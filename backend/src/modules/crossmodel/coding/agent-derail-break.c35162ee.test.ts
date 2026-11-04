/**
 * Replay pin — ticket c35162ee (mishap, auto-filed 2026-09-20T17:37:55Z at
 * the update_document derail-break trip; session
 * 521020fe-ebe5-4d97-8b58-fdbe8c95445f "Spark Lane Branch State Verification",
 * project spark-cluster, run 6216870c-c15f-4854-bea8-df47663ff6f5).
 *
 * THE INCIDENT: the lane's job that tick was a schedule state check
 * (list_schedules). Instead it emitted update_document with the model-authored
 * placeholder fileIds "probe" then "probe2" while its own reasoning named
 * list_schedules. Filed failure texts (newest first, verbatim from the ticket):
 *   · No generated file with id probe2 belongs to this user. Call list_files to see the current files.
 *   · No generated file with id probe belongs to this user. Call list_files to see the current files.
 * The run ended 17:34:59Z: "[HARNESS] Run ended: repeated wrong-tool
 * derailment (3 episodes; intended tool appears to be list_schedules)."
 * Guard rows for run 6216870c (supervisor pull, asOf 18:26Z): 17:35:21Z
 * derail_reanchor on update_feedback (intent_mismatch, intended
 * list_schedules) → 17:35:24Z + 17:36:16Z derail_break on update_feedback
 * (perma:false→true) → 17:37:05Z repeat_break on update_supervisor_state →
 * 17:37:22Z preflight on update_schedule (ungrounded_id, intended
 * run_command) → 17:37:55Z derail_break on update_document, state ended_run,
 * tools [update_feedback, update_document], intended list_schedules — the
 * decoder lock MIGRATED across the whole update_* family.
 *
 * VERDICT (adjudicated by lane b92ef13f, runs 1bcc0c79 + cb1244b8, with the
 * two supervisor-pulled evidence legs above): MODEL BEHAVIOR — the
 * placeholder-emission wrong-tool derail class (f839cede/aff1c189/ec9d7424).
 * The existence refusal is the deterministic ownership gate; every containment
 * seam (re-anchor 431518a2, derail break, repeat break 54a172ac) fired as
 * designed with zero junk writes in the source run. NO platform code change.
 * Companion finding (this lane's own run 1bcc0c79): the repeat-break ladder
 * (1 round → 3 → the run) lets identical placeholder writes EXECUTE between
 * withhold windows — detection held on every seam, side-effect prevention
 * partial. Pinned in the ladder test below.
 *
 * Scaffold mirrors agent-derail-break.54121353.test.ts (ToolCache document
 * seam) + agent-loop-volume.54a172ac.test.ts (strikes helper).
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

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { findUngroundedIdArgs } from './tool-preflight';
import { PLATFORM_TOOL_NAMES } from '../platform/platform-tool-names';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};
// The ladder replay needs ~12 model turns — one profile with a bigger budget.
const LADDER_TEST_PROFILE: AgentProfile = { ...CHAT_TEST_PROFILE, maxSteps: 20 };

// ── The incident's verbatim placeholder ids + filed texts (newest first) ────
const ID1 = 'probe';
const ID2 = 'probe2';
const existenceText = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const FILED_NEWEST_FIRST = [existenceText(ID2), existenceText(ID1)];

/** The verification-tick brief. Carries NO occurrence of probe/probe2 — the
 *  incident lane narrated the tokens before emitting them (the 00667344
 *  verbatim-occurrence mechanism), so the grounded variant injects the echo
 *  into the USER message exactly like 83297404's "__none__" echo. */
const BRIEF = [
  '[SPARK LANE BRANCH STATE VERIFICATION — standby tick]',
  'Verify the branch state, check the schedule cadence, stamp the tick, and',
  'end with a one-line status. Silence gate: no sends.',
].join('\n');
const ECHO = 'The earlier probes (probe, probe2) found nothing scheduled.';

/** Intent-convicted turn: reasoning names list_schedules (whole word, NEVER
 *  the called tool) — the REAL detectIntendedTool convicts (+1 fast-trip),
 *  exactly the ticket's "lane's reasoning named list_schedules". */
const INTENT_REASONING =
  'The verification tick starts from the cadence state — list_schedules shows whether the nightly fired; then the branch state can be stamped.';
