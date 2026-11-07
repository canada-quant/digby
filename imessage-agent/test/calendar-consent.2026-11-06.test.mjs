/**
 * Calendar consent EPISODE truthfulness — the 2026-11-06 repair
 * (ticket: "still no calendar sync on new chats/context").
 *
 * THE INCIDENT. On 0.9.23 the agent's tier-0 consent request was
 * fire-and-forget with its outcome DELIBERATELY DISCARDED, while the backend
 * copy told the owner "a one-time consent dialog was just triggered". Three
 * Macs were online, none of them ever acquired a Calendars TCC row, and the
 * dialog that was announced never appeared — because the script returned from
 * `on run` immediately, so osascript exited before macOS could present an
 * asynchronous consent prompt.
 *
 * These tests pin the REPAIR, not the prose:
 *   1. the requesting script holds its run loop until the completion fires or a
 *      bounded wait expires (a sub-second run is the 0.9.23 bug);
 *   2. the observation line is parsed defensively and the exit kind is derived
 *      from what actually happened (timeout with a live child = dialog-open,
 *      no readable line = error/bridge-failed — never "success");
 *   3. the classifier puts the STATUS API first: asked-but-tier-0 is
 *      `dispatched`, never `granted`;
 *   4. the episode persists atomically with 0600 and is read back (corrupt ⇒
 *      null, never an invented state);
 *   5. a recent undecided episode suppresses a re-fire across a relaunch;
 *   6. `calendar_consent_status` is NON-REQUESTING (no EventKit request, no
 *      osascript request script) so it is safe on a poll.
 *
 * Runs on Linux CI: nothing here executes AppleScript.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url).pathname;
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

// The consent module reads its state path from the env at call time, so the
// suite points it at a scratch dir BEFORE importing the compiled module.
const scratch = mkdtempSync(join(tmpdir(), 'digby-consent-test-'));
const STATE_PATH = join(scratch, 'calendar-consent.json');
process.env.DIGBY_CALENDAR_CONSENT_PATH = STATE_PATH;

const { classifyConsentEpisode, readConsentEpisode, recordConsentEpisode, consentLogLine } =
  await import(join(root, 'dist/calendar-consent.js'));
const { parseRequestObservation, classifyRequestExit, CALENDAR_REQUEST_WAIT_TICKS, CALENDAR_REQUEST_TIMEOUT_MS, EPISODE_REPROMPT_SUPPRESS_MS } =
  await import(join(root, 'dist/calendar-request.js'));

const requestSrc = read('src/calendar-request.ts');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── 1. The script keeps the process alive (THE 0.9.23 bug) ──────────────────

test('the requesting script WAITS for the completion instead of returning immediately', () => {
  // The defect: `on run` issued the request and returned. A returning run
  // tears osascript down before macOS can present an asynchronous prompt, so
  // no window appears and no TCC row is minted. The script must hold a run
  // loop bounded by CALENDAR_REQUEST_WAIT_TICKS.
  assert.match(
    requestSrc,
    /repeat while \(calendarGrantObserved is false\) and \(waited < \$\{CALENDAR_REQUEST_WAIT_TICKS\}\)/,
    'the run loop must wait on the completion flag',
  );
  assert.match(requestSrc, /delay 0\.5/, 'the wait loop must tick (a spin loop would burn a core)');
  assert.ok(CALENDAR_REQUEST_WAIT_TICKS >= 60, `the wait must outlast a person noticing a dialog (got ${CALENDAR_REQUEST_WAIT_TICKS} ticks)`);
  // The outer kill bound must exceed the script's own wait, otherwise the
  // process is always killed first and the observation line is never printed.
  assert.ok(
    CALENDAR_REQUEST_TIMEOUT_MS > CALENDAR_REQUEST_WAIT_TICKS * 500,
    'the child timeout must exceed the script wait so the script — not the signal — ends the call',
  );
});

test('a completion handler exists at all, and the modern API is tried before the legacy one', () => {
  assert.match(requestSrc, /on calendarAccessSeen:theGrant/, 'a completion handler must be installed');
  assert.match(requestSrc, /requestFullAccessToEventsWithCompletion:/, 'macOS 14+ requesting API');
  assert.match(requestSrc, /requestAccessToEntityType:EVT completion:/, 'legacy requesting API as a FALLBACK');
  // The modern call must come first (it is the non-deprecated one).
  assert.ok(
    requestSrc.indexOf('requestFullAccessToEventsWithCompletion:') < requestSrc.indexOf('requestAccessToEntityType:EVT completion:'),
    'modern API first, legacy fallback second',
  );
});

test('the script reports an OBSERVATION, and the tier comes from the proven status API', () => {
  assert.match(requestSrc, /DIGBY_CAL\|/, 'a machine-readable observation line');
  assert.match(requestSrc, /authorizationStatusForEntityType:EVT/, 'the tier is read from the status API, not inferred');
  // The observation must be issued even when both request idioms failed, so
  // "the request never ran" is distinguishable from "asked, undecided".
  assert.match(requestSrc, /if idiom is "none" then/);
});

test('the script stays a CONSTANT (injection safety) and is staged in a temp dir', () => {
  // No interpolation of user data anywhere in the script text: the only
  // ${...} in the template is the numeric wait bound.
  const template = requestSrc.slice(requestSrc.indexOf('const REQUEST_ACCESS_SCRIPT = `'), requestSrc.indexOf('on calendarAccessSeen:theGrant'));
  const interpolations = [...template.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
  for (const expr of interpolations) {
    assert.equal(expr, 'CALENDAR_REQUEST_WAIT_TICKS', `unexpected interpolation in the script: ${expr}`);
  }
  assert.match(requestSrc, /mkdtempSync\(join\(tmpdir\(\), 'digby-calendar-request-'\)\)/, 'staged in a private temp dir');
  assert.match(requestSrc, /rmSync\(dirname\(scriptPath\)/, 'the temp dir is always cleaned up');
});

// ── 2. Observation parsing / exit classification ────────────────────────────

test('parseRequestObservation reads the line and refuses garbage', () => {
  const ok = parseRequestObservation('noise\nDIGBY_CAL|full-access|1|3|3\ntrailing');
  assert.deepEqual(ok, { idiom: 'full-access', completed: true, waitedTicks: 3, tierAfter: 3 });

  const neverAsked = parseRequestObservation('DIGBY_CAL|none|0|0|-1');
  assert.equal(neverAsked.idiom, 'none');
  assert.equal(neverAsked.tierAfter, null, '-1 sentinel = the status read itself failed');

  assert.equal(parseRequestObservation(''), null);
  assert.equal(parseRequestObservation('DIGBY_CAL|partial'), null);
  assert.equal(parseRequestObservation('DIGBY_CAL|entity-type|0|abc|0'), null, 'non-numeric ticks are rejected');
});

test('classifyRequestExit: a killed child is a timeout only when a prompt may be up', () => {
  const live = { idiom: 'entity-type', completed: false, waitedTicks: CALENDAR_REQUEST_WAIT_TICKS, tierAfter: 0 };
  assert.equal(classifyRequestExit({ killedByTimeout: false, exitError: false, observation: live }), 'timeout');
  assert.equal(classifyRequestExit({ killedByTimeout: true, exitError: true, observation: live }), 'timeout');

  const completed = { idiom: 'full-access', completed: true, waitedTicks: 2, tierAfter: 3 };
  assert.equal(classifyRequestExit({ killedByTimeout: false, exitError: false, observation: completed }), 'ok');

  // BOTH idioms failed ⇒ the request was never issued. This is the state the
  // old code could not express (it logged and moved on).
  const none = { idiom: 'none', completed: false, waitedTicks: 0, tierAfter: 0 };
  assert.equal(classifyRequestExit({ killedByTimeout: false, exitError: true, observation: none }), 'error');

  // No readable line at all ⇒ never assume success.
  assert.equal(classifyRequestExit({ killedByTimeout: false, exitError: false, observation: null }), 'error');
  assert.equal(classifyRequestExit({ killedByTimeout: true, exitError: true, observation: null }), 'timeout');
});

// ── 3. The classifier: the STATUS API wins ─────────────────────────────────

test('classifyConsentEpisode: granted/denied come only from an observed tier', () => {
  assert.equal(classifyConsentEpisode({ tierAfter: 3, requestExit: 'ok', idiom: 'full-access' }).state, 'granted');
  assert.equal(classifyConsentEpisode({ tierAfter: 5, requestExit: 'timeout', idiom: 'entity-type' }).state, 'granted');
  assert.equal(classifyConsentEpisode({ tierAfter: 1, requestExit: 'ok', idiom: 'entity-type' }).state, 'denied');
  assert.equal(classifyConsentEpisode({ tierAfter: 2, requestExit: 'ok', idiom: 'entity-type' }).state, 'denied');
});

test('classifyConsentEpisode: a clean request that changed nothing is `dispatched`, NEVER granted', () => {
  const e = classifyConsentEpisode({ tierAfter: 0, requestExit: 'ok', idiom: 'full-access' });
  assert.equal(e.state, 'dispatched');
  assert.equal(e.observedTier, 0);
});

test('classifyConsentEpisode: timeout ⇒ dialog-open, error ⇒ bridge-failed, staging ⇒ request-failed', () => {
  assert.equal(classifyConsentEpisode({ tierAfter: 0, requestExit: 'timeout', idiom: 'entity-type' }).state, 'dialog-open');
  assert.equal(classifyConsentEpisode({ tierAfter: null, requestExit: 'error', idiom: 'none' }).state, 'bridge-failed');
  assert.equal(classifyConsentEpisode({ tierAfter: null, requestExit: 'staging-failed', idiom: 'none' }).state, 'request-failed');
});

test('the episode records the idiom, exit, version and an ISO instant (so a later fix is visible)', () => {
  const e = classifyConsentEpisode({ tierAfter: 0, requestExit: 'error', idiom: 'entity-type', at: '2026-11-06T10:00:00.000Z' });
  assert.equal(e.idiom, 'entity-type');
  assert.equal(e.requestExit, 'error');
  assert.equal(e.at, '2026-11-06T10:00:00.000Z');
  assert.equal(e.version, JSON.parse(read('package.json')).version);
  assert.match(consentLogLine(e), /state=bridge-failed idiom=entity-type exit=error tier=0/);
});

// ── 4. Persistence ─────────────────────────────────────────────────────────

test('an episode round-trips through the store with 0600 permissions', () => {
  rmSync(STATE_PATH, { force: true });
  const e = classifyConsentEpisode({ tierAfter: 0, requestExit: 'timeout', idiom: 'entity-type' });
  recordConsentEpisode(e);
  assert.ok(existsSync(STATE_PATH));
  assert.equal(statSync(STATE_PATH).mode & 0o777, 0o600, 'the record must not be world-readable');
  const back = readConsentEpisode();
  assert.equal(back.state, 'dialog-open');
  assert.equal(back.idiom, 'entity-type');
});

test('a corrupt or foreign record reads as null, never as an invented state', () => {
  writeFileSync(STATE_PATH, '{ not json');
  assert.equal(readConsentEpisode(), null);
  writeFileSync(STATE_PATH, JSON.stringify({ state: 'super-granted', at: '2026-11-06T00:00:00Z' }));
  assert.equal(readConsentEpisode(), null, 'unknown states are not trusted');
  writeFileSync(STATE_PATH, JSON.stringify({ at: '2026-11-06T00:00:00Z' }));
  assert.equal(readConsentEpisode(), null);
  rmSync(STATE_PATH, { force: true });
  assert.equal(readConsentEpisode(), null, 'no record = no episode (not "never requested")');
});

test('the record holds no secret', () => {
  rmSync(STATE_PATH, { force: true });
  recordConsentEpisode(classifyConsentEpisode({ tierAfter: 0, requestExit: 'ok', idiom: 'full-access' }));
  const raw = readFileSync(STATE_PATH, 'utf8');
  for (const forbidden of ['token', 'secret', 'password', 'Bearer']) {
    assert.ok(!raw.toLowerCase().includes(forbidden.toLowerCase()), `the episode must not carry ${forbidden}`);
  }
});

// ── 5. Prompt discipline ───────────────────────────────────────────────────

test('the module fires once per process and suppresses a re-fire for a recent undecided episode', () => {
  // Once per process: a module-scope latch flipped before any work.
  assert.match(requestSrc, /let tier0RequestFired = false;/);
  assert.match(requestSrc, /if \(tier0RequestFired\) return;\s*\n\s*tier0RequestFired = true;/);
  // Across a relaunch: an undecided episode younger than the window wins.
  assert.match(requestSrc, /prev\.state !== 'dialog-open' && prev\.state !== 'dispatched'/);
  assert.ok(EPISODE_REPROMPT_SUPPRESS_MS >= 60_000, 'the suppression window must be long enough to stop a relaunch storm');

  rmSync(STATE_PATH, { force: true });
  // A GRANTED/DENIED episode is decided — it must not suppress a later attempt
  // (the user may have re-granted after a denial).
  recordConsentEpisode(classifyConsentEpisode({ tierAfter: 0, requestExit: 'error', idiom: 'none' }));
  assert.match(strip(requestSrc), /if \(episodeSuppressesRefire\(Date\.now\(\)\)\)/, 'the gate is consulted at fire time');
});

// ── 6. The status surface is NON-REQUESTING ────────────────────────────────

test('calendar_consent_status never requests access (safe on a poll)', () => {
  const index = read('src/index.ts');
  const start = index.indexOf("case 'calendar_consent_status':");
  assert.ok(start > 0, 'the command exists');
  const block = index.slice(start, start + 1200);
  assert.doesNotMatch(block, /requestAccessToEntityType|requestFullAccessToEvents/, 'no requesting API on the status path');
  assert.doesNotMatch(block, /requestCalendarAccessOnce/, 'the status path must not fire the requester');
  assert.match(block, /readConsentEpisode\(\)/, 'it reports the persisted observation');
  assert.match(block, /calendarAuthStatus\(\)/, 'and the non-requesting authorization-status probe');

  // The requester lives in exactly ONE module, and only the READ path imports it.
  for (const f of ['src/index.ts', 'src/permissions.ts', 'src/tcc-regrant.ts', 'src/api.ts', 'src/config.ts', 'src/permissions.ts']) {
    assert.doesNotMatch(strip(read(f)), /requestCalendarAccessOnce/, `${f} must not import the requester`);
  }
  assert.match(read('src/calendar.ts'), /import \{ requestCalendarAccessOnce \} from '\.\/calendar-request';/);
});

test('the consent module never claims a dialog appeared, in code or copy', () => {
  // The exact sentence the old backend printed unconditionally.
  assert.doesNotMatch(requestSrc, /dialog was (just )?triggered/i);
  assert.doesNotMatch(read('src/calendar-consent.ts'), /dialog was (just )?triggered/i);
});