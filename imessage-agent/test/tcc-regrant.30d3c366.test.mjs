/**
 * Ticket 30d3c366 replay — macOS TCC grants (Accessibility / Input Monitoring /
 * Automation) silently dropped after an agent self-update, with no re-prompt.
 *
 * THE MISHAP (observed live on the owner's two Macs): after the DigbyAgent
 * self-updated, the Privacy & Security grants it previously held were gone and
 * macOS never prompted again. cql-stanne-mbp-1 on 2026-10-24 after the 0.9.6
 * self-update (the owner clicked Allow / enabled Accessibility + Automation);
 * cql-stanne-mbp-2 on 2026-10-29 (the owner had to re-enable Accessibility +
 * Input Monitoring by hand and relaunch). Remote control of mbp-2 failed
 * SILENTLY until that manual re-grant; agents misdiagnosed it as "input not
 * landing" / "stuck Shift key" and chased it for hours. The owner's ask,
 * verbatim: "why doesn't it request that for you automatically on new digby
 * install".
 *
 * ROOT CAUSE this suite pins (three gaps, all fixed here):
 *   1. The re-grant vocabulary was `ax|sr|fda|cal` on BOTH sides. Input
 *      Monitoring (`im`) and Automation (`ae`) — the two grants the owner
 *      actually lost — could not be NAMED, so a loss of either produced no
 *      card at all: buildTccReGrantNeeded filtered against a hand-written
 *      four-key literal, so an im-only or ae-only set became `grants: []`.
 *   2. The System Events Automation denial (-1743, errAEEventNotPermitted)
 *      matched no branch of denialFromErrorText, so it opened NO episode; the
 *      only trace was a soft "capture falls back to pointer → main" log.
 *      That is exactly the "agent silently blind, presents as flaky input"
 *      symptom in the report.
 *   3. Nothing REQUESTED the Input Monitoring grant: onboarding fired the
 *      native prompts for Accessibility and Screen Recording only, so a fresh
 *      install (or a post-update binary) never re-asked for it.
 *
 * WHAT PROVES IT: the pure functions below are driven with the live incident
 * shapes; the wiring that cannot execute on Linux is pinned by source bytes.
 * A regression on any of the three gaps fails a test here.
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
  preflightGrants,
  classifyDenial,
  regrantNeededMessage,
  REGRANT_PANE_URLS,
  REGRANT_LABELS,
  REGRANT_KEY_ORDER,
  ADVISORY_REGRANT_KEYS,
} = tcc;

// 30d3c366 review fix: the classifier is a PURE leaf function and now lives in
// dist/tcc-regrant.js. It must NOT be imported from dist/index.js — that module
// ends with main(), which calls process.exit(0) when unpaired, killing the test
// runner before a single test() registers (the vacuous-suite defect the
// independent review caught: "# tests 1 / # pass 1" with 18 tests never run).
const { denialFromErrorText } = tcc;

const computerDist = await import(join(pkgRoot, 'dist', 'computer.js'));
const { isAutomationDenialText } = computerDist;

const permissionsDist = await import(join(pkgRoot, 'dist', 'permissions.js'));
const { PANE_URLS, PANE_LABELS, onboardingMessage } = permissionsDist;

const indexSrc = read('src/index.ts');
const computerSrc = read('src/computer.ts');
const permissionsSrc = read('src/permissions.ts');
const tccSrc = read('src/tcc-regrant.ts');

// ── 1. The vocabulary can NAME the two grants the ticket lost ────────────────

test('30d3c366: the re-grant vocabulary carries Input Monitoring and Automation', () => {
  // Before the fix these keys did not exist in ANY vocabulary — the ticket's
  // own grants were literally unnameable.
  assert.ok(REGRANT_KEY_ORDER.includes('im'), 'Input Monitoring is a re-grant key');
  assert.ok(REGRANT_KEY_ORDER.includes('ae'), 'Automation is a re-grant key');
  assert.equal(REGRANT_LABELS.im, 'Input Monitoring');
  assert.equal(REGRANT_LABELS.ae, 'Automation');
});

test('30d3c366 pin: the new keys are APPENDED — every pre-existing wire form is byte-identical', () => {
  // The backend parser, the dedupe key and several pinned suites depend on the
  // old order. An interleaved insert would silently reorder them.
  assert.deepEqual(REGRANT_KEY_ORDER.slice(0, 4), ['ax', 'sr', 'fda', 'cal']);
  const legacy = buildTccReGrantNeeded(['cal', 'sr', 'ax'], 'cause');
  assert.deepEqual(legacy.grants, ['ax', 'sr', 'cal'], 'a legacy set serialises exactly as before');
});

test('30d3c366: an im-only / ae-only loss builds a REAL event (the four-key literal bug)', () => {
  // THE REGRESSION THIS PINS: buildTccReGrantNeeded filtered through a
  // hand-written ['ax','sr','fda','cal'] literal. With the new keys present in
  // the type but absent from that literal, an Input-Monitoring-only loss fell
  // through the filter and produced `grants: []` — an event naming nothing,
  // which is clinically the same as the ticket's "no card, no prompt".
  const imOnly = buildTccReGrantNeeded(['im'], 'call-time denial');
  assert.ok(imOnly, 'an im-only set must produce an event, not null');
  assert.deepEqual(imOnly.grants, ['im']);
  assert.deepEqual(imOnly.panes, [REGRANT_PANE_URLS.im]);

  const aeOnly = buildTccReGrantNeeded(['ae'], 'self-update tree swap');
  assert.ok(aeOnly, 'an ae-only set must produce an event, not null');
  assert.deepEqual(aeOnly.grants, ['ae']);
  assert.deepEqual(aeOnly.panes, [REGRANT_PANE_URLS.ae]);
});

test('30d3c366: the pane deep-links point at the panes macOS actually titles that way', () => {
  // The ticket's friction is the owner having to FIND the toggles. A wrong
  // pane id opens Settings at the top level and re-creates that friction.
  assert.match(REGRANT_PANE_URLS.im, /Privacy_ListenEvent$/); // macOS names the pane "Input Monitoring"
  assert.match(REGRANT_PANE_URLS.ae, /Privacy_Automation$/);
  assert.equal(PANE_URLS['input-monitoring'], REGRANT_PANE_URLS.im, 'agent + card vocabularies agree');
  assert.equal(PANE_URLS.automation, REGRANT_PANE_URLS.ae);
  assert.equal(PANE_LABELS['input-monitoring'], 'Input Monitoring');
  assert.equal(PANE_LABELS.automation, 'Automation');
});

// ── 2. Post-update detection covers them (the mbp-1 / mbp-2 incident shape) ──

test('30d3c366: the LIVE incident shape — predecessor held ax+im+ae, successor lost input monitoring and automation', () => {
  // mbp-2 2026-10-29: Accessibility AND Input Monitoring were gone; Automation
  // went with the same swap on mbp-1 (2026-10-24).
  const missing = preflightGrants(
    { ax: true, sr: true, fda: true, im: true, ae: true },
    { ax: true, sr: true, fda: true, im: false },
    null,
    false,
  );
  assert.deepEqual(missing, ['im', 'ae'], 'both ticket grants are convicted');
});

test('30d3c366: a loss is detected even when it is the ONLY thing lost', () => {
  // The exact silent case: everything else fine, one ticket grant orphaned.
  assert.deepEqual(
    preflightGrants({ ax: true, sr: true, fda: true, im: true }, { ax: true, sr: true, fda: true, im: false }, null, null),
    ['im'],
  );
  assert.deepEqual(
    preflightGrants({ ax: true, sr: true, fda: true, ae: true }, { ax: true, sr: true, fda: true }, null, false),
    ['ae'],
  );
});

test('30d3c366 pin: an UNKNOWN reading never convicts (no fabricated grant loss)', () => {
  // The c44b19e9 unknown-never-convicts rule, extended to the new keys: a
  // bridge that cannot answer reports undefined/null, which must contribute
  // NOTHING rather than a phantom loss.
  assert.deepEqual(
    preflightGrants({ ax: true, sr: true, fda: true, im: true }, { ax: true, sr: true, fda: true }, null, null),
    [],
    'undefined im is unknown, not false',
  );
  assert.deepEqual(
    preflightGrants({ ax: true, sr: true, fda: true, ae: true }, { ax: true, sr: true, fda: true }, null, null),
    [],
    'null ae status is unknown, not false',
  );
});

test('30d3c366 pin: a never-granted Mac files NOTHING (the 0.9.8 lesson)', () => {
  // A first-ever install has no predecessor baseline: an absent prev object
  // must never be read as "had everything, lost it all".
  assert.deepEqual(
    preflightGrants(null, { ax: false, sr: false, fda: false, im: false }, null, false),
    [],
  );
});

// ── 3. The Automation denial is CLASSIFIED (the silent-blindness gap) ────────

test('30d3c366: the real System Events -1743 text convicts Automation', () => {
  // macOS words it "Not authorized to send Apple events to System Events"
  // and appends (-1743) = errAEEventNotPermitted. This exact text used to
  // classify null → no episode → the silent failure the ticket reports.
  const live = "Error: An error occurred: Not authorized to send Apple events to System Events. (-1743)";
  assert.equal(isAutomationDenialText(live), true);
  assert.deepEqual(denialFromErrorText(live), { kind: 'automation-denied' });
  assert.equal(classifyDenial({ kind: 'automation-denied' }), 'ae');
});

test('30d3c366: the permissionBlock Automation line also convicts', () => {
  assert.deepEqual(
    denialFromErrorText('Missing macOS permission(s): Automation'),
    { kind: 'automation-denied' },
  );
});

test('30d3c366 pin: a bare -1743 is NOT stolen from the Calendars classifier', () => {
  // -1743 is ALSO the legacy EventKit denial. calendar.ts owns that text; this
  // classifier must not re-attribute it (one vocabulary per fact, c44b19e9).
  assert.equal(isAutomationDenialText('Error: An error occurred. (-1743)'), false);
  assert.equal(denialFromErrorText('Error: calendar read failed (-1743)'), null);
  // And the ordinary probe miss stays a plain miss.
  assert.equal(isAutomationDenialText('frontmost window unavailable (osascript timed out)'), false);
  assert.equal(denialFromErrorText('frontmost window unavailable'), null);
});

test('30d3c366 pin: the front_window probe stamps the denial instead of only logging a fallback', () => {
  assert.match(computerSrc, /if \(isAutomationDenialText\(msg\)\) \{[\s\S]{0,120}noteAutomationDenied\(\)/,
    'the real call site stamps the latch on a classified denial');
  assert.match(computerSrc, /export function noteAutomationDenied/);
  assert.match(computerSrc, /export function lastAutomationDenial/);
  assert.match(computerSrc, /export function clearAutomationDenial/);
  // The run loop must DRAIN it into the watchdog, or the stamp is inert.
  assert.match(indexSrc, /lastAutomationDenial\(\)\) \{\s*noteTccDenial\(\{ kind: 'automation-denied' \}\);\s*clearAutomationDenial\(\);/,
    'the run loop drains the latch into the TCC episode');
});

// ── 4. Input Monitoring is REQUESTED (the owner's verbatim ask) ──────────────

test('30d3c366: onboarding fires the NATIVE Input Monitoring prompt', () => {
  // "why doesn't it request that for you automatically on new digby install"
  assert.match(computerSrc, /export async function requestInputMonitoringPrompt/);
  assert.match(computerSrc, /if \(action === 'request_im'\)[\s\S]{0,400}CGRequestListenEventAccess\(\)/,
    'the requesting API is CGRequestListenEventAccess');
  assert.match(indexSrc, /requestInputMonitoringPrompt\(\)/, 'onboarding calls it');
  assert.match(permissionsSrc, /if \(missing\.includes\('input-monitoring'\)\)/, 'the checklist names the pane');
});

test('30d3c366 pin: the STATUS probe is NON-REQUESTING (the 0.9.8 / 30787bc4 rule)', () => {
  // The status preflight feeds the every-poll advert. It must be the
  // authorization-status query ONLY — the requesting API here would re-raise
  // a consent sheet on every poll, the exact modal-storm regression 30787bc4
  // fixed for Screen Recording.
  assert.match(computerSrc, /if \(action === 'preflight_im'\)[\s\S]{0,400}CGPreflightListenEventAccess\(\)/,
    'the status query is the preflight (non-requesting) API');
  // The requesting call must NOT appear in the preflight_im block: slice from
  // the preflight action up to the request action and assert it is absent.
  // Slice precisely: from the preflight action to the NEXT `if (action === …)`
  // after it. Using indexOf("if (action === 'request_im')") was a FALSE PASS —
  // that literal also appears in the comment above the preflight block, so the
  // slice ran past the block it was asserting on (independent-review finding).
  const imStart = computerSrc.indexOf("if (action === 'preflight_im')");
  assert.ok(imStart > -1, 'the preflight_im block exists');
  const nextAction = computerSrc.indexOf('if (action === ', imStart + 10);
  const preflightBlock = computerSrc.slice(imStart, nextAction > -1 ? nextAction : computerSrc.length);
  assert.ok(preflightBlock.length > 0, 'the preflight block is non-empty');
  assert.match(preflightBlock, /preflight/i, 'the slice really is the preflight block, not the requester');
  // COMMENT LINES ARE NOT EXECUTED CODE. The block's own prose names the
  // requesting API (that is the explanation of WHY the preflight exists), and
  // so does the doc comment above the requesting action that trails the slice.
  // Assert over EXECUTABLE lines only, or this pin measures prose.
  const preflightCode = preflightBlock
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.doesNotMatch(preflightCode, /CGRequestListenEventAccess/,
    'the polling status probe must never call the requesting API');
  assert.doesNotMatch(permissionsSrc, /CGRequestListenEventAccess/,
    'permissions.ts (the advert assembly) never requests');
});

test('30d3c366 pin: an unreachable bridge advertises NO im key (absent-never-clobbers)', () => {
  assert.match(permissionsSrc, /if \(probeCache\.im !== null\) status\.inputMonitoring = probeCache\.im;/,
    'undefined keeps the key off the poll so the backend retains its stored value');
  assert.match(read('src/api.ts'), /if \(p\.inputMonitoring !== undefined\) q \+= `&im=/,
    'the wire param is emitted only for a known reading');
});

// ── 5. The card TELLS the owner exactly what to switch on ────────────────────

test('30d3c366: the message names the exact pane + target for both grants', () => {
  const msg = regrantNeededMessage(buildTccReGrantNeeded(['im', 'ae'], null), 'DigbyAgent');
  assert.match(msg, /Input Monitoring/, 'names the Input Monitoring pane');
  assert.match(msg, /Automation/, 'names the Automation pane');
  assert.match(msg, /System Events/, 'names the target row the owner must expand');
  assert.match(msg, /RELAUNCH/i, 'carries the quit-and-relaunch rule');
});

test('30d3c366: Input Monitoring is ADVISORY — it can never claim remote control is broken', () => {
  // This agent POSTS events (an Accessibility power) and taps none, so a
  // missing `im` must not present as "your remote control is broken".
  assert.ok(ADVISORY_REGRANT_KEYS.includes('im'));
  const msg = regrantNeededMessage(buildTccReGrantNeeded(['im'], null), 'DigbyAgent');
  assert.doesNotMatch(msg, /remote control/i, 'no false alarm on the advisory grant');
});

// ── 6. Backend vocabulary accepts what the agent now sends ───────────────────

test('30d3c366: the backend parses the new tokens instead of dropping the whole param', () => {
  // parseRegrantParam returns NULL for any unknown token — so a backend
  // without `im`/`ae` would discard the ENTIRE episode, not just those keys.
  const backendSrc = readFileSync(join(pkgRoot, '..', 'backend', 'src', 'modules',
    'crossmodel', 'imessage', 'agent-tcc-regrant.ts'), 'utf8');
  assert.match(backendSrc, /export const REGRANT_KEYS = \['ax', 'sr', 'fda', 'cal', 'im', 'ae'\]/,
    'backend key vocabulary matches the agent');
  assert.match(backendSrc, /im: 'input-monitoring'/);
  assert.match(backendSrc, /ae: 'automation'/);
  const controllerSrc = readFileSync(join(pkgRoot, '..', 'backend', 'src', 'modules',
    'crossmodel', 'imessage', 'imessage.controller.ts'), 'utf8');
  assert.match(controllerSrc, /'input-monitoring', 'automation'/, 'the pane dispatch gate accepts both');
});