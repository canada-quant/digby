// LEGACY SCHEMA REPLAY (coding/tool-scope.ts, owner 2026-09-22): this pin replays
// an incident from before the cause-level fix — when `update_feedback` /
// `update_supervisor_state` were offered under their internal names to every
// coding lane. The breaker / pre-flight mechanics it pins are unchanged. The
// always-visible switches below still restore that era's SCOPE; the era's
// internal NAMES cannot be restored — RSW-1 deleted the disambiguation kill
// switch on 2026-11-02, so those tools are offered as `triage_ticket` /
// `save_supervisor_state` and the name assertions below pin the model-facing
// spelling. An EMITTED internal name still resolves and executes.
// (agent-tool-scope.test.ts pins the new default: renamed, scoped, slip-pruned.)
process.env.TRIAGE_TOOLS_ALWAYS_VISIBLE = '1';
process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE = '1';

/**
 * Identical-call loop breaker — ticket e882204f (Tenstorrent firing-101,
 * 2026-09-09; chat a8976e11, msg f67243f6).
 *
 * kimi-k3 burned ~63 min / ~70% of the run budget emitting the SAME listing
 * call with the SAME arguments across dozens of auto-continue rounds while its
 * own narration reported a "tool-selection malfunction"; the identical shape
 * reproduced on a GLM lane (140+ duplicate update_feedback calls). The
 * repeatCount text nudge fired every round and was ignored; the failure
 * derail-breaker could not see the loop because every call SUCCEEDED.
 *
 * The breaker is MECHANICAL parity with the derail-breaker: ONE tool called
 * with the IDENTICAL signature 3 turns running (repeatCount reaches 2) is
 * withheld from the schema for exactly one model round, with an in-band
 * notice + GUARD_STRIKE telemetry (seam 'tool_repeat_break'). Documented
 * identical-arg poll tools (process-output waits, get_chat_status,
 * run_command) and mixed multi-tool turns never trip it.
 *
 * Scaffold mirrors agent-derail-break.test.ts (same mock set).
 */

// These suites drive runCodingAgent through many mocked turns with REAL
// timers — in the contended shared dev container the event loop stretches
// them past jest's 5s default (11–13 tests timed out fleet-wide 2026-09-10,
// wedging every session's verify→PR gate; main CI passes at 5s on idle
// runners; 22/22 pass in-container at 60s). Timeout bump only — the
// assertions are unchanged.
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
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', TOOL_BATCH_CAP: 'tool_batch_cap' },
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
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
// d45faf5e3 added a reflection consult (45 s-bound cross-checker seat call) to
// the derail-breaker streak path; the poll-exempt test's ungrounded handle
// ("h1") is preflight-refused (failure-shaped), tripping that breaker, and the
// unmocked consult stalls the test past the 5 s jest timeout. Resolve instantly.
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

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/repeat-break-test',
  sessionId: 'sess-repeat-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'do the thing',
  emit: jest.fn(),
});

/** A turn calling `name` once with the IDENTICAL arguments every time (the loop shape). */
const identTurn = (name: string, n: number, args = '{"id":"e882204f","status":"done"}') => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `t${n}`, name, arguments: args }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const toolNames = (call: any[]): string[] => ((call?.[2] ?? []) as any[]).map((t: any) => t?.function?.name).filter(Boolean);
const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_repeat_break');
const allMessages = () => mockRunModelTurn.mock.calls.flatMap((c) => ((c?.[1] ?? []) as any[]));
const sawRepeatNotice = () => allMessages().some((m) =>
  m.role === 'user' && typeof m.content === 'string'
  && m.content.includes('IDENTICAL') && m.content.includes('temporarily removed'),
);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  mockExecuteCodingTool.mockResolvedValue('probe result: ok');
});

