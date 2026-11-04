/**
 * Time-boxed unified-memory search (2026-09-23). Prod: ~100 "Pipeline project
 * learnings: soft deadline hit" per day while both DB legs ran in ~20 ms — the
 * misses were the DashScope embed + rerank round trips, and the outer race
 * threw away a lookup that was 90% done. Pins: the embed HTTP timeout follows
 * the remaining budget, rerank is skipped (fused order returned) when little
 * budget remains, the query-embedding cache dedupes identical queries, the
 * timing metric records per-leg ms.
 */
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { $executeRawUnsafe: jest.fn(async () => 0), $queryRawUnsafe: jest.fn(async () => []) },
}));
const mockEmbed: jest.Mock = jest.fn();
const mockRerank: jest.Mock = jest.fn();
jest.mock('../rag.service', () => ({
  __esModule: true,
  embedTexts: (...a: any[]) => mockEmbed(...a),
  rerankTexts: (...a: any[]) => mockRerank(...a),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { MEMORY_SEARCH_TIMING: 'memory_search_timing', MEMORY_SCOPE_EVICTED: 'memory_scope_evicted', UNIFIED_MEMORY_EMBED_BREAKER: 'unified_memory_embed_breaker' },
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { memSearch, RERANK_MIN_REMAINING_MS, _clearQueryEmbedCache, _resetEmbedBreaker, _embedBreakerState, vectorLegSql, MEM_SEARCH_SCAN_CAP_DEFAULT, WIDE_BLEND_PER_SCOPE_DEFAULT } from './unified-memory.service';

const VEC = Array.from({ length: 4 }, (_, i) => i / 10);
const rows = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => ({
  id: `${prefix}${i}`, ref: '', title: `t${i}`, source: 'learning', content: `content ${i}`, scope_type: 'project', scope_id: 'p1', created_at: new Date().toISOString(),
}));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await sleep(5); };

beforeEach(() => {
  jest.clearAllMocks();
  _clearQueryEmbedCache();
  _resetEmbedBreaker();
  delete process.env.MEM_SEARCH_SCAN_CAP;
  delete process.env.UNIFIED_MEMORY_EMBED_BREAKER_DISABLED;
  (prisma.$queryRawUnsafe as jest.Mock).mockImplementation(async (sql: string) => (sql.includes('<=>') ? rows(12, 'v') : rows(12, 'f')));
  mockEmbed.mockImplementation(async () => [VEC]);
  mockRerank.mockImplementation(async (_q: string, texts: string[], topN: number) => texts.slice(0, topN).map((_, i) => ({ index: i, score: 1 - i / 10 })));
});

describe('memSearch time-box', () => {
  it('without a deadline: behaves as before (no HTTP timeout override, rerank runs)', async () => {
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'what blocked the deploy?', 4);
    expect(hits).toHaveLength(4);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    // No HTTP TIMEOUT override without a deadline. The opts object itself is no
    // longer undefined: every embed call now carries its write-time `bucket`
    // attribution (goal 4e432dff), which is independent of the time-box.
    expect(mockEmbed.mock.calls[0][2]).toEqual({ bucket: 'query' });
    expect(mockRerank).toHaveBeenCalledTimes(1);
    expect(mockRerank.mock.calls[0][3]).toBeUndefined();
  });

  it('with a deadline: the embed HTTP timeout is the remaining budget and the rerank gets what is left', async () => {
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'what blocked the deploy?', 4, { deadlineMs: 5750, purpose: 'project_learnings' });
    expect(hits).toHaveLength(4);
    const embedOpts = mockEmbed.mock.calls[0][2];
    expect(embedOpts.timeoutMs).toBeGreaterThan(5000);
    expect(embedOpts.timeoutMs).toBeLessThanOrEqual(5550);
    const rerankOpts = mockRerank.mock.calls[0][3];
    expect(rerankOpts.timeoutMs).toBeGreaterThan(4000);
    await flush();
    const m = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((x) => x.kind === 'memory_search_timing');
    expect(m).toBeTruthy();
    expect(m.meta).toMatchObject({ purpose: 'project_learnings', scopes: 1, deadlineMs: 5750, embedCached: false, hits: 4 });
    expect(typeof m.meta.embedMs).toBe('number');
    expect(typeof m.meta.rerankMs).toBe('number');
    expect(m.meta.rerankSkipped).toBeUndefined();
  });

  it('a slow embed that eats the budget SKIPS rerank and still returns the fused order (not [])', async () => {
    mockEmbed.mockImplementation(async () => { await sleep(120); return [VEC]; });
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'what blocked the deploy?', 4, { deadlineMs: 100 + RERANK_MIN_REMAINING_MS - 50 });
    expect(hits).toHaveLength(4);
    expect(mockRerank).not.toHaveBeenCalled();
    await flush();
    const m = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((x) => x.kind === 'memory_search_timing');
    expect(m.meta.rerankSkipped).toBe(true);
  });

  it('an embed failure (timeout) still answers from the keyword leg', async () => {
    mockEmbed.mockImplementation(async () => { throw new Error('timeout of 800ms exceeded'); });
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'what blocked the deploy?', 4, { deadlineMs: 3000 });
    expect(hits).toHaveLength(4);
    await flush();
    const m = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((x) => x.kind === 'memory_search_timing');
    expect(m.meta.embedFailed).toBe(true);
  });

  it('the query-embedding cache dedupes identical queries within a build', async () => {
    await memSearch([{ type: 'project', id: 'p1' }], 'same retrieval message', 4);
    await memSearch([{ type: 'session', id: 's1' }], 'same retrieval message', 4);
    expect(mockEmbed).toHaveBeenCalledTimes(1);
    await flush();
    const cached = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((x) => x.kind === 'memory_search_timing').map((x) => x.meta.embedCached);
    expect(cached).toEqual([false, true]);
  });
});

