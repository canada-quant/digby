/**
 * Context gauge + tier-1 clearing SHADOW + the chat fast path — build
 * 2026-10-08 C (context.md: Option A now, Option B in shadow).
 *
 * WHY (context.md §1): lane compaction nearly stopped after the 10-06 / 10-08
 * budget fixes, and the exposure moved to APPEND-ONLY transcripts that grow
 * large (gateway GLM lanes peak at a median 153k prompt tokens, 92 % of their
 * input tokens are spent in runs past 128k) while the prompt cache now earns
 * ~97 % on them. Any prefix edit throws that cache away, so a context edit
 * must be rare and batched — and nobody can tune that without per-turn data.
 * Meanwhile chat turns still block ~9 s on every LLM compaction (66 turns in
 * 45 h, up to 9 compactions in one turn).
 *
 * This module adds, behind switches:
 *  - the GAUGE (CONTEXT_GAUGE_DISABLED=1 drops all of it): per-turn prompt /
 *    cached tokens for the `context` event, ONE `context_edit` row per
 *    pre-rot threshold a run crosses (128k / 200k prompt tokens), and ONE
 *    run-summary row (peak, tokens spent above 128k / 200k, cache breaks,
 *    cache-aware list-priced $ and the no-cache $);
 *  - TIER 1 (same gauge switch): every turn it computes what a batched,
 *    cache-aware tool-result clear WOULD do (trigger 160k prompt tokens, keep
 *    the last 5 tool rounds, clear_at_least 40k tokens, down to 0.6·T), keeps
 *    a counterfactual of what it cleared, and records one `context_edit` row
 *    per would-clear event (tokens freed, edit position, the one-time cache
 *    break $) plus the run's projected net list-priced $ saving. Since build
 *    2026-10-11 T1 (owner order "turn everything remaining on"; context.md §4
 *    stages 3–4) it ACTS: a randomized TREATMENT arm of top-level runs gets the
 *    batched edit for real (tier1Act — stubs with a 400-char head, a steer
 *    guard, `tier1_act` rows with predicted vs observed cached tokens), the
 *    CONTROL arm (default 20 %) keeps today's behaviour and its shadow rows,
 *    and the run summary carries the arm + the stage-3 bar's inputs (outcomes,
 *    guardrails). Switch CONTEXT_CLEARING_ENABLED = off | shadow | act[:share];
 *    readout scripts/framework-audit/context-clearing-readout.js;
 *  - the CHAT FAST PATH (CHAT_CONTEXT_CLEARING = off | shadow | canary | act,
 *    default canary): on a chat seat with a ≤150k-char budget, a compaction
 *    trigger first tries a deterministic clear of old tool results (no network
 *    call); it ACTS for the owner canary (or everyone under `act`) only when
 *    the clear gets the transcript under the trigger, and otherwise the LLM
 *    summariser runs exactly as before (tier 2). Everyone else gets a shadow
 *    row saying what the clear would have done.
 *
 * Prices come from cost.ts priceFor (list rates; the cached-input rate when a
 * model documents one) so the dollar fields move with the price table.
 */

import { createHash } from 'crypto';
import { priceFor, type Price } from './cost';
import { recordLoopMetric, type MetricStamp } from '../platform/loop-metrics.service';
import {
  applyToolResultClears,
  clearOldToolResults,
  clearableToolResults,
  roughMessageChars,
  stubForResult,
  CLEAR_EXEMPT_TOOLS,
  type ClearPick,
  type ContextMessage,
} from './context-clearing';

/** The ONE loop_metrics kind for every row this module (and the history repair) writes — meta.event discriminates. */
export const CONTEXT_EDIT_KIND = 'context_edit';

/** The owner canary (build 2026-10-08 engineering rules). */
export const OWNER_CANARY_USER_ID = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

