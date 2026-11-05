/**
 * Rule (h) — FINISHED child archive (autonomy loop #12, 2026-09-20): a spawned
 * child whose plan board is complete, with no enabled schedule, no live run and
 * no run for 6 h is archived PROPERLY (chat archivedAt + satellite) through
 * platform.service archiveChat. Rule (e) (7-day idle) now archives properly too.
 * Scaffolding mirrors run-reaper.child.test.ts.
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
  hookEvent: { findMany: jest.fn(async () => []), deleteMany: jest.fn(async () => ({ count: 0 })) },
  $queryRaw: jest.fn(async () => []),
  // Third review (2026-10-22): rules (e) / (h) read the lane-family-facts restore MARKER (context store).
  contextStoreEntry: { findMany: jest.fn(async () => []) },
  // Fourth review (2026-10-22): rules (e) / (h) read the restore AUDIT (lane-family-facts
  // readRestoreAuditChats: the chats' owners, then their chat.restore / chat.archive rows) — none here.
  crossModelChat: { findMany: jest.fn(async () => []) },
  activity: { findMany: jest.fn(async () => []) },
};
const restoreMarkers = new Set<string>();
// Rule (i) (loop #14) dynamically imports the snapshot hygiene sweep — keep the real
// module (and its lazy config/redis import) out of this suite.
jest.mock('./worktree-snapshot.service', () => ({ __esModule: true, sweepSnapshotHygiene: jest.fn(async () => null) }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('./coding-data.service', () => ({
  sweepOrphanedRunningSessions: jest.fn(async () => 0),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  sweepLoopMetrics: jest.fn(async () => 0),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { CHILD_SESSION_ARCHIVED: 'child_session_archived' },
}));
const mockArchiveChat: jest.Mock = jest.fn(async () => ({ archived: true }));
jest.mock('../platform/platform.service', () => ({ __esModule: true, archiveChat: (...a: any[]) => mockArchiveChat(...a) }));
const mockGetPlanStrict: jest.Mock = jest.fn(async () => null);
jest.mock('./plan.service', () => ({ __esModule: true, getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a) }));

import { runAgentRunReaper, FINISHED_CHILD_ARCHIVE_IDLE_MS, FINISHED_CHILD_SCAN_CAP, CHILD_IDLE_REAP_MS, REAPER_CASCADE_MAX_PER_PASS, REAPER_AUDIT_MEMO_MS, __resetReaperCursorsForTests } from './run-reaper';

const H = 3_600_000;
const completedRun = (hoursAgo: number) => ({ status: 'completed', finishedAt: new Date(Date.now() - hoursAgo * H), createdAt: new Date(Date.now() - (hoursAgo + 1) * H) });
const donePlan = { steps: [{ status: 'done' }, { status: 'done' }, { status: 'skipped' }] };

/**
 * Rule (e) scans first (empty here); rule (h) is the SECOND chatCodingState.findMany call. Since the C4
 * rotation (2026-10-21) rule (e)'s chat filter carries archivedAt:null too — rule (h)'s is the one WITHOUT
 * the updatedAt cutoff.
 */
const isRuleH = (args: any) => args?.where?.chat?.is?.archivedAt === null && !args?.where?.chat?.is?.updatedAt;
function candidatesForRuleH(rows: Array<{ id: string; userId: string }>) {
  mockPrisma.chatCodingState.findMany.mockImplementation(async (args: any) => (isRuleH(args) ? rows : []));
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REAPER_CANDIDATE_ROTATION_DISABLED;
  __resetReaperCursorsForTests();
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockPrisma.chatSchedule.count.mockResolvedValue(0);
  mockArchiveChat.mockResolvedValue({ archived: true });
  mockGetPlanStrict.mockResolvedValue(null);
  restoreMarkers.clear();
  for (const k of ['LANE_IDLE_RETIRE_DISABLED', 'ARCHIVE_CASCADE_DISABLED', 'TICKET_LANE_ARCHIVE_GAPS_DISABLED']) delete process.env[k];
  mockPrisma.contextStoreEntry.findMany.mockImplementation(async ({ where }: any) => (String(where?.namespacePath ?? '').includes('restored')
    ? (where.key?.in ?? []).filter((k: string) => restoreMarkers.has(k)).map((k: string) => ({ key: k, value: { at: new Date().toISOString() }, expiresAt: null }))
    : []));
});

