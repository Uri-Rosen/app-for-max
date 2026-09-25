// Knowledge units, their questions, and the links from both to sources.
// Scheduling state lives on the unit row but is written only by review.ts
// (and by the explicit "start over" action here).

import { record, type ChangeSet } from '../audit.ts';
import { all, get, nowIso, type Row } from '../db/index.ts';
import { isIsoDate } from '../../shared/dates.ts';
import { formatDate } from '../../shared/labels.ts';
import { pickQuestion } from '../../shared/questionPick.ts';
import { initialState } from '../../shared/scheduler.ts';
import type { LinkDTO, QuestionDTO, UnitDetailDTO, UnitSummaryDTO } from '../../shared/api.ts';
import {
  ANSWER_TEMPLATES,
  PROVENANCES,
  QUESTION_KINDS,
  TEMPLATE_FIELDS,
  type AnswerStructure,
  type Importance,
  type Provenance,
  type QuestionKind,
  type SourceKind,
} from '../../shared/types.ts';
import {
  LINK_SQL,
  QUESTION_SQL,
  REVIEW_SQL,
  UNIT_SUMMARY_SQL,
  linksFor,
  mapLink,
  mapQuestion,
  mapReview,
  mapUnitSummary,
} from './mappers.ts';
import { getSettings, today } from './settings.ts';
import { UserError, getCourse, getLesson, getTopic, must } from './structure.ts';

function optText(v: unknown, max = 10000): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

function reqText(v: unknown, what: string, max = 10000): string {
  const s = optText(v, max);
  if (!s) throw new UserError(`חסר ${what}`);
  return s;
}

// ---------- units ----------

export function unitSummaries(where: string, ...params: unknown[]): UnitSummaryDTO[] {
  const settings = getSettings();
  return all<Row>(`${UNIT_SUMMARY_SQL} WHERE ${where}`, ...params).map((r) => mapUnitSummary(r, settings));
}

export function unitsForCourse(courseId: number): UnitSummaryDTO[] {
  return unitSummaries(
    `t.course_id = ? AND u.status IN ('active','suspended','proposed') ORDER BY u.learned_on, u.id`,
    courseId,
  );
}

function scheduleColumns(learnedOn: string): Row {
  const s = initialState(learnedOn);
  return {
    step: s.step,
    due_date: s.dueDate,
    last_reviewed_on: null,
    last_grade: null,
    last_question_id: null,
    reps: 0,
    lapses: 0,
    clean_streak: 0,
    remediation: 0,
    recent_grades: '[]',
    schedule_reason: JSON.stringify({
      summary: `חזרה ראשונה ב־${formatDate(learnedOn)}`,
      lines: [`יחידה חדשה: החזרה הראשונה נקבעה ליום הלמידה (${formatDate(learnedOn)}).`],
    }),
  };
}

function importanceOrNull(v: unknown): Importance | null {
  if (v === null || v === undefined || v === '' || v === 'inherit') return null;
  if (v === 'core' || v === 'normal' || v === 'peripheral') return v;
  throw new UserError('רמת חשיבות לא מוכרת');
}

export function insertUnit(cs: ChangeSet, b: Row, opts: { status?: string; createdBy?: string; aiRunId?: number | null; validation?: unknown } = {}): number {
  const topicId = Number(b.topicId);
  const topic = must(get<Row>('SELECT * FROM topics WHERE id = ?', topicId), 'הנושא');
  if (topic.status === 'merged') throw new UserError('הנושא אוחד לנושא אחר — בחר את נושא היעד');
  const learnedOn = b.learnedOn ? String(b.learnedOn) : today();
  if (!isIsoDate(learnedOn)) throw new UserError('תאריך למידה לא תקין');
  const lessonId = b.lessonId ? Number(b.lessonId) : null;
  if (lessonId !== null) must(get('SELECT id FROM lessons WHERE id = ?', lessonId), 'השיעור');
  return cs.insert('units', {
    topic_id: topicId,
    original_topic_id: topicId,
    lesson_id: lessonId,
    title: reqText(b.title, 'כותרת ליחידה', 300),
    content: optText(b.content),
    learned_on: learnedOn,
    importance: importanceOrNull(b.importance),
    foundational: b.foundational === null || b.foundational === undefined || b.foundational === 'inherit' ? null : b.foundational ? 1 : 0,
    status: opts.status ?? 'active',
    created_by: opts.createdBy ?? 'user',
    ai_run_id: opts.aiRunId ?? null,
    validation: opts.validation === undefined ? null : JSON.stringify(opts.validation),
    created_at: nowIso(),
    ...scheduleColumns(learnedOn),
  });
}

