/**
 * macOS Calendar read path (ticket 1ea9a120 — 2026-10-04 agent v0.7.0;
 * v0.7.1 moved the read onto EventKit; v0.7.2 swaps the bridge language to
 * AppleScript-ObjC — the JXA bridge ek6 measured DEAD on both Macs).
 *
 * The backend dispatches `calendar_list_events` to the Mac agent; the agent
 * reads upcoming events via the SAME osascript seam every other macOS
 * integration uses — never a native addon, so the agent stays its
 * zero-native-dep self except better-sqlite3, and never links EventKit
 * headers.
 *
 * Why ASOC, not JXA (v0.7.2): the v0.7.1 engine never read a single event
 * anywhere — the ek6 probe matrix measured the JXA ObjC bridge DEAD on
 * both controlled Macs (macOS 26.6.2 and 14.5 alike: EKEventStore
 * construction fails with "Object is not a function", and the semaphore
 * call is undefined outright), while the SAME EventKit calls written as
 * AppleScript-ObjC (`use framework "EventKit"`) read a full calendar plus
 * a 7-day event window in the ~28-67ms class on both. The engine below is
 * built only from idioms that matrix proved: try-wrapped field access,
 * EKEventStore alloc().init(), the event predicate, and the
 * NSJSONSerialization tail. No unproven bridge idiom ships — that is the
 * 0.7.1 failure class this file is the correction of.
 *
 * AUTH-TIER GATE (0.7.1, amended 0.9.11 by ticket daf8706a):
 * EKEventStore.authorizationStatus for the event entity returns 0
 * notDetermined / 1 restricted / 2 denied / 3 authorized / 4 write-only.
 * Only the READABLE tiers (3, and 5 as a defensive future full-access
 * tier) may return events. Tier 4 (write-only) is the trap: reads succeed
 * but silently return ZERO events — reported here as the classified
 * `calendar-denied` shape, never as a phony "no upcoming events" success.
 * Tier 0 (notDetermined — this client never asked) denies with its OWN
 * "not requested" marker and classifies as `calendar-never-requested`;
 * tiers 2/1 (denied/restricted) keep the fast "not authorized" marker.
 * The READ itself never requests access: the one-time consent request
 * lives in calendar-request.ts and is fired only from the tier-0
 * classification below.
 *
 * TIER-0 DEADLOCK FIX (ticket daf8706a, 2026-10-27 — the mbp-1
 * calendar-denied-after-grant incident): two defects made the grant the
 * user made UNREACHABLE forever. (1) The gate conflates tier 0
 * (notDetermined — this client has NEVER asked, so macOS has no TCC row
 * to show) with tier 2 (denied) into one `calendar-denied` reason — the
 * owner grants what the pane shows and the read still fails, because the
 * pane never listed the client that asks. The read path still never
 * requests (the read contract is unchanged), but tier 0 now classifies as
 * its OWN reason `calendar-never-requested` and ONE fire-and-forget
 * requesting script (calendar-request.ts, its own osascript, never the
 * read path) drives the EventKit consent request for THIS client — the
 * native Calendars consent dialog fires, a TCC row is created for the
 * agent binary (DigbyAgent / DigbyHelper), and after the user approves +
 * relaunches, ordinary reads read tier 3. A failed or unsupported request
 * idiom is a silent no-op (log line only): the System Settings path
 * remains, now naming the exact binary to grant. (2) The unavailable
 * payload carried NO client identity, so nobody could see which binary
 * was denied: every unavailable shape now carries `client` — the agent
 * binary's process.execPath (the TCC client macOS attributes the EventKit
 * request to) — and tier 0 vs tier 2 is visible in the reason itself. The
 * payload is ADDITIVE: older backends ignore unknown fields.
 *
 * The seam degrades gracefully: a denial or bridge failure exits non-zero
 * with a classified stderr, and the module reports the
 * {events:null, unavailable:{reason, pane:'calendar', client}} shape —
 * the backend then surfaces the "Grant calendar access" flow. The command
 * NEVER throws out of the handler.
 *
 * INJECTION SAFETY (the sender.ts rule): the AppleScript source below is a
 * CONSTANT string — no user text is ever interpolated into it. It is
 * staged to a private temp file per call (the exact `osascript <file>
 * <argv>` invocation form the ek6 control arm proved) and the day window
 * rides as ARGV, clamped both in-script and here — params can never alter
 * the script text, and no shell is ever involved.
 */

