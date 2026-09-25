// Row → DTO mapping. SQLite rows are snake_case with 0/1 booleans and JSON
// text columns; DTOs are what the client sees.

import { all, parseJson, type Row } from '../db/index.ts';
import { confidence } from '../../shared/scheduler.ts';
import type {
  CourseDTO,
  Explanation,
  LessonDTO,
  LinkDTO,
  QuestionDTO,
  ReviewDTO,
  TopicDTO,
  UnitSummaryDTO,
  ValidationReport,
} from '../../shared/api.ts';
import type { AnswerStructure, EffectiveGrade, Importance, Settings } from '../../shared/types.ts';

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown): boolean => Number(v) === 1;

export function mapCourse(r: Row): CourseDTO {
  return {
    id: Number(r.id),
    name: String(r.name),
    code: str(r.code),
    term: str(r.term),
    examDate: str(r.exam_date),
    color: str(r.color),
    watchFolder: str(r.watch_folder),
    archived: bool(r.archived),
    createdAt: String(r.created_at),
    stats: {
      topics: Number(r.topic_count ?? 0),
      units: Number(r.unit_count ?? 0),
      due: Number(r.due_count ?? 0),
      pending: Number(r.pending_count ?? 0),
    },
  };
}

export function mapTopic(r: Row, aliases: TopicDTO['aliases'] = [], lessonIds: number[] = []): TopicDTO {
  return {
    id: Number(r.id),
    courseId: Number(r.course_id),
    parentId: num(r.parent_id),
    name: String(r.name),
    description: str(r.description),
    importance: String(r.importance) as Importance,
    foundational: bool(r.foundational),
    position: Number(r.position),
    status: String(r.status) as TopicDTO['status'],
    mergedIntoId: num(r.merged_into_id),
    syllabusOrder: num(r.syllabus_order),
    createdBy: String(r.created_by) as TopicDTO['createdBy'],
    aliases,
    lessonIds,
    validation: parseJson<ValidationReport | null>(r.validation, null),
  };
}

export function mapLesson(r: Row, topicIds: number[] = [], sourceIds: number[] = []): LessonDTO {
  return {
    id: Number(r.id),
    courseId: Number(r.course_id),
    title: String(r.title),
    studiedOn: String(r.studied_on),
    kind: String(r.kind),
    notes: str(r.notes),
    topicIds,
    sourceIds,
  };
}

/** Expects the unit row joined with topic importance/foundational and question counts (see UNIT_SUMMARY_SQL). */
export function mapUnitSummary(r: Row, settings: Pick<Settings, 'ladder'>): UnitSummaryDTO {
  const step = Number(r.step);
  const lastGrade = str(r.last_grade) as EffectiveGrade | null;
  const reps = Number(r.reps);
  const remediation = bool(r.remediation);
  const cleanStreak = Number(r.clean_streak);
  return {
    id: Number(r.id),
    topicId: Number(r.topic_id),
    lessonId: num(r.lesson_id),
    title: String(r.title),
    learnedOn: String(r.learned_on),
    status: String(r.status) as UnitSummaryDTO['status'],
    importance: (str(r.importance) ?? str(r.topic_importance) ?? 'normal') as Importance,
    foundational: r.foundational === null || r.foundational === undefined ? bool(r.topic_foundational) : bool(r.foundational),
    dueDate: str(r.due_date),
    step,
    intervalDays: step >= 0 ? settings.ladder[Math.min(step, settings.ladder.length - 1)] : null,
    reps,
    lapses: Number(r.lapses),
    remediation,
    lastGrade,
    lastReviewedOn: str(r.last_reviewed_on),
    confidence: confidence({ reps, remediation, lastGrade, cleanStreak, step }),
    questionCounts: {
      approved: Number(r.q_approved ?? 0),
      pending: Number(r.q_pending ?? 0),
      flagged: Number(r.q_flagged ?? 0),
    },
    // The plan's source categories are the provenance values; only 'needs checking', a missing
    // classification, or an open conflict counts as unverified.
    unverified:
      Number(r.open_conflicts ?? 0) > 0 ||
      Number(r.q_unverified ?? 0) > 0 ||
      (Number(r.support_links ?? 0) === 0 && Number(r.q_approved ?? 0) === 0),
  };
}

export const UNIT_SUMMARY_SQL = `
  SELECT u.*, t.importance AS topic_importance, t.foundational AS topic_foundational,
    (SELECT COUNT(*) FROM questions q WHERE q.unit_id = u.id AND q.status = 'approved') AS q_approved,
    (SELECT COUNT(*) FROM questions q WHERE q.unit_id = u.id AND q.status IN ('pending','draft')) AS q_pending,
    (SELECT COUNT(*) FROM questions q WHERE q.unit_id = u.id AND q.status = 'flagged') AS q_flagged,
    (SELECT COUNT(*) FROM questions q WHERE q.unit_id = u.id AND q.status = 'approved' AND q.provenance = 'unverified') AS q_unverified,
    (SELECT COUNT(*) FROM source_links l WHERE l.role = 'supports' AND (
        (l.entity_type = 'unit' AND l.entity_id = u.id) OR
        (l.entity_type = 'question' AND l.entity_id IN (SELECT id FROM questions WHERE unit_id = u.id AND status = 'approved')))) AS support_links,
    (SELECT COUNT(*) FROM source_links l WHERE l.role = 'contradicts' AND l.resolved = 0 AND (
        (l.entity_type = 'unit' AND l.entity_id = u.id) OR
        (l.entity_type = 'question' AND l.entity_id IN (SELECT id FROM questions WHERE unit_id = u.id)))) AS open_conflicts
  FROM units u JOIN topics t ON t.id = u.topic_id`;

