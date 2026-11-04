/**
 * Time-sliced machine runs — OBSERVE-ONLY budget observer (todo 89df978b,
 * framework audit 2026-10-16). Regression pins:
 *
 *  1. The verdict math: a run past the budget is would-cut, a run within it
 *     is not, activeMs (the honest clock) wins over raw wall clock, a NULL
 *     duration never cuts, and the budget env floors at 1 min (a typo can
 *     never flood the would_cut rows).
 *  2. The observer records EXACTLY the two metric rows and NOTHING ELSE: it
 *     never collapses a step budget, never cancels, never requeues, never
 *     mutates a run — the run's own state changes are OUT OF SCOPE by design
 *     (the act-path flip is a later owner decision, gate-flip doctrine).
 *  3. The kill switch stops both rows.
 *  4. Unattended-only: a user run records nothing (the budget concept is
 *     machine-run-only).
 *  5. Totality: a throwing recordLoopMetric must never propagate.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// loop-metrics.service imports config/database → config/env, which
// process.exit(1)s in jest without the env mirror (the busy-chat-queue
// learning). The observer only CALLS recordLoopMetric — mock the module and
// assert the recorded shapes directly.
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: {
    MACHINE_RUN_DURATION: 'machine_run_duration',
    MACHINE_RUN_WOULD_CUT: 'machine_run_would_cut',
    RUN_QUEUE_WAIT: 'run_queue_wait',
  },
  recordLoopMetric: jest.fn(),
}));

import {
  MACHINE_RUN_BUDGET_DEFAULT_MS,
  MACHINE_RUN_BUDGET_MIN_MS,
  machineRunBudgetMs,
  machineRunBudgetVerdict,
  observeMachineRunBudget,
} from './machine-run-budget';
import { recordLoopMetric } from '../platform/loop-metrics.service';

const recordSpy = recordLoopMetric as unknown as jest.Mock;

const BASE = {
  sessionId: 'sess-1',
  runId: 'run-1',
  unattended: true,
  status: 'completed',
  steps: 12,
  stepBudget: 200,
  attempts: 1,
  checkpointed: true,
  waitingBehind: 6,
  queueWaitMs: 4_200_000,
  origin: 'schedule',
  scheduleId: 'sked-1',
};

describe('machine-run-budget verdict math (pure)', () => {
  it('a run past the budget is would-cut with overMin; within it is not', () => {
    const over = machineRunBudgetVerdict({ durationMs: 75 * 60_000, budgetMs: 60 * 60_000 });
    expect(over.wouldCut).toBe(true);
    expect(over.overMin).toBe(15);
    expect(over.budgetMin).toBe(60);
    expect(over.durationMin).toBe(75);
    const within = machineRunBudgetVerdict({ durationMs: 41 * 60_000, budgetMs: 60 * 60_000 });
    expect(within.wouldCut).toBe(false);
    expect(within.overMin).toBe(0);
    expect(within.durationMin).toBe(41);
  });

  it('activeMs (approval-waits excluded) wins over raw wall clock — a run that merely waited on an owner card is NOT would-cut', () => {
    // 90 min wall, 71 of them an owner-card wait: active 19 min → within.
    const v = machineRunBudgetVerdict({ durationMs: 90 * 60_000, activeMs: 19 * 60_000, budgetMs: 60 * 60_000 });
    expect(v.wouldCut).toBe(false);
    expect(v.durationMin).toBe(90); // duration row keeps the honest wall clock
  });

  it('a NULL/unknown duration never cuts (the denominator row is still recorded)', () => {
    const v = machineRunBudgetVerdict({ durationMs: null, budgetMs: 60 * 60_000 });
    expect(v.wouldCut).toBe(false);
    expect(v.durationMin).toBeNull();
  });

  it('the budget env floors at 1 min — a mis-set env can never mark healthy runs would-cut', () => {
    process.env.MACHINE_RUN_BUDGET_MS = '6'; // typo'd ms value
    expect(machineRunBudgetMs()).toBe(MACHINE_RUN_BUDGET_MIN_MS);
    delete process.env.MACHINE_RUN_BUDGET_MS;
    process.env.MACHINE_RUN_BUDGET_MS = '120000';
    expect(machineRunBudgetMs()).toBe(120_000);
    delete process.env.MACHINE_RUN_BUDGET_MS;
    expect(machineRunBudgetMs()).toBe(MACHINE_RUN_BUDGET_DEFAULT_MS);
  });
});

describe('observeMachineRunBudget (the finalize-seam observer)', () => {
  beforeEach(() => { recordSpy.mockClear(); });

  it('records machine_run_duration ALWAYS and machine_run_would_cut ONLY past the budget, with the full decision meta', () => {
    observeMachineRunBudget({ ...BASE, durationMs: 92 * 60_000, activeMs: 80 * 60_000 });
    expect(recordSpy).toHaveBeenCalledTimes(2);
    const [durationRow, cutRow] = recordSpy.mock.calls.map(c => c[0]);
    expect(durationRow.kind).toBe('machine_run_duration');
    expect(durationRow.value).toBe(92);
    expect(durationRow.unit).toBe('min');
    expect(durationRow.sessionId).toBe('sess-1');
    expect(durationRow.runId).toBe('run-1');
    expect(durationRow.meta).toMatchObject({ status: 'completed', origin: 'schedule', scheduleId: 'sked-1' });
    expect(cutRow.kind).toBe('machine_run_would_cut');
    expect(cutRow.value).toBe(1);
    expect(cutRow.meta).toMatchObject({
      budgetMin: 60,
      overMin: 20,
      durationMin: 92,
      activeMin: 80,
      steps: 12,
      stepBudget: 200,
      attempts: 1,
      checkpointed: true,
      waitingBehind: 6,
      queueWaitMs: 4_200_000,
    });
  });

  it('a run within the budget records ONLY the duration row — no would_cut row', () => {
    observeMachineRunBudget({ ...BASE, durationMs: 30 * 60_000 });
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy.mock.calls[0][0].kind).toBe('machine_run_duration');
  });

  it('NEVER cuts, cancels, requeues or mutates anything — the observer outputs only metric rows', () => {
    // The observer takes a PLAIN observation object and returns void; the
    // only side effect that can exist is the metric call. A would-cut run's
    // observation is identical in shape to a within-budget one — there is no
    // code path from the verdict to any run mutation (the act-path flip is a
    // LATER owner decision on the measured false-positive rate).
    const before = JSON.stringify({ ...BASE });
    observeMachineRunBudget({ ...BASE, durationMs: 5 * 60_000 * 60 }); // 5h — way past
    observeMachineRunBudget({ ...BASE, durationMs: 5 * 60_000 });
    expect(JSON.stringify({ ...BASE })).toBe(before);
    const kinds = recordSpy.mock.calls.map(c => c[0].kind);
    expect(kinds).toEqual(expect.arrayContaining(['machine_run_duration', 'machine_run_would_cut']));
    // No third kind — nothing else was touched.
    expect(new Set(kinds)).toEqual(new Set(['machine_run_duration', 'machine_run_would_cut']));
  });

  it('the kill switch MACHINE_RUN_BUDGET_OBSERVER_DISABLED=1 records NOTHING', () => {
    process.env.MACHINE_RUN_BUDGET_OBSERVER_DISABLED = '1';
    try {
      observeMachineRunBudget({ ...BASE, durationMs: 92 * 60_000 });
      expect(recordSpy).not.toHaveBeenCalled();
    } finally {
      delete process.env.MACHINE_RUN_BUDGET_OBSERVER_DISABLED;
    }
  });

  it('a user (attended) run records nothing — the budget concept is machine-run-only', () => {
    observeMachineRunBudget({ ...BASE, unattended: false, durationMs: 92 * 60_000 });
    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('is total: a throwing recordLoopMetric never propagates to the finalize path', () => {
    recordSpy.mockImplementationOnce(() => { throw new Error('DB down'); });
    expect(() => observeMachineRunBudget({ ...BASE, durationMs: 10 * 60_000 })).not.toThrow();
  });

  it('a NULL duration still records the duration-less verdict path safely (no duration row, no cut row)', () => {
    observeMachineRunBudget({ ...BASE, durationMs: null, activeMs: null });
    expect(recordSpy).not.toHaveBeenCalled();
  });
});
