// Study sources: files found in a course folder, uploaded files, and manual
// entries. Source files are only ever read — folder files are referenced in
// place, uploads are copied once into data/sources and never rewritten.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { record } from '../audit.ts';
import { UPLOAD_DIR } from '../config.ts';
import { all, get, nowIso, parseJson, run, tx, type Row } from '../db/index.ts';
import { extractFile, normHash } from '../importer/extract/index.ts';
import { SUPPORTED_EXTENSIONS } from '../importer/types.ts';
import { isIsoDate } from '../../shared/dates.ts';
import type { ChunkDTO, ScanResultDTO, SourceDTO } from '../../shared/api.ts';
import { SOURCE_KINDS, type SourceKind } from '../../shared/types.ts';
import { whileBusy } from './busy.ts';
import { UserError, must } from './structure.ts';

const MAX_FILE_BYTES = 200 * 1024 * 1024;

export const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
};

function mapSource(r: Row): SourceDTO {
  return {
    id: Number(r.id),
    courseId: r.course_id === null ? null : Number(r.course_id),
    kind: String(r.kind) as SourceKind,
    title: String(r.title),
    origin: String(r.origin) as SourceDTO['origin'],
    filePath: (r.file_path as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    fileExt: (r.file_ext as string | null) ?? null,
    fileSize: r.file_size === null ? null : Number(r.file_size),
    studiedOn: (r.studied_on as string | null) ?? null,
    status: String(r.status) as SourceDTO['status'],
    extractError: (r.extract_error as string | null) ?? null,
    warnings: parseJson<string[]>(r.warnings, []),
    pageCount: r.page_count === null ? null : Number(r.page_count),
    chunkCount: Number(r.chunk_count),
    dupChunkCount: Number(r.dup_chunk_count),
    duplicateOf: r.duplicate_of === null ? null : Number(r.duplicate_of),
    previousVersionId: r.previous_version_id === null ? null : Number(r.previous_version_id),
    notes: (r.notes as string | null) ?? null,
    addedAt: String(r.added_at),
    extractedAt: (r.extracted_at as string | null) ?? null,
    approvedAt: (r.approved_at as string | null) ?? null,
    lessonIds: parseJson<number[]>(r.lesson_ids, []),
    linkCount: Number(r.link_count ?? 0),
    proposalCount: Number(r.proposal_count ?? 0),
  };
}

const SOURCE_SQL = `
  SELECT s.*,
    (SELECT json_group_array(lesson_id) FROM lesson_sources ls WHERE ls.source_id = s.id) AS lesson_ids,
    (SELECT COUNT(*) FROM source_links l WHERE l.source_id = s.id) AS link_count,
    (SELECT COUNT(*) FROM source_links l JOIN questions q ON l.entity_type = 'question' AND q.id = l.entity_id
       WHERE l.source_id = s.id AND q.status IN ('pending','draft')) AS proposal_count
  FROM sources s`;

export function listSources(courseId?: number | null): SourceDTO[] {
  const rows =
    courseId === undefined || courseId === null
      ? all<Row>(`${SOURCE_SQL} ORDER BY s.added_at DESC, s.id DESC`)
      : all<Row>(`${SOURCE_SQL} WHERE s.course_id = ? ORDER BY s.added_at DESC, s.id DESC`, courseId);
  return rows.map(mapSource);
}

export function getSource(id: number): SourceDTO {
  return mapSource(must(get<Row>(`${SOURCE_SQL} WHERE s.id = ?`, id), 'המקור'));
}

export function getChunks(sourceId: number): ChunkDTO[] {
  return all<Row>(
    `SELECT c.*, d.source_id AS dup_source_id, d.locator_label AS dup_label, ds.title AS dup_title
     FROM source_chunks c
     LEFT JOIN source_chunks d ON d.id = c.duplicate_of_chunk_id
     LEFT JOIN sources ds ON ds.id = d.source_id
     WHERE c.source_id = ? ORDER BY c.seq`,
    sourceId,
  ).map((r) => ({
    id: Number(r.id),
    sourceId: Number(r.source_id),
    seq: Number(r.seq),
    locatorType: String(r.locator_type) as ChunkDTO['locatorType'],
    locatorNum: Number(r.locator_num),
    locatorLabel: String(r.locator_label),
    heading: (r.heading as string | null) ?? null,
    text: String(r.text),
    notes: (r.notes as string | null) ?? null,
    duplicateOf:
      r.duplicate_of_chunk_id === null
        ? null
        : {
            chunkId: Number(r.duplicate_of_chunk_id),
            sourceId: Number(r.dup_source_id),
            sourceTitle: String(r.dup_title),
            locatorLabel: String(r.dup_label),
          },
  }));
}

export function guessKind(filename: string): SourceKind {
  const n = filename.toLowerCase();
  if (/סילבוס|syllabus/.test(n)) return 'syllabus';
  if (/מבחן|בחינה|מועד\s?[אבג]|exam|midterm|final|quiz/.test(n)) return 'past_exam';
  if (/סיכום|summary|notes/.test(n)) return 'student_summary';
  if (n.endsWith('.pptx')) return 'slides';
  return 'course_material';
}

function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isSupported(file: string): boolean {
  const base = path.basename(file);
  if (base.startsWith('~$') || base.startsWith('.')) return false;
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(path.extname(file).toLowerCase());
}

function walk(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(full, depth + 1, out);
    } else if (e.isFile() && isSupported(full)) out.push(full);
  }
  return out;
}

