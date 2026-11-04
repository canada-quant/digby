/**
 * Digby Code — durable agent-run CLAIM (durability Phase 2, worker tier).
 *
 * The worker polls claimNextRun(): one atomic transaction SELECTs the oldest
 * claimable row FOR UPDATE SKIP LOCKED (multi-worker safe — blue+green overlap
 * or replicas) and flips it to 'running' with a fresh lease + attempts+1.
 *
 * Claimable shapes (see docs/archive/coding-worker-tier-phase2.md):
 *   queued (+ not-before passed)         — POSTed, not yet picked up; a
 *                                          lock-contention requeue sets
 *                                          leaseExpiresAt = now+15s as a
 *                                          NOT-BEFORE so the row can't spin
 *   interrupted                          — deploy/restart survival: resume when
 *                                          a checkpoint exists, else cold-retry
 *   running + expired lease              — the claiming worker crashed mid-run
 *
 * Attempt accounting (feedback d64f6f08): the claim normally burns one attempt
 * (attempts+1). A priorAttemptCrashed claim whose worker GENERATION changed
 * (workerGenerationOf — the docker container id, so a deploy/bounce) is
 * COMPENSATED instead (no increment — the run did nothing wrong; same doctrine
 * as requeueRun's H1 and finalizeAgentRunShutdownInterrupted), while a
 * same-generation re-claim (in-place docker restart / crash loop) keeps the
 * increment so crash loops stay bounded by ATTEMPTS_CAP.
 *
 * classifyClaim() is the PURE row-shape → action mapping; the executor calls it
 * BEFORE acquiring the session run-lock (an over-cap row fails without ever
 * touching the lock). attempts > ATTEMPTS_CAP always fails.
 */

import prisma from '../../../config/database';
import { Prisma } from '@prisma/client';
import logger from '../../../utils/logger';
import { ATTEMPTS_CAP, LEASE_MS, RunCheckpoint, RunInput, appendAttemptCause, isResumableCheckpoint } from './run-state';
import { LOOP_METRIC_KINDS, recordLoopMetric } from '../platform/loop-metrics.service';

export type ClaimKind = 'resume' | 'fresh' | 'fail';

export interface ClaimedRun {
  id: string;
  sessionId: string;
  /** The row's status as SELECTed (before the claim flipped it to 'running'). */
  preStatus: string;
  checkpoint: RunCheckpoint | null;
  input: RunInput | null;
  attempts: number;
  /** True once the executor persisted the user message (idempotent insert). */
  inputConsumed: boolean;
  /**
   * The attempt-failure cause chain recorded so far (agent_runs.error as of
   * this claim, including any lease-loss stamp the claim itself just wrote —
   * overnight forensics fix 4). The executor's give-up path composes
   * 'attempts exhausted: <this>' from it, and its finalizes APPEND onto it.
   */
  lastError: string | null;
  /** Durable FIRST-claim timestamp (P0 L13 — stamped once, preserved on
   *  re-claims). Deadline anchor: a worker-restart re-claim must inherit the
   *  run's elapsed wall clock, not restart it (2026-09-09 watcher jam).
   *  Optional for test builders; absent ⇒ the attempt keeps its full budget. */
  startedAt?: Date | null;
  /** Queue timestamp (todo 89df978b, observe-only): the row's createdAt —
   *  createdAt → first startedAt is the run's queue wait (RUN_QUEUE_WAIT).
   *  Optional for test builders. */
  createdAt?: Date | null;
}

/**
 * PURE row-shape → action mapping:
 *   queued      → checkpoint ? resume (adopted at queue time) : fresh (from input)
 *   interrupted → checkpoint ? resume : input ? fresh : fail
 *                 (H2: a worker SIGTERM before the first checkpoint finalizes
 *                 'interrupted' with a NULL checkpoint — cold-restart from the
 *                 input; a row with neither can't do anything → fail, which
 *                 also un-bricks the session)
 *   running     → stale lease: checkpoint ? resume (crash recovery) : input ?
 *                 fresh (crashed before the first checkpoint → restart cold) :
 *                 fail (same no-input safety net)
 *   attempts > ATTEMPTS_CAP → fail, regardless of shape.
 */
