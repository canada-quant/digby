/**
 * REPLAY TEST — ticket c2ee04a1 (enhancement, 2026-10-24): "AUTO runs that
 * exhaust step budget on long on-device work stall silently — nudge agents
 * to arm a schedule_self safety net first".
 *
 * THE INCIDENT BEING REPLAYED: a user-anchored AUTO-mode run doing long
 * paired-device work (computer_task on a Windows laptop: a 3.57 GB model
 * download + TTS install) exhausted its step budget mid-task across two
 * device sessions. The run's final honestly said "I'll drive the install
 * next turn" — and nothing woke the session for that next turn, so the work
 * stalled silently until the owner asked why. Two halves:
 *
 *   1. AGENT-SIDE: no standing guidance told the agent to arm a cheap
 *      one-shot schedule_self safety net BEFORE starting long blocking
 *      on-device/delegation work that could eat the step budget.
 *   2. FRAMEWORK-SIDE: the run-end unfinished-work backstop (below) queues
 *      continuations only for UNATTENDED runs (`unattendedRun = triggerKind
 *      !== 'user' || ownerDispatchRun`, run-executor.ts) — the user-attended
 *      path was completely SILENT: no note, no wake, no acknowledgment that
 *      work remained and nothing would resume it.
 *
 * THE FIX, pinned here (three surfaces, one concern):
 *   a. coding/agent.ts AUTO_WORKFLOW_DOCTRINE — a BUDGET SAFETY NET bullet:
 *      arm ONE cheap one-shot schedule_self before long blocking sequences;
 *      a promised "next turn" is a stall; cancel the one-shot when the work
 *      lands; never stack a second net for the same job.
 *   b. tool-executor.ts computer_task description — the same rule rides the
 *      tool surface the coding orchestrator sees (long device sequences can
 *      consume the whole budget).
 *   c. run-executor.ts — a USER-ATTENDED UNFINISHED NOTE: a user-anchored run
 *      finalizing with pending plan steps now gets an honest harness note
 *      naming the remaining steps and answering "is anything scheduled to
 *      continue this?" from the session's own enabled schedules. It never
 *      queues anything (human-in-the-loop doctrine) and never mutates state.
 *
 * This file pins (c) at the run-end seam with the same claim-shaped harness
 * the unattended backstop pins use (assistant-final transcript write), and
 * pins (a)+(b) as text contracts so the guidance cannot silently regress.
 * The unattended backstop's own behavior is NOT re-pinned here (it has its
 * own pins in run-executor.test.ts / agent-derail-break.*.test.ts).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Redis: in-memory stand-in (same shape as the b397a918 suite). ──
const mockStore = new Map<string, string>();
const mockLists = new Map<string, string[]>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: any) => {
      if (opts?.NX && mockStore.has(k)) return null;
      mockStore.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    del: jest.fn(async (k: string) => { mockStore.delete(k); return 1; }),
    exists: jest.fn(async (k: string) => (mockStore.has(k) ? 1 : 0)),
    expire: jest.fn(async () => true),
    incr: jest.fn(async (k: string) => {
      const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) + 1;
      mockStore.set(k, String(n));
      return n;
    }),
    rPush: jest.fn(async (k: string, v: string) => {
      const l = mockLists.get(k) ?? [];
      l.push(v);
      mockLists.set(k, l);
      return l.length;
    }),
    lPop: jest.fn(async (k: string) => {
      const l = mockLists.get(k) ?? [];
      const v = l.shift();
      if (l.length) mockLists.set(k, l); else mockLists.delete(k);
      return v ?? null;
    }),
    lTrim: jest.fn(async () => 'OK'),
  },
}));

const mockPrisma: any = {
  codingMessage: {
    create: jest.fn(async () => ({ id: 'msg-new' })),
    update: jest.fn(async () => ({})),
    count: jest.fn(async () => 1),
    findMany: jest.fn(async () => []),
  },
  crossModelChat: { findUnique: jest.fn(async () => ({ userId: 'u1' })) },
  agentRun: { update: jest.fn(async () => ({})), updateMany: jest.fn(async () => ({ count: 1 })), count: jest.fn(async () => 0) },
  agentEvent: { create: jest.fn(async () => ({})), aggregate: jest.fn(async () => ({ _max: { seq: 0 } })) },
  codingSchedule: {
    update: jest.fn(async () => ({})),
    findUnique: jest.fn(async (): Promise<any> => ({ enabled: true })),
    count: jest.fn(async (): Promise<number> => 0),
    findMany: jest.fn(async (): Promise<any[]> => []),
  },
  $executeRaw: jest.fn(async () => 1),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockGenerateTitle: jest.Mock = jest.fn(async () => 'Generated Title');
jest.mock('../integrations/moonshot.integration', () => ({
  __esModule: true,
  default: { generateTitle: (...args: any[]) => mockGenerateTitle(...args) },
}));

const mockRunCodingAgent: jest.Mock = jest.fn();
jest.mock('./agent', () => ({ runCodingAgent: (...args: any[]) => mockRunCodingAgent(...args) }));

const mockRecoverStrandedSteers: jest.Mock = jest.fn(async () => false);
jest.mock('./steer-recovery', () => ({
  __esModule: true,
  recoverStrandedSteers: (...a: any[]) => mockRecoverStrandedSteers(a[0]),
}));

const mockReattachWorktree: jest.Mock = jest.fn(async () => '/tmp/wt-reattached');
const mockIsUsableWorktree: jest.Mock = jest.fn(async () => true);
const mockIsWorkspaceVolumeOwner: jest.Mock = jest.fn(async () => true);
const mockEnsureBlankWorktree: jest.Mock = jest.fn(async () => '/tmp/wt-blank-new');
const mockSnapshotWorktreeGitState: jest.Mock = jest.fn(async (): Promise<any> => ({ branch: 'digby/x', wip: 'wipsha1' }));
jest.mock('./workspace.service', () => ({
  reattachWorktree: (...args: any[]) => mockReattachWorktree(...args),
  isUsableWorktree: (...args: any[]) => mockIsUsableWorktree(...args),
  snapshotWorktreeGitState: (...args: any[]) => mockSnapshotWorktreeGitState(...args),
  ensureBlankWorktree: (...args: any[]) => mockEnsureBlankWorktree(...args),
  repoMirrorPath: (id: string) => `/repos/${id}.git`,
  isWorkspaceVolumeOwner: (...args: any[]) => mockIsWorkspaceVolumeOwner(...args),
}));
jest.mock('./scaffolding.service', () => ({ ensureProjectDocs: jest.fn(async () => ({})) }));
jest.mock('../github/token-manager', () => ({ getValidToken: jest.fn(async () => 'tok') }));
jest.mock('fs/promises', () => ({ access: jest.fn(async () => undefined), stat: jest.fn(async () => undefined) }));
const mockEnsureProvisioned: jest.Mock = jest.fn(async () => '/repos/p1.git');
jest.mock('./project-workspace.service', () => ({
  __esModule: true,
  ensureProvisioned: (...a: any[]) => mockEnsureProvisioned(...a),
}));

const mockEmitHookEventSafe: jest.Mock = jest.fn(async () => {});
const mockClearHookDepth: jest.Mock = jest.fn(async () => {});
const mockEmitHookEvent: jest.Mock = jest.fn(async () => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
  clearHookDepth: (...a: any[]) => mockClearHookDepth(...a),
}));

const mockWriteRunJournalEntryAsync: jest.Mock = jest.fn();
const mockWriteGuardVerdictEntryAsync: jest.Mock = jest.fn();
const mockWriteAttemptsExhaustedEntryAsync: jest.Mock = jest.fn();
const mockWriteProbeMissEntryAsync: jest.Mock = jest.fn();
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  writeRunJournalEntryAsync: (...args: any[]) => mockWriteRunJournalEntryAsync(...args),
  writeGuardVerdictEntryAsync: (...args: any[]) => mockWriteGuardVerdictEntryAsync(...args),
  writeAttemptsExhaustedEntryAsync: (...a: any[]) => mockWriteAttemptsExhaustedEntryAsync(...a),
  writeProbeMissEntryAsync: (...a: any[]) => mockWriteProbeMissEntryAsync(...a),
}));

const mockUpdateCodingMemoryAsync: jest.Mock = jest.fn();
jest.mock('./coding-memory.service', () => ({
  __esModule: true,
  updateCodingMemoryAsync: (...a: any[]) => mockUpdateCodingMemoryAsync(...a),
}));

const mockMarkPlanGuardStrike: jest.Mock = jest.fn(async () => {});
const mockClearPlanGuardStrike: jest.Mock = jest.fn(async () => {});
const mockGetPlan: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockGetPlanStrict: jest.Mock = jest.fn(async (): Promise<any> => { throw new Error('store-less suite'); });
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...jest.requireActual('./plan.service'),
  markPlanGuardStrike: (...a: any[]) => mockMarkPlanGuardStrike(...a),
  clearPlanGuardStrike: (...a: any[]) => mockClearPlanGuardStrike(...a),
  getPlan: (...a: any[]) => mockGetPlan(...a),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));

const mockQueueContinuationRun: jest.Mock = jest.fn(async (): Promise<any> => ({ ok: true, runId: 'cont-1' }));
const mockHasQueuedContinuationRun: jest.Mock = jest.fn(async () => false);
const mockCreateScheduleFallback: jest.Mock = jest.fn(async (): Promise<any> => ({ ok: true, schedule: { intervalSec: 900 } }));
jest.mock('./schedule.service', () => ({
  __esModule: true,
  ...jest.requireActual('./schedule.service'),
  queueContinuationRun: (...a: any[]) => mockQueueContinuationRun(...a),
  hasQueuedContinuationRun: (...a: any[]) => mockHasQueuedContinuationRun(...a),
  createSchedule: (...a: any[]) => mockCreateScheduleFallback(...a),
}));

const mockGetRunReceipts: jest.Mock = jest.fn(async () => []);
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => []);
jest.mock('./run-receipts.service', () => ({
  __esModule: true,
  getRunReceipts: (...a: any[]) => mockGetRunReceipts(...a),
  getRecentChatReceipts: (...a: any[]) => mockGetRecentChatReceipts(...a),
  getRunReceiptsStrict: (...a: any[]) => mockGetRunReceipts(...a),
  getRecentChatReceiptsStrict: (...a: any[]) => mockGetRecentChatReceipts(...a),
}));

const mockFileFeedbackTicket: jest.Mock = jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => mockFileFeedbackTicket(...a),
}));

const mockFileStreakInvestigation: jest.Mock = jest.fn(async () => {});
const mockConsumeBreakerLaneNotice: jest.Mock = jest.fn(async () => null);
jest.mock('./reflection', () => ({
  __esModule: true,
  fileStreakInvestigation: (...a: any[]) => mockFileStreakInvestigation(...a),
  consultCrossCheckerOnStreak: jest.fn(async () => null),
  consumeBreakerLaneNotice: (...a: any[]) => mockConsumeBreakerLaneNotice(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss', SCHEDULE_CONTINUATION_SKIP: 'schedule_continuation_skip',
    CONTINUATION_SUPPRESSED: 'continuation_suppressed',
    TRANSIENT_RESUME: 'transient_resume',
    WAKE_DELIVERED: 'wake_delivered', WAKE_CAPPED: 'wake_capped', WAKE_PARKED: 'wake_parked',
    CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits',
    CODING_MEMORY_INJECTED: 'coding_memory_injected',
    DEGENERATE_FINAL: 'degenerate_final',
    BLANK_PROVISION_DEFERRED: 'blank_provision_deferred', BLANK_PROVISION_SELFHEAL: 'blank_provision_selfheal',
    LOCAL_MIRROR_SELFHEAL: 'local_mirror_selfheal',
  },
}));

const mockSearchMemory: jest.Mock = jest.fn(async (): Promise<any[]> => []);
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: (...a: any[]) => mockSearchMemory(...a),
}));

const mockBuildOwnerDirectives: jest.Mock = jest.fn(async (): Promise<any> => ({ block: '', shown: [], hidden: 0 }));
const mockRecordOwnerDirectiveDelivered: jest.Mock = jest.fn();
jest.mock('../platform/owner-directive-fanout', () => ({
  __esModule: true,
  buildOwnerDirectivesInForceBlock: (...a: any[]) => mockBuildOwnerDirectives(...a),
  recordOwnerDirectiveDelivered: (...a: any[]) => mockRecordOwnerDirectiveDelivered(...a),
}));

const mockUpdateContextAsync: jest.Mock = jest.fn();
jest.mock('../langgraph/memory.graph', () => ({
  __esModule: true,
  updateContextAsync: (...a: any[]) => mockUpdateContextAsync(...a),
  getProjectSettings: jest.fn(async () => ({ crossProjectMemory: true })),
}));

const mockApplyCompletionClaimGuard: jest.Mock = jest.fn();
jest.mock('./run-evidence-guard', () => ({
  __esModule: true,
  ...jest.requireActual('./run-evidence-guard'),
  applyCompletionClaimGuard: (...a: any[]) => mockApplyCompletionClaimGuard(...a),
}));

const mockGetSessionForUser: jest.Mock = jest.fn();
const mockUpdateSessionState: jest.Mock = jest.fn(async () => {});
const mockTouchChat: jest.Mock = jest.fn(async () => {});
const mockProjectCodingModel: jest.Mock = jest.fn(async () => null);
const mockResolveOneCodingPick: jest.Mock = jest.fn(async () => null);
const mockAppendCodingMessage: jest.Mock = jest.fn(async () => ({ id: 'msg-new' }));
const mockUpdateCodingMessage: jest.Mock = jest.fn(async () => ({}));
const mockListRecentCodingTranscript: jest.Mock = jest.fn(async () => []);
const mockCountCodingTranscriptMessages: jest.Mock = jest.fn(async () => 1);
const mockGetCodingSessionTitle: jest.Mock = jest.fn(async () => 'A proper existing title');
const mockGetFirstUserCodingMessage: jest.Mock = jest.fn(async () => null);
const mockGetCodingSessionTitleSource: jest.Mock = jest.fn(async () => null);
const mockResolveRoleModelForRun: jest.Mock = jest.fn(async (_role: string, _fallback: string) => 'kimi');
jest.mock('./coding-model', () => ({
  __esModule: true,
  resolveRoleModelForRun: (...args: any[]) => mockResolveRoleModelForRun(...args),
}));
jest.mock('./coding-data.service', () => ({
  __esModule: true,
  getSessionForUser: (...args: any[]) => mockGetSessionForUser(...args),
  updateSessionState: (...args: any[]) => mockUpdateSessionState(...args),
  touchChat: (...args: any[]) => mockTouchChat(...args),
  projectCodingModel: (...args: any[]) => mockProjectCodingModel(...args),
  resolveOneCodingPick: (...args: any[]) => mockResolveOneCodingPick(...args),
  appendCodingMessage: (...args: any[]) => mockAppendCodingMessage(...args),
  updateCodingMessage: (...args: any[]) => mockUpdateCodingMessage(...args),
  listRecentCodingTranscript: (...args: any[]) => mockListRecentCodingTranscript(...args),
  countCodingTranscriptMessages: (...args: any[]) => mockCountCodingTranscriptMessages(...args),
  getCodingSessionTitle: (...args: any[]) => mockGetCodingSessionTitle(...args),
  getFirstUserCodingMessage: (...args: any[]) => mockGetFirstUserCodingMessage(...args),
  getCodingSessionTitleSource: (...args: any[]) => mockGetCodingSessionTitleSource(...args),
  transcriptDualWriteEnabled: () => !process.env.TRANSCRIPT_DUAL_WRITE_OFF_IN_TESTS,
}));

const mockStageAndDescribe: jest.Mock = jest.fn(async () => ({ staged: [], note: '' }));
const mockStageFilesAndDescribe: jest.Mock = jest.fn(async () => ({ staged: [], note: '' }));
jest.mock('./attachments.service', () => ({
  __esModule: true,
  stageAndDescribe: (...a: any[]) => mockStageAndDescribe(...a),
  stageFilesAndDescribe: (...a: any[]) => mockStageFilesAndDescribe(...a),
}));

const mockFiringStartsNewWork: jest.Mock = jest.fn(async (): Promise<any> => ({ newWork: false, todoIds: [] }));
const mockPromoteLaneTodos: jest.Mock = jest.fn(async (): Promise<string[]> => []);
const mockMaybeStartNextLaneTodo: jest.Mock = jest.fn(async (): Promise<string> => 'no_todo');
const mockCloseLaneTodosOnPlanComplete: jest.Mock = jest.fn(async (): Promise<string> => 'no_plan');
jest.mock('./lane-todos', () => ({
  __esModule: true,
  firingStartsNewWork: (...a: any[]) => mockFiringStartsNewWork(...a),
  machineFiringNewWorkDisabled: () => process.env.MACHINE_FIRING_NEW_WORK_DISABLED === '1',
  promoteLaneTodosAtRunStart: (...a: any[]) => mockPromoteLaneTodos(...a),
  maybeStartNextLaneTodo: (...a: any[]) => mockMaybeStartNextLaneTodo(...a),
  closeLaneTodosOnPlanComplete: (...a: any[]) => mockCloseLaneTodosOnPlanComplete(...a),
}));

const mockRunDeliverableHandoffSafe: jest.Mock = jest.fn(async (): Promise<any> => null);
jest.mock('./deliverable-handoff', () => ({
  __esModule: true,
  ...jest.requireActual('./deliverable-handoff'),
  runDeliverableHandoffSafe: (...a: any[]) => mockRunDeliverableHandoffSafe(...a),
}));

const mockUnpushedAtRunEnd: jest.Mock = jest.fn(async (): Promise<any> => ({ line: null, state: null }));
jest.mock('./unpushed-commits', () => ({
  __esModule: true,
  unpushedCommitsAtRunEnd: (...a: any[]) => mockUnpushedAtRunEnd(...a),
}));

import { executeClaimedRun } from './run-executor';
import type { ClaimedRun } from './run-claim';
import * as fs from 'fs';
import * as path from 'path';

// Source-text pins (prompt-hygiene.test.ts precedent): this suite mocks ./agent
// and ../tool-executor transitively, so the guidance surfaces are pinned from
// their SOURCE text, not from the mocked modules.
const agentSrc = fs.readFileSync(path.join(__dirname, 'agent.ts'), 'utf8');
const toolExecutorSrc = fs.readFileSync(path.join(__dirname, '..', 'tool-executor.ts'), 'utf8');

const makeClaim = (over: Partial<ClaimedRun> = {}): ClaimedRun => ({
  id: 'run1',
  sessionId: 's1',
  preStatus: 'queued',
  checkpoint: null,
  input: { message: 'build it', userId: 'u1' },
  attempts: 1,
  inputConsumed: false,
  lastError: null,
  ...over,
});

const SESSION: any = {
  id: 's1', projectId: 'p1', userId: 'u1', title: 't', branch: 'digby/x', baseBranch: 'main',
  worktreePath: '/tmp/wt', permissionMode: 'auto', model: 'kimi', status: 'running',
  errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
  project: {
    id: 'p1', userId: 'u1', name: 'proj', repoUrl: 'https://github.com/o/r', defaultBranch: 'main',
    provider: 'github', githubLabel: null, folderId: null, createdAt: new Date(), updatedAt: new Date(),
  },
};

const planWithUnfinished = {
  goal: 'finish the install and test',
  acceptanceCriteria: [],
  version: 3,
  updatedAt: new Date().toISOString(),
  steps: [
    { id: 1, text: 'done step', status: 'completed' },
    { id: 2, text: 'pending step', status: 'pending' },
    { id: 3, text: 'wip step', status: 'in_progress' },
  ],
};

const planComplete = {
  goal: 'done',
  acceptanceCriteria: [],
  version: 3,
  updatedAt: new Date().toISOString(),
  steps: [{ id: 1, text: 'only step', status: 'completed' }],
};

/** A user-typed claim — the ticket's exact shape (triggerKind 'user', attended). */
const userClaim = (message = 'go ahead and install it now') =>
  makeClaim({ input: { message, userId: 'u1', userTurnAt: new Date().toISOString() } });

