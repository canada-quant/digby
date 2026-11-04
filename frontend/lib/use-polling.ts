'use client';

/**
 * usePolling — THE abortable data-polling hook (UI overhaul P5, "correctness
 * under the hood"). Every polling effect in the app used a bare setInterval
 * with zero AbortControllers: a slow response from tick N could land after
 * tick N+1 and overwrite newer data, unmounts left requests in flight, and
 * any state the tick read had to ride the effect's dependency array — tearing
 * the interval down (and firing an immediate refetch) on every state change
 * (the page.tsx `chats`-dep feedback loop).
 *
 * Guarantees:
 *   - the fetcher runs immediately on mount/enable (opt out: immediate:false)
 *     and then on every interval tick;
 *   - each tick receives an AbortSignal; the previous in-flight call is
 *     ABORTED when a new tick fires, on unmount, and on disable — thread the
 *     signal into the API call so the request is genuinely cancelled;
 *   - stale resolutions can never land: onData/onError are skipped for any
 *     tick that has been superseded or aborted (ticket counter + signal), so
 *     an older response can never overwrite newer state;
 *   - the interval is STABLE: fetcher/onData/onError are read through refs
 *     (always the latest render's closures — poll-read state stays OUT of
 *     dependency arrays), and intervalMs changes re-arm the timer in place
 *     without a teardown or an immediate refetch;
 *   - pauseWhenHidden (default true — the codebase's foreground convention):
 *     scheduled ticks skip while the tab is hidden and a catch-up tick fires
 *     on return to visible. Sites whose legacy interval polled while hidden
 *     pass false to keep their exact behavior.
 *
 * The pure engine (createPoller) is exported for the node-environment vitest
 * (use-resizable.ts convention: pure pieces tested, hook is a thin shell).
 */

import { useCallback, useEffect, useRef } from 'react';
import { isSessionDead } from './session-latch';

/**
 * True for a fetch/axios cancellation — never a real failure. Covers the DOM
 * AbortError, axios's CanceledError ('ERR_CANCELED'), and nothing else: a
 * migrated fetcher that handles its own errors must check this before
 * counting a failure or rendering an error state.
 */
export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.name === 'CanceledError' || e.code === 'ERR_CANCELED';
}

export interface PollerOptions<T> {
  /** The async work of one tick. MUST treat the signal as its cancellation. */
  fetcher: (signal: AbortSignal) => Promise<T> | T;
  /** Receives the resolved value — ONLY for the newest non-aborted tick. */
  onData?: (data: T) => void;
  /** Receives real failures — never aborts, never stale ticks' errors. */
  onError?: (err: unknown) => void;
  intervalMs: number;
  /** Scheduled ticks (start + interval) skip while true; manual tick() ignores it. */
  isPaused?: () => boolean;
}

export interface Poller {
  /** Arm the interval (+ run a leading tick unless immediate=false). Idempotent. */
  start(immediate?: boolean): void;
  /** Disarm the interval and abort/invalidate any in-flight tick. */
  stop(): void;
  /** Change cadence; re-arms IN PLACE — no teardown, no immediate refetch. */
  setIntervalMs(ms: number): void;
  /** Force a tick now (aborts the in-flight one). Ignores isPaused. */
  tick(): void;
}

/** The framework-agnostic polling engine behind usePolling (exported for tests). */
export function createPoller<T>(opts: PollerOptions<T>): Poller {
  let timer: ReturnType<typeof setInterval> | null = null;
  let controller: AbortController | null = null;
  let intervalMs = opts.intervalMs;
  // Monotonic tick id: a resolution (or rejection) whose ticket is no longer
  // current belongs to a superseded tick and is discarded — even if the
  // underlying request could not actually be cancelled.
  let ticket = 0;

  const tick = () => {
    const my = ++ticket;
    controller?.abort();
    const c = new AbortController();
    controller = c;
    let result: Promise<T> | T;
    try {
      result = opts.fetcher(c.signal);
    } catch (err) {
      if (my === ticket && !c.signal.aborted && !isAbortError(err)) opts.onError?.(err);
      return;
    }
    Promise.resolve(result).then(
      (data) => {
        if (my !== ticket || c.signal.aborted) return; // stale — a newer tick owns the state
        opts.onData?.(data);
      },
      (err) => {
        if (my !== ticket || c.signal.aborted || isAbortError(err)) return;
        opts.onError?.(err);
      },
    );
  };

  const scheduledTick = () => {
    if (opts.isPaused?.()) return;
    tick();
  };

  const arm = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(scheduledTick, intervalMs);
  };

  return {
    start(immediate = true) {
      arm();
      if (immediate) scheduledTick();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      ticket++; // anything already resolving is now stale
      controller?.abort();
      controller = null;
    },
    setIntervalMs(ms: number) {
      if (ms === intervalMs) return;
      intervalMs = ms;
      if (timer) arm();
    },
    tick,
  };
}

