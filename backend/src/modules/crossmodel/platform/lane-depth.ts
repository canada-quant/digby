/**
 * LANE DEPTH — the turn plan decides depth (roster 2026-10-06, Team A; owner: "drop the presets, fully agentic",
 * docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md option B phases 3b / 3c / 5).
 *
 * Before this module the turn plan (platform/turn-plan.ts) chose only the LEAD model (the Quick lane + the per-turn
 * model pick); whether a turn got a Double Checker or the research council still came 100 % from the keyword presets
 * (readiness report 2026-10-06 §2: 20 / 31 non-Quick plain turns ran a different checker decision than the turn
 * plan's own lane). Three act paths move depth onto the lanes, each behind its own store flag + the owner canary:
 *
 *   A-2  CHECKER BY LANE (`laneChecker`): lane standard ⇒ no Double Checker, lane checked ⇒ the checker, picked from
 *        the checker pool in a different model family than the lead (fail-open: the double_checker seat). The plan
 *        records `source: 'turn_plan'` and `lane`. Guards (like the Quick guards — a checker is only DROPPED on a
 *        confident, low-stakes, uncontested read): p(quick) + p(standard) ≥ 0.8, stakes < 0.6, contested < 0.5, and
 *        the trait rule (turn-plan.ts ruleAdjustedLane) never reads checked / research. Otherwise the checker runs.
 *        FOLLOW-UP HYSTERESIS (2026-10-20, the Quick guard's rule): a follow-up (follow_up ≥ 0.5) in a session whose
 *        prior lane is checked / research keeps the checker (a drug-interaction thread's "and with ibuprofen?" reads
 *        standard on its own) — LANE_CHECKER_FOLLOW_UP_DISABLED=1 restores the drop.
 *   A-3  RESEARCH ROUTING (`laneResearch`, at the controller — platform.service REST seam too): a confident research
 *        lane (argmax research with p ≥ 0.5, the near-tie / breadth-4 trait rule, or an explicit keyword research
 *        request with p(research) ≥ 0.2) routes to the council through the controller's existing quota reserve (an
 *        Auto send that loses it is demoted to Ensemble — never an error); a keyword Level 3 the turn plan does not
 *        call research is RETIRED to Ensemble (KEYWORD_L3_RETIRE_DISABLED=1 keeps it). A sender the router's Level 3
 *        ALLOWANCE refused (send-mode.ts allowDeepResearch — guest_no_research, quota, supervisor, chatless) is never
 *        lane-routed to the council: the route is 'denied' (2026-10-20 — 'denied' used to need routing.clamped, which
 *        exists only when the router itself picked Level 3, so a guest whose router said Level 2 reached a council).
 *   A-4  PRESET-FREE DEFAULT (`laneFailOpen`): when the turn plan has no usable answer (purpose off / timeout / error /
 *        an uncalibrated backend) a governed turn runs "standard on the seat" (no checker, no council) instead of the
 *        keyword preset; Dig-deeper rungs are lane steps (quick / standard → checked → research —
 *        compute-policy-wiring.ts nextLaneRung); the deep-research quota keys on the research lane (chat-gate.ts
 *        decideChatGate `lane`); Quick eligibility
 *        no longer needs a Level 1 / 2 preset on a governed ask (QuickLaneContext.presetFree). Presets survive only
 *        as internal aliases (laneToPreset / presetLane) for stored modes and API callers.
 *
 * STORE FLAGS — ONE context-store row shared with the turn plan, ['instance','turn-plan'] / 'config'
 * (scripts/framework-audit/set-lane-depth.js writes them; 30 s cache; a read failure = the defaults):
 *   laneChecker / laneResearch / laneFailOpen: 'off' | 'shadow' | 'act'   (absent ⇒ 'shadow')
 *       off    = nobody acts (the would-act is still recorded on the lane_depth row)
 *       shadow = only the per-feature CANARY acts; everyone else records the would-act
 *       act    = every eligible human turn acts (guests included)
 *   laneCanaryUserIds: string[]   (absent ⇒ [the owner, 83e4fbf9-…] — "starts on the owner canary"; [] = nobody)
 *
 * Every path FAILS OPEN to today's behaviour: a read error, a missing / uncalibrated answer (except the A-4 flag,
 * whose whole point is a lane fail-open), an unservable pool model ⇒ the preset / the seat. Never a supervisor chat,
 * a machine wake, a Dig-deeper rung, a council run or a kid.
 *
 * KILL SWITCHES (env; each restores today's behaviour for its piece): LANE_DEPTH_DISABLED (all three),
 * LANE_CHECKER_DISABLED, LANE_RESEARCH_ROUTING_DISABLED, LANE_FAIL_OPEN_DISABLED, KEYWORD_L3_RETIRE_DISABLED,
 * LANE_CHECKER_POOL_DISABLED (the seat checker even when a checker pool exists), QUICK_PRESET_FREE_DISABLED,
 * LANE_CHECKER_FOLLOW_UP_DISABLED (no follow-up hysteresis on the A-2 checker drop);
 * TURN_PLAN_DISABLED=1 also turns every lane path off (no classifier ⇒ the presets). Guard overrides (blank = unset):
 * LANE_STANDARD_THRESHOLD, LANE_CHECKER_STAKES_CEILING, LANE_CHECKER_CONTESTED_CEILING, LANE_RESEARCH_THRESHOLD,
 * LANE_RESEARCH_EXPLICIT_FLOOR.
 *
 * TELEMETRY: loop_metrics `lane_depth` (one row per eligible human turn: the turn plan's lane, the would-act and the
 * acted decision per feature, what RAN) and `lane_research` (one row per controller research ask).
 */

import logger from '../../../utils/logger';
import type { DepthPlan, DepthPreset } from './compute-policy-gate';
import { ceilingFromEnv, QUICK_LANE_FOLLOW_UP_CEILING } from './quick-lane-guards';
import { ghostModeDisabled } from '../chat-agent/ghost-runtime';
import {
  decideTurnPlan, firstUsable, ruleAdjustedLane, turnPlanDisabled, TURN_PLAN_PRIOR_TURNS, TURN_PLAN_TIMEOUT_MS,
  type Lane, type TurnClass, type TurnPlan, type TurnPlanInput, type QuickLaneContext,
} from './turn-plan';
import type { ModelCard } from '../model-endpoints/model-catalog';
import { detectCodeIntent } from './auto-router';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

