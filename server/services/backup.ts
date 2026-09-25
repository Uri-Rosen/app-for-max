// Backups are whole-database copies (VACUUM INTO), taken automatically once a
// study day and on demand. A JSON export of every table is written weekly.
// Restoring always takes a safety backup of the current state first.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, DATA_DIR, DB_PATH, EXPORT_DIR } from '../config.ts';
import { all, closeDb, currentDbPath, getDb, nowIso, openDb, run, TABLES } from '../db/index.ts';
import { SCHEMA_VERSION, migrate } from '../db/schema.ts';
import { isBusy } from './busy.ts';
import { clockOffset, getSettings, today } from './settings.ts';
import { UserError } from './structure.ts';

export interface BackupInfo {
  file: string;
  kind: 'auto' | 'manual' | 'pre-restore' | 'uploaded';
  size: number;
  createdAt: string;
}

const EXPORT_FORMAT = 'memory-system-export';

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function backupNow(kind: BackupInfo['kind'] = 'manual'): BackupInfo {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let file = `${kind}-${stamp()}.db`;
  for (let i = 2; fs.existsSync(path.join(BACKUP_DIR, file)); i++) file = `${kind}-${stamp()}-${i}.db`;
  const full = path.join(BACKUP_DIR, file);
  getDb().prepare('VACUUM INTO ?').run(full);
  const st = fs.statSync(full);
  return { file, kind, size: st.size, createdAt: st.mtime.toISOString() };
}

