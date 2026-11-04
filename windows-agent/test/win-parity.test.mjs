/**
 * W1 parity-core tests — the pure Windows-agent layers, verified on Linux CI
 * (no Windows box needed): the Rust-helper client's LAZY + INJECTABLE spawn
 * (the helper is never spawned at import, and never on a non-Windows
 * platform without an explicit helperPath — the retired W1 FFI contract,
 * translated), the virtual-screen DPI geometry math (mixed-DPI
 * multi-monitor + refuse cases), the browser port's pure helpers (profile
 * resolution, headless precedence, handler surface = the macOS contract),
 * and the W3 safety/refusal contract in dispatch.
 *
 * W3 (2026-09-25): the FFI-adapter pins were RETIRED-AND-REPLACED — the
 * INPUT-struct ABI pin now lives in the Rust helper crate
 * (rust-helper/src/input.rs cargo tests), the laziness pin is the helper
 * client's (test/win-rust-helper.test.mjs), and the koffi-dependency pin
 * became "koffi ABSENT" (below).
 *
 * Run: `npm test` in windows-agent/ (builds dist/ first — tests import the
 * BUILT module, i.e. exactly what ships). Plain .mjs, zero TypeScript
 * annotations, no "os" gate — the W0 learnings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const srcRoot = join(pkgRoot, 'src');

// ── The W3 migration contract (retire-and-replace of the FFI-era pins) ──────

test('rust-helper: the retired FFI adapter is GONE (src + dist + dependency)', () => {
  assert.ok(!existsSync(join(srcRoot, 'win32.ts')), 'src/win32.ts must not exist (W3 retired it)');
  assert.ok(!existsSync(join(pkgRoot, 'dist', 'win32.js')), 'dist/win32.js must not exist');
  // The seam implementation moved to rust-helper.ts + jpeg-encode.ts.
  assert.ok(existsSync(join(srcRoot, 'rust-helper.ts')), 'src/rust-helper.ts (the W3 seam client)');
  assert.ok(existsSync(join(srcRoot, 'jpeg-encode.ts')), 'src/jpeg-encode.ts (the moved pure encoder)');
  assert.ok(existsSync(join(srcRoot, 'safety.ts')), 'src/safety.ts (the W3 safety gate)');
});

test('package: the native-FFI dependency is ABSENT, jpeg-js stays, no "os" gate', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies?.koffi, undefined, 'koffi must NOT be a dependency (W3: the Rust helper replaces it)');
  assert.ok(pkg.dependencies?.['jpeg-js'], 'jpeg-js must be a runtime dependency (encoding stays in TS)');
  assert.ok(pkg.dependencies?.playwright, 'playwright stays (browser_* commands)');
  assert.equal(pkg.os, undefined, 'NO "os" field — Linux CI must install + test');
  assert.equal(pkg.version, '0.9.1', 'package version tracks AGENT_VERSION 0.9.1');
});

test('source: zero native-FFI references anywhere in src/ (the W3 net rule)', () => {
  const { readdirSync, statSync } = await0();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) {
        const src = readFileSync(p, 'utf8');
        assert.ok(!/koffi/.test(src), `src must not mention the retired FFI lib: ${p}`);
      }
    }
  };
  walk(srcRoot);
});

/** Synchronous fs walk shim (the .mjs suites cannot use require()). */
function await0() {
  // node:fs is synchronous-capable via its named exports; the import at the
  // top of this file only pulls readFileSync/existsSync, so fetch the rest
  // through the same module namespace lazily.
  return fs;
}

test('rust-helper: helper spawn is LAZY — importing the client spawns nothing', async () => {
  // Import the built client; no helper exists beside dist/ and no
  // DIGBY_WIN_HELPER is set, so NOTHING may spawn (the W1 laziness
  // contract, translated to the helper).
  const before = Object.keys(process._rawDebug ? {} : {});
  const mod = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  assert.equal(typeof mod.RustHelperClient, 'function');
  const client = new mod.RustHelperClient(); // no helperPath → resolves nothing
  assert.equal(client.running, false, 'no process until the first call');
  assert.equal(before, before);
  // The first computer-shaped call refuses with a CLEAR actionable error
  // (never a crash, never a silent no-op).
  await assert.rejects(
    () => client.call('monitor_size'),
    /digby-win-helper\.exe|helper/i,
    'the refusal must name the helper and the recovery',
  );
  // Browser commands never touch this client — verified structurally: the
  // browser module does not import rust-helper.
  const browserSrc = readFileSync(join(srcRoot, 'browser.ts'), 'utf8');
  assert.ok(!/rust-helper/.test(browserSrc), 'browser.ts must not depend on the helper client');
});

