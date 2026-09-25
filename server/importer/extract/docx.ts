// DOCX → section chunks split at headings.

import type { ExtractResult } from '../types.ts';
import { attr, buildSections, officeDocumentPath, readRels, readZip, TableBuilder, xmlTokens, zipText } from './index.ts';
import type { Block } from './index.ts';

interface StyleDef {
  level: number | null;
  /** Explicit outline level from the style (9 = body text). */
  outline: number | null;
  toc: boolean;
  basedOn: string | null;
}

class Styles {
  defs = new Map<string, StyleDef>();

  level(id: string, depth = 0): number | null {
    const def = this.defs.get(id);
    if (!def) return levelFromName(id);
    if (def.level != null) return def.level;
    if (def.outline != null) return def.outline < 9 ? def.outline + 1 : null;
    return def.basedOn && depth < 10 ? this.level(def.basedOn, depth + 1) : null;
  }

  isToc(id: string): boolean {
    return this.defs.get(id)?.toc ?? isTocName(id);
  }
}

function levelFromName(name: string): number | null {
  const n = name.trim().toLowerCase();
  const m = /^heading\s*([1-9])$/.exec(n);
  if (m) return Number(m[1]);
  return n === 'title' ? 1 : null;
}

function isTocName(name: string): boolean {
  return /^toc\s*(\d+|heading)?$/i.test(name.trim());
}

function toInt(v: string | null): number | null {
  if (v == null) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function parseStyles(xml: string | null): Styles {
  const styles = new Styles();
  if (!xml) return styles;
  let cur: { id: string | null; type: string | null; name: string; basedOn: string | null; outline: number | null } | null =
    null;
  for (const tok of xmlTokens(xml)) {
    if (tok.type === 'open') {
      if (tok.local === 'style' && !tok.selfClosing) {
        cur = { id: attr(tok.attrs, 'styleId'), type: attr(tok.attrs, 'type'), name: '', basedOn: null, outline: null };
      } else if (cur && tok.local === 'name') cur.name = attr(tok.attrs, 'val') ?? '';
      else if (cur && tok.local === 'basedOn') cur.basedOn = attr(tok.attrs, 'val');
      else if (cur && tok.local === 'outlineLvl') cur.outline = toInt(attr(tok.attrs, 'val'));
    } else if (tok.type === 'close' && tok.local === 'style') {
      if (cur?.id && (cur.type === 'paragraph' || cur.type == null)) {
        styles.defs.set(cur.id, {
          level: levelFromName(cur.name),
          outline: cur.outline,
          toc: isTocName(cur.name),
          basedOn: cur.basedOn,
        });
      }
      cur = null;
    }
  }
  return styles;
}

interface Para {
  parts: string[];
  style: string | null;
  outline: number | null;
  list: boolean;
}

function parseBody(xml: string, styles: Styles): Block[] {
  const blocks: Block[] = [];
  const paras: Para[] = [];
  const tables: TableBuilder[] = [];
  let pPrDepth = 0;
  let runDepth = 0;
  let fallbackDepth = 0;
  let inText = false;
  let preserve = false;
  let textBuf = '';

  const finishPara = (p: Para) => {
    const table = tables[tables.length - 1];
    let text = p.parts.join('');
    if (!text.trim() || (p.style && styles.isToc(p.style))) return;
    if (table?.cell) {
      table.cell.push(p.list ? `• ${text.trim()}` : text);
      return;
    }
    const level =
      p.outline != null ? (p.outline >= 0 && p.outline < 9 ? p.outline + 1 : null) : p.style ? styles.level(p.style) : null;
    if (level == null && p.list) text = `• ${text.trimStart()}`;
    blocks.push({ text, level });
  };

  for (const tok of xmlTokens(xml)) {
    if (tok.type === 'text') {
      if (inText && fallbackDepth === 0) textBuf += tok.text;
      continue;
    }
    const name = tok.local;
    if (name === 'Fallback') {
      if (tok.type === 'close') fallbackDepth--;
      else if (!tok.selfClosing) fallbackDepth++;
      continue;
    }
    if (fallbackDepth > 0) continue;
    const para = paras[paras.length - 1];
    const table = tables[tables.length - 1];

    if (tok.type === 'open') {
      switch (name) {
        case 'p':
          if (!tok.selfClosing) paras.push({ parts: [], style: null, outline: null, list: false });
          break;
        case 'pPr':
          if (!tok.selfClosing) pPrDepth++;
          break;
        case 'pStyle':
          if (para && pPrDepth === 1) para.style = attr(tok.attrs, 'val');
          break;
        case 'outlineLvl':
          if (para && pPrDepth === 1) para.outline = toInt(attr(tok.attrs, 'val'));
          break;
        case 'numPr':
          if (para && pPrDepth === 1) para.list = true;
          break;
        case 'r':
          if (!tok.selfClosing) runDepth++;
          break;
        case 't':
          if (!tok.selfClosing && pPrDepth === 0) {
            inText = true;
            preserve = attr(tok.attrs, 'space') === 'preserve';
            textBuf = '';
          }
          break;
        case 'tab':
        case 'ptab':
          if (para && runDepth > 0 && pPrDepth === 0) para.parts.push('\t');
          break;
        case 'br':
        case 'cr':
          if (para && runDepth > 0 && pPrDepth === 0) para.parts.push('\n');
          break;
        case 'noBreakHyphen':
          if (para && runDepth > 0) para.parts.push('-');
          break;
        case 'tbl':
          if (!tok.selfClosing) tables.push(new TableBuilder());
          break;
        case 'tr':
          table?.startRow();
          break;
        case 'tc':
          table?.startCell();
          break;
      }
    } else {
      switch (name) {
        case 'pPr':
          pPrDepth = Math.max(0, pPrDepth - 1);
          break;
        case 'r':
          runDepth = Math.max(0, runDepth - 1);
          break;
        case 't':
          if (inText) {
            para?.parts.push(preserve ? textBuf : textBuf.trim());
            inText = false;
          }
          break;
        case 'p': {
          const p = paras.pop();
          if (p) finishPara(p);
          break;
        }
        case 'tc':
          table?.endCell();
          break;
        case 'tr':
          table?.endRow();
          break;
        case 'tbl': {
          const done = tables.pop();
          if (!done || done.rows.length === 0) break;
          const outer = tables[tables.length - 1];
          if (outer?.cell) outer.cell.push(done.rows.join(' ; '));
          else blocks.push({ text: done.rows.join('\n'), level: null });
          break;
        }
      }
    }
  }
  return blocks;
}

export async function extractDocx(buf: Uint8Array): Promise<ExtractResult> {
  const files = readZip(buf, 'Word');
  const docPath = officeDocumentPath(files, 'word/document.xml');
  const xml = zipText(files, docPath);
  if (xml == null) throw new Error('הקובץ אינו מסמך Word תקין (חסר word/document.xml).');
  const stylesRel = readRels(files, docPath).find((r) => r.type.endsWith('/styles') && !r.external);
  const styles = parseStyles(zipText(files, stylesRel?.target ?? 'word/styles.xml'));

  const { chunks, outline } = buildSections(parseBody(xml, styles), {
    joiner: '\n',
    maxChars: 6000,
    fallbackBlocks: 12,
  });
  return {
    format: 'docx',
    chunks,
    pageCount: chunks.length,
    warnings: chunks.length === 0 ? ['לא נמצא טקסט במסמך'] : [],
    outline,
  };
}
