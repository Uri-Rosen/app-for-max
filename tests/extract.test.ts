import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import ExcelJS from 'exceljs';
import { extractFile, normHash } from '../server/importer/extract/index.ts';
import { fixVisualHebrew, normalizeText } from '../server/importer/hebrew.ts';

// ---------------------------------------------------------------------------
// Fixture builders (everything is generated in memory).

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

function relsXml(rels: Array<[id: string, type: string, target: string]>): string {
  return `${XML_DECL}<Relationships xmlns="${PKG_REL_NS}">${rels
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${REL_NS}/${type}" Target="${target}"/>`)
    .join('')}</Relationships>`;
}

function contentTypes(overrides: Array<[part: string, type: string]>): string {
  return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides
    .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
    .join('')}</Types>`;
}

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

// --- DOCX

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  `xmlns:r="${REL_NS}"`;

function wp(text: string, style?: string, extraPPr = ''): string {
  const pPr = style || extraPPr ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extraPPr}</w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function buildDocx(body: string, styles?: string): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml': contentTypes([
      ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    ]),
    '_rels/.rels': relsXml([['rId1', 'officeDocument', 'word/document.xml']]),
    'word/document.xml': `${XML_DECL}<w:document ${W_NS}><w:body>${body}<w:sectPr/></w:body></w:document>`,
  };
  if (styles) {
    files['word/styles.xml'] = `${XML_DECL}<w:styles ${W_NS}>${styles}</w:styles>`;
    files['word/_rels/document.xml.rels'] = relsXml([['rId1', 'styles', 'styles.xml']]);
  }
  return zip(files);
}

// Localized (Hebrew Word) style ids: "1"/"2" are headings only by their style *names*.
const HEBREW_STYLES =
  '<w:style w:type="paragraph" w:styleId="a"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:basedOn w:val="a"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/><w:basedOn w:val="a"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="MyChapter"><w:name w:val="My Chapter"/><w:basedOn w:val="1"/></w:style>';

// --- PPTX

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  `xmlns:r="${REL_NS}" ` +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const run = (t: string) => `<a:r><a:rPr lang="he-IL"/><a:t>${t}</a:t></a:r>`;