function envOn(name: string): boolean {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Kill switch for the gauge + the tier-1 shadow (rows, `context` event fields). */
export function contextGaugeDisabled(): boolean { return envOn('CONTEXT_GAUGE_DISABLED'); }

// ── Chat fast path ───────────────────────────────────────────────────────────

export type ChatClearingMode = 'off' | 'shadow' | 'canary' | 'act';

/** CHAT_CONTEXT_CLEARING: off | shadow | canary (default) | act. */
export function chatContextClearingMode(): ChatClearingMode {
  const v = String(process.env.CHAT_CONTEXT_CLEARING ?? '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false' || v === 'disabled') return 'off';
  if (v === 'shadow') return 'shadow';
  if (v === 'act' || v === 'on' || v === '1' || v === 'true') return 'act';
  return 'canary';
}

/** Chat seats above this budget (supervisors' 1M chars) keep the summariser — context.md Option A item 4. */
export const CHAT_CLEARING_MAX_BUDGET_CHARS = 150_000;
/** Clear down to this share of the budget (the compaction trigger is 0.7) — one batched edit, headroom for the next steps. */
export const CHAT_CLEAR_TARGET_RATIO = 0.5;
/** The newest tool rounds are never cleared. */
export const CHAT_CLEAR_KEEP_ROUNDS = 2;
/** A result under this is not worth a stub. */
export const CHAT_CLEAR_MIN_RESULT_CHARS = 1_200;
/** Head kept inside each stub — what the LLM summariser saw of a tool result (compaction.ts `brief`: 400 chars). */
export const CHAT_CLEAR_HEAD_CHARS = 400;

/**
 * Whether a compaction trigger on this run tries the chat fast path, and in
 * which mode. Null = not a chat seat with a small budget, or switched off.
 */
export function chatClearingDecision(o: { profileKind: string; budgetChars: number; userId?: string | null }): 'act' | 'shadow' | null {
  if (o.profileKind !== 'chat') return null;
  if (!(o.budgetChars > 0) || o.budgetChars > CHAT_CLEARING_MAX_BUDGET_CHARS) return null;
  const mode = chatContextClearingMode();
  if (mode === 'off') return null;
  if (mode === 'act') return 'act';
  if (mode === 'canary' && o.userId === OWNER_CANARY_USER_ID) return 'act';
  return 'shadow';
}

/**
 * The chat fast path at a compaction trigger. Records ONE `context_edit` row
 * (event 'chat_clear', outcome cleared | shadow | insufficient |
 * nothing_clearable) and returns the cleared transcript ONLY when acting AND
 * the clear got it at or under the trigger — otherwise null, and the caller
 * runs the summariser exactly as before. Never throws.
 */
export function chatFastPathClear(
  messages: ReadonlyArray<ContextMessage>,
  o: {
    decision: 'act' | 'shadow';
    beforeChars: number;
    budgetChars: number;
    triggerChars: number;
    step: number;
    sessionId?: string;
    runId?: string;
    stamp?: MetricStamp;
  },
): ContextMessage[] | null {
  try {
    const t0 = Date.now();
    const r = clearOldToolResults(messages, {
      beforeChars: o.beforeChars,
      targetChars: Math.floor(o.budgetChars * CHAT_CLEAR_TARGET_RATIO),
      keepRecentRounds: CHAT_CLEAR_KEEP_ROUNDS,
      minResultChars: CHAT_CLEAR_MIN_RESULT_CHARS,
      headChars: CHAT_CLEAR_HEAD_CHARS,
    });
    const below = !!r && r.afterChars <= o.triggerChars;
    const outcome = !r ? 'nothing_clearable' : !below ? 'insufficient' : o.decision === 'act' ? 'cleared' : 'shadow';
    recordLoopMetric({
      kind: CONTEXT_EDIT_KIND,
      sessionId: o.sessionId, runId: o.runId, stamp: o.stamp,
      value: r?.freedChars ?? 0, unit: 'chars',
      meta: {
        event: 'chat_clear', outcome, decision: o.decision, step: o.step,
        beforeChars: o.beforeChars, afterChars: r?.afterChars ?? o.beforeChars, freedChars: r?.freedChars ?? 0,
        cleared: r?.cleared ?? 0, triggerChars: o.triggerChars, budgetChars: o.budgetChars,
        ...(r ? { firstClearedIndex: r.firstClearedIndex, tools: r.tools } : {}),
        ms: Date.now() - t0,
      },
    });
    return o.decision === 'act' && below && r ? r.messages : null;
  } catch {
    return null; // the summariser path stays exactly as before
  }
}

// ── Gauge + tier 1 (shadow → act) ────────────────────────────────────────────

/** Pre-rot thresholds (prompt tokens) — one alarm row per run per threshold. */
export const PREROT_TOKEN_THRESHOLDS: ReadonlyArray<number> = [128_000, 200_000];
/** Tier-1 trigger T: provider-reported prompt tokens (start 160k for 1M-window seats — context.md Option B). */
export const TIER1_TRIGGER_TOKENS = 160_000;
/** Tool rounds kept raw (K of context.md: the last 5 assistant tool rounds are never cleared). */
export const TIER1_KEEP_ROUNDS = 5;
/** clear_at_least: an edit must free at least this much or it does not happen (the cache rule). */
export const TIER1_CLEAR_AT_LEAST_TOKENS = 40_000;
/** One edit brings the prompt down to this share of T. */
export const TIER1_TARGET_RATIO = 0.6;
/**
 * Head of the original kept inside every tier-1 stub (build 2026-10-11 T1) — the chat fast path's shape
 * (CHAT_CLEAR_HEAD_CHARS): the call's name + args, the first 400 chars and how to restore it (re-run the call).
 * The shadow models the SAME stub, so a control arm's tier1_shadow rows predict exactly what a treated run does.
 */
export const TIER1_HEAD_CHARS = CHAT_CLEAR_HEAD_CHARS;
/** Results under this many chars are never cleared — a 400-char-head stub would free almost nothing (= the chat fast path). */
export const TIER1_MIN_RESULT_CHARS = CHAT_CLEAR_MIN_RESULT_CHARS;
/**
 * The STEER GUARD (build 2026-10-11 T1; context.md stage-2/3 bar "no event within the last K turns of a steer"):
 * no tier-1 edit while fewer than K assistant turns have passed since the newest steer (every origin's steer
 * carries STEER_MARKER_TEXT — steer-framing.ts) or owner-typed user message (the task, a human turn).
 * K = 5 = TIER1_KEEP_ROUNDS, chosen because (1) it is the bar's own K — the kept-raw window; (2) a steer's first
 * actions (the reads / edits it asks for) happen in the rounds right after it, and those rounds stay verbatim AND
 * the cache stays warm while the model executes the steer — an edit there is the amnesia + cache-break combination
 * the pre-T1 regime showed (run 8abce324 lost a steer to compaction and re-read for 84 compactions); (3) the cost of
 * waiting is bounded: ~5 rounds of growth (GLM lanes add ~2–5k prompt tokens a round) before the deferred edit
 * fires on the next reading; measured on prod: of the 54 tier1_shadow would-clear events 2026-10-09..11, 0 fell
 * within 5 turns of a steer (3 at 5–9, 7 at ≥ 10, 44 with none) — K = 5 protects every steer and costs no edit
 * we have seen, where K = 10 would have deferred 3 of 54. Deferred turns are counted (`t1SteerBlockedTurns`).
 */
export const TIER1_STEER_GUARD_TURNS = TIER1_KEEP_ROUNDS;
/**
 * Never cleared by tier 1 on top of CLEAR_EXEMPT_TOOLS (plan, verify, supervisor state, worker digests, asks):
 * todo / goal state, the receipts a claim may cite (get_run_receipts), the supervisor's own state writes,
 * finish_run and background-worker status.
 */
export const TIER1_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  ...CLEAR_EXEMPT_TOOLS,
  'todo_list', 'todo_get', 'todo_create', 'todo_update',
  'goal_list', 'goal_get', 'goal_create', 'goal_update', 'goal_premise_set',
  'get_run_receipts', 'update_supervisor_state', 'finish_run', 'delegate_status',
]);
/** Cap on the cleared ORIGINALS a run carries in its checkpoint for the evidence guard's resume haystack (newest kept). */
export const TIER1_CLEARED_TEXTS_MAX_CHARS = 2_000_000;
/** A turn whose cached tokens fall under this share of the previous prompt broke the cache. */
export const CACHE_BREAK_RATIO = 0.5;
/** …counted only when the previous prompt was at least this large (tiny prompts have no cache to break). */
export const CACHE_BREAK_MIN_PREV_TOKENS = 20_000;
/** chars per token for the tier-1 estimates. */
export const CHARS_PER_TOKEN = 4;
/** = compaction.ts STEER_MARKER (pinned equal by context-gauge.test.ts; not imported so this module stays light). */
export const STEER_MARKER_TEXT = 'treat it as a live steering instruction';

