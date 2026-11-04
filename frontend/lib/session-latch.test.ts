/**
 * Session-dead latch (autonomy loop #19): a refresh the server refused pauses
 * every scheduled poll until the next authenticated success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { markSessionDead, markSessionAlive, isSessionDead, __resetSessionLatchForTest } from './session-latch';
import { createPoller } from './use-polling';

describe('session latch', () => {
  beforeEach(() => __resetSessionLatchForTest());

  it('starts alive; dead after markSessionDead; alive again after markSessionAlive', () => {
    expect(isSessionDead()).toBe(false);
    markSessionDead();
    expect(isSessionDead()).toBe(true);
    markSessionAlive();
    expect(isSessionDead()).toBe(false);
  });

  it('a poller whose isPaused reads the latch skips scheduled ticks while dead and resumes when alive; a manual tick still runs', () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => 'ok');
    const p = createPoller({ fetcher, intervalMs: 1000, isPaused: () => isSessionDead() });
    p.start(false);
    vi.advanceTimersByTime(2000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    markSessionDead();
    vi.advanceTimersByTime(3000);
    expect(fetcher).toHaveBeenCalledTimes(2); // dead: no scheduled ticks
    p.tick();
    expect(fetcher).toHaveBeenCalledTimes(3); // a user action can still revive
    markSessionAlive();
    vi.advanceTimersByTime(1000);
    expect(fetcher).toHaveBeenCalledTimes(4);
    p.stop();
    vi.useRealTimers();
  });
});
