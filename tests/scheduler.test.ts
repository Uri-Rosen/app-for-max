import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, studyDate } from '../shared/dates.ts';
import { planDay, type Candidate } from '../shared/planner.ts';
import { pickQuestion } from '../shared/questionPick.ts';
import { confidence, effectiveGrade, initialState, previewGrades, schedule, type SchedState } from '../shared/scheduler.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';

const cfg = DEFAULT_SETTINGS;
const D0 = '2026-10-01';

function run(grades: { g: 'wrong' | 'partial' | 'correct' | 'easy'; hint?: boolean; err?: 'unclear_question' | 'alt_phrasing' }[], start = D0) {
  let s: SchedState = initialState(start);
  let date = start;
  const out: { interval: number; due: string; step: number; remediation: boolean; lines: string[] }[] = [];
  for (const x of grades) {
    const d = schedule(s, { grade: x.g, hintUsed: x.hint ?? false, errorType: x.err ?? null, date }, cfg);
    out.push({ interval: d.intervalDays, due: d.dueDate, step: d.next.step, remediation: d.next.remediation, lines: d.lines });
    s = d.next;
    date = d.dueDate;
  }
  return { out, state: s };
}

describe('dates', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
  });
  it('late-night study counts toward the previous day', () => {
    expect(studyDate(new Date(2026, 9, 2, 1, 30), 4)).toBe('2026-10-01');
    expect(studyDate(new Date(2026, 9, 2, 4, 0), 4)).toBe('2026-10-02');
  });
});

describe('scheduler — the ladder', () => {
  it('new unit is first due on the learning day', () => {
    expect(initialState(D0).dueDate).toBe(D0);
  });

  it('climbs 1 → 3 → 7 → 14 → 30 → 60 → 120 days on steady correct answers, then stays', () => {
    const { out } = run(Array(9).fill({ g: 'correct' }));
    expect(out.map((o) => o.interval)).toEqual([1, 3, 7, 14, 30, 60, 120, 120, 120]);
  });

  it('easy skips a step', () => {
    const { out } = run([{ g: 'easy' }, { g: 'easy' }, { g: 'easy' }]);
    expect(out.map((o) => o.interval)).toEqual([3, 14, 60]);
  });

  it('partial holds the interval where it was', () => {
    const { out } = run([{ g: 'correct' }, { g: 'correct' }, { g: 'correct' }, { g: 'partial' }]);
    expect(out.map((o) => o.interval)).toEqual([1, 3, 7, 7]);
  });

  it('wrong brings the unit back tomorrow and drops two levels', () => {
    const { out } = run([{ g: 'correct' }, { g: 'correct' }, { g: 'correct' }, { g: 'correct' }, { g: 'correct' }, { g: 'wrong' }, { g: 'correct' }]);
    // 1,3,7,14,30 then wrong → tomorrow at step 2 (7d level) → next correct climbs to 14.
    expect(out.map((o) => o.interval)).toEqual([1, 3, 7, 14, 30, 1, 14]);
    expect(out[5].lines.join(' ')).toContain('חוזרים מחר');
  });

  it('a hint caps credit at partial', () => {
    const withHint = run([{ g: 'correct' }, { g: 'correct' }, { g: 'correct', hint: true }]);
    const clean = run([{ g: 'correct' }, { g: 'correct' }, { g: 'correct' }]);
    expect(withHint.out[2].interval).toBe(3);
    expect(clean.out[2].interval).toBe(7);
    expect(withHint.out[2].lines.join(' ')).toContain('רמז');
    expect(effectiveGrade({ grade: 'easy', hintUsed: true }).grade).toBe('partial');
  });

  it('alternative correct phrasing counts as correct', () => {
    expect(effectiveGrade({ grade: 'wrong', hintUsed: false, errorType: 'alt_phrasing' }).grade).toBe('correct');
  });

  it('an unclear question does not count against the unit', () => {
    const { out, state } = run([{ g: 'correct' }, { g: 'correct' }, { g: 'wrong', err: 'unclear_question' }]);
    expect(out[2].interval).toBe(1);
    expect(state.step).toBe(1);
    expect(state.lapses).toBe(0);
    expect(state.recentGrades).not.toContain('void');
  });

  it('repeated failure enters remediation and caps growth until two clean successes', () => {
    const { out } = run([
      { g: 'correct' },
      { g: 'correct' },
      { g: 'correct' },
      { g: 'wrong' },
      { g: 'correct' },
      { g: 'wrong' }, // 2 wrong in last 4 → remediation
      { g: 'easy' }, // would jump, capped at 7
      { g: 'easy' }, // second clean success → leaves remediation, growth resumes
      { g: 'correct' },
    ]);
    expect(out[5].remediation).toBe(true);
    expect(out[5].lines.join(' ')).toContain('מצב תיקון');
    expect(out[6].interval).toBeLessThanOrEqual(cfg.remediationCapDays);
    expect(out[7].remediation).toBe(false);
    expect(out[8].interval).toBeGreaterThan(cfg.remediationCapDays);
  });

  it('notes a late review in the explanation', () => {
    const s = initialState(D0);
    const d = schedule(s, { grade: 'correct', hintUsed: false, date: addDays(D0, 4) }, cfg);
    expect(d.lines[0]).toContain('באיחור');
    expect(d.dueDate).toBe(addDays(D0, 5));
  });

  it('is deterministic', () => {
    const a = run([{ g: 'correct' }, { g: 'wrong' }, { g: 'partial', hint: true }, { g: 'easy' }]);
    const b = run([{ g: 'correct' }, { g: 'wrong' }, { g: 'partial', hint: true }, { g: 'easy' }]);
    expect(a).toEqual(b);
  });

  it('previews every button without committing', () => {
    const p = previewGrades(initialState(D0), D0, false, cfg);
    expect(p).toEqual({ wrong: 1, partial: 1, correct: 1, easy: 3 });
    const ph = previewGrades(initialState(D0), D0, true, cfg);
    expect(ph.correct).toBe(1);
    expect(ph.easy).toBe(1);
  });

  it('derives confidence from history', () => {
    expect(confidence(initialState(D0))).toBe('new');
    expect(confidence(run([{ g: 'correct' }, { g: 'wrong' }]).state)).toBe('low');
    expect(confidence(run([{ g: 'correct' }, { g: 'correct' }, { g: 'correct' }, { g: 'correct' }]).state)).toBe('high');
  });
});

