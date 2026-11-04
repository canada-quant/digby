/**
 * Durable cron (Phase 3) — the five former in-process web crons + the
 * agent-run reaper now fire from the WORKER, claimed out of Postgres.
 *
 * WHY: the Phase-1/2 worker tier made coding RUNS deploy-proof, but the web
 * process still owned the recurring BACKGROUND sweeps (news prefetch, feed
 * refresh, memory dream, container/worktree reapers) as floating setIntervals.
 * A deploy killed them mid-flight and, worse, nothing recorded when they last
 * fired — an unnoticed crash-loop meant silently-stale news/feeds/memory.
 *
 * HOW: one `cron_jobs` row per job. A worker boot REGISTERs each job (upsert
 * that never clobbers nextRunAt/lastFiredAt). A 5 s tick CLAIMS the oldest due
 * enabled job with a guarded updateMany (id + still-due + lease-free), setting
 * a 10-min lease + workerId — exactly one worker across blue/green overlap or
 * replicas wins; the loser's count=0 makes it try again next tick. The handler
 * runs AWAITED; finishCronJob then re-anchors nextRunAt = now + intervalSec at
 * FINISH time and clears the lease.
 *
 * Misfire catch-up: after downtime nextRunAt is in the past, so the job is due
 * immediately and fires EXACTLY ONCE (finish-time anchoring means no
 * thundering-herd replay of every missed interval). A worker crash mid-handler
 * is covered by the 10-min lease: another worker re-claims after expiry and
 * the sweep runs again (each sweep's own Redis-NX dedupe, kept from the
 * in-process era, bounds any true duplicate during the deploy overlap).
 */

import prisma from '../../config/database';
import logger from '../../utils/logger';

/** How long a claimed job is owned before another worker may re-claim it. */
export const CRON_LEASE_MS = 10 * 60 * 1000;

export interface CronJobRow {
  id: string;
  intervalSec: number;
}

/**
 * Register (idempotent upsert) one job. Called by the worker at boot for each
 * job it serves. Re-registration updates ONLY intervalSec — it must NOT
 * clobber nextRunAt/lastFiredAt (a worker reboot is not a firing); a fresh row
 * starts due one interval from now.
 */
export async function registerCronJob(id: string, intervalSec: number): Promise<void> {
  await prisma.cronJob.upsert({
    where: { id },
    update: { intervalSec },
    create: { id, intervalSec, nextRunAt: new Date(Date.now() + intervalSec * 1000) },
  });
}

/**
 * Retire ORPHANED cron rows (audit 2026-10-08 W3-4 — plumbing F10): a job
 * that left the code keeps its row forever — `box-health` moved into the
 * in-process infra-watch reporter on 2026-09-18 and its row still says
 * nextRunAt 2026-09-18, so every cron-lag view read 20 days stale. A row is
 * retired (deleted) only when its id is in NO worker's job list (`knownIds`
 * = the code's FULL list, never a box-filtered one), it is lease-free, and it
 * has been overdue for `staleMs` (default 7 d) — a job a newer colour just
 * added is never fresh-and-unknown for 7 days, so a blue/green overlap can
 * never delete a live job. Never throws; returns the retired ids. Kill switch
 * CRON_ORPHAN_GC_DISABLED=1.
 */
