/**
 * macOS permission state + self-diagnostics for the Digby helper (v0.6.0+,
 * feedback ticket 2f646c10 — 2026-09-25).
 *
 * An owner spent ~24h with a dead computer-use input path: Accessibility was
 * granted to a STALE helper binary after an app update (System Settings showed
 * the switch ON) while the running DigbyHelper was a ghost from the deleted
 * bundle — and the agent had no way to say so. "Shouldn't this all be handled
 * when you install digby mac os app?"
 *
 * This module makes the helper self-diagnosing:
 *   - computePermissionStatus() assembles {ax, sr, fda, relaunch} and the run
 *     loop advertises it on EVERY poll (api.ts appends the four query params),
 *     so the Account → Integrations card shows live status + the exact fix.
 *   - noteMoveResult() latches PROVABLY dead input: 3+ consecutive verified
 *     cursor mis-lands (the CGEvent read-back says the pointer never arrived
 *     while Accessibility reports granted) trip a process-lifetime latch.
 *   - bundleReplaced() detects the .app bundle being swapped under the running
 *     helper (dev/ino of process.execPath changed) — after an update the
 *     running DigbyHelper is a ghost whose TCC grants no longer apply.
 *   - relaunch is advertised only when bouncing the helper is the FIX: the
 *     bundle was swapped under us, or Accessibility LOOKS granted but input is
 *     provably dead. The card's Relaunch helper button (permission_relaunch)
 *     then restarts it; launchd's KeepAlive brings it back in ~10s from the
 *     CURRENT bundle, which re-evaluates TCC — self-healing.
 *
 * Pure-ish module, no new deps. The Accessibility/Screen Recording preflight is
 * computer.ts's JXA 'preflight' action (the same executor path the
 * computer-use guard uses — never duplicated here); the Full Disk Access check
 * is chatdb's checkAccess(). NOTE: computer.ts imports noteMoveResult from
 * here, so the two modules are mutually cyclic — deliberately: every
 * cross-reference happens at CALL time (never at module init), which is safe
 * under CommonJS's late-bound property access.
 */

import { statSync } from 'fs';
import { basename } from 'path';
import { checkAccess } from './chatdb';
import { preflightPermissions, probeScreenRecording, lastCaptureTruth, shouldProbeScreenRecording, probeInputMonitoring } from './computer';

/**
 * The name macOS TCC lists for this helper — the executable's basename
 * (51d8dbe0): "DigbyAgent" on a CLI/tarball install (install.sh copies the
 * node runtime to a Digby-named binary), "DigbyHelper" in the .app bundle,
 * "node" in a dev checkout. User-facing guidance names THIS so the file the
 * user is told to add is exactly the one Finder reveals (process.execPath).
 */
export function helperDisplayName(execPath: string = process.execPath): string {
  return basename(execPath);
}

/** The advertised TCC state — the exact wire shape the backend persists
 *  (imessage_agents.permissions) and the Integrations card renders. */
export interface PermissionStatus {
  ax: boolean;        // Accessibility — computer control (CGEvent input)
  sr: boolean;        // Screen Recording — screenshots
  fda: boolean;       // Full Disk Access — reading ~/Library/Messages/chat.db
  relaunch: boolean;  // the helper must be bounced (see needsRelaunch)
  // 1ea9a120: calendar TCC truth derived from REAL calendar reads (not a
  // probe — Calendar.app's Automation consent fires on first read). ABSENT
  // until the first read happens: undefined keeps the `cal` advert key out
  // of the poll entirely so the backend keeps its stored value.
  calendar?: boolean;
  // 30d3c366: Input Monitoring (TCC kTCCServiceListenEvent) from the
  // NON-REQUESTING CGPreflightListenEventAccess query. OPTIONAL for the same
  // absent-never-clobbers reason as `calendar`: undefined keeps the `im` key
  // off the poll when the bridge cannot answer (an unknown must never be
  // advertised as a revoked grant), and a pre-0.9.13 backend ignores it.
  inputMonitoring?: boolean;
}

