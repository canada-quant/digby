/**
 * Loop-metrics telemetry foundation (audit roadmap #12).
 *
 * ONE table (loop_metrics), ONE write path: recordLoopMetric() — fire-and-
 * forget, micro-batched, and guaranteed to NEVER throw or block the caller,
 * so guards/hooks/wake scheduling can instrument themselves with a bare call
 * (no await, no try/catch at the call site). Telemetry is lossy by design:
 * when the DB is down a batch is dropped with a throttled warn, never queued
 * unboundedly and never surfaced to the loop being measured.
 *
 * Read path: queryLoopMetrics (per-kind count/sum/avg bucketed per hour/day),
 * queryLoopMetricOutcomes (ok/fail/rate per bucket AND per meta.unit — ticket
 * d59499f4: one call can write an attempt row and a call roll-up at the same
 * timestamp, so a rate pooled across units is ambiguous), queryLoopMetricPayloadSizes
 * (p50/p95/max of meta.chars / meta.batchChars, so chunk/batch sizing is a
 * number and not a guess) and summarizeLoopMetrics (compact all-kinds count+sum
 * window) — served by GET /api/crossmodel/admin/loop-metrics (admin only) and
 * the get_fleet_telemetry 'metrics' view.
 *
 * Spend accounting: recordRunSpend(runId, sessionId, usage) converts a run's
 * final UsageAccumulator snapshot (coding/cost.ts RunUsage — the shape
 * agent.ts already commits via commitRunUsage at run finalize) into
 * run_tokens_in / run_tokens_out rows per model plus one run_spend row.
 *
 * Retention: sweepLoopMetrics(days=30) — batched GC mirroring the
 * run_tool_receipts sweep in coding/run-reaper.ts.
 */

import { redactInboundSecrets } from './secret-scan';
import { embedAttributionComplete, isKnownEmbedBucket } from '../memory/embed-failure';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { ambientTelemetryRunId } from '../../../utils/run-telemetry-context';
import { LOOP_METRIC_KINDS } from './loop-metric-kinds';

// ── Kind registry ─────────────────────────────────────────────────────────────


// The registry itself moved to the import-free leaf ./loop-metric-kinds.ts
// (ticket 6665fff6, review A8 — feedback/ticket-metric.ts validates
// acceptanceMetric.params.kind against the registered kinds and must not
// import this service's env-validating chain). Re-exported below for every
// existing importer; internal references use the import.
export { LOOP_METRIC_KINDS };
export type { LoopMetricKind } from './loop-metric-kinds';

// ── Metric stamping (remediation P0 item N6) ─────────────────────────────────

/**
 * Per-run stamp context: built ONCE where the run's identity is known (agent
 * loop / run executor / chat agent) and passed to every recordLoopMetric call
 * from that run, instead of editing dozens of sites to compose meta by hand.
 * Merged UNDER the site's own meta (explicit meta keys win); `provider` is
 * derived from `model` via providerOfModel() when not given.
 */
export interface MetricStamp {
  /** the run's primary model id ('kimi-k3', 'glm-5.3', '<label>:<modelId>' …) */
  model?: string;
  /**
   * The durable agent_runs.id of a worker-claimed coding run (2026-10-04). run_spend / run_tokens rows key their
   * `runId` COLUMN on the UsageAccumulator's own id (one per agent loop, shared with chat runs that have no
   * agent_runs row), so per-run cost could not be joined to agent_runs — the 14-day coding readout (CR1004)
   * read $0 per run. This rides meta.agentRunId on every row of the run: `lm.meta->>'agentRunId' = ar.id`.
   */
  agentRunId?: string;
  /** provider name; omitted = derived from model (providerOfModel) */
  provider?: string;
  /** engine profile kind ('coding' | 'chat') */
  profile?: string;
  /** what triggered the run ('user' | 'schedule' | 'hook' | 'machine') */
  triggerKind?: string;
  /**
   * Decision-gate cost stamp (E5, 2026-09-25): the `meta.id` of the shadow
   * decision that gated THIS run's existence (wake_triage for a hook wake,
   * delta_material for a delta-gate firing — the stash on RunInput.decision /
   * ChatAgentRunArgs.decision). Lets the flip-readiness report join a
   * decision to the exact run_spend it would have shed. Telemetry only.
   */
  decisionId?: string;
  /** Same, for the self_audit decision whose +20-step round this run granted (the self_audit_run row + the run's run_spend). */
  selfAuditDecisionId?: string;
  /** Self-audit churn containment (2026-09-27): the HARNESS round id minted for
   *  every self-audit decision — granted OR skipped — on self_audit_run /
   *  self_audit_skip / self_audit_control and the run's run_spend; unlike
   *  selfAuditDecisionId (Jev stash only, 7.5 % of rounds) it joins every one. */
  selfAuditRoundId?: string;
  /** patience plan 1a (2026-09-25): the chat turn's RESOLVED level ('single_thinking' | 'thinking' | 'deep_research' …)
   *  so run_spend / run_tokens read cost per level without a join. */
  mode?: string;
  /** patience plan 1a: how the level was chosen — 'auto_heuristic' | 'auto_decision' | 'user_picked' | 'user_default' | 'user_explicit' | 'machine'. */
  routingSource?: string;
  /** Seats govern sessions (2026-09-28, coding/seat-governance.ts): what governed a coding
   *  run's model — 'explicit' | 'project' | 'preference' | 'seat' | 'stamp' — so run_spend
   *  reads "what governed" without a join (the API costs panel's governance line). */
  modelSource?: string;
  /** A4 machine-firing effort step-down (2026-10-04, coding/machine-firing-effort.ts):
   *  the reasoning_effort the lead seat was given for a SCHEDULE / HOOK firing
   *  ('high' | 'max' | … | 'default' = no effort param sent), stamped on the run's
   *  run_spend + run_tokens rows only, so spend per effort is a plain GROUP BY. */
  reasoningEffort?: string;
  /** A4: why — 'all_complete_board' (stepped down) | 'board_open' | 'no_plan' (kept). */
  effortReason?: string;
  /** GOAL-PRIORITY-SPEND (2026-10-20, platform/goal-spend.ts): the goal the run's spend is attributed to — the
   *  lane chat's charterGoalId (else its charter todo's goal), so per-goal spend is a plain filter on
   *  meta.goalId (get_spend scope 'goal', the [BOARD] 7d $). Kill switch GOAL_SPEND_ATTRIBUTION_DISABLED=1. */
  goalId?: string;
}

/**
 * Pure model-id → provider mapping (registry '<label>:<modelId>' specs map to
 * their label). Unknown families return undefined — never a guess.
 */
export function providerOfModel(model: string | undefined | null): string | undefined {
  if (!model || typeof model !== 'string') return undefined;
  const m = model.trim().toLowerCase();
  if (!m) return undefined;
  const colon = m.indexOf(':');
  if (colon > 0) return m.slice(0, colon); // custom-endpoint registry spec
  if (m.startsWith('kimi')) return 'moonshot';
  if (m.startsWith('glm')) return 'zai';
  if (m.startsWith('deepseek')) return 'deepseek';
  if (m.startsWith('qwen')) return 'dashscope';
  if (m.startsWith('gpt')) return 'openai';
  if (m.startsWith('grok')) return 'xai';
  if (m.startsWith('gemini')) return 'google';
  if (m.startsWith('claude')) return 'anthropic';
  return undefined;
}

/** The stamp's meta fields (defined values only, provider auto-derived). */
function stampMeta(stamp: MetricStamp | undefined): Record<string, unknown> | undefined {
  if (!stamp) return undefined;
  const out: Record<string, unknown> = {};
  if (stamp.model) out.model = stamp.model;
  const provider = stamp.provider ?? providerOfModel(stamp.model);
  if (provider) out.provider = provider;
  if (stamp.profile) out.profile = stamp.profile;
  if (stamp.agentRunId) out.agentRunId = stamp.agentRunId;
  if (stamp.triggerKind) out.triggerKind = stamp.triggerKind;
  if (stamp.mode) out.mode = stamp.mode;
  if (stamp.routingSource) out.routingSource = stamp.routingSource;
  if (stamp.modelSource) out.modelSource = stamp.modelSource;
  if (stamp.reasoningEffort) out.reasoningEffort = stamp.reasoningEffort;
  if (stamp.effortReason) out.effortReason = stamp.effortReason;
  if (stamp.decisionId) out.decisionId = stamp.decisionId;
  if (stamp.selfAuditDecisionId) out.selfAuditDecisionId = stamp.selfAuditDecisionId;
  if (stamp.selfAuditRoundId) out.selfAuditRoundId = stamp.selfAuditRoundId;
  if (stamp.goalId) out.goalId = stamp.goalId;
  return Object.keys(out).length ? out : undefined;
}

// ── Write path: fire-and-forget, micro-batched ───────────────────────────────

