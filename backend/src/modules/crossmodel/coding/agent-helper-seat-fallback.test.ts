/**
 * Helper-SEAT health fallback on the WORKER path (owner 2026-09-14: "I
 * switched the helper model in coding sessions over to our local cql spark
 * qwen4b so im concerned that is not working" — prod app_error_logs that day:
 * "runModelTurn 400 fingerprint [spark-qwen3-4b-helper] tools=14" ×4).
 *
 * The agent LOOP end-to-end with a mocked model turn (agent-delegation.test.ts
 * harness) and the coding_helper seat overridden to a CUSTOM endpoint: a
 * helper-tier worker whose turn the custom gateway 400s moves to the built-in
 * helper for the rest of its run (same request, one hop, never tool-less on
 * the same seat), the orchestrator's delegate result carries the honest
 * attribution, a seat_fallback row is recorded, and the UI end event names
 * the model that actually finished. Auth errors, the kill switch, a keyless
 * built-in, and a non-helper seat leave the loop's normal lanes untouched.
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
jest.mock('../imessage/agent-link', () => ({ agentBroker: { dispatch: jest.fn() } }));

// The model turn: ONE mock drives orchestrator + worker turns in call order;
// every invocation stamps the PROVIDER MODEL it was called with.
const timeline: string[] = [];
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return {
    ...actual,
    // Worker seat pre-flight runs env-key checks — every seat is servable here.
    seatUnservableReason: async () => null,
    runModelTurn: (...a: any[]) => {
      timeline.push(a[0]?.model);
      return mockRunModelTurn(...a);
    },
  };
});

// The owner's override: the coding_helper seat points at a CUSTOM endpoint.
const mockResolveRoleModel = jest.fn(async (k: string) => (k === 'coding_helper' ? 'cql:qwen3-4b' : ''));
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: (...a: any[]) => mockResolveRoleModel(...(a as [string])),
}));
const REG = {
  url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql',
  model: 'qwen3-4b', label: 'cql', supportsVision: false, coding: true, thinkingOff: false,
};
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: async (spec: string) => (spec === 'cql:qwen3-4b' ? REG : null),
}));

const mockNoteSeatFallback: jest.Mock = jest.fn();
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  noteSeatFallback: (...a: any[]) => mockNoteSeatFallback(...a),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected', SEAT_FALLBACK: 'seat_fallback' },
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
  buildCodingClockNote: jest.fn(() => '[HARNESS CLOCK] test'),
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 1) }));
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => ({ goal: 'g', acceptanceCriteria: [], steps: [{ id: 1, text: 'the step', status: 'in_progress' }] })),
  applyPlan: jest.fn(async (_s: string, _w: string, u: any) => ({ plan: u })),
  planToUpdate: jest.fn((p: any) => ({ goal: p.goal, steps: p.steps.map((s: any) => ({ ...s })) })),
  renderPlanReminder: jest.fn(() => '<plan>x</plan>'),
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 6,
  maxDelegations: 4,
  contextCharBudget: 500_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

let worktree: string;

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree,
  sessionId: 'sess-seat-fallback-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'ask',
  model: 'glm-5.3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test orchestrator.',
  history: [],
  userMessage: 'do the thing',
  emit: jest.fn(),
  ...over,
});

const orchTurn = (toolCalls: any[]) => ({ content: '', reasoning: '', toolCalls, finishReason: 'tool_calls' });
const finalTurn = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const delegateCall = (args: any) => ({ id: 'tc1', name: 'delegate', arguments: JSON.stringify(args) });
/** The prod shape: the custom gateway rejects the tool-bearing worker turn outright. */
const rejected = (status: number, providerError?: string) => ({
  content: '', reasoning: '', toolCalls: [], finishReason: 'error',
  errorMessage: `Request failed with status code ${status}`, errorStatus: status,
  ...(providerError ? { providerError } : {}),
});
const WORKER_DONE = finalTurn('Chain ran; all green.\n```json\n{"status":"done","artifacts":["report.txt"]}\n```');

