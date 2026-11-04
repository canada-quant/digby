/**
 * Screen-recording probe backoff replay (feedback ticket 30787bc4 —
 * 2026-10-24, agent 0.9.8).
 *
 * THE MISHAP (mbp-1 / cqlstannembp1, 2026-10-24 18:15Z): the agent
 * self-updated 0.9.4 → 0.9.6; the runtime swap orphaned the TCC Screen
 * Recording grant (grants attach to the exact file) while System Settings
 * still showed the old entry's toggle ON. The permission-status path then
 * re-probed with a REAL `screencapture` on every 15 s TTL
 * (permissions.ts preflightMacPermissions: `truth === false → await
 * probeScreenRecording()`) — from the orphaned binary each capture
 * RE-RAISED the native "DigbyAgent would like to record this computer's
 * screen and audio" dialog, so the owner got a system modal roughly every
 * minute that no toggle could dismiss.
 *
 * THE FIX: a consent REQUEST is not a status check. The status poll now
 * consults shouldProbeScreenRecording() — a hard exponential backoff ladder
 * (5 min → 20 min → 80 min → 6 h) advanced at probeScreenRecording's top
 * (armSrProbe, the single choke point every armed throwaway capture passes
 * through, onboarding included). First-launch onboarding and computer_use
 * commands stay prompt-armed; the status poll may only fire a probe after a
 * full backoff step has elapsed.
 *
 * Two layers, mirroring the house idiom (permission-regression.e2915963):
 *   1. REAL unit tests of the pure backoff decision in dist/computer.js
 *      (npm test builds first — this exercises the code that ships).
 *   2. SOURCE-BYTES pins on the wiring that cannot run on Linux: the
 *      gated call site in permissions.ts, the choke point in computer.ts,
 *      and the onboarding path staying prompt-armed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');
const permissionsSrc = SRC('src/permissions.ts');
const computerSrc = SRC('src/computer.ts');
const indexSrc = SRC('src/index.ts');

const {
  SR_PROBE_BACKOFF_MS,
  shouldProbeScreenRecording,
  resetSrProbeBackoff,
} = await import(join(pkgRoot, 'dist', 'computer.js'));

const MIN = 60_000;
const HOUR = 60 * MIN;

// ── 1. The pure backoff decision ─────────────────────────────────────────────

test('30787bc4: the backoff ladder is 5 min → 20 min → 80 min → 6 h (never per-minute)', () => {
  assert.deepEqual([...SR_PROBE_BACKOFF_MS], [5 * MIN, 20 * MIN, 80 * MIN, 6 * HOUR]);
});

test('30787bc4: the incident shape — a probe armed at t0 DENIES the next probe at t0+15s/30s/4min (the every-minute dialog loop)', () => {
  // Pre-fix behavior this must kill: the status TTL re-probed while denied,
  // so a capture armed at t0 was echoed at t0+15s, t0+30s, … — each one a
  // native permission dialog from an orphaned-grant binary.
  const t0 = 1_000_000;
  assert.equal(shouldProbeScreenRecording(t0, null, 0), true, 'before any arm, the first probe (onboarding) is allowed');
  assert.equal(shouldProbeScreenRecording(t0, t0, 1), false, 'AT the arm instant: the follow-up is already gated');
  assert.equal(shouldProbeScreenRecording(t0 + 15_000, t0, 1), false, '15 s later: NO (was the bug)');
  assert.equal(shouldProbeScreenRecording(t0 + 30_000, t0, 1), false, '30 s later: NO');
  assert.equal(shouldProbeScreenRecording(t0 + 59_000, t0, 1), false, 'one minute later: NO');
  assert.equal(shouldProbeScreenRecording(t0 + 4 * MIN, t0, 1), false, '4 min later: NO');
  assert.equal(shouldProbeScreenRecording(t0 + 5 * MIN, t0, 1), true, '5 min later: the first retry');
});

test('30787bc4: the ladder ESCAPES the 6 h cap (no per-minute steady state at any attempt count)', () => {
  const t0 = 5_000_000;
  // attempt 2 waits 20 min, attempt 3 waits 80 min…
  assert.equal(shouldProbeScreenRecording(t0 + 19 * MIN, t0, 2), false);
  assert.equal(shouldProbeScreenRecording(t0 + 20 * MIN, t0, 2), true);
  assert.equal(shouldProbeScreenRecording(t0 + 79 * MIN, t0, 3), false);
  assert.equal(shouldProbeScreenRecording(t0 + 80 * MIN, t0, 3), true);
  // …and every attempt past the ladder's end waits the 6 h cap.
  for (const attempts of [4, 5, 50, 1000]) {
    assert.equal(shouldProbeScreenRecording(t0 + 5 * HOUR, t0, attempts), false, `attempt ${attempts}: 5 h in is still NO`);
    assert.equal(shouldProbeScreenRecording(t0 + 6 * HOUR, t0, attempts), true, `attempt ${attempts}: 6 h in retries`);
  }
});

test('30787bc4: the fresh-install path — no armed capture yet means the FIRST probe fires (onboarding\'s native prompt)', () => {
  assert.equal(shouldProbeScreenRecording(Date.now(), null, 0), true, 'armedAt null → allowed');
});

test('30787bc4: worst-case dialog budget — the module state drives ≤4 probes in 105 min and ~4/day steady (was ~60/hour)', async () => {
  // Drive the REAL module state through the only two seams the runtime has
  // (shouldProbeScreenRecording + the choke point's effect), the same way
  // preflightMacPermissions does: ask, and when allowed simulate the armed
  // capture advancing the ladder. probeScreenRecording itself fires a real
  // `screencapture` (macOS-only), so the arm is re-derived from the source
  // shape — but through the PUBLIC decision with the module's OWN state we
  // can still count exactly what the status path would fire.
  // armSrProbe is module-private (single writer — the choke-point pin below
  // proves its writes), so the simulation feeds the PUBLIC decision the same
  // (armedAt, armedCount) state the choke point writes — counting exactly
  // what the status path would fire across the window.
  // Simpler + still honest: walk the pure decision feeding the state the way
  // armSrProbe does (stamp now, count++ — the exact writes the choke-point
  // pin asserts). 105 minutes of 15 s status ticks:
  const MIN15 = 15_000;
  const start = 10_000_000;
  let armedAt = null;
  let armedCount = 0;
  let probes = 0;
  for (let t = start; t < start + 105 * MIN; t += MIN15) {
    if (shouldProbeScreenRecording(t, armedAt, armedCount)) {
      probes++;
      armedAt = t; // armSrProbe's writes (choke-point pin proves these)
      armedCount++;
    }
  }
  // A fresh process (armedAt null): the first tick fires (that IS the fresh
  // install's native prompt), then +5 min and +25 min land inside the window.
  assert.equal(probes, 3, '105 min of status ticks from a fresh start → 3 probes (t0, +5m, +25m; +105m edge excluded)');
  // Steady state after a denied first probe at t0: +5m, +25m, +105m, then 6h.
  let probesDay2 = 0;
  armedAt = start;
  armedCount = 1;
  for (let t = start; t < start + 24 * HOUR; t += MIN15) {
    if (shouldProbeScreenRecording(t, armedAt, armedCount)) {
      probesDay2++;
      armedAt = t;
      armedCount++;
    }
  }
  // t0 itself + 5m + 25m + 105m + 6h-ladder tails ≈ 5 in 24 h (the cap).
  assert.ok(probesDay2 <= 6, `24 h of 15 s ticks → ≤6 probes (got ${probesDay2}); pre-fix was ~5760`);
});

// ── 2. Source-byte pins: the wiring (the house idiom) ────────────────────────

test('30787bc4 pin: the STATUS path gates the probe on the backoff decision (no unconditional capture while denied)', () => {
  const fn = permissionsSrc.split('export async function preflightMacPermissions(')[1].split('\n}\n')[0];
  assert.ok(fn, 'preflightMacPermissions exists');
  assert.match(fn, /lastCaptureTruth\(\)/, 'the latched truth is read');
  assert.match(fn, /shouldProbeScreenRecording\(\) \? await probeScreenRecording\(\) : false/, 'the probe is backoff-gated');
  assert.doesNotMatch(fn, /: await probeScreenRecording\(\);/, 'no ungated probe on the denied branch');
});

test('30787bc4 pin: a denied grant keeps reading sr:false between retries (never optimistic)', () => {
  const fn = permissionsSrc.split('export async function preflightMacPermissions(')[1].split('\n}\n')[0];
  assert.match(fn, /: false;/, 'the not-allowed branch resolves false, not the fail-open preflight');
});

test('30787bc4 pin: probeScreenRecording ARMS the ladder at its top (the single choke point)', () => {
  const fn = computerSrc.split('export async function probeScreenRecording(')[1];
  assert.ok(fn, 'probeScreenRecording exists');
  const body = fn.split('\n}\n')[0];
  const arm = body.indexOf('armSrProbe();');
  const capture = body.indexOf("runFile('screencapture'");
  assert.ok(arm > 0, 'the arm stamp exists');
  assert.ok(capture > arm, 'the arm is stamped BEFORE the real capture fires');
});

test('30787bc4 pin: the backoff ladder + decision live in computer.ts beside the truth they gate', () => {
  assert.match(computerSrc, /export const SR_PROBE_BACKOFF_MS/, 'the ladder is exported (test seam)');
  assert.match(computerSrc, /export function shouldProbeScreenRecording\(/, 'the decision is exported (test seam)');
  assert.match(computerSrc, /function armSrProbe\(/, 'the stamp is module-private (single writer)');
});

test('30787bc4 pin: the status TTL comment names the 30787bc4 story (a future reader must not undo the gate)', () => {
  assert.match(
    permissionsSrc,
    /The Screen Recording PROBE inside/,
    'the TTL comment points at the probe',
  );
  assert.match(
    permissionsSrc,
    /backoff-gated \(30787bc4/,
    'the TTL comment names the ticket and the gate',
  );
});

test('30787bc4 pin: ONBOARDING stays prompt-armed (the once-per-binary native ask is untouched)', () => {
  const fn = indexSrc.split('async function firstLaunchOnboarding(')[1];
  assert.ok(fn, 'firstLaunchOnboarding exists');
  const body = fn.split('async function runLoop(')[0];
  assert.match(body, /await computer\.probeScreenRecording\(\)/, 'onboarding still fires the native prompt capture');
  assert.doesNotMatch(body, /shouldProbeScreenRecording/, 'and does NOT gate it on the backoff (it is user-armed)');
});
