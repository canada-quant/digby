/**
 * Ingestion Service — Background document processing pipeline
 *
 * Flow:
 *   1. Extract text (PDF / DOCX / TXT / URL-synthesis)
 *   2. Chunk text (RecursiveCharacterTextSplitter)
 *   3. Add context sentence to each chunk (Digby)
 *   4. Embed chunks — DashScope text-embedding-v4 (1536 dims), all model sets (RAG is open-source-only)
 *   5. Store in project_chunks (pgvector)
 *   6. Update document status → ready
 *
 * All processing is fire-and-forget (non-blocking for the HTTP response).
 */

import mammoth from 'mammoth';
import { extractPdfText } from './pdf-extract';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import {
  chunkText,
  addContextToChunks,
  embedTexts,
  storeChunks,
  type EmbeddingProvider,
} from './rag.service';

// ── Concurrency limiter ────────────────────────────────────────────────────────
// When many files are uploaded at once, each triggers processDocument which
// makes concurrent HTTP requests to Together AI (context) + OpenAI (embeddings).
// Without limiting, 18 simultaneous uploads = 90+ concurrent API requests
// → socket pool exhaustion → TLSSocket errors.
// Limit to 3 concurrent ingestion jobs at a time.

const MAX_CONCURRENT_INGESTIONS = 3;
let activeIngestions = 0;
const ingestionQueue: Array<() => void> = [];

function acquireIngestionSlot(): Promise<void> {
  if (activeIngestions < MAX_CONCURRENT_INGESTIONS) {
    activeIngestions++;
    return Promise.resolve();
  }
  return new Promise<void>(resolve => ingestionQueue.push(resolve));
}

function releaseIngestionSlot(): void {
  activeIngestions--;
  const next = ingestionQueue.shift();
  if (next) {
    activeIngestions++;
    next();
  }
}

// URL synthesis — consolidated to Fireworks AI (same provider as main pipeline).
// Cohere Command-A for document synthesis (replaces Llama-3.3-70B on Fireworks).
import { utilityChat } from '../../utils/utility-llm';
import { scrapeUrlWithBrightData } from './mcp-search';
import { webSearchStatus, webSearchProblemSuffix } from './platform/instance-setup';

// ── Text Extraction ────────────────────────────────────────────────────────────

/**
 * Extract plain text from a file buffer based on MIME type.
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string> {
  try {
    if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) {
      // Layout-faithful extraction: vision OCR for layout-sensitive / scanned
      // PDFs (preserves table columns so financial numbers keep their meaning),
      // pdf-parse baseline + fallback. Shared extractor: see pdf-extract.ts.
      return await extractPdfText(buffer, filename);
    }

    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename.endsWith('.docx')
    ) {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    // TXT, MD, and other text formats
    return buffer.toString('utf-8');
  } catch (err: any) {
    logger.error(`Text extraction failed for ${filename}:`, err.message);
    throw new Error(`Failed to extract text from ${filename}: ${err.message}`);
  }
}

// ── URL Content Analysis (via CrossModel) ─────────────────────────────────────

/**
 * Fetch a URL's content for the knowledge base — the BrightData scrape (the same
 * `scrape_as_markdown` tool chat uses; PDFs route through the tiered PDF
 * extractor automatically) becomes the document body VERBATIM, topped with a
 * short utility-seat overview so retrieval has a summary chunk to land on.
 *
 * History: until 2026-09-22 this fanned out to THREE frontier models with web
 * search (GPT-5.6, Grok 4.5, Gemini 3.5 Flash) and stored their synthesized
 * summary — lossy for RAG (a summary drops the very facts a later question
 * needs), three paid searches per URL, and a hard failure on any instance
 * without frontier keys. The owner removed every frontier model; the scrape is
 * faithful, one call, and works on every instance with the web tools.
 */
export async function analyzeUrlWithCrossModel(url: string, documentName: string): Promise<string> {
  logger.info(`Fetching URL for the knowledge base: ${url}`);
  const scraped = (await scrapeUrlWithBrightData(url)).replace(/^\[Scraped Content from [^\]]*\]\s*/, '').trim();
  if (!scraped) {
    // Self-host setup hardening (2026-10-20): an empty scrape on an instance
    // with no search/fetch backend is a configuration fact, not the page's fault.
    throw new Error(webSearchStatus().configured
      ? 'Could not fetch the URL content — the page returned nothing readable (blocked, empty, or unreachable).'
      : `Could not fetch the URL: web page fetching is not configured on this Digby instance (no BrightData token or MCP gateway) — an admin enables web search under Account → Admin → Setup.${webSearchProblemSuffix()}`);
  }
  const body = scraped.length > URL_BODY_MAX_CHARS
    ? `${scraped.slice(0, URL_BODY_MAX_CHARS)}\n\n[… truncated at ${URL_BODY_MAX_CHARS.toLocaleString()} characters]`
    : scraped;
  const overview = await summarizeUrlBody(url, documentName, body);
  return `# ${documentName}\nSource: ${url}\n\n${overview ? `## Overview\n${overview}\n\n## Content\n` : ''}${body}`;
}

/** Stored body cap — a whole site dump would blow the chunker and the embed budget. */
const URL_BODY_MAX_CHARS = 200_000;
/** How much of the body the overview pass reads. */
const URL_OVERVIEW_INPUT_CHARS = 12_000;

