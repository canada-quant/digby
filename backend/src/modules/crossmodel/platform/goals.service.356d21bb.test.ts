/**
 * Ticket 356d21bb — unblockOwnerGatedItems (goals.service): the ONE choke
 * point every owner-answer path fans out to. Pins with a stateful fake
 * Prisma:
 *   - a todo blocked with gateQuestionId = the answered row flips to
 *     'pending' with blockedReason + blockKind + gateQuestionId cleared
 *     TOGETHER, a progressNote citing the answer, and an 'unblocked' assignee
 *     wake (the durable hook lane);
 *   - a goal likewise flips to 'active' (no wake — goals have no assignee);
 *   - rows gated on a DIFFERENT question, or not 'blocked', are untouched;
 *   - a lost conditional-flip race (updateMany count 0) wakes nothing;
 *   - NEVER THROWS: a prisma failure resolves with zero counts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stateful fake DB ─────────────────────────────────────────────────────────
const todoRows: any[] = [];
const goalRows: any[] = [];
const matchWhere = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
const table = (rows: any[]) => ({
  findMany: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matchWhere(r, where))),
  findUnique: jest.fn(async ({ where }: any) => rows.find((r) => matchWhere(r, where)) ?? null),
  updateMany: jest.fn(async ({ where, data }: any) => {
    const m = rows.filter((r) => matchWhere(r, where));
    m.forEach((r) => Object.assign(r, data));
    return { count: m.length };
  }),
});
const mockPrisma: any = {
  projectTodo: table(todoRows),
  projectGoal: table(goalRows),
  activity: { create: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// wakeTodoAssignee: Redis debounce (SET NX OK) → the durable hook lane.
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), get: jest.fn(async () => null) },
}));
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));

// error-handler imports config/env → process.exit at import without env vars.
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// folder-inheritance (real) pulls context-store — mock it.
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));

import { unblockOwnerGatedItems } from './goals.service';

beforeEach(() => {
  todoRows.length = 0;
  goalRows.length = 0;
  mockPrisma.activity.create.mockClear();
  mockEnqueueDirectWake.mockReset().mockResolvedValue({ ok: true, hookEventId: 'he-1' });
  mockPrisma.projectTodo.findMany.mockClear();
  mockPrisma.projectGoal.findMany.mockClear();
});

const blockedTodo = (over: any = {}) => ({
  id: 't1', userId: 'u1', goalId: 'g1', projectId: 'p1', title: 'Ship the thing',
  status: 'blocked', blockedReason: 'Waiting on the owner (gate oq_1)', blockKind: 'owner',
  gateQuestionId: 'oq_1', progressNote: null, assigneeChatId: 'lane-1', ...over,
});
const blockedGoal = (over: any = {}) => ({
  id: 'g1', userId: 'u1', projectId: 'p1', title: 'Goal', status: 'blocked',
  blockedReason: 'Waiting on the owner (gate oq_1)', blockKind: 'owner', gateQuestionId: 'oq_1',
  progressNote: null, ...over,
});
const call = () => unblockOwnerGatedItems({
  userId: 'u1', questionId: 'oq_1', question: 'Which region?', answer: 'ca-central-1', source: 'owner inbox answer',
});

describe('356d21bb — unblockOwnerGatedItems', () => {
  it('todo gated on the answered question → pending, all gate fields cleared together, progressNote cites the answer, assignee woken', async () => {
    todoRows.push(blockedTodo());
    const out = await call();
    expect(out).toEqual({ todos: 1, goals: 0, heldTodos: 0, heldGoals: 0 });
    const t = todoRows[0];
    expect(t.status).toBe('pending');
    expect(t.blockedReason).toBeNull();
    expect(t.blockKind).toBeNull();
    expect(t.gateQuestionId).toBeNull();
    expect(t.progressNote).toContain('ca-central-1');
    expect(t.progressNote).toContain('356d21bb');
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(mockEnqueueDirectWake).toHaveBeenCalledWith(
      expect.objectContaining({ targetChatId: 'lane-1', meta: expect.objectContaining({ todoId: 't1', trigger: 'unblocked' }) }),
    );
    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'todo.owner_gate_unblock' }) }),
    );
  });

  it('goal gated on the answered question → active, fields cleared, audited, NO wake', async () => {
    goalRows.push(blockedGoal());
    const out = await call();
    expect(out).toEqual({ todos: 0, goals: 1, heldTodos: 0, heldGoals: 0 });
    const g = goalRows[0];
    expect(g.status).toBe('active');
    expect(g.blockedReason).toBeNull();
    expect(g.blockKind).toBeNull();
    expect(g.gateQuestionId).toBeNull();
    expect(g.progressNote).toContain('ca-central-1');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'goal.owner_gate_unblock' }) }),
    );
  });

  it('rows gated on a DIFFERENT question — or not blocked — are untouched', async () => {
    todoRows.push(blockedTodo({ id: 't2', gateQuestionId: 'oq_other' }));
    todoRows.push(blockedTodo({ id: 't3', status: 'in_progress' }));
    goalRows.push(blockedGoal({ id: 'g2', gateQuestionId: 'oq_other' }));
    const out = await call();
    expect(out).toEqual({ todos: 0, goals: 0, heldTodos: 0, heldGoals: 0 });
    expect(todoRows[0].status).toBe('blocked');
    expect(todoRows[1].status).toBe('in_progress');
    expect(goalRows[0].status).toBe('blocked');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('a lost conditional-flip race (re-blocked elsewhere mid-fan-out) wakes nothing', async () => {
    todoRows.push(blockedTodo());
    mockPrisma.projectTodo.updateMany.mockResolvedValueOnce({ count: 0 });
    const out = await call();
    expect(out).toEqual({ todos: 0, goals: 0, heldTodos: 0, heldGoals: 0 });
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('an unassigned todo unblocks WITHOUT a wake (no assignee to notify)', async () => {
    todoRows.push(blockedTodo({ assigneeChatId: null }));
    const out = await call();
    expect(out).toEqual({ todos: 1, goals: 0, heldTodos: 0, heldGoals: 0 });
    expect(todoRows[0].status).toBe('pending');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('NEVER THROWS on a prisma failure — resolves with zero counts', async () => {
    mockPrisma.projectTodo.findMany.mockRejectedValueOnce(new Error('db down'));
    mockPrisma.projectGoal.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(call()).resolves.toEqual({ todos: 0, goals: 0, heldTodos: 0, heldGoals: 0 });
  });

  it('a blank question id is a no-op', async () => {
    await expect(unblockOwnerGatedItems({
      userId: 'u1', questionId: '  ', answer: 'x', source: 'test',
    })).resolves.toEqual({ todos: 0, goals: 0, heldTodos: 0, heldGoals: 0 });
    expect(mockPrisma.projectTodo.findMany).not.toHaveBeenCalled();
  });
});
