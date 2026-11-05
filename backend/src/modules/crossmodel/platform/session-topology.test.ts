/**
 * Session topology (SESSION_TITLES_TOPOLOGY design §B, 2026-09-27) pins.
 * Pure: the seven placement rules over a goal→lane index (R1 exact + word
 * overlap, R2 independent, R3 shared dependency, R4 watch ⇒ schedule, R5
 * satellite ⇒ merge, R6 retire candidates, R7 grey band ⇒ ambiguous), the
 * monitor-prompt detector, the hashed gate state. Wiring (mocked prisma +
 * gate): evaluateTopology is observe-only by default (advisory, no refusal),
 * SESSION_TOPOLOGY_ENFORCE=1 refuses R1 / R4 with the alternative named, the
 * gate is asked ONLY on R7 and its act answer replaces the fail-open spawn,
 * SESSION_TOPOLOGY_DISABLED=1 short-circuits, every read failure fails open,
 * and recordTopologyDecision writes the row with the spawned id.
 */
const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []) },
  chatCodingState: { findMany: jest.fn(async () => []) },
  projectTodo: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  projectGoal: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  agentRun: { groupBy: jest.fn(async () => []), findMany: jest.fn(async () => []) },
  chatSchedule: { groupBy: jest.fn(async () => []) },
  loopMetric: { groupBy: jest.fn(async () => []) },
  runToolReceipt: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
};
const mockDecide = jest.fn((..._a: any[]): Promise<any> => Promise.resolve(null));
const mockDecisionMode = jest.fn((..._a: any[]): any => 'shadow');
const mockRecordLoopMetric = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), LOOP_METRIC_KINDS: { SESSION_TOPOLOGY: 'session_topology', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', CONTEXT_COMPACTION: 'context_compaction' } }));
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockDecisionMode(...a),
  decisionThreshold: (_p: string, f: number) => f,
  stashDecision: (d: any, purpose: string, opts: any) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'x', extra: opts?.extra } : null),
}));
jest.mock('../coding/plan.service', () => ({ __esModule: true, getPlan: jest.fn(async () => null) }));

import {
  decideTopology, isMonitorPrompt, normalizeGoalWords, jaccard, retireCandidates, buildTopologyState, buildLaneIndex, evaluateTopology, recordTopologyDecision,
  renderLaneIndex, sessionTopologyOverlapMin, type LaneIndexRow,
} from './session-topology';

const NOW = new Date('2026-09-27T15:00:00Z');
const lane = (over: Partial<LaneIndexRow> = {}): LaneIndexRow => ({
  laneId: over.laneId ?? 'lane-aaaaaaaa', title: 'Some lane', charterGoalId: null, charterTodoIds: [], goalIds: [], planGoal: null, ageDays: 3, runs14d: 10, running: false,
  enabledSchedules: 0, busySkips24h: 0, compactionsPerRun: 0, goalsHeld: 0, lastMutatingReceiptAgeSec: 600, worktreeBranch: 'digby/session-a', parentChatId: null, isSupervisor: false, isCoding: true, charterOpen: false, titlePinned: false, ...over,
});
/** A chat row for the mocked index read. */
const chatRow = (id: string, over: Record<string, unknown> = {}) => ({ id, title: 'Lane', charterGoalId: null, charterTodoId: null, createdAt: NOW, parentChatId: null, isSupervisor: false, isProjectSupervisor: false, ...over });
/** Fixer 2026-09-27: only chats WITH a coding state are lanes — seed the states leg for every lane id. */
const seedCodingStates = (...ids: string[]) => mockPrisma.chatCodingState.findMany.mockResolvedValue(ids.map((id) => ({ id, branch: `digby/${id}`, status: 'ready' })));
const GOALS = { 'goal-1': 'H2H benchmark S3 and S5 shards', 'goal-2': 'Fix the upload MIME type on lane images' };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SESSION_TOPOLOGY_DISABLED;
  delete process.env.SESSION_TOPOLOGY_ENFORCE;
  delete process.env.SESSION_TOPOLOGY_OVERLAP_MIN;
  delete process.env.LANE_IDLE_RETIRE_DISABLED;
  mockDecisionMode.mockReturnValue('shadow');
  for (const m of Object.values(mockPrisma) as any[]) for (const f of Object.values(m) as any[]) f.mockResolvedValue?.(Array.isArray(f.getMockImplementation?.()) ? [] : undefined);
  mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.findFirst.mockResolvedValue(null);
  mockPrisma.projectGoal.findMany.mockResolvedValue([]);
  mockPrisma.projectGoal.findFirst.mockResolvedValue(null);
  mockPrisma.agentRun.groupBy.mockResolvedValue([]);
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
  mockPrisma.chatSchedule.groupBy.mockResolvedValue([]);
  mockPrisma.loopMetric.groupBy.mockResolvedValue([]);
  mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
});

