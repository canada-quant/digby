/**
 * Ticket c90958af round 2 — the SAME-RUN QUOTED HISTORICAL VERDICT class that
 * the landed fix (fddd77b25, PR #1723) did not cover.
 *
 * PRODUCTION REPLAY (2026-10-18, msg 334257bc, the 99145890 Gmail-attachments
 * lane): its final answer closes out a completed lifecycle and, per the
 * ticket-lane close-out template, audits the adversarial review:
 *
 *   "Round-1 verdict: **NOT-MERGE-SAFE** — manual legs (REST, tool, dedup,
 *    refactor equivalence, frontend, tests) verified; the auto-ingest rule
 *    refuted. All blocking findings fixed in commit **7cc860614** …"
 *
 * The run-outcome stamp on its run_completed digests read
 * VERDICT: NOT-MERGE-SAFE · BLOCKING: 0 (live at 08:06:37Z and 08:10:16Z,
 * AFTER the fddd77b25 deploy went fleet-live ~08:05Z — reproduced on fixed
 * code). fddd77b25's stripper covered two shapes only:
 *   - a parenthetical "verdict (DO NOT MERGE, …)";
 *   - a single sentence "returned NOT-MERGE-SAFE … findings were fixed"
 *     (auxiliary verb REQUIRED).
 * This lane's shape is neither: a round-attributed verdict sentence with the
 * resolution narration in the FOLLOWING sentence ("All blocking findings
 * fixed in commit X" — no auxiliary).
 *
 * The fix extends stripHistoricalVerdictAttributions: a NEGATIVE sentence
 * that names a PAST review round ("Round-1 verdict", "first-cut review
 * verdict", "the earlier review verdict") is history, not this run's veto,
 * when the findings are narrated as fixed/resolved in the same or the next
 * sentence. "Final verdict" is deliberately NOT an attribution marker — that
 * is the LIVE verdict's own title shape. Fail-closed is preserved: an
 * attributed negative with NO resolution cue still vetoes (a re-review that
 * is still adverse says "blocker stands", not "fixed").
 */
import { extractRunVerdict, buildRunOutcomeLine } from './run-outcome-line';

