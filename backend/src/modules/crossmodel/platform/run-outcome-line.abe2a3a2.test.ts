/**
 * Ticket abe2a3a2 — the run-outcome verdict strip dropped LIVE parenthetical
 * NOT-MERGE-SAFE vetoes (PR #1723 review finding F4).
 *
 * PRODUCTION REPLAY: stripHistoricalVerdictAttributions (added by fddd77b25's
 * c90958af/cf2601d5 half) opened with a bare parenthetical strip —
 * `/((?:review\s+)?verdict\s*\([^)]{0,200}\)/gi` — that required NO
 * attribution grammar at all. A LIVE verdict written in the platform's own
 * parenthetical veto shape lost its token before the whole-text negative
 * scan ever ran:
 *
 *   buildRunOutcomeLine('Final verdict (DO NOT MERGE): two blocking findings
 *   in the diff.')
 *     pre-fix  → RUN_OUTCOME: completed · VERDICT: n/a · BLOCKING: 2
 *     post-fix → RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 2
 *
 * Re-verified this lane on current main (7949009f3) with a direct module
 * probe before the fix: n/a; after: NOT-MERGE-SAFE. The veto was LOST, not
 * inverted (n/a is the fail-open residue, but a supervisor steering by the
 * stamp no longer sees the veto — the exact signal loss the own-words and
 * relay rules exist to prevent).
 *
 * THE FIX: the bare parenthetical strip is DELETED. A parenthetical is
 * stripped only when the sentence itself attributes it to the transcript —
 * the surviving `\(…\) is/was/were in the transcript` grammar (fddd77b25's
 * own pinned production shape). "Final verdict" is the LIVE verdict's title
 * shape (the c90958af round-2 contract already pins that), so
 * `Final verdict (DO NOT MERGE): …` keeps its voice. Fail-closed direction
 * preserved: a historical citation that escapes the strip costs a false
 * NOT-MERGE-SAFE (one transcript pull); a dropped live veto could merge over
 * a blocking finding.
 */
import { extractRunVerdict, buildRunOutcomeLine } from './run-outcome-line';

describe('ticket abe2a3a2 — live parenthetical verdict vetoes survive the strip', () => {
  // The ticket's exact repro probe (PR #1723 review finding F4).
  it('REPLAY: a LIVE parenthetical DO NOT MERGE veto stamps NOT-MERGE-SAFE, not n/a', () => {
    expect(extractRunVerdict('Final verdict (DO NOT MERGE): two blocking findings in the diff.'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });

  it('REPLAY: the same text on the outcome line — the veto is front-loaded, not lost', () => {
    const line = buildRunOutcomeLine({
      outcome: 'completed',
      finalText: 'Final verdict (DO NOT MERGE): two blocking findings in the diff.',
    });
    expect(line).toContain('VERDICT: NOT-MERGE-SAFE');
    expect(line).toContain('BLOCKING: 2');
  });

  it('live parenthetical veto variants: bare token, UNSAFE spelling, review-title form', () => {
    expect(extractRunVerdict('Final verdict (NOT-MERGE-SAFE): two blocking findings in the diff.').verdict)
      .toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict (UNSAFE TO MERGE): the latch path races.').verdict)
      .toBe('NOT-MERGE-SAFE');
    // The "review verdict" title form is ALSO live when nothing attributes it
    // to the transcript — the strip must not eat it either.
    expect(extractRunVerdict('Review verdict (DO NOT MERGE): the branch conflicts with main.').verdict)
      .toBe('NOT-MERGE-SAFE');
  });

  it('a live parenthetical veto still vetoes when the SAME answer carries a discounted historical citation', () => {
    expect(extractRunVerdict(
      'The review verdict (DO NOT MERGE, 3 blockers) is in the transcript from yesterday. Final verdict (DO NOT MERGE): the rebase reintroduced the race.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  // DETECTOR-RECALL REPLAY — the detector's PRIOR true positives must still
  // fire. Each pin below replays a shape that has convicted in production or
  // in a prior ticket's suite; if one stops firing, this change relaxed the
  // detector too far.
  it('DETECTOR-RECALL REPLAY: the transcript-attributed parenthetical citation still discounts to n/a (fddd77b25 pin)', () => {
    expect(extractRunVerdict(
      'The review verdict (DO NOT MERGE, 3 blockers) is in the transcript from yesterday.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'The verdict (NOT-MERGE-SAFE, 2 blockers) was in the transcript of the earlier round.',
    ).verdict).toBe('n/a');
  });

  it('DETECTOR-RECALL REPLAY: the round-attributed historical verdict shapes still discount (c90958af round 2)', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Adversarial review of the first cut returned NOT-MERGE-SAFE on three findings; every finding was fixed.',
    ).verdict).toBe('n/a');
  });

  it('DETECTOR-RECALL REPLAY: live explicit, quoted and plain-prose vetoes still veto', () => {
    expect(extractRunVerdict('VERDICT: DO NOT MERGE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: "DO NOT MERGE"').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: NOT-MERGE-SAFE.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. The current cut is DO NOT MERGE.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY: the da70e157 relay idiom — an ATTRIBUTED parenthetical relay keeps its carve-out, both directions', () => {
    // The pinned relay idiom (read-this-run attribution): the parenthetical
    // is the relay's own frame, and the quoted verdict inside still scans.
    expect(extractRunVerdict(
      '- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"** — every fix re-verified by the reviewer\'s own probes.',
    ).verdict).toBe('MERGE-SAFE');
    // The dangerous variant still never reads MERGE-SAFE (n/a fail-open).
    expect(extractRunVerdict(
      '- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: BLOCK — 2 blocking findings"**',
    ).verdict).toBe('n/a');
  });

  it('DETECTOR-RECALL REPLAY: "Final verdict" remains a LIVE title, never an attribution marker (c90958af pin)', () => {
    expect(extractRunVerdict(
      'The round-1 review had concerns. Final verdict: NOT-MERGE-SAFE.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
});
