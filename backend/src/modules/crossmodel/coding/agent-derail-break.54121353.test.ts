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
 * Replay pin — tickets 54121353 + 83297404 (ONE incident run, session
 * 619a1241-b080-4630-bfc3-5aa5456b1cd0 "Finding Flaws in Legal Bench Scores",
 * project canlegal-bench, kimi-k3, run cfcb9ee0-d5bf-48fc-b6a6-e03e264c21fc,
 * standby-watch firing 88 of 2026-09-20 06:44:09Z).
 *
 * THE INCIDENT: the lane's ENTIRE job that tick was one observation stamp
 * (observe_resource 719e0a51 — the silence-gate posture: no sends, no node
 * starts). Instead it produced:
 *   · 54121353: '3× tool-failure streak: update_feedback' with ONE failure
 *     text — the ungrounded-id pre-flight refusal for id="__none__", whose
 *     recovery line names observe_resource ("Your reasoning named
 *     observe_resource — you evidently meant to call observe_resource…");
 *   · 83297404: '3× tool-failure streak: update_document' with TWO failure
 *     texts — "No generated file with id __none__ belongs to this user"
 *     retried identically;
 * and the run ended 06:44:31Z with "[HARNESS] Run ended: repeated wrong-tool
 * derailment (3 episodes; intended tool appears to be observe_resource)".
 * Episode arithmetic mirrors the CanLaw composite (agent-derail-break.
 * b305c23e.test.ts): uf tripped twice (2nd perma, filing deduped) + ud once.
 *
 * WHAT ACTUALLY HAPPENED (adjudication against the lane's live transcript,
 * 2026-09-20): the derailed tick was a machine-triggered standby watch; NO
 * probe intent is documented anywhere — the lane's own prior tick (firing 86,
 * msg 2157ff2d) shows the healthy shape (observe_resource stamp + one-line
 * final). The id "__none__" literally narrates the model's awareness it had
 * no id — a MODEL-authored placeholder (the f839cede class); a framework
 * garble would have carried the real resource id 719e0a51, which the lane
 * knew and cited constantly. The supervisor's one-off recovery steer
 * (06:59:11Z) succeeded on the same seat (observe stamp 07:00:15.940Z, msg
 * cbcd09ab) — transient decoder state, not a routing fault.
 *
 * VERDICT (the tickets' mandated investigation): MODEL BEHAVIOR. Every
 * deterministic seam behaved as designed; the filed texts diff clean against
 * current framework code (tool-preflight.ts:278 for the ungrounded envelope;
 * tool-executor.ts:712/780/875 for the existence refusal, which post-PR-#895
 * counts as a failure by design). NO platform code change.
 *
 * Scaffold mirrors agent-derail-break.aff1c189.test.ts +
 * agent-derail-break.718a04a5.test.ts (ToolCache document seam).
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
import { findUngroundedIdArgs, ungroundedIdRefusal } from './tool-preflight';
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

// ── The incident's verbatim id ──────────────────────────────────────────────
const CALL_ID = '__none__'; // the model-authored placeholder for BOTH tools

/** The standby-watch brief. For the update_feedback suite it carries NO
 *  occurrence of __none__ (the pre-flight refuses ungrounded — the 54121353
 *  shape); the update_document suite injects the echo into the USER message
 *  (the incident lane narrated the token before emitting it — the 00667344
 *  verbatim-occurrence mechanism — so its calls EXECUTED into the existence
 *  check, the 83297404 shape). */
const BRIEF = [
  '[T350 STANDBY WATCH — one observation stamp, then a one-line tick]',
  'Probe the transcript for external news, check open owner-questions, stamp',
  'the watched resource 719e0a51 as observed (nodes STOPPED, $0 spend), and',
  'end with the owner-ETA line. Silence gate: no sends, no node starts.',
].join('\n');

/** Intent-convicted turn: reasoning names observe_resource (whole word,
 *  NEVER the called tool) — the REAL detectIntendedTool convicts (+1
 *  fast-trip), exactly the tickets' "reasoning named observe_resource". */
const INTENT_REASONING =
  'The tick closes with the resource stamp — observe_resource on 719e0a51 with the standby note is the one action that matters.';
const mkTurn = (n: number, tool: string, args: any, intent: boolean) => ({
  content: '',
  reasoning: intent
    ? INTENT_REASONING
    : `${tool} call ${n}: record the bookkeeping for id ${args.id ?? args.fileId}.`,
  toolCalls: [{ id: `t${n}`, name: tool, arguments: JSON.stringify(args) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Tick closed.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string): AgentRunInput => ({
  worktree: '/tmp/derail-54121353-test',
  sessionId: 'sess-54121353',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage,
  emit: jest.fn(),
});

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay 54121353 — one placeholder-id update_feedback with intent mismatch (the standby-tick derailment)', () => {
  it('"__none__" is ungrounded against the run haystack (not id-shaped; appears nowhere the model read)', () => {
    expect(findUngroundedIdArgs({ id: CALL_ID }, BRIEF))
      .toEqual([{ key: 'id', value: CALL_ID }]);
  });

  it('replays the exact refusal envelope from the filed text (the recovery line names observe_resource)', () => {
    const refusal = JSON.parse(
      ungroundedIdRefusal('update_feedback', [{ key: 'id', value: CALL_ID }], 'observe_resource'),
    );
    expect(refusal).toMatchObject({
      ok: false,
      tool: 'update_feedback',
      reason: 'ungrounded_id',
      rejected: [{ key: 'id', value: CALL_ID }],
    });
    expect(refusal.message).toContain('NOT EXECUTED');
    expect(refusal.message).toContain('Your reasoning named observe_resource — you evidently meant to call observe_resource; call it now with its real parameters.');
  });

  it('END-TO-END: ONE call trips the breaker at weighted 3 (+1 refusal, +1 ungrounded fast-trip, +1 intent fast-trip) with exactly the one filed text and intended=observe_resource', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(mkTurn(1, 'update_feedback', { id: CALL_ID }, true)) // weighted 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput(`${BRIEF}\nRun the tick now.`));

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(0);
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_feedback');
    expect(ev.perma).toBe(false);
    expect(ev.intended).toBe('observe_resource');
    expect(ev.recentFailures).toHaveLength(1);
    const filed = JSON.parse(ev.recentFailures[0]);
    expect(filed).toMatchObject({
      ok: false, tool: 'triage_ticket', reason: 'ungrounded_id', // preflight envelope renders the MODEL-FACING name
      rejected: [{ key: 'id', value: CALL_ID }],
    });
  });
});

describe('replay 83297404 — the same placeholder fed to update_document twice (existence refusals count post-#895)', () => {
  it('END-TO-END: two echo-grounded calls trip at weighted 3 (+1 existence refusal, +1 intent fast-trip; +1 refusal) with exactly the two filed texts and intended=observe_resource', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(mkTurn(1, 'update_document', { fileId: CALL_ID }, true))  // +1 refusal, +1 intent = 2
      .mockResolvedValueOnce(mkTurn(2, 'update_document', { fileId: CALL_ID }, false)) // +1 = 3 → TRIP
      .mockResolvedValue(FINAL);

    // The incident lane narrated "__none__" before emitting it — the echo
    // grounds the id (verbatim occurrence) so the calls EXECUTE into the
    // existence check instead of dying in the pre-flight.
    await runCodingAgent(makeInput(`${BRIEF}\nNo ticket applies — think of it as __none__ — refresh the digest now.`));

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_document');
    expect(ev.perma).toBe(false);
    expect(ev.intended).toBe('observe_resource');
    expect(ev.recentFailures).toHaveLength(2);
    expect(ev.recentFailures[0]).toBe(`No generated file with id ${CALL_ID} belongs to this user. Call list_files to see the current files.`);
    expect(ev.recentFailures[1]).toBe(`No generated file with id ${CALL_ID} belongs to this user. Call list_files to see the current files.`);
    // update_document never touched the platform executor seam.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(0);
  });

  it('wiring seam: observe_resource stays a real offered platform tool (the intended action the lane never took)', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('observe_resource');
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
  });
});
