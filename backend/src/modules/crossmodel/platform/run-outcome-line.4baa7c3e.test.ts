/**
 * Ticket 4baa7c3e — conditional positives inside parentheses stamped
 * MERGE-SAFE (NEGATIVE_RE could not see past a closing paren).
 *
 * PRODUCTION REPLAY: NEGATIVE_RE's conditional arms tolerated only
 * `[,;:]?\s*|[—–-]\s*|\(\s*` between a positive verdict token and the
 * condition word — a closing `)` before the condition word (or paren CONTENT
 * between token and close) defeated every arm, so the token fell through to
 * the whole-text positive fallback:
 *
 *   extractRunVerdict('SAFE TO MERGE (all good) once CI is green')
 *     pre-fix  → MERGE-SAFE   (the module's documented DANGEROUS direction)
 *     post-fix → NOT-MERGE-SAFE
 *   extractRunVerdict('Final verdict (SAFE TO MERGE — 2 blocking findings remain)')
 *     pre-fix  → MERGE-SAFE · BLOCKING: 2  (self-contradictory stamp)
 *     post-fix → NOT-MERGE-SAFE · BLOCKING: 2
 *
 * Re-verified this lane on current main (cc5d68723) via a direct module
 * probe before the fix (tmp/probe-4baa7c3e/repro.ts): all four ticket shapes
 * plus two family shapes read MERGE-SAFE; after the fix all six read
 * NOT-MERGE-SAFE, and the 21-shape guard battery (absences, sentence
 * boundaries, relay idiom, explicit lines) keeps its prior voice.
 *
 * THE FIX (run-outcome-line.ts NEGATIVE_RE): the separator class is
 * extracted into COND_GAP_SRC — punctuation/dash now optionally close a
 * paren, and a full bounded parenthetical `\([^.)]{0,40}?\)\s*` is tolerated
 * between the token and the condition word (content may not cross a sentence
 * boundary, a closing paren, or 40 chars). A second arm (STANDING_QUALIFIER)
 * reads a positive token qualified by LIVE standing-blocker narration —
 * "SAFE TO MERGE — 2 blocking findings remain" — negative: standing blockers
 * mean "not safe yet" exactly like an unmet condition, and that shape carries
 * no condition word at all. Guards keep positive absences positive: the
 * leading `(?!no|zero|without)` lookahead and the 1-99 count slot keep "safe
 * to merge, no blockers remain" / "zero findings remain" MERGE-SAFE.
 *
 * Fail-closed direction preserved: the never-relaxed sentence-boundary rule
 * ("MERGE-SAFE. Once CI is green" — no "." in any tolerated class) and the
 * da70e157 relay idiom are pinned below; a false NOT-MERGE-SAFE costs one
 * transcript pull, a false MERGE-SAFE could merge over a blocking finding.
 */
import { extractRunVerdict, buildRunOutcomeLine, frontLoadRunOutcome } from './run-outcome-line';

