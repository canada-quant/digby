/**
 * US-ANSI keyboard-layout char → macOS virtual keycode map + typing planner
 * for the computer-use `type` action (agent v0.4.2, feedback ticket cbaf3e08).
 *
 * WHY THIS EXISTS — the pre-0.4.2 type action created every keystroke with
 * keycode 0 (= kVK_ANSI_A) and overrode the character via
 * CGEventKeyboardSetUnicodeString. On macOS 26 the JXA→UniChar* bridging of
 * that call silently no-ops, so every event kept its keycode-0 character and
 * any typed string became a run of 'a' characters ("app.swapcard.com" landed
 * as a Google search for "aaaaaaaaaaaaaaaaaaaaaa"). Keycode-based events are
 * proven to work on the same path (the `key` action — Cmd+L, Cmd+Tab, Return —
 * worked throughout the incident), so the fix routes text through real
 * keycodes + shift flags and reserves the UnicodeString call as a best-effort
 * fallback for characters outside the US-ANSI printable set.
 *
 * Layout caveat: keycodes are PHYSICAL keys — on a non-US keyboard layout the
 * produced characters follow the user's layout (the pre-0.4.2 design was
 * layout-independent in theory but produced 'a'-only garbage in practice on
 * macOS 26). US-ANSI covers the reported fleet; the fallback keeps non-ASCII
 * input best-effort instead of silently dropping it.
 *
 * This module is pure (no I/O) so the node:test suite can verify the plan
 * exactly as the JXA runner will execute it.
 */

/** macOS virtual keycodes (HIToolbox/Events.h kVK_ANSI_*) for the unshifted
 *  US-ANSI layout. [char, keycode] — 0x0A/0x24/0x30 etc. are not printable
 *  chars, hence the gaps. */
const UNSHIFTED_ROWS: ReadonlyArray<readonly [string, number]> = [
  ['a', 0], ['s', 1], ['d', 2], ['f', 3], ['h', 4], ['g', 5], ['z', 6], ['x', 7], ['c', 8], ['v', 9],
  ['b', 11], ['q', 12], ['w', 13], ['e', 14], ['r', 15], ['y', 16], ['t', 17],
  ['1', 18], ['2', 19], ['3', 20], ['4', 21], ['5', 23], ['6', 22], ['=', 24],
  ['9', 25], ['7', 26], ['-', 27], ['8', 28], ['0', 29], [']', 30],
  ['o', 31], ['u', 32], ['[', 33], ['i', 34], ['p', 35],
  ['l', 37], ['j', 38], ["'", 39], ['k', 40], [';', 41], ['\\', 42],
  [',', 43], ['/', 44], ['n', 45], ['m', 46], ['.', 47],
  [' ', 49], ['`', 50],
];

/** Shifted symbol → the unshifted char on the same physical key (US-ANSI). */
const SHIFTED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['!', '1'], ['@', '2'], ['#', '3'], ['$', '4'], ['%', '5'], ['^', '6'], ['&', '7'], ['*', '8'], ['(', '9'], [')', '0'],
  ['_', '-'], ['+', '='], ['{', '['], ['}', ']'], ['|', '\\'], [':', ';'], ['"', "'"], ['<', ','], ['>', '.'], ['?', '/'], ['~', '`'],
];

export interface KeySpec { code: number; shift: boolean }

const CHAR_KEYCODES: Record<string, KeySpec> = {};
for (const [ch, code] of UNSHIFTED_ROWS) CHAR_KEYCODES[ch] = { code, shift: false };
for (const [shifted, base] of SHIFTED_PAIRS) {
  CHAR_KEYCODES[shifted] = { code: CHAR_KEYCODES[base].code, shift: true };
}
for (let i = 97; i <= 122; i++) {
  const lower = String.fromCharCode(i);
  CHAR_KEYCODES[lower.toUpperCase()] = { code: CHAR_KEYCODES[lower].code, shift: true };
}
// Whitespace controls typed as real keys.
CHAR_KEYCODES['\n'] = { code: 36, shift: false }; // kVK_Return
CHAR_KEYCODES['\r'] = { code: 36, shift: false };
CHAR_KEYCODES['\t'] = { code: 48, shift: false };  // kVK_Tab

/** One executable typing step, as consumed by the JXA runner's `type` action.
 *  Wire-compact: { k:'k', c, s } = post keycode c (s=1 → shift flag);
 *  { k:'u', ch } = best-effort UnicodeString fallback for unmapped chars. */
export type TypeStep = { k: 'k'; c: number; s: 0 | 1 } | { k: 'u'; ch: string };

/**
 * Plan the keystrokes for a string. Iterates by CODE POINT (for…of), so an
 * astral-plane char (emoji…) reaches the fallback as one intact character
 * instead of two surrogate halves. Every printable US-ASCII char maps to a
 * real keycode — the pre-0.4.2 "everything falls back to keycode 0 = 'a'"
 * failure (ticket cbaf3e08) is impossible for ASCII input.
 */
export function typeStepsFor(text: string): TypeStep[] {
  const steps: TypeStep[] = [];
  for (const ch of text) {
    const spec = CHAR_KEYCODES[ch];
    if (spec) steps.push({ k: 'k', c: spec.code, s: spec.shift ? 1 : 0 });
    else steps.push({ k: 'u', ch });
  }
  return steps;
}

