/**
 * Replay pin — ticket dae56e70 (2026-09-10 phantom busy-claim incident).
 *
 * Incident: session 0afa0737-88a4-4f9c-a3ae-2f125bdd08b1 (chatCodingState
 * status 'archived') was un-sendable for 8+ hours: every send_chat_message
 * 409'd "A run is already in progress for this chat…" and schedule 9da6ae0d's
 * firings skipped busy, while get_chat_status truthfully reported
 * running:false (isChatBusy reads registry + Redis liverun + agent_runs — all
 * empty). Root cause: queueAgentRun's ready-gate (run-state.ts) can never
 * match an 'archived' row, and healUnrunnableSession only covered
 * 'error'/'provisioning' — an archived satellite was a bricked lane that
 * looked exactly like a busy one, and no agent tool could clear it.
 *
 * Fix: healUnrunnableSession now also heals 'archived' — the established
 * unarchive semantic (updateSession unarchive always lands on 'ready'; the
 * executor re-provisions a reaped worktree on demand) applied to the
 * machine-dispatch path, behind the same fail-closed orphan guard (no FRESH
 * claimable agent_runs row, no live session run lock).
 *
 * Mock boundary mirrors coding-stream.controller.test.ts (colocated
 * mock-everything pattern); only the startScheduledRun surface is exercised.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  chatCodingState: { updateMany: jest.fn() },
  crossModelChat: { findUnique: jest.fn(), updateMany: jest.fn() },
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
// ARCHIVED-TARGET-RETIRE (2026-10-20): a user-turn heal re-arms the schedules the archive paused.
const mockResumeSchedulesForRestoredChat: jest.Mock = jest.fn(async () => 0);
jest.mock('./schedule.service', () => ({
  __esModule: true,
  consumeCapSkipNotice: (...a: any[]) => mockConsumeCapSkip(...a),
  restoreCapSkipNotice: (...a: any[]) => mockRestoreCapSkip(...a),
  resumeSchedulesForRestoredChat: (...a: any[]) => mockResumeSchedulesForRestoredChat(...a),
}));

const mockConsumeSpendSkip: jest.Mock = jest.fn(async () => 0);
const mockRestoreSpendSkip: jest.Mock = jest.fn(async () => {});
jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  consumeSpendCapSkipNotice: (...a: any[]) => mockConsumeSpendSkip(...a),
  restoreSpendCapSkipNotice: (...a: any[]) => mockRestoreSpendSkip(...a),
}));

const mockLoadAttachment: jest.Mock = jest.fn(async () => null);
// audit 2026-10-08 W3-5: a user-turn heal re-arms the hooks the archive paused (the real module pulls config/redis → env).
const mockResumeHooksForRestoredChat: jest.Mock = jest.fn(async () => 0);
jest.mock('../platform/hooks.service', () => ({ resumeHooksForRestoredChat: (...a: any[]) => mockResumeHooksForRestoredChat(...a) }));
jest.mock('../upload.controller', () => ({
  loadAttachment: (...a: any[]) => mockLoadAttachment(...a),
}));
// Archive cascade review fixer (2026-10-21): a user-turn heal of a STAMPED chat restores through archiveChat
// (the real platform.service pulls config/redis → env).
const mockArchiveChat: jest.Mock = jest.fn(async () => ({ id: 's1', archived: false }));
jest.mock('../platform/platform.service', () => ({ archiveChat: (...a: any[]) => mockArchiveChat(...a) }));
// Lane lifecycle second review fixer (2026-10-21): a direct-clear heal remembers the restore.
const mockRememberLaneRestore: jest.Mock = jest.fn(async () => {});
jest.mock('../platform/lane-family-facts', () => ({ __esModule: true, ...jest.requireActual('../platform/lane-family-facts'), rememberLaneRestore: (...a: any[]) => mockRememberLaneRestore(...a) }));

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

import { startScheduledRun } from './coding-stream.controller';
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
  mockPrisma.agentRun.findFirst.mockResolvedValue(null); // no claimable row by default
  mockQueueAgentRun.mockResolvedValue('run-new');
  mockGetActiveRun.mockResolvedValue(null);
  mockGetLatestRun.mockResolvedValue(null);
  mockGetEventsAfter.mockResolvedValue([]);
  mockIsLocked.mockResolvedValue(false);
  mockConsumeCapSkip.mockResolvedValue(0);
  mockRestoreCapSkip.mockResolvedValue(undefined);
  mockGetApprovalPending.mockResolvedValue(null);
  mockGetQuestionPending.mockResolvedValue(null);
  mockLoadDurable.mockResolvedValue(null);
  mockCurrentIdForFp.mockResolvedValue(null);
  mockLoadAttachment.mockResolvedValue(null);
});

describe('dae56e70 — archived-session machine-dispatch heal', () => {
  it('REPLAY (user turn): an ARCHIVED session reads busy to the ready-gate, self-heals to ready, and the retry queues', async () => {
    // The incident shape verbatim: gate throws SessionBusyError (0 rows match
    // status='ready' for an 'archived' row); before the fix this returned
    // { started:false, reason:'busy' } on every dispatch, forever. Since
    // autonomy loop #13 the heal is the RESTORE semantic — a real user turn.
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'archived' });
    mockQueueAgentRun.mockRejectedValueOnce(new SessionBusyError()).mockResolvedValueOnce('run-new');
    expect(await startScheduledRun('s1', 'tick', { userTurnAt: new Date(), origin: 'user' })).toEqual({ started: true });
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(2); // busy → heal → retry
    await new Promise((r) => setImmediate(r));
    expect(mockResumeHooksForRestoredChat).toHaveBeenCalledWith('s1'); // audit 2026-10-08 W3-5
    expect(mockResumeSchedulesForRestoredChat).toHaveBeenCalledWith('s1'); // archived-target-retire 2026-10-20
  });

  it('autonomy loop #13: a MACHINE dispatch (schedule / hook / agent / heuristic default) into an ARCHIVED session is REFUSED with the distinct reason "archived" — no heal, no un-archive, never "busy"', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'archived' });
    for (const opts of [undefined, { origin: 'schedule' as const, scheduleId: 'sch1' }, { origin: 'hook' as const }, { origin: 'agent' as const, originSourceChatId: 'sup-1' }]) {
      jest.clearAllMocks();
      mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
      expect(await startScheduledRun('s1', 'tick', opts as any)).toEqual({ started: false, reason: 'archived' });
      expect(mockUpdateSessionState).not.toHaveBeenCalled();
      expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
      expect(mockQueueAgentRun).toHaveBeenCalledTimes(1); // no retry
      expect(mockResumeSchedulesForRestoredChat).not.toHaveBeenCalled(); // a refused machine dispatch restores nothing
    }
  });

  it('an archived session with a FRESH claimable row is NOT flipped (fail-closed: a live worker owns it)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'archived' });
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'r-live' }); // fresh claimable row
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1); // no retry
  });

  it('an archived session with a live session run lock is NOT flipped (fail-closed)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'archived' });
    mockIsLocked.mockResolvedValue(true);
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });

  it('a runnable-state session (ready) is NEVER flipped by the heal — the widened condition reaches only unrunnable states', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'ready' });
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it('a RUNNING session is NEVER flipped by the heal (stopRun/the orphan reaper own that state)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'running' });
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
  });
});

describe('90d71ae7 — the heal completes the unarchive (chat archive stamp)', () => {
  it('REPLAY: the archived heal clears crossModelChat.archivedAt too — a satellite-only flip hid the chat from list_chats while its runs resumed', async () => {
    // The 90d71ae7 wedge verbatim: archive_chat parked BOTH halves (satellite
    // 'archived' + chat archivedAt); the dae56e70 heal flipped ONLY the
    // satellite at 15:12Z, so the chat ran again (get_chat_status fine) yet
    // list_chats (default view: archivedAt null) filtered it out — the exact
    // omission the ticket reports. The unarchive semantic is now COMPLETE.
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'archived' });
    mockQueueAgentRun.mockRejectedValueOnce(new SessionBusyError()).mockResolvedValueOnce('run-new');
    expect(await startScheduledRun('s1', 'tick', { userTurnAt: new Date(), origin: 'user' })).toEqual({ started: true });
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockPrisma.crossModelChat.updateMany).toHaveBeenCalledWith({ where: { id: 's1' }, data: { archivedAt: null } });
  });

  it('the fail-closed guards NEVER clear the chat stamp — no heal happened at all', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'archived' });
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'r-live' }); // fresh claimable row
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
  });

  it('the error/provisioning heals do NOT touch the chat archive stamp (those branches never parked the chat)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'error' });
    mockQueueAgentRun.mockRejectedValueOnce(new SessionBusyError()).mockResolvedValueOnce('run-new');
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: true });
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
  });
});

describe('archive cascade review fixer (2026-10-21) — the user-turn heal restores a STAMPED chat through archiveChat', () => {
  afterEach(() => { delete process.env.ARCHIVE_CASCADE_DISABLED; });

  it('REPLAY: the heal of an archived parent goes through archiveChat (its cascade restore brings the children back) — no direct clear, no duplicate re-arm', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'archived' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', archivedAt: new Date('2026-10-21T10:00:00Z') });
    mockQueueAgentRun.mockRejectedValueOnce(new SessionBusyError()).mockResolvedValueOnce('run-new');
    expect(await startScheduledRun('s1', 'tick', { userTurnAt: new Date(), origin: 'user' })).toEqual({ started: true });
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'u1', chatId: 's1', archived: false, source: 'dispatch_heal' });
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(mockResumeHooksForRestoredChat).not.toHaveBeenCalled();
    expect(mockResumeSchedulesForRestoredChat).not.toHaveBeenCalled();
    // archiveChat's own restore leg writes the marker — the heal adds none
    expect(mockRememberLaneRestore).not.toHaveBeenCalled();
  });

  it('a refused archiveChat, or ARCHIVE_CASCADE_DISABLED=1, keeps the direct clear', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'archived' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', archivedAt: new Date() });
    mockArchiveChat.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 400 }));
    mockQueueAgentRun.mockRejectedValueOnce(new SessionBusyError()).mockResolvedValueOnce('run-new');
    expect(await startScheduledRun('s1', 'tick', { userTurnAt: new Date(), origin: 'user' })).toEqual({ started: true });
    expect(mockPrisma.crossModelChat.updateMany).toHaveBeenCalledWith({ where: { id: 's1' }, data: { archivedAt: null } });
    // REPRO (second review, finding 11): the direct clear is a restore too — remembered for lane-retire
    await new Promise((r) => setImmediate(r));
    expect(mockRememberLaneRestore).toHaveBeenCalledWith('s1', { source: 'dispatch_heal' });

    jest.clearAllMocks();
    process.env.ARCHIVE_CASCADE_DISABLED = '1';
    mockPrisma.crossModelChat.updateMany.mockResolvedValue({ count: 1 });
    mockQueueAgentRun.mockRejectedValueOnce(new SessionBusyError()).mockResolvedValueOnce('run-new');
    expect(await startScheduledRun('s1', 'tick', { userTurnAt: new Date(), origin: 'user' })).toEqual({ started: true });
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalledWith(expect.objectContaining({ select: { archivedAt: true, userId: true } }));
    expect(mockPrisma.crossModelChat.updateMany).toHaveBeenCalledWith({ where: { id: 's1' }, data: { archivedAt: null } });
    await new Promise((r) => setImmediate(r));
    expect(mockRememberLaneRestore).toHaveBeenCalledWith('s1', { source: 'dispatch_heal' });
  });
});
