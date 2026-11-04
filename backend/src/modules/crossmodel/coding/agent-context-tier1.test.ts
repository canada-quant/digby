/**
 * build 2026-10-11 T1 — tier-1 context clearing ACTS, through the REAL agent loop (coding/agent.ts +
 * coding/context-gauge.ts tier1Act). Owner order 2026-10-11 "turn everything remaining on"; context.md §4 stage 3
 * (canary A/B) + stage 4 (act).
 *
 * Shape: a long lane whose tool results are 40k chars each (a read-heavy GLM lane — context.md §1.3: 48 / 70 gateway
 * GLM runs peaked ≥ 128k prompt tokens) and whose provider-reported prompt crosses T = 160k tokens. Pinned:
 *  - TREATMENT: ONE batched edit at the top of the step after the crossing — the oldest tool results become stubs
 *    (name + args, 400-char head, "re-run the call"), the last 5 rounds stay raw, nothing else changes; one
 *    `tier1_act` row with predicted vs observed cached tokens; run_summary arm 'treatment';
 *  - CONTROL / `shadow` / `off`: no request ever carries a stub;
 *  - a steer inside the last K = 5 turns defers the edit;
 *  - a cleared result can be re-read (the tool runs again, the full text comes back raw);
 *  - the evidence guard's haystack (result.toolTexts in-run, the checkpoint's clearedToolTexts on a resume) and
 *    finish_run's receipt check are unaffected.
 *
 * Harness: agent-context.c.test.ts (repo-standard stand-ins).
 */

jest.mock('../../../utils/utility-llm', () => ({
  ...jest.requireActual('../../../utils/utility-llm'),
  utilityChat: jest.fn(async () => 'RECAP'),
}));
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
const mockSent: any[][] = [];
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  // a deep copy of the messages AS SENT (the loop mutates the same array afterwards)
  return { ...actual, runModelTurn: (...a: any[]) => { mockSent.push(JSON.parse(JSON.stringify(a[1] ?? []))); return mockRunModelTurn(...a); } };
});

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'small result');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  noteSeatFallback: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss', CONTEXT_BUDGET: 'context_budget' },
}));
jest.mock('../model-endpoints/model-endpoints.service', () => ({ __esModule: true, resolveRegistryModel: jest.fn(async () => null) }));

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
  JOURNAL_ENTRIES_N: 6,
  MACHINE_JOURNAL_ENTRIES_N: 10,
  MACHINE_JOURNAL_BLOCK_CAP: 4000,
}));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
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
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 1), buildSessionMemoryInventory: jest.fn(async () => '') }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn(), getRecentChatReceipts: jest.fn(async () => []) }));

import { runCodingAgent } from './agent';
import { __resetContextCharCeilingsForTests } from './coding-model';
import { __resetSeatInvalidRequestLatchesForTests } from './seat-invalid-request';
import { STEER_MARKER_TEXT, TIER1_KEEP_ROUNDS, TIER1_STEER_GUARD_TURNS, TIER1_TRIGGER_TOKENS } from './context-gauge';
import { CLEARED_RESULT_PREFIX } from './context-clearing';
import { findUnmatchedQuotedOutputs, priorToolTextsFromCheckpoint } from './run-evidence-guard';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import type { RunCheckpoint } from './run-state';

/** A lane profile with a big budget (the GLM family budget is 4M chars — compaction stays far away). */
const LANE: AgentProfile = {
  kind: 'coding', maxSteps: 30, maxDelegations: 0, contextCharBudget: 4_000_000,
  workspaceTools: false, planReminders: false, memorySource: 'coding',
};
const SUPERVISOR: AgentProfile = {
  kind: 'chat', maxSteps: 30, maxDelegations: 0, contextCharBudget: 4_000_000,
  workspaceTools: false, planReminders: false, memorySource: 'chat', supervisorTools: true,
};
const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/t1-act-test', sessionId: 'sess-t1-act', projectId: 'p1', userId: 'u1', runId: 'run-t1-act',
  permissionMode: 'auto', model: 'glm-5.3', projectName: 'test', branch: 'main', profile: LANE,
  doctrineOverride: 'You are a test agent.', history: [], userMessage: 'Audit every module and report.', emit: jest.fn(),
  ...over,
});

