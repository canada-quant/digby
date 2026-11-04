/**
 * Rate slots — the per-chat/hour + per-user/day Redis counters the platform
 * tools meter their side effects with (notify_user, add_knowledge_url/_note,
 * and, since 2026-09-24, generate_image + POST /images/generate).
 *
 * A dependency-free LEAF: the four exports are verbatim copies of the private
 * helpers in account-tools.ts (rateKeys / consumeRateSlots / HOUR_KEY_TTL /
 * DAY_KEY_TTL) so a caller outside that module can meter without importing the
 * whole account-tool executor (and its prisma/redis graph). account-tools.ts
 * keeps its private copies for now — a peer session is editing it; dedupe by
 * importing from here on its next quiet edit. Keep the semantics IDENTICAL:
 * the refund-on-refusal rule below is what makes the counters equal the calls
 * actually admitted.
 */

/**
 * UTC day + hour keys for the per-user/day + per-chat/hour rate caps
 * (prefix 'notify' for notify_user, 'knowledge' for add_knowledge_url/_note,
 * 'image' for generate_image).
 */
export function rateKeys(prefix: string, userId: string, sessionId: string, now = new Date()): { dayKey: string; hourKey: string } {
  const iso = now.toISOString(); // 2026-09-08T14:03:22.123Z
  const day = iso.slice(0, 10);   // yyyy-mm-dd
  const hour = iso.slice(0, 13);  // yyyy-mm-ddThh
  return { dayKey: `${prefix}:user:${userId}:${day}`, hourKey: `${prefix}:chat:${sessionId}:${hour}` };
}

export type RateSlot = { key: string; cap: number; ttlSec: number; scope: 'chat_hourly' | 'user_daily' };
export type RateResult = { ok: true } | { ok: false; scope: RateSlot['scope']; cap: number };

/** The subset of the redis client the meter needs (ioredis satisfies it). */
export interface RateRedis {
  incr: (k: string) => Promise<number>;
  decr: (k: string) => Promise<number>;
  expire: (k: string, s: number) => Promise<unknown>;
}

/**
 * Take ONE slot from each counter in order (hourly chat bucket, then daily user
 * bucket); refuse with the FIRST scope that overflows. Compensation (review
 * 2026-09-08): a refusal gives back every slot the call already took — incl.
 * the overflowing key's own increment — so the counters always equal the calls
 * actually ADMITTED. Before this, a daily-capped notify_user still consumed an
 * hourly slot on each refused attempt, so the 6th attempt in that hour came
 * back as chat_hourly instead of user_daily and the model got the wrong
 * guidance ("batch into the chat answer" vs "the user is at the daily cap").
 * Throws on a redis error — the CALLER decides fail-open vs fail-closed.
 */
export async function consumeRateSlots(redis: RateRedis, slots: RateSlot[]): Promise<RateResult> {
  const taken: string[] = [];
  for (const slot of slots) {
    const n = await redis.incr(slot.key);
    await redis.expire(slot.key, slot.ttlSec);
    taken.push(slot.key);
    if (n > slot.cap) {
      for (const k of taken) await redis.decr(k).catch(() => { /* best effort — an over-count only makes the cap stricter */ });
      return { ok: false, scope: slot.scope, cap: slot.cap };
    }
  }
  return { ok: true };
}

/**
 * Give back every slot a successful `consumeRateSlots` took — for callers whose
 * metered action then FAILED (a provider error must not eat the user's budget).
 * Best effort: a decr error only makes the cap stricter.
 */
export async function refundRateSlots(redis: Pick<RateRedis, 'decr'>, slots: RateSlot[]): Promise<void> {
  for (const slot of slots) await redis.decr(slot.key).catch(() => { /* best effort */ });
}

/** Hour bucket keys live 2h, day bucket keys 2d — long enough to outlive their bucket. */
export const HOUR_KEY_TTL = 2 * 3600;
export const DAY_KEY_TTL = 2 * 86_400;