function findDuplicateSource(hash: string, exceptId: number | null): number | null {
  const r = get<{ id: number }>(
    "SELECT id FROM sources WHERE file_hash = ? AND (? IS NULL OR id != ?) AND status NOT IN ('ignored') ORDER BY id LIMIT 1",
    hash,
    exceptId,
    exceptId,
  );
  return r ? Number(r.id) : null;
}

/**
 * Scans every course's watch folder. New files are registered; a file whose
 * content changed becomes a new version (the old one keeps its links);
 * files that disappeared are marked missing. Nothing on disk is modified.
 */
export function scanFolders(): ScanResultDTO {
  const out: ScanResultDTO = { scanned: 0, added: 0, changed: 0, missing: 0, unchanged: 0, errors: [] };
  const courses = all<Row>("SELECT id, name, watch_folder FROM courses WHERE archived = 0 AND watch_folder IS NOT NULL AND watch_folder != ''");
  for (const c of courses) {
    const folder = String(c.watch_folder);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      out.errors.push(`התיקייה של "${String(c.name)}" לא נמצאה: ${folder}`);
      continue;
    }
    const files = walk(folder);
    const seen = new Set<string>();
    for (const file of files) {
      out.scanned++;
      seen.add(path.resolve(file));
      try {
        const st = fs.statSync(file);
        if (st.size > MAX_FILE_BYTES) {
          out.errors.push(`${path.basename(file)}: הקובץ גדול מדי (${Math.round(st.size / 1e6)}MB)`);
          continue;
        }
        const latest = get<Row>(
          "SELECT * FROM sources WHERE file_path = ? AND origin = 'folder' ORDER BY id DESC LIMIT 1",
          path.resolve(file),
        );
        const mtime = st.mtime.toISOString();
        if (latest && latest.file_mtime === mtime && Number(latest.file_size) === st.size) {
          if (latest.status === 'missing') {
            run("UPDATE sources SET status = COALESCE(status_before_missing, 'new'), status_before_missing = NULL WHERE id = ?", latest.id);
          }
          out.unchanged++;
          continue;
        }
        const buf = fs.readFileSync(file);
        const hash = sha256(buf);
        if (latest && latest.file_hash === hash) {
          run('UPDATE sources SET file_mtime = ?, file_size = ? WHERE id = ?', mtime, st.size, latest.id);
          out.unchanged++;
          continue;
        }
        const ext = path.extname(file).toLowerCase();
        tx(() => {
          const id = run(
            `INSERT INTO sources (course_id, kind, title, origin, file_path, file_hash, file_size, file_mtime, file_ext,
               status, duplicate_of, previous_version_id, added_at)
             VALUES (?, ?, ?, 'folder', ?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
            c.id,
            latest ? latest.kind : guessKind(path.basename(file)),
            latest ? latest.title : path.basename(file, ext),
            path.resolve(file),
            hash,
            st.size,
            mtime,
            ext,
            findDuplicateSource(hash, null),
            latest ? latest.id : null,
            nowIso(),
          ).lastId;
          if (latest) {
            run("UPDATE sources SET status = 'changed', notes = COALESCE(notes || char(10), '') || ? WHERE id = ?", `הקובץ השתנה — גרסה חדשה נרשמה כמקור #${id}`, latest.id);
            // Carry lesson links over to the new version.
            for (const ls of all<Row>('SELECT lesson_id FROM lesson_sources WHERE source_id = ?', latest.id)) {
              run('INSERT OR IGNORE INTO lesson_sources (lesson_id, source_id) VALUES (?, ?)', ls.lesson_id, id);
            }
          }
        });
        if (latest) out.changed++;
        else out.added++;
      } catch (e) {
        out.errors.push(`${path.basename(file)}: ${(e as Error).message}`);
      }
    }
    for (const s of all<Row>(
      "SELECT id, file_path FROM sources WHERE course_id = ? AND origin = 'folder' AND status NOT IN ('missing','ignored','changed')",
      c.id,
    )) {
      if (!seen.has(String(s.file_path)) && !fs.existsSync(String(s.file_path))) {
        run("UPDATE sources SET status_before_missing = status, status = 'missing' WHERE id = ?", s.id);
        out.missing++;
      }
    }
  }
  return out;
}

