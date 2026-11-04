/**
 * The ATTRIBUTION READ's own math (ticket b5f4d5e2, adversarial review 2026-11-02
 * finding N2): the deliverable query, its normalizer and the population it
 * selects. The reviewer's point stands — the acceptance read was the only new
 * code path with no test of its own logic, and a fleet test asserting against
 * already-rounded mock literals cannot catch a bad round, a null, or a mis-sort.
 *
 * B1 is the finding these tests exist to hold shut: one embed CALL writes TWO
 * rows — an attempt row (`meta.unit:'attempt'`, the only rows carrying
 * leg/abort) and a call roll-up (`meta.batchCount`, `value` = the whole call).
 * Pooling them double-counts every attempt, feeds ~41 s whole-call durations
 * into attempt percentiles, and dumps roll-ups into the (leg:null, abort:null)
 * bucket — i.e. a failure with no typed reason sits in the very group this
 * ticket exists to eliminate.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

const mockQueryRaw: jest.Mock = jest.fn(async () => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { $queryRaw: (...a: any[]) => mockQueryRaw(...a) },
}));

import { normalizeLoopMetricLegs, queryLoopMetricLegs } from './loop-metrics.service';

/** The query is a tagged template; join the literal parts so the SQL text can
 *  be asserted on. Interpolations (${since}, ${kind}) are parameters, not text. */
const sqlText = (): string => {
  const call = mockQueryRaw.mock.calls[mockQueryRaw.mock.calls.length - 1];
  const strings = call[0] as unknown as string[];
  return Array.isArray(strings) ? strings.join('?') : String(strings);
};
/** `$queryRaw` is a TAGGED TEMPLATE: the mock receives (stringsArray, ...values).
 *  The interpolations are what pg binds, and they are what must carry no SQL. */
const sqlBindings = (): unknown[] => {
  const call = mockQueryRaw.mock.calls[mockQueryRaw.mock.calls.length - 1];
  return (call as unknown[]).slice(1);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryRaw.mockResolvedValue([]);
});

describe('the population the attribution read selects (review B1)', () => {
  test('call-roll-up rows are EXCLUDED, so attempts are not double-counted', async () => {
    await queryLoopMetricLegs('rag_embed_call', { hours: 6 });
    // rollUp() is the only producer of meta.batchCount; attempt rows never carry it.
    expect(sqlText()).toContain(`"meta"->>'batchCount' IS NULL`);
  });

  test('the exclusion is NOT a positive unit filter — that would drop rerank entirely', async () => {
    // The rerank lane writes one row per rung with NO `unit` at all (there is no
    // call-level roll-up to distinguish it from), so `unit = 'attempt'` would
    // return an empty answer for the very lane the ticket names.
    for (const kind of ['rag_rerank_call', 'rag_embed_call']) {
      mockQueryRaw.mockClear();
      await queryLoopMetricLegs(kind, { hours: 6 });
      expect(sqlText()).not.toMatch(/"meta"->>'unit'\s*=\s*'attempt'/);
    }
  });

  test('rows with no ok/success flag are counted as `unlabeled`, never dropped (N4)', async () => {
    await queryLoopMetricLegs('rag_embed_call', { hours: 6 });
    // total = ok + fail + unlabeled must hold, or a caller subtracting the two
    // visible buckets gets a silent negative remainder.
    expect(sqlText()).toContain('AS unlabeled');
    expect(sqlText()).toMatch(/NOT IN \('true', '1', 'false', '0'\)/);
  });

  test('the window and kind are bound parameters, and the kind is never interpolated', async () => {
    await queryLoopMetricLegs('rag_embed_call', { hours: 6 });
    const bindings = sqlBindings();
    expect(bindings.some((b) => b instanceof Date)).toBe(true);
    // A kind that reached the SQL as text would be an injection seam.
    expect(typeof bindings[0] === 'string' || bindings.some((b) => b === 'rag_embed_call')).toBe(true);
    expect(sqlText()).not.toContain('rag_embed_call');
  });
});

