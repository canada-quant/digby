/**
 * GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20) — per-goal spend
 * attribution, the prisma half. Pins: the run's goal (the in-progress todo,
 * else the todo a continuation wake names, else charterGoalId, else the
 * charter todo's goal; none / switched off / read error ⇒ null), the shared
 * attribution predicate (stamp first; the charter fallback is project-scoped,
 * mirrors the charter todo's goal and stops at a charter goal rebind), and the
 * bounded fail-open spend read (null = no clause; only a KNOWN goal reads $0).
 */
const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn() },
  projectTodo: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
  $queryRawUnsafe: jest.fn(),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { resolveRunGoalId, goalSpendPredicate, loadGoalSpend, knownGoalSpendUsd, continuationTodoTitles, GOAL_SPEND_MAX_GOALS } from './goal-spend';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  delete process.env.GOAL_SPEND_ATTRIBUTION_DISABLED;
});

describe('resolveRunGoalId', () => {
  it('the charter goal; else the charter todo\'s goal; else null', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ charterGoalId: 'g-charter', charterTodoId: 't-1' });
    expect(await resolveRunGoalId('lane-1')).toBe('g-charter');
    expect(mockPrisma.projectTodo.findUnique).not.toHaveBeenCalled();
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ charterGoalId: null, charterTodoId: 't-1' });
    mockPrisma.projectTodo.findUnique.mockResolvedValueOnce({ goalId: 'g-of-todo' });
    expect(await resolveRunGoalId('lane-1')).toBe('g-of-todo');
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ charterGoalId: null, charterTodoId: null });
    expect(await resolveRunGoalId('sup-1')).toBeNull();
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce(null);
    expect(await resolveRunGoalId('gone')).toBeNull();
  });

  it('review fix: the todo the lane is WORKING wins over the charter — its in-progress todo, else the todo a continuation wake names', async () => {
    // Lane chartered to goal A holds an in-progress todo of goal B ⇒ B (the continuation picked B's higher-scored todo).
    mockPrisma.projectTodo.findMany.mockResolvedValueOnce([
      { id: 't-a', title: 'A work', status: 'pending', goalId: 'g-A' },
      { id: 't-b', title: 'B work', status: 'in_progress', goalId: 'g-B' },
    ]);
    expect(await resolveRunGoalId('lane-1')).toBe('g-B');
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.projectTodo.findMany.mock.calls[0][0]).toMatchObject({ where: { assigneeChatId: 'lane-1', status: { in: ['in_progress', 'pending'] } } });
    // The continuation run starts before the lane flips the todo in_progress: the wake's `Todo: "…"` names it.
    const wake = '[Fleet goal board — this lane finished its run with 2 pending todo(s) still assigned to it and nothing scheduled]\nTodo: "B work"\nGoal: "Goal B"\n';
    mockPrisma.projectTodo.findMany.mockResolvedValueOnce([
      { id: 't-a', title: 'A work', status: 'pending', goalId: 'g-A' },
      { id: 't-b', title: 'B  Work', status: 'pending', goalId: 'g-B' },
    ]);
    expect(await resolveRunGoalId('lane-1', { message: wake })).toBe('g-B');
    // Any other message (a schedule firing) ⇒ the charter.
    mockPrisma.projectTodo.findMany.mockResolvedValueOnce([{ id: 't-b', title: 'B work', status: 'pending', goalId: 'g-B' }]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ charterGoalId: 'g-A', charterTodoId: null });
    expect(await resolveRunGoalId('lane-1', { message: 'Todo: "B work"' })).toBe('g-A');
  });

  it('a read error ⇒ null (never throws); a todo read error falls through to the charter; switched off ⇒ null with no read', async () => {
    mockPrisma.projectTodo.findMany.mockRejectedValueOnce(new Error('db down'));
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ charterGoalId: 'g-charter', charterTodoId: null });
    expect(await resolveRunGoalId('lane-1')).toBe('g-charter');
    mockPrisma.crossModelChat.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await resolveRunGoalId('lane-1')).toBeNull();
    process.env.GOAL_SPEND_ATTRIBUTION_DISABLED = '1';
    expect(await resolveRunGoalId('lane-1')).toBeNull();
    expect(await resolveRunGoalId(null)).toBeNull();
    expect(mockPrisma.crossModelChat.findUnique).toHaveBeenCalledTimes(2);
  });

  it('continuationTodoTitles reads only a lane-continuation wake', () => {
    expect(continuationTodoTitles('… this lane finished its run with 1 pending …\nTodo: "Fix "quoted" title"\nGoal: "g"')).toEqual(['Fix "quoted" title']);
    expect(continuationTodoTitles('Todo: "x"')).toEqual([]);
    expect(continuationTodoTitles(undefined)).toEqual([]);
  });
});

