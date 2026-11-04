/**
 * Finding C3 (2026-09-27): setGoalPremises records ONE `premise_revised`
 * loop_metrics row per beyond-tolerance re-registration (value = signed pct,
 * unit 'pct'; meta old/new/manifests/mode/actingChatId), names the revision in
 * the goal.premises_set audit row, and echoes it on the answer as
 * premiseRevisions[].line — observe-only: the write lands either way.
 */
const mockPrisma: any = {
  projectGoal: { findUnique: jest.fn(), findMany: jest.fn(async () => []), update: jest.fn() },
  projectTodo: { findUnique: jest.fn(async () => null) },
  crossModelProject: { findUnique: jest.fn() },
  projectMember: { findMany: jest.fn(async () => []) },
  activity: { create: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error { constructor(public statusCode: number, public message: string) { super(message); } },
}));
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: jest.fn(async () => null), storePut: jest.fn(async () => {}) }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, ...jest.requireActual('./loop-metrics.service'), recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));
jest.mock('./hooks.service', () => ({ __esModule: true, emitHookEventSafe: jest.fn(async () => {}), enqueueDirectWake: jest.fn(async () => ({ ok: true })) }));
jest.mock('../coding/schedule.service', () => ({ __esModule: true, fireScheduleTarget: jest.fn(), dailyCapExceeded: jest.fn(async () => null), refundDailyCapToken: jest.fn() }));

import { setGoalPremises } from './goals.service';
import { PREMISE_MAX_PER_GOAL } from './premise-register';

const OWNER = 'u-owner';
const GOAL = 'aaaaaaaa-0000-4000-8000-000000000000';
const PROJECT = 'pppppppp-0000-4000-8000-000000000000';
const goalRow = (premises: any[]) => ({ id: GOAL, projectId: PROJECT, title: 'Ship draft2g at parity', status: 'active', premises, createdAt: new Date(), updatedAt: new Date() });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: PROJECT, userId: OWNER, members: [] });
  mockPrisma.projectGoal.findUnique.mockResolvedValue(goalRow([{ key: 'draft2g_tg32_mean_tps', value: 30.88, unit: 'tok/s', manifest: 'llama-bench draft2g tg32', setAt: '2026-09-20T00:00:00Z' }]));
  mockPrisma.projectGoal.update.mockImplementation(async ({ data }: any) => goalRow(data.premises));
});

describe('setGoalPremises — finding C3 revisions', () => {
  it('records premise_revised, names the revision in the audit row and echoes premiseRevisions on the answer', async () => {
    const view = await setGoalPremises({ userId: OWNER, goalId: GOAL, premises: [{ key: 'draft2g_tg32_mean_tps', value: 18.6, unit: 'tok/s', manifest: 'llama-bench draft2g tg32', note: 'rerun 2026-09-27' }], actingChatId: 'lane-2' });
    expect(view.premiseRevisions).toHaveLength(1);
    expect(view.premiseRevisions[0].line).toBe('premise draft2g_tg32_mean_tps revised 30.88→18.6tok/s (-40%)');
    expect(view.premises[0]).toMatchObject({ value: 18.6, prevValue: 30.88, prevManifest: 'llama-bench draft2g tg32' });
    const rows = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'premise_revised');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ unit: 'pct', meta: { goalId: GOAL, projectId: PROJECT, key: 'draft2g_tg32_mean_tps', old: 30.88, new: 18.6, manifestMatch: true, mode: 'merge', actingChatId: 'lane-2' } });
    expect(Math.round(rows[0].value)).toBe(-40);
    const audit = mockPrisma.activity.create.mock.calls.find((c: any) => c[0].data.action === 'goal.premises_set')![0].data.metadata;
    expect(audit.revised).toEqual([{ key: 'draft2g_tg32_mean_tps', old: 30.88, new: 18.6, pct: expect.any(Number) }]);
    // the write landed regardless (observe-only)
    expect(mockPrisma.projectGoal.update).toHaveBeenCalledTimes(1);
  });
  it('an unchanged value or a new key ⇒ no row, no premiseRevisions field, write still lands', async () => {
    const same = await setGoalPremises({ userId: OWNER, goalId: GOAL, premises: [{ key: 'draft2g_tg32_mean_tps', value: 30.88, unit: 'tok/s', manifest: 'llama-bench draft2g tg32' }, { key: 'fresh', value: 1 }] });
    expect(same).not.toHaveProperty('premiseRevisions');
    expect(mockRecordLoopMetric.mock.calls.filter((c) => c[0].kind === 'premise_revised')).toHaveLength(0);
    expect(mockPrisma.projectGoal.update).toHaveBeenCalledTimes(1);
  });
});

/**
 * Ticket 7862cb2a, second half — the SERVICE surface of eviction naming.
 * Adversarial review 2026-11-01 (nit 5): the pure `dropped`/notice were pinned,
 * but the goals.service wiring that echoes them and records the audit field had
 * ZERO tests. These are the missing half.
 */
describe('setGoalPremises — ticket 7862cb2a eviction naming', () => {
  const CAP = PREMISE_MAX_PER_GOAL;
  const atCap = Array.from({ length: CAP }, (_, i) => ({ key: `reg_${i}`, value: i, unit: 'clips', setAt: '2026-10-01T00:00:00Z' }));

  beforeEach(() => {
    mockPrisma.projectGoal.findUnique.mockResolvedValue(goalRow(atCap));
    mockPrisma.projectGoal.update.mockImplementation(async ({ data }: any) => goalRow(data.premises));
  });

  it('a replace that retires a measured premise echoes it, warns, and audits it', async () => {
    // Keep all but the last, add one new key: exactly one premise is displaced.
    const keep = atCap.slice(0, CAP - 1).map((p) => ({ key: p.key, value: p.value, unit: p.unit }));
    const view = await setGoalPremises({
      userId: OWNER, goalId: GOAL, mode: 'replace',
      premises: [...keep, { key: 'backlog:auto_decrypt_rate:diag', value: 7, unit: 'clips/hr' }],
      actingChatId: 'lane-2',
    } as any);
    expect(view.premiseEvictions).toEqual([`reg_${CAP - 1}`]);
    expect(String(view.premiseEvictionNotice)).toContain(`reg_${CAP - 1}`);
    const audit = mockPrisma.activity.create.mock.calls.find((c: any) => c[0].data.action === 'goal.premises_set')![0].data.metadata;
    expect(audit.evicted).toEqual([`reg_${CAP - 1}`]);
    expect(mockPrisma.projectGoal.update).toHaveBeenCalledTimes(1);
  });

  it('a replace that retires NOTHING carries no eviction field — the ordinary answer is unchanged', async () => {
    const view = await setGoalPremises({
      userId: OWNER, goalId: GOAL, mode: 'replace',
      premises: atCap.map((p) => ({ key: p.key, value: p.value, unit: p.unit })),
    } as any);
    expect(view).not.toHaveProperty('premiseEvictions');
    expect(view).not.toHaveProperty('premiseEvictionNotice');
    const audit = mockPrisma.activity.create.mock.calls.find((c: any) => c[0].data.action === 'goal.premises_set')![0].data.metadata;
    expect(audit).not.toHaveProperty('evicted');
  });

  it('a MERGE never reports an eviction', async () => {
    mockPrisma.projectGoal.findUnique.mockResolvedValue(goalRow(atCap.slice(0, 2)));
    const view = await setGoalPremises({ userId: OWNER, goalId: GOAL, premises: [{ key: 'new_one', value: 5 }] } as any);
    expect(view).not.toHaveProperty('premiseEvictions');
  });
});
