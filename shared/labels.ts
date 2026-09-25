// Hebrew display labels. The server uses these too, so explanations stored in
// the database read the same as the screen that shows them.

import type {
  AnswerTemplate,
  Confidence,
  ErrorType,
  Grade,
  Importance,
  PriorityReason,
  Provenance,
  QuestionKind,
  QuestionStatus,
  SourceKind,
} from './types.ts';

export const KIND_LABELS: Record<QuestionKind, string> = {
  definition: 'הגדרה',
  recall: 'שליפה פתוחה',
  cloze: 'השלמת משפט',
  causal: 'הסבר סיבתי',
  comparison: 'השוואה',
  application: 'יישום',
  interpretation: 'פירוש תוצאה',
  exam: 'סגנון מבחן',
  integrative: 'אינטגרטיבית',
};

export const KIND_HINTS: Record<QuestionKind, string> = {
  definition: 'מושג בצד אחד, הגדרה בצד השני',
  recall: 'לשלוף תהליך או הסבר במילים שלך',
  cloze: 'משפט עם חלק חסר — סמן את החסר ב־[[...]]',
  causal: 'מה גורם למה, ובאילו תנאים',
  comparison: 'מה משותף ומה שונה בין שני מושגים קרובים',
  application: 'עיקרון שמופעל בתרחיש חדש',
  interpretation: 'מה אומרת תוצאה של ניסוי, תרשים או גרף',
  exam: 'שאלה בנוסח של מבחן קודם',
  integrative: 'שאלה שמחברת בין נושאים',
};

export const GRADE_LABELS: Record<Grade, string> = {
  wrong: 'שגוי',
  partial: 'חלקי',
  correct: 'נכון',
  easy: 'קל מאוד',
};

export const ERROR_LABELS: Record<ErrorType, string> = {
  knowledge_gap: 'חוסר ידע',
  confusion: 'בלבול בין מושגים',
  partial: 'תשובה חלקית',
  alt_phrasing: 'ניסוח חלופי תקין',
  unclear_question: 'השאלה לא ברורה',
};

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  syllabus: 'סילבוס',
  slides: 'מצגת',
  lesson_summary: 'סיכום שיעור',
  course_material: 'חומר קורס',
  past_exam: 'מבחן קודם',
  student_summary: 'סיכום סטודנטים',
  external: 'מקור חיצוני',
  manual: 'מקור ידני',
};

/** How much weight each source kind carries, in the plan's own words. */
export const SOURCE_KIND_ROLE: Record<SourceKind, string> = {
  syllabus: 'מפת ציפיות ונושאים — לא אמת מוחלטת',
  slides: 'תיעוד של מה שנלמד בפועל',
  lesson_summary: 'תיעוד של מה שנלמד בפועל',
  course_material: 'חומר רשמי של הקורס',
  past_exam: 'דוגמה לסוג השאלות — לא מקור סמכותי יחיד לתשובה',
  student_summary: 'עזר שצריך לבדוק מול חומרי הקורס',
  external: 'הרחבה מחוץ לקורס',
  manual: 'מקור שהוזן ידנית',
};

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  official: 'חומר רשמי של הקורס',
  past_exam: 'מבחן קודם',
  generated: 'נוצרה מתוך מקור',
  external: 'הרחבה חיצונית',
  unverified: 'דורש בדיקה',
};

export const STATUS_LABELS: Record<QuestionStatus, string> = {
  draft: 'טיוטה',
  pending: 'ממתינה לאישור',
  approved: 'מאושרת',
  rejected: 'נפסלה',
  flagged: 'מסומנת לבדיקה',
};

export const IMPORTANCE_LABELS: Record<Importance, string> = {
  core: 'מרכזי',
  normal: 'רגיל',
  peripheral: 'שולי',
};

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  new: 'חדש',
  low: 'נמוכה',
  medium: 'בינונית',
  high: 'גבוהה',
};

export const TEMPLATE_LABELS: Record<AnswerTemplate, string> = {
  general: 'תשובה מלאה',
  pathway: 'מסלול ביולוגי',
  method: 'שיטה ניסויית',
};

export const FIELD_LABELS: Record<string, string> = {
  mechanism: 'מנגנון',
  role: 'תפקיד',
  example: 'דוגמה',
  causality: 'כיוון סיבתי',
  limits: 'מגבלות',
  source: 'מקור',
  signal: 'אות',
  target: 'מטרה',
  outcome: 'תוצאה',
  measures: 'מה השיטה מודדת',
  supports: 'במה תוצאה תומכת',
  notProves: 'מה היא אינה מוכיחה',
  controls: 'בקרות ומגבלות',
};

export const REASON_LABELS: Record<PriorityReason, string> = {
  failed_recently: 'נכשלה לאחרונה',
  remediation: 'במצב תיקון',
  overdue: 'באיחור',
  exam_soon: 'מבחן מתקרב',
  core: 'חומר מרכזי',
  foundational: 'ידע בסיס',
  long_gap: 'לא נבדקה זמן רב',
  new: 'חזרה ראשונה',
  due_today: 'הגיע מועדה',
  application: 'שאלת יישום',
};

export function formatDays(n: number): string {
  if (n === 0) return 'היום';
  if (n === 1) return 'יום אחד';
  if (n === 2) return 'יומיים';
  if (n === 7) return 'שבוע';
  if (n === 14) return 'שבועיים';
  if (n === 21) return 'שלושה שבועות';
  if (n === 30) return 'חודש';
  if (n === 60) return 'חודשיים';
  if (n === 90) return 'שלושה חודשים';
  if (n === 120) return 'ארבעה חודשים';
  if (n === 180) return 'חצי שנה';
  return `${n} ימים`;
}

/**
 * Attaches a Hebrew prefix letter: "לשבוע", "משבועיים", but "ל־7 ימים"
 * (a maqaf only before digits and Latin).
 */
export function pre(letter: 'ל' | 'מ' | 'ב', text: string): string {
  return /^[\d A-Za-z]/.test(text) ? `${letter}־${text}` : `${letter}${text}`;
}

/** "חזרה אחת" / "3 חזרות". */
export function count(n: number, one: string, many: string): string {
  return n === 1 ? one : `${n} ${many}`;
}

/** "בעוד שבוע", "מחר", "היום". */
export function formatIn(n: number): string {
  if (n === 0) return 'היום';
  if (n === 1) return 'מחר';
  if (n === 2) return 'מחרתיים';
  return `בעוד ${formatDays(n)}`;
}

const HEB_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

export function formatDate(date: string, withWeekday = false): string {
  const [y, m, d] = date.split('-').map(Number);
  const base = `${d}.${m}.${String(y).slice(2)}`;
  if (!withWeekday) return base;
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `יום ${HEB_DAYS[wd]}, ${base}`;
}