describe('identical-call loop breaker (ticket e882204f)', () => {
  it('3 consecutive identical successful calls withhold the tool for exactly one round, with notice + telemetry', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(identTurn('update_feedback', 1))
      .mockResolvedValueOnce(identTurn('update_feedback', 2))
      .mockResolvedValueOnce(identTurn('update_feedback', 3)) // streak hits 3 → withheld next round
      .mockResolvedValueOnce(identTurn('list_schedules', 4)) // the banned round — model probes differently
      .mockResolvedValue(FINAL);
    const input = makeInput();
    await runCodingAgent(input);

    // Round 4 (post-trigger): update_feedback absent from the offered schema.
    const round4Tools = toolNames(mockRunModelTurn.mock.calls[3]);
    expect(round4Tools.length).toBeGreaterThan(0); // tools still offered…
    expect(round4Tools).not.toContain('triage_ticket'); // …minus the looped one (model-facing spelling)

    // The notice reached the model before round 4.
    const round4Messages = mockRunModelTurn.mock.calls[3][1] as any[];
    expect(round4Messages.some((m) =>
      m.role === 'user' && typeof m.content === 'string'
      && m.content.includes('IDENTICAL update_feedback call')
      && m.content.includes('temporarily removed'),
    )).toBe(true);

    // Telemetry: one GUARD_STRIKE with the repeat-break seam…
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta.tool).toBe('update_feedback');
    // …and a progress event the UI can surface.
    expect(input.emit).toHaveBeenCalledWith('progress', expect.objectContaining({ stage: 'repeat-break' }));
  });

  it('the withheld tool RETURNS the round after the ban', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(identTurn('update_feedback', 1))
      .mockResolvedValueOnce(identTurn('update_feedback', 2))
      .mockResolvedValueOnce(identTurn('update_feedback', 3))
      .mockResolvedValueOnce(identTurn('search_memory', 4)) // banned round
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    const round5Call = mockRunModelTurn.mock.calls[4];
    if (round5Call && round5Call[2]) {
      expect(toolNames(round5Call)).toContain('triage_ticket'); // model-facing spelling
    }
  });

  it('documented poll tools are exempt — identical-arg process-output waits never trip the breaker', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(identTurn('wait_for_process_output', 1, '{"handle":"h1"}'))
      .mockResolvedValueOnce(identTurn('wait_for_process_output', 2, '{"handle":"h1"}'))
      .mockResolvedValueOnce(identTurn('wait_for_process_output', 3, '{"handle":"h1"}'))
      .mockResolvedValueOnce(identTurn('wait_for_process_output', 4, '{"handle":"h1"}'))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(breakerMetrics()).toHaveLength(0);
    expect(sawRepeatNotice()).toBe(false);
  });

  it('get_chat_status provisioning polls are exempt', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(identTurn('get_chat_status', 1, '{"chatId":"c1"}'))
      .mockResolvedValueOnce(identTurn('get_chat_status', 2, '{"chatId":"c1"}'))
      .mockResolvedValueOnce(identTurn('get_chat_status', 3, '{"chatId":"c1"}'))
      .mockResolvedValueOnce(identTurn('get_chat_status', 4, '{"chatId":"c1"}'))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(breakerMetrics()).toHaveLength(0);
    expect(sawRepeatNotice()).toBe(false);
  });

  it('a different call between identical ones resets the streak', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(identTurn('update_feedback', 1))
      .mockResolvedValueOnce(identTurn('update_feedback', 2))
      .mockResolvedValueOnce(identTurn('list_schedules', 3, '{}')) // sig changes — streak resets
      .mockResolvedValueOnce(identTurn('update_feedback', 4))
      .mockResolvedValueOnce(identTurn('update_feedback', 5)) // only 2 in a row — below the bar
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(breakerMetrics()).toHaveLength(0);
    expect(sawRepeatNotice()).toBe(false);
  });

  it('mixed multi-tool turns never trip the breaker (batch sigs are not single-tool loops)', async () => {
    const batchTurn = (n: number) => ({
      content: '',
      reasoning: '',
      toolCalls: [
        { id: `t${n}a`, name: 'list_chats', arguments: '{"limit":50}' },
        { id: `t${n}b`, name: 'list_schedules', arguments: '{}' },
      ],
      finishReason: 'tool_calls',
    });
    mockRunModelTurn
      .mockResolvedValueOnce(batchTurn(1))
      .mockResolvedValueOnce(batchTurn(2))
      .mockResolvedValueOnce(batchTurn(3))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(breakerMetrics()).toHaveLength(0);
    expect(sawRepeatNotice()).toBe(false);
  });
});

