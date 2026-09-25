// Deterministic heuristic provider: no model, no network, same input → same
// output. It reads course text the way a careful student skims it — headings,
// syllabus lines, "term – definition" lines, arrow chains, causal verbs — and
// proposes cards that quote the text verbatim, so everything it suggests
// passes validate.ts. Like any provider it only suggests.

import { SOURCE_KIND_LABELS, pre } from '../../shared/labels.ts';
import type { AnswerStructure, QuestionKind, SourceKind } from '../../shared/types.ts';
import { analyzeStyle } from './prompts.ts';
import type { StyleProfile } from './prompts.ts';
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
import { contentWords, keySet, normalizeText, similarity, stripEdgePunct, tokenize, wordKeys } from './validate.ts';

const MAX_UNITS = 40;
const MAX_QUESTIONS_PER_UNIT = 6;
const MAX_TOPIC_EVIDENCE = 3;
const CONFLICT_SIMILARITY = 0.3;

/** Which definition wins when sources disagree: what was taught beats helpers. */
const SOURCE_TIER: Record<SourceKind, number> = {
  course_material: 3,
  slides: 3,
  lesson_summary: 3,
  manual: 3,
  external: 1,
  student_summary: 1,
  past_exam: 1,
  syllabus: 0,
};

type Lang = 'he' | 'en';

// ---------- text helpers ----------

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function wordCount(s: string): number {
  const t = collapse(s);
  return t ? t.split(' ').length : 0;
}

function letterCount(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length;
}

function langOf(s: string): Lang {
  const he = (s.match(/[א-ת]/g) ?? []).length;
  const en = (s.match(/[A-Za-z]/g) ?? []).length;
  return en > he ? 'en' : 'he';
}

function trimPunct(s: string): string {
  let t = collapse(s).replace(/^["“”„«»״\s]+|["“”„«»״\s.,;:!?]+$/g, '');
  if (t.startsWith('(') && !t.includes(')')) t = t.slice(1).trim();
  if (t.endsWith(')') && !t.includes('(')) t = t.slice(0, -1).trim();
  return t;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "The hormone" / "Phosphorylation" → lower case inside an English sentence; acronyms stay. */
function inline(s: string): string {
  return s.replace(/^[A-Z][a-z]+\b/, (m) => m.toLowerCase());
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- lines and sentences ----------

interface Line {
  raw: string;
  /** `raw` without bullet / number / notes prefix — still an exact substring of the chunk. */
  body: string;
  text: string;
  bullet: boolean;
  num: number | null;
}

interface Sent {
  /** Exact substring of the chunk text: this is what gets quoted. */
  raw: string;
  text: string;
  chunk: ChunkRef;
  line: Line;
  first: boolean;
  /** The sentence is its whole line (a bullet), so a leading pronoun may refer to the heading. */
  solo: boolean;
  lang: Lang;
  seq: number;
}

const BULLET = /^(?:[•◦▪▫●○■□►▸‣⁃∙·✓✔➢➤*]|[-–—](?=\s))\s*/u;
const NUMBERED = /^\(?(\d{1,2})\s*[.)]\s+/;
const NOTES_PREFIX = /^הערות מרצה:\s*/;

function linesOf(text: string): Line[] {
  const out: Line[] = [];
  for (const piece of String(text ?? '').split('\n')) {
    const raw = piece.trim();
    if (!raw) continue;
    let body = raw.replace(NOTES_PREFIX, '');
    let bullet = false;
    let num: number | null = null;
    const b = BULLET.exec(body);
    if (b) {
      bullet = true;
      body = body.slice(b[0].length);
    }
    const n = NUMBERED.exec(body);
    if (n) {
      num = Number(n[1]);
      body = body.slice(n[0].length);
    }
    body = body.trim();
    if (body) out.push({ raw, body, text: collapse(body), bullet, num });
  }
  return out;
}

const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'fig', 'vs', 'cf', 'al', 'approx', 'ca', 'dr', 'prof', 'no', 'eq']);

function splitSentences(body: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of body.matchAll(/[.!?](?=\s+\S)/g)) {
    const idx = m.index ?? 0;
    if (m[0] === '.') {
      const last = /(\S+)$/.exec(body.slice(start, idx))?.[1] ?? '';
      if (/^\p{L}$/u.test(last) || ABBREVIATIONS.has(last.toLowerCase())) continue;
    }
    const s = body.slice(start, idx + 1).trim();
    if (s) out.push(s);
    start = idx + 1;
  }
  const rest = body.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

function sentencesOf(chunk: ChunkRef, seq: { n: number }): Sent[] {
  const out: Sent[] = [];
  for (const line of linesOf(chunk.text)) {
    const parts = splitSentences(line.body);
    parts.forEach((raw, i) => {
      out.push({ raw, text: collapse(raw), chunk, line, first: i === 0, solo: parts.length === 1, lang: langOf(raw), seq: seq.n++ });
    });
  }
  return out;
}

function evOf(s: Sent): Evidence {
  return { chunkId: s.chunk.chunkId, quote: s.raw };
}

function addEvidence(list: Evidence[], ...items: Evidence[]): void {
  for (const e of items) if (!list.some((x) => x.chunkId === e.chunkId && x.quote === e.quote)) list.push(e);
}

// ---------- topics ----------

