/**
 * TCC grant-loss self-heal replay (feedback ticket c44b19e9 — 2026-10-24,
 * agent 0.9.9).
 *
 * THE MISHAP (observed live on cql-stanne-mbp1, 0.9.7, re-probed 19:26Z
 * 2026-10-24): a self-update swaps the node binary tree; macOS TCC keys the
 * Accessibility / Screen Recording / Full Disk Access / Calendars (EventKit)
 * grants to the binary's exact file identity, so they silently die. The
 * agent kept polling with a stale (or absent) advert, capabilities failed at
 * task time with a BARE classified error ({"reason":"calendar-denied"} — no
 * remediation), and the owner was never told to re-grant + QUIT + RELAUNCH
 * (incident 6f4f8b36: a newly granted permission only applies to a freshly
 * launched process).
 *
 * THE FIX under test — three surfaces, one module (src/tcc-regrant.ts):
 *   1. ONE post-update preflight (non-requesting only: authorization-status
 *      queries; NEVER a requesting API — the 0.9.8 rule from 30787bc4),
 *      producing ONE consolidated 'tcc-regrant-needed' event listing every
 *      lost grant + the System Settings pane deep-link per grant.
 *   2. The runtime grant-loss watchdog: call-time TCC-denial outcomes
 *      (calendar-denied / the 33401f39 corroborated solid-black-capture
 *      conviction / the chatdb FDA block) convict their grant and surface
 *      the SAME consolidated card, once per episode.
 *   3. The episode arithmetic: a conviction ADDS, a real success HEALS; the
 *      poll carries the joined key only while the episode is open.
 *
 * Two layers, the house idiom (permission-regression.e2915963 /
 * sr-probe-backoff.30787bc4):
 *   1. REAL unit tests of the pure functions in dist/ (npm test builds
 *      first — this exercises the code that ships).
 *   2. SOURCE-BYTE pins on the wiring that cannot run on Linux.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const read = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');

const tcc = await import(join(pkgRoot, 'dist', 'tcc-regrant.js'));
const {
  buildTccReGrantNeeded,
  regrantNeededMessage,
  regrantEpisodeKey,
  convictionChangesEpisode,
  classifyDenial,
  preflightGrants,
  preflightCauseFromSwap,
  WATCHDOG_CAUSE,
  REGRANT_PANE_URLS,
  REGRANT_LABELS,
} = tcc;
const indexDist = await import(join(pkgRoot, 'dist', 'index.js'));
const { denialFromErrorText } = indexDist;

const indexSrc = read('src/index.ts');
const calendarSrc = read('src/calendar.ts');
const permissionsSrc = read('src/permissions.ts');

// ── 1. The consolidated event shape ──────────────────────────────────────────

test('c44b19e9: buildTccReGrantNeeded — ONE event lists EVERY lost grant in canonical order with its pane deep-link', () => {
  const e = buildTccReGrantNeeded(['cal', 'sr', 'ax', 'ax'], 'self-update 0.9.9 swapped the agent binary at 2026-10-24T18:48:00Z');
  // Deduped + canonical order (ax, sr, fda, cal) — a stable wire shape.
  assert.deepEqual(e.grants, ['ax', 'sr', 'cal']);
  // The pane deep-link per grant, in the SAME order.
  assert.deepEqual(e.panes, [REGRANT_PANE_URLS.ax, REGRANT_PANE_URLS.sr, REGRANT_PANE_URLS.cal]);
  assert.equal(e.type, 'tcc-regrant-needed');
  assert.equal(e.cause, 'self-update 0.9.9 swapped the agent binary at 2026-10-24T18:48:00Z');
  // The operator rule rides every event: relaunch REQUIRED.
  assert.equal(e.relaunchRequired, true);
});

test('c44b19e9: an empty grant set builds NO event (never a zero-grant card)', () => {
  assert.equal(buildTccReGrantNeeded([], null), null);
});

test('c44b19e9: every pane deep-link is the Privacy & Security URL — and Calendars joins the set', () => {
  for (const url of Object.values(REGRANT_PANE_URLS)) {
    assert.match(url, /^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_/);
  }
  assert.match(REGRANT_PANE_URLS.cal, /Privacy_Calendars$/);
  assert.match(REGRANT_PANE_URLS.sr, /Privacy_ScreenCapture$/);
  assert.match(REGRANT_PANE_URLS.fda, /Privacy_AllFiles$/);
  assert.match(REGRANT_PANE_URLS.ax, /Privacy_Accessibility$/);
});

test('c44b19e9: the user-facing message names every grant, ends with the QUIT+RELAUNCH line (the operator rule)', () => {
  const e = buildTccReGrantNeeded(['cal', 'sr'], 'self-update 0.9.9 swapped the agent binary');
  const msg = regrantNeededMessage(e, 'DigbyAgent');
  // Both grants' fix lines, with the helper name the TCC pane lists.
  assert.match(msg, /Calendars — open the Calendars pane, find "DigbyAgent", and turn the switch ON\./);
  assert.match(msg, /Screen Recording — open the Screen Recording pane, find "DigbyAgent", and turn the switch ON\./);
  // The relaunch line LAST — without it the owner re-grants and the RUNNING
  // process stays blind (the 2026-10-24 incident shape).
  assert.match(msg, /Then QUIT and RELAUNCH the Digby agent — the new grant only applies to a freshly launched process/);
  // FDA keeps the add-the-file steps (a CLI node binary has no switch).
  const fda = regrantNeededMessage(buildTccReGrantNeeded(['fda'], null), 'DigbyAgent');
  assert.match(fda, /click \+ \(unlock first if needed\), add the "DigbyAgent" file/);
});

// ── 2. The post-update preflight classification ──────────────────────────────

test('c44b19e9: preflightGrants — the live incident shape: predecessor cal:true + ax:true, successor denied both', () => {
  // mbp-1 at 0.9.7: Accessibility AND Calendars died with the swap.
  const grants = preflightGrants(
    { ax: true, sr: true, fda: true, cal: true },
    { ax: false, sr: true, fda: true },
    false, // calendarAuthStatus: EventKit tier is denied/write-only/not-determined
  );
  assert.deepEqual(grants, ['ax', 'cal']);
});

test('c44b19e9: preflightGrants — an intact Mac (grants survived the swap) yields []', () => {
  const grants = preflightGrants(
    { ax: true, sr: true, fda: true, cal: true },
    { ax: true, sr: true, fda: true },
    true,
  );
  assert.deepEqual(grants, []);
});

test('c44b19e9: preflightGrants — a null calendar status (query failed) never fabricates a Calendars loss', () => {
  const grants = preflightGrants({ cal: true }, { ax: true, sr: true, fda: true }, null);
  assert.deepEqual(grants, []);
});

test('c44b19e9: preflightGrants — a grant the predecessor NEVER had is a pre-existing gap, not a loss (e2915963 contract)', () => {
  // ax was false before the swap (onboarding never completed) and false now:
  // that is the onboarding flow's gap, NOT a swap regression.
  const grants = preflightGrants(
    { ax: false, sr: true, fda: false, cal: false },
    { ax: false, sr: false, fda: false },
    false,
  );
  assert.deepEqual(grants, ['sr']); // only the before-true → now-false key
});

test('c44b19e9: preflightGrants — a null predecessor baseline yields [] (no before→after to observe)', () => {
  assert.deepEqual(preflightGrants(null, { ax: false, sr: false, fda: false }, false), []);
});

test('c44b19e9: preflightCauseFromSwap — no pending swap ⇒ null cause (a plain relaunch never masquerades as one)', () => {
  assert.equal(preflightCauseFromSwap(null, '0.9.9'), null);
  assert.match(
    preflightCauseFromSwap({ swappedAt: '2026-10-24T18:48:00Z' }, '0.9.9'),
    /^self-update 0\.9\.9 swapped the agent binary at 2026-10-24T18:48:00Z$/,
  );
});

// ── 3. The runtime grant-loss watchdog classification ───────────────────────

test('c44b19e9: classifyDenial — each call-time TCC-denial class convicts its grant', () => {
  assert.equal(classifyDenial({ kind: 'calendar-denied' }), 'cal');
  assert.equal(classifyDenial({ kind: 'solid-capture' }), 'sr');
  assert.equal(classifyDenial({ kind: 'fda-block' }), 'fda');
  assert.equal(classifyDenial({ kind: 'ax-block' }), 'ax');
});

test('c44b19e9: denialFromErrorText — the exact error texts the owning suites pin convict their grant; anything else is null', () => {
  // The 933e6ca4 solid-black hint (verbatim from computer.ts permissionBlock).
  assert.deepEqual(
    denialFromErrorText('two consecutive captures came back solid-black at full resolution'),
    { kind: 'solid-capture' },
  );
  // The chatdb FDA guidance text (verbatim from chatdb.ts checkAccess).
  assert.deepEqual(
    denialFromErrorText('Full Disk Access is not granted to this helper yet — Digby cannot read your Messages.'),
    { kind: 'fda-block' },
  );
  // The raw sqlite denial class chatdb classifies by.
  assert.deepEqual(denialFromErrorText('unable to open database file'), { kind: 'fda-block' });
  // computer.ts permissionBlock's line.
  assert.deepEqual(
    denialFromErrorText('Missing macOS permission(s): Accessibility. A setup dialog was shown'),
    { kind: 'ax-block' },
  );
  // A non-permission error is not ours to judge.
  assert.equal(denialFromErrorText('ENOTFOUND digby.example.com'), null);
  assert.equal(denialFromErrorText(null), null);
  assert.equal(denialFromErrorText(''), null);
});

test('c44b19e9: the watchdog cause token is the brief\'s classification label, verbatim', () => {
  assert.equal(WATCHDOG_CAUSE, 'grant lost after update — needs relaunch + re-grant');
});

// ── 4. Episode arithmetic: once-per-episode surfacing ───────────────────────

test('c44b19e9: a conviction the episode already holds changes nothing (no re-push per command)', () => {
  // The 30787bc4 anti-pattern: the same denial on EVERY poll while the
  // episode is open must never re-surface.
  assert.equal(convictionChangesEpisode(['cal'], { kind: 'calendar-denied' }), false);
  assert.equal(convictionChangesEpisode(['cal', 'sr'], { kind: 'solid-capture' }), false);
});

test('c44b19e9: a NEW grant joining the open episode changes it (one fresh surfacing)', () => {
  assert.equal(convictionChangesEpisode(['cal'], { kind: 'solid-capture' }), true);
  assert.equal(convictionChangesEpisode([], { kind: 'calendar-denied' }), true);
});

test('c44b19e9: a null source never changes an episode', () => {
  assert.equal(convictionChangesEpisode(['cal'], null), false);
});

test('c44b19e9: the episode key is the sorted joined set — identical to the backend\'s compare format', () => {
  assert.equal(regrantEpisodeKey(['sr', 'cal']), 'cal,sr');
  assert.equal(regrantEpisodeKey(['cal', 'sr', 'cal']), 'cal,sr'); // deduped
});

// ── 5. PREFLIGHT-ONLY INVARIANT (the deliverable-4 pin) ──────────────────────

test('c44b19e9 pin: the post-update preflight is NON-REQUESTING — authorization-status queries only, never a requesting API', () => {
  // The only new probe the preflight adds is calendarAuthStatus, and its
  // script must be the status query — authorizationStatusForEntityType —
  // NEVER the requesting API (which raises the consent dialog). Since
  // daf8706a (0.9.11) the ONE requesting EventKit call lives in
  // calendar-request.ts and is fired ONLY from the read path's tier-0
  // classification — so calendar.ts itself (read + preflight surface)
  // stays free of it in CODE (comments stripped: prose may discuss the
  // distinction; the quarantine is structural, pinned in
  // tier0-request.daf8706a.test.mjs).
  assert.match(calendarSrc, /authorizationStatusForEntityType:EVT/, 'the status-only EventKit query');
  const code = calendarSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.doesNotMatch(code, /requestAccessToEntityType/, 'no requesting EventKit API in calendar.ts code (the one requester lives in calendar-request.ts)');
});

test('c44b19e9 pin: the preflight block never calls the requesting probes (probeScreenRecording / requestAccessibilityPrompt / a calendar read)', () => {
  // Extract the preflight block and pin its content: it may reference
  // calendarAuthStatus + computePermissionStatus + the latches ONLY.
  const start = indexSrc.indexOf('if (!postUpdatePreflightDone) {');
  const end = indexSrc.indexOf('── Permission-regression surfacing', start);
  assert.ok(start > 0, 'the preflight block exists');
  assert.ok(end > start, 'the preflight block is bounded');
  const block = indexSrc.slice(start, end);
  assert.match(block, /calendarAuthStatus\(\)/, 'the status-only calendar probe');
  assert.doesNotMatch(block, /probeScreenRecording\(/, 'never the throwaway-capture probe');
  assert.doesNotMatch(block, /requestAccessibilityPrompt\(/, 'never the native Accessibility prompt');
  assert.doesNotMatch(block, /listEvents\(/, 'never a real calendar read (consent fires on first read)');
});

test('c44b19e9 pin: the preflight runs ONCE per process (never in a poll loop)', () => {
  assert.match(indexSrc, /let postUpdatePreflightDone = false;/, 'the once-guard exists');
  assert.match(indexSrc, /if \(!postUpdatePreflightDone\) \{\s*\n\s*postUpdatePreflightDone = true;/, 'the guard flips before the body runs');
});

test('c44b19e9 pin: the SR probe stays behind the 0.9.8 backoff gate — no regression of the 30787bc4 fix', () => {
  // The sibling rule: computePermissionStatus may only probe via the
  // backoff gate. Our change must not re-open an un-gated probe path.
  assert.match(permissionsSrc, /shouldProbeScreenRecording\(\) \? await probeScreenRecording\(\) : false/, 'the gated probe call remains');
});

test('c44b19e9 pin: the watchdog convictions come from REAL call outcomes only (never a probe)', () => {
  // The error-path feed classifies the error text of a REAL command; the
  // calendar feed is the classified result of a REAL read. Neither site
  // calls a probe.
  assert.match(indexSrc, /const denial = denialFromErrorText\(e\?\.message \|\| String\(e\)\);/, 'the command-error feed');
  assert.match(indexSrc, /noteTccDenial\(\{ kind: 'calendar-denied' \}\)/, 'the calendar-result feed');
  const feed = indexSrc.slice(indexSrc.indexOf('function noteTccDenial'), indexSrc.indexOf('export function denialFromErrorText'));
  assert.doesNotMatch(feed, /probeScreenRecording|requestAccessibilityPrompt|listEvents/, 'the feed itself never probes');
});

test('c44b19e9 pin: the poll carries the regrant key only while an episode is OPEN', () => {
  assert.match(indexSrc, /openTccEpisode\.length > 0 \? regrantEpisodeKey\(openTccEpisode\) : null/, 'the poll param is conditional');
  assert.match(read('src/api.ts'), /regrant=\$\{encodeURIComponent\(regrant\)\}/, 'api.ts carries the param');
});

test('c44b19e9 pin (review D3): the watchdog classifies RESULT errors too — computer-use denials return Observations, never throws', () => {
  // permissionBlock's {ok:false, error} is the path the solid-capture (SR)
  // and Accessibility convictions actually arrive on; without this pin a
  // refactor back to throw-only classification silently dead-ends them.
  assert.match(indexSrc, /r\.ok === false && typeof r\.error === 'string'/, 'a false-result with an error string is classified');
  assert.match(indexSrc, /noteTccDenial\(denialFromErrorText\(r\.error\)\)/, 'the result error feeds the watchdog');
});

test('c44b19e9 pin: episode heals are reconciled from the latches (never a probe)', () => {
  assert.match(indexSrc, /if \(calendarAdvert\(\) === true\) openTccEpisode = openTccEpisode\.filter\(\(g\) => g !== 'cal'\)/, 'calendar heal');
  assert.match(indexSrc, /if \(lastCaptureTruth\(\) === true\) openTccEpisode = openTccEpisode\.filter\(\(g\) => g !== 'sr'\)/, 'capture heal');
});

test('c44b19e9 pin: the consolidated surfacing is FIRE-AND-FORGET (never awaited by the poll loop)', () => {
  assert.match(indexSrc, /function surfaceTccReGrant\(event: TccReGrantNeeded\): void/, 'returns void');
  assert.doesNotMatch(indexSrc, /await surfaceTccReGrant\(/, 'no call site awaits it');
});

test('c44b19e9 pin (review T1): a regression the OPEN consolidated episode covers is suppressed — ONE incident, ONE dialog', () => {
  // The pure covered-guard: full coverage suppresses; partial does not.
  assert.equal(regressionCovered(['ax', 'sr'], ['ax', 'sr', 'cal']), true);
  assert.equal(regressionCovered(['ax'], ['sr', 'cal']), false);
  assert.equal(regressionCovered(['ax'], []), false);
  // Wired at BOTH e2915963 surfacing sites (the swap-seed and the in-loop
  // flip) — a covered regression never re-fires the older per-key dialog.
  const seedGuard = /if \(seeded\.length > 0 && !regressionCovered\(seeded, openTccEpisode\)\) \{/;
  const flipGuard = /if \(lastRegressionKey !== key && !regressionCovered\(regressed, openTccEpisode\)\) \{/;
  assert.match(indexSrc, seedGuard, 'the seed site carries the covered-guard');
  assert.match(indexSrc, flipGuard, 'the flip site carries the covered-guard');
});

test('c44b19e9 pin: the e2915963 seam is INTACT (its dialog + baseline + stamp-consume still exist)', () => {
  // The consolidated card ADDS a surface; it must not break the sibling fix.
  assert.match(indexSrc, /function surfacePermissionRegression\(keys: TccGrantKey\[\], cause: string \| null\): void/, 'the e2915963 surfacing stands');
  assert.match(indexSrc, /whichPermissionsRegressed\(tccBaseline, permissions\)/, 'the baseline comparison stands');
  assert.match(indexSrc, /readRuntimeSwapStamp\(\)/, 'the stamp read stands');
  assert.match(indexSrc, /clearRuntimeSwapStamp\(\)/, 'the stamp consume stands');
});

test('c44b19e9 pin: the predecessor baseline now persists cal (so a successor can see a LOST Calendars grant)', () => {
  assert.match(read('src/config.ts'), /lastAdvertisedPermissions\?: \{ ax: boolean; sr: boolean; fda: boolean; cal\?: boolean; at: string \}/, 'the config type carries cal');
  assert.match(indexSrc, /\.\.\.\(permissions\.calendar !== undefined \? \{ cal: permissions\.calendar \} : \{\}\)/, 'the persist carries cal only when advertised');
});

test('c44b19e9 pin: the Calendars pane joins the open-pane vocabulary (the card\'s button must not 400 on the agent)', () => {
  assert.match(permissionsSrc, /calendars: 'x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_Calendars'/, 'the pane URL');
  assert.match(permissionsSrc, /export type PermissionPane = 'accessibility' \| 'screen-recording' \| 'full-disk-access' \| 'calendars'/, 'the pane type');
});
