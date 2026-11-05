/**
 * Busy-chat message queue (2026-08-07) — the persistence layer for messages
 * sent to a chat while a run is ACTIVE.
 *
 * Before this, such messages were silently LOST: the send_chat_message tool
 * path threw a 409 and the SSE stream path emitted an error event — the
 * content was never persisted anywhere. Now they persist to
 * `pending_chat_messages` and the finishing run's finally drains the OLDEST
 * one as a normal detached turn (chat-agent.service drainChatQueue), one per
 * drain — the newly started run's own finally drains the next, so a backed-up
 * queue unrolls as a natural FIFO chain of runs.
 *
 * Prisma/Redis-only helpers with NO imports from chat-agent.service or the
 * coding controllers BY DESIGN (import-cycle guard): chat-agent.service
 * imports THIS module for the drain; nothing here may import back.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import { AppError } from '../../../middleware/error-handler';
import { riderBody, formatWakeRider } from './agent-batch-format';

/**
 * Per-chat queue cap — over it, senders get a 409 instead of silent loss.
 * 20 matches the in-memory steer queue's bound (live-runs.ts).
 */
export const MAX_QUEUE_DEPTH = 20;

/** Who the message came from: the SSE stream ('user'), send_chat_message ('agent'), an inbound webhook fire ('webhook'), or a ONE-SHOT schedule firing queued behind a busy chat ('schedule', ticket 3405e332). */
export type PendingChatMessageSource = 'user' | 'agent' | 'webhook' | 'schedule';

/**
 * Fleet origin captured at ENQUEUE time for an AGENT send (send_chat_message
 * to a busy chat). pending_chat_messages has no metadata column (and this
 * audit phase makes no schema changes), so it rides a Redis side-channel
 * keyed by the row id: the drain reads it back to start the run MARKED
 * (messageOrigin 'agent' + sourceChatId — otherwise a queued nudge drains as
 * an interactive human turn in the fleet views) and to re-stamp the sender's
 * hook wake-depth onto this chat (hooks.service ladder — without it every
 * busy-chat hop resets the MAX_HOOK_DEPTH climb to 0). Best-effort by design:
 * a Redis hiccup degrades the drained run to unmarked, never blocks delivery.
 */
export interface PendingSendOrigin {
  /** 'webhook' = inbound webhook fire (2026-08-23) — no source chat, no depth.
   *  'schedule' = a ONE-SHOT schedule firing queued behind a busy chat (ticket
   *  3405e332) — carries scheduleId so the drain can enforce cancel-wins. */
  kind: 'agent' | 'webhook' | 'schedule';
  /** The SENDING chat's id (the run's own session). 'agent' sends only. */
  sourceChatId?: string;
  /** The sender's hook wake-depth at send time (0/absent = not a wake chain). 'agent' sends only. */
  depth?: number;
  /** The coding_schedules row whose firing was queued ('schedule' kind only) —
   *  the drain re-reads it and drops the message when the schedule was
   *  cancelled/deleted after queueing (mirrors run-executor's claim-time
   *  stale-firing guard). */
  scheduleId?: string;
  /** 'schedule' kind only (ticket 6ef770a1): the queued firing belongs to an
   *  owner-armed schedule (promptSetBy 'user') — the drain re-threads
   *  scheduleOwnerArmed so the delayed turn renders EXPANDED like the direct
   *  fire path would. Absent = machine/system/legacy row. */
  ownerArmed?: boolean;
  /** 'schedule' kind only (cohesive-chat wave 2026-09-28): the queued row is a
   *  TURN CONTINUATION of a human ask on this same chat — chat-agent/
   *  turn-continuation.ts armed it at the previous run's finalize. The drain
   *  threads it as ChatAgentRunArgs.continuation (machine origin, no user row,
   *  no wake preamble; the result posts as a new assistant message and the
   *  task card on the original row flips). Never set on user / agent / webhook
   *  rows. Type lives in turn-continuation.ts (ContinuationRun). */
  continuation?: import('./turn-continuation').ContinuationRun;
}

/** Outlives any realistic queue dwell (20-deep FIFO of minutes-long runs). */
const ORIGIN_STASH_TTL_SEC = 24 * 60 * 60;
const originStashKey = (id: string) => `chat:pendingorigin:${id}`;

