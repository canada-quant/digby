/**
 * Decision gate — the ONE softmax the logprob readout (decision-gate.ts) and
 * the temperature fit (decision-gate-fit.ts + backend/scripts/
 * decision-gate-fit-temperature.ts) share, so a fitted T means exactly what
 * the runtime does with it. Dependency-free on purpose: the fit script must
 * not boot config/env (logger → env.ts) just to do arithmetic.
 */

/**
 * Softmax of raw per-option logits ÷ temperature over the option keys
 * (absent keys get zero mass). Temperature > 1 flattens, < 1 sharpens —
 * fitted per (backend, purpose) from shadow rows. Throws when no key has a
 * finite logit.
 */
export function distributionFromLogits(
  logits: Record<string, number>,
  keys: string[],
  temperature: number,
): Record<string, number> {
  const T = temperature > 0 ? temperature : 1;
  const scaled = keys.map(k => {
    const lp = logits[k];
    return typeof lp === 'number' && Number.isFinite(lp) ? lp / T : -Infinity;
  });
  const max = Math.max(...scaled);
  if (max === -Infinity) throw new Error('no option logits');
  const exps = scaled.map(l => (l === -Infinity ? 0 : Math.exp(l - max)));
  const sum = exps.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  keys.forEach((k, i) => { out[k] = exps[i] / sum; });
  return out;
}

/**
 * E2 (2026-09-25): the CENSOR FLOOR for option letters absent from a readout's
 * top-k list. An absent letter's true logprob is unknown but bounded above by
 * the lowest logprob the server did return: when the list is FULL (the
 * vendor's top-k cap was reached) that 20th-ranked value is the tightest
 * bound; when the list is shorter the model simply stopped listing, so the
 * bound is looser — one nat under the lowest entry. Before this, absent
 * letters took −∞ (decision-gate.ts readoutLetterLogits omitted them →
 * distributionFromLogits gave zero mass), which is why 707/707 prod readout
 * nouls read EXACTLY 0 or 1 and no temperature could move them, and why
 * the fit skipped every sample whose actual key was absent. A censored value
 * is still a bound, so the readout stays conservative: a censored option can
 * never outrank a listed one at any temperature.
 */
export function readoutCensorFloor(lowestListedLogprob: number, listLength: number, topK: number): number {
  if (!Number.isFinite(lowestListedLogprob)) return -30;
  return listLength >= topK ? lowestListedLogprob : lowestListedLogprob - 1;
}

/** Fill the option keys absent from `logits` with `floor` (a copy; present keys untouched). */
export function censorAbsentLogits(logits: Record<string, number>, keys: string[], floor: number): { logits: Record<string, number>; censored: string[] } {
  const out: Record<string, number> = { ...logits };
  const censored: string[] = [];
  for (const k of keys) {
    if (typeof out[k] !== 'number' || !Number.isFinite(out[k])) { out[k] = floor; censored.push(k); }
  }
  return { logits: out, censored };
}

/**
 * E3b (2026-09-25): coarse buckets for an age-like minute count — 0–5, 5–15,
 * 15–60, 60+ — the memo-stable projection's replacement for whole-minute
 * ages. Lives here (dependency-free) so a leaf request builder such as
 * wake-triage-request.ts can bucket without importing decision-gate.ts
 * (whose module is mocked wholesale in the sweeper's unit suite — a missing
 * export there would have thrown inside the builder and failed the whole
 * triage open).
 */
export function bucketMinutes(min: number): string {
  if (!Number.isFinite(min)) return 'unknown';
  if (min < 5) return '0-5m';
  if (min < 15) return '5-15m';
  if (min < 60) return '15-60m';
  return '60m+';
}

/**
 * Wilson score interval for a binomial proportion k / n at z standard
 * deviations (default 1.96 — the 95% two-sided interval, whose upper end is a
 * one-sided 97.5% bound). Used by the E12 auto-demotion (decision-gate-modes)
 * to ask "is the act-band precision CONFIDENTLY below the bar?" instead of
 * comparing a point estimate — at n ≤ 100 the interval near p = 0.9 is
 * ±0.06–0.11 wide, so a point comparison flips on one label.
 *
 *   centre = (p̂ + z²/2n) / (1 + z²/n)
 *   half   = z · sqrt(p̂(1−p̂)/n + z²/4n²) / (1 + z²/n)
 *   lower / upper = centre ∓ half, clamped to [0, 1]
 *
 * n ≤ 0 (nothing observed) returns the whole interval [0, 1]. Pure.
 */
export function wilsonInterval(k: number, n: number, z = 1.96): { lower: number; upper: number; centre: number; pHat: number } {
  if (!Number.isFinite(n) || n <= 0) return { lower: 0, upper: 1, centre: 0.5, pHat: NaN };
  const kk = Math.min(Math.max(0, k), n);
  const pHat = kk / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (pHat + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half), centre, pHat };
}
