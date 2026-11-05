/**
 * agent_events TIERED compaction (audit 2026-10-06 T9-2). Pins: one walk over
 * bounded PK ranges with a persisted cursor; (a) reasoning rows of TERMINAL
 * runs deleted at any age (kept while HIDE_REASONING_DISABLED=1); (b) for runs
 * finished > AFTER_DAYS ago: all-but-last `context` deleted, screenshot / image
 * base64 replaced by a stub (row + seq kept), `complete.parts` stripped only
 * when the final transcript row exists; non-terminal runs and every other type
 * untouched; the walk stops at the frontier, passes over ranges the 30-day
 * sweep deletes within a day, is bounded per tick, retries a failing range and
 * passes it over after 3 ticks; dry run (own env or the retention's) writes
 * nothing and walks its own cursor; the kill switch does nothing at all; one
 * loop_metrics row per tick that did work.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { AGENT_EVENTS_RETENTION: 'agent_events_retention', AGENT_EVENTS_COMPACTION: 'agent_events_compaction' },
}));
const mockQuery: jest.Mock = jest.fn();
const mockExecute: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { $queryRawUnsafe: (...a: any[]) => mockQuery(...a), $executeRawUnsafe: (...a: any[]) => mockExecute(...a) } }));
// MERGE-1 complete (2026-11-04): the service no longer imports the read-switch or
// coding-data.service, but AppError is mocked here anyway so the suite keeps its shape
// if that edge ever comes back (coding-data.service reaches middleware/error-handler ->
// config/env, which calls process.exit(1) without env vars and kills the jest worker).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); }
  },
}));
const store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  storeGet: async (ns: string[], key: string) => store.get(`${ns.join(':')}/${key}`) ?? null,
  storePut: async (ns: string[], key: string, value: any) => { store.set(`${ns.join(':')}/${key}`, value); },
}));

import {
  runAgentEventsCompactionOnce, COMPACTION_SQL, COMPACTION_TIERS, COMPACTION_CURSOR_NS,
  compactionSql,
  COMPACTION_CURSOR_KEY, COMPACTION_DRY_RUN_CURSOR_KEY, DEFAULT_COMPACTION_MAX_RANGES, DEFAULT_COMPACTION_RANGE_IDS,
  DEFAULT_COMPACTION_AFTER_DAYS, compactionMaxRanges, compactionRangeIds, compactionAfterDays,
} from './agent-events-retention.service';

const NOW = new Date('2026-10-06T18:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);
const SHOT = 'S'.repeat(5_000);
const IMG = 'I'.repeat(3_000);
const REASONING = new Set(['reasoning', 'subagent:reasoning']);

interface Row { id: number; runId: string; seq: number; type: string; payload: any; createdAt: Date; deleted?: boolean }
interface Run { status: string; finishedAt: Date | null; finalMessageId?: string }

/**
 * Which runs' final assistant transcript row lives in WHICH table. The complete tier's
 * `FINAL_MESSAGE_LATERAL` now hard-codes `crossmodel_messages` (the only transcript table
 * after MERGE-1 completed), so the `legacy` half of this fixture models a row that is no
 * longer reachable at all. Omitted ⇒ the row exists (keeps the pre-existing fixtures).
 */
interface TranscriptHoldings { legacy?: string[]; merged?: string[] }

