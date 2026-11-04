/**
 * The periodic re-retire clock (ticket c6e91d19).
 *
 * The startup retire in runLoop() runs ONCE per process; the desktop app's
 * one-click "Set up iMessage on this Mac" (the served 0.1.10 app predates the
 * 549cef000 self-managed guard) can re-register the bundled helper's launchd
 * job at ANY later moment, after which a stale helper polls beside the current
 * agent with the SAME token — the stuck-version report. The idle poll loop
 * re-runs retireBundledHelper every RETIRE_RECHECK_MS so the re-infection
 * window is minutes, not the next reboot.
 *
 * Lives in its own module (not index.ts) so the test suite can import the
 * clock WITHOUT executing the CLI — index.ts calls main() at module load.
 */

/** How often the idle loop re-checks for a re-registered bundled helper. */
export const RETIRE_RECHECK_MS = 5 * 60 * 1000;

let lastRetireCheckAt = 0;

/** Millisecond clock, injectable seam for the tests. */
export const nowMs = (): number => Date.now();

/** True when the periodic retire re-check is due (called only on an IDLE poll). */
export function reRetireDue(now: number): boolean {
  return now - lastRetireCheckAt >= RETIRE_RECHECK_MS;
}

/** Stamp the clock (the call site does this when it FIRES the re-check). */
export function _stampRetireCheck(now: number): void {
  lastRetireCheckAt = now;
}
