/**
 * createPoller tests (UI overhaul P5) — the engine behind usePolling. The
 * three correctness guarantees under test:
 *   1. out-of-order protection: a slow response from tick N resolving AFTER
 *      tick N+1 can never reach onData (the pre-P5 setInterval bug class);
 *   2. abort: the in-flight tick's signal is aborted on each new tick and on
 *      stop() (what the hook calls on unmount/disable);
 *   3. abort rejections are never surfaced as errors.
 * Node environment + fake timers (the hook itself is a thin React shell —
 * use-resizable.ts convention: the pure engine carries the tests).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPoller, isAbortError } from './use-polling';

/** Drain the microtask queue so settled promises reach their handlers. */
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('isAbortError', () => {
  it('recognizes DOM AbortError, axios CanceledError, and ERR_CANCELED', () => {
    expect(isAbortError(new DOMException('gone', 'AbortError'))).toBe(true);
    expect(isAbortError({ name: 'CanceledError', message: 'canceled' })).toBe(true);
    expect(isAbortError({ code: 'ERR_CANCELED' })).toBe(true);
  });

  it('rejects real failures and non-objects', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError({ name: 'TypeError' })).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('createPoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs a leading tick on start and then on every interval', async () => {
    const fetcher = vi.fn().mockResolvedValue('ok');
    const onData = vi.fn();
    const p = createPoller({ fetcher, onData, intervalMs: 1000 });
    p.start();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await flush(); // let each tick's resolution land before the next fires
    vi.advanceTimersByTime(1000);
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(onData).toHaveBeenCalledTimes(4);
    p.stop();
  });

  it('start(false) skips the leading tick', () => {
    const fetcher = vi.fn().mockResolvedValue('ok');
    const p = createPoller({ fetcher, intervalMs: 1000 });
    p.start(false);
    expect(fetcher).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('OUT-OF-ORDER: a slow tick-1 response resolving after tick 2 never overwrites', async () => {
    const resolvers: Array<(v: string) => void> = [];
    const seen: string[] = [];
    const p = createPoller<string>({
      fetcher: () => new Promise<string>((res) => resolvers.push(res)),
      onData: (d) => seen.push(d),
      intervalMs: 1000,
    });
    p.start(); // tick 1 in flight
    vi.advanceTimersByTime(1000); // tick 2 fires; tick 1 now stale
    resolvers[1]('tick2'); // newer response lands first
    await flush();
    resolvers[0]('tick1'); // stale response arrives late
    await flush();
    expect(seen).toEqual(['tick2']); // tick1 discarded — newest state stands
    p.stop();
  });

  it('ABORT: each new tick aborts the previous in-flight signal', () => {
    const signals: AbortSignal[] = [];
    const p = createPoller({
      fetcher: (signal) => {
        signals.push(signal);
        return new Promise(() => {}); // never resolves
      },
      intervalMs: 1000,
    });
    p.start();
    vi.advanceTimersByTime(1000);
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true); // superseded call cancelled
    expect(signals[1].aborted).toBe(false); // current call live
    p.stop();
    expect(signals[1].aborted).toBe(true); // stop (unmount) aborts too
  });

  it('UNMOUNT (stop): aborts in-flight, stops ticking, discards late resolutions', async () => {
    let resolver: ((v: string) => void) | null = null;
    let signal: AbortSignal | null = null;
    const onData = vi.fn();
    const fetcher = vi.fn((s: AbortSignal) => {
      signal = s;
      return new Promise<string>((res) => {
        resolver = res;
      });
    });
    const p = createPoller<string>({ fetcher, onData, intervalMs: 1000 });
    p.start();
    p.stop();
    expect(signal!.aborted).toBe(true);
    resolver!('too late');
    await flush();
    expect(onData).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(fetcher).toHaveBeenCalledTimes(1); // interval disarmed
  });

  it('setIntervalMs re-arms in place — no immediate tick, new cadence honored', () => {
    const fetcher = vi.fn().mockResolvedValue('ok');
    const p = createPoller({ fetcher, intervalMs: 1000 });
    p.start(false);
    vi.advanceTimersByTime(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    p.setIntervalMs(5000); // cadence change must NOT fire a tick (feedback-loop fix)
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('setIntervalMs before start does not arm a timer', () => {
    const fetcher = vi.fn().mockResolvedValue('ok');
    const p = createPoller({ fetcher, intervalMs: 1000 });
    p.setIntervalMs(50);
    vi.advanceTimersByTime(1000);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('isPaused skips scheduled ticks; manual tick() runs regardless; ticking resumes', () => {
    let paused = true;
    const fetcher = vi.fn().mockResolvedValue('ok');
    const p = createPoller({ fetcher, intervalMs: 1000, isPaused: () => paused });
    p.start(); // leading tick skipped — hidden
    vi.advanceTimersByTime(2000);
    expect(fetcher).not.toHaveBeenCalled();
    p.tick(); // manual refresh / foreground catch-up ignores the pause
    expect(fetcher).toHaveBeenCalledTimes(1);
    paused = false;
    vi.advanceTimersByTime(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('real rejections reach onError; abort rejections and stale errors do not', async () => {
    const onError = vi.fn();
    let reject: ((e: unknown) => void) | null = null;
    const p = createPoller({
      fetcher: () => new Promise((_res, rej) => {
        reject = rej;
      }),
      onError,
      intervalMs: 1000,
    });
    p.start();
    const failCurrent = reject!;
    failCurrent(new Error('network down'));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000); // tick 2 in flight
    const rejectTick2 = reject!;
    rejectTick2(new DOMException('gone', 'AbortError')); // abort-shaped — never an error
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000); // tick 3 supersedes tick 2... and 1000ms later tick 4 supersedes 3
    const rejectTick3 = reject!;
    vi.advanceTimersByTime(1000);
    rejectTick3(new Error('stale failure')); // tick 3 is superseded — its error is stale
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    p.stop();
  });

  it('a synchronously-throwing fetcher reports the error and keeps polling', () => {
    const onError = vi.fn();
    let calls = 0;
    const p = createPoller({
      fetcher: () => {
        calls++;
        throw new Error('sync boom');
      },
      onError,
      intervalMs: 1000,
    });
    p.start();
    vi.advanceTimersByTime(2000);
    expect(calls).toBe(3);
    expect(onError).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it('restart after stop works (the hook re-enables / key changes)', async () => {
    const fetcher = vi.fn().mockResolvedValue('ok');
    const onData = vi.fn();
    const p = createPoller({ fetcher, onData, intervalMs: 1000 });
    p.start();
    p.stop(); // first lead's resolution is now stale — discarded
    p.start();
    await flush(); // second lead lands
    vi.advanceTimersByTime(1000);
    await flush(); // interval tick lands
    expect(fetcher).toHaveBeenCalledTimes(3); // lead + lead + 1 interval
    expect(onData).toHaveBeenCalledTimes(2); // first lead was aborted by stop
    p.stop();
  });
});