export type LaneFeature = 'checker' | 'research' | 'failOpen';
export type LaneFeatureMode = 'off' | 'shadow' | 'act';
export const LANE_FEATURES: readonly LaneFeature[] = ['checker', 'research', 'failOpen'];
/** The store field per feature (['instance','turn-plan'] / 'config'). */
export const LANE_FEATURE_FIELDS: Readonly<Record<LaneFeature, string>> = { checker: 'laneChecker', research: 'laneResearch', failOpen: 'laneFailOpen' };
/** The owner (roster 2026-10-06: new act paths start on the owner canary). Used only when the row has no laneCanaryUserIds. */
export const LANE_CANARY_DEFAULT_USER_IDS: readonly string[] = Object.freeze(['83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4']);

export const LANE_DEPTH_METRIC = 'lane_depth';
export const LANE_RESEARCH_METRIC = 'lane_research';

// ── kill switches ────────────────────────────────────────────────────────────
export function laneDepthDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.LANE_DEPTH_DISABLED); }
export function laneCheckerDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.LANE_CHECKER_DISABLED); }
export function laneResearchRoutingDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.LANE_RESEARCH_ROUTING_DISABLED); }
export function laneFailOpenDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.LANE_FAIL_OPEN_DISABLED); }
export function keywordL3RetireDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.KEYWORD_L3_RETIRE_DISABLED); }
export function laneCheckerPoolDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.LANE_CHECKER_POOL_DISABLED); }
export function quickPresetFreeDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.QUICK_PRESET_FREE_DISABLED); }
/** 2026-10-20: LANE_CHECKER_FOLLOW_UP_DISABLED=1 ⇒ the A-2 checker drop ignores the session (no follow-up hysteresis). */
export function laneCheckerFollowUpDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.LANE_CHECKER_FOLLOW_UP_DISABLED); }

function featureKilled(f: LaneFeature, env: NodeJS.ProcessEnv): boolean {
  if (laneDepthDisabled(env) || turnPlanDisabled(env)) return true;
  if (f === 'checker') return laneCheckerDisabled(env);
  if (f === 'research') return laneResearchRoutingDisabled(env);
  return laneFailOpenDisabled(env);
}

// ── the store config ─────────────────────────────────────────────────────────

export interface LaneDepthConfig {
  modes: Record<LaneFeature, LaneFeatureMode>;
  canaryUserIds: string[];
  /** true when the row carries no laneCanaryUserIds (the owner default applies). */
  canaryDefault: boolean;
}

const modeOf = (v: unknown): LaneFeatureMode => (v === 'off' || v === 'act' || v === 'shadow' ? v : 'shadow');

/** The row → the config (pure; absent fields take the defaults: every feature 'shadow', the owner canary). */
export function laneDepthConfigFrom(row: unknown): LaneDepthConfig {
  const r = row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, unknown> : {};
  const modes = {} as Record<LaneFeature, LaneFeatureMode>;
  for (const f of LANE_FEATURES) modes[f] = modeOf(r[LANE_FEATURE_FIELDS[f]]);
  const listed = Array.isArray(r.laneCanaryUserIds);
  const ids = listed ? (r.laneCanaryUserIds as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [...LANE_CANARY_DEFAULT_USER_IDS];
  return { modes, canaryUserIds: [...new Set(ids)], canaryDefault: !listed };
}

const CONFIG_NS = ['instance', 'turn-plan'];
const CONFIG_KEY = 'config';
const CONFIG_TTL_MS = 30_000;
let configCache: { cfg: LaneDepthConfig; expiresAt: number } | null = null;
export function __resetLaneDepthConfigForTests(): void { configCache = null; }

/** The live config (30 s cache; a read failure = the defaults — shadow + the owner canary, so nothing widens on an error). */
export async function laneDepthConfig(): Promise<LaneDepthConfig> {
  if (configCache && configCache.expiresAt > Date.now()) return configCache.cfg;
  let cfg: LaneDepthConfig;
  try {
    const { storeGet } = await import('../memory/context-store');
    cfg = laneDepthConfigFrom(await storeGet<Record<string, unknown>>(CONFIG_NS, CONFIG_KEY));
  } catch {
    cfg = laneDepthConfigFrom(null);
  }
  configCache = { cfg, expiresAt: Date.now() + CONFIG_TTL_MS };
  return cfg;
}

export interface LaneDepthAccess {
  /** The feature ACTS for this sender (act mode, or shadow + on the canary), kill switches applied. */
  acts: Record<LaneFeature, boolean>;
  /** The sender is on the canary list. */
  canary: boolean;
  modes: Record<LaneFeature, LaneFeatureMode>;
}

/** Does one feature act for this sender? Pure over the config + env. Guests (no user id) act only in 'act'. */
export function laneFeatureActs(cfg: LaneDepthConfig, f: LaneFeature, userId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (featureKilled(f, env)) return false;
  const m = cfg.modes[f];
  if (m === 'act') return true;
  if (m === 'shadow') return !!userId && cfg.canaryUserIds.includes(userId);
  return false;
}

/** Pure: the per-feature access for one sender. */
export function laneDepthAccessFrom(cfg: LaneDepthConfig, userId: string | null | undefined, env: NodeJS.ProcessEnv = process.env): LaneDepthAccess {
  const acts = {} as Record<LaneFeature, boolean>;
  for (const f of LANE_FEATURES) acts[f] = laneFeatureActs(cfg, f, userId, env);
  return { acts, canary: !!userId && cfg.canaryUserIds.includes(userId), modes: { ...cfg.modes } };
}

/** The per-feature access for one sender (never throws — an error = nothing acts). */
export async function laneDepthFor(userId: string | null | undefined): Promise<LaneDepthAccess> {
  try {
    return laneDepthAccessFrom(await laneDepthConfig(), userId);
  } catch {
    return { acts: { checker: false, research: false, failOpen: false }, canary: false, modes: { checker: 'off', research: 'off', failOpen: 'off' } };
  }
}

// ── lane ⇄ preset aliases (presets survive only as internal aliases) ─────────

/** The preset a lane runs as (quick / standard → Level 1 shape, checked → Level 2, research → the council). Pure. */
export function laneToPreset(lane: Lane): DepthPreset {
  if (lane === 'research') return 'deep_research';
  if (lane === 'checked') return 'thinking';
  return 'single_thinking';
}

/**
 * audit 2026-10-08 W4-1c: the run BUDGET of a harness-set Standard lane (lane depth A-2 'standard' / the A-4 fail-open).
 * The lane keeps its Level 1 preset ALIAS (no checker, no synthesis — laneToPreset stays the vocabulary), but the old
 * coupling also gave it the Level 1 BUDGET (6 steps / 240 s / 80k chars): measured on prod 14 d (2026-10-08, n 13
 * canary Standard-lane turns) completion p50 176 s / p75 260 s / p90 284 s — 5 of 13 overran 240 s, a forced
 * FINAL TURN cut real answers short and one overrun armed a false "still working" continuation. Every non-canary
 * Standard-shaped turn runs the 'thinking' budget (8 steps / 480 s / 100k — 12 of 13 measured turns fit), so the
 * lane gets that budget with its checker still off. STANDARD_LANE_THINKING_BUDGET_DISABLED=1 restores the
 * Level 1 budget. Pure.
 */
export function standardLaneThinkingBudgetDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.STANDARD_LANE_THINKING_BUDGET_DISABLED); }
export function standardLaneThinkingBudget(plan: { lane?: string | null; preset?: string | null } | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return !!plan && plan.lane === 'standard' && plan.preset === 'single_thinking' && !standardLaneThinkingBudgetDisabled(env);
}

