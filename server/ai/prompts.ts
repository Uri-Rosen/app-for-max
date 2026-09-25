// Prompts for the local-model provider, and the learner-style analysis that
// both providers use. The rules here restate the product spec's question-style
// and source-authority sections; the kinds and labels come from shared/ so the
// prompt never drifts from what the app can store.

import { FIELD_LABELS, KIND_HINTS, KIND_LABELS, SOURCE_KIND_LABELS, SOURCE_KIND_ROLE } from '../../shared/labels.ts';
import { QUESTION_KINDS, SOURCE_KINDS, TEMPLATE_FIELDS } from '../../shared/types.ts';
import type { ChunkRef, StyleExample, TopicsInput, UnitsInput } from './types.ts';

// ---------- learner style ----------

export interface StyleProfile {
  sample: number;
  /** Most definition cards show a bare term (no '?', at most 6 words). */
  bareTerms: boolean;
  /** Median answer is longer than 25 words: extra context belongs in `explanation`. */
  longAnswers: boolean;
  medianAnswerWords: number;
}

function words(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

export function analyzeStyle(style: StyleExample[]): StyleProfile {
  const valid = (style ?? []).filter((s) => s && typeof s.prompt === 'string' && typeof s.answer === 'string');
  const defs = valid.filter((s) => s.kind === 'definition');
  const pool = defs.length ? defs : valid;
  const bare = pool.filter((s) => !/[?؟？]/.test(s.prompt) && words(s.prompt) <= 6).length;
  const lengths = valid.map((s) => words(s.answer)).sort((a, b) => a - b);
  const mid = Math.floor(lengths.length / 2);
  const median = lengths.length === 0 ? 0 : lengths.length % 2 ? lengths[mid] : (lengths[mid - 1] + lengths[mid]) / 2;
  return { sample: valid.length, bareTerms: pool.length > 0 && bare * 2 > pool.length, longAnswers: median > 25, medianAnswerWords: median };
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Few-shot block: up to `max` of the learner's own cards, spread across kinds. */
export function buildStyleBlock(style: StyleExample[], max = 8): string {
  const profile = analyzeStyle(style);
  if (profile.sample === 0) {
    return [
      '## סגנון הלומד',
      'אין עדיין כרטיסים מאושרים של הלומד. נסח שאלות הגדרה כשאלה ("מהו X?" / "מהי X?"), ותשובות קצרות וממוקדות.',
    ].join('\n');
  }
  const byKind = new Map<string, StyleExample[]>();
  for (const s of style) {
    if (!s || typeof s.prompt !== 'string' || typeof s.answer !== 'string') continue;
    const list = byKind.get(s.kind) ?? [];
    list.push(s);
    byKind.set(s.kind, list);
  }
  const picked: StyleExample[] = [];
  while (picked.length < max && [...byKind.values()].some((l) => l.length)) {
    for (const list of byKind.values()) {
      const next = list.shift();
      if (next && picked.length < max) picked.push(next);
    }
  }
  const lines = [
    '## סגנון הלומד — חקה את הצורה, לא את התוכן',
    profile.bareTerms
      ? '- בכרטיסי הגדרה הלומד כותב בצד השאלה את המונח בלבד, בלי סימן שאלה. עשה כך גם אתה.'
      : '- הלומד מנסח את צד השאלה כשאלה מלאה. עשה כך גם אתה.',
    profile.longAnswers
      ? `- התשובות של הלומד ארוכות (כ־${Math.round(profile.medianAnswerWords)} מילים): תן תשובה ממוקדת ב־answer, והוסף הקשר (מנגנון, דוגמה, מגבלות) ב־explanation.`
      : `- התשובות של הלומד קצרות (כ־${Math.round(profile.medianAnswerWords)} מילים): שמור על answer קצר, ו־explanation רק כשיש מה להוסיף מהמקור.`,
    '',
    ...picked.map((s, i) => `${i + 1}. [${KIND_LABELS[s.kind] ?? s.kind}] צד א: ${clip(s.prompt, 160)}\n   צד ב: ${clip(s.answer, 320)}`),
  ];
  return lines.join('\n');
}

// ---------- chunks ----------

export interface ChunkPiece {
  chunk: ChunkRef;
  /** The chunk's text, or one part of it when the chunk was split into batches. */
  text: string;
}

function attr(s: string): string {
  return s.replace(/"/g, '״').replace(/\s+/g, ' ').trim();
}

export function formatChunk(p: ChunkPiece): string {
  const c = p.chunk;
  const kind = SOURCE_KIND_LABELS[c.sourceKind] ?? c.sourceKind;
  const role = SOURCE_KIND_ROLE[c.sourceKind] ?? '';
  const head = [
    `<chunk id="${c.chunkId}"`,
    ` kind="${c.sourceKind}"`,
    ` role="${attr(`${kind} — ${role}`)}"`,
    ` source="${attr(c.sourceTitle)}"`,
    ` locator="${attr(c.locatorLabel)}"`,
    c.heading ? ` heading="${attr(c.heading)}"` : '',
    '>',
  ].join('');
  return `${head}\n${p.text}\n</chunk>`;
}

// ---------- system prompts ----------

const kindLines = QUESTION_KINDS.map((k) => `- ${k} (${KIND_LABELS[k]}): ${KIND_HINTS[k]}`).join('\n');
const authorityLines = SOURCE_KINDS.map((k) => `- ${k} (${SOURCE_KIND_LABELS[k]}): ${SOURCE_KIND_ROLE[k]}`).join('\n');
const fieldList = (t: keyof typeof TEMPLATE_FIELDS) => TEMPLATE_FIELDS[t].map((f) => `${f} (${FIELD_LABELS[f]})`).join(' → ');

export const UNITS_SYSTEM_PROMPT = `אתה עוזר שמכין הצעות ליחידות ידע ולכרטיסי לימוד בסגנון Quizlet עבור לומד אחד, מתוך קטעי חומר של קורס.
אתה רק מציע: כל הצעה נבדקת מול המקור, ואדם מאשר, עורך או פוסל אותה. לעולם אל תקבע תאריכים או מועדי חזרה, ואל תסמן דבר כמאושר.

## ביסוס במקור — חובה
1. השתמש אך ורק במידע שמופיע בקטעים שקיבלת. אל תמציא עובדות, מספרים, דוגמאות, שמות או מנגנונים שאינם בטקסט, גם אם אתה "יודע" אותם.
2. לכל יחידה ולכל שאלה צרף evidence: מזהה הקטע (chunkId, המספר מתוך <chunk id="...">) וציטוט (quote) שמועתק מילה במילה, תו בתו, מטקסט הקטע — בלי ניסוח מחדש, בלי תרגום ובלי השמטות באמצע. ציטוט שלא נמצא בקטע פוסל את ההצעה.
3. אם אין קטע שתומך בתשובה — אל תציע אותה. עדיף מעט הצעות נכונות מהרבה הצעות מנוחשות.
4. אם שני מקורות אומרים דברים סותרים על אותו עניין — אל תכריע ביניהם ואל תמזג אותם. דווח ב־conflicts: תיאור קצר בעברית של הסתירה וציטוט מכל צד. מותר להציע את היחידה לפי המקור הסמכותי יותר; היא תסומן לבדיקה.

## סמכות המקורות
${authorityLines}
- מבחן קודם מלמד על סגנון השאלות והדגשים. חקה את הסגנון, אבל בסס את התשובה על חומר הקורס כשהוא קיים.
- סיכום סטודנטים הוא עזר: אם אותו דבר מופיע גם בחומר הקורס — צטט את חומר הקורס.
- סילבוס אינו מקור לתוכן של תשובות.

## צורת הכרטיס
צד אחד: מונח או שאלה (prompt). צד שני: תשובה (answer) והסבר (explanation).
סוגי שאלות (kind) — השתמש רק בקודים האלה:
${kindLines}

## איכות התשובה
- בתשובות חשובות כלול מנגנון, תפקיד, דוגמה, כיוון סיבתי ומגבלות — רק מה שכתוב במקור. אפשר לפרט אותם ב־structure עם template "general" ושדות ${fieldList('general')}.
- ב־recall, causal, comparison ו־application חובה keyPoints: 2–5 נקודות קצרות שתשובה נכונה חייבת לכלול.
- causal: מה גורם למה, באיזה כיוון (מגביר/מעכב/מפעיל) ובאילו תנאים.
- comparison: מה משותף ומה שונה בין שני מושגים קרובים; keyPoints מכל צד.
- מסלול ביולוגי: structure.template = "pathway", והשדות בסדר קבוע: ${fieldList('pathway')}. הוסף גם שאלת cloze בנוסח "השלם את המסלול: A → [[B]] → C → D".
- שיטה ניסויית: structure.template = "method", והשדות: ${fieldList('method')}. השאלה מבקשת מה השיטה מודדת, במה תוצאה מסוימת תומכת, מה היא אינה מוכיחה, ומהן הבקרות או המגבלות.
- cloze: prompt הוא המשפט המלא מהמקור, והחלק שהוסתר עטוף ב־[[...]]; answer הוא הטקסט שהוסתר.
- אנלוגיה מותרת רק בשדה structure.analogy, כעזר. היא לעולם לא מחליפה את המונח המדעי, והמונח חייב להופיע ב־answer.

## שפה וסגנון
- נסח שאלות ותשובות בשפת המקור (עברית כשהמקור בעברית). השאר מונחים מדעיים כפי שהם במקור, כולל מונחים באנגלית כמו GLUT4 או ATP.
- תיאורי סתירות (conflicts) — תמיד בעברית.
- חקה את סגנון הכרטיסים של הלומד (ראה למטה): מונח חשוף או שאלה מלאה, ואורך התשובה.
- יחידת ידע = רעיון אחד קטן (מונח, מסלול, קשר סיבתי). אל תציע את אותו מונח פעמיים.
- topicName: אחד מהנושאים הקיימים כשהוא מתאים; אחרת כותרת הקטע.

## פלט
החזר JSON בלבד, לפי הסכמה: {"units": [...], "conflicts": [...]}. אם אין מה להציע — החזר רשימות ריקות.`;

export const TOPICS_SYSTEM_PROMPT = `אתה עוזר שמציע מפת נושאים לקורס מתוך קטעי חומר. אתה רק מציע — אדם מאשר, עורך או פוסל כל נושא.

## מה להציע
- נושאים ותתי־נושאים מתוך כותרות (שקופיות, פרקים, כותרות מסמך) ומשורות סילבוס כמו "שבוע 3: ...", "שיעור 4 – ...", "הרצאה 5 - ...", "Week 2: ...", "Lecture 3 – ...", ורשימות ממוספרות בסילבוס.
- syllabusOrder: מספר השבוע, השיעור או הפריט — רק כשהמקור הוא סילבוס; אחרת null.
- parentName: שם נושא האב כשזה תת־נושא (למשל פריט שמופיע תחת שורת שבוע); אחרת null.
- description: פירוט קצר מתוך אותה שורה, אם יש; אחרת null.
- name: קצר (עד כ־6 מילים), בשפת המקור, בלי מספור ובלי "(המשך)".

## מה לא להציע
- פריטים מנהליים: דרישות הקורס, ציונים, מטלות, קריאה, שעות קבלה, פרטי המרצה, חופשות.
- שקופיות שאינן נושא: "תודה", "שאלות?", "תוכן עניינים", "Agenda", "סיכום".
- נושאים שכבר קיימים (הרשימה למטה) או כפילויות של אותו נושא בשמות שונים.

## ביסוס
- לכל נושא צרף evidence: chunkId וציטוט מדויק, תו בתו, של הכותרת או השורה שממנה הוא נלקח.
- הסילבוס הוא מפת ציפיות ולא אמת מוחלטת; החומר שנלמד בפועל קובע את המבנה הסופי.

## פלט
החזר JSON בלבד, לפי הסכמה: {"topics": [...]}. אם אין מה להציע — רשימה ריקה.`;

// ---------- user prompts ----------

function existingList(names: string[]): string {
  return names.length ? names.map((n) => `- ${n}`).join('\n') : '(אין עדיין)';
}

export function buildTopicsUserPrompt(input: TopicsInput, pieces: ChunkPiece[]): string {
  return [
    `קורס: ${input.course}`,
    '',
    'נושאים שכבר קיימים בקורס (אל תציע אותם שוב):',
    existingList(input.existingTopics),
    '',
    'קטעי המקור:',
    pieces.map(formatChunk).join('\n\n'),
  ].join('\n');
}

export function buildUnitsUserPrompt(input: UnitsInput, pieces: ChunkPiece[]): string {
  return [
    `קורס: ${input.course}`,
    `נושא מבוקש: ${input.topicHint?.trim() || '(לא צוין — השתמש בכותרת הקטע)'}`,
    '',
    'נושאים קיימים בקורס:',
    existingList(input.existingTopics),
    '',
    buildStyleBlock(input.style ?? []),
    '',
    'קטעי המקור (צטט מהם מילה במילה, עם ה־id שלהם):',
    pieces.map(formatChunk).join('\n\n'),
  ].join('\n');
}