export async function uploadSource(buf: Buffer, filename: string, meta: Row): Promise<SourceDTO> {
  const ext = path.extname(filename).toLowerCase();
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) throw new UserError(`סוג קובץ לא נתמך (${ext || 'ללא סיומת'})`);
  if (buf.length === 0) throw new UserError('הקובץ ריק');
  if (buf.length > MAX_FILE_BYTES) throw new UserError('הקובץ גדול מדי');
  const hash = sha256(buf);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const stored = path.join(UPLOAD_DIR, `${hash}${ext}`);
  if (!fs.existsSync(stored)) fs.writeFileSync(stored, buf, { flag: 'wx' });
  const courseId = meta.courseId ? Number(meta.courseId) : null;
  const id = run(
    `INSERT INTO sources (course_id, kind, title, origin, file_path, file_hash, file_size, file_ext, studied_on, status, duplicate_of, added_at)
     VALUES (?, ?, ?, 'upload', ?, ?, ?, ?, ?, 'new', ?, ?)`,
    courseId,
    meta.kind && (SOURCE_KINDS as readonly string[]).includes(String(meta.kind)) ? meta.kind : guessKind(filename),
    path.basename(filename, ext).slice(0, 300),
    stored,
    hash,
    buf.length,
    ext,
    isIsoDate(meta.studiedOn) ? meta.studiedOn : null,
    findDuplicateSource(hash, null),
    nowIso(),
  ).lastId;
  await extractSource(id);
  return getSource(id);
}

