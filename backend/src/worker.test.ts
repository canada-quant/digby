/**
 * Phase 2 LEG 2a — coding worker process: the claim tick fills free slots and
 * stops, a claim error never kills the loop, and stop() shutdown-interrupts +
 * cooperatively cancels active runs and resolves once they drain.
 */

// worker.ts imports ./config/env for fail-fast boot validation (2026-08-20) —
// satisfy the schema before any import runs (same convention as
// credentials.service.test.ts).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-at-least-32-chars!!';

jest.mock('./utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// audit 2026-10-08 W3-1: loopMetric.createMany so the shutdown-flush replay can see the rows a drained worker writes.
const mockLoopMetricCreateMany: jest.Mock = jest.fn(async () => ({ count: 0 }));
jest.mock('./config/database', () => ({ __esModule: true, default: { $connect: jest.fn(), $disconnect: jest.fn(), loopMetric: { createMany: (...args: any[]) => mockLoopMetricCreateMany(...args) } } }));
jest.mock('./config/redis', () => ({ __esModule: true, default: {}, connectRedis: jest.fn() }));

const mockClaimNextRun: jest.Mock = jest.fn();
jest.mock('./modules/crossmodel/coding/run-claim', () => ({
  claimNextRun: (...args: any[]) => mockClaimNextRun(...args),
}));

const mockExecuteClaimedRun: jest.Mock = jest.fn();
jest.mock('./modules/crossmodel/coding/run-executor', () => ({
  executeClaimedRun: (...args: any[]) => mockExecuteClaimedRun(...args),
}));

// Overnight forensics fix 4: a harness exception from executeClaimedRun is
// stashed on the row as the attempt's terminal cause (run-state seam).
const mockRecordAttemptError: jest.Mock = jest.fn(async () => {});
jest.mock('./modules/crossmodel/coding/run-state', () => ({
  recordAttemptError: (...args: any[]) => mockRecordAttemptError(...args),
}));

const mockCancelRun: jest.Mock = jest.fn();
const mockMarkShutdown: jest.Mock = jest.fn();
const mockRequestDrainYield: jest.Mock = jest.fn();
jest.mock('./modules/crossmodel/coding/live-runs', () => ({
  cancelRun: (...args: any[]) => mockCancelRun(...args),
  markRunShutdownInterrupted: (...args: any[]) => mockMarkShutdown(...args),
  requestDrainYield: (...args: any[]) => mockRequestDrainYield(...args),
}));

// ── Phase 3 durable-cron seams ───────────────────────────────────────────────
const mockRegisterCronJob: jest.Mock = jest.fn(async () => {});
const mockCronLoopStop: jest.Mock = jest.fn();
const mockStartCronLoop: jest.Mock = jest.fn(() => ({ stop: mockCronLoopStop }));
const mockRetireOrphanCronJobs: jest.Mock = jest.fn(async () => []);
jest.mock('./modules/crossmodel/cron.service', () => ({
  registerCronJob: (...args: any[]) => mockRegisterCronJob(...args),
  startCronLoop: (...args: any[]) => mockStartCronLoop(...args),
  retireOrphanCronJobs: (...args: any[]) => mockRetireOrphanCronJobs(...args),
}));

const mockNewsSweep: jest.Mock = jest.fn(async () => {});
jest.mock('./modules/crossmodel/news.service', () => ({
  runNewsSweepOnce: (...args: any[]) => mockNewsSweep(...args),
}));

// (The feed.service module — and its feed-refresh cron — was retired with the
// topic-feeds subsystem, ticket 43c24152, 2026-10-20.)

const mockDreamCycle: jest.Mock = jest.fn(async () => {});
jest.mock('./modules/crossmodel/memory-maintenance.service', () => ({
  runDreamCycle: (...args: any[]) => mockDreamCycle(...args),
}));

const mockProjectDigest: jest.Mock = jest.fn(async () => {});
jest.mock('./modules/crossmodel/fleet/project-digest.service', () => ({
  runProjectDigestOnce: (...args: any[]) => mockProjectDigest(...args),
}));

const mockIsContainerMode: jest.Mock = jest.fn(() => false);
const mockReapContainers: jest.Mock = jest.fn(async () => {});
jest.mock('./modules/crossmodel/coding/container.service', () => ({
  isContainerMode: (...args: any[]) => mockIsContainerMode(...args),
  reapIdleContainers: (...args: any[]) => mockReapContainers(...args),
}));

const mockWorktreeReap: jest.Mock = jest.fn(async () => {});
jest.mock('./modules/crossmodel/coding/project-workspace.service', () => ({
  runWorktreeReapOnce: (...args: any[]) => mockWorktreeReap(...args),
  // worker.ts CRON_JOBS calls this at module load. 3600 is the adaptive
  // default; WORKTREE_DISK_ADAPTIVE_DISABLED=1 restores 21600 in the real
  // function (covered by project-workspace.service.test.ts).
  worktreeReapIntervalSec: () => 3600,
}));

const mockAgentRunReaper: jest.Mock = jest.fn(async () => {});
jest.mock('./modules/crossmodel/coding/run-reaper', () => ({
  runAgentRunReaper: (...args: any[]) => mockAgentRunReaper(...args),
}));

// Nightly strike adjudication (remediation P8 N6b) — lazy-imported by its
// handler; mocked so the dispatch + kill-switch tests stay boundary-only.
const mockStrikeAdjudication: jest.Mock = jest.fn(async () => 'ok');
jest.mock('./modules/crossmodel/fleet/strike-adjudication.service', () => ({
  runStrikeAdjudicationOnce: (...args: any[]) => mockStrikeAdjudication(...args),
}));

// Hourly per-project idle-chat auto-archiver (ticket bb86cee8) — lazy-imported
// by its handler; mocked so the dispatch + kill-switch tests stay boundary-only.
const mockIdleChatArchiver: jest.Mock = jest.fn(async () => {});
jest.mock('./modules/crossmodel/idle-chat-archiver', () => ({
  runIdleChatArchiverOnce: (...args: any[]) => mockIdleChatArchiver(...args),
}));

// Hourly project supervisor status cards (owner ask 2026-09-14) — statically
// imported by worker.ts; mocked so dispatch + kill-switch tests stay boundary-only.
const mockProjectStatus: jest.Mock = jest.fn(async () => {});
jest.mock('./modules/crossmodel/fleet/project-status.service', () => ({
  runProjectStatusOnce: (...args: any[]) => mockProjectStatus(...args),
}));

// Hourly branch janitor (owner 2026-09-14 — merged/stale/legacy branch cleanup)
// — statically imported by worker.ts; mocked so dispatch + kill-switch tests
// stay boundary-only.
const mockBranchJanitor: jest.Mock = jest.fn(async () => 'repos 0, scanned 0, deleted 0, kept 0');
jest.mock('./modules/crossmodel/fleet/branch-janitor.service', () => ({
  runBranchJanitorOnce: (...args: any[]) => mockBranchJanitor(...args),
}));
// Ticket 8a66441e (2026-10-16): the hourly app_error_logs fingerprint sweep —
// statically imported by worker.ts; mocked so dispatch + kill-switch tests stay boundary-only.
const mockLogSignalSweep: jest.Mock = jest.fn(async () => 'rows 0, fingerprints 0, signals 0, tickets filed 0 bumped 0, alert no');
jest.mock('./modules/crossmodel/fleet/log-signal-sweep.service', () => ({
  runLogSignalSweepOnce: (...args: any[]) => mockLogSignalSweep(...args),
  LOG_SIGNAL_SWEEP_DISABLED_ENV: 'LOG_SIGNAL_SWEEP_DISABLED',
}));
const mockDeepseekBalanceProbe: jest.Mock = jest.fn(async () => 'ok total=25 USD');
jest.mock('./utils/utility-llm', () => ({
  probeDeepSeekBalance: (...args: any[]) => mockDeepseekBalanceProbe(...args),
}));
// Decision-gate flip-readiness job (E1 in-process, 2026-09-25) — lazy-imported
// by its handler; mocked so the dispatch + kill-switch tests stay boundary-only.
const mockDecisionGateReadiness: jest.Mock = jest.fn(async () => 'rows 0, purposes 17, ready 0, stamped, 14 d window, 3 ms');
const mockDecisionGateRollout: jest.Mock = jest.fn(async () => 'flipped 0, refused 0, asked 0, parked 0, inconsistencies 0, evaluated 21, 2 ms');
jest.mock('./modules/crossmodel/platform/decision-gate-rollout', () => ({
  ...jest.requireActual('./modules/crossmodel/platform/decision-gate-rollout'),
  runDecisionGateRolloutOnce: (...args: any[]) => mockDecisionGateRollout(...args),
}));
jest.mock('./modules/crossmodel/platform/decision-gate-readiness.job', () => ({
  runDecisionGateReadinessOnce: (...args: any[]) => mockDecisionGateReadiness(...args),
}));
// User-added MCP servers health sweep (ticket e294f9a4) — lazy-imported by its handler.
// First-party visitor analytics maintenance (owner 2026-10-07) — lazy-imported by its handler; boundary-only.
const mockVisitorAnalyticsMaintenance: jest.Mock = jest.fn(async () => 'retention: -0 events, -0 visitors; rollup: 2 day(s), 3 row(s)');
jest.mock('./modules/crossmodel/visitors/visitor-analytics.service', () => ({
  runVisitorAnalyticsMaintenanceOnce: (...args: any[]) => mockVisitorAnalyticsMaintenance(...args),
}));
// build 2026-10-08 D: the delegation ledger reconcile — lazy-imported by its handler; boundary-only.
const mockDelegationReconcile: jest.Mock = jest.fn(async () => 'ledger 0 checked, 100% agree, missingParent 0, missingRows 0, stale 0; intents 0, executed twice 0, orphan pending 0');
jest.mock('./modules/crossmodel/platform/delegation-tasks-reconcile', () => ({
  ...jest.requireActual('./modules/crossmodel/platform/delegation-tasks-reconcile'),
  runDelegationReconcileOnce: (...args: any[]) => mockDelegationReconcile(...args),
}));
const mockUserMcpHealthSweep: jest.Mock = jest.fn(async () => 'servers 2, checked 1, healthy 1, degraded 0, unhealthy 0, recovered 1, 40 ms');
jest.mock('./modules/crossmodel/user-mcp/user-mcp.service', () => ({
  runUserMcpHealthSweepOnce: (...args: any[]) => mockUserMcpHealthSweep(...args),
}));
const mockFrameworkSignalSweep: jest.Mock = jest.fn(async () => 'sweep: scanned 0/0/0/0, found 0, deduped 0, filed 0, capped 0');
jest.mock('./modules/crossmodel/fleet/framework-signal-sweep', () => ({
  runFrameworkSignalSweepOnce: (...args: any[]) => mockFrameworkSignalSweep(...args),
}));
// 2026-10-20: the live worker-slot registry publisher (coding/worker-slots.ts) startWorker arms — mocked so the
// suite's shutdown-timing pins never ride a Redis call; the leaf's own behaviour is pinned in worker-slots.test.ts.
const mockStopSlotPublisher: jest.Mock = jest.fn();
const mockStartWorkerSlotPublisher: jest.Mock = jest.fn(() => (...a: any[]) => mockStopSlotPublisher(...a));
jest.mock('./modules/crossmodel/coding/worker-slots', () => ({
  startWorkerSlotPublisher: (...args: any[]) => mockStartWorkerSlotPublisher(...args),
}));
const mockExistsSync: jest.Mock = jest.fn(() => false);
const mockWriteFileSync: jest.Mock = jest.fn();
const mockUtimesSync: jest.Mock = jest.fn();
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: (...args: any[]) => mockExistsSync(...args),
  writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
  utimesSync: (...args: any[]) => mockUtimesSync(...args),
}));

