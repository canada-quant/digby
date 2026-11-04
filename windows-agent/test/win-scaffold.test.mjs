/**
 * W0 scaffold tests — the pure Windows-agent layers, verified on Linux CI
 * (no Windows box needed): the platform/capability advertisement, the VK +
 * scan-code map, the typing planner, geometry reconciliation, and command
 * dispatch (verify-or-refuse click, modifier clearing, structured refusals).
 *
 * Run: `npm test` in windows-agent/ (builds dist/ first — tests import the
 * BUILT module, i.e. exactly what ships).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const { AGENT_VERSION, PLATFORM, CAPABILITIES, pairAdvertisement, pollAdvertisementQuery } =
  await import(join(pkgRoot, 'dist', 'advertisement.js'));
const {
  resolveKey, resolveModifier, typeStepsFor, keySpecFor, imageToScreen, NAMED_KEYS,
} = await import(join(pkgRoot, 'dist', 'win-platform.js'));
const { executeComputer, executeCommand } = await import(join(pkgRoot, 'dist', 'commands.js'));

// ── Advertisement (the W0 backend handshake) ────────────────────────────────

test('advertisement: windows platform, browser+computer capabilities, never imessage', () => {
  assert.equal(PLATFORM, 'windows');
  assert.deepEqual([...CAPABILITIES].sort(), ['browser', 'computer']);
  const advert = pairAdvertisement();
  assert.equal(advert.platform, 'windows');
  assert.deepEqual(advert.capabilities, ['browser', 'computer']);
});

test('advertisement: version 0.6.0 clears every backend dispatch gate', () => {
  // The broker's minAgentVersion gates: browser 0.2.0, computer 0.3.0,
  // computer-claim 0.3.2, pop-out 0.4.0, attach 0.5.0. 0.6.0 > all.
  const [maj, min] = AGENT_VERSION.split('.').map(Number);
  assert.ok(maj > 0 || min >= 5, `AGENT_VERSION ${AGENT_VERSION} must be ≥ 0.5.0`);
});

test('advertisement: poll query carries version+platform+capabilities', () => {
  const q = pollAdvertisementQuery();
  assert.ok(q.includes(`version=${AGENT_VERSION}`), q);
  assert.ok(q.includes('platform=windows'), q);
  assert.ok(q.includes('capabilities=browser,computer'), q);
});

// ── Keymap: VK + Set-1 scan codes ───────────────────────────────────────────

test('keymap: every printable US-ASCII char maps to a real VK + scan code (never vk 0)', () => {
  for (let i = 32; i <= 126; i++) {
    const ch = String.fromCharCode(i);
    const spec = keySpecFor(ch);
    assert.ok(spec, `no spec for ${JSON.stringify(ch)}`);
    assert.ok(spec.vk > 0, `vk must be nonzero for ${JSON.stringify(ch)}`);
    assert.ok(spec.scan > 0, `scan must be nonzero for ${JSON.stringify(ch)}`);
  }
});

test('keymap: shifted pairs share the physical key with their unshifted base', () => {
  for (const [shifted, base] of [['!', '1'], ['@', '2'], ['_', '-'], ['?', '/'], ['~', '`']]) {
    const s = keySpecFor(shifted);
    const b = keySpecFor(base);
    assert.ok(s && b, `missing ${shifted}/${base}`);
    assert.equal(s.scan, b.scan, `${shifted} must share the physical key with ${base}`);
    assert.equal(s.shift, true, `${shifted} needs shift`);
    assert.equal(b.shift, false, `${base} must not need shift`);
  }
});

test('keymap: uppercase letters are shifted lowercase', () => {
  for (const [lower, upper] of [['a', 'A'], ['z', 'Z'], ['m', 'M']]) {
    assert.equal(keySpecFor(upper).scan, keySpecFor(lower).scan);
    assert.equal(keySpecFor(upper).shift, true);
    assert.equal(keySpecFor(lower).shift, false);
  }
});

test('keymap: named keys + modifiers resolve (win, return, arrows extended)', () => {
  const ret = resolveKey('return');
  assert.equal(ret.vk, 0x0D);
  const win = resolveKey('win');
  assert.equal(win.vk, 0x5B);
  assert.equal(win.extended, true, 'win key is an extended key');
  for (const k of ['left', 'right', 'up', 'down', 'home', 'end', 'pageup', 'pagedown', 'delete']) {
    assert.ok(resolveKey(k), `missing named key ${k}`);
    assert.equal(resolveKey(k).extended, true, `${k} must be extended`);
  }
  // macOS aliases resolve to Windows analogues (a task text may slip through).
  assert.equal(resolveKey('cmd').vk, 0x5B);
  assert.equal(resolveModifier('option').vk, 0x12);
  assert.equal(resolveModifier('meta').vk, 0x5B);
  for (const m of ['ctrl', 'alt', 'shift', 'win']) assert.ok(resolveModifier(m), `missing modifier ${m}`);
  // Single-char keys resolve through the char table.
  assert.equal(resolveKey('c').vk, 0x43);
  // Unknown keys refuse.
  assert.equal(resolveKey('nonexistent'), undefined);
});

// ── Typing planner (the SendInput contract) ─────────────────────────────────

test('typing: every printable US-ASCII string plans to REAL key steps with zero fallback', () => {
  for (const s of ['app.swapcard.com', 'Hello, World!', 'C:\\Users\\Paul\\Desktop', 'a=b+c{d}[e]|f:g"h<i>j.k?l/m~n@o#p']) {
    const steps = typeStepsFor(s);
    assert.equal(steps.length, [...s].length, `step count mismatch for ${JSON.stringify(s)}`);
    for (const step of steps) {
      assert.equal(step.k, 'key', `char in ${JSON.stringify(s)} must plan a real key, not fallback`);
      assert.ok(step.spec.scan > 0);
    }
  }
});

test('typing: non-ASCII rides the unicode fallback as ONE intact code point', () => {
  const steps = typeStepsFor('héllo 😀');
  const unicode = steps.filter((s) => s.k === 'unicode');
  assert.equal(unicode.length, 2, 'é and 😀 each ride one unicode step');
  assert.equal(unicode[0].ch, 'é');
  assert.equal(unicode[1].ch, '😀'); // astral-plane: never split into surrogates
});

// ── Geometry reconciliation (the 4e4d56ff contract, DPI edition) ────────────

test('geometry: matching aspect maps image px → screen px', () => {
  const g = { imageWidth: 1568, imageHeight: 980, screenWidth: 2560, screenHeight: 1600 };
  const r = imageToScreen(784, 490, g);
  assert.ok('x' in r, `expected mapped coords, got ${JSON.stringify(r)}`);
  assert.equal(r.x, 1280);
  assert.equal(r.y, 800);
});

test('geometry: aspect mismatch (per-monitor DPI trap) REFUSES', () => {
  // 2560x1600 monitor (16:10) vs a 16:9 screenshot — the wrong-scale click trap.
  const g = { imageWidth: 1920, imageHeight: 1080, screenWidth: 2560, screenHeight: 1600 };
  const r = imageToScreen(960, 540, g);
  assert.ok('error' in r, 'mismatch must refuse');
  assert.match(r.error, /geometry mismatch/);
  assert.match(r.error, /DPI/);
});

test('geometry: out-of-monitor coords refuse; zero dims refuse', () => {
  const g = { imageWidth: 1000, imageHeight: 1000, screenWidth: 2000, screenHeight: 2000 };
  assert.ok('error' in imageToScreen(1500, 500, g));
  assert.ok('error' in imageToScreen(10, 10, { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 }));
});

// ── Command dispatch (pure orchestration over the seam) ─────────────────────

/** A scripted seam: records every call, lets the test drive responses. */
function scriptedSurface(over = {}) {
  const calls = [];
  return {
    calls,
    surface: {
      async monitorSize() { calls.push('monitorSize'); return { width: 2560, height: 1600 }; },
      async captureJpeg() { calls.push('captureJpeg'); return { base64: 'aGVsbG8=', width: 1568, height: 980 }; },
      async frontmost() { calls.push('frontmost'); return { app: 'chrome.exe', window: 'Google Chrome' }; },
      ...over,
    },
  };
}

