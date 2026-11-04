/**
 * Local computer use for the Digby Mac agent (v0.3.0+).
 *
 * Lets Digby SEE the user's screen and DRIVE it — screenshots, mouse clicks,
 * text typing, key presses, scrolling, opening apps — over the same long-poll
 * channel as the iMessage bridge. The backend's computer-agent module dispatches
 * `computer_<action>` commands here; each method returns an Observation-shaped
 * object and NEVER throws into the agent run loop (stability over strictness —
 * a failed action is a result, not a crash).
 *
 * macOS permissions (one-time grants, attributed to the DigbyHelper binary):
 *   - Screen Recording  — required for screencapture to include window content
 *   - Accessibility     — required for CGEvent mouse/keyboard control
 * The first computer_* command preflights both; when missing, the user gets a
 * native guidance dialog (same pattern as the Full Disk Access flow) and the
 * command returns a structured, actionable error.
 *
 * Permission advertising (v0.6.0, ticket 2f646c10): preflightPermissions() is
 * the single JXA preflight seam — permissions.ts reuses it for the every-poll
 * {ax, sr} advert, and each verified-input result feeds the dead-input latch
 * via noteMoveResult() (see permissions.ts for the relaunch semantics).
 *
 * Coordinate contract: the model clicks in IMAGE-PIXEL space of the last
 * screenshot (which is downscaled for the vision model). The agent caches the
 * screenshot's dims + the display's point size and converts to global Core
 * Graphics points itself — the model never worries about Retina scaling.
 *
 * Typing contract (v0.4.2, ticket cbaf3e08): text is typed as REAL keycode
 * events planned by computer-keymap.ts (US-ANSI map + shift flags) — never by
 * creating every event with keycode 0 and overriding via
 * CGEventKeyboardSetUnicodeString, which silently no-ops under macOS 26's JXA
 * bridging and garbled all text to 'a' runs. UnicodeString survives only as a
 * best-effort fallback for chars outside the printable US-ASCII set.
 *
 * Input-integrity contract (v0.4.3, ticket 4e4d56ff): after the 2026-09-09
 * incident (actions reporting success while input landed at wrong coordinates
 * or nowhere), input is VERIFY-OR-REFUSE:
 *   - clicks move the pointer, read the cursor back, retry once, and REFUSE
 *     to click blind when the pointer verifiably did not arrive;
 *   - scroll accepts an optional x/y target — the pointer is moved+verified
 *     there before the wheel event, so scrolls hit the content the model
 *     pointed at rather than whatever sits under the stale cursor;
 *   - the display's point size is cross-checked (CGDisplayBounds vs NSScreen
 *     vs the screenshot's aspect ratio); on an unreconciled mismatch,
 *     clicks/targeted scrolls are refused instead of being scaled with a
 *     wrong point size (wrong display → wrong coordinates).
 *
 * Multi-display capture (v0.6.1, cu-diag 2026-09-25 fix #1): the screenshot
 * captures the display that OWNS the frontmost window (then the pointer's
 * display, then main) instead of always `-D 1`, verifies the captured PNG's
 * pixel size against the display list, stamps display geometry + the
 * frontmost window's display on every result, and translates clicks through
 * the CAPTURED display's CG bounds. `DIGBY_CAPTURE_DISPLAY=main` restores the
 * pre-0.6.1 always-main capture. Every result also carries owner-presence
 * facts (fix #6): hidIdleSeconds (excluding this agent's own events) and a
 * remote-session hint (Screen Sharing / TeamViewer).
 *
 * v0.6.2 (cu-diag 2026-09-25 review of 0.6.1): the PNG pixel check is now
 * REAL — the JXA `displays` action emits the backing pixel size as numbers
 * (CGDisplayModeGetPixelWidth/High; the bridge returns strings and
 * CGDisplayPixelsWide is point-sized on HiDPI, so 0.6.1's check never
 * matched), the TS side Number()-coerces every topology field
 * (normalizeTopology) and also accepts a point size at an integer scale
 * (attributeCapturedDisplay). Identical panels that share a size are
 * reported as ambiguous, never re-attributed by guess. The System Events
 * frontmost-window probe is a SEPARATE parallel osascript (`front_window`,
 * 5 s) so an Automation stall cannot take the display list with it.
 * Agent-side kill switches: DIGBY_CAPTURE_PIXEL_CHECK=off (trust the -D
 * index; aspect reconciliation only), DIGBY_FRONT_WINDOW_PROBE=off (no
 * System Events probe; capture = pointer → main),
 * DIGBY_REMOTE_SESSION_IGNORE=<kinds|all> (drop remote-session kinds such
 * as `virtual_display` / `teamviewer_desktop` from the presence hint).
 */

import { execFile } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename } from 'path';
import { inflateSync } from 'zlib';
import { typeStepsFor, charKeyTableJson, modifierKeyTableJson, modifierFlagTableJson, ALL_MODIFIER_KEYCODES } from './computer-keymap';
import { noteMoveResult } from './permissions';

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [computer] ${msg}`);
}

export interface Observation {
  ok: boolean;
  /** base64 JPEG of the (downscaled) screen — screenshot action only */
  screenshotBase64?: string;
  /** pixel dims of the returned screenshot image */
  imageWidth?: number;
  imageHeight?: number;
  /** main display size in Core Graphics POINTS (what CGEvent coordinates use) */
  screenWidth?: number;
  screenHeight?: number;
  /** Set when the display's point size could not be reconciled with the
   *  screenshot's aspect ratio (v0.4.3, ticket 4e4d56ff) — clicks/scoll-xy are
   *  REFUSED while this is set (guessing would land at wrong coordinates). */
  geometryWarning?: string;
  frontmostApp?: string;
  frontmostWindow?: string;
  /** v0.6.1 (multi-display capture, cu-diag fix #1): which display the frame
   *  came from. `displayId` is the CGDirectDisplayID that was captured,
   *  `displayIndex` the 1-based `screencapture -D` index used, `displayCount`
   *  how many displays are active. `frontmostWindowDisplayId` is the display
   *  that owns the frontmost window (null when unknown) — when it differs from
   *  `displayId` the backend tells the model its focus is OFF-CAMERA instead
   *  of grading the unchanged frame as dead input. `captureReason` says why
   *  this display was chosen ('frontmost' | 'pointer' | 'main' | 'override'
   *  | 'legacy'). Older agents omit every one of these. */
  displayId?: number;
  displayIndex?: number;
  displayCount?: number;
  displayName?: string;
  frontmostWindowDisplayId?: number | null;
  pointerDisplayId?: number | null;
  captureReason?: string;
  /** v0.6.1 (cu-diag fix #6): seconds since the last HID input NOT generated
   *  by this agent (its own CGEvent posts are excluded via the own-input
   *  ledger). null = unknown (the last HID event was ours and no human event
   *  has been observed yet in this process). `hidIdleRawSeconds` is the OS
   *  reading INCLUDING our own events. */
  hidIdleSeconds?: number | null;
  hidIdleRawSeconds?: number | null;
  /** v0.6.1: a remote-control session appears to be attached (macOS Screen
   *  Sharing virtual display / screensharingd, TeamViewer desktop). */
  remoteSession?: { active: boolean; kinds: string[] };
  /** Ticket 746c4d4f: the GLOBAL modifier flags that were held DOWN at the
   *  instant before this action swept them (cmd/opt/ctrl bits). Non-zero means
   *  the action would have been corrupted by an inherited modifier — a left
   *  click arriving as a right-click, a chord eaten by another app, a wheel
   *  arriving as a zoom. It is the device-side proof of a corrupted event,
   *  reported whether or not the sweep rescued it. Absent from older agents. */
  clearedModifiers?: number;
  error?: string;
}

const SCREENSHOT_MAX_DIM = 1568;
const JPEG_QUALITY = 75;
const OSASCRIPT_TIMEOUT_MS = 15000;
/** Re-preflight permissions at most this often when they were GRANTED (the
 *  user can revoke mid-session; a stale "granted" cache is fixed by the next
 *  action error, which forces a recheck). */
const PERMISSION_CACHE_MS = 5 * 60_000;

// ── osascript runner ──────────────────────────────────────────────────────────

function runJxa(script: string, args: string[], timeoutMs = OSASCRIPT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script, '--', ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}${stderr ? ` — ${String(stderr).slice(-300)}` : ''}`));
        resolve(String(stdout || '').trim());
      },
    );
  });
}

/**
 * JXA action runner — mouse / keyboard / scroll / screen-info via raw CGEvent.
 * All CGEvent enum values are defined MANUALLY (BridgeSupport doesn't expose
 * them reliably to JXA). One script handles every action so the agent spawns
 * exactly one osascript per command.
 */
