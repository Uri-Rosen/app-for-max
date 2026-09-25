// Shapes that cross the HTTP boundary. The server maps rows into these;
// the client reads only these.

import type {
  AnswerStructure,
  Confidence,
  CreatedBy,
  EffectiveGrade,
  ErrorType,
  Grade,
  Importance,
  LocatorType,
  PriorityReason,
  Provenance,
  QuestionKind,
  QuestionStatus,
  Settings,
  SourceKind,
} from './types.ts';

export interface Check {
  code: string;
  ok: boolean;
  message: string;
}
export interface ValidationReport {
  ok: boolean;
  checks: Check[];
}

export interface Explanation {
  summary: string;
  lines: string[];
}

export interface CourseDTO {
  id: number;
  name: string;
  code: string | null;
  term: string | null;
  examDate: string | null;
  color: string | null;
  watchFolder: string | null;
  archived: boolean;
  createdAt: string;
  stats: { topics: number; units: number; due: number; pending: number };
}

export interface TopicDTO {
  id: number;
  courseId: number;
  parentId: number | null;
  name: string;
  description: string | null;
  importance: Importance;
  foundational: boolean;
  position: number;
  status: 'active' | 'proposed' | 'merged' | 'rejected';
  mergedIntoId: number | null;
  syllabusOrder: number | null;
  createdBy: CreatedBy;
  aliases: { alias: string; fromTopicId: number | null }[];
  lessonIds: number[];
  validation: ValidationReport | null;
}

export interface LessonDTO {
  id: number;
  courseId: number;
  title: string;
  studiedOn: string;
  kind: string;
  notes: string | null;
  topicIds: number[];
  sourceIds: number[];
}

export interface UnitSummaryDTO {
  id: number;
  topicId: number;
  lessonId: number | null;
  title: string;
  learnedOn: string;
  status: 'active' | 'suspended' | 'proposed' | 'rejected' | 'archived';
  importance: Importance;
  foundational: boolean;
  dueDate: string | null;
  step: number;
  intervalDays: number | null;
  reps: number;
  lapses: number;
  remediation: boolean;
  lastGrade: EffectiveGrade | null;
  lastReviewedOn: string | null;
  confidence: Confidence;
  questionCounts: { approved: number; pending: number; flagged: number };
  unverified: boolean;
}

export interface LinkDTO {
  id: number;
  entityType: 'unit' | 'question' | 'topic';
  entityId: number;
  sourceId: number;
  sourceTitle: string;
  sourceKind: SourceKind;
  chunkId: number | null;
  locator: string | null;
  locatorType: LocatorType | null;
  locatorNum: number | null;
  quote: string | null;
  role: 'supports' | 'contradicts' | 'context';
  resolved: boolean;
  note: string | null;
  hasFile: boolean;
  url: string | null;
}

export interface QuestionDTO {
  id: number;
  unitId: number;
  kind: QuestionKind;
  prompt: string;
  answer: string;
  explanation: string | null;
  hint: string | null;
  keyPoints: string[];
  structure: AnswerStructure | null;
  relatedUnitIds: number[];
  status: QuestionStatus;
  provenance: Provenance;
  createdBy: CreatedBy;
  verifiedAt: string | null;
  flagReason: string | null;
  validation: ValidationReport | null;
  createdAt: string;
  updatedAt: string;
  lastAskedOn: string | null;
  links: LinkDTO[];
}

export interface ReviewDTO {
  id: number;
  unitId: number;
  questionId: number | null;
  questionPrompt: string | null;
  questionKind: QuestionKind | null;
  localDate: string;
  reviewedAt: string;
  grade: Grade;
  effectiveGrade: EffectiveGrade;
  hintUsed: boolean;
  isCorrection: boolean;
  userAnswer: string | null;
  answerMs: number | null;
  totalMs: number | null;
  errorType: ErrorType | null;
  confusedWith: string | null;
  missingPoints: string[];
  note: string | null;
  prevStep: number | null;
  newStep: number | null;
  prevDue: string | null;
  newDue: string | null;
  intervalDays: number | null;
  gapDays: number | null;
  appearedBecause: { code: PriorityReason; text: string }[];
  scheduleReason: Explanation | null;
  auditId: number | null;
}

