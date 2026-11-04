/**
 * Document Generator — binary file generation for the agent document tools
 * (create_document / update_document / fill_pdf_form in tool-executor.ts).
 *
 * Pure-JS only (xlsx / docx / pdf-lib — no native deps), so it runs identically
 * in the prod Alpine container and in tests. Every generator returns BOTH the
 * binary buffer AND a plain-text rendering (textContent) so read_document and
 * the Files page never have to decode the binary again.
 *
 * Safety caps mirror the upload path: content is capped at 500k chars and the
 * decoded buffer at 15 MB — the agent's JSON tool args ride the model's context,
 * so anything bigger is almost certainly a runaway generation.
 */

import ExcelJS from 'exceljs';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
} from 'docx';
import {
  PDFDocument, StandardFonts, rgb,
} from 'pdf-lib';
import logger from '../../utils/logger';
import { excelCellToText } from './text-extract';

export interface GeneratedDoc {
  buffer: Buffer;
  textContent: string;
  mimeType: string;
  format: string;
}

const ALLOWED_FORMATS = ['txt', 'md', 'csv', 'json', 'xlsx', 'docx', 'pdf'] as const;
type AllowedFormat = (typeof ALLOWED_FORMATS)[number];

const MAX_CONTENT_CHARS = 500_000;
const MAX_BUFFER_BYTES = 15 * 1024 * 1024;
const MAX_SHEETS = 20;
const MAX_SHEET_ROWS = 50_000;

// Form operations PARSE an untrusted input PDF (uploads can be up to 50MB;
// pdf-lib inflates object streams in memory) — cap the input and bound the
// parse time so a hostile/pathological PDF can't pin the event loop for the
// whole request (adversarial review M3).
const MAX_INPUT_PDF_BYTES = 15 * 1024 * 1024;
const PDF_PARSE_TIMEOUT_MS = 20_000;

function assertInputPdfSize(template: Buffer): void {
  if (template.length > MAX_INPUT_PDF_BYTES) {
    throw new Error(
      `Input PDF too large for form operations (${(template.length / 1024 / 1024).toFixed(1)}MB > 15MB cap). Use a smaller PDF.`
    );
  }
}

/**
 * Bound a pdf-lib parse/flatten pipeline to PDF_PARSE_TIMEOUT_MS.
 *
 * HONEST LIMITATION: pdf-lib's parsing is synchronous CPU work between awaits
 * — once a synchronous parse step has started, this race cannot preempt it.
 * What it DOES guarantee is that the awaited load/flatten path as a whole
 * (which yields to the event loop between async steps) returns a tool error
 * instead of hanging the tool call indefinitely on a pathological PDF. A truly
 * single-tick CPU bomb would need a worker thread to interrupt — out of scope
 * here; the 15MB input cap above keeps the worst case bounded.
 */
