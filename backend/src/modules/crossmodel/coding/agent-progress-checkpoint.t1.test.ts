/**
 * audit 2026-10-06 T1-7 + T1-8 — the REAL agent loop on a coding profile.
 *
 * T1-7 (litellm.md F5): the node-b lane ran 340 + 416 min with ZERO file edits
 * while its "add the routes" plan step sat in_progress — nothing inside a run
 * watched for "no file mutation for hours". Now ≥ NO_PROGRESS_BRAKE_CALLS
 * consecutive calls that change nothing, while a step is in_progress, get ONE
 * harness notice + a `no_progress_brake` row. A mutating call resets the
 * streak; no in_progress step / chat profiles / the kill switch → nothing.
 *
 * T1-8 (schooltime.md #10): each goal-continue round's step budget ended in a
 * tools-off turn carrying FINAL_TURN_NOTICE, so the lane wrote a "Run outcome
 * (final turn …) Not done this run" deliverable the harness threw away by
 * auto-continuing (16 fake finals in one run). When the goal-continue lane WILL
 * resume, that turn now carries CHECKPOINT_TURN_NOTICE; the round that will
 * NOT resume (two stalls) still gets the real FINAL_TURN_NOTICE.
 *
 * Scaffold: agent-self-audit.5ac56d81.test.ts (real loop, in-memory store,
 * getPlan mocked per case).
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
let toolN = 0;
const mockExecuteCodingTool: jest.Mock = jest.fn(async () => `ok result ${++toolN}`);
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./coding-memory.service', () => ({
  __esModule: true,
  getUserCodingMemory: jest.fn(async () => null),
  getProjectMemory: jest.fn(async () => null),
  getSessionMemory: jest.fn(async () => null),
  formatCodingMemoryBlock: jest.fn(() => ''),
}));
jest.mock('./scaffolding.service', () => ({
  __esModule: true,
  assessDocsHealth: jest.fn(async () => ({ drift: [], nudgeSilenced: true, commandsUserOwned: false, autoRefreshable: true })),
}));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({ __esModule: true, gatherSessionCredentialEnv: jest.fn(async () => ({})), credentialEnvNote: jest.fn(() => '') }));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordRunSpend: jest.fn(),
  noteSeatFallback: jest.fn(),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', GOAL_CONTINUE: 'goal_continue', NO_PROGRESS_BRAKE: 'no_progress_brake', CONTEXT_BUDGET: 'context_budget' },
}));

const mockGetPlan: jest.Mock = jest.fn(async () => null);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlan: (...a: any[]) => mockGetPlan(...a),
}));

import { runCodingAgent, FINAL_TURN_NOTICE, CHECKPOINT_TURN_NOTICE } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const profile = (maxSteps: number): AgentProfile => ({
  kind: 'coding', maxSteps, maxDelegations: 0, contextCharBudget: 100_000,
  workspaceTools: true, planReminders: true, memorySource: 'coding',
});
const makeInput = (sessionId: string, maxSteps: number, permissionMode: 'auto' | 'ask' = 'auto'): AgentRunInput => ({
  worktree: '/tmp/t1-progress-checkpoint-does-not-exist',
  sessionId, projectId: 'p1', userId: 'u1', permissionMode, model: 'kimi-k3',
  projectName: 'test', branch: 'main', profile: profile(maxSteps),
  doctrineOverride: 'You are a test agent.', history: [],
  userMessage: 'add the two node-b routes to config.yaml', emit: jest.fn(),
});

const plan = (s1: 'in_progress' | 'pending' = 'in_progress') => ({
  goal: 'add the node-b routes', acceptanceCriteria: ['routes live'],
  steps: [{ id: 1, text: 'write the two routes', status: s1 }, { id: 2, text: 'push + PR', status: 'pending' }],
  version: 1, updatedAt: '2026-10-05T18:00:00.000Z',
});

let callN = 0;
const toolTurn = (name = 'read_file') => {
  callN += 1;
  return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: `c${callN}`, name, arguments: JSON.stringify(name === 'read_file' ? { path: `src/f${callN}.ts` } : { path: `src/f${callN}.ts`, content: 'x' }) }] };
};
const textTurn = (t: string) => ({ content: t, reasoning: '', toolCalls: [], finishReason: 'stop' });
/** Every harness user message the model saw, in order (the loop passes ONE live array). */
const harnessUserMsgs = () => {
  const calls = mockRunModelTurn.mock.calls;
  const msgs = (calls[calls.length - 1]?.[1] ?? []) as any[];
  return msgs.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[HARNESS'));
};
const metrics = (kind: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === kind);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  callN = 0; toolN = 0;
  mockGetPlan.mockResolvedValue(plan());
  for (const k of ['NO_PROGRESS_BRAKE_DISABLED', 'NO_PROGRESS_BRAKE_CALLS', 'FINAL_TURN_CHECKPOINT_DISABLED', 'NO_PROGRESS_BRAKE_V2_DISABLED']) delete process.env[k];
});