export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((file) => {
      const st = fs.statSync(path.join(BACKUP_DIR, file));
      const kind = (['auto', 'manual', 'pre-restore', 'uploaded'].find((k) => file.startsWith(`${k}-`)) ?? 'manual') as BackupInfo['kind'];
      return { file, kind, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * One automatic backup per study day. Old automatic backups beyond the
 * configured count are rotated out; manual and pre-restore backups never are.
 */
export function autoBackupIfNeeded(): BackupInfo | null {
  // A shifted test clock would name the file after a future day and suppress that day's real backup.
  if (clockOffset() !== 0) return null;
  const d = today();
  const autos = listBackups().filter((b) => b.kind === 'auto');
  let made: BackupInfo | null = null;
  if (!autos.some((b) => b.file.startsWith(`auto-${d}`))) {
    // Name the file after the study day, not the wall clock, so the check above is exact.
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = `auto-${d}.db`;
    const full = path.join(BACKUP_DIR, file);
    if (!fs.existsSync(full)) {
      getDb().prepare('VACUUM INTO ?').run(full);
      const st = fs.statSync(full);
      made = { file, kind: 'auto', size: st.size, createdAt: st.mtime.toISOString() };
    }
  }
  const keep = getSettings().autoBackupKeep;
  const all = listBackups().filter((b) => b.kind === 'auto');
  for (const old of all.slice(keep)) fs.rmSync(path.join(BACKUP_DIR, old.file));
  return made;
}

export function exportJson(): { format: string; schemaVersion: number; exportedAt: string; tables: Record<string, unknown[]> } {
  const tables: Record<string, unknown[]> = {};
  for (const t of TABLES) tables[t] = all(`SELECT * FROM ${t}`).map((r) => ({ ...r }));
  return { format: EXPORT_FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: nowIso(), tables };
}

export function writeJsonExport(): string {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const file = path.join(EXPORT_DIR, `export-${today()}.json`);
  fs.writeFileSync(file, JSON.stringify(exportJson()));
  return file;
}

/** Weekly JSON copy, independent of SQLite — readable by anything, forever. */
export function autoExportIfNeeded(): string | null {
  if (clockOffset() !== 0) return null;
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const files = fs.readdirSync(EXPORT_DIR).filter((f) => /^export-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const latest = files.at(-1)?.slice(7, 17) ?? null;
  const d = today();
  if (latest && (new Date(d).getTime() - new Date(latest).getTime()) / 86_400_000 < 7) return null;
  const file = writeJsonExport();
  const after = fs.readdirSync(EXPORT_DIR).filter((f) => /^export-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const old of after.slice(0, Math.max(0, after.length - 12))) fs.rmSync(path.join(EXPORT_DIR, old));
  return file;
}

function checkCandidate(file: string): void {
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    const ok = probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    if (ok.integrity_check !== 'ok') throw new UserError('קובץ הגיבוי פגום (בדיקת תקינות נכשלה)');
    const v = Number((probe.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (v < 1) throw new UserError('הקובץ אינו גיבוי של המערכת');
    if (v > SCHEMA_VERSION) throw new UserError('הגיבוי נוצר בגרסה חדשה יותר של המערכת');
    const hasUnits = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='units'").get();
    if (!hasUnits) throw new UserError('הקובץ אינו גיבוי של המערכת');
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(`לא ניתן לקרוא את קובץ הגיבוי: ${(e as Error).message}`);
  } finally {
    probe?.close();
  }
}

function swapIn(candidate: string, label: string): { safety: BackupInfo } {
  if (isBusy()) throw new UserError('רצה עכשיו עבודה ברקע (חילוץ קבצים או הצעות AI). נסה לשחזר שוב בעוד רגע.');
  const safety = backupNow('pre-restore');
  const target = currentDbPath() === ':memory:' ? DB_PATH : currentDbPath();
  closeDb();
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(target + ext)) fs.rmSync(target + ext);
  fs.copyFileSync(candidate, target);
  openDb(target);
  run(
    `INSERT INTO audit_log (at, action, summary, changes, undoable) VALUES (?, 'restore', ?, '[]', 0)`,
    nowIso(),
    `שחזור מ${label}. מצב קודם נשמר בגיבוי ${safety.file}`,
  );
  return { safety };
}

export function restoreFromBackup(file: string): { safety: BackupInfo } {
  const name = path.basename(file);
  if (name !== file || !name.endsWith('.db')) throw new UserError('שם קובץ גיבוי לא תקין');
  const full = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(full)) throw new UserError('קובץ הגיבוי לא נמצא', 404);
  checkCandidate(full);
  return swapIn(full, `גיבוי ${name}`);
}

export function saveUploadedBackup(buf: Buffer): BackupInfo {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = `uploaded-${stamp()}.db`;
  const full = path.join(BACKUP_DIR, file);
  fs.writeFileSync(full, buf);
  try {
    checkCandidate(full);
  } catch (e) {
    fs.rmSync(full);
    throw e;
  }
  const st = fs.statSync(full);
  return { file, kind: 'uploaded', size: st.size, createdAt: st.mtime.toISOString() };
}

/** Rebuilds a database from a JSON export, verifies it, then swaps it in. */
export function restoreFromJson(data: unknown): { safety: BackupInfo; counts: Record<string, number> } {
  const d = data as { format?: string; schemaVersion?: number; tables?: Record<string, Record<string, unknown>[]> };
  if (!d || d.format !== EXPORT_FORMAT || typeof d.tables !== 'object') throw new UserError('הקובץ אינו ייצוא JSON של המערכת');
  if ((d.schemaVersion ?? 0) > SCHEMA_VERSION) throw new UserError('הייצוא נוצר בגרסה חדשה יותר של המערכת');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = path.join(DATA_DIR, `restore-${Date.now()}.db`);
  const db = new DatabaseSync(tmp);
  const counts: Record<string, number> = {};
  try {
    migrate(db);
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    for (const t of TABLES) {
      const rows = d.tables[t] ?? [];
      const colInfo = db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[];
      const cols = new Set(colInfo.map((c) => c.name));
      for (const r of rows) {
        const keys = Object.keys(r).filter((k) => cols.has(k));
        if (keys.length === 0) continue;
        db.prepare(`INSERT INTO ${t} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(
          ...keys.map((k) => (r[k] === undefined ? null : (r[k] as string | number | null))),
        );
      }
      counts[t] = rows.length;
    }
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length > 0) throw new UserError(`הייצוא לא עקבי: ${fk.length} הפניות שבורות`);
    db.close();
    checkCandidate(tmp);
    const out = swapIn(tmp, 'ייצוא JSON');
    return { ...out, counts };
  } catch (e) {
    try {
      db.close();
    } catch {
      // already closed
    }
    throw e;
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(tmp + ext)) fs.rmSync(tmp + ext);
  }
}
