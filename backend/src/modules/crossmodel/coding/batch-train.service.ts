/**
 * batch-train.service.ts — the active batch-train registry's store + discovery
 * wiring (T2c, todo 9c89ab21).
 *
 * The leaf (batch-train.ts) holds the pure classification/notice logic; this
 * file adds the two things the leaf must not touch:
 *
 *   1. LIVE DISCOVERY (getActiveBatchTrains / getLiveBatchTrain): pure GitHub
 *      reads via the injectable API — NO redis anywhere in this path. This is
 *      deliberate: this module is dynamically imported from coding/tools.ts
 *      (the open_pull_request boarding advisory), and ANY top-level or
 *      require-time touch of config/redis drags src/config/env.ts's env
 *      validation — which calls process.exit(1) on a ZodError — into every
 *      suite that transitively imports tools.ts. That exact chain killed the
 *      open-pull-request-head / verify-gate / dependency-advisories jest
 *      workers (observed 2026-10-17, twice: first via a top-level import,
 *      then via a require-at-use). process.exit cannot be caught; the only
 *      safe design is to not load it from this path at all.
 *   2. A REDIS CACHE for the FIRE SEAMS ONLY. A machine-wake firing has no
 *      GitHub token, so appendBatchTrainNotice reads the cache (kept warm by
 *      the token-bearing paths' discovery writes). The cache is reached
 *      through lazyRedis(), which refuses to require config/redis inside a
 *      jest worker (JEST_WORKER_ID) — in tests every cache call is a no-op
 *      miss, fail-open by construction.
 *
 * Why auto-discovery instead of a registration surface (the deliberate
 * departure from the infra-blockers idiom): trains are cut by ANY operator —
 * Digby Code's own box (which cannot reach this platform's Redis or tools),
 * the Fleet Supervisor, a human with git. The BRANCH is the state: a
 * `batch/<ts>` head that is not an ancestor of main IS a boarding train, and
 * the moment the train fast-forwards main the branch becomes an ancestor and
 * reads as landed. Nothing to register, nothing to forget to clear.
 *
 * Fail-open everywhere: discovery errors mean "we cannot prove a train is
 * boarding" and annotate/refuse nothing (the 2026-10-17 P0 lesson — a gate
 * that holds the whole fleet on a flaky dependency is strictly worse than a
 * slipped merge the runbook absorbs by re-boarding).
 */

import logger from '../../../utils/logger';
import {
  ActiveBatchTrain,
  BatchTrainDiscoveryApi,
  DiscoveryOutcome,
  discoveryApiFromGithub,
  discoverBatchTrains,
  batchTrainGateDisabled,
  DISCOVERY_CACHE_KEY,
  DISCOVERY_CACHE_TTL_MS,
  isLiveTrain,
} from './batch-train';

let lastWarnAt = 0;
function warnThrottled(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  logger.warn(`batch-train: ${message}`);
}

/** Build a minimal read-only GitHub API adapter for train discovery. Lives
 *  HERE (not by importing self-merge.service's defaultGithubApi) because this
 *  module is dynamically imported from coding/tools.ts — the open_pull_request
 *  boarding advisory — and self-merge.service's top-level config/database +
 *  config/env imports would drag env validation (process.exit(1)) into every
 *  suite that transitively imports tools.ts, killing jest workers (observed
 *  2026-10-17). The shape matches self-merge's GithubApi (GET-only —
 *  discovery never writes). */
export function batchTrainGithubApi(token: string): { get(url: string, accept?: string): Promise<{ status: number; data: any }> } {
  return {
    async get(url: string, accept?: string) {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: accept || 'application/vnd.github+json' },
      });
      let data: any = null;
      try { data = await r.json(); } catch { data = null; }
      return { status: r.status, data };
    },
  };
}

/** Lazy redis accessor — FIRE-SEAM paths only. Never require config/redis
 *  inside a jest worker: its top-level env validation calls process.exit(1)
 *  on a ZodError, which cannot be caught and kills the worker (the exact
 *  crash observed 2026-10-17). Returns null there; callers treat null as a
 *  cache miss and fail open. */
function lazyRedis(): any | null {
  if (process.env.JEST_WORKER_ID) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../../config/redis');
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

interface CachedDiscovery {
  cachedAt: number;
  outcome: DiscoveryOutcome;
}

function parseCache(raw: unknown): CachedDiscovery | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v.cachedAt !== 'number' || !Array.isArray(v.outcome?.trains)) return null;
    return v as CachedDiscovery;
  } catch {
    return null;
  }
}

