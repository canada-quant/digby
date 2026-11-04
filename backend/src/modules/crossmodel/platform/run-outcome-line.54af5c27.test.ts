/**
 * Ticket 54af5c27 — the hook status-line extractor hoisted QUOTED historical
 * VERDICT strings into run_completed event headers.
 *
 * First-hand shape (read fresh 2026-09-18T05:08Z by the filing lane, re-read
 * verbatim from the transcript by the fixing lane): chat 13df1406's self-audit
 * pass-2 final answer (msg 51c94696, updatedAt 05:06:23Z) carried ONE new
 * "NOT-MERGE-SAFE" occurrence vs pass 1 — a quoted historical reviewer verdict
 * inside a markdown table row ("AdminNote (read fresh) records the e8ed45c3
 * verdict: NOT-MERGE-SAFE-as-described, sole blocker B1 cured by rebase…").
 * The answer has NO line starting with VERDICT:, so the explicit-line lane
 * never matched; the whole-text NEGATIVE_RE fallback scanned the quoted table
 * content and the event header asserted VERDICT: NOT-MERGE-SAFE — the OPPOSITE
 * of the lane's actual outcome (all seven criteria hold, ticket stays done;
 * pass 1's header correctly read VERDICT: n/a).
 *
 * THE FIX (OWN-WORDS RULE in run-outcome-line.ts): extraction runs on
 * maskDerivedContent(text) — fenced code blocks, blockquote lines, markdown
 * table rows, and inline code spans are masked BEFORE any verdict/blocking
 * regex runs, so only the lane's own words can yield a verdict.
 *
 * Mutation note: the replay's primary assertions go red without the fix (the
 * un-masked whole-text scan returns NOT-MERGE-SAFE for the fixture — verified
 * by the fixing lane by temporarily neutering maskDerivedContent). The
 * counterfactual pins below assert WHY: every NOT-MERGE-SAFE occurrence in the
 * fixture lives inside a masked construct.
 */

import { extractRunVerdict, buildRunOutcomeLine, frontLoadRunOutcome } from './run-outcome-line';

/**
 * Near-verbatim excerpt of msg 51c94696 (the pass-2 final answer that produced
 * the false header): the self-audit table incl. the smoking-gun row 4, plus
 * the closing deliverable paragraph. The lane's own prose carries NO
 * merge-safety marker ("merged" / "merge" do not match the extractor's
 * MERGE-SAFE alternations — pass 1, without row 4's quote, read n/a).
 */
const PASS2_ANSWER = [
  'Self-audit complete — all seven criteria re-probed fresh in this run (harness clock 05:03:16Z). Every one holds; nothing reopened.',
  '',
  '| Criterion | Fresh evidence THIS run |',
  '|---|---|',
  '| 1. Ticket status + binding | get_feedback `5036d072-4eee-4f4c-8ad6-cf7e90744b1c`: `status: done`, `updatedAt: 2026-09-18T04:57:10.814Z` |',
  '| 4. Reviewer verdict + finding→fix in PR body | AdminNote (read fresh) records the e8ed45c3 verdict: NOT-MERGE-SAFE-as-described, sole blocker B1 cured by rebase to 0f53d65a0 (`git cherry` patch-equivalence + range-diff `1: b0c8d1ec1 = 1: 0f53d65a0`); PR body carries the B1→rebase pair + C1–C7 table |',
  '| 5. PR merged + deploy green | `gh pr view 844`: `{"state":"MERGED","mergedAt":"2026-09-18T02:44:18Z"}` |',
  '',
  '**Deliverable restated:** ticket 5036d072 shipped via PR #844 (squash 93732dbae30ab17851420ff1064737d2420aeb19, merged 02:44:18Z), deployed green by run 35300814324, live-verified, and evidence-closed (`status=done`). This run executed only read/verify probes (no new mutations), so no claims block is attached.',
].join('\n');