const RESULT_CHARS = 40_000;
const bodyOf = (q: string) => `RESULT[${q}]\n${Array.from({ length: Math.ceil(RESULT_CHARS / 40) }, (_, i) => `${q} finding ${String(i).padStart(4, '0')}: checked ok`).join('\n')}`.slice(0, RESULT_CHARS);
const QUERIES = Array.from({ length: 20 }, (_, i) => `module-${String(i).padStart(2, '0')}`);
const promptAt = (k: number) => 60_000 + 11_000 * k; // turn 10 → 170k: the first reading over T
const toolTurn = (k: number, q = QUERIES[k]) => ({
  content: '', reasoning: '', finishReason: 'tool_calls',
  toolCalls: [{ id: `t${k}`, name: 'search_memory', arguments: JSON.stringify({ query: q }) }],
  usage: { promptTokens: promptAt(k), completionTokens: 200, cachedTokens: Math.max(0, promptAt(k) - 12_000) },
});
const FINAL = (k: number) => ({ content: 'Audit done.', reasoning: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 120_000, completionTokens: 50, cachedTokens: 60_000 } });

const rows = (kind: string, event?: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === kind && (!event || r?.meta?.event === event));
const toolMsgs = (callIdx: number) => (mockSent[callIdx] as any[]).filter((m) => m.role === 'tool');
const isStub = (m: any) => typeof m?.content === 'string' && m.content.startsWith(CLEARED_RESULT_PREFIX);
const sentStubs = () => mockSent.map((req) => req.filter((m: any) => m.role === 'tool' && isStub(m)).length);
const progress = (input: AgentRunInput) => (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'progress').map((c) => String(c[1]?.message ?? ''));

/** n tool turns then a final; every tool result is a 40k-char body named after its query. */
function drive(n: number, extra: Array<Record<string, unknown>> = []) {
  mockExecuteCodingTool.mockImplementation(async (_ctx: any, name: string, args: any) => (name === 'search_memory' ? bodyOf(String(args?.query)) : 'small result'));
  for (let k = 0; k < n; k++) mockRunModelTurn.mockResolvedValueOnce(toolTurn(k));
  for (const t of extra) mockRunModelTurn.mockResolvedValueOnce(t);
  mockRunModelTurn.mockResolvedValueOnce(FINAL(n));
}

const SWITCH = 'CONTEXT_CLEARING_ENABLED';
beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockRunModelTurn.mockReset();
  mockExecuteCodingTool.mockReset();
  mockSent.length = 0;
  delete process.env[SWITCH];
  delete process.env.CONTEXT_GAUGE_DISABLED;
  __resetContextCharCeilingsForTests();
  __resetSeatInvalidRequestLatchesForTests();
});
afterEach(() => { delete process.env[SWITCH]; });

