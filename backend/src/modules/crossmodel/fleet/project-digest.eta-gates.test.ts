/**
 * Ticket C1 (sup3 2026-09-27, canlaw / canlegal-bench / spark-cluster audit) —
 * the project digest's ETA class ignored three facts it already had in hand:
 *
 *   (a) the AGE of a deps-blocked todo — canlaw's critical-path todo sat
 *       dep-blocked for weeks while the digest read on_pace ("3 days"),
 *       because blockKind='deps' rows were excluded from the gate outright
 *       (P7 v1#20 treated every deps block as ordering);
 *   (b) every registered DEADLINE premise — canlaw's sft2_start_by_unixts was
 *       the next day; spark's grid ended in hours while the Pulse said
 *       "ETA 4.7 days" (computeGoalEta took no deadline input at all);
 *   (c) a HOLD / HELD / BLOCKED progress note — the pulse quoted the note and
 *       still rendered on_pace from todo arithmetic.
 *
 * The fix (project-digest.service.ts): a deps-blocked row whose block is older
 * than DEPS_BLOCK_STALE_MS (72h) joins the gate; a premise whose key matches
 * DEADLINE_PREMISE_KEY_RE feeds a `behind_deadline` class when the projection
 * overshoots the days left (or the deadline passed with work open); a note
 * that LEADS with a hold marker yields `held`. Every phrase is honest and
 * relative (never a calendar date); the pre-C1 phrases stay byte-identical
 * when no deadline is registered.
 *
 * Review fixes (2026-09-27, same branch — each pinned below):
 *   1. the deadline decode NEVER throws: every path must land inside
 *      PLAUSIBLE_EPOCH_MS (2001‥2096) or it is not a deadline (a 1e20 ms /
 *      1e16 s value raised `RangeError: Invalid time value` out of
 *      computeGoalProgress and froze the bucket's digest row on every sweep);
 *   2. the rollup is judged against NO deadline — behind_deadline iff some
 *      goal is behind ITS OWN (summed work vs one goal's deadline called a
 *      project late when no goal was);
 *   3. the stale-deps age is anchored on the row's blockedAt stamp (set on
 *      the transition into 'blocked'; reason / note rewrites never touch
 *      it) — updatedAt restarted on every rewrite, so the live canlaw row
 *      (blocked 18 days, updatedAt 1 h) never aged past the gate; updatedAt
 *      stays the fallback for a row with no stamp;
 *   4. `held` reads the goal's own note else the freshest OPEN todo's (never
 *      a done row's), the marker must LEAD the note and not be lifted, and
 *      the render is a fact about the note ("held per note"), never an
 *      owner-set status — with one doctrine sentence on both progressNote
 *      params (source-text pin below).
 * Mock harness mirrors project-digest.service.test.ts (same module under test).
 */

import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: jest.fn() }));
jest.mock('./fleet.service', () => ({ getSidebarHiddenFleetArtifacts: jest.fn() }));
jest.mock('../platform/loop-metrics.service', () => ({ recordLoopMetric: jest.fn() }));

import {
  DEPS_BLOCK_STALE_MS,
  DEADLINE_PREMISE_KEY_RE,
  HOLD_NOTE_RE,
  HOLD_LIFTED_RE,
  PLAUSIBLE_EPOCH_MS,
  isHoldNote,
  isPlausibleEpochMs,
  blockStartMs,
  computeGoalEta,
  computeGoalProgress,
  computeEtaSummary,
  etaSummaryPhrase,
  goalEtaPhrase,
  goalDeadline,
  premiseDeadlineMs,
  roundDaysLeft,
  deadlineName,
  deadlineDuePhrase,
  fallbackDigestSummary,
  type DigestStats,
} from './project-digest.service';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysFromNow = (d: number) => NOW.getTime() + d * 864e5;
const secs = (ms: number) => Math.floor(ms / 1000);

const goalRow = (id: string, title: string, status = 'active', extra: Record<string, any> = {}) => ({ id, title, status, ...extra });
const todoRow = (goalId: string, status: string, updatedAt: Date, extra: Record<string, any> = {}) => ({ goalId, status, updatedAt, ...extra });

/** The canonical paced fixture: 7 done inside 7d (pace 1/day), 11 open ⇒ etaDays 11. */
function pacedTodos(goalId: string, open = 11) {
  return [
    ...Array.from({ length: 7 }, (_, i) => todoRow(goalId, 'done', hoursAgo(2 + i * 20))),
    ...Array.from({ length: open }, () => todoRow(goalId, 'pending', hoursAgo(200))),
  ];
}