// ── SendInput serialization — moved to the Rust helper (cargo tests) ─────────

test('input ABI: the 40-byte INPUT layout pin lives in the Rust helper crate', () => {
  // The parent steer (2026-09-25): the koffi-era InputBuilder pin MOVED to
  // the helper — the Rust SendInput path now owns that ABI. Here we pin the
  // PRESENCE of the pin (pure cargo tests run on Linux CI via the workflow's
  // rust job; this suite runs without cargo, so the source-level check
  // guards drift until then).
  const inputRs = readFileSync(join(pkgRoot, 'rust-helper', 'src', 'input.rs'), 'utf8');
  assert.ok(inputRs.includes('INPUT_SIZE: usize = 40'), 'the 40-byte x64 INPUT stride is pinned in input.rs');
  assert.ok(/fn wheel_down_encodes_two_complement_never_throws/.test(inputRs), 'the W1 B1 two\'s-complement wheel pin is ported');
  assert.ok(/fn unicode_events_carry_one_utf16_unit_each/.test(inputRs), 'the W1 surrogate-pair pin is ported');
});

// ── JPEG encoding (moved to jpeg-encode.ts — BGRA edition) ───────────────────

test('jpeg encode — BGRA→RGB channel swap, long-edge cap, box downscale', async () => {
  const { encodeJpegFromBgra } = await import(join(pkgRoot, 'dist', 'jpeg-encode.js'));
  // Build a 4x2 BGRA image: red, green, blue, white row + black row.
  const w = 4, h = 2;
  const px = Buffer.alloc(w * h * 4);
  const put = (x, b, g, r) => { const o = (0 * w + x) * 4; px[o] = b; px[o + 1] = g; px[o + 2] = r; px[o + 3] = 0xff; };
  put(0, 0x00, 0x00, 0xff); // red
  put(1, 0x00, 0xff, 0x00); // green
  put(2, 0xff, 0x00, 0x00); // blue
  put(3, 0xff, 0xff, 0xff); // white
  // Row 1 all black (zeros already)
  const out = encodeJpegFromBgra(px, w, h, 1568, 75);
  assert.equal(out.width, 4); // no upscale
  assert.equal(out.height, 2);
  assert.ok(out.base64.length > 100, 'jpeg bytes exist');
  const decoded = Buffer.from(out.base64, 'base64');
  assert.equal(decoded[0], 0xff); // JPEG SOI marker
  assert.equal(decoded[1], 0xd8);
  // Downscale path: a 3200x1600 image caps at 1568 long edge.
  const big = Buffer.alloc(3200 * 1600 * 4);
  const out2 = encodeJpegFromBgra(big, 3200, 1600, 1568, 75);
  assert.equal(out2.width, 1568);
  assert.equal(out2.height, Math.round(1600 * (1568 / 3200)));
});

// ── Virtual-screen DPI geometry (mixed-DPI multi-monitor) ────────────────────

test('geometry: imageToScreen maps into virtual-screen space when vx/vy present', async () => {
  const { imageToScreen } = await import(join(pkgRoot, 'dist', 'win-platform.js'));
  // Two monitors: primary 2560x1600 at (0,0) 100% + secondary 1920x1080 at
  // (-1920, 0) 100%. Virtual screen: origin (-1920, 0), size 4480x1600.
  const g = { imageWidth: 2240, imageHeight: 800, screenWidth: 4480, screenHeight: 1600, vx: -1920, vy: 0 };
  // Center of the whole desktop → center of the virtual screen.
  const c = imageToScreen(1120, 400, g);
  assert.ok('x' in c, JSON.stringify(c));
  assert.equal(c.x, -1920 + 2240); // 320
  assert.equal(c.y, 800);
  // Top-left corner of the image → virtual origin.
  const tl = imageToScreen(0, 0, g);
  assert.equal(tl.x, -1920);
  assert.equal(tl.y, 0);
});

