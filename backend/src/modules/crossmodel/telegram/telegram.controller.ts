/**
 * Telegram Bot Controller
 *
 * Single shared "Digby" bot. Flow:
 *   • User clicks "Connect Telegram" → GET /telegram/connect-link mints a one-time
 *     token and returns a t.me/<bot>?start=<token> deep link.
 *   • User presses Start in Telegram → Telegram POSTs /telegram/webhook with
 *     "/start <token>"; we map their chatId → Digby userId (TelegramLink).
 *   • Any later message they send the bot is answered by running the normal Digby
 *     query pipeline as that user and replying through the bot.
 *
 * Endpoints:
 *   GET    /api/crossmodel/telegram/status        — connection status (auth)
 *   POST   /api/crossmodel/telegram/connect-link   — mint deep link (auth)
 *   DELETE /api/crossmodel/telegram/disconnect     — unlink (auth)
 *   POST   /api/crossmodel/telegram/webhook         — Telegram updates (public; secret-header verified)
 */

import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../../../config/database';
import { invalidateIntegrationStatusCache } from '../langgraph/integration-status-cache';
import logger from '../../../utils/logger';
import {
  isConfigured,
  getBotUsername,
  sendMessage,
  sendTyping,
  mintLinkToken,
  consumeLinkToken,
  buildConnectUrl,
} from './telegram.service';
import { instanceSiteLabel } from '../platform/instance-setup';

/** The hostname users know THIS instance by — "digby.ai" on production, the self-host's own host elsewhere (2026-10-20). */
const SITE = instanceSiteLabel();

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const BOT_ENABLED = !!process.env.TELEGRAM_BOT_TOKEN;

export class TelegramController {

  /** GET /api/crossmodel/telegram/status */
  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const configured = isConfigured() && !!getBotUsername();
      const row = await (prisma as any).telegramLink.findUnique({
        where: { userId },
        select: { username: true, firstName: true, linkedAt: true },
      });
      if (!row) {
        return res.json({ success: true, data: { connected: false, configured, botUsername: getBotUsername() } });
      }
      res.json({
        success: true,
        data: {
          connected: true, configured, botUsername: getBotUsername(),
          username: row.username || null, firstName: row.firstName || null, connectedAt: row.linkedAt,
        },
      });
    } catch (error) { next(error); }
  }

  /** POST /api/crossmodel/telegram/connect-link — mint a one-time deep link. */
  async getConnectLink(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      if (!isConfigured() || !getBotUsername()) {
        return res.status(400).json({ success: false, error: 'not_configured' });
      }
      const token = await mintLinkToken(userId);
      const url = buildConnectUrl(token);
      if (!url) return res.status(400).json({ success: false, error: 'not_configured' });
      res.json({ success: true, data: { url } });
    } catch (error) { next(error); }
  }

  /** DELETE /api/crossmodel/telegram/disconnect */
  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      await (prisma as any).telegramLink.deleteMany({ where: { userId } });
      await invalidateIntegrationStatusCache(userId);
      logger.info(`Telegram: disconnected userId=${userId}`);
      res.json({ success: true, message: 'Telegram disconnected' });
    } catch (error) { next(error); }
  }

  /**
   * POST /api/crossmodel/telegram/webhook  [public]
   * Telegram calls this for every update. We verify the secret header, ACK 200
   * immediately, then process the update asynchronously (the pipeline can take
   * tens of seconds and Telegram would otherwise retry).
   */
  async webhook(req: Request, res: Response) {
    // FAIL CLOSED: without a configured secret we cannot verify Telegram is the
    // caller, so any anonymous POST could impersonate a linked user. Never skip
    // verification (2026-07-21 pre-launch audit). Constant-time compare.
    if (!WEBHOOK_SECRET) {
      if (BOT_ENABLED) logger.error('Telegram webhook rejected: TELEGRAM_WEBHOOK_SECRET is not set (cannot verify caller)');
      return res.status(503).json({ ok: false });
    }
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    const expected = WEBHOOK_SECRET;
    const ok = typeof provided === 'string'
      && provided.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!ok) {
      logger.warn('Telegram webhook: bad secret token');
      return res.status(401).json({ ok: false });
    }
    // ACK immediately so Telegram doesn't retry while we think.
    res.status(200).json({ ok: true });

    const update = req.body;
    void handleUpdate(update).catch((err: any) => {
      logger.warn(`Telegram handleUpdate failed: ${err.message}`);
    });
  }
}

// ── Update processing (fire-and-forget after ACK) ──────────────────────────────

