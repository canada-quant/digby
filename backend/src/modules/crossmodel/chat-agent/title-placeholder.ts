// ─── Chat placeholder title — ONE canonical definition ─────────────────────
// The frontend pre-seeds a brand-new chat's sidebar title from the first
// message (frontend/app/crossmodel/page.tsx — auto-create chat block), and the
// backend stale-title repair must recognize that EXACT shape to give a chat
// its second chance (ticket 26385762). Previously the two ends matched only by
// two accidents: the frontend used slice(0,60)+'…' UNTRIMMED while the backend
// compared against substring(0,60).trim() with no ellipsis, and separately
// leaned on a catch-all endsWith('…'). KEEP THE FRONTEND FORMULA IN SYNC —
// it mirrors placeholderTitle() verbatim (cross-reference comment on both ends).
export function placeholderTitle(message: string): string {
  return message.slice(0, 60) + (message.length > 60 ? '…' : '');
}

// Stale shapes worth repairing (legacy heuristics, audit p10 + ticket 26385762):
// the frontend placeholder itself, any '…'-terminated truncation, the stock
// placeholders, the raw question verbatim, a near-empty title, or any
// ≥20-char substring of the question (local-fallback truncation patterns).
export function isStaleChatTitle(title: string, message: string): boolean {
  const trimmedMsg = message.substring(0, 60).trim();
  const titleLc = title.toLowerCase();
  const msgLc = message.toLowerCase();
  return (
    title === placeholderTitle(message) ||
    title.endsWith('…') ||
    title === 'New Conversation' ||
    title === 'New Chat' ||
    title === trimmedMsg ||
    title.length <= 3 ||
    (title.length >= 20 && msgLc.includes(titleLc)) ||
    (trimmedMsg.length > 10 && titleLc.startsWith(trimmedMsg.substring(0, 20).toLowerCase()))
  );
}
