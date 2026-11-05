/**
 * audit 2026-10-08 W5-4 — the todo a lane actually WORKS moves on the board.
 *
 * REPLAY A (goals.md F6, lane 3532d1ad — spawned with charterGoalId f3ddb80a
 * only): the lane's plan said "Implement chat mobile fixes (todo 5ca3996f)",
 * "(todo e07c8bd2)", "(todo de893432)" — the real plan step texts below — and
 * the three UNASSIGNED todos sat pending for two hours, then closed in one
 * burst. Now each moves pending → in_progress (assigned to the lane) when its
 * step starts, and → done with the steps as evidence when they complete.
 *
 * REPLAY B (lane 7bd45d57): the run ended "Plan is 10/10 complete" with its
 * assigned todo 75903ccc still in_progress for 2 h 47 m. Now the run end closes
 * a lone in-progress todo, and asks ONE closing turn when several are open.
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
  chatSchedule: { count: jest.fn(async () => 0) },
  agentRun: { count: jest.fn(async () => 0) },
  projectGoal: { findUnique: jest.fn(async () => ({ title: 'Mobile UX overhaul' })) },
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

import {
  reconcileLaneTodosFromPlan, closeLaneTodosOnPlanComplete, promoteLaneTodosAtRunStart, planTodoTransitions, todosNamedInText,
  laneTodoClosingPrompt,
} from './lane-todos';

const LANE = '3532d1ad-37d9-4c23-b5fd-30038e6cbc18';
const GOAL = 'f3ddb80a-350c-4165-a23c-040c56a1d877';
const T_AUDIT: Todo = { id: '5f395483-0000-4000-8000-000000000001', title: 'Audit mobile chat UX live: use Playwright iPhone-UA harness', status: 'done', goalId: GOAL, projectId: 'p', assigneeChatId: null };
const T_CHAT: Todo = { id: '5ca3996f-0000-4000-8000-000000000002', title: 'Implement mobile chat UX fixes: safe-area-inset composer, keyboard-resize', status: 'pending', goalId: GOAL, projectId: 'p', assigneeChatId: null };
const T_VIEWS: Todo = { id: 'e07c8bd2-0000-4000-8000-000000000003', title: 'Audit + fix remaining views (decks/cards/sets/meta/events/media/account)', status: 'pending', goalId: GOAL, projectId: 'p', assigneeChatId: null };
const T_VERIFY: Todo = { id: 'de893432-0000-4000-8000-000000000004', title: 'Verify on live site post-deploy with mobile harness', status: 'pending', goalId: GOAL, projectId: 'p', assigneeChatId: null };
const T_OTHER_LANE: Todo = { id: 'aaaa1111-0000-4000-8000-000000000005', title: 'Some other lane work', status: 'pending', goalId: GOAL, projectId: 'p', assigneeChatId: 'another-lane' };

/** The lane's REAL plan step texts (prod store row, 2026-10-08), statuses set per phase. */
const STEPS = [
  'Audit (todo 5f395483): Playwright iPhone-UA harness, live chat probes at 360/390/430px, defect catalog',
  'Implement chat mobile fixes (todo 5ca3996f): drawer scrim/close, safe-area composer, visualViewport keyboard, bubble widths, 44px targets, streaming scroll anchoring (ccc1851; probe_chat 63/63, probe_kb 22/22.)',
  'Extend usability pass to the other 7 views + one-handed nav for 8 tabs (todo e07c8bd2) (02cbfd0; header 168px/3 rows -> 58px/1 row on 8 views x 3 widths)',
  'Verify locally, commit, PR to main, merge, deploy (todo de893432) (VERIFY-SITE OK, pytest 107 passed, app.js 799/800; PR #64 merged (squash 3df5a27))',
];
const planWith = (statuses: string[], updatedAt = new Date().toISOString()) => ({
  goal: 'Make deckpose.com genuinely usable on mobile — chat first',
  steps: STEPS.map((text, i) => ({ id: i + 1, text, status: statuses[i] })),
  updatedAt,
});

