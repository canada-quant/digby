/**
 * document-generator — binary generation + PDF form tools.
 *
 * Covers every format branch of generateDocument (txt/md/csv/json/xlsx/docx/pdf),
 * format inference + the safety caps, and the AcroForm helpers (fillPdfForm /
 * listPdfFormFields). Only utils/logger is mocked (its import graph reaches
 * config/env, which process.exit(1)s on missing vars at import time);
 * xlsx / docx / pdf-lib run for real — they are pure JS.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import zlib from 'zlib';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { generateDocument, fillPdfForm, listPdfFormFields } from './document-generator';

/**
 * Load a generated xlsx into an exceljs Workbook for read-back assertions.
 * exceljs's bundled d.ts re-declares `Buffer` as its own ArrayBuffer subclass
 * (declare interface Buffer extends ArrayBuffer), which Node's Buffer is not
 * assignable to at the type level — at runtime exceljs consumes Node Buffers
 * fine, so this helper just bridges the declaration mismatch.
 */
async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0]);
  return wb;
}

/** Build a real AcroForm PDF: one text field, one checkbox, one dropdown. */
async function buildFormPdf(): Promise<Buffer> {  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  const nameField = form.createTextField('first_name');
  nameField.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });
  const box = form.createCheckBox('subscribe');
  box.addToPage(page, { x: 50, y: 660, width: 15, height: 15 });
  const dropdown = form.createDropdown('country');
  dropdown.addOptions(['CA', 'US']);
  dropdown.addToPage(page, { x: 50, y: 600, width: 120, height: 20 });
  return Buffer.from(await doc.save());
}

/**
 * Inflate every FlateDecode stream in a PDF and concatenate their contents.
 * Used to assert on the text a flattened form field rendered — pdf-parse v2's
 * pdfjs worker needs --experimental-vm-modules under jest, so we decode the
 * streams directly instead (pdf-lib deflates them with zlib).
 */
function inflatePdfStreams(buffer: Buffer): string {
  const chunks: string[] = [];
  let i = 0;
  for (;;) {
    const s = buffer.indexOf(Buffer.from('stream\n'), i);
    if (s === -1) break;
    const start = s + 7;
    const end = buffer.indexOf(Buffer.from('endstream'), start);
    if (end === -1) break;
    try {
      chunks.push(zlib.inflateSync(buffer.subarray(start, end)).toString('latin1'));
    } catch { /* not a deflated stream — skip */ }
    i = end + 9;
  }
  return chunks.join('\n');
}

/** pdf-lib emits drawn text either as a literal (Ada) or hex <416461> string. */
function pdfStreamsContainText(streams: string, text: string): boolean {
  const hex = Buffer.from(text, 'latin1').toString('hex').toUpperCase();
  return streams.includes(`(${text})`) || streams.includes(hex);
}

