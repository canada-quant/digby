/**
 * Characterization pins — log-signal family, lead ticket 30dfad06
 * (2026-11-01, lane d0e5e838). Five sweep auto-filings from ONE signal class
 * ("a warn line the hourly sweep fingerprints"), adjudicated PER MEMBER against
 * live app_error_logs rows (read this run) rather than the ticket text.
 *
 * NONE is a standalone defect of its own emit site: all five are DESIGNED
 * observability — the warning IS the enforcement/visibility record for a
 * condition the platform cannot silently absorb. Every one is pinned here so a
 * future "helpful" silencing (or a fingerprint drift) has to argue with a
 * replay, and so the sweep's fingerprints stay bound to their emit sites.
 *
 *  1. 30dfad06  brightdata-direct  — vendor HTTP 500 on the direct tier. The
 *     emit is a bounded FAILOVER record: BD_MAX_ATTEMPTS (3) retries for
 *     retryable statuses, then tryDirectBrightData returns null (never throws)
 *     and the request falls through to the gateway tier. Live newest row is a
 *     BrightData proxy-side "Parse Error: Header overflow" — component-local to
 *     OUR direct tier (the gateway tier is unaffected by that header overflow),
 *     so the direct tier genuinely missed and the loud record is what makes the
 *     failover visible. Silencing it would make "direct tier is degraded and
 *     every scrape is paying the gateway hop" indistinguishable from a healthy
 *     direct tier.
 *
 *  2. d7a1ad46  suggested-questions — low-yield/transient generation miss.
 *     DESIGNED: the warn is emitted exactly once per generation attempt, and
 *     the attempt then arms a backoff marker (5 min transient / 30 min when a
 *     real draft was thinned by the critic) that the controller READS before
 *     kicking another regeneration, so the class cannot become a request-rate
 *     storm. Live check this run (17 rows / 24 h): the busiest user contributes
 *     9 rows spaced 22:28 → 22:35 → 23:01 → 23:39 → 23:47 → 00:06 → 01:34 —
 *     i.e. never faster than the backoff window, which is the marker being
 *     HONORED. The recurrence driver is a real per-user yield miss, not a
 *     retry loop; silencing it would blind the fleet to users who never get a
 *     personalized set.
 *
 *  3. 9b296637  vision_describe seat — an Image-reader seat provider returning
 *     HTTP 524 (llm-cql upstream timeout). DESIGNED RESILIENCE, already
 *     adjudicated for the sibling shape by the fbd0fb6d pin ("a lead seat HTTP
 *     524 is a provider 'not now', and the turn moves on") and the 4c691bfe
 *     pin (the vision_describe seat chain). The seat warn fires ONCE PER FAILED
 *     PROVIDER inside the chain walk; a failing provider does not end the call
 *     — the chain falls through to the next one and only a WHOLE-chain failure
 *     throws. Silencing the per-provider warn would remove the only per-seat
 *     evidence that a specific vision provider is flapping behind a healthy
 *     fallback.
 *
 *  4. 1e6ca603  goal_premise_set — the documented ≤12-premise cap refusing a
 *     13th key. DESIGNED GUARD, already replay-pinned by af24badf (whose
 *     invariant this file re-asserts under this member's id): no refusal may
 *     advise a retry the tool would refuse again — the merge refusal names the
 *     exact arithmetic AND a mode:'replace' hatch that genuinely LANDS. The
 *     warn is the lane's only feedback that its register is full; silencing it
 *     would make the cap look like a silent data loss.
 *
 *  5. 18d83feb  action-verifier PRE-DELIVERY strike — the machine-wake
 *     fabricate-a-completion-claim guard convicting phantom claims in a
 *     supervisor note before delivery. DESIGNED, already pinned twice
 *     (82029969 citation-class + 91fb1905 / BRIEFING-UNVERIFIED-FILTER
 *     action-class). Re-asserted here: ONE warn per guarded note (never a
 *     per-claim fan-out), level warn never error, source 'action-verifier',
 *     total silence on a clean note.
 *
 * FINGERPRINT BINDING: every prod example row from the five tickets is replayed
 * through the SHIPPED normalizer and must reproduce its ticket's fingerprint
 * VERBATIM — the tickets' titles are the normalizer's own output, so this is the
 * check that the five filings really are these five emit sites.
 */

