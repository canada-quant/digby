/**
 * composer-enter — ticket 67fc53a7 (owner report 2026-09-14): desktop Enter
 * must SEND (Shift+Enter = newline); mobile keeps the iMessage behavior
 * (Enter = newline, Send button sends). Regression: 41c534372 made
 * Enter=newline unconditional on every device.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { enterKeySubmits, isTouchPrimary, type EnterKeyLike } from './composer-enter';

const enter = (over: Partial<EnterKeyLike> = {}): EnterKeyLike => ({
  key: 'Enter',
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  ...over,
});

describe('enterKeySubmits', () => {
  it('desktop (fine pointer): plain Enter submits with the default (undefined) semantics', () => {
    expect(enterKeySubmits(enter(), undefined, false)).toBe(true);
  });

  it('desktop: Shift+Enter is the newline escape hatch', () => {
    expect(enterKeySubmits(enter({ shiftKey: true }), undefined, false)).toBe(false);
  });

  it('touch-primary: plain Enter inserts a newline (iMessage parity — the behavior the owner wants KEPT on mobile)', () => {
    expect(enterKeySubmits(enter(), undefined, true)).toBe(false);
  });

  it('touch-primary: Shift+Enter also inserts a newline', () => {
    expect(enterKeySubmits(enter({ shiftKey: true }), undefined, true)).toBe(false);
  });

  it('Cmd+Enter submits on every device class, even touch', () => {
    expect(enterKeySubmits(enter({ metaKey: true }), undefined, true)).toBe(true);
    expect(enterKeySubmits(enter({ metaKey: true }), undefined, false)).toBe(true);
  });

  it('Ctrl+Enter submits on every device class, even with Shift held', () => {
    expect(enterKeySubmits(enter({ ctrlKey: true }), undefined, true)).toBe(true);
    expect(enterKeySubmits(enter({ ctrlKey: true, shiftKey: true }), undefined, false)).toBe(true);
  });

  it('explicit submitOnEnter=false forces newline semantics even on desktop (host override)', () => {
    expect(enterKeySubmits(enter(), false, false)).toBe(false);
    expect(enterKeySubmits(enter({ metaKey: true }), false, false)).toBe(true); // modifier still wins
  });

  it('explicit submitOnEnter=true forces submit semantics even on touch (host override)', () => {
    expect(enterKeySubmits(enter(), true, true)).toBe(true);
    expect(enterKeySubmits(enter({ shiftKey: true }), true, true)).toBe(false);
  });

  it('ignores non-Enter keys', () => {
    expect(enterKeySubmits(enter({ key: 'a' }), undefined, false)).toBe(false);
    expect(enterKeySubmits(enter({ key: 'Escape' }), true, false)).toBe(false);
  });

  it('IME composition: Enter confirming a candidate NEVER submits (B1 review finding — CJK users)', () => {
    // Direct flag (tests / non-React callers).
    expect(enterKeySubmits(enter({ isComposing: true }), undefined, false)).toBe(false);
    expect(enterKeySubmits(enter({ isComposing: true }), undefined, true)).toBe(false);
    // Composition wins even over an explicit force-submit and modifiers.
    expect(enterKeySubmits(enter({ isComposing: true }), true, false)).toBe(false);
    expect(enterKeySubmits(enter({ isComposing: true, metaKey: true }), undefined, false)).toBe(false);
  });

  it('IME composition: the React-event path (nativeEvent.isComposing) is honored', () => {
    const reactLike = { ...enter(), nativeEvent: { isComposing: true } };
    expect(enterKeySubmits(reactLike, undefined, false)).toBe(false);
    // Composition ended (flag cleared) → normal desktop semantics resume.
    const ended = { ...enter(), nativeEvent: { isComposing: false } };
    expect(enterKeySubmits(ended, undefined, false)).toBe(true);
  });
});

describe('isTouchPrimary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns false when there is no window (SSR)', () => {
    // vitest's node environment has no window by default.
    expect(typeof window === 'undefined' ? isTouchPrimary() : 'skip: dom env').toBe(
      typeof window === 'undefined' ? false : 'skip: dom env',
    );
  });

  it('true when the primary pointer is coarse (phone/tablet)', () => {
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }),
    });
    expect(isTouchPrimary()).toBe(true);
  });

  it('false when the primary pointer is fine (desktop, incl. touchscreen laptops)', () => {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: false }),
    });
    expect(isTouchPrimary()).toBe(false);
  });

  it('falls back to navigator.maxTouchPoints when matchMedia is unavailable', () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('navigator', { maxTouchPoints: 5 });
    expect(isTouchPrimary()).toBe(true);
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    expect(isTouchPrimary()).toBe(false);
  });
});
