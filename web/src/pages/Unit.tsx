import { Fragment, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../App.tsx';
import { LinkModal, QuestionModal, UnitModal } from '../editors.tsx';
import { Link } from '../router.tsx';
import {
  ClozeText,
  ConfidenceDot,
  Empty,
  ErrorBox,
  GradeBadge,
  Loading,
  ProvenanceBadge,
  SourceLinkView,
  StatusBadge,
  StructureView,
  mmss,
  useLoad,
  useToast,
  useUndoToast,
} from '../ui.tsx';
import type { CourseTreeDTO, QuestionDTO, UnitDetailDTO } from '../../../shared/api.ts';
import { daysBetween } from '../../../shared/dates.ts';
import {
  CONFIDENCE_LABELS,
  ERROR_LABELS,
  IMPORTANCE_LABELS,
  KIND_LABELS,
  formatDate,
  formatDays,
  formatIn,
} from '../../../shared/labels.ts';

type ModalState =
  | { kind: 'edit' }
  | { kind: 'question'; question?: QuestionDTO }
  | { kind: 'link'; entityType: 'unit' | 'question'; entityId: number; role: 'supports' | 'contradicts' }
  | null;

export default function UnitPage({ unitId }: { unitId: number }) {
  const { boot, refresh } = useApp();
  const detail = useLoad<UnitDetailDTO>(`/units/${unitId}`);
  const [modal, setModal] = useState<ModalState>(null);
  const toast = useToast();
  const reload = async () => {
    await detail.reload();
    void refresh();
  };
  const undo = useUndoToast(() => void reload());
  const courseId = detail.data?.course.id ?? null;
  const tree = useLoad<CourseTreeDTO>(courseId ? `/courses/${courseId}/tree` : null, [courseId]);

  if (detail.error) return <ErrorBox error={detail.error} retry={detail.reload} />;
  if (!detail.data) return <Loading />;
  const d = detail.data;
  const u = d.unit;

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      const log = await api.get<{ id: number }[]>('/audit?limit=1');
      undo(msg, log[0]?.id);
      await reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const dueIn = u.dueDate ? daysBetween(boot.today, u.dueDate) : null;

  return (
    <div className="stack-lg">
      <div>
        <div className="crumbs">
          <Link to={`/topics/${d.course.id}`}>{d.course.name}</Link> ›{d.parentTopic && <> {d.parentTopic.name} ›</>} {d.topic.name}
        </div>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1 dir="auto">{u.title}</h1>
            {u.content && (
              <p className="pre" dir="auto" style={{ color: 'var(--ink-2)' }}>
                {u.content}
              </p>
            )}
          </div>
          <div className="row">
            <button className="btn" onClick={() => setModal({ kind: 'edit' })} disabled={!tree.data}>
              עריכה
            </button>
            {u.status === 'active' && (
              <button className="btn ghost" onClick={() => act(() => api.put(`/units/${u.id}`, { status: 'suspended' }), 'היחידה הושהתה')}>
                השהה
              </button>
            )}
            {(u.status === 'suspended' || u.status === 'archived') && (
              <button className="btn" onClick={() => act(() => api.put(`/units/${u.id}`, { status: 'active' }), 'היחידה הופעלה')}>
                הפעל
              </button>
            )}
            {u.status === 'proposed' && (
              <button className="btn primary" onClick={() => act(() => api.post(`/units/${u.id}/approve`), 'היחידה אושרה')}>
                אשר יחידה
              </button>
            )}
            {u.status !== 'archived' && (
              <button className="btn ghost danger" onClick={() => act(() => api.put(`/units/${u.id}`, { status: 'archived' }), 'היחידה הועברה לארכיון')}>
                לארכיון
              </button>
            )}
          </div>
        </div>
      </div>

      {u.status !== 'active' && (
        <div className="callout warn">
          {u.status === 'suspended' && 'היחידה מושהית — היא לא תופיע בחזרות עד שתפעיל אותה. ההיסטוריה נשמרת.'}
          {u.status === 'archived' && 'היחידה בארכיון. שום דבר לא נמחק; אפשר להפעיל אותה מחדש.'}
          {u.status === 'proposed' && 'זו יחידה מוצעת. היא לא תיכנס לחזרות עד שתאשר אותה ולפחות שאלה אחת שלה.'}
        </div>
      )}

      <div className="grid-2">
        <div className="stack-lg">
          <Questions d={d} onModal={setModal} onChanged={reload} />
          <History d={d} onChanged={reload} />
        </div>
        <aside className="stack">
          <div className="card flat stack">
            <div className="card-title">
              <h3>תזמון</h3>
              <span className="row small">
                <ConfidenceDot c={u.confidence} /> ביטחון {CONFIDENCE_LABELS[u.confidence]}
              </span>
            </div>
            {u.status === 'active' && u.dueDate ? (
              <div>
                <div className="small muted">החזרה הבאה</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>
                  {formatDate(u.dueDate, true)}
                </div>
                <div className="small" style={dueIn !== null && dueIn < 0 ? { color: 'var(--partial)' } : { color: 'var(--soft)' }}>
                  {dueIn !== null && dueIn < 0 ? `באיחור של ${formatDays(-dueIn)}` : formatIn(dueIn ?? 0)}
                  {u.intervalDays ? ` · מרווח נוכחי ${formatDays(u.intervalDays)}` : ''}
                </div>
              </div>
            ) : (
              <div className="small muted">לא מתוזמנת כרגע.</div>
            )}
            <Ladder step={u.step} ladder={boot.settings.ladder} />
            {u.scheduleReason && (
              <div className="stack" style={{ gap: 4 }}>
                <div className="section-label">למה התאריך הזה</div>
                <ul className="small" style={{ margin: 0, paddingInlineStart: 18 }}>
                  {u.scheduleReason.lines.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="small muted">
              {u.reps} חזרות · {u.lapses} כישלונות · נלמד ב־{formatDate(u.learnedOn)}
              {d.lesson ? ` (${d.lesson.title})` : ''}
            </div>
            <div className="row small">
              <span className="badge outline">חשיבות: {IMPORTANCE_LABELS[u.importance]}</span>
              {u.foundational && <span className="badge easy">ידע בסיס</span>}
              {u.createdBy !== 'user' && <span className="badge">{u.createdBy === 'ai' ? 'הוצע ע״י AI' : u.createdBy === 'quizlet' ? 'מ־Quizlet' : 'מהסילבוס'}</span>}
            </div>
            {u.reps > 0 && (
              <button
                className="linkbtn small"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => act(() => api.post(`/units/${u.id}/restart`), 'התזמון התחיל מחדש')}
                title="לחומר שצריך ללמוד מחדש מההתחלה. ההיסטוריה נשמרת."
              >
                ללמוד מחדש — להתחיל את התזמון מהתחלה
              </button>
            )}
          </div>

          {(u.remediation || u.lapses >= 2) && <Remediation d={d} />}

          <div className="card flat stack">
            <div className="card-title">
              <h3>מקורות</h3>
              <div className="row">
                <button className="btn sm" onClick={() => setModal({ kind: 'link', entityType: 'unit', entityId: u.id, role: 'supports' })}>
                  + מקור
                </button>
                <button className="btn sm ghost" onClick={() => setModal({ kind: 'link', entityType: 'unit', entityId: u.id, role: 'contradicts' })}>
                  סמן סתירה
                </button>
              </div>
            </div>
            {d.links.length === 0 && (
              <div className="callout warn small">אין ליחידה מקור מתועד. בלי מקור היא מוצגת כ"לא מאומתת".</div>
            )}
            {d.links.map((l) => (
              <div key={l.id} className="stack" style={{ gap: 4 }}>
                <SourceLinkView l={l} />
                <div className="row">
                  {l.role === 'contradicts' && !l.resolved && (
                    <button
                      className="btn sm"
                      onClick={() => {
                        const note = window.prompt('איך יושבה הסתירה? (למשל: לפי המצגת, הסיכום טעה)') ?? '';
                        void act(() => api.post(`/links/${l.id}/resolve`, { note }), 'הסתירה יושבה');
                      }}
                    >
                      יישוב הסתירה
                    </button>
                  )}
                  <button className="btn sm ghost danger" onClick={() => act(() => api.del(`/links/${l.id}`), 'הקישור הוסר')}>
                    הסר
                  </button>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {modal?.kind === 'edit' && tree.data && (
        <UnitModal
          courseId={d.course.id}
          topics={tree.data.topics}
          lessons={tree.data.lessons}
          unit={u}
          today={boot.today}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void act(async () => {}, 'היחידה עודכנה');
          }}
        />
      )}
      {modal?.kind === 'question' && (
        <QuestionModal
          unitId={u.id}
          question={modal.question}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void act(async () => {}, modal.question ? 'השאלה עודכנה' : 'השאלה נוספה');
          }}
        />
      )}
      {modal?.kind === 'link' && (
        <LinkModal
          courseId={d.course.id}
          entityType={modal.entityType}
          entityId={modal.entityId}
          role={modal.role}
          initialQuery={u.title}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            void act(async () => {}, modal.role === 'contradicts' ? 'הסתירה סומנה' : 'המקור קושר');
          }}
        />
      )}
    </div>
  );
}

