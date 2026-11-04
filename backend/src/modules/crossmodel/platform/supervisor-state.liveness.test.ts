/**
 * [FLEET LIVENESS] block (remediation P7, spark G4): the code-built
 * per-project machine-heartbeat table injected into the supervisor's machine
 * wakes — enabled schedules · last firing age · live runs, from grouped
 * queries. A project with chats but no heartbeat renders as DEAF; an empty
 * fleet (or any failure) renders as ''.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockChatFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockSchedGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockSchedFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockRunGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockProjectFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockGoalGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTodoGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockWatchedGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findMany: (...a: any[]) => mockChatFindMany(...a) },
    crossModelProject: { findMany: (...a: any[]) => mockProjectFindMany(...a) },
    codingSchedule: {
      groupBy: (...a: any[]) => mockSchedGroupBy(...a),
      findMany: (...a: any[]) => mockSchedFindMany(...a), // the near-cap row scan (ticket b4d1096c)
    },
    agentRun: { groupBy: (...a: any[]) => mockRunGroupBy(...a) },
    projectGoal: { groupBy: (...a: any[]) => mockGoalGroupBy(...a) },
    projectTodo: { groupBy: (...a: any[]) => mockTodoGroupBy(...a) },
    watchedResource: { groupBy: (...a: any[]) => mockWatchedGroupBy(...a) },
  },
}));

import { buildFleetLivenessBlock } from './supervisor-state.service';

const NOW = new Date('2026-09-09T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

beforeEach(() => {
  jest.clearAllMocks();
  mockChatFindMany.mockResolvedValue([]);
  mockSchedGroupBy.mockResolvedValue([]);
  mockRunGroupBy.mockResolvedValue([]);
  mockProjectFindMany.mockResolvedValue([]);
  mockGoalGroupBy.mockResolvedValue([]);
  mockTodoGroupBy.mockResolvedValue([]);
  mockWatchedGroupBy.mockResolvedValue([]);
});

describe('buildFleetLivenessBlock (G4)', () => {
  it('an ownerless fleet (no chats) renders nothing', async () => {
    expect(await buildFleetLivenessBlock('u1', NOW)).toBe('');
    expect(mockSchedGroupBy).not.toHaveBeenCalled();
  });

  it('groups schedules + live runs per PROJECT, names projects, and ages the last firing', async () => {
    mockChatFindMany.mockResolvedValue([
      { id: 'c1', projectId: 'p1' },
      { id: 'c2', projectId: 'p1' },
      { id: 'c3', projectId: null },
    ]);
    mockSchedGroupBy.mockResolvedValue([
      { sessionId: 'c1', _count: { _all: 2 }, _max: { lastFiredAt: hoursAgo(2) } },
      { sessionId: 'c2', _count: { _all: 1 }, _max: { lastFiredAt: hoursAgo(5) } },
    ]);
    mockRunGroupBy.mockResolvedValue([{ sessionId: 'c3', _count: { _all: 1 } }]);
    mockProjectFindMany.mockResolvedValue([{ id: 'p1', name: 'Training run' }]);

    const block = await buildFleetLivenessBlock('u1', NOW);
    expect(block).toContain('[FLEET LIVENESS');
    expect(block).toContain('- Training run: 3 enabled schedule(s), last firing 2h ago, 0 running/queued run(s)');
    expect(block).toContain('- Ungrouped chats: 0 enabled schedule(s), NO enabled schedules (deaf unless a run is live), 1 running/queued run(s)');
  });

  it('a project with chats, ZERO schedules/runs, but LIVE WORK (an active goal) is listed as DEAF (the signal the table exists for)', async () => {
    mockChatFindMany.mockResolvedValue([
      { id: 'c1', projectId: 'p-live' },
      { id: 'c2', projectId: 'p-deaf' },
    ]);
    mockSchedGroupBy.mockResolvedValue([{ sessionId: 'c1', _count: { _all: 1 }, _max: { lastFiredAt: hoursAgo(1) } }]);
    mockProjectFindMany.mockResolvedValue([{ id: 'p-live', name: 'Live' }, { id: 'p-deaf', name: 'Deaf' }]);
    mockGoalGroupBy.mockResolvedValue([{ projectId: 'p-deaf', _count: { _all: 1 } }]);
    const block = await buildFleetLivenessBlock('u1', NOW);
    expect(block).toContain('- Deaf: 0 enabled schedule(s), NO enabled schedules (deaf unless a run is live)');
  });

  it('a project with chats but ZERO schedules/runs AND zero live work is DORMANT-BY-DESIGN, not deaf (ticket b1d435fd)', async () => {
    mockChatFindMany.mockResolvedValue([
      { id: 'c1', projectId: 'p-live' },
      { id: 'c2', projectId: 'p-dorm' },
    ]);
    mockSchedGroupBy.mockResolvedValue([{ sessionId: 'c1', _count: { _all: 1 }, _max: { lastFiredAt: hoursAgo(1) } }]);
    mockProjectFindMany.mockResolvedValue([{ id: 'p-live', name: 'Live' }, { id: 'p-dorm', name: 'Spark Cluster' }]);
    const block = await buildFleetLivenessBlock('u1', NOW);
    expect(block).toContain('- Spark Cluster: 0 enabled schedule(s), dormant-by-design');
    expect(block).toContain('re-arm NOTHING');
    expect(block).not.toContain('- Spark Cluster: 0 enabled schedule(s), NO enabled schedules (deaf');
    // ...but a watched resource (live infra monitor) flips it back to DEAF:
    mockWatchedGroupBy.mockResolvedValue([{ projectId: 'p-dorm', _count: { _all: 1 } }]);
    const block2 = await buildFleetLivenessBlock('u1', NOW);
    expect(block2).toContain('- Spark Cluster: 0 enabled schedule(s), NO enabled schedules (deaf unless a run is live)');
  });

  it('a fleet with chats but NO schedules and NO runs anywhere renders nothing (no empty table spam)', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'c1', projectId: 'p1' }]);
    expect(await buildFleetLivenessBlock('u1', NOW)).toBe('');
  });

  it('never throws — a grouped-query failure degrades', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'c1', projectId: 'p1' }]);
    mockSchedGroupBy.mockRejectedValue(new Error('db down'));
    mockRunGroupBy.mockRejectedValue(new Error('db down'));
    expect(await buildFleetLivenessBlock('u1', NOW)).toBe('');
  });

  it('near-cap annotation (ticket b4d1096c): a row ≥90% of its run cap is flagged with its id prefix + fraction; healthy capped rows stay silent', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'c1', projectId: 'p1' }]);
    mockSchedGroupBy.mockResolvedValue([{ sessionId: 'c1', _count: { _all: 2 }, _max: { lastFiredAt: hoursAgo(1) } }]);
    mockProjectFindMany.mockResolvedValue([{ id: 'p1', name: 'CanLaw' }]);
    const far = new Date(NOW.getTime() + 20 * 86_400_000);
    mockSchedFindMany.mockResolvedValue([
      // The field shape the ticket reported: CanLaw's coordinator watch at 482/500.
      { id: '66cee89e-aaaa-4000-8000-000000000001', sessionId: 'c1', kind: 'recurring', runsCount: 482, maxRuns: 500, expiresAt: far },
      // Capped but NOT near — never annotated.
      { id: 'bbbb0001-0000-4000-8000-000000000002', sessionId: 'c1', kind: 'recurring', runsCount: 100, maxRuns: 500, expiresAt: far },
    ]);
    const block = await buildFleetLivenessBlock('u1', NOW);
    expect(block).toContain('⚠ NEAR-CAP: 66cee89e 482/500');
    expect(block).toContain('re-arm pre-emptively');
    expect(block).not.toContain('bbbb0001 100/500');
    // A once-kind row at the same numbers never annotates (its run IS the lifecycle).
    mockSchedFindMany.mockResolvedValue([
      { id: 'cccc0001-0000-4000-8000-000000000003', sessionId: 'c1', kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: far },
    ]);
    expect(await buildFleetLivenessBlock('u1', NOW)).not.toContain('NEAR-CAP');
  });
});
