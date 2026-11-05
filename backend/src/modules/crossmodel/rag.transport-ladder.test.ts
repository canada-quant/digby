/**
 * RAG transport-resilience regression — the 2026-11-01 incident.
 *
 * WHAT HAPPENED (measured on prod, box-c): the `llm-cql` gateway answered
 * /v1/models in 131 ms and /chat/completions in 133 ms, but /v1/rerank and
 * /v1/embeddings HUNG — no response at 40 s / 90 s with a valid key (an
 * unauthenticated call is rejected in 235 ms, so the hang sat past auth in the
 * upstream worker). Meanwhile the seats read "resolving, servable,
 * recentFailures 0", because seat health comes from the flight log and never
 * from a transport probe.
 *
 * Result: 689 rerankTexts timeouts / 24 h (143 in the last 6 h, newest 13:17Z),
 * 4 742 / 168 h, plus 12 456 digby_memory rows stored keyword-only.
 *
 * THE SHAPE THIS FILE PINS. The old `postRerank` resolved ONE target and asked
 * it once. When that route hung, `rerankTexts` returned null and the caller
 * silently "kept its own order" — a healthy DashScope rung existed the whole
 * time, was never tried, and NOTHING counted the failure (one warn per process,
 * no denominator, so no rate). These tests fail against that code:
 *
 *   1. a dead primary rung must NOT end the call — the next rung serves;
 *   2. the caller's budget is SHARED by the rungs, not spent twice;
 *   3. every attempt emits a counter row, ok or not (failure RATE is answerable);
 *   4. the tags/prefix the log-signal sweep depends on survive the change.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./memory/text-utils', () => ({ stripNulBytes: (s: string) => s }));
jest.mock('./model-endpoints/matryoshka', () => ({ truncateMatryoshka: (v: any) => v }));
jest.mock('../../utils/utility-llm', () => ({ utilityChat: jest.fn() }));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('./model-endpoints/model-roles.service', () => ({
  __esModule: true,
  getModelRoleOverrides: jest.fn(async () => ({})),
}));
jest.mock('./model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: jest.fn(async () => null),
}));
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { RAG_RERANK_CALL: 'rag_rerank_call', RAG_EMBED_CALL: 'rag_embed_call' },
}));
// isNonFaultLogRow is the only thing needed from the sweep, but importing it
// pulls config/redis → config/env (which process.exit(1)s in a keyless jest
// env). Same seam mocks as rag.family-5ae52ca3.test.ts.
jest.mock('../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn(), del: jest.fn() } }));
jest.mock('./fleet/infra-watch.service', () => ({
  __esModule: true,
  adminFleetSupervisors: jest.fn(async () => []),
  deliver: jest.fn(),
}));
jest.mock('./platform/secret-scan', () => ({ __esModule: true, redactSecrets: (s: string) => s }));
jest.mock('./fleet/day-filing-budget', () => ({ __esModule: true, reserveDayFilingSlot: jest.fn(async () => true) }));

import axios from 'axios';
import { getModelRoleOverrides } from './model-endpoints/model-roles.service';
import { resolveRegistryModel } from './model-endpoints/model-endpoints.service';
import { recordLoopMetric } from './platform/loop-metrics.service';
import { isNonFaultLogRow } from './fleet/log-signal-sweep.service';

const mockedAxios = axios as unknown as { post: jest.Mock };
const mockedOverrides = getModelRoleOverrides as unknown as jest.Mock;
const mockedResolve = resolveRegistryModel as unknown as jest.Mock;
const mockedMetric = recordLoopMetric as unknown as jest.Mock;

/* eslint-disable @typescript-eslint/no-explicit-any */
let rag: any;
beforeAll(() => {
  process.env.DASHSCOPE_API_KEY = 'test-key-transport-ladder';
  rag = require('./rag.service');
});
afterAll(() => { delete process.env.DASHSCOPE_API_KEY; });

/**
 * The embed payload SENTINEL (ticket 945b0f69).
 *
 * These rows are checked for payload leakage by grepping the WHOLE serialized
 * row (`JSON.stringify(rows)`), and every row also carries `callId` =
 * randomUUID(), i.e. lowercase hex. So the sentinel must be impossible to spell
 * in hex — the old 3-char sentinel 'abc' was ALL hex letters and reddened main
 * on an unrelated commit when one uuid happened to contain `…-cabc-…`.
 * Uppercase 'ZZZ' cannot appear in a v4 uuid (nor in any of the row's other
 * fields), and staying 3 chars keeps the payload arithmetic below (30 / 6 / 36)
 * exactly as the size-only contract pins it.
 */
