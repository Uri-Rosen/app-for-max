// Chart primitives for the progress page: a measured SVG frame whose x axis
// runs right-to-left (the oldest / first category at the right, like the
// rest of the RTL layout), one tooltip layer driven by pointer, touch and
// arrow keys, legends, and a table twin for every chart.
//
// The SVG is drawn at the container's real pixel width (viewBox = width), so
// labels stay 11px at 375px instead of shrinking with the drawing.

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';

/** Colour roles, all from the design tokens (see styles.css). */
export const COLORS = {
  /** The series the story is about (long-gap retention, time, done). */
  key: 'var(--accent)',
  /** De-emphasised context series: a lighter step of the muted ink. */
  context: 'color-mix(in srgb, var(--soft) 65%, var(--surface))',
  bad: 'var(--wrong)',
  warn: 'var(--partial)',
  grid: 'var(--line-2)',
  axis: 'var(--line)',
  label: 'var(--soft)',
  ink: 'var(--ink)',
  ink2: 'var(--ink-2)',
  surface: 'var(--surface)',
  band: 'var(--surface-2)',
} as const;

export interface Margin {
  t: number;
  r: number;
  b: number;
  l: number;
}

export interface Frame {
  W: number;
  H: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  slot: number;
  n: number;
  /** Centre of band i; i = 0 sits at the right edge. */
  cx: (i: number) => number;
}

function makeFrame(W: number, H: number, m: Margin, n: number): Frame {
  const left = m.l;
  const right = W - m.r;
  const slot = (right - left) / Math.max(1, n);
  return { W, H, top: m.t, bottom: H - m.b, left, right, slot, n, cx: (i) => right - (i + 0.5) * slot };
}

export interface TipRow {
  value: string;
  label: string;
  color?: string;
  kind?: 'line' | 'rect' | 'outline';
}

export interface Tip {
  title: string;
  rows: TipRow[];
  note?: string;
}

function tipText(t: Tip): string {
  return [t.title, ...t.rows.map((r) => `${r.label}: ${r.value}`), t.note].filter(Boolean).join('. ');
}

// ---------- scales & shapes ----------