import { startWorker, VOLUME_BOUND_CRON_JOBS } from './worker';
import { finishWorkerShutdown } from './modules/crossmodel/coding/worker-shutdown';
import { trackBackground, __resetBackgroundTasksForTest } from './utils/background-tasks';
import { recordRunSpend, recordLoopMetric, flushLoopMetrics } from './modules/crossmodel/platform/loop-metrics.service';
import type { ClaimedRun } from './modules/crossmodel/coding/run-claim';
import logger from './utils/logger';

const mockLoggerInfo = logger.info as jest.Mock;

const CLAIM = (id: string, sessionId: string): ClaimedRun => ({
  id, sessionId, preStatus: 'queued', checkpoint: null,
  input: { message: 'm', userId: 'u' }, attempts: 1, inputConsumed: false, lastError: null,
});

/** Let the async tick chain settle (claims resolve in microtasks). */
const settle = (ms = 25) => new Promise(r => setTimeout(r, ms));

/**
 * Poll until `cond` holds or the deadline expires. Fixed wall-clock sleeps
 * are a timing lottery under load (jest parallel workers delay 20ms ticks
 * past the sleep window); polling makes the wait deterministic while the
 * assertion after it still fails if the condition never arrives.
 */
const waitFor = async (cond: () => boolean, timeoutMs = 2_000, stepMs = 5): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() <= deadline) {
    await new Promise(r => setTimeout(r, stepMs));
  }
};

beforeEach(() => jest.clearAllMocks());