function stats(): DigestStats {
  return {
    chatCount: 1, activeChats: 1,
    messages: { total: 2, user: 1, assistant: 1, byOrigin: { user: 1, assistant: 1 } },
    runs: { started: 1, completed: 1, failed: 0, active: 0 },
    todos: { total: 18, done: 7, blocked: 0, dropped: 0, createdInWindow: 0, completedInWindow: 0 },
    goals: { total: 1, done: 0, blocked: 0, createdInWindow: 0, completedInWindow: 0, archived: 0, lastFinishedAt: null },
    schedules: { firedInWindow: 0, errored: 0 },
    queuedMessages: 0,
  };
}

// ── (b) deadline premise reading ─────────────────────────────────────────────
describe('C1 (b) — deadline premises: key match, instant decoding, nearest wins', () => {
  it('DEADLINE_PREMISE_KEY_RE matches the three suffixes only, case-insensitively', () => {
    for (const k of ['sft2_start_by_unixts', 'grid_deadline', 'report_due', 'SFT2_START_BY_UNIXTS']) expect(DEADLINE_PREMISE_KEY_RE.test(k)).toBe(true);
    for (const k of ['untrained_base_suite_mean', 'due_count', 'deadline_days_left', 'by_unixts_note']) expect(DEADLINE_PREMISE_KEY_RE.test(k)).toBe(false);
  });

  it('premiseDeadlineMs: units first, then the _unixts key suffix, then the plausible-epoch heuristic', () => {
    const t = daysFromNow(1);
    expect(premiseDeadlineMs({ key: 'x_by_unixts', value: secs(t) })).toBe(secs(t) * 1000);
    expect(premiseDeadlineMs({ key: 'x_deadline', value: t, unit: 'ms' })).toBe(t);
    expect(premiseDeadlineMs({ key: 'x_deadline', value: secs(t), unit: 's' })).toBe(secs(t) * 1000);
    expect(premiseDeadlineMs({ key: 'x_due', value: 3, unit: 'days', setAt: NOW.toISOString() })).toBe(daysFromNow(3));
    expect(premiseDeadlineMs({ key: 'x_due', value: 6, unit: 'h', setAt: NOW.toISOString() })).toBe(NOW.getTime() + 6 * 36e5);
    expect(premiseDeadlineMs({ key: 'x_due', value: 3, unit: 'days' })).toBeNull(); // relative with no anchor
    expect(premiseDeadlineMs({ key: 'x_deadline', value: secs(t) })).toBe(secs(t) * 1000); // unitless seconds epoch
    expect(premiseDeadlineMs({ key: 'x_deadline', value: t })).toBe(t);                     // unitless ms epoch
    expect(premiseDeadlineMs({ key: 'x_deadline', value: 42 })).toBeNull();                 // not an instant
    expect(premiseDeadlineMs({ key: 'x_deadline', value: Number.NaN })).toBeNull();
    expect(premiseDeadlineMs({ key: 'x_deadline', value: 5, unit: 'furlongs' })).toBeNull(); // unknown unit never guesses
  });

  it('review fix 1: every decode path must land inside PLAUSIBLE_EPOCH_MS (2001‥2096) — out-of-range values are NOT deadlines and NOTHING throws', () => {
    expect(PLAUSIBLE_EPOCH_MS).toEqual({ min: 1e12, max: 4e12 });
    // the two probe values from the review, plus the `_by_unixts`-holding-milliseconds case (×1000 ⇒ year 58711)
    expect(premiseDeadlineMs({ key: 'x_deadline', value: 1e20, unit: 'ms' })).toBeNull();
    expect(premiseDeadlineMs({ key: 'x_by_unixts', value: 1e16 })).toBeNull();
    expect(premiseDeadlineMs({ key: 'x_by_unixts', value: daysFromNow(1) })).toBeNull();
    expect(premiseDeadlineMs({ key: 'x_deadline', value: 5e11, unit: 'ms' })).toBeNull();           // 1985 — before the window
    expect(premiseDeadlineMs({ key: 'x_deadline', value: 4e12, unit: 'ms' })).toBeNull();           // the exclusive upper edge
    expect(premiseDeadlineMs({ key: 'x_deadline', value: 1e12, unit: 'ms' })).toBe(1e12);           // the inclusive lower edge
    expect(premiseDeadlineMs({ key: 'x_due', value: 1e12, unit: 'days', setAt: NOW.toISOString() })).toBeNull(); // relative overshoot
    expect(premiseDeadlineMs({ key: 'x_deadline', value: Number.POSITIVE_INFINITY, unit: 's' })).toBeNull();
    expect(isPlausibleEpochMs(1e20)).toBe(false);
    expect(isPlausibleEpochMs(null)).toBe(false);
    expect(isPlausibleEpochMs(daysFromNow(1))).toBe(true);
    for (const premises of [
      [{ key: 'x_deadline', value: 1e20, unit: 'ms' }],
      [{ key: 'x_by_unixts', value: 1e16 }],
      [{ key: 'x_deadline', value: { toString() { throw new Error('boom'); } } }],
      [{ key: 'x_due', value: 3, unit: 'days', setAt: { toString() { throw new Error('boom'); } } }],
    ]) {
      expect(() => goalDeadline(premises, NOW)).not.toThrow();
      expect(goalDeadline(premises, NOW)).toBeNull();
    }
    // the mixed case: one unreadable premise never hides a readable sibling
    expect(goalDeadline([{ key: 'bad_deadline', value: 1e20, unit: 'ms' }, { key: 'ok_deadline', value: secs(daysFromNow(2)) }], NOW)?.key).toBe('ok_deadline');
    // and computeGoalProgress writes the row (class from pace, no deadline key) instead of throwing the bucket
    const gp = computeGoalProgress([goalRow('g1', 'G', 'active', { premises: [{ key: 'x_deadline', value: 1e20, unit: 'ms' }] })], pacedTodos('g1'), NOW);
    expect(gp).toHaveLength(1);
    expect(gp[0].eta).toEqual({ remaining: 11, pacePerDay: 1, etaDays: 11, class: 'on_pace' });
  });

  it('roundDaysLeft: one decimal inside ±2d, whole days beyond, never -0', () => {
    expect(roundDaysLeft(0.25)).toBe(0.3);
    expect(roundDaysLeft(1.94)).toBe(1.9);
    expect(roundDaysLeft(3.4)).toBe(3);
    expect(roundDaysLeft(-5.6)).toBe(-6);
    expect(Object.is(roundDaysLeft(-0.04), 0)).toBe(true);
    expect(Object.is(roundDaysLeft(-0.3), -0.3)).toBe(true);
  });

  it('goalDeadline: the NEAREST matching premise wins; non-deadline keys, unreadable values and garbage rows are ignored; non-array ⇒ null', () => {
    const premises = [
      { key: 'untrained_base_suite_mean', value: 0.42 },
      { key: 'report_due', value: secs(daysFromNow(5)) },
      { key: 'sft2_start_by_unixts', value: secs(daysFromNow(1)) },
      { key: 'bogus_deadline', value: 'soon' },
      null, 'x', 7,
    ];
    const d = goalDeadline(premises, NOW)!;
    expect(d.key).toBe('sft2_start_by_unixts');
    expect(d.at).toBe(new Date(secs(daysFromNow(1)) * 1000).toISOString());
    expect(d.daysLeft).toBe(1);
    expect(goalDeadline(null, NOW)).toBeNull();
    expect(goalDeadline('[]', NOW)).toBeNull();
    expect(goalDeadline([{ key: 'untrained_base_suite_mean', value: 0.42 }], NOW)).toBeNull();
  });
});

