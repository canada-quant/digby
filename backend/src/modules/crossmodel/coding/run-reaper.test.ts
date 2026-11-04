/**
 * agent-run-reaper (Phase 3) — the three rules: (b) 7-day resume-window expiry,
 * (a) orphaned running sessions → ready (delegated to the boot sweep), (c)
 * 30-day terminal-run event GC. Prisma + the sweep seam are mocked; each rule
 * is verified best-effort-isolated (one rule's failure can't skip the others).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentRun: { updateMany: jest.fn() },
  // findMany: rule (e)'s candidate scan — empty here (its own pins live in run-reaper.child.test.ts).
  chatCodingState: { updateMany: jest.fn(async () => ({ count: 0 })), findMany: jest.fn(async () => []) },
  agentEvent: { deleteMany: jest.fn() },
  runToolReceipt: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({ count: 0 })) },
  // Rule (g) — hook_events terminal-row GC (hardening review 2026-09-14).
  hookEvent: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({ count: 0 })) },
  $queryRaw: jest.fn(),
};
// Rule (i) (loop #14) dynamically imports the snapshot hygiene sweep — keep the real
// module (and its lazy config/redis import) out of this suite.
jest.mock('./worktree-snapshot.service', () => ({ __esModule: true, sweepSnapshotHygiene: jest.fn(async () => null) }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockSweep: jest.Mock = jest.fn(async () => 0);
jest.mock('./coding-data.service', () => ({
  sweepOrphanedRunningSessions: (...a: any[]) => mockSweep(...a),
}));

import { Prisma } from '@prisma/client';
import { runAgentRunReaper, RESUME_WINDOW_MS, EVENT_GC_BATCH, EVENT_GC_PASS_MAX_ROWS, EVENT_GC_PASS_BUDGET_MS, RECEIPT_GC_AGE_MS, RECEIPT_GC_BATCH, PROVISIONING_GRACE_MS, HOOK_EVENT_GC_AGE_MS, HOOK_EVENT_GC_BATCH, HOOK_EVENT_GC_TERMINAL_STATUSES } from './run-reaper';
import logger from '../../../utils/logger';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
  mockPrisma.runToolReceipt.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.hookEvent.findMany.mockResolvedValue([]);
  mockPrisma.hookEvent.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.chatCodingState.updateMany.mockResolvedValue({ count: 0 });
});

describe('rule (a2) — stuck provisioning sessions heal to ready', () => {
  it('flips provisioning rows older than the grace window to ready (absorbing-state fix)', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.chatCodingState.updateMany.mockResolvedValue({ count: 1 });
    const before = Date.now();
    await runAgentRunReaper();
    const [args] = mockPrisma.chatCodingState.updateMany.mock.calls[0];
    expect(args.where.status).toBe('provisioning');
    // Ticket 911b6c45: the heal flip must ALSO clear errorMessage — a bare
    // status flip leaves the failed attempt's text on a 'ready' row.
    expect(args.data).toEqual({ status: 'ready', errorMessage: null });
    const cutoff = args.where.updatedAt.lt.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(PROVISIONING_GRACE_MS - 1000);
    expect(before - cutoff).toBeLessThanOrEqual(PROVISIONING_GRACE_MS + 5000);
  });

  it('ticket 911b6c45 — clears errorMessage left on NON-error rows (the stale-mishap backfill)', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.chatCodingState.updateMany
      .mockResolvedValueOnce({ count: 0 })  // provisioning sweep: nothing stuck
      .mockResolvedValueOnce({ count: 3 }); // backfill: 3 stale rows healed
    await runAgentRunReaper();
    // Second chatCodingState.updateMany call = the ticket's backfill sweep:
    // every row holding a message under a NON-error status gets it cleared.
    const backfillArgs = mockPrisma.chatCodingState.updateMany.mock.calls[1][0];
    expect(backfillArgs.where).toEqual({ errorMessage: { not: null }, status: { not: 'error' } });
    expect(backfillArgs.data).toEqual({ errorMessage: null });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('cleared stale errorMessage on 3 non-error session(s) (ticket 911b6c45)'),
    );
  });

  it('ticket 911b6c45 — a backfill failure never throws and never skips the other rules', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.chatCodingState.updateMany
      .mockResolvedValueOnce({ count: 0 })   // provisioning sweep OK
      .mockRejectedValueOnce(new Error('db down')); // backfill fails
    await expect(runAgentRunReaper()).resolves.toBeUndefined();
    expect(mockPrisma.$queryRaw).toHaveBeenCalled(); // event GC still ran
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stale-errorMessage sweep failed'));
  });

  it('a provisioning-sweep failure never skips the other rules', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.chatCodingState.updateMany.mockRejectedValue(new Error('db down'));
    await expect(runAgentRunReaper()).resolves.toBeUndefined();
    expect(mockPrisma.$queryRaw).toHaveBeenCalled(); // event GC still ran
  });
});

describe('rule (b) — resume-window expiry', () => {
  it('fails interrupted runs older than 7 days, dropping the checkpoint + lease', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.$queryRaw.mockResolvedValue([]);

    const before = Date.now();
    await runAgentRunReaper();

    const [args] = mockPrisma.agentRun.updateMany.mock.calls[0];
    expect(args.where.status).toBe('interrupted');
    const cutoffMs = before - args.where.updatedAt.lt.getTime();
    // ±tolerance: the impl's own Date.now() can drift a ms or two from `before`.
    expect(cutoffMs).toBeGreaterThanOrEqual(RESUME_WINDOW_MS - 1_000);
    expect(cutoffMs).toBeLessThan(RESUME_WINDOW_MS + 5_000);
    expect(args.data.status).toBe('failed');
    expect(args.data.error).toBe('resume window expired');
    expect(args.data.finishedAt).toBeInstanceOf(Date);
    expect(args.data.checkpoint).toBe(Prisma.DbNull);
    expect(args.data.leaseExpiresAt).toBeNull();
    expect(args.data.workerId).toBeNull();
  });
});

describe('rule (a) — orphaned running sessions', () => {
  it('delegates to the boot-time orphan sweep (no claimable run row + no Redis lock → ready)', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockSweep.mockResolvedValue(3);

    await runAgentRunReaper();
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });
});

describe('rule (c) — terminal-run event GC (legacy join select, EVENT_GC_PK_RANGE_DISABLED=1 since audit 2026-10-06 T8-8)', () => {
  beforeEach(() => { process.env.EVENT_GC_PK_RANGE_DISABLED = '1'; });
  afterEach(() => { delete process.env.EVENT_GC_PK_RANGE_DISABLED; });
  it('deletes the selected batch of agent_events (terminal runs > 30d old, capped)', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 11n }, { id: 12n }]);
    mockPrisma.agentEvent.deleteMany.mockResolvedValue({ count: 2 });

    await runAgentRunReaper();

    // The raw select joins runs, restricts to terminal statuses, and batches.
    const sql = (mockPrisma.$queryRaw.mock.calls[0][0] as readonly string[]).join('?');
    expect(sql).toContain('agent_events');
    expect(sql).toContain('agent_runs');
    expect(sql).toContain(`'completed', 'failed', 'cancelled'`);
    expect(sql).toContain('LIMIT');
    expect(mockPrisma.$queryRaw.mock.calls[0].some((v: any) => v === EVENT_GC_BATCH)).toBe(true);

    expect(mockPrisma.agentEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [11n, 12n] } },
    });
  });

  it('no qualifying events → no delete', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await runAgentRunReaper();
    expect(mockPrisma.agentEvent.deleteMany).not.toHaveBeenCalled();
  });

  // Review 2026-09-13 issue 10: one 5k batch per pass (~0.7M/day) lost to
  // 2-3M inserts/day. A pass now loops over 5k batches, bounded by rows + time.
  describe('time-bounded multi-batch loop (review 2026-09-13 issue 10)', () => {
    const fullBatch = Array.from({ length: EVENT_GC_BATCH }, (_, i) => ({ id: BigInt(i + 1) }));
    afterEach(() => jest.restoreAllMocks());

    it('keeps deleting 5k batches while the select returns FULL batches, and stops on the first short one', async () => {
      mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.$queryRaw
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce([{ id: 99n }]); // short → drained
      mockPrisma.agentEvent.deleteMany.mockImplementation(async (a: any) => ({ count: a.where.id.in.length }));

      await runAgentRunReaper();
      expect(mockPrisma.agentEvent.deleteMany).toHaveBeenCalledTimes(3);
      // Every statement stays a 5k-id delete — the LIMIT is unchanged.
      for (const call of mockPrisma.$queryRaw.mock.calls) expect(call.some((v: any) => v === EVENT_GC_BATCH)).toBe(true);
      expect(mockPrisma.agentEvent.deleteMany.mock.calls[2][0].where.id.in).toEqual([99n]);
    });

    it(`caps a pass at EVENT_GC_PASS_MAX_ROWS (${EVENT_GC_PASS_MAX_ROWS}) rows even against an endless backlog`, async () => {
      mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.$queryRaw.mockResolvedValue(fullBatch); // always full
      mockPrisma.agentEvent.deleteMany.mockResolvedValue({ count: EVENT_GC_BATCH });

      await runAgentRunReaper();
      expect(mockPrisma.agentEvent.deleteMany).toHaveBeenCalledTimes(EVENT_GC_PASS_MAX_ROWS / EVENT_GC_BATCH);
      expect(EVENT_GC_PASS_MAX_ROWS).toBe(50_000); // 10x the old single batch
    });

    it(`stops after EVENT_GC_PASS_BUDGET_MS (${EVENT_GC_PASS_BUDGET_MS}ms) of wall clock — a slow DB never holds the reaper's other rules hostage`, async () => {
      let clock = 1_800_000_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => clock);
      mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.$queryRaw.mockResolvedValue(fullBatch); // always full
      mockPrisma.agentEvent.deleteMany.mockImplementation(async () => {
        clock += EVENT_GC_PASS_BUDGET_MS + 5_000; // each batch "takes" longer than the whole budget
        return { count: EVENT_GC_BATCH };
      });
      mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ id: 'r1' }]);
      mockPrisma.runToolReceipt.deleteMany.mockResolvedValue({ count: 1 });

      await runAgentRunReaper();
      expect(mockPrisma.agentEvent.deleteMany).toHaveBeenCalledTimes(1); // first batch always runs; budget stops the second
      expect(mockPrisma.runToolReceipt.deleteMany).toHaveBeenCalledTimes(1); // rule (d) still ran after the bounded pass
    });

    it('a mid-loop batch failure ends the pass without throwing; rule (d) still runs', async () => {
      mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.$queryRaw.mockResolvedValue(fullBatch);
      mockPrisma.agentEvent.deleteMany
        .mockResolvedValueOnce({ count: EVENT_GC_BATCH })
        .mockRejectedValueOnce(new Error('deadlock'));
      mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ id: 'r1' }]);
      mockPrisma.runToolReceipt.deleteMany.mockResolvedValue({ count: 1 });

      await expect(runAgentRunReaper()).resolves.toBeUndefined();
      expect(mockPrisma.agentEvent.deleteMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.runToolReceipt.deleteMany).toHaveBeenCalledTimes(1);
    });
  });
});

// audit 2026-10-06 T8-8: the 43 s join select is replaced by a primary-key range walk.
describe('rule (c) — terminal-run event GC, PK-range walk (audit 2026-10-06 T8-8)', () => {
  const OLD = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  const NEW = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  beforeEach(() => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.agentRun.findMany = jest.fn(async () => []);
    mockPrisma.agentEvent.deleteMany.mockImplementation(async (a: any) => ({ count: a.where.id.in.length }));
  });
  afterEach(() => { delete mockPrisma.agentRun.findMany; });

  it('reads a PK range (no join, no agent_runs in the SQL), checks the batch runs by id, deletes only events of terminal runs finished before the cutoff, and stops at the first newer event', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([
      { id: 1n, runId: 'run-done', createdAt: OLD },
      { id: 2n, runId: 'run-live', createdAt: OLD },
      { id: 3n, runId: 'run-done', createdAt: OLD },
      { id: 4n, runId: 'run-new', createdAt: NEW },
    ]);
    mockPrisma.agentRun.findMany.mockResolvedValueOnce([{ id: 'run-done' }]);

    await runAgentRunReaper();

    const sql = (mockPrisma.$queryRaw.mock.calls[0][0] as readonly string[]).join('?');
    expect(sql).toContain('agent_events');
    expect(sql).not.toContain('agent_runs');
    expect(sql).not.toMatch(/JOIN/i);
    expect(sql).toContain('ORDER BY e."id"');
    expect(mockPrisma.$queryRaw.mock.calls[0].some((v: any) => v === EVENT_GC_BATCH)).toBe(true);
    expect(mockPrisma.$queryRaw.mock.calls[0][1]).toBe(0n); // the walk starts at the head of the PK
    const runQuery = mockPrisma.agentRun.findMany.mock.calls[0][0];
    expect(runQuery.where.id.in.sort()).toEqual(['run-done', 'run-live']); // only OLD events' runs are checked
    expect(runQuery.where.status.in).toEqual(['completed', 'failed', 'cancelled']);
    expect(runQuery.where.finishedAt.lt).toBeInstanceOf(Date);
    expect(mockPrisma.agentEvent.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [1n, 3n] } } });
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1); // the batch reached a newer event — the walk stopped
  });

  it('steady state (head already newer than the cutoff): one range read, no run lookup, no delete', async () => {
    mockPrisma.$queryRaw.mockResolvedValueOnce([{ id: 900n, runId: 'r', createdAt: NEW }]);
    await runAgentRunReaper();
    expect(mockPrisma.agentRun.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.agentEvent.deleteMany).not.toHaveBeenCalled();
  });

  it('a full all-old batch continues from the last id seen (the cursor advances past rows it could not delete)', async () => {
    const full = Array.from({ length: EVENT_GC_BATCH }, (_, i) => ({ id: BigInt(i + 1), runId: 'run-stuck', createdAt: OLD }));
    mockPrisma.$queryRaw
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: BigInt(EVENT_GC_BATCH + 1), runId: 'run-done', createdAt: OLD }]);
    mockPrisma.agentRun.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'run-done' }]);
    await runAgentRunReaper();
    expect(mockPrisma.$queryRaw.mock.calls[1][1]).toBe(BigInt(EVENT_GC_BATCH));
    expect(mockPrisma.agentEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agentEvent.deleteMany).toHaveBeenCalledWith({ where: { id: { in: [BigInt(EVENT_GC_BATCH + 1)] } } });
  });

  it(`a pass scans at most EVENT_GC_PASS_MAX_ROWS (${EVENT_GC_PASS_MAX_ROWS}) rows against an endless old backlog`, async () => {
    const full = Array.from({ length: EVENT_GC_BATCH }, (_, i) => ({ id: BigInt(i + 1), runId: 'run-done', createdAt: OLD }));
    mockPrisma.$queryRaw.mockResolvedValue(full);
    mockPrisma.agentRun.findMany.mockResolvedValue([{ id: 'run-done' }]);
    await runAgentRunReaper();
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(EVENT_GC_PASS_MAX_ROWS / EVENT_GC_BATCH);
  });
});

describe('rule (d) — run_tool_receipts GC', () => {
  it('deletes receipts older than 30 days, batched — createdAt-only, NO run join (runId is a soft ref; chat-run receipts carry null)', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    mockPrisma.runToolReceipt.deleteMany.mockResolvedValue({ count: 2 });

    const before = Date.now();
    await runAgentRunReaper();

    const [findArgs] = mockPrisma.runToolReceipt.findMany.mock.calls[0];
    expect(Object.keys(findArgs.where)).toEqual(['createdAt']); // no run join
    const ageMs = before - findArgs.where.createdAt.lt.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(RECEIPT_GC_AGE_MS - 1_000);
    expect(ageMs).toBeLessThan(RECEIPT_GC_AGE_MS + 5_000);
    expect(findArgs.select).toEqual({ id: true });
    expect(findArgs.orderBy).toEqual({ createdAt: 'asc' });
    expect(findArgs.take).toBe(RECEIPT_GC_BATCH);
    expect(mockPrisma.runToolReceipt.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1', 'r2'] } } });
  });

  it('no old receipts → no delete; a receipts-GC failure never throws', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
    await runAgentRunReaper();
    expect(mockPrisma.runToolReceipt.deleteMany).not.toHaveBeenCalled();

    mockPrisma.runToolReceipt.findMany.mockRejectedValue(new Error('db down'));
    await expect(runAgentRunReaper()).resolves.toBeUndefined();
  });
});

// Hardening review 2026-09-14: hook_events had NO purge anywhere (only the FK
// cascade on hook deletion, and supervisor hooks are pause-never-delete), so
// delivered/failed/skipped rows accumulated forever while the verifier's
// JSON LIKE trace and the preempt requeue seq-scanned them.
describe('rule (g) — hook_events terminal-row GC', () => {
  it('deletes TERMINAL rows older than 30 days in ONE ordered 5k batch by id (the receipts-GC shape, never one unbounded deleteMany)', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.hookEvent.findMany.mockResolvedValue([{ id: 'h1' }, { id: 'h2' }]);
    mockPrisma.hookEvent.deleteMany.mockResolvedValue({ count: 2 });

    const before = Date.now();
    await runAgentRunReaper();

    expect(mockPrisma.hookEvent.findMany).toHaveBeenCalledTimes(1);
    const [findArgs] = mockPrisma.hookEvent.findMany.mock.calls[0];
    expect(Object.keys(findArgs.where).sort()).toEqual(['createdAt', 'status']); // rides the (status, createdAt) index
    expect(findArgs.where.status).toEqual({ in: [...HOOK_EVENT_GC_TERMINAL_STATUSES] });
    const ageMs = before - findArgs.where.createdAt.lt.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(HOOK_EVENT_GC_AGE_MS - 1_000);
    expect(ageMs).toBeLessThan(HOOK_EVENT_GC_AGE_MS + 5_000);
    expect(findArgs.select).toEqual({ id: true });
    expect(findArgs.orderBy).toEqual({ createdAt: 'asc' });
    expect(findArgs.take).toBe(HOOK_EVENT_GC_BATCH);
    // The delete is by the selected ids ONLY — never a status/createdAt range delete.
    expect(mockPrisma.hookEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.hookEvent.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['h1', 'h2'] } } });
    // Observe/record: one info line carrying the count, no "more" flag on a short batch.
    const line = (logger.info as jest.Mock).mock.calls.map((c: any[]) => String(c[0])).find((s) => /hook_events/.test(s));
    expect(line).toContain('deleted 2 hook_events');
    expect(line).not.toContain('more next pass');
  });

  it('pins the retention + the status allowlist: 30 d, terminal statuses ONLY — pending/delivering are live delivery state and are never selected', () => {
    expect(HOOK_EVENT_GC_AGE_MS).toBe(30 * 24 * 3600 * 1000);
    expect(HOOK_EVENT_GC_BATCH).toBe(5_000);
    // Ticket 9df506cc F2: 'skipped:target_retired' (57154856) is terminal and GC-eligible too.
    expect([...HOOK_EVENT_GC_TERMINAL_STATUSES].sort()).toEqual(['delivered', 'failed', 'failed:horizon', 'failed:source_gone', 'failed:target_gone', 'skipped:hook_disabled', 'skipped:target_retired']);
    expect(HOOK_EVENT_GC_TERMINAL_STATUSES).not.toContain('pending');
    expect(HOOK_EVENT_GC_TERMINAL_STATUSES).not.toContain('delivering');
  });

  it('a FULL batch logs "more next pass" (the backlog drains over passes — no in-pass loop, one 5k statement per 300 s tick)', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const full = Array.from({ length: HOOK_EVENT_GC_BATCH }, (_, i) => ({ id: `h${i}` }));
    mockPrisma.hookEvent.findMany.mockResolvedValue(full);
    mockPrisma.hookEvent.deleteMany.mockResolvedValue({ count: HOOK_EVENT_GC_BATCH });

    await runAgentRunReaper();
    expect(mockPrisma.hookEvent.deleteMany).toHaveBeenCalledTimes(1);
    const line = (logger.info as jest.Mock).mock.calls.map((c: any[]) => String(c[0])).find((s) => /hook_events/.test(s));
    expect(line).toContain('more next pass');
  });

  it('no old terminal rows → no delete; a hook_events-GC failure never throws and skips nothing after it', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.hookEvent.findMany.mockResolvedValue([]);
    await runAgentRunReaper();
    expect(mockPrisma.hookEvent.deleteMany).not.toHaveBeenCalled();

    mockPrisma.hookEvent.findMany.mockRejectedValue(new Error('db down'));
    mockPrisma.chatCodingState.findMany.mockClear();
    await expect(runAgentRunReaper()).resolves.toBeUndefined();
    expect(mockPrisma.chatCodingState.findMany).toHaveBeenCalledTimes(2); // rules (e) and (h) (finished-child archive, loop #12), which run AFTER (g), still ran
    expect((logger.warn as jest.Mock).mock.calls.some((c: any[]) => /hook_events GC failed/.test(String(c[0])))).toBe(true);
  });
});

describe('best-effort isolation', () => {
  it('a failing rule never skips the others', async () => {
    mockPrisma.agentRun.updateMany.mockRejectedValue(new Error('db down'));
    mockSweep.mockRejectedValue(new Error('redis down'));
    // Rule (c)'s PK-range walk (audit 2026-10-06 T8-8): one old event of a terminal run.
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 5n, runId: 'run-5', createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) }]);
    mockPrisma.agentRun.findMany = jest.fn(async () => [{ id: 'run-5' }]);
    mockPrisma.agentEvent.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ id: 'r9' }]);
    mockPrisma.runToolReceipt.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.hookEvent.findMany.mockResolvedValue([{ id: 'h9' }]);
    mockPrisma.hookEvent.deleteMany.mockResolvedValue({ count: 1 });

    await expect(runAgentRunReaper()).resolves.toBeUndefined();
    expect(mockSweep).toHaveBeenCalledTimes(1);                        // ran despite (b) failing
    expect(mockPrisma.agentEvent.deleteMany).toHaveBeenCalledTimes(1); // ran despite (a) failing
    expect(mockPrisma.runToolReceipt.deleteMany).toHaveBeenCalledTimes(1); // (d) ran despite (b)/(a) failing
    expect(mockPrisma.hookEvent.deleteMany).toHaveBeenCalledTimes(1);      // (g) ran despite (b)/(a) failing
    delete mockPrisma.agentRun.findMany;
  });
});
