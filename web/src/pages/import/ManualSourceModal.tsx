// A source entered by hand: a lesson you heard, a book chapter, a web page,
// or a file on disk that stays where it is.

import { useState } from 'react';
import { api } from '../../api.ts';
import { useApp } from '../../App.tsx';
import { Link } from '../../router.tsx';
import { Modal } from '../../ui.tsx';
import type { SourceDTO } from '../../../../shared/api.ts';
import type { SourceKind } from '../../../../shared/types.ts';
import { CourseSelect, KindRole, KindSelect, lessonLabel, useCourseTree } from './common.tsx';

export default function ManualSourceModal(props: { onClose: () => void; onCreated: (s: SourceDTO) => void }) {
  const { boot } = useApp();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<SourceKind>('manual');
  const [courseId, setCourseId] = useState(boot.courses.length > 0 ? String(boot.courses[0].id) : '');
  const [studiedOn, setStudiedOn] = useState(boot.today);
  const [lessonId, setLessonId] = useState('');
  const [url, setUrl] = useState('');
  const [filePath, setFilePath] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { tree, loading: treeLoading } = useCourseTree(courseId ? Number(courseId) : null);

  const urlBad = url.trim() !== '' && !/^https?:\/\//i.test(url.trim());
  const canSave = title.trim() !== '' && !urlBad && !busy;

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { title: title.trim(), kind };
      if (courseId) body.courseId = Number(courseId);
      if (studiedOn) body.studiedOn = studiedOn;
      if (lessonId) body.lessonId = Number(lessonId);
      if (url.trim()) body.url = url.trim();
      if (filePath.trim()) body.filePath = filePath.trim().replace(/^"(.*)"$/, '$1');
      if (notes.trim()) body.notes = notes.trim();
      const s = await api.post<SourceDTO>('/sources/manual', body);
      props.onCreated(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="מקור ידני"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn primary" disabled={!canSave} onClick={() => void save()}>
            {busy ? 'מוסיף…' : 'הוסף מקור'}
          </button>
          <button className="btn" onClick={props.onClose}>
            ביטול
          </button>
        </>
      }
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="small muted">
          למקור שאין לו קובץ לייבוא — שיעור ששמעת, פרק בספר או עמוד באינטרנט — או לקובץ שנשאר במקומו במחשב. כך כל שאלה שתיכתב ממנו תוכל
          להצביע עליו.
        </p>

        <label className="field">
          כותרת
          <input className="input" dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus placeholder="למשל: הרצאה 4 — מסלולי איתות" />
        </label>

        <div className="form-grid">
          <label className="field">
            סוג המקור
            <KindSelect id="man-kind" value={kind} onChange={(k) => k && setKind(k)} />
            <KindRole kind={kind} />
          </label>
          <label className="field">
            קורס
            <CourseSelect
              id="man-course"
              courses={boot.courses}
              value={courseId}
              onChange={(v) => {
                setCourseId(v);
                setLessonId('');
              }}
              noneLabel="ללא קורס"
            />
          </label>
          <label className="field">
            תאריך למידה
            <input type="date" className="input" value={studiedOn} onChange={(e) => setStudiedOn(e.target.value)} />
          </label>
          <label className="field">
            שיעור
            <select className="input" value={lessonId} onChange={(e) => setLessonId(e.target.value)} disabled={!tree || tree.lessons.length === 0}>
              <option value="">{!courseId ? 'בחר קורס קודם' : treeLoading ? 'טוען…' : tree && tree.lessons.length === 0 ? 'אין שיעורים בקורס' : 'ללא שיעור'}</option>
              {tree?.lessons.map((l) => (
                <option key={l.id} value={String(l.id)}>
                  {lessonLabel(l)}
                </option>
              ))}
            </select>
            {courseId && tree && tree.lessons.length === 0 && (
              <span className="hint">
                אפשר להוסיף שיעורים ב<Link to={`/topics/${courseId}`}>עמוד הנושאים של הקורס</Link>.
              </span>
            )}
          </label>
        </div>

        <label className="field">
          קישור לעמוד
          <input
            className="input ltr"
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            aria-invalid={urlBad}
          />
          {urlBad ? (
            <span className="hint" style={{ color: 'var(--wrong)' }}>
              קישור צריך להתחיל ב־http:// או https://
            </span>
          ) : (
            <span className="hint">לא חובה. למשל עמוד הקורס במודל, סרטון או מאמר.</span>
          )}
        </label>

        <label className="field">
          נתיב לקובץ במחשב
          <input className="input ltr" value={filePath} onChange={(e) => setFilePath(e.target.value)} placeholder="C:\Users\…\הרצאה 4.pdf" spellCheck={false} />
          <span className="hint">
            לא חובה. הקובץ נקרא בלבד — לא מועתק, לא מוזז ולא משתנה. אם הוא PDF, Word, PowerPoint, Excel או טקסט, הטקסט ייחלץ ממנו ויחכה לאישור;
            קובץ מסוג אחר (למשל תמונה) נשמר כהפניה בלבד.
          </span>
        </label>

        <label className="field">
          הערות
          <textarea className="input" dir="auto" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="מה נלמד, באיזה פרק, מה חשוב לזכור" />
        </label>

        {error && <div className="callout bad">{error}</div>}
        {/* Enter in a text field submits. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}
