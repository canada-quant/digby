/**
 * Digby Web Search — BrightData MCP Tools
 *
 * Calls BrightData tools via the self-hosted MCP gateway at mcp.digby.ai.
 *
 * Transport: MCP Streamable HTTP (POST) — MCP spec 2025-03-26
 *   - POST to /mcp with JSON-RPC 2.0 body
 *   - Server responds with Content-Type: text/event-stream (SSE)
 *   - Response events carry the JSON-RPC result as `data: {...}`
 *   - Stream stays open; we close it after receiving the matching ID
 *
 * Auth: X-API-Key header
 * Env:  MCP_DIGBY_TOKEN — API key for the MCP gateway
 *       MCP_DIGBY_URL / MCP_DIGBY_HEALTH_URL — override gateway URLs (self-host)
 *
 * Tools used (65 BrightData Pro Mode tools available):
 *   - search_engine    : Google/Bing/Yandex SERP results (was brightdata_search_engine on old server)
 *   - scrape_as_markdown: Scrape a single URL → Markdown (was brightdata_scrape_as_markdown)
 *   - scrape_batch     : Scrape multiple URLs → Markdown array (was brightdata_scrape_batch)
 *
 * Note: New server uses short tool names (no brightdata_ prefix).
 *
 * Used by Open Source models (GLM-5.2, Kimi K3, DeepSeek V4 Flash/Pro) for web search.
 * Frontier models use their own native web search capabilities.
 *
 * Health check: https://mcp.digby.ai/health (no auth needed) → "ok"
 *
 * Returns formatted context strings, or empty string on failure (graceful degradation).
 */

import axios from 'axios';
import logger from '../../utils/logger';
import { tryDirectBrightData, directBrightDataAvailable, noteStoreCredsForAvailability, DirectEmptyBodyError, DirectUnfetchableTargetError, unfetchableGuidance, type DirectMissInfo } from './brightdata-direct';
import { extractPdfText } from './pdf-extract';
// serp-provider-guard is a PURE leaf (zero imports) — safe to import here without
// touching any partial-factory mock contract on this module (module-mock rule).
import { serpProviderErrorDetail, SerpProviderErrorBodyError, type SerpCallOpts } from './serp-provider-guard';
import { unwrapSerpJsonText } from './serp-redirects';
import { isProdInstance } from './platform/instance-targets';
// MCP wire sessions (ticket 5f69fdc4): the gateway holds ONE stdio child —
// hence ONE BrightData browser — per Mcp-Session-Id, so the client must carry
// the id across calls or every tools/call lands on a fresh, blank browser.
import { mcpSessions, type McpSessionHeaders } from './mcp-session';

// Updated URL: new server at /mcp path (MCP Streamable HTTP transport)
// Env-overridable for self-hosted instances (which may run their own gateway or
// disable web search); the production default (mcp.digby.ai) applies ONLY on the
// production instance (DIGBY_INSTANCE unset / 'prod'). A self-host that sets an
// invented MCP_DIGBY_TOKEN but forgets MCP_DIGBY_URL used to POST that token to
// production on every search (401 → ~14 s of retries → "the gateway is
// recovering" forever); now the gateway tier is simply OFF there, and the
// instance setup page names the missing MCP_DIGBY_URL (platform/instance-setup.ts).
const MCP_DIGBY_URL   = process.env.MCP_DIGBY_URL || (isProdInstance() ? 'https://mcp.digby.ai/mcp' : '');
const MCP_DIGBY_TOKEN = process.env.MCP_DIGBY_TOKEN;
/**
 * The STATEFUL mount for interactive cloud browsing (ticket 5f69fdc4).
 *
 * The gateway runs TWO supergateways: `/mcp` stays stateless (byte-identical to
 * the pre-fix behaviour, so search/scrape AND the x-mcp service — a live
 * session-less client — are unaffected), and `/browser/mcp` is `--stateful`,
 * holding ONE stdio child (hence ONE BrightData browser) per Mcp-Session-Id.
 * Measured on supergateway 4.2.1: a stateful instance answers a session-less
 * POST with 400 "No valid session ID provided", which is exactly why this is a
 * separate path rather than a flag on the shared one.
 *
 * Derived from MCP_DIGBY_URL (…/mcp → …/browser/mcp) so a self-host that points
 * the gateway elsewhere gets the right mount; MCP_DIGBY_BROWSER_URL wins if set.
 */
const MCP_DIGBY_BROWSER_URL = process.env.MCP_DIGBY_BROWSER_URL
  || (MCP_DIGBY_URL ? MCP_DIGBY_URL.replace(/\/mcp\/?$/, '/browser/mcp') : '');

/** Gateway target for MCP-session lifecycle calls (initialize/release) — ticket 5f69fdc4. */
export const mcpGatewayTarget = (): { url: string; token: string } => ({ url: MCP_DIGBY_URL, token: MCP_DIGBY_TOKEN || '' });

/** The STATEFUL gateway target the interactive cloud browser must use (ticket 5f69fdc4). */
export const mcpBrowserGatewayTarget = (): { url: string; token: string } => ({
  url: MCP_DIGBY_BROWSER_URL || MCP_DIGBY_URL,
  token: MCP_DIGBY_TOKEN || '',
});

// When an injected one-shot search comes back EMPTY, callers append this to the
// system context. Without it, models that know they "always have web search"
// (platform identity) narrate a phantom search and stop — prod 2026-07-13: GLM's
// entire L2 draft was "I'll search for Satya Nadella's public LinkedIn profile
// information right now." (78 chars) because its injected search returned ''.
export const SEARCH_UNAVAILABLE_NOTE = `[WEB SEARCH UNAVAILABLE THIS TURN]
Live web search returned no results for this query (transient infrastructure issue). You cannot run another search this turn. Answer NOW from your existing knowledge and the conversation context: give your best complete answer, flag any fast-changing facts as possibly outdated, and do NOT say you will search, look something up, or wait.`;

// ── Gateway Health Check ──────────────────────────────────────────────────────
// Before the first tool call in a process lifetime (or after a long gap), ping
// the /health endpoint to verify the MCP gateway is reachable. If it is not,
// set _gatewayUnhealthy=true and skip all tool calls until the next probe window.
// This prevents burning all retries on a dead connection.
const HEALTH_CHECK_URL        = process.env.MCP_DIGBY_HEALTH_URL || (MCP_DIGBY_URL ? MCP_DIGBY_URL.replace(/\/mcp\/?$/, '/health') : '');
const HEALTH_CHECK_TIMEOUT_MS = 5000;  // 5s — fast fail
const HEALTH_PROBE_INTERVAL   = 60 * 1000; // re-probe every 60s after a failure
/** One "gateway tier is OFF" warn per process (an unconfigured self-host used to warn per call). */
let _warnedGatewayUnconfigured = false;

let _gatewayUnhealthy  = false;
let _lastHealthProbeAt = 0;
let _healthCheckInFlight = false;

/**
 * Lightweight gateway health check — pings /health (no auth required).
 * Sets _gatewayUnhealthy flag to skip tool calls when the gateway is down.
 * Non-blocking: called before the first tool call attempt.
 */
async function ensureGatewayHealthy(): Promise<boolean> {
  // If we already know it's healthy (no prior failure), skip the probe
  if (!_gatewayUnhealthy && _lastHealthProbeAt === 0) {
    // First call ever — do a quick probe to establish baseline
    _lastHealthProbeAt = Date.now();
  } else if (!_gatewayUnhealthy) {
    // Gateway was healthy last time we checked — trust it
    return true;
  }

  // Gateway was unhealthy — check if enough time has passed to re-probe
  if (_gatewayUnhealthy && Date.now() - _lastHealthProbeAt < HEALTH_PROBE_INTERVAL) {
    logger.warn(`Digby Web Search: gateway unhealthy — skipping tool call (next probe in ${Math.ceil((HEALTH_PROBE_INTERVAL - (Date.now() - _lastHealthProbeAt)) / 1000)}s)`, { source: 'web-search' });
    return false;
  }

  // Prevent concurrent health checks
  if (_healthCheckInFlight) return !_gatewayUnhealthy;
  _healthCheckInFlight = true;
  _lastHealthProbeAt = Date.now();

  try {
    const resp = await axios.get(HEALTH_CHECK_URL, { timeout: HEALTH_CHECK_TIMEOUT_MS });
    if (resp.status === 200) {
      if (_gatewayUnhealthy) {
        logger.info('Digby Web Search: gateway health check PASSED — resuming tool calls');
      }
      _gatewayUnhealthy = false;
      return true;
    }
    throw new Error(`Unexpected health check status: ${resp.status}`);
  } catch (err: any) {
    _gatewayUnhealthy = true;
    logger.warn(`Digby Web Search: gateway health check FAILED — disabling tool calls for ${HEALTH_PROBE_INTERVAL / 1000}s: ${err.message}`, { source: 'web-search' });
    return false;
  } finally {
    _healthCheckInFlight = false;
  }
}

