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
 * Wrong-tool derailment breaker — CanLaw session cec340f2, 2026-09-08.
 *
 * kimi-k3 got decoder-locked emitting update_feedback with narration ids
 * ("BREAKING_NOW", "RUN_CMD_NEXT_CALL") while its own reasoning said "call
 * run_command" — 20 failed calls over 6h. The identical-signature repeatCount
 * nudge never fired (the args differed each call), and text nudges alone
 * could not break the token-path lock. The breaker is MECHANICAL: three
 * consecutive failure-shaped results from the same tool (run_command exempt)
 * withhold that tool from the schema for one model round.
 *
 * Scaffold mirrors agent-zero-tool-gate.test.ts (same mock set).
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
// d45faf5e3 added a reflection consult (45 s-bound cross-checker seat call) to
// the derail-breaker streak path; unmocked, the real seat resolution stalls each
// streak test past the 5 s jest timeout. Resolve instantly, no advice.
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
  worktree: '/tmp/derail-break-test',
  sessionId: 'sess-derail-1',
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

/** A turn calling `name` once (unique args per call — the incident shape). */
const callTurn = (name: string, n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `t${n}`, name, arguments: `{"id":"deadbeef-${n}","status":"done"}` /* hex-shaped ⇒ passes the id-grounding pre-flight; pins the classic 3-streak path */ }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** A turn whose REASONING names another tool while it emits `name` with a raw args string. */
const derailTurn = (name: string, n: number, args: string, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name, arguments: args }],
  finishReason: 'tool_calls',
});

/** Coding-lane profile WITHOUT workspace tools (no container / worktree reads in the scaffold). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The structured platform refusal envelope — the incident's exact shape. */
const OK_FALSE = '{\n "ok": false,\n "tool": "update_feedback",\n "reason": "ticket_not_found"\n}';

/** The confirmation gate's STAGING envelope — ticket 1ab1a52b's exact shape
 *  (JSON.stringify(…, null, 1), as platform-tools.ts builds it). A staged
 *  confirmation is a PENDING USER ACTION, not a failure. */
const STAGED_CONFIRMATION = JSON.stringify({
  ok: false,
  needsConfirmation: true,
  confirmationId: 'cf_47362400-ca18-486f-a180-a778b163737d',
  summary: 'Cancel (disable) schedule 794a76cb.',
  expiresInMinutes: 10080,
  expiresAt: 1789655170811,
  instructions: 'This action changes the user\'s account and needs THEIR explicit confirmation. …',
}, null, 1);

