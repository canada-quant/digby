/**
 * Deploy-interrupt ritual for detached chat runs (feedback 56159c5a).
 *
 * THE BUG: a blue-green deploy tears the old color down a fixed 60s after the
 * nginx flip. Detached chat runs live in the web process (no durable state —
 * the user row persists at run start, the assistant row only at finalize), so
 * every in-flight chat turn died SILENTLY: no assistant row, no honest error,
 * and the orphan sweeper's 5-min grace meant the owner stared at an unanswered
 * question (or re-asked by hand) several times a day.
 *
 * THE RITUAL (SIGTERM, server.ts gracefulShutdown): for every ACTIVE chat run
 * on this instance —
 *   1. telemetry: loop_metrics kind chat_run_interrupted { reason:'deploy' };
 *   2. the run's unanswered turn is RPUSHed onto the durable Redis requeue
 *      list (DEPLOY_REQUEUE_KEY) — Redis lives in its OWN container and
 *      survives the teardown, so the incoming color's boot-drain
 *      (orphan-recovery drainDeployRequeue) re-fires the turn within seconds;
 *   3. an honest ASSISTANT row is persisted in the chat ("interrupted by a
 *      deploy — re-running"), so the user is never left staring at a dead
 *      question. Its metadata.origin 'deploy-interrupt' +
 *      interruptedMessageId is what the backstop (orphan-recovery Rule C)
 *      watches: even if the RPUSH itself was lost (Redis hiccup mid-ritual),
 *      the turn still re-fires one grace later.
 *   4. SOFT CHECKPOINT (ticket 5ba5f03e): the run's receipt-backed progress
 *      (what it ALREADY executed, from run_tool_receipts — scoped to this
 *      run's own start) is harvested into a bounded brief riding BOTH the
 *      requeue entry and the interrupt row's metadata. The re-fired turn is
 *      told to CONTINUE the work, not repeat completed side effects — the
 *      from-scratch re-run duplicated them (wasted tokens, double-sent
 *      messages, a lane ledger hand-corrected 130→74). Best-effort: no
 *      receipts (or a failed harvest) means no brief, never a blocked ritual.
 *
 * REQUEUE CONSUMER IDEMPOTENCY (the completing-run race): the ritual runs
 * while the doomed runs are still executing — a run may legitimately FINISH
 * (writing its real answer) after the ritual snapshotted it. The consumer
 * therefore re-checks the chat's LATEST row before re-firing and only fires
 * when it is still the referenced user row (or this interrupt row referencing
 * it); a real answer that landed meanwhile voids the entry.
 *
 * REPEATED INTERRUPTS: when the latest row is ALREADY a deploy-interrupt row
 * (the re-fired run died to the next deploy before answering), the ritual
 * re-queues the SAME referenced message without stacking a second notice row.
 * The shared recovery budget (orphan-recovery MAX_RECOVERY_ATTEMPTS) bounds
 * crash loops, after which the existing escalation path tells the owner once.
 *
 * Anonymous (chat:session:) / ephemeral runs have NO durable transcript rows —
 * they get telemetry only; their clients already surface a failure and resend.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { listActiveRunIds, runStartedAt, getRunMeta } from '../coding/live-runs';
import { recordLoopMetric, flushLoopMetrics, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { getRecentChatReceipts } from '../coding/run-receipts.service';
import { buildResumeBrief, type DeployResumeBrief } from './deploy-resume-brief';
import type { ContinuationRun } from './turn-continuation';

/** metadata.origin stamped on the honest interrupt row — Rule C watches it. */
export const DEPLOY_INTERRUPT_ORIGIN = 'deploy-interrupt';

/** The durable cross-deploy handoff list (Redis survives the web teardown). */
export const DEPLOY_REQUEUE_KEY = 'cm:deploy:requeue';

/** Requeue entries older than this are dropped unanswered (the orphan
 *  escalation path owns ancient cases; the list must never grow forever). */
export const REQUEUE_ENTRY_TTL_MS = 2 * 60 * 60 * 1000;

