/**
 * Utility LLM Client — DeepSeek V4.1 Flash (primary) + Qwen 3.6 27B via DashScope (safety net)
 *
 * Used by: generateTitle, generateFollowUps, consolidateMemory, RAG context
 *          sentences, ingestion synthesis, context compression, LangGraph memory
 *          extraction, live thinking-summary commentary.
 *
 * Why DeepSeek Flash (`deepseek-flash` = V4.1 Flash on api.deepseek.com,
 * released 2026-09-10; the retired `deepseek-v4-flash` id routes here)
 *  - Cheap per token compared with Cohere (~10x lower for utility-grade work)
 *  - OpenAI-compatible API shape — `choices[0].message.content` parses normally.
 *  - Already wired into env (DEEPSEEK_API_KEY).
 *  - Vendor aliases DO move (2026-09-10: V4 Flash retired, V4 Pro routed to
 *    V4.1 Flash from 2026-09-14) — track the current id here, alias legacy ids
 *    forward in coding-model.ts normalizeCodingModel.
 *
 * IMPORTANT: DeepSeek Flash THINKS BY DEFAULT and emits `message.reasoning_content`
 * BEFORE `message.content`. Every utility call below pins
 * `thinking:{type:'disabled'}` unless the caller opts in (options.thinking), so
 * a small max_tokens is not burned on reasoning. We default to 1024 max_tokens;
 * callers asking for very short answers should still leave ~150 tokens of
 * headroom, and `reasoning_content` is a fallback when `content` is empty so a
 * truncated thinking:true response still returns something usable.
 *
 * Falls back to Qwen 3.6 27B via Alibaba DashScope if DeepSeek is unavailable —
 * or, when the admin set a 'utility_fallback' model role (Digby Edge), to that
 * custom endpoint first (utilityChat's leg order documents the full chain).
 */

import axios from 'axios';
import logger from '../utils/logger';

// ── Primary: DeepSeek V4.1 Flash (direct API) ────────────────────────────────

const DEEPSEEK_API_KEY  = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_UTILITY_MODEL = 'deepseek-flash';

// ── Fallback: Qwen via Alibaba DashScope (OpenAI-compatible) ─────────────────
// 2026-07-12 (Paul): background/utility work must run on DeepSeek V4 Flash or
// Qwen 3.6 27B only — fallback moved from qwen3.6-flash to qwen3.6-27b.
// DASHSCOPE_UTILITY_MODEL overrides without a code change if the ID differs.
//
// Latency carve-out: callers with sub-10s timeouts (live thinking-summaries,
// kid status lines, title one-liners — cosmetic UI, not background tasks) were
// tuned for a flash-tier fallback; a 27B on a 4-8s budget would just time out
// and silently return '' during the exact DeepSeek outages the fallback exists
// for. Those calls keep the flash model.

const DASHSCOPE_API_KEY  = process.env.DASHSCOPE_API_KEY;
const DASHSCOPE_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const DASHSCOPE_FALLBACK_MODEL = process.env.DASHSCOPE_UTILITY_MODEL || 'qwen3.6-27b';

// ── DeepSeek billing/auth latch (rollout watch 2026-09-14, 19:07Z) ─────────
// DeepSeek answered HTTP 402 "Insufficient Balance" on every utility call —
// 115 failed round-trips in 40 minutes, each paying the primary's timeout
// before the DashScope fallback answered. A 402/401/403 is not transient: the
// balance or key needs a human. After one such answer the DeepSeek leg is
// skipped for DEEPSEEK_BILLING_LATCH_MS (fallback serves directly, ONE warn),
// then retried. Process-local by design — every process learns it once.
export const DEEPSEEK_BILLING_LATCH_MS = 10 * 60 * 1000;
const BILLING_AUTH_STATUSES = new Set([401, 402, 403]);
let deepseekBillingLatchUntil = 0;
export function deepseekBillingLatched(now: number = Date.now()): boolean { return now < deepseekBillingLatchUntil; }
export function __resetDeepseekBillingLatchForTests(): void { deepseekBillingLatchUntil = 0; lastBillingTicketAt = 0; }
// Owner signal (rollout watch 2026-09-14, tick 8): the 402 ran for 3h with the
// latch degrading every utility call to DashScope and NOTHING owner-visible —
// the coding loop files a deduped 'PROVIDER BILLING OUTAGE' ticket on the same
// class (agent.ts), but no coding lane sits on DeepSeek, so the utility leg was
// the only witness and it only warned. File the same owner-action ticket
// (userId null — process-level, the 26fe2168 pattern below) at most once per
// process per DEEPSEEK_BILLING_TICKET_REFIRE_MS; the stable title dedup-bumps.
export const DEEPSEEK_BILLING_TICKET_REFIRE_MS = 60 * 60 * 1000;

// ── Utility role-override latch (rollout watch tick 11, 2026-09-15) ───────────
// See the override block in utilityChat: a custom utility seat that times out or
// refuses connections is skipped for this long (process-local), then retried.
//
// FO firing 47 (2026-09-29): the flat 5-min window re-paid the FULL caller
// timeout every 5 minutes through a sustained slowdown — prod ran 6-7
// latch→retry→timeout→latch cycles per hour for 4h straight (24 warns, each
// costing a 30s hang on the caller that happened to land on the retry). A
// SUSTAINED outage now backs off 5 → 15 → 30 → 60 min (cap), one retry each;
// the first override SUCCESS resets the streak (a healthy seat is never
// penalized for one blip).
export const UTILITY_OVERRIDE_LATCH_MS = 5 * 60 * 1000;
export const UTILITY_OVERRIDE_BACKOFF_STEPS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
const UTILITY_OVERRIDE_UNREACHABLE_RE = /timeout of \d+ms exceeded|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network error/i;
const UTILITY_OVERRIDE_LATCHED_SKIP = Symbol('utility-override-latched');
let utilityOverrideLatchUntil = 0;
let utilityOverrideStreak = 0;
export function utilityOverrideLatched(now: number = Date.now()): boolean { return now < utilityOverrideLatchUntil; }
export function __resetUtilityOverrideLatchForTests(): void { utilityOverrideLatchUntil = 0; utilityOverrideStreak = 0; }
/** Latch the override leg off for the streak-th backoff step. Fire-and-forget telemetry (never delays the caller's degradation path). */
function latchUtilityOverrideOff(status: number | undefined, msg: string): void {
  const step = Math.min(utilityOverrideStreak, UTILITY_OVERRIDE_BACKOFF_STEPS_MS.length - 1);
  const backoffMs = UTILITY_OVERRIDE_BACKOFF_STEPS_MS[step];
  utilityOverrideStreak += 1;
  const streak = utilityOverrideStreak;
  utilityOverrideLatchUntil = Date.now() + backoffMs;
  logger.warn(`utilityChat: utility role override unreachable (${status || msg.slice(0, 120)}); skipping the override for ${backoffMs / 60000} min (streak ${streak}) — the built-in chain serves utility calls directly. Check the custom utility endpoint (Account → Admin → Endpoints → Model roles).`, { source: 'utility-override' });
  void import('../modules/crossmodel/platform/loop-metrics.service')
    .then((m) => m.recordLoopMetric({
      kind: m.LOOP_METRIC_KINDS.UTILITY_OVERRIDE_LATCH,
      meta: { backoffMin: backoffMs / 60000, streak, ...(typeof status === 'number' ? { status } : {}), ...(msg ? { error: msg.slice(0, 160) } : {}) },
    }))
    .catch(() => { /* telemetry is best-effort */ });
}
let lastBillingTicketAt = 0;
function noteDeepseekBillingOutage(status: number, errMsg: string): void {
  const now = Date.now();
  if (now - lastBillingTicketAt < DEEPSEEK_BILLING_TICKET_REFIRE_MS) return;
  lastBillingTicketAt = now;
  void (async () => {
    try {
      const { fileFeedbackTicket } = await import('../modules/crossmodel/feedback/feedback.service');
      await fileFeedbackTicket({
        userId: null, // process-level alert — no user context (column is nullable)
        type: 'mishap',
        priority: 5,
        area: 'owner-action',
        title: `PROVIDER BILLING OUTAGE — DeepSeek answered HTTP ${status} to utility calls (owner top-up / re-key needed)`,
        description: [
          `Auto-filed by utilityChat's DeepSeek billing/auth latch (pid ${process.pid}).`,
          '',
          `DeepSeek (${DEEPSEEK_UTILITY_MODEL}) answered HTTP ${status} — a billing/auth rejection, not a transient error. Provider said: ${String(errMsg).slice(0, 300)}`,
          '',
          `While this persists every utility call (titles, follow-ups, memory extraction, status cards, briefings) is served by the DashScope fallback ${DASHSCOPE_FALLBACK_MODEL}; the DeepSeek leg is retried every ${DEEPSEEK_BILLING_LATCH_MS / 60000} min and re-latches on the next ${status}. Only the OWNER can fix it: top up the DeepSeek balance or re-key DEEPSEEK_API_KEY. The L2 cross-checker / L3 council seats on DeepSeek fail the same way in chat.`,
          '',
          `Dedup note: repeats collapse into this row via title dedup (refire at most every ${DEEPSEEK_BILLING_TICKET_REFIRE_MS / 60000} min per process); occurrences count = ongoing outage.`,
        ].join('\n'),
        context: { area: 'owner-action', surface: 'utility-llm', class: 'provider_billing', status, pid: process.pid, filedAt: new Date().toISOString() },
      });
    } catch { /* ticket filing is best-effort — the latch + warn stand */ }
  })();
}