const JXA_RUNNER = `
function run(argv) {
  ObjC.import('Quartz');
  // macOS 26: Quartz's BridgeSupport no longer exposes CoreGraphics C functions
  // (CGMainDisplayID/CGEventPost/…) to JXA — AppKit's does. Without this import
  // every $ CG* symbol is undefined (verified on 26.6.2, 2026-08-31).
  ObjC.import('AppKit');
  var action = argv[0];
  var p = JSON.parse(argv[1] || '{}');

  // CGEvent constants (manually defined — do not rely on BridgeSupport enums)
  var TAP = 0;                       // kCGHIDEventTap
  var EV_L_DOWN = 1, EV_L_UP = 2;    // kCGEventLeftMouseDown/Up
  var EV_R_DOWN = 3, EV_R_UP = 4;    // kCGEventRightMouseDown/Up
  var EV_MOVED = 5;                  // kCGEventMouseMoved
  var BTN_LEFT = 0, BTN_RIGHT = 1;   // kCGMouseButtonLeft/Right
  var SCROLL_UNIT_LINE = 1;          // kCGScrollEventUnitLine
  var FIELD_CLICK_STATE = 23;        // kCGMouseEventClickState
  var FLAG_SHIFT = 131072, FLAG_CTRL = 262144, FLAG_OPT = 524288, FLAG_CMD = 1048576;
  // Single-char key table for the 'key' action (letters/digits/punct →
  // [keycode, needsShift]) — the computer_key contract advertises
  // key "c" + ["cmd"]; without this, Cmd+L/Cmd+N failed "unknown key: l"
  // (ticket cbaf3e08 attempt 2).
  var CHAR_KEYS = ${charKeyTableJson()};
  // Physical modifier keycodes — the ONLY events that move the WindowServer's
  // global modifier state (ticket 746c4d4f). Injected from computer-keymap.ts
  // (one source of truth, unit-tested in TS) instead of hand-typed literals.
  var MOD_KEYS = ${modifierKeyTableJson()};
  // …and the matching flag bits, injected from the same TS source.
  var MOD_FLAGS = ${modifierFlagTableJson()};
  var ALL_MOD_KEYS = ${JSON.stringify(ALL_MODIFIER_KEYCODES)};
  var FLAG_MASK_ALL = FLAG_SHIFT | FLAG_CTRL | FLAG_OPT | FLAG_CMD;

  function post(ev) { $.CGEventPost(TAP, ev); }
  function pt(x, y) { return $.CGPointMake(x, y); }
  function nap(ms) {
    var end = Date.now() + ms;
    while (Date.now() < end) { /* osascript JXA has no usleep — busy-wait (≤60ms) */ }
  }

  // ── Inherited-modifier hygiene (ticket 746c4d4f, agent 0.9.16) ─────────────
  // THE DEFECT: macOS resolves a LEFT mouse-down that carries the Control flag
  // as a SECONDARY (right) click. Modifier state is NOT per-event state — it is
  // the WindowServer's GLOBAL state, which this agent dirties every time it
  // posts a chord or leaves one latched. The 'type' action has swept the
  // modifiers before every character since 0.4.2, and its comment records the
  // law verbatim: "char keyups never clear it — only real modifier-KEY
  // transitions do". The CLICK and KEY paths never learned it, so:
  //   - one 'key' chord (the report's working route used Control+Up for Mission
  //     Control) left Control down, and EVERY later left-click arrived as a
  //     right-click → Discord's channel list opened Mark As Read / Add to
  //     Favorites / Invite / Pin / Copy Link / Mute instead of the channel;
  //   - a latched Control also makes a Dock click show the Dock menu instead of
  //     activating the app, which is the report's "cannot re-front" symptom;
  //   - and a chord posted as a FLAG on one keydown (with no modifier-key
  //     transition) is not a chord to the frontmost app — Cmd+K read as a bare
  //     'k' and was consumed by a menu-bar app (Finder) instead of Discord.
  // One root cause, all three reported symptoms. Swept at every input seam that
  // posts HID events: click, key, scroll (and type, since 0.4.2).
  /** The live global modifier flags; 0 when the bridge cannot say (fail-open). */
  function modifiersDown() {
    try {
      var f = $.CGEventSourceFlagsState(1); // kCGEventSourceStateHIDSystemState
      var n = Number(f);
      return isFinite(n) ? (n & FLAG_MASK_ALL) : 0;
    } catch (em) { return 0; }
  }
  /** Release every modifier for real (key-UP transitions) so no inherited flag
   *  can turn the next click into a secondary click or corrupt a chord.
   *  Returns the flags that were down BEFORE the sweep — diagnostic ground
   *  truth for "was this click corrupted?" without a device-side trace. */
  function clearModifiers() {
    var before = modifiersDown();
    for (var mk = 0; mk < ALL_MOD_KEYS.length; mk++) {
      post($.CGEventCreateKeyboardEvent($(), ALL_MOD_KEYS[mk], false));
    }
    if (before) nap(20); // let the released state settle before the real event
    return before;
  }

  if (action === 'screen_size') {
    // Return BOTH geometry sources (v0.4.3, ticket 4e4d56ff): CGDisplayBounds
    // (main display, what CGEvent coordinates use) AND NSScreen.mainScreen
    // (always bridged). The TS side cross-checks them against the screenshot's
    // aspect ratio — if they disagree (a bridging glitch, or a multi-display
    // setup where NSScreen's keyboard-focus display ≠ the captured display),
    // clicks must fail LOUD instead of landing at wrong coordinates.
    var cg = null, ns = null;
    try {
      var b = $.CGDisplayBounds($.CGMainDisplayID());
      cg = { width: b.size.width, height: b.size.height };
    } catch (e0) { /* CG C-fn bridging broke — NSScreen still speaks */ }
    try {
      var f = $.NSScreen.mainScreen.frame;
      ns = { width: f.size.width, height: f.size.height };
    } catch (e0b) { /* no NSScreen either — cg must carry */ }
    var out = cg || ns || { width: 0, height: 0 };
    return JSON.stringify({
      width: out.width, height: out.height,
      cgWidth: cg ? cg.width : 0, cgHeight: cg ? cg.height : 0,
      nsWidth: ns ? ns.width : 0, nsHeight: ns ? ns.height : 0,
    });
  }

  // v0.6.1 (multi-display capture, cu-diag fix #1): the WHOLE display topology
  // in one osascript spawn — every active display with its CG bounds (global
  // points, top-left origin = what CGEvent and System Events use), pixel size,
  // name; the main display id; the pointer location; the frontmost window's
  // frame; and the OS HID idle reading. The TS side picks the display that
  // OWNS the frontmost window (falling back to the pointer's display, then
  // main) and captures THAT one — the 2026-09-25 incident: a lid-closed
  // MacBook kept the built-in panel as CG-main while TextEdit opened on the
  // external Dell, so screencapture -D 1 returned the same frame forever
  // while every keystroke landed.
  if (action === 'displays') {
    var topo = { main: 0, displays: [], pointer: null, frontWindow: null, hidIdleRaw: null };
    try { topo.main = $.CGMainDisplayID(); } catch (ed0) { /* CG bridging — NSScreen still speaks */ }
    try {
      var screens = $.NSScreen.screens;
      var nScreens = screens.count;
      var primaryH = 0;
      try { primaryH = screens.objectAtIndex(0).frame.size.height; } catch (ed1) { /* no primary */ }
      for (var di = 0; di < nScreens; di++) {
        var sc = screens.objectAtIndex(di);
        var did = 0;
        try { did = Number(ObjC.unwrap(sc.deviceDescription.objectForKey('NSScreenNumber'))) || 0; } catch (ed2) { /* no id */ }
        var bounds = null;
        if (did) {
          try {
            var cb = $.CGDisplayBounds(did);
            bounds = { x: cb.origin.x, y: cb.origin.y, width: cb.size.width, height: cb.size.height };
          } catch (ed3) { /* CG bounds unreadable — flip the NSScreen frame below */ }
        }
        if (!bounds) {
          // Cocoa frames are bottom-left-origin; flip into CG (top-left) space.
          var fr = sc.frame;
          bounds = { x: fr.origin.x, y: primaryH - (fr.origin.y + fr.size.height), width: fr.size.width, height: fr.size.height };
        }
        // v0.6.2 (cu-diag 2026-09-25 review, blocking #1): the BACKING pixel
        // size as NUMBERS. Live-probed on a 3× DELL U2718Q Mac: the ObjC
        // bridge hands CGDisplayPixelsWide/High back as STRINGS ("2304") and
        // on HiDPI they equal the POINT size — so the TS pixel check compared
        // number to string, never matched, and the re-attribution safety net
        // was inert. CGDisplayModeGetPixelWidth/High on the current mode is
        // the real backing size ("4608" — also a string; Number() it), with
        // NSScreen.backingScaleFactor × point size as the fallback.
        var scale = 1;
        try { var sfv = Number(sc.backingScaleFactor); if (isFinite(sfv) && sfv > 0) scale = sfv; } catch (ed4a) { /* assume 1× */ }
        var pw = 0, ph = 0;
        try {
          var dmode = $.CGDisplayCopyDisplayMode(did);
          pw = Number($.CGDisplayModeGetPixelWidth(dmode)) || 0;
          ph = Number($.CGDisplayModeGetPixelHeight(dmode)) || 0;
        } catch (ed4) { /* no display mode — fall through */ }
        if (!(pw > 0 && ph > 0)) {
          try {
            // CGDisplayPixelsWide/High are point-sized on HiDPI — scale them.
            pw = Math.round((Number($.CGDisplayPixelsWide(did)) || 0) * scale);
            ph = Math.round((Number($.CGDisplayPixelsHigh(did)) || 0) * scale);
          } catch (ed4b) { pw = 0; ph = 0; /* pixel size unknown */ }
        }
        var dname = '';
        try { dname = String(ObjC.unwrap(sc.localizedName) || ''); } catch (ed5) { /* macOS < 10.15 */ }
        topo.displays.push({ id: did, index: di + 1, x: Number(bounds.x), y: Number(bounds.y), width: Number(bounds.width), height: Number(bounds.height), pixelWidth: pw, pixelHeight: ph, scale: scale, name: dname });
      }
    } catch (ed6) { /* no NSScreen — the caller falls back to the legacy single-display path */ }
    try {
      var ploc = $.CGEventGetLocation($.CGEventCreate($()));
      topo.pointer = { x: ploc.x, y: ploc.y };
    } catch (ed7) { /* pointer unknown */ }
    // v0.6.2: the System Events frontmost-window query lives in its OWN
    // action (front_window, below) — without Automation → System Events
    // that AppleEvent stalls for its 120 s default, and bundled here it took
    // the whole topology read (display list, pointer, HID idle) down with it
    // under the 10 s cap. The TS side runs both in parallel and merges.
    try {
      // kCGEventSourceStateHIDSystemState = 1, kCGAnyInputEventType = ~0.
      // Includes this agent's own posted events — the TS side subtracts them.
      var idle = $.CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF);
      if (typeof idle === 'number' && isFinite(idle)) topo.hidIdleRaw = idle;
    } catch (ed10) { /* the TS side falls back to ioreg HIDIdleTime */ }
    return JSON.stringify(topo);
  }

  // v0.6.2: the frontmost window's frame (System Events / Accessibility) —
  // split out of the displays action so an Automation stall costs only this probe
  // (capped separately; the capture then falls back to pointer → main).
  if (action === 'front_window') {
    try {
      var sed = Application('System Events');
      var frontP = sed.processes.whose({ frontmost: true })[0];
      var fw = { app: frontP.name(), window: '' };
      try {
        var w0 = frontP.windows[0];
        fw.window = w0.name() || '';
        var wpos = w0.position(), wsz = w0.size();
        fw.x = Number(wpos[0]); fw.y = Number(wpos[1]); fw.w = Number(wsz[0]); fw.h = Number(wsz[1]);
      } catch (ed8) { /* no window (menu-bar app, desktop) */ }
      return JSON.stringify(fw);
    } catch (ed9) {
      return JSON.stringify({ app: '', window: '', error: String(ed9) });
    }
  }

  if (action === 'preflight') {
    var screen = false, ax = false;
    try { screen = !!$.CGPreflightScreenCaptureAccess(); } catch (e) { screen = true; } // unknown → let screencapture speak
    try { ObjC.import('ApplicationServices'); ax = !!$.AXIsProcessTrusted(); } catch (e2) { ax = true; }
    return JSON.stringify({ screen: screen, accessibility: ax });
  }

  // 30d3c366: Input Monitoring (TCC service kTCCServiceListenEvent) status.
  // CGPreflightListenEventAccess is the NON-REQUESTING query — it never raises
  // the consent sheet, so it is safe on the every-poll advert path. A bridge
  // that cannot see the symbol reports UNKNOWN (null), never a fabricated
  // grant loss: the same unknown-never-convicts rule the Calendars status
  // query obeys (c44b19e9).
  if (action === 'preflight_im') {
    try {
      ObjC.import('AppKit');
      var imNow = $.CGPreflightListenEventAccess();
      return JSON.stringify({ inputMonitoring: !!imNow });
    } catch (eim) {
      return JSON.stringify({ inputMonitoring: null, error: String(eim) });
    }
  }

  // 30d3c366: Input Monitoring native prompt (CGRequestListenEventAccess).
  // This is the macOS consent sheet the owner asked for — "why doesn't it
  // request that for you automatically on new digby install". It is the
  // REQUESTING API, so it fires ONLY from first-launch onboarding (the one
  // place the 0.9.8 rule permits a requesting probe — same class as
  // request_ax below), never from the status poll.
  if (action === 'request_im') {
    try {
      ObjC.import('AppKit');
      var imGranted = $.CGRequestListenEventAccess();
      return JSON.stringify({ inputMonitoring: !!imGranted, prompted: true });
    } catch (eim2) {
      return JSON.stringify({ inputMonitoring: false, prompted: false, error: String(eim2) });
    }
  }

  if (action === 'request_ax') {
    // v0.6.3 first-launch onboarding: the NATIVE Accessibility prompt. macOS
    // shows "DigbyHelper would like to control this computer using
    // accessibility features" with an Open System Settings button and
    // PRE-LISTS the helper in the Accessibility pane — the user flips one
    // switch instead of dragging the binary in. The prompt is asynchronous
    // system UI; the return value is the grant state at call time.
    var axNow = false;
    try {
      ObjC.import('ApplicationServices');
      axNow = !!$.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
    } catch (e5) {
      return JSON.stringify({ accessibility: false, prompted: false, error: String(e5) });
    }
    return JSON.stringify({ accessibility: axNow, prompted: true });
  }

  if (action === 'frontmost') {
    try {
      var se = Application('System Events');
      var front = se.processes.whose({ frontmost: true })[0];
      var appName = front.name();
      var winName = '';
      try { winName = front.windows[0].name(); } catch (e3) { /* no window */ }
      return JSON.stringify({ app: appName, window: winName || '' });
    } catch (e4) {
      return JSON.stringify({ app: '', window: '', error: String(e4) });
    }
  }

  // v0.4.3 (ticket 4e4d56ff): post an absolute mouse-move and VERIFY the cursor
  // actually arrived (read-back via CGEventGetLocation of a fresh event — the
  // standard current-cursor-position idiom). One retry, then give up: callers
  // must NOT click/scroll at coordinates the OS demonstrably did not move to
  // (the 2026-09-09 incident: actions reported success while the pointer was
  // somewhere else entirely). Returns null when verification is impossible
  // (bridging hiccup) — callers then proceed unverified rather than break.
  function moveAndVerify(x, y) {
    for (var attempt = 0; attempt < 2; attempt++) {
      post($.CGEventCreateMouseEvent($(), EV_MOVED, pt(x, y), BTN_LEFT));
      nap(30);
      try {
        var loc = $.CGEventGetLocation($.CGEventCreate($()));
        var cx = loc.x, cy = loc.y;
        if (Math.abs(cx - x) <= 4 && Math.abs(cy - y) <= 4) return { x: cx, y: cy, verified: true };
      } catch (emv) {
        return null; // read-back itself failed — unverifiable, not a mis-land
      }
    }
    try {
      var loc2 = $.CGEventGetLocation($.CGEventCreate($()));
      return { x: loc2.x, y: loc2.y, verified: false };
    } catch (emv2) {
      return null;
    }
  }

  if (action === 'click') {
    var x = p.x, y = p.y;
    var right = p.button === 'right';
    var clicks = p.clicks === 2 ? 2 : 1;
    var downT = right ? EV_R_DOWN : EV_L_DOWN, upT = right ? EV_R_UP : EV_L_UP;
    var btn = right ? BTN_RIGHT : BTN_LEFT;
    // 746c4d4f: unhook any inherited modifier BEFORE the move+click. A latched
    // Control makes this left mouse-down resolve as a SECONDARY click (macOS's
    // ctrl-click), which is exactly the reported "every channel click opens a
    // context menu"; a latched Control also turns a Dock click into the Dock's
    // menu instead of activating the app. The flags read back BEFORE the sweep
    // are the diagnostic proof of a corrupted click.
    var inherited = clearModifiers();
    var mv = moveAndVerify(x, y);
    if (mv && !mv.verified) {
      // The pointer verifiably did NOT land on target — refuse to click blind
      // (a click at the wrong spot is strictly worse than a loud error the
      // loop can react to). misland:true is the structured dead-input signal
      // the node side feeds into the 2f646c10 latch — an error alone is NOT
      // (guard/geometry/permission errors carry no move-verification fact).
      return JSON.stringify({ misland: true, error: 'cursor did not reach click target — wanted (' + x + ',' + y + ') but the pointer is at (' + Math.round(mv.x) + ',' + Math.round(mv.y) + '); NOT clicking blind. Take a fresh screenshot and retry.' });
    }
    for (var i = 1; i <= clicks; i++) {
      var d = $.CGEventCreateMouseEvent($(), downT, pt(x, y), btn);
      var u = $.CGEventCreateMouseEvent($(), upT, pt(x, y), btn);
      if (i > 1) {
        $.CGEventSetIntegerValueField(d, FIELD_CLICK_STATE, i);
        $.CGEventSetIntegerValueField(u, FIELD_CLICK_STATE, i);
      }
      post(d); nap(40); post(u);
      if (i < clicks) nap(60);
    }
    return JSON.stringify({ clicked: [x, y], button: p.button || 'left', clicks: clicks, cursor: mv ? [Math.round(mv.x), Math.round(mv.y)] : null, cursorVerified: mv ? !!mv.verified : false, clearedModifiers: inherited });
  }

  if (action === 'scroll') {
    // Positive wheel = scroll UP (content moves down); lines map ~3px each per unit here.
    // 746c4d4f: scroll is the THIRD input seam and it needs the same unhook —
    // a latched ctrl/opt turns a wheel event into a ZOOM in most macOS apps
    // (cmd+wheel) or a horizontal scroll (shift+wheel), i.e. the same silent
    // wrong-event class as the click defect, just with a different symptom.
    var sInherited = clearModifiers();
    // v0.4.3 (ticket 4e4d56ff): optional x/y — the pointer is moved there FIRST
    // (and verified), so the scroll affects the content the model actually
    // pointed at instead of whatever happens to sit under the stale cursor.
    if (typeof p.x === 'number' && typeof p.y === 'number') {
      var smv = moveAndVerify(p.x, p.y);
      if (smv && !smv.verified) {
        return JSON.stringify({ misland: true, error: 'cursor did not reach scroll target — wanted (' + p.x + ',' + p.y + ') but the pointer is at (' + Math.round(smv.x) + ',' + Math.round(smv.y) + '); NOT scrolling blind. Take a fresh screenshot and retry.' });
      }
    }
    var lines = (p.direction === 'up' ? 1 : -1) * (p.amount || 10);
    var sv = $.CGEventCreateScrollWheelEvent($(), SCROLL_UNIT_LINE, 1, lines);
    post(sv);
    // cursorVerified mirrors click's contract: true only when the landing was
    // verifiably confirmed; null when the read-back was unavailable (smv
    // null) or the scroll was untargeted (no move happened at all). It is
    // NEVER false here — a verifiable mis-land returned early as an error.
    return JSON.stringify({ scrolled: p.direction || 'down', amount: p.amount || 10, targeted: typeof p.x === 'number', cursorVerified: smv ? !!smv.verified : null, clearedModifiers: sInherited });
  }

  if (action === 'type') {
    // v0.4.2 (ticket cbaf3e08): execute a PRE-PLANNED step list from the agent
    // (computer-keymap.ts typeStepsFor). Keycode steps post real key events —
    // the pre-0.4.2 design created every keystroke with keycode 0 and relied
    // on CGEventKeyboardSetUnicodeString, which silently no-ops under macOS 26's
    // AppKit bridging, so every character fell back to keycode 0 = 'a' and
    // typed text became a run of a's. The UnicodeString call survives ONLY as
    // a best-effort fallback for chars outside the US-ANSI printable set.
    var steps = p.steps || [];
    var nKey = 0, nFallback = 0;
    // Pre-type modifier sweep. Live-E2E findings (2026-09-09, macOS 26.6.2):
    //  (1) an INHERITED stuck modifier renders every char modified
    //      ("probe-123-…" → "PROBE_!@#_…"); char keyups never clear it —
    //      only real modifier-KEY transitions do.
    //  (2) with a CLEAN global modifier state, raw-keycode streams starting
    //      with unshifted chars lose the opening chars until the first
    //      modifier-state transition ("probe-123-XYZ…" → "XYZ…").
    //  (3) pressing cmd/opt/ctrl DOWN as a warm-up is UNSAFE — a char racing
    //      the press becomes a menu shortcut ('p' → Cmd+P opened a Print
    //      dialog live). So: UP-only releases for cmd/opt/ctrl (release any
    //      inherited hold without pressing), and the warm-up transition is
    //      SHIFT only (shift+char can never trigger a shortcut; an 8 ms
    //      down/up gap avoids coalescing; the 30 ms settle flushes before
    //      the first real char).
    var MOD_RELEASE = [54, 55, 58, 59, 61, 62]; // rcmd, lcmd, lopt, lctrl, ropt, rctrl
    for (var mi2 = 0; mi2 < MOD_RELEASE.length; mi2++) {
      post($.CGEventCreateKeyboardEvent($(), MOD_RELEASE[mi2], false));
    }
    var SHIFT_KEYS = [56, 60]; // lshift, rshift
    for (var si2 = 0; si2 < SHIFT_KEYS.length; si2++) {
      post($.CGEventCreateKeyboardEvent($(), SHIFT_KEYS[si2], false));
      nap(4);
      post($.CGEventCreateKeyboardEvent($(), SHIFT_KEYS[si2], true));
      nap(8);
      post($.CGEventCreateKeyboardEvent($(), SHIFT_KEYS[si2], false));
      nap(8);
    }
    nap(30);
    for (var si = 0; si < steps.length; si++) {
      var st = steps[si];
      if (st && st.k === 'k') {
        if (st.s) {
          // Shifted char = PHYSICAL typing shape: shift-KEY down (with the
          // flag set on it), char down, char up (FLAGLESS — a flagged char
          // keyup RE-ASSERTS the modifier and sticks it globally), shift-KEY
          // up. Char keyups alone NEVER release a modifier (learned live:
          // "XYZ https://…" rendered "XYZ HTTPS:??…" when the shift stuck).
          var sd = $.CGEventCreateKeyboardEvent($(), 56, true);
          $.CGEventSetFlags(sd, FLAG_SHIFT);
          post(sd); nap(4);
          var kds = $.CGEventCreateKeyboardEvent($(), st.c, true);
          $.CGEventSetFlags(kds, FLAG_SHIFT);
          post(kds); nap(4);
          post($.CGEventCreateKeyboardEvent($(), st.c, false)); nap(4);
          post($.CGEventCreateKeyboardEvent($(), 56, false));
        } else {
          post($.CGEventCreateKeyboardEvent($(), st.c, true)); nap(4);
          post($.CGEventCreateKeyboardEvent($(), st.c, false));
        }
        nKey++;
      } else if (st && st.k === 'u') {
        var uch = String(st.ch || '');
        if (uch.length) {
          var kdu = $.CGEventCreateKeyboardEvent($(), 0, true);
          $.CGEventKeyboardSetUnicodeString(kdu, uch.length, uch);
          post(kdu);
          var kuu = $.CGEventCreateKeyboardEvent($(), 0, false);
          $.CGEventKeyboardSetUnicodeString(kuu, uch.length, uch);
          post(kuu);
          nFallback++;
        }
      }
      nap(6);
    }
    return JSON.stringify({ typed: nKey + nFallback, keycodes: nKey, fallback: nFallback });
  }

  if (action === 'key') {
    var KEYCODES = {
      'return': 36, 'enter': 36, 'tab': 48, 'space': 49, 'delete': 51, 'backspace': 51,
      'escape': 53, 'esc': 53, 'left': 123, 'right': 124, 'down': 125, 'up': 126,
      'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121, 'f1': 122, 'f2': 120,
      'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97, 'f7': 98, 'f8': 100, 'f9': 101,
      'f10': 109, 'f11': 103, 'f12': 111,
    };
    var keyName = String(p.key || '').toLowerCase();
    var code = KEYCODES[keyName];
    var charShift = false;
    if (code === undefined && keyName.length === 1) {
      // Single character (letter/digit/punct) — resolve via the US-ANSI table
      // so Cmd+L / Cmd+N / Cmd+C etc. work (ticket cbaf3e08).
      var ck = CHAR_KEYS[keyName];
      if (ck) { code = ck[0]; charShift = !!ck[1]; }
    }
    if (code === undefined) return JSON.stringify({ error: 'unknown key: ' + keyName });
    var flags = charShift ? FLAG_SHIFT : 0;
    var mods = p.modifiers || [];
    // 746c4d4f: a chord is POSTED AS A CHORD — each requested modifier gets a
    // real key-DOWN transition around the char, then a key-UP. The old shape
    // (one flagged keydown, flagless keyup, no modifier-key events at all) is
    // not a chord to the target app: apps that key off modifierKeyDown (Discord
    // included) see a bare 'k', and whatever app owns the global handler eats
    // it — the report's "Cmd+K is delivered to Finder". Modifier keycodes are
    // collected in request order and released in REVERSE (same nesting shape
    // as a human's key chord).
    var holdKeys = [];
    for (var mi = 0; mi < mods.length; mi++) {
      var m = String(mods[mi]).toLowerCase();
      // Both tables are INJECTED from computer-keymap.ts (one unit-tested
      // source of truth). The old inline if/else copy is exactly how the click
      // and key paths drifted from the type action in the first place.
      if (MOD_FLAGS[m] !== undefined) flags |= MOD_FLAGS[m];
      if (MOD_KEYS[m] !== undefined && holdKeys.indexOf(MOD_KEYS[m]) < 0) holdKeys.push(MOD_KEYS[m]);
    }
    // A shifted CHAR (table says so) needs a real shift transition too.
    if (charShift && holdKeys.indexOf(MOD_KEYS['shift']) < 0) holdKeys.unshift(MOD_KEYS['shift']);
    // Unhook any inherited modifier first: a latched Control would corrupt the
    // chord (and is already corrupting every click — see clearModifiers).
    var keyInherited = clearModifiers();
    for (var hk = 0; hk < holdKeys.length; hk++) {
      var md2 = $.CGEventCreateKeyboardEvent($(), holdKeys[hk], true);
      if (flags) $.CGEventSetFlags(md2, flags);
      post(md2); nap(8); // settle between modifier and char (live-E2E: 4ms coalesced)
    }
    var kd2 = $.CGEventCreateKeyboardEvent($(), code, true);
    if (flags) $.CGEventSetFlags(kd2, flags);
    post(kd2); nap(35);
    // Char keyup stays FLAGLESS — a flagged keyUP re-asserts the modifier and
    // sticks it globally (the cbaf3e08 live finding, pinned in computer-keymap).
    var ku2 = $.CGEventCreateKeyboardEvent($(), code, false);
    post(ku2); nap(8);
    for (var hu = holdKeys.length - 1; hu >= 0; hu--) {
      post($.CGEventCreateKeyboardEvent($(), holdKeys[hu], false)); nap(6);
    }
    // Leave the world CLEAN: the next action is usually a click, and any
    // modifier still latched after this chord turns that left-click into a
    // right-click (the reported failure).
    clearModifiers();
    return JSON.stringify({ pressed: keyName, modifiers: mods, chord: holdKeys.length, clearedModifiers: keyInherited });
  }

  return JSON.stringify({ error: 'unknown action: ' + action });
}
`;

