// Progress: what is left in memory after a long gap comes first, then the
// habit (completion, time, deferrals, streak), then the charts, then the
// mistakes that keep coming back, then how trustworthy the material is.

import { useState, type ReactNode } from 'react';
import type { ProgressDTO } from '../../../shared/api.ts';
import { ERROR_LABELS, PROVENANCE_LABELS, formatDate } from '../../../shared/labels.ts';
import type { ErrorType, Provenance } from '../../../shared/types.ts';
import { useApp } from '../App.tsx';
import { Link } from '../router.tsx';
import { Empty, ErrorBox, Loading, pct, useLoad } from '../ui.tsx';
import { COLORS, PROGRESS_CSS } from './progress/charts.tsx';
import { DailyMinutesChart, DueDoneChart, GapBucketsChart, WeeklyTrendChart } from './progress/ProgressCharts.tsx';

/** Below this many reviews a retention percentage is noise, not a result. */
const FEW = 10;

const PROVENANCE_ORDER: Provenance[] = ['official', 'past_exam', 'generated', 'external', 'unverified'];

/** Days from learning a unit until its first review after a gap of at least `min` days, if every answer is right. */
function daysUntilGap(ladder: number[], min: number): number | null {
  let sum = 0;
  for (const step of ladder) {
    sum += step;
    if (step >= min) return sum;
  }
  return null;
}

export default function ProgressPage() {
  const { data, error, loading, reload } = useLoad<ProgressDTO>('/progress');
  const { boot } = useApp();

  if (!data) {
    return (
      <>
        <Head />
        {error ? <ErrorBox error={error} retry={reload} /> : <Loading />}
      </>
    );
  }

  const p = data;
  const hasReviews = p.totals.reviews > 0;
  const q = p.quality;
  const hasQuality = q.provenance.length > 0 || q.pending > 0 || q.flagged > 0 || q.openConflicts > 0 || q.unitsWithoutSource > 0;

  return (
    <div className="stack-lg" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity 150ms' }}>
      <style>{PROGRESS_CSS}</style>
      <Head since={hasReviews ? p.totals.firstDay : null} studyDays={p.totals.studyDays} />
      {error && <ErrorBox error={error} retry={reload} />}

      {hasReviews ? (
        <>
          <Retention p={p} ladder={boot.settings.ladder} />
          <Habit p={p} />
          <section aria-labelledby="pz-charts-h">
            <SectionHead id="pz-charts-h" title="לאורך זמן" hint="מעבר עם העכבר, נגיעה או חצים מציג ערכים מדויקים" />
            <div className="pz-charts">
              <GapBucketsChart buckets={p.buckets} />
              {p.weeks.some((w) => w.total > 0) && <WeeklyTrendChart weeks={p.weeks} />}
              <DailyMinutesChart daily={p.daily} budget={p.budgetMinutes} today={p.date} />
              <DueDoneChart daily={p.daily} today={p.date} />
            </div>
          </section>
          <Mistakes p={p} />
        </>
      ) : (
        <div className="card">
          <Empty title="עוד אין חזרות" action={<Link to="/today" className="btn primary">לסשן של היום</Link>}>
            אחרי הסשנים הראשונים יופיעו כאן אחוז ההצלחה אחרי מרווחים ארוכים — המדד העיקרי — ולצידו זמן הלימוד היומי, חזרות שנדחו וטעויות
            שחוזרות על עצמן.
            <FirstGapNote ladder={boot.settings.ladder} />
          </Empty>
        </div>
      )}

      {hasQuality && <Quality q={q} />}
    </div>
  );
}

function Head({ since, studyDays }: { since?: string | null; studyDays?: number }) {
  return (
    <div className="page-head" style={{ marginBottom: 0 }}>
      <div>
        <h1>התקדמות</h1>
        <p>
          מה נשאר בזיכרון אחרי מרווח ארוך, כמה זמן זה לוקח, ומה חוזר ונשכח.
          {since && studyDays ? ` ${studyDays} ימי לימוד מאז ${formatDate(since)}.` : ''}
        </p>
      </div>
    </div>
  );
}

function SectionHead({ id, title, hint }: { id: string; title: string; hint?: ReactNode }) {
  return (
    <div className="pz-section-head">
      <h2 id={id}>{title}</h2>
      {hint && <p>{hint}</p>}
    </div>
  );
}

