/**
 * Tier-0 Calendar CONSENT REQUEST — the agent's ONE requesting EventKit
 * call (ticket daf8706a, agent 0.9.11).
 *
 * THE DEADLOCK (cql-stanne-mbp1, 2026-10-27): EKEventStore's
 * requestAccessToEntityType is the only thing that makes macOS create a
 * Calendars TCC row for a client, and the agent never called it — so a Mac
 * where the agent had never asked had NO row to grant. The user toggled the
 * "Digby" app ON (a DIFFERENT TCC client than the agent binary) and reads
 * still failed with calendar-denied, forever.
 *
 * THE FIX: when the READ path (calendar.ts) classifies tier 0
 * (notDetermined — "not requested: EventKit calendar auth status 0"), it
 * fires requestCalendarAccessOnce() HERE. The AppleScript below calls the
 * requesting API from THIS process, so the TCC row is minted for the agent
 * binary (launchd DigbyAgent / app-bundled DigbyHelper) and the native
 * consent dialog fires on the Mac; after the user approves (and the agent
 * relaunches), ordinary reads read tier 3.
 *
 * INVARIANTS (pinned by test/tier0-request.daf8706a.test.mjs):
 *   - THE ONLY requesting EventKit API in the agent: calendar.ts stays
 *     free of requestAccessToEntityType (the c44b19e9 pin on the read +
 *     preflight surfaces remains literally true; the 0.9.8 rule "status
 *     surfaces never drive a requesting API" is untouched — the poll,
 *     status probe and preflight never import this module).
 *   - ONCE per process lifetime (module-level latch; never re-prompted on
 *     every read).
 *   - FIRE-AND-FORGET: never awaited by the dispatch, never touches the
 *     read contract, never throws out of the caller — a failed or
 *     unsupported request idiom (the handler-as-block ObjC bridge is not a
 *     proven idiom on every macOS build, unlike the read path's) is a log
 *     line, and the System Settings fallback remains (the backend copy now
 *     names the exact binary to grant).
 *   - The completion rides as an AppleScript handler bridged to the ObjC
 *     block; if a build refuses the bridge the try wrapper exits with the
 *     marker "not requested: request bridge unavailable" — classified by
 *     the caller's error path as a settled-without-grant, never a crash.
 *   - The granted/denied outcome is deliberately discarded: a later read
 *     re-derives the truth from the status API. This script exists only to
 *     mint the TCC row + dialog.
 *   - INJECTION SAFETY (the sender.ts rule): the script is a CONSTANT
 *     string — no user text is ever interpolated into it; it is staged to
 *     a private temp dir per attempt (the `osascript <file>` form the ek6
 *     control arm proved) and the dir is always removed when the call
 *     settles.
 */

import { execFile } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

const REQUEST_ACCESS_SCRIPT = `
use AppleScript version "2.4"
use framework "Foundation"
use framework "EventKit"
use scripting additions

on run
	set EVT to 0
	set store to (current application's EKEventStore's alloc()'s init())
	set done to false
	try
		store's requestAccessToEntityType:EVT completion:(my "calendarAccessDone:")
		set done to true
	end try
	if not done then error "not requested: request bridge unavailable"
end run

on calendarAccessDone:theGrant
	-- Fire-and-forget: the grant outcome is deliberately discarded here —
	-- a later read re-derives the truth from the status API. Returning
	-- normally ends the osascript run; the handler must exist for the
	-- block bridge to bind, and this is its whole body.
	return
end calendarAccessDone:
`;

let tier0RequestFired = false;

/** Fire the tier-0 consent request once per process lifetime
 * (fire-and-forget). Called ONLY by calendar.ts's tier-0 classification
 * (the read path) — the poll/status/preflight surfaces never import this
 * module, keeping the 0.9.8 no-requesting-probe invariant intact. */
export function requestCalendarAccessOnce(): void {
  if (tier0RequestFired) return;
  tier0RequestFired = true;
  let scriptPath = '';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'digby-calendar-request-'));
    scriptPath = join(dir, 'request-access.applescript');
    writeFileSync(scriptPath, REQUEST_ACCESS_SCRIPT, 'utf8');
  } catch {
    // Same staging-failure contract as the read path: log and drop —
    // never a throw out of the caller.
    console.error('[calendar] tier-0 request script staging failed; falling back to System Settings');
    return;
  }
  // Bounded: a short timeout so a wedged bridge cannot leak a child past
  // the consent dialog; the outcome is discarded either way. A timeout
  // with the dialog still open is a SUCCESS shape (the request WORKED —
  // osascript just cannot return while the dialog waits), not an error.
  execFile('osascript', [scriptPath], { timeout: 10_000 }, (err, _stdout, stderr) => {
    try {
      rmSync(dirname(scriptPath), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    if (err) {
      console.error(
        `[calendar] tier-0 consent request settled without a grant confirmation (${String(stderr || err.message).split('\n')[0] || 'no stderr'}); the System Settings path remains — grant the binary named in the payload's client`,
      );
    }
  });
}
