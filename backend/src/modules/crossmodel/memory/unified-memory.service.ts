/**
 * UNIFIED DIGBY MEMORY — one embeddings table, one hybrid query pipeline, for
 * EVERY memory surface (chat + coding converging into one system, per the
 * One-Digby direction and the Cerebras knowledge-base architecture):
 *
 *   scope_type/scope_id rows: 'user' | 'project' | 'chat' | 'session'
 *   source: 'compaction' | 'web_pipe' | 'large_read' | 'worker' |
 *           'conversation' | 'code' | ... (open set — callers name their source)
 *
 * Query pipeline (no single scorer trusted alone): vector AND full-text legs
 * always both run → RRF fusion (weight/(60+rank)) → age decay (14d half-life,
 * 0.5 floor) → qwen3-rerank cross-encoder → top k. Writers pass a quality gate
 * so trivial content never pollutes the index; an optional `title` column holds
 * a distilled searchable one-liner that is embedded WITH the content.
 *
 * Storage is created idempotently at runtime (prod migrations are manual).
 * Everything is best-effort: a memory failure degrades recall, never a request.
 *
 * Cold tier (2026-10-20, memory-archive.ts): a full scope's cap sweep MOVES its
 * evicted rows into digby_memory_archive (text only, FTS) instead of deleting
 * them; explicit deletions purge both tiers; only the search_memory tool reads
 * the archive (memSearchArchive), as a labelled top-up.
 */

import * as crypto from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { embedTexts, rerankTexts } from '../rag.service';
import { stripNulBytes } from './text-utils';
import { embedRowsWithRetry, embedFailureKey, type EmbedRowsResult, type EmbedBucket, type EmbedFailureCause } from './embed-failure';
import {
  ARCHIVE_DDL, ARCHIVE_EXISTS_SQL, ARCHIVE_PURGE_REFS_SQL, ARCHIVE_PURGE_REFS_EXCEPT_SQL, ARCHIVE_PURGE_SCOPE_SQL,
  archiveEvictionSql, archiveRefsEvictionSql, memoryArchiveDisabled,
} from './memory-archive';
// The cold tier's retention job + constants, re-exported so callers import one module.
export {
  runMemoryArchiveRetention, memoryArchiveDisabled, ARCHIVE_SESSION_RETENTION_DAYS, ARCHIVE_RETENTION_DAYS, ARCHIVED_LABEL,
} from './memory-archive';

/** Per-row retry calls after a rejected batch are bounded short (the store
 *  path is fire-and-forget behind a turn; 20 rows × 30 s would be a minute). */
const EMBED_ROW_RETRY_TIMEOUT_MS = 8000;
/** Embed-failure causes already logged at warn this process (later ones debug). */
const embedFailureNoticed = new Set<string>();
export function __resetEmbedFailureNoticeForTests(): void { embedFailureNoticed.clear(); }

/**
 * The metric meta an embed failure writes — PURE and exported so the pinning
 * test (embed-failure.attribution.test.ts) asserts the REAL emitted shape
 * rather than a re-implementation of it.
 *
 * Attribution keys LEAD: `bucket`/`abort`/`leg` are what the 24 h unattributed
 * probe reads (goal 4e432dff), and meta is truncated on write, so they must
 * never be casualties of a long providerMessage below them.
 */
export function embedFailureMetricMeta(
  cause: EmbedFailureCause,
  ctx: { rows: number; maxChars: number; source: string; scopeType: string; bucket?: EmbedBucket },
  r: Pick<EmbedRowsResult, 'retried' | 'rateLimitRetries'>,
): Record<string, unknown> {
  const bucket: EmbedBucket = ctx.bucket ?? 'store';
  return {
    bucket, abort: cause.abort, leg: cause.leg,
    kind: cause.kind, status: cause.status, code: cause.code, providerMessage: cause.providerMessage,
    rows: ctx.rows, maxChars: ctx.maxChars, source: ctx.source, scopeType: ctx.scopeType,
    retried: r.retried.attempted, recovered: r.retried.recovered,
    // The 429 ride-along (d7bf73c2, review follow-up 2): WITHOUT this, an
    // in-call throttle recovery is invisible in production — the metric and
    // the log line both fire only on embedded.cause (a failure), so a batch
    // that 429'd once and recovered never showed anywhere.
    rateLimitRetries: r.rateLimitRetries.attempted, rateLimitRecovered: r.rateLimitRetries.recovered, rateLimitWaitedMs: r.rateLimitRetries.waitedMs,
  };
}

/** Log the cause once per cause per process (warn; then debug) and count it. */
function reportEmbedFailure(r: EmbedRowsResult, ctx: { rows: number; maxChars: number; source: string; scopeType: string; bucket?: EmbedBucket }): void {
  const cause = r.cause!;
  const nulls = r.embeddings.filter(e => !e).length;
  // Write-time ATTRIBUTION (goal 4e432dff): the flow that attempted the call and
  // the side/leg it ended on. Before this, a row here could say HOW it failed
  // (`kind`/`status`/`code`) but never WHO was storing or WHICH upstream refused
  // — and 88 prod failures in the 2026-11-02 window were unattributable for
  // exactly that reason (the gateway log proved the provider answered 200 every
  // time, so the answer was on our side of a dimension we did not write).
  // `cause.leg`/`cause.abort` are populated on EVERY failure by
  // describeEmbedFailure, so the dimension cannot be forgotten at a call site.
  const bucket: EmbedBucket = ctx.bucket ?? 'store';
  const key = embedFailureKey(cause);
  const line = `unified-memory: embed failed, ${nulls}/${ctx.rows} row(s) stored keyword-only — ${cause.kind}${cause.status !== null ? ` HTTP ${cause.status}` : ''}${cause.code ? ` code=${cause.code}` : ''}${cause.providerMessage ? ` provider="${cause.providerMessage}"` : ''} (${cause.message}); rows=${ctx.rows} maxChars=${ctx.maxChars} source=${ctx.source} scope=${ctx.scopeType} bucket=${bucket} abort=${cause.abort}${cause.leg ? ` leg=${cause.leg}` : ''}; per-row retry ${r.retried.attempted ? `${r.retried.recovered}/${r.retried.attempted} recovered` : 'not attempted'}`;
  if (!embedFailureNoticed.has(key)) {
    embedFailureNoticed.add(key);
    logger.warn(`${line} (logged once per cause per process; counted as unified_memory_embed_failed)`);
  } else {
    logger.debug(line);
  }
  void import('../platform/loop-metrics.service')
    .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
      kind: LOOP_METRIC_KINDS.UNIFIED_MEMORY_EMBED_FAILED,
      value: nulls,
      unit: 'rows',
      meta: embedFailureMetricMeta(cause, ctx, r),
    }))
    .catch(() => undefined);
}
import { authorizedProjectScopeIds, ownedProjectIds, ownsAllProjects } from './memory-access';

// ── Query-time search budget (2026-09-23) ────────────────────────────────────
// Prod: ~100 "Pipeline project learnings: soft deadline hit" per day while
// both DB legs answer in ~20 ms — the misses are the two DashScope round trips
// (embed + rerank) queueing behind bulk ingestion embeds on the same key. The
// outer Promise.race discarded a lookup that was 90% done. Now a caller with a
// deadline gets a TIME-BOXED search: the embed call's HTTP timeout is the
// remaining budget (keyword leg still answers on a miss), rerank is SKIPPED
// when too little budget remains (fused RRF order is returned instead of
// nothing), and every search records per-leg timings so the operator can see
// which leg spikes. A tiny query-embedding cache removes the repeated embeds
// one context build issues for the SAME retrieval message (learnings +
// episodic + coding retrieval).
export const RERANK_MIN_REMAINING_MS = 1500;
// ── Vector-leg shape (2026-09-23, hardening-loop iteration 2) ────────────────
// The FIRST time-box telemetry overturned the DashScope diagnosis: the slow leg
// was the VECTOR QUERY (p90 14 s, worst 33 s for project_learnings). Two causes,
// both measured with EXPLAIN in prod: (1) a scope-filtered `ORDER BY embedding
// <=> $q LIMIT n` on a LARGE scope made the planner take the HNSW index scan
// and post-filter — with hnsw.iterative_scan=off (RDS default) it stops after
// ef_search candidates and returned 0 of 18 rows for the largest project scope
// (17k rows): the semantic leg was silently EMPTY there; (2) on the bitmap
// path every in-scope row's 6 KB TOASTed embedding is fetched — 75k rows for
// the owner's 34-project blended learnings shape (2.05 s), 17k rows for a big
// scope (13.8 s cold). Shape now: a MATERIALIZED id-only CTE pre-filters by
// scope (+ source) through the btree index and caps candidates by recency
// (MEM_SEARCH_SCAN_CAP, default 4000 — rows beyond it are still reachable
// through the keyword leg), then the distance sort runs over the JOIN: 18/18
// rows in 2.6 s cold / 97 ms warm on the largest scope, 0.42 s for the blended
// learnings shape (before the composite index). A composite btree
// (scope_type, scope_id, source) is created CONCURRENTLY in the background so
// source-filtered lookups touch only their rows.
export const MEM_SEARCH_SCAN_CAP_DEFAULT = 4000;
export function memSearchScanCap(): number {
  const n = Number(process.env.MEM_SEARCH_SCAN_CAP);
  return Number.isFinite(n) && n >= 100 ? Math.floor(n) : MEM_SEARCH_SCAN_CAP_DEFAULT;
}
// ── Wide-blend scope fan-in (FO firing 12, 2026-09-23) ────────────────────────
// The warm sample after d2b7bd53 (n=90, 21:36Z): purpose=project_learnings vec
// p50 3667 / p90 9279 ms while narrow lookups (p50 308 ms) proved the prefilter
// itself fine. Measured with EXPLAIN (ANALYZE, BUFFERS) on the owner's real
// blend (34 owned projects, 4040 learning/decision rows): the CTE prefilter is
// CHEAP (~2.2k buffers) — the cost is the outer join fetching every candidate's
// 6 KB TOASTed embedding+content (~8.4 buffers/row). Cap 4000 → 35.8k buffers
// (≈ the observed 3.7 s p50); the same shape at 512 candidates → 6.4k buffers
// (5.6× less). The blend's 4040 rows make the 4000 cap a no-op, so the distance
// sort joined ~4000 candidate embeddings to return the top 12. Fix: when a
// search fans in over WIDE_BLEND_SCOPES (default 10) scopes, each scope
// contributes at most its newest WIDE_BLEND_PER_SCOPE (default 16) candidates
// (ROW_NUMBER partition) — 34 projects → ≤544 candidates, EVERY project still
// represented (a single global recency cap lets the most-active project
// dominate), and older rows stay reachable through the keyword leg, which is
// uncapped.
export const WIDE_BLEND_SCOPES_DEFAULT = 10;
export const WIDE_BLEND_PER_SCOPE_DEFAULT = 16;
export function wideBlendScopes(): number {
  const n = Number(process.env.MEM_SEARCH_WIDE_BLEND_SCOPES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : WIDE_BLEND_SCOPES_DEFAULT;
}
export function widePerScopeQuota(): number {
  const n = Number(process.env.MEM_SEARCH_WIDE_PER_SCOPE);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : WIDE_BLEND_PER_SCOPE_DEFAULT;
}
/** The per-scope candidate quota for a wide blend, or undefined when the
 *  global-recency cap should run (narrow blends). */
export function wideBlendQuotaFor(scopeCount: number): number | undefined {
  if (scopeCount <= wideBlendScopes()) return undefined;
  return widePerScopeQuota();
}
/** The vector leg's SQL. Exported for the shape pins. */
export function vectorLegSql(base: string, after: number, k: number, scopes = 1): string {
  const quota = wideBlendQuotaFor(scopes);
  if (quota !== undefined) {
    return `WITH scoped AS MATERIALIZED (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY scope_type, scope_id ORDER BY created_at DESC) AS rn
             ${base} AND embedding IS NOT NULL
           ) w WHERE rn <= ${quota}
         )
         SELECT m.id, m.ref, m.title, m.source, m.content, m.scope_type, m.scope_id, m.created_at
         FROM digby_memory m JOIN scoped s ON s.id = m.id
         ORDER BY m.embedding <=> $${after}::vector LIMIT ${k * 3}`;
  }
  return `WITH scoped AS MATERIALIZED (
           SELECT id ${base} AND embedding IS NOT NULL ORDER BY created_at DESC LIMIT ${memSearchScanCap()}
         )
         SELECT m.id, m.ref, m.title, m.source, m.content, m.scope_type, m.scope_id, m.created_at
         FROM digby_memory m JOIN scoped s ON s.id = m.id
         ORDER BY m.embedding <=> $${after}::vector LIMIT ${k * 3}`;
}
// 800 → 1200 default, env-tunable (operator iteration 14, 2026-09-25): a
// DashScope latency wobble tripped the 800 ms floor 4× in one hour (keyword
// leg still served). UNIFIED_MEMORY_EMBED_MIN_TIMEOUT_MS overrides.
const EMBED_MIN_TIMEOUT_MS = (() => { const n = Number(process.env.UNIFIED_MEMORY_EMBED_MIN_TIMEOUT_MS); return Number.isFinite(n) && n >= 200 ? Math.floor(n) : 1200; })();
const QUERY_EMBED_CACHE_TTL_MS = 10 * 60_000;
const QUERY_EMBED_CACHE_MAX = 200;
const queryEmbedCache = new Map<string, { at: number; vec: number[] }>();
/** Test seam. */
export function _clearQueryEmbedCache(): void { queryEmbedCache.clear(); }
function cachedQueryEmbedding(text: string): number[] | undefined {
  const key = crypto.createHash('sha1').update(text).digest('hex');
  const hit = queryEmbedCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > QUERY_EMBED_CACHE_TTL_MS) { queryEmbedCache.delete(key); return undefined; }
  return hit.vec;
}
function rememberQueryEmbedding(text: string, vec: number[]): void {
  if (!Array.isArray(vec) || !vec.length) return;
  const key = crypto.createHash('sha1').update(text).digest('hex');
  queryEmbedCache.set(key, { at: Date.now(), vec });
  if (queryEmbedCache.size > QUERY_EMBED_CACHE_MAX) {
    const oldest = queryEmbedCache.keys().next().value;
    if (oldest !== undefined) queryEmbedCache.delete(oldest);
  }
}

