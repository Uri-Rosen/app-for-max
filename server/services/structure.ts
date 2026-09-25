// Courses, topics and lessons. Topics form a tree (course → topic → subtopic);
// lessons link many-to-many with topics, because a topic can span several
// lectures and one lecture can cover several topics.

import { record, type ChangeSet } from '../audit.ts';
import { all, get, nowIso, type Row } from '../db/index.ts';
import { isIsoDate } from '../../shared/dates.ts';
import type { CourseDTO, LessonDTO, TopicDTO } from '../../shared/api.ts';
import type { Importance } from '../../shared/types.ts';
import { mapCourse, mapLesson, mapTopic } from './mappers.ts';
import { today } from './settings.ts';

export class UserError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function must<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new UserError(`${what} לא נמצא`, 404);
  return v;
}

function text(v: unknown, what: string, max = 500): string {
  const s = String(v ?? '').trim();
  if (!s) throw new UserError(`חסר ${what}`);
  return s.slice(0, max);
}

function optText(v: unknown, max = 5000): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function optDate(v: unknown, what: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (!isIsoDate(v)) throw new UserError(`${what}: תאריך לא תקין`);
  return v;
}

function importance(v: unknown): Importance {
  if (v === 'core' || v === 'normal' || v === 'peripheral') return v;
  throw new UserError('רמת חשיבות לא מוכרת');
}

// ---------- courses ----------

export function listCourses(includeArchived = false): CourseDTO[] {
  const d = today();
  return all<Row>(
    `SELECT c.*,
       (SELECT COUNT(*) FROM topics t WHERE t.course_id = c.id AND t.status = 'active') AS topic_count,
       (SELECT COUNT(*) FROM units u JOIN topics t ON t.id = u.topic_id WHERE t.course_id = c.id AND u.status = 'active') AS unit_count,
       (SELECT COUNT(*) FROM units u JOIN topics t ON t.id = u.topic_id
          WHERE t.course_id = c.id AND u.status = 'active' AND u.due_date <= ?) AS due_count,
       (SELECT COUNT(*) FROM questions q JOIN units u ON u.id = q.unit_id JOIN topics t ON t.id = u.topic_id
          WHERE t.course_id = c.id AND q.status IN ('pending','draft','flagged') AND u.status IN ('active','proposed','suspended')) AS pending_count
     FROM courses c ${includeArchived ? '' : 'WHERE c.archived = 0'} ORDER BY c.archived, c.name`,
    d,
  ).map(mapCourse);
}

export function getCourse(id: number): CourseDTO {
  return must(listCourses(true).find((c) => c.id === id), 'הקורס');
}

export function createCourse(b: Row): CourseDTO {
  const { result } = record({ action: 'course.create', summary: `קורס חדש: ${String(b.name ?? '')}`, entityType: 'course' }, (cs) => {
    const id = cs.insert('courses', {
      name: text(b.name, 'שם קורס', 200),
      code: optText(b.code, 50),
      term: optText(b.term, 50),
      exam_date: optDate(b.examDate, 'תאריך מבחן'),
      color: optText(b.color, 20),
      watch_folder: optText(b.watchFolder, 1000),
      created_at: nowIso(),
    });
    cs.entityId = id;
    return id;
  });
  return getCourse(result);
}

export function updateCourse(id: number, b: Row): CourseDTO {
  const cur = must(get<Row>('SELECT * FROM courses WHERE id = ?', id), 'הקורס');
  const patch: Row = {};
  if ('name' in b) patch.name = text(b.name, 'שם קורס', 200);
  if ('code' in b) patch.code = optText(b.code, 50);
  if ('term' in b) patch.term = optText(b.term, 50);
  if ('examDate' in b) patch.exam_date = optDate(b.examDate, 'תאריך מבחן');
  if ('color' in b) patch.color = optText(b.color, 20);
  if ('watchFolder' in b) patch.watch_folder = optText(b.watchFolder, 1000);
  if ('archived' in b) patch.archived = b.archived ? 1 : 0;
  record({ action: 'course.update', summary: `עדכון קורס: ${String(cur.name)}`, entityType: 'course', entityId: id }, (cs) =>
    cs.update('courses', id, patch),
  );
  return getCourse(id);
}