describe('TREATMENT (act, control share 0): ONE batched edit after the crossing', () => {
  it('the request after the crossing carries stubs for the oldest results, the last 5 rounds raw, every other message verbatim', async () => {
    process.env[SWITCH] = 'act:0';
    drive(13);
    const checkpoints: RunCheckpoint[] = [];
    const input = makeInput({ onCheckpoint: (cp) => { checkpoints.push(JSON.parse(JSON.stringify(cp))); } });
    const result = await runCodingAgent(input);
    expect(result.finalText).toContain('Audit done.');

    // turn 10 reported 170k (> T) ⇒ request 11 is the first edited one; before it, no stub was ever sent
    expect(promptAt(10)).toBeGreaterThan(TIER1_TRIGGER_TOKENS);
    const stubs = sentStubs();
    expect(stubs.slice(0, 11).every((n) => n === 0)).toBe(true);
    expect(stubs[11]).toBeGreaterThan(0);
    // ONE batched edit: the stub count never grows again (the next readings are under T / insufficient)
    expect(new Set(stubs.slice(11))).toEqual(new Set([stubs[11]]));
    const tools11 = toolMsgs(11);
    expect(tools11.slice(-TIER1_KEEP_ROUNDS).every((m) => !isStub(m))).toBe(true);
    expect(isStub(tools11[0])).toBe(true);
    expect(tools11[0].content).toBe(`[cleared to save context: search_memory({"query":"module-00"}) returned ${bodyOf('module-00').length.toLocaleString('en-US')} chars — the first 400 are kept below. Re-run the call if you need the full result.]\n${bodyOf('module-00').slice(0, 400)}…`);
    // every non-tool message of request 11 is byte-identical to request 10's (and the tool_call ids pair up)
    const nonTool = (i: number) => (mockSent[i] as any[]).filter((m) => m.role !== 'tool' && m.role !== 'system');
    expect(nonTool(11).slice(0, nonTool(10).length)).toEqual(nonTool(10));
    expect(tools11.slice(0, toolMsgs(10).length).map((m) => m.tool_call_id)).toEqual(toolMsgs(10).map((m) => m.tool_call_id));

    const [act] = rows('context_edit', 'tier1_act');
    expect(rows('context_edit', 'tier1_act')).toHaveLength(1);
    expect(act).toMatchObject({ sessionId: 'sess-t1-act', runId: 'run-t1-act', unit: 'tokens' });
    expect(act.meta).toMatchObject({ arm: 'treatment', promptTokensBefore: promptAt(10), observedPromptTokens: promptAt(11), clearedResults: stubs[11] });
    expect(act.meta.freedTokens).toBeGreaterThanOrEqual(40_000);
    expect(rows('context_edit', 'tier1_shadow')).toEqual([]);
    const [summary] = rows('context_edit', 'run_summary');
    expect(summary.meta).toMatchObject({ arm: 'treatment', t1Mode: 'act', t1ControlShare: 0, t1Eligible: true, t1Events: 1, t1ReReads: 0, endState: 'ok' });
    expect(summary.meta).toMatchObject({ toolCalls: 13, searchMemoryCalls: 13, dupCalls: 0 });
    expect(progress(input).some((m) => /^Cleared \d+ older tool results \(~\d+k tokens\)/.test(m))).toBe(true);
    expect(rows('context_compaction')).toEqual([]); // tier 2 never ran

    // EVIDENCE GUARD, in-run: the full originals stay in the guard haystack (toolTexts), never the stubs
    expect(result.toolTexts).toEqual(expect.arrayContaining([bodyOf('module-00'), bodyOf('module-01')]));
    const quote = 'Observed output:\n```\n' + bodyOf('module-00').split('\n').slice(20, 23).join('\n') + '\n```';
    expect(findUnmatchedQuotedOutputs(quote, [], result.toolTexts)).toEqual([]);
    // …and on a RESUME: the checkpoint carries the cleared originals beside the stubbed messages
    const last = checkpoints.at(-1)!;
    expect(last.messages.some((m: any) => isStub(m))).toBe(true);
    expect(last.clearedToolTexts).toEqual(expect.arrayContaining([bodyOf('module-00')]));
    expect(findUnmatchedQuotedOutputs(quote, [], priorToolTextsFromCheckpoint(last))).toEqual([]);
    // without the union the stubbed transcript alone would convict the honest quote
    expect(findUnmatchedQuotedOutputs(quote, [], priorToolTextsFromCheckpoint({ messages: last.messages }))).toHaveLength(1);
  });

  it('a resumed run re-arms with the checkpoint\'s cleared originals and keeps them in its own checkpoints', async () => {
    process.env[SWITCH] = 'act:0';
    drive(13);
    const checkpoints: RunCheckpoint[] = [];
    await runCodingAgent(makeInput({ onCheckpoint: (cp) => { checkpoints.push(JSON.parse(JSON.stringify(cp))); } }));
    const cp = checkpoints.at(-1)!;
    mockRunModelTurn.mockReset();
    mockRunModelTurn.mockResolvedValueOnce(FINAL(0));
    const resumed: RunCheckpoint[] = [];
    await runCodingAgent(makeInput({ resumeFrom: cp, onCheckpoint: (c) => { resumed.push(JSON.parse(JSON.stringify(c))); } }));
    expect(resumed.at(-1)!.clearedToolTexts).toEqual(cp.clearedToolTexts);
  });

  it('a cleared result can be re-read: the same call runs again and its full text comes back raw', async () => {
    process.env[SWITCH] = 'act:0';
    // turn 11 (after the edit) re-issues turn 0's call
    drive(11, [{ ...toolTurn(11, QUERIES[0]), usage: { promptTokens: 120_000, completionTokens: 100, cachedTokens: 60_000 } }]);
    const input = makeInput();
    await runCodingAgent(input);
    const reread = toolMsgs(12);
    expect(isStub(reread.find((m) => m.tool_call_id === 't0'))).toBe(true);
    expect(reread.at(-1)).toMatchObject({ tool_call_id: 't11', content: bodyOf('module-00') });
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[2]?.query === 'module-00')).toHaveLength(2);
    expect(rows('context_edit', 'run_summary')[0].meta).toMatchObject({ t1ReReads: 1, dupCalls: 1 });
  });
});

