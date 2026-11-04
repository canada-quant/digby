/**
 * A4 (2026-09-27 spark-cluster audit): a project with NO verify chain used to
 * make the harness auto-verify exit SILENTLY (`if (!chain.length) break;`
 * before verify_start) — no event, no metric — so every "verified" the lane
 * wrote was its own probe and nothing on the board said so (spark-cluster:
 * 0 verify_result in 669 runs, 12 verify tool receipts).
 *
 * Pins: on a clean auto-mode finish with an empty chain the run emits
 * `verify_skipped {reason:'no_chain', auto:true}` + a progress line, records
 * ONE loop_metrics `verify_absent` row {projectId, seam:'auto'} and the
 * session marker (recordVerifyAbsent); the lane's own `verify` tool call
 * records the same with seam:'tool' and its answer now carries the todo
 * instruction. Observe-only: the run finishes exactly as before; the kill
 * seam is observed unconditionally (the kill switch retired 2026-11-02).
 *
 * Review-fixer pins (same day): the auto seam RE-READS .digby/config.json at
 * the finish (a config the lane created mid-run is seen: the chain runs, no
 * skip / row / marker); the tool seam judges absence on the
 * UNFILTERED chain (verify({only:['lint']}) on a typecheck+test project is a
 * precise subset answer, never the project-level marker); the doctrine and the
 * tool answer carry the no-commands escape hatch + the file-it-once rule.
 *
 * Scaffold mirrors agent-verify-reflection.test.ts (REAL agentLoop, model turn
 * + IO-boundary services stubbed).
 */


jest.setTimeout(60_000);

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// config/env calls process.exit(1) without env vars and kills the jest worker at
// import (agent → tools → platform-tools → platform.service reaches it).
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));

const mockRunModelTurn = jest.fn();
jest.mock('./coding-model', () => ({
  ...(jest.requireActual('./coding-model')),
  seatUnservableReason: async () => null,
  runModelTurn: (...a: any[]) => mockRunModelTurn(...a),
}));
jest.mock('./coding-memory.service', () => ({
  __esModule: true,
  getUserCodingMemory: jest.fn(async () => null),
  getProjectMemory: jest.fn(async () => null),
  getSessionMemory: jest.fn(async () => null),
  formatCodingMemoryBlock: jest.fn(() => ''),
  updateCodingMemoryAsync: jest.fn(),
}));
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => ''),
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'tok') }));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => null),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => null),
  getPlanStrict: jest.fn(async () => null),
  applyPlan: jest.fn(),
  planToUpdate: jest.fn(),
  renderPlanReminder: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
const mockRecordVerifyAbsent: jest.Mock = jest.fn(async () => {});
jest.mock('./verify-state', () => ({
  __esModule: true,
  ...(jest.requireActual('./verify-state')), // keeps the REAL verifyAbsentTelemetryDisabled (env kill switch under test)
  recordVerify: jest.fn(async () => {}),
  getVerifyState: jest.fn(async () => null),
  captureVerifyFingerprint: jest.fn(async () => null),
  recordVerifyAbsent: (...a: any[]) => mockRecordVerifyAbsent(...a),
}));
jest.mock('./usage-store', () => ({
  __esModule: true,
  loadSessionUsage: jest.fn(async () => ({})),
  commitRunUsage: jest.fn(async (_s: string, snap: any) => snap),
  mergeRunIntoSession: jest.fn((_prior: any, snap: any) => snap),
  emptySessionUsage: jest.fn(() => ({})),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordRunSpend: jest.fn(),
  noteSeatFallback: jest.fn(),
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', PROVIDER_REJECTED: 'provider_rejected', SELF_AUDIT_RUN: 'self_audit_run', VERIFY_ABSENT: 'verify_absent' },
}));


// verify-state's real module (kept for the kill-switch reader) imports the
// context store — stub it so nothing reaches Prisma.
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
  storeDelete: jest.fn(async () => {}),
}));