/** The delegate tool RESULT the orchestrator was shown (its 2nd turn's transcript). */
const delegateResultShownToOrchestrator = (): string => {
  const orchCalls = mockRunModelTurn.mock.calls.filter((c) => c[0]?.model === 'glm-5.3');
  const msgs = orchCalls[orchCalls.length - 1][1] as any[];
  const toolMsg = [...msgs].reverse().find((m) => m.role === 'tool');
  return String(toolMsg?.content ?? '');
};

beforeAll(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-seat-fallback-test-'));
});
afterAll(async () => { await fs.rm(worktree, { recursive: true, force: true }); });

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  timeline.length = 0;
  process.env.DASHSCOPE_API_KEY = 'sk-dashscope'; // the built-in helper is servable
  process.env.AGENT_TRANSIENT_BACKOFF_MS = '1,1,1'; // keep the normal lanes fast where they run
  delete process.env.HELPER_SEAT_FALLBACK_DISABLED;
  mockResolveRoleModel.mockImplementation(async (k: string) => (k === 'coding_helper' ? 'cql:qwen3-4b' : ''));
});
afterEach(() => { delete process.env.AGENT_TRANSIENT_BACKOFF_MS; });

describe('helper-tier worker on a CUSTOM coding_helper seat', () => {
  test('the prod replay: the custom seat 400s the tool-bearing turn → the worker continues on the built-in helper, one hop, honest attribution to the orchestrator', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'verifier', task: 'run the verify chain', title: 'Verify' })]))
      .mockResolvedValueOnce(rejected(400, 'tools are not supported by this model'))  // worker on qwen3-4b
      .mockResolvedValueOnce(WORKER_DONE)                                              // worker on the built-in
      .mockResolvedValueOnce(finalTurn('All done.'));
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toBe('All done.');
    // Provider sequence: orchestrator → custom seat (rejected) → built-in → orchestrator.
    expect(timeline).toEqual(['glm-5.3', 'qwen3-4b', 'qwen3.6-27b', 'glm-5.3']);
    // The retried turn is the SAME request (tools still offered — never a tool-less retry).
    const rejectedCall = mockRunModelTurn.mock.calls[1];
    const retriedCall = mockRunModelTurn.mock.calls[2];
    expect(retriedCall[2]?.length).toBe(rejectedCall[2]?.length);
    expect(retriedCall[2]?.length).toBeGreaterThan(0);
    expect(retriedCall[0]).toMatchObject({ model: 'qwen3.6-27b', label: 'DashScope intl (Qwen)' });
    // The orchestrator reads WHY the worker changed seats.
    const shown = delegateResultShownToOrchestrator();
    expect(shown).toContain('Chain ran; all green.');
    expect(shown).toContain('worker finished via qwen3.6-27b — custom helper seat cql (custom endpoint) (cql:qwen3-4b) failed: HTTP 400 — tools are not supported by this model');
    expect(shown).toContain('custom Helper seat is unhealthy');
    // Telemetry: ONE seat_fallback row for the seat, from → to, worker caller.
    expect(mockNoteSeatFallback).toHaveBeenCalledTimes(1);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'coding_helper', from: 'cql:qwen3-4b', to: 'qwen3.6-27b', status: 'retrying', caller: 'worker:verifier', httpStatus: 400,
      sessionId: 'sess-seat-fallback-1',
    }));
    expect(mockNoteSeatFallback.mock.calls[0][0].reason).toContain('HTTP 400');
    // No provider_rejected lane rows: the fallback pre-empted backoff + shrink.
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]?.kind)).not.toContain('provider_rejected');
    // UI: the end event names the model that ACTUALLY finished + the seat that failed.
    const emits = (input.emit as jest.Mock).mock.calls;
    expect(emits).toEqual(expect.arrayContaining([
      ['subagent_start', expect.objectContaining({ role: 'verifier', model: 'cql:qwen3-4b' })],
      ['subagent_end', expect.objectContaining({ role: 'verifier', model: 'qwen3.6-27b', status: 'done', seatFallback: expect.objectContaining({ from: 'cql:qwen3-4b' }) })],
    ]));
    expect(emits.some((c) => c[0] === 'subagent:progress' && /Helper seat cql \(custom endpoint\) failed \(HTTP 400/.test(c[1]?.message))).toBe(true);
  });

  test('a connection-level failure (ECONNREFUSED — the server is not there) moves the worker the same way', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'verifier', task: 't', title: 'Verify' })]))
      .mockResolvedValueOnce({ content: '', reasoning: '', toolCalls: [], finishReason: 'error', errorMessage: 'connect ECONNREFUSED 10.0.0.5:8000' })
      .mockResolvedValueOnce(WORKER_DONE)
      .mockResolvedValueOnce(finalTurn('All done.'));
    await runCodingAgent(makeInput());
    expect(timeline).toEqual(['glm-5.3', 'qwen3-4b', 'qwen3.6-27b', 'glm-5.3']);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({ reason: 'ECONNREFUSED', status: 'retrying' }));
  });

  test('NEVER a second hop: the built-in failing after the fallback takes the loop\'s normal lanes, not another seat change', async () => {
    mockRunModelTurn.mockImplementation(async (provider: any) => {
      if (timeline.length === 1) return orchTurn([delegateCall({ role: 'verifier', task: 't', title: 'Verify' })]);
      if (provider.model === 'qwen3-4b') return rejected(400);
      if (provider.model === 'qwen3.6-27b') return rejected(400); // the built-in rejects too
      return finalTurn('All done.');
    });
    const result = await runCodingAgent(makeInput());
    expect(result.finalText).toBe('All done.');
    expect(mockNoteSeatFallback).toHaveBeenCalledTimes(1);
    // After the ONE hop every worker turn stayed on the built-in (backoff + shrink lanes ran there).
    const afterHop = timeline.slice(timeline.indexOf('qwen3.6-27b'));
    expect(afterHop.filter((m) => m === 'qwen3-4b')).toHaveLength(0);
    expect(afterHop.filter((m) => m === 'qwen3.6-27b').length).toBeGreaterThan(1);
  });

  test.each([401, 403])('HTTP %i from the custom seat is a CONFIG error — no seat change, the loop\'s own lanes + honest note surface it', async (status) => {
    mockRunModelTurn.mockImplementation(async (provider: any) => {
      if (timeline.length === 1) return orchTurn([delegateCall({ role: 'verifier', task: 't', title: 'Verify' })]);
      if (provider.model === 'qwen3-4b') return rejected(status);
      return finalTurn('All done.');
    });
    const result = await runCodingAgent(makeInput());
    expect(result.finalText).toBe('All done.');
    expect(timeline).not.toContain('qwen3.6-27b');
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
    expect(delegateResultShownToOrchestrator()).toContain(`HTTP ${status}`);
  });

  test('kill switch HELPER_SEAT_FALLBACK_DISABLED=1 → no seat change (the normal lanes run on the custom seat)', async () => {
    process.env.HELPER_SEAT_FALLBACK_DISABLED = '1';
    mockRunModelTurn.mockImplementation(async (provider: any) => {
      if (timeline.length === 1) return orchTurn([delegateCall({ role: 'verifier', task: 't', title: 'Verify' })]);
      if (provider.model === 'qwen3-4b') return rejected(400);
      return finalTurn('All done.');
    });
    await runCodingAgent(makeInput());
    expect(timeline).not.toContain('qwen3.6-27b');
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });

  test('a KEYLESS built-in (Edge without DASHSCOPE_API_KEY) cannot take the worker — no seat change', async () => {
    delete process.env.DASHSCOPE_API_KEY;
    mockRunModelTurn.mockImplementation(async (provider: any) => {
      if (timeline.length === 1) return orchTurn([delegateCall({ role: 'verifier', task: 't', title: 'Verify' })]);
      if (provider.model === 'qwen3-4b') return rejected(400);
      return finalTurn('All done.');
    });
    await runCodingAgent(makeInput());
    expect(timeline).not.toContain('qwen3.6-27b');
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });

  test('a healthy custom seat is untouched: the worker runs and finishes on it, no attribution, no metric', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'verifier', task: 't', title: 'Verify' })]))
      .mockResolvedValueOnce(WORKER_DONE)
      .mockResolvedValueOnce(finalTurn('All done.'));
    const input = makeInput();
    await runCodingAgent(input);
    expect(timeline).toEqual(['glm-5.3', 'qwen3-4b', 'glm-5.3']);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
    expect(delegateResultShownToOrchestrator()).not.toContain('custom helper seat');
    expect((input.emit as jest.Mock).mock.calls).toEqual(expect.arrayContaining([
      ['subagent_end', expect.objectContaining({ role: 'verifier', model: 'cql:qwen3-4b', status: 'done' })],
    ]));
  });
});