async function handleUpdate(update: any): Promise<void> {
  const message = update?.message;
  if (!message || typeof message.text !== 'string') return;

  const chatId = String(message.chat?.id ?? '');
  const text   = message.text.trim();
  if (!chatId) return;

  // /start [token] — linking + greeting
  if (text.startsWith('/start')) {
    const token = text.split(/\s+/)[1]?.trim();
    if (token) {
      const userId = await consumeLinkToken(token);
      if (!userId) {
        await sendMessage(chatId, `That connection link has expired. Open ${SITE} → Account → Integrations → Connect Telegram to get a fresh link.`);
        return;
      }
      // Replace any prior link for this user OR this chat to avoid unique conflicts.
      await (prisma as any).telegramLink.deleteMany({ where: { OR: [{ userId }, { chatId }] } });
      await (prisma as any).telegramLink.create({
        data: {
          userId, chatId,
          telegramUserId: message.from?.id ? String(message.from.id) : null,
          username: message.from?.username || null,
          firstName: message.from?.first_name || null,
        },
      });
      await invalidateIntegrationStatusCache(userId); // surface the new connection immediately (don't wait for TTL)
      logger.info(`Telegram: linked userId=${userId} chatId=${chatId}`);
      await sendMessage(chatId, '✅ Connected to Digby! Send me any question and I\'ll answer using Digby\'s multi-model AI. Your account memory and integrations apply here too.');
      return;
    }
    const existing = await (prisma as any).telegramLink.findUnique({ where: { chatId } });
    await sendMessage(chatId, existing
      ? 'You\'re already connected to Digby — just send me a question!'
      : `Welcome to Digby! To connect, open ${SITE} → Account → Integrations → Connect Telegram, then tap the link.`);
    return;
  }

  if (text === '/help') {
    await sendMessage(chatId, `Send me any question and I'll answer with Digby's multi-model AI. Connect/disconnect from ${SITE} → Account → Integrations.`);
    return;
  }

  // Regular message → answer as the linked Digby user.
  const link = await (prisma as any).telegramLink.findUnique({ where: { chatId } });
  if (!link) {
    await sendMessage(chatId, `Please connect first: ${SITE} → Account → Integrations → Connect Telegram.`);
    return;
  }

  // Digby Kids guard (patience plan Phase 1a §3.5, 2026-09-25): a linked CHILD
  // account never reaches the adult single-model agent (this path had no
  // isChild check — a child who linked Telegram ran the adult pipeline with
  // no Socratic guardrails). Refuse with the kid-mode message; the Phase 4
  // Telegram Auto item is conditional on this guard. Fail CLOSED: only an
  // ADULT row runs the agent — a missing row or a DB error refuses too, each
  // with its own neutral copy (the kids message goes only to a real child).
  const linkedKind = await linkedUserKind(link.userId);
  const refusal = linkedUserRefusal(linkedKind);
  if (refusal) {
    await sendMessage(chatId, refusal);
    logger.info(`Telegram: not running the agent for this link (userId=${link.userId}, ${linkedKind})`);
    return;
  }

  // Owner-question answer pre-router (remediation P2 item 4): 'answer <ref|N>
  // <text>' — or a Telegram REPLY to the bot's decision DM — closes the flagged
  // question through the SAME answer path as the Inbox (option matching
  // included) BEFORE anything reaches the chat pipeline.
  if (await tryAnswerOwnerQuestionFromTelegram(link.userId, chatId, text, message)) return;

  await sendTyping(chatId);
  try {
    // Agentic-only cutover (2026-07-23): bot answers run through the agent chat
    // engine (single_thinking; web search is always on). There is no SSE client
    // here — a capturing send accumulates the streamed answer chunks and the
    // end of the run finalizes the text we reply with. (H3: 'complete' no
    // longer carries a summary field — the payload is slimmed for proxy-safe
    // SSE — so the accumulated chunks ARE the answer; clean them exactly as the
    // engine's finalize does: strip [CANVAS] blocks and any [FOLLOWUPS] tail.)
    const { runChatAgentTurn } = await import('../chat-agent/chat-agent.service');
    const { parseCanvasTags, parseFollowUps } = await import('../langgraph/pipeline-utils');
    // THE send-mode resolver (2026-09-26 audit routing-unify-6): a Telegram
    // send is routed exactly like a web send (Auto router, patience_auto_only)
    // but stays off Level 3 — chatless: no persisted row for "Deeper findings",
    // nothing to notify. TELEGRAM_AUTO_ROUTE_DISABLED=1 keeps the old fixed L1.
    const { resolveSendMode } = await import('../platform/send-mode');
    const resolved = await resolveSendMode({ mode: 'auto', userId: link.userId, origin: 'telegram', chatless: true, content: text, sessionId: `telegram:${chatId}` });
    let answer = '';
    let failed: string | null = null;
    await runChatAgentTurn({
      userId:    link.userId,
      chatId:    null,
      sessionId: `telegram:${chatId}`,
      message:   text,
      mode:      (resolved.mode === 'thinking' || resolved.mode === 'deep_research' ? resolved.mode : 'single_thinking'),
      channel:   'telegram',
      ...(resolved.routing ? { routing: resolved.routing } : {}),
      ...(resolved.routingSource ? { routingSource: resolved.routingSource } : {}),
      send: (type, data) => {
        if (type === 'chunk' && typeof data?.content === 'string') answer += data.content;
        else if (type === 'error') failed = String(data?.message || 'error');
      },
    });
    answer = parseFollowUps(parseCanvasTags(answer).cleanText).cleanText;

    await sendMessage(chatId, answer.trim() || (failed ? `Sorry, something went wrong answering that (${failed}). Please try again in a moment.` : 'Sorry, I couldn\'t generate a response just now. Please try again.'));
  } catch (err: any) {
    logger.warn(`Telegram pipeline failed for chatId=${chatId}: ${err.message}`);
    await sendMessage(chatId, 'Sorry, something went wrong answering that. Please try again in a moment.');
  }
}

