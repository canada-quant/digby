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
 * Replay pin — ticket 00667344 (mishap, breaker trip 2026-09-14, session
 * e083ff2e-de98-412a-85df-86923572db1d "Post-CPT Coordination — SFT/GRPO/GSPO
 * + …", run 9f0ceebe-d45c-4369-841b-7c48f5421227, auto-filed 00:41:06Z —
 * 72s after sibling ticket 03e8cd3d from the SAME run).
 *
 * THE INCIDENT: after the update_canvas "noop" derail (03e8cd3d) the same
 * lane decoder-locked on update_feedback with fabricated ids:
 *   · update_feedback({id:"00000000"}) → executed → "Feedback ticket
 *     \"00000000\" not found."
 *   · update_feedback({id:"noop"})     → executed → "Feedback ticket
 *     \"noop\" not found."
 *   (3 consecutive failure-shaped results → breaker trip → this ticket.)
 *
 * WHY THE PREFLIGHT LET THESE THROUGH — BY DESIGN, pinned here so nobody
 * "fixes" it blind:
 *   - "00000000" is ≥8-hex — it passes the id SHAPE check
 *     (tool-preflight.ts ID_SHAPE_RE): a shape-valid id the model invented
 *     is indistinguishable from a real citation without a DB lookup, so the
 *     call executes and the database TRUTHFULLY answers "not found". The
 *     preflight's contract is "no DB round-trip for ids the model could not
 *     know", not "validate every id against the DB".
 *   - "noop" was GROUNDED at that point in the run: the update_canvas
 *     preflight refusal from ~72s earlier quotes the rejected value
 *     (`canvasId=\"noop\"`) inside a tool RESULT, and tool results are
 *     legitimate grounding haystack (groundingHaystack excludes only
 *     ASSISTANT turns — the derailed call's own arguments can't ground the
 *     next one, but a refusal envelope the harness itself produced can).
 *     The containment chain held anyway: truthful failure → breaker trip →
 *     ONE deduped ticket.
 *
 * ADJUDICATION (this lane, 2026-09-14): MODEL behavior, framework working AS
 * DESIGNED at every deterministic seam. The 251e9329 check: every filed
 * failure text is truthful and self-describing (a real "ticket not found"
 * from the feedback service), and the advertised recovery path in the
 * sibling refusal (get_chat_messages) is a real, always-offered read tool.
 * No recent framework change touches this path (tool-preflight.ts untouched
 * since its 2026-09-12 pin; the ticket's own text is byte-identical to
 * reflection.ts fileStreakInvestigation's template). The root derail is the
 * model emitting placeholder ids — the class tool-preflight.ts was built to
 * catch and DID catch on the same run's update_canvas call.
 * NO platform code change: this pin replays the incident end-to-end through
 * the real agent loop (REAL preflight + grounding haystack + breaker; only
 * the model, the tool executor, and the streak consult/filing are mocked).
 * Scaffold mirrors agent-derail-break.b61fb6c9.test.ts.
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
  worktree: '/tmp/derail-00667344-test',
  sessionId: 'sess-00667344',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'close out the coordination tickets',
  emit: jest.fn(),
});

const derailTurn = (name: string, n: number, args: string, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name, arguments: args }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const preflightMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_preflight');

/** The ticket's verbatim failure texts (newest-first there; chronological here). */
const NOT_FOUND_ZEROS = 'Tool update_feedback failed: Feedback ticket "00000000" not found.';
const NOT_FOUND_NOOP = 'Tool update_feedback failed: Feedback ticket "noop" not found.';