// ── Tier 1: the ONE switch + the randomized arms (build 2026-10-11 T1) ───────

/**
 * build 2026-10-11 T1 (owner order 2026-10-11 "turn everything remaining on"; context.md §4 stages 3–4): the ONE
 * switch for tier 1 — `CONTEXT_CLEARING_ENABLED` = `off` | `shadow` | `act[:<controlShare>]`. Unset / blank = `act`
 * with a 20 % CONTROL arm. `shadow` restores the build 2026-10-08 C behaviour (rows only, no prompt edit) — the
 * rollback; `off` stops tier 1 entirely (gauge rows stay — CONTEXT_GAUGE_DISABLED=1 is the whole gauge). An
 * unrecognised value never acts (shadow); a malformed share keeps the default share. The name carries the registry's
 * switch suffix so CI tracks it (platform/switch-registry.ts).
 */
export type Tier1Mode = 'off' | 'shadow' | 'act';
/** treatment = tier 1 edits the prompt; control = today's behaviour (shadow rows); shadow / off = the switch's mode for every run. */
export type Tier1Arm = 'treatment' | 'control' | 'shadow' | 'off';
export const TIER1_DEFAULT_CONTROL_SHARE = 0.2;
export interface Tier1Config { mode: Tier1Mode; controlShare: number; valid: boolean }

export function tier1ClearingConfig(env: NodeJS.ProcessEnv = process.env): Tier1Config {
  const raw = String(env.CONTEXT_CLEARING_ENABLED ?? '').trim().toLowerCase();
  const dflt: Tier1Config = { mode: 'act', controlShare: TIER1_DEFAULT_CONTROL_SHARE, valid: true };
  if (!raw) return dflt;
  const colon = raw.indexOf(':');
  const head = (colon === -1 ? raw : raw.slice(0, colon)).trim();
  const tail = colon === -1 ? undefined : raw.slice(colon + 1).trim();
  if (tail === undefined && ['off', '0', 'false', 'no', 'disabled'].includes(head)) return { ...dflt, mode: 'off' };
  if (tail === undefined && head === 'shadow') return { ...dflt, mode: 'shadow' };
  if (['act', 'on', '1', 'true', 'yes'].includes(head)) {
    if (tail === undefined || tail === '') return dflt;
    const share = Number(tail);
    return Number.isFinite(share) && share >= 0 && share <= 1 ? { ...dflt, controlShare: share } : { ...dflt, valid: false };
  }
  return { ...dflt, mode: 'shadow', valid: false };
}

/**
 * The run's arm. Under `act` it is a deterministic hash of the run id (a resumed run keeps its arm), so `controlShare`
 * of the runs stay on today's behaviour — the stage-3 A/B. No run id ⇒ `rand()`. Pure given `rand`.
 */
export function tier1ArmFor(cfg: Tier1Config, runId?: string | null, rand: () => number = Math.random): Tier1Arm {
  if (cfg.mode !== 'act') return cfg.mode;
  const u = runId
    ? parseInt(createHash('sha256').update(`tier1-arm:${runId}`).digest('hex').slice(0, 8), 16) / 0x1_0000_0000
    : rand();
  return u < cfg.controlShare ? 'control' : 'treatment';
}

// ── Tier 1: the planner (shared by the act path and the shadow) ──────────────

function userText(m: ContextMessage | null | undefined): string {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p: any) => (p?.type === 'text' ? String(p.text ?? '') : '')).join(' ');
  return '';
}

/**
 * A steer (any origin — every steer header carries STEER_MARKER_TEXT) or a user message that is NOT harness-framed:
 * every harness-injected user message opens with '[' ([HARNESS …], [BACKGROUND WORKER REPORT …], [REFLECT …],
 * [MACHINE-TRIGGERED RUN …]), so what is left is the owner's own words — the run's task or a human turn. Pure.
 */