// ── the class ladder ─────────────────────────────────────────────────────────
describe('C1 — computeGoalEta ladder: done > blocked > held > behind_deadline > on_pace > no_movement', () => {
  const dl = (daysLeft: number) => ({ key: 'grid_end_by_unixts', at: new Date(daysFromNow(daysLeft)).toISOString(), daysLeft });

  it('behind_deadline when the projection overshoots the days left; on_pace (with the deadline carried) when it fits', () => {
    const behind = computeGoalEta({ remaining: 11, blockedGate: false, completed24h: 1, completed7d: 7, deadline: dl(1) });
    expect(behind).toMatchObject({ etaDays: 11, class: 'behind_deadline', deadline: { key: 'grid_end_by_unixts', daysLeft: 1 } });
    const fits = computeGoalEta({ remaining: 3, blockedGate: false, completed24h: 1, completed7d: 7, deadline: dl(5) });
    expect(fits).toMatchObject({ etaDays: 3, class: 'on_pace', deadline: { daysLeft: 5 } });
    // spark: "ETA 4.7 days" for a grid ending in hours
    const spark = computeGoalEta({ remaining: 14, blockedGate: false, completed24h: 3, completed7d: 21, deadline: dl(0.3) });
    expect(spark.etaDays).toBe(4.7);
    expect(spark.class).toBe('behind_deadline');
  });

  it('no pace: a PASSED deadline with work open is behind_deadline; a future one stays no_movement (nothing to project) but carries the deadline', () => {
    expect(computeGoalEta({ remaining: 4, blockedGate: false, completed24h: 0, completed7d: 0, deadline: dl(-3) }).class).toBe('behind_deadline');
    expect(computeGoalEta({ remaining: 4, blockedGate: false, completed24h: 0, completed7d: 0, deadline: dl(0) }).class).toBe('behind_deadline');
    const future = computeGoalEta({ remaining: 4, blockedGate: false, completed24h: 0, completed7d: 0, deadline: dl(2) });
    expect(future.class).toBe('no_movement');
    expect(future.deadline).toEqual(dl(2));
  });

  it('held sits under blocked and above behind_deadline; done wins over everything; no deadline ⇒ no `deadline` key (pre-C1 shape)', () => {
    expect(computeGoalEta({ remaining: 5, blockedGate: false, completed24h: 1, completed7d: 7, heldGate: true, deadline: dl(1) }).class).toBe('held');
    expect(computeGoalEta({ remaining: 5, blockedGate: true, completed24h: 1, completed7d: 7, heldGate: true, deadline: dl(1) }).class).toBe('blocked');
    expect(computeGoalEta({ remaining: 0, blockedGate: true, completed24h: 0, completed7d: 5, heldGate: true, deadline: dl(-1) }).class).toBe('done');
    const plain = computeGoalEta({ remaining: 11, blockedGate: false, completed24h: 2, completed7d: 7 });
    expect(plain).toEqual({ remaining: 11, pacePerDay: 1, etaDays: 11, class: 'on_pace' });
    expect('deadline' in plain).toBe(false);
  });
});

