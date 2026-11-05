/**
 * CHILD RUN FAILURE → PARENT ESCALATION (spark-cluster audit 2026-09-17).
 *
 * Child session 1d39d145 (spawned by lane 28de72e5 for the P3-3/P3-4 legs)
 * died twice on an unreachable pinned endpoint with zero tool calls. The run
 * finalized 'failed' and a run_failed hook event went to the PROJECT
 * supervisor's project-scope hook — but nothing told the PARENT that spawned
 * it, so the parent discovered the corpse by polling and silently took the
 * work back. A spawner is the one actor that can re-dispatch, re-seat or
 * reassign; it must hear about a failed child directly.
 *
 * Here: a MACHINE-triggered run (schedule / hook / agent wake — never a human
 * turn, whose failure the human sees in the UI) that finalizes 'failed' on a
 * chat with a parentChatId wakes that parent ONCE per child per 2 h with a
 * [CHILD RUN FAILED] direct wake naming the child, the cause, and the three
 * honest exits (re-dispatch on a servable model / retry once reachable /
 * reassign or close its todo). Same-owner parents only (per-user gate);
 * archived parents are skipped. Best-effort; never throws into finalize.
 *
 * PLAIN HUMAN PARENT (hand-off polish 2026-09-28, audit CT-4 / DOI-20): the
 * direct wake is the SUPERVISOR-shaped notification — a raw
 * `[MACHINE-TRIGGERED RUN …]` user-role row in a human's plain chat (the
 * same defect the run_completed path fixed in platform/handoff-parent-wake.ts,
 * which the todo_wake self-hook of THIS path bypasses). For a HUMAN-owned
 * NON-supervisor parent the failure is now delivered the way the hand-off
 * delivers a result: ONE honest assistant row on the parent (metadata.kind
 * 'child_run_failed', harness stamp, routed like the hand-off row — chat row
 * for a plain chat, coding transcript for a coding target) and the parent's
 * running SESSION card flipped to FAILED with the cause (preferCarrier; the
 * new row is the fallback anchor) + the live `task` frame; NO direct wake.
 * Supervisor-class parents keep the wake (how they re-dispatch). The 2 h
 * dedupe and the metric are shared; the metric row says `delivery:'card'`
 * and one `handoff_parent_wake_skipped {reason:'failed_card_flipped'}` row
 * is recorded. Fail-open: a row-post failure falls back to the wake.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { recordLoopMetric } from '../platform/loop-metrics.service';

const SOURCE = 'child-failure-escalation';
export const CHILD_FAILURE_DEDUPE_SEC = 2 * 3600;
const DEDUPE_KEY = (childChatId: string) => `child-fail:${childChatId}`;
const id8 = (s: unknown): string => String(s ?? '').slice(0, 8);

/** metadata.kind of the honest failure row on a plain parent. */
export const CHILD_FAILURE_MESSAGE_KIND = 'child_run_failed';
/** metadata.origin of that row — a harness stamp in NO machine-noise set (the row stays visible). */
export const CHILD_FAILURE_MESSAGE_ORIGIN = 'child_failure';

export interface ChildFailureInput {
  chatId: string;
  runId?: string | null;
  cause: string;
  triggerKind: 'user' | 'schedule' | 'hook' | 'machine';
  /**
   * Owner-dispatch (2026-10-01): the run was USER-classified but UNATTENDED
   * (run-executor unattendedRun — a supervisor relayed the owner's own-turn
   * ask). It escalates exactly like a machine run; a watched user run never does.
   */
  unattended?: boolean;
}

export function renderChildFailureWake(child: { id: string; title: string | null }, input: ChildFailureInput): string {
  const cause = String(input.cause ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'no cause recorded';
  const unreachable = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ETIMEDOUT|ECONNRESET)\b/.test(cause);
  return [
    `[CHILD RUN FAILED] Your sub-session ${id8(child.id)} "${String(child.title ?? '').slice(0, 80) || 'untitled'}" (${input.unattended === true && input.triggerKind === 'user' ? 'owner-dispatched' : input.triggerKind} run${input.runId ? ` ${id8(input.runId)}` : ''}) ended FAILED: ${cause}`,
    `No work landed from it. Decide now and cite the receipt in your note: (a) re-dispatch the task with start_coding_session on a model that is servable${unreachable ? ' — the child\'s endpoint is unreachable, so NOT on the same pinned endpoint' : ''}; (b) if the failure was transient, send the child ONE send_chat_message to retry once its provider is reachable; or (c) reassign or close the todo it held (todo_update) and take the work yourself. Do not re-spawn the same child into the same failure, and do not report its task as in progress.`,
  ].join('\n');
}

/**
 * The honest assistant row a PLAIN parent gets instead of the wake (pure):
 * what failed, why, that nothing landed, and what the user can do — never a
 * supervisor instruction, never a worktree path.
 */
