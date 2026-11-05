/**
 * RAG Service — Chunking, Embedding, and Retrieval
 * 
 * Pipeline:
 *   Text → Chunk → Contextualize (Digby) → Embed → Store (pgvector)
 *
 * Embedding + rerank are open-source-only via Alibaba DashScope (both model sets):
 *   - Embeddings: Qwen text-embedding-v4 (1536 dims) — compatible with the pgvector column
 *   - Rerank:     gte-rerank (Qwen GTE cross-encoder), with graceful fallback to RRF order
 *
 * Retrieval:
 *   Query → Embed (DashScope) → Semantic search (pgvector cosine) + Keyword search (tsvector)
 *         → RRF merge → DashScope gte-rerank → top-5 chunks
 *
 * IMPORTANT: Documents must be queried with the same embedding model used at ingestion.
 * Everything now embeds with DashScope text-embedding-v4 — documents embedded under the
 * previous OpenAI/Fireworks models are in a different vector space and must be re-ingested.
 */

import axios from 'axios';
import { randomUUID } from 'crypto';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { logExternal } from '../../utils/log-level';
import { utilityChat } from '../../utils/utility-llm';
import { stripNulBytes } from './memory/text-utils';
import { truncateMatryoshka } from './model-endpoints/matryoshka';
import { processTag } from './platform/process-tag';
import { type EmbedBucket, EMBED_GWLESS_DIRECT, legFromAttributionHeaders, markEmbedLane } from './memory/embed-failure';

// Alibaba DashScope — RAG embeddings (text-embedding-v4) + rerank (gte-rerank), open-source only
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RAGChunk {
  content: string;
  chunkIndex: number;
  tokenCount: number;
  metadata: {
    page?: number;
    section?: string;
    sourceUrl?: string;
    fileName: string;
  };
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  documentName: string;
  mimeType: string;
  content: string;
  chunkIndex: number;
  relevanceScore: number;
  metadata: any;
  /** Set only for cross-project results — the project the chunk came FROM (for labeling). */
  sourceProjectName?: string;
}

// ── Chunking ──────────────────────────────────────────────────────────────────

/**
 * Split text into overlapping chunks using recursive character splitter.
 * Respects paragraph boundaries, handles markdown/code/prose.
 */
export async function chunkText(text: string, fileName: string): Promise<RAGChunk[]> {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 2000,      // ~500 tokens — good balance of context vs specificity
    chunkOverlap: 200,    // ~50 tokens overlap for continuity
    separators: ['\n\n', '\n', '. ', '! ', '? ', ' ', ''], // respect paragraph boundaries
  });

  const docs = await splitter.createDocuments([text]);

  return docs.map((doc, i) => ({
    content: doc.pageContent,
    chunkIndex: i,
    tokenCount: Math.ceil(doc.pageContent.length / 4), // rough estimate: 4 chars/token
    metadata: {
      fileName,
      // Extract page number if present in metadata
      page: doc.metadata?.loc?.lines?.from ? Math.floor(doc.metadata.loc.lines.from / 50) + 1 : undefined,
    },
  }));
}

// ── Contextual Retrieval (Anthropic method) ───────────────────────────────────

/**
 * Add a brief context sentence to each chunk using Digby.
 * This prepends document-level context to each chunk, dramatically
 * improving retrieval accuracy (Anthropic reports ~49% improvement).
 *
 * For large documents with many chunks, we process in batches of 5.
 */
export async function addContextToChunks(
  documentText: string,
  chunks: RAGChunk[],
  fileName: string
): Promise<RAGChunk[]> {
  // Use first 3000 chars of document as context window
  const docContext = documentText.substring(0, 3000);

  const contextualizedChunks: RAGChunk[] = [];

  // Process in batches to avoid rate limiting
  const BATCH_SIZE = 5;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        try {
          const contextSentence = await getContextSentence(docContext, chunk.content, fileName);
          return {
            ...chunk,
            content: `${contextSentence}\n\n${chunk.content}`,
          };
        } catch (err: any) {
          // Pass only the message string — axios errors have TLSSocket circular refs
          // that crash JSON.stringify inside the logger format
          logger.warn(`Failed to add context to chunk ${chunk.chunkIndex}, using as-is: ${err?.message || String(err)}`);
          return chunk;
        }
      })
    );

    contextualizedChunks.push(...batchResults);
  }

  return contextualizedChunks;
}

/**
 * Ask Digby to write a 1-2 sentence context description for a chunk.
 */
async function getContextSentence(docContext: string, chunkContent: string, fileName: string): Promise<string> {
  const prompt = `Document excerpt from "${fileName}":
<document>
${docContext}
</document>

Specific chunk to contextualize:
<chunk>
${chunkContent.substring(0, 500)}
</chunk>

In 1-2 sentences only, describe what this chunk is about in the context of the document. Be specific and factual. Output ONLY the context sentence, nothing else.`;

  return utilityChat(
    [{ role: 'user', content: prompt }],
    { maxTokens: 100, temperature: 0.3, timeout: 15000 }
  );
}

// ── Embedding ─────────────────────────────────────────────────────────────────

/**
 * Embedding provider type. RAG is open-source-only via DashScope, so the only
 * provider is 'dashscope' (Qwen text-embedding-v4, 1536 dims). The type and the
 * `provider` params are retained for signature stability across callers; every
 * value routes to DashScope.
 *
 * IMPORTANT: Query embeddings must use the same model as ingestion embeddings.
 * Everything embeds with text-embedding-v4 now — documents embedded under the
 * previous OpenAI/Fireworks models must be re-ingested to match the vector space.
 */
export type EmbeddingProvider = 'openai' | 'dashscope';

// Alibaba DashScope embedding endpoint (OpenAI-compatible)
const DASHSCOPE_EMBEDDING_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings';
// text-embedding-v4 — Qwen embeddings; supports a configurable `dimensions` param (1536 here).
const DASHSCOPE_EMBEDDING_MODEL = 'text-embedding-v4';
// pgvector columns are vector(1536) everywhere — every embedding path must match.
const EMBEDDING_DIMS = 1536;

/**
 * Digby Edge model-roles override for the NON-CHAT lanes: the admin can point
 * the embeddings/rerank roles at a registered custom endpoint
 * ('<label>:<modelId>' — model-roles.service). Returns null when the role is
 * unset or no longer resolves (built-in default applies). Dynamic import +
 * fail-open: a missing/broken config module must never take down RAG.
 */
async function roleEndpointTarget(
  role: 'embeddings' | 'rerank',
  pathSuffix: '/embeddings' | '/rerank',
): Promise<{ url: string; model: string; apiKey?: string | null; spec: string; matryoshka: boolean } | null> {
  let spec = '';
  try {
    const { getModelRoleOverrides } = await import('./model-endpoints/model-roles.service');
    spec = (await getModelRoleOverrides())[role] ?? '';
    if (!spec) return null;
    const { resolveRegistryModel } = await import('./model-endpoints/model-endpoints.service');
    const reg = await resolveRegistryModel(spec);
    if (!reg) {
      if (role === 'embeddings') {
        // FAIL CLOSED: an embeddings override that is CONFIGURED but currently
        // unresolvable (endpoint disabled/deleted/renamed, key drift, DB blip
        // inside the registry lookup) must never silently swap to DashScope —
        // both are 1536-dim, nothing downstream would notice, and the wrong-
        // space vectors persist forever (adversarial review finding). Rerank
        // stays fail-open: its fallback only changes ordering, never data.
        throw new Error(`Embeddings model role "${spec}" is configured but does not currently resolve — refusing to embed with a different model (mixed vector spaces corrupt retrieval). Re-enable the endpoint or clear the role (Account → Admin → Endpoints).`);
      }
      logger.warn(`rag: ${role} role override "${spec}" no longer resolves — using the built-in default`);
      return null;
    }
    return { url: `${reg.baseUrl}${pathSuffix}`, model: reg.model, apiKey: reg.apiKey, spec, matryoshka: reg.matryoshka === true };
  } catch (err: any) {
    // A CONFIGURED embeddings override never degrades silently (see above);
    // config-read/import failures (spec unknown) stay fail-open — and
    // getModelRoleOverrides itself serves stale-on-error to shrink that window.
    if (role === 'embeddings' && spec) throw err;
    if (role === 'embeddings') logger.warn(`rag: embeddings role config unreadable (${err?.message}) — using the built-in default`);
    return null;
  }
}

/**
 * Embed an array of texts. Returns a 1536-dimensional vector for each input.
 * The instance's `embeddings` role override (custom OpenAI-compatible
 * /embeddings endpoint) wins when set; otherwise DashScope text-embedding-v4
 * (RAG is open-source-only). The `provider` arg is accepted for backward
 * compatibility but ignored.
 */
export async function embedTexts(
  texts: string[],
  _provider: EmbeddingProvider = 'dashscope',
  /** Per-request HTTP timeout (default 30 s). Query-time callers with a
   *  deadline pass their remaining budget so a slow provider fails fast and
   *  the keyword leg still answers (memory/unified-memory.service.ts). */
  opts?: {
    timeoutMs?: number;
    /** WHICH flow is embedding (goal 4e432dff). Stamped on every attempt row
     *  this call emits, so a failure row names the flow that attempted it.
     *  Defaults to `unknown` — deliberately a visible sentinel rather than an
     *  omission, because an unattributed row is exactly what the KPI counts. */
    bucket?: EmbedBucket;
  },
): Promise<number[][]> {
  const timeoutMs = Math.max(500, Math.floor(opts?.timeoutMs ?? EMBED_HTTP_TIMEOUT_MS));
  const bucket: EmbedBucket = opts?.bucket ?? 'unknown';
  const custom = await roleEndpointTarget('embeddings', '/embeddings');
  // PER-ATTEMPT COUNTING (2026-11-01). This used to emit ONE row per CALL, so a
  // multi-batch call that lost 9 of its 10 batches to timeouts still read as
  // "1 failure" — and a call that succeeded on the last batch read as pure
  // success. The attempt is the unit that pays the timeout, so the attempt is
  // the unit that is counted (unit:'attempt'); the call-level row keeps a
  // `batchAttempts`/`batchFailures` roll-up so both views are answerable.
  const rollFor = (spec: string, lane: string, op: string, sink: RagAttempt[]) =>
    (a: EmbedAttemptNote) => {
      sink.push({ spec, ok: a.ok, ms: a.ms, errorKind: a.errorKind, status: a.status, leg: a.leg, callId: a.callId, callIdEcho: a.callIdEcho, abort: a.abort, bucket });
      recordRagTransport('rag_embed_call', { spec, ok: a.ok, ms: a.ms, errorKind: a.errorKind, status: a.status, leg: a.leg, callId: a.callId, callIdEcho: a.callIdEcho, abort: a.abort },
        { op, lane, batch: a.batch, unit: 'attempt', ...(a.chars !== undefined ? { chars: a.chars } : {}), ...(a.retried ? { retried: true } : {}) });
    };
  // `batchChars` on the CALL row (ticket d59499f4): the payload the call sent,
  // so a chunk/batch-sizing change is attributable against the payload mix.
  const callChars = { batchChars: totalChars(texts), batchCount: Math.ceil(texts.length / EMBED_BATCH_SIZE) };
  const rollUp = (sink: RagAttempt[]) => ({ batchAttempts: sink.length, batchFailures: sink.filter(a => !a.ok).length, ...callChars });
  if (custom) {
    const customAttempts: RagAttempt[] = [];
    const t0 = Date.now();
    try {
      const vecs = await embedTextsCustom(custom, texts, timeoutMs, rollFor(custom.spec, 'custom', 'embedTexts', customAttempts));
      recordRagTransport('rag_embed_call', { spec: custom.spec, ok: true, ms: Date.now() - t0 }, { op: 'embedTexts', lane: 'custom', ...rollUp(customAttempts) });
      return vecs;
    } catch (err: any) {
      recordRagTransport('rag_embed_call', { spec: custom.spec, ok: false, ms: Date.now() - t0, ...classifyRagError(err) }, { op: 'embedTexts', lane: 'custom', ...rollUp(customAttempts) });
      throw err;
    }
  }
  // Self-host honesty (2026-10-26): a keyless instance (no embeddings seat
  // override, no DASHSCOPE_API_KEY) used to POST `Bearer undefined` to
  // DashScope and surface the provider's 401 as a PROVIDER failure — a
  // configuration error masked as an outage, on every document upload and
  // every memory store. Throw the config-shaped error instead: it names the
  // exact fix (assign the Embeddings seat or set DASHSCOPE_API_KEY) so
  // callers, logs and document.status rows say "not configured", never
  // "Request failed with status code 401".
  if (!DASHSCOPE_API_KEY) {
    throw new Error('no embeddings backend configured on this instance — set DASHSCOPE_API_KEY or assign a custom endpoint to the Embeddings seat (Account → Admin → Endpoints → Model roles)');
  }
  const spec = `dashscope:${DASHSCOPE_EMBEDDING_MODEL}`;
  const t0 = Date.now();
  const dsAttempts: RagAttempt[] = [];
  const onAttempt = (a: EmbedAttemptNote) => {
    dsAttempts.push({ spec, ok: a.ok, ms: a.ms, errorKind: a.errorKind, status: a.status, leg: a.leg, callId: a.callId, callIdEcho: a.callIdEcho, abort: a.abort, bucket });
    recordRagTransport('rag_embed_call', { spec, ok: a.ok, ms: a.ms, errorKind: a.errorKind, status: a.status, leg: a.leg, callId: a.callId, callIdEcho: a.callIdEcho, abort: a.abort },
      { op: 'embedTexts', lane: 'dashscope', batch: a.batch, unit: 'attempt', ...(a.chars !== undefined ? { chars: a.chars } : {}), ...(a.retried ? { retried: true } : {}), bucket, ...(a.gwless !== undefined ? { gwless: a.gwless } : {}) });
  };
  const dsRoll = { batchChars: totalChars(texts), batchCount: Math.ceil(texts.length / EMBED_BATCH_SIZE) };
  try {
    const vecs = await embedTextsDashscope(texts, timeoutMs, onAttempt);
    recordRagTransport('rag_embed_call', { spec, ok: true, ms: Date.now() - t0 }, { op: 'embedTexts', lane: 'dashscope', batchAttempts: dsAttempts.length, batchFailures: dsAttempts.filter(a => !a.ok).length, ...dsRoll });
    return vecs;
  } catch (err: any) {
    recordRagTransport('rag_embed_call', { spec, ok: false, ms: Date.now() - t0, ...classifyRagError(err) }, { op: 'embedTexts', lane: 'dashscope', batchAttempts: dsAttempts.length, batchFailures: dsAttempts.filter(a => !a.ok).length, ...dsRoll });
    throw err;
  }
}
/** One BATCH attempt of an embed call — the unit that pays the timeout, so the
 *  unit that is counted (2026-11-01: a per-CALL counter hid 9 of 10 failed
 *  batches behind one row). */