// ── Embed circuit breaker (FO f185, 2026-10-22) ─────────────────────────────
// The 2026-10-22 DashScope outage failed the embed leg of ~70% of memory
// searches for 6+ straight hours (embed_failed 100–150/h, semantic-leg warns
// 87–149/h) and every search paid the doomed call's latency before the keyword
// leg answered (project_learnings p50 10.7 s vs ~1 s healthy). After
// EMBED_BREAKER_THRESHOLD consecutive embed failures the breaker OPENS for
// EMBED_BREAKER_COOLDOWN_MS: memSearch skips the embed HTTP call (and the
// rerank round trip) outright — the keyword leg answers immediately, the
// timing row stamps embedBreaker — then HALF-OPENS on one trial embed; success
// closes and resets, failure re-opens at double the cooldown (cap
// EMBED_BREAKER_MAX_COOLDOWN_MS). One loop_metrics row per transition (kind
// unified_memory_embed_breaker). Cached query embeddings never touch the
// breaker (no HTTP call). The embed leg is the canary: a rerank-only failure
// (null return, never a throw) does not feed the counter — rerank is only
// gated while the breaker is already open. Process-local like the DeepSeek
// billing latch: web + worker converge on their own signal.
// UNIFIED_MEMORY_EMBED_BREAKER_DISABLED=1 restores the always-call behaviour
// from box env without a deploy (a mis-firing breaker would mask a healthy
// vendor's semantic leg in cooldown windows).
const EMBED_BREAKER_THRESHOLD = 8;
const EMBED_BREAKER_COOLDOWN_MS = 120_000;
const EMBED_BREAKER_MAX_COOLDOWN_MS = 600_000;
let embedBreakerFailures = 0;
let embedBreakerOpenUntil = 0;
let embedBreakerCooldownMs = EMBED_BREAKER_COOLDOWN_MS;
function embedBreakerDisabled(): boolean { return process.env.UNIFIED_MEMORY_EMBED_BREAKER_DISABLED === '1'; }
function embedBreakerIsOpen(): boolean { return !embedBreakerDisabled() && embedBreakerOpenUntil > Date.now(); }
function embedBreakerTrialPending(): boolean { return !embedBreakerDisabled() && embedBreakerOpenUntil > 0 && embedBreakerOpenUntil <= Date.now(); }
function recordEmbedBreakerTransition(transition: string): void {
  void import('../platform/loop-metrics.service')
    .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
      kind: LOOP_METRIC_KINDS.UNIFIED_MEMORY_EMBED_BREAKER,
      meta: { transition, failures: embedBreakerFailures, cooldownMs: embedBreakerCooldownMs, openUntil: embedBreakerOpenUntil || undefined },
    }))
    .catch(() => undefined);
}
function embedBreakerOnSuccess(): void {
  const wasTrialing = embedBreakerOpenUntil > 0;
  embedBreakerFailures = 0;
  embedBreakerOpenUntil = 0;
  if (wasTrialing) {
    embedBreakerCooldownMs = EMBED_BREAKER_COOLDOWN_MS;
    recordEmbedBreakerTransition('close');
  }
}
function embedBreakerOnFailure(): void {
  if (embedBreakerDisabled()) return;
  embedBreakerFailures += 1;
  const now = Date.now();
  if (embedBreakerOpenUntil > now) return; // already open — calls are gated
  if (embedBreakerOpenUntil > 0) {
    // half-open trial failed — back off harder: the re-open window IS the
    // doubled cooldown (double first, then arm).
    embedBreakerCooldownMs = Math.min(embedBreakerCooldownMs * 2, EMBED_BREAKER_MAX_COOLDOWN_MS);
    embedBreakerOpenUntil = now + embedBreakerCooldownMs;
    recordEmbedBreakerTransition('reopen');
    return;
  }
  if (embedBreakerFailures >= EMBED_BREAKER_THRESHOLD) {
    embedBreakerOpenUntil = now + embedBreakerCooldownMs;
    recordEmbedBreakerTransition('open');
  }
}
/** Test seam. */
export function _embedBreakerState(): { failures: number; openUntil: number; cooldownMs: number } {
  return { failures: embedBreakerFailures, openUntil: embedBreakerOpenUntil, cooldownMs: embedBreakerCooldownMs };
}
/** Test seam. */
export function _resetEmbedBreaker(): void { embedBreakerFailures = 0; embedBreakerOpenUntil = 0; embedBreakerCooldownMs = EMBED_BREAKER_COOLDOWN_MS; }
export interface MemSearchOpts {
  sources?: string[];
  /** Only rows whose ref is one of these (2026-10-22: a supervisor's own
   *  user-scope 'conversation' distills — ref = its chat id). Applies to every
   *  scope in the call, so callers pass it on a single-scope search. */
  refs?: string[];
  /** Wall-clock budget for the whole search (ms). Time-boxes the embed HTTP
   *  timeout and skips rerank when < RERANK_MIN_REMAINING_MS remain. */
  deadlineMs?: number;
  /** Label for the timing metric (e.g. 'project_learnings', 'episodic'). */
  purpose?: string;
}

export type MemScopeType = 'user' | 'project' | 'chat' | 'session';
export interface MemScope { type: MemScopeType; id: string; }
export interface MemItem { ref?: string; title?: string; content: string; }
export interface MemHit { ref: string; title: string; source: string; content: string; scopeType: MemScopeType; scopeId: string; createdAt: string; }
/** A hit from the owned-project blend — carries WHICH project it came from so
 *  the caller (and the model) can tell "this project" from "another of mine". */
export interface MemBlendedHit extends MemHit {
  projectId: string;
  /** Display name of the project the hit belongs to (null when it could not be resolved). */
  projectName: string | null;
  /** true when the hit came from a project OTHER than the primary set. */
  crossProject: boolean;
}

/** Owned-project blend: at most this many of the caller's other projects join a query. */
export const BLEND_OWNED_PROJECT_CAP = 50;

const CHUNK_CHARS = 3500;
const MAX_ITEM_CHARS = 40_000;
const MAX_CHUNKS_PER_STORE = 40;
const SCOPE_CAP = 800;               // newest N rows kept per scope (project: per source)
const DECAY_HALF_LIFE_DAYS = 14;

// ── Dynamic SESSION-scope retention (owner 2026-09-24: "shouldn't session scope
// memory be more dynamic") ───────────────────────────────────────────────────
// Before: one source-blind newest-800 cap per session scope. A busy lane writes
// ~140 orchestrator chunks an hour, so its window was 5–6 h and a compaction
// summary (the only record of transcript that was cut) was pushed out by the
// afternoon's tool output; prod 2026-09-24: 18,305 session rows evicted/day,
// e.g. scope 165b5d36 = 771 orchestrator vs 28 compaction rows.
// Now, for session scopes: (1) the cap is PER SOURCE (compaction / decision /
// cross_checker never compete with orchestrator chunks — the same shape the
// project scope has had since 2026-09-14); (2) rows younger than
// SESSION_SCOPE_MIN_RETENTION_HOURS are never evicted by the source cap (a
// lane's last day is always there for the fold and for retrieval); (3) a
// scope-wide HARD ceiling still bounds runaway growth (the vector prefilter's
// recency cap keeps search cost flat). User scopes keep the plain cap.
export const SESSION_SCOPE_MIN_RETENTION_HOURS_DEFAULT = 24;
export const SESSION_SCOPE_HARD_CAP_DEFAULT = 6000;
/** audit 2026-10-06 T1-5: session-scope store dedupe off (every chunk stored, as before). */
export function memorySessionDedupeDisabled(): boolean { return process.env.MEMORY_SESSION_DEDUPE_DISABLED === '1'; }
export function sessionScopeMinRetentionHours(): number {
  const n = Number(process.env.SESSION_SCOPE_MIN_RETENTION_HOURS);
  return Number.isFinite(n) && n >= 0 ? n : SESSION_SCOPE_MIN_RETENTION_HOURS_DEFAULT;
}
/** Hit-aware eviction: a row memSearch returned within this window is kept
 *  ahead of never-hit rows when the session source cap sweeps. Bounded so a
 *  row hit once long ago cannot outlive fresh rows forever. */
