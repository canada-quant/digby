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
 * Replay pin — ticket 0c0ce759 (mishap, auto-filed 2026-09-20T08:58:34Z at
 * breaker trip; incident lane 28de72e5-46c5-4a90-811d-840184efc106 "GLM-5.3
 * Deployment on Dual Sparks", spark-clusters, coding seat kimi-k3, recurring
 * PP-EAGER window-watch schedule, firing 1/13; run
 * f9095abd-6848-4f93-9399-d52400e431fc, trigger 08:52:12Z).
 *
 * THE INCIDENT (reconstructed from the guard_strike loop_metrics rows of run
 * f9095abd — every timestamp/meta below is a verbatim telemetry row):
 *   08:52:53 + 08:53:06  tool_preflight  update_feedback  reason=ungrounded_id
 *   08:53:11             tool_derail_break update_feedback perma:false (TRIP 1)
 *   08:53:37 + 08:53:53  tool_preflight  update_feedback  reason=ungrounded_id
 *   08:54:41             tool_derail_break update_feedback perma:true  (TRIP 2)
 *   08:55:06 + 08:57:30  tool_repeat_break update_supervisor_state (sibling
 *                        seam, trips 1→2 — the repeat breaker, NOT replayed here)
 *   08:58:34             tool_derail_break update_document state=ended_run
 *                        tools=["update_feedback","update_document"] trips=3
 *                        intended="get_chat_messages"
 * The run ended completed-with-note (assistant row 1722257e): "[HARNESS] Run
 * ended: repeated wrong-tool derailment (3 episodes; intended tool appears to
 * be get_chat_messages). The next scheduled firing starts fresh." The
 * auto-filed ticket carries the update_document streak's exact failure texts:
 *   · No generated file with id probe belongs to this user. Call list_files …
 *   · No generated file with id probe belongs to this user. Call list_files …
 *
 * EPISODE ARITHMETIC (pinned here; agent.ts:3196-3225):
 *   - update_feedback emissions carried a ticket id that appeared NOWHERE in
 *     the prompt or narration → the REAL ungrounded-id preflight
 *     (agent.ts:2194, PLATFORM_TOOL_NAMES only) refused pre-execution. Each
 *     refusal is failure-shaped (+1) and ungrounded (+1): weight 2/emission →
 *     two emissions = streak 4 ≥ 3 ⇒ a trip. Two pairs ⇒ trips {uf: 2}
 *     (one-round ban, then perma-lock).
 *   - update_document emissions carried the MODEL-AUTHORED placeholder fileId
 *     'probe' narrated VERBATIM — grounded by construction (the 00667344
 *     echo: the preflight validates occurrence, never existence) → executed
 *     into the document seam's existence refusal: failure (+1) plus intent
 *     mismatch (+1 — the narration named get_chat_messages): weight
 *     2/emission → two emissions ⇒ trip {ud: 1}.
 *   - Trip tallies {update_feedback: 2, update_document: 1}: size ≥ 2 AND
 *     total ≥ 3 (agent.ts:3252) ⇒ ended_run at the update_document trip.
 *
 * VERDICT (the ticket's mandated INVESTIGATE): MODEL BEHAVIOR — the kimi-k3
 * placeholder-emission / wrong-tool derail class (718a04a5, f839cede,
 * aff1c189, cbc5be24, 83297404, 0aecbe92…), NOT a deterministic framework
 * defect. Every deterministic seam behaved as designed: the ungrounded-id
 * preflight refused the fabricated ticket ids before any mutation could
 * execute (zero update_feedback executions all run), the narrated 'probe'
 * placeholder executed into a HARMLESS existence refusal whose envelope is
 * failure-shaped since 27e3a5fd (718a04a5 — before that, this loop read as
 * SUCCESS to the streak counter), the intent preflight named
 * get_chat_messages, and the terminal state ended the run honestly. The next
 * firing (09:07Z) ran the same watch cleanly. NO framework code change —
 * this file is the mishap's replay pin (the ticket-closure evidence).
 *
 * These tests pin: both incident envelopes are failure-shaped; the intent
 * preflight names get_chat_messages on the document emissions and nothing on
 * the ticket ones; the {uf:2, ud:1} trip sequence ends the run with the
 * EXACT incident note (3 episodes, intended get_chat_messages, next-firing
 * line), completed-with-note semantics, guard-marked part + emit, ended_run
 * telemetry with the incident's meta, ZERO update_feedback executions (every
 * one refused pre-flight), exactly two document-seam executions both with
 * fileId 'probe', and the auto-filing carrying the ticket's verbatim failure
 * texts. Scaffold mirrors agent-derail-break.0aecbe92.test.ts.
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

