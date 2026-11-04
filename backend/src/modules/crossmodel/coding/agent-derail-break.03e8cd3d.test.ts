// LEGACY SCHEMA REPLAY (coding/tool-scope.ts, owner 2026-09-22): this pin replays
// an incident from before the cause-level fix — a refused pure-slip turn now leaves
// the replayed transcript (slip-echo prune). The pre-flight / breaker mechanics it
// pins are unchanged; the always-visible switches below restore that era's SCOPE.
// The era's UNPRUNED transcript shape cannot be restored — RSW-1 deleted the
// slip-echo kill switch on 2026-11-02, so a pure-slip turn is always pruned and
// these pins assert on the refusal's telemetry row plus the SLIP REMOVED notice.
// (agent-tool-scope.test.ts pins the new default.)
process.env.TRIAGE_TOOLS_ALWAYS_VISIBLE = '1';
process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE = '1';

/**
 * Replay pin — ticket 03e8cd3d (mishap, breaker trip 2026-09-14, session
 * e083ff2e-de98-412a-85df-86923572db1d "Post-CPT Coordination — SFT/GRPO/GSPO
 * + …", run 9f0ceebe-d45c-4369-841b-7c48f5421227, auto-filed 00:39:54Z).
 *
 * THE INCIDENT: the coordination lane decoder-locked on update_canvas and
 * emitted `update_canvas({canvasId:"noop"})` — a narration token where an
 * entity id belongs — while its own reasoning said it was calling
 * get_chat_messages. The deterministic tool pre-flight (tool-preflight.ts,
 * built 2026-09-09 for EXACTLY this derailment class) refused the call
 * WITHOUT executing it:
 *   {"ok":false,"tool":"update_canvas","reason":"ungrounded_id",
 *    "rejected":[{"key":"canvasId","value":"noop"}],
 *    "message":"NOT EXECUTED: update_canvas was called with
 *    canvasId=\"noop\", which is not an id you obtained this run — …
 *    Your reasoning named get_chat_messages — you evidently meant to call
 *    get_chat_messages; call it now with its real parameters."}
 * and the breaker fast-tripped (ungrounded id + intent mismatch) → one-round
 * withhold + exactly ONE auto-filed investigation ticket (this one).
 *
 * ADJUDICATION (this lane, 2026-09-14): MODEL behavior, framework working AS
 * DESIGNED at every deterministic seam:
 *   - The refusal envelope is the preflight's pinned shape
 *     (tool-preflight.c5615f58.test.ts) — truthful, self-describing, and it
 *     names the recovery path. The named path is REAL: get_chat_messages is
 *     an always-offered platform read tool (PLATFORM_READ_TOOLS), so the
 *     251e9329 "broken advertised recovery" defect class does not apply.
 *   - "noop" is neither id-shaped (uuid / ≥8-hex) nor present in text the
 *     lane had read at that point — the grounding check convicted it
 *     correctly (findUngroundedIdArgs). No DB round-trip happened.
 *   - git log on tool-preflight.ts shows no recent framework change (last
 *     touch is a merge; the envelope is pin-locked since 2026-09-12) — the
 *     streak is not a regression diff against recent framework changes.
 *   - The ticket's own title/description is byte-identical to reflection.ts
 *     fileStreakInvestigation's template — proof the auto-filer itself fired
 *     as designed.
 * NO platform code change: this pin locks the intended behavior (the
 * preflight convicts the placeholder id on the FIRST call, names the
 * intended tool, fast-trips the breaker, files ONE deduped ticket) so a
 * future "fix" cannot weaken the conviction — while replaying the incident
 * end-to-end through the real agent loop (the REAL preflight + breaker run;
 * only the model, the tool executor, and the streak consult/filing are
 * mocked). Scaffold mirrors agent-derail-break.b61fb6c9.test.ts.
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
  buildChatWakeClockNote: jest.fn(() => ""),
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
  worktree: '/tmp/derail-03e8cd3d-test',
  sessionId: 'sess-03e8cd3d',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'refresh the coordination canvas',
  emit: jest.fn(),
});

/** A turn whose REASONING names another tool while it emits `name` with a raw args string. */
const derailTurn = (name: string, n: number, args: string, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name, arguments: args }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const toolNames = (call: any[]): string[] => ((call?.[2] ?? []) as any[]).map((t: any) => t?.function?.name).filter(Boolean);
const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const preflightMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_preflight');

/** The incident's reasoning shape: it names get_chat_messages (a real,
 *  always-offered read tool) and NEVER names update_canvas. */
