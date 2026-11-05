/**
 * xero-oauth.controller — multi-account labels (ticket 64a25e8d) + the
 * navigation-target auth-failure contract (ticket 8cb3aa34 class).
 *
 * Pins:
 *  1. startAuth: unauthenticated → redirect to the integrations UI with
 *     xero=auth_required (never a bare 401 JSON white page); the user-chosen
 *     ?label= rides the Redis state payload (capped at 40 chars).
 *  2. handleCallback: the state label wins the upsert key (userId_label) —
 *     a new label INSERTS an account, an existing label OVERWRITES tokens;
 *     legacy states without a label keep the orgName-derived labelling.
 *  3. GET /accounts lists all accounts first-connected first.
 *  4. PATCH /accounts/:id/label — 400 invalid · 404 not yours · 409 taken ·
 *     no-op rename short-circuits · success updates.
 *  5. DELETE /disconnect — ?label= deletes only that account (404 unknown);
 *     absent deletes ALL (backward compat).
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    xeroOAuthToken: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { setEx: jest.fn().mockResolvedValue('OK'), get: jest.fn(), del: jest.fn() },
}));
jest.mock('axios');
jest.mock('../google/crypto', () => ({ encrypt: jest.fn((s: string) => `enc:${s}`), decrypt: jest.fn((s: string) => s.replace(/^enc:/, '')) }));
jest.mock('../langgraph/integration-status-cache', () => ({ invalidateIntegrationStatusCache: jest.fn() }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import axios from 'axios';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import controller from './xero-oauth.controller';

const db = (prisma as any).xeroOAuthToken;
const redis = redisClient as any;

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  return res;
}

const ENV = {
  XERO_CLIENT_ID: 'xero-cid',
  XERO_CLIENT_SECRET: 'xero-secret',
  XERO_OAUTH_REDIRECT_URI: 'https://digby.ai/api/crossmodel/xero/callback',
  FRONTEND_URL: 'https://digby.ai',
};

const ACCOUNT_ROW = {
  id: 'row1', userId: 'u1', label: 'Default', orgName: 'Acme Ltd', tenantId: 't1',
  scopes: ['openid'], expiresAt: new Date('2030-01-01'), createdAt: new Date('2026-01-01'),
};

describe('XeroOAuthController multi-account (ticket 64a25e8d)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, ENV);
    jest.clearAllMocks();
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  // ── startAuth ──────────────────────────────────────────────────────────────

  it('startAuth: unauthenticated → redirect to the UI with xero=auth_required (never bare 401 JSON)', async () => {
    const res = mockRes();
    await controller.startAuth({ user: undefined, query: {} } as any, res, jest.fn());
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'https://digby.ai/account?tab=integrations&xero=auth_required',
    );
  });

  it('startAuth: the ?label= rides the Redis state payload; default label is "Default"', async () => {
    const res = mockRes();
    await controller.startAuth({ user: { id: 'u1' }, query: { label: 'Work' } } as any, res, jest.fn());
    const [key, ttl, payload] = (redis.setEx as jest.Mock).mock.calls[0];
    expect(key).toMatch(/^xero_oauth_state:/);
    expect(ttl).toBe(300);
    expect(JSON.parse(payload)).toMatchObject({ userId: 'u1', label: 'Work' });
    const authUrl = (res.redirect as jest.Mock).mock.calls[0][0] as string;
    expect(authUrl).toMatch(/^https:\/\/login\.xero\.com\/identity\/connect\/authorize\?/);

    (redis.setEx as jest.Mock).mockClear();
    const res2 = mockRes();
    await controller.startAuth({ user: { id: 'u1' }, query: {} } as any, res2, jest.fn());
    expect(JSON.parse((redis.setEx as jest.Mock).mock.calls[0][2])).toMatchObject({ label: 'Default' });
  });

  it('startAuth: caps the label at 40 chars', async () => {
    const res = mockRes();
    await controller.startAuth({ user: { id: 'u1' }, query: { label: 'x'.repeat(60) } } as any, res, jest.fn());
    const payload = JSON.parse((redis.setEx as jest.Mock).mock.calls[0][2]);
    expect(payload.label).toHaveLength(40);
  });

  // ── handleCallback ─────────────────────────────────────────────────────────

  function mockTokenAndConnections(orgName = 'Acme Ltd') {
    (axios.post as jest.Mock).mockResolvedValue({
      data: { access_token: 'at', refresh_token: 'rt', expires_in: 1800, scope: 'openid profile' },
    });
    (axios.get as jest.Mock).mockResolvedValue({
      data: [{ tenantId: 't1', tenantName: orgName }],
    });
  }

  it('handleCallback: the state label wins the upsert key — a new label inserts a NEW account', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ userId: 'u1', codeVerifier: 'cv', label: 'Work' }));
    mockTokenAndConnections();
    db.upsert.mockResolvedValue({});
    const res = mockRes();
    await controller.handleCallback({ query: { code: 'c', state: 's' }, originalUrl: '/cb' } as any, res, jest.fn());
    expect(db.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_label: { userId: 'u1', label: 'Work' } },
      create: expect.objectContaining({ label: 'Work', orgName: 'Acme Ltd', tenantId: 't1' }),
    }));
    expect(res.redirect).toHaveBeenCalledWith('https://digby.ai/account?tab=integrations&xero=connected');
  });

  it('handleCallback: legacy state without a label keeps orgName-derived labelling', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ userId: 'u1', codeVerifier: 'cv', label: null }));
    mockTokenAndConnections('Acme Ltd');
    db.upsert.mockResolvedValue({});
    const res = mockRes();
    await controller.handleCallback({ query: { code: 'c', state: 's' }, originalUrl: '/cb' } as any, res, jest.fn());
    expect(db.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_label: { userId: 'u1', label: 'Acme Ltd' } },
    }));
  });

  // ── listAccounts ───────────────────────────────────────────────────────────

  it('listAccounts returns all accounts first-connected first', async () => {
    db.findMany.mockResolvedValue([ACCOUNT_ROW, { ...ACCOUNT_ROW, id: 'row2', label: 'Work' }]);
    const res = mockRes();
    await controller.listAccounts({ user: { id: 'u1' } } as any, res, jest.fn());
    expect(db.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    }));
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ id: 'row1', label: 'Default', orgName: 'Acme Ltd' });
    expect(body.data[0].connectedAt).toEqual(ACCOUNT_ROW.createdAt);
  });

  // ── updateAccountLabel ─────────────────────────────────────────────────────

  it('updateAccountLabel: 400 on empty or >40-char labels', async () => {
    const res = mockRes();
    await controller.updateAccountLabel({ user: { id: 'u1' }, params: { id: 'row1' }, body: { label: '  ' } } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    const res2 = mockRes();
    await controller.updateAccountLabel({ user: { id: 'u1' }, params: { id: 'row1' }, body: { label: 'x'.repeat(41) } } as any, res2, jest.fn());
    expect(res2.status).toHaveBeenCalledWith(400);
  });

  it('updateAccountLabel: 404 when the id is not one of the user\'s accounts', async () => {
    db.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await controller.updateAccountLabel({ user: { id: 'u1' }, params: { id: 'nope' }, body: { label: 'Work' } } as any, res, jest.fn());
    expect(db.findFirst).toHaveBeenCalledWith({ where: { id: 'nope', userId: 'u1' } });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('updateAccountLabel: 409 when another account already uses the label', async () => {
    db.findFirst
      .mockResolvedValueOnce(ACCOUNT_ROW)                              // ownership
      .mockResolvedValueOnce({ ...ACCOUNT_ROW, id: 'row2', label: 'Work' }); // conflict
    const res = mockRes();
    await controller.updateAccountLabel({ user: { id: 'u1' }, params: { id: 'row1' }, body: { label: 'Work' } } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('updateAccountLabel: no-op rename short-circuits; success updates and returns the account', async () => {
    db.findFirst.mockResolvedValue(ACCOUNT_ROW);
    const res = mockRes();
    await controller.updateAccountLabel({ user: { id: 'u1' }, params: { id: 'row1' }, body: { label: 'Default' } } as any, res, jest.fn());
    expect(db.update).not.toHaveBeenCalled();
    expect((res.json as jest.Mock).mock.calls[0][0].data.label).toBe('Default');

    jest.clearAllMocks();
    db.findFirst
      .mockResolvedValueOnce(ACCOUNT_ROW)  // ownership
      .mockResolvedValueOnce(null);        // no conflict
    db.update.mockResolvedValue({ ...ACCOUNT_ROW, label: 'Work' });
    const res2 = mockRes();
    await controller.updateAccountLabel({ user: { id: 'u1' }, params: { id: 'row1' }, body: { label: 'Work' } } as any, res2, jest.fn());
    expect(db.update).toHaveBeenCalledWith({ where: { id: 'row1' }, data: { label: 'Work' } });
    expect((res2.json as jest.Mock).mock.calls[0][0].data.label).toBe('Work');
  });

  // ── disconnect ─────────────────────────────────────────────────────────────

  it('disconnect ?label= deletes only that account; unknown label → 404', async () => {
    db.findUnique.mockResolvedValue(ACCOUNT_ROW);
    const res = mockRes();
    await controller.disconnect({ user: { id: 'u1' }, query: { label: 'Default' } } as any, res, jest.fn());
    expect(db.findUnique).toHaveBeenCalledWith({ where: { userId_label: { userId: 'u1', label: 'Default' } } });
    expect(db.delete).toHaveBeenCalledWith({ where: { id: 'row1' } });
    expect(db.deleteMany).not.toHaveBeenCalled();

    jest.clearAllMocks();
    db.findUnique.mockResolvedValue(null);
    const res2 = mockRes();
    await controller.disconnect({ user: { id: 'u1' }, query: { label: 'Nope' } } as any, res2, jest.fn());
    expect(res2.status).toHaveBeenCalledWith(404);
    expect(db.deleteMany).not.toHaveBeenCalled();
  });

  it('disconnect without a label deletes ALL accounts (backward compat)', async () => {
    db.findMany.mockResolvedValue([ACCOUNT_ROW]);
    const res = mockRes();
    await controller.disconnect({ user: { id: 'u1' }, query: {} } as any, res, jest.fn());
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Xero disconnected' });
  });
});