// ---------- topics ----------

export function topicsForCourse(courseId: number, statuses = ['active', 'proposed']): TopicDTO[] {
  const rows = all<Row>(
    `SELECT * FROM topics WHERE course_id = ? AND status IN (SELECT value FROM json_each(?))
     ORDER BY COALESCE(parent_id, 0), position, COALESCE(syllabus_order, 1e9), id`,
    courseId,
    JSON.stringify(statuses),
  );
  const ids = rows.map((r) => Number(r.id));
  const aliases = all<Row>(
    'SELECT * FROM topic_aliases WHERE topic_id IN (SELECT value FROM json_each(?)) ORDER BY id',
    JSON.stringify(ids),
  );
  const lt = all<Row>(
    'SELECT * FROM lesson_topics WHERE topic_id IN (SELECT value FROM json_each(?))',
    JSON.stringify(ids),
  );
  return rows.map((r) =>
    mapTopic(
      r,
      aliases.filter((a) => a.topic_id === r.id).map((a) => ({ alias: String(a.alias), fromTopicId: (a.from_topic_id as number) ?? null })),
      lt.filter((l) => l.topic_id === r.id).map((l) => Number(l.lesson_id)),
    ),
  );
}

export function getTopic(id: number): TopicDTO {
  const r = must(get<Row>('SELECT * FROM topics WHERE id = ?', id), 'הנושא');
  const t = topicsForCourse(Number(r.course_id), [String(r.status)]).find((x) => x.id === id);
  return must(t, 'הנושא');
}

function assertParent(courseId: number, parentId: number | null, selfId: number | null): void {
  if (parentId === null) return;
  const p = must(get<Row>('SELECT * FROM topics WHERE id = ?', parentId), 'נושא האב');
  if (Number(p.course_id) !== courseId) throw new UserError('נושא האב שייך לקורס אחר');
  // Walk up to make sure we are not creating a cycle.
  let cur: number | null = parentId;
  while (cur !== null) {
    if (cur === selfId) throw new UserError('אי אפשר להפוך נושא לתת־נושא של עצמו');
    const row: Row | undefined = get<Row>('SELECT parent_id FROM topics WHERE id = ?', cur);
    cur = row && row.parent_id !== null ? Number(row.parent_id) : null;
  }
}

export function createTopic(b: Row): TopicDTO {
  const courseId = Number(b.courseId);
  must(get('SELECT id FROM courses WHERE id = ?', courseId), 'הקורס');
  const parentId = b.parentId ? Number(b.parentId) : null;
  assertParent(courseId, parentId, null);
  const pos = get<{ p: number }>(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM topics WHERE course_id = ? AND parent_id IS ?',
    courseId,
    parentId,
  )!.p;
  const { result } = record({ action: 'topic.create', summary: `נושא חדש: ${String(b.name ?? '')}`, entityType: 'topic' }, (cs) => {
    const id = cs.insert('topics', {
      course_id: courseId,
      parent_id: parentId,
      name: text(b.name, 'שם נושא', 300),
      description: optText(b.description),
      importance: b.importance ? importance(b.importance) : 'normal',
      foundational: b.foundational ? 1 : 0,
      position: pos,
      status: 'active',
      created_by: 'user',
      created_at: nowIso(),
    });
    cs.entityId = id;
    return id;
  });
  return getTopic(result);
}

export function updateTopic(id: number, b: Row): TopicDTO {
  const cur = must(get<Row>('SELECT * FROM topics WHERE id = ?', id), 'הנושא');
  const patch: Row = {};
  if ('name' in b) patch.name = text(b.name, 'שם נושא', 300);
  if ('description' in b) patch.description = optText(b.description);
  if ('importance' in b) patch.importance = importance(b.importance);
  if ('foundational' in b) patch.foundational = b.foundational ? 1 : 0;
  if ('position' in b) patch.position = Number(b.position);
  if ('parentId' in b) {
    const parentId = b.parentId ? Number(b.parentId) : null;
    assertParent(Number(cur.course_id), parentId, id);
    patch.parent_id = parentId;
  }
  const renamed = 'name' in b && patch.name !== cur.name;
  record({ action: 'topic.update', summary: `עדכון נושא: ${String(cur.name)}`, entityType: 'topic', entityId: id }, (cs) => {
    cs.update('topics', id, patch);
    // A rename keeps the old name findable, the same way a merge does.
    if (renamed) cs.insert('topic_aliases', { topic_id: id, alias: cur.name, from_topic_id: null, created_at: nowIso() });
  });
  return getTopic(id);
}

