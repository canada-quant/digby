/**
 * Agent-side safety wiring (W3, roadmap §2.3/§2.10): the preflights that
 * run BEFORE computer input/capture actions and the refusal codes they
 * surface. PURE over injected probes — every check takes a thunk, so the
 * whole surface unit-tests on Linux with scripted fakes.
 *
 * The refusal codes are the FROZEN W3 wire contract (see
 * rust-helper/src/protocol.rs for the helper's mirror + canonical guidance):
 *   UIA_E_ELEVATED        — window-under-point process elevated (UIPI)
 *   UIA_E_SECURE_DESKTOP  — UAC prompt / lock screen active
 *   UIA_E_ANTICHEAT       — foreground process on the refusal list
 *   UIA_W_DRM_SUSPECTED   — WARNING prefix in observation text (never an
 *                           error result): uniform-black foreground rect.
 */

import { REFUSAL_CODES, EnvironmentCheck } from './rust-helper';

/** Canonical human guidance per refusal code — kept in lockstep with the
 *  helper's protocol.rs guidance() (the agent produces these BEFORE the
 *  helper is involved; the helper produces them for its own refusals). */
export const REFUSAL_GUIDANCE: Record<string, string> = {
  [REFUSAL_CODES.ELEVATED]:
    'the foreground window belongs to an elevated (admin) process, so Windows UIPI blocks synthetic input; ask the user to run the app non-elevated or perform this step by hand',
  [REFUSAL_CODES.SECURE_DESKTOP]:
    'a secure desktop (UAC prompt or lock screen) is active, so the screen cannot be captured or driven; wait for the user to dismiss it',
  [REFUSAL_CODES.DRM]:
    'the target window refuses screen capture (DRM-protected or exclusive-fullscreen content); use computer_uia_tree to perceive it structurally instead',
  [REFUSAL_CODES.ANTICHEAT]:
    "the foreground process is protected by anti-cheat, so capture and input are refused to protect the user's account; ask the user to close the game first",
  [REFUSAL_CODES.NOT_FOUND]:
    'the element is gone (the UI tree changed since the last computer_uia_tree); take a fresh tree and retry with the new runtime_id',
  [REFUSAL_CODES.UNSUPPORTED]:
    'that pattern is not implemented by this element; inspect its role in the tree and pick a pattern it supports',
};

/** The full wire error string: '<CODE>: <human guidance>' — what an
 *  Observation.error carries for a refusal. */
export function refusalError(code: string, detail?: string): string {
  const guidance = REFUSAL_GUIDANCE[code] || 'the Windows helper could not complete this action';
  return detail ? `${code}: ${guidance} (${detail})` : `${code}: ${guidance}`;
}

/** The DRM-suspected WARNING line (embedded in observation text, NOT an
 *  error — the screenshot is still delivered). */
export function drmWarningLine(): string {
  return `${REFUSAL_CODES.DRM_SUSPECTED_WARNING}: the foreground window's pixels are uniformly black in the capture — likely DRM-protected or refusing pixel capture; use computer_uia_tree for structural perception of this window`;
}

// ── Anti-cheat refusal list ─────────────────────────────────────────────────

/** Default anti-cheat foreground-process refusal list (roadmap W3). These
 *  are the well-known anti-cheat services that run games' protected
 *  processes; driving them (or a game they protect) risks the user's
 *  account. Merged with config.json antiCheatProcesses[]. */
export const DEFAULT_ANTICHEAT_PROCESSES: readonly string[] = [
  'vgc.exe', 'vgtray.exe',                     // Vanguard (Riot)
  'EasyAntiCheat.exe', 'EasyAntiCheat_EOS.exe', // EAC (Epic Online Services)
  'BEService.exe',                              // BattlEye
];

/** Merge the default list with user config (case-insensitive, deduped,
 *  trimmed — config entries are exe names). PURE. */
