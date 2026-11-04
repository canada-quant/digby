/**
 * Replay pin — ticket ff1fa1b5 (enhancement, priority 0, filed 2026-09-20 by
 * the crossmodel supervisor c0e22e36): "Re-anchor hints don't rescue
 * derailing runs — containment stops damage but the run still burns (n=3)".
 *
 * THE INCIDENT: three same-day runs hit the decoder-lock wrong-tool derail
 * class, each received a CORRECT intended-tool re-anchor steer (431518a2),
 * and each still rode the breaker ladder to terminal "ended_run" without
 * completing its intended work:
 *   1. Spark bench lane 521020fe run 6216870c — update_document placeholder
 *      ids while reasoning named list_schedules; reanchor 17:35:21Z, ended
 *      17:37:55Z; intended work never done.
 *   2. Nightly engineer b92ef13f run 1bcc0c79 — update_feedback repeat_break
 *      1→2→3, update_document reanchor 18:02:22Z (correct hint: update_plan),
 *      ended; the c35162ee adjudication was undeliverable in-run — a MANUAL
 *      project-supervisor steer (18:31Z) plus a fresh run delivered it.
 *   3. (same class, third lane in the ticket's guard-row pull.)
 *
 * THE FIX (this pin — the ticket's option (b)): when a MACHINE run hits the
 * terminal derail state, the harness enqueues ONE durable continuation wake
 * to the SAME chat (enqueueDirectWake → the system:direct-wake todo_wake
 * self-hook) whose prompt carries the intended next step VERBATIM — the
 * intended tool when the derail detector named one — plus the re-grounding
 * rules and the goal context. The fresh run starts with a clean decoder and
 * the firing-start preamble at full strength: exactly the manual recovery
 * that worked, automated. Option (a) (a one-tap confirm mid-run) is rejected:
 * machine runs can never confirm staged actions, and a mid-run injection
 * still fights the locked decoder.
 *
 * BOUNDS pinned here: MACHINE runs only (a user-anchored run's human can
 * steer); at most DERAIL_RESCUE_MAX_PER_DAY (default 2) continuations per
 * chat per 24 h (Redis counter, stamped only on a REAL enqueue); a failed
 * wake burns no budget; the ended_run note
 * and breaker ladder stay BYTE-IDENTICAL (the rescue rides its own guard part
 * + guard_strike seam 'tool_derail_rescue' — derail forensics stay on
 * kind=guard_strike with meta.seam, the 13b2f286 doctrine).
 *
 * Scaffold mirrors agent-derail-reanchor.431518a2.test.ts (same mock set) +
 * the enqueueDirectWake boundary mock.
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
const mockRedisGet: jest.Mock = jest.fn(async () => null);
const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => mockRedisGet(...a), set: (...a: any[]) => mockRedisSet(...a), del: (...a: any[]) => mockRedisDel(...a) },
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

const EVIDENCE_REQUIRED = (ticketId: string) => JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'evidence_required',
  ticketId,
  message: `This machine-triggered run may NOT mutate feedback ticket ${ticketId.slice(0, 8)}: the ticket is not dispatched to this session (its context.dispatchedTo names another session) and no verifiable evidence was supplied.`,
}, null, 1);
const mockExecuteCodingTool: jest.Mock = jest.fn(async (_ctx: any, name: string, args: any) => {
  if (name === 'update_feedback') return EVIDENCE_REQUIRED(String(args?.id ?? ''));
  return 'probe result: ok';
});
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

const UD_ENVELOPE = (id: string) =>
  `No generated file with id ${id} belongs to this user. Call list_files to see the current files.`;
const mockToolCacheExec: jest.Mock = jest.fn(async (name: string, args: any) => {
  if (name === 'update_document' || name === 'read_document' || name === 'fill_pdf_form') {
    const id = String(args?.fileId ?? args?.documentId ?? '');
    return UD_ENVELOPE(id);
  }
  if (name === 'update_feedback') return EVIDENCE_REQUIRED(String(args?.id ?? ''));
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
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', TOOL_BATCH_CAP: 'tool_batch_cap' },
}));

/** The continuation-wake boundary: derail-rescue.ts dynamically imports
 *  enqueueDirectWake from the hook outbox module — intercepted here. */
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'evt-rescue-1' }));
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
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
import { renderDerailRescueWake, derailRescueMaxPerDay } from './derail-rescue';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 10,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