/** In-memory agent_events + agent_runs: the mock answers every SQL shape the walk uses (tagged t9:*). */
function db(rows: Row[], runs: Record<string, Run>, transcript?: TranscriptHoldings) {
  const live = () => rows.filter((r) => !r.deleted);
  const inRange = (lo: any, hi: any, ids?: string[]) => live().filter((r) => r.id >= Number(lo) && r.id < Number(hi) && (!ids || ids.includes(r.runId)));
  const size = (p: any) => JSON.stringify(p).length;
  const result = (n: number, bytes: number) => [{ n: BigInt(n), bytes: BigInt(bytes) }];
  /** Stands in for the lateral: does the RESOLVED transcript table hold this run's final assistant row? */
  const holdsFinal = (source: 'legacy' | 'merged', runId: string): boolean =>
    transcript ? (transcript[source] ?? []).includes(runId) : !!runs[runId]?.finalMessageId;
  const resolvedSource = (sql: string): 'legacy' | 'merged' =>
    sql.includes('crossmodel_messages') ? 'merged' : 'legacy';
  mockQuery.mockImplementation(async (sql: string, ...params: any[]) => {
    if (sql.includes('t9:probe-last')) {
      const r = live().filter((x) => x.id < Number(params[0])).sort((a, b) => b.id - a.id)[0];
      return r ? [{ id: BigInt(r.id), createdAt: r.createdAt }] : [];
    }
    if (sql.includes('t9:probe')) {
      const r = live().filter((x) => x.id >= Number(params[0])).sort((a, b) => a.id - b.id)[0];
      return r ? [{ id: BigInt(r.id), createdAt: r.createdAt }] : [];
    }
    if (sql.includes('t9:range-rows')) return inRange(params[0], params[1]).map((r) => ({ id: BigInt(r.id), runId: r.runId, type: r.type }));
    if (sql.includes('t9:run-status')) {
      return (params[0] as string[]).filter((id) => runs[id]).map((id) => ({ id, status: runs[id].status, finishedAt: runs[id].finishedAt }));
    }
    const m = /t9:(\w+):(apply|dry)/.exec(sql);
    if (!m) throw new Error(`unexpected query ${sql}`);
    const [, tier, mode] = m;
    const ids = new Set((params[0] as string[]).map(Number));
    const byIds = () => live().filter((r) => ids.has(r.id));
    const apply = mode === 'apply';
    let hits: Row[] = [];
    if (tier === 'reasoning') hits = byIds().filter((r) => REASONING.has(r.type));
    if (tier === 'context') hits = byIds().filter((r) => r.type === 'context' && live().some((l) => l.runId === r.runId && l.seq > r.seq && l.type === 'context'));
    if (tier === 'screenshots') hits = byIds().filter((r) => r.type === 'browser_observation' && typeof r.payload.screenshotBase64 === 'string');
    if (tier === 'images') hits = byIds().filter((r) => r.type === 'image' && typeof r.payload.data === 'string');
    if (tier === 'complete') hits = byIds().filter((r) => r.type === 'complete' && Array.isArray(r.payload.parts) && holdsFinal(resolvedSource(sql), r.runId));
    let bytes = 0;
    for (const r of hits) {
      if (!apply) { bytes += size(r.payload); continue; }
      if (tier === 'reasoning' || tier === 'context') { bytes += size(r.payload); r.deleted = true; continue; }
      if (tier === 'complete') {
        const { parts, ...rest } = r.payload;
        const omittedBytes = JSON.stringify(parts).length;
        r.payload = { ...rest, partsOmitted: true, partsCount: parts.length, messageId: runs[r.runId].finalMessageId, omittedBytes };
        bytes += omittedBytes;
        continue;
      }
      const field = tier === 'screenshots' ? 'screenshotBase64' : 'data';
      const { [field]: value, ...rest } = r.payload;
      r.payload = { ...rest, omitted: true, omittedField: field, omittedBytes: value.length };
      bytes += value.length;
    }
    return result(hits.length, bytes);
  });
  return {
    get: (id: number) => rows.find((r) => r.id === id)!,
    liveIds: () => live().map((r) => r.id),
    liveOf: (runId: string) => live().filter((r) => r.runId === runId),
  };
}

/** One completed run (finished `finishedDaysAgo`) whose rows sit at `rowsDaysAgo`, starting at id `base`. */
function runRows(runId: string, base: number, rowsDaysAgo: number): Row[] {
  const c = at(rowsDaysAgo);
  const r = (id: number, seq: number, type: string, payload: any): Row => ({ id: base + id, runId, seq, type, payload, createdAt: c });
  return [
    r(0, 1, 'init', { sessionId: 's' }),
    r(1, 2, 'reasoning', { delta: 'think' }),
    r(2, 3, 'context', { chars: 1, budget: 10, compactions: 0 }),
    r(3, 4, 'subagent:reasoning', { delta: 'more' }),
    r(4, 5, 'tool_call', { name: 'browser_task', args: {} }),
    r(5, 6, 'browser_observation', { action: 'navigate', url: 'https://x.test', ok: true, screenshotBase64: SHOT }),
    r(6, 7, 'browser_observation', { action: 'navigate', live: true, screenshotBase64: SHOT, mime: 'image/jpeg' }),
    r(7, 8, 'tool_result', { name: 'browser_task', result: 'ok' }),
    r(8, 9, 'image', { mediaType: 'image/png', data: IMG, name: 'Final page', source: 'browser' }),
    r(9, 10, 'context', { chars: 2, budget: 10, compactions: 0 }),
    // the run's LAST context lives in a later PK range (ranges are 100 ids)
    r(150, 11, 'text', { delta: 'answer' }),
    r(151, 12, 'context', { chars: 3, budget: 10, compactions: 1 }),
    r(152, 13, 'complete', { finalText: 'answer', parts: [{ type: 'text', text: 'answer' }], origin: 'user' }),
  ];
}

