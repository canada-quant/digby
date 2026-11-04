/**
 * Windows computer-use platform layer (W0, 2026-09-25 — roadmap §2.2–2.4).
 *
 * THE ADAPTER SEAM. Everything Windows-specific about seeing and driving the
 * screen lives behind the two interfaces at the bottom of this file
 * (Win32Surface + Win32Input). The pure planning/geometry/typing logic above
 * them runs on any OS — that is what the node:test suite exercises on Linux
 * CI (windows-agent/test/), so the contracts port from the macOS agent
 * (verify-or-refuse, geometry reconciliation, scancode typing, modifier
 * clearing) are pinned WITHOUT a Windows box.
 *
 * Ported macOS contracts (imessage-agent/src/computer.ts + computer-keymap.ts):
 *   - verify-or-refuse: a click moves the pointer, reads it back, retries
 *     once, and REFUSES to click blind when it verifiably did not arrive.
 *   - geometry reconciliation: image-pixel → physical-pixel conversion is
 *     cross-checked against the monitor's reported size; on unreconcilable
 *     mismatch, clicks are REFUSED (wrong-scale clicks land at wrong
 *     coordinates — the macOS 4e4d56ff lesson, translated to per-monitor DPI).
 *   - scancode typing: text is planned as REAL scan codes (the SendInput
 *     contract), never as "keycode 0 + hope" (the macOS cbaf3e08 lesson).
 *   - modifier-clearing pre-sweep: stuck modifiers corrupt every later event.
 *
 * The W0 scaffold ships a null implementation (logs + refuses with a clear
 * The W0 scaffold ships a null implementation (logs + refuses with a clear
 * "not yet implemented on this platform" error). W1 filled it in with a native-FFI adapter;
 * W3 replaced it with the Rust helper (digby-win-helper: WGC +
 * SendInput + UIA) — the seam never moves. */

// ── Windows virtual-key / scan-code map (US layout) ─────────────────────────
//
// SendInput keyboard events carry BOTH a virtual-key code (wVk) and a hardware
// scan code (wScan). The scan code is the PHYSICAL key (layout-stable); the
// VK is the logical key. We plan both, mirroring the macOS keymap's
// "real keycodes + shift flags" design.
//
// Scan codes here are Set 1 (make codes), matching what SendInput expects
// with KEYEVENTF_SCANCODE. Extended keys (arrows, Home/End/PgUp/PgDn/Ins/Del)
// carry the KEYEVENTF_EXTENDEDKEY flag — modeled as `extended: true`.

export interface WinKeySpec {
  /** Virtual-key code (WinUser.h VK_*). */
  vk: number;
  /** Set-1 scan code (the physical key). */
  scan: number;
  /** Shift required to produce the char (US layout). */
  shift: boolean;
  /** Extended-key flag (arrows, navigation cluster, Numpad /). */
  extended?: boolean;
}

/** Unshifted printable US-layout chars → VK + scan code.
 *  [char, vk, scan] — scan codes are the standard Set-1 make codes. */
const UNSHIFTED_ROWS: ReadonlyArray<readonly [string, number, number]> = [
  ['a', 0x41, 0x1E], ['b', 0x42, 0x30], ['c', 0x43, 0x2E], ['d', 0x44, 0x20],
  ['e', 0x45, 0x12], ['f', 0x46, 0x21], ['g', 0x47, 0x22], ['h', 0x48, 0x23],
  ['i', 0x49, 0x17], ['j', 0x4A, 0x24], ['k', 0x4B, 0x25], ['l', 0x4C, 0x26],
  ['m', 0x4D, 0x32], ['n', 0x4E, 0x31], ['o', 0x4F, 0x18], ['p', 0x50, 0x19],
  ['q', 0x51, 0x10], ['r', 0x52, 0x13], ['s', 0x53, 0x1F], ['t', 0x54, 0x14],
  ['u', 0x55, 0x16], ['v', 0x56, 0x2F], ['w', 0x57, 0x11], ['x', 0x58, 0x2D],
  ['y', 0x59, 0x15], ['z', 0x5A, 0x2C],
  ['1', 0x31, 0x02], ['2', 0x32, 0x03], ['3', 0x33, 0x04], ['4', 0x34, 0x05],
  ['5', 0x35, 0x06], ['6', 0x36, 0x07], ['7', 0x37, 0x08], ['8', 0x38, 0x09],
  ['9', 0x39, 0x0A], ['0', 0x30, 0x0B],
  [' ', 0x20, 0x39], ['-', 0xBD, 0x0C], ['=', 0xBB, 0x0D], ['[', 0xDB, 0x1A],
  [']', 0xDD, 0x1B], ['\\', 0xDC, 0x2B], [';', 0xBA, 0x27], ["'", 0xDE, 0x28],
  [',', 0xBC, 0x33], ['.', 0xBE, 0x34], ['/', 0xBF, 0x35], ['`', 0xC0, 0x29],
];