/** The lane a plan RAN (its own lane when set, else the preset's alias). Pure. */
export function ranLaneOf(plan: Pick<DepthPlan, 'preset' | 'spawnChecker'> & { lane?: string | null }): Lane {
  if (plan.lane === 'quick' || plan.lane === 'standard' || plan.lane === 'checked' || plan.lane === 'research') return plan.lane;
  if (plan.preset === 'deep_research') return 'research';
  return plan.spawnChecker ? 'checked' : 'standard';
}

/**
 * The lane a human turn's `ux_ttft` row is keyed by (audit 2026-10-08 W4-1b; pure). The per-turn model pick reads
 * prod latency per (model, lane) from those rows (model-evidence.ts), but `meta.lane` was stamped only when the
 * harness itself set the plan's lane (canary / Quick / research turns) — every other Standard-classified turn fell
 * back to its PRESET and was bucketed as 'checked' (preset thinking), so the 'standard' evidence starved and the
 * bench + tool formula (5–10× optimistic) won. Now EVERY human turn is keyed by the lane the pick evaluates:
 *   the harness-applied lane (plan.lane) → else the pick's own lane (a quick-ineligible turn is picked as standard)
 *   → else the turn plan's classified lane (a research read that ran without the council keys by what ran) → else
 *   the preset alias (ranLaneOf). `ranLane` (what ran) and `planLane` (the classifier) ride beside it.
 * UX_TTFT_LANE_ALWAYS_DISABLED=1 restores the plan.lane-only stamp (laneSource 'legacy').
 */
