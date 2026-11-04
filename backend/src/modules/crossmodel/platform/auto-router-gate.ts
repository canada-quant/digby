/**
 * Auto router + decision gate (2026-09-24). `routeMessageHeuristic`
 * (auto-router.ts) stays the PURE zero-latency baseline — this wrapper asks
 * the `decision` seat for the patience level and, in ACT mode, uses a
 * confident answer; SHADOW records agreement with the heuristic; OFF returns
 * the heuristic untouched. Never throws, never slower than its timeout.
 *
 * Patience plan Phase 1a (docs/PATIENCE_AUTO_ONLY_DEPRECATION_PLAN_2026-09-25.md
 * §3.2 / §3.4 / §4.1, 2026-09-25 — switch OFF, nothing user-visible changes):
 *   - `allowDeepResearch:false` clamps a Level 3 pick to Ensemble AFTER the
 *     decision with a code-selected `reasonKey` — the clamp never enters the
 *     state or the question, so the shadow dataset stays comparable across
 *     the flip; the outcome row keeps `actual = heuristic.level` (pre-clamp).
 *   - the Level 3 acting bar has its OWN env (DECISION_GATE_THRESHOLD_
 *     AUTO_ROUTE_DEEP_RESEARCH); the generic DECISION_GATE_THRESHOLD_AUTO_ROUTE
 *     can never LOWER it below 0.85.
 *   - every outcome row carries `heuristic`, `segment`, `modeSource`,
 *     `reasonKey`, `clamped`, `source` (the readout's three-way U × H × gate).
 *   - the LABEL WINDOW (`shadowAutoRouteAgainst`): while the pickers are live
 *     and ONLY for a level the user PICKED this send (the controller gates on
 *     modeSource === 'picked' — §4.2 "only picked counts as U"; this function
 *     refuses anything else too, so egress is zero until the client sends it),
 *     an EXPLICIT-level user send fires the same question in shadow with
 *     `actual` = the level the user picked (note user_picked / user_default /
 *     user_explicit by the client's `modeSource`), non-blocking, on the
 *     decision SEAT chain (TypeSafe Jev in prod — owner Q1 answered 2026-09-26
 *     by asking for the back-test over all user chats; the web client sends
 *     `modeSource` since the same day), throttled by LABEL_WINDOW_SAMPLE_PERCENT.
 *     LABEL_WINDOW_DECISION_SPEC still pins another backend (e.g.
 *     deepseek-flash, the pre-Q1 readout). Kill switch
 *     DECISION_GATE_AUTO_ROUTE_LABEL_WINDOW_DISABLED=1.
 *
 * Kept out of auto-router.ts so that leaf module (and its pure tests) stays
 * import-free; both send seams (stream controller, platform send) call this.
 * The SAME question text is used by every caller (`autoRouteQuestions`) so
 * rows share one questionsHash (E3/E7 partition key).
 */

import logger from '../../../utils/logger';
import type { RoutableLevel } from '../types';
import { routeMessageHeuristic, type AutoRouteDecision, type AutoRouteInput, type HeuristicReasonKey } from './auto-router';
import {
  decide, decisionMode, decisionOptionThreshold, decisionThreshold, recordDecisionOutcome,
  type DecideResult, type DecisionAnswer, type DecisionQuestion,
} from './decision-gate';
import { skipRetiredHumanAsk } from './human-turn-retirement';