/** Shifted symbol → the unshifted char on the same physical key (US layout). */
const SHIFTED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['!', '1'], ['@', '2'], ['#', '3'], ['$', '4'], ['%', '5'], ['^', '6'],
  ['&', '7'], ['*', '8'], ['(', '9'], [')', '0'],
  ['_', '-'], ['+', '='], ['{', '['], ['}', ']'], ['|', '\\'], [':', ';'],
  ['"', "'"], ['<', ','], ['>', '.'], ['?', '/'], ['~', '`'],
];

const CHAR_SPECS: Record<string, WinKeySpec> = {};
for (const [ch, vk, scan] of UNSHIFTED_ROWS) CHAR_SPECS[ch] = { vk, scan, shift: false };
for (const [shifted, base] of SHIFTED_PAIRS) {
  CHAR_SPECS[shifted] = { ...CHAR_SPECS[base], shift: true };
}
for (let i = 97; i <= 122; i++) {
  const lower = String.fromCharCode(i);
  CHAR_SPECS[lower.toUpperCase()] = { ...CHAR_SPECS[lower], shift: true };
}

/** Named non-printable keys the backend's `key` action accepts (the macOS
 *  keymap's named-key contract). VK + Set-1 scan code per key. */
export const NAMED_KEYS: Readonly<Record<string, WinKeySpec>> = {
  return:  { vk: 0x0D, scan: 0x1C, shift: false },
  tab:     { vk: 0x09, scan: 0x0F, shift: false },
  space:   { vk: 0x20, scan: 0x39, shift: false },
  delete:  { vk: 0x2E, scan: 0x53, shift: false, extended: true },
  backspace: { vk: 0x08, scan: 0x0E, shift: false },
  escape:  { vk: 0x1B, scan: 0x01, shift: false },
  left:    { vk: 0x25, scan: 0x4B, shift: false, extended: true },
  right:   { vk: 0x27, scan: 0x4D, shift: false, extended: true },
  up:      { vk: 0x26, scan: 0x48, shift: false, extended: true },
  down:    { vk: 0x28, scan: 0x50, shift: false, extended: true },
  home:    { vk: 0x24, scan: 0x47, shift: false, extended: true },
  end:     { vk: 0x23, scan: 0x4F, shift: false, extended: true },
  pageup:  { vk: 0x21, scan: 0x49, shift: false, extended: true },
  pagedown: { vk: 0x22, scan: 0x51, shift: false, extended: true },
  win:     { vk: 0x5B, scan: 0x5B, shift: false, extended: true }, // left Windows key
  // The backend's macOS key contract uses "cmd"; Windows tasks speak "win"
  // (see the loop's Windows instructions). Accept both on the wire.
  cmd:     { vk: 0x5B, scan: 0x5B, shift: false, extended: true },
  // macOS-only modifiers mapped to their Windows analogues (harmless when a
  // task text slips through): option → alt, cmd → win.
  option:  { vk: 0x12, scan: 0x38, shift: false },
  alt:     { vk: 0x12, scan: 0x38, shift: false },
  ctrl:    { vk: 0x11, scan: 0x1D, shift: false },
  shift:   { vk: 0x10, scan: 0x2A, shift: false },
  f1:  { vk: 0x70, scan: 0x3B, shift: false }, f2:  { vk: 0x71, scan: 0x3C, shift: false },
  f3:  { vk: 0x72, scan: 0x3D, shift: false }, f4:  { vk: 0x73, scan: 0x3E, shift: false },
  f5:  { vk: 0x74, scan: 0x3F, shift: false }, f6:  { vk: 0x75, scan: 0x40, shift: false },
  f7:  { vk: 0x76, scan: 0x41, shift: false }, f8:  { vk: 0x77, scan: 0x42, shift: false },
  f9:  { vk: 0x78, scan: 0x43, shift: false }, f10: { vk: 0x79, scan: 0x44, shift: false },
  f11: { vk: 0x7A, scan: 0x57, shift: false }, f12: { vk: 0x7B, scan: 0x58, shift: false },
};