function FirstGapNote({ ladder }: { ladder: number[] }) {
  const week = daysUntilGap(ladder, 7);
  const month = daysUntilGap(ladder, 30);
  if (!week) return null;
  return (
    <span className="small" style={{ display: 'block', marginTop: 8 }}>
      לפי לוח המרווחים הנוכחי, יחידה שעונים עליה נכון מגיעה לחזרה הראשונה אחרי מרווח של שבוע בערך {week} ימים אחרי הלמידה
      {month ? `, ולחזרה הראשונה אחרי מרווח של חודש — בערך ${month} ימים אחרי הלמידה` : ''}.
    </span>
  );
}

// ---------- 1. retention after long gaps ----------

function Retention({ p, ladder }: { p: ProgressDTO; ladder: number[] }) {
  const short = p.buckets.filter((b) => b.max <= 6);
  const shortTotal = short.reduce((s, b) => s + b.total, 0);
  const shortSuccess = short.reduce((s, b) => s + b.success, 0);
  return (
    <section aria-labelledby="pz-ret-h">
      <SectionHead id="pz-ret-h" title="מה נשאר בזיכרון" hint="המדד העיקרי: הצלחה בחזרה שמגיעה אחרי מרווח ארוך" />
      <div className="pz-hero">
        <RetentionTile title="זכירה אחרי שבוע ומעלה" gapText="7 ימים ומעלה" r={p.retentionWeek} firstIn={daysUntilGap(ladder, 7)} />
        <RetentionTile title="זכירה אחרי חודש ומעלה" gapText="30 ימים ומעלה" r={p.retentionMonth} firstIn={daysUntilGap(ladder, 30)} />
      </div>
      {shortTotal > 0 && (
        <p className="small muted" style={{ marginTop: 8 }}>
          לשם השוואה: אחרי מרווח של עד 6 ימים הצליחו <span className="num">{pct(shortSuccess / shortTotal)}</span> (
          <span className="num">{shortSuccess}</span> מתוך <span className="num">{shortTotal}</span>). הצלחה מיידית קלה יותר — היא לא המטרה.
        </p>
      )}
    </section>
  );
}

function RetentionTile({ title, gapText, r, firstIn }: { title: string; gapText: string; r: ProgressDTO['retentionWeek']; firstIn: number | null }) {
  const few = r.total > 0 && r.total < FEW;
  return (
    <div className="card">
      <div className="row-between">
        <span className="section-label" style={{ textTransform: 'none', letterSpacing: 0, fontSize: '0.9rem', color: 'var(--ink-2)' }}>
          {title}
        </span>
        {few && <span className="badge partial">מעט נתונים</span>}
      </div>
      {r.total === 0 ? (
        <>
          <div className="pz-hero-v few">עוד אין</div>
          <p className="small muted">
            עוד לא היו חזרות אחרי מרווח של {gapText}.{firstIn ? ` יחידה שעונים עליה נכון מגיעה לכך בערך ${firstIn} ימים אחרי הלמידה.` : ''}
          </p>
        </>
      ) : few ? (
        <>
          <div className="pz-hero-v few">
            <span className="num">{r.success}</span> מתוך <span className="num">{r.total}</span> הצליחו
          </div>
          <p className="small muted">
            אחרי מרווח של {gapText}. מתחת ל־{FEW} חזרות האחוז עוד לא אומר הרבה, אז הוא לא מוצג.
          </p>
        </>
      ) : (
        <>
          <div className="pz-hero-v" aria-label={`${pct(r.rate)} הצלחה`}>
            {pct(r.rate)}
          </div>
          <p className="small muted">
            <span className="num">{r.success}</span> מתוך <span className="num">{r.total}</span> חזרות אחרי מרווח של {gapText} הצליחו (נכון או קל מאוד).
          </p>
        </>
      )}
    </div>
  );
}

// ---------- 2. the habit ----------

