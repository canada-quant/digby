/**
 * Tool-intent attribution — decision-gate purpose `tool_intent`
 * (N10, docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §5; SHADOW telemetry ONLY).
 *
 * WHY: the derail guard's intent leg (`detectIntendedToolChannels`,
 * tool-preflight.ts) is a REGEX over the turn's final sentences — whole-word
 * mentions of OTHER offered tools convict, prose/alias self-naming acquits.
 * It logs `guard_miss` seam 'tool_intent_attribution' ≈ 508 rows/day and its
 * false-positive classes (ordered batches, pre-computed duties, recap of a
 * completed sibling) each needed their own discount. The paper's shape for
 * this judgment is a CHOICE over a fixed option set — which of the offered
 * tools did the narration intend? — answered from one prefill. This module
 * asks that question NEXT TO the regex ONCE PER TOOL TURN — on the turn's
 * FIRST dispatched call (review follow-up 2026-09-25: a batched turn shares
 * one narration, so per-call asks burned the run cap on N identical
 * questions and made every sibling the "next call"); the batch size rides
 * the state + note so batched turns are filterable — bounded per run, and
 * records TWO outcome rows per decision, told apart by meta.label:
 *   label 'regex'     — the regex detector's verdict (its named tool, or the
 *                       emitted tool when it acquitted), at decide time;
 *   label 'next_call' — the tool the model ACTUALLY called at the NEXT turn's
 *                       first dispatched call (a derailed model typically
 *                       calls the tool it meant right after), recorded then.
 * The fit / readiness pairing (decision-gate-fit.ts OUTCOME_LABEL_FOR_FIT)
 * keeps ONLY the 'regex' row per decision — 'next_call' is the weaker label
 * and must never enter the temperature fit. KNOWN GAP: the run's LAST tool
 * turn never gets a 'next_call' row (nothing is dispatched after it to
 * close the pending decision) — the regex row still lands, so the primary
 * series is complete. A call whose option set is a single tool (no other
 * tool named in the tail, no other recent call — the first call of nearly
 * every run) is NOT asked: a one-option Choice is unanswerable and would
 * only burn a cap slot and write an error row.
 * NOTHING acts on the answer: no steer, no trip, no refusal changes; there is
 * no act consumer for this purpose (ACT_POLICIES names it so). The gate runs
 * fire-and-forget CONCURRENTLY with the tool execution it sits beside — no
 * latency on the loop. Per-run bound DECISION_GATE_TOOL_INTENT_RUN_CAP
 * (default 16). (RSW-1 cluster 29, 2026-11-02: the
 * DECISION_GATE_TOOL_INTENT_DISABLED kill switch was deleted — the purpose's
 * own mode `off` (its retired state) is the only off-ramp.)
 *
 * STATE: the model's OWN reasoning / content tails (lane-authored; tool
 * results are never included), the emitted tool, and an option table. OPTION
 * KEYS ARE POSITIONAL (`option_1` … `option_n`, the tool names live in the
 * state) so the question text — and with it meta.questionsHash — depends only
 * on the option COUNT, not on which tools were offered: the fit report
 * partitions rows by questionsHash, and per-call option sets would otherwise
 * make every row its own partition. `option_1` is always the emitted tool.
 *
 * LEAF: imports decision-gate only; the agent loop passes the regex verdict
 * it already computed.
 */

import {
  decide, decisionMode, recordDecisionOutcome, DECISION_MAX_OPTIONS,
  type DecideResult, type DecisionQuestion,
} from '../platform/decision-gate';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** The question key on every tool_intent decision/outcome row. */
export const TOOL_INTENT_QUESTION = 'intended_tool';
/** Gate deadline — fire-and-forget, so this bounds only the telemetry row's latency. */
export const TOOL_INTENT_TIMEOUT_MS = 4000;
/** Default gate calls per run (env DECISION_GATE_TOOL_INTENT_RUN_CAP, clamped 0..200; 0 = none). */
export const TOOL_INTENT_DEFAULT_RUN_CAP = 16;
/** Narration shorter than this carries no decision sentence — not asked. */
export const TOOL_INTENT_MIN_NARRATION_CHARS = 24;
/** Tail windows (the decision is made at the tail — the regex reads the last 6000). */
export const TOOL_INTENT_REASONING_TAIL_CHARS = 1500;
export const TOOL_INTENT_CONTENT_TAIL_CHARS = 1000;
/** Recent tool calls (this run, before the emitted call) offered as options. */
export const TOOL_INTENT_RECENT_TOOLS = 20;
/** The outcome-row actual when the labelled tool is not in the option set. */
export const TOOL_INTENT_NOT_AN_OPTION = 'not_an_option';

