/**
 * REPLAY TEST — ticket d73765fc (mishap, 2026-09-22): "3× tool-failure
 * streak: search_memory on 'spark-cluster Supervisor' — framework or
 * model?"
 *
 * THE INCIDENT (verified against live evidence 2026-09-22):
 *   · chat 9e6e1712 (spark-cluster Supervisor, CHAT profile, deepseek-flash)
 *     answered the owner's 22:01Z question; its turn reasoning narrated
 *     web_pipe while the emitted calls were search_memory ×5 consecutive —
 *     every call SUCCEEDED.
 *   · loop_metrics guard_strike rows for that chat: tool_derail_reanchor
 *     (reason intent_mismatch_success, intended web_pipe, churned:false)
 *     22:06:19Z, then tool_derail_break (shape success_intent, perma:false)
 *     22:06:23Z — the 2c98b460 success-side ladder steering at 3 and tripping
 *     at 5, exactly as designed. The lane recovered and delivered a coherent
 *     final 35 s later (msg c229ca70). Zero tool_intent_attribution
 *     guard_miss rows — the 58e675c9 discount classes (precomputed duty /
 *     preamble-ordered) did NOT match, so this is not a known-benign FP.
 *   · Both guard fixes (c737d007 e3417bf98, 58e675c9 28d8920e4) are
 *     ancestors of the live box sha c4396a38 — the trip is post-rollout,
 *     not a regression window.
 *
 * THE DEFECT THIS TICKET EXPOSED (deterministic, framework-side): the
 * auto-filed investigation ticket + the cross-checker consult rendered the
 * trip under the FIXED "3× tool-failure streak" title and "Failure texts"
 * header — every surface (notice, progress, metric) had been threaded with
 * the trip's shape by 2c98b460/c737d007 EXCEPT the reflection filing and
 * consult surfaces, one level down. A 5× SUCCESS-side wrong-tool loop
 * therefore landed in the queue mislabeled as a tool-failure streak — the
 * d73765fc artifact itself is the evidence (its description says "kept
 * SUCCEEDING" while its title says "tool-failure streak").
 *
 * ADJUDICATION (recorded on the ticket): the streak is MODEL behavior
 * (decoder-locked wrong-tool emission on successful calls — contained by
 * the guard, post-rollout of c737d007/58e675c9); the mislabel is the
 * framework fix pinned here.
 *
 * THE FIX (this pin + reflection.d73765fc.test.ts): StreakEvidence.shape
 * ('failure' default | 'success_intent') threads derailNoticeShape into
 * fileStreakInvestigation + consultCrossCheckerOnStreak at BOTH agent-loop
 * call sites (the deferred-notice reflection block and the N1 terminal-end
 * parity filing). This file pins the LOOP side: the payload the loop hands
 * to the filing surface carries the shape; the rendering bytes are pinned
 * unit-side in reflection.d73765fc.test.ts.
 *
 * Scaffold mirrors agent-derail-break.c737d007.test.ts (the sibling
 * success-side replay): every mismatched call SUCCEEDS so the failure
 * ladder is blind; the called tool stays search_memory while the reasoning
 * names web_pipe every turn (the IDENTICAL pair — churned:false, the
 * legacy 2c98b460 catch). No run_command anywhere (the scaffold's
 * container mock would leak to a real shell).
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

// Every tool SUCCEEDS ('probe result: ok') — nothing failure-shaped ever
// appears; mockExecuteCodingTool's real signature is (ctx, name, args).
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, _name: string, _args: any) => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const mockToolCacheExec: jest.Mock = jest.fn(async (_name: string, _args: any) => 'probe result: ok');
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
import { detectIntendedTool } from './tool-preflight';

/** CODING profile (no workspace container in the scaffold). */
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const BRIEF = 'Answer the owner: where do the llama-bench results live, and is the card config the live one?';

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-d73765fc-test',
  sessionId: 'sess-d73765fc',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'deepseek-flash',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

/**
 * THE INCIDENT SHAPE: the called tool is decoder-locked on search_memory
 * while EVERY turn's reasoning names web_pipe — the IDENTICAL pair
 * (churned:false), five consecutive SUCCEEDING calls. Args vary by WORD so
 * the exact and digit-collapsed repeat signatures stay blind.
 */
const R_WP = 'Now web_pipe to ingest the benchmark thread pages before answering.';
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
const smTurn = (n: number) => ({
  content: '',
  reasoning: R_WP,
  toolCalls: [{ id: `t${n}`, name: 'search_memory', arguments: JSON.stringify({ query: `bench results ${WORDS[(n - 1) % WORDS.length]}` }) }],
  finishReason: 'tool_calls',
});
/** A failing call for the regression leg — narration names NO offered tool
 *  (no intent weight; pure 3× failure so the FAILURE ladder owns the trip). */
