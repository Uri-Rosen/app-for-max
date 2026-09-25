// Provider for a model running locally in Ollama. The model receives the
// chunks with their ids and a JSON schema (structured outputs); whatever comes
// back is coerced defensively — malformed items are dropped, good ones kept —
// and then goes through validate.ts like every other suggestion.

import { KIND_LABELS } from '../../shared/labels.ts';
import { ANSWER_TEMPLATES, QUESTION_KINDS, TEMPLATE_FIELDS } from '../../shared/types.ts';
import type { AnswerStructure, AnswerTemplate, QuestionKind } from '../../shared/types.ts';
import { TOPICS_SYSTEM_PROMPT, UNITS_SYSTEM_PROMPT, buildTopicsUserPrompt, buildUnitsUserPrompt } from './prompts.ts';
import type { ChunkPiece } from './prompts.ts';
import type {
  AIProvider,
  ChunkRef,
  ConflictSuggestion,
  Evidence,
  QuestionSuggestion,
  TopicSuggestion,
  TopicsInput,
  UnitsInput,
  UnitsOutput,
  UnitSuggestion,
} from './types.ts';
import { normalizeText } from './validate.ts';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
/** Chunk text per request; small local models lose track of long inputs. */
export const MAX_BATCH_CHARS = 6000;
const DEFAULT_TIMEOUT_MS = 180_000;
const TAGS_TIMEOUT_MS = 5_000;

export interface OllamaOptions {
  url: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBatchChars?: number;
}

// ---------- output schemas (Ollama structured outputs) ----------

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const STRING = { type: 'string' };

const EVIDENCE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { chunkId: { type: 'integer' }, quote: STRING },
    required: ['chunkId', 'quote'],
  },
};

const FIELD_NAMES = [...new Set(Object.values(TEMPLATE_FIELDS).flat())];

const STRUCTURE_SCHEMA = nullable({
  type: 'object',
  properties: {
    template: { type: 'string', enum: [...ANSWER_TEMPLATES] },
    fields: { type: 'object', properties: Object.fromEntries(FIELD_NAMES.map((f) => [f, STRING])) },
    analogy: STRING,
  },
  required: ['template', 'fields'],
});

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...QUESTION_KINDS] },
    prompt: STRING,
    answer: STRING,
    explanation: nullable(STRING),
    hint: nullable(STRING),
    keyPoints: { type: 'array', items: STRING },
    structure: STRUCTURE_SCHEMA,
    evidence: EVIDENCE_SCHEMA,
  },
  required: ['kind', 'prompt', 'answer', 'explanation', 'hint', 'keyPoints', 'structure', 'evidence'],
};

export const UNITS_SCHEMA = {
  type: 'object',
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: STRING,
          content: STRING,
          topicName: STRING,
          evidence: EVIDENCE_SCHEMA,
          questions: { type: 'array', items: QUESTION_SCHEMA },
        },
        required: ['title', 'content', 'topicName', 'evidence', 'questions'],
      },
    },
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { description: STRING, evidence: EVIDENCE_SCHEMA },
        required: ['description', 'evidence'],
      },
    },
  },
  required: ['units', 'conflicts'],
};

export const TOPICS_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: STRING,
          parentName: nullable(STRING),
          description: nullable(STRING),
          syllabusOrder: nullable({ type: 'integer' }),
          evidence: EVIDENCE_SCHEMA,
        },
        required: ['name', 'parentName', 'description', 'syllabusOrder', 'evidence'],
      },
    },
  },
  required: ['topics'],
};

// ---------- defensive coercion ----------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function int(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
  return null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Accepts the code ("causal") or its Hebrew label ("הסבר סיבתי"). */
const KIND_ALIASES = new Map<string, QuestionKind>();
for (const k of QUESTION_KINDS) {
  KIND_ALIASES.set(k, k);
  KIND_ALIASES.set(normalizeText(KIND_LABELS[k]), k);
}

function coerceKind(v: unknown): QuestionKind | null {
  const s = str(v);
  return s ? (KIND_ALIASES.get(normalizeText(s)) ?? null) : null;
}

