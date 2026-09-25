// Every user-meaningful change goes through a ChangeSet, which records the
// full row before and after. That record is the action log, and undo is just
// applying it backwards — so any logged action can be reversed without a
// hand-written inverse, and nothing is lost because the log keeps both sides.

import { all, get, nowIso, parseJson, run, tx, TABLE_PK, type Row } from './db/index.ts';

export interface Change {
  table: string;
  id: number | string;
  before: Row | null;
  after: Row | null;
}

const IDENT = /^[a-z_]+$/;

function pk(table: string): string {
  return TABLE_PK[table] ?? 'id';
}

function readRow(table: string, id: number | string): Row | null {
  if (!IDENT.test(table)) throw new Error(`bad table ${table}`);
  const r = get<Row>(`SELECT * FROM ${table} WHERE ${pk(table)} = ?`, id);
  return r ? { ...r } : null;
}

function writeInsert(table: string, row: Row): number {
  const cols = Object.keys(row).filter((c) => IDENT.test(c));
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  return run(sql, ...cols.map((c) => row[c])).lastId;
}

function writeUpdate(table: string, id: number | string, patch: Row): void {
  const cols = Object.keys(patch).filter((c) => IDENT.test(c) && c !== pk(table));
  if (cols.length === 0) return;
  run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${pk(table)} = ?`, ...cols.map((c) => patch[c]), id);
}

function writeDelete(table: string, id: number | string): void {
  run(`DELETE FROM ${table} WHERE ${pk(table)} = ?`, id);
}

export class ChangeSet {
  changes: Change[] = [];
  /** Set by the action body when the entity id is only known after inserting it. */
  entityId: number | null = null;

  /**
   * One entry per row: a row touched twice in one action keeps its first
   * "before" and its last "after", so undo compares against the real end state.
   */
  private track(table: string, id: number | string, before: Row | null, after: Row | null): void {
    const i = this.changes.findIndex((c) => c.table === table && String(c.id) === String(id));
    if (i < 0) {
      this.changes.push({ table, id, before, after });
      return;
    }
    const prev = this.changes[i];
    prev.after = after;
    const noop = prev.before === null ? prev.after === null : prev.after !== null && JSON.stringify(prev.before) === JSON.stringify(prev.after);
    if (noop) this.changes.splice(i, 1);
  }

  insert(table: string, row: Row): number {
    const id = writeInsert(table, row);
    const key = (row[pk(table)] ?? id) as number | string;
    this.track(table, key, null, readRow(table, key));
    return id;
  }

  update(table: string, id: number | string, patch: Row): Row {
    const before = readRow(table, id);
    if (!before) throw new Error(`לא נמצאה רשומה ${table}#${id}`);
    writeUpdate(table, id, patch);
    const after = readRow(table, id)!;
    if (JSON.stringify(before) !== JSON.stringify(after)) this.track(table, id, before, after);
    return after;
  }

  /** Insert or replace by primary key (used for settings and the day log). */
  upsert(table: string, row: Row): void {
    const key = row[pk(table)] as number | string;
    const before = readRow(table, key);
    if (before) this.update(table, key, row);
    else this.insert(table, row);
  }

  remove(table: string, id: number | string): void {
    const before = readRow(table, id);
    if (!before) return;
    writeDelete(table, id);
    this.track(table, id, before, null);
  }
}

export interface ActionMeta {
  action: string;
  summary: string;
  entityType?: string | null;
  entityId?: number | null;
  undoable?: boolean;
}

