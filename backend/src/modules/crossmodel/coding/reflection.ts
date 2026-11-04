/**
 * In-session failure reflection (owner doctrine 2026-09-10): when a lane hits
 * a 3× tool-failure streak, the SOTA-autonomous response is not "ping the
 * owner to swap models" — it is:
 *   1. REFLECT: package the streak evidence (failure texts, the tool the
 *      lane's own reasoning intended, the run goal);
 *   2. CONSULT: one bounded advisory turn from the CROSS-CHECKER seat — a
 *      DIFFERENT decoder diagnoses what a locked model cannot see about
 *      itself; the advice is injected back and the lane keeps its model;
 *   3. ATTRIBUTE: simultaneously auto-file ONE deduped investigation ticket
 *      so a fleet lane determines whether a DETERMINISTIC framework issue
 *      (schema pressure, preflight, guard false-positive) causes the streak —
 *      the 2026-09-09 forensics showed "model derailment" was framework-era
 *      churn, so attribution is never assumed.
 *
 * Bounded: ≤ REFLECTION_MAX_PER_RUN consults per run, 45s timeout, fail-open
 * (a consult failure never blocks the breaker notice).
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
// af4ef7c7: the breaker filer's STRUCTURAL class key and its attach arm both
// live in env-free leaf modules. Importing feedback.service here would pull its
// graph to config/env, whose parseEnv() process.exit(1)s a bare Jest worker —
// an UNCATCHABLE kill that broke 5 reflection.* suites (measured this run).
import { breakerClassKey, BREAKER_CLASS_KEY_FIELD } from '../feedback/breaker-class-key';
import { bumpAdjudicatedClassSighting } from '../feedback/adjudicated-class-attach';
// N8 (2026-09-25): decision-gate purpose `reflection_route` — a typed remedy
// choice over the streak evidence, CONCURRENT with the consult (shadow);
// act = consult only on needs_diagnosis. See the route section below.
import {
  confidenceOf, decide, decisionMode, decisionThreshold, recordDecisionOutcome,
  type DecideResult, type DecisionQuestion,
} from '../platform/decision-gate';

/** Consults per run — one per trip, and a run that trips twice has its answer. */
export const REFLECTION_MAX_PER_RUN = 2;

export interface StreakEvidence {
  sessionId: string;
  runId?: string | null;
  tool: string;
  perma: boolean;
  intended?: string | null;
  /** Most recent tool-result texts (failure messages), newest first. */
  recentFailures: string[];
  /**
   * DW-4 (2026-10-02, gap from 568d3652's close-out): the ARGS of the calls
   * that produced those failure texts, newest first — captured at counting
   * time beside the texts (same 8579d419 discipline, never re-derived at
   * trip time), capped at 3 × 200 chars (args can carry ids/paths — the cap
   * keeps the exposure bounded). Rendered in the ticket body AFTER the
   * failure texts so attribution needs no one-off transcript probe. The
   * churned-trip path (agent.ts ~:4815) shares the gap and rides the same
   * field. (The STREAK_ARGS_CAPTURE_DISABLED kill switch was deleted with
   * RSW-1 cluster 29 — capture is unconditional.)
   */
  recentArgs?: string[];
  goalHint?: string | null;
  /**
   * Ticket d73765fc (2026-09-22): WHICH ladder tripped. 'failure' (default)
   * is the classic 3× failure streak; 'success_intent' is the 2c98b460
   * success-side wrong-tool trip (5 consecutive SUCCESSES whose reasoning
   * named a different tool). The filing + consult surfaces render the shape
   * TRUTHFULLY — the fixed "3× tool-failure streak" title mislabeled
   * success-side trips (the d73765fc artifact: every call SUCCEEDED, yet the
   * ticket opened as a tool-failure streak), the same fixed-text-mislabel
   * class the 2c98b460 review flagged for the notice/progress/metric
   * surfaces one level up.
   *
   * Ticket 141d9d92 (2026-09-24): 'narration_repeat' is the cross-turn
   * repeated-line break (03587322) — the run was ended because ONE narration
   * line repeated across ≥2 turns. NO tool failed and the `tool` field is a
   * synthetic label ('final_text' — no such tool exists), so the filing must
   * never render it as a "tool-failure streak" (the 141d9d92 artifact: the
   * ticket opened as "3× tool-failure streak: final_text", sending the
   * investigator to diff a nonexistent tool's changes instead of the
   * narration-repeat class). `repeats` carries the repeat count for the
   * title.
   */
  shape?: 'failure' | 'success_intent' | 'narration_repeat';
  /** narration_repeat only: cumulative copies of the repeated line. */
  repeats?: number | null;
}

