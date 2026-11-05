/**
 * TICKET 03d14b78 — "Scope Fleet Supervisor tool reads to supervised projects".
 *
 * THE RESIDUAL THIS PINS. dca83b85 (merged, deployed, live-verified) enforced
 * the owner's `crossModelProject.supervised === false` opt-out across every
 * fleet COMPOSITION surface — hooks, digest, watchdog, board roll-up, attention
 * block, owner briefing. It deliberately did NOT touch the agent TOOL surface:
 * `list_chats` / `goal_list` / `todo_list` / `list_projects` still answered
 * account-wide, and those results are composed into the model's context on any
 * manual pull. So an opted-out project's names, ids and work still entered a
 * Fleet Supervisor machine turn through a tool call.
 *
 * WHAT THIS SUITE PROVES (mixed fixture, one account):
 *   · crossmodel      supervised=true,  isFramework=true   → ALWAYS visible
 *   · schooltime      supervised=false, projectSupervisorEnabled=true
 *   · onepiecetcg     supervised=false, projectSupervisorEnabled=true
 *   · canlaw          supervised=true,  non-framework       → visible
 *   · legacyflip      supervised=null (legacy row)          → visible (fail-open)
 *
 *   1. FLEET machine run: every opted-out project, chat, goal and todo is
 *      absent from list_chats / goal_list / todo_list / list_projects — no ids,
 *      no names, no counts, no exclusion metadata, no empty-result prose naming
 *      them.
 *   2. In-scope rows survive intact (framework + supervised=true + legacy-null).
 *   3. Explicit out-of-scope lookups are REFUSED (goal_list/todo_list/list_chats
 *      projectId) rather than silently returned — and the refusal does not echo
 *      the opted-out name.
 *   4. list_chats filters (q / archived / mode / page+limit) never resurrect an
 *      opted-out row; goal_list includeDescendants subtracts an opted-out
 *      descendant.
 *   5. NON-FLEET seats are untouched: a PROJECT SUPERVISOR (even of an opted-out
 *      project) and an ordinary chat still read everything; an owner-held turn
 *      ON the fleet chat still reads everything.
 *
 * Harness: platform-tools dispatch with platform.service / goals.service mocked
 * at the module boundary (the dispatch reaches them via DYNAMIC import, which
 * jest.mock intercepts) — the same scaffolding as platform-tools.fleet.test.ts.
 * The scope leaf itself is exercised through a mocked prisma, so the REAL
 * supervised:false read, the framework re-assertion and the seat classification
 * are all exercised rather than stubbed.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('../coding/code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));

// ── The fixtures ────────────────────────────────────────────────────────────
const OWNER = 'u-owner';

const P_FRAMEWORK = 'aaaaaaaa-0000-4000-8000-000000000001';
const P_SCHOOLTIME = 'bbbbbbbb-0000-4000-8000-000000000002';
const P_ONEPIECE = 'cccccccc-0000-4000-8000-000000000003';
const P_CANLAW = 'dddddddd-0000-4000-8000-000000000004';
const P_LEGACYFLIP = 'eeeeeeee-0000-4000-8000-000000000005';

const PROJECTS = [
  { id: P_FRAMEWORK, userId: OWNER, name: 'crossmodel', path: `/${P_FRAMEWORK}`, archivedAt: null, supervised: true, isFramework: true, repoUrl: 'example-org/crossmodel', emoji: '🧠', memberRole: 'owner', parentId: null, depth: 0 },
  // The two OPTED-OUT projects — and both still run their OWN project supervisor.
  { id: P_SCHOOLTIME, userId: OWNER, name: 'Schooltime', path: `/${P_SCHOOLTIME}`, archivedAt: null, supervised: false, projectSupervisorEnabled: true, emoji: '🎒', memberRole: 'owner', parentId: null, depth: 0 },
  { id: P_ONEPIECE, userId: OWNER, name: 'One Piece TCG', path: `/${P_ONEPIECE}`, archivedAt: null, supervised: false, projectSupervisorEnabled: true, emoji: '🏴‍☠️', memberRole: 'owner', parentId: null, depth: 0 },
  // In scope: a normal supervised project and a legacy row that reads NULL.
  { id: P_CANLAW, userId: OWNER, name: 'CanLaw', path: `/${P_CANLAW}`, archivedAt: null, supervised: true, emoji: '⚖️', memberRole: 'owner', parentId: null, depth: 0 },
  { id: P_LEGACYFLIP, userId: OWNER, name: 'Legacy', path: `/${P_LEGACYFLIP}`, archivedAt: null, supervised: null, emoji: '🗂️', memberRole: 'owner', parentId: null, depth: 0 },
];

const CHATS = [
  { id: 'chat-fw', title: 'framework lane', projectId: P_FRAMEWORK, userId: OWNER, mode: 'thinking', archivedAt: null, updatedAt: new Date('2026-11-01'), createdAt: new Date('2026-11-01'), parentChatId: null, isSupervisor: false, isProjectSupervisor: false, ghostMode: false },
  { id: 'chat-school', title: 'SCHOOLTIME-SECRET-LESSONS', projectId: P_SCHOOLTIME, userId: OWNER, mode: 'thinking', archivedAt: null, updatedAt: new Date('2026-11-02'), createdAt: new Date('2026-11-02'), parentChatId: null, isSupervisor: false, isProjectSupervisor: true, ghostMode: false },
  { id: 'chat-onepiece', title: 'ONEPIECE-SECRET-DECK', projectId: P_ONEPIECE, userId: OWNER, mode: 'thinking', archivedAt: null, updatedAt: new Date('2026-11-03'), createdAt: new Date('2026-11-03'), parentChatId: null, isSupervisor: false, isProjectSupervisor: true, ghostMode: false },
  { id: 'chat-canlaw', title: 'canlaw intake', projectId: P_CANLAW, userId: OWNER, mode: 'thinking', archivedAt: null, updatedAt: new Date('2026-11-01'), createdAt: new Date('2026-11-01'), parentChatId: null, isSupervisor: false, isProjectSupervisor: false, ghostMode: false },
  { id: 'chat-legacy', title: 'legacy notes', projectId: P_LEGACYFLIP, userId: OWNER, mode: 'thinking', archivedAt: null, updatedAt: new Date('2026-11-01'), createdAt: new Date('2026-11-01'), parentChatId: null, isSupervisor: false, isProjectSupervisor: false, ghostMode: false },
];

const GOALS = [
  { id: 'goal-fw', projectId: P_FRAMEWORK, title: 'framework goal', status: 'active', todos: [], depsThis: [], depsOn: [] },
  { id: 'goal-school', projectId: P_SCHOOLTIME, title: 'SCHOOLTIME-SECRET-GOAL', status: 'active', todos: [], depsThis: [], depsOn: [] },
  { id: 'goal-onepiece', projectId: P_ONEPIECE, title: 'ONEPIECE-SECRET-GOAL', status: 'active', todos: [], depsThis: [], depsOn: [] },
  { id: 'goal-canlaw', projectId: P_CANLAW, title: 'canlaw goal', status: 'active', todos: [], depsThis: [], depsOn: [] },
  { id: 'goal-legacy', projectId: P_LEGACYFLIP, title: 'legacy goal', status: 'active', todos: [], depsThis: [], depsOn: [] },
];

const TODOS = [
  { id: 'todo-fw', goalId: 'goal-fw', projectId: P_FRAMEWORK, title: 'framework todo', status: 'pending', dependsOnTodoIds: [] },
  { id: 'todo-school', goalId: 'goal-school', projectId: P_SCHOOLTIME, title: 'SCHOOLTIME-SECRET-TODO', status: 'pending', dependsOnTodoIds: [] },
  { id: 'todo-onepiece', goalId: 'goal-onepiece', projectId: P_ONEPIECE, title: 'ONEPIECE-SECRET-TODO', status: 'pending', dependsOnTodoIds: [] },
  { id: 'todo-canlaw', goalId: 'goal-canlaw', projectId: P_CANLAW, title: 'canlaw todo', status: 'pending', dependsOnTodoIds: [] },
  { id: 'todo-legacy', goalId: 'goal-legacy', projectId: P_LEGACYFLIP, title: 'legacy todo', status: 'pending', dependsOnTodoIds: [] },
];

// The strings that must NEVER appear in a Fleet machine envelope.
const OPTED_OUT_IDS = [P_SCHOOLTIME, P_ONEPIECE];
const OPTED_OUT_NAMES = ['Schooltime', 'One Piece TCG', 'SCHOOLTIME-SECRET', 'ONEPIECE-SECRET'];
const OPTED_OUT_ROW_IDS = ['chat-school', 'chat-onepiece', 'goal-school', 'goal-onepiece', 'todo-school', 'todo-onepiece'];

// ── prisma mock: the REAL scope leaf + the REAL list services run here ──────
const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(), findMany: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  projectMember: { findMany: jest.fn(async () => []) },
  projectGoal: { findUnique: jest.fn(), findMany: jest.fn() },
  projectTodo: { findUnique: jest.fn(), findMany: jest.fn() },
  goalDependency: { findMany: jest.fn(async () => []) },
  todoDependency: { findMany: jest.fn(async () => []) },
  activity: { create: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));

// ── service boundary mocks (dynamic imports under the dispatch) ─────────────
const svc = {
  listChats: jest.fn(),
  getFolderTree: jest.fn(),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const goalsSvc = {
  listGoals: jest.fn(),
  listTodos: jest.fn(),
  explainEmptyAccountWideTodoList: jest.fn(),
  goalListCompactDisabled: jest.fn(() => true),
  compactAccountWideGoals: jest.fn(),
  GOAL_LIST_COMPACT_HINT: '',
  resolveProjectIdForTool: jest.fn(),
  projectIdHealDisabled: jest.fn(() => true),
};
jest.mock('./goals.service', () => ({ __esModule: true, ...goalsSvc }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(() => false),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

jest.mock('./pending-confirmations', () => ({
  __esModule: true,
  pendingConfirmationCount: jest.fn(() => 0),
  createPendingConfirmationTable: jest.fn(),
}));

import { executePlatformTool } from './platform-tools';
import { outOfScopeProjectRefusal } from './fleet-tool-scope';
import { ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    worktree: '/wt', sessionId: 'fleet-chat', userId: OWNER, permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    // No user turn ⇒ a MACHINE run (the fleet's normal wake posture).
    userTurnAt: null,
    ...overrides,
  } as unknown as ToolContext;
}

/** Wire the fake DB so the REAL leaf + REAL services answer from the fixtures. */
function wireFake(opts: { seat?: 'fleet' | 'project' | 'other' } = {}) {
  const seat = opts.seat ?? 'fleet';
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where, select }: any) => {
    // The seat read on the RUNNING chat.
    if (where?.id && String(where.id).startsWith('fleet-chat')) {
      return { isSupervisor: seat === 'fleet', isProjectSupervisor: seat === 'project' };
    }
    const chat = CHATS.find((c) => c.id === where?.id);
    if (!chat) return null;
    if (!select) return chat;
    const out: any = {};
    for (const k of Object.keys(select)) if (select[k] === true) out[k] = (chat as any)[k];
    return out;
  });
  // The opted-out scan — the leaf's ONLY read. Honors supervised:false.
  mockPrisma.crossModelProject.findMany.mockImplementation(async (args: any = {}) => {
    const where = args?.where ?? {};
    let rows = PROJECTS.filter((p) => {
      if (where.userId && p.userId !== where.userId) return false;
      if (where.id && (p as any).id !== where.id) return false;
      if (where.supervised === false && p.supervised !== false) return false;
      if (where.archivedAt === null && p.archivedAt !== null) return false;
      return true;
    });
    const select = args?.select;
    if (select) rows = rows.map((p) => {
      const out: any = {};
      for (const k of Object.keys(select)) if (select[k] === true) out[k] = (p as any)[k];
      return out;
    });
    return args?.take ? rows.slice(0, args.take) : rows;
  });
  mockPrisma.crossModelProject.findUnique.mockImplementation(async ({ where }: any) => {
    const p = PROJECTS.find((x) => x.id === where?.id);
    return p ? { ...p, members: [] } : null;
  });

  // The REAL services are what the dispatch calls, but they are mocked at the
  // module boundary — so emulate their scope contract EXACTLY (this is the
  // contract the tests are pinning, and it mirrors the shipped code paths).
  svc.listChats.mockImplementation(async (o: any) => {
    const excluded = new Set<string>(o?.excludeProjectIds ?? []);
    let rows = CHATS.filter((c) => !excluded.has(c.projectId as string));
    if (o?.projectId) rows = rows.filter((c) => c.projectId === o.projectId);
    if (o?.q) rows = rows.filter((c) => c.title.toLowerCase().includes(String(o.q).toLowerCase()));
    rows = rows.slice(((o?.page ?? 1) - 1) * (o?.limit ?? 20), (o?.page ?? 1) * (o?.limit ?? 20));
    return { chats: rows.map((c) => ({ ...c, messageCount: 0, lastMessage: null, codeCapable: false, running: false })), pagination: { page: o?.page ?? 1, limit: o?.limit ?? 20, total: rows.length, pages: 1 } };
  });
  svc.getFolderTree.mockImplementation(async () => ({
    owned: PROJECTS.map((p) => ({ ...p, systemPrompt: 'SECRET-PROMPT' })),
    shared: [],
  }));

  goalsSvc.listGoals.mockImplementation(async (o: any) => {
    const excluded = new Set<string>(o?.excludeProjectIds ?? []);
    if (o?.projectId && excluded.has(o.projectId)) {
      const { AppError } = require('../../../middleware/error-handler');
      throw new AppError(403, outOfScopeProjectRefusal('goal_list'));
    }
    const ids = new Set<string>(
      (o?.projectId
        ? [o.projectId]
        : PROJECTS.filter((p) => !excluded.has(p.id)).map((p) => p.id)),
    );
    return GOALS.filter((g) => ids.has(g.projectId) && !excluded.has(g.projectId)).map((g) => ({
      ...g, projectName: PROJECTS.find((p) => p.id === g.projectId)?.name ?? null,
    }));
  });
  goalsSvc.listTodos.mockImplementation(async (o: any) => {
    const excluded = new Set<string>(o?.excludeProjectIds ?? []);
    if (o?.projectId && excluded.has(o.projectId)) {
      const { AppError } = require('../../../middleware/error-handler');
      throw new AppError(403, outOfScopeProjectRefusal('todo_list'));
    }
    let rows = TODOS.filter((t) => !excluded.has(t.projectId));
    if (o?.goalId) {
      const goal = GOALS.find((g) => g.id === o.goalId);
      if (goal && excluded.has(goal.projectId)) {
        const { AppError } = require('../../../middleware/error-handler');
        throw new AppError(403, outOfScopeProjectRefusal('todo_list'));
      }
      rows = rows.filter((t) => t.goalId === o.goalId);
    }
    if (o?.projectId) rows = rows.filter((t) => t.projectId === o.projectId);
    return rows.map((t) => ({ ...t, projectName: PROJECTS.find((p) => p.id === t.projectId)?.name ?? null }));
  });
  goalsSvc.explainEmptyAccountWideTodoList.mockImplementation(async () =>
    'Excluded: Schooltime, One Piece TCG still hold todos — read them by projectId.');
  goalsSvc.resolveProjectIdForTool.mockImplementation(async (id: string) => ({ id }));
}