describe('T1-7 — in-run no-progress brake', () => {
  it('N consecutive non-mutating calls with a step in_progress → the notice (after the Nth result) + one metric row; v2 re-fires ESCALATED every N more (audit 2026-10-08 W2-7)', async () => {
    process.env.NO_PROGRESS_BRAKE_CALLS = '10';
    mockRunModelTurn.mockImplementation(async (_p: any, _m: any, tools: any) => (tools && callN < 25 ? toolTurn() : textTurn('stopping here')));
    await runCodingAgent(makeInput('sess-np-1', 30, 'ask'));
    const notices = harnessUserMsgs().filter((m) => m.content.includes('NO-PROGRESS CHECK'));
    expect(notices).toHaveLength(2); // pre-W2-7: ONE per run, then 2.5–4.7 h of more reading
    expect(notices[0].content).toContain('10 tool calls in a row without changing anything');
    expect(notices[0].content).toContain('plan step #1 "write the two routes"');
    expect(notices[1].content).toContain('NO-PROGRESS CHECK #2: 20 tool calls');
    expect(notices[1].content).toContain('mark step #1 blocked via update_plan');
    const rows = metrics('no_progress_brake');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ value: 10, meta: { calls: 10, threshold: 10, step: 1, rung: 1 } });
    expect(rows[1]).toMatchObject({ value: 20, meta: { calls: 20, rung: 2 } });
    expect(rows[0].meta.lastTools).toContain('read_file');
  });

  it('NO_PROGRESS_BRAKE_V2_DISABLED=1 restores ONE notice per run', async () => {
    process.env.NO_PROGRESS_BRAKE_CALLS = '10';
    process.env.NO_PROGRESS_BRAKE_V2_DISABLED = '1';
    try {
      mockRunModelTurn.mockImplementation(async (_p: any, _m: any, tools: any) => (tools && callN < 25 ? toolTurn() : textTurn('stopping here')));
      await runCodingAgent(makeInput('sess-np-1b', 30, 'ask'));
      expect(harnessUserMsgs().filter((m) => m.content.includes('NO-PROGRESS CHECK'))).toHaveLength(1);
      expect(metrics('no_progress_brake')).toHaveLength(1);
      expect(metrics('no_progress_brake')[0].meta.rung).toBeUndefined();
    } finally { delete process.env.NO_PROGRESS_BRAKE_V2_DISABLED; }
  });

  it('W2-7: a worker that made its OWN change (edit_file) resets the lead streak; a read-only worker does not', async () => {
    process.env.NO_PROGRESS_BRAKE_CALLS = '10';
    const run = async (sessionId: string, workerTool: 'edit_file' | 'read_file'): Promise<number> => {
      let leadN = 0;
      mockRunModelTurn.mockReset().mockImplementation(async (_p: any, msgs: any[], tools: any) => {
        const isWorker = msgs.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('WORKER-TASK-7'));
        if (isWorker) {
          const done = msgs.some((m) => m.role === 'tool');
          return done || !tools
            ? textTurn('worker finished\n```json\n{"status":"done"}\n```')
            : { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: `w-${sessionId}`, name: workerTool, arguments: JSON.stringify({ path: 'src/routes.ts', content: 'x', old_string: 'a', new_string: 'b' }) }] };
        }
        if (!tools || leadN >= 25) return textTurn('stopping here');
        leadN += 1;
        if (leadN === 5) return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: `d-${sessionId}`, name: 'delegate', arguments: JSON.stringify({ role: workerTool === 'edit_file' ? 'coder' : 'explorer', task: 'WORKER-TASK-7: write the route', title: 'w' }) }] };
        return { content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: `l${leadN}-${sessionId}`, name: 'read_file', arguments: JSON.stringify({ path: `src/f${leadN}.ts` }) }] };
      });
      const input = makeInput(sessionId, 30, 'ask');
      input.profile = { ...profile(30), maxDelegations: 3 };
      await runCodingAgent(input);
      const rows = metrics('no_progress_brake').filter((r) => r.sessionId === sessionId);
      if (workerTool === 'edit_file') expect(rows[0]?.meta?.workerChanges).toBe(1);
      // The lead's own transcript (the last model call is the lead's final turn):
      // how many lead tool calls preceded the FIRST notice.
      const live = mockRunModelTurn.mock.calls[mockRunModelTurn.mock.calls.length - 1][1] as any[];
      const idx = live.findIndex((m) => typeof m.content === 'string' && m.content.includes('NO-PROGRESS CHECK'));
      return idx < 0 ? -1 : live.slice(0, idx).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    };
    expect(await run('sess-np-worker-edit', 'edit_file')).toBe(15); // the worker's edit reset the streak after call 5
    expect(await run('sess-np-worker-read', 'read_file')).toBe(10); // a read-only worker changed nothing
  });

  it('REPLAY (5d96cb5c shape): a delegation that changed nothing no longer resets the streak; the kill switch restores the reset', async () => {
    process.env.NO_PROGRESS_BRAKE_CALLS = '10';
    const noticeAfter = async (sessionId: string): Promise<number> => {
      callN = 0;
      mockRunModelTurn.mockReset().mockImplementation(async (_p: any, _m: any, tools: any) => {
        if (!tools || callN >= 25) return textTurn('stopping here');
        return callN === 4 ? toolTurn('delegate') : toolTurn(); // call 5 = a delegation (refused here — no worker ran, nothing changed)
      });
      await runCodingAgent(makeInput(sessionId, 30, 'ask'));
      const live = mockRunModelTurn.mock.calls[mockRunModelTurn.mock.calls.length - 1][1] as any[];
      const idx = live.findIndex((m) => typeof m.content === 'string' && m.content.includes('NO-PROGRESS CHECK'));
      return live.slice(0, idx).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    };
    expect(await noticeAfter('sess-np-deleg')).toBe(10);
    process.env.NO_PROGRESS_BRAKE_V2_DISABLED = '1';
    try { expect(await noticeAfter('sess-np-deleg-ks')).toBe(15); } finally { delete process.env.NO_PROGRESS_BRAKE_V2_DISABLED; }
  });

  it('a mutating call resets the streak (edit_file at call 6 → the notice waits for 10 MORE calls)', async () => {
    process.env.NO_PROGRESS_BRAKE_CALLS = '10';
    mockRunModelTurn.mockImplementation(async (_p: any, _m: any, tools: any) => {
      if (!tools || callN >= 25) return textTurn('stopping here');
      return callN === 5 ? toolTurn('edit_file') : toolTurn();
    });
    await runCodingAgent(makeInput('sess-np-2', 30, 'ask'));
    const rows = metrics('no_progress_brake');
    expect(rows).toHaveLength(1);
    // the brake row is recorded after the 16th call (6 = edit, then 10 reads)
    const live = mockRunModelTurn.mock.calls[mockRunModelTurn.mock.calls.length - 1][1] as any[];
    const noticeIdx = live.findIndex((m) => typeof m.content === 'string' && m.content.includes('NO-PROGRESS CHECK'));
    const callsBefore = live.slice(0, noticeIdx).filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    expect(callsBefore).toBe(16);
  });

  it('no step in_progress → no notice; kill switch → no notice', async () => {
    process.env.NO_PROGRESS_BRAKE_CALLS = '10';
    mockGetPlan.mockResolvedValue(plan('pending'));
    mockRunModelTurn.mockImplementation(async (_p: any, _m: any, tools: any) => (tools && callN < 25 ? toolTurn() : textTurn('stopping here')));
    await runCodingAgent(makeInput('sess-np-3', 30, 'ask'));
    expect(metrics('no_progress_brake')).toHaveLength(0);

    jest.clearAllMocks(); callN = 0;
    mockGetPlan.mockResolvedValue(plan());
    process.env.NO_PROGRESS_BRAKE_DISABLED = '1';
    mockRunModelTurn.mockImplementation(async (_p: any, _m: any, tools: any) => (tools && callN < 25 ? toolTurn() : textTurn('stopping here')));
    await runCodingAgent(makeInput('sess-np-4', 30, 'ask'));
    expect(metrics('no_progress_brake')).toHaveLength(0);
    expect(harnessUserMsgs().some((m) => m.content.includes('NO-PROGRESS CHECK'))).toBe(false);
  });
});