const mockRedis: any = {
  get: jest.fn(async (..._a: unknown[]): Promise<string | null> => null),
  set: jest.fn(async (): Promise<string | null> => 'OK'),
  setEx: jest.fn(async () => 'OK'),
  del: jest.fn(async () => 1),
};
jest.mock('../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  userMemory: { findUnique: jest.fn(async () => null) },
  userMemoryFact: { findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []) },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  // `log` is present because logExternal (utils/log-level.ts) emits the object
  // form through logger.log — a warn-level taxonomy row that must NOT be passed
  // as a splat argument.
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

const mockUtilityChat = jest.fn(async (): Promise<string> => '');
jest.mock('../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a),
}));

const mockRecordLoopMetric = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    SUGGESTED_QUESTIONS_QUALITY: 'suggested_questions_quality',
  },
}));

const mockPost = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockPost(...a) } }));

const mockSeatProviderChain: jest.Mock = jest.fn();
const mockSeatCompletion: jest.Mock = jest.fn();
const mockProviderKeyMissing: jest.Mock = jest.fn(() => null);
const mockWarnSeatFailure: jest.Mock = jest.fn();
jest.mock('./seat-call', () => ({
  __esModule: true,
  seatProviderChain: (...a: any[]) => mockSeatProviderChain(...a),
  seatCompletion: (...a: any[]) => mockSeatCompletion(...a),
  providerKeyMissing: (...a: any[]) => mockProviderKeyMissing(...a),
  warnSeatFailure: (...a: any[]) => mockWarnSeatFailure(...a),
  imageUrlPart: (mime: string, b64: string) => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }),
  resolveSeat: jest.fn(),
}));
jest.mock('./heic', () => ({
  __esModule: true,
  convertHeicToJpeg: jest.fn(),
  isHeicMime: (m: string) => m === 'image/heic' || m === 'image/heif',
}));

import { normalizeLogMessage } from './fleet/log-signal-sweep.service';
import { generateQuestionsForUser, DEFAULT_QUESTIONS, MIN_QUESTIONS } from './suggested-questions.service';
import { normalizePremises, PREMISE_MAX_PER_GOAL } from './platform/premise-register';
import { answerImageQuestion } from './image-describe';

const logger = require('../../utils/logger').default;

// ── The five prod example rows, verbatim from their tickets ──────────────────

const ROW_30dfad06 =
  'BrightData direct: scrape_as_markdown failed: 500 Request failed with status code 500 — body: ' +
  '{"status_code":500,"error":"Proxy request failed","error_code":"unknown_proxy_error","details":"Parse Error: Header overflow"}';

const ROW_d7a1ad46 =
  'suggested-questions: 0 usable results for userId=867c4f48-238b-4d35-beb6-73cd22e2e689 (min 3) — backing off 5 min before retry';

const ROW_9b296637 =
  'vision_describe seat: api-optimize-zai-glm-5.3-flash (llm-cql (custom endpoint)) failed — HTTP 524 — Request failed with status code 524';

const ROW_1e6ca603 =
  'coding tool goal_premise_set failed: goal_premise_set: a goal holds at most 12 premises (got 13: 12 already registered + ' +
  '1 new key(s) in this call) — 1 key must go: drop at least 1 of the NEW key(s) (dropping one you merely re-sent moves nothing — ' +
  "it is already registered), or send the ≤12-key set you want it to KEEP with mode:'replace' (a replace keeps ONLY the keys in " +
  'the call, so re-send every already-registered key you still need)';