// ── Circuit Breaker — prevents hammering a degraded MCP gateway ───────────────
// Production logs show repeated search_engine + scrape_batch failures that exhaust
// all retries on every query when the BrightData MCP gateway is recycling workers.
// The circuit breaker cuts off requests to a failing tool after consecutive
// failures, then allows one probe call (half-open) to test recovery.
// Tuning: 5 failures / 90s cooldown balances protection against hammering a dead
// service vs. keeping web search available for users asking real-time questions.
// Previous: 3 failures / 5min was too aggressive — users lost web search for too long.
interface CircuitState {
  failures: number;
  lastFailureAt: number;
  openUntil: number;
}
const _mcpCircuit = new Map<string, CircuitState>();
const CIRCUIT_FAIL_THRESHOLD = 5;              // increased from 3 — external services are flaky
const CIRCUIT_RESET_MS       = 90 * 1000;      // 90 seconds (reduced from 2min — faster recovery)

function isCircuitOpen(toolName: string): boolean {
  const state = _mcpCircuit.get(toolName);
  if (!state || state.failures < CIRCUIT_FAIL_THRESHOLD) return false;
  if (Date.now() > state.openUntil) {
    // Circuit expired — reset and allow probe call (half-open transition)
    _mcpCircuit.delete(toolName);
    logger.info(`Digby Web Search: circuit reset for ${toolName} — allowing probe call`);
    return false;
  }
  const remainingSec = Math.ceil((state.openUntil - Date.now()) / 1000);
  logger.warn(`Digby Web Search: circuit OPEN for ${toolName} — skipping (resets in ${remainingSec}s)`, { source: 'web-search', tool: toolName });
  return true;
}

/**
 * True when the web tools are currently DEGRADED — the gateway health probe is
 * failing, or a tool's circuit breaker is open. Lets callers tell the model
 * "web search is temporarily unavailable" (a transient infra state) instead of
 * "no results found" (which the model wrongly reads as "the topic has no results"
 * and gives up — exactly what happened when the MCP gateway 502'd mid-session).
 */
export function webToolsDegraded(): boolean {
  if (_gatewayUnhealthy) return true;
  const now = Date.now();
  for (const s of _mcpCircuit.values()) {
    if (s.failures >= CIRCUIT_FAIL_THRESHOLD && now < s.openUntil) return true;
  }
  return false;
}

function recordCircuitSuccess(toolName: string): void {
  if (_mcpCircuit.has(toolName)) {
    logger.info(`Digby Web Search: circuit CLOSED for ${toolName} — recovery confirmed`);
    _mcpCircuit.delete(toolName);
  }
}

function recordCircuitFailure(toolName: string): void {
  const state = _mcpCircuit.get(toolName) || { failures: 0, lastFailureAt: 0, openUntil: 0 };
  // Reset failure count if last failure was > 2× reset window ago (stale failures)
  if (Date.now() - state.lastFailureAt > CIRCUIT_RESET_MS * 2) {
    state.failures = 0;
  }
  state.failures++;
  state.lastFailureAt = Date.now();
  if (state.failures >= CIRCUIT_FAIL_THRESHOLD) {
    state.openUntil = Date.now() + CIRCUIT_RESET_MS;
    logger.warn(
          `Digby Web Search: circuit OPENED for ${toolName} after ${state.failures} failures ` +
          `— cooling down ${CIRCUIT_RESET_MS / 1000}s`,
          { source: 'web-search', tool: toolName }
        );
  }
  _mcpCircuit.set(toolName, state);
}

// ── MCP tool call helper — handles SSE streaming response ─────────────────────
//
// The MCP Streamable HTTP transport (2025-03-26 spec) responds to POST requests
// with Content-Type: text/event-stream. The JSON-RPC response arrives as:
//
//   data: {"jsonrpc":"2.0","result":{...},"id":1}\n\n
//
// The connection stays open indefinitely. We read until we find our matching
// message ID, then destroy the stream.

// The three hot tools go DIRECT-FIRST to BrightData REST (flipped 2026-07-15;
// failover-only since 2026-07-14): every outage so far was OUR gateway
// plumbing, never BrightData, and the direct call also skips a network hop.
const DIRECT_FAILOVER_TOOLS = new Set(['search_engine', 'scrape_as_markdown', 'scrape_batch']);

/** Ceiling for an in-loop retry wait bumped to a provider-stated minimum
 *  (ticket ca805a61): matches the retry loop's own max backoff (2s→4s→8s) so a
 *  stated wait can never park an interactive call longer than the loop's own
 *  budget; a stated wait ABOVE this takes the gateway tier's fail-fast return
 *  instead. */
const SERP_PROVIDER_RETRY_WAIT_CAP_MS = 8000;

/** The D3 fail-fast / resume decision, as ONE pure function (WRP-1 D3-R,
 *  2026-11-03). Extracted so the arithmetic that decides whether a stated
 *  throttle is waited out or fail-fasted is pinnable without burning the
 *  provider's real 60 s period in a test.
 *
 *  - `failFast` for a DETERMINISTIC class always (the same query fails the same
 *    way — retrying is pure latency).
 *  - `failFast` for a stated wait beyond the cap UNLESS the caller passed a
 *    resume budget that still covers it. That second half is the whole point:
 *    `cap` protects the INTERACTIVE caller (no budget ⇒ budgetMs 0 ⇒
 *    resumeWorthIt false ⇒ any stated wait > 8 s fails fast, ca805a61 intact),
 *    while a long-budget caller (web_pipe) resumes. */
export function serpResumeDecision(input: {
  retryable: boolean;
  statedWaitMs: number;
  /** The caller's total resume budget (0 = none — the interactive default). */
  budgetMs: number;
  /** The caller's fixed resume deadline (Date.now() + budgetMs at tier entry). */
  resumeDeadline: number;
  now?: number;
}): { resumeWorthIt: boolean; failFast: boolean } {
  const statedWaitMs = input.statedWaitMs > 0 ? input.statedWaitMs : 0;
  const resumeWorthIt = input.budgetMs > 0
    && input.retryable
    && (input.now ?? Date.now()) + statedWaitMs <= input.resumeDeadline;
  const failFast = !input.retryable
    || (statedWaitMs > SERP_PROVIDER_RETRY_WAIT_CAP_MS && !resumeWorthIt);
  return { resumeWorthIt, failFast };
}

