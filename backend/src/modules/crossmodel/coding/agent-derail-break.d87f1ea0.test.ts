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
 * Replay pin — tickets d87f1ea0 + cbc5be24 (ONE incident run, session
 * b92ef13f-c3f8-487e-8267-767e56543150 "Digby's Nightly Self-Improvement
 * Engineer", project crossmodel, kimi-k3, run aad8ff7d-fedf-4ded-9470-
 * 65cd6fc2d0af, 2026-09-20 ~06:48-06:53Z).
 *
 * THE INCIDENT — the strongest single-run data point in the 2026-09-20
 * placeholder-emission burst: the NIGHTLY ADJUDICATION LANE ITSELF, with the
 * full wrong-tool-class adjudication context loaded in its own brief (it was
 * mid-consolidated-report on exactly this class), tripped the breaker TWICE
 * in one run:
 *   · d87f1ea0 (filed 06:48:09Z): '3× tool-failure streak: update_feedback'
 *     with ONE failure text — the ungrounded-id pre-flight refusal for
 *     id="nonexistent-probe-never", recovery line naming update_plan.
 *     Weighted: +1 refusal, +1 ungrounded fast-trip, +1 intent fast-trip
 *     (the reasoning named update_plan) = 3 on the FIRST call.
 *   · cbc5be24 (filed 06:53:21Z): '3× tool-failure streak: update_document'
 *     with THREE failure texts — "No generated file with id
 *     placeholder-recheck belongs to this user" ×3. Weighted: +1, +1, then
 *     +1 refusal +1 intent fast-trip (the third call's reasoning named
 *     get_feedback) = 4 ≥ 3 with three texts — the filed shape pins WHICH
 *     call carried the intent conviction (only a t3 conviction leaves three
 *     texts; a t1 conviction would have tripped at t2 with two).
 *
 * WHAT ACTUALLY HAPPENED (adjudication): the lane's own live transcript
 * (msg bd8af24c, 06:54:15Z) records the misfire plainly ("ticket 718a04a5's
 * live row after the prior run's update_feedback misfire"); its supervisor
 * steer (06:59:33Z, msg 3da9b4c5) folds both tickets into the class tally as
 * SELF-ADJUDICATED occurrences: "That your lane — with the full adjudication
 * context loaded — still tripped is itself evidence the class is
 * context-unfixable model behavior." The id names narrate the model's own
 * awareness ("nonexistent-probe-never", "placeholder-recheck") — MODEL-
 * authored tokens; a framework emission-layer garble would have carried the
 * intended call's real args (a ticket id from list_feedback, a plan step).
 *
 * VERDICT (the tickets' mandated investigation): MODEL BEHAVIOR. Every
 * deterministic seam behaved as designed; the filed texts diff clean against
 * current framework code (tool-preflight.ts:278 for the ungrounded envelope
 * with the "Your reasoning named update_plan" recovery line;
 * tool-executor.ts:712/780/875 for the existence refusal, which post-PR-#895
 * counts as a failure by design). NO platform code change.
 *
 * d87f1ea0 closes via this replay per the supervisor's first-close-wins
 * coordination (its row was re-checked fresh: still in_progress, dispatched
 * to the batch lane). cbc5be24's row is dispatched to the nightly lane
 * (b92ef13f) — the batch lane's close rides the evidence bar.
 *
 * Scaffold mirrors agent-derail-break.aff1c189.test.ts + the intent-stub
 * seam of agent-derail-break.87d1e421.test.ts + the ToolCache document seam
 * of agent-derail-break.718a04a5.test.ts.
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

// ── The incident's verbatim ids ─────────────────────────────────────────────
const FEEDBACK_ID = 'nonexistent-probe-never'; // d87f1ea0 — ungrounded
const DOC_ID = 'placeholder-recheck'; // cbc5be24 — echo-grounded
const RECOVERY_ID = 'd87f1ea0'; // 8-hex — shape-valid citation for the recovery call

/** The nightly-lane brief. The update_feedback suite keeps it FREE of the
 *  placeholder token (the d87f1ea0 pre-flight shape); the update_document
 *  suite injects the echo into the user message (the incident lane narrated
 *  "placeholder-recheck" before emitting it — verbatim-occurrence grounding,
 *  so its calls EXECUTED into the existence check, the cbc5be24 shape). */
const BRIEF = [
  '[Nightly self-improvement — consolidated class adjudication]',
  'Fold tonight\'s derail-breaker tickets into the class tally, extend the',
  'canonical pin, and record verdicts with evidence. Plan bookkeeping rides',
  'the plan tool; ticket rows come only from list_feedback/get_feedback.',
].join('\n');

/** Stub so the REAL detectIntendedTool sees update_plan as offered (a live
 *  offered tool in the lane's coding-profile run; the chat test profile does
 *  not offer workspace tools — the extraTools seam, agent.ts:967, mirroring
 *  agent-derail-break.87d1e421.test.ts). get_feedback needs no stub: it is a
 *  real offered platform tool (platform-tool-names.ts:39). */
const UPDATE_PLAN_STUB = {
  schema: {
    type: 'function' as const,
    function: {
      name: 'update_plan',
      description: 'test stub — present so intent detection sees it offered',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: jest.fn(async () => 'plan ok'),
};

const mkTurn = (n: number, tool: string, args: any, reasoning: string) => ({
  content: '',
  reasoning,
  toolCalls: [{ id: `t${n}`, name: tool, arguments: JSON.stringify(args) }],
  finishReason: 'tool_calls',
});
/** d87f1ea0's turn shape: reasoning names update_plan (whole word, NEVER the
 *  called tool) → the REAL detectIntendedTool convicts (+1 fast-trip). */
const PLAN_INTENT_REASONING =
  'The adjudication tally is current; before any ticket bookkeeping I should update_plan to mark the folded occurrences.';
/** cbc5be24's third-turn shape: reasoning names get_feedback. */
const GET_FEEDBACK_INTENT_REASONING =
  'Re-check the row first — get_feedback on the ticket, then record the note against it.';
const PLAIN_UF_REASONING = 'update_feedback: record the class verdict on the ticket row.';
const PLAIN_UD_REASONING = 'update_document: refresh the tally digest with the folded occurrences.';
const FINAL = { content: 'Tally folded.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const makeInput = (userMessage: string): AgentRunInput => ({
  worktree: '/tmp/derail-d87f1ea0-test',
  sessionId: 'sess-d87f1ea0',
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
  extraTools: [UPDATE_PLAN_STUB],
});

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('replay d87f1ea0 — the adjudication lane\'s own placeholder update_feedback (intent: update_plan)', () => {
  it('"nonexistent-probe-never" is ungrounded against the run haystack (not id-shaped; appears nowhere the model read)', () => {
    expect(findUngroundedIdArgs({ id: FEEDBACK_ID }, BRIEF))
      .toEqual([{ key: 'id', value: FEEDBACK_ID }]);
  });

  it('replays the exact refusal envelope from the filed text (the recovery line names update_plan)', () => {
    const refusal = JSON.parse(
      ungroundedIdRefusal('update_feedback', [{ key: 'id', value: FEEDBACK_ID }], 'update_plan'),
    );
    expect(refusal).toMatchObject({
      ok: false,
      tool: 'update_feedback',
      reason: 'ungrounded_id',
      rejected: [{ key: 'id', value: FEEDBACK_ID }],
    });
    expect(refusal.message).toContain('NOT EXECUTED');
    expect(refusal.message).toContain('never from narration');
    expect(refusal.message).toContain('Your reasoning named update_plan — you evidently meant to call update_plan; call it now with its real parameters.');
  });

  it('END-TO-END: ONE call trips the breaker at weighted 3 (+1 refusal, +1 ungrounded fast-trip, +1 intent fast-trip) with exactly the one filed text and intended=update_plan', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(mkTurn(1, 'update_feedback', { id: FEEDBACK_ID }, PLAN_INTENT_REASONING)) // weighted 3 → TRIP
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput(`${BRIEF}\nFold the tally now.`));

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(0);
    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_feedback');
    expect(ev.perma).toBe(false);
    expect(ev.intended).toBe('update_plan');
    expect(ev.recentFailures).toHaveLength(1);
    const filed = JSON.parse(ev.recentFailures[0]);
    expect(filed).toMatchObject({
      ok: false, tool: 'triage_ticket', reason: 'ungrounded_id', // preflight envelope renders the MODEL-FACING name
      rejected: [{ key: 'id', value: FEEDBACK_ID }],
    });
    expect(filed.message).toContain('NOT EXECUTED');
  });

  it('first trip = one-round withhold, NOT perma: a same-tool call two rounds later EXECUTES (shape-valid citation)', async () => {
    const recoveryTurn = (n: number) => mkTurn(n, 'update_feedback', { id: RECOVERY_ID }, PLAIN_UF_REASONING);
    mockRunModelTurn
      .mockResolvedValueOnce(mkTurn(1, 'update_feedback', { id: FEEDBACK_ID }, PLAN_INTENT_REASONING)) // TRIP → withheld
      .mockResolvedValueOnce(recoveryTurn(2))  // refused: tool not offered (withheld)
      .mockResolvedValueOnce(recoveryTurn(3))  // back on offer → executes (grounded by hex shape)
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput(`${BRIEF}\nFold the tally now.`));

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteCodingTool.mock.calls[0][1]).toBe('update_feedback');
  });
});

