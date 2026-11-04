/**
 * Ticket da70e157 — the run_completed wake digest contradicted the persisted
 * final answer on BLOCK verdicts, in two flavors:
 *   #1 (09:05Z, msg 3fc32d93): digest "MERGE-SAFE · BLOCKING: 0" over
 *      "## **VERDICT: BLOCK** — 2 blocking findings, 9 advisory"
 *   #3 (11:12Z, msg 644c8c4b): digest "n/a · BLOCKING: 0" over
 *      "## **VERDICT: BLOCK** — 2 blocking findings (A: still not fixed; B′: new), C fully fixed"
 *   #4 (11:46Z, msg 877a503f): digest "n/a · BLOCKING: 3" over
 *      "## **VERDICT: BLOCK** — ... three blocking findings"
 *
 * Root cause (all three, same two gaps in run-outcome-line.ts):
 *   GAP 1 — the adversarial reviewers write their verdicts as MARKDOWN
 *   HEADINGS ("## **VERDICT: BLOCK**"), but VERDICT_LINE_RE's decoration
 *   class was [>\s*•\-–] with no '#', so the explicit-line lane never matched
 *   and the verdict fell to the whole-text fallback.
 *   GAP 2 — the fallback has NO BLOCK vocabulary at all: occurrence #1's
 *   answer carried "the two background worker reports (security,
 *   merge-safety)" in plain prose and the UNBOUNDED MERGE[-\s]SAFE substring
 *   matched inside the review-DIMENSION word "merge-safety", flipping the
 *   digest to MERGE-SAFE; occurrences #3/#4 matched nothing and failed open
 *   to n/a.
 *
 * The fixtures below are near-verbatim excerpts of the three persisted final
 * answers (read fresh from chat ce911d93 by the fixing lane this run; full
 * texts are 9–12k chars — every construct that can reach a verdict/blocking
 * decision is preserved, including the exact headings, the exact
 * "(security, merge-safety)" prose, and the BLOCKING-FINDINGS section
 * headers).
 *
 * Mutation note (the fix's load-bearing assertions): with GAP 1 open the
 * heading verdicts fall to the fallback (fixture 1 → MERGE-SAFE, fixtures
 * 3/4 → n/a — the observed digests); with GAP 2 open but GAP 1 closed the
 * explicit value "BLOCK" still reads n/a ("BLOCK" was in no vocabulary).
 * Both must be closed for the primary assertions to pass. The trailing
 * regression pins hold WITHOUT the fix too (they pin the pre-existing
 * bf30c5d9/54af5c27 contracts that this change must not disturb).
 */

import { extractRunVerdict, buildRunOutcomeLine, frontLoadRunOutcome } from './run-outcome-line';

/** Occurrence #1 — the MERGE-SAFE flip (msg 3fc32d93, review of f0711a86f). */
const OCCURRENCE_1 = [
  '# ADVERSARIAL REVIEW VERDICT — commit `f0711a86f` (ticket 26786762)',
  '',
  '## **VERDICT: BLOCK** — 2 blocking findings, 9 advisory',
  '',
  'The fix is substantially well-built: the architecture is right, the tests are real, the kill switch genuinely restores pre-fix behavior, and the merge mechanics are clean. But it ships a new plaintext-credential leak on the one surface it was built to protect, and a silent mis-delivery in its own headline use case.',
  '',
  '---',
  '',
  '## BLOCKING FINDINGS',
  '',
  '### BLOCKING 1 — the delivered value is persisted to the coding transcript in plaintext (`deliverSecrets[].value`)',
  '',
  '**Where (all at f0711a86f):** the tool call carries the raw value as an argument, and no secret scrub runs on this seam.',
  '',
  '### BLOCKING 2 — explicit-delivery ordinals collide with the handle the tool tells the agent to write',
  '',
  '**Where (all at f0711a86f):** the shared rescue counter starts at `next: 1` and the implicit spans consume ordinals first.',
  '',
  '---',
  '',
  '## WHAT\'S REQUIRED TO MERGE',
  '',
  'Fix BLOCKING 1 and BLOCKING 2 (minimal fixes sketched above), add the two missing tests, and re-request review. Nothing else blocks — the architecture, store, REST scoping, switch wiring, and all eight manifest claims otherwise check out against primary sources.',
  '',
  '*Review only: I edited no files, merged nothing, and fixed nothing. The two background worker reports (security, merge-safety) were corroborated against primary sources before adoption; the security worker\'s two blocking findings are the ones verified above.*',
].join('\n');