// ── Reflection route pre-choice (N8, 2026-09-25) — purpose `reflection_route` ──
//
// WHY: the consult is a 45 s Double-Checker turn on every 3× streak
// (`tool_derail_break` ≈ 33/day) — 25–50 min/day of lane wall time. Much of
// the time the remedy is obvious from the evidence the harness already
// packaged (wrong parameters → retry grounded; the lane's own reasoning
// named another tool → call it; a schema/preflight/guard text → framework).
// The gate asks ONE typed Choice over the StreakEvidence:
//   retry_with_corrected_params | different_tool | deterministic_framework | needs_diagnosis
// MODES (decisionMode('reflection_route'); default shadow, NODE_ENV=test off):
//   shadow — the gate runs CONCURRENTLY with the consult (no latency added for
//            a normal consult; a FAST consult — keyless seat / seat error —
//            waits ≤ REFLECTION_ROUTE_POST_CONSULT_WAIT_MS, then labels async);
//            the outcome row's `actual` is the remedy the consult's advice
//            text prescribed (classifyConsultAdvice — 'label:consult'), or,
//            when the consult gave nothing classifiable, the next tool the
//            lane actually called when it was the intended different tool
//            ('label:next_tool'); otherwise null (unlabelled).
//   act    — DESIGNED, NOT ENABLED: the gate is awaited first; a confident
//            (≥ DECISION_GATE_THRESHOLD_REFLECTION_ROUTE, default 0.85)
//            non-needs_diagnosis route SKIPS the consult (acted:true) and the
//            caller may render a one-line typed hint instead; needs_diagnosis
//            (or an unconfident answer) consults exactly as before. Keyed on
//            the RESULT's mode (E2) — decisionMode() only schedules the wait.
// Fail-open: any gate failure ⇒ the consult runs as before. Kill switches:
// the gate-wide switches.

export type ReflectionRoute = 'retry_with_corrected_params' | 'different_tool' | 'deterministic_framework' | 'needs_diagnosis';
export const REFLECTION_ROUTES: readonly ReflectionRoute[] = ['retry_with_corrected_params', 'different_tool', 'deterministic_framework', 'needs_diagnosis'];
/** The question key on every reflection_route decision/outcome row. */
export const REFLECTION_ROUTE_QUESTION = 'route';
/** Acting confidence for the consult skip (DECISION_GATE_THRESHOLD_REFLECTION_ROUTE overrides). */
export const REFLECTION_ROUTE_DEFAULT_THRESHOLD = 0.85;
/** Gate deadline — well under the consult's 45 s; in act mode this is the added wait. */
export const REFLECTION_ROUTE_TIMEOUT_MS = 3000;
/** Shadow: the longest the consult's RETURN waits on a still-pending gate — the
 *  worst case added to a FAST consult (keyless seat / seat error); a slower
 *  consult outlasts the gate and adds nothing. Past it the label lands async. */
export const REFLECTION_ROUTE_POST_CONSULT_WAIT_MS = 250;
const PENDING: unique symbol = Symbol('pending');
const sleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); (t as any).unref?.(); });
/** Per-result head carried in the state (the consult prompt's own 400). */
export const REFLECTION_ROUTE_RESULT_CHARS = 400;

/** The typed question — the four remedies the consult prompt itself enumerates. */
export const REFLECTION_ROUTE_QUESTIONS: Record<string, DecisionQuestion> = {
  [REFLECTION_ROUTE_QUESTION]: {
    type: 'choice',
    instructions: 'A coding agent tripped a tool streak (its recent calls of one tool failed, or succeeded while its own reasoning named a different tool). From the evidence, which single remedy should the agent take next?',
    criteria: {
      retry_with_corrected_params: 'the same tool is right but its parameters were wrong, missing, stale or ungrounded (a nonexistent path/id, a malformed payload) — re-issue it with parameters grounded in a fresh read',
      different_tool: 'the agent meant a different tool (its reasoning named one, or the failure text says this tool cannot do what was attempted) — call that tool instead',
      deterministic_framework: 'the failure text is a framework, schema, preflight or guard rejection that will recur identically regardless of parameters — a retry cannot help; route around it and record it',
      needs_diagnosis: 'the evidence does not determine the remedy — an independent diagnosis of the failure texts is needed before the next call',
    },
  },
};

