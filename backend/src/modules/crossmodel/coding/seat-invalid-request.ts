/**
 * Deterministic "invalid request" rejections from a CUSTOM-endpoint seat —
 * classifier + per-seat LATCH (2026-09-27).
 *
 * The incident: the Fleet Supervisor seated on `cql-litellm:api-openai-gpt-6-
 * astra` got HTTP 400 on EVERY turn for 6 h (48 provider_rejected rows —
 * "Invalid 'tools': array too long … maximum length 128 … got 195", and, with
 * fewer tools, "Function tools with reasoning_effort are not supported for
 * gpt-6-astra in /v1/chat/completions"). Only 429 / 5xx / billing moved the
 * lead seat to its fallback (helper-seat.ts leadSeatHttpFailure); a 400 that
 * the capability regex did not match went to the backoff + shrink lanes and
 * was re-sent to the same model, wake after wake — a DETERMINISTIC rejection
 * treated as transient.
 *
 * The rule now: a 400 / 404 / 413 / 422 whose provider body carries one of
 * the deterministic fingerprints below (tools too long, reasoning_effort
 * unsupported, tools unsupported, unknown/unsupported parameter, model not
 * found, context too long) is an INVALID-REQUEST rejection: the run moves to
 * the seat's custom fallback then the built-in order AT ONCE (the same
 * pickLeadFallback path the 429 cooldown uses), and the (seat spec,
 * fingerprint) is LATCHED for SEAT_INVALID_REQUEST_LATCH_MIN minutes
 * (default 30) so no later run pays the rejection first. Genuine content
 * errors — the model ANSWERED — never come through here (they are not HTTP
 * errors); a 400 with no recognised fingerprint stays on the existing lanes
 * (the provider-side incident class of ticket 4251dcb3 is spurious and needs
 * time, not a re-seat).
 *
 * Process-local by design (each web/worker process latches its own share —
 * one rejected turn per process at most); the DB-backed surface is the
 * seat_fallback loop_metrics row every latch records (meta.latchedUntil),
 * which the admin Model roles page, the owner briefing and the project
 * status card read (loop-metrics listActiveSeatLatches).
 *
 * Classification always runs for telemetry; nothing is re-seated or latched
 * while the seat is unreachable. Pure leaf — the only
 * import is the tool-cap parser.
 */

import { parseToolCapFromError } from './provider-limits';

export type InvalidRequestKind =
  | 'tools_too_long'
  | 'reasoning_effort_unsupported'
  | 'tools_unsupported'
  | 'unsupported_param'
  | 'model_not_found'
  | 'context_too_long';

export interface InvalidRequestClass {
  kind: InvalidRequestKind;
  status: number;
  /** The provider's own words, whitespace-collapsed, bounded. */
  detail: string;
  /** tools_too_long only: the cap the body names, when it does. */
  cap?: number;
}

/** The statuses that can carry a deterministic invalid-request rejection. */
export const INVALID_REQUEST_STATUSES: ReadonlySet<number> = new Set([400, 404, 413, 422]);