// ── Permissions ───────────────────────────────────────────────────────────────

interface PermissionState { screen: boolean; accessibility: boolean; checkedAt: number }
let permCache: PermissionState | null = null;
let lastGuidanceAt = 0;

/**
 * One JXA preflight of Screen Recording + Accessibility (uncached). The ONLY
 * seam for this check in the agent: missingComputerPermissions() (the
 * computer-use guard) and permissions.ts's every-poll advert both call it, so
 * the two surfaces can never disagree about what "granted" means.
 */
export async function preflightPermissions(): Promise<{ screen: boolean; accessibility: boolean }> {
  const out = await runJxa(JXA_RUNNER, ['preflight', '{}']);
  const r = JSON.parse(out);
  return { screen: !!r.screen, accessibility: !!r.accessibility };
}

// ── First-launch permission requests (v0.6.3) ────────────────────────────────
// Owner ask (2026-09-26, after a reinstall left computer use dead): "shouldn't
// the macOS client request all necessary system settings changes the first
// time you install, so you don't have to then separately do Accessibility,
// Screen Recording etc?" These two fire the NATIVE prompts; index.ts runs
// them once per helper binary at startup (see firstLaunchOnboarding).

/**
 * Fire the native Accessibility prompt (AXIsProcessTrustedWithOptions with
 * kAXTrustedCheckOptionPrompt). macOS pre-lists DigbyHelper in the pane, so
 * the user only flips the switch. Resolves to the grant state at call time
 * (the prompt itself is async system UI); a bridge failure resolves false —
 * onboarding is best-effort and never throws.
 */
export async function requestAccessibilityPrompt(): Promise<boolean> {
  try {
    const r = JSON.parse(await runJxa(JXA_RUNNER, ['request_ax', '{}']));
    if (r.error) log(`accessibility prompt unavailable (${r.error}) — falling back to the System Settings walkthrough`);
    return !!r.accessibility;
  } catch (e: any) {
    log(`accessibility prompt failed (${e?.message || e}) — falling back to the System Settings walkthrough`);
    return false;
  }
}

/**
 * 30d3c366: the NON-REQUESTING Input Monitoring query (CGPreflightListenEventAccess).
 * Returns true/false from the OS, or NULL when the bridge cannot answer — an
 * unknown must never be advertised or counted as a revoked grant (the
 * c44b19e9 unknown-never-convicts rule). Never raises the consent sheet, so
 * this is safe on the every-poll advert path (the 0.9.8 / 30787bc4 rule).
 */
export async function probeInputMonitoring(): Promise<boolean | null> {
  try {
    const r = JSON.parse(await runJxa(JXA_RUNNER, ['preflight_im', '{}']));
    return typeof r.inputMonitoring === 'boolean' ? r.inputMonitoring : null;
  } catch {
    return null; // bridge wedged → unknown, never a fabricated denial
  }
}

/**
 * 30d3c366: fire the NATIVE Input Monitoring consent sheet
 * (CGRequestListenEventAccess) — the prompt the owner asked for ("why doesn't
 * it request that for you automatically on new digby install"). REQUESTING, so
 * it belongs to first-launch onboarding only (the same class as
 * requestAccessibilityPrompt above); never the status poll. Best-effort: a
 * bridge failure resolves false and onboarding carries on.
 */
