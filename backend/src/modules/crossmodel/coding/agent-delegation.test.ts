/**
 * Delegation-upgrade bundle (audit #10+) — the agent LOOP end-to-end with a
 * mocked model turn (agent-reject-back.test.ts harness): worker model tiering
 * at dispatch, the structured result envelope on the delegate return path,
 * incremental (mid-flight) worker offload, and the completed-delegations
 * resume note in dispatch checkpoints + on resume.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));
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
jest.mock('../imessage/agent-link', () => ({ agentBroker: { dispatch: jest.fn() } }));

// The model turn: ONE mock drives orchestrator + worker turns in call order.
// Every invocation is stamped into `timeline` so cross-mock ordering (live
// offload vs the worker's next turn) is assertable.
const timeline: string[] = [];
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return {
    ...actual,
    // Worker seat pre-flight (2026-09-08) runs env-key checks — keyless jest
    // would refuse every dispatch. Every seat is servable in these suites.
    seatUnservableReason: async () => null,
    runModelTurn: (...a: any[]) => {
      timeline.push(`turn:${a[0]?.model}`);
      return mockRunModelTurn(...a);
    },
  };
});

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
  buildCodingClockNote: jest.fn(() => '[HARNESS CLOCK] test'),
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));

// storeFindings is order-stamped into the shared timeline (live-offload test).
const mockStoreFindings: jest.Mock = jest.fn(async () => 1);
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  storeFindings: (...a: any[]) => {
    timeline.push(`store:${a?.[2]?.[0]?.ref ?? ''}`);
    return mockStoreFindings(...a);
  },
}));

// Plan link (delegate todo_id path): applyPlan captures the status the
// envelope produced.
const mockApplyPlan: jest.Mock = jest.fn(async (_s: string, _w: string, u: any) => ({ plan: u }));
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => ({ goal: 'g', acceptanceCriteria: [], steps: [{ id: 1, text: 'the step', status: 'in_progress' }] })),
  applyPlan: (...a: any[]) => mockApplyPlan(...a),
  planToUpdate: jest.fn((p: any) => ({ goal: p.goal, steps: p.steps.map((s: any) => ({ ...s })) })),
  renderPlanReminder: jest.fn(() => '<plan>x</plan>'),
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';
import { COMPLETED_DELEGATIONS_MARKER } from './delegation';
import { trimToPreModel, RunCheckpoint } from './run-state';

// Coding-kind profile with the workspace machinery off: delegation, tiering,
// the envelope path, checkpoints, and offload are all profile-agnostic — only
// profile.kind==='coding' (delegate advertised, any role allowed) matters here.
const CODING_TEST_PROFILE: AgentProfile = {
  kind: 'coding',
  maxSteps: 6,
  maxDelegations: 4,
  contextCharBudget: 500_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'coding',
};

let worktree: string;

const makeInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree,
  sessionId: 'sess-delegation-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'ask',
  // Legacy stored id ON PURPOSE: resolveProviderForRun must auto-migrate a
  // pre-cutover glm-5.2 session to the glm-5.3 provider (owner 2026-09-03).
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CODING_TEST_PROFILE,
  doctrineOverride: 'You are a test orchestrator.',
  history: [],
  userMessage: 'do the thing',
  emit: jest.fn(),
  ...over,
});

const orchTurn = (toolCalls: any[]) => ({ content: '', reasoning: '', toolCalls, finishReason: 'tool_calls' });
const finalTurn = (content: string) => ({ content, reasoning: '', toolCalls: [], finishReason: 'stop' });
const delegateCall = (args: any) => ({ id: 'tc1', name: 'delegate', arguments: JSON.stringify(args) });

beforeAll(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'digby-delegation-test-'));
  await fs.writeFile(path.join(worktree, 'big.txt'), 'x'.repeat(500), 'utf8');
});
afterAll(async () => { await fs.rm(worktree, { recursive: true, force: true }); });

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
  timeline.length = 0;
  mockStoreFindings.mockImplementation(async () => 1);
  mockApplyPlan.mockImplementation(async (_s: string, _w: string, u: any) => ({ plan: u }));
});

describe('worker model tiering at dispatch (audit #10)', () => {
  test('a helperTier role (verifier) runs on the helper model; the orchestrator stays on its own model', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'verifier', task: 'run the verify chain', title: 'Verify' })]))
      .mockResolvedValueOnce(finalTurn('Chain ran; all green.\n```json\n{"status":"done","artifacts":["report.txt"]}\n```'))
      .mockResolvedValueOnce(finalTurn('All done.'));
    const input = makeInput();
    await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(3);
    expect(mockRunModelTurn.mock.calls[0][0].model).toBe('glm-5.3');     // orchestrator (glm-5.2 session auto-migrated)
    expect(mockRunModelTurn.mock.calls[1][0].model).toBe('qwen3.6-27b'); // helper-tier worker
    expect(mockRunModelTurn.mock.calls[2][0].model).toBe('glm-5.3');
    // The UI event carries the worker's actual model + parsed status.
    expect((input.emit as jest.Mock).mock.calls).toEqual(expect.arrayContaining([
      ['subagent_start', expect.objectContaining({ role: 'verifier', model: 'qwen3.6-27b' })],
      ['subagent_end', expect.objectContaining({ role: 'verifier', model: 'qwen3.6-27b', status: 'done' })],
    ]));
  });

  test("delegate model:'premium' escalates a helper-tier role; model:'helper' downgrades a premium role", async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'verifier', task: 't', model: 'premium' })]))
      .mockResolvedValueOnce(finalTurn('ok\n```json\n{"status":"done"}\n```'))
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'explorer', task: 't2', model: 'helper' })]))
      .mockResolvedValueOnce(finalTurn('mapped\n```json\n{"status":"done"}\n```'))
      .mockResolvedValueOnce(finalTurn('done'));
    await runCodingAgent(makeInput());

    expect(mockRunModelTurn.mock.calls[1][0].model).toBe('glm-5.3');     // premium override on verifier
    expect(mockRunModelTurn.mock.calls[3][0].model).toBe('qwen3.6-27b'); // helper override on explorer
  });

  test('the EDITOR runs on the coding agent\'s model by default (owner 2026-09-08); model:\'helper\' still downgrades it', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'editor', task: 'rename x→y in a.ts', title: 'Edit' })]))
      .mockResolvedValueOnce(finalTurn('renamed\n```json\n{"status":"done","artifacts":["a.ts"]}\n```'))
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'editor', task: 'fix a typo', model: 'helper' })]))
      .mockResolvedValueOnce(finalTurn('fixed\n```json\n{"status":"done"}\n```'))
      .mockResolvedValueOnce(finalTurn('done'));
    const input = makeInput();
    await runCodingAgent(input);

    expect(mockRunModelTurn.mock.calls[1][0].model).toBe('glm-5.3');     // editor default = the session's coding model
    expect(mockRunModelTurn.mock.calls[3][0].model).toBe('qwen3.6-27b'); // explicit helper downgrade
    // The UI event carries the session's STAMPED spec (glm-5.2 here — auto-
    // migrated to the glm-5.3 provider at the call), i.e. the coding model,
    // not the helper.
    expect((input.emit as jest.Mock).mock.calls).toEqual(expect.arrayContaining([
      ['subagent_start', expect.objectContaining({ role: 'editor', model: 'glm-5.2' })],
      ['subagent_start', expect.objectContaining({ role: 'editor', model: 'qwen3.6-27b' })],
    ]));
  });

  test('the delegate schema advertises the tier enum to the model', async () => {
    mockRunModelTurn.mockResolvedValueOnce(finalTurn('done'));
    await runCodingAgent(makeInput());
    const tools = mockRunModelTurn.mock.calls[0][2] as any[];
    const delegate = tools.find(t => t.function?.name === 'delegate');
    expect(delegate.function.parameters.properties.model).toEqual(
      expect.objectContaining({ enum: ['premium', 'helper'] }),
    );
    expect(delegate.function.description).toContain('"helper"');
    const parallel = tools.find(t => t.function?.name === 'delegate_parallel');
    expect(parallel.function.parameters.properties.tasks.items.properties.model).toEqual(
      expect.objectContaining({ enum: ['premium', 'helper'] }),
    );
  });
});

describe('structured worker result envelope on the delegate return path', () => {
  test('worker system prompt carries the envelope instruction; the orchestrator prompt does not; the summary the orchestrator sees is prose + [WORKER STATUS], footer stripped', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'verifier', task: 'verify', todo_id: 1 })]))
      .mockResolvedValueOnce(finalTurn('Chain ran; all green.\n```json\n{"status":"done","artifacts":["report.txt"]}\n```'))
      .mockResolvedValueOnce(finalTurn('All done.'));
    await runCodingAgent(makeInput());

    expect(String(mockRunModelTurn.mock.calls[0][1][0].content)).not.toContain('REPORT FORMAT (harness contract)');
    expect(String(mockRunModelTurn.mock.calls[1][1][0].content)).toContain('REPORT FORMAT (harness contract)');

    const orchFinalMessages = mockRunModelTurn.mock.calls[2][1] as any[];
    const toolMsg = orchFinalMessages.find(m => m.role === 'tool');
    expect(toolMsg.content).toContain('Chain ran; all green.');
    expect(toolMsg.content).toContain('[WORKER STATUS: done | artifacts: report.txt]');
    expect(toolMsg.content).not.toContain('```json');

    // todo link: envelope status 'done' → step completed.
    expect(mockApplyPlan).toHaveBeenCalledTimes(1);
    expect(mockApplyPlan.mock.calls[0][2].steps[0].status).toBe('completed');
  });

  test("envelope status 'blocked' marks the todo blocked even when the word sits far past the old 200-char sniff window", async () => {
    const prose = 'Investigated the failing suite thoroughly and in detail. '.repeat(10);
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'verifier', task: 'verify', todo_id: 1 })]))
      .mockResolvedValueOnce(finalTurn(`${prose}\nIn the end a missing credential stopped me.\n\`\`\`json\n{"status":"blocked","blockedReason":"missing credential"}\n\`\`\``))
      .mockResolvedValueOnce(finalTurn('ok'));
    await runCodingAgent(makeInput());

    expect(mockApplyPlan.mock.calls[0][2].steps[0].status).toBe('blocked');
    expect(mockApplyPlan.mock.calls[0][2].steps[0].note).toContain('Investigated');
  });

  test('missing envelope falls back to prose behavior: raw text as summary, blocked sniffed from the head only', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'verifier', task: 'verify', todo_id: 1 })]))
      .mockResolvedValueOnce(finalTurn('I was unable to run the chain — sandbox has no node.'))
      .mockResolvedValueOnce(finalTurn('ok'));
    const input = makeInput();
    await runCodingAgent(input);

    expect(mockApplyPlan.mock.calls[0][2].steps[0].status).toBe('blocked'); // head-of-prose heuristic
    const orchFinalMessages = mockRunModelTurn.mock.calls[2][1] as any[];
    const toolMsg = orchFinalMessages.find(m => m.role === 'tool');
    expect(toolMsg.content).toBe('I was unable to run the chain — sandbox has no node.');
    expect(toolMsg.content).not.toContain('[WORKER STATUS'); // no fabricated status line
    expect((input.emit as jest.Mock).mock.calls).toEqual(expect.arrayContaining([
      ['subagent_end', expect.objectContaining({ status: 'unknown' })],
    ]));
  });
});

describe('incremental worker offload (mid-flight search_memory)', () => {
  test('an explorer worker stores each qualifying read the moment the result arrives — BEFORE its next model turn — and the digest at the end', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'explorer', task: 'map the repo' })]))
      .mockResolvedValueOnce(orchTurn([{ id: 'w1', name: 'read_file', arguments: JSON.stringify({ path: 'big.txt' }) }]))
      .mockResolvedValueOnce(finalTurn('Mapped it.\n```json\n{"status":"done"}\n```'))
      .mockResolvedValueOnce(finalTurn('done'));
    await runCodingAgent(makeInput());

    // Two stores: the live per-result item + the end-of-worker digest.
    expect(mockStoreFindings).toHaveBeenCalledTimes(2);
    expect(mockStoreFindings.mock.calls[0][1]).toBe('explorer');
    expect(mockStoreFindings.mock.calls[0][2]).toEqual([expect.objectContaining({ ref: 'big.txt', content: 'x'.repeat(500) })]);
    expect(mockStoreFindings.mock.calls[1][2]).toEqual([expect.objectContaining({ ref: 'explorer digest' })]);

    // ORDERING: the item store fires before the worker's NEXT model turn
    // (mid-flight), not at worker end — that is the whole point of the change.
    // Timeline: turn(orch) → turn(worker read) → store:big.txt → turn(worker
    // final) → store:digest → turn(orch final).
    const turnIdxs = timeline.map((e, i) => (e.startsWith('turn:') ? i : -1)).filter(i => i >= 0);
    const storeIdx = timeline.indexOf('store:big.txt');
    expect(storeIdx).toBeGreaterThan(turnIdxs[1]);          // after the read turn…
    expect(storeIdx).toBeLessThan(turnIdxs[2]);             // …but BEFORE the worker's final turn
    expect(timeline.indexOf('store:explorer digest')).toBeGreaterThan(turnIdxs[2]); // digest at worker end, as before
  });
});

describe('delegation resume-notes (dispatch checkpoints + resume)', () => {
  test('a dispatch checkpoint written after a completed delegation carries the note, positioned to survive trimToPreModel', async () => {
    const checkpoints: RunCheckpoint[] = [];
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'verifier', task: 'verify it', title: 'Verify pass' })]))
      .mockResolvedValueOnce(finalTurn('All green.\n```json\n{"status":"done"}\n```'))
      .mockResolvedValueOnce(finalTurn('Finished.'));
    await runCodingAgent(makeInput({ onCheckpoint: cp => checkpoints.push(cp) }));

    const withNote = checkpoints.filter(cp => cp.phase === 'dispatch'
      && cp.messages.some((m: any) => typeof m.content === 'string' && m.content.includes(COMPLETED_DELEGATIONS_MARKER)));
    expect(withNote.length).toBeGreaterThan(0);
    const cp = withNote[withNote.length - 1];
    const note = cp.messages.find((m: any) => typeof m.content === 'string' && m.content.includes(COMPLETED_DELEGATIONS_MARKER));
    expect(note.role).toBe('user');
    expect(note.content).toContain('Verify pass (verifier) → done');

    // The whole point: trimToPreModel rewinds the in-flight turn but KEEPS the note.
    const trimmed = trimToPreModel(cp.messages);
    expect(trimmed.some((m: any) => typeof m.content === 'string' && m.content.includes(COMPLETED_DELEGATIONS_MARKER))).toBe(true);
    expect(trimmed.some((m: any) => Array.isArray(m.tool_calls) && m.tool_calls.length)).toBe(false); // turn regenerates

    // Pre-delegation checkpoints carry NO note (nothing completed yet).
    const preDispatch = checkpoints.find(c => c.phase === 'dispatch' && c.pendingToolCalls?.length);
    expect(preDispatch).toBeDefined();
    expect(preDispatch!.messages.some((m: any) => typeof m.content === 'string' && m.content.includes(COMPLETED_DELEGATIONS_MARKER))).toBe(false);

    // The LIVE transcript never carries the note — later turns don't see it on a healthy run.
    const orchFinalMessages = mockRunModelTurn.mock.calls[2][1] as any[];
    expect(orchFinalMessages.some((m: any) => typeof m.content === 'string' && m.content.includes(COMPLETED_DELEGATIONS_MARKER))).toBe(false);

    // …and a NEW run resumed from that checkpoint regenerates the turn WITH the note in context.
    jest.clearAllMocks();
    mockRunModelTurn.mockResolvedValue(finalTurn('resumed and finished'));
    await runCodingAgent(makeInput({ resumeFrom: cp, userMessage: 'continue' }));
    const resumedMessages = mockRunModelTurn.mock.calls[0][1] as any[];
    expect(resumedMessages.some((m: any) => typeof m.content === 'string' && m.content.includes(COMPLETED_DELEGATIONS_MARKER))).toBe(true);
    expect(resumedMessages.some((m: any) => Array.isArray(m.tool_calls) && m.tool_calls.length)).toBe(false);
  });

  test('the note resets each turn: a delegation in turn 1 leaves no note in turn 2 dispatch checkpoints (its result is in the transcript)', async () => {
    const checkpoints: RunCheckpoint[] = [];
    mockRunModelTurn
      .mockResolvedValueOnce(orchTurn([delegateCall({ role: 'verifier', task: 'verify it' })]))
      .mockResolvedValueOnce(finalTurn('green\n```json\n{"status":"done"}\n```'))
      .mockResolvedValueOnce(orchTurn([{ id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'big.txt' }) }]))
      .mockResolvedValueOnce(finalTurn('Finished.'));
    await runCodingAgent(makeInput({ onCheckpoint: cp => checkpoints.push(cp) }));

    // Turn-2 dispatch checkpoint (the read_file one) has NO note — the worker
    // summary already sits in the transcript as a tool result and survives trim.
    const turn2 = checkpoints.filter(cp => cp.phase === 'dispatch' && cp.pendingToolCalls?.some(t => t.name === 'read_file'));
    expect(turn2.length).toBeGreaterThan(0);
    for (const cp of turn2) {
      expect(cp.messages.some((m: any) => typeof m.content === 'string' && m.content.includes(COMPLETED_DELEGATIONS_MARKER))).toBe(false);
      expect(trimToPreModel(cp.messages).some((m: any) => m.role === 'tool' && String(m.content).includes('green'))).toBe(true);
    }
  });
});