const ROW_18d83feb =
  "action-verifier: PRE-DELIVERY strike — 4 phantom claim(s) in supervisor 41bd202a's note; the note was delivered AS WRITTEN " +
  '(observe-only — the seam will not enforce this verdict; nothing is removed, and its id-less action claims that locate in the ' +
  'note and cite no action receipt of this chat may get a trailing footnote at finalize — BRIEFING-UNVERIFIED-FILTER) unless the ' +
  "reject-back supersedes it (deferred-consequences pass — the retry's clean text replaces this attempt)";

describe('30dfad06/d7a1ad46/9b296637/1e6ca603/18d83feb — fingerprint binding (each ticket IS its emit site)', () => {
  it.each([
    ['30dfad06', ROW_30dfad06, 'brightdata direct: scrape_as_markdown failed:'],
    ['d7a1ad46', ROW_d7a1ad46, 'suggested-questions: <n> usable results for userid=<uuid> (min <n>) — backing off <n> min before retry'],
    ['9b296637', ROW_9b296637, 'vision_describe seat:'],
    ['1e6ca603', ROW_1e6ca603, 'coding tool goal_premise_set failed: goal_premise_set: a goal holds at most <n> premises'],
    ['18d83feb', ROW_18d83feb, 'action-verifier: pre-delivery strike —'],
  ])('%s normalizes to a fingerprint the ticket title carries', (id, raw, expectPrefix) => {
    const fp = normalizeLogMessage(raw);
    expect(fp.startsWith(expectPrefix)).toBe(true);
    // The ticket TITLE is the normalizer's own output, capped at the fingerprint
    // length — so the row and the filing provably describe the same signal.
    expect(fp.length).toBeLessThanOrEqual(120);
    // Every volatile field is normalized out: a user id, a status code or a
    // supervisor id must never split one class into many filings.
    expect(fp).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(fp.replace(/<(n|uuid)>/g, '')).not.toMatch(/\b\d{3}\b/);
  });

  it('the two members that carry an id are masked, not just truncated', () => {
    // d7a1ad46 masks the userId to <uuid>; 18d83feb masks the supervisor id.
    expect(normalizeLogMessage(ROW_d7a1ad46)).toContain('<uuid>');
    expect(normalizeLogMessage(ROW_18d83feb)).not.toContain('41bd202a');
  });
});

