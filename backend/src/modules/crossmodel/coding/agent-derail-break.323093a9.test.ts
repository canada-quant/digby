/**
 * Replay pin — ticket 323093a9 (mishap, breaker trip 2026-09-20 ~05:53Z,
 * session ddd26be0-723d-4745-8bb5-be3ff4752d52 "QB2 Qwen3.8 Speed Mission
 * Successor", project tt-rd, kimi-k3, run c3240002-bef9-4862-9512-
 * cecfd5030cb6, scheduled firing 80; first streak this run; NO intended-tool
 * annotation on the filing).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak:
 * update_document' mishap with THREE failure texts (newest first):
 *   · No generated file with id placeholder2 belongs to this user. …
 *   · No generated file with id placeholder belongs to this user. …
 *   · No generated file with id placeholder belongs to this user. …
 * i.e. chronologically placeholder, placeholder, placeholder2 — VARYING
 * placeholder ids (the identical-call repeat breaker's evasion vector), each
 * EXECUTING into tool-executor.ts's honest existence refusal (712/780/875),
 * which post-PR-#895 counts as a failure for the breaker by design. Three
 * plain refusals = weighted 3 → TRIP, no fast-trip weights, no intended
 * annotation — exactly the filed shape.
 *
 * WHAT ACTUALLY HAPPENED (adjudication against the lane's live transcript,
 * 2026-09-20): firing 80 died ~74s after trigger (05:52:38Z → 05:53:52Z) mid
 * DEVICE-TIME measurement window — START sent to the bench box, stop/rm never
 * ran (a detached probe process left on the GPU host — the tt-rd
 * supervisor's steer 06:50:54Z led with the cleanup). The lane's reasoning
 * named run_command at the run-end note ("(3 episodes; intended tool appears
 * to be run_command)"); NO probe intent is documented anywhere. The lane
 * knew no document ids — "placeholder"/"placeholder2" are MODEL-authored
 * tokens (the f839cede placeholder-emission class), not framework garbles (a
 * garble would carry the intended call's real args). The NEXT firing (81,
 * 06:49:39Z) derailed identically — the recurring wrong-tool class that
 * ticket 0aecbe92 umbrellas and 78f32515's lane notice addresses.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR. Every
 * deterministic seam behaved as designed; the filed texts are byte-identical
 * to tool-executor.ts's current existence-refusal template (712/780/875).
 * NO platform code change.
 *
 * These tests pin: the three placeholder ids ground via the brief's echo
 * (the 00667344 verbatim-occurrence mechanism — the incident model narrated
 * the tokens first), three plain existence refusals trip the breaker at
 * weighted 3 with exactly the three filed texts (newest first), intended
 * stays unset, and first trip = one-round withhold (not perma). Scaffold
 * mirrors agent-derail-break.718a04a5.test.ts (ToolCache document seam).
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
// (WEB_TOOL_NAMES), not executeCodingTool. Keep the REAL TOOL_DEFINITIONS
// (the offered-tool list is built from it); stub only the executor instance
// to answer tool-executor.ts's honest existence refusal (712/780/875).
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

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// ── The incident's verbatim placeholder ids (chronological order) ──────────
const IDS = ['placeholder', 'placeholder', 'placeholder2'];

/** The tt-rd brief — carries BOTH tokens verbatim, mirroring the incident
 *  (the model narrated the placeholders before emitting them; the 00667344
 *  verbatim-occurrence echo grounds the calls so they EXECUTE into the
 *  existence check instead of dying in the pre-flight). */
const BRIEF = [
  '[QB2 speed mission — DEVICE-TIME window]',
  'The bench digests placeholder and placeholder2 are stand-in artifacts from',
  'prior ticks; refresh them after the measurement window closes. Shell work',
  'goes through the terminal. Every claim cites a this-run receipt.',
].join('\n');

const ENVELOPE = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;

/** A turn calling update_document on a placeholder id — the reasoning NAMES
 *  the called tool so the intent-mismatch fast-trip stays out of the replay:
 *  the incident filing carries NO intended annotation (its run-end note's
 *  "intended run_command" came from the derail breaker's OWN tracking, not
 *  this streak — the filed 3-text shape proves no intent weight rode this
 *  trip: 1+1+1=3 exactly). */
const docTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `update_document call ${n}: refresh the digest ${id} with the window's figures.`,
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Window closed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-323093a9-test',
  sessionId: 'sess-323093a9',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRefresh the digests now.`,
  emit: jest.fn(),
});

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay 323093a9 — three plain placeholder existence refusals read as a "3× streak" (no fast-trip weights)', () => {
  it('END-TO-END: three varying placeholder ids trip the breaker at weighted 3 with exactly the three filed texts (newest first) and NO intended annotation', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(docTurn(1, IDS[0])) // +1
      .mockResolvedValueOnce(docTurn(2, IDS[1])) // +1
      .mockResolvedValueOnce(docTurn(3, IDS[2])) // +1 = 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_document');
    expect(ev.perma).toBe(false);
    expect(ev.intended ?? null).toBeNull();
    // Exactly the incident's three texts, newest first (placeholder2, placeholder, placeholder).
    expect(ev.recentFailures).toEqual([
      ENVELOPE('placeholder2'),
      ENVELOPE('placeholder'),
      ENVELOPE('placeholder'),
    ]);
    // update_document never touched the platform executor seam.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(0);
  });

  it('the placeholder tokens ground via the brief echo (verbatim occurrence) — the calls EXECUTE into the existence check, never the pre-flight', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(docTurn(1, IDS[0]))
      .mockResolvedValueOnce(docTurn(2, IDS[1]))
      .mockResolvedValueOnce(docTurn(3, IDS[2]))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // All three calls reached the ToolCache executor (the existence refusal
    // came back) — an ungrounded pre-flight refusal would have produced the
    // NOT-EXECUTED envelope instead and zero executor calls.
    expect(mockToolCacheExec).toHaveBeenCalledTimes(3);
    expect(mockToolCacheExec.mock.calls.map((c) => c[0])).toEqual([
      'update_document', 'update_document', 'update_document',
    ]);
  });

  it('first trip = one-round withhold, NOT perma: the tool returns the round after next', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(docTurn(1, IDS[0]))
      .mockResolvedValueOnce(docTurn(2, IDS[1]))
      .mockResolvedValueOnce(docTurn(3, IDS[2])) // TRIP → withheld for the next model round
      .mockResolvedValueOnce(docTurn(4, 'placeholder3')) // refused: tool not offered (withheld)
      .mockResolvedValueOnce(docTurn(5, 'placeholder3')) // back on offer → executes into the same honest refusal
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // 3 incident calls + the post-withhold recovery call reached the executor;
    // the withheld round-4 call never did (toolNotOffered).
    expect(mockToolCacheExec).toHaveBeenCalledTimes(4);
  });
});
