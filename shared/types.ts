// Domain vocabulary shared by the server and the web client.
// Every enum here is stored as plain text in SQLite; labels live in labels.ts.

export const QUESTION_KINDS = [
  'definition',     // הגדרה ישירה
  'recall',         // שליפה פתוחה של תהליך/הסבר
  'cloze',          // השלמת משפט
  'causal',         // הסבר סיבתי
  'comparison',     // השוואה בין מושגים
  'application',    // יישום בתרחיש חדש
  'interpretation', // פירוש ניסוי/תרשים/גרף
  'exam',           // בסגנון מבחנים קודמים
  'integrative',    // אינטגרטיבית בין נושאים
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

/** Self-rated outcome, as the learner pressed it. */
export const GRADES = ['wrong', 'partial', 'correct', 'easy'] as const;
export type Grade = (typeof GRADES)[number];

/** What the scheduler actually acted on, after hint and error-type rules. */
export type EffectiveGrade = Grade | 'void';

export const ERROR_TYPES = [
  'knowledge_gap',    // חוסר ידע
  'confusion',        // בלבול בין מושגים
  'partial',          // תשובה חלקית
  'alt_phrasing',     // ניסוח חלופי תקין
  'unclear_question', // שאלה לא ברורה
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export const SOURCE_KINDS = [
  'syllabus',
  'slides',
  'lesson_summary',
  'course_material',
  'past_exam',
  'student_summary',
  'external',
  'manual',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Where a question's answer comes from. `unverified` is never shown as fact. */
export const PROVENANCES = ['official', 'past_exam', 'generated', 'external', 'unverified'] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** Only `approved` questions are ever scheduled. */
export const QUESTION_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'flagged'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export type Importance = 'core' | 'normal' | 'peripheral';
export type CreatedBy = 'user' | 'ai' | 'quizlet' | 'syllabus';

export const ANSWER_TEMPLATES = ['general', 'pathway', 'method'] as const;
export type AnswerTemplate = (typeof ANSWER_TEMPLATES)[number];

/** Field order per template is part of the contract: pathways always read source → signal → target → outcome. */
export const TEMPLATE_FIELDS: Record<AnswerTemplate, readonly string[]> = {
  general: ['mechanism', 'role', 'example', 'causality', 'limits'],
  pathway: ['source', 'signal', 'target', 'outcome'],
  method: ['measures', 'supports', 'notProves', 'controls'],
};

export interface AnswerStructure {
  template: AnswerTemplate;
  fields: Record<string, string>;
  /** A helper image, never a substitute for the scientific term. */
  analogy?: string;
}

export type Confidence = 'new' | 'low' | 'medium' | 'high';

export type LocatorType = 'page' | 'slide' | 'sheet' | 'section' | 'card';

export type PriorityReason =
  | 'failed_recently'
  | 'remediation'
  | 'overdue'
  | 'exam_soon'
  | 'core'
  | 'foundational'
  | 'long_gap'
  | 'new'
  | 'due_today'
  | 'application';

export interface Settings {
  budgetMinutes: number;
  maxItems: number;
  /** Interval ladder in days. Step n uses ladder[n]. */
  ladder: number[];
  remediationCapDays: number;
  remediationWindow: number;
  remediationLapses: number;
  remediationClearStreak: number;
  defaultAnswerSeconds: number;
  /** Hours before this local hour still count as the previous study day. */
  dayStartHour: number;
  examWindowDays: number;
  longGapDays: number;
  autoBackupKeep: number;
  aiProvider: 'mock' | 'ollama';
  ollamaUrl: string;
  ollamaModel: string;
}

export const DEFAULT_SETTINGS: Settings = {
  budgetMinutes: 15,
  maxItems: 12,
  ladder: [1, 3, 7, 14, 30, 60, 120],
  remediationCapDays: 7,
  remediationWindow: 4,
  remediationLapses: 2,
  remediationClearStreak: 2,
  defaultAnswerSeconds: 60,
  dayStartHour: 4,
  examWindowDays: 14,
  longGapDays: 30,
  autoBackupKeep: 30,
  aiProvider: 'mock',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen2.5:7b-instruct',
};
