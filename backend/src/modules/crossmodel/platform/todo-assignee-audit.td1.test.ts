/**
 * TD-1 audit pass (Cluster 5, 2026-11-03) — the measurement half of the gate.
 *
 * The pass exists to answer ONE question before TODO_ASSIGNEE_REQUIRED_ENFORCE
 * is ever armed: how many `in_progress` todos are sitting on the board with no
 * assignee, i.e. work the board says is being done that no lane can fire
 * `todo_done` for.
 *
 * What is pinned here:
 *   (i)   it NEVER mutates — a backfill would have to invent an owner, and
 *         inventing an owner is the exact failure mode TD-1 names (the
 *         reconciliation left seven cluster todos deliberately unassigned
 *         rather than bind them to incidental lanes). So: no update/create/
 *         delete call, ever, and this test asserts that directly.
 *   (ii)  the scan filters on the defect's own shape: status in_progress AND
 *         assigneeChatId null AND old enough that it is not a create still in
 *         flight;
 *   (iii) one metric row per found row, carrying the facts a human pass needs
 *         to decide (ageH, laneCount, backfillable) — never a verdict;
 *   (iv)  the kill switch wins outright;
 *   (v)   it never throws into the worker (fail-soft, cron summary contract).
 */
const auditPrisma: any = {
  projectTodo: { findMany: jest.fn(async () => []) },
  crossModelChat: { count: jest.fn(async () => 0) },
};
const auditMetric = jest.fn();
const auditLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../../../config/database', () => ({ __esModule: true, default: auditPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: auditLogger }));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => auditMetric(...a),
}));

import {
  runTodoAssigneeAuditOnce,
  TODO_ASSIGNEE_AUDIT_MAX_ROWS,
  TODO_ASSIGNEE_AUDIT_MIN_AGE_MS,
} from './todo-assignee-audit';

const NOW = new Date('2026-11-03T22:00:00Z');
const OLD = new Date(NOW.getTime() - 48 * 3600_000);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TODO_ASSIGNEE_AUDIT_DISABLED;
  auditPrisma.projectTodo.findMany.mockResolvedValue([]);
  auditPrisma.crossModelChat.count.mockResolvedValue(0);
});

describe('TD-1 audit pass — unassigned in_progress todos', () => {
  it('(i) NEVER mutates: a scan over real rows issues no write of any kind', async () => {
    auditPrisma.projectTodo.findMany.mockResolvedValue([
      { id: 't1', goalId: 'g1', projectId: 'p1', createdAt: OLD, goal: { id: 'g1', status: 'active' } },
    ]);
    await runTodoAssigneeAuditOnce(NOW);
    // The whole point: an audit that guesses an owner is the defect wearing a fix.
    expect(auditPrisma.projectTodo.update).toBeUndefined();
    expect(auditPrisma.projectTodo.updateMany).toBeUndefined();
    expect(auditPrisma.projectTodo.create).toBeUndefined();
    expect(auditPrisma.projectTodo.delete).toBeUndefined();
    expect(auditPrisma.projectTodo.deleteMany).toBeUndefined();
  });

  it('(ii) scans exactly the defect shape — in_progress, assigneeChatId null, older than the in-flight grace', async () => {
    await runTodoAssigneeAuditOnce(NOW);
    const where = auditPrisma.projectTodo.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('in_progress');
    expect(where.assigneeChatId).toBeNull();
    expect(where.createdAt.lt).toEqual(new Date(NOW.getTime() - TODO_ASSIGNEE_AUDIT_MIN_AGE_MS));
    expect(auditPrisma.projectTodo.findMany.mock.calls[0][0].take).toBe(TODO_ASSIGNEE_AUDIT_MAX_ROWS);
  });

  it('(iii) records one metric row per found row with the facts a human needs, and no verdict', async () => {
    auditPrisma.projectTodo.findMany.mockResolvedValue([
      { id: 't1', goalId: 'g1', projectId: 'p-single', createdAt: OLD, goal: { id: 'g1', status: 'active' } },
      { id: 't2', goalId: 'g2', projectId: 'p-many', createdAt: OLD, goal: { id: 'g2', status: 'active' } },
    ]);
    auditPrisma.crossModelChat.count.mockImplementation(async (q: any) => (q.where.projectId === 'p-single' ? 1 : 3));

    await runTodoAssigneeAuditOnce(NOW);

    expect(auditMetric).toHaveBeenCalledTimes(2);
    const metas = auditMetric.mock.calls.map((c: any[]) => c[0].meta);
    expect(auditMetric.mock.calls.every((c: any[]) => c[0].kind === 'todo_assignee_audit')).toBe(true);

    const single = metas.find((m: any) => m.todoId === 't1');
    // Exactly one candidate lane → mechanically backfillable, reported as a fact.
    expect(single.laneCount).toBe(1);
    expect(single.backfillable).toBe(true);
    expect(single.ageH).toBe(48);
    expect(single.goalStatus).toBe('active');

    const many = metas.find((m: any) => m.todoId === 't2');
    // Several candidate lanes → a judgement call, NOT guessed.
    expect(many.laneCount).toBe(3);
    expect(many.backfillable).toBe(false);
  });

  it('(iii-b) a row under a done/archived goal is counted but not "live" — the honest number to drive to zero', async () => {
    auditPrisma.projectTodo.findMany.mockResolvedValue([
      { id: 't1', goalId: 'g1', projectId: 'p1', createdAt: OLD, goal: { id: 'g1', status: 'active' } },
      { id: 't2', goalId: 'g2', projectId: 'p1', createdAt: OLD, goal: { id: 'g2', status: 'done' } },
    ]);
    const summary = await runTodoAssigneeAuditOnce(NOW);
    expect(summary).toContain('2 unassigned in_progress row(s)');
    expect(summary).toContain('1 live');
    expect(summary.length).toBeLessThanOrEqual(200); // cron_jobs.lastStatus contract
  });

  it('(iv) the kill switch wins outright — no scan, no rows', async () => {
    process.env.TODO_ASSIGNEE_AUDIT_DISABLED = '1';
    const summary = await runTodoAssigneeAuditOnce(NOW);
    expect(summary).toContain('disabled');
    expect(auditPrisma.projectTodo.findMany).not.toHaveBeenCalled();
    expect(auditMetric).not.toHaveBeenCalled();
  });

  it('(v) never throws into the worker — a DB failure still returns a summary', async () => {
    auditPrisma.projectTodo.findMany.mockRejectedValue(new Error('db down'));
    await expect(runTodoAssigneeAuditOnce(NOW)).resolves.toContain('failed');
    expect(auditLogger.warn).toHaveBeenCalled();
  });

  it('reports a clean board without noise', async () => {
    const summary = await runTodoAssigneeAuditOnce(NOW);
    expect(summary).toContain('0 unassigned in_progress row(s)');
    expect(auditMetric).not.toHaveBeenCalled();
  });
});