// ── (a) stale deps-blocked rows + (c) HOLD notes, through computeGoalProgress ─
describe('C1 (a) — a deps-blocked todo whose block is older than 72h joins the gate (aged from blockedAt — review fix 3)', () => {
  it('the live canlaw shape: blockedAt 18 days ago while updatedAt is 1 h old (a lane keeps rewriting the reason) GATES; a 2-day-old block does not', () => {
    const stale = computeGoalProgress(
      [goalRow('g1', 'CanLaw SFT2')],
      [...pacedTodos('g1'), todoRow('g1', 'blocked', hoursAgo(1), { blockKind: 'deps', blockedAt: hoursAgo(18 * 24) })],
      NOW,
    )[0];
    expect(stale).toMatchObject({ blockedCount: 1, depsBlockedCount: 1, staleDepsBlockedCount: 1, held: false });
    expect(stale.eta.class).toBe('blocked');
    expect(stale.eta.etaDays).toBe(12); // 12 open (11 pending + the blocked one) / pace 1 — still computed, still honest

    const fresh = computeGoalProgress(
      [goalRow('g1', 'CanLaw SFT2')],
      [...pacedTodos('g1'), todoRow('g1', 'blocked', hoursAgo(1), { blockKind: 'deps', blockedAt: hoursAgo(48) })],
      NOW,
    )[0];
    expect(fresh).toMatchObject({ blockedCount: 1, depsBlockedCount: 1, staleDepsBlockedCount: 0 });
    expect(fresh.eta.class).toBe('on_pace');
  });

  it('blockStartMs: blockedAt wins (Date or ISO string); no stamp ⇒ updatedAt', () => {
    expect(blockStartMs({ blockedAt: hoursAgo(100), updatedAt: hoursAgo(1) })).toBe(hoursAgo(100).getTime());
    expect(blockStartMs({ blockedAt: hoursAgo(100).toISOString(), updatedAt: hoursAgo(1) })).toBe(hoursAgo(100).getTime());
    expect(blockStartMs({ blockedAt: null, updatedAt: hoursAgo(1) })).toBe(hoursAgo(1).getTime());
    expect(blockStartMs({ updatedAt: hoursAgo(1) })).toBe(hoursAgo(1).getTime());
    expect(blockStartMs({ blockedAt: 'garbage', updatedAt: hoursAgo(1) })).toBe(hoursAgo(1).getTime());
  });

  it('a row blocked before the stamp existed (blockedAt null) still ages on updatedAt — the pre-review behaviour, never a regression', () => {
    const legacy = computeGoalProgress(
      [goalRow('g1', 'G')],
      [...pacedTodos('g1'), todoRow('g1', 'blocked', hoursAgo(18 * 24), { blockKind: 'deps' })],
      NOW,
    )[0];
    expect(legacy.staleDepsBlockedCount).toBe(1);
    expect(legacy.eta.class).toBe('blocked');
  });

  it("the goal's OWN deps-typed block gates once its blockedAt is stale — only from the stamp, never from goal.updatedAt (re-stamped hourly by the premise re-check)", () => {
    const stale = computeGoalProgress([goalRow('g1', 'G', 'blocked', { blockKind: 'deps', blockedAt: hoursAgo(100) })], pacedTodos('g1'), NOW)[0];
    expect(stale.eta.class).toBe('blocked');
    expect(goalEtaPhrase(stale)).toBe('the goal is blocked, gating progress');
    const fresh = computeGoalProgress([goalRow('g1', 'G', 'blocked', { blockKind: 'deps', blockedAt: hoursAgo(10) })], pacedTodos('g1'), NOW)[0];
    expect(fresh.eta.class).toBe('on_pace');
    const unstamped = computeGoalProgress([goalRow('g1', 'G', 'blocked', { blockKind: 'deps', updatedAt: hoursAgo(500) })], pacedTodos('g1'), NOW)[0];
    expect(unstamped.eta.class).toBe('on_pace'); // no stamp ⇒ no age ⇒ ordering (P7 v1#20 unchanged)
  });

  it('the threshold is DEPS_BLOCK_STALE_MS exactly (72h) on the block start', () => {
    expect(DEPS_BLOCK_STALE_MS).toBe(72 * 3_600_000);
    const atEdge = computeGoalProgress([goalRow('g1', 'G')], [todoRow('g1', 'blocked', hoursAgo(1), { blockKind: 'deps', blockedAt: new Date(NOW.getTime() - DEPS_BLOCK_STALE_MS) }), todoRow('g1', 'done', hoursAgo(1))], NOW)[0];
    expect(atEdge.staleDepsBlockedCount).toBe(1);
    const justUnder = computeGoalProgress([goalRow('g1', 'G')], [todoRow('g1', 'blocked', hoursAgo(1), { blockKind: 'deps', blockedAt: new Date(NOW.getTime() - DEPS_BLOCK_STALE_MS + 1000) }), todoRow('g1', 'done', hoursAgo(1))], NOW)[0];
    expect(justUnder.staleDepsBlockedCount).toBe(0);
  });

  it('the fact line names the stale subset so the fragment and the class agree', () => {
    const gp = computeGoalProgress(
      [goalRow('g1', 'CanLaw SFT2')],
      [todoRow('g1', 'done', hoursAgo(2)), todoRow('g1', 'blocked', hoursAgo(100), { blockKind: 'deps' }), todoRow('g1', 'blocked', hoursAgo(10), { blockKind: 'deps' })],
      NOW,
    )[0];
    const summary = fallbackDigestSummary('CanLaw', 'on_track', stats(), [], [gp], null);
    expect(summary).toContain('2 waiting on dependencies (1 for over 3 days)');
    expect(summary).toContain('one dependency-blocked task has waited over 3 days, gating progress');
  });
});