const fresh = (id: number): Row => ({ id, runId: 'live', seq: id, type: 'text', payload: { delta: 'x' }, createdAt: at(0.01) });

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  for (const k of ['AGENT_EVENTS_COMPACTION_DISABLED', 'AGENT_EVENTS_COMPACTION_DRY_RUN', 'AGENT_EVENTS_RETENTION_DRY_RUN', 'AGENT_EVENTS_RETENTION_DAYS',
    'AGENT_EVENTS_COMPACTION_AFTER_DAYS', 'AGENT_EVENTS_COMPACTION_RANGE', 'AGENT_EVENTS_COMPACTION_MAX_RANGES', 'AGENT_EVENTS_COMPACTION_TICK_BUDGET_MS', 'HIDE_REASONING_DISABLED']) delete process.env[k];
  process.env.AGENT_EVENTS_COMPACTION_RANGE = '100'; // the floor — ranges of 100 ids keep the fixtures small
  process.env.AGENT_EVENTS_COMPACTION_MAX_RANGES = '50';
});

describe('runAgentEventsCompactionOnce — tiers', () => {
  it('aged terminal run: reasoning + all-but-last context deleted, screenshots / image / complete.parts stubbed; every other row and seq kept', async () => {
    const t = db([...runRows('A', 1, 10), fresh(1000)], { A: { status: 'completed', finishedAt: at(9), finalMessageId: 'msg-A' }, live: { status: 'running', finishedAt: null } });
    const r = await runAgentEventsCompactionOnce(NOW);
    expect(r.mode).toBe('apply');
    expect(r.reachedFrontier).toBe(true);
    expect(r.tiers.reasoning.rows).toBe(2);
    expect(r.tiers.context.rows).toBe(2);
    expect(r.tiers.screenshots.rows).toBe(2);
    expect(r.tiers.images.rows).toBe(1);
    expect(r.tiers.complete.rows).toBe(1);
    expect(r.rows).toBe(8);
    // Remaining rows: init, tool_call, 2× browser_observation stubs, tool_result, image stub, text, LAST context, complete.
    expect(t.liveOf('A').map((x) => `${x.seq}:${x.type}`)).toEqual(['1:init', '5:tool_call', '6:browser_observation', '7:browser_observation', '8:tool_result', '9:image', '11:text', '12:context', '13:complete']);
    expect(t.get(152).payload).toEqual({ chars: 3, budget: 10, compactions: 1 }); // last context untouched
    expect(t.get(6).payload).toEqual({ action: 'navigate', url: 'https://x.test', ok: true, omitted: true, omittedField: 'screenshotBase64', omittedBytes: SHOT.length });
    expect(t.get(9).payload).toEqual({ mediaType: 'image/png', name: 'Final page', source: 'browser', omitted: true, omittedField: 'data', omittedBytes: IMG.length });
    expect(t.get(153).payload).toMatchObject({ finalText: 'answer', origin: 'user', partsOmitted: true, partsCount: 1, messageId: 'msg-A' });
    expect(t.get(153).payload).not.toHaveProperty('parts');
    expect(t.get(5).payload).toEqual({ name: 'browser_task', args: {} });
    expect(t.get(8).payload).toEqual({ name: 'browser_task', result: 'ok' });
    expect(t.liveIds()).toContain(1000); // the fresh tail is never walked
    expect(store.get(`${COMPACTION_CURSOR_NS.join(':')}/${COMPACTION_CURSOR_KEY}`)).toMatchObject({ nextId: '251', failures: 0 });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'agent_events_compaction', value: 8, unit: 'rows',
      meta: expect.objectContaining({ mode: 'apply', ranges: 2, reachedFrontier: true, tiers: expect.objectContaining({ screenshots: { rows: 2, bytes: 2 * SHOT.length } }) }),
    }));
  });

  it('terminal but recently finished: reasoning goes (any age), everything else waits; a non-terminal run is never touched', async () => {
    const t = db([...runRows('B', 1, 4), ...runRows('C', 301, 4), fresh(1000)], {
      B: { status: 'failed', finishedAt: at(1), finalMessageId: 'msg-B' },
      C: { status: 'interrupted', finishedAt: null, finalMessageId: 'msg-C' },
      live: { status: 'running', finishedAt: null },
    });
    const r = await runAgentEventsCompactionOnce(NOW);
    expect(r.tiers.reasoning.rows).toBe(2);
    expect(r.tiers.context.rows + r.tiers.screenshots.rows + r.tiers.images.rows + r.tiers.complete.rows).toBe(0);
    expect(t.liveOf('B').filter((x) => x.type === 'context')).toHaveLength(3);
    expect(t.get(6).payload.screenshotBase64).toBe(SHOT);
    expect(t.liveOf('C')).toHaveLength(13); // interrupted ⇒ resumable ⇒ its seq log is never thinned
  });

  it('complete.parts stays when the run has no final transcript row', async () => {
    const t = db([...runRows('A', 1, 10), fresh(1000)], { A: { status: 'completed', finishedAt: at(9) }, live: { status: 'running', finishedAt: null } });
    const r = await runAgentEventsCompactionOnce(NOW);
    expect(r.tiers.complete.rows).toBe(0);
    expect(t.get(153).payload.parts).toEqual([{ type: 'text', text: 'answer' }]);
  });

  it('HIDE_REASONING_DISABLED=1 (reasoning replays to clients again) keeps reasoning rows; the other tiers still run', async () => {
    process.env.HIDE_REASONING_DISABLED = '1';
    const t = db([...runRows('A', 1, 10), fresh(1000)], { A: { status: 'completed', finishedAt: at(9), finalMessageId: 'm' }, live: { status: 'running', finishedAt: null } });
    const r = await runAgentEventsCompactionOnce(NOW);
    expect(r.tiers.reasoning.rows).toBe(0);
    expect(t.liveOf('A').filter((x) => REASONING.has(x.type))).toHaveLength(2);
    expect(r.tiers.context.rows).toBe(2);
    expect(mockQuery.mock.calls.some((c) => String(c[0]).includes('t9:reasoning'))).toBe(false);
  });
});

