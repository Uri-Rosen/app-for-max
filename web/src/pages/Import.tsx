// Import: every file found in a course folder, uploaded or entered by hand,
// with its extraction status and errors — plus the Quizlet paste path.
// Nothing here enters the schedule; sources are approved one by one.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../App.tsx';
import { Link, go } from '../router.tsx';
import { ErrorBox, Loading, useLoad, useToast, useUndoToast } from '../ui.tsx';
import type { CourseDTO, ScanResultDTO, SourceDTO } from '../../../shared/api.ts';
import {
  STATUS_GROUP_LABELS,
  count,
  inGroup,
  isExtracting,
  type StatusGroup,
} from './import/common.tsx';
import ManualSourceModal from './import/ManualSourceModal.tsx';
import QuizletModal, { type CardsImported } from './import/QuizletModal.tsx';
import SourcesTable from './import/SourcesTable.tsx';
import UploadModal, { type IncomingFiles } from './import/UploadModal.tsx';

type ModalKind = 'upload' | 'manual' | 'quizlet';
type ScanState = { kind: 'result'; r: ScanResultDTO } | { kind: 'no-folders' };

const GROUPS: StatusGroup[] = ['attention', 'approved', 'all'];

export default function ImportPage() {
  const { boot, refresh } = useApp();
  const toast = useToast();
  const [imported, setImported] = useState<CardsImported | null>(null);
  const undo = useUndoToast(() => {
    setImported(null);
    void refresh();
  });
  const { data: sources, error, reload, setData } = useLoad<SourceDTO[]>('/sources');

  const [modal, setModal] = useState<ModalKind | null>(null);
  const [incoming, setIncoming] = useState<IncomingFiles | null>(null);
  const [quizletText, setQuizletText] = useState('');
  const [scan, setScan] = useState<ScanState | null>(null);
  const [scanning, setScanning] = useState(false);
  const [pageDrag, setPageDrag] = useState(false);

  const [group, setGroup] = useState<StatusGroup | null>(null);
  const [courseFilter, setCourseFilter] = useState('');
  const [q, setQ] = useState('');

  const courses = useMemo(() => new Map<number, CourseDTO>(boot.courses.map((c) => [c.id, c])), [boot.courses]);
  const watched = boot.courses.filter((c) => c.watchFolder);

  // ----- background extraction: poll while the server's queue is running -----
  // A source can sit in 'new' with no queue running (e.g. restored after an
  // error); that one is "stuck", not "extracting", and polling won't help it.
  const waiting = (sources ?? []).filter(isExtracting).length;
  const stuck = waiting > 0 && !boot.importing;
  useEffect(() => {
    // boot.importing may be stale: confirm once before calling anything stuck.
    if (stuck) void refresh();
  }, [stuck, refresh]);
  useEffect(() => {
    if (!boot.importing) return;
    const t = setInterval(() => {
      api
        .get<SourceDTO[]>('/sources')
        .then(setData)
        .catch(() => {
          // keep polling; the next tick may succeed
        });
      void refresh(); // keeps boot.importing and the nav counts current
    }, 2000);
    return () => {
      clearInterval(t);
      // One last read so the rows the queue just finished show their final status.
      void api.get<SourceDTO[]>('/sources').then(setData).catch(() => undefined);
    };
  }, [boot.importing, refresh, setData]);

  const reloadQuiet = async () => {
    try {
      setData(await api.get<SourceDTO[]>('/sources'));
    } catch (e) {
      toast.error(e);
    }
  };

  // ----- drop files anywhere on the page -----
  const modalRef = useRef<ModalKind | null>(null);
  modalRef.current = modal;
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setPageDrag(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setPageDrag(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const reset = () => {
      depth = 0;
      setPageDrag(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      if (modalRef.current && modalRef.current !== 'upload') return;
      setIncoming({ files, seq: Date.now() });
      setModal('upload');
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    // Capture phase: runs even when a drop zone stops the event.
    window.addEventListener('drop', reset, true);
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // ----- actions -----
  async function runScan() {
    if (watched.length === 0) {
      setScan({ kind: 'no-folders' });
      return;
    }
    setScanning(true);
    try {
      const r = await api.post<ScanResultDTO>('/sources/scan');
      setScan({ kind: 'result', r });
      await reloadQuiet();
      void refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setScanning(false);
    }
  }

  function openUpload() {
    setIncoming(null);
    setModal('upload');
  }

  function onCardsImported(r: CardsImported) {
    setModal(null);
    setQuizletText('');
    setImported(r);
    undo(`יובאו ${count(r.result.units, 'כרטיס אחד', 'כרטיסים')} לנושא "${r.topicName}"`, r.result.auditId);
    void refresh();
  }

  // ----- filtering -----
  const all = sources ?? [];
  const byCourse = all.filter((s) =>
    courseFilter === '' ? true : courseFilter === 'none' ? s.courseId === null : s.courseId === Number(courseFilter),
  );
  const counts: Record<StatusGroup, number> = {
    attention: byCourse.filter((s) => inGroup(s, 'attention')).length,
    approved: byCourse.filter((s) => inGroup(s, 'approved')).length,
    all: byCourse.length,
  };
  const activeGroup: StatusGroup = group ?? (counts.attention > 0 ? 'attention' : 'all');
  const needle = q.trim().toLowerCase();
  const shown = byCourse.filter((s) => inGroup(s, activeGroup) && (!needle || s.title.toLowerCase().includes(needle)));
  const orphanCourseIds = [...new Set(all.map((s) => s.courseId).filter((id): id is number => id !== null && !courses.has(id)))];

  // break-word: error texts can carry long unbroken file names.
  return (
    <div className="stack-lg" style={{ overflowWrap: 'break-word' }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>ייבוא</h1>
          <p>קבצים שנמצאו, מצב חילוץ הטקסט ושגיאות. שום חומר לא משמש לשאלות לפני שאישרת אותו.</p>
        </div>
        <div className="row">
          <button
            className={`btn ${watched.length > 0 ? 'primary' : ''}`}
            onClick={() => void runScan()}
            disabled={scanning}
            title="קורא את הקבצים בתיקיות של הקורסים ורושם קבצים חדשים או שהשתנו. הקבצים עצמם לא משתנים."
          >
            {scanning ? (
              <>
                <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden /> סורק…
              </>
            ) : (
              'סרוק תיקיות'
            )}
          </button>
          <button className={`btn ${watched.length === 0 ? 'primary' : ''}`} onClick={openUpload}>
            העלאת קבצים
          </button>
          <button className="btn" onClick={() => setModal('manual')}>
            מקור ידני
          </button>
          <button className="btn" onClick={() => setModal('quizlet')}>
            ייבוא כרטיסים מ־Quizlet
          </button>
        </div>
      </div>

      {(scan || imported || waiting > 0) && (
        <div className="stack">
          {scan?.kind === 'no-folders' && (
            <div className="callout info row-between" role="status">
              <span>
                <strong>לאף קורס עוד לא הוגדרה תיקייה למעקב.</strong> בעמוד <Link to="/topics">נושאים</Link> פותחים את הקורס ובהגדרות הקורס מזינים את
                נתיב התיקייה שבה נשמרים חומרי הקורס (למשל <span className="ltr">C:\Users\…\ביולוגיה</span>). מאז, "סרוק תיקיות" ימצא בה קבצים חדשים —
                וקורא אותם בלבד, בלי לשנות, להזיז או למחוק דבר.
              </span>
              <DismissButton onClick={() => setScan(null)} />
            </div>
          )}
          {scan?.kind === 'result' && <ScanResult r={scan.r} onClose={() => setScan(null)} />}
          {imported && <ImportedBanner r={imported} onClose={() => setImported(null)} />}
          {waiting > 0 && !stuck && (
            <div className="callout row" role="status">
              <span className="spinner" style={{ width: 16, height: 16 }} aria-hidden />
              <span>
                מחלץ טקסט מ{waiting === 1 ? 'קובץ אחד' : `־${waiting} קבצים`} ברקע. הרשימה מתעדכנת מעצמה — אפשר להמשיך בינתיים.
              </span>
            </div>
          )}
          {stuck && (
            <div className="callout warn" role="status">
              {waiting === 1 ? 'מקור אחד עדיין ממתין' : `${waiting} מקורות עדיין ממתינים`} לחילוץ, אבל החילוץ ברקע לא פועל כרגע. פותחים את המקור ולוחצים
              "חלץ עכשיו"{watched.length > 0 ? ' — או לוחצים "סרוק תיקיות", שמפעיל מחדש את החילוץ של כל מה שממתין' : ''}.
            </div>
          )}
        </div>
      )}

      {boot.courses.length === 0 && (
        <div className="callout warn">
          עדיין אין קורסים. אפשר להעלות קבצים גם בלי קורס, אבל כדי לאשר מקור או לייבא כרטיסים צריך קורס —{' '}
          <Link to="/topics">יצירת קורס בעמוד נושאים</Link>.
        </div>
      )}

      {error && !sources ? (
        <ErrorBox error={error} retry={() => void reload()} />
      ) : !sources ? (
        <Loading />
      ) : all.length === 0 ? (
        <FirstRun hasFolders={watched.length > 0} scanning={scanning} onScan={() => void runScan()} onUpload={openUpload} onQuizlet={() => setModal('quizlet')} />
      ) : (
        <section className="card" aria-label="מקורות">
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div className="seg" role="group" aria-label="סינון לפי מצב">
              {GROUPS.map((g) => (
                <button key={g} className={activeGroup === g ? 'on' : ''} aria-pressed={activeGroup === g} onClick={() => setGroup(g)}>
                  {STATUS_GROUP_LABELS[g]} <span className="num" style={{ opacity: 0.7 }}>{counts[g]}</span>
                </button>
              ))}
            </div>
            <div className="row">
              <label className="sr-only" htmlFor="src-course">
                סינון לפי קורס
              </label>
              <select id="src-course" className="input" style={{ width: 'auto' }} value={courseFilter} onChange={(e) => setCourseFilter(e.target.value)}>
                <option value="">כל הקורסים</option>
                {boot.courses.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {c.name}
                  </option>
                ))}
                {orphanCourseIds.map((id) => (
                  <option key={id} value={String(id)}>
                    קורס #{id}
                  </option>
                ))}
                {all.some((s) => s.courseId === null) && <option value="none">ללא קורס</option>}
              </select>
              <label className="sr-only" htmlFor="src-q">
                חיפוש לפי כותרת
              </label>
              <input id="src-q" type="search" className="input" style={{ width: 180 }} placeholder="חיפוש לפי כותרת" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          {shown.length > 0 ? (
            <SourcesTable sources={shown} courses={courses} />
          ) : (
            <div className="empty" style={{ padding: '28px 16px' }}>
              {needle ? (
                <p>אין מקור שהכותרת שלו כוללת "{q.trim()}".</p>
              ) : activeGroup === 'attention' ? (
                <>
                  <h2>הכל מטופל</h2>
                  <p>אין מקורות שממתינים לאישור או שיש בהם שגיאה.</p>
                </>
              ) : activeGroup === 'approved' ? (
                <p>עוד לא אושר אף מקור{courseFilter ? ' בקורס הזה' : ''}. פותחים מקור, בודקים שהטקסט חולץ נכון ומאשרים.</p>
              ) : (
                <p>אין מקורות בקורס הזה.</p>
              )}
              {activeGroup !== 'all' && (
                <button className="btn sm" onClick={() => setGroup('all')}>
                  הצג את כל המקורות
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {sources && all.length > 0 && <WatchedFolders courses={watched} />}

      {pageDrag && modal === null && (
        <div className="overlay" style={{ pointerEvents: 'none' }} aria-hidden>
          <div className="card" style={{ padding: '28px 36px', textAlign: 'center', border: '2px dashed var(--accent)' }}>
            <h2>שחרר כדי להעלות</h2>
            <p className="small muted">לפני ההעלאה תבחר קורס וסוג מקור.</p>
          </div>
        </div>
      )}

      {modal === 'upload' && <UploadModal incoming={incoming} onClose={() => setModal(null)} onUploaded={() => void reloadQuiet().then(() => refresh())} />}
      {modal === 'manual' && (
        <ManualSourceModal
          onClose={() => setModal(null)}
          onCreated={(s) => {
            setModal(null);
            toast.info(`המקור "${s.title}" נוסף`, { label: 'פתח', run: () => go(`/import/source/${s.id}`) });
            void reloadQuiet();
            void refresh();
          }}
        />
      )}
      {modal === 'quizlet' && <QuizletModal text={quizletText} onText={setQuizletText} onClose={() => setModal(null)} onImported={onCardsImported} />}
    </div>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn ghost sm" onClick={onClick} aria-label="סגור הודעה">
      ✕
    </button>
  );
}

function ScanResult({ r, onClose }: { r: ScanResultDTO; onClose: () => void }) {
  const parts = [
    `נסרקו ${count(r.scanned, 'קובץ אחד', 'קבצים')}`,
    r.added > 0 ? `${r.added} חדשים` : null,
    r.changed > 0 ? `${r.changed} השתנו` : null,
    r.missing > 0 ? `${r.missing} חסרים בדיסק` : null,
    `${r.unchanged} ללא שינוי`,
  ].filter(Boolean);
  const hasNews = r.added + r.changed > 0;
  return (
    <div className={`callout ${r.errors.length > 0 ? 'warn' : hasNews ? 'good' : ''}`} role="status">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="stack" style={{ gap: 4 }}>
          <strong>הסריקה הסתיימה: {parts.join(' · ')}.</strong>
          <span className="small">
            {hasNews
              ? 'הטקסט מהקבצים החדשים מחולץ עכשיו ברקע, והם יופיעו כאן לבדיקה ואישור. '
              : r.scanned === 0
                ? 'לא נמצאו בתיקיות קבצים נתמכים (PDF, PPTX, DOCX, XLSX, TXT, MD, CSV). '
                : 'אין חומר חדש מאז הסריקה הקודמת. '}
            {r.changed > 0 && 'קובץ שהשתנה נרשם כגרסה חדשה, והגרסה הקודמת נשמרת כי שאלות עשויות לצטט אותה. '}
            {r.missing > 0 && 'קבצים שנעלמו מהתיקייה סומנו "חסר בדיסק" — שום דבר לא נמחק. '}
            הקבצים עצמם רק נקראו — לא שונו ולא הוזזו.
          </span>
          {r.errors.length > 0 && (
            <ul className="small" style={{ margin: 0, paddingInlineStart: 20, color: 'var(--wrong)' }}>
              {r.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
        <DismissButton onClick={onClose} />
      </div>
    </div>
  );
}

function ImportedBanner({ r, onClose }: { r: CardsImported; onClose: () => void }) {
  return (
    <div className="callout good row-between" role="status">
      <span>
        <strong>
          יובאו {count(r.result.units, 'כרטיס אחד', 'כרטיסים')} לנושא "{r.topicName}"
        </strong>{' '}
        ({r.courseName}).{' '}
        {r.reviewFirst ? 'הם ממתינים במסך בדיקה ואישור, ולא ייכנסו לחזרות לפני שתאשר.' : 'הם נכנסו ללוח החזרות.'}
        {r.result.skipped > 0 && ` ${count(r.result.skipped, 'שורה אחת דולגה', 'שורות דולגו')}.`}
      </span>
      <span className="row">
        <Link to={`/topics/${r.courseId}`} className="btn sm">
          לנושאי הקורס ←
        </Link>
        {r.reviewFirst && (
          <Link to="/review" className="btn sm">
            לבדיקה ואישור ←
          </Link>
        )}
        <DismissButton onClick={onClose} />
      </span>
    </div>
  );
}

function WatchedFolders({ courses }: { courses: CourseDTO[] }) {
  return (
    <details className="small muted">
      <summary style={{ cursor: 'pointer' }}>
        {courses.length > 0 ? `תיקיות במעקב (${courses.length}) ואיך עובדת הסריקה` : 'איך עובדת סריקת תיקיות'}
      </summary>
      <div className="stack" style={{ gap: 6, marginTop: 8 }}>
        {courses.length > 0 ? (
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            {courses.map((c) => (
              <li key={c.id}>
                {c.name}: <span className="ltr">{c.watchFolder}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>לאף קורס לא הוגדרה תיקייה.</p>
        )}
        <p>
          "סרוק תיקיות" עובר על התיקייה של כל קורס (כולל תתי־תיקיות) ורושם קבצים חדשים. קובץ שהשתנה נרשם כגרסה חדשה, וקובץ שנעלם מסומן "חסר בדיסק".
          הסריקה רק קוראת — היא לא משנה, מזיזה או מוחקת שום קובץ. את התיקייה של קורס מגדירים בעמוד <Link to="/topics">נושאים</Link>, בהגדרות הקורס.
        </p>
      </div>
    </details>
  );
}

function FirstRun(props: { hasFolders: boolean; scanning: boolean; onScan: () => void; onUpload: () => void; onQuizlet: () => void }) {
  return (
    <section className="stack-lg" aria-label="איך מתחילים">
      <div className="empty" style={{ padding: '24px 16px 0' }}>
        <h2>עוד לא יובא חומר</h2>
        <p>יש שלוש דרכים להכניס חומר. אפשר לשלב ביניהן — למשל תיקייה לקורס, והעלאה ידנית לקובץ שקיבלת במייל.</p>
      </div>
      <div className="grid-cards">
        <div className="card stack">
          <h3>1. תיקיית קורס</h3>
          <p className="small">
            מגדירים לכל קורס את התיקייה שבה נשמרים המצגות והסיכומים (בעמוד <Link to="/topics">נושאים</Link>, בהגדרות הקורס). אחרי כל שיעור לוחצים "סרוק
            תיקיות", וקבצים חדשים נקלטים. הקבצים רק נקראים — לא משתנים ולא זזים.
          </p>
          <div>
            {props.hasFolders ? (
              <button className="btn primary" onClick={props.onScan} disabled={props.scanning}>
                {props.scanning ? 'סורק…' : 'סרוק תיקיות'}
              </button>
            ) : (
              <Link to="/topics" className="btn">
                להגדרת תיקייה ←
              </Link>
            )}
          </div>
        </div>
        <div className="card stack">
          <h3>2. העלאת קבצים</h3>
          <p className="small">
            גוררים לכאן PDF, PowerPoint, Word, Excel או קובץ טקסט. הטקסט מחולץ מיד, עם מספרי העמודים והשקופיות, כדי שכל שאלה תצביע למקום המדויק במקור.
          </p>
          <div>
            <button className={`btn ${props.hasFolders ? '' : 'primary'}`} onClick={props.onUpload}>
              העלאת קבצים
            </button>
          </div>
        </div>
        <div className="card stack">
          <h3>3. כרטיסי Quizlet</h3>
          <p className="small">
            כבר יש לך כרטיסים ב־Quizlet? מייצאים את הסט ומדביקים. הכרטיסים שלך יכולים להיכנס ישר לחזרות, והם גם מלמדים את המערכת את סגנון השאלות שלך.
          </p>
          <div>
            <button className="btn" onClick={props.onQuizlet}>
              ייבוא כרטיסים מ־Quizlet
            </button>
          </div>
        </div>
      </div>
      <p className="small muted" style={{ textAlign: 'center' }}>
        אחרי הייבוא: בודקים שהטקסט חולץ נכון ומאשרים את המקור. ממקור מאושר אפשר לבקש מה־AI הצעות לנושאים ולשאלות — והן מגיעות למסך בדיקה ואישור, לא
        ישר לחזרות.
      </p>
    </section>
  );
}