/** Privacy & Security pane ids — the wire vocabulary for permission_open_pane
 *  (the backend validates the same set before dispatching). c44b19e9 adds
 *  'calendars' (the Calendars/EventKit pane) for the consolidated re-grant
 *  card's per-grant button. 30d3c366 adds 'input-monitoring' (the
 *  Privacy_ListenEvent pane macOS titles "Input Monitoring") and 'automation'
 *  (Privacy_Automation) — the two the ticket reports losing. */
export type PermissionPane =
  | 'accessibility'
  | 'screen-recording'
  | 'full-disk-access'
  | 'calendars'
  | 'input-monitoring'
  | 'automation';

/** System Settings → Privacy & Security deep links, CENTRALIZED so the agent's
 *  own guidance dialogs (computer.ts, index.ts) and the backend-dispatched
 *  permission_open_pane command can never drift apart. */
export const PANE_URLS: Record<PermissionPane, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  'full-disk-access': 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  calendars: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  'input-monitoring': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
};

// ── Dead-input latch ──────────────────────────────────────────────────────────

/** Consecutive verified mis-lands before the dead-input latch trips. */
export const RELATCH_AFTER = 3;

let consecutiveDeadMoves = 0;
let deadInputLatched = false;

/**
 * Feed the dead-input latch from the JXA moveAndVerify result (computer.ts
 * calls this on the NODE side, where the {x, y, verified} object is received):
 *   - false — the cursor read-back SUCCEEDED and the pointer is verifiably
 *     elsewhere: input is provably not landing. Count it.
 *   - true  — input verifiably landed: reset the consecutive counter.
 *   - null  — the read-back itself failed / no move happened: unverifiable,
 *     a no-op (never counted either way).
 * The latch trips at RELATCH_AFTER consecutive mis-lands and then stays
 * tripped for the PROCESS lifetime (one lucky landing after a streak of dead
 * input is not evidence the grant healed — a restart re-evaluates TCC fresh).
 */
export function noteMoveResult(verified: boolean | null): void {
  if (verified === null) return; // unverifiable — no signal either way
  if (verified) {
    consecutiveDeadMoves = 0;
    return;
  }
  consecutiveDeadMoves++;
  if (consecutiveDeadMoves >= RELATCH_AFTER) deadInputLatched = true;
}

/** True once the dead-input latch has tripped (sticky for the process). */
export function latchedDeadInput(): boolean {
  return deadInputLatched;
}

// ── Calendar read latch (1ea9a120) ───────────────────────────────────────────

let calendarGranted: boolean | undefined;

/**
 * Feed the calendar advert from a REAL calendar read result (index.ts calls
 * this after every calendar_list_events, with the classified truth in hand):
 * true — the read succeeded, so Calendar.app Automation is granted; false —
 * a classified DENIAL (calendar.ts mints reason:'calendar-denied' for the
 * TCC -1743 "not authorized to send Apple events" error). The caller does
 * NOT feed UNREACHABLE reads here at all: Calendar.app quit ≠ permission
 * revoked, so an unreachable result leaves the previous advert untouched —
 * a denial must never masquerade as unreachable, and neither may masquerade
 * as a grant (the 2f646c10 stale-truth rule). `undefined` (no successful
 * read and no denial yet) = key absent.
 */
export function noteCalendarRead(ok: boolean): void {
  calendarGranted = ok;
}

/** The calendar advert value — undefined until the first real read. */
export function calendarAdvert(): boolean | undefined {
  return calendarGranted;
}

// ── Bundle-replacement ghost check ────────────────────────────────────────────

/** A binary's identity on this filesystem — stable across renames, changes
 *  when the file at the path is REPLACED (an app update swaps the bundle). */
export interface BinaryIdentity {
  dev: number;
  ino: number;
}

/** Pure comparator (exported for the test suite): did the binary at
 *  process.execPath change under us? A missing baseline means "cannot tell"
 *  (false); a baseline with no current identity means the binary is GONE —
 *  the running helper is a ghost from a deleted bundle for sure. */
export function binaryIdentityChanged(launchedAs: BinaryIdentity | null, now: BinaryIdentity | null): boolean {
  if (!launchedAs) return false; // no baseline captured at init — nothing to compare
  if (!now) return true;         // stat now throws — the binary is gone
  return now.dev !== launchedAs.dev || now.ino !== launchedAs.ino;
}

