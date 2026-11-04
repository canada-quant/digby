/**
 * iMessage NLP helpers — resolve which conversation the user means, and parse a
 * "text <someone> <message>" request into a confirmable draft.
 *
 * Kept dependency-light: a cheap regex/token matcher for resolving a contact
 * against the user's conversation list, plus one utilityChat call to extract a
 * send request's recipient + body. Both fail soft (return null / best-effort) so
 * the chat pipeline is never blocked.
 */

import { utilityChat } from '../../../utils/utility-llm';
import logger from '../../../utils/logger';
import { decide, decisionMode, decisionThreshold, recordDecisionOutcome, stashDecision } from '../platform/decision-gate';
import type { DecideResult, DecisionStash } from '../platform/decision-gate';

export interface IMessageChatLite {
  chatId?: number;
  identifier?: string;
  displayName?: string | null;
}

export interface SendDraft {
  to: string; // resolved phone/email send target, or '' if we couldn't resolve it
  displayName: string; // human label for the confirm UI
  text: string; // message body to send
  resolved: boolean; // whether `to` is a usable send target
  /**
   * E5 (2026-09-25): the imessage_send decision this draft DEFERS — present
   * only when the gate answered and the draft surfaces a confirm card. The
   * outcome row is then written from the card's Send / Cancel
   * (send-draft-outcome.ts), never from the utility classifier's verdict, so
   * the purpose's positive class is the user's real intent. Absent ⇒ the
   * classification-time row was already recorded.
   */
  decision?: DecisionStash;
}

function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikePhoneOrEmail(s: string): boolean {
  return /@/.test(s) || /^[\d+().\-\s]{7,}$/.test(s);
}

/** Escape regex metacharacters so user-controlled contact names can't break (or inject into) a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the conversation the user is referring to by name. Matches a chat whose
 * displayName (or identifier) — or its first name — appears in `text`. Returns
 * the strongest match, or null.
 */
export function resolveNamedChat(
  text: string,
  chats: IMessageChatLite[],
): IMessageChatLite | null {
  const m = norm(text);
  if (!m) return null;
  let best: { chat: IMessageChatLite; score: number } | null = null;
  for (const c of chats) {
    for (const cand of [c.displayName, c.identifier].filter(Boolean) as string[]) {
      const n = norm(cand);
      if (!n || n.length < 2) continue;
      let score = 0;
      if (m.includes(n)) {
        score = n.length + 10; // full name / identifier appears verbatim
      } else {
        const first = n.split(' ')[0];
        // norm() already strips non-alphanumerics, but escape defensively so a
        // contact name can never throw a SyntaxError or inject into the RegExp.
        if (first.length >= 3) {
          try {
            if (new RegExp(`\\b${escapeRegExp(first)}\\b`).test(m)) score = first.length;
          } catch {
            if (m.includes(first)) score = first.length;
          }
        }
      }
      if (score > 0 && (!best || score > best.score)) best = { chat: c, score };
    }
  }
  return best?.chat || null;
}

/**
 * Reasoning-based send detection (NO keyword triggers). Given the recent
 * conversation, the latest user message, and the assistant's just-composed answer,
 * decide whether the user wants to SEND an iMessage right now, and if so extract
 * the recipient + the exact message body to send (which is usually a message the
 * assistant composed). The model reasons about intent — there are no hardcoded
 * trigger words. Conservative by design: only send=true when the latest user turn
 * is clearly asking to send/deliver a message.
 *
 * Returns a SendDraft (resolving the recipient against the user's conversations),
 * or null when the user is NOT asking to send.
 */