export async function requestInputMonitoringPrompt(): Promise<boolean> {
  try {
    const r = JSON.parse(await runJxa(JXA_RUNNER, ['request_im', '{}']));
    if (r.error) log(`input-monitoring prompt unavailable (${r.error}) — falling back to the System Settings walkthrough`);
    return !!r.inputMonitoring;
  } catch (e: any) {
    log(`input-monitoring prompt failed (${e?.message || e}) — falling back to the System Settings walkthrough`);
    return false;
  }
}

/**
 * Ground truth for Screen Recording from the last REAL capture: true after a
 * screencapture succeeded, false after the canonical TCC denial ("could not
 * create image from display"), null before any capture. The JXA preflight
 * cannot see Screen Recording on macOS 26 (CGPreflightScreenCaptureAccess is
 * not bridged → it reads "granted" for everyone — the 2026-08-31 false
 * positive), so the advertised `sr` flag prefers this once it exists.
 */
let captureTruth: boolean | null = null;
export function noteCaptureResult(ok: boolean): void {
  captureTruth = ok;
}
export function lastCaptureTruth(): boolean | null {
  return captureTruth;
}

// ── Automation denial latch (ticket 30d3c366, 2026-10-29) ────────────────────
// The front_window probe is the ONE place this agent exercises the Automation
// (Apple Events) grant: `Application('System Events')` is what macOS gates on
// it. When the grant is orphaned by a self-update the AppleEvent fails with
// -1743 (errAEEventNotPermitted) and — before this latch — the only trace was
// a soft "capture falls back to pointer → main" log line, so the loss was
// invisible: no episode, no card, and the operator read the symptom as flaky
// input. Same latch idiom as captureTruth above (computer.ts must not import
// index.ts — that would be a cycle): set here at the failure site, drained by
// the run loop, which feeds it to the TCC watchdog.
let automationDenied = false;
/** Stamp an Automation (Apple Events/System Events) denial observed at a REAL
 *  call. Only ever called from a genuine -1743 classification — never guessed. */
export function noteAutomationDenied(): void {
  automationDenied = true;
}
/** True when an Automation denial was stamped since the last drain. */
export function lastAutomationDenial(): boolean {
  return automationDenied;
}
/** Clear the latch once the run loop has consumed it (one surfacing per
 *  streak, mirroring the watchdog's dedupe). */
export function clearAutomationDenial(): void {
  automationDenied = false;
}
/** Pure (exported for the replay suite): does this AppleEvent error text
 *  convict the Automation grant? macOS words it "Not authorized to send Apple
 *  events to System Events" and appends `(-1743)`; errAEEventNotPermitted is
 *  1743. Deliberately narrow — a -1743 WITHOUT the Apple-events wording is the
 *  legacy EventKit/Calendars denial and belongs to calendar.ts's classifier,
 *  so this must never claim it (the c44b19e9 one-vocabulary rule). */
export function isAutomationDenialText(msg: string | null | undefined): boolean {
  if (!msg || typeof msg !== 'string') return false;
  if (!/-1743/.test(msg)) return false;
  return /system events|apple\s?events?|not authorized to send/i.test(msg);
}

// ── Probe backoff (ticket 30787bc4, 2026-10-24) ──────────────────────────────
// The incident: the 0.9.4→0.9.6 self-update swapped the DigbyAgent binary
// (a new inode); macOS TCC grants attach to the exact file, so the new
// binary's screen-capture requests were UN-granted while System Settings
// still showed the old entry's toggle ON. The status poll then re-probed
// with a REAL `screencapture` every 15 s TTL — each probe re-RAISED the
// native "DigbyAgent would like to record this computer's screen and audio"
// dialog, so the owner got a system modal roughly every minute that no
// toggle could dismiss (the visible toggle belongs to the STALE entry for
// the old binary). A consent REQUEST is not a status check: the status poll
// may only read state (the JXA preflight, the latched truth), and the probe
// — the only capture on that path — must clear a hard exponential backoff
// first. First-launch onboarding (once per binary) and computer_use commands
// (user-armed, one dialog per task at most) stay the prompt-bearing paths.

/** Backoff ladder for the throwaway Screen Recording probe: 5 min, 20 min,
 *  80 min, then 6 h. A missing grant surfaces at most ~4 dialogs in the
 *  first ~105 minutes and ~4/day steady-state instead of ~60/hour. */
export const SR_PROBE_BACKOFF_MS: readonly number[] = [
  5 * 60_000,
  20 * 60_000,
  80 * 60_000,
  6 * 60 * 60_000,
];

let srArmedAt: number | null = null;
let srArmedCount = 0;

/**
 * Stamp that a prompt-armed capture fired NOW — probeScreenRecording calls
 * this at its top, the single choke point every armed throwaway capture goes
 * through (onboarding's first ask included). Pushing the window out on the
 * ATTEMPT rather than the verdict is what closes the incident's worst case:
 * a dialog the owner dismisses or ignores makes screencapture fail with an
 * UNCLASSIFIED error — no denial latches — and the pre-fix code re-armed
 * 15 s later anyway.
 */
function armSrProbe(now: number = Date.now()): void {
  srArmedAt = now;
  srArmedCount++;
}

/** Test seam: reset the probe ladder state. */
export function resetSrProbeBackoff(): void {
  srArmedAt = null;
  srArmedCount = 0;
}

/**
 * Pure (exported for the Linux-CI suite): may the STATUS poll fire the
 * throwaway capture NOW? True while no armed capture has happened yet this
 * process (the fresh-install path — the first probe IS the native prompt);
 * after one, only once the current backoff step has fully elapsed. The
 * armed state itself is stamped by probeScreenRecording (the choke point),
 * so onboarding's prompt is never echoed by a status probe 15 s later.
 */
export function shouldProbeScreenRecording(
  now: number = Date.now(),
  armedAt: number | null = srArmedAt,
  armedCount: number = srArmedCount,
): boolean {
  if (armedAt === null) return true;
  const idx = Math.min(armedCount - 1, SR_PROBE_BACKOFF_MS.length - 1);
  const wait = SR_PROBE_BACKOFF_MS[Math.max(idx, 0)];
  return now - armedAt >= wait;
}

/**
 * One throwaway capture to a temp file (deleted immediately). Two jobs:
 *   - the native Screen Recording PROMPT: CGRequestScreenCaptureAccess is not
 *     bridged to JXA, but the first `screencapture` from a never-asked
 *     responsible process (this helper) raises the same system prompt
 *     ("DigbyAgent would like to record this computer's screen and audio");
 *   - the ground-truth PROBE — but ONLY when the 30787bc4 backoff ladder
 *     allows it (the status poll asks through shouldProbeScreenRecording;
 *     onboarding and computer_use commands are user-armed and may always
 *     fire, feeding the ladder via armSrProbe so their prompt is never
 *     echoed 15 s later). Resolves true iff the capture succeeded.
 */
export async function probeScreenRecording(): Promise<boolean> {
  armSrProbe(); // 30787bc4: every armed throwaway capture advances the backoff ladder
  const tmp = join(tmpdir(), `digby-sr-probe-${process.pid}-${Date.now()}.png`);
  try {
    await runFile('screencapture', ['-x', '-t', 'png', tmp], 20000);
    // 933e6ca4: exit-0 is NOT proof. A TCC-orphaned binary (its grant died
    // with the replaced/deleted old binary) gets a WELL-FORMED solid-black
    // frame at full resolution — the pane still shows the old grant and the
    // card shows ✓ while every capture is blind. Only the pixels tell the
    // truth — and never one frame alone (reviewer round 2: a sleeping
    // display / black wallpaper is legitimately solid black): corroborate
    // with a second capture after a display wake nudge before convicting.
    // A frame we cannot decode (null) keeps the optimistic verdict.
    let first: boolean | null = null;
    try { first = pngSolidPlaceholder(readFileSync(tmp)); } catch { first = null; }
    if (first === true) {
      let second: boolean | null = null;
      try { second = await corroboratingCapture(); } catch { second = null; }
      if (convictAfterCorroboration(first, second)) {
        noteCaptureResult(false);
        return false;
      }
    }
    noteCaptureResult(true);
    return true;
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (/could not create image from display/i.test(msg)) noteCaptureResult(false);
    return false;
  } finally {
    try { unlinkSync(tmp); } catch { /* nothing was written */ }
  }
}

/**
 * A corroboration capture for the solid-placeholder verdict (reviewer round
 * 2): nudge the display awake (a display that just went to sleep captures
 * genuinely black frames even with TCC granted), wait a moment for it to
 * light up, then capture again and return whether the second frame is ALSO a
 * solid placeholder. Best-effort — any failure resolves null (never a
 * conviction).
 */
async function corroboratingCapture(): Promise<boolean | null> {
  const tmp = join(tmpdir(), `digby-sr-corro-${process.pid}-${Date.now()}.png`);
  try {
    // -u asserts the wake assertion WITHOUT holding a caffeinate process.
    try { await runFile('caffeinate', ['-u', '-t', '2'], 5000); } catch { /* best-effort */ }
    await sleep(400);   // let the display actually light up
    await runFile('screencapture', ['-x', '-t', 'png', tmp], 20000);
    try { return pngSolidPlaceholder(readFileSync(tmp)); } catch { return null; }
  } finally {
    try { unlinkSync(tmp); } catch { /* nothing was written */ }
  }
}