describe('vector-leg shape (iteration 2: the slow leg was the vector query, and the HNSW path returned 0 rows on big scopes)', () => {
  const base = "FROM digby_memory WHERE ((scope_type = $1 AND scope_id = $2)) AND source = ANY($4::text[])";
  it('pre-filters ids by scope through a MATERIALIZED CTE with the recency cap, then joins for the distance sort', () => {
    const sql = vectorLegSql(base, 3, 6);
    expect(sql).toContain('WITH scoped AS MATERIALIZED');
    expect(sql).toContain(`ORDER BY created_at DESC LIMIT ${MEM_SEARCH_SCAN_CAP_DEFAULT}`);
    expect(sql).toContain('JOIN scoped s ON s.id = m.id');
    expect(sql).toContain('ORDER BY m.embedding <=> $3::vector LIMIT 18');
    // the scope + source filter lives INSIDE the CTE, never on the joined sort
    expect(sql.indexOf(base)).toBeLessThan(sql.indexOf('JOIN scoped'));
  });
  it('MEM_SEARCH_SCAN_CAP is honoured (floor 100)', () => {
    process.env.MEM_SEARCH_SCAN_CAP = '250';
    expect(vectorLegSql(base, 3, 6)).toContain('LIMIT 250');
    process.env.MEM_SEARCH_SCAN_CAP = '5';
    expect(vectorLegSql(base, 3, 6)).toContain(`LIMIT ${MEM_SEARCH_SCAN_CAP_DEFAULT}`);
  });
  it('memSearch runs the prefilter shape and stamps vecShape in the timing row', async () => {
    await memSearch([{ type: 'project', id: 'p1' }], 'q', 4, { deadlineMs: 5000, purpose: 'project_learnings' });
    const vecSql = (prisma.$queryRawUnsafe as jest.Mock).mock.calls.map((c) => String(c[0])).find((q) => q.includes('<=>'));
    expect(vecSql).toContain('WITH scoped AS MATERIALIZED');
    await flush();
    const m = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((x) => x.kind === 'memory_search_timing');
    expect(m.meta.vecShape).toBe('prefilter');
  });
});