const failTurn = (n: number) => ({
  content: '',
  reasoning: 'Checking the memory index again for the bench doc.',
  toolCalls: [{ id: `f${n}`, name: 'search_memory', arguments: JSON.stringify({ query: `attempt ${WORDS[(n - 1) % WORDS.length]}` }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'They live on the session branch, not main.', reasoning: '', toolCalls: [], finishReason: 'stop' };

// ── Compound-batch builders (reviewer 8d77c84f follow-up, 2026-09-23) ──
// The deferred-notice slot is written by a trip and flushed after the batch;
// two trips in ONE batch make the LAST writer own the filing. Only a PERMA
// trip leaves withheldTool clear for a second tool's trip in the same batch,
// so both compound orderings start from a perma trip.
const smCall = (n: number) => ({ id: `s${n}`, name: 'search_memory', arguments: JSON.stringify({ query: `bench results ${WORDS[(n - 1) % WORDS.length]}` }) });
const rfCall = (n: number) => ({ id: `r${n}`, name: 'read_file', arguments: JSON.stringify({ path: `docs/bench-${WORDS[(n - 1) % WORDS.length]}.md` }) });
const lfCall = (n: number) => ({ id: `l${n}`, name: 'list_files', arguments: JSON.stringify({ path: `docs/` }) });
const turnOf = (reasoning: string, calls: Array<{ id: string; name: string; arguments: string }>) => ({ content: '', reasoning, toolCalls: calls, finishReason: 'tool_calls' as const });
/** Aligned filler turn — rides out a one-round withhold without touching either streak. */
const ALIGNED = () => turnOf('Listing the docs folder to find the bench doc.', [lfCall(1)]);
/** read_file fails, every other tool succeeds — set on BOTH dispatch mocks. */
const perToolResults = () => {
  mockExecuteCodingTool.mockImplementation(async (_ctx: any, name: string) => (name === 'read_file' ? 'Tool read_file failed: index unreachable' : 'probe result: ok'));
  mockToolCacheExec.mockImplementation(async (name: string) => (name === 'read_file' ? 'Tool read_file failed: index unreachable' : 'probe result: ok'));
};
const filings = () => mockFileStreakInvestigation.mock.calls.map((c) => c[0]);

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const reanchorMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_reanchor');
const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
const userTexts = () => (conversation() || []).filter((m) => m?.role === 'user').map((m) => String(m.content));

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket d73765fc — success-side trips file truthfully (never a "3× tool-failure streak")', () => {
  it('UNIT: the incident premise — successes are invisible to the failure detector, and the web_pipe narration convicts on every search_memory turn', () => {
    const offered = new Set(['search_memory', 'web_pipe', 'list_files', 'update_plan', 'todo_list']);
    expect(looksLikeToolFailure('probe result: ok')).toBe(false);
    expect(detectIntendedTool(R_WP, 'search_memory', offered)).toBe('web_pipe');
  });

  it('REPLAY the incident: search_memory ×5 SUCCEEDING under web_pipe narration trips the success ladder AND the attribution payload carries shape:"success_intent"', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(smTurn(1))
      .mockResolvedValueOnce(smTurn(2))
      .mockResolvedValueOnce(smTurn(3)) // third ⇒ re-anchor armed
      .mockResolvedValueOnce(smTurn(4))
      .mockResolvedValueOnce(smTurn(5)) // fifth ⇒ TRIP 1
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The run CONTAINED the loop and finished (the guard's job).
    expect(result.finalText).toContain('They live on the session branch');
    expect(reanchorMetrics()).toHaveLength(1);
    expect(reanchorMetrics()[0].meta).toMatchObject({ reason: 'intent_mismatch_success', intended: 'web_pipe', churned: false });
    const trip = breakerMetrics().find((m) => m.meta.shape === 'success_intent');
    expect(trip).toBeDefined();
    expect(trip!.meta).toMatchObject({ tool: 'search_memory', perma: false, intended: 'web_pipe', churned: false });
    // The lane-visible notice tells the success truth (2c98b460 surface).
    expect(userTexts().some((t) => t.includes('all SUCCEEDED') && t.includes('search_memory'))).toBe(true);

    // d73765fc: the ATTRIBUTION payload now threads the shape — before this
    // fix every trip filed under the "3× tool-failure streak" template
    // regardless of which ladder tripped.
    expect(mockFileStreakInvestigation).toHaveBeenCalled();
    const filed = mockFileStreakInvestigation.mock.calls.find((c) => c[0]?.tool === 'search_memory');
    expect(filed).toBeDefined();
    expect(filed![0].shape).toBe('success_intent');
    expect(String(filed![0].recentFailures[0])).toContain('wrong-tool derailment on successful calls');
    expect(String(filed![0].recentFailures[0])).toContain('search_memory→web_pipe ×5 consecutive');
    // The consult receives the same shape-bearing evidence.
    const consulted = mockConsultCrossCheckerOnStreak.mock.calls.find((c) => c[0]?.tool === 'search_memory');
    expect(consulted).toBeDefined();
    expect(consulted![0].shape).toBe('success_intent');
  });

  it('REGRESSION: the classic 3× FAILURE streak (no intent conviction) files with the failure shape — the legacy rendering path is preserved', async () => {
    const failing = 'Tool search_memory failed: index unreachable';
    mockExecuteCodingTool.mockResolvedValue(failing);
    mockToolCacheExec.mockResolvedValue(failing);
    mockRunModelTurn
      .mockResolvedValueOnce(failTurn(1))
      .mockResolvedValueOnce(failTurn(2))
      .mockResolvedValueOnce(failTurn(3)) // third failure ⇒ TRIP
      .mockResolvedValue(FINAL);
    const input = makeInput();
    await runCodingAgent(input);

    expect(mockFileStreakInvestigation).toHaveBeenCalled();
    const filed = mockFileStreakInvestigation.mock.calls.find((c) => c[0]?.tool === 'search_memory');
    expect(filed).toBeDefined();
    expect(filed![0].shape ?? 'failure').toBe('failure');
  });

  // ── Compound batch (reviewer 8d77c84f follow-up, 2026-09-23): two trips
  // in ONE turn — the LAST writer must own EVERY deferred-notice slot field
  // (texts, tool, shape, churned, perma). Before the fix, the failure trip
  // overwrote texts+tool but inherited shape='success_intent' from the
  // earlier perma success trip, filing the FAILURE streak as "5×
  // success-side wrong-tool loop … every call SUCCEEDED" over failure texts
  // — the INVERSE of the original d73765fc mislabel, newly introduced. ──
  it('COMPOUND: a same-batch PERMA success trip followed by 3 failing read_file calls files the FAILURE trip as failure — the shape slot does not leak from the earlier trip', async () => {
    perToolResults();
    // Turns 1-6: search_memory ×5 succeeding under web_pipe narration
    // (trips 1 + 2 ⇒ PERMA), then an aligned list_files filler turn to
    // consume trip 1's one-round withhold.
    mockRunModelTurn
      .mockResolvedValueOnce(smTurn(1))
      .mockResolvedValueOnce(smTurn(2))
      .mockResolvedValueOnce(smTurn(3))
      .mockResolvedValueOnce(smTurn(4))
      .mockResolvedValueOnce(smTurn(5)) // FIFTH ⇒ TRIP 1 (one-round withhold)
      .mockResolvedValueOnce(ALIGNED()) // aligned filler rides out the withhold
      .mockResolvedValueOnce(smTurn(6)) // FIFTH again ⇒ TRIP 2 ⇒ PERMA
      // Turn 8: the compound batch — 3 read_file failures whose reasoning
      // names no offered tool (pure failure streak ⇒ TRIP 3 on read_file).
      .mockResolvedValueOnce(turnOf('Re-reading the bench doc sections that matter.', [rfCall(1), rfCall(2), rfCall(3)]))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // The failure trip filed with the FAILURE shape over failure texts.
    const rfFiled = filings().find((f: any) => f?.tool === 'read_file');
    expect(rfFiled).toBeDefined();
    expect(rfFiled!.shape ?? 'failure').toBe('failure');
    expect(String(rfFiled!.recentFailures[0])).toContain('index unreachable');
    // The terminal end carries the LAST trip's own perma (false — the
    // earlier success trip's perma=true did not leak into the slot).
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta.tool).toBe('read_file');
    expect(ended!.meta.perma).toBe(false);
  });

  it('COMPOUND (flipped control): a same-batch PERMA failure trip followed by 5 succeeding search_memory calls files the SUCCESS trip as success_intent — perma does not leak either', async () => {
    perToolResults();
    // Turns 1-6: read_file ×3 failing turns (trips 1 + 2 ⇒ PERMA on
    // read_file), with an aligned list_files filler turn to consume trip 1's
    // one-round withhold.
    const rfFailTurn = (n: number) => turnOf('Re-reading the bench doc sections that matter.', [rfCall(n)]);
    mockRunModelTurn
      .mockResolvedValueOnce(rfFailTurn(1))
      .mockResolvedValueOnce(rfFailTurn(2))
      .mockResolvedValueOnce(rfFailTurn(3)) // third failure ⇒ TRIP 1 (one-round withhold)
      .mockResolvedValueOnce(ALIGNED()) // aligned filler rides out the withhold
      .mockResolvedValueOnce(rfFailTurn(4))
      .mockResolvedValueOnce(rfFailTurn(5)) // third again ⇒ TRIP 2 ⇒ PERMA
      // Turn 7: the compound batch — 5 succeeding search_memory calls under
      // web_pipe narration (⇒ TRIP 3 on search_memory, success side).
      .mockResolvedValueOnce(turnOf(R_WP, [smCall(6), smCall(7), smCall(8), smCall(9), smCall(10)]))
      .mockResolvedValue(FINAL);
    await runCodingAgent(makeInput());

    // The success trip filed with the SUCCESS shape over success texts.
    const smFiled = filings().find((f: any) => f?.tool === 'search_memory');
    expect(smFiled).toBeDefined();
    expect(smFiled!.shape).toBe('success_intent');
    expect(String(smFiled!.recentFailures[0])).toContain('wrong-tool derailment on successful calls');
    // The terminal end carries the LAST trip's own perma (false — the
    // earlier failure trip's perma=true did not leak into the slot).
    const ended = breakerMetrics().find((m) => m.meta.state === 'ended_run');
    expect(ended).toBeDefined();
    expect(ended!.meta.tool).toBe('search_memory');
    expect(ended!.meta.perma).toBe(false);
  });
});
