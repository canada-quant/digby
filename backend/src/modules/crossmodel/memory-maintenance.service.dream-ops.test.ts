/**
 * 2026-10-20 memory upgrade — the user "dream" becomes per-item ops and reaches
 * every active user.
 *
 * LOG-SIGNAL 1822cc89 (2026-10-23, family lane ecc2bb0d): this suite's rows
 * also pin the FIXED "dream failed for user <uuid> (non-fatal):
 * rejections.join is not a function" class — a malformed legacy
 * `__rejections` array (a bare value, not an array) crashed `.join` at the
 * dream read site and wedged one user's nightly dream (10 rows Oct 21). The
 * defect was fixed by f80d735d8 (2026-10-21, FO f176 — coerce at the read
 * site; pinned in the "malformed __rejections" describe below) BEFORE this
 * ticket's fingerprint was filed by the sweep (2026-10-22T01:07Z, from
 * Oct-21 rows); the class has ZERO rows in the trailing 24 h at
 * adjudication. The ticket is the sweep re-filing an already-fixed class —
 * this note is the durable cross-reference.
 *
 *  (c) A 120-fact memory: the old consolidation asked the model to RE-EMIT every
 *      fact as JSON under 900 tokens; the simulated model below honours the
 *      output budget, so the whole-object answer is cut mid-JSON, JSON.parse
 *      throws and nothing is consolidated (MEMORY_STATE_OPS_DISABLED=1 still
 *      shows it). The ops answer is bounded by the CHANGES and lands.
 *  (d) 45 eligible users: the old cycle took a 20 h global lock and processed at
 *      most 30, so users past 30 never dreamt; now each hourly tick dreams every
 *      eligible user until its deadline and the next tick picks up the rest.
 *  (e) Kill switches: DREAM_ALL_ACTIVE_USERS_DISABLED=1 restores the 30-cap +
 *      20 h cycle lock; MEMORY_STATE_OPS_DISABLED=1 the whole-object prompt.
 *  Plus: a dream merge closes the merged-away fact as 'consolidated' with
 *  replacedBy `key:<into>` (fact versions), and the prompt shows fact dates.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/database', () => {
  const { createFactVersionTable } = jest.requireActual('./memory/fact-versions.testkit');
  const versions = createFactVersionTable();
  const memRows: Array<{ id: string; userId: string; facts: any; updatedAt: Date }> = [];
  const findMany = jest.fn(async (args: any = {}) => {
    let out = [...memRows];
    const ob = args.orderBy;
    if (ob?.id === 'asc') out.sort((a, b) => a.id.localeCompare(b.id));
    else if (ob?.updatedAt === 'desc') out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    if (args.cursor?.id) {
      const i = out.findIndex((r) => r.id === args.cursor.id);
      out = out.slice(i < 0 ? out.length : i);
    }
    if (args.skip) out = out.slice(args.skip);
    if (typeof args.take === 'number') out = out.slice(0, args.take);
    return out.map((r) => ({ id: r.id, userId: r.userId, facts: JSON.parse(JSON.stringify(r.facts)), updatedAt: new Date(r.updatedAt) }));
  });
  const update = jest.fn(async ({ where, data }: any) => {
    const r = memRows.find((x) => x.userId === where.userId);
    if (r) { r.facts = JSON.parse(JSON.stringify(data.facts)); r.updatedAt = new Date(); } // @updatedAt
    return r;
  });
  const findUnique = jest.fn(async ({ where }: any) => {
    const r = memRows.find((x) => x.userId === where.userId);
    return r ? { facts: JSON.parse(JSON.stringify(r.facts)), updatedAt: new Date(r.updatedAt) } : null;
  });
  return { __esModule: true, default: { ...versions.prismaModels(), userMemory: { findMany, findUnique, update }, __versions: versions, __memRows: memRows } };
});
const mockRedisKeys = new Map<string, number>(); // key → expiresAt (ms)
const mockRedisSet: jest.Mock = jest.fn(async (key: string, _v: string, opts: any) => {
  const now = Date.now();
  const exp = mockRedisKeys.get(key);
  if (opts?.NX && exp !== undefined && exp > now) return null;
  mockRedisKeys.set(key, now + (opts?.EX ?? 0) * 1000);
  return 'OK';
});
jest.mock('../../config/redis', () => ({ __esModule: true, default: { set: (...a: any[]) => mockRedisSet(...a) } }));
const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../utils/utility-llm', () => ({ utilityChat: (...a: any[]) => mockUtilityChat(...a) }));
jest.mock('./memory/context-store', () => ({ storeGet: jest.fn(async () => null), storePut: jest.fn(async () => undefined) }));
jest.mock('./memory/user-facts.service', () => ({ syncUserFactRows: jest.fn() }));
jest.mock('./langgraph/memory.graph', () => ({ buildRejectionKeywords: () => new Set<string>(), scrubUserContextState: (s: any) => s }));
jest.mock('./coding/coding-memory.service', () => ({ dreamCodingProjects: jest.fn(async () => 0) }));
jest.mock('./memory-relevance', () => ({
  topicalTokens: (t: string) => String(t).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4),
}));
const mockRecordExtractionOutcome: jest.Mock = jest.fn();
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({ recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));
jest.mock('./memory/memory-audit', () => ({
  recordMemoryMutation: jest.fn(),
  recordExtractionOutcome: (...a: any[]) => mockRecordExtractionOutcome(...a),
  extractionDetailOf: (raw: unknown) => String(raw ?? '').slice(0, 200),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} } return null; },
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));

import prisma from '../../config/database';
import { runDreamCycle, applyDreamOps, dreamEligibility, DREAM_OPS_BUDGET_TOKENS, DREAM_OPS_LENGTH_RETRY_BUDGET_TOKENS } from './memory-maintenance.service';
import { dreamCodingProjects } from './coding/coding-memory.service';
import { FACT_RECENCY_RULE } from './memory/fact-versions';
import type { FactVersionTable } from './memory/fact-versions.testkit';

const versions = (prisma as any).__versions as FactVersionTable;
const memRows = (prisma as any).__memRows as Array<{ id: string; userId: string; facts: any; updatedAt: Date }>;
const memUpdate = (prisma as any).userMemory.update as jest.Mock;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

const T0 = new Date('2026-10-20T06:00:00Z').getTime();
const HOUR = 60 * 60 * 1000;
const SWITCHES = ['DREAM_ALL_ACTIVE_USERS_DISABLED', 'MEMORY_STATE_OPS_DISABLED', 'FACT_VERSIONS_DISABLED', 'DREAM_OPS_LENGTH_RETRY_DISABLED'];

/** A model that honours its output budget: ~3 chars per token, the answer is CUT there. */
function budgetedModel(answerFor: (prompt: string) => string, msPerCall = 0) {
  return async (messages: Array<{ content: string }>, opts: { maxTokens: number }) => {
    if (msPerCall) jest.setSystemTime(Date.now() + msPerCall);
    return answerFor(String(messages[0].content)).slice(0, opts.maxTokens * 3);
  };
}
const isOpsPrompt = (p: string) => p.includes('{"merge": [{"keys": [');

