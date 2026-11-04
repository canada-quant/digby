/**
 * Integration-status cache — the Redis key + invalidation helper for the
 * per-user "[YOUR INTEGRATION STATUS]" block built in query-pipeline.ts.
 *
 * Extracted into its own tiny module (2026-07-06) so the OAuth callback
 * controllers can invalidate the cache on connect/disconnect WITHOUT importing
 * the heavy query-pipeline.ts graph (circular-import risk). The block itself is
 * still assembled in query-pipeline.ts (buildIntegrationStatusBlock); this file
 * owns only the cache key + the two cache primitives shared with the callbacks.
 *
 * Import-light (ticket c02b85bf): redis is loaded LAZILY inside the functions,
 * never at module load. config/redis pulls config/env, which validates env vars
 * and process.exit(1)s when they are absent — importing it eagerly made this
 * "tiny" module fatal to import-light test contexts (and any future consumer
 * that runs before env is set). The key stays a pure export; the two async
 * helpers resolve the client per call (jest mocks intercept the dynamic import
 * exactly like a static one).
 */
import type redisClientType from '../../../config/redis';

export const INTEGRATION_STATUS_CACHE_KEY = (userId: string) => `cm_integ_status:${userId}`;
export const INTEGRATION_STATUS_CACHE_TTL = 300; // seconds (5 min upper bound; explicit invalidation keeps it fresh)

/** Drop the cached integration-status block for a user (call after connect/disconnect). */
export async function invalidateIntegrationStatusCache(userId: string): Promise<void> {
  try {
    const redis: typeof redisClientType = (await import('../../../config/redis')).default;
    await redis.del(INTEGRATION_STATUS_CACHE_KEY(userId));
  } catch { /* non-critical */ }
}
