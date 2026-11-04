/**
 * Quick-lane guard cutoffs — dynamic roster (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md).
 * A pure LEAF shared by the consumer (platform/turn-plan.ts quickLaneEligibility)
 * and the readiness ruler's act band (decision-gate-fit.ts turnPlanActBand) so
 * the two can never disagree, and so neither imports the other (decision-gate
 * ⇄ decision-gate-fit would cycle through turn-plan).
 *
 * Defaults come from the 2026-10-03 offline replay (TP1003C: 87 human turns from
 * the last 30 days, Jev answers scored by a reasoning judge on the Double
 * Checker seat). At p(quick) ≥ 0.8 with stakes < 0.6 and contested < 0.5, all
 * 8 would-Quick turns were judged quick (Wilson 95% lower bound 0.68) and none
 * was judged checked / research; at p ≥ 0.7 three of twelve were. Contested is
 * sharp (≤ 0.08 on lookups, 0.5–0.6 on the disputed ones).
 *
 * STAKES over-reads benign asks (2026-10-20 real-user audit,
 * docs/AUDIT_2026-10-20_REAL_USER.md): turn_plan's stakes noul is a criteria-less
 * "Could a wrong answer cost …?" possibility, and Jev reads 0.52–0.73 on benign
 * asks (a weather question 0.62 — refused Quick, 157 s on the preset; a business
 * name 0.59; a trip plan 0.73) against 0.81–0.91 on real-stakes ones ("convert
 * 10,000 USD" 0.81, a mortgage 0.83, a drug interaction 0.91). The 2026-10-03
 * "0.3–0.55 on ordinary messages" band no longer holds. Rewording the question
 * would re-key turn_plan's whole questionsHash partition (readiness, memo, the
 * nightly drift audit) — so the fix is a LOOKUP-CONDITIONED ceiling instead: a
 * turn whose other traits say "pure live lookup" (needs_live_web ≥ 0.8,
 * multi_step < 0.5, contested < 0.2 — all three ANSWERED; a missing trait never
 * relaxes anything) gets the higher stakes ceiling 0.75; every other turn keeps
 * the base 0.6. A money / health lookup still reads ≥ 0.8 and stays off Quick.
 * The blanket raise (TURN_PLAN_QUICK_STAKES_CEILING=0.7) is NOT the same thing:
 * the 10-03 grid's stakes < 0.7 cell admitted 1 unsafe turn in 9.
 *
 * Overrides (blank = unset; clamped): DECISION_GATE_THRESHOLD_TURN_PLAN_QUICK
 * (0.5..1, the decision-gate option env — read by the consumer through
 * decisionOptionThreshold), TURN_PLAN_QUICK_STAKES_CEILING,
 * TURN_PLAN_QUICK_CONTESTED_CEILING and TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING
 * (0..1, ceilings only — never the generic purpose env, which must not move a
 * ceiling). The lookup ceiling is also the rollback: any value ≤ the base stakes
 * ceiling (e.g. 0.6) restores the pre-2026-10-20 rule byte-for-byte.
 */

export const QUICK_LANE_DEFAULT_THRESHOLD = 0.8;
export const QUICK_LANE_STAKES_CEILING = 0.6;
export const QUICK_LANE_CONTESTED_CEILING = 0.5;
/** A follow-up (follow_up ≥ this) in a Checked / Research session never drops to Quick. */
export const QUICK_LANE_FOLLOW_UP_CEILING = 0.5;
/** Longest message the Quick lane takes (a lookup is short). */
export const QUICK_LANE_MAX_MESSAGE_CHARS = 600;
/** The stakes ceiling of a PURE LOOKUP (isPureLookup) — above the base ceiling, below the real-stakes reads (≥ 0.81). */
export const QUICK_LANE_LOOKUP_STAKES_CEILING = 0.75;
/** A pure lookup needs live web at or above this … */
export const QUICK_LANE_LOOKUP_WEB_FLOOR = 0.8;
/** … multi-step reasoning below this … */
export const QUICK_LANE_LOOKUP_MULTI_STEP_CEILING = 0.5;
/** … and contested below this (stricter than the base contested ceiling: a lookup is uncontested). */
export const QUICK_LANE_LOOKUP_CONTESTED_CEILING = 0.2;

export interface QuickLaneGuards {
  threshold: number;
  stakesCeiling: number;
  contestedCeiling: number;
  /**
   * The stakes ceiling of a pure lookup (stakesCeilingFor). Optional: a legacy guards object without it (the replay
   * scripts' grids, a bare threshold) applies the base stakesCeiling only — exactly the pre-2026-10-20 rule.
   */
  lookupStakesCeiling?: number;
}

