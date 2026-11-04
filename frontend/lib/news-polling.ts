/**
 * News polling state machine — the honest-degraded-state logic for the home
 * news card (ticket d86cf931, split from 26fe2168).
 *
 * 2026-08-29 incident: a ~6h dual-provider utility-LLM outage (~15:00–21:00Z)
 * left the home news card showing "Your news is being prepared — checking
 * every few seconds" for the entire outage — an indefinite-loading lie. This
 * module decides, purely from poll outcomes, when the card must stop claiming
 * "checking every few seconds" and switch to an honest unavailable state, and
 * how fast to keep polling.
 *
 * Outcomes fed in by the caller:
 *   - 'success'  — the API returned ≥1 headline
 *   - 'pending'  — 200, no headlines, no degraded flag (backend still preparing)
 *   - 'degraded' — 200, no headlines, backend reports failure-backoff/breaker
 *   - 'error'    — the fetch itself threw (network / 5xx / backend down)
 *
 * Policy:
 *   - Any 'degraded' response degrades the card immediately (the backend
 *     already knows it recently failed — no reason to keep lying).
 *   - 5 consecutive transport errors (~30s at the healthy interval) degrade —
 *     a throw means something is wrong NOW.
 *   - 90 consecutive pendings (~9 min) degrade as a backstop for a backend too
 *     sick to set its flag. 90 × 6s = 540s > the 480s fetching-lock TTL, so a
 *     legitimate (even pathological ~459s) first-time generation does not trip
 *     it. Marginal exception: a crashed fetch that strands the NX lock for its
 *     full TTL plus a pathological refetch (~939s of legitimate pending) can
 *     false-degrade — the copy stays honest-ish ("temporarily unavailable",
 *     still retrying) and self-corrects on the first success within 60s, so
 *     this is accepted rather than lengthening the lie window for a backend
 *     that cannot report its own degraded flag.
 *   - Degraded is STICKY until a success: backoff flags flap with their 5-min
 *     TTL while an outage persists; un-degrading on a single bare 'pending'
 *     would flap the copy. Only real headlines restore the live state.
 *   - Poll cadence: 6s while healthy, 60s once degraded (10× backoff — the
 *     card still recovers within a minute of the outage ending, without
 *     hammering a sick backend every few seconds forever).
 *
 * Pure and framework-free so vitest can pin every transition.
 */

export const NEWS_POLL_HEALTHY_MS = 6_000;
export const NEWS_POLL_DEGRADED_MS = 60_000;
export const NEWS_ERROR_DEGRADED_THRESHOLD = 5;
export const NEWS_PENDING_DEGRADED_THRESHOLD = 90;

export type NewsPollOutcome = 'success' | 'pending' | 'degraded' | 'error';

export interface NewsPollState {
  /** Consecutive non-success outcomes since the last success. */
  consecutiveMisses: number;
  /** Sticky until success — drives the honest "temporarily unavailable" copy. */
  degraded: boolean;
}

export const INITIAL_NEWS_POLL_STATE: NewsPollState = {
  consecutiveMisses: 0,
  degraded: false,
};

/**
 * Advance the state machine by one poll outcome. Returns the next state and
 * the delay before the following poll. A 'success' outcome resets everything
 * (caller typically stops the poll chain entirely on success — the 60-min
 * auto-refresh interval handles later refetches).
 */
export function nextNewsPoll(
  state: NewsPollState,
  outcome: NewsPollOutcome,
): { state: NewsPollState; delayMs: number } {
  if (outcome === 'success') {
    return { state: { ...INITIAL_NEWS_POLL_STATE }, delayMs: NEWS_POLL_HEALTHY_MS };
  }
  const consecutiveMisses = state.consecutiveMisses + 1;
  const degraded =
    state.degraded || // sticky until success
    outcome === 'degraded' ||
    (outcome === 'error' && consecutiveMisses >= NEWS_ERROR_DEGRADED_THRESHOLD) ||
    consecutiveMisses >= NEWS_PENDING_DEGRADED_THRESHOLD;
  return {
    state: { consecutiveMisses, degraded },
    delayMs: degraded ? NEWS_POLL_DEGRADED_MS : NEWS_POLL_HEALTHY_MS,
  };
}
