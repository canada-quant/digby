/**
 * RAG-1 — SAME-RUN RAW RECALL (goal 9ecd595e / todo 6fa816ee, WRP-1 defect D4).
 *
 * THE INCIDENT this test reproduces, in one run: a live chat run fetched a SERP,
 * an offload wrote it into session memory, and `search_memory` — in the SAME run,
 * for the SAME scope — answered "Memory doesn't have it." Nothing was wrong with
 * the store. Recall meant embed → vector → FTS → RRF → rerank, and that ladder
 * answered empty for a query phrased differently from the stored row.
 *
 * THE OLD BEHAVIOUR THIS FILE FAILS ON: `searchMemory` with `sameRunRecall` on
 * and a fresh overlapping row present used to go straight to the hybrid ladder
 * and return [] — the assertion `expect(out).not.toHaveLength(0)` in the
 * write-then-miss case is the one that fails without the fix.
 *
 * Pinned here:
 *   1. write-then-miss in ONE run: raw path answers, and the embed/vector legs
 *      are never even reached (that is the durability property — a live result
 *      must not need a provider round-trip to be recalled);
 *   2. raw-FALLBACK: the hybrid ladder returns nothing but the scope holds fresh
 *      rows → the rows are returned, labelled, and the regression counter fires
 *      with path 'raw-fallback';
 *   3. a ranked hit is NEVER overridden by raw rows (no recency regression);
 *   4. the freshness window and the overlap guard both gate the raw path — a row
 *      from days ago, or a fresh row about something else, leaves the hybrid
 *      pipeline in charge;
 *   5. opt-in: without `sameRunRecall` (every injected reader) no raw read runs;
 *   6. SAME_RUN_RAW_RECALL_DISABLED=1 restores the pre-fix behaviour exactly.
 */
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { projectDocument: { count: jest.fn(async () => 0) } },
}));
jest.mock('../rag.service', () => ({
  __esModule: true,
  embedTexts: jest.fn(),
  rerankTexts: jest.fn(async () => null),
  retrieveChunks: jest.fn(async () => []),
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  ...jest.requireActual('../memory/unified-memory.service'),
  memSearch: jest.fn(async () => []),
  memSearchForUser: jest.fn(async () => []),
  memSearchArchive: jest.fn(async () => []),
  memSearchArchiveForUser: jest.fn(async () => []),
  memRecentRows: jest.fn(async () => []),
  memRecentRowsForUser: jest.fn(async () => []),
}));
jest.mock('../memory/memory-access', () => ({
  __esModule: true,
  authorizedProjectScopeIds: jest.fn(async (_u: string, ids: string[]) => ids),
  ownsAllProjects: jest.fn(async () => true),
}));
jest.mock('../platform/folder-inheritance', () => ({ __esModule: true, getRagScopeFolderIds: jest.fn(async (id: string) => [id]) }));
jest.mock('../langgraph/memory.graph', () => ({ __esModule: true, getProjectSettings: jest.fn(async () => ({ crossProjectMemory: true })) }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: jest.fn(),
}));

import { searchMemory } from './coding-retrieval.service';
import { RAW_RECALL_LABEL, pickRawRecall, overlapRatio, recallTokens } from '../memory/same-run-recall';
import { LOOP_METRIC_KINDS } from '../platform/loop-metric-kinds';

const { memSearch, memSearchForUser, memRecentRows, memRecentRowsForUser } = jest.requireMock('../memory/unified-memory.service');

const QUERY = 'Polk County 281 arrested human trafficking bust';

/** A stored row, `ageMinutes` old — the memo the run wrote into its own scope. */
const rawRow = (content: string, ageMinutes = 2, extra: Record<string, unknown> = {}) => ({
  id: `row-${Math.random().toString(36).slice(2, 8)}`,
  ref: 'search_engine: Polk County 281 arrested',
  title: 'SERP — Polk County 281 arrested human trafficking bust',
  source: 'orchestrator',
  content,
  scopeType: 'session',
  scopeId: 's1',
  createdAt: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
  createdMs: Date.now() - ageMinutes * 60_000,
  ...extra,
});

const SERP = 'WESH: Polk County sheriff announces 281 arrested in human trafficking operation, 12 rescued. Deputies said the operation ran for six months.';
const hit = (ref: string, content: string) => ({ ref, title: '', source: 'orchestrator', content, scopeType: 'session', scopeId: 's1', createdAt: new Date().toISOString() });

const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  jest.clearAllMocks();
  for (const m of [memSearch, memSearchForUser, memRecentRows, memRecentRowsForUser]) m.mockImplementation(async () => []);
  delete process.env.SAME_RUN_RAW_RECALL_DISABLED;
  delete process.env.SAME_RUN_WINDOW_MINUTES;
});