function shape(ph: string | null, paragraphs: string[]): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.map((p) => `<a:p>${p}</a:p>`).join('')}</p:txBody></p:sp>`
  );
}

function table(rows: string[][]): string {
  const cell = (t: string) => `<a:tc><a:txBody><a:bodyPr/><a:p>${t ? run(t) : ''}</a:p></a:txBody><a:tcPr/></a:tc>`;
  return (
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid/>' +
    rows.map((r) => `<a:tr h="1">${r.map(cell).join('')}</a:tr>`).join('') +
    '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
  );
}

function slideXml(content: string, root = 'sld'): string {
  return (
    `${XML_DECL}<p:${root} ${P_NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr/>${content}</p:spTree></p:cSld></p:${root}>`
  );
}

function buildPptx(): Uint8Array {
  return zip({
    '[Content_Types].xml': contentTypes([
      ['/ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
    ]),
    '_rels/.rels': relsXml([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    // Presentation order: slide2.xml, slide1.xml, slide3.xml — deliberately not file-name order.
    'ppt/presentation.xml':
      `${XML_DECL}<p:presentation ${P_NS}><p:sldIdLst>` +
      '<p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId4"/>' +
      '</p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': relsXml([
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'slide', 'slides/slide2.xml'],
      ['rId4', 'slide', 'slides/slide3.xml'],
    ]),
    'ppt/slides/slide2.xml': slideXml(
      shape('ctrTitle', [run('Intro')]) +
        shape(null, [run('First point'), `${run('Second')}<a:br/>${run('line')}`]) +
        table([
          ['מושג', 'הסבר'],
          ['ATP', 'מטבע אנרגיה'],
        ]) +
        shape('sldNum', [`<a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld>`]),
    ),
    'ppt/slides/_rels/slide2.xml.rels': relsXml([['rId1', 'notesSlide', '../notesSlides/notesSlide1.xml']]),
    'ppt/notesSlides/notesSlide1.xml': slideXml(
      shape('sldImg', []) +
        shape('body', [run('Remember this'), run('ומה שחשוב')]) +
        shape('sldNum', [`<a:fld id="{2}" type="slidenum"><a:t>1</a:t></a:fld>`]),
      'notes',
    ),
    'ppt/slides/slide1.xml': slideXml(
      shape('title', [run('שקופית שנייה')]) + shape('body', [run('A &amp; B &lt;C&gt; &#1513;&#x05DC;')]),
    ),
    'ppt/slides/slide3.xml': slideXml(''),
  });
}

// --- PDF (hand-written, with a correct xref table)

interface PdfOutlineItem {
  title: string;
  page?: number;
  named?: string;
}

function buildPdf(pages: Array<string | null>, outline: PdfOutlineItem[] = [], namedDests: Record<string, number> = {}): Uint8Array {
  const body: Record<number, string> = {};
  let next = 5;
  const pageIds = pages.map(() => {
    const ids = [next, next + 1];
    next += 2;
    return ids;
  });
  const outlineRoot = outline.length > 0 ? next++ : 0;
  const itemIds = outline.map(() => next++);
  const dests = Object.entries(namedDests)
    .map(([name, page]) => `/${name} [${pageIds[page - 1][0]} 0 R /Fit]`)
    .join(' ');

  body[1] =
    `<< /Type /Catalog /Pages 2 0 R` +
    (outlineRoot ? ` /Outlines ${outlineRoot} 0 R` : '') +
    (dests ? ` /Dests << ${dests} >>` : '') +
    ' >>';
  body[2] = `<< /Type /Pages /Kids [${pageIds.map(([p]) => `${p} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  body[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  // F2: codes 128–154 renamed to the Adobe glyph names of alef…tav (afii57664…), so pdf.js maps
  // them to Hebrew Unicode without an embedded font.
  body[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 32 /LastChar 154 ' +
    `/Widths [${Array(123).fill(600).join(' ')}] /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding ` +
    `/Differences [128 ${Array.from({ length: 27 }, (_, i) => `/afii${57664 + i}`).join(' ')}] >> >>`;
  pages.forEach((content, i) => {
    const [pageId, contentId] = pageIds[i];
    body[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = content ?? '';
    body[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  if (outlineRoot) {
    body[outlineRoot] = `<< /Type /Outlines /First ${itemIds[0]} 0 R /Last ${itemIds[itemIds.length - 1]} 0 R /Count ${outline.length} >>`;
    outline.forEach((item, i) => {
      const dest = item.named ? `/${item.named}` : `[${pageIds[(item.page ?? 1) - 1][0]} 0 R /Fit]`;
      const links = (i > 0 ? ` /Prev ${itemIds[i - 1]} 0 R` : '') + (i < outline.length - 1 ? ` /Next ${itemIds[i + 1]} 0 R` : '');
      body[itemIds[i]] = `<< /Title (${item.title}) /Parent ${outlineRoot} 0 R /Dest ${dest}${links} >>`;
    });
  }

  const count = next - 1;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id <= count; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${body[id]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= count; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out); // ASCII only, so string offsets are byte offsets
}

const PDF_PAGE_1 = [
  'BT /F1 24 Tf 72 720 Td (Cell Biology) Tj ET',
  'BT /F1 12 Tf 72 690 Td (ATP stores energy in cells.) Tj ET',
  'BT /F1 12 Tf 72 670 Td (Left) Tj 200 0 Td (Right) Tj ET',
].join('\n');
const PDF_PAGE_3 = 'BT /F1 12 Tf 72 720 Td (Mitochondria make ATP.) Tj ET';

/** Hex string for font F2: Hebrew letters → codes 128+, ASCII unchanged. */
function hebHex(s: string): string {
  return [...s]
    .map((ch) => {
      const c = ch.charCodeAt(0);
      return (c >= 0x05d0 && c <= 0x05ea ? 128 + (c - 0x05d0) : c).toString(16).padStart(2, '0');
    })
    .join('');
}

// Hebrew lines as a real RTL PDF draws them: glyphs laid out left-to-right in *visual* order
// (brackets already mirrored), plus one line drawn glyph-by-glyph from the right in logical order.
const PDF_HEBREW_PAGE = [
  `BT /F2 14 Tf 72 700 Td <${hebHex('םלוע םולש')}> Tj ET`,
  `BT /F2 14 Tf ${[...'שלום עולם'].map((ch, i) => `1 0 0 1 ${400 - i * 8.4} 660 Tm <${hebHex(ch)}> Tj`).join(' ')} ET`,
  `BT /F2 14 Tf 72 620 Td <${hebHex('בושח (ATP) את')}> Tj ET`,
  `BT /F2 14 Tf 72 580 Td <${hebHex('םיאת 123 שי')}> Tj ET`,
].join('\n');

function toWindows1255(s: string): Uint8Array {
  return Uint8Array.from(s, (ch) => {
    const c = ch.charCodeAt(0);
    if (c >= 0x05d0 && c <= 0x05ea) return 0xe0 + (c - 0x05d0);
    if (c < 0x80) return c;
    throw new Error(`unmapped ${ch}`);
  });
}

// ---------------------------------------------------------------------------

describe('extractFile dispatch', () => {
  it('rejects unsupported extensions with a Hebrew message', async () => {
    await expect(extractFile(strToU8('x'), 'notes.doc')).rejects.toThrow(/אינו נתמך/);
    await expect(extractFile(strToU8('x'), 'noext')).rejects.toThrow(/אינו נתמך/);
  });

  it('matches extensions case-insensitively', async () => {
    const res = await extractFile(strToU8('hello'), 'NOTES.TXT');
    expect(res.format).toBe('txt');
    expect(res.chunks[0].text).toBe('hello');
  });

  it('wraps corrupt files in a Hebrew error', async () => {
    await expect(extractFile(strToU8('not a zip'), 'x.docx')).rejects.toThrow(/לא ניתן לחלץ טקסט.*אינו קובץ Word תקין/);
    await expect(extractFile(strToU8('not a pdf'), 'x.pdf')).rejects.toThrow(/אינו PDF תקין/);
  });
});

describe('pdf', () => {
  const pdf = buildPdf(
    [PDF_PAGE_1, null, PDF_PAGE_3],
    [
      { title: 'Chapter One', page: 1 },
      { title: 'Chapter Two', named: 'chap2' },
    ],
    { chap2: 3 },
  );

  it('extracts one chunk per page, rebuilds lines, warns on pages without text', async () => {
    const res = await extractFile(pdf, 'lecture.pdf');
    expect(res.format).toBe('pdf');
    expect(res.pageCount).toBe(3);
    expect(res.chunks.map((c) => [c.locatorType, c.locatorNum, c.locatorLabel])).toEqual([
      ['page', 1, "עמ' 1"],
      ['page', 3, "עמ' 3"],
    ]);
    expect(res.chunks[0].text).toBe('Cell Biology\nATP stores energy in cells.\nLeft Right');
    expect(res.chunks[0].heading).toBe('Cell Biology');
    expect(res.chunks[1].text).toBe('Mitochondria make ATP.');
    expect(res.warnings).toEqual(["עמ' 2: אין שכבת טקסט — ייתכן שזו סריקה"]);
  });

  it('resolves outline destinations (explicit and named) to page numbers', async () => {
    const res = await extractFile(pdf, 'lecture.pdf');
    expect(res.outline).toEqual([
      { level: 1, text: 'Chapter One', locatorNum: 1 },
      { level: 1, text: 'Chapter Two', locatorNum: 3 },
    ]);
  });

  it('orders Hebrew text logically (word order, brackets, Latin and numbers)', async () => {
    const res = await extractFile(buildPdf([PDF_HEBREW_PAGE]), 'hebrew.pdf');
    expect(res.chunks[0].text).toBe('שלום עולם\nשלום עולם\nתא (ATP) חשוב\nיש 123 תאים');
    expect(res.chunks[0].heading).toBe('שלום עולם');
  });

  it('returns (does not throw) when every page is empty', async () => {
    const res = await extractFile(buildPdf([null]), 'scan.pdf');
    expect(res.chunks).toEqual([]);
    expect(res.pageCount).toBe(1);
    expect(res.warnings).toEqual(["עמ' 1: אין שכבת טקסט — ייתכן שזו סריקה"]);
  });

  it('leaves the input bytes untouched', async () => {
    const copy = pdf.slice();
    await extractFile(pdf, 'lecture.pdf');
    expect(pdf.byteLength).toBe(copy.byteLength);
    expect(Buffer.from(pdf).equals(Buffer.from(copy))).toBe(true);
  });
});

describe('pptx', () => {
  it('orders slides by presentation.xml, not by file name', async () => {
    const res = await extractFile(buildPptx(), 'deck.pptx');
    expect(res.format).toBe('pptx');
    expect(res.pageCount).toBe(3);
    expect(res.chunks.map((c) => [c.locatorNum, c.locatorLabel, c.heading])).toEqual([
      [1, 'שקופית 1', 'Intro'],
      [2, 'שקופית 2', 'שקופית שנייה'],
    ]);
    expect(res.outline).toEqual([
      { level: 1, text: 'Intro', locatorNum: 1 },
      { level: 1, text: 'שקופית שנייה', locatorNum: 2 },
    ]);
  });

  it('extracts body text, line breaks, tables and entities; skips slide-number placeholders', async () => {
    const res = await extractFile(buildPptx(), 'deck.pptx');
    expect(res.chunks[0].text).toBe('Intro\nFirst point\nSecond\nline\nמושג | הסבר\nATP | מטבע אנרגיה');
    expect(res.chunks[1].text).toBe('שקופית שנייה\nA & B <C> של');
  });

  it('extracts speaker notes without the slide number', async () => {
    const res = await extractFile(buildPptx(), 'deck.pptx');
    expect(res.chunks[0].notes).toBe('Remember this\nומה שחשוב');
    expect(res.chunks[1].notes).toBeNull();
  });

  it('warns about slides without text', async () => {
    const res = await extractFile(buildPptx(), 'deck.pptx');
    expect(res.warnings).toEqual(['שקופית 3: אין טקסט בשקופית']);
  });
});

describe('docx', () => {
  const body = [
    wp('מבוא לביולוגיה', '1'),
    `<w:p><w:r><w:t xml:space="preserve">התא הוא </w:t></w:r><w:r><w:t>יחידת החיים הבסיסית.</w:t></w:r></w:p>`,
    `<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>מונח</w:t><w:tab/><w:t>הגדרה</w:t><w:br/><w:t>שורה שנייה</w:t></w:r></w:p>`,
    wp('Mitochondria', 'Heading2'),
    wp('ATP נוצר במיטוכונדריה.'),
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>מושג</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>הסבר</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>ATP</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>מטבע אנרגיה</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:t>תיבת טקסט</w:t></mc:Choice><mc:Fallback><w:t>תיבת טקסט</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>',
    wp('פרק שני', 'MyChapter'),
    wp('תת נושא', undefined, '<w:outlineLvl w:val="2"/>'),
    wp('גוף הטקסט.'),
    `<w:p><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:delText>נמחק</w:delText></w:r></w:p>`,
  ].join('');

  it('splits sections at level-1/2 headings (localized style ids, basedOn, outlineLvl) and builds the outline', async () => {
    const res = await extractFile(buildDocx(body, HEBREW_STYLES), 'summary.docx');
    expect(res.format).toBe('docx');
    expect(res.chunks.map((c) => [c.locatorType, c.locatorNum, c.locatorLabel, c.heading])).toEqual([
      ['section', 1, 'סעיף 1', 'מבוא לביולוגיה'],
      ['section', 2, 'סעיף 2', 'Mitochondria'],
      ['section', 3, 'סעיף 3', 'פרק שני'],
    ]);
    expect(res.outline).toEqual([
      { level: 1, text: 'מבוא לביולוגיה', locatorNum: 1 },
      { level: 2, text: 'Mitochondria', locatorNum: 2 },
      { level: 1, text: 'פרק שני', locatorNum: 3 },
      { level: 3, text: 'תת נושא', locatorNum: 3 },
    ]);
    expect(res.pageCount).toBe(3);
  });

  it('keeps Hebrew text, runs, tabs, breaks and tables intact', async () => {
    const res = await extractFile(buildDocx(body, HEBREW_STYLES), 'summary.docx');
    expect(res.chunks[0].text).toBe('מבוא לביולוגיה\nהתא הוא יחידת החיים הבסיסית.\nמונח\tהגדרה\nשורה שנייה');
    expect(res.chunks[1].text).toBe('Mitochondria\nATP נוצר במיטוכונדריה.\nמושג | הסבר\nATP | מטבע אנרגיה\nתיבת טקסט');
    expect(res.chunks[2].text).toBe('פרק שני\nתת נושא\nגוף הטקסט.');
  });

  it('splits a heading-less document every ~12 paragraphs', async () => {
    const paras = Array.from({ length: 30 }, (_, i) => wp(`פסקה ${i + 1}`)).join('');
    const res = await extractFile(buildDocx(paras), 'plain.docx');
    expect(res.chunks.map((c) => c.text.split('\n').length)).toEqual([12, 12, 6]);
    expect(res.chunks.every((c) => c.heading === null)).toBe(true);
    expect(res.outline).toEqual([]);
  });
});

describe('xlsx', () => {
  async function buildXlsx(): Promise<Uint8Array> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('מושגים');
    ws.addRow(['מונח', 'הגדרה']);
    ws.addRow(['ATP', 'מטבע האנרגיה של התא']);
    ws.addRow([{ richText: [{ text: 'טקסט ' }, { text: 'עשיר', font: { bold: true } }] }, { formula: '1+1', result: 2 }]);
    ws.addRow([new Date(Date.UTC(2026, 9, 1)), 0.25]);
    ws.getCell('B4').numFmt = '0%';
    ws.getCell('A6').value = 'כותרת ממוזגת';
    ws.mergeCells('A6:C6');
    const big = wb.addWorksheet('Big');
    for (let i = 1; i <= 450; i++) big.addRow([`row ${i}`, i]);
    wb.addWorksheet('ריק');
    return new Uint8Array(await wb.xlsx.writeBuffer());
  }

  it('extracts sheets with names, rows and displayed values', async () => {
    const res = await extractFile(await buildXlsx(), 'terms.xlsx');
    expect(res.format).toBe('xlsx');
    expect(res.pageCount).toBe(3);
    const first = res.chunks[0];
    expect([first.locatorType, first.locatorNum, first.locatorLabel, first.heading]).toEqual([
      'sheet',
      1,
      "גיליון 'מושגים'",
      'מושגים',
    ]);
    expect(first.text).toBe(
      'מונח | הגדרה\nATP | מטבע האנרגיה של התא\nטקסט עשיר | 2\n01/10/2026 | 25%\nכותרת ממוזגת',
    );
    expect(res.outline.map((o) => o.text)).toEqual(['מושגים', 'Big', 'ריק']);
    expect(res.warnings).toEqual(["גיליון 'ריק': הגיליון ריק"]);
  });

  it('splits sheets over 200 rows', async () => {
    const res = await extractFile(await buildXlsx(), 'terms.xlsx');
    const big = res.chunks.filter((c) => c.heading === 'Big');
    expect(big.map((c) => [c.locatorNum, c.locatorLabel])).toEqual([
      [2, "גיליון 'Big' שורות 1–200"],
      [2, "גיליון 'Big' שורות 201–400"],
      [2, "גיליון 'Big' שורות 401–450"],
    ]);
    expect(big[2].text.split('\n')[0]).toBe('row 401 | 401');
  });
});

describe('text formats', () => {
  it('detects the csv delimiter (semicolon, with commas and quoted delimiters in values)', async () => {
    const csv = 'שם;ציון;הערה\nדני;3,5;"טוב; מאוד"\nרות;4;מצוין\n';
    const res = await extractFile(strToU8(csv), 'grades.csv');
    expect(res.format).toBe('csv');
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0]).toMatchObject({ locatorType: 'sheet', locatorNum: 1, locatorLabel: "גיליון 'grades'" });
    expect(res.chunks[0].text).toBe('שם | ציון | הערה\nדני | 3,5 | טוב; מאוד\nרות | 4 | מצוין');
  });

  it('detects tab and comma delimiters', async () => {
    expect((await extractFile(strToU8('a\tb\r\n1\t2\r\n'), 't.csv')).chunks[0].text).toBe('a | b\n1 | 2');
    expect((await extractFile(strToU8('x,y\n"1,5",2\n"say ""hi""",3'), 'c.csv')).chunks[0].text).toBe(
      'x | y\n1,5 | 2\nsay "hi" | 3',
    );
  });

  it('falls back to windows-1255 for non-UTF-8 text', async () => {
    const res = await extractFile(toWindows1255('שלום עולם\r\nשורה שנייה'), 'old.txt');
    expect(res.chunks[0].text).toBe('שלום עולם\nשורה שנייה');
  });

  it('packs txt paragraphs into chunks of at most ~1,500 characters', async () => {
    const paras = Array.from({ length: 20 }, (_, i) => `פסקה ${i + 1}: ${'מילה '.repeat(40).trim()}`);
    const res = await extractFile(strToU8(paras.join('\n\n')), 'notes.txt');
    expect(res.chunks.length).toBeGreaterThan(1);
    expect(res.chunks.every((c) => c.text.length <= 1500)).toBe(true);
    expect(res.chunks.map((c) => c.text).join('\n\n')).toBe(paras.join('\n\n'));
    expect(res.chunks.map((c) => c.locatorLabel)).toEqual(res.chunks.map((_, i) => `סעיף ${i + 1}`));
  });

  it('splits markdown at headings and ignores # inside code fences', async () => {
    const md = '# פרק א\nמבוא קצר.\n\n```py\n# not a heading\n```\n\n## סעיף משנה\nתוכן.\n\n# פרק ב\nסוף.\n';
    const res = await extractFile(strToU8(md), 'notes.md');
    expect(res.chunks.map((c) => c.heading)).toEqual(['פרק א', 'סעיף משנה', 'פרק ב']);
    expect(res.chunks[0].text).toBe('פרק א\n\nמבוא קצר.\n\n```py\n# not a heading\n```');
    expect(res.outline).toEqual([
      { level: 1, text: 'פרק א', locatorNum: 1 },
      { level: 2, text: 'סעיף משנה', locatorNum: 2 },
      { level: 1, text: 'פרק ב', locatorNum: 3 },
    ]);
  });
});

