import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { env } from './env';
import logger from '../utils/logger';
import { registerSpawnClaimStore, type SpawnClaimStore } from '../modules/crossmodel/platform/spawn-claim-store';

const redisClient: RedisClientType = createClient({
  url: env.REDIS_URL,
});

redisClient.on('error', (err) => {
  logger.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
  logger.info('✅ Redis connected');
});

// Connect to Redis
export const connectRedis = async () => {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
};

/**
 * SPAWN-CLAIM STORE (ticket d1120ffc, 2026-11-02) — the cross-box face of the
 * start_coding_session dedupe. Registered HERE, at the one module that owns the
 * client, because the consumer (platform-tools.ts) must never import this file:
 * it validates the whole env at import and `process.exit(1)`s in a bare test
 * env, which reds every hermetic suite that walks the tools import graph.
 * Read the header of platform/spawn-claim-store.ts for the full rationale.
 *
 * Semantics are deliberately the minimum the dedupe needs, and every method
 * THROWS on a Redis error — the tool seam catches and fails OPEN (a dedupe that
 * cannot read its claim must never block a legitimate spawn).
 */
const redisSpawnClaimStore: SpawnClaimStore = {
  async claim(key, value, ttlSec) {
    // SET NX EX: the first caller wins; `null` back means a claim already exists.
    const res = await redisClient.set(key, value, { NX: true, EX: Math.max(1, ttlSec) });
    return res === 'OK';
  },
  async read(key) {
    return redisClient.get(key);
  },
  async write(key, value, ttlSec) {
    await redisClient.set(key, value, { EX: Math.max(1, ttlSec) });
  },
  async release(key) {
    await redisClient.del(key);
  },
  async reclaim(key, expectedValue, value, ttlSec) {
    // Compare-and-set across boxes. A WATCH/MULTI transaction is the only way to
    // make "still holds the stale value" and "replace it" atomic on Redis; a bare
    // GET-then-SET would let two callers both reclaim and both spawn — the exact
    // duplicate lane this seam exists to prevent.
    await redisClient.watch(key);
    try {
      const current = await redisClient.get(key);
      if (current !== expectedValue) {
        await redisClient.unwatch();
        return false;
      }
      const tx = redisClient.multi();
      tx.set(key, value, { EX: Math.max(1, ttlSec) });
      const res = await tx.exec();
      return Array.isArray(res) && res.length > 0;
    } catch (err) {
      await redisClient.unwatch().catch(() => undefined);
      throw err;
    }
  },
  async ageSec(key) {
    // HONEST null: a Redis TTL alone says how long is LEFT, not when the claim
    // was taken, so this store cannot report an age. The replay note omits the
    // age rather than inventing one (the in-process store does know it).
    const exists = await redisClient.exists(key);
    return exists ? null : null;
  },
};
registerSpawnClaimStore(redisSpawnClaimStore);

// Graceful shutdown
process.on('beforeExit', async () => {
  await redisClient.quit();
});

export default redisClient;