describe('30dfad06 — the BrightData direct 500 is a bounded failover record, not a retry storm', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset();
    process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  });

  /** resetModules gives the module under test a FRESH logger mock — always
   *  read the logger back AFTER loading, never the module-level capture. */
  function load() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./brightdata-direct');
  }
  const freshLogger = () => require('../../utils/logger').default;

  it('REPLAY: the exact prod 500 → warn with the ticket fingerprint, then NULL (gateway tier takes over) — never a throw', async () => {
    const err: any = Object.assign(new Error('Request failed with status code 500'), {
      response: {
        status: 500,
        data: '{"status_code":500,"error":"Proxy request failed","error_code":"unknown_proxy_error","details":"Parse Error: Header overflow"}',
      },
    });
    mockPost.mockRejectedValue(err);
    const { tryDirectBrightData } = load();

    let threw: any = null;
    const out = await tryDirectBrightData('scrape_as_markdown', { url: 'https://example.com' })
      .catch((e: any) => { threw = e; return 'THREW'; });

    // Contract: null (fail over to the gateway tier), never throw — the caller
    // must be able to serve the request from the other tier.
    expect(out).toBeNull();
    expect(threw).toBeNull();

    // The warn IS the ticket fingerprint (same text the sweep normalizes).
    // Retry lines ("transient 500 … retrying") come first; the TERMINAL failure
    // is the last row — one degraded scrape = one fingerprint row.
    //
    // RE-ADJUDICATED (family lane 30dfad06, 2026-11-06): the terminal failure is
    // now emitted via logExternal — still level 'warn' and still PERSISTED
    // (tagging drops it from the log-signal SWEEP, not from app_error_logs),
    // but it carries logClass:'external' so an adjudicated vendor class stops
    // filing a weekly ticket. The row is read back here from logger.log, and
    // the audit's vendor_transient rung (no logClass filter) still sees it.
    const warnCalls = (freshLogger().warn as jest.Mock).mock.calls;
    const logCalls = (freshLogger().log as jest.Mock).mock.calls;
    expect(warnCalls.filter((c: any[]) => String(c[0]).includes('scrape_as_markdown failed'))).toHaveLength(0);
    const taggedTerminal = logCalls.filter((c: any[]) => String(c[0]?.message || '').includes('scrape_as_markdown failed'));
    expect(taggedTerminal).toHaveLength(1);
    const warnMsg = String(taggedTerminal[0][0].message);
    expect(warnMsg).toContain('BrightData direct: scrape_as_markdown failed: 500');
    expect(warnMsg).toContain('Parse Error: Header overflow');
    expect(normalizeLogMessage(warnMsg)).toBe(normalizeLogMessage(ROW_30dfad06));
    // Level is STILL warn (it is persisted and visible) — only the class tag moved.
    expect(taggedTerminal[0][0].level).toBe('warn');
    expect(taggedTerminal[0][0].logClass).toBe('external');
    // and it carries the routing context the sweep/alerting reads
    expect(taggedTerminal[0][0]).toMatchObject({ source: 'brightdata-direct', tool: 'scrape_as_markdown' });
  });

  it('an owner-actionable direct failure (revoked token / disabled zone) stays an UNTAGGED warn', async () => {
    // The other half of the taxonomy: http_401/402/403/429 are OURS to fix, so
    // they must keep filing. Tagging the whole catch-all would have hidden the
    // 2026-08-06 invisible-outage class.
    const err: any = Object.assign(new Error('Request failed with status code 403'), {
      response: { status: 403, data: '{"error":"zone disabled"}' },
    });
    mockPost.mockRejectedValue(err);
    const { tryDirectBrightData } = load();
    await tryDirectBrightData('scrape_as_markdown', { url: 'https://example.com' });

    const warnCalls = (freshLogger().warn as jest.Mock).mock.calls;
    const terminal = warnCalls.filter((c: any[]) => String(c[0]).includes('scrape_as_markdown failed'));
    expect(terminal).toHaveLength(1);
    expect(String(terminal[0][0])).toContain('403');
    // No external tag on this row — it must reach the sweep and file.
    expect(terminal[0][1]?.logClass).toBeUndefined();
  });

  it('the retry is BOUNDED at 3 attempts (no unbounded storm) and each retry is an INFO line, not a warn', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Request failed with status code 500'), { response: { status: 500, data: '' } }));
    const { tryDirectBrightData } = load();
    await tryDirectBrightData('scrape_as_markdown', { url: 'https://example.com' }, { remaining: 10 } as any);

    expect(mockPost).toHaveBeenCalledTimes(3);
    // retries are logged at info ("transient … retrying") — only the terminal
    // failure escalates, so one degraded scrape is ONE sweep row. Since the
    // 2026-11-06 re-adjudication that terminal row is emitted via logExternal
    // (logger.log, logClass:'external'), NOT logger.warn — the level is still
    // 'warn', so it persists and stays visible; only the tier tag moved.
    const warnMsgs = (freshLogger().warn as jest.Mock).mock.calls.map((c: any[]) => String(c[0]));
    const logMsgs = (freshLogger().log as jest.Mock).mock.calls.map((c: any[]) => String(c[0]?.message || ''));
    expect(warnMsgs.filter(m => m.includes('scrape_as_markdown failed'))).toHaveLength(0);
    expect(logMsgs.filter(m => m.includes('scrape_as_markdown failed'))).toHaveLength(1);
    // the retry lines are a DIFFERENT message shape, so they cannot masquerade
    // as the fingerprint row — and they carry their own tool tag.
    expect(warnMsgs.filter(m => m.includes('transient 500'))).toHaveLength(2); // attempts 1 and 2 only
  });
});