const INCIDENT_REASONING =
  'I need the parent lane\'s latest coordination state first — calling get_chat_messages now with its real parameters.';

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 00667344 replay — update_feedback fabricated-id streak (run 9f0ceebe)', () => {
  it('REPLAY: shape-valid ("00000000") and refusal-grounded ("noop") ids EXECUTE and fail truthfully; the 2nd-tool trip ENDS the run honestly; BOTH deduped tickets filed', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(NOT_FOUND_ZEROS) // t3
      .mockResolvedValueOnce(NOT_FOUND_NOOP); // t4
    mockRunModelTurn
      // Round 1-2: the sibling derail (03e8cd3d) — update_canvas({canvasId:
      // "noop"}) refused by the preflight. The refusal is a TOOL RESULT that
      // quotes `canvasId="noop"`, putting "noop" into the grounding haystack.
      .mockResolvedValueOnce(derailTurn('load_tool_group', 1, '{"group":"account"}', ''))
      .mockResolvedValueOnce(derailTurn('update_canvas', 2, '{"canvasId":"noop","markdown":"coordination update"}', INCIDENT_REASONING))
      // Rounds 3-4: THE STREAK — update_feedback with fabricated ids, the
      // reasoning still naming get_chat_messages (the incident ticket's own
      // "lane's reasoning named get_chat_messages"). Each failure counts +1
      // (failure) +1 (intent mismatch, agent.ts:2422) — the streak trips on
      // the SECOND update_feedback call: exactly the two "Failure texts" the
      // real ticket records.
      .mockResolvedValueOnce(derailTurn('update_feedback', 3, '{"id":"00000000","status":"done"}', INCIDENT_REASONING))
      .mockResolvedValueOnce(derailTurn('update_feedback', 4, '{"id":"noop","status":"done"}', INCIDENT_REASONING))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // 1. Both update_feedback calls EXECUTED (no NOT-EXECUTED refusal):
    //    "00000000" is hex-shape-valid and "noop" was haystack-grounded by
    //    the earlier refusal — the preflight passed them BY DESIGN.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
    // 2. …and the model saw the ticket's verbatim truthful not-found texts
    //    (a DB "not found", not a preflight refusal).
    const finalMessages = (mockRunModelTurn.mock.calls.at(-1)?.[1] ?? []) as any[];
    const seen = (id: string) => finalMessages.find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';
    expect(seen('t3')).toBe(NOT_FOUND_ZEROS);
    expect(seen('t4')).toBe(NOT_FOUND_NOOP);

    // 3. No preflight refusal was recorded FOR update_feedback (only the
    //    update_canvas primer earned one) — the executions were not a
    //    preflight malfunction.
    expect(preflightMetrics().filter((m) => m.meta.tool === 'update_feedback')).toHaveLength(0);
    expect(preflightMetrics().filter((m) => m.meta.tool === 'update_canvas')).toHaveLength(1);

    // 4. Terminal N1 state (agent.ts:2466): trips on ≥2 DIFFERENT tools END
    //    the run honestly (completed-with-note) instead of another withhold
    //    round — the run made exactly 4 model calls (no round 5).
    expect(mockRunModelTurn.mock.calls).toHaveLength(4);
    expect(breakerMetrics()).toHaveLength(2);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'update_canvas', perma: false, intended: 'get_chat_messages' });
    expect(breakerMetrics()[1].meta).toMatchObject({
      state: 'ended_run', tool: 'update_feedback', trips: 2,
      tools: ['update_canvas', 'update_feedback'], intended: 'get_chat_messages',
    });

    // 5. BOTH deduped investigation tickets were filed — the real incident's
    //    two tickets (03e8cd3d update_canvas, 00667344 update_feedback), the
    //    second carrying the streak's own verbatim failure texts and the
    //    intent signal the real ticket records ("lane's reasoning named
    //    get_chat_messages").
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(2);
    expect(mockFileStreakInvestigation.mock.calls[0][0]).toMatchObject({ tool: 'update_canvas', intended: 'get_chat_messages' });
    const ev = mockFileStreakInvestigation.mock.calls[1][0];
    expect(ev).toMatchObject({ tool: 'update_feedback', intended: 'get_chat_messages' });
    expect(ev.recentFailures).toHaveLength(2);
    expect(ev.recentFailures.join('\n')).toContain(NOT_FOUND_ZEROS);
    expect(ev.recentFailures.join('\n')).toContain(NOT_FOUND_NOOP);
  });

  it('CONTROL: on a CLEAN transcript the preflight still convicts update_feedback({id:"noop"}) without executing', async () => {
    // No "noop"-quoting refusal in the haystack this time — the bare token
    // is neither id-shaped nor read this run, so it is refused up front.
    // (The incident's executions happened only because the token had entered
    // read text via the sibling refusal — NOT because the preflight spares
    // "noop".)
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn('update_feedback', 1, '{"id":"noop","status":"done"}', INCIDENT_REASONING))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
    expect(preflightMetrics()).toHaveLength(1);
    expect(preflightMetrics()[0].meta).toMatchObject({ tool: 'update_feedback', reason: 'ungrounded_id', intended: 'get_chat_messages' });
    const round2Messages = mockRunModelTurn.mock.calls[1][1] as any[];
    // RSW-1: the slip-echo prune is ALWAYS ON now — the refusal envelope is
    // pruned from the replayed transcript for this pure-slip turn and ONE
    // harness notice stands in its place (pre-flight still refused it).
    expect(round2Messages.some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(false);
    const notice = round2Messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('SLIP REMOVED'));
    expect(notice).toBeTruthy();
    expect(notice.content).toContain('triage_ticket("noop")');
    expect(notice.content).toContain('the id was a placeholder, not an id any tool returned this run');
  });
});
