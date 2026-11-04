/**
 * PDF text extraction — SOTA, layout-faithful.
 *
 * Shared by upload.controller.ts (chat attachments) and ingestion.service.ts /
 * documents.controller.ts (RAG), mcp-search.ts (PDFs found by web search) and
 * google-mcp.ts (Drive files). Because extraction happens once, upstream of the
 * answering model, fixing it here fixes PDF quality for EVERY path.
 *
 * Strategy (tiered):
 *   1. pdf-parse (pdfjs) — fast, free baseline. Good for prose, but it FLATTENS
 *      tables: column structure is lost, so a row with values in only some columns
 *      (e.g. a bank statement: Date | Description | Withdrawals | Deposits | Balance)
 *      collapses to ambiguous linear text and the answering model can't tell which
 *      column a number belongs to → "hallucinated numbers from bank statements"
 *      (the exact bug this module fixes). pdf-parse also returns NOTHING for
 *      scanned/image-based PDFs (no text layer).
 *   2. Vision OCR on the PDF READER seat (model role `pdf_ocr`; built-in default
 *      glm-5.3-flash on Z.AI at reasoning_effort "low" — correct on every table
 *      cell in the 2026-09-22 live comparison, handles merged cells, cheap) — for
 *      documents small enough to be layout-sensitive (statements/invoices/
 *      receipts/forms) OR any PDF with no extractable text layer (scanned).
 *      The Z.AI GLM built-ins take the WHOLE PDF natively (a `file` content part,
 *      data URI); every other vision model gets the pages RENDERED TO PNG
 *      server-side (pdf-parse's getScreenshot over @napi-rs/canvas — no native
 *      toolchain), one page per call. The prompt asks for Markdown tables and
 *      HTML <table> only where cells are merged (colspan/rowspan), so numbers
 *      keep their column. Chain: the seat's model → its custom fallback → the
 *      built-in default (deepseek-flash, thinking off, is the recommended
 *      different-vendor fallback), then pdf-parse.
 *
 * History: Gemini (gemini-3.1-flash-lite, inline PDF) served this tier until
 * 2026-09-22, when the owner removed every frontier model — the seat replaces it
 * and is admin-editable (Account → Admin → Endpoints → Model roles → "PDF reader
 * (OCR)"). If the seat cannot be served or OCR fails, we fall back to pdf-parse
 * so extraction never hard-fails.
 */

import logger from '../../utils/logger';
import { ProviderConfig } from './coding/coding-model';
import { imageUrlPart, providerKeyMissing, seatCompletion, seatProviderChain, warnSeatFailure } from './seat-call';

export const PDF_OCR_ROLE = 'pdf_ocr';
export const PDF_OCR_DEFAULT_MODEL = 'glm-5.3-flash';

// Keep OCR bounded. Statements / invoices / receipts / forms — the documents where
// layout actually matters — are small. Large prose PDFs (reports, books) linearize
// fine via pdf-parse and would blow up vision token cost / risk output truncation.
const OCR_MAX_BYTES = 15 * 1024 * 1024; // 15 MB raw
const OCR_MAX_PAGES = 10;
// Below this, pdf-parse effectively found no text layer → treat as scanned.
const SCANNED_TEXT_THRESHOLD = 32;
// Page render + per-page call budget. 1400 px wide keeps statement digits legible
// while staying well inside every provider's image limits; 3 pages in flight.
const OCR_PAGE_WIDTH_PX = 1400;
const OCR_PAGE_CONCURRENCY = 3;
const OCR_PAGE_MAX_TOKENS = 8192;
const OCR_PAGE_TIMEOUT_MS = 90_000;
const OCR_RULES = `Rules:
- Reproduce ALL text exactly as printed. Never summarize, paraphrase, infer, or invent anything.
- Render every table as a Markdown table. Keep exactly one column per source column and KEEP EMPTY CELLS EMPTY (leave the cell blank) — NEVER shift a value into a neighbouring column. This is critical for financial documents (bank/credit-card statements, invoices): a number's column (e.g. Withdrawal vs Deposit vs Balance) determines its meaning.
- ONLY when a table has merged cells (a header spanning several columns or rows), render THAT table as an HTML <table> with colspan/rowspan instead, so the structure survives.
- Copy every number, amount, date and currency symbol digit-for-digit, in plain ASCII punctuation. Do not round, reformat, recompute, or "fix" any value.
- Preserve reading order.
- Output ONLY the transcription — no preamble, no explanation, no commentary.`;
const OCR_PAGE_PROMPT = `You are a precise OCR and document-transcription engine. Transcribe this page image to clean GitHub-flavored Markdown.\n${OCR_RULES}`;
const OCR_DOCUMENT_PROMPT = `You are a precise OCR and document-transcription engine. Transcribe EVERY page of this PDF to clean GitHub-flavored Markdown. Separate pages with a line containing only "---".\n${OCR_RULES}`;
const OCR_DOCUMENT_MAX_TOKENS = 32768;
const OCR_DOCUMENT_TIMEOUT_MS = 180_000;