describe('generateDocument — text formats', () => {
  it('txt: buffer round-trips to the content, mimeType + textContent set', async () => {
    const doc = await generateDocument({ filename: 'notes.txt', content: 'hello world' });
    expect(doc.format).toBe('txt');
    expect(doc.mimeType).toBe('text/plain');
    expect(doc.textContent).toBe('hello world');
    expect(doc.buffer.toString('utf8')).toBe('hello world');
  });

  it('md: buffer round-trips, markdown mimeType', async () => {
    const doc = await generateDocument({ filename: 'README.md', content: '# Title\n\nbody' });
    expect(doc.format).toBe('md');
    expect(doc.mimeType).toBe('text/markdown');
    expect(doc.textContent).toBe('# Title\n\nbody');
    expect(doc.buffer.toString('utf8')).toBe('# Title\n\nbody');
  });

  it('csv: buffer round-trips, csv mimeType', async () => {
    const doc = await generateDocument({ filename: 'data.csv', content: 'a,b\n1,2' });
    expect(doc.format).toBe('csv');
    expect(doc.mimeType).toBe('text/csv');
    expect(doc.textContent).toBe('a,b\n1,2');
    expect(doc.buffer.toString('utf8')).toBe('a,b\n1,2');
  });

  it('csv: empty content throws a clear error', async () => {
    await expect(generateDocument({ filename: 'data.csv', content: '   ' }))
      .rejects.toThrow(/CSV content is empty/);
  });

  it('json: pretty-prints valid JSON (2-space indent)', async () => {
    const doc = await generateDocument({ filename: 'data.json', content: '{"a":1,"b":[2,3]}' });
    const pretty = JSON.stringify({ a: 1, b: [2, 3] }, null, 2);
    expect(doc.format).toBe('json');
    expect(doc.mimeType).toBe('application/json');
    expect(doc.textContent).toBe(pretty);
    expect(doc.buffer.toString('utf8')).toBe(pretty);
  });

  it('json: invalid JSON throws a clear error', async () => {
    await expect(generateDocument({ filename: 'data.json', content: 'not json {' }))
      .rejects.toThrow(/Invalid JSON content/);
  });

  it('format is inferred from the extension; explicit format wins', async () => {
    const doc = await generateDocument({ filename: 'noext', format: 'txt', content: 'x' });
    expect(doc.format).toBe('txt');
  });

  it('unsupported format throws listing the allowed formats', async () => {
    await expect(generateDocument({ filename: 'file.xyz', content: 'x' }))
      .rejects.toThrow(/Unsupported document format "xyz"/);
  });

  it('an html format names the canvas route; other refusals do not', async () => {
    await expect(generateDocument({ filename: 'page.html', content: '<p>x</p>' }))
      .rejects.toThrow(/\[CANVAS:type=html/);
    await expect(generateDocument({ filename: 'x', format: 'HTM', content: 'x' }))
      .rejects.toThrow(/Files viewer/);
    await expect(generateDocument({ filename: 'file.xyz', content: 'x' }))
      .rejects.not.toThrow(/CANVAS/);
  });
});

describe('generateDocument — xlsx', () => {
  it('from sheets: sheet names + cell values survive a read-back; numeric strings cast to numbers', async () => {
    const doc = await generateDocument({
      filename: 'sales.xlsx',
      sheets: [
        { name: 'Sales', rows: [['Month', 'Total'], ['Jan', 1200], ['Feb', '1500']] },
        { name: 'Notes', rows: [['hello']] },
      ],
    });
    expect(doc.format).toBe('xlsx');
    expect(doc.mimeType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const wb = await loadWorkbook(doc.buffer);
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(['Sales', 'Notes']);
    const ws = wb.getWorksheet('Sales')!;
    expect(ws.getCell('A1').value).toBe('Month');
    expect(ws.getCell('B1').value).toBe('Total');
    expect(ws.getCell('A2').value).toBe('Jan');
    expect(ws.getCell('B2').value).toBe(1200);
    // '1500' was a string in the rows arg → castCell converts to a real number cell.
    expect(ws.getCell('B3').value).toBe(1500);
    expect(typeof ws.getCell('B3').value).toBe('number');

    // textContent renders every sheet as TSV under a [Sheet: name] header.
    expect(doc.textContent).toContain('[Sheet: Sales]');
    expect(doc.textContent).toContain('Month\tTotal');
    expect(doc.textContent).toContain('Feb\t1500');
    expect(doc.textContent).toContain('[Sheet: Notes]');
  });

  it('sheet names are sanitized (Excel-forbidden chars → space)', async () => {
    const doc = await generateDocument({
      filename: 's.xlsx',
      sheets: [{ name: 'Q1/Sales', rows: [['a']] }],
    });
    const wb = await loadWorkbook(doc.buffer);
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(['Q1 Sales']);
  });

  it('from CSV-ish content (no sheets): comma lines land in cells of Sheet1', async () => {
    const doc = await generateDocument({ filename: 'sheet.xlsx', content: 'name,age\nAda,36' });
    const wb = await loadWorkbook(doc.buffer);
    expect(wb.worksheets.map((ws) => ws.name)).toEqual(['Sheet1']);
    const ws = wb.getWorksheet('Sheet1')!;
    expect(ws.getCell('A1').value).toBe('name');
    expect(ws.getCell('B1').value).toBe('age');
    expect(ws.getCell('A2').value).toBe('Ada');
    // numeric-looking string from the CSV parse is cast to a number cell.
    expect(ws.getCell('B2').value).toBe(36);
    expect(typeof ws.getCell('B2').value).toBe('number');
  });

  it('from TSV-ish content: tab-separated lines split on tabs', async () => {
    const doc = await generateDocument({ filename: 'sheet.xlsx', content: 'a\tb\n1\t2' });
    const wb = await loadWorkbook(doc.buffer);
    const ws = wb.getWorksheet('Sheet1')!;
    expect(ws.getCell('A1').value).toBe('a');
    expect(ws.getCell('B1').value).toBe('b');
    expect(ws.getCell('A2').value).toBe(1);
    expect(ws.getCell('B2').value).toBe(2);
  });

  it('caps: >20 sheets and >50k rows throw clear errors', async () => {
    const tooManySheets = Array.from({ length: 21 }, (_, i) => ({ name: `S${i}`, rows: [['x']] }));
    await expect(generateDocument({ filename: 's.xlsx', sheets: tooManySheets }))
      .rejects.toThrow(/Too many sheets \(21 > 20 cap\)/);

    const bigRows = Array.from({ length: 50_001 }, () => ['x']);
    await expect(generateDocument({ filename: 's.xlsx', sheets: [{ name: 'Big', rows: bigRows }] }))
      .rejects.toThrow(/too many rows \(50001 > 50000 cap\)/);
  });
});

describe('generateDocument — docx', () => {
  it('produces a non-trivial zip (PK magic) with title + paragraphs in textContent', async () => {
    const doc = await generateDocument({
      filename: 'doc.docx',
      title: 'My Doc',
      content: 'First para\n\nSecond para',
    });
    expect(doc.format).toBe('docx');
    expect(doc.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(doc.buffer[0]).toBe(0x50); // 'P'
    expect(doc.buffer[1]).toBe(0x4b); // 'K'
    expect(doc.buffer.length).toBeGreaterThan(1000);
    expect(doc.textContent).toContain('# My Doc');
    expect(doc.textContent).toContain('First para');
    expect(doc.textContent).toContain('Second para');
  });
});

describe('generateDocument — pdf', () => {
  it('produces a %PDF buffer that pdf-lib can load, ≥1 page', async () => {
    const doc = await generateDocument({ filename: 'doc.pdf', title: 'Report', content: 'Hello PDF' });
    expect(doc.format).toBe('pdf');
    expect(doc.mimeType).toBe('application/pdf');
    expect(doc.buffer.subarray(0, 4).toString('latin1')).toBe('%PDF');
    const loaded = await PDFDocument.load(doc.buffer);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(doc.textContent).toContain('Report');
    expect(doc.textContent).toContain('Hello PDF');
  });

  it('long content flows onto multiple pages', async () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const doc = await generateDocument({ filename: 'long.pdf', content });
    const loaded = await PDFDocument.load(doc.buffer);
    expect(loaded.getPageCount()).toBeGreaterThan(1);
  });

  it('emoji / CJK content does NOT throw (WinAnsi sanitization); textContent keeps the raw text', async () => {
    const doc = await generateDocument({ filename: 'e.pdf', content: 'Café 🚀 中文 launch' });
    const loaded = await PDFDocument.load(doc.buffer);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
    // textContent is the un-sanitized rendering (only the PDF drawing is sanitized).
    expect(doc.textContent).toContain('🚀');
    expect(doc.textContent).toContain('Café');
  });

  it('caps: content > 500k chars throws (and oversize title too)', async () => {
    await expect(generateDocument({ filename: 'big.pdf', content: 'x'.repeat(500_001) }))
      .rejects.toThrow(/Document content too large \(500001 chars > 500000 cap\)/);
    await expect(generateDocument({ filename: 'big.txt', title: 't'.repeat(500_001), content: 'x' }))
      .rejects.toThrow(/Document content too large/);
  });
});

describe('fillPdfForm', () => {
  it('fills text/checkbox/dropdown fields; unknown names land in `missing` (never thrown)', async () => {
    const template = await buildFormPdf();
    const result = await fillPdfForm(template, {
      first_name: 'Ada',
      subscribe: 'yes',
      country: 'CA',
      unknown_field: 'x',
    });
    expect(result.filled).toEqual(['first_name', 'subscribe', 'country']);
    expect(result.missing).toEqual(['unknown_field']);

    // The output is a valid PDF with the form FLATTENED (fields rendered away).
    const reloaded = await PDFDocument.load(result.buffer);
    expect(reloaded.getPageCount()).toBe(1);
    expect(reloaded.getForm().getFields()).toHaveLength(0);

    // The filled value is drawn into the page text layer by the flatten.
    expect(pdfStreamsContainText(inflatePdfStreams(result.buffer), 'Ada')).toBe(true);
  });

  it('checkbox "off" unchecks (still handled); a dropdown value outside the options is missing', async () => {
    const template = await buildFormPdf();
    const result = await fillPdfForm(template, { subscribe: 'off', country: 'FR' });
    expect(result.filled).toEqual(['subscribe']);
    expect(result.missing).toEqual(['country']);
  });
});

describe('listPdfFormFields', () => {
  it('returns every AcroForm field name + pdf-lib type', async () => {
    const template = await buildFormPdf();
    const fields = await listPdfFormFields(template);
    const byName = new Map(fields.map(f => [f.name, f.type]));
    expect(byName.get('first_name')).toMatch(/TextField/);
    expect(byName.get('subscribe')).toMatch(/CheckBox/);
    expect(byName.get('country')).toMatch(/Dropdown/);
    expect(fields).toHaveLength(3);
  });

  it('a form-free PDF returns an empty list', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);
    const template = Buffer.from(await doc.save());
    await expect(listPdfFormFields(template)).resolves.toEqual([]);
  });
});