/** Code-selected reason on every routed message (§3.7 tooltip vocabulary). */
export type AutoRouteReasonKey = HeuristicReasonKey | 'decision_gate' | DeepResearchDenyReason;
/** Why Level 3 was not allowed (the clamp's reason). 2026-09-26 audit (send-mode.ts): supervisor chats, non-human origins and chatless (Telegram) sends are clamped too. */
export type DeepResearchDenyReason = 'quota_exhausted' | 'quota_unavailable' | 'guest_no_research' | 'supervisor_no_research' | 'channel_floor' | 'chatless_no_research';
/** The clamp tag a deny reason stamps on routing.clamped / the outcome row. */
export type DeepResearchClamp = 'quota' | 'supervisor' | 'channel_floor' | 'chatless';
export function clampFor(reasonKey: DeepResearchDenyReason): DeepResearchClamp {
  if (reasonKey === 'supervisor_no_research') return 'supervisor';
  if (reasonKey === 'channel_floor') return 'channel_floor';
  if (reasonKey === 'chatless_no_research') return 'chatless';
  return 'quota';
}
/** 'supervisor' (2026-09-26 audit, routing-unify-7): a fleet / project supervisor chat — the SAME segment the compute_policy row stamps, so the two gates classify one send alike. */
export type AutoRouteSegment = 'user' | 'guest' | 'telegram' | 'machine' | 'supervisor';
/** The client's account of how the level was chosen (label window §4.2). */
export type ModeSource = 'picked' | 'default' | 'restored';
export const MODE_SOURCES: readonly ModeSource[] = ['picked', 'default', 'restored'];

export function normalizeModeSource(v: unknown): ModeSource | undefined {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (MODE_SOURCES as readonly string[]).includes(s) ? (s as ModeSource) : undefined;
}

export interface AutoRouteOutcome extends Omit<AutoRouteDecision, 'reasonKey'> {
  /** Which judge picked the level. */
  source: 'heuristic' | 'decision';
  /** Code-selected reason for the RESOLVED level (post-clamp). */
  reasonKey: AutoRouteReasonKey;
  /** The heuristic's own pick — on every outcome, including gate-routed and clamped ones. */
  heuristicLevel: RoutableLevel;
  /** Gate confidence when the gate picked. */
  confidence?: number;
  /** Backend label when the gate picked. */
  backend?: string;
  /** Set when a Level 3 pick was demoted to Ensemble by the allowance / a floor. */
  clamped?: DeepResearchClamp;
  /** The pre-clamp level (only when clamped). */
  requestedLevel?: RoutableLevel;
}

export interface AutoRouteOpts extends AutoRouteInput {
  sessionId?: string;
  /** false = a Level 3 pick is demoted to Ensemble (§3.4). Default true. */
  allowDeepResearch?: boolean;
  /** Why Level 3 is disallowed (stamped as reasonKey on the clamp). Default quota_exhausted. */
  allowDeepResearchReason?: DeepResearchDenyReason;
  segment?: AutoRouteSegment;
  modeSource?: ModeSource;
  /** The level the user asked for when patience_auto_only rewrote the send to Auto (settings-switches-4: rides every outcome row so the human pick is never lost). */
  requestedMode?: string;
}

/** Request-path bound: the user is waiting for the first token. */
export const AUTO_ROUTE_TIMEOUT_MS = 1500;
/** Label-window bound — off the request path (fire-and-forget), so the readout leg gets room. */
export const LABEL_WINDOW_TIMEOUT_MS = 4000;
/**
 * The label window's default backend: 'seat' = the decision seat's normal
 * chain (TypeSafe Jev in prod). Was 'deepseek-flash' (the logprob readout —
 * a provider that already saw every chat message) while owner Q1 (patience
 * plan §10: TypeSafe egress for explicit-level sends) was open; the owner
 * answered it on 2026-09-26 by asking for the back-test over all user chats.
 * LABEL_WINDOW_DECISION_SPEC overrides; the kill switch is unchanged.
 */
export const LABEL_WINDOW_DEFAULT_SPEC = 'seat';
/** The Level 3 acting floor the generic threshold env can never lower (§3.2). */
export const AUTO_ROUTE_L3_THRESHOLD_FLOOR = 0.85;
export const AUTO_ROUTE_DEFAULT_THRESHOLD = 0.7;