describe('C1 (c) — a progress note that LEADS with a hold marker yields held (review-tightened 2026-09-27)', () => {
  it('isHoldNote: the marker must LEAD the note (≤3 punctuation chars before it), uppercase HOLD/HELD/BLOCKED or "on hold" any case; lowercase prose and mid-sentence markers never match', () => {
    for (const s of ['HOLD until the owner confirms the budget', 'HELD pending legal review', 'BLOCKED: waiting on GPU quota', '[HOLD] phase 2', '— On Hold — vendor', 'on_hold', '**BLOCKED** on quota', '  HOLD (owner msg 7f2a: stop SFT-2)']) {
      expect(HOLD_NOTE_RE.test(s.trim())).toBe(true);
      expect(isHoldNote(s)).toBe(true);
    }
    // mid-sentence: a lane bench verdict (the live canlaw goal note), prose, a done row's history
    for (const s of ['Phase 2 on hold', 'STATUS at_risk … s2v14r6 HOLD (Δ+2.70 det-v2 ✓ …)', 'shard 3 BLOCKED on quota', 'was BLOCKED on quota; quota granted, shipped', 'hold the results in S3 until Friday', 'blocked by nothing now — resumed', 'household survey shipped', 'BEHOLD the loss curve', 'unblocked', 'HOLDING pattern']) {
      expect(isHoldNote(s)).toBe(false);
    }
    expect(isHoldNote(null)).toBe(false);
    expect(isHoldNote(undefined)).toBe(false);
    expect(isHoldNote('')).toBe(false);
  });

  it('a note that says the hold was lifted is NOT a hold, whatever it leads with (HOLD_LIFTED_RE)', () => {
    for (const s of ['HOLD lifted by owner 09-26', 'BLOCKED→unblocked 09-20, resumed', 'ON HOLD lifted, resumed', 'HOLD cleared — resuming SFT-2', 'HELD no longer — released 09-27', 'BLOCKED then reopened']) {
      expect(HOLD_NOTE_RE.test(s)).toBe(true);   // it does lead with the marker…
      expect(HOLD_LIFTED_RE.test(s)).toBe(true); // …and says it is over
      expect(isHoldNote(s)).toBe(false);
    }
    const lifted = computeGoalProgress([goalRow('g1', 'G', 'active', { progressNote: 'HOLD lifted by owner 09-26 — resumed' })], pacedTodos('g1'), NOW)[0];
    expect(lifted).toMatchObject({ held: false, eta: { class: 'on_pace' } });
  });

  it("the goal's own note wins; else the freshest OPEN todo's note — a done row's note never holds even when it is the freshest (finishing bumps updatedAt); the pulse still quotes the freshest note (P7 unchanged)", () => {
    const fromGoal = computeGoalProgress([goalRow('g1', 'G', 'active', { progressNote: 'HOLD until owner confirms budget' })], pacedTodos('g1'), NOW)[0];
    expect(fromGoal.held).toBe(true);
    expect(fromGoal.eta.class).toBe('held');
    expect(fromGoal.eta.etaDays).toBe(11);
    const fromOpenTodo = computeGoalProgress(
      [goalRow('g1', 'G')],
      [...pacedTodos('g1'), todoRow('g1', 'in_progress', hoursAgo(1), { progressNote: 'BLOCKED on quota — shard 3 waits' })],
      NOW,
    )[0];
    expect(fromOpenTodo.eta.class).toBe('held');
    // The freshest note is a DONE row's; the open row's note is plain ⇒ not held. The quoted note is still the freshest (display unchanged).
    const doneFreshest = computeGoalProgress(
      [goalRow('g1', 'G')],
      [
        ...pacedTodos('g1'),
        todoRow('g1', 'done', hoursAgo(1), { progressNote: 'BLOCKED on quota, then granted — shipped' }),
        todoRow('g1', 'in_progress', hoursAgo(5), { progressNote: '3/5 shards trained' }),
      ],
      NOW,
    )[0];
    expect(doneFreshest.held).toBe(false);
    expect(doneFreshest.eta.class).toBe('on_pace');
    expect(doneFreshest.progressNote).toBe('BLOCKED on quota, then granted — shipped');
    // Even a done row's note that LEADS with the marker never holds — only open rows are read.
    const doneLeads = computeGoalProgress([goalRow('g1', 'G')], [...pacedTodos('g1'), todoRow('g1', 'done', hoursAgo(1), { progressNote: 'BLOCKED on quota (resolved)' })], NOW)[0];
    expect(doneLeads.held).toBe(false);
    expect(doneLeads.eta.class).toBe('on_pace');
    // A dropped row's note is out too (dropped rows leave every count already).
    const droppedLeads = computeGoalProgress([goalRow('g1', 'G')], [...pacedTodos('g1'), todoRow('g1', 'dropped', hoursAgo(1), { progressNote: 'HOLD — superseded by oq_1' })], NOW)[0];
    expect(droppedLeads.held).toBe(false);
    const plain = computeGoalProgress([goalRow('g1', 'G', 'active', { progressNote: '3/5 shards trained' })], pacedTodos('g1'), NOW)[0];
    expect(plain).toMatchObject({ held: false, eta: { class: 'on_pace' } });
    // The phrase is a FACT about the note, never an owner-set "on hold" status.
    const summary = fallbackDigestSummary('Spark', 'on_track', stats(), [], [fromGoal], null);
    expect(summary).toContain('the latest open progress note leads with a hold marker, so no estimate; latest: "HOLD until owner confirms budget"');
    expect(summary).not.toContain('on hold per');
  });

  it('the live canlaw goal note — a lane bench verdict that mentions HOLD mid-note — is NOT a hold', () => {
    const verdict = computeGoalProgress([goalRow('g1', 'G', 'active', { progressNote: 'STATUS at_risk — s2v14r6 HOLD (Δ+2.70 det-v2 ✓, gate FAILED)' })], pacedTodos('g1'), NOW)[0];
    expect(verdict.held).toBe(false);
    expect(verdict.eta.class).toBe('on_pace');
  });
});