export interface EmbedAttemptNote extends RagAttemptLeg {
  ok: boolean;
  ms: number;
  /** 0-based batch index within the call. */
  batch: number;
  /** Characters in THIS batch's payload (ticket d59499f4). The remaining
   *  post-fix failures land milliseconds short of the caller's bound, so the
   *  next lever is chunk/batch sizing — and choosing it needs the payload
   *  distribution. Without this field that experiment is blind and its result
   *  unattributable against a payload mix that may itself have shifted. */
  chars?: number;
  errorKind?: RagAttempt['errorKind'];
  status?: number;
  /** Typed end reason (ticket b5f4d5e2) — who aborted, not just that it failed. */
  abort?: RagAbortReason;
  /** The transport's own assertion that NO gateway sat in front (goal 4e432dff,
   *  supervisor ruling 2026-11-04). Set ONLY by the function that owns the URL
   *  literal — a per-row fact, never inferred from a missing leg. */
  gwless?: typeof EMBED_GWLESS_DIRECT;
  /** True when a bounded retry produced this attempt. */
  retried?: boolean;
}

/** Total characters across a call's inputs — the call-level `batchChars`
 *  (ticket d59499f4). Cheap (a sum of lengths), never the payload itself. */
export function totalChars(texts: string[]): number {
  let n = 0;
  for (const t of texts) n += typeof t === 'string' ? t.length : 0;
  return n;
}

/** Characters in a batch — the per-attempt payload size (ticket d59499f4).
 *  ONE definition: `batchCount` on the call row divides by it, so a retune of
 *  the batch size cannot make the count lie about the very lever it sizes. */
const EMBED_BATCH_SIZE = 10;

const EMBED_HTTP_TIMEOUT_MS = 30000;

/**
 * PER-ATTEMPT cap (2026-11-01, goal 79284e7f). `EMBED_HTTP_TIMEOUT_MS` above is
 * the CALL budget a caller grants; it must never be spent on ONE hung request.
 * Measured over a 6 h prod `rag_embed_call` sample (15:49–15:56Z, 482 rows):
 * every SUCCESS landed in 178–5 859 ms, while every timeout pinned at 30 000–
 * 30 016 ms — i.e. a hung attempt burned the entire call budget and then
 * failed, and ~30 % of attempts did exactly that. Sizing the attempt at 8 s
 * (1.37× the slowest observed success) converts each of those 30 s stalls into
 * an 8 s one and still leaves the fast path untouched.
 *
 * This is a CEILING, not a reserve: a caller with a smaller remaining budget
 * keeps its own smaller number.
 */
export const EMBED_ATTEMPT_TIMEOUT_MS = 8_000;

/**
 * Bounded retry for a timed-out attempt — attempts only, never an unbounded
 * ladder. One retry is worth it because the failures are bimodal (a request
 * either answers in <6 s or hangs to the cap), so a second draw on the same
 * input is a genuinely independent chance to land in the fast mode; beyond
 * that it is a provider outage and the row goes NULL for the backfill cron.
 */
export const EMBED_ATTEMPT_RETRY_MAX = 1;

/** Is the retry-able attempt budget exhausted? (Bounded — never a ladder.) */
export function embedAttemptRetries(envSource: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(envSource.RAG_EMBED_ATTEMPT_RETRY_MAX || '', 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 2) : EMBED_ATTEMPT_RETRY_MAX;
}

/**
 * WHICH VECTOR SPACE does the store hold today?
 *
 * Measured 2026-11-01 by re-embedding stored rows with DashScope
 * text-embedding-v4 and taking the cosine to the STORED vector:
 *   - 2026-07..2026-10 rows ........ cosine 0.63 – 0.99  (SAME space)
 *   - 2026-11-01 rows .............. cosine ≈ 0.01        (DIFFERENT space)
 * Every row is 1536-dim, so NOTHING downstream could notice the split: same
 * column, same width, incomparable vectors. Similarity across the two spaces
 * is noise, so part of the Nov corpus is unfindable by vector search while
 * still occupying storage — a silent retrieval loss, not a crash.
 *
 * CONFIRMED AGAIN 2026-11-01 (goal 79284e7f) with a direct two-provider probe
 * rather than a stored-row inference: the SAME sentence embedded through
 * DashScope text-embedding-v4 (1536 dims) and OpenAI text-embedding-3-small
 * (also 1536 dims) returned cosine −0.0168 — two vectors of identical WIDTH
 * and near-orthogonal DIRECTION. That is the whole constraint in one number:
 * matching dimensions buy you nothing, and a rotated provider writes pure
 * noise into a column the query leg still reads as meaningful.
 *
 * That is why embedTexts above keeps a SINGLE space per instance and fails
 * closed rather than rotating: rotating the embed provider on failure would
 * write a THIRD space into the same column. Embedding rotation is a
 * data-migration decision, never a retry policy. (The bounded per-attempt
 * retry added below is SAME-PROVIDER — it can never change the space.)
 */

/** The embedder the CORPUS and the LIVE QUERY LEGE agree on — used by the
 *  backfill to decide which vector space its output must be comparable to. */
export async function authoritativeEmbedTargetSpec(): Promise<string> {
  const pinned = process.env.RAG_EMBED_AUTHORITATIVE_SPEC;
  if (pinned) return pinned;
  // PARITY WITH THE QUERY LEG (adversarial review 2026-11-01, blocker 1).
  // Queries are embedded through the `embeddings` SEAT
  // (memory/unified-memory.service.ts → embedTexts). If the repair wrote a
  // different space, repaired rows would be physically unfindable by the live
  // query leg — the exact "silent retrieval loss" this work exists to remove.
  // So the repair resolves the SAME spec the query leg uses whenever that seat
  // resolves; only when it does not (unconfigured, or the route is the thing
  // that is broken) does it fall back to the built-in DashScope corpus space.
  try {
    const seat = await roleEndpointTarget('embeddings', '/embeddings');
    if (seat) return seat.spec;
  } catch {
    // Model space does NOT mean "stay frozen" — fall through to the corpus
    // space rather than editing in comment silence.
  }
  return `dashscope:${DASHSCOPE_EMBEDDING_MODEL}`;
}

/**
 * Embed into a SPECIFIC, PINNED vector space, bypassing whatever the
 * `embeddings` seat currently resolves to.
 *
 * Why this exists (2026-11-01): the repair cron used `embedTexts`, which
 * follows the seat. When the role is pointed at a route that HANGS (the
 * incident), every repair row burns its timeout and the cron can never
 * converge. This entry point takes the target EXPLICITLY so the repair can be
 * told which space to write into, independently of that failure mode.
 *
 * Supported pins:
 *   - `dashscope:<model>`      → the built-in DashScope route (needs the key)
 *   - `<label>:<modelId>`      → a registered endpoint (same resolver as the seat)
 * Anything else throws: an unknown pin must fail loudly, never guess a space.
 */
export async function embedTextsForSpec(
  spec: string,
  texts: string[],
  opts?: {
    timeoutMs?: number;
    /** WHICH flow is embedding (goal 4e432dff) — stamped on every attempt row. */
    bucket?: EmbedBucket;
  },
): Promise<number[][]> {
  const timeoutMs = Math.max(500, Math.floor(opts?.timeoutMs ?? EMBED_HTTP_TIMEOUT_MS));
  const bucket: EmbedBucket = opts?.bucket ?? 'unknown';
  if (!texts.length) return [];
  if (spec === `dashscope:${DASHSCOPE_EMBEDDING_MODEL}`) {
    const { resolveRegistryModel } = await import('./model-endpoints/model-endpoints.service');
    void resolveRegistryModel;
    if (DASHSCOPE_API_KEY) {
      const pinnedAttempts: RagAttempt[] = [];
      const rolled = (a: EmbedAttemptNote) => {
        pinnedAttempts.push({ spec, ok: a.ok, ms: a.ms, errorKind: a.errorKind, status: a.status, leg: a.leg, callId: a.callId, callIdEcho: a.callIdEcho, abort: a.abort, bucket });
        recordRagTransport('rag_embed_call', { spec, ok: a.ok, ms: a.ms, errorKind: a.errorKind, status: a.status, leg: a.leg, callId: a.callId, callIdEcho: a.callIdEcho, abort: a.abort },
          { op: 'embedTextsForSpec', lane: 'pinned', batch: a.batch, unit: 'attempt', ...(a.chars !== undefined ? { chars: a.chars } : {}), ...(a.retried ? { retried: true } : {}), bucket });
      };
      // Payload sizes (ticket d59499f4) — same contract as the seat lanes.
      const pinnedRoll = { batchChars: totalChars(texts), batchCount: Math.ceil(texts.length / EMBED_BATCH_SIZE) };
      const t0 = Date.now();
      try {
        const vecs = await embedTextsDashscope(texts, timeoutMs, rolled);
        recordRagTransport('rag_embed_call', { spec, ok: true, ms: Date.now() - t0 }, { op: 'embedTextsForSpec', lane: 'pinned', batchAttempts: pinnedAttempts.length, batchFailures: pinnedAttempts.filter(a => !a.ok).length, ...pinnedRoll });
        return vecs;
      } catch (err: any) {
        recordRagTransport('rag_embed_call', { spec, ok: false, ms: Date.now() - t0, ...classifyRagError(err) }, { op: 'embedTextsForSpec', lane: 'pinned', batchAttempts: pinnedAttempts.length, batchFailures: pinnedAttempts.filter(a => !a.ok).length, ...pinnedRoll });
        throw err;
      }
    }
    // Keyless self-host / Edge instance (adversarial review 2026-11-01, blocker
    // 2): the documented shape is "no DASHSCOPE_API_KEY + a custom Embeddings
    // seat". Throwing here made the repair cron fail every row with only a
    // debug line — silent. Serve that instance through whatever the seat
    // resolves to instead; the space stays the one its own queries use, which
    // is what parity means on an instance without a DashScope key.
    const seat = await roleEndpointTarget('embeddings', '/embeddings');
    if (seat) return embedTextsCustom(seat, texts, timeoutMs);
    throw new Error(`pinned embeddings spec "${spec}" needs DASHSCOPE_API_KEY (unset), and no embeddings seat resolves to serve this instance — configure one (Account → Admin → Endpoints → Model roles) or set RAG_EMBED_AUTHORITATIVE_SPEC to a spec that resolves`);
  }
  const { resolveRegistryModel } = await import('./model-endpoints/model-endpoints.service');
  const reg = await resolveRegistryModel(spec);
  if (!reg) throw new Error(`pinned embeddings spec "${spec}" does not resolve — refusing to repair into an unknown vector space`);
  const target = { url: `${reg.baseUrl}/embeddings`, model: reg.model, apiKey: reg.apiKey, spec, matryoshka: reg.matryoshka === true };
  const pinnedCustom: RagAttempt[] = [];
  const rollCustom = (a: EmbedAttemptNote) => {
    pinnedCustom.push({ spec, ok: a.ok, ms: a.ms, errorKind: a.errorKind, status: a.status, leg: a.leg, callId: a.callId, callIdEcho: a.callIdEcho, abort: a.abort, bucket });
    recordRagTransport('rag_embed_call', { spec, ok: a.ok, ms: a.ms, errorKind: a.errorKind, status: a.status, leg: a.leg, callId: a.callId, callIdEcho: a.callIdEcho, abort: a.abort },
      { op: 'embedTextsForSpec', lane: 'pinned', batch: a.batch, unit: 'attempt', ...(a.chars !== undefined ? { chars: a.chars } : {}), ...(a.retried ? { retried: true } : {}), bucket });
  };
  const customRoll = { batchChars: totalChars(texts), batchCount: Math.ceil(texts.length / EMBED_BATCH_SIZE) };
  const t0 = Date.now();
  try {
    const vecs = await embedTextsCustom(target, texts, timeoutMs, rollCustom);
    recordRagTransport('rag_embed_call', { spec, ok: true, ms: Date.now() - t0 }, { op: 'embedTextsForSpec', lane: 'pinned', batchAttempts: pinnedCustom.length, batchFailures: pinnedCustom.filter(a => !a.ok).length, ...customRoll });
    return vecs;
  } catch (err: any) {
    recordRagTransport('rag_embed_call', { spec, ok: false, ms: Date.now() - t0, ...classifyRagError(err) }, { op: 'embedTextsForSpec', lane: 'pinned', batchAttempts: pinnedCustom.length, batchFailures: pinnedCustom.filter(a => !a.ok).length, ...customRoll });
    throw err;
  }
}

