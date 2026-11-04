/**
 * OUTBOUND CLAIM AUDIT — agent wiring (P4 v1#25 / spark B3+B4), pinned at its
 * gate-flip default (2026-09-11, owner: full steam).
 *
 * The auditor itself (./outbound-claim-audit, its own test) still classifies a
 * machine run's outgoing text as clean / annotated / refused. What THIS file
 * pins is what the agent loop DOES with that verdict:
 *
 *   DEFAULT (observe-only): the tool call dispatches with the model's args
 *   UNCHANGED — no refusal envelope, no ' [unverified]' rewrite — and a
 *   GUARD_STRIKE row (seam outbound_claim, outcome 'observed_refusable' /
 *   'observed_annotatable') records what enforcement WOULD have done. Harm
 *   evidence: 3 rows since 09-08, all 'annotated', both pr_merged annotations
 *   structural false positives (an owner-click merge and other lanes' merges
 *   can never carry THIS run's receipts).
 *
 *   OPT-IN (OUTBOUND_CLAIM_AUDIT_ENFORCE=1): the pre-flip behavior — a
 *   receipt-less completion report on send_chat_message is REFUSED (the
 *   failure-shaped envelope becomes the tool result, nothing dispatches) and
 *   note args get their convicted lines annotated inline before dispatch.
 *
 * Harness: the REAL ./agent module with the repo-standard stand-ins
 * (agent-zero-tool-gate.test.ts precedent — keep the mock header in sync).
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

const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  return { ...actual, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

// Every tool dispatch lands here — the args it receives are the ones that
// actually dispatched (post-audit under enforce, verbatim under observe).
const mockExecuteCodingTool: jest.Mock = jest.fn(async () => 'Message sent (receipt 11111111-2222-4333-8444-555555555555).');
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
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));

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
import { OUTBOUND_UNVERIFIED_MARK } from './outbound-claim-audit';

const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 6,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

// The target chat id appears in the wake text so the tool pre-flight's
// id-grounding check (tool-preflight.ts) sees it as legitimately obtained.
const TARGET_CHAT = 'c0e22e36-1111-4222-8333-444444444444';

const makeInput = (): AgentRunInput => ({
  worktree: '/tmp/outbound-claim-wiring-test',
  sessionId: 'sess-outbound-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: `machine wake: report lane status to the supervisor chat ${TARGET_CHAT}`,
  emit: jest.fn(),
  machineTriggered: true,
});

/** A pure completion report — receipt-less pr_merged + deploy claims (the
 *  auditor's own REFUSE shape for send_chat_message). */
const REPORT = [
  'Status: merged PR #999 and squash-merged PR #998 to main.',
  'Deploy green, health check 200 — all done.',
].join('\n');

/** A mixed note: one convicted completion claim among plain status lines (the
 *  auditor's ANNOTATE shape). */
const NOTE = [
  'Blocked on the upstream schema question — waiting for the owner to pick a column type.',
  'Merged PR #4242 to main earlier in this run.',
  'Next: re-run the migration once the type is chosen.',
].join('\n');

const SEND_TURN = {
  content: 'Reporting to the supervisor.',
  reasoning: '',
  toolCalls: [{ id: 's1', name: 'send_chat_message', arguments: JSON.stringify({ chatId: TARGET_CHAT, message: REPORT }) }],
  finishReason: 'tool_calls',
};
const NOTE_TURN = {
  content: 'Recording the blocker.',
  reasoning: '',
  toolCalls: [{ id: 'n1', name: 'todo_update', arguments: JSON.stringify({ todoId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'blocked', blockedReason: NOTE }) }],
  finishReason: 'tool_calls',
};
const FINAL = { content: 'Reported. Nothing else this run.', reasoning: '', toolCalls: [], finishReason: 'stop' };

const outboundMetrics = () => mockRecordLoopMetric.mock.calls
  .map((c) => c[0])
  .filter((m) => m?.meta?.seam === 'outbound_claim');
const dispatchedArgs = (tool: string) => mockExecuteCodingTool.mock.calls.find((c) => c[1] === tool)?.[2];

const ENFORCE_ENV = 'OUTBOUND_CLAIM_AUDIT_ENFORCE';
const savedEnforce = process.env[ENFORCE_ENV];

beforeEach(() => {
  jest.clearAllMocks();
  mockRunModelTurn.mockReset();
  _store.clear();
  delete process.env[ENFORCE_ENV];
});

afterEach(() => {
  if (savedEnforce === undefined) delete process.env[ENFORCE_ENV];
  else process.env[ENFORCE_ENV] = savedEnforce;
});

