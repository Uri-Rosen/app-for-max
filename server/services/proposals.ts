// Proposals: everything that enters the system without a person having
// written it — AI suggestions, syllabus topics, Quizlet imports held for
// review — and the approval queue that gates them into the schedule.

import { record } from '../audit.ts';
import { all, get, nowIso, parseJson, run, type Row } from '../db/index.ts';
import { getProvider, validateConflict, validateQuestion, validateTopic, validateUnit } from '../ai/index.ts';
import { polarity } from '../ai/mock.ts';
import { similarity } from '../ai/validate.ts';
import type { ChunkRef, Evidence, StyleExample, TopicSuggestion, UnitsOutput } from '../ai/types.ts';
import { parseCards, type ParseOptions } from '../importer/quizlet.ts';
import { isIsoDate } from '../../shared/dates.ts';
import type { LinkDTO, QuestionDTO, TopicDTO, UnitSummaryDTO, ValidationReport } from '../../shared/api.ts';
import { PROVENANCES, type Provenance, type SourceKind } from '../../shared/types.ts';
import { LINK_SQL, QUESTION_SQL, linksFor, mapLink, mapQuestion, mapTopic } from './mappers.ts';
import { whileBusy } from './busy.ts';
import { getSettings, today } from './settings.ts';
import { UserError, must } from './structure.ts';
import { approveQuestion, flagQuestion, insertLink, insertQuestion, insertUnit, rejectQuestion, unitSummaries } from './units.ts';