/** Modifier names accepted on the wire → their key spec. */
export const MODIFIER_SPECS: Readonly<Record<string, WinKeySpec>> = {
  ctrl: NAMED_KEYS.ctrl,
  alt: NAMED_KEYS.alt,
  option: NAMED_KEYS.alt,
  shift: NAMED_KEYS.shift,
  win: NAMED_KEYS.win,
  cmd: NAMED_KEYS.win,
  meta: NAMED_KEYS.win,
};

/** Resolve a single-character key ("c") or a named key ("return"). */
export function resolveKey(name: string): WinKeySpec | undefined {
  if (name.length === 1) return CHAR_SPECS[name];
  return NAMED_KEYS[name.toLowerCase()];
}

/** Resolve a modifier by name (case-insensitive, mac aliases included). */
export function resolveModifier(name: string): WinKeySpec | undefined {
  return MODIFIER_SPECS[name.toLowerCase()];
}

// ── Typing planner (the SendInput contract) ──────────────────────────────────

/** One executable typing step for the FFI layer.
 *  { k:'key', spec } = press spec (with shift per spec.shift);
 *  { k:'unicode', ch } = SendInput KEYEVENTF_UNICODE fallback for chars
 *  outside the printable US-ASCII set (the macOS UnicodeString analogue). */
export type TypeStep =
  | { k: 'key'; spec: WinKeySpec }
  | { k: 'unicode'; ch: string };

/** Plan the keystrokes for a string: every printable US-ASCII char maps to a
 *  REAL VK + scan code (never keycode-0 + hope — the macOS cbaf3e08 lesson);
 *  anything else rides the KEYEVENTF_UNICODE fallback as one intact code
 *  point (iterated by code point, so astral-plane chars never split). */
export function typeStepsFor(text: string): TypeStep[] {
  const steps: TypeStep[] = [];
  for (const ch of text) {
    const spec = CHAR_SPECS[ch];
    if (spec) steps.push({ k: 'key', spec });
    else steps.push({ k: 'unicode', ch });
  }
  return steps;
}

/** Exported for tests: the resolved char → spec table. */
export function keySpecFor(ch: string): WinKeySpec | undefined {
  return CHAR_SPECS[ch];
}

/** UTF-16 code units for the KEYEVENTF_UNICODE fallback. SendInput's wScan
 *  field is 16-bit and carries ONE UTF-16 code unit per event — an
 *  astral-plane char (emoji, U+1F600) must be injected as its SURROGATE PAIR
 *  (two events: high then low), never a truncated code point: writing
 *  codePointAt(0) through a 16-bit field yields 0xF600 — private-use
 *  garbage the app renders as a wrong character. Pure — pinned by the
 *  Linux suite. */
export function unicodeUnits(ch: string): number[] {
  const units: number[] = [];
  for (let i = 0; i < ch.length; i++) units.push(ch.charCodeAt(i));
  return units;
}

// ── Geometry reconciliation (the 4e4d56ff contract, DPI edition) ────────────

export interface ScreenGeometry {
  /** Physical pixel size of the captured region (what SendInput coordinates
   *  use — Windows mouse coordinates are PHYSICAL pixels, unlike macOS points).
   *  W1: the VIRTUAL SCREEN size when the surface reports full-desktop
   *  geometry (multi-monitor); the primary monitor size otherwise. */
  screenWidth: number;
  screenHeight: number;
  /** Pixel dims of the most recent screenshot image (downscaled for the model). */
  imageWidth: number;
  imageHeight: number;
  /** Virtual-screen origin (W1, multi-monitor): physical px of the bounding
   *  box's top-left, NEGATIVE when a monitor sits left-of/above the primary.
   *  Optional + defaulted so single-monitor callers (and the W0 tests) are
   *  unchanged. */
  vx?: number;
  vy?: number;
  /** Set when the surface EXPOSES geometry() but the origin could not be
   *  verified (probe failed/threw, degenerate snapshot, or a snapshot whose
   *  size disagrees with the capture — topology changed mid-shot). On a
   *  multi-monitor desktop with a left/above secondary, an unverified origin
   *  maps every click onto the WRONG monitor — and moveToVerified cannot
   *  catch it (it verifies the injected coordinates, not the semantic
   *  target). Coordinate actions then REFUSE (verify-or-refuse, PR #1048
   *  review N1). Absent on surfaces that do not expose geometry() at all —
   *  those map origin (0,0) by the seam's documented single-monitor
   *  contract. */
  originUnknown?: string;
}

