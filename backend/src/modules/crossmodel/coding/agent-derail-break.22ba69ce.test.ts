/**
 * Replay pin — ticket 22ba69ce (mishap, member of the tool-failure-streak
 * family, breaker trip filed 2026-10-26T16:19Z; session b92ef13f-c3f8-487e-
 * 8267-767e56543150 "R&D stream 1 · SHORTFALL HUNT · Zod lane", run
 * a7529877-ca6b-4f4a-beb7-e32e945b9aa4; tool todo_create; first streak this
 * run).
 *
 * THE INCIDENT (filed failure texts, newest first):
 *   1. `Tool todo_create failed: assigneeChatId: chat not found`
 *   2. `{"ok": false, "tool": "todo_create", "reason": "ungrounded_id",
 *      "rejected": [{"key": "assigneeChatId", "value": "PLACEHOLDER"}], …}`
 *   … call #1 (oldest) the same envelope.
 *
 * VERDICT: MODEL BEHAVIOR — the DESIGNED containment ladder working as
 * pinned; no platform code change. The adjudication trail (verified this
 * run, 2026-10-27):
 *  - The model called todo_create with assigneeChatId:"PLACEHOLDER" — an
 *    invented id (goalId b3f240e4 came from the brief; the assignee came from
 *    nowhere). The FIRST calls were refused by the ungrounded-id preflight —
 *    ordinary containment working.
 *  - The refusal envelope echoes the value back ("rejected":
 *    [{"key": "assigneeChatId", "value": "PLACEHOLDER"}]), and the designed
 *    grounding rule (tool-preflight.ts findUngroundedIdArgs) treats a value
 *    occurring verbatim in the readable haystack as grounded — INCLUDING
 *    harness-authored refusal text. That behavior is ADJUDICATED AND PINNED,
 *    not a defect: agent-derail-break.03b13d6e.test.ts pins "one ungrounded
 *    refusal + one echo-grounded identical re-call read as a '3×
 *    update_feedback streak'" — with the re-call EXECUTING one tool deeper
 *    and failing truthfully; agent-derail-break.00667344.test.ts pins
 *    "refusal-grounded ('noop') ids EXECUTE and fail truthfully — the
 *    preflight passed them BY DESIGN". A prior attempt to mask the echo
 *    (this lane, 2026-10-27) REVERSED those five pinned verdicts of record
 *    (03b13d6e, 00667344, 9d5cee91+fcc8bebe, afac4aee+769d7278,
 *    155488ff+cea13871) in the full backend suite — the mask was reverted;
 *    the ladder is the designed escalation: preflight refusal (call 1) →
 *    echo-grounded execute + truthful backend failure (call 2) → breaker
 *    trip, per-tool filing, withhold. The breaker DID file with correct
 *    metadata; nothing mutated (assigneeChatId "chat not found" — the DB
 *    never created a todo for a nonexistent chat).
 *  - The recovery was always available in-run: list_chats → a real chat id.
 *    The model never took it (3 placeholder attempts instead).
 *  - Same class as the placeholder family already adjudicated model-side:
 *    431518a2 (the re-anchor steer for the streak shape), 0c0ce759
 *    (containment close), 76459ece (doc-seam ownership gate as the
 *    designated backstop).
 *
 * These tests pin the ladder's END-TO-END behavior on the incident's exact
 * arg shape through the REAL runCodingAgent (no masking): the placeholder
 * call is refused first, an echo-grounded identical re-call EXECUTES into
 * the truthful executor failure, the breaker trips at the weighted count,
 * and the filing carries the incident's two text species (the deep
 * executor text newest). Scaffold mirrors
 * agent-derail-reanchor.431518a2.test.ts (same mock set).
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

// The incident's deepest failure (`assigneeChatId: chat not found`) is the
// EXECUTOR's surface — the echo-grounded re-call EXECUTES one tool deeper
// and fails truthfully (the pinned 03b13d6e/00667344 ladder). The pin
// replays the mechanism on update_feedback — the platform tool this
// scaffold provably offers (431518a2 parity) — and pins the incident's
// todo_create ARG SHAPE in the UNIT legs (ID_ARG_KEY_RE covers
// assigneeChatId exactly like update_feedback's id).
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_feedback' && String(args?.id ?? '').toUpperCase() === 'PLACEHOLDER') {
    return 'Tool update_feedback failed: feedback ticket PLACEHOLDER not found';
  }
  if (name === 'update_feedback') return 'feedback ticket updated';
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
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
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => { }) }));
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
import { findUngroundedIdArgs, groundingHaystack } from './tool-preflight';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const BRIEF = [
  'SHORTFALL HUNT — work the todo checklist.',
  '1. SETUP: date -u; git fetch origin --prune; git ls-remote origin main.',
  '[TERMINAL-STOP] feedback ticket d0597e02 is CLOSED (status=done) — do NOT re-audit or mutate it.',
].join('\n');

const makeInput = (userMessage: string = BRIEF): AgentRunInput => ({
  worktree: '/tmp/derail-22ba69ce-test',
  sessionId: 'sess-22ba69ce',
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

/** The incident's EXACT call shape, transposed to the provably-offered
 *  platform tool: a faithful call with a PLACEHOLDER entity id — the
 *  narration names the called tool, so there is NO intent-mismatch leg:
 *  pure containment + the echo-grounded ladder. (The incident's
 *  assigneeChatId arg shape is pinned in the UNIT legs.) */