export const CRON_ORPHAN_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export async function retireOrphanCronJobs(knownIds: ReadonlyArray<string>, opts?: { staleMs?: number; now?: Date }): Promise<string[]> {
  if (String(process.env.CRON_ORPHAN_GC_DISABLED ?? '').trim() === '1') return [];
  if (!knownIds.length) return []; // an empty list would read every row as an orphan
  try {
    const now = opts?.now ?? new Date();
    const cutoff = new Date(now.getTime() - (opts?.staleMs ?? CRON_ORPHAN_STALE_MS));
    const orphans = await prisma.cronJob.findMany({
      where: {
        id: { notIn: [...knownIds] },
        nextRunAt: { lt: cutoff },
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      select: { id: true, nextRunAt: true, lastFiredAt: true },
      take: 50,
    });
    if (!orphans.length) return [];
    const ids = orphans.map((o) => o.id);
    await prisma.cronJob.deleteMany({ where: { id: { in: ids }, nextRunAt: { lt: cutoff } } });
    logger.info(`cron: retired ${ids.length} orphaned job row(s) no worker serves (overdue > ${Math.round((opts?.staleMs ?? CRON_ORPHAN_STALE_MS) / 86_400_000)} d): ${ids.join(', ')}`);
    try {
      const m = await import('./platform/loop-metrics.service');
      m.recordLoopMetric({
        kind: 'cron_orphan_retired',
        value: ids.length,
        meta: { ids, nextRunAt: orphans.map((o) => o.nextRunAt?.toISOString?.() ?? null) },
      });
    } catch { /* telemetry never blocks the GC */ }
    return ids;
  } catch (err: any) {
    logger.warn(`cron: orphan GC failed (non-fatal): ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Claim the oldest due, enabled, lease-free job for `workerId`. The pick is
 * made atomic by a guarded updateMany (id + still-due + lease-free predicates)
 * — count === 1 means THIS worker won the lease; count === 0 means another
 * worker claimed it first (or it finished between pick and claim) → null.
 */
export async function claimDueCronJob(workerId: string, onlyIds?: ReadonlyArray<string>): Promise<CronJobRow | null> {
  const now = new Date();
  const leaseFree = { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] };
  // onlyIds scopes the CLAIM to the jobs this worker actually serves
  // (2026-09-08 session-history-sync incident, pass #2: box A's cron-only
  // worker had the job filtered from its REGISTRATION list, but this claim
  // read the whole table and A's handler map still carried the entry — so A
  // kept claiming + running a workspace-volume-bound sweep against its stale
  // mirrors, 8/25 sessions failing every firing it won. A registration filter
  // alone can never fence a job: the claim itself must be limited to the
  // worker's own list. Absent = claim anything (old behavior for tests).
  const idScope = onlyIds ? { id: { in: [...onlyIds] } } : {};
  const due = await prisma.cronJob.findFirst({
    where: { enabled: true, nextRunAt: { lte: now }, ...leaseFree, ...idScope },
    orderBy: { nextRunAt: 'asc' },
    select: { id: true, intervalSec: true },
  });
  if (!due) return null;
  const claim = await prisma.cronJob.updateMany({
    where: { id: due.id, enabled: true, nextRunAt: { lte: now }, ...leaseFree },
    data: { leaseExpiresAt: new Date(now.getTime() + CRON_LEASE_MS), workerId },
  });
  if (claim.count !== 1) return null; // another worker won the race
  return { id: due.id, intervalSec: due.intervalSec };
}

/**
 * Lease heartbeat (2026-10-19). A handler that runs longer than CRON_LEASE_MS
 * (the hourly worktree reaper on a full disk) used to lose its lease
 * mid-pass, and another worker claimed the same job and ran a concurrent
 * pass. The live handler now renews its own lease every CRON_LEASE_MS/3 —
 * but only up to CRON_LEASE_MAX_HOLD_MS from the claim. A HUNG handler stops
 * renewing at that ceiling and its lease expires as before (an earlier
 * unbounded draft would have held a hung job forever). A crashed process
 * stops renewing at once. Kill switch CRON_LEASE_HEARTBEAT_DISABLED=1.
 */
export const CRON_LEASE_MAX_HOLD_MS = 2 * 60 * 60 * 1000;

/** Push a live claim's lease forward; false when the row is no longer ours. */
export async function renewCronLease(id: string, workerId: string, leaseMs: number = CRON_LEASE_MS): Promise<boolean> {
  const claim = await prisma.cronJob.updateMany({
    where: { id, workerId },
    data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
  });
  return claim.count === 1;
}

export function startCronLeaseHeartbeat(
  id: string,
  workerId: string,
  opts: { leaseMs?: number; maxHoldMs?: number; now?: () => number } = {},
): { stop: () => void } {
  const noop = { stop: () => {} };
  if (process.env.CRON_LEASE_HEARTBEAT_DISABLED === '1') return noop;
  const leaseMs = opts.leaseMs ?? CRON_LEASE_MS;
  const maxHoldMs = opts.maxHoldMs ?? CRON_LEASE_MAX_HOLD_MS;
  const now = opts.now ?? Date.now;
  const claimedAt = now();
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    // Never extend the lease past the hold ceiling: the last renewal may
    // carry it at most to claimedAt + maxHoldMs.
    const remaining = claimedAt + maxHoldMs - now();
    if (remaining <= 0) {
      stopped = true;
      clearInterval(timer);
      logger.warn(`cron lease heartbeat: job '${id}' still running after ${Math.round(maxHoldMs / 60000)} min — no longer renewing its lease (it can be re-claimed once the lease expires)`);
      return;
    }
    void renewCronLease(id, workerId, Math.min(leaseMs, remaining))
      .then(held => { if (!held) { stopped = true; clearInterval(timer); } })
      .catch(() => { /* DB blip — the next tick retries */ });
  }, Math.max(1000, Math.floor(leaseMs / 3)));
  (timer as any).unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}

/**
 * Record a firing's outcome and re-arm the job. nextRunAt is anchored at
 * FINISH time (now + intervalSec), so a job that fell due during downtime
 * fires exactly once on catch-up and then resumes its normal cadence — the
 * missed intervals are never replayed. lastStatus is truncated to 200 chars.
 */
export async function finishCronJob(id: string, ok: boolean, status: string): Promise<void> {
  const now = new Date();
  const job = await prisma.cronJob.findUnique({ where: { id }, select: { intervalSec: true } });
  if (!job) return; // row deleted out from under us — nothing to re-arm
  await prisma.cronJob.update({
    where: { id },
    data: {
      lastFiredAt: now,
      lastStatus: `${ok ? '' : 'ERROR: '}${status}`.slice(0, 200),
      leaseExpiresAt: null,
      workerId: null,
      nextRunAt: new Date(now.getTime() + job.intervalSec * 1000),
    },
  });
}

export interface CronLoopHandle {
  stop: () => void;
}

/**
 * Re-register ALL served jobs this often (Phase-3 review H2): boot
 * registration in worker.ts is only the FAST path — a transient DB blip during
 * deploy churn could otherwise drop a job's row for good and its sweep would
 * silently never fire again (the failure mode Phase 3 exists to fix).
 * registerCronJob is upsert-shaped and its update touches ONLY intervalSec, so
 * re-registration never re-arms a job or erases its fire history. At the
 * default 5 s tick this fires every 12th tick.
 */
export const CRON_REREGISTER_MS = 60_000;

/**
 * The worker-side loop: every tick claim ONE due job and run its handler
 * (awaited, so a long sweep naturally spans ticks — `ticking` blocks
 * re-entrancy). A throwing handler marks the job failed (its nextRunAt still
 * advances) and NEVER kills the loop; a claimed id with no handler is marked
 * failed 'no handler' (defends the jobs/handlers tables drifting apart).
 * Every CRON_REREGISTER_MS the tick first re-registers every job in `jobs`
 * (best-effort, per-job) so the table self-heals after a failed boot
 * registration (H2).
 */
export function startCronLoop(
  workerId: string,
  handlers: Record<string, () => Promise<void | string>>,
  jobs: ReadonlyArray<{ id: string; intervalSec: number }>,
  tickMs = 5_000,
): CronLoopHandle {
  let stopped = false;
  let ticking = false;
  const jobIds = jobs.map(j => j.id); // the claim scope — this worker's own list, nothing else
  // The clock (not a tick count) decides re-registration, so any tickMs —
  // including the tiny ticks tests use — re-registers on the same 60 s cadence.
  let lastRegister = Date.now();

  const tick = async (): Promise<void> => {
    // H2: self-healing registration. lastRegister advances BEFORE the upserts
    // so a failing database is retried on the NEXT INTERVAL rather than
    // hammered every tick; each job's upsert is individually best-effort.
    if (Date.now() - lastRegister >= CRON_REREGISTER_MS) {
      lastRegister = Date.now();
      for (const job of jobs) {
        await registerCronJob(job.id, job.intervalSec)
          .catch(err => logger.warn(`cron loop ${workerId}: re-register '${job.id}' failed (retrying next interval): ${err.message}`));
      }
    }

    let job: CronJobRow | null = null;
    try {
      // Claim ONLY the jobs in this worker's list — see claimDueCronJob's
      // onlyIds note (a 0-slot worker must never claim workspace-bound jobs).
      job = await claimDueCronJob(workerId, jobIds);
    } catch (err: any) {
      // DB hiccup: end this tick — the loop stays alive and retries next tick.
      logger.error(`cron loop ${workerId}: claim failed (retrying next tick): ${err.message}`);
      return;
    }
    if (!job) return;

    const handler = handlers[job.id];
    if (!handler) {
      logger.warn(`cron loop ${workerId}: claimed job '${job.id}' has no handler — marking failed`);
      await finishCronJob(job.id, false, 'no handler')
        .catch(err => logger.warn(`cron loop ${workerId}: finish(${job.id}) failed: ${err.message}`));
      return;
    }

    const started = Date.now();
    // Stopped BEFORE finishCronJob so a late renewal cannot revive the
    // cleared lease.
    const heartbeat = startCronLeaseHeartbeat(job.id, workerId);
    try {
      // Pass-through (FO firing 15, 2026-09-24): a handler may RETURN a short
      // status string for cron_jobs.lastStatus — session-history-sync computes
      // "synced N, unchanged N, failed N of N, …, no mirror N, skipped N" per
      // pass (its docblock always promised this; the tick previously
      // discarded it and hardcoded 'ok', so the standing audit read
      // session_history_sync_4h = 'ok' with no shape). finishCronJob truncates
      // to 200 chars.
      const ret = await handler();
      heartbeat.stop();
      const status = typeof ret === 'string' && ret.trim() ? ret : 'ok';
      logger.info(`cron loop ${workerId}: job '${job.id}' ok in ${Date.now() - started}ms${status !== 'ok' ? ` (${status})` : ''}`);
      await finishCronJob(job.id, true, status)
        .catch(err => logger.warn(`cron loop ${workerId}: finish(${job.id}) failed: ${err.message}`));
    } catch (err: any) {
      heartbeat.stop();
      logger.error(`cron loop ${workerId}: job '${job.id}' failed after ${Date.now() - started}ms: ${err?.message ?? err}`);
      await finishCronJob(job.id, false, String(err?.message ?? err))
        .catch(fErr => logger.warn(`cron loop ${workerId}: finish(${job.id}) failed: ${fErr.message}`));
    }
  };

  const fire = () => {
    if (ticking || stopped) return; // no re-entrant ticks (a long sweep spans ticks)
    ticking = true;
    void tick().finally(() => { ticking = false; });
  };

  logger.info(`cron loop ${workerId} started (${Object.keys(handlers).length} jobs, tick ${tickMs}ms)`);
  fire(); // claim immediately — a due job (e.g. post-deploy catch-up) shouldn't wait
  const timer = setInterval(fire, tickMs);
  (timer as any).unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      // A handler in flight finishes on its own; if the process exits first the
      // 10-min lease makes the job re-claimable by any live worker.
    },
  };
}
