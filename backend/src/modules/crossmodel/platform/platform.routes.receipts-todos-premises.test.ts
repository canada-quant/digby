/**
 * WI-N (2026-09-25) — route-level pins for three routes that shipped without
 * tests: GET /chats/:id/receipts (T3a — the run tool receipts, served by the
 * get_run_receipts platform tool), PATCH /todos/:id (fleet slice D) and
 * POST /goals/:id/premises (T4c parity with goal_premise_set).
 *
 * Same harness as platform.routes.fleet.test.ts (ephemeral express app over
 * real HTTP, services mocked at the module boundary — the routes reach
 * platform-tools / goals.service via DYNAMIC import, which jest.mock
 * intercepts). Pins: auth (401) + scope (403), zod validation (400s), the arg
 * mapping into executePlatformTool / goals.service, response shapes and the
 * handle() AppError → status passthrough.
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

jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

const mockVerifyAccessToken = jest.fn();
jest.mock('../../../utils/jwt', () => ({
  __esModule: true,
  verifyAccessToken: (...a: any[]) => mockVerifyAccessToken(...a),
}));

const svc = new Proxy({} as Record<string, jest.Mock>, {
  get: (t, k) => (t[k as string] ??= jest.fn()),
});
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

// platform-tools — DYNAMIC import inside GET /chats/:id/receipts. Mocked with a
// factory so its (huge) import graph never loads; the route only needs
// executePlatformTool.
const mockExecutePlatformTool = jest.fn();
jest.mock('./platform-tools', () => ({
  __esModule: true,
  executePlatformTool: (...a: any[]) => mockExecutePlatformTool(...a),
}));

const goalsSvc = {
  updateTodo: jest.fn(),
  setGoalPremises: jest.fn(),
  listGoals: jest.fn(),
  createGoal: jest.fn(),
  updateGoal: jest.fn(),
  getGoal: jest.fn(),
  listTodos: jest.fn(),
  createTodo: jest.fn(),
  getTodo: jest.fn(),
};
jest.mock('./goals.service', () => ({ __esModule: true, ...goalsSvc }));
jest.mock('./hooks.service', () => ({ __esModule: true }));
jest.mock('./autonomy.service', () => ({ __esModule: true }));
jest.mock('./supervisor.service', () => ({ __esModule: true }));

import router from './platform.routes';
import { AppError, errorHandler } from '../../../middleware/error-handler';

// ── HTTP harness (mirrors platform.routes.fleet.test.ts) ─────────────────────

let server: any;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/platform', router);
  app.use(errorHandler);
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
const GID = '22222222-2222-2222-2222-222222222222';
const TID = '33333333-3333-3333-3333-333333333333';
const CID = '44444444-4444-4444-4444-444444444444';
const RID = '88888888-8888-8888-8888-888888888888';

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

async function agentToken(scopes: string[], seed: string): Promise<string> {
  const raw = 'dgt_' + seed.repeat(24);
  const { createHash } = await import('crypto');
  mockPrisma.agentToken.findUnique.mockImplementation(async ({ where }: any) =>
    where.tokenHash === createHash('sha256').update(raw).digest('hex')
      ? { id: 'tok-1', userId: USER.id, scopes, expiresAt: null, revokedAt: null, lastUsedAt: new Date() }
      : null);
  mockPrisma.user.findUnique.mockResolvedValue({ ...USER, isActive: true, isChild: false, parentId: null });
  return raw;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('auth', () => {
  it('rejects unauthenticated requests (401)', async () => {
    expect((await api(`/chats/${CID}/receipts`)).status).toBe(401);
    expect((await api(`/todos/${TID}`, { method: 'PATCH', body: { status: 'done' } })).status).toBe(401);
    expect((await api(`/goals/${GID}/premises`, { method: 'POST', body: { premises: {} } })).status).toBe(401);
    expect(mockExecutePlatformTool).not.toHaveBeenCalled();
    expect(goalsSvc.updateTodo).not.toHaveBeenCalled();
    expect(goalsSvc.setGoalPremises).not.toHaveBeenCalled();
  });

  it('GET /chats/:id/receipts needs chats:read; PATCH /todos/:id and POST /goals/:id/premises need folders:write', async () => {
    const raw = await agentToken(['folders:read'], 'ab');
    const receipts = await api(`/chats/${CID}/receipts`, { token: raw });
    expect(receipts.status).toBe(403);
    expect(receipts.body).toEqual({ error: 'insufficient_scope', required: ['chats:read'] });

    const todo = await api(`/todos/${TID}`, { method: 'PATCH', token: raw, body: { status: 'done' } });
    expect(todo.status).toBe(403);
    expect(todo.body).toEqual({ error: 'insufficient_scope', required: ['folders:write'] });

    const premises = await api(`/goals/${GID}/premises`, { method: 'POST', token: raw, body: { premises: {} } });
    expect(premises.status).toBe(403);
    expect(premises.body).toEqual({ error: 'insufficient_scope', required: ['folders:write'] });

    expect(mockExecutePlatformTool).not.toHaveBeenCalled();
    expect(goalsSvc.updateTodo).not.toHaveBeenCalled();
    expect(goalsSvc.setGoalPremises).not.toHaveBeenCalled();
  });
});

// ── GET /chats/:id/receipts ───────────────────────────────────────────────────

describe('GET /chats/:id/receipts', () => {
  const OK = { ok: true, tool: 'get_run_receipts', chatId: CID, runs: [{ id: RID, status: 'completed', receipts: [] }] };

  it('runs get_run_receipts as the caller (auto mode, no session) and returns the parsed tool result', async () => {
    mockExecutePlatformTool.mockResolvedValue(JSON.stringify(OK));
    const r = await api(`/chats/${CID}/receipts`, { token: JWT });
    expect(r.status).toBe(200);
    expect(mockExecutePlatformTool).toHaveBeenCalledTimes(1);
    const [ctx, tool, args] = mockExecutePlatformTool.mock.calls[0];
    expect(ctx).toEqual({ sessionId: '', userId: USER.id, permissionMode: 'auto' });
    expect(tool).toBe('get_run_receipts');
    expect(args).toEqual({ chatId: CID, runId: undefined, limit: undefined });
    expect(r.body).toEqual(OK);
  });

  it('forwards runId and limit from the query string', async () => {
    mockExecutePlatformTool.mockResolvedValue(JSON.stringify(OK));
    const r = await api(`/chats/${CID}/receipts?runId=${RID}&limit=5`, { token: JWT });
    expect(r.status).toBe(200);
    expect(mockExecutePlatformTool.mock.calls[0][2]).toEqual({ chatId: CID, runId: RID, limit: 5 });
  });

  // Ticket e225aad8 (review finding 8): a chat / supervisor turn's telemetry
  // id (chat-<uuid>) must pass the REST validation and reach the tool — a
  // chat turn's receipts resolve over REST the same way they do in-loop.
  // The old z.string().uuid() shape rejected chat- ids with 400 before the
  // handler ever ran.
  it('accepts a chat-turn id (chat-<uuid>) as runId and forwards it to the tool (review finding 8)', async () => {
    mockExecutePlatformTool.mockResolvedValue(JSON.stringify(OK));
    const turnId = `chat-${RID}`;
    const r = await api(`/chats/${CID}/receipts?runId=${turnId}`, { token: JWT });
    expect(r.status).toBe(200);
    expect(mockExecutePlatformTool.mock.calls[0][2]).toEqual({ chatId: CID, runId: turnId, limit: undefined });
  });

  it('still rejects a malformed runId with 400 (validation guards the query shape)', async () => {
    mockExecutePlatformTool.mockResolvedValue(JSON.stringify(OK));
    const r = await api(`/chats/${CID}/receipts?runId=not-a-real-id`, { token: JWT });
    expect(r.status).toBe(400);
    expect(mockExecutePlatformTool).not.toHaveBeenCalled();
  });

  it('maps a not_found tool result to 404 with the tool\'s message (no existence leak beyond the tool\'s own wording)', async () => {
    mockExecutePlatformTool.mockResolvedValue(JSON.stringify({ ok: false, reason: 'not_found', message: 'No chat you can read matches that id.' }));
    const r = await api(`/chats/${CID}/receipts`, { token: JWT });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'No chat you can read matches that id.' });
  });

  it('maps any other refusal to 400 (falling back to a generic message when the tool gives none)', async () => {
    mockExecutePlatformTool.mockResolvedValue(JSON.stringify({ ok: false, reason: 'invalid', message: 'chatId is required.' }));
    const invalid = await api(`/chats/${CID}/receipts`, { token: JWT });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({ error: 'chatId is required.' });

    mockExecutePlatformTool.mockResolvedValue(JSON.stringify({ ok: false }));
    const bare = await api(`/chats/${CID}/receipts`, { token: JWT });
    expect(bare.status).toBe(400);
    expect(bare.body).toEqual({ error: 'receipts read failed' });
  });

  it('400s on a non-uuid chat id before the tool runs', async () => {
    const r = await api('/chats/not-a-uuid/receipts', { token: JWT });
    expect(r.status).toBe(400);
    expect(mockExecutePlatformTool).not.toHaveBeenCalled();
  });
});

// ── PATCH /todos/:id ──────────────────────────────────────────────────────────

describe('PATCH /todos/:id', () => {
  it('maps every field (title, status, blockedReason, assigneeChatId, dependsOnTodoIds, force) to updateTodo', async () => {
    goalsSvc.updateTodo.mockResolvedValue({ id: TID, status: 'blocked' });
    const r = await api(`/todos/${TID}`, {
      method: 'PATCH', token: JWT,
      body: { title: 'T2', status: 'blocked', blockedReason: 'waiting on DNS', assigneeChatId: CID, dependsOnTodoIds: [GID], force: false },
    });
    expect(r.status).toBe(200);
    expect(goalsSvc.updateTodo).toHaveBeenCalledWith({
      userId: USER.id, todoId: TID, title: 'T2', status: 'blocked', blockedReason: 'waiting on DNS',
      assigneeChatId: CID, dependsOnTodoIds: [GID], force: false,
    });
    expect(r.body).toEqual({ id: TID, status: 'blocked' });
  });

  it('400s on a bad status enum, a non-uuid assigneeChatId, an empty title and a non-uuid dependency', async () => {
    for (const body of [
      { status: 'nope' },
      { assigneeChatId: 'not-a-uuid' },
      { title: '' },
      { dependsOnTodoIds: ['not-a-uuid'] },
    ]) {
      const r = await api(`/todos/${TID}`, { method: 'PATCH', token: JWT, body });
      expect(r.status).toBe(400);
    }
    expect(goalsSvc.updateTodo).not.toHaveBeenCalled();
  });

  it('accepts the `dropped` status (the 2026-09 todo lifecycle) and an empty body (the service decides what a no-op means)', async () => {
    goalsSvc.updateTodo.mockResolvedValue({ id: TID, status: 'dropped' });
    const r = await api(`/todos/${TID}`, { method: 'PATCH', token: JWT, body: { status: 'dropped' } });
    expect(r.status).toBe(200);
    expect(goalsSvc.updateTodo).toHaveBeenCalledWith(expect.objectContaining({ userId: USER.id, todoId: TID, status: 'dropped' }));

    goalsSvc.updateTodo.mockResolvedValue({ id: TID });
    const empty = await api(`/todos/${TID}`, { method: 'PATCH', token: JWT, body: {} });
    expect(empty.status).toBe(200);
    expect(goalsSvc.updateTodo).toHaveBeenLastCalledWith({
      userId: USER.id, todoId: TID, title: undefined, status: undefined, blockedReason: undefined,
      assigneeChatId: undefined, dependsOnTodoIds: undefined, force: undefined,
    });
  });

  it('passes service errors through with their status (404 unknown todo, 409 done-gate)', async () => {
    goalsSvc.updateTodo.mockRejectedValue(new AppError(404, 'Todo not found'));
    const missing = await api(`/todos/${TID}`, { method: 'PATCH', token: JWT, body: { status: 'done' } });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Todo not found' });

    goalsSvc.updateTodo.mockRejectedValue(new AppError(409, 'Todo cannot be marked done: waiting on 2 todo(s) not done'));
    const gated = await api(`/todos/${TID}`, { method: 'PATCH', token: JWT, body: { status: 'done' } });
    expect(gated.status).toBe(409);
    expect(gated.body.error).toMatch(/waiting on 2 todo/);
  });
});

// ── POST /goals/:id/premises ──────────────────────────────────────────────────

describe('POST /goals/:id/premises', () => {
  const PREMISES = { budget: { value: 'under $150k', confidence: 'owner-stated' }, deadline: 'Q4' };

  it('maps premises + mode to setGoalPremises and returns the goal view (200, not 201 — it is an update)', async () => {
    goalsSvc.setGoalPremises.mockResolvedValue({ id: GID, premises: PREMISES });
    const r = await api(`/goals/${GID}/premises`, { method: 'POST', token: JWT, body: { premises: PREMISES, mode: 'replace' } });
    expect(r.status).toBe(200);
    expect(goalsSvc.setGoalPremises).toHaveBeenCalledWith({ userId: USER.id, goalId: GID, premises: PREMISES, mode: 'replace' });
    expect(r.body).toEqual({ id: GID, premises: PREMISES });
  });

  it('mode is optional (the service defaults to merge) and premises may be any JSON shape — the service validates it', async () => {
    goalsSvc.setGoalPremises.mockResolvedValue({ id: GID });
    const obj = await api(`/goals/${GID}/premises`, { method: 'POST', token: JWT, body: { premises: PREMISES } });
    expect(obj.status).toBe(200);
    expect(goalsSvc.setGoalPremises).toHaveBeenCalledWith({ userId: USER.id, goalId: GID, premises: PREMISES, mode: undefined });

    const arr = await api(`/goals/${GID}/premises`, { method: 'POST', token: JWT, body: { premises: ['a', 'b'] } });
    expect(arr.status).toBe(200);
    expect(goalsSvc.setGoalPremises).toHaveBeenLastCalledWith({ userId: USER.id, goalId: GID, premises: ['a', 'b'], mode: undefined });
  });

  it('400s on a bad mode enum or a non-uuid goal id', async () => {
    expect((await api(`/goals/${GID}/premises`, { method: 'POST', token: JWT, body: { premises: {}, mode: 'overwrite' } })).status).toBe(400);
    expect((await api('/goals/not-a-uuid/premises', { method: 'POST', token: JWT, body: { premises: {} } })).status).toBe(400);
    expect(goalsSvc.setGoalPremises).not.toHaveBeenCalled();
  });

  it('passes service errors through (404 unknown goal, 400 malformed premises from the service\'s own validation)', async () => {
    goalsSvc.setGoalPremises.mockRejectedValue(new AppError(404, 'Goal not found'));
    const missing = await api(`/goals/${GID}/premises`, { method: 'POST', token: JWT, body: { premises: PREMISES } });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'Goal not found' });

    goalsSvc.setGoalPremises.mockRejectedValue(new AppError(400, 'premises must be an object of named premises'));
    const malformed = await api(`/goals/${GID}/premises`, { method: 'POST', token: JWT, body: { premises: 42 } });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: 'premises must be an object of named premises' });
  });
});
