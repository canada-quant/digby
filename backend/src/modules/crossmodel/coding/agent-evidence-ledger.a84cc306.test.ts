/**
 * EVIDENCE LEDGER wiring (feedback a84cc306 — "Wake-note phantom citations
 * recur across supervisors — authorship-side prevention follow-on").
 *
 * Pins the generation-path seam: on chat-lane MACHINE wakes the agent loop
 * maintains a per-run EvidenceLedger (chat-agent/evidence-ledger.ts), ingests
 * every executed tool result, and re-injects the rendered [EVIDENCE LEDGER]
 * note as a TRANSIENT system message every turn — pushed pre-turn, spliced
 * post-turn (the clock-note idiom, ticket 63e9a3cb) so it never accumulates
 * in the transcript and never reaches persisted parts. The note is the
 * EVIDENCE LIST machine-wake rule 6 demands: the citation copy source the
 * authoring supervisor previously had to reconstruct from memory (the
 * production failure — ticket 0e2fcb6f's two phantom msg citations, minted
 * across two supervisor seats in ~7 min on 2026-09-15 and guard-stripped both
 * times).
 *
 * Harness: the REAL ./agent module with the repo-standard stand-ins
 * (agent-zero-tool-gate.test.ts precedent); the model turn is a jest mock
 * that SNAPSHOTS the messages array at call time (the array is mutated
 * post-turn — the splice assertion reads the live reference afterwards).
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
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0) }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { EVIDENCE_LEDGER_PREFIX } from '../chat-agent/evidence-ledger';

// Minimal chat-shaped profile (agent-zero-tool-gate.test.ts precedent): the
// ledger gate needs a TOP-LEVEL loop + input.machineTriggered + non-coding kind.
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
  worktree: '/tmp/evidence-ledger-test',
  sessionId: 'sess-evidence-ledger-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile,
  doctrineOverride: 'You are a test agent.',
  history: [],
  // Names the feedback queue: a CODING lane only sees list_feedback when its own
  // prompt works the queue (coding/tool-scope.ts, 2026-09-22) — chat lanes always do.
  userMessage: 'machine wake: sweep the open feedback tickets and report',
  emit: jest.fn(),
  ...(machineTriggered === undefined ? {} : { machineTriggered }),
});

// Turn shapes.
const SWEEP_TURN = {
  content: 'Pulling the queue first.',
  reasoning: '',
  toolCalls: [{ id: 't1', name: 'list_feedback', arguments: '{"status":"open"}' }],
  finishReason: 'tool_calls',
};
const FINAL_NOTE = {
  content: 'Queue unchanged: ticket a1b2c3d4 still open (msg id not captured).',
  reasoning: '',
  toolCalls: [],
  finishReason: 'stop',
};

const TICKET_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const FEEDBACK_JSON = JSON.stringify({
  tickets: [{ id: TICKET_ID, title: 'phantom follow-on', status: 'in_progress', priority: 2 }],
  count: 1,
});

let turnQueue: any[] = [];
let toolResultText = FEEDBACK_JSON;
/** Per-call snapshots of the messages array AS THE MODEL SAW IT (the live array is mutated post-turn). */
let messageSnapshots: Array<Array<{ role: string; content: string }>> = [];

const ledgerNotesIn = (snapshot: Array<{ role: string; content: string }>) =>
  snapshot.filter((m) => m.role === 'system' && m.content.startsWith(EVIDENCE_LEDGER_PREFIX));

// build 2026-10-08 F-1: these per-turn snapshot pins count the run's OWN turns — the finish_run shadow
// nudge (an extra isolated turn on machine coding / supervisor runs, pinned in agent-finish-run.test.ts) is off here.
const savedFinishRunDisabled = process.env.FINISH_RUN_DISABLED;
afterAll(() => { if (savedFinishRunDisabled === undefined) delete process.env.FINISH_RUN_DISABLED; else process.env.FINISH_RUN_DISABLED = savedFinishRunDisabled; });
beforeEach(() => {
  process.env.FINISH_RUN_DISABLED = '1';
  jest.clearAllMocks();
  _store.clear();
  turnQueue = [];
  toolResultText = FEEDBACK_JSON;
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
  mockExecuteCodingTool.mockImplementation(async () => toolResultText);
});