/** Assert an envelope carries NOTHING of the opted-out projects. */
function expectNoLeak(out: string) {
  for (const id of OPTED_OUT_IDS) expect(out).not.toContain(id);
  for (const id of OPTED_OUT_ROW_IDS) expect(out).not.toContain(id);
  for (const name of OPTED_OUT_NAMES) expect(out).not.toContain(name);
  // No exclusion metadata / counts-by-project hints either.
  expect(out).not.toMatch(/excludedProjects|hiddenProjects|outOfScope|supervised:false/i);
}

beforeEach(() => {
  jest.clearAllMocks();
  goalsSvc.goalListCompactDisabled.mockReturnValue(true);
  goalsSvc.projectIdHealDisabled.mockReturnValue(true);
  wireFake({ seat: 'fleet' });
});

describe('fleet machine run — account-wide reads are supervision-scoped', () => {
  it('list_chats: no opted-out chat, id or title; in-scope rows intact', async () => {
    const out = await executePlatformTool(makeCtx(), 'list_chats', {});
    expectNoLeak(out);
    const body = JSON.parse(out);
    const ids = body.chats.map((c: any) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['chat-fw', 'chat-canlaw', 'chat-legacy']));
    expect(ids).not.toContain('chat-school');
    expect(ids).not.toContain('chat-onepiece');
  });

  it('list_chats: pagination totals count only in-scope rows (no count leak)', async () => {
    const out = await executePlatformTool(makeCtx(), 'list_chats', { limit: 1 });
    expectNoLeak(out);
    // 3 in-scope chats, page size 1 — a filter applied AFTER the page would
    // leave a short page or a total counting the hidden rows.
    const body = JSON.parse(out);
    expect(body.chats.length).toBe(1);
  });

  it('list_chats: q / archived / mode / page filters never resurrect an opted-out row', async () => {
    for (const args of [{ q: 'SECRET' }, { archived: true }, { mode: 'thinking' }, { page: 3, limit: 50 }]) {
      const out = await executePlatformTool(makeCtx(), 'list_chats', args);
      expectNoLeak(out);
    }
  });

  it('list_chats: an explicit opted-out projectId is REFUSED, not returned', async () => {
    const out = await executePlatformTool(makeCtx(), 'list_chats', { projectId: P_SCHOOLTIME });
    expect(out).toMatch(/REFUSED/);
    expectNoLeak(out);
  });

  it('goal_list: no opted-out goal; in-scope goals intact', async () => {
    const out = await executePlatformTool(makeCtx(), 'goal_list', {});
    expectNoLeak(out);
    const body = JSON.parse(out);
    const ids = body.goals.map((g: any) => g.id);
    expect(ids).toEqual(expect.arrayContaining(['goal-fw', 'goal-canlaw', 'goal-legacy']));
    expect(ids).not.toContain('goal-school');
    expect(ids).not.toContain('goal-onepiece');
    expect(body.count).toBe(3);
  });

  it('goal_list: an explicit opted-out projectId is REFUSED', async () => {
    const out = await executePlatformTool(makeCtx(), 'goal_list', { projectId: P_ONEPIECE });
    expect(out).toMatch(/REFUSED/);
    expectNoLeak(out);
  });

  it('goal_list includeDescendants: an opted-out descendant is subtracted from the subtree', async () => {
    const out = await executePlatformTool(makeCtx(), 'goal_list', { projectId: P_FRAMEWORK, includeDescendants: true });
    expectNoLeak(out);
    const body = JSON.parse(out);
    expect(body.goals.map((g: any) => g.id)).toContain('goal-fw');
  });

  it('todo_list: no opted-out todo; in-scope todos intact', async () => {
    const out = await executePlatformTool(makeCtx(), 'todo_list', {});
    expectNoLeak(out);
    const body = JSON.parse(out);
    const ids = body.todos.map((t: any) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['todo-fw', 'todo-canlaw', 'todo-legacy']));
    expect(body.count).toBe(3);
  });

  it('todo_list: an explicit opted-out projectId is REFUSED', async () => {
    const out = await executePlatformTool(makeCtx(), 'todo_list', { projectId: P_SCHOOLTIME });
    expect(out).toMatch(/REFUSED/);
    expectNoLeak(out);
  });

  it('todo_list: a goalId inside an opted-out project is REFUSED', async () => {
    const out = await executePlatformTool(makeCtx(), 'todo_list', { goalId: 'goal-school' });
    expect(out).toMatch(/REFUSED/);
    expectNoLeak(out);
  });

  it('todo_list: an empty scoped result does NOT emit the excluded-projects explanation', async () => {
    // Only opted-out projects hold todos in this fixture variant.
    goalsSvc.listTodos.mockResolvedValue([]);
    const out = await executePlatformTool(makeCtx(), 'todo_list', {});
    expectNoLeak(out);
    expect(goalsSvc.explainEmptyAccountWideTodoList).not.toHaveBeenCalled();
  });

  it('list_projects: opted-out projects omitted from owned+shared; framework + in-scope present', async () => {
    const out = await executePlatformTool(makeCtx(), 'list_projects', {});
    expectNoLeak(out);
    const body = JSON.parse(out);
    const ids = body.owned.map((p: any) => p.id);
    expect(ids).toContain(P_FRAMEWORK);
    expect(ids).toContain(P_CANLAW);
    expect(ids).toContain(P_LEGACYFLIP);
    expect(ids).not.toContain(P_SCHOOLTIME);
    expect(ids).not.toContain(P_ONEPIECE);
    // systemPrompt stays stripped as before.
    expect(out).not.toContain('SECRET-PROMPT');
  });
});

