/**
 * Helper-SEAT health fallback (owner 2026-09-14: "I switched the helper model
 * in coding sessions over to our local cql spark qwen4b so im concerned that
 * is not working").
 *
 * The coding_helper seat is admin-overridable to a CUSTOM endpoint. When that
 * endpoint is unhealthy the seat's consumers used to fail HONESTLY but
 * UNHELPFULLY: the web/youtube digests came back "index only" (the owner saw
 * "banked memory is just raw search JSON"), and a helper-tier worker whose
 * tool-bearing turn the gateway 400'd burned the whole recovery budget on
 * backoff + shrink retries of a request the server would never accept.
 *
 * This module gives the seat ONE bounded fallback to the BUILT-IN helper (the
 * hardcoded default the seat would have with no override — HELPER_MODEL):
 *   - runHelperSeatCompletion: the non-streaming digest path (web_pipe,
 *     youtube_pipe). Resolves the seat, tries it, and on a fallbackable
 *     failure retries ONCE on the built-in, returning an honest attribution
 *     line the model/owner reads.
 *   - workerSeatFailureReason: the pure decision for the streaming worker
 *     path (agent.ts): a custom helper seat that 4xx's a turn (tool-bearing or
 *     not) or is unreachable moves the worker to the built-in for the rest of
 *     its run — never a tool-less retry on the same seat (a worker that cannot
 *     call tools would narrate work it did not do).
 *
 * Fallbackable = the seat is UNHEALTHY, not misconfigured: HTTP 4xx/5xx except
 * 401/403 (auth = a config error to surface), a timeout, a connection-level
 * failure (ECONNREFUSED/ENOTFOUND/…), or an empty answer. Built-in seats never
 * fall back (there is nothing further to fall to — the callers' own honest
 * fallbacks fire). Every fallback records loop_metrics seat_fallback
 * {role, from, to, reason, status} and warns once with the endpoint label.
 *
 * Kill switch: HELPER_SEAT_FALLBACK_DISABLED=1 (default ON).
 */

import { isProviderQuotaRejection } from './provider-quota';
import logger from '../../../utils/logger';
import {
  HELPER_MODEL, ProviderConfig, CodingModelId, extractProviderErrorDetail, normalizeCodingModel, resolveProviderForRun, resolveRoleModelForRun, resolveRoleFallbackForRun,
} from './coding-model';
import { HelperEmptyAnswerError, NonStreamingAnswer, isCustomEndpoint, runHelperCompletion } from './helper-completion';
import { seatInvalidRequestLatch } from './seat-invalid-request';
import type { ModelRoleKey } from '../model-endpoints/model-roles.service';

export const HELPER_SEAT_ROLE = 'coding_helper' as const;
/** The LEAD coding seat (the orchestrator's own model) — see leadSeatConnectionFailure. */
export const LEAD_SEAT_ROLE = 'coding_default' as const;
/** The Auto Quick lane's lead seat (model-roles.service 'chat_quick'). */
export const QUICK_SEAT_ROLE = 'chat_quick';

