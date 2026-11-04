/**
 * delta-coalescer unit tests (0c158104, link 3): the coalescer collapses
 * per-provider-chunk text/reasoning deltas into ~200ms frames BEFORE they hit
 * agent_events (a 30k-token run used to persist ~30k rows). The guarantees
 * that matter: batching, per-kind separation, synchronous flush ordering
 * (flush-before-any-non-delta-event at the call site), and no timer leaks.
 */

import { createDeltaCoalescer, DELTA_COALESCE_MS } from './delta-coalescer';

describe('delta-coalescer (0c158104)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('batches same-kind deltas within the window into ONE emission', () => {
    const seen: Array<[string, string]> = [];
    const c = createDeltaCoalescer((kind, delta) => seen.push([kind, delta]));
    c.push('text', 'a');
    c.push('text', 'b');
    c.push('text', 'c');
    jest.advanceTimersByTime(DELTA_COALESCE_MS - 1);
    expect(seen).toEqual([]); // nothing escapes before the window
    jest.advanceTimersByTime(1);
    expect(seen).toEqual([['text', 'abc']]); // concatenation is lossless
  });

  it('ARRIVAL ORDER is preserved: a kind switch flushes the pending buffer (2026-08-28 — the old two-buffer design emitted text-then-reasoning regardless of arrival, stitching interleaved-thinking transcripts wrong: "…Ver"|thought|"ifier…")', () => {
    const seen: Array<[string, string]> = [];
    const c = createDeltaCoalescer((kind, delta) => seen.push([kind, delta]));
    c.push('text', 't1');
    c.push('reasoning', 'r1');
    c.push('text', 't2');
    c.push('reasoning', 'r2');
    jest.advanceTimersByTime(DELTA_COALESCE_MS);
    expect(seen).toEqual([['text', 't1'], ['reasoning', 'r1'], ['text', 't2'], ['reasoning', 'r2']]);
  });

  it('same-kind runs still coalesce into one frame within the window', () => {
    const seen: Array<[string, string]> = [];
    const c = createDeltaCoalescer((kind, delta) => seen.push([kind, delta]));
    c.push('text', 'a');
    c.push('text', 'b');
    c.push('text', 'c');
    jest.advanceTimersByTime(DELTA_COALESCE_MS);
    expect(seen).toEqual([['text', 'abc']]);
  });

  it('flush() emits synchronously and disarms the timer (the non-delta ordering guarantee)', () => {
    const seen: Array<[string, string]> = [];
    const c = createDeltaCoalescer((kind, delta) => seen.push([kind, delta]));
    c.push('text', 'x');
    c.flush(); // the call site does this before every non-delta event
    expect(seen).toEqual([['text', 'x']]);
    jest.advanceTimersByTime(10_000); // no late re-emit, no empty emission
    expect(seen).toEqual([['text', 'x']]);
  });

  it('a flush with nothing buffered emits nothing', () => {
    const seen: Array<[string, string]> = [];
    const c = createDeltaCoalescer((kind, delta) => seen.push([kind, delta]));
    c.flush();
    jest.advanceTimersByTime(10_000);
    expect(seen).toEqual([]);
  });

  it('ignores empty deltas; the first REAL delta arms the window', () => {
    const seen: Array<[string, string]> = [];
    const c = createDeltaCoalescer((kind, delta) => seen.push([kind, delta]));
    c.push('text', '');
    jest.advanceTimersByTime(10_000);
    expect(seen).toEqual([]);
    c.push('text', 'y');
    jest.advanceTimersByTime(DELTA_COALESCE_MS);
    expect(seen).toEqual([['text', 'y']]);
  });

  it('consecutive windows emit separately (streaming continues all run)', () => {
    const seen: Array<[string, string]> = [];
    const c = createDeltaCoalescer((kind, delta) => seen.push([kind, delta]));
    c.push('text', 'w1');
    jest.advanceTimersByTime(DELTA_COALESCE_MS);
    c.push('text', 'w2');
    jest.advanceTimersByTime(DELTA_COALESCE_MS);
    expect(seen).toEqual([['text', 'w1'], ['text', 'w2']]);
  });

  it('the default window is the documented 200ms (below streaming perception)', () => {
    expect(DELTA_COALESCE_MS).toBe(200);
  });
});