/** The finalize's assistant-transcript write — where the harness note lands. */
const assistantFinal = () => {
  const calls = mockAppendCodingMessage.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.role === 'assistant');
  return calls[calls.length - 1]?.content ?? '';
};

const OK_AGENT_RESULT = { finalText: 'Honest status: budget exhausted mid-download — I will drive the install next turn.', parts: [] };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPlan.mockResolvedValue(planWithUnfinished);
  mockPrisma.codingSchedule.count.mockResolvedValue(0);
  mockRunCodingAgent.mockResolvedValue({ ...OK_AGENT_RESULT });
  mockGetSessionForUser.mockResolvedValue(SESSION);
});

describe('ticket c2ee04a1 — user-attended run finalizing with pending plan steps (the silent-stall incident class)', () => {
  it('the incident shape: a user-typed run with unfinished steps gets the honest note and the idle warning (NOT silence, and NO auto-queue)', async () => {
    await executeClaimedRun(userClaim());
    const final = assistantFinal();
    expect(final).toContain('this run ended with 2 unfinished plan step(s)');
    expect(final).toContain('- [pending] #2 pending step');
    expect(final).toContain('- [in_progress] #3 wip step');
    // The one question the owner asked the incident lane: is anything scheduled?
    expect(final).toContain('Nothing is scheduled to continue this');
    // Human-in-the-loop doctrine: the executor queues NOTHING for a user run.
    expect(mockQueueContinuationRun).not.toHaveBeenCalled();
    expect(mockCreateScheduleFallback).not.toHaveBeenCalled();
  });

  it('when the session HAS an enabled schedule, the note acknowledges it instead of warning idle', async () => {
    mockPrisma.codingSchedule.count.mockResolvedValueOnce(1);
    await executeClaimedRun(userClaim());
    const final = assistantFinal();
    expect(final).toContain('this run ended with 2 unfinished plan step(s)');
    expect(final).toContain('1 enabled schedule on this session can resume the remaining steps.');
    expect(final).not.toContain('Nothing is scheduled to continue this');
  });

  it('a user run with a COMPLETE plan board gets NO note (the note is unfinished-gated, not user-gated)', async () => {
    mockGetPlan.mockResolvedValueOnce(planComplete);
    await executeClaimedRun(userClaim());
    const final = assistantFinal();
    expect(final).not.toContain('unfinished plan step');
  });

  it('an UNATTENDED (machine) run with the same board keeps the EXISTING backstop path — no user-note double-write', async () => {
    await executeClaimedRun(makeClaim({ input: { message: 'do the nightly work', userId: 'u1', origin: 'schedule' } }));
    const final = assistantFinal();
    expect(final).toContain('this run ended with 2 unfinished plan step(s)');
    // The unattended lane queues a continuation (its existing pinned contract).
    expect(mockQueueContinuationRun).toHaveBeenCalledTimes(1);
    // The user-attended note's schedule-acknowledgment line must NOT also appear.
    expect(final).not.toContain('Nothing is scheduled to continue this');
    expect(final).not.toContain('enabled schedule on this session');
  });

  it('fail-open: a plan-read error means NO note (never a broken finalize)', async () => {
    mockGetPlan.mockRejectedValueOnce(new Error('store down'));
    await executeClaimedRun(userClaim());
    const final = assistantFinal();
    expect(final).not.toContain('unfinished plan step');
  });
});

describe('ticket c2ee04a1 — agent-side guidance (the surfaces the next run reads)', () => {
  it('AUTO_WORKFLOW_DOCTRINE carries the budget-safety-net rule: arm ONE one-shot before long blocking work, a promised next turn is a stall, cancel when it lands', () => {
    const d = agentSrc;
    expect(d).toContain('BUDGET SAFETY NET');
    expect(d).toContain('one-shot schedule_self');
    expect(d).toContain('nothing wakes the session unless YOU arm it');
    expect(d).toContain('Cancel the one-shot');
    expect(d).toContain('never stack a second net');
  });

  it('the computer_task tool description warns that long device sequences can eat the budget and names the one-shot safety net', () => {
    const m = /name: 'computer_task',[\s\S]*?description: '([\s\S]*?)',\n/.exec(toolExecutorSrc);
    const d = (m?.[1] ?? '').replace(/\\(['"])/g, '$1'); // unescape TS \' and \" to plain quotes
    expect(d).toContain('Long device work (multi-GB installs) can eat the whole step budget');
    expect(d).toContain('arm a one-shot schedule_self first');
    expect(d).toContain('cancel it once the work lands');
  });
});
