// Grounding and sanity checks, run on every AI suggestion before it is stored
// as a proposal. Severity lives in the check code: `err.*` is a hard failure
// (report.ok = false), `warn.*` is shown to the approver but never fails the
// report. Hard checks are always listed, passed or not, so the approval screen
// can show what was verified; warnings are listed only when raised.
//
// The text helpers at the top are shared with the providers so that the mock
// quotes exactly what this file will accept.

import { ANSWER_TEMPLATES, QUESTION_KINDS, TEMPLATE_FIELDS } from '../../shared/types.ts';
import type { AnswerStructure, AnswerTemplate, QuestionKind, SourceKind } from '../../shared/types.ts';
import { FIELD_LABELS, KIND_LABELS, SOURCE_KIND_LABELS, TEMPLATE_LABELS } from '../../shared/labels.ts';
import type {
  Check,
  ChunkRef,
  ConflictSuggestion,
  Evidence,
  QuestionSuggestion,
  TopicSuggestion,
  UnitSuggestion,
  ValidationReport,
} from './types.ts';

// ---------- text normalization ----------

const INVISIBLE = /[\u{AD}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}]/gu;
const NIQQUD = /[\u{591}-\u{5BD}\u{5BF}\u{5C1}\u{5C2}\u{5C4}\u{5C5}\u{5C7}]/gu;
const DOUBLE_QUOTES = /[\u{5F4}\u{201C}-\u{201F}\u{AB}\u{BB}\u{2033}\u{301D}\u{301E}]/gu;
const SINGLE_QUOTES = /[\u{5F3}\u{2018}-\u{201B}\u{60}\u{B4}\u{2032}]/gu;
const DASHES = /[\u{5BE}\u{2010}-\u{2015}\u{2212}\u{FE58}\u{FE63}\u{FF0D}]/gu;
const ARROWS = /\s*(?:-+>|=+>|⇒|⟶|➔|➜|⟹|→)\s*/g;

/**
 * Canonical form for comparing text: NFKC (also folds PDF ligatures), no
 * niqqud or invisible bidi marks, one kind of quote/dash/arrow, single spaces,
 * lower case.
 */
