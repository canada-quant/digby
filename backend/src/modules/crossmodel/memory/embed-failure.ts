/**
 * Unified-memory embed failures — the cause, named, and a per-row retry.
 *
 * Telemetry-noise audit (PE-13): `unified-memory: embed failed, keyword-only
 * store: Request failed with status code 400` — 27 rows / 7 d with the cause
 * hidden (axios puts the provider body on `err.response.data`, the catch
 * logged only `err.message`), and a batch of up to 10 inputs de-embedded ALL
 * ten rows when ONE input was rejected. This leaf (import-free — pure
 * functions plus an injected embed call) names the cause so it can be logged
 * ONCE per cause per process and counted, and re-embeds row by row on a
 * rejected batch so the good rows keep their vectors.
 *
 * Knob: `UNIFIED_MEMORY_EMBED_ROW_RETRY_MAX` (rows re-tried per store,
 * default 20; 0 = no per-row retry — a failed batch stays keyword-only).
 */

export type EmbedFailureKind = 'http_4xx' | 'http_5xx' | 'timeout' | 'aborted' | 'network' | 'unknown';

/**
 * WHICH EMBED FLOW attempted the call — the `bucket` dimension (goal 4e432dff,
 * Fleet directive 501f9e2b residual limb 2).
 *
 * WHY THIS EXISTS. An embed failure row used to name HOW it failed (`kind`,
 * `status`, `code`) but never WHO was embedding, so 88 failed attempts in the
 * 2026-11-02 window could not be attributed to a flow: a store going
 * keyword-only, a query leg degrading recall, the repair cron failing to
 * converge and an ingestion job dropping vectors all write the same
 * `rag_embed_call` / `unified_memory_embed_failed` shape. The gateway's own
 * logs proved the provider side was clean (4 713/4 713 × 200) — which precisely
 * means the answer lived on OUR side, in a dimension we did not write.
 *
 * The value set is deliberately CLOSED and small: it is a grouping key an
 * operator reads on the failing rows, not a free-form label, and a closed set is
 * what lets a probe count "rows that carry no bucket" as a hard number.
 * `unknown` exists only so a call site that arrives without one is VISIBLE
 * (it is what the KPI counts) rather than silently correct.
 */
export type EmbedBucket = 'store' | 'query' | 'backfill' | 'ingest' | 'user_facts' | 'unknown';

/** Every bucket, for validators and the probe's zero-row denominators. */
export const EMBED_BUCKETS: readonly EmbedBucket[] = ['store', 'query', 'backfill', 'ingest', 'user_facts', 'unknown'];

/** True when a value really names a flow (i.e. is NOT the `unknown` sentinel
 *  and is one of the closed set). */
export function isKnownEmbedBucket(v: unknown): v is EmbedBucket {
  return typeof v === 'string' && v !== 'unknown' && (EMBED_BUCKETS as readonly string[]).includes(v);
}

/**
 * Which SIDE ended the attempt — readable from the error object alone, so every
 * emitter can type it without the caller's per-attempt bookkeeping.
 *
 * This is the sibling of `rag.service.ts`'s `RagAbortReason` (ticket b5f4d5e2)
 * for the paths that never reach the rag transport recorder. The distinction
 * that matters is unchanged: `caller_timeout` means WE aborted and no response
 * (hence no leg header) ever existed — that row is fully attributed by
 * bucket + abort, and counting it as "unattributed because there is no leg"
 * would make the zero-unattributed bar unreachable by construction.
 */
export type EmbedAbort = 'caller_timeout' | 'provider_error' | 'parse_failure' | 'network' | 'unknown';

export interface EmbedFailureCause {
  kind: EmbedFailureKind;
  /** HTTP status when the provider answered. */
  status: number | null;
  /** The provider's own error code (DashScope `code`, OpenAI-compatible `error.code` / `error.type`). */
  code: string | null;
  /** The provider's message, bounded — never the input text. */
  providerMessage: string | null;
  /** The transport message (axios / node), bounded. */
  message: string;
  /** Seconds the provider asked us to wait (HTTP `Retry-After`, seconds or
   *  HTTP-date; DashScope 429s carry it). Null when absent/unparseable. */
  retryAfterSec: number | null;
  /**
   * The deployment/upstream that answered, read from the gateway's own
   * `x-litellm-*` response headers at WRITE time (the `leg` dimension).
   *
   * Null is a real, explained answer, not a gap: a caller-side abort has no
   * response at all, so no header exists at any layer. That case is named by
   * `abort` instead — see `embedAttributionComplete`.
   */
  leg: string | null;
  /** Who ended the attempt (see `EmbedAbort`). */
  abort: EmbedAbort;
}