export interface LoopMetricInput {
  /** one of LOOP_METRIC_KINDS (open string so new kinds need no migration) */
  kind: string;
  sessionId?: string;
  runId?: string;
  /** the measurement; omit for a pure counter */
  value?: number;
  /** 'tokens' | 'usd' | 'ms' | ... (kind-dependent) */
  unit?: string;
  /** small kind-dependent payload (must be JSON-serializable; sanitized here) */
  meta?: Record<string, unknown>;
  /** per-run stamp merged UNDER meta (meta keys win) — see MetricStamp */
  stamp?: MetricStamp;
  /**
   * EVENT time (ACCEPTANCE-METRIC-BASELINE, 2026-10-20): when set (a valid
   * Date not in the future), the row's createdAt is the moment the measured
   * EVENT happened, not the record call — framework_signal_finding rows are
   * written by an hourly sweep with a 2 h lookback, and a post-deploy metric
   * window must not count a pre-deploy event re-detected after the deploy.
   * Omitted = record time (every existing caller, unchanged).
   */
  at?: Date;
}

interface BufferedRow {
  kind: string;
  sessionId: string | null;
  runId: string | null;
  value: number | null;
  unit: string | null;
  meta?: Record<string, unknown>;
  createdAt: Date;
}

/** flush at most this often when traffic is a trickle */
export const LOOP_METRIC_FLUSH_MS = 2_000;
/** flush immediately once this many rows are buffered */
export const LOOP_METRIC_FLUSH_BATCH = 200;
/** hard cap: a down DB must become dropped telemetry, never a memory leak */
export const LOOP_METRIC_MAX_PENDING = 5_000;

let buffer: BufferedRow[] = [];
let flushTimer: NodeJS.Timeout | null = null;
/** Batches whose createMany is still in flight (audit 2026-10-08 W3-1). */
const inflightFlushes = new Set<Promise<unknown>>();
let lastWarnAt = 0;

function warnThrottled(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  try {
    logger.warn(`loop-metrics: ${message}`);
  } catch {
    /* even a broken logger must not surface */
  }
}

/** Strips non-JSON-serializable meta (circular refs, BigInt, ...) so one bad
 *  payload can never poison a whole createMany batch. */
function sanitizeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (meta === undefined || meta === null) return undefined;
  try {
    const clean = JSON.parse(JSON.stringify(meta));
    // abd733af (6d19f11f review finding 3): failure rows carry provider /
    // enqueue error strings in meta.error (and meta.detail) — a raw exception
    // message can quote a credential-shaped substring that secret-scan never
    // saw (it persisted after the scan, inside an Error). Redact those keys
    // at the ONE write path so every enqueue_failed-style row is safe by
    // construction. Only these keys, only string values — everything else in
    // meta stays byte-identical (existing readers must not see churn).
    for (const k of ['error', 'detail', 'err']) {
      const v = (clean as Record<string, unknown>)[k];
      if (typeof v === 'string' && v) (clean as Record<string, unknown>)[k] = redactInboundSecrets(v).slice(0, 200);
    }
    return clean;
  } catch {
    return undefined;
  }
}

function toRow(input: LoopMetricInput): BufferedRow {
  const value = typeof input.value === 'number' && Number.isFinite(input.value) ? input.value : null;
  // Stamp merge (N6): stamp fields sit UNDER the site's own meta so an explicit
  // meta.model (e.g. a run_tokens row) always wins over the run stamp.
  const stamped = stampMeta(input.stamp);
  const meta = stamped || input.meta ? { ...stamped, ...input.meta } : undefined;
  return {
    kind: input.kind.trim(),
    sessionId: typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null,
    // Audit 2026-10-06 T6-4 (crosscutting X7): a row recorded inside a chat-agent turn without a runId takes the
    // turn's minted telemetry run id (same session only; CHAT_RUN_TELEMETRY_ID_DISABLED=1 ⇒ null as before).
    runId: typeof input.runId === 'string' && input.runId ? input.runId : (ambientTelemetryRunId(input.sessionId) ?? null),
    value,
    unit: typeof input.unit === 'string' && input.unit ? input.unit : null,
    meta: sanitizeMeta(meta),
    // stamped at record time — flush lag must not skew buckets; an explicit
    // past EVENT time (input.at) wins (a future one is clamped to now).
    createdAt: input.at instanceof Date && Number.isFinite(input.at.getTime()) && input.at.getTime() <= Date.now()
      ? input.at
      : new Date(),
  };
}

/**
 * Record one loop-telemetry event. Fire-and-forget: returns immediately,
 * never throws, never blocks the caller (the DB write happens on the next
 * micro-batch flush). Safe to call with garbage — invalid input is dropped.
 */
export function recordLoopMetric(input: LoopMetricInput): void {
  try {
    if (!input || typeof input.kind !== 'string' || !input.kind.trim()) return;
    if (buffer.length >= LOOP_METRIC_MAX_PENDING) {
      warnThrottled(`pending buffer full (${LOOP_METRIC_MAX_PENDING}); dropping metrics until a flush succeeds`);
      return;
    }
    buffer.push(toRow(input));
    if (buffer.length >= LOOP_METRIC_FLUSH_BATCH) {
      void flushLoopMetrics();
      return;
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        void flushLoopMetrics();
      }, LOOP_METRIC_FLUSH_MS);
      // never hold the process open for telemetry (worker shutdown, jest)
      flushTimer.unref?.();
    }
  } catch {
    /* never throws — telemetry must not take the loop down */
  }
}

/** Batch-friendly variant: record many events in one call (one buffer pass). */
export function recordLoopMetrics(inputs: LoopMetricInput[]): void {
  try {
    if (!Array.isArray(inputs)) return;
    for (const input of inputs) recordLoopMetric(input);
  } catch {
    /* never throws */
  }
}

/**
 * Persist everything buffered so far. Called automatically (size/timer
 * triggered); exported for graceful shutdown and tests. Never rejects —
 * a failed batch is dropped with a throttled warn (lossy by design).
 */
export async function flushLoopMetrics(): Promise<void> {
  try {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    // audit 2026-10-08 W3-1: an in-flight batch is visible to drainLoopMetrics,
    // so a shutdown never disconnects Prisma under a createMany it started.
    const write = Promise.resolve(prisma.loopMetric.createMany({ data: batch as never }));
    inflightFlushes.add(write);
    try {
      await write;
    } finally {
      inflightFlushes.delete(write);
    }
  } catch (err: any) {
    warnThrottled(`flush failed, dropped batch (non-fatal): ${err?.message || err}`);
  }
}

/**
 * Graceful-shutdown flush (audit 2026-10-08 W3-1 — plumbing F1): write
 * everything buffered AND wait for batches a timer- or size-triggered flush
 * already has in flight, bounded by `maxMs`. A draining worker used to exit
 * with its last run's run_spend / run_tokens rows still in the buffer. Never
 * rejects. Returns how many rows were buffered when it was called.
 */
export async function drainLoopMetrics(maxMs = 10_000): Promise<{ buffered: number; inflight: number; timedOut: boolean }> {
  const buffered = buffer.length;
  const inflight = inflightFlushes.size;
  let timedOut = false;
  try {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((res) => {
      timer = setTimeout(() => res('deadline'), Math.max(0, maxMs));
      (timer as any).unref?.();
    });
    const work = (async () => {
      await flushLoopMetrics();
      await Promise.allSettled([...inflightFlushes]);
      return 'done' as const;
    })();
    timedOut = (await Promise.race([work, deadline])) === 'deadline';
    if (timer) clearTimeout(timer);
  } catch {
    /* never rejects */
  }
  return { buffered, inflight, timedOut };
}

// ── Spend accounting (the audit's blind spot) ────────────────────────────────

/**
 * Structural match for coding/cost.ts `RunUsage` (a UsageAccumulator
 * snapshot) — duck-typed so the wiring site passes `usageAcc.snapshot()`
 * straight through without an import cycle into the coding module.
 */
export interface RunSpendUsage {
  totalInTokens: number;
  totalOutTokens: number;
  totalCostUsd?: number;
  /** audit 2026-10-08 W3-2: cache-served prompt tokens across the run (cost.ts RunUsage.totalCachedTokens). */
  totalCachedTokens?: number;
  turns?: number;
  estimated?: boolean;
  agents?: Array<{
    model: string;
    /** audit 2026-10-08 W3-4: the custom endpoint's registry spec — the normalized row key (cost.ts AgentUsageRow.spec). */
    spec?: string;
    /** audit 2026-10-08 W3-2: cache-served prompt tokens on this row (subset of inTokens). */
    cachedTokens?: number;
    /** build 2026-10-08 C: USD the prompt cache saved on this row (cost.ts AgentUsageRow.cacheSavedUsd). */
    cacheSavedUsd?: number;
    /** build 2026-10-08 Q-1: 'family:<key>' | 'registry' | 'default' for a non-built-in price (cost.ts AgentUsageRow.priceSource). */
    priceSource?: string;
    inTokens: number;
    outTokens: number;
    costUsd?: number;
    estimated?: boolean;
    /** display key of the recording loop ('Digby', a worker title, 'Cross-checker' …) — cost.ts AgentUsageRow.agent */
    agent?: string;
    /** the loop's role ('cross_checker', 'coder' …; absent for the lead) — cost.ts AgentUsageRow.role */
    role?: string;
    /**
     * E5 context-fill: the largest single-turn prompt_tokens recorded under
     * this agent row (cost.ts AgentUsageRow.peakPromptTokens) — the fill
     * numerator. Absent on estimate-only rows.
     */
    peakPromptTokens?: number;
  }>;
}

