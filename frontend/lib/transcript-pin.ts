/**
 * Transcript "pinned to the bottom" decision — ONE pure rule for every
 * streaming transcript (CodeSessionView's chat scroller, the supervisor
 * thread), so the scroll-up experience cannot drift between surfaces.
 *
 * Owner recording 2026-09-18 ("when responses are generating, if you try and
 * scroll up … it won't let you"): the old rule re-pinned on EVERY scroll event
 * that landed within 80px of the bottom, checked BEFORE the upward-move test.
 * A wheel or trackpad scroll-up starts with small moves (10–60px), so each of
 * those events re-pinned the view; the next content growth (a streamed chunk,
 * the once-a-second "1m 59s" elapsed clock re-render, an ad rotation) then
 * scrolled straight back to the bottom. Frame analysis of the recording shows
 * exactly that: content moves up 30–70px, snaps back within a second, five
 * times in a row, until one hard flick clears 80px inside a single tick.
 *
 * The rule now:
 *  1. An UPWARD move that leaves the view away from the bottom is the user
 *     reading — unpin at once, whatever the distance, and open a short gesture
 *     window so the trailing events of the same gesture (trackpad momentum,
 *     a following anchoring bump) cannot re-pin it.
 *  2. Landing EXACTLY at the bottom always re-pins (a wheel-down or fling
 *     clamps there; so does a scroller clamp after content shrinks — that one
 *     LOOKS like an upward move but leaves dist ≈ 0, which is why the
 *     at-bottom test is checked before treating it as a user scroll-up).
 *  3. Landing NEAR the bottom (< 80px) re-pins only outside the gesture window
 *     — the tolerance still covers "scrolled down to about the end" without
 *     fighting a scroll-up in progress.
 *  4. Anything else keeps the current pin (downward moves far from the bottom
 *     include Chrome scroll-anchoring bumps and programmatic scrolls — PR #100).
 */

export const NEAR_BOTTOM_PX = 80;
/** How long after the last upward user move a near-bottom landing may NOT re-pin. */
export const UP_GESTURE_WINDOW_MS = 400;
/** dist ≤ this counts as "at the bottom" (fractional-scroll noise). */
const AT_BOTTOM_EPSILON_PX = 1;

export interface TranscriptPinState {
  pinned: boolean;
  /** scrollTop seen at the previous scroll event. */
  lastTop: number;
  /** Timestamp (ms) until which near-bottom landings must not re-pin. */
  upGestureUntil: number;
}

export interface TranscriptScrollSample {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Date.now() at the event. */
  now: number;
}

export interface TranscriptPinDecision {
  next: TranscriptPinState;
  /** Whether the "Jump to latest" pill should be visible after this event. */
  showJump: boolean;
}

export function initialTranscriptPinState(pinned = true): TranscriptPinState {
  return { pinned, lastTop: 0, upGestureUntil: 0 };
}

export function decideTranscriptPin(state: TranscriptPinState, s: TranscriptScrollSample): TranscriptPinDecision {
  const dist = s.scrollHeight - s.scrollTop - s.clientHeight;
  const atBottom = dist <= AT_BOTTOM_EPSILON_PX;
  const movedUp = s.scrollTop < state.lastTop - 1;
  const inUpGesture = s.now < state.upGestureUntil;

  let pinned = state.pinned;
  let upGestureUntil = state.upGestureUntil;
  if (atBottom) {
    pinned = true;
  } else if (movedUp) {
    pinned = false;
    upGestureUntil = s.now + UP_GESTURE_WINDOW_MS;
  } else if (dist < NEAR_BOTTOM_PX && !inUpGesture) {
    pinned = true;
  }
  return {
    next: { pinned, lastTop: s.scrollTop, upGestureUntil },
    showJump: !pinned,
  };
}

// ─── Turn anchor: stop following at the START of the newest turn ────────────
//
// Owner 2026-10-07: "when a session outputs a message it pulls the user to the
// bottom and they have to scroll all the way up to the beginning of the
// response". While pinned, the transcript now follows new content only until
// the newest turn's start (the user's question, or a standalone post) reaches
// the top of the viewport; after that the reader is left at the beginning of
// the reply and scrolls down at their own pace. Scrolling to the bottom by
// hand (or "Jump to latest") opts that turn back into full follow.

/** Breathing room kept above the anchor when the view stops on it. */
export const TURN_ANCHOR_GAP_PX = 16;
/** A long question keeps at most this much of itself above the reply. */
export const TURN_ANCHOR_MAX_QUESTION_PX = 120;

/**
 * Index of the row the newest turn starts at, from the rendered rows' roles in
 * order. The last user row anchors its own turn (its reply — live block or the
 * one appended assistant row — sits under it); two or more assistant rows after
 * it mean a later standalone post (a hand-off result, a background report), so
 * the newest row anchors. No user row ⇒ the newest row. -1 for no rows.
 */
export function turnAnchorIndex(roles: readonly string[]): number {
  if (roles.length === 0) return -1;
  const lastUser = roles.lastIndexOf('user');
  if (lastUser < 0) return roles.length - 1;
  return roles.length - 1 - lastUser >= 2 ? roles.length - 1 : lastUser;
}

/**
 * Where a pinned transcript should sit. `anchor` is the anchor row's box in
 * scroller coordinates (top / height, px); null ⇒ plain bottom-follow. The stop
 * line keeps at most TURN_ANCHOR_MAX_QUESTION_PX of a long question visible.
 */
export function followTarget(s: { scrollHeight: number; clientHeight: number }, anchor: { top: number; height: number } | null): { top: number; capped: boolean } {
  const bottom = Math.max(0, s.scrollHeight - s.clientHeight);
  if (!anchor) return { top: bottom, capped: false };
  const start = Math.max(anchor.top, anchor.top + anchor.height - TURN_ANCHOR_MAX_QUESTION_PX);
  const stop = Math.max(0, start - TURN_ANCHOR_GAP_PX);
  return stop < bottom ? { top: stop, capped: true } : { top: bottom, capped: false };
}