describe('pure helpers', () => {
  it('normalizeGoalWords drops stop words / short tokens and stems lightly; jaccard is 0 on empties', () => {
    expect([...normalizeGoalWords('Fix the upload MIME types on lane images')]).toEqual(['fix', 'upload', 'mime', 'type', 'image']);
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(), new Set(['x']))).toBe(0);
  });

  it('isMonitorPrompt: a monitor verb + a CADENCE cue + a URL / PR / issue reference and NO mutating verb (fixer 2026-09-27: narrow)', () => {
    expect(isMonitorPrompt('Check the status of PR #55747 every hour and report')).toBe(true);
    expect(isMonitorPrompt('Poll https://github.com/x/y/pull/12 until merged')).toBe(true);
    expect(isMonitorPrompt('Fix the MIME type and open a PR #12')).toBe(false);
    expect(isMonitorPrompt('Watch the training loss')).toBe(false);
    expect(isMonitorPrompt('')).toBe(false);
    // verify / audit / investigate / review / test / design are WORK, never a watch
    expect(isMonitorPrompt('Verify PR #712 CI status and report failures')).toBe(false);
    expect(isMonitorPrompt('Audit issue #88 every day')).toBe(false);
    expect(isMonitorPrompt('Investigate why https://ci.example/run/9 fails hourly')).toBe(false);
    // no cadence cue ⇒ a one-off read, not a schedule
    expect(isMonitorPrompt('Check the status of PR #55747')).toBe(false);
    // a bare 8-hex id (chat / ticket / commit) is not a watch reference
    expect(isMonitorPrompt('Track chat a1b2c3d4 hourly')).toBe(false);
  });

  it('sessionTopologyOverlapMin reads the env (0.6 default, clamped)', () => {
    expect(sessionTopologyOverlapMin()).toBe(0.6);
    process.env.SESSION_TOPOLOGY_OVERLAP_MIN = '0.4';
    expect(sessionTopologyOverlapMin()).toBe(0.4);
    process.env.SESSION_TOPOLOGY_OVERLAP_MIN = 'nope';
    expect(sessionTopologyOverlapMin()).toBe(0.6);
  });
});