describe('T1-8 — a round that goal-continue WILL resume ends in a CHECKPOINT turn, not a fake final', () => {
  const run = async (sessionId: string) => {
    mockRunModelTurn.mockImplementation(async (_p: any, msgs: any[], tools: any) => {
      if (tools) return toolTurn();
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      return textTurn(String(lastUser?.content).includes('CHECKPOINT') ? 'Next: write the routes.' : 'Run outcome (final turn): not done this run.');
    });
    await runCodingAgent(makeInput(sessionId, 4));
    return harnessUserMsgs().filter((m) => m.content === CHECKPOINT_TURN_NOTICE || m.content === FINAL_TURN_NOTICE).map((m) => (m.content === CHECKPOINT_TURN_NOTICE ? 'checkpoint' : 'final'));
  };

  it('two resumable rounds get CHECKPOINT; the round goal-continue stops on (2 stalls) gets the real FINAL TURN', async () => {
    expect(await run('sess-cp-1')).toEqual(['checkpoint', 'checkpoint', 'final']);
    const gc = metrics('goal_continue');
    expect(gc.map((r) => r.meta.checkpointNotice ?? false)).toEqual([true, true, false]);
    expect(gc.map((r) => r.meta.resumed)).toEqual([true, true, false]);
  });

  it('kill switch FINAL_TURN_CHECKPOINT_DISABLED=1 → every round ends on FINAL_TURN_NOTICE (pre-fix)', async () => {
    process.env.FINAL_TURN_CHECKPOINT_DISABLED = '1';
    expect(await run('sess-cp-2')).toEqual(['final', 'final', 'final']);
  });

  it('CHECKPOINT notice wording: not the end, no report, one line', () => {
    expect(CHECKPOINT_TURN_NOTICE).toContain('NOT the end of the run');
    expect(CHECKPOINT_TURN_NOTICE).toContain('Do NOT write a final report');
    expect(CHECKPOINT_TURN_NOTICE.startsWith('[HARNESS NOTICE — not typed by the user]')).toBe(true);
  });
});
