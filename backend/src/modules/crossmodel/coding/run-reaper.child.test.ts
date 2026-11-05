/**
 * Sub-session promotion (2026-09-02, piece 5) — the reaper's rule (e): a CHILD
 * coding session (chat.parentChatId set) fully idle > 7 days (no runs, no
 * messages, no enabled schedules) flips to status 'archived'. Plus the wave-1
 * WIRE-ME: runAgentRunReaper calls sweepLoopMetrics (loop-metrics GC) each pass.
 *
 * Pins:
 *   - the candidate query itself excludes non-children / active statuses /
 *     recently-touched rows (parentChatId not-null, status ready|error, both
 *     updatedAt cutoffs);
 *   - an idle child is archived; recent run / ACTIVE run / recent message /
 *     enabled schedule each veto the archive;
 *   - rule (e) is best-effort-isolated (its failure skips nothing else);
 *   - sweepLoopMetrics runs once per pass, even when rule (e) fails.
 *
 * Scaffolding mirrors run-reaper.test.ts (do not modify that file).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentRun: { updateMany: jest.fn(async () => ({ count: 0 })), findFirst: jest.fn(async () => null) },
  chatCodingState: {
    updateMany: jest.fn(async () => ({ count: 0 })),
    findMany: jest.fn(async () => []),
    update: jest.fn(async () => ({})),
  },
  agentEvent: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  crossModelMessage: { findFirst: jest.fn(async () => null) },
  chatSchedule: { count: jest.fn(async () => 0) },
  runToolReceipt: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({ count: 0 })) },
  // Rule (g) — hook_events terminal-row GC (hardening review 2026-09-14); empty here.
  hookEvent: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({ count: 0 })) },
  $queryRaw: jest.fn(async () => []),
  // Third review (2026-10-22): rules (e) / (h) read the restore marker (none here).
  contextStoreEntry: { findMany: jest.fn(async () => []) },
  // Fourth review (2026-10-22): rules (e) / (h) read the restore AUDIT (lane-family-facts
  // readRestoreAuditChats: the chats' owners, then their chat.restore / chat.archive rows) — none here.
  crossModelChat: { findMany: jest.fn(async () => []) },
  activity: { findMany: jest.fn(async () => []) },
};
// Rule (i) (loop #14) dynamically imports the snapshot hygiene sweep — keep the real
// module (and its lazy config/redis import) out of this suite.
jest.mock('./worktree-snapshot.service', () => ({ __esModule: true, sweepSnapshotHygiene: jest.fn(async () => null) }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockSweepOrphans: jest.Mock = jest.fn(async () => 0);
jest.mock('./coding-data.service', () => ({
  sweepOrphanedRunningSessions: (...a: any[]) => mockSweepOrphans(...a),
}));

// The wave-1 loop-metrics GC — mocked to pin the WIRING (the sweep itself is
// covered by loop-metrics.service.test.ts).
const mockSweepLoopMetrics: jest.Mock = jest.fn(async () => 0);
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  sweepLoopMetrics: (...a: any[]) => mockSweepLoopMetrics(...a),
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { CHILD_SESSION_ARCHIVED: 'child_session_archived' },
}));
// Loop #12: rule (e) archives PROPERLY through platform.service archiveChat
// (chat archivedAt + satellite) — mocked at the boundary (the real module's
// import chain reaches config/env → process.exit in tests).
const mockArchiveChat: jest.Mock = jest.fn(async () => ({ archived: true }));
jest.mock('../platform/platform.service', () => ({ __esModule: true, archiveChat: (...a: any[]) => mockArchiveChat(...a) }));

import { runAgentRunReaper, CHILD_IDLE_REAP_MS, CHILD_REAP_SCAN_CAP, FINISHED_CHILD_SCAN_CAP, __resetReaperCursorsForTests } from './run-reaper';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REAPER_CANDIDATE_ROTATION_DISABLED;
  __resetReaperCursorsForTests();
  mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockPrisma.chatCodingState.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockPrisma.chatCodingState.update.mockResolvedValue({});
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  mockPrisma.chatSchedule.count.mockResolvedValue(0);
  mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
  mockPrisma.$queryRaw.mockResolvedValue([]);
});

describe('rule (e) — idle child sessions are archived', () => {
  it('scans ONLY children: parentChatId set, status ready|error, both idle cutoffs, bounded (REAPER_CANDIDATE_ROTATION_DISABLED=1 — the pre-rotation query, byte-for-byte)', async () => {
    process.env.REAPER_CANDIDATE_ROTATION_DISABLED = '1';
    const before = Date.now();
    await runAgentRunReaper();
    const [args] = mockPrisma.chatCodingState.findMany.mock.calls[0];
    expect(args.where.status).toEqual({ in: ['ready', 'error'] });
    expect(args.where.chat).toEqual({
      is: { parentChatId: { not: null }, updatedAt: { lt: expect.any(Date) } },
    });
    expect(args.take).toBe(CHILD_REAP_SCAN_CAP);
    const cutoff = args.where.updatedAt.lt.getTime();
    expect(before - cutoff).toBeGreaterThanOrEqual(CHILD_IDLE_REAP_MS - 1000);
    expect(before - cutoff).toBeLessThanOrEqual(CHILD_IDLE_REAP_MS + 5000);
  });

  it('archives an idle child (no runs, no messages, no enabled schedules)', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'child-1' }]);
    await runAgentRunReaper();
    expect(mockArchiveChat).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'child-1', archived: true }));
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalledWith({
      where: { id: 'child-1' }, data: { status: 'archived' },
    });
  });

  it('a child with a RECENT run inside the window is untouched', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'child-1' }]);
    mockPrisma.agentRun.findFirst.mockImplementation(async ({ where }: any) =>
      where.createdAt ? { id: 'r-recent' } : null);
    await runAgentRunReaper();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('a child with an ACTIVE run (queued/running/interrupted) is untouched', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'child-1' }]);
    mockPrisma.agentRun.findFirst.mockImplementation(async ({ where }: any) =>
      where.status ? { id: 'r-active' } : null);
    await runAgentRunReaper();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('a child with a recent MESSAGE is untouched', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'child-1' }]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'm1' });
    await runAgentRunReaper();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('a child with an ENABLED schedule is untouched', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'child-1' }]);
    mockPrisma.chatSchedule.count.mockResolvedValue(1);
    await runAgentRunReaper();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockPrisma.chatSchedule.count).toHaveBeenCalledWith({
      where: { sessionId: 'child-1', enabled: true },
    });
  });

  it('mixed batch: archives only the fully idle child', async () => {
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'busy-child' }, { id: 'idle-child' }]);
    mockPrisma.chatSchedule.count.mockImplementation(async ({ where }: any) =>
      where.sessionId === 'busy-child' ? 2 : 0);
    await runAgentRunReaper();
    expect(mockArchiveChat).toHaveBeenCalledTimes(1);
    expect(mockArchiveChat).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'idle-child', archived: true }));
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalledWith({
      where: { id: 'idle-child' }, data: { status: 'archived' },
    });
  });

  it('a rule-(e) failure never skips the loop-metrics sweep (best-effort isolation)', async () => {
    mockPrisma.chatCodingState.findMany.mockRejectedValue(new Error('db down'));
    await expect(runAgentRunReaper()).resolves.toBeUndefined();
    expect(mockSweepLoopMetrics).toHaveBeenCalledTimes(1);
  });
});

describe('REAPER CANDIDATE ROTATION (lane lifecycle C4, 2026-10-21)', () => {
  /** Rule (e)'s page is the call whose chat filter carries the updatedAt cutoff; rule (h)'s has none. */
  const isRuleE = (a: any) => !!a?.where?.chat?.is?.updatedAt;
  const pageArgs = (pred: (a: any) => boolean) => mockPrisma.chatCodingState.findMany.mock.calls.map((c: any[]) => c[0]).filter(pred);

  it('rule (e)/(h) pages skip archived chats and chats with an enabled schedule at the query, ordered by id', async () => {
    await runAgentRunReaper();
    const [e] = pageArgs(isRuleE);
    expect(e.where.chat).toEqual({ is: { parentChatId: { not: null }, updatedAt: { lt: expect.any(Date) }, archivedAt: null, chatSchedules: { none: { enabled: true } } } });
    expect(e.orderBy).toEqual({ id: 'asc' });
    expect(e.where.id).toBeUndefined();
    const [h] = pageArgs((a) => a?.where?.chat?.is?.archivedAt === null && !isRuleE(a));
    expect(h.where.chat).toEqual({ is: { parentChatId: { not: null }, archivedAt: null, chatSchedules: { none: { enabled: true } } } });
    expect(h.orderBy).toEqual({ id: 'asc' });
  });

  it('ineligible rows cannot starve: a FULL page moves the cursor past its last id, a short page wraps — every candidate is visited within ceil(N / cap) passes', async () => {
    const N = CHILD_REAP_SCAN_CAP * 2 + 7;
    const all = Array.from({ length: N }, (_, i) => ({ id: `c-${String(i).padStart(4, '0')}`, userId: 'u1' }));
    // a model of the DB: rule (e) returns the cursor-filtered, id-ordered page; every candidate has a recent run (ineligible)
    mockPrisma.chatCodingState.findMany.mockImplementation(async (a: any) => {
      if (!isRuleE(a)) return [];
      const after = a.where.id?.gt;
      return all.filter((r) => !after || r.id > after).slice(0, a.take);
    });
    mockPrisma.agentRun.findFirst.mockImplementation(async ({ where }: any) => (where.createdAt ? { id: 'recent' } : null));
    const visited = new Set<string>();
    const cursors: Array<string | undefined> = [];
    const passes = Math.ceil(N / CHILD_REAP_SCAN_CAP);
    for (let i = 0; i < passes; i++) {
      mockPrisma.agentRun.findFirst.mockClear();
      await runAgentRunReaper();
      const e = pageArgs(isRuleE).pop();
      cursors.push(e.where.id?.gt);
      for (const call of mockPrisma.agentRun.findFirst.mock.calls) if (call[0].where.createdAt) visited.add(call[0].where.sessionId);
      mockPrisma.chatCodingState.findMany.mock.calls.length = 0;
    }
    expect(visited.size).toBe(N);
    expect(cursors).toEqual([undefined, `c-${String(CHILD_REAP_SCAN_CAP - 1).padStart(4, '0')}`, `c-${String(2 * CHILD_REAP_SCAN_CAP - 1).padStart(4, '0')}`]);
    // the third page was short ⇒ the next pass starts over
    await runAgentRunReaper();
    expect(pageArgs(isRuleE).pop().where.id).toBeUndefined();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('rule (h) rotates the same way (its own cursor); under the switch both rules keep the old queries', async () => {
    const H = Array.from({ length: FINISHED_CHILD_SCAN_CAP }, (_, i) => ({ id: `h-${String(i).padStart(4, '0')}`, userId: 'u1' }));
    mockPrisma.chatCodingState.findMany.mockImplementation(async (a: any) => (isRuleE(a) ? [] : H.filter((r) => !a.where.id?.gt || r.id > a.where.id.gt).slice(0, a.take)));
    await runAgentRunReaper();
    await runAgentRunReaper();
    const hs = pageArgs((a) => !isRuleE(a));
    expect(hs[0].where.id).toBeUndefined();
    expect(hs[1].where.id).toEqual({ gt: H[H.length - 1].id });
    process.env.REAPER_CANDIDATE_ROTATION_DISABLED = '1';
    mockPrisma.chatCodingState.findMany.mockClear();
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    await runAgentRunReaper();
    const [oldE, oldH] = mockPrisma.chatCodingState.findMany.mock.calls.map((c: any[]) => c[0]);
    expect(oldE.where.chat).toEqual({ is: { parentChatId: { not: null }, updatedAt: { lt: expect.any(Date) } } });
    expect(oldE.orderBy).toBeUndefined();
    expect(oldH.where.chat).toEqual({ is: { parentChatId: { not: null }, archivedAt: null } });
    expect(oldH.orderBy).toEqual({ updatedAt: 'asc' });
    expect(oldH.where.id).toBeUndefined();
  });
});

describe('rule (f) — sweepLoopMetrics is wired (wave-1 WIRE-ME)', () => {
  it('runs exactly once per reaper pass', async () => {
    await runAgentRunReaper();
    expect(mockSweepLoopMetrics).toHaveBeenCalledTimes(1);
  });
});