export function isSteerOrOwnerMessage(m: ContextMessage | null | undefined): boolean {
  if (m?.role !== 'user') return false;
  const t = userText(m);
  if (t.includes(STEER_MARKER_TEXT)) return true;
  return t.trim().length > 0 && !t.trimStart().startsWith('[');
}

/** Assistant turns since the newest steer / owner message (null: none in the transcript). Pure. */
export function turnsSinceSteerOrOwner(messages: ReadonlyArray<ContextMessage>): number | null {
  let turns = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isSteerOrOwnerMessage(m)) return turns;
    if (m?.role === 'assistant') turns += 1;
  }
  return null;
}

export interface Tier1Pick extends ClearPick { freedTokens: number }
export interface Tier1Plan {
  status: 'below_trigger' | 'steer_guard' | 'insufficient' | 'clear';
  picks: Tier1Pick[];
  freedTokens: number;
  freeableTokens: number;
  needTokens: number;
  /** transcript index of the oldest pick — the cache edit point (-1 when nothing is picked) */
  editIndex: number;
  turnsSinceAnchor: number | null;
}

/**
 * ONE batched, cache-aware tier-1 decision over `messages` at a prompt of `promptTokens` (provider-reported for the
 * act path; the counterfactual for the shadow). Nothing below T; nothing inside the steer guard; nothing unless
 * ≥ clear_at_least is freeable outside the last K rounds; otherwise OLDEST-first results until the prompt would be
 * at 0.6·T. A result's freed tokens = its tokens minus its stub's. Pure.
 */
export function planTier1Clear(messages: ReadonlyArray<ContextMessage>, o: { promptTokens: number; skipIds?: ReadonlySet<string> }): Tier1Plan {
  const turnsSinceAnchor = turnsSinceSteerOrOwner(messages);
  const empty = { picks: [] as Tier1Pick[], freedTokens: 0, freeableTokens: 0, needTokens: 0, editIndex: -1, turnsSinceAnchor };
  if (!(o.promptTokens > TIER1_TRIGGER_TOKENS)) return { status: 'below_trigger', ...empty };
  if (turnsSinceAnchor !== null && turnsSinceAnchor < TIER1_STEER_GUARD_TURNS) return { status: 'steer_guard', ...empty };
  const tok = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
  const scored: Tier1Pick[] = [];
  for (const c of clearableToolResults(messages, { keepRecentRounds: TIER1_KEEP_ROUNDS, minResultChars: TIER1_MIN_RESULT_CHARS, exemptTools: TIER1_EXEMPT_TOOLS, skipIds: o.skipIds })) {
    const original = String(messages[c.index].content);
    const freedTokens = tok(original.length) - tok(stubForResult(original, c.tool, c.args, TIER1_HEAD_CHARS).length);
    if (freedTokens > 0) scored.push({ index: c.index, toolCallId: c.toolCallId, tool: c.tool, args: c.args, freedTokens });
  }
  const freeableTokens = scored.reduce((s, x) => s + x.freedTokens, 0);
  const needTokens = Math.max(TIER1_CLEAR_AT_LEAST_TOKENS, o.promptTokens - Math.floor(TIER1_TRIGGER_TOKENS * TIER1_TARGET_RATIO));
  if (freeableTokens < TIER1_CLEAR_AT_LEAST_TOKENS) return { status: 'insufficient', ...empty, freeableTokens, needTokens };
  const picks: Tier1Pick[] = [];
  let freed = 0;
  for (const x of scored) {
    if (freed >= needTokens) break;
    picks.push(x);
    freed += x.freedTokens;
  }
  return { status: 'clear', picks, freedTokens: freed, freeableTokens, needTokens, editIndex: picks[0]?.index ?? -1, turnsSinceAnchor };
}

/** Keep the newest cleared originals under TIER1_CLEARED_TEXTS_MAX_CHARS (mutates `into`). Pure on its inputs. */
export function keepClearedTexts(into: string[], add: ReadonlyArray<string>, maxChars = TIER1_CLEARED_TEXTS_MAX_CHARS): void {
  into.push(...add);
  let total = into.reduce((s, t) => s + t.length, 0);
  while (into.length && total > maxChars) total -= into.shift()!.length;
}

/** What tier1Act hands the loop: the edited transcript + the cleared originals (evidence haystack). */
export interface Tier1ActResult { messages: ContextMessage[]; originals: string[]; cleared: number; freedTokens: number }

export interface GaugeUsage { promptTokens: number; completionTokens: number; cachedTokens?: number }

/** The per-turn fields the `context` event carries (sidebar / replay). */
export interface GaugeTurnView { promptTokens: number; cachedTokens?: number; cacheHit?: number }

/** A tool call the model emitted this turn (agent.ts StreamedToolCall — name + raw arguments). */
export interface GaugeToolCall { name: string; arguments?: string }

/** The run's receipts (run-receipts.ts ToolReceipt — only the fields the outcome count reads). */
export interface GaugeReceipt { tool: string; ok: boolean; ids?: Record<string, unknown> | null }

const usd = (n: number): number => Math.round(n * 1e6) / 1e6;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Whitespace-insensitive call signature (a re-issued call with re-spaced JSON args is the same call). */
function callSig(name: string, args: string | undefined): string {
  let a = String(args ?? '');
  try { a = JSON.stringify(JSON.parse(a || '{}')); } catch { /* raw */ }
  return createHash('sha1').update(`${name}\u0000${a}`).digest('hex');
}

function readPathOf(args: string | undefined): string | null {
  try {
    const v = JSON.parse(String(args ?? '') || '{}');
    const p = v?.path ?? v?.file_path ?? v?.file;
    return typeof p === 'string' && p.trim() ? p.trim() : null;
  } catch { return null; }
}

