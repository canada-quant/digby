/**
 * Platform unification (P3) — agent-token auth + platform REST API tests.
 *
 * Covers the authenticatePlatform middleware (JWT vs dgt_ agent tokens),
 * requireScope gating, the JWT-only token-management endpoints (mint stores
 * sha256, never the raw token; prefix kept for UI), child-account rejection
 * on code:run, and lastUsedAt write throttling.
 *
 * Prisma + platform.service are fully mocked (pattern follows
 * platform.service.test.ts / platform-tools.test.ts); the router is driven
 * over real HTTP via an ephemeral express app (no supertest dep).
 */

import express from 'express';
import { createHash } from 'crypto';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentToken: { findUnique: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(async () => ({})) },
  user: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  chatCodingState: { findMany: jest.fn(async () => []) },
  activity: { create: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// config/env calls process.exit(1) without env vars and kills the whole jest
// worker at import time (pulled in via middleware/error-handler, which only
// reads env.NODE_ENV). Mock env so the REAL AppError + errorHandler load —
// this suite mounts errorHandler on an express app and asserts its mapping.
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

// The service layer under the routes — fully mocked; auth/scoping/mapping is what we pin.
const svc = {
  listChats: jest.fn(async () => ({ chats: [], pagination: { page: 1, limit: 50, total: 0, pages: 0 } })),
  createChat: jest.fn(async (o: any) => ({ id: 'chat-new', ...o })),
  getChatStatus: jest.fn(async () => ({ id: 'chat-1', running: false })),
  sendChatMessage: jest.fn(async () => ({ queued: true })),
  renameChat: jest.fn(async (o: any) => ({ id: o.chatId })),
  archiveChat: jest.fn(async (o: any) => ({ id: o.chatId, archived: o.archived })),
  moveChat: jest.fn(async (o: any) => ({ id: o.chatId })),
  deleteChat: jest.fn(async () => ({ success: true })),
  createProject: jest.fn(async (o: any) => ({ id: 'folder-new', ...o })),
  updateProject: jest.fn(async (o: any) => ({ id: o.projectId })),
  deleteProject: jest.fn(async () => ({ success: true })),
  moveFolder: jest.fn(async (o: any) => ({ id: o.folderId })),
  startCodingSession: jest.fn(async () => ({ id: 'session-new', status: 'provisioning' })),
  scheduleChatRun: jest.fn(async () => ({ id: 'sched-new' })),
  listSchedules: jest.fn(async () => []),
  cancelSchedule: jest.fn(async () => true),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

import router from './platform.routes';
import { errorHandler } from '../../../middleware/error-handler';
import { requireScope, hashAgentToken } from '../../../middleware/agent-auth';

// ── HTTP harness ──────────────────────────────────────────────────────────────

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

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.agentToken.update.mockResolvedValue({});
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const USER = { id: 'u-1', email: 'a@b.c', role: 'USER', isChild: false, parentId: null, isActive: true };
const CHILD = { ...USER, id: 'u-child', isChild: true };

function agentTokenRecord(overrides: any = {}) {
  return {
    id: 'tok-1',
    userId: USER.id,
    name: 'ci',
    scopes: ['chats:read'],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    ...overrides,
  };
}

/** Raw token whose sha256 the mocked findUnique will "find". */
const RAW = 'dgt_' + 'ab'.repeat(24);

function mockTokenLookup(record: any | null, raw = RAW) {
  mockPrisma.agentToken.findUnique.mockImplementation(async ({ where }: any) =>
    where.tokenHash === createHash('sha256').update(raw).digest('hex') ? record : null);
}

async function api(path: string, opts: { method?: string; token?: string; body?: any } = {}) {
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

// ── authenticatePlatform: agent token path ────────────────────────────────────

describe('authenticatePlatform (agent tokens)', () => {
  it('authenticates a valid dgt_ token and sets req.user + scopes', async () => {
    mockTokenLookup(agentTokenRecord());
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    const r = await api('/chats', { token: RAW });
    expect(r.status).toBe(200);
    expect(svc.listChats).toHaveBeenCalledWith(expect.objectContaining({ userId: USER.id }));
  });

  it('rejects an unknown token (401)', async () => {
    mockTokenLookup(null);
    const r = await api('/chats', { token: RAW });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/invalid agent token/i);
  });

  it('rejects a revoked token (401)', async () => {
    mockTokenLookup(agentTokenRecord({ revokedAt: new Date() }));
    const r = await api('/chats', { token: RAW });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/revoked/i);
  });

  it('rejects an expired token (401)', async () => {
    mockTokenLookup(agentTokenRecord({ expiresAt: new Date(Date.now() - 1000) }));
    const r = await api('/chats', { token: RAW });
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/expired/i);
  });

  it('rejects a token whose owner is inactive (401)', async () => {
    mockTokenLookup(agentTokenRecord());
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER, isActive: false });
    const r = await api('/chats', { token: RAW });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('Agent token owner not found');
    expect(svc.listChats).not.toHaveBeenCalled();
  });

  it('accepts a token with a future expiry', async () => {
    mockTokenLookup(agentTokenRecord({ expiresAt: new Date(Date.now() + 60_000) }));
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    const r = await api('/chats', { token: RAW });
    expect(r.status).toBe(200);
  });

  it('rejects requests with no Authorization header (401)', async () => {
    const r = await api('/chats');
    expect(r.status).toBe(401);
  });
});