const mkTurn = (n: number, tool: string, args: any, intent: boolean) => ({
  content: '',
  reasoning: intent
    ? INTENT_REASONING
    : `${tool} call ${n}: record the bookkeeping for id ${args.id ?? args.fileId}.`,
  toolCalls: [{ id: `t${n}`, name: tool, arguments: JSON.stringify(args) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick closed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string, profile: AgentProfile = CHAT_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/derail-c35162ee-test',
  sessionId: 'sess-c35162ee',
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

describe('ticket c35162ee — placeholder fileIds probe/probe2 fed to update_document while the narration named list_schedules', () => {
  it('grounding asymmetry: probe/probe2 are ungrounded against the bare brief, grounded once the lane echoes them (the 00667344 verbatim-occurrence mechanism that let the incident calls reach the executor)', () => {
    expect(findUngroundedIdArgs({ fileId: ID1 }, BRIEF)).toEqual([{ key: 'fileId', value: ID1 }]);
    expect(findUngroundedIdArgs({ fileId: ID2 }, BRIEF)).toEqual([{ key: 'fileId', value: ID2 }]);
    expect(findUngroundedIdArgs({ fileId: ID1 }, `${BRIEF}\n${ECHO}`)).toEqual([]);
    expect(findUngroundedIdArgs({ fileId: ID2 }, `${BRIEF}\n${ECHO}`)).toEqual([]);
  });

  it('the two filed texts are byte-exact the executor existence-refusal format (the deterministic ownership gate — no framework defect)', async () => {
    expect(await mockToolCacheExec('update_document', { fileId: ID1 })).toBe(FILED_NEWEST_FIRST[1]);
    expect(await mockToolCacheExec('update_document', { fileId: ID2 })).toBe(FILED_NEWEST_FIRST[0]);
  });

  it('END-TO-END: two echo-grounded update_document calls (probe intent-convicted, probe2 plain) trip at weighted 3 with exactly the two filed texts, newest first, intended=list_schedules — and the platform executor seam is never touched', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(mkTurn(1, 'update_document', { fileId: ID1 }, true))  // +1 existence refusal, +1 intent fast-trip = 2
      .mockResolvedValueOnce(mkTurn(2, 'update_document', { fileId: ID2 }, false)) // +1 = 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput(`${BRIEF}\n${ECHO}\nRun the verification tick now.`));

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(0); // document seam rides ctx.toolCache only
    expect(mockToolCacheExec).toHaveBeenCalledTimes(2);
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_document');
    expect(ev.perma).toBe(false);
    expect(ev.intended).toBe('list_schedules');
    expect(ev.recentFailures).toEqual(FILED_NEWEST_FIRST);
  });

  it('END-TO-END ladder (the 1bcc0c79 companion finding): 12 identical update_feedback writes walk the repeat-break ladder trips 1→2→3 (rounds 1→3→run) while calls keep EXECUTING between withhold windows — detection holds, side-effect prevention partial', async () => {
    const TICKET_UUID = 'c35162ee-63e1-4027-a092-6e8a9b2eda6c';
    const ufTurn = (n: number) => ({
      content: '',
      reasoning: `update_feedback call ${n}: set the adminNote on ticket ${TICKET_UUID}.`,
      toolCalls: [{ id: `u${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: TICKET_UUID, adminNote: 'placeholder' }) }],
      finishReason: 'tool_calls',
    });
    for (let n = 1; n <= 12; n += 1) mockRunModelTurn.mockResolvedValueOnce(ufTurn(n));
    mockRunModelTurn.mockResolvedValue(FINAL);

    // The real ticket id lives in the user message → the uuid-shaped id is
    // grounded (haystack presence), so every call passes the preflight and
    // reaches the (mocked) executor — the 12 "adminNote set" receipts of run
    // cb1244b8.
    await runCodingAgent(makeInput(
      `${BRIEF}\nTicket ${TICKET_UUID} is the investigation target.\nRun the tick now.`,
      LADDER_TEST_PROFILE,
    ));

    const rep = strikes('tool_repeat_break');
    expect(rep.map((s) => s.meta.trips)).toEqual([1, 2, 3]);
    expect(rep.map((s) => s.meta.rounds)).toEqual([1, 3, 'run']);
    expect(rep.every((s) => s.meta.tool === 'update_feedback')).toBe(true);
    // Partial side-effect prevention: writes kept passing between the windows.
    expect(mockExecuteCodingTool.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('wiring seam: list_schedules (the intended action the lane never took) and update_feedback stay real offered platform tools', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('list_schedules');
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
  });
});
