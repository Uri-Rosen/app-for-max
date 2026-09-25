// Ask the AI provider for suggestions from an approved source. The AI only
// suggests: every topic, unit and question lands in the review screen, and
// nothing enters the schedule until the learner approves it.

import { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { Link } from '../../router.tsx';
import { mmss, useLoad, useUndoToast } from '../../ui.tsx';
import type { SourceDTO, SuggestResultDTO } from '../../../../shared/api.ts';
import { count, type AiStatusDTO } from './common.tsx';

type Task = 'topics' | 'units';

export default function AiPanel(props: {
  source: SourceDTO;
  chunkTotal: number;
  selected: Set<number>;
  onClearSelection: () => void;
  topicNames: string[];
  onDone: () => void;
}) {
  const { source, selected } = props;
  const { data: status, error: statusError, loading: statusLoading, reload: recheck } = useLoad<AiStatusDTO>('/ai/status');
  const [result, setResult] = useState<{ task: Task; r: SuggestResultDTO } | null>(null);
  // After an undo the summary would describe proposals that no longer exist.
  const undo = useUndoToast(() => {
    setResult(null);
    props.onDone();
  });
  const [running, setRunning] = useState<Task | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [topicHint, setTopicHint] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
    const t0 = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed((Date.now() - t0) / 1000), 1000);
    return () => clearInterval(t);
  }, [running]);

  const isSyllabus = source.kind === 'syllabus';
  const unavailable = status !== null && !status.ok;
  const disabled = running !== null || unavailable;

  async function run(task: Task) {
    setRunning(task);
    setError(null);
    try {
      const body: Record<string, unknown> = { sourceId: source.id, task };
      if (selected.size > 0) body.chunkIds = [...selected];
      if (task === 'units' && topicHint.trim()) body.topicHint = topicHint.trim();
      const r = await api.post<SuggestResultDTO>('/ai/suggest', body);
      setResult({ task, r });
      const made = r.topics + r.units + r.questions;
      undo(
        made === 0 ? 'לא נוצרו הצעות חדשות' : made === 1 ? 'נוצרה הצעה אחת — ממתינה לבדיקה' : `נוצרו ${made} הצעות — ממתינות לבדיקה`,
        made > 0 ? r.auditId : null,
      );
      props.onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(null);
    }
  }

  const scope =
    selected.size > 0 ? (
      <>
        ההצעות יתבססו על {count(selected.size, 'הקטע שבחרת', 'הקטעים שבחרת')}.{' '}
        <button className="linkbtn" onClick={props.onClearSelection}>
          השתמש בכל המקור
        </button>
      </>
    ) : (
      <>
        {props.chunkTotal === 1 ? 'ההצעות יתבססו על כל הטקסט של המקור.' : `ההצעות יתבססו על כל ${props.chunkTotal} הקטעים במקור. אפשר לסמן קטעים ברשימה כדי לצמצם.`}
      </>
    );

  const topicsBtn = (
    <button className={`btn ${isSyllabus ? 'primary' : ''}`} disabled={disabled} onClick={() => void run('topics')}>
      {running === 'topics' ? 'מציע נושאים…' : 'הצע נושאים'}
    </button>
  );

  const unitsBlock = (
    <div className="stack" style={{ gap: 8 }}>
      <label className="field">
        נושא (לא חובה)
        <input
          className="input"
          dir="auto"
          list="ai-topic-names"
          value={topicHint}
          onChange={(e) => setTopicHint(e.target.value)}
          placeholder="למשל: מסלול האינסולין"
          disabled={running !== null}
        />
        <span className="hint">שם של נושא קיים או חדש. יחידות בלי נושא ברור ישויכו אליו.</span>
      </label>
      <datalist id="ai-topic-names">
        {props.topicNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div>
        <button className={`btn ${isSyllabus ? '' : 'primary'}`} disabled={disabled} onClick={() => void run('units')}>
          {running === 'units' ? 'מציע יחידות ושאלות…' : 'הצע יחידות ושאלות'}
        </button>
      </div>
    </div>
  );

  return (
    <section className="card stack" aria-labelledby="ai-h">
      <div className="card-title" style={{ marginBottom: 0 }}>
        <h2 id="ai-h">הצעות AI</h2>
        {status && <span className={`badge ${status.ok ? 'correct' : 'warn'}`}>{status.label}</span>}
        {statusLoading && !status && <span className="spinner" style={{ width: 14, height: 14 }} aria-label="בודק את ספק ה־AI" />}
      </div>

      <p className="small muted">ה־AI רק מציע. כל נושא, יחידה ושאלה שייווצרו יחכו במסך בדיקה ואישור, ושום דבר לא נכנס ללוח החזרות עד שתאשר.</p>

      {status && status.id === 'mock' && (
        <div className="callout small">
          פועל עם ספק דמה: ההצעות נבנות בכללים פשוטים מתוך הטקסט, כדי לבדוק את הזרימה. להצעות אמיתיות אפשר לחבר מודל מקומי ב<Link to="/settings">הגדרות</Link>.
          {status.detail && <div className="tiny muted">{status.detail}</div>}
        </div>
      )}
      {status && status.id !== 'mock' && status.ok && status.detail && <p className="tiny muted">{status.detail}</p>}
      {unavailable && (
        <div className="callout warn small">
          <strong>המודל המקומי לא זמין כרגע.</strong> {status.detail}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn sm" onClick={() => void recheck()}>
              בדוק שוב
            </button>
            <Link to="/settings" className="small">
              להגדרות ה־AI ←
            </Link>
          </div>
        </div>
      )}
      {statusError && !status && <div className="callout warn small">לא הצלחתי לבדוק את ספק ה־AI: {statusError.message}</div>}

      <p className="small">{scope}</p>

      {isSyllabus ? (
        <>
          <div className="stack" style={{ gap: 6 }}>
            <p className="small">
              <strong>מסילבוס כדאי להתחיל בנושאים.</strong> נושאי הסילבוס הם ציפיות — המבנה האמיתי נקבע לפי מה שנלמד בפועל (מצגות, סיכומי שיעור
              ולוח השיעורים), ואפשר לאחד, לשנות או לפסול כל נושא במסך הבדיקה.
            </p>
            <div>{topicsBtn}</div>
          </div>
          <hr className="divider" />
          <details>
            <summary className="small" style={{ cursor: 'pointer' }}>
              הצעת יחידות ושאלות מהסילבוס
            </summary>
            <div style={{ marginTop: 8 }}>{unitsBlock}</div>
          </details>
        </>
      ) : (
        <>
          {unitsBlock}
          <hr className="divider" />
          <div className="stack" style={{ gap: 6 }}>
            <p className="small muted">אפשר גם להציע נושאים מתוך המקור — שימושי בעיקר לסילבוס או לחומר שפותח פרק חדש.</p>
            <div>{topicsBtn}</div>
          </div>
        </>
      )}

      {running && (
        <div className="callout info row" role="status" aria-live="polite">
          <span className="spinner" style={{ width: 16, height: 16 }} aria-hidden />
          <span className="grow">
            {running === 'topics' ? 'מבקש הצעות לנושאים' : 'מבקש הצעות ליחידות ושאלות'}… <span className="num">{mmss(elapsed)}</span>
            <span className="tiny muted" style={{ display: 'block' }}>
              עם מודל מקומי זה יכול לקחת כמה דקות. אפשר להמשיך לקרוא את הטקסט בינתיים.
            </span>
          </span>
        </div>
      )}

      {error && <div className="callout bad small">{error}</div>}

      {result && !running && <SuggestSummary task={result.task} r={result.r} />}
    </section>
  );
}