export const TOOLS_TOO_LONG_RE = /(tools?|functions?)[^.]{0,80}?(array )?too long|maximum length \d+[^.]{0,60}(tools?|functions?|array)|too many (tools?|functions?)|at most \d+ (tools?|functions?)|(tools?|functions?)[^.]{0,40}(limit|maximum)[^.]{0,20}\d+|exceeds? the (maximum|max)[^.]{0,30}(tools?|functions?)/i;
export const REASONING_EFFORT_UNSUPPORTED_RE = /reasoning[_ -]?effort[^.]{0,160}(not supported|unsupported|not allowed|invalid|unknown)|(not supported|unsupported|unknown|unrecognized|invalid)[^.]{0,80}reasoning[_ -]?effort|use \/v1\/responses or set reasoning[_ -]?effort/i;
export const TOOLS_UNSUPPORTED_RE = /tool.?choice|tool.?call.?parser|enable-auto-tool-choice|does not support (tools?|function|tool.?calling)|tools? (is|are) not supported|function.?calling.{0,40}(not\s+|un)supported|tools? (are |is )?unsupported/i;
export const UNSUPPORTED_PARAM_RE = /unsupported (parameter|value|field)|unknown (parameter|field|argument)|unrecognized (request )?argument|is not (a )?(valid|supported|recognized) (parameter|argument|field)|response_format.{0,30}not supported|extra (fields?|inputs?) (are )?not permitted/i;
export const MODEL_NOT_FOUND_RE = /model[^.]{0,60}(not found|does not exist|doesn'?t exist|not exist|is not available|unavailable|invalid model|unknown model)|no such model|not a valid model|unknown model|model_not_found|invalid_model|no model (named|called)|\bmodel group\b[^.]{0,80}\b(not found|does not exist|no deployments?|unknown)/i;
/** Shared with agent.ts's size lane — a body that names the size/token cause. */
export const CONTEXT_TOO_LONG_RE = /context.?length|too many tokens|maximum context|too large|reduce the (length|size)|request.{0,24}(too large|too long)|prompt is too long|exceed.{0,32}(context|token|length|limit)|(长度|上下文|令牌|token).{0,12}(超出|超过|限制)|(超出|超过).{0,12}(限制|长度|上下文|令牌)/i;
const BILLING_RE = /insufficient balance|exceeded_current_quota|suspended due to|billing details|account\b.{0,40}\bsuspended/i;

const DETAIL_CAP = 300;

/**
 * Pure: classify ONE failed turn. Null = not a deterministic invalid-request
 * rejection (leave it to the transient / size / billing / auth lanes).
 */
export function classifyInvalidRequest(turn: { errorStatus?: number; providerError?: string; errorMessage?: string }): InvalidRequestClass | null {
  const status = turn.errorStatus;
  if (typeof status !== 'number' || !INVALID_REQUEST_STATUSES.has(status)) return null;
  const raw = String(turn.providerError || turn.errorMessage || '');
  const text = raw.replace(/\s+/g, ' ').trim();
  if (BILLING_RE.test(text)) return null; // the billing lane owns it
  const detail = text.length > DETAIL_CAP ? `${text.slice(0, DETAIL_CAP)}…` : text;
  const mk = (kind: InvalidRequestKind, extra?: Partial<InvalidRequestClass>): InvalidRequestClass => ({ kind, status, detail, ...extra });
  if (TOOLS_TOO_LONG_RE.test(text)) {
    const cap = parseToolCapFromError(text);
    return mk('tools_too_long', cap ? { cap } : {});
  }
  if (REASONING_EFFORT_UNSUPPORTED_RE.test(text)) return mk('reasoning_effort_unsupported');
  if (TOOLS_UNSUPPORTED_RE.test(text)) return mk('tools_unsupported');
  if (status === 404 || MODEL_NOT_FOUND_RE.test(text)) return mk('model_not_found');
  if (status === 413 || CONTEXT_TOO_LONG_RE.test(text)) return mk('context_too_long');
  if (UNSUPPORTED_PARAM_RE.test(text)) return mk('unsupported_param');
  return null;
}

// ── Provider CONTENT FILTER (audit 2026-10-08 W2-4) ──────────────────────────
// Alibaba's moderation 400 — `InternalError.Algo.DataInspectionFailed: Input
// text data may contain inappropriate content` (qwen3.8-max via LiteLLM, the
// One Piece "leak / spoiler trackers" lanes) — matched no fingerprint above,
// so it took the spurious-400 transient lane: 5 backoffs of the IDENTICAL
// payload (9/30/71/133/280 s), then two useless context shrinks, then a run
// failure "too large or malformed" after 87 min (run 45c4f136). Time and
// shrinking cannot change what the provider inspected. The agent loop now
// fails the TURN over to the next seat in the chain once (no latch — the seat
// is fine for other content), tells the model in one line, and otherwise ends
// the run with an honest note. Kill switch CONTENT_FILTER_LANE_DISABLED=1
// restores the transient / size lanes.

export const CONTENT_FILTER_RE = /DataInspectionFailed|data[_ ]inspection[_ ]failed|inappropriate[_ ]content|content[_ -]?filter(?:ed|ing)?\b|content[_ ]management[_ ]policy|content[_ ]policy[_ ]violation|responsible ?AI (?:service )?policy|flagged by (?:the )?(?:content |safety )?moderation|moderation[_ ](?:block(?:ed)?|reject(?:ed|ion)?)/i;

/** The statuses a provider content-filter rejection arrives with (DashScope / OpenAI / Azure: 400; some gateways 403 / 422). */
export const CONTENT_FILTER_STATUSES: ReadonlySet<number> = new Set([400, 403, 422]);

export function contentFilterLaneDisabled(): boolean {
  const v = String(process.env.CONTENT_FILTER_LANE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export interface ContentFilterRejection {
  status: number;
  /** The provider's own words, whitespace-collapsed, bounded. */
  detail: string;
}

/** Pure: is this failed turn a provider content-filter rejection? */
export function classifyContentFilter(turn: { errorStatus?: number; providerError?: string; errorMessage?: string }): ContentFilterRejection | null {
  const status = turn.errorStatus;
  if (typeof status !== 'number' || !CONTENT_FILTER_STATUSES.has(status)) return null;
  const text = String(turn.providerError || turn.errorMessage || '').replace(/\s+/g, ' ').trim();
  if (!CONTENT_FILTER_RE.test(text)) return null;
  return { status, detail: text.length > DETAIL_CAP ? `${text.slice(0, DETAIL_CAP)}…` : text };
}

/** The ONE line the model is told after a content-filter failover (user-role harness framing). Pure. */
export function contentFilterModelNote(o: { from: string; to: string }): string {
  return `[HARNESS NOTICE — not typed by the user] The model provider of ${o.from} REFUSED the last request with its content filter (it judged text in this conversation — usually a recent scraped / fetched tool result — inappropriate). Nothing was lost; this run continues on ${o.to}. Do not re-fetch or quote the flagged material verbatim; summarise it in your own words if you still need it.`;
}

/** Short human label per kind (progress lines, notes, badges). */
export const INVALID_REQUEST_KIND_LABELS: Record<InvalidRequestKind, string> = {
  tools_too_long: 'tool list over the model\'s limit',
  reasoning_effort_unsupported: 'reasoning_effort not supported with tools',
  tools_unsupported: 'tool calling not supported',
  unsupported_param: 'unsupported request parameter',
  model_not_found: 'model not found on the endpoint',
  context_too_long: 'context too long for the model',
};

// ── Latch window ─────────────────────────────────────────────────────────────

export const SEAT_INVALID_REQUEST_LATCH_MIN_DEFAULT = 30;

/** env SEAT_INVALID_REQUEST_LATCH_MIN (minutes, default 30; 0 = no latch). */
export function seatInvalidRequestLatchMs(): number {
  const raw = String(process.env.SEAT_INVALID_REQUEST_LATCH_MIN ?? '').trim();
  const n = raw ? Number(raw) : SEAT_INVALID_REQUEST_LATCH_MIN_DEFAULT;
  if (!Number.isFinite(n) || n < 0) return SEAT_INVALID_REQUEST_LATCH_MIN_DEFAULT * 60_000;
  return Math.floor(n * 60_000);
}

export interface SeatInvalidRequestLatch {
  /** The seat spec that was rejected ('<label>:<modelId>'). */
  spec: string;
  kind: InvalidRequestKind;
  status: number;
  reason: string;
  since: number;
  until: number;
  strikes: number;
}

const latches = new Map<string, SeatInvalidRequestLatch>();

function latchKey(spec: string): string {
  return String(spec ?? '').trim();
}

/** Latch (spec, fingerprint) for the window. Re-latching extends the window and counts the strike. */
export function latchSeatInvalidRequest(spec: string, cls: InvalidRequestClass, now: number = Date.now()): SeatInvalidRequestLatch | null {
  const key = latchKey(spec);
  if (!key) return null;
  const windowMs = seatInvalidRequestLatchMs();
  if (windowMs <= 0) return null;
  const prev = latches.get(key);
  const entry: SeatInvalidRequestLatch = {
    spec: key,
    kind: cls.kind,
    status: cls.status,
    reason: `${INVALID_REQUEST_KIND_LABELS[cls.kind]}${cls.detail ? ` — ${cls.detail}` : ''}`.slice(0, 400),
    since: prev && prev.until > now ? prev.since : now,
    until: now + windowMs,
    strikes: prev && prev.until > now ? prev.strikes + 1 : 1,
  };
  latches.set(key, entry);
  return entry;
}

/** The live latch for a seat spec, or null (expired entries are dropped). */
export function seatInvalidRequestLatch(spec: string, now: number = Date.now()): SeatInvalidRequestLatch | null {
  const key = latchKey(spec);
  const e = latches.get(key);
  if (!e) return null;
  if (e.until <= now) { latches.delete(key); return null; }
  return e;
}

export function listSeatInvalidRequestLatches(now: number = Date.now()): SeatInvalidRequestLatch[] {
  const out: SeatInvalidRequestLatch[] = [];
  for (const [key, e] of latches) {
    if (e.until <= now) { latches.delete(key); continue; }
    out.push(e);
  }
  return out.sort((a, b) => a.since - b.since);
}

export function clearSeatInvalidRequestLatch(spec: string): void {
  latches.delete(latchKey(spec));
}

/** Test seam. */
export function __resetSeatInvalidRequestLatchesForTests(): void {
  latches.clear();
}

// ── Owner-facing line ────────────────────────────────────────────────────────

export interface SeatLatchLineEntry {
  role?: string | null;
  from: string;
  to?: string | null;
  reason: string;
  /** ISO or epoch ms. */
  since: string | number;
  until?: string | number | null;
}

const clock = (t: string | number | null | undefined): string => {
  if (t === null || t === undefined || t === '') return '?';
  const d = new Date(t);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '?';
};

/** "seat X unusable: <reason> — running on Y since <t> (retried after <t2>)" per latched seat; null when none. Pure. */
export function seatLatchLine(entries: ReadonlyArray<SeatLatchLineEntry>): string | null {
  const parts: string[] = [];
  for (const e of entries) {
    const seat = e.role ? `${e.role} seat ${e.from}` : `seat ${e.from}`;
    const running = e.to ? ` — running on ${e.to} since ${clock(e.since)}` : ` since ${clock(e.since)} (no fallback available)`;
    const retry = e.until ? ` (retried after ${clock(e.until)})` : '';
    parts.push(`${seat} unusable: ${String(e.reason).slice(0, 200)}${running}${retry}`);
  }
  return parts.length ? parts.join(' · ') : null;
}
