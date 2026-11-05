/**
 * Open-ended block escalation (todo 27c215d6) — the PURE leaf.
 * Pins the detection lexicons, the attention-watchdog normalization/similarity
 * borrowed for firing answers, the streak counter, the doubling backoff and
 * the merge precedence. No mocks — every helper is pure (same contract as
 * schedule-cadence.test.ts).
 */
import {
  isBlockedNoEndDateFinding, normalizeBlockTokens, blockAnswerSimilarity,
  blockStreakCount, blockStreakBackoffFor, mergeCadenceInterval, blockStreakStateLine,
  BLOCK_STREAK_TRIGGER, BLOCK_STREAK_MAX_INTERVAL_SEC,
} from './block-escalation';

// The baseline specimen class: the One Piece TCG prod-watch re-reporting the
// suspended AWS account day after day (ids/timestamps churn, tokens do not).
const TCG_REPORT = (n: number) =>
  `Check #${n} (2026-10-1${n}): AWS account 123456789012 remains suspended — provision is BLOCKED on the owner's account decision. No end date. Nothing else changed; task 4e8c22ab still pending.`;

describe('isBlockedNoEndDateFinding (todo 27c215d6)', () => {
  it('a strong blocked/waiting finding with no end date reads true', () => {
    expect(isBlockedNoEndDateFinding(TCG_REPORT(1))).toBe(true);
    expect(isBlockedNoEndDateFinding('Still blocked on the owner decision — waiting on the owner.')).toBe(true);
    expect(isBlockedNoEndDateFinding('HOLD: unable to deploy, needs the owner approval first.')).toBe(true);
  });
  it('an END-DATE marker scopes the finding out (dated holds have their own clock)', () => {
    expect(isBlockedNoEndDateFinding('Blocked until tomorrow when the quota resets.')).toBe(false);
    expect(isBlockedNoEndDateFinding('Blocked — the infra blocker expires 2026-10-19.')).toBe(false);
    expect(isBlockedNoEndDateFinding('On hold; ETA is Friday.')).toBe(false);
    expect(isBlockedNoEndDateFinding('Blocked, reopens in 3 days.')).toBe(false);
  });
  it('a quiet/healthy answer never reads as a blocked finding', () => {
    expect(isBlockedNoEndDateFinding('All green — nothing changed since the last check.')).toBe(false);
    expect(isBlockedNoEndDateFinding('Shipped PR #123; KPI moved to 14.2.')).toBe(false);
    expect(isBlockedNoEndDateFinding('')).toBe(false);
  });
  // Review F1 (2026-10-16, adversarial): the ALL-CLEAR vocabulary must stay OUT of
  // the lexicon — these exact specimens used to read as blocked findings.
  it('adversarial F1 specimens — all-clear / state-verb answers are NOT blocked findings (the false-escalation sin)', () => {
    expect(isBlockedNoEndDateFinding('Nothing needs the owner right now — every check is green.')).toBe(false);
    expect(isBlockedNoEndDateFinding('No action needed — I cannot find anything to do this hour.')).toBe(false);
    expect(isBlockedNoEndDateFinding('0 PRs awaiting review; the board is quiet.')).toBe(false);
    expect(isBlockedNoEndDateFinding('Waiting on CI to finish, then the deploy lands.')).toBe(false);
  });
  it('a RESOLUTION answer names its blocker but is not a blocked finding (the F1 RESOLVED specimen)', () => {
    expect(isBlockedNoEndDateFinding('RESOLVED — the AWS suspension blocker is cleared; provision succeeded.')).toBe(false);
  });
});

describe('normalization + similarity (the attention-watchdog primitives, import-free)', () => {
  it('ids, hashes, digits and punctuation are stripped so re-reports compare equal', () => {
    expect(normalizeBlockTokens('Check #47 (2026-10-14): task 4e8c22ab BLOCKED')).toEqual(
      normalizeBlockTokens('Check #48 (2026-10-15): task 91ff00c1 BLOCKED'),
    );
  });
  it('Jaccard on token sets: same report modulo ids ≈ 1, different subject < threshold', () => {
    expect(blockAnswerSimilarity(TCG_REPORT(1), TCG_REPORT(2))).toBeGreaterThanOrEqual(0.85);
    expect(blockAnswerSimilarity(TCG_REPORT(1), 'Deploy green; site healthy, KPI 14.2, nothing to report.')).toBeLessThan(0.85);
  });
});