import { execFile } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { requestCalendarAccessOnce } from './calendar-request';

/** Clamp the requested window — the backend clamps too, but the agent is the
 *  final guard on its own osascript budget. */
const MAX_DAYS = 120;

/** Cap the returned array so a pathological calendar can never balloon the
 *  result payload (the script also enforces this cap internally). */
const MAX_EVENTS = 200;

/** One calendar event, normalized to plain strings/booleans/null for the
 *  JSON wire — dates ISO-8601, everything else trimmed strings or null. */
export interface CalendarEvent {
  id: string;
  calendar: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  allDay: boolean;
  notes: string | null;
}

/** The classified failure reasons. 'calendar-denied' = the TCC grant is
 *  missing OR write-only (surface the "Grant calendar access" flow);
 *  'calendar-never-requested' (daf8706a) = tier 0 notDetermined — THIS
 *  client has never asked, so macOS has no TCC row to show; the user's
 *  grant to a DIFFERENT binary cannot reach us and the fix is the
 *  requesting script (fired automatically on this tier) + the named
 *  binary, not toggling a row that does not exist;
 *  'calendar-unreachable' = EventKit/bridge failure we could not classify
 *  as a denial (timeout, unparseable output); 'no-calendar-account' =
 *  EventKit reports ZERO calendars — the Mac is not signed in to an
 *  Apple account (owner directive 2026-10-07: never let a signed-out Mac
 *  masquerade as an empty success). All keep `pane:'calendar'` so the
 *  backend can name the pane in its copy. */
export type CalendarUnavailableReason =
  | 'calendar-denied'
  | 'calendar-never-requested'
  | 'calendar-unreachable'
  | 'no-calendar-account';

export interface CalendarReadResult {
  events: CalendarEvent[] | null;
  /** daf8706a: the unavailable payload carries the TCC client identity —
   *  process.execPath of the agent binary (the client macOS attributes the
   *  EventKit request to), so ONE line shows which binary must hold the
   *  grant ("digbyHelper granted, /…/DigbyAgent asking"). ADDITIVE: older
   *  backends ignore the extra field. */
  unavailable?: { reason: CalendarUnavailableReason; pane: 'calendar'; client: string };
}

/** The TCC client identity this agent's EventKit requests ride under: the
 *  agent binary's absolute path (launchd DigbyAgent, app-bundled
 *  DigbyHelper, or a dev `node`) — captured ONCE at module load, before
 *  anything can change it. Never empty unless Node itself fails (then
 *  'unknown'). */