/** Native guidance dialog + open the right System Settings pane (mirrors the FDA flow). */
function guidance(missing: string[]): void {
  const now = Date.now();
  if (now - lastGuidanceAt < 10 * 60_000) return; // don't spam the dialog
  lastGuidanceAt = now;
  const needs: string[] = [];
  if (missing.includes('screen')) {
    needs.push('Screen Recording');
    try { execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']); } catch { /* best-effort */ }
  }
  if (missing.includes('accessibility')) {
    needs.push('Accessibility');
    try { execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']); } catch { /* best-effort */ }
  }
  try { execFile('open', ['-R', process.execPath]); } catch { /* reveal the helper binary in Finder */ }
  // 51d8dbe0: name the REAL executable (DigbyAgent on a CLI install,
  // DigbyHelper in the .app bundle) — Finder just revealed process.execPath.
  const helper = basename(process.execPath);
  const script =
    `display dialog ${JSON.stringify(
      'Digby computer use needs one-time permission(s): ' + needs.join(' + ') + '.\n\n' +
      '1. In the System Settings window that just opened, click + (unlock first if needed).\n' +
      `2. A Finder window is showing a file called "${helper}" — drag it into the list.\n` +
      '3. Turn its switch ON.\n\n' +
      'Then ask Digby to retry — no restart needed.',
    )} with title "Digby — Computer Use Setup" buttons {"OK"} default button "OK"`;
  execFile('osascript', ['-e', script], { timeout: 120000 }, () => { /* user dismissed */ });
}

/**
 * Preflight Screen Recording + Accessibility. Returns the missing list ([] =
 * all granted). Cached briefly when granted; failures always recheck fresh so
 * a just-granted permission is picked up on the very next command.
 */
export async function missingComputerPermissions(force = false): Promise<string[]> {
  if (!force && permCache && permCache.screen && permCache.accessibility && Date.now() - permCache.checkedAt < PERMISSION_CACHE_MS) {
    return [];
  }
  try {
    const r = await preflightPermissions();
    permCache = { screen: r.screen, accessibility: r.accessibility, checkedAt: Date.now() };
  } catch (e: any) {
    log(`preflight failed (${e?.message || e}) — proceeding, action errors will surface`);
    return []; // preflight itself broke: don't block the feature on a broken CHECK
  }
  const missing: string[] = [];
  if (!permCache.screen) missing.push('screen');
  if (!permCache.accessibility) missing.push('accessibility');
  return missing;
}

/** Guidance dialog + the structured, actionable error for a missing-permissions block. */
function permissionBlock(missing: string[], opts?: { solidCapture?: boolean }): Observation {
  guidance(missing);
  const names = missing.map((m) => (m === 'screen' ? 'Screen Recording' : 'Accessibility'));
  // 933e6ca4 (d): name the binary that actually holds the grant — the TCC pane
  // lists the executable's basename ("DigbyAgent" on a tarball install,
  // "DigbyHelper" in the .app bundle), and telling the user to toggle a name
  // that is not in the pane is how a grant looks "already given" while the
  // NEW binary is still blind.
  const binaryName = basename(process.execPath);
  let hint =
    `Missing macOS permission(s): ${names.join(' + ')}. A setup dialog was shown on the user's Mac ` +
    `(add "${binaryName}" under System Settings → Privacy & Security → ${names.join(' / ')}), then retry — no restart needed.`;
  // 933e6ca4 (c): the solid-black-capture case is the one where the pane LIKELY
  // already shows a grant — for the OLD binary. Replacing or deleting the
  // helper gives the new binary a new identity, so its captures come back
  // solid-black while the pane still lists the stale entry. Say that, and the
  // fix: remove the stale entry, re-add the new binary, quit + relaunch.
  if (opts?.solidCapture && missing.includes('screen')) {
    hint +=
      ` NOTE: two consecutive captures came back solid-black at full resolution — the classic sign that the pane still holds a ` +
      `grant for a PREVIOUS "${binaryName}" binary (replacing or deleting the helper gives this one a new identity). ` +
      `If it is already listed: remove the stale entry, re-add "${binaryName}", then restart the agent (its launchd ` +
      `service restarts automatically within ~10s).`;
  }
  return { ok: false, error: hint };
}

async function guard(): Promise<Observation | null> {
  const missing = await missingComputerPermissions();
  if (missing.length === 0) return null;
  return permissionBlock(missing);
}

/** True when an action error smells like a revoked/missing permission → recheck. */
function looksPermissiony(msg: string): boolean {
  return /not (allowed|permitted)|assistive|accessibility|screen recording|could not create image from display|-10004|-25204|-1743/i.test(msg);
}

// ── Screenshot ────────────────────────────────────────────────────────────────

interface ShotMeta {
  imageWidth: number;
  imageHeight: number;
  screenWidth: number;
  screenHeight: number;
  geometryMismatch?: string;
  /** v0.6.1: CG-global origin of the CAPTURED display — clicks translate
   *  through the captured display's bounds, not the main display's. Absent
   *  (legacy single-display path) = 0,0. */
  originX?: number;
  originY?: number;
  displayId?: number;
}
let lastShot: ShotMeta | null = null;

// ── Display topology (v0.6.1, cu-diag fix #1) ─────────────────────────────────

export interface DisplayInfo {
  id: number;
  /** 1-based index in NSScreen.screens order — the `screencapture -D` index. */
  index: number;
  /** CG-global bounds in POINTS (top-left origin). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** BACKING pixel size (numbers; 0 = unknown). v0.6.2: read from the
   *  current CGDisplayMode and Number()-coerced on both sides — the ObjC
   *  bridge returns strings, and CGDisplayPixelsWide is point-sized on HiDPI. */
  pixelWidth: number;
  pixelHeight: number;
  /** NSScreen.backingScaleFactor (1 or 2; absent on older agents). */
  scale?: number;
  name: string;
}

export interface DisplayTopology {
  main: number;
  displays: DisplayInfo[];
  pointer: { x: number; y: number } | null;
  frontWindow: { app?: string; window?: string; x?: number; y?: number; w?: number; h?: number } | null;
  hidIdleRaw: number | null;
}

export type CaptureMode = 'auto' | 'main' | 'frontmost' | 'pointer' | number;

/** The capture-display policy. `DIGBY_CAPTURE_DISPLAY` (agent-side kill
 *  switch): unset/`auto` = the display owning the frontmost window → the
 *  pointer's display → main; `main` = the pre-0.6.1 behavior (always the
 *  main display); `frontmost` / `pointer` force one source; a number forces
 *  that 1-based display index. */
export function captureModeFromEnv(raw: string | undefined = process.env.DIGBY_CAPTURE_DISPLAY): CaptureMode {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === 'auto') return 'auto';
  if (v === 'main' || v === 'frontmost' || v === 'pointer') return v;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 1 ? n : 'auto';
}

/** The display whose CG bounds contain the point (right/bottom edges exclusive
 *  so a point on a shared edge resolves to exactly one display). */
export function displayContaining(displays: DisplayInfo[], x: number, y: number): DisplayInfo | null {
  for (const d of displays) {
    if (x >= d.x && x < d.x + d.width && y >= d.y && y < d.y + d.height) return d;
  }
  return null;
}

/**
 * Pure capture-display decision (exported for the node:test suite). The
 * incident rule: capture the display the user is LOOKING at — the one that
 * owns the frontmost window (its center; a window straddling displays picks
 * the display holding most of it), else the pointer's display, else main,
 * else the first display. Returns null display when the topology is empty
 * (the caller falls back to the legacy `-D 1` path).
 */
export function chooseCaptureDisplay(
  topo: DisplayTopology,
  mode: CaptureMode = 'auto',
): { display: DisplayInfo | null; reason: string; frontmostWindowDisplayId: number | null; pointerDisplayId: number | null } {
  const displays = topo.displays || [];
  const fw = topo.frontWindow;
  const frontDisplay =
    fw && typeof fw.x === 'number' && typeof fw.y === 'number' && typeof fw.w === 'number' && typeof fw.h === 'number'
      ? displayContaining(displays, fw.x + fw.w / 2, fw.y + fw.h / 2)
      : null;
  const pointerDisplay = topo.pointer ? displayContaining(displays, topo.pointer.x, topo.pointer.y) : null;
  const mainDisplay = displays.find((d) => d.id === topo.main) || null;
  const first = displays[0] || null;
  const ids = { frontmostWindowDisplayId: frontDisplay ? frontDisplay.id : null, pointerDisplayId: pointerDisplay ? pointerDisplay.id : null };
  if (!displays.length) return { display: null, reason: 'legacy', ...ids };
  if (typeof mode === 'number') {
    const forced = displays.find((d) => d.index === mode) || null;
    if (forced) return { display: forced, reason: 'override', ...ids };
  } else if (mode === 'main') {
    return { display: mainDisplay || first, reason: 'override', ...ids };
  } else if (mode === 'frontmost') {
    if (frontDisplay) return { display: frontDisplay, reason: 'frontmost', ...ids };
    return { display: mainDisplay || first, reason: 'main', ...ids };
  } else if (mode === 'pointer') {
    if (pointerDisplay) return { display: pointerDisplay, reason: 'pointer', ...ids };
    return { display: mainDisplay || first, reason: 'main', ...ids };
  }
  if (frontDisplay) return { display: frontDisplay, reason: 'frontmost', ...ids };
  if (pointerDisplay) return { display: pointerDisplay, reason: 'pointer', ...ids };
  return { display: mainDisplay || first, reason: 'main', ...ids };
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * v0.6.2: coerce a parsed `displays` payload into numbers. The JXA/ObjC
 * bridge hands CG integers back as STRINGS ("2304"), and `'0'` is truthy —
 * before this every `pd.width !== chosen.pixelWidth` was a number-vs-string
 * comparison that could never be equal. Pure; exported for the node:test
 * suite. Returns null when there is no usable display list.
 */
export function normalizeTopology(parsed: any): DisplayTopology | null {
  if (!parsed || !Array.isArray(parsed.displays) || parsed.displays.length === 0) return null;
  const displays: DisplayInfo[] = parsed.displays.map((d: any, i: number) => ({
    id: num(d?.id),
    index: num(d?.index) || i + 1,
    x: num(d?.x),
    y: num(d?.y),
    width: num(d?.width),
    height: num(d?.height),
    pixelWidth: Math.max(0, Math.round(num(d?.pixelWidth))),
    pixelHeight: Math.max(0, Math.round(num(d?.pixelHeight))),
    ...(d?.scale !== undefined && num(d.scale) > 0 ? { scale: num(d.scale) } : {}),
    name: String(d?.name || ''),
  }));
  const fw = parsed.frontWindow && typeof parsed.frontWindow === 'object' ? parsed.frontWindow : null;
  const frontWindow = fw
    ? {
        app: fw.app ? String(fw.app) : undefined,
        window: fw.window ? String(fw.window) : undefined,
        ...(['x', 'y', 'w', 'h'].every((k) => fw[k] !== undefined && fw[k] !== null && Number.isFinite(Number(fw[k])))
          ? { x: Number(fw.x), y: Number(fw.y), w: Number(fw.w), h: Number(fw.h) }
          : {}),
      }
    : null;
  const pointer = parsed.pointer && Number.isFinite(Number(parsed.pointer.x)) && Number.isFinite(Number(parsed.pointer.y))
    ? { x: Number(parsed.pointer.x), y: Number(parsed.pointer.y) }
    : null;
  const hid = parsed.hidIdleRaw === null || parsed.hidIdleRaw === undefined ? null : Number(parsed.hidIdleRaw);
  return {
    main: num(parsed.main),
    displays,
    pointer,
    frontWindow,
    hidIdleRaw: hid !== null && Number.isFinite(hid) ? hid : null,
  };
}

/** Integer backing scales a display may run at (1×, 2×, 3× for some panels). */
const CANDIDATE_SCALES = [1, 2, 3];

/** Does a PNG of `pd` pixels plausibly come from display `d`? Exact backing
 *  pixel match when the agent knows it; else the point size at an integer
 *  scale (a 2304×1296 pt panel → 4608×2592 px at 2×). */
export function displayMatchesPixels(d: DisplayInfo, pd: { width: number; height: number }): boolean {
  if (d.pixelWidth > 0 && d.pixelHeight > 0 && d.pixelWidth === pd.width && d.pixelHeight === pd.height) return true;
  if (d.width > 0 && d.height > 0) {
    for (const k of CANDIDATE_SCALES) {
      if (Math.round(d.width * k) === pd.width && Math.round(d.height * k) === pd.height) return true;
    }
  }
  return false;
}

/**
 * v0.6.2: the PNG-size honesty check as a pure function (exported for the
 * node:test suite). Given the display list, the display we ASKED
 * `screencapture -D` for and the PNG's IHDR size, decide which display the
 * frame really came from:
 *   - 'confirmed'  — the PNG is the chosen display's size (exact backing
 *                    pixels, or its point size at an integer scale);
 *   - 'reattributed' — exactly ONE OTHER display owns that pixel size — the
 *                    -D ordering differs from NSScreen's; use that display;
 *   - 'ambiguous'  — several displays share the size (three identical Dells)
 *                    and the chosen one is not among them — keep the chosen
 *                    display, say so;
 *   - 'unmatched'  — no display owns the size — keep the chosen display, the
 *                    aspect reconciliation decides.
 */
export function attributeCapturedDisplay(
  displays: DisplayInfo[],
  chosen: DisplayInfo,
  pd: { width: number; height: number } | null,
): { display: DisplayInfo; how: 'confirmed' | 'reattributed' | 'ambiguous' | 'unmatched' | 'unchecked'; candidates: DisplayInfo[] } {
  if (!pd || !(pd.width > 0 && pd.height > 0)) return { display: chosen, how: 'unchecked', candidates: [] };
  if (displayMatchesPixels(chosen, pd)) return { display: chosen, how: 'confirmed', candidates: [chosen] };
  const candidates = displays.filter((d) => d.id !== chosen.id && displayMatchesPixels(d, pd));
  if (candidates.length === 1) return { display: candidates[0], how: 'reattributed', candidates };
  if (candidates.length > 1) return { display: chosen, how: 'ambiguous', candidates };
  return { display: chosen, how: 'unmatched', candidates: [] };
}

/** `DIGBY_CAPTURE_PIXEL_CHECK=off` (agent-side kill switch, v0.6.2) skips
 *  the PNG-size re-attribution above (the chosen index is trusted as-is;
 *  the aspect reconciliation still runs). */
export function pixelCheckEnabled(raw: string | undefined = process.env.DIGBY_CAPTURE_PIXEL_CHECK): boolean {
  const v = String(raw || '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

/** `DIGBY_FRONT_WINDOW_PROBE=off` (agent-side kill switch, v0.6.2) skips the
 *  System Events frontmost-window probe entirely — the capture display then
 *  comes from the pointer → main, and frontmostApp/Window are omitted. */
export function frontWindowProbeEnabled(raw: string | undefined = process.env.DIGBY_FRONT_WINDOW_PROBE): boolean {
  const v = String(raw || '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false');
}

/** PNG IHDR read — width/height without spawning sips (bytes 16..24). */
export function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (!buf || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ── Degenerate-capture detection (ticket 933e6ca4) ────────────────────────────
//
// THE MISHAP (reproduced live on cql-stanne-mbp-1): replacing the helper
// binary invalidates its Screen Recording TCC grant, but macOS answers a
// capture request from a TCC-orphaned process with a SOLID-BLACK frame at
// FULL resolution — screencapture exits 0, the PNG is well-formed, and the
// probe (and every preflight) therefore reports Screen Recording GRANTED
// while computer use is blind. The owner sees black screenshots while the
// card shows ✓. The tell is the pixels: a real screen never rasterises to
// one colour.
//
// Reviewer round 2 hardened this twice, with a MEASURED false conviction:
// (1) the old ≤8192-sample cap convicted a REAL 1920×1080 near-black frame
// with ONE bright pixel (a black wallpaper + cursor is a real desktop) —
// the verdict must read EVERY byte (native memcmp via Buffer.equals), not a
// sparse sample; (2) a sleeping display produces legitimately black
// captures even with TCC granted, so a single solid capture is never
// enough — the live paths corroborate with a second capture after a display
// wake nudge before reporting the permission miss.

/**
 * Pure: is this RGB triple the black/transparent placeholder TCC hands an
 * unauthorised capture? A solid BLACK frame is the classic denial shape; a
 * fully transparent frame is the other one. Anything else (even solid
 * purple) is a real frame — a real desktop CAN legitimately be one flat
 * colour, so the detector ONLY fires on black and fully-transparent, never
 * on an arbitrary colour.
 */
export function isPlaceholderColor(r: number, g: number, b: number, a = 255): boolean {
  if (a === 0) return true;                      // fully transparent
  return r < 24 && g < 24 && b < 24;             // near-black (JPEG-tolerant)
}

/** Upper bound on the raw pixel bytes we will decode in-process (reviewer
 *  round 2: the decode is synchronous on the event loop that serves the
 *  backend long-poll). Above it the verdict is null — old behavior, no
 *  conviction. 128MB covers every real display up to 8K. */
const MAX_DECODE_BYTES = 128 * 1024 * 1024;

/** Small awaitable sleep (corroboration capture: give the display a moment
 *  to actually light up after the wake assertion). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One row's unfiltered bytes, written at dstOff in `px`; the row ABOVE it
 *  (already unfiltered) must sit at upOff. Filters 2/3/4 read the previous
 *  row, so the caller keeps a 2-row ring — a 1-row buffer would read out of
 *  bounds for every y ≥ 1. Returns false on an unknown filter type. */
function unfilterRow(raw: Buffer, y: number, rowBytes: number, bpp: number, px: Buffer, dstOff: number, upOff: number): boolean {
  const f = raw[y * (rowBytes + 1)];
  const srcRow = y * (rowBytes + 1) + 1;
  if (f === 0) {
    // The common case (screencapture's solid frames): memcpy the row.
    raw.copy(px, dstOff, srcRow, srcRow + rowBytes);
    return true;
  }
  for (let x = 0; x < rowBytes; x++) {
    const cur = raw[srcRow + x];
    // "left" is the byte one PIXEL to the left in THIS row — zero when
    // x < bpp (no pixel there). NOT px[dstOff + x - bpp] unclamped: that
    // can silently read the previous row's tail (caught by the filter-1
    // fixture in 933e6ca4's suite: row 1 decoded to 24 where the frame is
    // a constant 12).
    const left = x >= bpp ? px[dstOff + x - bpp] : 0;
    const up = y > 0 ? px[upOff + x] : 0;
    const upLeft = y > 0 && x >= bpp ? px[upOff + x - bpp] : 0;
    let v: number;
    switch (f) {
      case 1: v = (cur + left) & 0xff; break;
      case 2: v = (cur + up) & 0xff; break;
      case 3: v = (cur + ((left + up) >> 1)) & 0xff; break;
      case 4: {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        v = (cur + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
        break;
      }
      default: return false;                       // unknown filter — no verdict
    }
    px[dstOff + x] = v;
  }
  return true;
}

/**
 * EXHAUSTIVE verdict on raw (already-unfiltered) RGB/RGBA pixel data: every
 * byte read, none sampled (Buffer.equals is a native memcmp). Returns false
 * the moment any pixel differs from the first (row-wise early exit), true
 * only when the single colour everywhere is the placeholder (black/fully
 * transparent — a solid real colour is NEVER a denial), and null when the
 * input is too small or the pixel width is unsupported.
 */
export function isUniformFrame(raw: Buffer, bytesPerPixel: number): boolean | null {
  if (bytesPerPixel !== 3 && bytesPerPixel !== 4) return null;
  if (!raw || raw.length < bytesPerPixel * 16) return null;
  const bpp = bytesPerPixel;
  const rowBytes = Math.floor(raw.length / bpp) * bpp;
  const first = raw.subarray(0, bpp);
  if (!isPlaceholderColor(first[0], first[1], first[2], bpp === 4 ? first[3] : 255)) return false;
  // Every row — INCLUDING row 0 — must equal the first pixel's pattern
  // (native memcmp). (Starting the compare at row 1 was a real bug my own
  // suite caught: a single-row frame with a bright pixel after pixel 0 was
  // convicted as uniform.)
  const patternRow = Buffer.alloc(rowBytes);
  for (let o = 0; o < rowBytes; o += bpp) first.copy(patternRow, o);
  for (let off = 0; off + rowBytes <= raw.length; off += rowBytes) {
    if (!raw.subarray(off, off + rowBytes).equals(patternRow)) return false;
  }
  return true;
}

/**
 * Decode a PNG's raw pixels far enough to answer "is this the solid-black
 * frame macOS hands a TCC-orphaned capture?" Supports the two variants
 * screencapture writes (RGB8, RGBA8), no interlace, filter types 0–4.
 * Returns null whenever the image is anything else (palette, 16-bit,
 * interlaced, truncated, or larger than MAX_DECODE_BYTES) — a decode we
 * cannot do is a verdict we cannot claim (never a false conviction on a
 * REAL frame). Rows are unfiltered lazily and the scan EXITS on the first
 * non-uniform row, so a real frame usually costs one row, not the frame.
 */
export function pngSolidPlaceholder(buf: Buffer): boolean | null {
  try {
    if (!buf || buf.length < 8 + 25) return null;
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    const bitDepth = buf[24], colorType = buf[25];
    if (bitDepth !== 8) return null;
    let bpp: number;
    if (colorType === 2) bpp = 3;          // RGB
    else if (colorType === 6) bpp = 4;     // RGBA
    else return null;                      // palette/gray/… — not ours to judge
    // IHDR data is 13 bytes (width, height, bitDepth, colorType, compression,
    // filter, interlace) — interlace is the last one, file offset 28. Adam7
    // interlacing changes the row layout entirely: bail rather than misjudge.
    if (buf.length > 28 && buf[28] !== 0) return null;   // interlaced — bail
    if (w <= 0 || h <= 0 || w > 20000 || h > 20000) return null;
    const rowBytes = w * bpp;
    if (rowBytes * h > MAX_DECODE_BYTES) return null;    // too big to decode here
    // Collect + inflate the IDAT chunks.
    let off = 8;
    const chunks: Buffer[] = [];
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      if (type === 'IDAT' && off + 8 + len <= buf.length) chunks.push(buf.subarray(off + 8, off + 8 + len));
      if (type === 'IEND') break;
      off += 12 + len;
    }
    if (!chunks.length) return null;
    const idat = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    const raw = inflateSync(idat);
    if (raw.length < (rowBytes + 1) * h) return null;    // truncated — no verdict
    // Unfilter lazily, one row at a time (2-row ring: filters 2/3/4 read the
    // row above), and bail the moment any row is not the placeholder colour —
    // a real frame is usually detected on row 1.
    const px = Buffer.alloc(rowBytes * 2);
    let dst = 0, up = rowBytes;
    for (let y = 0; y < h; y++) {
      if (!unfilterRow(raw, y, rowBytes, bpp, px, dst, up)) return null;   // unknown filter
      const row = px.subarray(dst, dst + rowBytes);
      const a = bpp === 4 ? row[3] : 255;
      if (!isPlaceholderColor(row[0], row[1], row[2], a)) return false;
      // The whole row must equal the row's first pixel: native memcmp.
      const zeroRow = Buffer.alloc(rowBytes);
      for (let o = 0; o < rowBytes; o += bpp) row.copy(zeroRow, o);
      if (!row.equals(zeroRow)) return false;
      const t = dst; dst = up; up = t;   // swap the ring
    }
    return true;
  } catch {
    return null;
  }
}

/**
 * Corroboration gate (reviewer round 2, exported for the test suite): a
 * single solid-black capture is NOT a conviction — a sleeping display and a
 * black wallpaper both produce legitimately black frames with TCC granted.
 * The live paths take a SECOND capture after a display wake nudge and
 * convict only when both frames are solid placeholders.
 */
export function convictAfterCorroboration(first: boolean | null, second: boolean | null): boolean {
  return first === true && second === true;
}


// ── Own-input ledger + human idle (v0.6.1, cu-diag fix #6) ────────────────────

interface OwnInputInterval { start: number; end: number }
const OWN_INPUT_KEEP_MS = 120_000;
const OWN_INPUT_SLACK_MS = 1500;
const ownInputIntervals: OwnInputInterval[] = [];
let lastHumanEventAt: number | null = null;

/** Record that THIS agent posted HID events between start and now — the
 *  idle reading subtracts these so a machine run's own keystrokes never look
 *  like the owner typing. */
function markOwnInput(start: number): void {
  const now = Date.now();
  ownInputIntervals.push({ start, end: now });
  while (ownInputIntervals.length && ownInputIntervals[0].end < now - OWN_INPUT_KEEP_MS) ownInputIntervals.shift();
}

/**
 * Pure human-idle computation (exported for the node:test suite). `rawIdleSec`
 * is the OS reading (seconds since ANY HID event, ours included). When the
 * event it points at falls inside one of our own posted intervals (± slack)
 * it was ours, and the human idle is measured from the last human event we
 * previously observed (null when we never saw one in this process).
 */
export function humanIdleSeconds(
  rawIdleSec: number | null,
  now: number,
  own: OwnInputInterval[],
  lastHuman: number | null,
): { idle: number | null; lastHuman: number | null } {
  if (rawIdleSec === null || !Number.isFinite(rawIdleSec) || rawIdleSec < 0) {
    return { idle: lastHuman === null ? null : (now - lastHuman) / 1000, lastHuman };
  }
  const eventAt = now - rawIdleSec * 1000;
  const ours = own.some((iv) => eventAt >= iv.start - OWN_INPUT_SLACK_MS && eventAt <= iv.end + OWN_INPUT_SLACK_MS);
  if (!ours) {
    const lh = lastHuman === null ? eventAt : Math.max(lastHuman, eventAt);
    return { idle: (now - lh) / 1000, lastHuman: lh };
  }
  return { idle: lastHuman === null ? null : (now - lastHuman) / 1000, lastHuman };
}

/**
 * Ticket 81105154 (2026-10-24): classify a HID idle reading with TWO clocks.
 *
 * ATTRIBUTION clock (`readAtMs` — the moment the OS value was read): the
 * pre-fix call site computed eventAt = Date.now() − rawIdle with a Date.now()
 * taken AFTER the whole screenshot pipeline (front-window probe +
 * screencapture + sips — 2–8 s after the `displays` JXA took the reading),
 * which shifted eventAt FORWARD past the own-input interval end (+ slack)
 * and made the agent's own click/type read as "human input N s ago" — the
 * backend owner-presence gate then latched unattended machine runs
 * camera-only (one-way) in exactly the owner-absent windows they exist for.
 *
 * REPORT clock (`nowMs` — when the observation is built): the backend
 * consumes hidIdleSeconds as "seconds since the last human event RIGHT
 * NOW" (ownerPresence: idle < 120 s window). Measuring that delta at the
 * reading clock would UNDERSTATE it by the whole pipeline latency and
 * re-introduce false presence at the window edge (owner idle 122 s reads
 * 116 s → ACTIVE — reviewer finding 1, the same symptom class this ticket
 * exists to kill). So: eventAt at readAtMs, idle at nowMs.
 *
 * `readAtMs` null (no stamp available) falls back to nowMs for both — the
 * pre-fix behavior, never a silently widened own-input window.
 */
export function classifyHidReading(
  rawIdleSec: number | null,
  readAtMs: number | null,
  nowMs: number,
  own: OwnInputInterval[],
  lastHuman: number | null,
): { idle: number | null; lastHuman: number | null } {
  const readClock = typeof readAtMs === 'number' && Number.isFinite(readAtMs) ? readAtMs : nowMs;
  if (rawIdleSec === null || !Number.isFinite(rawIdleSec) || rawIdleSec < 0) {
    return { idle: lastHuman === null ? null : (nowMs - lastHuman) / 1000, lastHuman };
  }
  const eventAt = readClock - rawIdleSec * 1000;
  const ours = own.some((iv) => eventAt >= iv.start - OWN_INPUT_SLACK_MS && eventAt <= iv.end + OWN_INPUT_SLACK_MS);
  if (!ours) {
    const lh = lastHuman === null ? eventAt : Math.max(lastHuman, eventAt);
    return { idle: (nowMs - lh) / 1000, lastHuman: lh };
  }
  return { idle: lastHuman === null ? null : (nowMs - lastHuman) / 1000, lastHuman };
}

/** ioreg fallback for the HID idle reading (nanoseconds → seconds) when the
 *  CG function is not bridged. Best-effort, null on any failure. Returns the
 *  reading WITH the moment it was taken (ticket 81105154: attribution must
 *  use the reading's own clock). Reviewer finding 2: the stamp is taken
 *  AFTER the spawn resolves (like the topo path) — stamping BEFORE would
 *  shift eventAt backward by the spawn latency (up to the 3 s timeout,
 *  past OWN_INPUT_SLACK_MS) and swallow a real human keystroke that landed
 *  just after our own input window. */
async function ioregHidIdleSeconds(): Promise<{ sec: number | null; readAt: number }> {
  try {
    const out = await outputOf('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'], 3000);
    const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
    return { sec: m ? Number(m[1]) / 1e9 : null, readAt: Date.now() };
  } catch {
    return { sec: null, readAt: Date.now() };
  }
}

// ── Remote-session probe (v0.6.1, cu-diag fix #6) ─────────────────────────────

const REMOTE_PROBE_CACHE_MS = 5000;
let remoteProbeCache: { at: number; kinds: string[] } | null = null;

/** Which remote-control kinds look attached: a Screen Sharing virtual display
 *  (the topology already names it), a live `screensharingd`, or the TeamViewer
 *  desktop process. Cached 5 s — two pgrep spawns per screenshot otherwise. */
/** v0.6.2: `DIGBY_REMOTE_SESSION_IGNORE` — comma-separated remote-session
 *  kinds that must NOT count as "a remote session is attached" on this Mac
 *  (`all` ignores every kind). A headless Mac driving a dummy/virtual
 *  display (`virtual_display`), or one where the TeamViewer app merely sits
 *  open (`teamviewer_desktop`), would otherwise read as remote-controlled on
 *  every frame and keep every machine-triggered run camera-only. Default:
 *  nothing ignored (the 0.6.1 behavior). Pure; exported for the tests. */
export function remoteSessionIgnoreKinds(raw: string | undefined = process.env.DIGBY_REMOTE_SESSION_IGNORE): Set<string> {
  return new Set(
    String(raw || '')
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Pure kind classification of the display names (exported for the tests):
 *  `screen_sharing_virtual_display` for macOS Screen Sharing's own virtual
 *  display, `virtual_display` for any OTHER display calling itself virtual
 *  (BetterDisplay / DeskPad / HDMI dummies) — separately ignorable. */
export function remoteKindsFromDisplayNames(displays: Array<{ name?: string }>): string[] {
  const kinds = new Set<string>();
  for (const d of displays) {
    const name = d.name || '';
    if (/screen sharing/i.test(name)) kinds.add('screen_sharing_virtual_display');
    else if (/virtual display/i.test(name)) kinds.add('virtual_display');
  }
  return [...kinds];
}

export function applyRemoteSessionIgnore(kinds: string[], ignore: Set<string>): string[] {
  if (ignore.has('all')) return [];
  return kinds.filter((k) => !ignore.has(k));
}

async function remoteSessionKinds(displays: DisplayInfo[]): Promise<string[]> {
  const kinds = new Set<string>(remoteKindsFromDisplayNames(displays));
  const now = Date.now();
  if (remoteProbeCache && now - remoteProbeCache.at < REMOTE_PROBE_CACHE_MS) {
    remoteProbeCache.kinds.forEach((k) => kinds.add(k));
    return applyRemoteSessionIgnore([...kinds], remoteSessionIgnoreKinds());
  }
  const probed: string[] = [];
  const running = async (args: string[]): Promise<boolean> => {
    try { await runFile('pgrep', args, 3000); return true; } catch { return false; }
  };
  if (await running(['-x', 'screensharingd'])) probed.push('screensharingd');
  if (await running(['-f', 'TeamViewer_Desktop'])) probed.push('teamviewer_desktop');
  remoteProbeCache = { at: now, kinds: probed };
  probed.forEach((k) => kinds.add(k));
  return applyRemoteSessionIgnore([...kinds], remoteSessionIgnoreKinds());
}

/** Aspect-ratio agreement tolerance between the screenshot and the display's
 *  point size (sips -Z keeps aspect to sub-1%; 5% is generous headroom). */
const ASPECT_TOLERANCE = 0.05;

function aspectMatches(imageW: number, imageH: number, w: number, h: number): boolean {
  if (!imageW || !imageH || !w || !h) return false;
  const a = imageW / imageH, b = w / h;
  return Math.abs(a - b) / a <= ASPECT_TOLERANCE;
}

/**
 * v0.4.3 (ticket 4e4d56ff): reconcile the display's point size with the
 * screenshot. screencapture -D 1 captures the MAIN display; CGDisplayBounds(
 * CGMainDisplayID) is the same display in theory — but under macOS 26's
 * bridging the CG read can fail to the NSScreen fallback, and NSScreen's
 * "main" screen is the one with KEYBOARD FOCUS, which on a multi-display Mac
 * can be a DIFFERENT display than the captured one. Sizing clicks off the
 * wrong display lands them at wrong coordinates (the 2026-09-09 incident).
 * Rule: prefer CG bounds when they match the image's aspect; self-heal to
 * NSScreen when CG mismatches but NS matches; when NEITHER matches, keep CG
 * (the CGEvent-native source) but flag the shot so clicks fail LOUD instead
 * of guessing. Exported for the node:test geometry suite.
 */
export function pickScreenSize(
  imageW: number, imageH: number,
  cgW: number, cgH: number, nsW: number, nsH: number,
): { width: number; height: number; mismatch?: string } {
  const cgOk = aspectMatches(imageW, imageH, cgW, cgH);
  const nsOk = aspectMatches(imageW, imageH, nsW, nsH);
  if (cgOk) return { width: cgW, height: cgH };
  if (nsOk) return { width: nsW, height: nsH };
  if (cgW && cgH) {
    return {
      width: cgW, height: cgH,
      mismatch:
        `display point size ${cgW}×${cgH} (aspect ${(cgW / cgH).toFixed(3)}) does not match the ` +
        `${imageW}×${imageH} screenshot (aspect ${(imageW / imageH).toFixed(3)})` +
        (nsW && nsH ? `; NSScreen says ${nsW}×${nsH}` : ''),
    };
  }
  if (nsW && nsH) {
    return {
      width: nsW, height: nsH,
      mismatch:
        `display point size ${nsW}×${nsH} (NSScreen only — CGDisplayBounds unreadable) does not match the ` +
        `${imageW}×${imageH} screenshot`,
    };
  }
  return { width: 0, height: 0, mismatch: 'no display geometry available (both CGDisplayBounds and NSScreen failed)' };
}

/** Pure image-pixel → CG-point conversion for a given shot geometry. Exported
 *  for the node:test geometry suite (ticket 4e4d56ff replay pins). */
export function screenPointFor(x: number, y: number, shot: ShotMeta): { px: number; py: number } {
  // v0.6.1: translate through the CAPTURED display's bounds — its CG-global
  // origin is added so a click on a frame from the external display lands on
  // that display, not at the same offset on the main one.
  const ox = shot.originX || 0;
  const oy = shot.originY || 0;
  return {
    px: Math.round(ox + (x / shot.imageWidth) * shot.screenWidth),
    py: Math.round(oy + (y / shot.imageHeight) * shot.screenHeight),
  };
}

/**
 * Prime the click geometry from a capture the caller already took.
 *
 * ── THE BUG THIS EXISTS FOR (audit F2, 2026-11-02) ──────────────────────────
 * `toPoints` refuses every click until `lastShot` is set, and `lastShot` was
 * set ONLY by `screenshot()`. The brokered-remote path never calls
 * `screenshot()` — it captures through its own `screencapture` path because it
 * needs raw RGBA, not a downscaled JPEG. So on a real relay session every
 * decoded operator click hit `toPoints`'s "no screenshot geometry yet" guard,
 * returned `{ok:false}`, and was swallowed by the pump's best-effort catch: the
 * click decoded correctly and then silently did nothing. The e2e could not catch
 * it because it asserts the ACTION, not that `computer.click` accepts it.
 *
 * This is deliberately NOT a bypass of that guard. The guard exists because
 * guessing coordinates lands a click in the wrong place, which is worse than a
 * loud refusal — so this primes REAL geometry (the capture's own image size and
 * the display's point size) and lets the normal conversion run, including its
 * aspect reconciliation. If the geometry cannot be reconciled it REFUSES and
 * says so, and the pump logs that instead of pretending input works.
 *
 * `imageWidth/Height` must be the dimensions of the image whose coordinates the
 * OPERATOR is sending — i.e. the fitted/encoded frame, not the native capture.
 */
export async function primeScreenGeometry(
  imageWidth: number,
  imageHeight: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(imageWidth > 0) || !(imageHeight > 0)) {
    return { ok: false, error: 'refusing to prime geometry from empty image dimensions' };
  }
  try {
    const sizeRaw = await runJxa(JXA_RUNNER, ['screen_size', '{}']);
    const size = JSON.parse(sizeRaw);
    const picked = pickScreenSize(
      imageWidth,
      imageHeight,
      Number(size.cgWidth) || 0,
      Number(size.cgHeight) || 0,
      Number(size.nsWidth) || 0,
      Number(size.nsHeight) || 0,
    );
    if (picked.mismatch || !picked.width || !picked.height) {
      return {
        ok: false,
        error: picked.mismatch || 'display geometry unavailable',
      };
    }
    lastShot = {
      imageWidth,
      imageHeight,
      screenWidth: picked.width,
      screenHeight: picked.height,
    };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

function runFile(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, _so, se) =>
      err ? reject(new Error(`${err.message}${se ? ` — ${String(se).slice(-200)}` : ''}`)) : resolve(),
    );
  });
}

async function outputOf(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, so, se) =>
      err ? reject(new Error(`${err.message}${se ? ` — ${String(se).slice(-200)}` : ''}`)) : resolve(String(so || '')),
    );
  });
}

