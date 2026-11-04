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
 * Replay pin — tickets afac4aee + 769d7278 (ONE incident run, session
 * 3e1cae6f-59fb-43a7-9d32-6ee36c450428 "Hardening Bench for Public Release",
 * project canlegal-bench, kimi-k3, run ca07574e-9ca5-48d8-b4bb-075423abf09f,
 * splash re-sync standing-watch firing 11/500 of 2026-09-20 23:33:01Z,
 * todo f8654c84).
 *
 * THE INCIDENT: the lane's ENTIRE job that tick was the trigger-check probes
 * (git fetch origin + AST count of SUITE_MEAN_EXCLUDED_TASKS + a cache-busted
 * splash fetch — shell work: its reasoning named run_command). Instead the
 * decoder locked onto the wrong-tool family and the run produced:
 *   · afac4aee: '3× tool-failure streak: update_feedback' with ONE failure
 *     text — the ungrounded-id pre-flight refusal for id="__none__", whose
 *     recovery line names run_command ("Your reasoning named run_command —
 *     you evidently meant to call run_command; call it now with its real
 *     parameters.");
 *   · 769d7278: '3× tool-failure streak: update_document' with TWO failure
 *     texts — "No generated file with id none belongs to this user. Call
 *     list_files to see the current files." retried identically;
 * and the run ended 23:35:58Z with "[HARNESS] Run ended: repeated wrong-tool
 * derailment (3 episodes; intended tool appears to be run_command). The next
 * scheduled firing starts fresh." (msg 7466a063).
 *
 * GUARD ROWS for run ca07574e (get_fleet_telemetry guard_strike pull,
 * asOf 2026-09-21T00:03:29Z) — the full containment ladder, every seam
 * firing as designed:
 *   23:34:05.850Z tool_preflight      update_feedback ungrounded_id   intended run_command
 *   23:34:08.953Z tool_derail_reanchor update_feedback intent_mismatch intended run_command
 *   23:34:11.340Z tool_derail_break   update_feedback perma:false     intended run_command
 *   23:34:52.196Z tool_derail_break   update_feedback perma:true      intended run_command
 *   23:35:58.872Z tool_derail_break   update_document perma:false state ended_run
 *                                       tools [update_feedback, update_document] trips:3
 *                                       intended run_command
 *   23:35:58.886Z tool_derail_rescue  continuation_enqueued (1 of max 2) trips:3
 * Trip arithmetic: {update_feedback: 2, update_document: 1} = 3 episodes —
 * terminal by BOTH N1 rules (agent.ts: derailTripCounts.size >= 2 OR
 * total >= 3). The derail-rescue continuation (msg 70c3c282, 23:36:00Z)
 * re-grounded and completed the watch tick (msg 9e0d74bd, trigger-unmet
 * note 23:40:00Z) — the work recovered.
 *
 * ROLLOUT BOUNDARY (post-rollout boundary-classification doctrine): the run
 * started 23:33:01Z — AFTER the whole containment ladder for this class was
 * live: 88dde42a7 (re-anchor rescue, ticket ff1fa1b5, committed 22:03:47Z)
 * is an ancestor of b12b492c whose deploy run 35541257602 concluded success
 * 23:20:11Z (verified `git merge-base --is-ancestor` + get_fleet_telemetry
 * view 'deploy'). This is a POST-ROLLOUT residual occurrence of the
 * documented kimi-k3 placeholder-emission wrong-tool derail class
 * (f839cede/aff1c189/ec9d7424 → c35162ee → 54121353/83297404 → d50a6300),
 * NOT a new framework defect.
 *
 * VERDICT (the tickets' mandated investigation): MODEL BEHAVIOR. Both filed
 * texts diff byte-clean against current framework code:
 *   · the afac4aee text is ungroundedIdRefusal's exact envelope for
 *     update_feedback id="__none__" + intended run_command (tool-preflight.ts
 *     — update_feedback ∈ PLATFORM_TOOL_NAMES so the agent.ts preflight gates
 *     it; "__none__" is non-hex and appeared nowhere the model had read);
 *   · the 769d7278 text is the document executor's existence/ownership
 *     refusal verbatim (tool-executor.ts:712/780/875) — update_document ∉
 *     PLATFORM_TOOL_NAMES BY DESIGN (it rides the ToolCache WEB seam), so the
 *     ungrounded-id preflight never applies to it and the ownership gate is
 *     the deterministic backstop. The supervisor's "should have been caught
 *     by the ungrounded-id preflight" hypothesis is DISPROVEN for the
 *     document leg (peer handoff from lane b92ef13f, 2026-09-21T00:0xZ —
 *     the split is the design, no gap).
 * NO platform code change.
 *
 * NEW vs the 54121353/83297404 pin (identical composite, placeholder
 * "__none__" on BOTH legs): the document leg here carried the bare literal
 * 'none' (no underscores) — pin that variant — and this run's guard rows let
 * the trip-2 sub-path be reconstructed arithmetically: only ONE preflight
 * row exists, so the second update_feedback emission did NOT re-hit the
 * ungrounded preflight — the first refusal's own JSON echo ("value":
 * "__none__") sits in the run's tool messages, and groundingHaystack
 * INCLUDES tool results, so the identical placeholder was grounded by
 * verbatim occurrence (the c35162ee mechanism) and EXECUTED into the real
 * tool's refusal. The ladder below replays exactly that path.
 *
 * Scaffold mirrors agent-derail-break.54121353.test.ts +
 * agent-derail-break.d50a6300.test.ts (ToolCache document seam + CODING
 * profile so run_command is offerable for the intent conviction).
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

// update_feedback EXECUTES through executeCodingTool when it passes the
// preflight (the echo-grounded second/third emissions); a machine-triggered
// run mutating an undispatched ticket gets the mutation gate's
// evidence_required refusal (failure-shaped). Every other tool succeeds
// harmlessly.
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
import { findUngroundedIdArgs, ungroundedIdRefusal } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

/** CODING profile (the incident's profile per the guard rows): run_command
 *  is in the offered schema — the incident's intended tool must be offerable
 *  for the intent-mismatch preflight to name it (the 0aecbe92 precedent). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// ── The incident's verbatim placeholder literals + filed texts ─────────────
const UF_ID = '__none__'; // update_feedback leg (ticket afac4aee)
const UD_ID = 'none'; // update_document leg (ticket 769d7278) — the BARE literal
const EXISTENCE_TEXT =
  'No generated file with id none belongs to this user. Call list_files to see the current files.';
/** Ticket afac4aee's ONE filed text, verbatim — the pre-flight refusal for
 *  update_feedback id="__none__" with the run_command recovery line. */
const TICKET_AFAC4AEE_TEXT = [
  '{',
  ' "ok": false,',
  ' "tool": "triage_ticket",',
  ' "reason": "ungrounded_id",',
  ' "rejected": [',
  '  {',
  '   "key": "id",',
  '   "value": "__none__"',
  '  }',
  ' ],',
  ' "message": "NOT EXECUTED: triage_ticket was called with id=\\"__none__\\", which is not an id you obtained this run — ids come from a prior tool result (list_*/get_*), the brief, or the user, never from narration. Your reasoning named run_command — you evidently meant to call run_command; call it now with its real parameters."',
  '}',
].join('\n');

/** The splash re-sync standing-watch brief (todo f8654c84). It carries NEITHER
 *  placeholder literal, so the first update_feedback emission is refused
 *  ungrounded (the afac4aee shape); the document leg is never preflight-gated
 *  (the seam split — see the wiring test). */
const BRIEF = [
  '[SPLASH RE-SYNC WATCH — firing 11/500]',
  'TRIGGER CHECK: git fetch origin; on origin/main read',
  'canlegal_bench/suite_mean_policy.py SUITE_MEAN_EXCLUDED_TASKS and confirm',
  'whether any runbook §7 re-inclusion raised the suite-mean denominator.',
  'IF TRIGGER UNMET: cache-busted fetch of https://canlegalbench.com, then',
  'close with a one-line stand-down note. No other work.',
].join('\n');

/** A wrong-tool update_feedback emission carrying the placeholder: the
 *  reasoning names run_command (whole word, NEVER the called tool) — the
 *  REAL detectIntendedTool convicts (+1 fast-trip), exactly the guard rows'
 *  intended:run_command. */
const ufTurn = (n: number) => ({
  content: '',
  reasoning: 'Shell probes first: run_command with git fetch origin, then the policy diff — the bookkeeping can wait for the numbers.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: UF_ID, adminNote: 'recheck' }) }],
  finishReason: 'tool_calls',
});
/** The ban-round probe: a legitimate, succeeding plan touch. */
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
/** A wrong-tool update_document emission carrying the BARE 'none' literal as
 *  fileId — update_document is NOT platform-gated, so the call EXECUTES into
 *  the ownership gate (the 769d7278 refusal). The reasoning names run_command
 *  (whole word, never the called tool) — the ticket's "lane's reasoning named
 *  run_command". */
const udTurn = (n: number) => ({
  content: '',
  reasoning: 'run_command cannot rewrite the generated digest from here — refreshing the file with the reconciled census copy now.',
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: UD_ID, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick closed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string): AgentRunInput => ({
  worktree: '/tmp/derail-afac4aee-test',
  sessionId: 'sess-afac4aee',
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

const strikes = (seam: string) =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === seam);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('tickets afac4aee + 769d7278 — placeholder update_feedback "__none__" + update_document "none" while the narration named run_command', () => {
  it('both literals are ungrounded against the run haystack (non-hex; appear nowhere the model read)', () => {
    expect(findUngroundedIdArgs({ id: UF_ID }, BRIEF))
      .toEqual([{ key: 'id', value: UF_ID }]);
    expect(findUngroundedIdArgs({ fileId: UD_ID }, BRIEF))
      .toEqual([{ key: 'fileId', value: UD_ID }]);
  });

  it('the afac4aee filed text is byte-exact the current ungroundedIdRefusal envelope (update_feedback + intended run_command) — no framework drift', () => {
    // The production call site renders the MODEL-FACING tool name.
    expect(ungroundedIdRefusal('triage_ticket', [{ key: 'id', value: UF_ID }], 'run_command'))
      .toBe(TICKET_AFAC4AEE_TEXT);
  });

  it('the 769d7278 filed texts are byte-exact the executor existence-refusal format with the bare literal (the deterministic ownership gate — no framework defect)', async () => {
    expect(await mockToolCacheExec('update_document', { fileId: UD_ID })).toBe(EXISTENCE_TEXT);
  });

  it('verbatim-occurrence grounding: once the first refusal echo sits in the tool results, the identical placeholder is GROUNDED (haystack.includes) — the mechanism behind the incident\'s single tool_preflight row (the second update_feedback emission EXECUTED into the real tool instead of re-hitting the pre-flight)', () => {
    const firstRefusal = ungroundedIdRefusal('update_feedback', [{ key: 'id', value: UF_ID }], 'run_command');
    expect(firstRefusal).toContain(UF_ID); // the echo is inside the refusal JSON itself
    expect(findUngroundedIdArgs({ id: UF_ID }, `${BRIEF}\n${firstRefusal}`)).toEqual([]);
  });

  it('END-TO-END the incident ladder: {update_feedback: 2 trips, update_document: 1 trip} = 3 episodes ⇒ the run ends with the EXACT incident ender, ONE preflight row, the perma:false→perma:true ladder, both filings, and zero shell executions', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(ufTurn(1)) // ungrounded + intent ⇒ weighted 3 ⇒ TRIP 1 (one-round ban) — the ONLY preflight row
      .mockResolvedValueOnce(planTurn(2)) // ban round — harmless success
      .mockResolvedValueOnce(ufTurn(3)) // echo-grounded ⇒ EXECUTES into the mutation-gate refusal (count 2)
      .mockResolvedValueOnce(ufTurn(4)) // count 4 ⇒ TRIP 2 (perma on update_feedback)
      .mockResolvedValueOnce(udTurn(5)) // EXECUTES into the ownership gate (count 2)
      .mockResolvedValueOnce(udTurn(6)) // count 4 ⇒ TRIP 3 ⇒ TERMINAL (size 2 AND total 3)
      .mockResolvedValue(FINAL);

    const result = await runCodingAgent(makeInput(`${BRIEF}\nRun the watch tick now.`));

    // The incident's exact ender (msg 7466a063, finalized 23:35:58Z).
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes; intended tool appears to be run_command)');
    expect(result.modelErrored).toBeUndefined();

    // EXACTLY ONE preflight row — the incident's guard-row signature (the
    // second/third emissions were echo-grounded and executed).
    const preflight = strikes('tool_preflight').filter((m) => m.meta.reason === 'ungrounded_id');
    expect(preflight).toHaveLength(1);
    expect(preflight[0].meta).toMatchObject({ tool: 'update_feedback', intended: 'run_command' });

    // The perma ladder on update_feedback + the terminal row (23:35:58.872Z:
    // state ended_run, trips 3, tools [update_feedback, update_document],
    // intended run_command).
    const breaks = strikes('tool_derail_break');
    expect(breaks.some((m) => m.meta.tool === 'update_feedback' && m.meta.perma === false)).toBe(true);
    expect(breaks.some((m) => m.meta.tool === 'update_feedback' && m.meta.perma === true)).toBe(true);
    const ended = breaks.find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta).toMatchObject({ tool: 'update_document', perma: false, trips: 3, intended: 'run_command' });
    expect(ended!.meta.tools).toEqual(['update_feedback', 'update_document']);

    // Both auto-filings, exactly the two tickets' evidence: afac4aee carries
    // the ONE pre-flight envelope (its first-streak filing); 769d7278 carries
    // the TWO identical existence refusals (newest first).
    const filings = mockFileStreakInvestigation.mock.calls.map((c) => c[0]);
    const ufFiling = filings.find((f) => f.tool === 'update_feedback');
    const udFiling = filings.find((f) => f.tool === 'update_document');
    expect(ufFiling).toBeDefined();
    expect(ufFiling.recentFailures).toEqual([TICKET_AFAC4AEE_TEXT]);
    expect(ufFiling.intended).toBe('run_command');
    expect(udFiling).toBeDefined();
    expect(udFiling.recentFailures).toEqual([EXISTENCE_TEXT, EXISTENCE_TEXT]);
    expect(udFiling.intended).toBe('run_command');

    // Zero junk writes: the FIRST update_feedback call never executed
    // (preflight-refused); the two echo-grounded executions hit the mutation
    // gate; both document calls hit the ownership gate. run_command was NEVER
    // emitted — the incident signature (zero shell work).
    const ufExecs = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'update_feedback');
    expect(ufExecs).toHaveLength(2);
    expect(mockExecuteCodingTool.mock.calls.some((c) => c[1] === 'run_command')).toBe(false);
    expect(mockToolCacheExec.mock.calls.filter((c) => c[0] === 'update_document')).toHaveLength(2);
  });

  it('wiring seam: update_document rides the ToolCache/WEB document seam (NEVER the platform list, so the ungrounded-id pre-flight does not gate it — the supervisor\'s preflight hypothesis is disproven by design) while update_feedback stays a platform-gated tool', () => {
    expect(WEB_TOOL_NAMES.has('update_document')).toBe(true);
    expect(PLATFORM_TOOL_NAMES).not.toContain('update_document');
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
  });
});
