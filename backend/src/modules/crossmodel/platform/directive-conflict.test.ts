/**
 * Remediation P2 item 8 — the update_schedule directive-conflict guard,
 * replaying the 2026-09-08 21:17Z incident: a MACHINE-authored prompt rewrite
 * inserted "no decision pending" while the owner's 16:11Z directive rows were
 * still open, and the cutover never ran.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  ownerQuestion: { findMany: jest.fn(async () => []) },
  supervisorState: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  checkScheduleDirectiveConflict,
  keyTerms,
  termCoverage,
  NO_DECISION_PENDING_RE,
  DIRECTIVE_CONFLICT_WINDOW_MS,
} from './directive-conflict';

const U = 'u1';
const SCHED = 'sched-1111-2222';
const LANE = 'lane-chat-1';

/** The incident's directive (typed by the owner at 16:11Z). */
const DIRECTIVE_TEXT = 'Swap the bench lane to the Machete configuration and run the cutover once the benchmark wins';
/** The lane's standing prompt as it carried the directive. */
const OLD_PROMPT =
  'Monitor the bench lane. When the Machete configuration wins the benchmark, run the cutover: swap the lane to Machete and report the result.';
/** The 21:17Z rewrite. */
const REWRITE = 'Monitor the lane hourly and report status. No decision pending — nothing needs the owner.';

function seedDirective(atMsAgo = 5 * 3600e3) {
  mockPrisma.supervisorState.findMany.mockResolvedValue([{
    chatId: 'sup-1',
    state: {
      directives: [{ id: 'dir-16-11', text: DIRECTIVE_TEXT, at: new Date(Date.now() - atMsAgo).toISOString(), status: 'open' }],
      dispatches: [], projects: [], notes: '', refutations: [],
    },
  }]);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
  mockPrisma.supervisorState.findMany.mockResolvedValue([]);
});

const check = (over: Partial<Parameters<typeof checkScheduleDirectiveConflict>[0]> = {}) =>
  checkScheduleDirectiveConflict({
    userId: U, scheduleId: SCHED, sessionId: LANE,
    oldPrompt: OLD_PROMPT, newPrompt: REWRITE,
    ...over,
  });

describe('pure helpers', () => {
  it('keyTerms strips stopwords and short tokens', () => {
    const t = keyTerms('Swap the bench lane to the Machete configuration');
    expect(t.has('machete')).toBe(true);
    expect(t.has('the')).toBe(false);
    expect(t.has('to')).toBe(false);
  });

  it('termCoverage measures directive-term presence in a prompt', () => {
    const terms = keyTerms(DIRECTIVE_TEXT);
    expect(termCoverage(terms, OLD_PROMPT)).toBeGreaterThanOrEqual(0.5);
    expect(termCoverage(terms, 'watch unrelated things')).toBeLessThan(0.2);
  });

  it('NO_DECISION_PENDING_RE catches the incident idioms', () => {
    expect(NO_DECISION_PENDING_RE.test('No decision pending — all clear')).toBe(true);
    expect(NO_DECISION_PENDING_RE.test('nothing needs the owner')).toBe(true);
    expect(NO_DECISION_PENDING_RE.test('the owner should decide the cadence')).toBe(false);
  });
});

describe('the 21:17Z incident replay', () => {
  it('a machine rewrite that DROPS an open directive\'s key terms is refused with [DIRECTIVE CONFLICT] + metric', async () => {
    seedDirective();
    const v = await check();
    expect(v.conflict).toBe(true);
    expect(v.message).toContain('[DIRECTIVE CONFLICT]');
    expect(v.message).toContain('dir-16-1'); // names the directive
    expect(v.message).toContain('override:true');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'directive_conflict',
      sessionId: LANE,
      meta: expect.objectContaining({ overridden: false }),
    }));
  });

  it('inserting "no decision pending" while an owner QUESTION is open on the chat also refuses', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_open1234-aaaa', question: 'GO on the Machete swap?' },
    ]);
    const v = await check({ oldPrompt: 'Monitor the lane hourly.', newPrompt: 'Monitor the lane hourly. No decision pending.' });
    expect(v.conflict).toBe(true);
    expect(v.message).toContain('oq_open1234');
  });

  it('override:true + overrideReason passes (and the metric records the override)', async () => {
    seedDirective();
    const v = await check({ override: true, overrideReason: 'the owner superseded the cutover in chat this morning' });
    expect(v.conflict).toBe(false);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'directive_conflict',
      meta: expect.objectContaining({ overridden: true }),
    }));
  });

  it('override WITHOUT a reason does not pass', async () => {
    seedDirective();
    const v = await check({ override: true, overrideReason: '   ' });
    expect(v.conflict).toBe(true);
  });

  it('a rewrite that KEEPS the directive terms passes (no conflict, no metric)', async () => {
    seedDirective();
    const v = await check({
      newPrompt: 'Each firing: check the benchmark; when the Machete configuration wins, run the cutover swap on the bench lane and report.',
    });
    expect(v.conflict).toBe(false);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('a directive OUTSIDE the 72h window does not trip the guard', async () => {
    seedDirective(DIRECTIVE_CONFLICT_WINDOW_MS + 3600e3);
    const v = await check();
    expect(v.conflict).toBe(false);
  });

  it('a directive the schedule never carried does not trip the term-drop lane', async () => {
    seedDirective();
    const v = await check({ oldPrompt: 'Watch the CI dashboard for red builds.', newPrompt: 'Watch the CI dashboard for red builds and flaky tests.' });
    expect(v.conflict).toBe(false);
  });

  it('fail-OPEN: a DB error lets the update proceed', async () => {
    mockPrisma.ownerQuestion.findMany.mockRejectedValue(new Error('db down'));
    mockPrisma.supervisorState.findMany.mockRejectedValue(new Error('db down'));
    const v = await check();
    expect(v.conflict).toBe(false);
  });
});