describe('C1 (b) — the deadline premise through computeGoalProgress and the rollup', () => {
  const canlaw = () => goalRow('g1', 'CanLaw SFT2', 'active', {
    premises: [{ key: 'untrained_base_suite_mean', value: 0.42 }, { key: 'sft2_start_by_unixts', value: secs(daysFromNow(1)), setAt: hoursAgo(30).toISOString() }],
  });

  it('canlaw: pace says 11 days, the registered premise deadline is tomorrow ⇒ behind_deadline with the deadline on the row', () => {
    const gp = computeGoalProgress([canlaw()], pacedTodos('g1'), NOW)[0];
    expect(gp.eta).toMatchObject({ etaDays: 11, class: 'behind_deadline', deadline: { key: 'sft2_start_by_unixts', daysLeft: 1 } });
    expect(goalEtaPhrase(gp)).toBe('behind the sft2 start deadline (due in a day) — at the current pace roughly 11 more days of work remains');
  });

  it('rollup: a fast sibling never hides a late goal — any goal behind its own deadline makes the project behind_deadline, naming THAT deadline', () => {
    const late = computeGoalProgress([canlaw()], pacedTodos('g1'), NOW)[0];
    const fast = computeGoalProgress(
      [goalRow('g2', 'Docs', 'active', { premises: [{ key: 'docs_due', value: secs(daysFromNow(30)) }] })],
      [...Array.from({ length: 70 }, (_, i) => todoRow('g2', 'done', hoursAgo(1 + (i % 6) * 24))), todoRow('g2', 'pending', hoursAgo(5))],
      NOW,
    )[0];
    expect(fast.eta.class).toBe('on_pace');
    const rollup = computeEtaSummary([fast, late])!;
    // The rollup's own projection (12 open at 11/day ≈ 1.1d) is irrelevant here:
    // the late goal forces the class regardless of how fast its sibling moves.
    expect(rollup.class).toBe('behind_deadline');
    expect(rollup.deadline?.key).toBe('sft2_start_by_unixts');
    expect(etaSummaryPhrase(rollup)).toMatch(/^behind the sft2 start deadline \(due in a day\)/);
  });

  it("review fix 2: the rollup is judged against NO deadline — A on pace for its own deadline + B with no deadline (summed work overshoots A's deadline) ⇒ on_pace, deadline = A's, and the rollup phrase names no deadline", () => {
    const a = computeGoalProgress(
      [goalRow('ga', 'A', 'active', { premises: [{ key: 'a_deadline', value: secs(daysFromNow(3)) }] })],
      [...Array.from({ length: 7 }, (_, i) => todoRow('ga', 'done', hoursAgo(2 + i * 20))), todoRow('ga', 'pending', hoursAgo(50)), todoRow('ga', 'pending', hoursAgo(50))],
      NOW,
    )[0];
    const b = computeGoalProgress([goalRow('gb', 'B')], pacedTodos('gb', 50), NOW)[0];
    expect(a.eta).toMatchObject({ etaDays: 2, class: 'on_pace', deadline: { key: 'a_deadline', daysLeft: 3 } });
    expect(b.eta).toMatchObject({ etaDays: 50, class: 'on_pace' });
    expect('deadline' in b.eta).toBe(false);
    const rollup = computeEtaSummary([a, b])!;
    expect(rollup.class).toBe('on_pace');
    expect(rollup.etaDays).toBe(26); // 52 open / 2 per day — the project-wide projection, informational only
    expect(rollup.deadline).toEqual(a.eta.deadline); // the nearest registered deadline rides as a fact
    expect(etaSummaryPhrase(rollup)).toBe('at the current pace roughly 26 more days');
    // every goal on pace for the SAME deadline ⇒ still on_pace (nothing is behind)
    const a2 = computeGoalProgress(
      [goalRow('ga2', 'A2', 'active', { premises: [{ key: 'a_deadline', value: secs(daysFromNow(3)) }] })],
      [...Array.from({ length: 7 }, (_, i) => todoRow('ga2', 'done', hoursAgo(2 + i * 20))), todoRow('ga2', 'pending', hoursAgo(50)), todoRow('ga2', 'pending', hoursAgo(50))],
      NOW,
    )[0];
    expect(computeEtaSummary([a, a2])!.class).toBe('on_pace');
    // and a no-pace sibling with no deadline never makes the rollup behind either
    const idle = computeGoalProgress([goalRow('gi', 'Idle')], [todoRow('gi', 'pending', hoursAgo(300))], NOW)[0];
    expect(idle.eta.class).toBe('no_movement');
    expect(computeEtaSummary([a, idle])!.class).toBe('on_pace');
  });

  it('rollup: held only when every unfinished goal is held-or-blocked with at least one held; all-blocked stays blocked', () => {
    const held = computeGoalProgress([goalRow('g1', 'A', 'active', { progressNote: 'HOLD' })], pacedTodos('g1'), NOW)[0];
    const gated = computeGoalProgress([goalRow('g2', 'B')], [todoRow('g2', 'blocked', hoursAgo(1), { blockKind: 'owner' })], NOW)[0];
    const paced = computeGoalProgress([goalRow('g3', 'C')], pacedTodos('g3'), NOW)[0];
    expect(computeEtaSummary([held, gated])!.class).toBe('held');
    expect(computeEtaSummary([gated])!.class).toBe('blocked');
    expect(computeEtaSummary([held, paced])!.class).toBe('on_pace'); // a grinding sibling keeps the project moving (547df1ff class)
    expect(etaSummaryPhrase(computeEtaSummary([held, gated])!)).toBe('the latest open progress note leads with a hold marker, so no estimate');
  });

  it('a passed deadline with no pace phrases the overdue fact and the open count', () => {
    const gp = computeGoalProgress(
      [goalRow('g1', 'Grid', 'active', { premises: [{ key: 'grid_end_by_unixts', value: secs(daysFromNow(-3)) }] })],
      [todoRow('g1', 'pending', hoursAgo(300)), todoRow('g1', 'pending', hoursAgo(300)), todoRow('g1', 'done', hoursAgo(300))],
      NOW,
    )[0];
    expect(gp.eta.class).toBe('behind_deadline');
    expect(goalEtaPhrase(gp)).toBe('the grid end deadline passed 3 days ago with 2 tasks still open');
  });
});

