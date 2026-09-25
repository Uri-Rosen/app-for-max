import { useMemo, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../App.tsx';
import { CourseModal, LessonModal, MergeModal, TopicModal, UnitModal } from '../editors.tsx';
import { Link, go } from '../router.tsx';
import { ConfidenceDot, Empty, ErrorBox, Loading, useLoad, useToast, useUndoToast } from '../ui.tsx';
import type { CourseDTO, CourseTreeDTO, LessonDTO, TopicDTO, UnitSummaryDTO } from '../../../shared/api.ts';
import { daysBetween } from '../../../shared/dates.ts';
import { formatDate, formatIn } from '../../../shared/labels.ts';

export default function TopicsPage({ courseId }: { courseId: number | null }) {
  const { boot } = useApp();
  if (courseId === null) return <CourseList />;
  const exists = boot.courses.some((c) => c.id === courseId);
  return exists ? <CourseView key={courseId} courseId={courseId} /> : <CourseList />;
}

function CourseList() {
  const { boot, refresh } = useApp();
  const [adding, setAdding] = useState(false);
  const archived = useLoad<CourseDTO[]>('/courses?all=1');
  const old = (archived.data ?? []).filter((c) => c.archived);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>קורסים ונושאים</h1>
          <p>קורס → נושאים → תתי־נושאים → יחידות ידע. שיעורים מקושרים לנושאים שנלמדו בהם.</p>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          + קורס חדש
        </button>
      </div>
      {boot.courses.length === 0 ? (
        <div className="card">
          <Empty title="עוד אין קורסים" action={<button className="btn primary" onClick={() => setAdding(true)}>הוסף קורס</button>}>
            כדאי להתחיל בקורס אחד — לאשר ידנית את מפת הנושאים והשאלות, להשתמש כחודש, ורק אז להוסיף את השאר.
          </Empty>
        </div>
      ) : (
        <div className="grid-cards">
          {boot.courses.map((c) => (
            <Link key={c.id} to={`/topics/${c.id}`} className="card" >
              <div className="stack" style={{ gap: 6, color: 'var(--ink)' }}>
                <div className="row">
                  <span className="swatch" style={{ background: c.color ?? 'var(--soft)', width: 12, height: 12 }} />
                  <h3 className="grow">{c.name}</h3>
                </div>
                <div className="small muted">
                  {c.stats.topics} נושאים · {c.stats.units} יחידות
                </div>
                <div className="row small">
                  {c.stats.due > 0 && <span className="badge accent">{c.stats.due} לחזרה היום</span>}
                  {c.stats.pending > 0 && <span className="badge warn">{c.stats.pending} לבדיקה</span>}
                  {c.examDate && <span className="badge outline">מבחן {formatDate(c.examDate)}</span>}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
      {old.length > 0 && (
        <details style={{ marginTop: 24 }}>
          <summary className="small muted">קורסים בארכיון ({old.length})</summary>
          <div className="list">
            {old.map((c) => (
              <div key={c.id} className="list-item small">
                <span className="grow">{c.name}</span>
                <button
                  className="btn sm"
                  onClick={async () => {
                    await api.put(`/courses/${c.id}`, { archived: false });
                    await refresh();
                    void archived.reload();
                  }}
                >
                  החזר מהארכיון
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
      {adding && (
        <CourseModal
          onClose={() => setAdding(false)}
          onSaved={async (c) => {
            setAdding(false);
            await refresh();
            go(`/topics/${c.id}`);
          }}
        />
      )}
    </div>
  );
}

type ModalState =
  | { kind: 'course' }
  | { kind: 'topic'; topic?: TopicDTO; parentId?: number | null }
  | { kind: 'merge'; topic: TopicDTO }
  | { kind: 'lesson'; lesson?: LessonDTO }
  | { kind: 'unit'; topicId?: number | null; lessonId?: number | null }
  | null;

function CourseView({ courseId }: { courseId: number }) {
  const { boot, refresh } = useApp();
  const tree = useLoad<CourseTreeDTO>(`/courses/${courseId}/tree`);
  const [tab, setTab] = useState<'map' | 'lessons' | 'merged'>('map');
  const [modal, setModal] = useState<ModalState>(null);
  const [filter, setFilter] = useState('');
  const toast = useToast();
  const undo = useUndoToast(() => void tree.reload());

  if (tree.error) return <ErrorBox error={tree.error} retry={tree.reload} />;
  if (!tree.data) return <Loading />;
  const { course, topics, units, lessons, merged } = tree.data;

  const after = async (msg?: string) => {
    setModal(null);
    await tree.reload();
    void refresh();
    if (msg) toast.info(msg);
  };

  const topicAction = async (t: TopicDTO, action: 'approve' | 'reject') => {
    try {
      await api.post(`/topics/${t.id}/${action}`);
      const log = await api.get<{ id: number }[]>('/audit?limit=1');
      undo(action === 'approve' ? `הנושא "${t.name}" אושר` : `הנושא "${t.name}" נפסל`, log[0]?.id);
      await tree.reload();
      void refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div>
      <div className="crumbs">
        <Link to="/topics">קורסים</Link> ›
      </div>
      <div className="page-head">
        <div>
          <h1 className="row">
            <span className="swatch" style={{ background: course.color ?? 'var(--soft)', width: 14, height: 14 }} />
            {course.name}
          </h1>
          <p>
            {course.stats.topics} נושאים · {course.stats.units} יחידות
            {course.examDate ? ` · מבחן ב־${formatDate(course.examDate)}` : ''}
            {course.watchFolder ? ' · יש תיקיית חומרים' : ''}
          </p>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => setModal({ kind: 'unit' })} disabled={topics.filter((t) => t.status === 'active').length === 0}>
            + יחידת ידע
          </button>
          <button className="btn" onClick={() => setModal({ kind: 'topic' })}>
            + נושא
          </button>
          <button className="btn" onClick={() => setModal({ kind: 'lesson' })}>
            + שיעור
          </button>
          <button className="btn ghost" onClick={() => setModal({ kind: 'course' })}>
            עריכת קורס
          </button>
        </div>
      </div>

      <div className="tabs" role="tablist">
        <button className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>
          מפת נושאים
        </button>
        <button className={tab === 'lessons' ? 'on' : ''} onClick={() => setTab('lessons')}>
          שיעורים <span className="badge">{lessons.length}</span>
        </button>
        {merged.length > 0 && (
          <button className={tab === 'merged' ? 'on' : ''} onClick={() => setTab('merged')}>
            נושאים שאוחדו <span className="badge">{merged.length}</span>
          </button>
        )}
      </div>

      {tab === 'map' && (
        <TopicMap
          topics={topics}
          units={units}
          lessons={lessons}
          today={boot.today}
          filter={filter}
          setFilter={setFilter}
          onAddTopic={() => setModal({ kind: 'topic' })}
          onAction={(a, t) => {
            if (a === 'sub') setModal({ kind: 'topic', parentId: t.id });
            else if (a === 'edit') setModal({ kind: 'topic', topic: t });
            else if (a === 'merge') setModal({ kind: 'merge', topic: t });
            else if (a === 'unit') setModal({ kind: 'unit', topicId: t.id });
            else void topicAction(t, a);
          }}
        />
      )}
      {tab === 'lessons' && (
        <Lessons
          lessons={lessons}
          topics={topics}
          units={units}
          onEdit={(l) => setModal({ kind: 'lesson', lesson: l })}
          onAddUnit={(l) => setModal({ kind: 'unit', lessonId: l.id, topicId: l.topicIds[0] ?? null })}
          onAdd={() => setModal({ kind: 'lesson' })}
        />
      )}
      {tab === 'merged' && (
        <div className="card flat">
          <p className="small muted" style={{ marginBottom: 8 }}>
            נושאים שאוחדו נשמרים כאן עם שמם המקורי. אפשר לבטל איחוד מיומן הפעולות (הגדרות).
          </p>
          <div className="list">
            {merged.map((m) => (
              <div key={m.id} className="list-item small">
                <span className="grow">{m.name}</span>
                <span className="muted">אוחד לתוך</span>
                <strong>{topics.find((t) => t.id === m.mergedIntoId)?.name ?? `#${m.mergedIntoId}`}</strong>
              </div>
            ))}
          </div>
        </div>
      )}

      {modal?.kind === 'course' && (
        <CourseModal
          course={course}
          onClose={() => setModal(null)}
          onSaved={() => void after('הקורס עודכן')}
        />
      )}
      {modal?.kind === 'topic' && (
        <TopicModal
          courseId={courseId}
          topic={modal.topic}
          parentId={modal.parentId}
          topics={topics}
          onClose={() => setModal(null)}
          onSaved={() => void after(modal.topic ? 'הנושא עודכן' : 'הנושא נוסף')}
        />
      )}
      {modal?.kind === 'merge' && (
        <MergeModal topic={modal.topic} topics={topics} onClose={() => setModal(null)} onDone={(m) => void after(m)} />
      )}
      {modal?.kind === 'lesson' && (
        <LessonModal
          courseId={courseId}
          lesson={modal.lesson}
          topics={topics}
          today={boot.today}
          onClose={() => setModal(null)}
          onSaved={() => void after('השיעור נשמר')}
        />
      )}
      {modal?.kind === 'unit' && (
        <UnitModal
          courseId={courseId}
          topics={topics}
          lessons={lessons}
          topicId={modal.topicId}
          lessonId={modal.lessonId}
          today={boot.today}
          onClose={() => setModal(null)}
          onSaved={() => void after('היחידה נוספה')}
        />
      )}
    </div>
  );
}

type TopicAction = 'sub' | 'edit' | 'merge' | 'unit' | 'approve' | 'reject';

function TopicMap(props: {
  topics: TopicDTO[];
  units: UnitSummaryDTO[];
  lessons: LessonDTO[];
  today: string;
  filter: string;
  setFilter: (s: string) => void;
  onAddTopic: () => void;
  onAction: (a: TopicAction, t: TopicDTO) => void;
}) {
  const { topics, units } = props;
  const f = props.filter.trim().toLowerCase();
  const visibleUnits = useMemo(() => (f ? units.filter((u) => u.title.toLowerCase().includes(f)) : units), [units, f]);
  const byTopic = useMemo(() => {
    const m = new Map<number, UnitSummaryDTO[]>();
    for (const u of visibleUnits) m.set(u.topicId, [...(m.get(u.topicId) ?? []), u]);
    return m;
  }, [visibleUnits]);
  const ids = new Set(topics.map((t) => t.id));
  const roots = topics.filter((t) => t.parentId === null || !ids.has(t.parentId));

  if (topics.length === 0) {
    return (
      <div className="card">
        <Empty title="אין עדיין נושאים" action={<button className="btn primary" onClick={props.onAddTopic}>+ נושא ראשון</button>}>
          אפשר להוסיף נושאים ידנית, או לייבא סילבוס במסך הייבוא ולקבל הצעה למפת נושאים ראשונית.
        </Empty>
      </div>
    );
  }
  return (
    <div className="stack">
      <input
        className="input"
        style={{ maxWidth: 320 }}
        placeholder="סינון יחידות לפי שם…"
        value={props.filter}
        onChange={(e) => props.setFilter(e.target.value)}
        aria-label="סינון יחידות"
      />
      <div className="tree">
        {roots.map((t) => (
          <TopicNode key={t.id} topic={t} {...props} byTopic={byTopic} depth={0} forceOpen={f !== ''} />
        ))}
      </div>
    </div>
  );
}

function TopicNode(props: {
  topic: TopicDTO;
  topics: TopicDTO[];
  lessons: LessonDTO[];
  byTopic: Map<number, UnitSummaryDTO[]>;
  today: string;
  depth: number;
  forceOpen: boolean;
  onAction: (a: TopicAction, t: TopicDTO) => void;
}) {
  const { topic: t } = props;
  const [open, setOpen] = useState(props.depth === 0);
  const children = props.topics.filter((x) => x.parentId === t.id);
  const units = props.byTopic.get(t.id) ?? [];
  const due = units.filter((u) => u.status === 'active' && u.dueDate && u.dueDate <= props.today).length;
  const isOpen = open || props.forceOpen;
  const proposed = t.status === 'proposed';
  return (
    <div className={`topic ${proposed ? 'proposed' : ''}`}>
      <div className="topic-head">
        <button className={`caret ${isOpen ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-label={isOpen ? 'כווץ' : 'הרחב'} aria-expanded={isOpen}>
          ◀
        </button>
        <div className="grow stack" style={{ gap: 0 }}>
          <div className="row">
            <strong>{t.name}</strong>
            {proposed && <span className="badge dashed">{t.createdBy === 'syllabus' ? 'הצעה מהסילבוס' : 'הצעה'}</span>}
            {t.importance === 'core' && <span className="badge accent">מרכזי</span>}
            {t.importance === 'peripheral' && <span className="badge">שולי</span>}
            {t.foundational && <span className="badge easy">ידע בסיס</span>}
            <span className="tiny muted">
              {units.length} יחידות
              {due > 0 ? ` · ${due} לחזרה` : ''}
              {t.lessonIds.length ? ` · ${t.lessonIds.length} שיעורים` : ''}
            </span>
          </div>
          {t.aliases.length > 0 && <span className="tiny muted">מוכר גם כ: {t.aliases.map((a) => a.alias).join(', ')}</span>}
        </div>
        {proposed ? (
          <div className="row">
            <button className="btn sm primary" onClick={() => props.onAction('approve', t)}>
              אשר
            </button>
            <button className="btn sm" onClick={() => props.onAction('merge', t)}>
              אחד עם…
            </button>
            <button className="btn sm ghost danger" onClick={() => props.onAction('reject', t)}>
              פסול
            </button>
          </div>
        ) : (
          <div className="row">
            <button className="btn sm ghost" onClick={() => props.onAction('unit', t)} title="יחידת ידע חדשה בנושא">
              + יחידה
            </button>
            <button className="btn sm ghost" onClick={() => props.onAction('sub', t)} title="תת־נושא">
              + תת־נושא
            </button>
            <button className="btn sm ghost" onClick={() => props.onAction('edit', t)}>
              עריכה
            </button>
            <button className="btn sm ghost" onClick={() => props.onAction('merge', t)} title="איחוד עם נושא כפול">
              איחוד
            </button>
          </div>
        )}
      </div>
      {isOpen && (units.length > 0 || children.length > 0) && (
        <div className="topic-body">
          {units.map((u) => (
            <UnitRow key={u.id} u={u} today={props.today} />
          ))}
          {children.length > 0 && (
            <div className="children">
              {children.map((c) => (
                <TopicNode key={c.id} {...props} topic={c} depth={props.depth + 1} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UnitRow({ u, today }: { u: UnitSummaryDTO; today: string }) {
  const dueIn = u.dueDate ? daysBetween(today, u.dueDate) : null;
  return (
    <div className="unit-row" onClick={() => go(`/unit/${u.id}`)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && go(`/unit/${u.id}`)}>
      <ConfidenceDot c={u.confidence} />
      <span className="grow" dir="auto">
        {u.title}
      </span>
      {u.status === 'suspended' && <span className="badge">מושהית</span>}
      {u.status === 'proposed' && <span className="badge dashed">הצעה</span>}
      {u.remediation && <span className="badge wrong">תיקון</span>}
      {u.unverified && <span className="badge warn" title="יש שאלה שמסומנת ״דורש בדיקה״, או סתירה פתוחה בין מקורות">⚠ לא מאומת</span>}
      {u.questionCounts.pending > 0 && <span className="badge dashed">{u.questionCounts.pending} ממתינות</span>}
      {u.questionCounts.flagged > 0 && <span className="badge warn">{u.questionCounts.flagged} לבדיקה</span>}
      {u.questionCounts.approved + u.questionCounts.pending + u.questionCounts.flagged === 0 && u.status === 'active' && <span className="badge warn">אין שאלה</span>}
      {u.status === 'active' && dueIn !== null && (
        <span className={`tiny nowrap ${dueIn < 0 ? '' : 'muted'}`} style={dueIn < 0 ? { color: 'var(--partial)' } : undefined}>
          {dueIn < 0 ? `באיחור ${-dueIn} ימים` : formatIn(dueIn)}
        </span>
      )}
    </div>
  );
}

function Lessons(props: {
  lessons: LessonDTO[];
  topics: TopicDTO[];
  units: UnitSummaryDTO[];
  onEdit: (l: LessonDTO) => void;
  onAddUnit: (l: LessonDTO) => void;
  onAdd: () => void;
}) {
  if (props.lessons.length === 0) {
    return (
      <div className="card">
        <Empty title="אין עדיין שיעורים" action={<button className="btn primary" onClick={props.onAdd}>+ שיעור</button>}>
          אחרי כל שיעור או יום למידה, סמן כאן מה נלמד ומתי. יחידות שמשויכות לשיעור מקבלות את תאריך הלמידה שלו.
        </Empty>
      </div>
    );
  }
  const name = (id: number) => props.topics.find((t) => t.id === id)?.name ?? `#${id}`;
  return (
    <div className="card flat table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>תאריך</th>
            <th>שיעור</th>
            <th>נושאים</th>
            <th>יחידות</th>
            <th>מקורות</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {[...props.lessons].reverse().map((l) => (
            <tr key={l.id}>
              <td className="nowrap num">{formatDate(l.studiedOn)}</td>
              <td>
                <strong>{l.title}</strong>
                {l.notes && <div className="tiny muted">{l.notes}</div>}
              </td>
              <td>
                <div className="chips">
                  {l.topicIds.map((t) => (
                    <span key={t} className="badge outline">
                      {name(t)}
                    </span>
                  ))}
                  {l.topicIds.length === 0 && <span className="tiny muted">—</span>}
                </div>
              </td>
              <td className="num">{props.units.filter((u) => u.lessonId === l.id).length}</td>
              <td className="num">{l.sourceIds.length}</td>
              <td className="nowrap">
                <button className="btn sm ghost" onClick={() => props.onAddUnit(l)}>
                  + יחידה
                </button>
                <button className="btn sm ghost" onClick={() => props.onEdit(l)}>
                  עריכה
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