describe('outbound claim audit wiring — OBSERVE-ONLY by default (gate flip 2026-09-11)', () => {
  it('a receipt-less completion report on send_chat_message DISPATCHES UNCHANGED — metric outcome observed_refusable, no refusal envelope', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(SEND_TURN)
      .mockResolvedValueOnce(FINAL);
    const input = makeInput();
    const result = await runCodingAgent(input);

    // The send executed with the model's own args, byte-identical.
    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    expect(dispatchedArgs('send_chat_message')).toEqual({ chatId: TARGET_CHAT, message: REPORT });
    // No refusal envelope reached the model as the tool result.
    const toolMsgs = (mockRunModelTurn.mock.calls[1][1] as any[]).filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toContain('Message sent');
    expect(toolMsgs[0].content).not.toContain('unverified_outbound_claims');
    expect(toolMsgs[0].content).not.toContain('NOT sent');
    expect(result.finalText).toBe(FINAL.content);

    // Telemetry keeps flowing under the observed outcome, kinds preserved.
    expect(outboundMetrics()).toEqual([expect.objectContaining({
      kind: 'guard_strike', sessionId: 'sess-outbound-1',
      meta: expect.objectContaining({ seam: 'outbound_claim', tool: 'send_chat_message', outcome: 'observed_refusable' }),
    })]);
    expect(outboundMetrics()[0].meta.kinds).toEqual(expect.arrayContaining(['pr_merged', 'deploy']));
    expect(outboundMetrics().some((m) => m.meta.outcome === 'refused')).toBe(false);

    // A non-blocking progress note says what was observed — never "refused".
    const progress = (input.emit as jest.Mock).mock.calls
      .filter((c) => c[0] === 'progress' && c[1]?.stage === 'evidence-guard').map((c) => c[1].message);
    expect(progress).toEqual(['Outbound message carries completion claims without this-run receipts (observed — dispatched unchanged)']);
  });

  it('a note with a convicted line (todo_update blockedReason) dispatches WITHOUT the inline [unverified] rewrite — metric outcome observed_annotatable', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(NOTE_TURN)
      .mockResolvedValueOnce(FINAL);
    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    const args = dispatchedArgs('todo_update');
    expect(args.blockedReason).toBe(NOTE);
    expect(args.blockedReason).not.toContain(OUTBOUND_UNVERIFIED_MARK);
    // The streamed tool_call frame carries the model's args verbatim too.
    expect(outboundMetrics().map((m) => m.meta.outcome)).toEqual(['observed_annotatable']);
    expect(outboundMetrics()[0].meta.kinds).toEqual(expect.arrayContaining(['pr_merged']));
  });

  it('the opt-in spelling is exact: any value other than "1" stays observe-only', async () => {
    for (const v of ['true', 'yes', '0', '']) {
      process.env[ENFORCE_ENV] = v;
      mockRunModelTurn.mockReset();
      mockExecuteCodingTool.mockClear();
      mockRecordLoopMetric.mockClear();
      mockRunModelTurn
        .mockResolvedValueOnce(SEND_TURN)
        .mockResolvedValueOnce(FINAL);
      await runCodingAgent(makeInput());
      expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
      expect(dispatchedArgs('send_chat_message')).toEqual({ chatId: TARGET_CHAT, message: REPORT });
      expect(outboundMetrics().map((m) => m.meta.outcome)).toEqual(['observed_refusable']);
    }
  });
});

describe('outbound claim audit wiring — ENFORCED under OUTBOUND_CLAIM_AUDIT_ENFORCE=1 (pre-flip behavior)', () => {
  beforeEach(() => { process.env[ENFORCE_ENV] = '1'; });

  it('a receipt-less completion report on send_chat_message is REFUSED — nothing dispatches, the failure envelope is the tool result', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(SEND_TURN)
      .mockResolvedValueOnce(FINAL);
    const input = makeInput();
    await runCodingAgent(input);

    expect(mockExecuteCodingTool).not.toHaveBeenCalled();
    const toolMsgs = (mockRunModelTurn.mock.calls[1][1] as any[]).filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    const envelope = JSON.parse(toolMsgs[0].content);
    expect(envelope.ok).toBe(false);
    expect(envelope.reason).toBe('unverified_outbound_claims');
    expect(outboundMetrics().map((m) => m.meta.outcome)).toEqual(['refused']);
    const progress = (input.emit as jest.Mock).mock.calls
      .filter((c) => c[0] === 'progress' && c[1]?.stage === 'evidence-guard').map((c) => c[1].message);
    expect(progress[0]).toContain('Outbound message refused');
  });

  it('a note with a convicted line dispatches with the inline [unverified] annotation', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(NOTE_TURN)
      .mockResolvedValueOnce(FINAL);
    await runCodingAgent(makeInput());

    expect(mockExecuteCodingTool).toHaveBeenCalledTimes(1);
    const args = dispatchedArgs('todo_update');
    expect(args.blockedReason).toContain(OUTBOUND_UNVERIFIED_MARK);
    expect(args.blockedReason).toContain(`Merged PR #4242 to main earlier in this run.${OUTBOUND_UNVERIFIED_MARK}`);
    expect(outboundMetrics().map((m) => m.meta.outcome)).toEqual(['annotated']);
  });
});