describe('runAgentEventsCompactionOnce — the walk', () => {
  it('is bounded per tick and resumes from the persisted cursor; then only new ranges', async () => {
    process.env.AGENT_EVENTS_COMPACTION_MAX_RANGES = '1';
    const t = db([...runRows('A', 1, 10), fresh(1000)], { A: { status: 'completed', finishedAt: at(9), finalMessageId: 'm' }, live: { status: 'running', finishedAt: null } });
    const r1 = await runAgentEventsCompactionOnce(NOW);
    expect(r1.ranges).toBe(1);
    expect(r1.cursor).toBe('101');
    expect(r1.reachedFrontier).toBe(false);
    expect(t.get(152).deleted).toBeUndefined(); // the second range waits for the next tick
    const r2 = await runAgentEventsCompactionOnce(NOW);
    expect(r2.fromId).toBe('151');
    expect(r2.ranges).toBe(1);
    expect(r2.tiers.complete.rows).toBe(1);
    expect(r2.cursor).toBe('251');
    const r3 = await runAgentEventsCompactionOnce(NOW);
    expect(r3.ranges).toBe(0);
    expect(r3.reachedFrontier).toBe(true);
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(2); // no row for a tick that found nothing
  });

  it('never walks a range whose newest row is inside the frontier (AFTER_DAYS + 1 days)', async () => {
    // Rows 2.5 days old: older than AFTER_DAYS (2) but inside the 3-day frontier.
    const t = db([...runRows('A', 1, 2.5), fresh(1000)], { A: { status: 'completed', finishedAt: at(2.4), finalMessageId: 'm' }, live: { status: 'running', finishedAt: null } });
    const r = await runAgentEventsCompactionOnce(NOW);
    expect(r.ranges).toBe(0);
    expect(r.reachedFrontier).toBe(true);
    expect(t.liveOf('A')).toHaveLength(13);
    expect(store.size).toBe(0); // the cursor never moved
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('passes over ranges the 30-day sweep deletes within a day (no writes to rows about to vanish)', async () => {
    const t = db([...runRows('OLD', 1, 29.5), ...runRows('A', 401, 10), fresh(1000)], {
      OLD: { status: 'completed', finishedAt: at(29.4), finalMessageId: 'o' },
      A: { status: 'completed', finishedAt: at(9), finalMessageId: 'm' },
      live: { status: 'running', finishedAt: null },
    });
    const r = await runAgentEventsCompactionOnce(NOW);
    expect(r.skips).toBe(2);
    expect(r.ranges).toBe(2);
    expect(t.liveOf('OLD')).toHaveLength(13);
    expect(t.liveOf('A')).toHaveLength(9);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ skips: 2, ranges: 2 }) }));
  });

  it('a failing range is retried next tick (cursor held, streak persisted) and passed over after 3 failed ticks', async () => {
    db([...runRows('A', 1, 10), fresh(1000)], { A: { status: 'completed', finishedAt: at(9), finalMessageId: 'm' }, live: { status: 'running', finishedAt: null } });
    const impl = mockQuery.getMockImplementation()!;
    mockQuery.mockImplementation(async (sql: string, ...p: any[]) => {
      if (sql.includes('t9:context:apply') && (p[0] as string[]).includes('3')) throw new Error('statement timeout'); // range [1, 101)
      return impl(sql, ...p);
    });
    const key = `${COMPACTION_CURSOR_NS.join(':')}/${COMPACTION_CURSOR_KEY}`;
    const r1 = await runAgentEventsCompactionOnce(NOW);
    expect(r1.ranges).toBe(0);
    expect(store.get(key)).toMatchObject({ nextId: '1', failures: 1 });
    expect(r1.tiers.reasoning.rows).toBe(2); // the tiers before the failure did run (idempotent on retry)
    await runAgentEventsCompactionOnce(NOW);
    expect(store.get(key)).toMatchObject({ nextId: '1', failures: 2 });
    const r3 = await runAgentEventsCompactionOnce(NOW);
    expect(r3.cursor).toBe('251'); // passed over [1, 101), then the next range [151, 251) ran
    expect(r3.tiers.complete.rows).toBe(1);
    expect(store.get(key)).toMatchObject({ nextId: '251', failures: 0 });
  });

  it('dry run counts every tier, writes nothing, and walks its OWN cursor (the retention dry-run env is honoured too)', async () => {
    for (const env of ['AGENT_EVENTS_COMPACTION_DRY_RUN', 'AGENT_EVENTS_RETENTION_DRY_RUN']) {
      store.clear();
      process.env[env] = '1';
      const t = db([...runRows('A', 1, 10), fresh(1000)], { A: { status: 'completed', finishedAt: at(9), finalMessageId: 'm' }, live: { status: 'running', finishedAt: null } });
      const r = await runAgentEventsCompactionOnce(NOW);
      expect(r.mode).toBe('dry_run');
      expect(r.rows).toBe(8);
      expect(t.liveOf('A')).toHaveLength(13);
      expect(t.get(6).payload.screenshotBase64).toBe(SHOT);
      expect(mockQuery.mock.calls.some((c) => /t9:\w+:apply/.test(String(c[0])))).toBe(false);
      expect(store.get(`${COMPACTION_CURSOR_NS.join(':')}/${COMPACTION_DRY_RUN_CURSOR_KEY}`)).toMatchObject({ nextId: '251' });
      expect(store.has(`${COMPACTION_CURSOR_NS.join(':')}/${COMPACTION_CURSOR_KEY}`)).toBe(false);
      delete process.env[env];
    }
  });

  it('kill switch AGENT_EVENTS_COMPACTION_DISABLED=1 does nothing at all', async () => {
    process.env.AGENT_EVENTS_COMPACTION_DISABLED = '1';
    db([...runRows('A', 1, 10), fresh(1000)], { A: { status: 'completed', finishedAt: at(9), finalMessageId: 'm' } });
    const r = await runAgentEventsCompactionOnce(NOW);
    expect(r.mode).toBe('disabled');
    expect(mockQuery).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('never throws: a probe failure ends the tick quietly', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    const r = await runAgentEventsCompactionOnce(NOW);
    expect(r.ranges).toBe(0);
    expect(store.size).toBe(0);
  });
});

