/**
 * REPLAY PIN — ticket 7345b333 (2026-11-02 bug_report).
 *
 * THE INCIDENT (owner's own message in the Fleet Supervisor chat c0e22e36):
 * "why am i seeing all of this horrible looking text in the chat ui ?" — with
 * ~50 near-identical copies of this pasted beneath it, each followed by a
 * "Used 1 tool" row:
 *
 *   <tool_call><function=todo_update><parameter=todoId>0946fc49</parameter>
 *   <parameter=progressNote>Calendar-gated, NOT stalled: …</parameter></function></tool_call>
 *
 * It originated in a Schooltime machine run (lane 0037460b), not from owner
 * actions. THREE defects, all Digby-side; this file pins #1 and #2:
 *
 *   #1 PARSE FAIL, FAIL-OPEN TO TEXT — the ASCII-XML call was never recognised:
 *      `looksLikeAttemptedToolCall` needed `invoke name=` (unmatched), and
 *      `stripToolCallMarkup` keyed on `tool_calls` PLURAL (this tag is `tool_call`
 *      SINGULAR), so removing the tags stranded the ARGUMENT PAYLOAD as prose.
 *      → sanitize-model-output.test.ts ("7345b333 — the inline ASCII-XML
 *        tool-call form") is the unit pin.
 *
 *   #2 NO LOOP BREAK — the same call, reworded, dozens of times in one turn
 *      while the run kept spending. Every breaker was blind: the tool-repeat
 *      legs count STRUCTURED tool calls (these were TEXT — the turn's only real
 *      call was elsewhere), and the line-repeat leg keys on identical LINES
 *      (each block was reworded slightly). THIS file is that pin: the run must
 *      END on the first wall turn instead of finalizing it.
 *
 * Scaffold mirrors agent-loop-volume.54a172ac.test.ts (same mock set).
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
  __esModule: true, agentBroker: { dispatch: jest.fn() },
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
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
  writeBreakerLaneNotice: jest.fn(async () => undefined),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 12,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/leaked-call-7345b333-test',
  sessionId: 'sess-7345b333',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'reconcile the Schooltime capture-duty row',
  emit: jest.fn(),
});

/** The verbatim leaked shape from the owner's transcript (slightly reworded per copy, as in prod). */
const xmlLeak = (variant: number) =>
  '<tool_call><function=todo_update><parameter=todoId>0946fc49</parameter>'
  + `<parameter=progressNote>Calendar-gated, NOT stalled (reconciled ${variant}): close bar is Monday's measured school-day numbers</parameter>`
  + '</function></tool_call>';

/** A turn that emits `n` reworded copies of the call as TEXT — the incident's shape. */
const leakedWallTurn = (n: number) => ({
  content: Array.from({ length: n }, (_, i) => xmlLeak(i + 1)).join('\n'),
  reasoning: '',
  toolCalls: [],
  finishReason: 'stop',
});

/** The same, but the turn ALSO made one real tool call (prod interleaved "Used 1 tool" under each). */
const leakedWallPlusRealCallTurn = (n: number) => ({
  content: Array.from({ length: n }, (_, i) => xmlLeak(i + 1)).join('\n'),
  reasoning: '',
  toolCalls: [{ id: `x${n}`, name: 'read_file', arguments: JSON.stringify({ path: `docs/p${n}.md` }) }],
  finishReason: 'tool_calls',
});

const oneLeakedCallTurn = (n: number) => ({
  content: xmlLeak(n),
  reasoning: '',
  toolCalls: [],
  finishReason: 'stop',
});

const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const strikes = (seam: string) =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === seam);

/** Every text the run pushed into the transcript / final answer. */
const deliveredText = (r: any): string =>
  (r.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => String(p.text ?? '')).join('\n')
  + '\n' + String(r.finalText ?? '');

