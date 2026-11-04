/**
 * W3 Rust-helper tests — the client/protocol/safety surface, verified on
 * Linux CI by spawning the FAKE helper (test/fixtures/fake-helper.mjs)
 * through the exact code path the real digby-win-helper.exe takes
 * (helperPath injection). This suite closes the W3 gap: the whole seam —
 * framing, id-echo, serialization, timeout, refusal-code relay, the safety
 * preflights, and the UIA perception actions — is pinned WITHOUT a Windows
 * box.
 *
 * Run: `npm test` in windows-agent/ (builds dist/ first). Plain .mjs, zero
 * TypeScript annotations, no "os" gate — the W0 learnings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const FAKE = join(pkgRoot, 'test-fixtures', 'fake-helper.mjs');

/** Spawn a client against the fake helper in a given mode. */
async function fakeClient(mod, t) {
  const { RustHelperClient } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  const client = new RustHelperClient({ helperPath: process.execPath, args: [FAKE] });
  // DIGBY_FAKE_HELPER_MODE is read by the fixture AT STARTUP — set it before
  // the first call spawns the process, clear it after.
  process.env.DIGBY_FAKE_HELPER_MODE = mod;
  t.after(async () => {
    delete process.env.DIGBY_FAKE_HELPER_MODE;
    await client.dispose();
  });
  return client;
}

// ── Protocol round-trip (the frozen envelope) ───────────────────────────────

test('helper protocol: round-trip ping + every seam method through the fake helper', async (t) => {
  const client = await fakeClient('ok', t);
  const pong = await client.call('ping');
  assert.equal(pong.version, '0.9.1');

  // Surface seam methods.
  const size = await client.call('monitor_size');
  assert.deepEqual(size, { width: 2560, height: 1600 });
  const geo = await client.call('geometry');
  assert.equal(geo.width, 2560);
  assert.deepEqual(geo.monitors, [{ x: 0, y: 0, width: 2560, height: 1600, dpi: 144 }]);
  const pos = await client.call('cursor_pos');
  assert.deepEqual(pos, { x: 1280, y: 800 });
  const front = await client.call('frontmost');
  assert.equal(front.app, 'Notepad.exe');

  // Input seam methods (ok:true + the id echo is implicit — a mismatched id
  // would never resolve the promise).
  for (const [method, params] of [
    ['move_to', { x: 10, y: 20 }],
    ['mouse_down', { button: 'left' }],
    ['mouse_up', { button: 'right' }],
    ['scroll', { amount: -3 }],
    ['key_down', { vk: 0x41, scan: 0x1e, extended: false, shift: true }],
    ['key_up', { vk: 0x41, scan: 0x1e, extended: false, shift: true }],
    ['unicode_char', { ch: 'é' }],
    ['clear_modifiers', {}],
    ['open', { target: 'https://digby.example.com' }],
  ]) {
    await client.call(method, params);
  }
});

test('helper protocol: requests are SERIALIZED and responses match their ids', async (t) => {
  const client = await fakeClient('ok', t);
  const one = client.call('ping');
  const two = client.call('monitor_size');
  const three = client.call('cursor_pos');
  const [a, b, c] = await Promise.all([one, two, three]);
  assert.equal(a.version, '0.9.1');
  assert.deepEqual(b, { width: 2560, height: 1600 });
  assert.deepEqual(c, { x: 1280, y: 800 });
});

test('helper protocol: garbage lines are skipped, the real answer still lands', async (t) => {
  const client = await fakeClient('garbage', t);
  const pong = await client.call('ping');
  assert.equal(pong.version, '0.9.1');
});

test('helper protocol: a helper that DIES rejects pending calls (never hangs)', async (t) => {
  const client = await fakeClient('die', t);
  await assert.rejects(
    () => client.call('ping'),
    (e) => /helper process exited|helper stdin/i.test(e.message),
  );
});

test('helper protocol: a stuck helper TIMES OUT (15s) instead of hanging the agent', { timeout: 25_000 }, async (t) => {
  const client = await fakeClient('slow', t);
  await assert.rejects(
    () => client.call('ping'),
    (e) => /timed out after 15s/i.test(e.message),
  );
});