export async function classifySendDraft(
  latestUserMessage: string,
  assistantAnswer: string,
  history: { role: 'user' | 'assistant'; content: string }[],
  chats: IMessageChatLite[],
): Promise<SendDraft | null> {
  // Decision gate (2026-09-24, purpose 'imessage_send'): one cheap typed
  // judgment BEFORE the ~8 s utility reasoning call. shadow = ask, then run
  // the utility call as before and record what it concluded next to the
  // gate's answer; act = when the gate is confidently NOT-a-send, skip the
  // utility call. The gate can only remove work: any error here falls
  // through to the pre-gate path, and decide() itself never throws.
  let gate: DecideResult | null = null;
  // SHADOW runs the gate CONCURRENTLY with the utility call (no latency added
  // to the answer path); only ACT awaits it first, because a confident
  // not-a-send skips the utility call entirely.
  let gatePending: Promise<DecideResult | null> | null = null;
  try {
    const mode = decisionMode('imessage_send');
    if (mode !== 'off') {
      const ask = decide(
        { latest_user_message: latestUserMessage.slice(0, 2000), assistant_answer_head: assistantAnswer.slice(0, 1200) },
        {
          send: {
            type: 'noul',
            instructions: 'The LATEST user message is asking Digby to send / deliver / fire off a message to someone right now (not merely drafting, editing, or discussing a message).',
            criteria: { true: 'the user clearly wants a message sent now', false: 'the user is drafting, refining, discussing, or the message is unrelated to sending' },
          },
        },
        { purpose: 'imessage_send', timeoutMs: 1500 },
      );
      if (mode === 'act') {
        gate = await ask;
        const send = gate?.answers.send;
        // + 1e-9 guards the floating-point edge (1 − 0.85 = 0.15000000000000002).
        const notSendCutoff = 1 - decisionThreshold('imessage_send', 0.85) + 1e-9;
        // E2 (2026-09-25): the RESULT's mode gates acting (an uncalibrated backend answers as 'shadow').
        if (gate?.mode === 'act' && send && send.type === 'noul' && send.noul <= notSendCutoff) {
          recordDecisionOutcome(gate, 'imessage_send', { question: 'send', actual: null, acted: true });
          logger.debug(`classifySendDraft: decision gate confidently NOT a send (noul ${send.noul.toFixed(3)}) — skipping the utility classification`);
          return null;
        }
      } else {
        gatePending = ask;
      }
    }
  } catch (e: any) {
    logger.debug(`classifySendDraft: decision gate failed open: ${e?.message || e}`);
  }

  let recipient = '';
  let text = '';
  let wantsSend = false;
  try {
    const recent = history.slice(-6)
      .map(m => `${m.role === 'assistant' ? 'Digby' : 'User'}: ${m.content.slice(0, 1500)}`)
      .join('\n');
    const raw = await utilityChat(
      [
        {
          role: 'system',
          content:
            'You decide whether the user is asking Digby to SEND an iMessage/text right now, ' +
            'reasoning from the conversation (do NOT rely on specific trigger words). Return ONLY ' +
            'compact JSON {"send": boolean, "recipient": string, "message": string}. ' +
            'send=true ONLY if the LATEST user message is clearly asking to send/deliver/fire off a ' +
            'message to someone now (not merely drafting, editing, or discussing). ' +
            'recipient = who to send to (a name, phone number, or email mentioned by the user). ' +
            'message = the EXACT body to send — normally the message Digby composed in its answer; ' +
            'use that verbatim, stripped of any conversational wrapper. If the user is only asking to ' +
            'draft/refine/discuss, or it is unrelated, return {"send":false,"recipient":"","message":""}. ' +
            // audit 2026-10-08 W4-6: "message the tt-rd supervisor" on a supervisor chat drafted an iMessage card.
            'A message to a Digby chat, lane, session, project, agent or supervisor (e.g. "message the tt-rd supervisor", ' +
            '"tell the lane", "ping the coding session") is an IN-APP message, never an iMessage — return send:false for it.',
        },
        {
          role: 'user',
          content:
            `CONVERSATION SO FAR:\n${recent}\n\n` +
            `LATEST USER MESSAGE:\n${latestUserMessage}\n\n` +
            `DIGBY'S COMPOSED ANSWER (the message body usually lives here):\n${assistantAnswer.slice(0, 4000)}`,
        },
      ],
      // 2026-06-27: retryNotFound so the daily ~6am UTC provider maintenance window
      // doesn't silently drop the send classification — a null here means the
      // send-confirmation modal never appears (reported bug: user rephrased 3x because
      // "the modal didn't pop up"). This is user-initiated and latency-tolerant.
      { maxTokens: 700, temperature: 0, contentOnly: true, timeout: 8000, retryNotFound: true },
    );
    const slice = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(slice);
    wantsSend = parsed.send === true;
    recipient = String(parsed.recipient || '').trim();
    text = String(parsed.message || '').trim();
  } catch (e: any) {
    logger.warn(`classifySendDraft: could not classify send intent: ${e?.message || e}`);
    recordDecisionOutcome(gate ?? await gatePending?.catch(() => null) ?? null, 'imessage_send', { question: 'send', actual: wantsSend, acted: false, note: 'utility classification failed' });
    return null;
  }
  const decision = gate ?? await gatePending?.catch(() => null) ?? null;
  // E5: a draft that SURFACES a confirm card defers its label to the card's
  // Send / Cancel (the user's real intent — the utility verdict was recorded
  // as `actual` before, so the positive class was never measurable). A
  // non-surfacing verdict still closes the decision here. Fail-safe: any
  // stash problem falls back to the classification-time row.
  let deferred: DecisionStash | null = null;
  if (decision && wantsSend && !!text) {
    try { deferred = stashDecision(decision, 'imessage_send'); } catch { deferred = null; }
  }
  if (!deferred) recordDecisionOutcome(decision, 'imessage_send', { question: 'send', actual: wantsSend, acted: false });

  if (!wantsSend || !text) return null;

  let to = '';
  let displayName = recipient;
  if (recipient) {
    if (looksLikePhoneOrEmail(recipient)) {
      to = recipient.replace(/[()\-\s]/g, '');
      displayName = recipient;
    } else {
      const match = resolveNamedChat(recipient, chats);
      if (match) {
        to = match.identifier || '';
        displayName = match.displayName || match.identifier || recipient;
      }
    }
  }
  return { to, displayName: displayName || recipient || 'someone', text, resolved: !!to, ...(deferred ? { decision: deferred } : {}) };
}

