/**
 * Ghost mode (2026-10-22) — pins for the guest half + the pure helpers.
 *
 * Mirrors guest-sessions.test.ts: vitest runs in the NODE environment (no
 * jsdom), so the SSR branch is exercised by NOT installing the window stub
 * and the localStorage branch by installing the in-memory pair.
 *
 * Pins:
 *   1. The per-session flag store — round-trip, per-session isolation,
 *      SSR safety, never-throws.
 *   2. The honest copy — the tooltip names exactly the guarantees the
 *      backend implements (kept in sync with docs/GHOST_MODE.md).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getGuestGhost,
  setGuestGhost,
  clearGuestGhost,
  GHOST_MODE_TOOLTIP,
  GHOST_MODE_ACTIVE_LABEL,
} from '@/lib/ghost-mode';

// ── In-memory localStorage stub (guest-sessions.test.ts) ────────────────────
let backing: Record<string, string>;

function installWindow() {
  backing = {};
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => (k in backing ? backing[k] : null),
      setItem: (k: string, v: string) => { backing[k] = String(v); },
      removeItem: (k: string) => { delete backing[k]; },
    },
  };
}

function uninstallWindow() {
  delete (globalThis as any).window;
}

beforeEach(installWindow);
afterEach(uninstallWindow);

describe('SSR safety (no window)', () => {
  it('reads false and writes no-op when window is undefined', () => {
    uninstallWindow();
    expect(getGuestGhost('s1')).toBe(false);
    expect(() => setGuestGhost('s1', true)).not.toThrow();
    expect(() => clearGuestGhost('s1')).not.toThrow();
    expect(getGuestGhost('s1')).toBe(false);
  });
});

describe('per-session flag store', () => {
  it('round-trips on and off for one session', () => {
    expect(getGuestGhost('s1')).toBe(false); // absent = OFF (the safe default)
    setGuestGhost('s1', true);
    expect(getGuestGhost('s1')).toBe(true);
    setGuestGhost('s1', false);
    expect(getGuestGhost('s1')).toBe(false);
  });

  it('flags are per-session (toggling one never touches another)', () => {
    setGuestGhost('s1', true);
    setGuestGhost('s2', false);
    expect(getGuestGhost('s1')).toBe(true);
    expect(getGuestGhost('s2')).toBe(false);
    // a reopened session keeps ITS OWN flag — the guest-ghost contract
    setGuestGhost('s2', true);
    expect(getGuestGhost('s1')).toBe(true);
    expect(getGuestGhost('s2')).toBe(true);
  });

  it('clearGuestGhost forgets the flag (session deleted) and reads false after', () => {
    setGuestGhost('s1', true);
    clearGuestGhost('s1');
    expect(getGuestGhost('s1')).toBe(false);
    // clearing an absent key is a no-op, never a throw
    expect(() => clearGuestGhost('never-set')).not.toThrow();
  });

  it('null/undefined session ids read false and write no-op (no key minted)', () => {
    expect(getGuestGhost(null)).toBe(false);
    expect(getGuestGhost(undefined)).toBe(false);
    expect(() => setGuestGhost(null, true)).not.toThrow();
    expect(backing).toEqual({});
  });

  it('a blocked localStorage never throws (ghost OFF stays the default)', () => {
    (globalThis as any).window = {
      localStorage: {
        getItem: () => { throw new Error('blocked'); },
        setItem: () => { throw new Error('blocked'); },
        removeItem: () => { throw new Error('blocked'); },
      },
    };
    expect(() => setGuestGhost('s1', true)).not.toThrow();
    expect(getGuestGhost('s1')).toBe(false);
  });
});

describe('honest copy', () => {
  it('the tooltip states the routing + privacy guarantee + transcript retention exactly', () => {
    expect(GHOST_MODE_TOOLTIP).toBe(
      "Ghost mode routes this chat through the admin's private endpoint and keeps it out of memory and learning. Your transcript stays in your account.",
    );
  });

  it('the active label is the short indicator form', () => {
    expect(GHOST_MODE_ACTIVE_LABEL).toBe('Ghost mode on');
  });
});