describe('rule (h) — finished child archive', () => {
  it('a child with a COMPLETE plan, no schedule, no live run and a completed run 7 h ago is archived properly via archiveChat (userId threaded) + metric', async () => {
    candidatesForRuleH([{ id: 'child-1', userId: 'u1' }]);
    mockPrisma.agentRun.findFirst.mockImplementation(async (args: any) => (args?.where?.status ? null : completedRun(7)));
    mockGetPlanStrict.mockResolvedValue(donePlan);
    await runAgentRunReaper();
    // Third review (2026-10-22): the pass's ONE cascade budget and rule (h)'s own idle bar ride the call.
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'u1', chatId: 'child-1', archived: true, cascadeBudget: { remaining: REAPER_CASCADE_MAX_PER_PASS }, cascadeIdleMs: FINISHED_CHILD_ARCHIVE_IDLE_MS , restoreAuditCache: expect.any(Map) });
    const rows = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'child_session_archived');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 'child-1', meta: { reason: 'finished', steps: 3 } });
    expect(rows[0].meta.idleH).toBeGreaterThanOrEqual(6);
    // The candidate query: ready/error satellites of NON-archived, schedule-free children only, by id (C4 rotation), bounded.
    const q = mockPrisma.chatCodingState.findMany.mock.calls.map((c: any[]) => c[0]).find(isRuleH);
    expect(q).toMatchObject({ where: { status: { in: ['ready', 'error'] }, chat: { is: { parentChatId: { not: null }, archivedAt: null, chatSchedules: { none: { enabled: true } } } } }, orderBy: { id: 'asc' }, take: FINISHED_CHILD_SCAN_CAP });
    expect(q.where.updatedAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - FINISHED_CHILD_ARCHIVE_IDLE_MS);
    // REAPER_CANDIDATE_ROTATION_DISABLED=1: oldest first, the pre-rotation filter.
    process.env.REAPER_CANDIDATE_ROTATION_DISABLED = '1';
    mockPrisma.chatCodingState.findMany.mockClear();
    await runAgentRunReaper();
    const old = mockPrisma.chatCodingState.findMany.mock.calls.map((c: any[]) => c[0]).find(isRuleH);
    expect(old).toMatchObject({ where: { status: { in: ['ready', 'error'] }, chat: { is: { parentChatId: { not: null }, archivedAt: null } } }, orderBy: { updatedAt: 'asc' }, take: FINISHED_CHILD_SCAN_CAP });
    expect(old.where.chat.is.chatSchedules).toBeUndefined();
  });

  it('vetoes: a live run, an enabled schedule, an OPEN plan step, a run too recent, a plan-less child, a never-ran child, a failed last run', async () => {
    const cases: Array<[string, () => void]> = [
      ['live run', () => { mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? { id: 'r-live' } : completedRun(7))); mockGetPlanStrict.mockResolvedValue(donePlan); }],
      ['enabled schedule', () => { mockPrisma.chatSchedule.count.mockResolvedValue(1); mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(7))); mockGetPlanStrict.mockResolvedValue(donePlan); }],
      ['open step', () => { mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(7))); mockGetPlanStrict.mockResolvedValue({ steps: [{ status: 'done' }, { status: 'pending' }] }); }],
      ['too recent', () => { mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(2))); mockGetPlanStrict.mockResolvedValue(donePlan); }],
      ['no plan', () => { mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(7))); mockGetPlanStrict.mockResolvedValue(null); }],
      ['never ran', () => { mockPrisma.agentRun.findFirst.mockResolvedValue(null); mockGetPlanStrict.mockResolvedValue(donePlan); }],
      ['failed last run', () => { mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : { ...completedRun(7), status: 'failed' })); mockGetPlanStrict.mockResolvedValue(donePlan); }],
    ];
    for (const [label, arm] of cases) {
      jest.clearAllMocks();
      mockPrisma.chatSchedule.count.mockResolvedValue(0);
      candidatesForRuleH([{ id: `child-${label}`, userId: 'u1' }]);
      arm();
      await runAgentRunReaper();
      expect(mockArchiveChat).not.toHaveBeenCalled();
    }
  });

  it('an archiveChat error is swallowed (non-fatal, other candidates continue)', async () => {
    candidatesForRuleH([{ id: 'child-a', userId: 'u1' }, { id: 'child-b', userId: 'u1' }]);
    mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(9)));
    mockGetPlanStrict.mockResolvedValue(donePlan);
    mockArchiveChat.mockRejectedValueOnce(new Error('409 enabled schedules')).mockResolvedValueOnce({ archived: true });
    await expect(runAgentRunReaper()).resolves.toBeUndefined();
    expect(mockArchiveChat).toHaveBeenCalledTimes(2);
  });
});

