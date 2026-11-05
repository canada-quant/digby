/**
 * PER-ATTEMPT LEG ATTRIBUTION (ticket b5f4d5e2) — the structural blind spot.
 *
 * WHAT WAS PROVEN (2026-11-02, lane 129f28ba): the LiteLLM gateway container log
 * for 2026-10-29T14:02 → 2026-11-02T03:31 held 4 713 embed requests, all 4 713
 * answered 200, zero 4xx/5xx — including all 691 requests in the 23:00Z hour
 * that `loop_metrics` recorded as 70 call-level failures. Both legs were healthy
 * at 04:31Z (AGX 3/3 @0.99 s, a367 3/3 @0.088 s). So the failures were never
 * provider faults: they were OUR caller aborting at its ~8 000 ms per-attempt
 * bound, discarding a response the gateway was still going to serve.
 *
 * The row could not tell that apart from a provider fault, and named no leg, no
 * duration and no abort side — so a 47 %-failure P1 regression was measurable
 * but not localizable. The rerank seat had the identical hole.
 *
 * THESE TESTS FAIL AGAINST THE OLD CODE, one acceptance limb each:
 *   1. a SUCCESS names the leg from the gateway's own response headers;
 *   2. a CALLER abort is typed `caller_timeout` and carries the call id that is
 *      the only way back to the gateway's row (there is no leg header to read);
 *   3. a PROVIDER error is typed `provider_error` and keeps the leg it named —
 *      the distinction limb 2 vs 3 is the whole ticket;
 *   4. a 2xx with an unusable body is `parse_failure`, never a transport fault;
 *   5. every attempt row already carries the wall-clock duration (`ms`, and the
 *      row `value`) — nothing new needed, but it must not go missing;
 *   6. the RERANK lane gets the same treatment (the ticket names it explicitly);
 *   7. classification is a pure, table-testable function.
 *
 * The header contract is not folklore: LiteLLM's ProxyBaseLLMRequestProcessing
 * .get_custom_headers emits `x-litellm-model-api-base` (the upstream that
 * answered — this is what separates AGX from spark-a367) and
 * `x-litellm-model-id` on a 200, emits `x-litellm-model-id` on an error
 * response, and emits NOTHING on a caller-side abort (no response exists).
 * It echoes a client-supplied `x-litellm-call-id` back, which is why the caller
 * sends one.
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

import axios from 'axios';
import { getModelRoleOverrides } from './model-endpoints/model-roles.service';
import { resolveRegistryModel } from './model-endpoints/model-endpoints.service';
import { recordLoopMetric } from './platform/loop-metrics.service';

const mockedAxios = axios as unknown as { post: jest.Mock };
const mockedOverrides = getModelRoleOverrides as unknown as jest.Mock;
const mockedResolve = resolveRegistryModel as unknown as jest.Mock;
const mockedMetric = recordLoopMetric as unknown as jest.Mock;

/* eslint-disable @typescript-eslint/no-explicit-any */
let rag: any;
beforeAll(() => {
  process.env.DASHSCOPE_API_KEY = 'test-key-leg-attribution';
  rag = require('./rag.service');
});
afterAll(() => { delete process.env.DASHSCOPE_API_KEY; });

/** The two legs the incident could not tell apart. */
const AGX_BASE = 'https://agx-a.stanne.local:8001/v1';
const SPARK_BASE = 'https://spark-a367.stanne.local:8001/v1';

const EMBED_TARGET = {
  baseUrl: 'https://llm.cql.ca/v1',
  model: 'Qwen3-Embedding-8B',
  apiKey: 'gateway-key',
  matryoshka: false,
};

/** One 1536-dim vector — the only shape the store accepts. */
const VEC = new Array(1536).fill(0.01);

/** Headers a LiteLLM 200 carries (the subset the caller reads). */
const successHeaders = (apiBase: string, modelId: string, callId?: string) => ({
  'content-type': 'application/json',
  'x-litellm-model-api-base': apiBase,
  'x-litellm-model-id': modelId,
  ...(callId ? { 'x-litellm-call-id': callId } : {}),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.post.mockReset();
  mockedOverrides.mockImplementation(async () => ({}));
  mockedResolve.mockImplementation(async () => null);
  rag.__resetRungHealthForTests();
});

/** Attempt rows for a kind. The EMBED lane tags attempts `unit:'attempt'` so a
 *  rate can name its denominator against the call-level roll-up; the RERANK
 *  lane emits ONE row per attempt and no roll-up, so it carries no unit at all.
 *  Filtering both the same way would read zero rerank rows and call it a pass. */
