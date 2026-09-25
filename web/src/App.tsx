import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { Link, useRoute } from './router.tsx';
import { ErrorBox, Loading, ToastProvider } from './ui.tsx';
import type { BootstrapDTO } from '../../shared/api.ts';
import TodayPage from './pages/Today.tsx';
import TopicsPage from './pages/Topics.tsx';
import UnitPage from './pages/Unit.tsx';
import CalendarPage from './pages/Calendar.tsx';
import ImportPage from './pages/Import.tsx';
import SourcePage from './pages/Source.tsx';
import ReviewPage from './pages/Review.tsx';
import ProgressPage from './pages/Progress.tsx';
import SettingsPage from './pages/Settings.tsx';

interface AppState {
  boot: BootstrapDTO;
  refresh: () => Promise<void>;
}

const AppCtx = createContext<AppState | null>(null);

/** Settings, courses and queue counts — refreshed after anything that could change them. */
export function useApp(): AppState {
  const v = useContext(AppCtx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

const NAV: { to: string; label: string; match: string[]; count?: (b: BootstrapDTO) => number }[] = [
  { to: '/today', label: 'היום', match: ['today'] },
  { to: '/topics', label: 'נושאים', match: ['topics', 'unit'] },
  { to: '/calendar', label: 'לוח חזרות', match: ['calendar'] },
  { to: '/import', label: 'ייבוא', match: ['import'], count: (b) => b.counts.sources },
  {
    to: '/review',
    label: 'בדיקה ואישור',
    match: ['review'],
    count: (b) => b.counts.pending + b.counts.flagged + b.counts.conflicts + b.counts.topics,
  },
  { to: '/progress', label: 'התקדמות', match: ['progress'] },
];

function Shell({ children }: { children: ReactNode }) {
  const { parts } = useRoute();
  const { boot } = useApp();
  const section = parts[0] ?? 'today';
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/today" className="brand">
            <span className="brand-mark" aria-hidden />
            <span>זיכרון ארוך טווח</span>
          </Link>
          <nav className="nav" aria-label="ניווט ראשי">
            {NAV.map((n) => {
              const c = n.count?.(boot) ?? 0;
              return (
                <Link key={n.to} to={n.to} className={n.match.includes(section) ? 'active' : ''}>
                  {n.label}
                  {c > 0 && <span className="count">{c}</span>}
                </Link>
              );
            })}
          </nav>
          <Link to="/settings" className={section === 'settings' ? 'btn sm' : 'btn ghost sm'} title="הגדרות, גיבויים ויומן פעולות">
            ⚙ הגדרות
          </Link>
        </div>
      </header>
      {boot.clockOffsetDays !== 0 && (
        <div className="callout warn" style={{ borderRadius: 0, textAlign: 'center' }}>
          מצב בדיקה: שעון המערכת מוזז ב־{boot.clockOffsetDays} ימים. אפשר להחזיר אותו בהגדרות.
        </div>
      )}
      <main className="main">{children}</main>
    </div>
  );
}

function Routes() {
  const { parts } = useRoute();
  const [a, b, c] = parts;
  switch (a ?? 'today') {
    case 'today':
      return <TodayPage />;
    case 'topics':
      return <TopicsPage courseId={b ? Number(b) : null} />;
    case 'unit':
      return <UnitPage key={b} unitId={Number(b)} />;
    case 'calendar':
      return <CalendarPage />;
    case 'import':
      return b === 'source' && c ? <SourcePage key={c} sourceId={Number(c)} /> : <ImportPage />;
    case 'review':
      return <ReviewPage />;
    case 'progress':
      return <ProgressPage />;
    case 'settings':
      return <SettingsPage />;
    default:
      return <TodayPage />;
  }
}

export default function App() {
  const [boot, setBoot] = useState<BootstrapDTO | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const refresh = useCallback(async () => {
    try {
      setBoot(await api.get<BootstrapDTO>('/bootstrap'));
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  }, []);
  useEffect(() => {
    void refresh();
    // Counts drift as imports finish in the background; keep them honest.
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!boot) {
    return <div className="main">{error ? <ErrorBox error={error} retry={refresh} /> : <Loading />}</div>;
  }
  return (
    <ToastProvider>
      <AppCtx.Provider value={{ boot, refresh }}>
        <Shell>
          <Routes />
        </Shell>
      </AppCtx.Provider>
    </ToastProvider>
  );
}