const PAYLOAD_SENTINEL = 'ZZZ';

/** The llm-cql rung: the route that actually hung in production. */
const HUNG_TARGET = {
  baseUrl: 'https://llm.cql.ca/v1',
  model: 'Qwen3-Reranker-4B',
  apiKey: 'gateway-key',
  matryoshka: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.post.mockReset();
  mockedOverrides.mockImplementation(async () => ({}));
  mockedResolve.mockImplementation(async () => null);
  // The rung-health latch is process-local state that outlives a test. Reset it
  // or one test's consecutive failures silently change the ladder the next test
  // sees (it did: the "all rungs dead" case read a 1-rung ladder).
  rag.__resetRungHealthForTests();
});

describe('rerank ladder — a dead rung never ends the call (the silent-drop shape)', () => {
  test('THE REGRESSION: a dead rung does NOT end the call — the NEXT rung serves', async () => {
    // The production shape inverted to its general form: whichever rung is dead,
    // the next one serves. DashScope is rung 1 now, so make IT the dead one.
    mockedOverrides.mockImplementation(async () => ({ rerank: 'llm-cql:Qwen3-Reranker-4B' }));
    mockedResolve.mockImplementation(async () => HUNG_TARGET);

    const calls: string[] = [];
    mockedAxios.post.mockImplementation(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('dashscope-intl.aliyuncs.com')) {
        throw Object.assign(new Error('timeout of 9000ms exceeded'), { code: 'ECONNABORTED' });
      }
      if (String(url).includes('llm.cql.ca')) {
        return { data: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] } };
      }
      throw new Error(`unexpected axios.post ${url}`);
    });

    const out = await rag.rerankTexts('q', ['first doc', 'second doc'], 2);

    // Against the OLD single-target code: ONE post, then null — the caller
    // silently kept its own order while a healthy rung sat unused.
    expect(out).not.toBeNull();
    expect(out[0]).toEqual({ index: 1, score: 0.9 });
    // Both rungs were tried, in RUNG ORDER (the built-in serves first).
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('dashscope-intl.aliyuncs.com');
    expect(calls[1]).toContain('llm.cql.ca');
  });

  test('THE COST FIX (goal 79284e7f): when rung 1 serves, the custom rung is NEVER ASKED', async () => {
    // Measured 2026-11-01: the old order asked llm-cql FIRST and paid 4 064–
    // 9 004 ms of dead latency on every call (39 timeouts / 3 successes in a
    // 24 h sample) before DashScope answered in 867–1 854 ms. Rung 1 serving
    // must cost ZERO dead attempts — that is the whole deliverable.
    mockedOverrides.mockImplementation(async () => ({ rerank: 'llm-cql:Qwen3-Reranker-4B' }));
    mockedResolve.mockImplementation(async () => HUNG_TARGET);

    const calls: string[] = [];
    mockedAxios.post.mockImplementation(async (url: string) => {
      calls.push(String(url));
      return { data: { results: [{ index: 0, relevance_score: 0.8 }] } };
    });

    const out = await rag.rerankTexts('q', ['only doc'], 1);

    expect(out).toEqual([{ index: 0, score: 0.8 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('dashscope-intl.aliyuncs.com');
    expect(calls.some(c => c.includes('llm.cql.ca'))).toBe(false);

    // And exactly ONE attempt row — no dead-attempt row per call.
    await new Promise(r => setTimeout(r, 0));
    const rows = mockedMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'rag_rerank_call');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ meta: { ok: true } });
  });

  test('a rung that keeps failing is LATCHED out, then probed again after the cooldown', async () => {
    mockedOverrides.mockImplementation(async () => ({ rerank: 'llm-cql:Qwen3-Reranker-4B' }));
    mockedResolve.mockImplementation(async () => HUNG_TARGET);

    const calls: string[] = [];
    mockedAxios.post.mockImplementation(async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('dashscope-intl.aliyuncs.com')) {
        throw Object.assign(new Error('timeout of 9000ms exceeded'), { code: 'ECONNABORTED' });
      }
      throw Object.assign(new Error('timeout of 6000ms exceeded'), { code: 'ECONNABORTED' });
    });

    // Three consecutive failures latch the custom rung (threshold 3).
    for (let i = 0; i < rag.RERANK_RUNG_FAIL_THRESHOLD; i++) await rag.rerankTexts('q', ['a'], 1);
    expect(rag.rungLatched('llm-cql:Qwen3-Reranker-4B')).toBe(true);

    // A latched rung is skipped — but the ladder is never emptied, so rung 1
    // still serves and rerank is still attempted.
    calls.length = 0;
    await rag.rerankTexts('q', ['a'], 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('dashscope-intl.aliyuncs.com');

    // After the cooldown it is probed again (a latch is a cost guard, not a
    // permanent disable).
    rag.__resetRungHealthForTests();
    expect(rag.rungLatched('llm-cql:Qwen3-Reranker-4B')).toBe(false);
  });

  test('every attempt emits a counter row, so the failure RATE has a denominator', async () => {
    mockedOverrides.mockImplementation(async () => ({ rerank: 'llm-cql:Qwen3-Reranker-4B' }));
    mockedResolve.mockImplementation(async () => HUNG_TARGET);
    mockedAxios.post.mockImplementation(async (url: string) => {
      if (String(url).includes('dashscope-intl.aliyuncs.com')) {
        throw Object.assign(new Error('timeout of 9000ms exceeded'), { code: 'ECONNABORTED' });
      }
      return { data: { results: [{ index: 0, relevance_score: 0.5 }] } };
    });

    await rag.rerankTexts('q', ['a'], 1);
    // The emission is fire-and-forget (dynamic import), so let the microtask run.
    await new Promise(r => setTimeout(r, 0));

    const rows = mockedMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'rag_rerank_call');
    expect(rows).toHaveLength(2);              // one per ATTEMPT — not one per process
    expect(rows[0]).toMatchObject({ meta: { ok: false, errorKind: 'timeout' } });
    expect(rows[1]).toMatchObject({ meta: { ok: true } });
    // The numerator AND the denominator are both recorded.
    expect(rows.filter(r => r.meta.ok === false)).toHaveLength(1);
  });

  test('all rungs dead → still null (the caller contract) but the warn names every rung', async () => {
    mockedOverrides.mockImplementation(async () => ({ rerank: 'llm-cql:Qwen3-Reranker-4B' }));
    mockedResolve.mockImplementation(async () => HUNG_TARGET);
    mockedAxios.post.mockImplementation(async () => {
      throw Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });
    });

    const out = await rag.rerankTexts('q', ['a'], 1);
    expect(out).toBeNull();

    const objectForm = (require('../../utils/logger').default.log as jest.Mock).mock.calls
      .map((c: any[]) => c[0])
      .filter((o: any) => o && o.level === 'warn');
    expect(objectForm).toHaveLength(1);
    const row = objectForm[0];
    // The pinned prefix + tag survive (log-signal sweep contract, f184).
    expect(row.message).toContain('rerankTexts failed — caller keeps its own order: ');
    expect(row).toMatchObject({ logClass: 'external' });
    expect(isNonFaultLogRow({ context: { ...row, level: undefined } } as any)).toBe(true);
    // …and it now names BOTH dead rungs instead of the one it happened to ask.
    expect(row.message).toContain('llm-cql:Qwen3-Reranker-4B');
    expect(row.message).toContain('dashscope:qwen3-rerank');
  });

  test('the caller budget is SHARED across rungs, not spent twice, and NEVER exceeded', async () => {
    expect(rag.ladderRungBudgets(15_000, 2)).toEqual([9_000, 6_000]);
    expect(rag.ladderRungBudgets(8_000, 1)).toEqual([8_000]);
    // Adversarial review 2026-11-01 should-fix 3: the old floor RAISED a small
    // budget (1500 for a 1200 caller; 2x1500 for a 1000 caller). The sum must
    // never exceed what the caller actually granted.
    const sum = (b: number[]) => b.reduce((a, x) => a + x, 0);
    for (const budget of [700, 1_000, 1_200, 15_000]) {
      for (const rungs of [1, 2, 3]) {
        const b = rag.ladderRungBudgets(budget, rungs);
        expect(b).toHaveLength(rungs);
        expect(sum(b)).toBeLessThanOrEqual(budget);
        expect(b.every((x: number) => x >= 1)).toBe(true);
      }
    }
    // A single rung with a tiny budget gets exactly the budget, not more.
    expect(rag.ladderRungBudgets(1_200, 1)).toEqual([1_200]);
  });

  test('a rerank role that fails to RESOLVE must not disable the working rung', async () => {
    mockedOverrides.mockImplementation(async () => ({ rerank: 'gone:model' }));
    mockedResolve.mockImplementation(async () => null);
    mockedAxios.post.mockImplementation(async () => ({ data: { results: [{ index: 0, relevance_score: 0.7 }] } }));
    const out = await rag.rerankTexts('q', ['a'], 1);
    expect(out).toEqual([{ index: 0, score: 0.7 }]);
  });
});

