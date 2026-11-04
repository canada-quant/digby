/**
 * Advanced-tab retirement (ticket c99b404a, 2026-10-27) — source-level pins
 * that the Account → Advanced tab stays DEAD.
 *
 * The owner deprecated the tab outright ("Remove Advanced from tabs in
 * account settings it is deprecated now"): since roster 2026-10-06 B-3 it had
 * carried exactly one read-only line ("Digby picks depth and models per
 * message") and a Dig-deeper hint — nothing to set — so the tab went away
 * whole. The depth CONTRACT is untouched: Dig deeper under an answer remains
 * the one depth control, `depthPrefToWire` still ignores a stored preset, and
 * Admin → Settings → Depth policy still governs the always-Auto switch.
 *
 * Pins, at the source level (this suite's established idiom — readFileSync,
 * no runtime imports of the page):
 *   1. The account page lists no Advanced tab: no TABS entry, no Tab union
 *      member, no render branch, no child-filter entry, no import, no icon.
 *   2. The AdvancedTab component and its test are deleted from disk.
 *   3. The backend model-identity copy no longer sends users to the tab.
 *   4. A stored/junk depth pref still never picks a run (the wire contract
 *      the deleted AdvancedTab.test.tsx pinned — relocated here).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
// here = frontend/app/crossmodel → repo root is three levels up.
const repoRoot = join(here, '../../..');
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8');

const ACCOUNT_PAGE = read('frontend/app/crossmodel/account/page.tsx');
const CHAT_CONTEXT = read('backend/src/modules/crossmodel/chat-agent/chat-context.ts');

const ADVANCED_MARKERS = ['AdvancedTab', "id: 'advanced'", "'advanced'", 'SlidersHorizontal'];

describe('Advanced-tab retirement (c99b404a) — the account page', () => {
  it('lists no Advanced tab: no TABS entry, no Tab member, no render branch, no child-filter entry', () => {
    for (const marker of ADVANCED_MARKERS) {
      for (const line of ACCOUNT_PAGE.split('\n')) {
        const trimmed = line.trim();
        // Allow the retirement-record COMMENTS that name the removal (never a
        // live entry, union member, render branch or import).
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
        expect(`${ACCOUNT_PAGE}: ${line}`).not.toContain(marker);
      }
    }
    expect(ACCOUNT_PAGE).not.toContain("label: 'Advanced'");
    expect(ACCOUNT_PAGE).not.toContain("<AdvancedTab />");
  });

  it('the AdvancedTab component and its test are deleted', () => {
    expect(existsSync(join(repoRoot, 'frontend/app/crossmodel/account/AdvancedTab.tsx'))).toBe(false);
    expect(existsSync(join(repoRoot, 'frontend/app/crossmodel/account/AdvancedTab.test.tsx'))).toBe(false);
  });

  it('every remaining tab id is still deep-linkable (?tab= accepts the TABS list)', () => {
    expect(ACCOUNT_PAGE).toContain("TABS.some((t) => t.id === tab) || tab === 'admin'");
  });
});

describe('Advanced-tab retirement (c99b404a) — the model-facing copy', () => {
  it('DIGBY_PLATFORM_IDENTITY no longer points at Account → Advanced', () => {
    // The BLOCK ITSELF (the template literal the model receives) must not name
    // the tab; the dated history comments above the constant legitimately do.
    const openIdx = CHAT_CONTEXT.indexOf('`', CHAT_CONTEXT.indexOf('export const DIGBY_PLATFORM_IDENTITY'));
    const closeIdx = CHAT_CONTEXT.indexOf('`', openIdx + 1);
    const IDENTITY_BLOCK = CHAT_CONTEXT.slice(openIdx, closeIdx + 1);
    expect(IDENTITY_BLOCK).not.toContain('Account → Advanced');
    expect(IDENTITY_BLOCK).not.toContain('Advanced');
    expect(IDENTITY_BLOCK).toContain('There is no depth setting: Digby picks depth and models per message');
  });
});

describe('Advanced-tab retirement (c99b404a) — the depth contract survives the tab', () => {
  // Relocated from the deleted AdvancedTab.test.tsx (the wire block): a preset
  // stored by the RETIRED radios (or junk) still never picks a run. Runtime
  // imports are fine here — lib/depth-ux + lib/preferences are leaves. The
  // node-environment idiom is the deleted file's: a hand-rolled localStorage
  // on globalThis, set up and torn down around each test.
  let backing: Record<string, string>;
  beforeEach(() => {
    backing = {};
    (globalThis as any).window = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => (k in backing ? backing[k] : null),
      setItem: (k: string, v: string) => { backing[k] = String(v); },
      removeItem: (k: string) => { delete backing[k]; },
    };
  });
  afterEach(() => { delete (globalThis as any).window; delete (globalThis as any).localStorage; });

  it('signed-in: every stored value (a preset, a legacy level, Auto, junk) sends Auto with no modeSource', async () => {
    const { depthPrefToWire } = await import('../../lib/depth-ux');
    const { loadPrefs, normalizePatienceMode } = await import('../../lib/preferences');
    for (const stored of ['deep_research', 'thinking', 'single_thinking', 'fast', 'code', 'auto']) {
      backing.cm_prefs = JSON.stringify({ patienceMode: stored });
      expect(depthPrefToWire(normalizePatienceMode(loadPrefs().patienceMode), { guest: false }))
        .toEqual({ mode: 'auto' });
    }
    backing.cm_prefs = '{not json';
    expect(depthPrefToWire(normalizePatienceMode(loadPrefs().patienceMode), { guest: false }))
      .toEqual({ mode: 'auto' });
  });

  it('kids keep their stored mode untouched; guests keep the forced Ensemble', async () => {
    const { depthPrefToWire } = await import('../../lib/depth-ux');
    const { loadPrefs, normalizePatienceMode } = await import('../../lib/preferences');
    backing.cm_prefs = JSON.stringify({ patienceMode: 'thinking' });
    expect(depthPrefToWire(normalizePatienceMode(loadPrefs().patienceMode), { guest: false, isKid: true }))
      .toEqual({ mode: 'thinking' });
    expect(depthPrefToWire(normalizePatienceMode(loadPrefs().patienceMode), { guest: true }))
      .toEqual({ mode: 'thinking', modeSource: 'default' });
  });
});