const toolNames = (call: any[]): string[] => ((call?.[2] ?? []) as any[]).map((t: any) => t?.function?.name).filter(Boolean);
const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('wrong-tool derailment breaker', () => {
  it('3 consecutive failure-shaped results from one tool withhold it for exactly one round, with notice + telemetry', async () => {
    mockExecuteCodingTool.mockResolvedValue(OK_FALSE);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('update_feedback', 1))
      .mockResolvedValueOnce(callTurn('update_feedback', 2))
      .mockResolvedValueOnce(callTurn('update_feedback', 3)) // streak hits 3 → withheld next round
      .mockResolvedValueOnce({ ...FINAL, content: 'Recovered without the tool.' }) // the banned round
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // Round 4 (post-trigger): update_feedback absent from the offered schema.
    const round4Tools = toolNames(mockRunModelTurn.mock.calls[3]);
    expect(round4Tools.length).toBeGreaterThan(0); // tools still offered…
    expect(round4Tools).not.toContain('triage_ticket'); // …minus the derailed one (model-facing spelling)

    // The notice reached the model before round 4.
    const round4Messages = mockRunModelTurn.mock.calls[3][1] as any[];
    expect(round4Messages.some((m) =>
      m.role === 'user' && typeof m.content === 'string'
      && m.content.includes('Your last 3 calls of update_feedback ALL FAILED')
      && m.content.includes('temporarily removed'),
    )).toBe(true);

    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta.tool).toBe('update_feedback');
  });

  // REPLAY — ticket 1ab1a52b (2026-09-10): a machine-triggered burn-down lane
  // called cancel_schedule 3× without an autonomy grant; every call staged a
  // pending confirmation (the gate working AS DESIGNED) and returned the
  // needsConfirmation envelope. looksLikeToolFailure's /ok:false/ marker
  // counted each staging as a failure → the breaker tripped, withheld the
  // tool, and reflection.ts auto-filed mishap 1ab1a52b. Staged confirmations
  // must never move the streak, the schema, or the ticket pipeline.
  it('ticket 1ab1a52b replay: staged-confirmation envelopes never trip the breaker or file a streak ticket', async () => {
    mockExecuteCodingTool.mockResolvedValue(STAGED_CONFIRMATION);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('cancel_schedule', 1))
      .mockResolvedValueOnce(callTurn('cancel_schedule', 2))
      .mockResolvedValueOnce(callTurn('cancel_schedule', 3)) // the old 3rd "failure" → trip
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(breakerMetrics()).toHaveLength(0); // no derail-break telemetry
    // The tool was never withheld: it is still offered after the third staging.
    expect(toolNames(mockRunModelTurn.mock.calls[0])).toContain('cancel_schedule'); // scaffold sanity
    expect(toolNames(mockRunModelTurn.mock.calls[3])).toContain('cancel_schedule');
    // No phantom "3× tool-failure streak" investigation ticket / consult.
    const reflection = jest.requireMock('./reflection');
    expect(reflection.fileStreakInvestigation).not.toHaveBeenCalled();
    expect(reflection.consultCrossCheckerOnStreak).not.toHaveBeenCalled();
  });

  it('the withheld tool RETURNS the round after the ban', async () => {
    mockExecuteCodingTool.mockResolvedValue(OK_FALSE);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('update_feedback', 1))
      .mockResolvedValueOnce(callTurn('update_feedback', 2))
      .mockResolvedValueOnce(callTurn('update_feedback', 3))
      .mockResolvedValueOnce(callTurn('search_web', 4)) // banned round — model probes differently
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    const round5Call = mockRunModelTurn.mock.calls[4];
    if (round5Call && round5Call[2]) {
      expect(toolNames(round5Call)).toContain('triage_ticket'); // model-facing spelling
    }
  });

  it('run_command is exempt — consecutive failing commands are normal iteration', async () => {
    mockExecuteCodingTool.mockResolvedValue('Tool run_command failed: exit 1');
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('run_command', 1))
      .mockResolvedValueOnce(callTurn('run_command', 2))
      .mockResolvedValueOnce(callTurn('run_command', 3))
      .mockResolvedValueOnce(callTurn('run_command', 4))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(breakerMetrics()).toHaveLength(0);
    // No withhold notice either (the chat profile's schema never carries
    // run_command, so the metric + notice absence is the real exemption pin).
    for (const call of mockRunModelTurn.mock.calls) {
      const msgs = (call?.[1] ?? []) as any[];
      expect(msgs.some((m) => typeof m?.content === 'string' && m.content.includes('ALL FAILED'))).toBe(false);
    }
  });

  it('SECOND trip of the same tool in one run: removed for the REST of the run (perma notice + metric)', async () => {
    mockExecuteCodingTool.mockResolvedValue(OK_FALSE);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('update_feedback', 1))
      .mockResolvedValueOnce(callTurn('update_feedback', 2))
      .mockResolvedValueOnce(callTurn('update_feedback', 3)) // trip #1 → one-round ban
      .mockResolvedValueOnce(callTurn('update_feedback', 4)) // ban expired path: fails again
      .mockResolvedValueOnce(callTurn('update_feedback', 5))
      .mockResolvedValueOnce(callTurn('update_feedback', 6)) // trip #2 → PERMA
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    const metrics = breakerMetrics();
    expect(metrics).toHaveLength(2);
    expect(metrics[0].meta.perma).toBe(false);
    expect(metrics[1].meta.perma).toBe(true);

    // The perma notice reached the model (messages is a shared mutated array —
    // assert on its final content, not per-call snapshots).
    const finalMessages = (mockRunModelTurn.mock.calls.at(-1)?.[1] ?? []) as any[];
    expect(finalMessages.some((m) => typeof m?.content === 'string' && m.content.includes('REMOVED FOR THE REST OF THIS RUN'))).toBe(true);

    // The tools argument IS per-call: the first round offered the tool; every
    // round after trip #2 (call index 6+) excludes it.
    expect(toolNames(mockRunModelTurn.mock.calls[0])).toContain('triage_ticket');
    for (let i = 6; i < mockRunModelTurn.mock.calls.length; i++) {
      const call = mockRunModelTurn.mock.calls[i];
      if (call[2]) expect(toolNames(call)).not.toContain('triage_ticket');
    }
  });

  it('a success between failures resets the streak', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce(OK_FALSE)
      .mockResolvedValueOnce(OK_FALSE)
      .mockResolvedValueOnce('updated ticket ok') // success — streak resets
      .mockResolvedValue(OK_FALSE);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('update_feedback', 1))
      .mockResolvedValueOnce(callTurn('update_feedback', 2))
      .mockResolvedValueOnce(callTurn('update_feedback', 3))
      .mockResolvedValueOnce(callTurn('update_feedback', 4)) // fail #1 of a NEW streak
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(breakerMetrics()).toHaveLength(0);
  });
});

