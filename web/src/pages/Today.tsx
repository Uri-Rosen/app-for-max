import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../App.tsx';
import { Link } from '../router.tsx';
import {
  ClozeText,
  ConfidenceDot,
  CourseChip,
  Empty,
  ErrorBox,
  HistoryDots,
  Loading,
  ProvenanceBadge,
  SourceLinkView,
  StructureView,
  mmss,
  useKey,
  useToast,
  useUndoToast,
} from '../ui.tsx';
import type { ReviewResultDTO, SessionItemDTO, TodayDTO } from '../../../shared/api.ts';
import { CONFIDENCE_LABELS, ERROR_LABELS, FIELD_LABELS, GRADE_LABELS, KIND_LABELS, PROVENANCE_LABELS, count, formatDate, formatDays, formatIn } from '../../../shared/labels.ts';
import { ERROR_TYPES, TEMPLATE_FIELDS, type ErrorType, type Grade } from '../../../shared/types.ts';

type Phase = 'ask' | 'reveal' | 'detail' | 'feedback';

export default function TodayPage() {
  const { boot, refresh } = useApp();
  const toast = useToast();
  const [today, setToday] = useState<TodayDTO | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [beyond, setBeyond] = useState(false);

  const load = useCallback(
    async (b = beyond) => {
      try {
        setToday(await api.get<TodayDTO>(`/today${b ? '?beyond=1' : ''}`));
        setError(null);
      } catch (e) {
        setError(e as Error);
      }
    },
    [beyond],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorBox error={error} retry={() => void load()} />;
  if (!today) return <Loading />;

  if (boot.courses.length === 0) return <Onboarding />;

  const current = today.queue[0] ?? (today.queue.length === 0 ? today.corrections[0] : undefined);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{formatDate(today.date, true)}</h1>
          <p>{headline(today)}</p>
        </div>
        <SessionMeter today={today} />
      </div>
      <div className="grid-2">
        <div className="study stack">
          {current ? (
            <StudyCard
              key={`${current.unitId}-${current.isCorrection ? 'c' : 'q'}-${current.question?.id}`}
              item={current}
              onDone={async () => {
                await load();
                void refresh();
              }}
              onError={toast.error}
            />
          ) : (
            <DoneCard
              today={today}
              onBeyond={() => {
                setBeyond(true);
                void load(true);
              }}
            />
          )}
          {today.lastReview && !current && <LastReviewUndo today={today} onUndone={() => void load()} />}
        </div>
        <SidePanel today={today} currentUnitId={current?.unitId ?? null} />
      </div>
    </div>
  );
}

function headline(t: TodayDTO): string {
  const left = t.queue.length + t.corrections.length;
  if (t.totalDue === 0 && t.spent.count === 0) return 'אין חזרות שהגיע מועדן היום.';
  if (left === 0) return t.deferred.length ? `סיימת את הסשן. ${t.deferred.length} חזרות נדחו להמשך — הן לא נעלמות.` : 'סיימת את החזרות של היום.';
  if (t.queue.length === 0) return `נשארה ${count(t.corrections.length, 'שאלת תיקון אחת', 'שאלות תיקון')} — אותן שאלות שנכשלו קודם, כדי לסגור את הפער כל עוד הוא טרי.`;
  const mins = Math.max(1, Math.round(t.estQueueSeconds / 60));
  return `${count(t.queue.length, 'שאלה אחת', 'שאלות')} בסשן, בערך ${count(mins, 'דקה', 'דקות')}${t.corrections.length ? ` · ${count(t.corrections.length, 'שאלת תיקון אחת', 'שאלות תיקון')} בסוף` : ''}.`;
}

function SessionMeter({ today }: { today: TodayDTO }) {
  const budget = today.settings.budgetMinutes * 60;
  const pctTime = Math.min(100, (today.spent.seconds / budget) * 100);
  const total = today.spent.count + today.queue.length;
  return (
    <div style={{ minWidth: 220 }} className="stack" aria-label="התקדמות הסשן">
      <div className="row-between small">
        <span className="num">
          {today.spent.count} מתוך {total || today.settings.maxItems} שאלות
        </span>
        <span className="num muted">
          <bdi>{mmss(today.spent.seconds)}</bdi> מתוך {today.settings.budgetMinutes} דק׳
        </span>
      </div>
      <div className="progressbar" title="זמן שנוצל מתוך התקציב היומי">
        <div style={{ width: `${pctTime}%` }} />
      </div>
    </div>
  );
}

