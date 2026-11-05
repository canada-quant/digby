/**
 * build 2026-10-08 D — the agent LOOP's two shadow seams, end to end on the
 * agent-background-delegation.test.ts harness:
 *   D-2  a side-effecting call (send_chat_message) gets its PENDING intent row
 *        and idempotency key BEFORE it runs — the key rides ctx.intentKey for
 *        exactly the duration of the call — and is settled `applied` after; a
 *        RE-CLAIMED attempt of the same agent_runs row re-issuing the call at
 *        the same step is the `skip_applied` verdict + the `executed_twice` row
 *        (shadow: the call still runs and its result is untouched). Reads
 *        (get_chat_status) never enter the journal.
 *   D-1  the background pool's phases reach the delegation ledger (start →
 *        injected) and a resumed run's lost workers are failed there.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn() },
}));
jest.mock('../github/github-mcp', () => ({ searchCode: jest.fn(), listIssues: jest.fn(), getIssue: jest.fn(), listPullRequests: jest.fn() }));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(), getGmailMessages: jest.fn(), getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(), getCalendarEvents: jest.fn(), listDriveFiles: jest.fn(), getDocContent: jest.fn(), getSheetData: jest.fn(),
}));
jest.mock('../slack/slack-mcp', () => ({ searchMessages: jest.fn(), listChannels: jest.fn(), getChannelHistory: jest.fn() }));
jest.mock('../asana/asana-mcp', () => ({ searchTasks: jest.fn(), listMyTasks: jest.fn(), listProjects: jest.fn() }));
jest.mock('../x/x-mcp', () => ({ search: jest.fn(), getUserProfile: jest.fn(), getTrends: jest.fn() }));
jest.mock('../xero/xero-mcp', () => ({ getOrganisation: jest.fn(), getContacts: jest.fn(), getInvoices: jest.fn() }));
jest.mock('../plaid/plaid-mcp', () => ({ getAccounts: jest.fn(), getBalances: jest.fn(), getTransactions: jest.fn() }));
jest.mock('../imessage/imessage.service', () => ({ getPrimaryAgent: jest.fn(), isOnline: jest.fn() }));
jest.mock('../imessage/agent-link', () => ({ agentBroker: { dispatch: jest.fn() } }));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, seatUnservableReason: async () => null, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});
const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));
jest.mock('./run-journal.service', () => ({ __esModule: true, getRecentJournalEntries: jest.fn(async () => []), formatJournalBlock: jest.fn(() => '') }));
jest.mock('./container.service', () => ({ __esModule: true, ensureSessionContainer: jest.fn(async () => false), execInContainer: jest.fn(), isContainerMode: jest.fn(() => false) }));
jest.mock('./session-credentials', () => ({ __esModule: true, gatherSessionCredentialEnv: jest.fn(async () => ({})), credentialEnvNote: jest.fn(() => '') }));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 1) }));
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => null),
  applyPlan: jest.fn(async (_s: string, _w: string, u: any) => ({ plan: u })),
  planToUpdate: jest.fn((p: any) => ({ goal: p.goal, steps: p.steps.map((s: any) => ({ ...s })) })),
  renderPlanReminder: jest.fn(() => '<plan>x</plan>'),
}));
jest.mock('./background-delegation', () => {
  const actual = jest.requireActual('./background-delegation');
  return { ...actual, postBackgroundReportMessage: jest.fn(async () => true) };
});
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => {
  const actual = jest.requireActual('../platform/loop-metrics.service');
  return { ...actual, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), recordRunSpend: jest.fn() };
});
// The executor: the journaled call answers its ok envelope and records the ctx it ran with; every other tool runs for real.
const execSeen: Array<{ name: string; intentKey: string | undefined; ctx: any }> = [];
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return {
    ...actual,
    executeCodingTool: async (ctx: any, name: string, args: any) => {
      if (name === 'send_to_instance') { execSeen.push({ name, intentKey: ctx.intentKey, ctx }); return JSON.stringify({ ok: true, tool: 'send_to_instance', message: 'Sent.' }); }
      if (name === 'send_chat_message' || name === 'get_chat_status') {
        execSeen.push({ name, intentKey: ctx.intentKey, ctx });
        return name === 'send_chat_message'
          ? JSON.stringify({ ok: true, tool: 'send_chat_message', ids: { chatId: args.chatId }, message: `Message queued in chat ${args.chatId}.` })
          : JSON.stringify({ chatId: args.chatId, coding: { status: 'idle' } });
      }
      return actual.executeCodingTool(ctx, name, args);
    },
  };
});
// D-1: the ledger seams the loop calls (captured).
const mockNoteBackgroundWorkerPhase: jest.Mock = jest.fn();
const mockNoteBackgroundWorkersLost: jest.Mock = jest.fn();
const mockSweepOrphans: jest.Mock = jest.fn();
jest.mock('../platform/delegation-tasks', () => ({
  __esModule: true,
  noteBackgroundWorkerPhase: (...a: any[]) => mockNoteBackgroundWorkerPhase(...a),
  noteBackgroundWorkersLost: (...a: any[]) => mockNoteBackgroundWorkersLost(...a),
  sweepOrphanedBackgroundWorkerTasks: (...a: any[]) => mockSweepOrphans(...a), // d5974d65: run-start orphan sweep seam
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { createIntentJournal, type IntentJournalDeps } from './tool-intents';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding', maxSteps: 8, maxDelegations: 6, contextCharBudget: 500_000,
  workspaceTools: false, planReminders: false, memorySource: 'coding',
};
const LANE = '3f2c9a10-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

let worktree: string;
const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree, sessionId: 'sess-ledger-1', projectId: 'p1', userId: 'u1', permissionMode: 'auto', model: 'glm-5.3',
  projectName: 'test', branch: 'main', profile: CODING_TEST_PROFILE, doctrineOverride: 'You are a test orchestrator.',
  history: [], userMessage: `Nudge lane ${LANE} to pick up todo 4, then check it.`, emit: jest.fn(), ...over,
});
const orchTurn = (toolCalls: any[]) => ({ content: '', reasoning: '', toolCalls, finishReason: 'tool_calls' });
const finalTurn = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const call = (name: string, args: any, id = `tc-${name}-${Math.random().toString(36).slice(2, 6)}`) => ({ id, name, arguments: JSON.stringify(args) });
const isWorker = (messages: any[]) => String(messages?.[0]?.content ?? '').includes('REPORT FORMAT (harness contract)');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

function route(orch: Array<(messages: any[]) => any>, worker: () => Promise<any> = async () => finalTurn('n/a')) {
  let i = 0;
  mockRunModelTurn.mockImplementation(async (_p: any, messages: any[]) => {
    if (isWorker(messages)) return worker();
    const fn = orch[i++];
    return fn ? fn(messages) : finalTurn('(extra turn)');
  });
}

function memoryJournalDeps() {
  const rows: Array<Record<string, any>> = [];
  const metrics: Array<Record<string, unknown>> = [];
  const deps: Partial<IntentJournalDeps> = {
    insert: async (row) => { rows.push({ ...row, state: 'pending', createdAt: new Date() }); },
    findPrior: async (idemKey, attemptId) => {
      const hit = rows.filter((r) => r.idemKey === idemKey && r.attemptId !== attemptId).pop();
      return hit ? { id: hit.id, state: hit.state, createdAt: hit.createdAt } : null;
    },
    stampPrior: async (id, priorIntentId, verdict) => { Object.assign(rows.find((r) => r.id === id)!, { priorIntentId, wouldReconcile: verdict }); },
    settle: async (id, patch) => { Object.assign(rows.find((r) => r.id === id)!, patch); },
    metric: (meta) => { metrics.push(meta); },
  };
  return { rows, metrics, deps };
}

beforeAll(async () => { worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-ledger-d-test-')); });
afterAll(async () => { await fs.rm(worktree, { recursive: true, force: true }); });
beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  execSeen.length = 0;
  process.env.DELEGATE_BACKGROUND_LATE_POST_DELAY_MS = '0';
  delete process.env.TOOL_INTENT_JOURNAL_DISABLED;
  delete process.env.TOOL_INTENT_ACT_DISABLED;
});

describe('D-2 — the dispatch seam journals side-effecting calls (shadow)', () => {
  test('pending row + key before the call, key on ctx only during it, applied after; reads never journaled; a re-claim is skip_applied + executed_twice', async () => {
    // The SHADOW pin (TOOL_INTENT_ACT_DISABLED=1 restores it byte-for-byte); act is pinned in the DL-2 block below.
    process.env.TOOL_INTENT_ACT_DISABLED = '1';
    const mem = memoryJournalDeps();
    const turns = () => [
      () => orchTurn([call('send_chat_message', { chatId: LANE, content: 'Pick up todo 4.' }), call('get_chat_status', { chatId: LANE })]),
      () => finalTurn('Lane nudged.'),
    ];
    route(turns());
    const res1 = await runCodingAgent(makeInput({ runId: 'run-d2', intentJournal: createIntentJournal({ sessionId: 'sess-ledger-1', runId: 'run-d2', deps: mem.deps }) }));
    expect(res1.finalText).toBe('Lane nudged.');
    await flush();
    expect(mem.rows.map((r) => [r.tool, r.slot, r.scope, r.state, r.reconcileClass])).toEqual([['send_chat_message', '0:0', 'run:run-d2', 'applied', 'lookup']]);
    const send = execSeen.find((e) => e.name === 'send_chat_message')!;
    expect(send.intentKey).toBe(mem.rows[0].idemKey);
    expect(send.ctx.intentKey).toBeUndefined(); // cleared right after the call
    expect(execSeen.find((e) => e.name === 'get_chat_status')!.intentKey).toBeUndefined();
    expect(mem.metrics).toHaveLength(0);

    // The worker re-claims the SAME agent_runs row (a new attempt) and the model re-issues the call at the same step.
    route(turns());
    const res2 = await runCodingAgent(makeInput({ runId: 'run-d2', intentJournal: createIntentJournal({ sessionId: 'sess-ledger-1', runId: 'run-d2', deps: mem.deps }) }));
    expect(res2.finalText).toBe('Lane nudged.'); // shadow: the call ran, the result is untouched
    await flush();
    expect(mem.rows).toHaveLength(2);
    expect(mem.rows[1].idemKey).toBe(mem.rows[0].idemKey);
    expect(mem.metrics.map((m) => [m.phase, m.tool, m.verdict])).toEqual([
      ['would_reconcile', 'send_chat_message', 'skip_applied'],
      ['executed_twice', 'send_chat_message', 'skip_applied'],
    ]);
  });

  test('TOOL_INTENT_JOURNAL_DISABLED=1: no row, no key on the ctx — the loop is unchanged', async () => {
    process.env.TOOL_INTENT_JOURNAL_DISABLED = '1';
    const mem = memoryJournalDeps();
    route([() => orchTurn([call('send_chat_message', { chatId: LANE, content: 'Pick up todo 4.' })]), () => finalTurn('done')]);
    const input = makeInput({ runId: 'run-off' });
    const res = await runCodingAgent(input);
    expect(res.finalText).toBe('done');
    expect(execSeen[0].intentKey).toBeUndefined();
    expect(input.intentJournal?.enabled).toBe(false);
    expect(mem.rows).toHaveLength(0);
  });
});

describe('DL-2 — ACT at the dispatch seam: a re-claimed attempt does NOT re-run an applied side effect', () => {
  const RECEIPT_ID = '5ba5f03e-0000-4000-8000-00000000d1a2';
  test('ticket 5ba5f03e shape — the re-claimed attempt answers the send from the earlier receipt: the executor is not called, no new receipt, the row settles replayed', async () => {
    const mem = memoryJournalDeps();
    const priorReceipt = { id: RECEIPT_ID, chatId: 'sess-ledger-1', runId: 'run-dl2', tool: 'send_chat_message', ok: true, ids: { chatId: LANE }, inputHash: null, outputHash: null, createdAt: new Date() };
    const deps = {
      ...mem.deps,
      // the production findPrior carries receiptId / inputHash (the settle wrote them); the double reads them back
      findPrior: async (idemKey: string, attemptId: string) => {
        const hit = mem.rows.filter((r) => r.idemKey === idemKey && r.attemptId !== attemptId && r.state === 'applied').pop();
        return hit ? { id: hit.id, state: hit.state, createdAt: hit.createdAt, receiptId: RECEIPT_ID, inputHash: hit.inputHash } : null;
      },
      loadReceipt: async (id: string) => (id === RECEIPT_ID ? priorReceipt : null),
    };
    let seenByModel: any[] = [];
    const turns = () => [
      () => orchTurn([call('send_chat_message', { chatId: LANE, content: 'Pick up todo 4.' })]),
      (messages: any[]) => { seenByModel = messages; return finalTurn('Lane nudged.'); },
    ];
    route(turns());
    await runCodingAgent(makeInput({ runId: 'run-dl2', intentJournal: createIntentJournal({ sessionId: 'sess-ledger-1', runId: 'run-dl2', deps }) }));
    await flush();
    expect(execSeen.filter((e) => e.name === 'send_chat_message')).toHaveLength(1);
    const { recordRunReceiptAsync } = jest.requireMock('./run-receipts.service');
    const firstReceipts = (recordRunReceiptAsync as jest.Mock).mock.calls.length;

    // The worker re-claims the SAME agent_runs row; the model re-issues the call at the same step.
    route(turns());
    const res2 = await runCodingAgent(makeInput({ runId: 'run-dl2', intentJournal: createIntentJournal({ sessionId: 'sess-ledger-1', runId: 'run-dl2', deps }) }));
    await flush();
    expect(res2.finalText).toBe('Lane nudged.');
    expect(execSeen.filter((e) => e.name === 'send_chat_message')).toHaveLength(1); // NOT re-run
    const toolMsg = seenByModel.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toMatch(new RegExp(`^\\[idempotent skip\\] send_chat_message already applied at .+ — receipt ${RECEIPT_ID}; not re-run\\.`));
    expect((recordRunReceiptAsync as jest.Mock).mock.calls.length).toBe(firstReceipts); // no second receipt
    expect(mem.rows.map((r) => r.state)).toEqual(['applied', 'replayed']);
    expect(mem.metrics.filter((m) => m.phase === 'act')).toEqual([expect.objectContaining({ decision: 'skip_applied', tool: 'send_chat_message', receiptId: RECEIPT_ID })]);
    expect(mem.metrics.some((m) => m.phase === 'executed_twice')).toBe(false);
  });

  test('an at-most-once send_to_instance the dead attempt left IN FLIGHT is withheld — never resent', async () => {
    const mem = memoryJournalDeps();
    // the dead attempt: the push was issued at step 0 and the process died before it settled (a pending row)
    const INST = 'a1b2c3d4-0000-4000-8000-000000000001';
    const SEND = { instanceId: INST, chatId: LANE, content: 'PR #12 merged' };
    createIntentJournal({ sessionId: 'sess-ledger-1', runId: 'run-dl2c', deps: mem.deps }).begin('send_to_instance', SEND, 0);
    await flush();
    let seenByModel: any[] = [];
    route([() => orchTurn([call('send_to_instance', SEND)]), (messages: any[]) => { seenByModel = messages; return finalTurn('ok'); }]);
    await runCodingAgent(makeInput({ runId: 'run-dl2c', userMessage: `Tell instance ${INST} chat ${LANE} that PR #12 merged.`, intentJournal: createIntentJournal({ sessionId: 'sess-ledger-1', runId: 'run-dl2c', deps: mem.deps }) }));
    await flush();
    expect(execSeen.filter((e) => e.name === 'send_to_instance')).toHaveLength(0);
    expect(String(seenByModel.find((m) => m.role === 'tool')?.content)).toMatch(/^\[intent withheld\] send_to_instance NOT re-sent/);
    expect(mem.rows.map((r) => r.state)).toEqual(['pending', 'withheld']);
    expect(mem.metrics.filter((m) => m.phase === 'act')).toEqual([expect.objectContaining({ decision: 'withheld', tool: 'send_to_instance', priorState: 'pending' })]);
  });

  test('a NEW call in the re-claimed attempt (different content) runs', async () => {
    const mem = memoryJournalDeps();
    route([() => orchTurn([call('send_chat_message', { chatId: LANE, content: 'Pick up todo 4.' })]), () => finalTurn('a')]);
    await runCodingAgent(makeInput({ runId: 'run-dl2b', intentJournal: createIntentJournal({ sessionId: 'sess-ledger-1', runId: 'run-dl2b', deps: mem.deps }) }));
    route([() => orchTurn([call('send_chat_message', { chatId: LANE, content: 'Now pick up todo 5.' })]), () => finalTurn('b')]);
    await runCodingAgent(makeInput({ runId: 'run-dl2b', intentJournal: createIntentJournal({ sessionId: 'sess-ledger-1', runId: 'run-dl2b', deps: mem.deps }) }));
    await flush();
    expect(execSeen.filter((e) => e.name === 'send_chat_message')).toHaveLength(2);
    expect(mem.metrics.filter((m) => m.phase === 'act')).toHaveLength(0);
  });
});

describe('D-1 — the background pool reaches the delegation ledger', () => {
  test('a background worker\'s start and injected phases are mirrored with the run identity', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let done = false;
    route([
      () => orchTurn([call('delegate', { role: 'web_researcher', task: 'Research RTSP auth for the cameras.', title: 'RTSP research', background: true })]),
      () => { release(); return orchTurn([call('read_file', { path: 'nothing.txt' })]); },
      async () => { while (!done) await new Promise((r) => setTimeout(r, 5)); return orchTurn([call('read_file', { path: 'nothing.txt' })]); },
      () => finalTurn('RTSP: 554.'),
    ], async () => { await gate; done = true; return finalTurn('RTSP listens on 554.\n```json\n{"status":"done"}\n```'); });
    await runCodingAgent(makeInput({ runId: 'run-bg', userMessage: 'research RTSP in the background' }));
    const phases = mockNoteBackgroundWorkerPhase.mock.calls.map((c) => c[0]);
    expect(phases).toEqual(expect.arrayContaining(['start', 'injected']));
    const start = mockNoteBackgroundWorkerPhase.mock.calls.find((c) => c[0] === 'start')!;
    expect(start[1]).toEqual(expect.objectContaining({ role: 'web_researcher', title: 'RTSP research' }));
    expect(start[1].id).toMatch(/^bg1-/);
    expect(start[2]).toEqual({ sessionId: 'sess-ledger-1', runId: 'run-bg', userId: 'u1', machine: false });
  });

  test('a resumed run fails the workers that did not survive the restart', async () => {
    route([() => finalTurn('re-delegating')]);
    await runCodingAgent(makeInput({
      userMessage: 'continue',
      resumeFrom: {
        version: 1, step: 2, stepBudget: 8, phase: 'preModel',
        messages: [
          { role: 'system', content: 'old system' },
          { role: 'user', content: 'research' },
          { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'delegate', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 't1', content: '[BACKGROUND WORKER STARTED — web_researcher "RTSP research" · handle bg1-dead]\nIt is running in the background…' },
        ],
      } as any,
    }));
    expect(mockNoteBackgroundWorkersLost).toHaveBeenCalledWith(['bg1-dead'], { sessionId: 'sess-ledger-1' });
  });
});