export const MEM_HIT_KEEP_DAYS_DEFAULT = 7;
export function memHitKeepDays(): number {
  const n = Number(process.env.MEM_HIT_KEEP_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : MEM_HIT_KEEP_DAYS_DEFAULT;
}
export function sessionScopeHardCap(): number {
  const n = Number(process.env.SESSION_SCOPE_HARD_CAP);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : SESSION_SCOPE_HARD_CAP_DEFAULT;
}

// ── Hard-ceiling eviction ORDER (audit 2026-10-06 finding 4 / X2) ───────────
// The scope-wide ceiling was pure recency: once a long-lived chat (the Fleet
// Supervisor lives for weeks) wrote 6000 rows inside the 24 h source-cap floor,
// the ceiling dropped the oldest row whatever it was — a compaction summary
// (the only record of cut transcript), a worker digest, a row search_memory had
// just returned — so its memory spanned ~17 h and ~97 % of offloads left
// unread. Now the ceiling's keep set is TIERED:
//   1. rows a search returned within MEM_HIT_KEEP_DAYS (used memory stays);
//   2. rows younger than MEMORY_CEILING_FRESH_HOURS (an offload's "search_memory
//      for detail" promise holds for the run that made it);
//   3. UNIQUE records (compaction / intermediate / worker digests / anything
//      not listed below) ahead of re-fetchable tool output — a read_file /
//      grep / scrape / search / pipe result is a COPY of something that still
//      exists at its source and can be fetched again;
//   4. newest first.
// The ceiling itself (SESSION_SCOPE_HARD_CAP) is unchanged — the search-cost
// bound stays; only WHICH rows fall past it changes. Kill switch
// MEMORY_CEILING_TIERED_EVICTION_DISABLED=1 restores pure recency.
export const MEMORY_CEILING_FRESH_HOURS = 6;
/** Sources whose session rows are copies of re-fetchable tool output: the
 *  agent loop offloads tool results under the worker ROLE name (coding/roles.ts
 *  CodingRole, + 'orchestrator'), and the web / YouTube pipes store their
 *  fetched pages. A role's `<role> digest` row is that worker's own summary —
 *  unique, never re-fetchable (excluded by ref below). Pinned against the
 *  CodingRole list by unified-memory.ceiling.test.ts. */
export const REFETCHABLE_SESSION_SOURCES: readonly string[] = [
  'orchestrator', 'planner', 'architect', 'explorer', 'web_researcher', 'cross_checker',
  'coder', 'editor', 'verifier', 'reviewer', 'web_pipe', 'youtube_pipe',
];
export function memoryCeilingTieredEvictionDisabled(): boolean { return process.env.MEMORY_CEILING_TIERED_EVICTION_DISABLED === '1'; }
/** SQL predicate: this row is re-fetchable tool output (not a unique record). */
export function refetchableRowSql(): string {
  const list = REFETCHABLE_SESSION_SOURCES.map((s) => `'${s.replace(/'/g, "''")}'`).join(', ');
  return `(source IN (${list}) AND coalesce(ref, '') NOT LIKE '% digest')`;
}
/** The tiered keep order for the session hard ceiling (see the note above). */
export function sessionCeilingKeepOrderSql(): string {
  return `ORDER BY (last_hit_at IS NOT NULL AND last_hit_at > now() - make_interval(days => ${memHitKeepDays()})) DESC, `
    + `(created_at > now() - make_interval(hours => ${MEMORY_CEILING_FRESH_HOURS})) DESC, `
    + `${refetchableRowSql()} ASC, created_at DESC`;
}

// ── Pure helpers (exported for reuse + tests) ────────────────────────────────

/** Age decay: dampen (never kill) old rows — [0.5, 1] multiplier. */
export function ageDecayFactor(createdAt: Date | string | null | undefined, now = Date.now()): number {
  if (!createdAt) return 1;
  const ageDays = Math.max(0, (now - new Date(createdAt).getTime()) / 86_400_000);
  return 0.5 + 0.5 * Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}

/** RRF fusion of independently-ranked row lists (weight/(60+rank), keyed by id). */
export function rrfFuse<T extends { id: string }>(lists: T[][], smoothing = 60): Array<T & { rrf: number }> {
  const scores = new Map<string, { row: T; rrf: number }>();
  for (const list of lists) {
    list.forEach((row, rank) => {
      const cur = scores.get(row.id) || { row, rrf: 0 };
      cur.rrf += 1 / (smoothing + rank);
      scores.set(row.id, cur);
    });
  }
  return [...scores.values()].sort((a, b) => b.rrf - a.rrf).map(v => ({ ...v.row, rrf: v.rrf }));
}

/** Quality gate: don't embed "sounds good, thanks!" — short content passes only
 *  with concrete signal (paths, errors, code-ish tokens, URLs, numbers). */
export function worthEmbedding(content: string): boolean {
  const t = content.trim();
  if (t.length >= 200) return true;
  if (t.length < 25) return false;
  return /[\/\\]|\berror\b|Error|https?:|[a-zA-Z_]+\(|[a-zA-Z0-9_]+\.[a-zA-Z]{2,4}\b|\d{2,}|`|_/.test(t);
}

// ── Source prior (ticket 7852814c) ───────────────────────────────────────────
// A 'compaction' chunk is a distilled SUMMARY of content that also lives
// verbatim in primary-source chunks ('web_pipe', 'youtube_pipe', 'large_read',
// 'code', …). On fact-retrieval queries the verbatim source must outrank the
// summary — otherwise search_memory hands back meta-summaries (in the
// recursive-pollution case, summaries of summaries) instead of the ground
// truth. Dampen, never kill: a summary still surfaces when no source chunk
// matches the query.
const COMPACTION_SOURCE_PRIOR = 0.4;

/** Fact-retrieval heuristic — the query carries a specific-token signal
 *  (paths, URLs, identifiers, numbers, code spans; the same signal family as
 *  worthEmbedding's quality gate). */
export function isFactRetrievalQuery(query: string): boolean {
  return /[\/\\]|\berror\b|https?:|[a-zA-Z_]+\(|[a-zA-Z0-9_]+\.[a-zA-Z]{2,4}\b|\d{2,}|`|_/.test(query);
}

/** Score multiplier for a row's source under this query. Non-factual queries
 *  get 1.0 everywhere — pure relevance ranking, unchanged behavior. */
export function sourcePrior(source: string | null | undefined, query: string): number {
  return source === 'compaction' && isFactRetrievalQuery(query) ? COMPACTION_SOURCE_PRIOR : 1;
}

/**
 * Postgres `text` columns reject NUL bytes (0x00) with error 22021 — and one
 * bad row poisons the whole multi-row INSERT in memStore (prod telemetry:
 * 18 lost memory writes / 7d from scraped pages, tool output, and indexed
 * files carrying stray NULs). Strip them at the write boundary. All other C0
 * controls are legal in `text`, so they are left untouched.
 */
export { stripNulBytes };

const FTS_LONG_QUERY_CHARS = 160;
const FTS_MAX_TOKENS = 12;
const FTS_TOKEN_STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'were', 'been', 'when', 'then', 'than',
  'what', 'where', 'which', 'would', 'should', 'could', 'into', 'only', 'over',
  'about', 'their', 'there', 'these', 'those', 'because', 'session', 'please',
]);

/** Distinctive query tokens for an OR-ed keyword query: lower-case word runs of
 *  length ≥ 4, stopwords dropped, deduped, capped at FTS_MAX_TOKENS. Sanitized
 *  to plain word chars so the text stays a safe bound parameter. */
function ftsDistinctiveTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of query.toLowerCase().match(/[a-z0-9_][a-z0-9_.-]{3,}/g) || []) {
    const tok = raw.replace(/[^a-z0-9_]/g, ' ').trim().split(/\s+/).filter(t => t.length >= 4 && !FTS_TOKEN_STOPWORDS.has(t))[0];
    if (tok) seen.add(tok);
    if (seen.size >= FTS_MAX_TOKENS) break;
  }
  return [...seen];
}

/**
 * FTS query text for one search. plainto_tsquery/websearch_to_tsquery AND every
 * word together — fine for short targeted queries, but the injection callers
 * pass LONG texts (a whole user message, toolName + 500 chars of error output)
 * where all-words-in-one-chunk never matches, so the keyword leg was silently
 * dead exactly where recall matters most (owner 2026-09-04). Long queries are
 * reduced to their distinctive tokens OR-ed together (websearch_to_tsquery
 * understands the OR keyword; tokens are sanitized to word chars so the query
 * text stays a plain bound parameter).
 *
 * NOTE the short-query half of this same trap is handled by the zero-row OR
 * retry at the keyword leg (see `ftsQueryOrFor`): a ≤160-char query keeps AND
 * precision on the first attempt, and only when that matches NOTHING does the
 * OR form get one bounded retry.
 */
export function ftsQueryFor(query: string): string {
  if (query.length <= FTS_LONG_QUERY_CHARS) return query;
  const toks = ftsDistinctiveTokens(query);
  return toks.length ? toks.join(' OR ') : query.slice(0, FTS_LONG_QUERY_CHARS);
}

/**
 * The OR form of a query, for the keyword leg's zero-row retry (ticket
 * ba3d62cf, 2026-11-01). `websearch_to_tsquery` ANDs every term of a short
 * query, so ONE token absent from every stored row yields ZERO keyword rows
 * even when the stored row is a strong subject match — e.g. the query
 * "…arrested human trafficking bust latest numbers" against a SERP row about
 * the same operation that never uses the word "numbers". With the semantic leg
 * also down (an embed timeout, or a row stored `embedding IS NULL` — the
 * vector leg excludes those and has no similarity floor), BOTH ranked legs
 * answered empty and the read fell through to the raw-recall rescue: that is
 * the `raw-fallback` path, and it is what fired 3× in run 7e1e6594.
 *
 * Returns null when the query yields no distinctive tokens (an all-stopword
 * query is not widened — OR-ing nothing would scan the scope).
 */
export function ftsQueryOrFor(query: string): string | null {
  const toks = ftsDistinctiveTokens(query);
  return toks.length ? toks.join(' OR ') : null;
}

// ── Table ────────────────────────────────────────────────────────────────────

