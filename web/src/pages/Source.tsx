// One source: its details, extraction status and warnings, the extracted
// text page by page, approval, and — once approved — AI suggestions.

import { useEffect, useState } from 'react';
import { api, sourceFileUrl } from '../api.ts';
import { useApp } from '../App.tsx';
import { Link } from '../router.tsx';
import { ErrorBox, Loading, useLoad, useToast } from '../ui.tsx';
import type { SourceDTO } from '../../../shared/api.ts';
import { SOURCE_KIND_LABELS, formatDate } from '../../../shared/labels.ts';
import AiPanel from './import/AiPanel.tsx';
import ApproveModal from './import/ApproveModal.tsx';
import ChunkViewer from './import/ChunkViewer.tsx';
import SourceMetaForm, { draftBody, draftEquals, draftFrom, draftProblem, type SourceDraft } from './import/SourceMetaForm.tsx';
import {
  ORIGIN_LABELS,
  SOURCE_STATUS_EXPLAIN,
  SourceStatusBadge,
  count,
  extLabel,
  extentLabel,
  formatIsoDay,
  formatSize,
  isExtracting,
  locatorNoun,
  useCourseTree,
  useMedia,
  type SourceWithChunks,
} from './import/common.tsx';

type Action = 'approve' | 'ignore' | 'restore' | 'extract';

const ACTION_DONE: Record<Action, string> = {
  approve: 'המקור אושר',
  ignore: 'המקור הוסתר — אפשר להחזיר אותו בכל עת',
  restore: 'המקור הוחזר',
  extract: 'הטקסט חולץ מחדש',
};

export default function SourcePage({ sourceId }: { sourceId: number }) {
  const { data, error, reload, setData } = useLoad<SourceWithChunks>(`/sources/${sourceId}`);
  if (!data) {
    return (
      <div className="stack">
        <div className="crumbs">
          <Link to="/import">ייבוא</Link>
        </div>
        {error ? <ErrorBox error={error} retry={() => void reload()} /> : <Loading />}
      </div>
    );
  }
  return <SourceView data={data} setData={setData} />;
}