describe('pre-flight fast trip (tool-preflight, 2026-09-09)', () => {
  const INCIDENT_REASONING = 'The parts check finished on the box. I need to search_engine for the SSM invocation output format, then read it. Calling search_engine now.';

  it('ungrounded id + intent mismatch trips the breaker on the FIRST call, without executing the tool; the notice names the intended tool', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn('update_feedback', 1, '{"id":"noop","status":"open"}', INCIDENT_REASONING))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // Never round-tripped to the executor (no DB hit for an invented id).
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
    // Round 2: update_feedback already withheld.
    const round2Tools = toolNames(mockRunModelTurn.mock.calls[1]);
    expect(round2Tools.length).toBeGreaterThan(0);
    expect(round2Tools).not.toContain('triage_ticket');
    // The tool result the model saw is the structured, NOT EXECUTED refusal…
    const round2Messages = mockRunModelTurn.mock.calls[1][1] as any[];
    // RSW-1: the slip-echo prune is ALWAYS ON — this PURE-SLIP turn's record and
    // its refusal envelope are pruned from the replayed transcript, so the
    // refusal itself is asserted on telemetry (below) while the model sees ONE
    // harness notice carrying the same NOT-EXECUTED facts.
    expect(round2Messages.some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(false);
    const slipNotice = round2Messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('SLIP REMOVED'));
    expect(slipNotice).toBeTruthy();
    expect(slipNotice.content).toContain('triage_ticket("noop")');
    expect(slipNotice.content).toContain('did not execute');
    // …and the breaker notice names the tool the reasoning meant.
    expect(round2Messages.some((m) => m.role === 'user' && typeof m.content === 'string'
      && m.content.includes('ALL FAILED') && m.content.includes('named search_engine'))).toBe(true);
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta.intended).toBe('search_engine');
    const preflight = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_preflight');
    expect(preflight).toHaveLength(1);
    expect(preflight[0].meta).toMatchObject({ tool: 'update_feedback', reason: 'ungrounded_id', intended: 'search_engine' });
  });

  it('an ungrounded id ALONE (no intent signal) trips on the second call, not the first', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn('update_feedback', 1, '{"id":"PLACEHOLDER","status":"open"}', ''))
      .mockResolvedValueOnce(derailTurn('update_feedback', 2, '{"id":"BREAKING_NOW","status":"open"}', ''))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
    expect(toolNames(mockRunModelTurn.mock.calls[1])).toContain('triage_ticket'); // still offered after ONE refusal
    expect(toolNames(mockRunModelTurn.mock.calls[2])).not.toContain('triage_ticket'); // withheld after the second
    expect(breakerMetrics()).toHaveLength(1);
  });

  it('a grounded id the model READ this run is executed normally (no refusal, no trip)', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce('[{"id":"tkt_general","title":"non-hex id, known only from this tool result"}]')
      .mockResolvedValueOnce('updated ok');
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn('list_feedback', 1, '{}', ''))
      .mockResolvedValueOnce(derailTurn('update_feedback', 2, '{"id":"tkt_general","status":"in_progress"}', ''))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
    expect(breakerMetrics()).toHaveLength(0);
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_preflight')).toHaveLength(0);
  });

  it('a call to the WITHHELD tool during its ban is refused, not executed', async () => {
    mockExecuteCodingTool.mockResolvedValue(OK_FALSE);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('update_feedback', 1))
      .mockResolvedValueOnce(callTurn('update_feedback', 2))
      .mockResolvedValueOnce(callTurn('update_feedback', 3)) // trip → withheld next round
      .mockResolvedValueOnce(callTurn('update_feedback', 4)) // the decoder ignores the schema and calls it anyway
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);
    const round5Messages = mockRunModelTurn.mock.calls[4][1] as any[];
    // Pure-slip turn ⇒ pruned (RSW-1: slip-echo prune always on). The refusal
    // still fired; the model sees the notice that names the withheld tool.
    expect(round5Messages.some((m) => m.role === 'tool' && m.tool_call_id === 't4')).toBe(false);
    const withheldNotice = round5Messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('SLIP REMOVED'));
    expect(withheldNotice).toBeTruthy();
    expect(withheldNotice.content).toContain('triage_ticket');
    expect(withheldNotice.content).toContain('did not execute');
    // The breaker-withheld HINT rode the pruned envelope, so the refusal's own
    // record is the telemetry row: the call was refused pre-flight, not run.
    const withheldRow = mockRecordLoopMetric.mock.calls.map((c) => c[0])
      .filter((m) => m?.meta?.seam === 'tool_preflight' && m?.meta?.tool === 'update_feedback');
    expect(withheldRow).toHaveLength(1);
    expect(withheldRow[0].meta.reason).toBe('tool_not_offered');
  });
});