async function withPdfParseTimeout<T>(what: string, work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${PDF_PARSE_TIMEOUT_MS / 1000}s — the PDF is too complex to process. Use a smaller or simpler PDF.`)),
      PDF_PARSE_TIMEOUT_MS
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const MIME_BY_FORMAT: Record<AllowedFormat, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
};

function inferFormat(filename: string, explicit?: string): AllowedFormat {
  const raw = (explicit || filename.split('.').pop() || '').toLowerCase().trim();
  if ((ALLOWED_FORMATS as readonly string[]).includes(raw)) return raw as AllowedFormat;
  // An HTML page / app is not a downloadable document here — it renders as an html CANVAS block (the Files viewer
  // shows it live). Name that route in the refusal so the model does not guess again (2026-10-04 suite: a "make me
  // a landing page" turn spent a create_document call on format "html" before falling back to a canvas).
  const htmlHint = /^x?html?$/.test(raw)
    ? ' For an HTML page or app, write it in your answer as a [CANVAS:type=html,title=…]…[/CANVAS] block instead — it renders live in the Files viewer.'
    : '';
  throw new Error(
    `Unsupported document format "${raw || '(none)'}" — allowed: ${ALLOWED_FORMATS.join(', ')}. ` +
    'Pass an explicit format or use a filename with one of those extensions.' + htmlHint
  );
}

function assertContentSize(content: string): void {
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(`Document content too large (${content.length} chars > ${MAX_CONTENT_CHARS} cap). Split it into smaller files.`);
  }
}

function assertBufferSize(buffer: Buffer): void {
  if (buffer.length > MAX_BUFFER_BYTES) {
    throw new Error(`Generated file too large (${(buffer.length / 1024 / 1024).toFixed(1)}MB > 15MB cap). Reduce the content and retry.`);
  }
}

// ── XLSX (exceljs — replaces SheetJS xlsx, ticket 3be57df0) ───────────────────
//
// The `xlsx` (SheetJS CE) package is unmaintained on npm and carries two HIGH
// advisories with no registry fix (GHSA-4r6h-8v6p-xvw6 prototype pollution,
// GHSA-5pgg-2g8v-p4x9 ReDoS) that OSV-based scanners flag on EVERY version,
// including the vendor-CDN builds. exceljs (MIT, maintained, zero advisories)
// replaces it for both the write path (here) and the read path
// (text-extract.ts). The old API surface mapped cleanly; the one intentional
// behavior change: this is now async (exceljs serializes to a Promise).

type SheetRows = (string | number | boolean | null)[][];

/** Numeric-looking strings become real numbers so spreadsheet cells aren't text-typed. */
function castCell(cell: string | number | boolean | null): string | number | boolean | null {
  if (typeof cell === 'string' && cell.trim() !== '' && !isNaN(Number(cell))) {
    return Number(cell);
  }
  return cell;
}

/** Excel sheet names: max 31 chars, no []:*?/\ — sanitize before use. */
function safeSheetName(name: string): string {
  return (name || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
}

function buildWorkbook(sheets: { name: string; rows: SheetRows }[]): ExcelJS.Workbook {
  if (sheets.length > MAX_SHEETS) {
    throw new Error(`Too many sheets (${sheets.length} > ${MAX_SHEETS} cap). Split the data across multiple files.`);
  }
  const wb = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    if (sheet.rows.length > MAX_SHEET_ROWS) {
      throw new Error(`Sheet "${sheet.name}" has too many rows (${sheet.rows.length} > ${MAX_SHEET_ROWS} cap). Split it across multiple files.`);
    }
    const ws = wb.addWorksheet(safeSheetName(sheet.name));
    for (const row of sheet.rows.map(r => r.map(castCell))) {
      ws.addRow(row);
    }
  }
  return wb;
}

function workbookText(wb: ExcelJS.Workbook): string {
  const parts: string[] = [];
  wb.eachSheet((ws) => {
    const lines: string[] = [];
    // includeEmpty keeps blank interior rows as blank TSV lines (SheetJS's
    // sheet_to_csv rendered the full used range); excelCellToText renders
    // object cells (formula/hyperlink/rich text) and Dates as flat text —
    // both shared with the upload read path (reviewer findings 1/2/4).
    ws.eachRow({ includeEmpty: true }, (row) => {
      // row.values is CellValue[] | keyed-object; in the array shape it is
      // 1-indexed ([0] is undefined) — drop the padding.
      const vals = row.values;
      const cells = Array.isArray(vals)
        ? vals.slice(1).map((v) => excelCellToText(v))
        : Object.keys(vals).map((k) => `${k}=${vals[k]}`);
      lines.push(cells.join('\t'));
    });
    const tsv = lines.join('\n');
    if (tsv.trim().length > 0) parts.push(`[Sheet: ${ws.name}]\n${tsv.trim()}`);
  });
  return parts.join('\n\n');
}

async function generateXlsx(opts: GenerateOpts): Promise<GeneratedDoc> {
  let wb: ExcelJS.Workbook;
  if (opts.sheets && opts.sheets.length > 0) {
    wb = buildWorkbook(opts.sheets);
  } else {
    // Parse plain content lines into Sheet1: tab-separated when the line has a
    // tab, else comma-separated (a CSV paste lands in cells, not one column).
    const rows: SheetRows = (opts.content ?? '').split(/\r?\n/).map(line =>
      line.split(line.includes('\t') ? '\t' : ',')
    );
    wb = buildWorkbook([{ name: 'Sheet1', rows }]);
  }
  const arrayBuffer = await wb.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer as ArrayBuffer);
  return { buffer, textContent: workbookText(wb), mimeType: MIME_BY_FORMAT.xlsx, format: 'xlsx' };
}

// ── DOCX ──────────────────────────────────────────────────────────────────────

/**
 * Ticket c0fb822a — markdown-aware DOCX rendering. Everyday users asked for
 * "nice looking pretty docx" without hand-prompting: a create_document whose
 * content uses plain markdown (headings #/##/###, **bold** / *italic* /
 * `code`, - bullets, 1. numbered lists, | tables |, > quotes) now renders
 * styled — bold runs, real heading levels, bulleted/numbered lists, bordered
 * tables, indented quotes. Non-markdown text degrades to exactly the old
 * plain-paragraph shape (blank lines split paragraphs), so existing callers
 * see no diff unless they opt into markdown.
 */
interface DocxRun { text: string; bold?: boolean; italics?: boolean; code?: boolean }

/** Split one line of text into styled runs on **bold**, *italic*, `code`. */
function parseInlineMarkdown(line: string): DocxRun[] {
  const runs: DocxRun[] = [];
  // **bold** first (longest fence), then *italic*, then `code`.
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) runs.push({ text: line.slice(last, idx) });
    const tok = m[0];
    if (tok.startsWith('**')) runs.push({ text: tok.slice(2, -2), bold: true });
    else if (tok.startsWith('`')) runs.push({ text: tok.slice(1, -1), code: true });
    else runs.push({ text: tok.slice(1, -1), italics: true });
    last = idx + tok.length;
  }
  if (last < line.length) runs.push({ text: line.slice(last) });
  return runs.length ? runs : [{ text: line }];
}