export function mapLink(r: Row): LinkDTO {
  return {
    id: Number(r.id),
    entityType: String(r.entity_type) as LinkDTO['entityType'],
    entityId: Number(r.entity_id),
    sourceId: Number(r.source_id),
    sourceTitle: String(r.source_title ?? ''),
    sourceKind: String(r.source_kind ?? 'manual') as LinkDTO['sourceKind'],
    chunkId: num(r.chunk_id),
    locator: str(r.locator) ?? str(r.chunk_label),
    locatorType: (str(r.chunk_locator_type) as LinkDTO['locatorType']) ?? null,
    locatorNum: num(r.chunk_locator_num),
    quote: str(r.quote),
    role: String(r.role) as LinkDTO['role'],
    resolved: bool(r.resolved),
    note: str(r.note),
    hasFile: r.source_file_path !== null && r.source_file_path !== undefined,
    url: str(r.source_url),
  };
}

export const LINK_SQL = `
  SELECT l.*, s.title AS source_title, s.kind AS source_kind, s.file_path AS source_file_path, s.url AS source_url,
         c.locator_label AS chunk_label, c.locator_type AS chunk_locator_type, c.locator_num AS chunk_locator_num
  FROM source_links l
  JOIN sources s ON s.id = l.source_id
  LEFT JOIN source_chunks c ON c.id = l.chunk_id`;

export function linksFor(entityType: string, ids: number[]): Map<number, LinkDTO[]> {
  const out = new Map<number, LinkDTO[]>();
  if (ids.length === 0) return out;
  const rows = all<Row>(
    `${LINK_SQL} WHERE l.entity_type = ? AND l.entity_id IN (SELECT value FROM json_each(?)) ORDER BY l.id`,
    entityType,
    JSON.stringify(ids),
  );
  for (const r of rows) {
    const id = Number(r.entity_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push(mapLink(r));
  }
  return out;
}

export function mapQuestion(r: Row, links: LinkDTO[] = []): QuestionDTO {
  return {
    id: Number(r.id),
    unitId: Number(r.unit_id),
    kind: String(r.kind) as QuestionDTO['kind'],
    prompt: String(r.prompt),
    answer: String(r.answer),
    explanation: str(r.explanation),
    hint: str(r.hint),
    keyPoints: parseJson<string[]>(r.key_points, []),
    structure: parseJson<AnswerStructure | null>(r.structure, null),
    relatedUnitIds: parseJson<number[]>(r.related_unit_ids, []),
    status: String(r.status) as QuestionDTO['status'],
    provenance: String(r.provenance) as QuestionDTO['provenance'],
    createdBy: String(r.created_by) as QuestionDTO['createdBy'],
    verifiedAt: str(r.verified_at),
    flagReason: str(r.flag_reason),
    validation: parseJson<ValidationReport | null>(r.validation, null),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    lastAskedOn: str(r.last_asked_on),
    links,
  };
}

export const QUESTION_SQL = `
  SELECT q.*, (SELECT MAX(r.local_date) FROM reviews r WHERE r.question_id = q.id) AS last_asked_on
  FROM questions q`;

export function mapReview(r: Row): ReviewDTO {
  return {
    id: Number(r.id),
    unitId: Number(r.unit_id),
    questionId: num(r.question_id),
    questionPrompt: str(r.question_prompt),
    questionKind: (str(r.question_kind) as ReviewDTO['questionKind']) ?? null,
    localDate: String(r.local_date),
    reviewedAt: String(r.reviewed_at),
    grade: String(r.grade) as ReviewDTO['grade'],
    effectiveGrade: String(r.effective_grade) as ReviewDTO['effectiveGrade'],
    hintUsed: bool(r.hint_used),
    isCorrection: bool(r.is_correction),
    userAnswer: str(r.user_answer),
    answerMs: num(r.answer_ms),
    totalMs: num(r.total_ms),
    errorType: (str(r.error_type) as ReviewDTO['errorType']) ?? null,
    confusedWith: str(r.confused_with),
    missingPoints: parseJson<string[]>(r.missing_points, []),
    note: str(r.note),
    prevStep: num(r.prev_step),
    newStep: num(r.new_step),
    prevDue: str(r.prev_due),
    newDue: str(r.new_due),
    intervalDays: num(r.interval_days),
    gapDays: num(r.gap_days),
    appearedBecause: parseJson<ReviewDTO['appearedBecause']>(r.appeared_because, []),
    scheduleReason: parseJson<Explanation | null>(r.schedule_reason, null),
    auditId: num(r.audit_id),
  };
}

export const REVIEW_SQL = `
  SELECT r.*, q.prompt AS question_prompt, q.kind AS question_kind,
    (SELECT a.id FROM audit_log a WHERE a.action = 'review.submit' AND a.entity_id = r.id AND a.undone_at IS NULL ORDER BY a.id DESC LIMIT 1) AS audit_id
  FROM reviews r LEFT JOIN questions q ON q.id = r.question_id`;
