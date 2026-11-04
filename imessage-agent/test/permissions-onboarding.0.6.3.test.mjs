/**
 * First-launch permission onboarding (agent v0.6.3, owner ask 2026-09-26):
 * "shouldn't the macOS client request all necessary system settings changes
 * the first time you install, so you don't have to then separately do
 * Accessibility, Screen Recording etc?"
 *
 * Two layers, the house idiom (permissions.2f646c10):
 *   1. REAL unit tests of the pure pieces in dist/permissions.js
 *      (onboardingDue / missingPermissionPanes / onboardingMessage).
 *   2. SOURCE-BYTES pins on the macOS-only wiring: the native prompts
 *      (AXIsProcessTrustedWithOptions + a throwaway screencapture), the
 *      once-per-binary stamp, the kill switch, the never-a-gate ordering, and
 *      the Screen Recording ground-truth preference in the status advert.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');
const indexSrc = SRC('src/index.ts');
const computerSrc = SRC('src/computer.ts');
const permissionsSrc = SRC('src/permissions.ts');
const configSrc = SRC('src/config.ts');

const { onboardingDue, missingPermissionPanes, onboardingMessage, PANE_LABELS } =
  await import(join(pkgRoot, 'dist', 'permissions.js'));

// ── 1. Pure decisions ────────────────────────────────────────────────────────

const BIN = { dev: 16777234, ino: 9912345 };
const STAMP = { version: '0.6.3', dev: BIN.dev, ino: BIN.ino, at: '2026-09-26T13:00:00.000Z' };

test('onboardingDue: never stamped → due', () => {
  assert.equal(onboardingDue(null, BIN, '0.6.3'), true);
  assert.equal(onboardingDue(undefined, BIN, '0.6.3'), true);
});

test('onboardingDue: same binary + same version → NOT due (asked once)', () => {
  assert.equal(onboardingDue(STAMP, BIN, '0.6.3'), false);
});

test('onboardingDue: the binary was replaced (reinstall / app update) → due again', () => {
  assert.equal(onboardingDue(STAMP, { dev: BIN.dev, ino: BIN.ino + 1 }, '0.6.3'), true, 'new inode');
  assert.equal(onboardingDue(STAMP, { dev: BIN.dev + 1, ino: BIN.ino }, '0.6.3'), true, 'new device');
});

test('onboardingDue: a new agent version re-arms it', () => {
  assert.equal(onboardingDue(STAMP, BIN, '0.6.4'), true);
});

test('onboardingDue: cannot identify the running binary → trust the stamp (never re-prompt on a guess)', () => {
  assert.equal(onboardingDue(STAMP, null, '0.6.3'), false);
  assert.equal(onboardingDue(null, null, '0.6.3'), true, 'but a missing stamp still asks');
});

test('missingPermissionPanes: only the missing ones, in checklist order', () => {
  assert.deepEqual(missingPermissionPanes({ ax: true, sr: true, fda: true }), []);
  assert.deepEqual(missingPermissionPanes({ ax: false, sr: false, fda: false }), ['accessibility', 'screen-recording', 'full-disk-access']);
  assert.deepEqual(missingPermissionPanes({ ax: true, sr: false, fda: true }), ['screen-recording']);
  assert.deepEqual(missingPermissionPanes({ ax: false, sr: true, fda: false }), ['accessibility', 'full-disk-access']);
});

test('onboardingMessage: lists exactly the missing panes with the right verbs', () => {
  const all = onboardingMessage(['accessibility', 'screen-recording', 'full-disk-access']);
  assert.match(all, /three one-time macOS permissions/);
  assert.match(all, /Accessibility — lets Digby click and type/);
  assert.match(all, /Screen Recording — lets Digby see the screen/);
  assert.match(all, /Full Disk Access — lets Digby read your Messages/);
  // 51d8dbe0: the helper is named DYNAMICALLY (basename of process.execPath —
  // "DigbyAgent" on a CLI install, "DigbyHelper" in the .app bundle, "node"
  // in a dev checkout) so the file the user adds is the one Finder revealed.
  const helper = basename(process.execPath);
  assert.ok(all.includes(`already listed "${helper}"`), `the native prompts pre-list the helper (${helper}) — no drag dance for AX`);
  assert.match(all, /click \+ \(unlock first if needed\)/, 'FDA keeps the add-the-file steps (no prompt API exists)');
  assert.match(all, /No restart needed/);
  const one = onboardingMessage(['screen-recording']);
  assert.match(one, /one one-time macOS permission on this Mac/);
  assert.ok(!/Accessibility —/.test(one) && !/Full Disk Access —/.test(one), 'only the missing pane is listed');
  const two = onboardingMessage(['accessibility', 'full-disk-access']);
  assert.match(two, /two one-time macOS permissions/);
});

test('PANE_LABELS covers the panes (c44b19e9: calendars joins the set; 30d3c366: input-monitoring + automation)', () => {
  assert.deepEqual(PANE_LABELS, {
    accessibility: 'Accessibility',
    'screen-recording': 'Screen Recording',
    'full-disk-access': 'Full Disk Access',
    calendars: 'Calendars',
    // 30d3c366: the two grants a self-update actually orphaned — the labels
    // are the exact System Settings pane titles so the owner can find them.
    'input-monitoring': 'Input Monitoring',
    automation: 'Automation',
  });
});

// ── 2. Source-bytes pins on the macOS-only wiring ────────────────────────────

test('pin: the JXA runner has the native Accessibility prompt action (pre-lists DigbyHelper)', () => {
  const action = computerSrc.split("if (action === 'request_ax')")[1];
  assert.ok(action, 'request_ax action exists');
  assert.match(action.slice(0, 900), /AXIsProcessTrustedWithOptions\(\$\(\{ AXTrustedCheckOptionPrompt: true \}\)\)/);
  assert.match(computerSrc, /export async function requestAccessibilityPrompt\(\): Promise<boolean>/);
  assert.match(computerSrc, /\['request_ax', '\{\}'\]/, 'the TS side dispatches the action');
});

test('pin: Screen Recording is requested + probed with a throwaway screencapture (no bridged CGRequestScreenCaptureAccess)', () => {
  const fn = computerSrc.split('export async function probeScreenRecording(')[1];
  assert.ok(fn, 'probeScreenRecording exists');
  const body = fn.split('\n}\n')[0];
  assert.match(body, /runFile\('screencapture', \['-x', '-t', 'png', tmp\], 20000\)/);
  assert.match(body, /noteCaptureResult\(true\)/, 'a successful capture is the ground truth');
  assert.match(body, /could not create image from display/, 'the canonical denial latches false');
  assert.match(body, /unlinkSync\(tmp\)/, 'the throwaway file is removed');
});

test('pin: the real screenshot path feeds the Screen Recording ground truth both ways', () => {
  const shot = computerSrc.split('export async function screenshot(')[1].split('// ── Input actions')[0];
  // 933e6ca4 + reviewer round 2: a CORROBORATED solid-black (TCC-orphaned)
  // capture feeds the ground truth false before the success note; a clean or
  // uncorroborated capture feeds it true. Two focused pins (the full
  // sequence as one regex was too brittle against comment changes).
  const detector = shot.indexOf("try { solidCapture = pngSolidPlaceholder(readFileSync(png)); } catch { solidCapture = null; }");
  const verdict = shot.indexOf('if (convictAfterCorroboration(solidCapture, second)) {');
  const falseNote = shot.indexOf('noteCaptureResult(false);', verdict);
  const block = shot.indexOf("return permissionBlock(['screen'], { solidCapture: true });", verdict);
  const trueNote = shot.indexOf('noteCaptureResult(true);');
  assert.ok(detector > 0, 'the capture path decodes the frame');
  assert.ok(verdict > detector, 'the corroboration verdict follows the decode');
  assert.ok(falseNote > verdict && block > falseNote, 'a convicted capture notes false and returns the permission block');
  assert.ok(trueNote > block, 'a clean/unconvicted capture notes true after the gate');
  assert.match(shot, /could not create image from display\/i\.test\(msg\)\) \{\n\s*noteCaptureResult\(false\);/);
});

test('pin: the advertised sr flag prefers the capture ground truth and re-probes while denied', () => {
  const fn = permissionsSrc.split('export async function preflightMacPermissions(')[1].split('\n}\n')[0];
  assert.match(fn, /lastCaptureTruth\(\)/);
  // 30787bc4: the re-probe while denied is now BACKOFF-GATED (the pre-fix
  // unconditional re-probe was the every-minute permission dialog loop).
  assert.match(fn, /shouldProbeScreenRecording\(\) \? await probeScreenRecording\(\) : false/);
  assert.match(permissionsSrc, /export async function computePermissionStatus\(force = false\)/, 'onboarding forces a fresh probe');
  assert.match(permissionsSrc, /if \(force \|\| !probeCache \|\|/);
});

test('pin: onboarding runs once per helper BINARY, before the poll loop, never as a gate', () => {
  const fn = indexSrc.split('async function firstLaunchOnboarding(')[1];
  assert.ok(fn, 'firstLaunchOnboarding exists');
  const body = fn.split('async function runLoop(')[0];
  assert.match(body, /onboardingDue\(config\.permissionsOnboarded, current, AGENT_VERSION\)/);
  assert.match(body, /permissionsOnboarded: \{ version: AGENT_VERSION, dev: current\.dev, ino: current\.ino, at: new Date\(\)\.toISOString\(\) \}/, 'the stamp records binary + version');
  assert.match(body, /DIGBY_PERMISSIONS_ONBOARD/, 'kill switch');
  assert.match(body, /await computer\.requestAccessibilityPrompt\(\)/);
  assert.match(body, /await computer\.probeScreenRecording\(\)/);
  assert.match(body, /openFullDiskAccessGuidance\(\)/, 'FDA: pane + Finder reveal (no prompt API)');
  assert.match(body, /osascriptNotify\(onboardingMessage\(missing\), 'Digby — one-time setup'\)/, 'ONE consolidated checklist');
  assert.ok(!/process\.exit/.test(body), 'onboarding never exits — the poll loop always runs');
  // Ordering inside runLoop: onboarding → FDA nudge → poll loop; the nudge is
  // quiet (no dialog) and skips the pane on the launch that just onboarded.
  const runLoop = indexSrc.split('async function runLoop(')[1].split('async function pair(')[0];
  const onboardIdx = runLoop.indexOf('await firstLaunchOnboarding(config)');
  const fdaIdx = runLoop.indexOf('Full Disk Access missing');
  const loopIdx = runLoop.indexOf('while (true)');
  assert.ok(onboardIdx > 0 && fdaIdx > onboardIdx && loopIdx > fdaIdx, 'onboarding → FDA nudge → poll loop');
  assert.match(runLoop, /if \(!onboarded\) openFullDiskAccessGuidance\(\);/);
  assert.ok(!/osascriptNotify\(\s*'Almost done!/.test(runLoop), 'the old per-launch FDA dialog is gone (the checklist replaced it)');
});

test('pin: config carries the stamp and the version is the current release', () => {
  assert.match(configSrc, /permissionsOnboarded\?: \{ version: string; dev: number; ino: number; at: string \};/);
  assert.match(configSrc, /AGENT_VERSION = '0\.9\.19'/);
});
