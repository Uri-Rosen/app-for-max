// Every page / slide / section extracted from a source, searchable, with
// duplicate markers and — once the source is approved — checkboxes that
// limit AI suggestions to the chosen chunks.

import { Fragment, useState } from 'react';
import { sourceFileUrl } from '../../api.ts';
import { Link } from '../../router.tsx';
import type { ChunkDTO, SourceDTO } from '../../../../shared/api.ts';
import { count } from './common.tsx';

const PAGE = 60;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRe(needle)})`, 'gi'));
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}

export default function ChunkViewer(props: {
  source: SourceDTO;
  chunks: ChunkDTO[];
  selectable: boolean;
  selected: Set<number>;
  onSelected: (s: Set<number>) => void;
  onlyDup: boolean;
  onOnlyDup: (v: boolean) => void;
}) {
  const { source, chunks, selectable, selected } = props;
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const needle = q.trim();
  const lower = needle.toLowerCase();
  const isPdf = source.fileExt === '.pdf';
  const hasFile = source.filePath !== null && source.status !== 'missing';
  const dupCount = chunks.filter((c) => c.duplicateOf).length;

  const shown = chunks.filter(
    (c) =>
      (!props.onlyDup || c.duplicateOf !== null) &&
      (!lower || [c.text, c.heading ?? '', c.notes ?? '', c.locatorLabel].some((t) => t.toLowerCase().includes(lower))),
  );
  const visible = shown.slice(0, limit);

  const toggle = (id: number, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    props.onSelected(next);
  };

  if (chunks.length === 0) {
    return (
      <section className="card" aria-labelledby="chunks-h">
        <h2 id="chunks-h">הטקסט שחולץ</h2>
        <div className="empty" style={{ padding: '24px 8px' }}>
          {source.status === 'new' && source.filePath !== null ? (
            <p>הטקסט עוד לא חולץ מהקובץ.</p>
          ) : source.filePath === null ? (
            <p>למקור הזה אין קובץ — הוא נשמר כהפניה (שיעור, קישור או הערה), ואין בו טקסט להצגה.</p>
          ) : source.status === 'error' || source.status === 'missing' ? (
            <p>לא חולץ טקסט. ראה את השגיאה למעלה.</p>
          ) : (
            <p>לא נמצא טקסט בקובץ. ייתכן שזו סריקה (תמונה) בלי שכבת טקסט — אפשר לפתוח את הקובץ המקורי ולבדוק.</p>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="card stack" aria-labelledby="chunks-h">
      <div className="row-between">
        <h2 id="chunks-h">
          הטקסט שחולץ <span className="muted small">({count(chunks.length, 'קטע אחד', 'קטעים')})</span>
        </h2>
        <div className="row">
          <label className="sr-only" htmlFor="chunk-q">
            חיפוש בטקסט שחולץ
          </label>
          <input
            id="chunk-q"
            type="search"
            className="input"
            style={{ width: 200 }}
            placeholder="חיפוש בטקסט"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setLimit(PAGE);
            }}
          />
          {dupCount > 0 && (
            <label className="check small">
              <input type="checkbox" checked={props.onlyDup} onChange={(e) => props.onOnlyDup(e.target.checked)} />
              רק כפולים ({dupCount})
            </label>
          )}
        </div>
      </div>

      {selectable && (
        <div className="callout small row-between">
          <span>
            {selected.size > 0
              ? selected.size === 1
                ? `נבחר קטע אחד מתוך ${chunks.length} — הצעות ה־AI יתבססו רק עליו.`
                : `נבחרו ${selected.size} מתוך ${chunks.length} — הצעות ה־AI יתבססו רק עליהם.`
              : 'אפשר לסמן קטעים כדי שהצעות ה־AI יתבססו רק עליהם. בלי סימון — על כל המקור.'}
          </span>
          <span className="row">
            {shown.length > 0 && shown.some((c) => !selected.has(c.id)) && (
              <button className="linkbtn small" onClick={() => props.onSelected(new Set([...selected, ...shown.map((c) => c.id)]))}>
                {needle || props.onlyDup ? `בחר את ${shown.length} המוצגים` : 'בחר הכל'}
              </button>
            )}
            {selected.size > 0 && (
              <button className="linkbtn small" onClick={() => props.onSelected(new Set())}>
                נקה בחירה
              </button>
            )}
          </span>
        </div>
      )}

      {needle && <p className="small muted">{shown.length === 0 ? `אין קטע שמכיל "${needle}".` : `${count(shown.length, 'קטע אחד מכיל', 'קטעים מכילים')} "${needle}".`}</p>}

      <div className="stack">
        {visible.map((c) => {
          const notesMatch = !!lower && !!c.notes && c.notes.toLowerCase().includes(lower);
          const labelId = `chunk-${c.id}-label`;
          return (
            <article
              key={c.id}
              className="card flat"
              aria-labelledby={labelId}
              style={{
                padding: 12,
                borderColor: selected.has(c.id) ? 'var(--accent)' : undefined,
                background: selected.has(c.id) ? 'var(--accent-soft)' : undefined,
              }}
            >
              <div className="row-between" style={{ marginBottom: 6, alignItems: 'flex-start' }}>
                <div className="row" style={{ minWidth: 0 }}>
                  {selectable && (
                    <label className="check">
                      <input type="checkbox" checked={selected.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                      <span className="sr-only">בחר את {c.locatorLabel} להצעות AI</span>
                    </label>
                  )}
                  <span id={labelId} className="badge outline">
                    {c.locatorLabel}
                  </span>
                  {c.heading && (
                    <strong dir="auto" style={{ overflowWrap: 'anywhere' }}>
                      <Highlight text={c.heading} needle={needle} />
                    </strong>
                  )}
                </div>
                <div className="row small">
                  {c.duplicateOf && (
                    <Link
                      to={`/import/source/${c.duplicateOf.sourceId}`}
                      className="badge warn"
                      title={`הטקסט זהה ל${c.duplicateOf.locatorLabel} במקור "${c.duplicateOf.sourceTitle}"`}
                    >
                      כפול: {c.duplicateOf.sourceTitle} · {c.duplicateOf.locatorLabel}
                    </Link>
                  )}
                  {isPdf && hasFile && c.locatorType === 'page' && (
                    <a href={sourceFileUrl(source.id, 'page', c.locatorNum, '.pdf')} target="_blank" rel="noreferrer">
                      פתח בעמוד ↗
                    </a>
                  )}
                </div>
              </div>
              <div className="pre" dir="auto" style={{ overflowWrap: 'anywhere' }}>
                <Highlight text={c.text} needle={needle} />
              </div>
              {c.notes && (
                <details open={notesMatch || undefined} style={{ marginTop: 8 }}>
                  <summary className="small muted" style={{ cursor: 'pointer' }}>
                    הערות מרצה
                  </summary>
                  <div className="pre small quote" dir="auto" style={{ marginTop: 4 }}>
                    <Highlight text={c.notes} needle={needle} />
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </div>

      {shown.length > visible.length && (
        <div style={{ textAlign: 'center' }}>
          <button className="btn" onClick={() => setLimit((l) => l + PAGE)}>
            הצג עוד {Math.min(PAGE, shown.length - visible.length)} (מוצגים {visible.length} מתוך {shown.length})
          </button>
        </div>
      )}
    </section>
  );
}
