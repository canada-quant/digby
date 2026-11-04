/**
 * Fix-pass regression tests (PR #1048 review, 2026-09-25).
 *
 * B1 — scroll-down threw 100% of the time: InputBuilder.mouse() wrote the
 *      wheel delta with writeUInt32LE, and wheel-down is NEGATIVE
 *      (notches * WHEEL_DELTA = -360) → Node's range check threw
 *      ERR_OUT_OF_RANGE before any SendInput call. The backend driver
 *      defaults direction to "down", so down is the COMMON case.
 *      This suite builds a real scroll-down INPUT plan and asserts the
 *      exact two's-complement bytes.
 *
 * SURROGATE — unicodeChar truncated a code POINT through the 16-bit wScan
 *      field: an astral char (emoji, U+1F600) wrote 0xF600 (private-use
 *      garbage). KEYEVENTF_UNICODE carries ONE UTF-16 code unit per event —
 *      astral chars must arrive as their surrogate PAIR.
 *
 * N1 — silent wrong-monitor clicks when geometry() is unavailable: the
 *      screenshot handler skipped origin folding on null geometry and the
 *      mapping defaulted to origin (0,0); on a multi-monitor box with a
 *      left/above secondary, every click landed on the WRONG monitor with
 *      coordinates that still verified. Now: geometry() exposed but
 *      unavailable → originUnknown is stamped and coordinate actions REFUSE
 *      (the macOS geometryMismatch contract, origin edition).
 *
 * Run: `npm test` in windows-agent/ (builds dist/ first — tests import the
 * BUILT module, i.e. exactly what ships). Plain .mjs, zero TypeScript
 * annotations, no "os" gate — the W0 learnings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');

// ── B1: wheel encoding — the pin MOVED to the Rust helper (cargo test) ──────

test('B1 regression: the scroll-down pin lives in the Rust helper crate (source pin)', () => {
  // The retired W1 adapter's InputBuilder pin was RETIRED-AND-REPLACED
  // (parent steer 2026-09-25): the Rust SendInput path now owns the INPUT
  // ABI. The byte-level pin runs as a cargo unit test
  // (rust-helper/src/input.rs::wheel_down_encodes_two_complement_never_throws);
  // this source-level guard catches drift from the node suite.
  const inputRs = readFileSync(join(pkgRoot, 'rust-helper', 'src', 'input.rs'), 'utf8');
  assert.ok(/mouseData takes i32: the two's-complement DWORD encoding for wheel/.test(inputRs), 'the W1 B1 lesson comment is preserved');
  assert.ok(/0xFFFF_FE98|-360/.test(inputRs), 'the -360 → 0xFFFFFE98 byte pin exists');
});

test('B1 regression: full scroll-down dispatch through commands (no input injected when mapping refuses)', async () => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  // Scripted seam: records calls, cursor read-back always arrives.
  const calls = [];
  let cursor = { x: 0, y: 0 };
  const deps = {
    surface: {
      async monitorSize() { return { width: 2560, height: 1600 }; },
      async captureJpeg() { return { base64: 'aGk=', width: 1568, height: 980 }; },
      async frontmost() { return { app: 'a.exe', window: 'A' }; },
    },
    input: {
      async cursorPos() { calls.push(['cursorPos']); return { ...cursor }; },
      async moveTo(x, y) { calls.push(['moveTo', x, y]); cursor = { x, y }; },
      async mouseDown() { calls.push(['down']); },
      async mouseUp() { calls.push(['up']); },
      async scroll(n) { calls.push(['scroll', n]); },
      async keyDown() { calls.push(['keyDown']); },
      async keyUp() { calls.push(['keyUp']); },
      async unicodeChar() { calls.push(['unicode']); },
      async clearModifiers() { calls.push(['clear']); },
      async open() { calls.push(['open']); },
    },
  };
  const GEO = { imageWidth: 1568, imageHeight: 980, screenWidth: 2560, screenHeight: 1600 };

  // 1. Scroll-down WITHOUT a target — the common case (backend default
  //    direction is "down"). Pre-fix this never even reached input.scroll.
  calls.length = 0;
  const down = await executeComputer('computer_scroll', { direction: 'down', amount: 3 }, deps, { ...GEO });
  assert.equal(down.ok, true, down.error);
  assert.deepEqual(calls, [['clear'], ['scroll', -3]], 'modifier sweep then NEGATIVE scroll');

  // 2. Scroll-down WITH a verified target — the B1+N1 intersection: mapping
  //    succeeds (origin verified), move verifies, wheel is negative.
  calls.length = 0;
  const downAt = await executeComputer('computer_scroll', { direction: 'down', amount: 3, x: 784, y: 490 }, deps, { ...GEO });
  assert.equal(downAt.ok, true, downAt.error);
  const scrollCall = calls.find((c) => c[0] === 'scroll');
  assert.equal(scrollCall[1], -3);
  assert.ok(calls.some((c) => c[0] === 'moveTo'), 'targeted scroll moves first');
  assert.ok(calls.some((c) => c[0] === 'cursorPos'), 'targeted scroll verifies the move');

  // 3. Scroll-up sanity: positive delta.
  calls.length = 0;
  const up = await executeComputer('computer_scroll', { direction: 'up', amount: 2 }, deps, { ...GEO });
  assert.equal(up.ok, true, up.error);
  assert.deepEqual(calls, [['clear'], ['scroll', 2]]);
});

// ── Surrogate fix: KEYEVENTF_UNICODE carries UTF-16 code UNITS ───────────────

test('unicodeUnits: astral chars split into surrogate pairs, BMP chars stay whole', async () => {
  const { unicodeUnits } = await import(join(pkgRoot, 'dist', 'win-platform.js'));
  // BMP char → one unit (unchanged behavior).
  assert.deepEqual(unicodeUnits('é'), [0xe9]);
  assert.deepEqual(unicodeUnits('中'), [0x4e2d]);
  // Astral: U+1F600 (😀) = high D83D + low DE00 — two events, in order.
  assert.deepEqual(unicodeUnits('😀'), [0xd83d, 0xde00]);
  // U+1F9E1 (🧡) = D83E DDE1.
  assert.deepEqual(unicodeUnits('🧡'), [0xd83e, 0xdde1]);
  // A BMP + astral + BMP mix preserves order.
  assert.deepEqual(unicodeUnits('a😀b'), [0x61, 0xd83d, 0xde00, 0x62]);
  // The OLD behavior would have written codePointAt(0) = 0x1F600, which
  // through the 16-bit field truncates to 0xF600 (private-use garbage).
  const oldTruncated = '😀'.codePointAt(0) & 0xffff;
  assert.equal(oldTruncated, 0xf600);
  assert.notEqual(unicodeUnits('😀')[0], 0xf600, 'never the truncated code point');
});

// ── N1: origin-unverified → coordinate actions REFUSE ───────────────────────

test('N1: geometry() null → originUnknown stamped, click and targeted scroll REFUSE, untargeted scroll/type still work', async () => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const calls = [];
  let cursor = { x: 0, y: 0 };
  const geo = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  const deps = {
    surface: {
      async monitorSize() { return { width: 2560, height: 1600 }; },
      async captureJpeg() { return { base64: 'aGk=', width: 1568, height: 980 }; },
      async frontmost() { return { app: 'a.exe', window: 'A' }; },
      // The N1 scenario: the surface EXPOSES geometry() but it fails.
      async geometry() { return null; },
    },
    input: {
      async cursorPos() { return { ...cursor }; },
      async moveTo(x, y) { calls.push(['moveTo', x, y]); cursor = { x, y }; },
      async mouseDown() { calls.push(['down']); },
      async mouseUp() { calls.push(['up']); },
      async scroll(n) { calls.push(['scroll', n]); },
      async keyDown() { calls.push(['keyDown']); },
      async keyUp() { calls.push(['keyUp']); },
      async unicodeChar() { calls.push(['unicode']); },
      async clearModifiers() { calls.push(['clear']); },
      async open() { calls.push(['open']); },
    },
  };

  // Screenshot still SUCCEEDS (a good capture is never dropped because the
  // origin probe failed)…
  const shot = await executeComputer('computer_screenshot', {}, deps, geo);
  assert.equal(shot.ok, true, shot.error);
  assert.ok(geo.originUnknown, 'originUnknown is stamped on the cache');
  assert.match(geo.originUnknown, /unavailable/, `cause is named: ${geo.originUnknown}`);
  assert.equal(geo.vx, undefined, 'no stale origin kept from a prior shot');
  assert.equal(geo.vy, undefined);

  // …and coordinate actions REFUSE (never a silent origin-(0,0) click).
  calls.length = 0;
  const click = await executeComputer('computer_click', { x: 784, y: 490 }, deps, geo);
  assert.equal(click.ok, false);
  assert.match(click.error, /origin unverified/, click.error);
  assert.match(click.error, /wrong monitor/, 'names the failure mode');
  assert.equal(calls.length, 0, 'NOTHING is injected on origin-unverified');

  // Targeted scroll refuses identically (it consumes coordinates too).
  calls.length = 0;
  const scrollAt = await executeComputer('computer_scroll', { direction: 'down', amount: 3, x: 784, y: 490 }, deps, geo);
  assert.equal(scrollAt.ok, false);
  assert.match(scrollAt.error, /origin unverified/, scrollAt.error);
  assert.equal(calls.length, 0, 'no input on origin-unverified targeted scroll');

  // Untargeted scroll needs no coordinates — still allowed (macOS parity).
  calls.length = 0;
  const scrollNoTarget = await executeComputer('computer_scroll', { direction: 'down', amount: 3 }, deps, geo);
  assert.equal(scrollNoTarget.ok, true, scrollNoTarget.error);
  assert.ok(calls.some((c) => c[0] === 'scroll'), 'wheel still scrolls without a target');

  // type/key consume no coordinates — NOT gated (macOS parity).
  calls.length = 0;
  const typed = await executeComputer('computer_type', { text: 'ok' }, deps, geo);
  assert.equal(typed.ok, true, typed.error);
  assert.ok(calls.some((c) => c[0] === 'unicode' || c[0] === 'keyDown'), 'typing proceeds without geometry');
});

test('N1: geometry() THROWS → same structured refusal (the probe failing loudly is not silently skipped)', async () => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const geo = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  const deps = {
    surface: {
      async monitorSize() { return { width: 2560, height: 1600 }; },
      async captureJpeg() { return { base64: 'aGk=', width: 1568, height: 980 }; },
      async frontmost() { return { app: 'a.exe', window: 'A' }; },
      async geometry() { throw new Error('EnumDisplayMonitors failed'); },
    },
    input: {
      async cursorPos() { return { x: 0, y: 0 }; },
      async moveTo() {}, async mouseDown() {}, async mouseUp() {},
      async scroll() {}, async keyDown() {}, async keyUp() {},
      async unicodeChar() {}, async clearModifiers() {}, async open() {},
    },
  };
  const shot = await executeComputer('computer_screenshot', {}, deps, geo);
  assert.equal(shot.ok, true, `screenshot survives a throwing probe: ${shot.error}`);
  assert.match(geo.originUnknown, /probe failed: EnumDisplayMonitors failed/);
  const click = await executeComputer('computer_click', { x: 100, y: 100 }, deps, geo);
  assert.equal(click.ok, false);
  assert.match(click.error, /origin unverified/);
});

test('N1: degenerate geometry snapshot (validateGeometry refuses) → originUnknown, not a guessed origin', async () => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const geo = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  const deps = {
    surface: {
      async monitorSize() { return { width: 2560, height: 1600 }; },
      async captureJpeg() { return { base64: 'aGk=', width: 1568, height: 980 }; },
      async frontmost() { return { app: 'a.exe', window: 'A' }; },
      // Degenerate: zero monitors.
      async geometry() { return { x: -1920, y: 0, width: 4480, height: 1600, monitors: [] }; },
    },
    input: {
      async cursorPos() { return { x: 0, y: 0 }; },
      async moveTo() {}, async mouseDown() {}, async mouseUp() {},
      async scroll() {}, async keyDown() {}, async keyUp() {},
      async unicodeChar() {}, async clearModifiers() {}, async open() {},
    },
  };
  const shot = await executeComputer('computer_screenshot', {}, deps, geo);
  assert.equal(shot.ok, true, shot.error);
  assert.match(geo.originUnknown, /invalid virtual-screen geometry snapshot: no monitors reported/);
  const click = await executeComputer('computer_click', { x: 100, y: 100 }, deps, geo);
  assert.equal(click.ok, false);
  assert.match(click.error, /origin unverified/);
});

test('N1: monitor-size drift between capture and geometry() → originUnknown (stale-origin guard)', async () => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const geo = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  const deps = {
    surface: {
      async monitorSize() { return { width: 2560, height: 1600 }; },
      async captureJpeg() { return { base64: 'aGk=', width: 1568, height: 980 }; },
      async frontmost() { return { app: 'a.exe', window: 'A' }; },
      // Valid snapshot BUT sized for a different desktop than monitorSize()
      // reported (topology changed between the two reads).
      async geometry() { return { x: -1920, y: 0, width: 4480, height: 1600, monitors: [
        { x: -1920, y: 0, width: 1920, height: 1080, dpi: 96 },
        { x: 0, y: 0, width: 2560, height: 1600, dpi: 96 },
      ] }; },
    },
    input: {
      async cursorPos() { return { x: 0, y: 0 }; },
      async moveTo() {}, async mouseDown() {}, async mouseUp() {},
      async scroll() {}, async keyDown() {}, async keyUp() {},
      async unicodeChar() {}, async clearModifiers() {}, async open() {},
    },
  };
  const shot = await executeComputer('computer_screenshot', {}, deps, geo);
  assert.equal(shot.ok, true, shot.error);
  assert.match(geo.originUnknown, /size changed mid-shot/);
  const click = await executeComputer('computer_click', { x: 100, y: 100 }, deps, geo);
  assert.equal(click.ok, false);
  assert.match(click.error, /origin unverified/);
});

test('N1: verified origin still folds in (the happy path is unchanged); recovery clears originUnknown', async () => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const calls = [];
  let cursor = { x: 0, y: 0 };
  const geo = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  let probes = 0;
  const deps = {
    surface: {
      async monitorSize() { return { width: 4480, height: 1600 }; },
      async captureJpeg() { return { base64: 'aGk=', width: 2240, height: 800 }; },
      async frontmost() { return { app: 'a.exe', window: 'A' }; },
      async geometry() {
        probes++;
        if (probes === 1) return null; // first shot: probe fails
        // Second shot: the multi-monitor truth (secondary LEFT of primary).
        return { x: -1920, y: 0, width: 4480, height: 1600, monitors: [
          { x: -1920, y: 0, width: 1920, height: 1080, dpi: 96 },
          { x: 0, y: 0, width: 2560, height: 1600, dpi: 96 },
        ] };
      },
    },
    input: {
      async cursorPos() { return { ...cursor }; },
      async moveTo(x, y) { calls.push(['moveTo', x, y]); cursor = { x, y }; },
      async mouseDown() { calls.push(['down']); },
      async mouseUp() { calls.push(['up']); },
      async scroll() {},
      async keyDown() {}, async keyUp() {},
      async unicodeChar() {}, async clearModifiers() {}, async open() {},
    },
  };

  // First screenshot: probe fails → originUnknown.
  await executeComputer('computer_screenshot', {}, deps, geo);
  assert.ok(geo.originUnknown);
  const refused = await executeComputer('computer_click', { x: 100, y: 100 }, deps, geo);
  assert.equal(refused.ok, false);

  // Second screenshot: probe succeeds → origin folds in, originUnknown
  // CLEARS (a single bad probe must not poison the session forever).
  await executeComputer('computer_screenshot', {}, deps, geo);
  assert.equal(geo.originUnknown, undefined, 'recovered on the next verified shot');
  assert.equal(geo.vx, -1920);
  assert.equal(geo.vy, 0);
  // Click in the secondary monitor's half of the image → virtual coords
  // including the NEGATIVE origin (the wrong-monitor trap, now correct).
  calls.length = 0;
  const ok = await executeComputer('computer_click', { x: 100, y: 100 }, deps, geo);
  assert.equal(ok.ok, true, ok.error);
  const moveTo = calls.find((c) => c[0] === 'moveTo');
  // image x 100/2240 of 4480 = 200; 200 + (-1920) = -1720.
  // image y 100/800 of 1600 = 200; 200 + 0 = 200.
  assert.deepEqual(moveTo, ['moveTo', -1720, 200], 'click maps into virtual-screen space with the negative origin');
});

test('N1: surfaces WITHOUT geometry() keep the single-monitor origin-(0,0) contract (no behavior change)', async () => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const calls = [];
  let cursor = { x: 0, y: 0 };
  const geo = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  const deps = {
    surface: {
      async monitorSize() { return { width: 2560, height: 1600 }; },
      async captureJpeg() { return { base64: 'aGk=', width: 1568, height: 980 }; },
      async frontmost() { return { app: 'a.exe', window: 'A' }; },
      // NO geometry() method at all — the documented single-monitor seam.
    },
    input: {
      async cursorPos() { return { ...cursor }; },
      async moveTo(x, y) { calls.push(['moveTo', x, y]); cursor = { x, y }; },
      async mouseDown() {}, async mouseUp() {},
      async scroll() {}, async keyDown() {}, async keyUp() {},
      async unicodeChar() {}, async clearModifiers() {}, async open() {},
    },
  };
  await executeComputer('computer_screenshot', {}, deps, geo);
  assert.equal(geo.originUnknown, undefined, 'no geometry() → no originUnknown (single-monitor contract)');
  assert.equal(geo.vx, undefined);
  const click = await executeComputer('computer_click', { x: 784, y: 490 }, deps, geo);
  assert.equal(click.ok, true, click.error);
  const moveTo = calls.find((c) => c[0] === 'moveTo');
  assert.deepEqual(moveTo, ['moveTo', 1280, 800], 'origin (0,0) mapping is unchanged');
});

// ── imageToScreen pure-layer pin (the N1 gate) ────────────────���─────────────

test('imageToScreen: originUnknown refuses before any coordinate math', async () => {
  const { imageToScreen } = await import(join(pkgRoot, 'dist', 'win-platform.js'));
  const g = { imageWidth: 1568, imageHeight: 980, screenWidth: 2560, screenHeight: 1600, originUnknown: 'probe failed' };
  const r = imageToScreen(100, 100, g);
  assert.ok('error' in r, JSON.stringify(r));
  assert.match(r.error, /origin unverified/);
  assert.match(r.error, /refusing to map coordinates/);
  // Without originUnknown the same geometry maps normally.
  const ok = imageToScreen(784, 490, { imageWidth: 1568, imageHeight: 980, screenWidth: 2560, screenHeight: 1600 });
  assert.ok('x' in ok);
  assert.equal(ok.x, 1280);
  assert.equal(ok.y, 800);
});