/** Convert image-pixel coordinates (the model's space) to physical screen
 *  pixels (SendInput's space). REFUSES when the aspect ratios disagree beyond
 *  rounding — a wrong-scale click lands at wrong coordinates (the macOS
 *  wrong-display lesson; on Windows the analogous trap is per-monitor DPI
 *  scaling, e.g. a 150% monitor whose GDI capture reports virtualized px).
 *
 *  Multi-monitor (W1): the capture covers the ENTIRE virtual screen, so the
 *  mapping is a linear proportion across the same bounding box — per-monitor
 *  DPI affects only WHERE each monitor sits inside the box (already reflected
 *  in the reported rects), never this conversion. The optional vx/vy origin
 *  offsets the result into virtual-screen space (moveTo normalizes it away
 *  with MOUSEEVENTF_ABSOLUTE|VIRTUALDESK). */
export function imageToScreen(
  x: number,
  y: number,
  g: ScreenGeometry,
): { x: number; y: number } | { error: string } {
  if (!g.imageWidth || !g.imageHeight || !g.screenWidth || !g.screenHeight) {
    return { error: 'geometry unavailable — no screenshot or monitor size yet; take a screenshot first' };
  }
  // Origin-unverified (the surface exposes geometry() but it failed): a
  // multi-monitor desktop with a left/above secondary would place every click
  // on the WRONG monitor at origin (0,0), and the injected coordinates would
  // still verify — refusing is strictly better than a confident wrong click
  // (PR #1048 review N1; the macOS geometryMismatch contract, origin edition).
  if (g.originUnknown) {
    return {
      error: `virtual-screen origin unverified (${g.originUnknown}) — refusing to map coordinates onto a possibly-wrong monitor; retake the screenshot`,
    };
  }
  const aspectImage = g.imageWidth / g.imageHeight;
  const aspectScreen = g.screenWidth / g.screenHeight;
  const drift = Math.abs(aspectImage - aspectScreen) / aspectScreen;
  if (drift > 0.02) {
    return {
      error: `geometry mismatch — screenshot ${g.imageWidth}x${g.imageHeight} (aspect ${aspectImage.toFixed(3)}) vs monitor ${g.screenWidth}x${g.screenHeight} (aspect ${aspectScreen.toFixed(3)}): refusing to click rather than land at wrong coordinates (per-monitor DPI scaling suspected; retake the screenshot)`,
    };
  }
  const sx = Math.round((x / g.imageWidth) * g.screenWidth);
  const sy = Math.round((y / g.imageHeight) * g.screenHeight);
  if (sx < 0 || sy < 0 || sx >= g.screenWidth || sy >= g.screenHeight) {
    return { error: `coordinates (${x},${y}) map outside the monitor (${sx},${sy} of ${g.screenWidth}x${g.screenHeight})` };
  }
  const vx = g.vx || 0;
  const vy = g.vy || 0;
  return { x: sx + vx, y: sy + vy };
}

// ── Virtual-screen geometry (W1: mixed-DPI multi-monitor) ────────────────────

/** Per-monitor physical-pixel geometry + DPI, as the FFI layer reports it.
 *  Coordinates are VIRTUAL-SCREEN space: the bounding box of all monitors
 *  (origin SM_XVIRTUALSCREEN/SM_YVIRTUALSCREEN, size SM_CXVIRTUALSCREEN/
 *  SM_CYVIRTUALSCREEN). SendInput MOUSEEVENTF_ABSOLUTE operates on this space
 *  scaled to 0..65535, so a click at virtual (vx, vy) reaches the right
 *  monitor regardless of DPI. */
