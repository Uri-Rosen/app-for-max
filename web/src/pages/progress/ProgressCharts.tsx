// The four charts on the progress page. Forms:
//  - success by gap bucket: columns, emphasis on the ≥ week buckets (the main metric)
//  - weekly trend: two lines, ≥ week gap emphasised against all reviews; empty weeks break the line
//  - daily minutes: columns with the budget as a reference line
//  - due vs done / deferred: stacked columns (done of due + deferred = due)

import type { ProgressDTO } from '../../../../shared/api.ts';
import { formatDate } from '../../../../shared/labels.ts';
import { pct } from '../../ui.tsx';
import { COLORS, ChartCard, Legend, Plot, XLabels, YGrid, columnPath, labelEvery, niceTicks, shortDate, type Frame, type Tip } from './charts.tsx';

const PCT_TICKS = [0, 0.5, 1];
const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const barWidth = (f: Frame) => Math.min(24, Math.max(3, f.slot * 0.6));
/** Fewer than this many reviews in a bucket: drawn faint, called out as thin data. */
const THIN = 5;

// ---------- success by gap bucket ----------

export function GapBucketsChart({ buckets }: { buckets: ProgressDTO['buckets'] }) {
  const n = buckets.length;
  const isLong = (b: ProgressDTO['buckets'][number]) => b.min >= 7;
  const tip = (i: number): Tip => {
    const b = buckets[i];
    return {
      title: `מרווח של ${b.label}`,
      rows: [
        { value: b.rate === null ? 'אין חזרות' : pct(b.rate), label: 'הצליחו', color: isLong(b) ? COLORS.key : COLORS.context, kind: 'rect' },
        { value: `${b.success} מתוך ${b.total}`, label: 'חזרות' },
      ],
      note: b.total > 0 && b.total < THIN ? 'מעט נתונים — האחוז עוד לא יציב' : undefined,
    };
  };
  return (
    <ChartCard
      title="הצלחה לפי אורך המרווח"
      sub="כמה מהחזרות הצליחו (נכון או קל מאוד), לפי הזמן שעבר מהחזרה הקודמת. הצלחה אחרי מרווח ארוך היא מה שבאמת נשאר."
      legend={
        <Legend
          items={[
            { label: 'שבוע ומעלה', color: COLORS.key, kind: 'rect' },
            { label: 'מרווח קצר יותר', color: COLORS.context, kind: 'rect' },
          ]}
        />
      }
      table={{
        head: ['מרווח', 'הצלחה', 'הצליחו', 'חזרות'],
        rows: buckets.map((b) => [b.label, pct(b.rate), b.success, b.total]),
      }}
      foot={<p className="tiny muted">n = מספר החזרות בכל מרווח. עמודה חיוורת: פחות מ־{THIN} חזרות.</p>}
    >
      <Plot
        n={n}
        height={236}
        margin={{ t: 24, r: 38, b: 46, l: 6 }}
        label="אחוז הצלחה לפי אורך המרווח מהחזרה הקודמת"
        tip={tip}
        anchorY={(i, f) => f.bottom - (buckets[i].rate ?? 0) * (f.bottom - f.top) - 16}
      >
        {(f) => {
          const y = (v: number) => f.bottom - v * (f.bottom - f.top);
          const bw = barWidth(f);
          const split = (label: string) => (label.length * 5.6 > f.slot - 4 && label.includes('–') ? [label.split('–')[0] + '–', label.split('–')[1]] : [label]);
          return (
            <>
              <YGrid f={f} ticks={PCT_TICKS} max={1} format={fmtPct} />
              {buckets.map((b, i) => {
                const x = f.cx(i);
                if (b.rate === null) {
                  return (
                    <text key={i} x={x} y={f.bottom - 6} fontSize={11} textAnchor="middle" style={{ fill: COLORS.label }}>
                      —
                    </text>
                  );
                }
                const top = Math.min(y(b.rate), f.bottom - 2);
                return (
                  <g key={i}>
                    <path d={columnPath(x - bw / 2, bw, top, f.bottom)} style={{ fill: isLong(b) ? COLORS.key : COLORS.context, fillOpacity: b.total < THIN ? 0.4 : 1 }} />
                    <text x={x} y={top - 6} fontSize={11.5} fontWeight={650} textAnchor="middle" direction="ltr" style={{ fill: COLORS.ink2, fontVariantNumeric: 'tabular-nums' }}>
                      {pct(b.rate)}
                    </text>
                  </g>
                );
              })}
              <XLabels f={f} labels={buckets.map((b) => [...split(b.label), `n=${b.total}`])} />
            </>
          );
        }}
      </Plot>
    </ChartCard>
  );
}

