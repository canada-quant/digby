import type { PendingConfirmation } from '@/lib/api/crossmodel';

/**
 * Inline confirm cards (ticket cbdb4614) — select the DB-persisted staged
 * consequential-tool confirmations that belong to the OPEN chat and are still
 * actionable, for the inline card CodeSessionView renders at the bottom of the
 * transcript.
 *
 * Why this exists: staged confirmations (kind 'confirmation') used to surface
 * ONLY in the sidebar rail banner (collapsed by default since #711), the
 * Management → Inbox tab, and the supervisor overview panel — never inline in
 * the conversation the user is watching (and the rail sits behind a drawer on
 * mobile). A user whose agent staged an action and asked them to confirm could
 * reasonably report "i never saw a confirm card". The chat view now renders
 * these inline from the same 20s /confirmations/pending poll.
 *
 * Filter semantics mirror the sidebar rail's actionable branch (page.tsx):
 *  - kind 'confirmation' only — ask_user questions/approvals already render
 *    inline via the SSE-driven pendingQuestion/pendingApproval cards, and
 *    owner_questions live in the decisions queue;
 *  - NOT expired (a lapsed trace is non-actionable — the rail shows it as a
 *    muted "expired unconfirmed" row);
 *  - NOT stale (past the execution-freshness horizon: Confirm would refuse —
 *    the rail offers Dismiss-only with a re-stage hint);
 *  - chatId must match the open chat exactly; null/empty chatId selects nothing
 *    (chatless guests never have staged confirmations).
 *
 * Sorted by ts ascending so the oldest staged action is confirmed first when
 * more than one is pending.
 */
export function selectLiveChatConfirmations(
  list: readonly PendingConfirmation[],
  chatId: string | null | undefined,
): PendingConfirmation[] {
  if (!chatId || !Array.isArray(list)) return [];
  return list
    .filter((p) => p && p.kind === 'confirmation' && !p.expired && !p.stale && p.chatId === chatId)
    .slice()
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

// Cohesive chat (2026-09-28, review fixer): NO client-side hide rule for
// staged cards. The server is the only authority on whether a spawn needs a
// click — a human-turn `start_coding_session` is never STAGED once requested
// work executes card-free (platform/work-tools.ts), and whenever the server
// does stage one (WORK_TOOLS_NO_CARD_DISABLED=1, an out-of-scope call, or a
// user-anchored MACHINE run) the card is a real affordance that must render
// inline and in the rail, or it expires unconfirmed. The listing's `machine`
// flag (pending_confirmations.origin) is informational only.

/**
 * The open chat's agent-flagged owner questions (kind 'owner_question'),
 * triaged or not — rendered in-flow as an answerable OwnerQuestionCard (owner
 * 2026-09-22: the rail link opened the chat and the chat showed nothing to act
 * on). Sorted oldest-first; [] for a chatless view.
 */
export function selectLiveChatOwnerQuestions(
  list: readonly PendingConfirmation[],
  chatId: string | null | undefined,
): PendingConfirmation[] {
  if (!chatId || !Array.isArray(list)) return [];
  return list
    .filter((p) => p && p.kind === 'owner_question' && p.chatId === chatId)
    .slice()
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}