// ── Hedged gateway (autonomy loop #7, 2026-09-19) ─────────────────────────────
// Box C, 16:07–20:07Z: the DIRECT tier timed out 67 times (55 scrapes at 45 s,
// 12 searches at 60 s — 24% / 13% of its calls) and only THEN fell to the
// gateway, which mostly answered: ~55 minutes of lane wall-clock spent waiting
// on a tier that had already lost. The hedged-request pattern (Dean & Barroso,
// "The Tail at Scale"): when the direct call has not answered within
// WEB_HEDGE_MS, START the gateway call in parallel and take the first useful
// result; the direct call keeps its full timeout and still wins when it lands
// first. A direct result that is deterministically empty (PDF / blocked /
// JS-shell) still short-circuits to null and the hedge is ignored (#85). Only
// the single-target hot tools hedge — scrape_batch legitimately takes longer.
// Metric web_fetch_path per direct-tier call. Kill switch WEB_HEDGE_DISABLED=1;
// WEB_HEDGE_MS overrides the 12 s trigger.
const HEDGED_TOOLS = new Set(['search_engine', 'scrape_as_markdown']);
export const WEB_HEDGE_DEFAULT_MS = 12_000;
export function webHedgeMs(toolName: string): number {
  if (!HEDGED_TOOLS.has(toolName)) return 0;
  const v = String(process.env.WEB_HEDGE_DISABLED ?? '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return 0;
  const n = Number(process.env.WEB_HEDGE_MS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : WEB_HEDGE_DEFAULT_MS;
}
type DirectOutcome = { kind: 'ok'; value: string } | { kind: 'empty' } | { kind: 'deterministic'; err?: any } | { kind: 'error'; err: any };

// ── Adaptive hedge for the DIRECT search tier (backlog audit PE-06, 2026-09-28) ──
// Prod 7 d, tool=search_engine: the direct tier answered nothing in 35.4 % of
// searches (592/1,674) and each miss cost the user ~17–24 s before the gateway
// (which answered EVERY time) even started — the 12 s hedge only helps a SLOW
// direct call, not a fast-failing one that burns its retry loop first. Fix: a
// rolling window of direct outcomes per tool (noted when the direct call
// SETTLES, whoever won the race — so the rate is unbiased by the hedge itself);
// once the window holds ≥ WEB_DIRECT_ADAPTIVE_MIN_SAMPLES calls and the miss
// rate exceeds WEB_DIRECT_ADAPTIVE_MISS_RATE, the hedge trigger for that tool
// drops to WEB_DIRECT_ADAPTIVE_HEDGE_MS (default 0 = start the gateway AT ONCE
// and race both tiers; the direct answer still wins whenever it lands first).
// Deterministic / unfetchable outcomes are not tier misses and are not counted.
// Only search_engine adapts (scrape misses 6 %, below the bar by design).
// Every web_fetch_path row now carries `hedgeMs`, `adaptive`, `directMissRate`
// and — on a direct miss — `directClass` (the body / failure class from
// brightdata-direct classifyDirectMiss). WEB_HEDGE_DISABLED=1 disables it (it is
// a hedge variant).
const ADAPTIVE_TOOLS = new Set(['search_engine']);
export const WEB_DIRECT_ADAPTIVE_WINDOW_DEFAULT = 40;
export const WEB_DIRECT_ADAPTIVE_MIN_SAMPLES_DEFAULT = 20;
export const WEB_DIRECT_ADAPTIVE_MISS_RATE_DEFAULT = 0.3;
export const WEB_DIRECT_ADAPTIVE_HEDGE_MS_DEFAULT = 0;
function envNumber(name: string, fallback: number, min = 0): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
/** Per-tool rolling window of direct-tier outcomes (true = miss). */
const directOutcomeWindow = new Map<string, boolean[]>();
const adaptiveState = new Map<string, boolean>();
export function __resetDirectOutcomeWindowForTest(): void { directOutcomeWindow.clear(); adaptiveState.clear(); sharedSnapshots.clear(); sharedRefreshing.clear(); }
export function noteDirectOutcome(toolName: string, miss: boolean): void {
  const cap = Math.max(1, Math.floor(envNumber('WEB_DIRECT_ADAPTIVE_WINDOW', WEB_DIRECT_ADAPTIVE_WINDOW_DEFAULT, 1)));
  const w = directOutcomeWindow.get(toolName) ?? [];
  w.push(miss);
  while (w.length > cap) w.shift();
  directOutcomeWindow.set(toolName, w);
  // audit 2026-10-08 W3-6: every process's outcomes also feed ONE shared window.
  if (ADAPTIVE_TOOLS.has(toolName)) pushSharedOutcome(toolName, miss, cap);
}

// ── Shared adaptive window (audit 2026-10-08 W3-6 — plumbing F8) ─────────────
// The miss window was PER PROCESS: web blue/green + the worker each held their
// own 40-call window, most rows showed directWindow 10–13 (< MIN_SAMPLES 20),
// so `adaptive` was true on only 119 of 622 searches and ~108 gateway wins sat
// out the full 12 s hedge behind a pending direct call. Every process now also
// LPUSHes its outcome to one Redis list (`web:direct_outcomes:<tool>`, trimmed
// to the window, 1 h TTL) and plans from a cached snapshot of it (refreshed in
// the background at most every SHARED_WINDOW_REFRESH_MS — never on the hot
// path); a process uses the shared window only when it holds more samples than
// its own. FAIL-OPEN everywhere: no Redis, a closed client or any error ⇒ the
// local window, exactly as before. Kill switch WEB_DIRECT_ADAPTIVE_SHARED_DISABLED=1.
// The client is only ever read from a config/redis module the PROCESS already
// loaded (server / worker boot) — this module never imports it (its env
// validation exits a process that has no DATABASE_URL, e.g. a unit test).
export const SHARED_WINDOW_KEY = (toolName: string): string => `web:direct_outcomes:${toolName}`;
export const SHARED_WINDOW_REFRESH_MS = 5_000;
export const SHARED_WINDOW_MAX_AGE_MS = 60_000;
const SHARED_WINDOW_TTL_SEC = 3_600;
export function webDirectAdaptiveSharedDisabled(): boolean {
  const v = String(process.env.WEB_DIRECT_ADAPTIVE_SHARED_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
let sharedRedisOverride: any | undefined;
/** Test seam: inject a redis-like client (null = none). */
export function __setSharedWindowRedisForTest(client: any | null | undefined): void { sharedRedisOverride = client; sharedSnapshots.clear(); sharedRefreshing.clear(); }
function sharedRedis(): any | null {
  if (sharedRedisOverride !== undefined) return sharedRedisOverride;
  try {
    const mod = require.cache[require.resolve('../../config/redis')];
    const client = (mod?.exports as any)?.default;
    return client && client.isOpen ? client : null;
  } catch {
    return null;
  }
}
const sharedSnapshots = new Map<string, { rate: number; n: number; at: number }>();
const sharedRefreshing = new Map<string, number>();
function pushSharedOutcome(toolName: string, miss: boolean, cap: number): void {
  if (webDirectAdaptiveSharedDisabled()) return;
  const r = sharedRedis();
  if (!r) return;
  const key = SHARED_WINDOW_KEY(toolName);
  void (async () => {
    try {
      await r.lPush(key, miss ? '1' : '0');
      await r.lTrim(key, 0, cap - 1);
      await r.expire(key, SHARED_WINDOW_TTL_SEC);
    } catch { /* fail-open: the local window still counts it */ }
  })();
}
/** Background refresh of the shared snapshot (at most once per SHARED_WINDOW_REFRESH_MS per tool). Resolves when done. */
export async function refreshSharedDirectWindow(toolName: string): Promise<void> {
  if (webDirectAdaptiveSharedDisabled()) return;
  const r = sharedRedis();
  if (!r) return;
  const now = Date.now();
  if (now - (sharedRefreshing.get(toolName) ?? 0) < SHARED_WINDOW_REFRESH_MS) return;
  sharedRefreshing.set(toolName, now);
  try {
    const cap = Math.max(1, Math.floor(envNumber('WEB_DIRECT_ADAPTIVE_WINDOW', WEB_DIRECT_ADAPTIVE_WINDOW_DEFAULT, 1)));
    const list: unknown = await r.lRange(SHARED_WINDOW_KEY(toolName), 0, cap - 1);
    const items = Array.isArray(list) ? list.map(String).filter((x) => x === '1' || x === '0') : [];
    sharedSnapshots.set(toolName, { rate: items.length ? items.filter((x) => x === '1').length / items.length : 0, n: items.length, at: Date.now() });
  } catch { /* fail-open */ }
}
/** The cached shared window for a tool when fresh (≤ SHARED_WINDOW_MAX_AGE_MS), else null; kicks a background refresh. Sync. */
export function sharedDirectWindow(toolName: string): { rate: number; n: number } | null {
  if (webDirectAdaptiveSharedDisabled() || !ADAPTIVE_TOOLS.has(toolName)) return null;
  void refreshSharedDirectWindow(toolName).catch(() => {});
  const snap = sharedSnapshots.get(toolName);
  if (!snap || Date.now() - snap.at > SHARED_WINDOW_MAX_AGE_MS) return null;
  return { rate: snap.rate, n: snap.n };
}
/** The rolling direct-miss rate for a tool ({rate, n}; rate 0 when empty). */
export function directMissRate(toolName: string): { rate: number; n: number } {
  const w = directOutcomeWindow.get(toolName) ?? [];
  const n = w.length;
  return { rate: n ? w.filter(Boolean).length / n : 0, n };
}
export interface HedgePlan { hedgeMs: number; adaptive: boolean; missRate: number; n: number; windowSource?: 'shared' | 'local' }
/**
 * The hedge plan for one call: the base trigger (webHedgeMs) or, when the
 * adaptive rule holds for this tool, the shorter adaptive trigger. Pure over the
 * window; logs once per state transition.
 */
export function adaptiveHedgePlan(toolName: string, baseHedgeMs: number, shared?: { rate: number; n: number } | null): HedgePlan {
  const local = directMissRate(toolName);
  // audit 2026-10-08 W3-6: the fleet-wide window wins when it holds more samples than this process's.
  const useShared = !!shared && shared.n > local.n;
  const { rate, n } = useShared ? shared! : local;
  const off: HedgePlan = { hedgeMs: baseHedgeMs, adaptive: false, missRate: rate, n, ...(shared ? { windowSource: useShared ? 'shared' as const : 'local' as const } : {}) };
  if (baseHedgeMs <= 0 || !ADAPTIVE_TOOLS.has(toolName)) return off;
  const minSamples = Math.max(1, Math.floor(envNumber('WEB_DIRECT_ADAPTIVE_MIN_SAMPLES', WEB_DIRECT_ADAPTIVE_MIN_SAMPLES_DEFAULT, 1)));
  const bar = envNumber('WEB_DIRECT_ADAPTIVE_MISS_RATE', WEB_DIRECT_ADAPTIVE_MISS_RATE_DEFAULT);
  const on = n >= minSamples && rate > bar;
  if (adaptiveState.get(toolName) !== on && (on || adaptiveState.has(toolName))) {
    logger.info(`Digby Web Search: adaptive hedge ${on ? 'ON' : 'OFF'} for ${toolName} — direct miss rate ${(rate * 100).toFixed(0)}% over the last ${n} call(s) (bar ${(bar * 100).toFixed(0)}%)`);
  }
  adaptiveState.set(toolName, on);
  if (!on) return off;
  const adaptiveMs = Math.floor(envNumber('WEB_DIRECT_ADAPTIVE_HEDGE_MS', WEB_DIRECT_ADAPTIVE_HEDGE_MS_DEFAULT));
  return { hedgeMs: Math.min(baseHedgeMs, adaptiveMs), adaptive: true, missRate: rate, n, ...(off.windowSource ? { windowSource: off.windowSource } : {}) };
}

function recordWebFetchPath(toolName: string, meta: Record<string, unknown>, ms: number): void {
  void import('./platform/loop-metrics.service')
    .then((m) => m.recordLoopMetric({ kind: 'web_fetch_path', value: ms, meta: { tool: toolName, ...meta } }))
    .catch(() => {});
}

/**
 * D3 resume-after-throttle OBSERVABILITY (goal 9ecd595e, 2026-10-31).
 *
 * The ladder itself was silent: a resume left only a `logger.info` line inside
 * whichever container happened to run it, so neither `get_fleet_telemetry` nor
 * an operator could ever see one. That made the acceptance criterion
 * ("a production-path throttle RESUMES") unclosable BY CONSTRUCTION — a real
 * resume and "no throttle happened at all" produced exactly the same reading
 * (zero rows). One row per CALL that actually waited out a stated throttle
 * (never one per utterance of "retry") fixes that asymmetry: absence of a row
 * now means "no resume occurred", which is a measurable claim.
 *
 * Emitted ONLY when the D3 ladder waited (`resumeWaitCount > 0`), so the
 * default interactive fail-fast path records nothing and its contract — and
 * its noise floor — is byte-for-byte unchanged.
 */
function recordSerpResume(toolName: string, meta: Record<string, unknown>, ms: number): void {
  void import('./platform/loop-metrics.service')
    .then((m) => m.recordLoopMetric({ kind: 'web_serp_resume', value: Math.round(ms), meta: { tool: toolName, ...meta } }))
    .catch(() => {});
}

// ── PDF handling for the scrape path (ticket bf4e0629) ───────────────────────
// scrape_as_markdown on a PDF URL returns the RAW PDF BYTE STREAM ("%PDF-1.7
// ... FlateDecode ... endstream") — prod stored 471k chars of binary garbage
// for a rulebook PDF. Detect PDF targets here (the shared chokepoint every
// scrape consumer goes through: web_pipe, chat URL-scrape, agentic tools,
// browser-agent cloud reads) and extract real text via the existing
// pdf-extract tiered extractor (pdf-parse → Gemini vision OCR) instead.
const PDF_FETCH_MAX_BYTES = 20 * 1024 * 1024; // matches pdf-extract's OCR ceiling territory
const PDF_FETCH_TIMEOUT_MS = 20_000;
const PDF_TEXT_CHAR_CAP = 80_000;             // sane cap — callers slice further downstream

/** URL path says PDF (query/hash tolerated). Cheap pre-check only — the
 *  authoritative signals are the %PDF- magic bytes / content-type on fetch. */
export function isPdfUrl(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** A scrape result that is actually a raw PDF byte stream. */
function looksLikePdfBody(text: string): boolean {
  return text.trimStart().startsWith('%PDF-');
}

/**
 * Decode a URL's last path segment, TOLERANT of a bare `%`.
 *
 * `decodeURIComponent('56355%MAC')` throws `URIError: URI malformed`, and real
 * targets carry exactly that shape (asbca.mil serves `…/56355%MAC`). Because the
 * call sat INSIDE the fetch's try, the throw aborted extraction for a PDF we had
 * ALREADY downloaded successfully and surfaced as a "PDF fetch/extract failed"
 * warn — our own bug wearing a third-party failure's clothes, invisible because
 * the reason read `URI malformed` and every ticket row read `status code 403`
 * (adversarial review of ticket 68200428, 2026-11-06).
 *
 * The filename is only a hint to the extractor, so on a malformed escape the raw
 * segment is strictly better than throwing.
 */
export function safeDecodeUrlSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/**
 * Fetch a PDF's bytes directly (bounded) and extract readable text via the
 * shared tiered extractor. Returns null when the target is not actually a PDF
 * (caller falls through to a normal scrape), or when fetch/extraction fails —
 * never raw binary.
 */
export async function extractPdfTextFromUrl(url: string): Promise<string | null> {
  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: PDF_FETCH_TIMEOUT_MS,
      maxContentLength: PDF_FETCH_MAX_BYTES,
      maxBodyLength: PDF_FETCH_MAX_BYTES,
    });
    const buf = Buffer.from(r.data);
    const contentType = String(r.headers?.['content-type'] || '');
    const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-' || contentType.includes('application/pdf');
    if (!isPdf) return null; // not actually a PDF — let the normal scrape handle it
    const filename = safeDecodeUrlSegment(url.split('/').pop()?.split(/[?#]/)[0] || '') || 'document.pdf';
    const text = (await extractPdfText(buf, filename)).trim();
    if (!text) return null;
    logger.info(`Digby Web Search: extracted PDF text for "${url.slice(0, 60)}" (${text.length} chars from ${buf.length} bytes)`);
    return text.length > PDF_TEXT_CHAR_CAP
      ? `${text.slice(0, PDF_TEXT_CHAR_CAP)}\n\n[PDF text truncated at ${PDF_TEXT_CHAR_CAP.toLocaleString()} characters]`
      : text;
  } catch (err: any) {
    logger.warn(`Digby Web Search: PDF fetch/extract failed for "${url.slice(0, 60)}": ${err?.message || err}`, { source: 'web-search' });
    return null;
  }
}

// ── Search configuration pre-flight (ticket 6f4d42f2) ────────────────────────
// When an instance has NO search credentials configured (no env
// BRIGHTDATA_API_TOKEN, no admin-store key, no MCP gateway token), every
// search/scrape call would burn its full retry + circuit budget before
// answering null. This pre-flight resolves the credential state ONCE per call
// (cached server-side by the resolver) and records it on the shared
// search-config-state leaf, so the agent-facing consumers (tool-executor's
// search_engine/web_pipe tools, coding/web-pipe.ts) can say "search not
// configured — set a Bright Data key in Admin → Settings" instead of the
// generic unreachable/rate-limited text. It NEVER blocks a call: any error in
// the resolution degrades to "armed" (the existing retry paths own the rest).
let _searchConfigInFlight: Promise<void> | null = null;

async function noteSearchConfiguredState(): Promise<void> {
  // Coalesce concurrent pre-flights (search fan-outs call callMcpTool in
  // parallel): one resolver round trip serves them all. The gateway-token
  // short-circuit lives INSIDE the resolver leg so the direct tier's store
  // memo is primed on every path (see the Blocking-1 note below).
  if (!_searchConfigInFlight) {
    _searchConfigInFlight = (async () => {
      // Degraded default: a pre-flight failure NEVER blocks search (the
      // tiers own their failures) and never claims "not configured".
      let anyBackendArmed = true;
      try {
        const { resolveSearchCredentials } = await import('./platform/search-provider-config');
        const creds = await resolveSearchCredentials();
        // The gateway tier carries its own credentials (MCP_DIGBY_TOKEN) —
        // when it is set the instance IS configured regardless of the
        // Bright Data key state.
        anyBackendArmed = !!creds || (!!MCP_DIGBY_TOKEN && !!MCP_DIGBY_URL);
        // Reviewer Blocking 1 (ticket 6f4d42f2): prime brightdata-direct's
        // store-creds memo from THIS resolution. The sync
        // directBrightDataAvailable() gate in routeMcpTool reads that memo,
        // but it was previously written only inside
        // resolveDirectBrightDataCreds() — whose callers are reachable only
        // THROUGH the gate — so on a store-only instance (no env
        // BRIGHTDATA_API_TOKEN, the default docker-compose.selfhost.yml
        // shape) the memo never warmed and every search/scrape silently
        // returned null. Awaiting the pre-flight at the top of callMcpTool
        // guarantees the prime lands BEFORE the gate evaluates in the same
        // call — including after memo/cache TTL expiry (self-healing), and
        // within one call after an admin saves a key (the PUT clears the
        // resolver cache). Env creds need no memo: the module-level TOKEN
        // const arms the gate for them.
        noteStoreCredsForAvailability(
          creds && creds.source === 'store' ? { token: creds.token, zone: creds.zone } : null,
        );
      } catch {
        // Resolution itself failed (dynamic import / resolver explosion) —
        // keep anyBackendArmed true; the tiers own their failures.
      }
      const { recordSearchConfigState } = await import('./platform/search-config-state');
      recordSearchConfigState({ at: Date.now(), anyBackendArmed });
    })().finally(() => { _searchConfigInFlight = null; });
  }
  return _searchConfigInFlight;
}

export async function callMcpTool(toolName: string, args: Record<string, any>, timeoutMsOverride?: number, opts?: SerpCallOpts): Promise<any> {
  // Ticket 6f4d42f2: when NOTHING is configured — no env BRIGHTDATA_API_TOKEN,
  // no admin-store key (Admin → Settings → Web search), and no MCP gateway
  // token — every search/scrape path would burn its full retry/circuit budget
  // to answer null, and the agent-facing surfaces told the model "gateway
  // unreachable / rate-limited" (the exact dead-end the owner hit on his
  // self-hosted deployment: 9 searches + 9 reads, every path failed, no
  // actionable message). Fail FAST here with the honest diagnosis, and record
  // it on the shared config-state leaf so tool-executor / web_pipe can render
  // the operator-facing "search not configured — set a Bright Data key in
  // Admin → Settings" text instead of the generic degraded wording.
  await noteSearchConfiguredState();
  if (toolName === 'scrape_as_markdown') {
    const url = String(args.url || '');
    // PDF target by URL — extract text instead of scraping bytes.
    if (isPdfUrl(url)) {
      const pdfText = await extractPdfTextFromUrl(url);
      if (pdfText) return pdfText;
      // not actually a PDF, or fetch/extraction failed — try the normal scrape
    }
    const result = await routeMcpTool(toolName, args, timeoutMsOverride);
    // PDF detected from the response body (no .pdf extension) — re-fetch the
    // real bytes and extract; the utf8-mangled scrape body is unrecoverable.
    if (typeof result === 'string' && looksLikePdfBody(result)) {
      logger.info(`Digby Web Search: scrape of "${url.slice(0, 60)}" returned raw PDF bytes — extracting text instead`);
      return extractPdfTextFromUrl(url); // null on failure — raw PDF bytes are never useful
    }
    return result;
  }
  if (toolName === 'search_engine') {
    const result = await routeMcpTool(toolName, args, timeoutMsOverride, opts);
    // SERP provider-error chokepoint guard (ticket ca805a61, 2026-10-07): the
    // LANDED classifier (9b944f30) ran only inside web_pipe — every OTHER
    // callMcpTool('search_engine') consumer (the agent-facing search_engine
    // TOOL, news.service release roundups, the kid path, moonshot integrations)
    // received the gateway tier's error/debug TEXT as a normal
    // truthy result when the provider failed. Defense in depth over EVERY
    // route: the gateway tier already classifies the body as a FAILED attempt
    // (throw into its retry/backoff + circuit-breaker loop); THIS check nulls
    // the class whatever route served it (a direct-tier answer that raced the
    // hedge, or a future route) — a provider error body is never "results".
    // A JSON body with an organic array always passes (serpCarriesOrganic).
    if (typeof result === 'string') {
      const providerError = serpProviderErrorDetail(result);
      if (providerError) {
        opts?.onSerpProviderError?.(providerError);
        logger.warn(
          `Digby Web Search: search_engine answered with the provider's error/debug body instead of results` +
            (providerError.code ? ` (x-brd-error-code=${providerError.code})` : '') +
            (providerError.status ? ` HTTP ${providerError.status}` : '') +
            `${providerError.reqId ? ` req_id=${providerError.reqId}` : ''} — treating as failure, not results (ticket ca805a61): ${providerError.snippet}`,
          { source: 'web-search', tool: 'search_engine' },
        );
        return null;
      }
    }
    // SERP redirect wrappers (2026-09-14): since ~09-13 BrightData's Google SERP
    // returns organic[].link as https://www.google.com/goto?url=<opaque> —
    // unscrapable ("this endpoint is not supported") and useless as a citation.
    // Unwrap at THIS chokepoint so every consumer (chat + coding search_engine
    // tool result, [Web Search Results] blocks, news, kid path, web_pipe,
    // youtube_pipe) reads and cites REAL URLs. Non-JSON / wrapper-free SERPs
    // pass through byte-identical.
    return typeof result === 'string' ? unwrapSerpJsonText(result) : result;
  }
  // FORWARD `opts` (ticket 5f69fdc4, measured 2026-11-03). This is the fallthrough
  // every `scraping_browser_*` call takes, and dropping `opts` here silently
  // stripped BOTH halves of the wire-session contract the cloud browser depends
  // on: `sessionKey` (so no `initialize` was ever issued and no Mcp-Session-Id
  // ridden) and `gatewayUrl` (so the call fell back to the STATELESS
  // MCP_DIGBY_URL /mcp instead of the stateful /browser/mcp mount). Symptom on
  // prod: `navigate` ok=true len=0 after ~86s, then a snapshot of "Page:
  // about:blank" — each tools/call got its own fresh browser. Restoring the two
  // arguments is the whole fix; verified by patching this one line in memory on
  // the deployed dist (navigate len=1565, snapshot https://example.com/).
  return routeMcpTool(toolName, args, timeoutMsOverride, opts);
}

async function routeMcpTool(toolName: string, args: Record<string, any>, timeoutMsOverride?: number, opts?: SerpCallOpts): Promise<any> {
  // DIRECT-FIRST (owner, 2026-07-15): for the hot search/scrape tools, hit
  // api.brightdata.com straight from the backend — faster and skips the
  // supergateway entirely. The MCP gateway is now the FALLBACK tier for these
  // (it stays primary for web_data_*/scraping_browser_*, which have no direct
  // equivalent). tryDirectBrightData returns null on transient failure (try the
  // gateway next); it throws DirectEmptyBodyError ONLY when a scraped page
  // deterministically has no extractable content (PDF / blocked / JS-shell) —
  // skip the gateway for that: the same BrightData backend would return empty
  // too, burning ~30s per attempt and flooding warns (issue #85).
  if (DIRECT_FAILOVER_TOOLS.has(toolName) && directBrightDataAvailable()) {
    const t0 = Date.now();
    // PE-06: the miss class the direct tier reports for a null answer (telemetry only).
    let directMiss: DirectMissInfo | undefined;
    // tryDirectBrightData's contract: resolves a string (ok) or null (transient
    // failure → gateway next); rejects ONLY with DirectEmptyBodyError.
    const directP: Promise<DirectOutcome> = tryDirectBrightData(toolName, args, timeoutMsOverride, { onMiss: (m) => { directMiss = m; } })
      .then((v): DirectOutcome => (v ? { kind: 'ok', value: v } : { kind: 'empty' }))
      .catch((err: any): DirectOutcome => (err instanceof DirectEmptyBodyError ? { kind: 'deterministic', err } : { kind: 'error', err }));
    // The adaptive window is fed when the DIRECT call settles — whoever wins the
    // race — so a gateway-first answer never masks a direct hit or miss.
    void directP.then((d) => {
      if (d.kind === 'ok') noteDirectOutcome(toolName, false);
      else if (d.kind === 'empty') noteDirectOutcome(toolName, true);
    }).catch(() => {});
    const plan = adaptiveHedgePlan(toolName, webHedgeMs(toolName), sharedDirectWindow(toolName));
    const hedgeMs = plan.hedgeMs;
    const planMeta = { hedgeMs, adaptive: plan.adaptive, directMissRate: Number(plan.missRate.toFixed(3)), directWindow: plan.n, ...(plan.windowSource ? { windowSource: plan.windowSource } : {}) };
    let gatewayP: Promise<any> | null = null;
    const gateway = () => gatewayP ?? (gatewayP = gatewayTier(toolName, args, timeoutMsOverride, opts));
    const finish = (direct: DirectOutcome, hedged: boolean): Promise<any> | any => {
      const directMs = Date.now() - t0;
      if (direct.kind === 'ok') {
        recordWebFetchPath(toolName, { winner: 'direct', hedged, directOutcome: 'ok', directMs, ...planMeta }, directMs);
        return direct.value;
      }
      if (direct.kind === 'deterministic' && direct.err instanceof DirectUnfetchableTargetError) {
        // Loop #19: the target class is unreachable for the cloud fetcher (raw
        // IP / private host / odd port / policy-refused host) — no gateway try,
        // and the MODEL gets the reason plus the sandbox alternative.
        logger.info(`Digby Web Search: ${toolName}("${String(args.url || '').slice(0, 60)}") — unfetchable target (${direct.err.reason}); skipping gateway`);
        recordWebFetchPath(toolName, { winner: 'none', hedged, directOutcome: 'unfetchable', directMs, reason: direct.err.reason, ...planMeta }, directMs);
        return unfetchableGuidance(direct.err.url, direct.err.reason);
      }
      if (direct.kind === 'deterministic') {
        logger.info(`Digby Web Search: ${toolName}("${String(args.url || '').slice(0, 60)}") — no extractable content; skipping gateway (deterministic, #85)`);
        recordWebFetchPath(toolName, { winner: 'none', hedged, directOutcome: 'deterministic', directMs, ...planMeta }, directMs);
        return null;
      }
      if (direct.kind === 'error') throw direct.err; // contract: only DirectEmptyBodyError escapes tryDirectBrightData
      const directClass = directMiss?.class ?? 'unknown';
      // A miss while the hedged gateway is already running is the designed path
      // (the user is not waiting on it) — info; the sequential miss still costs
      // the user the gateway round trip — warn.
      const missLine = `Digby Web Search: DIRECT ${toolName} returned nothing after ${directMs} ms (${directClass}) — ${hedged ? 'the hedged gateway call is already running' : 'trying the gateway'}`;
      if (hedged) logger.info(missLine); else logger.warn(missLine, { source: 'web-search', tool: toolName });
      return gateway().then((v) => {
        recordWebFetchPath(toolName, { winner: v ? 'gateway' : 'none', hedged, directOutcome: 'empty', directMs, directClass, directStatus: directMiss?.status, ...planMeta }, Date.now() - t0);
        return v;
      });
    };
    if (hedgeMs > 0 || plan.adaptive) {
      const HEDGE = '__hedge__';
      // Adaptive trigger 0 = start the gateway at once (an already-settled direct
      // answer still wins the race — Promise.race honours iteration order).
      const trigger = hedgeMs > 0
        ? new Promise<typeof HEDGE>((res) => setTimeout(() => res(HEDGE), hedgeMs).unref?.())
        : Promise.resolve(HEDGE);
      const first = await Promise.race([directP, trigger]);
      if (first !== HEDGE) return finish(first as DirectOutcome, false);
      // Direct is slow — race it against the gateway; first useful answer wins.
      const winner = await Promise.race([
        directP.then((d) => ({ src: 'direct' as const, d })),
        gateway().then((v) => ({ src: 'gateway' as const, v })),
      ]);
      if (winner.src === 'direct') return finish(winner.d, true);
      if (winner.v) {
        const waitMs = Date.now() - t0;
        recordWebFetchPath(toolName, { winner: 'gateway', hedged: true, directOutcome: 'pending', directMs: waitMs, ...planMeta }, waitMs);
        logger.info(`Digby Web Search: hedged gateway answered ${toolName} first (direct still pending after ${waitMs} ms)`);
        // PE-06: one late row when the direct call settles, so a pending win
        // still tells us whether direct would have hit and, if not, why.
        void directP.then((d) => {
          if (d.kind !== 'ok' && d.kind !== 'empty') return;
          recordWebFetchPath(toolName, {
            winner: 'gateway', hedged: true, directOutcome: 'pending', phase: 'direct_settled',
            directLate: d.kind, directClass: d.kind === 'empty' ? (directMiss?.class ?? 'unknown') : undefined,
            directMs: Date.now() - t0, ...planMeta,
          }, waitMs);
        }).catch(() => {});
        return winner.v;
      }
      // The gateway came back empty first — the direct call is the last hope.
      return finish(await directP, true);
    }
    return finish(await directP, false);
  }

  return gatewayTier(toolName, args, timeoutMsOverride, opts);
}

/** The MCP-gateway tier: health probe, per-tool circuit breaker, bounded retries. null when unavailable or exhausted. */
async function gatewayTier(toolName: string, args: Record<string, any>, timeoutMsOverride?: number, opts?: SerpCallOpts): Promise<any> {
  if (!MCP_DIGBY_TOKEN || !MCP_DIGBY_URL) {
    // Once per process (the direct tier's own idiom, brightdata-direct.ts
    // directBrightDataAvailable): an unconfigured self-host used to warn on
    // EVERY tool call with no signal an admin could act on. The per-call line
    // stays at debug; the setup page (platform/instance-setup.ts) is the
    // admin's view, and the tool result itself tells the model honestly.
    if (!_warnedGatewayUnconfigured) {
      _warnedGatewayUnconfigured = true;
      logger.warn(
        !MCP_DIGBY_TOKEN
          ? 'Digby Web Search: MCP_DIGBY_TOKEN not set in this process — the MCP gateway tier is OFF (set BRIGHTDATA_API_TOKEN for direct search, or MCP_DIGBY_URL + MCP_DIGBY_TOKEN for a gateway)'
          : 'Digby Web Search: MCP_DIGBY_TOKEN is set but MCP_DIGBY_URL is not — on a non-production instance the gateway tier is OFF rather than aimed at the production gateway (set MCP_DIGBY_URL=http://brightdata-mcp:8000/mcp and run --profile mcp)',
        { source: 'web-search', tool: toolName },
      );
    }
    logger.debug(`Digby Web Search: gateway tier unconfigured, cannot call ${toolName}`, { source: 'web-search', tool: toolName });
    return null;
  }

  // Gateway health check — skip all tool calls if the gateway is unresponsive.
  // This prevents burning all retries on a dead connection and avoids cascading
  // failures when the MCP gateway is down or restarting.
  const gatewayOk = await ensureGatewayHealthy();
  if (!gatewayOk) return null; // direct tier already had its shot above

  // Circuit breaker — skip calls to known-failing tools (90s cooldown after 5 failures)
  if (isCircuitOpen(toolName)) return null; // direct tier already had its shot above

  // Retry wrapper — scrape AND search operations can fail due to MCP gateway child process
  // recycling or BrightData transient errors. Production logs show search_engine AND
  // scrape_batch failures multiple times per day.
  //
  // Retry policy (Mar 25, 2026):
  //   scrape_batch:      3 retries — was 2, bumped to 3 (prod logs show it still fails on 2nd try)
  //   search_engine:     3 retries — same reasoning
  //   scrape_as_markdown: 2 retries — single URL scrape recovers faster
  //
  //   All use exponential backoff: 1st retry after 2s, 2nd after 4s, 3rd after 8s.
  //   Exponential backoff is better than fixed delays because the MCP gateway child process
  //   typically needs 3-8s to fully restart — a fixed 3s delay catches the ~3s case but
  //   not the ~6-8s case; exponential backoff catches both without burning extra time early.
  // 2026-07-13: search_engine/scrape_batch 3 → 4 attempts (2s→4s→8s backoff =
  // ~14s of waiting). The gateway's OOM-killed child respawn took 15-21s under
  // load and a 3-attempt burst (≈6s of backoff) exhausted inside the window —
  // prod 18:52:57→18:53:18: all 3 attempts returned empty SSE bodies, then the
  // very next call succeeded.
  // 2026-07-15: direct tier runs FIRST now, so by the time we're here the
  // gateway is the last resort — keep its full retry budget.
  const maxRetries = (toolName === 'scrape_batch' || toolName === 'search_engine') ? 4
    : toolName.startsWith('scrape') ? 2 : 1;
  // D3 resume-after-throttle (goal 9ecd595e, 2026-10-31). Opt-in via
  // `opts.resumeBudgetMs`: absent/0 keeps the fail-fast contract byte-for-byte.
  // The deadline is fixed ONCE, at entry, so a chain of stated waits can never
  // walk the call past the caller's own wall-clock budget.
  const resumeBudgetMs = opts?.resumeBudgetMs ?? 0;
  const resumeDeadline = Date.now() + resumeBudgetMs;
  // Observability for the D3 ladder (see recordSerpResume): counts ONLY the
  // waits that a resume actually bought — i.e. a stated provider wait the
  // fail-fast path would have refused. A default caller never increments these.
  let resumeWaitCount = 0;
  let resumeWaitTotalMs = 0;
  let resumeStatedWaitMs = 0;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await callMcpToolOnce(toolName, args, timeoutMsOverride, opts);
      // SERP provider-error guard at the GATEWAY tier (ticket ca805a61): the
      // gateway answers a FAILING search backend with the provider's own
      // error/debug TEXT as a normal tools/call result — that is a FAILED
      // attempt, not success. Throw into this loop so the bounded retry budget
      // (2s→4s→8s backoff) and the circuit breaker treat it exactly like a
      // gateway error, and every callMcpTool('search_engine') caller sees the
      // honest null (which the agent-facing tool, news, kid path and moonshot
      // already report as their degraded class — they never see the body as
      // "results"). Reuses serp-provider-guard.ts (the landed 9b944f30
      // classifier: anchor-required weak triggers, organic[] fast-pass) — ONE
      // classifier, no duplicate).
      if (toolName === 'search_engine' && typeof result === 'string') {
        const providerError = serpProviderErrorDetail(result);
        if (providerError) {
          opts?.onSerpProviderError?.(providerError);
          // Fail fast (no in-window retries) when retrying CANNOT help:
          //  - deterministic class (unexpected_q): the identical query fails
          //    identically — 3 more attempts + ~14 s of backoff is pure latency;
          //  - a stated minimum wait beyond the retry budget's ceiling (the
          //    vendor's query-ban floor is 15 s; anything larger would park an
          //    interactive tool call for half a minute waiting a ban out).
          // Otherwise the class is transient: throw into this loop so the
          // bounded retry budget + circuit breaker treat it exactly like a
          // gateway error (the catch below bumps the backoff to the provider's
          // stated minimum — "stated-wait retry respect", same contract as
          // web_pipe's 9b944f30 layer).
          const statedWaitMs = providerError.minWaitMs ?? 0;
          // D3 (2026-10-31, goal 9ecd595e): a caller that passed a
          // `resumeBudgetMs` can afford to WAIT OUT a stated throttle instead of
          // surfacing it — but only if the whole wait still fits inside its own
          // deadline. Interactive callers pass nothing, so `resumeWorthIt` is
          // false and the ca805a61 fail-fast contract below is untouched.
          // The decision lives in ONE pure function so its arithmetic (the part
          // WRP-1 D3-R was about) is unit-pinned — see `serpResumeDecision`.
          const { failFast } = serpResumeDecision({
            retryable: providerError.retryable,
            statedWaitMs,
            budgetMs: resumeBudgetMs,
            resumeDeadline,
          });
          if (failFast) {
            recordCircuitFailure(toolName);
            logger.warn(
              `Digby Web Search: search_engine answered with the provider's error body` +
                (providerError.code ? ` (x-brd-error-code=${providerError.code})` : '') +
                `${providerError.status ? ` HTTP ${providerError.status}` : ''}` +
                `${providerError.reqId ? ` req_id=${providerError.reqId}` : ''}` +
                (providerError.retryable
                  ? ` — provider states a ${Math.round(statedWaitMs / 1000)} s minimum wait (beyond the retry budget); failing fast without in-window retries (ticket ca805a61): ${providerError.snippet}`
                  : ` — deterministic query-mismatch class; failing fast without retries (ticket ca805a61): ${providerError.snippet}`),
              { source: 'web-search', tool: toolName },
            );
            return null;
          }
          throw new SerpProviderErrorBodyError(providerError);
        }
      }
      // Record success to close/reset the circuit
      recordCircuitSuccess(toolName);
      if (resumeWaitCount > 0) {
        recordSerpResume(toolName, {
          outcome: 'resumed',
          attempts: attempt,
          resumeWaits: resumeWaitCount,
          waitedMs: resumeWaitTotalMs,
          statedWaitMs: resumeStatedWaitMs,
          budgetMs: resumeBudgetMs,
        }, resumeWaitTotalMs);
      }
      return result;
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries) {
        // Exponential backoff: 2s → 4s → 8s — gives gateway enough time to restart.
        // Base 2s, multiplier 2x per attempt: attempt 1 → 2s, attempt 2 → 4s, attempt 3 → 8s.
        // Production logs show the MCP gateway child process typically needs 3-8s to recycle;
        // fixed delays miss the upper end of that range, exponential backoff covers both.
        let retryDelay = 2000 * Math.pow(2, attempt - 1);
        // Stated-wait retry respect (ticket ca805a61): when the failed attempt
        // was a classified provider error body carrying the provider's OWN
        // minimum wait (x-brd-rate-limit-period-ms), waiting less just re-burns
        // a request against a limit the provider already refused — bump the
        // backoff to that minimum. The ceiling is the loop's own 8s cap by
        // default; a caller that passed `resumeBudgetMs` (D3) raises the ceiling
        // to whatever still fits inside ITS deadline, which is what lets a 60s
        // stated throttle actually be waited out instead of surfaced.
        if (err instanceof SerpProviderErrorBodyError && err.detail.minWaitMs) {
          const waitCeiling = resumeBudgetMs > 0
            ? Math.max(SERP_PROVIDER_RETRY_WAIT_CAP_MS, resumeDeadline - Date.now())
            : SERP_PROVIDER_RETRY_WAIT_CAP_MS;
          retryDelay = Math.max(retryDelay, Math.min(err.detail.minWaitMs, waitCeiling));
          // Count this as a RESUME only when the ladder is what made the wait
          // possible — a stated wait beyond the fail-fast cap that the default
          // contract would have refused outright. A short stated wait (or the
          // plain exponential backoff) is ordinary retry, not a D3 resume.
          if (resumeBudgetMs > 0 && (err.detail.minWaitMs ?? 0) > SERP_PROVIDER_RETRY_WAIT_CAP_MS) {
            resumeWaitCount += 1;
            resumeWaitTotalMs += retryDelay;
            resumeStatedWaitMs = Math.max(resumeStatedWaitMs, err.detail.minWaitMs ?? 0);
          }
        }
        logger.info(`Digby Web Search: ${toolName} attempt ${attempt} failed, retrying in ${retryDelay}ms... (${err.message})`);
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
  }

  // All gateway retries exhausted (direct was already tried first).
  recordCircuitFailure(toolName);
  if (resumeWaitCount > 0) {
    // A resume that still ended in exhaustion is REAL evidence (the ladder ran,
    // the ban outlived the budget) — record it so `outcome` separates the two.
    recordSerpResume(toolName, {
      outcome: 'exhausted',
      attempts: maxRetries,
      resumeWaits: resumeWaitCount,
      waitedMs: resumeWaitTotalMs,
      statedWaitMs: resumeStatedWaitMs,
      budgetMs: resumeBudgetMs,
    }, resumeWaitTotalMs);
  }
  logger.warn(`Digby Web Search: ${toolName} failed after ${maxRetries} gateway attempt(s): ${lastError?.message}`, { source: 'web-search', tool: toolName });
  return null;
}

async function callMcpToolOnce(toolName: string, args: Record<string, any>, timeoutMsOverride?: number, opts?: SerpCallOpts): Promise<any> {
  const requestId = Date.now() + Math.floor(Math.random() * 10000);

  // Shorter timeout for scrape operations (30s) — they either work fast or not at all
  // Search operations get full 90s timeout. Callers may override (e.g. the browser
  // agent allows a longer scrape window since BrightData scrape can exceed 30s).
  const timeoutMs = timeoutMsOverride ?? (toolName.startsWith('scrape') ? 30000 : 90000);

  // Session-scoped transport (ticket 5f69fdc4): every scraping_browser_* call
  // MUST ride the SAME Mcp-Session-Id, because the gateway holds one stdio
  // child (and thus one BrightData browser) per session. Without this every
  // tools/call got its own fresh browser — navigate reported success and the
  // very next snapshot read "Page: about:blank".
  //
  // OPT-IN ONLY. A session is engaged solely when the caller passes an explicit
  // `sessionKey` (the cloud browser driver). Search/scrape and every other
  // caller send NOTHING extra and perform NO handshake — byte-identical to the
  // pre-fix request, which is what keeps the working scrape path (and x-mcp's
  // sibling traffic) untouched on the shared stateless /mcp. Hammering a
  // stateless gateway with an `initialize` before every tools/call would be
  // pure waste and would perturb the existing call-count pins.
  const sessionKey = opts?.sessionKey;
  // WHICH MOUNT this call rides (ticket 5f69fdc4): the interactive cloud browser
  // goes to the STATEFUL /browser/mcp; every other caller keeps the shared,
  // stateless /mcp (absent ⇒ MCP_DIGBY_URL ⇒ byte-identical to pre-fix).
  const gatewayUrl = opts?.gatewayUrl || MCP_DIGBY_URL;
  const sessionHeaders: McpSessionHeaders = sessionKey
    ? await mcpSessions.headers(sessionKey, { url: gatewayUrl, token: MCP_DIGBY_TOKEN || '' })
    : {};

  const response = await axios.post(
    gatewayUrl,
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: toolName, arguments: args },
      id: requestId,
    },
    {
      headers: {
        ...baseGatewayHeaders(),
        ...sessionHeaders,
      },
      timeout: timeoutMs,
      responseType: 'stream',
      // Each attempt must own its own error class: a session-expiry 404 has to
      // be distinguishable so the NEXT attempt re-initializes instead of
      // replaying a dead id (spec: 404 ⇒ start a new session).
      validateStatus: () => true,
    }
  );

  const status = Number(response.status || 0);
  if (status === 404 && sessionHeaders['Mcp-Session-Id'] && sessionKey) {
    // supergateway reaped/restarted the session (30-min idle, container
    // restart) — drop the id so the retry handshakes again. This is exactly
    // the case supergateway 4.0.0 changed from 400 to 404 to make recoverable.
    drainStream(response.data);
    mcpSessions.invalidate(sessionKey);
    throw new Error(`MCP session expired for ${toolName} (HTTP 404) — re-initializing`);
  }
  if (status === 400 && !sessionHeaders['Mcp-Session-Id'] && sessionKey) {
    // A STATEFUL gateway refuses a session-less tools/call with 400. Retry
    // once with a fresh handshake rather than failing the call — this is the
    // window right after the gateway flips to --stateful.
    drainStream(response.data);
    mcpSessions.invalidate(sessionKey);
    const retryHeaders = await mcpSessions.headers(sessionKey, { url: gatewayUrl, token: MCP_DIGBY_TOKEN || '' });
    if (retryHeaders['Mcp-Session-Id']) {
      const retry = await axios.post(
        gatewayUrl,
        { jsonrpc: '2.0', method: 'tools/call', params: { name: toolName, arguments: args }, id: requestId },
        { headers: { ...baseGatewayHeaders(), ...retryHeaders }, timeout: timeoutMs, responseType: 'stream', validateStatus: () => true },
      );
      return parseToolCallResponse(retry, toolName, requestId, timeoutMs);
    }
  }
  if (status >= 400) {
    // Non-session HTTP error: read the body for the diagnostic (a JSON-RPC
    // error carries the real reason), then let the existing retry/health
    // ladder own it.
    const body = await readBodyBestEffort(response.data, timeoutMs);
    drainStream(response.data);
    const parsed = parseRpcBody(body);
    const msg = parsed?.error?.message ? String(parsed.error.message) : (body || '').trim().slice(0, 300);
    throw new Error(`MCP gateway HTTP ${status} for ${toolName}${msg ? `: ${msg}` : ''}`);
  }

  return parseToolCallResponse(response, toolName, requestId, timeoutMs);
}

/** The gateway request headers that are NOT session-scoped. */
function baseGatewayHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'X-API-Key': MCP_DIGBY_TOKEN || '',
  };
}

