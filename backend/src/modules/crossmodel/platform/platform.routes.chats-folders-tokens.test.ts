/**
 * Route coverage for the P0 platform surfaces: chat list (mode=auto, limit
 * cap), agent vs user sends, folder archived query, and autonomy GET.
 * Token mint / revoke stays in platform-auth.test.ts.
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

jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

const mockVerifyAccessToken = jest.fn();
jest.mock('../../../utils/jwt', () => ({
  __esModule: true,
  verifyAccessToken: (...a: any[]) => mockVerifyAccessToken(...a),
}));

const svc = {
  listChats: jest.fn(async () => ({ chats: [], pagination: { page: 1, limit: 50, total: 0, pages: 0 } })),
  createChat: jest.fn(async (o: any) => ({ id: 'chat-new', ...o })),
  getChatStatus: jest.fn(async () => ({ id: 'chat-1', running: false })),
  sendChatMessage: jest.fn(async (o: any) => ({ queued: true, delivery: 'queue' })),
  getFolderTree: jest.fn(async () => ({ folders: [] })),
  renameChat: jest.fn(async (o: any) => ({ id: o.chatId })),
  archiveChat: jest.fn(async (o: any) => ({ id: o.chatId, archived: o.archived })),
  moveChat: jest.fn(async (o: any) => ({ id: o.chatId })),
  deleteChat: jest.fn(async () => ({ success: true })),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const autonomySvc = {
  getChatAutonomy: jest.fn(),
  setChatAutonomy: jest.fn(),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

const crossModelSvc = { getChatAccess: jest.fn() };
jest.mock('../crossmodel.service', () => ({ __esModule: true, default: crossModelSvc }));

jest.mock('./goals.service', () => ({
  __esModule: true,
  listGoals: jest.fn(),
  createGoal: jest.fn(),
  updateGoal: jest.fn(),
}));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  listHooks: jest.fn(),
  subscribeHook: jest.fn(),
  unsubscribeHook: jest.fn(),
}));
jest.mock('./supervisor.service', () => ({
  __esModule: true,
  ensureFleetSupervisor: jest.fn(),
}));

import router from './platform.routes';
import { errorHandler } from '../../../middleware/error-handler';

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

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.agentToken.update.mockResolvedValue({});
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockPrisma.user.findUnique.mockResolvedValue(USER);
  mockVerifyAccessToken.mockReturnValue({ userId: USER.id, email: USER.email, role: 'USER' });
});

const USER = { id: 'u-1', email: 'a@b.c', role: 'USER', isChild: false, parentId: null, isActive: true };
const CID = '44444444-4444-4444-4444-444444444444';
const RAW = 'dgt_' + 'ab'.repeat(24);
const JWT = 'eyJhbGciOiJIUzI1NiJ9.e30.sig';

function agentTokenRecord(overrides: any = {}) {
  return {
    id: 'tok-1', userId: USER.id, name: 'ci', scopes: ['chats:read'],
    expiresAt: null, revokedAt: null, lastUsedAt: null, ...overrides,
  };
}

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

describe('platform routes — chats, folders, autonomy', () => {
  it('accepts mode=auto on GET /chats and keeps the default page size', async () => {
    const r = await api('/chats?mode=auto', { token: JWT });
    expect(r.status).toBe(200);
    expect(svc.listChats).toHaveBeenCalledWith({
      userId: 'u-1', page: 1, limit: 50, mode: 'auto',
    });
  });

  it('caps GET /chats limit at 200', async () => {
    const r = await api('/chats?limit=9999', { token: JWT });
    expect(r.status).toBe(200);
    expect(svc.listChats).toHaveBeenCalledWith({
      userId: 'u-1', page: 1, limit: 200,
    });
  });

  it('records a dgt_ send as agent origin and queues it by default', async () => {
    mockTokenLookup(agentTokenRecord({ scopes: ['chats:write'] }));
    const r = await api(`/chats/${CID}/messages`, {
      method: 'POST', token: RAW, body: { content: 'hello from the agent' },
    });
    expect(r.status).toBe(202);
    const arg = svc.sendChatMessage.mock.calls[0][0];
    expect(arg).toMatchObject({
      userId: 'u-1',
      chatId: CID,
      content: 'hello from the agent',
      origin: { kind: 'agent' },
      delivery: 'queue',
    });
    expect(arg.userTurnAt).toBeUndefined();
    expect(arg.ownerTurn).toBeUndefined();
  });

  it('passes an explicit agent delivery of steer or interrupt without a user turn', async () => {
    mockTokenLookup(agentTokenRecord({ scopes: ['chats:write'] }));
    for (const delivery of ['steer', 'interrupt'] as const) {
      svc.sendChatMessage.mockClear();
      const r = await api(`/chats/${CID}/messages`, {
        method: 'POST', token: RAW, body: { content: 'later', delivery },
      });
      expect(r.status).toBe(202);
      const arg = svc.sendChatMessage.mock.calls[0][0];
      expect(arg.origin).toEqual({ kind: 'agent' });
      expect(arg.delivery).toBe(delivery);
      expect(arg.userTurnAt).toBeUndefined();
    }
  });

  it('refuses as:user from a dgt_ token (403) and does not send', async () => {
    mockTokenLookup(agentTokenRecord({ scopes: ['chats:write'] }));
    const r = await api(`/chats/${CID}/messages`, {
      method: 'POST', token: RAW, body: { content: 'pretend', as: 'user' },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Agent tokens cannot send as a user');
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
  });

  it('keeps a JWT send as a user turn and omits delivery when the client omits it', async () => {
    const r = await api(`/chats/${CID}/messages`, {
      method: 'POST', token: JWT, body: { content: 'from me' },
    });
    expect(r.status).toBe(202);
    const arg = svc.sendChatMessage.mock.calls[0][0];
    expect(arg.origin).toEqual({ kind: 'user' });
    expect(arg.userTurnAt).toEqual(expect.any(Date));
    expect(arg).not.toHaveProperty('delivery');
  });

  it('forwards an explicit JWT delivery', async () => {
    const r = await api(`/chats/${CID}/messages`, {
      method: 'POST', token: JWT, body: { content: 'queue this', delivery: 'queue' },
    });
    expect(r.status).toBe(202);
    const arg = svc.sendChatMessage.mock.calls[0][0];
    expect(arg.origin).toEqual({ kind: 'user' });
    expect(arg.delivery).toBe('queue');
    expect(arg.userTurnAt).toEqual(expect.any(Date));
  });

  it('passes archived=true through to the folder tree', async () => {
    mockTokenLookup(agentTokenRecord({ scopes: ['folders:read'] }));
    const r = await api('/folders?archived=true', { token: RAW });
    expect(r.status).toBe(200);
    expect(svc.getFolderTree).toHaveBeenCalledWith({ userId: 'u-1', archived: true });
  });

  it('passes archived=false when the folders query omits it', async () => {
    const r = await api('/folders', { token: JWT });
    expect(r.status).toBe(200);
    expect(svc.getFolderTree).toHaveBeenCalledWith({ userId: 'u-1', archived: false });
  });

  it('returns the autonomy grant for a chat the caller can read', async () => {
    mockTokenLookup(agentTokenRecord({ scopes: ['chats:read'] }));
    crossModelSvc.getChatAccess.mockResolvedValue({ exists: true, access: 'owner' });
    autonomySvc.getChatAutonomy.mockResolvedValue({ tools: ['send_chat_message'], scheduleCap: 10 });
    const r = await api(`/chats/${CID}/autonomy`, { token: RAW });
    expect(r.status).toBe(200);
    expect(crossModelSvc.getChatAccess).toHaveBeenCalledWith(CID, 'u-1');
    expect(autonomySvc.getChatAutonomy).toHaveBeenCalledWith(CID);
    expect(r.body).toEqual({ chatId: CID, tools: ['send_chat_message'], scheduleCap: 10 });
  });
});