describe('ticket 4baa7c3e — conditional positives inside parentheses never stamp MERGE-SAFE', () => {
  // The ticket's exact repro shapes, each verified pre-fix this lane via the
  // direct module probe on current main (cc5d68723).
  it('REPLAY: the four ticket shapes read NOT-MERGE-SAFE, never MERGE-SAFE', () => {
    expect(extractRunVerdict('SAFE TO MERGE (all good) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('The review says SAFE TO MERGE (all good) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    // The self-contradictory stamp: MERGE-SAFE over BLOCKING: 2.
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE — 2 blocking findings remain)'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });

  it('REPLAY: the producer outcome line front-loads the negative verdict, not MERGE-SAFE', () => {
    const line = buildRunOutcomeLine({
      outcome: 'completed',
      finalText: 'The review says SAFE TO MERGE (all good) once CI is green.',
    });
    expect(line).toContain('VERDICT: NOT-MERGE-SAFE');
  });

  it('the paren-window arm: bounded paren content between token and condition word', () => {
    expect(extractRunVerdict('SAFE TO MERGE (all blockers resolved) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Verdict (merge-safe) pending CI re-run').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict (MERGE-SAFE) provided the deploy probe is green').verdict).toBe('NOT-MERGE-SAFE');
    // Paren content guards: a sentence boundary or an over-long window inside
    // the paren never joins the conditional (fail-open, not fail-closed).
    expect(extractRunVerdict('MERGE-SAFE (checked. Once CI is green we ship)').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE (a very long parenthetical aside that runs well past the forty-character window) once CI is green').verdict).toBe('MERGE-SAFE');
  });

  it('the standing-qualifier arm: a positive token qualified by live blocker narration, no condition word', () => {
    expect(extractRunVerdict('SAFE TO MERGE — 2 blocking findings remain').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('The patch is merge-safe, the findings stand').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('SAFE TO MERGE — one blocker remains').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe, two issues remain unresolved').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE — the blockers still remain open').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('SAFE TO MERGE (2 blockers remain)').verdict).toBe('NOT-MERGE-SAFE');
    // …with the condition word as well (both arms compose on shape 5).
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE — 2 blocking findings remain) once CI is green')
      .verdict).toBe('NOT-MERGE-SAFE');
  });

  it('guards: positive absences keep their positive voice (no false negatives introduced)', () => {
    expect(extractRunVerdict('safe to merge, no blockers remain').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('This is safe to merge (no blockers remain).').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE — zero findings remain outstanding').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE (blocking: 0)').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE — every claim re-verified this run.').verdict).toBe('MERGE-SAFE');
  });

  // DETECTOR-RECALL REPLAY — the detector's PRIOR true positives must still
  // fire. Each pin below replays a shape that has convicted in production or
  // in a prior ticket's suite; if one stops firing, this change relaxed the
  // detector too far.
  it('DETECTOR-RECALL REPLAY: the c90958af F3 conditional shapes still read NOT-MERGE-SAFE', () => {
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. This is MERGE-SAFE, provided CI is green.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. Verdict is MERGE-SAFE (pending CI).',
    ).verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE once the flaky suite is fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE — once CI is green.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE conditional on CI green.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY: the sentence-boundary rule survives the paren widening', () => {
    // c90958af F3 boundary pin: "." joins no class — "MERGE-SAFE. Once …"
    // does not trip the conditional lane.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. This is MERGE-SAFE. Once CI is green we ship.',
    ).verdict).toBe('MERGE-SAFE');
    // …and the whole-text variant on the same boundary shape.
    expect(extractRunVerdict('VERDICT: MERGE-SAFE. Once merged, watch the deploy run.').verdict).toBe('MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY: the da70e157 relay idiom and explicit-line contracts keep their voice', () => {
    expect(extractRunVerdict(
      '- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"** — every fix re-verified by the reviewer\'s own probes.',
    ).verdict).toBe('MERGE-SAFE');
    // A quoted positive WITH a tail still declines to n/a (R2-1, 11a35cfb):
    // the tail is foreign/conditional and masks — never MERGE-SAFE.
    expect(extractRunVerdict('Final verdict: "MERGE-SAFE — 2 blocking findings remain".').verdict).toBe('n/a');
    // Explicit lines keep precedence over the whole-text fallback.
    expect(extractRunVerdict('All claims checked.\nVERDICT: MERGE-SAFE\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Findings below.\nVERDICT: NOT-MERGE-SAFE\n').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('the producer seam (frontLoadRunOutcome) stays idempotent over the new arm', () => {
    const s = frontLoadRunOutcome('Final answer text.', {
      outcome: 'completed',
      finalText: 'SAFE TO MERGE (all good) once CI is green',
    });
    expect(s.split('\n')[0]).toBe('RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 0');
    expect(s).toBe(frontLoadRunOutcome(s, { outcome: 'completed', finalText: 'x' }));
  });
});

describe('ticket 4baa7c3e round 2 — adversarial review findings 1-3 (all repros verbatim)', () => {
  // The independent reviewer of round-1 commit c154e084 delivered
  // "DO NOT MERGE — 3 blocking findings" (2026-10-18 20:59Z); every finding is
  // in the module's documented dangerous direction and every repro below is
  // the reviewer's exact input, verified to reproduce on the round-1 build
  // (tmp/probe-4baa7c3e/findings.ts) before this round's fix.
  it('F1: a close-paren COMPOSES with a following dash/comma/colon separator (the unit-composition gap)', () => {
    expect(extractRunVerdict('SAFE TO MERGE (all good) — once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('SAFE TO MERGE (all good), once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE): once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    // The worst instance: the ticket's shape-4 self-contradictory stamp, one
    // parenthetical aside away from the fixed repro.
    expect(extractRunVerdict('SAFE TO MERGE (all good) — 2 blocking findings remain'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });

  it('F2: a verdict token inside a parenthetical with a TAIL before the close still reads negative', () => {
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE — verified) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict (MERGE-SAFE, all good) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Verdict (merge-safe — verified) pending CI re-run').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F3: the STANDING arm covers the module\'s own documented reviewer idioms (d78f4850 F2 vocabulary)', () => {
    expect(extractRunVerdict('The verdict is merge-safe — blocker C stands').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — blocker F2 still stands').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('This is safe to merge — blocker C2 remains open').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('This is merge-safe, two blockers are still standing').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — two findings are still unresolved').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE (verified) — the blocker stands unresolved').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('SAFE TO MERGE (all good) — 3 blockers stand').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('round-2 guards: positive absences AND resolution narration keep their positive voice', () => {
    // Reviewer-verified absences (must never flip).
    expect(extractRunVerdict('MERGE-SAFE — 0 findings remain').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE — nil findings remain').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('safe to merge — not one blocker remains').verdict).toBe('MERGE-SAFE');
    // Round-2 resolution-tail guard (reviewer note a): "remain resolved/fixed"
    // is a RESOLUTION narration, not a standing blocker.
    expect(extractRunVerdict('merge-safe — all blockers remain fixed').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — blocker remains resolved').verdict).toBe('MERGE-SAFE');
  });

  it('round-2 condition-word boundary: no substring or cross-sentence match (the \b rail + sentence rule)', () => {
    // A condition word must match on its own word boundary — "confidence"
    // must not trip the IF arm.
    expect(extractRunVerdict('High confidence this is safe to merge').verdict).toBe('MERGE-SAFE');
    // The reviewer's B1-veto improvement survives round 2: a quoted
    // conditional reviewer positive over own positive prose declines, not MERGE-SAFE.
    expect(extractRunVerdict('Reviewer wrote: "SAFE TO MERGE (all good) once CI is green". Our fix is merge-safe.')
      .verdict).not.toBe('MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY (round 2): every round-1 pin and prior-family contract still holds', () => {    // The four ticket shapes.
    expect(extractRunVerdict('SAFE TO MERGE (all good) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('The review says SAFE TO MERGE (all good) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE — 2 blocking findings remain)'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    // The c90958af sentence-boundary rail.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. This is MERGE-SAFE. Once CI is green we ship.',
    ).verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE. Once merged, watch the deploy run.').verdict).toBe('MERGE-SAFE');
    // The da70e157 relay idiom.
    expect(extractRunVerdict(
      '- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"** — every fix re-verified by the reviewer\'s own probes.',
    ).verdict).toBe('MERGE-SAFE');
    // Quoted positive with a tail still declines (never MERGE-SAFE).
    expect(extractRunVerdict('Final verdict: "MERGE-SAFE — 2 blocking findings remain".').verdict).toBe('n/a');
    // Explicit-line precedence and the 40-char fail-open bound.
    expect(extractRunVerdict('All claims checked.\nVERDICT: MERGE-SAFE\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE (a very long parenthetical aside that runs well past the forty-character window) once CI is green').verdict).toBe('MERGE-SAFE');
  });
});

describe('ticket 4baa7c3e round 3 — adversarial review findings 1-4 at 6e7b7affb (repros verbatim)', () => {
  // The round-2 re-review (2026-10-18 21:55Z, amended) returned DO NOT MERGE
  // with 4 blocking findings; every repro below was verified reproducing on
  // 6e7b7affb before this round's fix (tmp/probe-4baa7c3e/round3.ts + round3b.ts).
  it('F1: cross-newline conditionals and standing narration stay negative (the markdown line-wrap class)', () => {
    expect(extractRunVerdict('SAFE TO MERGE (all good)\nonce CI is green').verdict).toBe('NOT-MERGE-SAFE');
    // WORSE-than-main regression the review caught: main read this negative.
    expect(extractRunVerdict('SAFE TO MERGE —\nonce CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: SAFE TO MERGE (all good)\nonce CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('SAFE TO MERGE (all good)\r\nonce CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('SAFE TO MERGE (all good)\n2 blocking findings remain'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    expect(extractRunVerdict('SAFE TO MERGE —\n2 blocking findings remain'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    expect(extractRunVerdict('SAFE TO MERGE;\n2 blocking findings remain'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    expect(extractRunVerdict('SAFE TO MERGE,\n2 blocking findings remain'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });

  it('F2/F3: the sibling reviewer idioms (d78f4850 F2 vocabulary) as qualifiers of a positive token', () => {
    expect(extractRunVerdict('merge-safe — still a blocker').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — there is still a blocker').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker is not yet fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the finding regressed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker regressed again').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker was reintroduced by the merge').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — F2 still stands').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F3: quantifiers, determiners and identifier lists as standing narration', () => {
    expect(extractRunVerdict('merge-safe — several blockers remain').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — multiple findings remain open').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('safe to merge — many concerns remain').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — numerous issues remain').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('This is safe to merge — a blocker remains').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — one more blocker remains').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — twelve blockers remain').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — blockers C and F2 stand').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('round-3 guards: absence and resolution narration over the new vocabulary keeps its positive voice', () => {
    expect(extractRunVerdict('merge-safe — no regression').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the regression was fixed').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE\nBLOCKING: 0').verdict).toBe('MERGE-SAFE');
  });

  it('round-3 sentence rail: a PERIOD before a conditional stays positive (the period is the rail; a blank line is not)', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE.\nonce CI is green we ship').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE. once CI is green').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE.\n\nonce CI is green').verdict).toBe('MERGE-SAFE');
    // A blank line before the condition reads NOT-MERGE-SAFE — this is
    // PRE-EXISTING main behavior (the arm's trailing \s* has always spanned
    // newlines; it is how round 1 caught the cross-newline class) and is the
    // fail-closed direction. The PERIOD is the sentence rail, never the
    // newline — pinned above.
    expect(extractRunVerdict('SAFE TO MERGE\n\nonce CI is green').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DETECTOR-RECALL REPLAY (round 3): rounds 1-2 and prior-family contracts still hold', () => {    // The four ticket shapes (round 1).
    expect(extractRunVerdict('SAFE TO MERGE (all good) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE — 2 blocking findings remain)'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    // Round-2 F1 composition shapes.
    expect(extractRunVerdict('SAFE TO MERGE (all good) — once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('SAFE TO MERGE (all good), once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE): once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('SAFE TO MERGE (all good) — 2 blocking findings remain'))
      .toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
    // Round-2 F2 intra-parenthetical tails.
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE — verified) once CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Verdict (merge-safe — verified) pending CI re-run').verdict).toBe('NOT-MERGE-SAFE');
    // The c90958af sentence-boundary rail and da70e157 relay idiom.
    expect(extractRunVerdict(
      'Round-1 verdict: NOT-MERGE-SAFE on three findings. All blocking findings fixed in commit abc1234. This is MERGE-SAFE. Once CI is green we ship.',
    ).verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict(
      '- **Final verdict (read this run, message 5cedea7b, 14:26Z): "VERDICT: SAFE TO MERGE"** — every fix re-verified by the reviewer\'s own probes.',
    ).verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Final verdict: "MERGE-SAFE — 2 blocking findings remain".').verdict).toBe('n/a');
    expect(extractRunVerdict('All claims checked.\nVERDICT: MERGE-SAFE\n').verdict).toBe('MERGE-SAFE');
  });
});

describe('ticket 4baa7c3e round 4 — FROZEN ADVERSARIAL CORPUS (rounds 1-4 union, the convergence proof)', () => {
  // Per the supervisor's corpus-freeze tactic (2026-10-18): every repro from
  // all review rounds + the reviewer's probe shapes, pinned as ONE block.
  // Round 4 (verdict ead249e6, 5 findings) verified reproducing at 9cfe92d20
  // (tmp/probe-4baa7c3e/round4.ts: 19 failures) before this round's fix;
  // after it the whole corpus reads green in one pass. A future change that
  // regresses ANY shape below re-opens this ticket's class.
  const NEG = 'NOT-MERGE-SAFE';
  it('corpus: blank-line-after-parenthetical conditionals (all seven condition words + CRLF + markdown)', () => {
    for (const w of ['once', 'if', 'when', 'after', 'provided', 'assuming', 'pending', 'conditional on']) {
      expect(extractRunVerdict(`SAFE TO MERGE (all good)\n\n${w} CI is green`).verdict).toBe(NEG);
    }
    expect(extractRunVerdict('SAFE TO MERGE (all good)\r\n\r\nonce CI is green').verdict).toBe(NEG);
    expect(extractRunVerdict('**VERDICT: SAFE TO MERGE** (all good)\n\nonce CI is green').verdict).toBe(NEG);
    expect(extractRunVerdict('SAFE TO MERGE —\n\nonce CI is green').verdict).toBe(NEG);
    expect(extractRunVerdict('SAFE TO MERGE (all good)\n\n2 blocking findings remain').verdict).toBe(NEG);
    expect(extractRunVerdict('SAFE TO MERGE —\n\n2 blocking findings remain').verdict).toBe(NEG);
  });
  it('corpus: quantifier compositions and identifier lists', () => {
    expect(extractRunVerdict('merge-safe — a couple of blockers remain').verdict).toBe(NEG);
    expect(extractRunVerdict('safe to merge — a couple of issues remain').verdict).toBe(NEG);
    expect(extractRunVerdict('merge-safe — blockers C, D and F2 stand').verdict).toBe(NEG);
    expect(extractRunVerdict('merge-safe — blockers C, D, E and F2 remain open').verdict).toBe(NEG);
  });
  it('corpus: standing-idiom residuals (an issue, has/have regressed, still not fixed)', () => {
    expect(extractRunVerdict('merge-safe — still an issue').verdict).toBe(NEG);
    expect(extractRunVerdict('merge-safe — still open issues').verdict).toBe(NEG);
    expect(extractRunVerdict('merge-safe — has regressed').verdict).toBe(NEG);
    expect(extractRunVerdict('merge-safe — the blocker has regressed').verdict).toBe(NEG);
    expect(extractRunVerdict('merge-safe — the findings have regressed').verdict).toBe(NEG);
    expect(extractRunVerdict('merge-safe — the blocker is still not fixed').verdict).toBe(NEG);
  });
  it('corpus: guards — absences, resolutions and the period rail keep their positive voice', () => {
    expect(extractRunVerdict('merge-safe — a couple of minutes remain on the clock').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — not an issue').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the regression was fixed').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — no regression').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE.\n\nonce CI is green we ship').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE. once CI is green').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE (blocking: 0)').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('safe to merge, no blockers remain').verdict).toBe('MERGE-SAFE');
  });
  it('corpus: full rounds 1-3 replay (every prior repro, one block)', () => {
    for (const t of [
      'SAFE TO MERGE (all good) once CI is green',
      'The review says SAFE TO MERGE (all good) once CI is green',
      'Final verdict (SAFE TO MERGE) once CI is green',
      'Final verdict (SAFE TO MERGE — 2 blocking findings remain)',
      'SAFE TO MERGE (all good) — once CI is green',
      'SAFE TO MERGE (all good), once CI is green',
      'Final verdict (SAFE TO MERGE): once CI is green',
      'SAFE TO MERGE (all good) — 2 blocking findings remain',
      'Final verdict (SAFE TO MERGE — verified) once CI is green',
      'Final verdict (MERGE-SAFE, all good) once CI is green',
      'Verdict (merge-safe — verified) pending CI re-run',
      'The verdict is merge-safe — blocker C stands',
      'merge-safe — blocker F2 still stands',
      'This is safe to merge — blocker C2 remains open',
      'This is merge-safe, two blockers are still standing',
      'merge-safe — two findings are still unresolved',
      'MERGE-SAFE (verified) — the blocker stands unresolved',
      'SAFE TO MERGE (all good) — 3 blockers stand',
      'SAFE TO MERGE (all good)\nonce CI is green',
      'SAFE TO MERGE —\nonce CI is green',
      'Final verdict: SAFE TO MERGE (all good)\nonce CI is green',
      'SAFE TO MERGE (all good)\n2 blocking findings remain',
      'SAFE TO MERGE —\n2 blocking findings remain',
      'SAFE TO MERGE;\n2 blocking findings remain',
      'SAFE TO MERGE,\n2 blocking findings remain',
      'SAFE TO MERGE (all good)\r\nonce CI is green',
      'merge-safe — still a blocker',
      'merge-safe — there is still a blocker',
      'merge-safe — the blocker is not yet fixed',
      'merge-safe — the finding regressed',
      'merge-safe — the blocker regressed again',
      'merge-safe — the blocker was reintroduced by the merge',
      'merge-safe — several blockers remain',
      'merge-safe — multiple findings remain open',
      'safe to merge — many concerns remain',
      'merge-safe — numerous issues remain',
      'This is safe to merge — a blocker remains',
      'merge-safe — one more blocker remains',
      'merge-safe — twelve blockers remain',
      'merge-safe — blockers C and F2 stand',
    ]) {
      expect(extractRunVerdict(t).verdict).toBe(NEG);
    }
    expect(extractRunVerdict('Final verdict (SAFE TO MERGE — 2 blocking findings remain) once CI is green').verdict).toBe(NEG);
  });
});

describe('ticket 4baa7c3e round 5 — reviewer findings 1-3 at 2d1fb5887 (repros verbatim)', () => {
  // Round-4 re-review (2026-10-18 23:56Z): DO NOT MERGE — 3 blocking findings,
  // all verified reproducing at 2d1fb5887 (tmp/probe-4baa7c3e/round5.ts: 14 failures)
  // before this round's fix.
  it('F1: the been gap — passive-perfect compositions of the widened idioms', () => {
    expect(extractRunVerdict('merge-safe — the blocker has not yet been fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker has not been fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — F2 has not yet been fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker has not yet been resolved').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the issues have not yet been addressed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker has been reintroduced by the merge').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker has been reintroduced').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F2: regression as a standing noun — still-slot, bare plural, remain forms', () => {
    expect(extractRunVerdict('merge-safe — still a regression').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — still regressions').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — regressions remain').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — a regression remains').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F3: the explicit-lane veto tests ONLY qualified positives — historical citations do not veto the lane\'s own explicit line', () => {
    // The close-out audit template (history paragraph, then own verdict line)
    // must keep reading MERGE-SAFE.
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — all three findings were fixed in 256c7399e.\n\nVERDICT: MERGE-SAFE\nBLOCKING: 0').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('The earlier review returned NOT-MERGE-SAFE; every finding was fixed in commit 256c7399e.\n\nVERDICT: MERGE-SAFE').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\nThe prior round was NOT MERGE-SAFE until the latch landed; it has since been fixed.').verdict).toBe('MERGE-SAFE');
    // …while the round-4 vertical-shadowing class (the reason the guard exists)
    // keeps its negative voice.
    expect(extractRunVerdict('**VERDICT: SAFE TO MERGE** (all good)\n\nonce CI is green').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\n2 blocking findings remain').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('round-5 guards: resolutions with been stay positive; the reintroduction resolution-tail guard composes', () => {
    expect(extractRunVerdict('merge-safe — the blocker has been fixed').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — all blockers have been resolved').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the regression has been fixed').verdict).toBe('MERGE-SAFE');
  });

  it('round-5 non-blocking notes folded in: cured/cleared vocabulary consistency + beyond-two-break window pinned as fail-open', () => {
    // The reviewer's vocabulary-consistency note: the resolution-tail guard
    // knows cured|cleared, so the idiom list must too.
    expect(extractRunVerdict('merge-safe — the blocker is not yet cured').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker is not yet cleared').verdict).toBe('NOT-MERGE-SAFE');
    // The beyond-two-break note: three breaks = paragraph boundary, fail-open
    // (pre-existing at r3/r4; pinned here so the bound is explicit).
    expect(extractRunVerdict('SAFE TO MERGE —\n\n\nonce CI is green').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('MERGE-SAFE:\n\n\nonce CI is green').verdict).toBe('MERGE-SAFE');
  });
});

describe('ticket 4baa7c3e round 6 — reviewer findings 1-5 of round 5 (repros verbatim)', () => {
  // Round-5 re-review (2026-10-19 00:44Z, msg 02e12401): DO NOT MERGE — 5
  // blocking findings, all verified reproducing at a26f874e4 (22 probe
  // failures) before this round's fix.
  it('F1: quantifier x passive compositions', () => {
    expect(extractRunVerdict('merge-safe — two blockers have not yet been fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — several findings have not yet been addressed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — 2 blockers have not yet been fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — a couple of blockers have not been fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — twelve blockers have not been fixed').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F2: bare-copula negated resolutions, noun-consistent', () => {
    expect(extractRunVerdict('merge-safe — the blocker was not fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker is not fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blockers were not resolved').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the issue was not addressed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — F2 was not fixed').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F3: lead-in words below the verdict line do not defeat the vertical veto', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nNote: 2 blocking findings remain').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nCaveat: the blocker is not yet fixed.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: SAFE TO MERGE\n\nCaveat: the blocker has not yet been fixed.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nHowever, 2 blocking findings remain.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nNote: F2 still stands.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F4: resolved historical citations quoting standing language do not veto the own explicit line', () => {
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — 2 blocking findings remain; both were fixed in 256c7399e.\n\nVERDICT: MERGE-SAFE\nBLOCKING: 0').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('The earlier review returned NOT-MERGE-SAFE — blockers remain; every one was fixed in 256c7399e.\n\nVERDICT: MERGE-SAFE').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Round-1 said NOT SAFE TO MERGE — blockers remain in the cold path; both were fixed since.\n\nVERDICT: MERGE-SAFE\nBLOCKING: 0').verdict).toBe('MERGE-SAFE');
  });

  it('F5: current plain negatives below the own explicit line DO veto', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\nDO NOT MERGE this yet.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\nThis is NOT safe to merge.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\nThis is NOT-MERGE-SAFE.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('round-6 guards: the standing guard stays armed where it must', () => {
    // A live round-N verdict with standing narration keeps its veto (the
    // pinned re-review-title doctrine: d78f4850's protected shapes).
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE and it still stands.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict(
      'Round-2 re-review verdict: NOT-MERGE-SAFE — the fix introduced a new race in the latch path. The three round-1 blocking findings were fixed in 256c7399e.',
    ).verdict).toBe('NOT-MERGE-SAFE');
    // A different-topic bare resolution does not discount (528da78a doctrine).
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain. Both lint errors were fixed in abc1234.').verdict).toBe('NOT-MERGE-SAFE');
    // An except-clause refuses the discount (fails closed).
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; all were fixed except F3, which remains open.').verdict).toBe('NOT-MERGE-SAFE');
    // Resolutions keep their positive voice.
    expect(extractRunVerdict('merge-safe — the blocker has been fixed').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — all blockers have been resolved').verdict).toBe('MERGE-SAFE');
  });
});

describe('ticket 4baa7c3e round 7 — reviewer findings 1-3 of round 6 (repros verbatim)', () => {
  // Round-6 re-review (2026-10-19 01:26Z, msg 5ae8f0fb): DO NOT MERGE — 3
  // blocking findings, all verified reproducing at be2492bd7 (24 probe
  // failures) before this round's fix.
  it('F1: same-sentence standing in a LATER SEMICOLON CLAUSE defeats the bare-resolution discount (positional rule)', () => {
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — 2 blocking findings remain; both were fixed in 256c7399e; the third, F3, remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — 2 blocking findings remain; both were fixed; F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; all were fixed; F3 remains open; re-probe queued.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; however, F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed in 256c7399e; except for F3, which remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('The earlier review returned NOT-MERGE-SAFE — blockers remain; both were fixed; F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; one regression remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both are fixed; F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; all have been fixed; F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; each was fixed; F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed, however F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; save for F3, which remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; aside from F3, which remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    // The F4 controls keep their historical reading (standing BEFORE the
    // resolution is the narrated-then-resolved history).
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — 2 blocking findings remain; both were fixed in 256c7399e.\n\nVERDICT: MERGE-SAFE\nBLOCKING: 0').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('The earlier review returned NOT-MERGE-SAFE — blockers remain; every one was fixed in 256c7399e.\n\nVERDICT: MERGE-SAFE').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Round-1 said NOT SAFE TO MERGE — blockers remain in the cold path; both were fixed since.\n\nVERDICT: MERGE-SAFE\nBLOCKING: 0').verdict).toBe('MERGE-SAFE');
    // Period/comma twins (standing in its own sentence) stay negative.
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed. F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed, but F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F2: the bare-copula arm is scope-guarded — out-of-scope/deferred narration stays positive', () => {
    expect(extractRunVerdict('merge-safe — not fixed by this round, but pre-existing on main (see round-3 note)').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker was not fixed by this round; it was deferred to the next ticket by the owner').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the typo was not fixed; the owner accepted it as cosmetic').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the stale lockfile warning was not fixed — pre-existing, out of scope').verdict).toBe('MERGE-SAFE');
    // Live standing keeps its veto.
    expect(extractRunVerdict('merge-safe — the blocker was not fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — F2 was not fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blockers were not resolved').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the issue was not addressed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker is not yet fixed').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('F3: lead-in shapes without punctuation stay negative (the lead-in unit tolerates em-dash and bare-word forms)', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nBut 2 blocking findings remain.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nHowever 2 blocking findings remain.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nBut the blocker is not yet fixed.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nHowever the blocker still stands.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nAlthough the tests have not been fixed.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nThough the blocker has not yet been fixed.').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nCaveat — 2 blocking findings remain').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nNote — 2 blocking findings remain').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nNote — the blocker is not yet fixed.').verdict).toBe('NOT-MERGE-SAFE');
    // Absences under lead-ins stay positive.
    expect(extractRunVerdict('merge-safe — however, no blockers remain').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n\nNote: zero blockers remain').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — but not an issue').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE.\n\nHowever, no blockers remain.').verdict).toBe('MERGE-SAFE');
  });
});

describe('ticket 4baa7c3e round 8 — round-7 review findings 1 and 4 (supervisor-scoped: findings 2+3 are the documented boundary)', () => {
  // The round-7 re-review (2026-10-19 01:34Z) returned DO NOT MERGE — 4
  // blocking findings. Per the supervisor's time-box steer this round fixes
  // ONLY findings 1 and 4 (defects in the round-7 delta itself); findings 2
  // (identifier/pronoun-led "F3 is/remains unresolved") and 3 (the
  // STANDING_QUALIFIER noun slot lacks "tests?") fail-safe to MERGE-SAFE —
  // pre-ticket main behavior, no regression — and are the DOCUMENTED BOUNDARY
  // of the bounded vocabulary, recorded for the follow-up ticket.
  it('F1: the tail-guard no longer erases live standing — "not fixed in this round; they remain open" is LIVE', () => {
    // Verified reproducing at aca47759e (probe round8.ts) before this fix.
    expect(extractRunVerdict('merge-safe — the two blockers were not fixed in this round; they remain open').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blockers were not fixed by this round; they remain open').verdict).toBe('NOT-MERGE-SAFE');
    // The mutation-proof the reviewer ran: without the round-attribution
    // tail-guard, ALL live-standing repros fire — the guard's only
    // load-bearing pin was the deferred shape, now carried by the widened
    // deferred/scope vocabulary guard (60-char window crossing semicolons).
    expect(extractRunVerdict('merge-safe — the blocker was not fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — F2 was not fixed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blockers were not resolved').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the issue was not addressed').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the blocker is not yet fixed').verdict).toBe('NOT-MERGE-SAFE');
    // The deferred/out-of-scope POS pins keep their voice (the widened guard).
    expect(extractRunVerdict('merge-safe — the blocker was not fixed by this round; it was deferred to the next ticket by the owner').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — not fixed by this round, but pre-existing on main (see round-3 note)').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the stale lockfile warning was not fixed — pre-existing, out of scope').verdict).toBe('MERGE-SAFE');
  });

  it('F4: an absence tail after a full-coverage resolution confirms the discount — it does not veto it', () => {
    // Verified reproducing at aca47759e before this fix (over-negative).
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — 2 blocking findings remain; both were fixed; no blockers remain.\n\nVERDICT: MERGE-SAFE').verdict).not.toBe('NOT-MERGE-SAFE');
    // The round-6 standing-after-resolution LIVE pins still hold (the
    // absence mask only removes absence narration, never standing).
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — 2 blocking findings remain; both were fixed in 256c7399e; the third, F3, remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('Round-1 verdict: NOT-MERGE-SAFE — blockers remain; both were fixed; however, F3 remains open.\n\nVERDICT: MERGE-SAFE').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('DOCUMENTED BOUNDARY (round-7 findings 2+3, supervisor-ruled not fixed): fail-safe to MERGE-SAFE = pre-ticket main behavior', () => {
    // Identifier/pronoun-led standing (finding 2) and the qualifier-slot
    // "tests" noun (finding 3 — the STANDING_QUALIFIER remain-forms; the
    // idioms arm's "have not been fixed" form IS covered since round 7) are
    // OUT of the bounded vocabulary by the supervisor's 01:30Z time-box
    // ruling. They read MERGE-SAFE — identical to origin/main's reading
    // (pre-existing gap, no regression) — and are recorded for the
    // follow-up ticket (structured verdict field over more regex arms),
    // LANDED as ticket b36a150e: a lane emitting the structured field
    // {"verdict":"NOT-MERGE-SAFE","blocking":N} stamps NOT-MERGE-SAFE over
    // these same sentences (see run-outcome-line.b36a150e.test.ts) WITHOUT
    // widening any regex arm — these pins are the proof the vocabulary
    // itself is unchanged.
    // Pinned so the boundary is explicit and any accidental future widening
    // shows up as a diff against these pins.
    expect(extractRunVerdict('merge-safe — F3 is unresolved').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — F3 remains unresolved').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the tests remain unfixed').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('merge-safe — the tests remain unresolved').verdict).toBe('MERGE-SAFE');
  });
});
