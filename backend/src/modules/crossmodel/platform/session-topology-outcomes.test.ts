/**
 * session-topology-outcomes pins (SESSION_TITLES_TOPOLOGY design §B labels).
 * Pure: judgeTopologyOutcome per verdict. Cron (mocked prisma): rows older
 * than 24 h are labelled once (dedupe on decisionKey), a spawn is judged on
 * TTFR ≤ 10 min + not one-run-no-PR + no duplicate, reuse on the target's
 * receipt, retire waits 72 h, a gate stash also writes recordDecisionOutcome,
 * kill switches silence the pass, and the R6 scan writes one observe-only row
 * per candidate per 24 h. Never throws. LANE-IDLE-RETIRE (2026-10-21): the scan
 * then hands a non-partial index's candidates to lane-retire (which archives a
 * PROVEN machine-spawned lane idle ≥ 7 d), discovery widens to 100 projects /
 * 180 d newest-first, and LANE_IDLE_RETIRE_DISABLED=1 restores the
 * observe-only scan byte-for-byte (the original pins run under it).
 */
const mockPrisma: any = {
  loopMetric: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  crossModelChat: { count: jest.fn(async () => 0), findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  runToolReceipt: { findFirst: jest.fn(async () => null), count: jest.fn(async () => 0), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  agentRun: { count: jest.fn(async () => 0), groupBy: jest.fn(async () => []), findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelMessage: { count: jest.fn(async () => 0), groupBy: jest.fn(async () => []), findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  codingSchedule: { count: jest.fn(async () => 0), groupBy: jest.fn(async () => []), findMany: jest.fn(async () => []) },
  chatCodingState: { findMany: jest.fn(async () => []) },
  projectTodo: { findMany: jest.fn(async () => []) },
  projectGoal: { findMany: jest.fn(async () => []) },
  // lane-retire's fresh facts + proofs (LANE-IDLE-RETIRE 2026-10-21)
  chatShareLink: { findMany: jest.fn(async () => []) },
  userFeatureRequest: { findMany: jest.fn(async () => []) },
  delegationTask: { findMany: jest.fn(async () => []) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  // review fixer (2026-10-21): owner-parked lanes + the restore marker (the context store)
  ownerQuestion: { findMany: jest.fn(async () => []) },
  pendingConfirmation: { findMany: jest.fn(async () => []) },
  contextStoreEntry: { findMany: jest.fn(async () => []) },
  // second review fixer (2026-10-21): inbound integrations + the restore audit
  chatWebhook: { findMany: jest.fn(async () => []) },
  eventHook: { findMany: jest.fn(async () => []) },
  activity: { findMany: jest.fn(async () => []) },
};
const mockRecordLoopMetric = jest.fn();
const mockRecordDecisionOutcome = jest.fn();
const mockArchiveChat = jest.fn((..._a: any[]): Promise<any> => Promise.resolve({ id: 'x', archived: true }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), LOOP_METRIC_KINDS: { SESSION_TOPOLOGY: 'session_topology', SESSION_TOPOLOGY_OUTCOME: 'session_topology_outcome', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', CONTEXT_COMPACTION: 'context_compaction', LANE_RETIRED: 'lane_retired' } }));
jest.mock('./decision-gate', () => ({
  __esModule: true,
  recordDecisionOutcome: (...a: any[]) => mockRecordDecisionOutcome(...a),
  reconstructDecision: (s: any) => (s && s.id ? { ...s, ms: 0 } : null),
  decide: jest.fn(), decisionMode: jest.fn(() => 'shadow'), decisionThreshold: (_p: string, f: number) => f, stashDecision: jest.fn(),
}));
jest.mock('./platform.service', () => ({ __esModule: true, archiveChat: (...a: any[]) => mockArchiveChat(...a) }));
jest.mock('../coding/plan.service', () => ({ __esModule: true, getPlan: jest.fn(async () => null) }));
// The acting scan's hand-off: a pass-through spy over the REAL lane-retire (so the wiring and the archive path are both pinned).
const mockRetireIdleLanes = jest.fn((..._a: any[]): Promise<any> => Promise.resolve({ considered: 0, archived: 0, skipped: {} }));
jest.mock('./lane-retire', () => ({ __esModule: true, ...jest.requireActual('./lane-retire'), retireIdleLanes: (...a: any[]) => mockRetireIdleLanes(...a) }));

import { judgeTopologyOutcome, runSessionTopologyOutcomesOnce, runSessionTopologyRetireScanOnce, SPAWN_TTFR_MAX_SEC } from './session-topology-outcomes';
const realLaneRetire = jest.requireActual('./lane-retire');

const NOW = new Date('2026-09-27T15:00:00Z');
const H = 3600_000;
const facts = (o: Partial<Parameters<typeof judgeTopologyOutcome>[1]> = {}) => ({ ttfrSec: null, runs: 0, hasPr: false, oneRunNoPr: null, duplicateSpawned24h: false, targetReceiptInWindow: null, reactivatedAfterRetire: null, scheduleArmed: null, ...o });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SESSION_TOPOLOGY_DISABLED;
  delete process.env.LANE_IDLE_RETIRE_DISABLED;
  realLaneRetire.__resetLaneRetireCursorForTests();
  mockRetireIdleLanes.mockImplementation((...a: any[]) => realLaneRetire.retireIdleLanes(...a));
  for (const m of Object.values(mockPrisma) as any[]) for (const f of Object.values(m) as any[]) f.mockReset?.();
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
  mockPrisma.loopMetric.groupBy.mockResolvedValue([]);
  mockPrisma.crossModelChat.count.mockResolvedValue(0);
  mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
  mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
  mockPrisma.runToolReceipt.findFirst.mockResolvedValue(null);
  mockPrisma.runToolReceipt.count.mockResolvedValue(0);
  mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.count.mockResolvedValue(0);
  mockPrisma.agentRun.groupBy.mockResolvedValue([]);
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelMessage.count.mockResolvedValue(0);
  mockPrisma.codingSchedule.count.mockResolvedValue(0);
  mockPrisma.codingSchedule.groupBy.mockResolvedValue([]);
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.projectGoal.findMany.mockResolvedValue([]);
  mockPrisma.runToolReceipt.groupBy.mockResolvedValue([]);
  mockPrisma.crossModelMessage.groupBy.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  mockPrisma.chatShareLink.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  mockPrisma.delegationTask.findMany.mockResolvedValue([]);
  mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
  mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
  mockPrisma.pendingConfirmation.findMany.mockResolvedValue([]);
  mockPrisma.contextStoreEntry.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.groupBy.mockResolvedValue([]);
  mockPrisma.chatWebhook.findMany.mockResolvedValue([]);
  mockPrisma.eventHook.findMany.mockResolvedValue([]);
  mockPrisma.activity.findMany.mockResolvedValue([]);
  realLaneRetire.__resetLaneRetireScanCursorsForTests();
});

describe('judgeTopologyOutcome (pure)', () => {
  it('spawn (fixer 2026-09-27, pure label): a duplicate owner ⇒ wrong/"reuse"; TTFR ≤ 10 min and not one-run-no-PR ⇒ correct; slow / one-run ⇒ wrong with actual UNKNOWN (null)', () => {
    expect(judgeTopologyOutcome('spawn', facts({ ttfrSec: 120, oneRunNoPr: false }))).toEqual({ correct: true, actual: 'spawn' });
    // a fast first receipt with the one-run window still open is good evidence of a right placement
    expect(judgeTopologyOutcome('spawn', facts({ ttfrSec: 120, oneRunNoPr: null }))).toEqual({ correct: true, actual: 'spawn' });
    expect(judgeTopologyOutcome('spawn', facts({ ttfrSec: SPAWN_TTFR_MAX_SEC + 1, oneRunNoPr: false }))).toEqual({ correct: false, actual: null });
    expect(judgeTopologyOutcome('spawn', facts({ ttfrSec: 120, oneRunNoPr: false, duplicateSpawned24h: true }))).toEqual({ correct: false, actual: 'reuse' });
    expect(judgeTopologyOutcome('spawn', facts({ duplicateSpawned24h: true }))).toEqual({ correct: false, actual: 'reuse' });
    expect(judgeTopologyOutcome('spawn', facts({ ttfrSec: 120, oneRunNoPr: true }))).toEqual({ correct: false, actual: null });
    expect(judgeTopologyOutcome('spawn', facts())).toEqual({ correct: null, actual: null });
  });
  it('reuse / merge: correct iff the target minted a receipt in the window and no duplicate appeared; retire: no message for 72 h', () => {
    expect(judgeTopologyOutcome('reuse', facts({ targetReceiptInWindow: true }))).toEqual({ correct: true, actual: 'reuse' });
    expect(judgeTopologyOutcome('merge', facts({ targetReceiptInWindow: false }))).toEqual({ correct: false, actual: 'spawn' });
    expect(judgeTopologyOutcome('reuse', facts({ targetReceiptInWindow: true, duplicateSpawned24h: true }))).toEqual({ correct: false, actual: 'spawn' });
    expect(judgeTopologyOutcome('reuse', facts())).toEqual({ correct: null, actual: null });
    expect(judgeTopologyOutcome('retire', facts({ reactivatedAfterRetire: false }))).toEqual({ correct: true, actual: 'retire' });
    expect(judgeTopologyOutcome('retire', facts({ reactivatedAfterRetire: true }))).toEqual({ correct: false, actual: 'reuse' });
  });
  it('schedule (fixer 2026-09-27, labelled): spawn proceeded ⇒ correct iff the lane did no PR-class work; refused ⇒ correct iff a schedule was armed and no lane was spawned for the same goal text', () => {
    expect(judgeTopologyOutcome('schedule', facts({ spawnedLanePr: false }))).toEqual({ correct: true, actual: 'schedule' });
    expect(judgeTopologyOutcome('schedule', facts({ spawnedLanePr: true, scheduleArmed: true }))).toEqual({ correct: false, actual: 'spawn' });
    expect(judgeTopologyOutcome('schedule', facts({ scheduleArmed: true, watchLaneSpawned24h: false }))).toEqual({ correct: true, actual: 'schedule' });
    expect(judgeTopologyOutcome('schedule', facts({ scheduleArmed: true, watchLaneSpawned24h: true }))).toEqual({ correct: false, actual: 'spawn' });
    expect(judgeTopologyOutcome('schedule', facts({ scheduleArmed: false }))).toEqual({ correct: false, actual: 'spawn' });
    expect(judgeTopologyOutcome('schedule', facts())).toEqual({ correct: null, actual: null });
  });
});

describe('runSessionTopologyOutcomesOnce', () => {
  const decidedAt = new Date(NOW.getTime() - 30 * H);
  const row = (id: string, meta: Record<string, unknown>) => ({ id, sessionId: 'sup-1', meta, createdAt: decidedAt });

  const stash = { id: 'dec-1', purpose: 'session_topology', mode: 'shadow', backend: 'jev', answers: { placement: { type: 'choice', choice: 'spawn', probabilities: {}, confidence: 0.9 } } };

  it('labels a spawn row from the spawned lane (TTFR from the FIRST RUN START, runs, PR, duplicate) — one outcome row + a gate outcome when a stash rode the decision; already-labelled rows are skipped', async () => {
    mockPrisma.loopMetric.findMany
      .mockResolvedValueOnce([row('m1', { verdict: 'spawn', rule: 'R7', source: 'gate', goalId: 'goal-1', projectId: 'proj-1', spawnedChatId: 'child-1', stash }), row('m2', { verdict: 'spawn', rule: 'R2' })])
      .mockResolvedValueOnce([{ meta: { decisionKey: 'm2' } }]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ createdAt: decidedAt });
    // the lane was provisioned at decidedAt but its first run started 5 min later — TTFR counts from the run start (fixer 2026-09-27)
    mockPrisma.agentRun.findFirst.mockResolvedValue({ startedAt: new Date(decidedAt.getTime() + 300_000), createdAt: decidedAt });
    mockPrisma.runToolReceipt.findFirst.mockResolvedValue({ createdAt: new Date(decidedAt.getTime() + 300_000 + 120_000) });
    mockPrisma.agentRun.count.mockResolvedValue(3);
    mockPrisma.runToolReceipt.count.mockResolvedValue(1);
    mockPrisma.crossModelChat.count.mockResolvedValue(0);
    const summary = await runSessionTopologyOutcomesOnce(NOW);
    expect(summary).toMatch(/1 labelled \(1 gate rows\), 0 deferred of 2 candidates/);
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session_topology_outcome', meta: expect.objectContaining({ decisionKey: 'm1', verdict: 'spawn', ttfrSec: 120, runs: 3, hasPr: true, oneRunNoPr: false, duplicateSpawned24h: false, correct: true, actual: 'spawn' }) }));
    expect(mockRecordDecisionOutcome).toHaveBeenCalledWith(expect.objectContaining({ id: 'dec-1' }), 'session_topology', expect.objectContaining({ question: 'placement', actual: 'spawn', acted: true }));
    // the receipt search starts at the run start, not chat creation
    expect(mockPrisma.runToolReceipt.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ chatId: 'child-1', createdAt: { gte: new Date(decidedAt.getTime() + 300_000) } }) }));
  });

  it('fixer 2026-09-27: a single mid-work run (no PR, < 48 h) DEFERS the spawn row; at ≥ 48 h one-run-no-PR is wrong with actual UNKNOWN and NO gate outcome; a duplicate owner labels "reuse" at once', async () => {
    // 30 h old, one run, no PR ⇒ deferred
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([row('m5', { verdict: 'spawn', rule: 'R2', spawnedChatId: 'child-5', stash })]).mockResolvedValueOnce([]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ createdAt: decidedAt });
    mockPrisma.agentRun.count.mockResolvedValue(1);
    expect(await runSessionTopologyOutcomesOnce(NOW)).toMatch(/0 labelled \(0 gate rows\), 1 deferred/);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    // 80 h old, one run, no PR ⇒ measured wrong, actual null, the gate learns nothing
    const old = new Date(NOW.getTime() - 80 * H);
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([{ id: 'm6', sessionId: 'sup-1', meta: { verdict: 'spawn', rule: 'R2', spawnedChatId: 'child-6', stash }, createdAt: old }]).mockResolvedValueOnce([]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ createdAt: old });
    expect(await runSessionTopologyOutcomesOnce(NOW)).toMatch(/1 labelled \(0 gate rows\)/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ decisionKey: 'm6', oneRunNoPr: true, correct: false, actual: null }) }));
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
    // a duplicate lane for the goal inside 24 h ⇒ "reuse" even while the run is young
    jest.clearAllMocks();
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([row('m7', { verdict: 'spawn', rule: 'R2', goalId: 'goal-1', projectId: 'proj-1', spawnedChatId: 'child-7', stash })]).mockResolvedValueOnce([]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ createdAt: decidedAt });
    mockPrisma.crossModelChat.count.mockResolvedValue(1);
    expect(await runSessionTopologyOutcomesOnce(NOW)).toMatch(/1 labelled \(1 gate rows\)/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ decisionKey: 'm7', duplicateSpawned24h: true, correct: false, actual: 'reuse' }) }));
    expect(mockRecordDecisionOutcome).toHaveBeenCalledWith(expect.objectContaining({ id: 'dec-1' }), 'session_topology', expect.objectContaining({ actual: 'reuse' }));
  });

  it('fixer 2026-09-27: schedule rows are labelled — observe-only spawn judged by the lane\'s PR work; a refused watch by the armed schedule + no re-spawn for the same goal text', async () => {
    // observe-only: the spawn proceeded and opened a PR ⇒ it was real work, "spawn"
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([row('s1', { verdict: 'schedule', rule: 'R4', spawnedChatId: 'child-w', callerChatId: 'sup-1', projectId: 'proj-1', goalText: 'Bounty submission status' })]).mockResolvedValueOnce([]);
    mockPrisma.runToolReceipt.count.mockResolvedValue(1);
    await runSessionTopologyOutcomesOnce(NOW);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ decisionKey: 's1', spawnedLanePr: true, correct: false, actual: 'spawn' }) }));
    // refused: a schedule was armed but the caller spawned a lane titled like the watch anyway ⇒ "spawn"
    jest.clearAllMocks();
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([row('s2', { verdict: 'schedule', rule: 'R4', refused: true, callerChatId: 'sup-1', projectId: 'proj-1', goalText: 'Bounty submission status' })]).mockResolvedValueOnce([]);
    mockPrisma.codingSchedule.count.mockResolvedValue(1);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ title: 'Bounty submission status check' }]);
    await runSessionTopologyOutcomesOnce(NOW);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ decisionKey: 's2', scheduleArmed: true, watchLaneSpawned24h: true, correct: false, actual: 'spawn' }) }));
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ projectId: 'proj-1', parentChatId: 'sup-1' }) }));
    // refused, schedule armed, no re-spawn ⇒ correct
    jest.clearAllMocks();
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([row('s3', { verdict: 'schedule', rule: 'R4', refused: true, callerChatId: 'sup-1', projectId: 'proj-1', goalText: 'Bounty submission status' })]).mockResolvedValueOnce([]);
    mockPrisma.codingSchedule.count.mockResolvedValue(1);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ title: 'Rewrite the Telegram webhook retry queue' }]);
    await runSessionTopologyOutcomesOnce(NOW);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ decisionKey: 's3', scheduleArmed: true, watchLaneSpawned24h: false, correct: true, actual: 'schedule' }) }));
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
  });

  it('reuse: the target lane\'s first receipt inside 24 h; a duplicate lane for the goal flips it wrong; retire is deferred until 72 h have passed', async () => {
    mockPrisma.loopMetric.findMany
      .mockResolvedValueOnce([row('m1', { verdict: 'reuse', rule: 'R1', targetChatId: 'lane-1', goalId: 'goal-1', projectId: 'proj-1' }), row('m3', { verdict: 'retire', rule: 'R6', targetChatId: 'lane-9' })])
      .mockResolvedValueOnce([]);
    mockPrisma.runToolReceipt.findFirst.mockResolvedValue({ createdAt: new Date(decidedAt.getTime() + 5 * H) });
    mockPrisma.crossModelChat.count.mockResolvedValue(1);
    const summary = await runSessionTopologyOutcomesOnce(NOW);
    expect(summary).toMatch(/1 labelled \(0 gate rows\), 1 deferred/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ verdict: 'reuse', targetReceiptInWindow: true, duplicateSpawned24h: true, correct: false, actual: 'spawn' }) }));
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
  });

  it('retire after 72 h: a message on the lane = reactivated (wrong); kill switches silence the pass; a thrown read never throws', async () => {
    const old = new Date(NOW.getTime() - 80 * H);
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([{ id: 'm9', sessionId: null, meta: { verdict: 'retire', rule: 'R6', targetChatId: 'lane-9' }, createdAt: old }]).mockResolvedValueOnce([]);
    mockPrisma.crossModelMessage.count.mockResolvedValue(2);
    await runSessionTopologyOutcomesOnce(NOW);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ verdict: 'retire', reactivatedAfterRetire: true, correct: false, actual: 'reuse' }) }));
    process.env.SESSION_TOPOLOGY_DISABLED = '1';
    expect(await runSessionTopologyOutcomesOnce(NOW)).toBe('disabled');
    delete process.env.SESSION_TOPOLOGY_DISABLED;
    mockPrisma.loopMetric.findMany.mockRejectedValue(new Error('db'));
    expect(await runSessionTopologyOutcomesOnce(NOW)).toMatch(/pass failed \(non-fatal\)/);
  });
});