/**
 * Parse a send request ("text Sarah I'll be late", "send a message to +1555… saying hi")
 * into {recipient, message}, then resolve the recipient against the user's
 * conversations. Returns null when the input isn't actually a send request, so
 * the caller falls back to the normal chat flow.
 */
export async function extractSendDraft(
  message: string,
  chats: IMessageChatLite[],
): Promise<SendDraft | null> {
  let recipient = '';
  let text = '';
  try {
    const raw = await utilityChat(
      [
        {
          role: 'system',
          content:
            'You extract an iMessage send request. Return ONLY compact JSON of the form ' +
            '{"recipient": string, "message": string}. recipient = who to text (a name, ' +
            'phone number, or email). message = the exact text to send. If the input is NOT ' +
            'a request to send a text message, return {"recipient":"","message":""}.',
        },
        { role: 'user', content: message },
      ],
      // retryNotFound: survive the ~6am UTC maintenance window (see classifySendDraft).
      { maxTokens: 220, temperature: 0, contentOnly: true, timeout: 8000, retryNotFound: true },
    );
    const slice = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    const parsed = JSON.parse(slice);
    recipient = String(parsed.recipient || '').trim();
    text = String(parsed.message || '').trim();
  } catch (e: any) {
    logger.warn(`extractSendDraft: could not parse send request: ${e?.message || e}`);
  }

  if (!text) return null; // not a usable send request

  let to = '';
  let displayName = recipient;
  if (recipient) {
    if (looksLikePhoneOrEmail(recipient)) {
      to = recipient.replace(/[()\-\s]/g, '');
      displayName = recipient;
    } else {
      const match = resolveNamedChat(recipient, chats);
      if (match) {
        to = match.identifier || '';
        displayName = match.displayName || match.identifier || recipient;
      }
    }
  }

  return { to, displayName: displayName || recipient || 'someone', text, resolved: !!to };
}