// ── The seam classes (HelperWin32Surface / HelperWin32Input) ────────────────

test('seam: HelperWin32Surface.captureJpeg encodes the fake BGRA frame (channel swap verifiable)', async (t) => {
  const { RustHelperClient, HelperWin32Surface } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  const client = new RustHelperClient({ helperPath: process.execPath, args: [FAKE] });
  process.env.DIGBY_FAKE_HELPER_MODE = 'ok';
  t.after(async () => {
    delete process.env.DIGBY_FAKE_HELPER_MODE;
    await client.dispose();
  });
  const surface = new HelperWin32Surface(client);
  const shot = await surface.captureJpeg(1568, 75);
  assert.equal(shot.width, 2);
  assert.equal(shot.height, 2);
  assert.ok(shot.base64.length > 50, 'jpeg bytes exist');
  // The frame is cached for the DRM heuristic.
  assert.ok(surface.lastCapture, 'lastCapture is populated');
  assert.equal(surface.lastCapture.backend, 'wgc');
  assert.equal(surface.lastCapture.bgra.length, 2 * 2 * 4);
});

// ── The frozen refusal codes relay VERBATIM ─────────────────────────────────

test('refusals: the frozen UIA_* codes are exported and stable', async () => {
  const { REFUSAL_CODES } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  assert.equal(REFUSAL_CODES.ELEVATED, 'UIA_E_ELEVATED');
  assert.equal(REFUSAL_CODES.SECURE_DESKTOP, 'UIA_E_SECURE_DESKTOP');
  assert.equal(REFUSAL_CODES.DRM, 'UIA_E_DRM');
  assert.equal(REFUSAL_CODES.ANTICHEAT, 'UIA_E_ANTICHEAT');
  assert.equal(REFUSAL_CODES.NOT_FOUND, 'UIA_E_NOT_FOUND');
  assert.equal(REFUSAL_CODES.UNSUPPORTED, 'UIA_E_UNSUPPORTED');
  assert.equal(REFUSAL_CODES.DRM_SUSPECTED_WARNING, 'UIA_W_DRM_SUSPECTED');
});

test('refusals: a helper error response surfaces as code+message and isRefusal', async (t) => {
  const client = await fakeClient('refuse-uia', t);
  await assert.rejects(
    () => client.call('uia_tree', { root: 'foreground' }),
    (e) => {
      assert.equal(e.code, 'UIA_E_UNSUPPORTED');
      assert.equal(e.isRefusal, true);
      assert.match(e.message, /pattern is not implemented/);
      return true;
    },
  );
});

// ── UIA perception through dispatch (param validation + surfacing) ─────────

test('uia_tree: valid params pass, invalid params refuse with clear errors', async (t) => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const { RustHelperClient } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  const client = new RustHelperClient({ helperPath: process.execPath, args: [FAKE] });
  process.env.DIGBY_FAKE_HELPER_MODE = 'ok';
  t.after(async () => {
    delete process.env.DIGBY_FAKE_HELPER_MODE;
    await client.dispose();
  });
  const deps = {
    surface: {}, input: {}, helper: client,
  };
  const GEO = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };

  // Valid (defaults).
  const okTree = await executeComputer('computer_uia_tree', {}, deps, GEO);
  assert.equal(okTree.ok, true, okTree.error);
  assert.ok(okTree.uiaText.includes('- window "Untitled - Notepad"'));
  assert.ok(okTree.uiaText.includes('#42.7'), 'runtime ids render');
  assert.ok(okTree.uiaText.includes('="hello world"'), 'values render');
  assert.equal(okTree.uiaNodeCount, 3);

  // root validation.
  const badRoot = await executeComputer('computer_uia_tree', { root: 'bogus' }, deps, GEO);
  assert.equal(badRoot.ok, false);
  assert.match(badRoot.error, /invalid root/i);

  // max_depth / max_nodes validation.
  const badDepth = await executeComputer('computer_uia_tree', { max_depth: 0 }, deps, GEO);
  assert.equal(badDepth.ok, false);
  assert.match(badDepth.error, /max_depth must be a number 1\.\.32/i);
  const badNodes = await executeComputer('computer_uia_tree', { max_nodes: 99999 }, deps, GEO);
  assert.equal(badNodes.ok, false);
  assert.match(badNodes.error, /max_nodes must be a number 1\.\.2000/i);

  // desktop root is valid.
  const desk = await executeComputer('computer_uia_tree', { root: 'desktop', max_depth: 2, max_nodes: 50 }, deps, GEO);
  assert.equal(desk.ok, true, desk.error);

  // Without a helper wired: clear actionable refusal.
  const noHelper = await executeComputer('computer_uia_tree', {}, { surface: {}, input: {} }, GEO);
  assert.equal(noHelper.ok, false);
  assert.match(noHelper.error, /digby-win-helper\.exe/);
});