export interface DeployRequeueEntry {
  chatId: string;
  /** the UNANSWERED user-row id the dead run was answering */
  userMessageId: string;
  reason: 'deploy';
  at: string; // ISO wall-clock of the interrupt
  /**
   * SOFT CHECKPOINT (ticket 5ba5f03e): the receipt-backed list of what the
   * interrupted run ALREADY executed, harvested from run_tool_receipts at the
   * interrupt instant. Rides the entry to the re-fired run, which is told to
   * CONTINUE the turn (not repeat completed side effects) instead of the old
   * from-scratch re-run that duplicated them. Absent when the run had no
   * consequential executions yet (or the harvest failed — best-effort).
   */
  resume?: DeployResumeBrief;
  /**
   * Audit 2026-09-26 (routing-unify-4 / sse-ui-restore-1 / tests-gaps-1): a
   * Dig-deeper rung run cut by the deploy. `userMessageId` is then the
   * ORIGINAL question's user row (the row the escalated answer answered); the
   * consumer re-fires the RUNG against `escalation.ofMessageId` — never a
   * plain re-ask of the question text.
   */
  escalation?: { ofMessageId: string; rung: 'verify' | 'research' };
  /**
   * Turn continuation (cohesive-chat wave 2026-09-28, review fix 3): a
   * background continuation ROUND cut by the deploy. Its chat's latest row is
   * the rewritten answer (a round persists no user row), so the plain shape
   * would read it as "answered" and drop it — the card on the original row
   * then said "running" forever. `userMessageId` is the human ask's row when
   * the stash knows it, else the original answer row (never read as a user
   * row by the consumer); the consumer re-queues the SAME round (stash +
   * prompt + mode) through the chat's queue, or settles the card.
   */
  continuation?: { stash: ContinuationRun; prompt: string; mode: string };
}

/** True for the honest interrupt row's metadata shape (Rule C + consumers). */
export function isDeployInterruptMeta(meta: unknown): boolean {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  const m = meta as Record<string, unknown>;
  return m.origin === DEPLOY_INTERRUPT_ORIGIN && typeof m.interruptedMessageId === 'string' && !!m.interruptedMessageId;
}

const INTERRUPT_CONTENT =
  '⚠️ **This turn was interrupted by a deploy** — the server answering your message was replaced mid-run. ' +
  'Re-running your message on the new server now…';

/** Receipt-harvest guards (ticket 5ba5f03e): the window starts at the run's
 *  own start (a prior turn's receipts must never leak into THIS turn's brief)
 *  with a small clock-skew pad, and is capped so a pathological startedAt can
 *  never widen the read. */
const RESUME_HARVEST_SKEW_MS = 5_000;
const RESUME_HARVEST_MAX_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * Harvest the interrupted run's receipt-backed progress into a soft-checkpoint
 * brief. BEST-EFFORT by contract: the ritual is raced against an 8s shutdown
 * budget and a failed/slow/empty harvest must never block or delay a requeue
 * — null simply means the re-fire runs exactly as it did before the fix.
 * Precision beats recall: only ok-receipts scoped to THIS run's lifetime make
 * the brief (a tool call still in flight at SIGTERM leaves no receipt and is
 * redone — the pre-fix behavior, never a regression).
 */
async function harvestResumeBrief(chatId: string, runKey: string): Promise<DeployResumeBrief | null> {
  try {
    const startedAt = runStartedAt(runKey);
    if (!startedAt) return null;
    const windowMs = Math.min(Date.now() - startedAt + RESUME_HARVEST_SKEW_MS, RESUME_HARVEST_MAX_WINDOW_MS);
    if (windowMs <= 0) return null;
    return buildResumeBrief(await getRecentChatReceipts(chatId, windowMs));
  } catch {
    return null;
  }
}

/**
 * The SIGTERM ritual. Best-effort per run (one bad chat must never block the
 * others) and bounded by the CALLER (server.ts races it against an 8s budget —
 * docker's stop grace is 30s and the forced exit fires at 25s). Ends with an
 * AWAITED loop-metrics flush: the buffer's 2s micro-batch would otherwise die
 * with the process and take the very telemetry this exists to emit with it.
 */