// ── Proactive DeepSeek balance probe (nightly 2026-09-14, ticket 2b7ceafa class) ──
// The latch above is REACTIVE: it learns the balance is empty from the first
// failed utility call (today's 402 degraded calls for 3h before 225b878f4 made
// it owner-visible). DeepSeek exposes GET /user/balance (Bearer key →
// { is_available, balance_infos: [{ currency, total_balance, granted_balance,
// topped_up_balance }] }), so the durable cron 'deepseek-balance-probe'
// (worker.ts, hourly, DB/API-only — safe on every worker incl. the 0-slot
// cron-only one) asks the vendor directly:
//   - HTTP 401/402/403        → the key itself is rejected: latch + the same
//                               deduped owner-action ticket as a failed call.
//   - is_available === false  → vendor says the account cannot serve: latch
//                               PROACTIVELY (utility calls skip DeepSeek before
//                               burning a failed round-trip) + the same ticket.
//   - total_balance < DEEPSEEK_BALANCE_WARN_FLOOR (default 0 = off) → a
//                               DISTINCT low-balance early-warning ticket
//                               (priority 3, own 6h refire) so the owner can
//                               top up BEFORE anything degrades.
//   - network/timeout/other   → warn-only, NO ticket: a failed probe says
//                               nothing about the account.
export const DEEPSEEK_BALANCE_WARN_FLOOR = Number(process.env.DEEPSEEK_BALANCE_WARN_FLOOR || '0') || 0;
export const DEEPSEEK_BALANCE_LOW_TICKET_REFIRE_MS = 6 * 60 * 60 * 1000;
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
let lastBalanceLowTicketAt = 0;
export function __resetDeepseekBalanceProbeForTests(): void { lastBalanceLowTicketAt = 0; }