export function normalizeText(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(NIQQUD, '')
    .replace(DOUBLE_QUOTES, '"')
    .replace(SINGLE_QUOTES, "'")
    .replace(DASHES, '-')
    .replace(ARROWS, ' → ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const EDGE_PUNCT = /^[\s"'.,;:!?()[\]{}<>*•·…-]+|[\s"'.,;:!?()[\]{}<>*•·…-]+$/g;

export function stripEdgePunct(s: string): string {
  return s.replace(EDGE_PUNCT, '');
}

const TOKEN = /[\p{L}\p{N}]+(?:["'][\p{L}\p{N}]+)*/gu;

export function tokenize(s: string): string[] {
  return normalizeText(s).match(TOKEN) ?? [];
}

export const STOPWORDS: ReadonlySet<string> = new Set([
  // Hebrew function words
  'של', 'את', 'על', 'עם', 'אל', 'מן', 'עד', 'הוא', 'היא', 'הם', 'הן', 'זה', 'זו', 'זאת', 'אלה', 'אלו', 'כי', 'אם',
  'או', 'גם', 'לא', 'כן', 'יש', 'אין', 'אשר', 'כל', 'בין', 'כמו', 'לפי', 'אחר', 'אחרי', 'לפני', 'יותר', 'פחות',
  'מאוד', 'רק', 'כך', 'כאשר', 'בו', 'בה', 'בהם', 'בהן', 'לו', 'לה', 'להם', 'להן', 'אותו', 'אותה', 'אותם', 'אותן',
  'מה', 'מי', 'איך', 'למה', 'מהו', 'מהי', 'מהם', 'מהן', 'שם', 'אך', 'אבל', 'וכן', 'ידי', 'כדי', 'הינו', 'הינה',
  'הינם', 'הינן', 'זהו', 'זוהי', 'כלומר', 'למשל', 'בעוד', 'ואילו', 'אף', 'עוד', 'כבר', 'היה', 'היתה', 'הייתה',
  'היו', 'שבו', 'שבה', 'שבהם', 'שבהן', 'בתוך', 'תוך', 'ללא', 'בלי', 'כגון', 'אצל', 'לגבי', 'בגלל', 'עקב', 'לכן',
  'אולם', 'ולא', 'וגם', 'מכך', 'כזה', 'כזו', 'ועוד',
  // English function words
  'the', 'a', 'an', 'of', 'in', 'on', 'to', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'by', 'for', 'with',
  'and', 'or', 'as', 'at', 'that', 'this', 'these', 'those', 'it', 'its', 'from', 'which', 'what', 'who', 'whom',
  'into', 'than', 'then', 'not', 'no', 'can', 'may', 'might', 'also', 'such', 'so', 'if', 'but', 'do', 'does',
  'did', 'has', 'have', 'had', 'will', 'would', 'should', 'could', 'there', 'their', 'they', 'them', 'he', 'she',
  'we', 'you', 'i', 'our', 'your', 'his', 'her', 'about', 'between', 'through', 'during', 'after', 'before',
  'over', 'under', 'up', 'down', 'out', 'more', 'most', 'less', 'very', 'both', 'each', 'other', 'some', 'any',
  'all', 'only', 'same', 'own', 'just', 'when', 'where', 'how', 'why', 'whose', 'while',
]);

/** Distinct content words (normalized), in order of first appearance. */
export function contentWords(s: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(s)) {
    if (seen.has(t)) continue;
    seen.add(t);
    if (STOPWORDS.has(t)) continue;
    if (t.length < 2 && !/\d/.test(t)) continue;
    out.push(t);
  }
  return out;
}

const HE_PREFIXES = 'ובכלמשה';

/**
 * Match keys for one normalized word: the word itself plus the forms left after
 * dropping up to two Hebrew prefix letters (ו/ה/ב/כ/ל/מ/ש) or an English plural.
 * Two words "match" when their key sets intersect.
 */
export function wordKeys(t: string): string[] {
  const keys = [t];
  if (/^[א-ת]/.test(t)) {
    let s = t;
    for (let i = 0; i < 2 && s.length > 3 && HE_PREFIXES.includes(s[0]); i++) {
      s = s.slice(1);
      keys.push(s);
    }
  } else if (/^[a-z]+$/.test(t) && t.length > 3) {
    if (t.endsWith('ies')) keys.push(`${t.slice(0, -3)}y`);
    else if (t.endsWith('es')) keys.push(t.slice(0, -2), t.slice(0, -1));
    else if (t.endsWith('s') && !t.endsWith('ss')) keys.push(t.slice(0, -1));
  }
  return keys;
}

export function keySet(text: string): Set<string> {
  const set = new Set<string>();
  for (const w of contentWords(text)) for (const k of wordKeys(w)) set.add(k);
  return set;
}

function matches(word: string, keys: Set<string>): boolean {
  return wordKeys(word).some((k) => keys.has(k));
}

/** Share of `text`'s content words that also occur in `source` (prefix-insensitive). */
export function coverage(text: string, source: string | Set<string>): { ratio: number; total: number } {
  const words = contentWords(text);
  if (words.length === 0) return { ratio: 1, total: 0 };
  const keys = typeof source === 'string' ? keySet(source) : source;
  const found = words.filter((w) => matches(w, keys)).length;
  return { ratio: found / words.length, total: words.length };
}

/** Jaccard-style similarity of two texts' content words, prefix-insensitive. */
export function similarity(a: string, b: string): number {
  const A = contentWords(a);
  const B = contentWords(b);
  if (A.length === 0 || B.length === 0) return 0;
  const aKeys = keySet(a);
  const bKeys = keySet(b);
  const inter = (A.filter((w) => matches(w, bKeys)).length + B.filter((w) => matches(w, aKeys)).length) / 2;
  return inter / (A.length + B.length - inter);
}

// ---------- quotes ----------

const haystackCache = new WeakMap<ChunkRef, string[]>();

function haystacks(c: ChunkRef): string[] {
  let h = haystackCache.get(c);
  if (!h) {
    h = [normalizeText(c.text ?? ''), c.heading ? normalizeText(c.heading) : ''];
    haystackCache.set(c, h);
  }
  return h;
}

/**
 * Where a quote sits in its chunk (text or heading), after normalization.
 * `elided`: the quote skips text with "..." and every part is found, in order.
 */
export function locateQuote(quote: string, chunk: ChunkRef): 'exact' | 'elided' | null {
  if (typeof quote !== 'string') return null;
  const q = stripEdgePunct(normalizeText(quote));
  if (!q) return null;
  const hay = haystacks(chunk);
  if (hay.some((h) => h.includes(q))) return 'exact';
  const parts = q.split(/\s*\.{3}\s*/).map(stripEdgePunct).filter(Boolean);
  if (parts.length >= 2 && parts.every((p) => p.length >= 4)) {
    let from = 0;
    for (const p of parts) {
      const i = hay[0].indexOf(p, from);
      if (i < 0) return null;
      from = i + p.length;
    }
    return 'elided';
  }
  return null;
}

// ---------- checks ----------

export function isHardCheck(c: Check): boolean {
  return c.code.startsWith('err.');
}

export function chunkMap(chunks: Iterable<ChunkRef>): Map<number, ChunkRef> {
  const m = new Map<number, ChunkRef>();
  for (const c of chunks) m.set(c.chunkId, c);
  return m;
}

function mk(code: string, ok: boolean, message: string): Check {
  return { code, ok, message };
}

function finish(checks: Check[]): ValidationReport {
  return { ok: checks.every((c) => c.ok || !isHardCheck(c)), checks };
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function clip(s: string, n = 60): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function evidenceList(v: unknown): Evidence[] {
  return Array.isArray(v) ? (v as Evidence[]).filter((e) => e && typeof e === 'object') : [];
}

const GROUNDING_MIN = 0.5;
const OFFICIAL_KINDS: ReadonlySet<SourceKind> = new Set(['slides', 'lesson_summary', 'course_material', 'manual']);

function evidenceChecks(evidence: Evidence[], chunks: Map<number, ChunkRef>, minContentWords: number): Check[] {
  const out: Check[] = [];
  const n = evidence.length;
  out.push(
    mk(
      'err.evidence.missing',
      n > 0,
      n > 0 ? `מבוסס על ${n === 1 ? 'ציטוט אחד' : `${n} ציטוטים`} מהמקור` : 'אין ציטוט מהמקור — ההצעה אינה מבוססת',
    ),
  );
  if (n === 0) return out;

  const unknown = evidence.filter((e) => !chunks.has(Number(e.chunkId)));
  out.push(
    mk(
      'err.evidence.chunk',
      unknown.length === 0,
      unknown.length === 0
        ? 'כל הציטוטים מפנים לקטעי מקור קיימים'
        : `ציטוט מפנה לקטע מקור שאינו קיים (${[...new Set(unknown.map((e) => String(e.chunkId)))].join(', ')})`,
    ),
  );

  const fabricated: Evidence[] = [];
  let elided = 0;
  let short = 0;
  let checked = 0;
  for (const e of evidence) {
    const c = chunks.get(Number(e.chunkId));
    if (!c) continue;
    checked++;
    const where = locateQuote(e.quote, c);
    if (!where) fabricated.push(e);
    else {
      if (where === 'elided') elided++;
      if (minContentWords > 0 && contentWords(e.quote).length < minContentWords) short++;
    }
  }
  if (checked > 0) {
    out.push(
      mk(
        'err.evidence.quote_not_found',
        fabricated.length === 0,
        fabricated.length === 0
          ? 'כל הציטוטים נמצאו מילה במילה בטקסט המקור'
          : `ציטוט שלא נמצא בטקסט המקור — ייתכן שהומצא: ${fabricated.map((e) => `"${clip(text(e.quote)) || '(ריק)'}"`).join('; ')}`,
      ),
    );
  }
  if (elided) out.push(mk('warn.evidence.quote_elided', false, 'ציטוט מקוצר ב־"..." — החלקים נמצאו במקור, אבל לא ברצף אחד'));
  if (short) out.push(mk('warn.evidence.quote_short', false, 'ציטוט קצר מדי כדי לבסס את התשובה'));
  return out;
}

function sourceChecks(evidence: Evidence[], chunks: Map<number, ChunkRef>): Check[] {
  const kinds = [...new Set(evidence.map((e) => chunks.get(Number(e.chunkId))?.sourceKind).filter((k): k is SourceKind => !!k))];
  if (kinds.length === 0 || kinds.some((k) => OFFICIAL_KINDS.has(k))) return [];
  if (kinds.length === 1) {
    switch (kinds[0]) {
      case 'past_exam':
        return [mk('warn.source.past_exam_only', false, 'מבחן קודם בלבד — לא מקור סמכותי יחיד')];
      case 'student_summary':
        return [mk('warn.source.student_summary_only', false, 'סיכום סטודנטים בלבד — יש לבדוק מול חומר הקורס')];
      case 'syllabus':
        return [mk('warn.source.syllabus_only', false, 'סילבוס בלבד — מפת ציפיות, לא מקור לתוכן עצמו')];
      case 'external':
        return [mk('warn.source.external_only', false, 'מקור חיצוני בלבד — הרחבה מחוץ לחומר הקורס')];
    }
  }
  return [
    mk('warn.source.no_official', false, `אין תמיכה מחומר רשמי של הקורס (רק: ${kinds.map((k) => SOURCE_KIND_LABELS[k] ?? k).join(', ')})`),
  ];
}

function citedKeys(evidence: Evidence[], chunks: Map<number, ChunkRef>): Set<string> | null {
  const parts: string[] = [];
  for (const e of evidence) {
    const c = chunks.get(Number(e.chunkId));
    if (c) parts.push(c.text ?? '', c.heading ?? '');
  }
  return parts.length ? keySet(parts.join('\n')) : null;
}

function groundingCheck(code: string, message: string, value: string, evidence: Evidence[], chunks: Map<number, ChunkRef>): Check[] {
  const keys = citedKeys(evidence, chunks);
  if (!keys || !value) return [];
  const { ratio, total } = coverage(value, keys);
  if (total === 0 || ratio >= GROUNDING_MIN) return [];
  return [mk(code, false, `${message} (${Math.round(ratio * 100)}% מהמילים המרכזיות מופיעות בו)`)];
}

const KEYPOINT_KINDS: ReadonlySet<QuestionKind> = new Set(['recall', 'causal', 'comparison', 'application']);
const BLANK = /\[\[([^\]]*)\]\]/g;

export function clozeBlanks(prompt: string): string[] {
  return [...prompt.matchAll(BLANK)].map((m) => m[1].trim()).filter(Boolean);
}

/** The answer's content words appear, contiguously, in the visible part of the prompt. */
function leaksAnswer(prompt: string, answer: string): boolean {
  const a = tokenize(answer).filter((t) => !STOPWORDS.has(t));
  if (a.length === 0) return false;
  const p = tokenize(prompt.replace(BLANK, ' ')).filter((t) => !STOPWORDS.has(t));
  outer: for (let i = 0; i + a.length <= p.length; i++) {
    for (let j = 0; j < a.length; j++) if (p[i + j] !== a[j]) continue outer;
    return true;
  }
  return false;
}

function structureChecks(s: AnswerStructure | null | undefined): Check[] {
  if (s === null || s === undefined) return [];
  const template = (s as { template?: unknown }).template;
  if (typeof s !== 'object' || !(ANSWER_TEMPLATES as readonly unknown[]).includes(template)) {
    return [mk('err.structure.template', false, `תבנית תשובה לא מוכרת: "${String(template)}"`)];
  }
  const t = template as AnswerTemplate;
  const fields = s.fields && typeof s.fields === 'object' ? s.fields : null;
  if (!fields) return [mk('err.structure.fields', false, 'לתבנית התשובה אין שדות')];
  const expected = TEMPLATE_FIELDS[t];
  const out: Check[] = [];
  const unknown = Object.keys(fields).filter((k) => !expected.includes(k));
  if (unknown.length) {
    out.push(mk('warn.structure.unknown_fields', false, `שדות שאינם שייכים לתבנית "${TEMPLATE_LABELS[t]}": ${unknown.join(', ')}`));
  }
  // A general answer fills what the source supports; pathway and method must be complete and ordered.
  if (t === 'general') return out;
  const order = expected.map((f) => FIELD_LABELS[f] ?? f).join(' → ');
  const missing = expected.filter((f) => typeof fields[f] !== 'string' || !fields[f].trim());
  if (missing.length) {
    out.push(
      mk(
        'warn.structure.missing',
        false,
        `${t === 'pathway' ? 'מסלול לא שלם' : 'שיטה ניסויית לא שלמה'} (${order}) — חסר: ${missing.map((f) => FIELD_LABELS[f] ?? f).join(', ')}`,
      ),
    );
  }
  const present = Object.keys(fields).filter((k) => expected.includes(k));
  const inOrder = present.every((k, i) => i === 0 || expected.indexOf(present[i - 1]) < expected.indexOf(k));
  if (!inOrder) out.push(mk('warn.structure.order', false, `סדר השדות צריך להיות ${order}`));
  return out;
}

// ---------- public validators ----------

export function validateQuestion(q: QuestionSuggestion, chunks: Map<number, ChunkRef>): ValidationReport {
  const checks: Check[] = [];
  const kindOk = (QUESTION_KINDS as readonly unknown[]).includes(q.kind);
  checks.push(mk('err.kind.invalid', kindOk, kindOk ? `סוג השאלה: ${KIND_LABELS[q.kind]}` : `סוג שאלה לא מוכר: "${String(q.kind)}"`));

  const prompt = text(q.prompt);
  const answer = text(q.answer);
  checks.push(mk('err.prompt.empty', prompt.length > 0, prompt ? 'יש ניסוח לשאלה' : 'נוסח השאלה ריק'));
  checks.push(mk('err.answer.empty', answer.length > 0, answer ? 'יש תשובה' : 'התשובה ריקה'));

  if (q.kind === 'cloze') {
    const blanks = clozeBlanks(prompt);
    checks.push(
      mk(
        'err.cloze.no_blank',
        blanks.length > 0,
        blanks.length > 0
          ? `השלמה עם ${blanks.length === 1 ? 'חלק חסר אחד' : `${blanks.length} חלקים חסרים`}`
          : 'בשאלת השלמה חייב להיות חלק חסר מסומן ב־[[...]]',
      ),
    );
    if (blanks.length && answer && !blanks.some((b) => normalizeText(answer).includes(normalizeText(b)))) {
      checks.push(mk('warn.cloze.answer_mismatch', false, 'התשובה אינה תואמת את החלק החסר ב־[[...]]'));
    }
  }

  const keyPoints = Array.isArray(q.keyPoints) ? q.keyPoints.filter((k) => typeof k === 'string' && k.trim()) : [];
  if (KEYPOINT_KINDS.has(q.kind) && keyPoints.length === 0) {
    checks.push(mk('warn.keypoints.missing', false, 'חסרות נקודות מפתח — מה התשובה חייבת לכלול (מנגנון, כיוון סיבתי, הבדלים)'));
  }
  checks.push(...structureChecks(q.structure));
  if (prompt && answer && leaksAnswer(prompt, answer)) {
    checks.push(mk('warn.prompt.leaks_answer', false, 'התשובה מופיעה כבר בנוסח השאלה'));
  }

  const evidence = evidenceList(q.evidence);
  checks.push(...evidenceChecks(evidence, chunks, 3));
  checks.push(...sourceChecks(evidence, chunks));
  checks.push(...groundingCheck('warn.answer.not_in_source', 'התשובה לא נמצאה במקור המצוטט', answer, evidence, chunks));
  if (q.kind === 'cloze') {
    checks.push(
      ...groundingCheck('warn.prompt.not_in_source', 'משפט ההשלמה לא נמצא במקור המצוטט', prompt.replace(BLANK, ' '), evidence, chunks),
    );
  }
  return finish(checks);
}

export function validateUnit(u: UnitSuggestion, chunks: Map<number, ChunkRef>): ValidationReport {
  const checks: Check[] = [];
  const title = text(u.title);
  const content = text(u.content);
  checks.push(mk('err.title.empty', title.length > 0, title ? 'יש כותרת ליחידה' : 'כותרת היחידה ריקה'));
  checks.push(mk('err.content.empty', content.length > 0, content ? 'יש תוכן ליחידה' : 'תוכן היחידה ריק'));
  if (!text(u.topicName)) checks.push(mk('warn.topic.missing', false, 'לא צוין נושא ליחידה'));

  const evidence = evidenceList(u.evidence);
  checks.push(...evidenceChecks(evidence, chunks, 3));
  checks.push(...sourceChecks(evidence, chunks));
  checks.push(...groundingCheck('warn.content.not_in_source', 'תוכן היחידה לא נמצא במקור המצוטט', content, evidence, chunks));

  const questions = Array.isArray(u.questions) ? u.questions : [];
  if (questions.length === 0) checks.push(mk('warn.unit.no_questions', false, 'אין שאלות ליחידה'));
  else {
    const failed = questions.filter((q) => !validateQuestion(q, chunks).ok).length;
    if (failed) checks.push(mk('warn.unit.questions_failed', false, `${failed} מתוך ${questions.length} שאלות נכשלו בבדיקה`));
  }
  return finish(checks);
}

export function validateTopic(t: TopicSuggestion, chunks: Map<number, ChunkRef>): ValidationReport {
  const checks: Check[] = [];
  const name = text(t.name);
  checks.push(mk('err.name.empty', name.length > 0, name ? 'יש שם לנושא' : 'שם הנושא ריק'));
  if (name.length > 80) checks.push(mk('warn.name.long', false, 'שם הנושא ארוך מדי — כנראה משפט ולא נושא'));
  if (t.syllabusOrder !== null && t.syllabusOrder !== undefined && !(Number.isInteger(t.syllabusOrder) && t.syllabusOrder >= 0)) {
    checks.push(mk('warn.order.invalid', false, `מיקום בסילבוס לא תקין: ${String(t.syllabusOrder)}`));
  }
  // Topics legitimately come from a syllabus alone, so no source-authority warnings here.
  const evidence = evidenceList(t.evidence);
  checks.push(...evidenceChecks(evidence, chunks, 0));
  checks.push(...groundingCheck('warn.name.not_in_source', 'שם הנושא לא נמצא במקור המצוטט', name, evidence, chunks));
  return finish(checks);
}

export function validateConflict(c: ConflictSuggestion, chunks: Map<number, ChunkRef>): ValidationReport {
  const checks: Check[] = [];
  const description = text(c.description);
  checks.push(mk('err.description.empty', description.length > 0, description ? 'יש תיאור לסתירה' : 'תיאור הסתירה ריק'));
  const evidence = evidenceList(c.evidence);
  checks.push(
    mk(
      'err.conflict.evidence_count',
      evidence.length >= 2,
      evidence.length >= 2 ? 'לסתירה יש ציטוט מכל צד' : 'סתירה צריכה לפחות שני ציטוטים',
    ),
  );
  checks.push(...evidenceChecks(evidence, chunks, 0));
  const sources = new Set(evidence.map((e) => chunks.get(Number(e.chunkId))?.sourceId).filter((s) => s !== undefined));
  if (evidence.length >= 2 && sources.size === 1) {
    checks.push(mk('warn.conflict.same_source', false, 'שני הציטוטים מאותו מקור — ייתכן שזו התפתחות של הסבר ולא סתירה'));
  }
  return finish(checks);
}