function Habit({ p }: { p: ProgressDTO }) {
  const m = p.minutesPerActiveDay;
  const b = p.budgetMinutes;
  const ratio = b > 0 ? Math.min(1, m / b) : 0;
  return (
    <section aria-labelledby="pz-habit-h">
      <SectionHead id="pz-habit-h" title="ההרגל" hint="30 הימים האחרונים" />
      <div className="pz-kpis">
        <Kpi label="חזרות שבוצעו בזמן">
          <div className="v">{p.completion.due > 0 ? pct(p.completion.rate) : '—'}</div>
          <div className="l">
            {p.completion.due > 0 ? (
              <>
                <span className="num">{p.completion.done}</span> מתוך <span className="num">{p.completion.due}</span> שהיו מתוכננות לאותו יום
              </>
            ) : (
              'עוד אין יום שהסתיים עם חזרות מתוכננות'
            )}
          </div>
        </Kpi>
        <Kpi label="זמן ליום לימוד">
          <div className="v">
            {m} <small>דק׳</small>
          </div>
          <div className="pz-meter" role="img" aria-label={`${m} מתוך ${b} דקות`}>
            <div style={{ width: `${ratio * 100}%`, background: m > b ? COLORS.warn : COLORS.key }} />
          </div>
          <div className="l">
            מתוך תקציב של <span className="num">{b}</span> דק׳{m > b ? ' — מעל התקציב' : ''}
          </div>
        </Kpi>
        <Kpi label="חזרות שנדחו">
          <div className="v" style={p.deferred30 > 0 ? { color: 'var(--wrong)' } : undefined}>
            {p.deferred30}
          </div>
          <div className="l">{p.deferred30 > 0 ? 'נשארו בתור ועברו לימים הבאים — שום דבר לא נמחק' : 'שום חזרה לא נדחתה'}</div>
        </Kpi>
        <Kpi label="רצף">
          <div className="v">
            {p.totals.streak} <small>{p.totals.streak === 1 ? 'יום' : 'ימים'}</small>
          </div>
          <div className="l">
            {p.totals.streak > 0 ? 'ימי לימוד רצופים עד היום' : 'אין רצף פעיל — סשן היום יתחיל אחד'}
          </div>
        </Kpi>
      </div>
      {p.hintRate !== null && (
        <p className="small muted" style={{ marginTop: 8 }}>
          ב־<span className="num">{pct(p.hintRate)}</span> מהחזרות היה שימוש ברמז. תשובה עם רמז לא נחשבת הצלחה מלאה.
        </p>
      )}
    </section>
  );
}

function Kpi({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="card kpi pz-kpi">
      <span className="small" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>
        {label}
      </span>
      {children}
    </div>
  );
}

// ---------- 3. recurring mistakes ----------

function topErrors(counts: Partial<Record<ErrorType, number>>): [ErrorType, number][] {
  return (Object.entries(counts) as [ErrorType, number][]).sort((a, b) => b[1] - a[1]).slice(0, 2);
}

const TROUBLED_PREVIEW = 8;

