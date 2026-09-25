import { useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../App.tsx';
import { MergeModal, QuestionModal } from '../editors.tsx';
import { Link } from '../router.tsx';
import { ClozeText, Empty, ErrorBox, Loading, ProvenanceBadge, SourceLinkView, StatusBadge, StructureView, useLoad, useToast } from '../ui.tsx';
import type { ChunkDTO, CourseTreeDTO, LinkDTO, QuestionDTO, ReviewQueueDTO, TopicDTO, ValidationReport } from '../../../shared/api.ts';
import { KIND_LABELS } from '../../../shared/labels.ts';

type Tab = 'units' | 'pending' | 'topics' | 'flagged' | 'conflicts';

export default function ReviewPage() {
  const { refresh } = useApp();
  const q = useLoad<ReviewQueueDTO>('/review-queue');
  const [tab, setTab] = useState<Tab | null>(null);
  const reload = async () => {
    await q.reload();
    void refresh();
  };
  if (q.error) return <ErrorBox error={q.error} retry={q.reload} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const pendingCount = d.pendingInActive.reduce((s, x) => s + x.pending.length, 0);
  const flaggedCount = d.pendingInActive.reduce((s, x) => s + x.flagged.length, 0) + d.units.reduce((s, u) => s + u.questions.filter((x) => x.status === 'flagged').length, 0);
  const tabs: { id: Tab; label: string; n: number }[] = [
    { id: 'units', label: 'יחידות ושאלות מוצעות', n: d.units.length },
    { id: 'pending', label: 'שאלות ממתינות', n: pendingCount },
    { id: 'topics', label: 'נושאים מוצעים', n: d.topics.length },
    { id: 'flagged', label: 'מסומנות לבדיקה', n: flaggedCount },
    { id: 'conflicts', label: 'סתירות בין מקורות', n: d.conflicts.length },
  ];
  const active = tab ?? tabs.find((t) => t.n > 0)?.id ?? 'units';
  const total = tabs.reduce((s, t) => s + t.n, 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>בדיקה ואישור</h1>
          <p>שום דבר שלא כתבת בעצמך לא נכנס לחזרות לפני שבדקת אותו מול המקור ואישרת.</p>
        </div>
      </div>
      {d.sourcesAwaiting > 0 && (
        <div className="callout info small" style={{ marginBottom: 16 }}>
          {d.sourcesAwaiting} מקורות חולצו ומחכים לאישור ב<Link to="/import">מסך הייבוא</Link> — משם אפשר לבקש הצעות לנושאים ולשאלות.
        </div>
      )}
      {total === 0 ? (
        <div className="card">
          <Empty title="אין מה לבדוק">הצעות לנושאים ולשאלות יופיעו כאן אחרי שתבקש אותן ממקור שאושר, וכך גם שאלות שסומנו כלא ברורות וסתירות בין מקורות.</Empty>
        </div>
      ) : (
        <>
          <div className="tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} className={active === t.id ? 'on' : ''} onClick={() => setTab(t.id)} role="tab" aria-selected={active === t.id}>
                {t.label} {t.n > 0 && <span className="badge">{t.n}</span>}
              </button>
            ))}
          </div>
          {active === 'units' && <UnitsTab d={d} onChanged={reload} />}
          {active === 'pending' && <PendingTab d={d} onChanged={reload} />}
          {active === 'topics' && <TopicsTab d={d} onChanged={reload} />}
          {active === 'flagged' && <FlaggedTab d={d} onChanged={reload} />}
          {active === 'conflicts' && <ConflictsTab d={d} onChanged={reload} />}
        </>
      )}
    </div>
  );
}

function Checks({ v }: { v: ValidationReport | null }) {
  if (!v) return null;
  const bad = v.checks.filter((c) => !c.ok);
  if (bad.length === 0) return <div className="tiny" style={{ color: 'var(--correct)' }}>✓ עבר את בדיקות המקור ({v.checks.length})</div>;
  return (
    <div className="stack" style={{ gap: 2 }}>
      {bad.map((c, i) => {
        const hard = !c.code.startsWith('warn');
        return (
          <div key={i} className="tiny" style={{ color: hard ? 'var(--wrong)' : 'var(--warn)' }}>
            {hard ? '✗' : '⚠'} {c.message}
          </div>
        );
      })}
    </div>
  );
}

