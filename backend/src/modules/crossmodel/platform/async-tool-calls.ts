/**
 * SAA-1.6 — full-duplex asynchronous tool execution. PHASE 3b: THE ARMED PATH.
 *
 * THE GAP (docs/FRAMEWORK_BACKLOG.md §SAA-1.6, essay §4.1). Digby's ReAct loop
 * BLOCKS on every long call, so a slow tool holds a whole turn hostage: the
 * model cannot read input, cannot answer, cannot do anything else until the
 * call settles. `wait_for_chat` is the clearest case — it is a bounded block
 * whose cap is `WAIT_FOR_CHAT_MAX_SEC = 600` (`platform/coord-tools.ts:27`) and
 * the model must RE-CALL it to keep waiting. The start()/stop() handle shape the
 * essay asks for already exists in this repo, but only for shell commands
 * (`coding/process.service.ts`); the same shape is absent for the rest of the
 * long surface.
 *
 * ── PHASE 3a → 3b: THE RULE CHANGED, AND THE CHANGE IS THE WHOLE POINT ──────
 * Phase 3a shipped an ELIGIBILITY LEAF that asked "does this tool DECLARE a
 * duration?" — and on that test `run_command` and computer use were excluded,
 * because neither states a worst case before it runs. That exclusion was
 * reported as a finding, and it was escalated: it was the wrong rule for this
 * goal, because it narrowed a standing goal on an implementation detail.
 *
 * Phase 3b replaces PREDICTION with MEASUREMENT. A call does not need to know
 * how long it will take to be safe to hand off — it only needs to be observed
 * while it runs. So the question becomes: has THIS call actually been running
 * for `ASYNC_TOOL_AFTER_MS`? If it settles first, nothing happens at all: the
 * caller returns the tool's own result, byte-identical to today. Only a call
 * that is STILL RUNNING at the threshold is handed off. There is no guess to be
 * wrong, so the whole long surface joins on the same honest terms:
 *
 *   wait_for_chat  — bounded by its own `timeoutSec` (clamped to ≤600 s)
 *   run_command    — a shell command that has outlived its minute
 *   computer_task  — paired-device work that has outlived its minute
 *   browser_task   — hosted-browser work that has outlived its minute
 *
 * THE "SUB-60 s BYTE-IDENTICAL" GUARANTEE IS STRUCTURAL, NOT A CHECK. It is not
 * enforced by a comparison anywhere: a call that finishes before the threshold
 * returns through the SAME expression that returns it today, with the same
 * value, because the race's other arm simply never wins. A sub-60 s call cannot
 * observe this module.
 *
 * THREE STATES (same tri-state as the SAA-1.3/1.4 twins, same fail-safe floor):
 *   unset / '' / '0' / junk → mode 'observe' — LOG the row, execute as today.
 *                                              Nothing is handed off: this is
 *                                              the rate measurement, and the
 *                                              safe default for a deploy.
 *   'apply' / 'rewrite'     → mode 'apply'   — ARMED. A call still running at
 *                                              the threshold returns "Started"
 *                                              with a correlation id and its
 *                                              result is delivered as a harness
 *                                              event at the next step boundary.
 *   '1' / 'true' / 'on'     → mode 'off'     — today's behaviour exactly, no row.
 *
 * Kill switch: ASYNC_TOOL_CALLS_DISABLED=1 (release) makes every call blocking
 * as today — the loop never starts a handed-off call, so there is nothing to
 * deliver and no row.
 *
 * Pure leaf: no imports, no I/O, no clock. The caller owns the metric write and
 * the race (see `platform/async-tool-registry.ts`).
 */

/**
 * THE THRESHOLD, and the ONLY rule that decides whether a call is handed off.
 * It is an ELAPSED-TIME bar, never a predicted duration: a call goes async when
 * it has ALREADY run this long, so a call that finishes sooner is untouched.
 */
export const ASYNC_TOOL_AFTER_MS = 60_000;

/**
 * The closed set of tool classes that may be handed off. Membership means "this
 * tool can legitimately run past a minute", NOT "we think this call is slow" —
 * the threshold decides that per call, at run time.
 *
 * Closed on purpose: a tool outside this set is never handed off, so a new
 * addition is a deliberate, reviewable act rather than a side effect of naming
 * a tool.
 */
export const ASYNC_TOOL_ELIGIBLE_CLASSES = [
  'wait_for_chat',
  'run_command',
  'computer_task',
  'browser_task',
] as const;
export type AsyncToolEligibleClass = (typeof ASYNC_TOOL_ELIGIBLE_CLASSES)[number];

export const isAsyncToolEligibleClass = (name: string): name is AsyncToolEligibleClass =>
  (ASYNC_TOOL_ELIGIBLE_CLASSES as readonly string[]).includes(name);

/**
 * Mirrors `platform/coord-tools.ts` (WAIT_FOR_CHAT_MAX_SEC / _DEFAULT_SEC)
 * locally rather than importing it: `coord-tools.ts` pulls in chat-images and a
 * large tool surface, and this module must stay import-free so the loop can read
 * it on every dispatched call. `saa1-phase3b.async-tool-calls.test.ts` pins the
 * two against each other, so this copy cannot silently drift.
 */
const WAIT_FOR_CHAT_MAX_SEC = 600;
const WAIT_FOR_CHAT_DEFAULT_SEC = 120;

/** The three states — same shape and same fail-safe floor as the SAA-1.3/1.4 twins. */
export type AsyncToolMode = 'observe' | 'apply' | 'off';

