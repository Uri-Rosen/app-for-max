// Pieces of the calendar page: the month grid, the day panel, the 14-day
// load strip and the legend. Load is shown as a wash of the accent colour
// whose strength follows the number of reviews against the daily cap.

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import type { CalendarDayDTO, CalendarDayDetailDTO } from '../../../../shared/api.ts';
import { addDays, daysBetween } from '../../../../shared/dates.ts';
import { formatDate, formatDays, formatIn } from '../../../../shared/labels.ts';
import { Link } from '../../router.tsx';
import { ErrorBox, GradeBadge, Loading, useLoad } from '../../ui.tsx';

export const DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

const monthFmt = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export function monthTitle(y: number, m: number): string {
  return monthFmt.format(new Date(Date.UTC(y, m - 1, 1)));
}

/** Accent wash for a count; past days are drawn at half strength. */
export function heat(n: number, cap: number, past = false): string {
  if (n <= 0) return '0%';
  const v = 6 + 26 * Math.min(1, n / Math.max(1, cap));
  return `${Math.round(past ? v * 0.5 : v)}%`;
}

function heatStyle(n: number, cap: number, past = false): CSSProperties {
  return { ['--heat' as string]: heat(n, cap, past) } as CSSProperties;
}

/** "חזרה אחת" / "3 חזרות". */
export function reviewsWord(n: number): string {
  return n === 1 ? 'חזרה אחת' : `${n} חזרות`;
}

/** "היום", "מחר", "בעוד 3 ימים", "אתמול", "לפני 5 ימים". */
export function relDay(date: string, today: string): string {
  const d = daysBetween(today, date);
  if (d >= 0) return formatIn(d);
  if (d === -1) return 'אתמול';
  return `לפני ${formatDays(-d)}`;
}

function dayAria(date: string, today: string, c: CalendarDayDTO | undefined): string {
  const parts = [formatDate(date, true)];
  if (date === today) parts.push('היום');
  if (c) {
    if (c.kind === 'past') {
      if (c.done) parts.push(c.done === 1 ? 'חזרה אחת בוצעה' : `${c.done} חזרות בוצעו`);
      if (c.deferred) parts.push(c.deferred === 1 ? 'חזרה אחת נדחתה' : `${c.deferred} נדחו`);
    } else if (c.scheduled) {
      parts.push(`${reviewsWord(c.scheduled)} ${c.scheduled === 1 ? 'מתוכננת' : 'מתוכננות'}`);
      if (c.overdue) parts.push(`מתוכן ${c.overdue} באיחור`);
    }
  }
  return parts.join(', ');
}

// ---------- month grid ----------

export function MonthGrid(props: {
  cells: string[];
  month: string; // 'YYYY-MM'
  byDate: Map<string, CalendarDayDTO>;
  today: string;
  sel: string;
  cap: number;
  onSelect: (date: string) => void;
}) {
  const { cells, month, byDate, today, sel, cap } = props;
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  // Roving focus: one tab stop, arrows move the selection (RTL: left = next day).
  const focusable = cells.includes(sel) ? sel : `${month}-01`;
  useEffect(() => {
    if (!pendingFocus) return;
    const el = refs.current.get(pendingFocus);
    if (el) {
      el.focus();
      setPendingFocus(null);
    }
  }, [pendingFocus, cells]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta: Record<string, number> = { ArrowLeft: 1, ArrowRight: -1, ArrowUp: -7, ArrowDown: 7 };
    let next: string | null = null;
    if (e.key in delta) next = addDays(focusable, delta[e.key]);
    else if (e.key === 'Home') next = addDays(focusable, -new Date(`${focusable}T00:00:00Z`).getUTCDay());
    else if (e.key === 'End') next = addDays(focusable, 6 - new Date(`${focusable}T00:00:00Z`).getUTCDay());
    if (!next) return;
    e.preventDefault();
    props.onSelect(next);
    setPendingFocus(next);
  };

  return (
    <div className="cal lc-cal" role="group" aria-label="ימי החודש. חצים למעבר בין ימים." onKeyDown={onKey}>
      {DOW.map((d) => (
        <div key={d} className="dow" aria-hidden>
          {d}
        </div>
      ))}
      {cells.map((date) => {
        const c = byDate.get(date);
        const other = !date.startsWith(month);
        const isToday = date === today;
        const past = date < today;
        const load = !c ? 0 : c.kind === 'past' ? c.done : c.scheduled;
        const cls = ['day', 'lc-d', other ? 'other' : '', isToday ? 'today' : '', date === sel ? 'sel' : ''].filter(Boolean).join(' ');
        return (
          <button
            key={date}
            ref={(el) => {
              if (el) refs.current.set(date, el);
              else refs.current.delete(date);
            }}
            type="button"
            className={cls}
            style={heatStyle(load, cap, past)}
            tabIndex={date === focusable ? 0 : -1}
            aria-pressed={date === sel}
            aria-current={isToday ? 'date' : undefined}
            aria-label={dayAria(date, today, c)}
            onClick={() => props.onSelect(date)}
          >
            <span className="lc-top">
              <span className="dnum">{Number(date.slice(8, 10))}</span>
              {isToday && <span className="lc-today-tag">היום</span>}
            </span>
            {c && <CellBody c={c} />}
          </button>
        );
      })}
    </div>
  );
}