describe('runSessionTopologyRetireScanOnce (R6, observe-only — LANE_IDLE_RETIRE_DISABLED=1, byte-for-byte)', () => {
  beforeEach(() => { process.env.LANE_IDLE_RETIRE_DISABLED = '1'; });
  it('writes one session_topology R6 row per candidate per 24 h; never archives', async () => {
    mockPrisma.crossModelChat.findMany
      .mockResolvedValueOnce([{ projectId: 'proj-1', userId: 'u1' }]) // the recent-projects scan
      .mockResolvedValueOnce([ // buildLaneIndex chats
        { id: 'lane-old00000', title: 'Stale lane', charterGoalId: null, charterTodoId: null, createdAt: new Date(NOW.getTime() - 5 * 86400_000), parentChatId: null, isSupervisor: false, isProjectSupervisor: false },
        { id: 'lane-seen00000', title: 'Seen lane', charterGoalId: null, charterTodoId: null, createdAt: new Date(NOW.getTime() - 5 * 86400_000), parentChatId: null, isSupervisor: false, isProjectSupervisor: false },
      ]);
    mockPrisma.loopMetric.findMany.mockResolvedValue([{ meta: { rule: 'R6', targetChatId: 'lane-seen00000' } }]);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ chatId: 'lane-old00000', createdAt: new Date(NOW.getTime() - 8 * H) }, { chatId: 'lane-seen00000', createdAt: new Date(NOW.getTime() - 8 * H) }]);
    // fixer 2026-09-27: only chats WITH a coding state are lanes (a plain chat is never a retire candidate)
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'lane-old00000', branch: 'digby/a', status: 'ready' }, { id: 'lane-seen00000', branch: 'digby/b', status: 'ready' }]);
    const summary = await runSessionTopologyRetireScanOnce(NOW);
    expect(summary).toBe('retire scan: 1 candidate(s) (observe-only) over 1 project(s)');
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session_topology', sessionId: 'lane-old00000', meta: expect.objectContaining({ site: 'scan', rule: 'R6', verdict: 'retire', targetChatId: 'lane-old00000', enforced: false }) }));
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockRetireIdleLanes).not.toHaveBeenCalled();
    // the discovery query is today's: 30 d, unordered, 50 projects
    expect(mockPrisma.crossModelChat.findMany.mock.calls[0][0]).toEqual({
      where: { archivedAt: null, projectId: { not: null }, codingState: { isNot: null }, updatedAt: { gte: new Date(NOW.getTime() - 30 * 86400_000) } },
      select: { projectId: true, userId: true }, distinct: ['projectId'], take: 50,
    });
  });

  it('the stamp-keyed predicate: a lane whose charter todo is DONE is still never a candidate under the switch', async () => {
    mockPrisma.crossModelChat.findMany
      .mockResolvedValueOnce([{ projectId: 'proj-1', userId: 'u1' }])
      .mockResolvedValueOnce([{ id: 'lane-done0000', title: 'Done charter', charterGoalId: null, charterTodoId: 'todo-done', createdAt: new Date(NOW.getTime() - 5 * 86400_000), parentChatId: null, isSupervisor: false, isProjectSupervisor: false, titlePinned: false }]);
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'lane-done0000', branch: 'digby/a', status: 'ready' }]);
    mockPrisma.projectTodo.findMany.mockImplementation(async (a: any) => (a?.where?.id ? [{ id: 'todo-done', status: 'done', assigneeChatId: 'lane-done0000' }] : []));
    expect(await runSessionTopologyRetireScanOnce(NOW)).toBe('retire scan: 0 candidate(s) (observe-only) over 1 project(s)');
  });

  it('fixer 2026-09-27: an owner\'s plain project chat (no coding state) is never an R6 candidate', async () => {
    mockPrisma.crossModelChat.findMany
      .mockResolvedValueOnce([{ projectId: 'proj-1', userId: 'u1' }])
      .mockResolvedValueOnce([{ id: 'chat-plain0000', title: 'Notes with Digby', charterGoalId: null, charterTodoId: null, createdAt: new Date(NOW.getTime() - 5 * 86400_000), parentChatId: null, isSupervisor: false, isProjectSupervisor: false }]);
    mockPrisma.loopMetric.findMany.mockResolvedValue([]);
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    expect(await runSessionTopologyRetireScanOnce(NOW)).toBe('retire scan: 0 candidate(s) (observe-only) over 1 project(s)');
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});

