/**
 * Sidebar attention rule (owner 2026-09-16: "i shouldn't have green indicators
 * on sessions when there are just system or machine to machine messages …
 * only when the message is actually for the end user should it show a green
 * dot").
 *
 * Every persisted row carries `metadata.origin` — the TRIGGER of the turn:
 * a human turn has none (legacy UI sends) or 'user' (owner-anchored REST
 * sends); machine turns are 'schedule' / 'hook' / 'agent' / 'machine' /
 * 'attention-watchdog' / 'owner-inbox', and harness cards are
 * 'project_status' / 'session_status'. The unread dot means "a reply to YOU
 * is waiting", so it lights only for an assistant row whose turn a human
 * started. The chat list exposes the newest row's origin as
 * `lastMessageOrigin`; an older backend omits it and the legacy rule
 * (assistant + newer than last view) applies unchanged.
 */
export function isMessageForUser(origin: string | null | undefined): boolean {
  if (origin === undefined || origin === null || origin === '') return true;
  return origin === 'user';
}

/** The unread predicate shared by the chat rows and the folder roll-up. */
export function chatHasUnreadReply(chat: {
  lastMessageRole?: string | null;
  lastMessageAt?: string | null;
  lastMessageOrigin?: string | null;
}, viewedAtMs: number): boolean {
  if (chat.lastMessageRole !== 'assistant' || !chat.lastMessageAt) return false;
  if (!isMessageForUser(chat.lastMessageOrigin)) return false;
  const t = Date.parse(chat.lastMessageAt);
  if (!Number.isFinite(t)) return false;
  return viewedAtMs > 0 && t > viewedAtMs;
}