// ---------- weekly trend ----------

type Pt = { i: number; v: number };

/** Consecutive non-null runs, so a week without reviews breaks the line instead of dropping to zero. */
function runs(values: (number | null)[]): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push({ i, v });
  });
  if (cur.length) out.push(cur);
  return out;
}

export function WeeklyTrendChart({ weeks }: { weeks: ProgressDTO['weeks'] }) {
  const n = weeks.length;
  const longVals = weeks.map((w) => w.longRate);
  const allVals = weeks.map((w) => w.rate);
  const lastIdx = (vals: (number | null)[]) => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return i;
    return -1;
  };
  const tip = (i: number): Tip => {
    const w = weeks[i];
    return {
      title: `שבוע שמתחיל ב־${formatDate(w.weekStart)}`,
      rows: [
        { value: w.longRate === null ? 'אין' : pct(w.longRate), label: `אחרי מרווח של שבוע+ · n=${w.longTotal}`, color: COLORS.key },
        { value: w.rate === null ? 'אין' : pct(w.rate), label: `כל החזרות · n=${w.total}`, color: COLORS.context },
      ],
    };
  };
  const series = [
    { vals: allVals, color: COLORS.context },
    { vals: longVals, color: COLORS.key },
  ];

  return (
    <ChartCard
      title="מגמה שבועית"
      sub="אחוז ההצלחה בכל שבוע ב־12 השבועות האחרונים. שבוע בלי חזרות מופיע כרווח בקו; בשבוע עם מעט חזרות האחוז קופץ — n מופיע במעבר עם העכבר ובטבלה."
      legend={
        <Legend
          items={[
            { label: 'אחרי מרווח של שבוע ומעלה', color: COLORS.key, kind: 'line' },
            { label: 'כל החזרות', color: COLORS.context, kind: 'line' },
          ]}
        />
      }
      table={{
        head: ['שבוע מ־', 'שבוע+ ', 'n', 'כל החזרות', 'n'],
        rows: weeks.map((w) => [formatDate(w.weekStart), pct(w.longRate), w.longTotal, pct(w.rate), w.total]),
      }}
    >
      <Plot
        n={n}
        height={220}
        margin={{ t: 16, r: 38, b: 26, l: 40 }}
        label="אחוז הצלחה שבועי: אחרי מרווח של שבוע ומעלה, ובכל החזרות"
        tip={tip}
        highlight="crosshair"
        anchorY={(_i, f) => f.top + 4}
      >
        {(f, active) => {
          const y = (v: number) => f.bottom - v * (f.bottom - f.top);
          const k = labelEvery(f.slot, 38);
          const endLong = lastIdx(longVals);
          return (
            <>
              <YGrid f={f} ticks={PCT_TICKS} max={1} format={fmtPct} />
              {series.map((s, si) => (
                <g key={si}>
                  {runs(s.vals).map((run, ri) =>
                    run.length > 1 ? (
                      <path
                        key={ri}
                        d={run.map((p, j) => `${j ? 'L' : 'M'}${f.cx(p.i)},${y(p.v)}`).join('')}
                        fill="none"
                        style={{ stroke: s.color }}
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    ) : null,
                  )}
                  {/* Markers: isolated weeks (no line to carry them), the latest point, and the hovered week. */}
                  {s.vals.map((v, i) => {
                    if (v === null) return null;
                    const isolated = (i === 0 || s.vals[i - 1] === null) && (i === n - 1 || s.vals[i + 1] === null);
                    if (!isolated && i !== lastIdx(s.vals) && i !== active) return null;
                    return <circle key={i} cx={f.cx(i)} cy={y(v)} r={4} style={{ fill: s.color, stroke: COLORS.surface }} strokeWidth={2} />;
                  })}
                </g>
              ))}
              {endLong >= 0 && (
                <text
                  x={f.cx(endLong) - 9}
                  y={y(longVals[endLong] ?? 0)}
                  dy="0.32em"
                  fontSize={12}
                  fontWeight={700}
                  direction="ltr"
                  textAnchor="end"
                  paintOrder="stroke"
                  strokeWidth={3}
                  style={{ fill: COLORS.ink, stroke: COLORS.surface, fontVariantNumeric: 'tabular-nums' }}
                >
                  {pct(longVals[endLong])}
                </text>
              )}
              <XLabels f={f} labels={weeks.map((w, i) => ((n - 1 - i) % k === 0 ? [shortDate(w.weekStart)] : null))} />
            </>
          );
        }}
      </Plot>
    </ChartCard>
  );
}