/**
 * Embed via a custom OpenAI-compatible /embeddings endpoint (embeddings role).
 * NO silent fallback to DashScope on failure: mixing embedding models mixes
 * vector spaces and silently corrupts retrieval — a broken override must
 * surface as an error, exactly like a broken DashScope call does.
 */
async function embedTextsCustom(
  target: { url: string; model: string; apiKey?: string | null; spec: string; matryoshka: boolean },
  texts: string[],
  timeoutMs: number = EMBED_HTTP_TIMEOUT_MS,
  /** Emitted once per BATCH attempt — the per-attempt denominator (2026-11-01). */
  onAttempt?: (a: EmbedAttemptNote) => void,
): Promise<number[][]> {
  const BATCH_SIZE = EMBED_BATCH_SIZE;
  const headers = { ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}), 'Content-Type': 'application/json' };
  // Some servers reject the OpenAI `dimensions` param — retry once without it
  // and latch off for the remaining batches of this call. Remember that it
  // happened: the mismatch error below says REJECTED vs IGNORED, which point
  // at different fixes (owner 2026-09-08).
  let sendDims = true;
  let dimsRejected = false;
  const allEmbeddings: number[][] = [];
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const batches = Math.ceil(texts.length / BATCH_SIZE);
  for (let i = 0, b = 0; i < texts.length; i += BATCH_SIZE, b++) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // Payload size of THIS attempt (ticket d59499f4) — the chunk/batch-sizing
    // lever is blind without it.
    const chars = totalChars(batch);
    // BOUNDED CALL, not just a bounded request. `timeoutMs` used to bound ONE
    // HTTP request while the loop could issue any number of them, so a call
    // was unbounded in practice — a prod row measured 41 263 ms against a
    // 30 000 ms "timeout". The deadline makes the WHOLE call a fixed cost.
    const remaining = deadline - Date.now();
    if (remaining < RAG_MIN_ATTEMPT_MS) {
      const err: any = new Error(`embed call exceeded its ${timeoutMs}ms budget before batch ${b + 1}/${batches}`);
      err.code = 'ECONNABORTED';
      // No request was issued, so no leg exists and `ms` is honestly 0 — but it
      // is still an attempt that WE aborted, so it is typed as one rather than
      // left indistinguishable from a provider fault (ticket b5f4d5e2).
      onAttempt?.({ ok: false, ms: 0, batch: b, chars, errorKind: 'timeout', abort: 'caller_timeout' });
      throw err;
    }
    const post = (withDims: boolean, budgetMs: number, callId: string) => axios.post(target.url, {
      input: batch,
      model: target.model,
      ...(withDims ? { dimensions: EMBEDDING_DIMS } : {}),
    }, { headers: { ...headers, [LITELLM_CALL_ID_HEADER]: callId }, timeout: budgetMs });
    // ATTEMPT-LEVEL BOUND: the call's remaining budget caps the attempt, but so
    // does EMBED_ATTEMPT_TIMEOUT_MS — a hung request must not be allowed to eat
    // a whole 30 s call budget. One bounded retry follows a timeout only (the
    // failures are bimodal, so a second draw is independent); it is never a
    // ladder, and it still has to fit the call's remaining budget.
    const retriesMax = embedAttemptRetries();
    let response: any;
    let attemptErr: any;
    let timedOut = false;
    for (let attempt = 0; attempt <= retriesMax; attempt++) {
      const left = deadline - Date.now();
      if (left < RAG_MIN_ATTEMPT_MS) break;
      const attemptBudget = Math.max(1, Math.min(EMBED_ATTEMPT_TIMEOUT_MS, left));
      // Per-ATTEMPT call id (ticket b5f4d5e2) — see embedTextsDashscope.
      const callId = randomUUID();
      const a0 = Date.now();
      try {
        response = await post(sendDims, attemptBudget, callId);
        onAttempt?.({ ok: true, ms: Date.now() - a0, batch: b, chars, retried: attempt > 0, ...attemptLeg(response?.headers, callId) });
        attemptErr = null;
        break;
      } catch (err: any) {
        const kind = classifyRagError(err);
        onAttempt?.({ ok: false, ms: Date.now() - a0, batch: b, chars, ...kind, ...attemptLeg(err?.response?.headers, callId), abort: classifyAbortReason(err) });
        attemptErr = err;
        timedOut = kind.errorKind === 'timeout';
        // Some servers reject the OpenAI `dimensions` param — retry without it
        // and latch off for the remaining batches of this call. This is a
        // CORRECTION, not a budget-drawing retry: it re-issues immediately and
        // does not consume one of the bounded timeout retries.
        if (sendDims && err?.response?.status === 400) {
          sendDims = false;
          dimsRejected = true;
          attempt -= 1;
          continue;
        }
        // Only a TIMEOUT is worth the bounded retry; a provider rejection or a
        // 5xx fails the same way again and would only burn calls.
        if (!timedOut) break;
      }
    }
    if (!response) {
      if (timedOut) {
        // Re-shape so the CALL-level row reads as a timeout, not "network" —
        // and keep the literal word "timeout" in the message, which is what
        // callers, classifyRagError and the log sweep match on.
        const e: any = new Error(`embed attempt timeout after ${EMBED_ATTEMPT_TIMEOUT_MS}ms (batch ${b + 1}/${batches}, ${retriesMax + 1} attempt(s))`);
        e.code = 'ECONNABORTED';
        throw markEmbedLane(e, 'custom');
      }
      throw markEmbedLane(attemptErr ?? new Error(`embed attempt failed for batch ${b + 1}/${batches}`), 'custom');
    }
    const embeddings = (response.data?.data ?? [])
      .sort((a: any, b: any) => a.index - b.index)
      .map((item: any) => item.embedding as number[])
      .map((vec: number[]) => {
        if (Array.isArray(vec) && vec.length === EMBEDDING_DIMS) return vec;
        // Admin-flagged MRL model returning its native (longer) vector: the
        // client-side truncate+normalize IS the `dimensions` operation.
        if (Array.isArray(vec) && target.matryoshka && vec.length > EMBEDDING_DIMS) return truncateMatryoshka(vec, EMBEDDING_DIMS);
        const n = Array.isArray(vec) ? vec.length : 0;
        throw new Error(
          `Custom embeddings endpoint "${target.spec}" returned ${n || 'no'} dimensions (the server ${dimsRejected ? 'REJECTED' : 'ignored'} the dimensions=${EMBEDDING_DIMS} request) — the vector store is pinned to ${EMBEDDING_DIMS}. `
          + (n > EMBEDDING_DIMS
            ? `If this is an MRL-trained model (Qwen3-Embedding, text-embedding-3…) flag it "MRL" on its endpoint entry so Digby truncates client-side; otherwise make the server honor dimensions (vLLM: --hf-overrides '{"is_matryoshka": true}') or pick a ${EMBEDDING_DIMS}-dim model. `
            : `Pick a model that outputs ${EMBEDDING_DIMS} dims. `)
          + 'Fix or clear the embeddings model role (Account → Admin → Endpoints).',
        );
      });
    allEmbeddings.push(...embeddings);
  }
  return allEmbeddings;
}

/**
 * Embed texts using Qwen text-embedding-v4 via Alibaba DashScope.
 * Used by the open source pipeline. DashScope compatible-mode is OpenAI-compatible.
 * `dimensions: 1536` keeps the vectors compatible with the pgvector(1536) column.
 * NOTE: DashScope caps embedding inputs at 10 per request, so we batch in 10s
 * (vs 100 for OpenAI).
 */
async function embedTextsDashscope(
  texts: string[],
  timeoutMs: number = EMBED_HTTP_TIMEOUT_MS,
  /** Emitted once per BATCH attempt — the per-attempt denominator (2026-11-01). */
  onAttempt?: (a: EmbedAttemptNote) => void,
): Promise<number[][]> {
  const BATCH_SIZE = EMBED_BATCH_SIZE;
  const allEmbeddings: number[][] = [];
  const deadline = Date.now() + Math.max(1, timeoutMs);
  const batches = Math.ceil(texts.length / BATCH_SIZE);

  for (let i = 0, b = 0; i < texts.length; i += BATCH_SIZE, b++) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    // Payload size of THIS attempt (ticket d59499f4) — the chunk/batch-sizing
    // lever is blind without it.
    const chars = totalChars(batch);
    // Same per-attempt bound as the custom lane: the call budget caps the whole
    // call (this loop included), the attempt cap caps ONE hung request.
    let response: any;
    let attemptErr: any;
    let timedOut = false;
    const retriesMax = embedAttemptRetries();
    for (let attempt = 0; attempt <= retriesMax; attempt++) {
      const left = deadline - Date.now();
      if (left < RAG_MIN_ATTEMPT_MS) break;
      // Per-ATTEMPT call id (ticket b5f4d5e2): the gateway echoes this back, so
      // an attempt that WE abort still has a join key into the gateway's own
      // log — the one thing that makes a caller-side timeout attributable.
      const callId = randomUUID();
      const a0 = Date.now();
      try {
        response = await axios.post(
          DASHSCOPE_EMBEDDING_URL,
          {
            input: batch,
            model: DASHSCOPE_EMBEDDING_MODEL,
            dimensions: 1536,
          },
          {
            headers: {
              'Authorization': `Bearer ${DASHSCOPE_API_KEY}`,
              'Content-Type': 'application/json',
              [LITELLM_CALL_ID_HEADER]: callId,
            },
            timeout: Math.max(1, Math.min(EMBED_ATTEMPT_TIMEOUT_MS, left)),
          }
        );
        // THE GATEWAYLESS ASSERTION — this function posts to the literal
        // DASHSCOPE_EMBEDDING_URL, so no LiteLLM hop can exist in front and no
        // `x-litellm-*` header can ever arrive. Written on the SUCCESS row too,
        // so the key's absence on a failure is itself meaningful.
        onAttempt?.({ ok: true, ms: Date.now() - a0, batch: b, chars, retried: attempt > 0, ...attemptLeg(response?.headers, callId), gwless: EMBED_GWLESS_DIRECT });
        attemptErr = null;
        break;
      } catch (err: any) {
        const kind = classifyRagError(err);
        // A gateway-answered error still names its leg in `err.response.headers`;
        // a caller abort has no response, so the leg is absent and `callId` is
        // the only correlator. Both facts are recorded, never inferred later.
        onAttempt?.({ ok: false, ms: Date.now() - a0, batch: b, chars, ...kind, ...attemptLeg(err?.response?.headers, callId), abort: classifyAbortReason(err), gwless: EMBED_GWLESS_DIRECT });
        attemptErr = err;
        timedOut = kind.errorKind === 'timeout';
        if (!timedOut) break;
      }
    }
    if (!response) {
      if (timedOut) {
        // Re-shape so the CALL-level row reads as a timeout, not "network" —
        // and keep the literal word "timeout", which classifyRagError, callers
        // and the log sweep all match on.
        const e: any = new Error(`dashscope embed attempt timeout after ${EMBED_ATTEMPT_TIMEOUT_MS}ms (batch ${b + 1}/${batches}, ${retriesMax + 1} attempt(s))`);
        e.code = 'ECONNABORTED';
        // THE GATEWAYLESS ASSERTION (supervisor ruling 2026-11-04): this
        // function posts to the LITERAL DASHSCOPE_EMBEDDING_URL constant, so no
        // LiteLLM hop exists and no `x-litellm-*` header can ever arrive on a
        // failure. Stamping the lane HERE — where the URL is chosen — is what
        // lets the attribution rule distinguish this from a gatewayed lane
        // whose gateway omitted its headers.
        throw markEmbedLane(e, 'dashscope');
      }
      throw markEmbedLane(attemptErr ?? new Error(`dashscope embed attempt failed for batch ${b + 1}/${batches}`), 'dashscope');
    }

    const embeddings = response.data.data
      .sort((a: any, b2: any) => a.index - b2.index)
      .map((item: any) => item.embedding as number[]);

    allEmbeddings.push(...embeddings);
  }

  return allEmbeddings;
}

