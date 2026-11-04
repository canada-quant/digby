/**
 * Ticket 8b13ec2b — the macOS desktop shell must FIRE the microphone TCC
 * request when voice input is invoked. macOS only lists an app under System
 * Settings → Privacy & Security → Microphone after the app itself calls the
 * requestAccess API (users cannot add an app by hand — drag-drop is
 * impossible by Apple design), so an app that never asks NEVER appears.
 *
 * Owner report 2026-10-23 ("control shift space … it opens the privacy
 * settings, but it doesn't … add Digby into the microphone section"): the
 * shortcut DID reach the app (the denial alert opened Settings) but Digby
 * never appeared in the Microphone list. Root cause: VoiceMode.swift asked
 * for SPEECH FIRST and only requested the microphone after Speech came back
 * authorized — a sticky denied/restricted Speech TCC record aborted with the
 * alert before the mic request ever fired. Both the alert's deep link (the
 * generic `?Privacy` pane, not `?Privacy_Microphone`) and the missing
 * Microphone list entry match the report exactly.
 *
 * This is a source-level pin (the p1-shell-pins idiom): the Swift toolchain
 * only exists on the build Mac, so CI (Linux) pins the source instead of
 * compiling it.
 *
 * RELEASE CONTRACT (encoded below): the fix ships in shell 0.1.12. Until the
 * owner rebuilds + republishes Digby.dmg on their Mac (signed + notarized —
 * cannot be done from CI/Linux), desktop-latest.json MUST stay ≤0.1.10 (it
 * currently advertises 0.1.10; 0.1.11 was never published): advertising a
 * version whose DMG does not exist hands users a broken update. Once the feed
 * moves to ≥0.1.12 the notes must mention the microphone permission fix.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const VOICE = readFileSync(
  fileURLToPath(new URL('../../macos-app/Sources/Digby/VoiceMode.swift', import.meta.url)),
  'utf8',
);
const MAIN = readFileSync(
  fileURLToPath(new URL('../../macos-app/Sources/Digby/main.swift', import.meta.url)),
  'utf8',
);
const PLIST = readFileSync(
  fileURLToPath(new URL('../../macos-app/Info.plist', import.meta.url)),
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

describe('8b13ec2b — mic TCC request fires (mic-first, unconditional)', () => {
  it('requestAuthorizations asks for the microphone FIRST, not after Speech', () => {
    // The entry point must call the mic request before any Speech request:
    // a sticky denied Speech record must never block the microphone ask.
    const fn = VOICE.split('private func requestAuthorizations(')[1]?.split('\n    }\n')[0] ?? '';
    expect(fn).not.toBe('');
    const micAt = fn.indexOf('requestMicPermission');
    const speechAt = fn.indexOf('SFSpeechRecognizer.requestAuthorization');
    expect(micAt).toBeGreaterThan(-1);
    expect(speechAt).toBeGreaterThan(-1);
    expect(micAt).toBeLessThan(speechAt);
    // The only branch between the two asks is the mic-denied guard — the mic
    // request itself is unconditional.
    const between = fn.slice(micAt, speechAt);
    expect(between).toMatch(/guard micGranted else/);
  });

  it('the mic ask itself calls the TCC request API (AVAudioApplication 14+, AVCaptureDevice fallback)', () => {
    const fn = VOICE.split('private func requestMicPermission(')[1]?.split('\n    }\n')[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).toContain('AVAudioApplication.requestRecordPermission');
    expect(fn).toContain('AVCaptureDevice.requestAccess(for: .audio)');
    expect(fn).toContain('#available(macOS 14.0, *)');
  });

  it('denial alerts deep-link the EXACT privacy sub-pane, not the generic Privacy screen', () => {
    expect(VOICE).toContain('pane: "Privacy_Microphone"');
    expect(VOICE).toContain('pane: "Privacy_SpeechRecognition"');
    expect(VOICE).toContain('com.apple.preference.security?\\(pane)');
    // The old generic link is gone.
    expect(VOICE).not.toMatch(/com\.apple\.preference\.security\?Privacy"\)/);
  });

  it('Info.plist still declares the mic usage string (the prompt cannot appear without it)', () => {
    expect(PLIST).toContain('<key>NSMicrophoneUsageDescription</key>');
  });

  it('⌃⇧Space (the shortcut the owner pressed) aliases Push to Talk via a LOCAL monitor', () => {
    expect(MAIN).toContain('addLocalMonitorForEvents(matching: .keyDown)');
    expect(MAIN).toContain('event.keyCode == 49');
    expect(MAIN).toContain('.contains(.control)');
    expect(MAIN).toContain('.contains(.shift)');
    expect(MAIN).toContain('voice.togglePushToTalk()');
    // Local only — a global key tap would need Accessibility and change the
    // app's permission story; the monitor must not be global.
    expect(MAIN).not.toContain('addGlobalMonitorForEvents');
  });
});

describe('8b13ec2b — release contract (shell 0.1.12)', () => {
  it('build-app.sh defaults to a version at or above the fix-carrying one (0.1.12)', () => {
    const m = BUILD_SH.match(/VERSION="\$\{VERSION:-([0-9]+\.[0-9]+\.[0-9]+)\}"/);
    expect(m).not.toBeNull();
    expect(atLeast(m![1], '0.1.12')).toBe(true);
  });

  it('desktop-latest.json: still ≤0.1.10 (dmg not yet rebuilt) or ≥0.1.12 noting the mic fix', () => {
    expect(FEED.url).toBe('https://digby.example.com/Digby.dmg');
    if (atLeast(FEED.version, '0.1.12')) {
      expect(FEED.notes).toMatch(/microphone|mic/i);
    } else {
      // The feed must NEVER advertise 0.1.11 (never published) or any version
      // whose DMG does not exist. Anything from 0.1.11 up to below 0.1.12
      // would be exactly that broken window.
      expect(atLeast('0.1.12', FEED.version)).toBe(true);
      expect(FEED.version).not.toBe('0.1.11');
    }
  });
});