// The verify chain resolves EMPTY (no .digby/config.json / no runnable command)
// through the REAL resolveVerifyChain; runVerifyChain must never be reached.
const mockReadDigbyConfig: jest.Mock = jest.fn(async () => null);
const mockRunVerifyChain: jest.Mock = jest.fn(async () => { throw new Error('runVerifyChain must not run without a chain'); });
const mockLoopCfg = {
  maxAutoContinueRounds: 0, maxAutoVerifyIterations: 2, resumeStepBudget: 30,
  sameFailureStop: 3, oscillationWindow: 5, perCommandTimeoutMs: 1000,
};
jest.mock('./verify.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./verify.service')),
  readDigbyConfig: (...a: any[]) => mockReadDigbyConfig(...a),
  // DW-2 (FO f118): agent.ts's auto-verify re-read now uses the DETAILED
  // reader — route it through the same mock so mid-run config fixtures
  // (created/fixed by the lane under test) stay visible to the seam.
  readDigbyConfigDetailed: (...a: any[]) => Promise.resolve(mockReadDigbyConfig(...a)).then(c => (c ? { config: c } : { absent: true as const })),
  runVerifyChain: (...a: any[]) => mockRunVerifyChain(...a),
  loopConfig: jest.fn(() => ({ ...mockLoopCfg })),
}));
jest.mock('./verify-limiter', () => ({
  __esModule: true,
  withVerifySlot: jest.fn(async (fn: () => Promise<any>) => fn()),
}));
jest.mock('./reflection', () => ({
  __esModule: true,
  reflectionDisabled: jest.fn(() => true),
  REFLECTION_MAX_PER_RUN: 0,
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  fileStreakInvestigation: jest.fn(async () => undefined),
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  ...(jest.requireActual('../feedback/feedback.service')),
  fileFeedbackTicket: jest.fn(async () => ({})),
}));

// Integration wrapper modules pulled in transitively via tools → platform-tools
// (same base set as agent-verify-reflection.test.ts — they must never load for real).
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

import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';

const FINAL = { content: 'Done.', reasoning: '', toolCalls: [], finishReason: 'stop' };
const VERIFY_CALL = { content: '', reasoning: '', toolCalls: [{ id: 'v1', name: 'verify', arguments: '{}' }], finishReason: 'tool_calls' };

const emitted: Array<{ type: string; data: any }> = [];
const baseInput = (over: Partial<AgentRunInput> = {}): AgentRunInput => ({
  worktree: '/tmp/wt-verify-absent-nonexistent',
  sessionId: 's-verify-absent-1',
  runId: 'run-va-1',
  projectId: 'p-spark',
  userId: 'u1',
  permissionMode: 'auto',
  model: 'kimi-k3',
  projectName: 'spark-cluster',
  branch: 'digby/x',
  history: [],
  userMessage: 'finish the sweep',
  emit: jest.fn((type: string, data: any) => { emitted.push({ type, data }); }),
  ...over,
});

const absentRows = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r.kind === 'verify_absent');
/** The messages array handed to the Nth runModelTurn call (provider, messages, tools, …). */
const turnMessages = (n: number): any[] => (mockRunModelTurn.mock.calls[n]?.[1] as any[]) ?? [];

const GREEN_TYPECHECK = { passed: true, ran: true, unverified: false, stages: [{ key: 'typecheck', command: 'tsc --noEmit', exitCode: 0, passed: true, outputTail: '' }] };
const GREEN_TWO = { passed: true, ran: true, unverified: false, stages: [
  { key: 'typecheck', command: 'tsc --noEmit', exitCode: 0, passed: true, outputTail: '' },
  { key: 'test', command: 'jest', exitCode: 0, passed: true, outputTail: '' },
] };

beforeEach(() => {
  jest.clearAllMocks();
  emitted.length = 0;
  mockReadDigbyConfig.mockResolvedValue(null);
  mockRunModelTurn.mockResolvedValue(FINAL);
  // clearAllMocks keeps implementations — restore the defaults a test may have replaced.
  mockRunVerifyChain.mockImplementation(async () => { throw new Error('runVerifyChain must not run without a chain'); });
  mockRecordVerifyAbsent.mockImplementation(async () => {});
});

