/**
 * delta-gate.0b1dbe75.test.ts — replay/regression pins for the DELTA GATE
 * (feedback ticket 0b1dbe75): a recurring watch loop's fire-time cheap-poll
 * skip. The PLATFORM polls the schedule's https probes itself at each fire
 * time and SKIPS the model run (lastStatus 'skipped:delta_unchanged', no
 * run/maxRuns/daily-cap budget burned) when every observed value still equals
 * its stored marker; a first read FIRES 'baseline', a change FIRES 'delta',
 * a probe error FIRES 'error' (fail-open — a gate failure must never silence
 * a schedule), and an overdue heartbeat FIRES 'heartbeat' (liveness floor).
 *
 * Pinned here:
 *   1. validateDeltaGate — STRICT write-time validation: every refuse shape
 *      (non-object, 0/>4 probes, non-https/userinfo/over-long url, both-or-
 *      neither reader, bad jsonPath, over-long/invalid/unsafe pattern, >8
 *      headers, bad header name/value, heartbeatHours out of range) and the
 *      strip of platform-maintained marker/checkedAt/lastError.
 *   2. parseStoredDeltaGate — TOLERANT fire-time read: garbage → null, bad
 *      probes drop, headers sanitized, heartbeatHours clamped to default,
 *      platform fields preserved.
 *   3. evaluateDeltaGate — verdict precedence (baseline → delta → error →
 *      heartbeat → unchanged), reader semantics (number/boolean stringify,
 *      object JSON.stringify, first capture group over whole match), marker
 *      preservation on error, the 25s wall-clock timeout returning the
 *      ORIGINAL gate. NEVER throws.
 *   4. schedule.service integration — createSchedule/updateScheduleForUser
 *      arm/replace/clear rules, and the sweep (fireDue): unchanged → skip
 *      (no fire, skip write, no runsCount bump), delta/baseline/error →
 *      fire with markers persisted BEFORE the bump.
 *   5. ScheduleView redaction — header VALUES (secrets) never leave the row;
 *      read surfaces carry header NAMES only.
 *
 * Harness mirrors sched-infra-blocker.2b45941b.test.ts (colocated mocked
 * prisma/redis/hooks/fire-path) and premise-register.test.ts (dns mock +
 * the okResponse fetch fake — fetchPremiseSource reads res.body?.getReader()
 * and falls back to res.text() when body is falsy, so body:null + text()
 * below is the working shape). Hermetic: no real network (fetch always
 * stubbed), no real Redis, the one wall-clock path rides jest fake timers.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

// ── Prisma: the CRUD paths (create/findFirst/update), the view reads
//    (findMany), and the sweeper fire path (findMany due rows, the atomic
//    claim + skip/persist/bump writes via updateMany, the stale-firing
//    re-read via findUnique). ──
const mockCreate = jest.fn();
const mockCount = jest.fn();
const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateMany = jest.fn();
const mockDeleteMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 0 }));
const mockScheduleFindUnique = jest.fn(async (..._a: any[]): Promise<any> => ({ enabled: true }));
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-dg-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'ph-1' }));
// $transaction seam (ticket ae20da66): createSchedule wraps the create + the
// same-cadence collapse in ONE interactive transaction. The tx reuses this
// file's mock fns; the collapse's in-tx stale read gets its OWN mock defaulting
// to [] so pre-collapse tests behave exactly as before.
const mockStaleFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTransaction = jest.fn(async (fn: any) =>
  typeof fn === 'function'
    ? fn({
        chatSchedule: {
          create: (...a: any[]) => mockCreate(...a),
          findMany: (...a: any[]) => mockStaleFindMany(...a),
          updateMany: (...a: any[]) => mockUpdateMany(...a),
        },
      })
    : Promise.all(fn));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      create: (...a: any[]) => mockCreate(...a),
      count: (...a: any[]) => mockCount(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      findFirst: (...a: any[]) => mockFindFirst(...a),
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      update: (...a: any[]) => mockUpdate(...a),
      updateMany: (...a: any[]) => mockUpdateMany(...a),
      deleteMany: (...a: any[]) => mockDeleteMany(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      create: (...a: any[]) => mockRunCreate(...a),
      count: (...a: any[]) => mockRunCount(...a),
    },
    schedulePromptHistory: {
      findFirst: (...a: any[]) => mockPromptHistoryFindFirst(...a),
      count: (...a: any[]) => mockPromptHistoryCount(...a),
      create: (...a: any[]) => mockPromptHistoryCreate(...a),
    },
    $transaction: (fn: any) => mockTransaction(fn),
  },
}));

// ── Redis stand-in: the daily-cap counter (INCR), cap gates (SET NX), the
//    notice consume (GETDEL) and the infra-blocker registry read (HGETALL). ──
const mockStore = new Map<string, string>();
const mockIncr = jest.fn(async (...args: any[]) => {
  const k = String(args[0]);
  const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) + 1;
  mockStore.set(k, String(n));
  return n;
});
const mockDecr = jest.fn(async (...args: any[]) => {
  const k = String(args[0]);
  const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) - 1;
  mockStore.set(k, String(n));
  return n;
});
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: (...a: any[]) => mockIncr(...a),
    incrBy: jest.fn(async () => 1),
    decr: (...a: any[]) => mockDecr(...a),
    expire: jest.fn(async () => true),
    // store-backed NX semantics (FO firing 9's dead-source-alarm pin): the
    // once-per-crossing gate must be exercised honestly, not by stub returns.
    set: jest.fn(async (k: any, v: any, opts?: any) => {
      if (opts?.NX && mockStore.has(String(k))) return null;
      mockStore.set(String(k), String(v));
      return 'OK';
    }),
    del: jest.fn(async (k: any) => { mockStore.delete(String(k)); return 1; }),
    get: jest.fn(async () => null),
    getDel: jest.fn(async () => null),
    pTTL: jest.fn(async () => -2),
    publish: jest.fn(async () => 1),
    hGetAll: jest.fn(async () => ({})),
    hSet: jest.fn(async () => 1),
    hDel: jest.fn(async () => 0),
  },
}));

// fetchPremiseSource's SSRF guard DNS-checks every probe host — resolve them
// all to a public address (the guard's own matrix lives in
// premise-register.test.ts; here every probe host is legitimately public).
jest.mock('dns', () => ({
  promises: { lookup: jest.fn(async (..._a: any[]): Promise<any> => [{ address: '93.184.216.34', family: 4 }]) },
}));

// The daily-cap grant lookup (capForSession → autonomy.service dynamic import).
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  getChatAutonomy: jest.fn(async (..._a: any[]): Promise<any> => null),
}));

const mockEmitHookEvent = jest.fn(async (..._a: any[]): Promise<any> => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  emitHookEventSafe: (...a: any[]) => mockEmitHookEvent(...a),
  sweepHookEvents: (...a: any[]) => mockEmitHookEvent(...a),
}));

// The coding fire path (dynamic import in fireScheduleTarget).
const mockStartScheduledRun = jest.fn(async (..._a: any[]): Promise<any> => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

// Decision gate (delta_material) — OFF by default (hermetic, like the hooks
// suite); the WI-C outcome-label cases flip it to shadow per test.
const mockDecisionMode = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockDecide = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRecordDecisionOutcome = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  ...(jest.requireActual('../platform/decision-gate')),
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: () => mockDecisionMode(),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: (...a: any[]) => mockRecordDecisionOutcome(...a),
}));

// The plain-chat fire path (dynamic import in fireScheduleTarget).
const mockStartDetachedChatRun = jest.fn(async (..._a: any[]): Promise<boolean> => true);
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

// The terminal-stop resolver seam — no closed-ticket refs in these prompts.
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  getFeedbackTicketById: jest.fn(async (..._a: any[]): Promise<any> => null),
}));

// The continuation staleness guard's plan re-read (never reached here — no
// [HARNESS CONTINUATION] prompts — but the import must resolve).
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: jest.fn(async (..._a: any[]): Promise<any> => null),
}));

// Loop-metrics: fire-and-forget — silence it; kinds mirror the REAL registry
// (S-2 f79535306, 2026-10-08 REMOVED the delta-gate/busy-alarm/probe/rewrite
// kinds as unread — they are retired; never re-add them to this mock).
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    SWEEP_TICK: 'sweep_tick',
    WAKE_DELIVERED: 'wake_delivered',
    SCHEDULE_BUSY_SKIP: 'schedule_busy_skip',
    SCHEDULE_SWEEP_SKIP: 'schedule_sweep_skip',
  },
}));

// Sweep pre-triage (decision gate N2, 2026-09-25) — the leaf is mocked to the
// no-triage default; the wiring cases below drive it per test.
const mockPreTriageSweepFiring = jest.fn(async (..._a: any[]): Promise<any> => ({ sweep: null, decision: null, stash: null, skip: null }));
jest.mock('../platform/sweep-triage', () => ({
  __esModule: true,
  ...(jest.requireActual('../platform/sweep-triage')),
  preTriageSweepFiring: (...a: any[]) => mockPreTriageSweepFiring(...a),
}));

// The dormancy/goal gate (ticket b1d435fd) runs BEFORE the delta gate at fire
// time and in createSchedule for machine recurring arms — mocked live-work so
// these tests isolate the delta gate (its own suite covers the gate itself).
const mockEvaluateScheduleDormancy = jest.fn(async (..._a: any[]): Promise<any> => ({
  dormant: false, projectId: 'p1', reason: 'test: project has live work',
  signals: { activeGoals: 1, openTodos: 0, liveRuns: 0, watchedResources: 0 },
}));
jest.mock('./dormancy-gate.service', () => ({
  __esModule: true,
  DORMANT_LAST_STATUS: 'parked:dormant',
  evaluateScheduleDormancy: (...a: any[]) => mockEvaluateScheduleDormancy(...a),
}));

// The spend-cap gate also runs before the delta gate — default OFF (null).
// requireActual keeps the notice helpers real for the fire-path consume.
jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./spend-cap.service')),
  checkSpendCap: jest.fn(async (..._a: any[]): Promise<any> => null),
  recordSpendCapSkip: jest.fn(async (..._a: any[]) => {}),
  maybeAskSpendCapQuestion: jest.fn(async (..._a: any[]) => {}),
  consumeSpendCapSkipNotice: jest.fn(async (..._a: any[]): Promise<number> => 0),
  restoreSpendCapSkipNotice: jest.fn(async (..._a: any[]) => {}),
}));

// Lane-revival auto-resolve (createSchedule recurring path, dynamic import).
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: jest.fn(async (..._a: any[]): Promise<number> => 0),
  flagOwnerQuestion: jest.fn(async (..._a: any[]): Promise<any> => ({ kind: 'created', question: { id: 'oq_dg' } })),
}));

jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: jest.fn(),
  maybeFileStoppedScheduleDecision: jest.fn(async (..._a: any[]) => ({ filed: false, reason: 'lane_alive' })),
}));

import { Prisma } from '@prisma/client';
import {
  DELTA_GATE_MAX_PROBES,
  DELTA_GATE_DEFAULT_HEARTBEAT_HOURS,
  DELTA_GATE_MAX_HEARTBEAT_HOURS,
  DELTA_GATE_EVAL_TIMEOUT_MS,
  validateDeltaGate,
  parseStoredDeltaGate,
  evaluateDeltaGate,
  type DeltaGate,
} from './delta-gate.service';
import { createSchedule, updateScheduleForUser, listSchedulesForUser, fireDue, MIN_INTERVAL_SEC } from './schedule.service';

const NOW = new Date('2026-09-18T12:00:00.000Z');
const NOW_ISO = NOW.toISOString();
const SCORE_URL = 'https://bench.example/score.json';
const ERR_URL = 'https://bench.example/flaky.json';

/** The premise-register.test.ts fetch fake: body:null → fetchPremiseSource
 *  falls back to res.text(); headers.get is case-insensitive (extra header
 *  keys must be lowercase). */