describe('decideTopology — the rule table', () => {
  it('R1 exact: the lane that OWNS the goal (charter) / holds the same todoId ⇒ reuse that lane (the running owner first)', () => {
    const idle = lane({ laneId: 'lane-idle0000', charterGoalId: 'goal-1' });
    const busy = lane({ laneId: 'lane-busy0000', charterGoalId: 'goal-1', running: true });
    const d = decideTopology({ goalId: 'goal-1', lanes: [idle, busy] }, GOALS);
    expect(d).toMatchObject({ verdict: 'reuse', rule: 'R1', target: 'lane-busy0000' });
    expect(d.reason).toMatch(/already holds this goal — send_chat_message it/);
    expect(decideTopology({ todoId: 'todo-7', lanes: [lane({ charterTodoIds: ['todo-7'] })] }, GOALS)).toMatchObject({ verdict: 'reuse', rule: 'R1', target: 'lane-aaaaaaaa' });
  });

  it('fixer 2026-09-27: a lane holding ANOTHER open todo of the goal (no charter) is not the owner — an independent sibling todo fans out (R2), a dependent one is R3', () => {
    // lane works todo #1 of goal-1 (assigned, uncharted); todo #2 of goal-1 arrives with unrelated words
    const sibling = lane({ laneId: 'lane-sib00000', goalIds: ['goal-1'], charterTodoIds: ['todo-1'], goalsHeld: 1, planGoal: 'shard S3 run' });
    const independent = decideTopology({ goalId: 'goal-1', todoId: 'todo-2', goalText: 'Write the Telegram webhook retry queue', lanes: [sibling] }, { 'goal-1': 'Telegram reliability' });
    expect(independent.rule).not.toBe('R1');
    expect(independent.verdict).toBe('spawn');
    const dependent = decideTopology({ goalId: 'goal-1', todoId: 'todo-2', goalText: 'Write the Telegram webhook retry queue', dependsOnTodoIds: ['todo-1'], lanes: [sibling] }, { 'goal-1': 'Telegram reliability' });
    expect(dependent).toMatchObject({ verdict: 'reuse', rule: 'R3', target: 'lane-sib00000' });
  });

  it('fixer 2026-09-27: a PLAIN conversation (isCoding:false) is never an R1 / R5 target nor an R6 candidate', () => {
    const plain = lane({ laneId: 'chat-plain000', title: 'Fix the upload MIME type on lane images', isCoding: false, worktreeBranch: null });
    const r1 = decideTopology({ goalText: 'fix upload MIME type lane images', lanes: [plain] }, GOALS);
    expect(r1).toMatchObject({ verdict: 'spawn', rule: 'R2' });
    expect(r1.signals.lanes).toBe(0);
    const r5 = decideTopology({ prompt: 'Verify PR #712 still passes the smoke test', callerChatId: 'chat-plain000', lanes: [plain] }, GOALS);
    expect(r5).toMatchObject({ verdict: 'spawn', rule: 'R2' });
    expect(retireCandidates([lane({ laneId: 'chat-old00000', isCoding: false, lastMutatingReceiptAgeSec: null, ageDays: 9, runs14d: 0 })])).toEqual([]);
    expect(renderLaneIndex({ lanes: [plain, lane()], goalTitles: {}, partial: false }).map((r) => r.chatId)).toEqual(['lane-aaaaaaaa']);
  });

  it('R1 overlap: goal words ≥ 0.6 Jaccard against a lane\'s charter / plan goal ⇒ reuse with candidates', () => {
    const l = lane({ charterGoalId: 'goal-2' });
    const d = decideTopology({ goalText: 'fix upload MIME type lane images', lanes: [l] }, GOALS);
    expect(d).toMatchObject({ verdict: 'reuse', rule: 'R1', target: 'lane-aaaaaaaa' });
    expect(d.candidates?.[0]).toMatchObject({ laneId: 'lane-aaaaaaaa' });
    expect(Number(d.signals.overlap)).toBeGreaterThanOrEqual(0.6);
  });

  it('R4: a GET-only recurring watch ⇒ schedule, before every other rule — but NEVER for a charter-bound (goalId / todoId) request', () => {
    const d = decideTopology({ goalText: 'Bounty submission status', prompt: 'Check the status of PR #55747 every hour', lanes: [lane({ charterGoalId: 'goal-1' })] }, GOALS);
    expect(d).toMatchObject({ verdict: 'schedule', rule: 'R4' });
    expect(d.reason).toMatch(/schedule_message/);
    // fixer 2026-09-27: a todo-bound verify / status spawn is a deliverable
    const bound = decideTopology({ todoId: 'todo-9', goalText: 'Verify PR #712 CI status and report failures', prompt: 'Check the status of PR #712 every hour', lanes: [lane({ charterGoalId: 'goal-1' })] }, GOALS);
    expect(bound.rule).not.toBe('R4');
    expect(bound.verdict).toBe('spawn');
    const verify = decideTopology({ goalText: 'Verify PR #712 CI status', prompt: 'Verify PR #712 CI status and report failures', lanes: [lane({ charterGoalId: 'goal-1' })] }, GOALS);
    expect(verify.rule).not.toBe('R4');
  });

  it('R3: a dependency on a todo a ≤2-goal lane holds ⇒ reuse that lane', () => {
    const l = lane({ charterTodoIds: ['todo-dep'], goalsHeld: 2, charterGoalId: 'goal-1' });
    const d = decideTopology({ goalText: 'completely unrelated words here', dependsOnTodoIds: ['todo-dep'], lanes: [l] }, GOALS);
    expect(d).toMatchObject({ verdict: 'reuse', rule: 'R3', target: 'lane-aaaaaaaa' });
    const heavy = lane({ charterTodoIds: ['todo-dep'], goalsHeld: 4 });
    expect(decideTopology({ goalText: 'completely unrelated words here', dependsOnTodoIds: ['todo-dep'], lanes: [heavy] }, GOALS).rule).not.toBe('R3');
  });

  it('R7: overlap in the grey band (≥ 0.3, < 0.6) ⇒ ambiguous spawn with the nearest lane as target', () => {
    const l = lane({ charterGoalId: 'goal-2' });
    const d = decideTopology({ goalText: 'upload MIME audit for the desktop images pipeline', lanes: [l] }, GOALS);
    expect(d).toMatchObject({ verdict: 'spawn', rule: 'R7', ambiguous: true, target: 'lane-aaaaaaaa' });
    expect(Number(d.signals.overlap)).toBeGreaterThanOrEqual(0.3);
    expect(Number(d.signals.overlap)).toBeLessThan(0.6);
  });

  it('R5: a short goal-less prompt with an idle parent lane ⇒ merge into the parent; a running parent falls through to R2', () => {
    const parent = lane({ laneId: 'parent-000000', charterGoalId: 'goal-1' });
    const d = decideTopology({ prompt: 'Verify PR #712 still passes the smoke test', callerChatId: 'parent-000000', lanes: [parent] }, GOALS);
    expect(d).toMatchObject({ verdict: 'merge', rule: 'R5', target: 'parent-000000' });
    const busyParent = lane({ laneId: 'parent-000000', running: true, busySkips24h: 40 });
    const d2 = decideTopology({ prompt: 'Verify PR #712 still passes the smoke test', callerChatId: 'parent-000000', lanes: [busyParent] }, GOALS);
    expect(d2).toMatchObject({ verdict: 'spawn', rule: 'R2' });
    expect(d2.signals.hostBusy).toBe(true);
    expect(d2.reason).toMatch(/running/);
  });

  it('R2: no overlap ⇒ spawn a dedicated lane (naming the nearest lane\'s busy signals); no lanes ⇒ spawn', () => {
    const l = lane({ charterGoalId: 'goal-1', enabledSchedules: 3, compactionsPerRun: 0.2, goalsHeld: 4 });
    const d = decideTopology({ goalText: 'Rewrite the Telegram webhook retry queue', lanes: [l] }, GOALS);
    expect(d).toMatchObject({ verdict: 'spawn', rule: 'R2' });
    expect(d.signals.hostSignals).toEqual(expect.arrayContaining(['3 enabled schedules']));
    expect(decideTopology({ goalText: 'anything', lanes: [] }, GOALS)).toMatchObject({ verdict: 'spawn', rule: 'R2', reason: expect.stringMatching(/no lanes/) });
    // supervisors never count as lanes
    expect(decideTopology({ goalId: 'goal-1', lanes: [lane({ charterGoalId: 'goal-1', isSupervisor: true })] }, GOALS).rule).toBe('R2');
  });

  it('R6 retireCandidates: idle > 6 h, no charter todo / open goal, no schedule, not running, not a supervisor (LANE_IDLE_RETIRE_DISABLED=1 — the stamp-keyed predicate, byte-for-byte)', () => {
    process.env.LANE_IDLE_RETIRE_DISABLED = '1';
    const ok = lane({ laneId: 'lane-retire00', lastMutatingReceiptAgeSec: 7 * 3600 });
    const fresh = lane({ laneId: 'lane-fresh000', lastMutatingReceiptAgeSec: 600 });
    const withTodo = lane({ laneId: 'lane-todo0000', lastMutatingReceiptAgeSec: 7 * 3600, charterTodoIds: ['t'] });
    const scheduled = lane({ laneId: 'lane-sched000', lastMutatingReceiptAgeSec: 7 * 3600, enabledSchedules: 1 });
    const noReceiptOld = lane({ laneId: 'lane-old00000', lastMutatingReceiptAgeSec: null, ageDays: 2, runs14d: 0 });
    const noReceiptNew = lane({ laneId: 'lane-new00000', lastMutatingReceiptAgeSec: null, ageDays: 0.1, runs14d: 0 });
    expect(retireCandidates([ok, fresh, withTodo, scheduled, noReceiptOld, noReceiptNew, lane({ laneId: 'sup', isSupervisor: true, lastMutatingReceiptAgeSec: 9e6 })]).map((c) => c.laneId)).toEqual(['lane-retire00', 'lane-old00000']);
    // under the switch an OPEN charter alone is not read — only the stamp
    expect(retireCandidates([lane({ laneId: 'lane-open0000', lastMutatingReceiptAgeSec: 7 * 3600, charterOpen: true })]).map((c) => c.laneId)).toEqual(['lane-open0000']);
  });

  it('LANE-IDLE-RETIRE: R6 keys on charterOpen, not the stamp — a DONE charter todo is a candidate, an open charter or an open assigned todo is not', () => {
    const doneCharter = lane({ laneId: 'lane-done0000', lastMutatingReceiptAgeSec: 7 * 3600, charterTodoIds: ['t-done'], charterOpen: false });
    const openCharter = lane({ laneId: 'lane-open0000', lastMutatingReceiptAgeSec: 7 * 3600, charterTodoIds: ['t-open'], charterOpen: true });
    const assignedTodo = lane({ laneId: 'lane-asgn0000', lastMutatingReceiptAgeSec: 7 * 3600, charterTodoIds: ['t-2'], goalIds: ['goal-1'] });
    const scheduled = lane({ laneId: 'lane-sched000', lastMutatingReceiptAgeSec: 7 * 3600, enabledSchedules: 1 });
    expect(retireCandidates([doneCharter, openCharter, assignedTodo, scheduled]).map((c) => c.laneId)).toEqual(['lane-done0000']);
    // the placement rules still read charterTodoIds (R1 exact on the todo) — unchanged
    expect(decideTopology({ todoId: 't-done', lanes: [doneCharter] }, GOALS)).toMatchObject({ verdict: 'reuse', rule: 'R1', target: 'lane-done0000' });
  });

  it('buildTopologyState hashes lane ids, carries the request head + rule + nearest, ≤ 4 KB', () => {
    const l = lane({ charterGoalId: 'goal-2', planGoal: 'fix MIME' });
    const d = decideTopology({ goalText: 'upload MIME audit for the desktop images pipeline', lanes: [l] }, GOALS);
    const s = buildTopologyState(d, { goalText: 'upload MIME audit', prompt: 'do it', goalId: null, todoId: null, hasSchedule: false }, [l], GOALS);
    expect(s).toMatch(/^REQUEST: upload MIME audit/);
    expect(s).toContain('RULE: R7');
    expect(s).not.toContain('lane-aaaaaaaa');
    expect(s).toContain('Fix the upload MIME type on lane images');
    expect(s.length).toBeLessThanOrEqual(4000);
  });
});

