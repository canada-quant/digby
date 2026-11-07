/**
 * Calendar CONSENT EPISODE store — the honest record of what happened when
 * this agent asked macOS for Calendars access (ticket: "still no calendar
 * sync on new chats", 2026-11-06).
 *
 * WHY THIS FILE EXISTS. daf8706a (0.9.11) added the one-shot requesting call
 * and made a tier-0 read classify as `calendar-never-requested`, but the
 * request itself was FIRE-AND-FORGET with the outcome DELIBERATELY DISCARDED
 * — while the backend copy told the owner "a one-time consent dialog was just
 * triggered". That sentence was never verified by anything: the ASOC idiom
 * it rode on (`completion:(my "handler:")` — a script object bridged to an
 * ObjC block) is not a proven idiom on any macOS build, its error path was a
 * single log line, and a request that silently did nothing was reported to
 * the user exactly like one that worked. The owner consequently approved
 * dialogs that never appeared, on three Macs, and every read kept answering
 * "no Calendars entry exists for the agent yet".
 *
 * THE RULE THIS FILE ENFORCES. A state is recorded only when it was OBSERVED,
 * and the observation that matters is `authorizationStatusForEntityType` —
 * the plain, proven read (the ek6 control arm measured it on both Macs; the
 * REQUEST idiom is the unproven one). So:
 *
 *   granted  ← the status API says 3/5 AFTER the request returned. Verifiable.
 *   denied   ← the status API says 1/2 after the request. Verifiable.
 *   dialog-open ← the request process was still running at the bound. A
 *              blocked call is consistent with a modal prompt waiting, and
 *              that is all the copy may claim ("may be waiting").
 *   dispatched  ← the request returned WITHOUT error and the tier is STILL 0.
 *              The honest reading is "asked, no decision observed" — NOT
 *              "a dialog appeared". The copy never upgrades this to a dialog.
 *   bridge-failed ← every request idiom we tried errored. This is the ONE
 *              state that says the request could not be issued at all, which
 *              is exactly the failure mode the old code hid.
 *   request-failed ← our own staging/exec plumbing failed before the request
 *              could be made.
 *
 * The record is a SINGLE scalar episode (the last thing that happened), not a
 * history: the read path re-derives the current truth from the status API on
 * every call, so a stale record can never masquerade as a live grant. It is
 * persisted only so a process that restarts (launchd, self-update) and the
 * BACKEND (via the read payload) can both see what the last episode observed.
 *
 * STORAGE. `calendar-consent.json` inside the agent's CONFIG_DIR (next to
 * config.json / device-id), written 0o600. It deliberately holds NO secret —
 * a state word, an ISO timestamp, the observed tier and the request exit kind
 * — and it must live OUTSIDE the agent source tree, which the self-update
 * swap replaces wholesale.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { configPath, AGENT_VERSION } from './config';

/** What the last consent episode OBSERVED. See the module head for what each
 *  state is allowed to claim — no state may be read as "the user saw a
 *  dialog" except `dialog-open` (which says only that the call was blocked). */
export type CalendarConsentState =
  /** The request process was still running at the timeout bound — a modal
   *  consent prompt may be waiting on that Mac. NOT a confirmation. */
  | 'dialog-open'
  /** The request returned without error; the status API still reports
   *  notDetermined. Asked, no decision observed. */
  | 'dispatched'
  /** The status API reports authorized (3/5) after the request. */
  | 'granted'
  /** The status API reports denied/restricted (1/2) after the request. */
  | 'denied'
  /** Every request idiom errored — the request could not be issued. */
  | 'bridge-failed'
  /** Staging/exec of the request itself failed (our plumbing, not macOS). */
  | 'request-failed';

/** How the request child settled. Persisted for diagnosis: "we asked and the
 *  API returned" vs "we never managed to ask" are different bugs. */
export type CalendarRequestExit = 'ok' | 'timeout' | 'error' | 'staging-failed';

export interface CalendarConsentEpisode {
  state: CalendarConsentState;
  /** ISO-8601 instant the observation was made. */
  at: string;
  /** The EventKit authorization tier read AFTER the request (null = the
   *  status read itself failed; then the state is request-shaped only). */
  observedTier: number | null;
  /** Which request idiom produced the exit ('full-access' | 'entity-type' |
   *  'handler-bridge' | 'none'). Lets a later diagnosis tell WHICH bridge
   *  failed on the owner's macOS build instead of "it didn't work". */
  idiom: string;
  requestExit: CalendarRequestExit;
  /** The agent version that ran the episode — a fix that ships in 0.9.24 is
   *  visibly distinct from a 0.9.23 record on the backend copy. */
  version: string;
}

const STATE_FILE = 'calendar-consent.json';

