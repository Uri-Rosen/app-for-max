// The daily session: which units are due, in what order, what fits in the
// time budget, what was deferred and why, and recording each answer.

import { record } from '../audit.ts';
import { all, get, nowIso, parseJson, run, type Row } from '../db/index.ts';
import { addDays, daysBetween } from '../../shared/dates.ts';
import { planDay, prioritize, type Candidate } from '../../shared/planner.ts';
import { pickQuestion } from '../../shared/questionPick.ts';
import { confidence, effectiveGrade, previewGrades, schedule, type SchedState } from '../../shared/scheduler.ts';
import type { QuestionDTO, ReviewResultDTO, SessionItemDTO, TodayDTO } from '../../shared/api.ts';
import { ERROR_TYPES, GRADES, type EffectiveGrade, type ErrorType, type Grade, type Importance, type Settings } from '../../shared/types.ts';
import { QUESTION_SQL, linksFor, mapQuestion } from './mappers.ts';
import { clockOffset, getSettings, now, today } from './settings.ts';
import { UserError, must } from './structure.ts';
import { flagQuestion } from './units.ts';

const MAX_REVIEW_MS = 30 * 60_000;
/** A single answer longer than this is probably the learner walking away; cap it for time estimates. */
const EST_CAP_SECONDS = 600;

interface UnitCandidate extends Candidate {
  row: Row;
  question: QuestionDTO;
  questionWhy: string;
}

