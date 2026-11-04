/**
 * get_chat_messages `before` cursor resolution (2026-09-24). Prod: 30 tool
 * failures / 7 d with "Invalid before cursor for this chat" and no recovery
 * path in the message. Two real causes: (1) models cite ids by their first 8
 * chars (the citation doctrine) and pass that prefix back as the cursor — an
 * exact-id lookup can never match; (2) a cursor copied from ANOTHER chat's
 * page. Resolution now accepts a full message id OR a ≥8-char id prefix that
 * is unique within THIS chat, and the refusal tells the model exactly what to
 * pass. Pure over an injected finder so it unit-tests without prisma.
 */
export interface CursorRow { id: string; chatId: string; createdAt: Date }
export interface CursorFinder {
  byId(id: string): Promise<CursorRow | null>;
  /** Rows of THIS chat whose id starts with `prefix` (at most 2 needed). */
  byPrefixInChat(chatId: string, prefix: string): Promise<CursorRow[]>;
}
export type CursorResolution =
  | { ok: true; before: { createdAt: Date; id: string }; resolvedFrom: 'id' | 'prefix' }
  | { ok: false; reason: 'other_chat' | 'not_found' | 'ambiguous' | 'malformed'; message: string };

const HELP = "Pass the `nextBefore` value returned by a previous get_chat_messages page of THIS chat (a full message id from this chat, or its unique ≥8-char prefix, also works). Cursors from other chats are not accepted.";

export async function resolveBeforeCursor(finder: CursorFinder, chatId: string, before: string): Promise<CursorResolution> {
  const raw = String(before ?? '').trim();
  if (!raw) return { ok: false, reason: 'malformed', message: `Invalid before cursor for this chat — empty. ${HELP}` };
  // Exact id first, whatever its shape (callers and tests may use short ids).
  const exact = await finder.byId(raw);
  if (exact) {
    if (exact.chatId !== chatId) {
      return { ok: false, reason: 'other_chat', message: `Invalid before cursor for this chat — ${raw.slice(0, 8)} is a message of a DIFFERENT chat (${String(exact.chatId).slice(0, 8)}). ${HELP}` };
    }
    // The compound bound keeps the caller's id string (mirrors the sort's id tiebreak).
    return { ok: true, before: { createdAt: exact.createdAt, id: exact.id ?? raw }, resolvedFrom: 'id' };
  }
  // Citation-doctrine prefix (8+ chars, shorter than a full uuid), unique within THIS chat.
  if (raw.length >= 8 && raw.length < 36 && /^[0-9a-zA-Z_-]+$/.test(raw)) {
    const matches = await finder.byPrefixInChat(chatId, raw);
    if (matches.length === 1) return { ok: true, before: { createdAt: matches[0].createdAt, id: matches[0].id }, resolvedFrom: 'prefix' };
    if (matches.length > 1) return { ok: false, reason: 'ambiguous', message: `Invalid before cursor for this chat — prefix "${raw}" matches ${matches.length} messages here; pass more characters or the full id. ${HELP}` };
  }
  return { ok: false, reason: 'not_found', message: `Invalid before cursor for this chat — no message ${raw.slice(0, 8)}… exists in it. ${HELP}` };
}
