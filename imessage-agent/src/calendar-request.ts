/**
 * Tier-0 Calendar CONSENT REQUEST — the agent's ONE requesting EventKit
 * call (ticket daf8706a, agent 0.9.11; REPAIRED 2026-11-06).
 *
 * THE DEADLOCK (cql-stanne-mbp1, 2026-10-27): EKEventStore's
 * requestAccessToEntityType is the only thing that makes macOS create a
 * Calendars TCC row for a client, and the agent never called it — so a Mac
 * where the agent had never asked had NO row to grant. The user toggled the
 * "Digby" app ON (a DIFFERENT TCC client than the agent binary) and reads
 * still failed with calendar-denied, forever.
 *
 * THE 0.9.11 FIX (kept): when the READ path (calendar.ts) classifies tier 0
 * (notDetermined — "not requested: EventKit calendar auth status 0"), it
 * fires requestCalendarAccessOnce() HERE. The AppleScript below calls the
 * requesting API from THIS process, so the TCC row is minted for the agent
 * binary (launchd DigbyAgent / app-bundled DigbyHelper) and the native
 * consent dialog fires on the Mac; after the user approves (and the agent
 * relaunches), ordinary reads read tier 3.
 *
 * THE 0.9.23 DEFECT THIS FILE CORRECTS (measured live 2026-11-06, three
 * Macs: cql-stanne-mbp-1, example-tailnet-peer, cql-stanne-mbp-3 — all
 * online on 0.9.23, every read still tier 0). Three things were wrong and
 * together they produced a silent no-op reported to the owner as success:
 *
 *   1. THE PROCESS EXITED BEFORE THE PROMPT COULD APPEAR. The request is
 *      ASYNCHRONOUS: it returns immediately and delivers its outcome to a
 *      completion handler. The old script returned from `on run` right
 *      after issuing the call, so osascript tore the process down — and a
 *      request whose requesting process is gone cannot present a prompt or
 *      mint a TCC row. Fixed by keeping the script (and its run loop)
 *      ALIVE until the completion fires or a bounded wait expires.
 *   2. THE OUTCOME WAS DELIBERATELY DISCARDED, so a request that never ran
 *      and a request that worked were indistinguishable to the backend —
 *      which then told the owner "a one-time consent dialog was just
 *      triggered" either way. Fixed: the run prints a machine-readable
 *      observation line (idiom | completed | waited | authorization tier)
 *      and calendar-consent.ts classifies + persists an honest episode.
 *   3. ONE UNPROVEN IDIOM, NO FALLBACK. `completion:(my "handler:")` — a
 *      script object bridged to an ObjC block — is documented in-tree as
 *      "not a proven idiom on every macOS build". Fixed: the modern
 *      `requestFullAccessToEventsWithCompletion:` (macOS 14+) is tried
 *      first, the legacy entity-type call second, and if BOTH fail the
 *      episode records `bridge-failed` (a state the old code could not
 *      express) instead of a log line nobody reads.
 *
 * THE TRUTH COMES FROM THE STATUS API, NOT FROM THE REQUEST. The reported
 * tier is always the plain `authorizationStatusForEntityType` read — the
 * idiom the ek6 control arm proved on both controlled Macs. A request that
 * "succeeded" while the tier stayed 0 is recorded as `dispatched` (asked,
 * no decision observed) and NEVER as granted; only tier 3/5 reads granted.
 *
 * INVARIANTS (pinned by test/tier0-request.daf8706a.test.mjs and
 * test/calendar-consent.<this ticket>.test.mjs):
 *   - THE ONLY requesting EventKit API in the agent: calendar.ts, index.ts,
 *     permissions.ts, tcc-regrant.ts, api.ts and config.ts stay free of
 *     requestAccessToEntityType (the c44b19e9 pin on the read + preflight
 *     surfaces remains literally true; the 0.9.8 rule "status surfaces
 *     never drive a requesting API" is untouched — the poll, status probe
 *     and preflight never import this module).
 *   - ONCE per process lifetime, AND once per consent episode: a persisted
 *     episode younger than EPISODE_REPROMPT_SUPPRESS_MS (dialog-open or
 *     dispatched) suppresses a re-fire across a relaunch, so a restart loop
 *     cannot stack prompts.
 *   - FIRE-AND-FORGET from the caller: never awaited by the dispatch, never
 *     throws out of the caller. The RESULT is no longer discarded, though —
 *     it is classified and persisted (calendar-consent.ts) and reaches the
 *     backend on the next calendar read's payload.
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
import {
  classifyConsentEpisode,
  consentLogLine,
  readConsentEpisode,
  recordConsentEpisode,
  type CalendarConsentEpisode,
  type CalendarRequestExit,
} from './calendar-consent';

/**
 * How long the requesting script stays alive waiting for the completion
 * handler (in 0.5 s ticks — see the `delay 0.5` in the loop below). A modal
 * consent prompt blocks until the user answers, so a short bound guarantees
 * the process dies before the prompt is presented — the exact 0.9.23
 * failure. 120 ticks = 60 s: long enough for a person to notice the dialog,
 * short enough that a walked-away Mac does not leak a child indefinitely.
 */