const attemptRows = (kind: 'rag_embed_call' | 'rag_rerank_call') =>
  mockedMetric.mock.calls.map(c => c[0]).filter((r) => {
    if (r.kind !== kind) return false;
    return kind === 'rag_rerank_call' ? true : r.meta?.unit === 'attempt';
  });

/** Route the embeddings seat at the gateway so the custom lane runs. */
const useGatewayEmbeddingsSeat = () => {
  mockedOverrides.mockImplementation(async () => ({ embeddings: 'llm-cql:Qwen3-Embedding-8B' }));
  mockedResolve.mockImplementation(async () => ({ ...EMBED_TARGET }));
};

describe('embed attempts name the leg that served them (ticket b5f4d5e2, limb 1)', () => {
  test('a SUCCESS records the serving deployment from the gateway headers', async () => {
    useGatewayEmbeddingsSeat();
    mockedAxios.post.mockImplementation(async () => ({
      data: { data: [{ index: 0, embedding: VEC }] },
      headers: successHeaders(AGX_BASE, 'deploy-uuid-agx'),
    }));

    await rag.embedTexts(['hello']);
    await new Promise(r => setTimeout(r, 0));

    const [row] = attemptRows('rag_embed_call');
    // Host-only: the path/query say nothing about WHICH deployment and would
    // spend a third of the 240-char visible meta budget on a constant.
    expect(row.meta.leg).toBe('agx-a.stanne.local:8001');
    expect(row.meta.ok).toBe(true);
    // The duration limb: wall-clock on the row AND as the metric value.
    expect(typeof row.meta.ms).toBe('number');
    expect(row.value).toBe(row.meta.ms);
    // A success has no abort reason to report — absent, never a guessed value.
    expect(row.meta.abort).toBeUndefined();
  });

  test('the SAME model group can answer from either leg, and the row says which', async () => {
    // The whole point: routing is order:1, so consecutive attempts can land on
    // different deployments. Two attempts, two legs, distinguishable afterwards.
    useGatewayEmbeddingsSeat();
    let n = 0;
    mockedAxios.post.mockImplementation(async () => {
      const apiBase = n++ === 0 ? AGX_BASE : SPARK_BASE;
      return { data: { data: [{ index: 0, embedding: VEC }] }, headers: successHeaders(apiBase, `id-${n}`) };
    });

    await rag.embedTexts(['first']);
    await rag.embedTexts(['second']);
    await new Promise(r => setTimeout(r, 0));

    const legs = attemptRows('rag_embed_call').map(r => r.meta.leg);
    expect(legs).toEqual(['agx-a.stanne.local:8001', 'spark-a367.stanne.local:8001']);
  });

  test('a direct-to-provider lane (no gateway) is honestly leg-less, not fabricated', async () => {
    // DashScope directly: no x-litellm-* headers exist. The field must be ABSENT
    // rather than a made-up label — "no leg reported" is a real, readable state.
    mockedAxios.post.mockImplementation(async () => ({ data: { data: [{ index: 0, embedding: VEC }] } }));

    await rag.embedTexts(['hello']);
    await new Promise(r => setTimeout(r, 0));

    const [row] = attemptRows('rag_embed_call');
    expect(row.meta.leg).toBeUndefined();
    expect(row.meta.ok).toBe(true);
  });
});