let tableReady: Promise<void> | null = null;
async function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS digby_memory (
          id text PRIMARY KEY,
          scope_type text NOT NULL,
          scope_id text NOT NULL,
          user_id text,
          source text NOT NULL,
          ref text,
          title text,
          content text NOT NULL,
          embedding vector(1536),
          created_at timestamptz NOT NULL DEFAULT now()
        )`);
      // Hit-aware eviction (owner 2026-09-24 "shouldn't session scope memory be
      // more dynamic", step 2): memSearch stamps the rows it returns; the
      // session source cap keeps recently-HIT rows ahead of never-hit ones.
      await prisma.$executeRawUnsafe(`ALTER TABLE digby_memory ADD COLUMN IF NOT EXISTS last_hit_at timestamptz`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS digby_mem_scope_idx ON digby_memory (scope_type, scope_id)`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS digby_mem_user_idx ON digby_memory (user_id)`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS digby_mem_fts_idx ON digby_memory USING gin (to_tsvector('english', coalesce(title,'') || ' ' || content))`);
      try { await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS digby_mem_vec_idx ON digby_memory USING hnsw (embedding vector_cosine_ops)`); }
      catch { /* HNSW unavailable on older pgvector — cosine scan still works */ }
      // Composite scope+source btree (2026-09-23, see the vector-leg note): built
      // CONCURRENTLY and NOT awaited — on a 212k-row table the build takes tens
      // of seconds and must not hold the first memory op of a fresh process (or
      // block writers). $executeRawUnsafe runs autocommit, which CONCURRENTLY
      // requires. A concurrent build racing another process may fail; the next
      // process retries. Until it exists the old scope index serves the query.
      void prisma.$executeRawUnsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS digby_mem_scope_src_idx ON digby_memory (scope_type, scope_id, source)`)
        .catch((err: any) => logger.warn(`unified-memory: composite scope/source index build skipped this process (non-fatal): ${err?.message ?? err}`));
      // Cold tier (owner 2026-10-20 "archive instead of delete", memory-archive.ts).
      // Never throws: an archive that cannot be created leaves the hot store
      // fully working and the cap sweeps on today's plain DELETE.
      await ensureArchiveTable();
    })().catch(err => { tableReady = null; throw err; });
  }
  return tableReady;
}

// ── Cold tier state (2026-10-20) ─────────────────────────────────────────────
// 'ready' once the archive DDL ran (or the table already exists — the
// concurrent-boot race: two processes racing CREATE … IF NOT EXISTS can fail
// one of them on a catalog unique key, so a failed DDL re-probes with
// to_regclass before giving up). 'failed' = no archive this process: every cap
// sweep is today's DELETE; the next process (every deploy) retries.
type ArchiveState = 'unknown' | 'ready' | 'failed';
let archiveState: ArchiveState = 'unknown';
let archiveFallbackNoticed = false;
/** Test seam: forget the table + archive readiness so the next op re-runs the DDL. */
export function __resetMemoryTablesForTests(): void { tableReady = null; archiveState = 'unknown'; archiveFallbackNoticed = false; }

async function ensureArchiveTable(): Promise<void> {
  try {
    for (const sql of ARCHIVE_DDL) await prisma.$executeRawUnsafe(sql);
    archiveState = 'ready';
    return;
  } catch (err: any) {
    try {
      const probe = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(ARCHIVE_EXISTS_SQL);
      if (Array.isArray(probe) && probe[0]?.ok) {
        // Another process won the race: the table is there; the indexes are
        // IF NOT EXISTS, so retry each once (a racing index build is harmless).
        for (const sql of ARCHIVE_DDL.slice(1)) await prisma.$executeRawUnsafe(sql).catch(() => undefined);
        archiveState = 'ready';
        return;
      }
    } catch { /* probe failed too — treat as unavailable */ }
    archiveState = 'failed';
    logger.warn(`unified-memory: archive table digby_memory_archive unavailable this process — cap sweeps DELETE as before (non-fatal): ${err?.message ?? err}`);
  }
}

/** The archiving eviction failed at run time — log ONCE per process (the sweep falls back to the plain DELETE). */
function noteArchiveFallback(err: any): void {
  if (archiveFallbackNoticed) return;
  archiveFallbackNoticed = true;
  logger.warn(`unified-memory: archiving eviction failed — this sweep (and later failing ones) DELETE as before, so a cap is never skipped (logged once per process; counted as archiveFailed on memory_scope_evicted): ${err?.message ?? err}`);
}

/** Best-effort archive purge for an explicit deletion. Always attempted — even
 *  when this process could not create the archive (an earlier process may have
 *  archived rows; a user's deletion must reach them) or archiving is switched
 *  off. Silent on failure (no archive table = nothing to purge). */
async function purgeArchive(sql: string, ...params: any[]): Promise<void> {
  try { await prisma.$executeRawUnsafe(sql, ...params); } catch { /* nothing archived to clear */ }
}