export function createUnit(b: Row): UnitDetailDTO {
  const { result } = record({ action: 'unit.create', summary: `יחידת ידע חדשה: ${String(b.title ?? '')}`, entityType: 'unit' }, (cs) => {
    const id = insertUnit(cs, b);
    cs.entityId = id;
    if (Array.isArray(b.questions)) for (const q of b.questions as Row[]) insertQuestion(cs, { ...q, unitId: id });
    return id;
  });
  return getUnitDetail(result);
}

export function updateUnit(id: number, b: Row): UnitDetailDTO {
  const cur = must(get<Row>('SELECT * FROM units WHERE id = ?', id), 'היחידה');
  const patch: Row = {};
  if ('title' in b) patch.title = reqText(b.title, 'כותרת ליחידה', 300);
  if ('content' in b) patch.content = optText(b.content);
  if ('importance' in b) patch.importance = importanceOrNull(b.importance);
  if ('foundational' in b) patch.foundational = b.foundational === null || b.foundational === 'inherit' ? null : b.foundational ? 1 : 0;
  if ('lessonId' in b) patch.lesson_id = b.lessonId ? Number(b.lessonId) : null;
  if ('topicId' in b) {
    const t = must(get<Row>('SELECT * FROM topics WHERE id = ?', Number(b.topicId)), 'הנושא');
    if (t.status === 'merged') throw new UserError('הנושא אוחד לנושא אחר');
    patch.topic_id = Number(b.topicId);
  }
  if ('learnedOn' in b) {
    if (!isIsoDate(b.learnedOn)) throw new UserError('תאריך למידה לא תקין');
    patch.learned_on = b.learnedOn;
    // Before the first review, the first review simply follows the learning date.
    if (Number(cur.reps) === 0) Object.assign(patch, scheduleColumns(String(b.learnedOn)));
  }
  if ('status' in b) {
    if (!['active', 'suspended', 'archived'].includes(String(b.status))) throw new UserError('מצב לא מוכר');
    patch.status = b.status;
  }
  const verb =
    patch.status === 'archived'
      ? 'העברת יחידה לארכיון'
      : patch.status === 'suspended'
        ? 'השהיית יחידה'
        : patch.status === 'active' && cur.status !== 'active'
          ? 'הפעלת יחידה'
          : 'עדכון יחידה';
  record({ action: 'unit.update', summary: `${verb}: ${String(cur.title)}`, entityType: 'unit', entityId: id }, (cs) => {
    cs.update('units', id, patch);
  });
  return getUnitDetail(id);
}

/** Wipes the unit's schedule back to "new" — for material that has to be relearned from scratch. History stays. */
export function restartUnit(id: number): UnitDetailDTO {
  const cur = must(get<Row>('SELECT * FROM units WHERE id = ?', id), 'היחידה');
  const d = today();
  record({ action: 'unit.restart', summary: `התחלה מחדש של תזמון: ${String(cur.title)}`, entityType: 'unit', entityId: id }, (cs) => {
    cs.update('units', id, {
      ...scheduleColumns(d),
      reps: cur.reps,
      lapses: cur.lapses,
      schedule_reason: JSON.stringify({
        summary: 'התחלה מחדש',
        lines: ['ביקשת ללמוד את היחידה מחדש: התזמון אופס וחזרה ראשונה נקבעה להיום. היסטוריית החזרות נשמרת.'],
      }),
    });
  });
  return getUnitDetail(id);
}

export function approveUnit(id: number): UnitDetailDTO {
  const cur = must(get<Row>('SELECT * FROM units WHERE id = ?', id), 'היחידה');
  record({ action: 'unit.approve', summary: `אישור יחידה מוצעת: ${String(cur.title)}`, entityType: 'unit', entityId: id }, (cs) => {
    cs.update('units', id, { status: 'active', ...(Number(cur.reps) === 0 ? scheduleColumns(String(cur.learned_on)) : {}) });
  });
  return getUnitDetail(id);
}