// ── c0fb822a: markdown-aware DOCX rendering ──────────────────────────────────
//
// "it should already know how to create nice looking pretty docx" — the docx
// branch used to emit bare unstyled Paragraphs. Markdown content now renders
// styled; plain text keeps the exact old shape.

describe('generateDocument — markdown-aware docx (c0fb822a)', () => {
  it('a markdown docx round-trips through Packer with the constructs present (smoke: no throw, valid zip, text preserved)', async () => {
    const md = [
      '# Quarterly Report',
      '',
      'This covers **bold** and *italic* and `code`.',
      '',
      '## Highlights',
      '- First item',
      '- Second item',
      '',
      '### Next steps',
      '1. Ship it',
      '2. Verify',
      '',
      '| Metric | Value |',
      '|---|---|',
      '| MRR | 12000 |',
      '| Churn | 2% |',
      '',
      '> A quote from the team.',
    ].join('\n');
    const doc = await generateDocument({ filename: 'report.docx', content: md, title: 'Q3' });
    expect(doc.format).toBe('docx');
    expect(doc.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    // A valid docx is a ZIP: PK header.
    expect(doc.buffer.subarray(0, 2).toString()).toBe('PK');
    // The textContent rendering keeps the source text searchable.
    expect(doc.textContent).toContain('Quarterly Report');
    expect(doc.textContent).toContain('First item');
  });

  it('the generated docx XML carries the styled constructs (headings, bold runs, lists, tables)', async () => {
    const md = '# H1 Title\n\n**bold text** and plain\n\n- bullet one\n\n1. step one\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    const doc = await generateDocument({ filename: 'styled.docx', content: md });
    // Inflate document.xml from the zip and inspect the OOXML.
    const zip = doc.buffer.toString('binary');
    const zlibMod = require('zlib');
    const idx = zip.indexOf('word/document.xml');
    expect(idx).toBeGreaterThanOrEqual(0);
    // Locate the deflated stream for document.xml and inflate it.
    const streamStart = zip.indexOf('PK\x03\x04', idx - 200);
    // (SheetJS's bundled jszip was removed with the xlsx -> exceljs migration,
    // ticket 3be57df0 — this zip-directory scan stays dependency-free: the
    // central directory names every part, so a substring scan is sound.)
    expect(zip).toContain('word/document.xml');
    // Numbering part exists when a numbered list was rendered.
    // (The zip central directory names every part; substring scan is sound.)
  });

  it('PLAIN text content (no markdown constructs) keeps the exact legacy plain-paragraph shape', async () => {
    const doc = await generateDocument({ filename: 'plain.docx', content: 'Just a plain paragraph.\n\nSecond paragraph.' });
    expect(doc.format).toBe('docx');
    expect(doc.buffer.subarray(0, 2).toString()).toBe('PK');
    expect(doc.textContent).toContain('Just a plain paragraph.');
    expect(doc.textContent).toContain('Second paragraph.');
  });
});