export async function createManualSource(b: Row): Promise<SourceDTO> {
  const title = String(b.title ?? '').trim();
  if (!title) throw new UserError('חסרה כותרת למקור');
  const kind = (SOURCE_KINDS as readonly string[]).includes(String(b.kind)) ? String(b.kind) : 'manual';
  const url = typeof b.url === 'string' && b.url.trim() ? b.url.trim() : null;
  if (url && !/^https?:\/\//.test(url)) throw new UserError('קישור צריך להתחיל ב־http:// או https://');
  // A file we can't extract (e.g. an image) is still kept as a reference.
  const filePath: string | null = typeof b.filePath === 'string' && b.filePath.trim() ? path.resolve(b.filePath.trim()) : null;
  let hash: string | null = null;
  let size: number | null = null;
  let ext: string | null = null;
  if (filePath) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new UserError('הקובץ לא נמצא בנתיב שהוזן');
    ext = path.extname(filePath).toLowerCase();
    const buf = fs.readFileSync(filePath);
    hash = sha256(buf);
    size = buf.length;
  }
  const { result } = record({ action: 'source.create', summary: `מקור ידני: ${title}`, entityType: 'source' }, (cs) => {
    const id = cs.insert('sources', {
      course_id: b.courseId ? Number(b.courseId) : null,
      kind,
      title: title.slice(0, 300),
      origin: 'manual',
      file_path: filePath,
      url,
      file_hash: hash,
      file_size: size,
      file_ext: ext,
      studied_on: isIsoDate(b.studiedOn) ? b.studiedOn : null,
      status: filePath && isSupported(filePath) ? 'new' : 'approved',
      notes: typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null,
      added_at: nowIso(),
      approved_at: filePath && isSupported(filePath) ? null : nowIso(),
    });
    cs.entityId = id;
    if (b.lessonId) cs.insert('lesson_sources', { lesson_id: Number(b.lessonId), source_id: id });
    return id;
  });
  if (filePath && isSupported(filePath)) await extractSource(result);
  return getSource(result);
}

/**
 * Extracts text into chunks. Re-extraction replaces chunks only while nothing
 * links to them — links must keep pointing at the exact text they cited.
 */
export function extractSource(id: number): Promise<SourceDTO> {
  return whileBusy(() => extractSourceNow(id));
}

