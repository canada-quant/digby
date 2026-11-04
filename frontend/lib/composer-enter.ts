/**
 * composer-enter — the ONE place Enter-key semantics for message composers are
 * decided (ticket 67fc53a7, owner report 2026-09-14).
 *
 * The contract for every multi-line message composer (main chat, coding
 * session chat, plain chat in the coding view, supervisor chat, edge-instance
 * chat, profile interview):
 *
 *   - TOUCH-PRIMARY devices (phones/tablets — `pointer: coarse`): plain Enter
 *     inserts a NEWLINE, iMessage-style; sending is the Send button's job.
 *   - DESKTOP (fine pointer): plain Enter SENDS; Shift+Enter inserts a newline.
 *   - Cmd/Ctrl+Enter ALWAYS sends, on every device (an explicit modifier is an
 *     unambiguous "send now" even on touch devices with a hardware keyboard).
 *
 * Before 2026-09-14 the chat composer forced Enter=newline on ALL devices
 * (commit 41c534372, an iMessage-parity request that leaked onto desktop).
 */

/**
 * True when the device's PRIMARY pointing device is coarse (touch). Evaluated
 * at CALL time (a keydown handler) — no React state, so there is no SSR /
 * hydration mismatch: server render and the first client render behave
 * identically, and the decision is always fresh at keypress time.
 * `pointer: coarse` is the right signal (a touchscreen laptop keeps a fine
 * primary pointer); maxTouchPoints is only the no-matchMedia fallback.
 */
export function isTouchPrimary(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia('(pointer: coarse)').matches;
  }
  return typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0;
}

export interface EnterKeyLike {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** Direct flag (tests / non-React callers). */
  isComposing?: boolean;
  /** React passes its synthetic event through: the native event carries the flag. */
  nativeEvent?: { isComposing?: boolean };
}

/**
 * Should this Enter keydown submit the composer (true) or fall through to the
 * textarea's default newline (false)?
 *
 * `submitOnEnter` is the per-composer override:
 *   - undefined → device-aware default: desktop submits, touch newline.
 *   - true/false → forced (kept for hosts with a genuine reason + for tests).
 * `touchPrimary` is a parameter (not read internally) so the decision stays a
 * pure, unit-testable function — the caller passes isTouchPrimary().
 *
 * IME SAFETY: during an active CJK input-method composition, Enter CONFIRMS a
 * candidate — intercepting it would send a half-composed message (the B1
 * review finding, 2026-09-14). Composition always wins, even over modifiers.
 */
export function enterKeySubmits(
  e: EnterKeyLike,
  submitOnEnter: boolean | undefined,
  touchPrimary: boolean,
): boolean {
  if (e.key !== 'Enter') return false;
  if (e.isComposing ?? e.nativeEvent?.isComposing) return false;
  if (e.metaKey || e.ctrlKey) return true;
  const submit = submitOnEnter ?? !touchPrimary;
  return submit && !e.shiftKey;
}