/**
 * The closed vocabulary of reasons a plan carries. `eligible_elapsed` is the
 * only value that means "this call WILL be handed off if it outlives the
 * threshold"; the rest each name a distinct way a call stays synchronous, so a
 * readout can tell "the threshold is working" apart from "this tool is not in
 * the class" apart from "the switch is off".
 */
export type AsyncToolReason =
  | 'eligible_elapsed'
  | 'not_in_class'
  | 'kill_switch';

export interface AsyncToolPlan {
  /**
   * PHASE 3b: a real `boolean`. This is the one deliberate type change that
   * lets a call site actually hand a call off — it ships TOGETHER with the
   * delivery path and its tests, never alone (see the phase note above).
   */
  applied: boolean;
  mode: AsyncToolMode;
  /** True when this call will be handed off IF it outlives the threshold. */
  eligible: boolean;
  /** The threshold this call is judged against (elapsed time, never predicted). */
  afterMs: number;
  /**
   * `wait_for_chat`'s own declared bound (clamped to the 600 s cap) — the call
   * cannot outlive it. `null` for tools that declare none. Diagnostic only: it
   * does NOT decide eligibility any more (the elapsed threshold does).
   */
  declaredMs: number | null;
  reason: AsyncToolReason;
}

/** The kill switch. '1'/'true'/'on' (trimmed, any case) = OFF; anything else = not-off. */
export function asyncToolCallsDisabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  const raw = String(env?.ASYNC_TOOL_CALLS_DISABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/**
 * Resolve the mode from the ONE registered switch. Pure.
 *   '1'/'true'/'on'   → 'off'     kill switch: no row, today's blocking behaviour.
 *   'apply'/'rewrite' → 'apply'   ARMED: calls past the threshold are handed off.
 *   anything else     → 'observe' the threshold — an unrecognised value can never
 *                                 silently start handing calls off.
 */
export function asyncToolCallsMode(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): AsyncToolMode {
  if (asyncToolCallsDisabled(env)) return 'off';
  const raw = String(env?.ASYNC_TOOL_CALLS_DISABLED ?? '').trim().toLowerCase();
  if (raw === 'apply' || raw === 'rewrite') return 'apply';
  return 'observe';
}

/**
 * The DECLARED bound of one call, in ms, or `null` when the tool declares none.
 * Pure: depends only on the call's own arguments. Diagnostic only — see
 * `AsyncToolPlan.declaredMs`.
 *
 * `wait_for_chat`: the bound IS the timeout the caller asked for, clamped to the
 * tool's own registry maximum — a call cannot outlive its timeout, and a timeout
 * outside (0, 600] is not a bound this harness can honour. A non-numeric /
 * absent / NaN `timeoutSec` falls back to the tool's default, which is exactly
 * what the handler does, so the plan never disagrees with the call.
 */
export function declaredDurationMs(tool: string, args: unknown): number | null {
  if (tool !== 'wait_for_chat') return null;
  const raw = (args as { timeoutSec?: unknown } | null | undefined)?.timeoutSec;
  const asked = typeof raw === 'number' ? raw : Number(raw);
  const sec = Number.isFinite(asked) && asked > 0
    ? Math.min(asked, WAIT_FOR_CHAT_MAX_SEC)
    : WAIT_FOR_CHAT_DEFAULT_SEC;
  return Math.round(sec * 1000);
}

/**
 * Decide how ONE dispatched call will be treated. Pure.
 *
 * The ORDER of the checks is the contract, and each earlier branch wins:
 *   1. kill switch     — `off` means today's behaviour, full stop: no row, no hand-off.
 *   2. not in class    — a tool outside the closed set is never handed off.
 *   3. otherwise       — `eligible_elapsed`: the call is raced against the
 *                        threshold, and it stays byte-identical unless it loses.
 *
 * NOTE the absence of any duration test on the eligible path: that absence is
 * the Phase-3b correction. Eligibility no longer asks "how long will this
 * take?", it asks "may this tool legitimately take a minute?" — and the race
 * answers the rest per call.
 */
export function planAsyncToolCall(opts: {
  tool: string;
  args?: unknown;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): AsyncToolPlan {
  const mode = asyncToolCallsMode(opts.env);
  const declaredMs = declaredDurationMs(opts.tool, opts.args);
  const base = { mode, afterMs: ASYNC_TOOL_AFTER_MS, declaredMs };
  if (mode === 'off') return { ...base, applied: false, eligible: false, reason: 'kill_switch' };
  if (!isAsyncToolEligibleClass(opts.tool)) return { ...base, applied: false, eligible: false, reason: 'not_in_class' };
  return { ...base, applied: mode === 'apply', eligible: true, reason: 'eligible_elapsed' };
}

/**
 * The user-facing text a handed-off call returns in place of its result. Built
 * HERE, in the pure leaf, so the wording the model reads is pinned by a unit
 * test rather than buried in a loop seam.
 *
 * It must do three things: name the correlation id (so the delivered event can
 * be matched to it), tell the model NOT to re-call the tool (a re-call would
 * duplicate a side effect — the whole reason the handle exists), and say what
 * happens next.
 */
export function asyncToolStartedText(tool: string, correlationId: string, afterMs: number): string {
  return `Tool ${tool} started — still running after ${Math.round(afterMs / 1000)}s, so it continues in the background (id ${correlationId}). Its result will arrive as a [BACKGROUND TOOL RESULT] harness message at the start of a later step. Do NOT call ${tool} again for this same work — that would run it twice; keep working, or finish and the result will land in the transcript.`;
}