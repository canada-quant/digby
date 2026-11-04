/**
 * lane-self-driving.ts — SUP-WAKE-TIERS (2) / ALARM-CAUSE-AWARE (3): is a lane
 * still driving itself? (a live run, a schedule armed soon — never an assigned
 * todo on its own). Prisma is mocked; the predicate is the real one.
 */

const mockPrisma: any = {
  agentRun: { findMany: jest.fn() },
  codingSchedule: { findMany: jest.fn() },
  projectTodo: { findMany: jest.fn() },
  todoDependency: { findMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import {
  SELF_DRIVING_ARMED_HORIZON_MS, SELF_DRIVING_MAX_LANES, allLanesSelfDriving, dedupeLaneIds, isLaneSelfDriving, laneDriveFactsFromRows, readLaneDriveFacts,
} from './lane-self-driving';

const NOW = new Date('2026-10-20T12:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.todoDependency.findMany.mockResolvedValue([]);
});

describe('pure', () => {
  it.each([
    [{ liveRun: true, armedSoon: false }, true],
    [{ liveRun: false, armedSoon: true }, true],
    [{ liveRun: false, armedSoon: false }, false],
  ])('isLaneSelfDriving(%j) → %s', (facts, expected) => {
    expect(isLaneSelfDriving(facts)).toBe(expected);
  });

  it('review fix 2026-10-20: an assigned todo alone never drives a lane (in_progress + no run + no schedule is the STALL shape)', () => {
    // A legacy caller handing the old fact shape still gets the run / schedule verdict only.
    expect(isLaneSelfDriving({ liveRun: false, armedSoon: false, actionableTodo: true } as any)).toBe(false);
  });

  it('facts from rows: queued always counts, running unless countRunning:false (the emitting run), any matching schedule row is armed', () => {
    const rows = {
      runs: [{ sessionId: 'a', status: 'running' }, { sessionId: 'b', status: 'queued' }],
      schedules: [{ sessionId: 'c' }],
    };
    const by = (facts: ReturnType<typeof laneDriveFactsFromRows>) => Object.fromEntries(facts.map((f) => [f.chatId, isLaneSelfDriving(f)]));
    expect(by(laneDriveFactsFromRows(['a', 'b', 'c', 'd'], rows))).toEqual({ a: true, b: true, c: true, d: false });
    expect(by(laneDriveFactsFromRows(['a', 'b'], rows, { countRunning: false }))).toEqual({ a: false, b: true });
  });

  it('dedupeLaneIds keeps first-seen order and drops empties', () => {
    expect(dedupeLaneIds(['b', 'a', 'b', '', 'c'])).toEqual(['b', 'a', 'c']);
  });
});

describe('reads', () => {
  it('bounds the armed-schedule read to now + 30 min (null = any enabled schedule); dedupes ids; an empty set reads nothing; todos are never read', async () => {
    mockPrisma.agentRun.findMany.mockResolvedValue([{ sessionId: 'lane-1', status: 'running' }]);
    const facts = await readLaneDriveFacts(['lane-1', 'lane-1', 'lane-2'], NOW);
    expect(facts.map((f) => f.chatId)).toEqual(['lane-1', 'lane-2']);
    expect(mockPrisma.codingSchedule.findMany.mock.calls[0][0].where).toMatchObject({ enabled: true, nextRunAt: { lte: new Date(NOW.getTime() + SELF_DRIVING_ARMED_HORIZON_MS) } });
    await readLaneDriveFacts(['lane-1'], NOW, { horizonMs: null });
    expect(mockPrisma.codingSchedule.findMany.mock.calls[1][0].where.nextRunAt).toBeUndefined();
    expect(mockPrisma.projectTodo.findMany).not.toHaveBeenCalled();
    mockPrisma.agentRun.findMany.mockClear();
    expect(await readLaneDriveFacts([], NOW)).toEqual([]);
    expect(mockPrisma.agentRun.findMany).not.toHaveBeenCalled();
  });

  it('allLanesSelfDriving: EVERY lane must drive itself; an empty set is false; a DB error throws (the caller delivers)', async () => {
    mockPrisma.agentRun.findMany.mockResolvedValue([{ sessionId: 'lane-1', status: 'queued' }]);
    expect((await allLanesSelfDriving(['lane-1'], NOW)).selfDriving).toBe(true);
    expect((await allLanesSelfDriving(['lane-1', 'lane-2'], NOW)).selfDriving).toBe(false);
    expect((await allLanesSelfDriving([], NOW)).selfDriving).toBe(false);
    mockPrisma.codingSchedule.findMany.mockRejectedValue(new Error('db down'));
    await expect(allLanesSelfDriving(['lane-2'], NOW)).rejects.toThrow('db down');
  });

  it('review fix 2026-10-20: an idle lane holding an in_progress todo, no run and no schedule is NOT self-driving', async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValue([{ id: 't1', status: 'in_progress', assigneeChatId: 'lane-1' }]);
    expect((await allLanesSelfDriving(['lane-1'], NOW)).selfDriving).toBe(false);
  });

  it(`review fix 2026-10-20: more than ${SELF_DRIVING_MAX_LANES} lanes is never "every lane" — nothing is read, the answer is false + truncated`, async () => {
    // Every lane is busy — but lane 51 would go unchecked, so the set is refused (fail toward delivery).
    const ids = Array.from({ length: SELF_DRIVING_MAX_LANES + 1 }, (_, i) => `lane-${i}`);
    mockPrisma.agentRun.findMany.mockResolvedValue(ids.map((sessionId) => ({ sessionId, status: 'queued' })));
    const res = await allLanesSelfDriving(ids, NOW);
    expect(res).toEqual({ selfDriving: false, lanes: [], truncated: true });
    expect(mockPrisma.agentRun.findMany).not.toHaveBeenCalled();
    // Exactly the bound (duplicates collapse first) still reads and judges every lane.
    const bound = [...ids.slice(0, SELF_DRIVING_MAX_LANES), 'lane-0'];
    expect((await allLanesSelfDriving(bound, NOW)).selfDriving).toBe(true);
  });
});
