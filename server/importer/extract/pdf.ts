// PDF → one chunk per page, via pdfjs-dist (legacy build, fake worker in Node).

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ExtractedChunk, ExtractResult, OutlineEntry } from '../types.ts';
import {
  containsHebrew,
  containsLtr,
  countHebrewLetters,
  fixVisualHebrew,
  hebrewOrder,
  mirrorBrackets,
  mirrorOutsideLtrRuns,
  normalizeText,
  reverseGraphemes,
  reverseVisualLine,
} from '../hebrew.ts';

const require = createRequire(import.meta.url);
const PDFJS_DIR = dirname(require.resolve('pdfjs-dist/package.json'));
// pdf.js's Node data factory reads cMapUrl/standardFontDataUrl/wasmUrl with fs.readFile(base + name),
// so these are plain directory paths with a trailing slash, not file:// URLs.
const dirPath = (sub: string) => `${join(PDFJS_DIR, sub).replaceAll('\\', '/')}/`;

// In Node pdfjs runs its worker on the main thread ("fake worker") and loads it via import(workerSrc).
// Point it at the installed file explicitly so resolution does not depend on the caller's bundler/runner.
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

interface TextItemLike {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

interface PdfDoc {
  numPages: number;
  getOutline(): Promise<OutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
}

interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: OutlineNode[];
}

const MAX_OUTLINE = 2000;

interface Piece {
  str: string;
  left: number;
  right: number;
  h: number;
  kind: 'rtl' | 'ltr' | 'neutral';
  /** pdf.js reported the item as RTL, i.e. it already reversed it into logical order. */
  pdfjsRtl?: boolean;
}

function kindOf(s: string): Piece['kind'] {
  return containsHebrew(s) ? 'rtl' : containsLtr(s) ? 'ltr' : 'neutral';
}

