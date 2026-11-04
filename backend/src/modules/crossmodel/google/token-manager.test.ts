/**
 * token-manager disabled_client latch (FO firing f156, 2026-10-18).
 *
 * A `disabled_client` answer from the Google refresh endpoint is terminal
 * CLIENT-level (the OAuth client is disabled in Google Cloud Console) — without
 * a latch every getValidToken call re-attempted the refresh and looped a
 * level=error row every ~90 s (prod: n=119 in 4 h from one expired admin token,
 * first 2026-10-17T23:59:27Z). The latch (the utils/utility-llm.ts DeepSeek
 * billing-latch shape) short-circuits refreshes for
 * GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS (default 6 h; 0 = legacy behavior),
 * logging ONE error + filing ONE google_refresh_latch metric per window, and
 * KEEPS the token row (a re-enabled client makes the stored grant work again).
 * Pins: the latch, the expiry retry, the kill switch, and the unchanged
 * invalid_grant row-deletion + happy paths.
 */
const mockAxiosPost = jest.fn();
const mockFindFirst = jest.fn();
const mockDelete = jest.fn();
const mockUpdate = jest.fn();
const mockRecordLoopMetric = jest.fn(async (..._args: any[]) => undefined);
const mockLoggerError = jest.fn();
const mockLoggerInfo = jest.fn();

jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockAxiosPost(...a) } }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    googleOAuthToken: {
      findFirst: (...a: any[]) => mockFindFirst(...a),
      findUnique: jest.fn(),
      update: (...a: any[]) => mockUpdate(...a),
      delete: (...a: any[]) => mockDelete(...a),
    },
  },
}));
jest.mock('./crypto', () => ({ __esModule: true, encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.replace(/^enc:/, '') }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: (...a: any[]) => mockLoggerError(...a), info: (...a: any[]) => mockLoggerInfo(...a), warn: jest.fn(), debug: jest.fn() },
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { GOOGLE_REFRESH_LATCH: 'google_refresh_latch', GOOGLE_REFRESH_LATCH_SUPPRESSED: 'google_refresh_latch_suppressed' },
}));

// (07c1d554) e1cca01d-shape STATEFUL Redis mock — the key space actually holds
// what NX set, so a test can prove the fleet key SURVIVES the very emission
// that acquired it (the first e1cca01d implementation released the key on the
// row that latched, re-warning every miss).
const redisStore = new Map<string, string>();
const redisSet = jest.fn(async (key: string, val: string, opts?: any): Promise<string | null> => {
  const nx = !!(opts && opts.NX);
  if (nx && redisStore.has(key)) return null;
  redisStore.set(key, val);
  return 'OK';
});
const redisDel = jest.fn(async (key: string): Promise<number> => (redisStore.delete(key) ? 1 : 0));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: (...a: any[]) => (redisSet as any)(...a), del: (...a: any[]) => (redisDel as any)(...a) } }));

import { getValidToken, googleDisabledClientLatched, __resetGoogleDisabledClientLatchForTests, __resetGoogleRefreshWarnLatchForTests } from './token-manager';

const EXPIRED_ROW = {
  id: 'row1',
  userId: 'u1',
  label: 'Personal',
  accessToken: 'enc:old-access',
  refreshToken: 'enc:refresh',
  expiresAt: new Date(Date.now() - 60_000),
  email: 'u@example.com',
};

function axiosReject(error: string, status: number) {
  const e: any = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: { error } };
  return e;
}

