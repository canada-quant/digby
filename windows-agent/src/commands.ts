/**
 * Windows agent command surface (W0, 2026-09-25).
 *
 * Mirrors the macOS agent's execute() contract: the backend dispatches
 * `computer_<action>` and `browser_*` commands; each handler returns an
 * Observation-shaped object and NEVER throws into the run loop (stability
 * over strictness — a failed action is a result, not a crash).
 *
 * This module is PURE orchestration over the win-platform seam — no Win32
 * calls, no I/O. It runs (and is unit-tested) on Linux CI; the seam's null
 * implementation makes every computer_* command refuse with a clear
 * "not yet implemented (W1)" error, which is exactly what the W0 milestone
 * ships: the protocol + pairing + dispatch, with the FFI layer to come.
 *
 * Browser commands (W1, Playwright) route to browser.ts — also stubbed at W0
 * with the same refuse-with-reason contract.
 */

import {
  Win32Surface,
  Win32Input,
  imageToScreen,
  resolveKey,
  resolveModifier,
  typeStepsFor,
  validateGeometry,
  VirtualScreenGeometry,
  WinKeySpec,
} from './win-platform';
import {
  RustHelperClient,
  HelperProtocolError,
  HelperWin32Surface,
  HelperWin32Input,
  uiaTree,
  uiaInvoke,
  environmentCheck,
  REFUSAL_CODES,
} from './rust-helper';
import {
  SafetyGate,
  refusalError,
  drmWarningLine,
  drmSuspectedAgent,
  mergeAntiCheatList,
} from './safety';

export interface Observation {
  ok: boolean;
  action: string;
  /** base64 JPEG of the (downscaled) screen — screenshot action only */
  screenshotBase64?: string;
  imageWidth?: number;
  imageHeight?: number;
  /** Physical pixel size of the monitor (SendInput's coordinate space). */
  screenWidth?: number;
  screenHeight?: number;
  frontmostApp?: string;
  frontmostWindow?: string;
  /** UIA perception (computer_uia_tree): the compact linearized tree the
   *  model reads, the JSON tree, and the bounded node count. */
  uiaText?: string;
  uiaTreeData?: unknown;
  uiaNodeCount?: number;
  /** Warnings (never errors) embedded in the observation — e.g. the
   *  UIA_W_DRM_SUSPECTED line when a capture looks DRM-obscured. */
  warning?: string;
  error?: string;
}

const SCREENSHOT_MAX_DIM = 1568;
const JPEG_QUALITY = 75;
/** Click verify-or-refuse: after moving, read the cursor back; allow this
 *  much drift before retrying (physical px — generous for high-DPI). */
const CLICK_VERIFY_TOLERANCE_PX = 2;
/** Modifier-clearing pre-sweep runs before every planned input sequence. */

export interface CommandHandlers {
  surface: Win32Surface;
  input: Win32Input;
  browser?: BrowserCommandHandlers;
  /** W3: the Rust helper client (UIA + safety probes). When present, the
   *  uia_* perception actions and the safety preflights are live; when
   *  absent (helper spawn refused / non-Windows) they refuse with a clear
   *  actionable error instead of crashing. */
  helper?: RustHelperClient;
  /** W3: safety gate (elevation/secure-desktop/anti-cheat preflights).
   *  Optional for test seams; commands.ts constructs one from the helper
   *  when only `helper` is provided. */
  safety?: SafetyGate;
}

/** W1: the Playwright persistent-profile browser (ports nearly verbatim from
 *  imessage-agent/src/browser.ts — profile at %LOCALAPPDATA%\Digby\browser-profile). */
export interface BrowserCommandHandlers {
  [method: string]: (params: Record<string, unknown>) => Promise<unknown>;
}

function err(action: string, error: string): Observation {
  return { ok: false, action, error };
}

/** Verify-or-refuse cursor read-back: move, read, retry once, refuse blind clicks. */
async function moveToVerified(input: Win32Input, x: number, y: number): Promise<string | null> {
  await input.moveTo(x, y);
  let pos = await input.cursorPos();
  const arrived = (p: { x: number; y: number }) =>
    Math.abs(p.x - x) <= CLICK_VERIFY_TOLERANCE_PX && Math.abs(p.y - y) <= CLICK_VERIFY_TOLERANCE_PX;
  if (pos && arrived(pos)) return null;
  await input.moveTo(x, y); // one retry
  pos = await input.cursorPos();
  if (pos && arrived(pos)) return null;
  return `cursor read-back mismatch: moved to (${x},${y}) but read ${pos ? `(${pos.x},${pos.y})` : 'null'} — refusing to click blind (verify-or-refuse contract)`;
}