export function rejectUnit(id: number): void {
  const cur = must(get<Row>('SELECT * FROM units WHERE id = ?', id), 'היחידה');
  record({ action: 'unit.reject', summary: `פסילת יחידה מוצעת: ${String(cur.title)}`, entityType: 'unit', entityId: id }, (cs) => {
    cs.update('units', id, { status: 'rejected' });
    for (const q of all<Row>("SELECT id FROM questions WHERE unit_id = ? AND status IN ('pending','draft')", id)) {
      cs.update('questions', Number(q.id), { status: 'rejected', updated_at: nowIso() });
    }
  });
}

export function getUnitDetail(id: number): UnitDetailDTO {
  const settings = getSettings();
  const r = must(get<Row>(`${UNIT_SUMMARY_SQL} WHERE u.id = ?`, id), 'היחידה');
  const summary = mapUnitSummary(r, settings);
  const topic = getTopic(Number(r.topic_id));
  const parentTopic = topic.parentId ? getTopic(topic.parentId) : null;
  const course = getCourse(topic.courseId);
  const qRows = all<Row>(`${QUESTION_SQL} WHERE q.unit_id = ? AND q.status != 'rejected' ORDER BY q.id`, id);
  const qLinks = linksFor('question', qRows.map((q) => Number(q.id)));
  const questions = qRows.map((q) => mapQuestion(q, qLinks.get(Number(q.id)) ?? []));
  const links = linksFor('unit', [id]).get(id) ?? [];
  const reviews = all<Row>(`${REVIEW_SQL} WHERE r.unit_id = ? ORDER BY r.reviewed_at DESC`, id).map(mapReview);
  const approved = questions.filter((q) => q.status === 'approved');
  const pick = pickQuestion(approved, {
    step: summary.step,
    lastGrade: summary.lastGrade,
    lastQuestionId: r.last_question_id === null ? null : Number(r.last_question_id),
  });
  return {
    unit: {
      ...summary,
      content: (r.content as string | null) ?? null,
      importanceOverride: (r.importance as Importance | null) ?? null,
      foundationalOverride: r.foundational === null ? null : Number(r.foundational) === 1,
      createdBy: String(r.created_by) as UnitDetailDTO['unit']['createdBy'],
      validation: r.validation ? JSON.parse(String(r.validation)) : null,
      scheduleReason: r.schedule_reason ? JSON.parse(String(r.schedule_reason)) : null,
      originalTopicId: r.original_topic_id === null ? null : Number(r.original_topic_id),
      createdAt: String(r.created_at),
    },
    course,
    topic,
    parentTopic,
    lesson: r.lesson_id ? getLesson(Number(r.lesson_id)) : null,
    questions,
    links,
    reviews,
    nextQuestion: pick ? { questionId: pick.question.id, why: pick.why } : null,
  };
}

// ---------- questions ----------

function parseKind(v: unknown): QuestionKind {
  if (typeof v === 'string' && (QUESTION_KINDS as readonly string[]).includes(v)) return v as QuestionKind;
  throw new UserError('סוג שאלה לא מוכר');
}

function parseProvenance(v: unknown, fallback: Provenance): Provenance {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'string' && (PROVENANCES as readonly string[]).includes(v)) return v as Provenance;
  throw new UserError('סוג מקור לא מוכר');
}

export function parseStructure(v: unknown): AnswerStructure | null {
  if (v === undefined || v === null || v === '') return null;
  const o = (typeof v === 'string' ? JSON.parse(v) : v) as Partial<AnswerStructure>;
  if (!o || typeof o !== 'object') return null;
  const template = o.template;
  if (!template || !(ANSWER_TEMPLATES as readonly string[]).includes(template)) throw new UserError('תבנית תשובה לא מוכרת');
  const fields: Record<string, string> = {};
  for (const f of TEMPLATE_FIELDS[template]) {
    const val = o.fields?.[f];
    if (typeof val === 'string' && val.trim()) fields[f] = val.trim().slice(0, 4000);
  }
  const analogy = typeof o.analogy === 'string' && o.analogy.trim() ? o.analogy.trim().slice(0, 2000) : undefined;
  if (Object.keys(fields).length === 0 && !analogy) return null;
  return { template, fields, ...(analogy ? { analogy } : {}) };
}

function keyPoints(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 20).map((x) => x.slice(0, 500));
}

