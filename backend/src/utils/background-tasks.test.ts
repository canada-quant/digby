/**
 * audit 2026-10-08 W3-1 — the background-task registry a draining worker
 * awaits before it disconnects (utils/background-tasks.ts).
 */
import {
  trackBackground, awaitBackgroundTasks, pendingBackgroundCount, pendingBackgroundLabels, __resetBackgroundTasksForTest,
} from './background-tasks';

describe('background-tasks registry (audit 2026-10-08 W3-1)', () => {
  beforeEach(() => __resetBackgroundTasksForTest());
  afterEach(() => jest.useRealTimers());

  it('returns the SAME promise and forgets it once it settles', async () => {
    let release!: () => void;
    const p = new Promise<number>((r) => { release = () => r(7); });
    expect(trackBackground(p, 'x')).toBe(p);
    expect(pendingBackgroundCount()).toBe(1);
    expect(pendingBackgroundLabels()).toEqual(['x']);
    release();
    await p;
    await Promise.resolve();
    expect(pendingBackgroundCount()).toBe(0);
  });

  it('a rejected task is observed, never re-thrown by the registry', async () => {
    const p = Promise.reject(new Error('boom'));
    trackBackground(p, 'rej').catch(() => {}); // the caller keeps its own catch
    const r = await awaitBackgroundTasks(1_000);
    expect(r).toMatchObject({ initial: 1, remaining: 0, timedOut: false });
  });

  it('awaits tasks registered BY tasks (a hook emit that starts an escalation)', async () => {
    const order: string[] = [];
    trackBackground(Promise.resolve().then(() => {
      order.push('outer');
      trackBackground(new Promise<void>((r) => setImmediate(r)).then(() => { order.push('inner'); }), 'inner');
    }), 'outer');
    const r = await awaitBackgroundTasks(1_000);
    expect(order).toEqual(['outer', 'inner']);
    expect(r.remaining).toBe(0);
  });

  it('is bounded: a never-settling task times out at maxMs (fake timers)', async () => {
    jest.useFakeTimers();
    trackBackground(new Promise(() => { /* never */ }), 'stuck');
    const waiting = awaitBackgroundTasks(5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    const r = await waiting;
    expect(r).toMatchObject({ initial: 1, remaining: 1, timedOut: true, remainingLabels: ['stuck'] });
  });

  it('nothing tracked ⇒ resolves at once', async () => {
    const r = await awaitBackgroundTasks(10);
    expect(r).toMatchObject({ initial: 0, remaining: 0, timedOut: false });
  });

  it('a non-promise is returned untouched and not tracked', () => {
    expect(trackBackground(undefined as any)).toBeUndefined();
    expect(pendingBackgroundCount()).toBe(0);
  });
});