const okResponse = (body: string, contentType = 'application/json', status = 200, headers: Record<string, string> = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k: string) => ({ 'content-type': contentType, ...headers })[k.toLowerCase()] ?? null },
  body: null,
  text: async () => body,
}) as any;

/** A valid caller-side probe (jsonPath reader on the bench score). */
const jsonProbe = (over: Record<string, unknown> = {}): any => ({ url: SCORE_URL, jsonPath: 'results.suite_mean', ...over });
/** A valid gate as validateDeltaGate/parseStoredDeltaGate/evaluateDeltaGate see it. */
const gateOf = (probeOver: Record<string, unknown> = {}, gateOver: Record<string, unknown> = {}): DeltaGate =>
  ({ probes: [jsonProbe(probeOver)], heartbeatHours: 6, ...gateOver }) as DeltaGate;
/** A fetchImpl routing the flaky URL to a rejection and everything else to the given body. */
const fetchImplFor = (body: string) => jest.fn(async (url: any): Promise<any> => {
  if (String(url).includes('flaky')) throw new Error('ECONNRESET');
  return okResponse(body);
}) as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
});

describe('constants', () => {
  it('pins the documented bounds', () => {
    expect(DELTA_GATE_MAX_PROBES).toBe(4);
    expect(DELTA_GATE_DEFAULT_HEARTBEAT_HOURS).toBe(6);
    expect(DELTA_GATE_MAX_HEARTBEAT_HOURS).toBe(168);
    expect(DELTA_GATE_EVAL_TIMEOUT_MS).toBe(25_000);
  });
});