function chunk(content: string): string[] {
  const c = content.slice(0, MAX_ITEM_CHARS);
  const out: string[] = [];
  for (let i = 0; i < c.length; i += CHUNK_CHARS) out.push(c.slice(i, i + CHUNK_CHARS));
  return out;
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Store items into a scope (gate → chunk → embed → insert → cap). The distilled
 * `title` is prefixed into the embedded text so the semantic match sees it, and
 * kept as its own column for display. Best-effort; returns rows written.
 * `skipGate` bypasses the worthEmbedding quality gate for CURATED content
 * (learnings.md entries): a short plain-prose convention is exactly what that
 * gate drops, and the learnings sync then pinned the entry as indexed with
 * zero rows stored (owner 2026-09-04).
 *
 * `opts.userId` is stamped into `user_id` on every row. Reads are gated by
 * SCOPE (see memSearchForUser — project access is decided from
 * crossmodel_projects/project_members, not from this column), so the stamp is
 * provenance, not authorization — but project-scope writers (the code index,
 * the learnings sync, the KB/decision bridges) SHOULD pass the acting user's id
 * so a row can always be traced to who caused it (owner 2026-09-14 per-user gates).
 */
export async function memStore(
  scope: MemScope,
  source: string,
  items: MemItem[],
  opts?: { userId?: string; cap?: number; maxChunks?: number; skipCap?: boolean; skipGate?: boolean }
): Promise<number> {
  const rows: { ref: string; title: string; content: string }[] = [];
  for (const it of items) {
    const content = it?.content ? stripNulBytes(it.content) : '';
    if (!content.trim()) continue;
    if (!opts?.skipGate && !worthEmbedding(content)) continue;
    for (const part of chunk(content)) {
      rows.push({ ref: stripNulBytes((it.ref || '').slice(0, 400)), title: stripNulBytes((it.title || '').slice(0, 500)), content: part });
      if (rows.length >= (opts?.maxChunks ?? MAX_CHUNKS_PER_STORE)) break;
    }
    if (rows.length >= (opts?.maxChunks ?? MAX_CHUNKS_PER_STORE)) break;
  }
  if (!rows.length) return 0;
  try {
    await ensureTable();
    // ── Session-scope DEDUPE (audit 2026-10-06 T1-5): the same tool result was
    // offloaded again and again — config.yaml stored 8× in one litellm lane run,
    // 2,386 rows evicted from one session — each copy re-embedded and each
    // pushing real findings past the 6000-row ceiling. A chunk whose exact text
    // is already stored in THIS session under the same (source, ref) is skipped
    // (counted as stored — it IS in memory; read at write time, so a row the
    // cap already evicted is stored again). Within-batch repeats collapse too.
    // Fail-open: a lookup error stores everything. Kill switch
    // MEMORY_SESSION_DEDUPE_DISABLED=1.
    let deduped = 0;
    if (scope.type === 'session' && !memorySessionDedupeDisabled()) {
      const hashOf = (r: { ref: string; content: string }) => `${r.ref}\u0000${crypto.createHash('md5').update(r.content).digest('hex')}`;
      const seen = new Set<string>();
      try {
        const refs = [...new Set(rows.map((r) => r.ref))];
        const existing = await prisma.$queryRawUnsafe<Array<{ ref: string | null; h: string }>>(
          `SELECT ref, md5(content) AS h FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND source = $3 AND ref = ANY($4::text[])`,
          scope.type, scope.id, source, refs,
        );
        for (const e of Array.isArray(existing) ? existing : []) seen.add(`${e.ref ?? ''}\u0000${e.h}`);
      } catch { /* fail-open: dedupe only within this batch */ }
      const kept: typeof rows = [];
      for (const r of rows) {
        const k = hashOf(r);
        if (seen.has(k)) { deduped += 1; continue; }
        seen.add(k);
        kept.push(r);
      }
      if (deduped) {
        void import('../platform/loop-metrics.service')
          .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
            kind: LOOP_METRIC_KINDS.MEMORY_STORE_DEDUPED,
            sessionId: scope.id, value: deduped, unit: 'rows',
            meta: { source, deduped, written: kept.length },
          }))
          .catch(() => {});
      }
      if (!kept.length) return deduped;
      rows.length = 0;
      rows.push(...kept);
    }
    // Embed title + content together — the distilled one-liner carries the
    // vocabulary an engineer would actually search for. A rejected batch is
    // re-embedded row by row (embed-failure.ts) so one bad input does not
    // de-embed the whole store; the cause is logged ONCE per cause per process
    // and counted (unified_memory_embed_failed) — it used to be a bare
    // "Request failed with status code 400" with the provider body hidden.
    const texts = rows.map(r => (r.title ? `${r.title}\n${r.content}` : r.content));
    const embedded = await embedRowsWithRetry(texts, (batch) => embedTexts(batch, 'dashscope', batch.length === texts.length ? { bucket: 'store' } : { timeoutMs: EMBED_ROW_RETRY_TIMEOUT_MS, bucket: 'store' }));
    const embeddings = embedded.embeddings;
    if (embedded.cause) reportEmbedFailure(embedded, { rows: rows.length, maxChars: Math.max(0, ...texts.map(t => t.length)), source, scopeType: scope.type, bucket: 'store' });
    const vals: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (let j = 0; j < rows.length; j++) {
      const e = embeddings[j];
      if (e && e.length) {
        vals.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::vector)`);
        params.push(crypto.randomUUID(), scope.type, scope.id, opts?.userId ?? null, source, rows[j].ref, rows[j].title || null, rows[j].content, `[${e.join(',')}]`);
      } else {
        vals.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, NULL)`);
        params.push(crypto.randomUUID(), scope.type, scope.id, opts?.userId ?? null, source, rows[j].ref, rows[j].title || null, rows[j].content);
      }
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO digby_memory (id, scope_type, scope_id, user_id, source, ref, title, content, embedding) VALUES ${vals.join(', ')}`,
      ...params
    );
    // Cap the scope at the newest N rows (callers with big corpora — e.g. the
    // repo code index — pass a larger cap, and skip the per-store sweep in hot
    // loops via skipCap + one enforceScopeCap() at the end: the anti-join sorts
    // the whole scope, which is too heavy to run once per file).
    // Defence in depth (EOD review 2026-09-14 BLOCKER): a PROJECT scope is shared
    // by the code index, learnings, decisions and documents — a source-blind cap
    // here deleted ~17.6k code/learning rows in prod when the decision writer
    // forgot skipCap. Project scopes are therefore capped PER SOURCE; session and
    // user scopes keep the whole-scope cap (one writer each).
    if (!opts?.skipCap) await applyStoreCap(scope, source, opts?.cap);
    return rows.length + deduped;
  } catch (e: any) {
    logger.warn(`unified-memory: store failed (non-fatal): ${e.message}`);
    return 0;
  }
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Longest query text the semantic + rerank legs embed (2026-09-19 audit): a
 * machine wake's composed message is 13–22k chars and embedding + reranking
 * it took 27 s on a live row — the callers' soft deadlines (learnings 6 s,
 * enriched context 15 s) tripped on ~50% of machine turns and the memory
 * blocks were silently dropped. Long queries keep their TAIL: in this codebase
 * a long message's head is boilerplate (the machine preamble, a pasted
 * header) and its tail is the ask / the event body. The FTS leg has its own
 * cap (ftsQueryFor). chat-context also passes the pre-preamble text for
 * machine wakes, so this is the defence-in-depth bound for every caller.
 */
export const MEM_QUERY_MAX_CHARS = 4_000;
export function memQueryText(query: string): string {
  const q = String(query ?? '').trim();
  return q.length <= MEM_QUERY_MAX_CHARS ? q : q.slice(-MEM_QUERY_MAX_CHARS);
}

/**
 * Hybrid search across one or more scopes. Vector + FTS legs both run, RRF
 * fusion, age decay, rerank. `sources` optionally filters (e.g. only 'code').
 */
export async function memSearch(
  scopes: MemScope[],
  query: string,
  k = 6,
  opts?: MemSearchOpts
): Promise<MemHit[]> {
  if (!query.trim() || !scopes.length) return [];
  const t0 = Date.now();
  const timebox = typeof opts?.deadlineMs === 'number' && opts.deadlineMs > 0 ? opts.deadlineMs : undefined;
  const remaining = () => (timebox === undefined ? Infinity : timebox - (Date.now() - t0));
  const timing: Record<string, number | boolean | string | undefined> = { purpose: opts?.purpose, scopes: scopes.length, deadlineMs: timebox };
  // The embed/rerank legs see the bounded text; FTS keeps the full query for
  // its own OR-term extraction (ftsQueryFor caps it separately).
  const embedQuery = memQueryText(query);
  try {
    await ensureTable();
    const scopeCond = scopes.map((_, i) => `(scope_type = $${i * 2 + 1} AND scope_id = $${i * 2 + 2})`).join(' OR ');
    const scopeParams = scopes.flatMap(s => [s.type, s.id]);
    let srcCond = '';
    const srcParams: any[] = [];
    if (opts?.sources?.length) {
      srcCond = ` AND source = ANY($${scopeParams.length + 2}::text[])`;
      srcParams.push(opts.sources);
    }
    if (opts?.refs?.length) {
      srcCond += ` AND ref = ANY($${scopeParams.length + 2 + srcParams.length}::text[])`;
      srcParams.push(opts.refs);
    }
    const base = `FROM digby_memory WHERE (${scopeCond})${srcCond}`;
    const after = scopeParams.length + 1; // index of the query/vector param

    let vecRows: any[] = [];
    try {
      const tE = Date.now();
      let qe = cachedQueryEmbedding(embedQuery);
      timing.embedCached = !!qe;
      if (!qe) {
        if (embedBreakerIsOpen()) {
          // Sustained-outage fail-fast (FO f185): no doomed HTTP call and no
          // per-search warn — the breaker transition row carries the signal.
          timing.embedFailed = true;
          timing.embedBreaker = 'open';
        } else {
          if (embedBreakerTrialPending()) timing.embedBreaker = 'half_open_trial';
          const embedTimeout = timebox === undefined ? undefined : Math.max(EMBED_MIN_TIMEOUT_MS, Math.floor(remaining() - 200));
          try {
            [qe] = await embedTexts([embedQuery], 'dashscope', { ...(embedTimeout === undefined ? {} : { timeoutMs: embedTimeout }), bucket: 'query' });
          } catch (embedErr) {
            embedBreakerOnFailure();
            throw embedErr;
          }
          embedBreakerOnSuccess();
          if (qe) rememberQueryEmbedding(embedQuery, qe);
        }
      }
      timing.embedMs = Date.now() - tE;
      if (qe) {
        const tV = Date.now();
        vecRows = await prisma.$queryRawUnsafe(vectorLegSql(base, after, k, scopes.length), ...scopeParams, `[${qe.join(',')}]`, ...srcParams);
        timing.vecMs = Date.now() - tV;
        timing.vecShape = wideBlendQuotaFor(scopes.length) !== undefined ? 'prefilter+quota' : 'prefilter';
      } else if (!timing.embedFailed) {
        // embedTexts resolved without a vector and did not throw — the same
        // degradation class as a throw, minus the noise.
        timing.embedFailed = true;
      }
    } catch (e: any) {
      timing.embedFailed = true;
      logger.warn(`unified-memory: semantic leg failed (keyword leg still runs): ${e.message}`);
    }
    let ftsRows: any[] = [];
    const tF = Date.now();
    try {
      // websearch_to_tsquery: plainto semantics on plain text, but understands
      // the OR keyword ftsQueryFor emits for long queries (see its docstring).
      const ftsSql = `SELECT id, ref, title, source, content, scope_type, scope_id, created_at,
                ts_rank(to_tsvector('english', coalesce(title,'') || ' ' || content), websearch_to_tsquery('english', $${after})) AS score
         ${base} AND to_tsvector('english', coalesce(title,'') || ' ' || content) @@ websearch_to_tsquery('english', $${after})
         ORDER BY score DESC LIMIT ${k * 3}`;
      ftsRows = await prisma.$queryRawUnsafe(ftsSql, ...scopeParams, ftsQueryFor(query), ...srcParams);
      // ── ZERO-ROW OR RETRY (ticket ba3d62cf, 2026-11-01) ────────────────────
      // A ≤160-char query goes into websearch_to_tsquery VERBATIM, and that
      // function ANDs every term — so one token absent from every stored row
      // returns ZERO keyword rows even for a strong subject match ("…latest
      // numbers" against a SERP row that never says "numbers").
      //
      // THREE GUARDS, and they are what make this safe rather than merely
      // small. Reviewer finding B2 (2026-11-01): gating only on `ftsRows`
      // widens ANY search whose keyword leg missed — including a HEALTHY one
      // whose semantic leg answered — pushing OR rows into `rrfFuse` and able
      // to displace a vector-only top hit. So the gate is the WHOLE LADDER
      // being empty, which is exactly the precondition for the raw-fallback
      // rescue this exists to prevent:
      //   1. `!vecRows.length` — the semantic leg contributed nothing. A search
      //      that already has vector rows returns them untouched; this cannot
      //      reorder or dilute a single healthy result.
      //   2. `!ftsRows.length` — the precise AND form matched nothing.
      //   3. the OR text DIFFERS from the text already tried. `ftsQueryFor`
      //      already emits OR-joined tokens for >160-char queries, and a
      //      single-token query ORs to itself — re-issuing an identical
      //      statement is a guaranteed-empty scan plus a `ts_rank` sort on the
      //      largest scopes (reviewer finding B1). Skip those; the retry only
      //      ever runs when the query is genuinely in the AND-only class.
      //
      // Bounded: at most ONE extra statement per search, never a loop.
      const ftsOr = vecRows.length || ftsRows.length
        ? null
        : (() => { const o = ftsQueryOrFor(query); return o && o !== ftsQueryFor(query) ? o : null; })();
      if (ftsOr) {
        ftsRows = await prisma.$queryRawUnsafe(ftsSql, ...scopeParams, ftsOr, ...srcParams);
        timing.ftsOrRetry = ftsRows.length ? 'hit' : 'empty';
      }
    } catch (e: any) {
      logger.warn(`unified-memory: keyword leg failed: ${e.message}`);
    }
    timing.ftsMs = Date.now() - tF;

    const now = Date.now();
    let rows: any[] = rrfFuse([vecRows, ftsRows])
      .map(r => ({ ...r, fused: r.rrf * ageDecayFactor(r.created_at, now) * sourcePrior(r.source, query) }))
      .sort((a, b) => b.fused - a.fused);
    if (rows.length > k && remaining() < RERANK_MIN_REMAINING_MS) {
      // Time-boxed: too little budget left for the rerank round trip — the
      // fused RRF order IS a ranked answer; returning it beats returning [].
      timing.rerankSkipped = true;
      rows = rows.slice(0, k);
    } else if (rows.length > k && embedBreakerIsOpen()) {
      // Same outage class (FO f185): the vendor's cross-encoder is down with
      // its embed endpoint — the fused RRF order answers without the doomed
      // round trip.
      timing.rerankSkipped = true;
      timing.rerankBreaker = 'open';
      rows = rows.slice(0, k);
    } else if (rows.length > k) {
      const pool = rows.slice(0, Math.max(k * 2, 12));
      const tR = Date.now();
      const rerankTimeout = timebox === undefined ? undefined : Math.max(EMBED_MIN_TIMEOUT_MS, Math.floor(remaining() - 100));
      const ranked = await rerankTexts(embedQuery, pool.map(r => `${r.title ? r.title + '\n' : ''}${r.content}`), k, rerankTimeout === undefined ? undefined : { timeoutMs: rerankTimeout });
      timing.rerankMs = Date.now() - tR;
      if (ranked && ranked.length) {
        // The cross-encoder's rank is the primary signal; the source prior is
        // carried through so a verbatim source chunk beats a compaction
        // summary on a near-tie for fact-retrieval queries (ticket 7852814c).
        rows = ranked
          .map((r, pos) => ({ row: pool[r.index], score: (1 / (pos + 1)) * sourcePrior(pool[r.index]?.source, query) }))
          .filter(v => v.row)
          .sort((a, b) => b.score - a.score)
          .map(v => v.row);
      } else {
        rows = rows.slice(0, k);
      }
    }
    timing.totalMs = Date.now() - t0;
    timing.hits = Math.min(rows.length, k);
    recordSearchTiming(timing);
    stampHits(rows.slice(0, k));
    return rows.slice(0, k).map(r => ({
      ref: r.ref || '', title: r.title || '', source: r.source, content: r.content,
      scopeType: r.scope_type, scopeId: r.scope_id, createdAt: String(r.created_at),
    }));
  } catch (e: any) {
    logger.warn(`unified-memory: search failed (non-fatal): ${e.message}`);
    return [];
  }
}

/** Hit-aware eviction, write side: mark the rows a search returned so the
 *  session source cap keeps them (see enforceScopeCap hitAware). Fire-and-
 *  forget, one UPDATE per search. */
function stampHits(rows: any[]): void {
  const ids = rows.map(r => r?.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (!ids.length) return;
  void prisma.$executeRawUnsafe(`UPDATE digby_memory SET last_hit_at = now() WHERE id = ANY($1::text[])`, ids).catch(() => undefined);
}

/** One loop_metrics row per search (kind memory_search_timing) — fire-and-
 *  forget, dynamic import like enforceScopeCap's metric so this module stays
 *  import-light. */
function recordSearchTiming(timing: Record<string, unknown>): void {
  void import('../platform/loop-metrics.service')
    .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MEMORY_SEARCH_TIMING,
      value: typeof timing.totalMs === 'number' ? timing.totalMs : undefined,
      meta: timing,
    }))
    .catch(() => undefined);
}

// ── Gated reads (owner 2026-09-14: per-user gates) ───────────────────────────
// "One user can never read memory or knowledge about another user or another
// user's projects." memSearch stays the raw, scope-trusting primitive for the
// callers that already hold authorized scopes; everything that derives scopes
// from a REQUEST (search_memory, run-start injection, the KB/decision bridges)
// goes through these two, which drop every scope the caller may not read
// BEFORE the SQL runs. Fail closed: a lookup error yields no hits — memory
// failures degrade recall, never a request.

/**
 * The subset of `scopes` that `userId` may read:
 *   - 'project'         → owner, or member of the project / an ancestor folder
 *                          (memory-access.authorizedProjectScopeIds — never re-implemented here);
 *   - 'user'            → only the caller's own id;
 *   - 'session'/'chat'  → the chat row is owned by the caller OR sits in a
 *                          project the caller may read (one findMany over
 *                          crossmodel_chats; unknown ids are dropped).
 * Order preserved, duplicates collapsed. Exported for callers that need the
 * authorized scope list itself (e.g. to build an injection block) — the same
 * predicate memSearchForUser applies.
 */
export async function authorizedMemScopes(userId: string, scopes: MemScope[]): Promise<MemScope[]> {
  if (!userId || !scopes?.length) return [];
  try {
    const chatIds = [...new Set(scopes.filter(s => (s.type === 'session' || s.type === 'chat') && s.id).map(s => s.id))];
    const chatRows: Array<{ id: string; userId: string; projectId: string | null }> = chatIds.length
      ? await prisma.crossModelChat.findMany({ where: { id: { in: chatIds } }, select: { id: true, userId: true, projectId: true } })
      : [];
    const chatById = new Map(chatRows.map(c => [c.id, c]));

    // ONE authorization pass over every project id in play: the explicit
    // project scopes plus the projects the requested chats belong to.
    const projectIds = [...new Set([
      ...scopes.filter(s => s.type === 'project' && s.id).map(s => s.id),
      ...chatRows.map(c => c.projectId).filter((p): p is string => !!p),
    ])];
    const authorized = new Set(projectIds.length ? await authorizedProjectScopeIds(userId, projectIds) : []);

    const out: MemScope[] = [];
    const seen = new Set<string>();
    for (const s of scopes) {
      if (!s?.id) continue;
      let ok = false;
      if (s.type === 'project') ok = authorized.has(s.id);
      else if (s.type === 'user') ok = s.id === userId;
      else if (s.type === 'session' || s.type === 'chat') {
        const chat = chatById.get(s.id);
        ok = !!chat && (chat.userId === userId || (!!chat.projectId && authorized.has(chat.projectId)));
      }
      const key = `${s.type}:${s.id}`;
      if (ok && !seen.has(key)) { seen.add(key); out.push({ type: s.type, id: s.id }); }
    }
    if (out.length < scopes.length) {
      logger.debug(`unified-memory: dropped ${scopes.length - out.length}/${scopes.length} unauthorized scope(s) for user ${String(userId).slice(0, 8)}`);
    }
    return out;
  } catch (e: any) {
    logger.warn(`unified-memory: scope authorization failed for user ${String(userId).slice(0, 8)} — no scopes granted: ${e?.message ?? e}`);
    return [];
  }
}

/**
 * memSearch behind the per-user gate: unauthorized scopes are dropped (see
 * authorizedMemScopes), then the existing hybrid pipeline runs over what is
 * left. Empty when nothing survives or a lookup fails (fail closed).
 */
export async function memSearchForUser(
  userId: string,
  scopes: MemScope[],
  query: string,
  k = 6,
  opts?: MemSearchOpts
): Promise<MemHit[]> {
  if (!userId || !query?.trim() || !scopes?.length) return [];
  const allowed = await authorizedMemScopes(userId, scopes);
  if (!allowed.length) return [];
  return memSearch(allowed, query, k, opts);
}

// ── Cold read (2026-10-20, memory-archive.ts) ────────────────────────────────

/** A hit from the cold tier: rows the scope cap moved out of the hot store. */
export interface MemArchivedHit extends MemHit {
  archived: true;
  /** When the cap moved the row into the archive. */
  archivedAt: string;
}

/**
 * FTS-only search over digby_memory_archive — the archive has no embedding, so
 * there is no vector leg, no fusion and no rerank: websearch_to_tsquery +
 * ts_rank over the same tsvector expression as the hot keyword leg (its GIN
 * index matches), scoped EXACTLY like memSearch ((scope_type, scope_id) pairs
 * OR-ed, optional source filter). Trusts its scopes like memSearch — request-
 * derived scopes go through memSearchArchiveForUser. Bounded at k (≤ 50).
 * Never throws: [] on any failure or an empty query. Callers bound wall time
 * (search_memory races it — coding-retrieval ARCHIVE_SEARCH_TIMEOUT_MS).
 */
export async function memSearchArchive(scopes: MemScope[], query: string, k = 6, opts?: { sources?: string[]; refs?: string[]; purpose?: string }): Promise<MemArchivedHit[]> {
  if (!query?.trim() || !scopes?.length) return [];
  const limit = Math.max(1, Math.min(50, Math.floor(k) || 1));
  const t0 = Date.now();
  try {
    await ensureTable();
    const scopeCond = scopes.map((_, i) => `(scope_type = $${i * 2 + 1} AND scope_id = $${i * 2 + 2})`).join(' OR ');
    const scopeParams = scopes.flatMap(s => [s.type, s.id]);
    const after = scopeParams.length + 1;
    let srcCond = '';
    const srcParams: any[] = [];
    if (opts?.sources?.length) {
      srcCond = ` AND source = ANY($${scopeParams.length + 2}::text[])`;
      srcParams.push(opts.sources);
    }
    if (opts?.refs?.length) {
      srcCond += ` AND ref = ANY($${scopeParams.length + 2 + srcParams.length}::text[])`;
      srcParams.push(opts.refs);
    }
    const archSql = `SELECT id, ref, title, source, content, scope_type, scope_id, created_at, archived_at,
              ts_rank(to_tsvector('english', coalesce(title,'') || ' ' || content), websearch_to_tsquery('english', $${after})) AS score
       FROM digby_memory_archive WHERE (${scopeCond})${srcCond} AND to_tsvector('english', coalesce(title,'') || ' ' || content) @@ websearch_to_tsquery('english', $${after})
       ORDER BY score DESC, created_at DESC LIMIT ${limit}`;
    let rows: any[] = await prisma.$queryRawUnsafe(archSql, ...scopeParams, ftsQueryFor(query), ...srcParams);
    // ── ZERO-ROW OR RETRY (ticket ba3d62cf, 2026-11-01) ──────────────────────
    // The SAME AND-semantics trap as the hot keyword leg, and it matters HERE
    // because `coding-retrieval.service.ts` calls `topUpFromArchive` BEFORE it
    // decides `raw-fallback` — so an archived-row AND-miss alone was enough to
    // fire the incident path even with the hot leg fixed. The archive has no
    // vector leg (no embedding, no fusion, no rerank), so an empty keyword
    // result IS an empty result: no "whole ladder empty" guard is needed here,
    // only the bounded one-retry + the identical-text skip.
    if (!rows.length) {
      const orText = ftsQueryOrFor(query);
      if (orText && orText !== ftsQueryFor(query)) {
        rows = await prisma.$queryRawUnsafe(archSql, ...scopeParams, orText, ...srcParams);
      }
    }
    const out = (Array.isArray(rows) ? rows : []).slice(0, limit).map((r): MemArchivedHit => ({
      ref: r.ref || '', title: r.title || '', source: r.source, content: r.content,
      scopeType: r.scope_type, scopeId: r.scope_id, createdAt: String(r.created_at),
      archived: true, archivedAt: String(r.archived_at),
    }));
    recordSearchTiming({ purpose: opts?.purpose ?? 'archive', archive: true, scopes: scopes.length, ftsMs: Date.now() - t0, totalMs: Date.now() - t0, hits: out.length });
    return out;
  } catch (e: any) {
    logger.debug(`unified-memory: archive search failed (non-fatal, hot results stand): ${e?.message ?? e}`);
    return [];
  }
}

/** memSearchArchive behind the per-user gate (authorizedMemScopes — the same
 *  predicate memSearchForUser applies). Empty when nothing survives. */
export async function memSearchArchiveForUser(
  userId: string,
  scopes: MemScope[],
  query: string,
  k = 6,
  opts?: { sources?: string[]; refs?: string[]; purpose?: string }
): Promise<MemArchivedHit[]> {
  if (!userId || !query?.trim() || !scopes?.length) return [];
  const allowed = await authorizedMemScopes(userId, scopes);
  if (!allowed.length) return [];
  return memSearchArchive(allowed, query, k, opts);
}

// ── Same-run RAW recall (2026-10-31, goal 9ecd595e / RAG-1, WRP-1 defect D4) ──
/** One stored row as the raw (query-free) read returns it. */
export interface MemRawRow {
  id: string;
  ref: string;
  title: string;
  source: string;
  content: string;
  scopeType: MemScopeType;
  scopeId: string;
  createdAt: string;
  /** created_at as epoch ms (0 when unparseable) — what the freshness window reads. */
  createdMs: number;
}

/**
 * The newest rows of the given scopes, NO query and NO embedding — a plain
 * index read on (scope_type, scope_id). This is the read the Polk County run
 * needed: it had just STORED its own SERP and then could not recall it, because
 * recall meant embed → vector → FTS → RRF → rerank and that ladder answered
 * empty. Selection (which of these rows answer the query, and whether the raw
 * path may engage at all) is the pure leaf `same-run-recall.ts`; this function
 * only fetches, bounded by `limit` and optionally by `sinceMs`.
 *
 * Newest-first, `source`/`ref` filters honored, never throws (a store failure
 * returns null so the caller can tell "unreadable" from "no rows" — the
 * incident class was exactly a store that reported failure as absence).
 */
export async function memRecentRows(
  scopes: MemScope[],
  opts: { limit?: number; sinceMs?: number; sources?: string[]; refs?: string[] } = {},
): Promise<Array<{ id: string; ref: string; title: string; source: string; content: string; scopeType: MemScopeType; scopeId: string; createdAt: string; createdMs: number }> | null> {
  if (!scopes?.length) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 40)));
  try {
    await ensureTable();
    const scopeCond = scopes.map((_, i) => `(scope_type = $${i * 2 + 1} AND scope_id = $${i * 2 + 2})`).join(' OR ');
    const params: any[] = scopes.flatMap(s => [s.type, s.id]);
    let extra = '';
    if (opts.sources?.length) { params.push(opts.sources); extra += ` AND source = ANY($${params.length}::text[])`; }
    if (opts.refs?.length) { params.push(opts.refs); extra += ` AND ref = ANY($${params.length}::text[])`; }
    if (typeof opts.sinceMs === 'number' && Number.isFinite(opts.sinceMs)) {
      params.push(new Date(opts.sinceMs));
      extra += ` AND created_at >= $${params.length}::timestamptz`;
    }
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT id, ref, title, source, content, scope_type, scope_id, created_at
       FROM digby_memory WHERE (${scopeCond})${extra}
       ORDER BY created_at DESC LIMIT ${limit}`,
      ...params,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => {
      const ms = r.created_at instanceof Date ? r.created_at.getTime() : Date.parse(String(r.created_at ?? ''));
      return {
        id: String(r.id ?? ''), ref: r.ref || '', title: r.title || '', source: r.source,
        content: r.content, scopeType: r.scope_type, scopeId: r.scope_id,
        createdAt: String(r.created_at), createdMs: Number.isFinite(ms) ? ms : 0,
      };
    });
  } catch (e: any) {
    logger.warn(`unified-memory: recent-row read failed (non-fatal): ${e?.message ?? e}`);
    return null;
  }
}