// ── N1 terminal state (remediation P1, 2026-09-08): trips on ≥2 DIFFERENT
// tools (or a 3rd trip total) end the run honestly instead of withholding
// forever — completed-with-note, GUARD_STRIKE meta.state 'ended_run'. ────────
describe('N1 — derailment terminal state (run ends after trips on 2 different tools)', () => {
  afterEach(() => {
  });

  /** 3 failing rounds of A (trip 1), then 3 failing rounds of B (trip 2 — a
   *  SECOND tool ⇒ terminal). Chat profile: both platform/account tools are
   *  in the schema. */
  const wireTwoToolDerail = () => {
    mockExecuteCodingTool.mockResolvedValue(OK_FALSE);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('update_feedback', 1))
      .mockResolvedValueOnce(callTurn('update_feedback', 2))
      .mockResolvedValueOnce(callTurn('update_feedback', 3)) // trip #1 (one-round ban)
      .mockResolvedValueOnce(callTurn('update_canvas', 4))
      .mockResolvedValueOnce(callTurn('update_canvas', 5))
      .mockResolvedValueOnce(callTurn('update_canvas', 6)) // trip #2, DIFFERENT tool ⇒ run ends
      .mockResolvedValue(FINAL);
  };

  it('ends the run as completed-with-note: harness note is the finalText, no more model turns, not modelErrored', async () => {
    wireTwoToolDerail();
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The loop stopped at the terminal trip — the FINAL mock was never reached.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(6);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (2 episodes');
    expect(result.finalText).toContain('The next scheduled firing starts fresh.');
    // Completed-with-note, never a provider failure: the executor finalizes
    // 'completed' and the journal records finalText verbatim.
    expect(result.modelErrored).toBeUndefined();
    // The note is a visible harness callout in the parts AND on the live stream.
    const notePart = result.parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith('[HARNESS] Run ended'));
    expect(notePart).toBeDefined();
    expect(notePart!.marker).toBe('guard');
    const guardEmits = (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'guard_marker').map((c) => c[1]);
    expect(guardEmits.some((e) => String(e.text).startsWith('[HARNESS] Run ended'))).toBe(true);
    // Telemetry: trip #1 is a normal breaker row; the terminal trip carries
    // state 'ended_run' with the run-level tallies.
    const metrics = breakerMetrics();
    expect(metrics).toHaveLength(2);
    expect(metrics[0].meta.state).toBeUndefined();
    expect(metrics[1].meta).toMatchObject({
      seam: 'tool_derail_break', state: 'ended_run', tool: 'update_canvas',
      trips: 2, tools: ['update_feedback', 'update_canvas'],
    });
  });

  it('the end-note names the intended tool when the pre-flight detected one', async () => {
    mockExecuteCodingTool.mockResolvedValue(OK_FALSE);
    const REASONING = 'I actually need to search_engine for the docs before updating anything. Calling search_engine now.';
    mockRunModelTurn
      // Fast-trip #1: ungrounded id + intent mismatch ⇒ trip on the FIRST call.
      .mockResolvedValueOnce(derailTurn('update_feedback', 1, '{"id":"noop","status":"open"}', REASONING))
      // Second tool derails DURING tool #1's one-round ban (a new trip cannot
      // start while a ban is in flight — pre-existing breaker semantics)…
      .mockResolvedValueOnce(derailTurn('update_canvas', 2, '{"id":"BREAKING_NOW","content":"x"}', REASONING))
      // …and fast-trips the round after the ban expires ⇒ terminal.
      .mockResolvedValueOnce(derailTurn('update_canvas', 3, '{"id":"RUN_CMD_NEXT_CALL","content":"x"}', REASONING))
      .mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput());

    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    expect(result.finalText).toContain('intended tool appears to be search_engine');
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta.intended).toBe('search_engine');
  });

  it('2 trips on the SAME tool (perma) do NOT end the run — the terminal state needs a second tool or a 3rd trip', async () => {
    mockExecuteCodingTool.mockResolvedValue(OK_FALSE);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('update_feedback', 1))
      .mockResolvedValueOnce(callTurn('update_feedback', 2))
      .mockResolvedValueOnce(callTurn('update_feedback', 3)) // trip #1
      .mockResolvedValueOnce(callTurn('update_feedback', 4))
      .mockResolvedValueOnce(callTurn('update_feedback', 5))
      .mockResolvedValueOnce(callTurn('update_feedback', 6)) // trip #2 same tool → perma, run continues
      .mockResolvedValue(FINAL);
    const result = await runCodingAgent(makeInput());

    expect(result.finalText).toBe('Done.'); // the model got its post-perma turn
    expect(breakerMetrics().every((m) => m.meta.state !== 'ended_run')).toBe(true);
  });

  it('RUN-END parity (2026-09-10): the terminal branch files exactly ONE attribution ticket and SKIPS the consult (the run is ending)', async () => {
    wireTwoToolDerail();
    await runCodingAgent(makeInput());

    const reflection = jest.requireMock('./reflection');
    // Trip #1 (withheld branch) files for update_feedback; the terminal branch
    // files exactly one more for the tool that ended the run.
    const ticketEvidence = reflection.fileStreakInvestigation.mock.calls
      .map((c: any[]) => c[0])
      .filter((ev: any) => ev?.tool === 'update_canvas');
    expect(ticketEvidence).toHaveLength(1);
    expect(ticketEvidence[0]).toMatchObject({ sessionId: 'sess-derail-1', tool: 'update_canvas', perma: false });
    // The trip's own captured failure texts ride the ticket.
    expect(ticketEvidence[0].recentFailures.length).toBeGreaterThan(0);
    expect(ticketEvidence[0].recentFailures[0]).toContain('ticket_not_found');
    // No consult at run end — the NEXT firing benefits from the ticket.
    const consultTools = reflection.consultCrossCheckerOnStreak.mock.calls.map((c: any[]) => c[0]?.tool);
    expect(consultTools).not.toContain('update_canvas');
  });

});