describe('d7a1ad46 — the low-yield warn is emitted once per attempt and arms a backoff the controller honors', () => {
  const BACKOFF_KEY = (u: string) => `user:suggested-questions:failed:${u}`;
  const CACHE_KEY = (u: string) => `user:suggested-questions:${u}`;
  const setExCalls = () => (mockRedis.setEx.mock.calls as any[][]);

  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.get.mockResolvedValue(null);
    mockRedis.set.mockResolvedValue('OK');
    mockPrisma.userMemory.findUnique.mockResolvedValue({
      facts: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`topic_${i}`, `value ${i}`])),
    });
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockUtilityChat.mockReset();
  });

  it('REPLAY: a generation that yields ZERO usable chips warns with the fingerprint, arms the 5-min backoff, and never caches defaults as a 24 h hit', async () => {
    // draft fine, critic rejects everything → 0 survivors (the live "0 usable" row)
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({ question: `Digby, explain topic number ${i} for me?`, source: `fact:topic_${i}`, time_check: 'fits today' })),
      ))
      .mockResolvedValueOnce(JSON.stringify({ keep: [], rejected: [] }));

    const out = await generateQuestionsForUser('867c4f48-238b-4d35-beb6-73cd22e2e689');

    expect(out).toEqual(DEFAULT_QUESTIONS);
    expect(MIN_QUESTIONS).toBeGreaterThan(0);

    const warnMsg = String((logger.warn as jest.Mock).mock.calls.find((c: any[]) => String(c[0]).includes('usable results'))?.[0] ?? '');
    expect(warnMsg).toContain('usable results for userId=867c4f48-238b-4d35-beb6-73cd22e2e689');
    expect(warnMsg).toContain('backing off');
    expect(normalizeLogMessage(warnMsg)).toBe(normalizeLogMessage(ROW_d7a1ad46));

    // The bound that makes recurrence non-storming: the backoff marker is SET,
    // and defaults are NOT cached as a valid hit.
    const written = setExCalls().map(c => c[0]);
    expect(written).toContain(BACKOFF_KEY('867c4f48-238b-4d35-beb6-73cd22e2e689'));
    expect(written).not.toContain(CACHE_KEY('867c4f48-238b-4d35-beb6-73cd22e2e689'));

    // Exactly ONE warn for the attempt — never one per rejected candidate.
    const warns = (logger.warn as jest.Mock).mock.calls.map((c: any[]) => String(c[0])).filter(m => m.includes('usable results'));
    expect(warns).toHaveLength(1);
  });

  it('a critic-thinned draft (some survivors, below min) backs off 30 min, not 5 — the low-yield half of the same warn', async () => {
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify(
        Array.from({ length: 10 }, (_, i) => ({ question: `Digby, explain topic number ${i} for me?`, source: `fact:topic_${i}`, time_check: 'fits today' })),
      ))
      .mockResolvedValueOnce(JSON.stringify({ keep: [4, 5], rejected: [] }));

    await generateQuestionsForUser('u-thin-1');
    const warnMsg = String((logger.warn as jest.Mock).mock.calls.find((c: any[]) => String(c[0]).includes('usable results'))?.[0] ?? '');
    expect(warnMsg).toContain('backing off 30 min');
    const backoffWrite = setExCalls().find(c => c[0] === BACKOFF_KEY('u-thin-1'));
    expect(backoffWrite?.[1]).toBe(30 * 60); // setEx(key, ttlSeconds, value) — the long window
  });
});