// ── phrases ──────────────────────────────────────────────────────────────────
describe('C1 — phrases stay relative and honest; pre-C1 phrases are byte-identical without a deadline', () => {
  const eta = (over: Record<string, any>) => ({ remaining: 1, pacePerDay: 0, etaDays: null, class: 'no_movement', ...over }) as any;
  const dl = (daysLeft: number, key = 'grid_end_by_unixts') => ({ key, at: new Date(daysFromNow(daysLeft)).toISOString(), daysLeft });

  it('deadlineName strips the type suffix; deadlineDuePhrase never emits a calendar date', () => {
    expect(deadlineName('sft2_start_by_unixts')).toBe('sft2 start');
    expect(deadlineName('grid_deadline')).toBe('grid');
    expect(deadlineName('report_due')).toBe('report');
    expect(deadlineName('_due')).toBe('_due'); // nothing left ⇒ the raw key, never an empty name
    expect(deadlineDuePhrase(0.3)).toBe('due within a day');
    expect(deadlineDuePhrase(1)).toBe('due in a day');
    expect(deadlineDuePhrase(5)).toBe('due in 5 days');
    expect(deadlineDuePhrase(-0.5)).toBe('passed a day ago');
    expect(deadlineDuePhrase(-3)).toBe('passed 3 days ago');
  });

  it('the deadline fact rides the on_pace / no_movement / blocked phrases as a trailing parenthesis', () => {
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'on_pace', etaDays: 3.2, deadline: dl(5) }) }))
      .toBe('at the current pace roughly 3 more days (grid end deadline due in 5 days)');
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'no_movement', deadline: dl(2) }) }))
      .toBe('no movement in the last week, so no reliable estimate (grid end deadline due in 2 days)');
    expect(goalEtaPhrase({ blockedCount: 2, eta: eta({ class: 'blocked', deadline: dl(0.3) }) }))
      .toBe('2 blocked tasks are gating progress (grid end deadline due within a day)');
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'done', remaining: 0, deadline: dl(-1) }) })).toBe('all tasks done');
  });

  it('without a deadline every pre-C1 phrase is unchanged', () => {
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'on_pace', etaDays: 3.2 }) })).toBe('at the current pace roughly 3 more days');
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'on_pace', etaDays: 0.4 }) })).toBe('at the current pace roughly a day to go');
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'no_movement' }) })).toBe('no movement in the last week, so no reliable estimate');
    expect(goalEtaPhrase({ blockedCount: 1, eta: eta({ class: 'blocked' }) })).toBe('one blocked task is gating progress');
    expect(goalEtaPhrase({ blockedCount: 3, eta: eta({ class: 'blocked' }) })).toBe('3 blocked tasks are gating progress');
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'blocked' }) })).toBe('the goal is blocked, gating progress');
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'done', remaining: 0 }) })).toBe('all tasks done');
  });

  it('a mixed gate (real block + stale deps) keeps the plain blocked phrase; only an all-stale gate names the dependency wait', () => {
    expect(goalEtaPhrase({ blockedCount: 2, depsBlockedCount: 1, staleDepsBlockedCount: 1, eta: eta({ class: 'blocked' }) }))
      .toBe('2 blocked tasks are gating progress');
    expect(goalEtaPhrase({ blockedCount: 2, depsBlockedCount: 2, staleDepsBlockedCount: 2, eta: eta({ class: 'blocked' }) }))
      .toBe('2 dependency-blocked tasks have waited over 3 days, gating progress');
  });
});