describe('startWorker', () => {
  it('tick claims up to the free slots, then stops claiming (queue empty)', async () => {
    mockClaimNextRun
      .mockResolvedValueOnce(CLAIM('run1', 'sess1'))
      .mockResolvedValueOnce(CLAIM('run2', 'sess2'))
      .mockResolvedValue(null); // queue empty afterwards
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    mockExecuteClaimedRun.mockImplementation(() => gate); // both slots stay busy

    const w = startWorker({ tickMs: 60_000, concurrency: 2 }); // huge tick: only the initial fire runs
    await settle();

    // Exactly 2 claims: the loop exits when the slots fill — it never over-claims
    // (the queue-empty stop is covered by the claim-error test below).
    expect(mockClaimNextRun).toHaveBeenCalledTimes(2);
    expect(mockClaimNextRun.mock.calls[0][0]).toMatch(/^worker-.+-\d+$/);
    expect(mockExecuteClaimedRun).toHaveBeenCalledTimes(2);
    expect(mockExecuteClaimedRun.mock.calls.map(c => c[0].id)).toEqual(['run1', 'run2']);
    expect(mockWriteFileSync).toHaveBeenCalledWith('/tmp/worker-alive', expect.any(String));

    release(); // let both executions finish so stop() drains instantly
    await w.stop();
  });

  it('a claim error ends the tick but keeps the worker alive (next tick claims)', async () => {
    mockClaimNextRun
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce(CLAIM('run1', 'sess1'))
      .mockResolvedValue(null);
    mockExecuteClaimedRun.mockResolvedValue(undefined);

    const w = startWorker({ tickMs: 20, concurrency: 1 });
    // No fixed wall-clock window: under load (jest parallel workers) the 20ms
    // ticks land late, so poll until the error tick's recovery claim actually
    // ran, then until >= 3 ticks total have touched the healthcheck file
    // (error tick + recovery tick + at least one more). If the worker had died
    // on the claim error — the regression this test guards — these time out
    // and the assertions below fail.
    await waitFor(() => mockExecuteClaimedRun.mock.calls.length === 1);
    await waitFor(() => mockWriteFileSync.mock.calls.length >= 3);

    expect(mockExecuteClaimedRun).toHaveBeenCalledTimes(1);
    expect(mockExecuteClaimedRun.mock.calls[0][0].id).toBe('run1');
    // Still ticking after the error (healthcheck file keeps being touched).
    expect(mockWriteFileSync.mock.calls.length).toBeGreaterThanOrEqual(3);

    await w.stop();
  });

  it('concurrency 1: the ONLY slot must NOT be interactive-reserved (2026-08-30 starvation fix — 0>=0 made interactiveOnly permanent, machine runs never claimed)', async () => {
    mockClaimNextRun.mockResolvedValueOnce(CLAIM('run1', 'sess1')).mockResolvedValue(null);
    mockExecuteClaimedRun.mockResolvedValue(undefined);

    const w = startWorker({ tickMs: 60_000, concurrency: 1 });
    await settle();

    expect(mockClaimNextRun).toHaveBeenCalledTimes(1);
    expect(mockClaimNextRun.mock.calls[0][1]).toEqual({ interactiveOnly: false });
    expect(mockExecuteClaimedRun).toHaveBeenCalledTimes(1);
    await w.stop();
  });

  it('concurrency 2: the LAST slot stays interactive-reserved (the 2026-08-26 owner-report guard is intact)', async () => {
    mockClaimNextRun
      .mockResolvedValueOnce(CLAIM('run1', 'sess1'))
      .mockResolvedValueOnce(CLAIM('run2', 'sess2'))
      .mockResolvedValue(null);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    mockExecuteClaimedRun.mockImplementation(() => gate); // both slots stay busy

    const w = startWorker({ tickMs: 60_000, concurrency: 2 });
    await settle();

    expect(mockClaimNextRun).toHaveBeenCalledTimes(2);
    expect(mockClaimNextRun.mock.calls[0][1]).toEqual({ interactiveOnly: false }); // slot 1 of 2: free-for-all
    expect(mockClaimNextRun.mock.calls[1][1]).toEqual({ interactiveOnly: true });  // slot 2 of 2: reserved

    release();
    await w.stop();
  });

  it('stop() shutdown-marks + cancels active runs and resolves once they drain', async () => {
    mockClaimNextRun.mockResolvedValueOnce(CLAIM('run9', 'sess9')).mockResolvedValue(null);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    mockExecuteClaimedRun.mockImplementation(() => gate);

    const w = startWorker({ tickMs: 60_000, concurrency: 1 });
    await settle();
    expect(mockExecuteClaimedRun).toHaveBeenCalledTimes(1);

    const stopped = w.stop();
    await settle(5);
    expect(mockMarkShutdown).toHaveBeenCalledWith('sess9');
    expect(mockCancelRun).toHaveBeenCalledWith('sess9');
    // stop() is still waiting for the active run to finalize…
    release();
    await Promise.race([
      stopped,
      new Promise((_, rej) => setTimeout(() => rej(new Error('stop() hung')), 3000)),
    ]);
  });

  it('forensics fix 4: a harness exception from executeClaimedRun is stashed on the row as the attempt cause (was log-only)', async () => {
    mockClaimNextRun.mockResolvedValueOnce(CLAIM('run7', 'sess7')).mockResolvedValue(null);
    mockExecuteClaimedRun.mockRejectedValueOnce(new Error('stageAndDescribe blew up'));

    const w = startWorker({ tickMs: 60_000, concurrency: 1 });
    await settle();

    expect(mockRecordAttemptError).toHaveBeenCalledWith('run7', 'harness exception: stageAndDescribe blew up', 1);
    await w.stop();
  });

  it('drain() (owner 2026-09-24 deploy-interrupt fix): no new claims, active runs finish IN PLACE (never shutdown-marked), resolves when idle', async () => {
    process.env.WORKER_DRAIN_FILE = `${require('os').tmpdir()}/worker-draining-${process.pid}`;
    mockClaimNextRun.mockResolvedValueOnce(CLAIM('runD', 'sessD')).mockResolvedValue(null);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    mockExecuteClaimedRun.mockImplementation(() => gate);
    const w = startWorker({ tickMs: 60_000, concurrency: 2 });
    await settle();
    expect(mockExecuteClaimedRun).toHaveBeenCalledTimes(1);
    const draining = w.drain({ pollMs: 5 });
    await settle(5);
    expect(mockMarkShutdown).not.toHaveBeenCalled();
    expect(mockCancelRun).not.toHaveBeenCalled();
    mockClaimNextRun.mockClear();
    release();
    const r = await Promise.race([draining, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('drain() hung')), 3000))]);
    expect(r).toMatchObject({ drained: 1, interrupted: 0 });
    expect(mockClaimNextRun).not.toHaveBeenCalled(); // no claims once draining
  });

  it('drain() asks a long run to YIELD after the soft threshold (never shutdown-marks it directly); the run hands off and the drain completes', async () => {
    mockClaimNextRun.mockResolvedValueOnce(CLAIM('runY', 'sessY')).mockResolvedValue(null);
    let release!: () => void;
    mockExecuteClaimedRun.mockImplementation(() => new Promise<void>(r => { release = r; }));
    // the real loop hands off at its next step boundary once asked
    mockRequestDrainYield.mockImplementation(() => { release(); });
    const w = startWorker({ tickMs: 60_000, concurrency: 1 });
    await settle();
    const r = await Promise.race([w.drain({ pollMs: 5, yieldAfterMs: 20 }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('drain() hung')), 4000))]);
    expect(mockRequestDrainYield).toHaveBeenCalledTimes(1);
    expect(mockRequestDrainYield).toHaveBeenCalledWith('sessY');
    expect(mockMarkShutdown).not.toHaveBeenCalled(); // the hard bound was never reached
    expect(r).toMatchObject({ interrupted: 0 });
    mockRequestDrainYield.mockReset();
  });

  it('DRAIN_YIELD_DISABLED=1: drain never asks for a yield', async () => {
    process.env.DRAIN_YIELD_DISABLED = '1';
    try {
      mockClaimNextRun.mockResolvedValueOnce(CLAIM('runZ', 'sessZ')).mockResolvedValue(null);
      let release!: () => void;
      mockExecuteClaimedRun.mockImplementation(() => new Promise<void>(r => { release = r; }));
      const w = startWorker({ tickMs: 60_000, concurrency: 1 });
      await settle();
      const draining = w.drain({ pollMs: 5, yieldAfterMs: 1 });
      await settle(40);
      expect(mockRequestDrainYield).not.toHaveBeenCalled();
      release();
      await draining;
    } finally {
      delete process.env.DRAIN_YIELD_DISABLED;
    }
  });

  it('drain() past its bound falls back to the interrupt path for leftovers', async () => {
    mockClaimNextRun.mockResolvedValueOnce(CLAIM('runE', 'sessE')).mockResolvedValue(null);
    // Never finishes on its own — it only bails when the fallback interrupt path cancels it (the real loop's behaviour).
    let release!: () => void;
    mockExecuteClaimedRun.mockImplementation(() => new Promise<void>(r => { release = r; }));
    mockCancelRun.mockImplementation(() => { release(); });
    const w = startWorker({ tickMs: 60_000, concurrency: 1 });
    await settle();
    const r = await Promise.race([w.drain({ maxMs: 30, pollMs: 5 }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('drain() hung')), 4000))]);
    expect(mockMarkShutdown).toHaveBeenCalledWith('sessE');
    expect(mockCancelRun).toHaveBeenCalledWith('sessE');
    expect(r).toMatchObject({ drained: 0, interrupted: 1 });
    mockCancelRun.mockReset();
  });

  it('stop() with no active runs resolves immediately', async () => {
    mockClaimNextRun.mockResolvedValue(null);
    const w = startWorker({ tickMs: 60_000, concurrency: 2 });
    await settle();
    await expect(w.stop()).resolves.toBeUndefined();
    expect(mockCancelRun).not.toHaveBeenCalled();
  });

  it('stop() logs the shutdown bookkeeping: start line, per-run marks, and the marked-vs-drained summary (d64f6f08)', async () => {
    mockClaimNextRun.mockResolvedValueOnce(CLAIM('run10', 'sess10')).mockResolvedValue(null);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    mockExecuteClaimedRun.mockImplementation(() => gate);

    const w = startWorker({ tickMs: 60_000, concurrency: 1 });
    await settle();
    expect(mockExecuteClaimedRun).toHaveBeenCalledTimes(1);

    const stopped = w.stop();
    await settle(5);
    release(); // the run drains inside the STOP_WAIT_MS budget
    await stopped;

    const infos = mockLoggerInfo.mock.calls.map(c => String(c[0]));
    expect(infos.some(m => m.includes('shutdown — interrupting 1 active run(s): run10'))).toBe(true);
    expect(infos.some(m => m.includes('marking run run10 (session sess10) shutdown-interrupted + cancelling'))).toBe(true);
    expect(infos.some(m =>
      m.includes('shutdown summary') && m.includes('marked 1 run(s)') && m.includes('drained 1') && m.includes('still active 0'),
    )).toBe(true);
  });
});