describe('ticket 54af5c27 replay — a quoted historical verdict never reaches the header', () => {
  it('counterfactual pins: the fixture\'s ONLY negative marker lives inside a table row', () => {
    expect(PASS2_ANSWER).toContain('NOT-MERGE-SAFE');
    const markerLines = PASS2_ANSWER.split('\n').filter((l) => /NOT[-\s]MERGE[-\s]SAFE/i.test(l));
    expect(markerLines).toHaveLength(1);
    expect(markerLines[0].trim().startsWith('|')).toBe(true);
    // …and no line opens with an explicit VERDICT: status line (the pass-1/pass-2 truth).
    expect(PASS2_ANSWER.split('\n').some((l) => /^[>\s*•\-–]*VERDICT:/i.test(l))).toBe(false);
  });

  it('the replayed pass-2 answer extracts n/a (the pass-1 truth), not the quoted NOT-MERGE-SAFE', () => {
    const out = extractRunVerdict(PASS2_ANSWER);
    expect(out.verdict).toBe('n/a');
    expect(out.blocking).toBe(0);
    expect(buildRunOutcomeLine({ outcome: 'completed', finalText: PASS2_ANSWER }))
      .toBe('RUN_OUTCOME: completed · VERDICT: n/a · BLOCKING: 0');
  });

  it('the front-loaded hook summary opens with the lane\'s own outcome', () => {
    const summary = frontLoadRunOutcome('Chat run completed. Answer: Self-audit complete…', {
      outcome: 'completed', finalText: PASS2_ANSWER,
    });
    expect(summary.split('\n')[0]).toBe('RUN_OUTCOME: completed · VERDICT: n/a · BLOCKING: 0');
  });
});

describe('quoted/derived content is masked for every extraction lane', () => {
  it('a blockquoted historical VERDICT: line is quoted content, not a status line', () => {
    const text = 'The original review concluded:\n> VERDICT: NOT-MERGE-SAFE\n> BLOCKING: 2\n\nOwn re-probe: all criteria hold.';
    expect(extractRunVerdict(text)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('a fenced code block quoting a prior RUN_OUTCOME header is masked', () => {
    const text = 'The earlier wake arrived as:\n```\nRUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 1\n```\nRe-audit: everything holds.';
    expect(extractRunVerdict(text)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('an UNTERMINATED fence masks to end-of-text (safe direction, never throws)', () => {
    const text = 'Quoting the prior verdict:\n```\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 4\n(truncated paste';
    expect(extractRunVerdict(text)).toEqual({ verdict: 'n/a', blocking: 0 });
  });

  it('an inline code span quoting a verdict string is masked', () => {
    const text = 'The parent wake read `VERDICT: NOT-MERGE-SAFE` in its header line.';
    expect(extractRunVerdict(text).verdict).toBe('n/a');
  });

  it('a BLOCKING count inside a quoted table row is not inherited', () => {
    const text = '| prior run | BLOCKING: 5 |\n\nOwn review: no blocking findings.';
    expect(extractRunVerdict(text).blocking).toBe(0);
  });
});

describe('the lane\'s OWN words still govern (masking cannot invert or mute a real verdict)', () => {
  it('a quoted historical negative does NOT override the lane\'s own explicit MERGE-SAFE', () => {
    const text = '| history | the e8ed45c3 verdict: NOT-MERGE-SAFE-as-described |\n\nAll blockers cured by the rebase.\nVERDICT: MERGE-SAFE\n';
    expect(extractRunVerdict(text).verdict).toBe('MERGE-SAFE');
  });

  it('a quoted historical positive does NOT override the lane\'s own explicit NOT-MERGE-SAFE', () => {
    const text = '> earlier draft: VERDICT: MERGE-SAFE\n\nRe-run found C3 regressed.\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 1\n';
    expect(extractRunVerdict(text)).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 1 });
  });

  it('own prose markers still scan (bf30c5d9 keyword fallback preserved)', () => {
    expect(extractRunVerdict('All eight claims hold — safe to merge.').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict("Overall this isn't MERGE-SAFE until C2 is re-run.").verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('If C5 regressed this would be NOT-MERGE-SAFE; otherwise MERGE-SAFE.').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('the LAST own explicit VERDICT: line still wins', () => {
    const text = 'Draft said VERDICT: MERGE-SAFE earlier.\n…revised…\nVERDICT: NOT-MERGE-SAFE\n';
    expect(extractRunVerdict(text).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('own BLOCKING labels still count alongside quoted tables', () => {
    const text = '| history | BLOCKING: 9 |\n- BLOCKING: C3 regresses\n- BLOCKING: C7 unverified\nVERDICT: NOT-MERGE-SAFE\n';
    expect(extractRunVerdict(text)).toEqual({ verdict: 'NOT-MERGE-SAFE', blocking: 2 });
  });
});