function cand(id: number, over: Partial<Candidate> = {}): Candidate {
  return {
    unitId: id,
    dueDate: D0,
    learnedOn: '2026-09-01',
    lastReviewedOn: '2026-09-20',
    lastGrade: 'correct',
    remediation: false,
    importance: 'normal',
    foundational: false,
    examDate: null,
    questionKind: 'definition',
    estSeconds: 60,
    ...over,
  };
}

describe('planner — priority order', () => {
  it('orders failed > overdue > central > foundational > long gap > application', () => {
    const cs = [
      cand(1, { questionKind: 'application' }),
      cand(2, { lastReviewedOn: '2026-08-01' }),
      cand(3, { foundational: true }),
      cand(4, { importance: 'core' }),
      cand(5, { dueDate: '2026-09-28' }),
      cand(6, { lastGrade: 'wrong' }),
    ];
    const p = planDay(cs, D0, { seconds: 0, count: 0 }, cfg);
    expect(p.items.map((i) => i.candidate.unitId)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(p.items[1].reasons.map((r) => r.code)).toContain('overdue');
  });

  it('an exam within the window counts as central', () => {
    const p = planDay([cand(1), cand(2, { examDate: '2026-10-08' })], D0, { seconds: 0, count: 0 }, cfg);
    expect(p.items[0].candidate.unitId).toBe(2);
    expect(p.items[0].reasons.some((r) => r.code === 'exam_soon')).toBe(true);
  });

  it('fits the time budget and defers the rest with a reason — nothing disappears', () => {
    const cs = Array.from({ length: 30 }, (_, i) => cand(i + 1, { estSeconds: 90 }));
    const p = planDay(cs, D0, { seconds: 0, count: 0 }, cfg);
    expect(p.included.length).toBe(10); // 15 min / 90 s
    expect(p.deferred.length).toBe(20);
    expect(p.included.length + p.deferred.length).toBe(30);
    expect(p.deferred.every((d) => d.deferReason)).toBe(true);
  });

  it('respects the item cap and already-spent time', () => {
    const cs = Array.from({ length: 30 }, (_, i) => cand(i + 1, { estSeconds: 10 }));
    expect(planDay(cs, D0, { seconds: 0, count: 0 }, cfg).included.length).toBe(12);
    expect(planDay(cs, D0, { seconds: 0, count: 10 }, cfg).included.length).toBe(2);
    expect(planDay(cs, D0, { seconds: 15 * 60, count: 0 }, cfg).included.length).toBe(0);
  });

  it('ignores items not yet due', () => {
    const p = planDay([cand(1), cand(2, { dueDate: '2026-10-02' })], D0, { seconds: 0, count: 0 }, cfg);
    expect(p.items.map((i) => i.candidate.unitId)).toEqual([1]);
  });

  it('can be told to ignore the budget', () => {
    const cs = Array.from({ length: 30 }, (_, i) => cand(i + 1));
    expect(planDay(cs, D0, { seconds: 0, count: 0 }, cfg, { ignoreBudget: true }).included.length).toBe(30);
  });
});

describe('question selection', () => {
  const qs = [
    { id: 1, kind: 'definition' as const, lastAskedOn: '2026-09-01' },
    { id: 2, kind: 'cloze' as const, lastAskedOn: '2026-09-10' },
    { id: 3, kind: 'causal' as const, lastAskedOn: null },
    { id: 4, kind: 'application' as const, lastAskedOn: null },
  ];
  it('re-asks the question that failed', () => {
    expect(pickQuestion(qs, { step: 3, lastGrade: 'wrong', lastQuestionId: 2 })!.question.id).toBe(2);
  });
  it('keeps new units on basic kinds', () => {
    expect(pickQuestion(qs, { step: -1, lastGrade: null, lastQuestionId: null })!.question.id).toBe(1);
  });
  it('unlocks deeper kinds as the interval grows, fresh ones first', () => {
    expect(pickQuestion(qs, { step: 1, lastGrade: 'correct', lastQuestionId: 1 })!.question.id).toBe(3);
    expect(pickQuestion(qs, { step: 4, lastGrade: 'correct', lastQuestionId: 1 })!.question.id).toBe(4);
  });
  it('explains every choice', () => {
    expect(pickQuestion(qs, { step: 0, lastGrade: 'correct', lastQuestionId: 1 })!.why).toMatch(/שאלה/);
    expect(pickQuestion([], { step: 0, lastGrade: null, lastQuestionId: null })).toBeNull();
  });
});