describe('RAG-1 — write-then-miss inside ONE run', () => {
  it('recalls the row the run just wrote, WITHOUT touching the embed/vector ladder', async () => {
    // The write half: the SERP is in session memory, written two minutes ago.
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 2)]);
    // The read half: the hybrid ladder answers NOTHING for the model's phrasing
    // (this is exactly what produced "Memory doesn't have it" in prod).
    memSearchForUser.mockResolvedValue([]);

    const out = await searchMemory('s1', QUERY, 6, { scope: 'session', userId: 'u1', sameRunRecall: true });

    expect(out).not.toHaveLength(0);                        // ← FAILS on the old behaviour ([] here)
    expect(out[0].content).toContain('281 arrested');
    expect(out[0].content.startsWith(RAW_RECALL_LABEL)).toBe(true);
    // The recall path is an index read: no semantic work at all.
    expect(memSearchForUser).not.toHaveBeenCalled();
  });

  it('falls back to raw rows when the hybrid ladder returns nothing (semantic miss never renders as "not found")', async () => {
    // No vocabulary overlap — so the PRE-hybrid guard declines (`first`) …
    const row = rawRow('SERP dump: unrelated widget inventory 42 units in the Vancouver warehouse', 3,
      { title: 'SERP — widget inventory' });
    expect(pickRawRecall([row], QUERY, 'first')).toBeNull();
    memRecentRowsForUser.mockResolvedValue([row]);
    memSearchForUser.mockResolvedValue([]);

    // … but the post-hybrid FALLBACK still refuses to answer "nothing stored".
    const out = await searchMemory('s1', QUERY, 6, { scope: 'session', userId: 'u1', sameRunRecall: true });
    expect(out).toHaveLength(1);
    expect(out[0].content.startsWith(RAW_RECALL_LABEL)).toBe(true);
    await flush();
  });

  it('fires the regression counter with path raw-first (the incident class is raw-fallback)', async () => {
    const { recordLoopMetric } = jest.requireMock('../platform/loop-metrics.service');
    recordLoopMetric.mockClear();
    // raw-first: fresh + overlapping.
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 1)]);
    await searchMemory('s1', QUERY, 6, { scope: 'session', userId: 'u1', sameRunRecall: true });
    await flush();
    expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: LOOP_METRIC_KINDS.MEMORY_SAME_RUN_RAW_RECALL,
      value: 1,
      meta: expect.objectContaining({ path: 'raw-first' }),
    }));
  });

  it('says raw-fallback when the ranked ladder missed (the incident path)', async () => {
    const { recordLoopMetric } = jest.requireMock('../platform/loop-metrics.service');
    recordLoopMetric.mockClear();
    memRecentRowsForUser.mockResolvedValue([rawRow('SERP: widget inventory', 2, { title: 'SERP — widget inventory' })]);
    memSearchForUser.mockResolvedValue([]);
    await searchMemory('s1', QUERY, 6, { scope: 'session', userId: 'u1', sameRunRecall: true });
    await flush();
    expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: LOOP_METRIC_KINDS.MEMORY_SAME_RUN_RAW_RECALL,
      meta: expect.objectContaining({ path: 'raw-fallback' }),
    }));
  });
});

/**
 * ATTRIBUTION (2026-10-31, VERIFY-4 criterion (c)).
 *
 * The first cut of the regression counter emitted NO caller identity — the row
 * landed with `chat:null`/`run:null`. That made acceptance criterion (c) ("the
 * just-fetched SERP is retrievable in the SAME run") UNMEASURABLE BY
 * CONSTRUCTION: a live probe cannot say "THIS run took the raw path", because no
 * row on the metric names the run. A `raw-fallback = 0` KPI did not cover it —
 * a zero with no chat attached proves nothing about any particular run.
 *
 * These pin the fix so it cannot silently regress to an unattributable counter.
 */
describe('RAG-1 — the raw-recall counter must be ATTRIBUTABLE to its run', () => {
  it('stamps the row sessionId and meta.chatId, so the metric can be filtered by run', async () => {
    const { recordLoopMetric } = jest.requireMock('../platform/loop-metrics.service');
    recordLoopMetric.mockClear();
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 1)]);
    await searchMemory('s1', QUERY, 6, { scope: 'session', userId: 'u1', sameRunRecall: true });
    await flush();
    expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: LOOP_METRIC_KINDS.MEMORY_SAME_RUN_RAW_RECALL,
      // the row COLUMN the 'deploy'/'metrics' view's chatId filter reads
      sessionId: 's1',
      meta: expect.objectContaining({ path: 'raw-first', chatId: 's1' }),
    }));
  });

  it('prefers the explicit chat scope when the caller passes one', async () => {
    const { recordLoopMetric } = jest.requireMock('../platform/loop-metrics.service');
    recordLoopMetric.mockClear();
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 1)]);
    await searchMemory('s1', QUERY, 6, {
      scope: 'session', userId: 'u1', sameRunRecall: true, chatScopeId: 'chat-abc',
    });
    await flush();
    expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ chatId: 'chat-abc' }),
    }));
  });

  it('never emits chatId as undefined — an unattributable row is an explicit null', async () => {
    const { recordLoopMetric } = jest.requireMock('../platform/loop-metrics.service');
    recordLoopMetric.mockClear();
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 1)]);
    // No chatScopeId: attribution falls back to the session id, never undefined.
    await searchMemory('s1', QUERY, 6, { scope: 'session', userId: 'u1', sameRunRecall: true });
    await flush();
    const meta = recordLoopMetric.mock.calls.at(-1)?.[0]?.meta;
    expect(meta).toHaveProperty('chatId');
    expect(meta.chatId).not.toBeUndefined();
  });
});

