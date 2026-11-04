/**
 * Tests for the error-handling middleware — the last-stop logger for every
 * unhandled route error. Pins the level taxonomy the ops scanners rely on:
 * a STALE session (expired JWT, non-login AppError 401 such as a dead refresh
 * token) logs at info with logClass 'handled' — info never reaches
 * app_error_logs, so a stale token cannot become a framework-sweep ticket (the
 * 2026-08-08 flood was error-level; the 2026-10-17 tickets were the same class
 * stored at warn). What can be an attack stays warn: a forged/malformed JWT
 * (JsonWebTokenError) and a failed POST /api/auth/login. Validation (Zod 400)
 * and other operational client errors (403, AppError 400) stay warn; unexpected
 * 5xx stay error.
 */

import { errorHandler, AppError, isStaleSessionError } from './error-handler';
import logger from '../utils/logger';

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config/env', () => ({ env: { NODE_ENV: 'test' } }));
// The invalid-token spike counter reaches config/redis — mock and assert calls.
jest.mock('./auth-signal', () => ({
  __esModule: true,
  recordInvalidTokenSignal: jest.fn(),
  buildInvalidTokenSample: jest.fn(() => ({})),
  INVALID_TOKEN_SPIKE_THRESHOLD: 30,
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordInvalidTokenSignal } = require('./auth-signal');

const mockedLogger = logger as jest.Mocked<typeof logger>;

function mockReqRes() {
  const req: any = { method: 'GET', url: '/api/x', originalUrl: '/api/x' };
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return { req, res };
}

beforeEach(() => jest.clearAllMocks());

describe('errorHandler level taxonomy', () => {
  it('logs an EXPIRED JWT at info (handled) and still 401s', () => {
    const err: any = new Error('jwt expired');
    err.name = 'TokenExpiredError';
    const { req, res } = mockReqRes();
    errorHandler(err, req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockedLogger.info).toHaveBeenCalledWith('Client error:', expect.objectContaining({ logClass: 'handled' }));
    expect(mockedLogger.warn).not.toHaveBeenCalled();
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it('keeps a forged/malformed JWT (JsonWebTokenError) at warn — the forgery fingerprint is never demoted', () => {
    const err: any = new Error('invalid signature');
    err.name = 'JsonWebTokenError';
    const { req, res } = mockReqRes();
    errorHandler(err, req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockedLogger.info).not.toHaveBeenCalled();
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it('isStaleSessionError: expired + non-login 401 only', () => {
    const expired: any = new Error('x'); expired.name = 'TokenExpiredError';
    const forged: any = new Error('x'); forged.name = 'JsonWebTokenError';
    expect(isStaleSessionError(expired, 500, false)).toBe(true);
    expect(isStaleSessionError(forged, 401, false)).toBe(false);
    expect(isStaleSessionError(new AppError(401, 'Invalid refresh token'), 401, false)).toBe(true);
    expect(isStaleSessionError(new AppError(401, 'Invalid credentials'), 401, true)).toBe(false);
    expect(isStaleSessionError(new AppError(403, 'Forbidden'), 403, false)).toBe(false);
  });

  it('feeds the invalid-token spike counter for JsonWebTokenError only', () => {
    for (const [name, expectedCalls] of [['TokenExpiredError', 0], ['JsonWebTokenError', 1]] as const) {
      jest.clearAllMocks();
      const err: any = new Error('bad token');
      err.name = name;
      const { req, res } = mockReqRes();
      (req as any).ip = '8.8.8.8';
      errorHandler(err, req, res, jest.fn());
      expect(recordInvalidTokenSignal).toHaveBeenCalledTimes(expectedCalls);
      if (expectedCalls) expect(recordInvalidTokenSignal).toHaveBeenCalledWith('8.8.8.8', 'error-handler', expect.any(Object));
    }
  });

  it('keeps operational 4xx AppErrors at warn', () => {
    const { req, res } = mockReqRes();
    errorHandler(new AppError(403, 'Forbidden'), req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it('keeps unexpected 5xx errors at error', () => {
    const { req, res } = mockReqRes();
    errorHandler(new Error('db connection lost'), req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockedLogger.error).toHaveBeenCalledTimes(1);
    expect(mockedLogger.warn).not.toHaveBeenCalled();
  });
});

// ── Telemetry-noise audit (PE-04 / PE-18 + the token-in-url finding) ─────────
jest.mock('../modules/crossmodel/platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { AUTH_LOGIN_FAILED: 'auth_login_failed' },
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordLoopMetric } = require('../modules/crossmodel/platform/loop-metrics.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ZodError } = require('zod');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { redactUrlForLog, isLoginAttempt } = require('./error-handler');

const flush = () => new Promise((r) => setImmediate(r));

describe('errorHandler — ZodError is a 400 client error (PE-04)', () => {
  it('logs a ZodError thrown inside a handler at warn with statusCode 400 (was error / 500) and answers 400', () => {
    const { req, res } = mockReqRes();
    const zerr = new ZodError([{ code: 'invalid_type', expected: 'string', received: 'undefined', path: ['content'], message: 'Required' }]);
    errorHandler(zerr, req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockedLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockedLogger.error).not.toHaveBeenCalled();
    expect((mockedLogger.warn as jest.Mock).mock.calls[0][1]).toMatchObject({ statusCode: 400, source: 'error-handler' });
  });
});

describe('errorHandler — query credentials never reach the log row', () => {
  it('redacts token-class query params and leaves the rest of the url intact', () => {
    expect(redactUrlForLog('/api/crossmodel/stream?chatId=&token=eyJhbGciOi.abc.def&mode=auto'))
      .toBe('/api/crossmodel/stream?chatId=&token=[redacted]&mode=auto');
    expect(redactUrlForLog('/api/x?access_token=abc#frag')).toBe('/api/x?access_token=[redacted]#frag');
    expect(redactUrlForLog('/api/x?q=token')).toBe('/api/x?q=token');
    expect(redactUrlForLog(undefined)).toBeUndefined();
  });

  it('the logged url of a /stream error carries no bearer', () => {
    const { req, res } = mockReqRes();
    req.url = '/api/crossmodel/stream?chatId=&token=secret.jwt.here';
    errorHandler(new AppError(400, 'Invalid chat ID'), req, res, jest.fn());
    const meta = (mockedLogger.warn as jest.Mock).mock.calls[0][1] as any;
    expect(meta.url).toBe('/api/crossmodel/stream?chatId=&token=[redacted]');
    expect(JSON.stringify(meta)).not.toContain('secret.jwt.here');
  });
});

describe('errorHandler — failed logins carry the client IP + an email hash (PE-18)', () => {
  it('isLoginAttempt matches only POST /api/auth/login', () => {
    expect(isLoginAttempt({ method: 'POST', originalUrl: '/api/auth/login', url: '/login' })).toBe(true);
    expect(isLoginAttempt({ method: 'POST', originalUrl: '/api/auth/login?x=1', url: '/login' })).toBe(true);
    expect(isLoginAttempt({ method: 'GET', originalUrl: '/api/auth/login', url: '/login' })).toBe(false);
    expect(isLoginAttempt({ method: 'POST', originalUrl: '/api/auth/login-history', url: '/login-history' })).toBe(false);
    expect(isLoginAttempt({ method: 'POST', originalUrl: '/api/auth/refresh', url: '/refresh' })).toBe(false);
  });

  it('a 401 on POST /api/auth/login logs ip + emailHash (never the address) and records auth_login_failed keyed by an ip hash', async () => {
    const { req, res } = mockReqRes();
    req.method = 'POST'; req.originalUrl = '/api/auth/login'; req.url = '/login';
    req.ip = '203.0.113.9'; req.body = { email: 'Someone@Example.com', password: 'nope' };
    errorHandler(new AppError(401, 'Invalid credentials'), req, res, jest.fn());
    await flush();
    expect(res.status).toHaveBeenCalledWith(401);
    // A wrong password can be a guess — warn, never demoted to handled.
    expect(mockedLogger.info).not.toHaveBeenCalled();
    const meta = (mockedLogger.warn as jest.Mock).mock.calls[0][1] as any;
    expect(meta.logClass).toBeUndefined();
    expect(meta.ip).toBe('203.0.113.9');
    expect(meta.emailHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(meta).toLowerCase()).not.toContain('someone@example.com');
    expect(recordLoopMetric).toHaveBeenCalledTimes(1);
    const row = recordLoopMetric.mock.calls[0][0];
    expect(row.kind).toBe('auth_login_failed');
    expect(row.meta.ipHash).toMatch(/^[0-9a-f]{16}$/);
    expect(row.meta.ipHash).not.toBe('203.0.113.9');
    expect(row.meta.emailHash).toBe(meta.emailHash);
  });

  it('a 401 elsewhere carries no ip / emailHash and records nothing', async () => {
    const { req, res } = mockReqRes();
    req.method = 'GET'; req.originalUrl = '/api/crossmodel/chats'; req.ip = '203.0.113.9';
    errorHandler(new AppError(401, 'Unauthorized'), req, res, jest.fn());
    await flush();
    expect(mockedLogger.warn).not.toHaveBeenCalled();
    const meta = (mockedLogger.info as jest.Mock).mock.calls[0][1] as any;
    expect(meta.logClass).toBe('handled');
    expect(meta.ip).toBeUndefined();
    expect(meta.emailHash).toBeUndefined();
    expect(recordLoopMetric).not.toHaveBeenCalled();
  });
});

// ── Ticket 4a8fcbde: the deploy-healthcheck probe must not mint auth rows ────
describe('errorHandler — the synthetic healthcheck login never records auth_login_failed (4a8fcbde)', () => {
  it('the known probe body (healthcheck@test.com → emailHash 0034506974bc51de) records NOTHING', async () => {
    const { req, res } = mockReqRes();
    req.method = 'POST'; req.originalUrl = '/api/auth/login'; req.url = '/login';
    req.ip = '10.0.7.99'; req.body = { email: 'healthcheck@test.com', password: 'test' };
    errorHandler(new AppError(401, 'Invalid credentials'), req, res, jest.fn());
    await flush();
    expect(res.status).toHaveBeenCalledWith(401);
    // The 401 still answers (liveness semantics unchanged) and still logs
    // at warn — a failed login is never demoted to handled…
    const meta = (mockedLogger.warn as jest.Mock).mock.calls[0][1] as any;
    expect(meta.emailHash).toBe('0034506974bc51de');
    // …but no loop_metrics row: a liveness probe is not a password guess.
    expect(recordLoopMetric).not.toHaveBeenCalled();
  });

  it('the probe hash is exactly sha256("healthcheck@test.com")[:16] — pin the correspondence', () => {
    const { createHash } = require('crypto');
    expect(createHash('sha256').update('healthcheck@test.com').digest('hex').slice(0, 16)).toBe('0034506974bc51de');
  });

  it('a REAL failed login still records (the skip must not swallow genuine guesses)', async () => {
    const { req, res } = mockReqRes();
    req.method = 'POST'; req.originalUrl = '/api/auth/login'; req.url = '/login';
    req.ip = '203.0.113.77'; req.body = { email: 'attacker@example.com', password: 'guess' };
    errorHandler(new AppError(401, 'Invalid credentials'), req, res, jest.fn());
    await flush();
    expect(recordLoopMetric).toHaveBeenCalledTimes(1);
    expect(recordLoopMetric.mock.calls[0][0].kind).toBe('auth_login_failed');
  });

  it('clientIpHash: hops-anchored derivation — the client is the entry QUOTA_TRUSTED_PROXY_HOPS from the RIGHT (4a8fcbde secondary)', async () => {
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    try {
      const { req, res } = mockReqRes();
      req.method = 'POST'; req.originalUrl = '/api/auth/login'; req.url = '/login';
      req.ip = '10.0.0.42'; // the socket peer — the last proxy in the chain (ALB/nginx), NOT the client
      // honest chain the trusted proxies APPENDED: client, ALB-node
      req.headers = { 'x-forwarded-for': '198.51.100.23, 10.0.0.42' };
      req.body = { email: 'attacker@example.com', password: 'guess' };
      errorHandler(new AppError(401, 'Invalid credentials'), req, res, jest.fn());
      await flush();
      expect(recordLoopMetric).toHaveBeenCalledTimes(1);
      const row = recordLoopMetric.mock.calls[0][0];
      const { createHash } = require('crypto');
      const expectedClientHash = createHash('sha256').update('198.51.100.23').digest('hex').slice(0, 16);
      expect(row.meta.clientIpHash).toBe(expectedClientHash);
      expect(row.meta.ipHash).toBe(createHash('sha256').update('10.0.0.42').digest('hex').slice(0, 16));
      // Privacy pin: no raw IP anywhere in the row.
      expect(JSON.stringify(row.meta)).not.toContain('198.51.100.23');
    } finally {
      delete process.env.QUOTA_TRUSTED_PROXY_HOPS;
    }
  });

  it('clientIpHash: a FORGED prepended hop cannot move the derived client (review F1 — the parts[0] bug)', async () => {
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    try {
      const { req, res } = mockReqRes();
      req.method = 'POST'; req.originalUrl = '/api/auth/login'; req.url = '/login';
      req.ip = '10.0.0.42';
      // the brute-forcer sent its own "X-Forwarded-For: 1.2.3.4"; the ALB then
      // APPENDED the real client and nginx the ALB node — same shape as the
      // quotaClientIp pin. The first hop is client-writable and must be IGNORED.
      req.headers = { 'x-forwarded-for': '1.2.3.4, 198.51.100.23, 10.0.0.42' };
      req.body = { email: 'attacker@example.com', password: 'guess' };
      errorHandler(new AppError(401, 'Invalid credentials'), req, res, jest.fn());
      await flush();
      const row = recordLoopMetric.mock.calls[0][0];
      const { createHash } = require('crypto');
      // the REAL client, not the forged 1.2.3.4
      expect(row.meta.clientIpHash).toBe(createHash('sha256').update('198.51.100.23').digest('hex').slice(0, 16));
      expect(row.meta.clientIpHash).not.toBe(createHash('sha256').update('1.2.3.4').digest('hex').slice(0, 16));
    } finally {
      delete process.env.QUOTA_TRUSTED_PROXY_HOPS;
    }
  });

  it('clientIpHash: hop count unset, chain shorter than hops, or a private derived entry — the key is omitted, never guessed', async () => {
    // (a) unset hop count: the field is omitted entirely (opt-in, like the quota key)
    {
      const { req, res } = mockReqRes();
      req.method = 'POST'; req.originalUrl = '/api/auth/login'; req.url = '/login';
      req.ip = '10.0.0.42';
      req.headers = { 'x-forwarded-for': '198.51.100.23, 10.0.0.42' };
      req.body = { email: 'attacker@example.com', password: 'guess' };
      errorHandler(new AppError(401, 'Invalid credentials'), req, res, jest.fn());
      await flush();
      expect(recordLoopMetric).toHaveBeenCalledTimes(1);
      expect(recordLoopMetric.mock.calls[0][0].meta.clientIpHash).toBeUndefined();
    }
    jest.clearAllMocks();
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    try {
      // (b) chain shorter than the hop count: no position to anchor on
      {
        const { req, res } = mockReqRes();
        req.method = 'POST'; req.originalUrl = '/api/auth/login'; req.url = '/login';
        req.ip = '10.0.0.42';
        req.headers = { 'x-forwarded-for': '198.51.100.23' }; // only ONE entry, hops=2
        req.body = { email: 'attacker@example.com', password: 'guess' };
        errorHandler(new AppError(401, 'Invalid credentials'), req, res, jest.fn());
        await flush();
        expect(recordLoopMetric).toHaveBeenCalledTimes(1);
        expect(recordLoopMetric.mock.calls[0][0].meta.clientIpHash).toBeUndefined();
      }
      jest.clearAllMocks();
      // (c) private/loopback ranges at the anchored position: CGNAT (100.64/10),
      // benchmark (198.18/15), link-local (fe80::), loopback — a fully internal
      // chain has no client to recover
      for (const candidate of ['100.64.0.1', '198.18.0.5', 'fe80::1', '127.0.0.1']) {
        jest.clearAllMocks();
        const { req, res } = mockReqRes();
        req.method = 'POST'; req.originalUrl = '/api/auth/login'; req.url = '/login';
        req.ip = '10.0.0.42';
        req.headers = { 'x-forwarded-for': `${candidate}, 10.0.0.42` };
        req.body = { email: 'attacker@example.com', password: 'guess' };
        errorHandler(new AppError(401, 'Invalid credentials'), req, res, jest.fn());
        await flush();
        expect(recordLoopMetric).toHaveBeenCalledTimes(1);
        expect(recordLoopMetric.mock.calls[0][0].meta.clientIpHash).toBeUndefined();
      }
    } finally {
      delete process.env.QUOTA_TRUSTED_PROXY_HOPS;
    }
  });
});

