/**
 * Password-change cutoff (2026-10-12): access tokens issued before a user's
 * last password change are refused by every JWT seam — authenticate,
 * optionalAuthenticate (continues anonymous) and authenticatePlatform — and
 * the check FAILS OPEN on any Redis trouble (it must never log everyone out).
 */

import { NextFunction } from 'express';

jest.mock('../../utils/jwt', () => ({
  __esModule: true,
  verifyAccessToken: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../middleware/auth-signal', () => ({
  __esModule: true,
  recordInvalidTokenSignal: jest.fn(),
  isDeadTokenShape: jest.fn(() => false),
  INVALID_TOKEN_SPIKE_THRESHOLD: 30,
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));

import {
  configurePasswordChangeCutoffStore,
  recordPasswordChangeCutoff,
  readPasswordChangeCutoff,
  isRevokedByPasswordChange,
  cutoffKey,
  CUTOFF_CACHE_TTL_MS,
  __resetPasswordChangeCutoffForTest,
} from './password-change-cutoff';
import { authenticate, optionalAuthenticate, AuthRequest } from '../../middleware/auth';
import { authenticatePlatform } from '../../middleware/agent-auth';
import { verifyAccessToken } from '../../utils/jwt';

const mockedVerify = verifyAccessToken as jest.Mock;

function fakeStore() {
  const data = new Map<string, string>();
  return {
    data,
    isReady: true,
    get: jest.fn(async (k: string) => data.get(k) ?? null),
    set: jest.fn(async (k: string, v: string, _opts: { EX: number }) => { data.set(k, v); return 'OK'; }),
  };
}

function mockRes() {
  const res: any = { statusCode: 200, body: undefined };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.json = jest.fn((b: unknown) => { res.body = b; return res; });
  res.getHeader = jest.fn(() => undefined);
  res.setHeader = jest.fn();
  res.removeHeader = jest.fn();
  res.cookie = jest.fn();
  res.clearCookie = jest.fn();
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetPasswordChangeCutoffForTest();
});

