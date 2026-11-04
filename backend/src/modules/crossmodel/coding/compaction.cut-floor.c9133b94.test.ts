/**
 * Replay — ticket c9133b94 (owner in-chat feedback, plain chat 76263cb1:
 * "whats up with all these errors and wasted non optimized flow? why did
 * compaction lose things?").
 *
 * THE INCIDENT, as production actually recorded it. `loop_metrics` kind
 * `context_compaction`, sessionId = chat 76263cb1, run `chat-501` — three rows
 * inside 61 seconds, all `mode:'early'`:
 *
 *   18:18:11.899Z  value 32473 ms  {totalChars:20937, cutMessages:6, keptMessages:6, storedChars:0, storedItems:0, offloadStopped:true}
 *   18:19:02.832Z  value  2495 ms  {totalChars: 8373, cutMessages:4, keptMessages:7, storedChars:0, storedItems:0, offloadStopped:true}
 *   18:19:12.946Z  value  2818 ms  {totalChars: 2263, cutMessages:4, keptMessages:7, storedChars:0, storedItems:0, offloadStopped:true}
 *
 * `totalChars` is the RENDERED MIDDLE — what a pass reclaims — so each pass
 * reclaimed a SMALLER sliver while the run kept re-triggering. Three blocking
 * LLM summarizers (32.5 s on the first) bought to delete transcript that, with
 * offload stopped, was stored nowhere; the recap then tells the model to
 * "re-run the call", which is exactly what it did. That is the owner's "wasted
 * non optimized flow" and "why compaction lose things", from ONE non-convergence
 * loop rather than three separate problems.
 *
 * WHY 'early' cannot converge on that shape: it cuts the oldest third but is
 * clamped so KEEP_RECENT_MSGS survives verbatim. Once the recent window alone
 * is over the trigger, no early cut can reach it — every step reclaims a sliver
 * and re-fires.
 *
 * THE FIX (compactStepDecision, below): the first cut over the trigger stays a
 * normal productive 'early' cut; a cut that failed to land the transcript back
 * under the trigger escalates ONCE to 'full' (which takes everything down to
 * the recent window and so CAN converge); if even that leaves it over, nothing
 * converges by cutting, so stop paying and let the provider size-recovery path
 * (the 'full' compaction + shrinkLargestToolResults on a real 400/413) clip
 * instead of delete.
 */

// The module imports utility-llm (providers/env) at module scope; stub the
// heavy deps so this stays a pure-logic replay and never touches a provider.
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn() }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { CONTEXT_COMPACTION: 'context_compaction' },
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn() }));

import {
  compactStepDecision, compactionConvergenceGuardDisabled,
} from './compaction';

beforeEach(() => { delete process.env.COMPACTION_CONVERGENCE_GUARD_DISABLED; });
afterEach(() => { delete process.env.COMPACTION_CONVERGENCE_GUARD_DISABLED; });

describe('ticket c9133b94 — a repeat compaction over the trigger must stop paying', () => {
  test('REPLAY: the first cut over the trigger is the normal productive cut (unchanged behaviour)', () => {
    // Nothing has failed yet — the incident's FIRST pass (20,937 chars of middle,
    // a real cut) must still run exactly as before. A fix that skipped it would
    // trade one bug for a bigger one.
    expect(compactStepDecision({ nonConvergingCuts: 0 })).toBe('early');
  });

  test("REPLAY: the SECOND and THIRD cuts SKIP — the incident's 8,373 and 2,263-char repeats", () => {
    // Review correction (2026-11-01): an earlier draft escalated to 'full' here,
    // which is wrong. 'full' cuts to len - KEEP_RECENT_MSGS and 'early' cuts to
    // min(oldestThird, len - KEEP_RECENT_MSGS) — once the clamp binds they are
    // the SAME SPAN, so escalating reclaims nothing and pays another summariser
    // to delete the same messages. The repeat must simply not be paid for.
    expect(compactStepDecision({ nonConvergingCuts: 1 })).toBe('skip');
    expect(compactStepDecision({ nonConvergingCuts: 2 })).toBe('skip');
    expect(compactStepDecision({ nonConvergingCuts: 99 })).toBe('skip');
  });

  test('the decision is monotonic — it can never oscillate back to a shape that already failed', () => {
    const seen = [0, 1, 2, 3, 10].map((n) => compactStepDecision({ nonConvergingCuts: n }));
    expect(seen).toEqual(['early', 'skip', 'skip', 'skip', 'skip']);
  });

  test('garbage / negative state degrades to the first-cut behaviour, never to a skip', () => {
    // A wrong counter must not wedge a healthy run out of compacting at all.
    for (const bad of [NaN, -1, Infinity]) {
      expect(compactStepDecision({ nonConvergingCuts: bad as any })).not.toBe('skip');
    }
    expect(compactStepDecision({ nonConvergingCuts: NaN })).toBe('early');
  });

  test('COMPACTION_CONVERGENCE_GUARD_DISABLED=1 restores the pre-fix thrash exactly', () => {
    // The rollback must reproduce the reported behaviour byte-for-byte: every cut
    // runs, forever — i.e. the flow the owner complained about.
    process.env.COMPACTION_CONVERGENCE_GUARD_DISABLED = '1';
    expect(compactionConvergenceGuardDisabled()).toBe(true);
    for (const n of [0, 1, 2, 5, 99]) {
      expect(compactStepDecision({ nonConvergingCuts: n })).toBe('early');
    }
  });

  test('the guard permits exactly ONE paid cut before it arms — no off-by-one that restores the thrash', () => {
    // An off-by-one here silently re-enables the incident: if the second call
    // also returned 'early' the run would compact again with no new information.
    expect(compactStepDecision({ nonConvergingCuts: 0 })).toBe('early');
    expect(compactStepDecision({ nonConvergingCuts: 1 })).not.toBe('early');
  });
});