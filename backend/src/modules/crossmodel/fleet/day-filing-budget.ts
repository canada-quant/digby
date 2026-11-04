/**
 * Per-UTC-day NEW-filing budget for the hourly ticket sweeps — the Redis
 * INCR-first reservation the log-signal sweep introduced (aad94ed4), shared so
 * framework-signal-sweep uses the same shape (2026-10-20). Leaf module: the
 * caller passes its Redis client, so neither sweep pulls the other in.
 *
 * INCR first (atomic across every worker), set the TTL on the first slot of
 * the day, and give the slot back when the day is already spent so a capped
 * day never inflates the counter. A Redis failure answers 'unknown' — the
 * caller fails OPEN (feedback's own caps still bound the insert) and must not
 * refund a slot it never reserved.
 */

export interface DayBudgetRedis {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  decr(key: string): Promise<unknown>;
}

export type DaySlot = 'reserved' | 'capped' | 'unknown';

/** UTC day stamp (YYYY-MM-DD) — day-named keys need no reset job. */
export function utcDayStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function reserveDayFilingSlot(redis: DayBudgetRedis, key: string, cap: number, ttlSec: number): Promise<DaySlot> {
  const used = await redis.incr(key).catch(() => null);
  if (used === null) return 'unknown';
  if (used === 1) await redis.expire(key, ttlSec).catch(() => {});
  if (used > cap) {
    await redis.decr(key).catch(() => {}); // don't let a capped day inflate the counter
    return 'capped';
  }
  return 'reserved';
}

/** Give back a reserved slot (the insert failed, threw, or was a dedup bump). */
export async function refundDayFilingSlot(redis: DayBudgetRedis, key: string): Promise<void> {
  await redis.decr(key).catch(() => {});
}