// ── Escalation (autonomy loop #9, 2026-09-20): the one-round withhold fired 23×
//    on one lane in 26 min — a decoder-locked model resumes the identical call
//    the moment the tool returns. Trip 1: one round; trip 2: three rounds;
//    trip 3 on the same tool: gone for the rest of the run. ──
describe('identical-call loop breaker — escalation', () => {
  it('second loop withholds for THREE rounds, third loop withholds for the rest of the run; every other tool stays', async () => {
    const T = (n: number) => identTurn('update_feedback', n);
    mockRunModelTurn
      .mockResolvedValueOnce(T(1)).mockResolvedValueOnce(T(2)).mockResolvedValueOnce(T(3))   // rounds 1-3 → trip 1 (round 4 withheld)
      .mockResolvedValueOnce(identTurn('list_feedback', 4, '{}'))                            // round 4: tool absent — the model does something else
      .mockResolvedValueOnce(T(5)).mockResolvedValueOnce(T(6)).mockResolvedValueOnce(T(7))   // rounds 5-7 → trip 2 (rounds 8-10 withheld)
      .mockResolvedValueOnce(identTurn('list_feedback', 8, '{}'))
      .mockResolvedValueOnce(identTurn('list_feedback', 9, '{}'))
      .mockResolvedValueOnce(identTurn('list_feedback', 10, '{}'))
      .mockResolvedValueOnce(T(11)).mockResolvedValueOnce(T(12)).mockResolvedValueOnce(T(13)) // rounds 11-13 → trip 3 (rest of run)
      .mockResolvedValueOnce(identTurn('list_feedback', 14, '{}'))
      .mockResolvedValueOnce(identTurn('list_feedback', 15, '{}'))
      .mockResolvedValueOnce(FINAL);
    await runCodingAgent({ ...makeInput(), profile: { ...CHAT_TEST_PROFILE, maxSteps: 30 } });
    const has = (round: number) => toolNames(mockRunModelTurn.mock.calls[round - 1]).includes('triage_ticket'); // offered under the model-facing spelling
    // Trip 1: absent for round 4 only.
    expect(has(4)).toBe(false); expect(has(5)).toBe(true);
    // Trip 2: absent for rounds 8, 9, 10 — back at 11.
    expect(has(8)).toBe(false); expect(has(9)).toBe(false); expect(has(10)).toBe(false); expect(has(11)).toBe(true);
    // Trip 3: gone for the rest of the run.
    expect(has(14)).toBe(false); expect(has(15)).toBe(false); expect(has(16)).toBe(false);
    // Every other tool stays throughout.
    expect(toolNames(mockRunModelTurn.mock.calls[13])).toContain('list_feedback');
    const metrics = breakerMetrics();
    expect(metrics.map((m) => [m.meta.trips, m.meta.rounds])).toEqual([[1, 1], [2, 3], [3, 'run']]);
    // allMessages() flattens every model call's transcript, so dedupe by text.
    const notices = [...new Set(allMessages().filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('IDENTICAL update_feedback')).map((m) => m.content as string))];
    expect(notices).toHaveLength(3);
    expect(notices[0]).toContain('for the next round — it returns the round after');
    expect(notices[1]).toContain('second time this run');
    expect(notices[1]).toContain('for the next 3 rounds');
    expect(notices[2]).toContain('third time this run');
    expect(notices[2]).toContain('REST OF THIS RUN');
  });
});

// ── Per-turn batch cap (autonomy loop #9, 2026-09-20): run 1cf6f9d4 emitted 233
//    then 327 update_feedback calls in single turns — every one executed. ──
describe('per-turn tool-call batch cap', () => {
  it('a 40-call storm turn runs only the first 24, answers the rest synthetically, records tool_batch_cap, and withholds the dominant tool next round', async () => {
    const storm = {
      content: '', reasoning: '', finishReason: 'tool_calls',
      toolCalls: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: 'update_feedback', arguments: `{"id":"0000000${i}","status":"done"}` })),
    };
    mockRunModelTurn
      .mockResolvedValueOnce(storm)
      .mockResolvedValueOnce(identTurn('list_feedback', 2, '{}'))
      .mockResolvedValueOnce(FINAL);
    await runCodingAgent(makeInput());
    // Round 1 executed exactly 24 of the 40 calls.
    const executedNames = mockExecuteCodingTool.mock.calls.map((c) => c[1]);
    expect(executedNames.filter((n) => n === 'update_feedback')).toHaveLength(24);
    // The 16 skipped calls each got a tool message, so the transcript stays valid.
    const round2Messages = mockRunModelTurn.mock.calls[1][1] as any[];
    const synthetic = round2Messages.filter((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('[HARNESS — not executed]'));
    expect(synthetic).toHaveLength(16);
    expect(new Set(synthetic.map((m) => m.tool_call_id)).size).toBe(16);
    // Telemetry + escalation: the storm counted as trip 1 → the tool is absent in round 2, back in round 3.
    const cap = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((m) => m?.kind === 'tool_batch_cap');
    expect(cap).toMatchObject({ value: 40, meta: expect.objectContaining({ requested: 40, executed: 24, dominantTool: 'update_feedback', storm: true }) });
    expect(toolNames(mockRunModelTurn.mock.calls[1])).not.toContain('triage_ticket');
    expect(toolNames(mockRunModelTurn.mock.calls[2])).toContain('triage_ticket');
    expect(breakerMetrics().map((m) => [m.meta.trips, m.meta.rounds, m.meta.batch])).toEqual([[1, 1, 40]]);
    expect(round2Messages.some((m) => m.role === 'user' && String(m.content).includes('requested 40 tool calls, almost all update_feedback'))).toBe(true);
  });

  });
