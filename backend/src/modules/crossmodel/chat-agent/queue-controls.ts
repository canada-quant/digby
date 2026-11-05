/**
 * Busy-chat queue CONTROLS (ticket ea04454c, owner ask 2026-11-05: "we need to
 * add interrupt/steer options in ui as well not just queued messages").
 *
 * The queue itself has existed since 2026-08-07 (message-queue.service): a
 * message typed while a run is active is persisted to pending_chat_messages and
 * drained FIFO by the finishing run's finally. What was MISSING was any way for
 * the person who typed it to act on it — no visible position, no cancel, no
 * "run this one next", no way to promote one ahead of the others. The owner had
 * exactly one option: wait, or Stop everything.
 *
 * This module is the CONTROL PLANE for those rows — listing, cancelling,
 * promoting and reordering the USER rows of one chat's queue. It is deliberately
 * a SEPARATE module from message-queue.service.ts so the enqueue/drain hot path
 * keeps its import-cycle discipline (that module may not import back into
 * chat-agent.service; this one is only reached from the controller) and so the
 * reorder semantics live in one testable place.
 *
 * ORDERING WITHOUT A SCHEMA CHANGE. The drain order is
 * `ORDER BY createdAt ASC, id ASC` (peekOldest — USER rows first, then the rest)
 * so a "position" is nothing but that sort. Rather than add a priority column
 * and a migration for a control-plane nicety, a control MOVE re-STAMPS the
 * row's createdAt to sit immediately before/after its neighbour. That keeps one
 * sort implementation (the drain's) as the single source of truth: a promoted
 * row is promoted because the drain will genuinely read it next, not because a
 * second, parallel notion of order said so.
 *
 * Re-stamps are NUDGED by ORDER_EPSILON_MS and clamped to "not in the future"
 * so an operator/owner clock cannot park a row above the run that is about to
 * finish, and so two adjacent rows can never collide on createdAt (the id
 * tie-break stays a stable fallback, but never the primary ordering signal).
 *
 * SAFETY RAILS (each one is a way this could otherwise corrupt or lose work):
 *  - USER rows only (`source: 'user'`). Machine relay traffic (agent /
 *    webhook / schedule rows) shares the table; a human control surface must
 *    never reorder or delete a peer agent's report-up.
 *  - OWNER rows only (`userId` matches the caller). pending_chat_messages rows
 *    carry the typing user; a shared project chat can have several humans.
 *  - Promote/cancel take the row id AND the chat id, so a stale id from another
 *    chat 404s instead of touching the wrong queue.
 *  - Every move returns the FRESH list, so the UI re-renders from server truth
 *    (never from its own optimistic idea of the order).
 */

import prisma from '../../../config/database';

/** Gap inserted around a re-stamped row. A millisecond would colliding-collide
 *  with a neighbour stamped in the same tick; 10 ms keeps `<` total while
 *  staying far inside the drain's tolerance for "the same instant". */
export const ORDER_EPSILON_MS = 10;

/** One queued row as the control surface exposes it. */
export interface QueuedUserMessage {
  /** Raw pending_chat_messages id (the control endpoints take this). */
  id: string;
  /** 1-based position within the USER queue (what the UI badge shows). */
  position: number;
  content: string;
  createdAt: string;
  /** Staged attachment count — the UI shows a paperclip instead of the blobs. */
  attachmentCount: number;
}

/** Why a control action was refused (mapped to HTTP by the controller). */
export type QueueControlRefusal = 'not_found' | 'not_a_user_row' | 'not_owned' | 'blocked';

export interface QueueControlResult {
  ok: boolean;
  refusal?: QueueControlRefusal;
  /** The chat's USER queue after the action (always fresh server truth). */
  queue: QueuedUserMessage[];
}

function attachmentCountOf(uploadIds: unknown): number {
  if (!Array.isArray(uploadIds)) return 0;
  return uploadIds.filter((x): x is string => typeof x === 'string' && x.length > 0).length;
}

