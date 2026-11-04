/**
 * Tests for the auth middleware — the gatekeeper for every authenticated route
 * (~25 route files). Pins the token-resolution order (Bearer header → cm_access
 * cookie → ?token= query param), the 401/403 semantics, and the Digby Kids
 * child-account rejection, so a refactor can't silently open an auth bypass.
 */

import { NextFunction } from 'express';
import { authenticate, optionalAuthenticate, rejectChild, authorize, AuthRequest } from './auth';
import { verifyAccessToken } from '../utils/jwt';

jest.mock('../utils/jwt', () => ({
  verifyAccessToken: jest.fn(),
}));

// Silence error logging for the expected 401 paths.
jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// The invalid-token spike counter reaches config/redis (→ config/env, which
// hard-exits without env vars) — mock the signal module and assert the calls.
jest.mock('./auth-signal', () => ({
  __esModule: true,
  recordInvalidTokenSignal: jest.fn(),
  buildInvalidTokenSample: jest.fn(() => ({})),
  isDeadTokenShape: jest.requireActual('./auth-signal').isDeadTokenShape,
  INVALID_TOKEN_SPIKE_THRESHOLD: 30,
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordInvalidTokenSignal } = require('./auth-signal');

const mockedVerify = verifyAccessToken as jest.Mock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { __resetTokenNoiseForTest } = require('./token-noise');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mockLogger = require('../utils/logger').default;

const PAYLOAD = { userId: 'user-1', email: 'a@b.c', role: 'USER' };

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.cookie = jest.fn().mockReturnValue(res);
  res.clearCookie = jest.fn().mockReturnValue(res);
  res.getHeader = jest.fn().mockReturnValue(undefined);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.removeHeader = jest.fn().mockReturnValue(res);
  return res;
}

/**
 * Express-faithful res fake: res.cookie() APPENDS a Set-Cookie header (exactly
 * like the real implementation) so the stacked-middleware dedupe is tested
 * against real header semantics, not a jest.fn() that forgets calls.
 */
function appendingRes() {
  const headers: Record<string, string | string[]> = {};
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.getHeader = (name: string) => headers[name];
  res.setHeader = (name: string, value: string | string[]) => { headers[name] = value; return res; };
  res.removeHeader = (name: string) => { delete headers[name]; };
  res.cookie = (name: string, value: string, _opts: unknown) => {
    const serialized = `${name}=${value}; Path=/; HttpOnly`;
    const prev = headers['Set-Cookie'];
    headers['Set-Cookie'] = prev === undefined ? [serialized]
      : Array.isArray(prev) ? [...prev, serialized] : [String(prev), serialized];
    return res;
  };
  res.setCookieHeaders = () => {
    const v = headers['Set-Cookie'];
    return v === undefined ? [] : Array.isArray(v) ? v : [String(v)];
  };
  return res;
}

function mockReq(overrides: Record<string, any> = {}): AuthRequest {
  return { headers: {}, query: {}, ...overrides } as unknown as AuthRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedVerify.mockReturnValue(PAYLOAD);
});