describe('durable cron wiring (Phase 3)', () => {
  const EXPECTED_JOBS: Array<[string, number]> = [
    ['news-prefetch', 900],    // Audit 2026-09-26 (H1): the compute_policy window-closed negative writer.
    ['compute-policy-window-closer', 600],
    // Session topology (2026-09-27): the +24 h placement labels + the observe-only R6 retire scan.
    ['session-topology-outcomes', 21600],
    // INTERVENTION-OUTCOMES (2026-10-20): the +6h/+24h labels of supervisor lane interventions.
    ['supervisor-intervention-outcomes', 3600],
    // (feed-refresh 120 s was retired with the topic-feeds subsystem, 43c24152.)
    ['memory-dream', 3600],
    ['project-digest', 3600],
    ['ticket-postdeploy-verifier', 900], // 6665fff6: re-measures awaiting_verification tickets' acceptance metrics post-deploy
    ['premise-check', 3600],
    ['container-reaper', 3600],
    ['worktree-reaper', 3600],
    ['agent-run-reaper', 300],
    ['agent-events-retention', 60],
    ['attention-watchdog', 900],
    ['project-status', 900],
    ['session-status', 900],
    ['ticket-closure-manifest', 600],
    ['ticket-drain', 1800],
    ['session-history-sync', 600],
    ['strike-adjudication', 86400],
    // 2026-10-04: the nightly live-chat audit (signals + decision replay over real human turns).
    ['live-chat-audit', 86400],
    ['idle-chat-archiver', 3600],
    ['branch-janitor', 3600],
    // Ticket 8a66441e (2026-10-16): the hourly app_error_logs fingerprint sweep.
    ['log-signal-sweep', 3600],
    ['deepseek-balance-probe', 3600],
    ['drive-watch-renew', 86400],
    ['decision-gate-readiness', 21600],
    ['decision-gate-rollout', 3600],
    // User-added MCP servers (ticket e294f9a4): the health / self-healing re-probe sweep.
    ['user-mcp-health', 300],
    // First-party visitor analytics (owner 2026-10-07): visit_events retention + the per-user spend rollup.
    ['visitor-analytics', 21600],
    // build 2026-10-08 D: the SHADOW delegation ledger + tool-intent journal nightly readout.
    ['delegation-reconcile', 86400],
    // capacity-probe (todo 0f58ddde, 2026-10-16): box-C saturation probes
    // (drainer pool + dev-container memory) → capacity_* loop_metrics rows;
    // volume-bound (box C only). Kill switch CAPACITY_WATCH_DISABLED=1.
    ['capacity-probe', 900],
    // Ticket d7bf73c2: the repair cron for NULL-embedding digby_memory rows
    // (DashScope 429 keyword-only stores) — DB-only, claimable everywhere.
    ['memory-embed-backfill', 900],
    // 2026-10-16: hourly DB-only framework signal sweep (kill switch read inside).
    ['framework-signal-sweep', 3600],
    // CI-WATCH (2026-10-20): the no-LLM 5-min CI watch over lane-pushed shas (kill switch read inside).
    ['ci-watch', 300],
    // 2026-10-20 memory wave: the archived-memory retention (DB-only, daily).
    ['memory-archive-retention', 86400],
    // 2026-10-20 memory wave: the scheduled learnings-index dream (DB + utility model, daily).
    ['learnings-dream', 86400],
    // MERGE-INTENT-AWAIT (2026-10-20): the 2-min merge-intent + condition-wake pass (kill switches read inside).
    ['merge-intents', 120],
  ];

  it('registers all sixteen jobs at boot and starts the cron loop with their handlers', async () => {
    mockClaimNextRun.mockResolvedValue(null);
    const w = startWorker({ tickMs: 60_000, concurrency: 1 });
    await settle();

    expect(mockRegisterCronJob.mock.calls.map(c => [c[0], c[1]])).toEqual(EXPECTED_JOBS);

    expect(mockStartCronLoop).toHaveBeenCalledTimes(1);
    const [workerId, handlers, jobs, tickMs] = mockStartCronLoop.mock.calls[0];
    expect(workerId).toMatch(/^worker-.+-\d+$/);
    expect(tickMs).toBe(5_000);
    expect(Object.keys(handlers).sort()).toEqual(EXPECTED_JOBS.map(j => j[0]).sort());
    // The loop gets the job registry too (H2: it re-registers all jobs every 60s).
    expect(jobs.map((j: any) => [j.id, j.intervalSec])).toEqual(EXPECTED_JOBS);

    // (Feed boot maintenance was retired with the feeds subsystem, 43c24152.)

    await w.stop();
  });

  it('a 0-slot (cron-only) worker never registers or claims session-history-sync (box A stale-mirror incident 2026-09-08)', async () => {
    mockClaimNextRun.mockResolvedValue(null);
    const w = startWorker({ tickMs: 60_000, concurrency: 0 });
    await settle();

    const registered = mockRegisterCronJob.mock.calls.map(c => c[0]);
    expect(registered).not.toContain('session-history-sync');
    // Review 2026-09-13 issue 8: the gate now covers every volume-bound cron.
    expect(registered).toHaveLength(EXPECTED_JOBS.length - VOLUME_BOUND_CRON_JOBS.size);

    // The claim list the cron loop works from must exclude it too — a
    // registered-but-noop claim would consume the firing and starve box C.
    const [, , jobs] = mockStartCronLoop.mock.calls[0];
    expect(jobs.map((j: any) => j.id)).not.toContain('session-history-sync');

    await w.stop();
  });

  // Review 2026-09-13 issue 8: the worktree-reaper (hourly since 2026-10-18;
  // was 6h) was claimable by box A's 0-slot worker — it fired against A's
  // stale 48G volume copy and nulled the shared DB paths, orphaning C's real
  // dirs (177 of 223). Every cron that touches the workspaces volume or the
  // session containers is now absent from a cron-only worker's registration +
  // claim list; DB-only sweeps stay.
  it('a 0-slot (cron-only) worker never registers or claims ANY volume-bound cron: worktree-reaper + container-reaper join session-history-sync (review 2026-09-13 issue 8)', async () => {
    mockClaimNextRun.mockResolvedValue(null);
    const w = startWorker({ tickMs: 60_000, concurrency: 0 });
    await settle();

    expect([...VOLUME_BOUND_CRON_JOBS].sort()).toEqual(['capacity-probe', 'container-reaper', 'session-history-sync', 'worktree-reaper']);

    const registered = mockRegisterCronJob.mock.calls.map(c => c[0]);
    const [, , jobs] = mockStartCronLoop.mock.calls[0];
    const claimable = jobs.map((j: any) => j.id);
    for (const id of VOLUME_BOUND_CRON_JOBS) {
      expect(registered).not.toContain(id);
      expect(claimable).not.toContain(id);
    }
    // DB-only sweeps (the agent-run reaper included — it never touches disk) stay claimable on the cron-only box.
    for (const id of ['agent-run-reaper', 'agent-events-retention', 'attention-watchdog', 'project-status', 'session-status', 'project-digest', 'premise-check', 'ticket-drain', 'strike-adjudication', 'news-prefetch', 'memory-dream', 'branch-janitor', 'memory-embed-backfill']) {
      expect(registered).toContain(id);
      expect(claimable).toContain(id);
    }

    await w.stop();
  });

  it('a worker WITH slots (the volume owner, box C) still registers + claims every cron incl. the volume-bound ones', async () => {
    mockClaimNextRun.mockResolvedValue(null);
    const w = startWorker({ tickMs: 60_000, concurrency: 1 });
    await settle();

    const registered = mockRegisterCronJob.mock.calls.map(c => c[0]);
    for (const id of VOLUME_BOUND_CRON_JOBS) expect(registered).toContain(id);
    expect(registered).toHaveLength(EXPECTED_JOBS.length);

    await w.stop();
  });

  it('handlers dispatch to the right sweeps; the env guards ride along', async () => {
    mockClaimNextRun.mockResolvedValue(null);
    const w = startWorker({ tickMs: 60_000, concurrency: 1 });
    await settle();
    const handlers = mockStartCronLoop.mock.calls[0][1] as Record<string, () => Promise<void>>;

    await handlers['news-prefetch']();
    expect(mockNewsSweep).toHaveBeenCalledTimes(1);
    // (the feed-refresh handler was retired with the feeds subsystem, 43c24152)
    await handlers['worktree-reaper']();
    expect(mockWorktreeReap).toHaveBeenCalledTimes(1);
    await handlers['agent-run-reaper']();
    expect(mockAgentRunReaper).toHaveBeenCalledTimes(1);

    // container-reaper is a no-op outside container mode (the old start* guard)…
    await handlers['container-reaper']();
    expect(mockReapContainers).not.toHaveBeenCalled();
    mockIsContainerMode.mockReturnValue(true);
    await handlers['container-reaper']();
    expect(mockReapContainers).toHaveBeenCalledTimes(1);

    // …and memory-dream honors MEMORY_DREAM_DISABLED=1.
    process.env.MEMORY_DREAM_DISABLED = '1';
    await handlers['memory-dream']();
    expect(mockDreamCycle).not.toHaveBeenCalled();
    delete process.env.MEMORY_DREAM_DISABLED;
    await handlers['memory-dream']();
    expect(mockDreamCycle).toHaveBeenCalledTimes(1);

    // …and project-digest honors PROJECT_DIGEST_DISABLED=1 (same pattern).
    process.env.PROJECT_DIGEST_DISABLED = '1';
    await handlers['project-digest']();
    expect(mockProjectDigest).not.toHaveBeenCalled();
    delete process.env.PROJECT_DIGEST_DISABLED;
    await handlers['project-digest']();
    expect(mockProjectDigest).toHaveBeenCalledTimes(1);

    // …and strike-adjudication (P8 N6b) honors STRIKE_ADJUDICATION_DISABLED=1.
    process.env.STRIKE_ADJUDICATION_DISABLED = '1';
    await handlers['strike-adjudication']();
    expect(mockStrikeAdjudication).not.toHaveBeenCalled();
    delete process.env.STRIKE_ADJUDICATION_DISABLED;
    await handlers['strike-adjudication']();
    expect(mockStrikeAdjudication).toHaveBeenCalledTimes(1);

    // …and idle-chat-archiver (ticket bb86cee8) honors IDLE_CHAT_ARCHIVER_DISABLED=1.
    process.env.IDLE_CHAT_ARCHIVER_DISABLED = '1';
    await handlers['idle-chat-archiver']();
    expect(mockIdleChatArchiver).not.toHaveBeenCalled();
    delete process.env.IDLE_CHAT_ARCHIVER_DISABLED;
    await handlers['idle-chat-archiver']();
    expect(mockIdleChatArchiver).toHaveBeenCalledTimes(1);

    // …and project-status (owner ask 2026-09-14) honors PROJECT_STATUS_UPDATES_DISABLED=1.
    process.env.PROJECT_STATUS_UPDATES_DISABLED = '1';
    await handlers['project-status']();
    expect(mockProjectStatus).not.toHaveBeenCalled();
    delete process.env.PROJECT_STATUS_UPDATES_DISABLED;
    await handlers['project-status']();
    expect(mockProjectStatus).toHaveBeenCalledTimes(1);

    // …and branch-janitor (owner 2026-09-14) honors BRANCH_JANITOR_DISABLED=1
    // (DB/API-only — it is NOT in the volume-bound set).
    expect(VOLUME_BOUND_CRON_JOBS.has('branch-janitor')).toBe(false);
    process.env.BRANCH_JANITOR_DISABLED = '1';
    await handlers['branch-janitor']();
    expect(mockBranchJanitor).not.toHaveBeenCalled();
    delete process.env.BRANCH_JANITOR_DISABLED;
    await handlers['branch-janitor']();
    expect(mockBranchJanitor).toHaveBeenCalledTimes(1);

    // …and log-signal-sweep (ticket 8a66441e) honors LOG_SIGNAL_SWEEP_DISABLED=1
    // (DB + Redis only — NOT volume-bound, so the 0-slot cron-only box may claim it)
    // and returns its pass summary for cron_jobs.lastStatus.
    expect(VOLUME_BOUND_CRON_JOBS.has('log-signal-sweep')).toBe(false);
    process.env.LOG_SIGNAL_SWEEP_DISABLED = '1';
    await handlers['log-signal-sweep']();
    expect(mockLogSignalSweep).not.toHaveBeenCalled();
    delete process.env.LOG_SIGNAL_SWEEP_DISABLED;
    await expect(handlers['log-signal-sweep']()).resolves.toContain('fingerprints 0');
    expect(mockLogSignalSweep).toHaveBeenCalledTimes(1);

    // …and deepseek-balance-probe (nightly 2026-09-14) honors
    // DEEPSEEK_BALANCE_PROBE_DISABLED=1 (pure outbound HTTPS + deduped ticket —
    // NOT volume-bound, so the 0-slot cron-only box may claim it).
    expect(VOLUME_BOUND_CRON_JOBS.has('deepseek-balance-probe')).toBe(false);
    process.env.DEEPSEEK_BALANCE_PROBE_DISABLED = '1';
    await handlers['deepseek-balance-probe']();
    expect(mockDeepseekBalanceProbe).not.toHaveBeenCalled();
    delete process.env.DEEPSEEK_BALANCE_PROBE_DISABLED;
    await handlers['deepseek-balance-probe']();
    expect(mockDeepseekBalanceProbe).toHaveBeenCalledTimes(1);

    // …and decision-gate-readiness (E1 in-process, 2026-09-25) honors
    // DECISION_GATE_READINESS_JOB_DISABLED=1 and passes the job's one-line
    // summary through to cron_jobs.lastStatus (DB-only — NOT volume-bound, so
    // the 0-slot cron-only box A may claim it; the Postgres lease keeps it to
    // ONE worker per firing).
    expect(VOLUME_BOUND_CRON_JOBS.has('decision-gate-readiness')).toBe(false);
    process.env.DECISION_GATE_READINESS_JOB_DISABLED = '1';
    await handlers['decision-gate-readiness']();
    expect(mockDecisionGateReadiness).not.toHaveBeenCalled();
    delete process.env.DECISION_GATE_READINESS_JOB_DISABLED;
    await expect(handlers['decision-gate-readiness']()).resolves.toBe('rows 0, purposes 17, ready 0, stamped, 14 d window, 3 ms');
    expect(mockDecisionGateReadiness).toHaveBeenCalledTimes(1);

    // …and decision-gate-rollout (rollout self-governance, 2026-09-27) honors
    // DECISION_GATE_ROLLOUT_JOB_DISABLED=1 and passes its summary through the
    // same way (DB-only — NOT volume-bound).
    expect(VOLUME_BOUND_CRON_JOBS.has('decision-gate-rollout')).toBe(false);
    process.env.DECISION_GATE_ROLLOUT_JOB_DISABLED = '1';
    await handlers['decision-gate-rollout']();
    expect(mockDecisionGateRollout).not.toHaveBeenCalled();
    delete process.env.DECISION_GATE_ROLLOUT_JOB_DISABLED;
    await expect(handlers['decision-gate-rollout']()).resolves.toBe('flipped 0, refused 0, asked 0, parked 0, inconsistencies 0, evaluated 21, 2 ms');
    expect(mockDecisionGateRollout).toHaveBeenCalledTimes(1);

    // …and user-mcp-health (ticket e294f9a4) honors USER_MCP_DISABLED=1 and
    // USER_MCP_HEALTH_DISABLED=1, and passes the sweep summary through
    // (outbound HTTPS + store rows — NOT volume-bound).
    expect(VOLUME_BOUND_CRON_JOBS.has('user-mcp-health')).toBe(false);
    process.env.USER_MCP_DISABLED = '1';
    await handlers['user-mcp-health']();
    delete process.env.USER_MCP_DISABLED;
    process.env.USER_MCP_HEALTH_DISABLED = '1';
    await handlers['user-mcp-health']();
    expect(mockUserMcpHealthSweep).not.toHaveBeenCalled();
    delete process.env.USER_MCP_HEALTH_DISABLED;
    await expect(handlers['user-mcp-health']()).resolves.toBe('servers 2, checked 1, healthy 1, degraded 0, unhealthy 0, recovered 1, 40 ms');
    expect(mockUserMcpHealthSweep).toHaveBeenCalledTimes(1);

    // …and visitor-analytics (owner 2026-10-07) dispatches to the maintenance pass (DB-only — never volume-bound).
    expect(VOLUME_BOUND_CRON_JOBS.has('visitor-analytics')).toBe(false);
    await expect(handlers['visitor-analytics']()).resolves.toBe('retention: -0 events, -0 visitors; rollup: 2 day(s), 3 row(s)');
    expect(mockVisitorAnalyticsMaintenance).toHaveBeenCalledTimes(1);

    // …and delegation-reconcile (build 2026-10-08 D) dispatches to the readout pass (DB-only — never volume-bound).
    expect(VOLUME_BOUND_CRON_JOBS.has('delegation-reconcile')).toBe(false);
    await expect(handlers['delegation-reconcile']()).resolves.toMatch(/^ledger 0 checked/);
    expect(mockDelegationReconcile).toHaveBeenCalledTimes(1);

    expect(VOLUME_BOUND_CRON_JOBS.has('framework-signal-sweep')).toBe(false);
    await expect(handlers['framework-signal-sweep']()).resolves.toMatch(/^sweep: scanned/);
    expect(mockFrameworkSignalSweep).toHaveBeenCalledTimes(1);

    await w.stop();
  });

  it('stop() stops the cron loop alongside the run-claim tick', async () => {
    mockClaimNextRun.mockResolvedValue(null);
    const w = startWorker({ tickMs: 60_000, concurrency: 1 });
    await settle();
    expect(mockCronLoopStop).not.toHaveBeenCalled();
    await w.stop();
    expect(mockCronLoopStop).toHaveBeenCalledTimes(1);
  });
});

