/**
 * REPLAY — mishap ticket 260dd714 (2026-10-08 22:59–23:07Z, lane 0037460b).
 *
 * The lane's plan step 1 — "re-read the todos a62eb6ce / 276c004d", pure
 * bookkeeping — NAMES its two assigned todos, so every time it checked off,
 * the plan→todo reconcile marked BOTH todos done (three false closes in 8
 * minutes: 23:00Z, 23:05Z, 23:06Z), each auto-completing goal a8c755c8 while
 * the lane was mid-execution. A supervisor reopened them 3×; every update_plan
 * after a reopen re-fired the false close.
 *
 * This file replays that exact shape with the prod step text and todo ids:
 *  - REPLAY 1 (the reconcile, after update_plan): a completed step that merely
 *    NAMES open todos must never produce a done transition — only the safe
 *    pending → in_progress promotion survives.
 *  - REPLAY 2 (the same false close re-firing after a supervisor reopen):
 *    every reconcile call leaves the todos open, so the loop the supervisor
 *    fought (close → reopen → close) cannot restart.
 *  - REPLAY 3 (the run-end seam, same class): an all-complete plan with a lone
 *    in-progress assigned todo asks ONE closing wake for explicit
 *    todo_update(done, evidence) — the harness never writes done from plan
 *    shape.
 *
 * Ticket 260dd714-d79b-4f99-948e-c012591001b4 (type mishap — this file is the
 * replay pin the verified-close gate requires).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Todo = { id: string; title: string; status: string; goalId: string; projectId: string; assigneeChatId: string | null };
let todos: Todo[] = [];
let deps: Array<{ todoId: string; dependsOnTodoId: string }> = [];
let chat: any = {};
let plan: any = null;

const matchTodo = (t: Todo, w: any): boolean => {
  if (!w) return true;
  if (w.id?.in && !w.id.in.includes(t.id)) return false;
  if (w.status?.in && !w.status.in.includes(t.status)) return false;
  if (w.assigneeChatId !== undefined && w.assigneeChatId !== t.assigneeChatId) return false;
  if (w.goalId !== undefined && w.goalId !== t.goalId) return false;
  if (Array.isArray(w.OR) && !w.OR.some((c: any) => matchTodo(t, c))) return false;
  return true;
};
const mockPrisma: any = {
  projectTodo: { findMany: jest.fn(async ({ where }: any) => todos.filter((t) => matchTodo(t, where)).map((t) => ({ ...t }))) },
  todoDependency: { findMany: jest.fn(async ({ where }: any) => deps.filter((d) => where.todoId.in.includes(d.todoId))) },
  crossModelChat: { findUnique: jest.fn(async () => ({ ...chat })) },
  codingSchedule: { count: jest.fn(async () => 0) },
  agentRun: { count: jest.fn(async () => 0) },
  projectGoal: { findUnique: jest.fn(async () => ({ title: 'Schooltime polish' })) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const kv = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, o?: any) => { if (o?.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; }),
    incr: jest.fn(async (k: string) => { const n = (Number(kv.get(k)) || 0) + 1; kv.set(k, String(n)); return n; }),
    expire: jest.fn(async () => true),
    del: jest.fn(async (k: string) => { kv.delete(k); return 1; }),
  },
}));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

const mockUpdateTodo = jest.fn(async (o: any) => {
  const t = todos.find((x) => x.id === o.todoId)!;
  if (o.status) t.status = o.status;
  if (o.assigneeChatId !== undefined) t.assigneeChatId = o.assigneeChatId;
  return { ...t };
});
jest.mock('../platform/goals.service', () => ({ __esModule: true, updateTodo: (o: any) => mockUpdateTodo(o) }));

const mockEnqueueDirectWake = jest.fn(async (_o: any): Promise<any> => ({ ok: true, hookEventId: 'he1' }));
jest.mock('../platform/hooks.service', () => ({ __esModule: true, enqueueDirectWake: (o: any) => mockEnqueueDirectWake(o) }));

const mockBindCharter = jest.fn(async () => ({ bound: true }));
jest.mock('../platform/session-titles', () => ({ __esModule: true, bindCharter: (...a: any[]) => (mockBindCharter as any)(...a) }));

jest.mock('./plan.service', () => ({ __esModule: true, getPlan: jest.fn(async () => plan) }));

import { reconcileLaneTodosFromPlan, closeLaneTodosOnPlanComplete } from './lane-todos';

// ── the mishap's own ids (ticket 260dd714 context / digbyEvidence) ──────────
const LANE = '0037460b-d239-474e-bd32-5fe3ec52d820';
const GOAL = 'a8c755c8-0000-4000-8000-00000000000a';
const T_A62: Todo = { id: 'a62eb6ce-0000-4000-8000-00000000000b', title: 'Ship the schooltime fix: code, tests, PR to main', status: 'in_progress', goalId: GOAL, projectId: 'p', assigneeChatId: LANE };
const T_276: Todo = { id: '276c004d-0000-4000-8000-00000000000c', title: 'Verify the fix post-deploy and close the ticket', status: 'pending', goalId: GOAL, projectId: 'p', assigneeChatId: LANE };

/** The mishap's step-1 shape: a bookkeeping step that NAMES both todos. */
const BOOKKEEPING_STEP = 'Re-read the todos a62eb6ce and 276c004d to confirm scope before starting';
const planWith = (statuses: string[], updatedAt = new Date().toISOString()) => ({
  goal: 'Schooltime: land the pending fixes',
  steps: statuses.map((status, i) => (i === 0
    ? { id: 1, text: BOOKKEEPING_STEP, status }
    : { id: i + 1, text: `Execution step ${i + 1}: the actual deliverable work`, status })),
  updatedAt,
});