/** The agent's own state directory (the same one config.json lives in).
 *  Derived from configPath() so the SUDO_USER-aware home resolution (the
 *  2026-10-29 remote-access defect) is shared, not re-implemented.
 *  DIGBY_CALENDAR_CONSENT_PATH overrides the whole path — the test seam
 *  (and nothing else: it is never set by the installer or the plist). */
function stateDir(): string {
  const override = (process.env.DIGBY_CALENDAR_CONSENT_PATH || '').trim();
  if (override) return dirname(override);
  return dirname(configPath());
}

function statePath(): string {
  const override = (process.env.DIGBY_CALENDAR_CONSENT_PATH || '').trim();
  return override || join(stateDir(), STATE_FILE);
}

const STATES: readonly CalendarConsentState[] = [
  'dialog-open', 'dispatched', 'granted', 'denied', 'bridge-failed', 'request-failed',
];
const EXITS: readonly CalendarRequestExit[] = ['ok', 'timeout', 'error', 'staging-failed'];

/**
 * Record one observed episode. Best-effort by contract: a failed write must
 * NEVER throw into the read path (this is diagnostics, not data) — the caller
 * is a background callback on the calendar read.
 */
export function recordConsentEpisode(episode: CalendarConsentEpisode): void {
  try {
    if (!existsSync(stateDir())) mkdirSync(stateDir(), { recursive: true });
    const target = statePath();
    // Write-then-rename: an interrupted write must never leave a half JSON
    // that reads as "never requested" (the one state that is actionable).
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(episode, null, 2), { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    // Diagnostic only — never a throw out of the read path.
  }
}

/**
 * The last recorded episode, or null when none was ever observed (also null
 * for a corrupt/foreign file — an unknown state must not be invented).
 *
 * NON-REQUESTING by contract: this reads a file. It is safe on the poll,
 * status and preflight surfaces (the 0.9.8 / 30787bc4 rule) — which is why
 * the enrichment in index.ts may call it on every calendar read.
 */
export function readConsentEpisode(): CalendarConsentEpisode | null {
  try {
    if (!existsSync(statePath())) return null;
    const raw = readFileSync(statePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    if (typeof p.state !== 'string' || !STATES.includes(p.state as CalendarConsentState)) return null;
    if (typeof p.at !== 'string' || !p.at) return null;
    const tier = typeof p.observedTier === 'number' && Number.isFinite(p.observedTier) ? p.observedTier : null;
    return {
      state: p.state as CalendarConsentState,
      at: p.at,
      observedTier: tier,
      idiom: typeof p.idiom === 'string' ? p.idiom : 'none',
      requestExit: EXITS.includes(p.requestExit as CalendarRequestExit)
        ? (p.requestExit as CalendarRequestExit)
        : 'error',
      version: typeof p.version === 'string' ? p.version : 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * Build the episode from the two observations the requester actually made:
 * how the request child settled, and what the status API said afterwards.
 * Pure — exported so the classification table is unit-testable without a Mac.
 *
 * The ordering is load-bearing: the STATUS API wins over the request's own
 * return value. A request that reported success while the tier stayed 0 is
 * `dispatched` (no decision observed), never `granted`.
 */
export function classifyConsentEpisode(args: {
  tierAfter: number | null;
  requestExit: CalendarRequestExit;
  idiom: string;
  at?: string;
}): CalendarConsentEpisode {
  const { tierAfter, requestExit, idiom } = args;
  let state: CalendarConsentState;
  if (tierAfter === 3 || tierAfter === 5) {
    // Verifiable grant — regardless of what the request child said.
    state = 'granted';
  } else if (tierAfter === 1 || tierAfter === 2) {
    state = 'denied';
  } else if (requestExit === 'timeout') {
    // The call never returned: consistent with a modal prompt waiting.
    state = 'dialog-open';
  } else if (requestExit === 'staging-failed') {
    state = 'request-failed';
  } else if (requestExit === 'error') {
    // Every idiom we tried failed to compile/run — the request was never
    // issued. This is the state the old fire-and-forget code could not tell
    // apart from success.
    state = 'bridge-failed';
  } else {
    // The request returned cleanly but the tier is unchanged (0 or unreadable).
    state = 'dispatched';
  }
  return {
    state,
    at: args.at || new Date().toISOString(),
    observedTier: tierAfter,
    idiom,
    requestExit,
    version: AGENT_VERSION,
  };
}

/**
 * One-line operator log for the episode — the agent log is where a future
 * diagnosis starts, so it names the idiom and the observed tier, never a
 * claim about a dialog.
 */
export function consentLogLine(e: CalendarConsentEpisode): string {
  return `[calendar] consent episode: state=${e.state} idiom=${e.idiom} exit=${e.requestExit} tier=${e.observedTier === null ? 'unreadable' : e.observedTier} at=${e.at} (v${e.version})`;
}