describe('ticket 7345b333 — plain-text tool-call walls never reach the transcript, and the loop is bounded', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _store.clear();
    mockExecuteCodingTool.mockResolvedValue('probe result: ok');
  });

  it('REPLAY: one turn emitting ~50 reworded copies ends the run and no markup is delivered', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(leakedWallTurn(50))
      .mockResolvedValue(FINAL);

    const r = await runCodingAgent(makeInput());

    // The run ENDED on the wall turn — the guard did not retry into more spend.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    const brk = strikes('leaked_call_loop_break');
    expect(brk).toHaveLength(1);
    expect(brk[0].meta.state).toBe('ended_run');
    expect(brk[0].meta.leg).toBe('volume');
    expect(brk[0].meta.count).toBe(50);
    expect(brk[0].meta.tool).toBe('todo_update');

    // NOTHING markup-shaped was delivered, and the payload never surfaced as prose.
    const delivered = deliveredText(r);
    expect(delivered).not.toContain('<tool_call>');
    expect(delivered).not.toContain('<parameter=');
    expect(delivered).not.toContain('Calendar-gated');
    // …and the run says honestly what happened (the note rides both parts and
    // finalText, the same idiom every other breaker in agent.ts uses).
    expect(delivered).toContain('NONE of those calls executed');
  });

  it('REPLAY: the prod interleave (markup wall + one REAL tool call) is still caught', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(leakedWallPlusRealCallTurn(50))
      .mockResolvedValue(FINAL);

    const r = await runCodingAgent(makeInput());

    // The structured call is NOT the loop; the 50 text copies are. The turn was
    // read, so its real tool may have run — but the run still ends here.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(strikes('leaked_call_loop_break')).toHaveLength(1);
    const delivered = deliveredText(r);
    expect(delivered).not.toContain('<tool_call>');
    expect(delivered).not.toContain('<parameter=');
  });

  it('a SINGLE leaked call is a leak, not a loop — the bounded retry lane still owns it', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(oneLeakedCallTurn(1))
      .mockResolvedValueOnce(FINAL);

    await runCodingAgent(makeInput());

    expect(strikes('leaked_call_loop_break')).toHaveLength(0);
    // Two turns: the leak-retry retried once, then the clean final landed.
    expect(mockRunModelTurn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('the cross-turn REPEAT leg fires when the same call recurs across consecutive turns', async () => {
    // 3 turns × 1 identical call: the volume leg cannot see it (1 per turn) and
    // the exact structured-signature leg cannot either (no structured calls).
    mockRunModelTurn
      .mockResolvedValueOnce(oneLeakedCallTurn(1))
      .mockResolvedValueOnce(oneLeakedCallTurn(1))
      .mockResolvedValueOnce(oneLeakedCallTurn(1))
      .mockResolvedValue(FINAL);

    const r = await runCodingAgent(makeInput());

    const brk = strikes('leaked_call_loop_break');
    expect(brk).toHaveLength(1);
    expect(brk[0].meta.leg).toBe('repeat');
    expect(brk[0].meta.tool).toBe('todo_update');
    const delivered = deliveredText(r);
    expect(delivered).not.toContain('<tool_call>');
  });

  it('FEEDBACK-PIN: an answer that QUOTES the markup in a fenced block is delivered, never ended', async () => {
    // This repo's own docs/runs legitimately illustrate the shape. Fenced text
    // is masked, so it must not be convicted — and must not be stripped.
    const doc = [
      'The leak looked like this:',
      '```',
      xmlLeak(1),
      '```',
      'That is what reached the UI.',
    ].join('\n');
    mockRunModelTurn
      .mockResolvedValueOnce({ content: doc, reasoning: '', toolCalls: [], finishReason: 'stop' })
      .mockResolvedValue(FINAL);

    const r = await runCodingAgent(makeInput());

    expect(strikes('leaked_call_loop_break')).toHaveLength(0);
    const delivered = deliveredText(r);
    expect(delivered).toContain('The leak looked like this:');
    expect(delivered).toContain('That is what reached the UI.');
  });
});