beforeEach(() => {
  jest.clearAllMocks();
  kv.clear();
  for (const k of ['LANE_TODO_PLAN_RECONCILE_DISABLED', 'LANE_TODO_PLAN_CLOSE_DISABLED', 'LANE_TODO_AUTOPROMOTE_DISABLED']) delete process.env[k];
  todos = [{ ...T_AUDIT }, { ...T_CHAT }, { ...T_VIEWS }, { ...T_VERIFY }, { ...T_OTHER_LANE }];
  deps = [];
  chat = { charterGoalId: GOAL, charterTodoId: null, isSupervisor: false, isProjectSupervisor: false, archivedAt: null };
  plan = null;
});
const byId = (id: string) => todos.find((t) => t.id === id)!;

describe('REPLAY A — lane 3532d1ad works its goal\'s UNASSIGNED todos through its plan', () => {
  it('step 2 in progress ⇒ todo 5ca3996f pending → in_progress, ASSIGNED to the lane; nothing else moves', async () => {
    const moved = await reconcileLaneTodosFromPlan({ chatId: LANE, userId: 'u', runId: 'run-1', plan: planWith(['completed', 'in_progress', 'pending', 'pending']), machineTriggered: true });
    expect(moved).toEqual([T_CHAT.id]);
    expect(byId(T_CHAT.id)).toMatchObject({ status: 'in_progress', assigneeChatId: LANE });
    expect(byId(T_VIEWS.id).status).toBe('pending');
    expect(mockUpdateTodo).toHaveBeenCalledWith(expect.objectContaining({ todoId: T_CHAT.id, status: 'in_progress', assigneeChatId: LANE, actingChatId: LANE, actingRunId: 'run-1', machineTriggered: true }));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); // the charter bind is fire-and-forget
    expect(mockBindCharter).toHaveBeenCalledWith(LANE, { goalId: GOAL, todoId: T_CHAT.id }, { reason: 'todo' });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'lane_todo_plan_reconcile', meta: expect.objectContaining({ todoId: T_CHAT.id, from: 'pending', to: 'in_progress', assigned: true }) }));
  });

  it('all steps completed ⇒ named todos are NEVER done by the harness (mishap 260dd714) — done is an explicit todo_update(done, evidence)', async () => {
    await reconcileLaneTodosFromPlan({ chatId: LANE, userId: 'u', runId: 'run-1', plan: planWith(['completed', 'in_progress', 'pending', 'pending']), machineTriggered: true });
    await reconcileLaneTodosFromPlan({ chatId: LANE, userId: 'u', runId: 'run-2', plan: planWith(['completed', 'completed', 'completed', 'completed']), machineTriggered: true });
    // A plan step that NAMES a todo (even all-completed steps) is not evidence
    // its deliverable landed: pending todos were started (in_progress, assigned),
    // in_progress ones stay in_progress — no todo reaches done from plan shape.
    for (const t of [T_CHAT, T_VIEWS, T_VERIFY]) expect(byId(t.id).status).toBe('in_progress');
    expect(mockUpdateTodo.mock.calls.map((c: any[]) => c[0]).some((o: any) => o.status === 'done')).toBe(false);
    expect(byId(T_OTHER_LANE.id).status).toBe('pending'); // another lane's todo is never a candidate
    expect(byId(T_AUDIT.id).status).toBe('done'); // already done — untouched
    expect(mockUpdateTodo.mock.calls.some((c: any[]) => c[0].todoId === T_AUDIT.id)).toBe(false);
  });

  it('a todo with an OPEN dependency is never started or closed by the plan', async () => {
    deps = [{ todoId: T_CHAT.id, dependsOnTodoId: T_VERIFY.id }];
    await reconcileLaneTodosFromPlan({ chatId: LANE, userId: 'u', runId: 'r', plan: planWith(['completed', 'completed', 'pending', 'pending']), machineTriggered: true });
    expect(byId(T_CHAT.id).status).toBe('pending');
  });

  it('a supervisor chat never reconciles; LANE_TODO_PLAN_RECONCILE_DISABLED=1 restores assigned-only (no move)', async () => {
    chat.isProjectSupervisor = true;
    expect(await reconcileLaneTodosFromPlan({ chatId: LANE, userId: 'u', runId: 'r', plan: planWith(['completed', 'in_progress', 'pending', 'pending']), machineTriggered: true })).toEqual([]);
    chat.isProjectSupervisor = false;
    process.env.LANE_TODO_PLAN_RECONCILE_DISABLED = '1';
    expect(await reconcileLaneTodosFromPlan({ chatId: LANE, userId: 'u', runId: 'r', plan: planWith(['completed', 'in_progress', 'pending', 'pending']), machineTriggered: true })).toEqual([]);
    expect(mockUpdateTodo).not.toHaveBeenCalled();
  });

  it('run start: an UNASSIGNED charter-goal todo the prompt names is assigned + promoted', async () => {
    const promoted = await promoteLaneTodosAtRunStart({ chatId: LANE, userId: 'u', runId: 'run-0', prompt: '[Fleet supervisor] next: todo 5ca3996f — the chat fixes', machineTriggered: true });
    expect(promoted).toEqual([T_CHAT.id]);
    expect(byId(T_CHAT.id)).toMatchObject({ status: 'in_progress', assigneeChatId: LANE });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'lane_todo_autopromote', meta: expect.objectContaining({ source: 'prompt_goal_unassigned' }) }));
  });
});

