/**
 * audit 2026-10-06 T7-1 / T7-9 / T7-10 — lane todos at run start / run end.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  projectTodo: { findMany: jest.fn() },
  todoDependency: { findMany: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  codingSchedule: { count: jest.fn() },
  agentRun: { count: jest.fn() },
  projectGoal: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, o?: any) => { if (o?.NX && mockStore.has(k)) return null; mockStore.set(k, v); return 'OK'; }),
    incr: jest.fn(async (k: string) => { const n = (Number(mockStore.get(k)) || 0) + 1; mockStore.set(k, String(n)); return n; }),
    expire: jest.fn(async () => true),
    del: jest.fn(async (k: string) => { mockStore.delete(k); return 1; }),
  },
}));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

const mockUpdateTodo = jest.fn(async () => ({}));
jest.mock('../platform/goals.service', () => ({ __esModule: true, updateTodo: (...a: any[]) => (mockUpdateTodo as any)(...a) }));

const mockEnqueueDirectWake = jest.fn(async (): Promise<any> => ({ ok: true, hookEventId: 'he1' }));
jest.mock('../platform/hooks.service', () => ({ __esModule: true, enqueueDirectWake: (...a: any[]) => (mockEnqueueDirectWake as any)(...a) }));

import {
  listLaneTodos, todoWakeTitle, todoIdRefsInText, todosNamedInPrompt, firingStartsNewWork,
  promoteLaneTodosAtRunStart, maybeStartNextLaneTodo, laneTodoContinuationPrompt,
} from './lane-todos';
import { machineFiringEffortDecision } from './machine-firing-effort';

const T1 = { id: '1744ef36-0000-4000-8000-000000000001', title: 'Build cql-agent', status: 'pending', goalId: 'g1', projectId: 'p1' };
const T2 = { id: '57e0fe8d-0000-4000-8000-000000000002', title: 'Build cql-gateway', status: 'pending', goalId: 'g1', projectId: 'p1' };
const T3 = { id: 'fd5d25a7-0000-4000-8000-000000000003', title: 'Scaffold repo', status: 'in_progress', goalId: 'g1', projectId: 'p1' };
const KS = ['MACHINE_FIRING_NEW_WORK_DISABLED', 'LANE_TODO_AUTOPROMOTE_DISABLED', 'LANE_TODO_CONTINUATION_DISABLED', 'LANE_TODO_CONTINUATION_MAX_PER_DAY'];

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  for (const k of KS) delete process.env[k];
  mockPrisma.projectTodo.findMany.mockImplementation(async (q: any) => (q?.where?.assigneeChatId ? [T1, T2] : []));
  mockPrisma.todoDependency.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ charterTodoId: null, isSupervisor: false, isProjectSupervisor: false, archivedAt: null });
  mockPrisma.codingSchedule.count.mockResolvedValue(0);
  mockPrisma.agentRun.count.mockResolvedValue(0);
  mockPrisma.projectGoal.findUnique.mockResolvedValue({ title: 'StAnne control plane' });
});

describe('pure helpers', () => {
  it('todoWakeTitle reads the todo_wake header title; todoIdRefsInText reads ids next to "todo"', () => {
    expect(todoWakeTitle('[Fleet goal board — a todo was just ASSIGNED to this chat]\nTodo: "Build cql-agent"\nGoal: "x"')).toBe('Build cql-agent');
    expect(todoWakeTitle('plain message Todo: "x"')).toBeNull();
    expect(todoIdRefsInText('start todo 1744ef36 — build cql-agent; then todo 57e0fe8d-0000')).toEqual(['1744ef36', '57e0fe8d-0000']);
    expect(todoIdRefsInText('commit 1744ef36 landed')).toEqual([]);
    expect(todosNamedInPrompt([{ ...T1, openDeps: 0 }, { ...T2, openDeps: 0 }], 'start todo 1744ef36 — build').map((t) => t.id)).toEqual([T1.id]);
  });

  it('listLaneTodos counts OPEN dependency edges only', async () => {
    mockPrisma.todoDependency.findMany.mockResolvedValue([{ todoId: T2.id, dependsOnTodoId: 'dep-open' }, { todoId: T1.id, dependsOnTodoId: 'dep-done' }]);
    mockPrisma.projectTodo.findMany.mockImplementation(async (q: any) => (q?.where?.assigneeChatId ? [T1, T2] : [{ id: 'dep-open', status: 'pending' }, { id: 'dep-done', status: 'done' }]));
    const todos = await listLaneTodos('lane1');
    expect(todos.map((t) => [t.id, t.openDeps])).toEqual([[T1.id, 0], [T2.id, 1]]);
  });
});

describe('T7-1 — a firing that starts new work keeps the seat effort on an all-complete board', () => {
  it('a todo named in the prompt / an actionable assigned todo ⇒ newWork; none ⇒ the step-down stands', async () => {
    expect(await firingStartsNewWork('lane1', '[MACHINE-TRIGGERED RUN] start todo 1744ef36 — build cql-agent')).toEqual({ newWork: true, todoIds: ['1744ef36'] });
    expect((await firingStartsNewWork('lane1', 'tick')).newWork).toBe(true); // the lane holds actionable assigned todos
    mockPrisma.projectTodo.findMany.mockResolvedValue([]);
    expect(await firingStartsNewWork('lane1', 'tick')).toEqual({ newWork: false, todoIds: [] });
  });

  it('the decision: all-complete + newWork ⇒ no cap (reason new_work); without newWork the original rule', () => {
    expect(machineFiringEffortDecision({ hasPlan: true, allComplete: true, newWork: true })).toEqual({ cap: null, reason: 'new_work' });
    expect(machineFiringEffortDecision({ hasPlan: true, allComplete: true, newWork: false })).toEqual({ cap: 'high', reason: 'all_complete_board' });
    expect(machineFiringEffortDecision({ hasPlan: true, allComplete: true })).toEqual({ cap: 'high', reason: 'all_complete_board' });
    expect(machineFiringEffortDecision({ hasPlan: true, allComplete: false, newWork: true })).toEqual({ cap: null, reason: 'board_open' });
  });
});

describe('T7-9 — promote the todo a lane run starts on', () => {
  it('a pending todo named in the prompt → in_progress via updateTodo (acting chat + run, machine flag) + one metric row', async () => {
    const out = await promoteLaneTodosAtRunStart({ chatId: 'lane1', userId: 'u1', runId: 'r1', prompt: 'start todo 57e0fe8d now', machineTriggered: true });
    expect(out).toEqual([T2.id]);
    expect(mockUpdateTodo).toHaveBeenCalledWith({ userId: 'u1', todoId: T2.id, status: 'in_progress', machineTriggered: true, actingChatId: 'lane1', actingRunId: 'r1' });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'lane_todo_autopromote', meta: expect.objectContaining({ todoId: T2.id, source: 'prompt' }) }));
  });

  it('the CHARTER todo is promoted; the todo_wake title header names a todo too', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ charterTodoId: T1.id });
    expect(await promoteLaneTodosAtRunStart({ chatId: 'lane1', userId: 'u1', runId: 'r1', prompt: 'hello', machineTriggered: false })).toEqual([T1.id]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ charterTodoId: null });
    mockUpdateTodo.mockClear();
    expect(await promoteLaneTodosAtRunStart({ chatId: 'lane1', userId: 'u1', runId: 'r2', prompt: '[Fleet goal board — a todo was just ASSIGNED to this chat]\nTodo: "Build cql-gateway"\nGoal: "g"', machineTriggered: true })).toEqual([T2.id]);
  });

  it('never touches in_progress / dependency-blocked todos, an unnamed todo, or anything under the kill switch', async () => {
    mockPrisma.projectTodo.findMany.mockImplementation(async (q: any) => (q?.where?.assigneeChatId ? [T3, T2] : [{ id: 'dep', status: 'pending' }]));
    mockPrisma.todoDependency.findMany.mockResolvedValue([{ todoId: T2.id, dependsOnTodoId: 'dep' }]);
    expect(await promoteLaneTodosAtRunStart({ chatId: 'lane1', userId: 'u1', runId: 'r1', prompt: 'todo fd5d25a7 and todo 57e0fe8d', machineTriggered: true })).toEqual([]);
    mockPrisma.todoDependency.findMany.mockResolvedValue([]);
    mockPrisma.projectTodo.findMany.mockImplementation(async (q: any) => (q?.where?.assigneeChatId ? [T1, T2] : []));
    expect(await promoteLaneTodosAtRunStart({ chatId: 'lane1', userId: 'u1', runId: 'r1', prompt: 'just a question', machineTriggered: false })).toEqual([]);
    process.env.LANE_TODO_AUTOPROMOTE_DISABLED = '1';
    expect(await promoteLaneTodosAtRunStart({ chatId: 'lane1', userId: 'u1', runId: 'r1', prompt: 'todo 1744ef36', machineTriggered: true })).toEqual([]);
    expect(mockUpdateTodo).not.toHaveBeenCalled();
  });
});

describe('T7-10 — an idle lane with assigned todos starts the next one', () => {
  it('pending dependency-free todo + no schedule + nothing queued ⇒ ONE durable wake for the oldest todo', async () => {
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1', now: new Date('2026-10-06T02:04:00Z') })).toBe('started');
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const arg: any = (mockEnqueueDirectWake.mock.calls[0] as any)[0];
    expect(arg.targetChatId).toBe('lane1');
    expect(arg.meta).toEqual({ todoId: T1.id, goalId: 'g1', trigger: 'lane_idle' });
    expect(arg.prompt).toContain('Todo: "Build cql-agent"');
    expect(arg.prompt).toContain('Re-read this todo with todo_get FIRST');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'lane_todo_continuation', meta: expect.objectContaining({ outcome: 'started', todoId: T1.id }) }));
    // The same todo is not re-woken within 6 h.
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r2' })).toBe('recent');
  });

  it('an enabled schedule, a queued run, a supervisor / archived chat or no pending todo ⇒ nothing', async () => {
    mockPrisma.codingSchedule.count.mockResolvedValueOnce(1);
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1' })).toBe('scheduled');
    mockPrisma.agentRun.count.mockResolvedValueOnce(1);
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1' })).toBe('queued');
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ isSupervisor: false, isProjectSupervisor: true, archivedAt: null });
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1' })).toBe('no_todo');
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ isSupervisor: false, isProjectSupervisor: false, archivedAt: new Date() });
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1' })).toBe('no_todo');
    mockPrisma.projectTodo.findMany.mockResolvedValue([]);
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1' })).toBe('no_todo');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('caps at LANE_TODO_CONTINUATION_MAX_PER_DAY per lane per day', async () => {
    process.env.LANE_TODO_CONTINUATION_MAX_PER_DAY = '1';
    const now = new Date('2026-10-06T03:00:00Z');
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1', now })).toBe('started');
    mockPrisma.projectTodo.findMany.mockImplementation(async (q: any) => (q?.where?.assigneeChatId ? [T2] : []));
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r2', now })).toBe('capped');
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
  });

  it('LANE_TODO_CONTINUATION_DISABLED=1 ⇒ nothing is read or woken', async () => {
    process.env.LANE_TODO_CONTINUATION_DISABLED = '1';
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1' })).toBe('disabled');
    expect(mockPrisma.projectTodo.findMany).not.toHaveBeenCalled();
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('the prompt names the remaining count and the transition', () => {
    expect(laneTodoContinuationPrompt({ title: 'T' }, 'G', 3, '2026-10-06T00:00:00.000Z')).toMatch(/^\[Fleet goal board — this lane finished its run with 3 pending todo\(s\)/);
  });

  it('GOAL-PRIORITY-SPEND review fix: the run-goal resolver reads the started todo back out of this prompt (format pin)', async () => {
    const { continuationTodoTitles } = await import('../platform/goal-spend');
    expect(continuationTodoTitles(laneTodoContinuationPrompt({ title: 'Ship the "fast" path' }, 'G', 2, '2026-10-20T00:00:00.000Z'))).toEqual(['Ship the "fast" path']);
  });
});

// ── LANE-IDLE-WAKE (2026-10-20): only a schedule due within 30 min means "scheduled" ──
describe('maybeStartNextLaneTodo — LANE-IDLE-WAKE schedule horizon', () => {
  afterEach(() => { delete process.env.LANE_IDLE_WAKE_DISABLED; });

  it('counts only enabled schedules due within 30 min (a check armed for tomorrow no longer leaves the next todo idle)', async () => {
    const now = new Date('2026-10-20T12:00:00Z');
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1', now })).toBe('started');
    expect(mockPrisma.codingSchedule.count).toHaveBeenCalledWith({ where: { sessionId: 'lane1', enabled: true, nextRunAt: { lte: new Date('2026-10-20T12:30:00Z') } } });
  });

  it('LANE_IDLE_WAKE_DISABLED=1 restores "any enabled schedule"', async () => {
    process.env.LANE_IDLE_WAKE_DISABLED = '1';
    mockPrisma.codingSchedule.count.mockResolvedValueOnce(1);
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1' })).toBe('scheduled');
    expect(mockPrisma.codingSchedule.count).toHaveBeenCalledWith({ where: { sessionId: 'lane1', enabled: true } });
  });
});

// ── GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20): the continuation starts the highest-SCORED todo ──
describe('maybeStartNextLaneTodo — the todo of the highest-scored goal goes first', () => {
  const OLD_P3 = { ...T1, goalId: 'g-p3' };
  const NEW_P1 = { ...T2, goalId: 'g-p1' };
  beforeEach(() => {
    mockPrisma.projectTodo.findMany.mockImplementation(async (q: any) => (q?.where?.assigneeChatId ? [OLD_P3, NEW_P1] : []));
    mockPrisma.projectGoal.findMany = jest.fn(async () => [{ id: 'g-p3', priority: 3, prioritySource: 'machine' }, { id: 'g-p1', priority: 1, prioritySource: 'owner' }]);
  });
  afterEach(() => { delete process.env.GOAL_PRIORITY_ORDER_DISABLED; delete mockPrisma.projectGoal.findMany; });

  it('the owner-set P1 todo starts before the older P3 one; the metric row records how it was picked', async () => {
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1', now: new Date('2026-10-20T12:00:00Z') })).toBe('started');
    expect((mockEnqueueDirectWake.mock.calls[0] as any)[0].meta).toEqual({ todoId: NEW_P1.id, goalId: 'g-p1', trigger: 'lane_idle' });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'lane_todo_continuation',
      meta: expect.objectContaining({ outcome: 'started', todoId: NEW_P1.id, pickedBy: 'score', score: 80, priority: 'P1', oldestTodoId: OLD_P3.id }),
    }));
  });

  it('GOAL_PRIORITY_ORDER_DISABLED=1 (or a goal read failure) starts the OLDEST todo, as before', async () => {
    process.env.GOAL_PRIORITY_ORDER_DISABLED = '1';
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r1' })).toBe('started');
    expect((mockEnqueueDirectWake.mock.calls[0] as any)[0].meta.todoId).toBe(OLD_P3.id);
    expect(mockPrisma.projectGoal.findMany).not.toHaveBeenCalled();
    delete process.env.GOAL_PRIORITY_ORDER_DISABLED;
    mockStore.clear();
    mockPrisma.projectGoal.findMany = jest.fn(async () => { throw new Error('db down'); });
    expect(await maybeStartNextLaneTodo({ chatId: 'lane1', userId: 'u1', runId: 'r2' })).toBe('started');
    expect((mockEnqueueDirectWake.mock.calls[1] as any)[0].meta.todoId).toBe(OLD_P3.id);
    expect(mockRecordLoopMetric).toHaveBeenLastCalledWith(expect.objectContaining({ meta: expect.objectContaining({ pickedBy: 'fifo' }) }));
  });
});
