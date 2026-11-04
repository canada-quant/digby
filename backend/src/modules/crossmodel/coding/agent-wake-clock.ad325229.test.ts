/**
 * PER-TURN [HARNESS CLOCK] on chat-lane machine wakes (ticket ad325229 —
 * "Phantom observation clock: machine note cites future timestamp(s)").
 *
 * The incident (2026-09-16, chat 615723ba): a message-wake lane (Fleet
 * Supervisor relay) ran ~6 minutes; its ONLY clock was the one-line wake stamp
 * injected at run start (machine-wake.ts preamble). By final-note time the
 * stamp was visibly stale, so the lane ESTIMATED "now" as wake + guessed
 * elapsed and headlined "**Wake note — 19:21Z …**" — 4 min ahead of the run's
 * real clock (2026-09-16T19:16:34.230Z). The action verifier's
 * future-observation-clock lane struck it pre-delivery (containment worked —
 * the note was REPLACED). The prevention gap: the per-turn [HARNESS CLOCK]
 * note (ticket 63e9a3cb — built for the IDENTICAL overshoot-estimation shape
 * on coding lanes) was gated `profile.kind === 'coding'` only, so chat-lane
 * machine wakes never got a fresh clock to copy per machine-wake rule 8
 * (review finding B12, docs/reviews/2026-09-08-spark-review-maps, had already
 * flagged the coding-only gate).
 *
 * The fix widens the gate in agent.ts to
 *   profile.kind === 'coding'
 *   || (topLevel && input.machineTriggered === true && profile.kind !== 'coding')
 * — the exact EVIDENCE LEDGER gate (ticket a84cc306) — and pushes the
 * chat-wake variant (buildChatWakeClockNote) whose stale-clock reference is
 * the machine-wake line (chat lanes carry no [CURRENT DATE & TIME] block).
 * USER-triggered chat turns are deliberately unchanged.
 *
 * This replay reconstructs the incident's generation path: a chat-profile
 * MACHINE-triggered top-level run over two model turns. Before the fix the
 * snapshots carried NO [HARNESS CLOCK] note (the lane estimated); after it,
 * EVERY turn carries exactly one, rebuilt per turn (a once-built note would
 * go stale — the whole point), spliced post-turn and never persisted.
 *
 * Harness: the REAL ./agent module with the repo-standard stand-ins
 * (agent-evidence-ledger.a84cc306.test.ts precedent); the model turn is a
 * jest mock that SNAPSHOTS the messages array at call time (the array is
 * mutated post-turn — the splice assertion reads the live reference
 * afterwards). The clock-note TEXT is pinned in datetime-context.test.ts;
 * here the builders are sentinels so the wiring (gate/freshness/transience)
 * is what is asserted.
 */

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

// The model turn: ONE mock drives every case (per-test turn queue + snapshots).
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

// Coding-tool execution: mocked so a sweep turn dispatches cheaply.
const mockExecuteCodingTool: jest.Mock = jest.fn();
jest.mock('./tools', () => {
  const actual = jest.requireActual('./tools');
  return { ...actual, executeCodingTool: (...a: any[]) => mockExecuteCodingTool(...a) };
});

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
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

// The clock builders are SENTINELS here (their real text is pinned in
// datetime-context.test.ts) — distinct per variant so the test proves WHICH
// builder each lane got.
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => '[HARNESS CLOCK — coding-lane sentinel]'),
  buildChatWakeClockNote: jest.fn(() => '[HARNESS CLOCK — chat-wake sentinel]'),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { buildCodingClockNote, buildChatWakeClockNote } from './datetime-context';

const mockCodingClock = buildCodingClockNote as unknown as jest.Mock;
const mockChatWakeClock = buildChatWakeClockNote as unknown as jest.Mock;

const CHAT_SENTINEL = '[HARNESS CLOCK — chat-wake sentinel]';
const CODING_SENTINEL = '[HARNESS CLOCK — coding-lane sentinel]';

// Minimal chat-shaped profile (agent-evidence-ledger.a84cc306.test.ts
// precedent): the clock gate needs a TOP-LEVEL loop + input.machineTriggered
// + non-coding kind.
const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 6,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

const makeInput = (machineTriggered: boolean | undefined, profile: AgentProfile = CHAT_TEST_PROFILE): AgentRunInput => ({
  worktree: '/tmp/wake-clock-test',
  sessionId: 'sess-wake-clock-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'machine wake: relay absorbed, write the wake note',
  emit: jest.fn(),
  ...(machineTriggered === undefined ? {} : { machineTriggered }),
});

// Turn shapes — the incident lane absorbed the relay (a tool turn) and then
// wrote its final wake note.
const SWEEP_TURN = {
  content: 'Pulling fresh lane state first.',
  reasoning: '',
  toolCalls: [{ id: 't1', name: 'list_chats', arguments: '{}' }],
  finishReason: 'tool_calls',
};
const FINAL_NOTE = {
  content: '**Wake note — (harness-clock time) (message wake)**\n\n- Relay absorbed; nothing moved.',
  reasoning: '',
  toolCalls: [],
  finishReason: 'stop',
};

