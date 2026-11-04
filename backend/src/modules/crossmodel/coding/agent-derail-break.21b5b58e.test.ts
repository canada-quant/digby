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
 * Replay pin — ticket 21b5b58e (mishap, breaker trip 2026-09-20 ~06:31Z,
 * session 521020fe-ebe5-4d97-8b58-fdbe8c95445f "Spark Lane Branch State
 * Verification", project spark-cluster, run ce053da7-4e76-4e37-a13c-
 * 9b5e37a9fb28; first streak this run; lane's reasoning named run_command).
 *
 * THE INCIDENT: the breaker auto-filed a '3× tool-failure streak:
 * update_feedback' mishap with ONE failure text:
 *   `{ "ok": false, "tool": "update_feedback", "reason": "ungrounded_id",
 *     "rejected": [{ "key": "id", "value": "noop" }],
 *     "message": "NOT EXECUTED: update_feedback was called with id=\"noop\",
 *      which is not an id you obtained this run — … Your reasoning named
 *      run_command — you evidently meant to call run_command; call it now
 *      with its real parameters." }`
 * A single call read as a "3×" streak: ungrounded refusal +1, ungrounded
 * fast-trip +1 ("an invented id is never real work"), intent-mismatch
 * fast-trip +1 (the model's own reasoning named run_command) = 3 → TRIP.
 *
 * WHAT ACTUALLY HAPPENED (adjudication against the lane's live transcript,
 * 2026-09-20): the spark lane (kimi-k3, machine-triggered) was mid
 * supervisor-coordinated cluster work; no probe intent is documented anywhere
 * in the run — the emitted update_feedback with the model-authored id "noop"
 * is the placeholder-emission dispatch-loop class (tickets f839cede /
 * aff1c189 / ec9d7424, learnings.md): the model NARRATES one tool while
 * EMITTING another with a placeholder id. The lane recovered on its next
 * firing and is productive (supervisor conv-A/B GO 07:05Z, transcript msg
 * c55d551d) — no framework remediation followed, none was needed.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR. Every
 * deterministic seam behaved as designed, and the filed text diffs clean
 * against current framework code:
 *   · the id-grounding PRE-FLIGHT refused the invented id NOT EXECUTED
 *     (tool-preflight.ts:278 — the message template is byte-identical to the
 *     filed text, including the "Your reasoning named run_command" recovery
 *     line — PR #891 lineage);
 *   · the breaker weighted 1+1+1=3 as designed (agent.ts:3171-3183);
 *   · nothing reached the executor; the ticket id "noop" was never a real
 *     ticket (a framework garble would have carried real args).
 * NO platform code change.
 *
 * These tests pin: "noop" is ungrounded against the run haystack, the refusal
 * envelope matches the filed text (with the intent recovery line), ONE call
 * trips the breaker at weighted 3 with exactly the one filed text and
 * intended=run_command, zero calls reach the executor, and first trip =
 * one-round withhold (not perma). Scaffold mirrors
 * agent-derail-break.aff1c189.test.ts + the intent-stub seam of
 * agent-derail-break.87d1e421.test.ts.
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

// ── The incident's verbatim id (ticket 21b5b58e) ────────────────────────────
const CALL_ID = 'noop';
const RECOVERY_ID = '21b5b58e'; // 8-hex — shape-valid citation for the recovery call

/** The spark-lane brief — deliberately free of "noop", so the call id is
 *  UNGROUNDED in this run's haystack. */
const BRIEF = [
  '[Spark lane — branch state verification tick]',
  'Fetch the remote refs, compare against local HEAD, classify the session',
  'branches, run the policy grep, and record the verdict. Shell work goes',
  'through the terminal. Every claim cites a this-run receipt.',
].join('\n');

/** Stub so the REAL detectIntendedTool sees run_command as offered — it was a
 *  live offered tool in the lane's coding-profile run; the chat test profile
 *  does not offer workspace tools, so the extraTools seam (agent.ts:967)
 *  stands in, mirroring agent-derail-break.87d1e421.test.ts. */
const RUN_COMMAND_STUB = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'test stub — present so intent detection sees it offered',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: jest.fn(async () => 'shell ok'),
};

/** The incident turn's shape: the reasoning names run_command (a whole word,
 *  NEVER the called tool) so the REAL detectIntendedTool convicts it
 *  (+1 fast-trip, agent.ts:3181-3183) — exactly the ticket's "lane's
 *  reasoning named run_command" annotation. */
const INTENT_REASONING =
  'Time to run the shell verification — run_command with git fetch and ls-remote is the right call now.';
const intentTurn = (n: number, id: string) => ({
  content: '',
  reasoning: INTENT_REASONING,
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id }) }],
  finishReason: 'tool_calls',
});
const recoveryTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `update_feedback call ${n}: record the verdict on ticket ${id} per the run's bookkeeping.`,
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Verification recorded.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/derail-21b5b58e-test',
  sessionId: 'sess-21b5b58e',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `${BRIEF}\nRun the verification now.`,
  emit: jest.fn(),
  extraTools: [RUN_COMMAND_STUB],
});

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay 21b5b58e — one placeholder-id update_feedback with intent mismatch reads as a "3× streak"', () => {
  it('"noop" is ungrounded against the run haystack (not id-shaped; appears nowhere the model read)', () => {
    expect(findUngroundedIdArgs({ id: CALL_ID }, BRIEF))
      .toEqual([{ key: 'id', value: CALL_ID }]);
  });

  it('replays the exact refusal envelope from the filed text (ungrounded_id, NOT EXECUTED, the intent recovery line naming run_command)', () => {
    const refusal = JSON.parse(
      ungroundedIdRefusal('update_feedback', [{ key: 'id', value: CALL_ID }], 'run_command'),
    );
    expect(refusal).toMatchObject({
      ok: false,
      tool: 'update_feedback',
      reason: 'ungrounded_id',
      rejected: [{ key: 'id', value: CALL_ID }],
    });
    expect(refusal.message).toContain('NOT EXECUTED');
    expect(refusal.message).toContain('never from narration');
    expect(refusal.message).toContain('Your reasoning named run_command — you evidently meant to call run_command; call it now with its real parameters.');
  });

  it('END-TO-END: ONE call trips the breaker at weighted 3 (+1 refusal, +1 ungrounded fast-trip, +1 intent fast-trip) with exactly the one filed text and intended=run_command — nothing reaches the executor', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(intentTurn(1, CALL_ID)) // weighted 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(0);
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_feedback');
    expect(ev.perma).toBe(false);
    expect(ev.intended).toBe('run_command');
    expect(ev.recentFailures).toHaveLength(1);
    const filed = JSON.parse(ev.recentFailures[0]);
    expect(filed).toMatchObject({
      ok: false, tool: 'triage_ticket', reason: 'ungrounded_id', // preflight envelope renders the MODEL-FACING name
      rejected: [{ key: 'id', value: CALL_ID }],
    });
    expect(filed.message).toContain('NOT EXECUTED');
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (shape-valid citation, lane keeps working)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(intentTurn(1, CALL_ID))        // weighted 3 → TRIP, withheld for the next model round
      .mockResolvedValueOnce(recoveryTurn(2, RECOVERY_ID))  // refused: tool not offered (withheld)
      .mockResolvedValueOnce(recoveryTurn(3, RECOVERY_ID))  // back on offer → executes (grounded by hex shape)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    // Exactly ONE execution: the post-withhold recovery call. The incident
    // call died in the pre-flight; the withheld round-2 call never reached
    // the tool (toolNotOffered).
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteCodingTool.mock.calls[0][1]).toBe('update_feedback');
  });

  it('wiring seam: update_feedback stays a preflight-covered platform tool and run_command stays a real workspace tool', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
    expect(PLATFORM_TOOL_NAMES).not.toContain('run_command'); // workspace tool — offered by the coding profile / stub here
  });
});
