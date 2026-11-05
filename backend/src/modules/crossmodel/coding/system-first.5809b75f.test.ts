/**
 * DURABLE system-first latch — ticket 5809b75f, 2026-10-29.
 *
 * THE MISHAP REPLAYED HERE: ticket 68167bbf (PR #2061, squash 60247b90) fixed
 * the coding-agent 400 retry storm, but its acceptance criterion 3 — ZERO new
 * `messages[2].role is system` rows in app_error_logs for 24h — was UNMET. The
 * +24h re-measure found 16 post-deploy rows, and every single one of them was
 *
 *   loop_metrics kind=system_first_replay
 *   meta={"spec":"llm-cql:tt-qwen3.8-flash-next","label":"llm-cql (custom endpoint)",
 *         "model":"tt-qwen3.8-flash-next","outcome":"rejected_latched","systemCount":2}
 *
 * with ZERO `lane:'message_order'` give-up rows. That pair is decisive: the
 * hoist REPAIRED every turn (the fix worked), but each process PAID one live
 * 400 to re-learn strictness a previous process already knew, because the
 * learned latch was an in-memory Set. With 93 successful deploy waves in 24h
 * (measured 2026-10-29), "once per process" was really "once per wave".
 *
 * Two properties are pinned here, and they are BOTH required for the metric:
 *
 *   A. DURABILITY — a FRESH process (in-memory latch empty) whose Redis still
 *      carries the seat sends the system-first shape on its FIRST post: the
 *      rejection is inherited, never re-bought. This is the actual fix.
 *   B. TAXONOMY — when a rejection IS paid (a brand-new seat, or a fleet with
 *      no Redis), the merge repaired the turn, so the row is a HANDLED
 *      outcome, not a warn: it must not reach app_error_logs. This is the same
 *      ruling the sanitizeMessages repair already carries (ticket 6d4cebff),
 *      and the message TEXT is unchanged so existing greps still match.
 *
 * Fail-open is pinned too: no Redis, or a Redis error, must leave behaviour
 * byte-identical to before this change (the process just pays once, as it
 * always did) — nothing here may fail or delay a turn.
 */
import { Readable } from 'stream';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import axios from 'axios';
import logger from '../../../utils/logger';
import { runModelTurn, __resetReasoningEffortLatchForTests, type ProviderConfig } from './coding-model';
import {
  __resetSystemFirstLatchForTests,
  __setSystemFirstRedisForTests,
  latchSystemFirst,
  systemFirstKey,
  systemFirstLatched,
} from './system-first';

const mockPost = (axios as any).post as jest.Mock;
const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock };

/** The production seat, verbatim from the incident telemetry. */
const TT_SEAT: ProviderConfig = {
  url: 'https://llm.cql.ca/v1/chat/completions',
  apiKey: 'sk-test',
  model: 'tt-qwen3.8-flash-next',
  spec: 'llm-cql:tt-qwen3.8-flash-next',
  label: 'llm-cql (custom endpoint)',
  extra: {},
  reasoningEffort: 'auto',
};
const SEAT_KEY = systemFirstKey(TT_SEAT);

/** The VERBATIM provider rejection from every one of the 16 post-deploy rows. */
const systemOrder400 = () => Object.assign(new Error('Request failed with status code 400'), {
  response: {
    status: 400,
    data: Readable.from([JSON.stringify({
      error: { message: 'litellm.BadRequestError: OpenAIException - messages[2].role is system; the system message must be firstNo fallback model group found' },
    })]),
  },
});