test('uia_invoke: runtime_id + pattern validation; set_value requires value', async (t) => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const { RustHelperClient } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  const client = new RustHelperClient({ helperPath: process.execPath, args: [FAKE] });
  process.env.DIGBY_FAKE_HELPER_MODE = 'ok';
  t.after(async () => {
    delete process.env.DIGBY_FAKE_HELPER_MODE;
    await client.dispose();
  });
  const deps = { surface: {}, input: {}, helper: client };
  const GEO = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };

  // Valid invoke.
  const ok = await executeComputer('computer_uia_invoke', { runtime_id: [42, 7, 1001], pattern: 'invoke' }, deps, GEO);
  assert.equal(ok.ok, true, ok.error);

  // Missing/empty runtime_id.
  const noRid = await executeComputer('computer_uia_invoke', { pattern: 'invoke' }, deps, GEO);
  assert.equal(noRid.ok, false);
  assert.match(noRid.error, /runtime_id is required/i);
  const emptyRid = await executeComputer('computer_uia_invoke', { runtime_id: [], pattern: 'invoke' }, deps, GEO);
  assert.equal(emptyRid.ok, false);
  assert.match(emptyRid.error, /runtime_id is required/i);

  // Bad pattern.
  const badPat = await executeComputer('computer_uia_invoke', { runtime_id: [42], pattern: 'nuke' }, deps, GEO);
  assert.equal(badPat.ok, false);
  assert.match(badPat.error, /pattern must be one of/i);

  // set_value without value.
  const noVal = await executeComputer('computer_uia_invoke', { runtime_id: [42], pattern: 'set_value' }, deps, GEO);
  assert.equal(noVal.ok, false);
  assert.match(noVal.error, /set_value requires a value string/i);

  // set_value WITH value.
  const withVal = await executeComputer('computer_uia_invoke', { runtime_id: [42, 7, 1002], pattern: 'set_value', value: 'typed text' }, deps, GEO);
  assert.equal(withVal.ok, true, withVal.error);
});

test('uia_invoke: the helper refusal relays verbatim through dispatch', async (t) => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const { RustHelperClient } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  const client = new RustHelperClient({ helperPath: process.execPath, args: [FAKE] });
  process.env.DIGBY_FAKE_HELPER_MODE = 'refuse-uia';
  t.after(async () => {
    delete process.env.DIGBY_FAKE_HELPER_MODE;
    await client.dispose();
  });
  const deps = { surface: {}, input: {}, helper: client };
  const GEO = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  const out = await executeComputer('computer_uia_invoke', { runtime_id: [99], pattern: 'invoke' }, deps, GEO);
  assert.equal(out.ok, false);
  assert.match(out.error, /^UIA_E_NOT_FOUND: /, 'the frozen code prefixes the error');
  assert.match(out.error, /take a fresh tree/);
});

