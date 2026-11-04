/**
 * P5 — SHADOW firing-size predictor for schedule / hook firings
 * (coding option D step 2, 2026-10-04 — docs/CODING_DYNAMIC_ROSTER_OPTIONS_2026-10-04.md §D).
 *
 * Step 1 (2026-10-04) shipped the LABEL: `run_tool_profile` rows now carry
 * `codeWrites` / `gitWrites` / `platformWrites` (tool-profile.ts `runDidWrite`),
 * so a schedule / hook firing that changed nothing is a queryable row
 * (`meta->>'triggerKind'` from the run stamp).
 *
 * This leaf is the SHADOW predictor — telemetry only, NEVER caps the seat:
 * a schedule / hook firing (never a human turn, an owner dispatch, an agent
 * send or a harness auto-resume) that the lane's history says is likely to be
 * a no-op (maintenance-only) is recorded with its predicted label + the state
 * the prediction came from. The label is `runDidWrite` (did the run change
 * anything itself or hand work to a worker); the state is the lane's last 5
 * `run_tool_profile` rows. Readiness/act (effort high vs max, fast seat vs
 * lead, "skip the finish sequence") is a LATER decision gated on this shadow
 * data reaching the maturity bar — never here.
 *
 * Pure decision leaf — the DB reads live in the wiring (run-executor), so the
 * decision is unit-testable without a database, mirroring
 * machine-firing-effort.ts.
 */

export interface FiringProfileRow {
  /** loop_metrics.value — total tool calls in the run. */
  calls?: number | null;
  /** meta.codeWrites / gitWrites / platformWrites — the write counters. */
  codeWrites?: number | null;
  gitWrites?: number | null;
  platformWrites?: number | null;
  /** meta.machine — the run was machine-triggered. */
  machine?: boolean | null;
  /** createdAt — oldest→newest order is the CALLER's job. */
  createdAt?: Date | string | null;
}

export interface FiringPredictionInput {
  /** Oldest→newest, already filtered to this lane's run_tool_profile rows. */
  history: readonly FiringProfileRow[];
  /** The upcoming firing's trigger kind — schedule or hook only. */
  triggerKind: 'schedule' | 'hook' | 'user' | 'machine';
  ownerDispatch?: boolean;
}

export type FiringPredictionVerdict =
  | 'skip-finish' // history says maintenance-only — the no-op class
  | 'full'; // history says this firing writes — keep max effort + finish

export interface FiringPrediction {
  verdict: FiringPredictionVerdict;
  reason: string;
  /** The state the prediction came from (counts over the capped history). */
  from: {
    n: number;
    noOps: number;
    writes: number;
    /** true when the newest row was a no-op (recency evidence). */
    newestNoOp: boolean;
  };
}

/** True when the SHADOW predictor applies to this firing (schedule / hook only). */
export function firingPredictorApplies(
  input: Pick<FiringPredictionInput, 'triggerKind' | 'ownerDispatch'>,
): boolean {
  return (
    (input.triggerKind === 'schedule' || input.triggerKind === 'hook') && input.ownerDispatch !== true
  );
}

/** True when a profiled row shows the run wrote nothing (the no-op class). */
function isNoOpRow(row: FiringProfileRow | undefined): boolean {
  if (!row) return false;
  const didWrite = (row.codeWrites ?? 0) + (row.gitWrites ?? 0) + (row.platformWrites ?? 0) > 0;
  return !didWrite;
}

/**
 * The pure decision: from the lane's last 5 run_tool_profile rows (state),
 * predict whether THIS firing is maintenance-only (skip-finish) or a full
 * working firing. Predicts "full" (the safe default) unless the window is
 * BOTH recent (newest row a no-op) AND majority no-op (≥ 3 of ≥ 5 rows, or
 * 2 of 2 when that is all the history there is) — a full-biased recency
 * heuristic that never fires on thin data. Empty history ⇒ full + no_history.
 */
export function predictFiringSize(input: FiringPredictionInput): FiringPrediction {
  const h = input.history ?? [];
  const n = h.length;
  if (n === 0) {
    return {
      verdict: 'full',
      reason: 'no_history',
      from: { n: 0, noOps: 0, writes: 0, newestNoOp: false },
    };
  }
  let noOps = 0;
  for (const row of h) {
    if (isNoOpRow(row)) noOps += 1;
  }
  const writes = n - noOps;
  const newestNoOp = isNoOpRow(h[n - 1]);
  const majorityNoOp = n >= 5 ? noOps >= 3 : noOps === n && n >= 2;
  const skip = newestNoOp && majorityNoOp;
  return {
    verdict: skip ? 'skip-finish' : 'full',
    reason: skip ? 'recent_majority_no_op_history' : 'no_op_minority_or_recent_write',
    from: { n, noOps, writes, newestNoOp },
  };
}
