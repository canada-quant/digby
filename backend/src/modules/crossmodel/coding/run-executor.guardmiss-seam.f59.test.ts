/**
 * FO FIRING 59 PIN (2026-10-01) — every run-executor GUARD_MISS row must stamp
 * its seam, not just its run stamp.
 *
 * PRODUCTION EVIDENCE (firing-59 audit, 2026-10-01 02:30–06:50Z): the audit's
 * guard_4h `d` column (COALESCE(meta->>'detector', meta->>'seam',
 * meta->>'reason')) showed 12 rows reading '?' — every one a CLEAN-final
 * guard_miss (kind='guard_miss', meta carrying only run-stamp fields: model,
 * provider, profile, modelSource, triggerKind — no seam). Root cause:
 * run-executor.ts's clean-final branch passed `stamp` but NO `meta`, so
 * stampMeta() merged the run-stamp fields and nothing else — the row could
 * not be attributed to a seam, exactly the f58 class (strike rows carry
 * seam 'final_verdict'; the clean branch was blind).
 *
 * THE FIX (this firing): the clean-final branch stamps meta
 * { seam: 'final_verdict', outcome: 'clean' } — parity with the strike
 * branch's seam, and an outcome that distinguishes clean from the strike
 * outcomes ('observed' | 'enforced').
 *
 * This pin is TEXTUAL (the f58 doctrine — a unit test cannot drive the full
 * 4k-line run pipeline cheaply; the sibling pins action-verifier.f57 / f58 use
 * the same approach for seam sites): the guard_miss/guard_strike recordLoopMetric
 * call spans in run-executor.ts must each contain a `seam:` literal, and the
 * clean-final branch's ternary must carry BOTH branches' seam stamps. A future
 * edit that strips the seam from either branch fails this test.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'run-executor.ts');

/** Balanced-paren scan: the full text of every recordLoopMetric(…) call span. */
function metricSpans(src: string, needle: string): Array<{ span: string; line: number }> {
  const out: Array<{ span: string; line: number }> = [];
  let i = 0;
  while ((i = src.indexOf(needle, i)) !== -1) {
    let depth = 0;
    let j = i + needle.length - 1; // positioned at '('
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) break; }
    }
    out.push({ span: src.slice(i, j + 1), line: src.slice(0, i).split('\n').length });
    i = j + 1;
  }
  return out;
}

describe('run-executor guard_miss seam stamps (FO firing 59 — audit d="?" class)', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  it('every GUARD_MISS recordLoopMetric span in run-executor.ts stamps a seam', () => {
    const spans = metricSpans(src, 'kind: LOOP_METRIC_KINDS.GUARD_MISS');
    expect(spans.length).toBeGreaterThanOrEqual(2); // carried_receipt (L~1725) + the clean-final ternary arm (L~1831)
    const bare = spans.filter((s) => !s.span.includes('seam:'));
    expect(bare).toEqual([]); // names the offender line(s) on failure
  });

  it('the clean-final guard_miss stamps seam final_verdict + outcome clean (the fix)', () => {
    const spans = metricSpans(src, 'kind: LOOP_METRIC_KINDS.GUARD_MISS');
    const clean = spans.find((s) => s.span.includes("outcome: 'clean'"));
    expect(clean).toBeTruthy();
    expect(clean!.span).toContain("seam: 'final_verdict'");
    expect(clean!.span).toContain('stamp: runMetricStamp');
  });

  it('the strike/clean ternary stays seam-stamped on BOTH branches (f58 re-blind guard)', () => {
    const ternaryAt = src.indexOf('recordLoopMetric(guardFindings');
    expect(ternaryAt).toBeGreaterThan(-1);
    // Slice far enough to cover both ternary arms (the call is one statement).
    const slice = src.slice(ternaryAt, ternaryAt + 700);
    const strikeArm = slice.includes("kind: LOOP_METRIC_KINDS.GUARD_STRIKE")
      && slice.includes("seam: 'final_verdict'") && slice.includes("outcome: contained ? 'enforced' : 'observed'");
    const cleanArm = slice.includes('kind: LOOP_METRIC_KINDS.GUARD_MISS')
      && slice.includes("seam: 'final_verdict'") && slice.includes("outcome: 'clean'");
    expect(strikeArm).toBe(true);
    expect(cleanArm).toBe(true);
  });
});
