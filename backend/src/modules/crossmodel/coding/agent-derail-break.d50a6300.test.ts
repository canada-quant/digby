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
 * Replay pin — ticket d50a6300 (mishap, auto-filed 2026-09-20T22:50:30Z at
 * the update_document derail-break trip; session
 * d4c97977-62f9-4c56-9721-a6e644abbe1d "Post-Sweep Acceptance Criteria
 * Verified" (canlegal-bench pt2 drain monitor), run
 * d05a40ed-47d5-4506-b53c-55636e64c03f, model kimi-k3, schedule trigger).
 *
 * THE INCIDENT: the lane's job that tick was the drain monitor step-1 probes
 * (pgrep / wc -l via run_command — its reasoning named run_command, earlier
 * grep). Instead the decoder walked the wrong-tool family — update_feedback
 * (preflight ungrounded_id) → edit_file (re-anchor) → update_feedback
 * (derail_break perma:false→true) → update_document — and the two
 * update_document calls carried CHAT IDS LIFTED FROM THE LANE'S OWN PROMPT
 * CONTEXT as fileIds: "165b5d36" (the peer scaffold lane the monitor prompt
 * says to notify) then "d4c97977" (the lane's OWN chat id). Filed failure
 * texts (newest first, verbatim from the ticket):
 *   · No generated file with id d4c97977 belongs to this user. Call list_files to see the current files.
 *   · No generated file with id 165b5d36 belongs to this user. Call list_files to see the current files.
 * The run ended 22:50:30Z: "[HARNESS] Run ended: repeated wrong-tool
 * derailment (3 episodes; intended tool appears to be run_command)."
 * Guard rows for run d05a40ed (adjudicating lane b92ef13f get_fleet_telemetry
 * pull, asOf 2026-09-20T23:11:23Z): 22:48:35.963Z tool_preflight
 * update_feedback ungrounded_id intended grep → 22:48:36.845Z
 * tool_derail_reanchor edit_file intent_mismatch intended grep →
 * 22:48:38.566Z tool_derail_break update_feedback perma:false intended grep →
 * 22:49:37.263Z tool_derail_break update_feedback perma:true intended grep →
 * 22:50:30.738Z tool_derail_break update_document perma:false state
 * ended_run tools [update_feedback, update_document] trips:3 intended
 * run_command.
 *
 * VERDICT (adjudicated by lane b92ef13f): MODEL BEHAVIOR — the
 * placeholder-emission wrong-tool derail class (f839cede/aff1c189/ec9d7424,
 * c35162ee probe/probe2), chat-id-NAMESPACE variant: the ids are REAL
 * platform identifiers echoed from the lane's own brief (so they pass the
 * ungrounded-id preflight — the verbatim-occurrence mechanism pinned in
 * c35162ee test 1) but the WRONG NAMESPACE (chat id ≠ file id). The
 * existence refusal is the deterministic ownership gate (tool-executor.ts
 * 712/780/875); every containment seam (preflight ungrounded_id, re-anchor
 * 431518a2, derail break) fired as designed; zero junk document writes; the
 * update_* family migration is already pinned by
 * agent-derail-break.c35162ee.test.ts. NO platform code change.
 *
 * Scaffold mirrors agent-derail-break.c35162ee.test.ts (ToolCache document
 * seam + strikes helper).
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