function addUser(userId: string, facts: Record<string, any>, updatedAt = new Date(T0 - 2 * HOUR)) {
  memRows.push({ id: `m-${userId}`, userId, facts, updatedAt });
}
const savedFacts = (userId: string) => memRows.find((r) => r.userId === userId)!.facts;

beforeEach(() => {
  jest.useFakeTimers({ now: T0, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'hrtime', 'performance'] });
  jest.clearAllMocks();
  memRows.splice(0);
  mockRedisKeys.clear();
  versions.reset();
  for (const s of SWITCHES) delete process.env[s];
});
afterEach(() => { jest.useRealTimers(); });
afterAll(() => { for (const s of SWITCHES) delete process.env[s]; });

// ── (c) 120 facts ─────────────────────────────────────────────────────────────

describe('(c) a 120-fact memory', () => {
  const big: Record<string, string> = {};
  for (let i = 1; i <= 118; i++) big[`interest_${String(i).padStart(3, '0')}`] = `enjoys hobby number ${i} on weekends`;
  big.location = 'Oak Bay';
  big.lives_in = 'Oak Bay, Canada';
  const model = budgetedModel((p) => {
    if (isOpsPrompt(p)) return JSON.stringify({ merge: [{ keys: ['location', 'lives_in'], into: 'location', value: 'Oak Bay, Canada' }] });
    const { lives_in: _gone, ...rest } = big; void _gone;
    return JSON.stringify({ facts: { ...rest, location: 'Oak Bay, Canada' }, removed: [{ key: 'lives_in', reason: 'duplicate' }] });
  });

  it('per-item ops: the duplicate is merged — the answer is bounded by the changes, not the memory size', async () => {
    addUser('u1', { ...big });
    mockUtilityChat.mockImplementation(model);
    await runDreamCycle(true);
    const facts = savedFacts('u1');
    expect(facts.lives_in).toBeUndefined();
    expect(facts.location).toBe('Oak Bay, Canada');
    expect(Object.keys(facts).filter((k) => !k.startsWith('__'))).toHaveLength(119);
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', outcome: 'changed' }));
  });

  it('MEMORY_STATE_OPS_DISABLED=1 (the old whole-object answer): cut at the 900-token budget, JSON.parse fails, nothing consolidated', async () => {
    process.env.MEMORY_STATE_OPS_DISABLED = '1';
    addUser('u1', { ...big });
    mockUtilityChat.mockImplementation(model);
    await runDreamCycle(true);
    const answer = await model([{ content: String(mockUtilityChat.mock.calls[0][0][0].content) }], { maxTokens: 900 });
    expect(() => JSON.parse(answer)).toThrow(); // the truncation this upgrade removes
    expect(savedFacts('u1').lives_in).toBe('Oak Bay, Canada');
    expect(mockRecordExtractionOutcome).not.toHaveBeenCalled(); // and the failure was invisible
  });

  it('a dream merge closes the merged-away fact as consolidated (replacedBy key:<into>) and the prompt shows dates', async () => {
    addUser('u1', { name: 'Paul', location: 'Oak Bay', lives_in: 'Oak Bay, Canada', role: 'Head of AI Cloud' });
    versions.seed({ userId: 'u1', key: 'location', value: 'Oak Bay', validFrom: new Date('2026-05-01T00:00:00Z') });
    versions.seed({ userId: 'u1', key: 'lives_in', value: 'Oak Bay, Canada', validFrom: new Date('2026-09-12T00:00:00Z') });
    mockUtilityChat.mockImplementation(model);
    await runDreamCycle(true);
    await settle();
    const prompt = String(mockUtilityChat.mock.calls[0][0][0].content);
    expect(prompt).toContain('  location: Oak Bay (since 2026-05-01)');
    expect(prompt).toContain('  name: Paul\n'); // no known date → no suffix
    expect(prompt).toContain(`7. ${FACT_RECENCY_RULE}`);
    expect(versions.history('u1', 'lives_in')).toEqual([expect.objectContaining({ value: 'Oak Bay, Canada', endedReason: 'consolidated', replacedBy: 'key:location' })]);
    expect(versions.history('u1', 'location').map((v) => [v.value, v.endedReason, v.replacedBy, v.source])).toEqual([
      ['Oak Bay', 'replaced', 'Oak Bay, Canada', 'turn'],
      ['Oak Bay, Canada', null, null, 'dream'],
    ]);
  });

  it('FACT_VERSIONS_DISABLED=1: no dates in the prompt, no rule, no version rows', async () => {
    process.env.FACT_VERSIONS_DISABLED = '1';
    addUser('u1', { name: 'Paul', location: 'Oak Bay', lives_in: 'Oak Bay, Canada', role: 'Head of AI Cloud' });
    versions.seed({ userId: 'u1', key: 'location', value: 'Oak Bay', validFrom: new Date('2026-05-01T00:00:00Z') });
    mockUtilityChat.mockImplementation(model);
    await runDreamCycle(true);
    await settle();
    const prompt = String(mockUtilityChat.mock.calls[0][0][0].content);
    expect(prompt).not.toContain('(since');
    expect(prompt).not.toContain(FACT_RECENCY_RULE);
    expect(versions.rows).toHaveLength(1); // only the seed
  });
});