// ── audit 2026-10-08 W3-1 (plumbing F1) — REPLAY of the drained-worker loss ──
// Run 887e8789 (lane 7bd45d57, One Piece, $15.14) was the LAST run its worker
// finished while draining for a deploy: finalize emitted its context event at
// 00:59:29Z, the worker disconnected + exited, and the run has no run_spend /
// run_tokens rows, no coding_memory_fold rows and no run_completed hook event.
describe('worker shutdown flush (audit 2026-10-08 W3-1)', () => {
  const RUN = '887e8789-8c35-4ece-8329-d17d60954696';
  const LANE = '7bd45d57-059b-42c5-8245-ea1ee358635f';
  const emitted: Array<{ chatId: string; type: string; runId: string }> = [];
  /** What run-executor's finalize does for the incident run: a BUFFERED run_spend + a fire-and-forget terminal hook emit. */
  const finalizeLikeTheIncident = async (claim: ClaimedRun) => {
    recordRunSpend('rmuxdrained0001', claim.sessionId, {
      totalInTokens: 4_800_000, totalOutTokens: 61_000, totalCostUsd: 15.14, turns: 213, estimated: false,
      agents: [{ model: 'api-alibaba-qwen3.8-max', inTokens: 4_800_000, outTokens: 61_000, costUsd: 15.14, agent: 'Digby' }],
    }, { model: 'api-alibaba-qwen3.8-max', profile: 'coding', triggerKind: 'machine', agentRunId: claim.id });
    void trackBackground(
      new Promise<void>((r) => setTimeout(r, 30)).then(() => { emitted.push({ chatId: claim.sessionId, type: 'run_completed', runId: claim.id }); }),
      'terminal-hook-emit',
    );
  };
  const rowsWritten = () => mockLoopMetricCreateMany.mock.calls.flatMap((c: any[]) => (c[0]?.data ?? []) as any[]);

  beforeEach(() => {
    emitted.length = 0;
    __resetBackgroundTasksForTest();
    delete process.env.WORKER_SHUTDOWN_FLUSH_DISABLED;
    process.env.WORKER_DRAIN_FILE = `${require('os').tmpdir()}/worker-draining-w3-${process.pid}`;
  });
  afterAll(() => { delete process.env.WORKER_SHUTDOWN_FLUSH_DISABLED; });

  it('REPLAY: the drained worker\'s last run keeps its run_spend row and its run_completed emit lands before the disconnect', async () => {
    mockClaimNextRun.mockResolvedValueOnce(CLAIM(RUN, LANE)).mockResolvedValue(null);
    // The run is still active (3 h of steps) when SIGTERM arrives; it finishes in place during the drain.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockExecuteClaimedRun.mockImplementation(async (claim: ClaimedRun) => { await gate; await finalizeLikeTheIncident(claim); });
    const w = startWorker({ tickMs: 60_000, concurrency: 2 });
    await waitFor(() => mockExecuteClaimedRun.mock.calls.length === 1);
    const draining = w.drain({ pollMs: 5 });
    release();
    const d = await draining;
    expect(d).toMatchObject({ drained: 1, interrupted: 0 });
    // drain() resolved with the run's follow-up still in flight — the exact pre-fix exit point.
    expect(emitted).toEqual([]);
    expect(rowsWritten().some((r) => r.kind === 'run_spend')).toBe(false);
    const r = await finishWorkerShutdown({ settleMs: 0, signal: 'SIGTERM', mode: 'drain' });
    expect(r.skipped).toBe(false);
    expect(emitted).toEqual([{ chatId: LANE, type: 'run_completed', runId: RUN }]);
    const rows = rowsWritten();
    const spend = rows.find((x) => x.kind === 'run_spend');
    expect(spend).toMatchObject({ sessionId: LANE, value: 15.14 });
    expect(spend.meta).toMatchObject({ agentRunId: RUN, profile: 'coding' });
    expect(rows.some((x) => x.kind === 'run_tokens_in' && x.value === 4_800_000)).toBe(true);
    expect(rows.find((x) => x.kind === 'worker_shutdown_flush')?.meta).toMatchObject({ signal: 'SIGTERM', mode: 'drain', backgroundTimedOut: false });
  });

  it('kill switch WORKER_SHUTDOWN_FLUSH_DISABLED=1: nothing awaited, nothing flushed (the pre-fix exit)', async () => {
    process.env.WORKER_SHUTDOWN_FLUSH_DISABLED = '1';
    mockClaimNextRun.mockResolvedValueOnce(CLAIM(RUN, LANE)).mockResolvedValue(null);
    mockExecuteClaimedRun.mockImplementation(finalizeLikeTheIncident);
    const w = startWorker({ tickMs: 60_000, concurrency: 2 });
    await waitFor(() => mockExecuteClaimedRun.mock.calls.length === 1);
    await w.drain({ pollMs: 5 });
    const r = await finishWorkerShutdown({ settleMs: 0 });
    expect(r).toEqual({ skipped: true, background: null, metrics: null });
    expect(emitted).toEqual([]);
    expect(rowsWritten().some((x) => x.kind === 'run_spend')).toBe(false);
    // let the stray emit + buffered rows settle so they cannot leak into another test
    delete process.env.WORKER_SHUTDOWN_FLUSH_DISABLED;
    await finishWorkerShutdown({ settleMs: 0 });
  });

  it('a stuck background task is bounded: the flush still writes the spend row and reports the timeout', async () => {
    mockLoopMetricCreateMany.mockClear();
    recordRunSpend('rmuxstuck', LANE, { totalInTokens: 10, totalOutTokens: 1, totalCostUsd: 0.5, agents: [{ model: 'glm-5.3', inTokens: 10, outTokens: 1, costUsd: 0.5 }] }, { profile: 'coding' });
    void trackBackground(new Promise<void>(() => { /* never settles */ }), 'stuck');
    const r = await finishWorkerShutdown({ settleMs: 0, backgroundMaxMs: 20 });
    expect(r.background).toMatchObject({ timedOut: true, remaining: 1, remainingLabels: ['stuck'] });
    expect(rowsWritten().some((x) => x.kind === 'run_spend' && x.value === 0.5)).toBe(true);
    __resetBackgroundTasksForTest();
  });
});

