/**
 * Upload text extraction — shared extractors (factored out of
 * upload.controller.ts 2026-08-31, no behavior change).
 *
 * Two consumers:
 *   - upload.controller.ts processUpload — staging-time extraction for model
 *     context / RAG (applies its own per-family char caps at the call site).
 *   - chat-files.controller.ts previewTextChatFile — the
 *     /files/:fileId/preview-text route backing the Files panel's in-panel
 *     preview modal (applies its own cap + truncated flag).
 *
 * Every extractor NEVER throws: a failure logs a warning and returns the same
 * fallback string the old inline blocks produced ('' for PDF, a bracketed
 * note for docx/xlsx). Char capping is deliberately the CALLER's job — the
 * upload path caps docx/text at 50K and xlsx at 20K, the preview route at
 * 50K with a truncated flag.
 */

import logger from '../../utils/logger';
import { extractPdfText } from './pdf-extract';

/**
 * PDF → layout-faithful text (pdf-extract.ts: vision OCR for
 * layout-sensitive/scanned docs, pdf-parse baseline). '' on failure.
 */
export async function extractPdfUploadText(buffer: Buffer, filename: string): Promise<string> {
  try {
    return await extractPdfText(buffer, filename);
  } catch (e) {
    logger.warn('PDF text extraction failed for chat upload:', e);
    return '';
  }
}

/** DOCX → raw text via mammoth. Bracketed failure note on error. */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value as string;
  } catch (e) {
    logger.warn('mammoth DOCX extraction failed:', e);
    return '[DOCX text extraction failed]';
  }
}

/** Render one exceljs CellValue as flat text for TSV output — shared by this
 * read path and document-generator's textContent (adversarial-review findings
 * 1+2 on the 3be57df0 exceljs migration).
 *
 * exceljs yields OBJECTS for the most common real-world cell types — formula
 * ({formula, result}), shared formula ({sharedFormula, result}), hyperlink
 * ({text, hyperlink}), rich text ({richText}), error ({error}) — and Date
 * objects for date cells. Plain String(v) renders those as "[object Object]"
 * or a 63-char Date dump; SheetJS rendered the cached result / link label /
 * concatenated rich text / a short date, and this restores that. Booleans
 * render TRUE/FALSE (SheetJS's CSV shape).
 */
export function excelCellToText(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'object') {
    const cell = v as {
      richText?: { text?: string }[];
      text?: string;
      hyperlink?: string;
      result?: unknown;
      formula?: string;
      error?: unknown;
    };
    if (Array.isArray(cell.richText)) return cell.richText.map((r) => r.text ?? '').join('');
    if (typeof cell.text === 'string') return cell.text; // hyperlink label
    if (typeof cell.hyperlink === 'string') return cell.hyperlink;
    if (cell.result !== undefined && cell.result !== null) return excelCellToText(cell.result);
    if (typeof cell.formula === 'string') return cell.formula; // no cached result: the formula text
    if (cell.error !== undefined) return String(cell.error);
    return '';
  }
  return String(v);
}

/** XLSX → all sheets as TSV text ([Sheet: name] blocks), via exceljs.
 *
 * Replaces SheetJS `xlsx` (ticket 3be57df0): that package is unmaintained on
 * npm with two HIGH advisories (GHSA-4r6h-8v6p-xvw6 prototype pollution when
 * reading crafted files — THIS function is the exposure, it parses user
 * uploads — and GHSA-5pgg-2g8v-p4x9 ReDoS) and no registry fix exists; OSV
 * flags every version including the vendor-CDN builds. exceljs only reads
 * OOXML (xlsx), so legacy binary .xls now returns the same never-throw
 * fallback note telling the user to re-save as .xlsx.
 */
export async function extractXlsxText(buffer: Buffer): Promise<string> {
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    // A valid zip that is NOT a spreadsheet (e.g. a docx mislabeled
    // application/vnd.ms-excel) loads zero worksheets — say so instead of
    // silently returning '' (reviewer finding 3). Never throws.
    if (!wb.worksheets.length) {
      return '[XLSX: no worksheets found — not a spreadsheet?]';
    }
    const sheetTexts: string[] = [];
    wb.eachSheet((ws: any) => {
      const lines: string[] = [];
      // includeEmpty keeps blank interior rows as blank TSV lines — SheetJS's
      // sheet_to_csv rendered the full used range (reviewer finding 4).
      ws.eachRow({ includeEmpty: true }, (row: any) => {
        // row.values is 1-indexed ([0] is undefined) — drop the padding cell.
        const cells = row.values.slice(1).map((v: any) => excelCellToText(v));
        lines.push(cells.join('\t'));
      });
      const tsv = lines.join('\n');
      if (tsv.trim().length > 0) {
        sheetTexts.push(`[Sheet: ${ws.name}]\n${tsv.trim()}`);
      }
    });
    return sheetTexts.join('\n\n');
  } catch (e) {
    logger.warn('xlsx extraction failed:', e);
    return '[XLSX: text extraction failed — if this is a legacy .xls file, re-save it as .xlsx and re-upload]';
  }
}

/** Plain text, CSV, JSON, XML, Markdown → utf-8 (latin1 fallback). */
export function extractPlainText(buffer: Buffer): string {
  try {
    return buffer.toString('utf-8');
  } catch {
    return buffer.toString('latin1');
  }
}
