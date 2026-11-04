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
 * Replay pin — ticket f95bd4c8 (mishap, breaker trip 2026-09-14, session
 * cec340f2-f605-4370-b87a-d85b59cb243f "Re-Send Path C Phase 2 Kickoff",
 * run 53f24b04-21d1-4c84-bd61-478f34b29915, auto-filed 05:06:52Z).
 *
 * THE INCIDENT: the Path-C lane decoder-locked on update_canvas and emitted
 * `update_canvas({canvasId:"noop-audit-placeholder"})` — a self-describing
 * narration token where an entity id belongs — while its own reasoning said
 * it was calling get_account_overview. The deterministic tool pre-flight
 * (tool-preflight.ts, built 2026-09-09 for EXACTLY this derailment class —
 * its header names THIS session's id, "CanLaw cec340f2", as one of the
 * origin incidents) refused the call WITHOUT executing it:
 *   {"ok":false,"tool":"update_canvas","reason":"ungrounded_id",
 *    "rejected":[{"key":"canvasId","value":"noop-audit-placeholder"}],
 *    "message":"NOT EXECUTED: update_canvas was called with
 *    canvasId=\"noop-audit-placeholder\", which is not an id you obtained
 *    this run — … Your reasoning named get_account_overview — you evidently
 *    meant to call get_account_overview; call it now with its real
 *    parameters."}
 * and the breaker fast-tripped (ungrounded id + intent mismatch) → one-round
 * withhold + exactly ONE auto-filed investigation ticket (this one).
 *
 * ADJUDICATION (this lane, 2026-09-14): MODEL behavior, framework working AS
 * DESIGNED at every deterministic seam:
 *   - The conviction is correct and has NO false-positive path:
 *     "noop-audit-placeholder" fails ID_SHAPE_RE (/^[0-9a-f]{8}/i) and never
 *     appeared in text the lane had read (groundingHaystack covers system +
 *     user + tool results). A REAL canvas id can never be convicted:
 *     CanvasDocument.id is `String @id @default(uuid())` (schema.prisma) —
 *     uuids pass the shape check unconditionally — and even a non-hex id
 *     seen verbatim in a prior tool result passes the haystack check.
 *   - The intent redirect is truthful: detectIntendedTool requires a
 *     whole-word mention of another offered tool and zero mentions of the
 *     called tool; the refusal named get_account_overview — exactly what the
 *     lane's own reasoning named (per the ticket's failure text).
 *   - git log on tool-preflight.ts: two commits only (f356e14a7 2026-09-09
 *     the preflight build; a59b35691 2026-09-12 a message-only chatId
 *     recovery hint, c5615f58) — NO framework change between 2026-09-12 and
 *     this streak (2026-09-14T05:06Z). The envelope shape is pin-locked by
 *     tool-preflight.c5615f58.test.ts. Not a regression.
 *   - The ticket title is reflection.ts fileStreakInvestigation's constant
 *     template ("3× tool-failure streak: <tool> on \"<chat>\" — framework or
 *     model?") — "3×" is the breaker's trip-THRESHOLD branding, not a call
 *     count; the auto-filer fired as designed and filed ONE deduped ticket.
 *   - Same-day precedent: ticket 03e8cd3d (auto-filed 00:39:54Z, session
 *     e083ff2e, update_canvas({canvasId:"noop"}), intended get_chat_messages)
 *     was adjudicated identically — MODEL behavior, framework as designed —
 *     and its pin (agent-derail-break.03e8cd3d.test.ts) is merged on main.
 * NO platform code change: this pin locks the intended behavior for THIS
 * incident's verbatim envelope (the placeholder conviction on the FIRST
 * call, the get_account_overview redirect, the fast trip, ONE deduped
 * ticket) so a future "fix" cannot weaken the conviction — while replaying
 * the incident end-to-end through the real agent loop (the REAL preflight +
 * breaker run; only the model, the tool executor, and the streak
 * consult/filing are mocked). Scaffold mirrors agent-derail-break.03e8cd3d.
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
  worktree: '/tmp/derail-f95bd4c8-test',
  sessionId: 'sess-f95bd4c8',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'kick off phase 2 of the re-send path C work',
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

/** The incident's reasoning shape: it names get_account_overview (a real,
 *  offered account tool) and NEVER names update_canvas. */