/**
 * E5 context_window_used: known context windows (TOKENS) for the fill
 * denominator, keyed by model id. Mirrors the contextChars char budgets in
 * coding-model.ts ProviderConfig (chars ≈ 4/token, deliberately UNDER the raw
 * window as a compaction trigger) — this table is the RAW provider window in
 * tokens, the honest denominator for a fill ratio. Edge/custom `<label>:<id>`
 * specs and unknown models → no row (a wrong denominator would be worse than
 * none: the ratio is left absent rather than guessed).
 */
export const CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  'kimi-k3': 1_000_000,      // 1M window (platform.kimi.ai)
  'glm-5.3': 1_000_000,      // 1M window (docs.z.ai; live-verified 2026-09-10)
  'glm-5.3-flash': 1_000_000,
  'deepseek-flash': 1_000_000, // DeepSeek V4.1 Flash 1M context (cutover 2026-09-10)
  'kimi-k2.6': 256_000,
  'kimi-k2': 128_000,
  'qwen3.6-27b': 128_000,      // DashScope Qwen3.6 128k window
  'qwen3.6-flash': 128_000,
};

/** E5: resolve a model id's window, following the legacy aliases (retired ids
 *  route to their current targets — normalizeCodingModel / LEGACY_BUILT_IN_ALIASES
 *  route the CALLS there, so the serving window is the alias target's) —
 *  undefined when unknown. */
const LEGACY_WINDOW_ALIASES: Record<string, string> = {
  'deepseek-v4-pro': 'deepseek-flash',    // routed to V4.1 Flash (2026-09-10 cutover)
  'deepseek-v4-flash': 'deepseek-flash',  // retired, aliased forward
  'glm-5.2': 'glm-5.3',
  'kimi-k2.6': 'kimi-k3',
};

/** Exported for the pin test: the legacy window aliases, keyed by retired id. */
export const WINDOW_ALIASES: Record<string, string> = { ...LEGACY_WINDOW_ALIASES };

function windowTokensFor(model: string): number | undefined {
  const m = String(model || '').trim();
  if (!m || m.includes(':')) return undefined; // '<label>:<modelId>' Edge specs — unknown window
  return CONTEXT_WINDOW_TOKENS[m] ?? CONTEXT_WINDOW_TOKENS[LEGACY_WINDOW_ALIASES[m]];
}

/**
 * Convert one finalized run's usage into metrics rows:
 *   - run_tokens_in / run_tokens_out per model (value = tokens, meta.model),
 *   - one run_spend row (value = total USD, meta.models/turns/estimated).
 * Fire-and-forget and never throws (rides the recordLoopMetric buffer).
 *
 * Intended wiring (run-finalize, owned separately): right after
 * `commitRunUsage(input.sessionId, usageAcc.snapshot())` in coding/agent.ts —
 *   recordRunSpend(usageAcc.runId, input.sessionId, usageAcc.snapshot());
 *
 * `stamp` (N6): the run's MetricStamp — profile/triggerKind ride every row;
 * the per-model token rows keep their OWN model (provider re-derived per row),
 * the run_spend row carries the stamp's orchestrator model.
 *
 * `meta.seats` (WI-D, 2026-09-25): when the agent rows carry a role/agent label
 * (the UsageAccumulator always does; hand-built usages may not), the run_spend
 * row maps each model to the distinct seats that recorded under it —
 * `{ 'kimi-k3': ['lead'], 'deepseek-flash': ['cross_checker'] }` — so a shared
 * chat-turn ledger's byModel split can be labelled (the lead vs the Double
 * Checker on the same vendor stays distinguishable). Unlabelled rows → no key
 * (pre-existing hand-built callers stay byte-identical). Seats seen today:
 * 'lead' (the orchestrator's own turns), 'cross_checker' (the Double Checker
 * and the Level 3 council colleagues/clones) and 'reconcile' — the L2 reconcile
 * pass, the LEAD model re-run one-shot against the checker's draft
 * (`{ 'kimi-k3': ['lead', 'reconcile'], 'deepseek-flash': ['cross_checker'] }`;
 * agent.ts AgentRunInput.usageRole — before the 2026-09-25 seat-label fix it
 * landed as 'cross_checker' on the lead's model).
 */
