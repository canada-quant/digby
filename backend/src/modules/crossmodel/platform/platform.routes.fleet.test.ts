/**
 * Fleet supervisor (slice D) — REST endpoints for goals / todos / hooks /
 * autonomy (platform.routes.ts), driven over real HTTP via an ephemeral
 * express app (the platform-auth.test.ts harness — no supertest dep).
 *
 * The fleet services (goals/hooks/autonomy) are mocked at the module boundary
 * — the routes reach them via DYNAMIC import, which jest.mock intercepts.
 * What this pins: auth requirement, zod validation (400s), scope mapping,
 * arg mapping into the services, response shapes (201s on create), and the
 * handle() AppError → status passthrough (404/403/409).
 *
 * JWT auth only — the agent-token/scope mechanics are pinned in
 * platform-auth.test.ts; here one insufficient_scope pin proves the fleet
 * routes wired requireScope.
 */

import express from 'express';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentToken: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(async () => ({})) },
  user: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  crossModelProject: { findUnique: jest.fn() },
  projectMember: { findUnique: jest.fn() },
  chatCodingState: { findMany: jest.fn(async () => []) },
  activity: { create: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// config/env calls process.exit(1) without env vars and kills the whole jest
// worker at import time (pulled in via middleware/error-handler, which only
// reads env.NODE_ENV). Mock env so the REAL AppError + errorHandler load.
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

// JWT verify mocked — the JWT path's crypto is covered by middleware/auth tests.
const mockVerifyAccessToken = jest.fn();
jest.mock('../../../utils/jwt', () => ({
  __esModule: true,
  verifyAccessToken: (...a: any[]) => mockVerifyAccessToken(...a),
}));

// platform.service under the pre-existing routes — fully mocked (this suite
// never calls it, but the router imports it statically).
const svc = new Proxy({} as Record<string, jest.Mock>, {
  get: (t, k) => (t[k as string] ??= jest.fn()),
});
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

// The fleet services — fully mocked; routing/validation/arg-mapping is what we pin.
const goalsSvc = {
  listGoals: jest.fn(),
  createGoal: jest.fn(),
  updateGoal: jest.fn(),
  getGoal: jest.fn(),
  listTodos: jest.fn(),
  createTodo: jest.fn(),
  updateTodo: jest.fn(),
};
jest.mock('./goals.service', () => ({ __esModule: true, ...goalsSvc }));

const hooksSvc = {
  listHooks: jest.fn(),
  subscribeHook: jest.fn(),
  unsubscribeHook: jest.fn(),
};
jest.mock('./hooks.service', () => ({ __esModule: true, ...hooksSvc }));

const autonomySvc = {
  getChatAutonomy: jest.fn(),
  setChatAutonomy: jest.fn(),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

const supervisorSvc = {
  ensureFleetSupervisor: jest.fn(),
};
jest.mock('./supervisor.service', () => ({ __esModule: true, ...supervisorSvc }));

import router from './platform.routes';
import { AppError, errorHandler } from '../../../middleware/error-handler';

// ── HTTP harness (mirrors platform-auth.test.ts) ─────────────────────────────

let server: any;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/platform', router);
  app.use(errorHandler); // mirror app.ts: ZodError → 400, AppError → its statusCode
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}/platform`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const USER = { id: 'u-1', email: 'a@b.c', role: 'USER' };
const JWT = 'a.jwt.token';
const PID = '11111111-1111-1111-1111-111111111111';
const GID = '22222222-2222-2222-2222-222222222222';
const TID = '33333333-3333-3333-3333-333333333333';
const CID = '44444444-4444-4444-4444-444444444444';
const CID2 = '55555555-5555-5555-5555-555555555555';
const HID = '66666666-6666-6666-6666-666666666666';

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyAccessToken.mockReturnValue({ userId: USER.id, email: USER.email, role: 'USER' });
  mockPrisma.agentToken.update.mockResolvedValue({});
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
});

async function api(path: string, opts: { method?: string; token?: string | null; body?: any } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('rejects unauthenticated requests to the fleet routes (401)', async () => {
    for (const [method, path] of [
      ['GET', `/goals?projectId=${PID}`],
      ['POST', '/goals'],
      ['GET', `/todos?goalId=${GID}`],
      ['POST', '/todos'],
      ['GET', '/hooks'],
      ['POST', '/hooks'],
      ['DELETE', `/hooks/${HID}`],
      ['GET', `/chats/${CID}/autonomy`],
      ['PUT', `/chats/${CID}/autonomy`],
      ['POST', '/supervisor/ensure'],
    ] as const) {
      const r = await api(path, { method, ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }) });
      expect(r.status).toBe(401);
    }
    expect(goalsSvc.listGoals).not.toHaveBeenCalled();
    expect(hooksSvc.listHooks).not.toHaveBeenCalled();
  });

  it('enforces requireScope on the fleet routes (agent token without folders:read is 403)', async () => {
    const raw = 'dgt_' + 'cd'.repeat(24);
    const { createHash } = await import('crypto');
    mockPrisma.agentToken.findUnique.mockImplementation(async ({ where }: any) =>
      where.tokenHash === createHash('sha256').update(raw).digest('hex')
        ? { id: 'tok-1', userId: USER.id, scopes: ['chats:read'], expiresAt: null, revokedAt: null, lastUsedAt: new Date() }
        : null);
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER, isActive: true, isChild: false, parentId: null });
    const r = await api(`/goals?projectId=${PID}`, { token: raw });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'insufficient_scope', required: ['folders:read'] });
    expect(goalsSvc.listGoals).not.toHaveBeenCalled();
  });

  it('PUT /chats/:id/autonomy rejects AGENT TOKENS outright (a machine principal must not self-grant autonomy)', async () => {
    const raw = 'dgt_' + 'ef'.repeat(24);
    const { createHash } = await import('crypto');
    mockPrisma.agentToken.findUnique.mockImplementation(async ({ where }: any) =>
      where.tokenHash === createHash('sha256').update(raw).digest('hex')
        ? { id: 'tok-1', userId: USER.id, scopes: ['chats:write'], expiresAt: null, revokedAt: null, lastUsedAt: new Date() }
        : null);
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER, isActive: true, isChild: false, parentId: null });
    const r = await api(`/chats/${CID}/autonomy`, { method: 'PUT', token: raw, body: { allowedTools: ['send_chat_message'] } });
    expect(r.status).toBe(403);
    expect(autonomySvc.setChatAutonomy).not.toHaveBeenCalled();
  });
});

// ── Goals ─────────────────────────────────────────────────────────────────────

describe('goals routes', () => {
  it('GET /goals lists with the query filters mapped', async () => {
    goalsSvc.listGoals.mockResolvedValue([{ id: GID, title: 'G' }]);
    const r = await api(`/goals?projectId=${PID}&includeDescendants=true&status=blocked`, { token: JWT });
    expect(r.status).toBe(200);
    expect(goalsSvc.listGoals).toHaveBeenCalledWith({
      userId: USER.id, projectId: PID, includeDescendants: true, status: 'blocked',
    });
    expect(r.body).toEqual({ goals: [{ id: GID, title: 'G' }] });
  });

  it('GET /goals without projectId lists ACCOUNT-WIDE (owner decision 2026-08-13: owned projects, tagged)', async () => {
    goalsSvc.listGoals.mockResolvedValue([{ id: GID, title: 'G', projectName: 'P1' }]);
    const r = await api('/goals', { token: JWT });
    expect(r.status).toBe(200);
    expect(goalsSvc.listGoals).toHaveBeenCalledWith({
      userId: USER.id, projectId: undefined, includeDescendants: undefined, status: undefined,
    });
    expect(r.body).toEqual({ goals: [{ id: GID, title: 'G', projectName: 'P1' }] });
  });

  it('GET /goals with a bad status enum is a 400', async () => {
    const r = await api(`/goals?projectId=${PID}&status=nope`, { token: JWT });
    expect(r.status).toBe(400);
    expect(goalsSvc.listGoals).not.toHaveBeenCalled();
  });

  it('POST /goals creates and returns 201 with the service result', async () => {
    goalsSvc.createGoal.mockResolvedValue({ id: GID, title: 'Ship v2', status: 'active' });
    const r = await api('/goals', {
      method: 'POST', token: JWT,
      body: { projectId: PID, title: 'Ship v2', description: 'D', dependsOnGoalIds: [GID] },
    });
    expect(r.status).toBe(201);
    expect(goalsSvc.createGoal).toHaveBeenCalledWith({
      userId: USER.id, projectId: PID, title: 'Ship v2', description: 'D', dependsOnGoalIds: [GID],
    });
    expect(r.body).toEqual({ id: GID, title: 'Ship v2', status: 'active' });
  });

  it('POST /goals without a title is a 400', async () => {
    const r = await api('/goals', { method: 'POST', token: JWT, body: { projectId: PID } });
    expect(r.status).toBe(400);
    expect(goalsSvc.createGoal).not.toHaveBeenCalled();
  });

  it('GET /goals/:id returns the detail; a service 404 maps to 404', async () => {
    goalsSvc.getGoal.mockResolvedValue({ id: GID, todos: [] });
    const ok = await api(`/goals/${GID}`, { token: JWT });
    expect(ok.status).toBe(200);
    expect(goalsSvc.getGoal).toHaveBeenCalledWith({ userId: USER.id, goalId: GID });

    goalsSvc.getGoal.mockRejectedValue(new AppError(404, 'Goal not found'));
    const missing = await api(`/goals/${GID}`, { token: JWT });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Goal not found' });
  });

  it('PATCH /goals/:id maps every field (incl. force) to the service', async () => {
    goalsSvc.updateGoal.mockResolvedValue({ id: GID, status: 'done' });
    const r = await api(`/goals/${GID}`, {
      method: 'PATCH', token: JWT,
      body: { title: 'T2', description: 'D2', status: 'done', blockedReason: 'r', dependsOnGoalIds: [PID], force: true },
    });
    expect(r.status).toBe(200);
    expect(goalsSvc.updateGoal).toHaveBeenCalledWith({
      userId: USER.id, goalId: GID, title: 'T2', description: 'D2', status: 'done',
      blockedReason: 'r', dependsOnGoalIds: [PID], force: true,
      ownerExplicit: true, // GOAL-OUTCOME-UNMET review fix: a JWT caller is the owner writing directly
    });
  });

  it('PATCH /goals/:id with a dgt_ AGENT token is a machine write — never the owner accepting an unmet outcome (review fix 2026-10-20)', async () => {
    const raw = 'dgt_' + 'ab'.repeat(24);
    const { createHash } = await import('crypto');
    mockPrisma.agentToken.findUnique.mockImplementation(async ({ where }: any) =>
      where.tokenHash === createHash('sha256').update(raw).digest('hex')
        ? { id: 'tok-1', userId: USER.id, scopes: ['folders:write'], expiresAt: null, revokedAt: null, lastUsedAt: new Date() }
        : null);
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER, isActive: true, isChild: false, parentId: null });
    goalsSvc.updateGoal.mockResolvedValue({ id: GID, status: 'done' });
    const r = await api(`/goals/${GID}`, { method: 'PATCH', token: raw, body: { status: 'done' } });
    expect(r.status).toBe(200);
    const args = goalsSvc.updateGoal.mock.calls[0][0];
    expect(args.machineTriggered).toBe(true);
    expect(args).not.toHaveProperty('ownerExplicit');
  });

  it('PATCH /goals/:id passes a service 409 (done-gate) through with its message', async () => {
    goalsSvc.updateGoal.mockRejectedValue(new AppError(409, 'Goal cannot be marked done: waiting on 1 goal(s) not done'));
    const r = await api(`/goals/${GID}`, { method: 'PATCH', token: JWT, body: { status: 'done' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/waiting on 1 goal/);
  });

  it('PATCH /goals/:id with a bad status enum is a 400', async () => {
    const r = await api(`/goals/${GID}`, { method: 'PATCH', token: JWT, body: { status: 'nope' } });
    expect(r.status).toBe(400);
    expect(goalsSvc.updateGoal).not.toHaveBeenCalled();
  });
});

// ── Todos ─────────────────────────────────────────────────────────────────────

describe('todos routes', () => {
  it('GET /todos accepts goalId or projectId and maps the filter', async () => {
    goalsSvc.listTodos.mockResolvedValue([{ id: TID }]);
    const byGoal = await api(`/todos?goalId=${GID}`, { token: JWT });
    expect(byGoal.status).toBe(200);
    expect(goalsSvc.listTodos).toHaveBeenCalledWith({ userId: USER.id, goalId: GID, projectId: undefined });
    expect(byGoal.body).toEqual({ todos: [{ id: TID }] });

    goalsSvc.listTodos.mockClear();
    const byProject = await api(`/todos?projectId=${PID}`, { token: JWT });
    expect(byProject.status).toBe(200);
    expect(goalsSvc.listTodos).toHaveBeenCalledWith({ userId: USER.id, goalId: undefined, projectId: PID });
  });

  it('GET /todos with NO filter lists ACCOUNT-WIDE; both filters together stay a 400', async () => {
    goalsSvc.listTodos.mockResolvedValue([{ id: TID, projectName: 'P1' }]);
    const r = await api('/todos', { token: JWT });
    expect(r.status).toBe(200);
    expect(goalsSvc.listTodos).toHaveBeenCalledWith({ userId: USER.id, goalId: undefined, projectId: undefined });
    expect(r.body).toEqual({ todos: [{ id: TID, projectName: 'P1' }] });

    goalsSvc.listTodos.mockClear();
    expect((await api(`/todos?goalId=${GID}&projectId=${PID}`, { token: JWT })).status).toBe(400);
    expect(goalsSvc.listTodos).not.toHaveBeenCalled();
  });

  it('POST /todos creates and returns 201', async () => {
    goalsSvc.createTodo.mockResolvedValue({ id: TID, status: 'pending' });
    const r = await api('/todos', {
      method: 'POST', token: JWT,
      body: { goalId: GID, title: 'step', assigneeChatId: CID, dependsOnTodoIds: [TID] },
    });
    expect(r.status).toBe(201);
    expect(goalsSvc.createTodo).toHaveBeenCalledWith({
      userId: USER.id, goalId: GID, title: 'step', assigneeChatId: CID, dependsOnTodoIds: [TID],
    });
    expect(r.body).toEqual({ id: TID, status: 'pending' });
  });

  it('POST /todos without goalId/title is a 400', async () => {
    expect((await api('/todos', { method: 'POST', token: JWT, body: { title: 'x' } })).status).toBe(400);
    expect((await api('/todos', { method: 'POST', token: JWT, body: { goalId: GID } })).status).toBe(400);
    expect(goalsSvc.createTodo).not.toHaveBeenCalled();
  });

  it('PATCH /todos/:id maps fields including assigneeChatId null (unassign)', async () => {
    goalsSvc.updateTodo.mockResolvedValue({ id: TID, status: 'done', assigneeChatId: null });
    const r = await api(`/todos/${TID}`, {
      method: 'PATCH', token: JWT,
      body: { status: 'done', assigneeChatId: null, force: true },
    });
    expect(r.status).toBe(200);
    expect(goalsSvc.updateTodo).toHaveBeenCalledWith({
      userId: USER.id, todoId: TID, title: undefined, status: 'done',
      blockedReason: undefined, assigneeChatId: null, dependsOnTodoIds: undefined, force: true,
    });
  });
});

// ── Hooks ─────────────────────────────────────────────────────────────────────

describe('hooks routes', () => {
  it('GET /hooks maps the optional filters', async () => {
    hooksSvc.listHooks.mockResolvedValue([{ id: HID }]);
    const r = await api(`/hooks?sourceChatId=${CID}&targetChatId=${CID2}`, { token: JWT });
    expect(r.status).toBe(200);
    expect(hooksSvc.listHooks).toHaveBeenCalledWith({ userId: USER.id, sourceChatId: CID, targetChatId: CID2 });
    expect(r.body).toEqual({ hooks: [{ id: HID }] });
  });

  it('POST /hooks subscribes and returns 201', async () => {
    hooksSvc.subscribeHook.mockResolvedValue({ id: HID, debounceSec: 120 });
    const r = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { sourceChatId: CID, targetChatId: CID2, eventTypes: ['run_completed', 'todo_done'], promptTemplate: 'PT', debounceSec: 120 },
    });
    expect(r.status).toBe(201);
    expect(hooksSvc.subscribeHook).toHaveBeenCalledWith({
      userId: USER.id, sourceChatId: CID, targetChatId: CID2,
      eventTypes: ['run_completed', 'todo_done'], promptTemplate: 'PT', debounceSec: 120,
      createdVia: 'rest',
    });
    expect(r.body).toEqual({ id: HID, debounceSec: 120 });
  });

  it('POST /hooks rejects an invalid event type and an empty array (400)', async () => {
    const bad = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { sourceChatId: CID, targetChatId: CID2, eventTypes: ['exploded'] },
    });
    expect(bad.status).toBe(400);
    const empty = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { sourceChatId: CID, targetChatId: CID2, eventTypes: [] },
    });
    expect(empty.status).toBe(400);
    expect(hooksSvc.subscribeHook).not.toHaveBeenCalled();
  });

  it('POST /hooks accepts omitted or null sourceChatId (owner-scope wildcard)', async () => {
    hooksSvc.subscribeHook.mockResolvedValue({ id: HID, sourceChatId: null });
    const omitted = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { targetChatId: CID2, eventTypes: ['run_completed'] },
    });
    expect(omitted.status).toBe(201);
    expect(hooksSvc.subscribeHook).toHaveBeenCalledWith({
      userId: USER.id, sourceChatId: undefined, targetChatId: CID2,
      eventTypes: ['run_completed'], promptTemplate: undefined, debounceSec: undefined,
      createdVia: 'rest',
    });

    const explicitNull = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { sourceChatId: null, targetChatId: CID2, eventTypes: ['run_completed'] },
    });
    expect(explicitNull.status).toBe(201);
    expect(hooksSvc.subscribeHook).toHaveBeenLastCalledWith({
      userId: USER.id, sourceChatId: null, targetChatId: CID2,
      eventTypes: ['run_completed'], promptTemplate: undefined, debounceSec: undefined,
      createdVia: 'rest',
    });
  });

  // ── WI-E (2026-09-25): projectId — project-scope parity with hook_subscribe ──

  it('POST /hooks {projectId} creates a PROJECT-SCOPE wildcard (projectId forwarded, sourceChatId absent, createdVia rest)', async () => {
    hooksSvc.subscribeHook.mockResolvedValue({ id: HID, sourceChatId: null, projectId: PID, targetChatId: CID2, createdVia: 'rest' });
    const r = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { projectId: PID, targetChatId: CID2, eventTypes: ['run_completed', 'run_failed'] },
    });
    expect(r.status).toBe(201);
    expect(hooksSvc.subscribeHook).toHaveBeenCalledWith({
      userId: USER.id, sourceChatId: undefined, projectId: PID, targetChatId: CID2,
      eventTypes: ['run_completed', 'run_failed'], promptTemplate: undefined, debounceSec: undefined,
      createdVia: 'rest',
    });
    expect(r.body).toEqual({ id: HID, sourceChatId: null, projectId: PID, targetChatId: CID2, createdVia: 'rest' });
  });

  it('POST /hooks {projectId: null} is the plain owner-scope wildcard (no projectId forwarded)', async () => {
    hooksSvc.subscribeHook.mockResolvedValue({ id: HID, sourceChatId: null });
    const r = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { projectId: null, targetChatId: CID2, eventTypes: ['run_completed'] },
    });
    expect(r.status).toBe(201);
    const call = hooksSvc.subscribeHook.mock.calls[0][0];
    expect('projectId' in call).toBe(false);
    expect(call).toMatchObject({ userId: USER.id, targetChatId: CID2, createdVia: 'rest' });
  });

  it('POST /hooks rejects projectId + sourceChatId together (400 — mutually exclusive, same rule as the tool)', async () => {
    const r = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { projectId: PID, sourceChatId: CID, targetChatId: CID2, eventTypes: ['run_completed'] },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/mutually exclusive/);
    expect(hooksSvc.subscribeHook).not.toHaveBeenCalled();
  });

  it('POST /hooks rejects a malformed (non-uuid) projectId (400)', async () => {
    const r = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { projectId: 'not-a-uuid', targetChatId: CID2, eventTypes: ['run_completed'] },
    });
    expect(r.status).toBe(400);
    expect(hooksSvc.subscribeHook).not.toHaveBeenCalled();
  });

  it('POST /hooks passes the service 404 for a foreign/missing project through', async () => {
    hooksSvc.subscribeHook.mockRejectedValue(new AppError(404, 'Project not found or not owned by this user'));
    const r = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { projectId: PID, targetChatId: CID2, eventTypes: ['run_completed'] },
    });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'Project not found or not owned by this user' });
  });

  it('POST /hooks still rejects a malformed (non-uuid) sourceChatId (400)', async () => {
    const r = await api('/hooks', {
      method: 'POST', token: JWT,
      body: { sourceChatId: 'not-a-uuid', targetChatId: CID2, eventTypes: ['run_completed'] },
    });
    expect(r.status).toBe(400);
    expect(hooksSvc.subscribeHook).not.toHaveBeenCalled();
  });

  it('DELETE /hooks/:id returns success, or 404 when the hook is gone', async () => {
    hooksSvc.unsubscribeHook.mockResolvedValue(true);
    const ok = await api(`/hooks/${HID}`, { method: 'DELETE', token: JWT });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true });
    expect(hooksSvc.unsubscribeHook).toHaveBeenCalledWith({ userId: USER.id, hookId: HID });

    hooksSvc.unsubscribeHook.mockResolvedValue(false);
    const gone = await api(`/hooks/${HID}`, { method: 'DELETE', token: JWT });
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ error: 'Hook not found' });
  });
});

// ── Autonomy ──────────────────────────────────────────────────────────────────

describe('autonomy routes', () => {
  it('GET /chats/:id/autonomy returns the grant for an accessible chat', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: CID, userId: USER.id, projectId: null });
    autonomySvc.getChatAutonomy.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 48 });
    const r = await api(`/chats/${CID}/autonomy`, { token: JWT });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ chatId: CID, allowedTools: ['send_chat_message'], scheduleCap: 48 });
    expect(autonomySvc.getChatAutonomy).toHaveBeenCalledWith(CID);
  });

  it('GET /chats/:id/autonomy 404s when no grant exists', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: CID, userId: USER.id, projectId: null });
    autonomySvc.getChatAutonomy.mockResolvedValue(null);
    const r = await api(`/chats/${CID}/autonomy`, { token: JWT });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'No autonomy grant for this chat' });
  });

  it('GET /chats/:id/autonomy 404s for a missing or unrelated chat (no existence leak)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    expect((await api(`/chats/${CID}/autonomy`, { token: JWT })).status).toBe(404);

    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: CID, userId: 'someone-else', projectId: null });
    const r = await api(`/chats/${CID}/autonomy`, { token: JWT });
    expect(r.status).toBe(404);
    expect(autonomySvc.getChatAutonomy).not.toHaveBeenCalled();
  });

  it('PUT /chats/:id/autonomy grants and returns the service result', async () => {
    autonomySvc.setChatAutonomy.mockResolvedValue({
      granted: true, chatId: CID, allowedTools: ['send_chat_message'], scheduleCap: 96,
    });
    const r = await api(`/chats/${CID}/autonomy`, {
      method: 'PUT', token: JWT,
      body: { allowedTools: ['send_chat_message'], scheduleCap: 96 },
    });
    expect(r.status).toBe(200);
    expect(autonomySvc.setChatAutonomy).toHaveBeenCalledWith({
      userId: USER.id, chatId: CID, allowedTools: ['send_chat_message'], scheduleCap: 96,
    });
    expect(r.body.granted).toBe(true);
  });

  it('PUT /chats/:id/autonomy with an empty allowedTools revokes', async () => {
    autonomySvc.setChatAutonomy.mockResolvedValue({ granted: false, chatId: CID, allowedTools: [], scheduleCap: null });
    const r = await api(`/chats/${CID}/autonomy`, { method: 'PUT', token: JWT, body: { allowedTools: [] } });
    expect(r.status).toBe(200);
    expect(autonomySvc.setChatAutonomy).toHaveBeenCalledWith({
      userId: USER.id, chatId: CID, allowedTools: [], scheduleCap: undefined,
    });
    expect(r.body.granted).toBe(false);
  });

  it('PUT /chats/:id/autonomy rejects a non-grantable tool (400 zod)', async () => {
    const r = await api(`/chats/${CID}/autonomy`, {
      method: 'PUT', token: JWT, body: { allowedTools: ['set_chat_autonomy'] },
    });
    expect(r.status).toBe(400);
    expect(autonomySvc.setChatAutonomy).not.toHaveBeenCalled();
  });

  it('PUT /chats/:id/autonomy passes the service 403 (non-owner) through', async () => {
    autonomySvc.setChatAutonomy.mockRejectedValue(new AppError(403, 'Only the chat owner can grant autonomy for it'));
    const r = await api(`/chats/${CID}/autonomy`, {
      method: 'PUT', token: JWT, body: { allowedTools: ['send_chat_message'] },
    });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'Only the chat owner can grant autonomy for it' });
  });
});

// ── Fleet Supervisor (global) ─────────────────────────────────────────────────

describe('POST /supervisor/ensure', () => {
  const SUP = { id: CID, title: 'Fleet Supervisor', isSupervisor: true, projectId: null };

  it('ensures + returns the caller\'s ONE global Fleet Supervisor chat', async () => {
    supervisorSvc.ensureFleetSupervisor.mockResolvedValue(SUP);
    const r = await api('/supervisor/ensure', { method: 'POST', token: JWT });
    expect(r.status).toBe(200);
    expect(supervisorSvc.ensureFleetSupervisor).toHaveBeenCalledWith(USER.id);
    expect(r.body).toEqual(SUP);
  });

  it('maps a service failure (null — the service never throws) to a 500', async () => {
    supervisorSvc.ensureFleetSupervisor.mockResolvedValue(null);
    const r = await api('/supervisor/ensure', { method: 'POST', token: JWT });
    expect(r.status).toBe(500);
  });
});