describe('classifyRagError — the metric says WHY the attempt failed', () => {
  test('maps transport shapes to named kinds', () => {
    expect(rag.classifyRagError(Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' })).errorKind).toBe('timeout');
    expect(rag.classifyRagError({ response: { status: 401 } }).errorKind).toBe('auth');
    expect(rag.classifyRagError({ response: { status: 429 } }).errorKind).toBe('http_4xx');
    expect(rag.classifyRagError({ response: { status: 503 } }).errorKind).toBe('http_5xx');
    expect(rag.classifyRagError(new Error('empty rerank results')).errorKind).toBe('empty');
    expect(rag.classifyRagError(new Error('read ECONNRESET')).errorKind).toBe('network');
  });
});

describe('embeddings — one vector space per instance (rotation is a migration, not a retry)', () => {
  test('the embeddings lane fails CLOSED even with an alternate key available', async () => {
    // Measured 2026-11-01: Jul–Oct rows re-embed to cosine 0.63–0.99 against
    // text-embedding-v4, but Nov-1 rows come out ~0.01 — the same 1536-dim
    // column holds two incomparable spaces. A silent embed rotation would add
    // a third. So a hanging embeddings rung must THROW, never rotate.
    mockedOverrides.mockImplementation(async () => ({ embeddings: 'llm-cql:Qwen3-Embedding-8B' }));
    mockedResolve.mockImplementation(async () => ({ ...HUNG_TARGET, model: 'Qwen3-Embedding-8B' }));
    const calls: string[] = [];
    mockedAxios.post.mockImplementation(async (url: string) => {
      calls.push(String(url));
      throw Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
    });

    await expect(rag.embedTexts(['hello'])).rejects.toThrow(/timeout/i);
    // Still NO rotation: every call went to llm-cql, never to DashScope. The
    // count is now the BOUNDED attempt budget (1 attempt + 1 retry) rather than
    // a single ask — the retry is same-provider, so the space never changes.
    expect(rag.embedAttemptRetries() + 1).toBe(calls.length);
    expect(calls.every(c => c.includes('llm.cql.ca'))).toBe(true);
  });

  test('a hung attempt is bounded by EMBED_ATTEMPT_TIMEOUT_MS, never the whole 30 s call budget', async () => {
    // Measured 2026-11-01: every SUCCESS landed in 178–5 859 ms while every
    // timeout pinned at 30 000–30 016 ms, so ~30 % of attempts burned the FULL
    // call budget before failing. The attempt must be capped well below it.
    expect(rag.EMBED_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(rag.EMBED_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(6_000); // > the 5 859 ms slowest success

    mockedOverrides.mockImplementation(async () => ({ embeddings: 'llm-cql:Qwen3-Embedding-8B' }));
    mockedResolve.mockImplementation(async () => ({ ...HUNG_TARGET, model: 'Qwen3-Embedding-8B' }));
    const timeouts: number[] = [];
    mockedAxios.post.mockImplementation(async (_url: string, _body: any, cfg: any) => {
      timeouts.push(cfg?.timeout);
      throw Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
    });

    await expect(rag.embedTexts(['hello'])).rejects.toThrow(/timeout/i);
    // Every attempt asked for a bounded slice — none asked for the 30 s budget.
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every(t => t <= rag.EMBED_ATTEMPT_TIMEOUT_MS)).toBe(true);
  });

  test('the failing embeddings attempt is still COUNTED per attempt (counter, not a bare warn)', async () => {
    mockedOverrides.mockImplementation(async () => ({ embeddings: 'llm-cql:Qwen3-Embedding-8B' }));
    mockedResolve.mockImplementation(async () => ({ ...HUNG_TARGET, model: 'Qwen3-Embedding-8B' }));
    mockedAxios.post.mockImplementation(async () => {
      throw Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
    });

    await expect(rag.embedTexts(['hello'])).rejects.toThrow();
    await new Promise(r => setTimeout(r, 0));
    const rows = mockedMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'rag_embed_call');
    // One row per ATTEMPT (bounded: 1 + retries), plus one CALL-level roll-up.
    // The old shape emitted a single row for the whole call, so a multi-batch
    // call that lost 9 of 10 batches still read as "1 failure".
    const attemptRows = rows.filter(r => r.meta.unit === 'attempt');
    const rollup = rows.filter(r => r.meta.unit !== 'attempt');
    expect(attemptRows).toHaveLength(rag.embedAttemptRetries() + 1);
    expect(attemptRows.every(r => r.meta.ok === false && r.meta.errorKind === 'timeout')).toBe(true);
    expect(rollup).toHaveLength(1);
    expect(rollup[0].meta).toMatchObject({ ok: false, batchFailures: attemptRows.length });
  });

  // Ticket d59499f4: the post-fix failures land milliseconds short of the
  // caller's bound, so the honest next lever is chunk/batch sizing — and that
  // choice needs the PAYLOAD distribution. Without a size on the row the
  // experiment is blind and its result unattributable against a payload mix
  // that may itself have shifted.
  test('every embed row carries a payload size — chars per attempt, batchChars per call', async () => {
    mockedOverrides.mockImplementation(async () => ({ embeddings: 'llm-cql:Qwen3-Embedding-8B' }));
    mockedResolve.mockImplementation(async () => ({ ...HUNG_TARGET, model: 'Qwen3-Embedding-8B' }));
    mockedAxios.post.mockImplementation(async () => ({ data: { data: [{ index: 0, embedding: new Array(1536).fill(0.01) }] } }));

    // 12 inputs → two batches of 10 + 2, 3 chars each = 36 chars total.
    const texts = new Array(12).fill(PAYLOAD_SENTINEL);
    await rag.embedTexts(texts);
    await new Promise(r => setTimeout(r, 0));

    const rows = mockedMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'rag_embed_call');
    const attemptRows = rows.filter(r => r.meta.unit === 'attempt');
    const rollup = rows.filter(r => r.meta.unit !== 'attempt');

    expect(attemptRows).toHaveLength(2);
    // Batch 1 = 10 × 3 chars, batch 2 = 2 × 3 chars — the ACTUAL payload sent.
    expect(attemptRows.map(r => r.meta.chars)).toEqual([30, 6]);
    expect(rollup).toHaveLength(1);
    expect(rollup[0].meta).toMatchObject({ batchChars: 36, batchCount: 2 });
    // Never the payload itself — a size only.
    expect(JSON.stringify(rows)).not.toContain(PAYLOAD_SENTINEL);
  });

  // Ticket 945b0f69 — the FLAKE this suite used to hand main's CI. The
  // payload-leak assertion greps the WHOLE serialized row, and every row also
  // carries `callId` = randomUUID() (rag.service.ts per-attempt call ids). A v4
  // uuid is [0-9a-f], so a 3-char alphabetic sentinel can turn up inside its
  // hex purely by luck: ci.yml run 41532057538 reddened an unrelated
  // frontend-only commit because one uuid happened to read `…-cabc-…`. The
  // sentinel is now non-hex, and this replay forces the EXACT uuid from that
  // red run so the trap is exercised deterministically instead of 1-in-a-few-
  // thousand. RED against the old sentinel ('abc'): the payload grep hits the
  // uuid. GREEN now: the uuid is still in the row, but nothing matches.
  test('ticket 945b0f69 REPLAY: a callId whose hex spells payload text cannot red the size-only assertion', async () => {
    // The uuid from the red CI run. 'abc' is buried in the third group.
    const FLAKE_UUID = 'f8a5b7b5-cabc-4ff8-a8d7-59d3eaeebf0b';
    const cryptoMod = require('crypto');
    const uuidSpy = jest.spyOn(cryptoMod, 'randomUUID').mockReturnValue(FLAKE_UUID as any);
    try {
      mockedOverrides.mockImplementation(async () => ({ embeddings: 'llm-cql:Qwen3-Embedding-8B' }));
      mockedResolve.mockImplementation(async () => ({ ...HUNG_TARGET, model: 'Qwen3-Embedding-8B' }));
      mockedAxios.post.mockImplementation(async () => ({ data: { data: [{ index: 0, embedding: new Array(1536).fill(0.01) }] } }));

      const texts = new Array(12).fill(PAYLOAD_SENTINEL);
      await rag.embedTexts(texts);
      await new Promise(r => setTimeout(r, 0));

      const rows = mockedMetric.mock.calls.map(c => c[0]).filter(r => r.kind === 'rag_embed_call');
      // The trap is LIVE in this run: the uuid really is in the serialized rows
      // and its hex really does spell the OLD sentinel. Under the old sentinel
      // this whole-row grep was the red CI assertion on a green commit.
      const serialized = JSON.stringify(rows);
      expect(serialized).toContain(FLAKE_UUID);
      expect(serialized).toContain('abc');

      // The size-only contract is untouched by the correlator id.
      const attemptRows = rows.filter(r => r.meta.unit === 'attempt');
      expect(attemptRows.map(r => r.meta.chars)).toEqual([30, 6]);
      expect(rows.filter(r => r.meta.unit !== 'attempt')[0].meta).toMatchObject({ batchChars: 36, batchCount: 2 });
      // …and the payload text itself is still nowhere in the row.
      expect(JSON.stringify(rows)).not.toContain(PAYLOAD_SENTINEL);
    } finally {
      uuidSpy.mockRestore();
    }
  });
});