describe('validateDeltaGate — STRICT write-time validation', () => {
  it('accepts a single jsonPath probe, a single pattern probe, and 4 probes; heartbeatHours defaults to 6', () => {
    const j = validateDeltaGate({ probes: [jsonProbe()] });
    expect(j.error).toBeUndefined();
    expect(j.gate).toEqual({ probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean' }], heartbeatHours: 6 });

    const p = validateDeltaGate({ probes: [{ url: 'https://bench.example/v.txt', pattern: 'Version:\\s*([\\d.]+)' }] });
    expect(p.error).toBeUndefined();
    expect(p.gate?.probes[0]).toEqual({ url: 'https://bench.example/v.txt', pattern: 'Version:\\s*([\\d.]+)' });

    const four = validateDeltaGate({ probes: [jsonProbe(), jsonProbe({ url: 'https://bench.example/a.json' }), jsonProbe({ url: 'https://bench.example/b.json' }), jsonProbe({ url: 'https://bench.example/c.json' })] });
    expect(four.error).toBeUndefined();
    expect(four.gate?.probes).toHaveLength(4);
  });

  it('accepts ≤8 headers with valid names and values ≤300 chars; heartbeatHours 1 and 168 bind, fractions round', () => {
    const headers: Record<string, string> = {};
    for (let i = 0; i < 8; i++) headers[`X-H${i}`] = `v${i}`;
    const h = validateDeltaGate({ probes: [jsonProbe({ headers })] });
    expect(h.error).toBeUndefined();
    expect(h.gate?.probes[0].headers).toEqual(headers);
    const maxed = validateDeltaGate({ probes: [jsonProbe({ headers: { Authorization: 'x'.repeat(300) } })] });
    expect(maxed.error).toBeUndefined();
    expect(validateDeltaGate({ probes: [jsonProbe()], heartbeatHours: 1 }).gate?.heartbeatHours).toBe(1);
    expect(validateDeltaGate({ probes: [jsonProbe()], heartbeatHours: 168 }).gate?.heartbeatHours).toBe(168);
    expect(validateDeltaGate({ probes: [jsonProbe()], heartbeatHours: 6.4 }).gate?.heartbeatHours).toBe(6);
  });

  it('refuses non-objects, empty/over-full probe lists and non-object probes with actionable errors', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(validateDeltaGate(bad).error).toMatch(/must be an object/);
    }
    expect(validateDeltaGate({}).error).toMatch(/1–4 probe/);
    expect(validateDeltaGate({ probes: [] }).error).toMatch(/1–4 probe/);
    const five = validateDeltaGate({ probes: [jsonProbe(), jsonProbe(), jsonProbe(), jsonProbe(), jsonProbe()] });
    expect(five.error).toMatch(/at most 4/);
    expect(validateDeltaGate({ probes: [null] }).error).toMatch(/probe\[0\] must be an object/);
    expect(validateDeltaGate({ probes: [[]] }).error).toMatch(/probe\[0\] must be an object/);
  });

  it('refuses non-https urls, credential-carrying urls and urls over 400 chars', () => {
    expect(validateDeltaGate({ probes: [jsonProbe({ url: 'http://bench.example/score.json' })] }).error).toMatch(/https only/);
    expect(validateDeltaGate({ probes: [jsonProbe({ url: 'not a url' })] }).error).toMatch(/must be an https URL/);
    expect(validateDeltaGate({ probes: [jsonProbe({ url: 'https://user:pw@bench.example/score.json' })] }).error).toMatch(/credentials|userinfo/);
    expect(validateDeltaGate({ probes: [jsonProbe({ url: `https://bench.example/${'a'.repeat(400)}` })] }).error).toMatch(/≤400/);
  });

  it('refuses BOTH readers and NEITHER reader; bad jsonPath shapes and bad patterns name the rule', () => {
    expect(validateDeltaGate({ probes: [jsonProbe({ pattern: '(\\d+)' })] }).error).toMatch(/not both/);
    expect(validateDeltaGate({ probes: [{ url: SCORE_URL }] }).error).toMatch(/exactly one reader/);
    expect(validateDeltaGate({ probes: [jsonProbe({ jsonPath: 'a..b' })] }).error).toMatch(/dot\/bracket path/);
    expect(validateDeltaGate({ probes: [jsonProbe({ jsonPath: 'x'.repeat(121) })] }).error).toMatch(/dot\/bracket path/);
    expect(validateDeltaGate({ probes: [{ url: SCORE_URL, pattern: 'x'.repeat(201) }] }).error).toMatch(/pattern too long/);
    expect(validateDeltaGate({ probes: [{ url: SCORE_URL, pattern: '(' }] }).error).toMatch(/not a valid regex/);
    expect(validateDeltaGate({ probes: [{ url: SCORE_URL, pattern: '(a+)+$' }] }).error).toMatch(/nested or stacked quantifiers/);
  });

  it('refuses >8 headers, bad header names, non-string values and over-long values', () => {
    const nine: Record<string, string> = {};
    for (let i = 0; i < 9; i++) nine[`X-H${i}`] = 'v';
    expect(validateDeltaGate({ probes: [jsonProbe({ headers: nine })] }).error).toMatch(/at most 8/);
    expect(validateDeltaGate({ probes: [jsonProbe({ headers: { 'Bad Name': 'v' } })] }).error).toMatch(/header name/);
    expect(validateDeltaGate({ probes: [jsonProbe({ headers: { 'X-H': 42 } })] }).error).toMatch(/must be a string/);
    expect(validateDeltaGate({ probes: [jsonProbe({ headers: { 'X-H': 'v'.repeat(301) } })] }).error).toMatch(/over 300 chars/);
    expect(validateDeltaGate({ probes: [jsonProbe({ headers: [] as any })] }).error).toMatch(/headers must be an object/);
  });

  it('refuses a non-number, <1 or >168 heartbeatHours', () => {
    expect(validateDeltaGate({ probes: [jsonProbe()], heartbeatHours: 'abc' }).error).toMatch(/must be a number/);
    expect(validateDeltaGate({ probes: [jsonProbe()], heartbeatHours: 0 }).error).toMatch(/1–168/);
    expect(validateDeltaGate({ probes: [jsonProbe()], heartbeatHours: 169 }).error).toMatch(/1–168/);
  });

  it('STRIPS caller-supplied marker/checkedAt/lastError — a re-arm always re-baselines', () => {
    const v = validateDeltaGate({
      probes: [jsonProbe({ marker: '60.07', checkedAt: '2026-09-18T00:00:00.000Z', lastError: 'boom' })],
      heartbeatHours: 12,
    });
    expect(v.error).toBeUndefined();
    expect(v.gate).toEqual({ probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean' }], heartbeatHours: 12 });
    expect(v.gate?.probes[0]).not.toHaveProperty('marker');
    expect(v.gate?.probes[0]).not.toHaveProperty('checkedAt');
    expect(v.gate?.probes[0]).not.toHaveProperty('lastError');
  });
});

describe('parseStoredDeltaGate — TOLERANT fire-time read', () => {
  it('null/garbage → null; a list with no usable probe → null', () => {
    expect(parseStoredDeltaGate(null)).toBeNull();
    expect(parseStoredDeltaGate(undefined)).toBeNull();
    expect(parseStoredDeltaGate('garbage')).toBeNull();
    expect(parseStoredDeltaGate(42)).toBeNull();
    expect(parseStoredDeltaGate([])).toBeNull();
    expect(parseStoredDeltaGate({})).toBeNull();
    expect(parseStoredDeltaGate({ probes: 'nope' })).toBeNull();
    expect(parseStoredDeltaGate({ probes: [] })).toBeNull();
    // every probe unusable: missing reader / non-https url / non-object
    expect(parseStoredDeltaGate({ probes: [{ url: SCORE_URL }] })).toBeNull();
    expect(parseStoredDeltaGate({ probes: [{ url: 'http://bench.example/a.json', jsonPath: 'v' }] })).toBeNull();
    expect(parseStoredDeltaGate({ probes: [null, 42, 'x'] })).toBeNull();
  });

  it('drops unusable probes but keeps the usable ones; marker/checkedAt/lastError strings survive', () => {
    const g = parseStoredDeltaGate({
      probes: [
        { url: 'http://bench.example/dropped.json', jsonPath: 'v' },
        jsonProbe({ marker: '60.07', checkedAt: NOW_ISO, lastError: 'boom' }),
      ],
      heartbeatHours: 12,
    });
    expect(g).not.toBeNull();
    expect(g?.probes).toHaveLength(1);
    expect(g?.probes[0]).toMatchObject({ url: SCORE_URL, jsonPath: 'results.suite_mean', marker: '60.07', checkedAt: NOW_ISO, lastError: 'boom' });
    expect(g?.heartbeatHours).toBe(12);
  });

  it('sanitizes stored headers: bad names dropped, values truncated to 300, capped at 8 entries (sliced BEFORE filtering)', () => {
    const headers: Record<string, unknown> = { 'Bad Name': 'x', 'X-Long': 'v'.repeat(500), 'X-Num': 42 };
    for (let i = 0; i < 9; i++) headers[`X-H${i}`] = `v${i}`;
    const g = parseStoredDeltaGate({ probes: [jsonProbe({ headers })] });
    expect(g).not.toBeNull();
    const h = g?.probes[0].headers ?? {};
    // the 8-entry cap slices the entries FIRST, then bad names/non-string
    // values drop — X-H5..X-H8 never even enter consideration
    expect(Object.keys(h)).toEqual(['X-Long', 'X-H0', 'X-H1', 'X-H2', 'X-H3', 'X-H4']);
    expect(Object.keys(h).length).toBeLessThanOrEqual(8);
    expect(h['X-Long']).toHaveLength(300);
    // a probe whose headers ALL sanitize away carries no headers key at all
    const g2 = parseStoredDeltaGate({ probes: [jsonProbe({ headers: { 'Bad Name': 'x' } })] });
    expect(g2?.probes[0]).not.toHaveProperty('headers');
  });

  it('clamps an out-of-range stored heartbeatHours to the 6h default; non-string platform fields drop', () => {
    expect(parseStoredDeltaGate({ probes: [jsonProbe()], heartbeatHours: 0 })?.heartbeatHours).toBe(6);
    expect(parseStoredDeltaGate({ probes: [jsonProbe()], heartbeatHours: 999 })?.heartbeatHours).toBe(6);
    expect(parseStoredDeltaGate({ probes: [jsonProbe()], heartbeatHours: 'x' })?.heartbeatHours).toBe(6);
    expect(parseStoredDeltaGate({ probes: [jsonProbe()], heartbeatHours: 12.6 })?.heartbeatHours).toBe(13);
    const g = parseStoredDeltaGate({ probes: [jsonProbe({ marker: 42, checkedAt: NOW_ISO })] });
    expect(g?.probes[0]).not.toHaveProperty('marker');
    expect(g?.probes[0].checkedAt).toBe(NOW_ISO);
  });
});

describe('evaluateDeltaGate — verdict precedence + reader semantics', () => {
  const evalGate = (g: DeltaGate, over: { lastFiredAt?: Date | null; fetchImpl?: any } = {}) =>
    evaluateDeltaGate(g, { now: NOW, lastFiredAt: over.lastFiredAt === undefined ? new Date(NOW.getTime() - 3600_000) : over.lastFiredAt, fetchImpl: over.fetchImpl });

  it('a probe with NO stored marker whose read succeeds FIRES baseline and returns the gate marker-stamped (input untouched)', async () => {
    const g = gateOf();
    const v = await evalGate(g, { fetchImpl: fetchImplFor('{"results":{"suite_mean":60.07}}') });
    expect(v).toMatchObject({ fire: true, reason: 'baseline', markersChanged: true });
    expect(v.detail).toContain('baseline established');
    expect(v.detail).toContain(SCORE_URL);
    expect(v.detail).toContain('60.07');
    expect(v.gate).not.toBe(g); // the working copy, never the caller's object
    expect(v.gate.probes[0].marker).toBe('60.07');
    expect(v.gate.probes[0].checkedAt).toBe(NOW_ISO);
    expect(g.probes[0].marker).toBeUndefined(); // the caller's gate is never mutated
  });

  it('observed ≠ marker FIRES delta, updates the marker and names the url + both values', async () => {
    const g = gateOf({ marker: '60.07' });
    const v = await evalGate(g, { fetchImpl: fetchImplFor('{"results":{"suite_mean":61.5}}') });
    expect(v).toMatchObject({ fire: true, reason: 'delta', markersChanged: true });
    expect(v.detail).toContain(SCORE_URL);
    expect(v.detail).toContain('60.07');
    expect(v.detail).toContain('61.5');
    expect(v.gate.probes[0].marker).toBe('61.5');
  });

  it('a fetch throw / non-ok status / extract error FIRES error (fail-open): old marker kept, lastError stamped, markersChanged reflects the stamp', async () => {
    // fetch throws
    const g1 = gateOf({ marker: '60.07' });
    const v1 = await evalGate(g1, { fetchImpl: jest.fn(async (): Promise<any> => { throw new Error('ECONNRESET'); }) as any });
    expect(v1).toMatchObject({ fire: true, reason: 'error', markersChanged: true });
    expect(v1.gate.probes[0].marker).toBe('60.07'); // the OLD marker survives
    expect(v1.gate.probes[0].lastError).toBe('ECONNRESET');
    expect(v1.detail).toContain(SCORE_URL);
    expect(v1.detail).toContain('ECONNRESET');

    // non-ok status
    const v2 = await evalGate(gateOf({ marker: '60.07' }), { fetchImpl: jest.fn(async () => okResponse('nope', 'text/plain', 500)) as any });
    expect(v2).toMatchObject({ fire: true, reason: 'error', markersChanged: true });
    expect(v2.gate.probes[0].lastError).toContain('HTTP 500');

    // extract error: jsonPath absent in the JSON body
    const v3 = await evalGate(gateOf({ marker: '60.07' }), { fetchImpl: fetchImplFor('{"results":{}}') });
    expect(v3).toMatchObject({ fire: true, reason: 'error', markersChanged: true });
    expect(v3.gate.probes[0].lastError).toContain('jsonPath "results.suite_mean" absent');

    // extract error: pattern does not match the text body
    const v4 = await evalGate(gateOf({ marker: '0.1.8', jsonPath: undefined, pattern: 'Version:\\s*([\\d.]+)' }), { fetchImpl: fetchImplFor('nothing here') });
    expect(v4).toMatchObject({ fire: true, reason: 'error', markersChanged: true });
    expect(v4.gate.probes[0].lastError).toBe('pattern did not match');
    expect(v4.gate.probes[0].marker).toBe('0.1.8');
  });

  it('an errored probe whose lastError is UNCHANGED reports markersChanged false (nothing new to persist)', async () => {
    const g = gateOf({ marker: '60.07', lastError: 'ECONNRESET' });
    const v = await evalGate(g, { fetchImpl: jest.fn(async (): Promise<any> => { throw new Error('ECONNRESET'); }) as any });
    expect(v).toMatchObject({ fire: true, reason: 'error', markersChanged: false });
    expect(v.gate.probes[0].marker).toBe('60.07');
  });

  it('a good read CLEARS a stored lastError (markersChanged true) and otherwise behaves unchanged', async () => {
    const g = gateOf({ marker: '60.07', lastError: 'ECONNRESET' });
    const v = await evalGate(g, { fetchImpl: fetchImplFor('{"results":{"suite_mean":60.07}}') });
    expect(v).toMatchObject({ fire: false, reason: 'unchanged', markersChanged: true }); // the clear must persist
    expect(v.gate.probes[0]).not.toHaveProperty('lastError');
    expect(v.gate.probes[0].marker).toBe('60.07');
  });

  it('all unchanged + lastFiredAt null FIRES heartbeat (never ran); older than heartbeatHours FIRES heartbeat; within → SKIP unchanged', async () => {
    const body = '{"results":{"suite_mean":60.07}}';
    const g = () => gateOf({ marker: '60.07' });
    const never = await evalGate(g(), { lastFiredAt: null, fetchImpl: fetchImplFor(body) });
    expect(never).toMatchObject({ fire: true, reason: 'heartbeat', markersChanged: false });
    expect(never.detail).toContain('never');
    expect(never.detail).toContain('6h heartbeat');

    const stale = await evalGate(g(), { lastFiredAt: new Date(NOW.getTime() - 7 * 3600_000), fetchImpl: fetchImplFor(body) });
    expect(stale).toMatchObject({ fire: true, reason: 'heartbeat', markersChanged: false });
    expect(stale.detail).toContain('7h ago');

    const fresh = await evalGate(g(), { lastFiredAt: new Date(NOW.getTime() - 3600_000), fetchImpl: fetchImplFor(body) });
    expect(fresh).toMatchObject({ fire: false, reason: 'unchanged', markersChanged: false });
    expect(fresh.gate.probes[0].checkedAt).toBe(NOW_ISO); // checkedAt still advances on the returned gate
    expect(g().probes[0].checkedAt).toBeUndefined();
  });

  it('the heartbeat floor honors a custom heartbeatHours (1h: a 2h-old firing is overdue)', async () => {
    const v = await evalGate(gateOf({ marker: '60.07' }, { heartbeatHours: 1 }), {
      lastFiredAt: new Date(NOW.getTime() - 2 * 3600_000),
      fetchImpl: fetchImplFor('{"results":{"suite_mean":60.07}}'),
    });
    expect(v).toMatchObject({ fire: true, reason: 'heartbeat' });
    expect(v.detail).toContain('1h heartbeat');
  });

  it('jsonPath reader: numbers/booleans stringify, objects JSON.stringify; pattern reader: first capture group beats the whole match', async () => {
    const num = await evalGate(gateOf(), { fetchImpl: fetchImplFor('{"results":{"suite_mean":60.07}}') });
    expect(num.gate.probes[0].marker).toBe('60.07');
    const bool = await evalGate(gateOf(), { fetchImpl: fetchImplFor('{"results":{"suite_mean":true}}') });
    expect(bool.gate.probes[0].marker).toBe('true');
    const obj = await evalGate(gateOf(), { fetchImpl: fetchImplFor('{"results":{"suite_mean":{"a":1}}}') });
    expect(obj.gate.probes[0].marker).toBe('{"a":1}');

    const grouped = await evalGate(gateOf({ jsonPath: undefined, pattern: 'Version:\\s*([\\d.]+)' }), { fetchImpl: fetchImplFor('Version: 0.1.9 (stable)') });
    expect(grouped.gate.probes[0].marker).toBe('0.1.9');
    const whole = await evalGate(gateOf({ jsonPath: undefined, pattern: 'v\\d+\\.\\d+' }), { fetchImpl: fetchImplFor('release v1.2 out') });
    expect(whole.gate.probes[0].marker).toBe('v1.2');
  });

  it('verdict precedence across multiple probes: a baseline beats an error; all-unchanged skips only when EVERY probe holds', async () => {
    // probe[0] baselines (reads fine, no marker) while probe[1] errors → baseline verdict
    const g: DeltaGate = { probes: [jsonProbe(), jsonProbe({ url: ERR_URL, marker: '60.07' })], heartbeatHours: 6 } as DeltaGate;
    const v = await evalGate(g, { fetchImpl: fetchImplFor('{"results":{"suite_mean":60.07}}') });
    expect(v).toMatchObject({ fire: true, reason: 'baseline' });
    expect(v.gate.probes[0].marker).toBe('60.07');
    expect(v.gate.probes[1].lastError).toBe('ECONNRESET');
    expect(v.gate.probes[1].marker).toBe('60.07'); // errored probe keeps its marker

    // one of two probes changed → delta
    const g2: DeltaGate = { probes: [jsonProbe({ marker: '60.07' }), jsonProbe({ url: 'https://bench.example/other.json', marker: 'stale' })], heartbeatHours: 6 } as DeltaGate;
    const v2 = await evalGate(g2, { fetchImpl: fetchImplFor('{"results":{"suite_mean":60.07}}') });
    expect(v2).toMatchObject({ fire: true, reason: 'delta' });
    expect(v2.detail).toContain('https://bench.example/other.json');
  });

  it('probe headers ride the fetch (auth secrets reach the request; the verdict gate carries them back for persistence)', async () => {
    const fetchImpl = jest.fn(async () => okResponse('{"results":{"suite_mean":60.07}}')) as any;
    const g = gateOf({ headers: { Authorization: 'Bearer test-token-123' } });
    const v = await evalGate(g, { fetchImpl });
    expect(v).toMatchObject({ fire: true, reason: 'baseline' });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token-123');
    expect(fetchImpl.mock.calls[0][1].headers['user-agent']).toContain('digby-premise-check'); // defaults under the caller's
    // the returned gate is an INTERNAL persist surface — headers must survive
    // the round-trip or the next evaluation would lose auth; REDACTION is
    // pinned at the ScheduleView read surface below, not here.
    expect(v.gate.probes[0].headers).toEqual({ Authorization: 'Bearer test-token-123' });
  });

  it('the 25s evaluation timeout FIRES error with the ORIGINAL gate object returned (a never-resolving fetch leaves nothing half-written)', async () => {
    jest.useFakeTimers();
    try {
      const hanging = jest.fn((_u: any, _o: any) => new Promise(() => {})) as any;
      const g = gateOf({ marker: '60.07' });
      const pending = evaluateDeltaGate(g, { now: NOW, lastFiredAt: new Date(NOW.getTime() - 3600_000), fetchImpl: hanging });
      await jest.advanceTimersByTimeAsync(DELTA_GATE_EVAL_TIMEOUT_MS + 1);
      const v = await pending;
      expect(v).toMatchObject({ fire: true, reason: 'error', markersChanged: false });
      expect(v.detail).toContain('timed out');
      expect(v.gate).toBe(g); // the caller's gate, untouched — not the working copy
      expect(v.gate.probes[0].marker).toBe('60.07');
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── schedule.service integration ─────────────────────────────────────────────

/** A live recurring row as the sweeper/service sees it, with a delta gate armed. */
const STORED_GATE = {
  probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean', marker: '60.07' }],
  heartbeatHours: 6,
};
const liveRow = (over: Record<string, unknown> = {}) => ({
  id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'watch the bench score', kind: 'recurring',
  intervalSec: 3600, nextRunAt: new Date(Date.now() + 3600_000), enabled: true,
  runsCount: 3, maxRuns: 500, expiresAt: new Date(Date.now() + 10 * 24 * 3600 * 1000),
  lastFiredAt: new Date(Date.now() - 3600_000), lastStatus: 'started', createdAt: new Date(),
  promptSetBy: 'machine', ...over,
});

// Arms below use intervalSec: 3600 (24/day), NOT MIN_INTERVAL_SEC: the
// cap-cadence guard (ticket 2694a581) REFUSES machine 15m recurring arms
// (96/day > the default 48/day cap) before the delta-gate validation runs.
describe('createSchedule — delta gate arm rules', () => {
  beforeEach(() => {
    mockCount.mockResolvedValue(0);
    mockFindMany.mockResolvedValue([]); // the machine duplicate-backstop scan
    mockCreate.mockImplementation(({ data }: any) => Promise.resolve({
      id: 'sch_new', ...data, lastFiredAt: null, lastStatus: null, runsCount: 0, createdAt: new Date(),
    }));
  });

  it("kind 'once' + deltaGate → refused (a one-shot has nothing to skip), no row created", async () => {
    const r = await createSchedule({ sessionId: 's1', userId: 'u1', prompt: 'one shot', kind: 'once', intervalSec: MIN_INTERVAL_SEC, deltaGate: { probes: [jsonProbe()] } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/recurring/);
    expect(r.error).toMatch(/No schedule was created/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('recurring + valid deltaGate → created MARKERLESS (caller markers stripped); the returned view redacts header values', async () => {
    const r = await createSchedule({
      sessionId: 's1', userId: 'u1', prompt: 'watch the bench score', kind: 'recurring', intervalSec: 3600,
      promptSetBy: 'machine',
      deltaGate: { probes: [jsonProbe({ headers: { Authorization: 'create-secret-value' }, marker: '60.07', checkedAt: NOW_ISO, lastError: 'x' })], heartbeatHours: 12 },
    });
    expect(r.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const stored = mockCreate.mock.calls[0][0].data.deltaGate;
    expect(stored).toEqual({ probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean', headers: { Authorization: 'create-secret-value' } }], heartbeatHours: 12 });
    // the read surface carries header NAMES only — the secret never leaves the row
    const view = r.schedule as any;
    expect(view.deltaGate.probes[0].headers).toEqual(['Authorization']);
    expect(JSON.stringify(view)).not.toContain('create-secret-value');
  });

  it('recurring + INVALID deltaGate (http url) → refused with the rule named, no create call', async () => {
    const r = await createSchedule({
      sessionId: 's1', userId: 'u1', prompt: 'watch the bench score', kind: 'recurring', intervalSec: 3600,
      promptSetBy: 'machine',
      deltaGate: { probes: [jsonProbe({ url: 'http://bench.example/score.json' })] },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https only/);
    expect(r.error).toMatch(/No schedule was created/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // Review finding F3 (0b1dbe75): the machine duplicate-backstop guard used to
  // return the existing row BEFORE the gate was ever read — a re-arm carrying
  // a new gate was silently dropped while the caller believed it armed.
  it('F3: deduped re-arm with a DIFFERENT gate → (re)armed MARKERLESS on the existing row (gateUpdated), nothing created', async () => {
    const dupe = liveRow({ id: 'sch_dup', deltaGate: { probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean', marker: '60.07', checkedAt: NOW_ISO }], heartbeatHours: 6 } });
    mockFindMany.mockResolvedValue([dupe]);
    mockUpdate.mockImplementation(async ({ data }: any) => ({ ...dupe, ...data }));
    const r = await createSchedule({
      sessionId: 's1', userId: 'u1', prompt: 'WATCH   the bench score', kind: 'recurring', intervalSec: 3600, // normalized-identical prompt
      promptSetBy: 'machine',
      deltaGate: { probes: [jsonProbe()], heartbeatHours: 24 }, // differs (24h vs stored 6h)
    });
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.gateUpdated).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].where).toEqual({ id: 'sch_dup' });
    expect(mockUpdate.mock.calls[0][0].data.deltaGate).toEqual({ probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean' }], heartbeatHours: 24 }); // markerless → re-baseline
  });

  it('F3: deduped re-arm with the SAME gate (stored platform fields aside) → left untouched — no re-baseline churn', async () => {
    const stored = { probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean', marker: '60.07', checkedAt: NOW_ISO, lastError: 'stale' }], heartbeatHours: 6 };
    mockFindMany.mockResolvedValue([liveRow({ id: 'sch_dup', deltaGate: stored })]);
    const r = await createSchedule({
      sessionId: 's1', userId: 'u1', prompt: 'watch the bench score', kind: 'recurring', intervalSec: 3600,
      promptSetBy: 'machine',
      deltaGate: { probes: [jsonProbe({ marker: 'caller-junk-that-is-stripped' })], heartbeatHours: 6 },
    });
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.gateUpdated).toBe(false);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('F3: deduped re-arm with an INVALID gate → the whole arm refuses BEFORE the dedup return (nothing created, nothing updated)', async () => {
    mockFindMany.mockResolvedValue([liveRow({ id: 'sch_dup' })]);
    const r = await createSchedule({
      sessionId: 's1', userId: 'u1', prompt: 'watch the bench score', kind: 'recurring', intervalSec: 3600,
      promptSetBy: 'machine',
      deltaGate: { probes: [jsonProbe({ url: 'http://bench.example/score.json' })] },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https only/);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("F3: deduped re-arm WITHOUT a gate → the existing row's gate is left untouched (clearing is update_schedule's job)", async () => {
    const stored = { probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean', marker: '60.07' }], heartbeatHours: 6 };
    mockFindMany.mockResolvedValue([liveRow({ id: 'sch_dup', deltaGate: stored })]);
    const r = await createSchedule({
      sessionId: 's1', userId: 'u1', prompt: 'watch the bench score', kind: 'recurring', intervalSec: 3600,
      promptSetBy: 'machine',
    });
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.gateUpdated).toBeUndefined();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('updateScheduleForUser — delta gate replace/clear rules', () => {
  beforeEach(() => {
    mockFindFirst.mockImplementation(async ({ where }: any) =>
      where?.id === 'sch_1' && where?.userId === 'u1' ? liveRow() : null);
    mockUpdate.mockImplementation(async ({ data }: any) => ({ ...liveRow(), ...data }));
  });

  it('deltaGate: null CLEARS the gate via Prisma.DbNull', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { deltaGate: null });
    expect(r.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].data.deltaGate).toBe(Prisma.DbNull);
  });

  it('an INVALID gate refuses the whole update — nothing is written', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', { deltaGate: { probes: [jsonProbe({ url: 'http://bench.example/score.json' })] } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/https only/);
    expect(r.error).toMatch(/Nothing was updated/);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("a valid gate on a 'once' row is refused (nothing to skip)", async () => {
    mockFindFirst.mockImplementation(async ({ where }: any) =>
      where?.id === 'sch_1' && where?.userId === 'u1' ? liveRow({ kind: 'once' }) : null);
    const r = await updateScheduleForUser('u1', 'sch_1', { deltaGate: { probes: [jsonProbe()] } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/recurring/);
    expect(r.error).toMatch(/Nothing was updated/);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('a valid gate on a recurring row lands MARKERLESS — the next evaluation re-baselines', async () => {
    const r = await updateScheduleForUser('u1', 'sch_1', {
      deltaGate: { probes: [jsonProbe({ marker: '60.07', checkedAt: NOW_ISO })], heartbeatHours: 24 },
    });
    expect(r.ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].data.deltaGate).toEqual({
      probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean' }],
      heartbeatHours: 24,
    });
  });
});

describe('sweepTickBody (fireDue) — the fire-time delta gate', () => {
  const dueRow = (over: Record<string, unknown> = {}) => liveRow({
    nextRunAt: new Date(Date.now() - 1000), // due
    deltaGate: STORED_GATE,
    ...over,
  });
  let fetchSpy: jest.SpyInstance;
  const mockFetch = jest.fn(async (..._a: any[]): Promise<any> => okResponse('{"results":{"suite_mean":60.07}}'));
  /** updateMany calls whose data carries a deltaGate write (persist) or a runsCount bump. */
  const uMany = (pred: (data: any) => boolean) => mockUpdateMany.mock.calls.map((c) => c[0]).filter((u) => pred(u?.data));

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(mockFetch as any);
    // A per-test mockResolvedValue/mockRejectedValue would LEAK into later
    // tests — reset and re-seat the default 60.07 body every case.
    mockFetch.mockReset().mockImplementation(async () => okResponse('{"results":{"suite_mean":60.07}}'));
    mockFindMany.mockResolvedValue([dueRow()]);
    mockUpdateMany.mockResolvedValue({ count: 1 }); // the atomic claim always wins
    mockUpdate.mockResolvedValue({});
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockResolvedValue({ started: true });
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('UNCHANGED probes → the model run NEVER starts: skip write stamped, no runsCount bump', async () => {
    await fireDue();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe(SCORE_URL);
    const skips = uMany((d) => d?.lastStatus === 'skipped:delta_unchanged');
    expect(skips).toHaveLength(1);
    expect(skips[0].where).toMatchObject({ id: 'sch_1', deltaGate: { equals: STORED_GATE } }); // the optimistic Json-equals guard
    expect(skips[0].data.deltaGate.probes[0].marker).toBe('60.07');
    expect(skips[0].data.deltaGate.probes[0].checkedAt).toBeDefined();
    expect(uMany((d) => d?.runsCount != null)).toHaveLength(0); // no run/maxRuns budget consumed
    expect(mockUpdate.mock.calls.filter((c) => c[0]?.data?.runsCount != null)).toHaveLength(0);
  });

  it('a CHANGED marker → the fire proceeds and the fresh markers persist via updateMany BEFORE the post-fire bump', async () => {
    mockFetch.mockResolvedValue(okResponse('{"results":{"suite_mean":61.5}}') as any);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun.mock.calls[0][0]).toBe('s1');
    expect(String(mockStartScheduledRun.mock.calls[0][1])).toContain('watch the bench score');
    const persists = uMany((d) => d?.deltaGate?.probes?.[0]?.marker === '61.5');
    expect(persists).toHaveLength(1);
    expect(persists[0].where).toMatchObject({ id: 'sch_1', deltaGate: { equals: STORED_GATE } });
    const bumps = uMany((d) => d?.runsCount === 4 && d?.lastStatus === 'started');
    expect(bumps).toHaveLength(1);
    // the persist lands BEFORE the bump (a crash must not lose a baseline)
    const all = mockUpdateMany.mock.calls.map((c) => c[0]);
    expect(all.indexOf(persists[0])).toBeLessThan(all.indexOf(bumps[0]));
    expect(uMany((d) => d?.lastStatus === 'skipped:delta_unchanged')).toHaveLength(0);
  });

  describe('WI-C (2026-09-25): delta_material outcome label rides the fired run', () => {
    const GATE_ANSWER = { id: 'dm1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 7, answers: { material: { type: 'noul', noul: 0.93 } } };
    beforeEach(() => {
      mockDecisionMode.mockReturnValue('shadow');
      mockDecide.mockResolvedValue(GATE_ANSWER);
      mockFetch.mockResolvedValue(okResponse('{"results":{"suite_mean":61.5}}') as any); // a CHANGED marker → verdict 'delta'
    });
    afterEach(() => {
      mockDecisionMode.mockReturnValue('off');
      mockDecide.mockResolvedValue(null);
    });

    it('SHADOW + delta → the fire proceeds unchanged, the stash rides startScheduledRun opts.decision, and NO outcome row is written here', async () => {
      await fireDue();
      expect(mockDecide).toHaveBeenCalledTimes(1);
      expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'delta_material', sessionId: 's1' });
      expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
      const opts = mockStartScheduledRun.mock.calls[0][2];
      expect(opts).toMatchObject({ origin: 'schedule', scheduleId: 'sch_1' });
      expect(opts.decision).toMatchObject({ id: 'dm1', purpose: 'delta_material', mode: 'shadow', backend: 'TypeSafe Jev', answers: { material: { type: 'noul', noul: 0.93 } } });
      expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
      expect(uMany((d) => d?.runsCount === 4 && d?.lastStatus === 'started')).toHaveLength(1); // the firing itself is untouched
    });

    it('a BUSY lane closes the decision here, unlabelled (actual null, "not started: busy") — the re-arm re-judges a fresh delta', async () => {
      mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
      await fireDue();
      expect(mockRecordDecisionOutcome).toHaveBeenCalledTimes(1);
      const [decision, purpose, outcome] = mockRecordDecisionOutcome.mock.calls[0];
      expect(decision).toMatchObject({ id: 'dm1', mode: 'shadow', backend: 'TypeSafe Jev' });
      expect(purpose).toBe('delta_material');
      expect(outcome).toMatchObject({ question: 'material', actual: null, acted: false, sessionId: 's1', note: 'not started: busy' });
    });

    it('an UNCHANGED marker never reaches the materiality gate (no decide call, no stash) — the cheap skip is unchanged', async () => {
      mockFetch.mockResolvedValue(okResponse('{"results":{"suite_mean":60.07}}') as any);
      await fireDue();
      expect(mockDecide).not.toHaveBeenCalled();
      expect(mockStartScheduledRun).not.toHaveBeenCalled();
    });
  });

  it('a gate without markers → the first evaluation FIRES (baseline) and persists the fresh marker', async () => {
    mockFindMany.mockResolvedValue([dueRow({
      deltaGate: { probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean' }], heartbeatHours: 6 },
    })]);
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    const persists = uMany((d) => d?.deltaGate?.probes?.[0]?.marker === '60.07');
    expect(persists).toHaveLength(1);
  });

  it('a probe error FAILS OPEN: the fire proceeds, the errored probe keeps its marker and persists lastError', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    const persists = uMany((d) => typeof d?.deltaGate?.probes?.[0]?.lastError === 'string');
    expect(persists).toHaveLength(1);
    expect(persists[0].data.deltaGate.probes[0].marker).toBe('60.07');
    expect(persists[0].data.deltaGate.probes[0].lastError).toContain('ECONNRESET');
    expect(uMany((d) => d?.lastStatus === 'skipped:delta_unchanged')).toHaveLength(0);
  });

  it('a one-shot row carrying a gate is never gated (delta gate is recurring-only at fire time too)', async () => {
    mockFindMany.mockResolvedValue([dueRow({ kind: 'once', maxRuns: 1, runsCount: 0 })]);
    await fireDue();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
  });

  // Review finding F1 (0b1dbe75): dailyCapExceeded reserves its token
  // INCR-first — a delta skip started NO run, so the speculative token must be
  // refunded exactly like the busy/error paths (feedback 94bb9c2f drained
  // 85/144 tokens on 4 real runs the last time this leak existed).
  it('F1: an UNCHANGED skip REFUNDS the speculative daily-cap token (decr on the fires key)', async () => {
    await fireDue();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockDecr).toHaveBeenCalledTimes(1);
    expect(mockDecr).toHaveBeenCalledWith('coding:sched:fires:s1');
  });

  // Review finding F2 (0b1dbe75): a delta that lands on a BUSY lane must NOT
  // persist the fresh marker — persisting pre-fire let the +3-min re-arm read
  // the new marker as "unchanged" and silently drop the wake the delta existed
  // to trigger (and the busy-alarm streak died with it).
  it('F2: a CHANGED marker on a BUSY lane persists NOTHING — the re-arm re-detects the delta and re-attempts the fire', async () => {
    mockFetch.mockResolvedValue(okResponse('{"results":{"suite_mean":61.5}}') as any);
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1); // the fire was ATTEMPTED
    expect(uMany((d) => d?.deltaGate != null)).toHaveLength(0); // NO marker persist (started-only now)
    expect(uMany((d) => d?.lastStatus === 'skipped:delta_unchanged')).toHaveLength(0);
    expect(uMany((d) => d?.runsCount != null)).toHaveLength(0);
    // the observed value appears in NO write at all — the OLD marker stays stored
    const allWriteData = [...mockUpdateMany.mock.calls.map((c) => c[0]?.data), ...mockUpdate.mock.calls.map((c) => c[0]?.data)];
    expect(JSON.stringify(allWriteData)).not.toContain('61.5');
    // the normal busy path ran untouched: refund + skipped:busy + streak bump
    expect(mockDecr).toHaveBeenCalledWith('coding:sched:fires:s1');
    expect(mockUpdate.mock.calls.some((c) => c[0]?.data?.lastStatus === 'skipped:busy' && c[0]?.data?.busySkips != null)).toBe(true);
    // …and a SECOND sweep with the lane now free re-detects the SAME delta and fires
    mockUpdateMany.mockClear(); mockUpdate.mockClear(); mockDecr.mockClear();
    mockStartScheduledRun.mockResolvedValue({ started: true });
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(2);
    const persists = uMany((d) => d?.deltaGate?.probes?.[0]?.marker === '61.5');
    expect(persists).toHaveLength(1); // markers persist on the real start
  });

  // ── Dead-source alarm (FO firing 9, 2026-09-23) ─────────────────────────────
  // The canlegal-bench case: a deleted repo's api.github.com URL 404ed for 16
  // consecutive firings (~3-min cadence) before anything noticed — each firing
  // a full fail-open model run. Pinned here:
  //   1. error verdicts increment a per-schedule Redis streak; the 3rd crossing
  //      emits ONE attention_needed (NX-gated) and flips lastStatus.
  //   2. errors PAST the crossing never re-emit (no spam) but the schedule
  //      keeps firing FAIL-OPEN.
  //   3. a clean evaluation (unchanged / baseline / delta) RESETS the streak +
  //      the NX gate — a recovered source never alarms; a re-dying source does.
  describe('dead-source alarm (FO firing 9)', () => {
    const statusWrites = () => mockUpdate.mock.calls.map((c) => c[0]?.data).filter((d) => d?.lastStatus === 'alarm:delta_gate_errors');
    // emitHookEventSafe(sessionId, eventType, summary, extra) — positional args
    const attnCalls = () => mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'attention_needed');

    beforeEach(() => {
      mockFindMany.mockResolvedValue([dueRow()]);
      mockUpdateMany.mockResolvedValue({ count: 1 });
    });

    it('the 3rd CONSECUTIVE error verdict → ONE attention_needed + lastStatus flip; errors 1–2 alarm nothing', async () => {
      mockFetch.mockReset().mockImplementation(async () => okResponse('gone', 'application/json', 404));
      for (let i = 0; i < 3; i++) {
        mockUpdateMany.mockClear(); mockUpdate.mockClear(); mockRecordLoopMetric.mockClear(); mockEmitHookEvent.mockClear();
        await fireDue();
        expect(mockStartScheduledRun).toHaveBeenCalledTimes(i + 1); // ALWAYS fail-open
        if (i < 2) {
          expect(attnCalls()).toHaveLength(0); // below the crossing: no alarm
        }
      }
      // 3rd iteration = the crossing
      expect(statusWrites()).toHaveLength(1);
      expect(attnCalls()).toHaveLength(1);
      expect(attnCalls()[0][0]).toBe('s1'); // targeted at the schedule's own lane
      expect(String(attnCalls()[0][2])).toContain('3 firings in a row');
      expect(JSON.stringify(attnCalls()[0])).toContain('404'); // the failing probe's detail rides the payload
    });

    it('errors PAST the crossing never re-emit the attention event (NX gate) — but the firing stays fail-open', async () => {
      mockFetch.mockReset().mockImplementation(async () => okResponse('gone', 'application/json', 404));
      for (let i = 0; i < 5; i++) {
        mockEmitHookEvent.mockClear(); mockRecordLoopMetric.mockClear(); mockUpdate.mockClear();
        await fireDue();
      }
      expect(mockStartScheduledRun).toHaveBeenCalledTimes(5); // every firing ran
      expect(attnCalls()).toHaveLength(0); // no spam past the crossing
      // the digest-visible lastStatus flip is safe to repeat (same value)
      expect(statusWrites()).toHaveLength(1);
    });

    it('a CLEAN evaluation (unchanged) resets the streak and the NX gate — a re-dying source re-alarms on its NEXT 3rd error', async () => {
      // 3 errors → alarm armed
      mockFetch.mockReset().mockImplementation(async () => okResponse('gone', 'application/json', 404));
      for (let i = 0; i < 3; i++) await fireDue();
      expect(attnCalls()).toHaveLength(1);
      // source recovers: one clean unchanged evaluation resets the streak + gate
      mockFetch.mockReset().mockImplementation(async () => okResponse('{"results":{"suite_mean":60.07}}'));
      mockStartScheduledRun.mockClear(); mockEmitHookEvent.mockClear(); mockRecordLoopMetric.mockClear();
      await fireDue();
      expect(mockStartScheduledRun).not.toHaveBeenCalled(); // unchanged → skip
      expect(attnCalls()).toHaveLength(0);
      // source dies again: 3 more errors must re-alarm (fresh streak)
      mockFetch.mockReset().mockImplementation(async () => okResponse('gone', 'application/json', 404));
      mockStartScheduledRun.mockClear();
      for (let i = 0; i < 3; i++) {
        mockEmitHookEvent.mockClear(); mockRecordLoopMetric.mockClear();
        await fireDue();
      }
      expect(attnCalls()).toHaveLength(1); // re-armed after the reset
      expect(String(attnCalls()[0][2])).toContain('3 firings in a row'); // the FRESH streak's crossing, not 6
    });
  });
});

describe('ScheduleView redaction — header values never leave the row', () => {
  // toView is not exported; redactDeltaGate is pinned through the exported
  // listSchedulesForUser read surface (it maps rows through toView).
  it('listSchedulesForUser surfaces header NAMES only — the secret appears NOWHERE in the view JSON', async () => {
    const row = liveRow({
      deltaGate: {
        probes: [{ url: SCORE_URL, jsonPath: 'results.suite_mean', headers: { Authorization: 'list-secret-value' }, marker: '60.07', checkedAt: NOW_ISO }],
        heartbeatHours: 6,
      },
    });
    mockFindMany.mockImplementation(async ({ where }: any) => (where?.enabled === true ? [row] : []));
    const views = await listSchedulesForUser('u1');
    expect(views).toHaveLength(1);
    const gateView = views[0].deltaGate as any;
    expect(gateView.probes[0].headers).toEqual(['Authorization']);
    expect(gateView.probes[0]).toMatchObject({ url: SCORE_URL, jsonPath: 'results.suite_mean', marker: '60.07', checkedAt: NOW_ISO });
    expect(gateView.heartbeatHours).toBe(6);
    expect(JSON.stringify(views)).not.toContain('list-secret-value');
  });

  it('a row with no gate surfaces deltaGate: null', async () => {
    mockFindMany.mockImplementation(async ({ where }: any) => (where?.enabled === true ? [liveRow()] : []));
    const views = await listSchedulesForUser('u1');
    expect(views[0].deltaGate).toBeNull();
  });
});

describe('sweepTickBody (fireDue) — sweep pre-triage wiring (decision gate N2, 2026-09-25)', () => {
  const SWEEP_PROMPT = 'Fleet Supervisor sweep — a GOAL LEDGER diff, not a status bulletin.';
  const sweepRow = (over: Record<string, unknown> = {}) => liveRow({ prompt: SWEEP_PROMPT, intervalSec: 7200, nextRunAt: new Date(Date.now() - 1000), deltaGate: null, lastStatus: 'skipped:sweep_quiet:1', ...over });
  const STASH = { id: 'st1', purpose: 'sweep_triage', mode: 'shadow', backend: 'TypeSafe Jev', answers: { needs_turn_now: { type: 'noul', noul: 0.06 } }, decidedAt: '2026-09-25T12:00:00.000Z' };
  const uMany = (pred: (data: any) => boolean) => mockUpdateMany.mock.calls.map((c) => c[0]).filter((u) => pred(u?.data));

  beforeEach(() => {
    mockFindMany.mockResolvedValue([sweepRow()]);
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockUpdate.mockResolvedValue({});
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockResolvedValue({ started: true });
    mockPreTriageSweepFiring.mockResolvedValue({ sweep: null, decision: null, stash: null, skip: null });
  });

  it('the leaf is consulted with the due row facts (id, sessionId, prompt, lastFiredAt, intervalSec, lastStatus); no triage → the firing is byte-identical', async () => {
    await fireDue();
    expect(mockPreTriageSweepFiring).toHaveBeenCalledTimes(1);
    expect(mockPreTriageSweepFiring.mock.calls[0][0]).toMatchObject({ id: 'sch_1', sessionId: 's1', prompt: SWEEP_PROMPT, intervalSec: 7200, lastStatus: 'skipped:sweep_quiet:1' });
    expect(mockPreTriageSweepFiring.mock.calls[0][0].lastFiredAt).toBeInstanceOf(Date);
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun.mock.calls[0][2].decision).toBeUndefined();
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
  });

  it('SHADOW: the sweep_triage stash rides startScheduledRun opts.decision and no outcome row is written here', async () => {
    mockPreTriageSweepFiring.mockResolvedValue({ sweep: 'fleet', decision: { id: 'st1' }, stash: STASH, skip: null });
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun.mock.calls[0][2].decision).toEqual(STASH);
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled();
    expect(uMany((d) => d?.runsCount === 4 && d?.lastStatus === 'started')).toHaveLength(1); // the firing itself is untouched
  });

  it('a BUSY lane closes the sweep_triage decision here, unlabelled, under its own purpose + question', async () => {
    mockPreTriageSweepFiring.mockResolvedValue({ sweep: 'fleet', decision: { id: 'st1' }, stash: STASH, skip: null });
    mockStartScheduledRun.mockResolvedValue({ started: false, reason: 'busy' });
    await fireDue();
    expect(mockRecordDecisionOutcome).toHaveBeenCalledTimes(1);
    const [decision, purpose, outcome] = mockRecordDecisionOutcome.mock.calls[0];
    expect(decision).toMatchObject({ id: 'st1', mode: 'shadow', backend: 'TypeSafe Jev' });
    expect(purpose).toBe('sweep_triage');
    expect(outcome).toMatchObject({ question: 'needs_turn_now', actual: null, acted: false, sessionId: 's1', note: 'not started: busy' });
  });

  it('ACT (designed, not enabled): a skip verdict stamps skipped:sweep_quiet:<n>, refunds the cap token, records the metric and starts NO run', async () => {
    mockPreTriageSweepFiring.mockResolvedValue({ sweep: 'fleet', decision: { id: 'st1' }, stash: null, skip: { needsTurn: 0.04, consecutive: 2, sweep: 'fleet' } });
    await fireDue();
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls.some((c) => c[0]?.where?.id === 'sch_1' && c[0]?.data?.lastStatus === 'skipped:sweep_quiet:2')).toBe(true);
    expect(uMany((d) => d?.runsCount != null)).toHaveLength(0); // no run/maxRuns budget consumed
    expect(mockDecr).toHaveBeenCalled(); // the daily-cap token refunded
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'schedule_sweep_skip', sessionId: 's1', meta: expect.objectContaining({ scheduleId: 'sch_1', sweep: 'fleet', needsTurn: 0.04, consecutive: 2 }) }));
    expect(mockRecordDecisionOutcome).not.toHaveBeenCalled(); // the leaf recorded acted:true itself
  });

  it('a THROWING leaf fails open — the sweep fires exactly as before', async () => {
    mockPreTriageSweepFiring.mockRejectedValue(new Error('leaf boom'));
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun.mock.calls[0][2].decision).toBeUndefined();
  });
});
