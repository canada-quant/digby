/**
 * Replay pin — ticket 54a172ac (2026-09-20 bug_report, CanLaw project
 * supervisor chat f5c2c1f4; subject run = schedule-fired coding run
 * c510c56f on kimi-k3/moonshot, lane chat cec340f2).
 *
 * THE INCIDENT: a machine-triggered coding run degenerated into a repetition
 * loop at ~13:42Z: 137+ near-identical update_plan rewrites ("Breaking the
 * todo lock", plan frozen 0/6 for ~35 min) and 64 todo_create calls
 * ("noop1"…"noop64", 13:42:46Z→~14:17Z) creating junk todos directly under a
 * live project goal. guard_strike telemetry (pulled fresh at adjudication):
 * the derail/repeat seams fired only on ADJACENT tools (todo_get ×3 trips,
 * todo_update ×1, update_schedule preflight + re-anchor) and NO ended_run
 * ever fired — every breaker was blind to the loop's own tools:
 * todo_create/update_plan SUCCEED (the derail breaker counts failure-shaped
 * results only), their arguments differed per call (the repeat breaker needs
 * identical name:arguments signatures), and the stream was spread across
 * turns (the storm leg needs >24 calls in ONE turn). Recovery required a
 * supervisor steer delivered into the live run.
 *
 * THE FIX: (1) a per-run volume cap on create-class fleet tools
 * (todo_create/goal_create — loopVolumeCap(), default 25/run): calls past the
 * cap are refused BEFORE execution (failure-shaped, so the derail streak
 * escalates a model that keeps trying) and the tool is perma-withheld;
 * (2) a near-identical leg on the repeat breaker — digit-collapsed
 * signatures, so a numbering loop (noop1, noop2, …) trips the same
 * escalation ladder the exact-signature leg could not reach; (3) a
 * [LOOP-MARKER] line on the terminal hook summary (buildLoopMarker in
 * ./loop-marker) so supervisors can triage looped runs without transcripts.
 *
 * Scaffold mirrors agent-noop-filler-break.9e2c69a2.test.ts (same mock set).
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
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));

import { runCodingAgent, loopVolumeCap, LOOP_VOLUME_CAP_DEFAULT } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { buildLoopMarker, LOOP_MARKER_FLAG } from './loop-marker';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 12,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

// The incident's todo_create calls passed the ungrounded-id preflight because
// the goal id lived in the run's context — reproduced here by putting the
// goal UUID in the run's user message (the grounding haystack).
const GOAL_ID = '11111111-2222-3333-4444-555555555555';

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/loop-volume-54a172ac-test',
  sessionId: 'sess-54a172ac',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `create todos under goal ${GOAL_ID}`,
  emit: jest.fn(),
});

/** Names in the tools array handed to one runModelTurn call (arg index 2). */
const toolNamesOf = (callIdx: number): string[] =>
  (mockRunModelTurn.mock.calls[callIdx]?.[2] ?? [])
    .map((t: any) => t?.function?.name)
    .filter(Boolean);
/** Message texts handed to one runModelTurn call (arg index 1). */
const messageTextsOf = (callIdx: number): string[] =>
  (mockRunModelTurn.mock.calls[callIdx]?.[1] ?? [])
    .map((m: any) => String(m?.content ?? ''));

// Letter-varying titles: the digit-collapsed near-signature stays DISTINCT so
// the volume tests exercise the volume cap alone.
const TITLES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const todoCreateTurn = (n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `tc${n}`, name: 'todo_create', arguments: JSON.stringify({ goalId: GOAL_ID, title: `todo-${TITLES[(n - 1) % TITLES.length]}` }) }],
  finishReason: 'tool_calls',
});
const readFileTurn = (n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `r${n}`, name: 'read_file', arguments: JSON.stringify({ path: `docs/page${n}.md` }) }],
  finishReason: 'tool_calls',
});
const readFileSameTurn = (n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `r${n}`, name: 'read_file', arguments: JSON.stringify({ path: 'docs/same.md' }) }],
  finishReason: 'tool_calls',
});
// The incident's own shape: todo_create titles differing only by number.
const todoNoopTurn = (n: number) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `tn${n}`, name: 'todo_create', arguments: JSON.stringify({ goalId: GOAL_ID, title: `noop${n}` }) }],
  finishReason: 'tool_calls',
});
const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const strikes = (seam: string) =>
  mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === seam);

