/**
 * build 2026-10-08 D — the nightly reconcile of the SHADOW delegation ledger
 * and the tool-intent journal. It MEASURES the ledger against each kind's own
 * source of truth and writes the readout rows the stage-1 bar is read from:
 * delegation_task_reconcile { agreementPct ≥ 99, missingParent 0, missingRows,
 * stale } and tool_intent { phase: 'daily', executedTwiceKeys }. AFTER the
 * measurement it runs the background-orphan sweep (ticket d5974d65) — open
 * background_worker rows whose parent run is long terminal are failed /
 * canceled instead of sitting 'working' forever (the readout row is written
 * first, so it always reflects pre-sweep reality).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    DELEGATION_TASK: 'delegation_task', DELEGATION_TASK_RECONCILE: 'delegation_task_reconcile',
    TOOL_INTENT: 'tool_intent', DELEGATE_BACKGROUND: 'delegate_background',
  },
}));

const db: Record<string, any> = {};
jest.mock('../../../config/database', () => ({ __esModule: true, default: new Proxy({}, { get: (_t, k: string) => db[k] }) }));

import {
  agreementPct, runBoundTruth, runDelegationReconcileOnce, tallyAgreement, ticketTruth, type ReconcileTask,
} from './delegation-tasks-reconcile';

const NOW = new Date('2026-10-08T23:00:00Z');
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000);
const T = (over: Partial<ReconcileTask>): ReconcileTask => ({ id: 'aaaaaaaa-1', kind: 'session', state: 'submitted', createdAt: at(120), parentChatId: 'p', childChatId: 'c', childRef: null, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DELEGATION_TASKS_DISABLED;
  delete process.env.TOOL_INTENT_JOURNAL_DISABLED;
  for (const k of Object.keys(db)) delete db[k];
});

describe('reconcile — pure pieces', () => {
  it('tally: agreement is judged over pairs where the row or the truth is terminal', () => {
    const t = tallyAgreement([
      { task: T({ id: 'a1', state: 'completed' }), truth: 'completed' },
      { task: T({ id: 'a2', state: 'completed' }), truth: 'failed' },
      { task: T({ id: 'a3', state: 'working' }), truth: 'completed' },
      { task: T({ id: 'a4', state: 'canceled', kind: 'ticket' }), truth: null },
      { task: T({ id: 'a5', state: 'working' }), truth: null },
    ]);
    expect(t).toMatchObject({ checked: 5, agree: 1, mismatch: 1, missedTerminal: 1, falseTerminal: 1, openBoth: 1 });
    expect(agreementPct(t)).toBe(25);
    expect(t.byKind.session).toEqual({ checked: 4, agree: 1, disagree: 2 });
    expect(t.samples.map((s) => s.id)).toEqual(['a2', 'a3', 'a4']);
    expect(agreementPct(tallyAgreement([]))).toBe(100);
  });

  it('run-bound truth: the first run still running at the task or created after it', () => {
    const tc = at(60);
    expect(runBoundTruth(tc, [])).toBeNull();
    // an older run that finished before the ask is not its run
    expect(runBoundTruth(tc, [{ status: 'failed', createdAt: at(200), finishedAt: at(100) }])).toBeNull();
    // a steer into a run that was running at the ask
    expect(runBoundTruth(tc, [{ status: 'completed', createdAt: at(90), finishedAt: at(30) }])).toBe('completed');
    // the next run after the ask; a still-running one is open
    expect(runBoundTruth(tc, [{ status: 'cancelled', createdAt: at(50), finishedAt: at(40) }])).toBe('canceled');
    expect(runBoundTruth(tc, [{ status: 'running', createdAt: at(50), finishedAt: null }])).toBeNull();
  });

  it('ticket truth: closed ⇒ completed; another lane ⇒ canceled (superseded); re-dispatch stopped ⇒ failed', () => {
    const task = T({ kind: 'ticket', childChatId: 'lane-A', childRef: 'tk' });
    expect(ticketTruth(task, { status: 'done', adminNote: null, context: { dispatchedTo: 'lane-A' } })).toBe('completed');
    expect(ticketTruth(task, { status: 'in_progress', adminNote: null, context: { dispatchedTo: 'lane-B' } })).toBe('canceled');
    expect(ticketTruth(task, { status: 'open', adminNote: 'Auto re-dispatch stopped — 3 ticket lanes ran without closing it', context: {} })).toBe('failed');
    expect(ticketTruth(task, { status: 'in_progress', adminNote: 'Ticket lane x working since …', context: { dispatchedTo: 'lane-A' } })).toBeNull();
    expect(ticketTruth(task, null)).toBeNull();
  });
});

describe('reconcile — the nightly pass', () => {
  function seed() {
    const tasks = [
      { id: 's-agree-0001', kind: 'session', state: 'completed', createdAt: at(300), parentChatId: 'ps', childChatId: 'lane-1', childRef: null },
      { id: 's-missed-002', kind: 'session', state: 'submitted', createdAt: at(300), parentChatId: 'ps', childChatId: 'lane-2', childRef: null },
      { id: 'm-plain-0003', kind: 'message_ask', state: 'completed', createdAt: at(200), parentChatId: 'ps', childChatId: 'plain-1', childRef: null },
      { id: 't-super-0004', kind: 'ticket', state: 'canceled', createdAt: at(400), parentChatId: null, childChatId: 'lane-old', childRef: 'tk-1' },
      { id: 'b-bg-000005', kind: 'background_worker', state: 'completed', createdAt: at(100), parentChatId: 'lane-9', childChatId: null, childRef: 'bg1-x' },
      { id: 'c-cont-0006', kind: 'continuation', state: 'working', createdAt: at(100), parentChatId: 'chat-c', childChatId: 'chat-c', childRef: 'cont-1' },
      { id: 'o-orph-0007', kind: 'message_ask', state: 'completed', createdAt: at(100), parentChatId: null, childChatId: 'plain-2', childRef: null },
    ];
    db.delegationTask = {
      findMany: jest.fn(async ({ where }: any) => {
        if (where?.kind === 'session') return tasks.filter((t) => where.childChatId.in.includes(t.childChatId)).map((t) => ({ childChatId: t.childChatId }));
        // the orphan sweep's query (d5974d65): open background_worker rows — the only seeded bg row is completed, so the sweep scans 0
        if (where?.kind === 'background_worker' && where?.state?.in) return tasks.filter((t) => t.kind === 'background_worker' && where.state.in.includes(t.state));
        return tasks;
      }),
      count: jest.fn(async () => 2),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    };
    db.agentRun = {
      findMany: jest.fn(async () => [
        { sessionId: 'lane-1', status: 'completed', createdAt: at(290), finishedAt: at(250) },
        { sessionId: 'lane-2', status: 'failed', createdAt: at(290), finishedAt: at(280) },
      ]),
    };
    db.crossModelMessage = {
      findMany: jest.fn(async ({ where }: any) => (where.chatId.in.includes('chat-c')
        ? [{ chatId: 'chat-c', metadata: { task: { taskId: 'cont-1', status: 'done' } } }]
        : [{ chatId: 'plain-1', createdAt: at(150) }])),
    };
    db.userFeatureRequest = { findMany: jest.fn(async () => [{ id: 'tk-1', status: 'in_progress', adminNote: null, context: { dispatchedTo: 'lane-new' } }]) };
    db.loopMetric = { findMany: jest.fn(async () => [{ sessionId: 'lane-9', meta: { phase: 'injected', workerId: 'bg1-x' }, createdAt: at(90) }]) };
    db.runToolReceipt = { findMany: jest.fn(async () => [{ ids: { sessionId: 'lane-1' } }, { ids: { sessionId: 'lane-unrecorded' } }]) };
    db.toolIntent = {
      groupBy: jest.fn(async ({ by }: any) => (by[0] === 'state' ? [{ state: 'applied', _count: { _all: 40 } }, { state: 'pending', _count: { _all: 2 } }]
        : by[0] === 'wouldReconcile' ? [{ wouldReconcile: 'skip_applied', _count: { _all: 3 } }]
          : [{ idemKey: 'k1' }])),
      count: jest.fn(async () => 1),
      deleteMany: jest.fn(async () => ({ count: 5 })),
    };
  }

  it('measures every kind against its source, counts missing parents / missing rows / stale, summarizes the journal', async () => {
    seed();
    const summary = await runDelegationReconcileOnce(NOW);
    expect(summary).toBe('ledger 7 checked, 57.14% agree, missingParent 1, missingRows 1, stale 2, orphans swept 0/0; intents 42, executed twice 1, orphan pending 1');
    const rec = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r: any) => r.kind === 'delegation_task_reconcile');
    expect(rec.meta).toMatchObject({
      checked: 7, agree: 4, mismatch: 0, missedTerminal: 2, falseTerminal: 1, openBoth: 0,
      agreementPct: 57.14, missingParent: 1, missingRows: 1, spawnReceipts: 2, stale: 2,
    });
    // agree: lane-1 completed, plain-1 completed, the superseded ticket, the bg worker; missed: lane-2 (failed run), the continuation (card done); false: the orphan ask.
    expect(rec.meta.samples.map((s: any) => s.id)).toEqual(['s-missed', 'c-cont-0', 'o-orph-0']);
    const daily = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r: any) => r.kind === 'tool_intent');
    expect(daily).toMatchObject({ value: 1, unit: 'keys', meta: { phase: 'daily', total: 42, executedTwiceKeys: 1, orphanPending: 1, actSkips: 1, pruned: 5, byVerdict: { skip_applied: 3 } } });
    // build 2026-10-11 DL-2: the act population (replayed / withheld rows with an earlier-attempt twin)
    expect(db.toolIntent.count).toHaveBeenCalledWith({ where: { createdAt: { gte: new Date(NOW.getTime() - 86_400_000) }, state: { in: ['replayed', 'withheld'] }, priorIntentId: { not: null } } });
    // retention ran on both tables, bounded by age
    expect(db.delegationTask.deleteMany).toHaveBeenCalledWith({ where: { state: { in: ['completed', 'failed', 'canceled'] }, createdAt: { lt: new Date(NOW.getTime() - 90 * 86_400_000) } } });
    expect(db.toolIntent.deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: new Date(NOW.getTime() - 30 * 86_400_000) } } });
  });

  it('kill switches skip each half; a failing DB is a summary line, never a throw', async () => {
    process.env.DELEGATION_TASKS_DISABLED = '1';
    process.env.TOOL_INTENT_JOURNAL_DISABLED = '1';
    await expect(runDelegationReconcileOnce(NOW)).resolves.toBe('ledger off; journal off');
    delete process.env.DELEGATION_TASKS_DISABLED;
    delete process.env.TOOL_INTENT_JOURNAL_DISABLED;
    await expect(runDelegationReconcileOnce(NOW)).resolves.toBe('ledger error; journal error');
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});
