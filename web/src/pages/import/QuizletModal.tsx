// Paste a Quizlet export and turn each card into a knowledge unit with one
// question. Live preview uses the same parser as the import, so what you see
// is what gets imported.

import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { useApp } from '../../App.tsx';
import { Link } from '../../router.tsx';
import { ClozeText, Modal, useLoad } from '../../ui.tsx';
import type { SourceDTO } from '../../../../shared/api.ts';
import { PROVENANCE_LABELS, SOURCE_KIND_LABELS } from '../../../../shared/labels.ts';
import { PROVENANCES, type Provenance } from '../../../../shared/types.ts';
import {
  CourseSelect,
  PROVENANCE_FOR_KIND,
  count,
  lessonLabel,
  topicOptions,
  useCourseTree,
  type CardsImportResultDTO,
  type CardsPreviewDTO,
} from './common.tsx';

type TermSep = 'auto' | 'tab' | 'comma' | 'dash' | 'custom';
type CardSep = 'auto' | 'newline' | 'semicolon' | 'blankline' | 'custom';

const TERM_SEP_LABELS: Record<TermSep, string> = {
  auto: 'זיהוי אוטומטי',
  tab: 'טאב (ברירת המחדל של Quizlet)',
  comma: 'פסיק',
  dash: 'מקף עם רווחים ( - )',
  custom: 'אחר…',
};

const CARD_SEP_LABELS: Record<CardSep, string> = {
  auto: 'זיהוי אוטומטי',
  newline: 'שורה חדשה (ברירת המחדל של Quizlet)',
  semicolon: 'נקודה־פסיק (;)',
  blankline: 'שורה ריקה',
  custom: 'אחר…',
};

const PROVENANCE_EXPLAIN: Record<Provenance, string> = {
  official: 'התשובות לקוחות מחומר רשמי של הקורס — מצגות, סיכומי שיעור או חומרי קורס.',
  past_exam: 'הכרטיסים נכתבו לפי מבחן קודם. הם טובים לתרגול הסגנון, אבל כדאי לאמת את התשובות מול חומר הקורס.',
  generated: 'הכרטיסים נכתבו מתוך מקור מסוים (למשל סיכום שכתבת בעצמך מתוך ההרצאה).',
  external: 'הכרטיסים הם הרחבה מחוץ לחומר הקורס.',
  unverified:
    'כשאין מקור מתועד, הכרטיסים מסומנים "דורש בדיקה": הם נשארים שלך ויכולים להיכנס לחזרות, אבל לא יוצגו כעובדה מאומתת עד שתקשר אותם למקור.',
};

const PREVIEW_ROWS = 150;

export interface CardsImported {
  result: CardsImportResultDTO;
  courseId: number;
  courseName: string;
  topicName: string;
  reviewFirst: boolean;
}