/** The reply a linked child account gets instead of an answer (Digby Kids lives in the app only). */
export const KID_TELEGRAM_MESSAGE = `Digby Kids works in the Digby app, not over Telegram — open ${SITE} and sign in with your kids account to keep going.`;

/** True when the linked Digby user is a child sub-account (users.isChild). Fails CLOSED (unreadable ⇒ child). Exported for tests. */
export async function isChildLinkedUser(userId: string): Promise<boolean> {
  return (await linkedUserKind(userId)) !== 'adult';
}

export type LinkedUserKind = 'adult' | 'child' | 'missing' | 'unreadable';
/** Shown when the link's user row is gone (a deleted account whose telegram_links row outlived it). */
export const UNLINKED_TELEGRAM_MESSAGE = `This Telegram link is no longer connected to a Digby account — open ${SITE} → Account → Integrations to connect again.`;
/** Shown when users.isChild could not be read (a transient DB error) — neutral, never the kids copy. */
export const UNAVAILABLE_TELEGRAM_MESSAGE = 'Digby is temporarily unavailable over Telegram — please try again in a moment.';

/**
 * What the link points at. Fail-CLOSED: only 'adult' runs the agent — but the
 * copy branches on WHY (review 2026-09-25): the kids message goes only to a
 * real child; a missing row and a DB error each get their own neutral line
 * (an adult mid-outage must not be told they are on a kids account).
 */
export async function linkedUserKind(userId: string): Promise<LinkedUserKind> {
  try {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { isChild: true } });
    if (!row) return 'missing';
    return row.isChild ? 'child' : 'adult';
  } catch (err: any) {
    logger.warn(`Telegram: could not read users.isChild for ${userId} (${err?.message ?? err}) — not running the agent (fail-closed)`);
    return 'unreadable';
  }
}

/** The reply for a link that may not run the adult agent (null = adult, run it). */
export function linkedUserRefusal(kind: LinkedUserKind): string | null {
  if (kind === 'adult') return null;
  if (kind === 'child') return KID_TELEGRAM_MESSAGE;
  if (kind === 'missing') return UNLINKED_TELEGRAM_MESSAGE;
  return UNAVAILABLE_TELEGRAM_MESSAGE;
}

/** The inbound update handler (exported for tests; the webhook calls it after the ACK). */
export { handleUpdate };

// ── Owner-question answers over Telegram (remediation P2 item 4) ──────────────
// Two shapes close a flagged question through answerOwnerQuestion (the SAME
// path the Inbox uses — typed-option matching included):
//   1. 'answer <ref|N> <text…>' — ref = the 8-char short ref the DM printed
//      (the id chars after 'oq_'), a full oq_ id, or a 1-based number N into
//      the open list (newest first, as listed by 'answer' with no args).
//   2. A Telegram REPLY to the bot's own decision DM whose text quotes the
//      question — matched back to the open question; when exactly ONE question
//      is open for the user, a reply to any decision DM closes it.
// Anything that is not clearly an answer falls through to the chat pipeline
// (return false) — a false-positive here would swallow a normal chat message.

const ANSWER_COMMAND_RE = /^answer(?:\s+(\S+))?(?:\s+([\s\S]+))?$/i;
/** The DM shapes a bare reply may target (see owner-questions notifyOwnerOfNewFlag / repush). */
const DECISION_DM_MARKER_RE = /(Digby needs your decision|Still awaiting you)/;