/** audit 2026-10-08 W3-4: SPEND_MODEL_KEY_NORMALIZE_DISABLED=1 keys spend rows by the bare model id again. */
function spendKeyNormalizeDisabled(): boolean {
  const v = String(process.env.SPEND_MODEL_KEY_NORMALIZE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
/** audit 2026-10-08 W3-2: PROMPT_CACHE_METRICS_DISABLED=1 drops the cache fields from spend rows (coding/prompt-cache-usage.ts). */
function spendCacheFieldsDisabled(): boolean {
  const v = String(process.env.PROMPT_CACHE_METRICS_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export function recordRunSpend(runId: string, sessionId: string | undefined, usage: RunSpendUsage, stamp?: MetricStamp): void {
  try {
    if (!usage) return;
    const normalizeKeys = !spendKeyNormalizeDisabled();
    const cacheFields = !spendCacheFieldsDisabled();
    const byModel = new Map<string, { inTokens: number; outTokens: number; costUsd: number; estimated: boolean; cachedTokens: number }>();
    const seatsByModel = new Map<string, string[]>();
    /** key → the bare model id (window lookups stay on the id the provider serves). */
    const bareByKey = new Map<string, string>();
    /** build 2026-10-08 Q-1: key → the non-built-in price source the meter used (rides run_tokens_in). */
    const priceSourceByKey = new Map<string, string>();
    // E5 context-fill: per-model PEAK prompt_tokens (max across the model's
    // agent rows — a shared turn ledger runs the lead, the checker and the
    // reconcile pass on possibly the same vendor).
    const modelPeak = new Map<string, number>();
    for (const row of usage.agents ?? []) {
      if (!row || typeof row.model !== 'string' || !row.model) continue;
      // audit 2026-10-08 W3-4: one name per model — a custom endpoint keys on its registry spec.
      const key = normalizeKeys && typeof row.spec === 'string' && row.spec ? row.spec : row.model;
      if (!bareByKey.has(key)) bareByKey.set(key, row.model);
      if (typeof row.priceSource === 'string' && row.priceSource && !priceSourceByKey.has(key)) priceSourceByKey.set(key, row.priceSource);
      const acc = byModel.get(key) ?? { inTokens: 0, outTokens: 0, costUsd: 0, estimated: false, cachedTokens: 0 };
      acc.inTokens += Number(row.inTokens) || 0;
      acc.outTokens += Number(row.outTokens) || 0;
      acc.costUsd += Number(row.costUsd) || 0;
      acc.cachedTokens += Number(row.cachedTokens) || 0;
      acc.estimated = acc.estimated || !!row.estimated;
      byModel.set(key, acc);
      const peak = Number(row.peakPromptTokens) || 0;
      if (peak > (modelPeak.get(key) ?? 0)) modelPeak.set(key, peak);
      const seat = typeof row.role === 'string' && row.role ? row.role : (typeof row.agent === 'string' && row.agent ? 'lead' : '');
      if (seat) {
        const list = seatsByModel.get(key) ?? [];
        if (!list.includes(seat)) list.push(seat);
        seatsByModel.set(key, list);
      }
    }
    // No per-agent breakdown? Fall back to the totals under model 'unknown'.
    if (!byModel.size && ((Number(usage.totalInTokens) || 0) > 0 || (Number(usage.totalOutTokens) || 0) > 0)) {
      byModel.set('unknown', {
        inTokens: Number(usage.totalInTokens) || 0,
        outTokens: Number(usage.totalOutTokens) || 0,
        costUsd: Number(usage.totalCostUsd) || 0,
        estimated: !!usage.estimated,
        cachedTokens: Number(usage.totalCachedTokens) || 0,
      });
    }

    const base = { runId, sessionId };
    const entries: LoopMetricInput[] = [];
    for (const [model, t] of byModel) {
      // Per-row stamp: the token rows are per-MODEL, so the stamp's model is
      // replaced with the row's own (provider re-derives from it in stampMeta).
      // No stamp passed → no stamp built: the pre-N6 rows stay byte-identical.
      const rowStamp: MetricStamp | undefined = stamp ? { ...stamp, model, provider: undefined } : undefined;
      if (t.inTokens > 0) {
        entries.push({
          ...base,
          kind: LOOP_METRIC_KINDS.RUN_TOKENS_IN,
          value: t.inTokens,
          unit: 'tokens',
          // audit 2026-10-08 W3-2: the cache-served share of these prompt tokens (every provider shape).
          meta: { model, estimated: t.estimated, ...(cacheFields && t.cachedTokens > 0 ? { cachedTokens: t.cachedTokens } : {}), ...(priceSourceByKey.has(model) ? { priceSource: priceSourceByKey.get(model) } : {}) },
          stamp: rowStamp,
        });
      }
      if (t.outTokens > 0) {
        entries.push({
          ...base,
          kind: LOOP_METRIC_KINDS.RUN_TOKENS_OUT,
          value: t.outTokens,
          unit: 'tokens',
          meta: { model, estimated: t.estimated },
          stamp: rowStamp,
        });
      }
      // E5 context_window_used: the per-model context FILL row — peak
      // prompt_tokens vs the model's known window. One row per model that
      // reported a provider usage turn (estimate-only runs mint none: their
      // promptTokens is a chars/4 artifact, not a window measurement). Unknown
      // model / Edge spec → no row (a guessed denominator would be worse than
      // none). Per-model peak: multiple agent rows on the same model keep the
      // max, not a sum (two workers on one model fill two windows, not a
      // double-size one).
      const peak = modelPeak.get(model);
      const windowTokens = windowTokensFor(bareByKey.get(model) ?? model) ?? windowTokensFor(model);
      if (peak && windowTokens) {
        entries.push({
          ...base,
          kind: LOOP_METRIC_KINDS.RUN_CONTEXT_FILL,
          value: peak,
          unit: 'tokens',
          meta: {
            model,
            peakPromptTokens: peak,
            windowTokens,
            fillRatio: Math.round((peak / windowTokens) * 1000) / 1000,
          },
          stamp: rowStamp,
        });
      }
    }
    const totalCostUsd =
      typeof usage.totalCostUsd === 'number' && Number.isFinite(usage.totalCostUsd)
        ? usage.totalCostUsd
        : [...byModel.values()].reduce((s, t) => s + t.costUsd, 0);
    // Always one run_spend row per finalized run (even a $0 run — the count
    // of finalized runs is itself a loop-health signal).
    // audit 2026-10-08 W3-2: the run's prompt-cache effectiveness rides its spend row (cache-hit % per profile).
    const runIn = [...byModel.values()].reduce((s2, t) => s2 + t.inTokens, 0);
    const runCached = [...byModel.values()].reduce((s2, t) => s2 + t.cachedTokens, 0);
    // build 2026-10-08 C: cache-aware dollars — what the cache saved at list prices and what the run would have cost without it.
    const runCacheSaved = (usage.agents ?? []).reduce((s2, r) => s2 + (Number(r?.cacheSavedUsd) || 0), 0);
    entries.push({
      ...base,
      kind: LOOP_METRIC_KINDS.RUN_SPEND,
      value: totalCostUsd,
      unit: 'usd',
      meta: {
        models: [...byModel.keys()],
        turns: Number(usage.turns) || 0,
        estimated: !!usage.estimated,
        ...(seatsByModel.size ? { seats: Object.fromEntries(seatsByModel) } : {}),
        ...(cacheFields && runIn > 0 ? { inTokens: runIn, cachedTokens: runCached, cacheHitRatio: Math.round(Math.min(1, runCached / runIn) * 1000) / 1000 } : {}),
        ...(cacheFields && runCacheSaved > 0 ? { cacheSavedUsd: Math.round(runCacheSaved * 1e6) / 1e6, noCacheUsd: Math.round((totalCostUsd + runCacheSaved) * 1e6) / 1e6 } : {}),
      },
      stamp,
    });
    recordLoopMetrics(entries);
  } catch {
    /* never throws */
  }
}

// ── Guard-strike adjudication (remediation P0 item N6 rider) ─────────────────

/**
 * Write an adjudication verdict onto ONE existing loop_metrics row —
 * meta.adjudication + meta.adjudicatedAt, merged server-side (jsonb ||) so a
 * concurrent stamp/read can't be clobbered. For the future nightly
 * guard-strike adjudication job ("was this strike a true positive?"): the job
 * reads recent guard_strike rows, judges each, and calls this with a verdict
 * like 'true_positive' | 'false_positive' | 'unclear'.
 *
 * Returns true when the row existed and was updated. DB errors propagate —
 * this is a deliberate job/admin API, not the fire-and-forget write path.
 */
export async function adjudicateStrike(id: string, verdict: string): Promise<boolean> {
  const v = String(verdict ?? '').trim().slice(0, 60);
  if (!id || !v) return false;
  const updated = await prisma.$executeRaw`
    UPDATE "loop_metrics"
    SET "meta" = COALESCE("meta", '{}'::jsonb)
             || jsonb_build_object('adjudication', ${v}::text,
                                   'adjudicatedAt', ${new Date().toISOString()}::text)
    WHERE "id" = ${id}`;
  return Number(updated) === 1;
}

// ── Utility-LLM dual-failure telemetry (ticket 26fe2168 close-out) ───────────

/**
 * Record ONE utilityChat call on which BOTH providers failed (DeepSeek primary
 * AND the DashScope fallback — the utility-llm "total failure" path). One
 * loop_metrics row per dual failure, kind 'utility_llm_dual_failure', with the
 * process streak + the last provider error strings in meta so an operator can
 * chart outage windows and read the failure shape without grepping logs.
 *
 * The ALERTING half (streak threshold → deduped feedback ticket) lives in
 * utility-llm.ts itself (noteUtilityChatTotalFailure, PR #504) — this is the
 * telemetry half. Fire-and-forget, never throws, never blocks the caller.
 */
export function noteUtilityLlmFailure(input?: {
  /** The in-process consecutive dual-failure streak at this call. */
  streak?: number;
  /** Compact shape of the failing call (timeout/contentOnly/…). */
  callerContext?: string;
  /** The last provider error strings (DeepSeek + DashScope legs), clipped here. */
  lastErrors?: string[];
}): void {
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.UTILITY_LLM_DUAL_FAILURE,
      meta: {
        ...(typeof input?.streak === 'number' && Number.isFinite(input.streak) ? { streak: input.streak } : {}),
        ...(input?.callerContext ? { callerContext: String(input.callerContext).slice(0, 200) } : {}),
        ...(Array.isArray(input?.lastErrors) && input.lastErrors.length
          ? { lastErrors: input.lastErrors.slice(0, 4).map((e) => String(e).slice(0, 300)) }
          : {}),
      },
    });
  } catch {
    /* never throws — telemetry must not take the caller down */
  }
}

// ── Seat-fallback telemetry (helper-seat health fallback, 2026-09-14) ────────

export interface SeatFallbackNote {
  /** The model-roles seat key ('coding_helper', …). */
  role: string;
  /** The failed seat spec (the admin's override). */
  from: string;
  /** The built-in that served (or was tried) instead. */
  to: string;
  /** Short log-safe cause ('HTTP 400 — …', 'timeout', 'ECONNREFUSED', 'empty answer'). */
  reason: string;
  /** 'recovered' = the built-in answered; 'failed' = it failed too; 'unavailable'
   *  = keyless on this instance, no retry; 'retrying' = a streaming worker moved
   *  seats mid-run (outcome not known at record time). */
  status: 'recovered' | 'failed' | 'unavailable' | 'retrying';
  /** Which consumer hit it ('web_pipe', 'youtube_pipe', 'worker:verifier', …). */
  caller?: string;
  httpStatus?: number;
  /** 2026-09-30: the provider's own error text (secrets redacted, ≤200 chars) — a 'billing' or 429
   *  classification can be audited later (prod 09-30 04:57Z: 44 'billing' fallbacks on a funded key, no text kept). */
  detail?: string;
  sessionId?: string;
  runId?: string;
  stamp?: MetricStamp;
  /** 2026-09-27 deterministic-4xx seat fallback: the invalid-request
   *  fingerprint class ('tools_too_long', 'reasoning_effort_unsupported', …). */
  fingerprint?: string;
  /** 2026-09-27: ISO end of the seat latch (no run retries the seat before it) —
   *  the DB-backed signal the admin page / briefing / status card read
   *  (listActiveSeatLatches). */
  latchedUntil?: string;
  /** audit 2026-10-06 T1-6: same-endpoint candidates tried AFTER off-endpoint ones on a gateway 5xx. */
  sameEndpointDeferred?: string[];
}

/**
 * Record ONE seat fallback (kind seat_fallback, helper shape). Fire-and-forget,
 * never throws. One row per FAILURE of the configured seat, whatever the
 * outcome — countSeatFallbacksByRole reads them back as the seat's 24h
 * failure count for the admin Endpoints panel.
 */
export function noteSeatFallback(n: SeatFallbackNote): void {
  try {
    if (!n || typeof n.role !== 'string' || !n.role) return;
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SEAT_FALLBACK,
      sessionId: n.sessionId,
      runId: n.runId,
      stamp: n.stamp,
      meta: {
        role: n.role,
        from: String(n.from ?? '').slice(0, 300),
        to: String(n.to ?? '').slice(0, 300),
        reason: String(n.reason ?? '').slice(0, 200),
        status: n.status,
        ...(n.caller ? { caller: String(n.caller).slice(0, 80) } : {}),
        ...(typeof n.httpStatus === 'number' && Number.isFinite(n.httpStatus) ? { httpStatus: n.httpStatus } : {}),
        ...(n.detail ? { detail: redactInboundSecrets(String(n.detail)).replace(/\s+/g, ' ').slice(0, 200) } : {}),
        ...(n.fingerprint ? { fingerprint: String(n.fingerprint).slice(0, 60) } : {}),
        ...(n.latchedUntil ? { latchedUntil: String(n.latchedUntil).slice(0, 40) } : {}),
        ...(n.sameEndpointDeferred?.length ? { sameEndpointDeferred: n.sameEndpointDeferred.slice(0, 5).map((x) => String(x).slice(0, 200)) } : {}),
      },
    });
  } catch {
    /* never throws — telemetry must not take the caller down */
  }
}