export default function QuizletModal(props: {
  text: string;
  onText: (t: string) => void;
  onClose: () => void;
  onImported: (r: CardsImported) => void;
}) {
  const { boot } = useApp();
  const text = props.text;
  const [termSep, setTermSep] = useState<TermSep>('auto');
  const [termCustom, setTermCustom] = useState('');
  const [cardSep, setCardSep] = useState<CardSep>('auto');
  const [cardCustom, setCardCustom] = useState('');

  const [courseId, setCourseId] = useState(boot.courses.length > 0 ? String(boot.courses[0].id) : '');
  const [topicMode, setTopicMode] = useState<'new' | 'existing'>('new');
  const [topicId, setTopicId] = useState('');
  const [topicName, setTopicName] = useState('');
  const [lessonId, setLessonId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [learnedOn, setLearnedOn] = useState(boot.today);
  const [provenance, setProvenance] = useState<Provenance>('unverified');
  const [provTouched, setProvTouched] = useState(false);
  const [reviewFirst, setReviewFirst] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cid = courseId ? Number(courseId) : null;
  const { tree } = useCourseTree(cid);
  const topics = tree ? topicOptions(tree.topics) : [];
  const { data: courseSources } = useLoad<SourceDTO[]>(cid ? `/sources?courseId=${cid}` : null);
  const approvedSources = (courseSources ?? []).filter((s) => s.courseId === cid && s.status === 'approved');

  const ts = termSep === 'custom' ? termCustom || 'auto' : termSep;
  const cs = cardSep === 'custom' ? cardCustom || 'auto' : cardSep;

  // ----- live preview -----
  const [preview, setPreview] = useState<CardsPreviewDTO | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    if (!text.trim()) {
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    const t = setTimeout(() => {
      api
        .post<CardsPreviewDTO>('/import/cards/preview', { text, termSep: ts, cardSep: cs })
        .then((r) => {
          if (seq.current !== my) return;
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e: unknown) => {
          if (seq.current === my) setPreviewError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (seq.current === my) setPreviewing(false);
        });
    }, 300);
    return () => clearTimeout(t);
  }, [text, ts, cs]);

  const cards = preview?.cards ?? [];
  const skipped = preview?.skipped ?? [];

  function chooseCourse(v: string) {
    setCourseId(v);
    setTopicId('');
    setLessonId('');
    chooseSource('');
  }

  function chooseSource(v: string) {
    setSourceId(v);
    if (provTouched) return;
    const s = approvedSources.find((x) => String(x.id) === v);
    setProvenance(s ? PROVENANCE_FOR_KIND[s.kind] : 'unverified');
  }

  const topicOk = topicMode === 'new' || topicId !== '';
  const canImport = !busy && cards.length > 0 && !!cid && topicOk && !previewing;

  async function doImport() {
    if (!canImport || !cid) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { text, termSep: ts, cardSep: cs, courseId: cid, learnedOn, provenance, reviewFirst };
      let tName: string;
      if (topicMode === 'existing') {
        body.topicId = Number(topicId);
        tName = topics.find((t) => String(t.id) === topicId)?.name ?? '';
      } else {
        tName = topicName.trim() || 'כרטיסים מיובאים';
        body.topicName = tName;
      }
      if (lessonId) body.lessonId = Number(lessonId);
      if (sourceId) body.sourceId = Number(sourceId);
      const result = await api.post<CardsImportResultDTO>('/import/cards', body);
      props.onImported({
        result,
        courseId: cid,
        courseName: boot.courses.find((c) => c.id === cid)?.name ?? '',
        topicName: tName,
        reviewFirst,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="ייבוא כרטיסים מ־Quizlet"
      onClose={props.onClose}
      wide
      footer={
        <>
          <button className="btn primary" disabled={!canImport} onClick={() => void doImport()}>
            {busy ? 'מייבא…' : cards.length > 0 ? `ייבא ${count(cards.length, 'כרטיס אחד', 'כרטיסים')}` : 'ייבא'}
          </button>
          <button className="btn" onClick={props.onClose}>
            ביטול
          </button>
          {!cid && cards.length > 0 && <span className="small muted">בחר קורס כדי לייבא.</span>}
        </>
      }
    >
      <div className="stack-lg">
        <section className="stack">
          <div className="callout info small">
            <strong>איך מייצאים מ־Quizlet:</strong> פותחים את הסט, לוחצים על ⋯ ← <span className="ltr">Export</span> (ייצוא), משאירים את ברירות
            המחדל — <strong>טאב</strong> בין מונח להגדרה ו<strong>שורה חדשה</strong> בין כרטיסים — מעתיקים ומדביקים כאן. אפשר גם להדביק שתי עמודות
            מ־Excel.
          </div>
          <label className="field">
            הטקסט מ־Quizlet
            <textarea
              className="input"
              dir="auto"
              rows={8}
              value={text}
              onChange={(e) => props.onText(e.target.value)}
              placeholder={'מיטוכונדריה\tהאברון שבו מתרחשת הנשימה התאית\nהאינסולין מופרש מתאי ___ בלבלב\tבטא'}
              spellCheck={false}
              autoFocus
            />
            <span className="hint">
              מונח עם ___ (שלושה קווים תחתונים או יותר) הופך לשאלת השלמת משפט, וההגדרה היא החלק החסר. כרטיסים כפולים מדולגים.
            </span>
          </label>
          <div className="form-grid">
            <label className="field">
              מפריד בין מונח להגדרה
              <select className="input" value={termSep} onChange={(e) => setTermSep(e.target.value as TermSep)}>
                {(Object.keys(TERM_SEP_LABELS) as TermSep[]).map((k) => (
                  <option key={k} value={k}>
                    {TERM_SEP_LABELS[k]}
                  </option>
                ))}
              </select>
              {termSep === 'custom' && (
                <input className="input ltr" value={termCustom} onChange={(e) => setTermCustom(e.target.value)} placeholder="למשל ::" aria-label="מפריד מותאם בין מונח להגדרה" />
              )}
            </label>
            <label className="field">
              מפריד בין כרטיסים
              <select className="input" value={cardSep} onChange={(e) => setCardSep(e.target.value as CardSep)}>
                {(Object.keys(CARD_SEP_LABELS) as CardSep[]).map((k) => (
                  <option key={k} value={k}>
                    {CARD_SEP_LABELS[k]}
                  </option>
                ))}
              </select>
              {cardSep === 'custom' && (
                <input className="input ltr" value={cardCustom} onChange={(e) => setCardCustom(e.target.value)} placeholder="למשל ##" aria-label="מפריד מותאם בין כרטיסים" />
              )}
            </label>
          </div>
        </section>

        <section className="stack" aria-live="polite">
          <div className="row-between">
            <h3>תצוגה מקדימה</h3>
            <span className="row small">
              {previewing && <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden />}
              {preview && (
                <>
                  <span className="badge correct">{count(cards.length, 'כרטיס אחד', 'כרטיסים')}</span>
                  {skipped.length > 0 && <span className="badge warn">{count(skipped.length, 'שורה אחת דולגה', 'שורות דולגו')}</span>}
                </>
              )}
            </span>
          </div>
          {previewError && <div className="callout bad small">{previewError}</div>}
          {!text.trim() && <p className="small muted">הדבק טקסט כדי לראות כאן איך הכרטיסים ייקלטו.</p>}
          {preview && cards.length === 0 && (
            <div className="callout warn small">לא נמצאו כרטיסים. נסה לבחור מפריד אחר — למשל "פסיק" אם הייצוא נעשה עם פסיקים.</div>
          )}
          {cards.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--line-2)', borderRadius: 'var(--radius-sm)' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>שורה</th>
                    <th>מונח / שאלה</th>
                    <th>הגדרה / תשובה</th>
                    <th>סוג</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.slice(0, PREVIEW_ROWS).map((c) => (
                    <tr key={c.record}>
                      <td className="num muted">{c.record}</td>
                      <td dir="auto">{c.kind === 'cloze' ? <ClozeText text={c.prompt} reveal /> : c.term}</td>
                      <td dir="auto" className="pre">
                        {c.definition}
                      </td>
                      <td>
                        <span className={`badge ${c.kind === 'cloze' ? 'easy' : 'outline'}`}>{c.kind === 'cloze' ? 'השלמת משפט' : 'הגדרה'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cards.length > PREVIEW_ROWS && <p className="tiny muted">מוצגים {PREVIEW_ROWS} הראשונים מתוך {cards.length}. כולם ייובאו.</p>}
          {skipped.length > 0 && (
            <details>
              <summary className="small">{count(skipped.length, 'שורה אחת לא תיובא', 'שורות לא ייובאו')} — הצג למה</summary>
              <ul className="small" style={{ margin: '6px 0 0', paddingInlineStart: 20 }}>
                {skipped.slice(0, 100).map((s) => (
                  <li key={s.record}>
                    <span className="muted">שורה {s.record}:</span> {s.reason} — <span dir="auto">{s.text}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="stack">
          <h3>לאן לייבא</h3>
          <div className="form-grid">
            <label className="field">
              קורס
              <CourseSelect id="qz-course" courses={boot.courses} value={courseId} onChange={chooseCourse} noneLabel={boot.courses.length === 0 ? 'אין קורסים' : 'בחר קורס'} />
              {boot.courses.length === 0 && (
                <span className="hint">
                  צריך קורס כדי לייבא — <Link to="/topics">יצירת קורס בעמוד נושאים</Link>.
                </span>
              )}
            </label>
            <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.9rem', fontWeight: 600, color: 'var(--ink-2)' }}>
              <span id="qz-topic-label">נושא</span>
              <div className="seg" role="group" aria-labelledby="qz-topic-label">
                <button type="button" className={topicMode === 'new' ? 'on' : ''} aria-pressed={topicMode === 'new'} onClick={() => setTopicMode('new')}>
                  נושא חדש
                </button>
                <button
                  type="button"
                  className={topicMode === 'existing' ? 'on' : ''}
                  aria-pressed={topicMode === 'existing'}
                  onClick={() => setTopicMode('existing')}
                  disabled={topics.length === 0}
                  title={topics.length === 0 ? 'אין עדיין נושאים בקורס הזה' : undefined}
                >
                  נושא קיים
                </button>
              </div>
              {topicMode === 'new' ? (
                <input className="input" dir="auto" value={topicName} onChange={(e) => setTopicName(e.target.value)} placeholder="כרטיסים מיובאים" aria-label="שם הנושא החדש" />
              ) : (
                <select className="input" value={topicId} onChange={(e) => setTopicId(e.target.value)} aria-label="נושא קיים">
                  <option value="">בחר נושא…</option>
                  {topics.map((t) => (
                    <option key={t.id} value={String(t.id)}>
                      {t.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <label className="field">
              תאריך למידה
              <input type="date" className="input" value={learnedOn} onChange={(e) => setLearnedOn(e.target.value)} required />
              <span className="hint">החזרה הראשונה נקבעת מהתאריך הזה.</span>
            </label>
            <label className="field">
              שיעור
              <select className="input" value={lessonId} onChange={(e) => setLessonId(e.target.value)} disabled={!tree || tree.lessons.length === 0}>
                <option value="">{tree && tree.lessons.length === 0 ? 'אין שיעורים בקורס' : 'ללא שיעור'}</option>
                {tree?.lessons.map((l) => (
                  <option key={l.id} value={String(l.id)}>
                    {lessonLabel(l)}
                  </option>
                ))}
              </select>
              <span className="hint">לא חובה.</span>
            </label>
            <label className="field">
              מקור הכרטיסים
              <select className="input" value={sourceId} onChange={(e) => chooseSource(e.target.value)} disabled={approvedSources.length === 0}>
                <option value="">{approvedSources.length === 0 ? 'אין מקורות מאושרים בקורס' : 'ללא מקור'}</option>
                {approvedSources.map((s) => (
                  <option key={s.id} value={String(s.id)}>
                    {s.title} · {SOURCE_KIND_LABELS[s.kind]}
                  </option>
                ))}
              </select>
              <span className="hint">לא חובה. המקור שממנו כתבת את הכרטיסים — למשל המצגת של השיעור.</span>
            </label>
            <label className="field">
              מאיפה התשובות
              <select
                className="input"
                value={provenance}
                onChange={(e) => {
                  setProvenance(e.target.value as Provenance);
                  setProvTouched(true);
                }}
              >
                {PROVENANCES.map((p) => (
                  <option key={p} value={p}>
                    {PROVENANCE_LABELS[p]}
                  </option>
                ))}
              </select>
              <span className="hint">{PROVENANCE_EXPLAIN[provenance]}</span>
            </label>
          </div>

          <label className="check" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={reviewFirst} onChange={(e) => setReviewFirst(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              שלח קודם לבדיקה
              <span className="small muted" style={{ display: 'block', fontWeight: 400 }}>
                {reviewFirst
                  ? 'הכרטיסים ימתינו במסך "בדיקה ואישור", ורק אחרי שתאשר אותם הם ייכנסו לחזרות.'
                  : 'אלה הכרטיסים שלך, ולכן כברירת מחדל הם נכנסים ישר ללוח החזרות, החל מתאריך הלמידה. סמן כאן אם תרצה לעבור עליהם קודם.'}
              </span>
            </span>
          </label>
          <p className="tiny muted">כל הייבוא נרשם כפעולה אחת ביומן, ואפשר לבטל אותו מיד אחרי הייבוא.</p>
        </section>

        {error && <div className="callout bad">{error}</div>}
      </div>
    </Modal>
  );
}
