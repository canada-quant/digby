/**
 * Ticket 8071c98f — the CITATION-RELAY misfire class (instance #3) and the
 * NOUN-MODIFIER usage misfire (the third in-wild instance), the two
 * remaining classes of "digest stamps NOT-MERGE-SAFE over a final answer
 * whose own verdict content is positive".
 *
 * SPECIMENS (all verified this lane by ablation probe on current main,
 * tmp/probe-8071c98f.ts — pre-fix reads quoted from that run):
 *   #3   chat e75c538c msg 8e713334 (12:55Z): citation-colon relay
 *        ("**Adversarial review** (sub-session db3a6628…): verdict
 *        NOT-MERGE-SAFE with one blocking finding") + noun-less
 *        "Fixed this run:" resolution + gate-regression narration →
 *        pre-fix { NOT-MERGE-SAFE, 1 }, deliverable "fixed, reviewed,
 *        merged — PR #1745".
 *   #3'  chat 3ad495e3 msg d8810422 (~14:35Z, post-deploy of c90958af's
 *        fix): the sole surviving veto carrier is the plain-prose noun
 *        modifier "live parenthetical NOT-MERGE-SAFE vetoes degrade to" —
 *        the verdict VALUE as a modifier of a plural noun while the lane
 *        discusses the stamping mechanism; the backticked probe-comparison
 *        relays are already masked as inline code → pre-fix
 *        { NOT-MERGE-SAFE, 0 }, deliverable "PR #1750 MERGED to main".
 *   #2  chat db331d3e msg 04320233 — the instance-#2 absence class, fixed
 *        by the landed c90958af fix (PR #1749): control row, must stay
 *        MERGE-SAFE.
 *
 * THE FIX (four arms, all inside run-outcome-line.ts):
 *   1. CITATION_RELAY_ATTRIBUTION_RE — the citation grammar "review (…):
 *      verdict" joins the attribution set of stripHistoricalVerdictAttributions.
 *   2. VERDICT_NOUN_MODIFIER_RE — a verdict value modifying a plural noun
 *      with a following verb ("NOT-MERGE-SAFE vetoes degrade to") is masked
 *      in the whole-text fallback lane ONLY.
 *   3. THIS_RUN_RESOLUTION_RE (+ THIS_RUN_PROOF_RE co-presence) — the
 *      noun-less "Fixed this run:" close-out cue joins the resolution set.
 *   4. REGRESSION_TEST_DOMAIN_RE / REGRESSION_GATE_NARRATION_RE —
 *      test-domain and verification-provenance gate narration are carved
 *      from the standing-blocker window test (never from the text itself).
 *
 * DETECTOR-RECALL REPLAY: every prior true-positive shape cited in this
 * file's DETECTOR-RECALL blocks and in the sibling suites must still fire.
 * If a pin below stops firing, this change relaxed the detector too far.
 */
import { extractRunVerdict, buildRunOutcomeLine } from './run-outcome-line';