describe('the abort side is typed, so "who gave up" is a read not an inference (limbs 2-4)', () => {
  test('OUR per-attempt bound firing is caller_timeout, and carries the call id', async () => {
    // THE INCIDENT SHAPE, exactly: we abort, the gateway goes on to serve and log
    // a 200 nobody reads. There is no response, so no leg header — the call id we
    // SENT is the only join key back to the gateway's own row.
    useGatewayEmbeddingsSeat();
    const sentCallIds: string[] = [];
    mockedAxios.post.mockImplementation(async (_url: string, _body: any, cfg: any) => {
      sentCallIds.push(cfg?.headers?.['x-litellm-call-id']);
      throw Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' });
    });

    await expect(rag.embedTexts(['hello'])).rejects.toThrow(/timeout/i);
    await new Promise(r => setTimeout(r, 0));

    const rows = attemptRows('rag_embed_call');
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.meta.abort).toBe('caller_timeout');
      expect(r.meta.ok).toBe(false);
      // No response ⇒ no leg header. Absent, and the aggregate bins it as null.
      expect(r.meta.leg).toBeUndefined();
      // The correlator: a per-attempt uuid we SENT on the request.
      expect(typeof r.meta.callId).toBe('string');
      expect(r.meta.callId).toMatch(/^[0-9a-f-]{36}$/);
    }
    // Distinct per attempt — a retry is a different request, so it must be a
    // different key (one shared id would collapse two gateway rows into one).
    expect(new Set(rows.map(r => r.meta.callId)).size).toBe(rows.length);
    expect(sentCallIds.every(id => typeof id === 'string' && id.length === 36)).toBe(true);
  });

  test('a PROVIDER-side error is provider_error and KEEPS the leg it named', async () => {
    // This is the limb the incident needed: a 5xx from the gateway names the
    // deployment, so the leg survives even though the attempt failed.
    useGatewayEmbeddingsSeat();
    mockedAxios.post.mockImplementation(async () => {
      throw Object.assign(new Error('Request failed with status code 503'), {
        response: { status: 503, headers: { 'x-litellm-model-id': 'deploy-uuid-spark', 'x-litellm-call-id': 'gw-call-1' } },
      });
    });

    await expect(rag.embedTexts(['hello'])).rejects.toThrow();
    await new Promise(r => setTimeout(r, 0));

    const [row] = attemptRows('rag_embed_call');
    expect(row.meta.abort).toBe('provider_error');
    expect(row.meta.errorKind).toBe('http_5xx');
    expect(row.meta.status).toBe(503);
    // model-id only on an error response (LiteLLM's error path passes no
    // api_base) → the row says `id:…` rather than pretending it knows the host.
    // The full id is kept (review B5): a short prefix merged two real legs.
    expect(row.meta.leg).toBe('id:deploy-uuid-spark');
  });

  test('a 2xx with an unusable body is parse_failure, never a transport fault', async () => {
    useGatewayEmbeddingsSeat();
    mockedAxios.post.mockImplementation(async () => ({
      data: { data: [{ index: 0, embedding: new Array(4096).fill(0.01) }] },
      headers: successHeaders(AGX_BASE, 'deploy-uuid-agx'),
    }));

    await expect(rag.embedTexts(['hello'])).rejects.toThrow(/4096 dimensions/);
    await new Promise(r => setTimeout(r, 0));

    const [row] = attemptRows('rag_embed_call');
    // The ATTEMPT succeeded at the transport layer (the vector shape is checked
    // after the loop), so the attempt row is a success with its leg — and the
    // call-level row is the one that has to carry the parse fault.
    expect(row.meta.ok).toBe(true);
    expect(row.meta.leg).toBe('agx-a.stanne.local:8001');
    const callRow = mockedMetric.mock.calls.map(c => c[0])
      .filter(r => r.kind === 'rag_embed_call' && r.meta?.unit !== 'attempt').pop()!;
    expect(callRow.meta).toMatchObject({ ok: false, errorKind: 'dims' });
  });
});

describe('the RERANK seat gets the same attribution (limb 6)', () => {
  test('a served rung records its leg; a dead rung records caller_timeout', async () => {
    mockedOverrides.mockImplementation(async () => ({ rerank: 'llm-cql:Qwen3-Reranker-4B' }));
    mockedResolve.mockImplementation(async () => ({ ...EMBED_TARGET, model: 'Qwen3-Reranker-4B' }));

    mockedAxios.post.mockImplementation(async (url: string) => {
      // Rung 1 (DashScope) is the dead one — the 2026-11-01 shape.
      if (String(url).includes('dashscope-intl.aliyuncs.com')) {
        throw Object.assign(new Error('timeout of 9000ms exceeded'), { code: 'ECONNABORTED' });
      }
      return {
        data: { results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] },
        headers: successHeaders(SPARK_BASE, 'deploy-uuid-spark'),
      };
    });

    const out = await rag.rerankTexts('q', ['a', 'b'], 2);
    expect(out).toEqual([{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }]);
    await new Promise(r => setTimeout(r, 0));

    const rows = attemptRows('rag_rerank_call');
    expect(rows).toHaveLength(2);
    expect(rows[0].meta).toMatchObject({ ok: false, abort: 'caller_timeout' });
    expect(rows[0].meta.leg).toBeUndefined();
    expect(typeof rows[0].meta.callId).toBe('string');
    expect(rows[1].meta).toMatchObject({ ok: true, leg: 'spark-a367.stanne.local:8001' });
    // Duration on every row, success and failure alike.
    expect(rows.every(r => typeof r.meta.ms === 'number' && r.value === r.meta.ms)).toBe(true);
  });

  test('an empty 2xx body from a rung is parse_failure and still names the leg', async () => {
    mockedOverrides.mockImplementation(async () => ({ rerank: 'llm-cql:Qwen3-Reranker-4B' }));
    mockedResolve.mockImplementation(async () => ({ ...EMBED_TARGET, model: 'Qwen3-Reranker-4B' }));
    mockedAxios.post.mockImplementation(async () => ({
      data: { results: [] },
      headers: successHeaders(AGX_BASE, 'deploy-uuid-agx'),
    }));

    const out = await rag.rerankTexts('q', ['a'], 1);
    expect(out).toBeNull(); // the caller keeps its own order — contract preserved
    await new Promise(r => setTimeout(r, 0));

    const rows = attemptRows('rag_rerank_call');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.meta.abort === 'parse_failure')).toBe(true);
    expect(rows[0].meta.leg).toBe('agx-a.stanne.local:8001');
  });
});