describe('authenticate', () => {
  const next: NextFunction = jest.fn();

  it('401s when no token is present anywhere', async () => {
    const res = mockRes();
    await authenticate(mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'No token provided' });
    expect(next).not.toHaveBeenCalled();
  });

  it('accepts a Bearer token and maps userId → id', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer good-token' } });
    const res = mockRes();
    await authenticate(req, res, next);
    expect(mockedVerify).toHaveBeenCalledWith('good-token');
    expect(req.user).toEqual({ ...PAYLOAD, id: 'user-1' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('accepts the httpOnly cm_access cookie when there is no Bearer header', async () => {
    const req = mockReq({ cookies: { cm_access: 'cookie-token' } });
    const res = mockRes();
    await authenticate(req, res, next);
    expect(mockedVerify).toHaveBeenCalledWith('cookie-token');
    expect(req.user?.id).toBe('user-1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-Bearer authorization header and 401s without a cookie', async () => {
    const res = mockRes();
    await authenticate(mockReq({ headers: { authorization: 'Basic abc' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'No token provided' });
    expect(mockedVerify).not.toHaveBeenCalled();
  });

  it('401s when the token is invalid or expired', async () => {
    mockedVerify.mockImplementation(() => { throw new Error('jwt expired'); });
    const res = mockRes();
    await authenticate(mockReq({ headers: { authorization: 'Bearer bad' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  // 2026-08-08 errlog flood: routine expired client tokens must never reach
  // error. Since 2026-10-19 an EXPIRED token is a stale session (info, handled
  // — never stored in app_error_logs); an INVALID token can be forgery and
  // stays warn.
  it('logs an expired JWT at info (handled) and an invalid JWT at warn — never error', async () => {
    const logger = (await import('../utils/logger')).default as any;
    for (const [name, level] of [['TokenExpiredError', 'info'], ['JsonWebTokenError', 'warn']] as const) {
      __resetTokenNoiseForTest(); // loop #19 dedupes repeats of the SAME token — this pin is about the level, not volume
      logger.warn.mockClear(); logger.error.mockClear(); logger.info.mockClear();
      const err: any = new Error(name === 'TokenExpiredError' ? 'jwt expired' : 'invalid token');
      err.name = name;
      mockedVerify.mockImplementation(() => { throw err; });
      const res = mockRes();
      await authenticate(mockReq({ headers: { authorization: 'Bearer stale' } }), res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(logger[level]).toHaveBeenCalledTimes(1);
      expect(logger[level === 'info' ? 'warn' : 'info']).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      if (level === 'info') expect(logger.info.mock.calls[0][1]).toEqual(expect.objectContaining({ logClass: 'handled' }));
    }
  });

  // Compensating signal for the warn taxonomy: expiry is routine, but an
  // INVALID token (bad signature / malformed) is the forgery fingerprint —
  // it must feed the rate-limited spike counter so floods stay visible to
  // the error-level scanners.
  it('feeds the invalid-token spike counter for JsonWebTokenError, not TokenExpiredError', async () => {
    for (const [name, expectedCalls] of [['TokenExpiredError', 0], ['JsonWebTokenError', 1]] as const) {
      (recordInvalidTokenSignal as jest.Mock).mockClear();
      const err: any = new Error('bad');
      err.name = name;
      mockedVerify.mockImplementation(() => { throw err; });
      await authenticate(mockReq({ headers: { authorization: 'Bearer x' }, ip: '9.9.9.9' }), mockRes(), next);
      expect(recordInvalidTokenSignal).toHaveBeenCalledTimes(expectedCalls);
      if (expectedCalls) expect(recordInvalidTokenSignal).toHaveBeenCalledWith('9.9.9.9', 'authenticate', expect.any(Object));
    }
  });

  it('still logs unexpected auth failures at error', async () => {
    const logger = (await import('../utils/logger')).default as any;
    logger.warn.mockClear(); logger.error.mockClear();
    mockedVerify.mockImplementation(() => { throw new Error('secret store unreachable'); });
    const res = mockRes();
    await authenticate(mockReq({ headers: { authorization: 'Bearer x' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // Sliding cm_access re-issue (2026-07-23 "Chat not found" SSE fix): the SSE
  // EventSource GET authenticates ONLY via the cm_access cookie, which holds a
  // short-lived (15m) access token previously re-set only at login/refresh.
  // Re-issuing on every Bearer-authenticated request keeps the cookie in
  // lockstep with the token the client is actually using.
  it('re-issues the cm_access cookie on every successful Bearer auth', async () => {
    const res = mockRes();
    await authenticate(mockReq({ headers: { authorization: 'Bearer live-token' } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.cookie).toHaveBeenCalledWith(
      'cm_access',
      'live-token',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    );
  });

  it('re-issues the cm_access cookie when auth came from the cookie itself', async () => {
    const res = mockRes();
    await authenticate(mockReq({ cookies: { cm_access: 'cookie-token' } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.cookie).toHaveBeenCalledWith('cm_access', 'cookie-token', expect.any(Object));
  });

  it('does NOT touch the cookie on a 401', async () => {
    const res = mockRes();
    await authenticate(mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  // Regression (2026-07-23 prod 502s): every /api/crossmodel router that opens
  // with router.use(authenticate) re-runs this middleware while a request falls
  // through to a later router — /coding/* passes 8 of them. res.cookie()
  // appends, so the response accumulated 8 duplicate ~400-byte cm_access
  // headers (>4KB total), overflowing nginx's proxy_buffer_size → 502 on every
  // authenticated coding endpoint. The re-issue must REPLACE, never stack.
  it('stacked authenticate runs leave exactly ONE cm_access Set-Cookie header', async () => {
    const res = appendingRes();
    for (let i = 0; i < 8; i++) {
      await authenticate(mockReq({ headers: { authorization: 'Bearer live-token' } }), res, next);
    }
    const cmCookies = res.setCookieHeaders().filter((c: string) => c.startsWith('cm_access='));
    expect(cmCookies).toHaveLength(1);
    expect(cmCookies[0]).toContain('cm_access=live-token');
  });

  it('stacked re-issue preserves OTHER Set-Cookie headers (e.g. refreshToken)', async () => {
    const res = appendingRes();
    res.cookie('refreshToken', 'refresh-1', {});
    await authenticate(mockReq({ headers: { authorization: 'Bearer live-token' } }), res, next);
    await authenticate(mockReq({ headers: { authorization: 'Bearer live-token' } }), res, next);
    const all = res.setCookieHeaders();
    expect(all.filter((c: string) => c.startsWith('refreshToken='))).toHaveLength(1);
    expect(all.filter((c: string) => c.startsWith('cm_access='))).toHaveLength(1);
  });
});

describe('optionalAuthenticate', () => {
  const next: NextFunction = jest.fn();

  it('always calls next() and stays anonymous with no token', async () => {
    const req = mockReq();
    await optionalAuthenticate(req, mockRes(), next);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('sets req.user from the Bearer header', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer t1' } });
    await optionalAuthenticate(req, mockRes(), next);
    expect(mockedVerify).toHaveBeenCalledWith('t1');
    expect(req.user?.id).toBe('user-1');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('re-issues the cm_access cookie when a Bearer token verifies (sliding re-issue)', async () => {
    const res = mockRes();
    await optionalAuthenticate(mockReq({ headers: { authorization: 'Bearer t9' } }), res, next);
    expect(res.cookie).toHaveBeenCalledWith(
      'cm_access',
      't9',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    );
  });

  it('does NOT set the cookie when continuing anonymous', async () => {
    const res = mockRes();
    await optionalAuthenticate(mockReq(), res, next);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('falls back to the cm_access cookie, then the ?token= query param', async () => {
    const fromCookie = mockReq({ cookies: { cm_access: 'cookie-t' }, query: { token: 'query-t' } });
    await optionalAuthenticate(fromCookie, mockRes(), next);
    expect(mockedVerify).toHaveBeenCalledWith('cookie-t'); // cookie beats query

    const fromQuery = mockReq({ query: { token: 'query-t' } });
    await optionalAuthenticate(fromQuery, mockRes(), next);
    expect(mockedVerify).toHaveBeenCalledWith('query-t');
    expect(fromQuery.user?.id).toBe('user-1');
  });

  it('prefers the Bearer header over cookie and query', async () => {
    const req = mockReq({
      headers: { authorization: 'Bearer header-t' },
      cookies: { cm_access: 'cookie-t' },
      query: { token: 'query-t' },
    });
    await optionalAuthenticate(req, mockRes(), next);
    expect(mockedVerify).toHaveBeenCalledWith('header-t');
  });

  it('stacked optionalAuthenticate runs leave exactly ONE cm_access Set-Cookie header', async () => {
    const res = appendingRes();
    for (let i = 0; i < 4; i++) {
      await optionalAuthenticate(mockReq({ headers: { authorization: 'Bearer t9' } }), res, next);
    }
    expect(res.setCookieHeaders().filter((c: string) => c.startsWith('cm_access='))).toHaveLength(1);
  });

  it('continues anonymous (never 401s) on an invalid token', async () => {
    mockedVerify.mockImplementation(() => { throw new Error('bad signature'); });
    const req = mockReq({ headers: { authorization: 'Bearer bad' } });
    const res = mockRes();
    await optionalAuthenticate(req, res, next);
    expect(req.user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('rejectChild', () => {
  const next: NextFunction = jest.fn();

  it('403s a child sub-account token with the dedicated code', () => {
    const res = mockRes();
    rejectChild(mockReq({ user: { ...PAYLOAD, id: 'kid-1', isChild: true } }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CHILD_ACCOUNT_FORBIDDEN' }));
    expect(next).not.toHaveBeenCalled();
  });

  it('passes adult tokens (and tokens without the claim) through', () => {
    const res = mockRes();
    rejectChild(mockReq({ user: { ...PAYLOAD, id: 'user-1' } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('authorize', () => {
  const next: NextFunction = jest.fn();

  it('401s when there is no authenticated user', () => {
    const res = mockRes();
    authorize('ADMIN')(mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when the role is not in the allowed list', () => {
    const res = mockRes();
    authorize('ADMIN')(mockReq({ user: { ...PAYLOAD, id: 'user-1' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the role is allowed', () => {
    const res = mockRes();
    authorize('ADMIN', 'USER')(mockReq({ user: { ...PAYLOAD, id: 'user-1' } }), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('expired-token flood guard (autonomy loop #19: one client re-presented a six-day-old token every ~38 s — 376 warn rows in 4 h)', () => {
  const expired = () => { const e: any = new Error('jwt expired'); e.name = 'TokenExpiredError'; return e; };
  beforeEach(() => { __resetTokenNoiseForTest(); mockedVerify.mockReset(); (mockLogger.warn as jest.Mock).mockClear(); (mockLogger.info as jest.Mock).mockClear(); (mockLogger.debug as jest.Mock).mockClear(); });

  it('an EXPIRED token that arrived only via the cm_access cookie clears that cookie (the browser cannot) — a Bearer-sourced one does not', async () => {
    mockedVerify.mockImplementation(() => { throw expired(); });
    const resCookie = mockRes();
    await authenticate({ headers: {}, cookies: { cm_access: 'stale.cookie.token' } } as any, resCookie, jest.fn());
    expect(resCookie.status).toHaveBeenCalledWith(401);
    expect(resCookie.clearCookie).toHaveBeenCalledWith('cm_access', expect.objectContaining({ path: '/', httpOnly: true }));
    expect(resCookie.clearCookie.mock.calls[0][1]).not.toHaveProperty('maxAge');
    const resBearer = mockRes();
    await authenticate({ headers: { authorization: 'Bearer stale.bearer.token' }, cookies: {} } as any, resBearer, jest.fn());
    expect(resBearer.status).toHaveBeenCalledWith(401);
    expect(resBearer.clearCookie).not.toHaveBeenCalled();
  });

  it('the SAME expired token logs ONE handled info line per window and debug for the repeats; a different token logs again', async () => {
    mockedVerify.mockImplementation(() => { throw expired(); });
    for (let i = 0; i < 4; i++) {
      await authenticate({ headers: { authorization: 'Bearer same.expired.token' }, cookies: {} } as any, mockRes(), jest.fn());
    }
    const firsts = (mockLogger.info as jest.Mock).mock.calls.filter((c: any[]) => /Authentication failed \(client token/.test(String(c[0])));
    expect(firsts).toHaveLength(1);
    expect(String(firsts[0][0])).toContain('bearer');
    expect((mockLogger.warn as jest.Mock).mock.calls.filter((c: any[]) => /Authentication failed/.test(String(c[0])))).toHaveLength(0);
    const debugs = (mockLogger.debug as jest.Mock).mock.calls.filter((c: any[]) => /repeat #/.test(String(c[0])));
    expect(debugs).toHaveLength(3);
    await authenticate({ headers: { authorization: 'Bearer another.expired.token' }, cookies: {} } as any, mockRes(), jest.fn());
    expect((mockLogger.info as jest.Mock).mock.calls.filter((c: any[]) => /Authentication failed \(client token/.test(String(c[0])))).toHaveLength(2);
  });

  it('a DEAD pre-rotation token (invalid signature, its own exp long past) is a stale session: info, never the spike counter', async () => {
    const jwt = require('jsonwebtoken');
    const dead = jwt.sign({ userId: 'u-stale', exp: Math.floor(Date.now() / 1000) - 7 * 86400 }, 'the-old-rotated-secret');
    (recordInvalidTokenSignal as jest.Mock).mockClear(); (mockLogger.info as jest.Mock).mockClear();
    mockedVerify.mockImplementation(() => { const e: any = new Error('invalid signature'); e.name = 'JsonWebTokenError'; throw e; });
    await authenticate({ headers: { authorization: `Bearer ${dead}` }, cookies: {} } as any, mockRes(), jest.fn());
    expect(recordInvalidTokenSignal).not.toHaveBeenCalled();
    expect((mockLogger.warn as jest.Mock).mock.calls.filter((c: any[]) => /Authentication failed/.test(String(c[0])))).toHaveLength(0);
    expect((mockLogger.info as jest.Mock).mock.calls[0][1]).toEqual(expect.objectContaining({ logClass: 'handled' }));
  });

  it('an invalid-signature token with a LIVE exp stays the forgery signal: warn + spike counter', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ userId: 'u-target', exp: Math.floor(Date.now() / 1000) + 900 }, 'attacker-guess');
    (recordInvalidTokenSignal as jest.Mock).mockClear();
    mockedVerify.mockImplementation(() => { const e: any = new Error('invalid signature'); e.name = 'JsonWebTokenError'; throw e; });
    await authenticate({ headers: { authorization: `Bearer ${forged}` }, cookies: {} } as any, mockRes(), jest.fn());
    expect(recordInvalidTokenSignal).toHaveBeenCalledTimes(1);
    expect((mockLogger.warn as jest.Mock).mock.calls.filter((c: any[]) => /Authentication failed/.test(String(c[0])))).toHaveLength(1);
  });

  it('an invalid-signature token still feeds the spike counter on every occurrence (the forgery fingerprint is never deduped away)', async () => {
    (recordInvalidTokenSignal as jest.Mock).mockClear();
    mockedVerify.mockImplementation(() => { const e: any = new Error('invalid signature'); e.name = 'JsonWebTokenError'; throw e; });
    for (let i = 0; i < 3; i++) await authenticate({ headers: { authorization: 'Bearer forged.token' }, cookies: {} } as any, mockRes(), jest.fn());
    expect(recordInvalidTokenSignal).toHaveBeenCalledTimes(3);
  });
});