/** A 3-6 line factual overview from the Utility seat — fail-open to '' (the body still stores). */
async function summarizeUrlBody(url: string, documentName: string, body: string): Promise<string> {
  const prompt = `You are preparing reference material for a knowledge base. Below is the content fetched from ${url} (document name: "${documentName}").

Write a 3-6 line OVERVIEW in Markdown bullet points: what the page is, its main topic, and the key facts, figures, dates and conclusions it states. Use only what the content says — never add outside knowledge. Output ONLY the bullets.

CONTENT (may be truncated):
${body.slice(0, URL_OVERVIEW_INPUT_CHARS)}`;
  try {
    const overview = await utilityChat(
      [{ role: 'user', content: prompt }],
      { maxTokens: 600, temperature: 0.2, timeout: 45000 },
    );
    return (overview || '').trim();
  } catch (err: any) {
    logger.warn(`URL overview skipped for ${url}: ${err?.message || err}`);
    return '';
  }
}

// ── Main Ingestion Pipeline ───────────────────────────────────────────────────

/**
 * Process a document: extract → chunk → contextualize → embed → store.
 * Updates document status throughout. Designed to be called fire-and-forget.
 *
 * @param documentId  - The document to process
 * @param rawText     - Pre-extracted text (for file uploads). If omitted,
 *                      URL documents fetch their content via CrossModel.
 */
export async function processDocument(documentId: string, rawText?: string): Promise<void> {
  // Wait for an ingestion slot — prevents API flooding when many files upload at once
  await acquireIngestionSlot();
  logger.info(`Starting ingestion for document: ${documentId} (active: ${activeIngestions}/${MAX_CONCURRENT_INGESTIONS})`);

  let doc: any;
  try {
    doc = await prisma.projectDocument.findUnique({
      where: { id: documentId },
    });

    if (!doc) {
      logger.error(`Document not found: ${documentId}`);
      return;
    }

    // Determine raw text source
    let text = rawText;

    if (!text) {
      if (doc.mimeType === 'url') {
        if (!doc.sourceUrl) throw new Error('URL document missing sourceUrl');
        text = await analyzeUrlWithCrossModel(doc.sourceUrl, doc.name);
      } else {
        throw new Error('rawText required for non-URL documents');
      }
    }

    const rawTextToProcess = text;
    const charCount = rawTextToProcess.length;

    // Step 1: Chunk
    logger.info(`Chunking document ${documentId} (${charCount} chars)...`);
    const rawChunks = await chunkText(rawTextToProcess, doc.name);
    logger.info(`Created ${rawChunks.length} chunks`);

    if (rawChunks.length === 0) {
      await prisma.projectDocument.update({
        where: { id: documentId },
        data: { status: 'error', errorMsg: 'Document appears to be empty or unreadable' },
      });
      return;
    }

    // Step 2: Contextual retrieval (add context sentences via Digby)
    logger.info(`Adding context to chunks for document ${documentId}...`);
    const contextualizedChunks = await addContextToChunks(rawTextToProcess, rawChunks, doc.name);

    // Step 3: Embed all chunks. RAG is open-source-only — always Qwen text-embedding-v4
    // (DashScope), 1536-dim, for both model sets.
    const embeddingProvider: EmbeddingProvider = 'dashscope';

    // Step 4: Embed all chunks
    logger.info(`Embedding ${contextualizedChunks.length} chunks with Qwen text-embedding-v4 (DashScope)...`);
    const chunkTexts = contextualizedChunks.map(c => c.content);
    const embeddings = await embedTexts(chunkTexts, embeddingProvider, { bucket: 'ingest' });

    // Step 5: Store in pgvector
    logger.info(`Storing chunks in pgvector...`);
    await storeChunks(
      documentId,
      doc.projectId,
      doc.userId,
      contextualizedChunks,
      embeddings
    );

    // Step 6: Update document status
    await prisma.projectDocument.update({
      where: { id: documentId },
      data: {
        status: 'ready',
        charCount,
        chunkCount: contextualizedChunks.length,
        errorMsg: null, // Clear the temp rawText storage
      },
    });

    logger.info(`Document ${documentId} ingested: ${contextualizedChunks.length} chunks, ${charCount} chars`);

    // One-Digby (Phase 1B): if the project has a PROVISIONED workspace, also
    // commit the extracted text into the repo as knowledge/<name>.md. Fire-and-
    // forget + best-effort: RAG is already durable above; a repo commit failure
    // must never fail ingestion. No auto-provision here — syncKnowledgeToRepo
    // catches up when a workspace appears later.
    if (doc.projectId) {
      const projectId = doc.projectId;
      void (async () => {
        try {
          const { commitKnowledgeFile } = await import('./coding/project-workspace.service');
          await commitKnowledgeFile(projectId, {
            name: doc.name, mimeType: doc.mimeType, sourceUrl: (doc as any).sourceUrl,
            text: rawTextToProcess,
          });
        } catch { /* best-effort */ }
      })();
    }
  } catch (err: any) {
    // Use err.message (string) to avoid circular-reference issues when logging axios errors
    const errMsg = err?.message || 'Processing failed';
    logger.error(`Ingestion failed for document ${documentId}: ${errMsg}`);

    // Mark document as error
    try {
      await prisma.projectDocument.update({
        where: { id: documentId },
        data: {
          status: 'error',
          errorMsg: errMsg.substring(0, 500),
        },
      });
    } catch (updateErr: any) {
      logger.error(`Failed to update document error status: ${updateErr?.message}`);
    }
  } finally {
    // Always release the slot so queued ingestions can proceed
    releaseIngestionSlot();
  }
}
