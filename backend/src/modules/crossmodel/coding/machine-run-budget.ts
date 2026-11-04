/**
 * MACHINE-RUN BUDGET OBSERVER (todo 89df978b, framework audit 2026-10-16 —
 * observe-only, the 6f8b52b7 / PR #1548 ladder).
 *
 * The charter (SOTA: preemptive time slicing / fair queuing; Temporal
 * continue-as-new): a run budget that ends a MACHINE run at a STEP BOUNDARY,
 * checkpoints it, and requeues it behind waiting work. Every mechanism this
 * needs ALREADY EXISTS and is proven in production — the agent loop's
 * runDeadlineMs seam collapses a run to a tools-off final at a step boundary
 * (agent.ts, "past it the next step is forced to be the last"), the
 * write-ahead checkpoint fires at every step-top and before every tool
 * dispatch, and the interrupted/requeue path resumes from checkpoints across
 * deploy churn. The ONLY missing piece is the measurement: which runs a
 * budget WOULD have cut, what was waiting behind them, and what the
 * fleet's queue/ticket latencies look like.
 *
 * This module is the OBSERVATION leg and nothing else. It NEVER collapses a
 * step budget, NEVER cancels a run, NEVER requeues, NEVER mutates a schedule
 * — it records two loop_metrics rows at the run-finalize seam and answers
 * pure questions for tests. The flip to act (wiring a would-cut verdict into
 * an actual cut) is a LATER owner decision on the measured false-positive
 * rate (gate-flip doctrine) and is NOT implemented here.
 *
 * Baseline that motivated this (Paul's monitor, verified in code, 2026-10-16):
 * RUN_DEADLINE_ENABLED is opt-in and not forwarded to prod (switch-registry:
 * inert opt-in) — machine runs are unbounded; 3 ticket lanes busy, 6 waiting,
 * 0 started since 7 AM (13:05 PT external sweep). The 2026-09-11 gate flip
 * turned the v1#33 deadline OFF because 0.8×cadence truncated 11.3% of
 * machine runs — an act-path must be re-derived from measurement, not
 * assumed. MEASURE (the todo's own bar): p95 machine-run minutes, ticket
 * start latency, queue wait.
 *
 * Rows recorded per UNATTENDED machine run at finalize (fire-and-forget,
 * never throws):
 *   machine_run_duration     value = wall-clock minutes of the run (the
 *                            p95 source; one row per machine run — the
 *                            aggregate IS the distribution).
 *   machine_run_would_cut    value = 1 ONLY when the run outlived the
 *                            budget: the would-have-been-cut record, with
 *                            meta { budgetMin, overMin, steps, stepBudget,
 *                            attempts, status, checkpointed, waitingBehind,
 *                            queueWaitMs, origin } — the measured
 *                            false-positive-rate input for a future act
 *                            decision.
 *
 * Kill switch MACHINE_RUN_BUDGET_OBSERVER_DISABLED=1 (both rows stop;
 * the run is untouched either way). Budget default 60 min via
 * MACHINE_RUN_BUDGET_MS (min 60_000 — a typo must not arm a 6 ms budget and
 * mark every run would-cut).
 */
import { LOOP_METRIC_KINDS, recordLoopMetric } from '../platform/loop-metrics.service';

/** Default observation budget: 60 min. The baseline sweep found machine runs
 *  running 4 h+ while 6 ticket lanes waited; 60 min sits well above the
 *  normal p95 and below the pathological tail, so the would_cut rows measure
 *  the tail without noise-flooding on healthy runs. */
export const MACHINE_RUN_BUDGET_DEFAULT_MS = 60 * 60 * 1000;

/** Floor for MACHINE_RUN_BUDGET_MS so a mis-set env can never mark healthy
 *  runs would-cut (the false-positive source the act-path flip must avoid). */
export const MACHINE_RUN_BUDGET_MIN_MS = 60 * 1000;

/** MACHINE_RUN_BUDGET_OBSERVER_DISABLED=1 — the observer records nothing. */
export function machineRunBudgetObserverDisabled(): boolean {
  return process.env.MACHINE_RUN_BUDGET_OBSERVER_DISABLED === '1';
}

/** The observation budget in ms (env MACHINE_RUN_BUDGET_MS, default 60 min,
 *  floored at 1 min). Pure. */
export function machineRunBudgetMs(): number {
  const raw = Number(process.env.MACHINE_RUN_BUDGET_MS);
  if (!Number.isFinite(raw) || raw <= 0) return MACHINE_RUN_BUDGET_DEFAULT_MS;
  return Math.max(MACHINE_RUN_BUDGET_MIN_MS, Math.round(raw));
}

/** The inputs the finalize-seam observer needs. Everything is optional-safe:
 *  a missing timestamp degrades to null and the row is still recorded (an
 *  observer must never lose the denominator because one run had a NULL
 *  column). */
