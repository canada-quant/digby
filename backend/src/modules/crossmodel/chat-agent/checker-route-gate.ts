/**
 * Level 2 checker-site router — decision-gate purpose `checker_route`
 * (N4, docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §5; shipped SHADOW).
 *
 * WHY: on every human Level 2 turn `isSimpleQuestion` is a REGEX
 * (routeMessageHeuristic().level === 'single_thinking') that picks the 75 s vs
 * 300 s checker wait and the step-0 fast path, while the Double Checker always
 * spawns at reasoning_effort 'max'. This site measures placement quality
 * where the latency actually lands. It is its OWN purpose (review 2026-09-25):
 * the first cut shared `auto_route`, whose flip-readiness stamp measures the
 * newest questionsHash partition — with two sites writing concurrently the
 * router could have been admitted to act on checker-site rows.
 *
 * WHAT: ONE typed request per human L2 turn, asked CONCURRENTLY with the
 * regex (the regex still decides — zero added latency in shadow):
 *   depth          — Choice {simple_lookup, ordinary, contestable, unclear}
 *                    over {message ≤ 2k, last user turn ≤ 1k}; `unclear` is
 *                    the escape option (E9) and never acts.
 *   needs_live_web — noul: answering correctly needs live web information.
 * Both share the purpose's questionsHash partition (E3/E7: rows are never
 * pooled across shapes); the readiness stamp measures `depth` (ACT_POLICIES).
 *
 * LABEL (harness-derived at the chat finalize, never model-claimed):
 *   depth actual   — simple_lookup ⇔ the lead answered with NO tool round and
 *                    a short final (≤ 800 chars). Otherwise a HEAVY turn
 *                    (≥ 3 lead tool calls or a ≥ 2,500-char final) is
 *                    contestable when the checker's draft was MERGED into the
 *                    answer (injected mid-loop or reconciled inline) and
 *                    UNKNOWN (actual null) when it was not — whether the draft
 *                    reached the answer is decided by the wait the regex (or
 *                    the gate, in act) picked, so a heavy un-merged turn can
 *                    never honestly read 'ordinary' (review 2026-09-25: the
 *                    old rule labelled every regex-simple heavy turn ordinary
 *                    and biased agreement toward the regex). A light turn is
 *                    ordinary regardless of the merge.
 *   needs_live_web actual — the lead fired ≥ 1 web-grounding tool.
 *   The note carries the regex verdict + the raw facts so the readout can
 *   shadow-compare gate vs regex vs what the turn did. An empty orchestrator
 *   finalize evidences nothing (actual null, paired unlabelled).
 *
 * ACT (designed, NOT enabled — the purpose's mode via the RESULT's mode,
 * E2; no site-arming env since the purpose is this site's own). In the
 * ANSWER-FIRST world (2026-09-26; audit docs-drift-12) the act effect for a
 * signed-in human turn is ONLY the Double Checker's reasoning_effort: 'high'
 * on a confident simple_lookup instead of 'max'; a confident contestable
 * changes nothing (the injector wait is already 0 — the lead never blocks).
 * The "75 s checker path vs the full 300 s wait" choice and the step-0 fast
 * path apply ONLY to guests (no chatId) and under ANSWER_FIRST_DISABLED=1.
 * The checker is NEVER skipped on the gate alone (the L2 second opinion is
 * the product promise). Only when the purpose's configured mode is act is
 * the gate awaited before the checker spawns (bounded by
 * CHECKER_ROUTE_TIMEOUT_MS); shadow never waits.
 *
 * LABEL in the wait-0 world: whether the draft reached the answer is decided
 * by whether it beat the lead's loop (in-loop injection) or landed in the
 * LATE reconcile — so the chat finalize DEFERS this label to the late pass's
 * settle when the late check is armed (chat-agent.service.ts), with
 * checkerMerged upgraded from the outcome (revised / unchanged / addendum).
 *
 * Fail-open everywhere: a null answer, a throw, a timeout ⇒ the regex
 * verdict stands. Kill switch DECISION_GATE_CHECKER_ROUTE_DISABLED=1 (plus
 * the gate-wide switches). LEAF: imports decision-gate only.
 */

import { decisionThreshold, recordDecisionOutcome, type DecideResult, type DecisionAnswer, type DecisionQuestion } from '../platform/decision-gate';

export const CHECKER_ROUTE_QUESTION = 'depth';
export const CHECKER_ROUTE_WEB_QUESTION = 'needs_live_web';
/** Request-path bound in ACT (shadow never waits on it). */
export const CHECKER_ROUTE_TIMEOUT_MS = 1500;
export const CHECKER_ROUTE_MESSAGE_CHARS = 2000;
export const CHECKER_ROUTE_LAST_TURN_CHARS = 1000;
/** Acting confidence (DECISION_GATE_THRESHOLD_CHECKER_ROUTE overrides; mirrored in ACT_BAND_DEFAULT_THRESHOLD / ACT_POLICIES). */
export const CHECKER_ROUTE_DEFAULT_THRESHOLD = 0.7;
/** Label bounds (harness facts → depth actual). */
export const CHECKER_SIMPLE_MAX_FINAL_CHARS = 800;
export const CHECKER_CONTESTABLE_MIN_TOOL_CALLS = 3;
export const CHECKER_CONTESTABLE_MIN_FINAL_CHARS = 2500;

