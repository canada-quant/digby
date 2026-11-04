/**
 * feedback.service — the FILING halves of TICKET-FAMILY-ROUTING and
 * ACCEPTANCE-METRIC-BASELINE (2026-10-20).
 *   - applyAcceptanceBaselineGate: a metric that already passes on its pre-fix
 *     window is not stored (the ticket still files, flagged); a measurable,
 *     failing baseline is stamped; an unmeasurable one keeps the metric; the
 *     kill switch is a no-op; an invalid auto-filer metric is dropped.
 *   - a member of a NOISY family is filed 'queued' with the dispatcher-shaped
 *     note (never refused, never lost); a quiet family files 'open' as before.
 *   - family-queued rows are neither promoted by the rate-cap promoter nor
 *     counted against the rate-cap queue.
 *   - review 2026-10-20: a noisy-family row the fresh-lane drain cannot carry
 *     (another account's ticket — out of owner scope) files OPEN; the promoter
 *     excludes family rows IN THE QUERY (any number of them); a close
 *     transition stamps context.closedAt atomically.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userFeatureRequest: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  appErrorLog: { count: jest.fn() },
  loopMetric: { count: jest.fn() },
  $executeRaw: jest.fn(async () => 1),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('./ticket-dispatch.service', () => ({
  __esModule: true,
  drainOpenTicketsToLane: jest.fn(async () => ({ result: 'sent', batched: 1 })),
  releaseTicketDispatchClaim: jest.fn(async () => undefined),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string) { super(message); }
  },
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: unknown[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {},
}));

import { applyAcceptanceBaselineGate, fileFeedbackTicket, promoteQueuedFeedbackTickets, updateFeedbackTicket } from './feedback.service';

const METRIC = { probe: 'app_error_log_count', params: { messagePattern: 'P2025' }, operator: '<=', target: 0, windowHours: 24 };
let history: any[] = [];
let queuedRows: Array<{ id: string; adminNote?: string | null; context: any }> = [];
const ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  for (const k of ['ACCEPTANCE_BASELINE_GATE_DISABLED', 'TICKET_FAMILY_PRECISION_ROUTING_DISABLED', 'TICKET_FAMILY_BATCHING_DISABLED', 'TICKET_FAMILY_PREFIX_V2_DISABLED', 'TICKET_DISPATCH_FRESH_LANES_DISABLED', 'TICKET_DISPATCH_ANY_USER', 'PLATFORM_ENGINEER_CHAT_ID']) delete process.env[k];
  // The fresh-lane home (lane-home leaf): project 'proj-home' owned by u1.
  process.env.TICKET_LANE_PROJECT_ID = 'proj-home';
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ id: 'proj-home', userId: 'u1' });
  mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
  history = [];
  queuedRows = [];
  mockPrisma.userFeatureRequest.findMany.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    if (Array.isArray(w.OR) && w.OR.some((o: any) => o?.title?.startsWith || o?.context?.path?.[0] === 'verifier')) return history;
    if (w.status === 'queued' && w.source === 'agent') {
      // The promoter's null-safe column filter: adminNote IS NULL OR NOT startsWith(prefix).
      const prefix: string | undefined = w.OR?.[1]?.NOT?.adminNote?.startsWith;
      return queuedRows
        .filter((r) => !prefix || r.adminNote == null || !String(r.adminNote).startsWith(prefix))
        .slice(0, args.take)
        .map((r) => ({ id: r.id, context: r.context }));
    }
    return [];
  });
  mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
  mockPrisma.userFeatureRequest.create.mockImplementation(async ({ data }: any) => ({ id: 't-new', ...data }));
  mockPrisma.userFeatureRequest.updateMany.mockResolvedValue({ count: 1 });
});
afterAll(() => { process.env = ENV; });

describe('applyAcceptanceBaselineGate (filing)', () => {
  it('a VACUOUS metric (0 rows pre-fix vs <= 0) is not stored — the ticket is flagged missing a metric', async () => {
    mockPrisma.appErrorLog.count.mockResolvedValueOnce(0);
    const ctx: Record<string, unknown> = { acceptanceMetric: METRIC, sessionId: 's1' };
    await applyAcceptanceBaselineGate(ctx, 'bug_report', new Date('2026-10-20T12:00:00Z'));
    expect(ctx.acceptanceMetric).toBeUndefined();
    expect(ctx.acceptanceMetricMissing).toBe(true);
    expect(ctx.acceptanceMetricVacuous).toMatchObject({ baseline: 0, vacuous: true, source: 'filer', metric: METRIC });
    expect(mockRecordLoopMetric.mock.calls[0][0]).toMatchObject({ kind: 'acceptance_metric_baseline', meta: { phase: 'filing', vacuous: true, baseline: 0 } });
  });

  it('a failing baseline (5 > 0) keeps the metric and stamps it', async () => {
    mockPrisma.appErrorLog.count.mockResolvedValueOnce(5);
    const ctx: Record<string, unknown> = { acceptanceMetric: METRIC };
    await applyAcceptanceBaselineGate(ctx, 'bug_report');
    expect(ctx.acceptanceMetric).toEqual(METRIC);
    expect(ctx.acceptanceMetricBaseline).toMatchObject({ baseline: 5, measurable: true, vacuous: false });
  });

  it('an UNMEASURABLE baseline keeps the metric (never drops what it cannot judge)', async () => {
    mockPrisma.appErrorLog.count.mockRejectedValueOnce(new Error('db down'));
    const ctx: Record<string, unknown> = { acceptanceMetric: METRIC };
    await applyAcceptanceBaselineGate(ctx, 'bug_report');
    expect(ctx.acceptanceMetric).toEqual(METRIC);
    expect(ctx.acceptanceMetricBaseline).toMatchObject({ measurable: false, vacuous: false });
  });

  it('an invalid AUTO-FILER metric is dropped and flagged; ACCEPTANCE_BASELINE_GATE_DISABLED=1 is a no-op', async () => {
    const ctx: Record<string, unknown> = { acceptanceMetric: { probe: 'loop_metric_count', params: { kind: 'nope' }, operator: '<=', target: 0, windowHours: 24 }, acceptanceMetricSource: 'autofiler-default' };
    await applyAcceptanceBaselineGate(ctx, 'mishap');
    expect(ctx.acceptanceMetric).toBeUndefined();
    expect(ctx.acceptanceMetricMissing).toBe(true);
    process.env.ACCEPTANCE_BASELINE_GATE_DISABLED = '1';
    const ctx2: Record<string, unknown> = { acceptanceMetric: METRIC };
    await applyAcceptanceBaselineGate(ctx2, 'bug_report');
    expect(ctx2).toEqual({ acceptanceMetric: METRIC });
    expect(mockPrisma.appErrorLog.count).not.toHaveBeenCalled();
  });

  it('fileFeedbackTicket runs the gate before the insert', async () => {
    mockPrisma.appErrorLog.count.mockResolvedValueOnce(0);
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: 'Refresh token rows vanish under load', description: 'd', context: { sessionId: 's1', acceptanceMetric: METRIC } });
    const data = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(data.context.acceptanceMetric).toBeUndefined();
    expect(data.context.acceptanceMetricVacuous).toBeDefined();
  });
});

describe('family routing at filing', () => {
  const fp = (id: string, title: string) => ({ id, title, type: 'bug_report', status: 'done', adminNote: 'False positive — the owner was not frustrated.', context: {}, createdAt: new Date(Date.now() - 3600_000), updatedAt: new Date(Date.now() - 3600_000) });

  it('a NOISY family member is filed QUEUED with the dispatcher note — stored, never refused', async () => {
    history = [fp('a', 'Missed bug: owner frustration in chat 11111111'), fp('b', 'Missed bug: owner frustration in chat 22222222'), fp('c', 'Missed bug: owner frustration in chat 33333333')];
    const r = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: 'Missed bug: owner frustration in chat 44444444', description: 'excerpt', context: { sessionId: 'framework-sweep:missed-bug:x', surface: 'system', origin: 'framework-sweep' } });
    expect(r).toMatchObject({ deduped: false });
    const data = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(data.status).toBe('queued');
    expect(data.adminNote).toMatch(/^Queued for the next missed-bug family lane — /);
    expect(data.context).toMatchObject({ familyQueued: true, familyQueue: { key: 'missed-bug', considered: 3, falsePositives: 3 } });
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'ticket_family_routing', meta: expect.objectContaining({ phase: 'filed_queued', family: 'missed-bug' }) })]));
  });

  it('review 2026-10-20: ANOTHER ACCOUNT\'s noisy-family ticket files OPEN (held-for-owner list), never queued', async () => {
    history = [fp('a', 'Missed bug: owner frustration in chat 11111111'), fp('b', 'Missed bug: owner frustration in chat 22222222'), fp('c', 'Missed bug: owner frustration in chat 33333333')];
    await fileFeedbackTicket({ userId: 'someone-else', type: 'mishap', title: 'Missed bug: owner frustration in chat 44444444', description: 'excerpt', context: { sessionId: 's9' } });
    const data = mockPrisma.userFeatureRequest.create.mock.calls[0][0].data;
    expect(data.status).toBeUndefined();
    expect(data.context.familyQueued).toBeUndefined();
    // …and with the standing-lane path serving (fresh lanes off), the owner's own files open too.
    process.env.TICKET_DISPATCH_FRESH_LANES_DISABLED = '1';
    await fileFeedbackTicket({ userId: 'u1', type: 'mishap', title: 'Missed bug: owner frustration in chat 55555555', description: 'excerpt', context: { sessionId: 's10' } });
    expect(mockPrisma.userFeatureRequest.create.mock.calls[1][0].data.status).toBeUndefined();
  });

  it('a quiet family (or the kill switch) files open as before', async () => {
    history = [fp('a', 'Missed bug: owner frustration in chat 11111111')];
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: 'Missed bug: owner frustration in chat 44444444', description: 'excerpt', context: { sessionId: 's2' } });
    expect(mockPrisma.userFeatureRequest.create.mock.calls[0][0].data.status).toBeUndefined();
    history = [fp('a', 'Missed bug: owner frustration in chat 11111111'), fp('b', 'Missed bug: owner frustration in chat 22222222'), fp('c', 'Missed bug: owner frustration in chat 33333333')];
    process.env.TICKET_FAMILY_PRECISION_ROUTING_DISABLED = '1';
    await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: 'Missed bug: owner frustration in chat 55555555', description: 'excerpt', context: { sessionId: 's3' } });
    expect(mockPrisma.userFeatureRequest.create.mock.calls[1][0].data.status).toBeUndefined();
  });
});

describe('family-queued rows are not rate-cap backlog', () => {
  const famNote = 'Queued for the next missed-bug family lane — this auto-filer family\'s recent closes were mostly not defects.';
  it('the promoter excludes family-queued members IN THE QUERY — however many precede the rate-cap rows (review 2026-10-20)', async () => {
    queuedRows = [
      ...Array.from({ length: 15 }, (_, i) => ({ id: `fam-${i}`, adminNote: famNote, context: { familyQueued: true } })),
      { id: 'cap-1', adminNote: null, context: { queuedReason: 'session cap' } },
      { id: 'cap-2', adminNote: null, context: { queuedReason: 'session cap' } },
    ];
    const n = await promoteQueuedFeedbackTickets(3);
    expect(n).toBe(1); // the updateMany mock answers count 1
    expect(mockPrisma.userFeatureRequest.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['cap-1', 'cap-2'] }, status: 'queued' }, data: { status: 'open' } });
    const where = mockPrisma.userFeatureRequest.findMany.mock.calls.map((c: any[]) => c[0].where).find((w: any) => w.status === 'queued' && w.source === 'agent');
    expect(where.OR).toEqual([{ adminNote: null }, { NOT: { adminNote: { startsWith: 'Queued for the next' } } }]);
  });

  it('the in-memory belt still skips a family row whose note was edited', async () => {
    queuedRows = [{ id: 'fam-edited', adminNote: 'hand-edited', context: { familyQueued: true } }, { id: 'cap-1', adminNote: null, context: {} }];
    await promoteQueuedFeedbackTickets(3);
    expect(mockPrisma.userFeatureRequest.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['cap-1'] }, status: 'queued' }, data: { status: 'open' } });
  });

  it('a session at the queued cap only because of family-queued rows still QUEUES (not dropped)', async () => {
    mockPrisma.userFeatureRequest.count.mockImplementation(async ({ where }: any) => {
      if (where.AND) return 10; // family-queued rows (session-scoped and global)
      if (where.status === 'queued') return 10; // all queued rows for the session / global
      if (where.context) return 21; // the session cap count (> 20)
      return 0;
    });
    const r = await fileFeedbackTicket({ userId: 'u1', type: 'bug_report', title: 'Composer loses draft on reload', description: 'd', context: { sessionId: 'sess-cap' } });
    expect(r).toMatchObject({ queued: true });
    expect(mockPrisma.userFeatureRequest.create.mock.calls[0][0].data.status).toBe('queued');
  });
});

describe('updateFeedbackTicket stamps the close time (review 2026-10-20)', () => {
  const row = (status: string) => ({ id: 'tkt-00000001', status, adminNote: null, context: { family: 'x' } });

  it('a transition into done / awaiting_verification stamps context.closedAt with ONE atomic jsonb merge', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(row('in_progress'));
    mockPrisma.userFeatureRequest.update.mockResolvedValue({ ...row('done') });
    await updateFeedbackTicket({ id: 'tkt-00000001', status: 'done', adminNote: 'fixed' });
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, json, id] = mockPrisma.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('UPDATE "user_feature_requests" SET "context"');
    expect(JSON.parse(json)).toEqual({ closedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(id).toBe('tkt-00000001');
  });

  it('no stamp on a non-closing write, on a done→done re-write, or with the routing kill switch', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(row('open'));
    mockPrisma.userFeatureRequest.update.mockResolvedValue(row('in_progress'));
    await updateFeedbackTicket({ id: 'tkt-00000001', status: 'in_progress' });
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(row('done'));
    await updateFeedbackTicket({ id: 'tkt-00000001', status: 'done', adminNote: 'again' });
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(row('in_progress'));
    process.env.TICKET_FAMILY_PRECISION_ROUTING_DISABLED = '1';
    await updateFeedbackTicket({ id: 'tkt-00000001', status: 'done' });
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('a failed stamp never fails the close', async () => {
    mockPrisma.userFeatureRequest.findUnique.mockResolvedValue(row('in_progress'));
    mockPrisma.userFeatureRequest.update.mockResolvedValue(row('done'));
    mockPrisma.$executeRaw.mockRejectedValueOnce(new Error('db down'));
    await expect(updateFeedbackTicket({ id: 'tkt-00000001', status: 'done' })).resolves.toMatchObject({ status: 'done' });
  });
});