function checkCloze(kind: QuestionKind, prompt: string): void {
  if (kind === 'cloze' && !/\[\[[^\]]+\]\]/.test(prompt)) {
    throw new UserError('בשאלת השלמה צריך לסמן את החלק החסר בסוגריים כפולים, למשל: [[אינסולין]]');
  }
}

export function insertQuestion(
  cs: ChangeSet,
  b: Row,
  opts: { status?: string; createdBy?: string; provenance?: Provenance; aiRunId?: number | null; validation?: unknown } = {},
): number {
  const unitId = Number(b.unitId);
  must(get('SELECT id FROM units WHERE id = ?', unitId), 'היחידה');
  const kind = parseKind(b.kind ?? 'definition');
  const prompt = reqText(b.prompt, 'צד השאלה', 4000);
  checkCloze(kind, prompt);
  const answer = kind === 'cloze' && !optText(b.answer) ? prompt.match(/\[\[([^\]]+)\]\]/g)!.map((m) => m.slice(2, -2)).join(', ') : reqText(b.answer, 'תשובה', 8000);
  const t = nowIso();
  return cs.insert('questions', {
    unit_id: unitId,
    kind,
    prompt,
    answer,
    explanation: optText(b.explanation),
    hint: optText(b.hint, 1000),
    key_points: JSON.stringify(keyPoints(b.keyPoints)),
    structure: JSON.stringify(parseStructure(b.structure)),
    related_unit_ids: JSON.stringify(Array.isArray(b.relatedUnitIds) ? b.relatedUnitIds.map(Number) : []),
    status: opts.status ?? 'approved',
    provenance: parseProvenance(b.provenance, opts.provenance ?? 'unverified'),
    created_by: opts.createdBy ?? 'user',
    verified_at: null,
    flag_reason: null,
    ai_run_id: opts.aiRunId ?? null,
    validation: opts.validation === undefined ? null : JSON.stringify(opts.validation),
    created_at: t,
    updated_at: t,
  });
}

export function getQuestion(id: number): QuestionDTO {
  const r = must(get<Row>(`${QUESTION_SQL} WHERE q.id = ?`, id), 'השאלה');
  return mapQuestion(r, linksFor('question', [id]).get(id) ?? []);
}

export function createQuestion(b: Row): QuestionDTO {
  const unit = must(get<Row>('SELECT title FROM units WHERE id = ?', Number(b.unitId)), 'היחידה');
  const { result } = record({ action: 'question.create', summary: `שאלה חדשה ביחידה: ${String(unit.title)}`, entityType: 'question' }, (cs) => {
    const id = insertQuestion(cs, b);
    cs.entityId = id;
    return id;
  });
  return getQuestion(result);
}

export function updateQuestion(id: number, b: Row): QuestionDTO {
  const cur = must(get<Row>('SELECT * FROM questions WHERE id = ?', id), 'השאלה');
  const patch: Row = { updated_at: nowIso() };
  const kind = 'kind' in b ? parseKind(b.kind) : (String(cur.kind) as QuestionKind);
  if ('kind' in b) patch.kind = kind;
  if ('prompt' in b) patch.prompt = reqText(b.prompt, 'צד השאלה', 4000);
  checkCloze(kind, String(patch.prompt ?? cur.prompt));
  if ('answer' in b) patch.answer = reqText(b.answer, 'תשובה', 8000);
  if ('explanation' in b) patch.explanation = optText(b.explanation);
  if ('hint' in b) patch.hint = optText(b.hint, 1000);
  if ('keyPoints' in b) patch.key_points = JSON.stringify(keyPoints(b.keyPoints));
  if ('structure' in b) patch.structure = JSON.stringify(parseStructure(b.structure));
  if ('relatedUnitIds' in b) patch.related_unit_ids = JSON.stringify(Array.isArray(b.relatedUnitIds) ? b.relatedUnitIds.map(Number) : []);
  if ('provenance' in b) patch.provenance = parseProvenance(b.provenance, String(cur.provenance) as Provenance);
  record({ action: 'question.update', summary: `עריכת שאלה: ${String(cur.prompt).slice(0, 60)}`, entityType: 'question', entityId: id }, (cs) => {
    cs.update('questions', id, patch);
  });
  return getQuestion(id);
}

