/**
 * GOAL-OUTCOME-UNMET part 2 (architecture review #3, 2026-10-20): a goal
 * closed while its OWN outcome bar is unmet (the KPI of record below its bar)
 * keeps its project LIVE with no 7-day limit — until the KPI / target value
 * or its bar changes (the close record's fingerprint drifts) or the owner
 * closes it explicitly. A close with no record predates the change and is not
 * live beyond the 7-day suspect window. Kill switch GOAL_OUTCOME_CHECK_DISABLED=1.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGoalFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelProject: { findUnique: jest.fn(async () => ({ id: 'p1', name: 'tt-rd', archivedAt: null, userId: 'u1' })) },
    crossModelChat: { findMany: jest.fn(async () => [{ id: 'c1' }]) },
    projectGoal: { count: jest.fn(async () => 0), findMany: (...a: any[]) => mockGoalFindMany(...a) },
    hookEvent: { findMany: jest.fn(async () => []) },
    supervisorState: { findUnique: jest.fn(async () => null) },
    projectTodo: { count: jest.fn(async () => 0) },
    agentRun: { count: jest.fn(async () => 0) },
    watchedResource: { count: jest.fn(async () => 0) },
    chatSchedule: { count: jest.fn(async () => 0) },
  },
}));
const store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => store.get(`${ns.join(':')}/${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, v: any) => { store.set(`${ns.join(':')}/${key}`, v); }),
}));

import { evaluateProjectDormancy, DORMANCY_DONE_SUSPECT_WINDOW_MS } from './dormancy-gate.service';
import { goalOutcomeFingerprint, recordGoalOutcomeClose } from '../platform/goal-outcome';

const KPI = { key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', bar: 10, history: [{ value: 3.44 }] };
const OLD_CLOSE = { id: 'g-old', premises: [KPI] };

/** The (c) 7-day read returns nothing; the (e) older-closes read returns `older`. */
function older(rows: any[]) {
  mockGoalFindMany.mockImplementation(async (args: any) => (args?.where?.updatedAt?.lt ? rows : []));
}
const closeRecord = (over: any = {}) => ({
  fingerprint: goalOutcomeFingerprint([KPI]), reasons: ['kpi_bar_unmet'], seam: 'auto', actorKind: 'harness',
  at: new Date(Date.now() - 10 * 86_400_000).toISOString(), ownerAccepted: false, ...over,
});

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  mockGoalFindMany.mockImplementation(async () => []);
  delete process.env.GOAL_OUTCOME_CHECK_DISABLED;
  delete process.env.DORMANCY_LIVE_SIGNALS_DISABLED;
});

describe('part 2 — an outcome-unmet close keeps the project live past 7 days', () => {
  it('a 10-day-old close with the KPI still below its bar and the SAME reading as at close: LIVE, named in the reason', async () => {
    await recordGoalOutcomeClose('g-old', closeRecord());
    older([OLD_CLOSE]);
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(false);
    expect(v.signals.outcomeUnmetGoals).toBe(1);
    expect(v.reason).toContain('1 goal(s) closed with the outcome bar unmet');
    const q = mockGoalFindMany.mock.calls.find((c) => c[0]?.where?.updatedAt?.lt)?.[0];
    expect(q.where).toEqual(expect.objectContaining({ projectId: 'p1', status: 'done' }));
    expect(q.where.updatedAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - DORMANCY_DONE_SUSPECT_WINDOW_MS + 1000);
  });

  it('the bar / value changed since the close (fingerprint drift) ⇒ dormant', async () => {
    await recordGoalOutcomeClose('g-old', closeRecord());
    older([{ id: 'g-old', premises: [{ ...KPI, bar: 6 }] }]); // the supervisor recorded why the bar changed
    const v = await evaluateProjectDormancy('p1');
    expect(v.dormant).toBe(true);
    expect(v.signals.outcomeUnmetGoals).toBeUndefined();
  });

  it('the owner closed it explicitly (ownerAccepted) ⇒ dormant', async () => {
    await recordGoalOutcomeClose('g-old', closeRecord({ ownerAccepted: true }));
    older([OLD_CLOSE]);
    expect((await evaluateProjectDormancy('p1')).dormant).toBe(true);
  });

  it('a pre-change close (no record) is not live beyond the 7-day window; a met KPI never is', async () => {
    older([OLD_CLOSE, { id: 'g-met', premises: [{ ...KPI, value: 11 }] }]);
    expect((await evaluateProjectDormancy('p1')).dormant).toBe(true);
  });

  it('kill switch GOAL_OUTCOME_CHECK_DISABLED=1 ⇒ the pre-change verdict (and the older closes are never read)', async () => {
    await recordGoalOutcomeClose('g-old', closeRecord());
    older([OLD_CLOSE]);
    process.env.GOAL_OUTCOME_CHECK_DISABLED = '1';
    expect((await evaluateProjectDormancy('p1')).dormant).toBe(true);
    expect(mockGoalFindMany.mock.calls.some((c) => c[0]?.where?.updatedAt?.lt)).toBe(false);
  });
});
