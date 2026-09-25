// The editable details of one source. State lives in the Source page so that
// approving can save unsaved changes first.

import { useApp } from '../../App.tsx';
import { Link } from '../../router.tsx';
import type { CourseTreeDTO, SourceDTO } from '../../../../shared/api.ts';
import type { SourceKind } from '../../../../shared/types.ts';
import { CourseSelect, KIND_GUIDANCE, KindRole, KindSelect, lessonLabel } from './common.tsx';

export interface SourceDraft {
  title: string;
  kind: SourceKind;
  courseId: string;
  studiedOn: string;
  lessonIds: number[];
  notes: string;
  url: string;
}

export function draftFrom(s: SourceDTO): SourceDraft {
  return {
    title: s.title,
    kind: s.kind,
    courseId: s.courseId === null ? '' : String(s.courseId),
    studiedOn: s.studiedOn ?? '',
    lessonIds: [...s.lessonIds].sort((a, b) => a - b),
    notes: s.notes ?? '',
    url: s.url ?? '',
  };
}

export function draftEquals(a: SourceDraft, b: SourceDraft): boolean {
  return (
    a.title.trim() === b.title.trim() &&
    a.kind === b.kind &&
    a.courseId === b.courseId &&
    a.studiedOn === b.studiedOn &&
    a.notes.trim() === b.notes.trim() &&
    a.url.trim() === b.url.trim() &&
    a.lessonIds.length === b.lessonIds.length &&
    a.lessonIds.every((id, i) => id === b.lessonIds[i])
  );
}

export function draftProblem(d: SourceDraft): string | null {
  if (!d.title.trim()) return 'חסרה כותרת';
  if (d.url.trim() && !/^https?:\/\//i.test(d.url.trim())) return 'קישור צריך להתחיל ב־http:// או https://';
  return null;
}

export function draftBody(d: SourceDraft): Record<string, unknown> {
  return {
    title: d.title.trim(),
    kind: d.kind,
    courseId: d.courseId ? Number(d.courseId) : null,
    studiedOn: d.studiedOn || null,
    lessonIds: d.lessonIds,
    notes: d.notes,
    url: d.url.trim(),
  };
}

export default function SourceMetaForm(props: {
  draft: SourceDraft;
  onChange: (d: SourceDraft) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
  tree: CourseTreeDTO | null;
  treeLoading: boolean;
}) {
  const { boot } = useApp();
  const d = props.draft;
  const set = (p: Partial<SourceDraft>) => props.onChange({ ...d, ...p });
  const problem = draftProblem(d);
  const lessons = props.tree?.lessons ?? [];
  const cautious = d.kind === 'student_summary' || d.kind === 'past_exam' || d.kind === 'syllabus';

  return (
    <section className="card" aria-labelledby="meta-h">
      <div className="card-title">
        <h2 id="meta-h">פרטי המקור</h2>
        {props.dirty && <span className="badge partial">לא נשמר</span>}
      </div>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (props.dirty && !problem) props.onSave();
        }}
      >
        <label className="field">
          כותרת
          <input className="input" dir="auto" value={d.title} onChange={(e) => set({ title: e.target.value })} required />
        </label>

        <label className="field">
          סוג המקור
          <KindSelect id="meta-kind" value={d.kind} onChange={(k) => k && set({ kind: k })} />
          <KindRole kind={d.kind} />
        </label>
        <div className={`callout small ${cautious ? 'warn' : ''}`}>{KIND_GUIDANCE[d.kind]}</div>

        <label className="field">
          קורס
          <CourseSelect id="meta-course" courses={boot.courses} value={d.courseId} onChange={(v) => set({ courseId: v, lessonIds: [] })} noneLabel="ללא קורס" />
          {!d.courseId && <span className="hint">כדי לאשר את המקור צריך לשייך אותו לקורס.</span>}
        </label>

        <label className="field">
          תאריך למידה
          <input type="date" className="input" value={d.studiedOn} onChange={(e) => set({ studiedOn: e.target.value })} />
          <span className="hint">יחידות שייווצרו מהמקור יקבלו את התאריך הזה כתאריך למידה.</span>
        </label>

        <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <legend className="small" style={{ fontWeight: 600, color: 'var(--ink-2)', padding: 0, marginBottom: 4 }}>
            שיעורים
          </legend>
          {!d.courseId ? (
            <p className="small muted">בחר קורס כדי לקשר את המקור לשיעורים.</p>
          ) : props.treeLoading ? (
            <p className="small muted">טוען שיעורים…</p>
          ) : lessons.length === 0 ? (
            <p className="small muted">
              אין שיעורים בקורס הזה. אפשר להוסיף ב<Link to={`/topics/${d.courseId}`}>עמוד הנושאים של הקורס</Link>.
            </p>
          ) : (
            <div className="stack" style={{ gap: 4, maxHeight: 200, overflowY: 'auto' }}>
              {lessons.map((l) => (
                <label key={l.id} className="check small">
                  <input
                    type="checkbox"
                    checked={d.lessonIds.includes(l.id)}
                    onChange={(e) =>
                      set({
                        lessonIds: e.target.checked ? [...d.lessonIds, l.id].sort((a, b) => a - b) : d.lessonIds.filter((x) => x !== l.id),
                      })
                    }
                  />
                  <span dir="auto">{lessonLabel(l)}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <label className="field">
          קישור
          <input className="input ltr" type="url" inputMode="url" value={d.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://…" />
        </label>

        <label className="field">
          הערות
          <textarea className="input" dir="auto" rows={3} value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>

        {problem && props.dirty && (
          <div className="small" style={{ color: 'var(--wrong)' }}>
            {problem}
          </div>
        )}
        <div className="row">
          <button type="submit" className="btn primary" disabled={!props.dirty || !!problem || props.saving}>
            {props.saving ? 'שומר…' : 'שמור'}
          </button>
          {props.dirty && (
            <button type="button" className="btn ghost" onClick={props.onReset} disabled={props.saving}>
              בטל שינויים
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