test('uia_invoke: the B3 safety preflight — UIA cannot bypass the input refusals (review B3)', async (t) => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const { RustHelperClient } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  const { SafetyGate } = await import(join(pkgRoot, 'dist', 'safety.js'));
  // A WORKING helper (mode 'ok' — invoke would succeed) behind a safety gate
  // that reports each refusal condition: the preflight must refuse BEFORE
  // the helper is ever asked to invoke.
  const client = new RustHelperClient({ helperPath: process.execPath, args: [FAKE] });
  process.env.DIGBY_FAKE_HELPER_MODE = 'ok';
  t.after(async () => {
    delete process.env.DIGBY_FAKE_HELPER_MODE;
    await client.dispose();
  });
  const GEO = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  const baseEnv = {
    secure_desktop: false, elevated_foreground: false, foreground_exe: 'Notepad.exe',
    foreground_title: 'Untitled', foreground_rect: { x: 0, y: 0, w: 800, h: 600 }, foreground_pid: 1,
  };
  for (const [name, envOverride, code] of [
    ['elevated foreground', { elevated_foreground: true }, 'UIA_E_ELEVATED'],
    ['secure desktop', { secure_desktop: true }, 'UIA_E_SECURE_DESKTOP'],
    ['anti-cheat foreground', { foreground_exe: 'vgc.exe' }, 'UIA_E_ANTICHEAT'],
  ]) {
    const deps = {
      surface: {}, input: {}, helper: client,
      safety: new SafetyGate({ environment: async () => ({ ...baseEnv, ...envOverride }) }),
    };
    const out = await executeComputer('computer_uia_invoke', { runtime_id: [42, 7, 1001], pattern: 'invoke' }, deps, GEO);
    assert.equal(out.ok, false, `${name}: uia_invoke must refuse`);
    assert.match(out.error, new RegExp(`^${code}: `), `${name}: carries ${code} — got: ${out.error}`);
  }
  // Control: with a clean environment the same invoke succeeds.
  const clean = {
    surface: {}, input: {}, helper: client,
    safety: new SafetyGate({ environment: async () => baseEnv }),
  };
  const ok = await executeComputer('computer_uia_invoke', { runtime_id: [42, 7, 1001], pattern: 'invoke' }, clean, GEO);
  assert.equal(ok.ok, true, ok.error);
});

// ── The safety gate (elevation / secure desktop / anti-cheat) ───────────────

test('safety: UIA_E_ELEVATED refusal when the foreground process is elevated', async (t) => {
  const client = await fakeClient('refuse-elevated', t);
  const { SafetyGate } = await import(join(pkgRoot, 'dist', 'safety.js'));
  const gate = new SafetyGate({ environment: () => client.call('environment_check') });
  const r = await gate.elevationRefusal();
  assert.match(r, /^UIA_E_ELEVATED: /);
  assert.match(r, /UIPI/);
  // Secure desktop + anti-cheat are NOT triggered in this mode.
  assert.equal(await gate.secureDesktopRefusal(), null);
  assert.equal(await gate.antiCheatRefusal(), null);
});

test('safety: UIA_E_SECURE_DESKTOP refusal when a UAC prompt is up', async (t) => {
  const client = await fakeClient('refuse-secure', t);
  const { SafetyGate } = await import(join(pkgRoot, 'dist', 'safety.js'));
  const gate = new SafetyGate({ environment: () => client.call('environment_check') });
  const r = await gate.secureDesktopRefusal();
  assert.match(r, /^UIA_E_SECURE_DESKTOP: /);
  assert.match(r, /UAC prompt or lock screen/);
});

test('safety: UIA_E_ANTICHEAT refusal for vgc.exe (the default list)', async (t) => {
  const client = await fakeClient('refuse-anticheat', t);
  const { SafetyGate } = await import(join(pkgRoot, 'dist', 'safety.js'));
  const gate = new SafetyGate({ environment: () => client.call('environment_check') });
  const r = await gate.antiCheatRefusal();
  assert.match(r, /^UIA_E_ANTICHEAT: /);
  assert.match(r, /vgc\.exe/);
});

