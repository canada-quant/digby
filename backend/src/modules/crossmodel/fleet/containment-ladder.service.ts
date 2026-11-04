/**
 * Containment ladder (remediation P8 item S7, 2026-09-09) — TELEMETRY ONLY
 * since the 2026-09-11 gate flip (owner: "get the framework back operating at
 * full steam like it was before you added all these annoying gates").
 *
 * What remains: a PER-LANE tier evaluation over guard-strike rates, emitting
 * ONE containment_ladder loop_metric row per state TRANSITION (both
 * directions) so strike-rate pathology stays chartable:
 *
 *   ≥5 weighted strikes in the lane's last 10 runs  → 'claims_required'
 *   ≥10 weighted strikes in the last 20 runs        → 'cadence_halved'
 *   ≥15 weighted strikes in the last 30 runs        → 'model_swap_proposed'
 *
 * The tier NAMES are kept so historical rows and dashboards stay comparable,
 * but no tier ACTS any more. REMOVED (Gate flip 2026-09-11, owner: full
 * steam): the claims_required scheduler notice (Redis containment:notice:*),
 * the ONCE-per-7d cadence halving (intervalSec ×2 on the lane's fastest
 * schedule), the model-swap owner decision card, the
 * CONTAINMENT_LADDER_ACTIONS opt-in, and the self-merge G5 consumer
 * (`readLadderState`). In its 21 live hours the action path halved 12
 * cadences on 9 lanes (6 still doubled), filed 13 owner cards (all declined
 * or dismissed) and held ~10h of platform PRs on lanes that were struck by
 * a conviction class the very PRs fixed. There is deliberately NO opt-in env
 * that re-arms schedule mutation or merge refusal — that is the gate class the
 * owner cannot understand; re-adding an action means a new design, not a flag.
 *
 * Wiring: called once per attention-watchdog sweep (runAttentionWatchdogOnce;
 * 15-min cadence). Failure posture: best-effort, never throws into the cron
 * loop.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

// ── Ladder states + thresholds ────────────────────────────────────────────────

export type LadderState = 'normal' | 'claims_required' | 'cadence_halved' | 'model_swap_proposed';

/** The tiers, HIGHEST first (evaluation returns the highest tier that holds).
 *  window = how many of the lane's most recent runs the strikes are counted
 *  over; a lane with FEWER runs than the window is evaluated over what it has
 *  (same strike count over fewer runs is strictly worse, so this errs toward
 *  the higher tier, never away from it). Tier names are telemetry labels only. */
export const LADDER_TIERS: ReadonlyArray<{ state: Exclude<LadderState, 'normal'>; window: number; strikes: number }> = [
  { state: 'model_swap_proposed', window: 30, strikes: 15 },
  { state: 'cadence_halved', window: 20, strikes: 10 },
  { state: 'claims_required', window: 10, strikes: 5 },
];

/** The machine-run guard seams whose strikes count as MACHINE-attributed in
 *  the transition metric (`machineMajority`). Telemetry attribution only —
 *  nothing acts on it any more. Gate flip 2026-09-11 (owner: full steam):
 *  'zero_tool_prefinal' moved OUT of this set and INTO ANNOTATION_ONLY_SEAMS —
 *  that seam is observe-only now (agent.ts records tool-less answers without
 *  discarding them), so it can never drive a tier on its own weight. */
export const MACHINE_RUN_SEAMS: ReadonlySet<string> = new Set([
  'tool_derail_break',
  'reject_back',
  'numeric_provenance',
]);

export interface LaneStrike {
  /** meta.seam of the guard_strike row ('' for the seam-less finalize strike). */
  seam: string;
  createdAt: Date;
}

/** Annotation-only seams: the guard OBSERVED and marked/recorded but rejected,
 *  replaced, and withheld NOTHING. They count HALF toward the tier thresholds
 *  (2026-09-09 Hardening Bench calibration: 5 of the 15 strikes behind a
 *  model-swap card were annotate-only numeric_provenance marks). Gate flip
 *  2026-09-11 (owner: full steam): 'zero_tool_prefinal' added — the zero-tool
 *  gate records observations only (ZERO_TOOL_GATE_ENFORCE=1 restores the
 *  discard in agent.ts), so its rows weigh like any other observation. */
