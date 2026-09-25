// Builds a day's session from the units that are due. Pure: the server hands
// in candidates, this decides order and what fits, and says why for each one.
// Nothing due is ever dropped — what doesn't fit is returned as `deferred`
// with the reason, and stays due tomorrow.

import { daysBetween } from './dates.ts';
import { formatDate, formatDays } from './labels.ts';
import type { EffectiveGrade, Importance, PriorityReason, QuestionKind, Settings } from './types.ts';

export interface Candidate {
  unitId: number;
  dueDate: string;
  learnedOn: string;
  lastReviewedOn: string | null;
  lastGrade: EffectiveGrade | null;
  remediation: boolean;
  importance: Importance;
  foundational: boolean;
  examDate: string | null;
  /** Kind of the question that would be asked next. */
  questionKind: QuestionKind;
  estSeconds: number;
}

export interface PlannedItem<C extends Candidate = Candidate> {
  candidate: C;
  rank: number;
  score: number;
  reasons: { code: PriorityReason; text: string }[];
  included: boolean;
  deferReason: string | null;
}

export interface DayPlan<C extends Candidate = Candidate> {
  date: string;
  items: PlannedItem<C>[];
  included: PlannedItem<C>[];
  deferred: PlannedItem<C>[];
  estIncludedSeconds: number;
  remainingSeconds: number;
  remainingSlots: number;
}

export type PlanConfig = Pick<Settings, 'budgetMinutes' | 'maxItems' | 'examWindowDays' | 'longGapDays'>;

const DEEP_KINDS: QuestionKind[] = ['application', 'integrative'];

export function prioritize<C extends Candidate>(c: C, today: string, cfg: PlanConfig) {
  const reasons: { code: PriorityReason; text: string }[] = [];
  const failed = c.lastGrade === 'wrong' || c.remediation;
  if (c.lastGrade === 'wrong') reasons.push({ code: 'failed_recently', text: 'נכשלה בפעם הקודמת' });
  if (c.remediation) reasons.push({ code: 'remediation', text: 'במצב תיקון אחרי כישלונות חוזרים' });

  const overdueDays = daysBetween(c.dueDate, today);
  const overdue = overdueDays > 0;
  if (overdue) reasons.push({ code: 'overdue', text: `באיחור של ${formatDays(overdueDays)}` });

  const daysToExam = c.examDate ? daysBetween(today, c.examDate) : null;
  const examSoon = daysToExam !== null && daysToExam >= 0 && daysToExam <= cfg.examWindowDays;
  if (examSoon) reasons.push({ code: 'exam_soon', text: `מבחן ב־${formatDate(c.examDate!)} (עוד ${formatDays(daysToExam!)})` });
  const core = c.importance === 'core';
  if (core) reasons.push({ code: 'core', text: 'חומר מרכזי' });
  const central = core || examSoon;

  if (c.foundational) reasons.push({ code: 'foundational', text: 'ידע בסיס שנושאים אחרים נשענים עליו' });

  const since = daysBetween(c.lastReviewedOn ?? c.learnedOn, today);
  const longGap = c.lastReviewedOn !== null && since >= cfg.longGapDays;
  if (longGap) reasons.push({ code: 'long_gap', text: `לא נבדקה ${formatDays(since)}` });

  if (c.lastReviewedOn === null) reasons.push({ code: 'new', text: 'חזרה ראשונה על חומר חדש' });
  else if (!overdue) reasons.push({ code: 'due_today', text: 'הגיע מועד החזרה' });

  const deep = DEEP_KINDS.includes(c.questionKind);
  if (deep) reasons.push({ code: 'application', text: 'שאלת יישום/אינטגרציה — נכנסת כשיש זמן' });

  // The plan's priority list, as a lexicographic key packed into one number:
  // failed > overdue > central/exam > foundational > long gap > not-application.
  const score =
    (failed ? 32 : 0) + (overdue ? 16 : 0) + (central ? 8 : 0) + (c.foundational ? 4 : 0) + (longGap ? 2 : 0) + (deep ? 0 : 1);
  return { score, reasons, overdueDays, since };
}

export function planDay<C extends Candidate>(
  candidates: C[],
  today: string,
  spent: { seconds: number; count: number },
  cfg: PlanConfig,
  opts: { ignoreBudget?: boolean } = {},
): DayPlan<C> {
  const scored = candidates
    .filter((c) => c.dueDate <= today)
    .map((c) => ({ c, ...prioritize(c, today, cfg) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.overdueDays - a.overdueDays ||
        b.since - a.since ||
        a.c.dueDate.localeCompare(b.c.dueDate) ||
        a.c.unitId - b.c.unitId,
    );

  const remainingSeconds = Math.max(0, cfg.budgetMinutes * 60 - spent.seconds);
  const remainingSlots = Math.max(0, cfg.maxItems - spent.count);

  let used = 0;
  let taken = 0;
  let closedBy: string | null = null;
  const items: PlannedItem<C>[] = scored.map((s, i) => {
    let included = false;
    let deferReason: string | null = null;
    if (opts.ignoreBudget) {
      included = true;
    } else if (closedBy) {
      deferReason = closedBy;
    } else if (taken >= remainingSlots) {
      closedBy = `הגעת למכסה היומית של ${cfg.maxItems} שאלות`;
      deferReason = closedBy;
    } else if (used + s.c.estSeconds > remainingSeconds && taken > 0) {
      closedBy = `לא נכנס בתקציב של ${cfg.budgetMinutes} דקות`;
      deferReason = closedBy;
    } else if (remainingSeconds === 0) {
      closedBy = `תקציב ${cfg.budgetMinutes} הדקות של היום נוצל`;
      deferReason = closedBy;
    } else {
      included = true;
    }
    if (included) {
      used += s.c.estSeconds;
      taken += 1;
    }
    return { candidate: s.c, rank: i + 1, score: s.score, reasons: s.reasons, included, deferReason };
  });

  return {
    date: today,
    items,
    included: items.filter((i) => i.included),
    deferred: items.filter((i) => !i.included),
    estIncludedSeconds: used,
    remainingSeconds,
    remainingSlots,
  };
}
