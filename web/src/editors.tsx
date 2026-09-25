// Forms for creating and editing the study structure. Each one is a modal
// that posts to the API and hands the result back; undo comes from the log.

import { useEffect, useMemo, useState } from 'react';
import { api } from './api.ts';
import { Modal, useLoad, useToast } from './ui.tsx';
import type { ChunkDTO, CourseDTO, CourseTreeDTO, LessonDTO, QuestionDTO, SourceDTO, TopicDTO, UnitDetailDTO } from '../../shared/api.ts';
import {
  FIELD_LABELS,
  IMPORTANCE_LABELS,
  KIND_HINTS,
  KIND_LABELS,
  PROVENANCE_LABELS,
  SOURCE_KIND_LABELS,
  TEMPLATE_LABELS,
} from '../../shared/labels.ts';
import {
  ANSWER_TEMPLATES,
  PROVENANCES,
  QUESTION_KINDS,
  TEMPLATE_FIELDS,
  type AnswerStructure,
  type AnswerTemplate,
  type Importance,
  type Provenance,
  type QuestionKind,
} from '../../shared/types.ts';

const COLORS = ['#2f5d62', '#8a5a44', '#5b6b2e', '#6a4c93', '#b0563c', '#3a6ea5', '#9a7b1c', '#4f4f4f'];

function useBusy() {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      toast.error(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

// ---------- course ----------

export function CourseModal({ course, onClose, onSaved }: { course?: CourseDTO; onClose: () => void; onSaved: (c: CourseDTO) => void }) {
  const [f, setF] = useState({
    name: course?.name ?? '',
    code: course?.code ?? '',
    term: course?.term ?? '',
    examDate: course?.examDate ?? '',
    color: course?.color ?? COLORS[0],
    watchFolder: course?.watchFolder ?? '',
  });
  const { busy, run } = useBusy();
  const save = () =>
    run(async () => {
      const body = { ...f, examDate: f.examDate || null };
      const c = course ? await api.put<CourseDTO>(`/courses/${course.id}`, body) : await api.post<CourseDTO>('/courses', body);
      onSaved(c);
    });
  return (
    <Modal
      title={course ? 'עריכת קורס' : 'קורס חדש'}
      onClose={onClose}
      footer={
        <>
          <button className="btn primary" disabled={busy || !f.name.trim()} onClick={save}>
            שמור
          </button>
          <button className="btn ghost" onClick={onClose}>
            ביטול
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field full">
          שם הקורס
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
        </label>
        <label className="field">
          קוד קורס <span className="hint">לא חובה</span>
          <input className="input" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        </label>
        <label className="field">
          סמסטר <span className="hint">לא חובה</span>
          <input className="input" value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} />
        </label>
        <label className="field">
          תאריך מבחן <span className="hint">שבועיים לפניו החומר מקבל עדיפות</span>
          <input className="input" type="date" value={f.examDate} onChange={(e) => setF({ ...f, examDate: e.target.value })} />
        </label>
        <div className="field">
          צבע
          <div className="row">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`צבע ${c}`}
                onClick={() => setF({ ...f, color: c })}
                style={{ width: 24, height: 24, borderRadius: 6, background: c, border: f.color === c ? '2px solid var(--ink)' : '2px solid transparent', cursor: 'pointer' }}
              />
            ))}
          </div>
        </div>
        <label className="field full">
          תיקיית חומרי הקורס <span className="hint">נתיב מלא. הסריקה רק קוראת קבצים — לעולם לא משנה אותם.</span>
          <input
            className="input ltr"
            dir="ltr"
            placeholder="C:\Users\...\Biology"
            value={f.watchFolder}
            onChange={(e) => setF({ ...f, watchFolder: e.target.value })}
          />
        </label>
      </div>
    </Modal>
  );
}

// ---------- topic ----------