describe('goalSpendPredicate', () => {
  it('stamped rows match by meta.goalId; unstamped rows fall back to the project\'s chats chartered to the goal (or its charter todo) since their last goal rebind', () => {
    const p = goalSpendPredicate(3, 4);
    expect(p).toContain("lm.meta->>'goalId' = ANY($3::text[])");
    expect(p).toContain("lm.meta->>'goalId' IS NULL");
    // Review fix: scoped by the INDEXED projectId (charterGoalId is unindexed — no full chats scan per board render).
    expect(p).toContain('gsc."projectId" = ANY($4::text[])');
    expect(p).toContain('gsc."charterGoalId" = ANY($3::text[])');
    // Review fix: mirrors resolveRunGoalId's charter-todo fallback.
    expect(p).toContain('gsc."charterGoalId" IS NULL AND gst."goalId" = ANY($3::text[])');
    // Review fix: a charter goal rebind never drags the old goal's unstamped spend onto the new goal.
    expect(p).toContain("gsr.kind = 'charter_rebind'");
    expect(p).toContain("gsr.meta->>'goalRebound' = 'true'");
    expect(p).toContain('gsr."createdAt" > lm."createdAt"');
  });
});

describe('loadGoalSpend', () => {
  const since = new Date('2026-10-13T12:00:00Z');
  const route = (spendRows: any[], chartered: any[] = []) => mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => (sql.includes('SELECT DISTINCT') ? chartered : spendRows));

  it('goalId → {usd, runs, stampedRuns}; only the asked ids; ids de-duplicated and bounded; project-scoped', async () => {
    route([
      { goal_id: 'g1', usd: 12.5, runs: 4, stamped: 3 },
      { goal_id: 'g-other', usd: 99, runs: 1, stamped: 1 },
      { goal_id: null, usd: 1, runs: 1, stamped: 0 },
    ]);
    const m = await loadGoalSpend(['g1', 'g1', 'g2'], since, { projectIds: ['p1', 'p1'] });
    expect(m && [...m.byGoal]).toEqual([['g1', { usd: 12.5, runs: 4, stampedRuns: 3 }]]);
    const spendCall = mockPrisma.$queryRawUnsafe.mock.calls.find((c: any[]) => String(c[0]).includes("lm.kind = 'run_spend'"));
    const [sql, at, ids, projectIds] = spendCall;
    expect(sql).toContain('GROUP BY 1');
    expect(sql).toContain('COALESCE(lm.meta->>\'goalId\', c."charterGoalId", t."goalId")');
    expect(at).toBe(since);
    expect(ids).toEqual(['g1', 'g2']);
    expect(projectIds).toEqual(['p1']);
    mockPrisma.$queryRawUnsafe.mockClear();
    route([]);
    await loadGoalSpend(Array.from({ length: 100 }, (_, i) => `g${i}`), since, { projectIds: ['p1'] });
    expect(mockPrisma.$queryRawUnsafe.mock.calls.find((c: any[]) => String(c[0]).includes("lm.kind = 'run_spend'"))[2]).toHaveLength(GOAL_SPEND_MAX_GOALS);
  });

  it('review fix: a goal reads $0 only when KNOWN (a chartered lane or an attributed row) — otherwise no figure, never a false $0', async () => {
    route([{ goal_id: 'g-spent', usd: 4, runs: 2, stamped: 2 }], [{ goal_id: 'g-chartered-idle' }, { goal_id: 'g-not-asked' }]);
    const r = await loadGoalSpend(['g-spent', 'g-chartered-idle', 'g-unchartered'], since, { projectIds: ['p1'] });
    expect(knownGoalSpendUsd(r, 'g-spent')).toBe(4);
    expect(knownGoalSpendUsd(r, 'g-chartered-idle')).toBe(0);
    expect(knownGoalSpendUsd(r, 'g-unchartered')).toBeNull();
    expect(knownGoalSpendUsd(r, 'g-not-asked')).toBeNull();
    expect(knownGoalSpendUsd(null, 'g-spent')).toBeNull();
    // Past the read cap a goal was never read ⇒ unknown, not $0.
    route([], Array.from({ length: 100 }, (_, i) => ({ goal_id: `g${i}` })));
    const capped = await loadGoalSpend(Array.from({ length: 100 }, (_, i) => `g${i}`), since, { projectIds: ['p1'] });
    expect(knownGoalSpendUsd(capped, 'g0')).toBe(0);
    expect(knownGoalSpendUsd(capped, 'g99')).toBeNull();
    // A failed chartered read shrinks `known` to the goals with rows (still no false $0).
    mockPrisma.$queryRawUnsafe.mockImplementation(async (sql: string) => { if (sql.includes('SELECT DISTINCT')) throw new Error('db'); return [{ goal_id: 'g1', usd: 1, runs: 1, stamped: 1 }]; });
    const partial = await loadGoalSpend(['g1', 'g2'], since, { projectIds: ['p1'] });
    expect([...(partial?.known ?? [])]).toEqual(['g1']);
  });

  it('no ids ⇒ an empty read with no query; a read error or the switch ⇒ null (the board renders no clause)', async () => {
    expect(await loadGoalSpend([], since, { projectIds: ['p1'] })).toEqual({ byGoal: new Map(), known: new Set() });
    expect(mockPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
    mockPrisma.$queryRawUnsafe.mockRejectedValue(new Error('db down'));
    expect(await loadGoalSpend(['g1'], since, { projectIds: ['p1'] })).toBeNull();
    const calls = mockPrisma.$queryRawUnsafe.mock.calls.length;
    process.env.GOAL_SPEND_ATTRIBUTION_DISABLED = '1';
    expect(await loadGoalSpend(['g1'], since, { projectIds: ['p1'] })).toBeNull();
    expect(mockPrisma.$queryRawUnsafe.mock.calls.length).toBe(calls);
  });
});