function CellBody({ c }: { c: CalendarDayDTO }) {
  if (c.kind === 'past') {
    return (
      <>
        {c.done > 0 && (
          <span className="lc-line">
            <span aria-hidden>✓</span>
            <b>{c.done}</b>
            <span className="lc-w">בוצעו</span>
          </span>
        )}
        {c.deferred > 0 && (
          <span className="lc-line lc-bad">
            <span className="lc-dot" aria-hidden />
            <b>{c.deferred}</b>
            <span className="lc-w">נדחו</span>
          </span>
        )}
      </>
    );
  }
  if (c.scheduled === 0) return null;
  return (
    <>
      <span className="lc-line">
        <b>{c.scheduled}</b>
        <span className="lc-w">חזרות</span>
      </span>
      {c.overdue > 0 && (
        <span className="lc-line lc-bad">
          <span className="lc-dot" aria-hidden />
          <b>{c.overdue}</b>
          <span className="lc-w">באיחור</span>
        </span>
      )}
    </>
  );
}

export function CalLegend({ cap }: { cap: number }) {
  const sw = (n: number): CSSProperties => ({ ...heatStyle(n, cap), background: 'color-mix(in srgb, var(--accent) var(--heat), var(--surface))' });
  return (
    <div className="lc-legend small">
      <span>
        <span className="lc-sw" style={sw(1)} />
        <span className="lc-sw" style={sw(Math.ceil(cap / 2))} />
        <span className="lc-sw" style={sw(cap)} />
        עומס: מעט ← {cap}+ חזרות
      </span>
      <span>
        <span className="lc-sw lc-sw-today" /> היום
      </span>
      <span>
        <span aria-hidden>✓</span> בוצעו
      </span>
      <span>
        <span className="lc-dot" /> נדחו, או באיחור היום
      </span>
    </div>
  );
}

// ---------- 14-day strip ----------

export function Upcoming(props: { days: CalendarDayDTO[]; today: string; sel: string; cap: number; onSelect: (date: string) => void }) {
  const { days, cap } = props;
  const H = 64;
  const maxN = Math.max(cap * 1.25, ...days.map((d) => d.scheduled));
  const px = (n: number) => (n / maxN) * H;
  const total = days.reduce((s, d) => s + d.scheduled, 0);
  const crunch = days.filter((d) => d.scheduled > cap).length;
  const busiest = days.reduce<CalendarDayDTO | null>((b, d) => (d.scheduled > (b?.scheduled ?? 0) ? d : b), null);

  return (
    <section className="card">
      <div className="row-between" style={{ alignItems: 'baseline' }}>
        <h2>14 הימים הקרובים</h2>
        <span className="small muted">
          {total === 1 ? 'חזרה אחת מתוכננת' : <><span className="num">{total}</span> חזרות מתוכננות</>}
          {crunch > 0 ? (
            <>
              {' · '}
              <span style={{ color: 'var(--ink)' }}>
                <span className="num">{crunch}</span> {crunch === 1 ? 'יום' : 'ימים'} מעל המכסה היומית
              </span>
            </>
          ) : total > 0 ? (
            ' · אין יום מעל המכסה היומית'
          ) : (
            ''
          )}
        </span>
      </div>
      <div className="lc-up" role="group" aria-label="עומס החזרות ב־14 הימים הקרובים">
        {days.map((d) => {
          const overdue = Math.min(d.overdue, d.scheduled);
          const within = Math.min(d.scheduled, cap);
          const excess = Math.max(0, d.scheduled - cap);
          const ovIn = Math.min(overdue, within);
          const segs = [
            { n: excess, color: 'var(--partial)' },
            { n: within - ovIn, color: 'var(--accent)' },
            { n: ovIn, color: 'var(--wrong)' },
          ].filter((s) => s.n > 0);
          const wd = new Date(`${d.date}T00:00:00Z`).getUTCDay();
          const label = [
            formatDate(d.date, true),
            d.date === props.today ? 'היום' : relDay(d.date, props.today),
            d.scheduled ? reviewsWord(d.scheduled) : 'אין חזרות',
            d.overdue ? `מתוכן ${d.overdue} באיחור` : '',
            excess ? `${excess} מעל המכסה היומית (${cap})` : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <button
              key={d.date}
              type="button"
              className={d.date === props.sel ? 'sel' : ''}
              title={label}
              aria-label={label}
              aria-pressed={d.date === props.sel}
              onClick={() => props.onSelect(d.date)}
            >
              <span className="plot" style={{ height: H + 18 }}>
                <span className="capline" style={{ bottom: px(cap) }} aria-hidden />
                <span className="n">{d.scheduled || ''}</span>
                <span className="bar" aria-hidden>
                  {segs.map((s, i) => (
                    <span key={i} style={{ height: Math.max(2, px(s.n) - (i < segs.length - 1 ? 2 : 0)), background: s.color }} />
                  ))}
                </span>
              </span>
              <span className={`dow ${wd === 5 || wd === 6 ? 'we' : ''}`}>{d.date === props.today ? 'היום' : DOW[wd]}</span>
              <span className="dd num">{Number(d.date.slice(8, 10))}</span>
            </button>
          );
        })}
      </div>
      <div className="lc-legend small" style={{ marginTop: 8 }}>
        <span>
          <span className="lc-sw" style={{ background: 'var(--accent)' }} /> מתוכננות
        </span>
        <span>
          <span className="lc-sw" style={{ background: 'var(--wrong)' }} /> באיחור
        </span>
        <span>
          <span className="lc-sw" style={{ background: 'var(--partial)' }} /> מעל המכסה — חלק יידחו ליום הבא
        </span>
        <span>
          <span className="lc-capkey" /> מכסה יומית: {cap}
        </span>
      </div>
      {busiest && busiest.scheduled > cap && (
        <p className="small muted" style={{ marginTop: 6 }}>
          היום העמוס ביותר: {formatDate(busiest.date, true)} — <span className="num">{busiest.scheduled}</span> חזרות,{' '}
          <span className="num">{busiest.scheduled - cap}</span> מעבר למכסה. מה שלא ייכנס באותו יום יישאר בתור לימים הבאים, לא יימחק.
        </p>
      )}
    </section>
  );
}

