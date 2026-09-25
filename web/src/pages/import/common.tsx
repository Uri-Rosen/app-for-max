// Shared bits for the Import and Source pages: status vocabulary, small
// selects, the course-tree loader and formatting helpers.

import { useEffect, useState } from 'react';
import { useApp } from '../../App.tsx';
import { useLoad } from '../../ui.tsx';
import type { ChunkDTO, CourseDTO, CourseTreeDTO, LessonDTO, SourceDTO, TopicDTO } from '../../../../shared/api.ts';
import { SOURCE_KIND_LABELS, SOURCE_KIND_ROLE, formatDate } from '../../../../shared/labels.ts';
import { SOURCE_KINDS, type Provenance, type SourceKind } from '../../../../shared/types.ts';

// ---------- API shapes not in shared/api.ts ----------

export interface ParsedCardDTO {
  term: string;
  definition: string;
  kind: 'definition' | 'cloze';
  prompt: string;
  record: number;
}

export interface CardsPreviewDTO {
  cards: ParsedCardDTO[];
  skipped: { record: number; text: string; reason: string }[];
}

export interface CardsImportResultDTO {
  units: number;
  questions: number;
  skipped: number;
  auditId: number | null;
  unitIds: number[];
}

export interface AiStatusDTO {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface SourceWithChunks {
  source: SourceDTO;
  chunks: ChunkDTO[];
}

// ---------- status ----------

export type SourceStatus = SourceDTO['status'];

export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  new: 'חדש — ממתין לחילוץ',
  extracted: 'חולץ — ממתין לאישור',
  partial: 'חולץ חלקית',
  error: 'שגיאה',
  approved: 'אושר',
  ignored: 'התעלמות',
  missing: 'חסר בדיסק',
  changed: 'הקובץ השתנה',
};

const STATUS_CLASS: Record<SourceStatus, string> = {
  new: 'dashed',
  extracted: 'accent',
  partial: 'warn',
  error: 'wrong',
  approved: 'correct',
  ignored: '',
  missing: 'wrong',
  changed: 'warn',
};

/** One sentence per status: what it means and what to do next. */
export const SOURCE_STATUS_EXPLAIN: Record<SourceStatus, string> = {
  new: 'הטקסט עוד מחולץ מהקובץ. זה לוקח בין כמה שניות לדקה, לפי גודל הקובץ.',
  extracted: 'הטקסט חולץ. עבור עליו, ואם הוא נכון — אשר את המקור.',
  partial: 'חלק מהטקסט חולץ, אבל היו בעיות (ראה אזהרות). אפשר לאשר אם מה שחסר לא חשוב.',
  error: 'חילוץ הטקסט נכשל. אפשר לנסות לחלץ מחדש, או להתעלם מהמקור.',
  approved: 'המקור אושר: הטקסט נכון ומותר לבסס עליו שאלות.',
  ignored: 'המקור מוסתר ולא ישמש לשאלות. אפשר להחזיר אותו בכל עת.',
  missing: 'הקובץ לא נמצא בדיסק. אם הוא הועבר או ששמו שונה, סריקת התיקייה תרשום אותו מחדש.',
  changed: 'הקובץ השתנה מאז שיובא, וגרסה חדשה נרשמה כמקור נפרד. הגרסה הזו נשמרת כי שאלות עשויות לצטט אותה.',
};

export function SourceStatusBadge({ s }: { s: SourceStatus }) {
  const { boot } = useApp();
  return (
    <span className={`badge ${STATUS_CLASS[s]}`}>
      {s === 'new' && boot.importing && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} aria-hidden />}
      {SOURCE_STATUS_LABELS[s]}
    </span>
  );
}

export type StatusGroup = 'attention' | 'approved' | 'all';

export const STATUS_GROUP_LABELS: Record<StatusGroup, string> = {
  attention: 'דורש טיפול',
  approved: 'אושרו',
  all: 'הכל',
};

/** Waiting for background extraction (a source with no file never gets extracted). */
export function isExtracting(s: SourceDTO): boolean {
  return s.status === 'new' && s.filePath !== null;
}

const ATTENTION: SourceStatus[] = ['extracted', 'partial', 'error', 'changed', 'missing'];

export function inGroup(s: SourceDTO, g: StatusGroup): boolean {
  if (g === 'all') return true;
  if (g === 'approved') return s.status === 'approved';
  // Files still being extracted are shown here too, so a fresh scan doesn't vanish from view.
  return ATTENTION.includes(s.status) || isExtracting(s);
}

export const ORIGIN_LABELS: Record<SourceDTO['origin'], string> = {
  folder: 'מתיקיית הקורס',
  upload: 'הועלה',
  manual: 'ידני',
};

// ---------- source kinds ----------

/** Longer guidance shown under the kind picker on the source page. */
export const KIND_GUIDANCE: Record<SourceKind, string> = {
  syllabus: 'סילבוס עוזר להציע מבנה ראשוני של נושאים, אבל הוא מפת ציפיות בלבד — מה שנלמד בפועל ולוח השיעורים קובעים את המבנה הסופי.',
  slides: 'מצגת מתעדת את מה שנלמד בפועל בשיעור, ולכן היא בסיס טוב לשאלות.',
  lesson_summary: 'סיכום שיעור מתעד את מה שנלמד בפועל, ולכן הוא בסיס טוב לשאלות.',
  course_material: 'חומר רשמי של הקורס — הבסיס האמין ביותר לשאלות ולתשובות.',
  past_exam: 'מבחן קודם מראה את סוג השאלות והדגשים, אבל הוא לא מקור סמכותי יחיד לתשובה — כדאי לאמת תשובות מול חומרי הקורס.',
  student_summary: 'סיכום של סטודנטים הוא עזר שימושי, אבל כל מה שנוצר ממנו צריך להיבדק מול חומרי הקורס לפני שסומכים עליו.',
  external: 'הרחבה מחוץ לחומר הקורס — טובה להבנה, אבל לא בהכרח מה שנלמד בקורס.',
  manual: 'מקור שהוזן ידנית — שיעור, פרק או עמוד באינטרנט.',
};