export interface UnitDetailDTO {
  unit: UnitSummaryDTO & {
    content: string | null;
    importanceOverride: Importance | null;
    foundationalOverride: boolean | null;
    createdBy: CreatedBy;
    validation: ValidationReport | null;
    scheduleReason: Explanation | null;
    originalTopicId: number | null;
    createdAt: string;
  };
  course: CourseDTO;
  topic: TopicDTO;
  parentTopic: TopicDTO | null;
  lesson: LessonDTO | null;
  questions: QuestionDTO[];
  links: LinkDTO[];
  reviews: ReviewDTO[];
  nextQuestion: { questionId: number; why: string } | null;
}

export interface SessionItemDTO {
  unitId: number;
  unitTitle: string;
  unitContent: string | null;
  courseName: string;
  courseColor: string | null;
  topicName: string;
  rank: number;
  reasons: { code: PriorityReason; text: string }[];
  deferReason: string | null;
  dueDate: string;
  estSeconds: number;
  step: number;
  confidence: Confidence;
  question: QuestionDTO | null;
  questionWhy: string | null;
  history: { localDate: string; effectiveGrade: EffectiveGrade; hintUsed: boolean; isCorrection: boolean }[];
  /** Days until the next review for each button, without and with a hint. */
  preview: Record<Grade, number>;
  previewHint: Record<Grade, number>;
  unverified: boolean;
  isCorrection: boolean;
}

export interface TodayDTO {
  date: string;
  now: string;
  clockOffsetDays: number;
  settings: Pick<Settings, 'budgetMinutes' | 'maxItems'>;
  spent: { seconds: number; count: number; corrections: number };
  queue: SessionItemDTO[];
  deferred: SessionItemDTO[];
  corrections: SessionItemDTO[];
  totalDue: number;
  estQueueSeconds: number;
  /** Units with no approved question: they cannot be asked, and say so instead of vanishing. */
  blocked: { unitId: number; title: string; dueDate: string; reason: string }[];
  tomorrow: { date: string; count: number; estSeconds: number; overflow: number; items: { unitId: number; title: string; topicName: string; reasons: string[] }[] };
  lastReview: { reviewId: number; auditId: number | null; unitTitle: string; summary: string } | null;
}

export interface ReviewResultDTO {
  reviewId: number;
  auditId: number | null;
  effectiveGrade: EffectiveGrade;
  dueDate: string;
  intervalDays: number;
  explanation: Explanation;
  correctionQueued: boolean;
  remediation: boolean;
}

export interface SourceDTO {
  id: number;
  courseId: number | null;
  kind: SourceKind;
  title: string;
  origin: 'folder' | 'upload' | 'manual';
  filePath: string | null;
  url: string | null;
  fileExt: string | null;
  fileSize: number | null;
  studiedOn: string | null;
  status: 'new' | 'extracted' | 'partial' | 'error' | 'approved' | 'ignored' | 'missing' | 'changed';
  extractError: string | null;
  warnings: string[];
  pageCount: number | null;
  chunkCount: number;
  dupChunkCount: number;
  duplicateOf: number | null;
  previousVersionId: number | null;
  notes: string | null;
  addedAt: string;
  extractedAt: string | null;
  approvedAt: string | null;
  lessonIds: number[];
  linkCount: number;
  proposalCount: number;
}

export interface ChunkDTO {
  id: number;
  sourceId: number;
  seq: number;
  locatorType: LocatorType;
  locatorNum: number;
  locatorLabel: string;
  heading: string | null;
  text: string;
  notes: string | null;
  duplicateOf: { chunkId: number; sourceId: number; sourceTitle: string; locatorLabel: string } | null;
}

