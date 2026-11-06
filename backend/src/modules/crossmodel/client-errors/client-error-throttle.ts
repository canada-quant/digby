/**
 * Ingest throttle for client error reports (ticket d4e643a5, 2026-11-06).
 *
 * POST /api/crossmodel/client-error is PUBLIC (a crashing tab may be a signed-out
 * visitor, and a crash inside the login flow has no token at all), so the
 * endpoint is an untrusted write surface onto app_error_logs — the same posture
 * as POST /visit-events and the /ux/beacon stream beacons. Two independent
 * reasons this exists:
 *
 *  1. ONE ROW SET, NOT ONE ROW PER THROW. A render loop can throw the same
 *     error thousands of times a second, and React re-renders on every
 *     animation frame. The ticket's acceptance is explicit: the same signature
 *     repeated 100× must produce ONE row set. So a signature is admitted at
 *     most once per SIGNATURE_INTERVAL_MS; the suppressed duplicates are
 *     counted, not written.
 *  2. NO CROSS-CLIENT SILENCING. The per-signature window alone would let one
 *     tab posting random junk signatures spend the process budget and blind
 *     every real crash, so the per-client (hashed client ip) and process-wide
 *     per-minute ceilings are SEPARATE budgets — a refused report spends
 *     nothing.
 *
 * In-process only: the state never leaves memory, and two boxes each admitting
 * one row per window is fine — the sweep fingerprints the MESSAGE, so the two
 * rows collapse into one recurrence group by construction.
 *
 * Bounded maps: every map is pruned past MAX_KEYS so a hostile client cannot
 * grow memory by rotating signatures.
 *
 * Kill switch: CLIENT_ERROR_INGEST_DISABLED=1 (the endpoint answers 204 and
 * records nothing).
 */

/** A signature is written at most once per this window (a 5-min bucket == the sweep's own boot-episode gap is NOT implied; this is purely ingest pressure). */
export const SIGNATURE_INTERVAL_MS = 5 * 60 * 1000;
/** One client (hashed client ip) admits at most this many DISTINCT reports per minute. */
export const MAX_PER_CLIENT_PER_MIN = 12;
/** Process-wide ceiling per minute across every signature and client. */
export const MAX_PER_MIN = 30;
/**
 * Process-wide ceiling per rolling 24 h — THE sweep-protection budget.
 *
 * The hourly log-signal-sweep reads the newest LOG_SIGNAL_ROWS_CAP (3000) rows
 * of a 24 h window and fingerprints them. Client rows land in the SAME table,
 * so a deploy that breaks every page could push real SERVER errors out of that
 * window and blind the sweep to the fault that caused the breakage. 400 rows
 * per process per day (≈ 800 across the two prod boxes) keeps client reports a
 * bounded minority of the 3000-row window whatever the breakage looks like,
 * while still admitting genuine UI faults. Deliberately a plain cap with no
 * switch: the switch is the ingest kill switch itself.
 */
export const MAX_PER_DAY = 400;
/** Bound on the tracking maps (pruned past it). */
export const MAX_KEYS = 5_000;

export function clientErrorIngestDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLIENT_ERROR_INGEST_DISABLED === '1';
}

const lastBySignature = new Map<string, number>();
const byClient = new Map<string, { start: number; count: number }>();
let windowStart = 0;
let windowCount = 0;
let dayStart = 0;
let dayCount = 0;

function prune(map: Map<string, number>, now: number): void {
  if (map.size < MAX_KEYS) return;
  for (const [k, at] of map) if (now - at >= SIGNATURE_INTERVAL_MS) map.delete(k);
  if (map.size >= MAX_KEYS) map.clear();
}

export interface ClientErrorThrottleVerdict {
  /** May this report be written now? */
  admit: boolean;
  /** 'admitted' | 'duplicate' (same signature inside its window) | 'client-capped' | 'global-capped' | 'day-capped' */
  reason: 'admitted' | 'duplicate' | 'client-capped' | 'global-capped' | 'day-capped';
  /** How many reports this signature has absorbed inside the current window (≥ 1 when admitted). */
  occurrences: number;
}

/**
 * Decide whether one report is written, and record it when it is. Pure but for
 * the module's own state; a refused report spends NOTHING (no clock bump, no
 * budget decrement) so a client that is over its ceiling cannot extend its own
 * block by retrying.
 */
export function admitClientErrorReport(signature: string, client: string | null, now: number = Date.now()): ClientErrorThrottleVerdict {
  const sig = String(signature ?? '').slice(0, 200);

  // 0. Daily ceiling — the sweep-protection budget (see MAX_PER_DAY).
  if (now - dayStart >= 86_400_000) { dayStart = now; dayCount = 0; }
  if (dayCount >= MAX_PER_DAY) return { admit: false, reason: 'day-capped', occurrences: 1 };

  // 1. Global per-minute ceiling.
  if (now - windowStart >= 60_000) { windowStart = now; windowCount = 0; }
  if (windowCount >= MAX_PER_MIN) return { admit: false, reason: 'global-capped', occurrences: 1 };

  // 2. Per-client per-minute ceiling (a client with no derivable ip shares one bucket).
  const clientKey = client || 'noip';
  let c = byClient.get(clientKey);
  if (c && now - c.start >= 60_000) c = undefined;
  if (c && c.count >= MAX_PER_CLIENT_PER_MIN) return { admit: false, reason: 'client-capped', occurrences: 1 };

  // 3. Same signature inside its window ⇒ duplicate: count it, write nothing.
  prune(lastBySignature, now);
  const last = lastBySignature.get(sig);
  if (last !== undefined && now - last < SIGNATURE_INTERVAL_MS) {
    return { admit: false, reason: 'duplicate', occurrences: 1 };
  }

  lastBySignature.set(sig, now);
  windowCount++;
  dayCount++;
  if (byClient.size >= MAX_KEYS) {
    for (const [k, v] of byClient) if (now - v.start >= 60_000) byClient.delete(k);
    if (byClient.size >= MAX_KEYS) byClient.clear();
  }
  byClient.set(clientKey, c ? { start: c.start, count: c.count + 1 } : { start: now, count: 1 });
  return { admit: true, reason: 'admitted', occurrences: 1 };
}

/** Test seam: forget all throttle state. */
export function __resetClientErrorThrottle(): void {
  lastBySignature.clear();
  byClient.clear();
  windowStart = 0;
  windowCount = 0;
  dayStart = 0;
  dayCount = 0;
}

/** Test seam: how many signatures the throttle is tracking. */
export function __clientErrorSignatureCount(): number {
  return lastBySignature.size;
}