test('safety: the anti-cheat list MERGES defaults with config (case-insensitive, deduped)', async () => {
  const { mergeAntiCheatList, isAntiCheat, DEFAULT_ANTICHEAT_PROCESSES } = await import(join(pkgRoot, 'dist', 'safety.js'));
  assert.deepEqual(DEFAULT_ANTICHEAT_PROCESSES, ['vgc.exe', 'vgtray.exe', 'EasyAntiCheat.exe', 'EasyAntiCheat_EOS.exe', 'BEService.exe']);
  const merged = mergeAntiCheatList(['MyGameGuard.exe', 'VGC.EXE', '  ', '']);
  assert.ok(merged.includes('mygameguard.exe'));
  assert.ok(merged.includes('vgc.exe'));
  assert.equal(merged.filter((x) => x === 'vgc.exe').length, 1, 'deduped');
  assert.equal(merged.length, 6);
  // Basename matching: a full path matches its exe name.
  assert.ok(isAntiCheat('C:\\Riot Vanguard\\vgc.exe', merged));
  assert.ok(isAntiCheat('EasyAntiCheat_EOS.exe', merged));
  assert.ok(!isAntiCheat('Notepad.exe', merged));
  assert.ok(!isAntiCheat('', merged));
});

test('safety: refusalError + drmWarningLine formats', async () => {
  const { refusalError, drmWarningLine, REFUSAL_GUIDANCE } = await import(join(pkgRoot, 'dist', 'safety.js'));
  assert.match(refusalError('UIA_E_DRM'), /^UIA_E_DRM: /);
  assert.match(refusalError('UIA_E_DRM'), /computer_uia_tree/);
  assert.match(refusalError('UIA_E_ELEVATED', 'AdminApp.exe'), /\(AdminApp\.exe\)$/);
  assert.match(drmWarningLine(), /^UIA_W_DRM_SUSPECTED: /);
  // Every frozen code has guidance.
  for (const code of ['UIA_E_ELEVATED', 'UIA_E_SECURE_DESKTOP', 'UIA_E_DRM', 'UIA_E_ANTICHEAT', 'UIA_E_NOT_FOUND', 'UIA_E_UNSUPPORTED']) {
    assert.ok(REFUSAL_GUIDANCE[code], `${code} needs guidance`);
  }
});

// ── The DRM heuristic (agent side) ──────────────��───────────────────────────

test('drm: uniform-black foreground rect is suspected; a bright band clears it', async () => {
  const { drmSuspectedAgent } = await import(join(pkgRoot, 'dist', 'safety.js'));
  const w = 600, h = 400;
  const black = Buffer.alloc(w * h * 4);
  assert.ok(drmSuspectedAgent(black, w, h, { x: 0, y: 0, w, h }));
  assert.ok(!drmSuspectedAgent(black, w, h, null), 'no rect → not suspected');
  assert.ok(!drmSuspectedAgent(black, w, h, { x: 0, y: 0, w: 100, h: 100 }), 'small rect → not suspected');
  const withText = Buffer.from(black);
  for (let x = 0; x < w; x++) {
    for (let y = 200; y < 208; y++) {
      const o = (y * w + x) * 4;
      withText[o] = 0xff; withText[o + 1] = 0xff; withText[o + 2] = 0xff;
    }
  }
  assert.ok(!drmSuspectedAgent(withText, w, h, { x: 0, y: 0, w, h }), 'text UI clears the suspicion');
});