export interface ScanResultDTO {
  scanned: number;
  added: number;
  changed: number;
  missing: number;
  unchanged: number;
  errors: string[];
}

export interface BootstrapDTO {
  today: string;
  clockOffsetDays: number;
  settings: Settings;
  courses: CourseDTO[];
  counts: { pending: number; flagged: number; conflicts: number; topics: number; units: number; sources: number };
  importing: boolean;
}

export interface CourseTreeDTO {
  course: CourseDTO;
  topics: TopicDTO[];
  units: UnitSummaryDTO[];
  lessons: LessonDTO[];
  merged: TopicDTO[];
}

export interface CalendarDayDTO {
  date: string;
  kind: 'past' | 'today' | 'future';
  scheduled: number;
  done: number;
  dueAtStart: number;
  deferred: number;
  overdue: number;
}

export interface CalendarDayDetailDTO {
  date: string;
  scheduled: { unitId: number; title: string; topicName: string; courseName: string; dueDate: string }[];
  reviewed: { unitId: number; title: string; effectiveGrade: EffectiveGrade; hintUsed: boolean; nextDue: string | null }[];
  deferred: { unitId: number; title: string; nowDue: string | null }[];
}

export interface RateDTO {
  total: number;
  success: number;
  rate: number | null;
}

export interface ProgressDTO {
  date: string;
  budgetMinutes: number;
  totals: { units: number; reviews: number; studyDays: number; firstDay: string | null; daysSinceStart: number; streak: number };
  completion: { due: number; done: number; rate: number | null };
  retentionWeek: RateDTO;
  retentionMonth: RateDTO;
  buckets: ({ label: string; min: number; max: number } & RateDTO)[];
  weeks: { weekStart: string; total: number; rate: number | null; longTotal: number; longRate: number | null }[];
  daily: { date: string; minutes: number; reviews: number; due: number; deferred: number; success: number }[];
  minutesPerActiveDay: number;
  deferred30: number;
  hintRate: number | null;
  errors: { errorType: ErrorType; count: number }[];
  troubled: {
    unitId: number;
    title: string;
    topicName: string;
    lapses: number;
    remediation: boolean;
    dueDate: string | null;
    confusedWith: string[];
    errorCounts: Partial<Record<ErrorType, number>>;
  }[];
  quality: {
    provenance: { provenance: Provenance; count: number }[];
    pending: number;
    flagged: number;
    openConflicts: number;
    unitsWithoutSource: number;
    aiApproved: number;
    aiRejected: number;
  };
}

export interface ReviewQueueDTO {
  topics: (TopicDTO & { courseName: string; links: LinkDTO[] })[];
  units: {
    unit: UnitSummaryDTO;
    content: string | null;
    validation: ValidationReport | null;
    topicName: string;
    topicProposed: boolean;
    courseName: string;
    links: LinkDTO[];
    questions: QuestionDTO[];
  }[];
  pendingInActive: { unit: UnitSummaryDTO; pending: QuestionDTO[]; flagged: QuestionDTO[] }[];
  conflicts: { link: LinkDTO; entityTitle: string; unitId: number | null; supporting: LinkDTO[]; content: string | null }[];
  sourcesAwaiting: number;
  counts: { topics: number; units: number; questions: number; flagged: number; conflicts: number };
}

export interface SuggestResultDTO {
  runId: number;
  auditId: number | null;
  provider: string;
  topics: number;
  units: number;
  questions: number;
  conflicts: number;
  skipped: number;
  failedValidation: number;
  durationMs: number;
}

export interface BackupInfoDTO {
  file: string;
  kind: 'auto' | 'manual' | 'pre-restore' | 'uploaded';
  size: number;
  createdAt: string;
}

export interface AuditEntryDTO {
  id: number;
  at: string;
  action: string;
  summary: string;
  entity_type: string | null;
  entity_id: number | null;
  undoable: number;
  undone_at: string | null;
  undo_of: number | null;
  change_count: number;
}