/** Exported for tests: the resolved char → key spec table. */
export function keySpecFor(ch: string): KeySpec | undefined {
  return CHAR_KEYCODES[ch];
}

/** JXA-ready serialization of the whole mapped table ({char: [keycode, shift]}).
 *  Injected into the computer.ts JXA runner so the `key` action can resolve
 *  SINGLE-CHARACTER keys (the backend's computer_key contract advertises
 *  `key "c" + ["cmd"]` for copy — ticket cbaf3e08's Cmd+L retry failed with
 *  "unknown key: l" because the agent only knew named keys). */
export function charKeyTableJson(): string {
  const out: Record<string, [number, number]> = {};
  for (const [ch, spec] of Object.entries(CHAR_KEYCODES)) out[ch] = [spec.code, spec.shift ? 1 : 0];
  return JSON.stringify(out);
}

// ── Modifiers (ticket 746c4d4f, agent 0.9.16) ────────────────────────────────
/**
 * Physical modifier KEYCODES (kVK_Command=55, kVK_Shift=56, kVK_Option=58,
 * kVK_Control=59 for the left variants). These are the ONLY events that move
 * the WindowServer's global modifier state — CGEvent *flags* on a single
 * keydown do not, which is why a chord posted as flags alone is not a chord to
 * the target app (ticket 746c4d4f: Cmd+K read as a bare 'k' and went to
 * Finder), and why a flag left behind survives into the NEXT action.
 */
export const MODIFIER_KEYCODES: Readonly<Record<string, number>> = { cmd: 55, shift: 56, opt: 58, ctrl: 59 };

/** Every modifier keycode (left + right), released by the pre-input sweep so no
 *  INHERITED hold can corrupt the next event: a latched Control makes macOS
 *  resolve a left mouse-down as a SECONDARY click (the reported "every channel
 *  click opens a context menu") and turns a Dock click into the Dock's menu
 *  (the reported "cannot re-front"). Same lesson the `type` action has applied
 *  since 0.4.2 — "char keyups never clear it — only real modifier-KEY
 *  transitions do". */
export const ALL_MODIFIER_KEYCODES: readonly number[] = [54, 55, 58, 59, 61, 62];

/** CGEvent flag bits for the requested modifier names (+a shifted char). */
export function modifierFlagsFor(modifiers: readonly string[], shifted = false): number {
  const FLAG_SHIFT = 131072, FLAG_CTRL = 262144, FLAG_OPT = 524288, FLAG_CMD = 1048576;
  let flags = shifted ? FLAG_SHIFT : 0;
  for (const raw of modifiers) {
    const m = String(raw).toLowerCase();
    if (m === 'cmd' || m === 'command') flags |= FLAG_CMD;
    else if (m === 'shift') flags |= FLAG_SHIFT;
    else if (m === 'ctrl' || m === 'control') flags |= FLAG_CTRL;
    else if (m === 'opt' || m === 'option' || m === 'alt') flags |= FLAG_OPT;
  }
  return flags;
}

/**
 * The modifier keys a chord must actually PRESS, in press order (released in
 * reverse). Request order is kept, plus a real left-shift when the char itself
 * is a shifted one (an uppercase/symbol key from the US-ANSI table) — a shifted
 * char typed with only flag bits is the same broken-chord shape.
 * Duplicates are dropped (["cmd","command"] presses cmd once).
 */
export function modifierHoldKeysFor(modifiers: readonly string[], shifted = false): number[] {
  const held: number[] = [];
  const push = (k: number) => { if (held.indexOf(k) < 0) held.push(k); };
  for (const raw of modifiers) {
    const m = String(raw).toLowerCase();
    if (m === 'cmd' || m === 'command') push(MODIFIER_KEYCODES.cmd);
    else if (m === 'shift') push(MODIFIER_KEYCODES.shift);
    else if (m === 'ctrl' || m === 'control') push(MODIFIER_KEYCODES.ctrl);
    else if (m === 'opt' || m === 'option' || m === 'alt') push(MODIFIER_KEYCODES.opt);
  }
  if (shifted && held.indexOf(MODIFIER_KEYCODES.shift) < 0) held.unshift(MODIFIER_KEYCODES.shift);
  return held;
}

/** JXA-ready serialization of {modifier name → CGEvent flag bit} (aliases
 *  expanded), so the runner holds ONE source of truth for the flag bits the
 *  same way it does for the keycodes — the inline copy is how the click and
 *  key paths drifted from `type` in the first place. */
export function modifierFlagTableJson(): string {
  const out: Record<string, number> = {};
  for (const name of ['cmd', 'command', 'shift', 'ctrl', 'control', 'opt', 'option', 'alt']) {
    const flags = modifierFlagsFor([name]);
    if (flags) out[name] = flags;
  }
  return JSON.stringify(out);
}
export function modifierKeyTableJson(): string {
  const out: Record<string, number> = {};
  for (const name of ['cmd', 'command', 'shift', 'ctrl', 'control', 'opt', 'option', 'alt']) {
    const keys = modifierHoldKeysFor([name]);
    if (keys.length) out[name] = keys[0];
  }
  return JSON.stringify(out);
}
