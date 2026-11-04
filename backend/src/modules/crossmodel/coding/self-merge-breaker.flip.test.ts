/**
 * Gate flip 2026-09-11 (owner: full steam) — the merge_pull_request
 * SELF_MERGE_MAX_CYCLES circuit breaker no longer files an owner card.
 *
 * Its ONE live firing (crossmodel#647, gate verify_chain, cycles 5) was driven
 * by G3 environmental false positives and was answered 'STALE' after the lane
 * had already self-resolved — one useless owner interrupt. Now the breaker:
 *   - records ONE breaker-flagged merge_gate_failure loop metric
 *     (meta { gate, cycles, breaker:true, repo, pr }) — the Fleet Supervisor's
 *     telemetry — instead of flagOwnerQuestion;
 *   - keeps the once-only `cardFiled` bookkeeping so it trips exactly once
 *     per PR;
 *   - tells the lane so in a lane-facing note (no "expect the owner");
 *   - opt-in SELF_MERGE_BREAKER_CARD_ENABLED=1 restores the owner card.
 * The nothing-changed retry refusal beside it is retry discipline and stays.
 *
 * Boundary mocks mirror tools.test.ts (merge_pull_request describe).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../platform/platform.service', () => ({ __esModule: true }));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'],
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    MERGE_GATE_FAILURE: 'merge_gate_failure', MERGE_SUCCESS: 'merge_success', MERGE_SIZE_GUARD: 'merge_size_guard',
    GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
  },
}));
const mockResolveSelfMergePolicy: jest.Mock = jest.fn(async (): Promise<any> => ({ policy: 'on', source: 'setting' }));
const mockEvaluateMergeGates: jest.Mock = jest.fn();
const mockReadAttempt: jest.Mock = jest.fn();
const mockWriteAttempt: jest.Mock = jest.fn(async () => {});
const mockClearAttempt: jest.Mock = jest.fn(async () => {});
const mockRecordMergeLearning: jest.Mock = jest.fn(async () => {});
const mockGithubApi = { put: jest.fn(), get: jest.fn() };
jest.mock('./self-merge.service', () => ({
  __esModule: true,
  selfMergeDisabled: () => false,
  resolveSelfMergePolicy: (...a: any[]) => mockResolveSelfMergePolicy(...a),
  checkOrAskOwner: jest.fn(async () => 'on'),
  evaluateMergeGates: (...a: any[]) => mockEvaluateMergeGates(...a),
  readAttempt: (...a: any[]) => mockReadAttempt(...a),
  writeAttempt: (...a: any[]) => mockWriteAttempt(...a),
  clearAttempt: (...a: any[]) => mockClearAttempt(...a),
  recordMergeLearning: (...a: any[]) => mockRecordMergeLearning(...a),
  nothingChanged: () => false,
  selfMergeMaxCycles: () => 3,
  defaultGithubApi: () => mockGithubApi,
  // WAIT-ONCE (agent-decisions prerequisite 4, 2026-09-27) — inert here: the verify_chain
  // failures under test are never timing-class, so the tool bounces exactly as before.
  selfMergeWaitOnceDisabled: () => false,
  classifyMergeWait: (input: any) => input?.failure?.transient ?? null,
  mergeWaitOnceMs: () => 1,
  repoCiP50Ms: async () => null,
  tryAcquireMergeWaitSlot: () => true,
  releaseMergeWaitSlot: () => {},
  mergeWaitSleep: async () => undefined,
}));
const mockFlagOwnerQuestion: jest.Mock = jest.fn(async (): Promise<any> => ({ kind: 'created' }));
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  flagOwnerQuestion: (...a: any[]) => mockFlagOwnerQuestion(...a),
}));
jest.mock('./ci-status', () => ({
  __esModule: true,
  observeCiAfterPush: jest.fn(async () => ''),
  fetchCiStatus: jest.fn(async () => ({ state: 'none', checks: [], failing: [], total: 0 })),
  renderCiStatus: jest.fn(() => ''),
  emitCiFailed: jest.fn(),
}));
jest.mock('./process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(),
  waitForProcessOutput: jest.fn(),
  readProcessOutput: jest.fn(),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(),
  listProcesses: jest.fn(),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));

import { executeCodingTool, ToolContext } from './tools';

describe('merge_pull_request circuit breaker (observe-only since the 2026-09-11 gate flip)', () => {
  const mkMergeCtx = (over: Partial<Record<string, unknown>> = {}) => ({
    worktree: '/app/coding-workspaces/worktrees/sess-1', sessionId: 'sess-1', userId: 'u1', runId: 'run-9', permissionMode: 'auto',
    projectId: 'p1', projectName: 'proj',
    emit: jest.fn(), alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    getGithubToken: jest.fn(async () => 'tok'),
    ...over,
  }) as unknown as ToolContext;

  const RED = {
    ok: false, gate: 'verify_chain', cause: 'session verify state RED', evidence: 'failedStage=typecheck exit 137',
    suggestedFix: 're-run verify', evidenceHash: 'ev-3', headSha: 'headsha1234567890abcd', alreadyMerged: false,
  };

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ['SELF_MERGE_BREAKER_CARD_ENABLED'] as const;

  beforeEach(() => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    mockRecordLoopMetric.mockClear();
    mockFlagOwnerQuestion.mockClear().mockResolvedValue({ kind: 'created' });
    mockWriteAttempt.mockClear();
    mockRecordMergeLearning.mockClear();
    mockEvaluateMergeGates.mockReset().mockResolvedValue(RED);
    mockReadAttempt.mockReset().mockResolvedValue({ cycles: 2, lastGate: 'verify_chain', lastEvidenceHash: 'ev-2', cardFiled: false });
    mockGithubApi.put.mockReset();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
  });

  it('at the cycle cap: NO owner card — ONE breaker-flagged merge_gate_failure metric, cardFiled bookkeeping kept, lane-facing note', async () => {
    const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 647 });

    expect(out).toContain('MERGE BLOCKED (gate verify_chain, attempt 3)');
    expect(out).toContain('CIRCUIT BREAKER: 3 evidence-distinct failures');
    expect(out).toContain('no owner card is filed');
    expect(out).not.toContain('expect the owner');
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
    expect(mockGithubApi.put).not.toHaveBeenCalled();
    // The ordinary per-attempt failure row still flows … (agent-decisions prerequisite 4,
    // 2026-09-27: every merge_gate_failure row now carries the head the gates judged)
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({
      kind: 'merge_gate_failure', sessionId: 'sess-1', runId: 'run-9',
      meta: { gate: 'verify_chain', cause: 'session verify state RED', repo: 'o/r', pullNumber: 647, cycles: 3, headSha: 'headsha1234567890abcd' },
    });
    // … plus exactly ONE breaker-flagged row.
    const breakerRows = mockRecordLoopMetric.mock.calls.filter(([m]) => m.meta?.breaker === true);
    expect(breakerRows).toHaveLength(1);
    expect(breakerRows[0][0]).toEqual({
      kind: 'merge_gate_failure', sessionId: 'sess-1', runId: 'run-9',
      meta: { gate: 'verify_chain', cycles: 3, breaker: true, repo: 'o/r', pr: 647, headSha: 'headsha1234567890abcd' },
    });
    // Once-only: the attempt record is stamped cardFiled:true (the breaker trips once per PR).
    expect(mockWriteAttempt).toHaveBeenLastCalledWith('sess-1', 'o/r', 647, expect.objectContaining({ cycles: 3, cardFiled: true }));
  });

  it('below the cap: plain MERGE BLOCKED — no breaker row, no note', async () => {
    mockReadAttempt.mockResolvedValue({ cycles: 0, cardFiled: false });
    const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 647 });
    expect(out).toContain('MERGE BLOCKED (gate verify_chain, attempt 1)');
    expect(out).not.toContain('CIRCUIT BREAKER');
    expect(mockRecordLoopMetric.mock.calls.filter(([m]) => m.meta?.breaker === true)).toHaveLength(0);
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('already tripped (cardFiled:true): the breaker does not fire again', async () => {
    mockReadAttempt.mockResolvedValue({ cycles: 5, cardFiled: true });
    const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 647 });
    expect(out).toContain('MERGE BLOCKED (gate verify_chain, attempt 6)');
    expect(out).not.toContain('CIRCUIT BREAKER');
    expect(mockRecordLoopMetric.mock.calls.filter(([m]) => m.meta?.breaker === true)).toHaveLength(0);
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
  });

  it('opt-in SELF_MERGE_BREAKER_CARD_ENABLED=1 restores the owner card (once), with the old note', async () => {
    process.env.SELF_MERGE_BREAKER_CARD_ENABLED = '1';
    const out = await executeCodingTool(mkMergeCtx(), 'merge_pull_request', { repo: 'o/r', pullNumber: 647 });
    expect(mockFlagOwnerQuestion).toHaveBeenCalledTimes(1);
    expect(mockFlagOwnerQuestion).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'sess-1', userId: 'u1', machineTriggered: true,
      question: expect.stringContaining('Self-merge circuit breaker: PR o/r#647'),
    }));
    expect(out).toContain('ONE owner card is now filed');
    expect(mockRecordLoopMetric.mock.calls.filter(([m]) => m.meta?.breaker === true)).toHaveLength(0);
    expect(mockWriteAttempt).toHaveBeenLastCalledWith('sess-1', 'o/r', 647, expect.objectContaining({ cardFiled: true }));
  });
});
