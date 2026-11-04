/**
 * Replay pin — ticket ff091af6 (mishap, auto-filed 2026-09-21T00:33:58Z at
 * the update_document derail-break trip; session
 * b92ef13f-c3f8-487e-8267-767e56543150 "Digby's Nightly Self-Improvement
 * Enginee…", run 2ee49a18-22ac-4786-b298-2fcacea95e55, model kimi-k3,
 * fleet-hook wake).
 *
 * THE INCIDENT: the run was a derail-rescue continuation whose ONLY job was
 * to execute the get_feedback the previous ended run never could (plan step
 * #1 verbatim: "Harvest sub-session b4b4f2a7 (get_chat_status +
 * get_chat_messages) and re-probe settled state: get_feedback 6d8d8beb +
 * 9…"). Instead the decoder re-entered the wrong-tool lock: update_feedback
 * episode first (trip 1, one-round ban), then THREE update_document calls
 * carrying REAL PLATFORM IDS OF THE WRONG TYPE as fileIds — emitted in
 * escalating-specificity order:
 *   1st "b4b4f2a7-d33b-4dcd-997c-722e493fe59e" (the full sub-session CHAT id)
 *   2nd "b4b4f2a7"                            (its 8-char prefix)
 *   3rd "6d8d8beb"                            (the TICKET id from the plan step)
 * Filed failure texts (newest first, verbatim from the ticket):
 *   · No generated file with id 6d8d8beb belongs to this user. Call list_files to see the current files.
 *   · No generated file with id b4b4f2a7 belongs to this user. Call list_files to see the current files.
 *   · No generated file with id b4b4f2a7-d33b-4dcd-997c-722e493fe59e belongs to this user. Call list_files to see the current files.
 * The run ended 00:33:58Z: "[HARNESS] Run ended: repeated wrong-tool
 * derailment (2 episodes; intended tool appears to be get_feedback)."
 * Guard rows for run 2ee49a18 (adjudicating lane 3f07af2b get_fleet_telemetry
 * pull, asOf 2026-09-21T00:45:53Z, kind=guard_strike chatId=b92ef13f):
 *   00:32:52.346Z tool_derail_break    update_feedback perma:false
 *   00:33:36.440Z tool_derail_reanchor update_document intent_mismatch
 *                  intended get_feedback
 *   00:33:58.561Z tool_derail_break    update_document perma:false state
 *                  ended_run tools [update_feedback, update_document]
 *                  trips:2 intended get_feedback
 *   00:33:58.597Z tool_derail_rescue   update_document state
 *                  continuation_enqueued max:2 count:1 trips:2
 * Both ids were verified REAL this adjudication: chat
 * b4b4f2a7-d33b-4dcd-997c-722e493fe59e exists ("Harness Run Forensics
 * Failure Analysis", get_chat_status 2026-09-21) and ticket 6d8d8beb was
 * the lane's own close-set ticket (evidence-closed 00:25:11Z the same
 * night, per the b92ef13f transcript) — and both strings appear VERBATIM
 * in the run's own plan step / wake-message context.
 *
 * VERDICT (adjudicated by lane 3f07af2b, dispatch binding
 * ff091af6.context.dispatchedTo): MODEL BEHAVIOR — the wrong-tool derail
 * class (lineage f839cede/ec9d7424/aff1c189/bda7f125 → c35162ee →
 * d50a6300 → 769d7278/afac4aee), REAL-WRONG-TYPE-ID discriminator: unlike
 * the literal-placeholder siblings ("placeholder"/"none"/"__none__"), the
 * emitted ids are genuine ticket/chat identifiers echoed from the lane's
 * own context — hex-8-shape grounded (ID_SHAPE_RE /^[0-9a-f]{8}/i matches
 * the full uuid by prefix too), so the ungrounded-id preflight correctly
 * lets them through and the deterministic ownership gate
 * (tool-executor.ts:712/780/875 — one template, three sites) refuses them;
 * FAILURE_MARKERS (learnings-index.service.ts:384) shapes the streak.
 * EMISSION-LAYER EXCLUSION (the sibling analyses covered literals; this
 * pin extends it to real ids): the ONLY tool-arg rewrite site in the
 * coding loop is agent.ts:3201 `tc.arguments = JSON.stringify(audit.args)`,
 * gated on OUTBOUND_AUDITED_TOOL_ARGS[tc.name] (send_chat_message /
 * todo_update / goal_update / file_feedback — outbound TEXT args) AND
 * OUTBOUND_CLAIM_AUDIT_ENFORCE=1 (default observe-only) — update_document
 * is not an audited outbound tool, so no harness seam can rewrite or leak
 * a nearby id into its fileId arg; the ids could only come from the
 * model's own emission. Every containment seam fired as designed:
 * ownership gate (zero junk document writes), re-anchor steer
 * (431518a2), derail break terminal state, auto-ticket, derail-rescue
 * continuation (ff1fa1b5). NO platform code change.
 *
 * Scaffold mirrors agent-derail-break.d50a6300.test.ts (ToolCache document
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
import { OUTBOUND_AUDITED_TOOL_ARGS } from './outbound-claim-audit';

/** CODING profile (no workspace container in the scaffold): get_feedback —
 *  the incident's intended tool — must be offerable for the intent-mismatch
 *  detection to name it. */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim real-wrong-type ids + filed texts ──────────────