export function coerceEvidence(v: unknown): Evidence[] {
  const out: Evidence[] = [];
  for (const e of list(v)) {
    if (!isObj(e)) continue;
    const chunkId = int(e.chunkId ?? e.chunk_id ?? e.id);
    const quote = str(e.quote ?? e.text);
    if (chunkId === null || !quote) continue;
    if (!out.some((x) => x.chunkId === chunkId && x.quote === quote)) out.push({ chunkId, quote });
  }
  return out;
}

function coerceStructure(v: unknown): AnswerStructure | null {
  if (!isObj(v)) return null;
  const template = str(v.template);
  if (!template || !(ANSWER_TEMPLATES as readonly string[]).includes(template)) return null;
  const t = template as AnswerTemplate;
  // Rebuilt in template order, so a pathway always reads source → signal → target → outcome.
  const fields: Record<string, string> = {};
  if (isObj(v.fields)) {
    for (const f of TEMPLATE_FIELDS[t]) {
      const val = v.fields[f];
      if (typeof val === 'string') fields[f] = val.trim();
    }
  }
  const s: AnswerStructure = { template: t, fields };
  const analogy = str(v.analogy);
  if (analogy) s.analogy = analogy;
  return s;
}

function coerceQuestion(v: unknown, fallback: Evidence[]): QuestionSuggestion | null {
  if (!isObj(v)) return null;
  const kind = coerceKind(v.kind);
  const prompt = str(v.prompt);
  const answer = str(v.answer);
  if (!kind || !prompt || !answer) return null;
  const evidence = coerceEvidence(v.evidence);
  return {
    kind,
    prompt,
    answer,
    explanation: str(v.explanation),
    hint: str(v.hint),
    keyPoints: list(v.keyPoints ?? v.key_points)
      .map(str)
      .filter((x): x is string => x !== null),
    structure: coerceStructure(v.structure),
    evidence: evidence.length ? evidence : fallback,
  };
}

function coerceUnit(v: unknown, topicHint: string | null): UnitSuggestion | null {
  if (!isObj(v)) return null;
  const title = str(v.title);
  if (!title) return null;
  let evidence = coerceEvidence(v.evidence);
  const questions = list(v.questions)
    .map((q) => coerceQuestion(q, evidence))
    .filter((q): q is QuestionSuggestion => q !== null);
  if (evidence.length === 0) {
    evidence = coerceEvidence(questions.flatMap((q) => q.evidence));
    for (const q of questions) if (q.evidence.length === 0) q.evidence = evidence;
  }
  // A missing summary falls back to the source's own words, never to invented text.
  const content = str(v.content) ?? (evidence[0]?.quote || null);
  if (!content) return null;
  return { title, content, topicName: str(v.topicName ?? v.topic) ?? topicHint ?? '', evidence, questions };
}

function coerceConflict(v: unknown): ConflictSuggestion | null {
  if (!isObj(v)) return null;
  const description = str(v.description);
  const evidence = coerceEvidence(v.evidence);
  if (!description || evidence.length < 2) return null;
  return { description, evidence };
}

function coerceTopic(v: unknown): TopicSuggestion | null {
  if (!isObj(v)) return null;
  const name = str(v.name);
  if (!name) return null;
  const order = int(v.syllabusOrder ?? v.syllabus_order);
  return {
    name,
    parentName: str(v.parentName ?? v.parent),
    description: str(v.description),
    syllabusOrder: order !== null && order >= 0 ? order : null,
    evidence: coerceEvidence(v.evidence),
  };
}

export function coerceUnitsOutput(raw: unknown, topicHint: string | null): UnitsOutput {
  const units = isObj(raw) ? list(raw.units) : list(raw);
  const conflicts = isObj(raw) ? list(raw.conflicts) : [];
  return {
    units: units.map((u) => coerceUnit(u, topicHint)).filter((u): u is UnitSuggestion => u !== null),
    conflicts: conflicts.map(coerceConflict).filter((c): c is ConflictSuggestion => c !== null),
  };
}

export function coerceTopics(raw: unknown): TopicSuggestion[] {
  const topics = isObj(raw) ? list(raw.topics) : list(raw);
  return topics.map(coerceTopic).filter((t): t is TopicSuggestion => t !== null);
}