// ── authenticatePlatform: JWT path ────────────────────────────────────────────

describe('authenticatePlatform (user JWT)', () => {
  it('passes a valid JWT with full access (agentScopes null → scopes pass)', async () => {
    mockVerifyAccessToken.mockReturnValue({ userId: USER.id, email: USER.email, role: 'USER' });
    // chats:write route with a JWT — no agent scopes needed
    const r = await api('/chats', { method: 'POST', token: 'a.jwt.token', body: { title: 'hi' } });
    expect(r.status).toBe(201);
    expect(svc.createChat).toHaveBeenCalled();
  });

  it('rejects an invalid JWT (401)', async () => {
    mockVerifyAccessToken.mockImplementation(() => { throw new Error('bad'); });
    const r = await api('/chats', { token: 'not-a-jwt' });
    expect(r.status).toBe(401);
  });
});

// ── requireScope ──────────────────────────────────────────────────────────────

describe('requireScope', () => {
  it('blocks a token missing the required scope (403 insufficient_scope)', async () => {
    mockTokenLookup(agentTokenRecord({ scopes: ['chats:read'] }));
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    const r = await api('/chats', { method: 'POST', token: RAW, body: { title: 'x' } });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'insufficient_scope', required: ['chats:write'] });
    expect(svc.createChat).not.toHaveBeenCalled();
  });

  it('allows a token that carries the required scope', async () => {
    mockTokenLookup(agentTokenRecord({ scopes: ['chats:write'] }));
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    const r = await api('/chats', { method: 'POST', token: RAW, body: { title: 'x' } });
    expect(r.status).toBe(201);
  });

  it('requires every scope when a route needs more than one', async () => {
    mockTokenLookup(agentTokenRecord({ scopes: ['folders:read'] }));
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    const r = await api('/folders/folder-id/workspace', { method: 'POST', token: RAW, body: {} });
    expect(r.status).toBe(403);
    expect(r.body.required).toEqual(['code:run']);
  });

  it('unit: JWT (null scopes) passes, missing scope 403s, present scope passes', () => {
    const mw = requireScope('chats:write');
    const mkRes = () => {
      const res: any = {};
      res.status = jest.fn(() => res);
      res.json = jest.fn(() => res);
      return res;
    };
    const next = jest.fn();

    mw({ user: { id: 'u' }, agentScopes: null } as any, mkRes(), next);
    expect(next).toHaveBeenCalledTimes(1);

    const res2 = mkRes();
    mw({ user: { id: 'u' }, agentScopes: ['chats:read'] } as any, res2, next);
    expect(res2.status).toHaveBeenCalledWith(403);
    expect(res2.json).toHaveBeenCalledWith({ error: 'insufficient_scope', required: ['chats:write'] });

    mw({ user: { id: 'u' }, agentScopes: ['chats:write', 'code:run'] } as any, mkRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

// ── Token management endpoints (JWT only) ─────────────────────────────────────

describe('token management', () => {
  const jwt = 'a.jwt.token';
  beforeEach(() => {
    mockVerifyAccessToken.mockReturnValue({ userId: USER.id, email: USER.email, role: 'USER' });
  });

  it('refuses agent-token auth on all /tokens routes', async () => {
    mockTokenLookup(agentTokenRecord({ scopes: ['chats:read', 'chats:write', 'code:run'] }));
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    for (const [method, path, body] of [
      ['GET', '/tokens', undefined],
      ['POST', '/tokens', { name: 'x', scopes: ['chats:read'] }],
      ['DELETE', '/tokens/11111111-1111-1111-1111-111111111111', undefined],
    ] as const) {
      const r = await api(path, { method, token: RAW, body });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/this route requires your account session/i);
    }
    expect(mockPrisma.agentToken.create).not.toHaveBeenCalled();
  });

  it('lists tokens without ever exposing the hash', async () => {
    mockPrisma.agentToken.findMany.mockResolvedValue([
      { id: 't1', name: 'ci', tokenPrefix: 'dgt_ab12cd34', scopes: ['chats:read'], lastUsedAt: null, expiresAt: null, revokedAt: null, createdAt: new Date() },
    ]);
    const r = await api('/tokens', { token: jwt });
    expect(r.status).toBe(200);
    expect(r.body.tokens).toHaveLength(1);
    expect(JSON.stringify(r.body)).not.toContain('tokenHash');
  });

  it('mints a dgt_ token, stores ONLY the sha256 hash + 12-char prefix, returns raw once', async () => {
    mockPrisma.agentToken.create.mockImplementation(async ({ data }: any) => ({
      id: 't-new', name: data.name, tokenPrefix: data.tokenPrefix, scopes: data.scopes,
      expiresAt: data.expiresAt, createdAt: new Date(),
    }));
    const r = await api('/tokens', {
      method: 'POST', token: jwt,
      body: { name: 'ci bot', scopes: ['chats:read', 'code:run'] },
    });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^dgt_[0-9a-f]{48}$/);

    const stored = mockPrisma.agentToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(createHash('sha256').update(r.body.token).digest('hex'));
    expect(stored.tokenHash).not.toBe(r.body.token);
    expect(stored.tokenPrefix).toBe(r.body.token.slice(0, 12));
    expect(stored.tokenPrefix).toHaveLength(12);
    expect(stored.scopes).toEqual(['chats:read', 'code:run']);
    // The select must never include tokenHash
    expect(mockPrisma.agentToken.create.mock.calls[0][0].select.tokenHash).toBeUndefined();
  });

  it('rejects a mint with an unknown scope (400)', async () => {
    const r = await api('/tokens', { method: 'POST', token: jwt, body: { name: 'x', scopes: ['admin:all'] } });
    expect(r.status).toBe(400);
  });

  it('rejects a mint with a past expiry (400)', async () => {
    const r = await api('/tokens', {
      method: 'POST', token: jwt,
      body: { name: 'x', scopes: ['chats:read'], expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    expect(r.status).toBe(400);
  });

  it('revokes by setting revokedAt (owner-scoped)', async () => {
    mockPrisma.agentToken.findFirst.mockResolvedValue({ id: 't1', userId: USER.id, revokedAt: null });
    const id = '11111111-1111-1111-1111-111111111111';
    const r = await api(`/tokens/${id}`, { method: 'DELETE', token: jwt });
    expect(r.status).toBe(200);
    expect(mockPrisma.agentToken.findFirst).toHaveBeenCalledWith({ where: { id, userId: USER.id } });
    expect(mockPrisma.agentToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ revokedAt: expect.any(Date) }) }),
    );
  });

  it('404s revoking another user\'s token', async () => {
    mockPrisma.agentToken.findFirst.mockResolvedValue(null);
    const r = await api('/tokens/11111111-1111-1111-1111-111111111111', { method: 'DELETE', token: jwt });
    expect(r.status).toBe(404);
  });

  it('rejects child accounts from minting', async () => {
    mockVerifyAccessToken.mockReturnValue({ userId: CHILD.id, email: CHILD.email, role: 'USER', isChild: true, parentId: USER.id });
    const r = await api('/tokens', { method: 'POST', token: jwt, body: { name: 'x', scopes: ['chats:read'] } });
    expect(r.status).toBe(403);
    expect(mockPrisma.agentToken.create).not.toHaveBeenCalled();
  });
});

