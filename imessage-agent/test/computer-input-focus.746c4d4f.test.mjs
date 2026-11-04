/**
 * Regression tests for the macOS input-injection path — ticket 746c4d4f
 * (defect family `mac-client-input-focus`).
 *
 * THE MISHAP (owner-verified, Mac agent 0.9.15, paired Mac cql-stanne-mbp1):
 * driving the Discord desktop app through `computer_task`, three symptoms that
 * looked like three separate bugs but are ONE root cause:
 *
 *   1. LEFT-CLICK BECAME RIGHT-CLICK. Every click on Discord's channel list
 *      opened a context menu (Mark As Read / Add to Favorites / Invite / Pin /
 *      Copy Link / Mute) instead of selecting the channel.
 *   2. COMMAND-SHORTCUTS WENT TO FINDER. Cmd+K (Discord's quick switcher)
 *      never reached Discord; typed text landed in Finder.
 *   3. NO RE-FRONT. Clicks on the running Discord Dock icon left Finder
 *      frontmost; Discord would not come forward again in that session.
 *
 * WHAT WAS NOT BROKEN (this is what narrowed it to input, not capture): screen
 * capture read Discord verbatim whenever it happened to be frontmost, and the
 * harness counters showed refusedRepeats=0 / noChangeStrikes=0 — the device was
 * not refusing input, it was delivering a corrupted event.
 *
 * ROOT CAUSE. Modifier state is NOT per-event state; it is the WindowServer's
 * GLOBAL state (kCGEventSourceStateHIDSystemState), and only a physical
 * modifier KEY-UP transition clears it. The runner swept it before typing —
 * its own comment records the law "char keyups never clear it — only real
 * modifier-KEY transitions do" — but the CLICK and KEY paths never did:
 *
 *   (a) one `key` chord (the reporter's working route used Control+Up for
 *       Mission Control) left Control DOWN, and macOS resolves a LEFT
 *       mouse-down carrying the Control flag as a SECONDARY click — so every
 *       later left-click opened a context menu (symptom 1), and a Control-held
 *       Dock click shows the Dock menu instead of activating the app
 *       (symptom 3);
 *   (b) a chord posted as FLAG BITS on one keydown, with no modifier-key
 *       transition, is not a chord to the frontmost app: apps that key off
 *       modifierKeyDown see a bare 'k' and whatever owns the global handler
 *       eats it — Finder (symptom 2).
 *
 * THE FIX (agent 0.9.16) is at the shared seams, so no future action can
 * re-introduce it: `clearModifiers()` releases every modifier key-UP before a
 * click and after a chord, `key` posts a real modifier-key DOWN/UP envelope
 * around the char (released in reverse), and the flags read back BEFORE the
 * sweep ride out on every result as `clearedModifiers` — device-side proof of
 * a corrupted event without a trace.
 *
 * These tests pin (a) the modifier tables' values, (b) the chord/hold
 * computation including shifted chars and duplicate aliases, (c) the flag
 * mapping, and (d) STRUCTURAL pins on the shipped runner source proving the
 * click and key actions actually call the sweep.
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
const { MODIFIER_KEYCODES, ALL_MODIFIER_KEYCODES, modifierFlagsFor, modifierHoldKeysFor, modifierKeyTableJson } =
  await import(join(pkgRoot, 'dist', 'computer-keymap.js'));

const src = readFileSync(join(pkgRoot, 'src', 'computer.ts'), 'utf8');

// ── (a) the modifier keycodes are the real kVK_* constants ──────────────────

test('746c4d4f: modifier keycodes are the physical kVK_* values', () => {
  // macOS Events.h: kVK_Command=0x37, kVK_Shift=0x38, kVK_Option=0x3A, kVK_Control=0x3B.
  assert.equal(MODIFIER_KEYCODES.cmd, 55);   // 0x37 — the key whose hold makes a click move windows
  assert.equal(MODIFIER_KEYCODES.shift, 56); // 0x38
  assert.equal(MODIFIER_KEYCODES.opt, 58);   // 0x3A
  assert.equal(MODIFIER_KEYCODES.ctrl, 59);  // 0x3B — the key whose hold turns left-click into right-click
  // The sweep must cover BOTH sides of every modifier: a stuck RIGHT control
  // corrupts a click exactly like a stuck left one.
  assert.deepEqual([...ALL_MODIFIER_KEYCODES].sort((x, y) => x - y), [54, 55, 58, 59, 61, 62]);
  // The sweep list must be disjoint from nothing that matters: it never
  // contains a non-modifier key (shift=56/60 ARE modifiers and are included in
  // the hold computation, but the pre-click sweep is cmd/opt/ctrl only —
  // releasing shift on every click would break shift-click selection).
  assert.ok(!ALL_MODIFIER_KEYCODES.includes(56), 'pre-click sweep must not release shift (shift-click must survive)');
  assert.ok(!ALL_MODIFIER_KEYCODES.includes(60), 'pre-click sweep must not release shift (shift-click must survive)');
});

test('746c4d4f: the injected modifier table expands every alias to one keycode', () => {
  const table = JSON.parse(modifierKeyTableJson());
  assert.equal(table.cmd, 55);
  assert.equal(table.command, 55, 'Cmd+K arrives as "command" too — the alias must not fall through to no chord');
  assert.equal(table.ctrl, 59);
  assert.equal(table.control, 59, 'the reporter\'s Control+Up route must resolve to a real key transition');
  assert.equal(table.opt, 58);
  assert.equal(table.option, 58);
  assert.equal(table.alt, 58);
  assert.equal(table.shift, 56);
});

// ── (b) chord computation ──────────────────────────────────────────────────

test('746c4d4f: Cmd+K must PRESS the command key, not just set a flag', () => {
  const held = modifierHoldKeysFor(['cmd']);
  assert.deepEqual(held, [55], 'a chord with no modifier-key transition is the reported bug');
});

test('746c4d4f: Control resolves to the control keycode (the stuck-Control cause)', () => {
  // The reporter's one working route was Cmd+H → Control+Up → click. Control+Up
  // is exactly the chord that used to latch Control and poison every later click.
  assert.deepEqual(modifierHoldKeysFor(['ctrl']), [59]);
  assert.deepEqual(modifierHoldKeysFor(['control']), [59]);
});

test('746c4d4f: multi-modifier chords nest in request order and drop duplicates', () => {
  assert.deepEqual(modifierHoldKeysFor(['cmd', 'shift']), [55, 56]);
  assert.deepEqual(modifierHoldKeysFor(['shift', 'cmd']), [56, 55]);
  assert.deepEqual(modifierHoldKeysFor(['cmd', 'command']), [55], 'alias pair must press the key once');
  assert.deepEqual(modifierHoldKeysFor([]), [], 'a bare key needs no modifier hold');
});

test('746c4d4f: a shifted char holds a real shift key', () => {
  // 'L' from the US-ANSI table is keycode 37 shifted; typing shift as flags
  // alone is the same broken-chord shape as Cmd-as-flags.
  assert.deepEqual(modifierHoldKeysFor([], true), [56]);
  // …and the shift is not double-pressed when the caller also asked for it.
  assert.deepEqual(modifierHoldKeysFor(['shift'], true), [56]);
  // A shifted char keeps its other modifiers in request order, shift first.
  assert.deepEqual(modifierHoldKeysFor(['cmd'], true), [56, 55]);
});

// ── (c) flag mapping ───────────────────────────────────────────────────────

test('746c4d4f: flag bits map for every alias', () => {
  const FLAG_SHIFT = 131072, FLAG_CTRL = 262144, FLAG_OPT = 524288, FLAG_CMD = 1048576;
  assert.equal(modifierFlagsFor(['cmd']), FLAG_CMD);
  assert.equal(modifierFlagsFor(['command']), FLAG_CMD);
  assert.equal(modifierFlagsFor(['ctrl']), FLAG_CTRL);
  assert.equal(modifierFlagsFor(['control']), FLAG_CTRL);
  assert.equal(modifierFlagsFor(['opt']), FLAG_OPT);
  assert.equal(modifierFlagsFor(['option']), FLAG_OPT);
  assert.equal(modifierFlagsFor(['alt']), FLAG_OPT);
  assert.equal(modifierFlagsFor(['shift']), FLAG_SHIFT);
  assert.equal(modifierFlagsFor(['cmd', 'shift']), FLAG_CMD | FLAG_SHIFT);
  assert.equal(modifierFlagsFor([], true), FLAG_SHIFT, 'a shifted char carries the shift flag');
  assert.equal(modifierFlagsFor([]), 0);
});

// ── (d) structural pins on the shipped runner ──────────────────────────────

test('746c4d4f: the click action CLEARS inherited modifiers before the mouse-down', () => {
  const clickAction = src.split("if (action === 'click')")[1].split("if (action === 'scroll')")[0];
  // The sweep must exist and run BEFORE the move+click, not after it.
  const sweepAt = clickAction.indexOf('clearModifiers()');
  const moveAt = clickAction.indexOf('moveAndVerify(x, y)');
  assert.ok(sweepAt >= 0, 'click never clears inherited modifiers — a latched Control makes every left-click a right-click');
  assert.ok(moveAt >= 0, 'click lost its move+verify step');
  assert.ok(sweepAt < moveAt, 'the modifier sweep must precede the click (clearing after it corrupts nothing but fixes nothing)');
  // The pre-sweep flags must ride out on the result: without them a corrupted
  // click is indistinguishable from a wrong coordinate on the device.
  assert.match(clickAction, /clearedModifiers: inherited/, 'click result must report the modifiers it cleared');
});

test('746c4d4f: the key action posts a real modifier-key envelope around the char', () => {
  const keyAction = src.split("if (action === 'key')")[1];
  // 1. It computes which modifier keys to hold…
  assert.match(keyAction, /holdKeys/, 'key action has no modifier-hold plan — it is back to flags-only chords');
  // 2. …presses each one DOWN before the char…
  const downLoop = keyAction.indexOf('holdKeys[hk], true');
  const charDown = keyAction.indexOf('CGEventCreateKeyboardEvent($(), code, true)');
  assert.ok(downLoop >= 0, 'chord modifier keys are never pressed');
  assert.ok(charDown >= 0, 'the char keydown vanished');
  assert.ok(downLoop < charDown, 'modifier keys must go DOWN before the char');
  // 3. …releases them AFTER the char, in reverse…
  const upLoop = keyAction.indexOf('holdKeys[hu], false');
  assert.ok(upLoop > charDown, 'modifier keys must be released only after the char');
  assert.match(keyAction, /for \(var hu = holdKeys\.length - 1; hu >= 0; hu--\)/,
    'chord modifiers must be released in REVERSE press order (nesting shape)');
  // 4. …and leaves the world clean for the next action.
  assert.ok(keyAction.lastIndexOf('clearModifiers()') > upLoop,
    'a chord must not leave a modifier latched — the next action is usually a click');
  // 5. The char keyup stays FLAGLESS (a flagged keyUP re-asserts the modifier
  //    and sticks it globally — the cbaf3e08 live finding).
  assert.match(keyAction, /var ku2 = \$\.CGEventCreateKeyboardEvent\(\$\(\), code, false\);/,
    'the char keyup must stay flagless — a flagged keyup sticks the modifier globally');
});

test('746c4d4f: the sweep reads the REAL global modifier state (proof, not a guess)', () => {
  // The helper must read WindowServer state and release keys for real; a
  // "cleared" claim that never released anything would leave the bug in place.
  const helpers = src.split('function modifiersDown()')[1].split("if (action === 'screen_size')")[0];
  assert.match(helpers, /function clearModifiers\(\)/, 'the sweep helper is missing');
  assert.match(helpers, /CGEventSourceFlagsState\(1\)/,
    'the sweep must read kCGEventSourceStateHIDSystemState — an unread latch cannot be reported or proven cleared');
  assert.match(helpers, /ALL_MOD_KEYS\[mk\], false\)/,
    'the sweep must post modifier key-UP transitions — flags alone never clear a latched modifier');
});