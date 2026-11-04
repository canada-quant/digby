/**
 * Change-password tests (2026-10-12 — the 2026-10-11 security incident: a
 * signed-in user had no way to change their password).
 *
 * Mirrors auth.account.test.ts:
 *  1. SERVICE: re-auth with the current password, the register hash, one
 *     transaction that writes the hash + deletes EVERY refresh token of the
 *     user + stores the caller's fresh one, the access-token cutoff, the
 *     child / no-password / wrong-password refusals, no secret in any log.
 *  2. HTTP: inline authenticate (anon 401), zod (weak / same-as-current 400),
 *     success sets both cookies + returns the new access token like login,
 *     and an access token minted BEFORE the change is refused afterwards
 *     while the caller's new one keeps working (other sessions revoked).
 *
 * Hermetic: prisma + logger + password utils + jwt + loop metrics mocked;
 * app.listen(0) + fetch like auth.account.test.
 */

import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    refreshToken: {
      deleteMany: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/password', () => ({
  __esModule: true,
  hashPassword: jest.fn(),
  comparePassword: jest.fn(),
}));
jest.mock('../../utils/jwt', () => ({
  __esModule: true,
  verifyAccessToken: jest.fn(),
  generateAccessToken: jest.fn(),
  generateRefreshToken: jest.fn(),
  verifyRefreshToken: jest.fn(),
}));
jest.mock('../crossmodel/context.service', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('../crossmodel/platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { AUTH_PASSWORD_CHANGED: 'auth_password_changed' },
}));
// error-handler pulls config/env → process.exit without env vars (CI is env-less).
jest.mock('../../config/env', () => ({
  __esModule: true,
  env: {},
}));

import authRoutes from './auth.routes';
import authService from './auth.service';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { comparePassword, hashPassword } from '../../utils/password';
import { verifyAccessToken, generateAccessToken, generateRefreshToken } from '../../utils/jwt';
import { errorHandler } from '../../middleware/error-handler';
import {
  configurePasswordChangeCutoffStore,
  cutoffKey,
  CUTOFF_TTL_SECONDS,
  __resetPasswordChangeCutoffForTest,
} from './password-change-cutoff';
import { recordLoopMetric } from '../crossmodel/platform/loop-metrics.service';

const mockedPrisma = prisma as unknown as {
  user: { findUnique: jest.Mock; update: jest.Mock };
  refreshToken: { deleteMany: jest.Mock; create: jest.Mock };
  $transaction: jest.Mock;
};
const mockedCompare = comparePassword as jest.Mock;
const mockedHash = hashPassword as jest.Mock;
const mockedVerify = verifyAccessToken as jest.Mock;
const mockedGenAccess = generateAccessToken as jest.Mock;
const mockedGenRefresh = generateRefreshToken as jest.Mock;

const CURRENT = 'old-password-1';
const NEXT = 'new-password-1';
const NEW_HASH = '$2a$10$newhashnewhashnewhashnewhashnewhashnewhashnewhash';

const ADULT = {
  id: 'u1',
  email: 'a@b.c',
  role: 'USER',
  password: '$2a$10$storedhashstoredhashstoredhashstoredhashstoredhash',
  isActive: true,
  deletedAt: null,
  isChild: false,
  parentId: null,
};

/** In-memory stand-in for the shared Redis client. */
function fakeStore() {
  const data = new Map<string, string>();
  return {
    data,
    isReady: true,
    get: jest.fn(async (k: string) => data.get(k) ?? null),
    set: jest.fn(async (k: string, v: string, _opts: { EX: number }) => { data.set(k, v); return 'OK'; }),
  };
}

function happyPathMocks(revokedCount = 3) {
  mockedPrisma.user.findUnique.mockResolvedValue({ ...ADULT });
  mockedCompare.mockResolvedValue(true);
  mockedHash.mockResolvedValue(NEW_HASH);
  mockedGenAccess.mockReturnValue('new-access');
  mockedGenRefresh.mockReturnValue('new-refresh');
  mockedPrisma.user.update.mockResolvedValue({});
  mockedPrisma.refreshToken.deleteMany.mockResolvedValue({ count: revokedCount });
  mockedPrisma.refreshToken.create.mockResolvedValue({});
  mockedPrisma.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
}