/** memRecentRows behind the per-user gate (the same authorizedMemScopes
 *  predicate every request-derived read uses). Empty when nothing survives. */
export async function memRecentRowsForUser(
  userId: string,
  scopes: MemScope[],
  opts: { limit?: number; sinceMs?: number; sources?: string[]; refs?: string[] } = {},
): Promise<ReturnType<typeof memRecentRows> extends Promise<infer T> ? T : never> {
  if (!userId || !scopes?.length) return [];
  const allowed = await authorizedMemScopes(userId, scopes);
  if (!allowed.length) return [];
  return memRecentRows(allowed, opts);
}

/**
 * Project search with the OWNED-project blend: the authorized subset of
 * `primaryProjectIds` plus — only when `opts.blendOwned` — the caller's other
 * OWNED projects (memory-access.ownedProjectIds; primaries excluded; capped at
 * BLEND_OWNED_PROJECT_CAP). Member-shared projects are NEVER blended in: a
 * teammate's other work is not the caller's memory. Hits from a non-primary
 * project are labelled with that project's name (one findMany) — both as
 * structured fields (projectId/projectName/crossProject) and as a `[Name]`
 * prefix on the title so plain renderers show the provenance too.
 */
export async function memSearchProjectsBlended(
  userId: string,
  primaryProjectIds: string[],
  query: string,
  k = 6,
  opts?: {
    sources?: string[]; blendOwned?: boolean; ownedCap?: number; deadlineMs?: number; purpose?: string; extraScopes?: MemScope[];
    /** Leave the hidden user-space project out of the OWNED blend (2026-10-20): its learnings / decisions mix the user's
     *  unrelated ungrouped chats, so they never ride into another project's chat. */
    excludeUserSpace?: boolean;
  }
): Promise<MemBlendedHit[]> {
  if (!userId || !query?.trim()) return [];
  const primaryIds = [...new Set((primaryProjectIds || []).filter(id => typeof id === 'string' && id.length > 0))];
  const primaries = primaryIds.length ? await authorizedProjectScopeIds(userId, primaryIds) : [];
  const primarySet = new Set(primaries);
  let others: string[] = [];
  // Blend ONLY into projects the caller OWNS (EOD review 2026-09-14): a member
  // reading a shared project must never have their private projects pulled
  // into a context the owner and other members also read.
  // No-primary caller (ticket a6ba3fda, 2026-10-17): the owned blend was
  // previously keyed on `primaries.length` — a PROJECTLESS chat (the Fleet
  // Supervisor's own chat, projectId null) could never reach it. When
  // blendOwned is explicitly requested and there are NO primaries, the caller's
  // OWNED projects alone form the scope (still fail-closed: ownedProjectIds
  // returns only crossmodel_projects.userId === caller).
  if (opts?.blendOwned && ((primaries.length && (await ownsAllProjects(userId, primaries))) || !primaries.length)) {
    const cap = Math.min(BLEND_OWNED_PROJECT_CAP, Math.max(1, opts.ownedCap ?? BLEND_OWNED_PROJECT_CAP));
    others = (await ownedProjectIds(userId, { exclude: primaryIds, limit: cap, ...(opts.excludeUserSpace ? { excludeUserSpace: true } : {}) })).filter(id => !primarySet.has(id));
  }
  // Gated extra scopes (chat/supervisor-scope search, ticket a6ba3fda): passed
  // through authorizedMemScopes here so NO caller can smuggle an unauthorized
  // scope into the SQL — the same per-user fail-closed gate as project scopes.
  const extraAllowed = opts?.extraScopes?.length ? await authorizedMemScopes(userId, opts.extraScopes) : [];
  const scopes: MemScope[] = [...primaries.map(id => ({ type: 'project' as const, id })), ...others.map(id => ({ type: 'project' as const, id })), ...extraAllowed];
  if (!scopes.length) return [];
  const hits = await memSearch(scopes, query, k, {
    ...(opts?.sources?.length ? { sources: opts.sources } : {}),
    ...(opts?.deadlineMs ? { deadlineMs: opts.deadlineMs } : {}),
    ...(opts?.purpose ? { purpose: opts.purpose } : {}),
  });
  if (!hits.length) return [];

  // Label cross-project hits with their project name — one lookup for all of them.
  // Only PROJECT-scope hits can be cross-project: with empty primaries (the
  // fleet-learnings path, ticket a6ba3fda) a chat/session-scope hit's scopeId is
  // a CHAT id — it must never be name-looked-up as a project nor labelled
  // 'another project' (MemBlendedHit.projectId stays '' for non-project hits).
  const foreignIds = [...new Set(hits.filter(h => h.scopeType === 'project' && !primarySet.has(h.scopeId)).map(h => h.scopeId))];
  const names = new Map<string, string>();
  if (foreignIds.length) {
    try {
      const rows = await prisma.crossModelProject.findMany({ where: { id: { in: foreignIds } }, select: { id: true, name: true } });
      for (const r of rows) names.set(r.id, r.name);
    } catch (e: any) {
      logger.warn(`unified-memory: project-name lookup for blended hits failed (unlabelled): ${e?.message ?? e}`);
    }
  }
  return hits.map(h => {
    const crossProject = h.scopeType === 'project' && !primarySet.has(h.scopeId);
    const projectName = crossProject ? (names.get(h.scopeId) ?? null) : null; // only cross-project ids are looked up
    const label = crossProject ? `[${projectName ?? 'another project'}]` : '';
    return {
      ...h,
      title: label ? (h.title ? `${label} ${h.title}` : label) : h.title,
      projectId: h.scopeType === 'project' ? h.scopeId : '',
      projectName,
      crossProject,
    };
  });
}

