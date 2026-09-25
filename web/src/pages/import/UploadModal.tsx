// Upload one or more files: pick the course, kind and date first, then drop
// or choose files, then upload. Each file is extracted by the server as it
// arrives, so every row ends with its own result.

import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.ts';
import { useApp } from '../../App.tsx';
import { Link } from '../../router.tsx';
import { Modal } from '../../ui.tsx';
import type { SourceDTO } from '../../../../shared/api.ts';
import type { SourceKind } from '../../../../shared/types.ts';
import {
  CourseSelect,
  KindRole,
  KindSelect,
  SUPPORTED_UPLOAD_EXTENSIONS,
  SourceStatusBadge,
  count,
  extentLabel,
  fileExt,
  formatSize,
} from './common.tsx';

type ItemState = 'staged' | 'uploading' | 'done' | 'error' | 'unsupported';

interface Item {
  key: number;
  file: File;
  state: ItemState;
  result?: SourceDTO;
  error?: string;
}

export interface IncomingFiles {
  files: File[];
  seq: number;
}

export default function UploadModal(props: { incoming: IncomingFiles | null; onClose: () => void; onUploaded: () => void }) {
  const { boot } = useApp();
  const [courseId, setCourseId] = useState(boot.courses.length > 0 ? String(boot.courses[0].id) : '');
  const [kind, setKind] = useState<SourceKind | ''>('');
  const [studiedOn, setStudiedOn] = useState(boot.today);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const keySeq = useRef(1);

  const addFiles = (files: File[]) => {
    if (files.length === 0) return;
    setItems((xs) => [
      ...xs,
      ...files.map((file): Item => ({
        key: keySeq.current++,
        file,
        state: (SUPPORTED_UPLOAD_EXTENSIONS as readonly string[]).includes(fileExt(file.name)) ? 'staged' : 'unsupported',
      })),
    ]);
  };

  // Files dropped anywhere on the Import page arrive here.
  const lastSeq = useRef<number | null>(null);
  useEffect(() => {
    if (!props.incoming || props.incoming.seq === lastSeq.current) return;
    lastSeq.current = props.incoming.seq;
    addFiles(props.incoming.files);
  }, [props.incoming]);

  const patch = (key: number, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const staged = items.filter((i) => i.state === 'staged');

  async function uploadAll() {
    const todo = staged;
    if (todo.length === 0) return;
    const meta: Record<string, unknown> = {};
    if (courseId) meta.courseId = Number(courseId);
    if (kind) meta.kind = kind;
    if (studiedOn) meta.studiedOn = studiedOn;
    setBusy(true);
    // One at a time: the server extracts each file before answering.
    for (const it of todo) {
      patch(it.key, { state: 'uploading', error: undefined });
      try {
        const r = await api.upload<SourceDTO>('/sources/upload', it.file, meta);
        patch(it.key, { state: 'done', result: r });
      } catch (e) {
        patch(it.key, { state: 'error', error: e instanceof Error ? e.message : String(e) });
      }
    }
    setBusy(false);
    props.onUploaded();
  }

  const openPicker = () => inputRef.current?.click();

  return (
    <Modal
      title="העלאת קבצים"
      onClose={props.onClose}
      wide
      footer={
        <>
          <button className="btn primary" disabled={busy || staged.length === 0} onClick={() => void uploadAll()}>
            {busy ? (
              <>
                <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden /> מעלה ומחלץ…
              </>
            ) : staged.length > 0 ? (
              `העלה ${count(staged.length, 'קובץ אחד', 'קבצים')}`
            ) : (
              'העלה'
            )}
          </button>
          <button className="btn" onClick={props.onClose}>
            {items.some((i) => i.state === 'done') ? 'סיום' : 'ביטול'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="small muted">
          הקובץ נשמר כעותק בתוך המערכת, והטקסט מחולץ ממנו מיד — עם מספרי העמודים או השקופיות, כדי שכל שאלה תוכל להצביע למקום המדויק. הקובץ
          המקורי במחשב שלך לא משתנה.
        </p>

        <div className="form-grid">
          <label className="field">
            קורס
            <CourseSelect id="up-course" courses={boot.courses} value={courseId} onChange={setCourseId} noneLabel="ללא קורס — אשייך אחר כך" disabled={busy} />
            <span className="hint">{courseId ? 'כל הקבצים בהעלאה הזו ישויכו לקורס הזה.' : 'אפשר לשייך אחר כך, אבל אי אפשר לאשר מקור בלי קורס.'}</span>
          </label>
          <label className="field">
            סוג המקור
            <KindSelect id="up-kind" value={kind} onChange={setKind} allowAuto disabled={busy} />
            <KindRole kind={kind} />
          </label>
          <label className="field">
            תאריך למידה
            <input type="date" className="input" value={studiedOn} onChange={(e) => setStudiedOn(e.target.value)} disabled={busy} />
            <span className="hint">מתי למדת את החומר. השאר ריק לסילבוס או לחומר שעוד לא נלמד.</span>
          </label>
        </div>

        {boot.courses.length === 0 && (
          <div className="callout warn small">
            עדיין אין קורסים. אפשר להעלות בלי קורס, אבל כדי לאשר מקור צריך לשייך אותו לקורס — <Link to="/topics">יצירת קורס בעמוד נושאים</Link>.
          </div>
        )}

        <div
          role="button"
          tabIndex={0}
          aria-describedby="up-drop-help"
          onClick={openPicker}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openPicker();
            }
          }}
          onDragOver={(e) => {
            if (!Array.from(e.dataTransfer.types).includes('Files')) return;
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            if (!Array.from(e.dataTransfer.types).includes('Files')) return;
            e.preventDefault();
            // Handled here — keep the page-level drop handler from adding the same files again.
            e.stopPropagation();
            setOver(false);
            addFiles(Array.from(e.dataTransfer.files));
          }}
          style={{
            border: `2px dashed ${over ? 'var(--accent)' : 'var(--line)'}`,
            background: over ? 'var(--accent-soft)' : 'var(--surface-2)',
            borderRadius: 'var(--radius)',
            padding: '26px 16px',
            textAlign: 'center',
            cursor: 'pointer',
          }}
        >
          <div style={{ fontWeight: 650 }}>גרור לכאן קבצים, או לחץ כדי לבחור</div>
          <div id="up-drop-help" className="small muted">
            PDF · PowerPoint (PPTX) · Word (DOCX) · Excel (XLSX) · TXT · MD · CSV — אפשר כמה קבצים יחד
          </div>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          aria-label="בחירת קבצים להעלאה"
          accept={SUPPORTED_UPLOAD_EXTENSIONS.join(',')}
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />

        {items.length > 0 && (
          <div className="list" aria-live="polite">
            {items.map((it) => (
              <UploadRow
                key={it.key}
                item={it}
                busy={busy}
                onRemove={() => setItems((xs) => xs.filter((x) => x.key !== it.key))}
                onRetry={() => patch(it.key, { state: 'staged', error: undefined })}
              />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function UploadRow({ item, busy, onRemove, onRetry }: { item: Item; busy: boolean; onRemove: () => void; onRetry: () => void }) {
  const r = item.result;
  return (
    <div className="list-item" style={{ alignItems: 'flex-start' }}>
      <div className="grow stack" style={{ gap: 2 }}>
        <div className="row">
          <span dir="auto" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
            {item.file.name}
          </span>
          <span className="tiny muted">{formatSize(item.file.size)}</span>
        </div>
        {item.state === 'unsupported' && (
          <span className="small" style={{ color: 'var(--wrong)' }}>
            סוג קובץ לא נתמך ({fileExt(item.file.name) || 'ללא סיומת'}). נתמכים: {SUPPORTED_UPLOAD_EXTENSIONS.join(' ')}
          </span>
        )}
        {item.state === 'error' && (
          <span className="small" style={{ color: 'var(--wrong)' }}>
            {item.error}
          </span>
        )}
        {r && (
          <div className="row small">
            <SourceStatusBadge s={r.status} />
            <span className="muted">
              {[extentLabel(r.fileExt, r.pageCount), count(r.chunkCount, 'קטע טקסט אחד', 'קטעי טקסט')].filter(Boolean).join(' · ')}
            </span>
            {r.warnings.length > 0 && <span className="badge warn">{count(r.warnings.length, 'אזהרה אחת', 'אזהרות')}</span>}
            {r.duplicateOf !== null && <span className="badge warn">זהה למקור #{r.duplicateOf}</span>}
            {r.dupChunkCount > 0 && <span className="badge partial">{r.dupChunkCount} קטעים כפולים</span>}
            {r.extractError && <span style={{ color: 'var(--wrong)' }}>{r.extractError}</span>}
          </div>
        )}
      </div>
      <div className="row">
        {item.state === 'staged' && <span className="badge dashed">ממתין להעלאה</span>}
        {item.state === 'uploading' && (
          <span className="row small muted">
            <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden /> מעלה ומחלץ…
          </span>
        )}
        {r && (
          <Link to={`/import/source/${r.id}`} className="btn sm">
            לבדיקת הטקסט ←
          </Link>
        )}
        {item.state === 'error' && !busy && (
          <button className="btn sm" onClick={onRetry}>
            נסה שוב
          </button>
        )}
        {(item.state === 'staged' || item.state === 'unsupported' || item.state === 'error') && !busy && (
          <button className="btn ghost sm" onClick={onRemove} aria-label={`הסר את ${item.file.name}`}>
            הסר
          </button>
        )}
      </div>
    </div>
  );
}
