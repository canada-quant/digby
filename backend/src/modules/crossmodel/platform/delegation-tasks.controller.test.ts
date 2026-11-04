/**
 * build 2026-10-08 D — the admin read path of the SHADOW delegation ledger:
 * admin-only, read-only, compact rows (stale flag derived), the 24 h journal
 * summary and the last nightly reconcile row.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { DELEGATION_TASK_RECONCILE: 'delegation_task_reconcile', TOOL_INTENT: 'tool_intent' },
}));
const mockList: jest.Mock = jest.fn();
const mockGet: jest.Mock = jest.fn();
const mockSummary: jest.Mock = jest.fn();
jest.mock('./delegation-tasks', () => ({
  __esModule: true,
  listDelegationTasks: (...a: any[]) => mockList(...a),
  getDelegationTask: (...a: any[]) => mockGet(...a),
  summarizeDelegationTasks: (...a: any[]) => mockSummary(...a),
  isTerminalDelegationState: (s: string) => ['completed', 'failed', 'canceled'].includes(s),
}));
const mockIntentSummary: jest.Mock = jest.fn();
jest.mock('../coding/tool-intents', () => ({ __esModule: true, summarizeToolIntents: (...a: any[]) => mockIntentSummary(...a) }));
const mockMetricFindMany: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { loopMetric: { findMany: (...a: any[]) => mockMetricFindMany(...a) } } }));

import { compactDelegationTask, getAdminDelegationTask, getAdminDelegationTasks } from './delegation-tasks.controller';

function res() {
  const r: any = { statusCode: 200, body: null };
  r.status = jest.fn((c: number) => { r.statusCode = c; return r; });
  r.json = jest.fn((b: any) => { r.body = b; return r; });
  return r;
}
const ADMIN = { user: { role: 'ADMIN', email: 'a@b.c' } };
const ROW = {
  id: 'task-1', kind: 'session', source: 'start_coding_session', state: 'working', parentChatId: 'ps', childChatId: 'lane', childRef: null,
  projectId: 'p1', brief: 'x'.repeat(500), origin: 'machine', duplicateOfId: null, artifacts: [{ kind: 'pr', ref: 'u' }], events: [{}, {}],
  resultRef: null, reason: null, staleAfter: new Date(Date.now() - 1_000), createdAt: new Date('2026-10-08T10:00:00Z'), lastEventAt: new Date('2026-10-08T10:05:00Z'), completedAt: null,
  idempotencyKey: 'k'.repeat(40), parentRunId: 'run-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue([ROW]);
  mockSummary.mockResolvedValue({ hours: 168, total: 1, byKind: { session: { working: 1 } }, open: 1, stale: 1, duplicateKeys: 0 });
  mockIntentSummary.mockResolvedValue({ hours: 24, total: 3, byState: { applied: 3 }, byVerdict: {}, byTool: { send_chat_message: 3 }, orphanPending: 0 });
  mockMetricFindMany.mockResolvedValue([{ createdAt: new Date('2026-10-08T03:00:00Z'), value: 99.5, meta: { agreementPct: 99.5, phase: 'daily' } }]);
});

describe('GET /admin/delegation-tasks', () => {
  it('refuses a non-admin', async () => {
    const r = res();
    await getAdminDelegationTasks({ user: { role: 'USER', email: 'x@y.z' }, query: {} } as any, r);
    expect(r.statusCode).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('answers the summary, compact rows (brief clipped, stale derived), the journal summary and the last reconcile', async () => {
    const r = res();
    await getAdminDelegationTasks({ ...ADMIN, query: { kind: 'session', state: 'open', chatId: 'ps', hours: '24', limit: '10', stale: '1' } } as any, r);
    expect(mockList).toHaveBeenCalledWith({ kind: 'session', state: 'open', chatId: 'ps', hours: 24, limit: 10, staleOnly: true });
    expect(r.body.success).toBe(true);
    const t = r.body.data.tasks[0];
    expect(t).toMatchObject({ id: 'task-1', state: 'working', stale: true, artifactCount: 1, eventCount: 2, createdAt: '2026-10-08T10:00:00.000Z' });
    expect(t.brief).toHaveLength(200);
    expect(t).not.toHaveProperty('events');
    expect(r.body.data.summary.stale).toBe(1);
    expect(r.body.data.toolIntents.total).toBe(3);
    expect(r.body.data.lastReconcile).toMatchObject({ at: '2026-10-08T03:00:00.000Z', value: 99.5 });
    expect(r.body.data.lastIntentDaily).toMatchObject({ value: 99.5 });
  });

  it('a terminal task is never stale', () => {
    expect(compactDelegationTask({ ...ROW, state: 'completed' }).stale).toBe(false);
  });
});

describe('GET /admin/delegation-tasks/:id', () => {
  it('404 when unknown; the full trail when found', async () => {
    mockGet.mockResolvedValueOnce(null);
    const r1 = res();
    await getAdminDelegationTask({ ...ADMIN, params: { id: 'nope1234' } } as any, r1);
    expect(r1.statusCode).toBe(404);
    mockGet.mockResolvedValueOnce(ROW);
    const r2 = res();
    await getAdminDelegationTask({ ...ADMIN, params: { id: 'task-1' } } as any, r2);
    expect(r2.body.data.task).toMatchObject({ id: 'task-1', parentRunId: 'run-1', idempotencyKey: 'k'.repeat(40), events: [{}, {}], artifacts: [{ kind: 'pr', ref: 'u' }] });
    expect(r2.body.data.task.brief).toHaveLength(500);
  });
});
