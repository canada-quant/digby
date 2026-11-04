/**
 * Ticket 61823826 — the macOS mic TCC prompt NEVER APPEARS even though the app
 * asks. The 8b13ec2b fix (shell 0.1.12) made VoiceMode.swift request the
 * microphone FIRST and unconditionally — and the request demonstrably RUNS (the
 * in-app "Microphone Needed" NSAlert fires on ⌃⇧Space, so requestMicPermission's
 * handler returned granted=false) — yet on the owner's MacBook Pro and Mac mini:
 *   • NO macOS TCC consent dialog ever appears,
 *   • Digby never lands in System Settings → Privacy & Security → Microphone
 *     (even after `tccutil reset` + relaunch — there is no TCC record to reset),
 *   • the bundle is verified clean (NSMicrophoneUsageDescription present, bundle
 *     id ai.digby.desktop, signed + notarized).
 *
 * ROOT CAUSE: build-app.sh signs Digby.app with `codesign --options runtime`
 * (the hardened runtime, required for notarization) but passed NO entitlements
 * to that call — and the repo had no com.apple.security.device.audio-input
 * entitlement anywhere. Under the hardened runtime, microphone capture is
 * additionally gated by that entitlement: with it missing,
 * AVAudioApplication.requestRecordPermission (macOS 14+) and
 * AVCaptureDevice.requestAccess(for: .audio) return granted=false IMMEDIATELY —
 * no prompt, no TCC record, no list entry. The differential that convicts it:
 * Accessibility / Screen Recording / Full Disk Access are pure-TCC permissions
 * and their prompts DID appear on 0.1.12; microphone is the only one of the set
 * that is also entitlement-gated — and the only one that never prompts.
 *
 * This is a source-level pin (the p1-shell-pins idiom): the Swift toolchain and
 * codesign only exist on the build Mac, so CI (Linux) pins the build script and
 * the entitlements file instead of building.
 *
 * RELEASE CONTRACT (encoded below): the fix ships in shell 0.1.13. Until a
 * 0.1.13 DMG is built + notarized on the build Mac and published (the feed
 * notes must then name the entitlement fix), desktop-latest.json MUST stay at
 * 0.1.12 (the last version whose DMG exists) — advertising a version whose DMG
 * does not exist hands users a broken download.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const BUILD_SH = readFileSync(
  fileURLToPath(new URL('../../macos-app/build-app.sh', import.meta.url)),
  'utf8',
);
const ENTITLEMENTS = readFileSync(
  fileURLToPath(new URL('../../macos-app/Digby.entitlements', import.meta.url)),
  'utf8',
);
const PLIST = readFileSync(
  fileURLToPath(new URL('../../macos-app/Info.plist', import.meta.url)),
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

describe('61823826 — the mic request was auto-denied by the hardened runtime', () => {
  it('the app ships an entitlements file declaring com.apple.security.device.audio-input', () => {
    // The entitlement is the ONLY code-side thing that lets a hardened-runtime
    // app reach the TCC prompt; without it every mic ask auto-denies (the
    // ticket's AUTO_DENY verdict) — NSMicrophoneUsageDescription alone is NOT
    // enough for a notarized app.
    expect(ENTITLEMENTS).toContain('<key>com.apple.security.device.audio-input</key>');
    expect(ENTITLEMENTS).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);
  });

  it('build-app.sh signs the APP with --entitlements (the 0.1.12 signature had none)', () => {
    // The app-level codesign call — the one that signs "$APP" (not the helper,
    // not the dylibs) — must pass the entitlements file.
    const appSign = BUILD_SH.match(
      /codesign --force --options runtime --timestamp --entitlements [^\n]* --sign "\$APP_HASH" "\$APP"\n/,
    );
    expect(appSign).not.toBeNull();
    expect(appSign![0]).toContain('Digby.entitlements');
    // The OLD entitlement-less app signature is gone: a signature of exactly
    // the app with no --entitlements flag is the defect itself.
    expect(BUILD_SH).not.toMatch(
      /codesign --force --options runtime --timestamp --sign "\$APP_HASH" "\$APP"\n/,
    );
  });

  it('the build self-verifies the entitlement landed in the signed binary', () => {
    // The bug class was an INVISIBLE build-config gap — a build that silently
    // dropped the entitlement would reproduce the ticket exactly. The script
    // must dump the entitlements off the signed binary and fail when
    // audio-input is missing.
    expect(BUILD_SH).toContain('codesign -d --entitlements :- "$APP"');
    expect(BUILD_SH).toMatch(/grep -q "com\.apple\.security\.device\.audio-input"/);
  });

  it('build-app.sh defaults to a version above the entitlement-less 0.1.12', () => {
    const m = BUILD_SH.match(/VERSION="\$\{VERSION:-([0-9]+\.[0-9]+\.[0-9]+)\}"/);
    expect(m).not.toBeNull();
    expect(atLeast(m![1], '0.1.13')).toBe(true);
  });

  it('Info.plist still declares the mic usage string (the prompt body needs it)', () => {
    expect(PLIST).toContain('<key>NSMicrophoneUsageDescription</key>');
  });
});

describe('61823826 — release contract (shell 0.1.13)', () => {
  it('desktop-latest.json: stays 0.1.12 (last DMG that exists) until 0.1.13 publishes with the entitlement note', () => {
    // NOTE FOR FUTURE RELEASE-NOTES AUTHORS: from 0.1.13 onward the notes must
    // name the entitlement / mic-prompt fix forever (this assertion) AND the
    // 0.1.10 release content (desktop-file-picker-pins: display|capture|
    // presence + accessibility|screen recording|re-grant) — append, never
    // replace, the accumulating release-phrase set. scripts/dmg-build-61823826.sh
    // encodes exactly this wording.
    expect(FEED.url).toBe('https://digby.example.com/Digby.dmg');
    if (atLeast(FEED.version, '0.1.13')) {
      // The published 0.1.13+ DMG was built from a tree that had the
      // entitlement — its notes must say so (owner-facing: the fix finally
      // makes the macOS prompt appear).
      expect(FEED.notes).toMatch(/entitlement|microphone permission prompt|mic prompt/i);
    } else {
      // Never advertise a version whose DMG does not exist. 0.1.13 is the
      // entitlement-carrying version; the feed must sit at 0.1.12 (the newest
      // DMG that exists) until the owner rebuilds on the Mac.
      expect(atLeast('0.1.13', FEED.version)).toBe(true);
      expect(FEED.version).toBe('0.1.12');
    }
  });
});