/** Occurrence #3 — the n/a fail-open (msg 644c8c4b, round-3 re-review of cfc92f820). */
const OCCURRENCE_3 = [
  '# ROUND 3 — AMENDED ADVERSARIAL RE-REVIEW VERDICT — commit `cfc92f820` (ticket 26786762, PR #1666)',
  '',
  '## **VERDICT: BLOCK** — 2 blocking findings (A: still not fixed; B′: new), C fully fixed',
  '',
  'I re-verified every claim against primary sources at the commit, re-ran my own round-2 probe classes against the real module at the commit, and probed the seam expression verbatim.',
  '',
  '---',
  '',
  '## BLOCKING A — NOT FIXED: the streak-args seam masks a weaker pattern than the helper, and leaks in five shapes',
  '',
  'The comment above it names `maskDeliverSecretsInArgsString` — but the seam does not call it.',
  '',
  '## BLOCKING B′ — NEW (sibling of B): the canonical branch masks only `value`; a credential in `label` rides the preview seam verbatim',
  '',
  'This violates the module\'s own round-3 docstring and is the identical mishap class B was.',
  '',
  '## BLOCKING C — **FIXED** (verified by my own probe, 15/15)',
  '',
  'The comment is now true and the suite pins the per-card cap. No further action.',
  '',
  '---',
  '',
  '## TO MERGE',
  '',
  '1. **A:** call the helper at both capture sites and slice after masking.',
  '2. **B′:** project the canonical branch to a known-safe shape, never spread.',
  '3. C needs nothing.',
  '',
  '*Review only: no files edited, nothing merged, nothing pushed; the session branch was restored clean.*',
].join('\n');

/** Occurrence #4 — the n/a fail-open with a correct-but-accidental count (msg 877a503f, round-4 re-review of f4a0c080e). */
const OCCURRENCE_4 = [
  '# ROUND 4 (AMENDED) — ADVERSARIAL RE-REVIEW VERDICT — commit `f4a0c080e` (ticket 26786762, PR #1666)',
  '',
  '## **VERDICT: BLOCK** — your two round-3 findings A and B′ are now **genuinely fixed and verified**, C holds, both advisory pins landed — but the re-review surfaced **three blocking findings**.',
  '',
  '---',
  '',
  '## BLOCKING FINDINGS',
  '',
  '### F1 (cross-family finding, confirmed mine) — **CI is red at the PR head; no head since round 2 has ever been green**',
  '',
  '`check_ci(f4a0c080e…)` → **FAILURE — Backend tests (shard 3/4)**, all other 9 checks success.',
  '',
  '### B″ — the `r.secrets` manifest carries the **raw explicit label** through the unredacted tool-result seam',
  '',
  'The chain persists the raw label into coding_messages.parts and re-sends it to the provider.',
  '',
  '### D — the helper\'s unparseable-JSON fallback still passes a value tail, and both guards are `deliverSecrets`-field-scoped',
  '',
  'A truncated/unparseable args string with a comma-carrying tail leaks the value through the streak seam.',
  '',
  '## TO MERGE',
  '',
  '1. **F1:** shorten the description or add a budget row — the head must be green.',
  '2. **B″:** safe-label projection on `deliveredManifest`.',
  '3. **D:** full-string redaction on unparseable input containing `deliverSecrets`.',
].join('\n');

