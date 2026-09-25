// The scheduling engine. Pure and deterministic: same state + same answer
// always gives the same date, and every decision carries its reasons in Hebrew.
// No AI ever touches this file's output.

import { addDays, daysBetween } from './dates.ts';
import { ERROR_LABELS, GRADE_LABELS, formatDays, formatIn, pre } from './labels.ts';
import type { Confidence, EffectiveGrade, ErrorType, Grade, Settings } from './types.ts';

export interface SchedState {
  /** Index into the interval ladder. -1 = never reviewed. */
  step: number;
  dueDate: string | null;
  lastReviewedOn: string | null;
  lastGrade: EffectiveGrade | null;
  reps: number;
  lapses: number;
  /** Consecutive full successes (correct/easy, no hint). */
  cleanStreak: number;
  remediation: boolean;
  /** Last few effective outcomes, oldest first. `void` never enters. */
  recentGrades: EffectiveGrade[];
}

export interface ReviewOutcome {
  grade: Grade;
  hintUsed: boolean;
  errorType?: ErrorType | null;
  /** Study date the review happened on. */
  date: string;
}

export interface Decision {
  next: SchedState;
  effective: EffectiveGrade;
  intervalDays: number;
  dueDate: string;
  /** One line for buttons and lists: "נכון · בעוד שבוע". */
  summary: string;
  /** The full reasoning, one sentence per rule that fired. */
  lines: string[];
}

export type SchedulerConfig = Pick<
  Settings,
  'ladder' | 'remediationCapDays' | 'remediationWindow' | 'remediationLapses' | 'remediationClearStreak'
>;

export function initialState(learnedOn: string): SchedState {
  return {
    step: -1,
    dueDate: learnedOn,
    lastReviewedOn: null,
    lastGrade: null,
    reps: 0,
    lapses: 0,
    cleanStreak: 0,
    remediation: false,
    recentGrades: [],
  };
}

/** Applies the hint and error-type rules to what the learner pressed. */
export function effectiveGrade(o: Pick<ReviewOutcome, 'grade' | 'hintUsed' | 'errorType'>): {
  grade: EffectiveGrade;
  notes: string[];
} {
  const notes: string[] = [];
  if (o.errorType === 'unclear_question') {
    notes.push('סימנת שהשאלה לא ברורה — זה לא נחשב כישלון. השאלה עוברת לבדיקה.');
    return { grade: 'void', notes };
  }
  let g: Grade = o.grade;
  if (o.errorType === 'alt_phrasing' && (g === 'wrong' || g === 'partial')) {
    notes.push(`${ERROR_LABELS.alt_phrasing} נחשב כתשובה נכונה.`);
    g = 'correct';
  }
  if (o.hintUsed && (g === 'correct' || g === 'easy')) {
    notes.push('נעזרת ברמז, ולכן זה לא נחשב הצלחה מלאה — התשובה נספרת כחלקית.');
    g = 'partial';
  }
  return { grade: g, notes };
}

function intervalAt(cfg: SchedulerConfig, step: number): number {
  const s = Math.max(0, Math.min(step, cfg.ladder.length - 1));
  return cfg.ladder[s];
}

/** Highest step whose interval does not exceed the remediation cap. */
function capStep(cfg: SchedulerConfig): number {
  let s = 0;
  for (let i = 0; i < cfg.ladder.length; i++) if (cfg.ladder[i] <= cfg.remediationCapDays) s = i;
  return s;
}