describe('wide-blend scope fan-in (FO firing 12: the 34-project blend fetched ~4000 candidate embeddings to return the top 12)', () => {
  const base = "FROM digby_memory WHERE ((scope_type = $1 AND scope_id = $2) OR (scope_type = $3 AND scope_id = $4)) AND source = ANY($5::text[])";
  it('a WIDE blend (scopes > WIDE_BLEND_SCOPES) partitions the candidate pool per scope with a recency quota instead of the global cap', () => {
    const scopes = Array.from({ length: 34 }, (_, i) => ({ type: 'project', id: `p${i}` }));
    const wide = vectorLegSql(base, 3, 4, scopes.length);
    expect(wide).toContain('ROW_NUMBER() OVER (PARTITION BY scope_type, scope_id ORDER BY created_at DESC)');
    expect(wide).toContain(`rn <= ${WIDE_BLEND_PER_SCOPE_DEFAULT}`);
    expect(wide).not.toContain(`LIMIT ${MEM_SEARCH_SCAN_CAP_DEFAULT}`);
    // the scope + source filter lives INSIDE the window function, never on the joined sort
    expect(wide.indexOf(base)).toBeLessThan(wide.indexOf('JOIN scoped'));
  });
  it('a NARROW blend (scopes <= WIDE_BLEND_SCOPES) keeps the global recency cap', () => {
    const narrow = vectorLegSql(base, 3, 4, 10);
    expect(narrow).toContain(`ORDER BY created_at DESC LIMIT ${MEM_SEARCH_SCAN_CAP_DEFAULT}`);
    expect(narrow).not.toContain('ROW_NUMBER()');
  });
  it('MEM_SEARCH_WIDE_PER_SCOPE / MEM_SEARCH_WIDE_BLEND_SCOPES tune the quota and the width threshold (floor 1)', () => {
    process.env.MEM_SEARCH_WIDE_PER_SCOPE = '24';
    expect(vectorLegSql(base, 3, 4, 34)).toContain('rn <= 24');
    process.env.MEM_SEARCH_WIDE_BLEND_SCOPES = '40';
    expect(vectorLegSql(base, 3, 4, 34)).not.toContain('ROW_NUMBER()');
    delete process.env.MEM_SEARCH_WIDE_BLEND_SCOPES; // a 34-scope blend is wide again
    process.env.MEM_SEARCH_WIDE_PER_SCOPE = '0';
    expect(vectorLegSql(base, 3, 4, 34)).toContain(`rn <= ${WIDE_BLEND_PER_SCOPE_DEFAULT}`);
    delete process.env.MEM_SEARCH_WIDE_PER_SCOPE;
  });
  it('memSearch stamps vecShape=prefilter+quota on a wide blend and every scope stays reachable', async () => {
    const scopes = Array.from({ length: 34 }, (_, i) => ({ type: 'project' as const, id: `p${i}` }));
    await memSearch(scopes, 'q', 4, { deadlineMs: 5000, purpose: 'project_learnings' });
    const vecSql = (prisma.$queryRawUnsafe as jest.Mock).mock.calls.map((c) => String(c[0])).find((q) => q.includes('<=>'));
    expect(vecSql).toContain('ROW_NUMBER() OVER (PARTITION BY scope_type, scope_id');
    await flush();
    const m = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((x) => x.kind === 'memory_search_timing');
    expect(m.meta.vecShape).toBe('prefilter+quota');
    expect(m.meta.scopes).toBe(34);
  });
});