describe('buildLaneIndex (mocked prisma)', () => {
  it('assembles per-lane rows from chats, satellites, todos, runs, schedules, busy-skips, compactions and receipts; supervisors flagged; a plain chat is isCoding:false; partial on a failed leg', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: 'lane-1', title: 'Lane one', charterGoalId: 'goal-1', charterTodoId: null, createdAt: new Date(NOW.getTime() - 5 * 86400_000), parentChatId: null, isSupervisor: false, isProjectSupervisor: false },
      { id: 'sup-1', title: 'X Supervisor', charterGoalId: null, charterTodoId: null, createdAt: NOW, parentChatId: null, isSupervisor: false, isProjectSupervisor: true },
      chatRow('chat-plain', { title: 'A plain conversation' }),
    ]);
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 'lane-1', branch: 'digby/session-1', status: 'ready' }]);
    mockPrisma.projectTodo.findMany.mockResolvedValue([{ id: 'todo-1', goalId: 'goal-2', assigneeChatId: 'lane-1' }]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([{ sessionId: 'lane-1', _count: { _all: 20 } }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([{ sessionId: 'lane-1' }]);
    mockPrisma.chatSchedule.groupBy.mockResolvedValue([{ sessionId: 'lane-1', _count: { _all: 2 } }]);
    mockPrisma.loopMetric.groupBy.mockResolvedValueOnce([{ sessionId: 'lane-1', _count: { _all: 30 } }]).mockResolvedValueOnce([{ sessionId: 'lane-1', _count: { _all: 4 } }]);
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([{ chatId: 'lane-1', createdAt: new Date(NOW.getTime() - 3600_000) }]);
    mockPrisma.projectGoal.findMany.mockResolvedValue([{ id: 'goal-1', title: 'G1' }, { id: 'goal-2', title: 'G2' }]);
    const idx = await buildLaneIndex('proj-1', 'u1', { now: NOW });
    expect(idx.partial).toBe(false);
    expect(idx.goalTitles).toEqual({ 'goal-1': 'G1', 'goal-2': 'G2' });
    const l = idx.lanes.find((x) => x.laneId === 'lane-1')!;
    expect(l).toMatchObject({ charterGoalId: 'goal-1', charterTodoIds: ['todo-1'], goalIds: ['goal-2'], runs14d: 20, running: true, enabledSchedules: 2, busySkips24h: 30, compactionsPerRun: 0.2, goalsHeld: 2, lastMutatingReceiptAgeSec: 3600, worktreeBranch: 'digby/session-1', isCoding: true });
    expect(l.ageDays).toBeCloseTo(5);
    expect(idx.lanes.find((x) => x.laneId === 'sup-1')!.isSupervisor).toBe(true);
    // the plain chat is listed (Sessions view) but is not a lane
    expect(idx.lanes.find((x) => x.laneId === 'chat-plain')).toMatchObject({ isCoding: false, worktreeBranch: null });
    expect(renderLaneIndex(idx).map((r) => r.chatId)).toEqual(['lane-1']);
    // a failed leg ⇒ partial, never a throw
    mockPrisma.runToolReceipt.findMany.mockRejectedValue(new Error('boom'));
    expect((await buildLaneIndex('proj-1', 'u1', { now: NOW })).partial).toBe(true);
    // a failed STATES leg ⇒ partial AND nothing is a lane (the pre-check fails open to spawn, never to a reuse of an unknown chat)
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
    mockPrisma.chatCodingState.findMany.mockRejectedValue(new Error('states down'));
    const noStates = await buildLaneIndex('proj-1', 'u1', { now: NOW });
    expect(noStates.partial).toBe(true);
    expect(noStates.lanes.every((x) => x.isCoding === false)).toBe(true);
    mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
    // no chats ⇒ empty, not partial
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    expect(await buildLaneIndex('proj-1', 'u1', { now: NOW })).toEqual({ lanes: [], goalTitles: {}, partial: false });
  });
});

