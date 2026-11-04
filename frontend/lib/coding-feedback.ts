/**
 * In-chat feedback on CODING-session answers (ticket bd5b95b5, 2026-10-06: "feedback in chat button is not available
 * for coding session").
 *
 * Plain chats render PlainMessageActions (Copy · 👍 · 👎 Report issue · Read aloud) under every assistant answer; a
 * coding session's assistant rows carried only a timestamp line. The coding row now renders the SAME component —
 * same feedback form, same POST /crossmodel/feedback (feedbackApi.submit), same Account → Feedback ticket — with the
 * row's timestamp inside it, exactly as plain chats show it.
 *
 * Which rows: an assistant row with a PERSISTED id (a crossmodel_messages uuid — the coding transcript's merged read
 * serves those, and the coding dual-write mirrors every coding_messages row under the same id; fresh / streamed rows
 * carry a-… / tmp- / m-<i>- placeholders the feedback schema would 400 on) in a chat that exists. A project MEMBER
 * watching someone else's session keeps Copy + Read aloud but no feedback controls (the endpoint is owner-only —
 * PlainMessageActions hides 👍/👎 when chatId is '').
 */

const PERSISTED_MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A server row id the feedback endpoint can link (z.string().uuid()) — never a client placeholder. */
export function isPersistedMessageId(id: string | null | undefined): boolean {
  return typeof id === 'string' && PERSISTED_MESSAGE_ID_RE.test(id);
}

export interface CodingActionRow {
  /** The chatId PlainMessageActions gets: '' hides 👍/👎 (and the form) for a member viewer. */
  feedbackChatId: string;
  messageId: string;
}

/**
 * The action row a coding-session row renders, or null for the legacy timestamp-only line (a user row, a placeholder
 * id, no chat, a kid session, or the kill switch).
 */
export function codingActionRowFor(opts: {
  role: string;
  id: string;
  chatId: string | null | undefined;
  isKid?: boolean;
  memberViewOnly?: boolean;
}): CodingActionRow | null {
  if (opts.role !== 'assistant' || opts.isKid || !opts.chatId) return null;
  if (!isPersistedMessageId(opts.id)) return null;
  return { feedbackChatId: opts.memberViewOnly ? '' : opts.chatId, messageId: opts.id };
}