/** The gate state — the same evidence the consult prompt carries (counts first, prose last). Pure. */
export function buildReflectionRouteState(ev: StreakEvidence): Record<string, unknown> {
  const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const shape = ev.shape ?? 'failure';
  const state: Record<string, unknown> = {
    trip_shape: shape === 'success_intent'
      ? 'calls SUCCEEDED while the agent\'s reasoning named a different tool (wrong-tool loop)'
      : shape === 'narration_repeat'
      ? 'the run repeated one narration line across turns; no tool failed'
      : '3 consecutive failures of one tool',
    tool: ev.tool,
    second_streak_this_run: ev.perma === true,
    tool_named_by_agents_own_reasoning: ev.intended || undefined,
    recent_results_newest_first: ev.recentFailures.slice(0, 3).map((f) => clip(f, REFLECTION_ROUTE_RESULT_CHARS)),
    run_goal: ev.goalHint ? clip(ev.goalHint, 300) : undefined,
  };
  for (const k of Object.keys(state)) if (state[k] === undefined) delete state[k];
  return state;
}

// The consult's advice TEXT, classified into the route vocabulary — the
// shadow label. Clause-level: a clause with a negation word does not count
// as a positive mention ("the failures are not deterministic"). Precedence
// different_tool > deterministic_framework > retry_with_corrected_params >
// needs_diagnosis > null (unclassifiable — unlabelled, never guessed).
const NEGATION_RE = /\b(?:not|no|never|isn't|aren't|doesn't|don't|didn't|won't|cannot|can't|unlikely|neither|nor|without)\b/i;
const DIFFERENT_TOOL_RE = /\b(?:different|another|other|wrong|correct|intended|right) tool\b|\b(?:use|call|switch to|try|invoke|run) (?:the )?`?[a-z][a-z0-9_]*`? (?:instead|rather than)\b|\binstead (?:of [a-z_]+ )?(?:use|call) `?[a-z][a-z0-9_]*`?/i;
const DETERMINISTIC_RE = /\bdeterministic\b|\bframework(?:[-\s](?:side|issue|bug|error|defect|problem|rejection|gate))?\b|\bschema (?:pressure|mismatch|validation|error|rejection)\b|\bpreflight\b|\bguard (?:false[- ]positive|bug|rejection)\b|\bharness (?:bug|issue|error|rejection)\b/i;
/** "call/use/switch to <snake_case_tool>" — a tool other than the streak tool named as the thing to invoke. */
const NAMED_TOOL_RE = /\b(?:use|call|switch to|invoke|issue)\s+(?:the\s+)?`?([a-z][a-z0-9]*_[a-z0-9_]+)`?/i;
/**
 * Read-only GROUNDING tools (review 2026-09-25): the consult's natural retry
 * advice is "read the file with read_file / ls / grep first, then re-issue
 * <streak tool> with the real id" — the grounding read names another tool, but
 * the remedy is a corrected retry (REFLECTION_ROUTE_HINT.retry says exactly
 * this). Naming one of these never counts as "a different tool", so the
 * retry-vs-different_tool split is not biased toward different_tool. The
 * lane's own INTENDED tool still wins even when it is a grounding read.
 */
const GROUNDING_READ_TOOL_RE = /^(?:read_file|ls|grep|glob|find|cat|list_(?:dir|files|directory)|read_[a-z0-9_]+|search_[a-z0-9_]+|get_file_[a-z0-9_]+)$/i;
const RETRY_PARAMS_RE = /\b(?:wrong|invalid|missing|incorrect|ungrounded|malformed|bad|stale|nonexistent|non-existent|fabricated|hallucinated|made-up|real|actual|correct|exact|grounded|verified|right)\b[^.;!?]{0,60}\b(?:param|parameter|argument|arg|path|id|payload|field|value|name|filename|url)s?\b|\b(?:param|parameter|argument|arg|path|id|payload|field|value|filename)s?\b[^.;!?]{0,60}\b(?:wrong|invalid|missing|incorrect|ungrounded|malformed|real|actual|correct|exact|grounded|verified)\b|\bre-?(?:try|issue|run) (?:the )?(?:same )?(?:call|tool|command)\b|\bretry with\b|\bcorrect(?:ed)? (?:the )?(?:param|parameter|argument|path|id)/i;
const DIAGNOSIS_RE = /\bunclear\b|\b(?:cannot|can't|hard to|impossible to) (?:tell|determine|say|know)\b|\binvestigate\b|\binspect\b|\bdiagnos(?:e|is|tic)\b|\bmore (?:evidence|information|context|detail)\b|\b(?:first|before (?:anything|retrying|calling)) (?:read|check|inspect|look at|examine)\b|\bread the (?:error|log|stack|output)\b|\bneeds? (?:to )?(?:investigat|examin|inspect)/i;

const clauses = (text: string): string[] => text.split(/[.;!?\n]+|\s[—–]\s/).map((c) => c.trim()).filter(Boolean);
const mentionsPositively = (text: string, re: RegExp): boolean => clauses(text).some((c) => re.test(c) && !NEGATION_RE.test(c));

/** The remedy the consult's advice prescribed, or null when unclassifiable. Pure. */
export function classifyConsultAdvice(advice: string | null | undefined, ev?: Pick<StreakEvidence, 'tool' | 'intended'>): ReflectionRoute | null {
  const text = String(advice ?? '').trim();
  if (!text) return null;
  const namesIntended = !!ev?.intended && ev.intended !== ev.tool
    && mentionsPositively(text, new RegExp(`\\b(?:use|call|switch to|try|invoke|run|issue)\\b[^.;!?]{0,40}\\b${ev.intended.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
  // "call <some_other_tool> …" — a snake_case tool that is not the streak tool
  // (and not a read-only grounding tool — that is the retry's own vocabulary), named positively.
  const namesOtherTool = clauses(text).some((c) => {
    if (NEGATION_RE.test(c)) return false;
    // Every named tool in the clause ("use grep, then call update_canvas" names both).
    for (const m of c.matchAll(new RegExp(NAMED_TOOL_RE.source, 'gi'))) {
      const name = m[1];
      if (ev?.tool && name.toLowerCase() === ev.tool.toLowerCase()) continue;
      if (GROUNDING_READ_TOOL_RE.test(name)) continue;
      return true;
    }
    return false;
  });
  if (namesIntended || namesOtherTool || mentionsPositively(text, DIFFERENT_TOOL_RE)) return 'different_tool';
  if (mentionsPositively(text, DETERMINISTIC_RE)) return 'deterministic_framework';
  if (mentionsPositively(text, RETRY_PARAMS_RE)) return 'retry_with_corrected_params';
  if (mentionsPositively(text, DIAGNOSIS_RE)) return 'needs_diagnosis';
  return null;
}

/** ACT only: the one-line typed hint a caller may render in place of the skipped consult. */
export const REFLECTION_ROUTE_HINT: Record<Exclude<ReflectionRoute, 'needs_diagnosis'>, string> = {
  retry_with_corrected_params: 'The failures look like wrong or ungrounded parameters — re-issue the call with parameters grounded in a fresh read (ls / read_file / grep), never from memory.',
  different_tool: 'A different tool is the one intended — call it with its real name and its real parameters.',
  deterministic_framework: 'The failure text looks deterministic (a framework / schema / preflight / guard rejection), not a model error — do not retry the same call; route around it and record it honestly.',
};

/** The handle a caller holds until the lane's next tool call is known (or the run ends). */
export interface ReflectionRoutePending {
  decision: DecideResult;
  sessionId: string;
  streakTool: string;
  intended: string | null;
  /** The remedy the consult's advice text prescribed (null: consult skipped, failed, or unclassifiable). */
  consultVerdict: ReflectionRoute | null;
  /** Whether the consult actually ran (false under an act-mode skip). */
  consulted: boolean;
  /** ACT: the gate skipped the consult. */
  acted: boolean;
  /** ACT: the gate's confident route (a caller may render REFLECTION_ROUTE_HINT[route]). */
  route: ReflectionRoute | null;
}

/**
 * Record the outcome for a pending route decision. `nextTool` is the first
 * tool the lane called on its next turn (null: the run ended / answered in
 * prose first). The consult's classified remedy is the primary label; the
 * next tool labels only the unambiguous case (it was the intended different
 * tool) when the consult gave nothing classifiable. Fire-and-forget; never throws.
 */
export function labelReflectionRoute(pending: ReflectionRoutePending | null | undefined, nextTool: string | null): void {
  try {
    if (!pending?.decision) return;
    let actual: ReflectionRoute | null = null;
    let source: 'consult' | 'next_tool' | 'none' = 'none';
    if (pending.consultVerdict) { actual = pending.consultVerdict; source = 'consult'; }
    else if (nextTool && nextTool !== pending.streakTool && pending.intended && nextTool === pending.intended) { actual = 'different_tool'; source = 'next_tool'; }
    recordDecisionOutcome(pending.decision, 'reflection_route', {
      question: REFLECTION_ROUTE_QUESTION, actual, acted: pending.acted, sessionId: pending.sessionId,
      note: `label:${source} consult=${pending.consultVerdict ?? (pending.consulted ? 'unclassified' : 'skipped')} next=${nextTool ?? 'final'} streak=${pending.streakTool}`,
    });
  } catch { /* labels never break the breaker */ }
}

/** Start the route gate (never rejects; null when off / failed). */
function startReflectionRouteGate(ev: StreakEvidence): Promise<DecideResult | null> {
  try {
    if (decisionMode('reflection_route') === 'off') return Promise.resolve(null);
    return decide(buildReflectionRouteState(ev), REFLECTION_ROUTE_QUESTIONS, {
      purpose: 'reflection_route', timeoutMs: REFLECTION_ROUTE_TIMEOUT_MS, sessionId: ev.sessionId,
    }).catch((err: any) => { logger.debug(`reflection: route gate failed open: ${err?.message ?? err}`); return null; });
  } catch (err: any) {
    logger.debug(`reflection: route gate failed open: ${err?.message ?? err}`);
    return Promise.resolve(null);
  }
}

/**
 * One advisory turn from the cross-checker seat. Returns the advice text, or
 * null (seat keyless / call failed) — callers treat null as
 * "no advice", never as an error.
 *
 * N8: the route gate rides alongside. In shadow it runs concurrently with the
 * consult; in act (result.mode) a confident non-needs_diagnosis route skips
 * the consult (advice null, `pending.acted`). `opts.onRoutePending` receives
 * the pending label handle so the caller can label it with the lane's NEXT
 * tool call (labelReflectionRoute); without the callback the outcome is
 * recorded here from the consult's advice alone.
 */
export async function consultCrossCheckerOnStreak(ev: StreakEvidence, opts?: { onRoutePending?: (p: ReflectionRoutePending) => void }): Promise<string | null> {
  const gateP = startReflectionRouteGate(ev);
  let decision: DecideResult | null = null;
  const finish = (advice: string | null, acted: boolean, route: ReflectionRoute | null): void => {
    if (!decision) return;
    const pending: ReflectionRoutePending = {
      decision, sessionId: ev.sessionId, streakTool: ev.tool, intended: ev.intended ?? null,
      consultVerdict: acted ? null : classifyConsultAdvice(advice, ev), consulted: !acted, acted, route,
    };
    if (opts?.onRoutePending) { try { opts.onRoutePending(pending); } catch { /* caller's problem, never the consult's */ } }
    else labelReflectionRoute(pending, null);
  };
  try {
    // ACT scheduling only (never acting): when the purpose is armed, the gate
    // must answer BEFORE the consult can be skipped; acting keys on decision.mode.
    if (decisionMode('reflection_route') === 'act') {
      decision = await gateP;
      const a = decision?.answers[REFLECTION_ROUTE_QUESTION];
      const choice = a && a.type === 'choice' && (REFLECTION_ROUTES as readonly string[]).includes(a.choice) ? (a.choice as ReflectionRoute) : null;
      const threshold = decisionThreshold('reflection_route', REFLECTION_ROUTE_DEFAULT_THRESHOLD);
      if (decision?.mode === 'act' && choice && choice !== 'needs_diagnosis' && confidenceOf(a) >= threshold) {
        finish(null, true, choice);
        return null;
      }
    }
  } catch (err: any) {
    logger.debug(`reflection: route gate pre-wait failed open: ${err?.message ?? err}`);
  }
  const advice = await consultCrossCheckerSeat(ev);
  try {
    if (decision) { finish(advice, false, null); return advice; }
    // Shadow (review 2026-09-25): the consult normally outlasts the gate, but a
    // FAST consult (keyless seat → null at once; seat error) must not sit up to
    // REFLECTION_ROUTE_TIMEOUT_MS on the breaker path. Wait at most
    // REFLECTION_ROUTE_POST_CONSULT_WAIT_MS, then label asynchronously when the
    // gate answers — the advice returns now either way.
    const waited = await Promise.race<DecideResult | null | typeof PENDING>([gateP, sleep(REFLECTION_ROUTE_POST_CONSULT_WAIT_MS).then(() => PENDING)]);
    if (waited !== PENDING) { decision = waited; finish(advice, false, null); }
    else void gateP.then((d) => { decision = d; finish(advice, false, null); }).catch(() => { /* fail-open */ });
  } catch { /* labels never break the consult */ }
  return advice;
}

/** The consult itself — one bounded Double-Checker turn (unchanged by N8). */
async function consultCrossCheckerSeat(ev: StreakEvidence): Promise<string | null> {
  try {
    const { resolveRoleModelForRun, resolveProviderForRun } = await import('./coding-model');
    // The Double Checker seat (owner rename 2026-09-15; was chat_cross_checker).
    const model = await resolveRoleModelForRun('double_checker', 'deepseek-flash');
    const provider = await resolveProviderForRun(model);
    if (!provider.apiKey) return null; // keyless seat — honest skip
    const { postNonStreamingCompletion, extractNonStreamingAnswer } = await import('./helper-completion');
    // Ticket d73765fc: tell the cross-checker WHICH ladder tripped — a
    // success-side trip is a wrong-tool derailment on SUCCEEDING calls, and
    // the fixed "failure loop" framing pushed the diagnosis toward a
    // nonexistent tool defect.
    const system = (ev.shape === 'success_intent'
      ? 'You are an independent cross-checker consulted MID-RUN by another coding agent whose calls are SUCCEEDING while its own reasoning names a DIFFERENT tool (a wrong-tool loop, not a failure loop). '
      : 'You are an independent cross-checker consulted MID-RUN by another coding agent stuck in a tool-failure loop. ')
      + 'Diagnose briefly and prescribe the single best next step. Explicitly consider: wrong/ungrounded parameters; '
      + 'a different tool being intended; and whether the failure texts look DETERMINISTIC (framework/schema/gate) '
      + 'rather than model error — say which. Answer in at most 6 sentences, imperative, no preamble.';
    const user =
      `Stuck-lane evidence:\n- tool: ${ev.tool} (${ev.perma ? 'SECOND' : 'first'}`
      + (ev.shape === 'success_intent'
        ? ' streak this run, calls SUCCEEDED while the reasoning named a different tool)\n'
        : ' 3-failure streak this run)\n')
      + (ev.intended ? `- the lane's own reasoning named a different tool: ${ev.intended}\n` : '')
      + `- ${ev.shape === 'success_intent' ? 'recent tool results (newest first — all successes)' : 'recent failure results (newest first)'}:\n${ev.recentFailures.slice(0, 3).map(f => `  · ${f.slice(0, 400)}`).join('\n')}\n`
      + (ev.goalHint ? `- run goal: ${String(ev.goalHint).slice(0, 300)}\n` : '');
    const resp = await postNonStreamingCompletion(
      provider,
      { model: provider.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 2048, ...(provider.extra ?? {}) },
      // The consult WANTS the seat's reasoning (a different decoder diagnosing a
      // stuck lane) — keep the provider's thinking extras; the fast-seat
      // thinking-off default of this path is for digests/titles.
      { timeout: 45_000, keepThinking: true },
    );
    const ans = extractNonStreamingAnswer(resp?.data?.choices?.[0]);
    const text = (ans?.text ?? '').trim();
    return text || null;
  } catch (err: any) {
    logger.warn(`reflection: cross-checker consult failed (fail-open, no advice): ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Auto-file ONE investigation ticket per (session, tool) per 24h (Redis NX):
 * "framework or model?" — attribution work for the fleet's ticket loop, never
 * an owner card. Fire-and-forget; swallows every failure.
 * Returns the filed ticket's id — on a dedupe-window hit, the id of the ticket
 * filed earlier in the window (the NX key stores it as its value), else null.
 * Ticket 78f32515: callers that notify the lane about the trip (the breaker
 * lane notice below) need the id to NAME the auto-filed ticket.
 */
export async function fileStreakInvestigation(ev: StreakEvidence): Promise<string | null> {
  const dedupeKey = `reflect:ticket:${ev.sessionId}:${ev.tool}`;
  try {
    const nx = await (redisClient as any).set(dedupeKey, '1', { NX: true, EX: 86_400 });
    if (nx !== 'OK') {
      // Already filed inside the window — surface the stored id when known
      // (a value of '1' predates the id-stamping write or the create failed).
      try {
        const v = await (redisClient as any).get(dedupeKey);
        return typeof v === 'string' && v.length > 8 ? v : null;
      } catch { return null; }
    }
    const chat = await prisma.crossModelChat.findUnique({ where: { id: ev.sessionId }, select: { userId: true, title: true } });
    if (!chat) return null;
    // Ticket d73765fc: render the trip's SHAPE in the title + description —
    // a success-side trip (2c98b460) is "5× success-side wrong-tool loop",
    // never a "3× tool-failure streak". The incident artifact: search_memory
    // succeeded ×5 while reasoning named web_pipe, and the auto-filed title
    // called it a tool-failure streak — the fixed-text mislabel class one
    // surface below the notice/progress/metrics threads 2c98b460 already
    // fixed. Keeping the "framework or model?" mandate identical.
    const successShape = ev.shape === 'success_intent';
    const narrationShape = ev.shape === 'narration_repeat';
    // Ticket 141d9d92: a narration-repeat trip is NOT a tool failure — no tool
    // was called wrong and none failed; the run was ended because one line of
    // the model's own narration repeated across turns. Render the class
    // truthfully (d73765fc precedent) so the investigator is pointed at the
    // cross-turn line-repeat guard seam, not a nonexistent tool's changes.
    const title = narrationShape
      ? `${ev.repeats ?? 3}× narration-repeat run-end: "${String(chat.title ?? ev.sessionId).slice(0, 40)}" — framework or model?`
      : successShape
      ? `5× success-side wrong-tool loop: ${ev.tool} on "${String(chat.title ?? ev.sessionId).slice(0, 40)}" — framework or model?`
      : `3× tool-failure streak: ${ev.tool} on "${String(chat.title ?? ev.sessionId).slice(0, 40)}" — framework or model?`;
    // af4ef7c7 — attach a same-class repeat to the ADJUDICATED row instead of
    // buying another lane. This filer writes with a raw prisma.create, so it
    // never entered fileFeedbackTicket's dedupe passes at all; and its titles
    // embed the MUTABLE chat title, so the title-equality arm could not have
    // matched two sightings of one class anyway (59118fe0 vs 2c98b460: one
    // class, never attached). The key is STRUCTURAL — the trip's shape plus the
    // tool pair the detector convicted on — never the chat title. null for a
    // plain 'failure' streak (no discriminator ⇒ no key ⇒ unchanged filing).
    const classKey = breakerClassKey({ shape: ev.shape, tool: ev.tool, intended: ev.intended });
    const filedContext: Record<string, unknown> = {
      sessionId: ev.sessionId,
      ...(ev.runId ? { runId: ev.runId } : {}),
      filedAt: new Date().toISOString(),
      about: 'digby_platform',
      surface: 'coding',
      breakerShape: ev.shape ?? 'failure',
      ...(classKey ? { [BREAKER_CLASS_KEY_FIELD]: classKey } : {}),
    };
    const description =
      `Auto-filed at breaker trip (owner doctrine 2026-09-10: self-heal + attribute, never just escalate).\n`
      + `Session ${ev.sessionId}${ev.runId ? `, run ${ev.runId}` : ''}; ${narrationShape ? `cross-turn narration-repeat break (ticket 03587322 guard) — no tool failed; synthetic label '${ev.tool}';` : `tool ${ev.tool};`}${ev.perma ? ' second' : ' first'} streak this run`
      + (successShape ? '; 5 consecutive SUCCEEDING calls whose reasoning named a different tool' : '')
      + (ev.intended ? `; lane's reasoning named ${ev.intended}` : '') + '.\n'
      + `${narrationShape ? 'Repeated narration line' : successShape ? 'Recent tool results (newest first — every call SUCCEEDED)' : 'Failure texts (newest first)'}:\n${ev.recentFailures.slice(0, 3).map(f => `· ${f.slice(0, 500)}`).join('\n')}\n\n`
      // DW-4 (568d3652 gap): the ARGS that produced those texts, rendered
      // AFTER them — attribution needs no one-off transcript probe. Empty
      // when the capture was kill-switched or the trip predates the field.
      + (ev.recentArgs?.length ? `Call args of those ${successShape ? 'succeeding' : 'failing'} calls (newest first):\n${ev.recentArgs.slice(0, 3).map(a => `· ${a.slice(0, 200)}`).join('\n')}\n\n` : '')
      + `INVESTIGATE: determine whether a DETERMINISTIC framework/schema/preflight/guard issue causes this streak `
      + `(diff the failure texts against recent framework changes); fix it if so. Otherwise record it as model `
      + `behavior WITH evidence. Do not re-steer with generic claim discipline (known no-op).`;
    if (classKey) {
      // Fail-open: an attach failure must never block the breaker ticket, which
      // still files below exactly as before this fix.
      try {
        const attached = await bumpAdjudicatedClassSighting({
          classKey,
          type: 'mishap',
          description,
          context: filedContext,
        });
        if (attached) {
          // Stamp the id as the dedupe key's value (same contract as below) so
          // a repeat trip in the window still NAMES the ticket carrying the class.
          try { await (redisClient as any).set(dedupeKey, attached.attached, { KEEPTTL: true }); } catch { /* id stays unknown to dedupe hits */ }
          return attached.attached;
        }
      } catch (err: any) {
        logger.warn(`reflection: adjudicated-class attach unavailable (fail-open to normal filing): ${err?.message ?? err}`);
      }
    }
    const created = await prisma.userFeatureRequest.create({
      data: {
        userId: chat.userId,
        type: 'mishap',
        status: 'open',
        source: 'agent-harness',
        title,
        context: filedContext as any,
        description,
      },
    });
    // Stamp the id as the dedupe key's value so a repeat trip inside the
    // window can NAME the already-filed ticket (KEEPTTL preserves the 24h).
    try { await (redisClient as any).set(dedupeKey, created.id, { KEEPTTL: true }); } catch { /* id stays unknown to dedupe hits */ }
    return created.id as string;
  } catch (err: any) {
    logger.warn(`reflection: investigation ticket not filed (non-fatal): ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Ticket 78f32515 — the DERAILED lane's own signal for a breaker trip. Until
 * this existed, a lane whose run was ended by the narrated-tool-emit loop
 * breaker learned about it only indirectly (the auto-filed ticket lands in the
 * SUPERVISOR's queue; the attention_needed alarm reaches hook subscribers) —
 * its own next firing never saw WHY the previous run died. On trip the caller
 * writes ONE line here; the run-executor consumes it (exactly once) into the
 * next top-level run's [SCHEDULER NOTICE] context channel. Redis-backed,
 * best-effort: the ticket remains the durable record if the notice is lost.
 */
const BREAKER_LANE_NOTICE_TTL_SEC = 7 * 24 * 3600;

export async function writeBreakerLaneNotice(
  sessionId: string,
  n: { breaker: string; tool: string | null; repeats: number; snippet: string; ticketId?: string | null },
): Promise<void> {
  try {
    const line =
      `[BREAKER NOTICE] Your previous run was ended by the ${n.breaker} breaker: the run announced `
      + `"${n.snippet}" ${n.repeats}× but ${n.tool ?? 'the announced tool'} never executed — that action did NOT happen. `
      + (n.ticketId ? `Attribution ticket ${n.ticketId} was auto-filed for it. ` : 'An attribution ticket was auto-filed for it. ')
      + `If the action still needs to happen, re-issue it as a REAL tool call this run; if it is moot, say so and move on.`;
    await (redisClient as any).set(`breaker:lane-notice:${sessionId}`, line, { EX: BREAKER_LANE_NOTICE_TTL_SEC });
  } catch (err: any) {
    logger.warn(`reflection: breaker lane notice not written (non-fatal): ${err?.message ?? err}`);
  }
}

/** One-shot read for the run-executor's [SCHEDULER NOTICE] composition. */
export async function consumeBreakerLaneNotice(sessionId: string): Promise<string | null> {
  try {
    const key = `breaker:lane-notice:${sessionId}`;
    let v: any;
    try {
      v = await (redisClient as any).getDel(key); // Redis 6.2+ (node-redis v4 camelCase — reviewer-verified live: getdel does not exist)
    } catch {
      v = await (redisClient as any).get(key);
      if (v) await (redisClient as any).del(key);
    }
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}