describe('RAG-1 — the raw path must never degrade ranked recall', () => {
  it('a ranked hybrid hit wins; raw rows are not consulted', async () => {
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 1)]);
    memSearchForUser.mockResolvedValue([hit('ranked', 'a properly ranked finding about the operation')]);
    // A query with NO overlap keeps the pre-hybrid guard out, so the ranked hit is what answers.
    const out = await searchMemory('s1', 'quarterly budget reconciliation', 6, { scope: 'session', userId: 'u1', sameRunRecall: true });
    expect(out.map((f) => f.ref)).toEqual(['ranked']);
    expect(out[0].content.startsWith(RAW_RECALL_LABEL)).toBe(false);
  });

  it('a row older than the same-run window never enters the raw path', async () => {
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 60 * 24 * 3)]); // three days old
    memSearchForUser.mockResolvedValue([]);
    const out = await searchMemory('s1', QUERY, 6, { scope: 'session', userId: 'u1', sameRunRecall: true });
    expect(out).toHaveLength(0);
  });

  it('project scope is not raw-recalled — durable knowledge keeps the ranked read', async () => {
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 1)]);
    memSearchForUser.mockResolvedValue([]);
    const out = await searchMemory('s1', QUERY, 6, { scope: 'project', projectId: 'p1', userId: 'u1', sameRunRecall: true });
    expect(out).toHaveLength(0);
    expect(memRecentRowsForUser).not.toHaveBeenCalled();
    expect(memSearchForUser).toHaveBeenCalled();
  });
});

describe('RAG-1 — opt-in and kill switch', () => {
  it('is OFF by default (an injected reader must not trade ranked recall for recency)', async () => {
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 1)]);
    memSearchForUser.mockResolvedValue([]);
    const out = await searchMemory('s1', QUERY, 6, { scope: 'session', userId: 'u1' });
    expect(out).toHaveLength(0);
    expect(memRecentRowsForUser).not.toHaveBeenCalled();
  });

  it('SAME_RUN_RAW_RECALL_DISABLED=1 restores the pre-fix read byte-for-byte', async () => {
    process.env.SAME_RUN_RAW_RECALL_DISABLED = '1';
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 1)]);
    memSearchForUser.mockResolvedValue([]);
    const out = await searchMemory('s1', QUERY, 6, { scope: 'session', userId: 'u1', sameRunRecall: true });
    expect(out).toHaveLength(0);
    expect(memRecentRowsForUser).not.toHaveBeenCalled();
  });

  it('SAME_RUN_WINDOW_MINUTES widens the window (a long research run)', async () => {
    process.env.SAME_RUN_WINDOW_MINUTES = '600';
    memRecentRowsForUser.mockResolvedValue([rawRow(SERP, 300)]); // 5 h old
    memSearchForUser.mockResolvedValue([]);
    const out = await searchMemory('s1', QUERY, 6, { scope: 'session', userId: 'u1', sameRunRecall: true });
    expect(out).toHaveLength(1);
  });
});

describe('RAG-1 — the selection leaf', () => {
  it('tokenises and scores overlap deterministically', () => {
    expect(recallTokens('The Polk County bust').has('the')).toBe(false); // stopword
    expect(overlapRatio('polk county arrests', 'Polk County sheriff announced arrests')).toBe(1);
    expect(overlapRatio('polk county arrests', 'unrelated widget inventory')).toBe(0);
  });

  it('an unparseable timestamp is not evidence of freshness', () => {
    const bad = { ...rawRow(SERP, 1), createdAt: 'not-a-date', createdMs: 0 };
    expect(pickRawRecall([bad], QUERY, 'fallback')).toBeNull();
  });

  it('bounds the rows it returns and orders them freshest-first', () => {
    const rows = [
      rawRow('Polk County 281 arrested older', 30),
      rawRow('Polk County 281 arrested newest', 1),
      rawRow('Polk County 281 arrested middle', 10),
    ];
    const pick = pickRawRecall(rows, QUERY, 'first', { k: 2 });
    expect(pick?.rows).toHaveLength(2);
    expect(pick?.rows[0].content).toContain('newest');
    expect(pick?.rows[1].content).toContain('middle');
  });
});