/**
 * Ticket bf30c5d9 (MAST FM-2.4) — child result-hook wakes truncated the child's
 * final answer so a reviewer sub-session's verdict TAIL (per-claim table,
 * MERGE-SAFE / NOT-MERGE-SAFE, blocking findings) never reached the parent.
 * First-hand replay: parent b92ef13f's run_completed wake from reviewer
 * b1f74238 arrived cut mid-sentence; the C1–C8 verdict block was beyond the cut.
 *
 * The defect is TWO cuts, and the replay below exercises both:
 *   1. the producers' 300-char "Final answer:" / "Answer:" slice
 *      (run-executor.ts / chat-agent.service.ts), and
 *   2. hooks.service truncateSummary's SUMMARY_CAP = 2000.
 * The fix front-loads `RUN_OUTCOME: <outcome> · VERDICT: <v> · BLOCKING: <n>`
 * (extracted from the FULL final answer BEFORE any slicing) as the summary's
 * first line, so no downstream cut can take the verdict.
 *
 * Mutation note: every primary assertion below goes red without
 * run-outcome-line.ts (the prefix simply never appears); the counterfactual
 * block in the replay test pins WHY (the un-prefixed wake loses the verdict).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  eventHook: { findMany: jest.fn() },
  hookEvent: { create: jest.fn(async () => ({})) },
  crossModelChat: { findUnique: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// Module-load boundaries hooks.service pulls but this replay never exercises.
jest.mock('../crossmodel.service', () => ({ __esModule: true, default: { getChatAccess: jest.fn() } }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: jest.fn(async () => ({ started: true })),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
  notifyDailyCapOnce: jest.fn(async () => {}),
  claimCapWindowGate: jest.fn(async () => true),
}));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked',
    GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
    HOOK_STALE_SUPPRESSED: 'hook_stale_suppressed',
    HOOK_QUIET_EVENT_SHED: 'hook_quiet_event_shed',
  },
}));

import { emitHookEvent, truncateSummary, renderPrompt, CHILD_RESULT_PROMPT_TEMPLATE } from './hooks.service';
import {
  RUN_OUTCOME_PREFIX, extractRunVerdict, buildRunOutcomeLine, frontLoadRunOutcome,
} from './run-outcome-line';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({
    title: 'Reviewer sub-session', userId: 'u1', projectId: null, isProjectSupervisor: false, project: null,
  });
  mockPrisma.eventHook.findMany.mockResolvedValue([
    { id: 'h-child', userId: 'u1', sourceChatId: 'c-child', targetChatId: 'c-parent', projectId: null, eventTypes: ['run_completed'], enabled: true },
  ]);
});

describe('extractRunVerdict (unit)', () => {
  it('reads an explicit VERDICT: line', () => {
    expect(extractRunVerdict('All claims checked.\nVERDICT: MERGE-SAFE\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Findings below.\nVERDICT: NOT-MERGE-SAFE\n').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('the LAST explicit VERDICT: line wins (a final word beats an early quoted one)', () => {
    const text = 'Draft said VERDICT: MERGE-SAFE earlier.\n…revised…\nVERDICT: NOT-MERGE-SAFE\n';
    expect(extractRunVerdict(text).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('with no explicit line, a negative marker anywhere beats a positive one (safe direction)', () => {
    const text = 'If C5 regressed this would be NOT-MERGE-SAFE; otherwise MERGE-SAFE.';
    expect(extractRunVerdict(text).verdict).toBe('NOT-MERGE-SAFE');
  });

  it('positive-only markers read MERGE-SAFE; no markers read n/a', () => {
    expect(extractRunVerdict('All eight claims hold — safe to merge.').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('Summarized the docs and answered the question.').verdict).toBe('n/a');
  });

  it('reviewer f5bdeaf3 O1 repro: off-format negative/conditional phrasings must NOT read MERGE-SAFE', () => {
    // The exact false-MERGE-SAFE edges the adversarial reviewer reproduced
    // (pre-hardening each of these extracted MERGE-SAFE — the unsafe direction).
    expect(extractRunVerdict('C4 fails.\nVERDICT: CANNOT SHIP\n').verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict("Fix the regression first.\nVERDICT: WON'T SHIP\n").verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict("Overall this isn't MERGE-SAFE until C2 is re-run.").verdict).toBe('NOT-MERGE-SAFE');
    expect(extractRunVerdict('VERDICT: MERGE-SAFE once the flaky suite is fixed\n').verdict).toBe('NOT-MERGE-SAFE');
  });

  it('hardening keeps clean positives (regression guards)', () => {
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n').verdict).toBe('MERGE-SAFE');
    // A conditional word behind a sentence boundary is NOT a conditional verdict.
    expect(extractRunVerdict('VERDICT: MERGE-SAFE. Once merged, watch the deploy run.\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('All six claims confirmed.\nVERDICT: SHIP IT\n').verdict).toBe('MERGE-SAFE');
    expect(extractRunVerdict('All eight claims hold — safe to merge.').verdict).toBe('MERGE-SAFE');
  });

  it('BLOCKING count: an explicit "BLOCKING: n" line wins; else labeled lines are counted', () => {
    expect(extractRunVerdict('VERDICT: NOT-MERGE-SAFE\nBLOCKING: 3\n').blocking).toBe(3);
    expect(extractRunVerdict('- BLOCKING: C3 regresses\n- BLOCKING: C7 unverified\n').blocking).toBe(2);
    expect(extractRunVerdict('VERDICT: MERGE-SAFE\n').blocking).toBe(0);
  });
});

describe('frontLoadRunOutcome (unit)', () => {
  it('prepends the status line as the FIRST line and keeps the summary intact', () => {
    const out = frontLoadRunOutcome('Coding run completed. Final answer: ok', { outcome: 'completed', finalText: 'ok\nVERDICT: MERGE-SAFE' });
    expect(out.split('\n')[0]).toBe('RUN_OUTCOME: completed · VERDICT: MERGE-SAFE · BLOCKING: 0');
    expect(out).toContain('Coding run completed. Final answer: ok');
    // The status line is short enough to survive ANY downstream cut (~200 chars).
    expect(out.split('\n')[0].length).toBeLessThan(120);
  });

  it('is idempotent — a re-wrap never double-prefixes', () => {
    const once = frontLoadRunOutcome('x', { outcome: 'completed', finalText: '' });
    expect(frontLoadRunOutcome(once, { outcome: 'completed', finalText: '' })).toBe(once);
  });

  it('run_failed carries the outcome with no verdict; overrides are honored (GUARD-REPLACED)', () => {
    expect(buildRunOutcomeLine({ outcome: 'failed' })).toBe('RUN_OUTCOME: failed · VERDICT: n/a · BLOCKING: 0');
    expect(buildRunOutcomeLine({ outcome: 'completed', verdictOverride: 'GUARD-REPLACED' }))
      .toBe('RUN_OUTCOME: completed · VERDICT: GUARD-REPLACED · BLOCKING: 0');
  });
});

describe('ticket bf30c5d9 replay — the verdict tail survives BOTH cuts', () => {
  // Reviewer-style final answer: a long narrative head, then the C1–C8 verdict
  // block PAST char 2000 (the ticket's first-hand shape — the wake arrived cut
  // mid-sentence with the whole verdict block beyond the cut).
  const verdictTail =
    '\nVERDICT: NOT-MERGE-SAFE\nBLOCKING: 2\n' +
    '- BLOCKING: C3 — the fix does not cover the wildcard lane\n' +
    '- BLOCKING: C7 — claim cites a deploy run that never terminalled\n' +
    'C1 ok · C2 ok · C4 ok · C5 ok · C6 ok · C8 ok\n';
  const delivered = `Review of the diff follows. ${'Per-claim analysis narrative. '.repeat(90)}${verdictTail}`;
  it('the verdict block really does live past both cuts in this fixture', () => {
    expect(delivered.length).toBeGreaterThan(2000);
    expect(delivered.indexOf('VERDICT:')).toBeGreaterThan(2000);
  });

  it('replays the defect: the UN-prefixed wake loses the entire verdict tail', () => {
    // Counterfactual — the pre-fix producer shape (300-char slice, no prefix).
    const legacySummary = `Coding run completed. Final answer: ${delivered.replace(/\s+/g, ' ').slice(0, 300)}`;
    expect(legacySummary).not.toContain('NOT-MERGE-SAFE');
    expect(legacySummary).not.toContain('BLOCKING');
  });

  it('the stored hook-event summary opens with the extracted verdict, and the child-result wake renders it in its head', async () => {
    // Producer shape AFTER the fix: slice for the body, extract from the FULL final.
    const summary = frontLoadRunOutcome(
      `Coding run completed. Final answer: ${delivered.replace(/\s+/g, ' ').slice(0, 300)}`,
      { outcome: 'completed', finalText: delivered },
    );
    expect(summary.split('\n')[0]).toBe('RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 2');
    // The sliced body still never reaches the tail — the prefix is the ONLY carrier.
    expect(summary).not.toContain('C3 —');

    await emitHookEvent('c-child', 'run_completed', summary, { runId: 'r1' });
    expect(mockPrisma.hookEvent.create).toHaveBeenCalledTimes(1);
    const stored = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload;
    expect(stored.summary.split('\n')[0]).toBe('RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 2');

    // The parent's wake (CHILD_RESULT_PROMPT_TEMPLATE) renders the line in its first 200 chars.
    const wake = renderPrompt(CHILD_RESULT_PROMPT_TEMPLATE, {
      eventType: 'run_completed', sourceChatTitle: 'Reviewer sub-session', sourceChatId: 'c-child', summary: stored.summary,
    });
    expect(wake.slice(0, 200)).toContain('RUN_OUTCOME: completed · VERDICT: NOT-MERGE-SAFE · BLOCKING: 2');
  });

  it('the status line also survives the 2000-char truncateSummary cap', () => {
    const huge = frontLoadRunOutcome(`Coding run completed. ${'x'.repeat(2600)}`, {
      outcome: 'completed', finalText: `body\nVERDICT: MERGE-SAFE`,
    });
    const stored = truncateSummary(huge); // the hooks.service emission cut
    expect(stored.startsWith('RUN_OUTCOME: completed · VERDICT: MERGE-SAFE · BLOCKING: 0\n')).toBe(true);
    expect(stored).toContain('…[truncated');
  });

  it('run_failed summaries carry the line too (outcome front-loaded for parsers)', async () => {
    const summary = frontLoadRunOutcome('Coding run failed: provider 500', { outcome: 'failed' });
    await emitHookEvent('c-child', 'run_failed', summary, { runId: 'r2' });
    const stored = mockPrisma.hookEvent.create.mock.calls[0][0].data.payload;
    expect(stored.summary.split('\n')[0]).toBe('RUN_OUTCOME: failed · VERDICT: n/a · BLOCKING: 0');
  });
});