describe('A4: auto-verify with NO verify chain is observed, never silent (2026-09-27)', () => {
  it('clean auto-mode finish, no .digby/config.json: verify_skipped + progress + ONE verify_absent row {projectId, seam:auto} + session marker; the run still finishes as before', async () => {
    const result = await runCodingAgent(baseInput());

    expect(result.finalText).toBe('Done.');
    expect(mockRunVerifyChain).not.toHaveBeenCalled();
    expect(emitted.find(e => e.type === 'verify_start')).toBeUndefined();
    expect(emitted.find(e => e.type === 'verify_result')).toBeUndefined();

    const skipped = emitted.filter(e => e.type === 'verify_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].data).toEqual({ reason: 'no_chain', auto: true, configPresent: false });
    const progress = emitted.filter(e => e.type === 'progress' && /Auto-verify skipped: no verify chain/.test(String(e.data?.message)));
    expect(progress).toHaveLength(1);
    expect(progress[0].data.message).toContain('no .digby/config.json');
    expect(progress[0].data.message).toContain("lane's own probe");

    const rows = absentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 's-verify-absent-1', runId: 'run-va-1', meta: { projectId: 'p-spark', reason: 'no_chain', seam: 'auto', configPresent: false } });
    expect(mockRecordVerifyAbsent).toHaveBeenCalledTimes(1);
    expect(mockRecordVerifyAbsent).toHaveBeenCalledWith('s-verify-absent-1', { seam: 'auto', configPresent: false });
  });

  it('a .digby/config.json WITHOUT runnable commands is the same skip with configPresent:true', async () => {
    mockReadDigbyConfig.mockResolvedValue({ defaultBranch: 'main', commands: { typecheck: null, test: null } });
    await runCodingAgent(baseInput());
    const skipped = emitted.filter(e => e.type === 'verify_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].data).toEqual({ reason: 'no_chain', auto: true, configPresent: true });
    expect(emitted.find(e => e.type === 'progress' && /has no runnable typecheck\/lint\/test command/.test(String(e.data?.message)))).toBeDefined();
    expect(absentRows()[0].meta).toMatchObject({ configPresent: true, seam: 'auto' });
  });

  it("the lane's own verify tool call on a chain-less project: seam:'tool' row + marker, the answer carries the todo instruction, and the auto seam still fires at the finish", async () => {
    mockRunModelTurn.mockResolvedValueOnce(VERIFY_CALL).mockResolvedValue(FINAL);
    await runCodingAgent(baseInput());

    const rows = absentRows();
    expect(rows.map((r: any) => r.meta.seam)).toEqual(['tool', 'auto']);
    expect(rows[0]).toMatchObject({ sessionId: 's-verify-absent-1', meta: { projectId: 'p-spark', reason: 'no_chain', configPresent: false } });
    expect(mockRecordVerifyAbsent.mock.calls.map((c: any[]) => c[1].seam)).toEqual(['tool', 'auto']);
    // The tool answer (a tool-role message on the 2nd model turn) tells the
    // lane what to do instead of writing "verified".
    const toolMsg = turnMessages(1).find((m: any) => m.role === 'tool');
    expect(String(toolMsg?.content)).toContain('No verify chain configured');
    expect(String(toolMsg?.content)).toContain('add ONE plan step to create .digby/config.json');
    expect(String(toolMsg?.content)).toContain('unverified — no verify chain');
    // Review fix: the escape hatch (a repo with no such commands adds NO step,
    // never a placeholder) and the file-it-once rule ride the same answer …
    expect(String(toolMsg?.content)).toContain('never invent a placeholder command');
    expect(String(toolMsg?.content)).toContain('no verify chain applies: <reason>');
    expect(String(toolMsg?.content)).toContain('file the config ONCE');
    // … and the coding system prompt carries the same two clauses.
    const systemText = turnMessages(0).filter((m: any) => m.role === 'system').map((m: any) => String(m.content)).join('\n');
    expect(systemText).toContain('never invent a placeholder command');
    expect(systemText).toContain('file the config ONCE');
  });

  it('review fix: a config CREATED mid-run (the lane follows its own doctrine) + a green verify — the auto seam re-reads it, runs the chain, and writes NO skip / row / marker', async () => {
    // run start: absent; every later read (the tool call, the auto seam): present.
    mockReadDigbyConfig.mockResolvedValueOnce(null).mockResolvedValue({ commands: { typecheck: 'tsc --noEmit' } });
    mockRunVerifyChain.mockResolvedValue(GREEN_TYPECHECK);
    mockRunModelTurn.mockResolvedValueOnce(VERIFY_CALL).mockResolvedValue(FINAL);
    const result = await runCodingAgent(baseInput());

    expect(result.finalText).toBe('Done.');
    const toolMsg = turnMessages(1).find((m: any) => m.role === 'tool');
    expect(String(toolMsg?.content)).toMatch(/^Verify PASSED/);
    expect(emitted.find(e => e.type === 'verify_skipped')).toBeUndefined();
    expect(emitted.find(e => e.type === 'progress' && /Auto-verify skipped/.test(String(e.data?.message)))).toBeUndefined();
    expect(absentRows()).toHaveLength(0);
    expect(mockRecordVerifyAbsent).not.toHaveBeenCalled();
    // The auto seam ran the chain the lane created (tool call + auto = 2 runs).
    expect(mockRunVerifyChain).toHaveBeenCalledTimes(2);
    expect(emitted.find(e => e.type === 'verify_result' && e.data?.auto === true)?.data).toMatchObject({ passed: true });
  });

  it("review fix: verify({only:['lint']}) on a project WITH typecheck+test is a precise subset answer — no verify_absent row, no marker, no create-config instruction; the auto seam runs the full chain", async () => {
    mockReadDigbyConfig.mockResolvedValue({ commands: { typecheck: 'tsc --noEmit', test: 'jest' } });
    mockRunVerifyChain.mockResolvedValue(GREEN_TWO);
    mockRunModelTurn
      .mockResolvedValueOnce({ ...VERIFY_CALL, toolCalls: [{ id: 'v1', name: 'verify', arguments: JSON.stringify({ only: ['lint'] }) }] })
      .mockResolvedValue(FINAL);
    await runCodingAgent(baseInput());

    const toolMsg = turnMessages(1).find((m: any) => m.role === 'tool');
    expect(String(toolMsg?.content)).toContain('None of the requested verify stages (lint) is configured — configured stages: typecheck, test');
    expect(String(toolMsg?.content)).not.toContain('No verify chain configured');
    expect(String(toolMsg?.content)).not.toContain('.digby/config.json with the real commands');
    expect(absentRows()).toHaveLength(0);
    expect(mockRecordVerifyAbsent).not.toHaveBeenCalled();
    // The subset answer ran nothing; the auto seam ran the real chain once.
    expect(mockRunVerifyChain).toHaveBeenCalledTimes(1);
    expect(emitted.find(e => e.type === 'verify_result')?.data).toMatchObject({ auto: true, passed: true });
    expect(emitted.find(e => e.type === 'verify_skipped')).toBeUndefined();
  });

  it('fail-open: a marker write that REJECTS never touches the run — the event and row still land, the run finishes', async () => {
    mockRecordVerifyAbsent.mockRejectedValue(new Error('store down'));
    const result = await runCodingAgent(baseInput());
    expect(result.finalText).toBe('Done.');
    expect(emitted.filter(e => e.type === 'verify_skipped')).toHaveLength(1);
    expect(absentRows()).toHaveLength(1);
  });

  it('a chain that EXISTS is untouched: verify_start fires, no verify_skipped, no verify_absent row', async () => {
    mockReadDigbyConfig.mockResolvedValue({ commands: { typecheck: 'tsc --noEmit' } });
    mockRunVerifyChain.mockResolvedValueOnce({ passed: true, ran: true, unverified: false, stages: [{ key: 'typecheck', command: 'tsc --noEmit', exitCode: 0, passed: true, outputTail: '' }] });
    const result = await runCodingAgent(baseInput());
    expect(result.finalText).toBe('Done.');
    // The green check rides the transcript parts (not finalText) — as before.
    expect(result.parts.some((p: any) => p.type === 'text' && /Auto-verify passed \(typecheck\)/.test(String(p.text)))).toBe(true);
    expect(emitted.find(e => e.type === 'verify_start')).toBeDefined();
    expect(emitted.find(e => e.type === 'verify_result')?.data).toMatchObject({ passed: true, auto: true });
    expect(emitted.find(e => e.type === 'verify_skipped')).toBeUndefined();
    expect(absentRows()).toHaveLength(0);
    expect(mockRecordVerifyAbsent).not.toHaveBeenCalled();
  });
});