describe('classifyAbortReason — the table, tested without a network (limb 7)', () => {
  const cases: Array<[string, any, string]> = [
    ['our axios bound fired', Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' }), 'caller_timeout'],
    ['ETIMEDOUT with no response', Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }), 'caller_timeout'],
    ['provider answered 504', Object.assign(new Error('timeout of 8000ms exceeded'), { response: { status: 504 } }), 'provider_error'],
    ['provider answered 503', { response: { status: 503 }, message: 'nope' }, 'provider_error'],
    ['provider answered 401', { response: { status: 401 }, message: 'unauthorized' }, 'provider_error'],
    ['2xx with wrong dims', new Error('returned 4096 dimensions'), 'parse_failure'],
    ['2xx with no rerank results', new Error('empty rerank results'), 'parse_failure'],
    ['transport reset', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), 'network'],
    ['unrecognised', new Error('something else entirely'), 'unknown'],
  ];
  test.each(cases)('%s → %s', (_label, err, expected) => {
    expect(rag.classifyAbortReason(err)).toBe(expected);
  });

  test('a provider timeout is NOT our abort — the presence of a response settles it', () => {
    // The single most important line in this ticket: both errors carry the word
    // "timeout", and only one of them means "we gave up on a provider that was
    // about to answer".
    const ours = Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' });
    const theirs = Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED', response: { status: 504 } });
    expect(rag.classifyAbortReason(ours)).toBe('caller_timeout');
    expect(rag.classifyAbortReason(theirs)).toBe('provider_error');
  });
});

describe('the visible 240-char meta window keeps every field a consumer must read (review B2)', () => {
  /** The fleet view truncates the rendered meta at TELEMETRY_META_CHARS. The
   *  worst case is a FAILING attempt row: it carries BOTH `abort` and the
   *  36-char `callId`, so it is ~36 chars longer than a success. If the field
   *  ordering puts the caller id anywhere but last, exactly the failing rows —
   *  the population this ticket is about — lose `unit`, and `unit` exists
   *  nowhere else on the row (the rag path never sets the DB column), making a
   *  failed attempt indistinguishable from a call-roll-up row on the read. */
  const META_CHARS = 240;
  const rendered = (meta: Record<string, unknown>) => JSON.stringify(meta);

  test('a FAILING attempt row still shows unit/leg/abort/ok/ms inside the window', async () => {
    useGatewayEmbeddingsSeat();
    mockedAxios.post.mockImplementation(async () => {
      throw Object.assign(new Error('Request failed with status code 503'), {
        response: { status: 503, headers: { 'x-litellm-model-id': 'Qwen3-Embedding-8B-agx', 'x-litellm-call-id': 'echoed-id' } },
      });
    });

    await expect(rag.embedTexts(['hello'])).rejects.toThrow();
    await new Promise(r => setTimeout(r, 0));

    const [row] = attemptRows('rag_embed_call');
    const text = rendered(row.meta);
    const visible = text.slice(0, META_CHARS);
    for (const key of ['"unit":"attempt"', '"ok":false', '"ms"', '"leg"', '"abort":"provider_error"']) {
      expect(visible).toContain(key);
    }
  });

  test('the long caller id is the LAST key, so it is the only thing truncation can eat', async () => {
    useGatewayEmbeddingsSeat();
    mockedAxios.post.mockImplementation(async () => {
      throw Object.assign(new Error('timeout of 8000ms exceeded'), { code: 'ECONNABORTED' });
    });

    await expect(rag.embedTexts(['hello'])).rejects.toThrow(/timeout/i);
    await new Promise(r => setTimeout(r, 0));

    const [row] = attemptRows('rag_embed_call');
    const keys = Object.keys(row.meta);
    expect(keys[keys.length - 1]).toBe('callId');
    // …and every field a reader needs sits ahead of it, in the visible window.
    const visible = rendered(row.meta).slice(0, META_CHARS);
    for (const key of ['"unit":"attempt"', '"abort":"caller_timeout"', '"ok":false', '"ms"', '"proc"', '"target"']) {
      expect(visible).toContain(key);
    }
  });

  test('the id we SENT wins over a gateway echo, and a divergence is recorded (N6)', async () => {
    // A rewritten id is not a key we can prove we sent, so it must not silently
    // replace ours — the field's entire value is that it is verifiable. First:
    // the normal case, an echo of our own id (the proxy's documented behaviour).
    useGatewayEmbeddingsSeat();
    mockedAxios.post.mockImplementation(async (_url: string, _body: any, cfg: any) => {
      const sent = cfg?.headers?.['x-litellm-call-id'];
      return {
        data: { data: [{ index: 0, embedding: VEC }] },
        headers: { ...successHeaders(AGX_BASE, 'deploy-agx'), 'x-litellm-call-id': sent },
      };
    });

    await rag.embedTexts(['hello']);
    await new Promise(r => setTimeout(r, 0));

    let [row] = attemptRows('rag_embed_call');
    expect(row.meta.callId).toMatch(/^[0-9a-f-]{36}$/);
    // An echo of the same id is not a divergence — nothing extra is written.
    expect(row.meta.callIdEcho).toBeUndefined();

    // Second: a proxy that REWRITES the id. Ours stays authoritative.
    mockedMetric.mockClear();
    mockedAxios.post.mockImplementation(async () => ({
      data: { data: [{ index: 0, embedding: VEC }] },
      headers: { ...successHeaders(AGX_BASE, 'deploy-agx'), 'x-litellm-call-id': 'gateway-rewrote-this' },
    }));

    await rag.embedTexts(['hello']);
    await new Promise(r => setTimeout(r, 0));

    [row] = attemptRows('rag_embed_call');
    expect(row.meta.callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.meta.callId).not.toBe('gateway-rewrote-this');
    expect(row.meta.callIdEcho).toBe('gateway-rewrote-this');
  });
});

