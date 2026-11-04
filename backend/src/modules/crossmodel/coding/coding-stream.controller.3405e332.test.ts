/**
 * Replay pin — ticket 3405e332 (2026-09-17 one-shot schedule drift incident).
 *
 * Incident: one-shot schedules on busy lanes drifted HOURS past their intended
 * fire time (Fleet Supervisor schedules 7a7deedb ~7h and 0283acd6 ~3h, both
 * runs 0/1 "last skipped:busy") because a busy fire only re-armed nextRunAt by
 * 3 minutes forever — a continuously-busy session never let the one-shot start.
 *
 * Fix (this file pins the startScheduledRun layer): with queueBehindBusy:true
 * (passed by fireScheduleTarget for kind:'once' firings only), a genuinely busy
 * session queues the run as a queued agent_runs row BEHIND the active run
 * (riding the leaseExpiresAt NOT-BEFORE channel like queueContinuationRun)
 * instead of returning 'busy'. The queued row carries the SAME built input
 * (machine-provenance header + scheduleId), so the executor's claim-time
 * stale-firing guard still enforces cancel-wins. Without the flag — or with a
 * waiting queued row, or on an insert error — the busy skip is unchanged.
 *
 * Mock boundary mirrors coding-stream.controller.dae56e70.test.ts (colocated
 * mock-everything pattern); only the startScheduledRun surface is exercised.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  chatCodingState: { updateMany: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), updateMany: jest.fn() },
  agentRun: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  codingMessage: { create: jest.fn(async () => ({ id: 'msg1' })) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockQueueAgentRun: jest.Mock = jest.fn();
const mockGetActiveRun: jest.Mock = jest.fn();
const mockGetLatestRun: jest.Mock = jest.fn();
const mockGetEventsAfter: jest.Mock = jest.fn();
jest.mock('./run-state', () => ({
  queueAgentRun: (...a: any[]) => mockQueueAgentRun(...a),
  getActiveRunForSession: (...a: any[]) => mockGetActiveRun(...a),
  getLatestRunForSession: (...a: any[]) => mockGetLatestRun(...a),
  getAgentEventsAfter: (...a: any[]) => mockGetEventsAfter(...a),
  // Mirrors the real tagged error (run-state.ts) the busy-gate throws in-txn.
  SessionBusyError: class SessionBusyError extends Error {
    readonly code = 'BUSY';
    constructor() { super('busy'); this.name = 'SessionBusyError'; }
  },
}));

const mockGetSessionForUser: jest.Mock = jest.fn();
const mockUpdateSessionState: jest.Mock = jest.fn(async () => {});
const mockEnsureChatWorkspaceState: jest.Mock = jest.fn(async () => null);
const mockAppendCodingMessage: jest.Mock = jest.fn(async () => ({ id: 'msg1' }));
jest.mock('./coding-data.service', () => ({
  getSessionForUser: (...a: any[]) => mockGetSessionForUser(...a),
  updateSessionState: (...a: any[]) => mockUpdateSessionState(...a),
  ensureChatWorkspaceState: (...a: any[]) => mockEnsureChatWorkspaceState(...a),
  appendCodingMessage: (...a: any[]) => mockAppendCodingMessage(...a),
  // Mirror of the REAL constant in ./coding-data.service — keep in sync.
  CLAIMABLE_ROW_FRESH_MS: 15 * 60 * 1000,
}));

const mockIsLocked: jest.Mock = jest.fn(async () => false);
const mockRequestCancel: jest.Mock = jest.fn(async () => {});
const mockPushSteer: jest.Mock = jest.fn(async () => {});
const mockGetApprovalPending: jest.Mock = jest.fn(async () => null);
const mockPublishApprovalRes: jest.Mock = jest.fn(async () => {});
const mockGetQuestionPending: jest.Mock = jest.fn(async () => null);
const mockPublishQuestionRes: jest.Mock = jest.fn(async () => {});
jest.mock('./session-run-lock', () => ({
  isSessionRunLocked: (...a: any[]) => mockIsLocked(...a),
  requestRunCancel: (...a: any[]) => mockRequestCancel(...a),
  pushSteerMessage: (...a: any[]) => mockPushSteer(...a),
  getApprovalPendingSession: (...a: any[]) => mockGetApprovalPending(...a),
  publishApprovalResolution: (...a: any[]) => mockPublishApprovalRes(...a),
  getQuestionPendingSession: (...a: any[]) => mockGetQuestionPending(...a),
  publishQuestionResolution: (...a: any[]) => mockPublishQuestionRes(...a),
}));

const mockLoadDurable: jest.Mock = jest.fn(async () => null);
const mockMarkDurable: jest.Mock = jest.fn(async () => {});
const mockCurrentIdForFp: jest.Mock = jest.fn(async () => null);
jest.mock('./pending-durable', () => ({
  loadDurablePending: (...a: any[]) => mockLoadDurable(...a),
  markDurableResolved: (...a: any[]) => mockMarkDurable(...a),
  currentIdForFingerprint: (...a: any[]) => mockCurrentIdForFp(...a),
}));

const mockReadConfirmPending: jest.Mock = jest.fn(async () => new Map());
jest.mock('../confirm-pending', () => ({
  readConfirmPendingForChats: (...a: any[]) => mockReadConfirmPending(...a),
}));
const mockResolveOwnerQuestions: jest.Mock = jest.fn(async () => ({ resolved: 0, ids: [] }));
jest.mock('../platform/owner-questions', () => ({
  resolveOwnerQuestionsForChatAnswer: (...a: any[]) => mockResolveOwnerQuestions(...a),
}));

const mockConsumeCapSkip: jest.Mock = jest.fn(async () => 0);
const mockRestoreCapSkip: jest.Mock = jest.fn(async () => {});
jest.mock('./schedule.service', () => ({
  __esModule: true,
  consumeCapSkipNotice: (...a: any[]) => mockConsumeCapSkip(...a),
  restoreCapSkipNotice: (...a: any[]) => mockRestoreCapSkip(...a),
}));

const mockConsumeSpendSkip: jest.Mock = jest.fn(async () => 0);
const mockRestoreSpendSkip: jest.Mock = jest.fn(async () => {});
jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  consumeSpendCapSkipNotice: (...a: any[]) => mockConsumeSpendSkip(...a),
  restoreSpendCapSkipNotice: (...a: any[]) => mockRestoreSpendSkip(...a),
}));

const mockLoadAttachment: jest.Mock = jest.fn(async () => null);
jest.mock('../upload.controller', () => ({
  loadAttachment: (...a: any[]) => mockLoadAttachment(...a),
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

import { startScheduledRun, QUEUE_BEHIND_BUSY_DELAY_MS } from './coding-stream.controller';
import { SessionBusyError } from './run-state'; // the MOCKED class — instanceof-compatible with the controller's check

const SESSION: any = {
  id: 's1', projectId: 'p1', userId: 'u1', title: 't', branch: 'digby/x', baseBranch: 'main',
  worktreePath: '/tmp/wt', permissionMode: 'auto', model: 'glm-5.3', status: 'ready',
  errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
  project: {
    id: 'p1', userId: 'u1', name: 'proj', repoUrl: 'https://github.com/o/r', defaultBranch: 'main',
    provider: 'github', githubLabel: null, folderId: null, createdAt: new Date(), updatedAt: new Date(),
  },
};

beforeEach(() => {
  jest.clearAllMocks(); // clears CALLS only — every default implementation is re-set below
  mockGetSessionForUser.mockResolvedValue(SESSION);
  mockPrisma.chatCodingState.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1' });
  mockPrisma.crossModelChat.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.agentRun.findUnique.mockResolvedValue({ status: 'running' });
  mockPrisma.agentRun.findFirst.mockResolvedValue(null); // no waiting queued row by default
  mockPrisma.agentRun.create.mockResolvedValue({ id: 'run-q1' });
  mockQueueAgentRun.mockResolvedValue('run-new');
  mockGetActiveRun.mockResolvedValue(null);
  mockGetLatestRun.mockResolvedValue(null);
  mockGetEventsAfter.mockResolvedValue([]);
  mockIsLocked.mockResolvedValue(false);
  mockConsumeCapSkip.mockResolvedValue(0);
  mockRestoreCapSkip.mockResolvedValue(undefined);
  mockConsumeSpendSkip.mockResolvedValue(0);
  mockRestoreSpendSkip.mockResolvedValue(undefined);
  mockGetApprovalPending.mockResolvedValue(null);
  mockGetQuestionPending.mockResolvedValue(null);
  mockLoadDurable.mockResolvedValue(null);
  mockCurrentIdForFp.mockResolvedValue(null);
  mockLoadAttachment.mockResolvedValue(null);
});

describe('3405e332 — queue-behind-busy for one-shot schedule firings', () => {
  it('REPLAY: a busy ONE-SHOT firing queues an agent_runs row BEHIND the active run instead of skipping', async () => {
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError()); // genuinely busy (the ready-gate refuses)
    const res = await startScheduledRun('s1', 'check back on the provider outage', { origin: 'schedule', scheduleId: 'sch_1', queueBehindBusy: true });
    expect(res).toEqual({ started: true, queued: true, runId: 'run-q1' });
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1); // no heal retry for a 'ready' session
    expect(mockUpdateSessionState).not.toHaveBeenCalled(); // and no heal flip
    expect(mockPrisma.agentRun.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.agentRun.create.mock.calls[0][0].data;
    expect(data.sessionId).toBe('s1');
    expect(data.status).toBe('queued');
    expect(data.input.scheduleId).toBe('sch_1'); // feeds the claim-time stale-firing guard + provider-fail counter
    expect(data.input.origin).toBe('schedule');
    expect(data.input.message).toContain('[MACHINE-TRIGGERED RUN'); // provenance header intact
    expect(data.input.message).toContain('check back on the provider outage');
    // NOT-BEFORE rides leaseExpiresAt (~45s), the channel run-claim already honors.
    expect(data.leaseExpiresAt.getTime() - Date.now()).toBeGreaterThan(QUEUE_BEHIND_BUSY_DELAY_MS - 5_000);
    expect(data.leaseExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(QUEUE_BEHIND_BUSY_DELAY_MS + 1_000);
  });

  it('a waiting queued row keeps the busy skip (a continuation / colliding firing owns the slot)', async () => {
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'r-waiting' });
    const res = await startScheduledRun('s1', 'tick', { origin: 'schedule', scheduleId: 'sch_1', queueBehindBusy: true });
    expect(res).toEqual({ started: false, reason: 'busy' });
    expect(mockPrisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('without queueBehindBusy a busy firing skips exactly as before (the recurring path is unchanged)', async () => {
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    const res = await startScheduledRun('s1', 'tick', { origin: 'schedule', scheduleId: 'sch_r' });
    expect(res).toEqual({ started: false, reason: 'busy' });
    expect(mockPrisma.agentRun.findFirst).not.toHaveBeenCalled(); // the queue gate never runs
    expect(mockPrisma.agentRun.create).not.toHaveBeenCalled();
  });

  it('an insert error falls back to the busy skip (never throws past the sweeper)', async () => {
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    mockPrisma.agentRun.create.mockRejectedValue(new Error('db blip'));
    const res = await startScheduledRun('s1', 'tick', { origin: 'schedule', scheduleId: 'sch_1', queueBehindBusy: true });
    expect(res).toEqual({ started: false, reason: 'busy' });
  });

  it('consumed cap/spend-skip notices ride the QUEUED input (never restored on a successful queue)', async () => {
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    mockConsumeCapSkip.mockResolvedValue(3);
    mockConsumeSpendSkip.mockResolvedValue(2);
    const res = await startScheduledRun('s1', 'tick', { origin: 'schedule', scheduleId: 'sch_1', queueBehindBusy: true });
    expect(res).toEqual({ started: true, queued: true, runId: 'run-q1' });
    const input = mockPrisma.agentRun.create.mock.calls[0][0].data.input;
    expect(input.capSkippedNotice).toBe(3);
    expect(input.spendCapSkippedNotice).toBe(2);
    expect(mockRestoreCapSkip).not.toHaveBeenCalled();
    expect(mockRestoreSpendSkip).not.toHaveBeenCalled();
  });
});