export function stateOf(u: Row): SchedState {
  return {
    step: Number(u.step),
    dueDate: (u.due_date as string | null) ?? null,
    lastReviewedOn: (u.last_reviewed_on as string | null) ?? null,
    lastGrade: (u.last_grade as EffectiveGrade | null) ?? null,
    reps: Number(u.reps),
    lapses: Number(u.lapses),
    cleanStreak: Number(u.clean_streak),
    remediation: Number(u.remediation) === 1,
    recentGrades: parseJson<EffectiveGrade[]>(u.recent_grades, []),
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const UNIT_BASE_SQL = `
  SELECT u.*, t.importance AS topic_importance, t.foundational AS topic_foundational, t.name AS topic_name,
         c.name AS course_name, c.color AS course_color, c.exam_date AS exam_date
  FROM units u JOIN topics t ON t.id = u.topic_id JOIN courses c ON c.id = t.course_id`;
const UNIT_ROWS_SQL = `${UNIT_BASE_SQL} WHERE u.status = 'active' AND c.archived = 0 AND u.due_date IS NOT NULL`;

function estimates(unitIds: number[], settings: Settings): Map<number, number> {
  const rows = all<{ unit_id: number; total_ms: number }>(
    `SELECT unit_id, total_ms FROM reviews
     WHERE unit_id IN (SELECT value FROM json_each(?)) AND total_ms IS NOT NULL ORDER BY reviewed_at DESC`,
    JSON.stringify(unitIds),
  );
  const global = median(
    all<{ total_ms: number }>('SELECT total_ms FROM reviews WHERE total_ms IS NOT NULL ORDER BY reviewed_at DESC LIMIT 50').map((r) =>
      Math.min(EST_CAP_SECONDS, r.total_ms / 1000),
    ),
  );
  const byUnit = new Map<number, number[]>();
  for (const r of rows) {
    const list = byUnit.get(r.unit_id) ?? [];
    if (list.length < 5) list.push(Math.min(EST_CAP_SECONDS, r.total_ms / 1000));
    byUnit.set(r.unit_id, list);
  }
  const out = new Map<number, number>();
  for (const id of unitIds) {
    const m = median(byUnit.get(id) ?? []);
    out.set(id, Math.round(m ?? global ?? settings.defaultAnswerSeconds));
  }
  return out;
}

function approvedQuestions(unitIds: number[]): Map<number, QuestionDTO[]> {
  const rows = all<Row>(
    `${QUESTION_SQL} WHERE q.unit_id IN (SELECT value FROM json_each(?)) AND q.status = 'approved' ORDER BY q.id`,
    JSON.stringify(unitIds),
  );
  const links = linksFor('question', rows.map((r) => Number(r.id)));
  const out = new Map<number, QuestionDTO[]>();
  for (const r of rows) {
    const q = mapQuestion(r, links.get(Number(r.id)) ?? []);
    const list = out.get(q.unitId) ?? [];
    list.push(q);
    out.set(q.unitId, list);
  }
  return out;
}

function buildCandidates(maxDue: string, settings: Settings): { candidates: UnitCandidate[]; blocked: TodayDTO['blocked'] } {
  const rows = all<Row>(`${UNIT_ROWS_SQL} AND u.due_date <= ? ORDER BY u.due_date, u.id`, maxDue);
  const ids = rows.map((r) => Number(r.id));
  const qs = approvedQuestions(ids);
  const est = estimates(ids, settings);
  const candidates: UnitCandidate[] = [];
  const blocked: TodayDTO['blocked'] = [];
  for (const r of rows) {
    const id = Number(r.id);
    const list = qs.get(id) ?? [];
    const st = stateOf(r);
    const pick = pickQuestion(list, { step: st.step, lastGrade: st.lastGrade, lastQuestionId: r.last_question_id === null ? null : Number(r.last_question_id) });
    if (!pick) {
      const flagged = get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE unit_id = ? AND status = 'flagged'", id)!.n;
      const pending = get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE unit_id = ? AND status IN ('pending','draft')", id)!.n;
      blocked.push({
        unitId: id,
        title: String(r.title),
        dueDate: String(r.due_date),
        reason:
          flagged > 0
            ? 'כל השאלות של היחידה מסומנות לבדיקה (סתירה או שאלה לא ברורה) — צריך לטפל בהן במסך הבדיקה'
            : pending > 0
              ? 'לשאלות של היחידה עדיין אין אישור — אשר אותן במסך הבדיקה'
              : 'אין ליחידה שאלות — הוסף שאלה בעמוד היחידה',
      });
      continue;
    }
    candidates.push({
      unitId: id,
      dueDate: String(r.due_date),
      learnedOn: String(r.learned_on),
      lastReviewedOn: st.lastReviewedOn,
      lastGrade: st.lastGrade,
      remediation: st.remediation,
      importance: ((r.importance as Importance | null) ?? (r.topic_importance as Importance)) || 'normal',
      foundational: r.foundational === null ? Number(r.topic_foundational) === 1 : Number(r.foundational) === 1,
      examDate: (r.exam_date as string | null) ?? null,
      questionKind: pick.question.kind,
      estSeconds: est.get(id)!,
      row: r,
      question: pick.question,
      questionWhy: pick.why,
    });
  }
  return { candidates, blocked };
}

function historyFor(unitIds: number[]): Map<number, SessionItemDTO['history']> {
  const rows = all<Row>(
    `SELECT unit_id, local_date, effective_grade, hint_used, is_correction FROM reviews
     WHERE unit_id IN (SELECT value FROM json_each(?)) ORDER BY reviewed_at DESC`,
    JSON.stringify(unitIds),
  );
  const out = new Map<number, SessionItemDTO['history']>();
  for (const r of rows) {
    const list = out.get(Number(r.unit_id)) ?? [];
    if (list.length < 6)
      list.push({
        localDate: String(r.local_date),
        effectiveGrade: r.effective_grade as EffectiveGrade,
        hintUsed: Number(r.hint_used) === 1,
        isCorrection: Number(r.is_correction) === 1,
      });
    out.set(Number(r.unit_id), list);
  }
  return out;
}

function toItem(
  c: UnitCandidate,
  p: { rank: number; reasons: SessionItemDTO['reasons']; deferReason: string | null },
  d: string,
  settings: Settings,
  history: Map<number, SessionItemDTO['history']>,
  isCorrection = false,
): SessionItemDTO {
  const st = stateOf(c.row);
  return {
    unitId: c.unitId,
    unitTitle: String(c.row.title),
    unitContent: (c.row.content as string | null) ?? null,
    courseName: String(c.row.course_name),
    courseColor: (c.row.course_color as string | null) ?? null,
    topicName: String(c.row.topic_name),
    rank: p.rank,
    reasons: p.reasons,
    deferReason: p.deferReason,
    dueDate: c.dueDate,
    estSeconds: c.estSeconds,
    step: st.step,
    confidence: confidence(st),
    question: c.question,
    questionWhy: c.questionWhy,
    history: history.get(c.unitId) ?? [],
    preview: previewGrades(st, d, false, settings),
    previewHint: previewGrades(st, d, true, settings),
    unverified: c.question.provenance === 'unverified',
    isCorrection,
  };
}

function spentOn(d: string): TodayDTO['spent'] {
  const r = get<{ secs: number | null; n: number; corr: number }>(
    `SELECT SUM(MIN(COALESCE(total_ms, 0), ?)) / 1000.0 AS secs,
            SUM(CASE WHEN is_correction = 0 THEN 1 ELSE 0 END) AS n,
            SUM(CASE WHEN is_correction = 1 THEN 1 ELSE 0 END) AS corr
     FROM reviews WHERE local_date = ?`,
    EST_CAP_SECONDS * 1000,
    d,
  )!;
  return { seconds: Math.round(r.secs ?? 0), count: Number(r.n ?? 0), corrections: Number(r.corr ?? 0) };
}

/** Remembers everything that was due on a day, so "done vs. due" can be measured later. Bookkeeping, not an action. */
function touchDayLog(d: string, dueIds: number[], budget: number): void {
  const cur = get<Row>('SELECT * FROM day_log WHERE local_date = ?', d);
  if (!cur) {
    backfillMissedDays(d, budget);
    run('INSERT INTO day_log (local_date, due_unit_ids, first_seen_at, budget_minutes) VALUES (?, ?, ?, ?)', d, JSON.stringify(dueIds), nowIso(), budget);
    return;
  }
  const merged = new Set<number>(parseJson<number[]>(cur.due_unit_ids, []));
  const before = merged.size;
  for (const id of dueIds) merged.add(id);
  if (merged.size > before) run('UPDATE day_log SET due_unit_ids = ? WHERE local_date = ?', JSON.stringify([...merged]), d);
}

/**
 * Days the app was never opened still had reviews due. On the first visit of
 * a new day — before anything is answered — due dates haven't moved since the
 * last visit, so "due on or before day m" is exactly what was due on m.
 */
function backfillMissedDays(d: string, budget: number): void {
  const last = get<{ d: string | null }>('SELECT MAX(local_date) AS d FROM day_log WHERE local_date < ?', d)?.d;
  if (!last) return;
  const answeredToday = get<{ n: number }>('SELECT COUNT(*) AS n FROM reviews WHERE local_date = ?', d)!.n;
  if (answeredToday > 0) return;
  const start = addDays(last, 1);
  const from = daysBetween(start, d) > 60 ? addDays(d, -60) : start;
  for (let m = from; m < d; m = addDays(m, 1)) {
    const ids = all<{ id: number }>(
      `SELECT u.id FROM units u JOIN topics t ON t.id = u.topic_id JOIN courses c ON c.id = t.course_id
       WHERE u.status = 'active' AND c.archived = 0 AND u.due_date IS NOT NULL AND u.due_date <= ?
         AND date(u.created_at, 'localtime') <= ?`,
      m,
      m,
    ).map((r) => r.id);
    run('INSERT OR IGNORE INTO day_log (local_date, due_unit_ids, first_seen_at, budget_minutes) VALUES (?, ?, ?, ?)', m, JSON.stringify(ids), 'backfill', budget);
  }
}

/** Units answered wrong today that haven't had their in-session correction yet. */
function pendingCorrections(d: string): { unitId: number; questionId: number | null }[] {
  const rows = all<Row>('SELECT id, unit_id, question_id, effective_grade, is_correction FROM reviews WHERE local_date = ? ORDER BY reviewed_at, id', d);
  const pending = new Map<number, number | null>();
  for (const r of rows) {
    const unitId = Number(r.unit_id);
    if (Number(r.is_correction) === 1) pending.delete(unitId);
    else if (r.effective_grade === 'wrong') pending.set(unitId, r.question_id === null ? null : Number(r.question_id));
    else pending.delete(unitId);
  }
  return [...pending].map(([unitId, questionId]) => ({ unitId, questionId }));
}

export function getToday(opts: { beyond?: boolean } = {}): TodayDTO {
  const settings = getSettings();
  const d = today();
  const tomorrow = addDays(d, 1);
  const spent = spentOn(d);

  const { candidates, blocked: blockedAll } = buildCandidates(tomorrow, settings);
  const dueNow = candidates.filter((c) => c.dueDate <= d);
  const blocked = blockedAll.filter((b) => b.dueDate <= d);
  const plan = planDay(dueNow, d, spent, settings, { ignoreBudget: opts.beyond });
  touchDayLog(d, [...dueNow.map((c) => c.unitId), ...blocked.map((b) => b.unitId)], settings.budgetMinutes);

  const corr = pendingCorrections(d);
  const corrUnitIds = corr.map((c) => c.unitId);
  const history = historyFor([...dueNow.map((c) => c.unitId), ...corrUnitIds]);

  const queue = plan.included.map((p) => toItem(p.candidate, p, d, settings, history));
  const deferred = plan.deferred.map((p) => toItem(p.candidate, p, d, settings, history));

  // Corrections re-ask the exact question that failed, once, at the end of the session.
  const corrections: SessionItemDTO[] = [];
  if (corr.length > 0) {
    const rows = all<Row>(`${UNIT_ROWS_SQL} AND u.id IN (SELECT value FROM json_each(?))`, JSON.stringify(corrUnitIds));
    const qs = approvedQuestions(corrUnitIds);
    const flaggedToo = all<Row>(`${QUESTION_SQL} WHERE q.id IN (SELECT value FROM json_each(?))`, JSON.stringify(corr.map((c) => c.questionId)));
    for (const c of corr) {
      const r = rows.find((x) => Number(x.id) === c.unitId);
      if (!r) continue;
      const q =
        (qs.get(c.unitId) ?? []).find((x) => x.id === c.questionId) ??
        (flaggedToo.find((x) => Number(x.id) === c.questionId) ? mapQuestion(flaggedToo.find((x) => Number(x.id) === c.questionId)!) : null);
      if (!q) continue;
      const cand: UnitCandidate = {
        unitId: c.unitId,
        dueDate: String(r.due_date),
        learnedOn: String(r.learned_on),
        lastReviewedOn: (r.last_reviewed_on as string | null) ?? null,
        lastGrade: (r.last_grade as EffectiveGrade | null) ?? null,
        remediation: Number(r.remediation) === 1,
        importance: 'normal',
        foundational: false,
        examDate: null,
        questionKind: q.kind,
        estSeconds: 30,
        row: r,
        question: q,
        questionWhy: 'שאלת תיקון: אותה שאלה שנכשלה קודם בסשן, כדי לסגור את הפער כל עוד הוא טרי. לא משנה את התזמון.',
      };
      corrections.push(
        toItem(cand, { rank: 0, reasons: [{ code: 'failed_recently', text: 'נכשלה קודם בסשן הזה' }], deferReason: null }, d, settings, history, true),
      );
    }
  }

  // Tomorrow: what is already scheduled for tomorrow plus anything deferred today.
  const tomorrowPlan = planDay(candidates, tomorrow, { seconds: 0, count: 0 }, settings);
  const todayQueueIds = new Set(queue.map((q) => q.unitId));
  const tomorrowItems = tomorrowPlan.items.filter((p) => !todayQueueIds.has(p.candidate.unitId));
  const tomorrowIncluded = tomorrowItems.slice(0, settings.maxItems);

  const last = get<Row>(
    `SELECT r.id, r.local_date, r.schedule_reason, r.is_correction, u.title,
       (SELECT a.id FROM audit_log a WHERE a.action IN ('review.submit','review.correction') AND a.entity_id = r.id AND a.undone_at IS NULL ORDER BY a.id DESC LIMIT 1) AS audit_id
     FROM reviews r JOIN units u ON u.id = r.unit_id WHERE r.local_date = ? ORDER BY r.reviewed_at DESC, r.id DESC LIMIT 1`,
    d,
  );

  return {
    date: d,
    now: now().toISOString(),
    clockOffsetDays: clockOffset(),
    settings: { budgetMinutes: settings.budgetMinutes, maxItems: settings.maxItems },
    spent,
    queue,
    deferred,
    corrections,
    totalDue: dueNow.length + blocked.length,
    estQueueSeconds: plan.estIncludedSeconds,
    blocked,
    tomorrow: {
      date: tomorrow,
      count: tomorrowItems.length,
      estSeconds: tomorrowIncluded.reduce((s, p) => s + p.candidate.estSeconds, 0),
      overflow: Math.max(0, tomorrowItems.length - tomorrowIncluded.length),
      items: tomorrowIncluded.map((p) => ({
        unitId: p.candidate.unitId,
        title: String(p.candidate.row.title),
        topicName: String(p.candidate.row.topic_name),
        reasons: p.reasons.map((r) => r.text),
      })),
    },
    lastReview: last
      ? {
          reviewId: Number(last.id),
          auditId: last.audit_id === null ? null : Number(last.audit_id),
          unitTitle: String(last.title),
          summary: Number(last.is_correction) === 1 ? 'שאלת תיקון' : (parseJson<{ summary: string } | null>(last.schedule_reason, null)?.summary ?? ''),
        }
      : null,
  };
}

export function submitReview(b: Record<string, unknown>): ReviewResultDTO {
  const settings = getSettings();
  const d = today();
  // The day's due list (and any never-opened days before it) must be logged before
  // the first answer moves due dates — e.g. a tab left open overnight.
  if (!get('SELECT 1 FROM day_log WHERE local_date = ?', d)) getToday();
  const unitId = Number(b.unitId);
  const unit = must(get<Row>(`${UNIT_BASE_SQL} WHERE u.id = ?`, unitId), 'היחידה');
  if (unit.status !== 'active') throw new UserError('היחידה אינה פעילה');
  if (!b.isCorrection && unit.due_date && String(unit.due_date) > d) {
    // Typically a second tab answering a card this tab already answered.
    throw new UserError('היחידה כבר נענתה היום ומועד החזרה הבא שלה עוד לא הגיע. רענן את הדף.');
  }
  const grade = String(b.grade) as Grade;
  if (!(GRADES as readonly string[]).includes(grade)) throw new UserError('דירוג לא מוכר');
  const errorType = b.errorType ? (String(b.errorType) as ErrorType) : null;
  if (errorType && !(ERROR_TYPES as readonly string[]).includes(errorType)) throw new UserError('סוג טעות לא מוכר');
  const questionId = b.questionId ? Number(b.questionId) : null;
  const question = questionId ? must(get<Row>('SELECT * FROM questions WHERE id = ?', questionId), 'השאלה') : null;
  if (question && Number(question.unit_id) !== unitId) throw new UserError('השאלה לא שייכת ליחידה');
  const isCorrection = Boolean(b.isCorrection);
  if (!isCorrection && question && question.status !== 'approved') throw new UserError('אפשר לחזור רק על שאלות מאושרות');
  const hintUsed = Boolean(b.hintUsed);
  const clampMs = (v: unknown) => (v === undefined || v === null ? null : Math.max(0, Math.min(MAX_REVIEW_MS, Math.round(Number(v)))));
  const missing = Array.isArray(b.missingPoints) ? b.missingPoints.map(String).slice(0, 20) : [];
  const state = stateOf(unit);
  const reviewedAt = now().toISOString();
  const gap = daysBetween(state.lastReviewedOn ?? String(unit.learned_on), d);

  const base = {
    unit_id: unitId,
    question_id: questionId,
    local_date: d,
    reviewed_at: reviewedAt,
    grade,
    hint_used: hintUsed ? 1 : 0,
    user_answer: typeof b.userAnswer === 'string' ? b.userAnswer.slice(0, 8000) : null,
    answer_ms: clampMs(b.answerMs),
    total_ms: clampMs(b.totalMs),
    error_type: errorType,
    confused_with: typeof b.confusedWith === 'string' && b.confusedWith.trim() ? b.confusedWith.trim().slice(0, 300) : null,
    missing_points: JSON.stringify(missing),
    note: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 4000) : null,
    gap_days: gap,
  };

  if (isCorrection) {
    const eff = effectiveGrade({ grade, hintUsed, errorType }).grade;
    const explanation = {
      summary: 'שאלת תיקון · לא משנה את התזמון',
      lines: [
        eff === 'wrong'
          ? 'גם בתיקון התשובה לא הייתה נכונה. כדאי לפתוח את המקור עכשיו; היחידה כבר מתוזמנת למחר.'
          : 'התיקון הצליח. היחידה עדיין תחזור במועד שנקבע, כדי לוודא שהזיכרון מחזיק גם אחרי לילה.',
      ],
    };
    const { result, auditId } = record({ action: 'review.correction', summary: `שאלת תיקון: ${String(unit.title)}`, entityType: 'review' }, (cs) => {
      const id = cs.insert('reviews', {
        ...base,
        effective_grade: eff,
        is_correction: 1,
        prev_step: state.step,
        new_step: state.step,
        prev_due: state.dueDate,
        new_due: state.dueDate,
        interval_days: null,
        appeared_because: JSON.stringify([{ code: 'failed_recently', text: 'נכשלה קודם בסשן הזה' }]),
        schedule_reason: JSON.stringify(explanation),
      });
      cs.entityId = id;
      return id;
    });
    return {
      reviewId: result,
      auditId,
      effectiveGrade: eff,
      dueDate: state.dueDate ?? d,
      intervalDays: state.dueDate ? daysBetween(d, state.dueDate) : 0,
      explanation,
      correctionQueued: false,
      remediation: state.remediation,
    };
  }

  const decision = schedule(state, { grade, hintUsed, errorType, date: d }, settings);
  const cand: Candidate = {
    unitId,
    dueDate: state.dueDate ?? d,
    learnedOn: String(unit.learned_on),
    lastReviewedOn: state.lastReviewedOn,
    lastGrade: state.lastGrade,
    remediation: state.remediation,
    importance: ((unit.importance as Importance | null) ?? (unit.topic_importance as Importance)) || 'normal',
    foundational: unit.foundational === null ? Number(unit.topic_foundational) === 1 : Number(unit.foundational) === 1,
    examDate: (unit.exam_date as string | null) ?? null,
    questionKind: (question?.kind as Candidate['questionKind']) ?? 'recall',
    estSeconds: 0,
  };
  const appeared = prioritize(cand, d, settings).reasons;
  const explanation = { summary: decision.summary, lines: decision.lines };

  const { result, auditId } = record({ action: 'review.submit', summary: `חזרה: ${String(unit.title)} — ${decision.summary}`, entityType: 'review' }, (cs) => {
    const id = cs.insert('reviews', {
      ...base,
      effective_grade: decision.effective,
      is_correction: 0,
      prev_step: state.step,
      new_step: decision.next.step,
      prev_due: state.dueDate,
      new_due: decision.dueDate,
      interval_days: decision.intervalDays,
      appeared_because: JSON.stringify(appeared),
      schedule_reason: JSON.stringify(explanation),
    });
    cs.entityId = id;
    cs.update('units', unitId, {
      step: decision.next.step,
      due_date: decision.next.dueDate,
      last_reviewed_on: decision.next.lastReviewedOn,
      last_grade: decision.next.lastGrade,
      last_question_id: questionId,
      reps: decision.next.reps,
      lapses: decision.next.lapses,
      clean_streak: decision.next.cleanStreak,
      remediation: decision.next.remediation ? 1 : 0,
      recent_grades: JSON.stringify(decision.next.recentGrades),
      schedule_reason: JSON.stringify(explanation),
    });
    if (errorType === 'unclear_question' && questionId) flagQuestion(questionId, 'סומנה כלא ברורה בזמן חזרה', cs);
    return id;
  });

  return {
    reviewId: result,
    auditId,
    effectiveGrade: decision.effective,
    dueDate: decision.dueDate,
    intervalDays: decision.intervalDays,
    explanation,
    correctionQueued: decision.effective === 'wrong',
    remediation: decision.next.remediation,
  };
}
