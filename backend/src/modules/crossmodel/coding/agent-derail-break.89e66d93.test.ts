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
 * Replay pin — ticket 89e66d93 (mishap, breaker trip 2026-09-20T02:31:56Z,
 * session 1b30452f-d4eb-4dde-98d0-f63a95e31a65 "Ticket B9cb221b
 * Investigation", run 44466c6c-977e-44a6-a9be-6b7ea900248a, auto-filed).
 *
 * THE INCIDENT: the investigation lane fell into a ~25-turn emission fumble
 * loop (its own transcript row dffc26b6 narrates "Breaking the loop —
 * exactly two calls: read_file and grep" on repeat) and emitted ONE
 * malformed tool call: update_feedback({id:"nonexistent"}) — a placeholder
 * where a ticket id belongs — while its reasoning named grep. The lane
 * admitted it in-band: "My error — that was a malformed call (I meant to
 * invoke grep next, not update_feedback with a placeholder)". The
 * deterministic tool pre-flight refused the call WITHOUT executing it:
 *   {"ok":false,"tool":"update_feedback","reason":"ungrounded_id",
 *    "rejected":[{"key":"id","value":"nonexistent"}],
 *    "message":"NOT EXECUTED: update_feedback was called with
 *    id=\"nonexistent\", which is not an id you obtained this run — …
 *    Your reasoning named grep — you evidently meant to call grep; call it
 *    now with its real parameters."}
 * and the breaker fast-tripped: 1 (base failure) + 1 (ungrounded id — "an
 * invented id is never real work", agent.ts:2909) + 1 (intent mismatch —
 * the reasoning named a DIFFERENT offered tool, agent.ts:2910) = 3 →
 * one-round withhold + exactly ONE auto-filed investigation ticket whose
 * title says "3×" with exactly ONE failure text attached — the
 * trip-THRESHOLD branding plus fast-trip weights, not three real failures.
 *
 * ADJUDICATION (dispatch lane, 2026-09-20): MODEL behavior, framework
 * working AS DESIGNED at every deterministic seam — the same class as
 * f95bd4c8 (update_canvas placeholder, 2026-09-14) and 03e8cd3d, and the
 * probe-vs-derail twin of ea69c94e (adjudicated 2026-09-19). The intent
 * redirect was truthful (the lane really meant grep — its own words), the
 * conviction has no false-positive path for a real ticket id (uuids pass
 * ID_SHAPE_RE; any verbatim-read id passes the haystack), and the
 * auto-filer filed ONE deduped ticket. git log on tool-preflight.ts /
 * agent.ts shows NO framework change between ea69c94e's adjudication
 * (2026-09-19) and this streak (2026-09-20T02:31Z) — not a regression.
 *
 * NO platform code change for the streak itself: this pin locks the
 * intended behavior for THIS incident's verbatim envelope (the placeholder
 * conviction on the FIRST call, the grep redirect, the 1+1+1 fast trip
 * with ONE failure text, ONE deduped ticket) by replaying the incident
 * end-to-end through the real agent loop (the REAL preflight + breaker
 * run; only the model, the tool executor, and the streak consult/filing
 * are mocked). Scaffold mirrors agent-derail-break.f95bd4c8.
 *
 * Sister ticket d2c2744b (same batch — the machine-mutation gate's refusal
 * text for a not-found ticket id) is pinned by
 * platform/platform-tools.update-feedback-gate.d2c2744b.test.ts.
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
  reapOrphanedBuildProcesses: jest.fn(async () => 0),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}), captureVerifyFingerprint: jest.fn(async () => null) }));
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
  // The incident lane was a CODING session — only kind:'coding' gets the FULL
  // schema (agent.ts:926-931); a chat-kind profile is filtered to
  // CHAT_ORCH_TOOLS, which does NOT include grep, and detectIntendedTool only
  // recognizes OFFERED tools — so the replay must run as coding-kind for the
  // grep redirect to fire.
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: false,
  memorySource: 'chat',
};

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-89e66d93-test',
  sessionId: 'sess-89e66d93',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'investigate ticket b9cb221b (one-shot schedule skipped mid-run)',
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

/** The incident's reasoning shape: it names grep (a real, offered coding
 *  tool) and NEVER names update_feedback. */
