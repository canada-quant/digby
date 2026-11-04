/**
 * Evidence-guard REJECT-BACK (ticket dc04deea — f8d68167 option (b)): drives
 * runCodingAgent end-to-end with a mocked model turn. A top-level MACHINE
 * run's convicted clean-finish candidate is rejected BACK into the loop (one
 * bounded round) so the run corrects itself before submission; user-triggered
 * runs are never gated; maxRejections caps the correction.
 *
 * The REAL ./agent module runs — its heavy graph (prisma/redis/env/MCPs) is
 * mocked with the repo-standard stand-ins (coding-integrations.test.ts
 * precedent); the model turn is a jest mock; the evidence guard itself is
 * REAL (GitHub lanes 'unavailable' via a null token, so only the
 * deterministic receipt lane fires). The profile is a minimal chat-shaped one
 * (workspaceTools: false) so the worktree/memory machinery stays out — the
 * reject-back gate is profile-agnostic, and runCodingAgent forces
 * allowSubagents:true, which is the topLevel condition the gate needs.
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

// The model turn: ONE mock drives every case (per-test call shapes).
const mockRunModelTurn: jest.Mock = jest.fn();
jest.mock('./coding-model', () => {
  const actual = jest.requireActual('./coding-model');
  // seatUnservableReason: the worker pre-flight (2026-09-08) must not refuse
  // dispatch in keyless jest.
  return { ...actual, seatUnservableReason: async () => null, runModelTurn: (...a: any[]) => mockRunModelTurn(...a) };
});

// Telemetry: the reject-back gate fires GUARD_STRIKE rows with seam reject_back
// (parity with the zero-tool gate's zero_tool_prefinal rows).
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
}));

// In-memory context store (loop-goal-monitor.test.ts pattern) so the REAL
// usage-store reads/writes work without a DB.
const _store = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => _store.get(ns.join('/') + '::' + key) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { _store.set(ns.join('/') + '::' + key, value); }),
}));

// Run-journal reads stay empty (chat profile skips them anyway).
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
// Null token → the guard's GitHub verification lanes are 'unavailable' (SILENT
// — never a conviction), so only the deterministic receipt lane fires.
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

import { runCodingAgent, REJECT_BACK_MARKER } from './agent';
import type { AgentRunInput } from './agent';
import type { AgentProfile } from './agent-profiles';

// Minimal chat-shaped profile (agent-profiles.ts CHAT shape): workspaceTools
// false skips repo context / coding memory / containers / auto-verify; the
// reject-back gate only needs a TOP-LEVEL loop (runCodingAgent forces
// allowSubagents:true) + input.evidenceGuardRejectBack.
const CHAT_TEST_PROFILE: AgentProfile = {
  kind: 'chat',
  maxSteps: 6,
  maxDelegations: 0,
  contextCharBudget: 100_000,
  workspaceTools: false,
  planReminders: false,
  memorySource: 'chat',
};

const makeInput = (triggerKind: 'user' | 'schedule' | 'hook' | 'machine'): AgentRunInput => ({
  worktree: '/tmp/reject-back-test',
  sessionId: 'sess-reject-back-1',
  projectId: 'p1',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'glm-5.2',
  projectName: 'test',
  branch: 'main',
  profile: CHAT_TEST_PROFILE,
  doctrineOverride: 'You are a test agent.',
  history: [],
  userMessage: 'do the thing',
  emit: jest.fn(),
  evidenceGuardRejectBack: {
    triggerKind,
    resumed: false,
    maxRejections: 1,
    priorReceipts: [],
    ticketIdsExist: async () => new Set<string>(),
  },
});

// Zero-receipt completion claims (pr_merged + deploy) — convicted by GUARD 1
// on a machine trigger with an empty in-run receipt set.
const CONVICTED = {
  content: 'Shipped it — PR #57 merged at 10:00Z and the deploy is live.',
  reasoning: '', toolCalls: [], finishReason: 'stop',
};
const CLEAN = {
  content: 'I could not verify anything this run — attempted, unverified.',
  reasoning: '', toolCalls: [], finishReason: 'stop',
};

beforeEach(() => {
  jest.clearAllMocks();
  _store.clear();
});

describe('evidence-guard reject-back in the agent loop (ticket dc04deea)', () => {
  it('a convicted clean-finish candidate is rejected back; the run corrects before submission', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(CONVICTED)
      .mockResolvedValueOnce(CLEAN);
    const result = await runCodingAgent(makeInput('schedule'));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    // The rejection reached the MODEL's context as a user-role harness notice
    // (the leak-retry idiom), carrying the missing-receipt list.
    const call2Messages = mockRunModelTurn.mock.calls[1][1] as any[];
    const notice = call2Messages.find(
      (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('evidence guard REJECTED'),
    );
    expect(notice).toBeDefined();
    expect(notice.content).toContain('pr_merged');
    // The model saw its OWN convicted answer immediately before the notice —
    // the assistant store push precedes the gate (adversarial review N5).
    const convictedIdx = call2Messages.findIndex(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('PR #57 merged at 10:00Z'),
    );
    expect(convictedIdx).toBeGreaterThanOrEqual(0);
    expect(call2Messages.indexOf(notice)).toBeGreaterThan(convictedIdx);
    // The corrected answer is the run's final; the transcript carries the mark.
    expect(result.finalText).toBe(CLEAN.content);
    expect(
      result.parts.some((p) => p.type === 'text' && typeof p.text === 'string'
        && p.text.includes('⚠︎ Final answer rejected by the evidence guard')),
    ).toBe(true);
  });

  it('bounded: ONE rejection round per attempt — a still-convicted correction exits normally', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(CONVICTED)
      .mockResolvedValueOnce(CONVICTED);
    const result = await runCodingAgent(makeInput('schedule'));

    // Exactly one extra turn (maxRejections: 1) — then the candidate exits and
    // the executor's replace/redact lane (option (a)) would take over.
    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(result.finalText).toBe(CONVICTED.content);
  });

  it("triggerKind 'user' is never gated — a convicted candidate finishes in one turn", async () => {
    mockRunModelTurn.mockResolvedValueOnce(CONVICTED);
    const result = await runCodingAgent(makeInput('user'));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(result.finalText).toBe(CONVICTED.content);
    expect(
      result.parts.some((p) => typeof p.text === 'string' && p.text.includes('Final answer rejected by the evidence guard')),
    ).toBe(false);
  });

  // ── In-loop claims-block parity (audit #6 phase 2: applyClaimsBlock: true) ──
  // agent.ts passes applyClaimsBlock to evaluateFinalCandidateForRejectBack so
  // the in-loop gate composes the SAME typed claims-block lane the executor's
  // finalize lane runs: a fully receipt-verified block downgrades the guard-1
  // conviction (no bounce for receipt-proven work); an unverified entry
  // rejects like any other finding.

  it('a fully receipt-verified claims block downgrades the prose conviction — NO reject-back', async () => {
    const VERIFIED_FINAL = [
      'Merged PR #57.',
      '',
      '```claims',
      '[{"type":"pr","ref":"57"}]',
      '```',
    ].join('\n');
    mockRunModelTurn.mockResolvedValueOnce({ content: VERIFIED_FINAL, reasoning: '', toolCalls: [], finishReason: 'stop' });
    const input = makeInput('schedule');
    input.evidenceGuardRejectBack!.priorReceipts = [{
      id: 'rcpt-pr-57', chatId: 'sess-reject-back-1', runId: 'run-1', tool: 'open_pull_request', ok: true,
      ids: { prNumber: 57 }, inputHash: null, outputHash: null, createdAt: new Date(),
    }] as any;

    const result = await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(1); // accepted first time — no correction turn
    expect(result.finalText).toBe(VERIFIED_FINAL);
    expect(
      result.parts.some((p) => typeof p.text === 'string' && p.text.includes('Final answer rejected by the evidence guard')),
    ).toBe(false);
  });

  it('gate flip 2026-09-11: an UNVERIFIED claims-block entry is NOTE-ONLY — it never rejects back (the finalize lane records it as an observed strike)', async () => {
    // Was: "rejects back like any other finding". The typed-claims lane was the
    // #1 conviction kind (112 strikes) and every recoverable exhibit was honest
    // work in the wrong receipt shape — evaluateFinalCandidateForRejectBack now
    // decides on a copy with unverifiedBlockClaims cleared. No env re-arms it.
    const UNVERIFIED_FINAL = [
      'All wrapped up.',
      '',
      '```claims',
      '[{"type":"pr","ref":"999"}]',
      '```',
    ].join('\n');
    mockRunModelTurn
      .mockResolvedValueOnce({ content: UNVERIFIED_FINAL, reasoning: '', toolCalls: [], finishReason: 'stop' });

    const result = await runCodingAgent(makeInput('schedule'));

    expect(mockRunModelTurn).toHaveBeenCalledTimes(1); // accepted first time — no correction turn
    expect(result.finalText).toBe(UNVERIFIED_FINAL);
    expect(
      result.parts.some((p) => typeof p.text === 'string' && p.text.includes('Final answer rejected by the evidence guard')),
    ).toBe(false);
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'reject_back')).toEqual([]);
  });
});

// ── Gate flip 2026-09-11 (owner: full steam) ──────────────────────────────────
// These cases pass maxRejections:1 DIRECTLY, so they exercise the reject-back
// MECHANISM. In production run-executor.ts hands agent.ts
// `maxRejections: process.env.EVIDENCE_GUARD_ENFORCE === '1' ? 1 : 0` — i.e.
// the gate is OBSERVE-ONLY by default (pinned in run-executor.test.ts).
describe('evidence-guard reject-back — maxRejections 0 is a hard no-op (the executor default since 2026-09-11)', () => {
  it('a convicted machine candidate with maxRejections 0 is accepted in ONE turn: no notice, no strike, no marker, no reject_back row', async () => {
    mockRunModelTurn.mockResolvedValueOnce(CONVICTED);
    const input = makeInput('schedule');
    input.evidenceGuardRejectBack!.maxRejections = 0;

    const result = await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(1);
    expect(result.finalText).toBe(CONVICTED.content);
    expect(result.parts.some((p) => p.struck || p.marker === 'guard')).toBe(false);
    expect((input.emit as jest.Mock).mock.calls.some((c) => c[0] === 'guard_marker')).toBe(false);
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'reject_back')).toEqual([]);
    expect(result.guardRejectBacks ?? 0).toBe(0);
  });
});

// ── Owner transcript 2026-09-08 (session a8976e11 firing-87): the correction
// turn must be ACTIONABLE and the rejected draft must be VISIBLY struck ──────
describe('evidence-guard reject-back — correction grant, struck draft, telemetry (2026-09-08)', () => {
  const rejectMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.meta?.seam === 'reject_back');

  it('a rejection on the run\'s FINAL step grants a tool round: the correction turn carries tools and its answer is accepted', async () => {
    // maxSteps 1 ⇒ the only step is the last: tools omitted, FINAL TURN notice
    // pushed. Before the fix the rejection `continue`d straight out of the
    // for-loop and the run ended with the REJECTED fabrication as finalText.
    const ONE_STEP: AgentProfile = { ...CHAT_TEST_PROFILE, maxSteps: 1 };
    mockRunModelTurn
      .mockResolvedValueOnce(CONVICTED)
      .mockResolvedValueOnce(CLEAN);
    const input = { ...makeInput('schedule'), profile: ONE_STEP };
    const result = await runCodingAgent(input);

    expect(mockRunModelTurn).toHaveBeenCalledTimes(2);
    expect(mockRunModelTurn.mock.calls[0][2]).toBeUndefined(); // capped final step: no tools
    const grantedTools = mockRunModelTurn.mock.calls[1][2];
    expect(Array.isArray(grantedTools)).toBe(true);
    expect((grantedTools as any[]).length).toBeGreaterThan(0);
    // The contradictory FINAL TURN notice ("tool calls are no longer
    // available") was spliced before the "verify NOW with real tool calls" notice.
    const call2Messages = mockRunModelTurn.mock.calls[1][1] as any[];
    expect(call2Messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('FINAL TURN:'))).toBe(false);
    expect(call2Messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('evidence guard REJECTED'))).toBe(true);
    expect(result.finalText).toBe(CLEAN.content);
  });

  it('the rejected candidate part is STRUCK, the marker rides parts AND the live stream, and a reject_back GUARD_STRIKE row is recorded', async () => {
    mockRunModelTurn
      .mockResolvedValueOnce(CONVICTED)
      .mockResolvedValueOnce(CLEAN);
    const input = makeInput('schedule');
    const result = await runCodingAgent(input);

    const candidate = result.parts.find((p) => p.type === 'text' && p.text === CONVICTED.content);
    expect(candidate).toBeDefined();
    expect(candidate!.struck).toBe(true);
    const markerIdx = result.parts.findIndex((p) => p.type === 'text' && p.marker === 'guard' && p.text === REJECT_BACK_MARKER);
    expect(markerIdx).toBe(result.parts.indexOf(candidate!) + 1);
    // The accepted final is NOT struck and carries no marker.
    const accepted = result.parts.find((p) => p.type === 'text' && p.text === CLEAN.content);
    expect(accepted).toBeDefined();
    expect(accepted!.struck).toBeUndefined();
    // Live stream: the marker was emitted (before 2026-09-08 it was parts-only,
    // so a viewer watching live read the fabrication as ordinary prose).
    const emitted = (input.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'guard_marker').map((c) => c[1]);
    expect(emitted).toEqual([{ text: REJECT_BACK_MARKER, struckPrev: true }]);
    // Telemetry: one reject_back strike naming the finding classes.
    expect(rejectMetrics()).toEqual([expect.objectContaining({
      kind: 'guard_strike', sessionId: 'sess-reject-back-1',
      meta: expect.objectContaining({ seam: 'reject_back', outcome: 'rejected', round: 1, kinds: expect.arrayContaining(['unproven_completion']) }),
    })]);
  });

  it('a clean first answer records NO reject_back row and strikes nothing', async () => {
    mockRunModelTurn.mockResolvedValueOnce(CLEAN);
    const result = await runCodingAgent(makeInput('schedule'));
    expect(rejectMetrics()).toEqual([]);
    expect(result.parts.some((p) => p.struck || p.marker)).toBe(false);
  });
});
