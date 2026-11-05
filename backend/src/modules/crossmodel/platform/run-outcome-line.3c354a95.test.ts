/**
 * Ticket 3c354a95 — the run_completed digest verdict stamping residual: a
 * final answer whose OWN verdict content is positive or absent is stamped
 * NOT-MERGE-SAFE · BLOCKING n>0 when the only blocking material is
 * citation-relay narration of a review (the 8071c98f instance-#3 class the
 * prior ticket pinned OPEN by design) or mechanism narration of the verdict
 * vocabulary itself (the structured-field close-out's own documentation).
 *
 * WHAT LANDED (this ticket, on main @ the b36a150e structured field):
 *  - the reviewed 8071c98f arms from the preserved round-5 branch
 *    (digby/session-fc74fc86 @ b4d599b36), ported onto the structured-field
 *    module: the citation-relay attribution grammar (arm 3), the noun-less
 *    "Fixed this run:" resolution cue with proof co-presence + topic link
 *    (arm 4), the test-domain/gate-narration standing-guard carves (arm 5)
 *    and the noun-modifier usage mask (arm 2) — NO lexical NEGATIVE_RE/
 *    STANDING vocabulary widening (three such rounds were convicted by
 *    independent adversarial review under 8071c98f);
 *  - the structured NEGATIVE field now passes the SAME sentinel-differential
 *    attribution gate the positive runs (b36a150e review F1) — a field
 *    inside a fence, blockquote, table row, inline-code span or quoted/
 *    relayed span is FOREIGN text (a documented example), never the
 *    emitter's assertion;
 *  - the stamping-verb usage mask: "all four classes now stamp
 *    NOT-MERGE-SAFE with the field" names the STAMP, not a verdict.
 *
 * SPECIMENS (all three reproduced pre-fix on live main — see the ablation
 * probes in tmp/probe-3c354a95 and the live-dist prodq probe on box A):
 *  - msg b16bfc50 (chat ec137c6b, 07:55Z 2026-10-19, the FRESH specimen):
 *    the b36a150e lane's own delivery final — backticked field example +
 *    "classes now stamp NOT-MERGE-SAFE with the field" narration → was
 *    NOT-MERGE-SAFE · 2;
 *  - msg 8e713334 (chat e75c538c, 12:55Z 2026-10-18): the citation-relay
 *    close-out — ACCEPTANCE #3 of the c90958af suite, pinned OPEN there →
 *    was NOT-MERGE-SAFE · 1;
 *  - msg d8810422 (chat 3ad495e3, ~14:35Z 2026-10-18): the noun-modifier
 *    mechanism narration → was NOT-MERGE-SAFE · 0.
 */
import { buildRunOutcomeLine, extractRunVerdict } from './run-outcome-line';

