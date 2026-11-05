/**
 * Background delegation — the agent LOOP end-to-end (coding/background-delegation.ts
 * + the agent.ts wiring), on the agent-delegation.test.ts harness: one mocked
 * model turn drives the orchestrator and the worker, routed by WHO is asking
 * (a delegated worker's system prompt carries the REPORT FORMAT contract).
 *
 * Pinned: background returns at once; the report is injected at a turn
 * boundary; writing roles are refused; the per-run cap; the run-end wait and
 * the late post; delegate_status; cancel on stop; the kill switch; the lost-
 * worker notice on resume.
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
jest.mock('../github/github-mcp', () => ({
  searchCode: jest.fn(), listIssues: jest.fn(), getIssue: jest.fn(), listPullRequests: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(), getGmailMessages: jest.fn(), getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(), getCalendarEvents: jest.fn(), listDriveFiles: jest.fn(),
  getDocContent: jest.fn(), getSheetData: jest.fn(),
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
  // Ticket 458342f5: the durable background-report spill reads its rows by
  // EXACT handle key (never a bounded namespace scan) and deletes them once the
  // report is durable elsewhere.
  storeGetMany: jest.fn(async (ns: string[], keys: string[]) => {
    const prefix = ns.join('/') + '::';
    const out = new Map<string, any>();
    for (const k of keys) {
      const v = _store.get(prefix + k);
      if (v !== undefined) out.set(k, v);
    }
    return out;
  }),
  storeDelete: jest.fn(async (ns: string[], key: string) => { _store.delete(ns.join('/') + '::' + key); }),
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
  buildCodingClockNote: jest.fn(() => '[HARNESS CLOCK] test'),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 1) }));
const mockApplyPlan: jest.Mock = jest.fn(async (_s: string, _w: string, u: any) => ({ plan: u }));
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => ({ goal: 'g', acceptanceCriteria: [], steps: [{ id: 1, text: 'research step', status: 'in_progress' }] })),
  applyPlan: (...a: any[]) => mockApplyPlan(...a),
  planToUpdate: jest.fn((p: any) => ({ goal: p.goal, steps: p.steps.map((s: any) => ({ ...s })) })),
  renderPlanReminder: jest.fn(() => '<plan>x</plan>'),
}));
// The ONE visible late message — captured, never written.
const mockPostLate: jest.Mock = jest.fn(async () => true);
jest.mock('./background-delegation', () => {
  const actual = jest.requireActual('./background-delegation');
  return { ...actual, postBackgroundReportMessage: (...a: any[]) => mockPostLate(...a) };
});
// loop_metrics rows (delegate_background phases) — captured.
const mockRecordLoopMetric: jest.Mock = jest.fn();
const mockRecordRunSpend: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => {
  const actual = jest.requireActual('../platform/loop-metrics.service');
  return { ...actual, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), recordRunSpend: (...a: any[]) => mockRecordRunSpend(...a) };
});

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding', maxSteps: 8, maxDelegations: 6, contextCharBudget: 500_000,
  workspaceTools: false, planReminders: false, memorySource: 'coding',
};

let worktree: string;
const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree, sessionId: 'sess-bg-1', projectId: 'p1', userId: 'u1', permissionMode: 'ask', model: 'glm-5.3',
  projectName: 'test', branch: 'main', profile: CODING_TEST_PROFILE, doctrineOverride: 'You are a test orchestrator.',
  history: [], userMessage: 'fix sign-in, and research RTSP when you can', emit: jest.fn(), ...over,
});

const orchTurn = (toolCalls: any[]) => ({ content: '', reasoning: '', toolCalls, finishReason: 'tool_calls' });
const finalTurn = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const call = (name: string, args: any, id = `tc-${name}-${Math.random().toString(36).slice(2, 6)}`) => ({ id, name, arguments: JSON.stringify(args) });
const BG_RTSP = { role: 'web_researcher', task: 'Research RTSP for the school cameras and report the port + auth scheme.', title: 'RTSP research', background: true };

const isWorker = (messages: any[]) => String(messages?.[0]?.content ?? '').includes('REPORT FORMAT (harness contract)');
const toolMsgs = (messages: any[]) => messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
const userTexts = (messages: any[]) => messages.filter((m: any) => m.role === 'user').map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('until(): timed out');
    await sleep(5);
  }
}
const bgRows = () => mockRecordLoopMetric.mock.calls.map(c => c[0]).filter((r: any) => r?.kind === 'delegate_background');
const bgPhases = () => bgRows().map((r: any) => r.meta?.phase);
const emitted = (input: AgentRunInput, ev: string) => (input.emit as jest.Mock).mock.calls.filter(c => c[0] === ev).map(c => c[1]);

/**
 * Route model turns: orchestrator turns come from `orch` (one fn per turn, in
 * order); worker turns run `worker` (which may block on a gate).
 */