/** Best-effort cache write (the token-bearing paths keep the fire seams
 *  warm). Never throws; a no-op under jest and on any redis failure. */
async function writeDiscoveryCache(outcome: DiscoveryOutcome, now: Date): Promise<void> {
  try {
    const redis = lazyRedis();
    if (!redis) return;
    const payload: CachedDiscovery = { cachedAt: now.getTime(), outcome };
    await (redis as any).set(DISCOVERY_CACHE_KEY, JSON.stringify(payload), { timeout: DISCOVERY_CACHE_TTL_MS / 1000 });
  } catch { /* best-effort */ }
}

/**
 * The LIVE discovery (no cache read — the gate and the PR advisory want the
 * freshest answer and both hold a token). Pure leaf call + best-effort cache
 * write. NEVER throws: every failure is a { trains: [], error } outcome
 * (fail-open — no proof of a boarding train ⇒ no hold).
 */
export async function getActiveBatchTrains(
  api: BatchTrainDiscoveryApi,
  now: Date = new Date(),
): Promise<DiscoveryOutcome> {
  if (batchTrainGateDisabled()) return { trains: [] };
  let outcome: DiscoveryOutcome;
  try {
    outcome = await discoverBatchTrains(api, now);
  } catch (err: any) {
    const error = `discovery failed: ${String(err?.message ?? err).slice(0, 160)}`;
    warnThrottled(error);
    return { trains: [], error };
  }
  if (outcome.error) warnThrottled(outcome.error);
  await writeDiscoveryCache(outcome, now);
  return outcome;
}

/** The single live (boarding) train, or null when none is boarding. The
 *  runbook's collision guard says at most ONE train is ever legitimate; if
 *  discovery ever reports two, the NEWEST name is the real train and the
 *  older is a stale leftover (surfaced by list_batch_trains for cleanup). */
export async function getLiveBatchTrain(api: BatchTrainDiscoveryApi, now: Date = new Date()): Promise<ActiveBatchTrain | null> {
  const { trains } = await getActiveBatchTrains(api, now);
  const live = trains.filter(isLiveTrain);
  if (!live.length) return null;
  live.sort((a, b) => b.branch.localeCompare(a.branch)); // newest name first
  return live[0];
}

/** Read the discovery cache WITHOUT live fallback — the fire-seam read (no
 *  token at fire time). Respects the TTL (a cold/stale cache annotates
 *  nothing — fail-open; the merge gate remains the authoritative check).
 *  Returns [] on every failure, cold cache, and under jest. */
export async function readCachedBatchTrains(): Promise<ActiveBatchTrain[]> {
  try {
    const redis = lazyRedis();
    if (!redis) return [];
    const raw = await (redis as any).get(DISCOVERY_CACHE_KEY);
    const cached = parseCache(raw);
    if (!cached || Date.now() - cached.cachedAt >= DISCOVERY_CACHE_TTL_MS) return [];
    return cached.outcome.trains;
  } catch {
    return [];
  }
}

/**
 * Fire-time annotation seam (the appendInfraBlockerNotice idiom): when a
 * machine-wake prompt names the publish/merge surface AND a cached-boarding
 * train exists, append the advisory [BATCH TRAIN ACTIVE] block. Advisory
 * only, never a skip; fail-open. Called from BOTH machine-wake seams —
 * fireScheduleTarget and queueContinuationRun.
 */
export async function appendBatchTrainNotice(prompt: string, label: string): Promise<string> {
  try {
    if (batchTrainGateDisabled()) return prompt;
    // Same trigger shape as the infra-blocker seam: prompts that name the
    // publish/merge surface (the leaf's regex, reused — one definition of
    // "runbook-shaped" across both annotations).
    const { isDeployRunbookPrompt } = await import('./infra-blockers');
    const { buildBatchTrainNotice, isLiveTrain } = await import('./batch-train');
    if (!isDeployRunbookPrompt(prompt)) return prompt;
    const trains = await readCachedBatchTrains();
    const live = trains.filter(isLiveTrain);
    if (!live.length) return prompt;
    const notice = buildBatchTrainNotice(live, new Date());
    return notice ? `${prompt}\n\n${notice}` : prompt;
  } catch (err: any) {
    logger.warn(`coding schedule: [BATCH TRAIN] scan failed for ${label} (firing proceeds without it): ${err?.message ?? err}`);
    return prompt;
  }
}

export { discoveryApiFromGithub };
