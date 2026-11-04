/**
 * THE 24 h UNATTRIBUTED-EMBED-FAILURES PROBE (goal 4e432dff) — PINNING TEST.
 *
 * The KPI is `kpi:embed_unattributed_failures_24h`, bar 0 (`at_most`). A KPI
 * whose numerator can be made zero by a build that cannot emit the dimension is
 * WORSE than no KPI, so these tests pin the property that makes the number mean
 * something: a row written BEFORE the attribution build must read as
 * UNATTRIBUTED, loudly, rather than vanish from the population.
 *
 * The 2026-11-02 evidence this encodes: 88 leg-less failed attempts on
 * box-c@5d6c8954, unrecoverable at read time; the only contemporaneous bound
 * was the gateway's 4 713/4 713 × 200. A probe that silently ignored those rows
 * would have reported "0 unattributed" and closed the directive on a lie.
 *
 * The population rules here are load-bearing and each has its own case:
 *   - attempt rows only (a call ROLL-UP is not a failure of its own),
 *   - `unified_memory_embed_failed` rows count WITHOUT an ok flag (their
 *     existence IS the failure — an ok-based filter would silently skip the
 *     store path entirely),
 *   - the repair cron's tick row is attributed but never in the numerator
 *     (a healthy backfill must not be able to hold the bar red).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));

const mockQueryRaw: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { $queryRaw: (...a: any[]) => mockQueryRaw(...a) },
}));

import { normalizeEmbedAttribution, queryEmbedAttribution } from './loop-metrics.service';

beforeEach(() => { mockQueryRaw.mockReset(); });

describe('the probe counts a PRE-attribution failure row as unattributed', () => {
  test('a row with no bucket and no leg is unattributed — the 2026-11-02 shape', () => {
    // Exactly what box-c@5d6c8954 wrote: errorKind/status/leg-absent.
    const report = normalizeEmbedAttribution([
      { surface: 'rag_embed_call', meta: { proc: 'box-c@5d6c8954', target: 'dashscope:Qwen', errorKind: 'timeout', ok: false, unit: 'attempt' } },
    ], 24);
    expect(report.unattributed).toBe(1);
    expect(report.totalFailures).toBe(1);
    expect(report.buckets['(absent)']).toBe(1);
  });

  test('a 2-arg row predating even `abort` is still counted, not dropped', () => {
    const report = normalizeEmbedAttribution([
      { surface: 'rag_embed_call', meta: { leg: 'id:deploy', ok: false } }, // leg but no bucket
      { surface: 'rag_embed_call', meta: JSON.stringify({ ok: false }) }, // legacy string meta
    ], 24);
    expect(report.unattributed).toBe(2);
  });

  test('the forward build reads 0 — bucket + leg attributes a failure', () => {
    const report = normalizeEmbedAttribution([
      { surface: 'rag_embed_call', meta: { bucket: 'query', leg: 'agx-a:8001', abort: 'provider_error', ok: false } },
    ], 24);
    expect(report.unattributed).toBe(0);
    expect(report.totalFailures).toBe(1);
  });

  test('a caller_timeout with no leg is ATTRIBUTED (bucket + typed side)', () => {
    const report = normalizeEmbedAttribution([
      { surface: 'rag_embed_call', meta: { bucket: 'query', abort: 'caller_timeout', ok: false } },
    ], 24);
    expect(report.unattributed).toBe(0);
  });

  test('the `unknown` bucket sentinel is NOT an attribution', () => {
    const report = normalizeEmbedAttribution([
      { surface: 'rag_embed_call', meta: { bucket: 'unknown', leg: 'id:x', abort: 'provider_error', ok: false } },
    ], 24);
    expect(report.unattributed).toBe(1);
  });
});

describe('the population is the failure population, per surface', () => {
  test('the store-path failure row counts WITHOUT an ok flag', () => {
    // unified_memory_embed_failed carries no `ok` at all — an ok-based filter
    // would read this population as empty and the store path would go unseen.
    const report = normalizeEmbedAttribution([
      { surface: 'unified_memory_embed_failed', meta: { bucket: 'store', abort: 'provider_error', rows: 7 } },
    ], 24);
    expect(report.totalFailures).toBe(1);
    expect(report.unattributed).toBe(1); // no leg on a provider_error ⇒ unattributed
    expect(report.surfaces[0].surface).toBe('unified_memory_embed_failed');
  });

  test('a healthy repair tick is attributed but never in the numerator', () => {
    const report = normalizeEmbedAttribution([
      { surface: 'memory_embed_backfill', meta: { bucket: 'backfill', abort: 'caller_timeout', embedded: 50, failed: 0 } },
    ], 24);
    expect(report.totalFailures).toBe(0);
    expect(report.unattributed).toBe(0);
    // still visible per-surface, so the repair flow's own leg is readable
    expect(report.surfaces[0]).toMatchObject({ surface: 'memory_embed_backfill', total: 1 });
  });
});

describe('the live read asks the database the right question', () => {
  test('it selects only embed kinds, excludes roll-ups, and never pools successes', async () => {
    mockQueryRaw.mockResolvedValue([
      { kind: 'rag_embed_call', meta: { bucket: 'store', leg: 'id:deploy', abort: 'provider_error', ok: 'false' } },
      { kind: 'unified_memory_embed_failed', meta: { bucket: 'store', abort: 'caller_timeout' } },
      { kind: 'memory_embed_backfill', meta: { bucket: 'backfill', abort: 'caller_timeout' } },
    ]);
    const report = await queryEmbedAttribution({ hours: 24 });
    expect(report.hours).toBe(24);
    expect(report.totalFailures).toBe(2);
    expect(report.unattributed).toBe(0);
    expect(report.surfaces.map(s => s.surface).sort()).toEqual(
      ['memory_embed_backfill', 'rag_embed_call', 'unified_memory_embed_failed'],
    );
    // The leg histogram localizes an upstream; the bucket histogram catches
    // closed-enum drift.
    expect(report.legs['id:deploy']).toBe(1);
    expect(report.buckets.store).toBe(2);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  test('an empty window is an honest zero, not an error', async () => {
    mockQueryRaw.mockResolvedValue([]);
    const report = await queryEmbedAttribution({ hours: 6 });
    expect(report.unattributed).toBe(0);
    expect(report.totalFailures).toBe(0);
    expect(report.hours).toBe(6);
  });
});