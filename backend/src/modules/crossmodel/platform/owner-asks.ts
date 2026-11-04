/**
 * Open owner asks on supervisor chats (tt-rd audit 2026-09-27, findings
 * upward-chatter-directives-3/-4/-5).
 *
 * WHAT WENT WRONG: ten owner "progress?" pings on the tt-rd project supervisor
 * stayed 'open' in the directive ledger for days. Nine were answered in-chat
 * within minutes (the ledger just never closed them — see
 * supervisor-state.service closeAskOnReply), and ONE (871d203b, 2026-09-25
 * 19:16Z "what is going on…") got the harness's EMPTY_RUN_FALLBACK_NOTE as its
 * reply after 5 tool calls on glm-5.3 and was never answered: the ONE
 * empty-orchestrator retry applied only to no-tool runs or MACHINE wakes, and
 * nothing re-woke the supervisor about an owner turn that got a harness
 * envelope. The [SUPERVISOR STATE] block listed the stale rows mid-block with
 * no instruction to answer them first.
 *
 * This module gives the harness three deterministic, kill-switched pieces:
 *   1. buildOpenOwnerAsksBlock — the '[OPEN OWNER ASKS — ANSWER FIRST]' block
 *      injected ABOVE [SUPERVISOR STATE] on every supervisor machine wake:
 *      kind:'ask' directives younger than OPEN_OWNER_ASKS_MAX_AGE_MS with no
 *      finalize-stamped, non-error assistant row after them.
 *   2. rewakeForUnansweredOwnerAsk — when an OWNER turn on a supervisor chat
 *      ends with a harness error envelope, enqueue ONE machine re-wake
 *      ('[OWNER ASK UNANSWERED]', direct-wake hook) — once per ask (Redis NX,
 *      24 h). Always on — the OWNER_ASK_REWAKE_DISABLED release switch was
 *      removed 2026-10-31 (RSW-1 cohort delete). Telemetry
 *      loop_metrics 'owner_ask_rewake'.
 *   3. the env names for the owner-turn empty retry (chat-agent.service).
 *
 * Fail-open everywhere: a read error yields '' / false; nothing here gates,
 * refuses or cards. Dynamic imports keep the chat-agent run-start path
 * loadable under thin test mocks.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { isSupervisorReplyRow } from '../fleet/supervisor-reply-row';
import { listOpenOwnerAsks, closeAskOnReply, type OpenOwnerAsk } from './supervisor-state.service';

const SOURCE = 'owner-asks';

/** fixer 2026-09-27 (finding upward-chatter-1): the MACHINE-WAKE ask close —
 *  a hook wake carrying ownerAskMessageIds (the [OWNER ASK UNANSWERED]
 *  re-wake / the [FOLLOW-THROUGH] nudge) closes the ask when its reply is real
 *  text and stamps the reply row metadata.ownerAskReply. Always on — the
 *  OWNER_ASK_WAKE_CLOSE_DISABLED release switch was removed 2026-10-30
 *  (RSW-1 cohort delete). */
/** The hook payload kind BOTH ask wakes carry (owner-asks re-wake +
 *  follow-through nudge) — hooks.service reads it off the delivered rows to
 *  thread ownerAskMessageIds into the run. */
export const OWNER_ASK_WAKE_PAYLOAD_KIND = 'owner_ask_unanswered';

/** Asks older than this are history for the wake block (follow-through escalates them separately). */
export const OPEN_OWNER_ASKS_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** The block lists at most this many asks (oldest first — the longest-waiting owner question leads). */
export const OPEN_OWNER_ASKS_MAX_ROWS = 6;
/** Assistant rows scanned after an ask when looking for its reply. */
export const OPEN_OWNER_ASKS_REPLY_SCAN = 24;
/** The once-per-ask re-wake marker's TTL. */
export const OWNER_ASK_REWAKE_TTL_SEC = 24 * 3600;
export const OWNER_ASK_REWAKE_KEY = (askMessageId: string) => `owner-ask-rewake:${askMessageId}`;

export const OPEN_OWNER_ASKS_HEADER = '[OPEN OWNER ASKS — ANSWER FIRST]';

export const hhmmz = (d: Date): string => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