/** Clean axis ticks from 0 to a round number ≥ max. */
export function niceTicks(max: number, target = 4, integer = true): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  if (integer) step = Math.max(1, Math.round(step));
  const top = Math.ceil(max / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

/** A column with a 4px rounded data end and a square foot on the baseline. */
export function columnPath(x: number, w: number, yTop: number, yBase: number, radius = 4): string {
  const h = yBase - yTop;
  if (!(h > 0) || !(w > 0)) return '';
  const r = Math.min(radius, w / 2, h);
  return `M${x},${yBase}V${yTop + r}A${r},${r} 0 0 1 ${x + r},${yTop}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${yTop + r}V${yBase}Z`;
}

/** Every k-th band gets an x label, counted from the newest so it is always labelled. */
export function labelEvery(slot: number, minPx: number): number {
  return Math.max(1, Math.ceil(minPx / Math.max(1, slot)));
}

export function shortDate(d: string): string {
  return `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}`;
}

// ---------- axis bits ----------

/** Horizontal gridlines with tick labels on the right (the start side in RTL). */
export function YGrid({ f, ticks, max, format }: { f: Frame; ticks: number[]; max: number; format: (v: number) => string }) {
  return (
    <g>
      {ticks.map((t) => {
        const y = f.bottom - (t / max) * (f.bottom - f.top);
        return (
          <g key={t}>
            <line x1={f.left} x2={f.right} y1={y} y2={y} style={{ stroke: t === 0 ? COLORS.axis : COLORS.grid }} strokeWidth={1} shapeRendering="crispEdges" />
            <text x={f.right + 6} y={y} dy="0.32em" fontSize={11} direction="ltr" textAnchor="start" style={{ fill: COLORS.label, fontVariantNumeric: 'tabular-nums' }}>
              {format(t)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Bottom labels, one or more lines per band. */
export function XLabels({ f, labels }: { f: Frame; labels: (string[] | null)[] }) {
  return (
    <g>
      {labels.map((lines, i) =>
        lines ? (
          <text key={i} x={f.cx(i)} y={f.bottom + 15} fontSize={11} textAnchor="middle" style={{ fill: COLORS.label, fontVariantNumeric: 'tabular-nums' }}>
            {lines.map((l, j) => (
              <tspan key={j} x={f.cx(i)} dy={j === 0 ? 0 : 13}>
                {l}
              </tspan>
            ))}
          </text>
        ) : null,
      )}
    </g>
  );
}

// ---------- the interactive plot ----------

export function Plot(props: {
  n: number;
  height: number;
  margin: Margin;
  /** Short description of what is plotted, for assistive tech. */
  label: string;
  tip: (i: number) => Tip | null;
  /** Where the tooltip points, in px from the top. */
  anchorY: (i: number, f: Frame) => number;
  highlight?: 'band' | 'crosshair';
  children: (f: Frame, active: number | null) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.floor(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const f = W > 0 ? makeFrame(W, props.height, props.margin, props.n) : null;

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (!f) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) * f.W) / rect.width;
    const i = Math.floor((f.right - x) / f.slot);
    setActive(i >= 0 && i < props.n ? i : null);
  };

  // RTL: the left arrow moves forward (towards the left edge), the right arrow back.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? -1;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = Math.min(props.n - 1, cur + 1);
    else if (e.key === 'ArrowRight') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = props.n - 1;
    else if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  const tip = f && active !== null ? props.tip(active) : null;
  const highlight = props.highlight ?? 'band';

  return (
    <div
      ref={ref}
      className="pz-plot"
      tabIndex={0}
      role="group"
      aria-label={`${props.label}. אפשר לעבור בין הערכים בחצים.`}
      onKeyDown={onKey}
      onFocus={(e) => {
        if (e.currentTarget.matches(':focus-visible')) setActive((a) => a ?? 0);
      }}
      onBlur={() => setActive(null)}
      style={{ height: props.height }}
    >
      {f && (
        <svg
          width={f.W}
          height={f.H}
          viewBox={`0 0 ${f.W} ${f.H}`}
          aria-hidden="true"
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') setActive(null);
          }}
        >
          {active !== null && highlight === 'band' && (
            <rect x={f.cx(active) - f.slot / 2} y={f.top} width={f.slot} height={f.bottom - f.top} rx={3} style={{ fill: COLORS.band }} />
          )}
          {active !== null && highlight === 'crosshair' && (
            <line x1={f.cx(active)} x2={f.cx(active)} y1={f.top} y2={f.bottom} style={{ stroke: COLORS.axis }} strokeWidth={1} shapeRendering="crispEdges" />
          )}
          {props.children(f, active)}
        </svg>
      )}
      {tip && f && active !== null && <TipBox x={f.cx(active)} y={props.anchorY(active, f)} W={f.W} tip={tip} />}
      <div className="sr-only" aria-live="polite">
        {tip ? tipText(tip) : ''}
      </div>
    </div>
  );
}

function TipBox({ x, y, W, tip }: { x: number; y: number; W: number; tip: Tip }) {
  const tx = x < 110 ? '-14px' : x > W - 110 ? 'calc(-100% + 14px)' : '-50%';
  return (
    <div className="pz-tip" style={{ left: x, top: Math.max(0, y), transform: `translate(${tx}, calc(-100% - 8px))` }}>
      <div className="pz-tip-t">{tip.title}</div>
      {tip.rows.map((r, i) => (
        <div key={i} className="pz-tip-r">
          {r.color && <Key color={r.color} kind={r.kind ?? 'line'} small />}
          <b>{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
      {tip.note && <div className="pz-tip-n">{tip.note}</div>}
    </div>
  );
}

// ---------- legend, card, table twin ----------

export function Key({ color, kind, small }: { color: string; kind: 'line' | 'rect' | 'outline'; small?: boolean }) {
  if (kind === 'line') return <span className="pz-key-line" style={{ background: color, width: small ? 10 : 14 }} aria-hidden />;
  if (kind === 'outline') return <span className="pz-key-rect" style={{ border: `1.5px solid ${color}`, background: 'transparent' }} aria-hidden />;
  return <span className="pz-key-rect" style={{ background: color }} aria-hidden />;
}

export function Legend({ items }: { items: { label: string; color: string; kind: 'line' | 'rect' | 'outline' }[] }) {
  return (
    <div className="pz-legend">
      {items.map((it) => (
        <span key={it.label}>
          <Key color={it.color} kind={it.kind} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export interface TableTwin {
  head: string[];
  rows: (string | number)[][];
}

export function ChartCard(props: { title: string; sub?: ReactNode; legend?: ReactNode; children: ReactNode; table: TableTwin; foot?: ReactNode }) {
  return (
    <section className="card pz-chart">
      <h3>{props.title}</h3>
      {props.sub && <p className="small muted pz-sub">{props.sub}</p>}
      {props.legend}
      {props.children}
      {props.foot}
      <details className="pz-table">
        <summary>הצג כטבלה</summary>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                {props.table.head.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} className="num">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

/** Styles shared by the progress page. Tokens only, so both themes work. */
export const PROGRESS_CSS = `
.pz-plot { position: relative; touch-action: pan-y; border-radius: 4px; margin-top: 4px; }
.pz-plot svg { display: block; overflow: visible; }
.pz-plot:focus-visible { outline-offset: 4px; }
.pz-tip {
  position: absolute; z-index: 5; pointer-events: none; white-space: nowrap;
  background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: var(--radius-sm);
  box-shadow: var(--shadow); padding: 6px 10px; font-size: 0.8rem; line-height: 1.45;
}
.pz-tip-t { color: var(--soft); font-size: 0.75rem; margin-bottom: 2px; }
.pz-tip-r { display: flex; align-items: center; gap: 6px; }
.pz-tip-r b { font-weight: 700; font-variant-numeric: tabular-nums; }
.pz-tip-r span { color: var(--ink-2); }
.pz-tip-n { color: var(--soft); font-size: 0.74rem; margin-top: 2px; }
.pz-key-line { display: inline-block; height: 2px; border-radius: 1px; flex: none; }
.pz-key-rect { display: inline-block; width: 10px; height: 10px; border-radius: 2px; flex: none; box-sizing: border-box; }
.pz-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 0.82rem; color: var(--ink-2); margin: 8px 0 2px; }
.pz-legend > span { display: inline-flex; align-items: center; gap: 6px; }
.pz-chart h3 { margin-bottom: 2px; }
.pz-sub { margin-top: 2px; }
.pz-table summary { cursor: pointer; font-size: 0.82rem; color: var(--soft); margin-top: 10px; width: fit-content; }
.pz-table summary:hover { color: var(--ink-2); }
.pz-table .table { margin-top: 6px; font-size: 0.85rem; }
.pz-charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 440px), 1fr)); gap: 12px; }
.pz-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 12px; }
.pz-hero { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 12px; }
.pz-hero .card { display: flex; flex-direction: column; gap: 4px; }
.pz-hero-v { font-size: 3rem; font-weight: 700; line-height: 1.05; letter-spacing: -0.01em; }
.pz-hero-v.few { font-size: 1.6rem; line-height: 1.3; color: var(--ink-2); }
.pz-kpi .v { font-variant-numeric: normal; }
.pz-kpi .v small { font-size: 0.95rem; font-weight: 600; color: var(--ink-2); }
.pz-meter { height: 6px; border-radius: 999px; background: var(--accent-soft); overflow: hidden; margin-top: 6px; }
.pz-meter > div { height: 100%; border-radius: 999px; }
.pz-hbars { display: flex; flex-direction: column; gap: 8px; }
.pz-hbar { display: grid; grid-template-columns: minmax(0, 9.5em) minmax(0, 1fr) 3.2em; align-items: center; gap: 10px; font-size: 0.9rem; }
.pz-hbar .track { height: 10px; position: relative; }
.pz-hbar .fill { position: absolute; inset-block: 0; inset-inline-start: 0; border-start-end-radius: 4px; border-end-end-radius: 4px; min-width: 2px; }
.pz-hbar .val { text-align: end; font-variant-numeric: tabular-nums; color: var(--ink-2); }
.pz-stat { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--line-2); }
.pz-stat:last-child { border-bottom: 0; }
.pz-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.pz-section-head p { color: var(--soft); font-size: 0.9rem; }
@media (max-width: 520px) {
  .pz-hero-v { font-size: 2.5rem; }
  .pz-hbar { grid-template-columns: minmax(0, 7.5em) minmax(0, 1fr) 2.8em; }
}
`;