function SourceView({ data, setData }: { data: SourceWithChunks; setData: (d: SourceWithChunks) => void }) {
  const { boot, refresh } = useApp();
  const toast = useToast();
  const { source, chunks } = data;
  const narrow = useMedia('(max-width: 900px)');

  const [draft, setDraft] = useState<SourceDraft>(() => draftFrom(source));
  const dirty = !draftEquals(draft, draftFrom(source));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [onlyDup, setOnlyDup] = useState(false);

  const draftCourseId = draft.courseId ? Number(draft.courseId) : null;
  const { tree, loading: treeLoading } = useCourseTree(draftCourseId);

  // Other sources, only when this one points at them (duplicate / versions).
  const needRelated = source.duplicateOf !== null || source.status === 'changed' || source.previousVersionId !== null;
  const { data: related } = useLoad<SourceDTO[]>(needRelated ? '/sources' : null);
  const dupOf = source.duplicateOf !== null ? related?.find((s) => s.id === source.duplicateOf) : undefined;
  const prevVersion = source.previousVersionId !== null ? related?.find((s) => s.id === source.previousVersionId) : undefined;
  const newerVersion =
    source.status === 'changed' ? related?.filter((s) => s.previousVersionId === source.id).sort((a, b) => b.id - a.id)[0] : undefined;

  const fetchFull = async (): Promise<SourceWithChunks> => {
    const full = await api.get<SourceWithChunks>(`/sources/${source.id}`);
    setData(full);
    return full;
  };

  // Extraction runs in the background after a folder scan: poll while the
  // server's queue runs. A 'new' source with no queue running is stuck (e.g.
  // restored after an error) and gets a "חלץ עכשיו" button instead.
  const waiting = isExtracting(source);
  const extracting = waiting && boot.importing;
  const stuck = waiting && !boot.importing;
  useEffect(() => {
    // boot.importing may be stale: confirm once.
    if (waiting) void refresh();
  }, [waiting, refresh]);
  useEffect(() => {
    if (!extracting) return;
    const t = setInterval(() => {
      api
        .get<SourceWithChunks>(`/sources/${source.id}`)
        .then((full) => {
          setData(full);
          if (!isExtracting(full.source)) void refresh();
        })
        .catch(() => {
          // try again on the next tick
        });
      void refresh();
    }, 2000);
    return () => clearInterval(t);
  }, [extracting, source.id, setData, refresh]);

  async function save(): Promise<boolean> {
    const problem = draftProblem(draft);
    if (problem) {
      toast.error(new Error(problem));
      return false;
    }
    setSaving(true);
    try {
      const s = await api.put<SourceDTO>(`/sources/${source.id}`, draftBody(draft));
      setData({ source: s, chunks });
      setDraft(draftFrom(s));
      toast.info('פרטי המקור נשמרו');
      void refresh();
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function act(a: Action): Promise<boolean> {
    setBusy(a);
    setActionError(null);
    try {
      const s = await api.post<SourceDTO>(`/sources/${source.id}/${a}`);
      await fetchFull();
      if (a === 'extract') setSelected(new Set());
      if (a === 'extract' && (s.status === 'error' || s.status === 'missing')) toast.error(new Error(s.extractError ?? 'החילוץ נכשל'));
      else toast.info(ACTION_DONE[a]);
      void refresh();
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (dirty && !(await save())) return;
    await act('approve');
    setApproveOpen(false);
  }

  const courseName = (id: string) => boot.courses.find((c) => String(c.id) === id)?.name ?? (id ? `קורס #${id}` : '—');
  const hasFile = source.filePath !== null && source.status !== 'missing';
  const approvable = ['extracted', 'partial', 'changed'].includes(source.status);
  const approveBlock = !approvable
    ? source.status === 'new'
      ? 'אפשר לאשר אחרי שהטקסט יחולץ.'
      : source.status === 'error' || source.status === 'missing'
        ? 'אי אפשר לאשר מקור שהטקסט שלו לא חולץ.'
        : null
    : !draft.courseId
      ? 'כדי לאשר, בחר קורס בפרטי המקור.'
      : null;
  const selectable = source.status === 'approved' && chunks.length > 0;
  const extent = extentLabel(source.fileExt, source.pageCount);
  const noun = locatorNoun(source.fileExt);

  const meta = [
    ORIGIN_LABELS[source.origin],
    extLabel(source.fileExt),
    formatSize(source.fileSize),
    extent,
    source.studiedOn ? `נלמד ${formatDate(source.studiedOn)}` : null,
    `נוסף ${formatIsoDay(source.addedAt)}`,
  ].filter(Boolean);

  const metaForm = (
    <SourceMetaForm
      draft={draft}
      onChange={setDraft}
      dirty={dirty}
      saving={saving}
      onSave={() => void save()}
      onReset={() => setDraft(draftFrom(source))}
      tree={tree}
      treeLoading={treeLoading}
    />
  );

  const aiArea =
    source.status === 'approved' ? (
      chunks.length > 0 ? (
        <AiPanel
          source={source}
          chunkTotal={chunks.length}
          selected={selected}
          onClearSelection={() => setSelected(new Set())}
          topicNames={[...new Set((tree?.topics ?? []).filter((t) => t.status === 'active' || t.status === 'proposed').map((t) => t.name))]}
          onDone={() => {
            void fetchFull().catch(() => undefined);
            void refresh();
          }}
        />
      ) : (
        <div className="card flat small muted">אין במקור הזה טקסט שחולץ, ולכן אי אפשר לבקש ממנו הצעות AI.</div>
      )
    ) : (
      <div className="card flat small muted">
        <strong>הצעות AI</strong> — אחרי שתאשר את המקור, כאן אפשר לבקש הצעות לנושאים, ליחידות ולשאלות. הן יגיעו למסך בדיקה ואישור.
      </div>
    );

  const aside =
    source.status === 'approved' ? (
      <div className="stack">
        {aiArea}
        {metaForm}
      </div>
    ) : (
      <div className="stack">
        {metaForm}
        {aiArea}
      </div>
    );

  const main = (
    <ChunkViewer
      source={source}
      chunks={chunks}
      selectable={selectable}
      selected={selected}
      onSelected={setSelected}
      onlyDup={onlyDup}
      onOnlyDup={setOnlyDup}
    />
  );

  // break-word: error texts can carry long unbroken file names.
  return (
    <div className="stack-lg" style={{ overflowWrap: 'break-word' }}>
      <div>
        <div className="crumbs">
          <Link to="/import">ייבוא</Link>
          <span aria-hidden>›</span>
          <span dir="auto">{source.title}</span>
        </div>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div style={{ minWidth: 0 }}>
            <h1 dir="auto" style={{ overflowWrap: 'anywhere' }}>
              {source.title}
            </h1>
            <p className="row small" style={{ gap: 6 }}>
              <span className="badge outline">{SOURCE_KIND_LABELS[source.kind]}</span>
              <span>{meta.join(' · ')}</span>
            </p>
            {source.origin !== 'upload' && source.filePath && (
              <p className="tiny ltr" style={{ overflowWrap: 'anywhere' }}>
                {source.filePath}
              </p>
            )}
          </div>
          <div className="row">
            {hasFile && (
              <a
                className="btn"
                href={sourceFileUrl(source.id)}
                target="_blank"
                rel="noreferrer"
                title="נפתח בדפדפן לקריאה בלבד (או יורד, לפי סוג הקובץ). הקובץ עצמו לא משתנה."
              >
                פתח את הקובץ המקורי ↗
              </a>
            )}
            {source.url && (
              <a className="btn" href={source.url} target="_blank" rel="noreferrer">
                פתח את הקישור ↗
              </a>
            )}
          </div>
        </div>
      </div>

      <section className="card stack" aria-label="מצב המקור">
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div className="stack" style={{ gap: 4, minWidth: 0, flex: '1 1 280px' }}>
            <div className="row">
              <SourceStatusBadge s={source.status} />
              {source.status === 'approved' && source.approvedAt && <span className="small muted">אושר ב־{formatIsoDay(source.approvedAt)}</span>}
            </div>
            <span className="small">
              {stuck
                ? 'הטקסט עוד לא חולץ, והחילוץ ברקע לא פועל כרגע. לחץ "חלץ עכשיו".'
                : source.status === 'approved' && source.filePath === null
                  ? 'מקור בלי קובץ נשמר כהפניה ומאושר מיד — שאלות ויחידות יכולות להצביע עליו.'
                  : SOURCE_STATUS_EXPLAIN[source.status]}
            </span>
          </div>
          <div className="row">
            {source.status !== 'approved' && source.status !== 'ignored' && (
              <button
                className={`btn ${approveBlock ? '' : 'primary'}`}
                disabled={!!approveBlock || busy !== null}
                onClick={() => setApproveOpen(true)}
                title={approveBlock ?? undefined}
              >
                אשר מקור
              </button>
            )}
            {source.status === 'ignored' && (
              <button className="btn primary" disabled={busy !== null} onClick={() => void act('restore')}>
                {busy === 'restore' ? 'מחזיר…' : 'החזר'}
              </button>
            )}
            {source.filePath !== null && (
              <button className={`btn ${stuck ? 'primary' : ''}`} disabled={busy !== null || extracting} onClick={() => void act('extract')}>
                {busy === 'extract' ? 'מחלץ…' : waiting ? 'חלץ עכשיו' : 'חלץ מחדש'}
              </button>
            )}
            {/* Un-approving a file-less source would leave it in 'new' with nothing to extract. */}
            {source.status === 'approved' && source.filePath !== null && (
              <button
                className="btn ghost"
                disabled={busy !== null}
                onClick={() => void act('restore')}
                title="המקור יחזור למצב 'חולץ — ממתין לאישור'. הצעות ושאלות שכבר נוצרו ממנו נשארות."
              >
                {busy === 'restore' ? 'מחזיר…' : 'בטל אישור'}
              </button>
            )}
            {source.status !== 'ignored' && (
              <button
                className="btn ghost"
                disabled={busy !== null}
                onClick={() => void act('ignore')}
                title="מסתיר את המקור מהייבוא ומההצעות. שום דבר לא נמחק, ואפשר להחזיר."
              >
                {busy === 'ignore' ? 'מסתיר…' : 'התעלם'}
              </button>
            )}
          </div>
        </div>

        {approveBlock && !waiting && <p className="small muted">{approveBlock}</p>}
        {actionError && <div className="callout bad">{actionError}</div>}

        {source.extractError && (
          <div className="callout bad">
            <strong>שגיאה בחילוץ הטקסט:</strong> {source.extractError}
          </div>
        )}

        {source.warnings.length > 0 && <Warnings warnings={source.warnings} />}

        {source.duplicateOf !== null && (
          <div className="callout warn">
            <strong>הקובץ כולו זהה למקור אחר:</strong>{' '}
            <Link to={`/import/source/${source.duplicateOf}`}>
              #{source.duplicateOf}
              {dupOf ? ` — ${dupOf.title}` : ''}
            </Link>
            . אין צורך לאשר את שניהם — אפשר להתעלם מאחד מהם.
          </div>
        )}

        {source.dupChunkCount > 0 && (
          <div className="callout row-between">
            <span>
              {source.dupChunkCount} מתוך {source.chunkCount} ה{noun} {source.dupChunkCount === 1 ? 'זהה' : 'זהים'} לטקסט במקורות אחרים. הם
              מסומנים ברשימה עם קישור למקור השני.
            </span>
            <button className="btn sm" onClick={() => setOnlyDup(!onlyDup)} aria-pressed={onlyDup}>
              {onlyDup ? 'הצג הכל' : 'הצג רק אותם'}
            </button>
          </div>
        )}

        {source.status === 'changed' && (
          <div className="callout info">
            {newerVersion ? (
              <>
                הגרסה החדשה של הקובץ:{' '}
                <Link to={`/import/source/${newerVersion.id}`}>
                  #{newerVersion.id} — {newerVersion.title}
                </Link>
                . כדאי לבדוק ולאשר אותה במקום הגרסה הזו.
              </>
            ) : (
              'גרסה חדשה של הקובץ נרשמה כמקור נפרד ברשימת הייבוא.'
            )}
          </div>
        )}

        {source.previousVersionId !== null && (
          <div className="callout info">
            זו גרסה חדשה של{' '}
            <Link to={`/import/source/${source.previousVersionId}`}>
              #{source.previousVersionId}
              {prevVersion ? ` — ${prevVersion.title}` : ''}
            </Link>
            . שאלות שמצטטות את הגרסה הקודמת ממשיכות להצביע עליה.
          </div>
        )}

        {(source.linkCount > 0 || source.proposalCount > 0) && (
          <p className="small muted">
            {source.linkCount === 1 && 'קישור אחד (משאלה, יחידה או נושא) מצביע על המקור הזה. '}
            {source.linkCount > 1 && `${source.linkCount} קישורים משאלות, יחידות ונושאים מצביעים על המקור הזה. `}
            {source.proposalCount > 0 && (
              <>
                {count(source.proposalCount, 'שאלה אחת ממנו ממתינה', 'שאלות ממנו ממתינות')} לבדיקה — <Link to="/review">לבדיקה ואישור ←</Link>
              </>
            )}
          </p>
        )}
      </section>

      <div className="grid-2">
        {narrow ? (
          <>
            {aside}
            {main}
          </>
        ) : (
          <>
            {main}
            {aside}
          </>
        )}
      </div>

      {approveOpen && (
        <ApproveModal
          source={source}
          kind={draft.kind}
          courseName={courseName(draft.courseId)}
          dirty={dirty}
          busy={saving || busy === 'approve'}
          onConfirm={() => void approve()}
          onClose={() => setApproveOpen(false)}
        />
      )}
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  const first = warnings.slice(0, 5);
  const rest = warnings.slice(5);
  return (
    <div className="callout warn">
      <strong>{count(warnings.length, 'אזהרה אחת מהחילוץ', 'אזהרות מהחילוץ')}</strong>
      <ul className="small" style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
        {first.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="small">
          <summary style={{ cursor: 'pointer' }}>ועוד {rest.length}</summary>
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
            {rest.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="tiny" style={{ marginTop: 6 }}>
        עמוד בלי שכבת טקסט הוא בדרך כלל סריקה או תמונה. אם יש בו חומר חשוב, אפשר לפתוח את הקובץ המקורי ולהוסיף את החומר כמקור ידני.
      </p>
    </div>
  );
}