/** Verify-or-refuse, origin edition (PR #1048 review N1). Fold the
 *  virtual-screen origin into the geometry cache after a capture.
 *
 *  Three cases, all WITHOUT failing the screenshot itself (a capture that
 *  succeeded must never be dropped because an auxiliary probe failed):
 *   1. surface.geometry absent          → single-monitor seam contract: the
 *      capture region IS the primary monitor, origin (0,0) — map normally.
 *   2. geometry() available + valid     → fold x/y in, clear originUnknown.
 *   3. surface exposes geometry() but it returns null / throws / carries a
 *      degenerate snapshot (validateGeometry refuses) → stamp originUnknown
 *      with the cause. Coordinate actions (click, targeted scroll) then
 *      REFUSE instead of silently assuming origin (0,0) — on a multi-monitor
 *      desktop with a left/above secondary, that assumption clicks the
 *      WRONG monitor and the injected coordinates still verify (verify-
 *      or-refuse checks the cursor, not the semantic target). Mirrors the
 *      macOS agent's geometryMismatch contract (imessage-agent
 *      computer.ts toPoints: "refusing to guess click coordinates").
 *
 *  A snapshot whose size DISAGREES with the monitorSize() reading used for
 *  the capture (a topology change mid-shot — monitor unplugged, resolution
 *  flip) is treated as origin-unknown too: the cached origin would be stale
 *  by the time it is used. */
async function foldOrigin(
  surface: Win32Surface,
  geometry: GeometryCache,
  size: { width: number; height: number },
): Promise<void> {
  delete geometry.vx;
  delete geometry.vy;
  delete geometry.originUnknown;
  if (typeof surface.geometry !== 'function') return; // case 1
  let g: VirtualScreenGeometry | null = null;
  let cause: string | null = null;
  try {
    g = await surface.geometry();
  } catch (e: any) {
    cause = e?.message || String(e);
  }
  if (!g) {
    geometry.originUnknown = cause
      ? `virtual-screen geometry probe failed: ${cause}`
      : 'virtual-screen geometry unavailable (null probe)';
    return; // case 3
  }
  const v = validateGeometry(g);
  if ('error' in v) {
    geometry.originUnknown = `invalid virtual-screen geometry snapshot: ${v.error}`;
    return; // case 3
  }
  if (v.width !== size.width || v.height !== size.height) {
    geometry.originUnknown = `virtual-screen size changed mid-shot (${v.width}x${v.height} vs capture ${size.width}x${size.height})`;
    return; // case 3
  }
  geometry.vx = v.x; // case 2
  geometry.vy = v.y;
}

/** Last-screenshot geometry (image dims + captured-region size) for
 *  coordinate mapping. W1: vx/vy carry the virtual-screen origin for
 *  multi-monitor captures (absent on single-monitor surfaces). */
export interface GeometryCache {
  imageWidth: number;
  imageHeight: number;
  screenWidth: number;
  screenHeight: number;
  /** Virtual-screen origin (physical px; negative when a monitor sits
   *  left-of/above the primary). Optional — single-monitor setups omit it. */
  vx?: number;
  vy?: number;
  /** Non-empty when the surface EXPOSES geometry() but the origin could not
   *  be verified at screenshot time (probe failed/threw, degenerate
   *  snapshot, or a topology change mid-shot). Coordinate actions then
   *  REFUSE rather than fall back to origin (0,0) — on a multi-monitor
   *  desktop that silent fallback clicks the WRONG monitor (PR #1048
   *  review N1). Cleared on every screenshot that verifies the origin. */
  originUnknown?: string;
}

/**
 * Execute one computer_* command against the seam. `geometry` carries the
 * last screenshot's dims so clicks/scroll-xy in IMAGE space convert to
 * physical pixels with aspect reconciliation; it is mutated on screenshot.
 */