export async function interruptActiveChatRunsForShutdown(reason: 'deploy' = 'deploy'): Promise<void> {
  const keys = listActiveRunIds().filter((k) => k.startsWith('chat:'));
  if (!keys.length) return;
  logger.warn(`deploy-interrupt: ${keys.length} active chat run(s) on this instance — persisting interrupt rows + requeue entries (${reason})`);
  let requeued = 0;
  for (const key of keys) {
    try {
      // Telemetry for EVERY active chat-shaped run (session/ephemeral included).
      const chatId = key.startsWith('chat:session:') || key.startsWith('chat:ephemeral:') ? null : key.slice('chat:'.length);
      // WI-G (2026-09-25): the row also names WHAT was cut — a supervisor-class
      // machine wake vs anything else, and how long it had run — so the
      // fleet-telemetry 'deploy' view (deployInterrupts24h) can say whether
      // the drain budget / retire nudge are reaching the runs that matter.
      // Registry reads are best-effort (a mocked/absent registry adds nothing).
      let interruptedRun: Record<string, unknown> = {};
      let escalation: { ofMessageId: string; rung: 'verify' | 'research' } | null = null;
      let continuation: { stash: ContinuationRun; prompt: string; mode: string } | null = null;
      try {
        const m = getRunMeta(key);
        const startedAt = runStartedAt(key);
        if (m.escalation && typeof m.escalation.ofMessageId === 'string' && (m.escalation.rung === 'verify' || m.escalation.rung === 'research')) escalation = m.escalation;
        if (m.continuation && m.continuation.stash && typeof m.continuation.stash.taskId === 'string' && typeof m.continuation.stash.ofMessageId === 'string' && typeof m.continuation.prompt === 'string') {
          continuation = { stash: m.continuation.stash as ContinuationRun, prompt: m.continuation.prompt, mode: String(m.continuation.mode || 'thinking') };
        }
        interruptedRun = {
          ...(m.isSupervisorWake !== undefined ? { isSupervisorWake: m.isSupervisorWake === true } : {}),
          ...(m.machineTriggered !== undefined ? { machineTriggered: m.machineTriggered === true } : {}),
          ...(startedAt ? { runAgeSeconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)) } : {}),
          ...(escalation ? { escalationRung: escalation.rung, escalationOf: escalation.ofMessageId } : {}),
          ...(continuation ? { continuationRound: continuation.stash.round, continuationTaskId: continuation.stash.taskId } : {}),
        };
      } catch { /* telemetry detail only */ }
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.CHAT_RUN_INTERRUPTED,
        sessionId: chatId ?? undefined,
        meta: { reason, runKey: key, ...(chatId ? { chatId } : {}), ...interruptedRun },
        stamp: { profile: 'chat' },
      });
      if (!chatId) continue; // anonymous/ephemeral — no durable transcript to requeue
      // A Dig-deeper rung (audit 2026-09-26): its chat's latest row is the
      // ESCALATED answer (an escalation persists no user row), so the shape
      // below would have read it as "answered" and dropped it silently — the
      // quota slot spent, the chip still offering the same rung. It is
      // re-queued as an ESCALATION and the original row's ledger reads
      // 'interrupted'.
      if (escalation) {
        const orig = await prisma.crossModelMessage.findUnique({ where: { id: escalation.ofMessageId }, select: { id: true, chatId: true, createdAt: true, metadata: true } }).catch(() => null);
        const question = orig && orig.chatId === chatId
          ? await prisma.crossModelMessage.findFirst({ where: { chatId, role: 'user', createdAt: { lte: orig.createdAt } }, orderBy: { createdAt: 'desc' }, select: { id: true } }).catch(() => null)
          : null;
        if (orig && question) {
          const entry: DeployRequeueEntry = { chatId, userMessageId: question.id, reason, at: new Date().toISOString(), escalation };
          const pushed = await redisClient.rPush(DEPLOY_REQUEUE_KEY, JSON.stringify(entry)).then(() => true).catch(() => false);
          if (!pushed) logger.warn(`deploy-interrupt: escalation requeue RPUSH failed for chat ${chatId} (rung ${escalation.rung} of ${escalation.ofMessageId})`);
          // The ledger reads 'interrupted' until the re-fire lands (a re-tap is refused meanwhile; the chip can say so).
          try {
            const meta = (orig.metadata && typeof orig.metadata === 'object') ? orig.metadata as Record<string, any> : {};
            const depth = (meta.depth && typeof meta.depth === 'object') ? meta.depth : {};
            const list = Array.isArray(depth.escalations) ? depth.escalations : [];
            const idx = list.findIndex((e: any) => e?.rung === escalation!.rung && e?.status !== 'done');
            const stamped = idx >= 0 ? list.map((e: any, k: number) => (k === idx ? { ...e, status: 'interrupted', at: entry.at } : e)) : [...list, { rung: escalation.rung, at: entry.at, status: 'interrupted' }];
            await prisma.crossModelMessage.update({ where: { id: orig.id }, data: { metadata: { ...meta, depth: { ...depth, escalations: stamped } } as any } });
          } catch (err: any) { logger.warn(`deploy-interrupt: escalation interrupted-stamp failed for ${orig.id}: ${err?.message ?? err}`); }
          requeued += 1;
        }
        continue;
      }
      // A turn-continuation ROUND (review fix 3): its chat's latest row is the
      // rewritten answer (a round persists no user row), so the shape below
      // would read it as answered and drop it — leaving the card on the
      // original row "running" forever. It is re-queued AS A CONTINUATION
      // (the same stash + prompt + mode; the consumer re-enqueues it through
      // the chat's queue or settles the card).
      if (continuation) {
        const entry: DeployRequeueEntry = {
          chatId, userMessageId: continuation.stash.askMessageId ?? continuation.stash.ofMessageId, reason, at: new Date().toISOString(), continuation,
        };
        const pushed = await redisClient.rPush(DEPLOY_REQUEUE_KEY, JSON.stringify(entry)).then(() => true).catch(() => false);
        if (!pushed) logger.warn(`deploy-interrupt: continuation requeue RPUSH failed for chat ${chatId} (round ${continuation.stash.round} of task ${continuation.stash.taskId})`);
        else requeued += 1;
        continue;
      }
      // The run's unanswered turn = the chat's LATEST row when it is a user
      // row; an already-present deploy-interrupt row re-queues its referenced
      // message (repeated interrupts, no second notice). Anything else means
      // the turn is answered — nothing to do.
      const latest = await prisma.crossModelMessage.findFirst({
        where: { chatId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, role: true, metadata: true },
      });
      let userMessageId: string | null = null;
      let writeRow = false;
      if (latest?.role === 'user') {
        userMessageId = latest.id;
        writeRow = true;
      } else if (latest && isDeployInterruptMeta(latest.metadata)) {
        userMessageId = (latest.metadata as Record<string, unknown>).interruptedMessageId as string;
      }
      if (!userMessageId) continue;
      const resume = await harvestResumeBrief(chatId, key);
      const entry: DeployRequeueEntry = { chatId, userMessageId, reason, at: new Date().toISOString(), ...(resume ? { resume } : {}) };
      const pushed = await redisClient.rPush(DEPLOY_REQUEUE_KEY, JSON.stringify(entry)).then(() => true).catch(() => false);
      if (!pushed) {
        // The DB-row backstop (orphan-recovery Rule C) still owns this turn —
        // the honest interrupt row below is what it watches.
        logger.warn(`deploy-interrupt: requeue RPUSH failed for chat ${chatId} (msg ${userMessageId}) — Rule C backstop owns the re-fire`);
      }
      if (writeRow) {
        await prisma.crossModelMessage.create({
          data: {
            chatId,
            role: 'assistant',
            content: INTERRUPT_CONTENT,
            // The brief rides the row too: the Rule-C backstop re-fire path
            // (RPUSH lost) forwards it exactly like the drain path does.
            // (as any: the optional-resume spread carries `| undefined` in the
            // type, which InputJsonValue rejects — the key is absent at runtime.)
            metadata: { origin: DEPLOY_INTERRUPT_ORIGIN, interruptedMessageId: userMessageId, reason, at: entry.at, ...(resume ? { resume } : {}) } as any,
          },
        }).catch((err: any) => logger.warn(`deploy-interrupt: interrupt row persist failed for chat ${chatId}: ${err?.message ?? err}`));
      }
      requeued += 1;
    } catch (err: any) {
      logger.warn(`deploy-interrupt: ritual failed for run ${key}: ${err?.message ?? err}`);
    }
  }
  await flushLoopMetrics().catch(() => {});
  logger.warn(`deploy-interrupt: ritual complete — ${requeued}/${keys.length} run(s) requeued for the incoming color`);
}
