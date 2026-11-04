/**
 * Turn-continuation recovery helpers (cohesive-chat wave 2026-09-28, review
 * fixes 3 / 4 / 5) — the prisma-backed pieces the pure leaf
 * (turn-continuation.ts) must not carry. Shared by the queue drain
 * (chat-agent.service drainChatQueue), the run finalize, the SIGTERM ritual's
 * consumer (orphan-recovery drainDeployRequeue) and the lost-stash path.
 *
 *   - continuationSupersededByUser: a HUMAN message typed since the task
 *     started — a transcript user row newer than the stash (origin absent or
 *     'user'), or a user row waiting in the chat's queue — supersedes a queued
 *     round: the user's own turn owns the ask now, so the round is dropped and
 *     its card reads waiting_user (CONTINUATION_SUPERSEDED_LINE).
 *   - settleContinuationCard: flip the card on the ORIGINAL row (the human
 *     turn's answer) to a terminal status with one honest line.
 *   - settleLostContinuation: a queued continuation row whose Redis stash is
 *     gone AND whose marker predates the stash fields cannot be re-run
 *     honestly — the chat's newest 'running' continuation card is flipped to
 *     failed so the owner is never left with a card that never settles.
 *   - continuationCardOwed: whether the card on the original row still reads
 *     'running' for this task (the deploy-requeue consumer's "still owed"
 *     check — a card settled meanwhile voids the entry).
 *
 * Every helper is fail-safe: a lookup error reads as "not superseded" / "not
 * owed" / null and never throws into the caller's path.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { buildTaskEvent, emitTaskEvent, persistTaskCard, type TaskStatus } from './task-events';
import { CONTINUATION_FAILED_LINE, CONTINUATION_TASK_TITLE, type ContinuationRun } from './turn-continuation';

const SOURCE = 'continuation-recovery';



export interface ContinuationSupersession {
  /** 'row' = a transcript user row newer than the task; 'queued' = a user row waiting in the chat's queue. */
  kind: 'row' | 'queued';
  id: string;
}

/**
 * The newest HUMAN message that supersedes a continuation of `chatId` whose
 * task started at `since` (null = the human turn itself: only the queue is
 * checked — a transcript row newer than the running turn's own ask cannot
 * exist while it holds the chat). Machine-origin user rows (agent / schedule /
 * webhook / hook sends) never supersede — only the human does.
 */
export async function continuationSupersededByUser(chatId: string, since: Date | null): Promise<ContinuationSupersession | null> {
  try {
    if (since && Number.isFinite(since.getTime())) {
      const rows = await prisma.crossModelMessage.findMany({
        where: { chatId, role: 'user', createdAt: { gt: since } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, metadata: true },
      });
      for (const r of rows) {
        const origin = (r.metadata as { origin?: unknown } | null)?.origin;
        if (origin === undefined || origin === null || origin === 'user') return { kind: 'row', id: r.id };
      }
    }
    const queued = await prisma.pendingChatMessage.findFirst({
      where: { chatId, source: 'user' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    return queued ? { kind: 'queued', id: queued.id } : null;
  } catch (err: any) {
    logger.warn(`${SOURCE}: supersession check failed for ${chatId.slice(0, 8)} (reads as not superseded): ${err?.message ?? err}`, { source: SOURCE });
    return null;
  }
}

/** Flip the task card on the original row to a terminal status (persist + live emit). Never throws. */
export async function settleContinuationCard(
  chatId: string,
  stash: Pick<ContinuationRun, 'taskId' | 'ofMessageId' | 'startedAt'>,
  status: Exclude<TaskStatus, 'running'>,
  note: string,
  extra: { resultMessageId?: string } = {},
): Promise<void> {
  try {
    const payload = buildTaskEvent({
      taskId: stash.taskId, chatId, kind: 'continuation', status, title: CONTINUATION_TASK_TITLE, startedAt: stash.startedAt, note,
      ...(extra.resultMessageId ? { resultMessageId: extra.resultMessageId } : {}),
    });
    await persistTaskCard(chatId, payload, { messageId: stash.ofMessageId });
    emitTaskEvent(chatId, payload);
  } catch (err: any) {
    logger.warn(`${SOURCE}: card settle (${status}) failed for ${chatId.slice(0, 8)} / ${stash.taskId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
  }
}

/** True while the card on the original row still reads 'running' for this task. A missing row / other task / settled card ⇒ false. */
export async function continuationCardOwed(chatId: string, stash: Pick<ContinuationRun, 'taskId' | 'ofMessageId'>): Promise<boolean> {
  try {
    const row = await prisma.crossModelMessage.findUnique({ where: { id: stash.ofMessageId }, select: { chatId: true, metadata: true } });
    if (!row || row.chatId !== chatId) return false;
    const task = (row.metadata as { task?: { taskId?: unknown; status?: unknown } } | null)?.task;
    return !!task && task.taskId === stash.taskId && task.status === 'running';
  } catch {
    return false;
  }
}

/**
 * A queued continuation row that can no longer be re-run honestly (stash gone,
 * no marker fields): settle the chat's newest RUNNING continuation card as
 * failed. Returns the settled taskId, or null when no such card exists.
 */
export async function settleLostContinuation(chatId: string): Promise<string | null> {
  try {
    const row = await prisma.crossModelMessage.findFirst({
      where: { chatId, role: 'assistant', metadata: { path: ['task', 'status'], equals: 'running' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, metadata: true, parts: true },
    });
    const task = (row?.metadata as { task?: { taskId?: unknown; kind?: unknown } } | null)?.task;
    if (!row || !task || task.kind !== 'continuation' || typeof task.taskId !== 'string') return null;
    // Keep the card's own startedAt (the part carries the full payload; the metadata copy is compact).
    const part = Array.isArray(row.parts) ? (row.parts as Array<{ type?: unknown; task?: { taskId?: unknown; startedAt?: unknown } }>).find((p) => p?.type === 'task' && p.task?.taskId === task.taskId) : undefined;
    const startedAt = typeof part?.task?.startedAt === 'string' ? part.task.startedAt : new Date().toISOString();
    await settleContinuationCard(chatId, { taskId: task.taskId, ofMessageId: row.id, startedAt }, 'failed', CONTINUATION_FAILED_LINE);
    return task.taskId;
  } catch (err: any) {
    logger.warn(`${SOURCE}: lost-stash settle failed for ${chatId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    return null;
  }
}