function Mistakes({ p }: { p: ProgressDTO }) {
  const [all, setAll] = useState(false);
  const rows = all ? p.troubled : p.troubled.slice(0, TROUBLED_PREVIEW);
  const totalErrors = p.errors.reduce((s, e) => s + e.count, 0);
  const maxErr = Math.max(1, ...p.errors.map((e) => e.count));
  return (
    <section aria-labelledby="pz-mis-h">
      <SectionHead id="pz-mis-h" title="טעויות חוזרות" hint="יחידות שנכשלו פעמיים ומעלה, או שנמצאות בלמידת תיקון" />
      <div className="grid-2">
        <div className="card">
          {p.troubled.length === 0 ? (
            <p className="muted">אין כרגע יחידות שנכשלות שוב ושוב.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>יחידה</th>
                    <th>מצב</th>
                    <th>כישלונות</th>
                    <th>טעויות נפוצות</th>
                    <th>התבלבל עם</th>
                    <th>חזרה הבאה</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.unitId}>
                      <td style={{ minWidth: 160 }}>
                        <Link to={`/unit/${t.unitId}`}>{t.title}</Link>
                        <div className="tiny muted">{t.topicName}</div>
                      </td>
                      <td>{t.remediation ? <span className="badge wrong">למידת תיקון</span> : <span className="badge outline">במעקב</span>}</td>
                      <td className="num">{t.lapses}</td>
                      <td className="small">
                        {topErrors(t.errorCounts).length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          topErrors(t.errorCounts).map(([e, n]) => (
                            <div key={e} className="nowrap">
                              {ERROR_LABELS[e]} <span className="muted num">×{n}</span>
                            </div>
                          ))
                        )}
                      </td>
                      <td className="small">
                        {t.confusedWith.length === 0 ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            {t.confusedWith.slice(0, 3).join(' · ')}
                            {t.confusedWith.length > 3 && <span className="muted"> ועוד {t.confusedWith.length - 3}</span>}
                          </>
                        )}
                      </td>
                      <td className="small num nowrap">{t.dueDate ? formatDate(t.dueDate) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {p.troubled.length > TROUBLED_PREVIEW && (
                <button type="button" className="linkbtn small" style={{ marginTop: 8 }} onClick={() => setAll((v) => !v)}>
                  {all ? 'הצג פחות' : `הצג את כל ${p.troubled.length}`}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="card">
          <h3>סוגי טעויות</h3>
          <p className="small muted" style={{ marginBottom: 10 }}>
            ב־90 הימים האחרונים{totalErrors ? ` · ${totalErrors} טעויות מסווגות` : ''}
          </p>
          {p.errors.length === 0 ? (
            <p className="small muted">עוד לא סווגו טעויות. אחרי תשובה שגויה או חלקית אפשר לסמן מה קרה.</p>
          ) : (
            <div className="pz-hbars" role="list">
              {p.errors.map((e) => (
                <HBar key={e.errorType} label={ERROR_LABELS[e.errorType]} value={e.count} share={e.count / maxErr} color={COLORS.key} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function HBar({ label, value, share, color, icon }: { label: string; value: number; share: number; color: string; icon?: string }) {
  return (
    <div className="pz-hbar" role="listitem" aria-label={`${label}: ${value}`}>
      <span className="nowrap" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={label}>
        {icon && <span aria-hidden>{icon} </span>}
        {label}
      </span>
      <span className="track">
        <span className="fill" style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%`, background: color }} />
      </span>
      <span className="val">{value}</span>
    </div>
  );
}

// ---------- 4. source quality ----------

function Quality({ q }: { q: ProgressDTO['quality'] }) {
  const byProv = new Map(q.provenance.map((x) => [x.provenance, x.count]));
  const approved = q.provenance.reduce((s, x) => s + x.count, 0);
  const maxProv = Math.max(1, ...q.provenance.map((x) => x.count));
  const unverified = byProv.get('unverified') ?? 0;
  const aiDecided = q.aiApproved + q.aiRejected;
  return (
    <section aria-labelledby="pz-q-h">
      <SectionHead id="pz-q-h" title="איכות המקורות" hint="לכל שאלה צריך מקור מתועד; מה שלא נבדק לא מוצג כעובדה" />
      <div className="grid-2">
        <div className="card">
          <div className="row-between" style={{ marginBottom: 10 }}>
            <h3>שאלות מאושרות לפי מקור</h3>
            <span className="small muted num">{approved} שאלות</span>
          </div>
          {approved === 0 ? (
            <p className="small muted">עוד אין שאלות מאושרות.</p>
          ) : (
            <div className="pz-hbars" role="list">
              {PROVENANCE_ORDER.filter((pv) => byProv.has(pv)).map((pv) => (
                <HBar
                  key={pv}
                  label={PROVENANCE_LABELS[pv]}
                  value={byProv.get(pv) ?? 0}
                  share={(byProv.get(pv) ?? 0) / maxProv}
                  color={pv === 'unverified' ? COLORS.warn : COLORS.key}
                  icon={pv === 'unverified' ? '⚠' : undefined}
                />
              ))}
            </div>
          )}
          {unverified > 0 && (
            <div className="callout warn small" style={{ marginTop: 12 }}>
              ⚠ {unverified === 1 ? 'שאלה מאושרת אחת מסומנת' : `${unverified} שאלות מאושרות מסומנות`} "דורש בדיקה" — עדיין אין להן מקור מאומת.
            </div>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 4 }}>מה מחכה לבדיקה</h3>
          <QStat label="שאלות שממתינות לאישור" n={q.pending} to="/review" />
          <QStat label="שאלות שסומנו לבדיקה" n={q.flagged} to="/review" warn />
          <QStat label="סתירות פתוחות בין מקורות" n={q.openConflicts} to="/review" warn />
          <QStat label="יחידות בלי מקור מתועד" n={q.unitsWithoutSource} to="/topics" warn linkText="לנושאים" />
          <div className="pz-stat">
            <span>הצעות AI</span>
            <span className="small num">
              {aiDecided === 0 ? (
                <span className="muted">עוד לא הוכרעו</span>
              ) : (
                <>
                  <span className="badge correct">{q.aiApproved} אושרו</span> <span className="badge wrong">{q.aiRejected} נפסלו</span>
                </>
              )}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function QStat({ label, n, to, warn, linkText = 'לבדיקה' }: { label: string; n: number; to: string; warn?: boolean; linkText?: string }) {
  return (
    <div className="pz-stat">
      <span>{label}</span>
      <span className="row" style={{ gap: 10 }}>
        <span className={`badge ${n === 0 ? 'outline' : warn ? 'warn' : 'accent'} num`}>{n}</span>
        {n > 0 && (
          <Link to={to} className="small">
            {linkText} ←
          </Link>
        )}
      </span>
    </div>
  );
}