/**
 * Per-source row counts for a scope — the cheap "what does memory hold?"
 * inventory (indexed scope lookup, no embeds). Empty object on any failure.
 */
export async function memInventory(scope: MemScope): Promise<Record<string, number>> {
  try {
    await ensureTable();
    const rows: Array<{ source: string; n: bigint | number }> = await prisma.$queryRawUnsafe(
      `SELECT source, COUNT(*) AS n FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 GROUP BY source ORDER BY n DESC`,
      scope.type, scope.id
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.source] = Number(r.n);
    return out;
  } catch {
    return {};
  }
}

/**
 * The cap policy memStore applies after an insert (see the dynamic-retention
 * note by SESSION_SCOPE_*): project → per source; session → per source with
 * the retention floor, then the scope-wide hard ceiling; user → plain cap.
 */
export async function applyStoreCap(scope: MemScope, source: string, cap?: number): Promise<void> {
  if (scope.type === 'project') return enforceScopeCap(scope, cap ?? SCOPE_CAP, source);
  if (scope.type === 'session') {
    await enforceScopeCap(scope, cap ?? SCOPE_CAP, source, { minAgeHours: sessionScopeMinRetentionHours(), reason: 'source_cap', hitAware: true });
    await enforceScopeCap(scope, sessionScopeHardCap(), undefined, { reason: 'hard_ceiling', ...(memoryCeilingTieredEvictionDisabled() ? {} : { tiered: true }) });
    return;
  }
  return enforceScopeCap(scope, cap ?? SCOPE_CAP);
}

/**
 * Enforce the newest-N cap on a scope (single anti-join DELETE). Best-effort.
 * `opts.minAgeHours` (session dynamic retention): rows younger than this are
 * never deleted by this sweep — only OLDER rows count toward, and fall past,
 * the cap. `opts.reason` rides the eviction metric.
 * `source` narrows the sweep to one source's rows — the project scope is SHARED
 * (code index + learnings), and a source-blind sweep deletes oldest-first
 * across all sources, which is exactly the content-addressed, rarely-rewritten
 * learnings rows (owner 2026-09-04). The code-index sync passes 'code'.
 */
export async function enforceScopeCap(scope: MemScope, cap: number, source?: string, opts?: { minAgeHours?: number; reason?: string; hitAware?: boolean; tiered?: boolean }): Promise<void> {
  try {
    await ensureTable();
    const srcCond = source ? ` AND source = $3` : '';
    const params: any[] = source ? [scope.type, scope.id, source] : [scope.type, scope.id];
    const minAge = Math.max(0, Number(opts?.minAgeHours ?? 0) || 0);
    // Retention floor: young rows are excluded from the DELETE (never evicted)
    // but still counted in the newest-N keep set, so an old row is deleted only
    // when it is past the cap counting everything newer than it.
    const ageCond = minAge > 0 ? ` AND created_at < now() - make_interval(hours => ${Math.floor(minAge)})` : '';
    // Hit-aware keep set: rows memSearch returned within MEM_HIT_KEEP_DAYS sort
    // ahead of never-hit rows, then newest-first as before.
    // `tiered` (the session hard ceiling) = hit-aware + fresh + unique-before-copies.
    const order = opts?.tiered
      ? sessionCeilingKeepOrderSql()
      : opts?.hitAware
        ? `ORDER BY (last_hit_at IS NOT NULL AND last_hit_at > now() - make_interval(days => ${memHitKeepDays()})) DESC, created_at DESC`
        : `ORDER BY created_at DESC`;
    const deleteSql = `DELETE FROM digby_memory WHERE scope_type = $1 AND scope_id = $2${srcCond}${ageCond} AND id NOT IN (
         SELECT id FROM digby_memory WHERE scope_type = $1 AND scope_id = $2${srcCond} ${order} LIMIT ${Math.max(1, Math.floor(cap))})`;
    const reason = opts?.reason ?? (source ? 'source_cap' : 'scope_cap');
    // Archive instead of delete (owner 2026-10-20, memory-archive.ts): the SAME
    // DELETE (predicate, keep order, floor — byte-identical) becomes the CTE of
    // one atomic move into digby_memory_archive; its row count is still the
    // eviction count. A failing move (archive missing, a transient error) falls
    // back to the plain DELETE so a cap is never skipped. Kill switch
    // MEMORY_ARCHIVE_DISABLED=1 = today's DELETE byte-for-byte.
    let deleted: unknown;
    let archived = false;
    let archiveFailed = false;
    if (archiveState === 'ready' && !memoryArchiveDisabled()) {
      try {
        deleted = await prisma.$executeRawUnsafe(archiveEvictionSql(deleteSql, params.length + 1), ...params, reason);
        archived = true;
      } catch (err: any) {
        archiveFailed = true;
        noteArchiveFallback(err);
        deleted = await prisma.$executeRawUnsafe(deleteSql, ...params);
      }
    } else {
      deleted = await prisma.$executeRawUnsafe(deleteSql, ...params);
    }
    // 2026-09-22 audit: rows past the cap were deleted with no record at all.
    if (typeof deleted === 'number' && deleted > 0) {
      void import('../platform/loop-metrics.service')
        .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
          kind: LOOP_METRIC_KINDS.MEMORY_SCOPE_EVICTED,
          sessionId: scope.type === 'session' ? scope.id : undefined,
          value: deleted,
          unit: 'rows',
          // reason is ALWAYS stamped (operator iteration 14, 2026-09-25): 307 scope-wide session evictions/24 h carried no reason, so the audit could not tell the total-cap tier from a source cap.
          meta: { scopeType: scope.type, scopeId: scope.id, ...(source ? { source } : {}), cap, reason, ...(minAge > 0 ? { minAgeHours: minAge } : {}), ...(opts?.hitAware ? { hitAware: true } : {}), ...(opts?.tiered ? { tiered: true } : {}), ...(archived ? { archived: true } : {}), ...(archiveFailed ? { archiveFailed: true } : {}) },
        }))
        .catch(() => {});
    }
  } catch { /* cap sweep is advisory */ }
}

