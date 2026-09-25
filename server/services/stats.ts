// Calendar and progress figures. Everything is computed from reviews and the
// day log — nothing here is stored, so it can never drift from the history.

import { all, get, parseJson, type Row } from '../db/index.ts';
import { addDays, daysBetween } from '../../shared/dates.ts';
import type { EffectiveGrade, ErrorType, Provenance } from '../../shared/types.ts';
import { getSettings, today } from './settings.ts';

const SUCCESS = "effective_grade IN ('correct','easy')";
const COUNTED = "is_correction = 0 AND effective_grade != 'void'";

export interface CalendarDay {
  date: string;
  kind: 'past' | 'today' | 'future';
  scheduled: number;
  done: number;
  dueAtStart: number;
  deferred: number;
  overdue: number;
}

function dayLogFor(from: string, to: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const r of all<Row>('SELECT * FROM day_log WHERE local_date BETWEEN ? AND ?', from, to)) {
    out.set(String(r.local_date), parseJson<number[]>(r.due_unit_ids, []));
  }
  return out;
}

function reviewedUnitsOn(from: string, to: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const r of all<Row>('SELECT local_date, unit_id FROM reviews WHERE is_correction = 0 AND local_date BETWEEN ? AND ?', from, to)) {
    const set = out.get(String(r.local_date)) ?? new Set<number>();
    set.add(Number(r.unit_id));
    out.set(String(r.local_date), set);
  }
  return out;
}

// Same definition as the day's due list: every active due unit counts, including
// ones that can't be asked yet (they show on Today as "לא ניתן לשאול").
const SCHEDULABLE = `u.status = 'active' AND c.archived = 0`;

export function calendar(from: string, to: string): CalendarDay[] {
  const d = today();
  const logs = dayLogFor(from, to);
  const reviewed = reviewedUnitsOn(from, to);
  const scheduled = new Map<string, number>();
  for (const r of all<Row>(
    `SELECT u.due_date AS due, COUNT(*) AS n FROM units u JOIN topics t ON t.id = u.topic_id JOIN courses c ON c.id = t.course_id
     WHERE ${SCHEDULABLE} AND u.due_date IS NOT NULL GROUP BY u.due_date`,
  )) {
    scheduled.set(String(r.due), Number(r.n));
  }
  let overdueNow = 0;
  for (const [date, n] of scheduled) if (date < d) overdueNow += n;

  const days: CalendarDay[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const kind = date < d ? 'past' : date === d ? 'today' : 'future';
    const due = logs.get(date) ?? [];
    const done = reviewed.get(date) ?? new Set<number>();
    const deferred = kind === 'past' ? due.filter((id) => !done.has(id)).length : 0;
    days.push({
      date,
      kind,
      scheduled: kind === 'future' ? (scheduled.get(date) ?? 0) : kind === 'today' ? (scheduled.get(date) ?? 0) + overdueNow : 0,
      done: done.size,
      dueAtStart: due.length,
      deferred,
      overdue: kind === 'today' ? overdueNow : 0,
    });
  }
  return days;
}

export function calendarDay(date: string): {
  date: string;
  scheduled: { unitId: number; title: string; topicName: string; courseName: string; dueDate: string }[];
  reviewed: { unitId: number; title: string; effectiveGrade: EffectiveGrade; hintUsed: boolean; nextDue: string | null }[];
  deferred: { unitId: number; title: string; nowDue: string | null }[];
} {
  const d = today();
  const scheduled = all<Row>(
    `SELECT u.id, u.title, u.due_date, t.name AS topic_name, c.name AS course_name
     FROM units u JOIN topics t ON t.id = u.topic_id JOIN courses c ON c.id = t.course_id
     WHERE ${SCHEDULABLE} AND ${date === d ? 'u.due_date <= ?' : 'u.due_date = ?'} ORDER BY u.due_date, u.id`,
    date,
  ).map((r) => ({
    unitId: Number(r.id),
    title: String(r.title),
    topicName: String(r.topic_name),
    courseName: String(r.course_name),
    dueDate: String(r.due_date),
  }));
  const reviewed = all<Row>(
    `SELECT r.unit_id, u.title, r.effective_grade, r.hint_used, r.new_due FROM reviews r JOIN units u ON u.id = r.unit_id
     WHERE r.local_date = ? AND r.is_correction = 0 ORDER BY r.reviewed_at`,
    date,
  ).map((r) => ({
    unitId: Number(r.unit_id),
    title: String(r.title),
    effectiveGrade: r.effective_grade as EffectiveGrade,
    hintUsed: Number(r.hint_used) === 1,
    nextDue: (r.new_due as string | null) ?? null,
  }));
  const log = get<Row>('SELECT due_unit_ids FROM day_log WHERE local_date = ?', date);
  const doneIds = new Set(reviewed.map((r) => r.unitId));
  const deferredIds = date < d ? parseJson<number[]>(log?.due_unit_ids, []).filter((id) => !doneIds.has(id)) : [];
  const deferred = deferredIds.length
    ? all<Row>('SELECT id, title, due_date FROM units WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(deferredIds)).map((r) => ({
        unitId: Number(r.id),
        title: String(r.title),
        nowDue: (r.due_date as string | null) ?? null,
      }))
    : [];
  return { date, scheduled: date >= d ? scheduled : [], reviewed, deferred };
}