/** Read per call so ops can flip it live. */
export function helperSeatFallbackDisabled(): boolean {
  const v = String(process.env.HELPER_SEAT_FALLBACK_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Kill switch for the LEAD-seat immediate fallback lanes (unreachable endpoint; 429/5xx/billing) — default ON.
 *  CODING_SEAT_FALLBACK_DISABLED (the budget-exhaustion failover's switch, ticket fe6f0b0b) turns them off too:
 *  an operator who disables seat fallback means ALL of it. */
export function leadSeatFallbackDisabled(): boolean {
  const on = (k: string) => { const v = String(process.env[k] ?? '').trim().toLowerCase(); return v === '1' || v === 'true' || v === 'on'; };
  return on('LEAD_SEAT_FALLBACK_DISABLED') || on('CODING_SEAT_FALLBACK_DISABLED');
}

const LEAD_HARD_UNREACHABLE = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)\b/;
const LEAD_SOFT_UNREACHABLE = /\b(ETIMEDOUT|ECONNRESET)\b|socket hang up/i;

/**
 * LEAD seat on a CUSTOM endpoint that cannot be REACHED (spark-cluster audit
 * 2026-09-17: child session 1d39d145 was pinned to a project coding model on
 * 89.124.37.178:4000, the host timed out at connect, the loop burned five
 * backoffs twice and finalized with an error note — zero tool calls, and the
 * parent found out by polling). A connection-level failure is the network
 * answering, not the model: hard codes (refused / no such host / unreachable)
 * fall back at once, a timeout / reset after ONE ordinary backoff already
 * burned (a single blip still gets its retry). HTTP rejections (400/429/5xx)
 * are the provider answering and stay with the loop's own lanes — the
 * orchestrator on a custom endpoint that 400s is deliberately NOT re-seated.
 * Built-in seats have nothing further to fall to here (their own fallbacks
 * fire). Returns the short cause, or null.
 */
/** Built-in lead candidates, in preference order; the failed model is skipped. */
export const LEAD_BUILTIN_FALLBACK_ORDER: CodingModelId[] = ['glm-5.3', 'deepseek-flash', 'kimi-k3'];
const LEAD_BILLING_RE = /insufficient balance|exceeded_current_quota|suspended due to|billing details|account\b.{0,40}\bsuspended/i;
export type LeadHttpFailure = 'billing' | `HTTP ${number}`;

/**
 * LEAD seat rejected by the PROVIDER (owner 2026-09-17, ZAI glm-5.3 suspended
 * for balance then rate-limited for hours while every seat in production —
 * coding default, chat orchestrator, fleet + project supervisors — was pinned
 * to it with no fallback: "why isn't the fallback working so it just auto uses
 * the fallback and then retries the chosen model the next turn"). A 429, a
 * 5xx, or a billing suspension is the provider answering "not now": five
 * 70-second backoffs of the same request buy nothing a servable sibling seat
 * would not buy at once. Returns the cause class, or null for anything else
 * (400/401/403 and network errors keep their own lanes).
 */
export function leadSeatHttpFailure(turn: { errorStatus?: number; errorMessage?: string; providerError?: string }): LeadHttpFailure | null {
  if (LEAD_BILLING_RE.test(turn.errorMessage || '') || LEAD_BILLING_RE.test(turn.providerError || '')) return 'billing';
  if (turn.errorStatus === 429) return 'HTTP 429';
  // 2026-09-29: a 402/403 usage-limit / quota rejection fails the lead seat
  // over exactly like a 429 (provider-quota.ts).
  if (isProviderQuotaRejection(turn) && turn.errorStatus) return `HTTP ${turn.errorStatus}`;
  if (turn.errorStatus && turn.errorStatus >= 500) return `HTTP ${turn.errorStatus}`;
  return null;
}

/**
 * The seat a failing LEAD turn moves to: the admin's custom fallback for
 * coding_default when configured (owner 2026-09-15), else the first servable
 * built-in that is not the failed model. Null when nothing else is servable
 * here (keyless Edge — the loop's honest lanes stand).
 */
export interface LeadFallbackPick {
  model: string; provider: ProviderConfig; custom: boolean; skipped: Array<{ to: string; reason: string }>;
  /** audit 2026-10-06 T1-6: same-endpoint candidates moved behind the off-endpoint ones (gateway 5xx). */
  sameEndpointDeferred?: string[];
}

// ── Off-endpoint first on a GATEWAY 5xx (audit 2026-10-06 T1-6) ─────────────
// A 502/503/504 from a custom endpoint is the GATEWAY failing (LiteLLM down /
// redeploying / its upstream pool dead), and every other model behind the same
// endpoint label shares that gateway: the fleet audit saw
// `cql-litellm:…glm-5.3` 502 → `cql-litellm:…kimi-k3` (502 again, same second)
// → built-in glm-5.3 on every episode — a wasted same-host hop, and the
// fallback's 160k budget flipped compaction mid-run. On those statuses the
// candidates on the FAILED spec's endpoint label are tried LAST (never
// dropped — when nothing off-endpoint is servable they still run). Other
// failures (429, 500, billing, unreachable) keep the admin's order. Kill
// switch SEAT_FALLBACK_SAME_ENDPOINT_LAST_DISABLED=1.
export const GATEWAY_LEVEL_5XX: ReadonlySet<number> = new Set([502, 503, 504]);
export function seatFallbackSameEndpointLastDisabled(): boolean {
  const v = String(process.env.SEAT_FALLBACK_SAME_ENDPOINT_LAST_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
/** '<label>:<modelId>' → label; built-in ids (no ':') → null. Pure. */
export function endpointLabelOfSpec(spec: string | undefined | null): string | null {
  const s = String(spec ?? '');
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i) : null;
}
/**
 * Stable partition: on a gateway-level 5xx from a custom spec, candidates on the
 * same endpoint label go after every other candidate. Returns the new order and
 * the deferred specs (empty = order unchanged). Pure (reads the env per call).
 */
export function orderFallbackCandidates(candidates: readonly string[], failedSpec: string | undefined | null, httpStatus: number | undefined | null): { order: string[]; deferred: string[] } {
  const label = endpointLabelOfSpec(failedSpec);
  if (!label || typeof httpStatus !== 'number' || !GATEWAY_LEVEL_5XX.has(httpStatus) || seatFallbackSameEndpointLastDisabled()) {
    return { order: [...candidates], deferred: [] };
  }
  const same = candidates.filter((c) => endpointLabelOfSpec(c) === label);
  if (!same.length) return { order: [...candidates], deferred: [] };
  return { order: [...candidates.filter((c) => endpointLabelOfSpec(c) !== label), ...same], deferred: same };
}
/**
 * `seatRole` (2026-09-27): the model-roles seat the run is actually on — a
 * supervisor chat runs the 'supervisor' / 'project_supervisor' seat, a plain
 * chat 'chat_orchestrator' — so the ADMIN'S CUSTOM FALLBACK consulted is that
 * seat's, not always coding_default's. Omitted = coding_default (the coding
 * lanes; byte-identical to before). Candidates that are LATCHED off by a
 * deterministic invalid-request rejection (seat-invalid-request.ts) are
 * skipped like an unservable one — a fallback that 400s deterministically
 * is no fallback.
 */
export async function pickLeadFallback(
  currentModel: string | undefined,
  currentProviderModel: string,
  userId?: string,
  seatRole?: string,
  /** audit 2026-10-06 T1-6: the failing spec + HTTP status — a gateway 5xx
   *  tries off-endpoint candidates first (orderFallbackCandidates). */
  failure?: { spec?: string; httpStatus?: number },
): Promise<LeadFallbackPick | null> {
  const role = (seatRole && seatRole.trim()) || LEAD_SEAT_ROLE;
  const custom = (await resolveRoleFallbackForRun(role).catch(() => '')) || '';
  // The Quick answers seat (dynamic roster 2026-10-03) with no custom fallback
  // of its own hands a failed turn to the Digby seat — the normal lead — before
  // the built-in order: a failed quick lookup is still answered by the model the
  // user would have had without the Quick lane. Not a CUSTOM fallback (custom:false).
  const quickHandoff = !custom && role === QUICK_SEAT_ROLE ? ((await resolveRoleModelForRun('chat_orchestrator', '').catch(() => '')) || '') : '';
  // A CUSTOM spec ("label:model") is not a built-in — every built-in is a
  // candidate for it; a built-in skips itself (normalizeCodingModel folds
  // legacy aliases onto the live id).
  const current = currentModel && currentModel.includes(':') ? null : normalizeCodingModel(currentModel);
  const baseCandidates = [
    ...(custom && custom !== currentModel ? [custom] : []),
    ...(quickHandoff && quickHandoff !== currentModel ? [quickHandoff] : []),
    ...LEAD_BUILTIN_FALLBACK_ORDER.filter((m) => m !== current && m !== currentModel && m !== quickHandoff),
  ];
  const { order: candidates, deferred } = orderFallbackCandidates(baseCandidates, failure?.spec ?? currentModel, failure?.httpStatus);
  const skipped: Array<{ to: string; reason: string }> = [];
  for (const m of candidates) {
    const latch = m.includes(':') ? seatInvalidRequestLatch(m) : null;
    if (latch) { skipped.push({ to: m, reason: `latched off until ${new Date(latch.until).toISOString().slice(11, 19)}Z (${latch.kind})` }); continue; }
    const p = await resolveProviderForRun(m, userId).catch(() => null);
    if (!p || !p.apiKey) { skipped.push({ to: m, reason: 'not servable here (no key / no endpoint)' }); continue; }
    // fe6f0b0b nit 2: a colon spec whose registry row is DEAD falls through to
    // a built-in (fail-open) — serving it under the dead NAME is the silent
    // mislabel this feature forbids. Skip it; the built-in leg is offered
    // properly labeled.
    if (m.includes(':') && !p.label.endsWith('(custom endpoint)')) { skipped.push({ to: m, reason: 'fallback spec unresolved (registry fell through to a built-in)' }); continue; }
    if (p.model === currentProviderModel) continue; // no-op hop
    return { model: m, provider: p, custom: m === custom, skipped, ...(deferred.length ? { sameEndpointDeferred: deferred } : {}) };
  }
  return null;
}

export function leadSeatConnectionFailure(
  model: string | undefined,
  turn: { errorStatus?: number; errorMessage?: string },
  priorTransientRetries: number,
): string | null {
  if (!model || !model.includes(':')) return null;
  if (turn.errorStatus) return null;
  const msg = String(turn.errorMessage ?? '');
  const hard = LEAD_HARD_UNREACHABLE.exec(msg);
  if (hard) return hard[1];
  const soft = LEAD_SOFT_UNREACHABLE.exec(msg);
  if (soft && priorTransientRetries >= 1) return soft[1] ?? soft[0].trim();
  return null;
}

export interface HelperSeatFailure {
  /** Short, log-safe cause ('HTTP 400', 'timeout', 'ECONNREFUSED', 'empty answer', …). */
  reason: string;
  httpStatus?: number;
  /** False for config errors (401/403) and unclassified errors — surface, never fall back. */
  fallbackable: boolean;
}

const CONNECTION_CODES = /\b(ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|EPIPE)\b/;
const REASON_CAP = 200;

/** The provider's own reason from a NON-streaming axios error body (JSON or text), clipped. */
function providerDetail(err: any): string {
  const d = err?.response?.data;
  if (d === undefined || d === null) return '';
  let body = '';
  if (typeof d === 'string') body = d;
  else { try { body = JSON.stringify(d); } catch { body = ''; } }
  return extractProviderErrorDetail(body, 160);
}

/**
 * Pure: classify ONE helper-seat call failure. HTTP 401/403 are configuration
 * errors (wrong key / forbidden model) the admin must see — never masked by a
 * fallback. Every other HTTP status ≥ 400 (a 400 on a tool-bearing or
 * oversized request, a 404 on a renamed model, a 5xx from a gateway whose
 * backend is down), an axios timeout, a connection-level code, or an empty
 * answer means the seat is unhealthy right now and the built-in should serve.
 */
export function classifyHelperSeatFailure(err: any): HelperSeatFailure {
  if (err instanceof HelperEmptyAnswerError) return { reason: 'empty answer', fallbackable: true };
  const status = err?.response?.status;
  if (typeof status === 'number' && status >= 400) {
    if (status === 401 || status === 403) {
      return { reason: `HTTP ${status} (auth/config — fix the endpoint, not retried)`, httpStatus: status, fallbackable: false };
    }
    const detail = providerDetail(err);
    return { reason: `HTTP ${status}${detail ? ` — ${detail}` : ''}`.slice(0, REASON_CAP), httpStatus: status, fallbackable: true };
  }
  const message = String(err?.message || '');
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'ECONNABORTED' || /\btimeout\b/i.test(message)) return { reason: 'timeout', fallbackable: true };
  const conn = CONNECTION_CODES.exec(code) || CONNECTION_CODES.exec(message);
  if (conn) return { reason: conn[1], fallbackable: true };
  return { reason: (message || 'unknown error').slice(0, REASON_CAP), fallbackable: false };
}

export interface HelperSeatFallback {
  /** The model-roles seat key whose fallback ran: 'coding_helper', 'coding_default'
   *  (the main-seat transient failover — ticket fe6f0b0b — and the lead-seat
   *  unreachable-endpoint re-seat, LEAD_SEAT_ROLE) or the lead seat a chat lane
   *  passed (`AgentRunInput.seatRole`, e.g. 'supervisor'). Typed as the seat-key
   *  union (a free string used to be accepted here — nothing needed the widening). */
  role: ModelRoleKey;
  /** The failed seat spec (the admin's override). */
  from: string;
  /** Its provider label (names the endpoint for the owner). */
  fromLabel: string;
  /** The model that served instead — the admin's custom fallback (owner
   *  2026-09-15) or the built-in helper. */
  to: string;
  reason: string;
  httpStatus?: number;
  status: 'recovered' | 'failed' | 'unavailable';
  /** True when `to` is the admin's custom fallback rather than the built-in. */
  customFallback?: boolean;
}

/** The honest attribution the model/owner reads, e.g.
 *  "digest via qwen3.6-27b — custom helper seat cql (custom endpoint) failed: HTTP 400". */
export function helperSeatAttributionLine(f: Pick<HelperSeatFallback, 'from' | 'fromLabel' | 'to' | 'reason'>, noun = 'digest'): string {
  return `${noun} via ${f.to} — ${f.from.includes(':') ? 'custom helper seat' : 'helper seat'} ${f.fromLabel} (${f.from}) failed: ${f.reason}`;
}

export interface HelperSeatCompletion extends NonStreamingAnswer {
  /** The spec that ACTUALLY produced the answer (the seat, or the built-in on fallback). */
  model: string;
  /** Its provider label. */
  label: string;
  /** Present only when the custom seat failed and the built-in served. */
  fallback?: HelperSeatFallback;
  /** helperSeatAttributionLine(fallback) — present only on fallback. */
  attribution?: string;
}

/** Fire-and-forget seat_fallback telemetry. Dynamic import + fail-open keeps
 *  loop-metrics (prisma) off this module's load-time graph — the pipes are
 *  unit-tested without a database. */
async function recordSeatFallback(input: {
  fallback: Omit<HelperSeatFallback, 'fromLabel'> & { fromLabel?: string };
  caller: string;
  sessionId?: string;
  runId?: string;
}): Promise<void> {
  try {
    const { noteSeatFallback } = await import('../platform/loop-metrics.service');
    noteSeatFallback({
      role: input.fallback.role, from: input.fallback.from, to: input.fallback.to,
      reason: input.fallback.reason, status: input.fallback.status,
      caller: input.caller, httpStatus: input.fallback.httpStatus,
      sessionId: input.sessionId, runId: input.runId,
    });
  } catch { /* telemetry never takes the seat down */ }
}

/**
 * ONE non-streaming helper-seat completion with the health fallback. Resolves
 * the coding_helper seat (override or `builtIn`), runs it through
 * helper-completion (thinking-off directive, <think> stripping, empty answer
 * throws), and on a fallbackable CUSTOM-seat failure retries exactly once on
 * the built-in. Throws when: the seat is a built-in that failed (callers keep
 * their own honest fallback), the failure is a config error (401/403 / a colon
 * spec that no longer resolves / a keyless built-in), the kill switch is set,
 * the built-in is unservable on this instance, or the built-in fails too.
 */
export async function runHelperSeatCompletion(opts: {
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
  /** Log/telemetry label for the consumer ('web_pipe', 'youtube_pipe', …). */
  caller: string;
  /** The seat's hardcoded default (defaults to HELPER_MODEL). */
  builtIn?: string;
  userId?: string;
  sessionId?: string;
  runId?: string;
}): Promise<HelperSeatCompletion> {
  const builtIn = opts.builtIn ?? HELPER_MODEL;
  const spec = await resolveRoleModelForRun(HELPER_SEAT_ROLE, builtIn);
  const p = await resolveProviderForRun(spec, opts.userId, { fastSeat: true });
  // A colon spec that silently fell back to built-ins is a config error to
  // surface, not mask (that silent fallback IS the Edge 401 bug class).
  if (spec.includes(':') && !isCustomEndpoint(p)) {
    throw new Error(`coding_helper model "${spec}" no longer resolves to an enabled, [coding]-flagged endpoint model — fix or clear the role (Account → Admin → Endpoints)`);
  }
  // Built-in providers require their key (the old precise error); custom
  // endpoints may be keyless (Ollama/llama.cpp) — then send no auth header.
  if (!p.apiKey && !spec.includes(':')) throw new Error(`${p.envKey ?? 'API key'} not configured`);
  const call = { maxTokens: opts.maxTokens, temperature: opts.temperature, timeoutMs: opts.timeoutMs };
  let seatError: any;
  try {
    const answer = await runHelperCompletion(p, opts.messages, call);
    return { ...answer, model: spec, label: p.label };
  } catch (err: any) {
    seatError = err;
  }
  if (helperSeatFallbackDisabled()) throw seatError;
  // Owner 2026-09-15 ("add custom fallback"): the admin's fallback for the
  // Helper seat is tried FIRST — it also covers a failing BUILT-IN seat, which
  // has no other fallback (callers keep their own honest index-only digest).
  // Then the built-in, only when the seat itself was a custom endpoint. At
  // most two attempts after the seat; never a loop.
  const customFallback = await resolveRoleFallbackForRun(HELPER_SEAT_ROLE);
  const chain: string[] = [];
  if (customFallback && customFallback !== spec) chain.push(customFallback);
  if (isCustomEndpoint(p) && builtIn !== spec && !chain.includes(builtIn)) chain.push(builtIn);
  if (!chain.length) throw seatError;
  const failure = classifyHelperSeatFailure(seatError);
  if (!failure.fallbackable) throw seatError;
  let lastError: any = seatError;
  for (const to of chain) {
    const isCustomTo = to.includes(':');
    const base = { role: HELPER_SEAT_ROLE, from: spec, fromLabel: p.label, to, reason: failure.reason, httpStatus: failure.httpStatus, customFallback: isCustomTo };
    const pb = await resolveProviderForRun(to, opts.userId, { fastSeat: true });
    if (isCustomTo && !isCustomEndpoint(pb)) {
      logger.warn(`helper-seat [${opts.caller}]: helper seat ${p.label} (${spec}) failed (${failure.reason}) and its custom fallback ${to} no longer resolves — skipping it`, { source: 'helper-seat', caller: opts.caller, sessionId: opts.sessionId, runId: opts.runId, userId: opts.userId, from: spec, to });
      await recordSeatFallback({ fallback: { ...base, status: 'unavailable' }, caller: opts.caller, sessionId: opts.sessionId, runId: opts.runId });
      continue;
    }
    if (!pb.apiKey && !isCustomEndpoint(pb)) {
      logger.warn(`helper-seat [${opts.caller}]: helper seat ${p.label} (${spec}) failed (${failure.reason}) and the built-in ${to} cannot serve here (${pb.envKey ?? 'its API key'} not set) — no fallback`, { source: 'helper-seat', caller: opts.caller, sessionId: opts.sessionId, runId: opts.runId, userId: opts.userId, from: spec, to });
      await recordSeatFallback({ fallback: { ...base, status: 'unavailable' }, caller: opts.caller, sessionId: opts.sessionId, runId: opts.runId });
      continue;
    }
    logger.warn(`helper-seat [${opts.caller}]: ${spec.includes(':') ? 'custom helper seat' : 'helper seat'} ${p.label} (${spec}) failed (${failure.reason}) — retrying once on ${isCustomTo ? 'the admin\'s custom fallback' : 'the built-in'} ${to}`, { source: 'helper-seat', caller: opts.caller, sessionId: opts.sessionId, runId: opts.runId, userId: opts.userId, from: spec, to });
    try {
      const answer = await runHelperCompletion(pb, opts.messages, call);
      const fallback: HelperSeatFallback = { ...base, status: 'recovered' };
      await recordSeatFallback({ fallback, caller: opts.caller, sessionId: opts.sessionId, runId: opts.runId });
      return { ...answer, model: to, label: pb.label, fallback, attribution: helperSeatAttributionLine(fallback) };
    } catch (err2: any) {
      await recordSeatFallback({ fallback: { ...base, status: 'failed' }, caller: opts.caller, sessionId: opts.sessionId, runId: opts.runId });
      lastError = new Error(`${spec.includes(':') ? 'custom helper seat' : 'helper seat'} ${p.label} (${spec}) failed: ${failure.reason}; the ${isCustomTo ? `custom fallback ${to}` : `built-in ${to} fallback`} also failed: ${String(err2?.message || err2).slice(0, REASON_CAP)}`);
    }
  }
  throw lastError;
}

/**
 * Pure: should a helper-tier WORKER whose model turn the provider rejected
 * move to the built-in helper for the rest of its run? Returns the reason, or
 * null to leave the turn to the loop's normal recovery lanes.
 *
 * Only CUSTOM endpoints: a 4xx other than 401/403 (the prod 2026-09-14 shape —
 * "runModelTurn 400 fingerprint [spark-qwen3-4b-helper] tools=14": the gateway
 * rejects tool-bearing turns / the prompt shape outright, and no amount of
 * backoff or shrinking changes that), or a connection-level failure (the
 * server is not there). 429/5xx stay on the transient lane — a live server
 * that is momentarily busy needs TIME, not a different model. The worker's
 * turn is never retried tool-less on the same seat: a worker exists to run
 * tools, and a prose-only answer would narrate work it did not do.
 */
export function workerSeatFailureReason(
  provider: ProviderConfig,
  turn: { errorStatus?: number; errorMessage?: string; providerError?: string },
): string | null {
  if (!isCustomEndpoint(provider)) return null;
  const st = turn.errorStatus;
  if (typeof st === 'number') {
    if (st === 401 || st === 403) return null;
    if (st >= 400 && st < 500 && st !== 429) {
      const detail = turn.providerError ? ` — ${String(turn.providerError).slice(0, 160)}` : '';
      return `HTTP ${st}${detail}`.slice(0, REASON_CAP);
    }
    return null;
  }
  const conn = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)\b/.exec(turn.errorMessage || '');
  return conn ? conn[1] : null;
}
