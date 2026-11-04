/**
 * Replay pin — ticket 22c309f4 (2026-09-20): kimi-k3 coding-seat request
 * CONFORMANCE vs Moonshot's published K3 contract.
 *
 * THE AUDIT (in-tree + vendor docs, platform.kimi.ai scraped 2026-09-20):
 *   ✓ temperature/top_p OMITTED (K3 fixes sampling server-side; any explicit
 *     value errors) — already conformant.
 *   ✓ reasoning_effort omitted → vendor default 'max' (low/high/max accepted
 *     since the post-launch widening) — already conformant.
 *   ✓ max_tokens stripped via omitParams; output cap is max_completion_tokens
 *     — already conformant in SHAPE, but the 16,384 value let a max-effort
 *     turn burn the whole cap on reasoning and return EMPTY (4 real
 *     recoveries on 2026-09-13 with 67-71k-char traces, turn-recovery.ts) →
 *     raised to 65,536 (vendor default is 131,072; a cap is a ceiling, not a
 *     reservation).
 *   ✗ PRESERVED THINKING was violated in two ways: (1) the replayed
 *     reasoning_content was truncated at ASSISTANT_CONTENT_CAP (16k) although
 *     Moonshot REQUIRES the complete assistant message "as-is, including
 *     reasoning_content and tool_calls" (4 doc pages + the HF model card:
 *     "trained in the preserved thinking history mode"); (2) the content-only
 *     assistant pushes (leak lane / narration nudge / final-answer record)
 *     dropped reasoning_content entirely.
 *
 * THE FIX: one shared reasoningStore (cap raised to a 200k pathological-only
 * valve) attached to EVERY assistant message the loop stores for kimi-k3.
 *
 * These tests drive the REAL agent loop on the REAL kimi-k3 provider config
 * (only runModelTurn + the tool executor are mocked; scaffold mirrors
 * agent-derail-break.b61fb6c9.test.ts) and assert what the NEXT request would
 * carry.
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

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: ok');
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
const mockConsultCrossCheckerOnStreak: jest.Mock = jest.fn(async () => null);
const mockFileStreakInvestigation: jest.Mock = jest.fn(async () => undefined);
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: (...a: any[]) => mockConsultCrossCheckerOnStreak(...a),
  fileStreakInvestigation: (...a: any[]) => mockFileStreakInvestigation(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { sanitizeMessages } from './coding-model';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
} as AgentProfile;

const makeInput = (model: string): AgentRunInput => ({
  worktree: '/tmp/k3-conformance-22c309f4-test',
  sessionId: 'sess-22c309f4',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model,
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'check the open tickets',
  emit: jest.fn(),
});

const FINAL = { content: 'Done — the conformance report is in the ticket.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** Messages the loop handed to runModelTurn for call `n` (0-based). */
const messagesOf = (n: number): any[] => mockRunModelTurn.mock.calls[n][1] as any[];

beforeEach(() => {
  mockRunModelTurn.mockReset();
  mockExecuteCodingTool.mockClear();
});

describe('kimi-k3 Preserved Thinking conformance (ticket 22c309f4)', () => {
  it('a tool-call turn with a 70k-char reasoning trace replays reasoning_content VERBATIM on the next request (no 16k truncation)', async () => {
    // 67-71k chars is the REAL trace size that burned the 16k output cap on
    // 2026-09-13 (turn-recovery.ts) — the old replay truncated exactly these.
    const trace = 'Reasoning step. '.repeat(4_400); // 70,400 chars
    mockRunModelTurn
      .mockResolvedValueOnce({
        content: 'Probing the queue.',
        reasoning: trace,
        toolCalls: [{ id: 't1', name: 'list_feedback', arguments: '{}' }],
        finishReason: 'tool_calls',
      })
      .mockResolvedValueOnce(FINAL);

    const result = await runCodingAgent(makeInput('kimi-k3'));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    const assistant = messagesOf(1).find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(assistant).toBeDefined();
    expect(assistant.reasoning_content).toBe(trace); // byte-identical — the vendor's "as-is"
    expect(assistant.reasoning_content.length).toBeGreaterThan(16_000); // the OLD cap would have clipped this
    expect(assistant.reasoning_content).not.toContain('[truncated]');
    // …and the tool result still follows it (tool linkage intact).
    expect(messagesOf(1).some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(true);
    expect(result.finalText).toBe(FINAL.content);
  });

  it('a CONTENT-ONLY assistant record (leak lane) also carries reasoning_content for kimi-k3', async () => {
    // The model wrote a tool call as PLAIN TEXT with a real reasoning trace:
    // the leak lane stores its assistant turn before challenging — that record
    // must carry reasoning_content too (Preserved Thinking covers every
    // historical assistant message, not just tool-call turns).
    const trace = 'I should list the open tickets first. '.repeat(200); // 7,600 chars
    mockRunModelTurn
      .mockResolvedValueOnce({
        content: 'Let me read it.\n<invoke name="list_feedback"><parameter name="status">open</parameter></invoke>',
        reasoning: trace,
        toolCalls: [],
        finishReason: 'stop',
      })
      .mockResolvedValueOnce(FINAL);

    await runCodingAgent(makeInput('kimi-k3'));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    // The loop hands every turn the SAME live messages array (mutated later),
    // so the FINAL turn's own assistant record appears too — target the leak
    // lane's record by its content.
    const leakRecord = messagesOf(1).find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('Let me read it.'));
    expect(leakRecord).toBeDefined();
    expect(leakRecord.reasoning_content).toBe(trace);
    // …and the FINAL turn's record correctly carries none (empty reasoning).
    const finalRecord = messagesOf(1).find((m) => m.role === 'assistant' && m.content === FINAL.content);
    expect(finalRecord).toBeDefined();
    expect(finalRecord).not.toHaveProperty('reasoning_content');
  });

  it('other seats are untouched: glm-5.3 stores NO reasoning_content on the replayed assistant message', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce({
        content: 'Probing.',
        reasoning: 'glm thinks in its own channel',
        toolCalls: [{ id: 't1', name: 'list_feedback', arguments: '{}' }],
        finishReason: 'tool_calls',
      })
      .mockResolvedValueOnce(FINAL);

    await runCodingAgent(makeInput('glm-5.3'));

    const assistant = messagesOf(1).find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(assistant).toBeDefined();
    expect(assistant).not.toHaveProperty('reasoning_content');
  });

  it('the 200k pathological valve still truncates a runaway trace (with the marker)', async () => {
    const trace = 'x'.repeat(210_000);
    mockRunModelTurn
      .mockResolvedValueOnce({
        content: 'Probing.',
        reasoning: trace,
        toolCalls: [{ id: 't1', name: 'list_feedback', arguments: '{}' }],
        finishReason: 'tool_calls',
      })
      .mockResolvedValueOnce(FINAL);

    await runCodingAgent(makeInput('kimi-k3'));

    const assistant = messagesOf(1).find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(assistant.reasoning_content.length).toBe(200_000 + '\n[truncated]'.length);
    expect(assistant.reasoning_content.endsWith('[truncated]')).toBe(true);
  });

  it('the request sanitizer preserves reasoning_content end-to-end (what hits the wire)', async () => {
    const msgs = sanitizeMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'Probing.', reasoning_content: 'trace', tool_calls: [{ id: 't1', type: 'function', function: { name: 'list_feedback', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
    ]);
    const assistant = msgs.find((m: any) => m.role === 'assistant');
    expect(assistant.reasoning_content).toBe('trace');
    expect(msgs.some((m: any) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(true);
  });
});