let turnQueue: any[] = [];
/** Per-call snapshots of the messages array AS THE MODEL SAW IT (the live array is mutated post-turn). */
let messageSnapshots: Array<Array<{ role: string; content: string }>> = [];

const clockNotesIn = (snapshot: Array<{ role: string; content: string }>) =>
  snapshot.filter((m) => m.role === 'system' && m.content.startsWith('[HARNESS CLOCK'));

// build 2026-10-08 F-1: these per-turn snapshot pins count the run's OWN turns — the finish_run shadow
// nudge (an extra isolated turn on machine coding / supervisor runs, pinned in agent-finish-run.test.ts) is off here.
const savedFinishRunDisabled = process.env.FINISH_RUN_DISABLED;
afterAll(() => { if (savedFinishRunDisabled === undefined) delete process.env.FINISH_RUN_DISABLED; else process.env.FINISH_RUN_DISABLED = savedFinishRunDisabled; });
beforeEach(() => {
  process.env.FINISH_RUN_DISABLED = '1';
  jest.clearAllMocks();
  _store.clear();
  turnQueue = [];
  messageSnapshots = [];
  mockRunModelTurn.mockImplementation((_provider: any, messages: any[]) => {
    messageSnapshots.push(
      messages.map((m: any) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
    );
    const next = turnQueue.shift();
    if (!next) throw new Error('runModelTurn called more times than the test queued turns');
    return Promise.resolve(next);
  });
  mockExecuteCodingTool.mockImplementation(async () => '[]');
});

describe('per-turn [HARNESS CLOCK] on chat-lane machine wakes (ticket ad325229)', () => {
  it('EVERY turn carries a FRESH clock note — rebuilt per turn, spliced post-turn, never persisted (the incident shape: a stale-wake-stamp lane that used to estimate "now")', async () => {
    turnQueue = [SWEEP_TURN, FINAL_NOTE];
    const result = await runCodingAgent(makeInput(true));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    // Turn 1 AND turn 2: exactly ONE clock note each, the chat-wake variant…
    for (const snapshot of messageSnapshots) {
      const notes = clockNotesIn(snapshot);
      expect(notes).toHaveLength(1);
      expect(notes[0].content).toBe(CHAT_SENTINEL);
    }
    // …REBUILT before every model call (a once-built note would go stale —
    // rebuilding is the entire prevention; the phantom "19:21Z" was an
    // estimate made precisely because no this-turn clock existed).
    expect(mockChatWakeClock).toHaveBeenCalledTimes(2);
    expect(mockCodingClock).not.toHaveBeenCalled();

    // Spliced post-turn: the LIVE messages array (mutated after the call —
    // the mock recorded the reference) no longer carries the note…
    const liveMessages = mockRunModelTurn.mock.calls[1][1] as any[];
    expect(
      liveMessages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('[HARNESS CLOCK')),
    ).toBe(false);
    // …and the note never became transcript content (context-only channel).
    expect(
      result.parts.some((p: any) => typeof p?.text === 'string' && p.text.includes('[HARNESS CLOCK')),
    ).toBe(false);
    expect(result.finalText).toBe(FINAL_NOTE.content);
  });

  it('GATE NEGATIVE — a USER-triggered chat turn gets NO per-turn clock note (pre-ad325229 behavior preserved: short interactive turns keep their single run-start clock)', async () => {
    turnQueue = [SWEEP_TURN, FINAL_NOTE];
    const result = await runCodingAgent(makeInput(undefined));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    for (const snapshot of messageSnapshots) expect(clockNotesIn(snapshot)).toEqual([]);
    expect(mockChatWakeClock).not.toHaveBeenCalled();
    expect(mockCodingClock).not.toHaveBeenCalled();
    expect(result.finalText).toBe(FINAL_NOTE.content);
  });

  it('the CODING lane keeps its own variant every turn (ticket 63e9a3cb behavior preserved — its stale reference stays the [CURRENT DATE & TIME] block)', async () => {
    turnQueue = [SWEEP_TURN, FINAL_NOTE];
    const codingProfile: AgentProfile = { ...CHAT_TEST_PROFILE, kind: 'coding' };
    const result = await runCodingAgent(makeInput(true, codingProfile));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    for (const snapshot of messageSnapshots) {
      const notes = clockNotesIn(snapshot);
      expect(notes).toHaveLength(1);
      expect(notes[0].content).toBe(CODING_SENTINEL);
    }
    expect(mockCodingClock).toHaveBeenCalledTimes(2);
    expect(mockChatWakeClock).not.toHaveBeenCalled();
    expect(result.finalText).toBe(FINAL_NOTE.content);
  });
});