function Evidence({ l }: { l: LinkDTO }) {
  const [ctx, setCtx] = useState<ChunkDTO | null>(null);
  const [open, setOpen] = useState(false);
  const show = async () => {
    setOpen(!open);
    if (!ctx && l.chunkId) setCtx(await api.get<ChunkDTO>(`/chunks/${l.chunkId}`));
  };
  return (
    <div className="stack" style={{ gap: 4 }}>
      <SourceLinkView l={l} />
      {l.chunkId && (
        <button className="linkbtn tiny" style={{ alignSelf: 'flex-start' }} onClick={() => void show()}>
          {open ? 'הסתר הקשר' : 'הצג את הקטע המלא'}
        </button>
      )}
      {open && ctx && <Highlighted text={ctx.text} quote={l.quote} />}
    </div>
  );
}

function Highlighted({ text, quote }: { text: string; quote: string | null }) {
  const i = quote ? text.indexOf(quote.trim()) : -1;
  return (
    <div className="quote small" dir="auto" style={{ maxHeight: 260, overflowY: 'auto' }}>
      {i < 0 ? (
        <>
          {quote && <div className="tiny" style={{ color: 'var(--warn)' }}>הציטוט לא נמצא מילה במילה בקטע — בדוק בעיון.</div>}
          {text}
        </>
      ) : (
        <>
          {text.slice(0, i)}
          <mark>{text.slice(i, i + quote!.trim().length)}</mark>
          {text.slice(i + quote!.trim().length)}
        </>
      )}
    </div>
  );
}

function QuestionReview({ q, onChanged }: { q: QuestionDTO; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [verified, setVerified] = useState(false);
  const [editing, setEditing] = useState(false);
  const needsCheck = q.createdBy === 'ai';
  const failed = q.validation !== null && !q.validation.ok;
  const approve = async (override = false) => {
    try {
      await api.post(`/questions/${q.id}/approve`, { verified: verified || !needsCheck, override });
      toast.info('השאלה אושרה ונכנסה לחזרות');
      await onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="card flat stack" style={{ gap: 8 }}>
      <div className="row">
        <span className="badge">{KIND_LABELS[q.kind]}</span>
        <StatusBadge s={q.status} />
        <ProvenanceBadge p={q.provenance} />
        {q.createdBy === 'ai' && <span className="badge outline">הוצע ע״י AI</span>}
        {q.createdBy === 'quizlet' && <span className="badge outline">Quizlet</span>}
      </div>
      {q.flagReason && <div className="callout warn small">{q.flagReason}</div>}
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16 }}>
        <div className="stack" style={{ gap: 6 }}>
          <div className="serif" style={{ fontSize: '1.08rem' }} dir="auto">
            {q.kind === 'cloze' ? <ClozeText text={q.prompt} reveal /> : q.prompt}
          </div>
          <div className="pre small" dir="auto">
            {q.answer}
          </div>
          {q.explanation && (
            <div className="pre tiny muted" dir="auto">
              {q.explanation}
            </div>
          )}
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
          <Checks v={q.validation} />
        </div>
        <div className="stack" style={{ gap: 8 }}>
          <div className="section-label">המקור</div>
          {q.links.length === 0 ? <div className="callout warn small">אין מקור מצוטט.</div> : q.links.map((l) => <Evidence key={l.id} l={l} />)}
        </div>
      </div>
      <div className="row">
        {needsCheck && (
          <label className="check small">
            <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
            בדקתי מול המקור והתשובה נכונה
          </label>
        )}
        <button className="btn sm primary" disabled={needsCheck && !verified} onClick={() => void approve(false)}>
          אשר
        </button>
        {failed && (
          <button className="btn sm" disabled={needsCheck && !verified} onClick={() => void approve(true)} title="בדיקת המקור נכשלה — אשר רק אם וידאת בעצמך">
            אשר למרות הבדיקה
          </button>
        )}
        <button className="btn sm" onClick={() => setEditing(true)}>
          ערוך
        </button>
        <button
          className="btn sm ghost danger"
          onClick={async () => {
            const reason = window.prompt('למה לפסול? (לא חובה)');
            if (reason === null) return;
            try {
              await api.post(`/questions/${q.id}/reject`, { reason });
              toast.info('השאלה נפסלה');
              await onChanged();
            } catch (e) {
              toast.error(e);
            }
          }}
        >
          פסול
        </button>
      </div>
      {editing && (
        <QuestionModal
          unitId={q.unitId}
          question={q}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void onChanged();
          }}
        />
      )}
    </div>
  );
}

