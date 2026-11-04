/**
 * Review-fixer 2026-09-27 (finding B2 follow-up): the owner-visible surface
 * for refused self-renewals — `coding/renew-refusal-surface.ts`.
 *
 * A governor refusal stops a lane with a 🛑 note nobody may read (the SA0906
 * re-check files nothing on a goal-less project, its card path is
 * observe-only, a supervisor OFF switch skips the alarm). This leaf counts the
 * window's `schedule_renew_refused` rows for ONE project or ONE owner and
 * renders ONE harness line for the briefing head, the board digest and the
 * Management status card. Observed-only rows are counted separately and never
 * called "stopped". Never throws.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { SCHEDULE_RENEW_REFUSED: 'schedule_renew_refused' },
}));

const mockMetricFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockChatFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    loopMetric: { findMany: (...a: any[]) => mockMetricFindMany(...a) },
    crossModelChat: { findMany: (...a: any[]) => mockChatFindMany(...a) },
  },
}));

import {
  summarizeRenewRefusals, getRenewRefusalSummary, renewRefusalLine, renewRefusalBoardLine,
  RENEW_REFUSAL_BOARD_PREFIX, RENEW_REFUSAL_SURFACE_MAX_ROWS,
} from './renew-refusal-surface';

const row = (sessionId: string, kind: string, outcome?: string) => ({ sessionId, meta: { kind, ...(outcome ? { outcome } : {}) }, createdAt: new Date() });

beforeEach(() => {
  jest.clearAllMocks();
  mockMetricFindMany.mockReset().mockResolvedValue([]);
  mockChatFindMany.mockReset().mockResolvedValue([]);
});

describe('summarizeRenewRefusals (pure)', () => {
  it('nothing ⇒ null line, zero counts', () => {
    expect(summarizeRenewRefusals([], 24)).toEqual({ hours: 24, refused: 0, observed: 0, byKind: {}, chatIds: [], line: null });
  });

  it('refused rows are counted by kind with short chat ids; observed rows are a separate count, never "stopped"; pre-fixer rows with no outcome count as refused', () => {
    const s = summarizeRenewRefusals([
      row('aaaaaaaa-1111', 'generation_cap', 'refused'),
      row('bbbbbbbb-2222', 'no_anchor', 'refused'),
      row('aaaaaaaa-1111', 'generation_cap'),
      row('cccccccc-3333', 'no_anchor', 'observed'),
    ], 24);
    expect(s.refused).toBe(3);
    expect(s.observed).toBe(1);
    expect(s.byKind).toEqual({ generation_cap: 2, no_anchor: 1 });
    expect(s.chatIds).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    expect(s.line).toContain('Self-armed watches stopped (last 24 h, harness-measured): 3 — generation cap 2, no anchor 1 — chats aaaaaaaa, bbbbbbbb.');
    expect(s.line).toContain('The framework never re-arms a refused chain; arm a fresh schedule_self / schedule_message on the lane if the loop still matters.');
    expect(s.line).toContain('Also observed (last 24 h): 1 renewal with no open anchor still armed (observe-only; RENEW_ANCHOR_CHECK_ENFORCE=1 would have stopped it).');
  });

  it('observed-only ⇒ an "observed" line with no "stopped" claim', () => {
    const s = summarizeRenewRefusals([row('cccccccc-3333', 'no_anchor', 'observed'), row('dddddddd-4444', 'no_anchor', 'observed')], 24);
    expect(s.refused).toBe(0);
    expect(s.observed).toBe(2);
    expect(s.line).not.toContain('stopped (');
    expect(s.line).toContain('Self-armed watches observed (last 24 h): 2 renewals with no open anchor still armed');
  });

  it('caps the named chats at 6 and says how many more', () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`chat${i}xxxxxxxx`, 'generation_cap', 'refused'));
    const s = summarizeRenewRefusals(rows, 24);
    expect(s.chatIds).toHaveLength(6);
    expect(s.line).toContain('+3 more');
  });
});

describe('getRenewRefusalSummary (scoped read)', () => {
  it('reads the window\'s rows (kind + since, bounded), keeps only chats in the PROJECT scope, and renders', async () => {
    mockMetricFindMany.mockResolvedValue([row('in-1', 'generation_cap', 'refused'), row('out-1', 'generation_cap', 'refused'), row('in-2', 'no_anchor', 'observed')]);
    mockChatFindMany.mockResolvedValue([{ id: 'in-1' }, { id: 'in-2' }]);
    const s = await getRenewRefusalSummary({ scope: 'project', projectId: 'p1' }, 24);
    expect(s.refused).toBe(1);
    expect(s.observed).toBe(1);
    expect(s.chatIds).toEqual(['in-1']);
    const q = mockMetricFindMany.mock.calls[0][0];
    expect(q.where.kind).toBe('schedule_renew_refused');
    expect(q.where.createdAt.gte).toBeInstanceOf(Date);
    expect(q.take).toBe(RENEW_REFUSAL_SURFACE_MAX_ROWS);
    expect(mockChatFindMany.mock.calls[0][0].where).toEqual({ id: { in: ['in-1', 'out-1', 'in-2'] }, projectId: 'p1' });
  });

  it('USER scope filters chats by userId', async () => {
    mockMetricFindMany.mockResolvedValue([row('c1', 'generation_cap', 'refused')]);
    mockChatFindMany.mockResolvedValue([{ id: 'c1' }]);
    const s = await getRenewRefusalSummary({ scope: 'user', userId: 'u1' });
    expect(s.refused).toBe(1);
    expect(s.hours).toBe(24);
    expect(mockChatFindMany.mock.calls[0][0].where).toEqual({ id: { in: ['c1'] }, userId: 'u1' });
  });

  it('no rows ⇒ no chat read, null line', async () => {
    const s = await getRenewRefusalSummary({ scope: 'user', userId: 'u1' });
    expect(s.line).toBeNull();
    expect(mockChatFindMany).not.toHaveBeenCalled();
  });

  it('a DB error never throws — empty summary, null lines', async () => {
    mockMetricFindMany.mockRejectedValue(new Error('db gone'));
    expect((await getRenewRefusalSummary({ scope: 'user', userId: 'u1' })).line).toBeNull();
    expect(await renewRefusalLine({ scope: 'user', userId: 'u1' })).toBeNull();
    expect(await renewRefusalBoardLine({ scope: 'project', projectId: 'p1' })).toBeNull();
  });

  it('the board flavour carries the harness-measured prefix', async () => {
    mockMetricFindMany.mockResolvedValue([row('c1', 'no_anchor', 'refused')]);
    mockChatFindMany.mockResolvedValue([{ id: 'c1' }]);
    const line = await renewRefusalBoardLine({ scope: 'project', projectId: 'p1' });
    expect(line!.startsWith(`${RENEW_REFUSAL_BOARD_PREFIX} Self-armed watches stopped`)).toBe(true);
  });
});