function scriptedInput(over = {}) {
  const calls = [];
  let cursor = { x: 0, y: 0 };
  return {
    calls,
    input: {
      async cursorPos() { calls.push({ op: 'cursorPos' }); return { ...cursor }; },
      async moveTo(x, y) { calls.push({ op: 'moveTo', arg: [x, y] }); cursor = { x, y }; },
      async mouseDown(b) { calls.push({ op: 'mouseDown', arg: b }); },
      async mouseUp(b) { calls.push({ op: 'mouseUp', arg: b }); },
      async scroll(n) { calls.push({ op: 'scroll', arg: n }); },
      async keyDown(spec) { calls.push({ op: 'keyDown', arg: spec }); },
      async keyUp(spec) { calls.push({ op: 'keyUp', arg: spec }); },
      async unicodeChar(ch) { calls.push({ op: 'unicodeChar', arg: ch }); },
      async clearModifiers() { calls.push({ op: 'clearModifiers' }); },
      async open(t) { calls.push({ op: 'open', arg: t }); },
      ...over,
    },
  };
}

const GEO = { imageWidth: 1568, imageHeight: 980, screenWidth: 2560, screenHeight: 1600 };

test('dispatch: computer_ping works even on the null seam', async () => {
  const deps = { surface: new (await import(join(pkgRoot, 'dist', 'win-platform.js'))).NullWin32Surface(), input: new (await import(join(pkgRoot, 'dist', 'win-platform.js'))).NullWin32Input() };
  const obs = await executeComputer('computer_ping', {}, deps, { ...GEO });
  assert.equal(obs.ok, true);
});