export interface ActiveSeatLatch {
  role: string;
  from: string;
  to: string;
  reason: string;
  fingerprint?: string;
  /** ISO — the first latching row's time inside the live window. */
  since: string;
  /** ISO — when the seat is retried again. */
  until: string;
}

/**
 * Seats currently LATCHED off by a deterministic invalid-request rejection
 * (2026-09-27): the newest seat_fallback row per (role, from) whose
 * meta.latchedUntil is still ahead of `now`. DB-backed so every box (web A/B,
 * worker C) and the owner-facing surfaces agree — the in-process latch
 * (coding/seat-invalid-request.ts) is per process. DB errors propagate; every
 * caller fails open to [].
 */
export async function listActiveSeatLatches(now: number = Date.now()): Promise<ActiveSeatLatch[]> {
  const since = new Date(now - 24 * 3_600_000);
  const rows = await prisma.loopMetric.findMany({
    where: { kind: LOOP_METRIC_KINDS.SEAT_FALLBACK, createdAt: { gte: since } },
    select: { meta: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 2_000,
  });
  const out = new Map<string, ActiveSeatLatch>();
  const firstSeen = new Map<string, number>();
  for (const r of rows) {
    const m = (r?.meta ?? {}) as Record<string, unknown>;
    const until = typeof m.latchedUntil === 'string' ? Date.parse(m.latchedUntil) : NaN;
    if (!Number.isFinite(until)) continue;
    const role = typeof m.role === 'string' && m.role ? m.role : typeof m.seat === 'string' && m.seat ? m.seat : null;
    const from = typeof m.from === 'string' ? m.from : '';
    if (!role || !from) continue;
    const key = `${role}::${from}`;
    const createdAt = r.createdAt instanceof Date ? r.createdAt.getTime() : Date.parse(String(r.createdAt));
    if (until <= now) continue; // expired latch row
    if (!out.has(key)) {
      out.set(key, {
        role, from,
        to: typeof m.to === 'string' ? m.to : '',
        reason: typeof m.reason === 'string' ? m.reason : '',
        ...(typeof m.fingerprint === 'string' ? { fingerprint: m.fingerprint } : {}),
        since: new Date(createdAt).toISOString(),
        until: new Date(until).toISOString(),
      });
      firstSeen.set(key, createdAt);
    } else {
      // Rows are newest-first: an older live row moves `since` back.
      const prev = firstSeen.get(key) ?? createdAt;
      if (createdAt < prev) { firstSeen.set(key, createdAt); out.get(key)!.since = new Date(createdAt).toISOString(); }
    }
  }
  return [...out.values()].sort((a, b) => a.since.localeCompare(b.since));
}

/** Upper bound on rows read per count — fallbacks are rare; this is a guard, not a page size. */
export const SEAT_FALLBACK_COUNT_MAX_ROWS = 5_000;

/**
 * seat_fallback rows in the trailing window, counted per seat key — the
 * helper shape's meta.role and the orchestrator shape's meta.seat both name a
 * model-roles key. Served on GET /admin/model-roles as each role's
 * `recentFailures` so the Endpoints panel can badge a flaky seat. DB errors
 * propagate — the caller (listModelRoles) fails open to zero counts.
 */
export async function countSeatFallbacksByRole(hours = 24): Promise<Record<string, number>> {
  const since = new Date(Date.now() - clampHours(hours, 24) * 3_600_000);
  const rows = await prisma.loopMetric.findMany({
    where: { kind: LOOP_METRIC_KINDS.SEAT_FALLBACK, createdAt: { gte: since } },
    select: { meta: true },
    orderBy: { createdAt: 'desc' },
    take: SEAT_FALLBACK_COUNT_MAX_ROWS,
  });
  const out: Record<string, number> = {};
  for (const r of rows) {
    const m = (r?.meta ?? {}) as Record<string, unknown>;
    const role = typeof m.role === 'string' && m.role ? m.role : typeof m.seat === 'string' && m.seat ? m.seat : null;
    if (!role) continue;
    out[role] = (out[role] ?? 0) + 1;
  }
  return out;
}

// ── Read path: aggregations ──────────────────────────────────────────────────

export interface LoopMetricBucket {
  /** bucket start, ISO string (date_trunc'd to the hour/day) */
  bucket: string;
  kind: string;
  count: number;
  /** SUM(value) with null values contributing nothing; 0 when all-null */
  sum: number;
  /** AVG(value); null when the kind carries no values (pure counter) */
  avg: number | null;
}

interface RawBucketRow {
  bucket: Date | string;
  kind: string;
  count: bigint | number;
  sum: number | null;
  avg: number | null;
}

/** Pure normalization of a raw GROUP BY result: BigInt counts → number,
 *  null sums → 0, Date buckets → ISO. Exported for direct math testing. */
export function normalizeLoopMetricBuckets(rows: RawBucketRow[]): LoopMetricBucket[] {
  return (rows || []).map((r) => ({
    bucket: r.bucket instanceof Date ? r.bucket.toISOString() : new Date(r.bucket).toISOString(),
    kind: r.kind,
    count: Number(r.count) || 0,
    sum: typeof r.sum === 'number' && Number.isFinite(r.sum) ? r.sum : 0,
    avg: typeof r.avg === 'number' && Number.isFinite(r.avg) ? r.avg : null,
  }));
}

export const LOOP_METRIC_MAX_WINDOW_HOURS = 24 * 90; // retention is 30d; 90d is a hard sanity cap

function clampHours(hours: number | undefined, fallback: number): number {
  const n = Math.floor(Number(hours));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, LOOP_METRIC_MAX_WINDOW_HOURS);
}

/**
 * Per-kind aggregation over a trailing window, bucketed per hour (default)
 * or per day: count, sum, avg for each bucket. DB-side (date_trunc + GROUP
 * BY) — the [kind, createdAt] index covers the scan.
 */
export async function queryLoopMetrics(
  kind: string,
  opts?: { hours?: number; bucket?: 'hour' | 'day' }
): Promise<LoopMetricBucket[]> {
  const hours = clampHours(opts?.hours, 24);
  const unit = opts?.bucket === 'day' ? 'day' : 'hour';
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await prisma.$queryRaw<RawBucketRow[]>`
    SELECT date_trunc(${unit}, "createdAt") AS bucket,
           "kind"                           AS kind,
           COUNT(*)                         AS count,
           SUM("value")                     AS sum,
           AVG("value")                     AS avg
    FROM "loop_metrics"
    WHERE "createdAt" >= ${since} AND "kind" = ${kind}
    GROUP BY 1, 2
    ORDER BY 1 ASC`;
  return normalizeLoopMetricBuckets(rows);
}

// ── Outcome aggregate (ticket d59499f4) ─────────────────────────────────────
//
// WHY THIS EXISTS. `queryLoopMetrics` answers "how many rows per hour", which is
// NOT "what fraction succeeded": a lane certifying a reliability KPI had to fall
// back to SQL (hitting an edge mirror, publishing two retracted numbers) and
// finally asked a supervisor to hand-count rows (ticket 63ab9dc7). The rows
// carry `meta.ok`; nothing aggregated it.
//
// And a plain ok-rate would STILL have been wrong (ticket d59499f4, the second
// sighting): one embed call writes TWO rows at the same timestamp — an
// attempt row (`unit:'attempt'`) and a call-level roll-up with no `unit` — so
// grouping by time alone mixes two different denominators into one rate
// (85.71 % per attempt vs 95.45 % per call on the same prod sample). The
// aggregate therefore groups by (bucket, unit) and reports a rate PER UNIT plus
// a window total, so a caller must name the unit it is citing.