export function schedule(state: SchedState, outcome: ReviewOutcome, cfg: SchedulerConfig): Decision {
  const maxStep = cfg.ladder.length - 1;
  const { grade: eff, notes } = effectiveGrade(outcome);
  const lines = [...notes];
  const prevInterval = state.step >= 0 ? intervalAt(cfg, state.step) : null;

  if (state.dueDate && outcome.date > state.dueDate) {
    const late = daysBetween(state.dueDate, outcome.date);
    lines.push(`החזרה בוצעה באיחור של ${formatDays(late)} ממועדה.`);
  }

  let step = state.step;
  let interval: number;
  let cleanStreak = state.cleanStreak;
  let lapses = state.lapses;

  switch (eff) {
    case 'void':
      interval = 1;
      lines.push('היחידה תחזור מחר, ובינתיים השאלה ממתינה לתיקון במסך הבדיקה.');
      break;
    case 'wrong':
      lapses += 1;
      cleanStreak = 0;
      step = Math.max(0, state.step - 2);
      interval = 1;
      lines.push('תשובה שגויה → חוזרים מחר כדי לבדוק מה לא הובן.');
      if (prevInterval !== null && intervalAt(cfg, step) < prevInterval) {
        lines.push(
          `רמת המרווח יורדת ${pre('מ', formatDays(prevInterval))} ${pre('ל', formatDays(intervalAt(cfg, step)))}, ` +
            'והיא תגדל שוב רק אחרי הצלחות.',
        );
      }
      break;
    case 'partial':
      cleanStreak = 0;
      step = Math.max(0, state.step);
      interval = intervalAt(cfg, step);
      lines.push(
        prevInterval === null
          ? `תשובה חלקית בחזרה הראשונה → חוזרים ${formatIn(interval)}.`
          : `תשובה חלקית → המרווח לא מתארך ונשאר ${formatDays(interval)}.`,
      );
      break;
    case 'correct':
      cleanStreak += 1;
      step = Math.min(maxStep, state.step + 1);
      interval = intervalAt(cfg, step);
      if (prevInterval === null) lines.push(`תשובה נכונה בחזרה הראשונה → החזרה הבאה ${formatIn(interval)}.`);
      else if (step === state.step) lines.push(`תשובה נכונה. המרווח כבר הארוך ביותר (${formatDays(interval)}) ונשאר בו.`);
      else lines.push(`תשובה נכונה בלי רמז → המרווח מתארך ${pre('מ', formatDays(prevInterval))} ${pre('ל', formatDays(interval))}.`);
      break;
    case 'easy':
      cleanStreak += 1;
      step = Math.min(maxStep, state.step + 2);
      interval = intervalAt(cfg, step);
      if (prevInterval === null) lines.push(`קל מאוד כבר בחזרה הראשונה → מדלגים שלב, החזרה הבאה ${formatIn(interval)}.`);
      else if (step === state.step) lines.push(`קל מאוד. המרווח כבר הארוך ביותר (${formatDays(interval)}) ונשאר בו.`);
      else lines.push(`קל מאוד → המרווח קופץ שני שלבים, ${pre('מ', formatDays(prevInterval))} ${pre('ל', formatDays(interval))}.`);
      break;
  }

  const recentGrades =
    eff === 'void' ? state.recentGrades : [...state.recentGrades, eff].slice(-cfg.remediationWindow);

  let remediation = state.remediation;
  const wrongInWindow = recentGrades.filter((g) => g === 'wrong').length;
  if (!remediation && eff === 'wrong' && wrongInWindow >= cfg.remediationLapses) {
    remediation = true;
    lines.push(
      `היחידה נכשלה ${wrongInWindow} פעמים ב־${recentGrades.length} הניסיונות האחרונים → מצב תיקון: ` +
        `המרווח מוגבל ${pre('ל', formatDays(cfg.remediationCapDays))} עד ${cfg.remediationClearStreak} הצלחות רצופות בלי רמז. ` +
        'כדאי לחזור לחומר המקור לפני החזרה הבאה.',
    );
  } else if (remediation && cleanStreak >= cfg.remediationClearStreak) {
    remediation = false;
    lines.push(`${cleanStreak} הצלחות רצופות בלי רמז → יוצאים ממצב תיקון, והמרווח חוזר לגדול כרגיל.`);
  }

  if (remediation && eff !== 'wrong' && eff !== 'void') {
    const cs = capStep(cfg);
    if (step > cs) {
      const uncapped = intervalAt(cfg, step);
      step = cs;
      interval = intervalAt(cfg, step);
      lines.push(`מצב תיקון: המרווח מוגבל ${pre('ל', formatDays(interval))} במקום ${formatDays(uncapped)}.`);
    }
  }

  const dueDate = addDays(outcome.date, interval);
  const next: SchedState = {
    step,
    dueDate,
    lastReviewedOn: outcome.date,
    lastGrade: eff,
    reps: state.reps + 1,
    lapses,
    cleanStreak,
    remediation,
    recentGrades,
  };
  const label = eff === 'void' ? 'לא נספר' : GRADE_LABELS[eff];
  return { next, effective: eff, intervalDays: interval, dueDate, summary: `${label} · ${formatIn(interval)}`, lines };
}

/** What each button would do, for "נכון · שבוע" labels before the learner commits. */
export function previewGrades(
  state: SchedState,
  date: string,
  hintUsed: boolean,
  cfg: SchedulerConfig,
): Record<Grade, number> {
  const out = {} as Record<Grade, number>;
  for (const g of ['wrong', 'partial', 'correct', 'easy'] as const) {
    out[g] = schedule(state, { grade: g, hintUsed, date }, cfg).intervalDays;
  }
  return out;
}

export function confidence(s: Pick<SchedState, 'reps' | 'remediation' | 'lastGrade' | 'cleanStreak' | 'step'>): Confidence {
  if (s.reps === 0) return 'new';
  if (s.remediation || s.lastGrade === 'wrong') return 'low';
  if (s.cleanStreak >= 2 && s.step >= 3) return 'high';
  return 'medium';
}