function ageLabel(atIso: string, now: Date): string {
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return '?';
  const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The FIRST qualifying supervisor reply (owner-origin or ownerAskReply-stamped,
 * finalize-stamped, non-error, non-card) that landed in the chat AFTER `at`:
 * `{ replyId }` when one exists, `{ replyId: null }` when none does, and
 * `{ replyId: null, error: true }` when the read failed (the callers fail
 * open on that — an ask must never be re-injected because the lookup broke).
 */
export async function findSupervisorReplyAfter(chatId: string, at: Date): Promise<{ replyId: string | null; error?: boolean }> {
  try {
    const rows = await prisma.crossModelMessage.findMany({
      where: { chatId, role: 'assistant', createdAt: { gt: at } },
      select: { id: true, content: true, metadata: true },
      orderBy: { createdAt: 'asc' },
      take: OPEN_OWNER_ASKS_REPLY_SCAN,
    });
    const hit = (rows as Array<{ id: string; content: string | null; metadata: any }>).find((r) => isSupervisorReplyRow(r));
    return { replyId: hit ? String(hit.id) : null };
  } catch (err: any) {
    logger.warn(`${SOURCE}: reply scan failed for ${chatId.slice(0, 8)}: ${err?.message ?? err}`, { source: SOURCE });
    return { replyId: null, error: true };
  }
}

/**
 * True when a qualifying supervisor reply landed in the chat AFTER `at`. A
 * read error answers TRUE (fail-open). Follow-through detector 3 reads this.
 */
export async function hasSupervisorReplyAfter(chatId: string, at: Date): Promise<boolean> {
  const r = await findSupervisorReplyAfter(chatId, at);
  return r.error === true || r.replyId != null;
}

/** Pure render of the block. Exported for tests. */
export function renderOpenOwnerAsksBlock(asks: OpenOwnerAsk[], now: Date = new Date()): string {
  if (!asks.length) return '';
  const lines = asks.slice(0, OPEN_OWNER_ASKS_MAX_ROWS).map((a) => {
    const msg = a.messageId ? `, msg ${a.messageId.slice(0, 8)}` : '';
    return `- (${ageLabel(a.at, now)}${msg}) "${a.text.slice(0, 300)}"`;
  });
  return [
    `${OPEN_OWNER_ASKS_HEADER} The owner asked and has not been answered:`,
    ...lines,
    `Answer each in plain words THIS wake before any sweep, dispatch or report-up, citing its msg id; the harness marks the ask answered when your reply lands (only typed evidence via update_supervisor_state closes it done). An ask you cannot answer yet gets ONE line saying what you are doing to answer it and by when (harness clock — never a time you type).`,
  ].join('\n');
}

export interface OpenOwnerAsksWake {
  /** The '[OPEN OWNER ASKS — ANSWER FIRST]' block, or '' when nothing is open / the switch is off / a read failed. */
  block: string;
  /** Directive ids the [SUPERVISOR STATE] render must OMIT from its OPEN OWNER
   *  ASKS section: every ask the block lists (rendered once), every ask a
   *  qualifying reply already answered (auto-closed here), and every ask whose
   *  reply scan failed (fail-open — hidden, never re-injected on a broken lookup). */
  hideAskIds: string[];
  /** Asks whose reply was found in the transcript and handed to closeAskOnReply. */
  reconciledAskIds: string[];
}

/**
 * Everything a supervisor machine wake needs about open owner asks (fixer
 * 2026-09-27, finding upward-chatter-1c). Reads EVERY open ask (no age cap —
 * an old ask a reply already answered must still close), then per ask:
 *   - a qualifying reply exists AFTER it → RECONCILE: closeAskOnReply (source
 *     'reconcile') and
 *     hide it — the pre-fix close ran only on owner turns, so an ask answered
 *     by a machine wake, or by an owner turn before this fix deployed, stayed
 *     open and re-injected for 72 h;
 *   - no reply, younger than OPEN_OWNER_ASKS_MAX_AGE_MS → the block (capped at
 *     OPEN_OWNER_ASKS_MAX_ROWS, oldest first) and hidden from the state doc
 *     (listed once, not twice);
 *   - no reply, older → left to the state doc + follow-through escalation.
 * Fail-open everywhere; nothing gates.
 */
export async function buildOpenOwnerAsksWake(chatId: string, opts: { userId?: string; now?: Date } = {}): Promise<OpenOwnerAsksWake> {
  const now = opts.now ?? new Date();
  const out: OpenOwnerAsksWake = { block: '', hideAskIds: [], reconciledAskIds: [] };
  try {
    const asks = await listOpenOwnerAsks(chatId, { now });
    if (!asks.length) return out;
    const unanswered: OpenOwnerAsk[] = [];
    for (const a of asks) {
      const atMs = Date.parse(a.at) || now.getTime();
      const reply = await findSupervisorReplyAfter(chatId, new Date(atMs));
      if (reply.error) { out.hideAskIds.push(a.id); continue; }
      if (reply.replyId) {
        out.hideAskIds.push(a.id);
        if (opts.userId && a.messageId) {
          out.reconciledAskIds.push(a.id);
          // Fire-and-forget; the typeof guard tolerates thin test mocks of the state service.
          if (typeof closeAskOnReply === 'function') {
            void closeAskOnReply(chatId, opts.userId, { askMessageId: a.messageId, replyMessageId: reply.replyId, source: 'reconcile' }).catch(() => {});
          }
        }
        continue;
      }
      if (now.getTime() - atMs > OPEN_OWNER_ASKS_MAX_AGE_MS) continue;
      if (unanswered.length >= OPEN_OWNER_ASKS_MAX_ROWS) continue;
      unanswered.push(a);
      out.hideAskIds.push(a.id);
    }
    out.block = renderOpenOwnerAsksBlock(unanswered, now);
    return out;
  } catch (err: any) {
    logger.warn(`${SOURCE}: block build failed for ${chatId.slice(0, 8)}: ${err?.message ?? err}`, { source: SOURCE });
    return { block: '', hideAskIds: [], reconciledAskIds: [] };
  }
}

/**
 * The '[OPEN OWNER ASKS — ANSWER FIRST]' block for a supervisor chat's machine
 * wake, or '' when nothing is open / the switch is off / a read failed.
 * (Block only — no reconcile close without a userId; the chat-agent wake path
 * calls buildOpenOwnerAsksWake.)
 */
export async function buildOpenOwnerAsksBlock(chatId: string, now: Date = new Date()): Promise<string> {
  return (await buildOpenOwnerAsksWake(chatId, { now })).block;
}

/** Pure render of the re-wake prompt. Exported for tests. */
export function renderOwnerAskRewakePrompt(input: { askText: string; askMessageId: string; askAt: Date }): string {
  const id8 = input.askMessageId.slice(0, 8);
  return `[OWNER ASK UNANSWERED] The owner asked "${input.askText.replace(/\s+/g, ' ').trim().slice(0, 200)}" (msg ${id8}) at ${hhmmz(input.askAt)} and your reply failed (harness note — the model returned no usable text). Answer it now in plain words from the ledger and the transcript; cite msg ${id8}. This wake exists to answer that question — no sweep, no report-up, until it is answered.`;
}

/**
 * ONE machine re-wake for an owner turn whose reply was a harness error
 * envelope. Once per ask (Redis NX marker, 24 h); a Redis hiccup still
 * enqueues (a duplicate wake is cheaper than a lost owner question). Returns
 * whether a wake was enqueued.
 */
export async function rewakeForUnansweredOwnerAsk(input: {
  chatId: string;
  askMessageId: string;
  askText: string;
  askAt: Date;
  reason: 'empty' | 'provider_error';
}): Promise<boolean> {
  const meta = { chatId: input.chatId, askMessageId: input.askMessageId.slice(0, 8), reason: input.reason };
  try {
    let first = true;
    try {
      const { default: redisClient } = await import('../../../config/redis');
      const set = await (redisClient as any).set(OWNER_ASK_REWAKE_KEY(input.askMessageId), '1', { NX: true, EX: OWNER_ASK_REWAKE_TTL_SEC });
      first = set != null;
    } catch { first = true; }
    if (!first) return false;
    const hooks: any = await import('./hooks.service').catch(() => null);
    if (typeof hooks?.enqueueDirectWake !== 'function') return false;
    const res = await hooks.enqueueDirectWake({
      targetChatId: input.chatId,
      prompt: renderOwnerAskRewakePrompt(input),
      meta: { origin: SOURCE, kind: 'owner_ask_unanswered', askMessageId: input.askMessageId, reason: input.reason },
    });
    const enqueued = res?.ok === true;
    void import('./loop-metrics.service')
      .then((m) => m.recordLoopMetric({ kind: 'owner_ask_rewake', sessionId: input.chatId, meta: { ...meta, enqueued, hookEventId: res?.hookEventId ? String(res.hookEventId).slice(0, 8) : null } }))
      .catch(() => {});
    if (enqueued) logger.info(`${SOURCE}: re-wake enqueued for ${input.chatId.slice(0, 8)} — owner ask ${input.askMessageId.slice(0, 8)} got a harness envelope (${input.reason})`, { source: SOURCE });
    return enqueued;
  } catch (err: any) {
    logger.warn(`${SOURCE}: re-wake failed for ${input.chatId.slice(0, 8)}: ${err?.message ?? err}`, { source: SOURCE });
    return false;
  }
}