// Emission order (oldest → newest): full chat uuid → its prefix → ticket id
// (escalating specificity inside the decoder lock). The ticket files them
// newest first.
const ID_CHAT_FULL = 'b4b4f2a7-d33b-4dcd-997c-722e493fe59e'; // real sub-session chat id
const ID_CHAT_PREFIX = 'b4b4f2a7'; // its 8-char prefix
const ID_TICKET = '6d8d8beb'; // the lane's own close-set TICKET id
const existenceText = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const FILED_NEWEST_FIRST = [existenceText(ID_TICKET), existenceText(ID_CHAT_PREFIX), existenceText(ID_CHAT_FULL)];

/** The rescue-continuation brief: the real ids live in the plan/wake context
 *  — the lane echoed them into fileId args (the wrong NAMESPACE/TYPE: ticket
 *  id and chat id ≠ file id). */
const BRIEF = [
  '[DERAIL RESCUE] Resume: FIRST ACTION make the get_feedback call the',
  'previous run could not — plan step #1: Harvest sub-session',
  'b4b4f2a7-d33b-4dcd-997c-722e493fe59e (get_chat_status + get_chat_messages)',
  'and re-probe settled state: get_feedback 6d8d8beb + 9df506cc.',
].join('\n');

/** A wrong-tool emission into the fleet seam carrying a grounded hex ticket
 *  id — the incident's update_feedback episode (00:32:52.346Z trip 1). The
 *  reasoning names NO offered tool (failure-only weights: +1 per call, trip
 *  at the third — the incident's re-anchor fired LATER, on update_document,
 *  so the real uf turns carried no intent conviction). */
