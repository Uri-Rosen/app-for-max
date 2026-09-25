// Plain-text formats: .txt, .md, .csv.

import type { ExtractedChunk, ExtractResult } from '../types.ts';
import { normalizeText } from '../hebrew.ts';
import { buildSections } from './index.ts';
import type { Block } from './index.ts';

const TXT_CHUNK_MAX = 1500;
const CSV_ROWS_PER_CHUNK = 200;

/** UTF-8 (or UTF-16 with BOM); bytes that are not valid UTF-8 are read as windows-1255 (Hebrew). */
export function decodeText(buf: Uint8Array): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1255').decode(buf);
  }
}

function sectionChunk(n: number, heading: string | null, text: string): ExtractedChunk {
  return { locatorType: 'section', locatorNum: n, locatorLabel: `סעיף ${n}`, heading, text, notes: null };
}

function hardSplit(line: string, max: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Greedily packs paragraphs into chunks of at most `max` chars; oversized paragraphs are split by line. */
function packParagraphs(paragraphs: string[], max: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  const add = (piece: string, sep: string) => {
    if (cur && cur.length + sep.length + piece.length > max) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? cur + sep + piece : piece;
  };
  for (const p of paragraphs) {
    if (p.length <= max) {
      add(p, '\n\n');
      continue;
    }
    let sep = '\n\n';
    for (const line of p.split('\n')) {
      for (const piece of hardSplit(line, max)) {
        add(piece, sep);
        sep = '\n';
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function extractTxt(raw: string): ExtractResult {
  const paragraphs = normalizeText(raw)
    .split(/\n[ \t]*\n/)
    .map((p) => p.replace(/^\n+|\n+$/g, ''))
    .filter((p) => p.trim() !== '');
  const chunks = packParagraphs(paragraphs, TXT_CHUNK_MAX).map((t, i) => sectionChunk(i + 1, null, normalizeText(t)));
  return {
    format: 'txt',
    chunks,
    pageCount: chunks.length,
    warnings: chunks.length === 0 ? ['הקובץ ריק'] : [],
    outline: [],
  };
}

function extractMd(raw: string): ExtractResult {
  let lines = normalizeText(raw).split('\n');
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0 && end < 60) lines = lines.slice(end + 1);
  }

  const blocks: Block[] = [];
  let para: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (para.length > 0) blocks.push({ text: para.join('\n'), level: null });
    para = [];
  };
  for (const line of lines) {
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      para.push(line);
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      para.push(line);
      continue;
    }
    const h = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h && h[2].trim()) {
      flush();
      blocks.push({ text: h[2].trim(), level: h[1].length });
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();

  if (!blocks.some((b) => b.level != null)) {
    const chunks = packParagraphs(
      blocks.map((b) => b.text),
      TXT_CHUNK_MAX,
    ).map((t, i) => sectionChunk(i + 1, null, normalizeText(t)));
    return { format: 'md', chunks, pageCount: chunks.length, warnings: chunks.length ? [] : ['הקובץ ריק'], outline: [] };
  }
  const { chunks, outline } = buildSections(blocks, { joiner: '\n\n', maxChars: 6000, fallbackBlocks: 12 });
  return { format: 'md', chunks, pageCount: chunks.length, warnings: [], outline };
}

export function detectDelimiter(text: string): string {
  const lines = text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(0, 50)
    .map((l) => l.replace(/"[^"]*"/g, ''));
  let best = ',';
  let bestScore = 0;
  for (const d of [',', ';', '\t']) {
    const freq = new Map<number, number>();
    for (const l of lines) {
      const count = l.split(d).length - 1;
      if (count > 0) freq.set(count, (freq.get(count) ?? 0) + 1);
    }
    let mode = 0;
    let modeFreq = 0;
    for (const [c, f] of freq) {
      if (f > modeFreq || (f === modeFreq && c > mode)) {
        mode = c;
        modeFreq = f;
      }
    }
    const score = modeFreq / Math.max(1, lines.length) + mode * 1e-4;
    if (modeFreq > 0 && score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && field.trim() === '') {
      field = '';
      quoted = true;
    } else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function extractCsv(raw: string, name: string): ExtractResult {
  const sheet = name.replace(/\.[^.]+$/, '');
  const text = raw.replace(/^\uFEFF/, '');
  const records = parseCsv(text, detectDelimiter(text));
  const lines: Array<{ num: number; text: string }> = [];
  records.forEach((rec, i) => {
    const cells = rec.map((c) => normalizeText(c).replace(/\s*\n\s*/g, ' '));
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > 0) lines.push({ num: i + 1, text: cells.join(' | ') });
  });

  const chunks: ExtractedChunk[] = [];
  const split = lines.length > CSV_ROWS_PER_CHUNK;
  for (let start = 0; start < lines.length; start += CSV_ROWS_PER_CHUNK) {
    const part = lines.slice(start, start + CSV_ROWS_PER_CHUNK);
    chunks.push({
      locatorType: 'sheet',
      locatorNum: 1,
      locatorLabel: split
        ? `גיליון '${sheet}' שורות ${part[0].num}–${part[part.length - 1].num}`
        : `גיליון '${sheet}'`,
      heading: sheet,
      text: normalizeText(part.map((l) => l.text).join('\n')),
      notes: null,
    });
  }
  return { format: 'csv', chunks, pageCount: 1, warnings: chunks.length === 0 ? ['הקובץ ריק'] : [], outline: [] };
}

export function extractText(buf: Uint8Array, filename: string, ext: '.txt' | '.md' | '.csv'): ExtractResult {
  const raw = decodeText(buf);
  if (ext === '.csv') return extractCsv(raw, filename);
  if (ext === '.md') return extractMd(raw);
  return extractTxt(raw);
}