describe('ticket da70e157 — replay: the three reported BLOCK verdicts read NOT-MERGE-SAFE, never MERGE-SAFE or n/a', () => {
  it('occurrence #1 (the MERGE-SAFE flip): heading BLOCK verdict beats the "merge-safety" dimension word in the tail', () => {
    // The exact mechanism of the flip: unbounded MERGE-SAFE substring inside
    // "merge-safety" (a review dimension, not a verdict) — pinned so the
    // word-bound guard cannot regress.
    expect(OCCURRENCE_1).toContain('(security, merge-safety)');
    const out = extractRunVerdict(OCCURRENCE_1);
    expect(out.verdict).toBe('NOT-MERGE-SAFE');
    expect(out.blocking).toBe(2);
    expect(buildRunOutcomeLine({ outcome: 'completed', finalText: OCCURRENCE_1 }))
      .toBe('RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 2');
  });

  it('occurrence #3 (the n/a fail-open): a BLOCK verdict with fixed/new/fully-fixed recaps reads NOT-MERGE-SAFE', () => {
    const out = extractRunVerdict(OCCURRENCE_3);
    expect(out.verdict).toBe('NOT-MERGE-SAFE');
    expect(out.blocking).toBe(2);
    expect(buildRunOutcomeLine({ outcome: 'completed', finalText: OCCURRENCE_3 }))
      .toBe('RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 2');
  });

  it('occurrence #4 (n/a + accidental count): the verdict reads NOT-MERGE-SAFE and the count comes from the verdict-line tail, not the section header', () => {
    const out = extractRunVerdict(OCCURRENCE_4);
    expect(out.verdict).toBe('NOT-MERGE-SAFE');
    // "three blocking findings" on the verdict line — the F1/B″/D section
    // headings carry no BLOCKING label, and "## BLOCKING FINDINGS" is a
    // header, not a finding.
    expect(out.blocking).toBe(3);
  });

  it('the digest the supervisor would have received: front-loaded line carries the BLOCK signal past every cut', () => {
    const summary = frontLoadRunOutcome('Coding run completed. Final answer: …', {
      outcome: 'completed', finalText: OCCURRENCE_1,
    });
    expect(summary.split('\n')[0]).toBe('RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 2');
  });
});