function openConflicts(questionId: number, unitId: number): number {
  return get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM source_links WHERE role = 'contradicts' AND resolved = 0 AND
       ((entity_type = 'question' AND entity_id = ?) OR (entity_type = 'unit' AND entity_id = ?))`,
    questionId,
    unitId,
  )!.n;
}

/**
 * Approval is the gate into the review schedule. For anything a person did
 * not write themselves, the approver has to say they checked it against the source.
 */
export function approveQuestion(id: number, b: Row): QuestionDTO {
  const cur = must(get<Row>('SELECT * FROM questions WHERE id = ?', id), 'השאלה');
  if (cur.created_by === 'ai' && !b.verified) throw new UserError('לפני אישור שאלה שנוצרה על ידי AI צריך לסמן שבדקת אותה מול המקור');
  const validation = cur.validation ? (JSON.parse(String(cur.validation)) as { ok: boolean }) : null;
  if (validation && !validation.ok && !b.override) {
    throw new UserError('בדיקת המקור נכשלה לשאלה הזו (למשל ציטוט שלא נמצא במקור). תקן אותה, או אשר במפורש למרות זאת.');
  }
  if (openConflicts(id, Number(cur.unit_id)) > 0) throw new UserError('יש סתירה פתוחה בין מקורות — צריך ליישב אותה לפני אישור');
  const unit = get<Row>('SELECT * FROM units WHERE id = ?', cur.unit_id)!;
  record({ action: 'question.approve', summary: `אישור שאלה: ${String(cur.prompt).slice(0, 60)}`, entityType: 'question', entityId: id }, (cs) => {
    cs.update('questions', id, {
      status: 'approved',
      flag_reason: null,
      verified_at: b.verified ? nowIso() : cur.verified_at,
      updated_at: nowIso(),
    });
    // Approving a question inside a proposed unit approves the unit too — otherwise it could never be asked.
    if (unit.status === 'proposed') cs.update('units', Number(unit.id), { status: 'active', ...(Number(unit.reps) === 0 ? scheduleColumns(String(unit.learned_on)) : {}) });
  });
  return getQuestion(id);
}

export function rejectQuestion(id: number, b: Row): QuestionDTO {
  const cur = must(get<Row>('SELECT * FROM questions WHERE id = ?', id), 'השאלה');
  record({ action: 'question.reject', summary: `פסילת שאלה: ${String(cur.prompt).slice(0, 60)}`, entityType: 'question', entityId: id }, (cs) => {
    cs.update('questions', id, { status: 'rejected', flag_reason: optText(b.reason, 1000), updated_at: nowIso() });
  });
  return getQuestion(id);
}

export function flagQuestion(id: number, reason: string, cs?: ChangeSet): void {
  const cur = must(get<Row>('SELECT * FROM questions WHERE id = ?', id), 'השאלה');
  const apply = (c: ChangeSet) => c.update('questions', id, { status: 'flagged', flag_reason: reason, updated_at: nowIso() });
  if (cs) apply(cs);
  else record({ action: 'question.flag', summary: `סימון שאלה לבדיקה: ${String(cur.prompt).slice(0, 60)}`, entityType: 'question', entityId: id }, apply);
}

// ---------- source links ----------

const PROVENANCE_BY_KIND: Partial<Record<SourceKind, Provenance>> = {
  slides: 'official',
  lesson_summary: 'official',
  course_material: 'official',
  past_exam: 'past_exam',
  external: 'external',
};

export function getLink(id: number): LinkDTO {
  return mapLink(must(get<Row>(`${LINK_SQL} WHERE l.id = ?`, id), 'הקישור'));
}

export function insertLink(cs: ChangeSet, b: Row): number {
  const entityType = String(b.entityType);
  if (!['unit', 'question', 'topic'].includes(entityType)) throw new UserError('סוג ישות לא מוכר');
  const entityId = Number(b.entityId);
  const table = entityType === 'unit' ? 'units' : entityType === 'question' ? 'questions' : 'topics';
  must(get(`SELECT id FROM ${table} WHERE id = ?`, entityId), 'הפריט');
  const source = must(get<Row>('SELECT * FROM sources WHERE id = ?', Number(b.sourceId)), 'המקור');
  const chunkId = b.chunkId ? Number(b.chunkId) : null;
  if (chunkId !== null) {
    const ch = must(get<Row>('SELECT source_id FROM source_chunks WHERE id = ?', chunkId), 'קטע המקור');
    if (Number(ch.source_id) !== Number(source.id)) throw new UserError('הקטע לא שייך למקור שנבחר');
  }
  const role = String(b.role ?? 'supports');
  if (!['supports', 'contradicts', 'context'].includes(role)) throw new UserError('תפקיד קישור לא מוכר');
  return cs.insert('source_links', {
    entity_type: entityType,
    entity_id: entityId,
    source_id: Number(source.id),
    chunk_id: chunkId,
    locator: optText(b.locator, 200),
    quote: optText(b.quote, 4000),
    role,
    resolved: 0,
    note: optText(b.note, 2000),
    created_at: nowIso(),
  });
}

/**
 * Adds a source link. A supporting official source upgrades an unverified
 * question's provenance; a contradicting one pulls the affected questions out
 * of the schedule until the conflict is settled.
 */
export function addLink(b: Row): LinkDTO {
  const { result } = record({ action: 'link.add', summary: linkSummary(b), entityType: String(b.entityType) }, (cs) => {
    const id = insertLink(cs, b);
    cs.entityId = Number(b.entityId);
    const source = get<Row>('SELECT * FROM sources WHERE id = ?', Number(b.sourceId))!;
    const affected = affectedQuestions(String(b.entityType), Number(b.entityId));
    if (b.role === 'contradicts') {
      for (const q of affected) if (q.status === 'approved') flagQuestion(Number(q.id), 'סתירה בין מקורות — ממתין ליישוב', cs);
    } else if ((b.role ?? 'supports') === 'supports') {
      const prov = PROVENANCE_BY_KIND[String(source.kind) as SourceKind];
      if (prov) for (const q of affected) if (q.provenance === 'unverified') cs.update('questions', Number(q.id), { provenance: prov, updated_at: nowIso() });
    }
    return id;
  });
  return getLink(result);
}

function linkSummary(b: Row): string {
  const role = b.role === 'contradicts' ? 'סימון סתירה' : 'קישור למקור';
  return `${role} (${String(b.entityType) === 'unit' ? 'יחידה' : String(b.entityType) === 'topic' ? 'נושא' : 'שאלה'} #${String(b.entityId)})`;
}

function affectedQuestions(entityType: string, entityId: number): Row[] {
  if (entityType === 'question') return all<Row>('SELECT * FROM questions WHERE id = ?', entityId);
  if (entityType === 'unit') return all<Row>("SELECT * FROM questions WHERE unit_id = ? AND status != 'rejected'", entityId);
  return [];
}

export function resolveConflict(linkId: number, b: Row): LinkDTO {
  const link = must(get<Row>('SELECT * FROM source_links WHERE id = ?', linkId), 'הקישור');
  if (link.role !== 'contradicts') throw new UserError('הקישור אינו סתירה');
  record({ action: 'link.resolve', summary: `יישוב סתירה #${linkId}`, entityType: String(link.entity_type), entityId: Number(link.entity_id) }, (cs) => {
    cs.update('source_links', linkId, { resolved: 1, note: optText(b.note, 2000) ?? link.note });
    releaseConflictFlags(cs, String(link.entity_type), Number(link.entity_id));
  });
  return getLink(linkId);
}

/** Questions pulled out because of a conflict go back into rotation once no conflict on them remains open. */
function releaseConflictFlags(cs: ChangeSet, entityType: string, entityId: number): void {
  for (const q of affectedQuestions(entityType, entityId)) {
    if (q.status === 'flagged' && String(q.flag_reason ?? '').startsWith('סתירה') && openConflicts(Number(q.id), Number(q.unit_id)) === 0) {
      cs.update('questions', Number(q.id), { status: 'approved', flag_reason: null, updated_at: nowIso() });
    }
  }
}

export function removeLink(id: number): void {
  const link = must(get<Row>('SELECT * FROM source_links WHERE id = ?', id), 'הקישור');
  record({ action: 'link.remove', summary: `הסרת קישור למקור #${id}`, entityType: String(link.entity_type), entityId: Number(link.entity_id) }, (cs) => {
    cs.remove('source_links', id);
    // Removing a contradiction is a way of settling it too.
    if (link.role === 'contradicts') releaseConflictFlags(cs, String(link.entity_type), Number(link.entity_id));
  });
}