function Ladder({ step, ladder }: { step: number; ladder: number[] }) {
  return (
    <div className="stack" style={{ gap: 4 }} aria-label="שלב המרווח">
      <div className="row" style={{ gap: 3 }}>
        {ladder.map((d, i) => (
          <span
            key={i}
            title={formatDays(d)}
            style={{
              flex: 1,
              height: 6,
              borderRadius: 3,
              background: i <= step ? 'var(--accent)' : 'var(--line)',
            }}
          />
        ))}
      </div>
      <div className="row-between tiny muted">
        <span>{formatDays(ladder[0])}</span>
        <span>{formatDays(ladder[ladder.length - 1])}</span>
      </div>
    </div>
  );
}

function Questions({ d, onModal, onChanged }: { d: UnitDetailDTO; onModal: (m: ModalState) => void; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [verified, setVerified] = useState<Record<number, boolean>>({});
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.info(msg);
      await onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="card stack">
      <div className="card-title">
        <h2>שאלות</h2>
        <button className="btn sm primary" onClick={() => onModal({ kind: 'question' })}>
          + שאלה
        </button>
      </div>
      {d.questions.length === 0 && <Empty title="אין שאלות">בלי שאלה מאושרת היחידה לא תופיע בחזרות. הוסף שאלה אחת לפחות — מונח בצד אחד, תשובה והסבר בצד השני.</Empty>}
      {d.questions.map((q) => (
        <div key={q.id} className="card flat stack" style={{ gap: 8 }}>
          <div className="row">
            <span className="badge">{KIND_LABELS[q.kind]}</span>
            <StatusBadge s={q.status} />
            <ProvenanceBadge p={q.provenance} />
            {d.nextQuestion?.questionId === q.id && d.unit.status === 'active' && (
              <span className="badge accent" title={d.nextQuestion.why}>
                תישאל בפעם הבאה
              </span>
            )}
            {q.createdBy === 'ai' && <span className="badge outline">AI</span>}
            <span className="grow" />
            <span className="tiny muted">{q.lastAskedOn ? `נשאלה לאחרונה ${formatDate(q.lastAskedOn)}` : 'עוד לא נשאלה'}</span>
          </div>
          {q.flagReason && <div className="callout warn small">{q.flagReason}</div>}
          <div className="serif" style={{ fontSize: '1.1rem' }} dir="auto">
            {q.kind === 'cloze' ? <ClozeText text={q.prompt} reveal /> : q.prompt}
          </div>
          <div className="pre" dir="auto" style={{ color: 'var(--ink-2)' }}>
            {q.answer}
          </div>
          {q.structure && <StructureView s={q.structure} />}
          {q.keyPoints.length > 0 && (
            <ul className="small" style={{ margin: 0, paddingInlineStart: 18 }}>
              {q.keyPoints.map((k, i) => (
                <li key={i} dir="auto">
                  {k}
                </li>
              ))}
            </ul>
          )}
          {q.links.map((l) => (
            <SourceLinkView key={l.id} l={l} />
          ))}
          <div className="row">
            <button className="btn sm" onClick={() => onModal({ kind: 'question', question: q })}>
              עריכה
            </button>
            <button className="btn sm ghost" onClick={() => onModal({ kind: 'link', entityType: 'question', entityId: q.id, role: 'supports' })}>
              + מקור לשאלה
            </button>
            {q.status !== 'approved' && (
              <>
                {q.createdBy === 'ai' && (
                  <label className="check small">
                    <input type="checkbox" checked={!!verified[q.id]} onChange={(e) => setVerified({ ...verified, [q.id]: e.target.checked })} />
                    בדקתי מול המקור
                  </label>
                )}
                <button
                  className="btn sm primary"
                  disabled={q.createdBy === 'ai' && !verified[q.id]}
                  onClick={() => act(() => api.post(`/questions/${q.id}/approve`, { verified: !!verified[q.id] || q.createdBy !== 'ai' }), 'השאלה אושרה')}
                >
                  אשר
                </button>
              </>
            )}
            <button
              className="btn sm ghost danger"
              onClick={() => {
                const reason = window.prompt('למה לפסול? (לא חובה)') ?? undefined;
                if (reason === undefined) return;
                void act(() => api.post(`/questions/${q.id}/reject`, { reason }), 'השאלה נפסלה');
              }}
            >
              פסול
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function History({ d, onChanged }: { d: UnitDetailDTO; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState<number | null>(null);
  if (d.reviews.length === 0) {
    return (
      <div className="card flat">
        <h2>היסטוריית חזרות</h2>
        <p className="small muted" style={{ marginTop: 6 }}>
          עוד אין חזרות על היחידה.
        </p>
      </div>
    );
  }
  return (
    <div className="card flat">
      <div className="card-title">
        <h2>היסטוריית חזרות</h2>
        <span className="tiny muted">{d.reviews.length} ניסיונות</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>תאריך</th>
              <th>תוצאה</th>
              <th>שאלה</th>
              <th>אחרי</th>
              <th>זמן</th>
              <th>הבאה</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {d.reviews.map((r, i) => (
              <Fragment key={r.id}>
                <tr className="clickable" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <td className="nowrap num">{formatDate(r.localDate)}</td>
                  <td className="nowrap">
                    <span className="row" style={{ gap: 4 }}>
                      <GradeBadge g={r.effectiveGrade} hint={r.hintUsed} />
                      {r.isCorrection && <span className="badge outline">תיקון</span>}
                    </span>
                  </td>
                  <td className="small" dir="auto">
                    {r.questionKind ? `${KIND_LABELS[r.questionKind]}: ` : ''}
                    {(r.questionPrompt ?? '').replace(/\[\[[^\]]+\]\]/g, '___').slice(0, 60)}
                  </td>
                  <td className="nowrap small muted">{r.gapDays !== null ? formatDays(r.gapDays) : ''}</td>
                  <td className="nowrap small num muted">{r.totalMs ? mmss(r.totalMs / 1000) : ''}</td>
                  <td className="nowrap small">{r.newDue && !r.isCorrection ? formatDate(r.newDue) : ''}</td>
                  <td>
                    {i === 0 && r.auditId && (
                      <button
                        className="btn sm ghost"
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const res = await api.post<{ ok: boolean }>(`/audit/${r.auditId}/undo`);
                            if (!res.ok) throw new Error('אי אפשר לבטל — היחידה השתנתה מאז.');
                            toast.info('החזרה בוטלה והתזמון חזר למצבו הקודם');
                            await onChanged();
                          } catch (err) {
                            toast.error(err);
                          }
                        }}
                      >
                        בטל
                      </button>
                    )}
                  </td>
                </tr>
                {open === r.id && (
                  <tr>
                    <td colSpan={7}>
                      <div className="stack small" style={{ gap: 6 }}>
                        {r.appearedBecause.length > 0 && (
                          <div className="chips">
                            <span className="muted">הופיעה כי:</span>
                            {r.appearedBecause.map((a) => (
                              <span key={a.code} className="badge outline">
                                {a.text}
                              </span>
                            ))}
                          </div>
                        )}
                        {r.userAnswer && (
                          <div>
                            <span className="muted">התשובה שלך: </span>
                            <span dir="auto">{r.userAnswer}</span>
                          </div>
                        )}
                        {r.errorType && (
                          <div>
                            <span className="muted">סוג טעות: </span>
                            {ERROR_LABELS[r.errorType]}
                            {r.confusedWith ? ` (עם ${r.confusedWith})` : ''}
                          </div>
                        )}
                        {r.missingPoints.length > 0 && (
                          <div>
                            <span className="muted">חסר: </span>
                            {r.missingPoints.join(' · ')}
                          </div>
                        )}
                        {r.note && <div dir="auto">📝 {r.note}</div>}
                        {r.scheduleReason && (
                          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                            {r.scheduleReason.lines.map((l, j) => (
                              <li key={j}>{l}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The plan asks for a remediation suggestion when a unit keeps failing: go back to the source, not just retry. */
function Remediation({ d }: { d: UnitDetailDTO }) {
  const missing = new Map<string, number>();
  const confusions = new Map<string, number>();
  for (const r of d.reviews) {
    for (const m of r.missingPoints) missing.set(m, (missing.get(m) ?? 0) + 1);
    if (r.confusedWith) confusions.set(r.confusedWith, (confusions.get(r.confusedWith) ?? 0) + 1);
  }
  const sources = [...d.links, ...d.questions.flatMap((q) => q.links)].filter((l) => l.role === 'supports');
  return (
    <div className="card flat stack" style={{ borderColor: 'var(--wrong)' }}>
      <h3>הצעה ללמידת תיקון</h3>
      <p className="small">
        היחידה נכשלה {d.unit.lapses} פעמים. {d.unit.remediation ? 'המרווח מוגבל עד שתי הצלחות רצופות בלי רמז. ' : ''}חזרה נוספת על אותה שאלה לא תספיק — כדאי לחזור לחומר:
      </p>
      {sources.length > 0 ? (
        sources.slice(0, 3).map((l) => <SourceLinkView key={l.id} l={l} />)
      ) : (
        <div className="callout warn small">אין מקור מקושר. קשר מקור כדי שיהיה לאן לחזור.</div>
      )}
      {missing.size > 0 && (
        <div className="small">
          <div className="section-label">מה חסר שוב ושוב</div>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {[...missing].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([m, n]) => (
              <li key={m} dir="auto">
                {m} {n > 1 ? `(${n} פעמים)` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      {confusions.size > 0 && (
        <div className="small">
          <div className="section-label">מתבלבל עם</div>
          {[...confusions.keys()].join(' · ')} — שאלת השוואה בין המושגים יכולה לעזור.
        </div>
      )}
    </div>
  );
}
