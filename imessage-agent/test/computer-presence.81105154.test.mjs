/**
 * Ticket 81105154 (2026-10-24, lane d41a6069) — the owner-presence detector
 * SELF-TRIPS on the run's own synthetic input.
 *
 * THE INCIDENT (05:25Z, Mac cqlstannembp1): the owner was away 46 min. The
 * helper's ONLY input was its own synthetic click (done 05:25:11.184Z); the
 * harness then rendered "OBSERVE-ONLY (owner active: human input 2 s ago)".
 * Root cause: the raw HID idle is measured inside the `displays` JXA at
 * T_read, but humanIdleSeconds() was called with Date.now() AFTER the whole
 * screenshot pipeline (front-window probe + screencapture + sips ≈ 2–8 s
 * later). eventAt = classifyClock − rawIdle is shifted FORWARD past the
 * own-input interval end (+ 1.5 s slack), so the agent's own click
 * classifies as "human input N s ago" and the backend ownerPresence gate
 * (computer-loop.ts:1207/1477) latches the run camera-only, one-way.
 *
 * THE FIX: classify with the READING's clock, not the pipeline-end clock —
 * the screenshot path stamps the moment the topology (HID reading) came
 * back, and humanIdleSeconds receives that stamp as its `now`. This suite
 * replays the exact incident timeline against that stamping contract:
 *
 *   05:25:11.184Z  own synthetic click posted (interval [t0, done])
 *   05:25:13.1Z    displays JXA returns; raw HID idle = 2.0 s
 *                  (idle reading taken 2 s after the click — OURS)
 *   05:25:18.895Z  screenshot pipeline ends; OLD code classified HERE
 *
 * Old code: eventAt = 18.9 − 2.0 = 16.9 s → OUTSIDE the interval
 * [11.184−1.5, 11.184+1.5] → "human input 2 s ago" → camera-only. FALSE.
 * Fixed code: eventAt = 13.1 − 2.0 = 11.1 s → INSIDE → ours → no presence
 * from our own click. The owner (idle 46 min) reads as AWAY. Correct.
 *
 * Also pins the backend ownerPresence true-positive (a REAL human keypress
 * 4 s before the reading must still trip the gate — detector recall is
 * preserved) and the fail-closed direction: when the reading clock is
 * unknown (legacy path), classify with Date.now() — never silently wider.
 *
 * Run: `npm test` in imessage-agent/ (builds dist/ first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const { classifyHidReading, humanIdleSeconds } = await import(join(pkgRoot, 'dist', 'computer.js'));

// ── the incident timeline, to the millisecond ────────────────────────────────

const T0 = Date.parse('2026-10-24T05:25:11.184Z'); // click JXA starts
const T_DONE = Date.parse('2026-10-24T05:25:11.184Z'); // "✓ computer_click done" (markOwnInput end)
const T_READ = Date.parse('2026-10-24T05:25:13.100Z'); // displays JXA returned (rawIdle = 2.0 s)
const T_CLASSIFY = Date.parse('2026-10-24T05:25:18.895Z'); // pipeline end — where OLD code classified
const PIPELINE_MS = T_CLASSIFY - T_READ; // 5.795 s

const ownClick = [{ start: T0, end: T_DONE }];

// ── (a) the incident replay: the fix ─────────────────────────────────────────

test('81105154 incident replay: reading-clock classification — our own click is OURS', () => {
  const rawIdle = 2.0; // OS says "input 2 s ago" — measured at T_READ
  // FIXED path: classify at the READING's clock (T_READ), not pipeline end.
  const r = humanIdleSeconds(rawIdle, T_READ, ownClick, null);
  // The event the reading points at (T_READ − 2.0 s = 11.1 s) sits inside our
  // click interval (± 1.5 s slack) → it was OURS → idle is null (no human
  // event seen yet in this process) — NOT "human input 2 s ago".
  assert.equal(r.idle, null);
  assert.equal(r.lastHuman, null);
});

test('81105154 incident replay: OLD pipeline-end classification reproduces the false trip', () => {
  const rawIdle = 2.0;
  // OLD code classified with Date.now() at pipeline end (T_CLASSIFY):
  // eventAt = 18.895 − 2.0 = 16.895 s — past interval end + slack (12.68 s)
  // → escapes the own-ledger → "human input 2 s ago" → camera-only latch.
  const old = humanIdleSeconds(rawIdle, T_CLASSIFY, ownClick, null);
  assert.equal(old.idle, 2.0); // the false "human" reading the incident rendered
});

// ── (b) classifyHidReading: the two-clock contract ───────────────────────────

test('classifyHidReading uses the reading clock: ours classifies as ours', () => {
  // classifyHidReading(rawIdleSec, readAtMs, nowMs, own, lastHuman) —
  // attribution at readAtMs; the reported idle at nowMs (two clocks, see
  // the reviewer round: measuring the idle at the reading clock understates
  // it by the pipeline latency and re-introduces false presence at the
  // ownerPresence 120 s window edge).
  const r = classifyHidReading(2.0, T_READ, T_CLASSIFY, ownClick, null);
  assert.equal(r.idle, null);
  assert.equal(r.lastHuman, null);
});

test('classifyHidReading: a REAL human keypress 4 s before the reading still trips', () => {
  // The human typed at T_READ − 4 s (well outside our intervals) — detector
  // recall must hold: owner PRESENT.
  const r = classifyHidReading(4.0, T_READ, T_CLASSIFY, ownClick, null);
  assert.equal(r.lastHuman, T_READ - 4000);
});

test('classifyHidReading: the two clocks are NOT interchangeable — idle is measured at the report clock', () => {
  // Reviewer finding 1 (BLOCKING class, pinned): the reported idle must be
  // measured at nowMs (when the observation is built), NOT at readAtMs.
  // Otherwise a genuinely-idle owner at the window edge reads ACTIVE.
  // Setup: last human event 122 s before the REPORT clock (T_CLASSIFY);
  // the reading (rawIdle 4 s at T_READ) points at OUR click, so it must
  // not move lastHuman. Truth: idle at report = 122 s → ownerPresence
  // (window 120) says INACTIVE. Pre-fix reading-clock measurement would
  // say 122 − 5.795 = 116.2 s → ACTIVE → the ticket's false-trip class.
  const lastHuman = T_CLASSIFY - 122_000;
  const r = classifyHidReading(2.0, T_READ, T_CLASSIFY, ownClick, lastHuman);
  assert.equal(r.idle, 122); // measured at the report clock — NOT 116.2
  assert.equal(r.lastHuman, lastHuman);
});

test('classifyHidReading: a human keystroke just past our own slack window is NOT swallowed', () => {
  // Reviewer finding 2 (recall-loss direction): a keystroke INSIDE the slack
  // (±1.5 s) of our own interval is deliberately absorbed as ours (boundary
  // ambiguity); one just OUTSIDE it must register as HUMAN. The human typed
  // at 12.9 — 1.716 s after our click ended (past the 1.5 s slack), 0.2 s
  // before the reading (rawIdle 0.2 at T_READ):
  const humanAt = Date.parse('2026-10-24T05:25:12.900Z');
  const r = classifyHidReading(0.2, T_READ, T_CLASSIFY, ownClick, null);
  assert.equal(r.lastHuman, humanAt);
  assert.equal(r.idle, (T_CLASSIFY - humanAt) / 1000); // ≈ 5.995 — at the report clock
});

test('classifyHidReading: unknown reading clock falls back to now (fail-closed)', () => {
  // readAtMs = null (legacy path, no stamp) → classify with nowMs — the old
  // behavior; never silently widen the own-input window.
  const r = classifyHidReading(2.0, null, T_CLASSIFY, ownClick, null);
  // eventAt = T_CLASSIFY − 2.0 — outside our interval → reads as human.
  assert.equal(r.idle, 2.0);
});

// ── (c) structural pins on the shipped source (the contract is load-bearing) ─

test('source pin: the screenshot path stamps the reading clock and classifies with it', () => {
  const src = readFileSync(join(pkgRoot, 'src', 'computer.ts'), 'utf8');
  // The topology read stamps when it came back…
  assert.ok(src.includes('topoReadAt'), 'topoReadAt stamp missing');
  // …and classification uses the reading's clock, not the pipeline-end clock.
  assert.ok(
    /classifyHidReading\(\s*rawIdle,\s*idleReadAt/.test(src),
    'screenshot path must call classifyHidReading(rawIdle, idleReadAt, …)',
  );
  // The ioreg fallback stamps its own read (it has its own clock).
  assert.ok(/ioregHidIdleSeconds\(\)/.test(src), 'ioreg fallback should remain');
});

test('source pin: the own-input ledger marks every input action (click/type/key/scroll/open)', () => {
  const src = readFileSync(join(pkgRoot, 'src', 'computer.ts'), 'utf8');
  const marks = src.match(/markOwnInput\(/g) || [];
  assert.ok(marks.length >= 4, `expected ≥4 markOwnInput call sites, found ${marks.length}`);
});

// ── (d) detector-recall replay (backend): true positives must survive ────────
// Pinned indirectly: the classifier contract above keeps a REAL human event
// (4 s before the reading) reporting idle=4 — the exact input
// computer-loop.ts ownerPresence({ hidIdleSeconds: 4 }) needs to render
// "human input 4 s ago" and latch camera-only. The backend side is pinned
// in computer-loop.display-focus-presence.cu-diag.test.ts ("a MACHINE-
// triggered run with the owner active becomes camera-only"), unchanged by
// this fix — our change only corrects WHICH events count as human.