describe('blockStreakCount (adjacent-pair streak, newest first)', () => {
  it('three consecutive near-identical blocked reports count 3 (the trigger)', () => {
    expect(blockStreakCount([TCG_REPORT(3), TCG_REPORT(2), TCG_REPORT(1)])).toBe(3);
    expect(blockStreakCount([TCG_REPORT(4), TCG_REPORT(3), TCG_REPORT(2), TCG_REPORT(1)])).toBe(4);
  });
  it('a healthy NEWEST answer means no streak — a resolved lane never escalates', () => {
    expect(blockStreakCount(['All green today.', TCG_REPORT(2), TCG_REPORT(1)])).toBe(0);
    expect(blockStreakCount([])).toBe(0);
  });
  it('a healthy/noisy OLDER answer caps the streak at the consecutive run (under-detection, never false escalation)', () => {
    expect(blockStreakCount([TCG_REPORT(2), 'Shipped PR #99.', TCG_REPORT(1)])).toBe(1);
  });
  it('a DIFFERENT blocker breaks the adjacency chain (same verb, different subject)', () => {
    const other = 'Blocked on the DNS propagation — waiting for the nameservers to settle, no timeline from the provider.';
    expect(blockStreakCount([other, TCG_REPORT(1)])).toBe(1);
  });
});

describe('blockStreakBackoffFor (doubling, ceiling 24 h, never shrinks)', () => {
  it('below the trigger: no verdict', () => {
    expect(blockStreakBackoffFor({ intervalSec: 1800, streak: 2 })).toBeNull();
  });
  it('at the trigger the cadence doubles; each additional trigger doubles again', () => {
    expect(blockStreakBackoffFor({ intervalSec: 1800, streak: 3 })).toEqual({ kind: 'backoff', fromSec: 1800, toSec: 3600, streak: 3 });
    expect(blockStreakBackoffFor({ intervalSec: 1800, streak: 6 })).toEqual({ kind: 'backoff', fromSec: 1800, toSec: 7200, streak: 6 });
  });
  it('the 24 h ceiling caps the doubling', () => {
    expect(blockStreakBackoffFor({ intervalSec: 3600, streak: 30 })).toEqual({ kind: 'backoff', fromSec: 3600, toSec: BLOCK_STREAK_MAX_INTERVAL_SEC, streak: 30 });
  });
  it('a cadence already at the ceiling gets no verdict (the OBSERVED metric still accrues)', () => {
    expect(blockStreakBackoffFor({ intervalSec: BLOCK_STREAK_MAX_INTERVAL_SEC, streak: 9 })).toBeNull();
  });
  it('garbage interval: null, fail-open', () => {
    expect(blockStreakBackoffFor({ intervalSec: 0, streak: 3 })).toBeNull();
    expect(blockStreakBackoffFor({ intervalSec: Number.NaN, streak: 3 })).toBeNull();
  });
});

describe('mergeCadenceInterval + state line', () => {
  it('the LARGER target wins when the stretch and the block backoff co-fire', () => {
    expect(mergeCadenceInterval({ toSec: 3600 }, { toSec: 14400 })).toEqual({ toSec: 14400 });
    expect(mergeCadenceInterval({ toSec: 28800 }, { toSec: 7200 })).toEqual({ toSec: 28800 });
    expect(mergeCadenceInterval(null, { toSec: 7200 })).toEqual({ toSec: 7200 });
    expect(mergeCadenceInterval({ toSec: 3600 }, null)).toEqual({ toSec: 3600 });
    expect(mergeCadenceInterval(null, null)).toBeNull();
  });
  it('the [SCHEDULE STATE] line names the streak and tells the lane to escalate instead of re-report', () => {
    const line = blockStreakStateLine({ kind: 'backoff', fromSec: 1800, toSec: 3600, streak: BLOCK_STREAK_TRIGGER });
    expect(line).toMatch(/cadence stretched 30→60 min/);
    expect(line).toMatch(/SAME unresolved blocker/);
    expect(line).toMatch(/escalate it/);
  });
  it('a check\'s OWN timestamp is not an end date — the baseline re-report class stays in scope', () => {
    expect(isBlockedNoEndDateFinding('Check #47 (2026-10-14): still BLOCKED on the owner decision, no end date.')).toBe(true);
  });
});
