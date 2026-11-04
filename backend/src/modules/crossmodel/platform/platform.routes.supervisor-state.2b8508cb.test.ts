/**
 * Ticket 2b8508cb — GET /platform/chats/:id/supervisor-state.
 *
 * Pins over real HTTP (the platform.routes.fleet.test.ts harness):
 *  - auth: 401 without a token; 403 for an agent token lacking chats:read.
 *  - supervisor-class + ownership gate: 404 for a plain chat, 404 for
 *    another user's chat, 200 for the owner of a supervisor chat (both
 *    fleet + project supervisor shapes).
 *  - arg mapping into readSupervisorStateSection (section/query/limit).
 *  - the `query` arm adds memHits from the embedded supervisor_state rows.
 *
 * supervisor-state.service + supervisor-state-memory are mocked at the
 * module boundary (the route reaches them via dynamic import, which
 * jest.mock intercepts); their own suites pin the internals.
 */

import express from 'express';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentToken: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
  user: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
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

const mockReadSection = jest.fn();
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  readSupervisorStateSection: (...a: any[]) => mockReadSection(...a),
}));

const mockSearchMem = jest.fn();
jest.mock('./supervisor-state-memory', () => ({
  __esModule: true,
  searchSupervisorStateMem: (...a: any[]) => mockSearchMem(...a),
}));

import router from './platform.routes';
import { AppError, errorHandler } from '../../../middleware/error-handler';

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
const SUP_CHAT = '44444444-4444-4444-4444-444444444444';
const PROJ_SUP_CHAT = '55555555-5555-5555-5555-555555555555';
const PLAIN_CHAT = '66666666-6666-6666-6666-666666666666';

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyAccessToken.mockReturnValue({ userId: USER.id, email: USER.email, role: 'USER' });
  mockPrisma.agentToken.update.mockResolvedValue({});
  mockReadSection.mockResolvedValue({ section: 'all', counts: { directives: 2, open: 1, archived: 0, dispatches: 3, projects: 1, refutations: 0 } });
});

async function api(path: string, opts: { method?: string; token?: string | null } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

const supRow = (over: Record<string, unknown> = {}) => ({
  userId: USER.id, isSupervisor: true, isProjectSupervisor: false, ...over,
});

describe('GET /chats/:id/supervisor-state (ticket 2b8508cb)', () => {
  it('rejects unauthenticated requests (401) without reading the doc', async () => {
    const r = await api(`/chats/${SUP_CHAT}/supervisor-state`);
    expect(r.status).toBe(401);
    expect(mockReadSection).not.toHaveBeenCalled();
  });

  it('enforces chats:read (agent token with a different scope is 403)', async () => {
    const raw = 'dgt_' + 'ab'.repeat(24);
    const { createHash } = await import('crypto');
    mockPrisma.agentToken.findUnique.mockImplementation(async ({ where }: any) =>
      where.tokenHash === createHash('sha256').update(raw).digest('hex')
        ? { id: 'tok-1', userId: USER.id, scopes: ['folders:read'], expiresAt: null, revokedAt: null, lastUsedAt: new Date() }
        : null);
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER, isActive: true, isChild: false, parentId: null });
    const r = await api(`/chats/${SUP_CHAT}/supervisor-state`, { token: raw });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'insufficient_scope', required: ['chats:read'] });
    expect(mockReadSection).not.toHaveBeenCalled();
  });

  it('404 for a chat that does not exist, a PLAIN chat, or another user\'s chat', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    expect((await api(`/chats/${SUP_CHAT}/supervisor-state`, { token: JWT })).status).toBe(404);

    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supRow({ isSupervisor: false, isProjectSupervisor: false }));
    expect((await api(`/chats/${PLAIN_CHAT}/supervisor-state`, { token: JWT })).status).toBe(404);

    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supRow({ userId: 'someone-else' }));
    expect((await api(`/chats/${SUP_CHAT}/supervisor-state`, { token: JWT })).status).toBe(404);
    expect(mockReadSection).not.toHaveBeenCalled();
  });

  it('200 for the owner on BOTH supervisor shapes, args mapped into readSupervisorStateSection', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supRow());
    const r = await api(`/chats/${SUP_CHAT}/supervisor-state?section=dispatches&limit=10`, { token: JWT });
    expect(r.status).toBe(200);
    expect(mockReadSection).toHaveBeenCalledWith(SUP_CHAT, { section: 'dispatches', query: undefined, limit: 10 });
    expect(r.body.section).toBe('all');

    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supRow({ isSupervisor: false, isProjectSupervisor: true }));
    const r2 = await api(`/chats/${PROJ_SUP_CHAT}/supervisor-state?section=directives`, { token: JWT });
    expect(r2.status).toBe(200);
    expect(mockReadSection).toHaveBeenCalledWith(PROJ_SUP_CHAT, { section: 'directives', query: undefined, limit: undefined });
  });

  it('a ?query= read ALSO returns memHits from the embedded supervisor_state rows', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supRow());
    mockSearchMem.mockResolvedValueOnce([
      { ref: 'directive dir-9', title: 'Directive [dir-9] (open)', content: 'Directive dir-9 …: watch the backup budget', createdAt: '2026-10-18T00:00:00Z' },
    ]);
    const r = await api(`/chats/${SUP_CHAT}/supervisor-state?query=backup%20budget`, { token: JWT });
    expect(r.status).toBe(200);
    expect(mockSearchMem).toHaveBeenCalledWith(SUP_CHAT, 'backup budget', 20);
    expect(r.body.memHits[0].ref).toBe('directive dir-9');
  });

  it('a ?query= read without memHits omits the key (never a failed request)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supRow());
    mockSearchMem.mockResolvedValueOnce([]);
    const r = await api(`/chats/${SUP_CHAT}/supervisor-state?query=nothing`, { token: JWT });
    expect(r.status).toBe(200);
    expect(r.body.memHits).toBeUndefined();
  });

  it('an invalid section is a 400 (zod enum)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(supRow());
    const r = await api(`/chats/${SUP_CHAT}/supervisor-state?section=bogus`, { token: JWT });
    expect(r.status).toBe(400);
    expect(mockReadSection).not.toHaveBeenCalled();
  });
});
