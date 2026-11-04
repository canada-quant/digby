/**
 * Ticket 141d9d92 — the cross-turn repeated-line break's auto-filed ticket
 * mislabeled its own class (d73765fc's fixed-text-mislabel family, one shape
 * it missed). The incident (this lane's run d8b0521b, 2026-09-24): the run
 * re-emitted the identical per-ticket table row
 *   "| P2 1df1fe00 — red-window merge guard | **Not started.** | — |"
 * across 6 continuation turns; the 03587322 guard correctly ended the run,
 * but the auto-file opened as
 *   "3× tool-failure streak: final_text on …Digby's Nightly Self-Improvement…"
 * — naming a tool that DOES NOT EXIST ('final_text' is a synthetic label)
 * and a "tool-failure" class where no tool had failed, sending the
 * investigator (this lane) to "diff the failure texts against recent
 * final_text/harness changes" — a wild-goose chase.
 *
 * Pins the RENDERING bytes of the filing for the narration_repeat shape:
 *   (i)   the title renders the repeat count and the narration-repeat class,
 *         never "tool-failure streak", never the synthetic tool name;
 *   (ii)  the description says the guard is the cross-turn line-repeat break,
 *         names the synthetic label, and headers the evidence as the
 *         "Repeated narration line" (not "Failure texts");
 *   (iii) the legacy shapes keep their bytes EXACTLY (failure → "3×
 *         tool-failure streak", success_intent → "5× success-side wrong-tool
 *         loop") — every other filing site rides those defaults;
 *   (iv)  the framework-vs-model mandate text is unchanged.
 *
 * The loop-side threading (shape + repeats arrive at the filing) is pinned
 * in agent-derail-break.03587322.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindUnique: jest.Mock = jest.fn();
const mockCreate: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: (...a: any[]) => mockFindUnique(...a) },
    userFeatureRequest: { create: (...a: any[]) => mockCreate(...a) },
  },
}));

const mockRedisSet: jest.Mock = jest.fn();
const mockRedisGet: jest.Mock = jest.fn();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockRedisSet(...a),
    get: (...a: any[]) => mockRedisGet(...a),
    del: jest.fn(),
  },
}));

jest.mock('./coding-model', () => ({
  __esModule: true,
  resolveRoleModelForRun: jest.fn(),
  resolveProviderForRun: jest.fn(),
}));
jest.mock('./helper-completion', () => ({
  __esModule: true,
  postNonStreamingCompletion: jest.fn(),
  extractNonStreamingAnswer: jest.fn(),
}));

import { fileStreakInvestigation } from './reflection';
import type { StreakEvidence } from './reflection';

const INCIDENT_LINE = '| P2 1df1fe00 — red-window merge guard | **Not started.** | — |';

const NARRATION_EVIDENCE: StreakEvidence = {
  sessionId: 'b92ef13f', runId: 'run-d8b0521b', tool: 'final_text', perma: false,
  intended: null,
  recentFailures: [INCIDENT_LINE],
  goalHint: 'R&D STREAM 1 — nightly self-improvement cycle',
  shape: 'narration_repeat',
  repeats: 6,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUnique.mockResolvedValue({ userId: 'u1', title: "Digby's Nightly Self-Improvement Engineer" });
  mockCreate.mockResolvedValue({ id: 'ticket-141d9d92-1' });
  mockRedisSet.mockResolvedValue('OK');
  mockRedisGet.mockResolvedValue(null);
});

describe('ticket 141d9d92 — narration-repeat filings render their true class', () => {
  it('(i) the title names the repeat count and class; never "tool-failure streak", never the synthetic tool name', async () => {
    await fileStreakInvestigation(NARRATION_EVIDENCE);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.type).toBe('mishap');
    expect(data.source).toBe('agent-harness');
    expect(data.title).toBe(`6× narration-repeat run-end: "Digby's Nightly Self-Improvement Enginee" — framework or model?`);
    expect(data.title).not.toContain('tool-failure streak');
    expect(data.title).not.toContain('final_text');
  });

  it('(ii) the description names the guard, the synthetic label, and headers the evidence as the repeated line', async () => {
    await fileStreakInvestigation(NARRATION_EVIDENCE);

    const data = mockCreate.mock.calls[0][0].data;
    expect(data.description).toContain('cross-turn narration-repeat break (ticket 03587322 guard) — no tool failed');
    // PR #1033 review B1: the label must ACTUALLY render (the first cut left a
    // dangling "the synthetic label is" clause with the label nowhere).
    expect(data.description).toContain(`synthetic label 'final_text'`);
    expect(data.description).toContain('first streak this run');
    expect(data.description).toContain('Repeated narration line:');
    expect(data.description).not.toContain('Failure texts (newest first)');
    // The verbatim incident line rides through unmodified.
    expect(data.description).toContain(INCIDENT_LINE);
  });

  it('(iii) legacy shapes keep their bytes exactly — failure and success_intent unchanged', async () => {
    await fileStreakInvestigation({
      sessionId: 'sess-f', tool: 'update_schedule', perma: false,
      recentFailures: ['Tool update_schedule failed: not found'],
    });
    expect(mockCreate.mock.calls[0][0].data.title).toBe(`3× tool-failure streak: update_schedule on "Digby's Nightly Self-Improvement Enginee" — framework or model?`);

    jest.clearAllMocks();
    await fileStreakInvestigation({
      sessionId: 'sess-s', tool: 'search_memory', perma: false, intended: 'web_pipe',
      recentFailures: ['search_memory succeeded ×5 while reasoning named web_pipe'],
      shape: 'success_intent',
    });
    expect(mockCreate.mock.calls[0][0].data.title).toBe(`5× success-side wrong-tool loop: search_memory on "Digby's Nightly Self-Improvement Enginee" — framework or model?`);
  });

  it('(iv) the framework-vs-model mandate is unchanged in the narration shape', async () => {
    await fileStreakInvestigation(NARRATION_EVIDENCE);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.description).toContain('INVESTIGATE: determine whether a DETERMINISTIC framework/schema/preflight/guard issue');
    expect(data.description).toContain('record it as model behavior WITH evidence');
  });
});
