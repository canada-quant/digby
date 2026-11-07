/**
 * Permission onboarding + self-diagnostics tests (feedback ticket 2f646c10 —
 * 2026-09-25, agent v0.6.0).
 *
 * The mishap: an owner spent ~24h with a dead computer-use input path —
 * Accessibility was granted to a STALE helper binary after an app update while
 * System Settings showed the switch ON, and the agent had no way to report
 * its own broken state. The fix: the agent advertises {ax, sr, fda, relaunch}
 * on every poll, latches provably-dead input, detects bundle replacement, and
 * exposes permission_relaunch / permission_open_pane / permission_reveal.
 *
 * Two layers, mirroring the house idiom (browser-cdp-attach.4258335e):
 *   1. REAL unit tests of the pure pieces in dist/permissions.js (npm test
 *      builds first — these exercise the code that actually ships).
 *   2. SOURCE-BYTES pins on the wiring that cannot run on Linux: the FDA
 *      un-gate in index.ts (no more 90s exit — the poll loop always runs),
 *      the run-loop advert + bundle-swap self-heal, the three permission
 *      commands, and the dead-input latch feed from computer.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fork } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');
const indexSrc = SRC('src/index.ts');
const computerSrc = SRC('src/computer.ts');
const apiSrc = SRC('src/api.ts');
const configSrc = SRC('src/config.ts');
const pkg = JSON.parse(SRC('package.json'));

const {
  noteMoveResult,
  latchedDeadInput,
  bundleReplaced,
  binaryIdentityChanged,
  needsRelaunch,
  buildPermissionsQuery,
  RELATCH_AFTER,
  PANE_URLS,
} = await import(join(pkgRoot, 'dist', 'permissions.js'));

// ── 1. The dead-input latch ──────────────────────────────────────────────────

test('2f646c10: latch trips only after 3 consecutive verified mis-lands (RELATCH_AFTER = 3)', () => {
  assert.equal(RELATCH_AFTER, 3);
});

test('2f646c10: latch state machine — trips at 3, sticky, null is a no-op', async () => {
  // The latch is module-global and sticky; a fresh child process per scenario
  // keeps each assertion independent of the others.
  const scenario = (name) =>
    new Promise((resolve) => {
      const child = fork(join(here, 'permissions-latch-fixture.cjs'), [], { cwd: here });
      child.on('message', resolve);
      child.on('error', () => resolve({ crashed: true }));
      child.send(name);
    });

  // 2 mis-lands then a success → never tripped (the true RESETS the streak).
  let r = await scenario('two-then-ok');
  assert.equal(r.tripped, false, '2 falses + 1 true must not trip (reset)');
  // 3 consecutive mis-lands → tripped…
  r = await scenario('three-dead');
  assert.equal(r.tripped, true, '3 consecutive falses must trip the latch');
  // …and stays tripped even after a later verified landing (process-lifetime).
  r = await scenario('three-dead-then-ok');
  assert.equal(r.tripped, true, 'the latch is sticky for the process lifetime');
  // A null (unverifiable read-back) never counts in either direction.
  r = await scenario('nulls-only');
  assert.equal(r.tripped, false, 'nulls are no-ops and never trip the latch');
  // null does NOT break the streak either — it is not evidence of HEALTHY
  // input, so the counter counts false-since-last-true with nulls transparent.
  r = await scenario('two-null-one');
  assert.equal(r.tripped, true, 'null is a pure no-op: 3 falses since the last true still trip');
});

// Direct state-machine pins in THIS process too (the fixture covers
// process-lifetime semantics; these pin the counter transitions precisely).
test('2f646c10: null (unverifiable) is a no-op and never trips even in bulk', () => {
  for (let i = 0; i < 10; i++) noteMoveResult(null);
  assert.equal(latchedDeadInput(), false);
});

// ── 2. Bundle-replacement ghost check ────────────────────────────────────────

test('2f646c10: binaryIdentityChanged — same dev/ino → false (no swap)', () => {
  assert.equal(binaryIdentityChanged({ dev: 16777234, ino: 9987766 }, { dev: 16777234, ino: 9987766 }), false);
});

test('2f646c10: binaryIdentityChanged — different ino (bundle swapped) → true', () => {
  assert.equal(binaryIdentityChanged({ dev: 16777234, ino: 9987766 }, { dev: 16777234, ino: 424242 }), true);
});

test('2f646c10: binaryIdentityChanged — different dev (volume replaced) → true', () => {
  assert.equal(binaryIdentityChanged({ dev: 16777234, ino: 9987766 }, { dev: 16777299, ino: 9987766 }), true);
});

test('2f646c10: binaryIdentityChanged — binary GONE (stat throws) → true (ghost for sure)', () => {
  assert.equal(binaryIdentityChanged({ dev: 1, ino: 2 }, null), true);
});

test('2f646c10: binaryIdentityChanged — no baseline captured at init → false (cannot tell)', () => {
  assert.equal(binaryIdentityChanged(null, { dev: 1, ino: 2 }), false);
});

test('2f646c10: bundleReplaced() on a live binary that has NOT been swapped → false', () => {
  // This test process's own node binary was not replaced under it.
  assert.equal(bundleReplaced(), false);
});

// ── 3. Relaunch assembly ─────────────────────────────────────────────────────

test('2f646c10: needsRelaunch — bundle swapped → relaunch (regardless of ax)', () => {
  assert.equal(needsRelaunch({ bundleReplaced: true, latchedDeadInput: false, ax: false }), true);
  assert.equal(needsRelaunch({ bundleReplaced: true, latchedDeadInput: false, ax: true }), true);
});

test('2f646c10: needsRelaunch — latched dead input AND Accessibility LOOKS granted → relaunch (the stale-grant shape)', () => {
  assert.equal(needsRelaunch({ bundleReplaced: false, latchedDeadInput: true, ax: true }), true);
});

test('2f646c10: needsRelaunch — latched but ax is FALSE → no relaunch (the grant is visibly missing, re-grant is the fix)', () => {
  assert.equal(needsRelaunch({ bundleReplaced: false, latchedDeadInput: true, ax: false }), false);
});

test('2f646c10: needsRelaunch — healthy helper → false', () => {
  assert.equal(needsRelaunch({ bundleReplaced: false, latchedDeadInput: false, ax: true }), false);
});

// ── 4. Query building (the poll wire format) ─────────────────────────────────

test('2f646c10: buildPermissionsQuery renders the four flags as 1/0 params', () => {
  assert.equal(buildPermissionsQuery({ ax: true, sr: false, fda: true, relaunch: false }), 'ax=1&sr=0&fda=1&relaunch=0');
  assert.equal(buildPermissionsQuery({ ax: false, sr: true, fda: false, relaunch: true }), 'ax=0&sr=1&fda=0&relaunch=1');
});

test('2f646c10: PANE_URLS centralizes the three Privacy & Security deep links', () => {
  assert.equal(PANE_URLS.accessibility, 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  assert.equal(PANE_URLS['screen-recording'], 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  assert.equal(PANE_URLS['full-disk-access'], 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
});

// ── 5. Version lockstep ──────────────────────────────────────────────────────

test('2f646c10: agent version is 0.6.0 (the backend routes permission actions to ≥ 0.6.0)', () => {
  assert.match(configSrc, /AGENT_VERSION = '0\.9\.24'/, 'config.ts AGENT_VERSION must be 0.9.24');
  assert.equal(pkg.version, '0.9.24', 'package.json version must match AGENT_VERSION');
});

// ── 6. Source-bytes pins on the macOS-only wiring ─────────────���──────────────

const stripLineComments = (s) => s.replace(/(^|\s)\/\/[^\n]*/g, '$1');