export async function screenshot(): Promise<Observation> {
  const blocked = await guard();
  if (blocked) return blocked;
  const dir = mkdtempSync(join(tmpdir(), 'digby-shot-'));
  const png = join(dir, 'screen.png');
  const jpg = join(dir, 'screen.jpg');
  try {
    // v0.6.1 (cu-diag fix #1): read the display topology FIRST (one JXA spawn
    // — it also carries the frontmost window and the HID idle reading, so the
    // old separate screen_size + frontmost spawns are gone on this path) and
    // capture the display the user is looking at. When the topology read
    // fails (older macOS / bridging glitch) the pre-0.6.1 single-display path
    // below runs byte-for-byte.
    // v0.6.2: the System Events frontmost-window probe runs in PARALLEL as
    // its own osascript (5 s cap, like the legacy `frontmost`) — an
    // Automation stall no longer takes the display list down with it, and a
    // stalled probe only demotes the capture choice to pointer → main.
    let topo: DisplayTopology | null = null;
    let topoReadAt: number | null = null; // when the OS HID idle reading was taken (81105154)
    let probedFront: { app?: string; window?: string; x?: number; y?: number; w?: number; h?: number } | null = null;
    const frontProbe: Promise<any> = frontWindowProbeEnabled()
      ? runJxa(JXA_RUNNER, ['front_window', '{}'], 5000).then((raw) => JSON.parse(raw)).catch((e: any) => {
          const msg = e?.message || String(e);
          // 30d3c366: an Apple Events denial is a TCC GRANT LOSS, not a
          // transient probe miss — stamp it so the run loop opens a re-grant
          // episode naming Automation in the System Settings pane. Without
          // this the loss was invisible (only the soft line below) and the
          // operator chased "flaky input" instead of a missing grant.
          if (isAutomationDenialText(msg)) {
            noteAutomationDenied();
            log(`frontmost window unavailable — Automation (System Events) DENIED: ${msg}`);
          } else {
            log(`frontmost window unavailable (${msg}) — capture falls back to pointer → main`);
          }
          return null;
        })
      : Promise.resolve(null);
    try {
      const parsed = JSON.parse(await runJxa(JXA_RUNNER, ['displays', '{}'], 10000));
      topoReadAt = Date.now(); // the reading inside this payload was taken NOW (81105154)
      topo = normalizeTopology(parsed);
      if (!topo) log('display topology empty — legacy single-display capture');
    } catch (e: any) {
      log(`display topology unavailable (${e?.message || e}) — legacy single-display capture`);
    }
    const fwRaw = await frontProbe;
    if (fwRaw && typeof fwRaw === 'object' && (fwRaw.app || fwRaw.window)) {
      const merged = normalizeTopology({ displays: [{}], frontWindow: fwRaw });
      probedFront = merged ? merged.frontWindow : null;
    }
    if (topo) topo.frontWindow = probedFront;
    const mode = captureModeFromEnv();
    const choice = topo
      ? chooseCaptureDisplay(topo, mode)
      : { display: null, reason: 'legacy', frontmostWindowDisplayId: null, pointerDisplayId: null };
    let chosen: DisplayInfo | null = choice.display;
    let captureReason = choice.reason;
    const displayIndex = chosen ? chosen.index : 1;
    // -D <index>: exactly one display (multi-display would scatter files); -x: no sound.
    await runFile('screencapture', ['-D', String(displayIndex), '-x', png], 15000);
    // 933e6ca4: exit-0 can still be a TCC denial — an orphaned helper gets a
    // well-formed SOLID-BLACK frame at full resolution. Treat it as the
    // screen-permission miss it is (honest status + the fix flow), not as a
    // real observation the vision model would read as "a black screen".
    // Reviewer round 2: NEVER on one frame alone — a sleeping display / black
    // wallpaper is legitimately solid black. Corroborate with a second
    // capture after a display wake nudge; both solid ⇒ the permission miss.
    let solidCapture: boolean | null = null;
    try { solidCapture = pngSolidPlaceholder(readFileSync(png)); } catch { solidCapture = null; }
    if (solidCapture === true) {
      let second: boolean | null = null;
      try { second = await corroboratingCapture(); } catch { second = null; }
      if (convictAfterCorroboration(solidCapture, second)) {
        noteCaptureResult(false);
        return permissionBlock(['screen'], { solidCapture: true });
      }
      // Corroboration failed to confirm (second frame has content, or the
      // second decode said nothing): treat the capture as REAL, not denied —
      // a false conviction is the worse failure (it sends the user to delete
      // a working TCC grant). Fall through and use the first frame below.
    }
    noteCaptureResult(true);
    if (topo && chosen) {
      // Honesty check on the index → display mapping: the PNG's pixel size
      // must be the chosen display's. If it is another display's, the
      // screencapture ordering differs from NSScreen's — re-attribute so the
      // reported displayId and the click origin are the display we ACTUALLY
      // captured (never a guess).
      // v0.6.2: numbers on both sides (normalizeTopology + the JXA backing
      // pixel read) and an integer-scale fallback — the 0.6.1 check compared
      // a number to a bridged STRING and never matched (review blocking #1).
      const pd = pngDimensions(readFileSync(png));
      if (pixelCheckEnabled()) {
        const attributed = attributeCapturedDisplay(topo.displays, chosen, pd);
        if (attributed.how === 'reattributed') {
          const actual = attributed.display;
          log(`capture index ${displayIndex} produced ${pd!.width}×${pd!.height} — that is display ${actual.id} (${actual.name || 'unnamed'}), re-attributing`);
          chosen = actual;
          captureReason = `${choice.reason}:reattributed`;
        } else if (attributed.how === 'ambiguous') {
          log(`captured ${pd!.width}×${pd!.height} is the size of ${attributed.candidates.length} other displays (identical panels) — keeping index ${displayIndex} (display ${chosen.id}); aspect reconciliation decides`);
        } else if (attributed.how === 'unmatched') {
          log(`captured ${pd!.width}×${pd!.height} matches no display's pixel size (chosen ${chosen.pixelWidth}×${chosen.pixelHeight} px / ${chosen.width}×${chosen.height} pt) — aspect reconciliation decides`);
        }
      }
    }
    await runFile('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(JPEG_QUALITY), '-Z', String(SCREENSHOT_MAX_DIM), png, '--out', jpg], 20000);
    const dims = await outputOf('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', jpg], 10000);
    const iw = Number(/pixelWidth:\s*(\d+)/.exec(dims)?.[1] || 0);
    const ih = Number(/pixelHeight:\s*(\d+)/.exec(dims)?.[1] || 0);
    const buf = readFileSync(jpg);

    let picked: { width: number; height: number; mismatch?: string };
    let originX = 0, originY = 0;
    let front: { app?: string; window?: string } = {};
    if (topo && chosen) {
      // v0.4.3 reconciliation, now against the CAPTURED display: its point
      // size must match the image's aspect; the main display is the self-heal
      // candidate (a wrong -D ordering that the pixel check could not settle).
      const main = topo.displays.find((d) => d.id === topo!.main) || chosen;
      picked = pickScreenSize(iw, ih, chosen.width, chosen.height, main.width, main.height);
      if (picked.mismatch) log(`geometry mismatch — ${picked.mismatch}`);
      if (picked.width === chosen.width && picked.height === chosen.height) {
        originX = chosen.x; originY = chosen.y;
      } else if (picked.width === main.width && picked.height === main.height) {
        log(`geometry self-heal: captured frame matches the MAIN display ${main.width}×${main.height}, not display ${chosen.id} — using main`);
        chosen = main; originX = main.x; originY = main.y; captureReason = `${captureReason}:main-healed`;
      }
      front = { app: topo.frontWindow?.app || undefined, window: topo.frontWindow?.window || undefined };
    } else {
      // Legacy single-display path (pre-0.6.1, byte-for-byte): CG main vs
      // NSScreen main reconciled against the image aspect.
      const sizeRaw = await runJxa(JXA_RUNNER, ['screen_size', '{}']);
      const size = JSON.parse(sizeRaw);
      picked = pickScreenSize(iw, ih, Number(size.cgWidth) || 0, Number(size.cgHeight) || 0, Number(size.nsWidth) || 0, Number(size.nsHeight) || 0);
      if (picked.mismatch) log(`geometry mismatch — ${picked.mismatch}`);
      if (picked.width !== (Number(size.width) || 0)) {
        log(`geometry self-heal: using ${picked.width}×${picked.height} (screen_size primary was ${size.width}×${size.height})`);
      }
      // v0.4.1: name the frontmost app/window with every screenshot so the model
      // grounds in what the user is ALREADY using (their Chrome, their Mail…)
      // and the side panel can label the live view. Best-effort — never fails the shot.
      if (probedFront) {
        // v0.6.2: the parallel front_window probe already answered — no second spawn.
        front = { app: probedFront.app || undefined, window: probedFront.window || undefined };
      } else if (frontWindowProbeEnabled()) {
        try {
          const f = JSON.parse(await runJxa(JXA_RUNNER, ['frontmost', '{}'], 5000));
          front = { app: f.app || undefined, window: f.window || undefined };
        } catch { /* no frontmost info — the screenshot still stands */ }
      }
    }
    lastShot = {
      imageWidth: iw,
      imageHeight: ih,
      screenWidth: picked.width,
      screenHeight: picked.height,
      ...(picked.mismatch ? { geometryMismatch: picked.mismatch } : {}),
      ...(chosen ? { originX, originY, displayId: chosen.id } : {}),
    };

    // v0.6.1 (cu-diag fix #6): owner-presence facts. HID idle from the CG
    // reading (ioreg fallback), minus this agent's own posted events; a
    // remote-control session hint from the display names + process table.
    // 81105154: classification uses the READING's clock (topoReadAt / the
    // ioreg read stamp), not the pipeline-end clock — the drift between the
    // two (screencapture + sips + the front-window probe) is what let the
    // agent's own input escape the own-input ledger and read as "human".
    let rawIdle: number | null = topo && typeof topo.hidIdleRaw === 'number' ? topo.hidIdleRaw : null;
    let idleReadAt: number | null = topoReadAt;
    if (rawIdle === null) {
      const io = await ioregHidIdleSeconds();
      rawIdle = io.sec;
      idleReadAt = io.readAt;
    }
    const idle = classifyHidReading(rawIdle, idleReadAt, Date.now(), ownInputIntervals, lastHumanEventAt);
    lastHumanEventAt = idle.lastHuman;
    const remoteKinds = await remoteSessionKinds(topo ? topo.displays : []);

    return {
      ok: true,
      screenshotBase64: buf.toString('base64'),
      imageWidth: iw,
      imageHeight: ih,
      screenWidth: lastShot.screenWidth,
      screenHeight: lastShot.screenHeight,
      ...(picked.mismatch ? { geometryWarning: picked.mismatch } : {}),
      frontmostApp: front.app,
      frontmostWindow: front.window,
      ...(chosen
        ? {
            displayId: chosen.id,
            displayIndex: chosen.index,
            displayCount: topo ? topo.displays.length : 1,
            displayName: chosen.name || undefined,
            frontmostWindowDisplayId: choice.frontmostWindowDisplayId,
            pointerDisplayId: choice.pointerDisplayId,
            captureReason,
          }
        : { captureReason: 'legacy' }),
      hidIdleSeconds: idle.idle === null ? null : Math.round(idle.idle * 10) / 10,
      hidIdleRawSeconds: rawIdle === null ? null : Math.round(rawIdle * 10) / 10,
      remoteSession: { active: remoteKinds.length > 0, kinds: remoteKinds },
    };
  } catch (e: any) {
    const msg = e?.message || String(e);
    // Ground truth beats preflight: screencapture's "could not create image from
    // display" is the canonical TCC denial for Screen Recording — observed live
    // (2026-08-31): CGPreflightScreenCaptureAccess() false-positived (preflight
    // said "granted" while the user's TCC.db held zero ScreenCapture rows), which
    // let the failure bypass the guidance dialog entirely. Trust the capture.
    if (/could not create image from display/i.test(msg)) {
      noteCaptureResult(false);
      permCache = null; // force a fresh check once the user grants
      return permissionBlock(['screen']);
    }
    if (looksPermissiony(msg)) { permCache = null; return (await guard()) || { ok: false, error: msg }; }
    return { ok: false, error: `screenshot failed: ${msg}` };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp litter is harmless */ }
  }
}