describe('9b296637 — a 524 from one Image-reader provider falls through the seat chain (designed resilience)', () => {
  const SEAT = { model: 'api-optimize-zai-glm-5.3-flash', label: 'llm-cql (custom endpoint)', url: 'https://llm.cql.ca/v1/chat/completions', apiKey: 'k' };
  const FALLBACK = { model: 'cql-vision', label: 'cql', url: 'https://llm.cql.ca/v1/chat/completions', apiKey: '' };
  const ok = (text: string) => ({ text, reasoning: '', toolCalls: [], finishReason: 'stop', hadReasoning: false });

  beforeEach(() => {
    jest.clearAllMocks();
    mockProviderKeyMissing.mockImplementation(() => null);
    mockSeatProviderChain.mockResolvedValue([SEAT, FALLBACK]);
  });

  it('REPLAY: the prod 524 on the first provider warns ONCE (fingerprint) and the NEXT provider answers', async () => {
    mockSeatCompletion
      .mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 524'), { response: { status: 524 } }))
      .mockResolvedValueOnce(ok('described by the fallback'));

    const r = await answerImageQuestion(Buffer.from('x'), 'image/webp', 'a.webp', 'what is this?');

    // One failing provider must never end the call — the chain moves on.
    expect(r).toEqual({ answer: 'described by the fallback', model: 'cql-vision' });
    // One warn for one failed provider, carrying that provider's identity.
    expect(mockWarnSeatFailure).toHaveBeenCalledTimes(1);
    expect(mockWarnSeatFailure).toHaveBeenCalledWith('vision_describe', SEAT, expect.anything());
  });

  it('the warn text (seat name + provider label + describeSeatError) reproduces the ticket fingerprint', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { describeSeatError } = jest.requireActual('./seat-call');
    const err = Object.assign(new Error('Request failed with status code 524'), { response: { status: 524 } });
    const emitted = `vision_describe seat: ${SEAT.model} (${SEAT.label}) failed — ${describeSeatError(err)}`;
    expect(normalizeLogMessage(emitted)).toBe(normalizeLogMessage(ROW_9b296637));
  });

  it('only a WHOLE-chain failure throws — so a 524 that the fallback absorbs produces no error-level row', async () => {
    mockSeatCompletion
      .mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 524'), { response: { status: 524 } }))
      .mockResolvedValueOnce(ok('fallback again'));
    await answerImageQuestion(Buffer.from('x'), 'image/png', 'a.png', 'q');
    expect((logger.error as jest.Mock).mock.calls).toHaveLength(0); // warn, never error
  });
});