// ---------- daily minutes vs budget ----------

export function DailyMinutesChart({ daily, budget, today }: { daily: ProgressDTO['daily']; budget: number; today: string }) {
  const n = daily.length;
  const maxV = Math.max(budget * 1.15, ...daily.map((d) => d.minutes));
  const ticks = niceTicks(maxV, 3);
  const max = ticks[ticks.length - 1];
  const active = daily.filter((d) => d.reviews > 0);
  const over = active.filter((d) => d.minutes > budget).length;
  const tip = (i: number): Tip => {
    const d = daily[i];
    return {
      title: d.date === today ? `היום, ${formatDate(d.date)}` : formatDate(d.date, true),
      rows: [
        { value: `${d.minutes} דק׳`, label: 'זמן לימוד', color: COLORS.key, kind: 'rect' },
        { value: String(d.reviews), label: 'חזרות' },
      ],
      note: d.minutes > budget ? `מעל התקציב (${budget} דק׳)` : undefined,
    };
  };
  return (
    <ChartCard
      title="זמן לימוד יומי"
      sub={`דקות לימוד בכל יום ב־30 הימים האחרונים, מול התקציב היומי של ${budget} דק׳.${over === 1 ? ' יום אחד עבר את התקציב.' : over > 1 ? ` ${over} ימים עברו את התקציב.` : ''}`}
      table={{ head: ['תאריך', 'דקות', 'חזרות'], rows: daily.map((d) => [formatDate(d.date), d.minutes, d.reviews]) }}
    >
      <Plot n={n} height={200} margin={{ t: 14, r: 38, b: 24, l: 6 }} label={`דקות לימוד ביום, 30 הימים האחרונים, מול תקציב של ${budget} דקות`} tip={tip} anchorY={(i, f) => f.bottom - (daily[i].minutes / max) * (f.bottom - f.top)}>
        {(f) => {
          const y = (v: number) => f.bottom - (v / max) * (f.bottom - f.top);
          const bw = barWidth(f);
          const k = labelEvery(f.slot, 34);
          return (
            <>
              <YGrid f={f} ticks={ticks} max={max} format={(v) => String(v)} />
              {daily.map((d, i) =>
                d.minutes > 0 ? <path key={i} d={columnPath(f.cx(i) - bw / 2, bw, Math.min(y(d.minutes), f.bottom - 2), f.bottom, bw < 8 ? 2 : 4)} style={{ fill: COLORS.key }} /> : null,
              )}
              {/* Budget reference line: dashed because it is a target, not data. */}
              <line x1={f.left} x2={f.right} y1={y(budget)} y2={y(budget)} style={{ stroke: COLORS.ink2 }} strokeWidth={1.5} strokeDasharray="5 4" />
              <text x={f.right - 4} y={y(budget) - 6} fontSize={11} direction="rtl" textAnchor="start" paintOrder="stroke" strokeWidth={3} style={{ fill: COLORS.ink2, stroke: COLORS.surface }}>
                {`תקציב ${budget} דק׳`}
              </text>
              <XLabels f={f} labels={daily.map((d, i) => ((n - 1 - i) % k === 0 ? [d.date === today ? 'היום' : shortDate(d.date)] : null))} />
            </>
          );
        }}
      </Plot>
    </ChartCard>
  );
}