// ── Input actions ─────────────────────────────────────────────────────────────

/** Convert image-pixel coords (what the model sees) to CG points using the
 *  cached screenshot geometry. Clicks BEFORE any screenshot are rejected —
 *  and so are clicks whose screenshot geometry could not be reconciled with
 *  the display (v0.4.3, ticket 4e4d56ff): guessing would land the click at
 *  wrong coordinates, which is strictly worse than a loud error. */
function toPoints(x: number, y: number): { px: number; py: number } | { error: string } {
  if (!lastShot || !lastShot.imageWidth || !lastShot.screenWidth) {
    return { error: 'no screenshot geometry yet — take a screenshot before clicking' };
  }
  if (lastShot.geometryMismatch) {
    return { error: `unreliable screen geometry (${lastShot.geometryMismatch}) — refusing to guess click coordinates; take a fresh screenshot` };
  }
  return screenPointFor(x, y, lastShot);
}

async function action(obs: () => Promise<Observation>): Promise<Observation> {
  const blocked = await guard();
  if (blocked) return blocked;
  try {
    return await obs();
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (looksPermissiony(msg)) { permCache = null; return (await guard()) || { ok: false, error: msg }; }
    return { ok: false, error: msg };
  }
}

export async function click(x: number, y: number, button: 'left' | 'right' = 'left', clicks = 1): Promise<Observation> {
  return action(async () => {
    const c = toPoints(x, y);
    if ('error' in c) return { ok: false, error: c.error };
    const t0 = Date.now();
    const out = await runJxa(JXA_RUNNER, ['click', JSON.stringify({ x: c.px, y: c.py, button, clicks })]);
    markOwnInput(t0); // the move (even a mis-land) posted HID events
    const r = JSON.parse(out);
    if (r.misland === true) {
      // v0.6.0 (ticket 2f646c10): a VERIFIED mis-land — the only provable
      // dead-input fact a click refusal can carry. Guard/geometry/permission
      // errors never set misland, so they feed the latch nothing.
      noteMoveResult(false);
      return { ok: false, error: r.error };
    }
    if (r.error) return { ok: false, error: r.error };
    // v0.4.3: surface the verified cursor landing so the loop has ground truth.
    // v0.6.0 (ticket 2f646c10): on a SUCCESSFUL click the landing was verified
    // (a verifiable mis-land returned early above), so cursorVerified:false here
    // can only mean the read-back was unavailable — UNVERIFIABLE (null), never
    // a mis-land. noteMoveResult stays on the node side, right where the JXA
    // moveAndVerify result is received.
    noteMoveResult(r.cursorVerified === true ? true : null);
    if (r.cursorVerified !== true && r.cursor) log(`click cursor read-back unavailable at (${r.cursor}) — landing unverified (not counted as dead input)`);
    // 746c4d4f: an inherited modifier at click time is the proof that THIS
    // click would have arrived as a right-click. Surface it to the caller
    // (and the agent log) instead of discarding the JXA field one frame up —
    // the reported defect was undiagnosable precisely because nothing said it.
    if (typeof r.clearedModifiers === 'number' && r.clearedModifiers !== 0) {
      log(`click: cleared inherited modifier flags 0x${r.clearedModifiers.toString(16)} before clicking — this click would otherwise have been corrupted (ticket 746c4d4f)`);
    }
    return { ok: true, ...lastShot, frontmostApp: undefined, clearedModifiers: typeof r.clearedModifiers === 'number' ? r.clearedModifiers : undefined };
  });
}

