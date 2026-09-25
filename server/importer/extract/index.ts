// Text extraction entry point, plus small helpers shared by the per-format extractors.
// Extractors are loaded lazily so heavy libraries (pdfjs, exceljs) load only when needed.

import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { normalizeText } from '../hebrew.ts';
import { SUPPORTED_EXTENSIONS } from '../types.ts';
import type { ExtractedChunk, ExtractResult, OutlineEntry } from '../types.ts';

export async function extractFile(buf: Uint8Array, filename: string): Promise<ExtractResult> {
  const ext = /\.[^./\\]+$/.exec(filename)?.[0].toLowerCase() ?? '';
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new Error(
      `סוג הקובץ ${ext ? `"${ext}" ` : ''}אינו נתמך. אפשר לייבא קובצי ${SUPPORTED_EXTENSIONS.join(', ')}.`,
    );
  }
  const name = filename.split(/[\\/]/).pop() ?? filename;
  if (buf.byteLength === 0) throw new Error(`הקובץ "${name}" ריק.`);
  try {
    switch (ext) {
      case '.pdf':
        return await (await import('./pdf.ts')).extractPdf(buf);
      case '.pptx':
        return await (await import('./pptx.ts')).extractPptx(buf);
      case '.docx':
        return await (await import('./docx.ts')).extractDocx(buf);
      case '.xlsx':
        return await (await import('./xlsx.ts')).extractXlsx(buf);
      default:
        return (await import('./text.ts')).extractText(buf, name, ext as '.txt' | '.md' | '.csv');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`לא ניתן לחלץ טקסט מהקובץ "${name}": ${msg}`, { cause: err });
  }
}

/** sha256 of text normalized so that chunks differing only in niqqud, case, quotes, punctuation or spacing collide. */
export function normHash(text: string): string {
  const s = text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\u05BE/g, '-')
    .replace(/[\u05C0\u05C3\u05C6]/g, ' ')
    .replace(/[\u0591-\u05C7]/g, '')
    .toLowerCase()
    .replace(/["'`\u00B4\u05F3\u05F4\u2018-\u201F\u2032\u2033]/g, '')
    .replace(/[\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]/g, '-')
    .replace(/\p{P}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Shared helpers for extractors (not part of the public importer contract).

export type ZipFiles = Record<string, Uint8Array>;

/** Throws a Hebrew error when bytes are not a ZIP-based Office file. */
export function assertOfficeZip(buf: Uint8Array, kind: string): void {
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    throw new Error(`הקובץ מוגן בסיסמה או שמור בפורמט ${kind} ישן. יש לשמור אותו מחדש כקובץ רגיל ולנסות שוב.`);
  }
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`הקובץ אינו קובץ ${kind} תקין.`);
  }
}

/** Unzips only the XML parts (media is skipped). */
export function readZip(buf: Uint8Array, kind: string): ZipFiles {
  assertOfficeZip(buf, kind);
  try {
    return unzipSync(buf, {
      filter: (f) => /\.(xml|rels)$/i.test(f.name) && f.originalSize < 200 * 1024 * 1024,
    });
  } catch {
    throw new Error(`הקובץ אינו קובץ ${kind} תקין (הארכיון פגום).`);
  }
}

export function zipText(files: ZipFiles, path: string): string | null {
  let data: Uint8Array | undefined = files[path];
  if (!data) {
    const lower = path.toLowerCase();
    const key = Object.keys(files).find((k) => k.toLowerCase() === lower);
    if (key) data = files[key];
  }
  if (!data) return null;
  const s = strFromU8(data);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export type XmlToken =
  | { type: 'open'; local: string; attrs: string; selfClosing: boolean }
  | { type: 'close'; local: string }
  | { type: 'text'; text: string };

const XML_TOKEN =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[?!][^>]*>|([^<]+)/g;

/** Minimal streaming XML tokenizer. Element names are reported by local name (prefix stripped). */
export function* xmlTokens(xml: string): Generator<XmlToken> {
  for (const m of xml.matchAll(XML_TOKEN)) {
    if (m[2] !== undefined) {
      const local = m[2].slice(m[2].indexOf(':') + 1);
      if (m[1]) yield { type: 'close', local };
      else yield { type: 'open', local, attrs: m[3] ?? '', selfClosing: m[4] === '/' };
    } else if (m[5] !== undefined) {
      yield { type: 'text', text: m[5] };
    } else if (m[6] !== undefined) {
      yield { type: 'text', text: decodeXml(m[6]) };
    }
  }
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] !== '#') return NAMED_ENTITIES[e] ?? '';
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
      ? String.fromCodePoint(cp)
      : '';
  });
}

/**
 * Attribute value by local name. With `prefixed`, only a namespaced attribute matches
 * (so `r:id` is found and a plain `id` is not).
 */
export function attr(attrs: string, local: string, prefixed = false): string | null {
  for (const m of attrs.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = m[1];
    const colon = name.indexOf(':');
    if (name.slice(colon + 1) !== local || (prefixed && colon < 0)) continue;
    return decodeXml(m[2] ?? m[3] ?? '');
  }
  return null;
}

