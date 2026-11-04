/**
 * Ticket e2915963 (2026-10-24, agent-filed) — "Mac agent self-update loses
 * Accessibility TCC grant — unattended computer-use dies at 0 steps until
 * owner re-grants" — AGENT HALF (the runtime swap that caused it + the
 * on-Mac surfacing that was missing).
 *
 * THE MISHAP, replayed from the incident timeline (cqlstannembp1):
 *   • 14:48:06Z — the agent self-updated 0.9.4 → 0.9.6 (new helper pid
 *     12805). The 0.9.5+ runtime heal (21c68e74) fired on the new
 *     process's first idle poll and RENAMED a fresh DigbyAgent binary over
 *     the stable path ~/…/Digby/bin/DigbyAgent.
 *   • macOS TCC grants (Accessibility / Screen Recording / Full Disk
 *     Access) attach to the EXACT FILE (bundle identity = path + inode +
 *     code signature). The rename created a new inode → the grants were
 *     silently orphaned: System Settings still showed the switch ON while
 *     the OS re-prompted into the void (owner absent, TCC db mtime
 *     unchanged at 06:14:13Z — the OS never wrote a grant).
 *   • 15:01Z — the next computer_task dispatch returned
 *     "[COMPUTER_TASK — UNAVAILABLE] Computer use could not get a first
 *     screenshot from your Mac: Missing macOS permission(s): Accessibility"
 *     with steps: 0. A scheduled AWS-console drive stood down at zero steps.
 *
 * THE FIX, pinned here (two halves):
 *   A. runtime-dylib.ts — a byte-IDENTICAL staged binary NEVER swaps (the
 *      install.sh cmp -s idiom, 933e6ca4): a re-heal on an already-healed
 *      Mac must not recreate the inode for nothing. A REAL swap (bytes
 *      genuinely differ) stamps runtime-swap.json so the successor process
 *      can attribute the regression.
 *   B. index.ts — the run loop snapshots the TCC baseline at its first
 *      poll and surfaces a before-true → now-false flip LOUDLY (osascript
 *      notification + dialog + pane deep-link + log line), once per
 *      regression episode. The backend half (poll-seam detection + Telegram
 *      push) lives in the backend's e2915963 suite.
 *
 * WHAT CI CAN AND CANNOT REPLAY: the true mishap needs macOS TCC + launchd;
 * CI (Linux) replays the DETERMINISTIC CORE — the byte-equality gate, the
 * swap-stamp round trip, and the regression decision functions — plus the
 * source-byte pins of the loop wiring (the same idiom as
 * runtime-dylib.21c68e74 / permissions.2f646c10: the macOS-only path ships
 * in the served tarball and must stay correct on every platform).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'os';

import {
  binariesEqual,
  writeRuntimeSwapStamp,
  readRuntimeSwapStamp,
  clearRuntimeSwapStamp,
  digbyRuntimeDir,
} from '../dist/runtime-dylib.js';
import { whichPermissionsRegressed, regressionPane, regressionMessage } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const read = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');

// ── A. The byte-identical swap gate (the grant-preserving half) ──────────────

test('e2915963: binariesEqual — two byte-identical files are equal (the grant survives: no swap)', () => {
  const dir = join(tmpdir(), `e2915963-eq-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const a = join(dir, 'DigbyAgent');
  const b = join(dir, 'staged-node');
  // A real Mach-O-ish payload (content irrelevant — byte equality only).
  const bytes = Buffer.alloc(4096, 7);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  writeFileSync(a, bytes);
  writeFileSync(b, bytes);
  assert.equal(binariesEqual(a, b), true);
  rmSync(dir, { recursive: true, force: true });
});

test('e2915963: binariesEqual — a single differing byte is NOT equal (a REAL runtime change swaps)', () => {
  const dir = join(tmpdir(), `e2915963-ne-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const a = join(dir, 'DigbyAgent');
  const b = join(dir, 'staged-node');
  const bytes = Buffer.alloc(4096, 7);
  writeFileSync(a, bytes);
  const bytesB = Buffer.from(bytes);
  bytesB[4095] = 9;
  writeFileSync(b, bytesB);
  assert.equal(binariesEqual(a, b), false);
  rmSync(dir, { recursive: true, force: true });
});

test('e2915963: binariesEqual — size difference is NOT equal; missing files are NOT equal', () => {
  const dir = join(tmpdir(), `e2915963-miss-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const a = join(dir, 'DigbyAgent');
  writeFileSync(a, Buffer.alloc(100, 1));
  const b = join(dir, 'staged-node');
  writeFileSync(b, Buffer.alloc(101, 1));
  assert.equal(binariesEqual(a, b), false);
  assert.equal(binariesEqual(a, join(dir, 'nope')), false);
  assert.equal(binariesEqual(join(dir, 'nope'), join(dir, 'nope2')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('e2915963: binariesEqual — a 3 MB multi-chunk comparison works (the official node tarball is ~100 MB)', () => {
  const dir = join(tmpdir(), `e2915963-big-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const a = join(dir, 'DigbyAgent');
  const b = join(dir, 'staged-node');
  // 3 MB of pseudo-random-ish bytes — exercises the chunked loop (> 1 MB).
  const seed = (i) => (i * 2654435761) % 256;
  const big = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = seed(i);
  writeFileSync(a, big);
  writeFileSync(b, Buffer.from(big));
  assert.equal(binariesEqual(a, big.length === 0 ? a : b), true);
  // A late-byte difference in the SECOND chunk is still caught.
  const c = Buffer.from(big);
  c[2 * 1024 * 1024 + 5] = (c[2 * 1024 * 1024 + 5] + 1) % 256;
  writeFileSync(b, c);
  assert.equal(binariesEqual(a, b), false);
  rmSync(dir, { recursive: true, force: true });
});

// ── A2. The swap stamp (attribution for the successor process) ───────────────

test('e2915963: the swap stamp round-trips and self-cleans (readRuntimeSwapStamp → clear → null)', () => {
  // readRuntimeSwapStamp/writeRuntimeSwapStamp default to the REAL homedir;
  // the functions take an explicit home exactly so tests (and other users on
  // the same Mac) never touch the real runtime dir.
  const home = join(tmpdir(), `e2915963-home-${Date.now()}`);
  mkdirSync(join(home, 'Library', 'Application Support', 'Digby', 'bin'), { recursive: true });
  const bin = join(home, 'Library', 'Application Support', 'Digby', 'bin', 'DigbyAgent');
  writeFileSync(bin, Buffer.alloc(64, 1));

  writeRuntimeSwapStamp(bin);
  const stamp = readRuntimeSwapStamp(home);
  assert.ok(stamp, 'the stamp must read back');
  assert.equal(stamp.to, bin);
  assert.ok(stamp.swappedAt, 'the stamp carries when the swap happened');
  assert.ok(Number.isFinite(stamp.ino), 'the stamp carries the new inode identity');

  clearRuntimeSwapStamp(home);
  assert.equal(readRuntimeSwapStamp(home), null, 'the stamp is consumed');
  rmSync(home, { recursive: true, force: true });
});

test('e2915963: a garbage or absent stamp reads as null (degrades to unattributed regression — the pre-fix behavior)', () => {
  const home = join(tmpdir(), `e2915963-home2-${Date.now()}`);
  mkdirSync(join(home, 'Library', 'Application Support', 'Digby', 'bin'), { recursive: true });
  assert.equal(readRuntimeSwapStamp(home), null);
  writeFileSync(join(digbyRuntimeDir(home), 'runtime-swap.json'), 'not json at all');
  assert.equal(readRuntimeSwapStamp(home), null);
  writeFileSync(join(digbyRuntimeDir(home), 'runtime-swap.json'), JSON.stringify({ swappedAt: 123 }));
  assert.equal(readRuntimeSwapStamp(home), null, 'a non-string swappedAt/to is rejected');
  rmSync(home, { recursive: true, force: true });
});

// ── B. The regression decision core (the surfacing half) ─────────────────────

test('e2915963: the incident shape — baseline {ax:true} → ax missing is exactly ["ax"]', () => {
  assert.deepEqual(whichPermissionsRegressed({ ax: true, sr: true, fda: true }, { ax: false, sr: true, fda: true }), ['ax']);
});

test('e2915963: all three grants lost at once (what a runtime swap actually orphans)', () => {
  const r = whichPermissionsRegressed({ ax: true, sr: true, fda: true }, { ax: false, sr: false, fda: false });
  assert.deepEqual([...r].sort(), ['ax', 'fda', 'sr']);
});

test('e2915963: a grant LANDING (false→true) is not a regression; never-granted is not either', () => {
  assert.deepEqual(whichPermissionsRegressed({ ax: false }, { ax: true }), []);
  assert.deepEqual(whichPermissionsRegressed({ ax: false, sr: false }, { ax: false, sr: false }), []);
});

test('e2915963: null baseline (first poll) never fabricates a regression', () => {
  assert.deepEqual(whichPermissionsRegressed(null, { ax: false }), []);
});

test('e2915963: the regression message names the grant, the cause and the fix', () => {
  const msg = regressionMessage(['ax'], 'runtime binary swapped 2026-10-24T14:48:06.000Z');
  assert.match(msg, /Accessibility/);
  assert.match(msg, /runtime binary swapped/);
  assert.match(msg, /Privacy & Security/);
  assert.match(msg, /DigbyAgent/);
});

test('e2915963: the unattributed variant still surfaces (cause null)', () => {
  const msg = regressionMessage(['sr'], null);
  assert.match(msg, /Screen Recording/);
  assert.ok(!msg.includes('This happened because'), 'no cause line when unattributed');
});

test('e2915963: the pane deep-link vocabulary matches the server-validated set (never a drift)', () => {
  assert.equal(regressionPane('ax'), 'accessibility');
  assert.equal(regressionPane('sr'), 'screen-recording');
  assert.equal(regressionPane('fda'), 'full-disk-access');
});

// ── C. Source-byte pins: the loop + heal wiring (the house idiom) ────────────

test('e2915963 pin: the heal REFUSES a byte-identical swap (the grant-preserving gate)', () => {
  const src = read('src/runtime-dylib.ts');
  assert.match(src, /if \(binariesEqual\(stagedBin, bin\)\) \{/, 'the byte-equality gate guards the swap');
  assert.match(src, /staged official build is byte-identical to the current runtime/, 'the skip reason names the TCC story');
});

test('e2915963 pin: a REAL swap stamps runtime-swap.json before exiting', () => {
  const src = read('src/runtime-dylib.ts');
  assert.match(src, /writeRuntimeSwapStamp\(bin\)/, 'the swap writes the attribution stamp');
});

test('e2915963 pin: the run loop snapshots the TCC baseline on the first poll and compares every later poll', () => {
  const src = read('src/index.ts');
  assert.match(src, /let tccBaseline/, 'the baseline exists');
  assert.match(src, /whichPermissionsRegressed\(tccBaseline, permissions\)/, 'every later poll compares against the baseline');
});

test('e2915963 pin: a detected regression surfaces ONCE per episode (no dialog every 25 s poll)', () => {
  const src = read('src/index.ts');
  assert.match(src, /lastRegressionKey !== key/, 'the once-per-episode gate');
  assert.match(src, /lastRegressionKey = null; \/\/ healed/, 'the gate re-arms when the grants heal');
});

test('e2915963 pin: the surfacing fires the notification + dialog + pane deep-link (all three channels)', () => {
  const src = read('src/index.ts');
  assert.match(src, /display notification/, 'a macOS notification (lands in the notification center for an absent owner)');
  assert.match(src, /osascriptNotify\(msg, 'Digby — permission re-grant needed'\)/, 'the dialog');
  assert.match(src, /PANE_URLS\[regressionPane\(first\)\]/, 'the System Settings deep-link');
});

test('e2915963 pin (review F2): the surfacing is FIRE-AND-FORGET — the poll loop never awaits the click-waiting dialog', () => {
  const src = read('src/index.ts');
  // The dialog (`display dialog` waits up to 120 s for a click) must never be
  // awaited by the poll loop — a regression surfacing while the owner is
  // absent would otherwise stall every poll for two minutes.
  assert.match(src, /function surfacePermissionRegression\(keys: TccGrantKey\[\], cause: string \| null\): void/, 'the surfacing returns void (not a Promise)');
  assert.doesNotMatch(src, /await surfacePermissionRegression\(/, 'no call site awaits it');
});

test('e2915963 pin (review F6): a swap successor SEEDS its baseline from the predecessor\'s last-advertised grants', () => {
  const src = read('src/index.ts');
  assert.match(src, /lastAdvertisedPermissions/, 'the config carries the predecessor grants');
  const cfg = read('src/config.ts');
  assert.match(cfg, /lastAdvertisedPermissions\?:/, 'the config type declares it');
  assert.match(src, /whichPermissionsRegressed\(prev, permissions\)/, 'the successor compares the predecessor grants to its first read');
});

test('e2915963 pin: the runtime-swap stamp is read ONCE and consumed (the swap is the predecessor\'s act)', () => {
  const src = read('src/index.ts');
  assert.match(src, /readRuntimeSwapStamp\(\)/, 'the stamp is read');
  assert.match(src, /clearRuntimeSwapStamp\(\)/, 'and consumed');
});
