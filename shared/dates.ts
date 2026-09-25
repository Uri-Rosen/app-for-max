// Calendar-day arithmetic on 'YYYY-MM-DD' strings.
// Scheduling works in whole local days; times of day never enter the maths.

const DAY_MS = 86_400_000;

function toUtcMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fromUtcMs(toUtcMs(s)) === s;
}

export function addDays(date: string, days: number): string {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** b − a in whole days. */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/**
 * The study day a moment belongs to. A session at 01:30 with dayStartHour=4
 * still counts as the previous day, so a late night doesn't eat tomorrow.
 */
export function studyDate(now: Date, dayStartHour: number): string {
  const shifted = new Date(now.getTime() - dayStartHour * 3_600_000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function minDate(a: string, b: string): string {
  return a <= b ? a : b;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

export function monthGrid(year: number, month1: number): string[] {
  // Weeks start on Sunday, as in the Israeli calendar.
  const first = fromUtcMs(Date.UTC(year, month1 - 1, 1));
  const start = addDays(first, -weekday(first));
  const cells: string[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(start, i));
  return cells;
}