function UnitsTab({ d, onChanged }: { d: ReviewQueueDTO; onChanged: () => Promise<void> }) {
  const toast = useToast();
  if (d.units.length === 0) return <Empty title="אין יחידות מוצעות" />;
  return (
    <div className="stack-lg">
      {d.units.map((p) => (
        <div key={p.unit.id} className="card stack">
          <div className="row-between">
            <div className="stack" style={{ gap: 2 }}>
              <div className="row">
                <h2 dir="auto">{p.unit.title}</h2>
                <span className="badge dashed">יחידה מוצעת</span>
              </div>
              <div className="small muted">
                {p.courseName} › {p.topicName} {p.topicProposed && <span className="badge dashed">נושא מוצע</span>}
              </div>
            </div>
            <div className="row">
              <Link to={`/unit/${p.unit.id}`} className="btn sm ghost">
                לעמוד היחידה
              </Link>
              <button
                className="btn sm ghost danger"
                onClick={async () => {
                  try {
                    await api.post(`/units/${p.unit.id}/reject`);
                    toast.info('היחידה והשאלות שלה נפסלו');
                    await onChanged();
                  } catch (e) {
                    toast.error(e);
                  }
                }}
              >
                פסול יחידה
              </button>
            </div>
          </div>
          {p.content && (
            <p className="pre" dir="auto">
              {p.content}
            </p>
          )}
          <Checks v={p.validation} />
          {p.links.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              {p.links.map((l) => (
                <Evidence key={l.id} l={l} />
              ))}
            </div>
          )}
          {p.questions.length === 0 && <p className="small muted">אין שאלות מוצעות ליחידה.</p>}
          {p.questions.map((q) => (
            <QuestionReview key={q.id} q={q} onChanged={onChanged} />
          ))}
          <p className="tiny muted">אישור שאלה מאשר גם את היחידה, והחזרה הראשונה נקבעת לתאריך הלמידה.</p>
        </div>
      ))}
    </div>
  );
}