describe('evidence-ledger wiring (feedback a84cc306) — chat-lane machine wakes', () => {
  it('the [EVIDENCE LEDGER] note rides the turn AFTER a tool result, carries the harvested ticket id, and is spliced post-turn (never in persisted parts)', async () => {
    turnQueue = [SWEEP_TURN, FINAL_NOTE];
    const result = await runCodingAgent(makeInput(true));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    // Turn 1 (before any tool result): the ledger is empty — NO note pushed.
    expect(ledgerNotesIn(messageSnapshots[0])).toEqual([]);
    // Turn 2 (after the list_feedback result): exactly ONE transient system
    // note, carrying the id the tool ACTUALLY returned (normalized first-8).
    const notes = ledgerNotesIn(messageSnapshots[1]);
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain('ticket a1b2c3d4');
    expect(notes[0].content).toContain('EVIDENCE LIST');
    expect(notes[0].content).toContain('(id not captured)');

    // Spliced post-turn: the LIVE messages array (mutated after the call —
    // the mock recorded the reference) no longer carries the note…
    const liveMessages = mockRunModelTurn.mock.calls[1][1] as any[];
    expect(
      liveMessages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(EVIDENCE_LEDGER_PREFIX)),
    ).toBe(false);
    // …and the note never became transcript content (context-only channel).
    expect(
      result.parts.some((p: any) => typeof p?.text === 'string' && p.text.startsWith(EVIDENCE_LEDGER_PREFIX)),
    ).toBe(false);
    expect(result.finalText).toBe(FINAL_NOTE.content);
  });

  it('GATE POSITIVE (ticket 5036d072) — a coding-lane MACHINE run gets the lane-scoped note: fleet ids carried, claims-block wording, spliced post-turn', async () => {
    // The a84cc306 build gated coding lanes OUT ("finals ride the claims-
    // manifest idiom") — detection-only, and the detection-only lanes stayed
    // the FM-2.6 recidivists. 5036d072 extends the PREVENTION note to them.
    turnQueue = [SWEEP_TURN, FINAL_NOTE];
    const codingProfile: AgentProfile = { ...CHAT_TEST_PROFILE, kind: 'coding' };
    const result = await runCodingAgent(makeInput(true, codingProfile));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(ledgerNotesIn(messageSnapshots[0])).toEqual([]); // empty ledger — no note on turn 1
    const notes = ledgerNotesIn(messageSnapshots[1]);
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toContain('ticket a1b2c3d4'); // the id the tool ACTUALLY returned
    expect(notes[0].content).toContain('claims block'); // coding-lane wording…
    expect(notes[0].content).not.toContain('rule 6'); // …not the wake-note contract
    expect(notes[0].content).toContain('(id not captured)');

    // Spliced post-turn, never persisted — same transient idiom as chat lanes.
    const liveMessages = mockRunModelTurn.mock.calls[1][1] as any[];
    expect(
      liveMessages.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith(EVIDENCE_LEDGER_PREFIX)),
    ).toBe(false);
    expect(
      result.parts.some((p: any) => typeof p?.text === 'string' && p.text.startsWith(EVIDENCE_LEDGER_PREFIX)),
    ).toBe(false);
    expect(result.finalText).toBe(FINAL_NOTE.content);
  });

  it('GATE NEGATIVE — a USER-triggered coding run never sees the note (machineTriggered absent)', async () => {
    turnQueue = [SWEEP_TURN, FINAL_NOTE];
    const codingProfile: AgentProfile = { ...CHAT_TEST_PROFILE, kind: 'coding' };
    const result = await runCodingAgent(makeInput(undefined, codingProfile));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    for (const snapshot of messageSnapshots) expect(ledgerNotesIn(snapshot)).toEqual([]);
    expect(result.finalText).toBe(FINAL_NOTE.content);
  });

  it('GATE NEGATIVE — a USER-triggered chat turn never sees the note (machineTriggered absent)', async () => {
    turnQueue = [SWEEP_TURN, FINAL_NOTE];
    const result = await runCodingAgent(makeInput(undefined));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    for (const snapshot of messageSnapshots) expect(ledgerNotesIn(snapshot)).toEqual([]);
    expect(result.finalText).toBe(FINAL_NOTE.content);
  });

  it('no harvestable ids in the run\'s tool results ⇒ no note (render stays null — the preamble alone carries the rule)', async () => {
    toolResultText = 'No tickets matched that filter.';
    turnQueue = [SWEEP_TURN, FINAL_NOTE];
    const result = await runCodingAgent(makeInput(true));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    for (const snapshot of messageSnapshots) expect(ledgerNotesIn(snapshot)).toEqual([]);
    expect(result.finalText).toBe(FINAL_NOTE.content);
  });
});