/** Groups items into lines, in content-stream order, breaking on hasEOL or a baseline change. */
function groupLines(items: TextItemLike[]): Piece[][] {
  const lines: Piece[][] = [];
  let cur: Piece[] = [];
  let prevY = 0;
  for (const it of items) {
    const x = it.transform[4] ?? 0;
    const y = it.transform[5] ?? 0;
    const h = Math.abs(it.height) || Math.hypot(it.transform[2] ?? 0, it.transform[3] ?? 0) || 10;
    if (it.str !== '') {
      const prev = cur[cur.length - 1];
      if (prev && Math.abs(y - prevY) > Math.max(2, 0.5 * Math.min(h, prev.h))) {
        lines.push(cur);
        cur = [];
      }
      const w = Math.abs(it.width);
      cur.push({ str: it.str, left: x, right: x + w, h, kind: kindOf(it.str), pdfjsRtl: it.dir === 'rtl' });
      prevY = y;
    }
    if (it.hasEOL && cur.length > 0) {
      lines.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

/**
 * Makes each piece's own text logical. pdf.js already reverses RTL runs inside an item (without mirroring
 * brackets); items whose Hebrew still reads reversed (final letters at word start) are flipped here.
 */
function fixPiece(p: Piece, pageVerdict: ReturnType<typeof hebrewOrder>): Piece {
  let s = p.str;
  if (containsHebrew(s)) {
    const own = hebrewOrder(s);
    if (own === 'visual') s = fixVisualHebrew(s);
    else if (own === 'unknown' && pageVerdict === 'visual') s = reverseVisualLine(s);
    else if (p.pdfjsRtl) s = mirrorOutsideLtrRuns(s);
  }
  return { ...p, str: s, kind: kindOf(s) };
}

/** Neutral pieces between RTL material were stored visually: reverse their characters and mirror brackets. */
const flipNeutral = (p: Piece) => (p.kind === 'neutral' ? mirrorBrackets(reverseGraphemes(p.str)) : p.str);

/** Visual (left-to-right) pieces → logical text for a right-to-left line; LTR runs keep their order. */
function orderRtl(visual: Piece[]): string {
  const r = [...visual].reverse();
  let out = '';
  for (let i = 0; i < r.length; ) {
    if (r[i].kind !== 'ltr') {
      out += flipNeutral(r[i]);
      i++;
      continue;
    }
    let end = i;
    for (let j = i + 1; j < r.length && r[j].kind !== 'rtl'; j++) if (r[j].kind === 'ltr') end = j;
    out += r
      .slice(i, end + 1)
      .reverse()
      .map((p) => p.str)
      .join('');
    i = end + 1;
  }
  return out;
}

/** Visual pieces → logical text for a left-to-right line; runs of RTL pieces are reversed. */
function orderLtr(visual: Piece[]): string {
  let out = '';
  for (let i = 0; i < visual.length; ) {
    if (visual[i].kind !== 'rtl') {
      out += visual[i].str;
      i++;
      continue;
    }
    let end = i;
    for (let j = i + 1; j < visual.length && visual[j].kind !== 'ltr'; j++) if (visual[j].kind === 'rtl') end = j;
    out += visual
      .slice(i, end + 1)
      .reverse()
      .map(flipNeutral)
      .join('');
    i = end + 1;
  }
  return out;
}

/**
 * Rebuilds logical text lines from pdf.js text items: groups by hasEOL / baseline, orders each line's
 * pieces by x position, infers missing spaces from gaps, and applies bidi ordering at the piece level.
 */
export function itemsToLines(items: TextItemLike[]): string[] {
  const all = items.map((it) => it.str).join(' ');
  const pageVerdict = hebrewOrder(all);
  const pageRtl = countHebrewLetters(all) >= (all.match(/[A-Za-z]/g)?.length ?? 0);

  return groupLines(items).map((group) => {
    const pieces = group.map((p) => fixPiece(p, pageVerdict)).sort((a, b) => a.left - b.left);
    const visual: Piece[] = [];
    for (const p of pieces) {
      const prev = visual[visual.length - 1];
      const gap = prev ? p.left - prev.right : 0;
      if (
        prev &&
        prev.right > prev.left &&
        gap > 0.15 * Math.min(p.h, prev.h) &&
        !/\s$/.test(prev.str) &&
        !/^\s/.test(p.str)
      ) {
        visual.push({ str: ' ', left: prev.right, right: p.left, h: p.h, kind: 'neutral' });
      }
      visual.push(p);
    }
    const hasRtl = visual.some((p) => p.kind === 'rtl');
    const hasLtr = visual.some((p) => p.kind === 'ltr');
    const line = hasRtl && (!hasLtr || pageRtl) ? orderRtl(visual) : orderLtr(visual);
    return line.trim();
  });
}

function guessHeading(text: string): string | null {
  for (const line of text.split('\n').slice(0, 3)) {
    const t = line.trim();
    if (!t || !/\p{L}/u.test(t)) continue;
    return t.length <= 80 ? t : null;
  }
  return null;
}

async function resolveDestPage(doc: PdfDoc, dest: OutlineNode['dest']): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const target = explicit[0];
    let index: number | null = null;
    if (typeof target === 'number') index = target;
    else if (target && typeof target === 'object' && 'num' in target && 'gen' in target) {
      index = await doc.getPageIndex(target as { num: number; gen: number });
    }
    return index != null && index >= 0 && index < doc.numPages ? index + 1 : null;
  } catch {
    return null;
  }
}

async function readOutline(doc: PdfDoc): Promise<OutlineEntry[]> {
  let nodes: OutlineNode[] | null;
  try {
    nodes = await doc.getOutline();
  } catch {
    return [];
  }
  const out: OutlineEntry[] = [];
  const walk = async (list: OutlineNode[], level: number): Promise<void> => {
    for (const node of list) {
      if (out.length >= MAX_OUTLINE) return;
      const text = normalizeText(node.title ?? '').replace(/\s+/g, ' ');
      const page = await resolveDestPage(doc, node.dest);
      if (text && page != null) out.push({ level, text, locatorNum: page });
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  if (nodes) await walk(nodes, 1);
  return out;
}

function emptyPageWarnings(pages: number[]): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++;
    const range = i === j ? `${pages[i]}` : `${pages[i]}–${pages[j]}`;
    warnings.push(`עמ' ${range}: אין שכבת טקסט — ייתכן שזו סריקה`);
    i = j + 1;
  }
  return warnings;
}

export async function extractPdf(buf: Uint8Array): Promise<ExtractResult> {
  const task = pdfjs.getDocument({
    data: buf.slice(), // pdf.js may transfer (detach) the buffer it is given — never hand it the caller's bytes
    cMapUrl: dirPath('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: dirPath('standard_fonts'),
    wasmUrl: dirPath('wasm'),
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: false,
    verbosity: 0,
  });

  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      if (name === 'PasswordException') throw new Error('קובץ ה־PDF מוגן בסיסמה.');
      if (name === 'InvalidPDFException') throw new Error('הקובץ אינו PDF תקין או שהוא פגום.');
      throw err;
    }

    const chunks: ExtractedChunk[] = [];
    const emptyPages: number[] = [];
    const failed: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      let text: string;
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const items = content.items.filter((it): it is typeof it & TextItemLike => 'str' in it);
        text = normalizeText(itemsToLines(items).join('\n'));
        page.cleanup();
      } catch {
        failed.push(`עמ' ${n}: לא ניתן לקרוא את העמוד — ייתכן שהוא פגום`);
        continue;
      }
      if (!/\p{L}/u.test(text) && text.length < 10) {
        emptyPages.push(n);
        continue;
      }
      chunks.push({
        locatorType: 'page',
        locatorNum: n,
        locatorLabel: `עמ' ${n}`,
        heading: guessHeading(text),
        text,
        notes: null,
      });
    }

    const outline = await readOutline(doc as unknown as PdfDoc);
    const warnings = [...emptyPageWarnings(emptyPages), ...failed];
    return { format: 'pdf', chunks, pageCount: doc.numPages, warnings, outline };
  } finally {
    await task.destroy();
  }
}