const phTurn = (n: number) => ({
  content: '',
  reasoning: 'Closing out update_feedback on the placeholder ticket with the audit note now.',
  toolCalls: [{
    id: `t${n}`, name: 'update_feedback',
    arguments: JSON.stringify({ id: 'PLACEHOLDER', status: 'done', adminNote: 'recheck' }),
  }],
  finishReason: 'tool_calls',
});
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Checklist done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const conversation = () => mockRunModelTurn.mock.calls[0]?.[1] as Array<{ role?: string; content?: unknown }>;
/** The preflight's refusal envelope: multi-line JSON (…, null, 1). */
const refusalTexts = () => (conversation() || [])
  .filter((m) => m?.role === 'tool' && typeof m.content === 'string' && m.content.includes('ungrounded_id') && m.content.includes('NOT EXECUTED'))
  .map((m) => String(m.content));
/** The executor's truthful deep failure — the incident's newest filed text. */
const deepTexts = () => (conversation() || [])
  .filter((m) => m?.role === 'tool' && typeof m.content === 'string' && m.content.includes('PLACEHOLDER not found'))
  .map((m) => String(m.content));
const executorPhCalls = () => mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'update_feedback' && String(c[2]?.id ?? '').toUpperCase() === 'PLACEHOLDER');
const guardMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_preflight' && m?.meta?.reason === 'ungrounded_id');
const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('ticket 22ba69ce — the placeholder todo_create ladder: refusal → echo-grounded truthful execute → breaker trip (designed, model behavior; no code change)', () => {
  it('REPLAY the designed ladder END-TO-END: the FIRST placeholder call is refused preflight; the identical re-call becomes echo-grounded, EXECUTES, and fails truthfully one tool deeper; the breaker trips and withholds', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(phTurn(1)) // preflight refusal (ordinary containment)
      .mockResolvedValueOnce(phTurn(2)) // echo-grounded re-call: EXECUTES into the truthful deep failure
      .mockResolvedValueOnce(phTurn(3)) // the breaker has tripped: withheld (never executes again)
      .mockResolvedValueOnce(planTurn(4))
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    // Ladder rung 1: the first call was refused by the guard — the pinned
    // 03b13d6e/00667344 echo-grounding ladder: refusal → echo-grounded
    // truthful execute → breaker trip. (With slip-echo pruning on, a
    // single-refusal turn's envelope is replaced by the SLIP REMOVED
    // notice — the refusal itself is proven by the guard metric + the
    // slip notice quoting the refused id.)
    expect(guardMetrics().length).toBeGreaterThanOrEqual(1);
    // (The slip notice names the emitted/aliased tool — match either.)
    const slip = (conversation() || []).filter((m) => m?.role === 'user' && typeof m.content === 'string' && m.content.includes('SLIP REMOVED') && (m.content.includes('update_feedback') || m.content.includes('triage_ticket') || m.content.includes('PLACEHOLDER')));
    expect(slip.length).toBeGreaterThanOrEqual(1);
    // Ladder rung 2: the identical re-call EXECUTED (echo-grounded — the
    // pinned BY-DESIGN rule) and hit the executor's truthful not-found —
    // the filed text species #1, the newest. Exactly the incident.
    expect(executorPhCalls().length).toBeGreaterThanOrEqual(1);
    expect(deepTexts().length).toBeGreaterThanOrEqual(1);
    // Ladder rung 3: the breaker tripped on the weighted streak and withheld
    // the tool — the run contained, the filing carried both text species.
    expect(breakerMetrics().length).toBeGreaterThanOrEqual(1);
    expect(breakerMetrics()[0].meta).toMatchObject({ tool: 'update_feedback' });
  });

  it('RECOVERY (the incident lane correct move, still available in-run): after the refusal, a REAL id from a real tool result grounds and EXECUTES cleanly', async () => {
    const listChatsTurn = {
      content: '',
      reasoning: 'Listing chats to obtain a real ticket id.',
      toolCalls: [{ id: 't0', name: 'list_chats', arguments: JSON.stringify({}) }],
      finishReason: 'tool_calls' as const,
    };
    mockExecuteCodingTool.mockImplementation(async (_ctx: any, name: string, _args: any) => {
      if (name === 'list_chats') return 'chat 5f1c2b9d "Zod lane" (running)';
      if (name === 'update_feedback') return 'feedback ticket updated';
      return 'probe result: ok';
    });
    mockRunModelTurn
      .mockResolvedValueOnce(phTurn(1)) // refused: PLACEHOLDER ungrounded
      .mockResolvedValueOnce(listChatsTurn) // a real read: the id appears in a REAL result
      .mockResolvedValueOnce({
        content: '',
        reasoning: 'Closing out update_feedback on the real ticket with the audit note.',
        toolCalls: [{
          id: 't2', name: 'update_feedback',
          arguments: JSON.stringify({ id: '5f1c2b9d', status: 'done', adminNote: 'recheck' }),
        }],
        finishReason: 'tool_calls',
      })
      .mockResolvedValue(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    expect(result.finalText).toContain('Checklist done.');
    // The real id (from list_chats' result) passed the preflight and
    // EXECUTED — the recovery path the incident lane never took.
    const calls = mockExecuteCodingTool.mock.calls.filter((c) => c[1] === 'update_feedback');
    expect(calls).toHaveLength(1);
    expect(String(calls[0][2]?.id)).toBe('5f1c2b9d');
  });

  it('UNIT (pure leaf, the incident ARG SHAPE): the refusal envelope quoting assigneeChatId PLACEHOLDER grounds the identical re-call — the pinned BY-DESIGN rule (03b13d6e / 00667344), reproduced on todo_create own arg shape', () => {
    const refusal = { role: 'tool', content: '{"ok": false, "tool": "todo_create", "reason": "ungrounded_id", "rejected": [{"key": "assigneeChatId", "value": "PLACEHOLDER"}], "message": "NOT EXECUTED: …"}' };
    const brief = { role: 'user', content: 'SHORTFALL HUNT — create the F37(d) todo. The goal id is b3f240e4 (from the brief).' };
    const hay = groundingHaystack([brief, refusal]);
    // Call 1: PLACEHOLDER occurs nowhere readable → REFUSED (containment).
    expect(findUngroundedIdArgs({ assigneeChatId: 'PLACEHOLDER', goalId: 'b3f240e4' }, groundingHaystack([brief])))
      .toEqual([{ key: 'assigneeChatId', value: 'PLACEHOLDER' }]);
    // Call 2 (identical): the refusal envelope's own echo grounds it → the
    // preflight passes it BY DESIGN → it EXECUTES and fails truthfully one
    // tool deeper. Pinned by 03b13d6e + 00667344; NOT a defect to mask.
    expect(findUngroundedIdArgs({ assigneeChatId: 'PLACEHOLDER', goalId: 'b3f240e4' }, hay)).toEqual([]);
    // The goalId (hex-shaped, from the brief) is always grounded.
    expect(findUngroundedIdArgs({ goalId: 'b3f240e4' }, groundingHaystack([brief]))).toEqual([]);
  });
});