// update_feedback executes through executeCodingTool; a machine-triggered run
// mutating an undispatched ticket gets the mutation gate's evidence_required
// refusal (the 0aecbe92 shape). Every other tool succeeds harmlessly.
const UF_ENVELOPE = (ticketId: string) => JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'evidence_required',
  ticketId,
  message: `This machine-triggered run may NOT mutate feedback ticket ${ticketId.slice(0, 8)}: not dispatched to this session and no verifiable evidence supplied.`,
}, null, 1);
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_feedback') return UF_ENVELOPE(String(args?.id ?? ''));
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// The document-tool seam: update_document dispatches via ctx.toolCache
// (WEB_TOOL_NAMES), not executeCodingTool. Stub only the executor instance to
// answer tool-executor.ts's honest existence refusal (712/780/875).
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_document' || name === 'read_document' || name === 'fill_pdf_form') {
    const id = String(args?.fileId ?? args?.documentId ?? '');
    return `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
  }
  if (name === 'update_feedback') return UF_ENVELOPE(String(args?.id ?? ''));
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

import { runCodingAgent, WEB_TOOL_NAMES } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { findUngroundedIdArgs } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile (no workspace container in the scaffold): run_command is in
 *  the offered schema — the incident's intended tool must be offerable for
 *  the intent-mismatch preflight to name it (the 0aecbe92 precedent). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim chat-id fileIds + filed texts (newest first) ────
// ID_PEER was emitted first (the scaffold lane the monitor prompt says to
// notify), ID_SELF second (the lane's own chat id).
const ID_PEER = '165b5d36';
const ID_SELF = 'd4c97977';
const existenceText = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const FILED_NEWEST_FIRST = [existenceText(ID_SELF), existenceText(ID_PEER)];

/** The drain-monitor brief. The chat ids live in the prompt context — the
 *  lane copied them into fileId args (the wrong NAMESPACE: chat id ≠ file
 *  id), which is exactly how the calls passed the ungrounded-id preflight
 *  and reached the document executor (the verbatim-occurrence mechanism). */
const BRIEF = [
  '[PT2 DRAIN MONITOR — standby tick]',
  'Check the runner is alive and the ledger grew; re-arm the chain;',
  'when BOTH gates are true, tell the scaffold lane the drain verified.',
].join('\n');
const ECHO = 'You are bench lane d4c97977; scaffold lane 165b5d36 owns the node.';

/** A wrong-tool emission into the fleet seam with a grounded-hex id that
 *  EXECUTES into the mutation-gate refusal — the incident's update_feedback
 *  episodes (22:48:38.566Z perma:false → 22:49:37.263Z perma:true). The
 *  reasoning names grep (whole word, never the called tool) so the REAL
 *  detectIntendedTool convicts (+1 fast-trip), exactly the guard rows'
 *  intended:grep. */
const ufTurn = (n: number) => ({
  content: '',
  reasoning: 'Shell first: grep the runner log for the ledger count — the sweep starts now.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: 'deadbee0', adminNote: 'recheck' }) }],
  finishReason: 'tool_calls',
});
/** The ban-round probe: a legitimate, succeeding plan touch. */
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
/** A wrong-tool emission into the document seam carrying a CHAT ID as fileId —
 *  hex-shaped ⇒ grounded by shape (the namespace blindness), so the call
 *  EXECUTES into the ownership-gate refusal. The reasoning names run_command
 *  (whole word, never the called tool) — the ticket's "lane's reasoning named
 *  run_command". */
const udTurn = (n: number, id: string) => ({
  content: '',
  reasoning: 'run_command cannot touch the digest — refresh the generated file with the census figures now.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick closed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-d50a6300-test',
  sessionId: 'sess-d50a6300',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

const strikes = (seam: string) =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === seam);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket d50a6300 — chat-id fileIds 165b5d36/d4c97977 fed to update_document while the narration named run_command', () => {
  it('namespace blindness: the hex-shaped chat ids are grounded BY SHAPE (ID_SHAPE_RE /^[0-9a-f]{8}/i) — the ungrounded-id preflight cannot tell a chat id from a file id, so the incident calls sailed through to the document executor where the ownership gate refused them (the deterministic backstop); a NON-hex placeholder would have been caught pre-execution', () => {
    expect(findUngroundedIdArgs({ fileId: ID_PEER }, BRIEF)).toEqual([]);
    expect(findUngroundedIdArgs({ fileId: ID_SELF }, BRIEF)).toEqual([]);
    // Shape alone grounds — no prompt echo needed (unlike c35162ee probe/probe2).
    expect(findUngroundedIdArgs({ fileId: ID_PEER }, '')).toEqual([]);
    expect(findUngroundedIdArgs({ fileId: 'probe2' }, BRIEF)).toEqual([{ key: 'fileId', value: 'probe2' }]);
  });

  it('the two filed texts are byte-exact the executor existence-refusal format (the deterministic ownership gate — no framework defect)', async () => {
    expect(await mockToolCacheExec('update_document', { fileId: ID_PEER })).toBe(FILED_NEWEST_FIRST[1]);
    expect(await mockToolCacheExec('update_document', { fileId: ID_SELF })).toBe(FILED_NEWEST_FIRST[0]);
  });

  it('END-TO-END the incident ladder: {update_feedback: 2 trips (ungrounded_id + intended grep), update_document: 1 trip (chat-id fileIds + intended run_command)} = 3 episodes ⇒ the run ends with the EXACT incident ender and zero shell executions', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ufTurn(1)) // count 2 (preflight refusal + intent)
      .mockResolvedValueOnce(ufTurn(2)) // count 4 ⇒ TRIP 1 (one-round ban)
      .mockResolvedValueOnce(planTurn(3)) // ban round — harmless success
      .mockResolvedValueOnce(ufTurn(4)) // count 2
      .mockResolvedValueOnce(ufTurn(5)) // count 4 ⇒ TRIP 2 (perma on update_feedback)
      .mockResolvedValueOnce(udTurn(6, ID_PEER)) // count 2 (existence refusal + intent)
      .mockResolvedValueOnce(udTurn(7, ID_SELF)) // count 4 ⇒ TRIP 3 ⇒ TERMINAL
      .mockResolvedValue(FINAL);

    const input = makeInput(`${BRIEF}\n${ECHO}\nRun the monitor tick now.`);
    const result = await runCodingAgent(input);

    // The incident's exact ender (msg 9a0c2157, 22:50:30Z).
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes');
    expect(result.finalText).toContain('intended tool appears to be run_command');
    expect(result.modelErrored).toBeUndefined();

    // The terminal telemetry row (22:50:30.738Z: state ended_run, trips 3,
    // tools [update_feedback, update_document], intended run_command).
    const ended = strikes('tool_derail_break').find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'update_document', trips: 3, intended: 'run_command' });

    // Both chat-id calls EXECUTED into the ownership-gate refusal (grounded by
    // shape) and the auto-filing carries the two filed texts, newest first.
    expect(mockToolCacheExec).toHaveBeenCalledTimes(2);
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const udFiling = filings.find((f) => f.tool === 'update_document');
    const ufFiling = filings.find((f) => f.tool === 'update_feedback');
    expect(udFiling).toBeDefined();
    expect(udFiling.recentFailures).toEqual(FILED_NEWEST_FIRST);
    expect(ufFiling).toBeDefined();
    expect(ufFiling.recentFailures).toEqual([UF_ENVELOPE('deadbee0'), UF_ENVELOPE('deadbee0')]);

    // The incident signature: run_command was NEVER emitted — zero shell work.
    expect(mockExecuteCodingTool.mock.calls.some((c) => c.includes('run_command'))).toBe(false);
  });

  it('wiring seam: update_document rides the ToolCache/WEB document seam (never the fleet list) and update_feedback — the family the lock migrated across — stays a real offered platform tool', () => {
    expect(WEB_TOOL_NAMES.has('update_document')).toBe(true);
    expect(PLATFORM_TOOL_NAMES).not.toContain('update_document');
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
  });
});