export interface Relationship {
  id: string;
  type: string;
  /** Zip path of the target part (or the raw URL for external targets). */
  target: string;
  external: boolean;
}

export function resolvePart(dir: string, target: string): string {
  let t = target;
  try {
    t = decodeURIComponent(target);
  } catch {
    // keep raw
  }
  const joined = t.startsWith('/') ? t.slice(1) : (dir ? `${dir}/` : '') + t;
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

/** Relationships of a part ('' for the package root). */
export function readRels(files: ZipFiles, partPath: string): Relationship[] {
  const slash = partPath.lastIndexOf('/');
  const dir = slash >= 0 ? partPath.slice(0, slash) : '';
  const base = partPath.slice(slash + 1);
  const xml = zipText(files, `${dir ? `${dir}/` : ''}_rels/${base}.rels`);
  if (!xml) return [];
  const rels: Relationship[] = [];
  for (const tok of xmlTokens(xml)) {
    if (tok.type !== 'open' || tok.local !== 'Relationship') continue;
    const id = attr(tok.attrs, 'Id');
    const target = attr(tok.attrs, 'Target');
    if (!id || !target) continue;
    const external = attr(tok.attrs, 'TargetMode') === 'External';
    rels.push({
      id,
      type: attr(tok.attrs, 'Type') ?? '',
      target: external ? target : resolvePart(dir, target),
      external,
    });
  }
  return rels;
}

/** Main part of an OOXML package (word/document.xml, ppt/presentation.xml…). */
export function officeDocumentPath(files: ZipFiles, fallback: string): string {
  const rel = readRels(files, '').find((r) => r.type.endsWith('/officeDocument') && !r.external);
  return rel && zipText(files, rel.target) !== null ? rel.target : fallback;
}

/** Collects table rows as "cell | cell" lines. */
export class TableBuilder {
  rows: string[] = [];
  row: string[] | null = null;
  cell: string[] | null = null;

  startRow(): void {
    this.row = [];
  }
  startCell(): void {
    this.cell = [];
  }
  endCell(): void {
    if (this.row && this.cell) this.row.push(this.cell.join(' ').replace(/\s+/g, ' ').trim());
    this.cell = null;
  }
  endRow(): void {
    const r = this.row;
    if (r) {
      while (r.length > 0 && r[r.length - 1] === '') r.pop();
      if (r.length > 0) this.rows.push(r.join(' | '));
    }
    this.row = null;
  }
}

export interface Block {
  text: string;
  /** Heading level (1 = top) or null for body text. */
  level: number | null;
}

export interface SectionOptions {
  joiner: string;
  /** Start a continuation section when a section's body grows past this. */
  maxChars: number;
  /** Paragraphs per section when the document has no headings. */
  fallbackBlocks: number;
}

/**
 * Splits blocks into 'section' chunks at the top two heading levels present
 * (level 1/2 in a normal document). Consecutive headings with no body between them share a section.
 */
export function buildSections(
  blocks: Block[],
  opts: SectionOptions,
): { chunks: ExtractedChunk[]; outline: OutlineEntry[] } {
  interface Section {
    heading: string | null;
    parts: string[];
    size: number;
    hasBody: boolean;
  }
  const sections: Section[] = [];
  const outline: OutlineEntry[] = [];
  const items = blocks.filter((b) => b.text.trim() !== '');
  const levels = items.flatMap((b) => (b.level == null ? [] : [b.level]));

  if (levels.length === 0) {
    for (let i = 0; i < items.length; i += opts.fallbackBlocks) {
      const parts = items.slice(i, i + opts.fallbackBlocks).map((b) => b.text);
      sections.push({ heading: null, parts, size: 0, hasBody: true });
    }
  } else {
    const splitMax = Math.min(...levels) + 1;
    let cur: Section | null = null;
    const open = (heading: string | null): Section => {
      const s: Section = { heading, parts: [], size: 0, hasBody: false };
      sections.push(s);
      return s;
    };
    for (const b of items) {
      const isSplit = b.level != null && b.level <= splitMax;
      if (!cur || (isSplit && cur.hasBody)) cur = open(null);
      else if (!isSplit && cur.hasBody && cur.size + b.text.length > opts.maxChars) cur = open(cur.heading);
      const text = b.level != null ? b.text.replace(/\s+/g, ' ').trim() : b.text;
      cur.parts.push(text);
      cur.size += text.length + opts.joiner.length;
      if (isSplit) cur.heading = text;
      else cur.hasBody = true;
      if (b.level != null) outline.push({ level: b.level, text, locatorNum: sections.length });
    }
  }

  const chunks = sections.map(
    (s, i): ExtractedChunk => ({
      locatorType: 'section',
      locatorNum: i + 1,
      locatorLabel: `סעיף ${i + 1}`,
      heading: s.heading,
      text: normalizeText(s.parts.join(opts.joiner)),
      notes: null,
    }),
  );
  return { chunks, outline };
}