// Safety net: update_feedback must NEVER execute in this replay — the real
// ungrounded-id preflight refuses all four emissions. If that seam ever
// regresses, the calls land here and the ToolCache-assertions below fail.
const EVIDENCE_REQUIRED = (ticketId: string) => JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'evidence_required',
  ticketId,
  message: `refused: ${ticketId}`,
}, null, 1);
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_feedback') return EVIDENCE_REQUIRED(String(args?.id ?? ''));
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document seam: update_document dispatches via ctx.toolCache
// (WEB_TOOL_NAMES = TOOL_DEFINITIONS names, agent.ts:304). Keep the REAL
// TOOL_DEFINITIONS; stub only the executor — the incident's existence-refusal
// envelope verbatim (0c0ce759's filed failure texts).
const UD_ENVELOPE = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_document' || name === 'read_document' || name === 'fill_pdf_form') {
    const id = String(args?.fileId ?? args?.documentId ?? '');
    return UD_ENVELOPE(id);
  }
  if (name === 'update_feedback') return EVIDENCE_REQUIRED(String(args?.id ?? ''));
  return 'probe result: ok';
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
import { looksLikeToolFailure } from './learnings-index.service';
import { detectIntendedTool, ungroundedIdRefusal } from './tool-preflight';

/** CODING profile: the platform + document tools are in the offered schema —
 *  the incident's intended tool (get_chat_messages) must be offerable for the
 *  intent-mismatch preflight to name it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

/** The fabricated ticket id the incident's update_feedback emissions carried —
 *  a NON-HEX placeholder string: the ungrounded-id preflight (tool-preflight.ts
 *  findUngroundedIdArgs) skips any value SHAPED like an id (/^[0-9a-f]{8}/) —
 *  the incident's four tool_preflight ungrounded_id strikes therefore prove the
 *  id was a placeholder word, absent from the prompt and every narration ⇒
 *  refused pre-execution. ('the-stale-ticket' stands in for the unknown exact
 *  string; the filed ticket names only the count.) */
const UNGROUNDED_TICKET = 'the-stale-ticket';
const BRIEF = [
  'PP-EAGER WINDOW WATCH — firing 1/13.',
  'STEP 1: fresh transcript read — classify CASE A / B / C / D — get_chat_messages(limit 20) — END word after dark-start?',
  'STEP 2: If CASE B: one-line exit, zero fleet calls. If CASE A/C: restore-3b (search_memory first), ALL_LEGS_GREEN + ROUTE.',
].join('\n');

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-0c0ce759-test',
  sessionId: 'sess-0c0ce759',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

/** A wrong-tool emission: update_feedback with a fabricated, ungrounded ticket
 *  id. TWO mechanics pinned by the production telemetry and reproduced here:
 *  (1) the id is a NON-HEX placeholder word — findUngroundedIdArgs skips
 *  id-shaped values (/^[0-9a-f]{8}/), so the incident's four strikes prove a
 *  placeholder word; (2) EACH emission carried a FRESH placeholder — a refused
 *  refusal echoes the rejected arg into the tool result, and groundingHaystack
 *  includes tool results, so a REPEATED id is grounded-by-occurrence from its
 *  first refusal on (the replay's first draft missed this and the arithmetic
 *  collapsed to 2 episodes). The narration names NO offered tool — the
 *  incident's intent weight on the ticket emissions came from the ungrounded
 *  fast-trip alone (+1 failure +1 ungrounded = 2/emission; telemetry: two
 *  preflight strikes per trip). */
const FAKE_TICKET_IDS = ['the-stale-ticket', 'ticket-id', 'old-ticket-id', 'the-watch-ticket'];
const ufTurn = (n: number, id: string) => ({
  content: '',
  reasoning: 'Closing the stale watch ticket first so the board stops re-surfacing it.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id, status: 'done', adminNote: 'window lapsed' }) }],
  finishReason: 'tool_calls',
});
/** The ban-round probe: a legitimate, succeeding plan touch. */
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
/** A wrong-tool emission into the document seam with the model-authored
 *  placeholder fileId 'probe' — narrated VERBATIM (grounded by construction,
 *  the 00667344 echo) so the call EXECUTES into the existence refusal, while
 *  the narration announces the transcript read (the 0c0ce759 shape:
 *  "lane's reasoning named get_chat_messages"). */
