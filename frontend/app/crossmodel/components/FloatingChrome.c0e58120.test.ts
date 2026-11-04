/**
 * Ticket c0e58120 — "right sidebar can't be used with iphone dynamic island":
 * the old fixed floating pills rendered UNDER the Dynamic Island in landscape.
 * Since the Digby Frontier redesign (2026-10-06) the chrome is an IN-FLOW
 * 56px header; this pins its safe-area geometry instead — env() terms are 0px
 * on notch-free devices/orientations and desktop, so a no-op there.
 */
import { describe, it, expect } from 'vitest';
import { HEADER_STYLE, HEADER_ICON_BTN } from './FloatingChrome';

describe('FloatingChrome header — safe-area insets (ticket c0e58120)', () => {
  it('pads the status-bar inset on top and the landscape side insets', () => {
    expect(HEADER_STYLE.height).toBe('calc(56px + env(safe-area-inset-top, 0px))');
    expect(HEADER_STYLE.paddingTop).toBe('env(safe-area-inset-top, 0px)');
    expect(HEADER_STYLE.paddingLeft).toContain('env(safe-area-inset-left, 0px)');
    expect(HEADER_STYLE.paddingRight).toContain('env(safe-area-inset-right, 0px)');
  });

  it('icon buttons are 34px with a 44px coarse-pointer floor', () => {
    expect(HEADER_ICON_BTN).toContain('size-[34px]');
    expect(HEADER_ICON_BTN).toContain('[@media(pointer:coarse)]:size-11');
    expect(HEADER_ICON_BTN).toContain('rounded-[9px]');
  });
});