export type CheckerDepth = 'simple_lookup' | 'ordinary' | 'contestable' | 'unclear';
export const CHECKER_DEPTHS: readonly CheckerDepth[] = ['simple_lookup', 'ordinary', 'contestable', 'unclear'];

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

export const CHECKER_ROUTE_PURPOSE = 'checker_route' as const;

/** DECISION_GATE_CHECKER_ROUTE_DISABLED=1 — the Level 2 checker site never consults the gate. */
export function checkerRouteDisabled(): boolean {
  return onFlag(process.env.DECISION_GATE_CHECKER_ROUTE_DISABLED);
}

export interface CheckerRouteInput {
  message: string;
  /** The PREVIOUS user turn (context for follow-ups like "and in 2025?"). */
  lastUserTurn?: string | null;
}

/** The state + questions for one turn (pure). */
export function buildCheckerRouteRequest(input: CheckerRouteInput): { state: Record<string, unknown>; questions: Record<string, DecisionQuestion> } {
  const message = String(input.message || '').slice(0, CHECKER_ROUTE_MESSAGE_CHARS);
  const last = String(input.lastUserTurn || '').slice(0, CHECKER_ROUTE_LAST_TURN_CHARS);
  const state: Record<string, unknown> = { message, ...(last ? { last_user_turn: last } : {}) };
  const questions: Record<string, DecisionQuestion> = {
    [CHECKER_ROUTE_QUESTION]: {
      type: 'choice',
      instructions: 'How much independent cross-checking does a correct answer to this message need? When unsure, prefer ordinary.',
      criteria: {
        simple_lookup: 'A short, single-part factual lookup or quick answer whose correctness is easy to verify — one model answers directly; a second opinion adds little',
        ordinary: 'An ordinary question or task — a second model answering in parallel is useful, but the first complete answer can ship and be revised',
        // 2026-09-26 audit (gate-runtime-5): the SAME wording as compute_policy's depth question (compute-policy-gate.ts) —
        // the old "high-stakes … wait for the independent cross-check before it ships" line made Laya return NaN on the
        // sibling `needs_live_web` noul deterministically (4/4 probes, 14/14 prod rows). Resets checker_route's questionsHash
        // partition (the purpose is shadow and NOT READY, so nothing is lost). Pinned equal in checker-route-gate.test.ts.
        contestable: 'A disputable, multi-part or easy-to-get-wrong question — the answer should be cross-checked before the user acts on it',
        unclear: 'None of the above / cannot tell from the message',
      },
    },
    [CHECKER_ROUTE_WEB_QUESTION]: {
      type: 'noul',
      instructions: 'Answering this message correctly requires live web information.',
      criteria: {
        true: 'The answer depends on time-sensitive, recent, or online-verifiable facts (prices, news, versions, schedules, current status)',
        false: 'The answer follows from stable knowledge or from the conversation itself; nothing needs to be looked up',
      },
    },
  };
  return { state, questions };
}

/** What the finalized turn measurably did (harness facts). */
export interface CheckerRunFacts {
  /** The regex verdict the turn actually ran with (or the act override). */
  regexSimple: boolean;
  /** Every tool_call part in the lead's own loop. */
  leadToolCalls: number;
  /** Web-grounding tool calls in the lead's loop (chat-agent countWebToolCalls). */
  webToolCalls: number;
  finalChars: number;
  /** The checker's draft was injected mid-loop or reconciled inline into THIS answer. */
  checkerMerged: boolean;
  /** The answer shipped before the draft; late-crosscheck may revise the row. */
  lateArmed: boolean;
}

/** A heavy turn: the lead did real research or wrote at length. Pure. */
export function checkerTurnHeavy(f: Pick<CheckerRunFacts, 'leadToolCalls' | 'finalChars'>): boolean {
  return f.leadToolCalls >= CHECKER_CONTESTABLE_MIN_TOOL_CALLS || f.finalChars >= CHECKER_CONTESTABLE_MIN_FINAL_CHARS;
}

/**
 * The depth the turn evidences — never 'unclear' (that is the model's escape,
 * not a fact). `null` = unknown: a heavy turn whose checker draft never merged
 * (the wait cap the treatment picked decided that, not the question). Pure.
 */
export function deriveCheckerDepthActual(f: CheckerRunFacts): Exclude<CheckerDepth, 'unclear'> | null {
  if (f.leadToolCalls === 0 && f.finalChars <= CHECKER_SIMPLE_MAX_FINAL_CHARS) return 'simple_lookup';
  if (checkerTurnHeavy(f)) return f.checkerMerged ? 'contestable' : null;
  return 'ordinary';
}