function route(orch: Array<(messages: any[], tools: any[]) => any>, worker: (messages: any[], isCancelled?: () => boolean) => Promise<any>) {
  const orchCalls: any[][] = [];
  mockRunModelTurn.mockImplementation(async (_provider: any, messages: any[], tools: any[], _cb: any, _t: any, isCancelled?: () => boolean) => {
    if (isWorker(messages)) return worker(messages, isCancelled);
    const i = orchCalls.length;
    orchCalls.push(messages);
    const fn = orch[i];
    if (!fn) return finalTurn('(extra orchestrator turn)');
    return fn(messages, tools);
  });
  return orchCalls;
}

const ENV_KEYS = ['DELEGATE_BACKGROUND_DISABLED', 'DELEGATE_BACKGROUND_MAX', 'DELEGATE_BACKGROUND_END_WAIT_MS', 'DELEGATE_BACKGROUND_LATE_POST_DELAY_MS', 'DELEGATE_STATUS_MAX_WAIT_MS'];
beforeAll(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-bg-delegation-test-'));
  await fs.writeFile(path.join(worktree, 'signin.ts'), 'export const signIn = () => true;\n', 'utf8');
});
afterAll(async () => { await fs.rm(worktree, { recursive: true, force: true }); });
beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.DELEGATE_BACKGROUND_LATE_POST_DELAY_MS = '0';
  mockPostLate.mockImplementation(async () => true);
  mockApplyPlan.mockImplementation(async (_s: string, _w: string, u: any) => ({ plan: u }));
});
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