const WEEK_LINE =
  /^(?:שבוע|שיעור|הרצאה|מפגש|יחידה|פרק|נושא|week|lecture|class|session|unit|chapter|topic)\s*(?:מס['׳]?\s*)?(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\s*(?:\([^)]*\)|,?\s*\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?)?\s*[:\-–—.)]\s*(.+)$/iu;

const CONTINUATION = [
  /\s*\((?:המשך|cont\.?|continued|\d{1,2}|[א-ת]['׳]?|[ivx]+)\)\s*$/iu,
  /\s*[-–—:,]\s*(?:המשך|cont\.?|continued)\s*$/iu,
  /\s+(?:המשך|cont\.?|continued)\s*$/iu,
  /\s*[-–—:,]?\s*(?:חלק|part)\s+(?:\d{1,2}|[א-ת]['׳]?|[ivx]+)\s*$/iu,
];

function stripContinuation(s: string): string {
  let t = s;
  for (const re of CONTINUATION) t = t.replace(re, '');
  return t.trim();
}

function cleanTopicName(s: string): string {
  let t = collapse(s).replace(BULLET, '').replace(NUMBERED, '');
  const w = WEEK_LINE.exec(t);
  if (w) t = w[2];
  return trimPunct(stripContinuation(t));
}

function topicKey(s: string): string {
  return stripEdgePunct(normalizeText(cleanTopicName(s)));
}

const JUNK_TOPICS = new Set(
  [
    'תודה', 'תודה רבה', 'שאלות', 'שאלות ותשובות', 'questions', 'q&a', 'agenda', 'תוכן עניינים', 'תוכן העניינים',
    'table of contents', 'contents', 'outline', 'סיכום', 'summary', 'מבוא', 'הקדמה', 'introduction', 'intro',
    'overview', 'סקירה', 'references', 'ביבליוגרפיה', 'bibliography', 'מקורות', 'קריאה', 'קריאה נוספת',
    'reading', 'further reading', 'reading list', 'homework', 'שיעורי בית', 'exercise', 'תרגיל', 'תרגול', 'recap',
    'חזרה', 'review', 'learning objectives', 'objectives', 'מטרות', 'מטרות השיעור', 'מטרות הלמידה', 'goals',
    'schedule', 'לוח זמנים', 'thank you', 'thanks', 'הפסקה', 'break', 'סילבוס', 'syllabus', 'untitled',
    'ללא כותרת', 'נספח', 'appendix', 'דוגמה', 'דוגמא', 'דוגמאות', 'example', 'examples', 'נושאי הקורס',
    'תכנית הקורס', 'תוכנית הקורס', 'מהלך הקורס', 'course outline', 'course schedule', 'course topics', 'topics',
    'נושאים', 'פרטי הקורס', 'course information', 'דרישות הקורס', 'course requirements', 'הערות', 'הערות מרצה',
  ].map(normalizeText),
);

/** Words that mark administrative syllabus lines (grading, reading, office hours…). */
const ADMIN_WORDS = new Set([
  'דרישות', 'ציון', 'ציונים', 'הערכה', 'נוכחות', 'מטלה', 'מטלות', 'הגשה', 'הגשות', 'מבחן', 'מבחנים', 'בוחן',
  'בחינה', 'קריאה', 'ביבליוגרפיה', 'שעות', 'קבלה', 'מרצה', 'מתרגל', 'מתרגלת', 'חופשה', 'חופשת', 'פסח', 'סוכות',
  'חנוכה', 'מועד', 'מועדים', 'grade', 'grades', 'grading', 'exam', 'exams', 'midterm', 'final', 'quiz',
  'assignment', 'assignments', 'homework', 'attendance', 'requirements', 'reading', 'readings', 'office',
  'lecturer', 'instructor', 'holiday', 'vacation',
]);
const ALWAYS_ADMIN = new Set(['סילבוס', 'syllabus']);
const LOCATOR_ONLY = /^(?:שקופית|slide|עמוד|עמ'|page|sheet|גיליון|section|סעיף|פרק|chapter)\s*\d*$/iu;

function hasWord(s: string, set: Set<string>): boolean {
  return tokenize(s).some((t) => wordKeys(t).some((k) => set.has(k)));
}

function isJunkTopic(name: string, syllabus: boolean, courseKey: string): boolean {
  const key = topicKey(name);
  if (!key || letterCount(name) < 2) return true;
  if (key === courseKey || JUNK_TOPICS.has(key) || LOCATOR_ONLY.test(key)) return true;
  if (/%/.test(name) || /\?\s*$/.test(name)) return true;
  if (wordCount(name) > 10 || name.length > 80) return true;
  if (hasWord(name, ALWAYS_ADMIN)) return true;
  if (syllabus && hasWord(name, ADMIN_WORDS)) return true;
  return false;
}

/** "ממברנות – מבנה ותעבורה (פרק 3)" → name "ממברנות", detail "מבנה ותעבורה · פרק 3". */
function splitDetail(rest: string): { name: string; detail: string | null } {
  let name = collapse(rest);
  const details: string[] = [];
  const paren = /^(.*?\S)\s*\(([^)]*)\)\s*$/.exec(name);
  if (paren) {
    name = paren[1];
    if (paren[2].trim()) details.push(paren[2].trim());
  }
  const m = /^(.+?)(?:\s+[-–—]\s+|:\s+|;\s*)(.+)$/.exec(name);
  if (m && wordCount(m[1]) <= 8 && letterCount(m[1]) >= 2) {
    name = m[1];
    details.unshift(m[2]);
  } else if (wordCount(name) > 10) {
    const first = name.split(/,\s*/)[0];
    if (first !== name && wordCount(first) <= 10) {
      details.unshift(name.slice(first.length).replace(/^,\s*/, ''));
      name = first;
    }
  }
  return { name, detail: details.length ? details.join(' · ') : null };
}

function mockTopics(input: TopicsInput): TopicSuggestion[] {
  const courseKey = topicKey(input.course ?? '');
  const existing = new Set((input.existingTopics ?? []).map(topicKey));
  const out: TopicSuggestion[] = [];
  const byKey = new Map<string, TopicSuggestion>();

  /** Returns the name children should use as their parent, or null if skipped. */
  const add = (raw: string, quote: string, chunk: ChunkRef, order: number | null, parent: string | null, description: string | null): string | null => {
    const name = cleanTopicName(raw);
    if (isJunkTopic(name, chunk.sourceKind === 'syllabus', courseKey)) return null;
    const key = topicKey(name);
    if (existing.has(key)) return name;
    const ev: Evidence = { chunkId: chunk.chunkId, quote };
    const prev = byKey.get(key);
    if (prev) {
      if (prev.syllabusOrder === null && order !== null) prev.syllabusOrder = order;
      if (!prev.parentName && parent && topicKey(parent) !== key) prev.parentName = parent;
      if (!prev.description && description) prev.description = description;
      if (prev.evidence.length < MAX_TOPIC_EVIDENCE) addEvidence(prev.evidence, ev);
      return prev.name;
    }
    const t: TopicSuggestion = {
      name,
      parentName: parent && topicKey(parent) !== key ? parent : null,
      description,
      syllabusOrder: order,
      evidence: [ev],
    };
    byKey.set(key, t);
    out.push(t);
    return name;
  };

  for (const chunk of input.chunks ?? []) {
    const syllabus = chunk.sourceKind === 'syllabus';
    if (chunk.heading?.trim()) {
      const w = WEEK_LINE.exec(collapse(chunk.heading));
      add(chunk.heading, chunk.heading.trim(), chunk, w && syllabus ? Number(w[1]) : null, null, null);
    }
    let parent: string | null = null;
    let admin = false;
    for (const line of linesOf(chunk.text)) {
      const week = WEEK_LINE.exec(line.text);
      if (week) {
        const { name, detail } = splitDetail(week[2]);
        parent = add(name, line.raw, chunk, syllabus ? Number(week[1]) : null, null, detail);
        admin = parent === null;
        continue;
      }
      if (!syllabus) continue;
      if (line.num !== null || line.bullet) {
        if (admin) continue;
        const { name, detail } = splitDetail(line.text);
        if (parent) add(name, line.raw, chunk, null, parent, detail);
        else if (line.num !== null) add(name, line.raw, chunk, line.num, null, detail);
        continue;
      }
      admin = hasWord(line.text, ADMIN_WORDS);
    }
  }
  return out;
}

// ---------- definitions, lists, aspects ----------

/** "X: ..." lines whose X is a label, not a term. */
const LABELS = new Set(
  [
    'הערה', 'הערות', 'הערות מרצה', 'שים לב', 'שימו לב', 'חשוב', 'דוגמה', 'דוגמא', 'דוגמאות', 'למשל', 'סיכום',
    'מסקנה', 'מסקנות', 'תוצאה', 'תוצאות', 'שאלה', 'תשובה', 'מטרה', 'מטרות', 'הגדרה', 'רקע', 'מקור', 'הסבר', 'נושא',
    'נושאים', 'שיטה', 'שיטות', 'השערה', 'ניסוי', 'בקרה', 'בקרות', 'יתרונות', 'חסרונות', 'יתרון', 'חיסרון',
    'מאפיינים', 'סוגים', 'שלבים', 'תכונות', 'רכיבים', 'סיבות', 'קריאה', 'תאריך', 'מרצה', 'מתרגל', 'ציון',
    'דרישות', 'example', 'examples', 'note', 'notes', 'summary', 'definition', 'question', 'answer', 'result',
    'results', 'conclusion', 'conclusions', 'method', 'methods', 'aim', 'goal', 'background', 'hypothesis',
    'advantages', 'disadvantages', 'source', 'reading', 'topics', 'date', 'time', 'location', 'lecturer',
    'instructor', 'grade', 'requirements', 'key point', 'key points', 'remember', 'important', 'e.g',
  ].map(normalizeText),
);

type AspectField = 'role' | 'mechanism' | 'limits';
const ASPECTS: Record<string, AspectField> = Object.fromEntries(
  (
    [
      ['תפקיד', 'role'], ['תפקידים', 'role'], ['תפקידו', 'role'], ['תפקידה', 'role'], ['role', 'role'],
      ['function', 'role'], ['functions', 'role'], ['מנגנון', 'mechanism'], ['מנגנון פעולה', 'mechanism'],
      ['mechanism', 'mechanism'], ['mechanism of action', 'mechanism'], ['מגבלות', 'limits'], ['מגבלה', 'limits'],
      ['limitations', 'limits'], ['limitation', 'limits'],
    ] as [string, AspectField][]
  ).map(([k, v]) => [normalizeText(k), v]),
);

/** Words that never appear inside a term (verbs, conjunctions, pronouns). */
const TERM_REJECT = new Set([
  'כי', 'אם', 'כאשר', 'אשר', 'לכן', 'אולם', 'אך', 'אבל', 'כלומר', 'למשל', 'גם', 'רק', 'לא', 'כך', 'זה', 'זו', 'זאת',
  'מה', 'מי', 'איך', 'למה', 'כיצד', 'יש', 'אין', 'היה', 'היתה', 'הייתה', 'היו', 'אנו', 'אנחנו', 'אני', 'אתה', 'את',
  'הוא', 'היא', 'הם', 'הן', 'that', 'which', 'when', 'if', 'because', 'but', 'so', 'this', 'these', 'those', 'it',
  'there', 'what', 'how', 'why', 'not', 'we', 'you', 'they', 'he', 'she', 'i', 'is', 'are', 'was', 'were', 'can',
  'will', 'should', 'must', 'do', 'does', 'did', 'has', 'have', 'had', 'here', 'where',
]);

/** Heads that make "X הוא Y" a statement about something else, not a definition. */
const GENERIC_HEAD = new Set([
  'תפקיד', 'תפקידו', 'תפקידה', 'תפקידם', 'תפקידן', 'מטרה', 'המטרה', 'מטרתו', 'מטרתה', 'הסיבה', 'סיבה', 'התוצאה',
  'תוצאה', 'הרעיון', 'העיקרון', 'ההבדל', 'הבעיה', 'הפתרון', 'השאלה', 'התשובה', 'הדבר', 'הנקודה', 'החשוב', 'העיקר',
  'הדוגמה', 'הדוגמא', 'התהליך', 'השלב', 'המנגנון', 'הגורם', 'החומר', 'המולקולה', 'result', 'reason', 'goal',
  'idea', 'difference', 'problem', 'answer', 'point', 'main', 'one', 'another', 'example', 'role', 'function',
  'process', 'step', 'stage', 'mechanism', 'factor', 'molecule', 'substance', 'key', 'first', 'second', 'next',
]);

const DEF_REJECT_FIRST = new Set(['ולא', 'או', 'and', 'or', 'but', 'אבל', 'אך', 'כלומר', 'e', 'see', 'ראו', 'ראה']);

/** Words that start a predicate, not a definition: "X are found in…", "X are important…". */
const EN_PREDICATE_BLOCK = new Set([
  'not', 'also', 'very', 'more', 'less', 'found', 'known', 'made', 'used', 'able', 'present', 'often', 'usually',
  'always', 'never', 'mostly', 'mainly', 'only', 'still', 'now', 'then', 'being', 'in', 'on', 'at', 'by', 'for',
  'to', 'from', 'with', 'of', 'too', 'so', 'thought', 'believed', 'required', 'needed',
]);

const DASH_DEF = /^(.{1,60}?)(?:\s+-\s+|\s+[–—]\s*|[–—]\s+)(.+)$/u;
const COLON_DEF = /^([^:]{1,60}?)\s*:\s+(.+)$/u;
const HE_CALLED = /^(.{6,}?)\s+(נקרא|נקראת|נקראים|נקראות|מכונה|מכונים|מכונות)\s+(.{2,60})$/u;
const HE_DEFINED = /^(.{2,50}?)\s+(מוגדר|מוגדרת|מוגדרים|מוגדרות)\s+כ[־-]?\s*(.+)$/u;
const HE_COPULA = /^(.{2,50}?)\s+(הוא|היא|הם|הן|הינו|הינה|הינם|הינן|זהו|זוהי)\s+(.+)$/u;
const EN_CALLED = /^(.{6,}?)\s+(is|are)\s+(?:called|known as|termed|referred to as)\s+(.{2,60})$/iu;
const EN_DEF = /^(.{2,60}?)\s+(is defined as|are defined as|refers to|refer to|is|are)\s+(.+)$/iu;
const ARROW_ANY = /(?:[-–—]+>|=+>|→|⇒|⟶|➔|➜|⟹|←|<[-–—]+|⇐|⟵)/u;
const WEEK_TERM = /^(?:שבוע|שיעור|הרצאה|מפגש|week|lecture|class|session|unit|chapter|פרק)\s*\d/iu;

interface Def {
  /** Display form, used as unit title and bare-term prompt. */
  term: string;
  /** The term as written in the sentence (what a cloze hides). */
  rawTerm: string;
  /** How the term reads inside an English question: "a kinase". */
  ask: string;
  def: string;
  copula: string | null;
  sent: Sent;
  /** The defining sentence as shown on a card — without a leading "הערה:"-style label. */
  text: string;
  key: string;
}

type Finding =
  | { type: 'def'; d: Def }
  | { type: 'list'; term: string; items: string[]; sent: Sent }
  | { type: 'aspect'; subject: string; field: AspectField; value: string; sent: Sent };

function termKey(s: string): string {
  return stripEdgePunct(normalizeText(s)).replace(/^(?:the|a|an)\s+/, '');
}

/** Hebrew terms may carry the definite article: "התא" and "תא" are one term. */
function keyVariants(k: string): string[] {
  return [k, k.startsWith('ה') && k.length > 3 ? k.slice(1) : '', `ה${k}`].filter(Boolean);
}

function cleanTerm(raw: string): { term: string; article: string | null } {
  let term = trimPunct(raw.replace(BULLET, ''));
  let article: string | null = null;
  const m = /^(the|a|an)\s+(.+)$/i.exec(term);
  if (m) {
    article = m[1].toLowerCase();
    term = m[2];
  }
  return { term, article };
}

function goodTerm(term: string, maxWords: number, allowParens: boolean): boolean {
  if (letterCount(term) < 2 || term.length > 60 || wordCount(term) > maxWords) return false;
  if (/[?!→%,;:]/.test(term) || (!allowParens && /[()]/.test(term))) return false;
  if (WEEK_TERM.test(term)) return false;
  const toks = tokenize(term);
  if (toks.length === 0 || toks.some((t) => TERM_REJECT.has(t))) return false;
  const norm = normalizeText(term);
  if (GENERIC_HEAD.has(toks[0]) || GENERIC_HEAD.has(norm) || LABELS.has(norm)) return false;
  return true;
}

function goodDef(def: string, minWords: number): boolean {
  if (letterCount(def) < 3) return false;
  const wc = wordCount(def);
  if (wc < minWords || wc > 60 || /\?\s*$/.test(def)) return false;
  const first = tokenize(def)[0];
  return !!first && !DEF_REJECT_FIRST.has(first);
}

function listItems(value: string): string[] | null {
  const parts = value
    .split(/\s*[,;]\s*/)
    .map((p) => trimPunct(p.replace(/^(?:and|or)\s+/i, '')))
    .filter(Boolean);
  if (parts.length < 3 || !parts.every((p) => wordCount(p) <= 4)) return null;
  return parts;
}

function englishPredicateOk(copula: string, def: string): boolean {
  const w = def.split(/\s+/).map((x) => x.toLowerCase());
  if (copula === 'is') return /^(a|an|the|one|any|each)$/.test(w[0] ?? '');
  if (copula === 'are') {
    const first = w[0] ?? '';
    if (EN_PREDICATE_BLOCK.has(first) || /(ed|ly)$/.test(first)) return false;
    if (/(ble|ive|al|ous|ic|ent|ant|ful|less)$/.test(first)) return /s$/.test(w[1] ?? '') && !EN_PREDICATE_BLOCK.has(w[1] ?? '');
  }
  return true;
}

function makeDef(term: string, article: string | null, def: string, copula: string | null, s: Sent, text = s.text): Def {
  const en = s.lang === 'en';
  let ask = en && wordCount(term) <= 3 ? inline(term) : term;
  if (article) ask = `${article} ${ask}`;
  return {
    term: en ? capitalize(term) : term,
    rawTerm: term,
    ask,
    def: en ? capitalize(def) : def,
    copula,
    sent: s,
    text,
    key: termKey(term),
  };
}

/** "X – def" / "X: def" at the start of a line. `rest` is what copula patterns should still look at. */
function separatorFinding(s: Sent, t: string): { finding: Finding | null; rest: string } {
  const dash = DASH_DEF.exec(t);
  const colon = COLON_DEF.exec(t);
  const m = dash && colon ? (dash[1].length <= colon[1].length ? dash : colon) : (dash ?? colon);
  if (!m) return { finding: null, rest: t };
  const { term, article } = cleanTerm(m[1]);
  const value = trimPunct(m[2]);
  const label = normalizeText(term);
  const aspect = ASPECTS[label];
  if (aspect) {
    const subject = s.chunk.heading ? cleanTopicName(s.chunk.heading) : '';
    if (subject && goodTerm(subject, 5, true) && goodDef(value, 1)) {
      return { finding: { type: 'aspect', subject, field: aspect, value, sent: s }, rest: t };
    }
    return { finding: null, rest: value };
  }
  if (LABELS.has(label)) return { finding: null, rest: value };
  if (!goodTerm(term, 6, true)) return { finding: null, rest: t };
  const items = listItems(value);
  if (items) return { finding: { type: 'list', term, items, sent: s }, rest: t };
  if (!goodDef(value, 1) || normalizeText(value) === label) return { finding: null, rest: t };
  return { finding: { type: 'def', d: makeDef(term, article, value, null, s) }, rest: t };
}

function copulaFinding(s: Sent, t: string, display: string): Finding | null {
  const build = (termRaw: string, value: string, copula: string | null, maxWords: number): Finding | null => {
    const { term, article } = cleanTerm(termRaw);
    const v = trimPunct(value);
    if (!goodTerm(term, maxWords, false) || !goodDef(v, 2)) return null;
    if (normalizeText(term) === normalizeText(v)) return null;
    return { type: 'def', d: makeDef(term, article, v, copula, s, display) };
  };
  if (langOf(t) === 'he') {
    let m = HE_CALLED.exec(t);
    // "נקרא" agrees with the defining phrase, not the term, so gender comes from the term.
    if (m) return build(m[3], m[1], null, 4);
    m = HE_DEFINED.exec(t);
    if (m) return build(m[1], m[3], m[2], 4);
    m = HE_COPULA.exec(t);
    if (m) return build(m[1], m[3], m[2], 4);
    return null;
  }
  let m = EN_CALLED.exec(t);
  if (m) return build(m[3], m[1], m[2].toLowerCase(), 4);
  m = EN_DEF.exec(t);
  if (m) {
    const copula = m[2].toLowerCase();
    if (!englishPredicateOk(copula, m[3])) return null;
    return build(m[1], m[3], copula, 5);
  }
  return null;
}

function analyze(s: Sent): Finding | null {
  let t = s.text.replace(/[\s.;!]+$/, '');
  let display = s.text;
  if (ARROW_ANY.test(t)) return null;
  if (s.first) {
    const sep = separatorFinding(s, t);
    if (sep.finding) return sep.finding;
    if (sep.rest !== t) display = sep.rest;
    t = sep.rest;
  }
  return copulaFinding(s, t, display);
}

/** A sentence as shown in an explanation: no leading "הערה:"-style label. */
function displayOf(s: Sent): string {
  const m = /^([^:]{1,30}):\s+(.+)$/u.exec(s.text);
  return m && LABELS.has(normalizeText(m[1])) ? m[2] : s.text;
}

// ---------- pathways ----------

const FWD = /\s*(?:[-–—]+>|=+>|→|⇒|⟶|➔|➜|⟹)\s*/u;
const BWD = /\s*(?:←|<[-–—]+|⇐|⟵)\s*/u;

interface Pathway {
  label: string | null;
  steps: string[];
  sent: Sent;
}

function findPathway(s: Sent): Pathway | null {
  const t = s.text.replace(/[\s.;]+$/, '');
  const fwd = t.split(FWD);
  const bwd = t.split(BWD);
  let steps: string[];
  if (fwd.length >= 3 && bwd.length === 1) steps = fwd;
  // In Hebrew text "←" points along the reading direction; in English it points back.
  else if (bwd.length >= 3 && fwd.length === 1) steps = s.lang === 'he' ? bwd : bwd.reverse();
  else return null;
  let label: string | null = null;
  const lead = /^(.{2,50}?):\s*(.+)$/u.exec(steps[0]);
  if (lead) {
    label = trimPunct(lead[1]);
    steps[0] = lead[2];
  }
  steps = steps.map((x) => trimPunct(x.replace(BULLET, '')));
  if (steps.some((x) => !x || letterCount(x) < 1 || wordCount(x) > 8)) return null;
  if (label && (letterCount(label) < 2 || wordCount(label) > 6)) label = null;
  return { label, steps, sent: s };
}

/** Steps mapped in order onto source → signal → target → outcome; extra middle steps are merged. */
function pathwayFields(steps: string[]): Record<string, string> {
  const n = steps.length;
  if (n === 3) return { source: steps[0], signal: steps[1], target: '', outcome: steps[2] };
  if (n === 4) return { source: steps[0], signal: steps[1], target: steps[2], outcome: steps[3] };
  const mid = steps.slice(1, -1);
  const half = Math.ceil(mid.length / 2);
  return { source: steps[0], signal: mid.slice(0, half).join(' → '), target: mid.slice(half).join(' → '), outcome: steps[n - 1] };
}

// ---------- causal sentences ----------

interface Causal {
  cause: string;
  prompt: string;
  keyPoints: string[];
  sent: Sent;
}

const HE_CAUSE_VERBS: Record<string, string> = {
  גורם: 'גורם', גורמת: 'גורם', גורמים: 'גורם', גורמות: 'גורם',
  מוביל: 'מוביל', מובילה: 'מוביל', מובילים: 'מוביל', מובילות: 'מוביל',
};
const HE_DIRECTION_VERBS = new Set([
  'מעכב', 'מעכבת', 'מעכבים', 'מעכבות', 'מפעיל', 'מפעילה', 'מפעילים', 'מפעילות', 'משפעל', 'משפעלת', 'משפעלים',
  'משפעלות', 'מגביר', 'מגבירה', 'מגבירים', 'מגבירות', 'מפחית', 'מפחיתה', 'מפחיתים', 'מפחיתות', 'מעודד', 'מעודדת',
  'מעודדים', 'מעודדות', 'מדכא', 'מדכאת', 'מדכאים', 'מדכאות',
]);
const HE_PASSIVE_DIRECTION = new Set([
  'מעוכב', 'מעוכבת', 'מעוכבים', 'מעוכבות', 'מופעל', 'מופעלת', 'מופעלים', 'מופעלות', 'משופעל', 'משופעלת', 'משופעלים',
  'משופעלות', 'מוגבר', 'מוגברת', 'מוגברים', 'מוגברות', 'מופחת', 'מופחתת', 'מופחתים', 'מופחתות', 'מדוכא', 'מדוכאת',
  'מדוכאים', 'מדוכאות',
]);
const HE_PASSIVE_CAUSE = new Set(['נגרם', 'נגרמת', 'נגרמים', 'נגרמות']);
const HE_BY = /^(?:על[\s־-]ידי|ע"י|ע״י)\s+/u;
const HE_TRAILING_PASSIVE = /\s+(?:נגרם|נגרמת|נגרמים|נגרמות|נוצר|נוצרת|נוצרים|נוצרות|מתרחש|מתרחשת|מתרחשים|מתרחשות)$/u;
const HE_LEAD = /^(?:בנוסף|לכן|כמו כן|אולם|אך|עם זאת|כלומר|למשל|לדוגמה|לסיכום|בסופו של דבר)[,\s]+/u;
const EN_LEAD = /^(?:in addition|therefore|thus|however|also|moreover|furthermore|consequently|hence|in turn)[,\s]+/i;
const PRONOUNS = new Set(['הוא', 'היא', 'הם', 'הן', 'זה', 'זו', 'זאת', 'כך', 'it', 'this', 'that', 'they', 'these', 'which']);

const EN_CAUSE_VERBS: Record<string, string> = {
  causes: 'causes', cause: 'causes', caused: 'causes', triggers: 'triggers', trigger: 'triggers',
  triggered: 'triggers', induces: 'induces', induce: 'induces', induced: 'induces',
};
const EN_PHRASAL: Record<string, [string, string]> = {
  leads: ['to', 'leads to'], lead: ['to', 'leads to'], led: ['to', 'leads to'],
  results: ['in', 'results in'], result: ['in', 'results in'], resulted: ['in', 'results in'],
};
const EN_DIRECTION_VERBS = new Set([
  'inhibits', 'inhibit', 'inhibited', 'activates', 'activate', 'activated', 'increases', 'increase', 'increased',
  'decreases', 'decrease', 'decreased', 'stimulates', 'stimulate', 'stimulated', 'blocks', 'block', 'blocked',
  'reduces', 'reduce', 'reduced', 'enhances', 'enhance', 'enhanced', 'suppresses', 'suppress', 'suppressed',
  'promotes', 'promote', 'promoted',
]);
const EN_BE = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being']);
const EN_NOUN_CONTEXT = new Set(['a', 'an', 'the', 'this', 'that', 'its', 'their', 'his', 'her', 'no', 'any', 'some', 'each', 'to', 'which', 'what']);

function resolveSubject(raw: string, s: Sent): string | null {
  const cause = trimPunct(raw);
  if (!cause || PRONOUNS.has(normalizeText(cause))) {
    // In a paragraph "it" means the previous sentence's subject; only a bullet line points at its heading.
    if (!s.solo) return null;
    const h = s.chunk.heading ? cleanTopicName(s.chunk.heading) : '';
    return h && goodTerm(h, 5, true) ? h : null;
  }
  if (wordCount(cause) > 8 || letterCount(cause) < 2) return null;
  return cause;
}

function cleanClause(raw: string, lang: Lang): string {
  const c = collapse(raw).replace(/,\s*$/, '');
  return trimPunct(lang === 'he' ? c.replace(HE_LEAD, '') : c.replace(EN_LEAD, ''));
}

function cleanEffect(raw: string): string {
  let e = trimPunct(raw);
  if (wordCount(e) > 14) e = trimPunct(e.split(/\s*,\s*/)[0]);
  return e;
}

function causal(s: Sent, cause: string, effectLabel: string, prompt: string): Causal {
  const keyPoints = s.lang === 'he' ? [`סיבה: ${cause}`, `תוצאה: ${effectLabel}`] : [`Cause: ${cause}`, `Effect: ${effectLabel}`];
  return { cause, prompt, keyPoints, sent: s };
}

function hebrewCausal(s: Sent): Causal | null {
  const t = s.text.replace(/[\s.;!]+$/, '');
  const w = t.split(' ');
  for (let i = 0; i < w.length - 1; i++) {
    const word = w[i];
    const before = w.slice(0, i).join(' ');
    const after = w.slice(i + 1).join(' ');

    // Passive: "Y מעוכב על ידי X", "Y נגרם על ידי X".
    if (i > 0 && (HE_PASSIVE_DIRECTION.has(word) || HE_PASSIVE_CAUSE.has(word)) && HE_BY.test(after)) {
      const by = after.replace(HE_BY, '');
      const cause = resolveSubject(by.split(',')[0], s);
      const effect = cleanEffect(cleanClause(before, 'he'));
      if (!cause || letterCount(effect) < 3 || wordCount(effect) > 10) continue;
      if (HE_PASSIVE_CAUSE.has(word)) return causal(s, cause, effect, `מה גורם ${pre('ל', effect)}?`);
      return causal(s, cause, `${effect} ${word}`, `מה ההשפעה של ${cause} על ${effect}?`);
    }

    if (HE_CAUSE_VERBS[word] && /^ל/.test(after)) {
      const cause = resolveSubject(cleanClause(before, 'he'), s);
      const effect = cleanEffect(after);
      if (!cause || letterCount(effect) < 3 || wordCount(effect) > 14) continue;
      return causal(s, cause, effect.replace(/^ל[־-]?/, ''), `מה ${HE_CAUSE_VERBS[word]} ${effect}?`);
    }

    if (HE_DIRECTION_VERBS.has(word)) {
      // At the start of a line the word may be a noun ("מעכב תחרותי") unless an object follows.
      if (i === 0 && !/^את\s/.test(after)) continue;
      const cause = resolveSubject(cleanClause(before, 'he'), s);
      const effect = cleanEffect(after.replace(/^את\s+/, ''));
      if (!cause || letterCount(effect) < 3 || wordCount(effect) > 14) continue;
      return causal(s, cause, `${word} ${/^את\s/.test(after) ? 'את ' : ''}${effect}`, `מה ההשפעה של ${cause} על ${effect}?`);
    }

    const result = word === 'כתוצאה' && /^מ/.test(w[i + 1] ?? '');
    if (result || word === 'בעקבות') {
      let rest = w.slice(i + 1).join(' ');
      if (result) rest = rest.replace(/^מ[־-]?/, '');
      const comma = rest.indexOf(',');
      const leading = !cleanClause(before, 'he');
      if (leading && comma < 0) continue;
      const cause = trimPunct(comma >= 0 ? rest.slice(0, comma) : rest);
      const effect = cleanEffect(cleanClause(leading ? rest.slice(comma + 1) : before, 'he').replace(HE_TRAILING_PASSIVE, ''));
      if (!cause || PRONOUNS.has(normalizeText(cause)) || wordCount(cause) > 8 || letterCount(effect) < 3) continue;
      const marker = result ? (/^[א-ת]/.test(cause) ? 'כתוצאה מ' : 'כתוצאה מ־') : 'בעקבות ';
      return causal(s, cause, effect, `מה קורה ${marker}${cause}?`);
    }
  }
  return null;
}

function englishCausal(s: Sent): Causal | null {
  const t = s.text.replace(/[\s.;!]+$/, '');
  const w = t.split(' ');
  const lw = w.map((x) => x.toLowerCase().replace(/[,;:]$/, ''));
  for (let i = 0; i < w.length - 1; i++) {
    const prev = i > 0 ? lw[i - 1] : '';

    // Passive: "Y is inhibited by X".
    if (i > 0 && EN_BE.has(lw[i]) && lw[i + 2] === 'by' && (EN_CAUSE_VERBS[lw[i + 1]] || EN_DIRECTION_VERBS.has(lw[i + 1]))) {
      const effect = cleanClause(w.slice(0, i).join(' '), 'en');
      const cause = resolveSubject(w.slice(i + 3).join(' '), s);
      if (!cause || letterCount(effect) < 3 || wordCount(effect) > 10) continue;
      const verb = lw[i + 1];
      if (EN_CAUSE_VERBS[verb]) return causal(s, cause, effect, `What ${EN_CAUSE_VERBS[verb]} ${inline(effect)}?`);
      return causal(s, cause, `${verb} ${effect}`, `What is the effect of ${inline(cause)} on ${inline(effect)}?`);
    }

    if (EN_NOUN_CONTEXT.has(prev) || EN_BE.has(prev)) continue;
    const before = cleanClause(w.slice(0, i).join(' '), 'en').replace(/\s+(?:can|may|might|will|could|would|does|do)$/i, '');

    if (EN_CAUSE_VERBS[lw[i]]) {
      const cause = resolveSubject(before, s);
      const effect = cleanEffect(w.slice(i + 1).join(' '));
      if (!cause || letterCount(effect) < 3) continue;
      return causal(s, cause, effect, `What ${EN_CAUSE_VERBS[lw[i]]} ${inline(effect)}?`);
    }
    const phrasal = EN_PHRASAL[lw[i]];
    if (phrasal && lw[i + 1] === phrasal[0]) {
      const cause = resolveSubject(before, s);
      const effect = cleanEffect(w.slice(i + 2).join(' '));
      if (!cause || letterCount(effect) < 3) continue;
      return causal(s, cause, effect, `What ${phrasal[1]} ${inline(effect)}?`);
    }
    if (EN_DIRECTION_VERBS.has(lw[i])) {
      const cause = resolveSubject(before, s);
      const effect = cleanEffect(w.slice(i + 1).join(' '));
      if (!cause || letterCount(effect) < 3 || wordCount(effect) > 14) continue;
      return causal(s, cause, `${lw[i]} ${effect}`, `What is the effect of ${inline(cause)} on ${inline(effect)}?`);
    }
  }
  return null;
}

function findCausal(s: Sent): Causal | null {
  return s.lang === 'he' ? hebrewCausal(s) : englishCausal(s);
}

// ---------- conflicts ----------

const INCREASE =
  /(?:^|[^\p{L}])[ושהכ]{0,2}(?:מעלה|מעלים|מגביר|מגבירה|מגבירים|מגבירות|מאיץ|מאיצה|מעודד|מעודדת|עלייה|עליה|הגברה|increases?|raises?|elevates?|enhances?|stimulates?|promotes?)(?!\p{L})/u;
const DECREASE =
  /(?:^|[^\p{L}])[ושהכ]{0,2}(?:מוריד|מורידה|מורידים|מורידות|מפחית|מפחיתה|מפחיתים|מפחיתות|מעכב|מעכבת|מעכבים|מעכבות|מאט|מאטה|ירידה|הפחתה|decreases?|lowers?|reduces?|inhibits?|suppresses?|blocks?)(?!\p{L})/u;

/** +1 when a sentence says something rises, -1 when it falls, 0 otherwise. */
export function polarity(s: string): number {
  const n = normalizeText(s);
  return (INCREASE.test(n) ? 1 : 0) - (DECREASE.test(n) ? 1 : 0);
}

function tier(d: Def): number {
  return SOURCE_TIER[d.sent.chunk.sourceKind] ?? 1;
}

function describeSource(c: ChunkRef): string {
  return `${SOURCE_KIND_LABELS[c.sourceKind] ?? 'מקור'} "${c.sourceTitle}" (${c.locatorLabel})`;
}

function conflictFor(primary: Def, other: Def, opposite: boolean): ConflictSuggestion {
  const a = describeSource(primary.sent.chunk);
  const b = describeSource(other.sent.chunk);
  const what = opposite ? 'מתארים כיוון השפעה הפוך' : 'מגדירים אותו בצורה שונה';
  const decision =
    tier(primary) > tier(other)
      ? ` היחידה הוצעה לפי ${a}, שהוא מקור סמכותי יותר — עדיין יש לבדוק לפני אישור.`
      : ' אין להציג אף אחת מההגדרות כעובדה מאומתת עד שהסתירה תוכרע.';
  return {
    description: `סתירה אפשרית במונח "${primary.term}": ${a} ו${b} ${what}.${decision}`,
    evidence: [evOf(primary.sent), evOf(other.sent)],
  };
}

// ---------- question builders ----------

const CONTRAST = /(?:^|[\s,(])(?:לעומת|ואילו|לעומתו|לעומתה|לעומתם|בניגוד\s+ל|whereas|unlike|in contrast|by contrast)/iu;

function question(
  kind: QuestionKind,
  prompt: string,
  answer: string,
  evidence: Evidence[],
  extra: Partial<Pick<QuestionSuggestion, 'explanation' | 'hint' | 'keyPoints' | 'structure'>> = {},
): QuestionSuggestion {
  return {
    kind,
    prompt,
    answer,
    explanation: extra.explanation ?? null,
    hint: extra.hint ?? null,
    keyPoints: extra.keyPoints ?? [],
    structure: extra.structure ?? null,
    evidence,
  };
}

/** Grammatical "what is" for a Hebrew term: from the copula when known, else from the head noun. */
function heWhat(term: string, copula: string | null): string {
  const byCopula: Record<string, string> = {
    הוא: 'מהו', הינו: 'מהו', זהו: 'מהו', מוגדר: 'מהו', נקרא: 'מהו',
    היא: 'מהי', הינה: 'מהי', זוהי: 'מהי', מוגדרת: 'מהי', נקראת: 'מהי',
    הם: 'מהם', הינם: 'מהם', מוגדרים: 'מהם', נקראים: 'מהם', מכונים: 'מהם',
    הן: 'מהן', הינן: 'מהן', מוגדרות: 'מהן', נקראות: 'מהן', מכונות: 'מהן',
  };
  if (copula && byCopula[copula]) return byCopula[copula];
  const head = term.split(/\s+/)[0] ?? '';
  if (!/[א-ת]$/.test(head)) return 'מהו';
  if (head.endsWith('ים')) return 'מהם';
  if (head.endsWith('ות')) return 'מהן';
  if (/[הת]$/.test(head)) return 'מהי';
  return 'מהו';
}

function definitionPrompt(d: Def, style: StyleProfile): string {
  if (style.bareTerms) return d.term;
  if (d.sent.lang === 'he') return `${heWhat(d.term, d.copula)} ${d.term}?`;
  const plural = d.copula === 'are' || d.copula === 'are defined as' || d.copula === 'refer to';
  return `What ${plural ? 'are' : 'is'} ${d.ask}?`;
}

/** Sentences that only make sense after the previous one ("כתוצאה מכך, …", "It …"). */
const ANAPHORIC = /^(?:כתוצאה מכך|לכן|כך|זה|זו|זאת|הוא|היא|הם|הן|בנוסף|עם זאת|אולם|אך|it|this|these|that|they|therefore|thus|as a result|however|in addition)(?=[\s,]|$)/iu;

/** Other self-contained sentences in the chunk that mention every content word of `subject`. */
function contextSentences(subject: string, exclude: Sent[], pool: Sent[], max = 2): Sent[] {
  const words = contentWords(subject);
  if (words.length === 0) return [];
  return pool
    .filter((s) => !exclude.includes(s) && s.text.length > 10 && !/\?\s*$/.test(s.text) && !ANAPHORIC.test(displayOf(s)))
    .filter((s) => {
      const keys = keySet(s.text);
      return words.every((w) => wordKeys(w).some((k) => keys.has(k)));
    })
    .slice(0, max);
}

function withContext(subject: string, used: Sent[], pool: Sent[], style: StyleProfile, evidence: Evidence[]): string | null {
  if (!style.longAnswers) return null;
  const ctx = contextSentences(subject, used, pool);
  if (ctx.length === 0) return null;
  addEvidence(evidence, ...ctx.map(evOf));
  return ctx.map((s) => displayOf(s).replace(/([^.!?])$/, '$1.')).join(' ');
}

const METHOD_GENUS = new Set(['שיטה', 'טכניקה', 'בדיקה', 'method', 'technique', 'assay', 'procedure']);

/** A definition whose genus is "שיטה"/"method" gets the method template, so the approver fills the rest. */
function methodStructure(def: string): AnswerStructure | null {
  const genus = contentWords(def)[0];
  if (!genus || !wordKeys(genus).some((k) => METHOD_GENUS.has(k))) return null;
  return { template: 'method', fields: { measures: def, supports: '', notProves: '', controls: '' } };
}

/** Words of the definition up to and including its first content word: "הורמון…". */
function genusHint(def: string): string | null {
  if (wordCount(def) < 4) return null;
  const words = collapse(def).split(' ');
  const out: string[] = [];
  for (const w of words) {
    out.push(w);
    if (contentWords(w).length > 0 || out.length >= 3) break;
  }
  return `${out.join(' ')}…`;
}

function firstLetterHint(answer: string, lang: Lang): string | null {
  const ch = answer.trim()[0];
  if (!ch) return null;
  return lang === 'he' ? `מתחיל ב־"${ch}"` : `Starts with "${ch}"`;
}

function keyPointsFromDefinition(def: string): string[] {
  const parts = def.split(/\s*[,;]\s*/).map(trimPunct).filter((p) => wordCount(p) >= 2);
  return parts.length >= 2 ? parts : [];
}

/** Wraps every standalone occurrence of `term` (Hebrew prefixes allowed) in [[...]]. */
function wrapTerm(text: string, term: string): string | null {
  if (!term.trim()) return null;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])([ובכלמשה]{0,2})(${escapeRe(term)})(?![\\p{L}\\p{N}])`, 'giu');
  let n = 0;
  const out = text.replace(re, (_m, pre: string, prefix: string, word: string) => {
    n++;
    return `${pre}${prefix}[[${word}]]`;
  });
  return n ? out : null;
}

// ---------- units ----------

interface Draft {
  key: string;
  title: string;
  topicName: string;
  content: string[];
  evidence: Evidence[];
  questions: QuestionSuggestion[];
  order: number;
}

function topicFor(c: ChunkRef, hint: string | null, existing: Map<string, string>, courseKey: string): string {
  const heading = c.heading ? cleanTopicName(c.heading) : '';
  for (const cand of [heading, hint ?? '']) {
    const e = cand ? existing.get(topicKey(cand)) : undefined;
    if (e) return e;
  }
  if (hint?.trim()) return hint.trim();
  if (heading && !isJunkTopic(heading, false, courseKey)) return heading;
  return c.sourceTitle || '';
}

function mockUnits(input: UnitsInput): UnitsOutput {
  const style = analyzeStyle(input.style ?? []);
  const courseKey = topicKey(input.course ?? '');
  const existing = new Map<string, string>();
  for (const n of input.existingTopics ?? []) existing.set(topicKey(n), n);

  const seq = { n: 0 };
  const pools = new Map<number, Sent[]>();
  const sentences: Sent[] = [];
  for (const c of input.chunks ?? []) {
    // A syllabus maps topics; it is not a source of answers.
    if (c.sourceKind === 'syllabus' || typeof c.text !== 'string' || !c.text.trim()) continue;
    const ss = sentencesOf(c, seq);
    pools.set(c.chunkId, ss);
    sentences.push(...ss);
  }
  const poolOf = (s: Sent) => pools.get(s.chunk.chunkId) ?? [];
  const topicCache = new Map<number, string>();
  const topicOf = (c: ChunkRef): string => {
    let t = topicCache.get(c.chunkId);
    if (t === undefined) {
      t = topicFor(c, input.topicHint ?? null, existing, courseKey);
      topicCache.set(c.chunkId, t);
    }
    return t;
  };

  const defs: Def[] = [];
  const lists: Extract<Finding, { type: 'list' }>[] = [];
  const aspects: Extract<Finding, { type: 'aspect' }>[] = [];
  const pathways: Pathway[] = [];
  const causals: Causal[] = [];
  for (const s of sentences) {
    if (/\?\s*$/.test(s.text)) continue;
    const p = findPathway(s);
    if (p) {
      pathways.push(p);
      continue;
    }
    const f = analyze(s);
    if (f?.type === 'def') defs.push(f.d);
    else if (f?.type === 'list') lists.push(f);
    else if (f?.type === 'aspect') aspects.push(f);
    if (f?.type !== 'list' && f?.type !== 'aspect') {
      const c = findCausal(s);
      if (c) causals.push(c);
    }
  }

  const units = new Map<string, Draft>();
  const conflicts: ConflictSuggestion[] = [];
  const findUnit = (term: string): Draft | undefined => {
    for (const k of keyVariants(termKey(term))) {
      const u = units.get(k);
      if (u) return u;
    }
    return undefined;
  };
  const newUnit = (key: string, title: string, s: Sent): Draft => {
    const d: Draft = { key, title, topicName: topicOf(s.chunk), content: [], evidence: [], questions: [], order: s.seq };
    units.set(key, d);
    return d;
  };
  const addContent = (u: Draft, s: Sent) => {
    if (!u.content.includes(s.text)) u.content.push(s.text);
    addEvidence(u.evidence, evOf(s));
  };

  // Definitions: one unit per term. The most authoritative source wins; agreeing
  // sources add evidence; disagreeing ones become conflicts.
  const groups = new Map<string, Def[]>();
  for (const d of defs) {
    const key = keyVariants(d.key).find((k) => groups.has(k)) ?? d.key;
    const g = groups.get(key) ?? [];
    g.push(d);
    groups.set(key, g);
  }
  const primaries: Def[] = [];
  const unitOfDef = new Map<Def, Draft>();
  for (const [key, group] of groups) {
    const primary = group.reduce((best, d) => (tier(d) > tier(best) ? d : best), group[0]);
    const support: Def[] = [];
    const seenSources = new Set<number>([primary.sent.chunk.sourceId]);
    for (const d of group) {
      if (d === primary || seenSources.has(d.sent.chunk.sourceId)) continue;
      seenSources.add(d.sent.chunk.sourceId);
      const opposite = polarity(primary.def) * polarity(d.def) < 0;
      if (opposite || similarity(primary.def, d.def) < CONFLICT_SIMILARITY) conflicts.push(conflictFor(primary, d, opposite));
      else support.push(d);
    }
    const u = newUnit(key, primary.term, primary.sent);
    u.content.push(primary.text);
    addEvidence(u.evidence, evOf(primary.sent), ...support.map((d) => evOf(d.sent)));

    const evidence = [evOf(primary.sent), ...support.map((d) => evOf(d.sent))];
    const explanation = withContext(primary.rawTerm, [primary.sent], poolOf(primary.sent), style, evidence);
    u.questions.push(
      question('definition', definitionPrompt(primary, style), primary.def, evidence, {
        explanation,
        hint: genusHint(primary.def),
        keyPoints: keyPointsFromDefinition(primary.def),
        structure: methodStructure(primary.def),
      }),
    );
    const cloze = wrapTerm(primary.text, primary.rawTerm);
    if (cloze) {
      u.questions.push(question('cloze', cloze, primary.rawTerm, [evOf(primary.sent)], { hint: firstLetterHint(primary.rawTerm, primary.sent.lang) }));
    }
    primaries.push(primary);
    unitOfDef.set(primary, u);
  }

  // Comparisons: two terms defined in the same chunk that share a word, a genus, or a contrast.
  const compared = new Set<Def>();
  const byChunk = new Map<number, Def[]>();
  for (const d of primaries) byChunk.set(d.sent.chunk.chunkId, [...(byChunk.get(d.sent.chunk.chunkId) ?? []), d]);
  for (const list of byChunk.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (compared.has(a) || compared.has(b) || !comparable(a, b)) continue;
        compared.add(a);
        compared.add(b);
        const he = a.sent.lang === 'he';
        const pa = `${a.term} – ${he ? a.def : inline(a.def)}`;
        const pb = `${b.term} – ${he ? b.def : inline(b.def)}`;
        unitOfDef.get(a)?.questions.push(
          question(
            'comparison',
            he ? `מה ההבדל בין ${a.term} ${pre('ל', b.term)}?` : `What is the difference between ${a.ask} and ${b.ask}?`,
            `${pa}\n${pb}`,
            [evOf(a.sent), evOf(b.sent)],
            { keyPoints: [pa, pb] },
          ),
        );
      }
    }
  }

  // Aspect lines under a heading: "תפקיד: ..." → "מה התפקיד של <heading>?".
  for (const a of aspects) {
    const u = findUnit(a.subject) ?? newUnit(termKey(a.subject), a.subject, a.sent);
    addContent(u, a.sent);
    const he = a.sent.lang === 'he';
    const prompts: Record<AspectField, string> = he
      ? { role: `מה התפקיד של ${a.subject}?`, mechanism: `מהו המנגנון של ${a.subject}?`, limits: `מהן המגבלות של ${a.subject}?` }
      : {
          role: `What is the role of ${inline(a.subject)}?`,
          mechanism: `What is the mechanism of ${inline(a.subject)}?`,
          limits: `What are the limitations of ${inline(a.subject)}?`,
        };
    const points = a.value.split(/\s*[,;]\s*/).map(trimPunct).filter(Boolean);
    u.questions.push(
      question('recall', prompts[a.field], a.value, [evOf(a.sent)], {
        keyPoints: points.length ? points : [a.value],
        structure: { template: 'general', fields: { [a.field]: a.value } },
      }),
    );
  }

  // Enumerations: "סוגי RNA: mRNA, tRNA, rRNA".
  for (const l of lists) {
    const u = findUnit(l.term) ?? newUnit(termKey(l.term), l.term, l.sent);
    addContent(u, l.sent);
    const he = l.sent.lang === 'he';
    u.questions.push(
      question('recall', he ? `מנה: ${l.term}` : `List: ${l.term}`, l.items.join(', '), [evOf(l.sent)], {
        keyPoints: l.items,
        hint: he ? `${l.items.length} פריטים` : `${l.items.length} items`,
      }),
    );
  }

  // Pathways: a recall card with the ordered structure, and a cloze on the second step.
  for (const p of pathways) {
    const key = `path:${normalizeText(p.steps.join(' > '))}`;
    const known = units.get(key);
    if (known) {
      addEvidence(known.evidence, evOf(p.sent));
      continue;
    }
    const he = p.sent.lang === 'he';
    const first = p.steps[0];
    const last = p.steps[p.steps.length - 1];
    const title = p.label ?? (he ? `מסלול: ${first} → ${last}` : `Pathway: ${first} → ${last}`);
    const u = newUnit(key, title, p.sent);
    addContent(u, p.sent);
    const chain = p.steps.join(' → ');
    const evidence = [evOf(p.sent)];
    const explanation = withContext(p.label ?? first, [p.sent], poolOf(p.sent), style, evidence);
    u.questions.push(
      question('recall', he ? `תאר את שלבי המסלול: ${first} → … → ${last}` : `Describe the pathway: ${first} → … → ${last}`, chain, evidence, {
        explanation,
        hint: he ? `${p.steps.length} שלבים` : `${p.steps.length} steps`,
        keyPoints: p.steps,
        structure: { template: 'pathway', fields: pathwayFields(p.steps) },
      }),
    );
    const hide = 1;
    const blanked = p.steps.map((x, i) => (i === hide ? `[[${x}]]` : x)).join(' → ');
    u.questions.push(
      question('cloze', he ? `השלם את המסלול: ${blanked}` : `Complete the pathway: ${blanked}`, p.steps[hide], [evOf(p.sent)], {
        hint: firstLetterHint(p.steps[hide], p.sent.lang),
      }),
    );
  }

  // Causal sentences join the unit of their cause, or start one.
  for (const c of causals) {
    const he = c.sent.lang === 'he';
    const u = findUnit(c.cause) ?? newUnit(termKey(c.cause), he ? `ההשפעה של ${c.cause}` : `Effects of ${inline(c.cause)}`, c.sent);
    if (u.questions.some((q) => q.prompt === c.prompt)) continue;
    addContent(u, c.sent);
    const evidence = [evOf(c.sent)];
    const explanation = withContext(c.cause, [c.sent], poolOf(c.sent), style, evidence);
    u.questions.push(question('causal', c.prompt, c.sent.text, evidence, { explanation, keyPoints: c.keyPoints }));
  }

  const out: UnitSuggestion[] = [...units.values()]
    .sort((a, b) => a.order - b.order)
    .slice(0, MAX_UNITS)
    .map((u) => {
      const seen = new Set<string>();
      const questions = u.questions.filter((q) => !seen.has(q.prompt) && !!seen.add(q.prompt)).slice(0, MAX_QUESTIONS_PER_UNIT);
      return { title: u.title, content: u.content.join('\n'), topicName: u.topicName, evidence: u.evidence, questions };
    });
  return { units: out, conflicts };
}

function comparable(a: Def, b: Def): boolean {
  const ka = termKey(a.term);
  const kb = termKey(b.term);
  if (ka.includes(kb) || kb.includes(ka)) return false;
  const bKeys = keySet(b.term);
  if (contentWords(a.term).some((w) => wordKeys(w).some((k) => bKeys.has(k)))) return true;
  const ga = contentWords(a.def)[0];
  const gb = contentWords(b.def)[0];
  if (ga && gb && wordKeys(ga).some((k) => wordKeys(gb).includes(k))) return true;
  return CONTRAST.test(a.sent.text) || CONTRAST.test(b.sent.text);
}

// ---------- provider ----------

export class MockProvider implements AIProvider {
  readonly id: string;
  readonly label: string;

  constructor() {
    this.id = 'mock';
    this.label = 'ספק דמה (ללא מודל)';
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'ספק הדמה פועל תמיד: הצעות היוריסטיות מתוך הטקסט עצמו, בלי מודל שפה ובלי רשת' };
  }

  async suggestTopics(input: TopicsInput): Promise<TopicSuggestion[]> {
    return mockTopics(input);
  }

  async suggestUnits(input: UnitsInput): Promise<UnitsOutput> {
    return mockUnits(input);
  }
}
