// XLSX → one chunk per sheet (long sheets split every 200 rows).

import ExcelJS from 'exceljs';
import type { Cell } from 'exceljs';
import type { ExtractedChunk, ExtractResult, OutlineEntry } from '../types.ts';
import { normalizeText } from '../hebrew.ts';
import { assertOfficeZip } from './index.ts';

const ROWS_PER_CHUNK = 200;

const pad2 = (n: number) => String(n).padStart(2, '0');

function stripFormatLiterals(fmt: string): string {
  return fmt.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
}

function isDateFormat(fmt: string | undefined): boolean {
  return !!fmt && /[dmyhs]/i.test(stripFormatLiterals(fmt)) && !/general/i.test(fmt);
}

function formatDate(d: Date, fmt: string | undefined): string {
  const f = stripFormatLiterals(fmt ?? '').toLowerCase();
  const date = `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  const hasTime = d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || /h/.test(f);
  if (/h/.test(f) && !/[dy]/.test(f)) return time;
  return hasTime ? `${date} ${time}` : date;
}

function formatNumber(n: number, fmt: string | undefined): string {
  const f = stripFormatLiterals(fmt ?? '');
  if (isDateFormat(fmt)) {
    // Excel serial date (1900 system) → UTC date, as exceljs does for plain date cells.
    return formatDate(new Date(Math.round((n - 25569) * 86400000)), fmt);
  }
  const decimals = /\.(0+)/.exec(f)?.[1].length;
  if (f.includes('%')) {
    const v = n * 100;
    return `${decimals != null ? v.toFixed(decimals) : String(Number(v.toPrecision(12)))}%`;
  }
  if (decimals != null) return n.toFixed(decimals);
  return String(Number(n.toPrecision(12)));
}

function valueText(v: unknown, fmt: string | undefined): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return formatNumber(v, fmt);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : formatDate(v, fmt);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) {
      return o.richText.map((r: unknown) => String((r as { text?: unknown }).text ?? '')).join('');
    }
    if ('formula' in o || 'sharedFormula' in o) return valueText(o.result, fmt);
    if ('error' in o) return String(o.error ?? '');
    if ('text' in o) return valueText(o.text, fmt);
  }
  return String(v);
}

function cellText(cell: Cell): string {
  if (cell.type === ExcelJS.ValueType.Merge) return '';
  return valueText(cell.value, cell.numFmt).replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export async function extractXlsx(buf: Uint8Array): Promise<ExtractResult> {
  assertOfficeZip(buf, 'Excel');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf.slice().buffer);

  const chunks: ExtractedChunk[] = [];
  const outline: OutlineEntry[] = [];
  const warnings: string[] = [];
  const sheets = wb.worksheets;

  sheets.forEach((ws, i) => {
    const index = i + 1;
    const name = ws.name;
    outline.push({ level: 1, text: name, locatorNum: index });

    const rows: Array<{ num: number; cells: string[] }> = [];
    ws.eachRow({ includeEmpty: false }, (row, num) => {
      const cells: string[] = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push(cellText(row.getCell(c)));
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (cells.length > 0) rows.push({ num, cells });
    });
    if (rows.length === 0) {
      warnings.push(`גיליון '${name}': הגיליון ריק`);
      return;
    }
    // Drop leading columns that are empty in every row.
    const firstCol = Math.min(...rows.map((r) => r.cells.findIndex((c) => c !== '')));
    const lines = rows.map((r) => ({ num: r.num, text: r.cells.slice(firstCol).join(' | ') }));

    const split = lines.length > ROWS_PER_CHUNK;
    for (let start = 0; start < lines.length; start += ROWS_PER_CHUNK) {
      const part = lines.slice(start, start + ROWS_PER_CHUNK);
      const label = split
        ? `גיליון '${name}' שורות ${part[0].num}–${part[part.length - 1].num}`
        : `גיליון '${name}'`;
      chunks.push({
        locatorType: 'sheet',
        locatorNum: index,
        locatorLabel: label,
        heading: name,
        text: normalizeText(part.map((l) => l.text).join('\n')),
        notes: null,
      });
    }
  });

  if (sheets.length === 0) warnings.push('לא נמצאו גיליונות בקובץ');
  return { format: 'xlsx', chunks, pageCount: sheets.length, warnings, outline };
}
