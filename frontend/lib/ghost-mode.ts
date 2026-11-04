/**
 * Ghost mode (2026-10-22) — the ONE copy + the guest-side per-session flag.
 *
 * Per-chat private mode for BOTH guests and signed-in users: when on, the
 * chat's models are routed to the admin-designated self-hosted endpoint (see
 * Account → Admin → Endpoints → Model roles → Ghost mode) and the chat is
 * kept out of memory, learning and cross-chat surfacing.
 *
 * Signed-in users: the flag lives on the chat row (ghostMode, PUT /chats/:id)
 * and the backend applies the routing server-side — nothing client-side to
 * persist. Guests: there is no chat row, so the flag is browser-local per
 * guest session (the guest-session store pattern — SSR-safe, never throws,
 * chat must never break) and EVERY send of that session carries ghost=true on
 * the open /crossmodel/stream endpoint (plain-session.ts).
 *
 * This module is PURE (no React) so it unit-tests like guest-sessions.ts.
 */

/** The honest one-liner every ghost affordance shows (tooltip / hint). The
 *  privacy guarantees it names ARE implemented backend-side — keep it exactly
 *  in sync with the help doc (docs/GHOST_MODE.md) when wording changes. */
export const GHOST_MODE_TOOLTIP =
  "Ghost mode routes this chat through the admin's private endpoint and keeps it out of memory and learning. Your transcript stays in your account.";

/** Shorter rail/header indicator text (shown only while ghost is ON). */
export const GHOST_MODE_ACTIVE_LABEL = 'Ghost mode on';

const GUEST_GHOST_PREFIX = 'digbyGuestGhost.v1:';

const keyOf = (sessionId: string): string => GUEST_GHOST_PREFIX + sessionId;

/**
 * Whether a guest session runs in ghost mode. False when absent, during SSR,
 * or on any storage failure — ghost OFF is the safe default (the feature
 * changes routing; it must never silently flip on).
 */
export function getGuestGhost(sessionId: string | null | undefined): boolean {
  if (typeof window === 'undefined' || !sessionId) return false;
  try {
    return window.localStorage.getItem(keyOf(sessionId)) === '1';
  } catch {
    return false;
  }
}

/**
 * Set (or clear) a guest session's ghost flag. Never throws — a blocked or
 * full localStorage skips persistence, same contract as the guest-session
 * store (the in-memory React state still drives the current conversation).
 */
export function setGuestGhost(sessionId: string | null | undefined, on: boolean): void {
  if (typeof window === 'undefined' || !sessionId) return;
  try {
    if (on) window.localStorage.setItem(keyOf(sessionId), '1');
    else window.localStorage.removeItem(keyOf(sessionId));
  } catch {
    /* best-effort — chat must never break */
  }
}

/** Forget a session's flag entirely (guest session deleted). Never throws. */
export function clearGuestGhost(sessionId: string | null | undefined): void {
  if (typeof window === 'undefined' || !sessionId) return;
  try {
    window.localStorage.removeItem(keyOf(sessionId));
  } catch {
    /* best-effort */
  }
}