describe('runSessionTopologyRetireScanOnce — LANE-IDLE-RETIRE acts (default ON)', () => {
  const OLD = new Date(NOW.getTime() - 20 * 86400_000);
  /** One project, one idle ticket lane (charter todo DONE), a real fresh read, a p2 proof. */
  function seedIdleTicketLane(opts: { partial?: boolean } = {}) {
    const chat = { id: 'lane-tkt00000', title: 'ticket 4a8fcbde: fix', charterGoalId: null, charterTodoId: 'todo-done', createdAt: OLD, parentChatId: null, isSupervisor: false, isProjectSupervisor: false, titlePinned: false };
    mockPrisma.crossModelChat.findMany.mockImplementation(async (a: any) => {
      if (a?.distinct) return [{ projectId: 'proj-1', userId: 'u1' }];           // discovery
      if (a?.where?.projectId) return [chat];                                    // buildLaneIndex
      if (a?.where?.id?.in) return [{ ...chat, userId: 'u1', projectId: 'proj-1', archivedAt: null }]; // facts / p3
      return [];
    });
    // the acting discovery (second review fixer: a groupBy with a real LIMIT)
    mockPrisma.crossModelChat.groupBy.mockResolvedValue([{ projectId: 'proj-1', userId: 'u1', _max: { updatedAt: OLD } }]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ archivedAt: null, userId: 'u1' });
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: chat.id, branch: 'digby/t', status: 'ready' }]);
    mockPrisma.projectTodo.findMany.mockImplementation(async (a: any) => (a?.where?.id ? [{ id: 'todo-done', status: 'done', assigneeChatId: chat.id }] : []));
    if (opts.partial) {
      mockPrisma.runToolReceipt.findMany.mockRejectedValue(new Error('receipts leg down'));
      mockPrisma.runToolReceipt.groupBy.mockRejectedValue(new Error('receipts leg down'));
    } else {
      mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ chatId: chat.id, createdAt: new Date(NOW.getTime() - 9 * 86400_000) }]);
      // the scan page's receipt leg is a groupBy MAX (second review fixer); so is lane-retire's receipt leg
      mockPrisma.runToolReceipt.groupBy.mockResolvedValue([{ chatId: chat.id, _max: { createdAt: new Date(NOW.getTime() - 9 * 86400_000) } }]);
    }
    mockPrisma.agentRun.groupBy.mockImplementation(async (a: any) => (a?._max ? [{ sessionId: chat.id, _max: { updatedAt: new Date(NOW.getTime() - 9 * 86400_000) } }] : []));
    mockPrisma.userFeatureRequest.findMany.mockImplementation(async (a: any) => (a?.where?.status ? [] : [{ context: { dispatchedTo: chat.id, dispatchMode: 'ticket_lane' } }]));
    return chat;
  }

  it('archives a proven idle lane through archiveChat (source lane_retire) after writing the R6 row; the summary appends ", archived N"; discovery = 180 d, newest first, 100 projects', async () => {
    const chat = seedIdleTicketLane();
    const summary = await runSessionTopologyRetireScanOnce(NOW);
    expect(summary).toBe('retire scan: 1 candidate(s) (observe-only) over 1 project(s), archived 1');
    expect(mockArchiveChat).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', chatId: chat.id, source: 'lane_retire' }));
    const kinds = mockRecordLoopMetric.mock.calls.map((c) => [c[0].kind, c[0].meta?.phase ?? c[0].meta?.rule]);
    expect(kinds).toEqual([['session_topology', 'R6'], ['lane_retired', 'archived'], ['lane_retired', 'pass']]);
    expect(mockRecordLoopMetric.mock.calls[1][0]).toMatchObject({ sessionId: chat.id, meta: { phase: 'archived', proof: 'p2:dispatched_to', idleDays: 9, projectId: 'proj-1', parentChatId: null } });
    // REPRO (second review, finding 9): discovery is a groupBy with a real LIMIT — never an in-memory `distinct`
    expect(mockPrisma.crossModelChat.findMany.mock.calls.some((c: any[]) => c[0]?.distinct)).toBe(false);
    expect(mockPrisma.crossModelChat.groupBy).toHaveBeenCalledWith({
      by: ['projectId', 'userId'],
      where: { archivedAt: null, projectId: { not: null }, codingState: { isNot: null }, updatedAt: { gte: new Date(NOW.getTime() - 180 * 86400_000) } },
      _max: { updatedAt: true }, orderBy: { _max: { updatedAt: 'desc' } }, take: 100,
    });
    // …and the scan page's receipt leg is a groupBy MAX (the placement index keeps its distinct read)
    const receiptGroups = mockPrisma.runToolReceipt.groupBy.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a?.where?.ok === true);
    expect(receiptGroups).toHaveLength(1);
    expect(receiptGroups[0]).toMatchObject({ by: ['chatId'], _max: { createdAt: true } });
  });

  it('a candidate already seen in 24 h gets no second R6 row but is still evaluated; a PARTIAL index never feeds an archive', async () => {
    seedIdleTicketLane();
    mockPrisma.loopMetric.findMany.mockResolvedValue([{ meta: { rule: 'R6', targetChatId: 'lane-tkt00000' } }]);
    expect(await runSessionTopologyRetireScanOnce(NOW)).toBe('retire scan: 0 candidate(s) (observe-only) over 1 project(s), archived 1');
    jest.clearAllMocks();
    mockRetireIdleLanes.mockImplementation((...a: any[]) => realLaneRetire.retireIdleLanes(...a));
    seedIdleTicketLane({ partial: true });
    mockPrisma.loopMetric.findMany.mockResolvedValue([]);
    await runSessionTopologyRetireScanOnce(NOW);
    expect(mockRetireIdleLanes).toHaveBeenCalledWith([], NOW);
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('an owner-created lane (no proof: an API-made session whose first message reads "user") is evaluated and kept', async () => {
    seedIdleTicketLane();
    mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ metadata: { origin: 'user' } });
    expect(await runSessionTopologyRetireScanOnce(NOW)).toBe('retire scan: 1 candidate(s) (observe-only) over 1 project(s), archived 0');
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r) => r.kind === 'lane_retired')).toMatchObject({ meta: { phase: 'pass', considered: 1, archived: 0, skipped: { owner_created: 1 } } });
  });
});