describe('token-manager disabled_client latch', () => {
  const savedEnv = process.env.GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS;
  const savedCid = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetGoogleDisabledClientLatchForTests();
    __resetGoogleRefreshWarnLatchForTests();
    redisStore.clear();
    delete process.env.GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS;
    delete process.env.GOOGLE_REFRESH_LATCH_WARN_MS;
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
    mockFindFirst.mockResolvedValue(EXPIRED_ROW);
  });

  afterAll(() => {
    if (savedEnv === undefined) delete process.env.GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS;
    else process.env.GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS = savedEnv;
    if (savedCid === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID;
    else process.env.GOOGLE_OAUTH_CLIENT_ID = savedCid;
    if (savedSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    else process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedSecret;
  });

  it('latches on disabled_client: ONE error + ONE metric, row KEPT, second call makes no attempt and logs nothing', async () => {
    mockAxiosPost.mockRejectedValue(axiosReject('disabled_client', 401));

    const first = await getValidToken('u1');
    expect(first).toBeNull();
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(String(mockLoggerError.mock.calls[0][0])).toContain('disabled_client');
    // client-level error: the grant may survive a client re-enable — never deleted
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'google_refresh_latch' }));
    expect(googleDisabledClientLatched()).toBe(true);

    const second = await getValidToken('u1');
    expect(second).toBeNull();
    expect(mockAxiosPost).toHaveBeenCalledTimes(1); // latched: no new attempt
    expect(mockLoggerError).toHaveBeenCalledTimes(1); // latched: no hot error loop
  });

  it('latches on unauthorized_client (same terminal client family — FO f157, prod n=253/4h): ONE error + ONE metric, row KEPT, second call silent', async () => {
    mockAxiosPost.mockRejectedValue(axiosReject('unauthorized_client', 401));

    const first = await getValidToken('u1');
    expect(first).toBeNull();
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(String(mockLoggerError.mock.calls[0][0])).toContain('unauthorized_client');
    // client-level error: the grant may survive a client fix — never deleted
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'google_refresh_latch',
      meta: expect.objectContaining({ error: 'unauthorized_client' }),
    }));
    expect(googleDisabledClientLatched()).toBe(true);

    const second = await getValidToken('u1');
    expect(second).toBeNull();
    expect(mockAxiosPost).toHaveBeenCalledTimes(1); // latched: no new attempt
    expect(mockLoggerError).toHaveBeenCalledTimes(1); // latched: no hot error loop
  });

  it('retries once the latch window expires and re-latches on the next disabled_client (one error per FLEET warn window — 07c1d554)', async () => {
    process.env.GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS = '5';
    mockAxiosPost.mockRejectedValue(axiosReject('disabled_client', 401));

    await getValidToken('u1');
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 10));

    const beforeRetry = Date.now();
    await getValidToken('u1');
    expect(mockAxiosPost).toHaveBeenCalledTimes(2); // retry window expired → one retry
    // (07c1d554) the retry re-armed the process latch, but the EMISSION is
    // fleet-latched (24 h): no second error row — instead the suppressed-arm
    // metric. The refresh cadence is unchanged (6 h default), only the log is
    // once per user per day.
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'google_refresh_latch_suppressed' }));
    // (FO f164 flake fix — main red on 1825f880, CI 39237520214) assert the
    // re-arm RELATIVE to a pre-call timestamp, never against the 5 ms wall
    // clock: googleDisabledClientLatched() is a WITHIN-window probe, and a
    // loaded CI runner can stall >5 ms between the awaited retry (which sets
    // latchUntil = re-arm + 5 ms) and this assertion. beforeRetry is strictly
    // before the re-arm, so latched(beforeRetry) is true iff the retry
    // re-armed — deterministic on any runner.
    expect(googleDisabledClientLatched(beforeRetry)).toBe(true);
  });

  it('kill switch GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS=0 restores legacy behavior (every failure attempts + logs)', async () => {
    process.env.GOOGLE_REFRESH_DISABLED_CLIENT_LATCH_MS = '0';
    mockAxiosPost.mockRejectedValue(axiosReject('disabled_client', 401));

    await getValidToken('u1');
    await getValidToken('u1');
    expect(mockAxiosPost).toHaveBeenCalledTimes(2);
    expect(mockLoggerError).toHaveBeenCalledTimes(2);
    expect(googleDisabledClientLatched()).toBe(false);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('invalid_grant still deletes the dead grant row and does NOT engage the client latch (regression pin)', async () => {
    mockAxiosPost.mockRejectedValue(axiosReject('invalid_grant', 400));

    const tok = await getValidToken('u1');
    expect(tok).toBeNull();
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: 'row1' } });
    expect(googleDisabledClientLatched()).toBe(false);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('a healthy refresh updates the row and returns the token (happy path pin)', async () => {
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'new-tok', expires_in: 3600 } });

    const tok = await getValidToken('u1');
    expect(tok).toBe('new-tok');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(googleDisabledClientLatched()).toBe(false);
  });

  // ── (07c1d554) the fleet-wide EMISSION latch (Redis NX per userId) ──────────

  it('07c1d554: ONE error per user per fleet window — a SECOND process (fresh process-local latch) is suppressed, and the fleet key SURVIVES the emission that acquired it', async () => {
    mockAxiosPost.mockRejectedValue(axiosReject('unauthorized_client', 401));

    // Process 1: first arm acquires the Redis key and emits.
    await getValidToken('u1');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'google_refresh_latch' }));
    expect(redisStore.has('google:refresh-dead-client-warn:u1')).toBe(true);

    // Process 2 (the 2026-10-18 shape: another box/worker or a restart —
    // process-local latch reset): retries, arms its own latch, but the fleet
    // key is held → NO error row, and a suppressed-arm metric instead.
    __resetGoogleDisabledClientLatchForTests();
    const second = await getValidToken('u1');
    expect(second).toBeNull();
    expect(mockAxiosPost).toHaveBeenCalledTimes(2); // the retry still happened
    expect(mockLoggerError).toHaveBeenCalledTimes(1); // the emission did NOT
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'google_refresh_latch_suppressed' }));
    // (e1cca01d pin) the key must SURVIVE the very row that acquired it.
    expect(redisStore.has('google:refresh-dead-client-warn:u1')).toBe(true);
  });

  it('07c1d554: the per-user key is SCOPED — user u2 first arm still emits while u1 is suppressed', async () => {
    mockAxiosPost.mockRejectedValue(axiosReject('unauthorized_client', 401));

    await getValidToken('u1');
    __resetGoogleDisabledClientLatchForTests();
    mockFindFirst.mockResolvedValue({ ...EXPIRED_ROW, userId: 'u2' });

    await getValidToken('u2');
    expect(mockLoggerError).toHaveBeenCalledTimes(2); // one row PER USER
    expect(redisStore.has('google:refresh-dead-client-warn:u1')).toBe(true);
    expect(redisStore.has('google:refresh-dead-client-warn:u2')).toBe(true);
  });

  it('07c1d554: a healthy refresh releases a key this process holds — a later re-break warns at once, not at TTL', async () => {
    mockAxiosPost.mockRejectedValue(axiosReject('unauthorized_client', 401));
    await getValidToken('u1');
    expect(mockLoggerError).toHaveBeenCalledTimes(1);

    // The client is fixed: a healthy refresh must DEL the key (only if this
    // process holds it). The retry latch window is reset to simulate the
    // window having expired (the re-check that finds the client healthy).
    mockAxiosPost.mockResolvedValue({ data: { access_token: 'new-tok', expires_in: 3600 } });
    __resetGoogleDisabledClientLatchForTests();
    const tok = await getValidToken('u1');
    expect(tok).toBe('new-tok');
    expect(redisStore.has('google:refresh-dead-client-warn:u1')).toBe(false);

    // Re-break in the same process: warn again IMMEDIATELY (the 24 h TTL did
    // not silence the new break).
    mockAxiosPost.mockRejectedValue(axiosReject('unauthorized_client', 401));
    __resetGoogleDisabledClientLatchForTests();
    await getValidToken('u1');
    expect(mockLoggerError).toHaveBeenCalledTimes(2);
  });

  it('07c1d554: a healthy refresh in ANOTHER process does not release a key it does not hold (no cross-process DEL)', async () => {
    mockAxiosPost.mockRejectedValue(axiosReject('unauthorized_client', 401));
    await getValidToken('u1');
    // A different process acquires nothing (simulated by clearing the
    // held-set only — the Redis key space is untouched).
    __resetGoogleRefreshWarnLatchForTests();
    expect(redisStore.has('google:refresh-dead-client-warn:u1')).toBe(true);

    mockAxiosPost.mockResolvedValue({ data: { access_token: 'new-tok', expires_in: 3600 } });
    __resetGoogleDisabledClientLatchForTests();
    await getValidToken('u1');
    // Key not held by THIS process → NOT released (the TTL governs).
    expect(redisStore.has('google:refresh-dead-client-warn:u1')).toBe(true);
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('07c1d554: kill switch GOOGLE_REFRESH_LATCH_WARN_MS=0 → legacy every-arm emission (no fleet key)', async () => {
    process.env.GOOGLE_REFRESH_LATCH_WARN_MS = '0';
    mockAxiosPost.mockRejectedValue(axiosReject('unauthorized_client', 401));

    await getValidToken('u1');
    __resetGoogleDisabledClientLatchForTests();
    await getValidToken('u1');
    expect(mockLoggerError).toHaveBeenCalledTimes(2); // legacy: every arm emits
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'google_refresh_latch_suppressed' }));
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('07c1d554: a Redis error fails OPEN — the emission is never silenced by infra (e1cca01d doctrine)', async () => {
    const failedSet = async () => { throw new Error('redis down'); };
    redisSet.mockImplementationOnce(failedSet);
    mockAxiosPost.mockRejectedValue(axiosReject('unauthorized_client', 401));

    await getValidToken('u1');
    expect(mockLoggerError).toHaveBeenCalledTimes(1); // fail-open: emit anyway
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'google_refresh_latch' }));
  });
});