const udTurn = (n: number) => ({
  content: '',
  reasoning: 'get_chat_messages can wait one beat — refresh the generated file probe with the window classification first.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: 'probe', content: 'window classification' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Watch done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** The f9095abd episode sequence per the telemetry: four ungrounded
 *  update_feedback emissions with FRESH placeholder ids (trip 1 = one-round
 *  ban, ban-round probe, trip 2 = perma), then the document seam trips the
 *  run into the terminal state at the 3rd episode. */
const wireFiring = () => {
  mockRunModelTurn
    .mockResolvedValueOnce(ufTurn(1, FAKE_TICKET_IDS[0])) // preflight refusal — count 2
    .mockResolvedValueOnce(ufTurn(2, FAKE_TICKET_IDS[1])) // count 4 ⇒ TRIP 1 (one-round ban)
    .mockResolvedValueOnce(planTurn(3)) // ban round — harmless success
    .mockResolvedValueOnce(ufTurn(4, FAKE_TICKET_IDS[2])) // count 2
    .mockResolvedValueOnce(ufTurn(5, FAKE_TICKET_IDS[3])) // count 4 ⇒ TRIP 2 (perma on update_feedback)
    .mockResolvedValueOnce(udTurn(6)) // existence refusal + intent — count 2
    .mockResolvedValueOnce(udTurn(7)) // count 4 ⇒ TRIP 3 ⇒ TERMINAL
    .mockResolvedValue(FINAL);
};

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 0c0ce759 — kimi-k3 placeholder/wrong-tool derail on the PP-EAGER watch (get_chat_messages never emitted)', () => {
  it('UNIT: both incident envelopes are failure-shaped; the intent preflight names get_chat_messages only on the document emissions', () => {
    // The filed update_document envelope (ticket text verbatim) is failure-shaped.
    expect(looksLikeToolFailure(UD_ENVELOPE('probe'))).toBe(true);
    // The REAL ungrounded-id preflight refusal is failure-shaped too — that is
    // what let the four refused update_feedback emissions feed the streak.
    expect(looksLikeToolFailure(ungroundedIdRefusal('update_feedback', [{ key: 'id', value: UNGROUNDED_TICKET }], null))).toBe(true);
    // Intent: the document narration names the transcript tool; the ticket
    // narration names nothing offered.
    const offered = ['get_chat_messages', 'update_feedback', 'update_document', 'run_command'];
    expect(detectIntendedTool(udTurn(6).reasoning, 'update_document', offered)).toBe('get_chat_messages');
    expect(detectIntendedTool(ufTurn(1, FAKE_TICKET_IDS[0]).reasoning, 'update_feedback', offered)).toBeNull();
    // Sanity: faithful narration (naming the called tool) convicts nothing.
    expect(detectIntendedTool('Calling update_feedback now with the real id.', 'update_feedback', offered)).toBeNull();
  });

  it('REPLAY run f9095abd: {update_feedback:2, update_document:1} trips end the run with the EXACT incident note — 3 episodes, intended get_chat_messages, zero ticket mutations', async () => {
    wireFiring();
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The loop stopped at the terminal trip — the FINAL mock was never reached.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(7);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes');
    expect(result.finalText).toContain('intended tool appears to be get_chat_messages');
    expect(result.finalText).toContain('The next scheduled firing starts fresh.');
    // Completed-with-note, never a provider failure.
    expect(result.modelErrored).toBeUndefined();
    const notePart = result.parts.find((p) => p.type === 'text' && typeof p.text === 'string' && p.text.startsWith('[HARNESS] Run ended'));
    expect(notePart).toBeDefined();
    expect(notePart!.marker).toBe('guard');
    const guardEmits = (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'guard_marker').map((c) => c[1]);
    expect(guardEmits.some((e) => String(e.text).startsWith('[HARNESS] Run ended'))).toBe(true);

    // Telemetry: the terminal row carries ended_run + the incident's meta
    // (08:58:34Z row verbatim: tool update_document, trips 3, both tools
    // named, intended get_chat_messages).
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'update_document', trips: 3, intended: 'get_chat_messages' });
    expect(ended!.meta.tools).toEqual(expect.arrayContaining(['update_feedback', 'update_document']));

    // The preflight did its job: update_feedback NEVER executed — all four
    // emissions were refused pre-flight on the fabricated id, producing the
    // incident's exact four tool_preflight ungrounded_id strikes.
    const preflightStrikes = mockRecordLoopMetric.mock.calls
      .map((c) => c[0]?.meta)
      .filter((m) => m?.seam === 'tool_preflight' && m?.reason === 'ungrounded_id' && m?.tool === 'update_feedback');
    expect(preflightStrikes).toHaveLength(4);
    expect(mockToolCacheExec.mock.calls.some((c) => c[0] === 'update_feedback')).toBe(false);
    // executeCodingTool's signature is (ctx, name, args) — the name is c[1].
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[1] === 'update_feedback')).toBe(false);
    // The document seam executed EXACTLY twice, both with the placeholder id.
    const udCalls = mockToolCacheExec.mock.calls.filter((c) => c[0] === 'update_document');
    expect(udCalls).toHaveLength(2);
    expect(udCalls.every((c) => c[1]?.fileId === 'probe')).toBe(true);
    // And the intended transcript tool was never emitted at all.
    expect(mockToolCacheExec.mock.calls.some((c) => c[0] === 'get_chat_messages')).toBe(false);

    // The auto-filing carries the ticket's verbatim failure texts (0c0ce759's
    // "Failure texts (newest first)": the two identical 'probe' refusals).
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const udFiling = filings.find((f) => f.tool === 'update_document');
    expect(udFiling).toBeDefined();
    expect(udFiling.recentFailures).toEqual([UD_ENVELOPE('probe'), UD_ENVELOPE('probe')]);
    // The refused ticket emissions filed too, carrying the preflight refusals.
    const ufFilings = filings.filter((f) => f.tool === 'update_feedback');
    expect(ufFilings.length).toBeGreaterThanOrEqual(1);
    expect(String(ufFilings[0].recentFailures[0])).toContain('ungrounded_id');
  });
});
