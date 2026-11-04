/**
 * BOARD — GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20).
 *  - tracked goals render RANKED by score (owner-set P1..P4 + accrual; ties
 *    keep the loader's creation order) and each line LEADS with "[P1 · 82]"
 *    (" owner" when the owner set it), plus the goal's attributed "7d $";
 *  - open todos rank by their goal's score inside each status band;
 *  - the ranking text folds FIRST (spend → score → label) and the fully folded
 *    rendering equals the kill-switched one (same order) — ON never cuts a
 *    line OFF keeps;
 *  - GOAL_PRIORITY_ORDER_DISABLED=1 renders the creation order with no prefix;
 *    GOAL_SPEND_ATTRIBUTION_DISABLED=1 drops the spend clause;
 *  - loadGoalRankingFacts: the unblock counts + the 7-day spend read, both
 *    skipped under their switches and fail-open; review fix 2026-10-20: the
 *    spend read is project-scoped, takes the goals in RANK order (the cap
 *    keeps the ones on screen) and only a KNOWN goal gets a figure.
 */
const mockPrisma: any = {
  goalDependency: { findMany: jest.fn(async () => []) },
  projectGoal: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), incr: jest.fn(async () => 1), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { renderProjectBoardBlock, loadGoalRankingFacts, BOARD_BLOCK_CAP, type BoardFacts } from './board-digest.service';