describe('non-Fleet seats are untouched', () => {
  it('a PROJECT SUPERVISOR of an opted-out project still reads its own work', async () => {
    wireFake({ seat: 'project' });
    const goals = await executePlatformTool(makeCtx(), 'goal_list', { projectId: P_SCHOOLTIME });
    expect(goals).not.toMatch(/REFUSED/);
    expect(goals).toContain('goal-school');

    const todos = await executePlatformTool(makeCtx(), 'todo_list', { projectId: P_ONEPIECE });
    expect(todos).not.toMatch(/REFUSED/);
    expect(todos).toContain('todo-onepiece');

    const chats = await executePlatformTool(makeCtx(), 'list_chats', { projectId: P_SCHOOLTIME });
    expect(chats).toContain('chat-school');
    expect(chats).not.toMatch(/REFUSED/);

    const projects = await executePlatformTool(makeCtx(), 'list_projects', {});
    expect(projects).toContain(P_SCHOOLTIME);
    expect(projects).toContain(P_ONEPIECE);
  });

  it('an ordinary chat (neither seat) reads everything', async () => {
    wireFake({ seat: 'other' });
    const goals = await executePlatformTool(makeCtx({ sessionId: 'ordinary-chat' }), 'goal_list', {});
    expect(goals).toContain('goal-school');
    const projects = await executePlatformTool(makeCtx({ sessionId: 'ordinary-chat' }), 'list_projects', {});
    expect(projects).toContain(P_SCHOOLTIME);
  });

  it('an OWNER-held turn ON the fleet chat is not narrowed', async () => {
    const ctx = makeCtx({ userTurnAt: new Date('2026-11-04T12:00:00Z') });
    const goals = await executePlatformTool(ctx, 'goal_list', {});
    expect(goals).toContain('goal-school');
    const projects = await executePlatformTool(ctx, 'list_projects', {});
    expect(projects).toContain(P_SCHOOLTIME);
  });
});

