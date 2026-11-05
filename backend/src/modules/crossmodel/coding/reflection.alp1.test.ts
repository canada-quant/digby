/**
 * ALP-1 INTEGRATION — the breaker FILER's observe-only attribution, end to end
 * through `fileStreakInvestigation` (backlog §ALP-1; tickets 921013a5 →
 * d8395cca). `repro-attribution.alp1.test.ts` pins the leaf's contract; this
 * file pins what actually reaches the ROW and the TELEMETRY when a real trip
 * files.
 *
 * THE THREE LEGS THE GATE ASKS FOR:
 *   tagged adjudication probe → row carries reproOf + one guard_strike row;
 *   untagged trip             → context byte-identical to pre-change, zero rows;
 *   genuine refusal           → files exactly as today, no attribution.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => ({ userId: 'u1', title: 'Adjudication lane' }));
const mockTicketCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'newly-filed' }));
const mockFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    userFeatureRequest: {
      create: (...a: any[]) => mockTicketCreate(...a),
      findFirst: (...a: any[]) => mockFindFirst(...a),
    },
  },
}));

const mockRedisSet = jest.fn(async (..._a: any[]): Promise<any> => 'OK');
const mockRedisGet = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: (...a: any[]) => mockRedisSet(...a), get: (...a: any[]) => mockRedisGet(...a) },
}));

// The attach arm is exercised elsewhere; here it must simply decline so the
// plain create path runs (the path every trip with no structural class takes —
// which is exactly the d8395cca shape: a plain 'failure' streak).
jest.mock('../feedback/adjudicated-class-attach', () => ({
  __esModule: true,
  bumpAdjudicatedClassSighting: jest.fn(async () => null),
}));

const mockRecordLoopMetric = jest.fn((..._a: any[]): void => undefined);
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
}));

import { fileStreakInvestigation } from './reflection';

/** The ticket_lane binding the dispatcher writes (ticket-dispatch.service.ts). */
const LANE_ROW = {
  id: '921013a5',
  context: { dispatchMode: 'ticket_lane', dispatchedTo: '350827a9', dispatchedAt: '2026-11-05T00:18:33Z' },
};

const EV = {
  sessionId: '350827a9',
  runId: 'run-1',
  tool: 'update_feedback',
  perma: false,
  intended: 'run_command',
  recentFailures: ['Tool update_feedback failed: no such ticket "a930d169"'],
  recentArgs: ['{"ticketId":"a930d169"}'],
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.REPRO_ATTRIBUTION_DISABLED;
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', title: 'Adjudication lane' });
  mockTicketCreate.mockResolvedValue({ id: 'newly-filed' });
  mockRedisSet.mockResolvedValue('OK');
  mockRedisGet.mockResolvedValue(null);
  mockFindFirst.mockResolvedValue(null);
});
afterEach(() => {
  delete process.env.REPRO_ATTRIBUTION_DISABLED;
});

describe('ALP-1 integration — a TAGGED adjudication probe', () => {
  it('files its ticket anyway (nothing suppressed) and stamps reproOf + evidence', async () => {
    mockFindFirst.mockResolvedValue(LANE_ROW);
    const id = await fileStreakInvestigation(EV as any);

    // LEG 1 — the trip is NOT exempted: the row is still created.
    expect(mockTicketCreate).toHaveBeenCalledTimes(1);
    expect(id).toBe('newly-filed');

    // LEG 2 — attribution lands in the filed context, next to (not instead of)
    // the existing fields.
    const ctx = mockTicketCreate.mock.calls[0][0].data.context;
    expect(ctx.reproOf).toBe('921013a5');
    expect(ctx.reproOfEvidence).toBe('dispatched_ticket_lane');
    expect(ctx.sessionId).toBe('350827a9');
    expect(ctx.about).toBe('digby_platform');
    expect(ctx.breakerShape).toBe('failure');
    // The title/description are UNCHANGED by attribution — the same
    // framework-vs-model mandate and the same recorded probes.
    const data = mockTicketCreate.mock.calls[0][0].data;
    expect(data.title).toContain('3× tool-failure streak');
    expect(data.description).toMatch(/DETERMINISTIC framework/);
    expect(data.description).toContain('a930d169');
  });

  it('emits exactly ONE observe-only guard_strike row naming the repro ticket', async () => {
    mockFindFirst.mockResolvedValue(LANE_ROW);
    await fileStreakInvestigation(EV as any);
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    const m = mockRecordLoopMetric.mock.calls[0][0];
    expect(m.kind).toBe('guard_strike');
    expect(m.sessionId).toBe('350827a9');
    expect(m.runId).toBe('run-1');
    expect(m.meta).toMatchObject({
      seam: 'repro_attribution',
      state: 'filing_with_repro_of',
      tool: 'update_feedback',
      shape: 'failure',
      reproOf: '921013a5',
      reproEvidence: 'dispatched_ticket_lane',
    });
  });
});

