/**
 * WRP-1 D3-R — the fail-fast / resume arithmetic, pinned as a UNIT.
 *
 * THE DEFECT (backlog WRP-1, carried-in residual D3-R): BrightData's canonical
 * auto-throttle body states `x-brd-rate-limit-period-ms: 60000`. The resume
 * ladder shipped in #2228 (`b2050228`) is opt-in per caller through
 * `resumeBudgetMs`, and web_pipe was the only caller passing one — at 45 000 ms.
 * Measured arithmetic at that budget: `stated=60000` → `now + 60000 <=
 * deadline` is FALSE on entry → `resumeWorthIt=false` → `failFast=true` → the
 * call returns null BEFORE any attempt, so a `web_serp_resume` row for the
 * canonical shape was impossible BY CONSTRUCTION.
 *
 * THE FIX (2026-11-03) is NOT raising `SERP_PROVIDER_RETRY_WAIT_CAP_MS` (that
 * would park every interactive chat search for up to a minute — the very
 * decision ca805a61 pinned): the cap keeps governing the DEFAULT branch, and
 * web_pipe's budget alone grows to cover the canonical period
 * (`web-pipe.ts WEB_PIPE_SERP_RESUME_BUDGET_MS`).
 *
 * WHAT THIS SUITE PINS, in one place, so the decision cannot drift again:
 *   1. the canonical 60 s shape RESUMES under web_pipe's budget (D3-R closed);
 *   2. the SAME shape still FAILS FAST for a caller with no budget — the
 *      interactive contract is untouched, byte-for-byte;
 *   3. the budget is a real ceiling (a $stated wait beyond it still fails fast);
 *   4. the deterministic class fails fast at every budget;
 *   5. a 45 s budget (the OLD pipe value) refuses the canonical shape — the
 *      regression this fix exists to prevent, restated as an assertion.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { serpResumeDecision } from './mcp-search';

/** BrightData's canonical stated period, as its own throttle body prints it. */
const CANONICAL_STATED_MS = 60_000;
/** The old web_pipe budget — the defect's value, kept as the negative control. */
const OLD_PIPE_BUDGET_MS = 45_000;
/** The shipped web_pipe budget (web-pipe.ts WEB_PIPE_SERP_RESUME_BUDGET_MS). */
const PIPE_BUDGET_MS = 70_000;

/** Decide as the ladder does: the deadline is stamped ONCE at tier entry. */
function decide(statedWaitMs: number, budgetMs: number, now = 1_000_000) {
  return serpResumeDecision({
    retryable: true,
    statedWaitMs,
    budgetMs,
    resumeDeadline: now + budgetMs,
    now,
  });
}

describe('WRP-1 D3-R — canonical 60 s throttle vs the resume ladder', () => {
  it('the canonical 60 s shape RESUMES under web_pipe\'s budget (D3-R closed)', () => {
    const d = decide(CANONICAL_STATED_MS, PIPE_BUDGET_MS);
    expect(d.resumeWorthIt).toBe(true);
    expect(d.failFast).toBe(false);
  });

  it('the OLD 45 s pipe budget REFUSED the canonical shape — the defect, restated', () => {
    const d = decide(CANONICAL_STATED_MS, OLD_PIPE_BUDGET_MS);
    expect(d.resumeWorthIt).toBe(false);
    expect(d.failFast).toBe(true);
  });

  it('the interactive caller (no budget) still fails FAST on the canonical shape — ca805a61 intact', () => {
    const d = decide(CANONICAL_STATED_MS, 0);
    expect(d.resumeWorthIt).toBe(false);
    expect(d.failFast).toBe(true);
  });

  it('the same holds for every stated wait a query-ban can carry', () => {
    // The vendor's documented 15 s query-ban floor, the old 45 s boundary, and
    // the canonical 60 s: interactive fails fast on all three, the pipe resumes
    // on all three. A 9 s wait is included because it is the smallest stated
    // wait that exceeds the 8 s cap.
    for (const stated of [9_000, 15_000, 45_000, CANONICAL_STATED_MS]) {
      expect({ stated, ...decide(stated, 0) }).toMatchObject({ failFast: true });
      expect({ stated, ...decide(stated, PIPE_BUDGET_MS) }).toMatchObject({ failFast: false, resumeWorthIt: true });
    }
  });

  it('the budget is a real ceiling: a stated wait beyond it still fails fast', () => {
    // 70 s stated against a 70 s budget: `now + 70_000 <= deadline` is true at
    // the exact instant of entry (deadline === now + budget) — the boundary is
    // inclusive BY DESIGN (a wait that exactly fits is still a wait that fits).
    expect(decide(PIPE_BUDGET_MS, PIPE_BUDGET_MS).failFast).toBe(false);
    // One millisecond over the budget is refused.
    expect(decide(PIPE_BUDGET_MS + 1, PIPE_BUDGET_MS).failFast).toBe(true);
    // A stated wait far past any pipe budget is refused.
    expect(decide(600_000, PIPE_BUDGET_MS).failFast).toBe(true);
  });

  it('a wait already partly elapsed still resumes — the deadline, not the budget, decides', () => {
    // The direct tier may spend 8 s before the gateway tier stamps its
    // deadline, so the budget must exceed the stated wait by a margin; this
    // pins that the comparison uses the real clock, not the raw budget.
    const now = 5_000_000;
    const deadline = now + PIPE_BUDGET_MS;
    expect(serpResumeDecision({ retryable: true, statedWaitMs: 60_000, budgetMs: PIPE_BUDGET_MS, resumeDeadline: deadline, now }).failFast).toBe(false);
    // 20 s into the call the SAME 60 s wait no longer fits → fail fast.
    expect(serpResumeDecision({ retryable: true, statedWaitMs: 60_000, budgetMs: PIPE_BUDGET_MS, resumeDeadline: deadline, now: now + 20_000 }).failFast).toBe(true);
  });

  it('the deterministic class fails fast at EVERY budget — retrying cannot help', () => {
    for (const budget of [0, OLD_PIPE_BUDGET_MS, PIPE_BUDGET_MS]) {
      const d = serpResumeDecision({
        retryable: false,
        statedWaitMs: 0,
        budgetMs: budget,
        resumeDeadline: 1_000_000 + budget,
        now: 1_000_000,
      });
      expect(d.failFast).toBe(true);
      expect(d.resumeWorthIt).toBe(false);
    }
  });

  it('a stated wait UNDER the 8 s cap is ordinary retry, never a fail-fast — with or without a budget', () => {
    for (const budget of [0, PIPE_BUDGET_MS]) expect(decide(3_000, budget).failFast).toBe(false);
  });
});