const okStream = () => ({
  data: Readable.from([
    'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]),
});

/** THE INCIDENT SHAPE, fingerprint-identical: system:53440 user:2407 system:265. */
const incidentMessages = () => [
  { role: 'system', content: 'D'.repeat(53_440) },
  { role: 'user', content: 'U'.repeat(2_407) },
  { role: 'system', content: '[HARNESS CLOCK — not typed by the user] ' + 'C'.repeat(265 - 42) },
];

const rolesOf = (payload: any): string[] => (payload?.messages ?? []).map((m: any) => m.role);

/** A fake redis exposing only what the latch uses. `members` = what another
 *  process already learned; writes are recorded so the mirror is assertable. */
function fakeRedis(members: string[] = [], opts: { failRead?: boolean; failWrite?: boolean } = {}) {
  const state = { members: new Set(members), added: [] as Array<[string, string]>, expired: [] as Array<[string, number]> };
  return {
    state,
    sMembers: jest.fn(async () => {
      if (opts.failRead) throw new Error('redis down (read)');
      return Array.from(state.members);
    }),
    sAdd: jest.fn(async (k: string, m: string) => {
      if (opts.failWrite) throw new Error('redis down (write)');
      state.members.add(m);
      state.added.push([k, m]);
      return 1;
    }),
    expire: jest.fn(async (k: string, ttl: number) => { state.expired.push([k, ttl]); return 1; }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetSystemFirstLatchForTests();
  __setSystemFirstRedisForTests(null); // default: no redis (the jest-safe path)
  __resetReasoningEffortLatchForTests();
  delete process.env.SYSTEM_FIRST_NORMALIZE_DISABLED;
});
afterEach(() => {
  __setSystemFirstRedisForTests(undefined); // restore the real accessor
  __resetSystemFirstLatchForTests();
  delete process.env.SYSTEM_FIRST_NORMALIZE_DISABLED;
});

describe('5809b75f (A) DURABILITY — a restarted process inherits the strictness instead of re-buying the 400', () => {
  it('REPLAY: fresh process + Redis already holds the seat ⇒ ONE post, already system-first, ZERO rejections paid', async () => {
    // A previous process learned this seat; the durable SET survived the deploy.
    __setSystemFirstRedisForTests(fakeRedis([SEAT_KEY]));

    mockPost.mockResolvedValueOnce(okStream());
    const turn = await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});

    // The turn succeeds on its FIRST post — no 400, no corrective retry. This
    // is the exact row the ticket counted 16 of per 24h: it cannot be produced.
    expect(turn.content).toBe('OK');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(rolesOf(mockPost.mock.calls[0][1])).toEqual(['system', 'user']);

    // No `rejected_latched` telemetry, because nothing was rejected.
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).some((m) => m?.kind === 'system_first_replay')).toBe(false);
    // And no warn row for a rejection that never happened.
    expect(mockLogger.warn.mock.calls.some((c) => String(c[0]).includes('requires system-first'))).toBe(false);
  });

  it('the redistribution is PER SEAT: an inherited latch never leaks to another model on the same endpoint', async () => {
    __setSystemFirstRedisForTests(fakeRedis([SEAT_KEY]));
    const other: ProviderConfig = { ...TT_SEAT, model: 'tt-qwen3.8-27b', spec: 'llm-cql:tt-qwen3.8-27b' };

    mockPost.mockResolvedValueOnce(okStream());
    await runModelTurn(other, incidentMessages(), undefined, {});

    // Un-normalized: the per-turn clock note is still where the loop put it.
    expect(rolesOf(mockPost.mock.calls[0][1])).toEqual(['system', 'user', 'system']);
  });

  it('a paid rejection MIRRORS the seat to Redis (sAdd + TTL) so the next process inherits it', async () => {
    const redis = fakeRedis([]);
    __setSystemFirstRedisForTests(redis);

    mockPost.mockRejectedValueOnce(systemOrder400()).mockResolvedValueOnce(okStream());
    await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});

    expect(systemFirstLatched(TT_SEAT)).toBe(true);
    // The write is fire-and-forget — let its microtasks settle.
    await new Promise((r) => setImmediate(r));
    expect(redis.state.added).toContainEqual(['cm:system-first:strict', SEAT_KEY]);
    expect(redis.state.expired.map(([k]) => k)).toContain('cm:system-first:strict');
    // TTL must outlive a deploy wave, not expire between them.
    expect(redis.state.expired.find(([k]) => k === 'cm:system-first:strict')![1]).toBeGreaterThanOrEqual(24 * 60 * 60);
  });

  it('review N1: a BUILT-IN provider latches in memory but is NOT mirrored to Redis (no fleet-wide blast radius)', async () => {
    const redis = fakeRedis([]);
    __setSystemFirstRedisForTests(redis);
    // A frontier built-in seat — hoisting a per-turn clock note into its leading
    // system block would destroy Moonshot prefix caching, so a mis-fired 400
    // must die with the process, never persist fleet-wide for 90 days.
    const builtIn = { url: 'https://api.moonshot.ai/v1/chat/completions', model: 'kimi-k3', label: 'Moonshot' };

    expect(latchSystemFirst(builtIn)).toBe(true);
    await new Promise((r) => setImmediate(r));

    expect(systemFirstLatched(builtIn)).toBe(true); // still latched for THIS process
    expect(redis.state.added).toEqual([]); // …but never mirrored

    // And the custom-endpoint seat IS mirrored — the contrast is the whole point.
    expect(latchSystemFirst(TT_SEAT)).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(redis.state.added).toContainEqual(['cm:system-first:strict', SEAT_KEY]);
  });
});

