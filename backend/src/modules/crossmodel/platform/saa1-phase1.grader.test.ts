/**
 * SAA-1.1 GATE TOOLING — the batch-deduping suppression grader (todo 347e1fca).
 *
 * These tests pin the two things the grader exists to get right, both of which
 * were wrong when the join was done by hand on 2026-11-02:
 *   1. A BATCH is (hookId, ids) — never a row. Re-admissions of one batch must
 *      collapse; a raw row count inflates the rate by the duplicate factor.
 *   2. An all-unresolved window yields precision NULL — never 1.0, never 0.
 *      Counting "never delivered" as "suppression would have been right" is
 *      how a broken emitter reads as a perfect policy.
 */
import type { ObserveRowLike } from './hook-source-policy-grader';
import {
  batchKeyOf,
  dedupePolicyBatches,
  gradeSuppression,
  gradeSummary,
  reassembleBatches,
} from './hook-source-policy-grader';
import type { SuppressionLaterLabel } from './hook-source-policy';

const at = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();

/** One emitted observe row. Defaults mirror the real emitter's meta shape. */
function row(opts: {
  hookId?: string;
  ids: string[];
  decision?: 'respond' | 'candidate' | 'ignore';
  reason?: string;
  rows?: number;
  sources?: number;
  sessionId?: string | null;
  ms?: number;
}): ObserveRowLike {
  return {
    createdAt: at(opts.ms ?? 0),
    sessionId: opts.sessionId === undefined ? 'chat-1' : opts.sessionId,
    meta: {
      hookId: opts.hookId ?? 'hook-a',
      decision: opts.decision ?? 'respond',
      reason: opts.reason ?? 'failure_or_block',
      rows: opts.rows ?? opts.ids.length,
      sources: opts.sources ?? 1,
      ids: opts.ids,
    },
  };
}

describe('batchKeyOf', () => {
  it('is order-insensitive over ids so a grown batch keeps its identity', () => {
    expect(batchKeyOf('h1', ['b', 'a'])).toBe(batchKeyOf('h1', ['a', 'b']));
  });

  it('separates different hooks carrying the same ids', () => {
    expect(batchKeyOf('h1', ['a'])).not.toBe(batchKeyOf('h2', ['a']));
  });
});

describe('dedupePolicyBatches', () => {
  it('collapses N admissions of ONE batch into one batch, reporting the duplicate factor', () => {
    // The live shape: hook 83b3cd9d, ids ["5c198d8c"], admitted 33 times.
    const rows = Array.from({ length: 33 }, (_, i) =>
      row({ hookId: '83b3cd9d', ids: ['5c198d8c'], decision: 'respond', ms: i * 10_000 }),
    );
    const { batches } = dedupePolicyBatches(rows);
    expect(batches).toHaveLength(1);
    expect(batches[0].admissions).toBe(33);
    expect(batches[0].hookId).toBe('83b3cd9d');
  });

  it('does not let a re-admission with a QUIETER slice downgrade a refused batch', () => {
    // A batch was refused (respond); a later admission saw only its quiet half.
    // Grading the later slice as 'ignore' would manufacture a suppression claim.
    const rows = [
      row({ ids: ['a'], decision: 'respond', ms: 0 }),
      row({ ids: ['a'], decision: 'ignore', reason: 'routine_completion', ms: 1 }),
    ];
    const { batches } = dedupePolicyBatches(rows);
    expect(batches).toHaveLength(1);
    expect(batches[0].decision).toBe('respond');
  });

  it('takes the batch at its fullest size across admissions', () => {
    const rows = [
      row({ ids: ['a', 'b'], rows: 2, ms: 0 }),
      row({ ids: ['a', 'b'], rows: 5, ms: 1 }),
    ];
    expect(dedupePolicyBatches(rows).batches[0].rows).toBe(5);
  });

  it('DROPS an unkeyable row rather than inventing a batch from it', () => {
    const rows = [row({ ids: ['a'] }), { createdAt: at(1), sessionId: 'c', meta: { decision: 'ignore' } }];
    const { batches, dropped } = dedupePolicyBatches(rows);
    expect(batches).toHaveLength(1);
    expect(dropped).toBe(1);
  });

  it('counts distinct batches, not rows — the live 56-row / 7-batch shape', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row({ ids: ['s1'], hookId: 'h1', ms: i })),
      ...Array.from({ length: 20 }, (_, i) => row({ ids: ['s2'], hookId: 'h1', ms: 100 + i })),
      ...Array.from({ length: 16 }, (_, i) => row({ ids: ['s3'], hookId: 'h2', ms: 200 + i })),
    ];
    const { batches } = dedupePolicyBatches(rows);
    expect(rows).toHaveLength(56);
    expect(batches).toHaveLength(3);
  });
});