describe('buildLaneIndex — charterOpen + titlePinned (LANE-IDLE-RETIRE 2026-10-21)', () => {
  const OLD = new Date(NOW.getTime() - 9 * 86400_000);
  it('charterOpen: done / reassigned / missing charter todo ⇒ closed; open todo still on the lane (or unassigned) ⇒ open; an active / blocked charter goal ⇒ open, done / archived ⇒ closed', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      chatRow('l-done', { charterTodoId: 't-done', createdAt: OLD }),
      chatRow('l-reassigned', { charterTodoId: 't-moved', createdAt: OLD }),
      chatRow('l-open', { charterTodoId: 't-open', createdAt: OLD, titlePinned: true }),
      chatRow('l-unassigned', { charterTodoId: 't-free', createdAt: OLD }),
      chatRow('l-missing', { charterTodoId: 't-gone', createdAt: OLD }),
      chatRow('l-goal-active', { charterGoalId: 'g-active', createdAt: OLD }),
      chatRow('l-goal-done', { charterGoalId: 'g-done', createdAt: OLD }),
      chatRow('l-goal-blocked', { charterGoalId: 'g-blocked', createdAt: OLD }),
    ]);
    seedCodingStates('l-done', 'l-reassigned', 'l-open', 'l-unassigned', 'l-missing', 'l-goal-active', 'l-goal-done', 'l-goal-blocked');
    // the open-assigned-todos leg (status ∈ open) and the charter leg (by id) share findMany — answer by where shape
    mockPrisma.projectTodo.findMany.mockImplementation(async (args: any) => (args?.where?.id ? [
      { id: 't-done', status: 'done', assigneeChatId: 'l-done' },
      { id: 't-moved', status: 'in_progress', assigneeChatId: 'some-other-lane' },
      { id: 't-open', status: 'blocked', assigneeChatId: 'l-open' },
      { id: 't-free', status: 'pending', assigneeChatId: null },
    ] : []));
    mockPrisma.projectGoal.findMany.mockResolvedValue([
      { id: 'g-active', title: 'A', status: 'active' }, { id: 'g-done', title: 'D', status: 'done' }, { id: 'g-blocked', title: 'B', status: 'blocked' },
    ]);
    const idx = await buildLaneIndex('proj-1', 'u1', { now: NOW });
    expect(idx.partial).toBe(false);
    const open = Object.fromEntries(idx.lanes.map((l) => [l.laneId, l.charterOpen]));
    expect(open).toEqual({ 'l-done': false, 'l-reassigned': false, 'l-open': true, 'l-unassigned': true, 'l-missing': false, 'l-goal-active': true, 'l-goal-done': false, 'l-goal-blocked': true });
    // the placement input is unchanged: the stamp still rides charterTodoIds
    expect(idx.lanes.find((l) => l.laneId === 'l-done')!.charterTodoIds).toEqual(['t-done']);
    expect(idx.lanes.find((l) => l.laneId === 'l-open')!.titlePinned).toBe(true);
    expect(idx.lanes.find((l) => l.laneId === 'l-done')!.titlePinned).toBe(false);
    // the charter leg reads exactly the charter todo ids
    const charterCall = mockPrisma.projectTodo.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.id);
    expect(charterCall).toEqual({ where: { id: { in: ['t-done', 't-moved', 't-open', 't-free', 't-gone'] } }, select: { id: true, status: true, assigneeChatId: true } });
  });

  it('a FAILED charter leg / goal leg reads OPEN (fail-safe) and marks the index partial; no charter todo ⇒ the leg is skipped', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([chatRow('l-todo', { charterTodoId: 't-1' }), chatRow('l-goal', { charterGoalId: 'g-1' }), chatRow('l-none')]);
    seedCodingStates('l-todo', 'l-goal', 'l-none');
    mockPrisma.projectTodo.findMany.mockImplementation(async (args: any) => { if (args?.where?.id) throw new Error('todo leg down'); return []; });
    mockPrisma.projectGoal.findMany.mockRejectedValue(new Error('goal leg down'));
    const idx = await buildLaneIndex('proj-1', 'u1', { now: NOW });
    expect(idx.partial).toBe(true);
    expect(Object.fromEntries(idx.lanes.map((l) => [l.laneId, l.charterOpen]))).toEqual({ 'l-todo': true, 'l-goal': true, 'l-none': false });
    // no lane carries a charter todo ⇒ no charter read at all
    mockPrisma.projectTodo.findMany.mockReset();
    mockPrisma.projectTodo.findMany.mockResolvedValue([]);
    mockPrisma.projectGoal.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([chatRow('l-none')]);
    await buildLaneIndex('proj-1', 'u1', { now: NOW });
    expect(mockPrisma.projectTodo.findMany.mock.calls.some((c: any[]) => c[0]?.where?.id)).toBe(false);
    // LANE_IDLE_RETIRE_DISABLED=1: the index reads exactly what it read before (no charter leg, no goal status column)
    process.env.LANE_IDLE_RETIRE_DISABLED = '1';
    mockPrisma.crossModelChat.findMany.mockResolvedValue([chatRow('l-todo', { charterTodoId: 't-1', charterGoalId: 'g-1' })]);
    await buildLaneIndex('proj-1', 'u1', { now: NOW });
    expect(mockPrisma.projectTodo.findMany.mock.calls.some((c: any[]) => c[0]?.where?.id)).toBe(false);
    expect(mockPrisma.projectGoal.findMany).toHaveBeenLastCalledWith({ where: { id: { in: ['g-1'] } }, select: { id: true, title: true } });
  });
});

