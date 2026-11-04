/**
 * Browser-agent activity model pins (UI overhaul Phase 6a).
 *
 * The reducer is fed CAPTURED-SHAPE frames — exactly what the backend emits at
 * browser-agent/glm-loop.ts (per-action observation + separate screenshot
 * frame) and what the SSE lanes deliver as `browser_observation` data.
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_BROWSER_ACTIVITY,
  MAX_BROWSER_LOG_ENTRIES,
  CLOSED_BROWSER_SHEET,
  browserActionLabel,
  browserHost,
  browserPageLabel,
  browserPath,
  browserSurface,
  nextBrowserSheetState,
  reduceBrowserActivity,
  seedBrowserActivityFromMessages,
  type BrowserActivityState,
} from './browser-activity';

// Captured shapes — glm-loop.ts sendEvent('browser-observation', …) verbatim.
const NAV_FRAME = {
  action: 'navigate', ok: true, url: 'https://www.example.com/pricing',
  driver: 'cloud', preview: 'Example Domain — pricing tiers…', reasoning: 'Opening the pricing page',
};
const ERROR_FRAME = {
  action: 'click', ok: false, url: 'https://www.example.com/pricing',
  driver: 'cloud', preview: '⚠️ interactive cloud browsing is unavailable', reasoning: 'Trying the Buy button',
};
const SCREENSHOT_FRAME = {
  action: 'screenshot', ok: true, url: 'https://www.example.com/pricing',
  driver: 'local', screenshotBase64: 'iVBORw0KGgo=',
};

describe('reduceBrowserActivity — captured backend frames → running log', () => {
  it('folds an observation into the log with step, ingest ts, and the URL bar state', () => {
    const s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, NAV_FRAME, 1_000);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]).toEqual({
      step: 1, action: 'navigate', ok: true, url: 'https://www.example.com/pricing',
      driver: 'cloud', preview: 'Example Domain — pricing tiers…',
      reasoning: 'Opening the pricing page', hasScreenshot: false, ts: 1_000,
    });
    expect(s.currentUrl).toBe('https://www.example.com/pricing');
    expect(s.screenshot).toBeNull();
  });

  it('the screenshot frame becomes the live view (data: URL) and marks its row', () => {
    let s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, NAV_FRAME, 1_000);
    s = reduceBrowserActivity(s, SCREENSHOT_FRAME, 2_000);
    expect(s.entries).toHaveLength(2);
    expect(s.entries[1].hasScreenshot).toBe(true);
    expect(s.screenshot).toEqual({ src: 'data:image/png;base64,iVBORw0KGgo=', url: 'https://www.example.com/pricing', ts: 2_000 });
    // base64 lives ONLY on state.screenshot — log rows never pin PNGs.
    expect((s.entries[1] as any).screenshotBase64).toBeUndefined();
  });

  it('a later non-screenshot frame keeps the latest screenshot; a later screenshot replaces it', () => {
    let s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, SCREENSHOT_FRAME, 1_000);
    s = reduceBrowserActivity(s, ERROR_FRAME, 2_000);
    expect(s.screenshot?.ts).toBe(1_000);
    s = reduceBrowserActivity(s, { ...SCREENSHOT_FRAME, screenshotBase64: 'newer==' }, 3_000);
    expect(s.screenshot).toEqual({ src: 'data:image/png;base64,newer==', url: 'https://www.example.com/pricing', ts: 3_000 });
  });

  it('error observations keep ok:false and the ⚠ preview', () => {
    const s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, ERROR_FRAME, 1_000);
    expect(s.entries[0].ok).toBe(false);
    expect(s.entries[0].preview).toContain('⚠️');
  });

  it('malformed frames return the SAME state reference (React no-op)', () => {
    const s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, NAV_FRAME, 1_000);
    expect(reduceBrowserActivity(s, null)).toBe(s);
    expect(reduceBrowserActivity(s, 'nope')).toBe(s);
    expect(reduceBrowserActivity(s, { ok: true })).toBe(s);      // no action
    expect(reduceBrowserActivity(s, { action: 42 })).toBe(s);    // non-string action
  });

  it('caps the log window and keeps the NEWEST rows (step keeps counting)', () => {
    let s: BrowserActivityState = EMPTY_BROWSER_ACTIVITY;
    for (let i = 0; i < MAX_BROWSER_LOG_ENTRIES + 5; i++) {
      s = reduceBrowserActivity(s, { action: 'get_content', ok: true }, i);
    }
    expect(s.entries).toHaveLength(MAX_BROWSER_LOG_ENTRIES);
    expect(s.entries[s.entries.length - 1].step).toBe(MAX_BROWSER_LOG_ENTRIES + 5);
    expect(s.entries[0].step).toBe(6); // oldest 5 rolled off
  });

  it('a frame with no url keeps the previous URL-bar state', () => {
    let s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, NAV_FRAME, 1_000);
    s = reduceBrowserActivity(s, { action: 'scroll', ok: true }, 2_000);
    expect(s.currentUrl).toBe('https://www.example.com/pricing');
  });
});

describe('display helpers', () => {
  it('browserHost/browserPath mirror the InAppBrowser chrome derivation', () => {
    expect(browserHost('https://www.example.com/pricing?x=1')).toBe('example.com');
    expect(browserHost('not a url')).toBe('');
    expect(browserPath('https://example.com/pricing')).toBe('/pricing');
    expect(browserPath('https://example.com/')).toBe('');
  });

  it('browserPageLabel: host of the current URL, Globe-fallback label otherwise', () => {
    const s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, NAV_FRAME, 1_000);
    expect(browserPageLabel(s)).toBe('example.com');
    expect(browserPageLabel(EMPTY_BROWSER_ACTIVITY)).toBe('Agent browser');
  });

  it('browserActionLabel covers the action vocabulary compactly', () => {
    expect(browserActionLabel({ action: 'navigate', url: 'https://www.example.com/x' })).toBe('Opened example.com');
    expect(browserActionLabel({ action: 'navigate' })).toBe('Opened a page');
    expect(browserActionLabel({ action: 'get_content' })).toBe('Read the page');
    expect(browserActionLabel({ action: 'click' })).toBe('Clicked an element');
    expect(browserActionLabel({ action: 'type' })).toBe('Typed into a field');
    expect(browserActionLabel({ action: 'scroll' })).toBe('Scrolled the page');
    expect(browserActionLabel({ action: 'screenshot' })).toBe('Captured the page');
    expect(browserActionLabel({ action: 'extract' })).toBe('Extracted details');
    expect(browserActionLabel({ action: 'some_new_action' })).toBe('some new action');
  });
});

describe('browserSurface — panel on desktop, sheet on mobile, none without activity', () => {
  it('selects by activity first, then the md: mobile line', () => {
    expect(browserSurface(false, false)).toBe('none');
    expect(browserSurface(false, true)).toBe('none');
    expect(browserSurface(true, false)).toBe('panel');
    expect(browserSurface(true, true)).toBe('sheet');
  });
});

describe('nextBrowserSheetState — the mobile sheet state machine (ChatGPT pattern)', () => {
  it('auto-opens on the first observation', () => {
    expect(nextBrowserSheetState(CLOSED_BROWSER_SHEET, 'observation')).toEqual({ open: true, dismissed: false });
  });

  it('further observations keep the SAME reference while open (no churn)', () => {
    const open = nextBrowserSheetState(CLOSED_BROWSER_SHEET, 'observation');
    expect(nextBrowserSheetState(open, 'observation')).toBe(open);
  });

  it('a dismissal sticks: later observations do NOT reopen', () => {
    const dismissed = nextBrowserSheetState({ open: true, dismissed: false }, 'dismiss');
    expect(dismissed).toEqual({ open: false, dismissed: true });
    expect(nextBrowserSheetState(dismissed, 'observation')).toBe(dismissed);
  });

  it('the user can reopen after dismissing; reset clears everything (chat switch / full replay)', () => {
    const dismissed = nextBrowserSheetState(CLOSED_BROWSER_SHEET, 'dismiss');
    expect(nextBrowserSheetState(dismissed, 'open')).toEqual({ open: true, dismissed: false });
    expect(nextBrowserSheetState({ open: true, dismissed: false }, 'reset')).toEqual(CLOSED_BROWSER_SHEET);
  });
});

describe('live-view frames + computer-use frames (2026-09-09)', () => {
  const LIVE_JPEG = {
    action: 'screenshot', ok: true, url: 'https://www.example.com/pricing',
    driver: 'local', screenshotBase64: '/9j/4AAQ', mime: 'image/jpeg', live: true,
  };

  it('a live frame refreshes the live view WITHOUT adding a log row, and flags the last action', () => {
    let s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, NAV_FRAME, 1_000);
    s = reduceBrowserActivity(s, LIVE_JPEG, 2_000);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].hasScreenshot).toBe(true);
    expect(s.screenshot).toEqual({ src: 'data:image/jpeg;base64,/9j/4AAQ', url: 'https://www.example.com/pricing', ts: 2_000 });
    expect(s.currentDriver).toBe('local');
  });

  it('a live frame with no pixels is a no-op (same state reference)', () => {
    const s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, NAV_FRAME, 1_000);
    expect(reduceBrowserActivity(s, { action: 'screenshot', ok: true, live: true }, 2_000)).toBe(s);
  });

  it('mime defaults to PNG for legacy frames and rejects non-image values', () => {
    const s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, { ...SCREENSHOT_FRAME, mime: 'text/html' }, 1_000);
    expect(s.screenshot?.src.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('computer-use frames: driver computer → "Your Mac · <app>" label, Mac-flavored action labels', () => {
    let s = reduceBrowserActivity(EMPTY_BROWSER_ACTIVITY, {
      action: 'screenshot', ok: true, driver: 'computer', screenshotBase64: '/9j/', mime: 'image/jpeg', app: 'Google Chrome',
    }, 1_000);
    expect(s.currentDriver).toBe('computer');
    expect(s.currentApp).toBe('Google Chrome');
    expect(browserPageLabel(s)).toBe('Your Mac · Google Chrome');
    s = reduceBrowserActivity(s, { action: 'click', ok: true, driver: 'computer', reasoning: 'open the profile menu' }, 2_000);
    expect(browserActionLabel(s.entries[1])).toBe('Clicked on screen');
    expect(browserActionLabel({ action: 'key', driver: 'computer' })).toBe('Pressed a key');
    expect(browserActionLabel({ action: 'open', driver: 'computer' })).toBe('Opened an app');
    // The app sticks across computer frames that don't repeat it.
    expect(s.currentApp).toBe('Google Chrome');
  });
});

describe('seedBrowserActivityFromMessages (persisted screenshots → Browser tab, 2026-09-23)', () => {
  it('returns null when no assistant image part carries a browser/computer source', () => {
    expect(seedBrowserActivityFromMessages([])).toBeNull();
    expect(seedBrowserActivityFromMessages([{ role: 'user', parts: [{ type: 'image', data: 'x', mediaType: 'image/png' }] }])).toBeNull();
    expect(seedBrowserActivityFromMessages([{ role: 'assistant', parts: [{ type: 'image', data: 'x', mediaType: 'image/png' }] }])).toBeNull();
  });

  it('seeds the LATEST browser screenshot as the live view (lazy url wins over inline data)', () => {
    const s = seedBrowserActivityFromMessages([
      { role: 'assistant', createdAt: '2026-09-23T10:00:00.000Z', parts: [{ type: 'image', source: 'browser', mediaType: 'image/png', data: 'OLD', pageUrl: 'https://a.example/x', name: 'Final page · a.example' }] },
      { role: 'assistant', createdAt: '2026-09-23T11:00:00.000Z', parts: [
        { type: 'tool_call', name: 'browser_task' },
        { type: 'image', source: 'browser', mediaType: 'image/png', url: '/api/crossmodel/coding/sessions/c1/messages/m2/image/1', pageUrl: 'https://example.com/pricing', name: 'Final page · example.com', ts: '2026-09-23T11:00:05.000Z' },
      ] },
    ], 5);
    expect(s).not.toBeNull();
    expect(s!.screenshot).toEqual({ src: '/api/crossmodel/coding/sessions/c1/messages/m2/image/1', url: 'https://example.com/pricing', ts: Date.parse('2026-09-23T11:00:05.000Z') });
    expect(s!.currentUrl).toBe('https://example.com/pricing');
    expect(s!.currentDriver).toBeNull();
    expect(s!.entries).toHaveLength(1);
    expect(s!.entries[0]).toMatchObject({ action: 'screenshot', ok: true, hasScreenshot: true, preview: 'Final page · example.com' });
    expect(browserPageLabel(s!)).toBe('example.com');
  });

  it('a computer screenshot seeds the "Your Mac · app" chrome', () => {
    const s = seedBrowserActivityFromMessages([
      { role: 'assistant', parts: [{ type: 'image', source: 'computer', mediaType: 'image/jpeg', data: '/9j/', app: 'Google Chrome', name: 'Final screen · Your Mac · Google Chrome' }] },
    ], 7);
    expect(s!.screenshot).toEqual({ src: 'data:image/jpeg;base64,/9j/', url: undefined, ts: 7 });
    expect(s!.currentDriver).toBe('computer');
    expect(s!.currentApp).toBe('Google Chrome');
    expect(browserPageLabel(s!)).toBe('Your Mac · Google Chrome');
  });
});