test('2f646c10 pin: the FDA startup flow NO LONGER exits — the poll loop always runs', () => {
  const runLoop = indexSrc.split('async function runLoop(')[1];
  assert.ok(runLoop, 'runLoop must exist');
  // The pre-0.6.0 gate: dialog + exit(1) after 90s while FDA was missing.
  const code = stripLineComments(runLoop.split('async function pair(')[0]);
  assert.ok(!code.includes('setTimeout(() => process.exit(1), 90000)'), 'the 90s FDA exit must be GONE');
  // The guidance (dialog + settings pane + reveal) is KEPT.
  assert.match(code, /openFullDiskAccessGuidance\(\)/, 'the FDA guidance is still shown');
  assert.match(code, /Full Disk Access missing/, 'the FDA-missing log line is present');
});

test('2f646c10 pin: the run loop computes the permission status and rides it on every poll', () => {
  const code = stripLineComments(indexSrc.split('while (true)')[1].split('async function pair(')[0]);
  assert.match(code, /await computePermissionStatus\(\)/, 'the loop must compute the permission status');
  // c44b19e9 made the call multi-line (the regrant key rides it); the advert
  // arg is still the second parameter.
  assert.match(code, /await pollCommand\(\s*config,\s*permissions,/, 'the poll must carry the permissions advert');
});

test('2f646c10 pin: after the poll resolves, a bundle swap exits so launchd restarts from the new binary', () => {
  const code = indexSrc.split('while (true)')[1].split('async function pair(')[0];
  // The bundle check must sit AFTER pollCommand resolves (the advert that rode
  // that same request is already persisted server-side) and BEFORE the
  // `!command` continue — a no-command poll still triggers the self-heal exit.
  const pollIdx = code.indexOf('await pollCommand(');
  const bundleIdx = code.indexOf('if (bundleReplaced())');
  // 4e75cdea: the no-command branch is a block now (it hosts the self-update
  // gate) — both spellings keep the invariant: it comes AFTER bundleReplaced,
  // so a no-command poll still triggers the self-heal exit.
  const continueIdx = code.indexOf('if (!command) {') >= 0 ? code.indexOf('if (!command) {') : code.indexOf('if (!command) continue');
  assert.ok(pollIdx > 0, 'pollCommand call found');
  assert.ok(bundleIdx > pollIdx, 'bundleReplaced must be checked after the poll resolves');
  assert.ok(continueIdx > bundleIdx, 'the bundle-swap exit must fire even on a no-command poll');
  assert.match(code, /♻️/, 'the bundle-swap exit logs what is happening');
});

test('2f646c10 pin: the three permission commands exist in the dispatch table', () => {
  for (const cmd of ['permission_relaunch', 'permission_open_pane', 'permission_reveal']) {
    assert.ok(indexSrc.includes(`case '${cmd}'`), `dispatch must handle ${cmd}`);
  }
  // Relaunch posts its result BEFORE the exit (500ms delay).
  assert.match(indexSrc, /setTimeout\(\(\) => process\.exit\(1\), 500\)/, 'permission_relaunch delays its exit');
  assert.match(indexSrc, /return \{ relaunching: true \}/, 'permission_relaunch posts a result');
  // Reveal targets the helper binary itself.
  assert.match(indexSrc, /execFile\('open', \['-R', process\.execPath\]/, 'permission_reveal reveals process.execPath');
});

test('2f646c10 pin: permission_open_pane validates the pane against PANE_URLS (no arbitrary URL opens)', () => {
  const code = indexSrc.split("case 'permission_open_pane'")[1].split("case 'permission_reveal'")[0];
  assert.match(code, /if \(!PANE_URLS\[pane\]\) throw/, 'an unknown pane must be rejected');
});

test('2f646c10 pin: pair requests carry the permission state (both pairing paths)', () => {
  // pairWithPermissions computes the status and pairComplete takes it.
  assert.match(indexSrc, /await computePermissionStatus\(\)/, 'the pair helper computes the status');
  assert.match(indexSrc, /await pairWithPermissions\(/, 'both pairing paths route through the helper');
  assert.match(apiSrc, /permissions\?: PermissionStatus \| null/, 'pairComplete accepts the permissions param');
  // 1ea9a120: the pair body now serializes through pairPermissions (wire keys
  // `ax|sr|fda|relaunch|cal`) — the raw PermissionStatus never rides the body.
  assert.match(apiSrc, /permissions: pairPermissions\(permissions\)/, 'the pair body carries permissions when computable');
});

test('2f646c10 pin: api.ts appends the four flags to the poll query', () => {
  const code = stripLineComments(apiSrc);
  assert.match(code, /ax=\$\{p\.ax \? 1 : 0\}/, 'ax param');
  assert.match(code, /sr=\$\{p\.sr \? 1 : 0\}/, 'sr param');
  assert.match(code, /fda=\$\{p\.fda \? 1 : 0\}/, 'fda param');
  assert.match(code, /relaunch=\$\{p\.relaunch \? 1 : 0\}/, 'relaunch param');
  // A null status omits them (legacy behavior — the backend keeps its value).
  assert.match(code, /if \(!p\) return ''/, 'a null status advertises nothing');
});

test('2f646c10 pin: computer.ts feeds ONLY provable mis-lands into the dead-input latch', () => {
  // Review round 1 (sub-session 75c94a8b, BLOCKED): the first wiring counted
  // every successful targeted scroll as a mis-land (targeted means "x was
  // provided", not "mis-landed") and fed successful-but-unverifiable clicks
  // into the latch as mis-lands. The latch must trip ONLY on structured,
  // provable mis-land evidence.
  // 1. A VERIFIED mis-land (JXA refuses and flags misland:true) is the only
  //    path that feeds the latch a false — and it does so on BOTH click and
  //    scroll, BEFORE the generic error return.
  assert.match(computerSrc, /if \(r\.misland === true\) \{\s*\n\s*\/\/ v0\.6\.0[\s\S]*?noteMoveResult\(false\);/,
    'a structured mis-land (click or scroll) must count as a dead move');
  // 2. A SUCCESSFUL click only feeds a CONFIRMED landing; anything else is
  //    unverifiable (null) — never a mis-land.
  assert.match(computerSrc, /noteMoveResult\(r\.cursorVerified === true \? true : null\)/,
    'success feeds the latch only a confirmed (or null) landing');
  // 3. The JXA side sets misland:true on BOTH refusals (click + scroll)…
  const jxa = computerSrc.split('const JXA_RUNNER = `')[1].split('`;')[0];
  assert.match(jxa, /misland: true, error: 'cursor did not reach click target/, 'click refusal carries misland:true');
  assert.match(jxa, /misland: true, error: 'cursor did not reach scroll target/, 'scroll refusal carries misland:true');
  // …never counts a mere error as latch input, and reports a real
  // cursorVerified (true|false|null) on successful scroll targets.
  assert.ok(!jxa.includes('noteMoveResult'), 'the latch lives on the node side only');
  // 4. Errors WITHOUT the misland flag (guard/geometry/permission) return
  //    before any latch input — pin the ordering: misland check precedes the
  //    generic error return in both handlers.
  for (const fn of ['click', 'scroll']) {
    const body = computerSrc.split(`export async function ${fn}(`)[1].split('\n}')[0];
    assert.ok(body.indexOf('r.misland === true') < body.indexOf('if (r.error) return'),
      `${fn}: the misland check must precede the generic error return`);
  }
});

test('2f646c10 pin: permissions.ts reuses computer.ts preflight + chatdb checkAccess (no duplicated probes)', () => {
  const permSrc = SRC('src/permissions.ts');
  assert.match(permSrc, /import \{ preflightPermissions(?:, [a-zA-Z, ]+)? \} from '\.\/computer'/, 'the ax/sr probe is computer.ts preflight (0.6.3 adds the Screen Recording ground-truth seams to the same import)');
  assert.match(permSrc, /import \{ checkAccess \} from '\.\/chatdb'/, 'the fda probe is chatdb checkAccess');
  assert.match(computerSrc, /export async function preflightPermissions\(\)/, 'computer.ts exports the preflight seam');
});

test('2f646c10 pin: computePermissionStatus TTL-caches the probes (polls are sub-second)', () => {
  const permSrc = SRC('src/permissions.ts');
  assert.match(permSrc, /STATUS_TTL_MS = 15_000/, 'the probe cache TTL is ~15s');
  // The latch + bundle checks must stay OUTSIDE that cache (always fresh).
  assert.match(permSrc, /relaunch: needsRelaunch\(\{ bundleReplaced: bundleReplaced\(\), latchedDeadInput: deadInputLatched, ax \}\)/,
    'relaunch is assembled from always-fresh latch/bundle state');
});