describe('non-helper seats are out of scope', () => {
  test('the ORCHESTRATOR itself on a custom endpoint that 400s never re-seats (not a helper-seat loop)', async () => {
    mockRunModelTurn.mockImplementation(async (provider: any) => (provider.model === 'qwen3-4b' ? rejected(400) : finalTurn('x')));
    const result = await runCodingAgent(makeInput({ model: 'cql:qwen3-4b' }));
    expect(result.modelErrored).toBe(true); // the honest give-up, unchanged
    expect(timeline.every((m) => m === 'qwen3-4b')).toBe(true);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });

  test('a PREMIUM-tier worker (model:"premium" → the orchestrator\'s model) on a custom endpoint is not a helper-seat worker', async () => {
    mockRunModelTurn.mockImplementation(async (provider: any) => {
      if (timeline.length === 1) return orchTurn([delegateCall({ role: 'verifier', task: 't', title: 'Verify', model: 'premium' })]);
      if (provider.model === 'qwen3-4b') return rejected(400);
      return finalTurn('All done.');
    });
    await runCodingAgent(makeInput({ model: 'cql:qwen3-4b' }));
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
    expect(timeline).not.toContain('qwen3.6-27b');
  });
});

describe('LEAD seat on an UNREACHABLE custom endpoint (spark-cluster audit 2026-09-17, child 1d39d145)', () => {
  const connFail = (msg: string) => ({ content: '', reasoning: '', toolCalls: [], finishReason: 'error', errorMessage: msg });
  beforeEach(() => {
    process.env.ZAI_API_KEY = 'sk-zai'; // the built-in coding default (glm-5.3) is servable
    delete process.env.LEAD_SEAT_FALLBACK_DISABLED;
  });
  afterEach(() => { delete process.env.ZAI_API_KEY; });

  test('connect ECONNREFUSED on the lead custom seat → the run continues on the built-in coding default, one seat_fallback row, no give-up', async () => {
    mockRunModelTurn.mockImplementation(async (provider: any) => (provider.model === 'qwen3-4b' ? connFail('connect ECONNREFUSED 10.0.0.5:8000') : finalTurn('Done on the fallback.')));
    const result = await runCodingAgent(makeInput({ model: 'cql:qwen3-4b' }));
    expect(result.modelErrored).toBeFalsy();
    expect(result.finalText).toContain('Done on the fallback.');
    expect(timeline).toEqual(['qwen3-4b', 'glm-5.3']);
    expect(result.seatFallback).toMatchObject({ role: 'coding_default', from: 'cql:qwen3-4b', fromLabel: 'cql (custom endpoint)', to: 'glm-5.3', reason: 'ECONNREFUSED', status: 'recovered' });
    expect(mockNoteSeatFallback).toHaveBeenCalledTimes(1);
    expect(mockNoteSeatFallback.mock.calls[0][0]).toMatchObject({ role: 'coding_default', from: 'cql:qwen3-4b', to: 'glm-5.3', reason: 'ECONNREFUSED', status: 'retrying', caller: 'lead' });
  });

  test('connect ETIMEDOUT (the 1d39d145 shape): the first timeout takes ONE ordinary backoff, the second moves the run', async () => {
    mockRunModelTurn.mockImplementation(async (provider: any) => (provider.model === 'qwen3-4b' ? connFail('connect ETIMEDOUT 89.124.37.178:4000') : finalTurn('Recovered.')));
    const result = await runCodingAgent(makeInput({ model: 'cql:qwen3-4b' }));
    expect(result.modelErrored).toBeFalsy();
    expect(timeline).toEqual(['qwen3-4b', 'qwen3-4b', 'glm-5.3']);
    expect(result.seatFallback).toMatchObject({ role: 'coding_default', reason: 'ETIMEDOUT' });
  });

  test('kill switch LEAD_SEAT_FALLBACK_DISABLED=1 → the honest give-up as before (five backoffs, zero tools, modelErrored)', async () => {
    process.env.LEAD_SEAT_FALLBACK_DISABLED = '1';
    mockRunModelTurn.mockImplementation(async () => connFail('connect ECONNREFUSED 10.0.0.5:8000'));
    const result = await runCodingAgent(makeInput({ model: 'cql:qwen3-4b' }));
    expect(result.modelErrored).toBe(true);
    expect(timeline.every((m) => m === 'qwen3-4b')).toBe(true);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });

  test('a KEYLESS built-in cannot take the lead — no seat change, honest give-up', async () => {
    delete process.env.ZAI_API_KEY;
    // Keyed-shell determinism (2026-09-17): the lead fallback also tries
    // deepseek-flash/kimi-k3 — scrub their keys too, or a keyed dev shell
    // flips this honest give-up into a recovery (CI is keyless).
    const savedKeys = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY };
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    try {
      mockRunModelTurn.mockImplementation(async () => connFail('connect ECONNREFUSED 10.0.0.5:8000'));
      const result = await runCodingAgent(makeInput({ model: 'cql:qwen3-4b' }));
      expect(result.modelErrored).toBe(true);
      expect(timeline.every((m) => m === 'qwen3-4b')).toBe(true);
      expect(mockNoteSeatFallback).not.toHaveBeenCalled();
    } finally {
      if (savedKeys.DEEPSEEK_API_KEY !== undefined) process.env.DEEPSEEK_API_KEY = savedKeys.DEEPSEEK_API_KEY;
      if (savedKeys.MOONSHOT_API_KEY !== undefined) process.env.MOONSHOT_API_KEY = savedKeys.MOONSHOT_API_KEY;
    }
  });

  test('a BUILT-IN lead seat never takes this lane (nothing further to fall to here)', async () => {
    mockRunModelTurn.mockImplementation(async () => connFail('connect ECONNREFUSED 10.0.0.5:8000'));
    const result = await runCodingAgent(makeInput({ model: 'glm-5.3' }));
    expect(result.modelErrored).toBe(true);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });
});

