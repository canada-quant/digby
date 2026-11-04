/**
 * extractXlsxText fidelity regression — ticket 3be57df0 (2026-10-13).
 *
 * The adversarial review of the xlsx→exceljs migration found that the ported
 * suite only round-trips exceljs-written files, which never contain the cell
 * types real user uploads have (formulas, hyperlinks, rich text, dates) — so
 * it could not see String(v) rendering them as "[object Object]" or a 63-char
 * Date dump. These tests build fixtures WITH those cell types and pin the
 * flat-text rendering (excelCellToText) on BOTH surfaces:
 *   - the upload read path (extractXlsxText — feeds chat context / RAG)
 *   - the generator's textContent side-channel (workbookText)
 * plus the never-throw guarantees (finding 3: valid-zip non-spreadsheet;
 * finding 4: blank interior rows keep their line position).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// pdf-extract's import graph reaches config/env (process.exit on missing
// vars) and the provider seat-call chain — not under test here.
jest.mock('./pdf-extract', () => ({
  __esModule: true,
  extractPdfText: async () => '',
}));

import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph } from 'docx';
import { extractXlsxText, excelCellToText } from './text-extract';
import { generateDocument } from './document-generator';

/** Build an xlsx buffer carrying the cell types exceljs round-trips never
 *  produce from plain addRow arrays: formula, hyperlink, rich text, date. */
async function buildRichFixture(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  // Plain cells (row 1) — the only kind the old suite exercised.
  ws.getCell('A1').value = 'Month';
  ws.getCell('B1').value = 'Total';
  // Formula cell with a cached result (row 2): the classic spreadsheet shape.
  ws.getCell('A2').value = 'Sum';
  ws.getCell('B2').value = { formula: 'B4+B4', result: 2700 };
  // Hyperlink cell (row 3): renders the label, not the URL, not [object Object].
  ws.getCell('A3').value = { text: 'click here', hyperlink: 'https://digby.example.com' };
  // Rich-text cell (row 4): concatenated runs.
  ws.getCell('A4').value = { richText: [{ text: 'bo' }, { text: 'ld' }] };
  // Date cell (row 5): short ISO date, not the Date.toString() dump.
  ws.getCell('A5').value = new Date(Date.UTC(2026, 9, 13));
  // Boolean cell (row 6): TRUE/FALSE like SheetJS's CSV shape.
  ws.getCell('A6').value = true;
  // Blank interior row (7) then a value (8) — position must survive.
  ws.getCell('A8').value = 'after-gap';
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('extractXlsxText — exceljs fidelity (reviewer findings 1–4, ticket 3be57df0)', () => {
  it('renders formula, hyperlink, rich-text, date and boolean cells as flat text', async () => {
    const text = await extractXlsxText(await buildRichFixture());
    expect(text).toContain('[Sheet: S]');
    // F1 (MAJOR): formula cell → cached result, never [object Object].
    expect(text).toContain('2700');
    expect(text).not.toContain('[object Object]');
    // F1: hyperlink → its label.
    expect(text).toContain('click here');
    // F1: rich text → concatenated runs.
    expect(text).toContain('bold');
    // F2: date → short ISO form, not the 63-char Date.toString() dump.
    expect(text).toContain('2026-10-13');
    expect(text).not.toContain('GMT+0000');
    // Boolean renders TRUE (SheetJS CSV shape), not 'true'.
    expect(text).toMatch(/(^|\t)TRUE(\t|$)/m);
  });

  it('keeps blank interior rows as blank TSV lines (row position survives)', async () => {
    const text = await extractXlsxText(await buildRichFixture());
    // Row 7 is blank and row 8 follows it — a blank line must sit between
    // the row-6 and row-8 renderings (SheetJS rendered the full used range).
    expect(text).toMatch(/TRUE\n\nafter-gap/);
  });

  it('a valid zip that is NOT a spreadsheet returns an explicit note, not silent empty', async () => {
    // A docx is a valid OOXML zip with no xl/workbook.xml — exceljs resolves
    // the load with zero worksheets (finding 3).
    const docxBuffer = await Packer.toBuffer(new Document({
      sections: [{ children: [new Paragraph('hello')] }],
    }));
    const text = await extractXlsxText(Buffer.from(docxBuffer));
    expect(text).toBe('[XLSX: no worksheets found — not a spreadsheet?]');
  });

  it('legacy binary .xls (not a zip) still hits the never-throw catch with the re-save note', async () => {
    const biff8Magic = Buffer.from('d0cf11e0a1b11ae1', 'hex');
    const text = await extractXlsxText(biff8Magic);
    expect(text).toBe('[XLSX: text extraction failed — if this is a legacy .xls file, re-save it as .xlsx and re-upload]');
  });

  it('excelCellToText unit shape: shared formula results, error cells, nulls', () => {
    expect(excelCellToText(null)).toBe('');
    expect(excelCellToText(undefined)).toBe('');
    expect(excelCellToText(42)).toBe('42');
    expect(excelCellToText(false)).toBe('FALSE');
    expect(excelCellToText({ sharedFormula: 'B2', result: 99 })).toBe('99');
    expect(excelCellToText({ formula: 'A1+A2' })).toBe('A1+A2'); // no cached result
    expect(excelCellToText({ error: '#REF!' })).toBe('#REF!');
    expect(excelCellToText({ hyperlink: 'https://x.example' })).toBe('https://x.example');
    expect(excelCellToText({})).toBe('');
    expect(excelCellToText(new Date(Date.UTC(2026, 0, 2)))).toBe('2026-01-02');
  });
});

describe('generateDocument xlsx textContent — same formatter on the write-path side channel', () => {
  it('renders booleans as TRUE/FALSE and keeps blank interior rows (finding 4)', async () => {
    const doc = await generateDocument({
      filename: 's.xlsx',
      sheets: [{ name: 'S', rows: [['a'], [], ['c']] }],
    });
    expect(doc.textContent).toContain('[Sheet: S]');
    expect(doc.textContent).toMatch(/a\n\nc/);
  });

  it('boolean cells render TRUE (not false) in textContent', async () => {
    const doc = await generateDocument({
      filename: 'b.xlsx',
      sheets: [{ name: 'S', rows: [[true, false]] }],
    });
    expect(doc.textContent).toMatch(/TRUE\tFALSE/);
  });
});