// ── Storage ───────────────────────────────────────────────────────────────────

/**
 * Self-host honesty (2026-10-26): is ANY embeddings backend configured — a
 * custom endpoint on the embeddings seat, or the built-in DashScope key?
 * Pure config read (no network): crons and callers use it to idle quietly on
 * a keyless instance instead of burning a doomed call per row (the
 * memory-embed-backfill gate).
 */
export async function embeddingsBackendConfigured(): Promise<boolean> {
  if (DASHSCOPE_API_KEY) return true;
  try {
    return !!(await roleEndpointTarget('embeddings', '/embeddings'));
  } catch {
    return true; // fail-open — never idle a configured instance on a read hiccup
  }
}

/**
 * Store chunks with their embeddings in the project_chunks table.
 * Uses raw SQL because Prisma doesn't natively support pgvector columns.
 */
export async function storeChunks(
  documentId: string,
  projectId: string | null,
  userId: string,
  chunks: RAGChunk[],
  embeddings: number[][]
): Promise<void> {
  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk/embedding count mismatch: ${chunks.length} vs ${embeddings.length}`);
  }

  // Insert chunks in batches of 50 using raw SQL.
  // Optimization: single multi-row VALUES INSERT per batch instead of N individual inserts.
  // For a 100-chunk document: 2 queries instead of 100 — ~50x faster, holds DB connection
  // for a fraction of the time.
  const BATCH_SIZE = 50;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batchChunks = chunks.slice(i, i + BATCH_SIZE);
    const batchEmbeddings = embeddings.slice(i, i + BATCH_SIZE);

    // Build multi-row VALUES clause — one INSERT for the entire batch
    const valueClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    for (let j = 0; j < batchChunks.length; j++) {
      const chunk = batchChunks[j];
      const embedding = batchEmbeddings[j];
      const vectorStr = `[${embedding.join(',')}]`;

      valueClauses.push(
        `(gen_random_uuid()::text, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}::vector, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}::jsonb)`
      );
      params.push(
        documentId,
        projectId,
        userId,
        // Postgres TEXT/JSONB rejects 0x00 (error 22021) — one stray NUL from
        // extracted document text would poison the whole 50-row batch (issue #90).
        stripNulBytes(chunk.content),
        vectorStr,
        chunk.chunkIndex,
        chunk.tokenCount,
        // Strip raw NULs from string values BEFORE serialization: a raw NUL
        // breaks jsonb as 0x00 (22021) and its JSON-escaped form breaks it as
        // 22P05. Pre-serialization stripping is escape-parity-safe — a filename
        // containing the literal TEXT backslash-u0000 survives untouched.
        JSON.stringify(chunk.metadata, (_k, v) => (typeof v === 'string' ? stripNulBytes(v) : v))
      );
    }

    await prisma.$executeRawUnsafe(
      `INSERT INTO project_chunks (id, "documentId", "projectId", "userId", content, embedding, "chunkIndex", "tokenCount", metadata)
       VALUES ${valueClauses.join(', ')}`,
      ...params
    );
  }

  logger.info(`Stored ${chunks.length} chunks for document ${documentId}`);
}

// ── Retrieval ─────────────────────────────────────────────────────────────────

// Blended account-wide RAG (owner decision 2026-08-13): every chat retrieves
// from ALL projects the user OWNS, with the current scope's chunks BOOSTED.
// The global arm caps its candidates (context-size guard), carries a lower RRF
// weight so in-scope hits outrank equal-rank outsiders, and — because the
// qwen3 reranker is content-only — out-of-scope chunks are ALSO capped to a
// minority of the final top-K whenever in-scope results can fill the rest.
const GLOBAL_ARM_LIMIT = 10;    // per-arm candidate cap for the cross-project (global) queries
const GLOBAL_RRF_WEIGHT = 0.75; // out-of-scope rank weight (in-scope arms = 1.0)
/** Max out-of-scope rows in the final top-K when in-scope rows exist (e.g. 2 of 5). */
const maxGlobalSlots = (topK: number): number => Math.max(1, Math.floor(topK * 0.4));

/**
 * Retrieve relevant chunks for a query using hybrid search + reranking.
 *
 * 1. Semantic search: pgvector cosine similarity → top 20
 * 2. Keyword search: PostgreSQL tsvector BM25-like → top 20
 * 3. (with userId) Global arm: the same two searches over the OTHER projects
 *    the user OWNS — double-gated (project owned by the user AND chunk.userId
 *    = the user, so docs someone else uploaded into a shared project NEVER
 *    follow the user out of that project) and capped at GLOBAL_ARM_LIMIT
 * 4. RRF merge: weighted Reciprocal Rank Fusion (global arm at 0.75)
 * 5. DashScope qwen3-rerank → final top-K with out-of-scope rows capped to a
 *    minority share; cross-project chunks carry sourceProjectName for labeling
 *
 * @param embeddingProvider Retained for signature compatibility; ignored. All
 *   embeddings now use DashScope text-embedding-v4 (RAG is open-source-only).
 * @param userId When set, blends in chunks from the user's OTHER owned
 *   projects (never another user's, never member-shared projects). Omitted =
 *   exact pre-blend scoped behavior (anonymous/legacy callers unchanged).
 */
export async function retrieveChunks(
  query: string,
  projectId: string,
  topK: number = 5,
  embeddingProvider: EmbeddingProvider = 'dashscope',
  ancestorProjectIds: string[] = [],
  userId?: string
): Promise<RetrievedChunk[]> {
  try {
    // P2 folder tree: with ancestors in scope (inheritance flag on), chunk
    // filters widen from `= projectId` to `= ANY(scope)` so knowledge filed in
    // ancestor folders is retrievable from descendants. Single-folder scope
    // keeps the exact pre-P2 queries.
    const scopeIds = [projectId, ...ancestorProjectIds.filter((id) => id && id !== projectId)];
    const scoped = scopeIds.length > 1;

    // Step 1: Embed the query using the specified provider
    const [queryEmbedding] = await embedTexts([query], embeddingProvider);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    // Step 2: Semantic search (pgvector cosine)
    const semanticResults: any[] = scoped
      ? await prisma.$queryRawUnsafe(`
        SELECT
          pc.id,
          pc."documentId",
          pd.name as "documentName",
          pd."mimeType",
          pc.content,
          pc."chunkIndex",
          pc.metadata,
          (1 - (pc.embedding <=> $1::vector)) as score
        FROM project_chunks pc
        JOIN project_documents pd ON pd.id = pc."documentId"
        WHERE pc."projectId" = ANY($2::text[])
        ORDER BY pc.embedding <=> $1::vector
        LIMIT 20
      `, vectorStr, scopeIds)
      : await prisma.$queryRawUnsafe(`
      SELECT
        pc.id,
        pc."documentId",
        pd.name as "documentName",
        pd."mimeType",
        pc.content,
        pc."chunkIndex",
        pc.metadata,
        (1 - (pc.embedding <=> $1::vector)) as score
      FROM project_chunks pc
      JOIN project_documents pd ON pd.id = pc."documentId"
      WHERE pc."projectId" = $2
      ORDER BY pc.embedding <=> $1::vector
      LIMIT 20
    `, vectorStr, projectId);

    // Step 3: Keyword search (tsvector BM25-like)
    const keywordResults: any[] = scoped
      ? await prisma.$queryRawUnsafe(`
        SELECT
          pc.id,
          pc."documentId",
          pd.name as "documentName",
          pd."mimeType",
          pc.content,
          pc."chunkIndex",
          pc.metadata,
          ts_rank(to_tsvector('english', pc.content), plainto_tsquery('english', $1)) as score
        FROM project_chunks pc
        JOIN project_documents pd ON pd.id = pc."documentId"
        WHERE pc."projectId" = ANY($2::text[])
          AND to_tsvector('english', pc.content) @@ plainto_tsquery('english', $1)
        ORDER BY score DESC
        LIMIT 20
      `, query, scopeIds)
      : await prisma.$queryRawUnsafe(`
      SELECT
        pc.id,
        pc."documentId",
        pd.name as "documentName",
        pd."mimeType",
        pc.content,
        pc."chunkIndex",
        pc.metadata,
        ts_rank(to_tsvector('english', pc.content), plainto_tsquery('english', $1)) as score
      FROM project_chunks pc
      JOIN project_documents pd ON pd.id = pc."documentId"
      WHERE pc."projectId" = $2
        AND to_tsvector('english', pc.content) @@ plainto_tsquery('english', $1)
      ORDER BY score DESC
      LIMIT 20
    `, query, projectId);

    // Step 3b: Global arm (blended account-wide RAG) — the user's OTHER owned
    // projects. Isolation is double-gated in SQL: the project must be OWNED by
    // the requesting user (owned-ids filter) AND the chunk's own userId must
    // match — so another user's documents, and documents in projects merely
    // SHARED with this user, can never surface here (shared-project docs stay
    // retrievable only via the in-scope arm when chatting inside that project).
    let globalSemantic: any[] = [];
    let globalKeyword: any[] = [];
    const globalProjectNameById = new Map<string, string>();
    if (userId) {
      const owned = await prisma.crossModelProject.findMany({
        // Archived folders leave the blended cross-project arm (search-defaults
        // rule; their docs stay retrievable in-scope when chatting inside them).
        where: { userId, archivedAt: null },
        select: { id: true, name: true },
      });
      for (const p of owned) globalProjectNameById.set(p.id, p.name);
      const scopeSet = new Set(scopeIds);
      const outsideIds = owned.map((p) => p.id).filter((id) => !scopeSet.has(id));
      if (outsideIds.length > 0) {
        [globalSemantic, globalKeyword] = await Promise.all([
          prisma.$queryRawUnsafe(`
            SELECT pc.id, pc."documentId", pc."projectId", pd.name as "documentName", pd."mimeType",
                   pc.content, pc."chunkIndex", pc.metadata,
                   (1 - (pc.embedding <=> $1::vector)) as score
            FROM project_chunks pc
            JOIN project_documents pd ON pd.id = pc."documentId"
            WHERE pc."projectId" = ANY($2::text[]) AND pc."userId" = $3
            ORDER BY pc.embedding <=> $1::vector
            LIMIT ${GLOBAL_ARM_LIMIT}
          `, vectorStr, outsideIds, userId) as Promise<any[]>,
          prisma.$queryRawUnsafe(`
            SELECT pc.id, pc."documentId", pc."projectId", pd.name as "documentName", pd."mimeType",
                   pc.content, pc."chunkIndex", pc.metadata,
                   ts_rank(to_tsvector('english', pc.content), plainto_tsquery('english', $1)) as score
            FROM project_chunks pc
            JOIN project_documents pd ON pd.id = pc."documentId"
            WHERE pc."projectId" = ANY($2::text[]) AND pc."userId" = $3
              AND to_tsvector('english', pc.content) @@ plainto_tsquery('english', $1)
            ORDER BY score DESC
            LIMIT ${GLOBAL_ARM_LIMIT}
          `, query, outsideIds, userId) as Promise<any[]>,
        ]);
      }
    }
    // id → source projectId for the out-of-scope candidates (rerank drops extra fields).
    const globalProjectIdByChunk = new Map<string, string>(
      [...globalSemantic, ...globalKeyword].map((r: any) => [r.id, r.projectId])
    );

    // Step 4: weighted RRF merge — in-scope arms outrank the global arm at
    // equal ranks (the "current project boosted" half of the blend).
    const merged = weightedReciprocalRankFusion([
      { rows: semanticResults, weight: 1 },
      { rows: keywordResults, weight: 1 },
      { rows: globalSemantic, weight: GLOBAL_RRF_WEIGHT },
      { rows: globalKeyword, weight: GLOBAL_RRF_WEIGHT },
    ]);

    // No chunks found
    if (merged.length === 0) {
      return [];
    }

    // Step 5: Rerank with DashScope qwen3-rerank (if key available and enough
    // candidates). With global candidates in the mix, ask for a little slack
    // beyond topK so the composition cap below still has in-scope rows to
    // promote when outsiders win the cross-encoder.
    const rerankN = Math.min(
      globalProjectIdByChunk.size > 0 ? topK + maxGlobalSlots(topK) + 2 : topK,
      merged.length
    );
    let ranked: RetrievedChunk[];
    if (merged.length > 1 && (await rerankAvailable())) {
      ranked = await dashscopeRerank(query, merged, rerankN);
    } else {
      ranked = merged.slice(0, rerankN).map((r, i) => ({
        id: r.id,
        documentId: r.documentId,
        documentName: r.documentName,
        mimeType: r.mimeType,
        content: r.content,
        chunkIndex: r.chunkIndex,
        relevanceScore: 1 - i * 0.1, // synthetic score
        metadata: r.metadata,
      }));
    }

    // Step 5b: composition cap + labels — the reranker is content-only, so the
    // scope boost must bite here: out-of-scope rows take at most a minority of
    // the final top-K (they may still backfill when in-scope rows can't fill
    // it), and every cross-project row is labeled with its source project.
    ranked = composeWithGlobalCap(ranked, globalProjectIdByChunk, globalProjectNameById, topK);

    // Step 6: neighbor expansion — chunking splits headings/preconditions from
    // their bodies; pull each winner's adjacent chunks back so answers aren't
    // built from lonely mid-section paragraphs (Cerebras-style context re-add).
    return await expandWithNeighbors(ranked, projectId, topK);
  } catch (err: any) {
    // Ticket 9cd30d58 (log-signal family 5ae52ca3): DashScope/pgvector degradation
    // the caller is DESIGNED to survive (returns [] — callers answer from history).
    // Two fixes in one: the old `logger.error('retrieveChunks error:', err.message)`
    // passed the detail as a winston splat that never reached the persisted message
    // (the sweep fingerprint ended in a bare colon — the detail was untriageable),
    // and the untagged error level made designed degradation sweep-file as a defect.
    // logExternal: warn + logClass:'external' — rows stay queryable for the audit
    // detector's known-signature pins (f184 bb77c1b9a) but the sweep drops them.
    logExternal(`retrieveChunks error: ${err?.message ?? err} — caller degrades to no-retrieval (returns [])`);
    return [];
  }
}

/**
 * Final blend composition: walk the reranked list in order, admitting in-scope
 * chunks freely and out-of-scope (global) chunks only up to maxGlobalSlots —
 * then backfill with the skipped outsiders if in-scope rows couldn't fill topK
 * (a question genuinely about another project's content still gets answered).
 * Out-of-scope survivors get sourceProjectName attached for labeling.
 */
function composeWithGlobalCap(
  ranked: RetrievedChunk[],
  globalProjectIdByChunk: Map<string, string>,
  globalProjectNameById: Map<string, string>,
  topK: number
): RetrievedChunk[] {
  if (globalProjectIdByChunk.size === 0) return ranked.slice(0, topK);
  const cap = maxGlobalSlots(topK);
  const out: RetrievedChunk[] = [];
  let globals = 0;
  for (const c of ranked) {
    if (out.length >= topK) break;
    if (globalProjectIdByChunk.has(c.id)) {
      if (globals >= cap) continue;
      globals++;
    }
    out.push(c);
  }
  if (out.length < topK) {
    for (const c of ranked) {
      if (out.length >= topK) break;
      if (!out.includes(c)) out.push(c);
    }
  }
  return out.map((c) => {
    const srcProjectId = globalProjectIdByChunk.get(c.id);
    if (!srcProjectId) return c;
    return { ...c, sourceProjectName: globalProjectNameById.get(srcProjectId) || 'another project' };
  });
}

/**
 * For the top winners, fetch chunkIndex ±1 from the same document and splice
 * them in (deduped, capped at topK + 4 total). Neighbors inherit a slightly
 * lower score so downstream ordering keeps the true match first. Best-effort:
 * any failure returns the ranked list unchanged.
 */
async function expandWithNeighbors(
  ranked: RetrievedChunk[],
  projectId: string,
  topK: number
): Promise<RetrievedChunk[]> {
  try {
    const winners = ranked.slice(0, 3).filter(r => typeof r.chunkIndex === 'number');
    if (!winners.length) return ranked;
    const wanted: Array<{ documentId: string; idx: number; parentScore: number; sourceProjectName?: string }> = [];
    for (const w of winners) {
      for (const idx of [w.chunkIndex - 1, w.chunkIndex + 1]) {
        if (idx < 0) continue;
        if (ranked.some(r => r.documentId === w.documentId && r.chunkIndex === idx)) continue;
        wanted.push({ documentId: w.documentId, idx, parentScore: w.relevanceScore ?? 0, sourceProjectName: w.sourceProjectName });
      }
    }
    if (!wanted.length) return ranked;
    const conds = wanted.map((_, i) => `(pc."documentId" = $${i * 2 + 1} AND pc."chunkIndex" = $${i * 2 + 2})`).join(' OR ');
    const params = wanted.flatMap(w => [w.documentId, w.idx]);
    const rows: any[] = await prisma.$queryRawUnsafe(`
      SELECT pc.id, pc."documentId", pd.name as "documentName", pd."mimeType",
             pc.content, pc."chunkIndex", pc.metadata
      FROM project_chunks pc
      JOIN project_documents pd ON pd.id = pc."documentId"
      WHERE ${conds}
    `, ...params);
    const out = [...ranked];
    for (const r of rows) {
      if (out.length >= topK + 4) break;
      if (out.some(c => c.id === r.id)) continue;
      const parent = wanted.find(w => w.documentId === r.documentId && w.idx === r.chunkIndex);
      out.push({
        id: r.id, documentId: r.documentId, documentName: r.documentName, mimeType: r.mimeType,
        content: r.content, chunkIndex: r.chunkIndex,
        relevanceScore: Math.max(0, (parent?.parentScore ?? 0) - 0.05), // just below its winner
        metadata: r.metadata,
        // Neighbors of a cross-project winner keep its source-project label.
        ...(parent?.sourceProjectName ? { sourceProjectName: parent.sourceProjectName } : {}),
      });
    }
    return out;
  } catch {
    return ranked;
  }
}

/**
 * Account-wide retrieval for a chat with NO project (plain sidebar chat) —
 * blended-RAG bonus (owner decision 2026-08-13): an authed user's knowledge
 * base follows them everywhere. Searches every project the user OWNS (never
 * another user's, never member-shared projects — those stay in-project), with
 * the same chunk-level userId double-gate as retrieveChunks' global arm.
 * Every returned chunk is labeled with its source project name.
 *
 * (This subsumes the old per-project opt-in retrieveCrossProjectChunks path —
 * cross-project knowledge is now blended into retrieveChunks itself.)
 */
export async function retrieveGlobalChunks(
  query: string,
  userId: string,
  topK: number = 5,
  embeddingProvider: EmbeddingProvider = 'dashscope',
): Promise<RetrievedChunk[]> {
  try {
    const owned = await prisma.crossModelProject.findMany({
      // Archived folders leave global knowledge search (search-defaults rule).
      where: { userId, archivedAt: null },
      select: { id: true, name: true },
    });
    if (owned.length === 0) return [];
    const ownedIds = owned.map(p => p.id);
    const nameById = new Map(owned.map(p => [p.id, p.name]));

    const [queryEmbedding] = await embedTexts([query], embeddingProvider);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    const semanticResults: any[] = await prisma.$queryRawUnsafe(`
      SELECT pc.id, pc."documentId", pc."projectId", pd.name as "documentName", pd."mimeType",
             pc.content, pc."chunkIndex", pc.metadata,
             (1 - (pc.embedding <=> $1::vector)) as score
      FROM project_chunks pc
      JOIN project_documents pd ON pd.id = pc."documentId"
      WHERE pc."projectId" = ANY($2::text[]) AND pc."userId" = $3
      ORDER BY pc.embedding <=> $1::vector
      LIMIT 20
    `, vectorStr, ownedIds, userId);

    const keywordResults: any[] = await prisma.$queryRawUnsafe(`
      SELECT pc.id, pc."documentId", pc."projectId", pd.name as "documentName", pd."mimeType",
             pc.content, pc."chunkIndex", pc.metadata,
             ts_rank(to_tsvector('english', pc.content), plainto_tsquery('english', $1)) as score
      FROM project_chunks pc
      JOIN project_documents pd ON pd.id = pc."documentId"
      WHERE pc."projectId" = ANY($2::text[]) AND pc."userId" = $3
        AND to_tsvector('english', pc.content) @@ plainto_tsquery('english', $1)
      ORDER BY score DESC
      LIMIT 20
    `, query, ownedIds, userId);

    const merged = reciprocalRankFusion(semanticResults, keywordResults);
    if (merged.length === 0) return [];

    // Preserve each chunk's source projectId across the rerank (dashscopeRerank drops extra fields).
    const projectIdByChunk = new Map<string, string>(merged.map((c: any) => [c.id, c.projectId]));

    let ranked: RetrievedChunk[];
    if (merged.length > 1 && (await rerankAvailable())) {
      ranked = await dashscopeRerank(query, merged, Math.min(topK, merged.length));
    } else {
      ranked = merged.slice(0, topK).map((r: any, i: number) => ({
        id: r.id, documentId: r.documentId, documentName: r.documentName, mimeType: r.mimeType,
        content: r.content, chunkIndex: r.chunkIndex, relevanceScore: 1 - i * 0.1, metadata: r.metadata,
      }));
    }

    // Attach the source project label — in a project-less chat EVERY chunk is
    // cross-project, so every entry gets attributed.
    return ranked.slice(0, topK).map(c => ({
      ...c,
      sourceProjectName: nameById.get(projectIdByChunk.get(c.id) || '') || 'another project',
    }));
  } catch (err: any) {
    // Ticket 9cd30d58 sibling (same family/class): designed degradation — the
    // global arm returns [] and retrieval proceeds on the in-scope arm. Was a
    // splat-shaped untagged logger.error (detail lost, sweep-filed as a defect).
    logExternal(`retrieveGlobalChunks error: ${err?.message ?? err} — caller degrades to in-scope retrieval only (returns [])`);
    return [];
  }
}

/**
 * Build a clearly-labeled context block for cross-project knowledge. The model is told it comes
 * from a DIFFERENT project and to attribute it — so cross-project blending never reads as the
 * current chat being about those topics. `header` defaults to the other-projects wording; a
 * project-less chat passes its own (e.g. 'RELEVANT CONTEXT FROM YOUR PROJECTS').
 */
export function buildCrossProjectBlock(
  chunks: RetrievedChunk[],
  header: string = 'RELEVANT CONTEXT FROM YOUR OTHER PROJECTS'
): string {
  if (chunks.length === 0) return '';
  const lines: string[] = [];
  lines.push(`═══ ${header} ═══`);
  lines.push(`(Surfaced because it is relevant to THIS question but lives in a DIFFERENT project. Use it only if genuinely helpful, and attribute it to the named project. Do NOT assume the current project is about these topics.)`);
  lines.push('');
  chunks.forEach((chunk, i) => {
    const icon = chunk.mimeType === 'url' ? '🌐' : '📄';
    const source = chunk.mimeType === 'url'
      ? (chunk.metadata?.sourceUrl || chunk.documentName)
      : chunk.documentName;
    const score = (chunk.relevanceScore * 100).toFixed(0);
    lines.push(`[${i + 1}] ${icon} ${source} — from project "${chunk.sourceProjectName}" (relevance ${score}%)`);
    lines.push(chunk.content.substring(0, 800) + (chunk.content.length > 800 ? '...' : ''));
    if (i < chunks.length - 1) lines.push('');
  });
  lines.push('═══════════════════════');
  return lines.join('\n');
}

/**
 * Reciprocal Rank Fusion — merges semantic and keyword rankings.
 * score = 1/(60 + rank_semantic) + 1/(60 + rank_keyword)
 */
function reciprocalRankFusion(
  semanticResults: any[],
  keywordResults: any[]
): any[] {
  return weightedReciprocalRankFusion([
    { rows: semanticResults, weight: 1 },
    { rows: keywordResults, weight: 1 },
  ]);
}

/**
 * Weighted RRF over any number of ranked arms: score = Σ weight/(60 + rank + 1).
 * The blended retrieval runs its global (cross-project) arms at weight 0.75 so
 * an in-scope chunk beats an out-of-scope one holding the same ranks.
 */
function weightedReciprocalRankFusion(
  arms: Array<{ rows: any[]; weight: number }>
): any[] {
  const K = 60;
  const scores = new Map<string, { chunk: any; score: number }>();

  for (const { rows, weight } of arms) {
    rows.forEach((chunk, rank) => {
      const rrfScore = weight / (K + rank + 1);
      const existing = scores.get(chunk.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(chunk.id, { chunk, score: rrfScore });
      }
    });
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ chunk }) => chunk);
}

// Alibaba DashScope rerank (Qwen3 reranker). Open-source-only reranker.
// IMPORTANT: the international (Singapore) region serves rerank at the
// /compatible-api/v1/reranks endpoint (flat Cohere-style body) with model
// `qwen3-rerank` — NOT the Beijing native /api/v1/services/rerank/... path,
// and NOT gte-rerank-v2 (which 404s on the intl endpoint for this key).
const DASHSCOPE_RERANK_URL = 'https://dashscope-intl.aliyuncs.com/compatible-api/v1/reranks';
const DASHSCOPE_RERANK_MODEL = 'qwen3-rerank';

// ── Transport rotation ladder (2026-11-01, RAG transport incident) ───────────
//
// THE INCIDENT. The `llm-cql` gateway served /v1/models in 131 ms and answered
// /chat/completions in 133 ms, while /v1/rerank and /v1/embeddings HUNG — no
// response at 40 s and 90 s, with a valid key (an unauthenticated call is
// rejected in 235 ms, so the hang is past auth, in the upstream worker). The
// seats still read "resolving, servable, recentFailures 0" because seat health
// is judged from the flight log, never from a transport probe.
//
// 689 rerank timeouts / 24 h (143 in the last 6 h) were the visible half. The
// rotating ladder below is the fix: ONE target was a single point of failure,
// so a dead route degraded silently to "caller keeps its own order" (rerank)
// or "stored keyword-only" (embed) and nothing measured the failure.
//
// A target that fails is SKIPPED, not fatal: the next rung serves. Only when
// every rung fails does the call surface the failure — so the rerank contract
// (null ⇒ caller keeps its order) is preserved, and the embed contract (throw)
// is preserved, but both now mean "ALL providers failed", not "the one we use
// was down".

/** One rung of the ladder — a concrete endpoint to POST against. */
export interface RagTarget {
  url: string;
  model: string;
  apiKey?: string | null;
  /** Stable identity for telemetry, e.g. `llm-cql:Qwen3-Reranker-4B`. */
  spec: string;
  matryoshka?: boolean;
}

/**
 * WHY ONE ATTEMPT ENDED — typed, in the caller's own terms (ticket b5f4d5e2).
 *
 * The untyped signal this replaces was ambiguous in exactly the way that cost a
 * P1 investigation: `errorKind:'timeout'` on a row cannot say whether the
 * PROVIDER timed out (the gateway answered 504, and it has a leg to name) or
 * whether OUR OWN per-attempt bound fired first (no response ever arrived, so
 * no leg exists at any layer the fleet can read). Those two are different bugs
 * with different fixes, and the 2026-11-02 lane proved the second one can run
 * at a 47 % rate while the gateway logs 100 % 200s — visible only if the row
 * says which side aborted.
 *
 *   - `caller_timeout`  — WE aborted: our per-attempt/call bound fired, no
 *                         response was received. The provider may well have
 *                         served it (the gateway logs a 200 that nobody read).
 *   - `provider_error`  — the provider/gateway ANSWERED with a non-2xx.
 *   - `parse_failure`   — a 2xx arrived but its body was unusable (wrong
 *                         dimensionality, empty results) — never a transport fault.
 *   - `network`         — transport died with no response and no timeout
 *                         (ECONNRESET/ENOTFOUND/TLS): distinct from our own abort.
 *   - `unknown`         — none of the above; kept explicit rather than guessed.
 */
export type RagAbortReason = 'caller_timeout' | 'provider_error' | 'parse_failure' | 'network' | 'unknown';

/**
 * PER-ATTEMPT ATTRIBUTION (ticket b5f4d5e2): which leg served this attempt, by
 * what duration, aborted by whom.
 *
 * `leg` is read from the gateway's OWN response headers — `x-litellm-model-api-base`
 * (the upstream that actually answered; this is what distinguishes AGX from
 * spark-a367) and `x-litellm-model-id` (the deployment uuid). Both are emitted
 * by default by the LiteLLM proxy on a 200, and it emits `x-litellm-model-id`
 * on an error response too. It emits NOTHING on a caller-side abort — no
 * response exists — which is why the caller also SENDS `x-litellm-call-id`: on
 * a `caller_timeout` row the leg is recoverable server-side by that id, and the
 * row says so instead of quietly implying the leg was never involved.
 *
 * Deliberately transport-shaped (a string + a short enum), not a bag: the fleet
 * telemetry view truncates `meta` at 240 chars, so every field here has to earn
 * its space next to `proc` and `target`.
 */
export interface RagAttemptLeg {
  /** Deployment identity that served the attempt, e.g. `agx-a:8001` or
   *  `id:1f2e3d4c`. Absent when nothing identified it (a caller abort, or a
   *  direct-to-provider lane with no gateway in front). */
  leg?: string;
  /** The gateway call id this attempt used/was answered under. On a caller
   *  abort this is the ONLY join key back to the gateway's own logs. */
  callId?: string;
  /** Present only when the gateway echoed a DIFFERENT id than the one we sent —
   *  a rewritten id is not a key we can prove we originated, so ours wins and
   *  the divergence is recorded rather than silently overwritten. */
  callIdEcho?: string;
}

/**
 * The attribution for ONE attempt: the response-derived leg, with the call id WE
 * SENT kept authoritative (adversarial review 2026-11-02, N6).
 *
 * The header-derived object carries its own `callId` from the gateway's echo, so
 * a plain `{ callId, ...leg }` spread would let the echo silently overwrite the
 * id we logged. The whole value of this field is that it is a join key we can
 * PROVE we sent — an id the proxy rewrote (or mangled to its own cap) is not
 * that, so ours wins and the divergence is recorded rather than lost.
 */
function attemptLeg(headers: any, sentCallId: string): RagAttemptLeg {
  const echoed = legFromResponseHeaders(headers);
  return {
    ...echoed,
    callId: sentCallId,
    ...(echoed.callId && echoed.callId !== sentCallId ? { callIdEcho: echoed.callId } : {}),
  };
}

/** How one attempt ended — the measurable signal that replaces the bare warn. */
export interface RagAttempt extends RagAttemptLeg {
  spec: string;
  ok: boolean;
  ms: number;
  errorKind?: 'timeout' | 'auth' | 'http_4xx' | 'http_5xx' | 'network' | 'empty' | 'dims';
  status?: number;
  /** Typed end reason (ticket b5f4d5e2). Present on failures; success leaves it out. */
  abort?: RagAbortReason;
  /**
   * WHICH embed flow attempted the call (goal 4e432dff) — the write-time
   * `bucket` dimension. Every emit path stamps it, so a failure row is
   * attributable to a flow even when the leg is legitimately absent.
   */
  bucket?: EmbedBucket;
}

/** The gateway headers that name the leg, in ONE place — the spelling is the
 *  wire contract, so it must not be re-typed at each call site. */
const LEG_HEADER_API_BASE = 'x-litellm-model-api-base';
const LEG_HEADER_MODEL_ID = 'x-litellm-model-id';
const LEG_HEADER_MODEL_NAME = 'x-litellm-model-name';
/** Request header the proxy ECHOES back (`resolve_litellm_call_id`). Supplying
 *  it is what makes an attempt recoverable when we — not the provider — abort. */
export const LITELLM_CALL_ID_HEADER = 'x-litellm-call-id';

/** Case-insensitive header read that works for an axios response, a Headers
 *  object, and a plain object (tests, and gateways that do not send the
 *  header). A genuine key scan rather than a `toUpperCase()` probe: axios
 *  lowercases, but an error object or a hand-built response need not, and a
 *  silently-missed leg on exactly the failing rows is the bug being fixed. */
function readHeader(headers: any, name: string): string | undefined {
  if (!headers) return undefined;
  let raw: unknown;
  if (typeof headers.get === 'function') {
    raw = headers.get(name); // Headers/axios AxiosHeaders
  } else if (typeof headers === 'object') {
    raw = headers[name];
    if (raw === undefined) {
      const lower = name.toLowerCase();
      const hit = Object.keys(headers).find((k) => k.toLowerCase() === lower);
      if (hit) raw = headers[hit];
    }
  }
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/**
 * The leg a response says served it. Host-only for the api_base on purpose: the
 * path and query say nothing about WHICH deployment, and the full URL would
 * spend a third of the 240-char visible meta budget on a constant.
 *
 * The model-id fallback keeps MORE of the id than looks necessary (adversarial
 * review 2026-11-02, B5): `model_id` is an arbitrary operator-chosen string, not
 * a uuid — `Qwen3-Embedding-8B-agx` and `...-spark` share their first 12 chars,
 * so a 12-char prefix would report two different deployments as ONE leg on
 * precisely the provider_error path, where this header is the only one a failed
 * attempt gets. The truncation exists to bound the field, not to hide the answer.
 *
 * Returns `{}` when the response names nothing — a direct-to-provider call (no
 * gateway) is legitimately leg-less, and a caller abort has no response at all.
 */
export function legFromResponseHeaders(headers: any): RagAttemptLeg {
  const out: RagAttemptLeg = {};
  const callId = readHeader(headers, LITELLM_CALL_ID_HEADER);
  if (callId) out.callId = callId.slice(0, 64);
  const apiBase = readHeader(headers, LEG_HEADER_API_BASE);
  const modelId = readHeader(headers, LEG_HEADER_MODEL_ID);
  const modelName = readHeader(headers, LEG_HEADER_MODEL_NAME);
  if (apiBase) {
    try {
      out.leg = new URL(apiBase).host.slice(0, 64);
    } catch {
      out.leg = apiBase.slice(0, 64); // not a URL — report it rather than drop it
    }
  } else if (modelId) {
    // 48 chars: long enough that two real deployment ids cannot collide, short
    // enough to leave room for the outcome fields ahead of it in the meta.
    out.leg = `id:${modelId.slice(0, 48)}`;
  } else if (modelName) {
    out.leg = `n:${modelName.slice(0, 40)}`;
  }
  return out;
}

/**
 * Type WHY the attempt ended, so "which leg failed" and "who aborted" are two
 * different reads instead of one inference (ticket b5f4d5e2).
 *
 * Ordering is the whole judgement: a timeout WINS over a present response
 * because axios reports our own abort with no `response` at all, and a
 * provider's 504 has one — but a message containing "timeout" alongside a
 * response status is the provider saying so, which is `provider_error`.
 */
export function classifyAbortReason(err: any): RagAbortReason {
  const status = err?.response?.status;
  const message = String(err?.message ?? '');
  const timedOut = err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || /timeout/i.test(message);
  if (timedOut && status === undefined) return 'caller_timeout';
  if (typeof status === 'number' && status >= 400) return 'provider_error';
  // A 2xx whose body/vector shape was rejected: never a transport fault.
  if (/dimensions|empty rerank results/i.test(message)) return 'parse_failure';
  if (timedOut) return 'provider_error'; // the provider answered AND said timeout
  if (err?.response) return 'provider_error';
  if (err?.code || /ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|TLS/i.test(message)) return 'network';
  return 'unknown';
}

/**
 * WHY TWO TIMEOUT FAMILIES (15 000 ms AND ~7 000–13 000 ms) — the split is
 * deliberate, not drift, and the ladder keeps it that way:
 *
 *  - **BUDGET-LESS callers get the seat budget.** `rerankTexts` with no
 *    `opts.timeoutMs` uses RERANK_HTTP_TIMEOUT_MS = 15 000: a caller with its
 *    own outer deadline (a background job, a coding-session lookup) can afford
 *    the full wait, so it gets the whole budget. These are the literal
 *    "timeout of 15000ms exceeded" rows — the majority (≈600 of 689/24 h).
 *  - **DEADLINE-BOUND callers pass their REMAINING budget.** The query-time
 *    search path must answer a user turn inside its own deadline, so
 *    unified-memory passes `remaining() - overhead`, floored at
 *    EMBED_MIN_TIMEOUT_MS (1 200 ms). That is where the non-round values come
 *    from (7 097 / 7 268 / 13 251 ms …): each is one caller's leftover
 *    milliseconds, so no two are alike. Nothing is "unified" here on purpose —
 *    a fixed number would either overrun the user's deadline or throw away
 *    budget the caller still has.
 *
 * What the incident DID expose is that both families could be spent entirely on
 * ONE dead rung. The ladder fixes that: `ladderRungBudgets` splits the caller's
 * single budget across the rungs (60/40 for two), so a hang on rung 1 still
 * leaves rung 2 a usable slice instead of the call dying on the first route.
 */

/** Classify a transport error so the metric says WHY, not just that it failed. */
export function classifyRagError(err: any): Pick<RagAttempt, 'errorKind' | 'status'> {
  const status = err?.response?.status;
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || /timeout/i.test(err?.message ?? '')) {
    return { errorKind: 'timeout', status };
  }
  if (status === 401 || status === 403) return { errorKind: 'auth', status };
  if (typeof status === 'number' && status >= 400 && status < 500) return { errorKind: 'http_4xx', status };
  if (typeof status === 'number' && status >= 500) return { errorKind: 'http_5xx', status };
  if (/empty rerank results/i.test(err?.message ?? '')) return { errorKind: 'empty', status };
  if (/dimensions/i.test(err?.message ?? '')) return { errorKind: 'dims', status };
  return { errorKind: 'network', status };
}

/**
 * Emit one metric row per transport attempt. Fire-and-forget and never throws:
 * telemetry must not be able to fail a retrieval call.
 *
 * This is the counter the incident was missing. The old code logged a
 * once-per-process warn and nothing else, so "how many calls failed out of how
 * many made" was unanswerable — the 689 rows could not be turned into a rate.
 *
 * `proc` names the process that wrote the row (todo c0c0c52a). It goes FIRST
 * deliberately: loop_metrics has no host/process column, and the fleet
 * telemetry view truncates meta at 240 chars, so a key appended last would be
 * invisible on the very read that needs it. With it, "which build wrote this
 * row" is a one-query answer.
 *
 * The payload sizes (`chars` / `batchChars` / `batchCount`, ticket d59499f4)
 * follow the same rule and are HOISTED ahead of `errorKind`/`status`: a timeout
 * row with a long target label already lands at ~237 of the 240 visible chars,
 * so a size appended last would be missing from exactly the failing rows an
 * operator is sizing (adversarial review 2026-11-01, M3). The p50/p95 aggregate
 * reads the DB and is unaffected either way — this is about the visible sample.
 */
function recordRagTransport(kind: 'rag_rerank_call' | 'rag_embed_call', attempt: RagAttempt, extra?: Record<string, unknown>): void {
  // Pull the size keys out of `extra` so they can be placed high in the object.
  const { chars, batchChars, batchCount, gwless, ...rest } = (extra ?? {}) as Record<string, unknown>;
  // Everything the ordered block below already emits. Whatever remains is a
  // caller-specific field (batchAttempts/batchFailures on the call roll-up, …)
  // and it MUST still reach the row — an explicit allow-list here silently
  // dropped `batchFailures` once, which is the per-call counter the row exists to
  // carry (re-verified by rag.transport-ladder's roll-up assertion).
  const KNOWN_IN_REST = ['unit', 'op', 'lane', 'batch', 'retried'] as const;
  const residual: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (!(KNOWN_IN_REST as readonly string[]).includes(k) && v !== undefined) residual[k] = v;
  }
  void import('./platform/loop-metrics.service')
    .then(({ recordLoopMetric }) => recordLoopMetric({
      kind,
      value: attempt.ms,
      meta: {
        // ORDER IS LOAD-BEARING (adversarial review 2026-11-02, B2). The fleet
        // telemetry view TRUNCATES this object's rendered form at 240 chars, so
        // every field that must survive for a consumer to read the row has to
        // sit ahead of the tail. `unit` is the worst offender: it exists ONLY
        // here (the rag path never sets the DB column), and a failing attempt
        // row is 36 chars longer than a success because of `callId` — put the
        // caller id high and the failing rows lose `unit`, which is exactly the
        // population the ticket is about. So: identity and outcome first, the
        // long correlator LAST.
        proc: processTag(),
        target: attempt.spec,
        // Write-time ATTRIBUTION (goal 4e432dff). `bucket` names the flow that
        // attempted the call; it sits beside `unit` because the probe's whole
        // question — "how many failure rows cannot say who they were?" — is
        // answered by reading these two keys on the failing population. Both
        // are short (a closed enum, a bool) and both must survive the 240-char
        // meta truncation on exactly the long failure rows, hence this high.
        ...(rest.bucket !== undefined ? { bucket: rest.bucket } : {}),
        // THE POSITIVE GATEWAY FACT (goal 4e432dff, supervisor ruling
        // 2026-11-04) — `direct` only from the transport that owns the
        // DashScope URL literal. Two chars of key, placed HIGH because the
        // attribution rule reads it on precisely the long failure rows that
        // lose their tail to the 240-char truncation.
        ...(gwless !== undefined ? { gwless } : {}),
        ...(rest.unit !== undefined ? { unit: rest.unit } : {}),
        ...(attempt.leg !== undefined ? { leg: attempt.leg } : {}),
        ...(attempt.abort !== undefined ? { abort: attempt.abort } : {}),
        ok: attempt.ok,
        ms: attempt.ms,
        ...(chars !== undefined ? { chars } : {}),
        ...(batchChars !== undefined ? { batchChars } : {}),
        ...(batchCount !== undefined ? { batchCount } : {}),
        errorKind: attempt.errorKind,
        status: attempt.status,
        ...(rest.op !== undefined ? { op: rest.op } : {}),
        ...(rest.lane !== undefined ? { lane: rest.lane } : {}),
        ...(rest.batch !== undefined ? { batch: rest.batch } : {}),
        ...(rest.retried !== undefined ? { retried: rest.retried } : {}),
        ...residual,
        // LAST on purpose: the join key a CALLER-side abort needs (with no
        // response there is no leg header, and this id is the only way back to
        // the gateway's row for the request we gave up on) — but it is 36 chars
        // that only the rows which HAVE no leg need, so it goes behind
        // everything a reader must see on every row.
        ...(attempt.callId !== undefined ? { callId: attempt.callId } : {}),
        ...(attempt.callIdEcho !== undefined ? { callIdEcho: attempt.callIdEcho } : {}),
      },
    }))
    .catch(() => { /* telemetry is best-effort by contract */ });
}

/** Minimum time worth spending on a single rung (below this, fail fast). */
const RAG_MIN_ATTEMPT_MS = 1_500;
/**
 * Split a caller's budget across the ladder so the rungs SHARE it rather than
 * each consuming the whole thing (two rungs × 15 s would triple a 15 s budget).
 * Rung 1 gets the larger share because it is normally the fast path.
 */
export function ladderRungBudgets(budgetMs: number, rungs: number): number[] {
  if (rungs <= 0) return [];
  const total = Math.max(1, Math.floor(budgetMs));
  if (rungs === 1) return [total];
  // Hand out proportional shares that SUM to the budget exactly, so a rung can
  // never get more than the caller granted (adversarial review 2026-11-01,
  // should-fix 3: the old floor raised a 1200ms caller to 1500ms and a 1000ms
  // caller to 3000ms). Rung 1 takes the larger share. Full milliseconds are
  // always granted — the minimum is 1ms, never a floor the caller cannot pay.
  const first = Math.min(total - (rungs - 1), Math.max(1, Math.round(total * (rungs === 2 ? 0.6 : 0.5))));
  const remaining = total - first;
  const base = Math.floor(remaining / (rungs - 1));
  const spare = remaining - base * (rungs - 1);
  return [first, ...Array.from({ length: rungs - 1 }, (_, i) => base + (i < spare ? 1 : 0))];
}

const dashscopeRerankTarget = (): RagTarget | null => DASHSCOPE_API_KEY
  ? { url: DASHSCOPE_RERANK_URL, model: DASHSCOPE_RERANK_MODEL, apiKey: DASHSCOPE_API_KEY, spec: `dashscope:${DASHSCOPE_RERANK_MODEL}`, matryoshka: false }
  : null;

/**
 * True when SOME reranker can run: the instance's `rerank` role override, or
 * the built-in DashScope reranker. Gates the retrieval rerank passes so an
 * Edge box with a custom reranker (and no DASHSCOPE_API_KEY) still reranks.
 */
async function rerankAvailable(): Promise<boolean> {
  if (DASHSCOPE_API_KEY) return true;
  return !!(await roleEndpointTarget('rerank', '/rerank'));
}

/** A rung that failed this many times IN A ROW is skipped for the cooldown. */
export const RERANK_RUNG_FAIL_THRESHOLD = 3;
/** How long a latched rung stays out before it is probed again. Kept well
 *  above one caller's budget so the probe is a small fraction of the calls. */
export const RERANK_RUNG_COOLDOWN_MS = 10 * 60 * 1000;

/** spec → { consecutive failures, latched-until }. Process-local on purpose:
 *  it is a cost guard, not shared state — a restart simply re-probes. */
const rungHealth = new Map<string, { fails: number; cooldownUntil: number }>();

/** Is this rung currently latched out of the ladder? */
export function rungLatched(spec: string, now: number = Date.now()): boolean {
  const h = rungHealth.get(spec);
  return !!h && h.cooldownUntil > now;
}

/** Record how a rung performed; consecutive failures latch it out. */
function noteRungOutcome(spec: string, ok: boolean): void {
  if (ok) {
    rungHealth.delete(spec);
    return;
  }
  const h = rungHealth.get(spec) ?? { fails: 0, cooldownUntil: 0 };
  h.fails += 1;
  if (h.fails >= RERANK_RUNG_FAIL_THRESHOLD) {
    h.cooldownUntil = Date.now() + RERANK_RUNG_COOLDOWN_MS;
    h.fails = 0;
    // INFO, not warn (verify 2026-11-01): the failure that caused the latch is
    // ALREADY emitted as a warn by the pinned logClass:'external' catch in
    // rerankTexts (the rag.family-5ae52ca3 contract asserts exactly one warn
    // per degraded call). A second warn here would double-count the same fault
    // in the log-signal sweep, and a latch is a cost guard — an expected,
    // self-healing action — not a new degradation to file.
    logger.info(`rag: rerank rung "${spec}" latched out for ${Math.round(RERANK_RUNG_COOLDOWN_MS / 1000)}s after ${RERANK_RUNG_FAIL_THRESHOLD} consecutive failures — rung 1 serves until then`);
  }
  rungHealth.set(spec, h);
}

/** Test seam: forget every latch. */
export function __resetRungHealthForTests(): void {
  rungHealth.clear();
}

/**
 * The rerank ladder, IN MEASURED COST ORDER — built-in DashScope FIRST, the
 * instance's `rerank` role override SECOND.
 *
 * WHY THE ORDER FLIPPED (goal 79284e7f, 2026-11-01). The old ladder put the
 * custom rung first, and the measured cost was a dead attempt on EVERY call:
 * over a 24 h prod sample of `rag_rerank_call` rows the llm-cql rung logged
 * 39 timeouts against 3 successes (4 064–9 004 ms — the 9 002 ms rows are
 * exactly the 60 % rung share of a 15 s budget), while DashScope answered
 * 867–1 854 ms in the same rows. So each rerank paid ~4–9 s of dead latency
 * before reaching the rung that actually serves it — a 5–10× cost for zero
 * ranking benefit on the normal path. A direct DashScope probe returned HTTP
 * 200 in 857 ms, and the workload is 83 calls/day, so there is no rate-ceiling
 * argument for keeping the custom rung in front.
 *
 * DROP vs DEMOTE: llm-cql was NOT dropped. In the two calls where DashScope
 * itself failed (15:33:29Z, 1 507/1 573 ms) llm-cql failed too, so it rescues
 * nothing today — but a rung 2 that costs ZERO on the normal path (rung 1
 * serves, rung 2 is never asked) and can only help during a DashScope outage
 * is worth keeping, and it keeps the admin's `rerank` seat meaningful. The
 * DECISION is therefore: demote, do not delete.
 *
 * Rerank is ORDER-ONLY — a different reranker changes ranking, never stored
 * data — so rotating it is always safe (unlike embeddings, see embedTexts).
 */
async function rerankLadder(): Promise<RagTarget[]> {
  const ladder: RagTarget[] = [];
  const ds = dashscopeRerankTarget();
  if (ds) ladder.push(ds);
  try {
    const custom = await roleEndpointTarget('rerank', '/rerank');
    if (custom && !ladder.some(t => t.url === custom.url && t.model === custom.model)) {
      ladder.push({ url: custom.url, model: custom.model, apiKey: custom.apiKey, spec: custom.spec });
    }
  } catch (err: any) {
    // A broken rerank role must not disable a working DashScope rung — but it
    // must not vanish either (adversarial review 2026-11-01, should-fix 4):
    // this catch used to swallow the error, removing the only diagnostic for a
    // role whose config cannot be read.
    logger.warn(`rag: rerank role unusable (${err?.message ?? err}) — using the remaining rung(s)`);
  }
  // Skip latched rungs — but NEVER return an empty ladder: a latch is a cost
  // guard, and it must not be able to turn "degraded" into "rerank disabled".
  // When EVERY rung is latched we have no healthy choice, so we probe RUNG 1
  // ONLY rather than replaying the whole dead ladder: the caller keeps its own
  // order either way, and one bounded timeout instead of one-per-rung is the
  // difference between a degraded rerank costing 9 s and costing 15 s.
  const live = ladder.filter(t => !rungLatched(t.spec));
  if (live.length) return live;
  return ladder.slice(0, 1);
}

/**
 * ONE Cohere-style rerank POST against a resolved target. Throws on failure.
 */
async function postRerankTo(target: RagTarget, query: string, documents: string[], topN: number, timeoutMs: number, callId: string): Promise<{ results: any[]; headers: any }> {
  const response = await axios.post(
    target.url,
    { model: target.model, query, documents, top_n: topN, return_documents: false },
    { headers: { ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}), 'Content-Type': 'application/json', [LITELLM_CALL_ID_HEADER]: callId }, timeout: timeoutMs }
  );
  // Flat (Cohere/OpenAI-style) shape: { results: [{ index, relevance_score }] }
  const results = response.data?.results ?? [];
  // A 2xx with an EMPTY result set is a PARSE failure, not a transport one
  // (ticket b5f4d5e2): the provider answered, so the leg is known and the bug is
  // in the body contract. Tag it so classifyAbortReason can type it as such.
  if (!Array.isArray(results) || results.length === 0) {
    const err: any = new Error('empty rerank results');
    err.response = response;
    throw err;
  }
  return { results, headers: response?.headers };
}

/**
 * Rotate the rerank ladder until a rung answers. Returns the results plus the
 * attempts made (for telemetry). Throws only when EVERY rung failed — so a
 * caller's "keep my own order" fallback now means the whole ladder is down,
 * not that one dead route was asked once.
 */
async function postRerank(
  query: string, documents: string[], topN: number, budgetMs: number = RERANK_HTTP_TIMEOUT_MS,
  attempts?: RagAttempt[],
): Promise<any[]> {
  const ladder = await rerankLadder();
  if (!ladder.length) throw new Error('no reranker configured (DASHSCOPE_API_KEY unset, no rerank role override)');
  const budgets = ladderRungBudgets(budgetMs, ladder.length);
  let lastErr: any;
  for (let i = 0; i < ladder.length; i++) {
    const target = ladder[i];
    // Per-RUNG call id (ticket b5f4d5e2): same join key as the embed lane, so a
    // rung we aborted is still recoverable from the gateway's own log.
    const callId = randomUUID();
    const t0 = Date.now();
    try {
      const { results, headers } = await postRerankTo(target, query, documents, topN, budgets[i], callId);
      noteRungOutcome(target.spec, true);
      attempts?.push({ spec: target.spec, ok: true, ms: Date.now() - t0, ...attemptLeg(headers, callId) });
      return results;
    } catch (err: any) {
      lastErr = err;
      noteRungOutcome(target.spec, false);
      const kind = classifyRagError(err);
      // `leg` comes from the error's OWN response headers when the rung answered
      // (a 5xx/empty body still names its deployment); absent on a caller abort.
      attempts?.push({ spec: target.spec, ok: false, ms: Date.now() - t0, ...kind, ...attemptLeg(err?.response?.headers, callId), abort: classifyAbortReason(err) });
    }
  }
  throw lastErr;
}

/**
 * Generic text reranker for OTHER retrieval surfaces (e.g. coding session
 * memory). Returns topN {index, score} into `texts` by cross-encoder relevance,
 * or null when EVERY rung of the ladder failed — so the caller keeps its own
 * (cosine/keyword) ordering. One metric row per attempt (rag_rerank_call)
 * replaces the old once-per-process warn: the failure is now COUNTED against
 * the calls made, so a ratio exists.
 */
const RERANK_HTTP_TIMEOUT_MS = 15000;
export async function rerankTexts(
  query: string,
  texts: string[],
  topN: number,
  /** Per-request budget for the WHOLE ladder (default 15 s) — see embedTexts. */
  opts?: { timeoutMs?: number },
): Promise<Array<{ index: number; score: number }> | null> {
  if (!texts.length || !(await rerankAvailable())) return null;
  const attempts: RagAttempt[] = [];
  try {
    const results = await postRerank(
      query, texts, Math.min(topN, texts.length),
      Math.max(500, Math.floor(opts?.timeoutMs ?? RERANK_HTTP_TIMEOUT_MS)),
      attempts,
    );
    for (const a of attempts) recordRagTransport('rag_rerank_call', a, { op: 'rerankTexts' });
    return results
      .filter((r: any) => Number.isInteger(r.index) && r.index >= 0 && r.index < texts.length)
      .map((r: any) => ({ index: r.index as number, score: Number(r.relevance_score ?? 0) }));
  } catch (err: any) {
    // Ticket 007c1a3a (log-signal family 5ae52ca3): a rerank timeout is
    // external degradation the caller is DESIGNED to survive — it keeps its own
    // (RRF) order. logExternal keeps the row (warn, auditable, f184 pin) but
    // tags logClass:'external' so the sweep stops filing it as a framework
    // defect. Robust detail (review F1 nit): a non-Error rejection must never
    // throw inside the catch — that would break the "null on ANY failure"
    // contract.
    for (const a of attempts) recordRagTransport('rag_rerank_call', a, { op: 'rerankTexts' });
    const tried = attempts.map(a => `${a.spec} ${a.errorKind ?? 'error'} ${a.ms}ms`).join('; ') || 'no rung attempted';
    const detail = err?.response?.data?.message || err?.message || String(err ?? 'unknown error');
    // The pinned prefix "rerankTexts failed — caller keeps its own order: " and
    // the logClass:'external' tag are the f184/5ae52ca3 contract (SELF_AUDIT:
    // the sweep's isNonFaultLogRow depends on both) — the ladder detail is
    // APPENDED so the message stays greppable by its old prefix while now
    // naming every rung that failed.
    logExternal(`rerankTexts failed — caller keeps its own order: ${detail} (rungs ${attempts.length || 1}: ${tried})`);
    return null;
  }
}

/**
 * Rerank candidates using DashScope qwen3-rerank (Qwen3 cross-encoder reranker).
 * Much more accurate than cosine similarity alone. Falls back to RRF order on any failure.
 */
async function dashscopeRerank(
  query: string,
  candidates: any[],
  topN: number
): Promise<RetrievedChunk[]> {
  try {
    const results = await postRerank(query, candidates.map(c => c.content), topN);
    return results.map((result: any) => {
      const candidate = candidates[result.index];
      return {
        id: candidate.id,
        documentId: candidate.documentId,
        documentName: candidate.documentName,
        mimeType: candidate.mimeType,
        content: candidate.content,
        chunkIndex: candidate.chunkIndex,
        relevanceScore: result.relevance_score,
        metadata: candidate.metadata,
      };
    });
  } catch (err: any) {
    // Same class as the rerankTexts catch above (family 5ae52ca3 review F6 —
    // this sibling was the untagged twin that would have re-filed the
    // adjudicated fingerprint): DashScope degradation, RRF fallback by design.
    const detail = err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || String(err ?? 'unknown error');
    logExternal(`DashScope qwen3-rerank failed (${detail}) — falling back to RRF order.`);
    // Fallback to RRF order
    return candidates.slice(0, topN).map((c, i) => ({
      id: c.id,
      documentId: c.documentId,
      documentName: c.documentName,
      mimeType: c.mimeType,
      content: c.content,
      chunkIndex: c.chunkIndex,
      relevanceScore: 1 - i * 0.1,
      metadata: c.metadata,
    }));
  }
}

/**
 * Build context block to inject into model prompts.
 * Format designed for maximum clarity across OpenAI, Grok, Gemini.
 * 
 * Includes:
 *   - Project system prompt (custom instructions)
 *   - Retrieved document chunks (from uploaded files/URLs)
 *   - Project chat history (conversations from sibling chats in same project)
 */
export function buildContextBlock(
  projectName: string,
  systemPrompt: string | null | undefined,
  chunks: RetrievedChunk[],
  chatHistory?: string  // Optional: formatted history from other chats in this project
): string {
  const lines: string[] = [];

  lines.push(`═══ PROJECT: ${projectName} ═══`);

  if (systemPrompt?.trim()) {
    lines.push('');
    lines.push('[Custom Instructions]');
    lines.push(systemPrompt.trim());
  }

  if (chunks.length > 0) {
    lines.push('');
    lines.push(`[Relevant Knowledge — ${chunks.length} source${chunks.length > 1 ? 's' : ''} retrieved]`);
    // Blended account-wide RAG: cross-project entries are labeled so the model
    // can attribute them and never mistakes them for THIS project's content.
    if (chunks.some((c) => c.sourceProjectName)) {
      lines.push(`(Entries marked 'from project "…"' come from your OTHER projects — attribute them to that project; do NOT assume the current project covers those topics.)`);
    }
    lines.push('');

    chunks.forEach((chunk, i) => {
      const icon = chunk.mimeType === 'url' ? '🌐' : '📄';
      const source = chunk.mimeType === 'url'
        ? (chunk.metadata?.sourceUrl || chunk.documentName)
        : chunk.documentName;
      const pageInfo = chunk.metadata?.page ? ` (page ${chunk.metadata.page})` : '';
      const fromProject = chunk.sourceProjectName ? ` — from project "${chunk.sourceProjectName}"` : '';
      const score = (chunk.relevanceScore * 100).toFixed(0);

      lines.push(`[${i + 1}] ${icon} ${source}${pageInfo}${fromProject} — relevance: ${score}%`);
      lines.push(chunk.content.substring(0, 800) + (chunk.content.length > 800 ? '...' : ''));
      if (i < chunks.length - 1) lines.push('');
    });
  }

  // Include project chat history from sibling chats
  if (chatHistory?.trim()) {
    lines.push('');
    lines.push(chatHistory.trim());
  }

  lines.push('═══════════════════════');

  return lines.join('\n');
}