export async function probeDeepSeekBalance(): Promise<string> {
  if (!DEEPSEEK_API_KEY) return 'skipped: no DEEPSEEK_API_KEY';
  let res;
  try {
    res = await axios.get(DEEPSEEK_BALANCE_URL, {
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      timeout: 10_000,
      validateStatus: () => true, // status handled explicitly below
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`deepseek-balance-probe: probe failed (${msg.slice(0, 200)}) — transient, no ticket`);
    return `probe-failed: ${msg.slice(0, 120)}`;
  }
  const now = Date.now();
  if (!res || typeof res.status !== 'number') {
    logger.warn('deepseek-balance-probe: malformed response (no HTTP status) — transient, no ticket');
    return 'probe-failed: malformed response';
  }
  if (BILLING_AUTH_STATUSES.has(res.status)) {
    deepseekBillingLatchUntil = now + DEEPSEEK_BILLING_LATCH_MS;
    logger.warn(`deepseek-balance-probe: /user/balance answered HTTP ${res.status} — latching the DeepSeek leg for ${DEEPSEEK_BILLING_LATCH_MS / 60000} min`);
    noteDeepseekBillingOutage(res.status, `balance probe: GET /user/balance answered HTTP ${res.status}`);
    return `billing-auth HTTP ${res.status} (latched, ticket deduped)`;
  }
  if (res.status !== 200) {
    logger.warn(`deepseek-balance-probe: /user/balance answered HTTP ${res.status} — transient, no ticket`);
    return `probe-failed: HTTP ${res.status}`;
  }
  const infos: Array<{ currency?: string; total_balance?: unknown }> = Array.isArray(res.data?.balance_infos) ? res.data.balance_infos : [];
  const available = res.data?.is_available !== false; // absent field = treat as available (schema-drift tolerance)
  const total = infos.reduce((sum, i) => sum + (Number(i?.total_balance) || 0), 0);
  const currency = infos[0]?.currency || '?';
  if (!available) {
    // The vendor's OWN sufficiency flag — honored even under balance_infos
    // drift (it is not derived from the array).
    deepseekBillingLatchUntil = now + DEEPSEEK_BILLING_LATCH_MS;
    logger.warn(`deepseek-balance-probe: is_available=false (total ${total} ${currency}) — latching + filing the billing ticket`);
    noteDeepseekBillingOutage(402, `balance probe: is_available=false, total_balance=${total} ${currency}`);
    return `exhausted: is_available=false total=${total} ${currency} (latched, ticket deduped)`;
  }
  if (infos.length === 0) {
    // Review 2026-09-14 (PR #771): a 200 with a missing/empty balance_infos is
    // schema DRIFT, not a balance reading — with the floor armed, total=0
    // would file a bogus "balance LOW" ticket. Warn-only, like any malformed
    // probe: drift says nothing about the account.
    logger.warn('deepseek-balance-probe: 200 with missing/empty balance_infos — malformed body, warn-only');
    return 'probe-failed: malformed body (no balance_infos)';
  }
  if (DEEPSEEK_BALANCE_WARN_FLOOR > 0 && total < DEEPSEEK_BALANCE_WARN_FLOOR) {
    if (now - lastBalanceLowTicketAt >= DEEPSEEK_BALANCE_LOW_TICKET_REFIRE_MS) {
      lastBalanceLowTicketAt = now;
      void (async () => {
        try {
          const { fileFeedbackTicket } = await import('../modules/crossmodel/feedback/feedback.service');
          await fileFeedbackTicket({
            userId: null, // process-level alert — no user context (column is nullable)
            type: 'mishap',
            priority: 3,
            area: 'owner-action',
            title: 'DeepSeek balance LOW — proactive probe (owner top-up before utility degradation)',
            description: [
              `Auto-filed by the hourly deepseek-balance-probe cron (pid ${process.pid}).`,
              '',
              `GET /user/balance reports total_balance=${total} ${currency} — below the configured warn floor ${DEEPSEEK_BALANCE_WARN_FLOOR}. The account still serves (is_available=true), but at the current burn it will hit HTTP 402 "Insufficient Balance" — the failure shape of ticket 2b7ceafa (2026-09-14), where utility calls silently degraded to the DashScope fallback for hours.`,
              '',
              `Owner action: top up the DeepSeek balance BEFORE the reactive billing latch has to fire. Tune or silence this warning with DEEPSEEK_BALANCE_WARN_FLOOR (0 = off).`,
              '',
              `Dedup note: repeats collapse into this row via title dedup (refire at most every ${DEEPSEEK_BALANCE_LOW_TICKET_REFIRE_MS / 3600000}h per process).`,
            ].join('\n'),
            context: { area: 'owner-action', surface: 'deepseek-balance-probe', class: 'provider_billing', totalBalance: total, currency, floor: DEEPSEEK_BALANCE_WARN_FLOOR, pid: process.pid, filedAt: new Date().toISOString() },
          });
        } catch { /* ticket filing is best-effort — the warn stands */ }
      })();
    }
    return `low: total=${total} ${currency} < floor ${DEEPSEEK_BALANCE_WARN_FLOOR} (early-warning ticket deduped)`;
  }
  return `ok total=${total} ${currency}`;
}

const DASHSCOPE_FAST_FALLBACK_MODEL = 'qwen3.6-flash';
const FAST_FALLBACK_TIMEOUT_THRESHOLD_MS = 10_000;

// ── Dual-provider outage observability (ticket 26fe2168, 2026-08-30) ────────
// 2026-08-29: a ~6h window where DeepSeek returned EMPTY content AND the
// DashScope fallback timed out went completely unalerted — every utilityChat
// consumer (home starter questions, news prefetch, titles, follow-ups, memory
// consolidation) silently degraded to defaults. Count consecutive TOTAL
// failures (both legs attempted and failed on the same call) per process; past
// the threshold, file an agent feedback ticket. The stable title makes the
// feedback service's 90-day dedup BUMP the existing ticket (occurrences +1,
// priority = max, lastSeen refreshed) — that is the "file/refresh" half — and
// the post-file drain surfaces it to the fleet lane (the attention flag).
// In-process by design: the ticket asks for a per-process signal, and the
// backend processes serving the prefetch are the ones observing the failures.
export const UTILITY_OUTAGE_ALERT_THRESHOLD = 5;
export const UTILITY_OUTAGE_ALERT_REFIRE_MS = 30 * 60 * 1000;

let consecutiveDualFailures = 0;
let lastOutageAlertAt = 0;

/** Test hook — deterministic counter state between unit tests. */
export function __resetUtilityOutageCounterForTests(): void {
  consecutiveDualFailures = 0;
  lastOutageAlertAt = 0;
}

/**
 * Any leg returning real content proves the path is alive → reset the streak.
 * 1105650b review: also clear the recorded per-leg errors — a stale "last
 * DeepSeek error: (HTTP 401)" line from a long-healed blip must not ride
 * along on a later snapshot and misattribute a non-provider outage.
 */
function noteUtilityChatSuccess(): void {
  consecutiveDualFailures = 0;
  _lastDeepseekLegError = '';
  _lastDashscopeLegError = '';
  _lastCustomLegError = '';
}

// ── Utility-LLM health snapshot (ticket 1105650b, 2026-10-12) ────────────────
// The news fetch-breaker auto-ticket's `lastReason` said only "llm_empty:
// formatter returned empty content" through the 2026-10-12 05:26–07:35Z outage,
// while the actual cause — BOTH provider legs answering HTTP 401 on the dead
// pre-rotation keys — lived only in app_error_logs. Triage (and the dispatched
// ticket lane) had to dig the logs to find it. This snapshot puts the
// provider-leg state ON the ticket at trip time: the dual-failure streak (the
// same counter the outage alarm uses), the per-leg latch states, and the last
// provider error each leg recorded. Read-only, never throws — snapshotting must
// not delay the breaker path that calls it.
export interface UtilityLLMHealth {
  /** one-line human summary for the ticket body */
  summary: string;
  /** structured detail for the ticket context block */
  detail: {
    dualFailureStreak: number;
    deepseekBillingLatched: boolean;
    overrideLatched: boolean;
    deepseekKeyPresent: boolean;
    dashscopeKeyPresent: boolean;
    lastDeepseekError: string;
    lastDashscopeError: string;
    lastCustomLegError: string;
  };
}

let _lastDeepseekLegError = '';
let _lastDashscopeLegError = '';
let _lastCustomLegError = '';

/** Record the last provider error each built-in leg produced (bounded, best-effort). */
function noteLegError(leg: 'deepseek' | 'dashscope', message: string): void {
  const clipped = String(message).slice(0, 300);
  if (leg === 'deepseek') _lastDeepseekLegError = clipped;
  else _lastDashscopeLegError = clipped;
}

/** Record the last utility_fallback (custom-seat) leg error — surfaced by the health snapshot. */
function noteCustomLegError(message: string): void {
  _lastCustomLegError = String(message).slice(0, 300);
}

export function utilityLLMHealthSnapshot(): UtilityLLMHealth {
  const dualStreak = consecutiveDualFailures;
  const dsLatched = deepseekBillingLatched();
  const ovLatched = utilityOverrideLatched();
  const dsKey = Boolean(DEEPSEEK_API_KEY);
  const dqKey = Boolean(DASHSCOPE_API_KEY);
  const parts: string[] = [];
  parts.push(`dual-provider failure streak ${dualStreak} (consecutive utilityChat calls where every leg failed)`);
  parts.push(`DeepSeek leg ${dsLatched ? 'LATCHED OFF (billing/auth 401/402/403 — see the PROVIDER BILLING OUTAGE ticket)' : dsKey ? 'active' : 'unconfigured (DEEPSEEK_API_KEY not set)'}`);
  parts.push(`DashScope leg ${dqKey ? 'active' : 'unconfigured (DASHSCOPE_API_KEY not set)'}`);
  if (ovLatched) parts.push('custom utility-override leg LATCHED OFF (unreachable custom seat)');
  if (_lastCustomLegError) parts.push(`last custom-leg error: ${_lastCustomLegError}`);
  if (_lastDeepseekLegError) parts.push(`last DeepSeek error: ${_lastDeepseekLegError}`);
  if (_lastDashscopeLegError) parts.push(`last DashScope error: ${_lastDashscopeLegError}`);
  if (dualStreak >= UTILITY_OUTAGE_ALERT_THRESHOLD) parts.push('=> the utility-LLM outage alarm has ALSO fired (this is a provider outage, not a news-pipeline defect)');
  return {
    summary: parts.join('; '),
    detail: {
      dualFailureStreak: dualStreak,
      deepseekBillingLatched: dsLatched,
      overrideLatched: ovLatched,
      deepseekKeyPresent: dsKey,
      dashscopeKeyPresent: dqKey,
      lastDeepseekError: _lastDeepseekLegError,
      lastDashscopeError: _lastDashscopeLegError,
      lastCustomLegError: _lastCustomLegError,
    },
  };
}

/**
 * A call that reached the final '' return: DeepSeek failed (or was unconfigured)
 * AND the DashScope fallback failed/was absent. Past the threshold, file the
 * outage ticket (fire-and-forget — alerting must never delay or break the
 * caller's degradation path). Every dual failure ALSO records one
 * 'utility_llm_dual_failure' loop metric with the streak + the last provider
 * error strings (roadmap close-out for ticket 26fe2168) — dynamic import +
 * catch so telemetry can never delay, break, or (in a keyless test env)
 * hard-exit the caller path.
 */
function noteUtilityChatTotalFailure(callerContext: string, lastErrors: string[] = []): void {
  consecutiveDualFailures += 1;
  const streak = consecutiveDualFailures;
  void import('../modules/crossmodel/platform/loop-metrics.service')
    .then((m) => m.noteUtilityLlmFailure({ streak, callerContext, lastErrors }))
    .catch(() => { /* telemetry is best-effort */ });
  const now = Date.now();
  if (
    consecutiveDualFailures >= UTILITY_OUTAGE_ALERT_THRESHOLD &&
    now - lastOutageAlertAt >= UTILITY_OUTAGE_ALERT_REFIRE_MS
  ) {
    lastOutageAlertAt = now;
    const failures = consecutiveDualFailures;
    logger.error(`utilityChat: OUTAGE — ${failures} consecutive dual-provider failures (threshold ${UTILITY_OUTAGE_ALERT_THRESHOLD}); filing feedback ticket`);
    void (async () => {
      try {
        const { fileFeedbackTicket } = await import('../modules/crossmodel/feedback/feedback.service');
        await fileFeedbackTicket({
          userId: null, // process-level alert — no user context (column is nullable)
          type: 'bug_report',
          priority: 2,
          area: 'platform',
          title: 'Utility-LLM outage auto-detected: DeepSeek + DashScope both failing in backend process',
          description: [
            'Auto-filed by utilityChat dual-provider failure counter (follow-up to ticket 26fe2168).',
            '',
            `This backend process (pid ${process.pid}) has seen ${failures} CONSECUTIVE total utility-LLM failures — the DeepSeek primary AND the DashScope fallback both failed on the same call, ${failures} calls in a row (threshold ${UTILITY_OUTAGE_ALERT_THRESHOLD}; refire window ${UTILITY_OUTAGE_ALERT_REFIRE_MS / 60000}min). Last failing call shape: ${callerContext}.`,
            ...(lastErrors.length ? ['', `Last provider errors on the failing call:\n${lastErrors.map((e) => `- ${String(e).slice(0, 300)}`).join('\n')}`] : []),
            '',
            'Impact while this persists: every utilityChat consumer silently degrades — home starter questions serve DEFAULT_QUESTIONS, news prefetch stays on "being prepared", titles/follow-ups/status lines/memory consolidation drop to fallbacks. No user-facing error is raised, which is exactly why the 2026-08-29 ~15:00–21:00Z outage went unnoticed for ~6h.',
            '',
            `Triage: probe both providers from inside the backend container (DeepSeek api.deepseek.com, DashScope dashscope-intl.aliyuncs.com); check deploy/build CPU starvation on the host (the 2026-08-29 window correlated with near-continuous deploy builds on box A). The counter resets on the first successful call in this process; while the outage continues this ticket re-fires (dedup-bumped) at most every ${UTILITY_OUTAGE_ALERT_REFIRE_MS / 60000} min.`,
          ].join('\n'),
          context: {
            area: 'platform',
            surface: 'utility-llm',
            consecutiveDualFailures: failures,
            threshold: UTILITY_OUTAGE_ALERT_THRESHOLD,
            pid: process.pid,
            callerContext,
            lastErrors: lastErrors.map((e) => String(e).slice(0, 300)),
            filedAt: new Date().toISOString(),
          },
        });
      } catch (err: any) {
        logger.error(`utilityChat: outage ticket filing failed (counter=${failures}): ${err?.message}`);
      }
    })();
  }
}

// Minimum budget to leave room for DeepSeek's reasoning tokens. If a caller
// passes a smaller maxTokens (e.g. summarizeReasoning passes 30) we silently
// raise it to this floor so the call doesn't truncate before content emerges.
const DEEPSEEK_MIN_MAX_TOKENS = 256;
/** Floor for opt-in THINKING calls (reasoning counts against max_tokens). */
export const DEEPSEEK_THINKING_MIN_MAX_TOKENS = 16384;
/** reasoning_effort sent on opt-in thinking calls (iteration 13): low|high|max, 'off' = omit. */
export function utilityThinkingEffort(): 'low' | 'high' | 'max' | '' {
  const v = String(process.env.UTILITY_THINKING_EFFORT || 'low').toLowerCase();
  if (v === 'off' || v === 'none' || v === '') return '';
  return v === 'high' || v === 'max' ? v : 'low';
}

export interface UtilityLLMResponse {
  content: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
  /** provider finish_reason — 'length' with empty content = the budget went to reasoning */
  finishReason?: string;
  /** length of reasoning_content (0 when the provider sent none) — diagnostic for empty content */
  reasoningLength?: number;
}

/**
 * Call DeepSeek V4 Flash for utility tasks (title generation, JSON extraction, etc.).
 * OpenAI-compatible request/response shape.
 */
export async function utilityLLM(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  options?: {
    maxTokens?: number;
    temperature?: number;
    model?: string;
    timeout?: number;
    /** When true, NEVER fall back to reasoning_content if content is empty (cosmetic one-liners). */
    contentOnly?: boolean;
    /**
     * Opt-in REASONING for latency-tolerant background callers (2026-09-08, owner
     * report "are you sure it is reasoning for these?" — the home-screen starter
     * questions were mashing unrelated memory facts because the utility legs run
     * thinking-OFF). Default false keeps the 2026-09-04 no-thinking pin for every
     * other utility call (titles, follow-ups, memory extraction, briefing). With
     * thinking on, `max_tokens` covers reasoning + answer — pass a generous
     * budget (thousands) and a long timeout, and keep `contentOnly` so the raw
     * chain-of-thought can never leak into UI text.
     */
    thinking?: boolean;
  },
): Promise<UtilityLLMResponse> {
  const model = options?.model || DEEPSEEK_UTILITY_MODEL;
  const requestedMax = options?.maxTokens || 1024;
  // Thinking ON: `max_tokens` covers reasoning + answer, and V4.1 Flash's
  // reasoning alone can run past 5-8k tokens — a 2026-09-11 starter-question
  // draft came back EMPTY (finish_reason=length, thinking=true) at the
  // caller's 8000. Floor the budget so a thinking call never starves its answer.
  const maxTokens = Math.max(requestedMax, DEEPSEEK_MIN_MAX_TOKENS, options?.thinking ? DEEPSEEK_THINKING_MIN_MAX_TOKENS : 0);
  const temperature = options?.temperature ?? 0.3;
  const timeout = options?.timeout || 20000;

  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY not set — utility LLM unavailable');
  }

  let response: any;
  try {
    response = await axios.post(DEEPSEEK_BASE_URL, {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
      // 2026-09-04 (owner-briefing outage): DeepSeek's V4 API now defaults
      // THINKING ON — with small max_tokens the whole budget burns on
      // reasoning and `content` arrives EMPTY (contentOnly callers then get
      // ''). Utility calls are fast mechanical rewrites by design — thinking
      // is explicitly disabled on every utility leg UNLESS the caller opts in
      // (options.thinking — background work that needs judgment, e.g. the
      // home-screen starter questions; see the option doc above).
      thinking: { type: options?.thinking ? 'enabled' : 'disabled' },
      // Bounded reasoning for opt-in thinking calls (operator iteration 13,
      // 2026-09-25): at the vendor default effort V4.1 Flash reasoned for
      // 50-54k CHARS on starter-chip drafts/critics and memory extraction —
      // past even the 16k floor — and answered EMPTY (finish_reason=length,
      // 6 in 24 h, each then served by the DashScope fallback WITHOUT
      // reasoning). Utility judgments need bounded reasoning, not a research
      // budget. UTILITY_THINKING_EFFORT low|high|max (default low; 'off' omits).
      ...(options?.thinking && utilityThinkingEffort() ? { reasoning_effort: utilityThinkingEffort() } : {}),
    }, {
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout,
    });
  } catch (err: any) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.response?.data?.message || '';
    throw new Error(`DeepSeek ${model} HTTP ${status || 'N/A'}: ${detail || err.message}`);
  }

  // OpenAI-compatible shape; DeepSeek also exposes reasoning_content alongside
  // content. Prefer content; fall back to reasoning_content if content empty
  // (happens when max_tokens cut off before content emerged).
  const msg = response.data?.choices?.[0]?.message ?? {};
  // Prefer the real answer. `reasoning_content` is DeepSeek's raw chain-of-thought — only use it as a
  // fallback for tasks that can tolerate it. NEVER for cosmetic one-liners (contentOnly): leaking the
  // reasoning surfaces raw "we need to craft a single casual sentence…" text to the user.
  const content = (msg.content && msg.content.length > 0)
    ? msg.content
    : (options?.contentOnly ? '' : (msg.reasoning_content ?? ''));
  return {
    content,
    model: response.data?.model || model,
    // Diagnostics for the caller's empty-content warn (utilityChat): distinguishes
    // "reasoning ate the budget" (finish_reason=length, long reasoning) from a
    // provider blank — reported once, on the existing warn line, not twice.
    finishReason: response.data?.choices?.[0]?.finish_reason ?? undefined,
    reasoningLength: typeof msg.reasoning_content === 'string' ? msg.reasoning_content.length : 0,
    usage: response.data?.usage ? {
      promptTokens:     response.data.usage.prompt_tokens     ?? 0,
      completionTokens: response.data.usage.completion_tokens ?? 0,
    } : undefined,
  };
}