function PendingTab({ d, onChanged }: { d: ReviewQueueDTO; onChanged: () => Promise<void> }) {
  const groups = d.pendingInActive.filter((g) => g.pending.length > 0);
  const toast = useToast();
  if (groups.length === 0) return <Empty title="אין שאלות ממתינות ביחידות קיימות" />;
  return (
    <div className="stack-lg">
      {groups.map((g) => {
        const own = g.pending.filter((q) => q.createdBy !== 'ai');
        return (
          <div key={g.unit.id} className="card stack">
            <div className="row-between">
              <Link to={`/unit/${g.unit.id}`}>
                <h2 dir="auto">{g.unit.title}</h2>
              </Link>
              {own.length > 1 && (
                <button
                  className="btn sm"
                  onClick={async () => {
                    const r = await api.post<{ done: number; errors: { error: string }[] }>('/questions/bulk', { ids: own.map((q) => q.id), action: 'approve' });
                    toast.info(`${r.done} שאלות אושרו${r.errors.length ? ` · ${r.errors.length} נכשלו` : ''}`);
                    await onChanged();
                  }}
                >
                  אשר את {own.length} השאלות שלי
                </button>
              )}
            </div>
            {g.pending.map((q) => (
              <QuestionReview key={q.id} q={q} onChanged={onChanged} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function FlaggedTab({ d, onChanged }: { d: ReviewQueueDTO; onChanged: () => Promise<void> }) {
  const items = [
    ...d.pendingInActive.flatMap((g) => g.flagged.map((q) => ({ q, title: g.unit.title, unitId: g.unit.id }))),
    ...d.units.flatMap((u) => u.questions.filter((q) => q.status === 'flagged').map((q) => ({ q, title: u.unit.title, unitId: u.unit.id }))),
  ];
  if (items.length === 0) return <Empty title="אין שאלות מסומנות">שאלה שסימנת כ"לא ברורה" בזמן חזרה, או שיש לה סתירה בין מקורות, מגיעה לכאן ויוצאת מהחזרות עד שמטפלים בה.</Empty>;
  return (
    <div className="stack">
      {items.map(({ q, title, unitId }) => (
        <div key={q.id} className="stack" style={{ gap: 4 }}>
          <Link to={`/unit/${unitId}`} className="small">
            {title}
          </Link>
          <QuestionReview q={q} onChanged={onChanged} />
        </div>
      ))}
    </div>
  );
}

function TopicsTab({ d, onChanged }: { d: ReviewQueueDTO; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [merge, setMerge] = useState<TopicDTO | null>(null);
  const courseId = merge?.courseId ?? null;
  const tree = useLoad<CourseTreeDTO>(courseId ? `/courses/${courseId}/tree` : null, [courseId]);
  if (d.topics.length === 0) return <Empty title="אין נושאים מוצעים" />;
  const act = async (id: number, a: 'approve' | 'reject') => {
    try {
      await api.post(`/topics/${id}/${a}`);
      toast.info(a === 'approve' ? 'הנושא נוסף למפה' : 'הנושא נפסל');
      await onChanged();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="stack">
      <div className="callout info small">
        נושאים מהסילבוס הם מפת ציפיות, לא אמת מוחלטת. המבנה הסופי נקבע לפי מה שנלמד בפועל — אפשר לאשר, לאחד עם נושא קיים בשם אחר, או לפסול.
      </div>
      {d.topics.map((t) => (
        <div key={t.id} className="card flat stack" style={{ gap: 6 }}>
          <div className="row-between">
            <div className="row">
              {t.syllabusOrder !== null && <span className="badge outline num">#{t.syllabusOrder}</span>}
              <strong>{t.name}</strong>
              <span className="small muted">{t.courseName}</span>
              <span className="badge dashed">{t.createdBy === 'syllabus' ? 'מהסילבוס' : 'הצעת AI'}</span>
            </div>
            <div className="row">
              <button className="btn sm primary" onClick={() => void act(t.id, 'approve')}>
                אשר
              </button>
              <button className="btn sm" onClick={() => setMerge(t)}>
                אחד עם נושא קיים
              </button>
              <button className="btn sm ghost danger" onClick={() => void act(t.id, 'reject')}>
                פסול
              </button>
            </div>
          </div>
          <Checks v={t.validation} />
          {t.links.map((l) => (
            <SourceLinkView key={l.id} l={l} compact />
          ))}
        </div>
      ))}
      {merge && tree.data && (
        <MergeModal
          topic={merge}
          topics={tree.data.topics}
          onClose={() => setMerge(null)}
          onDone={(m) => {
            setMerge(null);
            toast.info(m);
            void onChanged();
          }}
        />
      )}
    </div>
  );
}

function ConflictsTab({ d, onChanged }: { d: ReviewQueueDTO; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [notes, setNotes] = useState<Record<number, string>>({});
  if (d.conflicts.length === 0) return <Empty title="אין סתירות פתוחות" />;
  return (
    <div className="stack-lg">
      <div className="callout info small">
        כשמקורות סותרים זה את זה, השאלות הנוגעות בדבר יוצאות מהחזרות. בדוק מול חומר הקורס הרשמי, תקן את התשובה אם צריך, ורשום איך הוחלט.
      </div>
      {d.conflicts.map((c) => (
        <div key={c.link.id} className="card stack">
          <div className="row-between">
            <h3 dir="auto">{c.entityTitle}</h3>
            {c.unitId && (
              <Link to={`/unit/${c.unitId}`} className="btn sm ghost">
                לעמוד היחידה
              </Link>
            )}
          </div>
          {c.link.note && <div className="small">{c.link.note}</div>}
          <div className="grid-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16 }}>
            <div className="stack" style={{ gap: 6 }}>
              <div className="section-label">מה כתוב אצלנו</div>
              {c.content && (
                <div className="pre small" dir="auto">
                  {c.content}
                </div>
              )}
              {c.supporting.map((l) => (
                <Evidence key={l.id} l={l} />
              ))}
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <div className="section-label" style={{ color: 'var(--wrong)' }}>
                המקור הסותר
              </div>
              <Evidence l={c.link} />
            </div>
          </div>
          <div className="row">
            <input
              className="input grow"
              dir="auto"
              placeholder="איך הוחלט? (למשל: לפי המצגת; הסיכום טעה)"
              value={notes[c.link.id] ?? ''}
              onChange={(e) => setNotes({ ...notes, [c.link.id]: e.target.value })}
            />
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await api.post(`/links/${c.link.id}/resolve`, { note: notes[c.link.id] ?? '' });
                  toast.info('הסתירה יושבה והשאלות חזרו לחזרות');
                  await onChanged();
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              סמן כמיושב
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