/**
 * The embed circuit breaker (FO f185, 2026-10-22). Prod evidence: the
 * 2026-10-22 DashScope outage failed the embed leg of ~70% of memory searches
 * for 6+ straight hours (embed_failed 100–150/h, semantic-leg warns 87–149/h)
 * and every search paid the doomed call's latency (project_learnings p50
 * 10.7 s) before the keyword leg answered. Pins: 8 consecutive embed failures
 * open the breaker for 120 s (embed HTTP call AND rerank round trip skipped,
 * keyword leg answers, timing rows stamped, one transition metric), a half-open
 * trial closes on success / re-opens at doubled cooldown on failure (cap
 * 600 s), and UNIFIED_MEMORY_EMBED_BREAKER_DISABLED=1 restores always-call.
 */
describe('embed circuit breaker (FO f185)', () => {
  const failEmbed = () => mockEmbed.mockImplementation(async () => { throw new Error('timeout of 30000ms exceeded'); });
  const breakerRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((x) => x.kind === 'unified_memory_embed_breaker');
  const timingRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((x) => x.kind === 'memory_search_timing').map((x) => x.meta);
  const flushMicro = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  it('opens after 8 consecutive embed failures: the 9th search skips the embed HTTP call AND the rerank round trip', async () => {
    failEmbed();
    for (let i = 0; i < 8; i++) await memSearch([{ type: 'project', id: 'p1' }], `breaker probe ${i}`, 4);
    expect(mockEmbed).toHaveBeenCalledTimes(8);
    expect(mockRerank).toHaveBeenCalledTimes(7); // the 8th failure opens the breaker mid-search — its own rerank is already gated
    await flush();
    expect(breakerRows().map((r) => r.meta.transition)).toEqual(['open']);
    expect(breakerRows()[0].meta).toMatchObject({ failures: 8, cooldownMs: 120_000 });
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'breaker probe 9', 4);
    expect(hits).toHaveLength(4); // the keyword leg still answers
    expect(mockEmbed).toHaveBeenCalledTimes(8); // fail-fast: no 9th HTTP call
    expect(mockRerank).toHaveBeenCalledTimes(7); // the rerank round trip stays gated
    await flush();
    const last = timingRows().at(-1);
    expect(last).toMatchObject({ embedBreaker: 'open', embedFailed: true, rerankBreaker: 'open', rerankSkipped: true, hits: 4 });
    expect(_embedBreakerState().openUntil).toBeGreaterThan(Date.now());
  });

  it('half-opens after the cooldown: a successful trial closes the breaker and resets', async () => {
    jest.useFakeTimers({ now: 5_000_000 });
    try {
      failEmbed();
      for (let i = 0; i < 8; i++) await memSearch([{ type: 'project', id: 'p1' }], `trial probe ${i}`, 4);
      expect(_embedBreakerState().openUntil).toBeGreaterThan(Date.now());
      jest.setSystemTime(Date.now() + 121_000);
      mockEmbed.mockImplementation(async () => [VEC]);
      const hits = await memSearch([{ type: 'project', id: 'p1' }], 'trial probe 9', 4);
      expect(hits).toHaveLength(4);
      expect(mockEmbed).toHaveBeenCalledTimes(9); // the trial embed ran
      expect(_embedBreakerState()).toMatchObject({ failures: 0, openUntil: 0, cooldownMs: 120_000 });
      await flushMicro();
      expect(breakerRows().map((r) => r.meta.transition)).toEqual(['open', 'close']);
      expect(timingRows().at(-1).embedBreaker).toBe('half_open_trial');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a failed half-open trial re-opens with a doubled cooldown (cap 600 s)', async () => {
    jest.useFakeTimers({ now: 9_000_000 });
    try {
      failEmbed();
      for (let i = 0; i < 8; i++) await memSearch([{ type: 'project', id: 'p1' }], `reopen probe ${i}`, 4);
      expect(_embedBreakerState().cooldownMs).toBe(120_000);
      jest.setSystemTime(Date.now() + 121_000);
      await memSearch([{ type: 'project', id: 'p1' }], 'reopen probe 9', 4); // the trial embed fails
      const st = _embedBreakerState();
      expect(st.cooldownMs).toBe(240_000);
      expect(st.openUntil).toBe(Date.now() + 240_000);
      await flushMicro();
      expect(breakerRows().map((r) => r.meta.transition)).toEqual(['open', 'reopen']);
      expect(timingRows().at(-1).embedBreaker).toBe('half_open_trial');
    } finally {
      jest.useRealTimers();
    }
  });

  it('UNIFIED_MEMORY_EMBED_BREAKER_DISABLED=1 keeps the always-call behaviour (no counting, no transitions)', async () => {
    process.env.UNIFIED_MEMORY_EMBED_BREAKER_DISABLED = '1';
    failEmbed();
    for (let i = 0; i < 10; i++) await memSearch([{ type: 'project', id: 'p1' }], `disabled probe ${i}`, 4);
    expect(mockEmbed).toHaveBeenCalledTimes(10);
    expect(mockRerank).toHaveBeenCalledTimes(10);
    expect(_embedBreakerState()).toMatchObject({ failures: 0, openUntil: 0 });
    await flush();
    expect(breakerRows()).toHaveLength(0);
    const last = timingRows().at(-1);
    expect(last.embedFailed).toBe(true);
    expect(last.embedBreaker).toBeUndefined();
  });
});