describe('compaction statements + defaults', () => {
  it('every tier statement reaches rows only by explicit PK ids (never a whole-run index read); only the measured waste types are named', () => {
    for (const tier of COMPACTION_TIERS) {
      for (const sql of [COMPACTION_SQL[tier].apply, COMPACTION_SQL[tier].dry]) {
        expect(sql).toContain('e.id = ANY($1::bigint[])');
        expect(sql).not.toContain('"runId" = ANY');
        expect(sql).not.toMatch(/'(tool_result|tool_call|text|plan_update|progress|subagent:text)'/);
      }
      expect(COMPACTION_SQL[tier].dry).not.toMatch(/\b(DELETE|UPDATE)\b/);
    }
    expect(COMPACTION_SQL.complete.apply).toContain('crossmodel_messages');
    expect(COMPACTION_SQL.complete.apply).toContain(`'partsOmitted', true`);
    expect(COMPACTION_SQL.context.apply).toContain('l.seq > e.seq');
  });

  it('gentle defaults: 2 ranges × 2,000 ids per tick, runs aged 2 days; env clamps', () => {
    delete process.env.AGENT_EVENTS_COMPACTION_RANGE;
    delete process.env.AGENT_EVENTS_COMPACTION_MAX_RANGES;
    expect([compactionMaxRanges(), compactionRangeIds(), compactionAfterDays()]).toEqual([DEFAULT_COMPACTION_MAX_RANGES, DEFAULT_COMPACTION_RANGE_IDS, DEFAULT_COMPACTION_AFTER_DAYS]);
    expect([DEFAULT_COMPACTION_MAX_RANGES, DEFAULT_COMPACTION_RANGE_IDS, DEFAULT_COMPACTION_AFTER_DAYS]).toEqual([2, 2000, 2]);
    process.env.AGENT_EVENTS_COMPACTION_AFTER_DAYS = '0.2';
    expect(compactionAfterDays()).toBe(1);
    process.env.AGENT_EVENTS_COMPACTION_RANGE = '9999999';
    expect(compactionRangeIds()).toBe(20_000);
  });
});

