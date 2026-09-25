// Hebrew-aware text helpers: visual-order repair for PDF text, and text normalization.

const HEBREW_LETTER = /[\u05D0-\u05EA]/;
const HEBREW_WORD = /[\u05D0-\u05EA][\u05D0-\u05EA\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]*/g;
const FINAL_LETTERS = new Set(['ך', 'ם', 'ן', 'ף', 'ץ']);

// Left-to-right material that must stay readable after a visual line is reversed:
// Latin/Greek/Cyrillic letters and digits, plus the neutrals between them (no RTL chars inside).
const LTR_CHAR = 'A-Za-z0-9\\u00C0-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF';
const RTL_CHAR = '\\u0590-\\u05FF\\u0600-\\u06FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFF';
// Number-attached terminators (bidi class ET), e.g. "10%", "5°".
const NUMBER_ATTACHED = '%\\u2030\\u00B0#$\\u20AA\\u20AC\\u00A3\\u00A2';
const LTR_RUN = new RegExp(
  `[${NUMBER_ATTACHED}]*[${LTR_CHAR}](?:[^${RTL_CHAR}]*[${LTR_CHAR}])?[${NUMBER_ATTACHED}]*`,
  'g',
);
const MIRROR: Record<string, string> = {
  '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«',
};

const graphemes = new Intl.Segmenter('he', { granularity: 'grapheme' });

/** Reverses by grapheme, so niqqud stays attached to its letter. */
export function reverseGraphemes(s: string): string {
  return Array.from(graphemes.segment(s), (g) => g.segment).reverse().join('');
}

export function mirrorBrackets(s: string): string {
  return s.replace(/[()[\]{}<>«»]/g, (c) => MIRROR[c] ?? c);
}

/** Applies `ltr` to left-to-right runs (Latin words, numbers) and `other` to everything between them. */
function mapLtrRuns(s: string, ltr: (run: string) => string, other: (rest: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(LTR_RUN)) {
    const at = m.index ?? 0;
    out += other(s.slice(last, at)) + ltr(m[0]);
    last = at + m[0].length;
  }
  return out + other(s.slice(last));
}

/**
 * For RTL text that was reversed without bracket mirroring (as pdf.js does):
 * mirrors brackets outside left-to-right runs.
 */
export function mirrorOutsideLtrRuns(s: string): string {
  return mapLtrRuns(s, (run) => run, mirrorBrackets);
}

export interface HebrewOrderEvidence {
  /** Hebrew words (2+ letters) that START with a final letter — a sign of reversed text. */
  startsWithFinal: number;
  /** Hebrew words (2+ letters) that END with a final letter — a sign of logical text. */
  endsWithFinal: number;
}

export function hebrewOrderEvidence(text: string): HebrewOrderEvidence {
  let startsWithFinal = 0;
  let endsWithFinal = 0;
  for (const m of text.matchAll(HEBREW_WORD)) {
    const letters = m[0].replace(/[^\u05D0-\u05EA]/g, '');
    if (letters.length < 2) continue;
    if (FINAL_LETTERS.has(letters[letters.length - 1])) endsWithFinal++;
    else if (FINAL_LETTERS.has(letters[0])) startsWithFinal++;
  }
  return { startsWithFinal, endsWithFinal };
}

/** 'visual' / 'logical' only when the evidence clearly points one way. */
export function hebrewOrder(text: string): 'visual' | 'logical' | 'unknown' {
  const { startsWithFinal: s, endsWithFinal: e } = hebrewOrderEvidence(text);
  if (s > 0 && s >= 2 * e + 1) return 'visual';
  if (e > 0 && e >= 2 * s + 1) return 'logical';
  return 'unknown';
}

/**
 * Unconditionally converts a visual-order (RTL paragraph) line to logical order:
 * reverse the whole line, then restore left-to-right runs (Latin words, numbers)
 * and mirror brackets that were outside those runs.
 */
export function reverseVisualLine(line: string): string {
  return mapLtrRuns(reverseGraphemes(line), reverseGraphemes, mirrorBrackets);
}

/**
 * Repairs a line whose Hebrew came out in visual order ("םולש" instead of "שלום").
 * Conservative: the line is changed only when final-letter evidence clearly says it is reversed.
 */
export function fixVisualHebrew(line: string): string {
  if (!HEBREW_LETTER.test(line)) return line;
  return hebrewOrder(line) === 'visual' ? reverseVisualLine(line) : line;
}

export function containsHebrew(text: string): boolean {
  return HEBREW_LETTER.test(text);
}

const HEBREW_LETTERS_G = new RegExp(HEBREW_LETTER.source, 'g');
const LTR_STRONG = new RegExp(`[${LTR_CHAR}]`);

export function countHebrewLetters(text: string): number {
  return text.match(HEBREW_LETTERS_G)?.length ?? 0;
}

/** Latin/Greek/Cyrillic letter or digit present. */
export function containsLtr(text: string): boolean {
  return LTR_STRONG.test(text);
}

/**
 * NFC, odd spaces → space, zero-width and bidi control characters removed,
 * trailing whitespace trimmed per line, 3+ newlines collapsed to 2, outer trim.
 */
export function normalizeText(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029\u000B\u000C]/g, '\n')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u061C\uFEFF\u00AD]/g, '')
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