const CLOSED_TICKET = 'd0597e02'; // hex-shaped ⇒ grounded — the call EXECUTES into the refusal
const BRIEF = [
  'DOCS-KEEPER firing — work the 7-step shell checklist.',
  '1. SETUP: date -u; git fetch origin --prune; git ls-remote origin main.',
  '[TERMINAL-STOP] feedback ticket d0597e02 is CLOSED (status=done) — do NOT re-audit or mutate it.',
].join('\n');

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/derail-ff1fa1b5-test',
  sessionId: 'sess-ff1fa1b5',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: BRIEF,
  emit: jest.fn(),
  ...over,
});

/** The incident shape: update_feedback against the closed ticket while the
 *  narration announces shell work — failure + intent mismatch (re-anchor leg
 *  b, then the breaker ladder). */
const ufTurn = (n: number) => ({
  content: '',
  reasoning: 'Shell first: run_command "git fetch origin --prune && git ls-remote origin main" — the sweep starts now.',
  toolCalls: [{ id: `t${n}`, name: 'update_feedback', arguments: JSON.stringify({ id: CLOSED_TICKET, status: 'done', adminNote: 'recheck' }) }],
  finishReason: 'tool_calls',
});
const udTurn = (n: number, id: string) => ({
  content: '',
  reasoning: `run_command cannot touch the digest — refresh the generated file ${id} with the census figures now.`,
  toolCalls: [{ id: `t${n}`, name: 'update_document', arguments: JSON.stringify({ fileId: id, content: 'reconciled digest' }) }],
  finishReason: 'tool_calls',
});
const planTurn = (n: number) => ({
  content: '',
  reasoning: 'Re-reading the plan before the next probe.',
  toolCalls: [{ id: `t${n}`, name: 'update_plan', arguments: JSON.stringify({ steps: [{ text: 'setup', status: 'in_progress' }] }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Checklist done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

/** PR #898's terminal sequence (verbatim from the 431518a2 pin): trips
 *  {update_feedback:2, update_document:1} → ended_run, intended run_command. */
const driveToTerminalDerail = () => {
  mockRunModelTurn
    .mockResolvedValueOnce(ufTurn(1)) // re-anchor steer HERE (count 2)
    .mockResolvedValueOnce(ufTurn(2)) // count 4 ⇒ TRIP 1 (one-round ban)
    .mockResolvedValueOnce(planTurn(3)) // ban round — harmless success
    .mockResolvedValueOnce(ufTurn(4)) // count 2
    .mockResolvedValueOnce(ufTurn(5)) // count 4 ⇒ TRIP 2 (perma on update_feedback)
    .mockResolvedValueOnce(udTurn(6, CLOSED_TICKET)) // count 2
    .mockResolvedValueOnce(udTurn(7, 'noop')) // count 4 ⇒ TRIP 3 ⇒ TERMINAL
    .mockResolvedValue(FINAL);
};

const breakerMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_break');
const rescueMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'tool_derail_rescue');
const rescueParts = (result: any) => (result.parts as any[]).filter(
  (p) => p?.type === 'text' && typeof p.text === 'string' && p.text.startsWith('[HARNESS] Derail-rescue:'),
);

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  delete process.env.DERAIL_RESCUE_MAX_PER_DAY;
  mockRedisGet.mockResolvedValue(null); // no rescues yet today
  mockRedisSet.mockResolvedValue('OK');
  mockEnqueueDirectWake.mockResolvedValue({ ok: true, hookEventId: 'evt-rescue-1' });
});

describe('ticket ff1fa1b5 — derail-rescue continuation wake at the terminal derail state', () => {
  it('REPLAY the incident: a MACHINE run ending in terminal derail enqueues ONE durable continuation carrying the intended next step verbatim', async () => {
    driveToTerminalDerail();
    const result = await runCodingAgent(makeInput());

    // The terminal path is UNCHANGED: same 7 turns, same byte-identical note.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(7);
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment (3 episodes');
    expect(result.finalText).toContain('intended tool appears to be run_command');
    expect(breakerMetrics().find((m) => m.meta.state === 'ended_run')).toBeDefined();

    // NEW: exactly ONE continuation wake, to the same chat, carrying the
    // intended tool verbatim + the re-grounding rules + the goal context.
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const wake = mockEnqueueDirectWake.mock.calls[0][0];
    expect(wake.targetChatId).toBe('sess-ff1fa1b5');
    expect(wake.prompt).toContain('[DERAIL RESCUE — harness continuation, not typed by the user]');
    expect(wake.prompt).toContain('trying to call run_command when it derailed');
    expect(wake.prompt).toContain('FIRST ACTION: make the run_command call the previous run could not');
    expect(wake.prompt).toContain('RE-GROUND: every entity id');
    expect(wake.prompt).toContain('looping tool(s): update_feedback, update_document');
    expect(wake.prompt).toContain('DOCS-KEEPER firing'); // goal context
    expect(wake.prompt).toContain('#1 of at most 2');
    expect(wake.meta).toMatchObject({ origin: 'derail-rescue', kind: 'derail_rescue', intended: 'run_command', rescueCount: 1, rescueMax: 2 });

    // Attribution: its own guard part + guard_strike seam row (the ended_run
    // note is untouched — the rescue never rewrites the terminal record).
    expect(rescueParts(result)).toHaveLength(1);
    expect(rescueParts(result)[0].text).toContain('call run_command');
    expect(rescueMetrics()).toHaveLength(1);
    expect(rescueMetrics()[0].meta).toMatchObject({
      state: 'continuation_enqueued', tool: 'update_document', intended: 'run_command', trips: 3, count: 1, max: 2,
    });
    // The budget stamps only on a REAL enqueue.
    expect(mockRedisSet).toHaveBeenCalledWith('derail-rescue:sess-ff1fa1b5', '1', { EX: 24 * 3600 });
  });

  it('BOUND: a USER-anchored run (userTurnAt set) gets NO continuation — the human can steer', async () => {
    driveToTerminalDerail();
    const result = await runCodingAgent(makeInput({ userTurnAt: new Date() }));
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(rescueMetrics()).toHaveLength(0);
    expect(rescueParts(result)).toHaveLength(0);
  });

  it('BOUND: the per-chat 24h budget is enforced — a chat already at 2/2 gets NO third continuation', async () => {
    mockRedisGet.mockImplementation(async (k: string) => (k === 'derail-rescue:sess-ff1fa1b5' ? '2' : null));
    driveToTerminalDerail();
    const result = await runCodingAgent(makeInput());
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    expect(rescueMetrics()).toHaveLength(0);
    expect(rescueParts(result)).toHaveLength(0);
  });

  it('BOUND: the second rescue of the day IS allowed and names #2 of at most 2 (the chain dies after it)', async () => {
    mockRedisGet.mockImplementation(async (k: string) => (k === 'derail-rescue:sess-ff1fa1b5' ? '1' : null));
    driveToTerminalDerail();
    const result = await runCodingAgent(makeInput());
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const wake = mockEnqueueDirectWake.mock.calls[0][0];
    expect(wake.prompt).toContain('#2 of at most 2');
    expect(wake.meta).toMatchObject({ rescueCount: 2 });
    expect(mockRedisSet).toHaveBeenCalledWith('derail-rescue:sess-ff1fa1b5', '2', { EX: 24 * 3600 });
    expect(rescueMetrics()[0].meta).toMatchObject({ count: 2, max: 2 });
    expect(rescueParts(result)).toHaveLength(1);
  });

  it('FAIL-SAFE: a failed wake enqueue burns NO budget and records NO rescue — the terminal end stands alone', async () => {
    mockEnqueueDirectWake.mockResolvedValue({ ok: false, error: 'target chat not found' });
    driveToTerminalDerail();
    const result = await runCodingAgent(makeInput());
    expect(result.finalText).toContain('[HARNESS] Run ended: repeated wrong-tool derailment');
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(mockRedisSet).not.toHaveBeenCalledWith('derail-rescue:sess-ff1fa1b5', expect.anything(), expect.anything());
    expect(rescueMetrics()).toHaveLength(0);
    expect(rescueParts(result)).toHaveLength(0);
  });

  it('UNIT renderDerailRescueWake: no-intended variant names the looping tools and the generic first action; goal truncates', () => {
    const text = renderDerailRescueWake(
      { sessionId: 'c1', runId: 'r1', tools: ['update_feedback'], intended: null, trips: 3, goalHint: 'x'.repeat(900), userTurnAt: undefined },
      1, 2,
    );
    expect(text).toContain('looping tool(s): update_feedback');
    expect(text).toContain('The looping calls never executed.');
    expect(text).toContain('FIRST ACTION: redo the blocked step with the correct tool from your ACTUAL offered tool list');
    expect(text).not.toContain('undefined');
    expect(text.length).toBeLessThan(1900); // 400-char goal cap holds
    expect(derailRescueMaxPerDay()).toBe(2);
    process.env.DERAIL_RESCUE_MAX_PER_DAY = '3';
    expect(derailRescueMaxPerDay()).toBe(3);
    process.env.DERAIL_RESCUE_MAX_PER_DAY = 'banana';
    expect(derailRescueMaxPerDay()).toBe(2);
  });
});