const ufTurn = (n: number) => ({
  content: '',
  reasoning: 'Writing the close-set adjudication note now.',
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
/** A wrong-tool emission into the document seam carrying a REAL wrong-type id
 *  as fileId — hex-8-shape grounded, so the call EXECUTES into the
 *  ownership-gate refusal. The first two carry failure-only weight (+1 each)
 *  so all three incident calls execute before the trip. */
const udTurn = (n: number, id: string) => ({
  content: '',
  reasoning: 'Refreshing the digest artifact with the reconciled close-set figures now.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
/** The THIRD document-seam call: the reasoning names get_feedback (whole
 *  word, never the called tool) — the incident's 00:33:36.440Z re-anchor row
 *  (update_document, intent_mismatch, intended get_feedback). Weights: +1
 *  failure +1 intent ⇒ the streak reaches the trip exactly here, and the
 *  conviction survives into the terminal note ("intended tool appears to be
 *  get_feedback", agent.ts:3366). */
const udConvictTurn = (n: number, id: string) => ({
  content: '',
  reasoning: 'get_feedback on the settled pair first — then this digest refresh can land.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Rescue closed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string, profile: AgentProfile = CODING_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-ff091af6-test',
  sessionId: 'sess-ff091af6',
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

describe('ticket ff091af6 — real wrong-type ids (ticket 6d8d8beb, chat b4b4f2a7[-full]) fed to update_document while the rescue brief named get_feedback', () => {
  it('real-id discriminator: the ticket id AND the full 36-char chat uuid are grounded BY SHAPE (ID_SHAPE_RE /^[0-9a-f]{8}/i prefix-matches the uuid) — the ungrounded-id preflight cannot tell a real ticket/chat id from a file id, so all three incident calls sailed through to the ownership gate; a NON-hex placeholder would have been caught pre-execution', () => {
    expect(findUngroundedIdArgs({ fileId: ID_TICKET }, BRIEF)).toEqual([]);
    expect(findUngroundedIdArgs({ fileId: ID_CHAT_PREFIX }, BRIEF)).toEqual([]);
    expect(findUngroundedIdArgs({ fileId: ID_CHAT_FULL }, BRIEF)).toEqual([]);
    // Shape alone grounds — no context echo needed (and the context echoes them verbatim anyway).
    expect(findUngroundedIdArgs({ fileId: ID_CHAT_FULL }, '')).toEqual([]);
    expect(findUngroundedIdArgs({ fileId: 'placeholder' }, BRIEF)).toEqual([{ key: 'fileId', value: 'placeholder' }]);
  });

  it('the three filed texts are byte-exact the executor existence-refusal format (the deterministic ownership gate — no framework defect)', async () => {
    expect(await mockToolCacheExec('update_document', { fileId: ID_CHAT_FULL })).toBe(FILED_NEWEST_FIRST[2]);
    expect(await mockToolCacheExec('update_document', { fileId: ID_CHAT_PREFIX })).toBe(FILED_NEWEST_FIRST[1]);
    expect(await mockToolCacheExec('update_document', { fileId: ID_TICKET })).toBe(FILED_NEWEST_FIRST[0]);
  });

  it('emission-layer exclusion: the ONLY tool-arg rewrite seam (agent.ts:3201, outbound claim audit) is gated on OUTBOUND_AUDITED_TOOL_ARGS — update_document is not an audited outbound tool, so no harness layer can rewrite/leak a real nearby id into its fileId arg; the ids came from the model emission alone', () => {
    expect(OUTBOUND_AUDITED_TOOL_ARGS['update_document']).toBeUndefined();
    expect(Object.keys(OUTBOUND_AUDITED_TOOL_ARGS).sort()).toEqual([
      'file_feedback', 'goal_update', 'send_chat_message', 'todo_update',
    ]);
  });

  it('END-TO-END the incident ladder: {update_feedback: 1 trip, update_document: 1 trip} across 2 tools ⇒ the run ends with the EXACT incident ender, the three real-id refusals filed newest-first, and zero get_feedback executions', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ufTurn(1)) // failure-only ⇒ count 1
      .mockResolvedValueOnce(ufTurn(2)) // count 2
      .mockResolvedValueOnce(ufTurn(3)) // count 3 ⇒ TRIP 1 (one-round ban, perma:false)
      .mockResolvedValueOnce(planTurn(4)) // ban round — harmless success
      .mockResolvedValueOnce(udTurn(5, ID_CHAT_FULL)) // count 1 (failure-only)
      .mockResolvedValueOnce(udTurn(6, ID_CHAT_PREFIX)) // count 2
      .mockResolvedValueOnce(udConvictTurn(7, ID_TICKET)) // +1 failure +1 intent ⇒ count 4 ⇒ TRIP on update_document ⇒ size 2 ⇒ TERMINAL
      .mockResolvedValue(FINAL);

    const input = makeInput(`${BRIEF}\nResume the work NOW.`);
    const result = await runCodingAgent(input);

    // The incident's exact ender (msg c3a737c8, 00:33:58Z).
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (2 episodes');
    expect(result.finalText).toContain('intended tool appears to be get_feedback');
    expect(result.modelErrored).toBeUndefined();

    // The terminal telemetry row (00:33:58.561Z: state ended_run, trips 2,
    // tools [update_feedback, update_document], intended get_feedback).
    const ended = strikes('tool_derail_break').find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'update_document', trips: 2, intended: 'get_feedback' });
    expect(ended!.meta.tools).toEqual(expect.arrayContaining(['update_feedback', 'update_document']));

    // The re-anchor steer fired on the convicting update_document call with
    // the incident's intended tool (00:33:36.440Z row: update_document,
    // intent_mismatch, intended get_feedback).
    const reanchor = strikes('tool_derail_reanchor')[0];
    expect(reanchor).toBeDefined();
    expect(reanchor.meta).toMatchObject({ tool: 'update_document', intended: 'get_feedback', reason: 'intent_mismatch' });

    // All three real-id calls EXECUTED into the ownership-gate refusal, in the
    // incident's escalating-specificity order, and the auto-filing carries the
    // three filed texts, newest first.
    expect(mockToolCacheExec).toHaveBeenCalledTimes(3);
    expect(mockToolCacheExec.mock.calls.map((c) => c[1].fileId)).toEqual([ID_CHAT_FULL, ID_CHAT_PREFIX, ID_TICKET]);
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const udFiling = filings.find((f) => f.tool === 'update_document');
    expect(udFiling).toBeDefined();
    expect(udFiling.recentFailures).toEqual(FILED_NEWEST_FIRST);

    // The incident signature: get_feedback was NEVER emitted — the rescue's
    // mandated FIRST ACTION never executed (zero fleet-tool reads).
    expect(mockExecuteCodingTool.mock.calls.some((c) => c.includes('get_feedback'))).toBe(false);
  });

  it('wiring seam: update_document rides the ToolCache/WEB document seam (never the fleet list, so no ungrounded-id preflight) while get_feedback/update_feedback — the family the lock migrated across — stay real offered platform tools', () => {
    expect(WEB_TOOL_NAMES.has('update_document')).toBe(true);
    expect(PLATFORM_TOOL_NAMES).not.toContain('update_document');
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
    expect(PLATFORM_TOOL_NAMES).toContain('get_feedback');
  });
});
