// The app's clock. A test offset (Settings › מצב בדיקה, or MEMORY_CLOCK_OFFSET_DAYS)
// shifts study dates and record timestamps together, so a rehearsed day looks
// like a real one everywhere. Never persisted.

let offsetDays = Number(process.env.MEMORY_CLOCK_OFFSET_DAYS ?? 0);

export function setClockOffsetDays(days: number): void {
  offsetDays = days;
}

export function clockOffset(): number {
  return offsetDays;
}

export function now(): Date {
  return new Date(Date.now() + offsetDays * 86_400_000);
}