function drainStream(data: any): void {
  try {
    if (data && typeof data.destroy === 'function') data.destroy();
    else if (data && typeof data.resume === 'function') data.resume();
  } catch { /* best-effort */ }
}

/** Read an already-buffered or streamed axios body as text, bounded. */
function readBodyBestEffort(data: any, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    if (data == null) { resolve(''); return; }
    if (typeof data === 'string') { resolve(data); return; }
    if (typeof data.on !== 'function') {
      try { resolve(JSON.stringify(data)); } catch { resolve(''); }
      return;
    }
    let out = '';
    let done = false;
    const finish = (v: string) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => finish(out), Math.max(1, Math.min(timeoutMs, 15000)));
    (timer as any).unref?.();
    data.on('data', (c: Buffer) => { out += c.toString(); if (out.length > 100_000) finish(out); });
    data.on('end', () => finish(out));
    data.on('error', () => finish(out));
  });
}

/** Parse a JSON-RPC envelope out of an SSE-framed or plain-JSON body. */
function parseRpcBody(body: string): any {
  const trimmed = (body || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* fall through to SSE */ }
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const raw = t.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !('method' in parsed)) return parsed;
    } catch { /* skip */ }
  }
  return null;
}

/** Turn a successful gateway response into the tool's text result. */
function parseToolCallResponse(response: any, toolName: string, requestId: number, timeoutMs: number): Promise<any> {
  // Parse the response and return the result. FORMAT-AGNOSTIC (2026-07-10):
  // MCP Streamable HTTP allows the server to answer a POST with EITHER an SSE
  // stream (`data:`-framed) OR a plain JSON body. This parser previously assumed
  // SSE-only, so a valid plain-JSON reply was silently dropped and surfaced as
  // "SSE stream ended without response" — indistinguishable from an upstream
  // outage in the logs (intermittent search-failure windows, 2026-07-10).
  const contentType = String(response.headers?.['content-type'] || '');

  return new Promise((resolve, reject) => {
    const stream = response.data;
    let buffer = '';
    let fullBody = ''; // entire raw body — fallback parse for plain-JSON (non-SSE) replies
    let resolved = false;

    /** A JSON-RPC RESPONSE (not a notification/request): has result|error, no method. */
    const isRpcResponse = (p: any) =>
      p && typeof p === 'object' && !('method' in p) && ('result' in p || 'error' in p);

    const settle = (parsed: any) => {
      resolved = true;
      clearTimeout(safetyTimer);
      stream.destroy();

      if (parsed.error) {
        reject(new Error(parsed.error.message || 'MCP error'));
        return;
      }

      // Extract text content from result
      const content = parsed.result?.content;
      if (!content || !Array.isArray(content)) {
        resolve(null);
        return;
      }

      const text = content.find((c: any) => c.type === 'text')?.text || null;
      resolve(text);
    };

    // Safety timeout — reject if we haven't heard back
    const safetyTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        stream.destroy();
        logger.warn(`Digby Web Search: ${toolName} SSE stream timed out (${timeoutMs / 1000}s)`, { source: 'web-search', tool: toolName });
        reject(new Error(`MCP tool ${toolName} timed out`));
      }
    }, timeoutMs);

    stream.on('data', (chunk: Buffer) => {
      if (resolved) return;
      const piece = chunk.toString();
      fullBody += piece;
      buffer += piece;

      // Process complete SSE lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete last line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const rawJson = trimmed.slice(5).trim(); // strip "data: " prefix
        if (!rawJson || rawJson === '[DONE]') continue;

        try {
          const parsed = JSON.parse(rawJson);
          if (!isRpcResponse(parsed)) continue; // notification/progress event — keep waiting

          // This POST's stream only carries replies to THIS request (Streamable
          // HTTP is request-scoped), so accept an id mismatch rather than drop a
          // valid response — a proxy hop that re-numbers ids must not break search.
          if (parsed.id !== requestId) {
            logger.warn(`Digby Web Search: ${toolName} response id mismatch (got ${parsed.id}, sent ${requestId}) — accepting (single-request stream)`, { source: 'web-search', tool: toolName });
          }

          settle(parsed);
          return;
        } catch {
          // Skip non-JSON lines (event type declarations, comments, etc.)
        }
      }
    });

    stream.on('error', (err: Error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(safetyTimer);
        reject(err);
      }
    });

    stream.on('end', () => {
      if (resolved) return;

      // Non-SSE fallback: try the WHOLE body as a plain JSON-RPC response before
      // declaring failure (Streamable HTTP servers may reply application/json).
      try {
        const parsed = JSON.parse(fullBody.trim());
        if (isRpcResponse(parsed)) {
          logger.info(`Digby Web Search: ${toolName} responded as plain JSON body (non-SSE, content-type: ${contentType}) — accepted`);
          settle(parsed);
          return;
        }
      } catch { /* not a plain JSON body either */ }

      resolved = true;
      clearTimeout(safetyTimer);
      // Diagnostic-rich failure: content-type + byte count + body preview tell us
      // whether the gateway sent nothing (upstream outage) or something we
      // failed to understand (client bug) — never again ambiguous in the logs.
      const preview = (fullBody.trim() || buffer.trim()).substring(0, 300);
      logger.warn(
        `Digby Web Search: SSE stream ended without response for ${toolName}` +
        ` [content-type: ${contentType || 'unknown'}, bytes: ${fullBody.length}]` +
        (preview ? ` — body preview: ${preview}` : ' — EMPTY BODY'),
        { source: 'web-search', tool: toolName }
      );
      reject(new Error(`SSE stream ended without response for ${toolName}`));
    });
  });
}