const docxRuns = (runs: DocxRun[]): TextRun[] =>
  runs.map((r) => new TextRun({
    text: r.text,
    ...(r.bold ? { bold: true } : {}),
    ...(r.italics ? { italics: true } : {}),
    ...(r.code ? { font: 'Consolas' } : {}),
  }));

/** Does the content LOOK like markdown (any styled construct present)? */
function looksLikeMarkdown(content: string): boolean {
  return /^#{1,3}\s/m.test(content)
    || /\*\*[^*]+\*\*/.test(content)
    || /^\s*[-*]\s+\S/m.test(content)
    || /^\s*\d+\.\s+\S/m.test(content)
    || /^\s*\|.*\|\s*$/m.test(content)
    || /^>\s+\S/m.test(content);
}

function markdownToDocxChildren(content: string): Paragraph[] {
  const out: Paragraph[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(new Paragraph({
        children: docxRuns(parseInlineMarkdown(heading[2])),
        heading: level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
      }));
      i += 1;
      continue;
    }
    // Table block: | a | b | with an optional |---|---| separator next line.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const headerCells = cells(line);
      const sep = lines[i + 1] ?? '';
      const hasSep = /^\s*\|[\s:|-]+\|\s*$/.test(sep);
      const tableRows: string[][] = [];
      let j = i + (hasSep ? 2 : 1);
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) {
        tableRows.push(cells(lines[j]));
        j += 1;
      }
      out.push(renderDocxTable(headerCells, tableRows));
      i = j;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      out.push(new Paragraph({ children: docxRuns(parseInlineMarkdown(bullet[1])), bullet: { level: 0 } }));
      i += 1;
      continue;
    }
    const numbered = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (numbered) {
      out.push(new Paragraph({ children: docxRuns(parseInlineMarkdown(numbered[2])), numbering: { reference: 'md-numbered', level: 0 } }));
      i += 1;
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      out.push(new Paragraph({
        children: docxRuns(parseInlineMarkdown(quote[1])),
        indent: { left: 720 },
        spacing: { before: 80, after: 80 },
      }));
      i += 1;
      continue;
    }
    // Blank line → paragraph separator; single newline stays inline (old rule).
    if (!line.trim()) { i += 1; continue; }
    // Plain paragraph: fold consecutive non-blank, non-construct lines.
    const para: string[] = [line];
    let k = i + 1;
    while (
      k < lines.length && lines[k].trim()
      && !/^(#{1,3})\s/.test(lines[k])
      && !/^\s*[-*]\s+\S/.test(lines[k])
      && !/^\s*\d+\.\s+\S/.test(lines[k])
      && !/^\s*\|.*\|\s*$/.test(lines[k])
      && !/^>\s?\S/.test(lines[k])
    ) { para.push(lines[k]); k += 1; }
    out.push(new Paragraph({ children: docxRuns(parseInlineMarkdown(para.join(' '))) }));
    i = k;
  }
  return out.length ? out : [new Paragraph('')];
}

