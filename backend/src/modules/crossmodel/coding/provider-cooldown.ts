/**
 * Provider cooldown — a process-local circuit breaker for a rate-limited or
 * overloaded model PROVIDER (autonomy loop #3, 2026-09-19).
 *
 * THE COST WITHOUT IT: the lead-seat fallback (owner 2026-09-17) moves a 429 /
 * 5xx turn to a sibling seat and retries the CHOSEN seat on the very next
 * step. Under a sustained provider rate limit that means EVERY step pays one
 * rejected round trip before the fallback answers — Z.AI 2026-09-19
 * 00:00–03:10Z: 210 rejected glm-5.3 turns across 16 sessions (41 in one
 * ten-minute slot), each a wasted request that itself counts against the
 * provider's per-minute budget, so the storm fed itself.
 *
 * THE RULE: THRESHOLD rejections from one provider inside WINDOW_MS trip a
 * COOLDOWN_MS cooldown for that provider. While it holds, a lead seat on that
 * provider does not probe it — the run starts on (or stays on) its fallback
 * seat; the first step after the cooldown probes the primary again exactly as
 * the revert path always did. Rejections are 429 and 5xx (the provider
 * answering "not now"); billing suspensions are sticky per run and never
 * counted here; 400/401/403 never reach this module.
 *
 * Process-local by design: each web/worker process sees its own share of the
 * storm; the breaker bounds THIS process's contribution and needs no shared
 * state. Pure leaf — no imports. (RSW-1 cluster 29, 2026-11-02: the
 * PROVIDER_COOLDOWN_DISABLED=1 kill switch was deleted — the breaker is
 * unconditional; it had no reader left outside this module.)
 */

export const PROVIDER_COOLDOWN_WINDOW_MS = 120_000;
export const PROVIDER_COOLDOWN_THRESHOLD = 3;
export const PROVIDER_COOLDOWN_MS = 180_000;
/** Adaptive ladder (2026-09-19 15:55Z: Z.AI re-tripped 15× in 2.5 h at a FIXED
 *  180 s — the breaker released, runs went back, the concurrency limit (code
 *  1302) hit again; 76 of 97 lead fallbacks still paid a rejected turn). Each
 *  trip that follows the previous cooldown within RESET_MS doubles the hold:
 *  180 → 360 → 720 → 900 s (cap). A quiet RESET_MS after a cooldown ends
 *  returns the ladder to the base. */
export const PROVIDER_COOLDOWN_MAX_MS = 900_000;
export const PROVIDER_COOLDOWN_RESET_MS = 600_000;

const strikes = new Map<string, number[]>();
const coolingUntil = new Map<string, number>();
const ladder = new Map<string, { consecutive: number; lastEnd: number }>();

/** The hold a trip at `now` would impose, given the provider's recent trip history. Pure. */
export function providerCooldownDurationMs(consecutiveTrips: number): number {
  return Math.min(PROVIDER_COOLDOWN_MS * 2 ** Math.max(0, consecutiveTrips - 1), PROVIDER_COOLDOWN_MAX_MS);
}



/** Normalize a provider identity (the ProviderConfig label, e.g. "ZAI direct"). */
export function providerCooldownKey(label: string | undefined | null): string {
  return String(label ?? '').trim().toLowerCase() || 'unknown';
}

/**
 * Record one rejection. Returns whether THIS strike tripped a (new) cooldown,
 * the strike count inside the window, and the cooldown end when one holds.
 */
export function noteProviderRejection(label: string | undefined | null, now: number = Date.now()): { tripped: boolean; strikes: number; until: number | null; consecutive?: number; durationMs?: number } {
  const key = providerCooldownKey(label);
  const list = (strikes.get(key) ?? []).filter((t) => now - t < PROVIDER_COOLDOWN_WINDOW_MS);
  list.push(now);
  strikes.set(key, list);
  const existing = coolingUntil.get(key);
  if (existing && existing > now) return { tripped: false, strikes: list.length, until: existing };
  if (list.length >= PROVIDER_COOLDOWN_THRESHOLD) {
    const prev = ladder.get(key);
    const consecutive = prev && now - prev.lastEnd < PROVIDER_COOLDOWN_RESET_MS ? prev.consecutive + 1 : 1;
    const durationMs = providerCooldownDurationMs(consecutive);
    const until = now + durationMs;
    coolingUntil.set(key, until);
    ladder.set(key, { consecutive, lastEnd: until });
    strikes.set(key, []); // the next window starts clean after the cooldown
    return { tripped: true, strikes: list.length, until, consecutive, durationMs };
  }
  return { tripped: false, strikes: list.length, until: null };
}

/** Cooldown end (epoch ms) when the provider is cooling down right now, else null. */
export function providerCooldownUntil(label: string | undefined | null, now: number = Date.now()): number | null {
  const until = coolingUntil.get(providerCooldownKey(label));
  if (!until) return null;
  if (until <= now) { coolingUntil.delete(providerCooldownKey(label)); return null; }
  return until;
}

/** Test seam. */
export function __resetProviderCooldownForTests(): void {
  strikes.clear();
  coolingUntil.clear();
  ladder.clear();
}