beforeEach(() => {
  jest.clearAllMocks();
  kv.clear();
  for (const k of ['LANE_TODO_PLAN_RECONCILE_DISABLED', 'LANE_TODO_PLAN_CLOSE_DISABLED', 'LANE_TODO_AUTOPROMOTE_DISABLED']) delete process.env[k];
  todos = [{ ...T_A62 }, { ...T_276 }];
  deps = [];
  chat = { charterGoalId: GOAL, charterTodoId: null, isSupervisor: false, isProjectSupervisor: false, archivedAt: null };
  plan = null;
});
const byId = (id: string) => todos.find((t) => t.id === id)!;

describe('REPLAY 260dd714 — a completed bookkeeping step that NAMES todos never closes them', () => {
  it('the mishap shape: step "re-read the todos a62eb6ce / 276c004d" completed ⇒ NO todo reaches done (the pending one only promotes)', async () => {
    // pre-fix: planTodoTransitions returned {target:'done'} for both todos here and
    // reconcileLaneTodosFromPlan wrote status:'done' with harness evidence —
    // closing both and auto-completing goal a8c755c8 mid-execution.
    const moved = await reconcileLaneTodosFromPlan({ chatId: LANE, userId: 'u', runId: 'run-1', plan: planWith(['completed', 'in_progress', 'pending']), machineTriggered: true });
    expect(moved).toEqual([T_276.id]); // only the SAFE promotion: pending → in_progress
    expect(byId(T_A62.id).status).toBe('in_progress'); // in_progress — untouched, never done
    expect(byId(T_276.id).status).toBe('in_progress'); // promoted, NOT done — a naming step is not deliverable evidence
    expect(mockUpdateTodo.mock.calls.map((c: any[]) => c[0]).some((o: any) => o.status === 'done')).toBe(false);
  });

  it('the re-fire loop the supervisor fought: reopen both todos, check the step off again ⇒ still open, every time', async () => {
    // The mishap: supervisor reopens (pending/in_progress), the lane re-checks
    // step 1, the harness closes again — three times in 8 minutes. With the fix,
    // NO reconcile pass ever writes done, so the loop cannot restart.
    for (let pass = 1; pass <= 3; pass++) {
      todos = [{ ...T_A62, status: 'in_progress' }, { ...T_276, status: 'pending' }];
      await reconcileLaneTodosFromPlan({ chatId: LANE, userId: 'u', runId: `run-${pass}`, plan: planWith(['completed', 'completed', 'completed']), machineTriggered: true });
      expect(byId(T_A62.id).status).toBe('in_progress');
      expect(byId(T_276.id).status).not.toBe('done');
      expect(mockUpdateTodo.mock.calls.some((c: any[]) => c[0].status === 'done')).toBe(false);
    }
  });

  it('the safe direction survives: a pending todo named by a STARTED step promotes to in_progress (W5-4 intact)', async () => {
    await reconcileLaneTodosFromPlan({ chatId: LANE, userId: 'u', runId: 'run-1', plan: planWith(['in_progress', 'pending', 'pending']), machineTriggered: true });
    expect(byId(T_276.id).status).toBe('in_progress');
    expect(byId(T_A62.id).status).toBe('in_progress');
  });

  it('REPLAY 3 — run end (same class): an all-complete plan + lone in-progress todo sends ONE closing wake, never a harness close', async () => {
    todos = [{ ...T_A62 }];
    plan = planWith(['completed', 'completed', 'completed']);
    const runStartedAt = new Date(Date.now() - 600_000);
    // pre-fix: outcome 'closed' wrote status:'done' with "finished its plan …" evidence
    expect(await closeLaneTodosOnPlanComplete({ chatId: LANE, userId: 'u', runId: 'f-260dd714-0000', runStartedAt })).toBe('wake_sent');
    expect(byId(T_A62.id).status).toBe('in_progress'); // never done from plan shape
    expect(mockUpdateTodo).not.toHaveBeenCalled();
    const wake = mockEnqueueDirectWake.mock.calls[0][0];
    expect(wake.prompt).toContain('a62eb6ce');
    expect(wake.prompt).toContain('todo_update status:"done" and evidence');
    // once per 6 h
    expect(await closeLaneTodosOnPlanComplete({ chatId: LANE, userId: 'u', runId: 'r2', runStartedAt })).toBe('recent');
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
  });
});