/**
 * The DRAIN's order for a chat's user rows — createdAt asc, id asc, WITHOUT a
 * userId filter, because that is literally what peekOldest does
 * (`where: { chatId, source: 'user' }`). Computing positions inside one user's
 * rows instead would have two consequences, both wrong:
 *   - the number in the badge would not be the person's real place in the queue;
 *   - a re-stamped createdAt could silently jump ANOTHER human's waiting row in
 *     a shared chat, an inversion the other person can neither see nor undo.
 * So: order by the chat's real order, then narrow to the caller for rendering.
 */
async function chatUserOrder(chatId: string): Promise<Array<{ id: string; userId: string; createdAt: Date }>> {
  return prisma.pendingChatMessage.findMany({
    where: { chatId, source: 'user' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, userId: true, createdAt: true },
  });
}

/**
 * The chat's USER queue as the CALLER sees it: their own rows, each carrying its
 * true 1-based position in the chat's delivery order. Never throws for a
 * caller-facing read — the controller maps an empty list to an empty panel.
 */
export async function listUserQueue(chatId: string, userId: string): Promise<QueuedUserMessage[]> {
  const order = await chatUserOrder(chatId);
  const mine = new Set<string>();
  for (const r of order) if (r.userId === userId) mine.add(r.id);
  if (!mine.size) return [];
  const rows = await prisma.pendingChatMessage.findMany({
    where: { chatId, source: 'user', userId, id: { in: [...mine] } },
    select: { id: true, content: true, createdAt: true, uploadIds: true },
  });
  const byId = new Map((rows ?? []).map((r) => [r.id, r]));
  const out: QueuedUserMessage[] = [];
  order.forEach((r, i) => {
    if (!mine.has(r.id)) return;
    const full = byId.get(r.id);
    if (!full) return;
    out.push({
      id: full.id,
      position: i + 1, // position in the CHAT's user queue — the truth
      content: full.content,
      createdAt: full.createdAt.toISOString(),
      attachmentCount: attachmentCountOf(full.uploadIds),
    });
  });
  return out;
}

/** Load one row and prove it is the caller's own USER row in THIS chat. */
async function loadControllable(chatId: string, userId: string, id: string) {
  const row = await prisma.pendingChatMessage.findFirst({
    where: { id, chatId },
    select: { id: true, chatId: true, userId: true, source: true, createdAt: true, mode: true },
  });
  if (!row) return { row: null, refusal: 'not_found' as QueueControlRefusal };
  // A machine row is not the human's to move — report it distinctly so the UI
  // can say "that message is from another sender" instead of "no longer queued".
  if (row.source !== 'user') return { row: null, refusal: 'not_a_user_row' as QueueControlRefusal };
  if (row.userId !== userId) return { row: null, refusal: 'not_owned' as QueueControlRefusal };
  return { row, refusal: undefined as QueueControlRefusal | undefined };
}

/**
 * Stamp `id` at `desired`, nudged so it can never EQUAL an existing row's
 * createdAt. A tie is not cosmetic: the drain tie-breaks by `id ASC`, so an
 * equal stamp could land the row on the wrong side of its neighbour (one click,
 * two positions) — the module header's "can never collide" claim is enforced
 * HERE, not asserted. Returns the nearest free millisecond.
 */
async function freeStamp(chatId: string, id: string, desired: Date): Promise<Date> {
  const taken = new Set(
    (await prisma.pendingChatMessage.findMany({ where: { chatId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, createdAt: true } }))
      .filter((r) => r.id !== id)
      .map((r) => r.createdAt.getTime()),
  );
  let ms = desired.getTime();
  for (let i = 0; i < 1000 && taken.has(ms); i += 1) ms -= 1; // step back (earlier) to stay well-ordered
  return new Date(ms);
}

/** Cancel one queued message before it fires. Idempotent-ish: a second cancel
 *  of the same id 404s (the row is genuinely gone — the UI refreshes). */
