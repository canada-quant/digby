/**
 * Replay pin — ticket 90d71ae7 (2026-09-10 list_chats visibility wedge), the
 * SESSION-API door. Root cause (shared with the machine-dispatch heal, pinned
 * in coding-stream.controller.dae56e70.test.ts): archive_chat parks BOTH the
 * chatCodingState satellite ('archived') AND crossModelChat.archivedAt, and
 * listChats' default view excludes stamped rows — so any unarchive path that
 * flips ONLY the satellite leaves a running chat invisible to list_chats
 * (both q-search and the unfiltered listing) while get_chat_status reads it
 * fine. This pins the REST updateSession branch: unarchiving an archived
 * satellite ALSO clears the chat stamp. The archive direction used to NOT
 * stamp the chat (satellite-archived sessions kept their list visibility);
 * since lane lifecycle C3 (2026-10-21) it stamps it through archiveChat
 * (source 'session_api') — SESSION_API_ARCHIVE_STAMP_DISABLED=1 restores the
 * satellite-only archive, pinned below under the switch.
 *
 * Mock boundary: colocated mock-everything pattern (same style as
 * coding-stream.controller.dae56e70.test.ts) — only updateSession is
 * exercised; schedule.service/context-store are mocked because their import
 * chains reach config/redis → config/env (process.exit in a keyless env).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  // findUnique: the unarchive's chat-row read (review fixer 2026-10-21) — null = an unstamped row (the satellite-only archive).
  crossModelChat: { updateMany: jest.fn(async () => ({ count: 1 })), findUnique: jest.fn(async (): Promise<any> => null) },
  activity: { create: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// Lane lifecycle C3 (2026-10-21): the session-API archive stamps archivedAt through archiveChat.
const mockArchiveChat: jest.Mock = jest.fn(async () => ({ id: 's1', archived: true }));
jest.mock('../platform/platform.service', () => ({ archiveChat: (...a: any[]) => mockArchiveChat(...a) }));
// Lane lifecycle second review fixer (2026-10-21): a direct-clear unarchive remembers the restore.
const mockRememberLaneRestore: jest.Mock = jest.fn(async () => {});
jest.mock('../platform/lane-family-facts', () => ({ __esModule: true, ...jest.requireActual('../platform/lane-family-facts'), rememberLaneRestore: (...a: any[]) => mockRememberLaneRestore(...a) }));
jest.mock('../github/token-manager', () => ({ getAllValidTokens: jest.fn(), getValidToken: jest.fn() }));
jest.mock('./workspace.service', () => ({
  removeWorktree: jest.fn(), removeSessionEnv: jest.fn(), git: jest.fn(), worktreePath: jest.fn(),
}));
jest.mock('./plan.service', () => ({ getPlan: jest.fn(), applyPlan: jest.fn(), planToUpdate: jest.fn() }));
jest.mock('./project-workspace.service', () => ({ commitKnowledgeFile: jest.fn() }));

const mockGetSessionForUser: jest.Mock = jest.fn();
const mockUpdateSessionState: jest.Mock = jest.fn(async () => {});
jest.mock('./coding-data.service', () => ({
  getSessionForUser: (...a: any[]) => mockGetSessionForUser(...a),
  updateSessionState: (...a: any[]) => mockUpdateSessionState(...a),
  listCodingProjects: jest.fn(), createCodingProject: jest.fn(), getCodingProjectForUser: jest.fn(),
  deleteCodingProjectData: jest.fn(), listCodingChats: jest.fn(),
  listCodingTranscript: jest.fn(), listCodingTranscriptPage: jest.fn(),
  stripInlineImageData: jest.fn(), listRunningSessionIdsForUser: jest.fn(),
}));
jest.mock('./coding-retrieval.service', () => ({ clearSessionMemory: jest.fn() }));
jest.mock('./usage-store', () => ({ loadSessionUsage: jest.fn() }));
// ARCHIVED-TARGET-RETIRE (2026-10-20): the session-API archive pauses the lane's
// schedules (remembered) and a restore re-arms them.
const mockPauseSchedulesForLaneArchive: jest.Mock = jest.fn(async () => 2);
const mockResumeSchedulesForRestoredChat: jest.Mock = jest.fn(async () => 2);
jest.mock('./schedule.service', () => ({
  getScheduleHealth: jest.fn(),
  pauseSchedulesForLaneArchive: (...a: any[]) => mockPauseSchedulesForLaneArchive(...a),
  resumeSchedulesForRestoredChat: (...a: any[]) => mockResumeSchedulesForRestoredChat(...a),
}));
const mockUnassignTodosForArchivedLane: jest.Mock = jest.fn(async () => ({ unassigned: 1, wokeChatIds: ['ps-1'] }));
jest.mock('../platform/archived-target-retire', () => ({
  archivedTargetRetireDisabled: () => process.env.ARCHIVED_TARGET_RETIRE_DISABLED === '1',
  unassignTodosForArchivedLane: (...a: any[]) => mockUnassignTodosForArchivedLane(...a),
}));
jest.mock('./credentials.service', () => ({
  listCredentials: jest.fn(), upsertCredential: jest.fn(), deleteCredential: jest.fn(),
}));
jest.mock('../memory/context-store', () => ({ storeGet: jest.fn() }));
jest.mock('./container.service', () => ({ stopSessionContainer: jest.fn(), removeSandboxHome: jest.fn() }));
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
// audit 2026-10-08 W3-5: an unarchive re-arms the hooks the archive paused (the real module pulls config/redis → env).
const mockResumeHooksForRestoredChat: jest.Mock = jest.fn(async () => 0);
const mockPauseHooksForArchivedSource: jest.Mock = jest.fn(async () => 1);
jest.mock('../platform/hooks.service', () => ({
  resumeHooksForRestoredChat: (...a: any[]) => mockResumeHooksForRestoredChat(...a),
  pauseHooksForArchivedSource: (...a: any[]) => mockPauseHooksForArchivedSource(...a),
}));

import codingController from './coding.controller';

const ARCHIVED_SESSION: any = { id: 's1', userId: 'u1', status: 'archived', title: 't' };

function makeReqRes(body: any) {
  const req: any = { user: { id: 'u1' }, params: { id: 's1' }, body };
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED;
  delete process.env.SESSION_API_ARCHIVE_STAMP_DISABLED;
  // updateSession loads the session twice: pre-update (status gate) + the
  // post-update row it returns.
  mockGetSessionForUser
    .mockResolvedValueOnce(ARCHIVED_SESSION)
    .mockResolvedValueOnce({ ...ARCHIVED_SESSION, status: 'ready' });
  mockPrisma.crossModelChat.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
});

describe('90d71ae7 — updateSession completes the unarchive (REST door)', () => {
  it('REPLAY: unarchiving an archived satellite clears crossModelChat.archivedAt (the wedge: satellite-only flip ⇒ chat hidden from list_chats while running)', async () => {
    const { req, res } = makeReqRes({ archived: false });
    await codingController.updateSession(req, res);
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockPrisma.crossModelChat.updateMany).toHaveBeenCalledWith({ where: { id: 's1' }, data: { archivedAt: null } });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    // audit 2026-10-08 W3-5: the bypass unarchive re-arms what the archive paused, like archiveChat's restore.
    await new Promise((r) => setImmediate(r));
    expect(mockResumeHooksForRestoredChat).toHaveBeenCalledWith('s1');
    // ARCHIVED-TARGET-RETIRE (2026-10-20): …and the schedules the archive paused.
    expect(mockResumeSchedulesForRestoredChat).toHaveBeenCalledWith('s1');
    expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalled();
  });

  it('SESSION_API_ARCHIVE_STAMP_DISABLED=1: the ARCHIVE direction does NOT stamp the chat (satellite-archived sessions keep their list visibility)', async () => {
    process.env.SESSION_API_ARCHIVE_STAMP_DISABLED = '1';
    mockGetSessionForUser.mockReset();
    mockGetSessionForUser
      .mockResolvedValueOnce({ ...ARCHIVED_SESSION, status: 'ready' })
      .mockResolvedValueOnce(ARCHIVED_SESSION);
    const { req, res } = makeReqRes({ archived: true });
    await codingController.updateSession(req, res);
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'archived' });
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
    // ARCHIVED-TARGET-RETIRE (d + e, 2026-10-20): the archive retires the lane's
    // machine work — schedules paused (remembered), hooks paused, live todos
    // unassigned (one todo_wake to the supervisor).
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledWith('s1', { archiveRetire: { detail: 'the owner archived this coding session' } });
    expect(mockPauseHooksForArchivedSource).toHaveBeenCalledWith('u1', 's1');
    expect(mockUnassignTodosForArchivedLane).toHaveBeenCalledWith({ userId: 'u1', chatId: 's1', source: 'session_archive' });
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('SESSION-API ARCHIVE STAMP (C3): the archive also stamps the chat through archiveChat (source session_api) AFTER the retire block; a refusal keeps the satellite-only state and the request still succeeds', async () => {
    mockGetSessionForUser.mockReset();
    mockGetSessionForUser.mockResolvedValueOnce({ ...ARCHIVED_SESSION, status: 'ready' }).mockResolvedValueOnce(ARCHIVED_SESSION);
    const { req, res } = makeReqRes({ archived: true });
    await codingController.updateSession(req, res);
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'archived' });
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'u1', chatId: 's1', source: 'session_api' });
    // the schedules were paused first, so archiveChat's enabled-schedule 409 cannot fire
    expect(mockPauseSchedulesForLaneArchive.mock.invocationCallOrder[0]).toBeLessThan(mockArchiveChat.mock.invocationCallOrder[0]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    // ARCHIVED_TARGET_RETIRE_DISABLED=1 leaves schedules enabled ⇒ archiveChat 409s ⇒ today's satellite-only state, no error
    jest.clearAllMocks();
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    mockArchiveChat.mockRejectedValueOnce(Object.assign(new Error('This chat has enabled schedules'), { statusCode: 409 }));
    mockGetSessionForUser.mockReset();
    mockGetSessionForUser.mockResolvedValueOnce({ ...ARCHIVED_SESSION, status: 'ready' }).mockResolvedValueOnce(ARCHIVED_SESSION);
    const second = makeReqRes({ archived: true });
    await codingController.updateSession(second.req, second.res);
    expect(mockArchiveChat).toHaveBeenCalledTimes(1);
    expect(second.res.status).not.toHaveBeenCalled();
    expect(second.res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

    // an unarchive / a re-archive of an already-archived session never calls it
    jest.clearAllMocks();
    delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED;
    mockGetSessionForUser.mockReset();
    mockGetSessionForUser.mockResolvedValueOnce(ARCHIVED_SESSION).mockResolvedValueOnce(ARCHIVED_SESSION);
    await codingController.updateSession(makeReqRes({ archived: true }).req, makeReqRes({}).res);
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('ARCHIVED-TARGET-RETIRE: re-archiving an already-archived session retires nothing again; the kill switch retires nothing at all', async () => {
    mockGetSessionForUser.mockReset();
    mockGetSessionForUser.mockResolvedValueOnce(ARCHIVED_SESSION).mockResolvedValueOnce(ARCHIVED_SESSION);
    await codingController.updateSession(makeReqRes({ archived: true }).req, makeReqRes({}).res);
    expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalled();

    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    mockGetSessionForUser.mockReset();
    mockGetSessionForUser.mockResolvedValueOnce({ ...ARCHIVED_SESSION, status: 'ready' }).mockResolvedValueOnce(ARCHIVED_SESSION);
    await codingController.updateSession(makeReqRes({ archived: true }).req, makeReqRes({}).res);
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'archived' });
    expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalled();
    expect(mockPauseHooksForArchivedSource).not.toHaveBeenCalled();
    expect(mockUnassignTodosForArchivedLane).not.toHaveBeenCalled();
  });

  it('unarchiving a satellite that was NOT archived never touches the chat stamp', async () => {
    mockGetSessionForUser.mockReset();
    mockGetSessionForUser
      .mockResolvedValueOnce({ ...ARCHIVED_SESSION, status: 'ready' })
      .mockResolvedValueOnce({ ...ARCHIVED_SESSION, status: 'ready' });
    const { req, res } = makeReqRes({ archived: false });
    await codingController.updateSession(req, res);
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
  });

  it('a RUNNING session ignores the archive param entirely (no status flip, no stamp write)', async () => {
    mockGetSessionForUser.mockReset();
    mockGetSessionForUser
      .mockResolvedValueOnce({ ...ARCHIVED_SESSION, status: 'running' })
      .mockResolvedValueOnce({ ...ARCHIVED_SESSION, status: 'running' });
    const { req, res } = makeReqRes({ archived: false });
    await codingController.updateSession(req, res);
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', {});
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
  });
});

describe('SESSION-API UNARCHIVE goes through archiveChat when the chat row is stamped (review fixer 2026-10-21 — the C3 asymmetry)', () => {
  it('REPLAY: an API archive cascade-took the children; the API unarchive restores through archiveChat (cascade restore + marker ride along) — no direct clear, no duplicate re-arm', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ archivedAt: new Date('2026-10-21T10:00:00Z') });
    const { req, res } = makeReqRes({ archived: false });
    await codingController.updateSession(req, res);
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockPrisma.crossModelChat.findUnique).toHaveBeenCalledWith({ where: { id: 's1' }, select: { archivedAt: true } });
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'u1', chatId: 's1', archived: false, source: 'session_api' });
    expect(mockPrisma.crossModelChat.updateMany).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    // archiveChat's restore re-arms the hooks + schedules itself
    expect(mockResumeHooksForRestoredChat).not.toHaveBeenCalled();
    expect(mockResumeSchedulesForRestoredChat).not.toHaveBeenCalled();
    expect(mockRememberLaneRestore).not.toHaveBeenCalled(); // archiveChat's restore leg writes it
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('a refused archiveChat restore falls back to the direct clear (+ re-arms); the request still succeeds', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ archivedAt: new Date() });
    mockArchiveChat.mockRejectedValueOnce(Object.assign(new Error('nope'), { statusCode: 400 }));
    const { req, res } = makeReqRes({ archived: false });
    await codingController.updateSession(req, res);
    expect(mockPrisma.crossModelChat.updateMany).toHaveBeenCalledWith({ where: { id: 's1' }, data: { archivedAt: null } });
    await new Promise((r) => setImmediate(r));
    expect(mockResumeHooksForRestoredChat).toHaveBeenCalledWith('s1');
    expect(mockResumeSchedulesForRestoredChat).toHaveBeenCalledWith('s1');
    // second review fixer: the direct clear is a restore — remembered (rememberLaneRestore writes nothing when every reader is off)
    expect(mockRememberLaneRestore).toHaveBeenCalledWith('s1', { source: 'session_api' });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('SESSION_API_ARCHIVE_STAMP_DISABLED=1: today\'s direct clear byte-for-byte — no chat-row read, no archiveChat', async () => {
    process.env.SESSION_API_ARCHIVE_STAMP_DISABLED = '1';
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ archivedAt: new Date() });
    const { req, res } = makeReqRes({ archived: false });
    await codingController.updateSession(req, res);
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.updateMany).toHaveBeenCalledWith({ where: { id: 's1' }, data: { archivedAt: null } });
    // REPRO (second review, finding 11): lane-retire stays live under this switch and never reads
    // chat.updatedAt — the direct clear remembers the restore, or the next pass re-archives the lane.
    await new Promise((r) => setImmediate(r));
    expect(mockRememberLaneRestore).toHaveBeenCalledWith('s1', { source: 'session_api' });
  });
});