describe('ticket da70e157 — the BLOCK family on an explicit verdict line (unit)', () => {
  it('heading + bold decoration variants all reach the explicit lane', () => {
    expect(extractRunVerdict('## **VERDICT: BLOCK** — 2 blocking findings\n').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('## VERDICT: BLOCKED\n').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('# VERDICT: FAIL\n').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('### VERDICT: REJECTED\n').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('**VERDICT: REFUSED**\n').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('## VERDICT: BLOCKED (2 blockers)\n').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('an APPROVE-family verdict on a heading line reads MERGE-SAFE (the reviewer idiom\'s positive counterpart)', () => {
    expect(extractRunVerdict('## **VERDICT: APPROVE** — all findings fixed and verified\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('## **VERDICT: APPROVED**\n').verdict).toBe('MERGE-SAFE');
  });

  it('a negated or zeroed block value is NOT negative — "NO BLOCKING ISSUES" / "0 FAIL" read MERGE-SAFE', () => {
    expect(extractRunVerdict('## **VERDICT: NO BLOCKING ISSUES**\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: 0 FAIL\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: BLOCKING ISSUES RESOLVED\n').verdict).toBe('MERGE-SAFE');
  });

  it('BLOCK-family words in PLAIN PROSE about fixes do not flip a no-marker answer (whole-text lane keeps its bf30c5d9 markers only)', () => {
    // "the fix blocks the leak" is a POSITIVE statement about a fix — the
    // bare word must stay out of the whole-text fallback vocabulary.
    expect(extractRunVerdict('The fix blocks the leak on both seams; all suites green.').verdict).toBe('n/a');
    expect(extractRunVerdict('The new guard blocks credential exfiltration end-to-end.').verdict).toBe('n/a');
    // …and the word-bounded positive: "merge-safety" is a dimension, not a verdict.
    expect(extractRunVerdict('The two background worker reports (security, merge-safety) were corroborated.').verdict).toBe('n/a');
    // …while a REAL positive fallback marker still works.
    expect(extractRunVerdict('All eight claims hold — safe to merge.').verdict).toBe('MERGE-SAFE');
  });

  it('the last explicit VERDICT: line still wins (a verdict recap heading does not steal a later status line)', () => {
    const text = '## **VERDICT: BLOCK** — 2 blocking findings\n\nRecap follows.\n\nVERDICT: MERGE-SAFE\n';
    expect(extractRunVerdict(text).verdict).toBe('MERGE-SAFE');
  });
});

describe('ticket da70e157 — blocking-count precedence (regression pins on the widened lanes)', () => {
  it('an explicit BLOCKING: n line still wins over the verdict tail and labeled lines', () => {
    expect(extractRunVerdict('VERDICT: NOT-MERGE-SAFE\nBLOCKING: 3\n- BLOCKING: A\n- BLOCKING: B\n').blocking).toBe(3);
  });

  it('a heading "### BLOCKING 1 — …" counts as a finding; the bare "## BLOCKING FINDINGS" header does not', () => {
    expect(extractRunVerdict('## BLOCKING FINDINGS\n### BLOCKING 1 — leak\n### BLOCKING 2 — ordinals\n').blocking).toBe(2);
  });

  it('a count in the verdict line\'s own tail beats labeled lines (occurrences #1/#3 shape)', () => {
    expect(extractRunVerdict('## **VERDICT: BLOCK** — 2 blocking findings, 9 advisory\n').blocking).toBe(2);
    expect(extractRunVerdict('## **VERDICT: BLOCK** — 2 blocking findings (A: still not fixed; B′: new)\n').blocking).toBe(2);
  });
  it('B1 regression class (reviewer 8df4e03f): an absent/resolved phrase never forecloses a LIVE negative token in the same value', () => {
    // All measured NOT-MERGE-SAFE under the shipped fix; every one of these
    // read MERGE-SAFE under the absent-first ordering the review blocked.
    for (const v of [
      'VERDICT: NO BLOCKING ISSUES BUT NOT MERGE-SAFE\n',
      '## VERDICT: NO BLOCKING ISSUES — MERGE-SAFE once CI is green\n',
      'VERDICT: BLOCKING ISSUES RESOLVED, NOT MERGE-SAFE UNTIL REBASE\n',
      'VERDICT: NO BLOCKS — DO NOT MERGE\n',
      'VERDICT: NO BLOCKING ISSUES — CANNOT SHIP YET\n',
      '## **VERDICT: NO BLOCKING ISSUES — NOT SAFE TO MERGE**\n',
      'VERDICT: BLOCKING ISSUES RESOLVED — MERGE-SAFE ONCE REBASED\n',
    ]) expect(extractRunVerdict(v).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('B1 fail-open class: absent/resolved phrase + live blocker in the SAME verdict never reads MERGE-SAFE', () => {
    for (const v of [
      'VERDICT: BLOCKING ISSUES RESOLVED — 1 NEW BLOCKING FINDING\n',
      'VERDICT: BLOCKING ISSUES RESOLVED — BLOCKED ON CI\n',
      '## **VERDICT: BLOCKING ISSUES RESOLVED** — 2 blocking findings remain\n',
      'VERDICT: NO BLOCKING ISSUES — 1 NEW REJECT\n',
      'VERDICT: BLOCKING ISSUES RESOLVED, BUT 2 NEW BLOCKERS\n',
      'VERDICT: NO BLOCKING ISSUES, 2 FAILURES\n',
    ]) expect(extractRunVerdict(v).verdict).toBe('NOT-MERGE-SAFE');
    // The bold-tail shape also carries its count (the capture stops at `**`,
    // the survivor check runs on the full line).
    expect(extractRunVerdict('## **VERDICT: BLOCKING ISSUES RESOLVED** — 2 blocking findings remain\n'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });

  it('advisory ① adopted: colon/count absent forms ("MERGE-SAFE (blocking: 0)", "LGTM, blocking: 0") read MERGE-SAFE', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE (blocking: 0)\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: LGTM, blocking: 0\n').verdict).toBe('MERGE-SAFE');
  });

  it('advisory ⑦ adopted: a spelled-out BLOCKING FINDINGS count line counts ("three" → 3)', () => {
    expect(extractRunVerdict('VERDICT: BLOCK\nBLOCKING FINDINGS: three\n').blocking).toBe(3);
  });

  it('P4 over-negative documented (advisory ⑥): "APPROVE — the fix blocks the leak" reads NOT-MERGE-SAFE — the safe direction', () => {
    // Genuinely ambiguous ("blocks the leak" is praise); NOT-MERGE-SAFE is
    // the safe fail-closed direction for an ambiguous verdict value.
    expect(extractRunVerdict('VERDICT: APPROVE — the fix blocks the leak on both seams; all suites green.\n').verdict)
      .toBe('NOT-MERGE-SAFE');
  });

  it('P5/P6 pins: ambiguous compound blocks stay NOT-MERGE-SAFE', () => {
    expect(extractRunVerdict('VERDICT: BLOCK — G1/G2/G3 ADDRESSED\n').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: BLOCKED BUT RESOLVED BY REBASE\n').verdict).toBe('NOT-MERGE-SAFE');
  });
});

describe('ticket da70e157 — cross-review regression pins (heading verdicts with trailing qualifications)', () => {
  /**
   * Cross-family review 2026-10-17 (post-merge, PR #1676): the heading fix
   * routed `## **VERDICT: X** — trailing qualification` lines into the
   * explicit lane, but the capture stops at the closing `**` and the value-
   * only tests never saw the qualification — reading MERGE-SAFE over an
   * explicit same-line negative/conditional (the unsafe direction; pre-fix
   * these shapes fell to the whole-text fallback where NEGATIVE wins).
   * The fix: NEGATIVE also tests the UPPERCASED FULL verdict line.
   */
  it('defect 1 — a trailing negative/conditional on a heading verdict reads NOT-MERGE-SAFE, never MERGE-SAFE', () => {
    for (const t of [
      '## **VERDICT: MERGE-SAFE** — MERGE-SAFE once the flaky suite is fixed\n',
      '## **VERDICT: MERGE-SAFE** — but NOT MERGE-SAFE until CI is green\n',
      '## **VERDICT: MERGE-SAFE** — DO NOT MERGE until C2 is re-run\n',
      '## **VERDICT: NO BLOCKING ISSUES** — but NOT MERGE-SAFE until CI is green\n',
      '## **VERDICT: NO BLOCKING ISSUES** — CANNOT SHIP yet\n',
      '**VERDICT: NO BLOCKING ISSUES** — NOT MERGE-SAFE\n',
    ]) expect(extractRunVerdict(t).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('defect 2 — an unknown-vocab explicit value falls through to the whole-text scan instead of failing open to n/a', () => {
    // Pre-fix these read NOT-MERGE-SAFE via the fallback; the heading fix
    // made them n/a (the ticket's #3/#4 flavor reintroduced for headings).
    expect(extractRunVerdict('## VERDICT: CHANGES REQUESTED\n\nThe current head is NOT MERGE-SAFE — C2 regresses.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('## VERDICT: REWORK\n\nDO NOT MERGE.').verdict).toBe('NOT-MERGE-SAFE');
    // A clean positive body still reads MERGE-SAFE through the fallthrough.
    expect(extractRunVerdict('## VERDICT: CHANGES REQUESTED\n\nAll concerns resolved — safe to merge.').verdict).toBe('MERGE-SAFE');
  });

  it('defect 3 — BLOCKERS joins the absent vocabulary symmetrically', () => {
    expect(extractRunVerdict('## **VERDICT: NO BLOCKERS**\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('## **VERDICT: 0 BLOCKERS — APPROVED**\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('## **VERDICT: ALL BLOCKERS RESOLVED**\n').verdict).toBe('MERGE-SAFE');
  });

  it('documented side effect: a heading tail naming the earlier NOT-MERGE-SAFE concern reads NOT-MERGE-SAFE (safe fail-closed)', () => {
    // Over-negative by construction: the tail names a negative marker, and
    // the extractor cannot attribute bare prose. NOT-MERGE-SAFE is the safe
    // direction for an ambiguous heading tail.
    expect(extractRunVerdict('## **VERDICT: MERGE-SAFE** — the earlier NOT-MERGE-SAFE concern is fixed\n').verdict).toBe('NOT-MERGE-SAFE');
  });
});

describe('ticket da70e157 — fresh repro delivered 15:18Z 2026-10-17 (build lane fbdc568d, msg 0bb00c00): quoted-in-prose verdicts and round history', () => {
  /**
   * A BUILD lane's final (not a reviewer's) carried its only verdict text as
   * a PLAIN-PROSE quote of the adversarial reviewer — 'Final verdict (read
   * this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"' — plus
   * round history ('Round 1 → BLOCKED', 'Round 2 → 1 new blocker'). The
   * mid-line quote cannot reach the line-anchored explicit lane (54af5c27
   * residual limit: a leaf heuristic cannot attribute bare-prose quotes), so
   * the whole-text fallback decides. Pins, in order of load-bearing:
   *   1. the DANGEROUS variant (same shape, quoted verdict is BLOCK) must
   *      NEVER read MERGE-SAFE — n/a is the safe fail-open (BLOCK-family
   *      words are whole-text-absent by design, and the positive fallback is
   *      word-bounded, so no flip is possible);
   *   2. the real instance reads MERGE-SAFE — semantically correct here
   *      (the reviewer's actual current verdict WAS safe-to-merge; every
   *      round blocker was fixed and re-verified), so the quoted positive
   *      verdict carries;
   *   3. round history alone (BLOCKED rounds, all fixed, no verdict) stays
   *      n/a — cleared history is not a verdict.
   */
  const REAL_BUILD_LANE = [
    '## Deliverable — the hosted hardened browser (ticket ea3ad8a8), built, reviewed, and staged for landing',
    '',
    '### Adversarial review (independent sub-session 67d9f113, fresh context) — PASSED',
    '',
    'Two full rounds, refutation-only with the reviewer\'s own probes:',
    '- **Round 1 → BLOCKED**: 2 blockers (image build broken; tini ENTRYPOINT absent) — **all fixed in commit `72012485`**, each with a regression test.',
    '- **Round 2 → 1 new blocker**: R1, empty-secret fail-open — **all fixed in commit `27fd49c6`** with regression tests.',
    '- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"** — every fix re-verified by the reviewer\'s own probes.',
    '',
    '### What remains — NOT done this run (exact handoff)',
    '1. **Verify train CI green on the batch head.**',
    '2. **git push origin main --ff-only to exactly the tested sha.**',
  ].join('\n');

  const QUOTED_BLOCK_VARIANT = [
    '## Deliverable — built and reviewed',
    '',
    '- **Round 1 → BLOCKED**: 2 blockers — **all fixed in commit abc1234**, each with a regression test.',
    '- **Round 2 → 1 new blocker**: fixed in commit def5678.',
    '- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: BLOCK — 2 blocking findings"**',
    '',
    '### What remains',
    'The blockers stand; the fix lane must act.',
  ].join('\n');

  it('DANGEROUS variant: a quoted-in-prose BLOCK verdict never reads MERGE-SAFE (n/a fail-open is the safe direction)', () => {
    expect(extractRunVerdict(QUOTED_BLOCK_VARIANT)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('the real instance (quoted SAFE TO MERGE, all round blockers fixed) reads MERGE-SAFE — the quoted positive verdict carries', () => {
    expect(extractRunVerdict(REAL_BUILD_LANE)).toEqual({ verdict: 'MERGE-SAFE', blocking: 0 });
  });

  it('cleared round history alone (BLOCKED rounds, all fixed, no verdict) stays n/a', () => {
    const text = [
      '## Deliverable — built and reviewed',
      '- **Round 1 → BLOCKED**: 2 blockers — all fixed in commit abc1234.',
      '- **Round 2 → 1 new blocker**: fixed in commit def5678.',
      'All remaining steps verified against primary sources.',
    ].join('\n');
    expect(extractRunVerdict(text)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('a mid-line "VERDICT REAFFIRMED: BLOCK" tail (occurrence #1\'s real closing) alone fails open to n/a, never MERGE-SAFE', () => {
    const text = '_Independent review (a second model checked this against your original request): 1 possible issue raised and weighed — VERDICT REAFFIRMED: BLOCK — unchanged, and now doubly-confirmed._';
    expect(extractRunVerdict(text)).toEqual({ verdict: 'n/a', blocking: 0 });
  });
});

describe('ticket da70e157 — 54af5c27 own-words masking still holds on heading verdicts', () => {
  it('a BLOCKQUOTE quoting a heading verdict is masked, not adopted', () => {
    const text = 'The original review concluded:\n> ## **VERDICT: BLOCK** — 2 blocking findings\n\nOwn re-probe: everything holds.';
    expect(extractRunVerdict(text)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('a fenced code block quoting a heading verdict is masked', () => {
    const text = 'The earlier wake read:\n```\n## **VERDICT: BLOCK** — 2 blocking findings\n```\nRe-audit: all clean.';
    expect(extractRunVerdict(text)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('a table row quoting a heading verdict is masked', () => {
    const text = '| prior round | ## **VERDICT: BLOCK** — 2 blocking findings |\n\nOwn pass: no findings.';
    expect(extractRunVerdict(text)).toEqual({ verdict: 'n/a', blocking: 0 });
  });
});