describe('gradeSuppression — precision', () => {
  const ignoreBatch = (id: string, ms: number) =>
    row({ ids: [id], decision: 'ignore', reason: 'routine_completion', ms });

  it('returns NULL, never 1.0, when every would-suppress batch is unresolved', () => {
    const rows = [ignoreBatch('x', 0), ignoreBatch('y', 1)];
    const g = gradeSuppression(rows, () => null);
    expect(g.wouldSuppress).toBe(2);
    expect(g.unresolved).toBe(2);
    expect(g.wouldHold).toBe(0);
    expect(g.wouldLose).toBe(0);
    expect(g.precision).toBeNull();
    // The string form must not print a number it does not have.
    expect(gradeSummary(g)).toContain('null (nothing resolved)');
  });

  it('returns NULL when the window carries NO would-suppress batch at all', () => {
    const rows = [row({ ids: ['a'], decision: 'respond' })];
    const g = gradeSuppression(rows, () => ({ delivered: true, acted: false }));
    expect(g.wouldSuppress).toBe(0);
    expect(g.precision).toBeNull();
  });

  it('computes wouldHold/(wouldHold+wouldLose) over BASES, excluding unresolved', () => {
    const rows = [ignoreBatch('a', 0), ignoreBatch('b', 1), ignoreBatch('c', 2)];
    const labels: Record<string, SuppressionLaterLabel | null> = {
      a: { delivered: true, acted: false },   // would_hold
      b: { delivered: true, acted: true },    // would_lose
      c: null,                                // unresolved — EXCLUDED
    };
    const g = gradeSuppression(rows, (b) => labels[b.ids[0]]);
    expect(g.wouldHold).toBe(1);
    expect(g.wouldLose).toBe(1);
    expect(g.unresolved).toBe(1);
    expect(g.precision).toBe(0.5);
  });

  it('grades ONLY ignore batches — a respond batch is not a suppression claim', () => {
    const rows = [row({ ids: ['a'], decision: 'respond', ms: 0 }), ignoreBatch('b', 1)];
    const calls: string[] = [];
    const g = gradeSuppression(rows, (b) => { calls.push(b.ids[0]); return { delivered: true, acted: false }; });
    expect(calls).toEqual(['b']);
    expect(g.wouldSuppress).toBe(1);
    expect(g.batches).toBe(2);
  });

  it('reports rows, batches and duplicateFactor separately (the row-count trap)', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ignoreBatch('dup', i));
    const g = gradeSuppression(rows, () => ({ delivered: true, acted: false }));
    expect(g.rows).toBe(10);
    expect(g.batches).toBe(1);
    expect(g.duplicateFactor).toBe(10);
    // One batch, one vote — NOT ten.
    expect(g.wouldHold).toBe(1);
    expect(g.precision).toBe(1);
  });

  it('grades each batch ONCE however many times it was re-admitted', () => {
    const rows = Array.from({ length: 33 }, (_, i) => ignoreBatch('same', i));
    let calls = 0;
    const g = gradeSuppression(rows, () => { calls += 1; return { delivered: true, acted: false }; });
    expect(calls).toBe(1);
    expect(g.wouldHold).toBe(1);
  });

  it('treats a throwing resolver as unresolved, not as a hold', () => {
    const g = gradeSuppression([ignoreBatch('boom', 0)], () => { throw new Error('db down'); });
    expect(g.unresolved).toBe(1);
    expect(g.precision).toBeNull();
  });

  it('treats delivered:false as unresolved (a batch that never ran proves nothing)', () => {
    const g = gradeSuppression([ignoreBatch('a', 0)], () => ({ delivered: false, acted: false }));
    expect(g.unresolved).toBe(1);
    expect(g.precision).toBeNull();
  });
});

describe('reassembleBatches — replay grouping', () => {
  it('groups one hook’s consecutive rows inside the gap into ONE batch', () => {
    const rows = [
      { hookId: 'h1', targetChatId: 'c1', id: 'r1', eventType: 'run_completed', createdAt: new Date(1000) },
      { hookId: 'h1', targetChatId: 'c1', id: 'r2', eventType: 'run_completed', createdAt: new Date(2000) },
    ];
    const batches = reassembleBatches(rows, 60_000);
    expect(batches).toHaveLength(1);
    expect(batches[0].rows).toHaveLength(2);
  });

  it('splits when the gap is exceeded, and never merges across hooks', () => {
    const rows = [
      { hookId: 'h1', targetChatId: 'c1', id: 'r1', createdAt: new Date(0) },
      { hookId: 'h1', targetChatId: 'c1', id: 'r2', createdAt: new Date(120_000) },
      { hookId: 'h2', targetChatId: 'c1', id: 'r3', createdAt: new Date(130_000) },
    ];
    expect(reassembleBatches(rows, 60_000)).toHaveLength(3);
  });

  it('orders by time regardless of input order', () => {
    const rows = [
      { hookId: 'h1', targetChatId: 'c1', id: 'late', createdAt: new Date(50_000) },
      { hookId: 'h1', targetChatId: 'c1', id: 'early', createdAt: new Date(0) },
    ];
    const b = reassembleBatches(rows, 120_000);
    expect(b).toHaveLength(1);
    expect(b[0].rows.map((r) => r.id)).toEqual(['early', 'late']);
  });
});