/** The gateway header names that identify a leg — the wire contract, spelled once. */
const LEG_HEADER_API_BASE = 'x-litellm-model-api-base';
const LEG_HEADER_MODEL_ID = 'x-litellm-model-id';
const LEG_HEADER_MODEL_NAME = 'x-litellm-model-name';

/**
 * Case-insensitive header read that works for an axios response, a `Headers`
 * object and a plain object (tests, and gateways that do not send the header).
 * A genuine key scan rather than a `toUpperCase()` probe: axios lowercases, but
 * an error object or a hand-built response need not, and a silently-missed leg
 * on exactly the failing rows is the bug this exists to prevent.
 */
export function readAttributionHeader(headers: any, name: string): string | undefined {
  if (!headers) return undefined;
  let raw: unknown;
  if (typeof headers.get === 'function') {
    raw = headers.get(name); // Headers / axios AxiosHeaders
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
 * The leg a response says served it — THE definition, shared by the rag
 * transport rows and the memory failure rows so the two surfaces cannot name
 * the same deployment two different ways.
 *
 * Host-only for the api_base on purpose: the path and query say nothing about
 * WHICH deployment, and a full URL would spend a third of the 240-char visible
 * meta budget on a constant.
 *
 * The model-id fallback keeps 48 chars (adversarial review 2026-11-02, B5):
 * `model_id` is an operator-chosen string, not a uuid, so
 * `Qwen3-Embedding-8B-agx` and `...-spark` share their first 12 chars and a
 * 12-char prefix would report two deployments as ONE leg — on precisely the
 * provider_error path, where this header is the only one a failed attempt gets.
 *
 * Returns null when the response names nothing (a caller abort, or a
 * direct-to-provider lane with no gateway in front).
 */
export function legFromAttributionHeaders(headers: any): string | null {
  const apiBase = readAttributionHeader(headers, LEG_HEADER_API_BASE);
  const modelId = readAttributionHeader(headers, LEG_HEADER_MODEL_ID);
  const modelName = readAttributionHeader(headers, LEG_HEADER_MODEL_NAME);
  if (apiBase) {
    try {
      return new URL(apiBase).host.slice(0, 64);
    } catch {
      return apiBase.slice(0, 64); // not a URL — report it rather than drop it
    }
  }
  if (modelId) return `id:${modelId.slice(0, 48)}`;
  if (modelName) return `n:${modelName.slice(0, 40)}`;
  return null;
}

/**
 * Attribute a failure row: does it name BOTH the flow that attempted the call
 * and the side/leg it ended on?
 *
 * THE RULE (and why it is not simply `bucket && leg`): a caller-side abort has
 * no response, so no leg can exist at any layer — a `caller_timeout` is
 * attributed by `bucket` + the typed `abort` (+ `callId` where the emitter has
 * one). Requiring a leg there would make "zero unattributed failures" a bar
 * that no honest build can ever meet, which is a worse gate than no gate.
 * Everything else — a provider error, a parse failure, a network fault — must
 * name its leg, because a response (or a resolved host) existed.
 *
 * Exported so the KPI probe applies the SAME rule the emitters write by.
 */
export function embedAttributionComplete(meta: Record<string, unknown> | null | undefined): boolean {
  if (!meta || typeof meta !== 'object') return false;
  if (!isKnownEmbedBucket(meta.bucket)) return false;
  const leg = typeof meta.leg === 'string' && meta.leg.trim() ? meta.leg.trim() : null;
  if (leg) return true;
  const abort = typeof meta.abort === 'string' ? meta.abort : null;
  if (abort === 'caller_timeout') return true;
  // A network fault can also resolve no response (ECONNRESET before headers) —
  // it is attributable by its typed reason the same way a caller abort is.
  if (abort === 'network') return true;
  return false;
}

const MESSAGE_CAP = 200;
/** Retry-After is bounded so a hostile/misconfigured header cannot park the
 *  embed path for hours (a 3600 s ask clamps to 120 s). */
const RETRY_AFTER_CAP_SEC = 120;

function bounded(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = typeof value === 'string' ? value : (() => { try { return JSON.stringify(value); } catch { return String(value); } })();
  const t = s.trim();
  return t ? t.slice(0, MESSAGE_CAP) : null;
}

/** Parse an HTTP `Retry-After` value (delta-seconds or HTTP-date) into bounded
 *  seconds. Never throws; null when absent or unparseable. */
export function parseRetryAfterSec(raw: unknown, now: Date = new Date()): number | null {
  if (raw === undefined || raw === null) return null;
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(Math.ceil(n), RETRY_AFTER_CAP_SEC);
  }
  const at = Date.parse(s);
  if (Number.isFinite(at)) {
    const delta = (at - now.getTime()) / 1000;
    if (!Number.isFinite(delta) || delta <= 0) return null;
    return Math.min(Math.ceil(delta), RETRY_AFTER_CAP_SEC);
  }
  return null;
}

/**
 * Which SIDE ended the attempt, from the error object alone (goal 4e432dff).
 *
 * The ordering is the whole judgement, and it mirrors `rag.service.ts`
 * `classifyAbortReason` deliberately: a timeout WINS over a present response
 * only when there IS no response (axios reports our own abort with
 * `code:'ECONNABORTED'` and no `response`) — a provider 504 arrives WITH a
 * response and a status, so it is a `provider_error` that happens to be slow.
 * Getting this backwards would relabel every provider 5xx as our own bound,
 * which is the exact misattribution the parent ticket is about.
 */
export function classifyEmbedAbort(err: unknown, kind?: EmbedFailureKind): EmbedAbort {
  const e = (err ?? {}) as any;
  const status = e?.response?.status;
  const msg = String(e?.message ?? '');
  const timedOut = e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || /\btimeout\b/i.test(msg);
  if (timedOut && status === undefined) return 'caller_timeout';
  if (typeof status === 'number' && status >= 400) return 'provider_error';
  if (/dimensions|empty (?:rerank )?results|no vector/i.test(msg)) return 'parse_failure';
  const resolvedKind = kind ?? describeEmbedFailure(err).kind;
  if (resolvedKind === 'network') return 'network';
  if (resolvedKind === 'timeout') return status === undefined ? 'caller_timeout' : 'provider_error';
  return 'unknown';
}

/**
 * Name the cause of a failed embedding call — including the two attribution
 * dimensions (goal 4e432dff): `leg` (which deployment answered, from the
 * gateway's own headers) and `abort` (which side ended it).
 *
 * `leg` is read from `err.response.headers`, the ONLY place it exists on a
 * failure: axios discards a successful response's headers on the error path,
 * but keeps the response object itself, which is why a provider error can still
 * name its upstream while a caller abort cannot (there is no response at all).
 * Never throws.
 */
export function describeEmbedFailure(err: unknown): EmbedFailureCause {
  const e = (err ?? {}) as any;
  const message = bounded(e?.message) ?? 'unknown error';
  const status: number | null = typeof e?.response?.status === 'number' ? e.response.status : null;
  const body = e?.response?.data;
  // DashScope compatible-mode answers `{error:{message,type,code}}`; the native
  // API answers `{code, message, request_id}` — read both shapes.
  const code = bounded(body?.error?.code ?? body?.error?.type ?? body?.code) ?? null;
  const providerMessage = bounded(body?.error?.message ?? body?.message) ?? null;
  const retryAfterSec = parseRetryAfterSec(e?.response?.headers?.['retry-after'] ?? e?.response?.headers?.['Retry-After']);
  let kind: EmbedFailureKind = 'unknown';
  if (status !== null) kind = status >= 500 ? 'http_5xx' : status >= 400 ? 'http_4xx' : 'unknown';
  else if (e?.code === 'ECONNABORTED' || /\btimeout\b/i.test(message)) kind = 'timeout';
  else if (e?.name === 'AbortError' || e?.name === 'CanceledError' || /\baborted\b|\bcanceled\b/i.test(message)) kind = 'aborted';
  else if (/^E[A-Z]+$/.test(String(e?.code || '')) || /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)) kind = 'network';
  return {
    kind, status, code, providerMessage, message, retryAfterSec,
    // Both dimensions are populated on EVERY failure by construction — the
    // caller cannot forget one, which is what makes "zero unattributed" a
    // property of the emitter rather than a habit of its call sites.
    leg: legFromAttributionHeaders(e?.response?.headers),
    abort: classifyEmbedAbort(err, kind),
  };
}