/** Z.AI GLM vision models accept a whole PDF as a `file` content part (data
 *  URI, ≤50 MB) — verified live 2026-09-22 on glm-5.3-flash (a 2-page scan in
 *  16 s). Built-in ZAI providers only: custom endpoints get page images. */
function providerTakesPdfNatively(p: ProviderConfig): boolean {
  return !p.label.endsWith('(custom endpoint)') && /^https:\/\/api\.z\.ai\//i.test(p.url) && /^glm-/i.test(p.model);
}

interface PdfParseResult {
  pages: Array<{ text: string; num: number }>;
}

interface PdfScreenshotResult {
  pages: Array<{ data: Uint8Array; pageNumber: number; width: number; height: number }>;
  total: number;
}
type PdfParseInstance = {
  getText: () => Promise<PdfParseResult>;
  /** pdf-parse v2 page rendering (pdfjs + @napi-rs/canvas) → PNG bytes per page. */
  getScreenshot: (params?: { first?: number; desiredWidth?: number; scale?: number; imageBuffer?: boolean; imageDataUrl?: boolean }) => Promise<PdfScreenshotResult>;
  destroy: () => Promise<void>;
};
function loadPdfParse(): new (options?: { data?: Uint8Array; verbosityLevel?: number }) => PdfParseInstance {
  // pdf-parse v2: class-based API. Data goes in the constructor as Uint8Array;
  // text is extracted via getText() (NOT pdf()); pages render via getScreenshot().
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('pdf-parse') as {
    PDFParse: new (options?: { data?: Uint8Array; verbosityLevel?: number }) => PdfParseInstance;
  };
  return mod.PDFParse;
}

async function runPdfParse(buffer: Buffer): Promise<{ text: string; pageCount: number }> {
  const PdfParseClass = loadPdfParse();
  const parser = new PdfParseClass({ data: new Uint8Array(buffer), verbosityLevel: 0 });
  const result = await parser.getText();
  const pages = result.pages || [];
  return {
    text: pages.map(p => p.text).join('\n'),
    pageCount: pages.length,
  };
}

/** Render the first `maxPages` pages to PNG (pdf-parse getScreenshot). */
async function renderPdfPages(buffer: Buffer, maxPages: number): Promise<Array<{ pageNumber: number; png: Buffer }>> {
  const PdfParseClass = loadPdfParse();
  const parser = new PdfParseClass({ data: new Uint8Array(buffer), verbosityLevel: 0 });
  try {
    const shot = await parser.getScreenshot({ first: maxPages, desiredWidth: OCR_PAGE_WIDTH_PX, imageBuffer: true, imageDataUrl: false });
    return (shot.pages || [])
      .filter(p => p?.data?.length)
      .map(p => ({ pageNumber: p.pageNumber, png: Buffer.from(p.data) }));
  } finally {
    await parser.destroy().catch(() => { /* best effort */ });
  }
}

/** Bounded-concurrency map preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** One provider's attempt at the whole document: native PDF part for Z.AI GLM,
 *  rendered pages (bounded concurrency) for everything else. '' = nothing usable. */
async function ocrWithProvider(provider: ProviderConfig, buffer: Buffer, filename: string, pages: Array<{ pageNumber: number; png: Buffer }> | null): Promise<string> {
  if (providerTakesPdfNatively(provider)) {
    const r = await seatCompletion(provider, [{
      role: 'user',
      content: [
        { type: 'file', file: { file_data: `data:application/pdf;base64,${buffer.toString('base64')}`, filename: filename || 'document.pdf' } },
        { type: 'text', text: OCR_DOCUMENT_PROMPT },
      ],
    }], { maxTokens: OCR_DOCUMENT_MAX_TOKENS, temperature: 0, timeoutMs: OCR_DOCUMENT_TIMEOUT_MS, reasoningEffort: 'low' });
    return r.text.trim();
  }
  if (!pages?.length) return '';
  let failed = 0;
  const transcripts = await mapLimit(pages, OCR_PAGE_CONCURRENCY, async (page) => {
    try {
      const r = await seatCompletion(provider, [{
        role: 'user',
        content: [imageUrlPart('image/png', page.png.toString('base64')), { type: 'text', text: OCR_PAGE_PROMPT }],
      }], { maxTokens: OCR_PAGE_MAX_TOKENS, temperature: 0, timeoutMs: OCR_PAGE_TIMEOUT_MS, reasoningEffort: 'low' });
      if (!r.text) failed++;
      return r.text;
    } catch (err: any) {
      failed++;
      warnSeatFailure(PDF_OCR_ROLE, provider, err);
      return '';
    }
  });
  if (failed === pages.length) return '';
  if (failed) logger.warn(`PDF OCR: ${failed}/${pages.length} page(s) of ${filename} failed on ${provider.model} — the rest of the document is kept`);
  return transcripts.map(t => t.trim()).join('\n\n---\n\n').trim();
}