describe('orphan cron GC at boot (audit 2026-10-08 W3-4)', () => {
  it('a 0-slot worker passes the FULL code job list (volume-bound ids included) — it never retires a job another box serves', async () => {
    mockClaimNextRun.mockResolvedValue(null);
    const w = startWorker({ tickMs: 60_000, concurrency: 0 });
    await waitFor(() => mockRetireOrphanCronJobs.mock.calls.length === 1);
    const known: string[] = mockRetireOrphanCronJobs.mock.calls[0][0];
    for (const id of VOLUME_BOUND_CRON_JOBS) expect(known).toContain(id);
    expect(known).toContain('attention-watchdog');
    expect(known).not.toContain('box-health');
    await w.stop();
  });
});

// audit 2026-10-08 W3-4 (plumbing F10): lane 7bd45d57 wrote 650 context_compaction rows in 18 h, 0 with a runId.
describe('per-run telemetry id on coding runs (audit 2026-10-08 W3-4)', () => {
  const RUN = '5d96cb5c-038e-4a4d-bb76-0e4f4fc13205';
  const LANE = '7bd45d57-059b-42c5-8245-ea1ee358635f';
  const compactionRow = () => mockLoopMetricCreateMany.mock.calls.flatMap((c: any[]) => (c[0]?.data ?? []) as any[]).find((r) => r.kind === 'context_compaction');
  afterEach(() => { delete process.env.CODING_RUN_TELEMETRY_ID_DISABLED; });

  it('REPLAY: a compaction row recorded inside the run (no explicit runId) carries the agent_runs id', async () => {
    mockClaimNextRun.mockResolvedValueOnce(CLAIM(RUN, LANE)).mockResolvedValue(null);
    mockExecuteClaimedRun.mockImplementation(async (claim: ClaimedRun) => {
      await Promise.resolve();
      recordLoopMetric({ kind: 'context_compaction', sessionId: claim.sessionId, value: 1200, unit: 'ms', meta: { mode: 'early' } });
    });
    const w = startWorker({ tickMs: 60_000, concurrency: 2 });
    await waitFor(() => mockExecuteClaimedRun.mock.calls.length === 1);
    await w.drain({ pollMs: 5 });
    await flushLoopMetrics();
    expect(compactionRow()).toMatchObject({ sessionId: LANE, runId: RUN });
  });

  it('kill switch CODING_RUN_TELEMETRY_ID_DISABLED=1: the row keeps runId null (pre-fix)', async () => {
    process.env.CODING_RUN_TELEMETRY_ID_DISABLED = '1';
    mockClaimNextRun.mockResolvedValueOnce(CLAIM(RUN, LANE)).mockResolvedValue(null);
    mockExecuteClaimedRun.mockImplementation(async (claim: ClaimedRun) => {
      recordLoopMetric({ kind: 'context_compaction', sessionId: claim.sessionId, value: 1, unit: 'ms' });
    });
    const w = startWorker({ tickMs: 60_000, concurrency: 2 });
    await waitFor(() => mockExecuteClaimedRun.mock.calls.length === 1);
    await w.drain({ pollMs: 5 });
    await flushLoopMetrics();
    expect(compactionRow()).toMatchObject({ sessionId: LANE, runId: null });
  });
});