// ---------- the study card ----------

function keyPointsOf(item: SessionItemDTO): string[] {
  const q = item.question!;
  const pts = [...q.keyPoints];
  if (q.structure) {
    for (const f of TEMPLATE_FIELDS[q.structure.template]) {
      const v = q.structure.fields[f];
      if (v) pts.push(`${FIELD_LABELS[f]}: ${v}`);
    }
  }
  return pts;
}

function StudyCard({ item, onDone, onError }: { item: SessionItemDTO; onDone: () => Promise<void>; onError: (e: unknown) => void }) {
  const q = item.question!;
  const [phase, setPhase] = useState<Phase>('ask');
  const [answer, setAnswer] = useState('');
  const [hint, setHint] = useState(false);
  const [why, setWhy] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [grade, setGrade] = useState<Grade | null>(null);
  const [errorType, setErrorType] = useState<ErrorType | null>(null);
  const [confusedWith, setConfusedWith] = useState('');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<ReviewResultDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(Date.now());
  const revealedAt = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const undo = useUndoToast(() => void onDone());

  useEffect(() => {
    const t = setInterval(() => setElapsed((Date.now() - started.current) / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    answerRef.current?.focus();
  }, []);

  const points = useMemo(() => keyPointsOf(item), [item]);
  const suggested: Grade | null = points.length === 0 ? null : checked.size === points.length ? 'correct' : checked.size === 0 ? 'wrong' : 'partial';
  const preview = hint ? item.previewHint : item.preview;

  const reveal = () => {
    if (phase !== 'ask') return;
    revealedAt.current = Date.now();
    setPhase('reveal');
  };

  const submit = async (g: Grade, extra: { errorType?: ErrorType | null } = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      const now = Date.now();
      const r = await api.post<ReviewResultDTO>('/reviews', {
        unitId: item.unitId,
        questionId: q.id,
        grade: g,
        hintUsed: hint,
        isCorrection: item.isCorrection,
        userAnswer: answer.trim() || null,
        answerMs: (revealedAt.current ?? now) - started.current,
        totalMs: now - started.current,
        errorType: extra.errorType ?? errorType,
        confusedWith: confusedWith.trim() || null,
        // Only when the checklist was used; an untouched list says nothing about what was missing.
        missingPoints: checked.size > 0 ? points.filter((_, i) => !checked.has(i)) : [],
        note: note.trim() || null,
      });
      setResult(r);
      setGrade(g);
      setPhase('feedback');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const pick = (g: Grade) => {
    if (phase !== 'reveal' && phase !== 'detail') return;
    if (g === 'wrong' || g === 'partial') {
      setGrade(g);
      setPhase('detail');
    } else void submit(g);
  };

  useKey(
    (e) => {
      if (phase === 'ask' && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        reveal();
      } else if (phase === 'ask' && (e.key === 'h' || e.key === 'ר') && q.hint) setHint(true);
      else if ((phase === 'reveal' || phase === 'detail') && ['1', '2', '3', '4'].includes(e.key)) {
        pick((['wrong', 'partial', 'correct', 'easy'] as const)[Number(e.key) - 1]);
      } else if (phase === 'feedback' && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        void onDone();
      }
    },
    [phase, hint, grade, busy],
  );

  return (
    <div className="card qcard" aria-live="polite">
      <div className="qmeta">
        {item.isCorrection && <span className="badge wrong">שאלת תיקון</span>}
        <CourseChip name={item.courseName} color={item.courseColor} />
        <span className="badge outline">{item.topicName}</span>
        <span className="badge">{KIND_LABELS[q.kind]}</span>
        {q.provenance === 'unverified' && <ProvenanceBadge p="unverified" />}
        <span className="grow" />
        <span className="tiny muted num" title="זמן על השאלה">
          {mmss(elapsed)}
        </span>
        <button className="linkbtn small" onClick={() => setWhy((w) => !w)} aria-expanded={why}>
          למה עכשיו?
        </button>
      </div>

      {why && (
        <div className="callout small stack" style={{ gap: 6, marginBottom: 12 }}>
          <div className="chips">
            {item.reasons.map((r) => (
              <span key={r.code} className={`badge ${r.code === 'failed_recently' || r.code === 'remediation' ? 'wrong' : r.code === 'overdue' ? 'partial' : 'outline'}`}>
                {r.text}
              </span>
            ))}
          </div>
          {item.questionWhy && <div>{item.questionWhy}</div>}
          <div className="row">
            <span className="muted">ניסיונות קודמים:</span> <HistoryDots items={item.history} />
            <span className="muted">· ביטחון:</span> <ConfidenceDot c={item.confidence} /> {CONFIDENCE_LABELS[item.confidence]}
            <span className="muted">· מועד:</span> {formatDate(item.dueDate)}
          </div>
          <Link to={`/unit/${item.unitId}`}>לעמוד היחידה ←</Link>
        </div>
      )}

      <div className="prompt" dir="auto">
        {q.kind === 'cloze' ? <ClozeText text={q.prompt} reveal={phase !== 'ask'} /> : q.prompt}
      </div>

      {phase === 'ask' ? (
        <div className="stack">
          <textarea
            ref={answerRef}
            className="input"
            dir="auto"
            rows={3}
            placeholder="נסה לענות לפני שאתה רואה את הפתרון — במילים שלך, גם בקצרה."
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) reveal();
            }}
          />
          {hint && q.hint && (
            <div className="callout warn small">
              <strong>רמז:</strong> {q.hint}
            </div>
          )}
          <div className="row">
            <button className="btn primary lg" onClick={reveal}>
              הצג תשובה <span className="kbd">Ctrl+Enter</span>
            </button>
            {q.hint && !hint && (
              <button className="btn ghost" onClick={() => setHint(true)} title="שימוש ברמז לא ייחשב הצלחה מלאה">
                רמז <span className="kbd">H</span>
              </button>
            )}
            {hint && <span className="tiny muted">השתמשת ברמז — תשובה נכונה תיחשב חלקית.</span>}
          </div>
        </div>
      ) : (
        <div className="stack">
          <hr className="divider" />
          {answer.trim() && (
            <div className="stack" style={{ gap: 4 }}>
              <div className="section-label">התשובה שלך</div>
              <div className="pre" dir="auto" style={{ color: 'var(--ink-2)' }}>
                {answer}
              </div>
            </div>
          )}
          <div className="stack" style={{ gap: 4 }}>
            <div className="section-label">התשובה הצפויה</div>
            <div className="answer-text" dir="auto">
              {q.answer}
            </div>
          </div>
          {q.structure && <StructureView s={q.structure} />}
          {q.explanation && (
            <div className="pre small" dir="auto" style={{ color: 'var(--ink-2)' }}>
              {q.explanation}
            </div>
          )}
          <Sources item={item} />

          {points.length > 0 && phase !== 'feedback' && (
            <div className="stack" style={{ gap: 6 }}>
              <div className="section-label">מה כללת בתשובה?</div>
              {points.map((p, i) => (
                <label key={i} className="check small">
                  <input
                    type="checkbox"
                    checked={checked.has(i)}
                    onChange={(e) =>
                      setChecked((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(i);
                        else n.delete(i);
                        return n;
                      })
                    }
                  />
                  <span dir="auto">{p}</span>
                </label>
              ))}
            </div>
          )}

          {(phase === 'reveal' || phase === 'detail') && (
            <div className="stack">
              <div className="row-between">
                <div className="section-label">עד כמה ידעת?</div>
                {suggested && <span className="tiny muted">לפי מה שסימנת: {GRADE_LABELS[suggested]}</span>}
              </div>
              <div className="grades">
                {(['wrong', 'partial', 'correct', 'easy'] as const).map((g, i) => (
                  <button
                    key={g}
                    className={`grade ${g} ${grade === g || (!grade && suggested === g) ? 'on' : ''}`}
                    onClick={() => pick(g)}
                    disabled={busy}
                  >
                    {GRADE_LABELS[g]}
                    <small>
                      {formatIn(preview[g])} · {i + 1}
                    </small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {phase === 'detail' && grade && (
            <div className="card flat stack" style={{ background: 'var(--surface-2)' }}>
              <div className="section-label">מה קרה? (לא חובה, עוזר לתקן)</div>
              <div className="chips" role="radiogroup">
                {ERROR_TYPES.map((t) => (
                  <button
                    key={t}
                    role="radio"
                    aria-checked={errorType === t}
                    className={`chip ${errorType === t ? 'on' : ''}`}
                    onClick={() => setErrorType(errorType === t ? null : t)}
                  >
                    {ERROR_LABELS[t]}
                  </button>
                ))}
              </div>
              {errorType === 'alt_phrasing' && <div className="tiny muted">ניסוח חלופי תקין ייחשב כתשובה נכונה.</div>}
              {errorType === 'unclear_question' && <div className="tiny muted">השאלה תסומן לבדיקה ולא תיחשב כישלון.</div>}
              {errorType === 'confusion' && (
                <input className="input" dir="auto" placeholder="עם איזה מושג התבלבלת?" value={confusedWith} onChange={(e) => setConfusedWith(e.target.value)} />
              )}
              <textarea className="input" dir="auto" rows={2} placeholder="מה היה חסר או לא מובן?" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row">
                <button className="btn primary" onClick={() => void submit(grade)} disabled={busy}>
                  שמור · {GRADE_LABELS[grade]}
                </button>
                <button className="btn ghost" onClick={() => setPhase('reveal')}>
                  חזרה
                </button>
              </div>
            </div>
          )}

          {phase === 'feedback' && result && (
            <Feedback
              item={item}
              result={result}
              onNext={() => void onDone()}
              onUndo={async () => {
                try {
                  const r = await api.post<{ ok: boolean }>(`/audit/${result.auditId}/undo`);
                  if (!r.ok) throw new Error('אי אפשר לבטל — היחידה השתנתה מאז.');
                  undo('הדירוג בוטל. אפשר לענות שוב.', null);
                  await onDone();
                } catch (e) {
                  onError(e);
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Sources({ item }: { item: SessionItemDTO }) {
  const q = item.question!;
  const links = q.links.filter((l) => l.role !== 'context');
  if (links.length === 0) {
    if (q.provenance === 'unverified') {
      return <div className="callout warn small">לשאלה הזו אין מקור מתועד — אל תתייחס אליה כעובדה מאומתת. אפשר להוסיף מקור בעמוד היחידה.</div>;
    }
    return (
      <div className="small muted">
        מקור: {PROVENANCE_LABELS[q.provenance]} (בלי הפניה לעמוד או שקופית — אפשר להוסיף בעמוד היחידה).
      </div>
    );
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="section-label">מקור</div>
      {links.map((l) => (
        <SourceLinkView key={l.id} l={l} />
      ))}
    </div>
  );
}

function Feedback({ item, result, onNext, onUndo }: { item: SessionItemDTO; result: ReviewResultDTO; onNext: () => void; onUndo: () => void }) {
  const cls = result.effectiveGrade === 'void' ? '' : result.effectiveGrade === 'wrong' ? 'bad' : result.effectiveGrade === 'partial' ? 'warn' : 'good';
  const nextBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => nextBtn.current?.focus(), []);
  return (
    <div className="stack">
      <div className={`callout ${cls} stack`} style={{ gap: 6 }}>
        <strong>{result.explanation.summary}</strong>
        {!item.isCorrection && (
          <div>
            החזרה הבאה: <strong>{formatDate(result.dueDate, true)}</strong> ({formatIn(result.intervalDays)})
          </div>
        )}
        <ul style={{ margin: 0, paddingInlineStart: 18 }} className="small">
          {result.explanation.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
      {result.correctionQueued && !item.isCorrection && (
        <div className="callout info small">שאלת תיקון קצרה תופיע בסוף הסשן, כדי לסגור את הפער כל עוד הוא טרי.</div>
      )}
      {result.remediation && (
        <div className="callout warn small">
          היחידה במצב תיקון: כדאי לפתוח את המקור ולקרוא שוב לפני החזרה הבאה. המרווח מוגבל עד שתי הצלחות רצופות.{' '}
          <Link to={`/unit/${item.unitId}`}>להצעת התיקון בעמוד היחידה ←</Link>
        </div>
      )}
      <div className="row">
        <button ref={nextBtn} className="btn primary lg" onClick={onNext}>
          הבא <span className="kbd">Enter</span>
        </button>
        {result.auditId && (
          <button className="btn ghost" onClick={onUndo} title="מחזיר את היחידה למצב שלפני הדירוג">
            טעיתי בדירוג — בטל
          </button>
        )}
      </div>
    </div>
  );
}

function DoneCard({ today, onBeyond }: { today: TodayDTO; onBeyond: () => void }) {
  if (today.totalDue === 0 && today.spent.count === 0) {
    return (
      <div className="card">
        <Empty title="אין חזרות להיום">
          {today.blocked.length
            ? 'יש יחידות שהגיע מועדן אבל אין להן שאלה מאושרת — ראה בצד.'
            : today.tomorrow.count
              ? `מחר מחכות ${today.tomorrow.count} חזרות.`
              : 'כשתוסיף יחידות ידע, החזרה הראשונה שלהן תופיע כאן ביום הלמידה.'}
        </Empty>
      </div>
    );
  }
  return (
    <div className="card stack">
      <h2>{today.deferred.length ? 'נגמר הזמן שהוקצב להיום' : 'סיימת להיום'}</h2>
      <p className="muted">
        ענית על {count(today.spent.count, 'שאלה אחת', 'שאלות')} ב־<bdi>{mmss(today.spent.seconds)}</bdi> דקות
        {today.spent.corrections ? `, ועוד ${count(today.spent.corrections, 'שאלת תיקון אחת', 'שאלות תיקון')}` : ''}.
      </p>
      {today.deferred.length > 0 && (
        <div className="callout warn stack" style={{ gap: 8 }}>
          <span>
            {today.deferred.length} חזרות לא נכנסו בתקציב ({today.deferred[0].deferReason}). הן נשארות בתור ויופיעו ראשונות מחר, לפי סדר העדיפויות.
          </span>
          <div>
            <button className="btn" onClick={onBeyond}>
              המשך בכל זאת
            </button>
          </div>
        </div>
      )}
      <div className="row small">
        <Link to="/calendar">ללוח החזרות</Link>
        <span className="muted">·</span>
        <Link to="/progress">להתקדמות</Link>
      </div>
    </div>
  );
}

function LastReviewUndo({ today, onUndone }: { today: TodayDTO; onUndone: () => void }) {
  const toast = useToast();
  const lr = today.lastReview!;
  if (!lr.auditId) return null;
  return (
    <div className="small muted row">
      דירוג אחרון: {lr.unitTitle} — {lr.summary}.
      <button
        className="linkbtn"
        onClick={async () => {
          try {
            const r = await api.post<{ ok: boolean }>(`/audit/${lr.auditId}/undo`);
            if (!r.ok) throw new Error('אי אפשר לבטל — היחידה השתנתה מאז.');
            toast.info('הדירוג בוטל');
            onUndone();
          } catch (e) {
            toast.error(e);
          }
        }}
      >
        בטל אותו
      </button>
    </div>
  );
}

// ---------- side panel ----------

function SidePanel({ today, currentUnitId }: { today: TodayDTO; currentUnitId: number | null }) {
  const [showDeferred, setShowDeferred] = useState(false);
  const upcoming = today.queue.filter((q) => q.unitId !== currentUnitId);
  const corrections = today.queue.length > 0 ? today.corrections : today.corrections.filter((c) => c.unitId !== currentUnitId);
  const evening = new Date(today.now).getHours() >= 17;
  return (
    <aside className="stack">
      {(upcoming.length > 0 || corrections.length > 0) && (
        <div className="card flat">
          <div className="card-title">
            <h3>בתור</h3>
            <span className="tiny muted num">{upcoming.length + corrections.length}</span>
          </div>
          <div className="list">
            {upcoming.slice(0, 12).map((q) => (
              <div key={q.unitId} className="list-item small">
                <ConfidenceDot c={q.confidence} />
                <span className="grow" dir="auto">
                  {q.unitTitle}
                </span>
                <span className="badge outline tiny">{q.reasons[0]?.text}</span>
              </div>
            ))}
            {corrections.map((c) => (
                <div key={`c${c.unitId}`} className="list-item small">
                  <span className="badge wrong tiny">תיקון</span>
                  <span className="grow" dir="auto">
                    {c.unitTitle}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {today.deferred.length > 0 && (
        <div className="card flat">
          <div className="card-title">
            <h3>נדחו להמשך</h3>
            <span className="badge partial num">{today.deferred.length}</span>
          </div>
          <p className="small muted">{today.deferred[0].deferReason}. הן לא נעלמות — מחר הן יקבלו עדיפות כחזרות באיחור.</p>
          <button className="linkbtn small" onClick={() => setShowDeferred((s) => !s)}>
            {showDeferred ? 'הסתר' : 'הצג את הרשימה'}
          </button>
          {showDeferred && (
            <div className="list" style={{ marginTop: 6 }}>
              {today.deferred.map((d) => (
                <Link key={d.unitId} to={`/unit/${d.unitId}`} className="list-item small clickable">
                  <span className="grow" dir="auto">
                    {d.unitTitle}
                  </span>
                  <span className="tiny muted">{d.reasons[0]?.text}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {today.blocked.length > 0 && (
        <div className="card flat">
          <div className="card-title">
            <h3>לא ניתן לשאול</h3>
            <span className="badge warn num">{today.blocked.length}</span>
          </div>
          <div className="list">
            {today.blocked.map((b) => (
              <Link key={b.unitId} to={`/unit/${b.unitId}`} className="list-item small clickable" title={b.reason}>
                <span className="grow stack" style={{ gap: 0 }}>
                  <span dir="auto">{b.title}</span>
                  <span className="tiny muted">{b.reason}</span>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="card flat" style={evening ? { borderColor: 'var(--accent)' } : undefined}>
        <div className="card-title">
          <h3>מחר · {formatDate(today.tomorrow.date)}</h3>
          <span className="tiny muted num">{count(today.tomorrow.count, 'חזרה אחת', 'חזרות')}</span>
        </div>
        {today.tomorrow.count === 0 ? (
          <p className="small muted">עוד לא מתוכננות חזרות למחר. תשובות של היום עשויות להוסיף.</p>
        ) : (
          <>
            <p className="small muted">
              בערך {count(Math.max(1, Math.round(today.tomorrow.estSeconds / 60)), 'דקה', 'דקות')}
              {today.tomorrow.overflow > 0 ? ` · ${today.tomorrow.overflow} מעבר למכסה` : ''}. התוכנית מתעדכנת לפי התשובות של היום.
            </p>
            {evening && (
              <div className="list" style={{ marginTop: 6 }}>
                {today.tomorrow.items.slice(0, 10).map((t) => (
                  <div key={t.unitId} className="list-item small">
                    <span className="grow" dir="auto">
                      {t.title}
                    </span>
                    <span className="tiny muted">{t.topicName}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <p className="tiny muted">
        מקשים: Ctrl+Enter — הצג תשובה (גם מתוך תיבת התשובה) · 1–4 — דירוג · H — רמז · Enter — הבא. המרווחים: {formatDays(1)}, {formatDays(3)}, {formatDays(7)} ועד {formatDays(120)}.
      </p>
    </aside>
  );
}

function Onboarding() {
  return (
    <div className="card stack-lg" style={{ maxWidth: 720 }}>
      <div className="stack">
        <h1>ברוך הבא</h1>
        <p className="muted">
          המערכת עוקבת אחרי כל יחידת ידע בנפרד ומחליטה מתי לחזור עליה לפי התשובות שלך. כל בוקר יחכה כאן סשן קצר של עד רבע שעה. הכל נשמר במחשב הזה בלבד.
        </p>
      </div>
      <ol className="stack" style={{ margin: 0, paddingInlineStart: 20 }}>
        <li>
          <strong>הוסף קורס</strong> — ב<Link to="/topics">נושאים</Link>. אפשר לציין תאריך מבחן ותיקייה שבה נמצאים חומרי הקורס.
        </li>
        <li>
          <strong>הכנס חומר</strong> — יחידות ושאלות ידנית בעמוד הנושאים, או <Link to="/import">ייבוא</Link> של כרטיסי Quizlet וקבצי הקורס.
        </li>
        <li>
          <strong>חזור מחר בבוקר</strong> — החזרה הראשונה של כל יחידה היא ביום הלמידה, ואחר כך המרווחים מתארכים.
        </li>
      </ol>
      <div className="row">
        <Link to="/topics" className="btn primary">
          הוסף קורס ראשון
        </Link>
        <Link to="/import" className="btn">
          ייבוא כרטיסים
        </Link>
      </div>
    </div>
  );
}