export async function typeText(text: string): Promise<Observation> {
  return action(async () => {
    if (!text) return { ok: false, error: 'type requires text' };
    // v0.4.2 (ticket cbaf3e08): plan real keycode steps in TS (testable) and let
    // the JXA runner just execute them — see computer-keymap.ts for why the old
    // UnicodeString-only path garbled every char to 'a' on macOS 26.
    const steps = typeStepsFor(text);
    // Scale the timeout with length (each char is two posted events + pacing).
    const t0 = Date.now();
    const out = await runJxa(JXA_RUNNER, ['type', JSON.stringify({ steps })], Math.min(60000, OSASCRIPT_TIMEOUT_MS + text.length * 20));
    markOwnInput(t0);
    const r = JSON.parse(out);
    if (r.error) return { ok: false, error: r.error };
    if (r.fallback) log(`type: ${r.fallback} char(s) went through the best-effort unicode fallback (outside US-ANSI map)`);
    return { ok: true };
  });
}

export async function keyPress(key: string, modifiers: string[] = []): Promise<Observation> {
  return action(async () => {
    const t0 = Date.now();
    const out = await runJxa(JXA_RUNNER, ['key', JSON.stringify({ key, modifiers })]);
    markOwnInput(t0);
    const r = JSON.parse(out);
    if (typeof r.clearedModifiers === 'number' && r.clearedModifiers !== 0) {
      log(`key ${key}: cleared inherited modifier flags 0x${r.clearedModifiers.toString(16)} before the chord — it would otherwise have been corrupted (ticket 746c4d4f)`);
    }
    return r.error ? { ok: false, error: r.error } : { ok: true, clearedModifiers: typeof r.clearedModifiers === 'number' ? r.clearedModifiers : undefined };
  });
}

export async function scroll(direction: 'up' | 'down' = 'down', amount = 10, x?: number, y?: number): Promise<Observation> {
  return action(async () => {
    const params: Record<string, unknown> = { direction, amount };
    // v0.4.3 (ticket 4e4d56ff): optional target — the pointer is moved (and
    // verified) at the converted point BEFORE the wheel event, so the scroll
    // affects the content the model pointed at. Without x/y the legacy
    // behavior stands (scroll whatever is under the current cursor).
    if (typeof x === 'number' && typeof y === 'number') {
      const c = toPoints(x, y);
      if ('error' in c) return { ok: false, error: c.error };
      params.x = c.px;
      params.y = c.py;
    }
    const t0 = Date.now();
    const out = await runJxa(JXA_RUNNER, ['scroll', JSON.stringify(params)]);
    markOwnInput(t0);
    const r = JSON.parse(out);
    // v0.6.0 (ticket 2f646c10): a targeted scroll's VERIFIED mis-land refusal is
    // provable dead input — same evidence class as a click refusal. A
    // SUCCESSFUL scroll feeds the latch only a confirmed landing (true) or
    // nothing (null: untargeted, or the read-back was unavailable). An error
    // without misland carries no move-verification fact.
    if (r.misland === true) {
      noteMoveResult(false);
      return { ok: false, error: r.error };
    }
    if (r.error) return { ok: false, error: r.error };
    noteMoveResult(r.cursorVerified === true ? true : null);
    if (typeof r.clearedModifiers === 'number' && r.clearedModifiers !== 0) {
      log(`scroll: cleared inherited modifier flags 0x${r.clearedModifiers.toString(16)} — the wheel would otherwise have arrived as a zoom/pan (ticket 746c4d4f)`);
    }
    return { ok: true, clearedModifiers: typeof r.clearedModifiers === 'number' ? r.clearedModifiers : undefined };
  });
}

export async function openApp(target: string): Promise<Observation> {
  return action(async () => {
    if (!target) return { ok: false, error: 'open requires an app name or URL' };
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.includes('@');
    try {
      if (isUrl) await runFile('open', [target], 15000);
      else await runFile('open', ['-a', target], 15000);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: `open "${target}" failed: ${e?.message || e}` };
    }
  });
}

export async function frontmost(): Promise<Observation> {
  return action(async () => {
    const out = await runJxa(JXA_RUNNER, ['frontmost', '{}']);
    const r = JSON.parse(out);
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, frontmostApp: r.app || undefined, frontmostWindow: r.window || undefined };
  });
}