describe('runSessionTopologyRetireScanOnce — the acting feed walks CODING lanes past the placement index (review fixer 2026-10-21)', () => {
  const OLD = new Date(NOW.getTime() - 20 * 86400_000);
  it('a long-idle lane that is NOT among the 200 newest chats (plain chats crowd them) is still found and archived; its R6 observe row is not invented', async () => {
    const plain = Array.from({ length: 200 }, (_, i) => ({ id: `plain-${String(i).padStart(3, '0')}`, title: 'chat', charterGoalId: null, charterTodoId: null, createdAt: OLD, parentChatId: null, isSupervisor: false, isProjectSupervisor: false, titlePinned: false }));
    const stale = { id: 'lane-stale000', title: 'ticket fix', charterGoalId: null, charterTodoId: null, createdAt: OLD, parentChatId: null, isSupervisor: false, isProjectSupervisor: false, titlePinned: false };
    mockPrisma.crossModelChat.findMany.mockImplementation(async (a: any) => {
      if (a?.distinct) return [{ projectId: 'proj-1', userId: 'u1' }];
      if (a?.where?.projectId && a?.where?.codingState) return [stale];       // the scan page: coding lanes only
      if (a?.where?.projectId) return plain;                                    // the placement index: 200 newest chats, all plain
      if (a?.where?.id?.in) return [{ ...stale, userId: 'u1', projectId: 'proj-1', archivedAt: null }];
      return [];
    });
    mockPrisma.crossModelChat.groupBy.mockResolvedValue([{ projectId: 'proj-1', userId: 'u1', _max: { updatedAt: OLD } }]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ archivedAt: null, userId: 'u1' });
    mockPrisma.chatCodingState.findMany.mockImplementation(async (a: any) => (a?.where?.id?.in?.includes(stale.id) ? [{ id: stale.id, branch: 'digby/s', status: 'ready' }] : []));
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ chatId: stale.id, createdAt: new Date(NOW.getTime() - 9 * 86400_000) }]);
    mockPrisma.runToolReceipt.groupBy.mockResolvedValue([{ chatId: stale.id, _max: { createdAt: new Date(NOW.getTime() - 9 * 86400_000) } }]);
    mockPrisma.agentRun.groupBy.mockImplementation(async (a: any) => (a?._max ? [{ sessionId: stale.id, _max: { updatedAt: new Date(NOW.getTime() - 9 * 86400_000) } }] : []));
    mockPrisma.userFeatureRequest.findMany.mockImplementation(async (a: any) => (a?.where?.status ? [] : [{ context: { dispatchedTo: stale.id } }]));
    const summary = await runSessionTopologyRetireScanOnce(NOW);
    // the observe rows still come from the placement index (no coding lane there ⇒ no R6 row) …
    expect(summary).toBe('retire scan: 0 candidate(s) (observe-only) over 1 project(s), archived 1');
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0].kind === 'session_topology')).toBe(false);
    // … while the acting walk found the stale lane and archived it
    expect(mockArchiveChat).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', chatId: stale.id, source: 'lane_retire' }));
    const scanCall = mockPrisma.crossModelChat.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.codingState && typeof a?.where?.projectId === 'string');
    expect(scanCall).toMatchObject({ where: { projectId: 'proj-1', userId: 'u1', archivedAt: null, codingState: { isNot: null } }, orderBy: { id: 'asc' } });
  });

  it('LANE_IDLE_RETIRE_DISABLED=1: no scan page is read at all', async () => {
    process.env.LANE_IDLE_RETIRE_DISABLED = '1';
    mockPrisma.crossModelChat.findMany.mockImplementation(async (a: any) => (a?.distinct ? [{ projectId: 'proj-1', userId: 'u1' }] : []));
    await runSessionTopologyRetireScanOnce(NOW);
    expect(mockPrisma.crossModelChat.findMany.mock.calls.some((c: any[]) => c[0]?.where?.codingState && typeof c[0]?.where?.projectId === 'string')).toBe(false);
  });
});