describe('buildLaneIndex — scan mode (lane-retire\'s coding-lane walk, review fixer 2026-10-21)', () => {
  it('REPRO (second review, finding 9): a scan page reads the newest mutating receipt per lane as a groupBy MAX (Prisma runs `distinct` in memory — the findMany pulled every receipt of the page); the placement read keeps its distinct findMany; a scan groupBy failure marks the page partial', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([chatRow('l-1'), chatRow('l-2')]);
    seedCodingStates('l-1', 'l-2');
    const at = new Date(NOW.getTime() - 9 * 86400_000);
    mockPrisma.runToolReceipt.groupBy.mockResolvedValueOnce([{ chatId: 'l-1', _max: { createdAt: at } }, { chatId: 'l-2', _max: { createdAt: null } }]);
    const page = await buildLaneIndex('proj-1', 'u1', { now: NOW, scan: { afterId: null } });
    expect(page.partial).toBe(false);
    expect(page.lanes.map((l) => [l.laneId, l.lastMutatingReceiptAgeSec])).toEqual([['l-1', 9 * 86400], ['l-2', null]]);
    expect(mockPrisma.runToolReceipt.groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ['chatId'], _max: { createdAt: true }, where: expect.objectContaining({ chatId: { in: ['l-1', 'l-2'] }, ok: true }) }));
    expect(mockPrisma.runToolReceipt.findMany).not.toHaveBeenCalled();
    await buildLaneIndex('proj-1', 'u1', { now: NOW });
    expect(mockPrisma.runToolReceipt.findMany).toHaveBeenCalledWith(expect.objectContaining({ distinct: ['chatId'], orderBy: { createdAt: 'desc' } }));
    mockPrisma.runToolReceipt.groupBy.mockRejectedValueOnce(new Error('slow'));
    expect((await buildLaneIndex('proj-1', 'u1', { now: NOW, scan: { afterId: null } })).partial).toBe(true);
  });

  it('a scan page reads CODING lanes only, by id after the cursor, and skips the plan reads; the placement read is unchanged', async () => {
    const { getPlan } = jest.requireMock('../coding/plan.service');
    mockPrisma.crossModelChat.findMany.mockResolvedValue([chatRow('l-1'), chatRow('l-2')]);
    seedCodingStates('l-1', 'l-2');
    const page = await buildLaneIndex('proj-1', 'u1', { now: NOW, scan: { afterId: 'l-0' } });
    expect(page.lanes.map((l) => [l.laneId, l.isCoding, l.planGoal])).toEqual([['l-1', true, null], ['l-2', true, null]]);
    expect(mockPrisma.crossModelChat.findMany.mock.calls[0][0]).toMatchObject({
      where: { projectId: 'proj-1', userId: 'u1', archivedAt: null, codingState: { isNot: null }, id: { gt: 'l-0' } },
      orderBy: { id: 'asc' }, take: 200,
    });
    expect(getPlan).not.toHaveBeenCalled();
    // the first page has no cursor clause
    await buildLaneIndex('proj-1', 'u1', { now: NOW, scan: { afterId: null } });
    expect(mockPrisma.crossModelChat.findMany.mock.calls[1][0].where).toEqual({ projectId: 'proj-1', userId: 'u1', archivedAt: null, codingState: { isNot: null } });
    // no scan ⇒ today's placement read: any chat, newest first, plan reads on
    await buildLaneIndex('proj-1', 'u1', { now: NOW });
    expect(mockPrisma.crossModelChat.findMany.mock.calls[2][0]).toMatchObject({ where: { projectId: 'proj-1', userId: 'u1', archivedAt: null }, orderBy: { updatedAt: 'desc' }, take: 200 });
    expect(mockPrisma.crossModelChat.findMany.mock.calls[2][0].where).not.toHaveProperty('codingState');
    expect(getPlan).toHaveBeenCalledTimes(2);
  });
});

