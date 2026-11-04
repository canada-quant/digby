/**
 * FLEET-PS-FIRST (supervisor SOTA round 2, 2026-10-20) — the fleet [BOARD]
 * gains ONE harness-read line per project: its top goal, the computeGoalEta
 * pace phrase, the KPI register and the age of the project's last move. Pins:
 * the render (pace lines only when the pre-pace block fits; they shrink first
 * and never cut the owner questions), the loader's bounded reads + top-goal
 * pick + last-move derivation, and the kill switch.
 */
const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []) },
  projectGoal: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  agentRun: { findMany: jest.fn(async () => []) },
  codingSchedule: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findFirst: jest.fn(async () => null) },
  systemSetting: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), incr: jest.fn(async () => 1), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  renderFleetBoardBlock, loadFleetGoalPaceLines, FLEET_BOARD_BLOCK_CAP, FLEET_BOARD_PACE_EXTRA_CAP,
  type FleetBoardProject,
} from './board-digest.service';

const NOW = new Date('2026-10-20T12:00:00Z');
const proj = (name: string, projectId: string): FleetBoardProject => ({ name, projectId, activeGoals: 1, blockedGoals: 0, openTodos: 2, blockedTodos: 0, openOwnerQuestions: 0 });
const OQ = [{ id: 'oq_12345678-aaaa-4000-8000-000000000000', status: 'open', createdAt: new Date('2026-10-20T09:00:00Z'), question: 'Ship it?' }];

afterEach(() => {
  delete process.env.FLEET_BOARD_GOAL_PACE_DISABLED;
  delete process.env.GOAL_PRIORITY_ORDER_DISABLED;
  delete process.env.GOAL_SPEND_ATTRIBUTION_DISABLED;
  delete mockPrisma.$queryRawUnsafe;
  delete mockPrisma.goalDependency;
  jest.clearAllMocks();
});

describe('renderFleetBoardBlock — pace lines', () => {
  it('a pace line rides directly under its project\'s count line; no map ⇒ the pre-pace block byte-for-byte', () => {
    const projects = () => [proj('spark', 'p-spark000'), proj('CanLaw', 'p-canlaw00')];
    const base = renderFleetBoardBlock(projects(), OQ, NOW);
    const pace = new Map([['p-spark000', '  ↳ top goal g1234567 "Ship": at the current pace roughly 3 more days · last move 2h ago']]);
    const block = renderFleetBoardBlock(projects(), OQ, NOW, undefined, undefined, pace);
    expect(block).toContain('- spark (p-spark0): 1 active goal(s) · 2 open todo(s) · 0 open owner question(s)\n  ↳ top goal g1234567 "Ship": at the current pace roughly 3 more days · last move 2h ago\nOPEN OWNER QUESTIONS');
    expect(block.replace(/\n  ↳[^\n]*/g, '')).toBe(base);
    expect(renderFleetBoardBlock(projects(), OQ, NOW, undefined, undefined, new Map())).toBe(base);
  });

  it('pace lines shrink from the end of the list first and never push the owner questions out', () => {
    const projects = Array.from({ length: 12 }, (_, i) => proj(`project-${String(i).padStart(2, '0')}`, `p-${String(i).padStart(7, '0')}`));
    const pace = new Map(projects.map((p) => [p.projectId, `  ↳ top goal ${p.projectId} "${'x'.repeat(48)}": ${'at the current pace roughly 9 more days '.repeat(6)}· last move 1h ago`]));
    const block = renderFleetBoardBlock(projects.map((p) => ({ ...p })), OQ, NOW, undefined, undefined, pace);
    expect(block.length).toBeLessThanOrEqual(FLEET_BOARD_BLOCK_CAP + FLEET_BOARD_PACE_EXTRA_CAP);
    expect(block).toContain('OPEN OWNER QUESTIONS (account-wide):\n- oq_12345678 OPEN since');
    expect(block).not.toContain('…[truncated]');
    const kept = (block.match(/\n  ↳ /g) ?? []).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(12);
    expect(block).toContain('↳ top goal p-0000000'); // the first projects keep theirs
    expect(block).not.toContain('↳ top goal p-0000011');
  });

  it('when the block without pace lines already overflows its cap, no pace line is added (the old truncation applies)', () => {
    const projects = Array.from({ length: 30 }, (_, i) => proj(`a-very-long-project-name-${i}`, `p-${String(i).padStart(7, '0')}`));
    const base = renderFleetBoardBlock(projects.map((p) => ({ ...p })), OQ, NOW);
    expect(base.endsWith('…[truncated]')).toBe(true);
    const pace = new Map(projects.map((p) => [p.projectId, '  ↳ top goal x "y": z · no move recorded']));
    expect(renderFleetBoardBlock(projects.map((p) => ({ ...p })), OQ, NOW, undefined, undefined, pace)).toBe(base);
  });
});