/**
 * Merges a duplicate topic into another. Nothing is deleted: the old topic
 * stays as a `merged` row, its name becomes an alias, and every unit, subtopic,
 * lesson link and source link moves over. Review history is untouched because
 * it hangs off units, not topics. The whole merge is one undoable action.
 */
export function mergeTopics(fromId: number, intoId: number): TopicDTO {
  if (fromId === intoId) throw new UserError('אי אפשר לאחד נושא עם עצמו');
  const from = must(get<Row>('SELECT * FROM topics WHERE id = ?', fromId), 'הנושא המאוחד');
  const into = must(get<Row>('SELECT * FROM topics WHERE id = ?', intoId), 'נושא היעד');
  if (from.course_id !== into.course_id) throw new UserError('אפשר לאחד רק נושאים מאותו קורס');
  if (from.status === 'merged') throw new UserError('הנושא כבר אוחד');
  if (into.status !== 'active' && into.status !== 'proposed') throw new UserError('אפשר לאחד רק לתוך נושא פעיל');
  assertParent(Number(into.course_id), intoId, fromId);

  record(
    { action: 'topic.merge', summary: `איחוד נושאים: "${String(from.name)}" → "${String(into.name)}"`, entityType: 'topic', entityId: intoId },
    (cs) => {
      const t = nowIso();
      cs.insert('topic_aliases', { topic_id: intoId, alias: from.name, from_topic_id: fromId, created_at: t });
      for (const a of all<Row>('SELECT id FROM topic_aliases WHERE topic_id = ?', fromId)) {
        cs.update('topic_aliases', Number(a.id), { topic_id: intoId });
      }
      for (const u of all<Row>('SELECT id FROM units WHERE topic_id = ?', fromId)) {
        cs.update('units', Number(u.id), { topic_id: intoId });
      }
      for (const c of all<Row>('SELECT id FROM topics WHERE parent_id = ?', fromId)) {
        cs.update('topics', Number(c.id), { parent_id: intoId });
      }
      for (const lt of all<Row>('SELECT * FROM lesson_topics WHERE topic_id = ?', fromId)) {
        const exists = get('SELECT id FROM lesson_topics WHERE lesson_id = ? AND topic_id = ?', lt.lesson_id, intoId);
        if (exists) cs.remove('lesson_topics', Number(lt.id));
        else cs.update('lesson_topics', Number(lt.id), { topic_id: intoId });
      }
      for (const l of all<Row>("SELECT id FROM source_links WHERE entity_type = 'topic' AND entity_id = ?", fromId)) {
        cs.update('source_links', Number(l.id), { entity_id: intoId });
      }
      const patch: Row = { status: 'merged', merged_into_id: intoId };
      cs.update('topics', fromId, patch);
      if (from.importance === 'core' && into.importance !== 'core') cs.update('topics', intoId, { importance: 'core' });
      if (Number(from.foundational) === 1 && Number(into.foundational) !== 1) cs.update('topics', intoId, { foundational: 1 });
    },
  );
  return getTopic(intoId);
}

export function setTopicStatus(id: number, status: 'active' | 'rejected'): TopicDTO {
  const cur = must(get<Row>('SELECT * FROM topics WHERE id = ?', id), 'הנושא');
  const verb = status === 'active' ? 'אישור נושא' : 'פסילת נושא';
  record({ action: `topic.${status === 'active' ? 'approve' : 'reject'}`, summary: `${verb}: ${String(cur.name)}`, entityType: 'topic', entityId: id }, (cs) => {
    cs.update('topics', id, { status });
  });
  return getTopic(id);
}

