/**
 * Agent-loop pins for coding/tool-scope.ts (owner 2026-09-22). Scaffold mirrors
 * agent-derail-break.89e66d93 (real loop; model + executor mocked).
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

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { supervisorOnlyRefusal } from './tool-scope';

const CODING: AgentProfile = { kind: 'coding', maxSteps: 10, maxDelegations: 0, contextCharBudget: 100_000, workspaceTools: true, planReminders: false, memorySource: 'chat' };

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/tool-scope-test', sessionId: 'sess-tool-scope', projectId: 'p1', userId: 'u1', permissionMode: 'auto',
  model: 'kimi-k3', projectName: 'test', branch: 'main', profile: CODING, doctrineOverride: 'You are a test agent.',
  history: [], userMessage: 'Coordinator watch firing 16: fresh probes, then fold the design delta.', emit: jest.fn(), ...over,
});
const callTurn = (name: string, n: number, args: string, reasoning = '', content = '') => ({ content, reasoning, toolCalls: [{ id: `t${n}`, name, arguments: args }], finishReason: 'tool_calls' });
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const toolNames = (call: any[]): string[] => ((call?.[2] ?? []) as any[]).map((t: any) => t?.function?.name).filter(Boolean);
const metrics = (seam: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === seam);

beforeEach(() => {
  jest.clearAllMocks(); _store.clear();
  mockExecuteCodingTool.mockImplementation(async () => 'probe result: ok');
  delete process.env.TRIAGE_TOOLS_ALWAYS_VISIBLE; delete process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE;
  delete process.env.SUPERVISOR_ONLY_PERMA_AFTER;
});

describe('tool-scope in the agent loop (owner 2026-09-22 — fix the kimi-k3 wrong-tool slip at the cause)', () => {
  it('a coding run with NO ticket in scope is offered neither triage nor supervisor-only tools, under either spelling', async () => {
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    const offered = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(offered).toContain('update_plan');
    expect(offered).toContain('file_feedback');
    for (const n of ['update_feedback', 'triage_ticket', 'list_feedback', 'update_supervisor_state', 'save_supervisor_state', 'get_supervisor_state', 'register_infra_blocker', 'clear_infra_blocker']) {
      expect(offered).not.toContain(n);
    }
    expect(offered).toContain('load_tool_group');
    // No offered name shares the hot update_ prefix except the coding tools themselves.
    expect(offered.filter((n) => n.startsWith('update_')).sort()).toEqual(['update_document', 'update_plan', 'update_project', 'update_schedule'].filter((n) => offered.includes(n)).sort());
  });

  it('a ticket-dispatched run sees the triage tools under the model-facing name; an emitted triage_ticket dispatches as update_feedback and replays as emitted', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('triage_ticket', 1, '{"id":"02bf673a-6424-4db0-9b1a-5e8314bb304b","status":"in_progress","adminNote":"working"}', 'Mark the ticket in progress with triage_ticket.'))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userMessage: '[TICKET DISPATCH — feedback ticket 02bf673a-6424-4db0-9b1a-5e8314bb304b]\nfix the flaky test' }));
    const offered = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(offered).toContain('triage_ticket');
    expect(offered).toContain('list_feedback');
    expect(offered).not.toContain('update_feedback');
    // the description of list_feedback names the model-facing sibling
    const listSchema = (mockRunModelTurn.mock.calls[0][2] as any[]).find((t) => t.function.name === 'list_feedback');
    expect(listSchema.function.description).toContain('triage_ticket');
    expect(listSchema.function.description).not.toContain('update_feedback');
    // executed under the INTERNAL name
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteCodingTool.mock.calls[0][1]).toBe('update_feedback');
    // replayed under the EMITTED name, with the id the model used
    const round2 = mockRunModelTurn.mock.calls[1][1] as any[];
    const rec = round2.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(rec.tool_calls[0].function.name).toBe('triage_ticket');
    expect(round2.some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(true);
    expect(metrics('tool_alias_used')).toHaveLength(0);
  });

  it('the legacy alias update_feedback still executes when the triage group is in scope, and is telemetered', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('update_feedback', 1, '{"id":"02bf673a-6424-4db0-9b1a-5e8314bb304b","status":"in_progress"}', 'update the ticket'))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ userMessage: 'work the feedback tickets: list_feedback then fix the top one' }));
    expect(mockExecuteCodingTool.mock.calls[0][1]).toBe('update_feedback');
    expect(metrics('tool_alias_used')).toHaveLength(1);
    expect(metrics('tool_alias_used')[0].meta).toMatchObject({ tool: 'update_feedback', offeredAs: 'triage_ticket', outcome: 'observed' });
    const rec = (mockRunModelTurn.mock.calls[1][1] as any[]).find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(rec.tool_calls[0].function.name).toBe('update_feedback'); // replayed exactly as emitted
  });

  it('load_tool_group({group:"triage"}) adds the triage tools for the rest of the run', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('load_tool_group', 1, '{"group":"triage"}'))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(toolNames(mockRunModelTurn.mock.calls[0])).not.toContain('triage_ticket');
    const r2 = toolNames(mockRunModelTurn.mock.calls[1]);
    expect(r2).toContain('triage_ticket');
    expect(r2).toContain('list_feedback');
    const result = (mockRunModelTurn.mock.calls[1][1] as any[]).find((m) => m.role === 'tool' && m.tool_call_id === 't1');
    expect(result.content).toContain('"group": "triage"');
    expect(result.content).toContain('triage_ticket');
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
  });

  it('SLIP ECHO PRUNE: a turn that was ONLY a placeholder slip is removed from the replayed transcript and replaced by one harness line naming the intended tool', async () => {
    mockRunModelTurn
      // the prod shape: reasoning says run_command, the one emitted call is the cold admin tool with a placeholder id
      .mockResolvedValueOnce(callTurn('update_feedback', 1, '{"id":"noop"}', 'I will run the probe batch now with run_command, then read the design file.', 'Step 2: running the probes.'))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
    const round2 = mockRunModelTurn.mock.calls[1][1] as any[];
    expect(round2.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some((c: any) => c.id === 't1'))).toBe(false);
    expect(round2.some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(false);
    const note = round2.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('SLIP REMOVED'));
    expect(note).toBeTruthy();
    expect(note.content).toContain('"noop"');
    expect(note.content).toContain('You had written: "Step 2: running the probes."');
    expect(note.content).toContain('call run_command now');
    // the slip is not named by its internal spelling to the model
    expect(note.content).not.toContain('update_feedback(');
    expect(metrics('slip_echo_pruned')).toHaveLength(1);
    expect(metrics('slip_echo_pruned')[0].meta).toMatchObject({ tool: 'update_feedback', calls: 1, intended: 'run_command' });
    // the refusal itself still happened and was telemetered
    expect(metrics('tool_preflight')).toHaveLength(1);
  });

  it('a turn that mixes a slip with a REAL call keeps its full record (results are evidence)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce({ content: '', reasoning: 'read the file and also…', toolCalls: [
        { id: 't1', name: 'read_file', arguments: '{"path":"README.md"}' },
        { id: 't2', name: 'update_feedback', arguments: '{"id":"noop"}' },
      ], finishReason: 'tool_calls' })
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    const round2 = mockRunModelTurn.mock.calls[1][1] as any[];
    expect(round2.some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(true);
    expect(round2.some((m) => m.role === 'tool' && m.tool_call_id === 't2')).toBe(true);
    expect(metrics('slip_echo_pruned')).toHaveLength(0);
  });

  it('always-visible triage/supervisor tools are offered under their MODEL-FACING names', async () => {
    process.env.TRIAGE_TOOLS_ALWAYS_VISIBLE = '1';
    process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE = '1';
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    const offered = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(offered).toContain('triage_ticket');
    expect(offered).toContain('save_supervisor_state');
    expect(offered).not.toContain('update_feedback');
  });

  it('a supervisor profile keeps its state tools (model-facing spelling)', async () => {
    mockRunModelTurn.mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ profile: { ...CODING, kind: 'chat', workspaceTools: false, supervisorTools: true } }));
    const offered = toolNames(mockRunModelTurn.mock.calls[0]);
    expect(offered).toContain('save_supervisor_state');
    expect(offered).toContain('get_supervisor_state');
    expect(offered).not.toContain('update_supervisor_state');
    expect(offered).toContain('list_feedback'); // chat lanes: triage stays visible
  });
});

describe('FILER BINDING → triage-work signal (2026-09-27 review finding 4): a successful file_feedback preloads the triage group', () => {
  const FILED = 'Filed feedback ticket 3f09a1bc-aaaa-bbbb-cccc-dddddddddddd (bug_report, priority 3): "T". Filer binding: this session may move it with triage_ticket (in_progress / adminNote / priority; status=done needs evidence) only while no other lane is dispatched to it.';
  const DEDUP_MINE = 'Already tracked as ticket 3f09a1bc-aaaa-bbbb-cccc-dddddddddddd ("T", priority 3, seen 2 times) — bumped its priority/occurrence count instead of filing a duplicate. This session filed it — you may triage it with update_feedback (in_progress / adminNote / priority; status=done still needs evidence).';
  const DEDUP_OTHER = 'Already tracked as ticket 3f09a1bc-aaaa-bbbb-cccc-dddddddddddd ("T", priority 3, seen 2 times) — bumped its priority/occurrence count instead of filing a duplicate. Another session filed it — its filer/dispatched lane triages it; your sighting is recorded, do not update_feedback it.';
  const FILE_ARGS = '{"type":"bug_report","title":"T","description":"D","about":"digby_platform","digbyEvidence":"platform repo"}';

  it('a coding run with NO ticket in scope that files a ticket sees triage_ticket + list_feedback from the next round (no load_tool_group round trip)', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(FILED);
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('file_feedback', 1, FILE_ARGS))
      .mockResolvedValue(FINAL);
    const emit = jest.fn();
    await runCodingAgent(makeInput({ emit }));
    expect(toolNames(mockRunModelTurn.mock.calls[0])).not.toContain('triage_ticket');
    const r2 = toolNames(mockRunModelTurn.mock.calls[1]);
    expect(r2).toContain('triage_ticket');
    expect(r2).toContain('list_feedback');
    expect(emit).toHaveBeenCalledWith('progress', expect.objectContaining({ stage: 'tool-group', message: expect.stringContaining('filer binding') }));
  });

  it('a dedup hit that names THIS session as the filer preloads too; one that names ANOTHER session does not', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce(DEDUP_MINE);
    mockRunModelTurn.mockResolvedValueOnce(callTurn('file_feedback', 1, FILE_ARGS)).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(toolNames(mockRunModelTurn.mock.calls[1])).toContain('triage_ticket');

    jest.clearAllMocks();
    mockExecuteCodingTool.mockResolvedValueOnce(DEDUP_OTHER);
    mockRunModelTurn.mockResolvedValueOnce(callTurn('file_feedback', 1, FILE_ARGS)).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(toolNames(mockRunModelTurn.mock.calls[1])).not.toContain('triage_ticket');
  });

  it('a FAILED filing (refusal prose) does not preload — the signal is the receipt, not the call', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce('file_feedback refused: unclassified filing from a coding context — pass about=…');
    mockRunModelTurn.mockResolvedValueOnce(callTurn('file_feedback', 1, FILE_ARGS)).mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(toolNames(mockRunModelTurn.mock.calls[1])).not.toContain('triage_ticket');
  });

  it('a run that never filed sees the preload withheld: load_tool_group still works and the not-loaded hint names the filer case', async () => {
    mockExecuteCodingTool.mockResolvedValueOnce('probe result: ok');
    mockRunModelTurn
      .mockResolvedValueOnce(callTurn('list_dir', 1, '{"path":"."}'))
      // A MIXED turn: the refused triage_ticket rides alongside a REAL offered call,
      // so the slip-echo prune (always on since RSW-1) keeps the full record and the
      // refusal envelope's facility hint stays inspectable.
      .mockResolvedValueOnce({ content: '', reasoning: '', toolCalls: [
        { id: 't2', name: 'triage_ticket', arguments: '{"id":"3f09a1bc-aaaa-bbbb-cccc-dddddddddddd","status":"in_progress"}' },
        { id: 't3', name: 'list_dir', arguments: '{"path":"."}' },
      ], finishReason: 'tool_calls' })
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(toolNames(mockRunModelTurn.mock.calls[1])).not.toContain('triage_ticket');
    const refusal = (mockRunModelTurn.mock.calls[2][1] as any[]).find((m) => m.role === 'tool' && m.tool_call_id === 't2');
    const envelope = JSON.parse(refusal.content);
    expect(envelope).toMatchObject({ ok: false, tool: 'triage_ticket', reason: 'tool_not_offered' });
    expect(envelope.message).toContain('has not filed one this run');
    expect(envelope.message).toContain('or to move a ticket THIS session filed');
    expect(envelope.message).toContain('load_tool_group({group:"triage"})');
  });
});

describe('D5 (2026-09-27) — supervisor-only refusals are failure-shaped and perma-withhold the tool after 2 (prod 28de72e5: 90 update_supervisor_state calls, 0 receipts)', () => {
  const REFUSAL = supervisorOnlyRefusal('save_supervisor_state', 'save_supervisor_state is only available on the Fleet Supervisor chat');
  const refuseSupervisorState = () => mockExecuteCodingTool.mockImplementation(async (_ctx: any, name: string) => (name === 'update_supervisor_state' ? REFUSAL : 'probe result: ok'));
  // args vary per call so the unrelated identical-call repeat breaker never fires
  const supCall = (n: number) => callTurn('save_supervisor_state', n, `{"notes":"dual sparks deployment: step ${n} done"}`, 'Save the state, then continue the deployment.');

  it('EXECUTOR path (tool offered — the pre-09-22 prod shape): the 2nd refusal removes the tool for the rest of the run, the notice names the reason, the run continues', async () => {
    process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE = '1';
    refuseSupervisorState();
    mockRunModelTurn
      .mockResolvedValueOnce(supCall(1))
      .mockResolvedValueOnce(supCall(2))
      .mockResolvedValueOnce(supCall(3))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    // the executor saw exactly the two calls that were offered; the third was refused pre-flight
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'update_supervisor_state')).toHaveLength(2);
    expect(toolNames(mockRunModelTurn.mock.calls[1])).toContain('save_supervisor_state'); // one refusal is containment
    expect(toolNames(mockRunModelTurn.mock.calls[2])).not.toContain('save_supervisor_state'); // two is a lock
    expect(toolNames(mockRunModelTurn.mock.calls[3])).not.toContain('save_supervisor_state'); // for the rest of the run
    const round3 = mockRunModelTurn.mock.calls[2][1] as any[];
    const notice = round3.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('REMOVED FOR THE REST OF THIS RUN'));
    expect(notice).toBeTruthy();
    expect(notice.content).toContain('save_supervisor_state is only available on a supervisor chat');
    expect(notice.content).toContain('2 refusals this run');
    expect(notice.content).not.toContain('locked up again'); // not the generic 3+3 wording
    expect(notice.content).not.toContain('update_supervisor_state'); // model-facing spelling only
    // the third emission is refused pre-flight as withheld (failure-shaped, no execution)
    const t3 = (mockRunModelTurn.mock.calls[3][1] as any[]).find((m) => m.role === 'tool' && m.tool_call_id === 't3');
    // (a pure-slip turn is pruned from the replay — the refusal is still telemetered)
    expect(t3 === undefined || String(t3.content).includes('tool_not_offered')).toBe(true);
    expect(metrics('tool_preflight').filter((m) => m.meta.tool === 'update_supervisor_state')).toHaveLength(1);
    // telemetry: one row per refusal, the second is the perma
    const rows = metrics('supervisor_only_refusal');
    expect(rows.map((m) => m.meta)).toEqual([
      expect.objectContaining({ tool: 'update_supervisor_state', source: 'executor', count: 1, after: 2, outcome: 'counted' }),
      expect.objectContaining({ tool: 'update_supervisor_state', source: 'executor', count: 2, after: 2, outcome: 'perma_withheld' }),
    ]);
    const breaks = metrics('tool_derail_break');
    expect(breaks).toHaveLength(1);
    expect(breaks[0].meta).toMatchObject({ tool: 'update_supervisor_state', perma: true, shape: 'supervisor_only' });
    // the run was NOT ended (a single-tool lock never ends a run — parity with the generic ladder)
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(metrics('tool_derail_break').some((m) => m.meta.state === 'ended_run')).toBe(false);
  });

  it('PREFLIGHT path (default coding lane — the tool is never offered): two not-offered refusals count the same way', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(supCall(1))
      .mockResolvedValueOnce(supCall(2))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
    const rows = metrics('supervisor_only_refusal');
    expect(rows.map((m) => m.meta)).toEqual([
      expect.objectContaining({ tool: 'update_supervisor_state', source: 'preflight', count: 1, outcome: 'counted' }),
      expect.objectContaining({ tool: 'update_supervisor_state', source: 'preflight', count: 2, outcome: 'perma_withheld' }),
    ]);
    expect(metrics('tool_derail_break')).toHaveLength(1);
    expect(metrics('tool_derail_break')[0].meta).toMatchObject({ shape: 'supervisor_only', perma: true });
    const round3 = mockRunModelTurn.mock.calls[2][1] as any[];
    expect(round3.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('REMOVED FOR THE REST OF THIS RUN'))).toBe(true);
    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
  });

  it('SUPERVISOR_ONLY_PERMA_AFTER=3 moves the lock', async () => {
    process.env.SUPERVISOR_TOOLS_ALWAYS_VISIBLE = '1';
    process.env.SUPERVISOR_ONLY_PERMA_AFTER = '3';
    refuseSupervisorState();
    mockRunModelTurn
      .mockResolvedValueOnce(supCall(1))
      .mockResolvedValueOnce(supCall(2))
      .mockResolvedValueOnce(supCall(3))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(toolNames(mockRunModelTurn.mock.calls[2])).toContain('save_supervisor_state');
    expect(toolNames(mockRunModelTurn.mock.calls[3])).not.toContain('save_supervisor_state');
    expect(metrics('supervisor_only_refusal').map((m) => m.meta.outcome)).toEqual(['counted', 'counted', 'perma_withheld']);
    expect(metrics('tool_derail_break')[0].meta).toMatchObject({ perma: true, shape: 'supervisor_only' });
  });

  it('a supervisor profile whose calls EXECUTE is never touched', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(supCall(1))
      .mockResolvedValueOnce(supCall(2))
      .mockResolvedValueOnce(supCall(3))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ profile: { ...CODING, kind: 'chat', workspaceTools: false, supervisorTools: true } }));
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'update_supervisor_state')).toHaveLength(3);
    expect(metrics('supervisor_only_refusal')).toHaveLength(0);
    expect(metrics('tool_derail_break')).toHaveLength(0);
    expect(toolNames(mockRunModelTurn.mock.calls[3])).toContain('save_supervisor_state');
  });

  // Review fixer (2026-09-27, high): isSupervisorChat is `false` on ANY DB
  // error, so a REAL supervisor's executor can answer the supervisor_only
  // envelope during a transient outage. The ladder keys on the PROFILE — a
  // supervisorTools lane is never counted, never perma-locked, never told
  // "THIS chat is not one".
  it('a supervisor PROFILE whose executor answers the supervisor_only envelope (transient state-read failure) is NEVER counted: no rows, no perma, the tool stays offered', async () => {
    refuseSupervisorState();
    mockRunModelTurn
      .mockResolvedValueOnce(supCall(1))
      .mockResolvedValueOnce(supCall(2))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput({ profile: { ...CODING, kind: 'chat', workspaceTools: false, supervisorTools: true } }));
    expect(mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'update_supervisor_state')).toHaveLength(2);
    expect(metrics('supervisor_only_refusal')).toHaveLength(0);
    expect(metrics('tool_derail_break')).toHaveLength(0);
    expect(toolNames(mockRunModelTurn.mock.calls[2])).toContain('save_supervisor_state'); // still offered after two refusals
    const allUser = mockRunModelTurn.mock.calls.flatMap((c) => (c[1] as any[]).filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content as string));
    expect(allUser.some((t) => t.includes('REMOVED FOR THE REST OF THIS RUN'))).toBe(false);
    expect(allUser.some((t) => t.includes('THIS chat is not one'))).toBe(false);
  });

  // Review fixer (2026-09-27, medium): the perma used to be recorded as TWO
  // derailTripCounts trips, so one later ordinary 3-failure streak on ANY
  // other tool crossed the run-end bar (size ≥ 2 || total ≥ 3) and ended the
  // lane's run. A scope refusal is not a derailment episode: it feeds no trip.
  it('D5 perma + ONE ordinary 3-failure trip on another tool does NOT end the run (the scope lock is not a derailment trip)', async () => {
    mockExecuteCodingTool.mockImplementation(async (_ctx: any, name: string) => (name === 'read_file' ? 'Tool read_file failed: ENOENT' : 'probe result: ok'));
    const readFail = (n: number) => callTurn('read_file', n, `{"path":"src/missing-${n}.ts"}`, 'Read the file.');
    mockRunModelTurn
      .mockResolvedValueOnce(supCall(1))
      .mockResolvedValueOnce(supCall(2))   // D5 perma (preflight path)
      .mockResolvedValueOnce(readFail(3))
      .mockResolvedValueOnce(readFail(4))
      .mockResolvedValueOnce(readFail(5))  // ordinary trip #1 on read_file (one-round withhold)
      .mockResolvedValueOnce(callTurn('list_files', 6, '{"path":"src"}', 'List the directory.'))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());
    expect(metrics('supervisor_only_refusal').map((m) => m.meta.outcome)).toEqual(['counted', 'perma_withheld']);
    const breaks = metrics('tool_derail_break');
    expect(breaks.some((m) => m.meta.state === 'ended_run')).toBe(false);
    expect(breaks.find((m) => m.meta.shape === 'supervisor_only')?.meta).toMatchObject({ tool: 'update_supervisor_state', perma: true });
    expect(breaks.find((m) => m.meta.tool === 'read_file')?.meta).toMatchObject({ perma: false, shape: 'failure' }); // the ordinary one-round withhold
    expect(mockRunModelTurn).toHaveBeenCalledTimes(7); // the run reached its own final answer
    expect(toolNames(mockRunModelTurn.mock.calls[6])).toContain('read_file'); // back after one round
    expect(toolNames(mockRunModelTurn.mock.calls[6])).not.toContain('save_supervisor_state'); // the scope lock holds
  });
});