export interface UsePollingOptions<T> {
  /** Poll cadence (ms). May change between renders — re-arms in place. */
  intervalMs: number;
  /** Master switch (default true). false stops the interval AND aborts in-flight. */
  enabled?: boolean;
  /** Run a leading tick on mount/enable/key-change (default true). */
  immediate?: boolean;
  /**
   * Skip scheduled ticks while the tab is hidden + catch-up tick on return to
   * visible (default true). Pass false to preserve a legacy always-on cadence
   * (pairing/redeem/provisioning polls that must keep running while the user
   * is off in another window).
   */
  pauseWhenHidden?: boolean;
  /** Also run a catch-up tick on window focus (Dashboard/Schedules pattern). */
  refreshOnFocus?: boolean;
  /** Identity the fetcher reads (projectId, sessionId…): a change restarts the poll. */
  key?: unknown;
  /** Resolved data — called ONLY for the newest non-aborted tick. */
  onData?: (data: T) => void;
  /** Real failures only (aborts and superseded ticks never reach it). */
  onError?: (err: unknown) => void;
}

/**
 * Poll `fetcher` on an interval with abort + stale-resolution protection.
 * Returns { refresh } — a stable manual trigger (post-mutation refetch); it
 * aborts the in-flight tick and runs one now, hidden or not.
 */
export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T> | T,
  options: UsePollingOptions<T>,
): { refresh: () => void } {
  const {
    intervalMs,
    enabled = true,
    immediate = true,
    pauseWhenHidden = true,
    refreshOnFocus = false,
    key,
  } = options;

  // Latest-render closures, read through refs so the interval NEVER re-arms
  // because state the tick reads changed (the chats-dep feedback-loop fix).
  const fetcherRef = useRef(fetcher);
  const onDataRef = useRef(options.onData);
  const onErrorRef = useRef(options.onError);
  const pauseRef = useRef(pauseWhenHidden);
  const immediateRef = useRef(immediate);
  useEffect(() => {
    fetcherRef.current = fetcher;
    onDataRef.current = options.onData;
    onErrorRef.current = options.onError;
    pauseRef.current = pauseWhenHidden;
    immediateRef.current = immediate;
  });

  const pollerRef = useRef<Poller | null>(null);
  if (!pollerRef.current) {
    pollerRef.current = createPoller<T>({
      fetcher: (signal) => fetcherRef.current(signal),
      onData: (d) => onDataRef.current?.(d),
      onError: (e) => onErrorRef.current?.(e),
      intervalMs,
      // Loop #19: a DEAD session (refresh refused) pauses every scheduled tick —
      // manual tick()/refresh() still run so a user action can revive it.
      isPaused: () =>
        isSessionDead() || (pauseRef.current && typeof document !== 'undefined' && document.visibilityState === 'hidden'),
    });
  }
  const poller = pollerRef.current;

  // Cadence changes re-arm the timer in place — no teardown, no leading refetch.
  useEffect(() => {
    poller.setIntervalMs(intervalMs);
  }, [poller, intervalMs]);

  // Lifecycle: mount/enable/key-change arms (+ leading tick); cleanup aborts.
  useEffect(() => {
    if (!enabled) return;
    poller.start(immediateRef.current);
    return () => poller.stop();
  }, [poller, enabled, key]);

  // Foreground catch-up (visibility and/or focus), matching the site's legacy listeners.
  useEffect(() => {
    if (!enabled || (!pauseWhenHidden && !refreshOnFocus)) return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') poller.tick();
    };
    const onFocus = () => poller.tick();
    if (pauseWhenHidden) document.addEventListener('visibilitychange', onVisibility);
    if (refreshOnFocus) window.addEventListener('focus', onFocus);
    return () => {
      if (pauseWhenHidden) document.removeEventListener('visibilitychange', onVisibility);
      if (refreshOnFocus) window.removeEventListener('focus', onFocus);
    };
  }, [poller, enabled, pauseWhenHidden, refreshOnFocus]);

  const refresh = useCallback(() => poller.tick(), [poller]);
  return { refresh };
}