/**
 * Characterization pin — log-signal ticket 6348ebff (2026-10-23, family lane
 * ecc2bb0d): the "unified-memory: semantic leg failed (keyword leg still
 * runs): timeout of <n>ms exceeded" warn fingerprint the hourly
 * log-signal-sweep filed (688 rows across 9 distinct hours, Oct 22 — by far
 * the family's loudest member) is DESIGNED graceful-degradation observability
 * during a LIVE VENDOR OUTAGE (DashScope embed/rerank), not a defect in this
 * repo. The search DEGRADES, never fails: the keyword (FTS) leg answers with
 * the fused order.
 *
 * WHERE THE ROWS COME FROM (live evidence this run, 00:13Z Oct 23): 747 rows
 * in the trailing 24 h, a MIX of "timeout of <n>ms exceeded" (the outage's
 * latency half) and "Request failed with status code 429" (its rate-limit
 * half) — both legs of one vendor incident, which the sweep normalized into
 * two fingerprints (this ticket carries the timeout shape). The embed circuit
 * breaker above (bcd71d4c1, merged 2026-10-23) is the MITIGATION: once 8
 * consecutive embed failures open it, no doomed HTTP call is made and NO
 * per-search warn is logged — the breaker's transition row carries the
 * signal instead. Until the breaker's wave lands on the boxes (at pin time
 * boxes still run a0340c08, pre-breaker), every failed search legitimately
 * logs this warn once.
 *
 * WHY DESIGNED: the warn names the EXACT degradation the caller sees
 * (semantic leg gone, keyword leg live) — the alternative (silence) is the
 * class a detector cannot distinguish from a working system. The per-search
 * volume during a fleet-wide outage is bounded by search volume itself
 * (~70%/h of memory searches at the outage peak), never by a retry loop:
 * ONE warn per search (pinned below), the failure branch returns the fused
 * keyword answer, and there is no re-attempt inside one search.
 */