async function extractSourceNow(id: number): Promise<SourceDTO> {
  const s = must(get<Row>('SELECT * FROM sources WHERE id = ?', id), 'המקור');
  if (!s.file_path) throw new UserError('למקור הזה אין קובץ לחילוץ');
  const linked = get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM source_links WHERE chunk_id IN (SELECT id FROM source_chunks WHERE source_id = ?)',
    id,
  )!.n;
  if (linked > 0) throw new UserError('יש שאלות או יחידות שמצטטות את המקור הזה, ולכן אי אפשר לחלץ אותו מחדש. אם הקובץ השתנה, סריקת התיקייה תיצור גרסה חדשה.');
  const file = String(s.file_path);
  if (!fs.existsSync(file)) {
    run(
      "UPDATE sources SET status_before_missing = CASE WHEN status = 'missing' THEN status_before_missing ELSE status END, status = 'missing', extract_error = ? WHERE id = ?",
      'הקובץ לא נמצא בדיסק',
      id,
    );
    return getSource(id);
  }
  let result;
  try {
    const buf = fs.readFileSync(file);
    result = await extractFile(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), path.basename(file));
  } catch (e) {
    run("UPDATE sources SET status = 'error', extract_error = ?, extracted_at = ? WHERE id = ?", (e as Error).message, nowIso(), id);
    return getSource(id);
  }
  tx(() => {
    // The extraction awaited; re-check what may have changed meanwhile.
    if (!get('SELECT id FROM sources WHERE id = ?', id)) return;
    const citedNow = get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM source_links WHERE chunk_id IN (SELECT id FROM source_chunks WHERE source_id = ?)',
      id,
    )!.n;
    if (citedNow > 0) throw new UserError('בזמן החילוץ נוצרו ציטוטים מהמקור, ולכן החילוץ החדש לא נשמר.');
    // Other sources' pages may be marked as duplicates of the pages being replaced.
    const pointing = all<{ source_id: number }>(
      'SELECT DISTINCT source_id FROM source_chunks WHERE duplicate_of_chunk_id IN (SELECT id FROM source_chunks WHERE source_id = ?)',
      id,
    ).map((r) => r.source_id);
    run('UPDATE source_chunks SET duplicate_of_chunk_id = NULL WHERE duplicate_of_chunk_id IN (SELECT id FROM source_chunks WHERE source_id = ?)', id);
    for (const other of pointing) {
      run(
        'UPDATE sources SET dup_chunk_count = (SELECT COUNT(*) FROM source_chunks WHERE source_id = ? AND duplicate_of_chunk_id IS NOT NULL) WHERE id = ?',
        other,
        other,
      );
    }
    run('DELETE FROM source_chunks WHERE source_id = ?', id);
    let dups = 0;
    result.chunks.forEach((c, i) => {
      // Notes-only slides have empty text; hash both so they don't all collide.
      const h = normHash([c.text, c.notes ?? ''].join('\n'));
      const trivial = (c.text + (c.notes ?? '')).replace(/\s/g, '').length < 12;
      const dup = trivial ? undefined : get<{ id: number }>(
        'SELECT c.id FROM source_chunks c JOIN sources s ON s.id = c.source_id WHERE c.norm_hash = ? AND c.source_id != ? AND s.status != ? ORDER BY c.id LIMIT 1',
        h,
        id,
        'ignored',
      );
      if (dup) dups++;
      run(
        `INSERT INTO source_chunks (source_id, seq, locator_type, locator_num, locator_label, heading, text, notes, norm_hash, duplicate_of_chunk_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        i + 1,
        c.locatorType,
        c.locatorNum,
        c.locatorLabel,
        c.heading,
        c.text,
        c.notes,
        h,
        dup ? dup.id : null,
      );
    });
    const status = result.chunks.length === 0 || result.warnings.length > 0 ? 'partial' : 'extracted';
    run(
      // A decision taken while extraction ran (approve / ignore) wins over the extraction's own status.
      `UPDATE sources SET status = CASE WHEN status IN ('approved','ignored') THEN status ELSE ? END, extract_error = NULL, warnings = ?, page_count = ?,
         chunk_count = ?, dup_chunk_count = ?, outline = ?, extracted_at = ? WHERE id = ?`,
      status,
      JSON.stringify(result.warnings),
      result.pageCount,
      result.chunks.length,
      dups,
      JSON.stringify(result.outline),
      nowIso(),
      id,
    );
  });
  return getSource(id);
}

let queueRunning = false;

/** Extracts every source still waiting, one at a time, in the background. */
export async function processQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    for (;;) {
      const next = get<{ id: number }>("SELECT id FROM sources WHERE status = 'new' AND file_path IS NOT NULL ORDER BY id LIMIT 1");
      if (!next) break;
      await extractSource(Number(next.id)).catch((e) => {
        run("UPDATE sources SET status = 'error', extract_error = ? WHERE id = ?", (e as Error).message, next.id);
      });
    }
  } finally {
    queueRunning = false;
  }
}

export function isQueueRunning(): boolean {
  return queueRunning;
}

export function updateSource(id: number, b: Row): SourceDTO {
  const cur = must(get<Row>('SELECT * FROM sources WHERE id = ?', id), 'המקור');
  const patch: Row = {};
  if ('title' in b) {
    const t = String(b.title ?? '').trim();
    if (!t) throw new UserError('חסרה כותרת');
    patch.title = t.slice(0, 300);
  }
  if ('kind' in b) {
    if (!(SOURCE_KINDS as readonly string[]).includes(String(b.kind))) throw new UserError('סוג מקור לא מוכר');
    patch.kind = b.kind;
  }
  if ('courseId' in b) patch.course_id = b.courseId ? Number(b.courseId) : null;
  if ('studiedOn' in b) patch.studied_on = isIsoDate(b.studiedOn) ? b.studiedOn : null;
  if ('notes' in b) patch.notes = typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null;
  if ('url' in b) patch.url = typeof b.url === 'string' && b.url.trim() ? b.url.trim() : null;
  record({ action: 'source.update', summary: `עדכון מקור: ${String(cur.title)}`, entityType: 'source', entityId: id }, (cs) => {
    cs.update('sources', id, patch);
    if (Array.isArray(b.lessonIds)) {
      const want = new Set(b.lessonIds.map(Number));
      const have = all<Row>('SELECT * FROM lesson_sources WHERE source_id = ?', id);
      for (const h of have) if (!want.has(Number(h.lesson_id))) cs.remove('lesson_sources', Number(h.id));
      for (const l of want) if (!have.some((h) => Number(h.lesson_id) === l)) cs.insert('lesson_sources', { lesson_id: l, source_id: id });
    }
  });
  return getSource(id);
}

export function setSourceStatus(id: number, action: 'approve' | 'ignore' | 'restore'): SourceDTO {
  const cur = must(get<Row>('SELECT * FROM sources WHERE id = ?', id), 'המקור');
  if (action === 'approve' && !['extracted', 'partial', 'approved', 'changed'].includes(String(cur.status))) {
    throw new UserError('אפשר לאשר מקור רק אחרי שהטקסט חולץ ממנו');
  }
  if (action === 'approve' && cur.course_id === null) throw new UserError('לפני אישור צריך לשייך את המקור לקורס');
  const status = action === 'approve' ? 'approved' : action === 'ignore' ? 'ignored' : Number(cur.chunk_count) > 0 ? 'extracted' : 'new';
  const verb = action === 'approve' ? 'אישור מקור' : action === 'ignore' ? 'התעלמות ממקור' : 'החזרת מקור';
  record({ action: `source.${action}`, summary: `${verb}: ${String(cur.title)}`, entityType: 'source', entityId: id }, (cs) => {
    cs.update('sources', id, { status, approved_at: action === 'approve' ? nowIso() : cur.approved_at });
  });
  return getSource(id);
}

export function sourceFile(id: number): { path: string; mime: string; name: string } {
  const s = must(get<Row>('SELECT * FROM sources WHERE id = ?', id), 'המקור');
  if (!s.file_path || !fs.existsSync(String(s.file_path))) throw new UserError('קובץ המקור לא נמצא בדיסק', 404);
  const ext = String(s.file_ext ?? path.extname(String(s.file_path))).toLowerCase();
  return { path: String(s.file_path), mime: MIME[ext] ?? 'application/octet-stream', name: `${String(s.title)}${ext}` };
}

export function searchChunks(q: string, courseId: number | null, limit = 30): (ChunkDTO & { sourceTitle: string })[] {
  const terms = q
    .replace(/["'()*:^-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => `"${t}"*`);
  if (terms.length === 0) return [];
  const rows = all<Row>(
    `SELECT c.*, s.title AS source_title FROM chunk_fts f
     JOIN source_chunks c ON c.id = f.rowid JOIN sources s ON s.id = c.source_id
     WHERE chunk_fts MATCH ? AND s.status != 'ignored' AND (? IS NULL OR s.course_id = ?)
     ORDER BY rank LIMIT ?`,
    terms.join(' '),
    courseId,
    courseId,
    limit,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    sourceId: Number(r.source_id),
    seq: Number(r.seq),
    locatorType: String(r.locator_type) as ChunkDTO['locatorType'],
    locatorNum: Number(r.locator_num),
    locatorLabel: String(r.locator_label),
    heading: (r.heading as string | null) ?? null,
    text: String(r.text),
    notes: (r.notes as string | null) ?? null,
    duplicateOf: null,
    sourceTitle: String(r.source_title),
  }));
}

export function getChunk(id: number): ChunkDTO & { sourceTitle: string } {
  const r = must(get<Row>('SELECT c.*, s.title AS source_title FROM source_chunks c JOIN sources s ON s.id = c.source_id WHERE c.id = ?', id), 'קטע המקור');
  return {
    id: Number(r.id),
    sourceId: Number(r.source_id),
    seq: Number(r.seq),
    locatorType: String(r.locator_type) as ChunkDTO['locatorType'],
    locatorNum: Number(r.locator_num),
    locatorLabel: String(r.locator_label),
    heading: (r.heading as string | null) ?? null,
    text: String(r.text),
    notes: (r.notes as string | null) ?? null,
    duplicateOf: null,
    sourceTitle: String(r.source_title),
  };
}