export interface MonitorRect {
  /** Virtual-screen origin of this monitor (physical px, may be negative). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** DPI (96 = 100%). Used to identify scaling factor, not to convert coords. */
  dpi: number;
}

export interface VirtualScreenGeometry {
  /** Virtual-screen origin + size (GetSystemMetrics SM_*VIRTUALSCREEN). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Per-monitor rects (EnumDisplayMonitors / GetMonitorInfoW). */
  monitors: MonitorRect[];
}

/** Pure validation + normalization of a geometry snapshot. A geometry with
 *  zero/degenerate monitors is refused — capture AND clicks need it. */
export function validateGeometry(g: Partial<VirtualScreenGeometry> | null | undefined): VirtualScreenGeometry | { error: string } {
  if (!g || typeof g !== 'object') return { error: 'no virtual-screen geometry available' };
  const x = Number(g.x ?? 0);
  const y = Number(g.y ?? 0);
  const width = Number((g as Partial<VirtualScreenGeometry>).width);
  const height = Number((g as Partial<VirtualScreenGeometry>).height);
  const monitors = (g as Partial<VirtualScreenGeometry>).monitors;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: `invalid virtual-screen origin (${g.x},${g.y})` };
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { error: `invalid virtual-screen size ${g.width}x${g.height}` };
  }
  if (!Array.isArray(monitors) || monitors.length === 0) {
    return { error: 'no monitors reported — cannot reconcile geometry' };
  }
  for (const m of monitors) {
    if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y) || !Number.isFinite(m.width) || !Number.isFinite(m.height) || m.width <= 0 || m.height <= 0) {
      return { error: `invalid monitor rect ${JSON.stringify(m)}` };
    }
    if (!Number.isFinite(m.dpi) || m.dpi < 24 || m.dpi > 960) {
      return { error: `monitor DPI out of range (${m?.dpi}) at (${m?.x},${m?.y}) — refusing to guess` };
    }
  }
  return { x, y, width, height, monitors } as VirtualScreenGeometry;
}

/** Image-pixel → virtual-screen physical-pixel conversion (the model's space
 *  → SendInput's space). PURE — unit-tested on Linux with mixed-DPI cases.
 *
 *  The model sees a downscaled JPEG of the ENTIRE virtual screen (all
 *  monitors composited). Its (x, y) is in image pixels; the target is a
 *  physical pixel in virtual-screen space. Because both spaces are the same
 *  bounding box, the mapping is linear proportion — per-monitor DPI affects
 *  only WHERE each monitor sits inside the box (already reflected in the
 *  rects), never the conversion. The reconciliation step (below) checks the
 *  image's aspect against the virtual screen's aspect; a drift beyond
 *  GEOMETRY_DRIFT_LIMIT means the capture and the reported geometry disagree
 *  (e.g. GDI virtualization on a per-monitor-DPI setup) — clicks then REFUSE
 *  rather than land at wrong coordinates (the 4e4d56ff verify-or-refuse
 *  doctrine, DPI edition). */
export const GEOMETRY_DRIFT_LIMIT = 0.02;

/** The monitor a virtual-screen point falls on (null when between monitors —
 *  possible: the bounding box can cover gaps). */
export function monitorAt(g: VirtualScreenGeometry, vx: number, vy: number): MonitorRect | null {
  for (const m of g.monitors) {
    if (vx >= m.x && vx < m.x + m.width && vy >= m.y && vy < m.y + m.height) return m;
  }
  return null;
}

// ── The platform seam ────────────────────────────────────────────────────────

/** What the platform layer must expose (W3: the Rust helper client is the
 *  seam implementation). The pure logic in this file NEVER touches Win32
 *  directly. */
export interface Win32Surface {
  /** Physical-pixel size of the captured region (W1: the VIRTUAL SCREEN —
   *  the bounding box of all monitors). */
  monitorSize(): Promise<{ width: number; height: number }>;
  /** Capture the primary monitor → JPEG base64 (≤ maxDim long edge, quality 75 —
   *  the macOS screenshot contract). */
  captureJpeg(maxDim: number, quality: number): Promise<{ base64: string; width: number; height: number }>;
  /** Frontmost window's app + title (GetForegroundWindow/GetWindowText). */
  frontmost(): Promise<{ app: string; window: string } | null>;
  /** Full virtual-screen geometry incl. per-monitor rects + DPI (W1,
   *  multi-monitor). Optional: absent on surfaces that only know the primary
   *  monitor — clicks then map without the virtual origin. */
  geometry?(): Promise<VirtualScreenGeometry | null>;
}