export function classifyClaim(row: { preStatus: string; checkpoint: unknown; input?: unknown; attempts: number }): ClaimKind {
  if (row.attempts > ATTEMPTS_CAP) return 'fail';
  // agent-decisions prerequisite 6 (2026-09-27): only a transcript-bearing,
  // non-terminal checkpoint resumes — a trimmed TERMINAL summary (run-state
  // trimTerminalCheckpoint; never on a claimable status by construction) reads
  // as "no checkpoint" here rather than as a resumable transcript.
  const resumable = isResumableCheckpoint(row.checkpoint);
  switch (row.preStatus) {
    case 'queued':
      return resumable ? 'resume' : 'fresh';
    case 'interrupted':
      return resumable ? 'resume' : row.input ? 'fresh' : 'fail';
    case 'running':
      return resumable ? 'resume' : row.input ? 'fresh' : 'fail';
    default:
      return 'fail';
  }
}

/** Worker generation = the hostname segment of worker-<hostname>-<pid> (the docker
 *  container id). It changes on container recreate (blue-green deploy/bounce) but
 *  survives an in-place docker restart (worker crash-loop) — exactly the line
 *  between "the run did nothing wrong" and "the run's worker keeps dying". */
export function workerGenerationOf(workerId: string | null | undefined): string | null {
  const m = /^worker-(.+)-(\d+)$/.exec(workerId ?? '');
  return m ? m[1] : null;
}

/** Raw claim row shape (DB column names — see the Phase-1 migration SQL). */
interface ClaimRow {
  id: string;
  sessionId: string;
  status: string;
  checkpoint: unknown;
  input: unknown;
  inputConsumedAt: Date | null;
  attempts: number;
  error: string | null;
  finishedAt: Date | null;
  workerId: string | null;
  startedAt: Date | null;
  createdAt: Date | null;
}

/**
 * Claim the oldest claimable run for `workerId`. Returns null when the queue
 * is empty. The SELECT ... FOR UPDATE SKIP LOCKED + the update happen in ONE
 * interactive transaction, so concurrent workers never claim the same row.
 *
 * Predicates (H1/H2):
 *  - queued: only when its NOT-BEFORE passed — a fresh row carries
 *    leaseExpiresAt NULL (immediately claimable); a lock-contention requeue
 *    sets it to now+15s (backoff — the row can't spin claim→lock-fail→requeue
 *    burning attempts against a long-running run of the same session);
 *  - interrupted: UNCONDITIONED — every interrupted row is claimable (H2: a
 *    NULL-checkpoint one cold-restarts or fails instead of bricking);
 *  - running: only with an expired lease (the claiming worker is gone).
 */
/** Claim transaction bounds (hardening loop iteration 10, 2026-09-24): prod
 *  logged 13 "Unable to start a transaction in the given time" claim failures
 *  in one day, clustered in the deploy-drain hours when two or three workers
 *  overlap — Prisma's default maxWait is 2 s. The claim is SKIP LOCKED and
 *  cheap once started; waiting a little longer for a pool slot beats losing a
 *  claim tick. Env-tunable. */
const CLAIM_TXN_MAX_WAIT_MS = () => Math.max(2_000, Number(process.env.RUN_CLAIM_TXN_MAX_WAIT_MS) || 10_000);
const CLAIM_TXN_TIMEOUT_MS = () => Math.max(5_000, Number(process.env.RUN_CLAIM_TXN_TIMEOUT_MS) || 30_000);