function allLoggedText(): string {
  const l = logger as unknown as Record<'error' | 'warn' | 'info' | 'debug', jest.Mock>;
  return JSON.stringify([l.error.mock.calls, l.warn.mock.calls, l.info.mock.calls, l.debug.mock.calls]);
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetPasswordChangeCutoffForTest();
});

// ── SERVICE LAYER ─────────────────────────────────────────────────────────────

describe('authService.changePassword', () => {
  it('re-auths, hashes like register, swaps every refresh token for a fresh one, and cuts off older access tokens', async () => {
    const store = fakeStore();
    configurePasswordChangeCutoffStore(store);
    happyPathMocks(3);
    const before = Math.floor(Date.now() / 1000);

    const result = await authService.changePassword('u1', { currentPassword: CURRENT, newPassword: NEXT });

    expect(mockedCompare).toHaveBeenCalledWith(CURRENT, ADULT.password);
    expect(mockedHash).toHaveBeenCalledWith(NEXT);
    // ONE transaction: the hash, every refresh token of the user, the caller's fresh one.
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { password: NEW_HASH } });
    expect(mockedPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    expect(mockedPrisma.refreshToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', token: 'new-refresh', expiresAt: expect.any(Date) }),
    });
    // The new pair carries the same claims login mints.
    expect(mockedGenAccess).toHaveBeenCalledWith({ userId: 'u1', email: 'a@b.c', role: 'USER', isChild: false, parentId: null });
    // Access-token cutoff recorded in the shared store.
    expect(store.set).toHaveBeenCalledWith(cutoffKey('u1'), expect.any(String), { EX: CUTOFF_TTL_SECONDS });
    expect(Number(store.data.get(cutoffKey('u1')))).toBeGreaterThanOrEqual(before);

    expect(result).toEqual({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      refreshTokensRevoked: 3,
      accessTokensCutOff: true,
    });
    // Telemetry: a user-id hash only.
    await new Promise((r) => setImmediate(r));
    expect(recordLoopMetric).toHaveBeenCalledWith({
      kind: 'auth_password_changed',
      meta: { userIdHash: expect.stringMatching(/^[0-9a-f]{16}$/), refreshTokensRevoked: 3, accessCutoff: true },
    });
    // No password, hash or email in any log line or metric.
    const logged = allLoggedText() + JSON.stringify((recordLoopMetric as jest.Mock).mock.calls);
    for (const secret of [CURRENT, NEXT, NEW_HASH, ADULT.password, 'a@b.c']) expect(logged).not.toContain(secret);
  });

  it('reports accessTokensCutOff:false (and still changes the password) when Redis is not ready', async () => {
    configurePasswordChangeCutoffStore({ ...fakeStore(), isReady: false });
    happyPathMocks(1);

    const result = await authService.changePassword('u1', { currentPassword: CURRENT, newPassword: NEXT });

    expect(result.accessTokensCutOff).toBe(false);
    expect(mockedPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('did not reach Redis'));
  });

  it('rejects a wrong current password with 400 (not 401 — the web client would treat 401 as an expired session)', async () => {
    happyPathMocks();
    mockedCompare.mockResolvedValue(false);

    await expect(authService.changePassword('u1', { currentPassword: 'wrong', newPassword: NEXT })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Current password is incorrect',
    });
    expect(mockedHash).not.toHaveBeenCalled();
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a Digby Kids child account (403) without checking the password', async () => {
    happyPathMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ ...ADULT, isChild: true, parentId: 'p1' });

    await expect(authService.changePassword('u1', { currentPassword: CURRENT, newPassword: NEXT })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockedCompare).not.toHaveBeenCalled();
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers 400 honestly for an account with no password set', async () => {
    happyPathMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ ...ADULT, password: '' });

    await expect(authService.changePassword('u1', { currentPassword: CURRENT, newPassword: NEXT })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('no password set'),
    });
    expect(mockedCompare).not.toHaveBeenCalled();
  });

  it('401s a deactivated or missing user', async () => {
    happyPathMocks();
    mockedPrisma.user.findUnique.mockResolvedValue({ ...ADULT, isActive: false });
    await expect(authService.changePassword('u1', { currentPassword: CURRENT, newPassword: NEXT })).rejects.toMatchObject({ statusCode: 401 });
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    await expect(authService.changePassword('u1', { currentPassword: CURRENT, newPassword: NEXT })).rejects.toMatchObject({ statusCode: 401 });
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ── HTTP ──────────────────────────────────────────────────────────────────────

describe('POST /api/auth/change-password (HTTP)', () => {
  const NOW_SEC = () => Math.floor(Date.now() / 1000);

  beforeEach(() => {
    // 'old-*' tokens were minted an hour ago; anything else is fresh.
    mockedVerify.mockImplementation((token: string) => ({
      userId: 'u1',
      email: 'a@b.c',
      role: 'USER',
      isChild: false,
      parentId: null,
      iat: token.startsWith('old') ? NOW_SEC() - 3600 : NOW_SEC() + 1,
    }));
  });

  async function withServer(fn: (port: number) => Promise<void>): Promise<void> {
    const app: Express = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use(errorHandler);
    const server = await new Promise<import('http').Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const { port } = server.address() as { port: number };
      await fn(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  function post(port: number, body: unknown, token?: string) {
    return fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  }

  it('401s without a token (inline authenticate — /api/auth mounts before the guard)', async () => {
    await withServer(async (port) => {
      const res = await post(port, { currentPassword: CURRENT, newPassword: NEXT });
      expect(res.status).toBe(401);
      expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  it('400s a weak new password (the register rule: at least 8 characters, after trimming)', async () => {
    await withServer(async (port) => {
      for (const weak of ['short', '        ', '  abc12  ']) {
        const res = await post(port, { currentPassword: CURRENT, newPassword: weak }, 'tok');
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain('at least 8 characters');
        expect(text).not.toContain(CURRENT);
      }
      expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  it('400s a new password equal to the current one', async () => {
    await withServer(async (port) => {
      const res = await post(port, { currentPassword: CURRENT, newPassword: ` ${CURRENT} ` }, 'tok');
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('different from your current password');
      expect(mockedPrisma.user.findUnique).not.toHaveBeenCalled();
    });
  });

  it('400s a missing current password', async () => {
    await withServer(async (port) => {
      const res = await post(port, { newPassword: NEXT }, 'tok');
      expect(res.status).toBe(400);
    });
  });

  it('400s a wrong current password with a generic message', async () => {
    happyPathMocks();
    mockedCompare.mockResolvedValue(false);
    await withServer(async (port) => {
      const res = await post(port, { currentPassword: 'wrong-guess', newPassword: NEXT }, 'tok');
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Current password is incorrect' });
    });
  });

  it('succeeds: new token pair like login (cookies + accessToken), other sessions revoked, this one kept', async () => {
    const store = fakeStore();
    configurePasswordChangeCutoffStore(store);
    happyPathMocks(4);

    await withServer(async (port) => {
      // An old access token from ANOTHER device works before the change.
      mockedPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@b.c', role: 'USER' });
      const before = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { Authorization: 'Bearer old-other-device' } });
      expect(before.status).toBe(200);

      const res = await post(port, { currentPassword: CURRENT, newPassword: NEXT }, 'old-this-tab');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
      expect(body.success).toBe(true);
      expect(body.data).toEqual({ accessToken: 'new-access', refreshTokensRevoked: 4, accessTokensCutOff: true });
      const setCookie = res.headers.get('set-cookie') || '';
      expect(setCookie).toContain('refreshToken=new-refresh');
      expect(setCookie).toContain('cm_access=new-access');
      // The middleware's sliding re-issue of the OLD token is replaced, never appended.
      expect(setCookie).not.toContain('cm_access=old-this-tab');
      expect(JSON.stringify(body)).not.toContain(NEW_HASH);

      // Every refresh token of the user was deleted (all devices).
      expect(mockedPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });

      // The other device's access token (minted before the change) is now refused…
      const after = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { Authorization: 'Bearer old-other-device' } });
      expect(after.status).toBe(401);
      expect(await after.json()).toMatchObject({ code: 'PASSWORD_CHANGED' });

      // …while the caller's fresh token keeps working.
      mockedPrisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', email: 'a@b.c', role: 'USER' });
      const mine = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { headers: { Authorization: 'Bearer new-access' } });
      expect(mine.status).toBe(200);
    });
  });

  it('is rate-limited with login/register (app.ts authRateLimit)', () => {
    const app = readFileSync(join(__dirname, '../../app.ts'), 'utf8');
    expect(app).toContain("app.use('/api/auth/change-password', authRateLimit);");
  });
});