const LEVELS: readonly RoutableLevel[] = ['single_thinking', 'thinking', 'deep_research'];

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** A threshold env as a number, or null when unset / BLANK / garbage (mirrors decision-gate thresholdEnvNumber; kept local so the mocked-boundary tests hold). */
const thresholdEnvNumber = (raw: string | undefined): number | null => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/**
 * Per-level acting threshold. Level 3: DECISION_GATE_THRESHOLD_AUTO_ROUTE_
 * DEEP_RESEARCH when set (explicit, the Phase 2 refit), else max(generic, 0.85)
 * — the generic env cannot lower the council bar. Levels 1/2: the generic env
 * or 0.7. Clamped to [0.5, 1] by the decision-gate helpers.
 */
export function autoRouteThreshold(level: RoutableLevel): number {
  if (level !== 'deep_research') return decisionThreshold('auto_route', AUTO_ROUTE_DEFAULT_THRESHOLD);
  // A BLANK per-option env (compose `${VAR:-}` passthrough) is UNSET, never an
  // explicit override — the 0.85 floor holds (audit 2026-09-26, settings-switches-1).
  const explicit = thresholdEnvNumber(process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH);
  const own = decisionOptionThreshold('auto_route', 'deep_research', AUTO_ROUTE_L3_THRESHOLD_FLOOR);
  return explicit !== null ? own : Math.max(own, AUTO_ROUTE_L3_THRESHOLD_FLOOR);
}

/** The gate's state for one message — exactly the MVP shape (§3.3): the typed message + the workspace flag. */
export function autoRouteState(input: AutoRouteInput): { message: string; chat_has_code_workspace: boolean } {
  return { message: String(input.content || '').slice(0, 4000), chat_has_code_workspace: !!input.hasWorkspace };
}

/** The ONE `level` question every auto_route router site asks (text pinned — a rewording resets comparability). */
export function autoRouteQuestions(): Record<string, DecisionQuestion> {
  return {
    level: {
      type: 'choice',
      instructions: 'Which patience level should answer this message? When unsure, prefer the cheaper level.',
      criteria: {
        single_thinking: 'Level 1 — one short, simple, single-part factual lookup or quick answer that one model gives directly',
        thinking: 'Level 2 (the default) — an ordinary question or task that benefits from a second model cross-checking the answer in parallel',
        deep_research: 'Level 3 — the user explicitly asks for deep research: a comprehensive report, literature / market analysis, many cited sources, or a very long multi-part brief',
      },
    },
  };
}

/** Outcome-row extras shared by the router and the label window (§3.2 "Outcome rows gain"). */
function outcomeExtra(o: { heuristic: RoutableLevel; source: 'heuristic' | 'decision'; segment?: AutoRouteSegment; modeSource?: ModeSource; reasonKey?: AutoRouteReasonKey; clamped?: DeepResearchClamp; labelWindow?: boolean; requestedMode?: string }): Record<string, unknown> {
  return {
    heuristic: o.heuristic,
    source: o.source,
    ...(o.segment ? { segment: o.segment } : {}),
    ...(o.modeSource ? { modeSource: o.modeSource } : {}),
    ...(o.reasonKey ? { reasonKey: o.reasonKey } : {}),
    ...(o.clamped ? { clamped: o.clamped } : {}),
    ...(o.labelWindow ? { labelWindow: true } : {}),
    ...(o.requestedMode ? { requestedMode: o.requestedMode } : {}),
  };
}

/** Apply the allowance AFTER the decision (never fed into the state / question). */
function clampLevel(out: AutoRouteOutcome, opts: AutoRouteOpts): AutoRouteOutcome {
  if (opts.allowDeepResearch !== false || out.level !== 'deep_research') return out;
  const reasonKey: DeepResearchDenyReason = opts.allowDeepResearchReason ?? 'quota_exhausted';
  return {
    ...out,
    level: 'thinking',
    requestedLevel: 'deep_research',
    clamped: clampFor(reasonKey),
    reasonKey,
    reason: `${out.reason} — demoted to Ensemble (${reasonKey.replace(/_/g, ' ')})`,
  };
}