test('geometry: mixed-DPI monitors — DPI never changes the linear mapping', async () => {
  const { imageToScreen, monitorAt, validateGeometry } = await import(join(pkgRoot, 'dist', 'win-platform.js'));
  // Primary 3840x2160 at 200% DPI (192) + secondary 1920x1080 at 100% (96),
  // side by side. Windows reports PHYSICAL pixels (SetProcessDPIAware): the
  // virtual screen spans 5760x2160 at origin (0,0).
  const geo = {
    x: 0, y: 0, width: 5760, height: 2160,
    monitors: [
      { x: 0, y: 0, width: 3840, height: 2160, dpi: 192 },
      { x: 3840, y: 0, width: 1920, height: 1080, dpi: 96 },
    ],
  };
  const v = validateGeometry(geo);
  assert.ok(!('error' in v), JSON.stringify(v));
  // Image 2880x1080 (half-scale of the virtual screen).
  const g = { imageWidth: 2880, imageHeight: 1080, screenWidth: 5760, screenHeight: 2160, vx: 0, vy: 0 };
  // A click at image (1920, 540) = the boundary between the monitors →
  // physical (3840, 1080).
  const r = imageToScreen(1920, 540, g);
  assert.ok('x' in r);
  assert.equal(r.x, 3840);
  assert.equal(r.y, 1080);
  // monitorAt classifies which monitor a physical point falls on.
  assert.equal(monitorAt(geo, 100, 100).dpi, 192, 'left half = the 200% monitor');
  assert.equal(monitorAt(geo, 5000, 100).dpi, 96, 'right half = the 100% monitor');
  assert.equal(monitorAt(geo, 3839, 2159)?.dpi, 192);
  // The point BETWEEN monitors vertically (below the shorter secondary's
  // bottom edge but inside the bounding box) → null (a gap).
  assert.equal(monitorAt(geo, 5000, 2000), null, 'below the 1080p secondary is a gap');
});

test('geometry: refuse cases — drift, out-of-bounds, degenerate', async () => {
  const { imageToScreen, validateGeometry } = await import(join(pkgRoot, 'dist', 'win-platform.js'));
  // Aspect drift beyond 2% (GDI virtualization suspected) → refuse.
  const bad = imageToScreen(100, 100, { imageWidth: 1920, imageHeight: 1080, screenWidth: 2560, screenHeight: 1600 });
  assert.ok('error' in bad);
  assert.match(bad.error, /geometry mismatch/);
  assert.match(bad.error, /refusing/);
  // Missing geometry entirely.
  const none = imageToScreen(10, 10, { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 });
  assert.ok('error' in none);
  assert.match(none.error, /no screenshot/);
  // Coordinates outside the image.
  const outside = imageToScreen(2000, 500, { imageWidth: 1920, imageHeight: 1080, screenWidth: 1920, screenHeight: 1080 });
  assert.ok('error' in outside);
  // Degenerate virtual-screen snapshots refuse in validateGeometry.
  assert.ok('error' in validateGeometry(null));
  assert.ok('error' in validateGeometry({ x: 0, y: 0, width: 0, height: 0, monitors: [] }));
  assert.ok('error' in validateGeometry({ x: 0, y: 0, width: 100, height: 100, monitors: [{ x: 0, y: 0, width: 0, height: 100, dpi: 96 }] }));
  assert.ok('error' in validateGeometry({ x: 0, y: 0, width: 100, height: 100, monitors: [{ x: 0, y: 0, width: 100, height: 100, dpi: 5000 }] }), 'absurd DPI refuses');
});

// ── Elevation contract in dispatch (the UIPI wall) ───────────────────────��───