export const CALENDAR_REQUEST_WAIT_TICKS = 120;
/** Outer bound on the child. Must exceed WAIT_TICKS * 0.5 s so the script's
 *  own bounded wait — not the kill signal — is what normally ends it. */
export const CALENDAR_REQUEST_TIMEOUT_MS = 90_000;
/** A suppressed re-fire window across process restarts. macOS shows the
 *  consent prompt once per client anyway; this stops a relaunch loop from
 *  spawning a prompt-storm while an episode is genuinely undecided. */
export const EPISODE_REPROMPT_SUPPRESS_MS = 10 * 60 * 1000;

const REQUEST_ACCESS_SCRIPT = `
use AppleScript version "2.4"
use framework "Foundation"
use framework "EventKit"
use scripting additions

property calendarGrantObserved : false

on run
	set EVT to 0
	set idiom to "none"
	set store to (current application's EKEventStore's alloc()'s init())
	-- Modern API first (macOS 14+): requestFullAccessToEventsWithCompletion:
	-- is the non-deprecated requesting call. An older macOS throws on the
	-- selector, which is exactly why the legacy call below is a FALLBACK and
	-- not the only idiom.
	try
		store's requestFullAccessToEventsWithCompletion:(my "calendarAccessSeen:")
		set idiom to "full-access"
	end try
	if idiom is "none" then
		try
			store's requestAccessToEntityType:EVT completion:(my "calendarAccessSeen:")
			set idiom to "entity-type"
		end try
	end if
	-- KEEP THE PROCESS ALIVE while the request is outstanding. The request is
	-- asynchronous; returning from run here tears osascript down before macOS
	-- can present the prompt, and a request whose process is gone mints no
	-- TCC row and shows no dialog. This wait loop is the 0.9.23 repair.
	set waited to 0
	if idiom is not "none" then
		repeat while (calendarGrantObserved is false) and (waited < ${CALENDAR_REQUEST_WAIT_TICKS})
			delay 0.5
			set waited to waited + 1
		end repeat
	end if
	set doneFlag to 0
	if calendarGrantObserved then set doneFlag to 1
	-- Report the OBSERVATION, never a claim: which idiom was issued, whether
	-- the completion handler ever fired, how long we held the run loop, and
	-- the authorization tier read from the proven status API afterwards.
	set authRaw to (current application's EKEventStore's authorizationStatusForEntityType:EVT)
	set auth to (authRaw as integer)
	return ("DIGBY_CAL|" & idiom & "|" & doneFlag & "|" & waited & "|" & auth)
end run

on calendarAccessSeen:theGrant
	set calendarGrantObserved to true
	return
end calendarAccessSeen:
`;

/** The observation line the requesting script prints. Parsed defensively:
 *  anything unparseable is an `error` exit, never an invented state. */
export interface CalendarRequestObservation {
  idiom: string;
  /** Did the completion handler fire? (1 = the request completed and macOS
   *  answered it, 0 = we never got an answer.) */
  completed: boolean;
  /** Ticks (0.5 s) the run loop was held. */
  waitedTicks: number;
  /** EventKit authorization tier observed AFTER the request, or null when
   *  the script's own tier read failed. */
  tierAfter: number | null;
}

/** Parse `DIGBY_CAL|<idiom>|<0|1>|<ticks>|<tier>`; null when the line is
 *  absent or malformed. Pure — exported for the test suite. */
export function parseRequestObservation(stdout: string): CalendarRequestObservation | null {
  const line = String(stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('DIGBY_CAL|'));
  if (!line) return null;
  const parts = line.split('|');
  if (parts.length < 5) return null;
  const idiom = parts[1] || 'none';
  const completed = parts[2] === '1';
  const ticks = Number(parts[3]);
  const tier = Number(parts[4]);
  if (!Number.isFinite(ticks) || ticks < 0) return null;
  return {
    idiom,
    completed,
    waitedTicks: ticks,
    // -1 is the script's "the status read itself failed" sentinel.
    tierAfter: Number.isFinite(tier) && tier >= 0 ? tier : null,
  };
}

