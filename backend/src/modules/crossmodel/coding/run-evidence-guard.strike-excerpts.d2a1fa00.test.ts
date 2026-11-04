/**
 * REPLAY (ticket d2a1fa00, R&D stream-1 firing 20, 2026-10-10) — the
 * final_verdict guard_strike meta carried ONLY the finding kinds, so a
 * recurrence-2 adjudication of a struck final (the live de529489 pair:
 * runs 1e7716da 14:04:46Z + 7f3da1c6 14:13:34Z, kinds ["unproven_completion"],
 * outcome "observed") needed 3 transcript pulls + a receipts pull to see WHAT
 * was struck — while the GuardVerdict already held the struck claim OBJECTS.
 *
 * THE FIX: guardStrikeClaimExcerpts(v) — pure, bounded — is wired into the
 * strike row's meta as `claims` (run-executor.ts), so a struck final's
 * excerpt is readable straight off the metrics surface.
 *
 * This suite pins the helper's CONTRACT:
 *  - every unproven / future-dated / block-claim excerpt carries its kind +
 *    the claim's final-answer line, capped at GUARD_STRIKE_EXCERPT_TEXT_CAP;
 *  - at most GUARD_STRIKE_EXCERPT_MAX excerpts survive (bound);
 *  - empty / absent classes are simply omitted (omit-when-empty: quote-only
 *    and kinds-only verdicts keep their old meta byte-identical);
 *  - partial/mocked verdicts (a GuardVerdict without the optional arrays)
 *    never throw — telemetry must not lose a final (guardError doctrine).
 */
// Boundary-mocked like the sibling guard suites (run-evidence-guard.carried.test.ts):
// logger + token manager are stubs so importing the guard module never runs the
// real env validation (parseEnv exits without DATABASE_URL/REDIS_URL/JWT_SECRET
// in this shell) — the REAL guard helper under test is pure and needs neither.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../github/token-manager', () => ({
  __esModule: true,
  getValidToken: jest.fn(async () => null),
}));

import {
  guardStrikeClaimExcerpts,
  GUARD_STRIKE_EXCERPT_TEXT_CAP,
  GUARD_STRIKE_EXCERPT_MAX,
  type GuardVerdict,
} from './run-evidence-guard';

const baseVerdict = (): GuardVerdict => ({
  unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [],
});

describe('guardStrikeClaimExcerpts (ticket d2a1fa00 — strike meta observability)', () => {
  it('returns [] for clean, undefined and null verdicts — omit-when-empty keeps clean strikes kinds-only', () => {
    expect(guardStrikeClaimExcerpts(baseVerdict())).toEqual([]);
    expect(guardStrikeClaimExcerpts(undefined)).toEqual([]);
    expect(guardStrikeClaimExcerpts(null)).toEqual([]);
  });

  it('carries kind + capped claim text for the three excerpt-bearing classes (the de529489 adjudication surface)', () => {
    const v = baseVerdict();
    v.unprovenKinds = ['pr_merged'];
    v.unprovenClaims = [{ kind: 'pr_merged', prNumber: 224, text: 'Plan 6/6 — CLOSED. PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0.' }];
    v.futureDated = ['2026-10-10T23:59:00Z'];
    v.futureDatedClaims = [{ text: 'deployHealth healthy, checkedAt 2026-10-10T23:59:00Z', stamp: '2026-10-10T23:59:00Z', aheadMs: 42 }];
    v.unverifiedBlockClaims = ['probe — no matching receipt'];
    const out = guardStrikeClaimExcerpts(v);
    expect(out).toEqual([
      { kind: 'pr_merged', text: 'Plan 6/6 — CLOSED. PR #224 squash-merged at 4:19:21 AM, sha 84fe3ae0.' },
      { kind: 'future_dated', text: 'deployHealth healthy, checkedAt 2026-10-10T23:59:00Z' },
      { kind: 'unverified_block_claim', text: 'probe — no matching receipt' },
    ]);
    // All within the cap.
    for (const c of out) expect(c.text.length).toBeLessThanOrEqual(GUARD_STRIKE_EXCERPT_TEXT_CAP);
  });

  it('caps claim text at GUARD_STRIKE_EXCERPT_TEXT_CAP and bounds the list at GUARD_STRIKE_EXCERPT_MAX', () => {
    const v = baseVerdict();
    const long = 'x'.repeat(GUARD_STRIKE_EXCERPT_TEXT_CAP * 3);
    v.unprovenKinds = ['probe'];
    v.unprovenClaims = Array.from({ length: GUARD_STRIKE_EXCERPT_MAX + 4 }, (_, i) => ({ kind: 'probe' as const, text: `claim line ${i} ${long}` }));
    const out = guardStrikeClaimExcerpts(v);
    expect(out.length).toBe(GUARD_STRIKE_EXCERPT_MAX);
    for (const c of out) {
      expect(c.text.length).toBe(GUARD_STRIKE_EXCERPT_TEXT_CAP);
      expect(c.kind).toBe('probe');
    }
  });

  it('skips blank/whitespace texts and never throws on a mocked verdict missing the optional arrays', () => {
    const v: any = { unprovenKinds: ['pr_merged'], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], unprovenClaims: [{ kind: 'pr_merged', text: '   ' }] };
    expect(guardStrikeClaimExcerpts(v)).toEqual([]);
    const bare: any = { unprovenKinds: ['pr_merged'], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] };
    expect(guardStrikeClaimExcerpts(bare)).toEqual([]);
  });
});