describe('rule (e) — the 7-day idle reap now archives PROPERLY too', () => {
  it('an idle child goes through archiveChat (chat archivedAt + satellite), not a satellite-only flip', async () => {
    mockPrisma.chatCodingState.findMany.mockImplementation(async (args: any) => (isRuleH(args) ? [] : [{ id: 'child-idle', userId: 'u2' }]));
    await runAgentRunReaper();
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'u2', chatId: 'child-idle', archived: true, cascadeBudget: { remaining: REAPER_CASCADE_MAX_PER_PASS }, cascadeIdleMs: CHILD_IDLE_REAP_MS , restoreAuditCache: expect.any(Map) });
    expect(mockPrisma.chatCodingState.update).not.toHaveBeenCalled();
    const rows = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'child_session_archived');
    expect(rows[0]).toMatchObject({ sessionId: 'child-idle', meta: { reason: 'idle_7d', idleDays: 7 } });
  });
});

describe('third review (2026-10-22) — rules (e) and (h) honour the restore MARKER; one cascade budget per pass', () => {
  it('REPRO: a finished child the owner RESTORED (to read its result) is not re-archived by rule (h) six hours later, nor by rule (e) after 7 idle days; a sibling with no marker is', async () => {
    candidatesForRuleH([{ id: 'child-restored', userId: 'u1' }, { id: 'child-plain', userId: 'u1' }]);
    restoreMarkers.add('child-restored');
    mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(30)));
    mockGetPlanStrict.mockResolvedValue(donePlan);
    await runAgentRunReaper();
    expect(mockArchiveChat.mock.calls.map((c) => c[0].chatId)).toEqual(['child-plain']);
    // the marker read is one batched context-store read over the rule's candidates
    const markerReads = mockPrisma.contextStoreEntry.findMany.mock.calls.map((c: any[]) => c[0]).filter((a: any) => String(a.where.namespacePath).includes('restored'));
    expect(markerReads.some((a: any) => a.where.key.in.includes('child-restored') && a.where.key.in.includes('child-plain'))).toBe(true);
    // rule (e)
    jest.clearAllMocks();
    mockPrisma.chatSchedule.count.mockResolvedValue(0);
    mockPrisma.agentRun.findFirst.mockResolvedValue(null); // rule (e): no run in 7 d, nothing live
    mockPrisma.chatCodingState.findMany.mockImplementation(async (args: any) => (isRuleH(args) ? [] : [{ id: 'child-restored', userId: 'u2' }, { id: 'idle-plain', userId: 'u2' }]));
    await runAgentRunReaper();
    expect(mockArchiveChat.mock.calls.map((c) => c[0].chatId)).toEqual(['idle-plain']);
  });

  it('FAIL SAFE: a failed marker read keeps every candidate of that rule this pass', async () => {
    candidatesForRuleH([{ id: 'child-x', userId: 'u1' }]);
    mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(30)));
    mockGetPlanStrict.mockResolvedValue(donePlan);
    mockPrisma.contextStoreEntry.findMany.mockRejectedValue(new Error('db down'));
    await runAgentRunReaper();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('with every marker reader switch off (no marker is written then) the reaper reads none and archives as before; ARCHIVE_CASCADE_DISABLED=1 → the pre-cascade call shape', async () => {
    for (const k of ['LANE_IDLE_RETIRE_DISABLED', 'ARCHIVE_CASCADE_DISABLED', 'TICKET_LANE_ARCHIVE_GAPS_DISABLED']) process.env[k] = '1';
    candidatesForRuleH([{ id: 'child-old', userId: 'u1' }]);
    restoreMarkers.add('child-old'); // a stale marker from before the switches went off
    mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(30)));
    mockGetPlanStrict.mockResolvedValue(donePlan);
    await runAgentRunReaper();
    expect(mockPrisma.contextStoreEntry.findMany).not.toHaveBeenCalled();
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'u1', chatId: 'child-old', archived: true });
  });

  it('ONE cascade budget per pass: rule (e) and rule (h) archives hand archiveChat the SAME budget object', async () => {
    mockPrisma.chatCodingState.findMany.mockImplementation(async (args: any) => (isRuleH(args) ? [{ id: 'h-child', userId: 'u1' }] : [{ id: 'e-child', userId: 'u1' }]));
    // rule (e)'s 7-day re-check (createdAt gte) and the live probe find nothing; rule (h)'s last run finished 30 h ago
    mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status || a?.where?.createdAt ? null : completedRun(30)));
    mockGetPlanStrict.mockResolvedValue(donePlan);
    await runAgentRunReaper();
    const budgets = mockArchiveChat.mock.calls.map((c) => c[0].cascadeBudget);
    expect(mockArchiveChat.mock.calls.map((c) => c[0].chatId)).toEqual(['e-child', 'h-child']);
    expect(budgets[0]).toBe(budgets[1]);
  });
});

