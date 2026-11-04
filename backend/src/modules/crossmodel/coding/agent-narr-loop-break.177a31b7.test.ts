/**
 * Replay pin — ticket 177a31b7 (2026-09-20 bug, spark-cluster chat 28de72e5,
 * coding run on kimi-k3/moonshot, auto mode).
 *
 * THE INCIDENT: the run decoder-locked on ANNOUNCING an imminent tool call —
 * "Sending the window-gate relay to 521020fe NOW:" and near-identical
 * variants — dozens of times from 01:39:21Z through 02:09:29Z while the
 * structured send_chat_message call NEVER executed (no receipt; the peer
 * lane never received the relay). The wedged run held the lane busy
 * (recurring schedules fired skipped:busy) and blocked a time-critical
 * inter-lane relay for 25+ minutes. Every breaker missed it: the failure
 * derail-breaker needs failing CALLS, the identical-call breaker needs
 * REPEATED CALLS, the leak lane needs tool-call MARKUP, the provider
 * repetition lane needs degenerate intra-stream output, and the zero-tool
 * gate is observe-only — each wedge turn was a short, well-formed, call-free
 * announcement that finalized, then goal-continue resurrected the run and
 * the model re-announced.
 *
 * THE FIX PINNED HERE: a narrated-tool-emit loop breaker in the run loop's
 * no-tool-call branch — a call-free turn whose text announces an imminent
 * action (an offered tool named in announce context, or an announce verb +
 * immediacy tail) counts when it near-identically repeats the previous
 * counted announcement; repeat 1 injects ONE corrective nudge with a granted
 * tool round; repeat 3 ends the run honestly (completed-with-note) and flags
 * AgentRunResult.narrLoopEnded for the executor's attention_needed alarm.
 * Any real tool call, a differently-worded text, or a status-only line
 * resets the streak.
 *
 * Scaffold mirrors agent-self-audit.5ac56d81.test.ts (same mock set) plus
 * the executeCodingTool / reflection mocks from
 * agent-noop-filler-break.9e2c69a2.test.ts.
 */

jest.setTimeout(60_000);

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn() },
}));

// MCP integration modules (the coding-integrations import chain).
jest.mock('../github/github-mcp', () => ({
  searchCode: jest.fn(), listIssues: jest.fn(), getIssue: jest.fn(), listPullRequests: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(), getGmailMessages: jest.fn(), getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(), getCalendarEvents: jest.fn(), listDriveFiles: jest.fn(),
  getDocContent: jest.fn(), getSheetData: jest.fn(),
}));
jest.mock('../slack/slack-mcp', () => ({
  searchMessages: jest.fn(), listChannels: jest.fn(), getChannelHistory: jest.fn(),
}));
jest.mock('../asana/asana-mcp', () => ({
  searchTasks: jest.fn(), listMyTasks: jest.fn(), listProjects: jest.fn(),
}));
jest.mock('../x/x-mcp', () => ({
  search: jest.fn(), getUserProfile: jest.fn(), getTrends: jest.fn(),
}));
jest.mock('../xero/xero-mcp', () => ({
  getOrganisation: jest.fn(), getContacts: jest.fn(), getInvoices: jest.fn(),
}));
jest.mock('../plaid/plaid-mcp', () => ({
  getAccounts: jest.fn(), getBalances: jest.fn(), getTransactions: jest.fn(),
}));
jest.mock('../imessage/imessage.service', () => ({
  getPrimaryAgent: jest.fn(), isOnline: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

// The model turn: ONE mock drives every case.
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, seatUnservableReason: async () => null, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'probe result: ok');
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

// In-memory context store — the REAL plan.service helpers run against it.
const _store = new Map<string, any>();
const mockStoreGet: jest.Mock = jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null);
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...(a as [string[], string])),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));

jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./coding-memory.service', () => ({
  __esModule: true,
  getUserCodingMemory: jest.fn(async () => null),
  getProjectMemory: jest.fn(async () => null),
  getSessionMemory: jest.fn(async () => null),
  formatCodingMemoryBlock: jest.fn(() => ''),
}));
jest.mock('./scaffolding.service', () => ({
  __esModule: true,
  assessDocsHealth: jest.fn(async () => ({ drift: [], nudgeSilenced: true, commandsUserOwned: false, autoRefreshable: true })),
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
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ''),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => false),
  REFLECTION_MAX_PER_RUN: 2,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordRunSpend: jest.fn(),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
}));

// Plan board: actual module, getPlan mocked per-case (the goal-continue lane
// is the incident's resurrection mechanism — it must run for real).
const mockGetPlan: jest.Mock = jest.fn(async () => null);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlan: (...a: any[]) => mockGetPlan(...a),
}));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { detectNarratedToolIntent, sameNarration, normalizeNarration } from './tool-preflight';

const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 6,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: true,
  planReminders: true,
  memorySource: 'coding',
};

const makeInput = (sessionId: string): AgentRunInput => ({
  worktree: '/tmp/narr-loop-177a31b7-test-does-not-exist',
  sessionId,
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'relay the window gate to the peer lane',
  emit: jest.fn(),
});