// ---------- lessons ----------

export function lessonsForCourse(courseId: number): LessonDTO[] {
  const rows = all<Row>('SELECT * FROM lessons WHERE course_id = ? AND archived = 0 ORDER BY studied_on, id', courseId);
  const ids = JSON.stringify(rows.map((r) => Number(r.id)));
  const lt = all<Row>('SELECT * FROM lesson_topics WHERE lesson_id IN (SELECT value FROM json_each(?))', ids);
  const ls = all<Row>('SELECT * FROM lesson_sources WHERE lesson_id IN (SELECT value FROM json_each(?))', ids);
  return rows.map((r) =>
    mapLesson(
      r,
      lt.filter((x) => x.lesson_id === r.id).map((x) => Number(x.topic_id)),
      ls.filter((x) => x.lesson_id === r.id).map((x) => Number(x.source_id)),
    ),
  );
}

export function getLesson(id: number): LessonDTO {
  const r = must(get<Row>('SELECT * FROM lessons WHERE id = ?', id), 'השיעור');
  return must(lessonsForCourse(Number(r.course_id)).find((l) => l.id === id), 'השיעור');
}

function syncLinks(cs: ChangeSet, table: 'lesson_topics' | 'lesson_sources', lessonId: number, col: 'topic_id' | 'source_id', wanted: number[]): void {
  const cur = all<Row>(`SELECT * FROM ${table} WHERE lesson_id = ?`, lessonId);
  const want = new Set(wanted);
  for (const r of cur) if (!want.has(Number(r[col]))) cs.remove(table, Number(r.id));
  const have = new Set(cur.map((r) => Number(r[col])));
  for (const id of want) if (!have.has(id)) cs.insert(table, { lesson_id: lessonId, [col]: id });
}

export function createLesson(b: Row): LessonDTO {
  const courseId = Number(b.courseId);
  must(get('SELECT id FROM courses WHERE id = ?', courseId), 'הקורס');
  const studiedOn = optDate(b.studiedOn, 'תאריך למידה') ?? today();
  const { result } = record({ action: 'lesson.create', summary: `שיעור חדש: ${String(b.title ?? '')}`, entityType: 'lesson' }, (cs) => {
    const id = cs.insert('lessons', {
      course_id: courseId,
      title: text(b.title, 'שם שיעור', 300),
      studied_on: studiedOn,
      kind: optText(b.kind, 30) ?? 'lecture',
      notes: optText(b.notes),
      created_at: nowIso(),
    });
    cs.entityId = id;
    if (Array.isArray(b.topicIds)) syncLinks(cs, 'lesson_topics', id, 'topic_id', b.topicIds.map(Number));
    if (Array.isArray(b.sourceIds)) syncLinks(cs, 'lesson_sources', id, 'source_id', b.sourceIds.map(Number));
    return id;
  });
  return getLesson(result);
}

export function updateLesson(id: number, b: Row): LessonDTO {
  const cur = must(get<Row>('SELECT * FROM lessons WHERE id = ?', id), 'השיעור');
  const patch: Row = {};
  if ('title' in b) patch.title = text(b.title, 'שם שיעור', 300);
  if ('studiedOn' in b) patch.studied_on = optDate(b.studiedOn, 'תאריך למידה') ?? cur.studied_on;
  if ('kind' in b) patch.kind = optText(b.kind, 30) ?? 'lecture';
  if ('notes' in b) patch.notes = optText(b.notes);
  if ('archived' in b) patch.archived = b.archived ? 1 : 0;
  record({ action: 'lesson.update', summary: `עדכון שיעור: ${String(cur.title)}`, entityType: 'lesson', entityId: id }, (cs) => {
    cs.update('lessons', id, patch);
    if (Array.isArray(b.topicIds)) syncLinks(cs, 'lesson_topics', id, 'topic_id', b.topicIds.map(Number));
    if (Array.isArray(b.sourceIds)) syncLinks(cs, 'lesson_sources', id, 'source_id', b.sourceIds.map(Number));
  });
  return getLesson(id);
}