export const ANNOTATION_ONLY_SEAMS: ReadonlySet<string> = new Set(['numeric_provenance', 'zero_tool_prefinal']);

/** Escalation weight of one strike toward the tier thresholds. */
export function strikeWeight(seam: string): number {
  return ANNOTATION_ONLY_SEAMS.has(seam) ? 0.5 : 1;
}

/** Run-boundary timestamps: `windowN` = createdAt of the lane's N-th most
 *  recent run. undefined = the lane has fewer than N runs (all strikes count). */
export interface LadderRunBoundaries {
  window10?: Date;
  window20?: Date;
  window30?: Date;
}

/**
 * Pure ladder evaluation for one lane. `strikes` = the lane's guard_strike
 * rows within its last min(runs, 30) runs; `runs` = how many runs that window
 * actually holds. Strikes are attributed to a tier's window by TIME (createdAt
 * ≥ the window's oldest run) — runs are sequential per lane (one claimable row
 * per session), so time order is run order. Returns the HIGHEST tier that
 * holds; 'normal' otherwise (including runs <= 0 — no runs means nothing to
 * evaluate).
 */
export function ladderStateForLane(
  strikes: LaneStrike[],
  runs: number,
  boundaries?: LadderRunBoundaries,
): LadderState {
  if (!Array.isArray(strikes) || strikes.length === 0) return 'normal';
  if (!Number.isFinite(runs) || runs <= 0) return 'normal';
  const boundaryFor = (window: number): Date | undefined => {
    if (window === 10) return boundaries?.window10;
    if (window === 20) return boundaries?.window20;
    return boundaries?.window30;
  };
  const weightIn = (window: number): number => {
    const boundary = boundaryFor(window);
    const inWindow = boundary
      ? strikes.filter((s) => s.createdAt.getTime() >= boundary.getTime())
      : strikes; // fewer runs than the window — every strike is inside it
    // Weighted, not counted: annotate-only observations escalate at half the
    // rate of enforcement-grade strikes (see ANNOTATION_ONLY_SEAMS above).
    return inWindow.reduce((sum, s) => sum + strikeWeight(s.seam), 0);
  };
  // RECOVERY DECAY (2026-09-09 stale-window incident): every tier requires
  // CURRENT heat — a lane whose last-10-runs weight would not even trigger
  // the claims tier has recovered, and a resolved storm must not pin it for
  // 30 runs. Observed: a lane whose 74 derail strikes all predated a fix by
  // 16+ clean hours was still pinned at model_swap_proposed. Severity still
  // comes from the longer windows — a still-hot lane keeps its full tier.
  const claimsThreshold = LADDER_TIERS[LADDER_TIERS.length - 1].strikes;
  if (weightIn(10) < claimsThreshold) return 'normal';
  for (const tier of LADDER_TIERS) {
    if (weightIn(tier.window) >= tier.strikes) return tier.state;
  }
  return 'normal';
}

/** True when a strict majority of the strikes carry machine-run seams. Pure;
 *  exported for tests. Telemetry attribution only (stamped on the transition
 *  metric as `machineMajority`) — nothing gates on it since 2026-09-11. */
export function strikesMajorityMachineSeams(strikes: LaneStrike[]): boolean {
  if (!Array.isArray(strikes) || strikes.length === 0) return false;
  const machine = strikes.filter((s) => MACHINE_RUN_SEAMS.has(s.seam)).length;
  return machine * 2 > strikes.length;
}

// ── Tunables + keys ───────────────────────────────────────────────────────────

/** Lanes considered per sweep = lanes with a guard_strike in this lookback. */
export const LADDER_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Pathology bound: lanes evaluated per sweep. */
export const LADDER_MAX_LANES_PER_SWEEP = 25;
/** The lane's recent-run window (matches the top tier). */
export const LADDER_RUNS_WINDOW = 30;
/** Last-known ladder state per lane (transition detection), self-cleaning. */
const LADDER_STATE_TTL_SEC = 7 * 24 * 3600;

export const LADDER_STATE_KEY = (sessionId: string) => `containment:state:${sessionId}`;

