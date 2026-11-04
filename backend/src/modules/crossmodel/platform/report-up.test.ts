/**
 * report-up.ts — the deterministic reading of a project-supervisor →
 * Fleet-Supervisor message (tt-rd audit 2026-09-27, findings 1 + 2).
 *
 *  - a body carrying the doctrine's state-change vocabulary (WHAT MOVED /
 *    STUCK SINCE / NEEDS FLEET / moved toward|away) reads hasStateChange;
 *  - a question, a please, or an explicit need reads hasAsk;
 *  - neither ⇒ statusOnly (the advisory line / the opt-in ack-only drain);
 *  - batchIsStatusOnly is all-or-nothing and never true on an empty batch;
 *  - the env helpers read their switches at call time.
 */
import {
  classifyReportUp, batchIsStatusOnly, reportUpAckOnlyDrainEnabled,
  REPORT_UP_ADVISORY_LINE, REPORT_UP_ACK_NOTE, REPORT_UP_ACK_ORIGIN,
} from './report-up';

describe('classifyReportUp', () => {
  it('reads the doctrine state-change lines', () => {
    for (const t of [
      'WHAT MOVED: PR #706 merged — 3.44 → 5.08 tok/s (bit-exact).',
      'Lane ddd26be0 moved away from the goal: e2e regressed 5.82 → 5.36.',
      'STUCK SINCE 09-25 14:00Z — the L-HT1 ladder has 0 adoptions across 5 wakes.',
      'NEEDS FLEET: cross-project dependency on the tt-metal rebase.',
    ]) {
      const r = classifyReportUp(t);
      expect(r.hasStateChange).toBe(true);
      expect(r.statusOnly).toBe(false);
    }
  });

  it('reads an ask', () => {
    for (const t of [
      'Should we pause the bounty poll?',
      'Please steer lane 17f71915 — it re-polls the same 5 GETs.',
      'We need you to carry this to the owner: the QuietBox is network-dark.',
      'This is a framework issue: hook wakes are not delivering.',
    ]) {
      const r = classifyReportUp(t);
      expect(r.hasAsk).toBe(true);
      expect(r.statusOnly).toBe(false);
    }
  });

  // fixer 2026-09-27 (finding upward-chatter-3): natural goal-delivery bodies
  // carry no literal marker — the advisory landed on legitimate deltas, the
  // statusOnly telemetry over-counted, and the opt-in ack-only drain would have
  // swallowed a goal completion. An artifact / delivery cue is a delta.
  it('a natural delivery body — PR number, merged/landed, goal done, labelled receipt id, tok/s delta — is a state change, never status-only', () => {
    for (const t of [
      'PR #281 merged to main. Goal G2 delivered; todo T7 closed.',
      'The rebase landed on main at 14:02Z (PR #290). Goal "rebase" is complete.',
      'Goal "speed 7 tok/s" DONE — probe shows 7.1 tok/s client-visible (PR #300).',
      'Bisect finished: rung zf exonerated, commit 3fa2b1c9 reverted.',
      'Lane 17f71915 posted the client-visible number: 5.08 → 7.1 tok/s.',
      'Speed run: the vendor loop is now done, msg 871d203b carries the receipt.',
      'Results log restore shipped (#1098); the ladder todo is marked complete.',
    ]) {
      const r = classifyReportUp(t);
      expect([t, r.hasStateChange, r.statusOnly]).toEqual([t, true, false]);
    }
  });

  it('a bare lane id, an unchanged tok/s figure or an "open todos" count is NOT a delivery cue', () => {
    for (const t of [
      'Lane ddd26be0 running; lane 17f71915 scheduled hourly.',
      'Premise register unchanged at 5.08 tok/s of record.',
      '2 active goals, 4 open todos, nothing new.',
    ]) {
      expect([t, classifyReportUp(t).statusOnly]).toEqual([t, true]);
    }
  });

  it('a ledger restatement is status-only (the 259-of-310 class)', () => {
    const t = 'Status: 2 active goals, 4 open todos. Lane ddd26be0 running (bisect L-HT1zf), lane 17f71915 scheduled hourly. No change since last sweep. Premise register unchanged at 5.08 tok/s of record.';
    expect(classifyReportUp(t)).toEqual({ chars: t.length, hasStateChange: false, hasAsk: false, statusOnly: true });
  });

  it('empty / non-string input is status-only with zero chars', () => {
    expect(classifyReportUp('')).toMatchObject({ chars: 0, statusOnly: true });
    expect(classifyReportUp(undefined)).toMatchObject({ chars: 0, statusOnly: true });
  });
});

describe('batchIsStatusOnly', () => {
  it('true only when EVERY body is status-only; never on an empty batch', () => {
    expect(batchIsStatusOnly(['lane roster unchanged', 'no change since last sweep'])).toBe(true);
    expect(batchIsStatusOnly(['lane roster unchanged', 'WHAT MOVED: PR #1 merged'])).toBe(false);
    expect(batchIsStatusOnly(['lane roster unchanged', 'can you re-arm the sweep?'])).toBe(false);
    expect(batchIsStatusOnly([])).toBe(false);
  });
});

describe('switches + constants', () => {
  afterEach(() => { delete process.env.REPORT_UP_ACK_ONLY_DRAIN; });
  it('the ack-only drain is OFF by default and on only under REPORT_UP_ACK_ONLY_DRAIN=1', () => {
    expect(reportUpAckOnlyDrainEnabled()).toBe(false);
    process.env.REPORT_UP_ACK_ONLY_DRAIN = '1';
    expect(reportUpAckOnlyDrainEnabled()).toBe(true);
    process.env.REPORT_UP_ACK_ONLY_DRAIN = 'true';
    expect(reportUpAckOnlyDrainEnabled()).toBe(false);
  });
  it('the advisory names the remedy and the "not counted as an action" rule; the ack row is not a supervisor-note origin', () => {
    expect(REPORT_UP_ADVISORY_LINE).toContain('message the lane instead');
    expect(REPORT_UP_ADVISORY_LINE).toContain('not counted as an action');
    expect(REPORT_UP_ACK_NOTE).toContain('REPORT-UP ACKED');
    expect(['schedule', 'hook', 'machine', 'agent', 'webhook']).not.toContain(REPORT_UP_ACK_ORIGIN);
  });
});