test('drm: the screenshot observation carries the warning line (never an error)', async (t) => {
  const { executeComputer } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const { RustHelperClient, HelperWin32Surface } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  const { SafetyGate } = await import(join(pkgRoot, 'dist', 'safety.js'));

  // A black 600x400 frame (uniform black in the foreground rect) + a normal
  // environment. The fake helper's capture is 2x2 — so this test scripts the
  // surface directly with a LAST CAPTURE that is uniformly black and big.
  const blackFrame = Buffer.alloc(600 * 400 * 4);
  const surface = {
    async monitorSize() { return { width: 600, height: 400 }; },
    async captureJpeg() { return { base64: 'aGk=', width: 600, height: 400 }; },
    async frontmost() { return { app: 'Player.exe', window: 'Movie' }; },
    lastCapture: { bgra: blackFrame, width: 600, height: 400, backend: 'wgc' },
  };
  const client = new RustHelperClient({ helperPath: process.execPath, args: [FAKE] });
  process.env.DIGBY_FAKE_HELPER_MODE = 'ok';
  t.after(async () => {
    delete process.env.DIGBY_FAKE_HELPER_MODE;
    await client.dispose();
  });
  const env = {
    secure_desktop: false, elevated_foreground: false, foreground_exe: 'Player.exe',
    foreground_title: 'Movie', foreground_rect: { x: 0, y: 0, w: 600, h: 400 }, foreground_pid: 9,
  };
  const deps = {
    surface, input: {}, helper: client,
    safety: new SafetyGate({ environment: async () => env }),
  };
  const GEO = { imageWidth: 600, imageHeight: 400, screenWidth: 600, screenHeight: 400 };
  const obs = await executeComputer('computer_screenshot', {}, deps, GEO);
  assert.equal(obs.ok, true, 'a suspected-DRM capture is still DELIVERED');
  assert.match(obs.warning, /^UIA_W_DRM_SUSPECTED: /);
  assert.ok(obs.screenshotBase64, 'the pixels ride along');
});

// ── Helper resolution (config > env > bundle root > inside dist) ────────────
// Ticket 4424ebd6 (2026-10-21): v0.9.0 shipped digby-win-helper.exe at the
// AGENT BUNDLE ROOT (digby.nsi SecAgent — $INSTDIR\agent\digby-win-helper.exe,
// BESIDE the dist\ folder) but probed only INSIDE dist\
// (join(__dirname,'digby-win-helper.exe')), so a fresh standard install paired
// and polled fine while EVERY computer_* command failed with "helper
// executable not found". The suite below replays the SHIPPED bundle layout
// through the real resolution logic (mkdtemp + fromDir injection) — the exact
// regression a v0.9.0-style probe would recommit.

test('resolution: helperPath > DIGBY_WIN_HELPER env > bundle root > inside dist', async (t) => {
  const { resolveHelperCommand, helperProbePaths } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  // Explicit path wins.
  assert.deepEqual(resolveHelperCommand({ helperPath: '/x/y.exe' }), { cmd: '/x/y.exe', args: [] });

  // Env var next (clean the process env for the check).
  const had = process.env.DIGBY_WIN_HELPER;
  delete process.env.DIGBY_WIN_HELPER;
  assert.equal(resolveHelperCommand(), null, 'nothing at either probe location on the CI box → null');
  process.env.DIGBY_WIN_HELPER = '/env/helper.exe';
  t.after(() => {
    if (had === undefined) delete process.env.DIGBY_WIN_HELPER;
    else process.env.DIGBY_WIN_HELPER = had;
  });
  assert.deepEqual(resolveHelperCommand(), { cmd: '/env/helper.exe', args: [] });
  delete process.env.DIGBY_WIN_HELPER;
  if (had !== undefined) process.env.DIGBY_WIN_HELPER = had;

  // 4424ebd6 replay — the SHIPPED installer layout: the exe at the bundle
  // root, BESIDE dist/ (where digby.nsi SecAgent puts it), nothing inside
  // dist/. v0.9.0 resolved this to null → "helper executable not found".
  const bundle = await mkdtemp(join(tmpdir(), 'digby-agent-bundle-'));
  const distDir = join(bundle, 'dist');
  mkdirSync(distDir, { recursive: true });
  const rootExe = join(bundle, 'digby-win-helper.exe');
  writeFileSync(rootExe, ''); // existsSync is the only probe — content-free
  t.after(() => rmSync(bundle, { recursive: true, force: true }));
  const resolved = resolveHelperCommand(undefined, distDir);
  assert.ok(resolved, 'the shipped layout (exe beside dist/) MUST resolve');
  assert.equal(resolved.cmd, rootExe, 'resolves to the bundle-root exe, not a dist/ path');

  // Probe ORDER: bundle root comes FIRST — a stale exe a user once copied
  // inside dist/ (the old manual workaround) must not shadow a fresh
  // bundle-root exe on upgrade (NSIS File /r dist never deletes it).
  assert.deepEqual(helperProbePaths(distDir), [rootExe, join(distDir, 'digby-win-helper.exe')]);
  const insideExe = join(distDir, 'digby-win-helper.exe');
  writeFileSync(insideExe, '');
  assert.equal(resolveHelperCommand(undefined, distDir).cmd, rootExe, 'bundle-root exe wins over a stale inside-dist exe');

  // The legacy manual workaround still works when ONLY inside dist/ exists.
  rmSync(rootExe);
  const legacy = resolveHelperCommand(undefined, distDir);
  assert.ok(legacy, 'inside-dist exe alone still resolves (legacy workaround)');
  assert.equal(legacy.cmd, insideExe);

  // Neither location → null (clean refusal, the pre-fix behavior for genuinely
  // missing helpers — DIGBY_WIN_HELPER or reinstall remains the actionable fix).
  rmSync(insideExe);
  assert.equal(resolveHelperCommand(undefined, distDir), null);
});