// ── Child accounts + code:run ─────────────────────────────────────────────────

describe('child accounts', () => {
  it('rejects a child JWT from code:run routes', async () => {
    mockVerifyAccessToken.mockReturnValue({ userId: CHILD.id, email: CHILD.email, role: 'USER', isChild: true, parentId: USER.id });
    const chatId = '11111111-1111-1111-1111-111111111111';
    for (const path of [`/chats/${chatId}/code`, `/folders/${chatId}/workspace`]) {
      const r = await api(path, { method: 'POST', token: 'a.jwt.token', body: {} });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('CHILD_ACCOUNT_FORBIDDEN');
    }
    expect(svc.startCodingSession).not.toHaveBeenCalled();
  });

  it('rejects a child-owned agent token from code:run routes', async () => {
    mockTokenLookup(agentTokenRecord({ userId: CHILD.id, scopes: ['code:run'] }));
    mockPrisma.user.findUnique.mockResolvedValue(CHILD);
    const r = await api('/folders/11111111-1111-1111-1111-111111111111/workspace', { method: 'POST', token: RAW, body: {} });
    expect(r.status).toBe(403);
    expect(svc.startCodingSession).not.toHaveBeenCalled();
  });
});

// ── lastUsedAt throttling ─────────────────────────────────────────────────────

describe('lastUsedAt throttling', () => {
  it('writes lastUsedAt when never used before (fire-and-forget)', async () => {
    mockTokenLookup(agentTokenRecord({ lastUsedAt: null }));
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    await api('/chats', { token: RAW });
    expect(mockPrisma.agentToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tok-1' }, data: { lastUsedAt: expect.any(Date) } }),
    );
  });

  it('writes lastUsedAt when the last write is older than 60s', async () => {
    mockTokenLookup(agentTokenRecord({ lastUsedAt: new Date(Date.now() - 61_000) }));
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    await api('/chats', { token: RAW });
    expect(mockPrisma.agentToken.update).toHaveBeenCalled();
  });

  it('skips the write when used within the last 60s', async () => {
    mockTokenLookup(agentTokenRecord({ lastUsedAt: new Date(Date.now() - 30_000) }));
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    await api('/chats', { token: RAW });
    expect(mockPrisma.agentToken.update).not.toHaveBeenCalled();
  });
});

// ── hashAgentToken ────────────────────────────────────────────────────────────

describe('hashAgentToken', () => {
  it('is sha256 hex of the raw token', () => {
    expect(hashAgentToken(RAW)).toBe(createHash('sha256').update(RAW).digest('hex'));
    expect(hashAgentToken(RAW)).toHaveLength(64);
  });
});