function SuggestSummary({ task, r }: { task: Task; r: SuggestResultDTO }) {
  const made = r.topics + r.units + r.questions;
  const parts = [
    task === 'topics' || r.topics > 0 ? count(r.topics, 'נושא אחד', 'נושאים') : null,
    task === 'units' ? count(r.units, 'יחידה אחת', 'יחידות') : null,
    task === 'units' ? count(r.questions, 'שאלה אחת', 'שאלות') : null,
    r.conflicts > 0 ? count(r.conflicts, 'סתירה אחת', 'סתירות') : null,
  ].filter(Boolean);
  return (
    <div className={`callout ${made > 0 ? 'good' : ''} stack`} style={{ gap: 6 }} role="status">
      <strong>{made > 0 ? `נוצרו: ${parts.join(' · ')}` : 'לא נוצרו הצעות חדשות'}</strong>
      <span className="small">
        {r.failedValidation > 0 && (
          <>
            {count(r.failedValidation, 'הצעה אחת לא עברה', 'הצעות לא עברו')} את בדיקת העיגון במקור (למשל ציטוט שלא נמצא בטקסט) — הן מסומנות במסך
            הבדיקה.{' '}
          </>
        )}
        {r.skipped > 0 && <>{count(r.skipped, 'פריט אחד דולג', 'פריטים דולגו')} כי כבר קיים. </>}
        {r.conflicts > 0 && <>סתירות בין מקורות מחכות להכרעה שלך. </>}
      </span>
      <span className="tiny muted">
        {r.provider} · {mmss(r.durationMs / 1000)}
      </span>
      {made > 0 && (
        <div className="row">
          <Link to="/review" className="btn primary sm">
            לבדיקה ואישור ←
          </Link>
          <span className="tiny muted">שום דבר לא נכנס לחזרות לפני שתאשר.</span>
        </div>
      )}
    </div>
  );
}
