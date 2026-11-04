/**
 * Retire every NON-self-managed Digby agent LaunchAgent (ticket 933e6ca4,
 * extended by ticket 405927c9).
 *
 * THE MISHAP THIS FIXES (reproduced live on cql-stanne-mbp-1): the one-line
 * installer booted out the .app-bundled helper's launchd job but LEFT its
 * plist in ~/Library/LaunchAgents. launchd loads every plist in that folder
 * at login, so the stale bundled helper (an old build, no self-update)
 * RESURRECTED at every reboot and polled the backend beside the current
 * self-managed agent — with the SAME token. The stored agentVersion then
 * flapped between the bundled build's version and the current release, so
 * the web card's "Agent update available" hint came back after every login
 * and read exactly like "the nag tracks the Mac app version".
 *
 * The agent now retires that plist itself on startup, so the fix reaches
 * every already-installed Mac through the normal self-update — no re-run of
 * the installer needed (which is good, because the nag is exactly what told
 * the owner to run it in the first place).
 *
 * WHAT MAY BE RETIRED (405927c9) — every install shape that can NEVER
 * self-update, and only from a runner that CAN:
 *   • the .app-bundled helper — ProgramArguments[0] contains
 *     ".app/Contents/Resources/" (the desktop app's one-click install,
 *     frozen at the app's build);
 *   • the /Library/Digby .pkg install — ProgramArguments[0] starts with
 *     "/Library/Digby/" (root-owned payload, no bundled npm, never
 *     self-updates — the served .pkg froze agent 0.1.0 for four months).
 * Both are retired by the SELF-MANAGED agent only: the .pkg's postinstall
 * chowns its plist to the console user, so the rm needs no sudo. A .pkg
 * install that is a Mac's ONLY install is never retired — nothing running
 * the retire code exists beside it.
 *
 * WHO MAY RETIRE — identity, not just shape:
 *   • the .app-bundled helper never retires anything (933e6ca4 reviewer
 *     blocker 1 — it would rm its OWN launchd job seconds after pairing);
 *   • a /Library/Digby .pkg agent never retires anything (405927c9: the
 *     fresh .pkg yields to a self-managed install in postinstall; the .pkg
 *     agent itself must never fight the newer self-managed one);
 *   • anything unparseable/unknown is left COMPLETELY alone.
 *
 * Never fatal, never blocks the poll loop: every failure mode is logged and
 * swallowed — a Mac whose stale install cannot be retired keeps working,
 * it just keeps the old flap.
 */

import { readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { homedir } from 'os';

/** The launchd label shared by the .app-bundled helper and the .pkg install. */
export const BUNDLED_AGENT_LABEL = 'ai.digby.imessage-agent';

/** The plist path the desktop app (and the .pkg postinstall) writes. */
export function bundledAgentPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${BUNDLED_AGENT_LABEL}.plist`);
}

/** First ProgramArguments entry of a plist XML, or '' when unreadable. */
export function plistProgramArgument(plistXml: string | null): string {
  if (!plistXml) return '';
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plistXml);
  if (!m) return '';
  const first = /<string>([\s\S]*?)<\/string>/.exec(m[1]);
  return first ? first[1].trim() : '';
}

/**
 * Pure decision (exported for the test suite): does this plist belong to the
 * DESKTOP APP'S bundled helper — the one that must be retired?
 *
 * The app writes ProgramArguments[0] = "/Applications/Digby.app/Contents/
 * Resources/imessage-agent/DigbyHelper" (any install location — the match is
 * on the ".app/Contents/Resources/" shape, NOT a leading slash: a path like
 * "/Applications/Digby.app/…" has no char boundary before ".app"); the .pkg
 * postinstall writes "/Library/Digby/imessage-agent/DigbyAgent". Only the
 * .app shape retires. An unreadable/unparseable plist is NOT retired
 * (unknown ⇒ untouched).
 */
export function isAppBundledPlist(plistXml: string | null): boolean {
  return plistProgramArgument(plistXml).includes('.app/Contents/Resources/');
}

/**
 * True when this plist belongs to the signed .pkg install — the
 * /Library/Digby payload. Both postinstall generations are matched by the
 * PATH PREFIX, not the binary name: the June 2026 .pkg wrote ProgramArguments
 * [0]=/Library/Digby/imessage-agent/node (a plain "node"), the current one
 * writes …/DigbyAgent — a name-only check would miss every .pkg ever served
 * (405927c9).
 */
export function isPkgInstallPlist(plistXml: string | null): boolean {
  return plistProgramArgument(plistXml).startsWith('/Library/Digby/');
}

/** Any install shape that can never self-update — retireable from a
 *  self-managed agent. */
export function isRetireablePlist(plistXml: string | null): boolean {
  return isAppBundledPlist(plistXml) || isPkgInstallPlist(plistXml);
}

export interface RetireResult {
  /** retired: the app-bundled plist was booted out and removed. */
  retired: boolean;
  /** present: a plist with the bundled label existed at all. */
  present: boolean;
  /** The first ProgramArguments entry, for the log line (diagnostics). */
  program?: string;
  /** self: the RUNNING process IS the bundled helper itself — never retired
   *  (reviewer blocker 1: build-app.sh builds the .app-bundled agent from
   *  this same tree, so a future app bundle runs agent ≥ 0.9.1; without this
   *  guard that helper would boot out and rm its OWN launchd job seconds
   *  after pairing, killing the app's one-click setup). */
  self?: boolean;
}

/** True when the process reading this is itself the .app-bundled helper. */
export function runningIsBundledHelper(execPath: string = process.execPath): boolean {
  return execPath.includes('.app/Contents/Resources/');
}

/** True when the process reading this is itself the /Library/Digby .pkg agent. */
export function runningIsPkgAgent(execPath: string = process.execPath): boolean {
  return execPath.startsWith('/Library/Digby/');
}

/**
 * Boot out + remove every stale Digby agent plist this SELF-MANAGED agent can
 * attribute. Safe to call on every startup: a missing plist is a no-op, and a
 * plist this agent cannot attribute is left in place. Returns what happened so
 * the caller can log one line (never more).
 *
 * IDENTITY, not just shape: when THIS process is the .app-bundled helper or
 * the .pkg agent itself, do nothing — those installs never retire anything
 * (a bundled helper would rm its OWN launchd job seconds after pairing; a
 * .pkg agent would fight the self-managed install that postinstall yielded
 * to — the .pkg yields, never counter-retires).
 */
export function retireBundledHelper(home: string = homedir()): RetireResult {
  // Reviewer blocker 1: a future .app bundle ships a ≥0.9.1 helper whose own
  // runLoop calls this — the shape check alone would make it boot out and
  // delete ITS OWN launchd job moments after pairing. The bundled helper
  // never retires anything.
  if (runningIsBundledHelper()) {
    return { retired: false, present: true, self: true, program: process.execPath };
  }
  // 405927c9: the .pkg agent runs root-owned code with no self-update — it
  // must never retire the self-managed agent that outranks it, and it must
  // never remove its own job (postinstall already yields to the newer
  // install when one exists).
  if (runningIsPkgAgent()) {
    return { retired: false, present: true, self: true, program: process.execPath };
  }
  const plist = bundledAgentPlistPath(home);
  if (!existsSync(plist)) return { retired: false, present: false };
  let xml: string | null = null;
  try {
    xml = readFileSync(plist, 'utf8');
  } catch {
    xml = null;
  }
  const program = plistProgramArgument(xml) || undefined;
  if (!isRetireablePlist(xml)) return { retired: false, present: true, program };
  // Boot the job out of the logged-in GUI domain (fall back to the legacy
  // verb). Both verbs may "fail" when the job is not loaded — that is fine:
  // what ends the resurrect loop is the rmSync below (launchd only loads
  // plists that exist at login). spawnSync (not execFile): the retire must
  // complete before this process starts polling, or the two agents briefly
  // poll side by side — the exact flap this fixes.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  try {
    const boot = spawnSync('launchctl', ['bootout', `gui/${uid}`, plist], { timeout: 15_000 });
    if (boot.status !== 0) {
      spawnSync('launchctl', ['unload', plist], { timeout: 15_000 });
    }
  } catch { /* best-effort — the rm below is what matters */ }
  try {
    rmSync(plist, { force: true });
  } catch {
    return { retired: false, present: true, program };
  }
  return { retired: true, present: true, program };
}
