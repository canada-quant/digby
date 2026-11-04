/**
 * v0.6.1 — multi-display capture + owner-presence facts (cu-diag 2026-09-25,
 * fix #1 / #6 / #9).
 *
 * THE INCIDENT (2026-09-25 23:55Z–00:07Z, Pauls-MBP): lid closed, built-in
 * LCD still CG-main, a Dell U2717D at x=1728. `screencapture -D 1` captured
 * the built-in panel forever while Cmd+Space → "TextEdit" → Return landed on
 * the Dell — every frame byte-identical, the harness counted dead input, the
 * supervisor told the owner keystrokes were dead. tccd had allowed every
 * event. The fix captures the display that OWNS the frontmost window.
 *
 * Pins:
 *   (a) chooseCaptureDisplay decision table (frontmost → pointer → main;
 *       override modes; empty topology → legacy),
 *   (b) screenPointFor translates through the CAPTURED display's origin,
 *   (c) humanIdleSeconds excludes the agent's own posted events,
 *   (d) pngDimensions reads the IHDR,
 *   (e) structural pins on the shipped source (the `displays` JXA action,
 *       the -D <index> capture, the stamped result fields, the own-input marks).
 *
 * Run: `npm test` in imessage-agent/ (builds dist/ first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const {
  chooseCaptureDisplay, displayContaining, screenPointFor, humanIdleSeconds, pngDimensions, captureModeFromEnv,
  normalizeTopology, attributeCapturedDisplay, displayMatchesPixels, pixelCheckEnabled, frontWindowProbeEnabled,
  remoteSessionIgnoreKinds, remoteKindsFromDisplayNames, applyRemoteSessionIgnore,
} = await import(join(pkgRoot, 'dist', 'computer.js'));

// The incident topology: built-in 1728×1117 pt at (0,0) is CG-main; the Dell
// 2560×1440 pt sits at x=1728.
const BUILTIN = { id: 1, index: 1, x: 0, y: 0, width: 1728, height: 1117, pixelWidth: 3456, pixelHeight: 2234, name: 'Color LCD' };
const DELL = { id: 2, index: 2, x: 1728, y: 0, width: 2560, height: 1440, pixelWidth: 2560, pixelHeight: 1440, name: 'DELL U2717D' };
const topo = (over = {}) => ({ main: 1, displays: [BUILTIN, DELL], pointer: null, frontWindow: null, hidIdleRaw: null, ...over });

// ── (a) the capture-display decision table ───────────────────────────────────

test('incident replay: TextEdit on the Dell → the Dell is captured, not CG-main', () => {
  const r = chooseCaptureDisplay(topo({ frontWindow: { app: 'TextEdit', window: 'Untitled', x: 1900, y: 200, w: 800, h: 600 } }));
  assert.equal(r.display.id, 2);
  assert.equal(r.reason, 'frontmost');
  assert.equal(r.frontmostWindowDisplayId, 2);
});

test('a window straddling both displays goes to the display holding its center', () => {
  // center x = 1600 + 400 = 2000 → the Dell
  const r = chooseCaptureDisplay(topo({ frontWindow: { app: 'Safari', window: 'w', x: 1600, y: 100, w: 800, h: 500 } }));
  assert.equal(r.display.id, 2);
  // center x = 1400 + 200 = 1600 → the built-in
  const r2 = chooseCaptureDisplay(topo({ frontWindow: { app: 'Safari', window: 'w', x: 1400, y: 100, w: 400, h: 500 } }));
  assert.equal(r2.display.id, 1);
});

test('no frontmost window frame → the pointer display; no pointer → main', () => {
  const p = chooseCaptureDisplay(topo({ frontWindow: { app: 'Finder', window: '' }, pointer: { x: 3000, y: 700 } }));
  assert.equal(p.display.id, 2);
  assert.equal(p.reason, 'pointer');
  assert.equal(p.frontmostWindowDisplayId, null);
  assert.equal(p.pointerDisplayId, 2);
  const m = chooseCaptureDisplay(topo());
  assert.equal(m.display.id, 1);
  assert.equal(m.reason, 'main');
});

test('single display (Screen Sharing virtual display collapsed the topology) → that display, count 1', () => {
  const vd = { id: 9, index: 1, x: 0, y: 0, width: 1920, height: 1080, pixelWidth: 3840, pixelHeight: 2160, name: 'Screen Sharing Virtual Display' };
  const r = chooseCaptureDisplay({ main: 9, displays: [vd], pointer: { x: 10, y: 10 }, frontWindow: { app: 'Terminal', window: 'zsh', x: 0, y: 0, w: 1920, h: 1080 }, hidIdleRaw: null });
  assert.equal(r.display.id, 9);
  assert.equal(r.reason, 'frontmost');
});

test('DIGBY_CAPTURE_DISPLAY=main restores the pre-0.6.1 behavior even with focus on the Dell', () => {
  const r = chooseCaptureDisplay(topo({ frontWindow: { app: 'TextEdit', window: 'x', x: 1900, y: 200, w: 800, h: 600 } }), 'main');
  assert.equal(r.display.id, 1);
  assert.equal(r.reason, 'override');
  // …but the frontmost-window display is STILL reported so the backend can
  // warn about the focus split.
  assert.equal(r.frontmostWindowDisplayId, 2);
});

test('a numeric override forces that display index; an unknown index falls through to auto', () => {
  assert.equal(chooseCaptureDisplay(topo(), 2).display.id, 2);
  assert.equal(chooseCaptureDisplay(topo(), 7).display.id, 1); // no index 7 → auto → main
});

test('empty topology → legacy path (null display)', () => {
  const r = chooseCaptureDisplay({ main: 0, displays: [], pointer: null, frontWindow: null, hidIdleRaw: null });
  assert.equal(r.display, null);
  assert.equal(r.reason, 'legacy');
});

test('captureModeFromEnv parses the kill switch', () => {
  assert.equal(captureModeFromEnv(undefined), 'auto');
  assert.equal(captureModeFromEnv(''), 'auto');
  assert.equal(captureModeFromEnv('MAIN'), 'main');
  assert.equal(captureModeFromEnv('frontmost'), 'frontmost');
  assert.equal(captureModeFromEnv('2'), 2);
  assert.equal(captureModeFromEnv('garbage'), 'auto');
});

test('displayContaining: shared edges resolve to exactly one display', () => {
  assert.equal(displayContaining([BUILTIN, DELL], 1728, 10).id, 2);
  assert.equal(displayContaining([BUILTIN, DELL], 1727.9, 10).id, 1);
  assert.equal(displayContaining([BUILTIN, DELL], -1, 10), null);
});

// ── (b) clicks translate through the CAPTURED display's origin ───────────────

test('screenPointFor adds the captured display origin (a Dell frame click lands on the Dell)', () => {
  const dellShot = { imageWidth: 1568, imageHeight: 882, screenWidth: 2560, screenHeight: 1440, originX: 1728, originY: 0 };
  assert.deepEqual(screenPointFor(0, 0, dellShot), { px: 1728, py: 0 });
  assert.deepEqual(screenPointFor(784, 441, dellShot), { px: 1728 + 1280, py: 720 });
});

test('screenPointFor without an origin is byte-identical to the 4e4d56ff contract (legacy shots)', () => {
  const shot = { imageWidth: 1568, imageHeight: 882, screenWidth: 1920, screenHeight: 1080 };
  assert.deepEqual(screenPointFor(797, 183, shot), { px: 976, py: 224 });
});

// ── (c) human idle excludes the agent's own events ───────────────────────────

test('humanIdleSeconds: a raw reading pointing at a human event is reported as-is', () => {
  const now = 1_000_000;
  const r = humanIdleSeconds(30, now, [], null);
  assert.equal(r.idle, 30);
  assert.equal(r.lastHuman, now - 30_000);
});

test('humanIdleSeconds: a raw reading pointing INSIDE our own type burst is NOT the owner', () => {
  const now = 1_000_000;
  const own = [{ start: now - 2000, end: now - 500 }]; // we typed 2 s ago
  const r = humanIdleSeconds(0.7, now, own, null); // OS says "input 0.7 s ago" — ours
  assert.equal(r.idle, null); // no human event ever observed → unknown, never "active"
  const r2 = humanIdleSeconds(0.7, now, own, now - 90_000); // a human event 90 s earlier
  assert.equal(r2.idle, 90);
});

test('humanIdleSeconds: a human event AFTER our burst is detected and advances lastHuman', () => {
  const now = 1_000_000;
  const own = [{ start: now - 20_000, end: now - 18_000 }];
  const r = humanIdleSeconds(3, now, own, now - 60_000); // event 3 s ago, well outside our burst
  assert.equal(r.idle, 3);
  assert.equal(r.lastHuman, now - 3000);
});

test('humanIdleSeconds: null raw reading falls back to the last observed human event', () => {
  const now = 1_000_000;
  assert.equal(humanIdleSeconds(null, now, [], null).idle, null);
  assert.equal(humanIdleSeconds(null, now, [], now - 5000).idle, 5);
});

// ── (d) PNG IHDR ─────────────────────────────────────────────────────────────

test('pngDimensions reads the IHDR width/height, rejects non-PNG bytes', () => {
  const buf = Buffer.alloc(24);
  buf.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(2560, 16);
  buf.writeUInt32BE(1440, 20);
  assert.deepEqual(pngDimensions(buf), { width: 2560, height: 1440 });
  assert.equal(pngDimensions(Buffer.from('not a png at all, really')), null);
  assert.equal(pngDimensions(Buffer.alloc(3)), null);
});

// ── (d2) v0.6.2 — the PNG pixel check is REAL (review blocking #1) ──────────
//
// Live probe on a 3× DELL U2718Q Mac (2026-09-25): the ObjC bridge returns
// CGDisplayPixelsWide/High as STRINGS ("2304") equal to the POINT size on
// HiDPI, while the backing PNG is 4608×2592. 0.6.1 compared number to string
// (never equal), `find` never matched, every capture logged "matches no
// display's pixel size" and no re-attribution ever happened.

const png = (w, h) => ({ width: w, height: h });
// The exact JXA payload shape 0.6.1 shipped: strings, point-sized "pixels".
const RAW_STRING_TOPO = {
  main: 1,
  displays: [
    { id: 1, index: 1, x: 0, y: 0, width: 2304, height: 1296, pixelWidth: '2304', pixelHeight: '1296', name: 'DELL U2718Q (2)' },
    { id: 2, index: 2, x: -2304, y: 0, width: 2304, height: 1296, pixelWidth: '2304', pixelHeight: '1296', name: 'DELL U2718Q (1)' },
    { id: 3, index: 3, x: 2304, y: 0, width: 2304, height: 1296, pixelWidth: '2304', pixelHeight: '1296', name: 'DELL U2718Q (3)' },
  ],
  pointer: { x: '265.03', y: '65.8' },
  frontWindow: null,
  hidIdleRaw: '3361.27',
};

test('normalizeTopology coerces every bridged STRING to a number ("0" is falsy again)', () => {
  const t = normalizeTopology({ ...RAW_STRING_TOPO, displays: [{ ...RAW_STRING_TOPO.displays[0], pixelWidth: '0', pixelHeight: '0' }, RAW_STRING_TOPO.displays[1]] });
  assert.equal(typeof t.displays[0].pixelWidth, 'number');
  assert.equal(t.displays[0].pixelWidth, 0);
  assert.ok(!(t.displays[0].pixelWidth && t.displays[0].pixelHeight), 'an unreadable pixel size must be falsy, not the truthy string "0"');
  assert.equal(t.displays[1].pixelWidth, 2304);
  assert.deepEqual(t.pointer, { x: 265.03, y: 65.8 });
  assert.equal(t.hidIdleRaw, 3361.27);
  assert.equal(t.main, 1);
  assert.equal(normalizeTopology({ displays: [] }), null);
  assert.equal(normalizeTopology(null), null);
});

test('normalizeTopology keeps a front-window frame only when all four numbers are present', () => {
  const t = normalizeTopology({ ...RAW_STRING_TOPO, frontWindow: { app: 'TextEdit', window: 'Untitled', x: '1900', y: '200', w: '800', h: '600' } });
  assert.deepEqual(t.frontWindow, { app: 'TextEdit', window: 'Untitled', x: 1900, y: 200, w: 800, h: 600 });
  const t2 = normalizeTopology({ ...RAW_STRING_TOPO, frontWindow: { app: 'Finder', window: '' } });
  assert.equal(t2.frontWindow.app, 'Finder');
  assert.equal(t2.frontWindow.x, undefined);
});

test('HiDPI PNG (4608×2592) through the 0.6.1 payload: the CHOSEN Dell is confirmed by integer scale, not re-attributed', () => {
  const t = normalizeTopology(RAW_STRING_TOPO);
  const chosen = t.displays[1];
  const r = attributeCapturedDisplay(t.displays, chosen, png(4608, 2592));
  assert.equal(r.how, 'confirmed');
  assert.equal(r.display.id, 2);
  assert.ok(displayMatchesPixels(chosen, png(4608, 2592)), '2304×1296 pt at 2× is 4608×2592 px');
  assert.ok(displayMatchesPixels(chosen, png(2304, 1296)), '…and at 1×');
  assert.ok(!displayMatchesPixels(chosen, png(3456, 2234)));
});

test('the 0.6.2 payload (numeric backing pixels) confirms exactly and re-attributes a swapped -D ordering', () => {
  const builtin = { ...BUILTIN };
  const dell = { ...DELL };
  // asked for the built-in (index 1), got the Dell's 2560×1440 PNG → the Dell
  const r = attributeCapturedDisplay([builtin, dell], builtin, png(2560, 1440));
  assert.equal(r.how, 'reattributed');
  assert.equal(r.display.id, 2);
  // asked for the Dell, got the built-in's 3456×2234 backing PNG → the built-in
  const r2 = attributeCapturedDisplay([builtin, dell], dell, png(3456, 2234));
  assert.equal(r2.how, 'reattributed');
  assert.equal(r2.display.id, 1);
  // string-typed backing pixels through normalizeTopology behave the same
  const t = normalizeTopology({ main: 1, displays: [{ ...builtin, pixelWidth: '3456', pixelHeight: '2234' }, { ...dell, pixelWidth: '2560', pixelHeight: '1440' }] });
  assert.equal(attributeCapturedDisplay(t.displays, t.displays[0], png(2560, 1440)).how, 'reattributed');
  assert.equal(attributeCapturedDisplay(t.displays, t.displays[0], png(3456, 2234)).how, 'confirmed');
});

test('identical panels: a PNG the chosen display could NOT have produced but two others could → ambiguous, chosen kept (never a guess)', () => {
  const t = normalizeTopology(RAW_STRING_TOPO);
  const odd = { ...t.displays[0], width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080 };
  const r = attributeCapturedDisplay([odd, t.displays[1], t.displays[2]], odd, png(4608, 2592));
  assert.equal(r.how, 'ambiguous');
  assert.equal(r.display.id, odd.id);
  assert.equal(r.candidates.length, 2);
});

test('no display owns the PNG size → unmatched (aspect reconciliation decides); no PNG → unchecked', () => {
  const t = normalizeTopology(RAW_STRING_TOPO);
  assert.equal(attributeCapturedDisplay(t.displays, t.displays[0], png(1234, 567)).how, 'unmatched');
  assert.equal(attributeCapturedDisplay(t.displays, t.displays[0], null).how, 'unchecked');
  assert.equal(attributeCapturedDisplay(t.displays, t.displays[0], png(0, 0)).how, 'unchecked');
});

test('kill switches: DIGBY_CAPTURE_PIXEL_CHECK=off / DIGBY_FRONT_WINDOW_PROBE=off', () => {
  assert.equal(pixelCheckEnabled(undefined), true);
  assert.equal(pixelCheckEnabled('off'), false);
  assert.equal(pixelCheckEnabled('0'), false);
  assert.equal(frontWindowProbeEnabled(''), true);
  assert.equal(frontWindowProbeEnabled('OFF'), false);
});

// ── (d3) v0.6.2 — remote-session kinds are separable (review non-blocking #3) ──

test('remote kinds: Screen Sharing is its own kind; any other "virtual display" is `virtual_display`', () => {
  assert.deepEqual(remoteKindsFromDisplayNames([{ name: 'Screen Sharing Virtual Display' }]), ['screen_sharing_virtual_display']);
  assert.deepEqual(remoteKindsFromDisplayNames([{ name: 'BetterDisplay Virtual Display' }, { name: 'DELL U2718Q' }]), ['virtual_display']);
  assert.deepEqual(remoteKindsFromDisplayNames([{ name: 'DELL U2718Q' }, {}]), []);
});

test('DIGBY_REMOTE_SESSION_IGNORE drops the named kinds (default: nothing dropped — the 0.6.1 behavior)', () => {
  assert.deepEqual([...remoteSessionIgnoreKinds(undefined)], []);
  assert.deepEqual([...remoteSessionIgnoreKinds(' virtual_display, TeamViewer_Desktop ')], ['virtual_display', 'teamviewer_desktop']);
  const kinds = ['virtual_display', 'teamviewer_desktop', 'screensharingd'];
  assert.deepEqual(applyRemoteSessionIgnore(kinds, remoteSessionIgnoreKinds(undefined)), kinds);
  assert.deepEqual(applyRemoteSessionIgnore(kinds, remoteSessionIgnoreKinds('virtual_display,teamviewer_desktop')), ['screensharingd']);
  assert.deepEqual(applyRemoteSessionIgnore(kinds, remoteSessionIgnoreKinds('all')), []);
});

// ── (e) structural pins on the shipped source ────────────────────────────────

const src = readFileSync(join(pkgRoot, 'src', 'computer.ts'), 'utf8');

test('structural pin: the JXA displays action returns bounds, NUMERIC backing pixels, pointer, HID idle — and NO System Events', () => {
  const block = src.split("if (action === 'displays')")[1].split("if (action === 'front_window')")[0];
  for (const needle of ['CGMainDisplayID', 'NSScreenNumber', 'CGDisplayBounds', 'CGDisplayCopyDisplayMode', 'Number($.CGDisplayModeGetPixelWidth', 'Number($.CGDisplayModeGetPixelHeight', 'CGDisplayPixelsWide', 'backingScaleFactor', 'localizedName', 'CGEventGetLocation', 'CGEventSourceSecondsSinceLastEventType']) {
    assert.ok(block.includes(needle), `displays action must use ${needle}`);
  }
  // v0.6.2: an Automation → System Events stall (120 s AppleEvent default)
  // must never take the display list down with it.
  assert.ok(!block.includes("Application('System Events')"), 'displays must not query System Events');
  assert.ok(!block.includes('frontmost: true'), 'displays must not query the frontmost process');
});

test('structural pin: the front_window action carries the System Events query (frame included) and runs in PARALLEL with a 5 s cap', () => {
  const block = src.split("if (action === 'front_window')")[1].split("if (action === 'preflight')")[0];
  for (const needle of ["Application('System Events')", 'frontmost: true', 'position()', 'size()']) {
    assert.ok(block.includes(needle), `front_window action must use ${needle}`);
  }
  const shot = src.split('export async function screenshot(')[1].split('// ── Input actions')[0];
  assert.match(shot, /runJxa\(JXA_RUNNER, \['front_window', '\{\}'\], 5000\)/, 'front_window is capped at 5 s');
  assert.match(shot, /runJxa\(JXA_RUNNER, \['displays', '\{\}'\], 10000\)/, 'displays keeps its 10 s cap');
  assert.ok(shot.indexOf("['front_window'") < shot.indexOf("['displays'"), 'the front_window probe is started BEFORE the displays read is awaited (parallel)');
  assert.match(shot, /normalizeTopology\(parsed\)/, 'the displays payload must be Number()-coerced');
  assert.match(shot, /attributeCapturedDisplay\(topo\.displays, chosen, pd\)/, 'the PNG size check goes through the pure attribution');
  assert.match(shot, /pixelCheckEnabled\(\)/, 'the pixel check has its kill switch');
});

test('structural pin: screencapture uses the CHOSEN display index, never a hardcoded -D 1', () => {
  const shot = src.split('export async function screenshot(')[1].split('// ── Input actions')[0];
  assert.match(shot, /screencapture', \['-D', String\(displayIndex\)/, 'capture must use the chosen index');
  assert.ok(!/\['-D', '1'/.test(shot), 'the hardcoded -D 1 must be gone');
  assert.match(shot, /chooseCaptureDisplay\(topo, mode\)/);
  assert.match(shot, /pngDimensions\(readFileSync\(png\)\)/, 'the captured PNG size must be verified against the display list');
});

test('structural pin: every screenshot result stamps the 0.6.1 fields', () => {
  const shot = src.split('export async function screenshot(')[1].split('// ── Input actions')[0];
  for (const field of ['displayId', 'displayIndex', 'displayCount', 'frontmostWindowDisplayId', 'pointerDisplayId', 'captureReason', 'hidIdleSeconds', 'hidIdleRawSeconds', 'remoteSession']) {
    assert.ok(shot.includes(`${field}:`), `screenshot result must carry ${field}`);
  }
});

test('structural pin: click / type / key / scroll mark their own HID events for the idle ledger', () => {
  for (const fn of ['export async function click(', 'export async function typeText(', 'export async function keyPress(', 'export async function scroll(']) {
    const body = src.split(fn)[1].split('export async function')[0];
    assert.match(body, /markOwnInput\(t0\)/, `${fn} must mark its own input`);
  }
  const open = src.split('export async function openApp(')[1].split('export async function')[0];
  assert.ok(!/markOwnInput/.test(open), 'open is not HID input and must not be marked');
});

test('structural pin: lastShot carries the captured display origin and toPoints goes through screenPointFor', () => {
  const shot = src.split('export async function screenshot(')[1].split('// ── Input actions')[0];
  assert.match(shot, /originX, originY, displayId: chosen\.id/);
  const toPoints = src.split('function toPoints(')[1].split('export async function click')[0];
  assert.match(toPoints, /screenPointFor\(x, y, lastShot\)/);
});