/** The act event awaiting the provider's report on the first request after it. */
interface PendingAct {
  step: number; model: string; promptBefore: number; freedTokens: number; freedChars: number; cleared: number;
  editIndex: number; transcriptMessages: number; needTokens: number; freeableTokens: number;
  predictedCachedTokens: number; predictedBreakTokens: number; breakUsdPredicted: number;
  turnsSinceAnchor: number | null; tools: Record<string, number>; eventN: number; inRate: number; cachedRate: number;
}

export class ContextGauge {
  private readonly priceOf: (model: string) => Price;
  /** build 2026-10-11 T1: the switch as read at run start + this run's arm. */
  readonly tier1: Tier1Config;
  readonly arm: Tier1Arm;
  private turns = 0;
  private providerTurns = 0;
  private peak = 0;
  private sumPrompt = 0;
  private sumCached = 0;
  private cacheReported = false;
  private above: Record<number, { tokens: number; turns: number }> = {};
  private prerotFired = new Set<number>();
  private cacheBreaks = 0;
  private prevPrompt: number | undefined;
  private costUsd = 0;
  private noCacheUsd = 0;
  private lastModel = '';
  // tier-1 counterfactual (shadow / control): tool_call_id → tokens the stub would have freed
  private shadowCleared = new Map<string, number>();
  // tier-1 act (treatment): tool_call_id → tokens its stub freed
  private actCleared = new Map<string, number>();
  private pendingAct: PendingAct | null = null;
  private lastPrompt = 0;
  private lastRequestLen = 0;
  private lastPrice: Price | null = null;
  private actArmed = false; // a fresh provider reading since the last act decision
  private t1Eligible = false;
  private t1Events = 0;
  private t1Freed = 0;
  private t1BreakUsd = 0;
  private t1BreakObservedUsd = 0;
  private t1SavingUsd = 0;
  private t1Blocked = 0;
  private t1SteerBlocked = 0;
  private t1PeakSimPrompt = 0;
  // stage-3 guardrails (context.md §4): duplicate calls, reads per file, search_memory, re-reads of cleared results
  private toolCalls = 0;
  private dupCalls = 0;
  private callSigs = new Set<string>();
  private readFileCalls = 0;
  private readPaths = new Set<string>();
  private searchMemoryCalls = 0;
  private verifyCalls = 0;
  private clearedSigs = new Set<string>();
  private reReads = 0;
  private finished = false;

  constructor(private readonly o: {
    sessionId?: string; runId?: string; stamp?: MetricStamp; profile: string; priceOf?: (model: string) => Price;
    /** tests: the switch value / the arm's random source (default: process.env / Math.random) */
    tier1?: Tier1Config; rand?: () => number;
  }) {
    this.priceOf = o.priceOf ?? priceFor;
    this.tier1 = o.tier1 ?? tier1ClearingConfig();
    this.arm = tier1ArmFor(this.tier1, o.runId, o.rand);
  }

  private record(value: number, unit: string, meta: Record<string, unknown>): void {
    try {
      recordLoopMetric({ kind: CONTEXT_EDIT_KIND, sessionId: this.o.sessionId, runId: this.o.runId, stamp: this.o.stamp, value, unit, meta });
    } catch { /* telemetry never breaks a run */ }
  }

  /** Stage-3 guardrail counters over the calls the model emitted this turn. Never throws. */
  private countToolCalls(calls: ReadonlyArray<GaugeToolCall> | null | undefined): void {
    if (!Array.isArray(calls)) return;
    for (const c of calls) {
      if (!c || typeof c.name !== 'string') continue;
      this.toolCalls += 1;
      const sig = callSig(c.name, c.arguments);
      if (this.callSigs.has(sig)) this.dupCalls += 1; else this.callSigs.add(sig);
      if (this.clearedSigs.delete(sig)) this.reReads += 1; // the model re-ran a call whose result tier 1 cleared
      if (c.name === 'read_file') {
        this.readFileCalls += 1;
        const p = readPathOf(c.arguments);
        if (p) this.readPaths.add(p);
      } else if (c.name === 'search_memory') this.searchMemoryCalls += 1;
      else if (c.name === 'verify') this.verifyCalls += 1;
    }
  }