export interface CheckerRouteVerdict {
  depth: CheckerDepth | null;
  depthConfidence: number | null;
  needsLiveWeb: number | null;
  /** ACT only: true = treat as simple (75 s path, checker at 'high'); false = force the full wait; null = the regex decides. */
  actSimple: boolean | null;
}

/** Read a decision into the site's verdict. Act requires result.mode === 'act' (E2) AND confidence ≥ τ; `unclear` never acts. Pure. */
export function checkerRouteVerdict(r: DecideResult | null | undefined): CheckerRouteVerdict {
  const none: CheckerRouteVerdict = { depth: null, depthConfidence: null, needsLiveWeb: null, actSimple: null };
  if (!r) return none;
  const d = r.answers[CHECKER_ROUTE_QUESTION] as Extract<DecisionAnswer, { type: 'choice' }> | undefined;
  const w = r.answers[CHECKER_ROUTE_WEB_QUESTION] as Extract<DecisionAnswer, { type: 'noul' }> | undefined;
  const depth = d && d.type === 'choice' && (CHECKER_DEPTHS as readonly string[]).includes(d.choice) ? (d.choice as CheckerDepth) : null;
  const depthConfidence = d && d.type === 'choice' && Number.isFinite(d.confidence) ? d.confidence : null;
  const needsLiveWeb = w && w.type === 'noul' && Number.isFinite(w.noul) ? w.noul : null;
  let actSimple: boolean | null = null;
  if (r.mode === 'act' && depth && depth !== 'unclear' && depthConfidence !== null) {
    const tau = decisionThreshold(CHECKER_ROUTE_PURPOSE, CHECKER_ROUTE_DEFAULT_THRESHOLD);
    if (depthConfidence >= tau) actSimple = depth === 'simple_lookup' ? true : depth === 'contestable' ? false : null;
  }
  return { depth, depthConfidence, needsLiveWeb, actSimple };
}

/** Facts → the outcome note (bounded; the readout parses `regex:` and the counters). Pure. */
export function checkerRouteNote(f: CheckerRunFacts, acted: boolean): string {
  return `regex:${f.regexSimple ? 'simple' : 'deep'}; merged:${f.checkerMerged ? 1 : 0}; late:${f.lateArmed ? 1 : 0}; tools:${f.leadToolCalls}; web:${f.webToolCalls}; chars:${f.finalChars}${acted ? '; acted' : ''}`;
}

/**
 * Record both outcome rows for a settled decision from the finalized turn's
 * facts. `failed` (empty orchestrator finalize) ⇒ actual null on both; a
 * heavy turn whose draft never merged ⇒ depth actual null (unknown — see
 * deriveCheckerDepthActual), needs_live_web still labelled.
 * Fire-and-forget; never throws.
 */
export function recordCheckerRouteOutcome(
  r: DecideResult | null | undefined,
  facts: CheckerRunFacts | null,
  opts: { sessionId?: string; acted?: boolean; failed?: boolean } = {},
): void {
  if (!r) return;
  try {
    const acted = !!opts.acted;
    if (opts.failed || !facts) {
      recordDecisionOutcome(r, CHECKER_ROUTE_PURPOSE, { question: CHECKER_ROUTE_QUESTION, actual: null, acted, sessionId: opts.sessionId, note: 'run failed — outcome unknown', extra: { site: 'checker' } });
      recordDecisionOutcome(r, CHECKER_ROUTE_PURPOSE, { question: CHECKER_ROUTE_WEB_QUESTION, actual: null, acted, sessionId: opts.sessionId, note: 'run failed — outcome unknown', extra: { site: 'checker' } });
      return;
    }
    const note = checkerRouteNote(facts, acted);
    const extra = { site: 'checker', regexSimple: facts.regexSimple, checkerMerged: facts.checkerMerged, leadToolCalls: facts.leadToolCalls, webToolCalls: facts.webToolCalls, finalChars: facts.finalChars };
    if (r.answers[CHECKER_ROUTE_QUESTION]) {
      const depthActual = deriveCheckerDepthActual(facts);
      recordDecisionOutcome(r, CHECKER_ROUTE_PURPOSE, {
        question: CHECKER_ROUTE_QUESTION, actual: depthActual, acted, sessionId: opts.sessionId,
        note: depthActual === null ? `${note}; depth unknown — heavy turn, draft never merged before the wait cap` : note, extra,
      });
    }
    if (r.answers[CHECKER_ROUTE_WEB_QUESTION]) {
      recordDecisionOutcome(r, CHECKER_ROUTE_PURPOSE, { question: CHECKER_ROUTE_WEB_QUESTION, actual: facts.webToolCalls > 0, acted, sessionId: opts.sessionId, note, extra });
    }
  } catch { /* labels never break a finalize */ }
}