describe('fourth review (2026-10-22) — rules (e) and (h) read the restore AUDIT too (a restore made before the marker shipped)', () => {
  /** archiveChat's audit trail: an archive 30 h ago, then the owner's restore 8 h ago — no marker. */
  function auditRestored(ids: string[]) {
    mockPrisma.crossModelChat.findMany.mockImplementation(async ({ where }: any) => (where.id?.in ?? []).map((id: string) => ({ id, userId: 'u1' })));
    mockPrisma.activity.findMany.mockImplementation(async ({ where }: any) => ids
      .filter((id) => where.OR.some((o: any) => o.metadata.equals === id))
      .flatMap((id) => [
        { action: 'chat.archive', metadata: { chatId: id }, createdAt: new Date(Date.now() - 30 * H) },
        { action: 'chat.restore', metadata: { chatId: id }, createdAt: new Date(Date.now() - 8 * H) },
      ]));
  }
  afterEach(() => {
    mockPrisma.crossModelChat.findMany.mockReset().mockResolvedValue([]);
    mockPrisma.activity.findMany.mockReset().mockResolvedValue([]);
  });

  it('REPRO (h): a finished child with an audit-only restore (no marker) is kept; its sibling is archived; ONE batched audit read over the candidates that passed every other check', async () => {
    candidatesForRuleH([{ id: 'child-r', userId: 'u1' }, { id: 'child-p', userId: 'u1' }]);
    auditRestored(['child-r']);
    mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(31)));
    mockGetPlanStrict.mockResolvedValue(donePlan);
    await runAgentRunReaper();
    expect(mockArchiveChat.mock.calls.map((c) => c[0].chatId)).toEqual(['child-p']);
    const auditReads = mockPrisma.activity.findMany.mock.calls.map((c: any[]) => c[0].where.OR.map((o: any) => o.metadata.equals));
    expect(auditReads).toEqual([['child-r', 'child-p']]);
  });

  it('REPRO (e): an idle child with an audit-only restore is kept; a failed audit read keeps every candidate of the rule this pass', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue(null);
    mockPrisma.chatCodingState.findMany.mockImplementation(async (args: any) => (isRuleH(args) ? [] : [{ id: 'idle-r', userId: 'u1' }, { id: 'idle-p', userId: 'u1' }]));
    auditRestored(['idle-r']);
    await runAgentRunReaper();
    expect(mockArchiveChat.mock.calls.map((c) => c[0].chatId)).toEqual(['idle-p']);
    mockArchiveChat.mockClear();
    __resetReaperCursorsForTests();
    mockPrisma.activity.findMany.mockRejectedValue(new Error('db down'));
    await runAgentRunReaper();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('REPRO (fifth review, DB load): a child the audit KEPT is not re-read on the next passes (the reaper remembers a restored verdict for REAPER_AUDIT_MEMO_MS); one restore-audit memo per pass reaches every cascade', async () => {
    candidatesForRuleH([{ id: 'child-r', userId: 'u1' }]);
    auditRestored(['child-r']);
    mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(31)));
    mockGetPlanStrict.mockResolvedValue(donePlan);
    await runAgentRunReaper();
    await runAgentRunReaper();
    await runAgentRunReaper();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockPrisma.activity.findMany).toHaveBeenCalledTimes(1);
    // past the memo window it is read again (still restored — still kept)
    const realNow = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(realNow + REAPER_AUDIT_MEMO_MS + 60_000);
    try {
      await runAgentRunReaper();
    } finally { spy.mockRestore(); }
    expect(mockPrisma.activity.findMany).toHaveBeenCalledTimes(2);
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('with every marker reader switch off the audit is not read either (the pre-wave reaper)', async () => {
    for (const k of ['LANE_IDLE_RETIRE_DISABLED', 'ARCHIVE_CASCADE_DISABLED', 'TICKET_LANE_ARCHIVE_GAPS_DISABLED']) process.env[k] = '1';
    candidatesForRuleH([{ id: 'child-r', userId: 'u1' }]);
    auditRestored(['child-r']);
    mockPrisma.agentRun.findFirst.mockImplementation(async (a: any) => (a?.where?.status ? null : completedRun(31)));
    mockGetPlanStrict.mockResolvedValue(donePlan);
    await runAgentRunReaper();
    expect(mockPrisma.activity.findMany).not.toHaveBeenCalled();
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'u1', chatId: 'child-r', archived: true });
  });
});