export const DEFAULT_QUICK_LANE_GUARDS: Readonly<QuickLaneGuards> = Object.freeze({
  threshold: QUICK_LANE_DEFAULT_THRESHOLD,
  stakesCeiling: QUICK_LANE_STAKES_CEILING,
  contestedCeiling: QUICK_LANE_CONTESTED_CEILING,
  lookupStakesCeiling: QUICK_LANE_LOOKUP_STAKES_CEILING,
});

/** A ceiling env as a number in [0, 1], or the fallback when unset / blank / garbage. Pure. */
export function ceilingFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** The trait ceilings in force (the threshold is the caller's — decisionOptionThreshold owns that env). Pure over env. */
export function quickLaneCeilings(env: Record<string, string | undefined> = process.env): Required<Pick<QuickLaneGuards, 'stakesCeiling' | 'contestedCeiling' | 'lookupStakesCeiling'>> {
  return {
    stakesCeiling: ceilingFromEnv(env.TURN_PLAN_QUICK_STAKES_CEILING, QUICK_LANE_STAKES_CEILING),
    contestedCeiling: ceilingFromEnv(env.TURN_PLAN_QUICK_CONTESTED_CEILING, QUICK_LANE_CONTESTED_CEILING),
    lookupStakesCeiling: ceilingFromEnv(env.TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING, QUICK_LANE_LOOKUP_STAKES_CEILING),
  };
}

/** The traits the lookup predicate reads (turn-plan.ts TurnClass carries them; the ruler reads them off the answers). */
export interface LookupTraits {
  needsLiveWeb?: number | null;
  multiStep?: number | null;
  contested?: number | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Traits as the decision ROW stores them (decision-gate.ts compactAnswers: 3 dp) — the consumer and the readiness
 *  ruler (which reads the row) classify the same numbers at every boundary (2026-10-20 review). */
export function traitRound(v: number): number { return Number(v.toFixed(3)); }

/**
 * A PURE LIVE LOOKUP: a correct answer depends on current web information (needs_live_web ≥ 0.8), needs no careful
 * multi-step reasoning (multi_step < 0.5) and is not a disputed topic (contested < 0.2). All three must be ANSWERED
 * (finite) — a missing / NaN trait (a backend that did not answer a noul) never relaxes the stakes guard. Pure.
 */
export function isPureLookup(t: LookupTraits | null | undefined): boolean {
  if (!t) return false;
  const { needsLiveWeb, multiStep, contested } = t;
  if (!finite(needsLiveWeb) || !finite(multiStep) || !finite(contested)) return false;
  return traitRound(needsLiveWeb) >= QUICK_LANE_LOOKUP_WEB_FLOOR - 1e-9
    && traitRound(multiStep) < QUICK_LANE_LOOKUP_MULTI_STEP_CEILING
    && traitRound(contested) < QUICK_LANE_LOOKUP_CONTESTED_CEILING;
}

/**
 * The stakes ceiling one turn is held to (pure): the lookup ceiling when the turn is a pure lookup AND the guards carry
 * a lookup ceiling ABOVE the base one; otherwise the base ceiling (`lookup: false`). A guards object without
 * lookupStakesCeiling, or one at / below the base (TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING=0.6), is today's rule.
 * The consumer (quickLaneEligibility) and the ruler (turnPlanActBand) both call this — they cannot disagree.
 */
export function stakesCeilingFor(t: LookupTraits | null | undefined, g: Pick<QuickLaneGuards, 'stakesCeiling' | 'lookupStakesCeiling'>): { ceiling: number; lookup: boolean } {
  let lookupCeiling = g.lookupStakesCeiling;
  // Tightening the BASE ceiling tightens lookups by the same amount (2026-10-20 review: an operator lowering
  // TURN_PLAN_QUICK_STAKES_CEILING after a bad Quick answer must not leave lookups at the absolute 0.75).
  if (finite(lookupCeiling) && g.stakesCeiling < QUICK_LANE_STAKES_CEILING) {
    lookupCeiling = Math.min(lookupCeiling, g.stakesCeiling + (QUICK_LANE_LOOKUP_STAKES_CEILING - QUICK_LANE_STAKES_CEILING));
  }
  if (finite(lookupCeiling) && lookupCeiling > g.stakesCeiling && isPureLookup(t)) return { ceiling: Number(lookupCeiling.toFixed(3)), lookup: true };
  return { ceiling: g.stakesCeiling, lookup: false };
}