/** DECISION_GATE_TOOL_INTENT_RUN_CAP — gate calls per run (clamped 0..200). */
export function toolIntentRunCap(): number {
  const raw = Number(process.env.DECISION_GATE_TOOL_INTENT_RUN_CAP);
  const v = Number.isFinite(raw) ? Math.floor(raw) : TOOL_INTENT_DEFAULT_RUN_CAP;
  return Math.min(200, Math.max(0, v));
}

// ── Pure builders ────────────────────────────────────────────────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Offered tools named as a whole word in the narration tail, in order of LAST mention (closest to the call first). Pure. */
export function toolsNamedInTail(tail: string, offeredNames: Iterable<string>): string[] {
  const hits: Array<{ name: string; pos: number }> = [];
  for (const name of offeredNames) {
    if (!name) continue;
    const re = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, 'g');
    let last = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tail)) !== null) last = m.index;
    if (last >= 0) hits.push({ name, pos: last });
  }
  return hits.sort((a, b) => b.pos - a.pos).map((h) => h.name);
}

export interface ToolIntentOptions {
  /** option key → internal tool name; option_1 is always the emitted tool. */
  byKey: Record<string, string>;
  keys: string[];
}

/**
 * The option set: the emitted tool first, then tools the tail names (closest
 * mention first), then the run's recent calls (newest first), deduped and
 * bounded to DECISION_MAX_OPTIONS. Pure.
 */
export function buildToolIntentOptions(emitted: string, namedInTail: readonly string[], recentTools: readonly string[]): ToolIntentOptions {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (n: string) => { if (n && !seen.has(n) && ordered.length < DECISION_MAX_OPTIONS) { seen.add(n); ordered.push(n); } };
  push(emitted);
  for (const n of namedInTail) push(n);
  for (let i = recentTools.length - 1; i >= 0; i--) push(recentTools[i]);
  const byKey: Record<string, string> = {};
  const keys: string[] = [];
  ordered.forEach((n, i) => { const k = `option_${i + 1}`; byKey[k] = n; keys.push(k); });
  return { byKey, keys };
}

/** The option key a tool name maps to (null when it is not an option). Pure. */
export function optionKeyFor(opts: ToolIntentOptions, tool: string | null | undefined): string | null {
  if (!tool) return null;
  for (const k of opts.keys) if (opts.byKey[k] === tool) return k;
  return null;
}

/** The question for an option COUNT — fixed text per n, so questionsHash partitions by n only. Pure. */
export function buildToolIntentQuestions(keys: readonly string[]): Record<string, DecisionQuestion> {
  const criteria: Record<string, string> = {};
  for (const k of keys) criteria[k] = `the narration's action is the tool the state lists as ${k}`;
  return {
    [TOOL_INTENT_QUESTION]: {
      type: 'choice',
      instructions: 'An autonomous coding model wrote the reasoning and content below and then emitted ONE tool call (the state names it as option_1). Reading the narration\'s final sentences — where it states the action it is taking — which listed tool did the model actually intend to call? Pick option_1 unless the narration clearly commits to a different listed tool and never names the emitted one.',
      criteria,
    },
  };
}

export interface ToolIntentStateInput {
  emitted: string;
  reasoning: string;
  content: string;
  options: ToolIntentOptions;
  step?: number;
  batchCalls?: number;
}

const tail = (s: string, n: number): string => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(-n) : t; };

/** The gate state: option table + emitted key first, prose LAST (tool results never enter). Pure. */
export function buildToolIntentState(input: ToolIntentStateInput): Record<string, unknown> {
  const state: Record<string, unknown> = {
    emitted_tool: 'option_1',
    options: input.options.byKey,
    ...(typeof input.step === 'number' ? { step: input.step } : {}),
    ...(typeof input.batchCalls === 'number' && input.batchCalls > 1 ? { batch_calls: input.batchCalls } : {}),
    reasoning_tail: tail(input.reasoning, TOOL_INTENT_REASONING_TAIL_CHARS) || undefined,
    content_tail: tail(input.content, TOOL_INTENT_CONTENT_TAIL_CHARS) || undefined,
  };
  for (const k of Object.keys(state)) if (state[k] === undefined) delete state[k];
  return state;
}

// ── The per-run shadow ───────────────────────────────────────────────────────

export interface ToolIntentObservation {
  /** The INTERNAL name of the tool the model emitted. */
  emitted: string;
  /** The turn's two channels (never tool results). */
  reasoning: string;
  content: string;
  /** Tools offered this turn (internal names). */
  offeredNames: Iterable<string>;
  /** Tool calls already dispatched this run (oldest first; this trims to the last TOOL_INTENT_RECENT_TOOLS).
   *  A THUNK so the loop pays nothing unless a decision is actually asked. */
  recentTools: readonly string[] | (() => readonly string[]);
  /** The regex detector's verdict for this call (its named tool, or null = acquitted).
   *  A THUNK for the same reason — the regex runs only when the gate is asked. */
  regexVerdict: string | null | (() => string | null);
  step?: number;
  /** Tool calls dispatched in this turn (the observation is the turn's FIRST; siblings share its narration). */
  batchCalls?: number;
}