describe('replay cbc5be24 — the same run\'s update_document placeholder triple (intent convicts the THIRD call)', () => {
  it('END-TO-END: three echo-grounded calls trip at weighted 4 (+1, +1, +1 refusal +1 intent) with exactly the three filed texts and intended=get_feedback — pinning that only t3 carried the intent conviction', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(mkTurn(1, 'update_document', { fileId: DOC_ID }, PLAIN_UD_REASONING)) // +1
      .mockResolvedValueOnce(mkTurn(2, 'update_document', { fileId: DOC_ID }, PLAIN_UD_REASONING)) // +1
      .mockResolvedValueOnce(mkTurn(3, 'update_document', { fileId: DOC_ID }, GET_FEEDBACK_INTENT_REASONING)) // +1 refusal, +1 intent = 4 → TRIP
      .mockResolvedValue(FINAL);

    // The incident lane narrated "placeholder-recheck" before emitting it —
    // the echo grounds the id so the calls EXECUTE into the existence check.
    await runCodingAgent(makeInput(`${BRIEF}\nThe placeholder-recheck digest carries the tally — refresh it now.`));

    expect(mockFileStreakInvestigation).toHaveBeenCalledTimes(1);
    const ev = mockFileStreakInvestigation.mock.calls[0][0];
    expect(ev.tool).toBe('update_document');
    expect(ev.perma).toBe(false);
    expect(ev.intended).toBe('get_feedback');
    expect(ev.recentFailures).toEqual([
      `No generated file with id ${DOC_ID} belongs to this user. Call list_files to see the current files.`,
      `No generated file with id ${DOC_ID} belongs to this user. Call list_files to see the current files.`,
      `No generated file with id ${DOC_ID} belongs to this user. Call list_files to see the current files.`,
    ]);
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(0);
    expect(mockToolCacheExec).toHaveBeenCalledTimes(3);
  });

  it('wiring seam: get_feedback stays a real offered platform tool (no stub needed) and update_feedback stays preflight-covered', () => {
    expect(PLATFORM_TOOL_NAMES).toContain('get_feedback');
    expect(PLATFORM_TOOL_NAMES).toContain('update_feedback');
  });
});