test('dispatch: the W3 safety gate blocks input actions with the frozen refusal code', async () => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const { SafetyGate } = await import(join(pkgRoot, 'dist', 'safety.js'));
  const calls = [];
  let cursor = { x: 0, y: 0 };
  const deps = {
    surface: {
      async monitorSize() { return { width: 2560, height: 1600 }; },
      async captureJpeg() { return { base64: 'aGk=', width: 1568, height: 980 }; },
      async frontmost() { return { app: 'a.exe', window: 'A' }; },
    },
    input: {
      async cursorPos() { return { ...cursor }; },
      async moveTo(x, y) { calls.push(['moveTo', x, y]); cursor = { x, y }; },
      async mouseDown() { calls.push(['down']); },
      async mouseUp() { calls.push(['up']); },
      async scroll() { calls.push(['scroll']); },
      async keyDown(s) { calls.push(['keyDown', s.vk]); },
      async keyUp(s) { calls.push(['keyUp', s.vk]); },
      async unicodeChar() { calls.push(['unicode']); },
      async clearModifiers() { calls.push(['clear']); },
      async open() { calls.push(['open']); },
    },
    // The W3 safety gate over a scripted environment probe: the foreground
    // window's process is ELEVATED (the W1 foregroundElevated preflight,
    // now the UIA_E_ELEVATED frozen refusal code).
    safety: new SafetyGate({
      environment: async () => ({
        secure_desktop: false,
        elevated_foreground: true,
        foreground_exe: 'adminapp.exe',
        foreground_title: 'Admin App',
        foreground_rect: { x: 0, y: 0, w: 800, h: 600 },
        foreground_pid: 1234,
      }),
    }),
  };
  const GEO = { imageWidth: 1568, imageHeight: 980, screenWidth: 2560, screenHeight: 1600 };
  for (const [method, params] of [
    ['computer_click', { x: 784, y: 490 }],
    ['computer_type', { text: 'hi' }],
    ['computer_key', { key: 'return' }],
    ['computer_scroll', { direction: 'down', amount: 3 }],
  ]) {
    calls.length = 0;
    const obs = await executeComputer(method, params, deps, { ...GEO });
    assert.equal(obs.ok, false, `${method} must refuse when elevated`);
    assert.match(obs.error, /UIA_E_ELEVATED/, `${method} error carries the frozen code: ${obs.error}`);
    assert.match(obs.error, /UIPI/, `${method} error names the mechanism`);
    assert.equal(calls.length, 0, `${method} injects NOTHING when elevated`);
  }
  // open() is NOT input injection (ShellExecute spawns/activates) — allowed.
  const open = await executeComputer('computer_open', { target: 'https://digby.example.com' }, deps, { ...GEO });
  assert.equal(open.ok, true);
  assert.deepEqual(calls, [['open']]);
  // With no gate wired (older surface), actions proceed.
  const ok = await executeComputer('computer_click', { x: 784, y: 490 }, { surface: deps.surface, input: deps.input }, { ...GEO });
  assert.equal(ok.ok, true);
});

// ── Browser port: pure helpers ───────────────────────────────────────────────

test('browser: profile dir resolves to %LOCALAPPDATA%\\Digby\\browser-profile', async () => {
  const { resolveProfileDir } = await import(join(pkgRoot, 'dist', 'browser.js'));
  const sep = await (async () => (process.platform === 'win32' ? '\\' : '/'))();
  // LOCALAPPDATA set (as on Windows) → the canonical path.
  const win = resolveProfileDir({ LOCALAPPDATA: 'C:\\Users\\paul\\AppData\\Local' });
  assert.ok(win.includes('Digby'), win);
  assert.ok(win.endsWith(join('Digby', 'browser-profile')), win);
  // Env override wins.
  assert.equal(resolveProfileDir({ DIGBY_BROWSER_PROFILE: 'D:\\digby-profile' }), 'D:\\digby-profile');
  // Neither set + non-win32 platform → the ~/.config fallback (dev boxes).
  const fallback = resolveProfileDir({});
  assert.ok(fallback.includes(join('.config', 'digby-agent', 'browser-profile')), fallback);
  assert.equal(sep, process.platform === 'win32' ? '\\' : '/');
});