export async function tryAnswerOwnerQuestionFromTelegram(
  userId: string,
  chatId: string,
  text: string,
  message: any,
): Promise<boolean> {
  try {
    const { listOpenOwnerQuestionsForUser, answerOwnerQuestion, shortQuestionRef } = await import('../platform/owner-questions');

    // Shape 2 — a Telegram reply to the bot's decision DM.
    const repliedText: string = String(message?.reply_to_message?.text ?? '');
    const isDecisionReply = !!repliedText && DECISION_DM_MARKER_RE.test(repliedText);

    const cmd = ANSWER_COMMAND_RE.exec(text);
    const isAnswerCommand = !!cmd && /^answer\b/i.test(text);
    if (!isAnswerCommand && !isDecisionReply) return false;

    // Review 2026-09-13 issue 11: supervisor-first triage — the DEFAULT listing
    // hides rows still in the Fleet Supervisor's triage window (the owner was
    // never DM'd about them; they surface here only after the SLA).
    const open = await listOpenOwnerQuestionsForUser(userId);
    if (!open.length) {
      if (isAnswerCommand) await sendMessage(chatId, 'No open questions right now — nothing to answer.');
      return isAnswerCommand; // an 'answer' command is consumed either way; a bare reply falls through
    }

    let target: (typeof open)[number] | undefined;
    let answerText = '';

    if (isAnswerCommand) {
      const ref = String(cmd?.[1] ?? '').trim();
      answerText = String(cmd?.[2] ?? '').trim();
      if (!ref || !answerText) {
        const listing = open
          .map((q, i) => `${i + 1}. [${shortQuestionRef(q.id)}] ${q.question.slice(0, 120)}`)
          .join('\n');
        await sendMessage(chatId, `Usage: answer <number|ref> <your answer>\n\nOpen questions (newest first):\n${listing}`);
        return true;
      }
      if (/^\d{1,2}$/.test(ref)) {
        const n = parseInt(ref, 10);
        if (n >= 1 && n <= open.length) target = open[n - 1];
      }
      if (!target) {
        const norm = ref.toLowerCase().replace(/^oq_/, '');
        const matches = open.filter((q) => q.id.toLowerCase().replace(/^oq_/, '').startsWith(norm));
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) {
          await sendMessage(chatId, `"${ref}" matches ${matches.length} open questions — use the full ref: ${matches.map((q) => shortQuestionRef(q.id)).join(', ')}.`);
          return true;
        }
      }
      if (!target) {
        await sendMessage(chatId, `No open question matches "${ref}". Send "answer" alone to list the open questions.`);
        return true;
      }
    } else {
      // Bare reply to a decision DM: match the quoted question text back to an
      // open row; a single open question accepts any decision-DM reply.
      answerText = text.trim();
      if (!answerText) return false;
      if (open.length === 1) {
        target = open[0];
      } else {
        const matches = open.filter((q) => repliedText.includes(q.question.slice(0, 120)));
        if (matches.length === 1) target = matches[0];
      }
      if (!target) {
        await sendMessage(chatId, `You have ${open.length} open questions — I couldn't tell which one this answers. Use: answer <number|ref> <your answer> (send "answer" alone to list them).`);
        return true;
      }
    }

    const r = await answerOwnerQuestion(target.id, userId, answerText.slice(0, 8000));
    if (r === 'ok') {
      await sendMessage(chatId, `✅ Answer recorded for [${shortQuestionRef(target.id)}] "${target.question.slice(0, 120)}" — the asking chat is being woken with it.`);
    } else if (r === 'reply_recorded') {
      // Todo 0dd7d3f2: a choice/yes_no gate got non-matching text — the reply
      // reached the asking chat as conversation; only the resolution is
      // refused. The old code lumped this into the credential message.
      // 2026-10-20: a credential gate answers the same code for WORDS (not the
      // key) — the asking lane is woken to answer; the key itself still has
      // to land through the card's key field, store_secret or the Account UI.
      const credentialGate = String((target as any).expectedAnswerType ?? '').startsWith('credential');
      await sendMessage(chatId, credentialGate
        ? `💬 Sent to the agent as a reply — it is being woken to answer you. That question still needs the KEY itself (the key field on the card in Management → Inbox, store_secret or Account → Coding credentials), so it stays open.`
        : `💬 Sent to the chat as a reply and the chat is being woken with it — act on any instruction in your words. The card still needs an option pick (or a yes/no ruling) to resolve, so it stays open. Reply "answer <number|ref> <option>" to resolve it.`);
    } else if (r === 'credential_pending') {
      // Todo 77c88942 item 2: a credential gate stays shut on text answers.
      // Ticket 238c9e2a: name ALL three lift channels (the card's key field,
      // store_secret, the Account UI) — the same list the Inbox card shows.
      await sendMessage(chatId, `🔒 Reply recorded, but that question needs a credential — the gate opens only when the key is stored (the key field on the card in Management → Inbox, store_secret or Account → Coding credentials), never from a chat answer. It stays open.`);
    } else {
      await sendMessage(chatId, `That question is no longer open (already answered or dismissed on another surface).`);
    }
    return true;
  } catch (err: any) {
    logger.warn(`Telegram owner-question answer failed: ${err?.message ?? err}`);
    return false; // fall through to the chat pipeline — never swallow the message on an error
  }
}

export default new TelegramController();