export async function routeMessageAuto(input: AutoRouteOpts): Promise<AutoRouteOutcome> {
  const heuristic = routeMessageHeuristic(input);
  const base: AutoRouteOutcome = { ...heuristic, source: 'heuristic', heuristicLevel: heuristic.level };
  const mode = decisionMode('auto_route');
  if (mode === 'off') return clampLevel(base, input);
  // roster 2026-10-06 B-2: retired on HUMAN turns (AUROC 0.459 on the 2026-10-06 readout; the turn plan classifies
  // the lane) — a human segment's send takes the heuristic level exactly as OFF does, with one decision_ask_retired
  // row. A 'machine' segment (an explicit-auto machine send) still asks. Kill switches:
  // DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED=1 / DECISION_GATE_AUTO_ROUTE_HUMAN_RETIRE_LIFTED=1.
  if (input.segment && input.segment !== 'machine' && skipRetiredHumanAsk('auto_route', { site: 'route', segment: input.segment, sessionId: input.sessionId })) {
    return clampLevel(base, input);
  }
  const ask = () => decide(autoRouteState(input), autoRouteQuestions(), { purpose: 'auto_route', timeoutMs: AUTO_ROUTE_TIMEOUT_MS, sessionId: input.sessionId });
  const extraBase = { heuristic: heuristic.level, segment: input.segment, modeSource: input.modeSource, requestedMode: input.requestedMode };
  if (mode === 'shadow') {
    // SHADOW never delays the first token: the heuristic answers now, the
    // gate's answer lands as an outcome row whenever it arrives.
    const out = clampLevel(base, input);
    void ask()
      .then(r => recordDecisionOutcome(r, 'auto_route', {
        question: 'level', actual: heuristic.level, acted: false, sessionId: input.sessionId,
        extra: outcomeExtra({ ...extraBase, source: 'heuristic', reasonKey: out.reasonKey, clamped: out.clamped }),
      }))
      .catch(() => { /* never surfaces */ });
    return out;
  }
  try {
    const r = await ask();
    if (!r) return clampLevel(base, input);
    const a = r.answers.level as Extract<DecisionAnswer, { type: 'choice' }>;
    const level = a.choice as RoutableLevel;
    // Bias cheap, exactly like the heuristic: Level 3 needs a stronger read.
    const threshold = autoRouteThreshold(LEVELS.includes(level) ? level : 'thinking');
    // E2 (2026-09-25): the RESULT's mode gates acting (an uncalibrated backend answers as 'shadow').
    if (r.mode === 'act' && LEVELS.includes(level) && a.confidence >= threshold) {
      const out = clampLevel({
        ...base,
        level,
        reasonKey: 'decision_gate',
        reason: `decision gate: ${level} (confidence ${a.confidence.toFixed(2)}; heuristic said ${heuristic.level})${heuristic.suggestCode ? '; code intent + workspace → suggest Code' : ''}`,
        source: 'decision',
        confidence: a.confidence,
        backend: r.backend,
      }, input);
      recordDecisionOutcome(r, 'auto_route', {
        question: 'level', actual: heuristic.level, acted: true, sessionId: input.sessionId,
        extra: outcomeExtra({ ...extraBase, source: 'decision', reasonKey: out.reasonKey, clamped: out.clamped }),
      });
      return out;
    }
    const out = clampLevel(base, input);
    recordDecisionOutcome(r, 'auto_route', {
      question: 'level', actual: heuristic.level, acted: false, sessionId: input.sessionId,
      extra: outcomeExtra({ ...extraBase, source: 'heuristic', reasonKey: out.reasonKey, clamped: out.clamped }),
    });
    return out;
  } catch (err: any) {
    logger.warn(`auto router: decision gate failed (${err?.message || err}) — heuristic level stands`);
  }
  return clampLevel(base, input);
}

// ── Label window (Phase 1a, §4.1 stream 2) ───────────────────────────────────