test('browser: headless precedence — HEADLESS env beats HEADED beats default-on', async () => {
  const { defaultHeadless } = await import(join(pkgRoot, 'dist', 'browser.js'));
  assert.equal(defaultHeadless({}), true, 'default is headless');
  assert.equal(defaultHeadless({ DIGBY_BROWSER_HEADED: '1' }), false);
  assert.equal(defaultHeadless({ DIGBY_BROWSER_HEADED: 'true' }), false);
  assert.equal(defaultHeadless({ DIGBY_BROWSER_HEADLESS: '1' }), true);
  // HEADLESS wins over HEADED (the macOS precedence).
  assert.equal(defaultHeadless({ DIGBY_BROWSER_HEADLESS: '1', DIGBY_BROWSER_HEADED: '1' }), true);
  assert.equal(defaultHeadless({ DIGBY_BROWSER_HEADLESS: '0', DIGBY_BROWSER_HEADED: '0' }), true, 'unrecognized values fall back to the default');
});

test('browser: handler surface = the macOS contract (method names + param keys)', async () => {
  const { browserHandlers } = await import(join(pkgRoot, 'dist', 'browser.js'));
  const handlers = browserHandlers();
  // Every method the macOS agent's execute() switch dispatches exists here,
  // with the same backend-visible name.
  for (const m of [
    'browser_navigate', 'browser_get_content', 'browser_extract', 'browser_click',
    'browser_type', 'browser_scroll', 'browser_screenshot', 'browser_pop_out',
    'browser_close',
  ]) {
    assert.equal(typeof handlers[m], 'function', `missing ${m}`);
  }
  // browser_get_url ships as a bonus (the macOS agent exports getUrl but the
  // backend never dispatched it — kept for parity of the module surface).
  assert.equal(typeof handlers.browser_get_url, 'function');
  // An unknown browser_* method still refuses through commands.ts.
  assert.equal(typeof handlers.browser_nonexistent, 'undefined');
});

test('browser: navigate requires a url — param validation matches the macOS agent', async () => {
  const { navigate } = await import(join(pkgRoot, 'dist', 'browser.js'));
  const r = await navigate('');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'navigate requires a url');
});

// ── Advertisement (0.8.0 clears every gate) ─────────────────────────────────

test('advertisement: AGENT_VERSION 0.9.1 (the 4424ebd6 helper-locator fix), capabilities unchanged', async () => {
  const { AGENT_VERSION, PLATFORM, CAPABILITIES } = await import(join(pkgRoot, 'dist', 'advertisement.js'));
  assert.equal(AGENT_VERSION, '0.9.1');
  assert.equal(PLATFORM, 'windows');
  assert.deepEqual([...CAPABILITIES], ['browser', 'computer']);
  // 0.9.1 > every backend gate (0.5.0 highest) + the W3 UIA gate (0.9.0):
  // Macs (0.5.0) can never claim uia commands; this agent claims everything.
  const [maj, min] = AGENT_VERSION.split('.').map(Number);
  assert.ok(maj > 0 || min >= 9, 'must clear the 0.9.0 UIA gate');
});

// ── Source-level contract pins (the macOS byte-compatibility promise) ────────

test('contract: computer_* dispatch reads the macOS param names', async () => {
  const src = readFileSync(join(srcRoot, 'commands.ts'), 'utf8');
  for (const param of ['params.x', 'params.y', 'params.button', 'params.clicks', 'params.text', 'params.key', 'params.modifiers', 'params.direction', 'params.amount', 'params.target']) {
    assert.ok(src.includes(param), `commands.ts must read ${param} (the macOS contract)`);
  }
  const browserSrc = readFileSync(join(srcRoot, 'browser.ts'), 'utf8');
  for (const param of ['p?.url', 'p?.format', 'p?.selector', 'p?.text', 'p?.submit', 'p?.direction', 'p?.amount', 'p?.quality', 'p?.attach']) {
    assert.ok(browserSrc.includes(param), `browser.ts must read ${param} (the macOS contract)`);
  }
});

test('contract: dist/ entry files exist after build', () => {
  for (const f of ['rust-helper.js', 'safety.js', 'jpeg-encode.js', 'browser.js', 'commands.js', 'win-platform.js', 'advertisement.js', 'index.js', 'api.js', 'config.js']) {
    assert.ok(existsSync(join(pkgRoot, 'dist', f)), `dist/${f} must exist (npm test builds first)`);
  }
  // W3: the retired FFI adapter is GONE — the Rust helper owns Win32 now.
  assert.ok(!existsSync(join(pkgRoot, 'dist', 'win32.js')), 'dist/win32.js must not exist (retired in W3)');
});
