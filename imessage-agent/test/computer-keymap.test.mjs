/**
 * Regression tests for the computer-use typing path (feedback ticket cbaf3e08).
 *
 * The mishap: on macOS 26 the agent's `type` action created every keystroke
 * with keycode 0 (= kVK_ANSI_A) and relied on CGEventKeyboardSetUnicodeString
 * to override the character; the JXA→UniChar* bridging silently no-ops on
 * macOS 26, so every typed string became a run of 'a' characters — the user's
 * "app.swapcard.com" landed as a Google search for "aaaaaaaaaaaaaaaaaaaaaa".
 *
 * The fix (agent v0.4.2) plans REAL keycode events in computer-keymap.ts.
 * These tests pin: (1) the whole printable US-ASCII set maps to real keycodes,
 * (2) the ticket's exact failing strings plan to keycode steps with NO
 * fallback and NO all-keycode-0 collapse, (3) map internal consistency,
 * (4) the built runner keeps UnicodeString strictly as a fallback for
 * unmapped chars (structural pin against re-introducing the old design).
 *
 * Run: `npm test` in imessage-agent/ (builds dist/ first — tests import the
 * BUILT module, i.e. exactly what ships in the app bundle).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const { typeStepsFor, keySpecFor, charKeyTableJson } = await import(join(pkgRoot, 'dist', 'computer-keymap.js'));

test('every printable US-ASCII char (0x20–0x7E) maps to a real keycode step', () => {
  for (let cp = 0x20; cp <= 0x7e; cp++) {
    const ch = String.fromCharCode(cp);
    assert.ok(keySpecFor(ch), `unmapped printable ASCII: ${JSON.stringify(ch)} (0x${cp.toString(16)}) would hit the broken fallback`);
  }
});

test('spot-check keycodes against kVK_ANSI_* constants', () => {
  const cases = {
    a: [0, false], s: [1, false], z: [6, false], q: [12, false], p: [35, false], m: [46, false],
    A: [0, true], Z: [6, true],
    '1': [18, false], '0': [29, false], '!': [18, true], ')': [29, true],
    // Digit-row pins (reviewer aec4596f finding #1): Events.h's out-of-order
    // row is 1,2,3,4,6,5,=,9,7,-,8,0 — '5' is keycode 23, '6' is 22 (swapped
    // in the first cut of this fix; %/^ ride the same base chars).
    '2': [19, false], '3': [20, false], '4': [21, false],
    '5': [23, false], '6': [22, false], '%': [23, true], '^': [22, true],
    '7': [26, false], '8': [28, false], '9': [25, false],
    '-': [27, false], _: [27, true], '=': [24, false], '+': [24, true],
    '.': [47, false], '>': [47, true], '/': [44, false], '?': [44, true],
    ':': [41, true], ';': [41, false], "'": [39, false], '"': [39, true],
    ',': [43, false], '<': [43, true], ' ': [49, false], '`': [50, false], '~': [50, true],
  };
  for (const [ch, [code, shift]] of Object.entries(cases)) {
    assert.deepEqual(keySpecFor(ch), { code, shift }, `wrong spec for ${JSON.stringify(ch)}`);
  }
});

test('whitespace controls plan to real keys (return/tab)', () => {
  assert.deepEqual(typeStepsFor('\n'), [{ k: 'k', c: 36, s: 0 }]);
  assert.deepEqual(typeStepsFor('\t'), [{ k: 'k', c: 48, s: 0 }]);
});

test('cbaf3e08 regression: the failing strings plan to keycodes — no fallback, no all-“a” collapse', () => {
  for (const text of ['app.swapcard.com', 'https://app.swapcard.com', 'probe-123-XYZ']) {
    const steps = typeStepsFor(text);
    assert.equal(steps.length, text.length, `${text}: one step per char`);
    const fallbacks = steps.filter((s) => s.k === 'u');
    assert.equal(fallbacks.length, 0, `${text}: ASCII must never reach the UnicodeString fallback`);
    const codes = steps.map((s) => s.c);
    assert.ok(!codes.every((c) => c === 0), `${text}: all-keycode-0 plan is the garbled-“aaaa…” bug shape`);
    // spot anchor: 'a' is an INTENTIONAL keycode 0, distinct from other chars
    if (text.includes('a')) assert.equal(steps[text.indexOf('a')].c, 0);
    assert.notEqual(steps[text.indexOf('p')].c, 0);
  }
});

test('map consistency: no duplicate (keycode, shift) pairs; all keycodes in the ANSI set', () => {
  const seen = new Map();
  const validCodes = new Set([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    31, 32, 33, 34, 35, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 49, 50, 36, 48,
  ]);
  for (let cp = 0x20; cp <= 0x7e; cp++) {
    const ch = String.fromCharCode(cp);
    const spec = keySpecFor(ch);
    const sig = `${spec.code}:${spec.shift}`;
    assert.ok(!seen.has(sig), `duplicate key spec ${sig} for ${JSON.stringify(ch)} and ${JSON.stringify(seen.get(sig))}`);
    seen.set(sig, ch);
    assert.ok(validCodes.has(spec.code), `keycode ${spec.code} for ${JSON.stringify(ch)} is not a known ANSI/control keycode`);
  }
});

test('non-ASCII uses the fallback, by code point (no surrogate splitting)', () => {
  const steps = typeStepsFor('café');
  assert.deepEqual(steps.filter((s) => s.k === 'u'), [{ k: 'u', ch: 'é' }]);
  const emoji = typeStepsFor('a😀b');
  assert.equal(emoji.length, 3, 'astral char is ONE step, not two surrogate halves');
  assert.deepEqual(emoji[1], { k: 'u', ch: '😀' });
});

test('structural pin (cbaf3e08): built runner types via steps; UnicodeString only in the fallback branch', () => {
  const src = readFileSync(join(pkgRoot, 'src', 'computer.ts'), 'utf8');
  assert.match(src, /typeStepsFor\(text\)/, 'typeText must plan steps via computer-keymap');
  assert.ok(!src.includes('text.charAt(ci)'), 'old per-char keycode-0 loop is gone');
  const typeAction = src.split("if (action === 'type')")[1].split("if (action === 'key')")[0];
  const callAt = typeAction.search(/\$\.CGEventKeyboardSetUnicodeString\(/);
  assert.ok(callAt > typeAction.indexOf("st.k === 'u'"),
    'UnicodeString call must appear only AFTER the fallback-branch guard');
  assert.ok(!/CGEventCreateKeyboardEvent\(\$\(\), 0, true\);\s*\n\s*\$\.CGEventKeyboardSetUnicodeString\(kd, 1, ch\)/.test(typeAction),
    'the exact keycode-0+override pattern from the mishap is gone');
  // v5 shape pins (live-E2E-derived, macOS 26.6.2):
  // (a) modifier sweep = UP-only releases for cmd/opt/ctrl (a modifier DOWN
  //     warm-up raced a char into Cmd+P → live Print dialog) + shift-key
  //     down/up transitions (shift+char can never trigger a menu shortcut).
  assert.match(typeAction, /MOD_RELEASE = \[54, 55, 58, 59, 61, 62\]/, 'cmd/opt/ctrl release list required');
  assert.match(typeAction, /MOD_RELEASE\[mi2\], false\)/, 'cmd/opt/ctrl sweep must be UP-only (no press = no shortcut race)');
  assert.ok(!/MOD_RELEASE\[mi2\], true\)/.test(typeAction), 'never press cmd/opt/ctrl in the warm-up sweep');
  assert.match(typeAction, /SHIFT_KEYS = \[56, 60\]/, 'shift-key warm-up list required');
  assert.match(typeAction, /SHIFT_KEYS\[si2\], true\)/, 'warm-up needs a real shift DOWN transition');
  // (b) shifted chars use the PHYSICAL shape: shift-KEY (56) down/up around the char.
  assert.match(typeAction, /CGEventCreateKeyboardEvent\(\$\(\), 56, true\)/, 'shifted chars must press the shift KEY first');
  assert.match(typeAction, /CGEventCreateKeyboardEvent\(\$\(\), 56, false\)/, 'shifted chars must release the shift KEY');
  // (c) flags only ever on keyDOWN events (sd = shift-key down, kds = char down) —
  //     a flagged keyUP re-asserts the modifier and sticks it globally
  //     ("XYZ https://…" → "XYZ HTTPS:??…").
  const flagCalls = typeAction.match(/CGEventSetFlags\((\w+),/g) || [];
  assert.ok(flagCalls.length > 0 && flagCalls.every((c) => /\((sd|kds),/.test(c)),
    `CGEventSetFlags may only target keydown events (sd/kds); found: ${flagCalls.join(', ')}`);
});

test('key action resolves single characters via the US-ANSI table (cbaf3e08 Cmd+L fix)', () => {
  const src = readFileSync(join(pkgRoot, 'src', 'computer.ts'), 'utf8');
  const keyAction = src.split("if (action === 'key')")[1];
  assert.match(keyAction, /CHAR_KEYS\[keyName\]/, 'key action must look up single chars in CHAR_KEYS');
  assert.match(keyAction, /keyName\.length === 1/, 'single-char path must be length-guarded');
  const table = JSON.parse(charKeyTableJson());
  assert.deepEqual(table['l'], [37, 0], 'l → keycode 37 unshifted (Cmd+L!)');
  assert.deepEqual(table['c'], [8, 0], 'c → keycode 8 unshifted (Cmd+C)');
  assert.deepEqual(table['n'], [45, 0], 'n → keycode 45 unshifted (Cmd+N)');
  assert.deepEqual(table['L'], [37, 1], 'L → keycode 37 shifted');
});
