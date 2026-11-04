/**
 * Tests for the invalid-token spike counter — the compensating signal for the
 * warn-level JWT taxonomy. Per-request JsonWebTokenError stays warn (see
 * auth.test.ts / error-handler.test.ts), but a sustained flood from one IP
 * must produce exactly ONE error-level line per window so the error-level
 * scanners (auto-fix triage, nightly telemetry) see the campaign.
 * 2026-10-14 FO retune: the two ALB AZ node IPs are the ACCEPTED-BASELINE
 * class — they fire only at the high tripwire (default 300), every other IP
 * keeps the legacy 30.
 */

const mockIncr: jest.Mock = jest.fn();
const mockExpire: jest.Mock = jest.fn(async () => 1);
const mockSet: jest.Mock = jest.fn(async () => 'OK');
const mockGet: jest.Mock = jest.fn(async () => null);

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../config/redis', () => ({
  __esModule: true,
  default: {
    incr: (...a: any[]) => mockIncr(...a),
    expire: (...a: any[]) => mockExpire(...a),
    set: (...a: any[]) => mockSet(...a),
    get: (...a: any[]) => mockGet(...a),
  },
}));

import { recordInvalidTokenSignal, buildInvalidTokenSample, INVALID_TOKEN_SPIKE_THRESHOLD, isDeadTokenShape } from './auth-signal';
import logger from '../utils/logger';

const mockedLogger = logger as jest.Mocked<typeof logger>;

/** recordInvalidTokenSignal is fire-and-forget — flush its async work. */
const flush = () => new Promise(setImmediate);

beforeEach(() => jest.clearAllMocks());