describe('ALP-1 integration — an UNTAGGED trip is byte-identical to today', () => {
  it('no dispatch binding ⇒ no reproOf key and ZERO metric rows', async () => {
    mockFindFirst.mockResolvedValue(null); // no ticket_lane binding
    await fileStreakInvestigation(EV as any);

    const ctx = mockTicketCreate.mock.calls[0][0].data.context;
    // The pre-change field set, EXACTLY — no empty-string placeholder, no key.
    expect(Object.keys(ctx).sort()).toEqual(
      ['about', 'breakerShape', 'filedAt', 'runId', 'sessionId', 'surface'].sort(),
    );
    expect('reproOf' in ctx).toBe(false);
    expect('reproOfEvidence' in ctx).toBe(false);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('a row bound to a DIFFERENT lane never attributes this session', async () => {
    // The dispatcher's row exists but dispatchMode is not ticket_lane.
    mockFindFirst.mockResolvedValue({ id: '921013a5', context: { dispatchMode: 'owner_dispatch', dispatchedTo: '350827a9' } });
    await fileStreakInvestigation(EV as any);
    const ctx = mockTicketCreate.mock.calls[0][0].data.context;
    expect('reproOf' in ctx).toBe(false);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});

describe('ALP-1 integration — a GENUINE refusal keeps counting', () => {
  it('a refusal-shaped trip with no ticket lane files untouched and unattributed', async () => {
    // run_command refusals never reach the dispatcher, so no lane row is
    // returned: attribution cannot attach, and the ticket still files.
    mockFindFirst.mockResolvedValue(null);
    const refusalEv = {
      ...EV,
      sessionId: 'genuine-refusal',
      tool: 'run_command',
      intended: undefined,
      recentFailures: ['Refused: the command was not on the allowlist (no approval path matched)'],
    };
    await fileStreakInvestigation(refusalEv as any);

    expect(mockTicketCreate).toHaveBeenCalledTimes(1);
    const ctx = mockTicketCreate.mock.calls[0][0].data.context;
    expect('reproOf' in ctx).toBe(false);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    expect(mockTicketCreate.mock.calls[0][0].data.description).toContain('not on the allowlist');
  });
});

describe('ALP-1 integration — the switch restores the exact pre-change filing', () => {
  it('REPRO_ATTRIBUTION_DISABLED=1 ⇒ no read, no field, no metric row', async () => {
    process.env.REPRO_ATTRIBUTION_DISABLED = '1';
    mockFindFirst.mockResolvedValue(LANE_ROW); // would attribute if it were read
    await fileStreakInvestigation(EV as any);

    expect(mockFindFirst).not.toHaveBeenCalled(); // the OFF half performs no read
    const ctx = mockTicketCreate.mock.calls[0][0].data.context;
    expect('reproOf' in ctx).toBe(false);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    expect(mockTicketCreate).toHaveBeenCalledTimes(1); // filing still happens
  });
});

describe('ALP-1 integration — attribution never costs a filing', () => {
  it('an attribution read failure still files the untouched row', async () => {
    mockFindFirst.mockRejectedValue(new Error('db down'));
    const id = await fileStreakInvestigation(EV as any);
    expect(mockTicketCreate).toHaveBeenCalledTimes(1);
    expect(id).toBe('newly-filed');
    expect('reproOf' in mockTicketCreate.mock.calls[0][0].data.context).toBe(false);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});