describe('legFromResponseHeaders — header contract (limb 1, unit-level)', () => {
  test('api_base wins (it is the leg), model-id is the fallback, name the last resort', () => {
    expect(rag.legFromResponseHeaders({
      'x-litellm-model-api-base': AGX_BASE,
      'x-litellm-model-id': 'uuid-1',
    })).toMatchObject({ leg: 'agx-a.stanne.local:8001' });

    // An error response carries only the model id. 48 chars kept (B5): the id is
    // operator-chosen, not a uuid, so a short prefix merges two real legs.
    expect(rag.legFromResponseHeaders({ 'x-litellm-model-id': 'uuid-1234567890ab' }))
      .toMatchObject({ leg: 'id:uuid-1234567890ab' });

    expect(rag.legFromResponseHeaders({ 'x-litellm-model-name': 'Qwen3-Embedding-8B' }))
      .toMatchObject({ leg: 'n:Qwen3-Embedding-8B' });
  });

  test('two deployments with a shared 12-char id prefix stay DISTINCT (review B5)', () => {
    // The regression the review caught: `id:` truncated to 12 chars turned the
    // provider_error path — where model-id is the only header a failure gets —
    // into two different deployments reporting the same leg.
    const agx = rag.legFromResponseHeaders({ 'x-litellm-model-id': 'Qwen3-Embedding-8B-agx' }).leg;
    const spark = rag.legFromResponseHeaders({ 'x-litellm-model-id': 'Qwen3-Embedding-8B-spark' }).leg;
    expect(agx).not.toBe(spark);
  });

  test('header lookup is case-insensitive and tolerant of no headers at all', () => {
    expect(rag.legFromResponseHeaders({ 'X-LiteLLM-Model-Api-Base': AGX_BASE }))
      .toMatchObject({ leg: 'agx-a.stanne.local:8001' });
    expect(rag.legFromResponseHeaders(undefined)).toEqual({});
    expect(rag.legFromResponseHeaders({ 'x-litellm-model-api-base': '   ' })).toEqual({});
  });

  test('a non-URL api_base is reported verbatim rather than silently dropped', () => {
    // A proxy may put something other than a URL there. Dropping it would make
    // an unparseable leg read as "no leg" — a lie about the data.
    expect(rag.legFromResponseHeaders({ 'x-litellm-model-api-base': 'agx-internal' }))
      .toMatchObject({ leg: 'agx-internal' });
  });

  test('the call id is kept (it is the join key), and the api_base query string is not', () => {
    const out = rag.legFromResponseHeaders({
      'x-litellm-model-api-base': 'https://agx-a:8001/v1?api-version=2',
      'x-litellm-call-id': 'call-abc-123',
    });
    expect(out).toEqual({ leg: 'agx-a:8001', callId: 'call-abc-123' });
  });
});