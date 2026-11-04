/**
 * P6 remediation — tool-output offload honesty (v1#19) + AGENTS.md injection
 * honesty (sparks B10/G10).
 *
 * v1#19: tool results >8k were display-truncated with an UNCONDITIONAL
 * "full detail is searchable via search_memory" marker — but only OFFLOAD_TOOLS
 * (read_file/scrape/grep/search_engine) results were ever offloaded, so a big
 * run_command/verify/platform-tool output carried a FALSE pointer. The loop now
 * offloads EVERY >8k result (head+tail past 36k) and the marker states what
 * actually happened.
 *
 * B10/G10: AGENTS.md was silently sliced to its first 8,000 chars — an 83k
 * guide read as complete. The injection now carries a visible [GUIDE TRUNCATED]
 * marker with byte counts, and past 12k a [GUIDE NOTICE] naming .digby/rules
 * as the reliable always-injected channel.
 *
 * Harness: the REAL ./agent module with the repo-standard stand-ins
 * (agent-zero-tool-gate.test.ts precedent).
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

// The model turn: ONE mock drives every case (per-test call shapes).
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

// Coding-tool execution: the big-output producer.
const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'small result');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
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
  buildChatWakeClockNote: jest.fn(() => ""),
}));
// The seam under test (v1#19): whether a store ACTUALLY happened drives the marker.
const mockStoreFindings: jest.Mock = jest.fn(async () => 1);
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  storeFindings: (...a: any[]) => mockStoreFindings(...a),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCodingAgent, buildAgentGuide, AGENTS_MD_INJECT_CHARS, AGENTS_MD_NOTICE_CHARS } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 6,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/offload-honesty-test',
  sessionId: 'sess-offload-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'pull the open feedback and summarize',
  emit: jest.fn(),
});

// list_feedback is a chat-lane-offered PLATFORM tool that is NOT in
// OFFLOAD_TOOLS — exactly the class whose big outputs carried the false marker.
const BIG_TOOL_TURN = {
  content: 'Pulling the queue.',
  reasoning: '',
  toolCalls: [{ id: 't1', name: 'list_feedback', arguments: '{"status":"open"}' }],
  finishReason: 'tool_calls',
};
const FINAL_TURN = {
  content: 'Summarized the queue.',
  reasoning: '', toolCalls: [], finishReason: 'stop',
};

const toolResultEvents = (input: AgentRunInput) =>
  (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'tool_result').map((c) => c[1]);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockStoreFindings.mockResolvedValue(1);
});

describe('tool-output offload honesty (P6 — v1#19)', () => {
  it('a >8k output from a NON-content-read tool is offloaded and the truncation marker tells the truth', async () => {
    const big = `HEAD-MARKER ${'x'.repeat(12_000)} TAIL-MARKER`;
    mockExecuteCodingTool.mockResolvedValueOnce(big);
    mockRunModelTurn.mockResolvedValueOnce(BIG_TOOL_TURN).mockResolvedValueOnce(FINAL_TURN);
    const input = makeInput();
    await runCodingAgent(input);

    // The full result was submitted to session memory under a tool-named ref.
    const offload = mockStoreFindings.mock.calls.find((c) => String(c[2]?.[0]?.ref || '').startsWith('list_feedback:'));
    expect(offload).toBeDefined();
    expect(offload![0]).toBe('sess-offload-1');
    expect(String(offload![1])).toBe('orchestrator');
    expect(offload![2][0].content).toBe(big); // ≤36k → stored whole

    // The display slice is truncated WITH the now-true pointer.
    const [ev] = toolResultEvents(input);
    expect(ev.result.length).toBeLessThan(big.length);
    expect(ev.result).toContain('…[truncated');
    expect(ev.result).toContain('full detail is searchable via search_memory');
  });

  it('a HUGE (>36k) output is offloaded head+tail — both ends survive, the middle is marked omitted', async () => {
    const big = `HEAD-MARKER ${'y'.repeat(50_000)} TAIL-MARKER`;
    mockExecuteCodingTool.mockResolvedValueOnce(big);
    mockRunModelTurn.mockResolvedValueOnce(BIG_TOOL_TURN).mockResolvedValueOnce(FINAL_TURN);
    await runCodingAgent(makeInput());
    const offload = mockStoreFindings.mock.calls.find((c) => String(c[2]?.[0]?.ref || '').startsWith('list_feedback:'));
    expect(offload).toBeDefined();
    const stored = String(offload![2][0].content);
    expect(stored).toContain('HEAD-MARKER');
    expect(stored).toContain('TAIL-MARKER');
    expect(stored).toContain('chars omitted at offload');
    expect(stored.length).toBeLessThan(big.length);
  });

  it('when the store FAILS (0 rows / throw), the marker says NOT stored — never a false search_memory pointer', async () => {
    for (const behavior of ['zero', 'throw'] as const) {
      jest.clearAllMocks();
      if (behavior === 'zero') mockStoreFindings.mockResolvedValue(0);
      else mockStoreFindings.mockRejectedValue(new Error('store down'));
      const big = 'z'.repeat(12_000);
      mockExecuteCodingTool.mockResolvedValueOnce(big);
      mockRunModelTurn.mockResolvedValueOnce(BIG_TOOL_TURN).mockResolvedValueOnce(FINAL_TURN);
      const input = makeInput();
      await runCodingAgent(input);
      const [ev] = toolResultEvents(input);
      expect(ev.result).toContain('…[truncated');
      expect(ev.result).toContain('NOT stored to memory');
      expect(ev.result).not.toContain('searchable via search_memory');
    }
  });

  it('a small (<8k) output is neither truncated nor offloaded — no marker, no store call', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce('a tidy 40-char result, nothing special');
    mockRunModelTurn.mockResolvedValueOnce(BIG_TOOL_TURN).mockResolvedValueOnce(FINAL_TURN);
    const input = makeInput();
    await runCodingAgent(input);
    const [ev] = toolResultEvents(input);
    expect(ev.result).not.toContain('…[truncated');
    expect(mockStoreFindings.mock.calls.find((c) => String(c[2]?.[0]?.ref || '').startsWith('list_feedback:'))).toBeUndefined();
  });
});

describe('AGENTS.md injection honesty (P6 — sparks B10/G10)', () => {
  let dir: string;
  beforeEach(() => { dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'guide-honesty-')); });
  afterEach(() => { fsSync.rmSync(dir, { recursive: true, force: true }); });

  it('constants pinned: 8,000-char injection window, 12,000-char notice threshold', () => {
    expect(AGENTS_MD_INJECT_CHARS).toBe(8_000);
    expect(AGENTS_MD_NOTICE_CHARS).toBe(12_000);
  });

  it('an oversized AGENTS.md gets a visible [GUIDE TRUNCATED] marker with byte counts', async () => {
    fsSync.writeFileSync(path.join(dir, 'AGENTS.md'), 'g'.repeat(9_500));
    const guide = await buildAgentGuide(dir);
    expect(guide).toContain('[GUIDE TRUNCATED: showing 8,000 of 9,500 chars — put must-see doctrine in .digby/rules/]');
    expect(guide).not.toContain('[GUIDE NOTICE]'); // under the 12k notice bar
  });

  it('past 12k the one-line [GUIDE NOTICE] names .digby/rules as the reliable channel', async () => {
    fsSync.writeFileSync(path.join(dir, 'AGENTS.md'), 'g'.repeat(83_031));
    const guide = await buildAgentGuide(dir);
    expect(guide).toContain('[GUIDE TRUNCATED: showing 8,000 of 83,031 chars — put must-see doctrine in .digby/rules/]');
    expect(guide).toContain('[GUIDE NOTICE] AGENTS.md is 83,031 chars');
    expect(guide).toContain('.digby/rules/*.md are the reliable always-injected channel');
  });

  it('a guide within the window is injected whole with NO marker (unchanged behavior)', async () => {
    fsSync.writeFileSync(path.join(dir, 'AGENTS.md'), '# Guide\nshort and sweet\n');
    const guide = await buildAgentGuide(dir);
    expect(guide).toContain('short and sweet');
    expect(guide).not.toContain('[GUIDE TRUNCATED');
    expect(guide).not.toContain('[GUIDE NOTICE]');
  });
});