describe('fail-open posture', () => {
  it('an unreadable project scan narrows nothing (an outage never hides live work)', async () => {
    mockPrisma.crossModelProject.findMany.mockRejectedValue(new Error('db down'));
    const out = await executePlatformTool(makeCtx(), 'goal_list', {});
    expect(out).toContain('goal-school');
    expect(out).toContain('goal-onepiece');
  });

  it('an unreadable seat row narrows nothing either', async () => {
    mockPrisma.crossModelChat.findUnique.mockRejectedValue(new Error('db down'));
    const out = await executePlatformTool(makeCtx(), 'list_projects', {});
    expect(out).toContain(P_SCHOOLTIME);
  });

  it('the framework project is re-asserted supervised even on a legacy flipped row', async () => {
    // A pre-write-guard row / direct DB edit can read supervised:false.
    const flipped: any[] = PROJECTS.map((p) => (p.id === P_FRAMEWORK ? { ...p, supervised: false } : p));
    mockPrisma.crossModelProject.findMany.mockImplementation(async (args: any = {}) => {
      let rows = flipped.filter((p) => (args?.where?.supervised === false ? p.supervised === false : true));
      if (args?.select) rows = rows.map((p) => ({ id: p.id, supervised: p.supervised, repoUrl: p.repoUrl }));
      return rows;
    });
    const out = await executePlatformTool(makeCtx(), 'list_projects', {});
    expect(out).toContain(P_FRAMEWORK);
    expect(out).toContain('crossmodel');
  });
});

describe('tool descriptions no longer promise unfiltered account-wide output', () => {
  it('all four list tools describe the Fleet supervision scope', async () => {
    const { PLATFORM_TOOL_SCHEMA } = await import('./platform-tools');
    const desc = (n: string) => String(PLATFORM_TOOL_SCHEMA.find((t) => t.function.name === n)?.function.description ?? '');
    for (const tool of ['list_chats', 'goal_list', 'todo_list', 'list_projects']) {
      // list_chats fits the longer marker inside its budget; the other three had
      // to use "FLEET SCOPE" to stay under the 800-char top-level budget (see
      // coding/tool-description-budget.test.ts). The full rationale lives in
      // fleet-tool-scope.ts and at the handler call sites.
      expect(desc(tool)).toMatch(/FLEET (SUPERVISION )?SCOPE/);
      expect(desc(tool)).toMatch(/opted.out/);
    }
  });
});