export interface MachineRunBudgetObservation {
  sessionId: string;
  runId: string;
  /** machine classification at the executor (triggerKind !== 'user' || ownerDispatch). */
  unattended: boolean;
  /** Wall-clock duration ms (first-claim startedAt → finalize). Null = unknown. */
  durationMs: number | null;
  /** Elapsed clock minus approval/queue waits (agent deadlineOffsetMs), when known —
   *  the honest budget clock (the act-path seam excludes these waits too). */
  activeMs?: number | null;
  status: string;
  steps?: number | null;
  stepBudget?: number | null;
  attempts?: number | null;
  /** Did THIS attempt ever write a checkpoint (executor checkpointWritten)? The
   *  resume feasibility leg of a would-cut: cutting a run with no checkpoint
   *  would lose work. */
  checkpointed?: boolean;
  /** Runs QUEUED on other sessions at finalize time (the queue-wait pressure
   *  behind the would-cut run — "what was waiting behind it"). */
  waitingBehind?: number | null;
  /** queued createdAt → first-claim startedAt for THIS run, ms (queue wait). */
  queueWaitMs?: number | null;
  origin?: string | null;
  /** schedule/hook firing that queued this run, when present. */
  scheduleId?: string | null;
}

/** The verdict the observer records — pure, exported for tests. */
export interface MachineRunBudgetVerdict {
  /** duration row value: wall-clock minutes (null when durationMs unknown). */
  durationMin: number | null;
  /** true when the run outlived the budget (the would-cut record). */
  wouldCut: boolean;
  /** budget used for the comparison, minutes. */
  budgetMin: number;
  /** minutes past the budget (0 when within). */
  overMin: number;
}

/** Pure: the would-cut verdict for one run. `activeMs` wins over `durationMs`
 *  when present (the budget the act-path would enforce excludes
 *  approval-waits — comparing on raw wall clock would over-count a run that
 *  merely waited on an owner card). */
export function machineRunBudgetVerdict(obs: {
  durationMs: number | null;
  activeMs?: number | null;
  budgetMs?: number;
}): MachineRunBudgetVerdict {
  const budgetMs = obs.budgetMs ?? machineRunBudgetMs();
  const budgetMin = Math.round(budgetMs / 60_000);
  const clock = obs.activeMs ?? obs.durationMs;
  if (typeof clock !== 'number' || !Number.isFinite(clock) || clock < 0) {
    return { durationMin: null, wouldCut: false, overMin: 0, budgetMin };
  }
  const overMs = clock - budgetMs;
  return {
    durationMin: Math.round((obs.durationMs ?? clock) / 60_000),
    wouldCut: overMs > 0,
    overMin: overMs > 0 ? Math.round(overMs / 60_000) : 0,
    budgetMin,
  };
}

/**
 * The finalize-seam observer: record machine_run_duration (+ machine_run_would_cut
 * when the run outlived the budget) for ONE unattended machine run. TOTAL —
 * never throws, never mutates the run, never collapses a budget; the caller
 * passes fire-and-forget context and the rows land on the next loop-metrics
 * micro-batch flush. Non-unattended runs are skipped (the budget concept is
 * machine-run-only; user runs keep the no-latency-contract rule).
 */
export function observeMachineRunBudget(obs: MachineRunBudgetObservation): void {
  try {
    if (machineRunBudgetObserverDisabled()) return;
    if (!obs.unattended) return;
    const verdict = machineRunBudgetVerdict(obs);
    if (verdict.durationMin != null) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.MACHINE_RUN_DURATION,
        sessionId: obs.sessionId,
        runId: obs.runId,
        value: verdict.durationMin,
        unit: 'min',
        meta: {
          status: obs.status,
          ...(obs.origin ? { origin: obs.origin } : {}),
          ...(obs.scheduleId ? { scheduleId: obs.scheduleId } : {}),
        },
      });
    }
    if (!verdict.wouldCut) return;
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MACHINE_RUN_WOULD_CUT,
      sessionId: obs.sessionId,
      runId: obs.runId,
      value: 1,
      meta: {
        budgetMin: verdict.budgetMin,
        overMin: verdict.overMin,
        durationMin: verdict.durationMin ?? null,
        ...(obs.activeMs != null ? { activeMin: Math.round(obs.activeMs / 60_000) } : {}),
        status: obs.status,
        steps: obs.steps ?? null,
        stepBudget: obs.stepBudget ?? null,
        attempts: obs.attempts ?? null,
        checkpointed: obs.checkpointed === true,
        waitingBehind: obs.waitingBehind ?? null,
        queueWaitMs: obs.queueWaitMs ?? null,
        ...(obs.origin ? { origin: obs.origin } : {}),
        ...(obs.scheduleId ? { scheduleId: obs.scheduleId } : {}),
      },
    });
  } catch {
    /* observe-only telemetry must never break a finalize path */
  }
}