describe('ticket 54a172ac — loop containment: per-run volume cap + near-identical repeat leg + terminal loop marker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _store.clear();
    delete process.env.LOOP_VOLUME_CAP;
  });

  it('loopVolumeCap(): default 25, env-tunable', () => {
    expect(LOOP_VOLUME_CAP_DEFAULT).toBe(25);
    expect(loopVolumeCap()).toBe(25);
    process.env.LOOP_VOLUME_CAP = '3';
    expect(loopVolumeCap()).toBe(3);
  });

  it('REPLAY: the incident shape is contained — todo_create past the per-run cap is refused pre-execution and perma-withheld', async () => {
    process.env.LOOP_VOLUME_CAP = '3';
    mockRunModelTurn
      .mockResolvedValueOnce(todoCreateTurn(1))
      .mockResolvedValueOnce(todoCreateTurn(2))
      .mockResolvedValueOnce(todoCreateTurn(3)) // cap reached — executes
      .mockResolvedValueOnce(todoCreateTurn(4)) // CROSSED — refused before execution, perma-withheld
      .mockResolvedValueOnce(todoCreateTurn(5)) // no longer offered — toolNotOffered refusal
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Exactly the first cap calls reached the tool; calls 4 and 5 never did.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);
    // The cap-hit guard_strike row names the new seam, once.
    const vol = strikes('tool_volume_break');
    expect(vol).toHaveLength(1);
    expect(vol[0].meta.tool).toBe('todo_create');
    expect(vol[0].meta.count).toBe(3);
    expect(vol[0].meta.cap).toBe(3);
    // todo_create is out of the schema from the next round on.
    expect(toolNamesOf(4)).not.toContain('todo_create');
    // The refusal is failure-shaped (the derail streak sees it) and explains itself.
    const refusal = messageTextsOf(4).find((t) => t.includes('volume cap'));
    expect(refusal).toBeDefined();
    expect(refusal).toContain('Tool todo_create failed');
    expect(refusal).toContain('REST OF THIS RUN');
  });

  it('near-identical leg: the incident shape (todo_create noop1, noop2, …) trips the repeat breaker on the 4th consecutive turn', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(todoNoopTurn(1))
      .mockResolvedValueOnce(todoNoopTurn(2))
      .mockResolvedValueOnce(todoNoopTurn(3))
      .mockResolvedValueOnce(todoNoopTurn(4)) // near-signature TRIP
      .mockResolvedValueOnce(todoNoopTurn(5)) // withheld round — toolNotOffered
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // Four executions; the withheld round's call never reached the tool.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(4);
    expect(toolNamesOf(4)).not.toContain('todo_create');
    const notice = messageTextsOf(4).find((t) => t.includes('[HARNESS NOTICE'));
    expect(notice).toBeDefined();
    expect(notice).toContain('NEAR-IDENTICAL');
    expect(notice).toContain('todo_create');
    const rep = strikes('tool_repeat_break');
    expect(rep).toHaveLength(1);
    expect(rep[0].meta.tool).toBe('todo_create');
    expect(rep[0].meta.trips).toBe(1);
    expect(rep[0].meta.near).toBe(true);
    // The default volume cap (25) is nowhere near this 4-call loop.
    expect(strikes('tool_volume_break')).toHaveLength(0);
  });

  it('review F1 pin: legitimate numbered READS never trip the near leg — read_file page1..page4 gains new information every turn', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(readFileTurn(1))
      .mockResolvedValueOnce(readFileTurn(2))
      .mockResolvedValueOnce(readFileTurn(3))
      .mockResolvedValueOnce(readFileTurn(4))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    // All four reads execute; read_file stays offered; no repeat strike.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(4);
    expect(toolNamesOf(4)).toContain('read_file');
    expect(strikes('tool_repeat_break')).toHaveLength(0);
  });

  it('near-identical leg stays quiet at 3 consecutive digit-varying turns', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(todoNoopTurn(1))
      .mockResolvedValueOnce(todoNoopTurn(2))
      .mockResolvedValueOnce(todoNoopTurn(3))
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);
    expect(strikes('tool_repeat_break')).toHaveLength(0);
  });

  it('exact-signature leg unchanged: 3 identical calls still trip on the 3rd turn (regression pin)', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(readFileSameTurn(1))
      .mockResolvedValueOnce(readFileSameTurn(2))
      .mockResolvedValueOnce(readFileSameTurn(3)) // exact-signature TRIP
      .mockResolvedValueOnce(readFileSameTurn(4)) // withheld round — toolNotOffered
      .mockResolvedValue(FINAL);

    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(3);
    expect(toolNamesOf(3)).not.toContain('read_file');
    const rep = strikes('tool_repeat_break');
    expect(rep).toHaveLength(1);
    expect(rep[0].meta.trips).toBe(1);
    expect(rep[0].meta.near).toBeUndefined();
  });

  it('buildLoopMarker: flags the incident volume (todo_create ×64 + update_plan ×137), ignores run_command churn', () => {
    const parts = [
      ...Array.from({ length: 64 }, () => ({ type: 'tool_call', name: 'todo_create' })),
      ...Array.from({ length: 137 }, () => ({ type: 'tool_call', name: 'update_plan' })),
      ...Array.from({ length: 60 }, () => ({ type: 'tool_call', name: 'run_command' })), // legitimate build iteration — NOT watched
      ...Array.from({ length: 5 }, () => ({ type: 'tool_call', name: 'todo_get' })),
      { type: 'text', name: undefined },
    ];
    const marker = buildLoopMarker(parts as any);
    expect(marker).toContain('[LOOP-MARKER');
    expect(marker).toContain('todo_create×64');
    expect(marker).toContain('update_plan×137');
    expect(marker).not.toContain('run_command');
    expect(marker).not.toContain('todo_get');
  });

  it(`buildLoopMarker: quiet below the flag (≥${LOOP_MARKER_FLAG}) and on empty runs`, () => {
    expect(LOOP_MARKER_FLAG).toBe(25);
    const parts = Array.from({ length: 24 }, () => ({ type: 'tool_call', name: 'todo_create' }));
    expect(buildLoopMarker(parts as any)).toBe('');
    expect(buildLoopMarker([])).toBe('');
  });
});
