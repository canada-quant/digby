/**
 * Expired-token log NOISE guard (autonomy loop #19, 2026-09-21). One stuck
 * client re-presented the SAME access token (expired six days earlier) every
 * ~38 s for hours — 376 warn rows in 4 h, 44% of the day's app_error_logs
 * volume, the exact 2026-08-08 pattern the warn taxonomy was meant to end.
 * The middleware keeps ONE warn per token fingerprint per window (with the
 * repeat count) and drops the rest to debug. Pure, in-memory, bounded.
 */
import { createHash } from 'crypto';

export const EXPIRED_TOKEN_WINDOW_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5000;
const seen = new Map<string, { first: number; count: number }>();

export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}

/** Returns whether THIS occurrence should be logged at warn, plus how many times the same token was already seen in the window. */
export function expiredTokenNoise(token: string, now: number = Date.now()): { log: boolean; repeats: number; fingerprint: string } {
  const fingerprint = tokenFingerprint(token);
  if (seen.size > MAX_ENTRIES) {
    for (const [k, v] of seen) if (now - v.first > EXPIRED_TOKEN_WINDOW_MS) seen.delete(k);
    if (seen.size > MAX_ENTRIES) seen.clear();
  }
  const cur = seen.get(fingerprint);
  if (!cur || now - cur.first > EXPIRED_TOKEN_WINDOW_MS) {
    seen.set(fingerprint, { first: now, count: 1 });
    return { log: true, repeats: cur && now - cur.first > EXPIRED_TOKEN_WINDOW_MS ? cur.count : 0, fingerprint };
  }
  cur.count += 1;
  return { log: false, repeats: cur.count - 1, fingerprint };
}

export function __resetTokenNoiseForTest(): void { seen.clear(); }