export function uxTtftLaneDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.UX_TTFT_LANE_ALWAYS_DISABLED); }
export function ttftLaneStamp(
  plan: Pick<DepthPlan, 'preset' | 'spawnChecker'> & { lane?: string | null },
  turnPlan: { lane?: string | null; modelPick?: { lane?: string | null } | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { lane?: Lane; ranLane: Lane; planLane?: Lane; laneSource: 'plan' | 'pick' | 'turn_plan' | 'preset' | 'legacy' } {
  const isLane = (v: unknown): v is Lane => v === 'quick' || v === 'standard' || v === 'checked' || v === 'research';
  const ranLane = ranLaneOf(plan);
  const planLane = isLane(turnPlan?.lane) ? turnPlan!.lane as Lane : undefined;
  const extra = planLane ? { planLane } : {};
  if (uxTtftLaneDisabled(env)) return { ...(isLane(plan.lane) ? { lane: plan.lane } : {}), ranLane, ...extra, laneSource: 'legacy' };
  if (isLane(plan.lane)) return { lane: plan.lane, ranLane, ...extra, laneSource: 'plan' };
  const pickLane = turnPlan?.modelPick?.lane;
  if (isLane(pickLane)) return { lane: pickLane, ranLane, ...extra, laneSource: 'pick' };
  if (planLane) {
    if (planLane === 'quick') return { lane: 'standard', ranLane, ...extra, laneSource: 'turn_plan' }; // never ran the Quick lane
    if (planLane === 'research' && ranLane !== 'research') return { lane: ranLane, ranLane, ...extra, laneSource: 'turn_plan' };
    return { lane: planLane, ranLane, ...extra, laneSource: 'turn_plan' };
  }
  return { lane: ranLane, ranLane, laneSource: 'preset' };
}

// ── A-2: the checker by lane (pure) ──────────────────────────────────────────

export interface LaneCheckerGuards {
  /** p(quick) + p(standard) a checker drop needs (both option orders averaged). */
  lowerLaneThreshold: number;
  /** stakes at or above this keeps the checker. */
  stakesCeiling: number;
  /** contested at or above this keeps the checker. */
  contestedCeiling: number;
}

/**
 * Defaults = the Quick guards' shape (2026-10-03 replay: p ≥ 0.8 · stakes < 0.6 · contested < 0.5 had 0 unsafe of 8),
 * applied to the LOWER-lane mass because a checker drop is the same kind of call ("a second model would not
 * meaningfully improve this"). Calibration (2026-10-06, prod read-only, 17 standard-lane plain turns in 14 d):
 * p(standard) 0.66–1.0 (median 0.97), stakes 0.07–0.71 — 11 of 17 pass these guards. scripts/framework-audit/
 * replay-min-lane.js re-fits them against the minimum-sufficient-lane judge + the checker-material label.
 */
export const LANE_CHECKER_DEFAULT_GUARDS: Readonly<LaneCheckerGuards> = Object.freeze({ lowerLaneThreshold: 0.8, stakesCeiling: 0.6, contestedCeiling: 0.5 });

export function laneCheckerGuards(env: Record<string, string | undefined> = process.env): LaneCheckerGuards {
  return {
    lowerLaneThreshold: ceilingFromEnv(env.LANE_STANDARD_THRESHOLD, LANE_CHECKER_DEFAULT_GUARDS.lowerLaneThreshold),
    stakesCeiling: ceilingFromEnv(env.LANE_CHECKER_STAKES_CEILING, LANE_CHECKER_DEFAULT_GUARDS.stakesCeiling),
    contestedCeiling: ceilingFromEnv(env.LANE_CHECKER_CONTESTED_CEILING, LANE_CHECKER_DEFAULT_GUARDS.contestedCeiling),
  };
}

export interface LaneCheckerDecision {
  /** The lane the turn runs: standard (no checker) or checked (the checker). */
  lane: 'standard' | 'checked';
  spawnChecker: boolean;
  /** Code-composed audit string. */
  why: string;
}

/** The session context of one checker decision (2026-10-20 follow-up hysteresis). */
export interface LaneCheckerSession {
  /**
   * The lane this chat's session is in before this turn — the SAME lane the Quick guard read (chat-agent: the session
   * roster's lane when the roster acts, else the last answer's turn-plan lane; rosterTrace.priorLaneRead). null / absent
   * ⇒ no hysteresis (a fresh chat, a read failure).
   */
  priorLane?: Lane | null;
}

/**
 * Standard vs Checked from one classification (pure; null ⇒ no classification). The checker is DROPPED only on a
 * confident lower-lane read with low stakes, no contest and no trait rule pointing up — high stakes never lose it —
 * and never on a FOLLOW-UP (follow_up ≥ QUICK_LANE_FOLLOW_UP_CEILING) in a session whose prior lane is checked /
 * research: the turn plan classifies the message, and a terse follow-up in a checked thread reads standard on its own
 * (the Quick lane's session hysteresis, turn-plan.ts quickLaneEligibility, applied to the checker drop).
 * LANE_CHECKER_FOLLOW_UP_DISABLED=1 ignores the session.
 */
export function laneCheckerDecision(cls: TurnClass | null | undefined, guards: LaneCheckerGuards = LANE_CHECKER_DEFAULT_GUARDS, session: LaneCheckerSession = {}): LaneCheckerDecision | null {
  if (!cls) return null;
  const keep = (why: string): LaneCheckerDecision => ({ lane: 'checked', spawnChecker: true, why });
  const rule = ruleAdjustedLane(cls);
  if (rule?.rule && (rule.lane === 'checked' || rule.lane === 'research')) return keep(`trait rule ${rule.rule} → ${rule.lane}`);
  if (cls.lane === 'checked' || cls.lane === 'research') return keep(`lane ${cls.lane} (p ${cls.laneConfidence.toFixed(2)})`);
  const lower = (cls.laneProbs.quick ?? 0) + (cls.laneProbs.standard ?? 0);
  if (lower < guards.lowerLaneThreshold - 1e-9) return keep(`p(quick+standard) ${lower.toFixed(2)} < ${guards.lowerLaneThreshold}`);
  // 2026-10-20 review: an UNANSWERED stakes / contested noul (one censored question) can never drop the checker.
  if (typeof cls.stakes !== 'number' || !Number.isFinite(cls.stakes) || typeof cls.contested !== 'number' || !Number.isFinite(cls.contested)) {
    return keep('stakes / contested unanswered');
  }
  if ((cls.stakes ?? 0) >= guards.stakesCeiling) return keep(`stakes ${(cls.stakes ?? 0).toFixed(2)} ≥ ${guards.stakesCeiling}`);
  if ((cls.contested ?? 0) >= guards.contestedCeiling) return keep(`contested ${(cls.contested ?? 0).toFixed(2)} ≥ ${guards.contestedCeiling}`);
  const prior = session.priorLane;
  if ((prior === 'checked' || prior === 'research') && (cls.followUp ?? 0) >= QUICK_LANE_FOLLOW_UP_CEILING && !laneCheckerFollowUpDisabled()) {
    return keep(`follow-up in a ${prior} session (follow_up ${(cls.followUp ?? 0).toFixed(2)} ≥ ${QUICK_LANE_FOLLOW_UP_CEILING})`);
  }
  return { lane: 'standard', spawnChecker: false, why: `p(quick+standard) ${lower.toFixed(2)} ≥ ${guards.lowerLaneThreshold}, stakes ${(cls.stakes ?? 0).toFixed(2)}, contested ${(cls.contested ?? 0).toFixed(2)}` };
}

/** A turn plan's answer is usable for a lane ACT: classified, not off, and from a calibrated backend. Pure. */
export function usableTurnPlan(tp: Pick<TurnPlan, 'cls' | 'mode' | 'stash'> | null | undefined): tp is Pick<TurnPlan, 'cls' | 'mode' | 'stash'> & { cls: TurnClass } {
  return !!tp && !!tp.cls && tp.mode !== 'off' && (tp.stash as { calibrated?: boolean } | null | undefined)?.calibrated !== false;
}

/** A-4: "standard on the seat" — the lane fail-open when the turn plan has no usable answer (pure). */
export function laneFailOpenPlan(base: DepthPlan, why = 'no usable turn plan'): DepthPlan {
  return {
    ...base, preset: 'single_thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', lane: 'standard',
    source: 'lane_fail_open', reason: `lane fail-open: standard on the seat (${why}; was ${base.reason})`,
  };
}

export interface LaneDepthRunDecision {
  /** The plan the run executes (unchanged when nothing applied). */
  plan: DepthPlan;
  applied: 'checker' | 'fail_open' | null;
  /** The checker decision the turn plan implies (recorded in every mode; null without a usable answer). */
  checker: LaneCheckerDecision | null;
  why: string;
}

/**
 * A-2 / A-4 at the run's plan point (pure). `access` = what acts for this sender; `eligible` = a human plain-chat turn
 * that is not a council / Dig-deeper rung / supervisor / machine run (the caller's gate). The checker decision is
 * applied only with the `checker` feature; the fail-open only with `failOpen` and only when no usable answer exists.
 * `priorLane` = the session lane the Quick guard read (the checker drop's follow-up hysteresis; absent ⇒ none).
 */
export function applyLaneDepth(i: { plan: DepthPlan; turnPlan: Pick<TurnPlan, 'cls' | 'mode' | 'stash'> | null | undefined; access: Pick<LaneDepthAccess, 'acts'>; eligible: boolean; guards?: LaneCheckerGuards; priorLane?: Lane | null }): LaneDepthRunDecision {
  const usable = usableTurnPlan(i.turnPlan);
  const checker = usable ? laneCheckerDecision(i.turnPlan!.cls, i.guards ?? laneCheckerGuards(), { priorLane: i.priorLane ?? null }) : null;
  if (!i.eligible) return { plan: i.plan, applied: null, checker, why: 'not eligible' };
  if (checker && i.access.acts.checker) {
    const plan: DepthPlan = {
      ...i.plan, preset: laneToPreset(checker.lane), spawnChecker: checker.spawnChecker,
      checkerWaitMs: checker.spawnChecker ? i.plan.checkerWaitMs : 0, council: 'none', lane: checker.lane,
      source: 'turn_plan', reason: `turn plan lane ${checker.lane}: ${checker.why} (was ${i.plan.reason})`,
    };
    return { plan, applied: 'checker', checker, why: checker.why };
  }
  if (!usable && i.access.acts.failOpen) {
    const why = !i.turnPlan ? 'turn plan not in' : !i.turnPlan.cls ? 'no classification' : i.turnPlan.mode === 'off' ? 'purpose off' : 'uncalibrated backend';
    return { plan: laneFailOpenPlan(i.plan, why), applied: 'fail_open', checker, why };
  }
  return { plan: i.plan, applied: null, checker, why: checker ? `recorded only (${checker.why})` : 'no usable turn plan' };
}

// ── A-2: the checker MODEL from the pool (other family than the lead) ────────

/**
 * The checker model for a checked turn (pure over the pool + catalog): the first usable model of the checker pool
 * whose family differs from the lead's; a pool that follows its seat (source 'seats') or yields nothing keeps the
 * seat. Team C's utility pick (roster C-3) can replace this selection at the same seam.
 */
export function laneCheckerModel(i: { pool: { models: readonly string[]; source: string } | null | undefined; catalog: ReadonlyMap<string, ModelCard>; lead: string; seat: string; familyOf: (spec: string) => string }): { spec: string; why: string } {
  if (!i.pool || i.pool.source !== 'pool' || !i.pool.models.length) return { spec: i.seat, why: 'the checker pool follows the seat' };
  const leadFamily = i.catalog.get(i.lead)?.family ?? i.familyOf(i.lead);
  const pick = firstUsable(i.pool.models, i.catalog, { excludeFamily: leadFamily, exclude: [i.lead] });
  if (!pick) return { spec: i.seat, why: 'no usable checker in the pool — the seat' };
  const fam = i.catalog.get(pick)?.family ?? i.familyOf(pick);
  return { spec: pick, why: `checker pool: ${pick}${fam !== leadFamily ? ` (family ${fam} ≠ lead ${leadFamily})` : ' (no other family usable)'}` };
}

/** The live checker-pool pick (never throws; any error / LANE_CHECKER_POOL_DISABLED=1 ⇒ the seat). */
export async function laneCheckerModelFor(lead: string, seat: string): Promise<{ spec: string; why: string }> {
  if (laneCheckerPoolDisabled()) return { spec: seat, why: 'LANE_CHECKER_POOL_DISABLED' };
  try {
    const { resolveEffectivePools } = await import('../model-endpoints/auto-pools.service');
    const pools = await resolveEffectivePools();
    const pool = pools?.checker ?? null;
    if (!pool || pool.source !== 'pool') return { spec: seat, why: 'the checker pool follows the seat' };
    const { listChatModelCatalog, modelFamily } = await import('../model-endpoints/model-catalog');
    const catalog = new Map((await listChatModelCatalog()).map((c) => [c.spec, c] as const));
    return laneCheckerModel({ pool, catalog, lead, seat, familyOf: modelFamily });
  } catch (err: any) {
    logger.warn(`lane-depth: checker pool pick failed (${err?.message ?? err}) — the seat checks`);
    return { spec: seat, why: 'pool read failed — the seat' };
  }
}

// ── A-3: research by lane (pure) ─────────────────────────────────────────────

export interface ResearchLaneGuards {
  /** argmax research needs at least this much probability. */
  threshold: number;
  /** an explicit keyword research request ('research_requested') routes at this p(research) (the classifier still has to see some research). */
  explicitFloor: number;
}

/**
 * 2026-10-06 calibration (prod read-only, 14 d of turn_plan decisions on Jev): p(research) ≥ 0.5 on 5 of 661 user-segment
 * asks, all research-shaped sessions; the near-tie / breadth-4 rule caught the plan doc's own Quebec example (research
 * 0.36 vs standard 0.37, contested 0.97). The explicit floor keeps a typed "research X" from silently losing the
 * council when Jev reads it as a near-uniform standard / research split.
 */
export const LANE_RESEARCH_DEFAULT_GUARDS: Readonly<ResearchLaneGuards> = Object.freeze({ threshold: 0.5, explicitFloor: 0.2 });

export function researchLaneGuards(env: Record<string, string | undefined> = process.env): ResearchLaneGuards {
  return {
    threshold: ceilingFromEnv(env.LANE_RESEARCH_THRESHOLD, LANE_RESEARCH_DEFAULT_GUARDS.threshold),
    explicitFloor: ceilingFromEnv(env.LANE_RESEARCH_EXPLICIT_FLOOR, LANE_RESEARCH_DEFAULT_GUARDS.explicitFloor),
  };
}

export interface ResearchLaneDecision { route: 'research' | 'not_research' | 'no_answer'; why: string }

/** Research or not, from one classification (pure). `keywordReasonKey` = the keyword router's reasonKey for this send. */
export function researchLaneDecision(cls: TurnClass | null | undefined, opts: { keywordReasonKey?: string | null; guards?: ResearchLaneGuards } = {}): ResearchLaneDecision {
  if (!cls) return { route: 'no_answer', why: 'no classification' };
  const g = opts.guards ?? LANE_RESEARCH_DEFAULT_GUARDS;
  const pr = cls.laneProbs.research ?? 0;
  const rule = ruleAdjustedLane(cls);
  if (rule?.rule && rule.lane === 'research') return { route: 'research', why: `trait rule ${rule.rule} (p(research) ${pr.toFixed(2)}, breadth ${cls.breadth ?? '?'})` };
  if (cls.lane === 'research' && pr >= g.threshold - 1e-9) return { route: 'research', why: `lane research (p ${pr.toFixed(2)} ≥ ${g.threshold})` };
  if (opts.keywordReasonKey === 'research_requested' && pr >= g.explicitFloor - 1e-9) return { route: 'research', why: `explicit research request + p(research) ${pr.toFixed(2)} ≥ ${g.explicitFloor}` };
  return { route: 'not_research', why: `lane ${cls.lane} (p(research) ${pr.toFixed(2)})` };
}

// ── A-3: the controller helper ───────────────────────────────────────────────

/** The routing card fields this module writes (a structural subset of platform/send-mode.ts SendRouting). */
export interface LaneRouting {
  level: string; reason: string; suggestCode: boolean;
  reasonKey?: string; source?: string; clamped?: string; requestedMode?: string; modeSource?: string; confidence?: number; backend?: string;
}

export interface ResearchRouteInput {
  seam: 'web' | 'rest';
  userId: string | null;
  chatId: string | null;
  message: string;
  images: number;
  documents: number;
  /** The level resolveSendMode resolved (the keyword / Auto router's pick). */
  mode: string;
  routing: LaneRouting | null | undefined;
  /** The send went through the Auto router (explicit levels are never re-routed). */
  autoRouted: boolean;
  segment: string;
  isSupervisorChat: boolean;
  isChild: boolean;
  escalation: boolean;
  chatless?: boolean;
  /**
   * 2026-10-20: the router's Level 3 ALLOWANCE verdict for this send (send-mode.ts ResolvedSendMode.allowDeepResearch /
   * allowDeepResearchReason). false ⇒ a research read is 'denied' even when routing carries no clamp (the router
   * picked Level 2 — guest_no_research / quota / supervisor / chatless). Absent (a caller that passes no verdict) ⇒ a
   * GUEST is denied (the Auto contract keeps guests off Level 3); a signed-in sender falls to the clamp check.
   */
  deepResearchAllowed?: boolean | null;
  deepResearchDenyReason?: string | null;
  /**
   * Ghost mode (owner 2026-10-22; integ/ghost-composer review fix): the send is a GHOST turn — the chat row's stored
   * ghostMode, or a chatId-less send's per-send `ghost` opt-in (guests / the createChat-failure fallback). The turn plan
   * is a CLOUD decision call carrying the message text and the prior user turns, so a ghost turn is never asked here:
   * 'not_governed', no plan handed to the run — the run's own turn plan then skips it too (chat-agent `ghost_skip`).
   * Inert under CHAT_GHOST_MODE_DISABLED=1 (ghost mode off instance-wide — the send is asked like any other).
   */
  ghost?: boolean;
}

/**
 * Why deep research is not allowed for this send, or null (pure). The routing clamp wins (the router already said
 * so); then the allowance verdict; with no verdict at all a guest is denied ('guest_no_research').
 */
export function researchDenyReason(i: Pick<ResearchRouteInput, 'routing' | 'deepResearchAllowed' | 'deepResearchDenyReason' | 'userId'>): string | null {
  if (i.routing?.clamped) return i.routing.clamped;
  if (i.deepResearchAllowed === false) return i.deepResearchDenyReason || 'not_allowed';
  if ((i.deepResearchAllowed === undefined || i.deepResearchAllowed === null) && !i.userId) return 'guest_no_research';
  return null;
}

export type ResearchRoute = 'not_governed' | 'research' | 'kept' | 'keyword_retired' | 'no_answer' | 'denied';

export interface ResearchRouteResult {
  mode: string;
  routing: LaneRouting | null | undefined;
  /** 'auto_turn_plan' when this module changed the level (the send-mode `auto_<source>` shape). */
  routingSource?: string;
  /** The answered turn plan — handed to the run so it is never asked twice (null when not asked / no answer). */
  turnPlan: TurnPlan | null;
  route: ResearchRoute;
  why: string;
}

export interface ResearchRouteDeps {
  access: (userId: string | null) => Promise<LaneDepthAccess>;
  facts: (chatId: string | null) => Promise<TurnPlanSessionFacts>;
  turnPlan: (input: TurnPlanInput, ctx: QuickLaneContext & { requestedMode: string }) => Promise<TurnPlan | null>;
  codeIntent: (message: string) => boolean;
  record: (row: { kind: string; sessionId?: string; value?: number; unit?: string; meta: Record<string, unknown> }) => void;
  /** 2026-10-20 review: the lane the Quick guard (and the run's checker hysteresis) reads for this session — the
   *  session roster's lane when the roster acts for the sender, else the last answer's lane (chat-agent's
   *  guardPriorLane). Optional: absent ⇒ the legacy lane, as before. */
  guardLane?: (chatId: string | null, userId: string | null, legacy: Lane | null) => Promise<Lane | null>;
}

export interface TurnPlanSessionFacts { priorUserTurns: string[]; priorLane: Lane | null; turnIndex: number }

/** The session facts the turn plan reads (prior user turns oldest-first, the last answer's lane, the human turn count). Never throws. */
export async function turnPlanSessionFacts(chatId: string | null): Promise<TurnPlanSessionFacts> {
  if (!chatId) return { priorUserTurns: [], priorLane: null, turnIndex: 0 };
  try {
    const prisma = (await import('../../../config/database')).default;
    const { turnPlanFromMetadata } = await import('../chat-agent/turn-plan-labels');
    const [priorRows, lastAnswer, turnIndex] = await Promise.all([
      prisma.crossModelMessage.findMany({ where: { chatId, role: 'user' }, orderBy: { createdAt: 'desc' }, take: TURN_PLAN_PRIOR_TURNS, select: { content: true } }).catch(() => [] as Array<{ content: string }>),
      prisma.crossModelMessage.findFirst({ where: { chatId, role: 'assistant' }, orderBy: { createdAt: 'desc' }, select: { metadata: true } }).catch(() => null),
      prisma.crossModelMessage.count({ where: { chatId, role: 'user' } }).catch(() => 0),
    ]);
    return { priorUserTurns: [...priorRows].reverse().map((r) => String(r.content ?? '')), priorLane: turnPlanFromMetadata(lastAnswer?.metadata)?.lane ?? null, turnIndex };
  } catch {
    return { priorUserTurns: [], priorLane: null, turnIndex: 0 };
  }
}

const defaultResearchDeps: ResearchRouteDeps = {
  access: (userId) => laneDepthFor(userId),
  facts: (chatId) => turnPlanSessionFacts(chatId),
  turnPlan: (input, ctx) => decideTurnPlan(input, ctx),
  codeIntent: (m) => !!detectCodeIntent(String(m ?? '')),
  record: (row) => { void import('./loop-metrics.service').then((m) => m.recordLoopMetric(row)).catch(() => {}); },
  guardLane: async (chatId, userId, legacy) => {
    try {
      const { readSessionRosterForTurn, guardPriorLane } = await import('../chat-agent/session-roster');
      return guardPriorLane(await readSessionRosterForTurn(chatId, userId), legacy).lane;
    } catch { return legacy; }
  },
};

const RESEARCH_LEVELS = new Set(['deep_research', 'deep_research_all']);

/**
 * A-3 — research routing for ONE human Auto send (the web stream controller and the REST seam call it after
 * resolveSendMode, before the quota reserve). Only a sender the `research` feature acts for is asked (no added
 * latency for anyone else); the answer may (a) route a confident research lane to Level 3 — the caller's reserve
 * then runs exactly as for a keyword Level 3 (a lost reserve on an Auto send demotes to Ensemble), (b) retire a
 * keyword Level 3 the classifier does not call research, (c) keep the level. No / unusable answer ⇒ today's level.
 * Never throws.
 */
export async function routeResearchLane(i: ResearchRouteInput, deps: ResearchRouteDeps = defaultResearchDeps): Promise<ResearchRouteResult> {
  const keep = (route: ResearchRoute, why: string, turnPlan: TurnPlan | null = null): ResearchRouteResult => ({ mode: i.mode, routing: i.routing, turnPlan, route, why });
  try {
    if (!i.autoRouted || i.isSupervisorChat || i.isChild || i.escalation || i.chatless || i.mode === 'browser_agent') return keep('not_governed', 'not an eligible human Auto send');
    // Ghost privacy (docs/GHOST_MODE.md: nothing about a ghost conversation routes through a model the admin did not
    // designate): BEFORE the access read — a ghost turn's text never reaches the cloud turn-plan backend.
    if (i.ghost === true && !ghostModeDisabled()) return keep('not_governed', 'ghost chat — its content never reaches the cloud turn plan');
    const access = await deps.access(i.userId).catch(() => null);
    if (!access?.acts.research) return keep('not_governed', 'research routing does not act for this sender');
    // 2026-10-20 review: a sender who may not get Level 3 (a guest, an exhausted quota, a clamped route) can never be
    // routed — answer at once instead of a serial turn-plan ask before the stream starts (the run then asks it
    // concurrently with the context load, as for any ungoverned sender).
    const deniedUpFront = RESEARCH_LEVELS.has(i.mode) ? null : researchDenyReason(i);
    if (deniedUpFront) {
      const out = keep('denied', `deep research not allowed (${deniedUpFront}) — not asked`);
      deps.record({
        kind: LANE_RESEARCH_METRIC, ...(i.chatId ? { sessionId: i.chatId } : {}), value: 0, unit: 'ms',
        meta: { seam: i.seam, segment: i.segment, canary: access.canary, mode: access.modes.research, route: out.route, routed: out.mode, keywordLevel: i.mode, why: out.why.slice(0, 200), guest: !i.userId, asked: false,
          ...(typeof i.deepResearchAllowed === 'boolean' ? { allowance: i.deepResearchAllowed } : {}) },
      });
      return out;
    }
    const t0 = Date.now();
    const facts = await deps.facts(i.chatId).catch(() => ({ priorUserTurns: [], priorLane: null, turnIndex: 0 }));
    const guardLane = deps.guardLane ? await deps.guardLane(i.chatId, i.userId, facts.priorLane).catch(() => facts.priorLane) : facts.priorLane;
    const input: TurnPlanInput = {
      message: i.message, priorUserTurns: facts.priorUserTurns, images: i.images, documents: i.documents, priorLane: facts.priorLane,
      turnIndex: facts.turnIndex, ...(i.chatId ? { chatId: i.chatId, sessionId: i.chatId } : {}), segment: i.userId ? 'user' : 'guest', userId: i.userId,
    };
    const ctx: QuickLaneContext & { requestedMode: string } = {
      messageChars: String(i.message ?? '').length, images: i.images, documents: i.documents, mode: i.mode, escalation: false, supervisor: false, machine: false,
      codeIntent: deps.codeIntent(i.message), priorLane: guardLane, presetFree: !quickPresetFreeDisabled(), requestedMode: i.mode,
    };
    const TIMED_OUT = Symbol('turn-plan-timeout');
    const raced = await Promise.race([
      deps.turnPlan(input, ctx).catch(() => null),
      new Promise<typeof TIMED_OUT>((res) => setTimeout(() => res(TIMED_OUT), TURN_PLAN_TIMEOUT_MS + 300).unref?.()),
    ]);
    const tp: TurnPlan | null = raced === TIMED_OUT ? null : (raced as TurnPlan | null);
    const ms = Date.now() - t0;
    const usable = usableTurnPlan(tp);
    const d = usable ? researchLaneDecision(tp!.cls, { keywordReasonKey: i.routing?.reasonKey ?? null, guards: researchLaneGuards() }) : { route: 'no_answer' as const, why: raced === TIMED_OUT ? 'turn plan timed out' : !tp ? 'no turn plan' : 'unusable turn plan' };
    let out: ResearchRouteResult;
    if (d.route === 'no_answer') {
      out = keep('no_answer', `${d.why} — the router's level stands`, tp && tp.cls ? tp : null);
    } else if (d.route === 'research') {
      const denied = RESEARCH_LEVELS.has(i.mode) ? null : researchDenyReason(i);
      if (RESEARCH_LEVELS.has(i.mode)) out = keep('kept', `${d.why} (already Level 3)`, tp);
      else if (denied) out = keep('denied', `${d.why} — deep research not allowed (${denied})`, tp);
      else {
        const base: LaneRouting = i.routing ?? { level: i.mode, reason: 'auto', suggestCode: false };
        out = {
          mode: 'deep_research', turnPlan: tp, route: 'research', why: d.why, routingSource: 'auto_turn_plan',
          routing: { ...base, level: 'deep_research', reasonKey: 'turn_plan_research', source: 'turn_plan', reason: `turn plan: research — ${d.why} (router said ${i.mode})` },
        };
      }
    } else if (RESEARCH_LEVELS.has(i.mode) && !keywordL3RetireDisabled()) {
      const base: LaneRouting = i.routing ?? { level: i.mode, reason: 'auto', suggestCode: false };
      out = {
        mode: 'thinking', turnPlan: tp, route: 'keyword_retired', why: d.why, routingSource: 'auto_turn_plan',
        routing: { ...base, level: 'thinking', reasonKey: 'turn_plan_lane', source: 'turn_plan', reason: `${base.reason} — keyword Level 3 retired: the turn plan reads ${d.why}` },
      };
    } else {
      out = keep('kept', d.why, tp);
    }
    deps.record({
      kind: LANE_RESEARCH_METRIC, ...(i.chatId ? { sessionId: i.chatId } : {}), value: ms, unit: 'ms',
      meta: {
        seam: i.seam, segment: i.segment, canary: access.canary, mode: access.modes.research, route: out.route, routed: out.mode, keywordLevel: i.mode,
        ...(i.routing?.reasonKey ? { keywordReasonKey: i.routing.reasonKey } : {}), why: out.why.slice(0, 200),
        ...(tp?.cls ? { lane: tp.cls.lane, pResearch: Number((tp.cls.laneProbs.research ?? 0).toFixed(3)), ruleLane: ruleAdjustedLane(tp.cls)?.lane ?? null, breadth: tp.cls.breadth } : {}),
        ...(tp?.decisionId ? { decisionId: tp.decisionId } : {}), ...(tp?.backend ? { backend: tp.backend } : {}), guest: !i.userId,
        ...(typeof i.deepResearchAllowed === 'boolean' ? { allowance: i.deepResearchAllowed } : {}),
      },
    });
    if (out.route === 'research' || out.route === 'keyword_retired') logger.info(`lane-depth: research routing ${out.route} (${i.seam}, user ${i.userId || 'guest'}) — ${out.why}`);
    return out;
  } catch (err: any) {
    logger.warn(`lane-depth: research routing failed (${err?.message ?? err}) — the router's level stands`);
    return keep('no_answer', 'error');
  }
}

// ── the per-turn telemetry row (finalize) ────────────────────────────────────

/** The `lane_depth` meta for one finalized human turn (pure). */
export function laneDepthRowMeta(i: {
  access: LaneDepthAccess | null; turnPlan: Pick<TurnPlan, 'cls' | 'mode' | 'stash'> | null | undefined; decision: LaneDepthRunDecision | null;
  ranPlan: Pick<DepthPlan, 'preset' | 'spawnChecker' | 'source'> & { lane?: string | null }; ranChecker: boolean; checkerModel?: string | null;
  segment: string; routedLevel?: string | null; keywordReasonKey?: string | null; researchRouted?: boolean;
  /** The session lane the checker decision read (2026-10-20 follow-up hysteresis) — the would-act uses the same. */
  priorLane?: Lane | null;
}): Record<string, unknown> {
  const cls = usableTurnPlan(i.turnPlan) ? i.turnPlan!.cls : null;
  const would = cls ? laneCheckerDecision(cls, laneCheckerGuards(), { priorLane: i.priorLane ?? null }) : null;
  const research = cls ? researchLaneDecision(cls, { keywordReasonKey: i.keywordReasonKey ?? null, guards: researchLaneGuards() }) : null;
  const r3 = (v: number | null | undefined) => (typeof v === 'number' ? Number(v.toFixed(3)) : null);
  return {
    segment: i.segment,
    ...(i.access ? { canary: i.access.canary, modes: i.access.modes, acts: i.access.acts } : {}),
    ...(cls ? { lane: cls.lane, ruleLane: ruleAdjustedLane(cls)?.lane ?? null, pLower: r3((cls.laneProbs.quick ?? 0) + (cls.laneProbs.standard ?? 0)), pResearch: r3(cls.laneProbs.research), stakes: r3(cls.stakes), contested: r3(cls.contested) } : { lane: null }),
    ...(cls && i.priorLane ? { priorLane: i.priorLane, followUp: r3(cls.followUp) } : {}),
    ...(would ? { wouldChecker: would.spawnChecker, checkerWhy: would.why.slice(0, 160) } : {}),
    ...(research ? { wouldResearch: research.route === 'research' } : {}),
    applied: i.decision?.applied ?? null,
    ranLane: ranLaneOf(i.ranPlan), ranPreset: i.ranPlan.preset, ranChecker: i.ranChecker, source: i.ranPlan.source,
    // audit 2026-10-08 W4-1c: which run budget the lane got ('thinking' = the raised Standard-lane budget).
    ...(standardLaneThinkingBudget(i.ranPlan as { lane?: string | null; preset?: string | null }) ? { budget: 'thinking' } : {}),
    ...(i.checkerModel ? { checkerModel: i.checkerModel } : {}),
    ...(i.routedLevel ? { routedLevel: i.routedLevel } : {}),
    ...(i.researchRouted ? { researchRouted: true } : {}),
  };
}

// ── A-1: the checker-material label (pure; replay-min-lane.js + any live reader) ──

export type CheckerMaterialLabel = 'material' | 'nothing_material';

/**
 * Did the Double Checker change anything MATERIAL on this answer row? (roster 2026-10-06 A-1; the plan doc's
 * "a checker that changed nothing material ⇒ over-provisioned" label.) Reads the persisted check record:
 *   - no checker ran                                   ⇒ null (the label only exists where the checker ran)
 *   - check 'checked' (wording-only / unchanged)       ⇒ nothing_material
 *   - check 'updated' with verdict.contradicts (T6-2)  ⇒ contradicts ? material : nothing_material
 *   - check 'updated' on an older row with the previous answer kept (metadata.revision.previousContent) ⇒ the
 *     injected direction-aware diff (compute-policy-gate revisionContradictsPrevious) over previous → current
 *   - a gate-decided 'updated' verdict                 ⇒ material
 *   - anything else (interrupted / skipped / checking / fallback with no previous text) ⇒ null
 * The deterministic diff alone marked almost every L2 answer 'updated' (readiness report §3b-5), so the
 * CONTRADICTION reading is what discriminates.
 */
export function checkerMaterialLabel(metadata: unknown, content?: string | null, contradicts?: (prev: string, next: string) => boolean): CheckerMaterialLabel | null {
  const meta = metadata && typeof metadata === 'object' ? metadata as Record<string, any> : null;
  if (!meta) return null;
  const depth = meta.depth && typeof meta.depth === 'object' ? meta.depth : {};
  const ran = depth.facts && typeof depth.facts.checkerSpawned === 'boolean' ? depth.facts.checkerSpawned : depth.plan?.spawnChecker === true;
  if (!ran) return null;
  const check = meta.check && typeof meta.check === 'object' ? meta.check : null;
  const state = check?.state;
  if (state === 'checked') return 'nothing_material';
  if (state !== 'updated') return null;
  const v = check.verdict && typeof check.verdict === 'object' ? check.verdict : {};
  if (typeof v.contradicts === 'boolean') return v.contradicts ? 'material' : 'nothing_material';
  const prev = typeof meta.revision?.previousContent === 'string' ? meta.revision.previousContent : null;
  if (prev && typeof content === 'string' && content && contradicts) {
    try { return contradicts(prev, content) ? 'material' : 'nothing_material'; } catch { return null; }
  }
  if (v.source === 'gate' && v.material === true) return 'material';
  return null;
}