describe('evaluateTopology + recordTopologyDecision (wiring)', () => {
  const seedDuplicate = () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'lane-1', title: 'Lane one', charterGoalId: 'goal-1', charterTodoId: null, createdAt: NOW, parentChatId: null, isSupervisor: false, isProjectSupervisor: false }]);
    seedCodingStates('lane-1');
    mockPrisma.projectGoal.findMany.mockResolvedValue([{ id: 'goal-1', title: 'H2H benchmark S3 and S5 shards' }]);
  };

  it('fixer 2026-09-27: a plain project chat titled like the goal is NOT a reuse target (no coding state) — the spawn proceeds as R2', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([chatRow('chat-plain', { title: 'H2H benchmark S3 and S5 shards' })]);
    mockPrisma.projectGoal.findFirst.mockResolvedValue({ title: 'H2H benchmark S3 and S5 shards' });
    process.env.SESSION_TOPOLOGY_ENFORCE = '1';
    const ev = await evaluateTopology({ userId: 'u1', projectId: 'proj-1', goalId: 'goal-1', site: 'spawn', now: NOW });
    expect(ev.decision).toMatchObject({ verdict: 'spawn', rule: 'R2' });
    expect(ev.refusal).toBeNull();
    expect(ev.telemetry).toMatchObject({ lanes: 1 });
  });

  it('observe-only by default: an R1 duplicate spawn gets an advisory, NO refusal; the row records rule / verdict / target / source rule and the spawned id', async () => {
    seedDuplicate();
    const ev = await evaluateTopology({ userId: 'u1', projectId: 'proj-1', callerChatId: 'sup-1', goalId: 'goal-1', site: 'spawn', now: NOW });
    expect(ev.decision).toMatchObject({ verdict: 'reuse', rule: 'R1', target: 'lane-1' });
    expect(ev.refusal).toBeNull();
    expect(ev.advisory).toMatch(/^\[TOPOLOGY R1 → reuse lane-1 \(observe-only\)\]/);
    expect(mockDecide).not.toHaveBeenCalled();
    recordTopologyDecision(ev, { spawnedChatId: 'child-9' });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'session_topology', sessionId: 'sup-1', meta: expect.objectContaining({ site: 'spawn', rule: 'R1', verdict: 'reuse', targetChatId: 'lane-1', goalId: 'goal-1', source: 'rule', enforced: false, spawnedChatId: 'child-9' }) }));
  });

  it('SESSION_TOPOLOGY_ENFORCE=1 refuses R1 (send_chat_message the lane) and R4 (schedule_message), never the other rules', async () => {
    process.env.SESSION_TOPOLOGY_ENFORCE = '1';
    seedDuplicate();
    const r1 = await evaluateTopology({ userId: 'u1', projectId: 'proj-1', goalId: 'goal-1', site: 'spawn', now: NOW });
    expect(r1.refusal).toMatch(/^Refused: .*send_chat_message/);
    const r4 = await evaluateTopology({ userId: 'u1', projectId: 'proj-1', prompt: 'Check the status of PR #55747 every hour', site: 'spawn', now: NOW });
    expect(r4.refusal).toMatch(/^Refused: .*schedule_message/);
    const r2 = await evaluateTopology({ userId: 'u1', projectId: 'proj-1', title: 'Rewrite the Telegram webhook retry queue', site: 'spawn', now: NOW });
    expect(r2.refusal).toBeNull();
    expect(r2.decision.rule).toBe('R2');
    expect(r2.advisory).toBe('');
  });

  it('R7 asks the gate (shadow: verdict stands, stash rides the row); act + confident reuse REPLACES the fail-open spawn; a gate error fails open', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'lane-1', title: 'Lane one', charterGoalId: 'goal-2', charterTodoId: null, createdAt: NOW, parentChatId: null, isSupervisor: false, isProjectSupervisor: false }]);
    seedCodingStates('lane-1');
    mockPrisma.projectGoal.findMany.mockResolvedValue([{ id: 'goal-2', title: 'Fix the upload MIME type on lane images' }]);
    mockDecide.mockResolvedValue({ id: 'dec-1', mode: 'shadow', backend: 'TypeSafe Jev', answers: { placement: { type: 'choice', choice: 'reuse', probabilities: { reuse: 0.9 }, confidence: 0.9 } }, ms: 5 });
    const shadow = await evaluateTopology({ userId: 'u1', projectId: 'proj-1', callerChatId: 'sup-1', title: 'upload MIME audit for the desktop images pipeline', site: 'spawn', now: NOW });
    expect(shadow.decision).toMatchObject({ verdict: 'spawn', rule: 'R7', ambiguous: true });
    expect(mockDecide).toHaveBeenCalledWith(expect.stringContaining('RULE: R7'), expect.objectContaining({ placement: expect.objectContaining({ type: 'choice' }) }), expect.objectContaining({ purpose: 'session_topology', sessionId: 'sup-1', segment: 'machine' }));
    expect(shadow.stash).toMatchObject({ id: 'dec-1', purpose: 'session_topology', extra: expect.objectContaining({ rule: 'R7', ruleVerdict: 'spawn' }) });
    expect(shadow.gateChoice).toBe('reuse');
    expect(shadow.telemetry).toMatchObject({ source: 'rule', decisionId: 'dec-1', gateChoice: 'reuse' });

    mockDecide.mockResolvedValue({ id: 'dec-2', mode: 'act', backend: 'TypeSafe Jev', answers: { placement: { type: 'choice', choice: 'reuse', probabilities: { reuse: 0.9 }, confidence: 0.9 } }, ms: 5 });
    const act = await evaluateTopology({ userId: 'u1', projectId: 'proj-1', title: 'upload MIME audit for the desktop images pipeline', site: 'spawn', now: NOW });
    expect(act.decision.verdict).toBe('reuse');
    expect(act.decision.reason).toMatch(/the decision gate chose reuse/);
    expect(act.telemetry).toMatchObject({ source: 'gate' });
    expect(act.refusal).toBeNull(); // the gate re-routes advisorily; enforcement is R1/R4 only

    mockDecide.mockResolvedValue({ id: 'dec-3', mode: 'act', backend: 'TypeSafe Jev', answers: { placement: { type: 'choice', choice: 'reuse', probabilities: { reuse: 0.5 }, confidence: 0.5 } }, ms: 5 });
    expect((await evaluateTopology({ userId: 'u1', projectId: 'proj-1', title: 'upload MIME audit for the desktop images pipeline', site: 'spawn', now: NOW })).decision.verdict).toBe('spawn');

    mockDecide.mockRejectedValue(new Error('gate down'));
    expect((await evaluateTopology({ userId: 'u1', projectId: 'proj-1', title: 'upload MIME audit for the desktop images pipeline', site: 'spawn', now: NOW })).decision.verdict).toBe('spawn');

    mockDecisionMode.mockReturnValue('off');
    mockDecide.mockClear();
    await evaluateTopology({ userId: 'u1', projectId: 'proj-1', title: 'upload MIME audit for the desktop images pipeline', site: 'spawn', now: NOW });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('a todoId resolves its goal + dependencies; a missing goal title is fetched; SESSION_TOPOLOGY_DISABLED short-circuits; a thrown read fails open with no telemetry', async () => {
    mockPrisma.projectTodo.findFirst.mockResolvedValue({ title: 'Do the S5 shard', goalId: 'goal-1', depsThis: [{ dependsOnTodoId: 'todo-dep' }] });
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'lane-1', title: 'Lane one', charterGoalId: 'goal-9', charterTodoId: 'todo-dep', createdAt: NOW, parentChatId: null, isSupervisor: false, isProjectSupervisor: false }]);
    seedCodingStates('lane-1');
    mockPrisma.projectGoal.findMany.mockResolvedValue([{ id: 'goal-9', title: 'Something else entirely' }]);
    mockPrisma.projectGoal.findFirst.mockResolvedValue({ title: 'H2H benchmark shards' });
    const ev = await evaluateTopology({ userId: 'u1', projectId: 'proj-1', todoId: 'todo-5', site: 'check', now: NOW });
    expect(ev.decision).toMatchObject({ verdict: 'reuse', rule: 'R3', target: 'lane-1' });
    expect(ev.telemetry).toMatchObject({ goalId: 'goal-1', todoId: 'todo-5', site: 'check' });

    process.env.SESSION_TOPOLOGY_DISABLED = '1';
    const off = await evaluateTopology({ userId: 'u1', projectId: 'proj-1', todoId: 'todo-5', site: 'check', now: NOW });
    expect(off.decision).toMatchObject({ verdict: 'spawn', rule: 'R2' });
    expect(off.telemetry).toBeUndefined();
    recordTopologyDecision(off);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    delete process.env.SESSION_TOPOLOGY_DISABLED;

    mockPrisma.crossModelChat.findMany.mockImplementation(() => { throw new Error('sync boom'); });
    const failed = await evaluateTopology({ userId: 'u1', projectId: 'proj-1', todoId: 'todo-5', site: 'check', now: NOW });
    expect(failed.decision.verdict).toBe('spawn');
    expect(failed.refusal).toBeNull();
  });
});
