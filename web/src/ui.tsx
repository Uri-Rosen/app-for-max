// Small UI kit: modal, toasts (with undo), async loader hook, and shared
// display bits (badges, dots, source links, formatted answers).

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, sourceFileUrl } from './api.ts';
import type { LinkDTO } from '../../shared/api.ts';
import {
  CONFIDENCE_LABELS,
  FIELD_LABELS,
  GRADE_LABELS,
  PROVENANCE_LABELS,
  SOURCE_KIND_LABELS,
  STATUS_LABELS,
  TEMPLATE_LABELS,
  formatDate,
} from '../../shared/labels.ts';
import { TEMPLATE_FIELDS, type AnswerStructure, type Confidence, type EffectiveGrade, type Provenance, type QuestionStatus } from '../../shared/types.ts';

// ---------- toasts ----------

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; run: () => void };
}

const ToastCtx = createContext<{ push: (t: Omit<Toast, 'id'>) => void }>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(1);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = seq.current++;
    setToasts((xs) => [...xs, { ...t, id }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.action ? 9000 : t.kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            <span className="grow">{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  setToasts((xs) => xs.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const { push } = useContext(ToastCtx);
  return {
    info: (text: string, action?: Toast['action']) => push({ text, kind: 'info', action }),
    error: (e: unknown) => push({ text: e instanceof Error ? e.message : String(e), kind: 'error' }),
  };
}

/** A toast with an "undo" button wired to the audit log. */
export function useUndoToast(after?: () => void) {
  const toast = useToast();
  return (text: string, auditId: number | null | undefined) => {
    toast.info(
      text,
      auditId
        ? {
            label: 'ביטול',
            run: () => {
              api
                .post(`/audit/${auditId}/undo`)
                .then((r) => {
                  const res = r as { ok: boolean };
                  if (res.ok) toast.info('הפעולה בוטלה');
                  else toast.error(new Error('אי אפשר לבטל: הנתונים השתנו מאז. אפשר לבטל ממסך ההגדרות › יומן פעולות.'));
                  after?.();
                })
                .catch(toast.error);
            },
          }
        : undefined,
    );
  };
}

// ---------- data loading ----------

export function useLoad<T>(url: string | null, deps: unknown[] = []): {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (d: T) => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      setData(await api.get<T>(url));
      setError(null);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

export function Loading({ text = 'טוען…' }: { text?: string }) {
  return (
    <div className="loading">
      <span className="spinner" /> {text}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: Error; retry?: () => void }) {
  return (
    <div className="callout bad row-between">
      <span>{error.message}</span>
      {retry && (
        <button className="btn sm" onClick={retry}>
          נסה שוב
        </button>
      )}
    </div>
  );
}

// ---------- modal ----------

export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [props]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{props.title}</h2>
          <button className="btn ghost sm" onClick={props.onClose} aria-label="סגור">
            ✕
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

// ---------- display bits ----------

export function ConfidenceDot({ c }: { c: Confidence }) {
  return <span className={`dot ${c}`} title={`ביטחון: ${CONFIDENCE_LABELS[c]}`} />;
}

export function GradeBadge({ g, hint }: { g: EffectiveGrade; hint?: boolean }) {
  if (g === 'void') return <span className="badge">לא נספר</span>;
  return (
    <span className={`badge ${g}`}>
      {GRADE_LABELS[g]}
      {hint ? ' · רמז' : ''}
    </span>
  );
}

export function HistoryDots({ items }: { items: { effectiveGrade: EffectiveGrade; localDate: string; hintUsed?: boolean; isCorrection?: boolean }[] }) {
  if (items.length === 0) return <span className="tiny muted">אין עדיין ניסיונות</span>;
  return (
    <span className="history-dots" title="ניסיונות קודמים, מהחדש לישן">
      {items.map((h, i) => (
        <span
          key={i}
          className={`hd-${h.effectiveGrade}`}
          title={`${formatDate(h.localDate)} · ${h.effectiveGrade === 'void' ? 'לא נספר' : GRADE_LABELS[h.effectiveGrade]}${h.hintUsed ? ' · רמז' : ''}${h.isCorrection ? ' · תיקון' : ''}`}
          style={h.isCorrection ? { opacity: 0.5 } : undefined}
        />
      ))}
    </span>
  );
}

export function ProvenanceBadge({ p }: { p: Provenance }) {
  const cls = p === 'unverified' ? 'warn' : p === 'official' ? 'correct' : p === 'past_exam' ? 'easy' : 'outline';
  return <span className={`badge ${cls}`}>{p === 'unverified' ? '⚠ ' : ''}{PROVENANCE_LABELS[p]}</span>;
}

export function StatusBadge({ s }: { s: QuestionStatus }) {
  const cls = s === 'approved' ? 'correct' : s === 'pending' || s === 'draft' ? 'dashed' : s === 'flagged' ? 'warn' : 'wrong';
  return <span className={`badge ${cls}`}>{STATUS_LABELS[s]}</span>;
}

export function CourseChip({ name, color }: { name: string; color: string | null }) {
  return (
    <span className="badge outline">
      <span className="swatch" style={{ background: color ?? 'var(--soft)' }} />
      {name}
    </span>
  );
}

/** Cloze prompts: "[[x]]" is a blank before reveal and a highlight after. */
export function ClozeText({ text, reveal }: { text: string; reveal: boolean }) {
  const parts = text.split(/(\[\[[^\]]+\]\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[\[([^\]]+)\]\]$/.exec(p);
        if (!m) return <span key={i}>{p}</span>;
        return reveal ? (
          <span key={i} className="filled">
            {m[1]}
          </span>
        ) : (
          <span key={i} className="blank" aria-label="חסר" />
        );
      })}
    </>
  );
}

export function StructureView({ s }: { s: AnswerStructure }) {
  const fields = TEMPLATE_FIELDS[s.template].filter((f) => s.fields[f]);
  return (
    <div className="stack">
      {fields.length > 0 && <div className="section-label">{TEMPLATE_LABELS[s.template]}</div>}
      {s.template === 'pathway' ? (
        <div className="pathway">
          {fields.map((f, i) => (
            <FragmentWithArrow key={f} first={i === 0}>
              <div className="step">
                <span className="section-label">{FIELD_LABELS[f]}</span>
                {s.fields[f]}
              </div>
            </FragmentWithArrow>
          ))}
        </div>
      ) : (
        fields.length > 0 && (
          <dl className="fields">
            {fields.map((f) => (
              <FieldRow key={f} label={FIELD_LABELS[f]} value={s.fields[f]} />
            ))}
          </dl>
        )
      )}
      {s.analogy && (
        <div className="callout small">
          <strong>אנלוגיה (עזר לזיכרון, לא תחליף למונח):</strong> {s.analogy}
        </div>
      )}
    </div>
  );
}

function FragmentWithArrow({ first, children }: { first: boolean; children: ReactNode }) {
  return (
    <>
      {!first && <span className="arrow">←</span>}
      {children}
    </>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

export function SourceLinkView({ l, compact }: { l: LinkDTO; compact?: boolean }) {
  const href = l.hasFile ? sourceFileUrl(l.sourceId, l.locatorType, l.locatorNum) : l.url;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="row small">
        {l.role === 'contradicts' && <span className="badge wrong">{l.resolved ? 'סתירה שיושבה' : 'סותר'}</span>}
        <span className="badge outline">{SOURCE_KIND_LABELS[l.sourceKind]}</span>
        <a href={`#/import/source/${l.sourceId}`}>{l.sourceTitle}</a>
        {l.locator && <span className="muted">· {l.locator}</span>}
        {href && (
          <a href={href} target="_blank" rel="noreferrer" className="small">
            פתח ↗
          </a>
        )}
      </div>
      {l.quote && !compact && <div className="quote">{l.quote}</div>}
      {l.note && <div className="tiny muted">{l.note}</div>}
    </div>
  );
}

export function Empty(props: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{props.title}</h2>
      {props.children && <p>{props.children}</p>}
      {props.action}
    </div>
  );
}

export function useKey(handler: (e: KeyboardEvent) => void, deps: unknown[]) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      // Ctrl+Enter is the one modified shortcut the app uses.
      if ((e.ctrlKey || e.metaKey || e.altKey) && !(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
      handler(e);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function pct(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`;
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