/** The once-per-process log key for a cause: kind + status + provider code. */
export function embedFailureKey(cause: EmbedFailureCause): string {
  return `${cause.kind}:${cause.status ?? '-'}:${cause.code ?? '-'}`;
}

/** A provider RATE LIMIT is TRANSIENT: worth ONE same-call retry after a short
 *  backoff (the whole batch rides it, so 20 recovered rows cost 2 calls, not
 *  21). A provider REJECTION (400 / 413 / 422) is worth the per-ROW retry
 *  below. Everything else — 401/403 (auth), 5xx, timeout, network — fails the
 *  same way again and only burns calls. (Ticket d7bf73c2: DashScope 429s
 *  dropped whole stores to keyword-only with zero retries.) */
export function embedFailureRateLimited(cause: EmbedFailureCause): boolean {
  return cause.kind === 'http_4xx' && cause.status === 429;
}

/** Only a provider REJECTION of the request (400 / 413 / 422) is worth a
 *  per-row retry — a 401/403, a 5xx, a timeout or a network fault fails
 *  the retry rows the same way and would only burn calls. A 429 is NOT here:
 *  it is transient for the WHOLE batch and handled by the rate-limit retry
 *  above (per-row calls during a throttle window all 429 too). */
export function embedFailureRetryable(cause: EmbedFailureCause): boolean {
  return cause.kind === 'http_4xx' && (cause.status === 400 || cause.status === 413 || cause.status === 422);
}