describe('5809b75f (B) TAXONOMY — a repaired turn is a HANDLED outcome, so it never reaches app_error_logs', () => {
  it('the paid rejection is logged as handled (info), NOT as a warn row — message text unchanged', async () => {
    mockPost.mockRejectedValueOnce(systemOrder400()).mockResolvedValueOnce(okStream());
    const turn = await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});

    expect(turn.content).toBe('OK'); // the repair worked
    // No warn ⇒ the warn+ Prisma transport never persists an app_error_logs row
    // for a turn that succeeded. (Winston's Prisma transport is warn+.)
    expect(mockLogger.warn.mock.calls.some((c) => String(c[0]).includes('requires system-first'))).toBe(false);
    // …but the event is still observable, at info, tagged handled, with the
    // SAME text so existing greps/audit pins keep matching.
    const handled = mockLogger.info.mock.calls.find((c) => String(c[0]).includes('requires system-first'));
    expect(handled).toBeDefined();
    expect(String(handled![0])).toContain('tt-qwen3.8-flash-next');
    expect(String(handled![0])).toContain('messages[2].role is system');
    expect((handled![1] as any)?.logClass).toBe('handled');
  });

  it('the GIVE-UP path is untouched: a second order-400 still surfaces (agent.ts message_order owns it)', async () => {
    mockPost.mockRejectedValueOnce(systemOrder400()).mockRejectedValueOnce(systemOrder400());

    await expect(runModelTurn(TT_SEAT, incidentMessages(), undefined, {})).rejects.toMatchObject({
      response: { status: 400 },
    });
    expect(mockPost).toHaveBeenCalledTimes(2); // bounded: one heal, then give up
  });
});

describe('5809b75f fail-open — the durable layer can never fail or delay a turn', () => {
  it('NO redis: behaviour is byte-identical to before this change (pay once, repair, continue)', async () => {
    __setSystemFirstRedisForTests(null);
    mockPost.mockRejectedValueOnce(systemOrder400()).mockResolvedValueOnce(okStream());

    const turn = await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});

    expect(turn.content).toBe('OK');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(rolesOf(mockPost.mock.calls[1][1])).toEqual(['system', 'user']);
    expect(systemFirstLatched(TT_SEAT)).toBe(true); // in-memory latch still holds
  });

  it('a Redis READ error still lets the turn run (and is not memoized as a permanent miss)', async () => {
    const redis = fakeRedis([SEAT_KEY], { failRead: true });
    __setSystemFirstRedisForTests(redis);
    mockPost.mockRejectedValueOnce(systemOrder400()).mockResolvedValueOnce(okStream());

    const turn = await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});
    expect(turn.content).toBe('OK');
    expect(mockPost).toHaveBeenCalledTimes(2); // fail-open: it paid, as before
  });

  it('a Redis WRITE error never breaks the turn', async () => {
    __setSystemFirstRedisForTests(fakeRedis([], { failWrite: true }));
    mockPost.mockRejectedValueOnce(systemOrder400()).mockResolvedValueOnce(okStream());

    const turn = await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});
    await new Promise((r) => setImmediate(r)); // let the failing mirror settle

    expect(turn.content).toBe('OK');
    expect(systemFirstLatched(TT_SEAT)).toBe(true); // in-memory latch survives a dead mirror
  });

  it('SYSTEM_FIRST_NORMALIZE_DISABLED=1 stays a TRUE revert: no hydration-driven merge, no heal', async () => {
    const redis = fakeRedis([SEAT_KEY]);
    __setSystemFirstRedisForTests(redis);
    process.env.SYSTEM_FIRST_NORMALIZE_DISABLED = '1';

    mockPost.mockResolvedValueOnce(okStream());
    await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});

    // The operator's kill switch must win over the durable latch.
    expect(rolesOf(mockPost.mock.calls[0][1])).toEqual(['system', 'user', 'system']);
    expect(redis.sMembers).not.toHaveBeenCalled();
  });
});

