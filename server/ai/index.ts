// Entry point for AI suggestions: pick the configured provider, and validate
// everything it returns before it becomes a proposal.

import type { Settings } from '../../shared/types.ts';
import { MockProvider } from './mock.ts';
import { OllamaProvider } from './ollama.ts';
import type { AIProvider } from './types.ts';

export function getProvider(s: Pick<Settings, 'aiProvider' | 'ollamaUrl' | 'ollamaModel'>): AIProvider {
  if (s.aiProvider === 'ollama') return new OllamaProvider({ url: s.ollamaUrl, model: s.ollamaModel });
  return new MockProvider();
}

export { MockProvider } from './mock.ts';
export { OllamaProvider, DEFAULT_OLLAMA_URL, MAX_BATCH_CHARS } from './ollama.ts';
export type { OllamaOptions } from './ollama.ts';
export { chunkMap, isHardCheck, normalizeText, validateConflict, validateQuestion, validateTopic, validateUnit } from './validate.ts';
export type {
  AIProvider,
  Check,
  ChunkRef,
  ConflictSuggestion,
  Evidence,
  QuestionSuggestion,
  StyleExample,
  TopicSuggestion,
  TopicsInput,
  UnitSuggestion,
  UnitsInput,
  UnitsOutput,
  ValidationReport,
} from './types.ts';