/**
 * F3 (adversarial review 2026-09-15): throttled warn for a DEAD
 * 'utility_fallback' spec — the leg check runs on every utility call, so the
 * signal that the admin's custom outage leg no longer resolves must not spam.
 * The same string also reaches the total-failure telemetry via
 * lastCustomFallbackError on every call (metrics carry it, logs get this).
 */
const DEAD_FALLBACK_WARN_MS = 10 * 60 * 1000;
let lastDeadFallbackWarnAt = 0;
function warnDeadUtilityFallback(spec: string, fellBackTo: string): void {
  const now = Date.now();
  if (now - lastDeadFallbackWarnAt < DEAD_FALLBACK_WARN_MS) return;
  lastDeadFallbackWarnAt = now;
  logger.warn(`utilityChat: utility_fallback (${spec}) no longer resolves to an enabled, [coding]-flagged endpoint model (would silently fall back to ${fellBackTo}) — the custom outage leg is DEAD; reassign or clear the seat in Account → Admin → Endpoints → Model roles`);
}
/** Test hook — deterministic throttle state between unit tests. */
export function __resetDeadFallbackWarnForTests(): void { lastDeadFallbackWarnAt = 0; }

/**
 * Chat-completion convenience wrapper. Returns the text directly, or '' on
 * failure.
 *
 * LEG ORDER (2026-09-15 — the 'utility_fallback' role inserted the
 * admin-selectable middle leg):
 *   1. 'utility' model-role override (Digby Edge) — when set, tried FIRST;
 *   2. DeepSeek V4.1 Flash primary (skipped while the billing latch is hot);
 *   3. 'utility_fallback' model-role leg (Digby Edge) — a custom endpoint
 *      (e.g. a Nebius B300 node) that rides out a DeepSeek cloud outage
 *      BEFORE burning the last-resort leg;
 *   4. DashScope Qwen safety net;
 *   5. total failure → dual-outage streak telemetry + ticket.
 * Every custom leg fails OPEN: any error/empty answer falls through to the
 * next leg, never breaks the chain.
 */