export interface PendingChatMessageRow {
  id: string;
  chatId: string;
  userId: string;
  content: string;
  mode: string | null;
  source: string;
  /** Staged upload ids riding the queue (ac65d51e) — resolved at drain. */
  uploadIds?: unknown;
  createdAt: Date;
}

/**
 * Persist a message for later delivery. Throws AppError(409) when the chat's
 * queue is full (the ONLY remaining 409 on the busy-send paths). Returns the
 * new row's id and its 1-based FIFO position.
 */
export async function enqueueChatMessage(args: {
  chatId: string;
  userId: string;
  content: string;
  mode?: string | null;
  source: PendingChatMessageSource;
  /** AGENT/WEBHOOK sends only: fleet origin (+ agent wake-depth) to replay at drain time. */
  origin?: PendingSendOrigin;
  /** Staged /crossmodel/upload ids (ac65d51e) — persist with the row and
   *  EXTEND each blob's Redis TTL so attachments outlive the queue dwell. */
  uploadIds?: string[];
}): Promise<{ id: string; position: number; coalesced?: true }> {
  const count = await prisma.pendingChatMessage.count({ where: { chatId: args.chatId } });
  if (count >= MAX_QUEUE_DEPTH) {
    // FULL-QUEUE COALESCE (autonomy loop #15, 2026-09-21): a 409 here LOSES the
    // message — the sender's tool call fails and the report-up is gone (8 lost
    // in 4 h while the Fleet Supervisor's queue sat at 20). An AGENT send whose
    // sender already has a row waiting is appended to that row instead: the
    // two parts deliver as one message, provenance headers intact.
    const merged = await coalesceIntoSameSender(args, count).catch(() => null);
    if (merged) return merged;
    throw new AppError(
      409,
      `Message queue is full for this chat (${MAX_QUEUE_DEPTH} pending) — wait for the active run to finish and drain it, then resend.`,
    );
  }
  const row = await prisma.pendingChatMessage.create({
    data: {
      chatId: args.chatId,
      userId: args.userId,
      content: args.content,
      mode: args.mode ?? null,
      source: args.source,
      ...(args.uploadIds?.length ? { uploadIds: args.uploadIds } : {}),
    },
  });
  if (args.uploadIds?.length) {
    // Queued attachments (ac65d51e): blobs normally live 15 min — a 20-deep
    // FIFO of minutes-long runs can dwell far longer, so stretch each staged
    // blob to the origin-stash horizon. Best-effort: a Redis hiccup leaves the
    // default TTL and the drain annotates any expiry honestly.
    const { attachmentKey } = await import('../upload.controller');
    await Promise.all(
      args.uploadIds.map((id) => redisClient.expire(attachmentKey(id), ORIGIN_STASH_TTL_SEC).catch(() => 0)),
    );
  }
  if (args.origin) {
    await redisClient
      .set(originStashKey(row.id), JSON.stringify(args.origin), { EX: ORIGIN_STASH_TTL_SEC })
      .catch(() => {}); // best-effort — see PendingSendOrigin
  }
  return { id: row.id, position: count + 1 };
}

/** Ceiling for a coalesced row's content — past it the send is refused (409) as before. */
export const QUEUE_COALESCE_MAX_CHARS = 24_000;
export const COALESCED_FOLLOW_UP_PREFIX = '[+ FOLLOW-UP from the same sender';