describe('ticket c90958af round 2 — round-attributed historical verdicts', () => {
  // The production sentence pair, shape-faithful (msg 334257bc, 2026-10-18).
  const PRODUCTION_SHAPE = [
    '### Independent adversarial review (sub-session 77e5ae56, fresh detached worktree, diff + claim manifest only)',
    '',
    'Round-1 verdict: **NOT-MERGE-SAFE** — manual legs (REST, tool, dedup, refactor equivalence, frontend, tests) verified; the auto-ingest rule refuted. All blocking findings fixed in commit **7cc860614** (squashed into the merge): **F1** hook was unreachable → now passes projectId/sessionId.',
    '',
    'The deliverable is on main and merged.',
  ].join('\n');

  it('REPLAY (msg 334257bc): a round-attributed verdict with adjacent resolution narration is history, not a veto', () => {
    expect(extractRunVerdict(PRODUCTION_SHAPE)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('REPLAY: the same text stamps n/a on the outcome line, not NOT-MERGE-SAFE', () => {
    const line = buildRunOutcomeLine({ outcome: 'completed', finalText: PRODUCTION_SHAPE });
    expect(line).toContain('VERDICT: n/a');
    expect(line).toContain('BLOCKING: 0');
  });

  it('resolution narration variants: auxiliary-less and addressed/resolved forms discount the verdict', () => {
    expect(extractRunVerdict(
      'Round-2 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'The first-cut review verdict: NOT-MERGE-SAFE. Every finding was addressed in the re-review round.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'The earlier review verdict: DO NOT MERGE. Both blocking findings have since been fixed.',
    ).verdict).toBe('n/a');
  });

  it('the landed shapes (fddd77b25) stay discounted', () => {
    expect(extractRunVerdict(
      'The review verdict (DO NOT MERGE, 3 blockers) is in the transcript from yesterday.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Adversarial review of the first cut returned NOT-MERGE-SAFE on three findings; every finding was fixed.',
    ).verdict).toBe('n/a');
  });

  // DETECTOR-RECALL REPLAY — the detector's PRIOR true positives must still
  // fire. Each pin below replays a shape that has convicted in production or
  // in a prior ticket's suite; if one stops firing, this change relaxed the
  // detector too far.
  it('DETECTOR-RECALL REPLAY: a reviewer lane DELIVERING an adverse verdict still stamps NOT-MERGE-SAFE', () => {
    // Production msg 16ad5f14 (2026-10-18): the review lane whose deliverable
    // WAS the adverse verdict — no round attribution, no resolution.
    expect(extractRunVerdict(
      'Deliverable (already delivered): Independent adversarial review of PR #1724 at head sha 86cd0b263, verdict NOT-MERGE-SAFE, sent to the requesting lane chat with receipt.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Findings + verdict delivered both places — F1-F11 each with severity/file:line/fix in the delivered report; verdict NOT-MERGE-SAFE in both.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY: live explicit and quoted negatives still veto', () => {
    expect(extractRunVerdict('Final verdict: "DO NOT MERGE"').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: DO NOT MERGE').verdict).toBe('NOT-MERGE-SAFE');
    // B1 (11a35cfb R4): own positive + a live quoted negative declines to
    // n/a, never MERGE-SAFE.
    expect(extractRunVerdict(
      'Reviewer wrote: "DO NOT MERGE". This patch is safe to merge.',
    ).verdict).toBe('n/a');
  });

  it('DETECTOR-RECALL REPLAY: an attributed negative with NO resolution cue still vetoes (fail-closed)', () => {
    // A re-review that is still adverse narrates standing blockers, not fixes.
    expect(extractRunVerdict(
      'Round-2 re-review verdict: NOT-MERGE-SAFE — blocker C stands, the wildcard lane is still uncovered.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Adversarial review returned NOT-MERGE-SAFE on three findings.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY: a LIVE veto after a discounted historical citation still vetoes', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. The current cut is DO NOT MERGE.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY: explicit VERDICT lines are untouched by the fallback stripper (da70e157 heading shape)', () => {
    expect(extractRunVerdict('## **VERDICT: BLOCK** — your two round-3 findings are now fixed, C holds').verdict)
      .toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('## **VERDICT: MERGE-SAFE** — the earlier NOT-MERGE-SAFE concern is fixed').verdict)
      .toBe('NOT-MERGE-SAFE');
  });

  it('"Final verdict" is never an attribution marker — the live title shape keeps its veto', () => {
    expect(extractRunVerdict(
      'The round-1 review had concerns. Final verdict: NOT-MERGE-SAFE.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('cleared round history alone (BLOCKED rounds, all fixed, no negative verdict) stays n/a — da70e157 contract unchanged', () => {
    expect(extractRunVerdict([
      '## Deliverable — built and reviewed',
      '- **Round 1 → BLOCKED**: 2 blockers — all fixed in commit abc1234.',
      '- **Round 2 → 1 new blocker**: fixed in commit def5678.',
      'All remaining steps verified against primary sources.',
    ].join('\n'))).toEqual({ verdict: 'n/a', blocking: 0 });
  });
});

describe('ticket c90958af round 3 — adversarial review msg d78f4850 (chat 36b1d622), 3 blocking findings', () => {
  /**
   * VERDICT: NOT-MERGE-SAFE — every repro below is quoted from the review and
   * was reproduced pre-fix (13/19 rows failing in this lane's own probe
   * battery, tmp/probe-d78f4850.ts). F1: standing/regressed narration outside
   * the VERDICT sentence (in the resolution sentence or the one after it) was
   * ignored — the guard tested only the verdict sentence. F2: STANDING
   * vocabulary gaps ("blocker C stands", "remains unfixed", "the findings
   * stand", "unresolved") and the "re-review" attribution form. F3: the
   * conditional-positive arm of NEGATIVE_RE accepted only a dash/space, so
   * "MERGE-SAFE, provided CI is green" / "(pending CI)" / "safe to merge once"
   * flipped a discounted-history answer to MERGE-SAFE.
   *
   * Round-3 SUPERSession note (review 528da78a, finding 2): the
   * "re-review" attribution WIDENING that fixed F2's accident is itself
   * REVERTED — it discounted LIVE re-review verdicts. The pins below keep
   * passing after the revert because the standing vocabulary F2 added
   * ("blocker C stands" in the identifier slot, "still uncovered") fires
   * the window guard — which is how a live adverse re-review actually
   * writes. The re-review TITLE form itself is pinned in the round-4
   * block below.
   */

  it('F1: standing narration inside the RESOLUTION sentence kills the discount (live veto preserved)', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All findings were fixed in commit abc1234, with the exception of F3, which remains open.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234, all but one — F2 regressed on re-derivation.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234, except blocker C, which remains unfixed.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F1: standing narration in the sentence AFTER the resolution kills the discount', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. Blocker C remains open at head sha 86cd0b263.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in abc1234. However F4 was regressed by the merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in abc1234. The wildcard lane is still broken.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in abc1234. F7 is still a blocker.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-2 verdict: NOT-MERGE-SAFE. All findings were fixed in abc1234, but the findings stand as written.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234, yet the blocker is unresolved.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F2: the re-review attribution form is pinned, with and without a discount attempt', () => {
    // The existing pin's shape — held before only because "still uncovered"
    // fired; now ALSO because "re-review" matches the attribution itself.
    expect(extractRunVerdict(
      'Round-2 re-review verdict: NOT-MERGE-SAFE — blocker C stands, the wildcard lane is still uncovered.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // The reviewer's accident trace: attribution now matches, standing vocab
    // ("blocker C stands", identifier slot) now fires — no discount.
    expect(extractRunVerdict(
      'Round-2 re-review verdict: NOT-MERGE-SAFE — blocker C stands. All blocking findings were fixed in commit abc1234.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // The bare "blocker C stands" shape WITHOUT the re- prefix.
    expect(extractRunVerdict(
      'Round-2 verdict: NOT-MERGE-SAFE — blocker C stands. All blocking findings were fixed in commit abc1234.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F3: conditional positives in punctuation forms the old arm missed read NOT-MERGE-SAFE, never MERGE-SAFE', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. This is MERGE-SAFE, provided CI is green.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. The patch is safe to merge once CI is green.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. Verdict is MERGE-SAFE (pending CI).',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // The dash/space form the old arm already covered (control).
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. The patch is merge-safe once CI is green.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // The sentence-boundary doctrine stands (f5bdeaf3, unchanged by this
    // fix — it read MERGE-SAFE before the fix too): "MERGE-SAFE. Once CI…"
    // does NOT trip the conditional lane because "." is deliberately absent
    // from the tolerated punctuation class. This pin guards the boundary of
    // the F3 widening: only [,;:()]—dash/space forms join the conditional
    // arm, never a period.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. This is MERGE-SAFE. Once CI is green we ship.',
    ).verdict).toBe('MERGE-SAFE');
  });

  it('F1 controls: a clean resolution with NO standing narration still discounts (the ticket case and variants)', () => {
    // The production replay (msg 334257bc shape) — unchanged by the fix.
    expect(extractRunVerdict([
      '### Independent adversarial review (sub-session 77e5ae56, fresh detached worktree, diff + claim manifest only)',
      '',
      'Round-1 verdict: **NOT-MERGE-SAFE** — manual legs (REST, tool, dedup, refactor equivalence, frontend, tests) verified; the auto-ingest rule refuted. All blocking findings fixed in commit **7cc860614** (squashed into the merge): **F1** hook was unreachable → now passes projectId/sessionId.',
      '',
      'The deliverable is on main and merged.',
    ].join('\n'))).toEqual({ verdict: 'n/a', blocking: 0 });
    expect(extractRunVerdict(
      'Round-2 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234.',
    ).verdict).toBe('n/a');
    // Resolution in the same sentence, then clean following sentences.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. The deliverable merged and the deploy wave is green.',
    ).verdict).toBe('n/a');
    // The landed fddd77b25 `returned` shape with a clean following sentence.
    expect(extractRunVerdict(
      'Adversarial review of the first cut returned NOT-MERGE-SAFE on three findings; every finding was fixed. The re-probe is green.',
    ).verdict).toBe('n/a');
  });

  it('F2 residual (X1): an except-carve-out with "still stands" in the resolution sentence vetoes; benign "still stands" does not', () => {
    // Reviewer battery X1: "except F2 which still stands at head" — standing
    // narration inside the resolution sentence, the F1 class in a shape the
    // noun-adjacent arms miss. The finding-tag window (\bF\d{1,3}\b … still
    // stands?) covers it; a benign "still stands" (test suite / compromise)
    // must NOT veto.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234, except F2 which still stands at head.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. The test suite still stands at 1200 tests.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. The compromise still stands.',
    ).verdict).toBe('n/a');
  });
});

describe('ticket c90958af round 4 — adversarial review msg 528da78a (chat 36b1d622), 2 blocking findings', () => {
  /**
   * Round-2 re-review verdict on head 256c7399e: NOT-MERGE-SAFE — both
   * blocking findings are round-3 additions that over-DISCOUNT live
   * verdicts (the unsafe direction of this module's EXTRACTION BIAS
   * doctrine, run-outcome-line.ts:22-23). Every repro below is quoted
   * verbatim from the review; reproduced pre-fix in this lane's 4-way
   * battery (tmp/probe-528da78a.cjs — B0 main / B1 017510e13 / B2
   * 256c7399e / B3 the fix).
   *
   * Finding 1 — RESOLUTION_CUE_RE noun expansion: the generic nouns
   * "issues"/"concerns" (added to both arms in round 3) let a
   * DIFFERENT-TOPIC resolution discount a verdict sentence. Reverted:
   * only finding/blocker nouns count; unrecognized resolution nouns fail
   * closed. "issues" in the QUANTIFIED arm 1 predates round 3 (adjudicated
   * by the round-1 review) and is kept.
   *
   * Finding 2 — PAST_ROUND_ATTRIBUTION_RE re-review widening: making the
   * `re-` prefix optional meant the LIVE re-review's own title shape
   * ("Round-2 re-review verdict: …") matched the historical-attribution
   * regex, so a standard fix→re-review cycle that reports round-1 fixed
   * AND new findings lost its veto — the exact lifecycle of this ticket.
   * Reverted: the re-review title is a LIVE title; it survives on its own
   * title, no standing narration needed. (The round-3 F2 pins keep
   * passing via the standing vocabulary — the reviewer itself noted the
   * widening was unnecessary for them.)
   */
  it('N1/N5: different-topic resolutions ("lint/docs issues") never discount a verdict sentence', () => {
    // Verbatim from the review (M6/N1, N5) — pre-existing at 017510e13,
    // regressed at 256c7399e to n/a.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE. The lint issues were fixed in commit abc1234.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE. The docs issues were fixed in PR #1730.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('N2: different-topic resolution + own-positive prose never flips to MERGE-SAFE', () => {
    // Verbatim from the review — the UNSAFE FLIP: NOT-MERGE-SAFE → MERGE-SAFE
    // at 256c7399e. "clean and safe to merge" is unconditional own-positive
    // prose over an undiscounted veto — must stay NOT-MERGE-SAFE.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE. The lint issues were fixed in commit abc1234. The current cut is clean and safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('NOUN CONTROLS: finding/blocker resolutions still discount — the ticket case is unchanged', () => {
    // The kept noNoun configuration (the reviewer's own counterfactual
    // bundle-r2-noNoun.cjs): findings and blockers in both arms, plus the
    // adjudicated arm-1 "issues" (quantified only).
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. The findings were fixed in commit abc1234.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. The blockers were fixed in commit abc1234.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All issues were fixed in commit abc1234.',
    ).verdict).toBe('n/a');
    // The production ticket shape (msg 334257bc) — the reason this lane exists.
    expect(extractRunVerdict([
      '### Independent adversarial review (sub-session 77e5ae56, fresh detached worktree, diff + claim manifest only)',
      '',
      'Round-1 verdict: **NOT-MERGE-SAFE** — manual legs (REST, tool, dedup, refactor equivalence, frontend, tests) verified; the auto-ingest rule refuted. All blocking findings fixed in commit **7cc860614** (squashed into the merge): **F1** hook was unreachable → now passes projectId/sessionId.',
      '',
      'The deliverable is on main and merged.',
    ].join('\n'))).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('RW-1/RW-2: a LIVE re-review verdict reporting round-1 fixed AND new findings keeps its veto', () => {
    // Verbatim from the review — the VETO LOST at 256c7399e. This is the
    // standard ticket lifecycle: the re-review confirms the round-1 fixes
    // and reports the NEW finding. The re-review title is the live
    // verdict's own title shape.
    expect(extractRunVerdict(
      'Round-2 re-review verdict: NOT-MERGE-SAFE — the fix introduced a new race in the latch path. The three round-1 blocking findings were fixed in 256c7399e.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-2 re-review verdict: NOT-MERGE-SAFE — the fix introduced a new race in the latch path. The three round-1 blocking findings were fixed in 256c7399e. The deploy is ready.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('R-C: a live re-review verdict + resolution narration + own-positive prose never flips to MERGE-SAFE', () => {
    // Verbatim from the review — UNSAFE FLIP #2 at 256c7399e.
    expect(extractRunVerdict(
      'Round-2 re-review verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. The patch is solid and merge-safe.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('R-B: a live re-review verdict whose findings are narrated fixed fails CLOSED (no standing narration)', () => {
    // Verbatim from the review — the fail-closed gap: the re-review title
    // is live, so its verdict is NOT history; the resolution narration
    // names no standing blocker, so nothing discounts it either. It keeps
    // the veto (over-veto in the safe direction is the documented bias).
    expect(extractRunVerdict(
      'Round-2 re-review verdict: NOT-MERGE-SAFE. All blocking findings were fixed in commit abc1234.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('REVIEW-TITLE CONTROLS: plain "Round-N verdict" stays historical (documented round-blindness); live titles stay live', () => {
    // Round-blindness is intentional (d78f4850 advisory 1): a PLAIN
    // "Round-N verdict" citation with resolution narration is history.
    expect(extractRunVerdict(
      'Round-2 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234.',
    ).verdict).toBe('n/a');
    // "Final verdict" and a bare "VERDICT:" line are live titles — never
    // discounted, with or without resolution narration.
    expect(extractRunVerdict(
      'Final verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: DO NOT MERGE').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('RESIDUAL (documented): historical "earlier re-review verdict" + resolution fails CLOSED — the `re-` prefix blocks the attribution match', () => {
    // Review 528da78a finding 2's revert side effect: "earlier re-review
    // verdict" IS genuinely historical, but the re- prefix now prevents the
    // attribution match, so nothing discounts it. Fail-closed is the safe
    // direction (run-outcome-line.ts:22-23 doctrine) and this is identical
    // to the round-1-reviewed head 017510e13 — pinned so the residual is
    // documented, not discovered.
    expect(extractRunVerdict(
      'The earlier re-review verdict: NOT-MERGE-SAFE. All findings were fixed in commit abc1234.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // A LIVE re-review whose resolution uses the arm-1 "issues" noun also
    // fails closed (live titles never discount; the issues noun only counts
    // under a plain Round-N citation).
    expect(extractRunVerdict(
      'Round-2 re-review verdict: NOT-MERGE-SAFE on three findings. All issues were fixed in commit abc1234.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('ACCEPTANCE #2 (supervisor instance, chat db331d3e msg 04320233, 12:48Z): "Zero injection failures" on a POSITIVE verdict line is an absence, never a BLOCK-family negative', () => {
    // A read-only post-deploy E2E probe's final answer — its VERDICT line
    // says the fix is verified working. The FAIL family matched the bare
    // "FAILURES" tail and prod stamped NOT-MERGE-SAFE over a POSITIVE
    // verdict. The affirmative quantifier + bounded modifiers (up to two
    // lowercase words) + family noun is now recognized as an absence.
    expect(extractRunVerdict(
      '**VERDICT: fix verified working in a fresh post-deploy session. X/20 = 20/20 — every one of 20 separate fresh-shell reads returned aklen=20 sklen=40. NOTICE SEEN: YES. Zero injection failures.**',
    ).verdict).toBe('MERGE-SAFE');
    // Bounded modifiers cover the natural variants.
    expect(extractRunVerdict('VERDICT: PASS — zero lint failures found').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: no merge blockers').verdict).toBe('MERGE-SAFE');
    // The re-test guard replaces EVERY absence span ("no blockers, no
    // vetoes" — the second absence used to resurrect the family word).
    expect(extractRunVerdict('VERDICT: no blockers, no vetoes').verdict).toBe('MERGE-SAFE');
    // Fail-closed guards: NOT fires upstream of the absence lane
    // (NEGATIVE_RE and the \bNOT\b test run first), a live BLOCK keeps its
    // veto, and a co-present live blocker phrase wins over the absence.
    expect(extractRunVerdict('VERDICT: not all failures fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: not all blockers fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: two blockers remain, zero failures elsewhere').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: BLOCK — structurally defeated').verdict).toBe('NOT-MERGE-SAFE');
    // Pre-existing absence contracts unchanged.
    expect(extractRunVerdict('VERDICT: 0 FAIL').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: NO BLOCKING ISSUES').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: BLOCKING ISSUES RESOLVED').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: BLOCK — G1/G2/G3 ADDRESSED').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('ACCEPTANCE #3 (supervisor instance, chat e75c538c msg 8e713334, 12:55Z — FIXED by ticket 3c354a95, porting the 8071c98f round-5 arms): a citation-relay historical review verdict with a noun-less "Fixed this run:" resolution and gate-regression proof narration no longer stamps NOT-MERGE-SAFE over the merged close-out', () => {
    // Root cause (mechanically isolated by the c90958af lane): the relay
    // sentence "Adversarial review (sub-session db3a6628, diff + claim
    // manifest only): verdict NOT-MERGE-SAFE with one blocking finding"
    // carries NO round marker, so PAST_ROUND_ATTRIBUTION_RE never matched;
    // the resolution "Fixed this run: DAY2 rows re-dated + non-vacuity
    // assertions" names no finding/blocker noun, so RESOLUTION_CUE_RE
    // never matched; and "regression" fired STANDING_BLOCKER_RE in BOTH
    // the historical narration ("a pre-N1 gate regression passed 59/59")
    // and the fix's own proof ("the pre-N1 regression now FAILS the
    // suite"). The lane pinned this as the documented residual and filed
    // follow-up 8071c98f, whose round-5 branch
    // (digby/session-fc74fc86 @ b4d599b36) landed the reviewed arms that
    // ticket 3c354a95 ports onto main.
    // FIXED: the citation-colon grammar joins the attribution set
    // (CITATION_RELAY_ATTRIBUTION_RE), the noun-less "Fixed this run:" cue
    // WITH proof co-presence joins the resolution set, and the
    // mutation-qualified gate narration is carved from the standing-guard
    // window test. The digest over this close-out now reads n/a · 0 — no
    // false NOT-MERGE-SAFE over "fixed, reviewed, merged — PR #1745".
    expect(extractRunVerdict([
      '## Deliverable: ticket 7b2990fa fixed, reviewed, merged — PR #1745 (squash `0e1316b4` on main)',
      '',
      'Adversarial review (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding — my faithful mock had silently vacated the pre-existing N1 actionability-gate pin (reviewer mutation-proved a pre-N1 gate regression passed 59/59). Fixed this run: DAY2 rows re-dated + non-vacuity assertions; my mutation re-check confirms the pre-N1 regression now FAILS the suite (1 failed / 59) while clean runs pass 59/59.',
    ].join('\n'))).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('ADVISORY-6 pins: the known benign conditional/F-tag over-vetoes are accepted (safe direction, documented)', () => {
    // Review advisory 6: these benign shapes over-veto after the round-3
    // F3/F2 widenings. Over-veto is the SAFE direction (a false
    // NOT-MERGE-SAFE costs a re-read; a false MERGE-SAFE merges over a
    // blocking finding). Pinned so a future change that silently flips
    // them to MERGE-SAFE/n/a is caught.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. This is MERGE-SAFE: if you need the numbers, see the table.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. The patch is safe to merge, assuming the reviewer agrees.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. The F2 fixture still stands at 40 tests.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // The benign controls the reviewer verified still pass (n/a).
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. The test suite still stands at 1200 tests.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. The compromise still stands.',
    ).verdict).toBe('n/a');
  });
});