describe('progressive tool disclosure — coding lane (load_tool_group)', () => {
  const codingInput = (): AgentRunInput => ({ ...makeInput(), profile: CODING_TEST_PROFILE });

  it('coding runs start WITHOUT the account tools and WITH load_tool_group; loading adds the group and retires the meta-tool', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn('load_tool_group', 1, '{"group":"account"}', ''))
      .mockResolvedValue(FINAL);
    await runCodingAgent(codingInput());

    const round1 = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(round1).toContain('load_tool_group');
    expect(round1).toContain('triage_ticket'); // core platform tool stays (the ticket lane needs it) — model-facing spelling
    expect(round1).not.toContain('update_canvas');
    expect(round1).not.toContain('notify_user');

    const round2 = toolNames(mockRunModelTurn.mock.calls[1]);
    expect(round2).toContain('update_canvas');
    expect(round2).toContain('notify_user');
    expect(round2).not.toContain('load_tool_group');

    const round2Messages = mockRunModelTurn.mock.calls[1][1] as any[];
    const loadResult = round2Messages.find((m) => m.role === 'tool' && m.tool_call_id === 't1');
    expect(JSON.parse(loadResult.content)).toMatchObject({ ok: true, group: 'account' });
    expect(JSON.parse(loadResult.content).loaded).toContain('update_canvas');
    expect(mockExecuteCodingTool).not.toHaveBeenCalled(); // handled in the loop, never dispatched
  });

  it('calling an unloaded account tool is refused with a pointer to load_tool_group, and never executes', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn('update_canvas', 1, '{"id":"deadbeef-1","content":"x"}', ''))
      .mockResolvedValue(FINAL);
    await runCodingAgent(codingInput());

    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
    const round2Messages = mockRunModelTurn.mock.calls[1][1] as any[];
    // Pure-slip turn ⇒ pruned (RSW-1: slip-echo prune always on); the notice
    // keeps the facility answer the refusal carried (where the group lives).
    expect(round2Messages.some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(false);
    const refusedNotice = round2Messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('SLIP REMOVED'));
    expect(refusedNotice).toBeTruthy();
    expect(refusedNotice.content).toContain('update_canvas');
    expect(refusedNotice.content).toContain('did not execute');
    // The refusal's facility hint ("call load_tool_group({group:\"account\"})")
    // rode the pruned envelope; the refusal itself is the telemetry record.
    const refusedRow = mockRecordLoopMetric.mock.calls.map((c) => c[0])
      .filter((m) => m?.meta?.seam === 'tool_preflight' && m?.meta?.tool === 'update_canvas');
    expect(refusedRow).toHaveLength(1);
    expect(refusedRow[0].meta.reason).toBe('tool_not_offered');
  });

  it('chat runs keep the account tools loaded and never see load_tool_group', async () => {
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    const round1 = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(round1).toContain('update_canvas');
    expect(round1).not.toContain('load_tool_group');
  });
});