/** A reasonable default provenance for cards linked to a source of this kind. */
export const PROVENANCE_FOR_KIND: Record<SourceKind, Provenance> = {
  syllabus: 'unverified',
  slides: 'official',
  lesson_summary: 'official',
  course_material: 'official',
  past_exam: 'past_exam',
  student_summary: 'unverified',
  external: 'external',
  manual: 'unverified',
};

export function KindSelect(props: {
  id: string;
  value: SourceKind | '';
  onChange: (k: SourceKind | '') => void;
  allowAuto?: boolean;
  disabled?: boolean;
}) {
  return (
    <select
      id={props.id}
      className="input"
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value as SourceKind | '')}
    >
      {props.allowAuto && <option value="">זיהוי אוטומטי לפי שם הקובץ</option>}
      {SOURCE_KINDS.map((k) => (
        <option key={k} value={k}>
          {SOURCE_KIND_LABELS[k]}
        </option>
      ))}
    </select>
  );
}

/** The role line that sits under every kind picker. */
export function KindRole({ kind }: { kind: SourceKind | '' }) {
  if (!kind) {
    return (
      <span className="hint">
        סילבוס, מבחן או סיכום מזוהים לפי מילים בשם הקובץ; קובץ PPTX כמצגת; כל השאר כחומר קורס. אפשר לתקן אחר כך בעמוד המקור.
      </span>
    );
  }
  return <span className="hint">{SOURCE_KIND_ROLE[kind]}</span>;
}

// ---------- courses, topics, lessons ----------

export function CourseSelect(props: {
  id: string;
  courses: CourseDTO[];
  value: string;
  onChange: (v: string) => void;
  noneLabel?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  return (
    <select
      id={props.id}
      className="input"
      value={props.value}
      disabled={props.disabled}
      required={props.required}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.noneLabel !== undefined && <option value="">{props.noneLabel}</option>}
      {props.courses.map((c) => (
        <option key={c.id} value={String(c.id)}>
          {c.name}
          {c.term ? ` · ${c.term}` : ''}
        </option>
      ))}
    </select>
  );
}

/**
 * The course tree for pickers. Returns null while loading, and never returns
 * a tree that belongs to a previously selected course.
 */
export function useCourseTree(courseId: number | null): { tree: CourseTreeDTO | null; loading: boolean } {
  const { data, loading } = useLoad<CourseTreeDTO>(courseId ? `/courses/${courseId}/tree` : null);
  const tree = data && courseId && data.course.id === courseId ? data : null;
  return { tree, loading: courseId !== null && !tree && loading };
}

/** Active topics in tree order, indented by depth. */
export function topicOptions(topics: TopicDTO[]): { id: number; label: string; name: string }[] {
  const active = topics.filter((t) => t.status === 'active');
  const ids = new Set(active.map((t) => t.id));
  const children = new Map<number | null, TopicDTO[]>();
  for (const t of active) {
    const parent = t.parentId !== null && ids.has(t.parentId) ? t.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(t);
    children.set(parent, list);
  }
  const out: { id: number; label: string; name: string }[] = [];
  const walk = (parent: number | null, depth: number) => {
    const list = (children.get(parent) ?? []).slice().sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'he'));
    for (const t of list) {
      out.push({ id: t.id, name: t.name, label: `${'— '.repeat(depth)}${t.name}` });
      if (depth < 8) walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function lessonLabel(l: LessonDTO): string {
  return `${l.title} · ${formatDate(l.studiedOn)}`;
}

// ---------- formatting ----------

/** Local calendar day of an ISO timestamp, as YYYY-MM-DD. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatIsoDay(iso: string | null): string {
  return iso ? formatDate(localDay(iso)) : '—';
}

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function extLabel(ext: string | null): string {
  return ext ? ext.replace(/^\./, '').toUpperCase() : '';
}

/** What the file's pieces are called: pages, slides, sheets or sections. */
export function locatorNoun(ext: string | null): string {
  switch (ext) {
    case '.pdf':
      return 'עמודים';
    case '.pptx':
      return 'שקופיות';
    case '.xlsx':
      return 'גיליונות';
    default:
      return 'קטעים';
  }
}

/** "12 עמודים" / "שקופית אחת" — only for formats whose pieces have a physical number. */
export function extentLabel(ext: string | null, pageCount: number | null): string | null {
  if (pageCount === null) return null;
  switch (ext) {
    case '.pdf':
      return count(pageCount, 'עמוד אחד', 'עמודים');
    case '.pptx':
      return count(pageCount, 'שקופית אחת', 'שקופיות');
    case '.xlsx':
      return count(pageCount, 'גיליון אחד', 'גיליונות');
    default:
      return null;
  }
}

/** "קובץ אחד" / "3 קבצים". */
export function count(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

export const SUPPORTED_UPLOAD_EXTENSIONS = ['.pdf', '.pptx', '.docx', '.xlsx', '.txt', '.md', '.csv'] as const;

export function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase();
}

// ---------- hooks ----------

export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}