describe('loadFleetGoalPaceLines', () => {
  const goals = [
    { id: 'g-kpi0001', projectId: 'p1', title: 'Hit the throughput bar', status: 'active', createdAt: new Date('2026-10-10T00:00:00Z'),
      premises: [{ key: 'kpi:tok_s', value: 5.08, unit: 'tok/s', bar: 10, receiptId: 'f5b42fe6aaaa', setAt: '2026-10-20T10:00:00Z', prev: { value: 4.1 } }] },
    { id: 'g-busy001', projectId: 'p1', title: 'Busy goal', status: 'active', createdAt: new Date('2026-10-01T00:00:00Z'), premises: [] },
    { id: 'g-only001', projectId: 'p2', title: 'Only goal', status: 'blocked', createdAt: new Date('2026-10-01T00:00:00Z'), premises: [] },
  ];

  it('picks the KPI goal, quotes the injected pace phrase + the KPI register, and dates the last move (newest of todo close / KPI change)', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce(goals);
    mockPrisma.projectTodo.groupBy
      .mockResolvedValueOnce([{ goalId: 'g-busy001', _count: { _all: 9 } }, { goalId: 'g-only001', _count: { _all: 1 } }])
      .mockResolvedValueOnce([{ projectId: 'p1', _max: { updatedAt: new Date('2026-10-20T07:00:00Z') } }]);
    mockPrisma.projectTodo.findMany.mockResolvedValueOnce([{ goalId: 'g-kpi0001', status: 'done', updatedAt: new Date('2026-10-20T07:00:00Z') }]);
    const seen: Array<{ id: string; todos: number }> = [];
    const lines = await loadFleetGoalPaceLines(['p1', 'p2'], NOW, {
      goalPace: (g, todos) => { seen.push({ id: g.id, todos: todos.length }); return g.id === 'g-kpi0001' ? 'at the current pace roughly 3 more days' : 'one blocked task is gating progress'; },
    });
    expect(seen).toEqual([{ id: 'g-kpi0001', todos: 1 }, { id: 'g-only001', todos: 0 }]);
    // GOAL-PRIORITY-SPEND (round 3): the P-level rides after the goal id and the KPI gap after the register
    // (no spend clause here — the mock has no $queryRawUnsafe, so the spend read fails open to no clause).
    expect(lines.get('p1')).toBe('  ↳ top goal g-kpi000 [P2] "Hit the throughput bar": at the current pace roughly 3 more days · KPI tok_s=5.08 tok/s (receipt f5b42fe6 · 2h ago · bar ≥10) · last change 4.1→5.08 @10:00Z · KPI gap 4.92 tok/s to bar ≥10 · last move 2h ago');
    expect(lines.get('p2')).toBe('  ↳ top goal g-only00 [P2] "Only goal": one blocked task is gating progress · no move recorded');
    // Bounded reads.
    expect(mockPrisma.projectGoal.findMany.mock.calls[0][0]).toMatchObject({ where: { projectId: { in: ['p1', 'p2'] }, status: { in: ['active', 'blocked'] } }, take: 400 });
    expect(mockPrisma.projectTodo.findMany.mock.calls[0][0]).toMatchObject({ where: { goalId: { in: ['g-kpi0001', 'g-only001'] } }, take: 3000 });
  });

  it('no goals ⇒ empty; a read failure ⇒ empty, never a throw; the kill switch reads nothing', async () => {
    expect((await loadFleetGoalPaceLines(['p1'], NOW, { goalPace: () => 'x' })).size).toBe(0);
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce(goals);
    mockPrisma.projectTodo.groupBy.mockRejectedValueOnce(new Error('db down'));
    mockPrisma.projectTodo.findMany.mockRejectedValueOnce(new Error('db down'));
    const partial = await loadFleetGoalPaceLines(['p1'], NOW, { goalPace: () => 'no movement in the last week, so no reliable estimate' });
    expect(partial.get('p1')).toContain('top goal g-kpi000');
    jest.clearAllMocks();
    process.env.FLEET_BOARD_GOAL_PACE_DISABLED = '1';
    expect((await loadFleetGoalPaceLines(['p1'], NOW, { goalPace: () => 'x' })).size).toBe(0);
    expect(mockPrisma.projectGoal.findMany).not.toHaveBeenCalled();
  });
});

