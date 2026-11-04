/**
 * Cross-process per-project lock.
 *
 * Extracted from project-workspace.service.ts (todo fed7731d / PR #252 review)
 * so workspace.service.ts can serialize ensureRepoMirror's clone/fetch of the
 * shared per-project bare mirror WITHOUT importing project-workspace.service
 * (which itself imports workspace.service — a cycle). project-workspace.service
 * re-exports withProjectLock as __withProjectLockForTest for its existing suite.
 *
 * NOTE for tests: config/redis is resolved LAZILY on first lock acquisition
 * (below), NOT at module load. workspace.service is reached transitively by
 * dozens of jest suites (via coding/tools.ts) that never take the lock, and
 * an eager config/redis → config/env import PROCESS.EXITS under jest (the
 * fed7731d first cut broke 24 suites that way). Suites that DO exercise the
 * lock mock config/redis at the boundary as usual — jest.mock intercepts the
 * lazy require by resolved path exactly like an eager import.
 */

import logger from '../../../utils/logger';

// Type-only (erased at compile time — zero runtime import side effect).
type ProjectLockRedis = typeof import('../../../config/redis').default;

let redisLazy: ProjectLockRedis | null = null;
function redisClient(): ProjectLockRedis {
  if (!redisLazy) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    redisLazy = require('../../../config/redis').default as ProjectLockRedis;
  }
  return redisLazy;
}

// ── Per-project lock (E5, now cross-process) ─────────────────────────────────
// The in-process mutex below only serializes ONE process — but the
// coding_workspaces volume is SHARED across web + worker + blue/green, so two
// processes could still race a clone/commit/push on the same mirror. A Redis
// NX lock is the OUTER cross-process layer; the promise-chain mutex stays as
// the inner in-process layer. Fail posture is OPEN: Redis down → in-process
// mutex alone (a degraded lock must never block knowledge commits), logged
// once per outage.
const projectLocks = new Map<string, Promise<void>>();

const PROJECT_LOCK_KEY = (projectId: string) => `coding:project:lock:${projectId}`;
// TTL comfortably above the refresh interval so a healthy holder never loses
// the lock, but a hard-crashed holder frees it within a minute.
const PROJECT_LOCK_TTL_MS = 60_000;
const PROJECT_LOCK_REFRESH_MS = 20_000;
const PROJECT_LOCK_RETRY_MS = 500;
// Bounded wait: the longest healthy hold is no longer withTempWorktree's 120s
// clone cap — ensureRepoMirror now holds this lock (todo fed7731d), and a
// mirror clone runs up to 300s while a fetch+unshallow runs up to ~780s
// (180s fetch cap + 600s unshallow cap). The bounded wait must cover those or
// a healthy long clone would force fail-open degradation mid-race. (TTL and
// refresh are unchanged: a crashed holder still frees the lock within ~60s; a
// live slow holder refreshes and waiters correctly wait.)
const PROJECT_LOCK_WAIT_MS = 900_000;

// Ownership-checked release/refresh: only touch the key while OUR token is
// still its value (a lock that expired and was re-acquired by another process
// must not be deleted or extended by the stale holder).
const RELEASE_IF_OWNER_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const REFRESH_IF_OWNER_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';

let redisLockWarned = false;

/**
 * Acquire the cross-process project lock. Returns the ownership token, or null
 * to fall back to the in-process mutex alone (Redis unavailable, or the wait
 * timed out — both degrade to the pre-Redis behavior rather than failing the
 * knowledge commit).
 */
async function acquireProjectRedisLock(projectId: string): Promise<string | null> {
  const key = PROJECT_LOCK_KEY(projectId);
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + PROJECT_LOCK_WAIT_MS;
  for (;;) {
    let r: string | null;
    try {
      r = await redisClient().set(key, token, { NX: true, PX: PROJECT_LOCK_TTL_MS });
    } catch (err: any) {
      if (!redisLockWarned) {
        redisLockWarned = true;
        logger.warn(`project workspace: Redis lock unavailable — in-process mutex only: ${err.message}`);
      }
      return null;
    }
    redisLockWarned = false;
    if (r === 'OK') return token;
    if (Date.now() + PROJECT_LOCK_RETRY_MS > deadline) {
      logger.warn(`project workspace: lock wait for ${projectId} exceeded ${PROJECT_LOCK_WAIT_MS}ms — proceeding under in-process mutex only`);
      return null;
    }
    await new Promise(res => setTimeout(res, PROJECT_LOCK_RETRY_MS));
  }
}

async function releaseProjectRedisLock(projectId: string, token: string): Promise<void> {
  await redisClient()
    .eval(RELEASE_IF_OWNER_LUA, { keys: [PROJECT_LOCK_KEY(projectId)], arguments: [token] })
    .catch(() => {});
}

export async function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const token = await acquireProjectRedisLock(projectId);
  // Refresh the TTL while held so a long clone/push outlives PROJECT_LOCK_TTL_MS.
  let refresh: ReturnType<typeof setInterval> | null = null;
  if (token) {
    refresh = setInterval(() => {
      void redisClient()
        .eval(REFRESH_IF_OWNER_LUA, {
          keys: [PROJECT_LOCK_KEY(projectId)],
          arguments: [token, String(PROJECT_LOCK_TTL_MS)],
        })
        .catch(() => {});
    }, PROJECT_LOCK_REFRESH_MS);
    refresh.unref?.();
  }
  try {
    const prev = projectLocks.get(projectId) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(r => { release = r; });
    projectLocks.set(projectId, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (projectLocks.get(projectId) === next) projectLocks.delete(projectId);
    }
  } finally {
    if (refresh) clearInterval(refresh);
    if (token) await releaseProjectRedisLock(projectId, token);
  }
}