export async function utilityChat(
  messages: Array<{ role: string; content: string }>,
  options?: {
    maxTokens?: number;
    temperature?: number;
    timeout?: number;
    /** When true, don't fall back to DeepSeek reasoning_content; let the DashScope (non-reasoning) fallback answer. */
    contentOnly?: boolean;
    /**
     * When true, retry the DeepSeek call (short backoff) on a "model not found"/404
     * before falling through to the DashScope fallback. Use for latency-tolerant
     * callers (e.g. post-synthesis follow-up generation) so the daily ~6am UTC
     * provider maintenance window doesn't silently drop their output. Default off
     * to keep latency-sensitive callers (e.g. live thinking-summary) fast.
     * 2026-06-20: Added to fix generateFollowUps 404s during the maintenance window.
     */
    retryNotFound?: boolean;
    /**
     * Opt-in reasoning on the DeepSeek leg (`thinking:{type:'enabled'}`). Default
     * false = today's no-thinking pin. Applies to the DeepSeek leg ONLY:
     *  - the DashScope fallback stays `enable_thinking:false` — Qwen3 thinking
     *    on DashScope is stream-only and this client is non-streaming, so an
     *    outage fallback must not carry an untested param (a 400 there would
     *    count toward the dual-provider OUTAGE alarm);
     *  - the Digby Edge 'utility' role override leg never forwards it — custom
     *    OpenAI-compatible servers may reject unknown params.
     * So an opted-in caller can be served UNREASONED by a fallback (logged) and
     * must keep its own deterministic + critic gates. See utilityLLM's option
     * doc for budget/contentOnly rules.
     */
    thinking?: boolean;
    /**
     * Diagnostics hook (2026-09-23): which provider leg answered and its finish
     * reason. Lets extraction callers stamp their outcome rows so a parse_error
     * is attributable (DeepSeek vs the DashScope fallback, length-truncated or
     * not) instead of a bare "could not parse". Never throws into the call.
     */
    onMeta?: (m: { leg: 'deepseek' | 'dashscope' | 'override'; model: string; finishReason?: string }) => void;
  },
): Promise<string> {
  // Digby Edge model-roles override: when the 'utility' role is set (a built-in
  // id or a '<label>:<modelId>' custom-endpoint spec), that model is tried
  // FIRST with the same non-streaming call shape; ANY failure falls through to
  // the built-in DeepSeek → DashScope chain below. Dynamic import + fail-open —
  // utility calls run on every background path and must survive a broken config.
  // Rollout watch tick 11 (2026-09-15): the owner's custom utility seat (a local
  // model) timed out on 221 calls in one hour yesterday and ~10/h tonight — each
  // one paid the full 30s before this fallback ran. A timeout / connection
  // failure / 5xx latches the override OFF for UTILITY_OVERRIDE_LATCH_MS (the
  // built-in chain serves directly, ONE warn), then it is retried. 4xx config
  // errors keep surfacing per call (they are fast and the operator must see them).
  try {
    if (utilityOverrideLatched()) throw UTILITY_OVERRIDE_LATCHED_SKIP;
    const { resolveRoleModel } = await import('../modules/crossmodel/model-endpoints/model-roles.service');
    const spec = await resolveRoleModel('utility');
    if (spec) {
      const { resolveProviderForRun } = await import('../modules/crossmodel/coding/coding-model');
      const p = await resolveProviderForRun(spec);
      // A colon spec that silently fell back to built-ins would double-call the
      // chain below — only use the override when it actually resolved.
      if (!spec.includes(':') || p.label.endsWith('(custom endpoint)')) {
        // Provider extras FIRST so the caller's own params win (a provider
        // default temperature must not clobber a caller's 0.5/0.6 — review
        // finding). Reasoning-shaped built-ins are rejected for this seat at
        // save time (model-roles NON_STREAMING_ROLES), so extras here are
        // benign defaults, never must-win contract params.
        const payload: any = {
          ...p.extra,
          model: p.model,
          messages,
          max_tokens: Math.max(options?.maxTokens || 512, DEEPSEEK_MIN_MAX_TOKENS),
          temperature: options?.temperature ?? 0.3,
        };
        for (const k of p.omitParams ?? []) delete payload[k];
        // Shared non-streaming path (2026-09-08): sends the thinking-off
        // directive to custom endpoints (tried once, latched off on a 4xx) and
        // strips closed AND unclosed <think> blocks — a default-thinking custom
        // Qwen used to hand titles/follow-ups raw reasoning or nothing at all.
        const { postNonStreamingCompletion, extractNonStreamingAnswer } = await import('../modules/crossmodel/coding/helper-completion');
        const resp = await postNonStreamingCompletion(p, payload, { timeout: options?.timeout || 20000 });
        const choice = resp.data?.choices?.[0];
        const answer = extractNonStreamingAnswer(choice);
        // contentOnly callers never accept reasoning as the answer; others keep
        // the legacy reasoning_content fallback when the model wrote no prose.
        const oContent = answer.text || (options?.contentOnly ? '' : String(choice?.message?.reasoning_content ?? ''));
        if (oContent) {
          noteUtilityChatSuccess();
          // FO firing 47: the override answered — reset the backoff streak so a
          // healthy seat is never penalized for one blip (and a recovered seat
          // returns to the short 5-min window on its next outage).
          utilityOverrideStreak = 0;
          // FO firing 46 (2026-09-29): this was the ONLY leg that returned
          // without onMeta — with the admin's Edge utility seat serving prod
          // (firing 45's root cause sat on this leg), every project_brief
          // outcome row landed leg=null and the budget telemetry was
          // unattributable. Same diagnostics shape as the other three legs.
          try { options?.onMeta?.({ leg: 'override', model: p.model, finishReason: choice?.finish_reason ?? undefined }); } catch { /* diagnostics never break the call */ }
          return oContent;
        }
        logger.warn(`utilityChat: utility role override (${spec}) returned empty content — falling back to the built-in chain`, { source: 'utility-override' });
      }
    }
  } catch (err: any) {
    if (err !== UTILITY_OVERRIDE_LATCHED_SKIP) {
      const status: number | undefined = err?.response?.status;
      const msg = String(err?.message ?? '');
      const unreachable = (typeof status === 'number' && status >= 500) || UTILITY_OVERRIDE_UNREACHABLE_RE.test(msg);
      if (unreachable && !utilityOverrideLatched()) {
        // FO firing 47: escalating backoff — a flat 5-min window re-paid the
        // full caller timeout every 5 min through a sustained outage.
        latchUtilityOverrideOff(status, msg);
      } else if (!unreachable) {
        logger.warn(`utilityChat: utility role override failed (${status || msg}) — falling back to the built-in chain`, { source: 'utility-override' });
      }
    }
  }
  // Last error string per provider leg — the outage alarm/telemetry attaches
  // them so an operator reads the failure shape without grepping logs.
  let lastDeepseekError = '';
  let lastCustomFallbackError = '';
  let lastDashscopeError = DASHSCOPE_API_KEY ? '' : 'DashScope: DASHSCOPE_API_KEY not set (fallback unavailable)';
  // Up to 2 extra DeepSeek attempts on model-not-found when retryNotFound is set.
  // Short backoff (1.5s, 3s) — the maintenance window is typically 30-60s and this
  // runs off the user's critical path. Non-not-found errors break out immediately.
  const maxNotFoundRetries = options?.retryNotFound ? 2 : 0;
  const skipPrimary = deepseekBillingLatched();
  if (skipPrimary) lastDeepseekError = `DeepSeek ${DEEPSEEK_UTILITY_MODEL}: skipped — billing/auth latch active (recent HTTP 402/401/403)`;
  for (let attempt = 0; !skipPrimary && attempt <= maxNotFoundRetries; attempt++) {
    try {
      const result = await utilityLLM(
        messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        options,
      );
      if (result.content) {
        noteUtilityChatSuccess();
        try { options?.onMeta?.({ leg: 'deepseek', model: DEEPSEEK_UTILITY_MODEL, finishReason: result.finishReason }); } catch { /* diagnostics never break the call */ }
        return result.content;
      }
      // Reasoning ate the whole budget (iteration 13): finish_reason=length
      // with a long reasoning_content and no answer. Retry ONCE on the SAME
      // model with thinking OFF before leaving the primary — a fast,
      // deterministic answer from the utility seat beats the DashScope
      // fallback, which also serves such calls unreasoned (its own warn).
      if (options?.thinking && result.finishReason === 'length' && (result.reasoningLength ?? 0) > 0) {
        logger.warn(`utilityChat: DeepSeek ${DEEPSEEK_UTILITY_MODEL} reasoning exhausted the budget (finish_reason=length, reasoning_len=${result.reasoningLength}, maxTokens=${options?.maxTokens ?? 'default'}) — retrying once with thinking OFF on the same model`);
        try {
          const plain = await utilityLLM(
            messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
            { ...options, thinking: false },
          );
          if (plain.content) {
            noteUtilityChatSuccess();
            try { options?.onMeta?.({ leg: 'deepseek', model: DEEPSEEK_UTILITY_MODEL, finishReason: plain.finishReason }); } catch { /* diagnostics never break the call */ }
            return plain.content;
          }
        } catch (retryErr: any) {
          logger.warn(`utilityChat: thinking-off retry failed (${retryErr?.response?.status || retryErr?.message}) — trying DashScope fallback`);
        }
      }
      // empty content → fall through to DashScope
      lastDeepseekError = `DeepSeek ${DEEPSEEK_UTILITY_MODEL}: returned empty content (finish_reason=${result.finishReason ?? 'unknown'})`;
      noteLegError('deepseek', lastDeepseekError);
      logger.warn(`utilityChat: DeepSeek ${DEEPSEEK_UTILITY_MODEL} returned empty content (finish_reason=${result.finishReason ?? 'unknown'}, reasoning_len=${result.reasoningLength ?? 0}, thinking=${!!options?.thinking}, maxTokens=${options?.maxTokens ?? 'default'}), trying DashScope fallback`);
      break;
    } catch (err: any) {
      const status = err.response?.status || 'N/A';
      const errMsg = String(err.message || '').toLowerCase();
      const isModelNotFound =
        status === 404 ||
        errMsg.includes('http 404') ||
        errMsg.includes('model not found') ||
        errMsg.includes('not_found');
      if (isModelNotFound && attempt < maxNotFoundRetries) {
        const delay = 1500 * (attempt + 1);
        logger.warn(`utilityChat: DeepSeek ${DEEPSEEK_UTILITY_MODEL} model-not-found (attempt ${attempt + 1}/${maxNotFoundRetries + 1}), retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      lastDeepseekError = `DeepSeek ${DEEPSEEK_UTILITY_MODEL} (HTTP ${status}): ${String(err.message).slice(0, 300)}`;
      noteLegError('deepseek', lastDeepseekError);
      logger.warn(`utilityChat: DeepSeek ${DEEPSEEK_UTILITY_MODEL} failed (HTTP ${status}): ${err.message}`);
      // utilityLLM rethrows the provider error as `DeepSeek <model> HTTP 402: …`
      // (response.status is gone by then — prod logs read "HTTP N/A"), so the
      // status is recovered from the message when the response is absent.
      const billingStatus = typeof status === 'number' ? status : Number((errMsg.match(/\bhttp (40[123])\b/) || [])[1]) || 0;
      if (BILLING_AUTH_STATUSES.has(billingStatus) && !deepseekBillingLatched()) {
        deepseekBillingLatchUntil = Date.now() + DEEPSEEK_BILLING_LATCH_MS;
        logger.warn(`utilityChat: DeepSeek answered HTTP ${billingStatus} (billing/auth — not transient); skipping the DeepSeek leg for ${DEEPSEEK_BILLING_LATCH_MS / 60000} min, DashScope ${DASHSCOPE_FALLBACK_MODEL} serves utility calls directly. Owner action: top up / re-key DeepSeek.`);
        noteDeepseekBillingOutage(billingStatus, String(err.message));
      }
      break;
    }
  }

  // ── Digby Edge 'utility_fallback' role: the admin-selectable MIDDLE leg ────
  // Set to a custom endpoint (e.g. a Nebius B300 node) to ride out a DeepSeek
  // outage (billing/HTTP 402) BEFORE burning the DashScope safety net. Same
  // non-streaming call shape, payload contract, and fail-open semantics as the
  // 'utility' override leg above: provider extras first so the caller's params
  // win, omitParams stripped, the max_tokens floor, thinking-off handled inside
  // postNonStreamingCompletion, <think>-stripping inside
  // extractNonStreamingAnswer. ANY failure/empty answer falls through to
  // DashScope — a broken config can never break the chain.
  try {
    // Owner 2026-09-15: the retired 'utility_fallback' ROLE is now the utility
    // seat's CUSTOM FALLBACK slot (Account → Admin → Endpoints → Model roles →
    // Utility → "Add custom fallback"); legacy stored rows migrate on read.
    const { resolveRoleFallback } = await import('../modules/crossmodel/model-endpoints/model-roles.service');
    const fbSpec = await resolveRoleFallback('utility');
    if (fbSpec && !fbSpec.includes(':')) {
      // F1 (adversarial review 2026-09-15): a BUILT-IN id on this seat always
      // duplicates a chain leg — DeepSeek just failed (or is billing-latched,
      // and re-calling it here would hammer the 402ing provider every call
      // that the latch exists to rest), and 'qwen3.6-27b' IS the DashScope
      // safety net below. Save-time validation now refuses built-ins for this
      // seat (model-roles.service assertAssignable); this skip covers configs
      // stored before that gate. Straight to the safety net.
      logger.info(`utilityChat: utility_fallback (${fbSpec}) is a built-in chain leg — skipping to the DashScope safety net`);
    } else if (fbSpec) {
      const { resolveProviderForRun } = await import('../modules/crossmodel/coding/coding-model');
      const p = await resolveProviderForRun(fbSpec);
      // Same guard as the override leg: a colon spec that silently fell back
      // to built-ins would double-call the chain — skip it.
      if (p.label.endsWith('(custom endpoint)')) {
        const payload: any = {
          ...p.extra,
          model: p.model,
          messages,
          max_tokens: Math.max(options?.maxTokens || 512, DEEPSEEK_MIN_MAX_TOKENS),
          temperature: options?.temperature ?? 0.3,
        };
        for (const k of p.omitParams ?? []) delete payload[k];
        const { postNonStreamingCompletion, extractNonStreamingAnswer } = await import('../modules/crossmodel/coding/helper-completion');
        const resp = await postNonStreamingCompletion(p, payload, { timeout: options?.timeout || 20000 });
        const choice = resp.data?.choices?.[0];
        const answer = extractNonStreamingAnswer(choice);
        // contentOnly callers never accept reasoning as the answer; others keep
        // the legacy reasoning_content fallback when the model wrote no prose.
        const fbContent = answer.text || (options?.contentOnly ? '' : String(choice?.message?.reasoning_content ?? ''));
        if (fbContent) {
          logger.info(`utilityChat: utility_fallback role (${fbSpec}) succeeded`);
          noteUtilityChatSuccess();
          try { options?.onMeta?.({ leg: 'override', model: p.model, finishReason: choice?.finish_reason ?? undefined }); } catch { /* diagnostics never break the call */ }
          return fbContent;
        }
        lastCustomFallbackError = `utility_fallback (${fbSpec}): returned empty content`;
        noteCustomLegError(lastCustomFallbackError);
        logger.warn(`utilityChat: utility_fallback role (${fbSpec}) returned empty content — falling back to the DashScope safety net`);
      } else {
        // F3 (adversarial review 2026-09-15): a DEAD custom spec (endpoint
        // deleted/disabled/renamed) used to skip with ZERO signal — the
        // admin's outage protection gone, visible only on the roles page's
        // resolves badge. Name it in the total-failure telemetry and warn
        // (throttled — this check runs on every utility call).
        lastCustomFallbackError = `utility_fallback (${fbSpec}): no longer resolves to an enabled, [coding]-flagged endpoint model — custom outage leg skipped (would silently fall back to ${p.model})`;
        noteCustomLegError(lastCustomFallbackError);
        warnDeadUtilityFallback(fbSpec, p.model);
      }
    }
  } catch (err: any) {
    lastCustomFallbackError = `utility_fallback (HTTP ${err?.response?.status || 'N/A'}): ${String(err?.message || err).slice(0, 300)}`;
    noteCustomLegError(lastCustomFallbackError);
    logger.warn(`utilityChat: utility_fallback leg failed (${err?.response?.status || err?.message}) — falling back to the DashScope safety net`);
  }

  if (DASHSCOPE_API_KEY) {
    // 2026-07-13: honor retryNotFound on the DashScope fallback too. Previously the
    // retry-on-404 backoff only guarded the PRIMARY (DeepSeek) call — if the daily
    // ~6am UTC provider-maintenance window happened to hit DashScope (or its
    // configured utility model ID was momentarily 404ing), the fallback failed once
    // and follow-ups/titles silently degraded to empty. The fallback exists precisely
    // to cover a primary outage, so it deserves the same brief 404 retry.
    const fallbackModel = (options?.timeout && options.timeout <= FAST_FALLBACK_TIMEOUT_THRESHOLD_MS)
      ? DASHSCOPE_FAST_FALLBACK_MODEL
      : DASHSCOPE_FALLBACK_MODEL;
    const maxFbNotFoundRetries = options?.retryNotFound ? 2 : 0;
    for (let fbAttempt = 0; fbAttempt <= maxFbNotFoundRetries; fbAttempt++) {
      try {
        const fbResult = await axios.post(DASHSCOPE_BASE_URL, {
          model: fallbackModel,
          messages,
          max_tokens: options?.maxTokens || 512,
          temperature: options?.temperature ?? 0.3,
          // 2026-09-04: qwen3.* on DashScope also reasons by default in
          // non-streaming mode — the 25s briefing fallback timed out purely on
          // thinking. ALWAYS off here — even for options.thinking callers (Qwen3
          // thinking on DashScope is stream-only; see the option doc).
          enable_thinking: false,
        }, {
          headers: { Authorization: `Bearer ${DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: (options?.timeout || 15000),
        });
        const fbMsg = fbResult.data?.choices?.[0]?.message ?? {};
        // Honor contentOnly here too: the DashScope fallback model is normally
        // non-reasoning, but if it ever returns reasoning_content with empty
        // content we must NOT leak that raw chain-of-thought to contentOnly
        // callers (follow-ups, titles, status lines). Return '' so they degrade
        // gracefully instead of surfacing meta-reasoning.
        const fbContent = (fbMsg.content && fbMsg.content.length > 0)
          ? fbMsg.content
          : (options?.contentOnly ? '' : (fbMsg.reasoning_content || ''));
        if (fbContent) {
          logger.info(`utilityChat: DashScope fallback (${fallbackModel}) succeeded`);
          if (options?.thinking) logger.warn(`utilityChat: fallback (${fallbackModel}) served a thinking:true call WITHOUT reasoning — caller gates must hold`);
          noteUtilityChatSuccess();
          try { options?.onMeta?.({ leg: 'dashscope', model: fallbackModel, finishReason: fbResult.data?.choices?.[0]?.finish_reason ?? undefined }); } catch { /* diagnostics never break the call */ }
          return fbContent;
        }
        lastDashscopeError = `DashScope ${fallbackModel}: returned empty content`;
        noteLegError('dashscope', lastDashscopeError);
        break; // empty content is not a retryable condition
      } catch (fbErr: any) {
        const fbStatus = (fbErr as any).response?.status || 'N/A';
        const fbMsgLower = String(fbErr.message || '').toLowerCase();
        const fbNotFound =
          fbStatus === 404 ||
          fbMsgLower.includes('status code 404') ||
          fbMsgLower.includes('model not found') ||
          fbMsgLower.includes('not_found');
        if (fbNotFound && fbAttempt < maxFbNotFoundRetries) {
          const delay = 1500 * (fbAttempt + 1);
          logger.warn(`utilityChat: DashScope fallback (${fallbackModel}) model-not-found (attempt ${fbAttempt + 1}/${maxFbNotFoundRetries + 1}), retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        lastDashscopeError = `DashScope ${fallbackModel} (HTTP ${fbStatus}): ${String(fbErr.message).slice(0, 300)}`;
        noteLegError('dashscope', lastDashscopeError);
        logger.warn(`utilityChat: DashScope fallback also failed (HTTP ${fbStatus}): ${fbErr.message}`);
        break;
      }
    }
  }

  // Total failure — every leg failed (or was unconfigured) on this call.
  noteUtilityChatTotalFailure(
    `timeout=${options?.timeout ?? 'default'} contentOnly=${!!options?.contentOnly} retryNotFound=${!!options?.retryNotFound} maxTokens=${options?.maxTokens ?? 'default'} thinking=${!!options?.thinking}`,
    [lastDeepseekError || (DEEPSEEK_API_KEY ? 'DeepSeek: no error recorded' : 'DeepSeek: DEEPSEEK_API_KEY not set'), lastCustomFallbackError, lastDashscopeError].filter(Boolean),
  );
  return '';
}

/**
 * Clean a cosmetic one-line status/commentary string before it's shown to the user.
 * Strips reasoning (<think> blocks), keeps the final line if the model reasoned first, removes
 * surrounding quotes, and REJECTS (returns '') anything that is obviously the model's meta-reasoning
 * or a prompt echo — so a raw "We need to craft a single casual sentence, max 20 words…" never leaks.
 * On rejection the caller falls back to its default rotating status.
 */
export function sanitizeStatusLine(s: string): string {
  if (!s) return '';
  let t = s
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
  // Models often reason across several lines then give the answer last — keep the last non-empty line.
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) t = lines[lines.length - 1];
  t = t.replace(/^["'`*]+|["'`*]+$/g, '').trim();
  // Reject meta-reasoning / prompt echoes.
  if (/\b(we need to|let me|i should|i'?ll|i will|the user (just )?(asked|wants)|craft|one (casual )?sentence|single (casual )?sentence|max \d+ words|describing what'?s about|write one)\b/i.test(t)) {
    return '';
  }
  if (t.length < 2 || t.length > 180) return '';
  return t;
}

/**
 * Summarize a chunk of AI reasoning into a one-sentence label for the live
 * thinking-summary UI. Tight latency budget (3s) since this fires in the SSE
 * progress channel. Uses contentOnly so DeepSeek's raw reasoning never leaks, and
 * sanitizeStatusLine as a final guard.
 */
export async function summarizeReasoning(modelLabel: string, reasoningText: string): Promise<string> {
  const snippet = reasoningText.substring(0, 500);
  try {
    const raw = await utilityChat(
      [{ role: 'user', content: `In ≤15 words, summarize what this AI is thinking about. Be specific to the topic:\n\n${modelLabel}: "${snippet}"` }],
      { maxTokens: 256, temperature: 0.3, timeout: 4000, contentOnly: true },
    );
    return sanitizeStatusLine(raw);
  } catch {
    return '';
  }
}

export const UTILITY_MODEL_NAME = DEEPSEEK_UTILITY_MODEL;

// Latched presence of a 'utility'/'utility_fallback' model-role override (Digby
// Edge): the gate below must stay SYNC (8 call sites use it as a plain boolean
// guard), so the override check is a self-refreshing latch — each gate call
// kicks an async refresh for the NEXT call, and utilityChat's own override leg
// keeps it warm.
// Cold-start worst case: the very first gate call on a keyless Edge box says
// "unavailable" once, then converges.
let utilityOverrideLatch = false;
let utilityOverrideCheckedAt = 0;
function refreshUtilityOverrideLatch(): void {
  const now = Date.now();
  if (now - utilityOverrideCheckedAt < 30_000) return;
  utilityOverrideCheckedAt = now;
  void import('../modules/crossmodel/model-endpoints/model-roles.service')
    // A configured 'utility_fallback' leg also counts as availability (2026-09-15):
    // on a DeepSeek outage with no DashScope key it is the ONLY serving leg.
    .then(async (m) => { utilityOverrideLatch = Boolean(await m.resolveRoleModel('utility')) || Boolean(await m.resolveRoleFallback('utility')); })
    .catch(() => { /* config unavailable → latch unchanged */ });
}

/**
 * True if any utility-LLM backend is configured. utilityChat() uses DeepSeek as
 * primary and falls back to DashScope, so callers gating on DEEPSEEK_API_KEY
 * alone would wrongly skip work when only DASHSCOPE_API_KEY is set. Use this
 * instead of a bare `process.env.DEEPSEEK_API_KEY` check. A configured
 * 'utility' or 'utility_fallback' model-role override also counts (latched —
 * see above).
 */
export function isUtilityLLMAvailable(): boolean {
  refreshUtilityOverrideLatch();
  return Boolean(DEEPSEEK_API_KEY || DASHSCOPE_API_KEY || utilityOverrideLatch);
}

/**
 * STRUCTURALLY unconfigured utility chain (2026-10-26, the digby.cql.ca Edge
 * outage): no built-in key (DEEPSEEK_API_KEY / DASHSCOPE_API_KEY) AND no
 * 'utility' seat override or custom fallback. Callers use this to give a
 * TERMINAL "not configured" answer instead of a degrade-forever loop —
 * retrying cannot succeed because the missing piece is configuration, not a
 * transient provider outage (GET /news + the news scheduler; suggested
 * questions the same shape).
 *
 * Async where isUtilityLLMAvailable is sync: the seat check reads the admin
 * config. Fail-open per call (a resolution error returns false — never
 * reclassify a configured instance as unconfigured on a transient read).
 */
export async function utilityChainUnconfigured(): Promise<boolean> {
  if (DEEPSEEK_API_KEY || DASHSCOPE_API_KEY) return false;
  refreshUtilityOverrideLatch();
  if (utilityOverrideLatch) return false;
  try {
    const { resolveRoleModel, resolveRoleFallback } = await import('../modules/crossmodel/model-endpoints/model-roles.service');
    return !(await resolveRoleModel('utility')) && !(await resolveRoleFallback('utility'));
  } catch {
    return false; // fail-open — config read failed; treat as configured
  }
}

export default { utilityLLM, utilityChat, summarizeReasoning, sanitizeStatusLine, isUtilityLLMAvailable };