describe('hebrew helpers', () => {
  it('fixes a reversed (visual-order) Hebrew line', () => {
    expect(fixVisualHebrew('םלוע םולש')).toBe('שלום עולם');
  });

  it('keeps Latin words and numbers readable when fixing a mixed line', () => {
    const fixed = fixVisualHebrew('םימעפ 123 םיאתב רצונ ATP');
    expect(fixed).toBe('ATP נוצר בתאים 123 פעמים');
    expect(fixVisualHebrew('10% םיאתב')).toBe('בתאים 10%');
    expect(fixVisualHebrew('םולש (ATP) םלוע')).toBe('עולם (ATP) שלום');
  });

  it('leaves logical and ambiguous lines alone', () => {
    for (const line of ['שלום עולם, ATP 123', 'אבג דהו', 'Plain English line', 'מים חיים ומלך']) {
      expect(fixVisualHebrew(line)).toBe(line);
    }
  });

  it('normalizeText strips bidi/zero-width marks and tidies whitespace', () => {
    expect(normalizeText('\u200Fשלום\u00A0עולם\u200B  \r\n\n\n\nשורה\u202A\u202C \n')).toBe('שלום עולם\n\nשורה');
  });

  it('normHash ignores whitespace, niqqud, punctuation, case and quote/dash variants', () => {
    expect(normHash('שָׁלוֹם,  עוֹלָם!')).toBe(normHash('שלום עולם'));
    expect(normHash('צה״ל')).toBe(normHash('צה"ל'));
    expect(normHash('בית\u05BEספר')).toBe(normHash('בית-ספר'));
    expect(normHash('ATP  is\n energy.')).toBe(normHash('atp is energy'));
    expect(normHash('ATP is energy')).not.toBe(normHash('ADP is energy'));
    expect(normHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});