describe('pure naming rules', () => {
  const C = [{ ...T_CHAT }, { ...T_VIEWS }];
  it('names by id prefix (≥ 8 hex) or by the full title (≥ 3 words); a git sha that prefixes no todo names nothing', () => {
    expect(todosNamedInText(C, 'work on 5ca3996f now').map((t) => t.id)).toEqual([T_CHAT.id]);
    expect(todosNamedInText(C, `Step: ${T_VIEWS.title} — done`).map((t) => t.id)).toEqual([T_VIEWS.id]);
    expect(todosNamedInText(C, 'commit 02cbfd0 and 3df5a27e landed')).toEqual([]);
  });
  it('planTodoTransitions: naming steps NEVER produce done (mishap 260dd714) — started ⇒ in_progress (from pending only)', () => {
    const tr = planTodoTransitions(C, planWith(['pending', 'completed', 'in_progress', 'pending']));
    expect(tr.map((x) => [x.todo.id, x.target])).toEqual([[T_CHAT.id, 'in_progress'], [T_VIEWS.id, 'in_progress']]);
    // even an ALL-completed naming set never targets done — done is an explicit todo_update(done, evidence)
    const allDone = planTodoTransitions(C, planWith(['completed', 'completed', 'completed', 'completed']));
    expect(allDone.every((x) => x.target === 'in_progress')).toBe(true);
  });
});

