/**
 * SEAM REPLAY TEST — ticket 66007a6e (the agent-loop half of the mishap).
 *
 * THE INCIDENT: a project-supervisor chat running hourly uptime probes with
 * scrape_as_markdown could never satisfy observe_resource's machine
 * no_receipt gate — web tools minted NO receipt id at the agent seam (the
 * mint line tested only RECEIPT_TOOLS membership), so extractReceipt was
 * never even called for a scrape and the in-process collector stayed empty
 * on a probe-only wake.
 *
 * THE FIX UNDER TEST (agent.ts result seam):
 *   · the mint gate now admits WEB_PROBE_RECEIPT_TOOLS_SET members;
 *   · the receipt is pushed to the in-process collector (gate evidence —
 *     what observe_resource's no_receipt gate reads FIRST) but
 *     recordRunReceiptAsync is SKIPPED for this class: no run_tool_receipts
 *     row, so the hottest tool class fleet-wide never adds DB volume and
 *     every DB-reading pool (getRecentChatReceipts's cross-wake 500-cap
 *     exoneration pool among them) is untouched by construction.
 *
 * These tests drive the REAL agent loop (scaffold mirrors
 * agent-derail-break.099bd00a.test.ts — the web seam dispatches via
 * ctx.toolCache, so only the ToolCache executor instance is stubbed; nothing
 * reaches a network).
 */

jest.setTimeout(60_000);

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));
jest.mock('../github/github-mcp', () => ({
  __esModule: true, isGitHubMcpConfigured: jest.fn(() => false), callGitHubMcpTool: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  __esModule: true, isGoogleMcpConfigured: jest.fn(() => false), callGoogleMcpTool: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

// The web seam: scrape_as_markdown dispatches via ctx.toolCache
// (WEB_TOOL_NAMES), not executeCodingTool. The incident's two probe shapes:
// the DOWN result for the watched health endpoint and a control scrape.
const DOWN_RESULT =
  'Failed to fetch https://example.com/api/health — the page may be unavailable, blocked, or rate-limited (a transient 403/429 often clears after a cooldown). A retry after a short wait, or trying a different official source for the same content, is fine — just don\'t hammer the same URL repeatedly. If it keeps failing, answer from the search results you already have.';
const CONTROL_RESULT = '# Example Domain\n\nThis domain is for use in illustrative examples.';
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'scrape_as_markdown' && String(args?.url ?? '') === 'https://example.com/api/health') return DOWN_RESULT;
  return CONTROL_RESULT;
});
jest.mock('../tool-executor', () => {
  const actual = jest.requireActual('../tool-executor');
  return {
    ...actual,
    ToolCache: jest.fn().mockImplementation(() => ({
      getOrExecute: (...a: any[]) => mockToolCacheExec(...a),
    })),
  };
});

// The persistence seam under test: collector push WITHOUT the DB write.
const mockRecordRunReceiptAsync: jest.Mock = jest.fn();
jest.mock('./run-receipts.service', () => ({
  __esModule: true,
  recordRunReceiptAsync: (...a: any[]) => mockRecordRunReceiptAsync(...a),
  getRecentChatReceipts: jest.fn(async () => []),
}));

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss', TOOL_BATCH_CAP: 'tool_batch_cap' },
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
  ensureSessionContainer: jest.fn(async () => false),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn() }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

/** CODING profile (no workspace container in the scaffold). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const makeInput = (sessionId: string): AgentRunInput => ({
  worktree: '/tmp/agent-66007a6e-test',
  sessionId,
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'Uptime probe: scrape the health endpoint and a control URL, then report.',
  emit: jest.fn(),
});

const FINAL = { content: 'Probe complete: endpoint DOWN, control up.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const probeTurn = (n: number) => ({
  content: '',
  reasoning: 'Probing the watched endpoint and the control.',
  toolCalls: [
    { id: `t${n}a`, name: 'scrape_as_markdown', arguments: JSON.stringify({ url: 'https://example.com/api/health' }) },
    { id: `t${n}b`, name: 'scrape_as_markdown', arguments: JSON.stringify({ url: 'https://example.com/' }) },
  ],
  finishReason: 'tool_calls',
});

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 66007a6e — web-probe receipts at the agent seam: collector push, NO persistence', () => {
  it('REPLAY: the incident probe (DOWN + control scrape) mints BOTH receipts into the collector and persists NEITHER', async () => {
    mockRunModelTurn.mockResolvedValueOnce(probeTurn(1)).mockResolvedValue(FINAL);
    const input = makeInput('sess-66007a6e');
    const result = await runCodingAgent(input);
    expect(result.finalText).toContain('Probe complete');

    // The collector (input.receipts — the array the loop shares with the gate)
    // holds BOTH web-probe receipts, both ok:true (the DOWN shape executed).
    const receipts = (result.receipts ?? []) as Array<{ tool: string; ok: boolean; ids: Record<string, unknown> }>;
    const scrapes = receipts.filter((r) => r.tool === 'scrape_as_markdown');
    expect(scrapes).toHaveLength(2);
    expect(scrapes.every((r) => r.ok)).toBe(true);
    expect(scrapes.map((r) => r.ids.url)).toEqual(expect.arrayContaining(['https://example.com/api/health', 'https://example.com/']));

    // COLLECTOR-ONLY: no run_tool_receipts write for the web-probe class.
    const persistedTools = mockRecordRunReceiptAsync.mock.calls.map((c) => c[0]?.tool);
    expect(persistedTools.filter((t: string) => t === 'scrape_as_markdown')).toHaveLength(0);
  });

  it('CONTROL: a RECEIPT_TOOLS member on the same loop still persists (only the web class is collector-only)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce({
        content: '', reasoning: '',
        toolCalls: [{ id: 't1', name: 'git_commit', arguments: JSON.stringify({ message: 'x' }) }],
        finishReason: 'tool_calls',
      })
      .mockResolvedValue(FINAL);
    const input = makeInput('sess-66007a6e-ctl');
    // git_commit dispatches through executeCodingTool — stub it at the tools
    // seam with git's own success stdout (the extractor's ok shape).
    const result = await runCodingAgent(input);
    expect(result.finalText).toContain('Probe complete');
    const persistedTools = mockRecordRunReceiptAsync.mock.calls.map((c) => c[0]?.tool);
    expect(persistedTools).toContain('git_commit');
  });
});