export function renderChildFailureRow(child: { id: string; title: string | null }, input: ChildFailureInput): string {
  const title = String(child.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Coding session';
  const cause = String(input.cause ?? '').replace(/\s+/g, ' ').replace(/^Coding run failed:\s*/i, '').trim().slice(0, 300) || 'no cause was recorded';
  return [
    `**Sub-session failed: ${title}**`,
    '',
    `The background run of this sub-session ended without delivering anything — ${cause}`,
    '',
    'Nothing from it landed in this chat. Reply here to retry, change the task, or drop it.',
  ].join('\n');
}

export interface ChildFailureOutcome {
  escalated: boolean;
  /** 'woken' (direct wake) | 'card' (plain parent: honest row + failed card) | a skip reason. */
  reason: string;
  parentChatId?: string;
  /** The honest row's id when delivery was 'card'. */
  messageId?: string;
}

/** Wake the spawner of a failed machine run — or, for a plain human parent, post the honest row + flip its card. */
export async function escalateChildRunFailure(input: ChildFailureInput): Promise<ChildFailureOutcome> {
  if (input.triggerKind === 'user' && input.unattended !== true) return { escalated: false, reason: 'user_run' };
  try {
    const child = await prisma.crossModelChat.findUnique({ where: { id: input.chatId }, select: { id: true, title: true, userId: true, parentChatId: true } });
    if (!child?.parentChatId) return { escalated: false, reason: 'no_parent' };
    const parent = await prisma.crossModelChat.findUnique({
      where: { id: child.parentChatId },
      select: { id: true, userId: true, archivedAt: true, isSupervisor: true, isProjectSupervisor: true },
    });
    if (!parent || parent.userId !== child.userId) return { escalated: false, reason: 'parent_missing_or_foreign' };
    if (parent.archivedAt) return { escalated: false, reason: 'parent_archived' };
    const key = DEDUPE_KEY(child.id);
    if (await (redisClient as any).get(key).catch(() => null)) return { escalated: false, reason: 'deduped', parentChatId: parent.id };

    // ── Plain human parent: the honest row + the failed card, never a machine wake ──
    const plainParent = parent.isSupervisor !== true && parent.isProjectSupervisor !== true;
    if (plainParent) {
      const delivered = await deliverPlainParentFailure(child, parent.id, input).catch((err: any) => {
        logger.warn(`${SOURCE}: plain-parent card delivery failed for ${id8(child.id)} (${err?.message ?? err}) — falling back to the wake`, { source: SOURCE });
        return null;
      });
      if (delivered) {
        await (redisClient as any).set(key, input.runId ?? '1', { EX: CHILD_FAILURE_DEDUPE_SEC }).catch(() => {});
        recordLoopMetric({
          kind: 'handoff_parent_wake_skipped', sessionId: parent.id, value: 1,
          meta: { childChatId: child.id, eventTypes: ['run_failed'], runIds: input.runId ? [input.runId] : [], reason: 'failed_card_flipped', cardFlipped: delivered.cardFlipped ? 1 : 0, source: SOURCE },
        });
        logger.info(`${SOURCE}: child ${id8(child.id)} failed (${input.triggerKind}) — plain parent ${id8(parent.id)} got the honest row ${id8(delivered.messageId)} + ${delivered.cardFlipped ? 'the failed card' : 'no card to flip'} (no wake)`, { source: SOURCE });
        return { escalated: true, reason: 'card', parentChatId: parent.id, messageId: delivered.messageId };
      }
    }

    const { enqueueDirectWake } = await import('../platform/hooks.service');
    const res = await enqueueDirectWake({
      targetChatId: parent.id,
      prompt: renderChildFailureWake(child, input),
      meta: { origin: SOURCE, kind: 'child_run_failed', childChatId: child.id, runId: input.runId ?? null, triggerKind: input.triggerKind },
    });
    if (!res?.ok) return { escalated: false, reason: `wake_failed:${res?.error ?? 'unknown'}`, parentChatId: parent.id };
    await (redisClient as any).set(key, input.runId ?? '1', { EX: CHILD_FAILURE_DEDUPE_SEC }).catch(() => {});
    logger.info(`${SOURCE}: child ${id8(child.id)} failed (${input.triggerKind}) — parent ${id8(parent.id)} woken`, { source: SOURCE });
    return { escalated: true, reason: 'woken', parentChatId: parent.id };
  } catch (err: any) {
    logger.warn(`${SOURCE}: escalation failed for ${id8(input.chatId)} (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    return { escalated: false, reason: 'error' };
  }
}

/**
 * The plain-parent delivery: ONE assistant row (routed by what the target is,
 * through the hand-off's own appendMessage) + the SESSION card flipped to
 * FAILED (preferCarrier — the answer row that spawned the child; the new row
 * is the fallback anchor) + the live `task` frame. null ⇒ the caller falls
 * back to the wake (task card switched off, or no row posted).
 */
async function deliverPlainParentFailure(
  child: { id: string; title: string | null },
  parentChatId: string,
  input: ChildFailureInput,
): Promise<{ messageId: string; cardFlipped: boolean } | null> {
  const handoff = await import('./deliverable-handoff');
  const te = await import('../chat-agent/task-events');
  const cause = String(input.cause ?? '').replace(/\s+/g, ' ').replace(/^Coding run failed:\s*/i, '').trim().slice(0, 300);
  const payload = te.buildTaskEvent({
    taskId: handoff.taskIdForSession(child.id),
    chatId: parentChatId,
    childChatId: child.id,
    kind: 'session',
    status: 'failed',
    title: String(child.title ?? '').trim() || 'Coding session',
    note: cause ? `The sub-session's run failed: ${cause}` : 'The sub-session\'s run failed before it delivered anything.',
  });
  const deps = handoff.defaultHandoffDeps();
  const row = await deps.appendMessage(parentChatId, renderChildFailureRow(child, input), {
    kind: CHILD_FAILURE_MESSAGE_KIND,
    origin: CHILD_FAILURE_MESSAGE_ORIGIN,
    harness: true,
    runId: input.runId ?? null,
    childChatId: child.id,
    sourceChatId: child.id,
    triggerKind: input.triggerKind,
    task: payload,
  });
  if (!row?.id) return null;
  const cardRow = await te.persistTaskCard(parentChatId, payload, { preferCarrier: true, messageId: row.id }).catch(() => null);
  te.emitTaskEvent(parentChatId, payload);
  return { messageId: row.id, cardFlipped: !!cardRow };
}
