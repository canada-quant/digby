/**
 * build 2026-10-08 D-1 — the delegation task ledger (SHADOW). Pins the ONE
 * vocabulary (and every map into it), the report-up rule, terminal
 * immutability, and replays of the delegation shapes architecture.md item B
 * audited (an in-memory delegation_tasks table stands in for Postgres):
 *   · spawn → child run start → run_completed (the 132/139 child→parent return
 *     path) — recorded even when no hook listens (the 10-08 P1-1 paused-
 *     supervisor regression: 10 lane runs woke nobody, the ledger still closes);
 *   · a message QUEUED behind a busy plain chat is not completed by the run it
 *     queued behind — only by the run that drains it;
 *   · a steer into a running coding lane completes with THAT run;
 *   · the worker's start note lost a cross-process race: a submitted task
 *     created before the run started still closes with it;
 *   · a cancelled lane run → canceled;
 *   · ticket lanes: a re-dispatch supersedes the old lane's task; the ticket's
 *     close completes it; "Auto re-dispatch stopped" fails it;
 *   · the twin-lane duplicate (#1339 / #1340): a second task with the SAME
 *     tool-intent key is stamped duplicateOfId + one duplicate_key row;
 *   · background workers: start → injected / posted_late / cancelled /
 *     lost_on_resume;
 *   · the task card: the hand-off's done card completes the session task with
 *     its artifacts (also after the run outcome already closed it); a
 *     continuation's cards create + move their own task.
 * Shadow: every writer is fire-and-forget and swallows every error;
 * DELEGATION_TASKS_DISABLED=1 writes nothing.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { DELEGATION_TASK: 'delegation_task' },
}));

// ── In-memory Prisma stand-in ────────────────────────────────────────────────
type Row = Record<string, any>;
const tables: { tasks: Row[]; chats: Row[]; coding: Row[]; runs: Row[]; tickets: Row[] } = { tasks: [], chats: [], coding: [], runs: [], tickets: [] };
let seq = 0;
let nowMs = Date.now();

function cmp(v: any, cond: any): boolean {
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    if ('in' in cond) return (cond.in as any[]).includes(v);
    if ('notIn' in cond) return !(cond.notIn as any[]).includes(v);
    if ('not' in cond) return cond.not === null ? v != null : v !== cond.not;
    if ('startsWith' in cond) return typeof v === 'string' && v.startsWith(cond.startsWith);
    const t = v instanceof Date ? v.getTime() : v;
    if ('lt' in cond && !(t < new Date(cond.lt).getTime())) return false;
    if ('lte' in cond && !(t <= new Date(cond.lte).getTime())) return false;
    if ('gte' in cond && !(t >= new Date(cond.gte).getTime())) return false;
    return true;
  }
  return v === cond;
}
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    return cmp(row[k], cond);
  });
}
const pick = (row: Row, select?: Row) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row });

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    delegationTask: {
      create: async ({ data, select }: any) => {
        const row = { id: `task-${String(++seq).padStart(4, '0')}-0000-0000-0000-000000000000`, createdAt: new Date(nowMs), completedAt: null, resultRef: null, reason: null, ...data };
        tables.tasks.push(row);
        return pick(row, select);
      },
      findFirst: async ({ where, orderBy, select }: any) => {
        const hits = tables.tasks.filter((r) => matches(r, where));
        if (orderBy?.createdAt === 'desc') hits.reverse();
        return hits.length ? pick(hits[0], select) : null;
      },
      findMany: async ({ where, select, take }: any) => tables.tasks.filter((r) => matches(r, where)).slice(0, take ?? 1e9).map((r) => pick(r, select)),
      findUnique: async ({ where }: any) => tables.tasks.find((r) => r.id === where.id) ?? null,
      updateMany: async ({ where, data }: any) => {
        const hits = tables.tasks.filter((r) => matches(r, where));
        for (const r of hits) Object.assign(r, data);
        return { count: hits.length };
      },
      update: async ({ where, data }: any) => Object.assign(tables.tasks.find((r) => r.id === where.id)!, data),
      count: async ({ where }: any) => tables.tasks.filter((r) => matches(r, where)).length,
      groupBy: async ({ where }: any) => {
        const m = new Map<string, number>();
        for (const r of tables.tasks.filter((x) => matches(x, where))) m.set(`${r.kind}|${r.state}`, (m.get(`${r.kind}|${r.state}`) ?? 0) + 1);
        return [...m.entries()].map(([k, n]) => ({ kind: k.split('|')[0], state: k.split('|')[1], _count: { _all: n } }));
      },
    },
    crossModelChat: { findMany: async ({ where }: any) => tables.chats.filter((r) => matches(r, where)) },
    chatCodingState: { findUnique: async ({ where }: any) => tables.coding.find((r) => r.id === where.id) ?? null },
    agentRun: { findUnique: async ({ where }: any) => tables.runs.find((r) => r.id === where.id) ?? null },
    userFeatureRequest: { findUnique: async ({ where }: any) => tables.tickets.find((r) => r.id === where.id) ?? null },
  },
}));

import {
  appendDelegationEvent, canTransitionDelegation, createDelegationTask, delegationTasksDisabled, flushDelegationTaskWrites,
  fromBackgroundPhase, fromHookEvent, fromRunStatus, fromTaskCardStatus, fromTicketStatus, getDelegationTask, isReportUp,
  listDelegationTasks, mergeDelegationArtifacts, noteBackgroundWorkerPhase, noteBackgroundWorkersLost, noteChatRunEvent,
  noteChatRunStarted, noteTaskCardLifecycle, noteTicketDispatchExhausted, noteTicketLaneClosed, recordDelegationTask,
  summarizeDelegationTasks, DELEGATION_STATES,
} from './delegation-tasks';

const flush = async () => { await flushDelegationTaskWrites(); await new Promise((r) => setImmediate(r)); await flushDelegationTaskWrites(); };
const task = (pred: (r: Row) => boolean) => tables.tasks.find(pred)!;
const metricPhases = () => mockRecordLoopMetric.mock.calls.map((c) => (c[0] as any).meta?.phase);

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(tables) as Array<keyof typeof tables>) tables[k].length = 0;
  delete process.env.DELEGATION_TASKS_DISABLED;
  nowMs = Date.now();
});

describe('delegation ledger — the ONE vocabulary (pure)', () => {
  it('six states; terminal states are immutable; nothing moves back to submitted', () => {
    expect(DELEGATION_STATES).toEqual(['submitted', 'working', 'input_required', 'completed', 'failed', 'canceled']);
    expect(canTransitionDelegation('submitted', 'working')).toBe(true);
    expect(canTransitionDelegation('submitted', 'completed')).toBe(true);
    expect(canTransitionDelegation('working', 'input_required')).toBe(true);
    expect(canTransitionDelegation('input_required', 'working')).toBe(true);
    expect(canTransitionDelegation('working', 'submitted')).toBe(false);
    expect(canTransitionDelegation('working', 'working')).toBe(false);
    for (const t of ['completed', 'failed', 'canceled']) {
      for (const to of ['working', 'completed', 'failed', 'canceled', 'input_required']) expect(canTransitionDelegation(t, to)).toBe(false);
    }
    expect(canTransitionDelegation('working', 'done')).toBe(false);
  });

  it('maps the existing vocabularies into it (agent_runs, hook events, task card, background pool, tickets)', () => {
    expect(['queued', 'running', 'interrupted', 'completed', 'failed', 'cancelled'].map(fromRunStatus)).toEqual(['submitted', 'working', 'working', 'completed', 'failed', 'canceled']);
    expect(['run_completed', 'run_failed', 'attention_needed', 'todo_done'].map(fromHookEvent)).toEqual(['completed', 'failed', 'input_required', null]);
    expect(['running', 'done', 'failed', 'waiting_user'].map(fromTaskCardStatus)).toEqual(['working', 'completed', 'failed', 'input_required']);
    expect(['start', 'injected', 'status', 'posted_late', 'cancelled', 'unposted', 'lost_on_resume', 'end_wait'].map(fromBackgroundPhase))
      .toEqual(['working', 'completed', 'completed', 'completed', 'canceled', 'failed', 'failed', null]);
    expect(['done', 'resolved', 'open', 'in_progress'].map(fromTicketStatus)).toEqual(['completed', 'completed', null, null]);
  });

  it('report-up rule: up to the Fleet Supervisor / own project supervisor / own parent is no task; down and sideways ask', () => {
    const fs = { id: 'fs', isSupervisor: true };
    const ps = { id: 'ps', isProjectSupervisor: true, projectId: 'p1' };
    const lane = { id: 'lane', projectId: 'p1', parentChatId: 'ps' };
    const otherLane = { id: 'lane2', projectId: 'p1', parentChatId: 'ps' };
    const child = { id: 'kid', projectId: 'p2', parentChatId: 'lane' };
    expect(isReportUp(ps, fs)).toBe(true); // PS → FS
    expect(isReportUp(lane, fs)).toBe(true); // lane → FS
    expect(isReportUp(lane, ps)).toBe(true); // lane → own PS
    expect(isReportUp(child, { id: 'lane', projectId: 'p1' })).toBe(true); // child → parent
    expect(isReportUp(fs, ps)).toBe(false); // FS → PS: an ask
    expect(isReportUp(ps, lane)).toBe(false); // PS → lane: an ask
    expect(isReportUp(lane, otherLane)).toBe(false); // sideways: an ask
    expect(isReportUp({ id: 'x', projectId: 'p9' }, ps)).toBe(false); // another project's lane asking a PS
    expect(isReportUp(lane, lane)).toBe(true); // a note to itself
  });

  it('event trail keeps the first and newest events; artifacts dedupe by kind + ref', () => {
    let ev: any[] = [];
    for (let i = 0; i < 40; i++) ev = appendDelegationEvent(ev, { at: String(i), from: null, to: 'working', seam: `s${i}` });
    expect(ev).toHaveLength(24);
    expect(ev[0].seam).toBe('s0');
    expect(ev[23].seam).toBe('s39');
    const a = mergeDelegationArtifacts([{ kind: 'pr', ref: 'https://x/pull/1' }], [{ kind: 'pr', ref: 'https://x/pull/1' }, { kind: 'file', ref: '/api/f/1', name: 'deck.pdf' }]);
    expect(a).toEqual([{ kind: 'pr', ref: 'https://x/pull/1' }, { kind: 'file', ref: '/api/f/1', name: 'deck.pdf' }]);
  });
});

describe('delegation ledger — replays (shadow writes)', () => {
  it('spawn → child run start → run_completed closes the session task; no hook needs to listen', async () => {
    recordDelegationTask({ kind: 'session', source: 'start_coding_session', userId: 'u1', parentChatId: 'ps-1', parentRunId: 'chat-run-1', childChatId: 'lane-1', projectId: 'p1', brief: 'H2H bench S3', origin: 'machine' });
    await flush();
    expect(task((r) => r.childChatId === 'lane-1')).toMatchObject({ kind: 'session', state: 'submitted', parentChatId: 'ps-1' });
    noteChatRunStarted('lane-1', 'run-a');
    noteChatRunEvent('lane-1', 'run_completed', 'run-a');
    await flush();
    const t = task((r) => r.childChatId === 'lane-1');
    expect(t).toMatchObject({ state: 'completed', resultRef: 'run-a' });
    expect(t.events.map((e: any) => `${e.from}->${e.to}@${e.seam}`)).toEqual(['null->submitted@start_coding_session', 'submitted->working@run_started', 'working->completed@run_completed']);
    expect(metricPhases()).toEqual(['created']); // a transition's record is the row, never a metric row
  });

  it('a message queued behind a busy plain chat stays submitted through that run, closes with the run that drains it', async () => {
    tables.chats.push({ id: 'sup', isSupervisor: false, isProjectSupervisor: true, projectId: 'p1' }, { id: 'chat-b', projectId: 'p1' });
    recordDelegationTask({ kind: 'message_ask', source: 'send_chat_message', parentChatId: 'sup', childChatId: 'chat-b', brief: 'summarise the bench', deliveredAs: 'queued', skipIfReportUp: true });
    await flush();
    noteChatRunEvent('chat-b', 'run_completed'); // the run it queued behind (a chat run — no agent_runs row)
    await flush();
    expect(task((r) => r.childChatId === 'chat-b').state).toBe('submitted');
    noteChatRunStarted('chat-b');
    noteChatRunEvent('chat-b', 'run_completed');
    await flush();
    expect(task((r) => r.childChatId === 'chat-b').state).toBe('completed');
  });

  it('a report up is no task; a plain-chat start is working at once; a coding lane start waits for the worker claim', async () => {
    tables.chats.push({ id: 'lane-x', projectId: 'p1' }, { id: 'ps-x', isProjectSupervisor: true, projectId: 'p1' }, { id: 'plain', projectId: null });
    tables.coding.push({ id: 'lane-x' });
    expect(await createDelegationTask({ kind: 'message_ask', source: 'send_chat_message', parentChatId: 'lane-x', childChatId: 'ps-x', deliveredAs: 'started', skipIfReportUp: true })).toBeNull();
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).toMatchObject({ phase: 'skipped', reason: 'report_up', kind: 'message_ask' });
    await createDelegationTask({ kind: 'message_ask', source: 'send_chat_message', parentChatId: 'ps-x', childChatId: 'plain', deliveredAs: 'started', skipIfReportUp: true });
    await createDelegationTask({ kind: 'message_ask', source: 'send_chat_message', parentChatId: 'ps-x', childChatId: 'lane-x', deliveredAs: 'started', skipIfReportUp: true });
    await createDelegationTask({ kind: 'message_ask', source: 'send_chat_message', parentChatId: 'ps-x', childChatId: 'lane-x', deliveredAs: 'steer', skipIfReportUp: true });
    expect(tables.tasks.map((r) => [r.childChatId, r.state])).toEqual([['plain', 'working'], ['lane-x', 'submitted'], ['lane-x', 'working']]);
  });

  it('a steer into a running lane closes with that run; a lost start note still closes when the task predates the run', async () => {
    tables.coding.push({ id: 'lane-2' });
    await createDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'fs', childChatId: 'lane-2', brief: 'race' });
    tables.runs.push({ id: 'run-r', status: 'completed', startedAt: new Date(nowMs + 5_000), createdAt: new Date(nowMs + 3_000) });
    // the worker's start note never reached this process — only the outcome does
    noteChatRunEvent('lane-2', 'run_completed', 'run-r');
    await flush();
    expect(task((r) => r.childChatId === 'lane-2')).toMatchObject({ state: 'completed', resultRef: 'run-r' });
  });

  it('a cancelled lane run (run_failed + agent_runs cancelled) → canceled; attention_needed parks a working task', async () => {
    await createDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'p', childChatId: 'lane-3', state: 'working' });
    await createDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'p', childChatId: 'lane-4', state: 'working' });
    tables.runs.push({ id: 'run-c', status: 'cancelled', startedAt: new Date(nowMs), createdAt: new Date(nowMs) });
    noteChatRunEvent('lane-3', 'run_failed', 'run-c');
    noteChatRunEvent('lane-4', 'attention_needed', 'run-d');
    await flush();
    expect(task((r) => r.childChatId === 'lane-3').state).toBe('canceled');
    expect(task((r) => r.childChatId === 'lane-4').state).toBe('input_required');
  });

  it('terminal states are immutable — a contrary late signal is one terminal_conflict row', async () => {
    await createDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'p', childChatId: 'lane-5', state: 'working' });
    noteChatRunEvent('lane-5', 'run_completed', null);
    await flush();
    noteTaskCardLifecycle('p', { taskId: 'session:lane-5', kind: 'session', status: 'failed', childChatId: 'lane-5' });
    await flush();
    expect(task((r) => r.childChatId === 'lane-5').state).toBe('completed');
    expect(metricPhases()).toContain('terminal_conflict');
  });

  it('ticket lanes: a re-dispatch supersedes the old lane; the ticket close completes the new lane; exhaustion fails a lane', async () => {
    recordDelegationTask({ kind: 'ticket', source: 'ticket_lane', parentChatId: 'reporter', childChatId: 'lane-A', childRef: 'tk-1', brief: 'fix X' });
    await flush();
    noteChatRunStarted('lane-A', 'r1');
    await flush();
    recordDelegationTask({ kind: 'ticket', source: 'ticket_lane', parentChatId: 'reporter', childChatId: 'lane-B', childRef: 'tk-1', brief: 'fix X', supersedesChildChatId: 'lane-A' });
    await flush();
    expect(task((r) => r.childChatId === 'lane-A')).toMatchObject({ state: 'canceled', reason: 'superseded' });
    // a lane run finishing on an OPEN ticket does not close the ticket task
    tables.tickets.push({ id: 'tk-1', status: 'in_progress' });
    noteChatRunStarted('lane-B', 'r2');
    noteChatRunEvent('lane-B', 'run_completed', 'r2');
    await flush();
    expect(task((r) => r.childChatId === 'lane-B').state).toBe('working');
    tables.tickets[0].status = 'done';
    noteTicketLaneClosed('tk-1', 'lane-B');
    await flush();
    expect(task((r) => r.childChatId === 'lane-B').state).toBe('completed');
    // another ticket whose lanes are exhausted
    recordDelegationTask({ kind: 'ticket', source: 'ticket_lane', childChatId: 'lane-C', childRef: 'tk-2' });
    await flush();
    noteTicketDispatchExhausted('tk-2');
    await flush();
    expect(task((r) => r.childChatId === 'lane-C')).toMatchObject({ state: 'failed', reason: 'dispatch_exhausted' });
  });

  it('#1339 / #1340 twin lanes: a second task with the same tool-intent key is stamped duplicateOfId + one duplicate_key row', async () => {
    const first = await createDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'fs', childChatId: 'lane-1339', idempotencyKey: 'k'.repeat(40) });
    const second = await createDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'fs', childChatId: 'lane-1340', idempotencyKey: 'k'.repeat(40) });
    expect(task((r) => r.id === second).duplicateOfId).toBe(first);
    expect(task((r) => r.id === first).duplicateOfId).toBeNull();
    expect(metricPhases().filter((p) => p === 'duplicate_key')).toHaveLength(1);
  });

  it('background workers: start → injected completes; posted_late completes; cancelled cancels; lost on resume fails', async () => {
    const ctx = { sessionId: 'lane-9', runId: 'run-9', userId: 'u1', machine: true };
    for (const id of ['bg1-ab', 'bg2-ab', 'bg3-ab', 'bg4-ab']) noteBackgroundWorkerPhase('start', { id, role: 'web_researcher', title: `t ${id}` }, ctx);
    noteBackgroundWorkerPhase('end_wait', null, ctx); // pool-level row — nothing to move
    noteBackgroundWorkerPhase('injected', { id: 'bg1-ab', role: 'web_researcher', title: 't' }, ctx);
    noteBackgroundWorkerPhase('posted_late', { id: 'bg2-ab', role: 'web_researcher', title: 't' }, ctx);
    noteBackgroundWorkerPhase('cancelled', { id: 'bg3-ab', role: 'web_researcher', title: 't' }, ctx);
    noteBackgroundWorkersLost(['bg4-ab'], { sessionId: 'lane-9' });
    await flush();
    const states = Object.fromEntries(tables.tasks.map((r) => [r.childRef, [r.state, r.parentRunId, r.origin]]));
    expect(states).toEqual({
      'bg1-ab': ['completed', 'run-9', 'machine'], 'bg2-ab': ['completed', 'run-9', 'machine'],
      'bg3-ab': ['canceled', 'run-9', 'machine'], 'bg4-ab': ['failed', 'run-9', 'machine'],
    });
    expect(task((r) => r.childRef === 'bg4-ab').reason).toBe('lost_on_resume');
    // a guest session has no ledger
    noteBackgroundWorkerPhase('start', { id: 'bg1-zz', role: 'r', title: 't' }, { sessionId: 'anon-x' });
    await flush();
    expect(tables.tasks.some((r) => r.childRef === 'bg1-zz')).toBe(false);
  });

  it('task card: the hand-off done card completes the session with its artifacts — also after the run outcome closed it', async () => {
    await createDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'chat-h', childChatId: 'kid-1', state: 'working' });
    await createDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'chat-h', childChatId: 'kid-2', state: 'working' });
    noteChatRunEvent('kid-2', 'run_completed', null);
    await flush();
    const card = (child: string) => ({
      taskId: `session:${child}`, chatId: 'chat-h', childChatId: child, kind: 'session', status: 'done', title: 'Deck', resultMessageId: 'msg-9',
      artifacts: [{ name: 'deck.pdf', url: '/api/crossmodel/files/dh_1/download', kind: 'file', bytes: 10 }, { name: 'PR #12', url: 'https://github.com/o/r/pull/12', kind: 'pr' }],
    });
    noteTaskCardLifecycle('chat-h', card('kid-1'));
    noteTaskCardLifecycle('chat-h', card('kid-2'));
    await flush();
    for (const kid of ['kid-1', 'kid-2']) {
      const t = task((r) => r.childChatId === kid);
      expect(t.state).toBe('completed');
      expect(t.artifacts.map((a: any) => a.ref)).toEqual(['/api/crossmodel/files/dh_1/download', 'https://github.com/o/r/pull/12']);
    }
    expect(task((r) => r.childChatId === 'kid-1').resultRef).toBe('msg-9');
  });

  it('task card: a continuation creates its own task and follows the card running → done', async () => {
    noteTaskCardLifecycle('chat-c', { taskId: 'cont-1', chatId: 'chat-c', kind: 'continuation', status: 'running', title: 'Finishing your request' });
    await flush();
    expect(task((r) => r.childRef === 'cont-1')).toMatchObject({ kind: 'continuation', state: 'working', parentChatId: 'chat-c', childChatId: 'chat-c' });
    // a run outcome on the chat itself never closes a continuation (the card owns it)
    noteChatRunEvent('chat-c', 'run_completed', null);
    await flush();
    expect(task((r) => r.childRef === 'cont-1').state).toBe('working');
    noteTaskCardLifecycle('chat-c', { taskId: 'cont-1', chatId: 'chat-c', kind: 'continuation', status: 'done', resultMessageId: 'm-2' });
    await flush();
    expect(task((r) => r.childRef === 'cont-1')).toMatchObject({ state: 'completed', resultRef: 'm-2' });
    // a waiting_user card on a fresh ask creates the task straight into input_required
    noteTaskCardLifecycle('chat-c', { taskId: 'cont-2', chatId: 'chat-c', kind: 'continuation', status: 'waiting_user', note: 'Which repo?' });
    await flush();
    expect(task((r) => r.childRef === 'cont-2')).toMatchObject({ state: 'input_required', reason: 'Which repo?' });
  });

  it('DELEGATION_TASKS_DISABLED=1 writes nothing; a client without the model never throws', async () => {
    process.env.DELEGATION_TASKS_DISABLED = '1';
    expect(delegationTasksDisabled()).toBe(true);
    recordDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'p', childChatId: 'c' });
    noteChatRunStarted('c');
    noteChatRunEvent('c', 'run_completed');
    expect(await createDelegationTask({ kind: 'session', source: 'x', parentChatId: 'p', childChatId: 'c' })).toBeNull();
    await flush();
    expect(tables.tasks).toHaveLength(0);
    delete process.env.DELEGATION_TASKS_DISABLED;
    // an unknown kind is refused, never thrown
    expect(await createDelegationTask({ kind: 'nope' as any, source: 'x' })).toBeNull();
  });

  it('read path: list (filters, open, stale), get by prefix, summary by kind × state', async () => {
    await createDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'p1', childChatId: 'k1' });
    await createDelegationTask({ kind: 'message_ask', source: 'send_chat_message', parentChatId: 'p1', childChatId: 'k2', state: 'working' });
    await createDelegationTask({ kind: 'session', source: 'start_coding_session', parentChatId: 'p2', childChatId: 'k3', state: 'completed' });
    tables.tasks[0].staleAfter = new Date(Date.now() - 1_000); // past its TTL
    expect((await listDelegationTasks({ kind: 'session' })).map((r) => r.childChatId)).toEqual(['k1', 'k3']);
    expect((await listDelegationTasks({ state: 'open' })).map((r) => r.childChatId)).toEqual(['k1', 'k2']);
    expect((await listDelegationTasks({ chatId: 'p2' })).map((r) => r.childChatId)).toEqual(['k3']);
    expect((await listDelegationTasks({ staleOnly: true })).map((r) => r.childChatId)).toEqual(['k1']);
    expect((await getDelegationTask(tables.tasks[1].id.slice(0, 9)))?.childChatId).toBe('k2');
    expect(await getDelegationTask('short')).toBeNull();
    const s = await summarizeDelegationTasks(168);
    expect(s).toMatchObject({ total: 3, open: 2, stale: 1, byKind: { session: { submitted: 1, completed: 1 }, message_ask: { working: 1 } } });
  });
});