// ── Public functions ──────────────────────────────────────────────────────────

/**
 * Search the web via BrightData SERP and return formatted results.
 * Returns empty string if token is not set or search fails.
 *
 * IMPORTANT: Strips URLs from the query before sending to BrightData.
 * When users paste URLs in their message (e.g. TradingView links, Reuters articles),
 * the raw URL confuses BrightData's search_engine and returns zero results.
 * We strip the URL but keep the surrounding intent text as the clean search query.
 */
export async function searchWithBrightData(
  query: string,
  engine: 'google' | 'bing' = 'google',
  conversationHistory?: Array<{ role: string; content: string | any[] }>,
  timeoutMs?: number
): Promise<string> {
  // Extract any URLs from query before stripping
  const urlMatches = query.match(/https?:\/\/[^\s]+/g) || [];

  // Strip URLs — BrightData search_engine fails when the query contains raw URLs
  const cleanQuery = query
    .replace(/https?:\/\/[^\s]+/g, '')  // remove all URLs
    .replace(/\s+/g, ' ')               // collapse extra whitespace
    .trim()
    .substring(0, 200);                 // cap at 200 chars for a clean SERP query

  // ── Case 1: Message is essentially just a URL ─────────────────────────────
  // Searching for a URL string returns SERP snippets (often stale/cached).
  // Direct scraping gives the live page content — critical for stock prices,
  // news articles, financial data, etc.
  if (cleanQuery.length < 5 && urlMatches.length > 0) {
    const urlToScrape = urlMatches[0] as string;
    logger.info(`Digby Web Search: message is a URL — scraping directly: "${urlToScrape.substring(0, 80)}"`);
    return scrapeUrlWithBrightData(urlToScrape);
  }

  // ── Case 2: Vague / command-style query — enrich with conversation context ─
  // When user says "use web search to find the price right now", the query has no
  // subject matter. Pull context from recent user messages (last 3) to build a
  // richer, more searchable query (e.g. "SST stock price System1").
  let effectiveQuery = cleanQuery.length >= 5 ? cleanQuery : query.substring(0, 200).trim();

  if (effectiveQuery.length < 60 && conversationHistory && conversationHistory.length > 0) {
    const contextFromHistory = conversationHistory
      .filter(m => m.role === 'user')
      .slice(-3)
      .map(m => {
        const c = typeof m.content === 'string' ? m.content : '';
        return c.replace(/https?:\/\/[^\s]+/g, '').trim(); // strip URLs from history too
      })
      .filter(c => c.length > 10 && c !== effectiveQuery)
      .join(' ')
      .substring(0, 200);

    if (contextFromHistory.length > effectiveQuery.length) {
      const enriched = `${effectiveQuery} ${contextFromHistory}`.trim().substring(0, 200);
      if (enriched.length > effectiveQuery.length) {
        logger.info(`Digby Web Search: enriched vague query with history context: "${enriched.substring(0, 80)}"`);
        effectiveQuery = enriched;
      }
    }
  }

  if (cleanQuery !== query.trim().substring(0, 200)) {
    logger.info(`Digby Web Search: cleaned query (stripped URLs): "${effectiveQuery.substring(0, 80)}"`);
  }

  try {
    // timeoutMs (2026-07-12): background callers (news/feed schedulers) pass a
    // tight per-attempt budget so a degraded gateway can't hold a scheduled
    // fetch for the full 90s×3-retry worst case (~276s). Interactive callers
    // omit it and keep the default.
    const text = await callMcpTool('search_engine', { query: effectiveQuery, engine }, timeoutMs);
    if (!text) return '';
    logger.info(`Digby Web Search: SERP complete for "${effectiveQuery.substring(0, 60)}" (${text.length} chars)`);
    return `[Web Search Results]\nQuery: ${effectiveQuery}\n\n${text}`;
  } catch (error: any) {
    logger.warn(`Digby Web Search (SERP) failed: ${error.message}`, { source: 'web-search' });
    return '';
  }
}