/** JSON.parse that tolerates code fences and chatter around the object. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    // fall through
  }
  const start = t.search(/[[{]/);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  return undefined;
}

// ---------- batching ----------

function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    let l = line;
    while (l.length > max) {
      const space = l.lastIndexOf(' ', max);
      const at = space > max / 2 ? space : max;
      if (cur) {
        out.push(cur);
        cur = '';
      }
      out.push(l.slice(0, at));
      l = l.slice(at).trimStart();
    }
    if (cur && cur.length + 1 + l.length > max) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) out.push(cur);
  return out;
}

/** Groups chunks into requests of at most `maxChars` of text; a longer chunk is split on line breaks. */
export function packChunks(chunks: ChunkRef[], maxChars: number = MAX_BATCH_CHARS): ChunkPiece[][] {
  const pieces: ChunkPiece[] = [];
  for (const c of chunks) {
    const text = String(c.text ?? '');
    if (!text.trim() && !c.heading) continue;
    for (const part of splitText(text, maxChars)) pieces.push({ chunk: c, text: part });
  }
  const batches: ChunkPiece[][] = [];
  let cur: ChunkPiece[] = [];
  let size = 0;
  for (const p of pieces) {
    if (cur.length && size + p.text.length > maxChars) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// ---------- provider ----------

function modelMatches(installed: string, wanted: string): boolean {
  const n = installed.toLowerCase();
  const m = wanted.toLowerCase();
  return n === m || (!m.includes(':') && n === `${m}:latest`) || (m.endsWith(':latest') && n === m.slice(0, -7));
}

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as unknown;
      if (isObj(j) && typeof j.error === 'string') return j.error;
    } catch {
      // not JSON
    }
    return text.slice(0, 200).trim();
  } catch {
    return '';
  }
}

type ChatResult = { ok: true; value: unknown } | { ok: false; error: string };

export class OllamaProvider implements AIProvider {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBatchChars: number;

