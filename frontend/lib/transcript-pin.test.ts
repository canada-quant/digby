/**
 * Pins for lib/transcript-pin.ts — the owner's 2026-09-18 recording: a slow
 * scroll-up during a streaming response must unpin on the FIRST upward move,
 * not only once it clears the 80px near-bottom band.
 */

import { describe, expect, it } from 'vitest';
import { decideTranscriptPin, followTarget, initialTranscriptPinState, NEAR_BOTTOM_PX, turnAnchorIndex, TURN_ANCHOR_GAP_PX, TURN_ANCHOR_MAX_QUESTION_PX, UP_GESTURE_WINDOW_MS } from './transcript-pin';

const H = 5000; // scrollHeight
const C = 800;  // clientHeight
const BOTTOM = H - C; // scrollTop when glued to the bottom
const sample = (scrollTop: number, now = 1_000) => ({ scrollTop, scrollHeight: H, clientHeight: C, now });

describe('decideTranscriptPin — the recording (slow wheel-up mid-stream)', () => {
  it('a 30px upward move from the bottom unpins immediately (was: stayed pinned under the 80px band)', () => {
    const glued = { ...initialTranscriptPinState(), lastTop: BOTTOM };
    const d = decideTranscriptPin(glued, sample(BOTTOM - 30));
    expect(d.next.pinned).toBe(false);
    expect(d.showJump).toBe(true);
    expect(d.next.upGestureUntil).toBe(1_000 + UP_GESTURE_WINDOW_MS);
  });

  it('a trailing near-bottom event inside the gesture window does NOT re-pin (momentum / anchoring bump)', () => {
    const glued = { ...initialTranscriptPinState(), lastTop: BOTTOM };
    const a = decideTranscriptPin(glued, sample(BOTTOM - 30, 1_000)).next;
    // content grew, the browser bumped scrollTop DOWN a little; still < 80px away
    const b = decideTranscriptPin(a, sample(BOTTOM - 20, 1_200));
    expect(b.next.pinned).toBe(false);
    expect(b.showJump).toBe(true);
  });

  it('a near-bottom landing AFTER the gesture window re-pins (the "scrolled back down to about the end" tolerance)', () => {
    const away = { pinned: false, lastTop: BOTTOM - 300, upGestureUntil: 1_400 };
    const d = decideTranscriptPin(away, sample(BOTTOM - (NEAR_BOTTOM_PX - 1), 5_000));
    expect(d.next.pinned).toBe(true);
    expect(d.showJump).toBe(false);
  });

  it('landing exactly at the bottom always re-pins, even inside the gesture window', () => {
    const away = { pinned: false, lastTop: BOTTOM - 300, upGestureUntil: 9_999 };
    const d = decideTranscriptPin(away, sample(BOTTOM, 1_100));
    expect(d.next.pinned).toBe(true);
    expect(d.showJump).toBe(false);
  });
});

describe('decideTranscriptPin — never over-unpin', () => {
  it('a scroller CLAMP (content shrank while glued — scrollTop drops but the view is still at the bottom) keeps the pin', () => {
    // Before: glued at 4200. Content shrank 20px → browser clamps scrollTop to
    // 4180 and dist is 0. Looks like an upward move; is not the user.
    const glued = { ...initialTranscriptPinState(), lastTop: BOTTOM };
    const d = decideTranscriptPin(glued, { scrollTop: BOTTOM - 20, scrollHeight: H - 20, clientHeight: C, now: 1_000 });
    expect(d.next.pinned).toBe(true);
    expect(d.showJump).toBe(false);
  });

  it('a downward move far from the bottom (anchoring bump / programmatic) keeps whatever pin state it had (PR #100)', () => {
    const reading = { pinned: false, lastTop: 1000, upGestureUntil: 0 };
    const d = decideTranscriptPin(reading, sample(1040));
    expect(d.next.pinned).toBe(false);
    expect(d.showJump).toBe(true);
    const pinnedFar = { pinned: true, lastTop: 1000, upGestureUntil: 0 };
    expect(decideTranscriptPin(pinnedFar, sample(1040)).next.pinned).toBe(true);
  });

  it('fractional-scroll noise (< 1px "upward") is not a user move', () => {
    const glued = { ...initialTranscriptPinState(), lastTop: BOTTOM - 50 };
    const d = decideTranscriptPin(glued, sample(BOTTOM - 50.5, 1_000));
    expect(d.next.pinned).toBe(true);
  });

  it('tracks lastTop on every event', () => {
    const d = decideTranscriptPin(initialTranscriptPinState(), sample(123));
    expect(d.next.lastTop).toBe(123);
  });
});

describe('turn anchor (2026-10-07 — stop at the start of the reply)', () => {
  it('anchors the last user row while its reply streams or has landed', () => {
    expect(turnAnchorIndex(['user', 'assistant', 'user'])).toBe(2);
    expect(turnAnchorIndex(['user', 'assistant', 'user', 'assistant'])).toBe(2);
  });
  it('a later standalone post (2+ assistant rows after the question) anchors itself', () => {
    expect(turnAnchorIndex(['user', 'assistant', 'assistant'])).toBe(2);
  });
  it('no user row ⇒ newest row; no rows ⇒ -1', () => {
    expect(turnAnchorIndex(['assistant', 'assistant'])).toBe(1);
    expect(turnAnchorIndex([])).toBe(-1);
  });
  it('follows to the bottom until the anchor would leave the top, then stops on it', () => {
    // short content: bottom is above the stop line → plain follow
    expect(followTarget({ scrollHeight: 1000, clientHeight: 800 }, { top: 600, height: 40 })).toEqual({ top: 200, capped: false });
    // long reply: stop 16px above the question
    expect(followTarget({ scrollHeight: 3000, clientHeight: 800 }, { top: 600, height: 40 })).toEqual({ top: 600 - TURN_ANCHOR_GAP_PX, capped: true });
  });
  it('a tall question keeps only its last 120px above the reply', () => {
    const r = followTarget({ scrollHeight: 5000, clientHeight: 800 }, { top: 600, height: 900 });
    expect(r).toEqual({ top: 600 + 900 - TURN_ANCHOR_MAX_QUESTION_PX - TURN_ANCHOR_GAP_PX, capped: true });
  });
  it('no anchor ⇒ bottom', () => {
    expect(followTarget({ scrollHeight: 3000, clientHeight: 800 }, null)).toEqual({ top: 2200, capped: false });
  });
});