describe('5809b75f hydration robustness — a MISSED hydration must never become permanent (review B1, PR #2099)', () => {
  it('a HANGING redis read times out, then a LATER turn retries and inherits the latch', async () => {
    // node-redis QUEUES commands while its socket is down, so a read issued
    // during a reconnect never settles — it loses the 750 ms race and, crucially,
    // resolves `undefined` WITHOUT throwing. Memoizing that empty result would
    // leave the process permanently pre-fix (the very bug this ticket fixes).
    let hang = true;
    const redis = {
      sMembers: jest.fn(async () => {
        if (hang) return new Promise<string[]>(() => { /* never settles */ });
        return [SEAT_KEY];
      }),
      sAdd: jest.fn(async () => 1),
      expire: jest.fn(async () => 1),
    };
    __setSystemFirstRedisForTests(redis);

    // Turn 1: the read hangs. The turn still runs (fail-open, pays as before).
    mockPost.mockRejectedValueOnce(systemOrder400()).mockResolvedValueOnce(okStream());
    expect((await runModelTurn(TT_SEAT, incidentMessages(), undefined, {})).content).toBe('OK');
    expect(redis.sMembers).toHaveBeenCalledTimes(1);

    // Turn 2 — Redis healthy now. The memo must have been CLEARED by the
    // timeout, so this turn re-reads and inherits: no rejection is paid.
    hang = false;
    __resetSystemFirstLatchForTests(); // simulate the process still not knowing the seat
    mockPost.mockClear();
    mockPost.mockResolvedValueOnce(okStream());
    expect((await runModelTurn(TT_SEAT, incidentMessages(), undefined, {})).content).toBe('OK');
    expect(redis.sMembers).toHaveBeenCalledTimes(2); // ← retried, not memoized
    expect(mockPost).toHaveBeenCalledTimes(1); // and it was already system-first
    expect(rolesOf(mockPost.mock.calls[0][1])).toEqual(['system', 'user']);
  }, 20_000);

  it('the REAL client specifier resolves — a wrong ./.. path would fail open in prod while tests pass', () => {
    // The suite always injects the seam, which short-circuits before the real
    // `require`. Pin the specifier itself: these files live in the same
    // directory as system-first.ts, so this resolves identically.
    expect(() => require.resolve('../../../config/redis')).not.toThrow();
  });

  it('REDIS_URL absent ⇒ the module is never required at all (env.ts would process.exit, uncatchably)', async () => {
    const saved = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    __resetSystemFirstLatchForTests();
    __setSystemFirstRedisForTests(undefined); // real accessor: JEST_WORKER_ID makes it null
    try {
      mockPost.mockResolvedValueOnce(okStream());
      const turn = await runModelTurn(TT_SEAT, incidentMessages(), undefined, {});
      expect(turn.content).toBe('OK'); // the turn is never blocked by a missing Redis
    } finally {
      if (saved === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = saved;
    }
  });
});