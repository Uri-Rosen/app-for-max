// Contract for AI providers. A provider only *suggests*: every suggestion
// becomes a pending proposal that a human approves, edits or rejects.
// Providers never compute dates and never approve anything.

import type { AnswerStructure, QuestionKind, SourceKind } from '../../shared/types.ts';

export interface ChunkRef {
  chunkId: number;
  sourceId: number;
  sourceTitle: string;
  sourceKind: SourceKind;
  locatorLabel: string;
  heading: string | null;
  text: string;
}

/** A verbatim quote from a chunk that backs a suggestion. */
export interface Evidence {
  chunkId: number;
  quote: string;
}

/** An approved card of the learner's own, used to imitate their Quizlet style. */
export interface StyleExample {
  kind: QuestionKind;
  prompt: string;
  answer: string;
}

export interface TopicSuggestion {
  name: string;
  parentName: string | null;
  description: string | null;
  /** Position in the syllabus, when the source is a syllabus. */
  syllabusOrder: number | null;
  evidence: Evidence[];
}

export interface QuestionSuggestion {
  kind: QuestionKind;
  /** For cloze: the full sentence with the hidden part(s) wrapped in [[...]]. */
  prompt: string;
  answer: string;
  explanation: string | null;
  hint: string | null;
  keyPoints: string[];
  structure: AnswerStructure | null;
  evidence: Evidence[];
}

export interface UnitSuggestion {
  title: string;
  content: string;
  topicName: string;
  evidence: Evidence[];
  questions: QuestionSuggestion[];
}

export interface ConflictSuggestion {
  description: string;
  /** At least two pieces of evidence, from different sources. */
  evidence: Evidence[];
}

export interface TopicsInput {
  course: string;
  chunks: ChunkRef[];
  existingTopics: string[];
}

export interface UnitsInput {
  course: string;
  topicHint: string | null;
  chunks: ChunkRef[];
  existingTopics: string[];
  style: StyleExample[];
}

export interface UnitsOutput {
  units: UnitSuggestion[];
  conflicts: ConflictSuggestion[];
}

export interface AIProvider {
  readonly id: string;
  readonly label: string;
  available(): Promise<{ ok: boolean; detail: string }>;
  suggestTopics(input: TopicsInput): Promise<TopicSuggestion[]>;
  suggestUnits(input: UnitsInput): Promise<UnitsOutput>;
}

export interface Check {
  code: string;
  ok: boolean;
  /** Hebrew, shown next to the proposal in the approval screen. */
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  checks: Check[];
}