export function mergeAntiCheatList(configList?: readonly string[]): string[] {
  const all = [...DEFAULT_ANTICHEAT_PROCESSES, ...(configList ?? [])]
    .map((s) => String(s || '').trim().toLowerCase())
    .filter((s) => s.length > 0);
  return [...new Set(all)];
}

/** True when the foreground exe is on the refusal list (case-insensitive
 *  compare on the basename — config may carry a full path). PURE. */
export function isAntiCheat(foregroundExe: string, list: readonly string[]): boolean {
  const base = String(foregroundExe || '').trim().toLowerCase().split(/[\\/]/).pop() || '';
  if (!base) return false;
  return list.some((entry) => entry === base);
}

// ── The preflights (pure over injected probes) ──────────────────────────────

export interface SafetyProbes {
  /** Fresh environment_check from the helper (secure desktop, elevated
   *  foreground, foreground exe). */
  environment: () => Promise<EnvironmentCheck>;
}

export interface SafetyPolicy {
  antiCheatProcesses?: readonly string[];
}

export class SafetyGate {
  private antiCheat: string[];

  constructor(
    private probes: SafetyProbes,
    policy: SafetyPolicy = {},
  ) {
    this.antiCheat = mergeAntiCheatList(policy.antiCheatProcesses);
  }

  /** True when a secure desktop (UAC/lock) is active. Probe failures are
   *  NOT secure-desktop (fail-open on the probe, never a false refusal). */
  async secureDesktop(): Promise<boolean> {
    try {
      return !!(await this.probes.environment()).secure_desktop;
    } catch {
      return false;
    }
  }

  /** Refuse capture+input when the secure desktop is up. Returns the wire
   *  error string, or null to proceed. */
  async secureDesktopRefusal(): Promise<string | null> {
    return (await this.secureDesktop()) ? refusalError(REFUSAL_CODES.SECURE_DESKTOP) : null;
  }

  /** Elevation refusal for INPUT actions: the FOREGROUND window's process
   *  elevated ⇒ UIPI blocks our SendInput. */
  async elevationRefusal(): Promise<string | null> {
    let env: EnvironmentCheck;
    try {
      env = await this.probes.environment();
    } catch {
      return null; // preflight failed — let the action's own error speak
    }
    return env.elevated_foreground ? refusalError(REFUSAL_CODES.ELEVATED) : null;
  }

  /** Anti-cheat refusal for CAPTURE+INPUT: the foreground process on the
   *  list ⇒ hard refusal. */
  async antiCheatRefusal(): Promise<string | null> {
    let env: EnvironmentCheck;
    try {
      env = await this.probes.environment();
    } catch {
      return null;
    }
    if (!env.foreground_exe) return null;
    return isAntiCheat(env.foreground_exe, this.antiCheat)
      ? refusalError(REFUSAL_CODES.ANTICHEAT, `foreground process ${env.foreground_exe}`)
      : null;
  }
}

// ── DRM heuristic (agent side, over the captured BGRA frame) ────────────────

/** Uniform-black foreground-rect heuristic — pure over the frame + rect.
 *  Mirrors rust-helper/src/drm.rs (the helper also computes it frame-side;
 *  this is the agent's copy for the observation text). */
export function drmSuspectedAgent(
  pixels: Buffer, width: number, height: number,
  rect: { x: number; y: number; w: number; h: number } | null,
): boolean {
  if (!rect || rect.w <= 0 || rect.h <= 0 || width <= 0 || height <= 0) return false;
  if (rect.w * rect.h < 256 * 256) return false; // too small to call
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.w);
  const y1 = Math.min(height, rect.y + rect.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return false;
  const total = (x1 - x0) * (y1 - y0);
  if (total < 256 * 256) return false;
  const stride = Math.max(1, Math.floor(total / 40_000) + 1);
  let sampled = 0;
  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const o = (y * width + x) * 4;
      if (pixels[o] > 8 || pixels[o + 1] > 8 || pixels[o + 2] > 8) return false;
      sampled++;
    }
  }
  return sampled > 0;
}