describe('LEAD seat rejected by the PROVIDER — 429 / 5xx / billing (owner 2026-09-17 "why isn\'t the fallback working")', () => {
  const rateLimited = () => ({ content: '', reasoning: '', toolCalls: [], finishReason: 'error', errorStatus: 429, errorMessage: 'Request failed with status code 429', providerError: '{"error":{"code":"1302","message":"Rate limit reached for requests"}}' });
  const suspended = () => ({ content: '', reasoning: '', toolCalls: [], finishReason: 'error', errorStatus: 429, errorMessage: 'Request failed with status code 429 — provider: Your account org-b71a is suspended due to insufficient balance' });
  beforeEach(() => {
    process.env.ZAI_API_KEY = 'sk-zai';
    process.env.DEEPSEEK_API_KEY = 'sk-deepseek';
    delete process.env.LEAD_SEAT_FALLBACK_DISABLED;
  });
  afterEach(() => { delete process.env.ZAI_API_KEY; delete process.env.DEEPSEEK_API_KEY; });

  test('a 429 on the built-in lead (glm-5.3) moves THIS turn to the next servable built-in with no backoff — no give-up, one seat_fallback row', async () => {
    mockRunModelTurn.mockImplementation(async (provider: any) => (provider.model === 'glm-5.3' ? rateLimited() : finalTurn('Answered on the fallback.')));
    const result = await runCodingAgent(makeInput({ model: 'glm-5.3' }));
    expect(result.modelErrored).toBeFalsy();
    expect(result.finalText).toContain('Answered on the fallback.');
    expect(timeline).toEqual(['glm-5.3', 'deepseek-flash']);
    expect(result.seatFallback).toMatchObject({ role: 'coding_default', from: 'glm-5.3', to: 'deepseek-flash', reason: 'HTTP 429', httpStatus: 429, status: 'recovered' });
    expect(mockNoteSeatFallback).toHaveBeenCalledTimes(1);
    expect(mockNoteSeatFallback.mock.calls[0][0]).toMatchObject({ role: 'coding_default', reason: 'HTTP 429', caller: 'lead', httpStatus: 429 });
  });

  test('the CHOSEN seat is retried on the next turn (fallback covers one turn, then the primary comes back)', async () => {
    let leadCalls = 0;
    mockRunModelTurn.mockImplementation(async (provider: any) => {
      if (provider.model === 'glm-5.3') { leadCalls += 1; return leadCalls === 1 ? rateLimited() : finalTurn('Back on the chosen model.'); }
      if (provider.model === 'deepseek-flash') return orchTurn([delegateCall({ role: 'verifier', task: 't', title: 'Verify' })]);
      return WORKER_DONE; // the helper-seat worker
    });
    const result = await runCodingAgent(makeInput({ model: 'glm-5.3' }));
    expect(result.modelErrored).toBeFalsy();
    expect(result.finalText).toContain('Back on the chosen model.');
    expect(timeline[0]).toBe('glm-5.3');
    expect(timeline[1]).toBe('deepseek-flash');
    expect(timeline[timeline.length - 1]).toBe('glm-5.3');
  });

  test('a BILLING suspension is sticky for the run — the fallback becomes the primary, no futile retry of the suspended account', async () => {
    mockRunModelTurn.mockImplementation(async (provider: any) => {
      if (provider.model === 'glm-5.3') return suspended();
      if (provider.model === 'deepseek-flash') return timeline.filter((m) => m === 'deepseek-flash').length === 1 ? orchTurn([delegateCall({ role: 'verifier', task: 't', title: 'Verify' })]) : finalTurn('Finished on the fallback.');
      return WORKER_DONE;
    });
    const result = await runCodingAgent(makeInput({ model: 'glm-5.3' }));
    expect(result.modelErrored).toBeFalsy();
    expect(result.seatFallback).toMatchObject({ reason: 'billing', to: 'deepseek-flash' });
    expect(timeline.filter((m) => m === 'glm-5.3')).toHaveLength(1); // never retried
    expect(timeline[timeline.length - 1]).toBe('deepseek-flash');
  });

  test('kill switch → the old lanes (backoffs, then the honest give-up)', async () => {
    process.env.LEAD_SEAT_FALLBACK_DISABLED = '1';
    mockRunModelTurn.mockImplementation(async () => rateLimited());
    const result = await runCodingAgent(makeInput({ model: 'glm-5.3' }));
    expect(result.modelErrored).toBe(true);
    expect(timeline.every((m) => m === 'glm-5.3')).toBe(true);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });

  test('a 400 on the lead is NOT a provider "not now" — no re-seat (the pinned out-of-scope behaviour stands)', async () => {
    mockRunModelTurn.mockImplementation(async (provider: any) => (provider.model === 'glm-5.3' ? rejected(400) : finalTurn('x')));
    const result = await runCodingAgent(makeInput({ model: 'glm-5.3' }));
    expect(result.modelErrored).toBe(true);
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  });
});
