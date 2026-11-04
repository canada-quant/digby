/**
 * Redis-backed Store for express-rate-limit (v7 Store contract).
 *
 * The default MemoryStore is per-process: with blue+green (and web+worker)
 * instances behind nginx, every limit is effectively doubled and resets on
 * each deploy. This store counts hits in the shared Redis instead: INCR +
 * PEXPIRE-on-first-hit, one key per client per limiter (distinct `prefix`
 * per limiter so stream/upload/auth/platform never collide on the same IP).
 *
 * Redis outage posture: DEGRADE to a per-process in-memory window, never to
 * unlimited. A plain fail-open (totalHits=1) would disable the auth
 * brute-force limiter for the whole outage — strictly worse than the old
 * MemoryStore, which kept counting without Redis (review 2026-08-16). The
 * fallback restores exactly those per-process semantics: counts are local to
 * each instance (limits effectively double across two instances) and are
 * discarded when Redis recovers. The degradation is logged once per outage.
 */

import type { Options, Store, IncrementResponse } from 'express-rate-limit';
import redisClient from '../config/redis';
import logger from '../utils/logger';

export class RedisRateLimitStore implements Store {
  /** Set by init() from the limiter's options; sane default until then. */
  windowMs = 60_000;
  readonly prefix: string;
  /** Keys live in shared Redis — instances DO see each other's hits. */
  readonly localKeys = false;

  private warned = false;
  /** Per-process outage fallback windows (see header) — keyed by the raw key. */
  private fallback = new Map<string, { count: number; resetAt: number }>();
  /** Sweep expired fallback entries past this size (memory bound under attack). */
  private static readonly FALLBACK_MAX_ENTRIES = 10_000;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private key(key: string): string {
    return this.prefix + key;
  }

  private failOpen(key: string, err: unknown): IncrementResponse {
    if (!this.warned) {
      this.warned = true;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`rate-limit store ${this.prefix}: Redis unavailable — degrading to per-process in-memory window: ${msg}`);
    }
    const now = Date.now();
    let entry = this.fallback.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 1, resetAt: now + this.windowMs };
      if (this.fallback.size >= RedisRateLimitStore.FALLBACK_MAX_ENTRIES) {
        for (const [k, e] of this.fallback) {
          if (now > e.resetAt) this.fallback.delete(k);
        }
      }
      this.fallback.set(key, entry);
    } else {
      entry.count++;
    }
    return { totalHits: entry.count, resetTime: new Date(entry.resetAt) };
  }

  async increment(key: string): Promise<IncrementResponse> {
    if (!redisClient.isOpen) return this.failOpen(key, new Error('client not open'));
    try {
      const k = this.key(key);
      const [hits, ttl] = await redisClient.multi().incr(k).pTTL(k).exec();
      let ttlMs = Number(ttl);
      if (ttlMs < 0) {
        // First hit of the window (INCR created the key with no TTL) — or a key
        // that somehow lost its TTL; either way, start a fresh window now.
        ttlMs = this.windowMs;
        await redisClient.pExpire(k, this.windowMs);
      }
      if (this.warned) {
        // Recovered — a future outage warns again; drop the outage windows so
        // stale local counts never linger into healthy operation.
        this.warned = false;
        this.fallback.clear();
      }
      return { totalHits: Number(hits), resetTime: new Date(Date.now() + ttlMs) };
    } catch (err) {
      return this.failOpen(key, err);
    }
  }

  async decrement(key: string): Promise<void> {
    await redisClient.decr(this.key(key)).catch(() => {});
  }

  async resetKey(key: string): Promise<void> {
    await redisClient.del(this.key(key)).catch(() => {});
  }
}
