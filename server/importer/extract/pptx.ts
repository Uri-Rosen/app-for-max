// PPTX → one chunk per slide, in presentation order, with speaker notes.

import type { ExtractedChunk, ExtractResult, OutlineEntry } from '../types.ts';
import { normalizeText } from '../hebrew.ts';
import { attr, officeDocumentPath, readRels, readZip, TableBuilder, xmlTokens, zipText } from './index.ts';
import type { ZipFiles } from './index.ts';

const TITLE_PH = new Set(['title', 'ctrTitle']);
const NOISE_PH = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);

interface TextBlock {
  /** Placeholder type of the containing shape, or null for free shapes / tables. */
  ph: string | null;
  text: string;
}

/** Text of every DrawingML paragraph (and table) in a slide/notes/diagram part, in document order. */
function parseDrawingText(xml: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  const shapes: Array<{ ph: string | null }> = [];
  const tables: TableBuilder[] = [];
  let para: string[] | null = null;
  let inText = false;
  let fallbackDepth = 0;

  for (const tok of xmlTokens(xml)) {
    if (tok.type === 'text') {
      if (inText && para && fallbackDepth === 0) para.push(tok.text);
      continue;
    }
    const name = tok.local;
    if (name === 'Fallback') {
      if (tok.type === 'close') fallbackDepth--;
      else if (!tok.selfClosing) fallbackDepth++;
      continue;
    }
    if (fallbackDepth > 0) continue;
    const shape = shapes[shapes.length - 1];
    const table = tables[tables.length - 1];

    if (tok.type === 'open') {
      switch (name) {
        case 'sp':
          if (!tok.selfClosing) shapes.push({ ph: null });
          break;
        case 'ph':
          if (shape) shape.ph = attr(tok.attrs, 'type') ?? 'obj';
          break;
        case 'p':
          if (!tok.selfClosing) para = [];
          break;
        case 't':
          if (!tok.selfClosing) inText = true;
          break;
        case 'br':
          para?.push('\n');
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
        case 't':
          inText = false;
          break;
        case 'p':
          if (para) {
            const text = para.join('');
            para = null;
            if (table?.cell) table.cell.push(text);
            else blocks.push({ ph: shape?.ph ?? null, text });
          }
          break;
        case 'sp':
          shapes.pop();
          break;
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
          else blocks.push({ ph: shape?.ph ?? null, text: done.rows.join('\n') });
          break;
        }
      }
    }
  }
  return blocks;
}

function slideOrder(files: ZipFiles, presPath: string, presXml: string): Array<string | null> {
  const rels = new Map(readRels(files, presPath).map((r) => [r.id, r]));
  const order: Array<string | null> = [];
  let inList = false;
  for (const tok of xmlTokens(presXml)) {
    if (tok.type === 'close' && tok.local === 'sldIdLst') inList = false;
    if (tok.type !== 'open') continue;
    if (tok.local === 'sldIdLst') inList = !tok.selfClosing;
    else if (inList && tok.local === 'sldId') {
      const rid = attr(tok.attrs, 'id', true);
      const rel = rid ? rels.get(rid) : undefined;
      order.push(rel && !rel.external ? rel.target : null);
    }
  }
  return order;
}

export async function extractPptx(buf: Uint8Array): Promise<ExtractResult> {
  const files = readZip(buf, 'PowerPoint');
  const presPath = officeDocumentPath(files, 'ppt/presentation.xml');
  const presXml = zipText(files, presPath);
  if (presXml == null) throw new Error('הקובץ אינו מצגת PowerPoint תקינה (חסר ppt/presentation.xml).');

  const slides = slideOrder(files, presPath, presXml);
  const chunks: ExtractedChunk[] = [];
  const outline: OutlineEntry[] = [];
  const warnings: string[] = [];

  slides.forEach((slidePath, i) => {
    const n = i + 1;
    const xml = slidePath ? zipText(files, slidePath) : null;
    if (xml == null || !slidePath) {
      warnings.push(`שקופית ${n}: השקופית חסרה בקובץ`);
      return;
    }
    const rels = readRels(files, slidePath);
    const blocks = parseDrawingText(xml).filter((b) => !(b.ph && NOISE_PH.has(b.ph)));
    for (const rel of rels) {
      if (rel.external || !rel.type.endsWith('/diagramData')) continue;
      const dataXml = zipText(files, rel.target);
      if (dataXml) blocks.push(...parseDrawingText(dataXml).map((b) => ({ ph: null, text: b.text })));
    }

    const title = blocks
      .filter((b) => b.ph && TITLE_PH.has(b.ph))
      .map((b) => b.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const text = normalizeText(blocks.map((b) => b.text).join('\n'));

    let notes = '';
    const notesRel = rels.find((r) => !r.external && r.type.endsWith('/notesSlide'));
    const notesXml = notesRel ? zipText(files, notesRel.target) : null;
    if (notesXml) {
      notes = normalizeText(
        parseDrawingText(notesXml)
          .filter((b) => !(b.ph && NOISE_PH.has(b.ph)))
          .map((b) => b.text)
          .join('\n'),
      );
    }

    if (!text && !notes) {
      warnings.push(`שקופית ${n}: אין טקסט בשקופית`);
      return;
    }
    chunks.push({
      locatorType: 'slide',
      locatorNum: n,
      locatorLabel: `שקופית ${n}`,
      heading: title || null,
      text,
      notes: notes || null,
    });
    if (title) outline.push({ level: 1, text: title, locatorNum: n });
  });

  if (slides.length === 0) warnings.push('לא נמצאו שקופיות במצגת');
  return { format: 'pptx', chunks, pageCount: slides.length, warnings, outline };
}