const tableBorder = { style: 'single' as const, size: 1, color: '999999' };

function renderDocxTable(headerCells: string[], rows: string[][]): Paragraph {
  // A table cannot nest in a Paragraph — emit it via the section-children array
  // by returning a marker; simplest correct shape: return the table AS an any
  // (the docx Document accepts Table instances in section children).
  return new (require('docx').Table)({
    rows: [
      new (require('docx').TableRow)({
        tableHeader: true,
        children: headerCells.map((c) => new (require('docx').TableCell)({
          children: [new Paragraph({ children: [new TextRun({ text: c, bold: true })] })],
          shading: { fill: 'F2F2F2' },
          borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
        })),
      }),
      ...rows.map((r) => new (require('docx').TableRow)({
        children: headerCells.map((_, ci) => new (require('docx').TableCell)({
          children: [new Paragraph({ children: docxRuns(parseInlineMarkdown(r[ci] ?? '')) })],
          borders: { top: tableBorder, bottom: tableBorder, left: tableBorder, right: tableBorder },
        })),
      })),
    ],
    width: { size: 100, type: 'pct' },
  }) as unknown as Paragraph;
}

async function generateDocx(opts: GenerateOpts): Promise<GeneratedDoc> {
  const children: Array<Paragraph | any> = [];
  if (opts.title) {
    children.push(new Paragraph({ text: opts.title, heading: HeadingLevel.HEADING_1 }));
  }
  const content = opts.content ?? '';
  // Markdown-aware rendering (c0fb822a): only when the content actually uses a
  // markdown construct — plain text keeps the exact pre-existing shape.
  if (looksLikeMarkdown(content)) {
    children.push(...markdownToDocxChildren(content));
  } else {
    // Blank lines split paragraphs (markdown-style); single newlines stay inline.
    const paragraphs = content.split(/\r?\n\s*\r?\n/);
    for (const para of paragraphs) {
      children.push(new Paragraph({ children: [new TextRun(para.replace(/\r?\n/g, ' '))] }));
    }
  }
  const doc = new Document({
    numbering: {
      config: [{
        reference: 'md-numbered',
        levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'start' }],
      }],
    },
    sections: [{ children: children.length > 0 ? children : [new Paragraph('')] }],
  });
  const buffer = await Packer.toBuffer(doc);
  const textContent = [opts.title ? `# ${opts.title}` : '', ...content.split(/\r?\n\s*\r?\n/)].filter(Boolean).join('\n\n');
  return { buffer, textContent, mimeType: MIME_BY_FORMAT.docx, format: 'docx' };
}

// ── PDF ───────────────────────────────────────────────────────────────────────

/**
 * pdf-lib standard fonts are WinAnsi-encoded — any character outside that code
 * page makes encodeText throw. Replace unsupported chars with '?' so PDF
 * generation NEVER fails on emoji/CJK (the agent can always produce text).
 */
function toWinAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');
}