/**
 * MERGE-1 COMPLETE — THE PINNING TEST for the one failure that is silent.
 *
 * The complete tier's `FINAL_MESSAGE_LATERAL` once hard-coded `coding_messages`. After
 * the drop that statement raises 42P01 on every range, compactRange throws, the caller
 * catches at :398, retries, then SKIPS the range with only a logger.warn (:403) and
 * advances the cursor — so `agent_events.payload.parts` is never stripped again and the
 * largest table grows unbounded, reporting `rows = 0` the whole time (the same value it
 * legitimately reports on a quiet fleet). No red test, no error, disk fills weeks later.
 *
 * The lateral is now hard-coded to `crossmodel_messages` — the only transcript table
 * after MERGE-1 completed (2026-11-04) — so these assertions pin the single remaining
 * source: a MIRROR-ONLY fixture must report COUNT(*) > 0, and a legacy-only fixture 0.
 */
describe('MERGE-1 complete — the complete tier reads crossmodel_messages only', () => {
  /** The run's final assistant row exists ONLY in crossmodel_messages (the only table left). */
  const MIRROR_ONLY: TranscriptHoldings = { legacy: [], merged: ['A'] };
  /** A row that exists ONLY in coding_messages can no longer be found at all. */
  const LEGACY_ONLY: TranscriptHoldings = { legacy: ['A'], merged: [] };
  const runA = () => [...runRows('A', 1, 10), fresh(1000)];
  const runsA = { A: { status: 'completed', finishedAt: at(9) }, live: { status: 'running', finishedAt: null } };

  it('MIRROR-ONLY fixture reports COUNT(*) > 0 — the drop-safety proof', async () => {
    db(runA(), runsA, MIRROR_ONLY);
    const r = await runAgentEventsCompactionOnce(NOW);
    expect(r.mode).toBe('apply');
    expect(r.tiers.complete.rows).toBeGreaterThan(0);
    expect(r.tiers.complete.rows).toBe(1);
  });

  it('a legacy-only row is no longer visible to the lateral (that table is gone)', async () => {
    db(runA(), runsA, LEGACY_ONLY);
    expect((await runAgentEventsCompactionOnce(NOW)).tiers.complete.rows).toBe(0);
  });

  it('the lateral names crossmodel_messages."chatId" and never the doomed table', () => {
    const merged = compactionSql();
    expect(merged.complete.apply).toContain('crossmodel_messages cm');
    expect(merged.complete.apply).toContain('cm."chatId" = r."sessionId"');
    expect(merged.complete.apply).not.toContain('coding_messages');
    expect(merged.complete.dry).not.toContain('coding_messages');
  });
});
