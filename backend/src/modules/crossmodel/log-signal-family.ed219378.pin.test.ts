/**
 * Characterization pins — log-signal family, lead ticket a6f59654
 * (2026-11-05, lane ed219378). Four sweep auto-filings, adjudicated PER MEMBER
 * against live app_error_logs rows read THIS run (get_fleet_telemetry view
 * 'errors', 24 h) rather than against the ticket text.
 *
 * NONE is a standalone defect of its own emit site: every one is DESIGNED
 * observability — the warn IS the record that a condition the platform must not
 * absorb silently actually happened. Each is pinned here so a future "helpful"
 * silencing (or a fingerprint drift) has to argue with a replay.
 *
 *  1. a6f59654  verify.service.ts:663 — "stage typecheck died environmentally
 *     … one memory-gated retry after backoff". The rule-2 hit is NOT a broken
 *     suppression promise: the phrase describes ONE in-chain retry (the `backoff`
 *     token is that retry's wait, not a suppression window). The promise is
 *     honoured BY CONSTRUCTION — the attempt loop runs at most twice and the
 *     warn is emitted only for attempt 0, so one chain instance yields exactly
 *     TWO leg executions and exactly ONE warn. Live check (13 rows / 24 h): the
 *     rows land on the hourly lane cadence (:29–:30 past the hour), i.e. one row
 *     per chain instance, never a retry storm. Silencing it would blind the
 *     fleet to the exact class this sweep exists for: a stage that never got to
 *     render a verdict.
 *
 *  2. f73871a7  brightdata-direct.ts:548 — a BrightData direct-tier timeout. The
 *     emit is a bounded FAILOVER record: our own timeout (ECONNABORTED) is NEVER
 *     retried by isRetryableBdError (a slow target is not a transient), the
 *     attempt leaves tryDirectBrightData returning null (never throwing), and the
 *     request falls through to the gateway tier. Live check (42 rows / 24 h
 *     across 10+ hours): one warn per degraded scrape, real vendor degradation —
 *     sibling shape already replay-pinned by 30dfad06.
 *
 *  3. 29be3a9d  verify.service.ts:663 — the same emit site as (1), the `test`
 *     stage instead of `typecheck`. SAME root-cause adjudication; pinned
 *     separately so its own fingerprint cannot drift.
 *
 *  4. 9054c318  verify.service.ts:559 — the per-session background allowance
 *     (ff262da5). The warn is the enforcement record for "this session's OWN
 *     daemons hold more RSS than the allowance, so a cold chain would compete
 *     with them": the chain does not run, the verdict is unverified (never a
 *     false green), and one loop_metrics row is minted. Attribution is verified
 *     below to be PER SESSION (worktree cwd / DIGBY_ENV), so a lane is never
 *     charged for a peer's daemons — the live rows (20 / 24 h, 9 distinct
 *     sessions) are that many genuine conditions, not one misattributed one.
 *
 * FINGERPRINT BINDING: every prod example row is replayed through the SHIPPED
 * normalizer and must reproduce its ticket's fingerprint, so the four filings
 * provably describe these four emit sites.
 *
 * CLOSE NOTE: all four are METRIC-CARRYING auto-filer rows whose class is
 * designed, so each closes replayTestPath-ONLY with false-positive vocabulary —
 * attaching a commit sha would arm the post-deploy verifier against an
 * unattainable <=2/24h bar for a class that is live by design.
 */

const mockAxiosPost = jest.fn();

jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockAxiosPost(...a) } }));

const mockRedis: any = {
  get: jest.fn(async (): Promise<string | null> => null),
  set: jest.fn(async (): Promise<string | null> => 'OK'),
  setEx: jest.fn(async () => 'OK'),
  del: jest.fn(async () => 1),
  incr: jest.fn(async () => 1),
  expire: jest.fn(async () => 1),
};
jest.mock('../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  userMemory: { findUnique: jest.fn(async () => null) },
  userMemoryFact: { findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []) },
  feedbackTicket: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  // `log` is required by logExternal (utils/log-level.ts), which now emits the
  // BrightData direct-tier terminal failure (family lane 30dfad06, 2026-11-06).
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

// verify.service reaches loop-metrics via DYNAMIC import (env-free-leaf
// convention) — jest still resolves it, dragging config/database → config/env
// into this suite, so it is mocked exactly as the sibling verify suites do.
const mockRecordLoopMetric = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    VERIFY_PRESSURE_DEFERRED: 'verify_pressure_deferred',
    VERIFY_ENV_RED: 'verify_env_red',
    VERIFY_STAGE_TIMEOUT: 'verify_stage_timeout',
    LOG_SIGNAL_SWEEP: 'log_signal_sweep',
    SUGGESTED_QUESTIONS_QUALITY: 'suggested_questions_quality',
  },
}));