export async function claimNextRun(workerId: string, opts?: { interactiveOnly?: boolean }): Promise<ClaimedRun | null> {
  // Run queue wait (todo 89df978b, observe-only): captured by the transaction
  // below into this holder — the metric fires AFTER the transaction commits
  // (never inside it: a telemetry write must not ride the claim's FOR UPDATE
  // window). A first claim (pre-claim startedAt NULL) is the only one whose
  // createdAt→startedAt gap is a queue wait; a re-claim inherits the original
  // startedAt and records nothing. A holder object, not a bare let: the
  // assignment happens inside the transaction closure, which TS's control-flow
  // analysis won't propagate back to the post-commit read.
  const queueWait: { ctx: { sessionId: string; waitMs: number; origin: string | null; preStatus: string } | null } = { ctx: null };
  const claimedRun = await prisma.$transaction(async tx => {
    // INTERACTIVE PRIORITY (2026-08-26, owner report: user messages sat queued
    // 12-18min behind hours-long machine runs — all worker slots FIFO'd to
    // schedule/batch work). Two levers: (1) user-origin rows (origin='user' or
    // absent = legacy user sends) always claim BEFORE machine rows
    // (schedule/hook/agent/webhook), FIFO within each class; (2) the worker
    // reserves its last slot for interactive runs via interactiveOnly.
    // Owner-dispatch (2026-10-01, platform/agent-send-header.ts): an agent row
    // sendChatMessage stamped ownerDispatch + an owner anchor is a USER run —
    // it may take the reserved last slot and claims with the user class. The
    // SAME predicate as isOwnerDispatchRun (origin agent + flag + anchor).
    const ownerDispatchRow = Prisma.sql`(input->>'origin' = 'agent' AND input->>'ownerDispatch' = 'true' AND input->>'userTurnAt' IS NOT NULL)`;
    const interactiveFilter = opts?.interactiveOnly
      ? Prisma.sql`AND (input->>'origin' = 'user' OR input->>'origin' IS NULL OR input IS NULL OR ${ownerDispatchRow})`
      : Prisma.empty;
    const ownerDispatchRank = Prisma.sql`WHEN ${ownerDispatchRow} THEN 0 `;
    // DURABLE SESSION MUTEX (autonomy loop #14, 2026-09-21): never claim a row
    // whose session already has ANOTHER run executing with a live lease. The
    // Redis run-lock is the fast mutex, but it is evictable (allkeys-lru at the
    // 256 MB cap) and flushed by a Redis restart — session 82656032 ran three
    // runs at once on one worktree (21:28–22:30Z 2026-09-20) after its lock
    // vanished. The lease is heartbeated every 2.5 min for the whole run, so a
    // live run always shows a fresh lease; a dead one lapses and its row is
    // re-claimable by the stale-running branch below as before.
    const sessionMutex = Prisma.sql`AND NOT EXISTS (
           SELECT 1 FROM "agent_runs" r2
           WHERE r2."sessionId" = "agent_runs"."sessionId"
             AND r2.id <> "agent_runs".id
             AND r2.status = 'running'
             AND r2."leaseExpiresAt" > now())`;
    const rows = await tx.$queryRaw<ClaimRow[]>`
      SELECT * FROM "agent_runs"
      WHERE ((status = 'queued' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now()))
         OR status = 'interrupted'
         OR (status = 'running' AND "leaseExpiresAt" < now()))
      ${interactiveFilter}
      ${sessionMutex}
      ORDER BY (CASE ${ownerDispatchRank}WHEN input->>'origin' IN ('schedule','hook','agent','webhook') THEN 1 ELSE 0 END), "createdAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    const claimed = rows[0];
    if (!claimed) return null;
    const now = new Date();
    // Run queue wait (todo 89df978b): snapshot the PRE-claim timestamps before
    // the update stamps startedAt — a first claim (startedAt null here) is the
    // only one whose createdAt→startedAt gap is a queue wait.
    const preClaimCreatedAt = claimed.createdAt ?? null;
    const preClaimStartedAt = claimed.startedAt ?? null;
    if (!preClaimStartedAt && preClaimCreatedAt) {
      queueWait.ctx = {
        sessionId: claimed.sessionId,
        waitMs: Math.max(0, now.getTime() - preClaimCreatedAt.getTime()),
        origin: (claimed.input as unknown as RunInput | null)?.origin ?? null,
        preStatus: claimed.status,
      };
    }
    // Overnight forensics (fix 4): a claim of a stale-'running' row — or of an
    // 'interrupted' row with NO finishedAt (crash-adopted by a reconcile sweep,
    // never gracefully finalized) — means the PREVIOUS attempt died with no
    // live finalizer to record its cause. Stamp that as the attempt's terminal
    // error, APPENDED onto whatever earlier attempts recorded (first cause
    // preserved), so the eventual 'attempts exhausted' give-up can name it.
    // claimed.attempts is the pre-increment value = the attempt that died.
    const priorAttemptCrashed = claimed.status === 'running'
      || (claimed.status === 'interrupted' && !claimed.finishedAt);
    // Worker-replacement compensation (feedback d64f6f08): when the crashed
    // attempt's worker GENERATION differs from this worker's, the attempt died
    // of a deploy/bounce (the docker container was recreated), not of a run
    // fault — the claim is ATTEMPT-NEUTRAL (no increment). TRANSFER semantics:
    // priorAttemptCrashed guarantees the previous attempt's +1 was never
    // refunded (no finalizer ran), so exactly one stranded charge sits on the
    // row; skipping this increment TRANSFERS it to the new live attempt. Every
    // refund site (requeueRun, finalizeAgentRunShutdownInterrupted) therefore
    // stays UNCONDITIONAL — a compensated claim that later earns a refund
    // returns the stranded charge, not an unearned one (each claim reaches at
    // most one refund site, so it can never over-refund). Same-generation
    // re-claims (in-place docker restart = worker crash-loop) keep the
    // increment so crash loops stay bounded by ATTEMPTS_CAP; a NULL prior
    // workerId is unprovable and also keeps it.
    const generationChanged = claimed.workerId != null
      && workerGenerationOf(claimed.workerId) !== workerGenerationOf(workerId);
    const workerReplaced = priorAttemptCrashed && generationChanged;
    if (workerReplaced) {
      logger.warn(`claimNextRun: run ${claimed.id} (session ${claimed.sessionId}) lost its worker to a worker replacement (${claimed.workerId} → ${workerId}) — attempt compensated (no increment)`);
    }
    const updated = await tx.agentRun.update({
      where: { id: claimed.id },
      data: {
        status: 'running',
        workerId,
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        // startedAt (remediation P0 item L13): queued rows are created WITHOUT
        // it (only the legacy in-process createAgentRun stamped it), so every
        // worker-claimed run carried NULL startedAt forever. First claim
        // stamps it; a re-claim of a crashed attempt keeps the original.
        ...(claimed.startedAt ? {} : { startedAt: now }),
        ...(!workerReplaced ? { attempts: { increment: 1 } } : {}),
        ...(priorAttemptCrashed
          ? {
            error: appendAttemptCause(
              claimed.error,
              workerReplaced
                ? `attempt ${claimed.attempts} lost its worker to a worker replacement (worker generation changed — deploy/bounce, not a run fault); attempt compensated`
                : `attempt ${claimed.attempts} lost its worker (lease expired with no finalizer — process crash/OOM, hang, or a harness exception)`,
            ),
          }
          : {}),
      },
    });
    return {
      id: updated.id,
      sessionId: updated.sessionId,
      preStatus: claimed.status,
      checkpoint: isResumableCheckpoint(updated.checkpoint) ? (updated.checkpoint as unknown as RunCheckpoint) : null,
      input: (updated.input as unknown as RunInput) ?? null,
      attempts: updated.attempts,
      inputConsumed: !!updated.inputConsumedAt,
      lastError: updated.error ?? null,
      startedAt: updated.startedAt ?? null,
      // Run queue wait (todo 89df978b, observe-only): createdAt → first
      // startedAt is the time this run spent queued before a worker picked it
      // up. Only meaningful on the FIRST claim (a re-claim inherits the
      // original startedAt); the RUN_QUEUE_WAIT metric itself is recorded by
      // claimNextRun AFTER the transaction commits.
      createdAt: claimed.createdAt ?? null,
    };
  }, { maxWait: CLAIM_TXN_MAX_WAIT_MS(), timeout: CLAIM_TXN_TIMEOUT_MS() });
  // RUN_QUEUE_WAIT (todo 89df978b, observe-only): one row per FIRST claim —
  // queued createdAt → first startedAt, the fair-queuing input (a user turn
  // queued behind a long machine run is exactly the latency a run budget
  // would relieve). Fire-and-forget AFTER the claim transaction committed;
  // total — a telemetry failure must never surface as a claim failure.
  try {
    if (queueWait.ctx) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.RUN_QUEUE_WAIT,
        sessionId: queueWait.ctx.sessionId,
        value: queueWait.ctx.waitMs,
        unit: 'ms',
        meta: { origin: queueWait.ctx.origin, preStatus: queueWait.ctx.preStatus },
      });
    }
  } catch { /* observe-only telemetry must never break a claim */ }
  return claimedRun;
}

/** Lock-contention requeue NOT-BEFORE backoff (rides leaseExpiresAt — see claimNextRun). */
export const REQUEUE_BACKOFF_MS = 15_000;

/**
 * Put a claimed row back to 'queued' (lock-held race: another worker holds the
 * session's Redis run lock, so this worker can't execute it right now).
 *
 * H1: lock contention is NOT an attempt — compensate the claim-time increment
 * (attempts - 1) so a row queued behind a long-running run of the same session
 * never fails 'attempts exhausted' without executing. leaseExpiresAt becomes a
 * NOT-BEFORE (now + 15 s): the claim query's queued branch skips the row until
 * then, so it can't spin claim→lock-fail→requeue every claim tick. Any
 * checkpoint on the row is kept (an adopted/owned checkpoint stays valid).
 *
 * The decrement is UNCONDITIONAL by design (d64f6f08 transfer semantics): when
 * the claim was itself attempt-neutral (worker-replacement compensation — no
 * increment happened), this −1 refunds the STRANDED charge of the prior
 * generation's killed attempt that the compensation transferred onto this
 * claim. Each claim reaches at most one refund site, so it never over-refunds.
 */
export async function requeueRun(runId: string): Promise<void> {
  await requeueRunWithBackoff(runId, REQUEUE_BACKOFF_MS, undefined);
}

/**
 * ff262da5 (todo 4ecfd309, 2026-10-16): admission control for RUNS — put a
 * claimed row back to 'queued' because the shared dev container's memory
 * working set is above the admission threshold (default 85%). Same refund
 * semantics as requeueRun (the memory condition is not the run's fault);
 * notBefore = now + backoff (NOT the default 15 s — a starved container
 * needs minutes, and a 15 s backoff would spin claim→admit-fail every tick,
 * hammering the container with scans), and the LAST deferred reason is
 * stamped on the row so an operator reading the queue sees WHY a run waits
 * (and the 'attempts exhausted' forensics never blame the environment).
 * A custom backoff lets the worker apply an escalating one (bounded).
 */
export async function requeueRunWithBackoff(
  runId: string,
  backoffMs: number,
  reason?: string,
): Promise<void> {
  const backoff = Math.max(1_000, Math.floor(Number(backoffMs) || REQUEUE_BACKOFF_MS));
  await prisma.agentRun.update({
    where: { id: runId },
    data: {
      status: 'queued',
      heartbeatAt: null,
      // requeueRun's L13 rationale verbatim: the claim stamped startedAt but
      // the run never executed — clear it so the row does not read as
      // "running for N min with no heartbeat". The next real claim re-stamps.
      startedAt: null,
      leaseExpiresAt: new Date(Date.now() + backoff),
      workerId: null,
      attempts: { decrement: 1 },
      ...(reason
        ? { error: appendAttemptCause(undefined, reason) }
        : {}),
    },
  });
}