// ── Helper failure NEVER touches browser_* ──────────────────────────────────

test('isolation: a missing helper refuses computer_* but never browser_*', async () => {
  const { executeCommand } = await import(join(pkgRoot, 'dist', 'commands.js'));
  const { NullWin32Surface, NullWin32Input } = await import(join(pkgRoot, 'dist', 'win-platform.js'));
  const deps = {
    surface: new NullWin32Surface(),
    input: new NullWin32Input(),
    // A browser seam that WORKS — proving the helper failure is isolated.
    // (executeBrowser looks up the FULL method name as the key.)
    browser: {
      async browser_navigate() { return { ok: true, title: 'Digby' }; },
    },
  };
  const GEO = { imageWidth: 0, imageHeight: 0, screenWidth: 0, screenHeight: 0 };
  const shot = await executeCommand('computer_screenshot', {}, deps, GEO);
  assert.equal(shot.ok, false);
  const nav = await executeCommand('browser_navigate', { url: 'https://digby.example.com' }, deps, GEO);
  assert.equal(nav.ok, true, 'browser_* works while computer_* refuses');
});

// ── The real binary, when present (opt-in via DIGBY_TEST_REAL_HELPER) ───────

test('real helper (optional): spawns and answers ping when DIGBY_TEST_REAL_HELPER points at it', { skip: !process.env.DIGBY_TEST_REAL_HELPER }, async (t) => {
  const { RustHelperClient } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  const client = new RustHelperClient({ helperPath: process.env.DIGBY_TEST_REAL_HELPER });
  t.after(() => client.dispose());
  const pong = await client.call('ping');
  assert.equal(pong.version, '0.9.1');
  // On Linux every Win32 method answers HELPER_E_PLATFORM (the graceful
  // non-Windows refusal) — on Windows this same suite runs against the
  // real thing.
  if (process.platform !== 'win32') {
    await assert.rejects(
      () => client.call('monitor_size'),
      (e) => e.code === 'HELPER_E_PLATFORM',
    );
  }
});

// ── Rust source pins (the crate's frozen constants, guarded from TS) ────────

test('rust crate: protocol version + refusal codes match the TS mirror', () => {
  const protocolRs = readFileSync(join(pkgRoot, 'rust-helper', 'src', 'protocol.rs'), 'utf8');
  for (const code of ['UIA_E_ELEVATED', 'UIA_E_SECURE_DESKTOP', 'UIA_E_DRM', 'UIA_E_ANTICHEAT', 'UIA_E_NOT_FOUND', 'UIA_E_UNSUPPORTED', 'UIA_W_DRM_SUSPECTED']) {
    assert.ok(protocolRs.includes(`pub const ${code}`), `${code} must be defined in protocol.rs`);
  }
  assert.ok(protocolRs.includes('pub const VERSION: &str = "0.9.1"'), 'the helper protocol version tracks 0.9.1');
  const cargo = readFileSync(join(pkgRoot, 'rust-helper', 'Cargo.toml'), 'utf8');
  assert.ok(cargo.includes('version = "0.9.1"'), 'the crate version tracks 0.9.1');
});

// Silence the unused-import lint for spawn (kept for future modes).
void spawn;