describe('REPLAY B — the run end of an all-complete plan', () => {
  const LANE_B = '7bd45d57-059b-42c5-8245-ea1ee358635f';
  const T_SCRAPER: Todo = { id: '75903ccc-2134-4a13-94c6-b7b9d4c4a694', title: 'Implement events scraper (fetch→S3→load→RDS) following existing optcg-scraper pattern', status: 'in_progress', goalId: 'g2', projectId: 'p', assigneeChatId: LANE_B };
  const T_SCHED: Todo = { id: 'b63c2d5e-ae75-4cfe-b64b-21079958d3d4', title: 'Schedule weekly events refresh via EventBridge alongside existing scrape crons', status: 'pending', goalId: 'g2', projectId: 'p', assigneeChatId: LANE_B };
  const runStartedAt = new Date(Date.now() - 3600_000);
  const tenOfTen = (updatedAt = new Date().toISOString()) => ({
    goal: 'Ingest official OPTCG events + rules', updatedAt,
    steps: Array.from({ length: 10 }, (_, i) => ({ id: i + 1, text: `step ${i + 1}`, status: 'completed' })),
  });

  beforeEach(() => { chat = { charterGoalId: 'g2', charterTodoId: 'bce96455-ab39-4441-952f-17621ff4aa09', isSupervisor: false, isProjectSupervisor: false, archivedAt: null }; });

  it('a lone in-progress assigned todo is NEVER harness-closed (mishap 260dd714) — ONE closing wake asks for explicit todo_update(done, evidence)', async () => {
    todos = [{ ...T_SCRAPER }];
    plan = tenOfTen();
    expect(await closeLaneTodosOnPlanComplete({ chatId: LANE_B, userId: 'u', runId: 'f9012dc6-0000-4000-8000-000000000000', runStartedAt })).toBe('wake_sent');
    expect(byId(T_SCRAPER.id).status).toBe('in_progress'); // the harness never writes done from plan shape
    expect(mockUpdateTodo).not.toHaveBeenCalled();
    const prompt = mockEnqueueDirectWake.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('75903ccc');
    expect(prompt).toContain('todo_update status:"done"');
    // once per 6 h — a second completed run is 'recent', no second wake
    expect(await closeLaneTodosOnPlanComplete({ chatId: LANE_B, userId: 'u', runId: 'r2', runStartedAt })).toBe('recent');
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
  });

  it('several open (one in progress) ⇒ ONE closing wake, once per 6 h; the next-todo continuation is skipped by the caller', async () => {
    todos = [{ ...T_SCRAPER }, { ...T_SCHED }];
    plan = tenOfTen();
    expect(await closeLaneTodosOnPlanComplete({ chatId: LANE_B, userId: 'u', runId: 'r1', runStartedAt })).toBe('wake_sent');
    expect(mockUpdateTodo).not.toHaveBeenCalled(); // never a guess
    const prompt = mockEnqueueDirectWake.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('finished its plan 10/10 complete with 2 assigned todo(s) still open');
    expect(prompt.indexOf('75903ccc')).toBeLessThan(prompt.indexOf('b63c2d5e')); // in-progress first
    expect(await closeLaneTodosOnPlanComplete({ chatId: LANE_B, userId: 'u', runId: 'r2', runStartedAt })).toBe('recent');
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
  });

  it('no close on a STALE plan (not updated this run), an open plan, pending-only todos, or with the kill switch', async () => {
    todos = [{ ...T_SCRAPER }];
    plan = tenOfTen(new Date(runStartedAt.getTime() - 60_000).toISOString());
    expect(await closeLaneTodosOnPlanComplete({ chatId: LANE_B, userId: 'u', runId: 'r', runStartedAt })).toBe('stale_plan');
    plan = { ...tenOfTen(), steps: [...tenOfTen().steps.slice(0, 9), { id: 10, text: 'x', status: 'in_progress' }] };
    expect(await closeLaneTodosOnPlanComplete({ chatId: LANE_B, userId: 'u', runId: 'r', runStartedAt })).toBe('plan_open');
    todos = [{ ...T_SCHED }];
    plan = tenOfTen();
    expect(await closeLaneTodosOnPlanComplete({ chatId: LANE_B, userId: 'u', runId: 'r', runStartedAt })).toBe('pending_only');
    process.env.LANE_TODO_PLAN_CLOSE_DISABLED = '1';
    todos = [{ ...T_SCRAPER }];
    expect(await closeLaneTodosOnPlanComplete({ chatId: LANE_B, userId: 'u', runId: 'r', runStartedAt })).toBe('disabled');
    expect(mockUpdateTodo).not.toHaveBeenCalled();
  });

  it('the closing prompt asks for evidence-backed closes, never new work', () => {
    const p = laneTodoClosingPrompt([{ id: T_SCRAPER.id, title: T_SCRAPER.title, status: 'in_progress' }], 10, '2026-10-08T14:00:00Z');
    expect(p).toContain('ONE short turn, no new work');
    expect(p).toContain('todo_update status:"done" and evidence');
  });
});