export const EMBED_ROW_RETRY_MAX_DEFAULT = 20;

export function embedRowRetryMax(envSource: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(envSource.UNIFIED_MEMORY_EMBED_ROW_RETRY_MAX || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : EMBED_ROW_RETRY_MAX_DEFAULT;
}

/** ── 429-aware backoff (ticket d7bf73c2) ─────────────────────────────────────
 * A throttled embed batch used to drop the WHOLE store keyword-only (Box C,
 * 2026-10-16: "0/7 row(s) stored keyword-only — http_4xx … Too many requests
 * … throttled") — 429 is transient for the entire batch, so the batch is
 * retried after a short backoff. The wait honours the provider's `Retry-After`
 * when it fits the in-call budget — a 10 s cap PER WAIT and CUMULATIVELY
 * across the retries (two Retry-After: 10 answers must not become a 20 s
 * wait in front of the INSERT; awaited memStore callers block on it); without
 * the header it backs off exponentially (0.75 s → 1.5 s), capped at 2 s so
 * the fire-and-forget store path never parks for long. A `Retry-After` LONGER
 * than the budget means the throttle window outlives it — no (further)
 * in-call retry (the rows
 * land NULL immediately and the memory-embed-backfill cron repairs them within
 * its 15-min cadence; holding the INSERT hostage to a minute-long window would
 * delay the keyword-only store too, since memStore inserts only after embed
 * resolves). `UNIFIED_MEMORY_EMBED_429_RETRY_DISABLED=1` is the kill switch
 * (the store still completes keyword-only, exactly as before). */
export const EMBED_429_BACKOFF_BASE_MS = 750;
export const EMBED_429_BACKOFF_MAX_MS = 2_000;
export const EMBED_429_RETRY_AFTER_HONOUR_MAX_MS = 10_000;

export function embed429RetryDisabled(envSource: NodeJS.ProcessEnv = process.env): boolean {
  return envSource.UNIFIED_MEMORY_EMBED_429_RETRY_DISABLED === '1';
}

/** The backoff before a rate-limit retry attempt (0-based): the provider's
 * `Retry-After` when it fits the in-call budget, else the exponential default.
 * -1 = the window outlives the budget — do not retry in-call at all. */
export function embed429BackoffMs(cause: EmbedFailureCause, attempt: number): number {
  if (cause.retryAfterSec !== null) {
    const asked = cause.retryAfterSec * 1000;
    return asked <= EMBED_429_RETRY_AFTER_HONOUR_MAX_MS ? asked : -1;
  }
  const exp = EMBED_429_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt));
  return Math.min(exp, EMBED_429_BACKOFF_MAX_MS);
}

export const EMBED_429_RETRY_ATTEMPTS_DEFAULT = 2;

export function embed429RetryAttempts(envSource: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(envSource.UNIFIED_MEMORY_EMBED_429_RETRIES || '', 10);
  return Number.isFinite(n) && n >= 0 ? n : EMBED_429_RETRY_ATTEMPTS_DEFAULT;
}

/** Tests inject a sub-millisecond sleeper so the exponential ladder is
 *  observable without wall-clock waits. */
export const embedTestHooks: { sleep?: (ms: number) => Promise<void> } = {};