function wrapLine(line: string, maxChars: number): string[] {
  if (line.length <= maxChars) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

async function generatePdf(opts: GenerateOpts): Promise<GeneratedDoc> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // US Letter, 50pt margins, 11pt body at ~95 chars/line.
  const pageSize: [number, number] = [612, 792];
  const margin = 50;
  const bodySize = 11;
  const lineHeight = bodySize * 1.4;
  const maxChars = 95;

  let page = pdf.addPage(pageSize);
  let y = pageSize[1] - margin;
  const newPage = () => {
    page = pdf.addPage(pageSize);
    y = pageSize[1] - margin;
  };
  const ensureSpace = (needed: number) => {
    if (y - needed < margin) newPage();
  };

  if (opts.title) {
    ensureSpace(24);
    page.drawText(toWinAnsi(opts.title), { x: margin, y, size: 16, font: bold, color: rgb(0, 0, 0) });
    y -= 24;
  }

  const rawLines = toWinAnsi(opts.content ?? '').split(/\r?\n/);
  for (const raw of rawLines) {
    if (!raw.trim()) {
      y -= lineHeight; // blank line → vertical gap
      ensureSpace(lineHeight);
      continue;
    }
    for (const line of wrapLine(raw, maxChars)) {
      ensureSpace(lineHeight);
      page.drawText(line, { x: margin, y, size: bodySize, font, color: rgb(0, 0, 0) });
      y -= lineHeight;
    }
  }

  const buffer = Buffer.from(await pdf.save());
  const textContent = [opts.title ?? '', opts.content ?? ''].filter(Boolean).join('\n\n');
  return { buffer, textContent, mimeType: MIME_BY_FORMAT.pdf, format: 'pdf' };
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface GenerateOpts {
  filename: string;
  format?: string;
  content?: string;
  sheets?: { name: string; rows: (string | number | boolean | null)[][] }[];
  title?: string;
}

export async function generateDocument(opts: GenerateOpts): Promise<GeneratedDoc> {
  const format = inferFormat(opts.filename, opts.format);
  const content = opts.content ?? '';
  assertContentSize(content);
  if (opts.title) assertContentSize(opts.title);

  let doc: GeneratedDoc;
  switch (format) {
    case 'txt':
    case 'md':
      doc = { buffer: Buffer.from(content, 'utf8'), textContent: content, mimeType: MIME_BY_FORMAT[format], format };
      break;
    case 'csv':
      if (!content.trim()) {
        throw new Error('CSV content is empty — provide at least a header row.');
      }
      doc = { buffer: Buffer.from(content, 'utf8'), textContent: content, mimeType: MIME_BY_FORMAT.csv, format };
      break;
    case 'json': {
      let pretty: string;
      try {
        pretty = JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        throw new Error('Invalid JSON content — the content string is not parseable JSON. Fix it and retry.');
      }
      doc = { buffer: Buffer.from(pretty, 'utf8'), textContent: pretty, mimeType: MIME_BY_FORMAT.json, format };
      break;
    }
    case 'xlsx':
      doc = await generateXlsx(opts);
      break;
    case 'docx':
      doc = await generateDocx(opts);
      break;
    case 'pdf':
      doc = await generatePdf(opts);
      break;
  }
  assertBufferSize(doc.buffer);
  logger.info(`DocumentGenerator: generated ${opts.filename} (${format}, ${doc.buffer.length} bytes, text ${doc.textContent.length} chars)`);
  return doc;
}

/**
 * Fill an AcroForm PDF. Unknown field names are collected into `missing`
 * (never thrown) so the agent can report exactly what didn't match.
 */
export async function fillPdfForm(
  template: Buffer,
  fields: Record<string, string>
): Promise<{ buffer: Buffer; filled: string[]; missing: string[] }> {
  assertInputPdfSize(template);
  return withPdfParseTimeout('Filling the PDF form', async () => {
    const pdf = await PDFDocument.load(template, { ignoreEncryption: true });
    const form = pdf.getForm();
    const filled: string[] = [];
    const missing: string[] = [];

    for (const [name, value] of Object.entries(fields)) {
      let handled = false;
      try {
        form.getTextField(name).setText(value);
        handled = true;
      } catch { /* not a text field */ }
      if (!handled) {
        try {
          const dropdown = form.getDropdown(name);
          if (dropdown.getOptions().includes(value)) {
            dropdown.select(value);
            handled = true;
          }
        } catch { /* not a dropdown */ }
      }
      if (!handled) {
        try {
          const box = form.getCheckBox(name);
          if (/^(true|yes|1|on)$/i.test(value.trim())) box.check();
          else box.uncheck();
          handled = true;
        } catch { /* not a checkbox */ }
      }
      if (!handled) {
        try {
          form.getRadioGroup(name).select(value);
          handled = true;
        } catch { /* not a radio group */ }
      }
      if (handled) filled.push(name);
      else missing.push(name);
    }

    form.flatten();
    const buffer = Buffer.from(await pdf.save());
    assertBufferSize(buffer);
    return { buffer, filled, missing };
  });
}

/** List the AcroForm field names + types of a PDF (for read_document on forms). */
export async function listPdfFormFields(template: Buffer): Promise<{ name: string; type: string }[]> {
  assertInputPdfSize(template);
  return withPdfParseTimeout('Listing the PDF form fields', async () => {
    const pdf = await PDFDocument.load(template, { ignoreEncryption: true });
    return pdf.getForm().getFields().map(f => ({ name: f.getName(), type: f.constructor.name }));
  });
}