const INCIDENT_REASONING =
  'The Phase 2 kickoff summary should land on the program canvas, but I have not pulled '
  + 'the account state yet — calling get_account_overview now with its real parameters, '
  + 'then I write the kickoff note.';

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket f95bd4c8 replay — update_canvas({canvasId:"noop-audit-placeholder"}) placeholder-id derail', () => {
  it('REPLAY: the preflight refuses WITHOUT executing, names get_account_overview, fast-trips the breaker, files ONE ticket', async () => {
    mockRunModelTurn
      // Round 1: the lane loads the account group (the incident run had
      // update_canvas offered — it is an account tool, load_tool_group-gated).
      .mockResolvedValueOnce(derailTurn('load_tool_group', 1, '{"group":"account"}', ''))
      // Round 2: THE DERAIL — the narration token "noop-audit-placeholder"
      // where a canvasId belongs, while the reasoning says get_account_overview.
      .mockResolvedValueOnce(derailTurn('update_canvas', 2, '{"canvasId":"noop-audit-placeholder","markdown":"phase 2 kickoff"}', INCIDENT_REASONING))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // 1. Never round-tripped to the executor — no DB hit for an invented id
    //    (load_tool_group is answered inline by the preflight too).
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();

    // 2. The tool result the model saw is the ticket's verbatim refusal
    //    envelope: ungrounded_id, the rejected canvasId="noop-audit-placeholder",
    //    NOT EXECUTED, and the redirect naming get_account_overview.
    const round3Messages = mockRunModelTurn.mock.calls[2][1] as any[];
    // RSW-1: the slip-echo prune is ALWAYS ON now — a PURE-SLIP turn's record
    // and refusal are pruned from the replayed transcript in favour of ONE
    // harness notice (the pre-flight refusal still fired; see telemetry below).
    expect(round3Messages.some((m) => m.role === 'tool' && m.tool_call_id === 't2')).toBe(false);
    const notice = round3Messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('SLIP REMOVED'));
    expect(notice).toBeTruthy();
    expect(notice.content).toContain('update_canvas("noop-audit-placeholder")');
    expect(notice.content).toContain('the id was a placeholder, not an id any tool returned this run');
    expect(notice.content).toContain('get_account_overview');

    // 3. Fast trip on the FIRST derailed call (ungrounded + intent mismatch):
    //    update_canvas is withheld from the very next round's schema…
    const round3Tools = toolNames(mockRunModelTurn.mock.calls[2]);
    expect(round3Tools.length).toBeGreaterThan(0);
    expect(round3Tools).not.toContain('update_canvas');
    //    …and the breaker notice names the tool the reasoning meant.
    expect(round3Messages.some((m) => m.role === 'user' && typeof m.content === 'string'
      && m.content.includes('ALL FAILED') && m.content.includes('named get_account_overview'))).toBe(true);

    // 4. Telemetry: one preflight guard_strike + one breaker trip, both
    //    naming update_canvas and the intended get_account_overview.
    expect(preflightMetrics()).toHaveLength(1);
    expect(preflightMetrics()[0].meta).toMatchObject({ tool: 'update_canvas', reason: 'ungrounded_id', intended: 'get_account_overview' });
    expect(breakerMetrics()).toHaveLength(1);
    expect(breakerMetrics()[0].meta.tool).toBe('update_canvas');

    // 5. Exactly ONE investigation ticket filed at the trip (the ticket this
    //    pin replays), carrying the tool, the intent, and the refusal text.
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    expect(mockFileStreakInvestigation.mock.calls[0][0]).toMatchObject({ tool: 'update_canvas', intended: 'get_account_overview' });
    expect(mockFileStreakInvestigation.mock.calls[0][0].recentFailures.join('\n')).toContain('ungrounded_id');
    expect(mockFileStreakInvestigation.mock.calls[0][0].recentFailures.join('\n')).toContain('noop-audit-placeholder');
  });

  it('CONTROL (no overreach): a REAL canvas id read this run executes normally — no refusal, no trip, no ticket', async () => {
    mockExecuteCodingTool
      .mockResolvedValueOnce('[{"id":"7c2e9a41-3b5d-4f6a-8c1e-9d0b2a4f6e8c","title":"Re-Send Path C"}]') // list_canvases
      .mockResolvedValueOnce('Canvas updated (version 2).'); // update_canvas
    mockRunModelTurn
      .mockResolvedValueOnce(derailTurn('load_tool_group', 1, '{"group":"account"}', ''))
      .mockResolvedValueOnce(derailTurn('list_canvases', 2, '{}', ''))
      .mockResolvedValueOnce(derailTurn('update_canvas', 3, '{"canvasId":"7c2e9a41-3b5d-4f6a-8c1e-9d0b2a4f6e8c","markdown":"ok"}', ''))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(2);
    expect(preflightMetrics().filter((m) => m.meta.tool === 'update_canvas')).toHaveLength(0);
    expect(breakerMetrics()).toHaveLength(0);
    expect(mockFileStreakInvestigation).not.toHaveBeenCalled();
  });
});