  /**
   * Observe ONE served model turn (after the meter recorded it). Estimated
   * turns (no provider usage) count as turns but never feed token analytics —
   * their prompt size is a chars/4 artifact. Returns the per-turn view for the
   * `context` event, or null. Never throws.
   */
  observeTurn(t: { step: number; model: string; usage?: GaugeUsage | null; messages: ReadonlyArray<ContextMessage>; toolCalls?: ReadonlyArray<GaugeToolCall> | null }): GaugeTurnView | null {
    try {
      this.turns += 1;
      this.countToolCalls(t.toolCalls);
      const u = t.usage;
      if (!u || !(u.promptTokens > 0)) return null;
      this.lastModel = t.model;
      const prompt = u.promptTokens;
      const cached = typeof u.cachedTokens === 'number' && u.cachedTokens >= 0 ? Math.min(u.cachedTokens, prompt) : undefined;
      this.providerTurns += 1;
      this.sumPrompt += prompt;
      if (cached !== undefined) { this.sumCached += cached; this.cacheReported = true; }
      if (prompt > this.peak) this.peak = prompt;
      if (prompt > TIER1_TRIGGER_TOKENS) this.t1Eligible = true;
      for (const th of PREROT_TOKEN_THRESHOLDS) {
        if (prompt < th) continue;
        const a = (this.above[th] ??= { tokens: 0, turns: 0 });
        a.tokens += prompt;
        a.turns += 1;
      }
      if (cached !== undefined && this.prevPrompt !== undefined && this.prevPrompt >= CACHE_BREAK_MIN_PREV_TOKENS && cached < this.prevPrompt * CACHE_BREAK_RATIO) {
        this.cacheBreaks += 1;
      }
      this.prevPrompt = prompt;

      const p = this.priceOf(t.model);
      const cachedRate = p.cachedIn ?? p.in;
      const c = cached ?? 0;
      this.costUsd += ((prompt - c) * p.in + c * cachedRate + (u.completionTokens || 0) * p.out) / 1_000_000;
      this.noCacheUsd += (prompt * p.in + (u.completionTokens || 0) * p.out) / 1_000_000;

      // ── Pre-rot alarm: ONE row per threshold per run. ──
      for (const th of PREROT_TOKEN_THRESHOLDS) {
        if (prompt >= th && !this.prerotFired.has(th)) {
          this.prerotFired.add(th);
          this.record(prompt, 'tokens', { event: 'prerot', threshold: th, promptTokens: prompt, ...(cached !== undefined ? { cachedTokens: cached } : {}), step: t.step, model: t.model, profile: this.o.profile });
        }
      }

      if (this.arm === 'treatment') this.observeActTurn(prompt, cached, p, t.messages);
      else if (this.arm === 'control' || this.arm === 'shadow') this.shadowTier1(t.step, t.model, prompt, cached, p, t.messages);
      this.lastPrompt = prompt;
      this.lastRequestLen = t.messages.length;
      this.lastPrice = p;
      this.actArmed = true;
      return { promptTokens: prompt, ...(cached !== undefined ? { cachedTokens: cached, cacheHit: Math.round((cached / prompt) * 1000) / 1000 } : {}) };
    } catch {
      return null;
    }
  }

  /** The effective per-token input rate of a request (its cached share at the cached rate). */
  private static effRate(prompt: number, cached: number | undefined, p: Price): number {
    const cachedRate = p.cachedIn ?? p.in;
    const c = cached ?? 0;
    return prompt > 0 ? ((prompt - c) * p.in + c * cachedRate) / prompt : p.in;
  }

  /** Tokens the given cleared-id map keeps out of THIS request (results compaction since dropped no longer count). */
  private static present(cleared: Map<string, number>, messages: ReadonlyArray<ContextMessage>): number {
    if (!cleared.size) return 0;
    let n = 0;
    for (const m of messages) if (m?.role === 'tool' && typeof m.tool_call_id === 'string') n += cleared.get(m.tool_call_id) ?? 0;
    return n;
  }

  /** Treatment: the realized saving on THIS request + the pending act row, flushed with what the provider reported. */
  private observeActTurn(prompt: number, cached: number | undefined, p: Price, messages: ReadonlyArray<ContextMessage>): void {
    this.t1SavingUsd += (ContextGauge.present(this.actCleared, messages) * ContextGauge.effRate(prompt, cached, p)) / 1_000_000;
    if (this.pendingAct) this.flushAct({ prompt, cached });
  }

  /**
   * Tier 1, ACT (build 2026-10-11 T1) — treatment arm only, called at the top of a step BEFORE the compaction check
   * (tier 2 stays the fallback above its own char trigger). Decides ONCE per provider reading: when the newest
   * provider-reported prompt is over T, outside the steer guard and ≥ clear_at_least is freeable outside the last
   * K rounds, ONE batched edit replaces the oldest tool-result bodies with restorable stubs (name + args, the first
   * 400 chars, "re-run the call"). Never a system / user / assistant message, never an exempt tool (plan, verify,
   * todo / goal state, receipts, supervisor state, worker digests), never an array (vision) result. Returns the
   * edited transcript + the cleared originals, or null (no edit). The `tier1_act` row is written once the next
   * request's usage is known (predicted vs observed cached tokens), or at finish. Never throws.
   */
  tier1Act(messages: ReadonlyArray<ContextMessage>, step: number): Tier1ActResult | null {
    try {
      if (this.finished || this.arm !== 'treatment' || !this.actArmed || !this.lastPrice) return null;
      const prompt = this.lastPrompt;
      if (!(prompt > TIER1_TRIGGER_TOKENS)) return null;
      this.actArmed = false; // one decision per provider reading
      const plan = planTier1Clear(messages, { promptTokens: prompt });
      if (plan.status === 'steer_guard') { this.t1SteerBlocked += 1; return null; }
      if (plan.status !== 'clear') { this.t1Blocked += 1; return null; }
      const applied = applyToolResultClears(messages, plan.picks, TIER1_HEAD_CHARS);
      if (!applied.cleared) { this.t1Blocked += 1; return null; }
      const appliedIds = new Set(applied.clearedIds);
      let freed = 0;
      for (const x of plan.picks) {
        if (!appliedIds.has(x.toolCallId)) continue;
        this.actCleared.set(x.toolCallId, x.freedTokens);
        this.clearedSigs.add(callSig(x.tool, x.args));
        freed += x.freedTokens;
      }
      const p = this.lastPrice;
      const cachedRate = p.cachedIn ?? p.in;
      const editIndex = applied.firstClearedIndex;
      // The prefix up to the edit point stays cached; the old request's tail from the edit point is re-read uncached
      // once (the tail appended since that request is uncached either way).
      const reqEnd = Math.min(this.lastRequestLen, messages.length);
      let preChars = 0;
      let postChars = 0;
      for (let i = Math.max(0, editIndex); i < reqEnd; i++) {
        preChars += roughMessageChars(messages[i]);
        postChars += roughMessageChars(applied.messages[i]);
      }
      const predictedCachedTokens = Math.max(0, prompt - Math.ceil(preChars / CHARS_PER_TOKEN));
      const predictedBreakTokens = Math.ceil(postChars / CHARS_PER_TOKEN);
      const breakUsdPredicted = (predictedBreakTokens * (p.in - cachedRate)) / 1_000_000;
      this.t1Events += 1;
      this.t1Freed += freed;
      this.t1BreakUsd += breakUsdPredicted;
      this.pendingAct = {
        step, model: this.lastModel, promptBefore: prompt, freedTokens: freed, freedChars: applied.freedChars, cleared: applied.cleared,
        editIndex, transcriptMessages: messages.length, needTokens: plan.needTokens, freeableTokens: plan.freeableTokens,
        predictedCachedTokens, predictedBreakTokens, breakUsdPredicted, turnsSinceAnchor: plan.turnsSinceAnchor,
        tools: applied.tools, eventN: this.t1Events, inRate: p.in, cachedRate,
      };
      return { messages: applied.messages, originals: applied.originals, cleared: applied.cleared, freedTokens: freed };
    } catch {
      return null; // the loop keeps today's transcript
    }
  }

