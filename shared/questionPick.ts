// Which of a unit's approved questions to ask next, and why.
// Basic kinds first; deeper kinds unlock as the unit's interval grows.

import type { EffectiveGrade, QuestionKind } from './types.ts';

/** The unit step at which a kind becomes eligible. */
export const KIND_MIN_STEP: Record<QuestionKind, number> = {
  definition: -1,
  recall: -1,
  cloze: -1,
  causal: 1,
  comparison: 1,
  interpretation: 2,
  exam: 2,
  application: 3,
  integrative: 3,
};

export interface PickableQuestion {
  id: number;
  kind: QuestionKind;
  lastAskedOn: string | null;
}

export interface PickContext {
  step: number;
  lastGrade: EffectiveGrade | null;
  lastQuestionId: number | null;
}

export function pickQuestion<Q extends PickableQuestion>(
  questions: Q[],
  ctx: PickContext,
): { question: Q; why: string } | null {
  if (questions.length === 0) return null;

  if ((ctx.lastGrade === 'wrong' || ctx.lastGrade === 'partial') && ctx.lastQuestionId !== null) {
    const again = questions.find((q) => q.id === ctx.lastQuestionId);
    if (again) return { question: again, why: 'אותה שאלה שלא הצליחה בפעם הקודמת — לבדוק שהפער נסגר' };
  }

  const eligible = questions.filter((q) => KIND_MIN_STEP[q.kind] <= ctx.step);
  const pool = eligible.length > 0 ? eligible : questions;
  const poolNote = eligible.length > 0 ? '' : ' (אין עדיין שאלה בסיסית ליחידה, לכן נבחרה שאלה מתקדמת)';

  const fresh = pool.filter((q) => q.lastAskedOn === null);
  if (fresh.length > 0) {
    // Deepest kind the unit has earned, so progress shows up as harder questions.
    const best = [...fresh].sort((a, b) => KIND_MIN_STEP[b.kind] - KIND_MIN_STEP[a.kind] || a.id - b.id)[0];
    return { question: best, why: `שאלה שעוד לא נשאלה, ברמה שמתאימה לשלב של היחידה${poolNote}` };
  }

  const oldest = [...pool].sort(
    (a, b) => (a.lastAskedOn ?? '').localeCompare(b.lastAskedOn ?? '') || a.id - b.id,
  )[0];
  return { question: oldest, why: `השאלה שלא נשאלה הכי הרבה זמן מבין השאלות של היחידה${poolNote}` };
}
