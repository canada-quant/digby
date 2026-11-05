/**
 * Ticket 8a25754c — the macOS desktop shell MUST implement WKUIDelegate's
 * file-picker method. macOS WKWebView has NO default open panel: without
 * `runOpenPanelWith`, a JS `.click()` on `<input type="file">` is silently
 * dropped — no panel, no error — while drag-and-drop keeps working (native
 * WebKit drag machinery never asks the UI delegate). That was the reported
 * "click attachment icon doesn't work but you can still drag and drop", in
 * BOTH the normal-chat and coding-session composers (they share the shell).
 *
 * This is a source-level pin (the p1-shell-pins idiom): the Swift toolchain
 * only exists on the build Mac, so CI (Linux) pins the source instead of
 * compiling it.
 *
 * RELEASE CONTRACT (encoded below): the fix ships in shell 0.1.9. Until the
 * owner rebuilds + republishes Digby.dmg on their Mac (signed + notarized —
 * cannot be done from CI/Linux), desktop-latest.json MUST stay at 0.1.8:
 * advertising 0.1.9 while the served dmg is still the 0.1.8 binary would
 * hand users a broken no-op update. Once the feed moves to ≥0.1.9 the notes
 * must mention the fix.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const SWIFT = readFileSync(
  fileURLToPath(new URL('../../macos-app/Sources/Digby/main.swift', import.meta.url)),
  'utf8',
);
const BUILD_SH = readFileSync(
  fileURLToPath(new URL('../../macos-app/build-app.sh', import.meta.url)),
  'utf8',
);
const FEED = JSON.parse(readFileSync(
  fileURLToPath(new URL('../public/desktop-latest.json', import.meta.url)),
  'utf8',
)) as { version: string; url: string; notes: string };

/** Dotted numeric compare ('0.1.9' < '0.1.10'), like the shell's isNewer. */
function atLeast(ver: string, floor: string): boolean {
  const a = ver.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

describe('8a25754c — desktop shell file picker (runOpenPanelWith)', () => {
  it('main.swift implements the WKUIDelegate open-panel method exactly once', () => {
    expect(SWIFT.match(/runOpenPanelWith/g)?.length).toBe(1);
    expect(SWIFT).toContain('func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters');
    // The conformance that routes the callback.
    expect(SWIFT).toContain('WKUIDelegate');
  });

  it('the panel presents as a sheet over the main window and returns the picked urls', () => {
    expect(SWIFT).toContain('NSOpenPanel()');
    expect(SWIFT).toContain('panel.beginSheetModal(for: window)');
    expect(SWIFT).toContain('completionHandler(response == .OK ? panel.urls : nil)');
  });

  it('the panel honors multiple-selection (the web inputs are `multiple`)', () => {
    expect(SWIFT).toContain('panel.allowsMultipleSelection = parameters.allowsMultipleSelection');
  });

  it('build-app.sh defaults to a version at or above the fix-carrying one (0.1.9; 0.1.10 = multi-display capture, agent 0.6.2)', () => {
    const m = BUILD_SH.match(/VERSION="\$\{VERSION:-([0-9]+\.[0-9]+\.[0-9]+)\}"/);
    expect(m).not.toBeNull();
    expect(atLeast(m![1], '0.1.9')).toBe(true);
  });

  it('desktop-latest.json: either still 0.1.8 (dmg not yet rebuilt) or ≥0.1.9 noting the fix', () => {
    expect(FEED.url).toBe('https://digby.ai/Digby.dmg');
    if (atLeast(FEED.version, '0.1.10')) {
      // 0.1.10+ (agent 0.6.2): the notes must name the multi-display capture fix
      // and the one-time permission re-grant a re-signed binary needs.
      expect(FEED.notes).toMatch(/display|capture|presence/i);
      expect(FEED.notes).toMatch(/accessibility|screen recording|re-grant/i);
    } else if (atLeast(FEED.version, '0.1.9')) {
      // Published release: the notes must tell users the picker is fixed.
      expect(FEED.notes).toMatch(/attachment|file picker|paperclip/i);
    } else {
      // Pre-release: the feed must NOT advertise a version the served dmg
      // doesn't have. The committed Digby.dmg is the 0.1.8 binary until the
      // owner's Mac build replaces it.
      expect(FEED.version).toBe('0.1.8');
    }
  });
});
