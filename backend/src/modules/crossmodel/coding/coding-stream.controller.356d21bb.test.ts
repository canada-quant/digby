/**
 * Ticket 356d21bb replay pins — the coding STEER lane (Gap C): a coding run
 * parked in awaitAnswer never reaches the steer drain's step boundary, so an
 * inbound message while a question card is live must be published on the
 * RESOLUTION mailbox (drained by the parked run's cancelPoll within ~2s) —
 * not RPUSHed to the steer mailbox.
 *
 *   1. active run + live question card → publishQuestionResolution with the
 *      text (durable 'answered' stamped FIRST — before any 'expired' write),
 *      the owner's text persisted as a user row, NO steer push, and the
 *      flagged owner-question rows closed (resolveOwnerQuestionsForChatAnswer).
 *   2. active run, NO live card → the legacy steer push stands.
 *   3. no active run → steered:false (the existing contract).
 *
 * The message-as-answer helper is REAL here — its dynamic imports land on the
 * same mocked boundaries (confirm-pending, session-run-lock, pending-durable,
 * platform/owner-questions), so this pins the whole steer-lane composition.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  chatCodingState: { updateMany: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  agentRun: { findUnique: jest.fn(), findFirst: jest.fn() },
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
const mockResolveOwnerQuestions: jest.Mock = jest.fn(async () => ({ resolved: 1, ids: ['oq_1'] }));
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
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

import controller, { steerActiveRun } from './coding-stream.controller';

const SESSION: any = {
  id: 's1', projectId: 'p1', userId: 'u1', title: 't', branch: 'digby/x', baseBranch: 'main',
  worktreePath: '/tmp/wt', permissionMode: 'auto', model: 'glm-5.2', status: 'running',
  errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
  project: { id: 'p1', userId: 'u1', name: 'proj' },
};

const liveCard = new Map([
  ['s1', { kind: 'question' as const, id: 'q-1', question: 'Which model should I use?', options: [], ts: Date.now() }],
]);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSessionForUser.mockResolvedValue(SESSION);
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1' });
  mockGetActiveRun.mockResolvedValue({ id: 'run-1', sessionId: 's1', status: 'running' });
  mockReadConfirmPending.mockResolvedValue(new Map());
  mockResolveOwnerQuestions.mockResolvedValue({ resolved: 1, ids: ['oq_1'] });
});

describe('356d21bb — coding steer with a LIVE question card (Gap C)', () => {
  it("publishes the text on the RESOLUTION mailbox (durable 'answered' first), persists the user row, never steer-pushes", async () => {
    mockReadConfirmPending.mockResolvedValue(liveCard);
    const out = await steerActiveRun('s1', 'use glm-5.3');

    expect(out).toEqual({ steered: true, reason: 'answered_question' });
    // Durable 'answered' stamped BEFORE the mailbox publish — first-writer-
    // wins means no later cancel/timeout can rewrite it as 'expired'.
    expect(mockMarkDurable).toHaveBeenCalledWith('question', 'q-1', 'answered', 'use glm-5.3');
    expect(mockMarkDurable.mock.invocationCallOrder[0]).toBeLessThan(mockPublishQuestionRes.mock.invocationCallOrder[0]);
    expect(mockPublishQuestionRes).toHaveBeenCalledWith('s1', 'q-1', 'use glm-5.3');
    // NO steer push — a parked run never reaches the steer drain.
    expect(mockPushSteer).not.toHaveBeenCalled();
    // The owner's text still lands in the transcript as a user row.
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 's1', role: 'user', content: 'use glm-5.3' }),
    );
    // Flag rows for the same decision close (the 992c8374 coherence seam).
    expect(mockResolveOwnerQuestions).toHaveBeenCalledWith({
      chatId: 's1', userId: 'u1', askedQuestion: 'Which model should I use?', answer: 'use glm-5.3',
    });
  });

  it('the HTTP POST /steer endpoint takes the same path (success, no steer push)', async () => {
    mockReadConfirmPending.mockResolvedValue(liveCard);
    const req: any = { params: { id: 's1' }, body: { message: 'use glm-5.3' }, user: { id: 'u1' } };
    const res: any = {
      statusCode: 200, body: undefined,
      status: jest.fn(function (this: any, c: number) { this.statusCode = c; return this; }),
      json: jest.fn(function (this: any, b: any) { this.body = b; return this; }),
    };
    await controller.steerRun(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { steered: true } });
    expect(mockPublishQuestionRes).toHaveBeenCalledWith('s1', 'q-1', 'use glm-5.3');
    expect(mockPushSteer).not.toHaveBeenCalled();
  });
});

describe('356d21bb — steer fallbacks preserved', () => {
  it('active run with NO live card → the legacy steer push stands', async () => {
    const out = await steerActiveRun('s1', 'also handle the retry storm');
    expect(out).toEqual({ steered: true });
    expect(mockPushSteer).toHaveBeenCalledWith('s1', expect.objectContaining({ text: 'also handle the retry storm' }));
    expect(mockPublishQuestionRes).not.toHaveBeenCalled();
    expect(mockMarkDurable).not.toHaveBeenCalled();
    expect(mockResolveOwnerQuestions).not.toHaveBeenCalled();
  });

  it('an APPROVAL card is NOT a question — the steer push stands', async () => {
    mockReadConfirmPending.mockResolvedValue(new Map([
      ['s1', { kind: 'approval' as const, id: 'ap-1', question: 'Allow run_command?', options: ['allow', 'deny'], tool: 'run_command', ts: Date.now() }],
    ]));
    const out = await steerActiveRun('s1', 'allow it');
    expect(out).toEqual({ steered: true });
    expect(mockPushSteer).toHaveBeenCalled();
    expect(mockPublishQuestionRes).not.toHaveBeenCalled();
  });

  it('no active run → steered:false (the fresh-run fallback contract)', async () => {
    mockGetActiveRun.mockResolvedValue(null);
    const out = await steerActiveRun('s1', 'use glm-5.3');
    expect(out).toEqual({ steered: false, reason: 'no_active_run' });
    expect(mockPushSteer).not.toHaveBeenCalled();
    expect(mockPublishQuestionRes).not.toHaveBeenCalled();
  });
});