describe('live worker-slot registry publisher (2026-10-20 — the project-supervisor spawn ceiling reads it)', () => {
  it('startWorker publishes THIS worker\'s slots (its workerId + concurrency) and stop() stops the publisher', async () => {
    mockClaimNextRun.mockResolvedValue(null);
    const w = startWorker({ tickMs: 60_000, concurrency: 2 });
    expect(mockStartWorkerSlotPublisher).toHaveBeenCalledTimes(1);
    expect(mockStartWorkerSlotPublisher.mock.calls[0][0]).toMatchObject({ concurrency: 2 });
    expect(mockStartWorkerSlotPublisher.mock.calls[0][0].workerId).toMatch(/^worker-.+-\d+$/);
    expect(mockStopSlotPublisher).not.toHaveBeenCalled();
    await w.stop();
    expect(mockStopSlotPublisher).toHaveBeenCalledTimes(1);
  });

  it('drain() stops the publisher too (a draining worker\'s slots are leaving)', async () => {
    mockClaimNextRun.mockResolvedValue(null);
    const w = startWorker({ tickMs: 60_000, concurrency: 2 });
    await w.drain({ pollMs: 5 });
    expect(mockStopSlotPublisher).toHaveBeenCalledTimes(1);
  });

  it('a 0-slot cron-only worker hands the publisher its 0 (the leaf publishes nothing for it — pinned in worker-slots.test.ts)', async () => {
    const w = startWorker({ tickMs: 60_000, concurrency: 0 });
    expect(mockStartWorkerSlotPublisher.mock.calls[0][0]).toMatchObject({ concurrency: 0 });
    await w.stop();
  });
});