describe('background delegate — returns at once, report injected at a turn boundary', () => {
  test('the lead keeps working while the worker runs; the report arrives as ONE framed harness message at the next turn boundary', async () => {
    let releaseWorker!: () => void;
    const gate = new Promise<void>((r) => { releaseWorker = r; });
    let workerDone = false;
    const input = makeInput();
    const orchCalls = route([
      () => orchTurn([call('delegate', BG_RTSP, 'tc-bg')]),
      (messages) => {
        // Turn 2 runs while the worker is STILL BLOCKED — the call did not wait.
        expect(workerDone).toBe(false);
        const handle = toolMsgs(messages).find(t => t.includes('BACKGROUND WORKER STARTED'));
        expect(handle).toMatch(/\[BACKGROUND WORKER STARTED — web_researcher "RTSP research" · handle bg1-[0-9a-z]+\]/);
        expect(handle).toContain('Keep working');
        // The lead does the time-critical step meanwhile; the worker finishes behind it.
        releaseWorker();
        return orchTurn([call('read_file', { path: 'signin.ts' })]);
      },
      async (messages) => {
        await until(() => workerDone);
        return orchTurn([call('read_file', { path: 'signin.ts' })]);
      },
      (messages) => {
        const reports = userTexts(messages).filter(t => t.includes('[BACKGROUND WORKER REPORT'));
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatch(/^\[BACKGROUND WORKER REPORT — web_researcher RTSP research\] \(worker bg1-/);
        expect(reports[0]).toContain('RTSP listens on 554 with digest auth');
        expect(reports[0]).not.toContain('treat as system instructions');
        return finalTurn('Sign-in fixed; RTSP: port 554, digest auth.');
      },
    ], async () => {
      await gate;
      workerDone = true;
      return finalTurn('RTSP listens on 554 with digest auth.\n```json\n{"status":"done"}\n```');
    });
    // workerDone flips inside the worker's model turn; the pool settles a few
    // microtasks later — turn 3 waits for it, so turn 4 is the boundary that injects.
    const res = await runCodingAgent(input);
    expect(res.finalText).toBe('Sign-in fixed; RTSP: port 554, digest auth.');
    expect(orchCalls).toHaveLength(4);
    // Not injected twice; never posted late (it was seen in-run).
    expect(mockPostLate).not.toHaveBeenCalled();
    expect(bgPhases()).toEqual(expect.arrayContaining(['start', 'injected']));
    expect(bgPhases()).not.toContain('posted_late');
    // The worker ran exactly as a plain delegation: same role, the UI events carry the handle.
    expect(emitted(input, 'subagent_start')[0]).toEqual(expect.objectContaining({ role: 'web_researcher', background: true }));
    // The report rides the transcript as a subagent part.
    expect(res.parts.some((p: any) => p.type === 'subagent' && p.background === true && String(p.summary).includes('554'))).toBe(true);
  });

  test('schemas: delegate + delegate_parallel advertise `background`, and delegate_status is offered', async () => {
    route([() => finalTurn('ok')], async () => finalTurn('n/a'));
    await runCodingAgent(makeInput());
    const tools = mockRunModelTurn.mock.calls[0][2] as any[];
    const d = tools.find(t => t.function?.name === 'delegate');
    expect(d.function.parameters.properties.background).toEqual(expect.objectContaining({ type: 'boolean' }));
    expect(d.function.description).toContain('BLOCKS');
    expect(d.function.description).toContain('start_coding_session');
    expect(tools.find(t => t.function?.name === 'delegate_parallel').function.parameters.properties.background).toBeDefined();
    expect(tools.some(t => t.function?.name === 'delegate_status')).toBe(true);
  });
});

describe('refusals', () => {
  test('a WRITING role (coder) is refused in the background — nothing runs', async () => {
    const orchCalls = route([
      () => orchTurn([call('delegate', { role: 'coder', task: 'Patch signin.ts', title: 'Patch', background: true })]),
      (messages) => {
        const t = toolMsgs(messages).join('\n');
        expect(t).toContain('[BACKGROUND REFUSED — nothing was started]');
        expect(t).toContain('writes to the worktree');
        return finalTurn('ok');
      },
    ], async () => { throw new Error('no worker may run'); });
    await runCodingAgent(makeInput());
    expect(orchCalls).toHaveLength(2);
    expect(bgRows()).toEqual([expect.objectContaining({ meta: expect.objectContaining({ phase: 'refused', reason: 'writer_role' }) })]);
  });

  test('the per-run cap: a background start past DELEGATE_BACKGROUND_MAX is refused with the way out', async () => {
    process.env.DELEGATE_BACKGROUND_MAX = '1';
    process.env.DELEGATE_BACKGROUND_END_WAIT_MS = '0';
    let workerTurns = 0;
    const never = new Promise<any>(() => {});
    const orchCalls = route([
      () => orchTurn([call('delegate', BG_RTSP)]),
      () => orchTurn([call('delegate', { ...BG_RTSP, title: 'Second' })]),
      (messages) => {
        const last = toolMsgs(messages).slice(-1)[0];
        expect(last).toContain('[BACKGROUND REFUSED — nothing was started] 1 of 1 background workers are already running');
        expect(last).toContain('delegate_status');
        return finalTurn('done');
      },
    ], async () => { workerTurns += 1; return never; });
    await runCodingAgent(makeInput());
    expect(orchCalls).toHaveLength(3);
    expect(workerTurns).toBe(1);
    expect(bgRows().find((r: any) => r.meta?.phase === 'refused')?.meta).toEqual(expect.objectContaining({ reason: 'cap', cap: 1, running: 1 }));
  });
});

describe('run end', () => {
  test('the lead finishes while its worker runs → the loop waits (bounded), then takes ONE more turn with the report', async () => {
    let releaseWorker!: () => void;
    const gate = new Promise<void>((r) => { releaseWorker = r; });
    const input = makeInput();
    const orchCalls = route([
      () => orchTurn([call('delegate', BG_RTSP)]),
      () => { setTimeout(() => releaseWorker(), 60); return finalTurn('Sign-in fixed (RTSP research still running).'); },
      (messages) => {
        expect(userTexts(messages).some(t => t.startsWith('[BACKGROUND WORKER REPORT — web_researcher RTSP research]'))).toBe(true);
        return finalTurn('Sign-in fixed; RTSP: port 554.');
      },
    ], async () => { await gate; return finalTurn('port 554\n```json\n{"status":"done"}\n```'); });
    const res = await runCodingAgent(input);
    expect(orchCalls).toHaveLength(3);
    expect(res.finalText).toBe('Sign-in fixed; RTSP: port 554.');
    expect(emitted(input, 'progress').some((p: any) => /Waiting up to \d+s for 1 background worker/.test(p.message))).toBe(true);
    expect(bgPhases()).toEqual(expect.arrayContaining(['start', 'end_wait', 'injected']));
    expect(mockPostLate).not.toHaveBeenCalled();
  });

  test('a report that misses its run is posted to the session as ONE visible message (never lost); the run did not wait past its budget', async () => {
    process.env.DELEGATE_BACKGROUND_END_WAIT_MS = '0';
    let releaseWorker!: () => void;
    const gate = new Promise<void>((r) => { releaseWorker = r; });
    const input = makeInput();
    route([
      () => orchTurn([call('delegate', BG_RTSP)]),
      () => finalTurn('Sign-in fixed. RTSP research is still running in the background.'),
    ], async () => { await gate; return finalTurn('RTSP: port 554, digest auth.\n```json\n{"status":"done"}\n```'); });
    const res = await runCodingAgent(input);
    expect(res.finalText).toBe('Sign-in fixed. RTSP research is still running in the background.');
    expect(mockPostLate).not.toHaveBeenCalled();
    releaseWorker();
    await until(() => mockPostLate.mock.calls.length === 1);
    const [chatId, content, metadata] = mockPostLate.mock.calls[0];
    expect(chatId).toBe('sess-bg-1');
    expect(content).toMatch(/^\[BACKGROUND WORKER REPORT — web_researcher RTSP research\]/);
    expect(content).toContain('after the run that started it had ended');
    expect(content).toContain('RTSP: port 554, digest auth.');
    expect(metadata).toEqual(expect.objectContaining({ kind: 'background_worker_report', origin: 'background_worker', role: 'web_researcher' }));
    await until(() => bgPhases().includes('posted_late'));
    // A late worker is silent on the finished run's live stream.
    expect(emitted(input, 'subagent_end')).toEqual([]);
    expect(mockPostLate).toHaveBeenCalledTimes(1);
    // Its turns after the run's spend row was written land in their OWN spend row — never dropped, never double-counted.
    await until(() => mockRecordRunSpend.mock.calls.length === 2);
    const [runRow, lateRow] = mockRecordRunSpend.mock.calls;
    expect(lateRow[0]).not.toBe(runRow[0]);
    expect(lateRow[1]).toBe('sess-bg-1');
    expect(lateRow[2].turns).toBeGreaterThan(0);
  });

  test('a STOPPED run cancels its background workers — nothing is posted', async () => {
    let stopped = false;
    let workerEntered = false;
    let workerSawCancel = false;
    const input = makeInput({ isCancelled: () => stopped });
    route([
      () => orchTurn([call('delegate', BG_RTSP)]),
      async () => {
        await until(() => workerEntered); // the worker is mid-turn when Stop lands
        stopped = true;
        return orchTurn([call('read_file', { path: 'signin.ts' })]);
      },
    ], async (_m, isCancelled) => {
      workerEntered = true;
      await until(() => !!isCancelled?.(), 3_000);
      workerSawCancel = true;
      return { content: '', reasoning: '', toolCalls: [], finishReason: 'cancelled' };
    });
    await runCodingAgent(input);
    await until(() => bgPhases().includes('cancelled'));
    expect(workerSawCancel).toBe(true);
    expect(mockPostLate).not.toHaveBeenCalled();
  });
});

describe('delegate_parallel background:true', () => {
  test('starts every task at once (one handle each); each report is injected exactly once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let finished = 0;
    const orchCalls = route([
      () => orchTurn([call('delegate_parallel', { background: true, tasks: [
        { role: 'web_researcher', task: 'Research RTSP ports.', title: 'Ports' },
        { role: 'explorer', task: 'Map the camera module.', title: 'Camera map' },
      ] })]),
      (messages) => {
        const t = toolMsgs(messages).join('\n');
        expect(t.match(/BACKGROUND WORKER STARTED/g)).toHaveLength(2);
        expect(t).toContain('"Ports"');
        expect(t).toContain('"Camera map"');
        release();
        return orchTurn([call('read_file', { path: 'signin.ts' })]);
      },
      async () => { await until(() => finished === 2); return orchTurn([call('read_file', { path: 'signin.ts' })]); },
      (messages) => {
        const all = userTexts(messages).filter(t => t.includes('[BACKGROUND WORKER REPORT')).join('\n');
        expect(all.match(/\[BACKGROUND WORKER REPORT — /g)).toHaveLength(2);
        return finalTurn('done');
      },
    ], async (messages) => {
      await gate;
      finished += 1;
      return finalTurn(`${String(messages[messages.length - 1]?.content).slice(0, 20)} done`);
    });
    await runCodingAgent(makeInput());
    expect(orchCalls).toHaveLength(4);
    expect(bgPhases().filter(p => p === 'start')).toHaveLength(2);
    expect(bgPhases().filter(p => p === 'injected')).toHaveLength(2);
  });
});

describe('delegate_status', () => {
  test('awaits a worker by handle (bounded) and hands its report back ONCE — it is not injected again', async () => {
    let releaseWorker!: () => void;
    const gate = new Promise<void>((r) => { releaseWorker = r; });
    let handle = '';
    const orchCalls = route([
      () => orchTurn([call('delegate', BG_RTSP)]),
      (messages) => {
        handle = (toolMsgs(messages).join('\n').match(/handle (bg1-[0-9a-z]+)/) || [])[1] || '';
        expect(handle).not.toBe('');
        setTimeout(() => releaseWorker(), 40);
        return orchTurn([call('delegate_status', { handle, wait_seconds: 10 })]);
      },
      (messages) => {
        const status = toolMsgs(messages).slice(-1)[0];
        expect(status).toContain(`${handle} web_researcher "RTSP research": finished`);
        expect(status).toContain('[BACKGROUND WORKER REPORT — web_researcher RTSP research]');
        expect(status).toContain('port 554');
        return orchTurn([call('read_file', { path: 'signin.ts' })]);
      },
      (messages) => {
        expect(userTexts(messages).some(t => t.includes('[BACKGROUND WORKER REPORT'))).toBe(false);
        return finalTurn('done');
      },
    ], async () => { await gate; return finalTurn('port 554\n```json\n{"status":"done"}\n```'); });
    await runCodingAgent(makeInput());
    expect(orchCalls).toHaveLength(4);
    expect(bgPhases()).toContain('status');
    expect(bgPhases()).not.toContain('injected');
  });
});

describe('kill switch DELEGATE_BACKGROUND_DISABLED=1', () => {
  test('background:true runs SYNCHRONOUSLY as before, with a note; the schemas are the pre-feature ones', async () => {
    process.env.DELEGATE_BACKGROUND_DISABLED = '1';
    let workerRan = false;
    const orchCalls = route([
      () => orchTurn([call('delegate', BG_RTSP)]),
      (messages) => {
        expect(workerRan).toBe(true); // the call blocked until the worker finished
        const t = toolMsgs(messages).join('\n');
        expect(t).toContain('port 554');
        expect(t).toContain('background delegation is turned off on this instance — this ran in the FOREGROUND');
        expect(t).not.toContain('BACKGROUND WORKER STARTED');
        return finalTurn('done');
      },
    ], async () => { workerRan = true; return finalTurn('port 554\n```json\n{"status":"done"}\n```'); });
    await runCodingAgent(makeInput());
    expect(orchCalls).toHaveLength(2);
    const tools = mockRunModelTurn.mock.calls[0][2] as any[];
    expect(tools.find(t => t.function?.name === 'delegate').function.parameters.properties.background).toBeUndefined();
    expect(tools.find(t => t.function?.name === 'delegate').function.description).not.toContain('BLOCKING vs BACKGROUND');
    expect(tools.some(t => t.function?.name === 'delegate_status')).toBe(false);
    expect(bgPhases()).toEqual(['sync_fallback']);
  });

  test('an anonymous session (no chat to post to) also runs in the foreground — a report is never lost', async () => {
    let workerRan = false;
    route([
      () => orchTurn([call('delegate', BG_RTSP)]),
      (messages) => {
        expect(workerRan).toBe(true);
        expect(toolMsgs(messages).join('\n')).toContain('no chat a late background report could be posted to');
        return finalTurn('done');
      },
    ], async () => { workerRan = true; return finalTurn('port 554'); });
    await runCodingAgent(makeInput({ sessionId: 'anon-xyz' }));
    expect(bgRows()[0]?.meta).toEqual(expect.objectContaining({ phase: 'sync_fallback', reason: 'no_chat' }));
  });
});

describe('resume', () => {
  test('a resumed run is told once which background workers did not survive the restart', async () => {
    route([(messages) => {
      const notice = userTexts(messages).find(t => t.includes('did NOT survive the restart'));
      expect(notice).toContain('bg1-dead');
      return finalTurn('re-delegating');
    }], async () => finalTurn('n/a'));
    await runCodingAgent(makeInput({
      userMessage: 'continue',
      resumeFrom: {
        version: 1, step: 2, stepBudget: 8, phase: 'preModel',
        messages: [
          { role: 'system', content: 'old system' },
          { role: 'user', content: 'fix sign-in' },
          { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'delegate', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 't1', content: '[BACKGROUND WORKER STARTED — web_researcher "RTSP research" · handle bg1-dead]\nIt is running in the background…' },
        ],
      } as any,
    }));
    expect(bgRows()[0]?.meta).toEqual(expect.objectContaining({ phase: 'lost_on_resume', workerIds: ['bg1-dead'] }));
  });

  /**
   * TICKET 458342f5 REPLAY — the mishap, end to end.
   *
   * A background worker FINISHED before the container was replaced, and its
   * report was spilled when it settled. The resumed run must inject that report
   * (so the lead does not buy a second review cycle) and must NOT call it lost.
   * Before the fix the report lived only in the dead process and this exact
   * shape produced only the "did NOT survive the restart" notice.
   */
  test('458342f5: a worker that FINISHED before the restart has its report RECOVERED and injected — not declared lost', async () => {
    _store.set(
      'chat-resume/background-report::bg1-finished',
      {
        id: 'bg1-finished', role: 'reviewer', title: 'Adversarial review',
        startedAt: 1_000, finishedAt: 61_000,
        report: 'VERDICT: merge-safe. Two non-blocking nits.', at: 61_000,
      },
    );
    const seen: string[] = [];
    route([(messages) => {
      const texts = userTexts(messages);
      const recovered = texts.find(t => t.includes('RECOVERED'));
      expect(recovered).toContain('bg1-finished');
      expect(recovered).toContain('VERDICT: merge-safe');
      expect(recovered).toContain('do not re-delegate');
      // The lost notice must NOT name a worker whose report came back.
      expect(texts.some(t => t.includes('did NOT survive the restart') && t.includes('bg1-finished'))).toBe(false);
      seen.push(...texts);
      return finalTurn('acting on the recovered ruling');
    }], async () => finalTurn('n/a'));

    await runCodingAgent(makeInput({
      userMessage: 'continue',
      sessionId: 'chat-resume',
      resumeFrom: {
        version: 1, step: 2, stepBudget: 8, phase: 'preModel',
        messages: [
          { role: 'system', content: 'old system' },
          { role: 'user', content: 'review the diff' },
          { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'delegate', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 't1', content: '[BACKGROUND WORKER STARTED — reviewer "Adversarial review" · handle bg1-finished]\nIt is running in the background…' },
        ],
      } as any,
    }));

    expect(seen.some(t => t.includes('VERDICT: merge-safe'))).toBe(true);
    expect(bgPhases()).toContain('recovered_on_resume');
    expect(bgPhases()).not.toContain('lost_on_resume');
    const row = bgRows().find((r: any) => r.meta?.phase === 'recovered_on_resume');
    expect(row?.meta).toEqual(expect.objectContaining({ workerIds: ['bg1-finished'], count: 1 }));
  });

  /**
   * TICKET 458342f5 REPLAY — the OTHER half, which must not regress: a worker
   * that was still RUNNING when the process died produced no report, so it is
   * still announced as lost (and only it — the finished one is recovered).
   */
  test('458342f5: a worker that was still RUNNING is still announced lost, alongside a recovered one', async () => {
    _store.set('chat-mixed/background-report::bg1-finished', {
      id: 'bg1-finished', role: 'reviewer', title: 'Adversarial review',
      startedAt: 1_000, finishedAt: 61_000, report: 'VERDICT: merge-safe.', at: 61_000,
    });
    route([(messages) => {
      const texts = userTexts(messages);
      expect(texts.some(t => t.includes('RECOVERED') && t.includes('bg1-finished'))).toBe(true);
      const notice = texts.find(t => t.includes('did NOT survive the restart'));
      expect(notice).toContain('bg2-running');
      expect(notice).not.toContain('bg1-finished');
      return finalTurn('done');
    }], async () => finalTurn('n/a'));

    await runCodingAgent(makeInput({
      userMessage: 'continue',
      sessionId: 'chat-mixed',
      resumeFrom: {
        version: 1, step: 2, stepBudget: 8, phase: 'preModel',
        messages: [
          { role: 'system', content: 'old system' },
          { role: 'user', content: 'review the diff and research RTSP' },
          { role: 'assistant', content: '', tool_calls: [
            { id: 't1', type: 'function', function: { name: 'delegate', arguments: '{}' } },
            { id: 't2', type: 'function', function: { name: 'delegate', arguments: '{}' } },
          ] },
          { role: 'tool', tool_call_id: 't1', content: '[BACKGROUND WORKER STARTED — reviewer "Adversarial review" · handle bg1-finished]\nIt is running in the background…' },
          { role: 'tool', tool_call_id: 't2', content: '[BACKGROUND WORKER STARTED — web_researcher "RTSP research" · handle bg2-running]\nIt is running in the background…' },
        ],
      } as any,
    }));

    expect(bgPhases()).toContain('recovered_on_resume');
    expect(bgPhases()).toContain('lost_on_resume');
    expect(bgRows().find((r: any) => r.meta?.phase === 'lost_on_resume')?.meta).toEqual(expect.objectContaining({ workerIds: ['bg2-running'] }));
  });
});