describe('log-signal 6348ebff — the semantic-leg warn is designed degradation observability (one per search, keyword answers)', () => {
  beforeEach(() => {
    mockEmbed.mockImplementation(async () => { throw new Error('timeout of 14550ms exceeded'); });
    mockRerank.mockImplementation(async () => null);
  });

  it('an embed timeout logs EXACTLY ONE warn carrying the swept fingerprint, and the search still answers via the keyword leg', async () => {
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'what blocked the deploy?', 4);
    expect(hits).toHaveLength(4); // the keyword leg answered — graceful by contract
    const warns = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('semantic leg failed'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe('unified-memory: semantic leg failed (keyword leg still runs): timeout of 14550ms exceeded');
    // Level warn, never error (the DB transport persists warn+; the sweep
    // reads exactly this level).
    expect((logger.error as jest.Mock).mock.calls).toHaveLength(0);
    // No second leg attempted for the embed: ONE HTTP call per search.
    expect(mockEmbed).toHaveBeenCalledTimes(1);
  });

  it("every distinct search mints its own single warn — row volume tracks search volume (the outage's 688/day), never a per-search loop", async () => {
    const before = (logger.warn as jest.Mock).mock.calls.length;
    for (let i = 0; i < 5; i++) await memSearch([{ type: 'project', id: 'p1' }], `outage probe ${i}`, 4);
    const warns = (logger.warn as jest.Mock).mock.calls.slice(before).map((c) => String(c[0])).filter((m) => m.includes('semantic leg failed'));
    expect(warns).toHaveLength(5); // 5 searches → 5 rows, one each
    expect(mockEmbed).toHaveBeenCalledTimes(5); // and exactly 5 doomed calls — no retry ladder
  });

  it('the failure stamps the timing row the detector reads (embedFailed + hits>0 = the designed ESCALATE arm of memory_search_timing)', async () => {
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'what blocked the deploy?', 4);
    expect(hits).toHaveLength(4);
    await flush();
    const m = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((x) => x.kind === 'memory_search_timing');
    expect(m.meta).toMatchObject({ embedFailed: true, hits: 4 });
  });
});