describe('normalizeLoopMetricLegs — the read’s math, tested without a DB (N2)', () => {
  test('failures sort first, then volume — the supervisor reads the top', () => {
    const out = normalizeLoopMetricLegs([
      { leg: 'agx-a:8001', abort: null, total: 691, ok: 691, fail: 0, unlabeled: 0, p50ms: 990, p95ms: 1400 },
      { leg: 'spark-a367:8001', abort: 'caller_timeout', total: 70, ok: 0, fail: 70, unlabeled: 0, p50ms: 8001, p95ms: 8003 },
      { leg: 'other:9000', abort: 'provider_error', total: 3, ok: 0, fail: 3, unlabeled: 0, p50ms: 12, p95ms: 30 },
    ]);
    expect(out.map((r) => r.leg)).toEqual(['spark-a367:8001', 'other:9000', 'agx-a:8001']);
  });

  test('equal failures fall back to volume, then to leg name (a stable order)', () => {
    const out = normalizeLoopMetricLegs([
      { leg: 'b', abort: null, total: 5, ok: 4, fail: 1, unlabeled: 0, p50ms: 1, p95ms: 1 },
      { leg: 'a', abort: null, total: 5, ok: 4, fail: 1, unlabeled: 0, p50ms: 1, p95ms: 1 },
      { leg: 'c', abort: null, total: 9, ok: 8, fail: 1, unlabeled: 0, p50ms: 1, p95ms: 1 },
    ]);
    expect(out.map((r) => r.leg)).toEqual(['c', 'a', 'b']);
  });

  test('pg returns percentiles as Decimal STRINGS and counts as BigInt — both coerce', () => {
    const out = normalizeLoopMetricLegs([
      { leg: 'agx', abort: null, total: BigInt(7), ok: BigInt(6), fail: BigInt(1), unlabeled: BigInt(0), p50ms: '1200.4', p95ms: '9100.6' },
    ]);
    expect(out[0]).toMatchObject({ total: 7, ok: 6, fail: 1, p50Ms: 1200, p95Ms: 9101 });
  });

  test('a sample-less duration stays NULL, never 0 — 0 ms reads as "instant" (N5)', () => {
    // num(null) → 0 would report a group with no durations as instantaneous,
    // which is the one wrong answer a latency must not give.
    const out = normalizeLoopMetricLegs([
      { leg: 'agx', abort: null, total: 2, ok: 2, fail: 0, unlabeled: 0, p50ms: null, p95ms: null },
    ]);
    expect(out[0].p50Ms).toBeNull();
    expect(out[0].p95Ms).toBeNull();
  });

  test('empty strings normalize to null rather than a blank leg group', () => {
    const out = normalizeLoopMetricLegs([
      { leg: '', abort: '', total: 1, ok: 1, fail: 0, unlabeled: 0, p50ms: 10, p95ms: 10 },
    ]);
    expect(out[0].leg).toBeNull();
    expect(out[0].abort).toBeNull();
  });

  test('a zero-total group is dropped, and a missing key never throws', () => {
    expect(normalizeLoopMetricLegs([{ leg: 'x', abort: null, total: 0, ok: 0, fail: 0, unlabeled: 0, p50ms: null, p95ms: null }])).toEqual([]);
    expect(normalizeLoopMetricLegs([] as any)).toEqual([]);
    expect(normalizeLoopMetricLegs(undefined as any)).toEqual([]);
  });
});

describe('an empty read is not a silent success (review B3)', () => {
  test('zero rows resolves to [] — the caller (not the query) owns the disclosure', async () => {
    mockQueryRaw.mockResolvedValue([]);
    await expect(queryLoopMetricLegs('rag_embed_call', { hours: 6 })).resolves.toEqual([]);
  });

  test('a THROW propagates so the view can disclose "blind", not "no legs"', async () => {
    // fleet-telemetry wraps this in .catch(() => null) and its note says the read
    // FAILED — swallowing the error here would make a broken read look like an
    // empty window.
    mockQueryRaw.mockRejectedValue(new Error('db down'));
    await expect(queryLoopMetricLegs('rag_embed_call', { hours: 6 })).rejects.toThrow('db down');
  });
});