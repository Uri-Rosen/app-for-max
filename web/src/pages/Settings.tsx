import { useRef, useState } from 'react';
import { api } from '../api.ts';
import { useApp } from '../App.tsx';
import { ErrorBox, Loading, Modal, useLoad, useToast } from '../ui.tsx';
import type { AuditEntryDTO, BackupInfoDTO } from '../../../shared/api.ts';
import { formatDays } from '../../../shared/labels.ts';
import type { Settings } from '../../../shared/types.ts';

type Tab = 'study' | 'data' | 'log' | 'ai' | 'test';

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('study');
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>הגדרות</h1>
          <p>הכל נשמר במחשב הזה. מסד הנתונים הוא מקור האמת; Excel ו־JSON הם ייצוא בלבד.</p>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {(
          [
            ['study', 'סשן ותזמון'],
            ['data', 'גיבוי וייצוא'],
            ['log', 'יומן פעולות'],
            ['ai', 'AI מקומי'],
            ['test', 'מצב בדיקה'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'study' && <StudySettings />}
      {tab === 'data' && <DataSettings />}
      {tab === 'log' && <AuditLog />}
      {tab === 'ai' && <AiSettings />}
      {tab === 'test' && <TestSettings />}
    </div>
  );
}

function useSave() {
  const { refresh } = useApp();
  const toast = useToast();
  return async (patch: Partial<Settings>) => {
    try {
      await api.put('/settings', patch);
      await refresh();
      toast.info('נשמר');
    } catch (e) {
      toast.error(e);
    }
  };
}

function StudySettings() {
  const { boot } = useApp();
  const s = boot.settings;
  const save = useSave();
  const [f, setF] = useState({
    budgetMinutes: s.budgetMinutes,
    maxItems: s.maxItems,
    ladder: s.ladder.join(', '),
    remediationCapDays: s.remediationCapDays,
    remediationLapses: s.remediationLapses,
    remediationWindow: s.remediationWindow,
    remediationClearStreak: s.remediationClearStreak,
    defaultAnswerSeconds: s.defaultAnswerSeconds,
    dayStartHour: s.dayStartHour,
    examWindowDays: s.examWindowDays,
    longGapDays: s.longGapDays,
  });
  const num = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Number(e.target.value) });
  const ladder = f.ladder
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  return (
    <div className="stack-lg" style={{ maxWidth: 760 }}>
      <div className="card stack">
        <h2>הסשן היומי</h2>
        <div className="form-grid">
          <label className="field">
            זמן יומי (דקות)
            <input className="input" type="number" min={1} value={f.budgetMinutes} onChange={num('budgetMinutes')} />
          </label>
          <label className="field">
            מקסימום שאלות ביום
            <input className="input" type="number" min={1} value={f.maxItems} onChange={num('maxItems')} />
          </label>
          <label className="field">
            זמן משוער לשאלה חדשה (שניות)
            <span className="hint">אחרי כמה חזרות המערכת מודדת את הזמן האמיתי שלך</span>
            <input className="input" type="number" min={5} value={f.defaultAnswerSeconds} onChange={num('defaultAnswerSeconds')} />
          </label>
          <label className="field">
            היום מתחלף בשעה
            <span className="hint">חזרה ב־01:00 עם ערך 4 נחשבת ליום הקודם</span>
            <input className="input" type="number" min={0} max={12} value={f.dayStartHour} onChange={num('dayStartHour')} />
          </label>
          <label className="field">
            "מבחן קרוב" — ימים לפני המבחן
            <input className="input" type="number" min={0} value={f.examWindowDays} onChange={num('examWindowDays')} />
          </label>
          <label className="field">
            "לא נבדק זמן רב" — אחרי כמה ימים
            <input className="input" type="number" min={1} value={f.longGapDays} onChange={num('longGapDays')} />
          </label>
        </div>
      </div>

      <div className="card stack">
        <h2>לוח המרווחים</h2>
        <p className="small muted">
          אלה ערכי פתיחה, לא הבטחה. תשובה נכונה מתקדמת שלב, "קל מאוד" שני שלבים, חלקית נשארת באותו שלב, ושגויה חוזרת מחר ויורדת שני שלבים. רמז הופך הצלחה לחלקית.
        </p>
        <label className="field">
          מרווחים בימים, מופרדים בפסיקים
          <input className="input ltr" dir="ltr" value={f.ladder} onChange={(e) => setF({ ...f, ladder: e.target.value })} />
          <span className="hint">{ladder.every((n) => n > 0) ? ladder.map(formatDays).join(' ← ') : 'ערכים לא תקינים'}</span>
        </label>
        <div className="form-grid">
          <label className="field">
            מצב תיקון: כישלונות
            <input className="input" type="number" min={1} value={f.remediationLapses} onChange={num('remediationLapses')} />
          </label>
          <label className="field">
            מתוך כמה ניסיונות אחרונים
            <input className="input" type="number" min={2} value={f.remediationWindow} onChange={num('remediationWindow')} />
          </label>
          <label className="field">
            תקרת מרווח במצב תיקון (ימים)
            <input className="input" type="number" min={1} value={f.remediationCapDays} onChange={num('remediationCapDays')} />
          </label>
          <label className="field">
            הצלחות רצופות ליציאה ממצב תיקון
            <input className="input" type="number" min={1} value={f.remediationClearStreak} onChange={num('remediationClearStreak')} />
          </label>
        </div>
        <p className="tiny muted">שינוי הלוח משפיע על התזמונים הבאים בלבד; תאריכים שכבר נקבעו לא זזים.</p>
      </div>
      <div>
        <button className="btn primary" onClick={() => void save({ ...f, ladder })}>
          שמור הגדרות
        </button>
      </div>
      <ThemeToggle />
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem('theme') ?? 'auto';
    } catch {
      return 'auto';
    }
  });
  const set = (t: string) => {
    setTheme(t);
    try {
      if (t === 'auto') localStorage.removeItem('theme');
      else localStorage.setItem('theme', t);
    } catch {
      // ignore
    }
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  };
  return (
    <div className="card flat row-between">
      <span>מראה</span>
      <div className="seg">
        {[
          ['auto', 'לפי המערכת'],
          ['light', 'בהיר'],
          ['dark', 'כהה'],
        ].map(([id, label]) => (
          <button key={id} className={theme === id ? 'on' : ''} onClick={() => set(id)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function size(n: number): string {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.round(n / 1e3)}KB`;
}

function DataSettings() {
  const { refresh, boot } = useApp();
  const backups = useLoad<BackupInfoDTO[]>('/backups');
  const toast = useToast();
  const [confirm, setConfirm] = useState<BackupInfoDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const KIND: Record<BackupInfoDTO['kind'], string> = { auto: 'אוטומטי', manual: 'ידני', 'pre-restore': 'לפני שחזור', uploaded: 'הועלה' };

  const restore = async (b: BackupInfoDTO) => {
    setBusy(true);
    try {
      const r = await api.post<{ safety: BackupInfoDTO }>('/backups/restore', { file: b.file });
      toast.info(`שוחזר. המצב הקודם נשמר בגיבוי ${r.safety.file}`);
      setConfirm(null);
      await refresh();
      await backups.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-lg" style={{ maxWidth: 860 }}>
      <div className="card stack">
        <h2>ייצוא</h2>
        <p className="small muted">גיבוי JSON מלא נכתב אוטומטית פעם בשבוע לתיקיית data/exports. אפשר גם להוריד עכשיו.</p>
        <div className="row">
          <a className="btn" href="/api/export/excel">
            דוח Excel
          </a>
          <a className="btn" href="/api/export/json">
            ייצוא JSON מלא
          </a>
        </div>
      </div>

      <div className="card stack">
        <div className="card-title">
          <h2>גיבויים</h2>
          <div className="row">
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                try {
                  const b = await api.post<BackupInfoDTO>('/backups');
                  toast.info(`נוצר גיבוי ${b.file}`);
                  await backups.reload();
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              גבה עכשיו
            </button>
            <button className="btn" onClick={() => file.current?.click()} disabled={busy}>
              שחזור מקובץ…
            </button>
            <input
              ref={file}
              type="file"
              accept=".db,.json"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                if (!window.confirm(`לשחזר מ־${f.name}? המצב הנוכחי יישמר קודם בגיבוי "לפני שחזור".`)) return;
                setBusy(true);
                try {
                  await api.upload('/backups/upload', f);
                  toast.info('השחזור הושלם');
                  await refresh();
                  await backups.reload();
                } catch (err) {
                  toast.error(err);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </div>
        </div>
        <p className="small muted">
          גיבוי אוטומטי נוצר פעם ביום לימוד; נשמרים {boot.settings.autoBackupKeep} האחרונים. גיבויים ידניים ו"לפני שחזור" לא נמחקים אף פעם. לפני כל שחזור המערכת שומרת את המצב הנוכחי, כך ששחזור תמיד הפיך.
        </p>
        {backups.error && <ErrorBox error={backups.error} />}
        {!backups.data ? (
          <Loading />
        ) : backups.data.length === 0 ? (
          <p className="small muted">אין עדיין גיבויים.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>קובץ</th>
                  <th>סוג</th>
                  <th>נוצר</th>
                  <th>גודל</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {backups.data.map((b) => (
                  <tr key={b.file}>
                    <td className="ltr small" dir="ltr">
                      {b.file}
                    </td>
                    <td>
                      <span className="badge">{KIND[b.kind]}</span>
                    </td>
                    <td className="small nowrap">{new Date(b.createdAt).toLocaleString('he-IL')}</td>
                    <td className="small num">{size(b.size)}</td>
                    <td>
                      <button className="btn sm" onClick={() => setConfirm(b)}>
                        שחזר
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {confirm && (
        <Modal
          title="שחזור מגיבוי"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn primary" disabled={busy} onClick={() => void restore(confirm)}>
                כן, שחזר
              </button>
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                ביטול
              </button>
            </>
          }
        >
          <p>
            המערכת תחזור למצב של <strong>{new Date(confirm.createdAt).toLocaleString('he-IL')}</strong>. כל מה שנעשה מאז (חזרות, עריכות) לא יופיע — אבל לא ילך לאיבוד: המצב הנוכחי נשמר קודם בגיבוי "לפני שחזור", שאפשר לשחזר ממנו בחזרה.
          </p>
        </Modal>
      )}
    </div>
  );
}

function AuditLog() {
  const log = useLoad<AuditEntryDTO[]>('/audit?limit=200');
  const toast = useToast();
  const { refresh } = useApp();
  const undo = async (e: AuditEntryDTO, force = false) => {
    try {
      const r = await api.post<{ ok: boolean; conflicts: { table: string; id: number; message: string }[] }>(`/audit/${e.id}/undo`, { force });
      if (!r.ok) {
        const msg = r.conflicts.map((c) => c.message).join('; ');
        if (window.confirm(`הנתונים השתנו מאז הפעולה (${msg}). ביטול בכוח ידרוס את השינויים המאוחרים יותר בפריטים האלה. להמשיך?`)) await undo(e, true);
        return;
      }
      toast.info('הפעולה בוטלה');
      await log.reload();
      void refresh();
    } catch (err) {
      toast.error(err);
    }
  };
  if (log.error) return <ErrorBox error={log.error} retry={log.reload} />;
  if (!log.data) return <Loading />;
  return (
    <div className="card flat">
      <p className="small muted" style={{ marginBottom: 10 }}>
        כל אישור, עריכה, איחוד, חזרה ושחזור נרשמים כאן עם המצב לפני ואחרי, וכמעט כל פעולה אפשר לבטל. ביטול נרשם גם הוא, ואפשר לבטל אותו בחזרה.
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>מתי</th>
              <th>פעולה</th>
              <th>שינויים</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {log.data.map((e) => (
              <tr key={e.id} style={e.undone_at ? { opacity: 0.55 } : undefined}>
                <td className="small nowrap">{new Date(e.at).toLocaleString('he-IL')}</td>
                <td className="small" dir="auto">
                  {e.summary}
                  {e.undone_at && <span className="badge" style={{ marginInlineStart: 6 }}>בוטלה</span>}
                </td>
                <td className="small num muted">{e.change_count}</td>
                <td>
                  {e.undoable === 1 && !e.undone_at && (
                    <button className="btn sm ghost" onClick={() => void undo(e)}>
                      בטל
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AiSettings() {
  const { boot } = useApp();
  const save = useSave();
  const status = useLoad<{ id: string; label: string; ok: boolean; detail: string }>('/ai/status', [boot.settings.aiProvider, boot.settings.ollamaModel, boot.settings.ollamaUrl]);
  const [f, setF] = useState({ aiProvider: boot.settings.aiProvider, ollamaUrl: boot.settings.ollamaUrl, ollamaModel: boot.settings.ollamaModel });
  return (
    <div className="stack-lg" style={{ maxWidth: 760 }}>
      <div className="card stack">
        <h2>ספק הצעות</h2>
        <p className="small muted">
          ה־AI רק מציע נושאים ושאלות. הוא לא מחשב תאריכים ולא מאשר שום דבר — כל הצעה נבדקת אוטומטית מול המקור ואז מחכה לאישור שלך. שני הספקים פועלים בלי אינטרנט.
        </p>
        <div className="seg">
          <button className={f.aiProvider === 'mock' ? 'on' : ''} onClick={() => setF({ ...f, aiProvider: 'mock' })}>
            ספק דמה (כללים, בלי מודל)
          </button>
          <button className={f.aiProvider === 'ollama' ? 'on' : ''} onClick={() => setF({ ...f, aiProvider: 'ollama' })}>
            מודל מקומי (Ollama)
          </button>
        </div>
        {f.aiProvider === 'ollama' && (
          <div className="form-grid">
            <label className="field">
              כתובת Ollama <span className="hint">מקומית בלבד</span>
              <input className="input ltr" dir="ltr" value={f.ollamaUrl} onChange={(e) => setF({ ...f, ollamaUrl: e.target.value })} />
            </label>
            <label className="field">
              מודל
              <input className="input ltr" dir="ltr" value={f.ollamaModel} onChange={(e) => setF({ ...f, ollamaModel: e.target.value })} />
            </label>
          </div>
        )}
        <div className="row">
          <button className="btn primary" onClick={() => void save(f).then(() => status.reload())}>
            שמור
          </button>
          {status.data && (
            <span className={`badge ${status.data.ok ? 'correct' : 'warn'}`}>
              {status.data.label}: {status.data.ok ? 'זמין' : 'לא זמין'}
            </span>
          )}
        </div>
        {status.data && !status.data.ok && <div className="callout warn small pre">{status.data.detail}</div>}
      </div>
    </div>
  );
}

function TestSettings() {
  const { boot, refresh } = useApp();
  const toast = useToast();
  const [days, setDays] = useState(boot.clockOffsetDays);
  const set = async (n: number) => {
    try {
      await api.post('/clock', { offsetDays: n });
      setDays(n);
      await refresh();
      toast.info(n === 0 ? 'השעון חזר להיום' : `השעון הוזז ב־${n} ימים`);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="card stack" style={{ maxWidth: 760 }}>
      <h2>הזזת שעון (לבדיקה)</h2>
      <p className="small muted">
        מאפשר לראות איך המערכת מתנהגת כשמדלגים על ימים: חזרות שפוספסו, עומס, דחיות. ההזזה לא נשמרת — הפעלה מחדש של השרת מחזירה את השעון להיום. חזרות שתבצע במצב הזה נרשמות בתאריך המוזז, לכן כדאי לגבות לפני ולשחזר אחרי.
      </p>
      <div className="row">
        <button className="btn" onClick={() => void set(days - 1)}>
          − יום
        </button>
        <span className="num" style={{ minWidth: 60, textAlign: 'center' }}>
          {days > 0 ? `+${days}` : days} ימים
        </span>
        <button className="btn" onClick={() => void set(days + 1)}>
          + יום
        </button>
        <button className="btn" onClick={() => void set(days + 7)}>
          + שבוע
        </button>
        <button className="btn ghost" onClick={() => void set(0)} disabled={days === 0}>
          חזרה להיום
        </button>
      </div>
      <p className="small">תאריך הלימוד הנוכחי במערכת: {boot.today}</p>
    </div>
  );
}