const TCC_CLIENT_PATH: string = (() => {
  try {
    return process.execPath || 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** The ONLY place `reason` values are minted (with the pane always
 *  'calendar' and the client always the agent binary's path) — the
 *  backend surfaces these verbatim. */
function unavailable(reason: CalendarUnavailableReason): CalendarReadResult {
  return { events: null, unavailable: { reason, pane: 'calendar', client: TCC_CLIENT_PATH } };
}

/**
 * EventKit read (ASOC, read-only): events of every calendar overlapping
 * [now, now + days). Auth gate FIRST (see module head): only readable
 * tiers (3/5) return events; every other tier — write-only (4) and
 * not-determined (0) included — errors out with the "not authorized"
 * marker the classifier below keys on, so a write-only grant can NEVER
 * masquerade as an empty success. Events are oldest-start first per
 * EKEventStore ordering; the 200-event cap stops collection early. Dates
 * ride as epoch seconds and become ISO-8601 on this side (toEvent).
 * Success prints one line of JSON (possibly an empty array); the script
 * is built only from idioms the ek6 control arm proved on both Macs.
 */
const LIST_EVENTS_SCRIPT = `
use AppleScript version "2.4"
use framework "Foundation"
use framework "EventKit"
use scripting additions

on run argv
	-- The day window rides as argv (never inside the script text) and is
	-- clamped here too: 1..120 (the TS side clamps as well).
	set daysArg to 7
	try
		set daysArg to (item 1 of argv) as integer
	end try
	if daysArg < 1 then set daysArg to 1
	if daysArg > 120 then set daysArg to 120
	set EVT to 0
	-- Auth-tier gate: 3 = authorized (full read) and 5 = defensive future
	-- full-access tier are the ONLY readable tiers. 4 = write-only is the
	-- silent-zero trap (reads "succeed" with zero events). Tier 0 =
	-- notDetermined gets its OWN marker (daf8706a): it means THIS client
	-- never asked, so the read classifies as calendar-never-requested and
	-- the requesting side-channel fires — the read itself never requests
	-- (unproven prompt idioms stay out of the read contract). Tiers 2/1
	-- (denied/restricted) keep the plain "not authorized" marker.
	set authRaw to (current application's EKEventStore's authorizationStatusForEntityType:EVT)
	set auth to (authRaw as integer)
	if auth is not 3 and auth is not 5 then
		if auth is 0 then
			error "not requested: EventKit calendar auth status 0"
		end if
		error ("not authorized: EventKit calendar auth status " & (auth as text))
	end if
	set store to (current application's EKEventStore's alloc()'s init())
	-- v0.7.3 sign-in guard (owner directive 2026-10-07): a Mac with ZERO
	-- calendars is not signed in to an Apple account — error with the
	-- marker the TS classifier keys on so the backend surfaces "sign in"
	-- copy instead of a silent "no upcoming events" success.
	set calCount to ((store's calendars())'s |count|() as integer)
	if calCount is 0 then
		error "no calendar account: EventKit reports 0 calendars (sign in to the Apple account)"
	end if
	set nowD to (current application's NSDate's |date|())
	set span to (daysArg as real) * 86400.0
	set endD to (nowD's dateByAddingTimeInterval:span)
	set pred to (store's predicateForEventsWithStartDate:(nowD) endDate:(endD) calendars:(missing value))
	set evts to (store's eventsMatchingPredicate:pred)
	set evCount to (evts's |count|())
	set n to (evCount as integer)
	if n > 200 then set n to 200
	set outArr to (current application's NSMutableArray's array())
	repeat with i from 0 to (n - 1)
		set e to (evts's objectAtIndex:i)
		set d to (current application's NSMutableDictionary's dictionary())
		set vId to ""
		try
			set vId to ((e's eventIdentifier()) as text)
		end try
		(d's setObject:vId forKey:"id")
		set vCal to ""
		try
			set vCal to (((e's |calendar|())'s |title|()) as text)
		end try
		(d's setObject:vCal forKey:"calendar")
		set vTi to ""
		try
			set vTi to ((e's |title|()) as text)
		end try
		(d's setObject:vTi forKey:"title")
		set vSD to (current application's NSNull's |null|())
		try
			set vSD to (((e's startDate())'s timeIntervalSince1970()) as real)
		end try
		(d's setObject:vSD forKey:"startDate")
		set vED to (current application's NSNull's |null|())
		try
			set vED to (((e's endDate())'s timeIntervalSince1970()) as real)
		end try
		(d's setObject:vED forKey:"endDate")
		set vLoc to ""
		try
			set vLoc to ((e's location()) as text)
		end try
		(d's setObject:vLoc forKey:"location")
		set vAll to false
		try
			set vAll to ((e's isAllDay()) as boolean)
		end try
		(d's setObject:vAll forKey:"allDay")
		set vNotes to ""
		try
			set vNotes to ((e's notes()) as text)
		end try
		(d's setObject:vNotes forKey:"notes")
		(outArr's addObject:d)
	end repeat
	set jsonData to (current application's NSJSONSerialization's dataWithJSONObject:outArr options:0 |error|:(missing value))
	if jsonData is missing value then return "[]"
	set jsonStr to (current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)) as text
	return jsonStr
end run
`;

/** Is an osascript error the "not authorized for Apple events" denial
 * (-1743 / "not authorized to send Apple events")? The v0.7.2 ASOC gate
 * throws 'not authorized: EventKit calendar auth status N' — the SAME
 * classifier catches both the legacy Apple-events denial and the
 * auth-tier denial. */
function isDenied(stderr: string): boolean {
  return /not authorized|apple ?events|-1743|automation/i.test(stderr || '');
}

/** c44b19e9: STATUS-ONLY EventKit authorization query. The auth-tier gate
 *  LIST_EVENTS_SCRIPT runs FIRST is factored here as its own probe —
 *  `authorizationStatusForEntityType:` is the NON-REQUESTING API (unlike
 *  requestAccessToEntityType it never raises a consent dialog), so the
 *  post-update TCC preflight can read the Calendars grant state without
 *  prompting: readable tiers (3 full-read / 5 defensive future full-access)
 *  resolve true; write-only (4) and not-determined (0) resolve false (both
 *  are "the read will deny" — the 0.7.2 gate's own contract); a bridge
 *  failure resolves null and the caller adds NOTHING (an unknown never
 *  fabricates a grant loss). Same staged `osascript <file>` form the read
 *  path proved on both Macs. */
const AUTH_STATUS_SCRIPT = `
use AppleScript version "2.4"
use framework "Foundation"
use framework "EventKit"
use scripting additions

on run
	set EVT to 0
	set authRaw to (current application's EKEventStore's authorizationStatusForEntityType:EVT)
	return (authRaw as integer) as text
end run
`;

/** Read the Calendars (EventKit) authorization tier WITHOUT requesting
 *  anything. Resolves true (readable), false (denied / write-only /
 *  not-determined), or null (the status query itself failed — never a
 *  denial). Exported for the c44b19e9 suite. */
export function calendarAuthStatus(): Promise<boolean | null> {
  return new Promise((resolve) => {
    let scriptPath = '';
    try {
      const dir = mkdtempSync(join(tmpdir(), 'digby-calendar-auth-'));
      scriptPath = join(dir, 'auth-status.applescript');
      writeFileSync(scriptPath, AUTH_STATUS_SCRIPT, 'utf8');
    } catch {
      return resolve(null);
    }
    execFile('osascript', [scriptPath], { timeout: 15_000 }, (err, _stdout, _stderr) => {
      try { rmSync(dirname(scriptPath), { recursive: true, force: true }); } catch { /* best-effort */ }
      if (err) return resolve(null);
      const tier = parseInt(String(_stdout || '').trim(), 10);
      if (!Number.isFinite(tier)) return resolve(null);
      // 3 = authorized (full read), 5 = defensive future full-access tier.
      // 4 = write-only (the silent-zero trap), 0 = not-determined, 1/2 =
      // denied/restricted — every non-readable tier reads "the read will
      // deny" (the LIST_EVENTS_SCRIPT gate's own contract).
      resolve(tier === 3 || tier === 5);
    });
  });
}

/** v0.7.3: is the osascript error the zero-calendars sign-in guard? A Mac
 *  not signed in to an Apple account reports 0 calendars — classified as
 *  'no-calendar-account' (NOT a denial: the TCC grant is fine) and NOT
 *  unreachable (the read worked; the account is missing). */
function isNoAccount(stderr: string): boolean {
  return /no calendar account/i.test(stderr || '');
}

/** daf8706a: is the osascript error the tier-0 (never requested) marker the
 *  gate now mints? Kept SEPARATE from isDenied so the latch and the backend
 *  can tell "this client never asked" from "the user said no" — the first
 *  is fixed by requesting access (automatic via calendar-request.ts, the
 *  agent's ONLY requesting EventKit call), the second only by System
 *  Settings. */
function isNeverRequested(stderr: string): boolean {
  return /not requested/i.test(stderr || '');
}

/** Force the raw JSON event into the CalendarEvent wire shape: dates ride
 *  as epoch seconds in the script and become ISO-8601 here; a malformed
 *  field degrades to null, never to a crash or a leak of an odd object
 *  into the wire. An event without an id is dropped — it cannot be deduped
 *  upstream. */
function toEvent(raw: unknown): CalendarEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : null;
  if (!id) return null; // an event without an id cannot be deduped upstream
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const iso = (v: unknown): string | null => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    try {
      return new Date(n * 1000).toISOString();
    } catch {
      return null;
    }
  };
  return {
    id,
    calendar: str(r.calendar) ?? '',
    title: str(r.title),
    startDate: iso(r.startDate),
    endDate: iso(r.endDate),
    location: str(r.location),
    allDay: r.allDay === true,
    notes: str(r.notes),
  };
}

/**
 * Read upcoming Calendar events for the next N days (default 7, clamped
 * to 1..120). NEVER throws: resolves {events:[...]} on success, or
 * {events:null, unavailable:{reason, pane:'calendar', client}} when the
 * read is denied or unreadable — the handler contract the backend's
 * structured-error criterion requires (never a raw crash, never a silent
 * null that looks like "no data" without the unavailable marker). The
 * constant script is staged to a private temp dir (the exact
 * `osascript <file> <argv>` form the ek6 control arm proved) and that dir
 * is always removed when the call settles; a staging failure resolves
 * calendar-unreachable, never a throw. A tier-0 (never-requested)
 * classification additionally fires the one-shot consent request
 * (daf8706a) before resolving.
 */
export function listEvents(days: number = 7): Promise<CalendarReadResult> {
  return new Promise((resolve) => {
    const windowDays = Math.min(Math.max(1, Math.floor(Number(days) || 7)), MAX_DAYS);
    let scriptPath = '';
    try {
      const dir = mkdtempSync(join(tmpdir(), 'digby-calendar-'));
      scriptPath = join(dir, 'list-events.applescript');
      writeFileSync(scriptPath, LIST_EVENTS_SCRIPT, 'utf8');
    } catch {
      // Best-effort cleanup of a half-staged dir; a staging failure is
      // unreachable, never a throw.
      try {
        if (scriptPath) rmSync(dirname(scriptPath), { recursive: true, force: true });
      } catch {
        // ignored — never a throw out of the handler
      }
      return resolve(unavailable('calendar-unreachable'));
    }
    execFile(
      'osascript',
      [scriptPath, String(windowDays)],
      { timeout: 30_000 },
      (err, stdout, stderr) => {
        rmSync(dirname(scriptPath), { recursive: true, force: true });
        if (err) {
          if (isNoAccount(String(stderr))) return resolve(unavailable('no-calendar-account'));
          if (isNeverRequested(String(stderr))) {
            // daf8706a: the client that asks has no TCC row yet. Fire the
            // consent request once (fire-and-forget), then surface the
            // dedicated reason — the backend copy tells the user the
            // dialog is on its way / which binary to grant.
            requestCalendarAccessOnce();
            return resolve(unavailable('calendar-never-requested'));
          }
          if (isDenied(String(stderr))) return resolve(unavailable('calendar-denied'));
          return resolve(unavailable('calendar-unreachable'));
        }
        try {
          const parsed = JSON.parse(String(stdout || '').trim() || '[]');
          const rawEvents = Array.isArray(parsed) ? parsed : [];
          const events = rawEvents
            .map(toEvent)
            .filter((e): e is CalendarEvent => e !== null)
            .slice(0, MAX_EVENTS);
          return resolve({ events });
        } catch {
          return resolve(unavailable('calendar-unreachable'));
        }
      },
    );
  });
}
