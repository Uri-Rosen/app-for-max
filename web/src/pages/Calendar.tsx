// Calendar: planned, overdue and past reviews by day. The month grid shows
// load as a wash of the accent colour; the 14-day strip shows crunch days
// coming; the side panel lists what is behind any day.

import { useMemo, useState } from 'react';
import type { CalendarDayDTO } from '../../../shared/api.ts';
import { addDays, monthGrid } from '../../../shared/dates.ts';
import { useApp } from '../App.tsx';
import { Link } from '../router.tsx';
import { Empty, ErrorBox, Loading, useLoad } from '../ui.tsx';
import { CALENDAR_CSS, CalLegend, DayDetail, MonthGrid, Upcoming, monthTitle } from './calendar/parts.tsx';

interface YM {
  y: number;
  m: number;
}

const ymOf = (date: string): YM => ({ y: Number(date.slice(0, 4)), m: Number(date.slice(5, 7)) });
const ymKey = (v: YM) => `${v.y}-${String(v.m).padStart(2, '0')}`;
const shift = (v: YM, delta: number): YM => {
  const i = v.y * 12 + (v.m - 1) + delta;
  return { y: Math.floor(i / 12), m: (i % 12) + 1 };
};

export default function CalendarPage() {
  const { boot } = useApp();
  const today = boot.today;
  const cap = Math.max(1, boot.settings.maxItems);
  const totalUnits = boot.courses.reduce((s, c) => s + c.stats.units, 0);

  const [ym, setYm] = useState<YM>(() => ymOf(today));
  const [sel, setSel] = useState(today);
  const month = ymKey(ym);

  // Drop trailing weeks that belong wholly to the next month.
  const cells = useMemo(() => {
    const all = monthGrid(ym.y, ym.m);
    let rows = 6;
    while (rows > 4 && all.slice((rows - 1) * 7, rows * 7).every((d) => !d.startsWith(month))) rows--;
    return all.slice(0, rows * 7);
  }, [ym.y, ym.m, month]);

  const grid = useLoad<CalendarDayDTO[]>(`/calendar?from=${cells[0]}&to=${cells[cells.length - 1]}`);
  const upcoming = useLoad<CalendarDayDTO[]>(`/calendar?from=${today}&to=${addDays(today, 13)}`);

  const byDate = useMemo(() => new Map((grid.data ?? []).map((d) => [d.date, d])), [grid.data]);

  const select = (date: string) => {
    setSel(date);
    if (!date.startsWith(month)) setYm(ymOf(date));
  };

  if (totalUnits === 0) {
    return (
      <>
        <Head />
        <div className="card">
          <Empty title="עוד אין יחידות ידע בלוח" action={<Link to="/topics" className="btn primary">לנושאים</Link>}>
            כשיהיו יחידות ידע עם שאלות מאושרות, מועדי החזרה שלהן יופיעו כאן — מה מתוכנן, מה באיחור ומה כבר בוצע.
          </Empty>
        </div>
      </>
    );
  }

  const inMonth = (grid.data ?? []).filter((d) => d.date.startsWith(month));
  const sum = {
    done: inMonth.reduce((s, d) => s + d.done, 0),
    deferred: inMonth.reduce((s, d) => s + d.deferred, 0),
    planned: inMonth.reduce((s, d) => s + (d.kind === 'past' ? 0 : d.scheduled), 0),
  };

  return (
    <div className="stack-lg">
      <style>{CALENDAR_CSS}</style>
      <Head />

      {upcoming.error ? (
        <ErrorBox error={upcoming.error} retry={upcoming.reload} />
      ) : upcoming.data ? (
        <Upcoming days={upcoming.data} today={today} sel={sel} cap={cap} onSelect={select} />
      ) : (
        <Loading />
      )}

      <div className="grid-2">
        <section className="card">
          <div className="lc-nav">
            <button type="button" className="btn sm" onClick={() => setYm(shift(ym, -1))} aria-label="החודש הקודם">
              → הקודם
            </button>
            <div style={{ textAlign: 'center' }}>
              <h2 aria-live="polite">{monthTitle(ym.y, ym.m)}</h2>
              {grid.data && (
                <div className="tiny muted">
                  {[
                    sum.done ? (sum.done === 1 ? 'חזרה אחת בוצעה' : `${sum.done} בוצעו`) : '',
                    sum.deferred ? (sum.deferred === 1 ? 'חזרה אחת נדחתה' : `${sum.deferred} נדחו`) : '',
                    sum.planned ? (sum.planned === 1 ? 'חזרה אחת מתוכננת' : `${sum.planned} מתוכננות`) : '',
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'אין חזרות בחודש הזה'}
                </div>
              )}
            </div>
            <div className="row" style={{ gap: 6 }}>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => {
                  setYm(ymOf(today));
                  setSel(today);
                }}
                disabled={month === ymKey(ymOf(today)) && sel === today}
              >
                היום
              </button>
              <button type="button" className="btn sm" onClick={() => setYm(shift(ym, 1))} aria-label="החודש הבא">
                הבא ←
              </button>
            </div>
          </div>
          {grid.error && <ErrorBox error={grid.error} retry={grid.reload} />}
          <div style={{ opacity: grid.loading ? 0.55 : 1, transition: 'opacity 150ms' }}>
            <MonthGrid cells={cells} month={month} byDate={byDate} today={today} sel={sel} cap={cap} onSelect={select} />
          </div>
          <div style={{ marginTop: 12 }} className="stack">
            <CalLegend cap={cap} />
            <p className="tiny muted">המספרים בימים הבאים לפי מועדי החזרה הנוכחיים — הם יזוזו לפי התשובות שלך.</p>
          </div>
        </section>
        <DayDetail date={sel} today={today} />
      </div>
    </div>
  );
}

function Head() {
  return (
    <div className="page-head" style={{ marginBottom: 0 }}>
      <div>
        <h1>לוח חזרות</h1>
        <p>מה מתוכנן, מה באיחור ומה כבר נעשה — יום אחרי יום.</p>
      </div>
    </div>
  );
}