export function TopicModal(props: {
  courseId: number;
  topic?: TopicDTO;
  parentId?: number | null;
  topics: TopicDTO[];
  onClose: () => void;
  onSaved: (t: TopicDTO) => void;
}) {
  const t = props.topic;
  const [f, setF] = useState({
    name: t?.name ?? '',
    description: t?.description ?? '',
    importance: (t?.importance ?? 'normal') as Importance,
    foundational: t?.foundational ?? false,
    parentId: (t ? t.parentId : props.parentId) ?? null,
  });
  const { busy, run } = useBusy();
  const parents = props.topics.filter((x) => x.id !== t?.id && x.status === 'active');
  const save = () =>
    run(async () => {
      const r = t ? await api.put<TopicDTO>(`/topics/${t.id}`, f) : await api.post<TopicDTO>('/topics', { ...f, courseId: props.courseId });
      props.onSaved(r);
    });
  return (
    <Modal
      title={t ? 'עריכת נושא' : f.parentId ? 'תת־נושא חדש' : 'נושא חדש'}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn primary" disabled={busy || !f.name.trim()} onClick={save}>
            שמור
          </button>
          <button className="btn ghost" onClick={props.onClose}>
            ביטול
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field full">
          שם
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          {t && t.name !== f.name && <span className="hint">השם הקודם יישמר ככינוי, כך שאפשר יהיה למצוא את הנושא גם לפיו.</span>}
        </label>
        <label className="field">
          נושא אב
          <select className="input" value={f.parentId ?? ''} onChange={(e) => setF({ ...f, parentId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">— נושא ראשי —</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          חשיבות
          <select className="input" value={f.importance} onChange={(e) => setF({ ...f, importance: e.target.value as Importance })}>
            {(['core', 'normal', 'peripheral'] as const).map((i) => (
              <option key={i} value={i}>
                {IMPORTANCE_LABELS[i]}
              </option>
            ))}
          </select>
        </label>
        <label className="check full">
          <input type="checkbox" checked={f.foundational} onChange={(e) => setF({ ...f, foundational: e.target.checked })} />
          ידע בסיס — נושאים אחרים נשענים עליו (מקבל עדיפות בסשן)
        </label>
        <label className="field full">
          תיאור <span className="hint">לא חובה</span>
          <textarea className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

export function MergeModal({ topic, topics, onClose, onDone }: { topic: TopicDTO; topics: TopicDTO[]; onClose: () => void; onDone: (auditHint: string) => void }) {
  const [into, setInto] = useState<number | ''>('');
  const { busy, run } = useBusy();
  const targets = topics.filter((t) => t.id !== topic.id && t.status === 'active');
  return (
    <Modal
      title={`איחוד "${topic.name}"`}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn primary"
            disabled={busy || into === ''}
            onClick={() =>
              run(async () => {
                await api.post(`/topics/${topic.id}/merge`, { intoId: into });
                onDone(`"${topic.name}" אוחד`);
              })
            }
          >
            אחד
          </button>
          <button className="btn ghost" onClick={onClose}>
            ביטול
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small">
          כל היחידות, תתי־הנושאים, השיעורים והמקורות של הנושא יעברו לנושא היעד. השם "{topic.name}" יישמר ככינוי, היסטוריית החזרות לא משתנה, ואפשר לבטל את האיחוד מיומן הפעולות.
        </p>
        <label className="field">
          לאחד לתוך
          <select className="input" value={into} onChange={(e) => setInto(e.target.value ? Number(e.target.value) : '')}>
            <option value="">בחר נושא…</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}

// ---------- lesson ----------

export function LessonModal(props: { courseId: number; lesson?: LessonDTO; topics: TopicDTO[]; today: string; onClose: () => void; onSaved: (l: LessonDTO) => void }) {
  const l = props.lesson;
  const sources = useLoad<SourceDTO[]>(`/sources?courseId=${props.courseId}`);
  const [f, setF] = useState({
    title: l?.title ?? '',
    studiedOn: l?.studiedOn ?? props.today,
    kind: l?.kind ?? 'lecture',
    notes: l?.notes ?? '',
    topicIds: l?.topicIds ?? ([] as number[]),
    sourceIds: l?.sourceIds ?? ([] as number[]),
  });
  const { busy, run } = useBusy();
  const toggle = (key: 'topicIds' | 'sourceIds', id: number) =>
    setF((x) => ({ ...x, [key]: x[key].includes(id) ? x[key].filter((y) => y !== id) : [...x[key], id] }));
  return (
    <Modal
      title={l ? 'עריכת שיעור' : 'שיעור / יום למידה'}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button
            className="btn primary"
            disabled={busy || !f.title.trim()}
            onClick={() =>
              run(async () => {
                const r = l ? await api.put<LessonDTO>(`/lessons/${l.id}`, f) : await api.post<LessonDTO>('/lessons', { ...f, courseId: props.courseId });
                props.onSaved(r);
              })
            }
          >
            שמור
          </button>
          <button className="btn ghost" onClick={props.onClose}>
            ביטול
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field">
          כותרת
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="הרצאה 4 — קולטנים" autoFocus />
        </label>
        <label className="field">
          תאריך הלמידה
          <input className="input" type="date" value={f.studiedOn} onChange={(e) => setF({ ...f, studiedOn: e.target.value })} />
        </label>
        <label className="field">
          סוג
          <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="lecture">הרצאה</option>
            <option value="tutorial">תרגול</option>
            <option value="lab">מעבדה</option>
            <option value="self_study">למידה עצמית</option>
          </select>
        </label>
        <label className="field">
          הערות
          <input className="input" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <div className="field full">
          נושאים שנלמדו <span className="hint">שיעור יכול לכסות כמה נושאים, ונושא יכול להתפרס על כמה שיעורים</span>
          <div className="chips">
            {props.topics
              .filter((t) => t.status === 'active')
              .map((t) => (
                <button key={t.id} type="button" className={`chip ${f.topicIds.includes(t.id) ? 'on' : ''}`} onClick={() => toggle('topicIds', t.id)}>
                  {t.name}
                </button>
              ))}
            {props.topics.length === 0 && <span className="small muted">אין עדיין נושאים בקורס.</span>}
          </div>
        </div>
        <div className="field full">
          מקורות <span className="hint">מצגות וסיכומים של השיעור</span>
          <div className="chips">
            {(sources.data ?? [])
              .filter((s) => s.status !== 'ignored')
              .map((s) => (
                <button key={s.id} type="button" className={`chip ${f.sourceIds.includes(s.id) ? 'on' : ''}`} onClick={() => toggle('sourceIds', s.id)}>
                  {s.title}
                </button>
              ))}
            {sources.data?.length === 0 && <span className="small muted">אין מקורות לקורס — אפשר להוסיף במסך הייבוא.</span>}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------- questions ----------

export interface QuestionDraft {
  kind: QuestionKind;
  prompt: string;
  answer: string;
  explanation: string;
  hint: string;
  keyPoints: string[];
  structure: AnswerStructure | null;
  provenance: Provenance;
}

export function draftFrom(q?: QuestionDTO, provenance: Provenance = 'unverified'): QuestionDraft {
  return {
    kind: q?.kind ?? 'definition',
    prompt: q?.prompt ?? '',
    answer: q?.answer ?? '',
    explanation: q?.explanation ?? '',
    hint: q?.hint ?? '',
    keyPoints: q?.keyPoints ?? [],
    structure: q?.structure ?? null,
    provenance: q?.provenance ?? provenance,
  };
}

export function QuestionFields({ d, set }: { d: QuestionDraft; set: (d: QuestionDraft) => void }) {
  const [kp, setKp] = useState(d.keyPoints.join('\n'));
  useEffect(() => setKp(d.keyPoints.join('\n')), [d.keyPoints]);
  const tpl = d.structure?.template ?? null;
  const setTemplate = (t: AnswerTemplate | null) =>
    set({ ...d, structure: t ? { template: t, fields: d.structure?.template === t ? d.structure.fields : {}, analogy: d.structure?.analogy } : null });
  const clozeBad = d.kind === 'cloze' && d.prompt.trim() !== '' && !/\[\[[^\]]+\]\]/.test(d.prompt);
  return (
    <div className="form-grid">
      <label className="field">
        סוג שאלה
        <select className="input" value={d.kind} onChange={(e) => set({ ...d, kind: e.target.value as QuestionKind })}>
          {QUESTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <span className="hint">{KIND_HINTS[d.kind]}</span>
      </label>
      <label className="field">
        מקור התשובה
        <select className="input" value={d.provenance} onChange={(e) => set({ ...d, provenance: e.target.value as Provenance })}>
          {PROVENANCES.map((p) => (
            <option key={p} value={p}>
              {PROVENANCE_LABELS[p]}
            </option>
          ))}
        </select>
        <span className="hint">"דורש בדיקה" מוצג עם אזהרה עד שמקשרים מקור.</span>
      </label>
      <label className="field full">
        {d.kind === 'cloze' ? 'המשפט, עם החלק החסר ב־[[סוגריים כפולים]]' : 'צד השאלה / המונח'}
        <textarea className="input serif" dir="auto" rows={2} value={d.prompt} onChange={(e) => set({ ...d, prompt: e.target.value })} />
        {clozeBad && <span className="hint" style={{ color: 'var(--wrong)' }}>סמן את החלק שיוסתר, למשל: [[אינסולין]]</span>}
      </label>
      <label className="field full">
        תשובה {d.kind === 'cloze' && <span className="hint">אפשר להשאיר ריק — המילים שבסוגריים הן התשובה</span>}
        <textarea className="input" dir="auto" rows={3} value={d.answer} onChange={(e) => set({ ...d, answer: e.target.value })} />
      </label>
      <label className="field full">
        הסבר קצר <span className="hint">מופיע אחרי חשיפת התשובה</span>
        <textarea className="input" dir="auto" rows={2} value={d.explanation} onChange={(e) => set({ ...d, explanation: e.target.value })} />
      </label>
      <label className="field">
        רמז <span className="hint">שימוש ברמז לא נחשב הצלחה מלאה</span>
        <input className="input" dir="auto" value={d.hint} onChange={(e) => set({ ...d, hint: e.target.value })} />
      </label>
      <label className="field">
        נקודות מפתח <span className="hint">שורה לכל נקודה — משמשות לבדיקה עצמית</span>
        <textarea
          className="input"
          dir="auto"
          rows={3}
          value={kp}
          onChange={(e) => setKp(e.target.value)}
          onBlur={() => set({ ...d, keyPoints: kp.split('\n').map((x) => x.trim()).filter(Boolean) })}
        />
      </label>
      <div className="field full">
        מבנה תשובה <span className="hint">לתשובות חשובות: מנגנון, תפקיד, דוגמה, כיוון סיבתי ומגבלות</span>
        <div className="seg">
          <button type="button" className={tpl === null ? 'on' : ''} onClick={() => setTemplate(null)}>
            ללא
          </button>
          {ANSWER_TEMPLATES.map((t) => (
            <button type="button" key={t} className={tpl === t ? 'on' : ''} onClick={() => setTemplate(t)}>
              {TEMPLATE_LABELS[t]}
            </button>
          ))}
        </div>
      </div>
      {d.structure && (
        <>
          {TEMPLATE_FIELDS[d.structure.template].map((f) => (
            <label key={f} className="field">
              {FIELD_LABELS[f]}
              <input
                className="input"
                dir="auto"
                value={d.structure!.fields[f] ?? ''}
                onChange={(e) => set({ ...d, structure: { ...d.structure!, fields: { ...d.structure!.fields, [f]: e.target.value } } })}
              />
            </label>
          ))}
          <label className="field full">
            אנלוגיה <span className="hint">עוזרת לזכור, אבל לא מחליפה את המונח המדעי</span>
            <input className="input" dir="auto" value={d.structure.analogy ?? ''} onChange={(e) => set({ ...d, structure: { ...d.structure!, analogy: e.target.value } })} />
          </label>
        </>
      )}
    </div>
  );
}

export function QuestionModal({ unitId, question, onClose, onSaved }: { unitId: number; question?: QuestionDTO; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<QuestionDraft>(draftFrom(question));
  const { busy, run } = useBusy();
  return (
    <Modal
      title={question ? 'עריכת שאלה' : 'שאלה חדשה'}
      onClose={onClose}
      wide
      footer={
        <>
          <button
            className="btn primary"
            disabled={busy || !d.prompt.trim() || (d.kind !== 'cloze' && !d.answer.trim())}
            onClick={() =>
              run(async () => {
                if (question) await api.put(`/questions/${question.id}`, d);
                else await api.post('/questions', { ...d, unitId });
                onSaved();
              })
            }
          >
            שמור
          </button>
          <button className="btn ghost" onClick={onClose}>
            ביטול
          </button>
        </>
      }
    >
      <QuestionFields d={d} set={setD} />
    </Modal>
  );
}

// ---------- unit ----------

export function UnitModal(props: {
  courseId: number;
  topics: TopicDTO[];
  lessons: LessonDTO[];
  topicId?: number | null;
  lessonId?: number | null;
  unit?: UnitDetailDTO['unit'];
  today: string;
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const u = props.unit;
  const [f, setF] = useState({
    topicId: u?.topicId ?? props.topicId ?? props.topics.find((t) => t.status === 'active')?.id ?? 0,
    title: u?.title ?? '',
    content: u?.content ?? '',
    learnedOn: u?.learnedOn ?? props.lessons.find((l) => l.id === props.lessonId)?.studiedOn ?? props.today,
    lessonId: u?.lessonId ?? props.lessonId ?? null,
    importance: (u?.importanceOverride ?? 'inherit') as Importance | 'inherit',
    foundational: u?.foundationalOverride === null || u?.foundationalOverride === undefined ? 'inherit' : u.foundationalOverride ? 'yes' : 'no',
  });
  const [q, setQ] = useState<QuestionDraft>(draftFrom(undefined, props.lessonId ? 'official' : 'unverified'));
  const [withQuestion, setWithQuestion] = useState(!u);
  const { busy, run } = useBusy();
  const active = props.topics.filter((t) => t.status === 'active');
  const save = () =>
    run(async () => {
      const body = {
        ...f,
        importance: f.importance === 'inherit' ? null : f.importance,
        foundational: f.foundational === 'inherit' ? null : f.foundational === 'yes',
      };
      if (u) {
        await api.put(`/units/${u.id}`, body);
        props.onSaved(u.id);
      } else {
        const created = await api.post<UnitDetailDTO>('/units', {
          ...body,
          questions: withQuestion && q.prompt.trim() ? [{ ...q, prompt: q.prompt || f.title }] : [],
        });
        props.onSaved(created.unit.id);
      }
    });
  return (
    <Modal
      title={u ? 'עריכת יחידת ידע' : 'יחידת ידע חדשה'}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button className="btn primary" disabled={busy || !f.title.trim() || !f.topicId} onClick={save}>
            שמור
          </button>
          <button className="btn ghost" onClick={props.onClose}>
            ביטול
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">יחידת ידע היא רעיון אחד קטן שאפשר לבדוק בשאלה — מונח, שלב במסלול, תוצאה של ניסוי. התזמון שייך ליחידה, לא לנושא כולו.</p>
        <div className="form-grid">
          <label className="field">
            נושא
            <select className="input" value={f.topicId} onChange={(e) => setF({ ...f, topicId: Number(e.target.value) })}>
              {active.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.parentId ? '— ' : ''}
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            כותרת
            <input className="input" dir="auto" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus placeholder="למשל: קולטן אינסולין" />
          </label>
          <label className="field full">
            תוכן <span className="hint">הרעיון עצמו, בקצרה</span>
            <textarea className="input" dir="auto" rows={2} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />
          </label>
          <label className="field">
            נלמד בתאריך <span className="hint">{u && u.reps > 0 ? 'שינוי לא משנה תזמון קיים' : 'החזרה הראשונה נקבעת ליום הזה'}</span>
            <input className="input" type="date" value={f.learnedOn} onChange={(e) => setF({ ...f, learnedOn: e.target.value })} />
          </label>
          <label className="field">
            שיעור
            <select
              className="input"
              value={f.lessonId ?? ''}
              onChange={(e) => {
                const id = e.target.value ? Number(e.target.value) : null;
                const l = props.lessons.find((x) => x.id === id);
                setF({ ...f, lessonId: id, learnedOn: l && !(u && u.reps > 0) ? l.studiedOn : f.learnedOn });
              }}
            >
              <option value="">— ללא —</option>
              {props.lessons.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title} ({l.studiedOn})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            חשיבות
            <select className="input" value={f.importance} onChange={(e) => setF({ ...f, importance: e.target.value as Importance | 'inherit' })}>
              <option value="inherit">כמו הנושא</option>
              {(['core', 'normal', 'peripheral'] as const).map((i) => (
                <option key={i} value={i}>
                  {IMPORTANCE_LABELS[i]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            ידע בסיס
            <select className="input" value={f.foundational} onChange={(e) => setF({ ...f, foundational: e.target.value })}>
              <option value="inherit">כמו הנושא</option>
              <option value="yes">כן</option>
              <option value="no">לא</option>
            </select>
          </label>
        </div>
        {!u && (
          <>
            <label className="check">
              <input type="checkbox" checked={withQuestion} onChange={(e) => setWithQuestion(e.target.checked)} />
              הוסף שאלה ראשונה עכשיו
            </label>
            {withQuestion && (
              <div className="card flat">
                <QuestionFields d={q} set={setQ} />
              </div>
            )}
            {!withQuestion && <p className="tiny muted">בלי שאלה מאושרת היחידה לא תופיע בסשן — היא תופיע ברשימת "לא ניתן לשאול".</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------- source links ----------

export function LinkModal(props: {
  courseId: number;
  entityType: 'unit' | 'question';
  entityId: number;
  role?: 'supports' | 'contradicts';
  initialQuery?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const sources = useLoad<SourceDTO[]>(`/sources?courseId=${props.courseId}`);
  const [role, setRole] = useState<'supports' | 'contradicts'>(props.role ?? 'supports');
  const [q, setQ] = useState(props.initialQuery ?? '');
  const [hits, setHits] = useState<(ChunkDTO & { sourceTitle: string })[]>([]);
  const [chunk, setChunk] = useState<(ChunkDTO & { sourceTitle: string }) | null>(null);
  const [sourceId, setSourceId] = useState<number | ''>('');
  const [locator, setLocator] = useState('');
  const [quote, setQuote] = useState('');
  const [note, setNote] = useState('');
  const { busy, run } = useBusy();

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get<(ChunkDTO & { sourceTitle: string })[]>(`/chunks/search?q=${encodeURIComponent(q)}&courseId=${props.courseId}`)
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, props.courseId]);

  const usable = useMemo(() => (sources.data ?? []).filter((s) => s.status !== 'ignored'), [sources.data]);
  const canSave = chunk !== null || sourceId !== '';

  return (
    <Modal
      title={role === 'contradicts' ? 'סימון סתירה ממקור' : 'קישור למקור'}
      onClose={props.onClose}
      wide
      footer={
        <>
          <button
            className="btn primary"
            disabled={busy || !canSave}
            onClick={() =>
              run(async () => {
                await api.post('/links', {
                  entityType: props.entityType,
                  entityId: props.entityId,
                  sourceId: chunk ? chunk.sourceId : sourceId,
                  chunkId: chunk?.id ?? null,
                  locator: chunk ? chunk.locatorLabel : locator,
                  quote: quote || null,
                  role,
                  note: note || null,
                });
                props.onSaved();
              })
            }
          >
            שמור
          </button>
          <button className="btn ghost" onClick={props.onClose}>
            ביטול
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="seg">
          <button className={role === 'supports' ? 'on' : ''} onClick={() => setRole('supports')}>
            המקור תומך
          </button>
          <button className={role === 'contradicts' ? 'on' : ''} onClick={() => setRole('contradicts')}>
            המקור סותר
          </button>
        </div>
        {role === 'contradicts' && (
          <div className="callout warn small">סתירה מוציאה את השאלות של הפריט מהחזרות עד שמיישבים אותה במסך הבדיקה — כדי לא לשנן משהו שאולי שגוי.</div>
        )}
        <label className="field">
          חיפוש בטקסט המקורות של הקורס
          <input className="input" dir="auto" value={q} onChange={(e) => setQ(e.target.value)} placeholder="מילה או ביטוי מהשקופית / העמוד" />
        </label>
        {hits.length > 0 && !chunk && (
          <div className="list" style={{ maxHeight: 260, overflowY: 'auto' }}>
            {hits.map((h) => (
              <button
                key={h.id}
                className="list-item clickable"
                style={{ textAlign: 'start', background: 'none', border: 0, borderBottom: '1px solid var(--line-2)' }}
                onClick={() => {
                  setChunk(h);
                  const idx = h.text.indexOf(q.trim());
                  setQuote(idx >= 0 ? h.text.slice(Math.max(0, idx - 80), idx + 160).trim() : h.text.slice(0, 240));
                }}
              >
                <span className="stack grow" style={{ gap: 2 }}>
                  <span className="small">
                    <strong>{h.sourceTitle}</strong> · {h.locatorLabel}
                    {h.heading ? ` · ${h.heading}` : ''}
                  </span>
                  <span className="tiny muted" dir="auto">
                    {h.text.slice(0, 180)}…
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {chunk ? (
          <div className="callout info small row-between">
            <span>
              {chunk.sourceTitle} · {chunk.locatorLabel}
            </span>
            <button className="linkbtn" onClick={() => setChunk(null)}>
              החלף
            </button>
          </div>
        ) : (
          <div className="form-grid">
            <label className="field">
              או בחר מקור
              <select className="input" value={sourceId} onChange={(e) => setSourceId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">—</option>
                {usable.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title} ({SOURCE_KIND_LABELS[s.kind]})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              מיקום <span className="hint">עמוד / שקופית / דקה בהקלטה</span>
              <input className="input" value={locator} onChange={(e) => setLocator(e.target.value)} placeholder="שקופית 12" />
            </label>
          </div>
        )}
        <label className="field">
          ציטוט <span className="hint">הקטע שמבסס (או סותר) את התשובה</span>
          <textarea className="input" dir="auto" rows={3} value={quote} onChange={(e) => setQuote(e.target.value)} />
        </label>
        <label className="field">
          הערה
          <input className="input" dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {usable.length === 0 && !sources.loading && <p className="tiny muted">אין מקורות לקורס הזה. אפשר להוסיף מקור ידני או קובץ במסך הייבוא.</p>}
      </div>
    </Modal>
  );
}

export type { CourseTreeDTO };