const INCIDENT_REASONING =
  'The coordination canvas is stale. I need the parent lane\'s freshest transcript first '
  + '— calling get_chat_messages now with its real parameters, then I write the summary.';

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 03e8cd3d replay — update_canvas({canvasId:"noop"}) placeholder-id derail', () => {
  it('REPLAY: the preflight refuses WITHOUT executing, names get_chat_messages, fast-trips the breaker, files ONE ticket', async () => {
    mockRunModelTurn
      // Round 1: the lane loads the account group (the incident run had
      // update_canvas offered — it is an account tool, load_tool_group-gated).
      .mockResolvedValueOnce(derailTurn('load_tool_group', 1, '{"group":"account"}', ''))
      // Round 2: THE DERAIL — narration token "noop" where a canvasId belongs,
      // while the reasoning says get_chat_messages.
      .mockResolvedValueOnce(derailTurn('update_canvas', 2, '{"canvasId":"noop","markdown":"coordination update"}', INCIDENT_REASONING))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // 1. Never round-tripped to the executor — no DB hit for an invented id
    //    (load_tool_group is answered inline by the preflight too).
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();

    // 2. The tool result the model saw is the ticket's verbatim refusal
    //    envelope: ungrounded_id, the rejected canvasId="noop", NOT EXECUTED,
    //    and the redirect naming get_chat_messages.
    const round3Messages = mockRunModelTurn.mock.calls[2][1] as any[];
    // RSW-1: the slip-echo prune is ALWAYS ON now, so a PURE-SLIP turn's
    // assistant record and its refusal envelope are removed from the replayed
    // transcript and replaced by ONE harness notice. The refusal itself still
    // fired pre-flight (asserted on telemetry below); what the model sees is
    // the notice naming the call, the reason and the intended tool.
    expect(round3Messages.some((m) => m.role === 'tool' && m.tool_call_id === 't2')).toBe(false);
    const notice = round3Messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('SLIP REMOVED'));
    expect(notice).toBeTruthy();
    expect(notice.content).toContain('update_canvas("noop")');
    expect(notice.content).toContain('the id was a placeholder, not an id any tool returned this run');
    expect(notice.content).toContain('get_chat_messages');

    // 3. Fast trip on the FIRST derailed call (ungrounded + intent mismatch):
    //    update_canvas is withheld from the very next round's schema…
    const round3Tools = toolNames(mockRunModelTurn.mock.calls[2]);
    expect(round3Tools.length).toBeGreaterThan(0);
    expect(round3Tools).not.toContain('update_canvas');
    //    …and the breaker notice names the tool the reasoning meant.
    expect(round3Messages.some((m) => m.role === 'user' && typeof m.content === 'string'
      && m.content.includes('ALL FAILED') && m.content.includes('named get_chat_messages'))).toBe(true);

    // 4. Telemetry: one preflight guard_strike + one breaker trip, both
    //    naming update_canvas and the intended get_chat_messages.
    expect(preflightMetrics()).toHaveLength(1);
    expect(preflightMetrics()[0].meta).toMatchObject({ tool: 'update_canvas', reason: 'ungrounded_id', intended: 'get_chat_messages' });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta.tool).toBe('update_canvas');

    // 5. Exactly ONE investigation ticket filed at the trip (the ticket this
    //    pin replays), carrying the tool, the intent, and the refusal text.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    expect(mockFileStreakInvestigation.mock.calls[0][0]).toMatchObject({ tool: 'update_canvas', intended: 'get_chat_messages' });
    expect(mockFileStreakInvestigation.mock.calls[0][0].recentFailures.join('\n')).toContain('ungrounded_id');
  });

  it('CONTROL (no overreach): a REAL canvas id read this run executes normally — no refusal, no trip, no ticket', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce('[{"id":"1b9d6f3e-2a4c-4e5b-9c7d-8e0f1a2b3c4d","title":"Post-CPT Coordination"}]') // list_canvases
      .mockResolvedValueOnce('Canvas updated (version 2).'); // update_canvas
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn('load_tool_group', 1, '{"group":"account"}', ''))
      .mockResolvedValueOnce(derailTurn('list_canvases', 2, '{}', ''))
      .mockResolvedValueOnce(derailTurn('update_canvas', 3, '{"canvasId":"1b9d6f3e-2a4c-4e5b-9c7d-8e0f1a2b3c4d","markdown":"ok"}', ''))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
    expect(preflightMetrics().filter((m) => m.meta.tool === 'update_canvas')).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });
});