/** One bucket × one unit group of the outcome aggregate. */
export interface LoopMetricOutcomeBucket {
  /** bucket start, ISO string (date_trunc'd to the hour/day) */
  bucket: string;
  /** `meta.unit` of the rows in this group; null = the rows carry no unit field
   *  (a call-level roll-up row). Never conflate it with an attempt group. */
  unit: string | null;
  /** every row in the group, labeled or not */
  total: number;
  /** rows whose success flag read true */
  ok: number;
  /** rows whose success flag read false */
  fail: number;
  /** rows with NO boolean-ish success flag — in `total`, never in `rate` */
  unlabeled: number;
  /** ok / (ok + fail); null when the group has no labeled row (never 0/0 → NaN) */
  rate: number | null;
}

/** Per-unit window total. Same fields as a bucket, no `bucket`. */
export interface LoopMetricOutcomeGroup {
  unit: string | null;
  total: number;
  ok: number;
  fail: number;
  unlabeled: number;
  rate: number | null;
}

export interface LoopMetricOutcomes {
  /** Which meta key carried the flag in this window ('ok' preferred, 'success'
   *  the fallback); null = no row in the window carried one. */
  flag: 'ok' | 'success' | null;
  /** per (bucket, unit), oldest bucket first */
  buckets: LoopMetricOutcomeBucket[];
  /** per unit, summed over the whole window — cite ONE of these, never a mix */
  byUnit: LoopMetricOutcomeGroup[];
  /** the whole window across every unit group */
  window: Omit<LoopMetricOutcomeGroup, 'unit'>;
}

interface RawOutcomeRow {
  bucket: Date | string;
  unit: string | null;
  total: bigint | number;
  ok: bigint | number;
  fail: bigint | number;
  okKey: bigint | number;
  successKey: bigint | number;
}

