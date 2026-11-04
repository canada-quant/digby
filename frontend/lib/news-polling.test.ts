/**
 * Tests for lib/news-polling.ts — the honest-degraded state machine behind the
 * home news card (ticket d86cf931).
 *
 * The 2026-08-29 outage failure mode these tests pin: ~6h of "Your news is
 * being prepared — checking every few seconds" while the backend could not
 * produce news. The card must switch to an honest unavailable state after
 * sustained failure, back off its poll cadence, and restore live polling on
 * the first success — and it must NOT false-degrade during a legitimate
 * (even pathological, ~8min) first-time generation.
 */

import { describe, it, expect } from 'vitest';
import {
  INITIAL_NEWS_POLL_STATE,
  NEWS_ERROR_DEGRADED_THRESHOLD,
  NEWS_POLL_DEGRADED_MS,
  NEWS_POLL_HEALTHY_MS,
  NEWS_PENDING_DEGRADED_THRESHOLD,
  nextNewsPoll,
  type NewsPollOutcome,
  type NewsPollState,
} from './news-polling';

/** Run n consecutive outcomes through the machine, returning the last result. */
function run(outcome: NewsPollOutcome, n: number, start: NewsPollState = INITIAL_NEWS_POLL_STATE) {
  let result = { state: start, delayMs: NEWS_POLL_HEALTHY_MS };
  for (let i = 0; i < n; i++) result = nextNewsPoll(result.state, outcome);
  return result;
}

describe('nextNewsPoll', () => {
  it('healthy pending polls stay live at the 6s cadence', () => {
    const { state, delayMs } = nextNewsPoll(INITIAL_NEWS_POLL_STATE, 'pending');
    expect(state).toEqual({ consecutiveMisses: 1, degraded: false });
    expect(delayMs).toBe(NEWS_POLL_HEALTHY_MS);
  });

  it('a backend degraded response degrades immediately and backs off to 60s', () => {
    const { state, delayMs } = nextNewsPoll(INITIAL_NEWS_POLL_STATE, 'degraded');
    expect(state.degraded).toBe(true);
    expect(state.consecutiveMisses).toBe(1);
    expect(delayMs).toBe(NEWS_POLL_DEGRADED_MS);
  });

  it('consecutive transport errors degrade at the threshold (≈30s of failures)', () => {
    const below = run('error', NEWS_ERROR_DEGRADED_THRESHOLD - 1);
    expect(below.state.degraded).toBe(false);
    expect(below.delayMs).toBe(NEWS_POLL_HEALTHY_MS);

    const at = run('error', NEWS_ERROR_DEGRADED_THRESHOLD, below.state);
    expect(at.state.degraded).toBe(true);
    expect(at.delayMs).toBe(NEWS_POLL_DEGRADED_MS);
  });

  it('a legitimate long first-time generation never false-degrades (pending backstop > 480s fetch lock)', () => {
    // The fetching lock TTL is 480s = 80 polls at 6s; the pathological
    // worst-case fetch fits inside it. The backstop must clear that window.
    expect(NEWS_PENDING_DEGRADED_THRESHOLD * NEWS_POLL_HEALTHY_MS).toBeGreaterThan(480_000);
    const below = run('pending', NEWS_PENDING_DEGRADED_THRESHOLD - 1);
    expect(below.state.degraded).toBe(false);
    const at = run('pending', 1, below.state);
    expect(at.state.degraded).toBe(true);
    expect(at.delayMs).toBe(NEWS_POLL_DEGRADED_MS);
  });

  it('degraded is sticky through bare pendings (backoff-flag flap must not flap the copy)', () => {
    const degraded = run('degraded', 1);
    const flapped = run('pending', 3, degraded.state);
    expect(flapped.state.degraded).toBe(true);
    expect(flapped.delayMs).toBe(NEWS_POLL_DEGRADED_MS);
  });

  it('errors below the threshold do not degrade, but keep counting toward the pending backstop', () => {
    const { state, delayMs } = run('error', 2);
    expect(state).toEqual({ consecutiveMisses: 2, degraded: false });
    expect(delayMs).toBe(NEWS_POLL_HEALTHY_MS);
  });

  it('success resets the machine and restores the healthy cadence', () => {
    const degraded = run('error', NEWS_ERROR_DEGRADED_THRESHOLD + 10);
    expect(degraded.state.degraded).toBe(true);
    const recovered = nextNewsPoll(degraded.state, 'success');
    expect(recovered.state).toEqual(INITIAL_NEWS_POLL_STATE);
    expect(recovered.delayMs).toBe(NEWS_POLL_HEALTHY_MS);
  });

  it('success after a single pending also resets the miss counter', () => {
    const pending = run('pending', 7);
    const recovered = nextNewsPoll(pending.state, 'success');
    expect(recovered.state.consecutiveMisses).toBe(0);
    expect(recovered.state.degraded).toBe(false);
  });

  it('mixed outcomes accumulate misses across kinds', () => {
    let r = nextNewsPoll(INITIAL_NEWS_POLL_STATE, 'pending');
    r = nextNewsPoll(r.state, 'error');
    r = nextNewsPoll(r.state, 'pending');
    expect(r.state.consecutiveMisses).toBe(3);
    expect(r.state.degraded).toBe(false);
  });

  it('the 2026-08-29 scenario: outage polls degrade within a minute instead of lying for 6 hours', () => {
    // Backend alive but failing: first response carries degraded=true once the
    // per-user backoff is set — the card switches on the very first poll.
    const first = nextNewsPoll(INITIAL_NEWS_POLL_STATE, 'degraded');
    expect(first.state.degraded).toBe(true);
    // Backend fully down: 5 consecutive throws ≈ 30s at 6s → honest state.
    const down = run('error', NEWS_ERROR_DEGRADED_THRESHOLD);
    expect(down.state.degraded).toBe(true);
    expect(NEWS_ERROR_DEGRADED_THRESHOLD * NEWS_POLL_HEALTHY_MS).toBeLessThanOrEqual(60_000);
  });
});