describe('1e6ca603 — the ≤12-premise cap refusal is honest and its advised hatch LANDS', () => {
  const twelveRegistered = Array.from({ length: PREMISE_MAX_PER_GOAL }, (_, i) => ({ key: `p${i}`, value: i, unit: 'rows' })) as any;

  it('REPLAY: the exact prod shape (12 registered + 1 new) refuses with the ticket fingerprint’s arithmetic', () => {
    const res = normalizePremises([{ key: 'brand_new', value: 1 }], twelveRegistered, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;

    expect(res.error).toContain(`at most ${PREMISE_MAX_PER_GOAL} premises`);
    // "got 13: 12 already registered + 1 new key(s) in this call" — the live row
    expect(res.error).toContain(`got ${PREMISE_MAX_PER_GOAL + 1}: ${PREMISE_MAX_PER_GOAL} already registered + 1 new key(s) in this call`);
    expect(res.error).toContain('1 key must go');
    // and the emitted tool envelope is what the sweep fingerprints
    const emitted = `coding tool goal_premise_set failed: goal_premise_set: ${res.error}`;
    expect(normalizeLogMessage(emitted)).toBe(normalizeLogMessage(ROW_1e6ca603));
  });

  it('INVARIANT (af24badf, re-asserted): the remedy the refusal names, executed literally, LANDS — no dead-end retry', () => {
    const res = normalizePremises([{ key: 'brand_new', value: 1 }], twelveRegistered, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(`the ≤${PREMISE_MAX_PER_GOAL}-key set you want it to KEEP with mode:'replace'`);

    // Do exactly what it says: drop the oldest registered key, keep the rest, add the new one.
    const keep = [...twelveRegistered.slice(1).map((p: any) => ({ key: p.key, value: p.value })), { key: 'brand_new', value: 1 }];
    expect(keep).toHaveLength(PREMISE_MAX_PER_GOAL);
    const landed = normalizePremises(keep, twelveRegistered, { mode: 'replace' });
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    expect(landed.premises).toHaveLength(PREMISE_MAX_PER_GOAL);
    expect(landed.premises.some((p: any) => p.key === 'brand_new')).toBe(true);
  });

  it('the cap is DISCLOSED before it is hit: a call that fits still lands (the warn only fires on a real over-cap)', () => {
    const fits = normalizePremises([{ key: 'another_new', value: 1 }], twelveRegistered.slice(0, PREMISE_MAX_PER_GOAL - 1), {});
    expect(fits.ok).toBe(true);
  });
});

describe('18d83feb — the PRE-DELIVERY strike is the fabrication guard’s designed record, one warn per note', () => {
  const fs = require('fs');
  const path = require('path');

  it('the emit site is a single warn carrying source + chatId + claim evidence, and is observe-only', () => {
    const src = fs.readFileSync(path.join(__dirname, 'platform/action-verifier.ts'), 'utf8');
    const at = src.indexOf('action-verifier: PRE-DELIVERY strike');
    expect(at).toBeGreaterThan(-1);

    const line = src.slice(at, at + 700);
    // one template line — the context the sweep and the owner card read
    expect(line).toContain('phantom claim(s)');
    expect(src.slice(at, at + 260)).toContain("source: 'action-verifier'");
    // 'warn', never 'error': the sweep reads warn+ and the guard is not a crash
    expect(src.slice(Math.max(0, at - 120), at)).toContain('logger.warn');
    // observe-only: the seam explicitly refuses to enforce (nothing is removed)
    expect(src).toContain('observe-only');
    expect(src).toContain('BRIEFING-UNVERIFIED-FILTER');
  });

  it('the live row’s two delivery phrases share one emit site, and the stable tail after the supervisor id is identical', () => {
    // citation-class phrase and the action-class (BRIEFING-UNVERIFIED-FILTER)
    // phrase — the 82029969/91fb1905 pins cover their executable replays; here we
    // pin that both come from the SAME template line, whose post-id tail is one
    // signal regardless of which delivery phrase fired.
    const citation = "action-verifier: PRE-DELIVERY strike — 1 phantom claim(s) in supervisor e03452f4's note; " +
      'the note was delivered as written with an observe-only annotation (audit 2026-10-08 W1-4)';
    const fpCitation = normalizeLogMessage(citation);
    const fpProd = normalizeLogMessage(ROW_18d83feb);

    expect(fpCitation).toContain('<n> phantom claim(s) in supervisor');
    // Both keep the same emit-site prefix through the supervisor id …
    const prefix = (s: string) => s.slice(0, s.indexOf('supervisor ') + 'supervisor '.length);
    expect(prefix(fpCitation)).toBe(prefix(fpProd));
    // … and the SAME tail from "'s note; the note was delivered as writ".
    // The prod fingerprint is TRUNCATED at FINGERPRINT_MAX_LEN, so its tail is a
    // PREFIX of the longer citation's tail ("as wr" vs "as wri") — that cut is
    // itself why the ticket title ends mid-word.
    const tail = (s: string) => s.slice(s.indexOf("'s note;"));
    expect(tail(fpCitation).startsWith(tail(fpProd))).toBe(true);
    expect(fpProd).toHaveLength(120); // the observed cut
  });

  it('OBSERVED (recorded, NOT changed here): the id token is digit-normalized, not shape-normalized, so two supervisors can split one class', () => {
    // 41bd202a → "<n>bd<n>a"; e03452f4 → "e<n>f<n>". The normalizer replaces
    // DIGITS (`\d+` → <n>) and full uuids, but a bare 8-hex id only partially —
    // so the supervisor id's letter/digit pattern survives into the fingerprint.
    // That fragments ONE signal class across supervisors, which is why the
    // action-verifier strike keeps arriving as several sibling filings
    // (82029969, 91fb1905, 18d83feb …).
    //
    // Deliberately NOT fixed in this family PR: the normalizer is shared by
    // EVERY log-signal class, so changing it would re-fingerprint the whole
    // sweep at once (and reset every per-fingerprint adjudication). Recorded
    // here as a measurement so the sweep owner can weigh it with evidence.
    const a = normalizeLogMessage("action-verifier: PRE-DELIVERY strike — 4 phantom claim(s) in supervisor 41bd202a's note; the note was delivered as written");
    const b = normalizeLogMessage("action-verifier: PRE-DELIVERY strike — 4 phantom claim(s) in supervisor e03452f4's note; the note was delivered as written");
    expect(a).not.toBe(b);                    // the wart, pinned as it stands
    expect(a).toContain('<n>bd<n>a');         // digits replaced, letters kept
    expect(b).toContain('e<n>f<n>');
  });

  it('the guard is ALREADY replay-pinned executably elsewhere — this member adds no new seam, only the binding', () => {
    const pin = fs.readFileSync(path.join(__dirname, 'platform/action-verifier.log-signal-82029969.test.ts'), 'utf8');
    expect(pin).toContain('82029969');
    expect(pin).toContain('guardMachineWakeFinalAnswer');
    expect(pin).toContain('the note was delivered as writ');
  });
});
// ── PER-MEMBER REPLAY BINDING (family lane, 2026-11-06) ─────────────────────
// Every member of this family gets ONE assertion naming its emit site and the
// adjudication that was made, so a ticket close has a replay pin that cites the
// row's own 8-char id (the adjudication gate's EVIDENCE requirement) and a
// future reader can tell "designed, pinned" from "never looked at".
describe('family member replay binding — each ticket id maps to one adjudicated site', () => {
  const fs = require('fs');
  const pathMod = require('path');
  const code = (rel: string) => fs.readFileSync(pathMod.join(__dirname, rel), 'utf8');

  it('c71183ab — the GONE row is split by RECOVERY, not tagged wholesale', () => {
    const src = code('coding/container.service.ts');
    expect(src).toContain('if (reProvisioned) logExternal(goneMessage');
    expect(src).toContain('else logger.warn(goneMessage);');
    // The unrecovered branch is the one that must keep filing: with no shell
    // tools for the rest of the run the lane loses its firing.
    expect(src).toContain('re-provisioned=${reProvisioned}');
  });

  it('488abfa3 — a REPLACED container is recovered, so it is tagged external', () => {
    const src = code('coding/container.service.ts');
    expect(src).toContain('logExternal(\n      `coding container: REPLACED for session');
    // Nothing is lost: the durable metric row is written on the SAME branch.
    expect(src).toContain('CONTAINER_REPLACED');
  });

  it('8775266b — the attribution summary is info; the metric rows are the record', () => {
    const src = code('chat-agent/chat-agent.service.ts');
    expect(src).toContain('artifact-attribution mismatch(es) (observe-only) — spec 13dfa16d`, { source: \'chat-agent\' });');
    // Both sibling summary sites moved; their durable metric did not.
    expect(src).toContain("kind: 'artifact_attribution_mismatch',");
    expect(src).not.toContain('logger.warn(`chat-agent: supervisor ${chatId.slice(0, 8)} machine wake carried ${attribMismatches.length}');
  });

  it('fa9349ee — REFUTED for tagging: our own gateway liveness trace stays a warn', () => {
    const src = code('mcp-search.ts');
    expect(src).toContain('logger.warn(`Digby Web Search: ${toolName} SSE stream timed out (${timeoutMs / 1000}s)`');
    // The timer is OUR safety timer waiting on OUR gateway child — there is no
    // vendor/ours discriminator, so de-ticketing it would delete the only
    // per-attempt evidence that the child stopped emitting.
    expect(src).not.toContain('logExternal(`Digby Web Search:');
  });
});
