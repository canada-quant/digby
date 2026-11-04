/**
 * build 2026-10-08 F-1 — typed finish_run, SHADOW stage, wired through the REAL agent loop
 * (coding/finish-run.ts + coding/agent.ts). Harness: the zero-tool gate test's stand-ins (the model
 * turn is a jest mock, executeCodingTool is mocked).
 *
 * The shadow contract pinned here:
 *   - offered ONLY to top-level machine runs of supervisors / coding lanes (never a human turn,
 *     never a plain chat wake), appended LAST; FINISH_RUN_DISABLED=1 = byte-identical (no tool,
 *     no nudge, no row);
 *   - an in-loop call answers the fixed ACK and never executes anything;
 *   - a run that ends without it gets ONE isolated nudge turn (transcript copy + the nudge, same tool
 *     list, nothing streamed, no other tool executed) and the DELIVERED finalText never changes;
 *   - no call after the nudge ⇒ an auto-finish record; one finish_run row per eligible run.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn() },
}));

// MCP integration modules (the coding-integrations import chain).
jest.mock('../github/github-mcp', () => ({
  searchCode: jest.fn(), listIssues: jest.fn(), getIssue: jest.fn(), listPullRequests: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(), getGmailMessages: jest.fn(), getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(), getCalendarEvents: jest.fn(), listDriveFiles: jest.fn(),
  getDocContent: jest.fn(), getSheetData: jest.fn(),
}));
jest.mock('../slack/slack-mcp', () => ({
  searchMessages: jest.fn(), listChannels: jest.fn(), getChannelHistory: jest.fn(),
}));
jest.mock('../asana/asana-mcp', () => ({
  searchTasks: jest.fn(), listMyTasks: jest.fn(), listProjects: jest.fn(),
}));
jest.mock('../x/x-mcp', () => ({
  search: jest.fn(), getUserProfile: jest.fn(), getTrends: jest.fn(),
}));
jest.mock('../xero/xero-mcp', () => ({
  getOrganisation: jest.fn(), getContacts: jest.fn(), getInvoices: jest.fn(),
}));
jest.mock('../plaid/plaid-mcp', () => ({
  getAccounts: jest.fn(), getBalances: jest.fn(), getTransactions: jest.fn(),
}));
jest.mock('../imessage/imessage.service', () => ({
  getPrimaryAgent: jest.fn(), isOnline: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: 1 file read');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
}));

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

jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
// The session-scope read (this chat's earlier receipts) — lazily loaded only when a claim is still open.
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => []);
jest.mock('./run-receipts.service', () => ({
  __esModule: true,
  recordRunReceiptAsync: jest.fn(),
  getRecentChatReceipts: (...a: any[]) => mockGetRecentChatReceipts(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { FINISH_RUN_ACK, FINISH_RUN_NUDGE, FINISH_RUN_CORRECTION_HEAD } from './finish-run';
import { resetFinishRunActCache } from './finish-run-act';
import mockDatabase from '../../../config/database';

const SUPERVISOR_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 6,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
  supervisorTools: true,
};
const PLAIN_CHAT_PROFILE: AgentProfile = { ...SUPERVISOR_TEST_PROFILE, supervisorTools: undefined };

const makeInput = (machineTriggered: boolean, profile: AgentProfile = SUPERVISOR_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/finish-run-test',
  sessionId: 'sess-finish-run-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile,
  doctrineOverride: 'You are a test supervisor.',
  history: [],
  userMessage: 'machine wake: check lane chat-lane1234-abcd and report',
  emit: jest.fn(),
  machineTriggered,
});

const FINAL = { content: 'Lane checked: quiet, nothing needed this wake.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const finishCall = (args: Record<string, unknown>, id = 'f1') => ({
  content: '', reasoning: '', finishReason: 'tool_calls',
  toolCalls: [{ id, name: 'finish_run', arguments: JSON.stringify(args) }],
});
const NO_OP = { status: 'no_op', summary: 'Checked the lane; nothing needed doing.', claims: [], open_items: [] };

const toolNames = (callIdx: number): string[] => ((mockRunModelTurn.mock.calls[callIdx]?.[2] ?? []) as any[]).map((t) => t?.function?.name);
const finishRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'finish_run');

const ENV = 'FINISH_RUN_DISABLED';
const saved = process.env[ENV];
// build 2026-10-11 FA-4: the stage-2 switch (unset = on)
const ACT_ENV = 'FINISH_RUN_ACT';
const savedAct = process.env[ACT_ENV];
beforeEach(() => {
  jest.clearAllMocks();
  mockRunModelTurn.mockReset();
  _store.clear();
  delete process.env[ENV];
  delete process.env[ACT_ENV];
  resetFinishRunActCache();
});
afterEach(() => {
  jest.restoreAllMocks();
  if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  if (savedAct === undefined) delete process.env[ACT_ENV]; else process.env[ACT_ENV] = savedAct;
});

describe('finish_run SHADOW — offered, recorded, never delivered', () => {
  it('an in-loop call answers the fixed ACK, executes nothing, and the next turn\'s prose is the delivered answer', async () => {
    mockRunModelTurn.mockResolvedValueOnce(finishCall(NO_OP)).mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(true));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2); // no nudge: the run already finished
    expect(toolNames(0).at(-1)).toBe('finish_run'); // appended LAST
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
    expect(result.finalText).toBe(FINAL.content);
    const ack = result.parts.find((p) => p.type === 'tool_result' && p.name === 'finish_run');
    expect(ack?.result).toBe(FINISH_RUN_ACK);
    expect(result.finishRun).toMatchObject({ source: 'model', calls: 1, offered: true, valid: true, status: 'no_op', nudge: { outcome: 'not_needed' } });
    expect(result.finishRun).toMatchObject({ step: 0, stepsAfterCall: 1, callToEndMs: expect.any(Number) }); // the in-loop call's cost: ONE more turn
    expect(finishRows()).toEqual([expect.objectContaining({
      kind: 'finish_run', sessionId: 'sess-finish-run-1', value: 1, unit: 'valid',
      meta: expect.objectContaining({ source: 'model', valid: true, supervisor: true, machine: true }),
    })]);
    expect(mockGetRecentChatReceipts).not.toHaveBeenCalled(); // nothing open ⇒ no session read
  });

  it('a run that ends WITHOUT the call gets ONE isolated nudge turn — the delivered answer is unchanged, nothing streams, no part is added', async () => {
    mockRunModelTurn.mockResolvedValueOnce(FINAL).mockResolvedValueOnce(finishCall(NO_OP, 'n1'));
    const input = { ...makeInput(true), providerExtra: { reasoning_effort: 'max' } };
    const result = await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    const nudgeMessages = mockRunModelTurn.mock.calls[1][1] as any[];
    expect(nudgeMessages[nudgeMessages.length - 1]).toEqual({ role: 'user', content: FINISH_RUN_NUDGE });
    expect(nudgeMessages[nudgeMessages.length - 2]).toMatchObject({ role: 'assistant', content: FINAL.content });
    expect(toolNames(1)).toEqual(toolNames(0)); // the SAME tool list (prompt-cache friendly)
    expect(typeof mockRunModelTurn.mock.calls[1][5]).toBe('function'); // the bounded cancel poll
    // a seat effort ABOVE the cap is lowered for the nudge only (the lead turn keeps 'max')
    expect((mockRunModelTurn.mock.calls[0][0] as any)?.extra?.reasoning_effort).toBe('max');
    expect((mockRunModelTurn.mock.calls[1][0] as any)?.extra?.reasoning_effort).toBe('high');

    expect(result.finalText).toBe(FINAL.content);
    expect(result.parts.some((p) => p.name === 'finish_run')).toBe(false);
    expect((input.emit as jest.Mock).mock.calls.some((c) => c[0] === 'tool_call')).toBe(false);
    expect(result.finishRun).toMatchObject({ source: 'nudged', calls: 1, valid: true, nudge: { outcome: 'called' } });
    expect(finishRows()).toHaveLength(1);
  });

  it('still no call after the nudge ⇒ AUTO-FINISH record; a non-finish tool in the nudge turn is NEVER executed', async () => {
    mockRunModelTurn.mockResolvedValueOnce(FINAL).mockResolvedValueOnce({
      content: '', reasoning: '', finishReason: 'tool_calls',
      toolCalls: [{ id: 'x1', name: 'send_chat_message', arguments: '{"chatId":"chat-lane1234-abcd","text":"hi"}' }],
    });
    const result = await runCodingAgent(makeInput(true));
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
    expect(result.finalText).toBe(FINAL.content);
    expect(result.finishRun).toMatchObject({ source: 'auto', valid: false, calls: 0, nudge: { outcome: 'other_tool' }, autoClaims: 0 });

    mockRunModelTurn.mockReset();
    mockRunModelTurn.mockResolvedValueOnce(FINAL).mockResolvedValueOnce({ content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' });
    const r2 = await runCodingAgent(makeInput(true));
    expect(r2.finalText).toBe(FINAL.content); // the nudge's prose is never delivered
    expect(r2.finishRun).toMatchObject({ source: 'auto', nudge: { outcome: 'prose' } });
  });

  it('the nudge is bounded: past FINISH_RUN_NUDGE_TIMEOUT_MS its cancel poll fires ⇒ outcome timeout, answer unchanged', async () => {
    const t0 = Date.now();
    mockRunModelTurn.mockResolvedValueOnce(FINAL).mockImplementationOnce(async (_p: any, _m: any, _t: any, _cb: any, _ms: any, isCancelled: () => boolean) => {
      jest.spyOn(Date, 'now').mockReturnValue(t0 + 10 * 60_000);
      return { content: '', reasoning: '', toolCalls: [], finishReason: isCancelled() ? 'cancelled' : 'stop' };
    });
    const result = await runCodingAgent(makeInput(true));
    expect(result.finalText).toBe(FINAL.content);
    expect(result.finishRun?.nudge.outcome).toBe('timeout');
  });

  it('claims are checked against THIS run\'s receipts: a real send verifies, a forged merge is rejected with its reason — and the answer is untouched', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(JSON.stringify({ ok: true, tool: 'send_chat_message', ids: { messageId: 'm-9f8e7d6c5b', chatId: 'chat-lane1234-abcd' } }));
    mockRunModelTurn
      .mockResolvedValueOnce({ content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 's1', name: 'send_chat_message', arguments: '{"chatId":"chat-lane1234-abcd","text":"rebase onto main"}' }] })
      .mockResolvedValueOnce(finishCall({ status: 'done', summary: 'Steered the lane.', claims: [{ type: 'message_sent', ref: 'm-9f8e7d6c5b' }, { type: 'merge', ref: '999' }] }))
      .mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(true));
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(result.finalText).toBe(FINAL.content);
    expect(result.finishRun).toMatchObject({
      source: 'model', valid: false, claims: 2, verified: 1, unverified: 1, byVia: { this_run: 1 },
      rejected: [expect.objectContaining({ type: 'pr_merged', ref: '999', reason: 'no_receipt' })],
    });
    expect(mockGetRecentChatReceipts).toHaveBeenCalledTimes(1); // the open claim tried the session scope once
  });

  it('build 2026-10-09 FR-3: a supervisor\'s state save (no receipt tool) reaches the executed tier through the loop — "ticket_update save_supervisor_state" is a recorded type repair, the finish valid', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(JSON.stringify({ applied: ['notes'], errors: [] }, null, 1));
    mockRunModelTurn
      .mockResolvedValueOnce({ content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'u1', name: 'update_supervisor_state', arguments: '{"notes":"lane quiet"}' }] })
      .mockResolvedValueOnce(finishCall({ status: 'done', summary: 'Saved state.', claims: [{ type: 'ticket_update', ref: 'save_supervisor_state' }] }))
      .mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(true));
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(result.finalText).toBe(FINAL.content);
    expect(result.finishRun).toMatchObject({
      source: 'model', valid: true, claims: 1, verified: 0, unverified: 0, repaired: 1, rejected: [],
      repairs: [{ from: 'ticket_update', to: 'state_update', ref: 'save_supervisor_state', reason: 'wrong_type' }],
    });
  });
});

describe('finish_run SHADOW — scope and kill switch (byte-identical outside it)', () => {
  it('a HUMAN turn is never offered the tool and never nudged', async () => {
    mockRunModelTurn.mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(false));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(toolNames(0)).not.toContain('finish_run');
    expect(result.finishRun).toBeUndefined();
    expect(finishRows()).toEqual([]);
  });

  it('a plain (non-supervisor) chat wake is out of scope', async () => {
    mockRunModelTurn.mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(true, PLAIN_CHAT_PROFILE));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(toolNames(0)).not.toContain('finish_run');
    expect(result.finishRun).toBeUndefined();
  });

  it('FINISH_RUN_DISABLED=1: no tool, no nudge, no row', async () => {
    process.env[ENV] = '1';
    mockRunModelTurn.mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(true));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(toolNames(0)).not.toContain('finish_run');
    expect(result.finishRun).toBeUndefined();
    expect(finishRows()).toEqual([]);
  });
});

describe('build 2026-10-11 FA — the supervisor read verify + stage 2 (soft in-loop correction) through the REAL loop', () => {
  const OQ = 'oq_1215f6f0-aaaa-4bbb-8ccc-dddddddddddd';
  const MSG = '749bb6c0-1111-4222-8333-444455556666';
  const verifyOq = { status: 'done', summary: 'Checked the owner question.', claims: [{ type: 'verify', ref: 'oq_1215f6f0' }] };
  const unbacked = { status: 'done', summary: 'Checked the lane.', claims: [{ type: 'verify', ref: '26fb95e3' }] };
  const finishResults = (parts: any[]) => parts.filter((p) => p.type === 'tool_result' && p.name === 'finish_run').map((p) => String(p.result));
  const readCall = (name: string, args: Record<string, unknown>, id = 'r1') => ({
    content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  });

  it('FA-1: a verify of ids a READ returned (get_chat_messages message id) is valid on the first call — the ACK, no correction', async () => {
    // the id sits past the 200-char receipt head (RECEIPT_HEAD_CHARS) — only the read index can see it (the prod gap)
    mockExecuteCodingTool.mockResolvedValueOnce(JSON.stringify({ chatId: 'chat-lane1234-abcd', messages: [{ id: 'm-first', content: 'x'.repeat(400) }, { id: MSG, role: 'assistant' }], hasMore: false }));
    mockRunModelTurn
      .mockResolvedValueOnce(readCall('get_chat_messages', { chatId: 'chat-lane1234-abcd' }))
      .mockResolvedValueOnce(finishCall({ status: 'done', summary: 'Read the lane.', claims: [{ type: 'verify', ref: 'msg 749bb6c0' }] }))
      .mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(true));
    expect(result.finalText).toBe(FINAL.content);
    expect(finishResults(result.parts)).toEqual([FINISH_RUN_ACK]);
    expect(result.finishRun).toMatchObject({ valid: true, byVia: { read: 1 }, inLoopError: false, rejectedOnFirst: false, actMode: 'on', actApplied: true });
  });

  it('stage 2 (default on): an unbacked verify gets the ONE correction; the model READS the id and re-calls ⇒ ACK, valid, correctedOnSecond — the delivered final is untouched', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(JSON.stringify({ count: 2, questions: [{ id: 'oq_00000000-first', context: 'y'.repeat(400) }, { id: OQ, status: 'open' }] }));
    mockRunModelTurn
      .mockResolvedValueOnce(finishCall(verifyOq, 'f1'))
      .mockResolvedValueOnce(readCall('list_owner_questions', {}))
      .mockResolvedValueOnce(finishCall(verifyOq, 'f2'))
      .mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(true));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4); // no nudge — the run called finish_run
    const acks = finishResults(result.parts);
    expect(acks).toHaveLength(2);
    expect(acks[0].startsWith(FINISH_RUN_CORRECTION_HEAD)).toBe(true);
    expect(acks[0]).toContain('claims[0] (verify)');
    expect(acks[0]).not.toContain('oq_1215f6f0'); // the ref is never echoed into the tool-output haystack
    expect(acks[1]).toBe(FINISH_RUN_ACK);
    expect(result.finalText).toBe(FINAL.content);
    expect(result.finishRun).toMatchObject({
      source: 'model', calls: 2, valid: true, byVia: { read: 1 }, nudge: { outcome: 'not_needed' },
      inLoopError: true, rejectedOnFirst: true, correctedOnSecond: true, extraTurnMs: expect.any(Number),
    });
    expect(finishRows()).toEqual([expect.objectContaining({ value: 1, meta: expect.objectContaining({ inLoopError: true, correctedOnSecond: true, rejectedOnFirst: true }) })]);
  });

  it('a second INVALID call ends it: the fixed ACK (no second correction), the run ends normally, the final untouched, the row invalid', async () => {
    mockRunModelTurn.mockResolvedValueOnce(finishCall(unbacked, 'f1')).mockResolvedValueOnce(finishCall(unbacked, 'f2')).mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(true));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    const acks = finishResults(result.parts);
    expect(acks[0].startsWith(FINISH_RUN_CORRECTION_HEAD)).toBe(true);
    expect(acks[1]).toBe(FINISH_RUN_ACK);
    expect(result.finalText).toBe(FINAL.content);
    expect(result.finishRun).toMatchObject({ valid: false, calls: 2, inLoopError: true, rejectedOnFirst: true, correctedOnSecond: false });
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
  });

  it('no second call after the correction: the run ends on its prose (no nudge — the correction WAS the extra turn)', async () => {
    mockRunModelTurn.mockResolvedValueOnce(finishCall(unbacked, 'f1')).mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(true));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(result.finalText).toBe(FINAL.content);
    expect(result.finishRun).toMatchObject({ valid: false, calls: 1, nudge: { outcome: 'not_needed' }, inLoopError: true, correctedOnSecond: false });
  });

  it('FINISH_RUN_ACT=off: the shadow stage byte-for-byte — the fixed ACK on an invalid call; rejectedOnFirst still measured', async () => {
    process.env[ACT_ENV] = 'off';
    mockRunModelTurn.mockResolvedValueOnce(finishCall(unbacked)).mockResolvedValueOnce(FINAL);
    const result = await runCodingAgent(makeInput(true));
    expect(finishResults(result.parts)).toEqual([FINISH_RUN_ACK]);
    expect(result.finalText).toBe(FINAL.content);
    expect(result.finishRun).toMatchObject({ valid: false, actMode: 'off', actApplied: false, inLoopError: false, rejectedOnFirst: true, correctedOnSecond: null });
  });

  it('FINISH_RUN_ACT=seats: unmeasurable seat stats ⇒ shadow (fail-safe ACK); a seat measured over the bar ⇒ the correction', async () => {
    process.env[ACT_ENV] = 'seats';
    mockRunModelTurn.mockResolvedValueOnce(finishCall(unbacked)).mockResolvedValueOnce(FINAL);
    const r1 = await runCodingAgent(makeInput(true));
    expect(finishResults(r1.parts)).toEqual([FINISH_RUN_ACK]);
    expect(r1.finishRun).toMatchObject({ actMode: 'seats', actApplied: false, actReason: 'seat_stats_unavailable', inLoopError: false });

    resetFinishRunActCache();
    (mockDatabase as any).$queryRaw = jest.fn(async () => [{ seat: 'glm-5.2', runs: 40, valid: 39 }]);
    try {
      mockRunModelTurn.mockReset();
      mockRunModelTurn.mockResolvedValueOnce(finishCall(unbacked)).mockResolvedValueOnce(FINAL);
      const r2 = await runCodingAgent(makeInput(true));
      expect(finishResults(r2.parts)[0].startsWith(FINISH_RUN_CORRECTION_HEAD)).toBe(true);
      expect(r2.finalText).toBe(FINAL.content);
      expect(r2.finishRun).toMatchObject({ actMode: 'seats', actApplied: true, actReason: 'seat_meets_bar', actSeatRate: 0.975, inLoopError: true });
    } finally {
      delete (mockDatabase as any).$queryRaw;
    }
  });

  it('a NUDGED call is never corrected — the nudge is unchanged and stays that run\'s one extra turn', async () => {
    mockRunModelTurn.mockResolvedValueOnce(FINAL).mockResolvedValueOnce(finishCall(unbacked, 'n1'));
    const result = await runCodingAgent(makeInput(true));
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(result.finalText).toBe(FINAL.content);
    expect(result.finishRun).toMatchObject({ source: 'nudged', valid: false, inLoopError: false, rejectedOnFirst: true, actApplied: null });
  });
});