import { normalizeLogMessage } from './fleet/log-signal-sweep.service';
import { runVerifyChain, type VerifyChainEntry } from './coding/verify.service';
import { SESSION_BG_MARKER } from './coding/session-bg';

const logger = require('../../utils/logger').default;

// ── The four prod example rows, verbatim from their tickets ──────────────────

const ROW_a6f59654 =
  'verify: stage typecheck died environmentally (exit 1, output) — one memory-gated retry after backoff';

const ROW_f73871a7 =
  'BrightData direct: scrape_as_markdown failed:  timeout of 60000ms exceeded';

const ROW_29be3a9d =
  'verify: stage test died environmentally (exit 1, output) — one memory-gated retry after backoff';

const ROW_9054c318 =
  'verify: ENV-STARVED — session d16f83a3-a5b2-4de1-ab87-982ad787becc background allowance exceeded: ' +
  '4 attributed process(es) hold 2605 MB RSS > 2048 MB (run-end reap / idle sweep own this class; ff262da5)';

describe('ed219378 family — fingerprint binding (each ticket IS its emit site)', () => {
  it.each([
    ['a6f59654', ROW_a6f59654, 'verify: stage typecheck died environmentally (exit <n>, output)'],
    ['f73871a7', ROW_f73871a7, 'brightdata direct: scrape_as_markdown failed:'],
    ['29be3a9d', ROW_29be3a9d, 'verify: stage test died environmentally (exit <n>, output)'],
    ['9054c318', ROW_9054c318, 'verify: env-starved — session <uuid> background allowance exceeded:'],
  ])('%s normalizes to the fingerprint its ticket title carries', (_id, raw, expectPrefix) => {
    const fp = normalizeLogMessage(raw);
    expect(fp.startsWith(expectPrefix)).toBe(true);
    // Every volatile field is normalized out: a session uuid must never split
    // one class into many filings.
    expect(fp).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(fp).not.toContain('d16f83a3');
  });

  it('the two verify env-death rows differ ONLY by stage key (one emit site, two fingerprints)', () => {
    const a = normalizeLogMessage(ROW_a6f59654);
    const b = normalizeLogMessage(ROW_29be3a9d);
    expect(a.replace('typecheck', '<stage>')).toBe(b.replace('test', '<stage>'));
  });
});

// ── The verify.service harness ───────────────────────────────────────────────
//
// runVerifyChain drives the worktree shell for FOUR distinct purposes in one
// call: the reap+preamble probe, the optional session-bg scan, the related-tests
// git read (test stage only), and the chain legs themselves. A sequential
// mockResolvedValueOnce queue is therefore wrong — the git read would swallow a
// leg answer. Route on the command text instead, and keep a counter for the
// legs so a retry can see a different outcome from its first attempt.

const cg = (currentKb: number, maxKb: number, inactiveKb: number) =>
  `__CG__ ${currentKb} ${maxKb} ${inactiveKb}\n__MEM__ 999999 2000000\n__OOM__ 0`;
const bgRow = (sid: string, rssKb: number) => `__BG__ 123 1001 123 ${rssKb} 4321 0 ${sid} node server.js`;
const out = (text: string, code: number) => ({ stdout: `${text}\n__DIGBY_EXIT__ ${code}`, stderr: '' });

/** A leg whose wrapper died BEFORE echoing the exit marker but after printing
 *  output — exactly the prod shape "(exit 1, output)": no marker ⇒ terminated ⇒
 *  the exit code defaults to 1 while the cleaned output still carries text. */
const DIED_WITH_OUTPUT = { stdout: 'partial leg output, then SIGKILL\n', stderr: '' };

/**
 * Route one execShell call by what it actually is.
 * `legResults` is consumed one per CHAIN-LEG invocation (so attempt 0 and the
 * retry can differ); the last entry repeats once exhausted.
 */
function routedExec(
  legResults: Array<{ stdout: string; stderr: string }>,
  o: { cgroup?: string; bgScan?: string; changedFiles?: string } = {},
) {
  let legIndex = 0;
  const cgroupOut = o.cgroup ?? cg(100, 24_500, 0); // container healthy (~0.4%)
  return jest.fn(async (cmd: string) => {
    if (cmd.includes('memory.current') || cmd.includes('pgrep -f')) return { stdout: cgroupOut, stderr: '' };
    if (cmd.includes(SESSION_BG_MARKER)) return { stdout: o.bgScan ?? '', stderr: '' };
    if (cmd.includes('git diff --name-only') || cmd.includes('git merge-base')) {
      return { stdout: o.changedFiles ?? '', stderr: '' };
    }
    if (cmd.includes('package.json')) return { stdout: '{}', stderr: '' };
    const r = legResults[Math.min(legIndex, legResults.length - 1)];
    legIndex++;
    return r;
  });
}