// ── Sweep ─────────────────────────────────────────────────────────────────────

/**
 * One containment sweep: evaluate every lane that drew a guard strike in the
 * last 24h and emit a containment_ladder metric on every STATE TRANSITION.
 * Takes NO action (Gate flip 2026-09-11, owner: full steam — the notice /
 * cadence-halving / owner-card path was removed, not gated). Returns the
 * number of lanes currently in a non-normal state. NEVER throws.
 */
export async function sweepContainmentLadder(opts?: { now?: Date }): Promise<number> {
  try {
    const now = opts?.now ?? new Date();
    const recent = await prisma.loopMetric.findMany({
      where: { kind: 'guard_strike', createdAt: { gte: new Date(now.getTime() - LADDER_LOOKBACK_MS) } },
      select: { sessionId: true },
    });
    const lanes = [...new Set((recent ?? []).map((r: any) => r?.sessionId).filter(Boolean) as string[])]
      .sort()
      .slice(0, LADDER_MAX_LANES_PER_SWEEP);
    let contained = 0;
    for (const lane of lanes) {
      try {
        contained += (await evaluateLane(lane)) ? 1 : 0;
      } catch (err: any) {
        logger.warn(`containment-ladder: lane ${String(lane).slice(0, 8)} evaluation failed (non-fatal): ${err?.message ?? err}`);
      }
    }
    return contained;
  } catch (err: any) {
    try { logger.warn(`containment-ladder: sweep failed (non-fatal): ${err?.message ?? err}`); } catch { /* never throws */ }
    return 0;
  }
}

/** Evaluate ONE lane and record its transition (telemetry only). Returns true
 *  when state ≠ normal. */
async function evaluateLane(lane: string): Promise<boolean> {
  // The lane's last ≤30 runs, newest first — the strike window + boundaries.
  const runs = await prisma.agentRun.findMany({
    where: { sessionId: lane },
    orderBy: { createdAt: 'desc' },
    take: LADDER_RUNS_WINDOW,
    select: { id: true, createdAt: true },
  });
  if (!runs?.length) return false;
  const oldest = runs[runs.length - 1].createdAt;
  const boundaries: LadderRunBoundaries = {
    window10: runs[9]?.createdAt,
    window20: runs[19]?.createdAt,
    window30: runs[29]?.createdAt,
  };
  const strikeRows = await prisma.loopMetric.findMany({
    where: { kind: 'guard_strike', sessionId: lane, createdAt: { gte: oldest } },
    select: { meta: true, createdAt: true },
  });
  const strikes: LaneStrike[] = (strikeRows ?? []).map((r: any) => ({
    seam: typeof r?.meta?.seam === 'string' ? r.meta.seam : '',
    createdAt: r.createdAt,
  }));
  const state = ladderStateForLane(strikes, runs.length, boundaries);

  // Transition telemetry: one containment_ladder row per state CHANGE (both
  // directions — recovery to 'normal' is chartable too). `machineMajority`
  // carries the old ACT-gate attribution as data.
  const stateKey = LADDER_STATE_KEY(lane);
  let prev: string | null = null;
  try { prev = await (redisClient as any).get(stateKey); } catch { /* best-effort */ }
  const prevState = prev || 'normal';
  if (state !== prevState) {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.CONTAINMENT_LADDER,
      sessionId: lane,
      meta: {
        lane,
        state,
        prev: prevState,
        strikes: strikes.length,
        runs: runs.length,
        machineMajority: strikesMajorityMachineSeams(strikes),
        outcome: 'observed', // Gate flip 2026-09-11 (owner: full steam): no tier acts
      },
    });
    logger.info(`containment-ladder: lane ${lane.slice(0, 8)} ${prevState} → ${state} (${strikes.length} strikes / ${runs.length} runs; observed only)`);
    try { await (redisClient as any).set(stateKey, state, { EX: LADDER_STATE_TTL_SEC }); } catch { /* best-effort */ }
  }

  // Gate flip 2026-09-11 (owner: full steam): the ACT branch (claims notice →
  // cadence halving → owner model-swap card) was REMOVED here, not gated — no
  // env restores it. Telemetry above is the whole ladder now.
  return state !== 'normal';
}