  /** ONE `tier1_act` row: the edit + what the provider reported on the first request after it (null at run end). */
  private flushAct(observed: { prompt: number; cached: number | undefined } | null): void {
    const e = this.pendingAct;
    if (!e) return;
    this.pendingAct = null;
    let observedFields: Record<string, unknown> = {};
    if (observed) {
      observedFields = { observedPromptTokens: observed.prompt };
      if (observed.cached !== undefined) {
        // no-edit baseline: only the tail appended since the old request would have been uncached
        const baselineUncached = Math.max(0, observed.prompt + e.freedTokens - e.promptBefore);
        const observedBreakTokens = Math.max(0, observed.prompt - observed.cached - baselineUncached);
        const breakUsdObserved = (observedBreakTokens * (e.inRate - e.cachedRate)) / 1_000_000;
        this.t1BreakObservedUsd += breakUsdObserved;
        observedFields = {
          ...observedFields, observedCachedTokens: observed.cached, observedBreakTokens, breakUsdObserved: usd(breakUsdObserved),
          // the prefix BEFORE the edit point was not served from cache (a cold / other deployment) — worse than planned
          unplannedMiss: observed.cached < e.predictedCachedTokens * 0.8,
        };
      }
    }
    this.record(e.freedTokens, 'tokens', {
      event: 'tier1_act', arm: 'treatment', step: e.step, model: e.model, profile: this.o.profile,
      promptTokensBefore: e.promptBefore, freedTokens: e.freedTokens, freedChars: e.freedChars, clearedResults: e.cleared,
      editIndex: e.editIndex, transcriptMessages: e.transcriptMessages, needTokens: e.needTokens, freeableTokens: e.freeableTokens,
      predictedCachedTokens: e.predictedCachedTokens, predictedBreakTokens: e.predictedBreakTokens, breakUsdPredicted: usd(e.breakUsdPredicted),
      ...observedFields,
      // what the freed tokens would have cost on EVERY later request (append-only: at the cached rate)
      savingPerTurnUsd: usd((e.freedTokens * e.cachedRate) / 1_000_000),
      turnsSinceAnchor: e.turnsSinceAnchor, tools: e.tools, eventN: e.eventN,
      trigger: TIER1_TRIGGER_TOKENS, keepRounds: TIER1_KEEP_ROUNDS, clearAtLeast: TIER1_CLEAR_AT_LEAST_TOKENS,
      steerGuardTurns: TIER1_STEER_GUARD_TURNS, headChars: TIER1_HEAD_CHARS,
    });
  }