/** Who we started as — captured at module init (before any update can swap us). */
const launchedAs: BinaryIdentity | null = (() => {
  try {
    const st = statSync(process.execPath);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null; // no baseline — bundleReplaced() can never claim a swap
  }
})();

/** The helper's current binary identity, or null when it can't be stated. */
export function currentBinaryIdentity(): BinaryIdentity | null {
  try {
    const st = statSync(process.execPath);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

/**
 * True when the .app bundle was swapped under the running helper: the binary
 * at process.execPath is no longer the one this process started from (dev/ino
 * differ) or is gone entirely. After an app update the running DigbyHelper is
 * a GHOST from the deleted bundle — its Accessibility grant no longer applies
 * while System Settings still shows the old entry ON, which is exactly the
 * ~24h-dead-input incident shape (ticket 2f646c10).
 */
export function bundleReplaced(): boolean {
  return binaryIdentityChanged(launchedAs, currentBinaryIdentity());
}

// ── Status assembly ───────────────────────────────────────────────────────────

/**
 * Fresh Accessibility + Screen Recording check — the SAME JXA preflight action
 * the computer-use guard runs (uncached; callers own the caching policy).
 * Inherits the guard's fail-open posture: the JXA preflight reports true when
 * its probes themselves fail, so a broken CHECK never blocks the feature.
 */
export async function preflightMacPermissions(): Promise<{ ax: boolean; sr: boolean }> {
  const p = await preflightPermissions();
  // v0.6.3: Screen Recording ground truth beats the fail-open preflight (macOS
  // 26 cannot see it and reads "granted" — computer.ts lastCaptureTruth).
  // 30787bc4 (2026-10-24): the OLD re-probe here — `await probeScreenRecording()`
  // while the last capture was denied — fired a REAL `screencapture` on every
  // status TTL. From a self-updated binary whose TCC grant was orphaned that
  // capture RE-RAISED the native "DigbyAgent would like to record this
  // computer's screen and audio" dialog, so the owner got a system modal every
  // ~15-25 s that no toggle could dismiss (the visible toggle belongs to the
  // STALE entry for the old binary). The status poll must NEVER drive a
  // requesting API: the truth comes from (a) a real capture that already
  // happened — onboarding fired one, and every computer_use screenshot feeds
  // noteCaptureResult (a SUCCESS latches truth=true and this branch never
  // runs again this process) — and (b) the probe RATE-LIMITED by
  // shouldProbeScreenRecording() (computer.ts: exponential backoff 5min →
  // 6h, advanced at the probe's single choke point). First-launch onboarding
  // and computer-use commands remain the only prompt-armed paths.
  const truth = lastCaptureTruth();
  let sr: boolean;
  if (truth === true) sr = true;
  else if (truth === null) sr = p.screen;
  else sr = shouldProbeScreenRecording() ? await probeScreenRecording() : false;
  return { ax: p.accessibility, sr };
}

/** How long a preflight/FDA probe stays fresh. osascript + a sqlite open are
 *  too heavy to run on EVERY poll (polls are sub-second during active computer
 *  use); 15s caps them at ~4 checks/minute. The Screen Recording PROBE inside
 *  this TTL is separately backoff-gated (30787bc4 — see
 *  shouldProbeScreenRecording): the TTL alone was the re-prompt loop. */
const STATUS_TTL_MS = 15_000;

interface CachedProbe {
  ax: boolean;
  sr: boolean;
  fda: boolean;
  /** 30d3c366: Input Monitoring; null = the bridge could not answer (unknown
   *  — never advertised, never counted as a loss). */
  im: boolean | null;
  at: number;
}
let probeCache: CachedProbe | null = null;

/** Pure relaunch decision (exported for the test suite): the helper must be
 *  bounced when the bundle was swapped under it, or when Accessibility LOOKS
 *  granted (ax true) while input is provably dead — the stale-grant shape
 *  where re-granting in System Settings changes nothing because the grant
 *  already LOOKS present. */
export function needsRelaunch(opts: { bundleReplaced: boolean; latchedDeadInput: boolean; ax: boolean }): boolean {
  return opts.bundleReplaced || (opts.latchedDeadInput && opts.ax === true);
}

/**
 * Assemble the poll advert {ax, sr, fda, relaunch}. The preflight + FDA probes
 * are TTL-cached (15s); the latch and bundle-replacement checks are ALWAYS
 * fresh (in-memory / one statSync — free, and must never lag). A probe that
 * itself fails keeps the last known values serving (a wedged osascript must
 * not flip a healthy Mac to all-missing); first-run failures read false.
 */
export async function computePermissionStatus(force = false): Promise<PermissionStatus> {
  const now = Date.now();
  if (force || !probeCache || now - probeCache.at > STATUS_TTL_MS) {
    const fresh: CachedProbe = { ax: false, sr: false, fda: false, im: null, at: now };
    try {
      const p = await preflightMacPermissions();
      fresh.ax = p.ax;
      fresh.sr = p.sr;
    } catch {
      if (probeCache) {
        fresh.ax = probeCache.ax;
        fresh.sr = probeCache.sr;
      }
    }
    try {
      fresh.fda = checkAccess().ok;
    } catch {
      if (probeCache) fresh.fda = probeCache.fda;
    }
    // 30d3c366: NON-REQUESTING Input Monitoring query. A failed probe keeps
    // the previous reading (or null) — same fail-safe posture as ax/sr above,
    // so a wedged bridge never flips a healthy Mac to "grant lost".
    try {
      const im = await probeInputMonitoring();
      fresh.im = im !== null ? im : (probeCache ? probeCache.im : null);
    } catch {
      fresh.im = probeCache ? probeCache.im : null;
    }
    probeCache = fresh;
  }
  const { ax, sr, fda } = probeCache;
  const status: PermissionStatus = {
    ax,
    sr,
    fda,
    relaunch: needsRelaunch({ bundleReplaced: bundleReplaced(), latchedDeadInput: deadInputLatched, ax }),
  };
  // 1ea9a120: the calendar key rides the advert ONLY once a real calendar
  // read has happened (absent-never-clobbers — see noteCalendarRead).
  const cal = calendarAdvert();
  if (cal !== undefined) status.calendar = cal;
  // 30d3c366: `im` rides the advert only when the OS answered. Undefined (an
  // unreachable bridge) keeps the key OFF the poll so the backend retains its
  // stored value — an unknown must never overwrite a known grant.
  if (probeCache.im !== null) status.inputMonitoring = probeCache.im;
  return status;
}

/**
 * The four permission flags as a query string ('ax=1&sr=0&…') — api.ts appends
 * this to every poll so the backend's touchAgent persists the state.
 */
export function buildPermissionsQuery(p: PermissionStatus): string {
  return `ax=${p.ax ? 1 : 0}&sr=${p.sr ? 1 : 0}&fda=${p.fda ? 1 : 0}&relaunch=${p.relaunch ? 1 : 0}`;
}

// ── First-launch onboarding (v0.6.3) ─────────────────────────────────────────
// Owner ask 2026-09-26 (after a reinstall left computer use dead until each
// permission was re-done by hand): request EVERY macOS permission up front,
// once, the first time this helper binary runs — and again after an app
// update / reinstall, because the re-signed helper may need its grants
// re-made. The pure decisions live here (tested); index.ts owns the prompts.

/** What the onboarding recorded in config.json: the helper binary + agent
 *  version the native prompts were fired for. */
export interface OnboardingStamp {
  version: string;
  dev: number;
  ino: number;
  at: string;
}

/**
 * Pure: should the first-launch onboarding run now? Yes when nothing was ever
 * recorded, when the recorded agent version differs, or when the recorded
 * binary identity differs from the one running (reinstall / update). When the
 * current identity cannot be stated the stamp is trusted (never re-prompt on
 * a guess).
 */
export function onboardingDue(
  stamp: OnboardingStamp | null | undefined,
  current: BinaryIdentity | null,
  version: string,
): boolean {
  if (!stamp) return true;
  if (stamp.version !== version) return true;
  if (!current) return false;
  return stamp.dev !== current.dev || stamp.ino !== current.ino;
}

/** Human labels for the panes (dialog + log copy). c44b19e9: 'calendars' joins
 *  the vocabulary (the consolidated re-grant card's pane); it is NOT part of
 *  the first-launch onboarding set (missingPermissionPanes — Calendars is
 *  granted on first calendar read / via the card, never a launch prompt). */
export const PANE_LABELS: Record<PermissionPane, string> = {
  accessibility: 'Accessibility',
  'screen-recording': 'Screen Recording',
  'full-disk-access': 'Full Disk Access',
  calendars: 'Calendars',
  // 30d3c366: the exact System Settings pane titles — a label that differs
  // from the pane title is half the "the user must hunt for the toggle"
  // friction the ticket reports.
  'input-monitoring': 'Input Monitoring',
  automation: 'Automation',
};

/** Pure: the panes still needing the user, in the order the checklist shows them.
 *
 *  30d3c366: `im` and `ae` are OPTIONAL inputs. They are threaded in because
 *  the native Input Monitoring sheet can be dismissed — without this the
 *  onboarding branch that computed `im` threw the result away and a dismissed
 *  sheet left NO fallback line (the reviewer's BLOCKING-2 finding). Undefined
 *  means "not part of this checklist" (an agent that cannot answer), never a
 *  phantom missing grant. */
export function missingPermissionPanes(
  s: { ax: boolean; sr: boolean; fda: boolean; im?: boolean; ae?: boolean },
): PermissionPane[] {
  const out: PermissionPane[] = [];
  if (!s.ax) out.push('accessibility');
  if (!s.sr) out.push('screen-recording');
  if (!s.fda) out.push('full-disk-access');
  // The two ticket grants LAST — they are the least likely to be missing on a
  // healthy Mac, and a dismissed native sheet is exactly when this fires.
  if (s.im === false) out.push('input-monitoring');
  if (s.ae === false) out.push('automation');
  return out;
}

/**
 * Pure: the ONE consolidated checklist dialog shown after the native prompts,
 * listing only what is still missing. Accessibility + Screen Recording were
 * pre-listed by their prompts (flip the switch); Full Disk Access has no
 * prompt API, so its line carries the add-the-file steps.
 */
export function onboardingMessage(missing: PermissionPane[]): string {
  // 51d8dbe0: name the REAL executable — "DigbyAgent" on a CLI install,
  // "DigbyHelper" in the .app bundle — so the file the user adds is exactly
  // the one Finder revealed (openFullDiskAccessGuidance reveals process.execPath).
  const helper = helperDisplayName();
  const lines: string[] = [];
  if (missing.includes('accessibility')) {
    lines.push(`• Accessibility — lets Digby click and type for you. The system prompt already listed "${helper}": open System Settings from it and turn the switch ON.`);
  }
  if (missing.includes('input-monitoring')) {
    // 30d3c366: the native consent sheet is fired above; this line is the
    // fallback path (an older bridge, or a dismissed sheet) and names the
    // pane macOS actually titles "Input Monitoring".
    lines.push(`• Input Monitoring — lets Digby see input events. The system prompt already listed "${helper}": open System Settings from it and turn the switch ON.`);
  }
  if (missing.includes('screen-recording')) {
    lines.push(`• Screen Recording — lets Digby see the screen. Same: "${helper}" is already listed, turn it ON.`);
  }
  if (missing.includes('full-disk-access')) {
    lines.push(`• Full Disk Access — lets Digby read your Messages. In the Full Disk Access pane that opened, click + (unlock first if needed), add the "${helper}" file highlighted in Finder, and turn it ON.`);
  }
  if (missing.includes('automation')) {
    // 30d3c366: Automation has no add-the-file switch — the per-target row
    // appears only after a denied Apple Event, so the copy names the targets
    // instead of sending the owner looking for a row that is not there.
    lines.push(`• Automation — lets Digby read the frontmost window. In the Automation pane expand "${helper}" and turn ON "System Events" (and Calendar if present).`);
  }
  const n = lines.length;
  const word = n === 1 ? 'one' : n === 2 ? 'two' : n === 3 ? 'three' : n === 4 ? 'four' : String(n);
  return (
    `Digby needs ${word} one-time macOS permission${n === 1 ? '' : 's'} on this Mac:\n\n` +
    lines.join('\n') +
    '\n\nDigby keeps running — the Account → Integrations card updates live as each one lands. No restart needed.'
  );
}