describe('ticket 3c354a95 — the three production specimens (replayed from the live messages, pre-fix readings quoted)', () => {
  // The b16bfc50 final, verbatim in its load-bearing head (the delivery
  // final of PR #1782): every receipt below is the lane's own POSITIVE
  // delivery evidence; the ONLY negative tokens are (a) the backticked
  // structured-field EXAMPLE and (b) "classes now stamp NOT-MERGE-SAFE with
  // the field" — documentation of the mechanism this very module implements.
  const B16 = [
    '**Ticket b36a150e is DELIVERED and CLOSED — the full lifecycle completed this session: implement → adversarial review → fix findings → merge → deploy green → live E2E probe → ticket closed with evidence.**',
    '',
    '## What shipped (PR #1782, MERGED, squash `4dca9f720d62` — live on origin/main per this run\'s `git ls-remote`)',
    '',
    'The **structured verdict field** the ticket prescribed: `extractRunVerdict` now reads a machine-readable one-line JSON field (`{"verdict":"NOT-MERGE-SAFE","blocking":2,"source":"reviewer-final"}`) with precedence over the regex fallback — zero regex arms widened. Negative fields win outright (read pre-mask, fail-closed) and carry their own blocking count; positive fields pass an attribution gate. All four ticket boundary classes now stamp NOT-MERGE-SAFE with the field; without it, the 4baa7c3e DOCUMENTED BOUNDARY pins stay green (regex untouched).',
    '',
    '## This run\'s completion receipts (all observed 2026-10-19 ~07:42–07:54Z, 12:42–12:54 AM PDT)',
    '',
    '- **Deploy green + live:** main head `4dca9f72`; run **39214147313 → conclusion: success**; all 4 box/process rows `onMainHead: true`.',
    '- **Live E2E probe of the changed surface** — the ticket\'s full corpus inside the deployed container on box A: `PROBE b36a150e E2E: PASS=84 FAIL=0 TOTAL=84`.',
    '- **Ticket CLOSED:** evidence `{commitSha: 4dca9f720d62, prUrl: …/pull/1782, deployRunId: 39214147313, replayTestPath: backend/src/modules/crossmodel/platform/run-outcome-line.b36a150e.test.ts}`.',
  ].join('\n');

  it('REPLAY (msg b16bfc50, the fresh 07:55Z specimen): the structured-field close-out stamps n/a · 0, not NOT-MERGE-SAFE · 2', () => {
    // Pre-fix (live dist probe, box A, this run): NOT-MERGE-SAFE · 2.
    expect(extractRunVerdict(B16)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('REPLAY (msg b16bfc50): the producer outcome line over the delivery final carries no NOT-MERGE-SAFE stamp', () => {
    const line = buildRunOutcomeLine({ outcome: 'completed', finalText: B16 });
    expect(line).not.toContain('NOT-MERGE-SAFE');
    expect(line).toContain('RUN_OUTCOME: completed');
  });

  it('REPLAY (msg 8e713334, ACCEPTANCE #3 of c90958af): the citation-relay close-out stamps n/a · 0, not NOT-MERGE-SAFE · 1', () => {
    const text = [
      '## Deliverable: ticket 7b2990fa fixed, reviewed, merged — PR #1745 (squash `0e1316b4` on main)',
      '',
      '**Adversarial review** (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding — my faithful mock had silently vacated the pre-existing **N1 actionability-gate pin** (DAY2 second pass fetched 0 rows; reviewer mutation-proved a pre-N1 gate regression passed 59/59). **Fixed this run**: DAY2 rows re-dated + non-vacuity assertions (rows 6, signals 1); my mutation re-check confirms the pre-N1 regression now FAILS the suite (1 failed / 59) while clean runs pass 59/59.',
    ].join('\n');
    // Pre-fix (this run, pre-edit module): NOT-MERGE-SAFE · 1.
    expect(extractRunVerdict(text)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('REPLAY (msg d8810422, the noun-modifier specimen): the mechanism close-out stamps MERGE-SAFE · 0, not NOT-MERGE-SAFE · 0', () => {
    const text = [
      '**PR #1750 MERGED to main** (squash sha `f6cb7621120c`, merge receipt: "MERGED example-org/crossmodel#1750 (squash sha f6cb7621120c) — confirmed merged:true by follow-up GET").',
      '',
      'Plus sighting ticket **abe2a3a2-332f-4944-856d-20ae156a7871** filed for the separate run-outcome-line defect (live parenthetical NOT-MERGE-SAFE vetoes degrade to `n/a` — the c90958af half of PR #1723, verified by probe: pre `VERDICT: NOT-MERGE-SAFE · BLOCKING: 2` → post `VERDICT: n/a · BLOCKING: 2`; NOT this lane\'s concern per one-concern-per-PR).',
      '',
      'Reviewer (delegate, fresh context) verdict **MERGE-SAFE**; its findings were all fixed in commit `c9536882` and probe-verified.',
    ].join('\n');
    // Pre-fix (this run, pre-edit module): NOT-MERGE-SAFE · 0.
    expect(extractRunVerdict(text)).toEqual({ verdict: 'MERGE-SAFE', blocking: 0 });
  });
});

describe('ticket 3c354a95 — the structured NEGATIVE field attribution gate (the b16bfc50 carrier isolation)', () => {
  it('A NEGATIVE field inside an inline-code span (the documented example) is foreign — n/a, and the count is not hoisted', () => {
    // The exact carrier isolated by ablation: removing the backticked span
    // dropped the read from NOT-MERGE-SAFE·2 to NOT-MERGE-SAFE·0 pre-fix.
    expect(extractRunVerdict('The field is `{"verdict":"NOT-MERGE-SAFE","blocking":2}` — that is the contract.')).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('A NEGATIVE field inside a fenced block (a quoted reviewer final) is foreign — n/a (the quoted-negative veto declines)', () => {
    expect(extractRunVerdict('Reviewer final answer:\n```\n{"verdict":"NOT-MERGE-SAFE","blocking":2}\n```\nBuild is green.').verdict).toBe('n/a');
  });

  it('A NEGATIVE field on the author\'s OWN line keeps its fail-closed win (the live emitter contract, b36a150e producer replay)', () => {
    expect(extractRunVerdict('merge-safe prose\n{"verdict":"NOT-MERGE-SAFE","blocking":1}')).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 1 });
    expect(extractRunVerdict('{"verdict":"NOT-MERGE-SAFE","blocking":2,"source":"reviewer-final"}')).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });

  it('DETECTOR-RECALL REPLAY (b36a150e FAIL-CLOSED pins): contradictory pairs and historical QUOTED negative fields still read NOT-MERGE-SAFE', () => {
    // Both orderings of a contradictory pair — the b36a150e contract.
    expect(extractRunVerdict('{"verdict":"NOT-MERGE-SAFE"}\nmore prose\n{"verdict":"MERGE-SAFE"}').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('{"verdict":"MERGE-SAFE"}\nmore prose\n{"verdict":"NOT-MERGE-SAFE","blocking":3}').verdict).toBe('NOT-MERGE-SAFE');
    // A historical QUOTED negative field with NO later field: the negative
    // value is still read through the prose relay (fail-closed — a quoted
    // reviewer negative is never erased) with its count.
    expect(extractRunVerdict('the round-1 field was {"verdict":"NOT-MERGE-SAFE","blocking":2} and both findings were fixed in 256c7399e'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    // The producer line over a live negative field stays front-loaded.
    const line = buildRunOutcomeLine({
      outcome: 'completed',
      finalText: 'merge-safe — F3 is unresolved\n{"verdict":"NOT-MERGE-SAFE","blocking":1,"source":"reviewer-final"}',
    });
    expect(line).toContain('VERDICT: NOT-MERGE-SAFE');
    expect(line).toContain('BLOCKING: 1');
  });

  it('DETECTOR-RECALL REPLAY (b36a150e F1 positives): foreign POSITIVE fields never stamp MERGE-SAFE', () => {
    // The gate must not have been weakened for the positive direction by
    // the shared attributedField helper.
    expect(extractRunVerdict('```\n{"verdict":"MERGE-SAFE","blocking":0}\n```\nTwo blockers remain open after the fix.').verdict).toBe('n/a');
    expect(extractRunVerdict('emit `{"verdict":"MERGE-SAFE","blocking":0}` to stamp it').verdict).toBe('n/a');
    expect(extractRunVerdict('| field |\n| --- |\n| {"verdict":"MERGE-SAFE","blocking":0} |').verdict).toBe('n/a');
    expect(extractRunVerdict('All checks green.\n{"verdict":"MERGE-SAFE","blocking":0}').verdict).toBe('MERGE-SAFE');
  });
});

describe('ticket 3c354a95 — the stamping-verb usage mask (the b16bfc50 prose carrier)', () => {
  it('The class-stamping idiom is mechanism narration: "all four classes now stamp NOT-MERGE-SAFE with the field" reads no veto', () => {
    expect(extractRunVerdict('All four ticket boundary classes now stamp NOT-MERGE-SAFE with the field; without it, the pins stay green.').verdict).toBe('n/a');
    expect(extractRunVerdict('Negative fields now read as NOT-MERGE-SAFE pre-mask; the docblock says so.').verdict).toBe('n/a');
  });

  it('DETECTOR-RECALL REPLAY: a reviewer\'s LIVE colon-introduced verdict keeps its veto (the verb mask never touches it)', () => {
    expect(extractRunVerdict('Reviewer verdict: NOT-MERGE-SAFE — two blocking findings remain open.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: NOT-MERGE-SAFE — the latch test still fails').verdict).toBe('NOT-MERGE-SAFE');
    // A live imperative veto is not a plural mechanism subject.
    expect(extractRunVerdict('DO NOT MERGE — the tests do not pass.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY (8071c98f arm-2 landed pins): the noun-modifier masks stay bounded', () => {
    expect(extractRunVerdict('The live parenthetical NOT-MERGE-SAFE vetoes degrade to n/a when the fix lands, and the rest is clean.').verdict).toBe('n/a');
    expect(extractRunVerdict('The DO NOT MERGE stamps degrade to n/a when the fix lands.').verdict).toBe('n/a');
    // A true veto heads its own clause after the colon — the 11a35cfb pin.
    expect(extractRunVerdict('Final verdict: "NOT-MERGE-SAFE" — C2 regressed.').verdict).toBe('NOT-MERGE-SAFE');
  });
});

describe('ticket 3c354a95 — DETECTOR-RECALL REPLAY: the prior true positives still fire (fail-closed)', () => {
  it('A citation-relay verdict whose finding is NOT resolved keeps its veto (the discount requires the this-run close-out)', () => {
    expect(extractRunVerdict('**Adversarial review** (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding — the mock vacated the pin. The finding remains unfixed at head.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('A citation-relay verdict with a STANDING window keeps its veto (window guard)', () => {
    expect(extractRunVerdict('**Adversarial review** (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding. **Fixed this run**: my mutation re-check confirms the N1 regression now FAILS the suite. However F4 was regressed by the merge.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('A citation-relay verdict with a DIFFERENT-TOPIC noun-less close-out keeps its veto (topic link)', () => {
    expect(extractRunVerdict('**Adversarial review** (independent sub-session db3a6628, diff + claim manifest only): verdict NOT-MERGE-SAFE with one blocking finding on the latch race. **Fixed this run**: my mutation re-check confirms the docs gate now FAILS the suite.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('The explicit-line + structured-field + whole-text negative lanes are untouched (spot pins from the landed suites)', () => {
    expect(extractRunVerdict('The two blockers remain open; the rest is clean. NOT SAFE TO MERGE.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('**VERDICT: BLOCK** — the reviewer refuses until the race is fixed.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings were fixed in commit abc1234. However F4 was regressed by the merge.').verdict).toBe('NOT-MERGE-SAFE');
  });
});