test('dispatch: click plans modifier-clear → verified move → down/up in IMAGE space', async () => {
  const s = scriptedSurface();
  const i = scriptedInput();
  const deps = { surface: s.surface, input: i.input };
  const obs = await executeComputer('computer_click', { x: 784, y: 490 }, deps, { ...GEO });
  assert.equal(obs.ok, true, obs.error);
  const ops = i.calls.map((c) => c.op);
  assert.equal(ops[0], 'clearModifiers', 'modifier pre-sweep runs first');
  assert.ok(ops.includes('moveTo'));
  assert.ok(ops.includes('cursorPos'), 'verify-or-refuse read-back');
  assert.ok(ops.includes('mouseDown'));
  assert.ok(ops.includes('mouseUp'));
  // Image (784,490) on 1568x980 → screen (1280,800) on 2560x1600.
  const moveTo = i.calls.find((c) => c.op === 'moveTo');
  assert.deepEqual(moveTo.arg, [1280, 800]);
});

test('dispatch: verify-or-refuse — cursor never arrives → click REFUSES, never blind', async () => {
  const s = scriptedSurface();
  const i = scriptedInput({
    cursorPos: async () => ({ x: 999, y: 999 }), // read-back never matches
  });
  const deps = { surface: s.surface, input: i.input };
  const obs = await executeComputer('computer_click', { x: 784, y: 490 }, deps, { ...GEO });
  assert.equal(obs.ok, false);
  assert.match(obs.error, /refusing to click blind/);
  assert.ok(!i.calls.some((c) => c.op === 'mouseDown'), 'no click when verify fails');
});

test('dispatch: geometry mismatch → click refuses before any input', async () => {
  const s = scriptedSurface();
  const i = scriptedInput();
  const obs = await executeComputer(
    'computer_click', { x: 100, y: 100 },
    { surface: s.surface, input: i.input },
    { imageWidth: 1920, imageHeight: 1080, screenWidth: 2560, screenHeight: 1600 },
  );
  assert.equal(obs.ok, false);
  assert.match(obs.error, /geometry mismatch/);
  assert.equal(i.calls.length, 0, 'no input at all on geometry mismatch');
});

test('dispatch: type plans real keys via the planner; unicode fallback intact', async () => {
  const s = scriptedSurface();
  const i = scriptedInput();
  const obs = await executeComputer('computer_type', { text: 'Hi!' }, { surface: s.surface, input: i.input }, { ...GEO });
  assert.equal(obs.ok, true, obs.error);
  const keyDowns = i.calls.filter((c) => c.op === 'keyDown').map((c) => c.arg.vk);
  // H(shift+h) i !(shift+1)
  assert.deepEqual(keyDowns, [0x48, 0x49, 0x31]);
  assert.equal(i.calls[0].op, 'clearModifiers');
});