// ---------- due vs done / deferred ----------

export function DueDoneChart({ daily, today }: { daily: ProgressDTO['daily']; today: string }) {
  const n = daily.length;
  const ticks = niceTicks(Math.max(4, ...daily.map((d) => d.due)), 3);
  const max = ticks[ticks.length - 1];
  const doneOf = (d: ProgressDTO['daily'][number]) => Math.max(0, d.due - d.deferred);
  // Today's queue is not part of this series (the day is still open); the calendar shows it.
  const tip = (i: number): Tip => {
    const d = daily[i];
    const isToday = d.date === today;
    const title = isToday ? `היום, ${formatDate(d.date)}` : formatDate(d.date, true);
    if (isToday) return { title, rows: [{ value: String(d.reviews), label: 'חזרות עד עכשיו' }], note: 'היום עוד פתוח — מה שמתוכנן להיום מופיע בלוח החזרות' };
    if (d.due === 0 && d.reviews === 0) return { title, rows: [], note: 'לא נרשם תור ליום הזה — האתר לא נפתח, או שלא היו חזרות' };
    return {
      title,
      rows: [
        { value: String(doneOf(d)), label: 'בוצעו מהמתוכננות', color: COLORS.key, kind: 'rect' },
        { value: String(d.deferred), label: 'נדחו', color: COLORS.bad, kind: 'rect' },
        { value: String(d.due), label: 'היו מתוכננות' },
      ],
      note: d.reviews > doneOf(d) ? `סה״כ ${d.reviews} חזרות באותו יום` : undefined,
    };
  };
  return (
    <ChartCard
      title="מתוכנן מול בוצע"
      sub="לכל יום שהסתיים: כמה יחידות עמדו בתור כשהיום התחיל, כמה מהן בוצעו באותו יום וכמה נדחו."
      legend={
        <Legend
          items={[
            { label: 'בוצעו', color: COLORS.key, kind: 'rect' },
            { label: 'נדחו', color: COLORS.bad, kind: 'rect' },
          ]}
        />
      }
      table={{
        head: ['תאריך', 'מתוכננות', 'בוצעו', 'נדחו'],
        rows: daily.map((d) => (d.date === today ? [`${formatDate(d.date)} (היום, עוד פתוח)`, '—', d.reviews, '—'] : [formatDate(d.date), d.due, doneOf(d), d.deferred])),
      }}
    >
      <Plot n={n} height={200} margin={{ t: 14, r: 38, b: 24, l: 6 }} label="חזרות מתוכננות, שבוצעו ושנדחו בכל יום, 30 הימים האחרונים" tip={tip} anchorY={(i, f) => f.bottom - (daily[i].due / max) * (f.bottom - f.top)}>
        {(f) => {
          const y = (v: number) => f.bottom - (v / max) * (f.bottom - f.top);
          const bw = barWidth(f);
          const r = bw < 8 ? 2 : 4;
          const k = labelEvery(f.slot, 34);
          return (
            <>
              <YGrid f={f} ticks={ticks} max={max} format={(v) => String(v)} />
              {daily.map((d, i) => {
                const x = f.cx(i) - bw / 2;
                if (d.due === 0 || d.date === today) return null;
                const done = doneOf(d);
                const doneTop = y(done);
                const allTop = y(d.due);
                // 2px surface gap between the two stacked segments.
                return (
                  <g key={i}>
                    {done > 0 && <path d={columnPath(x, bw, d.deferred > 0 ? doneTop + 1 : doneTop, f.bottom, d.deferred > 0 ? 0 : r)} style={{ fill: COLORS.key }} />}
                    {d.deferred > 0 && <path d={columnPath(x, bw, allTop, done > 0 ? doneTop - 1 : f.bottom, r)} style={{ fill: COLORS.bad }} />}
                  </g>
                );
              })}
              <XLabels f={f} labels={daily.map((d, i) => ((n - 1 - i) % k === 0 ? [d.date === today ? 'היום' : shortDate(d.date)] : null))} />
            </>
          );
        }}
      </Plot>
    </ChartCard>
  );
}
