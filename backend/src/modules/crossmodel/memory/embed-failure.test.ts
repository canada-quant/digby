/**
 * embed-failure.ts — the unified-memory embed failure leaf (telemetry-noise
 * audit PE-13: 27 "Request failed with status code 400" rows / 7 d with the
 * provider body hidden, and one rejected input de-embedding a whole batch).
 */
import {
  describeEmbedFailure, embedFailureKey, embedFailureRetryable, embedRowRetryMax,
  embedRowsWithRetry, EMBED_ROW_RETRY_MAX_DEFAULT,
  parseRetryAfterSec, embedFailureRateLimited, embed429BackoffMs, embed429RetryDisabled,
  embed429RetryAttempts, embed429RetryAttempts as _embed429RetryAttempts, EMBED_429_BACKOFF_BASE_MS,
  EMBED_429_BACKOFF_MAX_MS, EMBED_429_RETRY_AFTER_HONOUR_MAX_MS, embedTestHooks,
} from './embed-failure';

const http = (status: number, data: unknown, message = `Request failed with status code ${status}`, headers?: Record<string, string>) =>
  Object.assign(new Error(message), { response: { status, data, ...(headers ? { headers } : {}) } });

describe('describeEmbedFailure — names the cause axios hides', () => {
  it('reads the DashScope compatible-mode body {error:{message,type,code}}', () => {
    const c = describeEmbedFailure(http(400, { error: { message: 'Range of input length should be [1, 8192]', type: 'invalid_request_error', code: 'invalid_parameter_error' } }));
    expect(c).toMatchObject({ kind: 'http_4xx', status: 400, code: 'invalid_parameter_error' });
    expect(c.providerMessage).toContain('Range of input length');
    expect(c.message).toBe('Request failed with status code 400');
  });

  it('reads the native DashScope body {code,message,request_id}', () => {
    const c = describeEmbedFailure(http(400, { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.', request_id: 'r1' }));
    expect(c).toMatchObject({ kind: 'http_4xx', status: 400, code: 'DataInspectionFailed' });
    expect(c.providerMessage).toContain('inappropriate content');
  });

  it('bounds the provider message and never throws on odd shapes', () => {
    const c = describeEmbedFailure(http(500, { error: { message: 'x'.repeat(1000) } }));
    expect(c.kind).toBe('http_5xx');
    expect(c.providerMessage!.length).toBe(200);
    expect(describeEmbedFailure(null).kind).toBe('unknown');
    expect(describeEmbedFailure({ message: 'timeout of 30000ms exceeded', code: 'ECONNABORTED' }).kind).toBe('timeout');
    expect(describeEmbedFailure({ message: 'aborted', name: 'CanceledError' }).kind).toBe('aborted');
    expect(describeEmbedFailure({ message: 'connect ECONNREFUSED 1.2.3.4:443', code: 'ECONNREFUSED' }).kind).toBe('network');
  });

  it('the once-per-process key is kind + status + provider code', () => {
    expect(embedFailureKey(describeEmbedFailure(http(400, { code: 'DataInspectionFailed', message: 'm' })))).toBe('http_4xx:400:DataInspectionFailed');
    expect(embedFailureKey(describeEmbedFailure({ message: 'timeout of 1ms exceeded' }))).toBe('timeout:-:-');
  });
});

describe('embedFailureRetryable — only a provider REJECTION earns a per-row retry', () => {
  it.each([[400, true], [413, true], [422, true], [401, false], [403, false], [429, false], [500, false], [503, false]])('HTTP %s → %s', (status, expected) => {
    expect(embedFailureRetryable(describeEmbedFailure(http(status, {})))).toBe(expected);
  });
  it('timeouts / network faults are not retried row by row', () => {
    expect(embedFailureRetryable(describeEmbedFailure({ message: 'timeout of 30000ms exceeded' }))).toBe(false);
    expect(embedFailureRetryable(describeEmbedFailure({ message: 'socket hang up' }))).toBe(false);
  });
});

describe('embedRowRetryMax', () => {
  it('defaults and honours the env', () => {
    expect(embedRowRetryMax({})).toBe(EMBED_ROW_RETRY_MAX_DEFAULT);
    expect(embedRowRetryMax({ UNIFIED_MEMORY_EMBED_ROW_RETRY_MAX: '5' })).toBe(5);
    expect(embedRowRetryMax({ UNIFIED_MEMORY_EMBED_ROW_RETRY_MAX: 'nope' })).toBe(EMBED_ROW_RETRY_MAX_DEFAULT);
  });
});

describe('embedRowsWithRetry', () => {
  const vec = (n: number) => [n, n, n];

  it('a successful batch passes through untouched (no retry, no cause)', async () => {
    const embed = jest.fn(async (b: string[]) => b.map((_, i) => vec(i)));
    const r = await embedRowsWithRetry(['a', 'b'], embed, { retryMax: 20 });
    expect(r.cause).toBeNull();
    expect(r.embeddings).toEqual([vec(0), vec(1)]);
    expect(r.retried).toEqual({ attempted: 0, recovered: 0 });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('a rejected batch is re-embedded row by row — the good rows keep their vectors, the bad row stays null', async () => {
    const embed = jest.fn(async (b: string[]) => {
      if (b.includes('BAD')) throw http(400, { code: 'DataInspectionFailed', message: 'inappropriate content' });
      return b.map(() => vec(1));
    });
    const r = await embedRowsWithRetry(['ok1', 'BAD', 'ok2'], embed, { retryMax: 20 });
    expect(r.cause).toMatchObject({ kind: 'http_4xx', status: 400, code: 'DataInspectionFailed' });
    expect(r.embeddings).toEqual([vec(1), null, vec(1)]);
    expect(r.retried).toEqual({ attempted: 3, recovered: 2 });
    expect(r.rowCauses).toHaveLength(1);
    expect(embed).toHaveBeenCalledTimes(4); // 1 batch + 3 rows
  });

  it('retryMax bounds the per-row calls; a single-row batch and a non-retryable cause are never retried', async () => {
    const reject400 = jest.fn(async () => { throw http(400, {}); });
    const r1 = await embedRowsWithRetry(['a', 'b', 'c', 'd'], reject400, { retryMax: 2 });
    expect(r1.retried.attempted).toBe(2);
    expect(reject400).toHaveBeenCalledTimes(3);
    const r2 = await embedRowsWithRetry(['solo'], reject400, { retryMax: 20 });
    expect(r2.retried.attempted).toBe(0);
    const reject500 = jest.fn(async () => { throw http(503, {}); });
    const r3 = await embedRowsWithRetry(['a', 'b'], reject500, { retryMax: 20 });
    expect(r3.retried.attempted).toBe(0);
    expect(r3.embeddings).toEqual([null, null]);
    const r4 = await embedRowsWithRetry(['a', 'b'], reject400, { retryMax: 0 });
    expect(r4.retried.attempted).toBe(0);
  });

  it('never throws and answers null rows for an empty / malformed provider answer', async () => {
    const r = await embedRowsWithRetry(['a', 'b'], jest.fn(async () => [[] as number[], undefined as any]), { retryMax: 20 });
    expect(r.embeddings).toEqual([null, null]);
    expect(await embedRowsWithRetry([], jest.fn(), { retryMax: 20 })).toMatchObject({ embeddings: [], cause: null });
  });
});

// ── 429-aware backoff (ticket d7bf73c2) ───────────────────────────────────────
// Box C, 2026-10-16: "unified-memory: embed failed, 0/7 row(s) stored
// keyword-only — http_4xx … Too many requests … throttled" — a DashScope 429
// dropped the WHOLE store keyword-only with zero retries.

describe('parseRetryAfterSec', () => {
  it('reads delta-seconds, decimal seconds, and HTTP-dates', () => {
    expect(parseRetryAfterSec('5')).toBe(5);
    expect(parseRetryAfterSec(' 2.4 ')).toBe(3);
    const now = new Date('2026-10-17T00:00:00Z');
    expect(parseRetryAfterSec('Fri, 17 Oct 2026 00:00:30 GMT', now)).toBe(30);
  });
  it('caps a hostile/misconfigured header and rejects garbage/past dates', () => {
    expect(parseRetryAfterSec('3600')).toBe(120);
    expect(parseRetryAfterSec('soon')).toBeNull();
    expect(parseRetryAfterSec('')).toBeNull();
    expect(parseRetryAfterSec(undefined)).toBeNull();
    expect(parseRetryAfterSec(-1 as any)).toBeNull();
    const past = new Date('2026-10-17T00:00:00Z');
    expect(parseRetryAfterSec('Fri, 16 Oct 2026 23:59:00 GMT', past)).toBeNull();
  });
  it('describeEmbedFailure surfaces retryAfterSec from the axios header (both casings)', () => {
    expect(describeEmbedFailure(http(429, { code: 'Throttling', message: 'Too many requests' }, 'Request failed with status code 429', { 'retry-after': '3' })).retryAfterSec).toBe(3);
    expect(describeEmbedFailure(http(429, {}, 'msg', { 'Retry-After': '7' })).retryAfterSec).toBe(7);
    expect(describeEmbedFailure(http(429, {})).retryAfterSec).toBeNull();
  });
});

describe('embedFailureRateLimited / embed429BackoffMs', () => {
  it('only a 429 is a rate limit; the backoff honours Retry-After within budget, else exponential', () => {
    expect(embedFailureRateLimited(describeEmbedFailure(http(429, { message: 'Too many requests' })))).toBe(true);
    expect(embedFailureRateLimited(describeEmbedFailure(http(400, {})))).toBe(false);
    expect(embedFailureRateLimited(describeEmbedFailure(http(503, {})))).toBe(false);
    expect(embedFailureRateLimited(describeEmbedFailure({ message: 'timeout of 1ms exceeded' }))).toBe(false);

    const noHeader = describeEmbedFailure(http(429, {}));
    expect(embed429BackoffMs(noHeader, 0)).toBe(EMBED_429_BACKOFF_BASE_MS);
    expect(embed429BackoffMs(noHeader, 1)).toBe(1500);
    expect(embed429BackoffMs(noHeader, 5)).toBe(EMBED_429_BACKOFF_MAX_MS);
    const withHeader = describeEmbedFailure(http(429, {}, 'm', { 'retry-after': '4' }));
    expect(embed429BackoffMs(withHeader, 0)).toBe(4000);
    // A Retry-After LONGER than the honour cap means the window outlives the
    // in-call budget: -1 = do not retry in-call, the backfill cron owns the rows.
    const tooLong = describeEmbedFailure(http(429, {}, 'm', { 'retry-after': '60' }));
    expect(embed429BackoffMs(tooLong, 0)).toBe(-1);
  });
  it('the env knob caps the attempts; the kill switch reads the env', () => {
    expect(embed429RetryAttempts({})).toBe(2);
    expect(embed429RetryAttempts({ UNIFIED_MEMORY_EMBED_429_RETRIES: '0' })).toBe(0);
    expect(embed429RetryAttempts({ UNIFIED_MEMORY_EMBED_429_RETRIES: 'nope' })).toBe(2);
    expect(embed429RetryDisabled({})).toBe(false);
    expect(embed429RetryDisabled({ UNIFIED_MEMORY_EMBED_429_RETRY_DISABLED: '1' })).toBe(true);
  });
});

describe('embedRowsWithRetry — the 429 class (ticket d7bf73c2)', () => {
  const vec = (n: number) => [n, n, n];
  let sleeps: number[] = [];
  beforeAll(() => { embedTestHooks.sleep = async (ms) => { sleeps.push(ms); }; });
  afterAll(() => { delete embedTestHooks.sleep; });
  beforeEach(() => { sleeps = []; });

  it('a throttled batch retries the WHOLE batch after a backoff and recovers every row — no keyword-only store', async () => {
    let calls = 0;
    const embed = jest.fn(async (b: string[]) => {
      calls++;
      if (calls === 1) throw http(429, { code: 'Throttling', message: 'Too many requests' }, 'Request failed with status code 429', { 'retry-after': '1' });
      return b.map((_, i) => vec(i));
    });
    const r = await embedRowsWithRetry(['a', 'b', 'c'], embed, { retryMax: 20 });
    expect(r.embeddings).toEqual([vec(0), vec(1), vec(2)]);
    expect(r.cause).toBeNull(); // a RECOVERED throttle is not a failure — no false "keyword-only" report
    expect(r.rateLimitRetries).toEqual({ attempted: 1, recovered: 3, waitedMs: 1000 });
    expect(embed).toHaveBeenCalledTimes(2); // the whole batch rode ONE retry — 2 calls, not 1 + N
    expect(sleeps).toEqual([1000]);
  });

  it('without Retry-After the backoff is exponential (750ms → 1500ms) and bounded attempts; exhaustion keeps the cause for the report', async () => {
    const embed = jest.fn(async () => { throw http(429, { code: 'Throttling', message: 'Too many requests' }); });
    const r = await embedRowsWithRetry(['a', 'b'], embed, { retryMax: 20 });
    expect(embed).toHaveBeenCalledTimes(3); // 1 + 2 retries (default attempts)
    expect(sleeps).toEqual([750, 1500]);
    expect(r.cause).toMatchObject({ kind: 'http_4xx', status: 429, code: 'Throttling' });
    expect(r.embeddings).toEqual([null, null]);
    expect(r.rateLimitRetries).toEqual({ attempted: 2, recovered: 0, waitedMs: 2250 });
    expect(embedFailureRetryable(r.cause!)).toBe(false); // …and no per-row burn on top
    expect(r.retried.attempted).toBe(0);
  });

  it('a Retry-After longer than the in-call budget skips the in-call retry entirely (the backfill cron owns the rows)', async () => {
    const embed = jest.fn(async () => { throw http(429, {}, 'm', { 'retry-after': '60' }); });
    const r = await embedRowsWithRetry(['a', 'b'], embed, { retryMax: 20 });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(r.embeddings).toEqual([null, null]);
    expect(r.rateLimitRetries).toEqual({ attempted: 0, recovered: 0, waitedMs: 0 });
  });

  it('rateLimitRetries=0 (kill switch) keeps the OLD behaviour: 429 → all-null, one call', async () => {
    const embed = jest.fn(async () => { throw http(429, { message: 'Too many requests' }); });
    const r = await embedRowsWithRetry(['a', 'b'], embed, { retryMax: 20, rateLimitRetries: 0 });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(r.embeddings).toEqual([null, null]);
    expect(sleeps).toEqual([]);
  });

  it('a recovered batch still reports row-nulls when the provider answer is malformed (rateLimitRetries counts the wait)', async () => {
    let calls = 0;
    const embed = jest.fn(async (b: string[]) => {
      calls++;
      if (calls === 1) throw http(429, {}, 'm', { 'retry-after': '2' });
      return b.map(() => null as any);
    });
    const r = await embedRowsWithRetry(['a', 'b'], embed, { retryMax: 20 });
    expect(r.embeddings).toEqual([null, null]);
    expect(r.cause).toBeNull(); // the call SUCCEEDED; the rows are null because the provider returned nothing
    expect(r.rateLimitRetries).toEqual({ attempted: 1, recovered: 0, waitedMs: 2000 });
  });

  it('recovered counts rows recovered BY a retry — an unthrottled first-call success reports 0 (adversarial review round-2, follow-up 1)', async () => {
    const embed = jest.fn(async (b: string[]) => b.map((_, i) => vec(i)));
    const r = await embedRowsWithRetry(['a', 'b'], embed, { retryMax: 20 });
    expect(r.rateLimitRetries).toEqual({ attempted: 0, recovered: 0, waitedMs: 0 });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('the Retry-After honour cap is the boundary: at the cap it is honoured, past it the cron owns the rows', async () => {
    // '10' = EMBED_429_RETRY_AFTER_HONOUR_MAX_MS exactly → honoured (one retry, recovered).
    let calls = 0;
    const embed = jest.fn(async (b: string[]) => {
      calls++;
      if (calls === 1) throw http(429, {}, 'm', { 'retry-after': String(EMBED_429_RETRY_AFTER_HONOUR_MAX_MS / 1000) });
      return b.map((_, i) => vec(i));
    });
    const r = await embedRowsWithRetry(['a'], embed, { retryMax: 20 });
    expect(r.rateLimitRetries).toEqual({ attempted: 1, recovered: 1, waitedMs: EMBED_429_RETRY_AFTER_HONOUR_MAX_MS });
    expect(sleeps).toEqual([EMBED_429_RETRY_AFTER_HONOUR_MAX_MS]);
    // One second past the cap → no in-call retry at all.
    const embed2 = jest.fn(async () => { throw http(429, {}, 'm', { 'retry-after': String(EMBED_429_RETRY_AFTER_HONOUR_MAX_MS / 1000 + 1) }); });
    const r2 = await embedRowsWithRetry(['a'], embed2, { retryMax: 20 });
    expect(embed2).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([EMBED_429_RETRY_AFTER_HONOUR_MAX_MS]); // unchanged — the second scenario never slept
    expect(r2.rateLimitRetries).toEqual({ attempted: 0, recovered: 0, waitedMs: 0 });
  });

  it('the 10 s budget is CUMULATIVE, not per-wait (adversarial review round-2, follow-up 3): two Retry-After: 6 answers make ONE retry, not a 12 s stall', async () => {
    const embed = jest.fn(async () => { throw http(429, {}, 'm', { 'retry-after': '6' }); });
    const r = await embedRowsWithRetry(['a', 'b'], embed, { retryMax: 20 });
    // First wait 6 s fits the budget; a second 6 s (12 s cumulative) does not —
    // break out and leave the rows to the backfill cron.
    expect(embed).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([6000]);
    expect(r.rateLimitRetries).toEqual({ attempted: 1, recovered: 0, waitedMs: 6000 });
    expect(r.cause).toMatchObject({ status: 429 });
  });
});