/**
 * Turn a child's termination + parsed line into the exit kind the classifier
 * consumes. Pure — exported for the test suite (no macOS needed).
 *
 * The distinction that matters: a KILLED child is `timeout` only when the
 * requesting script had actually held the run loop (ie it was alive and
 * waiting) — a prompt may then be on screen. A child that exits non-zero,
 * or prints nothing we can parse, is `error`: the request never ran.
 */
export function classifyRequestExit(args: {
  killedByTimeout: boolean;
  exitError: boolean;
  observation: CalendarRequestObservation | null;
}): CalendarRequestExit {
  if (args.observation) {
    // We got a readable observation: the script ran to completion, so the
    // request WAS issued (or the script told us both idioms failed).
    if (args.observation.idiom === 'none') return 'error';
    if (args.killedByTimeout) return 'timeout';
    // Held the full wait without the completion firing ⇒ the prompt is
    // outstanding; `timeout` is the exit kind that maps to dialog-open.
    if (!args.observation.completed && args.observation.waitedTicks >= CALENDAR_REQUEST_WAIT_TICKS) return 'timeout';
    return 'ok';
  }
  // No readable observation line. Two shapes, and the difference matters for
  // the copy: a KILLED child may have a prompt on screen (the script was
  // alive long enough to be killed at the bound); anything else means we
  // cannot confirm the request was ever issued, which is `error` — the
  // state that tells the user to grant access by hand instead of waiting
  // for a dialog that may never come.
  if (args.killedByTimeout) return 'timeout';
  return 'error';
}

let tier0RequestFired = false;

/** True when a persisted episode is recent enough that re-firing would stack
 *  prompts across a relaunch. Read-only (non-requesting). */
function episodeSuppressesRefire(now: number): boolean {
  const prev = readConsentEpisode();
  if (!prev) return false;
  if (prev.state !== 'dialog-open' && prev.state !== 'dispatched') return false;
  const at = Date.parse(prev.at);
  if (!Number.isFinite(at)) return false;
  return now - at < EPISODE_REPROMPT_SUPPRESS_MS;
}

/**
 * Fire the tier-0 consent request once per process (and once per consent
 * episode), then classify + persist what was OBSERVED. Called ONLY by
 * calendar.ts's tier-0 classification (the read path) — the poll/status/
 * preflight surfaces never import this module, keeping the 0.9.8
 * no-requesting-probe invariant intact.
 *
 * Fire-and-forget by contract: returns immediately, never throws.
 */
export function requestCalendarAccessOnce(): void {
  if (tier0RequestFired) return;
  tier0RequestFired = true;
  if (episodeSuppressesRefire(Date.now())) {
    // An undecided episode from a few minutes ago — macOS is still holding
    // (or the owner has not answered) the prompt this process asked for.
    // Do not stack a second one; the persisted episode is the report.
    return;
  }
  let scriptPath = '';
  try {
    const dir = mkdtempSync(join(tmpdir(), 'digby-calendar-request-'));
    scriptPath = join(dir, 'request-access.applescript');
    writeFileSync(scriptPath, REQUEST_ACCESS_SCRIPT, 'utf8');
  } catch {
    // Same staging-failure contract as the read path: log and record, never
    // a throw out of the caller.
    const staged = classifyConsentEpisode({
      tierAfter: null,
      requestExit: 'staging-failed',
      idiom: 'none',
    });
    recordConsentEpisode(staged);
    console.error(consentLogLine(staged));
    return;
  }
  execFile(
    'osascript',
    [scriptPath],
    { timeout: CALENDAR_REQUEST_TIMEOUT_MS, killSignal: 'SIGKILL' },
    (err, stdout, stderr) => {
      try {
        rmSync(dirname(scriptPath), { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      const observation = parseRequestObservation(String(stdout || ''));
      const killedByTimeout = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed);
      const requestExit = classifyRequestExit({ killedByTimeout, exitError: Boolean(err), observation });
      const episode: CalendarConsentEpisode = classifyConsentEpisode({
        tierAfter: observation ? observation.tierAfter : null,
        requestExit,
        idiom: observation ? observation.idiom : 'none',
      });
      recordConsentEpisode(episode);
      // One line per episode, naming what was OBSERVED (never a claim that a
      // dialog appeared). `bridge-failed` is the state a human must act on;
      // it is loud on purpose.
      if (episode.state === 'bridge-failed' || episode.state === 'request-failed') {
        console.error(
          consentLogLine(episode) +
            ' — the EventKit consent request could not be issued on this macOS build; grant Calendar access to this binary in System Settings → Privacy & Security → Calendars',
        );
        if (stderr) {
          console.error(`[calendar] request stderr: ${String(stderr).split('\n')[0]}`);
        }
      } else {
        console.log(consentLogLine(episode));
      }
    },
  );
}