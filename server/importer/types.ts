// Contract between file extractors and the rest of the importer.

import type { LocatorType } from '../../shared/types.ts';

export interface ExtractedChunk {
  locatorType: LocatorType;
  /** 1-based page / slide / sheet / section number. */
  locatorNum: number;
  /** Hebrew display label: "עמ' 3", "שקופית 4", "גיליון 'מושגים'", "סעיף 2". */
  locatorLabel: string;
  /** Slide title, nearest document heading, or sheet name. */
  heading: string | null;
  /** Normalized text: paragraphs separated by '\n', no trailing spaces, no empty runs of lines. */
  text: string;
  /** Speaker notes for slides. */
  notes: string | null;
}

export interface OutlineEntry {
  level: number;
  text: string;
  locatorNum: number;
}

export interface ExtractResult {
  format: 'pdf' | 'pptx' | 'docx' | 'xlsx' | 'txt' | 'csv' | 'md';
  chunks: ExtractedChunk[];
  /** Pages / slides / sheets in the file, including ones that produced no text. */
  pageCount: number;
  /** Hebrew, human-readable: e.g. "עמ' 4: אין שכבת טקסט — ייתכן שזו סריקה". */
  warnings: string[];
  /** Headings in document order — used to suggest topics. */
  outline: OutlineEntry[];
}

export const SUPPORTED_EXTENSIONS = ['.pdf', '.pptx', '.docx', '.xlsx', '.txt', '.csv', '.md'] as const;