describe('loadFleetGoalPaceLines — GOAL-PRIORITY-SPEND (round 3)', () => {
  const ranked = [
    { id: 'g-kpi0001', projectId: 'p1', title: 'Hit the throughput bar', status: 'active', createdAt: new Date('2026-10-10T00:00:00Z'),
      premises: [{ key: 'kpi:tok_s', value: 5.08, unit: 'tok/s', bar: 10, receiptId: 'f5b42fe6aaaa', setAt: '2026-10-20T10:00:00Z' }] },
    { id: 'g-p1own01', projectId: 'p1', title: 'Owner priority', status: 'active', priority: 1, prioritySource: 'owner', createdAt: new Date('2026-10-19T00:00:00Z'), premises: [] },
  ];

  it('the owner-set P1 goal outranks the KPI goal; the line carries "[P1 owner]" and the attributed 7d $', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce(ranked);
    mockPrisma.$queryRawUnsafe = jest.fn(async () => [{ goal_id: 'g-p1own01', usd: 41.2, runs: 7, stamped: 5 }]);
    const lines = await loadFleetGoalPaceLines(['p1'], NOW, { goalPace: () => 'at the current pace roughly 2 more days' });
    expect(lines.get('p1')).toBe('  ↳ top goal g-p1own0 [P1 owner] "Owner priority": at the current pace roughly 2 more days · 7d $41.20 · no move recorded');
    // The spend read is bounded to the top goals and the 7-day window.
    const [sql, since, ids] = mockPrisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain("lm.kind = 'run_spend'");
    expect(ids).toEqual(['g-p1own01']);
    expect(NOW.getTime() - (since as Date).getTime()).toBe(7 * 24 * 3600_000);
  });

  it('review fix: a top goal with no attributed row reads "7d $0.00" only when a lane is chartered to it — otherwise no clause (never a false $0); the read is project-scoped', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce(ranked);
    mockPrisma.$queryRawUnsafe = jest.fn(async () => []);
    const unknown = await loadFleetGoalPaceLines(['p1'], NOW, { goalPace: () => 'at the current pace roughly 2 more days' });
    expect(unknown.get('p1')).toBe('  ↳ top goal g-p1own0 [P1 owner] "Owner priority": at the current pace roughly 2 more days · no move recorded');
    const spendCall = mockPrisma.$queryRawUnsafe.mock.calls.find((c: any[]) => String(c[0]).includes("lm.kind = 'run_spend'"));
    expect(spendCall[3]).toEqual(['p1']);
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce(ranked);
    mockPrisma.$queryRawUnsafe = jest.fn(async (sql: string) => (sql.includes('SELECT DISTINCT') ? [{ goal_id: 'g-p1own01' }] : []));
    const idle = await loadFleetGoalPaceLines(['p1'], NOW, { goalPace: () => 'at the current pace roughly 2 more days' });
    expect(idle.get('p1')).toContain(' · 7d $0.00 · ');
  });

  it('GOAL_PRIORITY_ORDER_DISABLED=1: the pre-change pick (the KPI goal) and no P-level / KPI gap; GOAL_SPEND_ATTRIBUTION_DISABLED=1: no spend read', async () => {
    process.env.GOAL_PRIORITY_ORDER_DISABLED = '1';
    process.env.GOAL_SPEND_ATTRIBUTION_DISABLED = '1';
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce(ranked);
    mockPrisma.$queryRawUnsafe = jest.fn(async () => []);
    const lines = await loadFleetGoalPaceLines(['p1'], NOW, { goalPace: () => 'at the current pace roughly 3 more days' });
    expect(lines.get('p1')).toBe('  ↳ top goal g-kpi000 "Hit the throughput bar": at the current pace roughly 3 more days · KPI tok_s=5.08 tok/s (receipt f5b42fe6 · 2h ago · bar ≥10) · no move recorded');
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