export async function executeComputer(
  method: string,
  params: Record<string, unknown>,
  deps: CommandHandlers,
  geometry: GeometryCache,
): Promise<Observation> {
  const action = method.replace(/^computer_/, '');
  const { surface, input } = deps;

  /** W3 safety gate (elevation/secure-desktop/anti-cheat preflights over
   *  the helper's environment_check). Constructed lazily from deps.helper
   *  when only the helper is wired (index.ts); test seams may inject a
   *  scripted safety gate directly. */
  const gate: SafetyGate | null =
    deps.safety ??
    (deps.helper ? new SafetyGate({ environment: () => environmentCheck(deps.helper!) }) : null);

  /** Helper refusal (frozen UIA_* codes) → the wire error string, relayed
   *  VERBATIM: '<CODE>: <human guidance>'. */
  const helperError = (e: any): string =>
    e instanceof HelperProtocolError || typeof e?.code === 'string'
      ? `${e.code}: ${e.message}`
      : e?.message || String(e);

  /** Preflight for INPUT actions (elevation, secure desktop, anti-cheat).
   *  Returns the wire error string or null to proceed. */
  const inputRefusal = async (): Promise<string | null> => {
    if (!gate) return null;
    try {
      const secure = await gate.secureDesktopRefusal();
      if (secure) return secure;
      const antiCheat = await gate.antiCheatRefusal();
      if (antiCheat) return antiCheat;
      return await gate.elevationRefusal();
    } catch {
      return null; // preflight itself failed — let the action's own error speak
    }
  };

  /** Preflight for CAPTURE actions (secure desktop, anti-cheat). */
  const captureRefusal = async (): Promise<string | null> => {
    if (!gate) return null;
    try {
      const secure = await gate.secureDesktopRefusal();
      if (secure) return secure;
      return await gate.antiCheatRefusal();
    } catch {
      return null;
    }
  };

  switch (action) {
    case 'ping':
      return { ok: true, action };

    case 'screenshot': {
      try {
        const refused = await captureRefusal();
        if (refused) return err(action, refused);
        const shot = await surface.captureJpeg(SCREENSHOT_MAX_DIM, JPEG_QUALITY);
        const size = await surface.monitorSize();
        geometry.imageWidth = shot.width;
        geometry.imageHeight = shot.height;
        geometry.screenWidth = size.width;
        geometry.screenHeight = size.height;
        // Multi-monitor: fold the virtual-screen origin in so clicks map
        // into virtual-screen coordinates (moveTo normalizes via VIRTUALDESK).
        // NEVER throws (a failed origin probe must not fail an otherwise good
        // capture) and NEVER silently falls back to origin (0,0): when the
        // surface exposes geometry() but it is unavailable, later coordinate
        // actions refuse instead (PR #1048 review N1).
        await foldOrigin(surface, geometry, size);
        const front = await surface.frontmost();
        // W3 DRM heuristic: a uniform-black foreground rect in the captured
        // frame → the UIA_W_DRM_SUSPECTED WARNING line in the observation
        // text (never a refusal — the screenshot is still delivered; the
        // model can fall back to computer_uia_tree).
        let warning: string | undefined;
        try {
          const cap = (surface as HelperWin32Surface).lastCapture;
          if (cap && deps.helper) {
            // Prefer the helper's frame-side verdict (computed in the same
            // response — no extra round-trip); the agent-side heuristic is
            // the fallback for older helpers without the field.
            let suspected: boolean;
            if (typeof cap.drmSuspected === 'boolean') {
              suspected = cap.drmSuspected;
            } else {
              const env = await environmentCheck(deps.helper);
              suspected = drmSuspectedAgent(cap.bgra, cap.width, cap.height, env.foreground_rect);
            }
            if (suspected) {
              warning = drmWarningLine();
            }
          }
        } catch {
          /* the heuristic is best-effort — never fails a good capture */
        }
        return {
          ok: true,
          action,
          screenshotBase64: shot.base64,
          imageWidth: shot.width,
          imageHeight: shot.height,
          screenWidth: size.width,
          screenHeight: size.height,
          ...(warning ? { warning } : {}),
          ...(front ? { frontmostApp: front.app, frontmostWindow: front.window } : {}),
        };
      } catch (e: any) {
        return err(action, `screen capture failed: ${e?.message || e}`);
      }
    }

    case 'frontmost': {
      try {
        const front = await surface.frontmost();
        if (!front) return err(action, 'no foreground window');
        return { ok: true, action, frontmostApp: front.app, frontmostWindow: front.window };
      } catch (e: any) {
        return err(action, `frontmost lookup failed: ${e?.message || e}`);
      }
    }

    case 'click': {
      const x = Number(params.x);
      const y = Number(params.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return err(action, 'x and y are required (image-pixel coordinates)');
      const mapped = imageToScreen(x, y, geometry);
      if ('error' in mapped) return err(action, mapped.error);
      try {
        const refused = await inputRefusal();
        if (refused) return err(action, refused);
        await input.clearModifiers();
        const fail = await moveToVerified(input, mapped.x, mapped.y);
        if (fail) return err(action, fail);
        const button = params.button === 'right' ? 'right' : 'left';
        await input.mouseDown(button);
        await input.mouseUp(button);
        if (Number(params.clicks) === 2) {
          // double-click = two full down/up cycles (the macOS contract).
          await input.mouseDown(button);
          await input.mouseUp(button);
        }
        // Post-action screenshot (the macOS contract: the model ALWAYS sees
        // the result of its last action) — the driver-level loop handles this
        // in the backend; the observation carries the landing coordinates.
        return { ok: true, action, x: mapped.x, y: mapped.y } as Observation;
      } catch (e: any) {
        return err(action, `${e?.code ? `${e.code}: ` : ''}${e?.message || e}`);
      }
    }

    case 'type': {
      const text = String(params.text ?? '');
      if (!text) return err(action, 'text is required');
      try {
        const refused = await inputRefusal();
        if (refused) return err(action, refused);
        await input.clearModifiers();
        for (const step of typeStepsFor(text)) {
          if (step.k === 'key') {
            await input.keyDown(step.spec);
            await input.keyUp(step.spec);
          } else {
            await input.unicodeChar(step.ch);
          }
        }
        return { ok: true, action } as Observation;
      } catch (e: any) {
        return err(action, `${e?.code ? `${e.code}: ` : ''}${e?.message || e}`);
      }
    }

    case 'key': {
      const keyName = String(params.key ?? '');
      if (!keyName) return err(action, 'key is required');
      const spec = resolveKey(keyName);
      if (!spec) return err(action, `unknown key: ${keyName}`);
      const modifiers = Array.isArray(params.modifiers) ? params.modifiers.map(String) : [];
      const modSpecs: WinKeySpec[] = [];
      for (const m of modifiers) {
        const mod = resolveModifier(m);
        if (!mod) return err(action, `unknown modifier: ${m}`);
        modSpecs.push(mod);
      }
      try {
        const refused = await inputRefusal();
        if (refused) return err(action, refused);
        await input.clearModifiers();
        for (const m of modSpecs) await input.keyDown(m);
        await input.keyDown(spec);
        await input.keyUp(spec);
        for (let i = modSpecs.length - 1; i >= 0; i--) await input.keyUp(modSpecs[i]);
        return { ok: true, action } as Observation;
      } catch (e: any) {
        return err(action, `${e?.code ? `${e.code}: ` : ''}${e?.message || e}`);
      }
    }

    case 'scroll': {
      const direction = params.direction === 'up' ? 'up' : 'down';
      const amount = Math.max(1, Math.min(20, Number(params.amount) || 3));
      let target: { x: number; y: number } | null = null;
      if (params.x !== undefined && params.y !== undefined) {
        const mapped = imageToScreen(Number(params.x), Number(params.y), geometry);
        if ('error' in mapped) return err(action, mapped.error);
        target = { x: mapped.x, y: mapped.y };
      }
      try {
        const refused = await inputRefusal();
        if (refused) return err(action, refused);
        await input.clearModifiers();
        if (target) {
          const fail = await moveToVerified(input, target.x, target.y);
          if (fail) return err(action, fail);
        }
        await input.scroll(direction === 'up' ? amount : -amount);
        return { ok: true, action } as Observation;
      } catch (e: any) {
        return err(action, `${e?.code ? `${e.code}: ` : ''}${e?.message || e}`);
      }
    }

    case 'open': {
      const target = String(params.target ?? '');
      if (!target) return err(action, 'target is required (app name or URL)');
      try {
        await input.open(target);
        return { ok: true, action } as Observation;
      } catch (e: any) {
        return err(action, `${e?.code ? `${e.code}: ` : ''}${e?.message || e}`);
      }
    }

    // ── W3: UIA perception (the semantic-tree alternative to pixels) ──────

    case 'uia_tree': {
      if (!deps.helper) {
        return err(action, 'UIA perception unavailable — the Digby Windows helper (digby-win-helper.exe) is not running; computer_uia_tree needs the W3 agent bundle (reinstall Digby) or a manual DIGBY_WIN_HELPER path');
      }
      // Root validation is the AGENT's job (mirrors the helper's
      // clamp_tree_params): an invalid root refuses, never silently coerced.
      if (params.root !== undefined && params.root !== 'foreground' && params.root !== 'desktop') {
        return err(action, `invalid root: ${params.root} (expected 'foreground' or 'desktop')`);
      }
      const root = params.root === 'desktop' ? 'desktop' : 'foreground';
      const maxDepth = params.max_depth === undefined ? undefined : Number(params.max_depth);
      const maxNodes = params.max_nodes === undefined ? undefined : Number(params.max_nodes);
      if (maxDepth !== undefined && (!Number.isFinite(maxDepth) || maxDepth < 1 || maxDepth > 32)) {
        return err(action, 'max_depth must be a number 1..32');
      }
      if (maxNodes !== undefined && (!Number.isFinite(maxNodes) || maxNodes < 1 || maxNodes > 2000)) {
        return err(action, 'max_nodes must be a number 1..2000');
      }
      try {
        const r = await uiaTree(deps.helper, { root, max_depth: maxDepth, max_nodes: maxNodes });
        return {
          ok: true,
          action,
          uiaText: r.text,
          uiaTreeData: r.tree,
          uiaNodeCount: r.node_count,
        };
      } catch (e: any) {
        return err(action, helperError(e));
      }
    }

    case 'uia_invoke': {
      if (!deps.helper) {
        return err(action, 'UIA perception unavailable — the Digby Windows helper (digby-win-helper.exe) is not running; computer_uia_invoke needs the W3 agent bundle (reinstall Digby) or a manual DIGBY_WIN_HELPER path');
      }
      const runtimeId = Array.isArray(params.runtime_id) ? params.runtime_id.map(Number) : null;
      if (!runtimeId || runtimeId.length === 0 || runtimeId.some((n) => !Number.isFinite(n))) {
        return err(action, 'runtime_id is required (a non-empty number[] from computer_uia_tree)');
      }
      const pattern = String(params.pattern ?? '');
      const patterns = ['invoke', 'toggle', 'expand', 'select', 'focus', 'set_value'];
      if (!patterns.includes(pattern)) {
        return err(action, `pattern must be one of ${patterns.join('|')}`);
      }
      if (pattern === 'set_value' && (typeof params.value !== 'string' || params.value === '')) {
        return err(action, 'set_value requires a value string');
      }
      // SAFETY PREFLIGHT (review B3): uia_invoke DRIVES the UI (invoke/
      // toggle/expand/select/set_value/focus all act on elements) — the
      // same input-action refusals apply. Without this the secure-desktop/
      // anti-cheat/elevation gates were bypassable via UIA.
      try {
        const refused = await inputRefusal();
        if (refused) return err(action, refused);
      } catch {
        /* preflight itself failed — let the invoke's own error speak */
      }
      try {
        await uiaInvoke(deps.helper, {
          runtime_id: runtimeId,
          pattern: pattern as 'invoke',
          ...(pattern === 'set_value' ? { value: String(params.value) } : {}),
        });
        // The backend driver follows up with computer_screenshot exactly as
        // after click/type — the helper does NOT capture on invoke.
        return { ok: true, action } as Observation;
      } catch (e: any) {
        return err(action, helperError(e));
      }
    }

    default:
      return err(action, `unknown computer action: ${action}`);
  }
}

/** Execute one browser_* command (W1 — Playwright persistent profile). */
export async function executeBrowser(
  method: string,
  params: Record<string, unknown>,
  deps: CommandHandlers,
): Promise<unknown> {
  if (deps.browser && typeof deps.browser[method] === 'function') {
    return deps.browser[method](params);
  }
  throw new Error(`browser command not yet available: ${method}`);
}

/** Top-level dispatch: computer_* / browser_* / future surfaces. */
export async function executeCommand(
  method: string,
  params: Record<string, unknown>,
  deps: CommandHandlers,
  geometry: GeometryCache,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    if (method.startsWith('computer_')) {
      const obs = await executeComputer(method, params, deps, geometry);
      return obs.ok ? { ok: true, result: obs } : { ok: false, error: obs.error || 'computer action failed' };
    }
    if (method.startsWith('browser_')) {
      const result = await executeBrowser(method, params, deps);
      return { ok: true, result };
    }
    if (method === 'ping') return { ok: true, result: { ok: true, action: 'ping' } };
    return { ok: false, error: `unknown method: ${method}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