/** Drop a scope's rows (session/chat/project deletion). Best-effort.
 *  2026-10-20: a deletion is the user's / owner's intent, so the scope's
 *  ARCHIVED rows go too (cold tier, memory-archive.ts) — hot first, then the
 *  archive, so a row a concurrent cap sweep moves mid-delete is still purged. */
export async function memClear(scope: MemScope): Promise<void> {
  try {
    await ensureTable();
    await prisma.$executeRawUnsafe(`DELETE FROM digby_memory WHERE scope_type = $1 AND scope_id = $2`, scope.type, scope.id);
  } catch { /* nothing to clear */ }
  await purgeArchive(ARCHIVE_PURGE_SCOPE_SQL, scope.type, scope.id);
}

/**
 * The distinct refs stored for (scope, source), with how many rows each holds
 * — the per-row mirror writers (supervisor-state-memory, MIND-HYGIENE
 * 2026-10-20) diff their wanted refs against it so an unchanged row keeps its
 * own created_at instead of being re-stamped on every write. Bounded by
 * `limit`. Returns null on ANY failure (the caller must not read "no rows"
 * into an unreadable store).
 */
export async function memListRefs(scope: MemScope, source: string, limit = 2000): Promise<Array<{ ref: string; rows: number }> | null> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Array<{ ref: string | null; n: number | bigint }>>(
      `SELECT ref, COUNT(*) AS n FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND source = $3 GROUP BY ref LIMIT ${Math.max(1, Math.min(10_000, Math.floor(limit)))}`,
      scope.type, scope.id, source,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => ({ ref: String(r.ref ?? ''), rows: Number(r.n) || 0 }));
  } catch {
    return null;
  }
}

/**
 * Per-ref row counts + the newest row's created_at (epoch ms) for (scope,
 * source) — the code index's tiered row cap (code-index.service, 2026-10-23)
 * plans whole-file evictions from it: refs the index state no longer knows
 * first, then test files, then live code oldest-first. Bounded by `limit`
 * (clamped to [1, 100,000]); the caller treats a full page as incomplete.
 * Returns null on ANY failure (never "no rows" for an unreadable store).
 */
export async function memListRefStats(scope: MemScope, source: string, limit = 50_000): Promise<Array<{ ref: string; rows: number; newestMs: number }> | null> {
  try {
    await ensureTable();
    const rows = await prisma.$queryRawUnsafe<Array<{ ref: string | null; n: number | bigint; newest: Date | string | null }>>(
      `SELECT ref, COUNT(*) AS n, MAX(created_at) AS newest FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND source = $3 GROUP BY ref LIMIT ${Math.max(1, Math.min(100_000, Math.floor(limit)))}`,
      scope.type, scope.id, source,
    );
    return (Array.isArray(rows) ? rows : []).map((r) => {
      const t = r.newest instanceof Date ? r.newest.getTime() : Date.parse(String(r.newest ?? ''));
      return { ref: String(r.ref ?? ''), rows: Number(r.n) || 0, newestMs: Number.isFinite(t) ? t : 0 };
    });
  } catch {
    return null;
  }
}

/** Delete every row of (scope, source) whose ref is in `refs`. Best-effort; returns HOT rows deleted (0 on failure).
 *  2026-10-20: an explicit ref deletion also purges that ref's archived copies (cold tier). */
export async function memDeleteRefs(scope: MemScope, source: string, refs: string[]): Promise<number> {
  const keys = [...new Set(refs.map((r) => String(r ?? '').slice(0, 400)))];
  if (!keys.length) return 0;
  let deleted = 0;
  try {
    await ensureTable();
    const n = await prisma.$executeRawUnsafe(
      `DELETE FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND source = $3 AND ref = ANY($4::text[])`,
      scope.type, scope.id, source, keys,
    );
    deleted = typeof n === 'number' ? n : 0;
  } catch {
    deleted = 0;
  }
  await purgeArchive(ARCHIVE_PURGE_REFS_SQL, scope.type, scope.id, source, keys);
  return deleted;
}

/**
 * A CAP eviction of whole refs (the code index's tiered row cap, 2026-10-23)
 * follows the 2026-10-20 "archive instead of delete when a store is full"
 * rule: every hot row of (scope, source, refs) MOVES into digby_memory_archive
 * in one statement that also drops those refs' previous archived generation
 * (archiveRefsEvictionSql — one archived copy per ref, however often the cap
 * evicts it). Same fallback as enforceScopeCap: no archive this process,
 * MEMORY_ARCHIVE_DISABLED=1 or a failing move ⇒ a plain DELETE of the hot rows
 * (warned once per process) — plus a purge of the refs' older archived copies,
 * i.e. memDeleteRefs, so a superseded generation never outlives an eviction
 * whose current copy could not be archived. Never throws.
 */
export async function memArchiveRefs(scope: MemScope, source: string, refs: string[], reason: string): Promise<{ evicted: number; archived: boolean; archiveFailed: boolean }> {
  const keys = [...new Set(refs.map((r) => String(r ?? '').slice(0, 400)))];
  if (!keys.length) return { evicted: 0, archived: false, archiveFailed: false };
  let evicted = 0;
  let archived = false;
  let archiveFailed = false;
  try {
    await ensureTable();
    if (archiveState === 'ready' && !memoryArchiveDisabled()) {
      try {
        const n = await prisma.$executeRawUnsafe(archiveRefsEvictionSql(), scope.type, scope.id, source, keys, reason);
        evicted = typeof n === 'number' ? n : 0;
        archived = true;
      } catch (err: any) {
        archiveFailed = true;
        noteArchiveFallback(err);
      }
    }
    if (!archived) {
      const n = await prisma.$executeRawUnsafe(
        `DELETE FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND source = $3 AND ref = ANY($4::text[])`,
        scope.type, scope.id, source, keys,
      );
      evicted = typeof n === 'number' ? n : 0;
    }
  } catch { /* the eviction is advisory — the next sync's cap retries */ }
  if (!archived) await purgeArchive(ARCHIVE_PURGE_REFS_SQL, scope.type, scope.id, source, keys);
  return { evicted, archived, archiveFailed };
}

/** Purge only the ARCHIVED copies of refs whose content is back in the hot
 *  tier (the code index re-embedding a file the cap once evicted: the cold
 *  copy is a stale version of the live file). Hot rows are untouched.
 *  Best-effort; never throws. */
export async function memPurgeArchivedRefs(scope: MemScope, source: string, refs: string[]): Promise<void> {
  const keys = [...new Set(refs.map((r) => String(r ?? '').slice(0, 400)))];
  if (!keys.length) return;
  await purgeArchive(ARCHIVE_PURGE_REFS_SQL, scope.type, scope.id, source, keys);
}

/**
 * Purge the ARCHIVED rows of (scope, source) whose ref is NOT in `keepRefs` —
 * the code index's backstop on a complete checkout listing (2026-10-23 round
 * 4): every file not listed is gone from the repo, so its archived copy is
 * content that should have been deleted (search_memory's cold leg would
 * return it "[archived]" for up to 365 days). Hot rows are untouched. An
 * empty keep list purges every archived row of (scope, source) — the caller
 * passes a COMPLETE listing only. ONE statement. Returns the rows purged;
 * null on failure (the caller retries a later pass). Never throws.
 */
export async function memPurgeArchivedRefsExcept(scope: MemScope, source: string, keepRefs: string[]): Promise<number | null> {
  const keep = [...new Set(keepRefs.map((r) => String(r ?? '').slice(0, 400)))];
  try {
    await ensureTable();
    const n = await prisma.$executeRawUnsafe(ARCHIVE_PURGE_REFS_EXCEPT_SQL, scope.type, scope.id, source, keep);
    return typeof n === 'number' ? n : 0;
  } catch {
    return null;
  }
}

/** Delete rows for a specific (scope, source, ref) — used by incremental sync
 *  (e.g. re-embedding one changed file replaces its previous rows).
 *  A replacement is not an eviction: the old rows are DELETED, never archived
 *  (2026-10-20). An EMPTY `items` list is an explicit deletion of the ref (a
 *  deleted chat's conversation record, a file gone from the repo, a removed
 *  learning) — its archived copies are purged too, so deleted content cannot
 *  resurface from the cold tier. */
export async function memReplaceRef(scope: MemScope, source: string, ref: string, items: MemItem[], opts?: { userId?: string; cap?: number; maxChunks?: number; skipCap?: boolean; skipGate?: boolean }): Promise<number> {
  try {
    await ensureTable();
    // Match memStore's persistence exactly: refs are stored truncated to 400
    // chars, so the delete must use the same key or long refs never replace.
    await prisma.$executeRawUnsafe(
      `DELETE FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND source = $3 AND ref = $4`,
      scope.type, scope.id, source, ref.slice(0, 400)
    );
  } catch { /* insert still proceeds */ }
  if (!items.length) await purgeArchive(ARCHIVE_PURGE_REFS_SQL, scope.type, scope.id, source, [ref.slice(0, 400)]);
  return memStore(scope, source, items.map(i => ({ ...i, ref })), opts);
}