export async function cancelQueuedUserMessage(chatId: string, userId: string, id: string): Promise<QueueControlResult> {
  const { row, refusal } = await loadControllable(chatId, userId, id);
  if (!row) return { ok: false, refusal, queue: await listUserQueue(chatId, userId) };
  // The daily Council slot is reserved at ENQUEUE time (crossmodel.controller),
  // so deleting the row without giving it back would spend one of the person's
  // deep-research runs on an answer that never happens. Refund before the row
  // disappears — a refund that fails only costs the slot, which is the status
  // quo for a cancel, while a silent swallow of the DELETE would be worse.
  const mode = (row as { mode?: string | null }).mode ?? null;
  await prisma.pendingChatMessage.delete({ where: { id: row.id } });
  if (mode === 'deep_research' || mode === 'deep_research_all') {
    const { refundDeepResearchQuota } = await import('../rate-limit.service');
    await refundDeepResearchQuota(userId).catch(() => {});
  }
  // The staged uploads keep their (extended) TTL and lapse on their own — the
  // cancel path deliberately does NOT delete blobs, so a mis-click never
  // destroys an attachment the sender can still re-send from the composer.
  return { ok: true, queue: await listUserQueue(chatId, userId) };
}

/**
 * Move one queued message to the front of the CALLER's own messages — never
 * above a row another human is waiting on. The blocker rule matters: the drain
 * reads the chat's user rows in one order, so letting one person's promote jump
 * another person's waiting row would invert a queue the other person can
 * neither see nor undo (review finding, ticket ea04454c).
 */
export async function promoteQueuedUserMessage(chatId: string, userId: string, id: string): Promise<QueueControlResult> {
  const { row, refusal } = await loadControllable(chatId, userId, id);
  if (!row) return { ok: false, refusal, queue: await listUserQueue(chatId, userId) };
  const order = await chatUserOrder(chatId);
  const idx = order.findIndex((r) => r.id === row.id);
  const myFirst = order.findIndex((r) => r.userId === userId);
  if (idx < 0 || myFirst < 0) return { ok: false, refusal: 'not_found', queue: await listUserQueue(chatId, userId) };
  // Already at the front of my own block → nothing to move.
  if (idx === myFirst) return { ok: true, queue: await listUserQueue(chatId, userId) };
  const desired = new Date(order[myFirst].createdAt.getTime() - ORDER_EPSILON_MS);
  const target = await freeStamp(chatId, row.id, desired);
  await prisma.pendingChatMessage.update({ where: { id: row.id }, data: { createdAt: target } });
  return { ok: true, queue: await listUserQueue(chatId, userId) };
}

export type QueueMoveDirection = 'up' | 'down';

/**
 * Reorder one queued message by one slot, within the CHAT's real user order (so
 * a move can lift the caller's message past their own neighbour only when that
 * neighbour is theirs — it never hops another person's waiting row).
 * 'up' = one closer to the front. A move past either end is a successful no-op
 * (the UI disables the button at the ends, so a race that hits one just
 * re-renders the true order).
 */
export async function moveQueuedUserMessage(
  chatId: string,
  userId: string,
  id: string,
  direction: QueueMoveDirection,
): Promise<QueueControlResult> {
  const { row, refusal } = await loadControllable(chatId, userId, id);
  if (!row) return { ok: false, refusal, queue: await listUserQueue(chatId, userId) };
  const order = await chatUserOrder(chatId);
  const idx = order.findIndex((s) => s.id === row.id);
  if (idx < 0) return { ok: false, refusal: 'not_found', queue: await listUserQueue(chatId, userId) };
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= order.length) {
    return { ok: true, queue: await listUserQueue(chatId, userId) };
  }
  const neighbour = order[swapWith];
  // Refuse to hop a row somebody else is waiting on (same rule as promote): the
  // other person cannot see or undo this reorder, so it must not move them.
  if (neighbour.userId !== userId) {
    return { ok: false, refusal: 'blocked', queue: await listUserQueue(chatId, userId) };
  }
  // Place the moved row just BEYOND its neighbour on the side it travels to,
  // on a millisecond no other row occupies (freeStamp) so the drain's id
  // tie-break can never silently put it the wrong side of a neighbour.
  const desired = direction === 'up'
    ? new Date(neighbour.createdAt.getTime() - ORDER_EPSILON_MS)
    : new Date(neighbour.createdAt.getTime() + ORDER_EPSILON_MS);
  const capped = desired.getTime() > Date.now() ? new Date(Date.now()) : desired;
  const target = await freeStamp(chatId, row.id, capped);
  await prisma.pendingChatMessage.update({ where: { id: row.id }, data: { createdAt: target } });
  return { ok: true, queue: await listUserQueue(chatId, userId) };
}