describe('ticket 8071c98f — citation-relay close-out (instance #3, msg 8e713334)', () => {
  // The production specimen, shape-faithful (verbatim from the message).
  const SPECIMEN_A = [
    '## Deliverable: ticket 7b2990fa fixed, reviewed, merged — PR #1745 (squash `0e1316b4` on main)',
    '',
    '**Adversarial review** (independent sub-session `db3a6628`, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding — my faithful mock had silently vacated the pre-existing **N1 actionability-gate pin** (DAY2 second pass fetched 0 rows; reviewer mutation-proved a pre-N1 gate regression passed 59/59). **Fixed this run**: DAY2 rows re-dated + non-vacuity assertions (`rows 6`, `signals 1`); my mutation re-check confirms the pre-N1 regression now FAILS the suite (1 failed / 59) while clean runs pass 59/59.',
    '',
    'All 5 claims otherwise CONFIRMED against primary sources.',
  ].join('\n');

  it('REPLAY (msg 8e713334): the citation-relay close-out stamps n/a · 0, not NOT-MERGE-SAFE · 1', () => {
    expect(extractRunVerdict(SPECIMEN_A)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('REPLAY: the full production text (with bold, backticks and the whole close-out) stamps n/a on the outcome line', () => {
    const line = buildRunOutcomeLine({ outcome: 'completed', finalText: SPECIMEN_A });
    expect(line).toContain('VERDICT: n/a');
    expect(line).toContain('BLOCKING: 0');
  });

  it('the cited review\'s blocking count is not reported as this run\'s BLOCKING (the count tier scans the discounted view)', () => {
    // Pre-fix this stamped BLOCKING: 1 — "one blocking finding" inside the
    // discounted citation sentence fed BLOCKING_COUNT_STATEMENT_RE.
    expect(extractRunVerdict(SPECIMEN_A).blocking).toBe(0);
  });

  it('citation-grammar variants discount ONLY with the noun-less this-run close-out + topic link (review round 1 F3 + hardening round)', () => {
    // Hardening round: the nounless pairing additionally requires a
    // TOPIC-LINK OVERLAP — the proof's finding-domain object must be named
    // by the veto sentence too ("the N1 pin" resolves a veto that names the
    // pin). A veto phrased only generically ("two blocking findings") does
    // not establish the link and keeps its veto (IR3 pin).
    expect(extractRunVerdict(
      'Adversarial review (sub-session aabbccdd): verdict NOT-MERGE-SAFE with two blocking findings on the N1 pin. Fixed this run: DAY2 rows re-dated; my mutation re-check confirms the pin now fails.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Adversarial review: verdict NOT-MERGE-SAFE with one blocking finding in the sweep suite. Fixed this run: DAY2 rows re-dated; the mutation re-check confirms the suite fails on the old shape.',
    ).verdict).toBe('n/a');
  });

  it('BOUNDARY: a citation-relay verdict with NO resolution cue still vetoes (fail-closed)', () => {
    expect(extractRunVerdict(
      'Adversarial review (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('BOUNDARY: a citation-relay verdict with only a different-topic / unproven noun-less resolution fails CLOSED', () => {
    // No proof cue co-present — a bare work statement is not a close-out.
    expect(extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding. Fixed this run: docs updated.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('BOUNDARY: standing narration in the discount window still kills the discount', () => {
    expect(extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding. Fixed this run: DAY2 rows re-dated; the suite now passes 59/59. However blocker C remains open at head.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding. Fixed this run: DAY2 rows re-dated; the suite now passes 59/59, except F2 which remains unfixed.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('BOUNDARY: a bare pass/fail regression statement without verification provenance keeps its veto (the carve is provenance-bound)', () => {
    expect(extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding. Fixed this run: DAY2 rows re-dated; the suite now passes 59/59. The regression passed 59/59 at head.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('BOUNDARY: "regression test still fails" keeps its veto (test-domain carve does not swallow standing vocabulary)', () => {
    expect(extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding. Fixed this run: DAY2 rows re-dated; the suite now passes 59/59. The regression test still fails.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
});

describe('ticket 8071c98f — adversarial-review round-1 blocking findings (reviewer b1f8269e) — every repro pinned, every fix narrow', () => {
  it('F1 pin: "NOT-MERGE-SAFE findings remain at head" keeps its veto (the mask covers META-nouns only)', () => {
    expect(extractRunVerdict('NOT-MERGE-SAFE findings remain at head. This patch is ready to merge.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('The two NOT-MERGE-SAFE findings remain at head; the rest is clean.').verdict).toBe('NOT-MERGE-SAFE');
  });
  it('F2 pin: a different-topic noun-less resolution does not discount a round-attributed veto', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on the latch race. Fixed this run: docs updated; the suite passes 42/42.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('F3 pin (XR-1): a live reviewer deliverable with citation grammar and a NOUN-FUL resolution keeps its veto and count', () => {
    expect(extractRunVerdict(
      'Independent review (fresh context, diff + manifest only): verdict NOT-MERGE-SAFE — two blocking findings, these two are new. All blocking findings were fixed in commit abc1234.',
    )).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });
  it('F3 pin (XR-2): the re-review walk-around of the re- exclusion keeps its veto (lookbehind)', () => {
    expect(extractRunVerdict(
      'Adversarial re-review (round 2): verdict NOT-MERGE-SAFE — F1 stands. All findings were fixed in the final diff.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('F3 pin (XR-3): a reviewer deliverable with sub-session provenance and a noun-ful resolution keeps its veto', () => {
    expect(extractRunVerdict(
      'Independent adversarial review (sub-session b1f8269e, fresh context, diff + claim manifest only): verdict NOT-MERGE-SAFE with two blocking findings. All blocking findings were fixed by the author in commit abc1234.',
    )).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });
  it('F6 pin: a kept relay span still vetoes the own-positive fallback to n/a (the mask never touches relay carriers)', () => {
    expect(extractRunVerdict('Reviewer wrote: "NOT-MERGE-SAFE findings remain at head". This patch is safe to merge.').verdict).toBe('n/a');
  });
});

describe('ticket 8071c98f — adversarial-review round-2 blocking findings (reviewer b1f8269e) — polarity + topic-link guards', () => {
  it('F1′ pin: a provenance-marked regression that STILL FAILS AT HEAD is standing failure, not proof — keeps its veto under BOTH arms', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. My re-check confirms the regression fails at head. The rest of the patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. My re-check confirms the regression now FAILS the suite at head.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding. Fixed this run: attempted the fix; my re-check confirms the regression now FAILS the suite at head.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // The vacuous-pin standing confession shape.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. My re-check confirms the regression passed 59/59 at head. The rest of the patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // on-main present-state marker.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE. All blocking findings were fixed in commit abc1234. My mutation re-check confirms the regression fails on main. This patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('F1′ counter-pin: the specimen\'s own proof narration (FAILS the suite, no present-state marker) still discounts', () => {
    expect(extractRunVerdict(
      'Adversarial review (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding on the N1 actionability-gate pin (reviewer mutation-proved a pre-N1 gate regression passed 59/59). Fixed this run: DAY2 rows re-dated; my mutation re-check confirms the pre-N1 regression now FAILS the suite.',
    ).verdict).toBe('n/a');
  });
  it('F2′ pin: a different-topic re-check proof ("the docs build") fails closed under BOTH arms', () => {
    expect(extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding on the latch race. Fixed this run: docs updated; my re-check confirms the docs build. The patch is otherwise safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on the latch race. Fixed this run: docs updated; my re-check confirms the docs build. The patch is otherwise safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('A3′ pin: "Peer review:" with no third-party provenance token stays live (a reviewer\'s own heading)', () => {
    expect(extractRunVerdict(
      'Peer review: verdict NOT-MERGE-SAFE with one blocking finding. Fixed this run: DAY2 rows re-dated; my mutation re-check confirms the pin now fails.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('A3′ counter-pin: the specimen\'s provenance shapes ("Adversarial review (sub-session …):", "(independent sub-session …, diff + claim manifest only):") still discount with a topic link', () => {
    expect(extractRunVerdict(
      'Adversarial review (sub-session aabbccdd): verdict NOT-MERGE-SAFE with two blocking findings on the N1 pin. Fixed this run: DAY2 rows re-dated; my mutation re-check confirms the pin now fails.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Adversarial review (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding on the N1 pin. Fixed this run: DAY2 rows re-dated; my mutation re-check confirms the pin now fails.',
    ).verdict).toBe('n/a');
  });
});

describe('ticket 8071c98f — adversarial-review round-3 blocking findings (reviewer b1f8269e) — semantic guards: mutation qualifier + provenance content', () => {
  it('F1″ pin: a PLAIN re-check narrating a still-failing regression keeps its veto — enumerated "where" synonyms cannot bypass (the carve is mutation-qualified)', () => {
    // All reviewer round-3 F1″ repros: present-state synonyms outside any
    // enumerated list. The mutation qualifier is the load-bearing guard:
    // only a MUTATION-QUALIFIED check observes a guard catching a defect.
    for (const tail of [
      'fails at the new head',
      'fails at tip',
      'fails at the latest head',
      'fails at the current tip',
      'fails on the branch',
      'fails on the latest commit',
      'fails in the current build',
      'fails today',
    ]) {
      expect(extractRunVerdict(
        `Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. My re-check confirms the regression ${tail}. The rest of the patch is safe to merge.`,
      ).verdict).toBe('NOT-MERGE-SAFE');
    }
  });
  it('F1″ pin: one-sentence-away present-state marker also keeps its veto (citation arm, both halves)', () => {
    expect(extractRunVerdict(
      'Adversarial review (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding. Fixed this run: attempted the fix; my re-check confirms the regression now FAILS the suite at the new head. The patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. My re-check confirms the regression fails. At head the suite is red. The rest of the patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('F1″ counter-pin: the specimen\'s MUTATION-qualified proof still carves (both polarities)', () => {
    // The mutation check observes the PIN catching the defect — the
    // deliberate-break idiom — in either polarity.
    expect(extractRunVerdict(
      'Adversarial review (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding — reviewer mutation-proved a pre-N1 gate regression passed 59/59. Fixed this run: DAY2 rows re-dated; my mutation re-check confirms the pre-N1 regression now FAILS the suite.',
    ).verdict).toBe('n/a');
  });
  it('F2″ pin: a plain re-check of ANY other surface fails closed — generic verification vocabulary is not a topic link', () => {
    for (const proof of [
      'my re-check confirms the CI suite is green',
      'my re-check confirms the typecheck test passes',
      'my re-check confirms the lint check passes',
      'my re-check confirms the docs suite builds',
      'my re-check confirms the nightly suite is green',
      'my re-check confirms the unrelated vacuity assertions pass',
      'my re-verified checks all pass',
      'my re-run of the test suite is green',
    ]) {
      expect(extractRunVerdict(
        `Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding on the latch race. Fixed this run: docs updated; ${proof}. The patch is otherwise safe to merge.`,
      ).verdict).toBe('NOT-MERGE-SAFE');
      expect(extractRunVerdict(
        `Round-1 verdict: NOT-MERGE-SAFE on the latch race. Fixed this run: docs updated; ${proof}. The patch is otherwise safe to merge.`,
      ).verdict).toBe('NOT-MERGE-SAFE');
    }
  });
  it('F2″ counter-pin: the specimen\'s MUTATION re-check proof still discounts (the trailing own-positive then wins, exactly like specimen C)', () => {
    // Without the discount this reads NOT-MERGE-SAFE; with the mutation-
    // qualified proof the citation relay is history and the own-positive
    // "otherwise safe to merge" legitimately wins → MERGE-SAFE.
    const r = extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding on the N1 pin. Fixed this run: DAY2 rows re-dated; my mutation re-check confirms the pin now fails. The patch is otherwise safe to merge.',
    );
    expect(r.verdict).toBe('MERGE-SAFE');
  });
  it('A1″ pin: a non-provenance parenthetical does not satisfy the citation arm', () => {
    for (const head of ['Peer review (external):', 'Review (by me):', 'Review (via box A):', 'Review (round 1):']) {
      expect(extractRunVerdict(
        `${head} verdict NOT-MERGE-SAFE with one blocking finding. Fixed this run: DAY2 rows re-dated; my mutation re-check confirms the pin now fails.`,
      ).verdict).toBe('NOT-MERGE-SAFE');
    }
  });
  it('A1″ counter-pin: provenance-bearing parentheticals still discount with a topic link ("fresh context", "diff + claim manifest")', () => {
    expect(extractRunVerdict(
      'Independent review (fresh context): verdict NOT-MERGE-SAFE with one blocking finding on the N1 pin. Fixed this run: DAY2 rows re-dated; my mutation re-check confirms the pin now fails.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Adversarial review (diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding on the N1 pin. Fixed this run: DAY2 rows re-dated; my mutation re-check confirms the pin now fails.',
    ).verdict).toBe('n/a');
  });
});

describe('ticket 8071c98f — hardening round (independent cross-family review): verification-semantics composite + topic-link overlap', () => {
  it('IR1 pin: a BARE mutation NOUN is not a proof — failing/absent/negated/queued/stale/pointer text keeps its veto', () => {
    for (const proof of [
      'without a mutation run the gate is unproven',
      'the mutation run is failing',
      'the mutation proof is still missing',
      'the mutation check is red',
      'a mutation check is queued for tomorrow',
      'mutation verified last week',
      'see the attached mutation proof',
      'the nightly mutation run is green',
    ]) {
      expect(extractRunVerdict(
        `Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding. Fixed this run: docs updated; ${proof}.`,
      ).verdict).toBe('NOT-MERGE-SAFE');
    }
  });
  it('R4-F2 pin: "My mutation run observed the regression fails" keeps its veto (the run|re-run noun head is out of the gate carve)', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. My mutation run observed the regression fails. The rest of the patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('R4-topic pin: a mutation re-check of a DIFFERENT finding (the N1 pin over a latch-race veto) keeps its veto — topic-link overlap required', () => {
    expect(extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding on the latch race. Fixed this run: docs updated; my mutation re-check confirms the N1 pin now fails. The patch is otherwise safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('R4-locator pin: present-state localizers behind the mutation qualifier keep their vetoes', () => {
    for (const tail of ['on the fix branch', 'after the rebase', 'in the deployed build', 'on the rebased branch', 'since the rebase']) {
      expect(extractRunVerdict(
        `Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. My mutation re-check confirms the regression fails ${tail}. The rest of the patch is safe to merge.`,
      ).verdict).toBe('NOT-MERGE-SAFE');
    }
  });
  it('R4-polarity pin: "regression failed again" keeps its veto', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. My mutation re-check confirms the regression failed again. The rest of the patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('IR2 pin: the test-domain carve does not swallow standing vacuity narration', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on the vacuous pin. All blocking findings were fixed in commit abc1234; the regression test passes vacuously.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234; the regression test broke.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234; the regression test is vacuous.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('IR3 pin: a reviewer deliverable whose nounless resolution proof names a finding the veto did NOT name keeps its veto (topic-link overlap)', () => {
    expect(extractRunVerdict(
      'Adversarial review (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with two blocking findings in the diff. Fixed this run: my mutation re-check confirms the pin now fails.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('IR1 counter-pin: the specimen\'s composite proof (mutation re-check + confirms + the pre-N1 regression) still discounts', () => {
    // The topic-link overlap holds here: the veto sentence names the
    // "actionability-gate pin" and the proof names the pin/regression.
    expect(extractRunVerdict(
      'Adversarial review (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding — my faithful mock had silently vacated the pre-existing N1 actionability-gate pin (reviewer mutation-proved a pre-N1 gate regression passed 59/59). Fixed this run: DAY2 rows re-dated + non-vacuity assertions; my mutation re-check confirms the pre-N1 regression now FAILS the suite (1 failed / 59) while clean runs pass 59/59.',
    )).toEqual({ verdict: 'n/a', blocking: 0 });
  });
});

describe('ticket 8071c98f — noun-modifier verdict usage (third in-wild instance, msg d8810422)', () => {
  // The sighting sentence from the production specimen, verbatim.
  const SIGHTING = 'Plus sighting ticket **abe2a3a2-332f-4944-856d-20ae156a7871** filed for the separate run-outcome-line defect (live parenthetical NOT-MERGE-SAFE vetoes degrade to `n/a` — the c90958af half of PR #1723, verified by probe: pre `VERDICT: NOT-MERGE-SAFE · BLOCKING: 2` → post `VERDICT: n/a · BLOCKING: 2`; NOT this lane\'s concern per one-concern-per-PR).';

  it('REPLAY (msg d8810422): the noun-modifier sighting sentence alone declines to n/a, never vetoes', () => {
    expect(extractRunVerdict(SIGHTING)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('REPLAY: the full production close-out reads MERGE-SAFE over the sighting (its own verdict content is positive)', () => {
    // Abridge: headline + sighting + the reviewer-positive verification.
    const full = [
      '## Deliverable',
      '',
      '**PR #1750 MERGED to main** (squash sha `f6cb7621120c`, merge receipt: "MERGED canada-quant/digby#1750 — confirmed merged:true by follow-up GET").',
      '',
      SIGHTING,
      '',
      'Reviewer (delegate, fresh context) verdict **MERGE-SAFE**; its findings F1, F2, F3 were all fixed in commit `c9536882` and probe-verified.',
    ].join('\n');
    expect(extractRunVerdict(full)).toEqual({ verdict: 'MERGE-SAFE', blocking: 0 });
  });

  it('usage variants: the value as a modifier of a META-noun with a degrade/read verb is masked in the fallback lane only', () => {
    // Review round 1, finding F1: the noun list is META-NOUNS ONLY
    // (vetoes/stamps/markers/verdicts/tokens — verdict-shaped TEXT, not
    // findings), the verb list is DEGRADATION-TO-VALUE verbs only
    // (degrade to / read as). "NOT-MERGE-SAFE findings remain at head" is
    // a LIVE veto and keeps its voice (pinned below).
    expect(extractRunVerdict('The NOT-MERGE-SAFE vetoes degrade to n/a after the fix.').verdict).toBe('n/a');
    expect(extractRunVerdict('Live parenthetical NOT-MERGE-SAFE verdicts degrade to n/a in the old build.').verdict).toBe('n/a');
    expect(extractRunVerdict('The DO NOT MERGE stamps degrade to n/a when the fix lands.').verdict).toBe('n/a');
    // REVIEW FIX F2-EXT (3c354a95 review): a VISIBLE non-n/a outcome after
    // "degrade to" is what a LIVE veto reported as ignored looks like —
    // the mask no longer erases it.
    expect(extractRunVerdict("The reviewer's DO NOT MERGE vetoes degrade to nothing; the build is merge-safe.").verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('The two NOT-MERGE-SAFE verdicts read as final: C1 the latch race is unresolved.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('BOUNDARY: a true veto sentence keeps its voice — the mask requires the plural-noun + verb class shape', () => {
    // An actual veto: the value is the sentence's own assertion.
    expect(extractRunVerdict('The current cut is NOT-MERGE-SAFE.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('DO NOT MERGE vetoes the merge.').verdict).toBe('NOT-MERGE-SAFE');
    // Singular noun usage is not the class shape — keeps its veto (the safe
    // direction; a singular "veto" is more likely the value's own voice).
    expect(extractRunVerdict('The NOT-MERGE-SAFE veto stands.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('BOUNDARY: an explicit VERDICT line is never masked by the fallback usage arm (tier precedence)', () => {
    expect(extractRunVerdict('VERDICT: NOT-MERGE-SAFE — the two vetoes degrade the signal.').verdict).toBe('NOT-MERGE-SAFE');
  });
});

describe('ticket 8071c98f — DETECTOR-RECALL REPLAY (prior true positives must still fire)', () => {
  it('DETECTOR-RECALL REPLAY: the reviewer lane DELIVERING an adverse verdict (msg 16ad5f14) still stamps NOT-MERGE-SAFE', () => {
    // Production msg 16ad5f14 (2026-10-18): no citation grammar — the
    // reviewer lane's own deliverable IS the verdict. The citation-colon
    // arm must not touch it.
    expect(extractRunVerdict(
      'Deliverable (already delivered): Independent adversarial review of PR #1724 at head sha 86cd0b263, verdict NOT-MERGE-SAFE, sent to the requesting lane chat with receipt.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY: the round-attributed history arms (c90958af) keep their contracts', () => {
    // The production replay (msg 334257bc) — discounted as history.
    const replay = extractRunVerdict([
      'Round-1 verdict: **NOT-MERGE-SAFE** — manual legs verified. All blocking findings fixed in commit **7cc860614**.',
    ].join('\n'));
    expect(replay).toEqual({ verdict: 'n/a', blocking: 0 });
    // Live titles keep their veto.
    expect(extractRunVerdict('Final verdict: NOT-MERGE-SAFE. All findings were fixed.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: DO NOT MERGE').verdict).toBe('NOT-MERGE-SAFE');
    // Re-review live title — the R-B/RW contracts.
    expect(extractRunVerdict(
      'Round-2 re-review verdict: NOT-MERGE-SAFE. All blocking findings were fixed in commit abc1234.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // Standing narration kills every discount.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. However F4 was regressed by the merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // Different-topic resolutions never discount (528da78a finding 1).
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE. The lint issues were fixed in commit abc1234.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // A LIVE veto after a discounted historical citation still vetoes.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. The current cut is DO NOT MERGE.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY: benign standing shapes stay benign (over-discount would flip these to NOT-MERGE-SAFE)', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. The test suite still stands at 1200 tests.',
    ).verdict).toBe('n/a');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. The compromise still stands.',
    ).verdict).toBe('n/a');
  });

  it('DETECTOR-RECALL REPLAY: the instance-#2 absence class (msg 04320233) stays fixed — landed contract', () => {
    expect(extractRunVerdict(
      '**VERDICT: fix verified working in a fresh post-deploy session. X/20 = 20/20 — every one of 20 separate fresh-shell reads returned aklen=20 sklen=40. NOTICE SEEN: YES. Zero injection failures.**',
    ).verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: not all failures fixed').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY: quoted/relay contracts (11a35cfb / da70e157) keep their voices', () => {
    // The pinned relay idiom — a colon-introduced quoted verdict still relays.
    expect(extractRunVerdict('Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"').verdict).toBe('MERGE-SAFE');
    // A quoted negative declines the own-positive fallback to n/a (B1).
    expect(extractRunVerdict('Reviewer wrote: "DO NOT MERGE". This patch is safe to merge.').verdict).toBe('n/a');
    // An explicit heading BLOCK stays NOT-MERGE-SAFE.
    expect(extractRunVerdict('## **VERDICT: BLOCK** — 2 blocking findings').verdict).toBe('NOT-MERGE-SAFE');
    // A live quoted negative with standing narration.
    expect(extractRunVerdict('Final verdict: "NOT-MERGE-SAFE" — C2 regressed.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY: abe2a3a2\'s landed fix governs the sibling shape — pinned to the MERGED-MAIN reading', () => {
    // abe2a3a2 (PR #1758, main f44a0105e) deleted the bare `verdict (…)`
    // parenthetical strip: "Final verdict (DO NOT MERGE): two blocking
    // findings in the diff." now stamps NOT-MERGE-SAFE · 2 (the live veto
    // survives). Pre-#1758 this lane pinned the OLD n/a reading; the peer
    // lane's fix flipped it and coordinated the update. Verified
    // empirically on the rebased branch this run.
    expect(extractRunVerdict(
      'Final verdict (DO NOT MERGE): two blocking findings in the diff.',
    )).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });
});

describe('ticket 8071c98f — COND-2/3/4 pins (round-3 reviewer advisory, fold decision)', () => {
  // The round-3 reviewer (msg bc3255b7) flagged that at B4 (the landed
  // c90958af fix) a new-arm absence + a condition word reads MERGE-SAFE
  // where B3 read NOT-MERGE-SAFE, and recommended pinning whichever
  // behavior is intended. Fold decision (this lane): pin the LANDED B4
  // behavior — the adjacent pre-existing form already read MERGE-SAFE at
  // B0/B3, the module's existing design accepts the shape, and no live
  // unconditional veto inverts anywhere. These pins make that decision
  // explicit so a future change flipping them is caught.
  it('COND-1 (pre-existing adjacent form): "zero blockers, provided the race is fixed" reads MERGE-SAFE — pinned as intended', () => {
    expect(extractRunVerdict('VERDICT: zero blockers, provided the race is fixed').verdict).toBe('MERGE-SAFE');
  });
  it('COND-2: "zero remaining blockers, provided CI lands" reads MERGE-SAFE — pinned as intended (B4 behavior)', () => {
    expect(extractRunVerdict('VERDICT: zero remaining blockers, provided CI lands').verdict).toBe('MERGE-SAFE');
  });
  it('COND-3: "no further merge blockers once CI is green" reads MERGE-SAFE — pinned as intended (B4 behavior)', () => {
    expect(extractRunVerdict('VERDICT: no further merge blockers once CI is green').verdict).toBe('MERGE-SAFE');
  });
  it('COND-4: "zero hard failures if you take the rebase" reads MERGE-SAFE — pinned as intended (B4 behavior)', () => {
    expect(extractRunVerdict('VERDICT: zero hard failures if you take the rebase').verdict).toBe('MERGE-SAFE');
  });
  it('the live unconditional veto is untouched: "two blockers remain" still NOT-MERGE-SAFE', () => {
    expect(extractRunVerdict('VERDICT: two blockers remain, zero failures elsewhere').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: BLOCK — structurally defeated').verdict).toBe('NOT-MERGE-SAFE');
  });
});

describe('ticket 8071c98f — round-5 (dispatch-2, reviewer 09ec3c07): fixed under-veto classes — pinned; NOT landed (branch preservation)', () => {
  // Reviewer 09ec3c07 convicted 10 blocking under-veto classes (F1-F10) on the
  // dispatch-1 hardening branch. Round-5 (this lane) fixed the composite-proof
  // semantics (F1), partial-coverage fail-closed (F2), the standing-guard
  // vocabulary (F3), the test-domain carve bounds (F5/F10), the gate-carve
  // vacuity class (F8-hollow/F9) and the round-arm nounless widening (F7-round,
  // via the fail/catch outcome requirement). These pins hold the fixes. The
  // remaining classes (F4 present-state localizer after proof, F6 live plural
  // verdict mask, F7-citation clause-split topic link, F8-vacuous-circumvention,
  // A1 count restore, A2 without-exception, A3 self-description provenance)
  // stay OPEN — the ticket's residual documents them.
  it('R5-F1 pin: a FAILED / QUEUED / FUTURE mutation verification is not a proof — keeps its veto', () => {
    for (const proof of [
      'the mutation check failed to confirm the latch test',
      'a mutation check is queued for tomorrow and proves the latch test',
      'my mutation re-check will prove the latch test',
    ]) {
      expect(extractRunVerdict(
        `Adversarial review (sub-session aabbccdd): verdict NOT-MERGE-SAFE with one blocking finding on the latch race. Fixed this run: docs updated; ${proof}. The patch is otherwise safe to merge.`,
      ).verdict).toBe('NOT-MERGE-SAFE');
    }
  });
  it('R5-F2 pin: a PARTIAL fix is never a noun-less full resolution — keeps its veto and count', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE — two blocking findings in the latch race. Fixed this run: one of the two findings; my mutation re-check confirms the latch test now fails the suite. The patch is safe to merge.',
    )).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE — two blocking findings in the latch race. Fixed this run: only part of the fix; my mutation re-check confirms the latch test now fails the suite. The patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('R5-F3 pin: defect-noun standing forms ("the race still stands", "the race is untouched", hollow guards) keep their vetoes', () => {
    for (const standing of [
      'the race still stands',
      'the race remains',
      'the race is still there',
      'the guard is hollow',
    ]) {
      expect(extractRunVerdict(
        `Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding on the latch race — ${standing}. Fixed this run: docs updated; my mutation re-check confirms the latch test now fails the suite. The patch is otherwise safe to merge.`,
      ).verdict).toBe('NOT-MERGE-SAFE');
    }
  });
  it('R5-F3-lexical pin: a mutation proof with a PRESENT-STATE LOCALIZER ("at head") is not a this-run proof — keeps its veto', () => {
    expect(extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding on the latch race. Fixed this run: docs updated; my mutation re-check confirms the latch test now FAILS the suite at head. The patch is otherwise safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('R5-F5/F10 pin: hollow/deleted/distant-failing regression-test narration keeps its veto', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE — the latch race. The regression suite hides the real failures; all findings were fixed in abc1234. The patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. The regression test written by the reviewer to catch the latch race still fails.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. The regression test, which the reviewer added last round to catch the latch race, is red.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('R5-F8/F9 pin: a mutation check whose regression PASSES (a vacuous pin confession) is standing, not proof — keeps its veto', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. My mutation check showed the regression passed 59/59; the guard is hollow.',
    )).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 1 });
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE — both were fixed; my mutation check showed the regression passed 59/59, so the guard is vacuous.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'VERDICT: MERGE-SAFE\nBLOCKING: 0\n\nRound-1 verdict: NOT-MERGE-SAFE with one blocking finding. All blocking findings were fixed in commit abc1234. My mutation check showed the regression passed 59/59; the guard is hollow.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('R5-F7-round pin: the round arm pairs ONLY with noun-ful resolutions — a nounless "Fixed this run" over a round-attributed veto keeps its veto (the dispatch-1 widening reverted)', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE — the latch race. Fixed this run: my mutation re-check confirms the docs tests pass 42/42. The patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('R5-S2 pin: a generic-noun topic link ("suite" over "suite") does not carry a citation-arm discount', () => {
    expect(extractRunVerdict(
      'Adversarial review (sub-session db3a6628): verdict NOT-MERGE-SAFE with one blocking finding in the suite. Fixed this run: docs updated; my mutation re-check confirms the CI suite is green.',
    ).verdict).toBe('NOT-MERGE-SAFE');
  });
  it('R5 RESIDUAL ADJUDICATION (3c354a95 review, finding F3): the pinned "open" F4/F6/A1 classes were DELTAS INTRODUCED by the 3c354a95 port (the branch pinned them against the pre-structured-field main), not fail-safe-to-base residuals — all three now hold fail-closed after the review fixes', () => {
    // F4 (fixed by the 3c354a95 review): a different-surface fail proof with
    // a present-state localizer — "fails after the fix" was missing from
    // REGRESSION_GATE_NARRATION_RE's localizer exclusion, so the carve
    // erased a LIVE standing regression. Base (4dca9f720) read
    // NOT-MERGE-SAFE; the first port read MERGE-SAFE (the reviewer's
    // dangerous inversion); "after the fix" now joins the exclusion list.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE — the latch race. My mutation re-check confirms the regression fails after the fix; all findings were fixed in abc1234. The patch is safe to merge.',
    ).verdict).toBe('NOT-MERGE-SAFE'); // F4 fixed — fail-safe to base
    // F6 (fixed by the 3c354a95 review): a live plural verdict read as
    // meta-nouns. "The two NOT-MERGE-SAFE verdicts read as final" carries a
    // visible non-n/a outcome ("final"), so the noun-modifier mask no longer
    // erases it. Base read NOT-MERGE-SAFE; the first port read n/a.
    expect(extractRunVerdict(
      '## Review complete\n\nThe two NOT-MERGE-SAFE verdicts read as final: C1 the latch race is unresolved, C2 the auth path is unsafe.',
    ).verdict).toBe('NOT-MERGE-SAFE'); // F6 fixed — fail-safe to base
    // A1 (still open, advisory F4 of the review — safe direction): count
    // under-report on a live veto (the verdict itself survives; the count
    // falls to 0 because the relayed "2 blocking findings" lives inside the
    // discounted history sentence). Under-count is the 11a35cfb class, not a
    // MERGE-SAFE inversion.
    expect(extractRunVerdict(
      'Round-1 review verdict: NOT-MERGE-SAFE with 2 blocking findings — the latch race.\n\nFixed this run: my mutation re-check confirms the latch test now fails the suite.\n\nVERDICT: NOT-MERGE-SAFE\n\nThe auth path is unsafe.',
    )).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 0 }); // KNOWN count under-report — A1 still open (advisory)
    // F7-citation / F8 / A2 / A3 remain pinned OPEN in their own blocks
    // above (not base-deltas — they were pinned against the branch's own
    // pre-port readings and neither the port nor the review fixes changed
    // them).
  });
});