/** Runs fn inside a transaction and logs what it changed as one action. */
export function record<T>(meta: ActionMeta, fn: (cs: ChangeSet) => T): { result: T; auditId: number | null } {
  return tx(() => {
    const cs = new ChangeSet();
    const result = fn(cs);
    if (cs.changes.length === 0) return { result, auditId: null };
    const auditId = run(
      `INSERT INTO audit_log (at, action, summary, entity_type, entity_id, changes, undoable)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      nowIso(),
      meta.action,
      meta.summary,
      meta.entityType ?? null,
      meta.entityId ?? cs.entityId,
      JSON.stringify(cs.changes),
      meta.undoable === false ? 0 : 1,
    ).lastId;
    return { result, auditId };
  });
}

export interface UndoConflict {
  table: string;
  id: number | string;
  message: string;
}

export interface AuditRow {
  id: number;
  at: string;
  action: string;
  summary: string;
  entity_type: string | null;
  entity_id: number | null;
  changes: string;
  undoable: number;
  undone_at: string | null;
  undo_of: number | null;
}

/** Rows that point at an entity without a foreign key (source links are polymorphic). */
const LINK_ENTITY: Record<string, string> = { units: 'unit', questions: 'question', topics: 'topic' };

/** Natural keys that must stay unique when a deleted row is re-inserted. */
const UNIQUE_KEYS: Record<string, string[]> = {
  lesson_topics: ['lesson_id', 'topic_id'],
  lesson_sources: ['lesson_id', 'source_id'],
};

function twinOf(table: string, row: Row): Row | null {
  const cols = UNIQUE_KEYS[table];
  if (!cols) return null;
  const r = get<Row>(`SELECT * FROM ${table} WHERE ${cols.map((c) => `${c} = ?`).join(' AND ')} AND id != ?`, ...cols.map((c) => row[c]), row.id);
  return r ?? null;
}

function sameRow(a: Row | null, b: Row | null): boolean {
  if (!a || !b) return a === b;
  for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  return true;
}

/**
 * Reverses a logged action. Refuses if any touched row has changed since,
 * unless forced — undoing on top of later edits would silently drop them.
 */
export function undoAction(auditId: number, opts: { force?: boolean } = {}): {
  ok: boolean;
  conflicts: UndoConflict[];
  auditId: number | null;
} {
  return tx(() => {
    const entry = get<AuditRow>('SELECT * FROM audit_log WHERE id = ?', auditId);
    if (!entry) throw new Error('הפעולה לא נמצאה ביומן');
    if (!entry.undoable) throw new Error('את הפעולה הזו אי אפשר לבטל מהיומן — אפשר לשחזר מגיבוי');
    if (entry.undone_at) throw new Error('הפעולה כבר בוטלה');
    const changes = parseJson<Change[]>(entry.changes, []);

    const conflicts: UndoConflict[] = [];
    // Source links added later to something this undo would delete. They have
    // no foreign key, so without this they would outlive their entity — and
    // attach themselves to the next row that reuses its id.
    const ownLinks = new Set(changes.filter((c) => c.table === 'source_links').map((c) => String(c.id)));
    const strayLinks: number[] = [];
    for (const c of changes) {
      const type = LINK_ENTITY[c.table];
      if (!type || c.before !== null) continue;
      for (const l of all<{ id: number }>('SELECT id FROM source_links WHERE entity_type = ? AND entity_id = ?', type, c.id)) {
        if (ownLinks.has(String(l.id))) continue;
        strayLinks.push(l.id);
        conflicts.push({ table: 'source_links', id: l.id, message: 'נוספו לפריט קישורים למקורות אחרי הפעולה' });
      }
    }
    for (const c of changes) {
      const cur = readRow(c.table, c.id);
      if (c.after === null) {
        if (cur) conflicts.push({ table: c.table, id: c.id, message: 'הרשומה נוצרה מחדש מאז' });
        else if (c.before && twinOf(c.table, c.before)) conflicts.push({ table: c.table, id: c.id, message: 'קישור זהה נוצר מחדש מאז' });
      } else if (!cur) {
        conflicts.push({ table: c.table, id: c.id, message: 'הרשומה כבר לא קיימת' });
      } else if (!sameRow(cur, c.after)) {
        conflicts.push({ table: c.table, id: c.id, message: 'הרשומה השתנתה מאז הפעולה' });
      }
    }
    if (conflicts.length > 0 && !opts.force) return { ok: false, conflicts, auditId: null };

    const cs = new ChangeSet();
    for (const id of strayLinks) cs.remove('source_links', id);
    for (const c of [...changes].reverse()) {
      if (c.before === null) {
        cs.remove(c.table, c.id);
      } else if (c.after === null || !readRow(c.table, c.id)) {
        const before = readRow(c.table, c.id);
        if (before) cs.update(c.table, c.id, c.before);
        else if (!twinOf(c.table, c.before)) cs.insert(c.table, c.before);
      } else {
        cs.update(c.table, c.id, c.before);
      }
    }
    const undoId = run(
      `INSERT INTO audit_log (at, action, summary, entity_type, entity_id, changes, undoable, undo_of)
       VALUES (?, 'undo', ?, ?, ?, ?, 1, ?)`,
      nowIso(),
      `ביטול: ${entry.summary}`,
      entry.entity_type,
      entry.entity_id,
      JSON.stringify(cs.changes),
      entry.id,
    ).lastId;
    run('UPDATE audit_log SET undone_at = ? WHERE id = ?', nowIso(), entry.id);
    // Undoing an undo re-opens the original action.
    if (entry.undo_of) run('UPDATE audit_log SET undone_at = NULL WHERE id = ?', entry.undo_of);
    return { ok: true, conflicts, auditId: undoId };
  });
}

export function listAudit(limit = 100, offset = 0): Omit<AuditRow, 'changes'>[] {
  return all<AuditRow>(
    `SELECT id, at, action, summary, entity_type, entity_id, undoable, undone_at, undo_of,
            json_array_length(changes) AS change_count
     FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`,
    limit,
    offset,
  );
}