describe('password-change cutoff leaf', () => {
  it('is a no-op until a store is configured (env-less tests, worker)', async () => {
    expect(await isRevokedByPasswordChange({ userId: 'u1', iat: 1 })).toBe(false);
    expect(await recordPasswordChangeCutoff('u1', 100)).toBe(false);
  });

  it('revokes tokens issued strictly before the cutoff; same-second and later pass', async () => {
    const store = fakeStore();
    configurePasswordChangeCutoffStore(store);
    expect(await recordPasswordChangeCutoff('u1', 1000)).toBe(true);
    expect(store.data.get(cutoffKey('u1'))).toBe('1000');

    expect(await isRevokedByPasswordChange({ userId: 'u1', iat: 999 })).toBe(true);
    expect(await isRevokedByPasswordChange({ userId: 'u1', iat: 1000 })).toBe(false);
    expect(await isRevokedByPasswordChange({ userId: 'u1', iat: 1001 })).toBe(false);
    // No iat at all counts as issued at 0.
    expect(await isRevokedByPasswordChange({ userId: 'u1' })).toBe(true);
    // Another user is untouched.
    expect(await isRevokedByPasswordChange({ userId: 'u2', iat: 5 })).toBe(false);
  });

  it('reads a cutoff written by ANOTHER process and caches it (≤ 1 GET per user per window)', async () => {
    const store = fakeStore();
    store.data.set(cutoffKey('u1'), '500');
    configurePasswordChangeCutoffStore(store);

    expect(await readPasswordChangeCutoff('u1')).toBe(500);
    expect(await readPasswordChangeCutoff('u1')).toBe(500);
    expect(store.get).toHaveBeenCalledTimes(1);

    const realNow = Date.now;
    try {
      Date.now = () => realNow() + CUTOFF_CACHE_TTL_MS + 1;
      store.data.set(cutoffKey('u1'), '700');
      expect(await readPasswordChangeCutoff('u1')).toBe(700);
      expect(store.get).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });

  it('fails OPEN when Redis is not ready, errors or hangs', async () => {
    configurePasswordChangeCutoffStore({ ...fakeStore(), isReady: false });
    expect(await isRevokedByPasswordChange({ userId: 'u1', iat: 1 })).toBe(false);

    __resetPasswordChangeCutoffForTest();
    configurePasswordChangeCutoffStore({
      isReady: true,
      get: jest.fn(async () => { throw new Error('ECONNRESET'); }),
      set: jest.fn(async () => { throw new Error('ECONNRESET'); }),
    });
    expect(await isRevokedByPasswordChange({ userId: 'u1', iat: 1 })).toBe(false);

    __resetPasswordChangeCutoffForTest();
    configurePasswordChangeCutoffStore({
      isReady: true,
      get: jest.fn(() => new Promise<string | null>(() => undefined)), // never settles
      set: jest.fn(async () => 'OK'),
    });
    const t0 = Date.now();
    expect(await isRevokedByPasswordChange({ userId: 'u1', iat: 1 })).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('auth middlewares honour the cutoff', () => {
  const NOW = Math.floor(Date.now() / 1000);

  beforeEach(() => {
    configurePasswordChangeCutoffStore(fakeStore());
    mockedVerify.mockImplementation((token: string) => ({
      userId: 'u1',
      email: 'a@b.c',
      role: 'USER',
      iat: token.startsWith('old') ? NOW - 60 : NOW + 5,
    }));
  });

  it('authenticate: 401 PASSWORD_CHANGED for a pre-change token, next() for a post-change one', async () => {
    await recordPasswordChangeCutoff('u1', NOW);

    const req = { headers: { authorization: 'Bearer old-tok' } } as unknown as AuthRequest;
    const res = mockRes();
    const next = jest.fn() as NextFunction;
    await authenticate(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'PASSWORD_CHANGED' });
    expect(res.cookie).not.toHaveBeenCalled(); // no sliding re-issue of a dead token

    const req2 = { headers: { authorization: 'Bearer new-tok' } } as unknown as AuthRequest;
    const res2 = mockRes();
    const next2 = jest.fn() as NextFunction;
    await authenticate(req2, res2, next2);
    expect(next2).toHaveBeenCalled();
    expect(req2.user?.userId).toBe('u1');
  });

  it('authenticate: a cookie-only pre-change token also clears the cm_access cookie', async () => {
    await recordPasswordChangeCutoff('u1', NOW);
    const req = { headers: {}, cookies: { cm_access: 'old-cookie' } } as unknown as AuthRequest;
    const res = mockRes();
    await authenticate(req, res, jest.fn() as NextFunction);
    expect(res.statusCode).toBe(401);
    expect(res.clearCookie).toHaveBeenCalledWith('cm_access', expect.any(Object));
  });

  it('optionalAuthenticate: a pre-change token continues ANONYMOUS', async () => {
    await recordPasswordChangeCutoff('u1', NOW);
    const req = { headers: { authorization: 'Bearer old-tok' }, query: {} } as unknown as AuthRequest;
    const next = jest.fn() as NextFunction;
    await optionalAuthenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('authenticatePlatform (JWT path): 401 PASSWORD_CHANGED for a pre-change token', async () => {
    await recordPasswordChangeCutoff('u1', NOW);
    const req = { headers: { authorization: 'Bearer old-tok' } } as any;
    const res = mockRes();
    const next = jest.fn() as NextFunction;
    await authenticatePlatform(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ code: 'PASSWORD_CHANGED' });
  });

  it('no cutoff recorded ⇒ every valid token passes (users who never changed their password)', async () => {
    const req = { headers: { authorization: 'Bearer old-tok' } } as unknown as AuthRequest;
    const next = jest.fn() as NextFunction;
    await authenticate(req, mockRes(), next);
    expect(next).toHaveBeenCalled();
  });
});