const num = (v: bigint | number | string | null | undefined): number => {
  const n = typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** ok / (ok + fail), or null when nothing is labeled — never NaN, never 0/0. */
export function outcomeRate(ok: number, fail: number): number | null {
  const labeled = ok + fail;
  return labeled > 0 ? Math.round((ok / labeled) * 10_000) / 10_000 : null;
}

/**
 * Pure normalization + roll-up of the raw GROUP BY. Exported so the math (the
 * bucket → unit → window fold and the null-rate rule) is testable without a DB.
 */
export function normalizeLoopMetricOutcomes(rows: RawOutcomeRow[]): LoopMetricOutcomes {
  const buckets: LoopMetricOutcomeBucket[] = (rows || []).map((r) => {
    const total = num(r.total);
    const ok = num(r.ok);
    const fail = num(r.fail);
    return {
      bucket: r.bucket instanceof Date ? r.bucket.toISOString() : new Date(r.bucket).toISOString(),
      unit: typeof r.unit === 'string' && r.unit ? r.unit : null,
      total,
      ok,
      fail,
      unlabeled: Math.max(0, total - ok - fail),
      rate: outcomeRate(ok, fail),
    };
  }).sort((a, b) => a.bucket.localeCompare(b.bucket) || String(a.unit ?? '').localeCompare(String(b.unit ?? '')));

  const groups = new Map<string | null, LoopMetricOutcomeGroup>();
  const window = { total: 0, ok: 0, fail: 0, unlabeled: 0 };
  let okKeyRows = 0;
  let successKeyRows = 0;
  for (const b of buckets) {
    const g = groups.get(b.unit) ?? { unit: b.unit, total: 0, ok: 0, fail: 0, unlabeled: 0, rate: null };
    g.total += b.total;
    g.ok += b.ok;
    g.fail += b.fail;
    g.unlabeled += b.unlabeled;
    groups.set(b.unit, g);
    window.total += b.total;
    window.ok += b.ok;
    window.fail += b.fail;
    window.unlabeled += b.unlabeled;
  }
  // The flag is decided over the WHOLE window: a kind that uses `success` on
  // some rows and `ok` on others still reports one honest name.
  for (const r of rows || []) {
    okKeyRows += num(r.okKey);
    successKeyRows += num(r.successKey);
  }
  const byUnit = [...groups.values()]
    .map((g) => ({ ...g, rate: outcomeRate(g.ok, g.fail) }))
    .sort((a, b) => b.total - a.total || String(a.unit ?? '').localeCompare(String(b.unit ?? '')));
  return {
    flag: okKeyRows > 0 ? 'ok' : successKeyRows > 0 ? 'success' : null,
    buckets,
    byUnit,
    window: { ...window, rate: outcomeRate(window.ok, window.fail) },
  };
}

/**
 * Window-bounded ok/fail aggregate for a row-kind metric, grouped by meta.unit
 * AND by time bucket. DB-side (date_trunc + GROUP BY + COUNT FILTER) on the
 * [kind, createdAt] index; the boolean-ish flag is read from `meta.ok` and
 * falls back to `meta.success`.
 *
 * A row with no flag is counted in `total` and `unlabeled`, never in the rate —
 * an unlabeled row must not silently read as a success OR a failure.
 */
export async function queryLoopMetricOutcomes(
  kind: string,
  opts?: { hours?: number; bucket?: 'hour' | 'day' }
): Promise<LoopMetricOutcomes> {
  const hours = clampHours(opts?.hours, 24);
  const unit_arg = opts?.bucket === 'day' ? 'day' : 'hour';
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await prisma.$queryRaw<RawOutcomeRow[]>`
    SELECT date_trunc(${unit_arg}, "createdAt") AS bucket,
           NULLIF("meta"->>'unit', '')            AS unit,
           COUNT(*)                               AS total,
           COUNT(*) FILTER (WHERE lower(COALESCE(NULLIF("meta"->>'ok', ''), NULLIF("meta"->>'success', ''))) IN ('true', '1'))  AS ok,
           COUNT(*) FILTER (WHERE lower(COALESCE(NULLIF("meta"->>'ok', ''), NULLIF("meta"->>'success', ''))) IN ('false', '0')) AS fail,
           COUNT(*) FILTER (WHERE NULLIF("meta"->>'ok', '') IS NOT NULL)      AS "okKey",
           COUNT(*) FILTER (WHERE NULLIF("meta"->>'success', '') IS NOT NULL) AS "successKey"
    FROM "loop_metrics"
    WHERE "createdAt" >= ${since} AND "kind" = ${kind}
    GROUP BY 1, 2
    ORDER BY 1 ASC, 2 ASC`;
  return normalizeLoopMetricOutcomes(rows);
}

// ── Payload-size distribution (ticket d59499f4, missing field #1) ────────────

/** Payload sizes are emitted per record (rag_embed_call: `chars` on an attempt
 *  row, `batchChars` on the call roll-up). Sized here so the chunk/batch lever
 *  is a number instead of a guess. */
export interface LoopMetricPayloadSize {
  /** meta.unit of the group; null = unit-less rows */
  unit: string | null;
  /** which meta key the sizes came from */
  field: 'chars' | 'batchChars';
  /** rows that carried a size */
  n: number;
  p50: number;
  p95: number;
  max: number;
  avg: number;
}

interface RawPayloadRow {
  unit: string | null;
  field: string;
  n: bigint | number;
  /** percentile_cont / AVG over a numeric come back as a Decimal string from
   *  most pg drivers — parsed defensively in num(). */
  p50: number | string | null;
  p95: number | string | null;
  max: number | string | null;
  avg: number | string | null;
}

/** A meta value counts as a size only when it is a plain non-negative number —
 *  the CAST is guarded in SQL by this same shape, so a junk value can never
 *  blow the read up. */
const NUMERIC_TEXT = '^[0-9]+(\\.[0-9]+)?$';

export function normalizeLoopMetricPayloadSizes(rows: RawPayloadRow[]): LoopMetricPayloadSize[] {
  return (rows || [])
    .map((r) => ({
      unit: typeof r.unit === 'string' && r.unit ? r.unit : null,
      field: (r.field === 'chars' ? 'chars' : 'batchChars') as 'chars' | 'batchChars',
      n: num(r.n),
      p50: Math.round(num(r.p50)),
      p95: Math.round(num(r.p95)),
      max: Math.round(num(r.max)),
      avg: Math.round(num(r.avg)),
    }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n);
}

/**
 * p50/p95/max of the payload sizes the rows carry, per (unit, field). Empty for
 * a kind that emits no size — that is the signal that the lever is still blind,
 * so it is returned rather than guessed.
 */
export async function queryLoopMetricPayloadSizes(
  kind: string,
  opts?: { hours?: number }
): Promise<LoopMetricPayloadSize[]> {
  const since = new Date(Date.now() - clampHours(opts?.hours, 24) * 3_600_000);
  // The numeric guard lives INSIDE the lateral, not in an outer WHERE: an outer
  // filter does not guarantee the CAST is never evaluated on a junk value, and
  // one malformed meta field must not take the whole telemetry read down.
  // The cast stops at `numeric` (adversarial review 2026-11-01, M1): a 400-digit
  // digit string passes the regex AND numeric, but `numeric → float8` raises
  // "value out of range" — which is exactly the escape this guard exists to
  // prevent. percentile_cont / AVG / MAX all accept numeric, and
  // normalizeLoopMetricPayloadSizes already parses numeric-as-string.
  const rows = await prisma.$queryRaw<RawPayloadRow[]>`
    SELECT unit, field, COUNT(*) AS n,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY v) AS p50,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY v) AS p95,
           MAX(v) AS max,
           AVG(v) AS avg
    FROM (
      SELECT NULLIF("meta"->>'unit', '') AS unit,
             -- 'chars' wins only when it is itself a usable size; a junk chars
             -- value falls through to batchChars instead of being dropped
             -- (review M4), so a row is never silently uncounted.
             CASE WHEN "meta"->>'chars' ~ ${NUMERIC_TEXT} THEN 'chars' ELSE 'batchChars' END AS field,
             CASE WHEN "meta"->>'chars' ~ ${NUMERIC_TEXT} THEN "meta"->>'chars' ELSE "meta"->>'batchChars' END AS raw
      FROM "loop_metrics"
      WHERE "createdAt" >= ${since} AND "kind" = ${kind}
        AND (jsonb_exists("meta", 'chars') OR jsonb_exists("meta", 'batchChars'))
    ) t,
    LATERAL (SELECT CASE WHEN t.raw ~ ${NUMERIC_TEXT} THEN t.raw::numeric END AS v) sized
    WHERE sized.v IS NOT NULL
    GROUP BY 1, 2
    ORDER BY 3 DESC`;
  return normalizeLoopMetricPayloadSizes(rows);
}

/**
 * PER-LEG ATTEMPT ATTRIBUTION (ticket b5f4d5e2) — the read that turns "an embed
 * regression exists" into "leg X failed N of M attempts, aborted by Y".
 *
 * Without this, a 47 % failure rate on `rag_embed_call` was measurable but not
 * localizable: the row said `errorKind:'timeout'` and nothing named which
 * deployment served the attempt, how long it took, or whether OUR bound or the
 * provider's error ended it. The 2026-11-02 lane proved the gap was structural
 * (the gateway logged 100 % 200s for the same hour the platform counted 70
 * failures), so the fix has to make the LEG a first-class grouping key.
 *
 * `leg` is absent on a caller-side abort by construction (no response ⇒ no
 * header), so those rows land in the explicit `leg: null` group instead of
 * vanishing from the aggregate — a leg-less failure is still a counted failure,
 * and `abort:'caller_timeout'` is what names it.
 */
export interface LoopMetricLegRow {
  /** the deployment the gateway named; null = no leg was reported (a caller
   *  abort, or a direct-to-provider lane with no gateway in front) */
  leg: string | null;
  /** typed end reason the row carried; null = the row predates the field or
   *  the attempt succeeded */
  abort: string | null;
  total: number;
  ok: number;
  /** rows that carried NO ok/success flag — counted, never folded into ok or
   *  fail (the `outcomes` sibling exposes the same number; a row in `total` but
   *  in neither bucket would otherwise be an invisible subtraction) */
  unlabeled: number;
  fail: number;
  /** p50/p95 attempt wall-clock in ms — the duration needed to tell "slow but
   *  serving" from "aborted at our bound". NULL = no row in the group carried a
   *  duration; never 0, which would read as "instant". */
  p50Ms: number | null;
  p95Ms: number | null;
}

interface RawLegRow {
  leg: string | null;
  abort: string | null;
  total: bigint | number;
  ok: bigint | number;
  fail: bigint | number;
  unlabeled: bigint | number;
  p50ms: number | string | null;
  p95ms: number | string | null;
}

/** A duration percentile is either a real number or genuinely unknown. `num()`
 *  maps null → 0, which for a latency reads as "instant" — the one wrong answer
 *  it must never give, so absence is preserved instead of coerced. */
const durationOrNull = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === '' ? null : Math.round(num(v));

/** Pure normalization of the raw GROUP BY — the math is testable without a DB. */
export function normalizeLoopMetricLegs(rows: RawLegRow[]): LoopMetricLegRow[] {
  return (rows || [])
    .map((r) => ({
      leg: typeof r.leg === 'string' && r.leg ? r.leg : null,
      abort: typeof r.abort === 'string' && r.abort ? r.abort : null,
      total: num(r.total),
      ok: num(r.ok),
      fail: num(r.fail),
      unlabeled: num(r.unlabeled),
      p50Ms: durationOrNull(r.p50ms),
      p95Ms: durationOrNull(r.p95ms),
    }))
    .filter((r) => r.total > 0)
    // FAILURES FIRST, then by volume: the supervisor reads the top of this list,
    // so the rows that need a decision must not sit under a healthy leg's noise.
    .sort((a, b) => b.fail - a.fail || b.total - a.total || String(a.leg ?? '').localeCompare(String(b.leg ?? '')));
}

/**
 * ATTEMPT rows grouped by (leg, abort) over the window — the acceptance read
 * ("each failed attempt is queryable by leg"). DB-side GROUP BY, no row cap, so
 * a 6 h window reports the whole population rather than a sample.
 *
 * THE POPULATION IS THE WHOLE CORRECTNESS OF THIS READ. One embed CALL writes
 * TWO kinds of row at the same instant: an ATTEMPT row (`meta.unit:'attempt'`,
 * `value` = one request's ms, and the only rows that carry leg/abort) and a
 * CALL ROLL-UP (`meta.batchCount`, `value` = the whole call). Pooling them —
 * which a bare `kind` predicate does — double-counts every attempt, feeds
 * whole-call durations (documented as reaching ~41 s) into the attempt
 * percentiles, and dumps every roll-up into the `leg:null, abort:null` group, so
 * a failure with no typed reason appears in exactly the bucket this ticket
 * exists to eliminate.
 *
 * `rollUp()` in rag.service.ts is the ONLY producer of `meta.batchCount`, and
 * attempt rows never carry it, so excluding it selects attempts for the embed
 * lane. It is the right predicate rather than a positive `unit = 'attempt'`
 * because the RERANK lane writes one row per rung with NO `unit` at all — a
 * positive unit filter would silently drop the entire rerank population, which
 * the ticket names as the identical blind spot.
 */
export async function queryLoopMetricLegs(
  kind: string,
  opts?: { hours?: number }
): Promise<LoopMetricLegRow[]> {
  const since = new Date(Date.now() - clampHours(opts?.hours, 24) * 3_600_000);
  // `value` carries the attempt wall-clock (recordRagTransport sets
  // value: attempt.ms), so the duration percentiles need no extra field parse.
  const rows = await prisma.$queryRaw<RawLegRow[]>`
    SELECT NULLIF("meta"->>'leg', '')   AS leg,
           NULLIF("meta"->>'abort', '') AS abort,
           COUNT(*)                     AS total,
           COUNT(*) FILTER (WHERE lower(COALESCE(NULLIF("meta"->>'ok', ''), NULLIF("meta"->>'success', ''))) IN ('true', '1'))  AS ok,
           COUNT(*) FILTER (WHERE lower(COALESCE(NULLIF("meta"->>'ok', ''), NULLIF("meta"->>'success', ''))) IN ('false', '0')) AS fail,
           COUNT(*) FILTER (WHERE lower(COALESCE(NULLIF("meta"->>'ok', ''), NULLIF("meta"->>'success', ''))) NOT IN ('true', '1', 'false', '0')) AS unlabeled,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY "value") AS p50ms,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY "value") AS p95ms
    FROM "loop_metrics"
    WHERE "createdAt" >= ${since} AND "kind" = ${kind}
      AND "meta"->>'batchCount' IS NULL
    GROUP BY 1, 2
    ORDER BY fail DESC, total DESC`;
  return normalizeLoopMetricLegs(rows);
}

/**
 * UNATTRIBUTED EMBED FAILURES over a window — the KPI read for goal 4e432dff.
 *
 * WHAT IT COUNTS. Failure rows on the embed surfaces that cannot name BOTH the
 * flow that attempted the call (`meta.bucket`) and the side/leg it ended on.
 * The attribution RULE is not re-implemented here: `embedAttributionComplete` in
 * memory/embed-failure.ts is the single definition, and the normalizer below
 * calls it, so the probe can never drift from what the emitters write.
 *
 * WHY THE POPULATION IS PER-ROW AND SPLIT BY SURFACE. The three emit paths
 * count different things and pooling them would be a lying denominator:
 *   - `rag_embed_call` ATTEMPT rows (`meta.unit:'attempt'`, no `meta.batchCount`)
 *     are one per HTTP request — the unit that pays the timeout.
 *   - `rag_embed_call` CALL ROLL-UPS (`meta.batchCount`) aggregate a whole call;
 *     they are not failures of their own and including them would double-count.
 *   - `unified_memory_embed_failed` rows are per FAILED BATCH (value = rows lost),
 *     so they are failures by construction (`meta.ok` is absent there and the
 *     suppress/ok filter must NOT drop them).
 *   - `memory_embed_backfill` is the repair cron's tick row: an ATTEMPT
 *     attribution, not a failure. It is reported separately so the operator can
 *     see the repair flow's own leg without inflating the failure count.
 *
 * `unattributed` is the number the KPI bar reads (bar 0, at_most).
 */
export interface LoopMetricEmbedAttributionRow {
  /** the emit surface this row came from */
  surface: 'rag_embed_call' | 'unified_memory_embed_failed' | 'memory_embed_backfill';
  total: number;
  /** rows carrying a real bucket (not the `unknown` sentinel) */
  bucketed: number;
  /** rows carrying a leg */
  legged: number;
  /** rows that FAIL the attribution rule — the KPI's numerator */
  unattributed: number;
}

export interface LoopMetricEmbedAttributionReport {
  hours: number;
  /** failures that cannot name bucket+leg — THE KPI VALUE */
  unattributed: number;
  totalFailures: number;
  /** per-surface breakdown (the diagnostic, never the KPI) */
  surfaces: LoopMetricEmbedAttributionRow[];
  /** the distinct buckets seen, for a drift read on the closed enum */
  buckets: Record<string, number>;
  /** the distinct legs seen, failures first — localizes an upstream */
  legs: Record<string, number>;
}

/**
 * Rows-as-data normalization — the whole judgement, testable with no DB.
 * Kept exported and pure so the fixture suite can prove the rule on the exact
 * shapes the emitters produce (including the pre-attribution row with no keys).
 */
export function normalizeEmbedAttribution(
  input: Array<{ surface: LoopMetricEmbedAttributionRow['surface']; meta: any }>,
  hours: number,
): LoopMetricEmbedAttributionReport {
  const bySurface = new Map<LoopMetricEmbedAttributionRow['surface'], LoopMetricEmbedAttributionRow>();
  const buckets: Record<string, number> = {};
  const legs: Record<string, number> = {};
  let unattributed = 0;
  let totalFailures = 0;
  for (const row of input || []) {
    let meta: any = row?.meta;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch { meta = null; }
    }
    const surface = row.surface;
    const agg = bySurface.get(surface)
      ?? { surface, total: 0, bucketed: 0, legged: 0, unattributed: 0 };
    agg.total++;
    // The KPI is a FAILURE bar: the repair tick's own summary row is a flow
    // attribution, not a failure, so it is counted per-surface but never in the
    // numerator — a healthy cron must not be able to hold the bar red.
    if (surface !== 'memory_embed_backfill') {
      totalFailures++;
      if (!embedAttributionComplete(meta)) {
        agg.unattributed++;
        unattributed++;
      }
    }
    if (isKnownEmbedBucket(meta?.bucket)) agg.bucketed++;
    if (typeof meta?.leg === 'string' && meta.leg) agg.legged++;
    const b = typeof meta?.bucket === 'string' && meta.bucket ? meta.bucket : '(absent)';
    buckets[b] = (buckets[b] ?? 0) + 1;
    const l = typeof meta?.leg === 'string' && meta.leg ? meta.leg : '(none)';
    legs[l] = (legs[l] ?? 0) + 1;
    bySurface.set(surface, agg);
  }
  return {
    hours,
    unattributed,
    totalFailures,
    surfaces: [...bySurface.values()].sort((a, b) => b.unattributed - a.unattributed || b.total - a.total),
    buckets,
    legs,
  };
}

/**
 * The LIVE read behind the KPI. DB-side filtering keeps the whole population
 * (no row cap) while returning only meta — never the full rows — because the
 * window can hold tens of thousands of attempt rows.
 *
 * `ok = false` selects the failure population where the row HAS an ok flag;
 * `unified_memory_embed_failed` rows carry none (they only exist on failure),
 * so they are selected without that predicate.
 */
export async function queryEmbedAttribution(opts?: { hours?: number }): Promise<LoopMetricEmbedAttributionReport> {
  const hours = clampHours(opts?.hours, 24);
  const since = new Date(Date.now() - hours * 3_600_000);
  const rows = await prisma.$queryRaw<Array<{ kind: string; meta: any }>>`
    SELECT "kind", "meta"
    FROM "loop_metrics"
    WHERE "createdAt" >= ${since}
      AND "kind" IN (${LOOP_METRIC_KINDS.RAG_EMBED_CALL}, ${LOOP_METRIC_KINDS.UNIFIED_MEMORY_EMBED_FAILED}, ${LOOP_METRIC_KINDS.MEMORY_EMBED_BACKFILL})
      AND (
        -- an embed ATTEMPT that failed (roll-ups and successes excluded)
        ("kind" = ${LOOP_METRIC_KINDS.RAG_EMBED_CALL}
          AND "meta"->>'batchCount' IS NULL
          AND lower(COALESCE(NULLIF("meta"->>'ok', ''), NULLIF("meta"->>'success', ''))) IN ('false', '0'))
        -- the store-path failure row: its existence IS the failure
        OR "kind" = ${LOOP_METRIC_KINDS.UNIFIED_MEMORY_EMBED_FAILED}
        -- the repair tick: attributed separately, never in the KPI numerator
        OR "kind" = ${LOOP_METRIC_KINDS.MEMORY_EMBED_BACKFILL}
      )`;
  return normalizeEmbedAttribution(
    (rows || []).map((r) => ({
      surface: r.kind === LOOP_METRIC_KINDS.RAG_EMBED_CALL
        ? 'rag_embed_call' as const
        : r.kind === LOOP_METRIC_KINDS.UNIFIED_MEMORY_EMBED_FAILED
          ? 'unified_memory_embed_failed' as const
          : 'memory_embed_backfill' as const,
      meta: r.meta,
    })),
    hours,
  );
}

export interface LoopMetricSummaryRow {
  kind: string;
  count: number;
  sum: number;
}

/** Compact window summary — count + sum for EVERY kind seen (default 24h). */
export async function summarizeLoopMetrics(hours = 24): Promise<LoopMetricSummaryRow[]> {
  const since = new Date(Date.now() - clampHours(hours, 24) * 3_600_000);
  const groups = await prisma.loopMetric.groupBy({
    by: ['kind'],
    where: { createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { value: true },
    orderBy: { kind: 'asc' },
  });
  return groups.map((g) => ({
    kind: g.kind,
    count: Number(g._count?._all) || 0,
    sum: typeof g._sum?.value === 'number' && Number.isFinite(g._sum.value) ? g._sum.value : 0,
  }));
}

// ── Retention ────────────────────────────────────────────────────────────────

export const LOOP_METRIC_RETENTION_DAYS = 30;
export const LOOP_METRIC_GC_BATCH = 5_000;
/** ≤ 100k rows per sweep — bounded like the reaper GCs; a backlog drains
 *  across successive sweeps. */
export const LOOP_METRIC_GC_MAX_BATCHES = 20;

/**
 * Delete loop_metrics rows older than `days` (default 30), batched so no
 * single statement locks the table unboundedly. Never throws; returns the
 * number of rows deleted.
 *
 * WIRED (2026-09-02): runAgentRunReaper() in coding/run-reaper.ts calls this
 * every reaper pass as GC rule (f), alongside the event/receipt GCs. It is
 * best-effort/batched internally, so the call site carries no try/catch.
 */
export async function sweepLoopMetrics(days = LOOP_METRIC_RETENTION_DAYS): Promise<number> {
  let deleted = 0;
  try {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 86_400_000);
    for (let i = 0; i < LOOP_METRIC_GC_MAX_BATCHES; i++) {
      const ids = await prisma.loopMetric.findMany({
        where: { createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: LOOP_METRIC_GC_BATCH,
      });
      if (!ids.length) break;
      const del = await prisma.loopMetric.deleteMany({ where: { id: { in: ids.map((r) => r.id) } } });
      deleted += del.count;
      if (ids.length < LOOP_METRIC_GC_BATCH) break;
    }
    if (deleted) {
      logger.info(
        `loop-metrics sweep: deleted ${deleted} row(s) older than ${days}d${deleted >= LOOP_METRIC_GC_BATCH * LOOP_METRIC_GC_MAX_BATCHES ? ' (cap hit, more next sweep)' : ''}`
      );
    }
  } catch (err: any) {
    logger.warn(`loop-metrics sweep failed (non-fatal): ${err?.message || err}`);
  }
  return deleted;
}

// ── Test hook ────────────────────────────────────────────────────────────────

/** Clears the in-memory buffer + timer. Tests only. */
export function __resetLoopMetricsForTest(): void {
  buffer = [];
  inflightFlushes.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  lastWarnAt = 0;
}