const chainOf = (key: string, command: string): VerifyChainEntry[] => [{ key, command }];

const envDeathWarns = () =>
  (logger.warn as jest.Mock).mock.calls
    .map((c: any[]) => String(c[0]))
    .filter((m) => m.includes('died environmentally'));

// ── 1 + 3: the verify env-death warn — one retry, ONE warn per chain ─────────

describe('a6f59654 / 29be3a9d — the env-death warn promises ONE retry and emits ONE row per chain', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
    process.env.VERIFY_ENV_RETRY_MAX_BACKOFF_MS = '1';
    delete process.env.VERIFY_PRESSURE_DEFER_PCT;
    delete process.env.VERIFY_HOST_PRESSURE_DEFER_PCT;
    delete process.env.VERIFY_SESSION_ALLOWANCE_DISABLED;
  });

  it('a6f59654: typecheck dies environmentally ⇒ warn once, retry once, then pass', async () => {
    const exec = routedExec([DIED_WITH_OUTPUT, out('ok', 0)]);
    const res = await runVerifyChain(exec as any, '/wt-a6f59654', chainOf('typecheck', 'npx tsc --noEmit'), 1000);

    // "one memory-gated retry" is honoured literally: exactly TWO leg attempts.
    expect(exec.mock.calls.filter((c: any[]) => String(c[0]).includes('npx tsc --noEmit'))).toHaveLength(2);

    // …and exactly ONE warn, so one chain instance = one sweep row.
    const warns = envDeathWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('verify: stage typecheck died environmentally (exit 1, output)');
    expect(warns[0]).toContain('one memory-gated retry after backoff');
    // The warn text IS the ticket fingerprint — the same row the sweep files.
    expect(normalizeLogMessage(warns[0])).toBe(normalizeLogMessage(ROW_a6f59654));

    // The retry succeeded, so this is a real pass — the warn never poisons it.
    expect(res.passed).toBe(true);
  });

  it('29be3a9d: the test stage takes the SAME path — one warn, one retry', async () => {
    const exec = routedExec([DIED_WITH_OUTPUT, out('', 0)]);
    const res = await runVerifyChain(exec as any, '/wt-29be3a9d', chainOf('test', 'npx jest'), 1000);

    expect(exec.mock.calls.filter((c: any[]) => String(c[0]).includes('npx jest'))).toHaveLength(2);
    const warns = envDeathWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('verify: stage test died environmentally');
    expect(normalizeLogMessage(warns[0])).toBe(normalizeLogMessage(ROW_29be3a9d));
    expect(res.passed).toBe(true);
  });

  it('a stage that dies on BOTH attempts still emits exactly ONE warn (never a per-attempt fan-out)', async () => {
    const exec = routedExec([DIED_WITH_OUTPUT, DIED_WITH_OUTPUT]);
    const res = await runVerifyChain(exec as any, '/wt-both', chainOf('typecheck', 'npx tsc --noEmit'), 1000);

    // Both attempts ran; the second is the last — and it is SILENT by design.
    expect(exec.mock.calls.filter((c: any[]) => String(c[0]).includes('npx tsc --noEmit'))).toHaveLength(2);
    expect(envDeathWarns()).toHaveLength(1);
    expect(res.passed).toBe(false);
  });
});

// ── 4: the per-session background allowance ─────────────────────────────────

const SID = '7f87305b-7201-400c-a9a8-ee8d6bb8e418';
const PEER_SID = '5eb20b2e-901d-4b17-93bf-a7922f9b3bdd';
const LEG_OK = { stdout: 'ok\n__DIGBY_EXIT__ 0', stderr: '' };