/**
 * Scrape a single URL and return its content as Markdown.
 * Returns empty string on failure.
 */
export async function scrapeUrlWithBrightData(url: string): Promise<string> {
  try {
    const text = await callMcpTool('scrape_as_markdown', { url });
    if (!text) return '';
    logger.info(`Digby Web Search: scraped "${url}" (${text.length} chars)`);
    return `[Scraped Content from ${url}]\n\n${text}`;
  } catch (error: any) {
    logger.warn(`Digby Web Search (scrape) failed for ${url}: ${error.message}`, { source: 'web-search' });
    return '';
  }
}

/**
 * Scrape multiple URLs in one batch call and return combined Markdown.
 * Accepts up to 5 URLs. Returns empty string on failure.
 */
export async function scrapeUrlsBatchWithBrightData(urls: string[]): Promise<string> {
  if (urls.length === 0) return '';
  const batch = urls.slice(0, 5);

  try {
    const text = await callMcpTool('scrape_batch', { urls: batch });
    if (!text) return '';
    logger.info(`Digby Web Search: batch scraped ${batch.length} URLs (${text.length} chars)`);
    return `[Batch Scraped Content from ${batch.length} URLs]\n\n${text}`;
  } catch (error: any) {
    logger.warn(`Digby Web Search (batch scrape) failed: ${error.message}`, { source: 'web-search' });
    return '';
  }
}

/**
 * Combined web search: SERP results + scrape top results for deeper content.
 * Best used when the query needs both finding pages AND reading them.
 * Returns combined context string.
 */
export async function searchAndScrapeWithBrightData(query: string): Promise<string> {
  const serpContext = await searchWithBrightData(query);
  if (!serpContext) return '';

  const urlPattern = /https?:\/\/[^\s"'<>]+/g;
  const foundUrls = [...new Set(serpContext.match(urlPattern) || [])].slice(0, 3);
  if (foundUrls.length === 0) return serpContext;

  const scrapedContext = await scrapeUrlsBatchWithBrightData(foundUrls);
  if (!scrapedContext) return serpContext;

  return `${serpContext}\n\n${scrapedContext}`;
}