export function normName(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[֑-ׇ]/g, '')
    .toLowerCase()
    .replace(/["'`׳״.,:;!?()[\]{}\-–—_/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Two definitions of the same term conflict when they share little, or when one says "raises" and the other "lowers". */
function conflicting(a: string, b: string): boolean {
  // similarity() ignores Hebrew prefix letters (ה/ו/ב/ל/מ/ש/כ), so "הורמון" matches "ההורמון".
  return polarity(a) * polarity(b) < 0 || similarity(a, b) < 0.3;
}

function courseTopicIndex(courseId: number): Map<string, number> {
  const idx = new Map<string, number>();
  for (const t of all<Row>("SELECT id, name, merged_into_id, status FROM topics WHERE course_id = ? AND status IN ('active','proposed','merged')", courseId)) {
    const target = t.status === 'merged' && t.merged_into_id ? Number(t.merged_into_id) : Number(t.id);
    idx.set(normName(String(t.name)), target);
  }
  for (const a of all<Row>(
    'SELECT a.alias, a.topic_id FROM topic_aliases a JOIN topics t ON t.id = a.topic_id WHERE t.course_id = ?',
    courseId,
  )) {
    if (!idx.has(normName(String(a.alias)))) idx.set(normName(String(a.alias)), Number(a.topic_id));
  }
  return idx;
}

function styleExamples(courseId: number): StyleExample[] {
  return all<Row>(
    `SELECT q.kind, q.prompt, q.answer FROM questions q JOIN units u ON u.id = q.unit_id JOIN topics t ON t.id = u.topic_id
     WHERE q.status = 'approved' AND q.created_by IN ('user','quizlet')
     ORDER BY (t.course_id = ?) DESC, q.id DESC LIMIT 12`,
    courseId,
  ).map((r) => ({ kind: r.kind as StyleExample['kind'], prompt: String(r.prompt), answer: String(r.answer) }));
}

function evidenceLinks(evidence: Evidence[], chunks: Map<number, ChunkRef>): { sourceId: number; chunkId: number; quote: string; locator: string }[] {
  const out: { sourceId: number; chunkId: number; quote: string; locator: string }[] = [];
  for (const e of evidence) {
    const c = chunks.get(e.chunkId);
    if (!c) continue;
    out.push({ sourceId: c.sourceId, chunkId: c.chunkId, quote: e.quote, locator: c.locatorLabel });
  }
  return out;
}

export interface SuggestResult {
  runId: number;
  auditId: number | null;
  provider: string;
  topics: number;
  units: number;
  questions: number;
  conflicts: number;
  skipped: number;
  failedValidation: number;
  durationMs: number;
}

/**
 * Asks the configured provider for suggestions from one approved source and
 * stores them as proposals. Nothing here is scheduled: topics and units land
 * as `proposed`, questions as `pending`, each with its validation report.
 */
const suggesting = new Set<number>();

export async function suggestFromSource(sourceId: number, task: 'topics' | 'units', opts: { chunkIds?: number[]; topicHint?: string | null } = {}): Promise<SuggestResult> {
  // Two overlapping runs on one source would both see "no such topic yet" and duplicate every proposal.
  if (suggesting.has(sourceId)) throw new UserError('כבר רצה בקשת הצעות למקור הזה — חכה שתסתיים');
  suggesting.add(sourceId);
  try {
    return await whileBusy(() => suggestNow(sourceId, task, opts));
  } finally {
    suggesting.delete(sourceId);
  }
}

async function suggestNow(sourceId: number, task: 'topics' | 'units', opts: { chunkIds?: number[]; topicHint?: string | null }): Promise<SuggestResult> {
  const source = must(get<Row>('SELECT * FROM sources WHERE id = ?', sourceId), 'המקור');
  if (source.status !== 'approved') throw new UserError('אפשר לבקש הצעות רק ממקור שאושר במסך הייבוא');
  if (source.course_id === null) throw new UserError('המקור לא משויך לקורס');
  const courseId = Number(source.course_id);
  const course = get<Row>('SELECT * FROM courses WHERE id = ?', courseId)!;
  const settings = getSettings();
  const provider = getProvider(settings);

  const chunkRows = all<Row>(
    `SELECT c.* FROM source_chunks c WHERE c.source_id = ? ${opts.chunkIds?.length ? 'AND c.id IN (SELECT value FROM json_each(?))' : ''} ORDER BY c.seq`,
    ...(opts.chunkIds?.length ? [sourceId, JSON.stringify(opts.chunkIds)] : [sourceId]),
  );
  if (chunkRows.length === 0) throw new UserError('אין במקור טקסט שחולץ');
  const chunks: ChunkRef[] = chunkRows.map((c) => ({
    chunkId: Number(c.id),
    sourceId,
    sourceTitle: String(source.title),
    sourceKind: String(source.kind) as SourceKind,
    locatorLabel: String(c.locator_label),
    heading: (c.heading as string | null) ?? null,
    text: [String(c.text), c.notes ? `הערות מרצה: ${String(c.notes)}` : ''].filter(Boolean).join('\n'),
  }));
  const chunkMap = new Map(chunks.map((c) => [c.chunkId, c]));
  const existingTopics = [...new Set(all<Row>("SELECT name FROM topics WHERE course_id = ? AND status IN ('active','proposed')", courseId).map((r) => String(r.name)))];

  const t0 = Date.now();
  let topicOut: TopicSuggestion[] = [];
  let unitOut: UnitsOutput = { units: [], conflicts: [] };
  try {
    if (task === 'topics') topicOut = await provider.suggestTopics({ course: String(course.name), chunks, existingTopics });
    else
      unitOut = await provider.suggestUnits({
        course: String(course.name),
        topicHint: opts.topicHint ?? null,
        chunks,
        existingTopics,
        style: styleExamples(courseId),
      });
  } catch (e) {
    run(
      'INSERT INTO ai_runs (provider, model, task, source_id, course_id, chunk_ids, error, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      provider.id,
      provider.id === 'ollama' ? settings.ollamaModel : null,
      task,
      sourceId,
      courseId,
      JSON.stringify(chunks.map((c) => c.chunkId)),
      (e as Error).message,
      Date.now() - t0,
      nowIso(),
    );
    throw new UserError(`ספק ה־AI נכשל: ${(e as Error).message}`);
  }
  const durationMs = Date.now() - t0;
  // Built after the await: topics may have been added while the provider was thinking.
  const topicIdx = courseTopicIndex(courseId);
  const lessonDate = get<{ d: string | null }>(
    'SELECT MIN(l.studied_on) AS d FROM lessons l JOIN lesson_sources ls ON ls.lesson_id = l.id WHERE ls.source_id = ?',
    sourceId,
  )?.d;
  const learnedOn = (source.studied_on as string | null) || lessonDate || today();

  const stats = { topics: 0, units: 0, questions: 0, conflicts: 0, skipped: 0, failedValidation: 0 };
  const runId = run(
    'INSERT INTO ai_runs (provider, model, task, source_id, course_id, chunk_ids, output, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    provider.id,
    provider.id === 'ollama' ? settings.ollamaModel : null,
    task,
    sourceId,
    courseId,
    JSON.stringify(chunks.map((c) => c.chunkId)),
    JSON.stringify(task === 'topics' ? topicOut : unitOut),
    durationMs,
    nowIso(),
  ).lastId;

  const { auditId } = record(
    { action: 'ai.suggest', summary: `הצעות ${provider.label} מתוך "${String(source.title)}"`, entityType: 'source', entityId: sourceId },
    (cs) => {
      const newTopic = (name: string, parentId: number | null, v: ValidationReport | null, order: number | null): number => {
        const id = cs.insert('topics', {
          course_id: courseId,
          parent_id: parentId,
          name: name.slice(0, 300),
          importance: 'normal',
          foundational: 0,
          position: 1000 + (order ?? 0),
          status: 'proposed',
          syllabus_order: order,
          created_by: source.kind === 'syllabus' ? 'syllabus' : 'ai',
          ai_run_id: runId,
          validation: v ? JSON.stringify(v) : null,
          created_at: nowIso(),
        });
        topicIdx.set(normName(name), id);
        return id;
      };

      for (const t of topicOut) {
        const key = normName(t.name);
        if (!key || topicIdx.has(key)) {
          stats.skipped++;
          continue;
        }
        const v = validateTopic(t, chunkMap);
        if (!v.ok) stats.failedValidation++;
        const parentId = t.parentName ? (topicIdx.get(normName(t.parentName)) ?? null) : null;
        const id = newTopic(t.name, parentId, v, t.syllabusOrder);
        for (const l of evidenceLinks(t.evidence, chunkMap)) insertLink(cs, { entityType: 'topic', entityId: id, ...l, role: 'supports' });
        stats.topics++;
      }

      const createdUnits: { id: number; title: string; content: string; chunkIds: Set<number> }[] = [];
      for (const u of unitOut.units) {
        const uv = validateUnit(u, chunkMap);
        if (!uv.ok) stats.failedValidation++;
        let topicId = topicIdx.get(normName(u.topicName || opts.topicHint || String(source.title)));
        if (topicId === undefined) topicId = newTopic(u.topicName || opts.topicHint || String(source.title), null, null, null);

        // An existing unit with the same title gets the new questions instead of a duplicate unit.
        const existing = get<Row>(
          `SELECT u.id FROM units u JOIN topics t ON t.id = u.topic_id
           WHERE t.course_id = ? AND u.status IN ('active','proposed','suspended') AND lower(u.title) = lower(?) LIMIT 1`,
          courseId,
          u.title,
        );
        let unitId: number;
        if (existing) {
          unitId = Number(existing.id);
          stats.skipped++;
          // A new source saying something different about an existing unit is exactly the conflict to surface.
          const ex = get<Row>('SELECT content FROM units WHERE id = ?', unitId);
          const cited = evidenceLinks(u.evidence, chunkMap);
          // Only with a citation to show: a flag the user can't see the reason for can't be resolved.
          if (cited.length > 0 && ex?.content && u.content && conflicting(u.content, String(ex.content))) {
            const opposite = polarity(u.content) * polarity(String(ex.content)) < 0;
            for (const l of cited) {
              insertLink(cs, {
                entityType: 'unit',
                entityId: unitId,
                ...l,
                role: 'contradicts',
                note: opposite
                  ? `"${u.title}": המקור הזה מתאר כיוון השפעה הפוך — צריך לבדוק מה נכון`
                  : `"${u.title}" מוגדר אחרת במקור הזה — צריך להחליט איזו הגדרה נכונה`,
              });
            }
            for (const q of all<Row>("SELECT id FROM questions WHERE unit_id = ? AND status = 'approved'", unitId)) {
              flagQuestion(Number(q.id), 'סתירה בין מקורות — ממתין ליישוב', cs);
            }
            stats.conflicts++;
          }
        } else {
          unitId = insertUnit(
            cs,
            { topicId, title: u.title, content: u.content, learnedOn },
            { status: 'proposed', createdBy: 'ai', aiRunId: runId, validation: uv },
          );
          for (const l of evidenceLinks(u.evidence, chunkMap)) insertLink(cs, { entityType: 'unit', entityId: unitId, ...l, role: 'supports' });
          createdUnits.push({ id: unitId, title: u.title, content: u.content, chunkIds: new Set(u.evidence.map((e) => e.chunkId)) });
          stats.units++;
        }
        for (const q of u.questions) {
          const qv = validateQuestion(q, chunkMap);
          if (!qv.ok) stats.failedValidation++;
          const kinds = new Set(q.evidence.map((e) => chunkMap.get(e.chunkId)?.sourceKind));
          const provenance: Provenance = kinds.size === 1 && kinds.has('past_exam') ? 'past_exam' : 'generated';
          let qid: number;
          try {
            qid = insertQuestion(
              cs,
              {
                unitId,
                kind: q.kind,
                prompt: q.prompt,
                answer: q.answer,
                explanation: q.explanation,
                hint: q.hint,
                keyPoints: q.keyPoints,
                structure: q.structure,
              },
              { status: 'pending', createdBy: 'ai', provenance, aiRunId: runId, validation: qv },
            );
          } catch {
            stats.skipped++;
            continue;
          }
          for (const l of evidenceLinks(q.evidence, chunkMap)) insertLink(cs, { entityType: 'question', entityId: qid, ...l, role: 'supports' });
          stats.questions++;
        }
      }

      // Conflicts the provider saw inside this source.
      for (const c of unitOut.conflicts) {
        const cv = validateConflict(c, chunkMap);
        if (!cv.ok) continue;
        const target = createdUnits.find((u) => c.evidence.some((e) => u.chunkIds.has(e.chunkId)));
        if (!target) continue;
        const other = c.evidence.find((e) => !target.chunkIds.has(e.chunkId)) ?? c.evidence[1];
        const oc = chunkMap.get(other.chunkId);
        if (!oc) continue;
        insertLink(cs, { entityType: 'unit', entityId: target.id, sourceId: oc.sourceId, chunkId: oc.chunkId, quote: other.quote, locator: oc.locatorLabel, role: 'contradicts', note: c.description });
        stats.conflicts++;
      }

      // Deterministic cross-check: the same term already defined differently elsewhere in the course.
      for (const u of createdUnits) {
        const others = all<Row>(
          `SELECT u.id, u.title, u.content FROM units u JOIN topics t ON t.id = u.topic_id
           WHERE t.course_id = ? AND u.id != ? AND u.status IN ('active','proposed') AND u.content IS NOT NULL`,
          courseId,
          u.id,
        ).filter((o) => normName(String(o.title)) === normName(u.title));
        for (const o of others) {
          if (!conflicting(u.content, String(o.content))) continue;
          const opposite = polarity(u.content) * polarity(String(o.content)) < 0;
          const link = get<Row>(
            `SELECT * FROM source_links WHERE role = 'supports' AND ((entity_type = 'unit' AND entity_id = ?)
               OR (entity_type = 'question' AND entity_id IN (SELECT id FROM questions WHERE unit_id = ?))) AND source_id != ? LIMIT 1`,
            o.id,
            o.id,
            sourceId,
          );
          if (!link) continue;
          insertLink(cs, {
            entityType: 'unit',
            entityId: u.id,
            sourceId: link.source_id,
            chunkId: link.chunk_id,
            quote: link.quote ?? o.content,
            locator: link.locator,
            role: 'contradicts',
            note: opposite
              ? `"${u.title}": מקור אחר של הקורס מתאר כיוון השפעה הפוך — צריך לבדוק מה נכון`
              : `"${u.title}" מוגדר אחרת במקור אחר של הקורס — צריך להחליט איזו הגדרה נכונה`,
          });
          stats.conflicts++;
        }
      }
    },
  );

  run('UPDATE ai_runs SET stats = ? WHERE id = ?', JSON.stringify(stats), runId);
  return { runId, auditId, provider: provider.label, ...stats, durationMs };
}

// ---------- the approval queue ----------

export function reviewQueue() {
  const topicRows = all<Row>("SELECT * FROM topics WHERE status = 'proposed' ORDER BY course_id, COALESCE(syllabus_order, 1e9), id");
  const topicLinks = linksFor('topic', topicRows.map((t) => Number(t.id)));
  const topics: (TopicDTO & { courseName: string; links: LinkDTO[] })[] = topicRows.map((t) => ({
    ...mapTopic(t),
    courseName: String(get<Row>('SELECT name FROM courses WHERE id = ?', t.course_id)?.name ?? ''),
    links: topicLinks.get(Number(t.id)) ?? [],
  }));

  const units = unitSummaries("u.status = 'proposed' ORDER BY u.id");
  const unitIds = units.map((u) => u.id);
  const unitLinks = linksFor('unit', unitIds);
  const unitInfo = new Map(
    all<Row>(
      `SELECT u.id, u.content, u.validation, t.name AS topic_name, t.status AS topic_status, c.name AS course_name
       FROM units u JOIN topics t ON t.id = u.topic_id JOIN courses c ON c.id = t.course_id WHERE u.id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(unitIds),
    ).map((r) => [Number(r.id), r]),
  );

  const qRows = all<Row>(
    `${QUESTION_SQL} JOIN units u ON u.id = q.unit_id
     WHERE q.status IN ('pending','draft','flagged') AND u.status IN ('active','proposed','suspended') ORDER BY q.unit_id, q.id`,
  );
  const qLinks = linksFor('question', qRows.map((q) => Number(q.id)));
  const questions = qRows.map((q) => mapQuestion(q, qLinks.get(Number(q.id)) ?? []));
  const byUnit = new Map<number, QuestionDTO[]>();
  for (const q of questions) {
    const list = byUnit.get(q.unitId) ?? [];
    list.push(q);
    byUnit.set(q.unitId, list);
  }

  const proposedUnits = units.map((u) => {
    const info = unitInfo.get(u.id)!;
    return {
      unit: u,
      content: (info.content as string | null) ?? null,
      validation: parseJson<ValidationReport | null>(info.validation, null),
      topicName: String(info.topic_name),
      topicProposed: info.topic_status === 'proposed',
      courseName: String(info.course_name),
      links: unitLinks.get(u.id) ?? [],
      questions: byUnit.get(u.id) ?? [],
    };
  });

  // Questions waiting on units that are already active.
  const activeUnitIds = [...byUnit.keys()].filter((id) => !unitIds.includes(id));
  const activeUnits = activeUnitIds.length ? unitSummaries('u.id IN (SELECT value FROM json_each(?))', JSON.stringify(activeUnitIds)) : [];
  const pendingInActive = activeUnits.map((u) => ({
    unit: u,
    pending: (byUnit.get(u.id) ?? []).filter((q) => q.status !== 'flagged'),
    flagged: (byUnit.get(u.id) ?? []).filter((q) => q.status === 'flagged'),
  }));

  const conflicts = all<Row>(`${LINK_SQL} WHERE l.role = 'contradicts' AND l.resolved = 0 ORDER BY l.id`).map((r) => {
    const link = mapLink(r);
    const entityTitle =
      link.entityType === 'unit'
        ? String(get<Row>('SELECT title FROM units WHERE id = ?', link.entityId)?.title ?? '')
        : link.entityType === 'question'
          ? String(get<Row>('SELECT prompt FROM questions WHERE id = ?', link.entityId)?.prompt ?? '')
          : String(get<Row>('SELECT name FROM topics WHERE id = ?', link.entityId)?.name ?? '');
    const unitId =
      link.entityType === 'unit' ? link.entityId : link.entityType === 'question' ? Number(get<Row>('SELECT unit_id FROM questions WHERE id = ?', link.entityId)?.unit_id ?? 0) : null;
    const supporting = unitId ? (linksFor('unit', [unitId]).get(unitId) ?? []).filter((l) => l.role === 'supports') : [];
    const content = unitId ? ((get<Row>('SELECT content FROM units WHERE id = ?', unitId)?.content as string | null) ?? null) : null;
    return { link, entityTitle, unitId, supporting, content };
  });

  const sourcesAwaiting = get<{ n: number }>("SELECT COUNT(*) AS n FROM sources WHERE status IN ('extracted','partial')")!.n;

  return {
    topics,
    units: proposedUnits,
    pendingInActive,
    conflicts,
    sourcesAwaiting,
    counts: {
      topics: topics.length,
      units: proposedUnits.length,
      questions: questions.filter((q) => q.status !== 'flagged').length,
      flagged: questions.filter((q) => q.status === 'flagged').length,
      conflicts: conflicts.length,
    },
  };
}

export type ReviewQueueDTO = ReturnType<typeof reviewQueue>;

export function queueCounts(): { pending: number; flagged: number; conflicts: number; topics: number; units: number; sources: number } {
  const r = get<Row>(
    `SELECT
      (SELECT COUNT(*) FROM questions q JOIN units u ON u.id = q.unit_id WHERE q.status IN ('pending','draft') AND u.status IN ('active','proposed','suspended')) AS pending,
      (SELECT COUNT(*) FROM questions q JOIN units u ON u.id = q.unit_id WHERE q.status = 'flagged' AND u.status IN ('active','proposed','suspended')) AS flagged,
      (SELECT COUNT(*) FROM source_links WHERE role = 'contradicts' AND resolved = 0) AS conflicts,
      (SELECT COUNT(*) FROM topics WHERE status = 'proposed') AS topics,
      (SELECT COUNT(*) FROM units WHERE status = 'proposed') AS units,
      (SELECT COUNT(*) FROM sources WHERE status IN ('extracted','partial','error','changed')) AS sources`,
  )!;
  return {
    pending: Number(r.pending),
    flagged: Number(r.flagged),
    conflicts: Number(r.conflicts),
    topics: Number(r.topics),
    units: Number(r.units),
    sources: Number(r.sources),
  };
}

export function bulkQuestions(ids: number[], action: 'approve' | 'reject', b: Row): { done: number; errors: { id: number; error: string }[] } {
  let done = 0;
  const errors: { id: number; error: string }[] = [];
  for (const id of ids) {
    try {
      if (action === 'approve') approveQuestion(id, b);
      else rejectQuestion(id, b);
      done++;
    } catch (e) {
      errors.push({ id, error: (e as Error).message });
    }
  }
  return { done, errors };
}

// ---------- Quizlet / pasted cards ----------

export function previewCards(text: string, opts: ParseOptions) {
  return parseCards(text, opts);
}

/**
 * Imports pasted cards as units with one question each. The learner's own
 * cards may go straight into the schedule; the whole import is one undoable action.
 */
export function importCards(b: Row): { units: number; questions: number; skipped: number; auditId: number | null; unitIds: number[] } {
  const text = String(b.text ?? '');
  if (!text.trim()) throw new UserError('לא הודבק טקסט');
  const { cards, skipped } = parseCards(text, { termSep: b.termSep as string, cardSep: b.cardSep as string });
  if (cards.length === 0) throw new UserError('לא נמצאו כרטיסים בטקסט');
  if (cards.length > 2000) throw new UserError('יותר מדי כרטיסים בייבוא אחד (עד 2000)');
  const courseId = Number(b.courseId);
  must(get('SELECT id FROM courses WHERE id = ?', courseId), 'הקורס');
  const learnedOn = isIsoDate(b.learnedOn) ? String(b.learnedOn) : today();
  const provenance = (PROVENANCES as readonly string[]).includes(String(b.provenance)) ? (String(b.provenance) as Provenance) : 'unverified';
  const status = b.reviewFirst ? 'pending' : 'approved';
  const unitIds: number[] = [];
  const { auditId } = record({ action: 'import.cards', summary: `ייבוא ${cards.length} כרטיסים (Quizlet)`, entityType: 'course', entityId: courseId }, (cs) => {
    let topicId = b.topicId ? Number(b.topicId) : null;
    if (!topicId) {
      const name = String(b.topicName ?? '').trim() || 'כרטיסים מיובאים';
      topicId = cs.insert('topics', { course_id: courseId, name, importance: 'normal', foundational: 0, position: 999, status: 'active', created_by: 'quizlet', created_at: nowIso() });
    }
    for (const c of cards) {
      const unitId = insertUnit(cs, { topicId, title: c.term.replace(/_{3,}/g, '…').slice(0, 300), content: c.definition, learnedOn, lessonId: b.lessonId ?? null });
      insertQuestion(cs, { unitId, kind: c.kind, prompt: c.prompt, answer: c.definition, provenance }, { status, createdBy: 'quizlet' });
      if (b.sourceId) insertLink(cs, { entityType: 'unit', entityId: unitId, sourceId: Number(b.sourceId), role: 'supports' });
      unitIds.push(unitId);
    }
  });
  return { units: cards.length, questions: cards.length, skipped: skipped.length, auditId, unitIds };
}

export function unitsLite(ids: number[]): UnitSummaryDTO[] {
  return ids.length ? unitSummaries('u.id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)) : [];
}