  constructor(opts: OllamaOptions) {
    this.id = 'ollama';
    this.url = (opts.url?.trim() || DEFAULT_OLLAMA_URL).replace(/\/+$/, '');
    this.model = opts.model?.trim() ?? '';
    this.label = `מודל מקומי (Ollama · ${this.model || 'לא נבחר מודל'})`;
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBatchChars = opts.maxBatchChars ?? MAX_BATCH_CHARS;
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    if (!this.model) return { ok: false, detail: 'לא נבחר מודל ל־Ollama — יש לבחור מודל בהגדרות' };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/api/tags`, { method: 'GET', signal: AbortSignal.timeout(TAGS_TIMEOUT_MS) });
    } catch {
      return { ok: false, detail: `Ollama לא פועל בכתובת ${this.url} — יש להתקין ולהפעיל את Ollama (ollama serve) ולנסות שוב` };
    }
    if (!res.ok) return { ok: false, detail: `Ollama החזיר שגיאה ${res.status} בבדיקת המודלים המותקנים` };
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { ok: false, detail: 'Ollama החזיר תשובה לא תקינה לרשימת המודלים' };
    }
    const names = (isObj(data) ? list(data.models) : [])
      .flatMap((m) => (isObj(m) ? [str(m.name), str(m.model)] : []))
      .filter((n): n is string => n !== null);
    if (names.some((n) => modelMatches(n, this.model))) return { ok: true, detail: `Ollama פועל והמודל ${this.model} זמין` };
    const installed = [...new Set(names)].slice(0, 8);
    return {
      ok: false,
      detail: `Ollama פועל, אבל המודל "${this.model}" לא מותקן. להתקנה הרץ: ollama pull ${this.model}${installed.length ? ` (מותקנים: ${installed.join(', ')})` : ' (אין מודלים מותקנים)'}`,
    };
  }

  async suggestTopics(input: TopicsInput): Promise<TopicSuggestion[]> {
    const existing = new Set((input.existingTopics ?? []).map(normalizeText));
    const byKey = new Map<string, TopicSuggestion>();
    const out: TopicSuggestion[] = [];
    await this.run(
      input.chunks ?? [],
      (batch) => [TOPICS_SYSTEM_PROMPT, buildTopicsUserPrompt(input, batch), TOPICS_SCHEMA],
      (value) => {
        for (const t of coerceTopics(value)) {
          const key = normalizeText(t.name);
          if (existing.has(key)) continue;
          const prev = byKey.get(key);
          if (prev) {
            prev.evidence.push(...t.evidence.filter((e) => !prev.evidence.some((x) => x.chunkId === e.chunkId && x.quote === e.quote)));
            prev.syllabusOrder ??= t.syllabusOrder;
            prev.parentName ??= t.parentName;
            prev.description ??= t.description;
            continue;
          }
          byKey.set(key, t);
          out.push(t);
        }
      },
    );
    return out;
  }

  async suggestUnits(input: UnitsInput): Promise<UnitsOutput> {
    const byTitle = new Map<string, UnitSuggestion>();
    const units: UnitSuggestion[] = [];
    const conflicts: ConflictSuggestion[] = [];
    await this.run(
      input.chunks ?? [],
      (batch) => [UNITS_SYSTEM_PROMPT, buildUnitsUserPrompt(input, batch), UNITS_SCHEMA],
      (value) => {
        const got = coerceUnitsOutput(value, input.topicHint ?? null);
        conflicts.push(...got.conflicts);
        for (const u of got.units) {
          const key = normalizeText(u.title);
          const prev = byTitle.get(key);
          if (!prev) {
            byTitle.set(key, u);
            units.push(u);
            continue;
          }
          // The same unit proposed from two batches: keep one, with every distinct question.
          for (const e of u.evidence) if (!prev.evidence.some((x) => x.chunkId === e.chunkId && x.quote === e.quote)) prev.evidence.push(e);
          for (const q of u.questions) if (!prev.questions.some((x) => normalizeText(x.prompt) === normalizeText(q.prompt))) prev.questions.push(q);
        }
      },
    );
    return { units, conflicts };
  }

  /** Sends one request per batch. Transport errors abort; an unparseable batch is skipped unless all are. */
  private async run(chunks: ChunkRef[], build: (batch: ChunkPiece[]) => [string, string, object], take: (value: unknown) => void): Promise<void> {
    const batches = packChunks(chunks, this.maxBatchChars);
    let parsed = 0;
    let lastError = '';
    for (const batch of batches) {
      const [system, user, schema] = build(batch);
      const r = await this.chat(system, user, schema);
      if (!r.ok) {
        lastError = r.error;
        continue;
      }
      parsed++;
      take(r.value);
    }
    if (batches.length > 0 && parsed === 0) throw new Error(lastError || 'המודל לא החזיר הצעות');
  }

  private async chat(system: string, user: string, format: object): Promise<ChatResult> {
    if (!this.model) throw new Error('לא נבחר מודל ל־Ollama — יש לבחור מודל בהגדרות');
    const body = JSON.stringify({
      model: this.model,
      stream: false,
      format,
      options: { temperature: 0.2 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new Error(this.describeFailure(e));
    }
    if (!res.ok) {
      const detail = await errorDetail(res);
      if (res.status === 404 && /model|not found/i.test(detail)) {
        throw new Error(`המודל "${this.model}" לא מותקן ב־Ollama. להתקנה הרץ: ollama pull ${this.model}`);
      }
      throw new Error(`Ollama החזיר שגיאה ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch (e) {
      if (isTimeout(e)) throw new Error(this.describeFailure(e));
      return { ok: false, error: 'Ollama החזיר תשובה שאינה JSON' };
    }
    const content = isObj(data) && isObj(data.message) ? data.message.content : undefined;
    if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'המודל החזיר תשובה ריקה' };
    const value = parseJsonLoose(content);
    if (value === undefined) return { ok: false, error: 'המודל החזיר פלט שאינו JSON תקין' };
    return { ok: true, value };
  }

  private describeFailure(e: unknown): string {
    if (isTimeout(e)) {
      return `המודל לא הגיב בתוך ${Math.round(this.timeoutMs / 1000)} שניות — נסה מודל קטן יותר או פחות חומר בכל בקשה`;
    }
    return `לא ניתן להתחבר ל־Ollama בכתובת ${this.url} — ודא ש־Ollama מותקן ופועל (ollama serve)`;
  }
}
