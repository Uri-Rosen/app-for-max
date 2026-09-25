// Parses a Quizlet export (or anything pasted from a two-column spreadsheet):
// one card per line/record, term and definition split by a separator.

export interface ParsedCard {
  term: string;
  definition: string;
  /** 'cloze' when the term had a blank (____) that the definition fills. */
  kind: 'definition' | 'cloze';
  prompt: string;
  record: number;
}

export interface ParseOptions {
  termSep?: 'auto' | 'tab' | 'comma' | 'dash' | string;
  cardSep?: 'auto' | 'newline' | 'semicolon' | 'blankline' | string;
}

function resolveTermSep(text: string, sep: string | undefined): string | RegExp {
  switch (sep ?? 'auto') {
    case 'tab':
      return '\t';
    case 'comma':
      return ',';
    case 'dash':
      return /\s+[-–—]\s+/;
    case 'auto':
      if (text.includes('\t')) return '\t';
      if (/\s[-–—]\s/.test(text)) return /\s+[-–—]\s+/;
      return ',';
    default:
      return sep as string;
  }
}

function resolveCardSep(text: string, sep: string | undefined): string | RegExp {
  switch (sep ?? 'auto') {
    case 'newline':
      return /\r?\n/;
    case 'semicolon':
      return ';';
    case 'blankline':
      return /\r?\n\s*\r?\n/;
    case 'auto':
      // Quizlet's default export is one card per line; a line-less paste with ';' uses semicolons.
      return /\r?\n/.test(text.trim()) ? /\r?\n/ : text.includes(';') ? ';' : /\r?\n/;
    default:
      return sep as string;
  }
}

function splitOnce(s: string, sep: string | RegExp): [string, string] | null {
  if (typeof sep === 'string') {
    const i = s.indexOf(sep);
    return i < 0 ? null : [s.slice(0, i), s.slice(i + sep.length)];
  }
  const m = sep.exec(s);
  return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length)] : null;
}

const BLANK = /_{3,}/;

export function parseCards(text: string, opts: ParseOptions = {}): {
  cards: ParsedCard[];
  skipped: { record: number; text: string; reason: string }[];
} {
  const termSep = resolveTermSep(text, opts.termSep);
  const cardSep = resolveCardSep(text, opts.cardSep);
  const records = text.split(cardSep);
  const cards: ParsedCard[] = [];
  const skipped: { record: number; text: string; reason: string }[] = [];
  const seen = new Set<string>();
  records.forEach((raw, i) => {
    const rec = raw.trim();
    if (!rec) return;
    const parts = splitOnce(rec, termSep);
    if (!parts) {
      skipped.push({ record: i + 1, text: rec.slice(0, 120), reason: 'לא נמצא מפריד בין מונח להגדרה' });
      return;
    }
    const term = parts[0].trim().replace(/^"(.*)"$/s, '$1');
    const definition = parts[1].trim().replace(/^"(.*)"$/s, '$1');
    if (!term || !definition) {
      skipped.push({ record: i + 1, text: rec.slice(0, 120), reason: 'חסר מונח או הגדרה' });
      return;
    }
    const key = `${term}\u0000${definition}`;
    if (seen.has(key)) {
      skipped.push({ record: i + 1, text: rec.slice(0, 120), reason: 'כרטיס כפול' });
      return;
    }
    seen.add(key);
    if (BLANK.test(term)) {
      cards.push({ term, definition, kind: 'cloze', prompt: term.replace(BLANK, `[[${definition}]]`), record: i + 1 });
    } else {
      cards.push({ term, definition, kind: 'definition', prompt: term, record: i + 1 });
    }
  });
  return { cards, skipped };
}
