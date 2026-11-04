/**
 * Placeholder-title detection on the client (owner 2026-09-22: a new chat kept
 * showing its raw first message — "can you get all newest trending post on
 * x.com about…" — as its sidebar title although the server had generated
 * "Latest AI Trends and Releases on X" minutes earlier).
 *
 * The generated title reaches the sidebar through the 'chat-title' stream
 * frame. A 10-minute tool-heavy first turn outlives the attach replay window
 * and reconnects, so that early frame can be missed, and the `autoTitle` the
 * server also echoes on 'complete' was never read. Mirrors the server's
 * isStaleChatTitle shapes (chat-agent/title-placeholder.ts) so the view can
 * decide, at run end, whether the title it holds is still the placeholder and
 * ask the server for the real one. Pure.
 */
export function isPlaceholderChatTitle(title: string | null | undefined, firstUserMessage: string | null | undefined): boolean {
  const t = String(title ?? '').trim();
  if (!t) return true;
  if (t === 'New Conversation' || t === 'New Chat' || t === 'Untitled chat' || t.length <= 3) return true;
  if (t.endsWith('…') || t.endsWith('...')) return true;
  const msg = String(firstUserMessage ?? '').replace(/\s+/g, ' ').trim();
  if (!msg) return false;
  const tl = t.toLowerCase();
  const ml = msg.toLowerCase();
  if (tl === ml.slice(0, 60).trim()) return true;
  if (t.length >= 20 && ml.includes(tl)) return true;
  const head = ml.slice(0, 20);
  if (head.length > 10 && tl.startsWith(head)) return true;
  return false;
}