  /**
   * Tier 1, SHADOW (the control arm, or every run under `shadow`). Savings accrue on THIS turn for results the
   * counterfactual cleared before it (at this turn's effective per-token input rate); then a new would-clear event
   * is evaluated on the counterfactual prompt with the SAME planner the act path uses.
   */
  private shadowTier1(step: number, model: string, prompt: number, cached: number | undefined, p: Price, messages: ReadonlyArray<ContextMessage>): void {
    const cachedRate = p.cachedIn ?? p.in;
    const present = ContextGauge.present(this.shadowCleared, messages);
    this.t1SavingUsd += (present * ContextGauge.effRate(prompt, cached, p)) / 1_000_000;
    const sim = prompt - present;
    if (sim > this.t1PeakSimPrompt) this.t1PeakSimPrompt = sim;
    if (sim <= TIER1_TRIGGER_TOKENS) return;

    const plan = planTier1Clear(messages, { promptTokens: sim, skipIds: new Set(this.shadowCleared.keys()) });
    if (plan.status === 'steer_guard') { this.t1SteerBlocked += 1; return; }
    if (plan.status !== 'clear') { this.t1Blocked += 1; return; }
    for (const x of plan.picks) this.shadowCleared.set(x.toolCallId, x.freedTokens);
    const freed = plan.freedTokens;
    const editIndex = plan.editIndex;
    // The NEXT request re-reads everything after the edit point uncached once.
    let afterChars = 0;
    for (let i = Math.max(0, editIndex); i < messages.length; i++) afterChars += roughMessageChars(messages[i]);
    const tokensAfterEdit = Math.max(0, Math.ceil(afterChars / CHARS_PER_TOKEN) - freed);
    const breakUsd = (tokensAfterEdit * (p.in - cachedRate)) / 1_000_000;
    this.t1Events += 1;
    this.t1Freed += freed;
    this.t1BreakUsd += breakUsd;
    // Steer distance (kept for continuity with the 2026-10-08 rows; the guard itself reads turnsSinceAnchor).
    let lastSteer = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === 'user' && typeof m.content === 'string' && m.content.includes(STEER_MARKER_TEXT)) { lastSteer = i; break; }
    }
    let roundsSinceSteer: number | null = null;
    if (lastSteer >= 0) {
      roundsSinceSteer = 0;
      for (let i = lastSteer + 1; i < messages.length; i++) if (messages[i]?.role === 'assistant') roundsSinceSteer += 1;
    }
    this.record(freed, 'tokens', {
      event: 'tier1_shadow', arm: this.arm, step, model, profile: this.o.profile,
      promptTokens: prompt, simPromptBefore: sim, simPromptAfter: sim - freed, freedTokens: freed, clearedResults: plan.picks.length,
      editIndex, transcriptMessages: messages.length, tokensAfterEdit, breakUsd: usd(breakUsd),
      trigger: TIER1_TRIGGER_TOKENS, keepRounds: TIER1_KEEP_ROUNDS, clearAtLeast: TIER1_CLEAR_AT_LEAST_TOKENS,
      steerGuardTurns: TIER1_STEER_GUARD_TURNS, headChars: TIER1_HEAD_CHARS,
      roundsSinceSteer, turnsSinceAnchor: plan.turnsSinceAnchor, eventN: this.t1Events,
    });
  }

  /**
   * Records the ONE run-summary row (top-level runs with ≥1 provider-reported turn). Idempotent, never throws.
   * build 2026-10-11 T1: carries the ARM + the stage-3 bar's inputs — outcomes from the run's receipts (a commit, a
   * PR, a green verify), the guardrails (duplicate-call share, reads per file, search_memory, verify, completion) and
   * the realized tier-1 numbers on a treated run.
   */
  finish(o: { compactions: number; chatClears?: number; model?: string; receipts?: ReadonlyArray<GaugeReceipt> | null; endState?: 'ok' | 'model_error' | 'cancelled' }): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.flushAct(null);
      if (!this.providerTurns) return;
      const net = this.t1SavingUsd - this.t1BreakUsd;
      const a128 = this.above[128_000] ?? { tokens: 0, turns: 0 };
      const a200 = this.above[200_000] ?? { tokens: 0, turns: 0 };
      const okOf = (tool: string) => (o.receipts ?? []).filter((r) => r?.tool === tool && r.ok === true).length;
      const verifies = (o.receipts ?? []).filter((r) => r?.tool === 'verify');
      const verifyPassed = verifies.filter((r) => r.ids?.passed === true).length;
      const commits = okOf('git_commit');
      const prs = okOf('open_pull_request');
      this.record(this.peak, 'tokens', {
        event: 'run_summary', model: o.model || this.lastModel, profile: this.o.profile,
        turns: this.turns, providerTurns: this.providerTurns, peakPromptTokens: this.peak,
        sumPromptTokens: this.sumPrompt,
        ...(this.cacheReported ? { sumCachedTokens: this.sumCached, cacheHitRatio: Math.round((this.sumCached / Math.max(1, this.sumPrompt)) * 1000) / 1000 } : {}),
        cacheBreaks: this.cacheBreaks,
        tokensAbove128k: a128.tokens, turnsAbove128k: a128.turns, tokensAbove200k: a200.tokens, turnsAbove200k: a200.turns,
        compactions: o.compactions, chatClears: o.chatClears ?? 0,
        costUsd: usd(this.costUsd), noCacheUsd: usd(this.noCacheUsd), cacheSavedUsd: usd(this.noCacheUsd - this.costUsd),
        // build 2026-10-11 T1 — the arm + the switch it ran under
        arm: this.arm, t1Mode: this.tier1.mode, t1ControlShare: this.tier1.controlShare, ...(this.tier1.valid ? {} : { t1ConfigInvalid: true }),
        t1Eligible: this.t1Eligible,
        t1Events: this.t1Events, t1FreedTokens: this.t1Freed, t1BreakUsd: usd(this.t1BreakUsd), t1SavingUsd: usd(this.t1SavingUsd),
        t1NetSavingUsd: usd(net), t1SavingPct: this.costUsd > 0 ? Math.round((net / this.costUsd) * 1000) / 1000 : 0,
        ...(this.arm === 'treatment' ? { t1BreakObservedUsd: usd(this.t1BreakObservedUsd), t1ReReads: this.reReads } : { t1PeakSimPromptTokens: this.t1PeakSimPrompt }),
        t1BlockedTurns: this.t1Blocked, t1SteerBlockedTurns: this.t1SteerBlocked, t1Trigger: TIER1_TRIGGER_TOKENS,
        // stage-3 guardrails + outcomes (context.md §4: $ per commit / PR / green verify, cache-aware list prices)
        toolCalls: this.toolCalls, dupCalls: this.dupCalls, dupShare: this.toolCalls ? round3(this.dupCalls / this.toolCalls) : 0,
        readFileCalls: this.readFileCalls, readFilePaths: this.readPaths.size,
        searchMemoryCalls: this.searchMemoryCalls, verifyCalls: this.verifyCalls,
        commits, pushes: okOf('git_push'), prs, merges: okOf('merge_pull_request'),
        verifyRuns: verifies.length, verifyPassed, outcomes: commits + prs + verifyPassed,
        endState: o.endState ?? 'ok',
      });
    } catch { /* never throws */ }
  }
}
