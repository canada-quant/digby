/**
 * iMessage send-draft decision outcome (E5 honest labels, 2026-09-25).
 *
 * The `imessage_send` decision gate (nlp.ts classifySendDraft) used to close
 * every shadow decision with the UTILITY CLASSIFIER's verdict as `actual` —
 * 45/45 agreed, 0 positives in 7 days: the label was the other model's
 * opinion, not the user's intent, so the flip bar ("≥30 labelled POSITIVE
 * sends") could never be met. A draft that SURFACES the confirm card now
 * defers its label: the decision stash parks here (Redis, short TTL, keyed
 * by user + decision id) and the card's Send (confirmed ⇒ actual:true) or
 * Cancel (declined ⇒ actual:false) writes the outcome row against the STORED
 * answer, so `agreed` is computed on the user's real intent.
 *
 * Kept OUT of nlp.ts on purpose: this module pulls config/redis (env
 * validation); nlp.ts stays dependency-light and the chat finalize / the
 * controller import this lazily. Every path is fail-open and never throws
 * into a send: a lost stash simply leaves the decision unlabelled.
 */

import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { reconstructDecision, recordDecisionOutcome, type DecisionStash } from '../platform/decision-gate';

/** How long a surfaced card may wait for Send / Cancel before the label is lost. */
export const SEND_DRAFT_DECISION_TTL_SEC = 6 * 3600;

export type SendDraftOutcome = 'confirmed' | 'declined';

const key = (userId: string, decisionId: string) => `imsg_send_decision:${userId}:${decisionId}`;

/** True for a well-formed decision id (8 hex chars from decide(), or any short token) — rejects garbage keys. */
export function validSendDraftDecisionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(id);
}

/** Park the surfaced draft's decision until the card is answered. Returns false when nothing was stored. */
export async function stashSendDraftDecision(userId: string, stash: DecisionStash | null | undefined): Promise<boolean> {
  if (!userId || !stash || !validSendDraftDecisionId(stash.id)) return false;
  try {
    await redisClient.set(key(userId, stash.id), JSON.stringify(stash), { EX: SEND_DRAFT_DECISION_TTL_SEC });
    return true;
  } catch (err: any) {
    logger.debug(`send-draft-outcome: stash failed (label lost, non-fatal): ${err?.message || err}`);
    return false;
  }
}

/**
 * Record the card's answer against the parked decision. Returns true when a
 * stash was found and the outcome row was written; false for an unknown /
 * expired id (already answered, or the card outlived the TTL). Never throws.
 */
export async function recordSendDraftOutcome(userId: string, decisionId: unknown, outcome: SendDraftOutcome): Promise<boolean> {
  if (!userId || !validSendDraftDecisionId(decisionId)) return false;
  try {
    const k = key(userId, decisionId);
    const raw = await redisClient.get(k);
    if (!raw) return false;
    await redisClient.del(k).catch(() => {});
    const decision = reconstructDecision(JSON.parse(raw));
    if (!decision || decision.purpose !== 'imessage_send') return false;
    recordDecisionOutcome(decision, 'imessage_send', {
      question: 'send',
      actual: outcome === 'confirmed',
      acted: false,
      note: `modal: ${outcome}`,
    });
    return true;
  } catch (err: any) {
    logger.debug(`send-draft-outcome: record failed (non-fatal): ${err?.message || err}`);
    return false;
  }
}