describe("9054c318 — the session allowance warns for THIS session's daemons and never charges a peer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.VERIFY_SESSION_ALLOWANCE_MB;
    delete process.env.VERIFY_SESSION_ALLOWANCE_DISABLED;
    delete process.env.VERIFY_PRESSURE_DEFER_PCT;
    delete process.env.VERIFY_HOST_PRESSURE_DEFER_PCT;
  });

  const starvedWarns = () =>
    (logger.warn as jest.Mock).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((m) => m.includes('background allowance exceeded'));

  /** noteVerifyEnvStarved is void-ed and dynamic-imports its recorder, so the
   *  metric lands a microtask later — flush before asserting on it. */
  const flush = () => new Promise((r) => setImmediate(r));

  it('own daemons over 2048 MB ⇒ ENV-STARVED (session_allowance), chain does NOT run, ONE telemetry row', async () => {
    // Container and host both healthy: the ONLY starved axis is this session's
    // own daemons (3 GB > the 2048 MB default), which is exactly the arm.
    const exec = routedExec([LEG_OK], { bgScan: bgRow(SID, 3 * 1024 * 1024) });

    const res = await runVerifyChain(exec as any, '/wt-9054c318', chainOf('typecheck', 'npx tsc --noEmit'), 1000, { sessionId: SID });

    // The whole point of this arm: no fresh chain may buy memory its own
    // daemons are already holding — so NO leg runs at all.
    expect(res.ran).toBe(false);
    expect(res.stages[0]?.key).toBe('session_allowance');
    expect(res.stages[0]?.envStarved).toBe(true);
    // Unverified, never a false green.
    expect(res.unverified).toBe(true);
    expect(res.stages[0]?.outputTail).toContain('ENV-STARVED');
    // …and the leg never executed.
    expect(exec.mock.calls.filter((c: any[]) => String(c[0]).includes('npx tsc --noEmit'))).toHaveLength(0);

    const warns = starvedWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`verify: ENV-STARVED — session ${SID}`);
    expect(warns[0]).toContain('background allowance exceeded');
    expect(normalizeLogMessage(warns[0])).toBe(normalizeLogMessage(ROW_9054c318));

    // Exactly one telemetry row for the deferred chain.
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'verify_pressure_deferred' }));
  });

  it("a PEER session's daemons never starve this one — attribution is per session", async () => {
    // One peer daemon holds 6 GB — three times the allowance — but it is NOT
    // this session's bill, so the chain must run.
    const exec = routedExec([LEG_OK], { bgScan: bgRow(PEER_SID, 6 * 1024 * 1024) });

    const res = await runVerifyChain(exec as any, '/wt-peer', chainOf('typecheck', 'true'), 30_000, { sessionId: SID });

    expect(res.ran).toBe(true);
    expect(starvedWarns()).toHaveLength(0);
  });
});

// ── 2: the BrightData direct-tier timeout is a bounded failover record ──────

describe('f73871a7 — a direct-tier timeout is logged once and never retried (bounded failover)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  });

  const scrapeWarns = () =>
    (logger.warn as jest.Mock).mock.calls
      .map((c: any[]) => String(c[0]))
      .filter((m) => m.includes('scrape_as_markdown failed'));

  it('ECONNABORTED (our own timeout) ⇒ exactly ONE POST, ONE warn, NULL return — never a throw', async () => {
    // ECONNABORTED is our timeoutMs firing: isRetryableBdError returns false by
    // design (a slow target is not a transient), so a backoff storm is
    // impossible — there is no second attempt to storm with.
    mockAxiosPost.mockRejectedValue(Object.assign(new Error('timeout of 45000ms exceeded'), { code: 'ECONNABORTED' }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { tryDirectBrightData } = require('./brightdata-direct');

    let threw: any = null;
    const val = await tryDirectBrightData('scrape_as_markdown', { url: 'https://example.com' })
      .catch((e: any) => { threw = e; return 'THREW'; });

    // Contract: null (fall over to the gateway tier), never throw.
    expect(val).toBeNull();
    expect(threw).toBeNull();
    // Bounded by construction: ONE attempt.
    expect(mockAxiosPost).toHaveBeenCalledTimes(1);

    const warns = scrapeWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('BrightData direct: scrape_as_markdown failed:');
    expect(warns[0]).toContain('timeout of 45000ms exceeded');
    // The warn IS the ticket fingerprint; the elapsed ms normalizes out.
    expect(normalizeLogMessage(warns[0])).toBe(normalizeLogMessage(ROW_f73871a7));
  });

  it('a 500 is retried at most BD_MAX_ATTEMPTS times and escalates to ONE terminal row', async () => {
    mockAxiosPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 500'), {
      response: { status: 500, data: '' },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { tryDirectBrightData } = require('./brightdata-direct');
    await tryDirectBrightData('scrape_as_markdown', { url: 'https://example.com' }, { remaining: 10 } as any);

    expect(mockAxiosPost).toHaveBeenCalledTimes(3); // BD_MAX_ATTEMPTS, never unbounded
    // ONLY the terminal failure carries the fingerprint shape; the retry lines
    // are a different message ("transient … retrying"), so one degraded scrape
    // can never masquerade as many sweep rows.
    //
    // RE-ADJUDICATED (family lane 30dfad06, 2026-11-06): a 500 is a VENDOR
    // degradation, so the terminal row is now emitted via logExternal
    // (logger.log, logClass:'external'). It is still level 'warn' and still
    // persisted for the audit's vendor_transient rung; only the sweep tier tag
    // moved. The owner-actionable classes (40x) stay untagged warns.
    const tagged = (logger.log as jest.Mock).mock.calls
      .map((c: any[]) => c[0])
      .filter((o: any) => String(o?.message || '').includes('scrape_as_markdown failed'));
    expect(tagged).toHaveLength(1);
    expect(tagged[0].level).toBe('warn');
    expect(tagged[0].logClass).toBe('external');
    expect(scrapeWarns()).toHaveLength(0);
  });
});