export interface EmbedRowsResult {
  embeddings: (number[] | null)[];
  /** The batch failure, when the batch call threw (null = the batch succeeded). */
  cause: EmbedFailureCause | null;
  /** Rows re-embedded one by one after a rejected batch, and how many recovered. */
  retried: { attempted: number; recovered: number };
  /** Causes seen on the per-row retries that still failed (bounded, first 5). */
  rowCauses: EmbedFailureCause[];
  /** The 429 (or provider asked-to-wait) retries of the batch itself, when the
   *  throttle window closed and the batch went through on a later attempt. */
  rateLimitRetries: { attempted: number; recovered: number; waitedMs: number };
}

/**
 * Embed `texts` as one batch. Three failure classes, three policies:
 *  - 429 / provider asked-to-wait (ticket d7bf73c2): retry the WHOLE batch
 *    after a backoff (Retry-After honoured, else 0.75 s → 1.5 s, cap 2 s) —
 *    a throttle is transient for every row, and one retry recovers the whole
 *    store instead of dropping it keyword-only.
 *  - 400 / 413 / 422 (provider REJECTED the batch — often one bad input):
 *    re-embed row by row (up to `retryMax` rows) so one bad input does not
 *    de-embed the whole store.
 *  - anything else (401/403, 5xx, timeout, network): no retry — the rows land
 *    NULL and the memory-embed-backfill cron repairs them later.
 * Never throws — a row that cannot be embedded is null (keyword-only).
 */
export async function embedRowsWithRetry(
  texts: string[],
  embed: (batch: string[]) => Promise<(number[] | null)[]>,
  opts?: { retryMax?: number; rateLimitRetries?: number },
): Promise<EmbedRowsResult> {
  const retryMax = opts?.retryMax ?? embedRowRetryMax();
  const rateLimitRetriesMax = opts?.rateLimitRetries ?? (embed429RetryDisabled() ? 0 : embed429RetryAttempts());
  const out: EmbedRowsResult = { embeddings: texts.map(() => null), cause: null, retried: { attempted: 0, recovered: 0 }, rowCauses: [], rateLimitRetries: { attempted: 0, recovered: 0, waitedMs: 0 } };
  if (!texts.length) return out;
  const sleep = embedTestHooks.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let rateLimitAttempts = 0;
  let waitedTotalMs = 0;
  for (;;) {
    try {
      const batch = await embed(texts);
      out.embeddings = texts.map((_, i) => (Array.isArray(batch?.[i]) && batch[i]!.length ? batch[i] : null));
      // Success — even after throttled attempts. A recovered throttle is NOT a
      // failure: cause is cleared (no false "keyword-only" report to memStore)
      // and the recovery ride-along tells the story. `recovered` counts rows
      // recovered BY a retry (0 when the first call succeeded — it must agree
      // with the failure branch, which also reports 0).
      out.cause = null;
      out.rateLimitRetries = { attempted: rateLimitAttempts, recovered: rateLimitAttempts > 0 ? out.embeddings.filter(e => !!e).length : 0, waitedMs: waitedTotalMs };
      return out;
    } catch (err) {
      out.cause = describeEmbedFailure(err);
    }
    if (!embedFailureRateLimited(out.cause)) break;
    if (rateLimitAttempts >= rateLimitRetriesMax) break;
    const backoffMs = embed429BackoffMs(out.cause, rateLimitAttempts);
    if (backoffMs < 0) break; // Retry-After outlives the remaining in-call budget — the backfill cron owns these rows
    if (waitedTotalMs + backoffMs > EMBED_429_RETRY_AFTER_HONOUR_MAX_MS) break; // the CUMULATIVE wait is capped too: two Retry-After: 10 answers must not become a 20 s stall in front of the INSERT
    rateLimitAttempts++;
    waitedTotalMs += backoffMs;
    await sleep(backoffMs);
  }
  out.rateLimitRetries = { attempted: rateLimitAttempts, recovered: 0, waitedMs: waitedTotalMs };
  if (texts.length < 2 || retryMax <= 0 || !embedFailureRetryable(out.cause)) return out;
  const limit = Math.min(texts.length, retryMax);
  for (let i = 0; i < limit; i++) {
    out.retried.attempted++;
    try {
      const one = await embed([texts[i]]);
      const vec = Array.isArray(one?.[0]) && one[0]!.length ? one[0] : null;
      if (vec) { out.embeddings[i] = vec; out.retried.recovered++; }
    } catch (err) {
      if (out.rowCauses.length < 5) out.rowCauses.push(describeEmbedFailure(err));
    }
  }
  return out;
}