/** DECISION_GATE_AUTO_ROUTE_LABEL_WINDOW_DISABLED=1 — explicit-level sends never fire the shadow gate. */
export function labelWindowDisabled(): boolean {
  return onFlag(process.env.DECISION_GATE_AUTO_ROUTE_LABEL_WINDOW_DISABLED);
}

/** LABEL_WINDOW_SAMPLE_PERCENT (default 100; clamped 0..100; 0 = none). */
export function labelWindowSamplePercent(): number {
  const raw = process.env.LABEL_WINDOW_SAMPLE_PERCENT;
  if (raw === undefined || String(raw).trim() === '') return 100;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 100;
}

/**
 * LABEL_WINDOW_DECISION_SPEC: the backend spec the label window asks.
 * 'seat' (the default since 2026-09-26) = undefined here, i.e. `decide()`
 * walks the seat chain (seat → fallback → built-in jev → readout) and memoises
 * as it does for the router; any other value is a pinned `spec` ask
 * (memo:true so identical repeated sends still hit the E3 memo).
 */
export function labelWindowSpec(): string | undefined {
  const raw = String(process.env.LABEL_WINDOW_DECISION_SPEC ?? '').trim() || LABEL_WINDOW_DEFAULT_SPEC;
  return raw.toLowerCase() === 'seat' ? undefined : raw;
}

export type LabelWindowNote = 'user_picked' | 'user_default' | 'user_explicit';

/** The outcome note for an explicit-level send: only `picked` counts as U (§4.2); no client signal = user_explicit. */
export function labelWindowNote(modeSource: ModeSource | undefined): LabelWindowNote {
  if (modeSource === 'picked') return 'user_picked';
  if (modeSource === 'default' || modeSource === 'restored') return 'user_default';
  return 'user_explicit';
}

/**
 * Fire the shadow auto_route gate against the level the user PICKED this
 * send (opts.modeSource must be 'picked' — a default / restored / unsignalled
 * level is not a human label and makes NO call). Non-blocking by contract
 * (callers `void` it); never throws; never changes the send. One outcome
 * row: actual = the user's level, note user_picked, meta.heuristic = the
 * regex's pick on the same message, meta.labelWindow. Identical repeated
 * sends answer from the E3 memo (memo:true — the spec ask opts in).
 */
export async function shadowAutoRouteAgainst(
  input: AutoRouteInput & { sessionId?: string },
  actualLevel: RoutableLevel,
  opts: { modeSource?: ModeSource; segment?: AutoRouteSegment; random?: () => number } = {},
): Promise<void> {
  try {
    if (labelWindowDisabled()) return;
    if (opts.modeSource !== 'picked') return;
    if (decisionMode('auto_route') === 'off') return;
    // roster 2026-10-06 B-2: the label window is a human-send ask — retired with the router's human asks.
    if ((opts.segment ?? 'user') !== 'machine' && skipRetiredHumanAsk('auto_route', { site: 'label_window', segment: opts.segment ?? 'user', sessionId: input.sessionId })) return;
    const pct = labelWindowSamplePercent();
    if (pct <= 0) return;
    if (pct < 100 && (opts.random ?? Math.random)() * 100 >= pct) return;
    const heuristic = routeMessageHeuristic(input);
    const spec = labelWindowSpec();
    const r = await decide(autoRouteState(input), autoRouteQuestions(), {
      purpose: 'auto_route', timeoutMs: LABEL_WINDOW_TIMEOUT_MS, sessionId: input.sessionId, ...(spec ? { spec, memo: true } : {}),
    });
    recordDecisionOutcome(r, 'auto_route', {
      question: 'level', actual: actualLevel, acted: false, sessionId: input.sessionId,
      note: labelWindowNote(opts.modeSource),
      extra: outcomeExtra({ heuristic: heuristic.level, source: 'heuristic', segment: opts.segment ?? 'user', modeSource: opts.modeSource, labelWindow: true }),
    });
  } catch (err: any) {
    logger.warn(`auto router: label window failed (${err?.message || err}) — send unaffected`);
  }
}

export type { DecideResult };