/** The incident's plan shape: one unfinished step keeps goal-continue alive. */
const wedgePlan = () => ({
  goal: 'relay the window gate',
  acceptanceCriteria: ['relay delivered'],
  steps: [
    { id: 1, text: 'open the window gate', status: 'completed' },
    { id: 2, text: 'send the window-gate relay to 521020fe', status: 'in_progress' },
  ],
  version: 3,
  updatedAt: '2026-09-20T01:30:00.000Z',
});

const TURN = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const toolTurn = (n: number, name: string, args: unknown) => ({
  content: '',
  reasoning: '',
  toolCalls: [{ id: `t${n}`, name, arguments: JSON.stringify(args) }],
  finishReason: 'tool_calls',
});

/** The incident's exact wedge line (announce channel — names NO tool). */
const INCIDENT_LINE = 'Sending the window-gate relay to 521020fe NOW:';
/** The tool-named variant (tool channel). */
const TOOL_NAMED_LINE = 'Calling send_chat_message with the window-gate relay for 521020fe NOW:';

/** All message contents handed to one runModelTurn call (arg index 1). */
const messageTextsOf = (callIdx: number): string[] =>
  ((mockRunModelTurn.mock.calls[callIdx]?.[1] ?? []) as any[])
    .map((m: any) => (typeof m?.content === 'string' ? m.content : ''))
    .filter(Boolean);

const narrLoopMetrics = () =>
  mockRecordLoopMetric.mock.calls
    .map((c) => c[0])
    .filter((m) => m?.meta?.seam === 'narrated_tool_emit_loop');