// ── Log-signal family lane 92dc54d6 — ticket 2ed4141c (2026-10-27) ──────────────
// The October-26 re-file of the 6348ebff semantic-leg class: 170 rows/24h
// (Oct 26 09:00 → Oct 27 00:09Z) of
//   unified-memory: semantic leg failed (keyword leg still runs): timeout of
//   7800ms exceeded
// Adjudication (lane 92dc54d6, 2026-10-27): NOT a framework defect — the
// SAME designed-degradation observability class 6348ebff pinned (the
// DashScope embed outage's timeout half, still live): the number in the row
// is the DESIGNED time-box passthrough (the embed HTTP timeout = the ask's
// remaining deadline − 200 ms, floored at EMBED_MIN_TIMEOUT_MS=1200 — the
// 7800 ms in the prod rows is an ~8000 ms memory-search deadline handed
// down), the search DEGRADES to the keyword leg and still answers, ONE warn
// per search, and the embed circuit breaker (bcd71d4c1) bounds the volume:
// after 8 consecutive failures the breaker opens and NO further per-search
// warn is logged — the breaker's transition row carries the signal instead.
// This block pins this member's own fingerprint (the 7800 ms prod value) and
// the breaker volume bound.
describe('log-signal 2ed4141c — the semantic-leg timeout re-file (designed degradation, deadline-derived number, breaker-bounded volume)', () => {
  beforeEach(() => {
    mockEmbed.mockImplementation(async () => { throw new Error('timeout of 7800ms exceeded'); });
    mockRerank.mockImplementation(async () => null);
  });

  it('REPLAYS the prod row: a deadline-derived embed timeout (7800ms ≈ an 8000ms remaining budget − 200) logs the ONE warn, and the keyword leg answers', async () => {
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'what blocked the deploy?', 4, { deadlineMs: 8000 });
    expect(hits).toHaveLength(4); // the keyword leg answered — graceful by contract
    const warns = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('semantic leg failed'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe('unified-memory: semantic leg failed (keyword leg still runs): timeout of 7800ms exceeded');
    // The number in the row IS the designed embed HTTP timeout handed down
    // from the caller's deadline (remaining − 200, floor 1200) — not a hang.
    // Bounds hold the DESIGN, not host jitter: upper 7800 (8000 − 200) and
    // lower > the 1200 floor (a number above the floor proves the deadline
    // passthrough ran, tolerating any elapsed-time skew on a loaded box).
    const embedOpts = mockEmbed.mock.calls[0][2];
    expect(embedOpts.timeoutMs).toBeLessThanOrEqual(7800);
    expect(embedOpts.timeoutMs).toBeGreaterThan(1200);
    // Level warn, never error (the DB transport persists warn+; the sweep
    // reads exactly this level) — the 6348ebff contract, this member's rows.
    expect((logger.error as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('the 170-row/24h volume is bounded by SEARCH volume and the breaker, never a retry loop: 8 consecutive failures open the breaker and the 9th search logs NO warn at all', async () => {
    for (let i = 0; i < 8; i++) await memSearch([{ type: 'project', id: 'p1' }], `outage probe ${i}`, 4);
    let warns = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('semantic leg failed'));
    expect(warns).toHaveLength(8); // one per search — 8 searches, 8 warns
    expect(mockEmbed).toHaveBeenCalledTimes(8); // exactly 8 doomed calls — no retry ladder
    // The 9th search with the breaker open: fail-fast — no embed call, no
    // warn; the breaker's transition row carries the signal instead.
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'outage probe 9', 4);
    expect(hits).toHaveLength(4); // the keyword leg still answers
    warns = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('semantic leg failed'));
    expect(warns).toHaveLength(8); // NO 9th warn
    expect(mockEmbed).toHaveBeenCalledTimes(8); // NO 9th doomed call
  });
});

// ── Log-signal family lane — ticket b019a303 (2026-10-27) ───────────────────────
// The HTTP-status half of the 6348ebff semantic-leg class (its timeout half is
// pinned above): 769 rows/24h (Oct 26-27) of
//   unified-memory: semantic leg failed (keyword leg still runs): Request
//   failed with status code 429
// during the DashScope embed vendor storm (the fleet's embeddings watch:
// unified_memory_embed_failed, decaying ~52% day over day). Same adjudication
// as 6348ebff/2ed4141c (lanes ecc2bb0d/92dc54d6): DESIGNED
// graceful-degradation observability, not a framework defect — the search
// degrades to the keyword leg and still answers, ONE warn per search (volume
// tracks search volume, never a retry ladder), and the embed circuit breaker
// (bcd71d4c1) bounds the volume: after 8 consecutive failures no doomed HTTP
// call and NO further per-search warn.
describe('log-signal b019a303 — the semantic-leg HTTP 429 warn is designed degradation observability (one per search, keyword answers, breaker-bounded)', () => {
  beforeEach(() => {
    mockEmbed.mockImplementation(async () => { throw new Error('Request failed with status code 429'); });
    mockRerank.mockImplementation(async () => null);
  });

  it('REPLAYS the prod row: a 429 embed leg logs the ONE swept warn exactly, and the search still answers via the keyword leg', async () => {
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'what blocked the deploy?', 4);
    expect(hits).toHaveLength(4); // the keyword leg answered — graceful by contract
    const warns = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('semantic leg failed'));
    expect(warns).toEqual(['unified-memory: semantic leg failed (keyword leg still runs): Request failed with status code 429']);
    expect((logger.error as jest.Mock).mock.calls).toHaveLength(0); // warn level — the sweep reads warn+
    expect(mockEmbed).toHaveBeenCalledTimes(1); // ONE doomed call per search — no retry ladder
  });

  it('the volume is bounded by search volume and the breaker: 8 failures open it and the 9th search logs NO warn and makes NO embed call', async () => {
    for (let i = 0; i < 8; i++) await memSearch([{ type: 'project', id: 'p1' }], `storm probe ${i}`, 4);
    let warns = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('semantic leg failed'));
    expect(warns).toHaveLength(8);
    expect(mockEmbed).toHaveBeenCalledTimes(8);
    const hits = await memSearch([{ type: 'project', id: 'p1' }], 'storm probe 9', 4);
    expect(hits).toHaveLength(4); // the keyword leg still answers with the breaker open
    warns = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('semantic leg failed'));
    expect(warns).toHaveLength(8); // NO 9th warn — the breaker's transition row carries the signal
    expect(mockEmbed).toHaveBeenCalledTimes(8); // NO 9th doomed call
  });
});