/**
 * Transcribe a PDF to layout-faithful Markdown via the PDF reader seat's vision
 * model — the seat's model, then its custom fallback, then the built-in default.
 * Returns null if no provider in the chain can be called (keyless), the
 * document is too large, rendering fails for a page-based provider, every
 * provider fails, or the transcription is empty — callers then keep pdf-parse.
 */
export async function ocrPdfWithVision(buffer: Buffer, filename: string): Promise<string | null> {
  if (buffer.length > OCR_MAX_BYTES) return null;

  let chain: ProviderConfig[];
  try {
    chain = await seatProviderChain(PDF_OCR_ROLE, PDF_OCR_DEFAULT_MODEL, { requiresVision: true });
  } catch (err: any) {
    logger.warn(`PDF OCR: could not resolve the PDF reader seat (${err?.message || err}) — using pdf-parse text for ${filename}`);
    return null;
  }
  const usable = chain.filter(p => {
    const keyless = providerKeyMissing(p);
    if (keyless) logger.info(`PDF OCR: skipping ${p.model} for ${filename}: ${keyless}`);
    return !keyless;
  });
  if (!usable.length) return null;

  // Render pages once, lazily — only a page-based provider needs them.
  let pages: Array<{ pageNumber: number; png: Buffer }> | null | undefined;
  const renderedPages = async () => {
    if (pages !== undefined) return pages;
    try {
      pages = await renderPdfPages(buffer, OCR_MAX_PAGES);
    } catch (err: any) {
      logger.warn(`PDF OCR: page rendering failed for ${filename} (${err?.message || err})`);
      pages = null;
    }
    return pages;
  };

  for (const provider of usable) {
    try {
      const text = await ocrWithProvider(provider, buffer, filename, providerTakesPdfNatively(provider) ? null : await renderedPages());
      if (text) return text;
      logger.warn(`PDF OCR: ${provider.model} returned no transcription for ${filename}`);
    } catch (err: any) {
      warnSeatFailure(PDF_OCR_ROLE, provider, err);
    }
  }
  return null;
}

/**
 * Extract text from a PDF buffer, preferring layout-faithful vision OCR for
 * small/layout-sensitive or scanned documents, with pdf-parse as the baseline
 * and fallback. Never throws for OCR reasons — always returns the best text it
 * could get (possibly '' for an un-OCR-able scanned PDF, which callers note).
 */
export async function extractPdfText(buffer: Buffer, filename: string): Promise<string> {
  let parseText = '';
  let pageCount = 0;
  try {
    const r = await runPdfParse(buffer);
    parseText = r.text;
    pageCount = r.pageCount;
  } catch (e: any) {
    logger.warn(`pdf-parse getText() failed for ${filename}: ${e?.message}`);
  }

  const trimmedLen = parseText.trim().length;
  const scanned = trimmedLen < SCANNED_TEXT_THRESHOLD;
  const withinOcrBounds =
    buffer.length <= OCR_MAX_BYTES && (pageCount === 0 || pageCount <= OCR_MAX_PAGES);

  // OCR when the document is small enough to be layout-sensitive (statements,
  // invoices, receipts, forms) OR when pdf-parse found no usable text (scanned).
  if (withinOcrBounds) {
    const ocr = await ocrPdfWithVision(buffer, filename);
    // Guard against silently losing content if OCR truncated/under-performed:
    // only prefer OCR when it produced at least half of what pdf-parse found
    // (always prefer it for scanned PDFs, where pdf-parse had nothing).
    if (ocr && (scanned || ocr.length >= Math.max(40, trimmedLen * 0.5))) {
      logger.info(
        `PDF "${filename}" extracted via the PDF reader seat's vision OCR: ${ocr.length} chars ` +
          `(pdf-parse baseline ${trimmedLen} chars, ${pageCount} pages)`
      );
      return ocr;
    }
  }

  return parseText;
}