test('dispatch: key with modifiers — ctrl then key, release in reverse', async () => {
  const s = scriptedSurface();
  const i = scriptedInput();
  const obs = await executeComputer(
    'computer_key', { key: 'c', modifiers: ['ctrl'] },
    { surface: s.surface, input: i.input }, { ...GEO },
  );
  assert.equal(obs.ok, true, obs.error);
  const ops = i.calls.map((c) => c.op);
  assert.deepEqual(ops.filter((o) => o !== 'cursorPos' && o !== 'clearModifiers' || o === 'clearModifiers'), ['clearModifiers', 'keyDown', 'keyDown', 'keyUp', 'keyUp']);
  const downs = i.calls.filter((c) => c.op === 'keyDown').map((c) => c.arg.vk);
  assert.deepEqual(downs, [0x11, 0x43]); // ctrl first, then c
  const ups = i.calls.filter((c) => c.op === 'keyUp').map((c) => c.arg.vk);
  assert.deepEqual(ups, [0x43, 0x11]); // key up first, modifier released last
});

test('dispatch: unknown key / modifier refuses with a structured error', async () => {
  const s = scriptedSurface();
  const i = scriptedInput();
  const bad1 = await executeComputer('computer_key', { key: 'hyper' }, { surface: s.surface, input: i.input }, { ...GEO });
  assert.equal(bad1.ok, false);
  assert.match(bad1.error, /unknown key: hyper/);
  const bad2 = await executeComputer('computer_key', { key: 'c', modifiers: ['banana'] }, { surface: s.surface, input: i.input }, { ...GEO });
  assert.equal(bad2.ok, false);
  assert.match(bad2.error, /unknown modifier: banana/);
});

test('dispatch: scroll with verified target; unknown action refuses', async () => {
  const s = scriptedSurface();
  const i = scriptedInput();
  const obs = await executeComputer('computer_scroll', { direction: 'down', amount: 3, x: 784, y: 490 }, { surface: s.surface, input: i.input }, { ...GEO });
  assert.equal(obs.ok, true, obs.error);
  assert.ok(i.calls.some((c) => c.op === 'moveTo'));
  assert.deepEqual(i.calls.find((c) => c.op === 'scroll').arg, -3);
  const bad = await executeComputer('computer_teleport', {}, { surface: s.surface, input: i.input }, { ...GEO });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unknown computer action/);
});

test('dispatch: screenshot updates the geometry cache + reports frontmost', async () => {
  const s = scriptedSurface();
  const i = scriptedInput();
  const geometry = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  const obs = await executeComputer('computer_screenshot', {}, { surface: s.surface, input: i.input }, geometry);
  assert.equal(obs.ok, true, obs.error);
  assert.equal(obs.screenshotBase64, 'aGVsbG8=');
  assert.equal(obs.frontmostApp, 'chrome.exe');
  assert.equal(geometry.imageWidth, 1568);
  assert.equal(geometry.screenWidth, 2560);
});

test('dispatch: the null seam refuses computer_* with a clear error (never a crash)', async () => {
  const { NullWin32Surface, NullWin32Input } = await import(join(pkgRoot, 'dist', 'win-platform.js'));
  const deps = { surface: new NullWin32Surface(), input: new NullWin32Input() };
  for (const method of ['computer_screenshot', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll', 'computer_open']) {
    const params = method === 'computer_type' ? { text: 'x' } : method === 'computer_key' ? { key: 'return' } : method === 'computer_open' ? { target: 'https://digby.example.com' } : { x: 10, y: 10 };
    const out = await executeCommand(method, params, deps, { ...GEO });
    assert.equal(out.ok, false, `${method} must refuse on the null seam`);
    assert.match(out.error, /Rust helper layer is not loaded/, `${method} error must name the cause: ${out.error}`);
  }
});

test('dispatch: browser_* routes to handlers when present; unknown methods refuse', async () => {
  const { NullWin32Surface, NullWin32Input } = await import(join(pkgRoot, 'dist', 'win-platform.js'));
  // No browser handlers wired (the null-seam agent) → browser_* refuses cleanly.
  const deps = { surface: new NullWin32Surface(), input: new NullWin32Input() };
  const b = await executeCommand('browser_navigate', { url: 'https://digby.example.com' }, deps, { ...GEO });
  assert.equal(b.ok, false);
  assert.match(b.error, /browser command not yet available/);
  // iMessage methods are the macOS agent's surface — never ours.
  const im = await executeCommand('list_chats', {}, deps, { ...GEO });
  assert.equal(im.ok, false);
  assert.match(im.error, /unknown method/);
});