// ── review fix 4 — the doctrine pin ───────────────────────────────────────────
// Lanes learn what a LEADING hold marker does to the Pulse from the one place
// they read before writing a note: the progressNote param description on
// goal_update and todo_update. Read as source text (platform-tools.ts imports
// half the platform at module scope) and pinned to the regex it describes.
describe('doctrine: both progressNote params carry the held-per-note sentence, and it matches isHoldNote', () => {
  const sentence = 'A note that LEADS with HOLD / HELD / BLOCKED / ON HOLD renders the goal as held-per-note on the Pulse (no estimate): lead with that marker only for a hold the owner set in their own words — never a lane-set gate or a bench verdict — and write lifted / resumed once it is over (the marker is then ignored).';

  it('goal_update and todo_update progressNote descriptions both carry the sentence verbatim', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'platform', 'platform-tools.ts'), 'utf8');
    expect(src.split(sentence).length - 1).toBe(2);
    // …and each sits on a progressNote param line (not stray prose).
    const lines = src.split('\n').filter((l) => l.includes(sentence));
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l.trimStart().startsWith('progressNote:')).toBe(true);
  });

  it('the sentence describes the real rule: the four markers lead ⇒ held; "lifted" / "resumed" ⇒ ignored', () => {
    for (const s of ['HOLD x', 'HELD x', 'BLOCKED x', 'ON HOLD x']) expect(isHoldNote(s)).toBe(true);
    for (const s of ['HOLD x — lifted', 'BLOCKED x, resumed']) expect(isHoldNote(s)).toBe(false);
  });
});