describe('CONTROL / shadow / off never edit a prompt', () => {
  it.each([
    ['act:1', 'control'],
    ['shadow', 'shadow'],
  ])('%s: no stub in any request; a tier1_shadow row says what treatment would do (arm %s)', async (value, arm) => {
    process.env[SWITCH] = value;
    drive(13);
    await runCodingAgent(makeInput());
    expect(sentStubs().every((n) => n === 0)).toBe(true);
    expect(rows('context_edit', 'tier1_act')).toEqual([]);
    const shadow = rows('context_edit', 'tier1_shadow');
    expect(shadow.length).toBeGreaterThan(0);
    expect(shadow.every((r) => r.meta.arm === arm)).toBe(true);
    expect(rows('context_edit', 'run_summary')[0].meta).toMatchObject({ arm, t1Eligible: true });
  });

  it('off: no stub, no tier-1 row; the gauge still writes its run summary', async () => {
    process.env[SWITCH] = 'off';
    drive(13);
    await runCodingAgent(makeInput());
    expect(sentStubs().every((n) => n === 0)).toBe(true);
    expect(rows('context_edit', 'tier1_act')).toEqual([]);
    expect(rows('context_edit', 'tier1_shadow')).toEqual([]);
    expect(rows('context_edit', 'run_summary')[0].meta).toMatchObject({ arm: 'off', t1Mode: 'off', t1Events: 0 });
  });

  it('CONTEXT_GAUGE_DISABLED=1: no gauge ⇒ no tier 1 either', async () => {
    process.env.CONTEXT_GAUGE_DISABLED = '1';
    drive(13);
    await runCodingAgent(makeInput());
    expect(sentStubs().every((n) => n === 0)).toBe(true);
    expect(rows('context_edit')).toEqual([]);
  });
});

describe('the steer guard in the loop', () => {
  it('a steer inside the last K turns defers the edit until K assistant turns have passed', async () => {
    process.env[SWITCH] = 'act:0';
    drive(16);
    const steerAtStep = 9;
    const input = makeInput({
      injectSystem: (step: number) => (step === steerAtStep ? `The user sent this WHILE you are working — ${STEER_MARKER_TEXT} with high priority. Adjust your plan/approach to honor it, then continue:\ncheck module 19 first` : null),
    });
    await runCodingAgent(input);
    const stubs = sentStubs();
    // the steer arrived with request 9; readings over T from turn 10 on; the edit waits for K turns after the steer
    const firstEdited = stubs.findIndex((n) => n > 0);
    expect(firstEdited).toBe(steerAtStep + TIER1_STEER_GUARD_TURNS);
    const [act] = rows('context_edit', 'tier1_act');
    expect(act.meta.turnsSinceAnchor).toBe(TIER1_STEER_GUARD_TURNS);
    expect(rows('context_edit', 'run_summary')[0].meta.t1SteerBlockedTurns).toBe(firstEdited - 11);
    // the steer itself is never touched
    expect((mockSent[firstEdited] as any[]).some((m) => m.role === 'user' && String(m.content).includes('check module 19 first'))).toBe(true);
  });
});

describe('finish_run is unaffected', () => {
  it('a supervisor machine run whose send_chat_message result was cleared still verifies its message_sent claim from the receipts', async () => {
    process.env[SWITCH] = 'act:0';
    const SEND = JSON.stringify({ ok: true, tool: 'send_chat_message', ids: { messageId: 'm-9f8e7d6c5b', chatId: 'chat-lane1234-abcd' }, note: 'delivered. '.repeat(400) });
    mockExecuteCodingTool.mockImplementation(async (_ctx: any, name: string, args: any) => (name === 'send_chat_message' ? SEND : name === 'search_memory' ? bodyOf(String(args?.query)) : 'small result'));
    mockRunModelTurn.mockResolvedValueOnce({ content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 's0', name: 'send_chat_message', arguments: '{"chatId":"chat-lane1234-abcd","text":"rebase onto main"}' }], usage: { promptTokens: 50_000, completionTokens: 10, cachedTokens: 40_000 } });
    for (let k = 1; k <= 12; k++) mockRunModelTurn.mockResolvedValueOnce(toolTurn(k));
    mockRunModelTurn.mockResolvedValueOnce({ content: '', reasoning: '', finishReason: 'tool_calls', toolCalls: [{ id: 'f1', name: 'finish_run', arguments: JSON.stringify({ status: 'done', summary: 'Steered the lane.', claims: [{ type: 'message_sent', ref: 'm-9f8e7d6c5b' }], open_items: [] }) }], usage: { promptTokens: 110_000, completionTokens: 10, cachedTokens: 50_000 } });
    mockRunModelTurn.mockResolvedValueOnce({ content: 'Lane steered.', reasoning: '', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 110_000, completionTokens: 10, cachedTokens: 100_000 } });
    const result = await runCodingAgent(makeInput({ profile: SUPERVISOR, machineTriggered: true, userMessage: '[MACHINE-TRIGGERED RUN] wake: check lane chat-lane1234-abcd' }));
    // the send result was cleared before the finish_run call
    const finishReq = mockSent.findIndex((req) => req.some((m: any) => m.role === 'assistant' && m.tool_calls?.some((t: any) => t.function?.name === 'finish_run')));
    const sendResult = (mockSent[finishReq - 1] as any[]).find((m) => m.tool_call_id === 's0');
    expect(isStub(sendResult)).toBe(true);
    expect(result.finishRun).toMatchObject({ source: 'model', valid: true, claims: 1, verified: 1 });
    expect(result.finalText).toBe('Lane steered.');
  });
});