function rate(success: number, total: number): number | null {
  return total > 0 ? success / total : null;
}

export function progress() {
  const d = today();
  const settings = getSettings();
  const from30 = addDays(d, -29);

  const buckets = [
    { label: 'עד יומיים', min: 0, max: 2 },
    { label: '3–6 ימים', min: 3, max: 6 },
    { label: 'שבוע–שבועיים', min: 7, max: 13 },
    { label: 'שבועיים–חודש', min: 14, max: 29 },
    { label: 'חודש ומעלה', min: 30, max: 100000 },
  ].map((b) => {
    const r = get<{ n: number; s: number }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN ${SUCCESS} THEN 1 ELSE 0 END) AS s FROM reviews
       WHERE ${COUNTED} AND gap_days BETWEEN ? AND ?`,
      b.min,
      b.max,
    )!;
    return { ...b, total: Number(r.n), success: Number(r.s ?? 0), rate: rate(Number(r.s ?? 0), Number(r.n)) };
  });

  const afterGap = (min: number) => {
    const r = get<{ n: number; s: number }>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN ${SUCCESS} THEN 1 ELSE 0 END) AS s FROM reviews WHERE ${COUNTED} AND gap_days >= ?`,
      min,
    )!;
    return { total: Number(r.n), success: Number(r.s ?? 0), rate: rate(Number(r.s ?? 0), Number(r.n)) };
  };

  // Completion: of the units that were due on each past day, how many were done that day.
  const logs = dayLogFor(from30, addDays(d, -1));
  const reviewed = reviewedUnitsOn(from30, d);
  let dueSum = 0;
  let doneSum = 0;
  const daily: { date: string; minutes: number; reviews: number; due: number; deferred: number; success: number }[] = [];
  const perDay = new Map<string, Row>();
  for (const r of all<Row>(
    `SELECT local_date, SUM(MIN(COALESCE(total_ms,0), 600000)) / 60000.0 AS minutes,
            SUM(CASE WHEN is_correction = 0 THEN 1 ELSE 0 END) AS n,
            SUM(CASE WHEN ${COUNTED} AND ${SUCCESS} THEN 1 ELSE 0 END) AS s
     FROM reviews WHERE local_date BETWEEN ? AND ? GROUP BY local_date`,
    from30,
    d,
  )) {
    perDay.set(String(r.local_date), r);
  }
  for (let date = from30; date <= d; date = addDays(date, 1)) {
    const due = logs.get(date) ?? [];
    const done = reviewed.get(date) ?? new Set<number>();
    const doneOfDue = due.filter((id) => done.has(id)).length;
    if (date < d) {
      dueSum += due.length;
      doneSum += doneOfDue;
    }
    const pd = perDay.get(date);
    daily.push({
      date,
      minutes: pd ? Math.round(Number(pd.minutes) * 10) / 10 : 0,
      reviews: pd ? Number(pd.n) : 0,
      due: due.length,
      deferred: date < d ? due.length - doneOfDue : 0,
      success: pd ? Number(pd.s) : 0,
    });
  }

  // Weekly trend: overall success, and success after gaps of a week or more — the number that matters.
  const weeks: { weekStart: string; total: number; rate: number | null; longTotal: number; longRate: number | null }[] = [];
  for (let i = 11; i >= 0; i--) {
    const start = addDays(d, -7 * i - 6);
    const end = addDays(d, -7 * i);
    const r = get<Row>(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN ${SUCCESS} THEN 1 ELSE 0 END) AS s,
              SUM(CASE WHEN gap_days >= 7 THEN 1 ELSE 0 END) AS ln,
              SUM(CASE WHEN gap_days >= 7 AND ${SUCCESS} THEN 1 ELSE 0 END) AS ls
       FROM reviews WHERE ${COUNTED} AND local_date BETWEEN ? AND ?`,
      start,
      end,
    )!;
    weeks.push({
      weekStart: start,
      total: Number(r.n),
      rate: rate(Number(r.s ?? 0), Number(r.n)),
      longTotal: Number(r.ln ?? 0),
      longRate: rate(Number(r.ls ?? 0), Number(r.ln ?? 0)),
    });
  }

  const hint = get<{ n: number; h: number }>(`SELECT COUNT(*) AS n, SUM(hint_used) AS h FROM reviews WHERE ${COUNTED}`)!;

  const errors = all<Row>(
    `SELECT error_type, COUNT(*) AS n FROM reviews WHERE error_type IS NOT NULL AND local_date >= ? GROUP BY error_type ORDER BY n DESC`,
    addDays(d, -90),
  ).map((r) => ({ errorType: r.error_type as ErrorType, count: Number(r.n) }));

  const troubled = all<Row>(
    `SELECT u.id, u.title, u.lapses, u.remediation, u.due_date, t.name AS topic_name,
       (SELECT GROUP_CONCAT(DISTINCT r.confused_with) FROM reviews r WHERE r.unit_id = u.id AND r.confused_with IS NOT NULL) AS confused,
       (SELECT GROUP_CONCAT(r.error_type) FROM reviews r WHERE r.unit_id = u.id AND r.error_type IS NOT NULL) AS errs
     FROM units u JOIN topics t ON t.id = u.topic_id
     WHERE u.status = 'active' AND (u.lapses >= 2 OR u.remediation = 1)
     ORDER BY u.remediation DESC, u.lapses DESC LIMIT 30`,
  ).map((r) => {
    const errs = String(r.errs ?? '').split(',').filter(Boolean) as ErrorType[];
    const counts: Partial<Record<ErrorType, number>> = {};
    for (const e of errs) counts[e] = (counts[e] ?? 0) + 1;
    return {
      unitId: Number(r.id),
      title: String(r.title),
      topicName: String(r.topic_name),
      lapses: Number(r.lapses),
      remediation: Number(r.remediation) === 1,
      dueDate: (r.due_date as string | null) ?? null,
      confusedWith: String(r.confused ?? '').split(',').filter(Boolean),
      errorCounts: counts,
    };
  });

  const provenance = all<Row>(
    "SELECT provenance, COUNT(*) AS n FROM questions WHERE status = 'approved' GROUP BY provenance",
  ).map((r) => ({ provenance: r.provenance as Provenance, count: Number(r.n) }));
  const quality = {
    provenance,
    pending: get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE status IN ('pending','draft')")!.n,
    flagged: get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE status = 'flagged'")!.n,
    openConflicts: get<{ n: number }>("SELECT COUNT(*) AS n FROM source_links WHERE role = 'contradicts' AND resolved = 0")!.n,
    unitsWithoutSource: get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM units u WHERE u.status = 'active' AND NOT EXISTS (
         SELECT 1 FROM source_links l WHERE l.role = 'supports' AND (
           (l.entity_type = 'unit' AND l.entity_id = u.id) OR
           (l.entity_type = 'question' AND l.entity_id IN (SELECT id FROM questions WHERE unit_id = u.id))))`,
    )!.n,
    aiApproved: get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE status = 'approved' AND created_by = 'ai'")!.n,
    aiRejected: get<{ n: number }>("SELECT COUNT(*) AS n FROM questions WHERE status = 'rejected' AND created_by = 'ai'")!.n,
  };

  const totals = get<Row>(
    `SELECT (SELECT COUNT(*) FROM units WHERE status = 'active') AS units,
            (SELECT COUNT(*) FROM reviews WHERE is_correction = 0) AS reviews,
            (SELECT COUNT(DISTINCT local_date) FROM reviews) AS days,
            (SELECT MIN(local_date) FROM reviews) AS first_day`,
  )!;

  // Streak: consecutive study days ending today or yesterday.
  const days = new Set(all<Row>('SELECT DISTINCT local_date FROM reviews').map((r) => String(r.local_date)));
  let streak = 0;
  for (let cur = days.has(d) ? d : addDays(d, -1); days.has(cur); cur = addDays(cur, -1)) streak++;

  const minutes30 = daily.reduce((s, x) => s + x.minutes, 0);
  const activeDays30 = daily.filter((x) => x.reviews > 0).length;

  return {
    date: d,
    budgetMinutes: settings.budgetMinutes,
    totals: {
      units: Number(totals.units),
      reviews: Number(totals.reviews),
      studyDays: Number(totals.days),
      firstDay: (totals.first_day as string | null) ?? null,
      daysSinceStart: totals.first_day ? daysBetween(String(totals.first_day), d) + 1 : 0,
      streak,
    },
    completion: { due: dueSum, done: doneSum, rate: rate(doneSum, dueSum) },
    retentionWeek: afterGap(7),
    retentionMonth: afterGap(30),
    buckets,
    weeks,
    daily,
    minutesPerActiveDay: activeDays30 ? Math.round((minutes30 / activeDays30) * 10) / 10 : 0,
    deferred30: daily.reduce((s, x) => s + x.deferred, 0),
    hintRate: rate(Number(hint.h ?? 0), Number(hint.n)),
    errors,
    troubled,
    quality,
  };
}

export type ProgressDTO = ReturnType<typeof progress>;
export type CalendarDayDTO = ReturnType<typeof calendarDay>;
