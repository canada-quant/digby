/**
 * Guest stream reconnect (stream drops, 2026-10-20 — owner: "why does
 * connection drop?").
 *
 * A guest (anonymous) chat has no chat row, so when its live answer's
 * EventSource dropped the view could only say "Connection lost — send your
 * message again to retry" — while the run kept going server-side, and a resend
 * then hit "Digby is still working on the previous message". The backend now
 * has a guest twin of the signed-in attach — GET
 * /api/crossmodel/session/:sessionId/stream (the unguessable session uuid is
 * the credential, like /session/:id/state) — so the view reconnects a guest
 * with the same backoff as a signed-in chat, and the focus / visibility /
 * network-back resync covers guests too.
 *
 * Pure helpers (CodeSessionView wires them):
 *   - guestReconnectSessionId — the guest session this tab may reconnect, or
 *     null (signed-in, chatless without a session, the switch off);
 *   - buildGuestAttachUrl — the attach URL (no token: the uuid is the key);
 *   - reconnectBackoff — the ONE backoff both paths use (1/2/4/8/15 s, then
 *     every 15 s in the slow phase).
 *
 * NEXT_PUBLIC_GUEST_STREAM_RECONNECT_DISABLED=1 restores the dead end (no guest
 * reconnect, no guest resync). NEXT_PUBLIC_ONLINE_RESYNC_DISABLED=1 drops the
 * window 'online' resync (every surface).
 */

export function guestStreamReconnectDisabled(): boolean {
  return process.env.NEXT_PUBLIC_GUEST_STREAM_RECONNECT_DISABLED === '1';
}

export function onlineResyncDisabled(): boolean {
  return process.env.NEXT_PUBLIC_ONLINE_RESYNC_DISABLED === '1';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The guest session id a dropped stream can reconnect through, or null. Only a
 * chatless (sid == null) GUEST plain view with a uuid-shaped session id
 * qualifies — signed-in chats keep their own attach; the signed-in chatless
 * fallback has no session id and stays a dead end.
 */
export function guestReconnectSessionId(
  plain: { guest?: boolean; guestSessionId?: string | null } | null | undefined,
  sid: string | null | undefined,
): string | null {
  if (guestStreamReconnectDisabled()) return null;
  if (!plain || sid != null || !plain.guest) return null;
  const g = plain.guestSessionId;
  return typeof g === 'string' && UUID_RE.test(g) ? g : null;
}

/** GET /api/crossmodel/session/:sessionId/stream (cache-busted like the signed-in attach URL). */
export function buildGuestAttachUrl(sessionId: string, now: number = Date.now()): string {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
  return `${apiBase}/crossmodel/session/${encodeURIComponent(sessionId)}/stream?${new URLSearchParams({ _t: String(now) })}`;
}

/** Number of fast retries before the slow phase (reconcile with the server first, then every 15 s). */
export const RECONNECT_FAST_ATTEMPTS = 6;
export const RECONNECT_SLOW_DELAY_MS = 15_000;

/**
 * The reconnect delay after `attempts` failures so far: 1, 2, 4, 8, 15, 15 s,
 * then the slow phase (every 15 s, reconciling against the server first).
 */
export function reconnectBackoff(attempts: number): { slow: boolean; delay: number } {
  const slow = attempts >= RECONNECT_FAST_ATTEMPTS;
  const delay = slow ? RECONNECT_SLOW_DELAY_MS : Math.min(1000 * 2 ** attempts, RECONNECT_SLOW_DELAY_MS);
  return { slow, delay };
}