describe('recordInvalidTokenSignal', () => {
  it('increments a per-IP counter and sets the TTL on the first hit', async () => {
    mockIncr.mockResolvedValue(1);
    recordInvalidTokenSignal('1.2.3.4', 'authenticate');
    await flush();
    expect(mockIncr).toHaveBeenCalledWith('auth:invalid_token:1.2.3.4');
    expect(mockExpire).toHaveBeenCalledWith('auth:invalid_token:1.2.3.4', 3600);
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it('stays quiet below the threshold (no error-level noise)', async () => {
    mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD - 1);
    recordInvalidTokenSignal('1.2.3.4', 'authenticate');
    await flush();
    expect(mockedLogger.error).not.toHaveBeenCalled();
    expect(mockExpire).not.toHaveBeenCalled(); // TTL only set on the first hit
  });

  it('emits ONE error-level spike line exactly at the threshold crossing', async () => {
    mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
    recordInvalidTokenSignal('1.2.3.4', 'authenticatePlatform');
    await flush();
    expect(mockedLogger.error).toHaveBeenCalledTimes(1);
    const line = (mockedLogger.error as jest.Mock).mock.calls[0][0] as string;
    expect(line).toContain('ip=1.2.3.4');
    expect(line).toContain('authenticatePlatform');
    expect(line).toContain('JsonWebTokenError');
  });

  it('past the threshold it goes quiet again (one line per window, not per request)', async () => {
    mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD + 1);
    recordInvalidTokenSignal('1.2.3.4', 'authenticate');
    await flush();
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it('a missing IP is bucketed as "unknown"', async () => {
    mockIncr.mockResolvedValue(2);
    recordInvalidTokenSignal(undefined, 'error-handler');
    await flush();
    expect(mockIncr).toHaveBeenCalledWith('auth:invalid_token:unknown');
  });

  it('never throws when redis is down (the 401 path must not break)', async () => {
    mockIncr.mockRejectedValue(new Error('redis unreachable'));
    expect(() => recordInvalidTokenSignal('1.2.3.4', 'authenticate')).not.toThrow();
    await flush();
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });
});

describe('caller sample (caller-identification behind the ALB nodes)', () => {
  it('stores the freshest sample and renders it into the spike line', async () => {
    const sample = { path: '/api/coding/sessions', method: 'GET', userAgent: 'node-fetch/1.0', clientIp: '203.0.113.9', subject: 'user-1' };
    mockGet.mockResolvedValueOnce(JSON.stringify(sample));
    mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
    recordInvalidTokenSignal('1.2.3.4', 'error-handler', sample);
    await flush();
    expect(mockSet).toHaveBeenCalledWith('auth:invalid_token:1.2.3.4:sample', JSON.stringify(sample), { EX: 3600 });
    const line = (mockedLogger.error as jest.Mock).mock.calls[0][0] as string;
    expect(line).toContain('caller=');
    expect(line).toContain('/api/coding/sessions');
    expect(line).toContain('203.0.113.9');
    expect(line).toContain('user-1');
  });

  it('AUTH_SIGNAL_SAMPLE_DISABLED=1 skips the store and the render', async () => {
    process.env.AUTH_SIGNAL_SAMPLE_DISABLED = '1';
    try {
      mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
      recordInvalidTokenSignal('1.2.3.4', 'authenticate', { path: '/api/x' });
      await flush();
      expect(mockSet).not.toHaveBeenCalled();
      const line = (mockedLogger.error as jest.Mock).mock.calls[0][0] as string;
      expect(line).not.toContain('caller=');
    } finally {
      delete process.env.AUTH_SIGNAL_SAMPLE_DISABLED;
    }
  });

  it('an empty sample is never stored', async () => {
    mockIncr.mockResolvedValue(2);
    recordInvalidTokenSignal('1.2.3.4', 'authenticate', {});
    await flush();
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('a sample-store failure still counts and still fires the spike line', async () => {
    mockSet.mockRejectedValueOnce(new Error('redis busy'));
    mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
    recordInvalidTokenSignal('1.2.3.4', 'authenticate', { path: '/api/x' });
    await flush();
    expect(mockIncr).toHaveBeenCalledWith('auth:invalid_token:1.2.3.4');
    expect(mockedLogger.error).toHaveBeenCalledTimes(1);
  });
});

describe('baseline-IP retune (FO retune, 2026-10-14 — ALB AZ nodes are the accepted-baseline class)', () => {
  const BASELINE_IP = '10.0.0.1';
  const BASELINE_IP_B = '10.0.0.2';
  const THIRD_IP = '203.0.113.9';

  it('a baseline IP at the legacy threshold (30) fires NO error line but still counts', async () => {
    mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
    recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
    await flush();
    expect(mockedLogger.error).not.toHaveBeenCalled();
    expect(mockIncr).toHaveBeenCalledWith('auth:invalid_token:10.0.0.1');
  });

  it('a baseline IP first hit still sets the TTL (counter + TTL machinery unchanged)', async () => {
    mockIncr.mockResolvedValue(1);
    recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
    await flush();
    expect(mockIncr).toHaveBeenCalledWith('auth:invalid_token:10.0.0.1');
    expect(mockExpire).toHaveBeenCalledWith('auth:invalid_token:10.0.0.1', 3600);
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it('the other default baseline IP (10.0.0.2) is equally quiet at 30', async () => {
    mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
    recordInvalidTokenSignal(BASELINE_IP_B, 'authenticate');
    await flush();
    expect(mockedLogger.error).not.toHaveBeenCalled();
    expect(mockIncr).toHaveBeenCalledWith('auth:invalid_token:10.0.0.2');
  });

  it('a baseline IP stays quiet at 299 and fires exactly ONE tripwire line at 300', async () => {
    mockIncr.mockResolvedValue(299);
    recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
    await flush();
    expect(mockedLogger.error).not.toHaveBeenCalled();

    const sample = { path: '/api/crossmodel/news', method: 'GET' };
    mockGet.mockResolvedValueOnce(JSON.stringify(sample));
    mockIncr.mockResolvedValue(300);
    recordInvalidTokenSignal(BASELINE_IP, 'error-handler', sample);
    await flush();
    expect(mockedLogger.error).toHaveBeenCalledTimes(1);
    const line = (mockedLogger.error as jest.Mock).mock.calls[0][0] as string;
    expect(line.startsWith('Invalid-signature JWT spike:')).toBe(true); // byte-identical prefix for the scanners
    expect(line).toContain('ip=10.0.0.1');
    expect(line).toContain('(baseline-IP tripwire)');
    expect(line).toContain('caller='); // the caller render survives the retune
    expect(line).toContain('/api/crossmodel/news');
    // The caller-sample STORE also ran exactly as today (monitoring loses nothing).
    expect(mockSet).toHaveBeenCalledWith('auth:invalid_token:10.0.0.1:sample', JSON.stringify(sample), { EX: 3600 });
  });

  it('a baseline IP past the tripwire (301) goes quiet again (one line per window)', async () => {
    mockIncr.mockResolvedValue(301);
    recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
    await flush();
    expect(mockedLogger.error).not.toHaveBeenCalled();
  });

  it('a NON-baseline "third IP" still fires at the legacy threshold (30)', async () => {
    mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
    recordInvalidTokenSignal(THIRD_IP, 'error-handler');
    await flush();
    expect(mockedLogger.error).toHaveBeenCalledTimes(1);
    const line = (mockedLogger.error as jest.Mock).mock.calls[0][0] as string;
    expect(line.startsWith('Invalid-signature JWT spike:')).toBe(true);
    expect(line).toContain('ip=203.0.113.9');
    expect(line).not.toContain('(baseline-IP tripwire)');
  });

  it('AUTH_SIGNAL_BASELINE_IPS="" behaves as UNSET (the docker-compose `${VAR:-}` class) — the default pair applies', async () => {
    process.env.AUTH_SIGNAL_BASELINE_IPS = '';
    try {
      // The compose pass-through hands containers '' for a host-unset var: that
      // must NOT configure an empty baseline class (the 2026-10-14 neutering —
      // 30/60min rows kept firing on fully-deployed retune code).
      mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
      recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
      await flush();
      expect(mockedLogger.error).not.toHaveBeenCalled();

      mockIncr.mockResolvedValue(300);
      recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
      await flush();
      expect(mockedLogger.error).toHaveBeenCalledTimes(1);
      const line = (mockedLogger.error as jest.Mock).mock.calls[0][0] as string;
      expect(line).toContain('ip=10.0.0.1');
      expect(line).toContain('(baseline-IP tripwire)');
    } finally {
      delete process.env.AUTH_SIGNAL_BASELINE_IPS;
    }
  });

  it('AUTH_SIGNAL_BASELINE_IPS whitespace-only also behaves as UNSET', async () => {
    process.env.AUTH_SIGNAL_BASELINE_IPS = '   ';
    try {
      mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
      recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
      await flush();
      expect(mockedLogger.error).not.toHaveBeenCalled();
    } finally {
      delete process.env.AUTH_SIGNAL_BASELINE_IPS;
    }
  });

  it('AUTH_SIGNAL_BASELINE_IPS="none" (the explicit token) configures NO baseline IPs — 10.0.0.1 fires at 30', async () => {
    process.env.AUTH_SIGNAL_BASELINE_IPS = ' None ';
    try {
      mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
      recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
      await flush();
      expect(mockedLogger.error).toHaveBeenCalledTimes(1);
      const line = (mockedLogger.error as jest.Mock).mock.calls[0][0] as string;
      expect(line).toContain('ip=10.0.0.1');
      expect(line).not.toContain('(baseline-IP tripwire)');
    } finally {
      delete process.env.AUTH_SIGNAL_BASELINE_IPS;
    }
  });

  it('AUTH_SIGNAL_BASELINE_IPS override moves the baseline class (new IP baseline, defaults lifted)', async () => {
    process.env.AUTH_SIGNAL_BASELINE_IPS = ' 203.0.113.9 , 198.51.100.7 ';
    try {
      // An override IP joins the baseline class: quiet at 30.
      mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
      recordInvalidTokenSignal(THIRD_IP, 'error-handler');
      await flush();
      expect(mockedLogger.error).not.toHaveBeenCalled();

      // A default pair member is NO LONGER baseline once overridden: fires at 30.
      recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
      await flush();
      expect(mockedLogger.error).toHaveBeenCalledTimes(1);
      const line = (mockedLogger.error as jest.Mock).mock.calls[0][0] as string;
      expect(line).toContain('ip=10.0.0.1');
      expect(line).not.toContain('(baseline-IP tripwire)');
    } finally {
      delete process.env.AUTH_SIGNAL_BASELINE_IPS;
    }
  });

  it('AUTH_SIGNAL_BASELINE_DISABLED=1 kills the baseline class — 10.0.0.1 fires at 30', async () => {
    process.env.AUTH_SIGNAL_BASELINE_DISABLED = '1';
    try {
      mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
      recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
      await flush();
      expect(mockedLogger.error).toHaveBeenCalledTimes(1);
      const line = (mockedLogger.error as jest.Mock).mock.calls[0][0] as string;
      expect(line).toContain('ip=10.0.0.1');
      expect(line).not.toContain('(baseline-IP tripwire)');
    } finally {
      delete process.env.AUTH_SIGNAL_BASELINE_DISABLED;
    }
  });

  it('AUTH_SIGNAL_BASELINE_SPIKE_THRESHOLD="abc" falls back to the default 300', async () => {
    process.env.AUTH_SIGNAL_BASELINE_SPIKE_THRESHOLD = 'abc';
    try {
      mockIncr.mockResolvedValue(INVALID_TOKEN_SPIKE_THRESHOLD);
      recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
      await flush();
      expect(mockedLogger.error).not.toHaveBeenCalled();

      mockIncr.mockResolvedValue(300);
      recordInvalidTokenSignal(BASELINE_IP, 'error-handler');
      await flush();
      expect(mockedLogger.error).toHaveBeenCalledTimes(1);
      const line = (mockedLogger.error as jest.Mock).mock.calls[0][0] as string;
      expect(line.startsWith('Invalid-signature JWT spike:')).toBe(true);
      expect(line).toContain('ip=10.0.0.1');
      expect(line).toContain('(baseline-IP tripwire)');
    } finally {
      delete process.env.AUTH_SIGNAL_BASELINE_SPIKE_THRESHOLD;
    }
  });
});

describe('buildInvalidTokenSample', () => {
  it('keeps the path but NEVER the query string (the SSE ?token= stays out of logs)', () => {
    const s = buildInvalidTokenSample({ method: 'get', originalUrl: '/api/chats/c1/stream?token=SECRETJWT&x=1', headers: {} });
    expect(s.path).toBe('/api/chats/c1/stream');
    expect(s.method).toBe('GET');
    expect(JSON.stringify(s)).not.toContain('SECRETJWT');
  });

  it('derives clientIp at the trust-proxy depth (hops-anchored, NOT the client-writable first hop)', () => {
    // Honest ALB→nginx chain at hops=2: client, nginx, ALB — the entry TWO from
    // the right is the client. (Pre-fix this read split(',')[0] — the first
    // hop, client-writable and forgeable.)
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    try {
      const s = buildInvalidTokenSample({
        headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'u'.repeat(300) },
      });
      expect(s.clientIp).toBe('203.0.113.9');
      expect(s.userAgent).toHaveLength(160);

      // A FORGED prepended hop cannot move the derived client (todo ead881f4):
      // the prober claims 1.2.3.4 as the first hop; the derivation still names
      // the real client two from the right.
      const forged = buildInvalidTokenSample({
        headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.1' },
      });
      expect(forged.clientIp).toBe('203.0.113.9');
      expect(forged.clientIp).not.toBe('1.2.3.4');

      // Unset hop count ⇒ the field is OMITTED, never guessed.
      delete process.env.QUOTA_TRUSTED_PROXY_HOPS;
      const unset = buildInvalidTokenSample({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
      expect(unset.clientIp).toBeUndefined();

      // Chain shorter than the hop count ⇒ omitted.
      process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
      const short = buildInvalidTokenSample({ headers: { 'x-forwarded-for': '203.0.113.9' } });
      expect(short.clientIp).toBeUndefined();

      // A private candidate at the derived position (fully-internal chain) ⇒
      // omitted — there is no external client to recover.
      const internal = buildInvalidTokenSample({ headers: { 'x-forwarded-for': '10.0.0.9, 10.0.0.1' } });
      expect(internal.clientIp).toBeUndefined();
    } finally {
      delete process.env.QUOTA_TRUSTED_PROXY_HOPS;
    }
  });

  it('reads the dead token subject WITHOUT verifying it (identification hint, never trusted)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const token = require('jsonwebtoken').sign({ userId: 'user-abc' }, 'any-secret');
    const s = buildInvalidTokenSample({ headers: {} }, token);
    expect(s.subject).toBe('user-abc');
    expect(buildInvalidTokenSample({ headers: {} }, 'not-a-jwt').subject).toBeUndefined();
    expect(buildInvalidTokenSample({ headers: {} }).subject).toBeUndefined();
  });
});

describe('isDeadTokenShape (2026-10-19 — pre-rotation dead tokens are stale sessions, not forgery)', () => {
  const jwt = require('jsonwebtoken');
  afterEach(() => { delete process.env.AUTH_DEAD_TOKEN_STALE_DISABLED; });
  it('true for a token whose own exp is in the past, whatever key signed it', () => {
    expect(isDeadTokenShape(jwt.sign({ userId: 'u', exp: Math.floor(Date.now() / 1000) - 60 }, 'old-secret'))).toBe(true);
  });
  it('false for a live exp, no exp, garbage, or nothing', () => {
    expect(isDeadTokenShape(jwt.sign({ userId: 'u', exp: Math.floor(Date.now() / 1000) + 600 }, 'x'))).toBe(false);
    expect(isDeadTokenShape(jwt.sign({ userId: 'u' }, 'x'))).toBe(false);
    expect(isDeadTokenShape('not.a.jwt')).toBe(false);
    expect(isDeadTokenShape(undefined)).toBe(false);
  });
  it('AUTH_DEAD_TOKEN_STALE_DISABLED=1 → always false', () => {
    process.env.AUTH_DEAD_TOKEN_STALE_DISABLED = '1';
    expect(isDeadTokenShape(jwt.sign({ userId: 'u', exp: 1 }, 'old'))).toBe(false);
  });
});