// ── (d) every active user ─────────────────────────────────────────────────────

describe('(d) 45 eligible users are all dreamt across hourly ticks', () => {
  const dreamtUsers = () => memUpdate.mock.calls.map((c: any[]) => c[0].where.userId);

  it('each tick dreams until its deadline; the next tick picks up the rest — every user exactly once', async () => {
    for (let i = 1; i <= 45; i++) addUser(`u${String(i).padStart(2, '0')}`, { name: `User ${i}`, city: `City ${i}` });
    // 1 simulated minute per consolidation call → a batch of 4 takes 4 min; the 12-min deadline cuts tick 1.
    mockUtilityChat.mockImplementation(budgetedModel(() => '{}', 60 * 1000));
    const perTick: number[] = [];
    for (let tick = 0; tick < 6; tick++) {
      jest.setSystemTime(T0 + tick * HOUR);
      const before = memUpdate.mock.calls.length;
      await runDreamCycle(); // the worker cron's hourly call — NOT forced
      perTick.push(memUpdate.mock.calls.length - before);
    }
    expect(perTick[0]).toBeGreaterThan(0);
    expect(perTick[0]).toBeLessThan(45); // the deadline really deferred users…
    const users = dreamtUsers();
    expect(new Set(users).size).toBe(45); // …and the following ticks reached every one of them
    expect(users).toHaveLength(45); // none twice: last dream < 20 h and nothing changed since
    expect(mockRedisSet).toHaveBeenCalledWith('crossmodel:memory-dream:tick-lock', expect.any(String), { NX: true, EX: 55 * 60 });
    expect(dreamCodingProjects).toHaveBeenCalledTimes(6); // the coding-project dream keeps its own per-project gap
  });

  it('a user who wrote memory after the scan is skipped (fresh re-read) and dreamt next tick — the new fact is never overwritten', async () => {
    for (let i = 1; i <= 6; i++) addUser(`u${i}`, { name: `User ${i}`, city: 'X' });
    let wrote = false;
    mockUtilityChat.mockImplementation(async () => {
      if (!wrote) { // u6 chats while u1–u4 are being dreamt
        wrote = true;
        const r = memRows.find((x) => x.userId === 'u6')!;
        r.facts = { ...r.facts, pet: 'a cat named Miso' };
        r.updatedAt = new Date();
      }
      return '{}';
    });
    await runDreamCycle();
    expect(dreamtUsers()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
    expect(savedFacts('u6').pet).toBe('a cat named Miso');
    jest.setSystemTime(T0 + HOUR);
    await runDreamCycle();
    expect(dreamtUsers()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']);
    expect(savedFacts('u6').pet).toBe('a cat named Miso'); // dreamt from the fresh blob
  });

  it('a second call inside the same tick is a no-op (per-tick lock)', async () => {
    for (let i = 1; i <= 3; i++) addUser(`u${i}`, { name: `User ${i}`, city: 'X' });
    mockUtilityChat.mockImplementation(budgetedModel(() => '{}'));
    await runDreamCycle();
    await runDreamCycle();
    expect(memUpdate).toHaveBeenCalledTimes(3);
  });

  it('per-user eligibility: changed since the last dream, last dream ≥ 20 h ago, outside the quiet period', () => {
    const now = T0;
    const facts = (lastRunAt?: string) => ({ name: 'P', ...(lastRunAt ? { __dream: { lastRunAt } } : {}) });
    expect(dreamEligibility({ facts: facts(), updatedAt: new Date(now - HOUR) }, now)).toEqual({ lastRunMs: 0 });
    expect(dreamEligibility({ facts: facts(), updatedAt: new Date(now - 10 * 60 * 1000) }, now)).toBeNull(); // mid-session
    expect(dreamEligibility({ facts: { __dream: {} }, updatedAt: new Date(now - HOUR) }, now)).toBeNull(); // nothing visible
    const last = new Date(now - 21 * HOUR).toISOString();
    expect(dreamEligibility({ facts: facts(last), updatedAt: new Date(now - 21 * HOUR + 5000) }, now)).toBeNull(); // the dream's own save
    expect(dreamEligibility({ facts: facts(last), updatedAt: new Date(now - 2 * HOUR) }, now)).toEqual({ lastRunMs: now - 21 * HOUR });
    const recent = new Date(now - 5 * HOUR).toISOString();
    expect(dreamEligibility({ facts: facts(recent), updatedAt: new Date(now - HOUR) }, now)).toBeNull(); // dreamt 5 h ago
    expect(dreamEligibility({ facts: facts('not a date'), updatedAt: new Date(now - HOUR) }, now)).toEqual({ lastRunMs: 0 });
  });
});

// ── (e) kill switches ─────────────────────────────────────────────────────────

describe('(e) DREAM_ALL_ACTIVE_USERS_DISABLED=1 restores the 30-cap + 20 h cycle lock', () => {
  it('45 eligible users: 30 dreamt, the cycle lock holds the next ticks', async () => {
    process.env.DREAM_ALL_ACTIVE_USERS_DISABLED = '1';
    for (let i = 1; i <= 45; i++) addUser(`u${String(i).padStart(2, '0')}`, { name: `User ${i}`, city: 'X' });
    mockUtilityChat.mockImplementation(budgetedModel(() => '{}'));
    for (let tick = 0; tick < 3; tick++) {
      jest.setSystemTime(T0 + tick * HOUR);
      await runDreamCycle();
    }
    expect(memUpdate).toHaveBeenCalledTimes(30);
    expect(mockRedisSet).toHaveBeenCalledWith('crossmodel:memory-dream:cycle-lock', expect.any(String), { NX: true, EX: 20 * 60 * 60 });
    expect(mockRedisSet).not.toHaveBeenCalledWith('crossmodel:memory-dream:tick-lock', expect.anything(), expect.anything());
  });

  it('default: the same 45 users are all dreamt in one unhurried tick', async () => {
    for (let i = 1; i <= 45; i++) addUser(`u${String(i).padStart(2, '0')}`, { name: `User ${i}`, city: 'X' });
    mockUtilityChat.mockImplementation(budgetedModel(() => '{}'));
    await runDreamCycle();
    expect(memUpdate).toHaveBeenCalledTimes(45);
  });
});

// ── f176: a malformed stored __rejections never wedges a user's dream ────────

describe('f176: a legacy non-array __rejections reads as no rejections', () => {
  it('a bare-string __rejections: the dream completes (no "rejections.join is not a function"), consolidates, and drops the malformed value', async () => {
    // Prod rows 2026-10-21 (n=4): "memory-maintenance: dream failed for user <id>
    // (non-fatal): rejections.join is not a function" — a string has .length > 0
    // but no .join, so the prompt build threw EVERY tick and the user never dreamt.
    addUser('u1', { name: 'Ada', city: 'Oak Bay', pet: 'a cat named Miso', __rejections: 'cats' as any });
    mockUtilityChat.mockImplementation(budgetedModel((p) =>
      isOpsPrompt(p) ? JSON.stringify({ merge: [{ keys: ['name', 'city'], into: 'name', value: 'Ada of Oak Bay' }] }) : '{}',
    ));
    const logger = jest.requireMock('../../utils/logger').default;
    await runDreamCycle(true);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('rejections.join is not a function'));
    const facts = savedFacts('u1');
    expect(facts.name).toBe('Ada of Oak Bay');
    expect(facts.city).toBeUndefined();
    expect(facts.__rejections).toBeUndefined(); // the malformed shape self-heals on the next successful dream
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', outcome: 'changed' }));
  });
});

// ── f177: the dream-ops length retry ─────────────────────────────────────────
// Prod row 2026-10-21 11:38Z: a merge-heavy ops answer clipped at the 1500 cap
// (merge list cut mid-string → parse_error → originals kept). An active user's
// SAME long merge proposal re-clips every dream — the truncation twin of the
// rejections.join wedge. The clip signature (finishReason='length', non-empty
// raw) retries ONCE at DREAM_OPS_LENGTH_RETRY_BUDGET_TOKENS; every outcome row
// carries the answering leg + finishReason (firing-45 pattern).
describe('f177: dream-ops length retry', () => {
  const baseFacts = { name: 'Ada', city: 'Oak Bay', pet: 'a cat named Miso' };
  const clipped = '{"merge": [{"keys": ["name", "city"], "into": "name", "value": "Ada of Oak';
  const cleanMerge = JSON.stringify({ merge: [{ keys: ['name', 'city'], into: 'name', value: 'Ada of Oak Bay' }] });

  it('a length-clipped ops answer retries ONCE at the bigger budget, consolidates, and stamps the retry leg on the changed row', async () => {
    addUser('u1', { ...baseFacts });
    const budgets: number[] = [];
    mockUtilityChat.mockImplementation(async (_msgs: any, opts: any) => {
      budgets.push(opts.maxTokens);
      if (budgets.length === 1) {
        opts.onMeta?.({ leg: 'deepseek', model: 'm', finishReason: 'length' });
        return clipped;
      }
      opts.onMeta?.({ leg: 'dashscope', model: 'm2', finishReason: 'stop' });
      return cleanMerge;
    });
    await runDreamCycle(true);
    expect(budgets).toEqual([DREAM_OPS_BUDGET_TOKENS, DREAM_OPS_LENGTH_RETRY_BUDGET_TOKENS]);
    const facts = savedFacts('u1');
    expect(facts.name).toBe('Ada of Oak Bay');
    expect(facts.city).toBeUndefined();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({ kind: 'dream_ops_length_retry', meta: expect.objectContaining({ userId: 'u1', clippedLeg: 'deepseek', retryLeg: 'dashscope', retryOutcome: 'changed' }) });
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', outcome: 'changed', budgetTokens: DREAM_OPS_LENGTH_RETRY_BUDGET_TOKENS, leg: 'dashscope', finishReason: 'stop' }));
  });

  it('DREAM_OPS_LENGTH_RETRY_DISABLED=1: one attempt, the parse_error row attributes the clip (leg + finishReason), no metric', async () => {
    process.env.DREAM_OPS_LENGTH_RETRY_DISABLED = '1';
    addUser('u1', { ...baseFacts });
    mockUtilityChat.mockImplementation(async (_msgs: any, opts: any) => {
      opts.onMeta?.({ leg: 'deepseek', model: 'm', finishReason: 'length' });
      return clipped;
    });
    await runDreamCycle(true);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', outcome: 'parse_error', budgetTokens: DREAM_OPS_BUDGET_TOKENS, leg: 'deepseek', finishReason: 'length' }));
    expect(savedFacts('u1').city).toBe('Oak Bay'); // originals kept
  });

  it('a junk answer with finishReason stop is NOT retried (no double-pay), and the row still carries the leg', async () => {
    addUser('u1', { ...baseFacts });
    mockUtilityChat.mockImplementation(async (_msgs: any, opts: any) => {
      opts.onMeta?.({ leg: 'deepseek', model: 'm', finishReason: 'stop' });
      return 'I cannot consolidate these facts.'; // prose, not a clip
    });
    await runDreamCycle(true);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    expect(mockRecordExtractionOutcome).toHaveBeenCalledWith(expect.objectContaining({ source: 'dream', outcome: 'parse_error', leg: 'deepseek', finishReason: 'stop' }));
  });
});

// ── applyDreamOps (pure) ──────────────────────────────────────────────────────

describe('applyDreamOps', () => {
  const input = { name: 'Paul', location: 'Oak Bay', lives_in: 'Oak Bay, Canada', city: 'Victoria', diet: 'vegan' };

  it('merge → update → remove, with reasons and merge links; unknown keys ignored', () => {
    const r = applyDreamOps(input, {
      merge: [{ keys: ['location', 'lives_in', 'ghost'], into: 'location', value: 'Oak Bay, Canada' }],
      update: { name: 'Paul C.', ghost: 'x' },
      remove: [{ key: 'diet', reason: 'stale' }, 'ghost2'],
    });
    expect(r.facts).toEqual({ name: 'Paul C.', location: 'Oak Bay, Canada', city: 'Victoria' });
    expect(r.mergedInto).toEqual({ lives_in: 'location' });
    expect(r.removed).toEqual([{ key: 'lives_in', reason: 'merged into location' }, { key: 'diet', reason: 'stale' }]);
    expect(r.changedKeys.sort()).toEqual(['location', 'name']);
  });

  it('merge into a NEW key moves every listed key; chained merges link to the final key', () => {
    const r = applyDreamOps(input, {
      merge: [
        { keys: ['location', 'lives_in'], into: 'home', value: 'Oak Bay, Canada' },
        { keys: ['home', 'city'], into: 'region', value: 'Greater Victoria' },
      ],
    });
    expect(r.facts).toEqual({ name: 'Paul', diet: 'vegan', region: 'Greater Victoria' });
    expect(r.mergedInto).toEqual({ location: 'region', lives_in: 'region', city: 'region' });
  });

  it('{} is a no-op; a value-less merge keeps the most complete value', () => {
    expect(applyDreamOps(input, {})).toEqual({ facts: input, removed: [], mergedInto: {}, changedKeys: [] });
    expect(applyDreamOps(input, { merge: [{ keys: ['location', 'lives_in'], into: 'location' }] }).facts.location).toBe('Oak Bay');
    expect(applyDreamOps(input, { merge: [{ keys: ['lives_in', 'location'], into: 'place' }] }).facts.place).toBe('Oak Bay, Canada');
  });
});