/** Input injection (SendInput). All coordinates are PHYSICAL pixels. */
export interface Win32Input {
  /** Read the cursor position (GetCursorPos). */
  cursorPos(): Promise<{ x: number; y: number } | null>;
  /** Move the pointer (SendInput MOUSEEVENTF_MOVE|ABSOLUTE). */
  moveTo(x: number, y: number): Promise<void>;
  /** Mouse down/up (left or right). */
  mouseDown(button: 'left' | 'right'): Promise<void>;
  mouseUp(button: 'left' | 'right'): Promise<void>;
  /** Vertical wheel scroll (positive = up). */
  scroll(amount: number): Promise<void>;
  /** Press a key spec (respecting spec.shift/extended). */
  keyDown(spec: WinKeySpec): Promise<void>;
  keyUp(spec: WinKeySpec): Promise<void>;
  /** KEYEVENTF_UNICODE event (the non-ASCII fallback). */
  unicodeChar(ch: string): Promise<void>;
  /** Release every modifier (the pre-sweep before every planned input —
   *  stuck modifiers corrupt every later event). */
  clearModifiers(): Promise<void>;
  /** Open an app by name (Win-key search) or a URL (ShellExecute). */
  open(target: string): Promise<void>;
}

/** The null implementation: refuses with a clear, actionable error so the
 *  run loop reports "not available" instead of crashing. The Rust helper
 *  client implements this for real — nothing above the seam changes. */
export class NullWin32Surface implements Win32Surface {
  async monitorSize(): Promise<{ width: number; height: number }> {
    throw new Error('monitorSize unavailable — the Rust helper layer is not loaded (helper binary missing: reinstall the agent bundle or set DIGBY_WIN_HELPER)');
  }
  async captureJpeg(): Promise<{ base64: string; width: number; height: number }> {
    throw new Error('screen capture unavailable — the Rust helper layer is not loaded (helper binary missing: reinstall the agent bundle or set DIGBY_WIN_HELPER)');
  }
  async frontmost(): Promise<{ app: string; window: string } | null> {
    return null;
  }
}

export class NullWin32Input implements Win32Input {
  async cursorPos(): Promise<{ x: number; y: number } | null> { return null; }
  async moveTo(): Promise<void> { throw new Error('mouse input unavailable — the Rust helper layer is not loaded (helper binary missing: reinstall the agent bundle or set DIGBY_WIN_HELPER)'); }
  async mouseDown(): Promise<void> { throw new Error('mouse input unavailable — the Rust helper layer is not loaded (helper binary missing: reinstall the agent bundle or set DIGBY_WIN_HELPER)'); }
  async mouseUp(): Promise<void> { throw new Error('mouse input unavailable — the Rust helper layer is not loaded (helper binary missing: reinstall the agent bundle or set DIGBY_WIN_HELPER)'); }
  async scroll(): Promise<void> { throw new Error('scroll unavailable — the Rust helper layer is not loaded (helper binary missing: reinstall the agent bundle or set DIGBY_WIN_HELPER)'); }
  async keyDown(): Promise<void> { throw new Error('keyboard input unavailable — the Rust helper layer is not loaded (helper binary missing: reinstall the agent bundle or set DIGBY_WIN_HELPER)'); }
  async keyUp(): Promise<void> { throw new Error('keyboard input unavailable — the Rust helper layer is not loaded (helper binary missing: reinstall the agent bundle or set DIGBY_WIN_HELPER)'); }
  async unicodeChar(): Promise<void> { throw new Error('keyboard input unavailable — the Rust helper layer is not loaded (helper binary missing: reinstall the agent bundle or set DIGBY_WIN_HELPER)'); }
  async clearModifiers(): Promise<void> { /* nothing to clear in the null impl */ }
  async open(): Promise<void> { throw new Error('open unavailable — the Rust helper layer is not loaded (helper binary missing: reinstall the agent bundle or set DIGBY_WIN_HELPER)'); }
}