async function coalesceIntoSameSender(
  args: { chatId: string; content: string; source: PendingChatMessageSource; origin?: PendingSendOrigin; uploadIds?: string[] },
  pendingCount: number,
): Promise<{ id: string; position: number; coalesced: true } | null> {
  if (args.source !== 'agent' || args.origin?.kind !== 'agent' || !args.origin.sourceChatId || args.uploadIds?.length) return null;
  const sender = args.origin.sourceChatId;
  const rows = await prisma.pendingChatMessage.findMany({
    where: { chatId: args.chatId, source: 'agent' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_QUEUE_DEPTH,
    select: { id: true, content: true, createdAt: true, uploadIds: true },
  });
  // Newest first regardless of driver ordering — the sender's LATEST row absorbs the follow-up.
  const newestFirst = (rows as Array<{ id: string; content: string; createdAt: Date; uploadIds?: unknown }>)
    .slice()
    .sort((a, b) => (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) || (b.id > a.id ? 1 : -1));
  for (const r of newestFirst) {
    const uploads = Array.isArray(r.uploadIds) ? (r.uploadIds as unknown[]).filter((x) => typeof x === 'string' && (x as string).length > 0) : [];
    if (uploads.length) continue; // attachment rows drain singly — never merge into them
    const raw = await redisClient.get(originStashKey(r.id)).catch(() => null);
    if (!raw) continue;
    let o: PendingSendOrigin | null = null;
    try { o = JSON.parse(raw) as PendingSendOrigin; } catch { continue; }
    if (o?.kind !== 'agent' || o.sourceChatId !== sender) continue;
    const merged = `${r.content}\n\n${COALESCED_FOLLOW_UP_PREFIX} ${sender.slice(0, 8)}, queued ${new Date().toISOString()} while this chat's queue was full (${MAX_QUEUE_DEPTH} pending) — read both parts as one report]\n${args.content}`;
    if (merged.length > QUEUE_COALESCE_MAX_CHARS) return null;
    await prisma.pendingChatMessage.update({ where: { id: r.id }, data: { content: merged } });
    const ahead = await prisma.pendingChatMessage.count({ where: { chatId: args.chatId, createdAt: { lt: r.createdAt } } }).catch(() => 0);
    return { id: r.id, position: Math.min(pendingCount, ahead + 1), coalesced: true };
  }
  return null;
}

/**
 * Head of a chat's queue for the finalize's fairness arbitration (loop #15):
 * the OLDEST row of any class, reported as source 'user' whenever any human
 * row waits (peekOldest serves user rows first, so that is the row a drain
 * would start). null = empty queue. Never throws.
 */
export async function oldestPendingHead(chatId: string): Promise<{ createdAt: Date; source: string } | null> {
  try {
    const rows = await prisma.pendingChatMessage.findMany({
      where: { chatId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 1,
      select: { createdAt: true, source: true },
    });
    const row = rows?.[0];
    if (!row) return null;
    if (row.source !== 'user') {
      const users = await prisma.pendingChatMessage.count({ where: { chatId, source: 'user' } }).catch(() => 0);
      if (users > 0) return { createdAt: row.createdAt, source: 'user' };
    }
    return { createdAt: row.createdAt, source: row.source };
  } catch {
    return null;
  }
}

/** The origin stash for a queued row (null when absent/expired/hiccup). Read-only — deletePending clears it. */
export async function readPendingOrigin(id: string): Promise<PendingSendOrigin | null> {
  try {
    const raw = await redisClient.get(originStashKey(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.kind === 'agent' || parsed?.kind === 'webhook' || parsed?.kind === 'schedule' ? (parsed as PendingSendOrigin) : null;
  } catch {
    return null;
  }
}

/**
 * The next queued message for a chat, or null when empty. USER-origin rows
 * drain FIRST (owner incident 2026-09-04, chat c0e22e36: the owner's typed
 * question sat 12 minutes behind queued machine/relay traffic in a plain FIFO)
 * — the `source` column ('user' vs 'agent'/'webhook') is the origin marker,
 * captured at enqueue. Within each class the order stays FIFO (createdAt, id),
 * so two user messages still deliver in the order they were typed.
 */
export async function peekOldest(chatId: string): Promise<PendingChatMessageRow | null> {
  const user = await prisma.pendingChatMessage.findFirst({
    where: { chatId, source: 'user' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (user) return user;
  return prisma.pendingChatMessage.findFirst({
    where: { chatId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * Coalesced report-up digest (owner 2026-09-14 — the Fleet Supervisor ran 50
 * turns in 3 h, 24 of them one-message agent report-ups queued while it was
 * busy): the oldest consecutive AGENT rows for a chat, FIFO, up to `limit`,
 * drained as ONE turn by chat-agent drainChatQueue. USER rows are never
 * batched (a human turn is a human turn) and rows carrying staged uploads
 * drain singly (attachment resolution is per-row).
 */
export const AGENT_DRAIN_BATCH_MAX = 6;
export async function peekOldestAgentBatch(chatId: string, limit: number = AGENT_DRAIN_BATCH_MAX): Promise<PendingChatMessageRow[]> {
  const rows = await prisma.pendingChatMessage.findMany({
    where: { chatId, source: 'agent' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, limit),
  });
  // Leading run of upload-free rows only (FIFO within the agent class is preserved).
  const out: PendingChatMessageRow[] = [];
  for (const r of rows as PendingChatMessageRow[]) {
    const uploads = Array.isArray(r.uploadIds) ? (r.uploadIds as unknown[]).filter((x) => typeof x === 'string' && (x as string).length > 0) : [];
    if (uploads.length) break;
    out.push(r);
  }
  return out;
}

/** Remove a queued row (after its run has successfully started) + its origin stash. */
export async function deletePending(id: string): Promise<void> {
  await prisma.pendingChatMessage.delete({ where: { id } });
  await redisClient.del(originStashKey(id)).catch(() => {});
}

/**
 * CONSUME-AT-PERSIST — the MERGE-1 cutover kill-window fix (2026-11-05).
 *
 * THE DEFECT. Delivery of a queued row is two independent writes: the drain
 * deletes `pending_chat_messages` (chat-agent.service drainChatQueue, right
 * after `startDetachedChatRun` returns) and the detached run persists the
 * transcript row later (runChatAgentTurnInner's user-row create). A blue-green
 * cutover kills the old colour anywhere in between, so the handover had TWO
 * reachable failure modes and no ordering fixes both:
 *   · kill between the CLAIM and the DELETE -> the row survives, the run may
 *     have persisted; once the Redis liveness key expires (LIVE_RUN_TTL_SEC =
 *     60 s) the surviving colour peeks the same row and starts a SECOND run
 *     for the same content => DUPLICATION;
 *   · kill between the DELETE and the PERSIST -> the row is gone and the
 *     content was never written => LOSS (the pre-existing order made this the
 *     likelier of the two, because the delete is synchronous in the drain
 *     while the persist runs detached).
 * Deleting BEFORE the start converts duplication into loss (proved in
 * message-queue.merge1-bluegreen.test.ts) — so neither order is safe. The
 * writes must be ONE write.
 *
 * THE FIX. Create the transcript row(s) and delete the consumed pending rows
 * in a single Postgres transaction. Then every kill point resolves safely:
 *   · before the commit  -> nothing happened: the row survives, the message is
 *     absent, the next drain delivers it (no loss, and not a duplication
 *     because the content was never persisted);
 *   · after the commit   -> both effects exist exactly once (no duplication,
 *     because the row cannot outlive the persist).
 * `deleteMany` (not `delete`) is deliberate: a row already removed by an
 * unrelated deliberate-drop path is simply not matched, so the consume is
 * idempotent and never throws on a row that is gone.
 *
 * Callers pass the ids of the rows whose CONTENT the messages carry. A caller
 * with no ids keeps the plain create (no transaction is opened needlessly).
 */
export async function createMessagesConsumingPending(args: {
  messages: Array<{ chatId: string; role: string; content: string; metadata?: object }>;
  pendingIds: string[];
}): Promise<Array<{ id: string; createdAt: Date }>> {
  const { messages, pendingIds } = args;
  if (!pendingIds.length) {
    const rows = [];
    for (const data of messages) rows.push(await prisma.crossModelMessage.create({ data }));
    return rows as Array<{ id: string; createdAt: Date }>;
  }
  const rows = await prisma.$transaction(async (tx) => {
    const created: Array<{ id: string; createdAt: Date }> = [];
    for (const data of messages) created.push(await tx.crossModelMessage.create({ data }));
    // Same transaction as the persist: the queue row and its content commit
    // together or not at all.
    await tx.pendingChatMessage.deleteMany({ where: { id: { in: pendingIds } } });
    return created;
  });
  // The origin stash is Redis-only (best-effort by design) — cleared AFTER the
  // durable consume, so a Redis hiccup leaves a stale stash (harmless) rather
  // than dropping provenance for a message that is still queued.
  await Promise.all(pendingIds.map((id) => redisClient.del(originStashKey(id)).catch(() => 0)));
  // A delivered row starts with a clean attempt budget if it is ever re-queued.
  await clearDrainAttempts(pendingIds);
  return rows;
}

/**
 * Consume the drained rows for a branch that persists NO transcript row of its
 * own (a turn continuation: the harness prompt is never a user row). See
 * createMessagesConsumingPending for the kill-window rationale — the point
 * here is only that these rows still must not survive their delivery.
 * Best-effort by contract: the caller's content is the harness's, so a failure
 * leaves the row queued for one more round rather than losing owner content.
 */
export async function consumeDrainedPendingRows(pendingIds: string[] | undefined): Promise<void> {
  const ids = Array.isArray(pendingIds) ? pendingIds.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  if (!ids.length) return;
  await prisma.pendingChatMessage.deleteMany({ where: { id: { in: ids } } });
  await Promise.all(ids.map((id) => redisClient.del(originStashKey(id)).catch(() => 0)));
  await clearDrainAttempts(ids);
}
/**
 * DRAIN ATTEMPT BOUND — companion to consume-at-persist (MERGE-1 kill-window
 * fix, 2026-11-05). Consuming at persist is what makes a killed delivery LOSE
 * nothing (the failed transaction rolls back and the row stays queued), but
 * that also means a row whose persist keeps failing is re-drained by the
 * finished run's own finally — which is a tight retry LOOP, not a recovery.
 * This counts delivery attempts per row so the immediate chain gives up after
 * a small number; the row stays QUEUED (never dropped) and the periodic
 * sweeper/nudge still retries it later, so nothing is lost either way.
 *
 * FAIL-CLOSED FOR LOOP PREVENTION (2026-11-05 rework — the OOM defect).
 * The first cut of this bound read the count ONLY from Redis and answered 0 on
 * any Redis error ("fail-open, so a cache hiccup can never block a delivery").
 * That polarity is WRONG for a bound whose entire job is to stop a hot loop: it
 * is blind exactly when the system is unhealthy, which is when the loop fires.
 * Measured (preemption.test.ts, source WITH the fix vs origin/main): 19/19
 * passing in 4.078s without the fix, versus 0 tests in 173.66s with it — a jest
 * worker SIGTERM at 4041.3 MB of a 4137.4 MB heap. Mechanism: the persist threw,
 * the row was never consumed, the finished run's own finally re-drained the SAME
 * head row, and the Redis-only counter (a mocked/degraded Redis answers 0) never
 * tripped — an unbounded promise chain, no progress per cycle.
 *
 * The bound is therefore now IN-PROCESS AUTHORITATIVE: a plain Map cannot fail,
 * so the immediate chain can never be unbounded. Redis is kept only as a
 * cross-instance BACKSTOP with a short window; it is read, never required.
 *
 * PROGRESS MODEL: at most MAX_DRAIN_ATTEMPTS deliveries per row, then a bounded
 * COOLDOWN during which the drain declines instantly (a Map lookup — no run
 * started, no persist attempted) and the periodic sweeper/nudge retries later.
 * The row is never dropped; a transient fault recovers without operator action
 * and a permanent one cannot spin.
 */
const drainAttemptKey = (id: string) => `chat:pendingattempt:${id}`;
/** Cross-instance backstop window (the local ledger is the authority). */
const DRAIN_ATTEMPT_TTL_SEC = 60 * 5;
/** Immediate-chain attempts before the drain stops starting runs for one row. */
export const MAX_DRAIN_ATTEMPTS = 3;
/** Quiet window after the bound trips — no run is started for the row. */
const DRAIN_COOLDOWN_MS = 60_000;
/**
 * Local ledger entry lifetime. Must EXCEED a failing delivery cycle: if it were
 * shorter than a typical failing run, the count would reset to 1 every cycle and
 * only the Redis backstop would ever trip the bound (review 2026-11-05) — which
 * is precisely the blindness this rework removes.
 */
const LOCAL_ATTEMPT_WINDOW_MS = 10 * 60_000;

/**
 * In-process ledger — the AUTHORITATIVE bound. `{ n }` counts attempts in the
 * current window; `{ until }` is a tripped cooldown (a row that exhausted its
 * budget). Pruned on every write so a long-lived worker cannot leak rows.
 */
const localDrainLedger = new Map<string, { n: number; at: number } | { until: number }>();
let lastLocalPrune = 0;

function pruneLocalLedger(now: number): void {
  if (now - lastLocalPrune < 30_000) return;
  lastLocalPrune = now;
  for (const [id, entry] of localDrainLedger) {
    const dead = 'until' in entry ? entry.until <= now : now - entry.at > LOCAL_ATTEMPT_WINDOW_MS;
    if (dead) localDrainLedger.delete(id);
  }
}

/**
 * Is this row inside its post-bound cooldown? A Map lookup only — deliberately
 * synchronous and failure-free, because this is the guard that must hold when
 * everything else (Redis, the DB) is down.
 */
export function isDrainCoolingDown(id: string): boolean {
  const entry = localDrainLedger.get(id);
  if (!entry || !('until' in entry)) return false;
  if (entry.until > Date.now()) return true;
  localDrainLedger.delete(id);
  return false;
}

/**
 * Count one delivery attempt for a queued row; returns the new count.
 * The LOCAL count is always incremented first and cannot fail, so the bound is
 * guaranteed to trip; the Redis count is layered on when available.
 */
export async function noteDrainAttempt(id: string): Promise<number> {
  const now = Date.now();
  pruneLocalLedger(now);
  const prior = localDrainLedger.get(id);
  const local = (prior && 'n' in prior && now - prior.at <= LOCAL_ATTEMPT_WINDOW_MS ? prior.n : 0) + 1;
  localDrainLedger.set(id, { n: local, at: now });
  let remote = 0;
  try {
    const n = await redisClient.incr(drainAttemptKey(id));
    if (n === 1) await redisClient.expire(drainAttemptKey(id), DRAIN_ATTEMPT_TTL_SEC).catch(() => 0);
    remote = Number(n) || 0;
  } catch {
    remote = 0; // backstop only — the local count above is what enforces the bound
  }
  return Math.max(local, remote);
}

/**
 * Trip the cooldown for a row that exhausted its budget. Resets BOTH counters
 * so a later recovery starts from a clean slate instead of inheriting a
 * lifetime tally (a permanently stuck row then costs one run-start per
 * cooldown, never a hot loop, and a transient fault heals on the next sweep).
 */
export async function tripDrainCooldown(id: string): Promise<void> {
  localDrainLedger.set(id, { until: Date.now() + DRAIN_COOLDOWN_MS });
  await redisClient.del(drainAttemptKey(id)).catch(() => 0);
}

/** Clear the attempt budget for rows that were CONSUMED (a successful delivery). */
async function clearDrainAttempts(ids: string[]): Promise<void> {
  for (const id of ids) localDrainLedger.delete(id);
  await Promise.all(ids.map((id) => redisClient.del(drainAttemptKey(id)).catch(() => 0)));
}

/**
 * TEST-ONLY: drop the in-process ledger. It is module state, so a jest file
 * that resets its id counter between cases mints the SAME row ids again and the
 * attempts of an earlier case carry over (they accumulated 1→2→3→4 and tripped
 * the cooldown, so later cases never reached the persist at all). Production
 * ids are cuids and never collide; only fixtures need this. Not called by any
 * production path.
 */
export function __resetDrainAttemptLedgerForTests(): void {
  localDrainLedger.clear();
  lastLocalPrune = 0;
}

/**
 * Release the enqueue's TTL pin after a SUCCESSFUL drain (ac65d51e, review
 * M2): the started run already owns the resolved content in memory, so the
 * 24h-stretched blobs are pure memory pressure from here. Best-effort — a
 * Redis hiccup just leaves the (harmless) TTL to lapse.
 */
export async function consumePendingUploads(uploadIds: string[]): Promise<void> {
  if (!uploadIds.length) return;
  const { attachmentKey } = await import('../upload.controller');
  await Promise.all(uploadIds.map((id) => redisClient.del(attachmentKey(id)).catch(() => 0)));
}

/**
 * Supersession-marker support (ticket c6db9c72, 2026-09-16): a queued agent
 * steer can be DELIVERED long after its source chat moved on — the owner may
 * have ruled there after the steer was queued, and a receiver ruling on the
 * cold copy inverts the owner's call (the 23:01Z fleet incident: spark's
 * stand-down steer delivered with the owner's 22:42Z ruling sitting unread in
 * the source chat). The drain checks each distinct source chat for
 * owner-authored rows NEWER than the row's enqueue time and annotates the
 * delivered copy.
 *
 * "Owner-authored" = role 'user' whose metadata.origin is absent/'user'
 * (machine origins — schedule/hook/agent/webhook — never count). The JS-side
 * filter sidesteps Prisma's JSON-null / missing-key edge cases: owner rows
 * variously carry SQL-NULL metadata, {origin:'user'}, or attachment-only
 * metadata. One bounded indexed query per distinct source chat
 * (crossmodel_messages(chatId, createdAt), newest 50 rows in the window).
 * Best-effort: a DB hiccup yields no marker and never blocks delivery.
 */
export async function latestOwnerRowsAfter(
  queries: ReadonlyArray<{ sourceChatId: string | undefined; since: Date }>,
): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>();
  // Dedupe source chats, keeping the OLDEST since per chat (widest window).
  const byChat = new Map<string, Date>();
  for (const q of queries) {
    if (!q?.sourceChatId || !(q.since instanceof Date) || Number.isNaN(q.since.getTime())) continue;
    const prev = byChat.get(q.sourceChatId);
    if (!prev || q.since < prev) byChat.set(q.sourceChatId, q.since);
  }
  await Promise.all(
    [...byChat].map(async ([sourceChatId, since]) => {
      try {
        const rows = await prisma.crossModelMessage.findMany({
          where: { chatId: sourceChatId, role: 'user', createdAt: { gt: since } },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { createdAt: true, metadata: true },
        });
        let newest: Date | null = null;
        for (const r of rows) {
          const origin = (r.metadata as { origin?: unknown } | null)?.origin;
          if (origin !== undefined && origin !== null && origin !== 'user') continue;
          if (!newest || r.createdAt > newest) newest = r.createdAt;
        }
        out.set(sourceChatId, newest);
      } catch {
        out.set(sourceChatId, null); // hiccup → no marker, delivery unaffected
      }
    }),
  );
  return out;
}

/** Marker prefix for the supersession note (tests assert on this constant). */
export const SUPERSEDED_STEER_NOTE_PREFIX = '⚠ SUPERSEDED?';

/**
 * The one-line delivery note prepended to a queued agent message whose source
 * chat has an owner row NEWER than the message's own enqueue time. Advisory —
 * it tells the receiver to re-read the source chat before acting; it never
 * drops the message. Timestamps stay ISO/UTC (machine-to-machine content).
 */
export function buildSupersededSteerNote(sourceChatId: string, ownerAt: Date, queuedAt: Date): string {
  return `[${SUPERSEDED_STEER_NOTE_PREFIX} — the OWNER posted in the source chat ${sourceChatId.slice(0, 8)} at ${ownerAt.toISOString()}, AFTER this message was queued (${queuedAt.toISOString()}). What follows may be SUPERSEDED by that ruling — read the source chat (get_chat_messages) BEFORE acting on it.]`;
}

/** How many messages are waiting in a chat's queue. */
export async function countPending(chatId: string): Promise<number> {
  return prisma.pendingChatMessage.count({ where: { chatId } });
}

/** How many USER-typed messages are waiting (F3 honest-status surfaces:
 *  "your message is queued" must count the user's own sends, not machine
 *  relay traffic sharing the queue). */
export async function countPendingUser(chatId: string): Promise<number> {
  return prisma.pendingChatMessage.count({ where: { chatId, source: 'user' } });
}

// ── Queued report-up RIDER on hook/schedule wakes (hardening loop iteration 7, 2026-09-24) ──
//
// The Fleet Supervisor (24 h to 2026-09-24 12:00Z): 121 turns, busy 19.2 h of
// 24, p50 8 / p90 19 min per turn; 66 turns were single AGENT report-ups
// (project supervisors' per-sweep deltas, ~1.2 KB) drained one per turn — the
// coalesced batch drain (peekOldestAgentBatch) rarely saw two rows because
// report-ups arrive slower than the turns. Every hook (39/day) or schedule
// (16/day) wake that finds agent rows queued now carries them as a RIDER in
// the same machine turn: the row is delivered once (deleted after the wake
// STARTS — the same peek → start → delete order drainChatQueue uses) and the
// separate drain turn never happens. USER rows never ride (a human turn is a
// human turn — and a waiting human row means the wake should not be taking
// the idle window anyway); rows with staged uploads never ride (per-row
// attachment resolution); the block is bounded by WAKE_RIDER_MAX_CHARS so a
// wake prompt (~17 KB today) does not double — rows that do not fit stay
// queued and the header says so.

export const WAKE_RIDER_MAX_CHARS = 8_000;

export interface WakeRider {
  /** The queued rows riding this wake, FIFO. */
  rows: PendingChatMessageRow[];
  /** The rendered block to append to the wake prompt (before the sweep-doctrine suffix). */
  text: string;
  /** Deepest stashed hook wake-depth among the riders (0 = none) — the caller re-stamps it on the chat. */
  maxDepth: number;
  /** Queued agent rows that did NOT fit this wake (drain after the turn). */
  remaining: number;
}

/**
 * Peek the agent rows that can ride a machine wake for `chatId`. null when a
 * USER row is waiting, no upload-free agent row is queued, or
 * even the oldest row does not fit the budget (it drains on its own). Read-only:
 * consumeWakeRider deletes the rows once the wake has STARTED.
 */
export async function peekWakeRider(chatId: string, opts: { maxChars?: number } = {}): Promise<WakeRider | null> {
  if (!chatId) return null;
  const maxChars = Math.max(500, opts.maxChars ?? WAKE_RIDER_MAX_CHARS);
  try {
    if ((await countPendingUser(chatId)) > 0) return null;
    const batch = await peekOldestAgentBatch(chatId);
    if (!batch.length) return null;
    const origins = await Promise.all(batch.map((r) => readPendingOrigin(r.id)));
    // A stash that says the row is NOT an agent send (impossible for source
    // 'agent' today, kept as a guard) ends the leading run there.
    let usable = batch.length;
    for (let i = 0; i < batch.length; i++) { if (origins[i] && origins[i]!.kind !== 'agent') { usable = i; break; } }
    if (!usable) return null;
    const rows = batch.slice(0, usable);
    let notes: Array<string | null> = rows.map(() => null);
    try {
      const newestOwner = await latestOwnerRowsAfter(rows.map((r, i) => ({ sourceChatId: origins[i]?.sourceChatId, since: r.createdAt })));
      notes = rows.map((r, i) => {
        const src = origins[i]?.sourceChatId;
        const ownerAt = src ? newestOwner.get(src) : null;
        return src && ownerAt && ownerAt > r.createdAt ? buildSupersededSteerNote(src, ownerAt, r.createdAt) : null;
      });
    } catch { /* advisory */ }
    const bodies: string[] = [];
    let used = 0;
    for (let i = 0; i < rows.length; i++) {
      const b = riderBody(rows[i].content, origins[i]?.sourceChatId, notes[i]);
      if (bodies.length && used + b.length > maxChars) break;
      if (!bodies.length && b.length > maxChars) return null; // the oldest alone is too big — it drains on its own
      bodies.push(b);
      used += b.length;
    }
    const taken = rows.slice(0, bodies.length);
    const totalAgent = await prisma.pendingChatMessage.count({ where: { chatId, source: 'agent' } }).catch(() => taken.length);
    const remaining = Math.max(0, totalAgent - taken.length);
    const maxDepth = Math.max(0, ...taken.map((_r, i) => Number(origins[i]?.depth ?? 0) || 0));
    return { rows: taken, text: formatWakeRider(bodies, remaining), maxDepth, remaining };
  } catch {
    return null; // the rider is an optimization — never block a wake on it
  }
}

/** Delete the rider rows (+ origin stashes) once the wake has started. Best-effort per row; returns rows removed. */
export async function consumeWakeRider(rider: WakeRider): Promise<number> {
  let n = 0;
  for (const r of rider.rows) {
    try { await deletePending(r.id); n++; } catch { /* a surviving row re-delivers on the next drain — logged by the caller */ }
  }
  return n;
}