// ---------- day panel ----------

export function DayDetail({ date, today }: { date: string; today: string }) {
  const { data, error, loading, reload } = useLoad<CalendarDayDetailDTO>(`/calendar/day?date=${date}`);
  const kind = date < today ? 'past' : date === today ? 'today' : 'future';
  const d = data && data.date === date ? data : null;

  return (
    <section className="card lc-detail" aria-live="polite" aria-busy={loading}>
      <div className="row-between" style={{ alignItems: 'baseline' }}>
        <h2>{formatDate(date, true)}</h2>
        <span className={`badge ${kind === 'today' ? 'accent' : 'outline'}`}>{kind === 'today' ? 'היום' : relDay(date, today)}</span>
      </div>
      {error && <ErrorBox error={error} retry={reload} />}
      {!d && !error ? (
        <Loading />
      ) : d ? (
        <div className="stack" style={{ marginTop: 10, opacity: loading ? 0.6 : 1 }}>
          {kind !== 'past' && (
            <Group title={kind === 'today' ? 'מתוכננות להיום' : 'מתוכננות'} n={d.scheduled.length}>
              {d.scheduled.map((s) => (
                <li key={s.unitId} className="list-item">
                  <div className="grow">
                    <Link to={`/unit/${s.unitId}`}>{s.title}</Link>
                    <div className="tiny muted">
                      {s.courseName} · {s.topicName}
                    </div>
                  </div>
                  {s.dueDate < date && <span className="badge wrong">באיחור מ־{formatDate(s.dueDate)}</span>}
                </li>
              ))}
            </Group>
          )}
          {(kind !== 'future' || d.reviewed.length > 0) && (
            <Group title={kind === 'today' ? 'בוצעו היום' : 'בוצעו'} n={d.reviewed.length}>
              {d.reviewed.map((r, i) => (
                <li key={`${r.unitId}-${i}`} className="list-item">
                  <div className="grow">
                    <Link to={`/unit/${r.unitId}`}>{r.title}</Link>
                    <div className="tiny muted">{r.nextDue ? `חזרה הבאה: ${formatDate(r.nextDue)} (${relDay(r.nextDue, today)})` : 'אין מועד הבא'}</div>
                  </div>
                  <GradeBadge g={r.effectiveGrade} hint={r.hintUsed} />
                </li>
              ))}
            </Group>
          )}
          {kind === 'past' && (
            <Group title="נדחו או פוספסו" n={d.deferred.length} bad>
              {d.deferred.map((x) => (
                <li key={x.unitId} className="list-item">
                  <div className="grow">
                    <Link to={`/unit/${x.unitId}`}>{x.title}</Link>
                    <div className="tiny" style={{ color: 'var(--ink-2)' }}>
                      {x.nowDue
                        ? `נדחתה — כעת מתוזמנת ל־${formatDate(x.nowDue)} (${x.nowDue < today ? `באיחור מאז ${formatDate(x.nowDue)}` : relDay(x.nowDue, today)})`
                        : 'נדחתה — אין לה כרגע מועד חזרה'}
                    </div>
                  </div>
                </li>
              ))}
            </Group>
          )}
          {kind === 'today' && d.scheduled.length > 0 && (
            <Link to="/today" className="btn primary">
              לסשן של היום
            </Link>
          )}
          {kind === 'future' && d.scheduled.length > 0 && (
            <p className="tiny muted">הרשימה לפי מועדי החזרה הנוכחיים; היא תשתנה לפי התשובות בימים שלפני.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function Group({ title, n, bad, children }: { title: string; n: number; bad?: boolean; children: ReactNode }) {
  return (
    <div>
      <div className="row" style={{ marginBottom: 2 }}>
        <h3>{title}</h3>
        <span className={`badge ${n > 0 && bad ? 'wrong' : ''} num`}>{n}</span>
      </div>
      {n === 0 ? <p className="small muted">אין</p> : <ul className="list lc-ul">{children}</ul>}
    </div>
  );
}

export const CALENDAR_CSS = `
.lc-cal .day.lc-d, .lc-cal .day.lc-d.sel {
  background: color-mix(in srgb, var(--accent) var(--heat, 0%), var(--surface));
  color: var(--ink); min-height: 78px; min-width: 0; overflow: hidden;
}
.lc-cal .day.lc-d:hover { border-color: var(--line); }
.lc-cal .day.lc-d.sel { box-shadow: 0 0 0 2px var(--ink); }
.lc-cal .day.lc-d.sel.today { box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 2px var(--ink); }
.lc-top { display: flex; align-items: center; justify-content: space-between; gap: 4px; width: 100%; }
.lc-today-tag { font-size: 0.68rem; font-weight: 700; color: var(--accent); }
.lc-line { display: flex; align-items: center; gap: 3px; font-size: 0.78rem; line-height: 1.3; color: var(--ink-2); white-space: nowrap; }
.lc-line b { font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
.lc-bad, .lc-bad b { color: var(--wrong); }
.lc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--wrong); display: inline-block; flex: none; }
.lc-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--ink-2); }
.lc-legend > span { display: inline-flex; align-items: center; gap: 5px; }
.lc-sw { width: 12px; height: 12px; border-radius: 3px; border: 1px solid var(--line-2); display: inline-block; flex: none; }
.lc-sw-today { border: 2px solid var(--accent); background: var(--surface); }
.lc-capkey { width: 14px; border-top: 1.5px dashed var(--ink-2); display: inline-block; }
.lc-up { display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); gap: 3px; margin-top: 10px; }
.lc-up button {
  border: 0; background: transparent; padding: 4px 0 3px; border-radius: var(--radius-sm); cursor: pointer; min-width: 0;
  display: flex; flex-direction: column; align-items: center; gap: 3px; color: var(--ink-2); font-size: 0.75rem;
}
.lc-up button:hover { background: var(--surface-2); }
.lc-up button.sel { background: var(--surface-2); box-shadow: inset 0 0 0 1.5px var(--ink); }
.lc-up .n { font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; font-size: 0.8rem; line-height: 1.2; margin-bottom: 2px; position: relative; z-index: 1; }
.lc-up .plot { position: relative; width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
.lc-up .capline { position: absolute; inset-inline: 0; border-top: 1.5px dashed var(--ink-2); opacity: 0.7; z-index: 0; }
.lc-up .bar { width: min(18px, 62%); display: flex; flex-direction: column; gap: 2px; position: relative; z-index: 1; }
.lc-up .bar > span { display: block; }
.lc-up .bar > span:first-child { border-radius: 4px 4px 0 0; }
.lc-up .dow { font-weight: 650; white-space: nowrap; }
.lc-up .dow.we { color: var(--soft); }
.lc-up .dd { color: var(--soft); line-height: 1; }
.lc-ul { list-style: none; margin: 0; padding: 0; }
.lc-detail h3 { font-size: 0.95rem; }
.lc-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.lc-nav h2 { min-width: 9em; text-align: center; }
@media (max-width: 640px) {
  .lc-w, .lc-today-tag { display: none; }
  .lc-cal .day.lc-d { min-height: 56px; padding: 4px 5px; }
  .lc-line { font-size: 0.74rem; }
  .lc-up { gap: 1px; }
  .lc-up .dow { font-size: 0.68rem; }
}
`;