export interface ToolIntentShadow {
  /** Observe one dispatched call. Synchronous; never throws; never awaits the seat. */
  observe(o: ToolIntentObservation): void;
  /** Gate calls made so far this run (tests / telemetry). */
  readonly asked: number;
}

interface Pending {
  promise: Promise<DecideResult | null>;
  options: ToolIntentOptions;
  emitted: string;
  batch: number;
}

/**
 * One shadow per run. Each observed call — the FIRST dispatched call of a
 * tool turn — (a) closes the PREVIOUS turn's decision with label 'next_call'
 * = this call's tool, then (b) — when eligible, under the cap, and with at
 * least two options — asks the gate about THIS call, fire-and-forget, and
 * records label 'regex' when the answer lands. Mode 'off' (the NODE_ENV=test
 * default), the kill switch or cap 0 make it inert.
 */
export function createToolIntentShadow(ctx: { sessionId?: string; runId?: string }): ToolIntentShadow {
  let pending: Pending | null = null;
  let asked = 0;
  const closePending = (nextTool: string): void => {
    const p = pending;
    pending = null;
    if (!p) return;
    p.promise.then((d) => {
      if (!d) return;
      const key = optionKeyFor(p.options, nextTool);
      recordDecisionOutcome(d, 'tool_intent', {
        question: TOOL_INTENT_QUESTION, actual: key ?? TOOL_INTENT_NOT_AN_OPTION, acted: false, sessionId: ctx.sessionId, label: 'next_call',
        note: `label:next_call ${nextTool}${key ? '' : ' (not an option)'}; emitted ${p.emitted}${p.batch > 1 ? `; batch ${p.batch}` : ''}`,
      });
    }).catch(() => { /* telemetry never throws */ });
  };
  return {
    get asked() { return asked; },
    observe(o: ToolIntentObservation): void {
      try {
        closePending(o.emitted);
        if (decisionMode('tool_intent') === 'off') return;
        if (asked >= toolIntentRunCap()) return;
        const reasoning = String(o.reasoning ?? '');
        const content = String(o.content ?? '');
        if (reasoning.trim().length + content.trim().length < TOOL_INTENT_MIN_NARRATION_CHARS) return;
        const offered = [...o.offeredNames];
        if (!offered.length) return;
        const tailText = `${tail(reasoning, TOOL_INTENT_REASONING_TAIL_CHARS)}\n${tail(content, TOOL_INTENT_CONTENT_TAIL_CHARS)}`;
        const named = toolsNamedInTail(tailText, offered);
        const recentAll = typeof o.recentTools === 'function' ? o.recentTools() : o.recentTools;
        const recent = recentAll.slice(-TOOL_INTENT_RECENT_TOOLS);
        const options = buildToolIntentOptions(o.emitted, named, recent);
        // A one-option Choice is unanswerable (decide() rejects it AFTER writing
        // an error row): the first call of nearly every run, and any later call
        // whose narration names no other tool and whose only recent call is the
        // emitted tool. Not asked, no cap slot consumed.
        if (options.keys.length < 2) return;
        const batch = typeof o.batchCalls === 'number' && o.batchCalls > 1 ? Math.floor(o.batchCalls) : 1;
        const questions = buildToolIntentQuestions(options.keys);
        const state = buildToolIntentState({ emitted: o.emitted, reasoning, content, options, step: o.step, batchCalls: batch });
        asked += 1;
        const regexVerdict = typeof o.regexVerdict === 'function' ? o.regexVerdict() : o.regexVerdict;
        const regexTool = regexVerdict ?? o.emitted;
        const promise: Promise<DecideResult | null> = decide(state, questions, {
          purpose: 'tool_intent', timeoutMs: TOOL_INTENT_TIMEOUT_MS, sessionId: ctx.sessionId,
        }).then((d) => {
          if (d) {
            const key = optionKeyFor(options, regexTool);
            recordDecisionOutcome(d, 'tool_intent', {
              question: TOOL_INTENT_QUESTION, actual: key ?? TOOL_INTENT_NOT_AN_OPTION, acted: false, sessionId: ctx.sessionId, label: 'regex',
              note: `label:regex ${regexVerdict ? `mismatch→${regexVerdict}` : 'aligned'}; emitted ${o.emitted}; options ${options.keys.length}${batch > 1 ? `; batch ${batch}` : ''}`,
            });
          }
          return d;
        }).catch(() => null);
        pending = { promise, options, emitted: o.emitted, batch };
      } catch { /* shadow never breaks the loop */ }
    },
  };
}