const NOW = new Date('2026-10-20T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const uuid = (seed: string) => `${seed.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`;

const facts = (over: Partial<BoardFacts> = {}): BoardFacts => ({
  projectName: 'tt-rd',
  now: NOW,
  goals: [
    { id: uuid('gfirst00'), title: 'Oldest goal', status: 'active', createdAt: hoursAgo(10), spendUsd: 3 },
    { id: uuid('gmachp3'), title: 'Machine P3', status: 'active', priority: 3, prioritySource: 'machine', createdAt: hoursAgo(9), spendUsd: 0 },
    { id: uuid('gownerp1'), title: 'Owner P1', status: 'active', priority: 1, prioritySource: 'owner', createdAt: hoursAgo(8), spendUsd: 12.4 },
    { id: uuid('gdone000'), title: 'Done', status: 'done', createdAt: hoursAgo(20) },
  ],
  todos: [
    { id: uuid('tlowpend'), goalId: uuid('gmachp3'), title: 'P3 work', status: 'pending', updatedAt: hoursAgo(1) },
    { id: uuid('thipend0'), goalId: uuid('gownerp1'), title: 'P1 work', status: 'pending', updatedAt: hoursAgo(5) },
    { id: uuid('tinprog0'), goalId: uuid('gmachp3'), title: 'In flight', status: 'in_progress', updatedAt: hoursAgo(2) },
  ],
  ownerQuestions: [],
  ...over,
});

const goalLines = (b: string) => b.split('\n').filter((l) => / goal [0-9a-z]{8} \[(active|blocked)\]/.test(l));

beforeEach(() => {
  delete process.env.GOAL_PRIORITY_ORDER_DISABLED;
  delete process.env.GOAL_SPEND_ATTRIBUTION_DISABLED;
  jest.clearAllMocks();
  delete mockPrisma.$queryRawUnsafe;
});

describe('renderProjectBoardBlock — ranked goals', () => {
  it('ranks by score, leads each line with [P-level · score], quotes the 7d spend, and notes the ranking in the GOALS header', () => {
    const block = renderProjectBoardBlock(facts());
    expect(block).toContain('GOALS: 3 active/blocked · 1 done · 0 archived · ranked by [priority · score], P1 highest');
    expect(goalLines(block)).toEqual([
      '- [P1 owner · 80] goal gownerp1 [active] "Owner P1" · 7d $12.40 · todos 1 open/0 done',
      '- [P2 · 60] goal gfirst00 [active] "Oldest goal" · 7d $3.00 · todos 0 open/0 done · UNPLANNED',
      '- [P3 · 40] goal gmachp30 [active] "Machine P3" · 7d $0.00 · todos 2 open/0 done',
    ]);
  });

  it('open todos rank by their goal\'s score inside each status band (in_progress still first)', () => {
    const todoLines = renderProjectBoardBlock(facts()).split('\n').filter((l) => l.startsWith('- todo '));
    expect(todoLines.map((l) => l.slice(0, 15))).toEqual(['- todo tinprog0', '- todo thipend0', '- todo tlowpend']);
  });

  it('GOAL_PRIORITY_ORDER_DISABLED=1: creation order, no prefix, no header note, todos by recency; GOAL_SPEND_ATTRIBUTION_DISABLED=1: no spend clause', () => {
    process.env.GOAL_PRIORITY_ORDER_DISABLED = '1';
    process.env.GOAL_SPEND_ATTRIBUTION_DISABLED = '1';
    const block = renderProjectBoardBlock(facts());
    expect(block).toContain('GOALS: 3 active/blocked · 1 done · 0 archived\n');
    expect(goalLines(block)).toEqual([
      '- goal gfirst00 [active] "Oldest goal" · todos 0 open/0 done · UNPLANNED',
      '- goal gmachp30 [active] "Machine P3" · todos 2 open/0 done',
      '- goal gownerp1 [active] "Owner P1" · todos 1 open/0 done',
    ]);
    const todoLines = block.split('\n').filter((l) => l.startsWith('- todo '));
    expect(todoLines.map((l) => l.slice(0, 15))).toEqual(['- todo tinprog0', '- todo tlowpend', '- todo thipend0']);
    delete process.env.GOAL_PRIORITY_ORDER_DISABLED;
    expect(renderProjectBoardBlock(facts())).not.toContain('7d $');
  });

  it('an unknown spend (the read failed) renders no clause — never a false "$0"', () => {
    const f = facts();
    f.goals = f.goals.map((g) => ({ ...g, spendUsd: undefined }));
    expect(renderProjectBoardBlock(f)).not.toContain('7d $');
  });

  it('the ranking text folds FIRST (spend → score → label); fully folded it equals the kill-switched board and never cuts a line OFF keeps', () => {
    // 12 unranked goals (equal scores ⇒ the same order both ways) + 20 long todos; `pad` pushes toward the cap.
    const pressure = (pad: number): BoardFacts => {
      const goals = Array.from({ length: 12 }, (_, i) => ({ id: uuid(`g${String(i).padStart(3, '0')}x`), title: `Goal number ${i} ${'g'.repeat(pad)}`, status: 'active', createdAt: hoursAgo(50 - i), spendUsd: 1.5 * i }));
      const todos = Array.from({ length: 20 }, (_, i) => ({ id: uuid(`t${String(i).padStart(3, '0')}x`), goalId: goals[i % 6].id, title: `Todo ${i} ${'y'.repeat(70)}`, status: 'pending', updatedAt: hoursAgo(i + 1) }));
      return facts({ goals, todos });
    };
    const both = (pad: number) => {
      process.env.GOAL_PRIORITY_ORDER_DISABLED = '1';
      process.env.GOAL_SPEND_ATTRIBUTION_DISABLED = '1';
      const off = renderProjectBoardBlock(pressure(pad));
      delete process.env.GOAL_PRIORITY_ORDER_DISABLED;
      delete process.env.GOAL_SPEND_ATTRIBUTION_DISABLED;
      return { on: renderProjectBoardBlock(pressure(pad)), off };
    };
    const lines = (b: string, re: RegExp) => b.split('\n').filter((l) => re.test(l)).length;
    expect(both(0).on).toContain('· 7d $');
    let sawSpendFolded = false;
    let sawScoreFolded = false;
    for (let pad = 0; pad <= 70; pad += 2) {
      const r = both(pad);
      expect(r.on.length).toBeLessThanOrEqual(BOARD_BLOCK_CAP);
      expect(lines(r.on, /^- todo /)).toBe(lines(r.off, /^- todo /));
      expect(lines(r.on, / goal [0-9a-z]{8} \[active\]/)).toBe(lines(r.off, / goal [0-9a-z]{8} \[active\]/));
      if (!r.on.includes('7d $') && r.on.includes('[P2 · 60]')) sawSpendFolded = true;
      if (!r.on.includes('[P2 · 60]') && r.on.includes('[P2] goal')) sawScoreFolded = true;
    }
    expect(sawSpendFolded).toBe(true);
    expect(sawScoreFolded).toBe(true);
    const tight = both(70);
    expect(tight.on).toBe(tight.off);
  });
});

describe('loadGoalRankingFacts', () => {
  const goals = [{ id: 'ga', status: 'active' }, { id: 'gb', status: 'blocked' }, { id: 'gd', status: 'done' }];

  it('counts OPEN dependents per tracked goal and reads the tracked goals\' 7-day attributed spend', async () => {
    mockPrisma.goalDependency.findMany.mockResolvedValueOnce([{ goalId: 'x1', dependsOnGoalId: 'ga' }, { goalId: 'x2', dependsOnGoalId: 'ga' }, { goalId: 'x3', dependsOnGoalId: 'gb' }]);
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([{ id: 'x1', status: 'active' }, { id: 'x2', status: 'done' }, { id: 'x3', status: 'blocked' }]);
    mockPrisma.$queryRawUnsafe = jest.fn(async (sql: string) => (sql.includes('SELECT DISTINCT') ? [] : [{ goal_id: 'ga', usd: 7.25, runs: 3, stamped: 1 }]));
    const r = await loadGoalRankingFacts(goals, NOW, { projectIds: ['proj-1'] });
    expect([...r.unblock]).toEqual([['ga', 1], ['gb', 1]]);
    expect(r.spend?.byGoal.get('ga')).toEqual({ usd: 7.25, runs: 3, stampedRuns: 1 });
    expect([...(r.spend?.known ?? [])]).toEqual(['ga']);
    expect(mockPrisma.goalDependency.findMany.mock.calls[0][0]).toMatchObject({ where: { dependsOnGoalId: { in: ['ga', 'gb'] } } });
    const spendCall = mockPrisma.$queryRawUnsafe.mock.calls.find((c: any[]) => String(c[0]).includes("lm.kind = 'run_spend'"));
    const [, since, ids, projectIds] = spendCall;
    expect(ids).toEqual(['ga', 'gb']);
    expect(projectIds).toEqual(['proj-1']);
    expect(NOW.getTime() - (since as Date).getTime()).toBe(7 * 24 * 3600_000);
  });

  it('review fix: over the read cap the spend read takes the goals in RANK order — the ones the board renders', async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ id: `g${String(i).padStart(2, '0')}`, status: 'active', createdAt: hoursAgo(100 - i) } as any));
    many[69] = { ...many[69], priority: 1, prioritySource: 'owner' }; // the newest goal is the owner's P1 — rank 1 on the board
    mockPrisma.$queryRawUnsafe = jest.fn(async () => []);
    await loadGoalRankingFacts(many, NOW, { projectIds: ['proj-1'] });
    const spendCall = mockPrisma.$queryRawUnsafe.mock.calls.find((c: any[]) => String(c[0]).includes("lm.kind = 'run_spend'"));
    expect(spendCall[2]).toHaveLength(60);
    expect(spendCall[2][0]).toBe('g69');
  });

  it('fails open (empty counts, null spend) and the switches skip their reads', async () => {
    mockPrisma.goalDependency.findMany.mockRejectedValueOnce(new Error('db down'));
    mockPrisma.$queryRawUnsafe = jest.fn(async () => { throw new Error('db down'); });
    const r = await loadGoalRankingFacts(goals, NOW);
    expect(r.unblock.size).toBe(0);
    expect(r.spend).toBeNull();
    jest.clearAllMocks();
    process.env.GOAL_PRIORITY_ORDER_DISABLED = '1';
    process.env.GOAL_SPEND_ATTRIBUTION_DISABLED = '1';
    const off = await loadGoalRankingFacts(goals, NOW);
    expect(off.spend).toBeNull();
    expect(mockPrisma.goalDependency.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