const INCIDENT_REASONING =
  'I keep fumbling the emission — breaking the loop now: locating the stale '
  + 'tool-doc text with grep across backend/src, then reading the real section.';

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 89e66d93 replay — update_feedback({id:"nonexistent"}) fumbled-call derail', () => {
  it('REPLAY: the preflight refuses WITHOUT executing, names grep, fast-trips 1+1+1 on the FIRST call, files ONE ticket with ONE failure text', async () => {
    mockRunModelTurn
      // Round 1: THE DERAIL — the placeholder "nonexistent" where a ticket id
      // belongs, while the reasoning says grep (update_feedback is a platform
      // tool, offered directly — no load_tool_group needed).
      .mockResolvedValueOnce(derailTurn('update_feedback', 1, '{"id":"nonexistent","status":"in_progress","adminNote":"auditing"}', INCIDENT_REASONING))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // 1. Never round-tripped to the executor — no DB hit for an invented id.
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();

    // 2. The tool result the model saw is the ticket's verbatim refusal
    //    envelope: ungrounded_id, the rejected id="nonexistent", NOT EXECUTED,
    //    and the redirect naming grep.
    const round2Messages = mockRunModelTurn.mock.calls[1][1] as any[];
    // RSW-1: the slip-echo prune is ALWAYS ON now — this PURE-SLIP turn's
    // record and refusal are pruned in favour of ONE harness notice (the
    // pre-flight refusal still fired; see the metrics assertions below).
    expect(round2Messages.some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(false);
    const notice = round2Messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('SLIP REMOVED'));
    expect(notice).toBeTruthy();
    expect(notice.content).toContain('triage_ticket("nonexistent")');
    expect(notice.content).toContain('the id was a placeholder, not an id any tool returned this run');
    expect(notice.content).toContain('Your reasoning named grep');

    // 3. Fast trip on the FIRST derailed call (1 base + 1 ungrounded + 1
    //    intended = 3): update_feedback is withheld from the very next
    //    round's schema…
    const round2Tools = toolNames(mockRunModelTurn.mock.calls[1]);
    expect(round2Tools.length).toBeGreaterThan(0);
    expect(round2Tools).not.toContain('update_feedback');
    //    …and the breaker notice names the tool the reasoning meant.
    expect(round2Messages.some((m) => m.role === 'user' && typeof m.content === 'string'
      && m.content.includes('ALL FAILED') && m.content.includes('named grep'))).toBe(true);

    // 4. Telemetry: one preflight guard_strike + one breaker trip, both
    //    naming update_feedback and the intended grep.
    expect(preflightMetrics()).toHaveLength(1);
    expect(preflightMetrics()[0].meta).toMatchObject({ tool: 'update_feedback', reason: 'ungrounded_id', intended: 'grep' });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta.tool).toBe('update_feedback');

    // 5. Exactly ONE investigation ticket filed at the trip (the ticket this
    //    pin replays) — carrying EXACTLY ONE failure text: the "3×" in the
    //    auto-filed title is the trip threshold plus the ungrounded+intended
    //    fast-trip weights, never three real failures.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    expect(mockFileStreakInvestigation.mock.calls[0][0]).toMatchObject({ tool: 'update_feedback', intended: 'grep' });
    expect(mockFileStreakInvestigation.mock.calls[0][0].recentFailures).toHaveLength(1);
    expect(mockFileStreakInvestigation.mock.calls[0][0].recentFailures.join('\n')).toContain('ungrounded_id');
    expect(mockFileStreakInvestigation.mock.calls[0][0].recentFailures.join('\n')).toContain('nonexistent');
  });

  it('CONTROL (no overreach): a REAL ticket id read this run executes normally — no refusal, no trip, no ticket', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce('[{"id":"89e66d93-71cb-4816-9334-de6109bcbbd4","title":"Ticket B9cb221b Investigation"}]') // list_feedback
      .mockResolvedValueOnce('Updated feedback ticket 89e66d93-71cb-4816-9334-de6109bcbbd4: status=in_progress, priority=0.'); // update_feedback
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn('list_feedback', 1, '{"limit":5}', ''))
      .mockResolvedValueOnce(derailTurn('update_feedback', 2, '{"id":"89e66d93-71cb-4816-9334-de6109bcbbd4","status":"in_progress"}', ''))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
    expect(preflightMetrics().filter((m) => m.meta.tool === 'update_feedback')).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });
});