describe('ticket 177a31b7 — narrated-but-unexecuted tool-call loop breaker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _store.clear();
    mockGetPlan.mockResolvedValue(null);
  });

  it('terminates the incident\'s exact wedge loop at the 4th identical announcement and flags narrLoopEnded', async () => {
    mockGetPlan.mockResolvedValue(wedgePlan());
    mockRunModelTurn
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))  // count 0 → finalizes → goal-continue resurrects
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))  // count 1 → NUDGE + granted tool round
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))  // count 2 → finalizes → goal-continue (stall 1)
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))  // count 3 → TERMINATE
      .mockResolvedValue(TURN('unreachable — the loop must already be broken'));

    const result = await runCodingAgent(makeInput('sess-177a31b7'));

    // The loop broke: exactly 4 model rounds, never the 30+ the incident burned.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(result.narrLoopEnded).toBeDefined();
    expect(result.narrLoopEnded!.tool).toBeNull(); // the incident line names no tool
    expect(result.narrLoopEnded!.repeats).toBe(4);
    expect(result.narrLoopEnded!.snippet).toContain('Sending the window-gate relay');
    // Honest completed-with-note final (derail run-end parity).
    expect(result.finalText).toContain('Run ended: repeated narrated-but-unexecuted tool announcements');
    expect(result.finalText).toContain('The announced action did NOT happen');
    expect(result.parts.some((p: any) => p.marker === 'guard' && typeof p.text === 'string' && p.text.includes('narrated-but-unexecuted'))).toBe(true);
    // Telemetry: one nudge strike, one run-end strike.
    const seams = narrLoopMetrics();
    expect(seams.some((m) => m.meta.outcome === 'nudged' && m.meta.repeats === 2)).toBe(true);
    expect(seams.some((m) => m.meta.state === 'ended_run' && m.meta.repeats === 4)).toBe(true);
    // The nudge notice rode into the model call AFTER the 2nd announcement.
    const notice = messageTextsOf(2).find((t) => t.includes('[HARNESS NOTICE') && t.includes('narrating a call does not execute it'));
    expect(notice).toBeDefined();
  });

  it('names the announced tool when the narration names one (tool channel)', async () => {
    mockGetPlan.mockResolvedValue(wedgePlan());
    mockRunModelTurn
      .mockResolvedValueOnce(TURN(TOOL_NAMED_LINE))
      .mockResolvedValueOnce(TURN(TOOL_NAMED_LINE))
      .mockResolvedValueOnce(TURN(TOOL_NAMED_LINE))
      .mockResolvedValueOnce(TURN(TOOL_NAMED_LINE))
      .mockResolvedValue(TURN('unreachable'));

    const result = await runCodingAgent(makeInput('sess-177a31b7-tool'));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(4);
    expect(result.narrLoopEnded).toBeDefined();
    expect(result.narrLoopEnded!.tool).toBe('send_chat_message');
    expect(result.finalText).toContain('send_chat_message never executed');
    // The nudge named the tool the model evidently meant.
    const notice = messageTextsOf(2).find((t) => t.includes('[HARNESS NOTICE'));
    expect(notice).toBeDefined();
    expect(notice).toContain('send_chat_message');
  });

  it('nudges once, then a REAL tool call clears the streak — no termination', async () => {
    mockGetPlan.mockResolvedValue(wedgePlan());
    mockRunModelTurn
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))   // count 0 → finalizes → goal-continue
      .mockResolvedValueOnce(TURN(INCIDENT_LINE))   // count 1 → NUDGE
      .mockResolvedValueOnce(toolTurn(3, 'send_chat_message', { chatId: '521020fe-ebe5-4d97-8b58-fdbe8c95445f', content: 'window-gate relay' })) // REAL call → streak resets
      .mockResolvedValue(TURN('Relay sent — the receipt confirms delivery.'));

    const result = await runCodingAgent(makeInput('sess-177a31b7-recover'));

    expect(mockExecuteCodingTool).toHaveBeenCalled();
    expect(result.narrLoopEnded).toBeUndefined();
    const seams = narrLoopMetrics();
    expect(seams.some((m) => m.meta.outcome === 'nudged')).toBe(true);
    expect(seams.some((m) => m.meta.state === 'ended_run')).toBe(false);
    expect(result.finalText).not.toContain('narrated-but-unexecuted');
  });

  it('accumulates across near-identical VARIANTS (prefix drift), not just verbatim repeats', async () => {
    mockGetPlan.mockResolvedValue(wedgePlan());
    mockRunModelTurn
      .mockResolvedValueOnce(TURN('Sending the window-gate relay to 521020fe NOW:'))
      .mockResolvedValueOnce(TURN('Sending the window-gate relay to 521020fe NOW — attempt 2:'))
      .mockResolvedValue(TURN('done'));

    await runCodingAgent(makeInput('sess-177a31b7-variant'));

    // The variant counted as a repeat of the first announcement → the nudge fired.
    expect(narrLoopMetrics().some((m) => m.meta.outcome === 'nudged' && m.meta.repeats === 2)).toBe(true);
  });

  it('NEVER convicts a status-only park line, even repeated (verdict-wait posture)', async () => {
    mockGetPlan.mockResolvedValue(wedgePlan());
    mockRunModelTurn.mockResolvedValue(TURN('Still blocked on the reviewer verdict — no change.'));

    const result = await runCodingAgent(makeInput('sess-177a31b7-park'));

    expect(narrLoopMetrics()).toHaveLength(0);
    expect(result.narrLoopEnded).toBeUndefined();
    expect(result.finalText).not.toContain('narrated-but-unexecuted');
  });

  describe('pure detector helpers (tool-preflight)', () => {
    const OFFERED = new Set(['send_chat_message', 'run_command', 'update_plan', 'search_memory']);

    it('tool channel: an offered tool named in announce context', () => {
      expect(detectNarratedToolIntent(TOOL_NAMED_LINE, OFFERED)).toEqual({ tool: 'send_chat_message' });
      expect(detectNarratedToolIntent('send_chat_message next:', OFFERED)).toEqual({ tool: 'send_chat_message' });
    });

    it('announce channel: announce verb + immediacy punchline, no tool named', () => {
      expect(detectNarratedToolIntent(INCIDENT_LINE, OFFERED)).toEqual({ tool: null });
      expect(detectNarratedToolIntent('Re-sending the relay now.', OFFERED)).toEqual({ tool: null });
    });

    it('never convicts statements, reports, questions, or status lines', () => {
      // A statement that merely NAMES a tool (no announce phrasing).
      expect(detectNarratedToolIntent('The send_chat_message receipt confirmed delivery.', OFFERED)).toBeNull();
      // A completion report (past tense, no immediacy tail).
      expect(detectNarratedToolIntent('Deployed and verified — PR #900 merged at c818d802.', OFFERED)).toBeNull();
      // A QUESTION about sending is honest planning, not an announcement.
      expect(detectNarratedToolIntent('Should I send the relay now?', OFFERED)).toBeNull();
      // The verdict-wait park line.
      expect(detectNarratedToolIntent('Still blocked on the reviewer verdict — no change.', OFFERED)).toBeNull();
      // Too short to mean anything.
      expect(detectNarratedToolIntent('now', OFFERED)).toBeNull();
      expect(detectNarratedToolIntent('', OFFERED)).toBeNull();
    });

    it('sameNarration: exact, prefix-drift, floor, and mismatch', () => {
      expect(sameNarration(INCIDENT_LINE, INCIDENT_LINE)).toBe(true);
      expect(sameNarration(INCIDENT_LINE, 'Sending the window-gate relay to 521020fe NOW — attempt 2:')).toBe(true);
      expect(sameNarration('Sending the window-gate relay to 521020fe NOW — attempt 2:', INCIDENT_LINE)).toBe(true);
      // The 24-char floor: a bare short announcement never matches.
      expect(sameNarration('Sending NOW:', 'Sending NOW:')).toBe(false);
      // Genuinely different announcements.
      expect(sameNarration(INCIDENT_LINE, 'Pushing the fix branch to origin now.')).toBe(false);
    });

    it('normalizeNarration is case/punctuation-insensitive', () => {
      expect(normalizeNarration('Sending the Window-Gate relay to 521020fe NOW:'))
        .toBe('sending the window gate relay to 521020fe now');
    });
  });
});
