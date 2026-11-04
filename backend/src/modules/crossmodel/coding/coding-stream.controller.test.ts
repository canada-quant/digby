/**
 * Phase 2 LEG 2b — THE CUTOVER: the web process owns no coding execution.
 *  (a) POST /run queue path — atomic gate+queue in ONE txn (Phase-3 H1):
 *      SessionBusyError → 409, happy-path queueAgentRun, queue failure → 500
 *      with NO manual rollback (the txn rolls itself back).
 *  (b) startScheduledRun — busy skips without queueing; free queues.
 *  (c) SSE Postgres tailer — ordered replay, cursor dedupe, init reset,
 *      terminal-event end, honest end on terminal-row-without-event,
 *      queued-run synthetic progress; replay + orphan + idle attach paths.
 *  (d) stop / steer over the cross-process Redis channels.
 *  (e) LEG 2c approval/question resolve endpoints — pending-key ownership +
 *      mailbox publish (web → worker).
 *  (f) Phase 4 — durable-record fallback on those endpoints (pending key
 *      gone → coding:pend record: idempotent / aliased delivery / expired).
 *
 * Prisma + the run-state/session-run-lock/pending-durable/coding-data seams
 * are mocked; the
 * SSE response is a req/res fake (same pattern as the executor tests).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  chatCodingState: { updateMany: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  agentRun: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
  codingMessage: { create: jest.fn(async () => ({ id: 'msg1' })) },
};
// STOP MEANS STOP (2026-09-29): the Stop button's queued-continuation cancel
// records a loop_metrics row — mocked so no real buffer loads.
const mockStopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockStopMetric(...a),
  LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k).toLowerCase() }),
}));
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
// Merged controller also imports ensureChatWorkspaceState (P5-B lazy attach) and
// appendCodingMessage (P5-A dual-writing steer persistence) from this seam.
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

// 992c8374: the controller's decision-card coherence seam (a card answer also
// closes the matching flagged owner-question) DYNAMICALLY imports
// ../confirm-pending (→ config/redis → config/env — process.exit at import)
// and ../platform/owner-questions — mocked at the boundary like ./schedule.service.
const mockReadConfirmPending: jest.Mock = jest.fn(async () => new Map());
jest.mock('../confirm-pending', () => ({
  readConfirmPendingForChats: (...a: any[]) => mockReadConfirmPending(...a),
}));
const mockResolveOwnerQuestions: jest.Mock = jest.fn(async () => ({ resolved: 0, ids: [] }));
jest.mock('../platform/owner-questions', () => ({
  resolveOwnerQuestionsForChatAnswer: (...a: any[]) => mockResolveOwnerQuestions(...a),
}));

// #187's controller import of ./schedule.service reaches config/redis →
// config/env (process.exit at import) — mock the boundary. The controller
// uses consumeCapSkipNotice (run start) + restoreCapSkipNotice (busy/error
// skip: the consumed count must survive until a run actually starts).
const mockConsumeCapSkip: jest.Mock = jest.fn(async () => 0);
const mockRestoreCapSkip: jest.Mock = jest.fn(async () => {});
jest.mock('./schedule.service', () => ({
  __esModule: true,
  consumeCapSkipNotice: (...a: any[]) => mockConsumeCapSkip(...a),
  restoreCapSkipNotice: (...a: any[]) => mockRestoreCapSkip(...a),
}));

// P7 (N7/S1a): the spend-skip notice rides the same consume-or-restore contract
// through a DYNAMIC import of ./spend-cap.service — whose static chain reaches
// config/redis → config/env (process.exit at import). Same boundary mock.
const mockConsumeSpendSkip: jest.Mock = jest.fn(async () => 0);
const mockRestoreSpendSkip: jest.Mock = jest.fn(async () => {});
jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  consumeSpendCapSkipNotice: (...a: any[]) => mockConsumeSpendSkip(...a),
  restoreSpendCapSkipNotice: (...a: any[]) => mockRestoreSpendSkip(...a),
}));

// 7f546b03: the controller resolves staged chat uploads via a DYNAMIC import
// of ../upload.controller (its chain reaches config/redis → config/env —
// process.exit at import) — mocked at the boundary like ./schedule.service.
const mockLoadAttachment: jest.Mock = jest.fn(async () => null);
jest.mock('../upload.controller', () => ({
  loadAttachment: (...a: any[]) => mockLoadAttachment(...a),
}));

// error-handler reaches config/env (process.exit at import in a keyless test
// env) — mock AppError at the boundary (same shape as platform.service.test).
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

import controller, { startScheduledRun } from './coding-stream.controller';
import { SessionBusyError } from './run-state'; // the MOCKED class — instanceof-compatible with the controller's check
import { CLAIMABLE_ROW_FRESH_MS } from './coding-data.service'; // the MOCKED constant (mirrors the real value)

const SESSION: any = {
  id: 's1', projectId: 'p1', userId: 'u1', title: 't', branch: 'digby/x', baseBranch: 'main',
  worktreePath: '/tmp/wt', permissionMode: 'auto', model: 'glm-5.2', status: 'ready',
  errorMessage: null, createdAt: new Date(), updatedAt: new Date(),
  project: {
    id: 'p1', userId: 'u1', name: 'proj', repoUrl: 'https://github.com/o/r', defaultBranch: 'main',
    provider: 'github', githubLabel: null, folderId: null, createdAt: new Date(), updatedAt: new Date(),
  },
};

const BUSY = 'A run is already in progress for this session. Wait for it to finish (or Stop it) before sending another message.';

/* ── req/res fakes ── */
const mkReq = (over: any = {}): any => {
  const req: any = {
    params: { id: 's1' },
    query: {},
    body: {},
    headers: {},
    user: { id: 'u1' },
    listeners: {} as Record<string, Array<(...a: any[]) => void>>,
    on(ev: string, cb: (...a: any[]) => void) { (this.listeners[ev] ||= []).push(cb); return this; },
    ...over,
  };
  return req;
};
const mkRes = (): any => {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    chunks: [] as string[],
    writableEnded: false,
    headersSent: false,
    setHeader: jest.fn(),
    flushHeaders: jest.fn(() => { res.headersSent = true; }),
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((b: any) => { res.body = b; res.writableEnded = true; return res; }),
    write: jest.fn((s: string) => { res.chunks.push(String(s)); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const out = (res: any): string => res.chunks.join('');
/** Parsed SSE frames (heartbeat comments AND the 0c158104 replay_end boundary
 * marker dropped — control frames, not transcript): { id, type, data }. */
const frames = (res: any): Array<{ id: number | null; type: string; data: any }> =>
  out(res).split('\n\n')
    .filter((f: string) => f.trim() && !f.startsWith(':'))
    .map((f: string) => {
      // 0c158104: frame ids are COMPOSITE `<runId>:<seq>` — `id` is the seq.
      const id = f.match(/^id: (?:[^:\n]+:)?(\d+)\n/)?.[1] ?? null;
      const parsed = JSON.parse(f.replace(/^id: (?:[^:\n]+:)?\d+\n/, '').replace(/^data: /, ''));
      return { id: id ? +id : null, type: parsed.type, data: parsed.data };
    })
    .filter((f) => f.type !== 'replay_end');
const closeReq = (req: any) => (req.listeners.close || []).forEach((cb: any) => cb());
/** Flush the microtask queue (the tailer's sequential awaits on mocked promises). */
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
/** Let the tailer's immediate poll + n interval ticks run. */
const runTail = async (ticks = 0) => {
  for (let i = 0; i <= ticks; i++) {
    if (i > 0) jest.advanceTimersByTime(750);
    await flush();
  }
};

beforeEach(() => {
  jest.clearAllMocks(); // clears CALLS only — every default implementation is re-set below
  mockGetSessionForUser.mockResolvedValue(SESSION);
  mockPrisma.chatCodingState.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1' });
  mockPrisma.agentRun.findUnique.mockResolvedValue({ status: 'running' });
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
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
  mockLoadAttachment.mockResolvedValue(null); // 7f546b03: no staged uploads by default
});

/* ====================================================================
 * (a) POST /run — the queue path
 * ==================================================================== */
describe('startRun (queue-only)', () => {
  it('401s without a user', async () => {
    const res = mkRes();
    await controller.startRun(mkReq({ user: undefined, body: { message: 'hi' } }), res);
    expect(res.statusCode).toBe(401);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  it('happy path: queues the row (the gate+flip lives INSIDE queueAgentRun’s txn — Phase-3 H1), returns the started shape', async () => {
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'build it' } }), res);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'build it', images: [], userId: 'u1',
      userTurnAt: expect.any(String), // a REAL user turn anchors the confirmation protocol
    });
    // No separate controller-side gate anymore: the ready→running flip moved
    // into queueAgentRun's interactive transaction.
    expect(mockPrisma.chatCodingState.updateMany).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true, data: { started: true } });
  });

  it('busy (SessionBusyError from the in-txn gate) → 409 with the classic busy message', async () => {
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'build it' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: BUSY });
  });

  it('busy via the tagged .code (defensive mapping) → the same 409 body', async () => {
    mockQueueAgentRun.mockRejectedValue(Object.assign(new Error('busy'), { code: 'BUSY' }));
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'build it' } }), res);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: BUSY });
  });

  it('queue failure (non-busy) → 500 and NO manual rollback (the txn rolls itself back)', async () => {
    mockQueueAgentRun.mockRejectedValue(new Error('db down'));
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'build it' } }), res);
    expect(res.statusCode).toBe(500);
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });

  it('404s a session the user cannot see', async () => {
    mockGetSessionForUser.mockResolvedValue(null);
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'build it' } }), res);
    expect(res.statusCode).toBe(404);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  /* ── Ticket 7acaa7ba: a project member sending into the owner's coding
   * session used to get 404 "Session not found" (getSessionForUser 'owner'
   * returned null for members). Members DO have read access — the honest
   * answer is a 403 that names the constraint. ── */
  it('a project MEMBER (read access, not owner) gets an actionable 403, not 404', async () => {
    // getSessionForUser('read') returns the session; its userId is the OWNER's.
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, userId: 'owner-u9' });
    const res = mkRes();
    await controller.startRun(mkReq({ user: { id: 'member-u2' }, body: { message: 'build it' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CODING_OWNER_ONLY');
    expect(res.body.error).toContain('only the owner can start runs');
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  it('steerRun: a member gets the same honest 403 (was 404)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, userId: 'owner-u9' });
    const res = mkRes();
    await controller.steerRun(mkReq({ user: { id: 'member-u2' }, body: { message: 'tweak it' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('CODING_OWNER_ONLY');
    expect(mockPushSteer).not.toHaveBeenCalled();
  });

  it('the OWNER still passes the gate unchanged (queue called, no 403)', async () => {
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'build it' } }), res);
    expect(res.statusCode).toBe(200);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({ userId: 'u1' }));
  });

  /* ── 7f546b03: staged chat uploads reach the run as REAL files ── */
  const MD_B64 = Buffer.from('# notes\n').toString('base64');
  const MD_UPLOAD = { type: 'document', filename: 'notes.md', mimeType: 'text/markdown', base64: MD_B64, ownerUserId: 'u1' };

  it('uploadIds resolve into input.files — the staged bytes ride the queued run', async () => {
    mockLoadAttachment.mockResolvedValue(MD_UPLOAD);
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'use this', uploadIds: ['up-1'] } }), res);
    expect(mockLoadAttachment).toHaveBeenCalledWith('up-1');
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'use this', images: [], userId: 'u1',
      userTurnAt: expect.any(String),
      files: [{ name: 'notes.md', mediaType: 'text/markdown', data: MD_B64 }],
    });
    expect(res.body).toEqual({ success: true, data: { started: true } });
  });

  it('an upload carrying extractedText passes it through on the file payload (7b5ee09b — the readable sibling source)', async () => {
    mockLoadAttachment.mockResolvedValue({ ...MD_UPLOAD, filename: 'report.pdf', mimeType: 'application/pdf', extractedText: 'page one text' });
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'summarize this', uploadIds: ['up-1'] } }), res);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'summarize this', images: [], userId: 'u1',
      userTurnAt: expect.any(String),
      files: [{ name: 'report.pdf', mediaType: 'application/pdf', data: MD_B64, extractedText: 'page one text' }],
    });
    expect(res.body).toEqual({ success: true, data: { started: true } });
  });

  it('an upload with a NON-string extractedText resolves WITHOUT the extract key (auxiliary data never fails the file at the resolve seam)', async () => {
    mockLoadAttachment.mockResolvedValue({ ...MD_UPLOAD, extractedText: 42 });
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'go', uploadIds: ['up-1'] } }), res);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({
      files: [{ name: 'notes.md', mediaType: 'text/markdown', data: MD_B64 }],
    }));
    expect(res.body).toEqual({ success: true, data: { started: true } });
  });

  it('an attachment-only send (blank message) is legal once files resolve', async () => {
    mockLoadAttachment.mockResolvedValue(MD_UPLOAD);
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: '   ', uploadIds: ['up-1'] } }), res);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({
      files: [{ name: 'notes.md', mediaType: 'text/markdown', data: MD_B64 }],
    }));
    expect(res.body).toEqual({ success: true, data: { started: true } });
  });

  it('attachment-only startRun queues a FACTUAL marker message, not a blank row (review F1 — same marker as streamCapabilityRun)', async () => {
    mockLoadAttachment.mockResolvedValue(MD_UPLOAD);
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: '', uploadIds: ['up-1'] } }), res);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({
      message: 'Attached 1 file(s): notes.md',
    }));
    expect(res.body).toEqual({ success: true, data: { started: true } });
  });

  it('an EXPIRED uploadId → 400 (never silently dropped)', async () => {
    mockLoadAttachment.mockResolvedValue(null);
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'go', uploadIds: ['up-gone'] } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('expired');
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  it('an upload owned by a DIFFERENT user → 400', async () => {
    mockLoadAttachment.mockResolvedValue({ ...MD_UPLOAD, ownerUserId: 'u2' });
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'go', uploadIds: ['up-1'] } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('different user');
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  it('a LEGACY upload (no retained base64) → 400 naming the file', async () => {
    mockLoadAttachment.mockResolvedValue({ type: 'document', filename: 'old.csv', mimeType: 'text/csv', extractedText: 'a,b', ownerUserId: 'u1' });
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'go', uploadIds: ['up-1'] } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('Re-send old.csv');
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  it('a malformed uploadIds body → 400 (loud shape check — never stripped)', async () => {
    const res = mkRes();
    await controller.startRun(mkReq({ body: { message: 'go', uploadIds: 'up-1' } }), res);
    expect(res.statusCode).toBe(400);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * (b) startScheduledRun — same gate + queue, sweeper contract preserved
 * ==================================================================== */
describe('startScheduledRun', () => {
  it('unknown chat → not_found', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    expect(await startScheduledRun('sX', 'tick')).toEqual({ started: false, reason: 'not_found' });
  });

  it('busy session → {started:false, reason:busy} WITHOUT consuming the run budget (SessionBusyError maps to busy)', async () => {
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockUpdateSessionState).not.toHaveBeenCalled(); // status 'ready' ⇒ no heal attempted
  });

  // ── Error-state self-heal (2026-08-30 fleet audit): 'error' / never-provisioned
  // sessions used to fail the ready-gate FOREVER — machine dispatch into them
  // 409'd as if merely busy; stopRun only repaired 'running'. ──
  it('an ERROR-state session is flipped to ready and the dispatch retries once', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'error' });
    mockQueueAgentRun.mockRejectedValueOnce(new SessionBusyError()).mockResolvedValueOnce('run-new');
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: true });
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(2);
  });

  it('a NEVER-PROVISIONED lazy satellite (provisioning, no worktreePath) is flipped and retried — the worker provisions on first run', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'provisioning', worktreePath: null });
    mockQueueAgentRun.mockRejectedValueOnce(new SessionBusyError()).mockResolvedValueOnce('run-new');
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: true });
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(2);
  });

  it('an errored session with a FRESH claimable row is NOT flipped (a live worker owns it)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'error' });
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'r-live' }); // fresh claimable row
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1); // no retry
  });

  it('an errored session with a live run lock is NOT flipped', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'error' });
    mockIsLocked.mockResolvedValue(true);
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
  });

  it('a genuinely busy READY session stays busy (no heal, no flip, no retry)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'running' });
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
  });

  it('free session → queues with the schedule prompt + the owner userId', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u-owner' });
    expect(await startScheduledRun('s1', 'tick the loop')).toEqual({ started: true });
    // The sweeper path carries NO userTurnAt — machine-fired runs fail closed
    // in the consequential-platform-tool confirmation protocol.
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', { message: 'tick the loop', images: [], userId: 'u-owner' });
  });

  it('a REAL user turn (platform sendChatMessage) threads userTurnAt into the queued run', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u-owner' });
    const turn = new Date('2026-07-28T10:00:00.000Z');
    expect(await startScheduledRun('s1', 'from the user', { userTurnAt: turn })).toEqual({ started: true });
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'from the user', images: [], userId: 'u-owner', userTurnAt: turn.toISOString(),
    });
  });

  it('an explicit fleet origin (agent send) rides the queued run input — it WINS over the executor heuristic', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u-owner' });
    const turn = new Date('2026-07-28T10:00:00.000Z');
    expect(await startScheduledRun('s1', 'agent hi', {
      userTurnAt: turn, origin: 'agent', originSourceChatId: 'chat-9',
    })).toEqual({ started: true });
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'agent hi', images: [], userId: 'u-owner',
      userTurnAt: turn.toISOString(), origin: 'agent', originSourceChatId: 'chat-9',
    });
  });

  // ── Cap-skip notice delivery (audit p6): consumed only when a run actually
  // starts, and NEVER prepended to the message the executor persists as the
  // user-role transcript row. ──
  it('a pending cap-skip notice rides RunInput.capSkippedNotice — the message stays the PLAIN prompt (no banner persisted as user words)', async () => {
    mockConsumeCapSkip.mockResolvedValue(3);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u-owner' });
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: true });
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'tick', images: [], userId: 'u-owner', capSkippedNotice: 3,
    });
    expect(mockRestoreCapSkip).not.toHaveBeenCalled();
  });

  it('a BUSY skip restores the consumed cap-skip count (the self-heal signal survives until a run starts)', async () => {
    mockConsumeCapSkip.mockResolvedValue(20);
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockRestoreCapSkip).toHaveBeenCalledWith('s1', 20);
  });

  it('a queue ERROR also restores the consumed count before rethrowing', async () => {
    mockConsumeCapSkip.mockResolvedValue(5);
    mockQueueAgentRun.mockRejectedValue(new Error('db down'));
    await expect(startScheduledRun('s1', 'tick')).rejects.toThrow('db down');
    expect(mockRestoreCapSkip).toHaveBeenCalledWith('s1', 5);
  });

  it('no pending notice → no capSkippedNotice field and no restore, even on busy', async () => {
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    expect(await startScheduledRun('s1', 'tick')).toEqual({ started: false, reason: 'busy' });
    expect(mockRestoreCapSkip).not.toHaveBeenCalled();
  });

  it('a blank prompt carrying files (attachment-only platform send) queues the FACTUAL marker, never a blank message (confirmation review B1)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u-owner' });
    const files = [{ name: 'allin-people.txt', mediaType: 'text/plain', data: Buffer.from('a\n').toString('base64') }];
    expect(await startScheduledRun('s1', '', { files })).toEqual({ started: true });
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'Attached 1 file(s): allin-people.txt', images: [], userId: 'u-owner', files,
    });
  });

  it('a blank prompt WITHOUT files stays blank (pre-existing sweeper semantics unchanged)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u-owner' });
    expect(await startScheduledRun('s1', '')).toEqual({ started: true });
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', { message: '', images: [], userId: 'u-owner' });
  });

  // ── Machine-provenance header (fbe65673): schedule/hook firings carry the
  // '[MACHINE-TRIGGERED RUN' marker; human/agent sends stay byte-identical. ──
  it('a schedule firing queues the prompt WITH the machine-provenance header', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u-owner' });
    expect(await startScheduledRun('s1', 'tick the loop', { origin: 'schedule', scheduleId: 'sch_1' })).toEqual({ started: true });
    const input = mockQueueAgentRun.mock.calls[0][1];
    expect(input.message.startsWith('[MACHINE-TRIGGERED RUN')).toBe(true);
    expect(input.message).toContain('scheduled firing');
    expect(input.message).toContain('NOT a human-typed message');
    expect(input.message.endsWith('tick the loop')).toBe(true);
    expect(input.scheduleId).toBe('sch_1'); // cff523e7 stamping preserved
    expect(input.origin).toBe('schedule');
  });

  it('a hook wake queues the prompt WITH the hook variant of the header (and never stamps scheduleId)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u-owner' });
    expect(await startScheduledRun('s1', 'fleet event', { origin: 'hook' })).toEqual({ started: true });
    const input = mockQueueAgentRun.mock.calls[0][1];
    expect(input.message.startsWith('[MACHINE-TRIGGERED RUN')).toBe(true);
    expect(input.message).toContain('event hook');
    expect(input.message.endsWith('fleet event')).toBe(true);
    expect(input.scheduleId).toBeUndefined();
    expect(input.origin).toBe('hook');
  });

  it('agent sends + origin-less sends stay byte-identical — the marker never touches human-lookalike traffic', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u-owner' });
    await startScheduledRun('s1', 'from the supervisor', { origin: 'agent', originSourceChatId: 'sup-1' });
    expect(mockQueueAgentRun.mock.calls[0][1].message).toBe('from the supervisor');
    await startScheduledRun('s1', 'plain tick');
    expect(mockQueueAgentRun.mock.calls[1][1].message).toBe('plain tick');
  });
});

/* ====================================================================
 * (b2) streamCapabilityRun — chat uploads reach the capability run (7f546b03)
 * ==================================================================== */
describe('streamCapabilityRun — chat uploads reach the coding run (7f546b03)', () => {
  const CHAT = { id: 's1', userId: 'u1', projectId: 'p1', title: 't' };
  const CSV_B64 = Buffer.from('a,b\n1,2\n').toString('base64');
  const CSV_UPLOAD = { type: 'document', filename: 'data.csv', mimeType: 'text/csv', base64: CSV_B64, ownerUserId: 'u1' };

  it('attachment-only send: uploadIds resolve and queue input.files with a factual marker message', async () => {
    mockEnsureChatWorkspaceState.mockResolvedValue(SESSION);
    mockLoadAttachment.mockResolvedValue(CSV_UPLOAD);
    // No active run at the busy check; the just-queued row is visible to the attach.
    mockGetActiveRun.mockResolvedValueOnce(null).mockResolvedValue({ id: 'r-new', status: 'queued' });
    const req = mkReq({ query: {} });
    const res = mkRes();
    await controller.streamCapabilityRun(req, res, CHAT, '', ['up-1']);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'Attached 1 file(s): data.csv', images: [], userId: 'u1',
      userTurnAt: expect.any(String),
      files: [{ name: 'data.csv', mediaType: 'text/csv', data: CSV_B64 }],
    });
    // …and the response ATTACHED to the queued run's log (synthetic queued progress).
    await flush();
    expect(out(res)).toContain('Queued');
    closeReq(req);
  });

  it('message + uploads: the typed message stays the run message and the files ride along', async () => {
    mockEnsureChatWorkspaceState.mockResolvedValue(SESSION);
    mockLoadAttachment.mockResolvedValue(CSV_UPLOAD);
    mockGetActiveRun.mockResolvedValueOnce(null).mockResolvedValue({ id: 'r-new', status: 'queued' });
    const req = mkReq({ query: {} });
    const res = mkRes();
    await controller.streamCapabilityRun(req, res, CHAT, 'crunch this', ['up-1']);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({
      message: 'crunch this',
      files: [{ name: 'data.csv', mediaType: 'text/csv', data: CSV_B64 }],
    }));
    closeReq(req);
  });

  it('an EXPIRED uploadId 400s BEFORE the stream opens (plain JSON, no SSE headers)', async () => {
    mockEnsureChatWorkspaceState.mockResolvedValue(SESSION);
    mockLoadAttachment.mockResolvedValue(null);
    const res = mkRes();
    await controller.streamCapabilityRun(mkReq({ query: {} }), res, CHAT, 'go', ['up-gone']);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('expired');
    expect(res.headersSent).toBe(false);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  it('a live run + an attachment-only send → 409 (the busy rule counts files)', async () => {
    mockEnsureChatWorkspaceState.mockResolvedValue(SESSION);
    mockLoadAttachment.mockResolvedValue(CSV_UPLOAD);
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const res = mkRes();
    await controller.streamCapabilityRun(mkReq({ query: {} }), res, CHAT, '', ['up-1']);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: BUSY });
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  it('no uploads and no message: the plain attach behavior is untouched (no resolve, no files key)', async () => {
    mockEnsureChatWorkspaceState.mockResolvedValue(SESSION);
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const req = mkReq({ query: {} });
    const res = mkRes();
    await controller.streamCapabilityRun(req, res, CHAT, '');
    expect(mockLoadAttachment).not.toHaveBeenCalled();
    // Empty attach → tails the active run (the pre-7f546b03 behavior).
    expect(res.statusCode).toBe(200);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
    closeReq(req);
  });
});

/* ====================================================================
 * (b3) PE-01 / 7acaa7ba — the unified /api/crossmodel/stream route carries
 * NO `:id` param (chatId rides the query, or the registered stream token):
 * streamCapabilityRun must seed the session id into the attach explicitly.
 * Pre-fix: `const { id } = req.params` was undefined on that route →
 * prisma findUnique({ where: { id: undefined } }) → 500 AFTER the run was
 * queued (the user saw an error; the resend 409'd busy). mkReq defaults
 * params to { id: 's1' }, which is exactly why the old tests never saw it.
 * ==================================================================== */
describe('streamCapabilityRun over the unified /stream route (no :id param) — PE-01 / 7acaa7ba', () => {
  const CHAT = { id: 's1', userId: 'u1', projectId: 'p1', title: 't' };

  it('GET /stream?chatId=&message= replay on a workspace-attached chat: the run queues ONCE and the attach reads the REAL session id', async () => {
    mockEnsureChatWorkspaceState.mockResolvedValue(SESSION);
    mockGetActiveRun.mockResolvedValueOnce(null).mockResolvedValue({ id: 'r-new', status: 'queued' });
    // The exact req shape of GET /api/crossmodel/stream: params {} (no route
    // param), chatId + message in the query.
    const req = mkReq({ params: {}, query: { chatId: 's1', message: 'fix formatting' } });
    const res = mkRes();
    await controller.streamCapabilityRun(req, res, CHAT, 'fix formatting');
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', expect.objectContaining({ message: 'fix formatting' }));
    // The attach's access-checked lookup got the session id — never undefined.
    expect(mockGetSessionForUser).toHaveBeenCalledWith('s1', 'u1', 'read', expect.objectContaining({ includeProject: true }));
    for (const c of mockGetSessionForUser.mock.calls) expect(c[0]).toBe('s1');
    expect(res.statusCode).toBe(200);
    expect(res.json).not.toHaveBeenCalled();
    await flush();
    expect(out(res)).toContain('Queued');
    closeReq(req);
  });

  it('POST-registered /stream (streamToken → chatId; params {} AND an empty query): the seeded id still carries the attach', async () => {
    mockEnsureChatWorkspaceState.mockResolvedValue(SESSION);
    mockGetActiveRun.mockResolvedValueOnce(null).mockResolvedValue({ id: 'r-new', status: 'queued' });
    // POST /stream/register stores chatId + message server-side; the follow-up
    // GET /stream?streamToken=… has NEITHER a route param NOR ?chatId= — the
    // controller resolves the chat from the token and hands it to us.
    const req = mkReq({ params: {}, query: { streamToken: 'tok-1' }, body: {} });
    const res = mkRes();
    await controller.streamCapabilityRun(req, res, CHAT, 'good gift for a 9 year old', undefined);
    expect(mockQueueAgentRun).toHaveBeenCalledTimes(1);
    expect(mockGetSessionForUser).toHaveBeenCalledWith('s1', 'u1', 'read', expect.anything());
    for (const c of mockGetSessionForUser.mock.calls) expect(c[0]).toBe('s1');
    expect(res.statusCode).toBe(200);
    await flush();
    expect(out(res)).toContain('Queued');
    closeReq(req);
  });

  it('a project MEMBER attaching over /stream (params {}) reads the session by chat.id both times — never undefined', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, userId: 'owner-x' });
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const req = mkReq({ params: {}, query: { chatId: 's1' }, user: { id: 'member-1' } });
    const res = mkRes();
    await controller.streamCapabilityRun(req, res, { ...CHAT, userId: 'owner-x' }, '');
    expect(mockEnsureChatWorkspaceState).not.toHaveBeenCalled();
    for (const c of mockGetSessionForUser.mock.calls) expect(c[0]).toBe('s1');
    expect(res.statusCode).toBe(200);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
    closeReq(req);
  });

  it('streamRun with NO :id and NO ?chatId → 400 (never a lookup with an undefined id, never a 500)', async () => {
    const res = mkRes();
    await controller.streamRun(mkReq({ params: {}, query: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/session id/i);
    expect(mockGetSessionForUser).not.toHaveBeenCalled();
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });

  it('streamRun with params {} but ?chatId= resolves the session from the query and tails the live run', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const req = mkReq({ params: {}, query: { chatId: 's1' } });
    const res = mkRes();
    await controller.streamRun(req, res);
    expect(mockGetSessionForUser).toHaveBeenCalledWith('s1', 'u1', 'read', expect.anything());
    expect(res.statusCode).toBe(200);
    closeReq(req);
  });

  it('the mounted /coding/sessions/:id/stream route is byte-identical: :id wins over a stray ?chatId=', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const req = mkReq({ params: { id: 's1' }, query: { chatId: 'other' } });
    const res = mkRes();
    await controller.streamRun(req, res);
    expect(mockGetSessionForUser).toHaveBeenCalledWith('s1', 'u1', 'read', expect.anything());
    closeReq(req);
  });
});

/* ====================================================================
 * (c) GET /stream — the Postgres tailer
 * ==================================================================== */
describe('streamRun tailer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('queued run: ONE synthetic unsequenced progress event + the stream stays open', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'queued' });
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(2); // a few polls: no events, row still 'running'
    const f = frames(res);
    expect(f).toHaveLength(1);
    expect(f[0]).toEqual({ id: null, type: 'progress', data: { message: 'Queued — a worker will pick this up shortly…', stage: 'queued' } });
    expect(res.writableEnded).toBe(false); // stays open on the heartbeat
    expect(mockGetEventsAfter).toHaveBeenCalledWith('r1', -1); // first poll fetches the full log
    closeReq(req);
    expect(res.writableEnded).toBe(true);
  });

  it('running run: ordered writes with seq ids; a terminal event ends the stream', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    mockGetEventsAfter
      .mockResolvedValueOnce([{ seq: 1, type: 'init', payload: { sessionId: 's1' } }, { seq: 2, type: 'text', payload: { delta: 'a' } }])
      .mockResolvedValueOnce([{ seq: 3, type: 'complete', payload: { finalText: 'done', parts: [] } }]);
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(1);
    const f = frames(res);
    expect(f.map(x => x.id)).toEqual([1, 2, 3]);
    expect(f.map(x => x.type)).toEqual(['init', 'text', 'complete']);
    expect(res.writableEnded).toBe(true);
    // After seeing seq 2 the second poll filters in SQL from this run's OWN seq space.
    expect(mockGetEventsAfter).toHaveBeenLastCalledWith('r1', 2);
  });

  it('cursor dedupe: seq <= cursor are skipped (same-run cursor, no init in the window)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    mockGetEventsAfter.mockResolvedValueOnce([
      { seq: 3, type: 'text', payload: { delta: 'seen' } },
      { seq: 4, type: 'complete', payload: { finalText: 'done', parts: [] } },
    ]);
    const req = mkReq({ headers: { 'last-event-id': '3' } }), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(0);
    const f = frames(res);
    expect(f.map(x => x.id)).toEqual([4]); // seq 3 was already seen by this client
    expect(res.writableEnded).toBe(true);
  });

  it('an init event resets a FOREIGN cursor (a previous run\'s seq space)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    mockGetEventsAfter.mockResolvedValueOnce([
      { seq: 1, type: 'init', payload: { sessionId: 's1' } },
      { seq: 2, type: 'complete', payload: { finalText: 'done', parts: [] } },
    ]);
    const req = mkReq({ headers: { 'last-event-id': '50' } }), res = mkRes(); // cursor from an older run
    await controller.streamRun(req, res);
    await runTail(0);
    const f = frames(res);
    expect(f.map(x => x.id)).toEqual([1, 2]); // nothing skipped — the init reset the filter
    expect(res.writableEnded).toBe(true);
  });

  it('TRUSTED composite cursor (<runId>:<seq>): the FIRST poll filters in SQL — no whole-log replay, no init reset (0c158104)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    mockGetEventsAfter.mockResolvedValueOnce([
      { seq: 41, type: 'text', payload: { delta: 'new' } },
      { seq: 42, type: 'complete', payload: { finalText: 'done', parts: [] } },
    ]);
    const req = mkReq({ headers: { 'last-event-id': 'r1:40' } }), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(0);
    // The fix: the backlog (seq <= 40) is never re-fetched, let alone re-sent.
    expect(mockGetEventsAfter).toHaveBeenCalledWith('r1', 40);
    const f = frames(res);
    expect(f.map(x => x.id)).toEqual([41, 42]); // no init, nothing at/below 40
    expect(res.writableEnded).toBe(true);
  });

  it('a same-run init PAST the cursor is delivered WITHOUT resetting the trusted cursor (ba6fa991) — filtering stays seq > cursor', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    mockGetEventsAfter.mockResolvedValueOnce([
      { seq: 41, type: 'init', payload: { sessionId: 's1', generation: 2 } },
      { seq: 42, type: 'complete', payload: { finalText: 'done', parts: [] } },
    ]);
    const req = mkReq({ headers: { 'last-event-id': 'r1:40' } }), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(0);
    const f = frames(res);
    expect(f[0].type).toBe('init'); // the new-generation signal still reaches the client
    expect(f.map(x => x.id)).toEqual([41, 42]); // …and only rows PAST the cursor stream
  });

  it('TRUSTED cursor + a later-generation init: the cursor SURVIVES the generation boundary — no poll ever re-fetches from -1 (ba6fa991 acceptance)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    mockGetEventsAfter
      .mockResolvedValueOnce([{ seq: 41, type: 'init', payload: { sessionId: 's1', generation: 2 } }]) // resume generation lands
      .mockResolvedValueOnce([{ seq: 42, type: 'text', payload: { delta: 'post-resume' } }])
      .mockResolvedValue([{ seq: 43, type: 'complete', payload: { finalText: 'done', parts: [] } }]);
    const req = mkReq({ headers: { 'last-event-id': 'r1:40' } }), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(2); // first poll + two interval ticks (the init poll, then live rows)
    // The anti-replay contract: every poll filtered in SQL from the advancing
    // cursor — a worker-restart init must NEVER drop the fetch back to -1
    // (the 2026-08-27 incident: 35k events re-streamed across 4 bounces).
    expect(mockGetEventsAfter).toHaveBeenNthCalledWith(1, 'r1', 40);
    expect(mockGetEventsAfter).toHaveBeenNthCalledWith(2, 'r1', 41);
    expect(mockGetEventsAfter).not.toHaveBeenCalledWith('r1', -1);
    const f = frames(res);
    expect(f.map(x => x.id)).toEqual([41, 42, 43]); // init + only rows past the cursor
    expect(res.writableEnded).toBe(true);
  });

  it('a composite cursor for a DIFFERENT run is untrusted: the first poll starts at seq 1 and its init resets the cursor (0c158104 acceptance)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    mockGetEventsAfter.mockResolvedValueOnce([
      { seq: 1, type: 'init', payload: { sessionId: 's1' } },
      { seq: 2, type: 'text', payload: { delta: 'a' } },
      { seq: 3, type: 'complete', payload: { finalText: 'done', parts: [] } },
    ]);
    const req = mkReq({ headers: { 'last-event-id': 'rOLD:40' } }), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(0);
    expect(mockGetEventsAfter).toHaveBeenCalledWith('r1', -1); // untrusted → the full log
    const f = frames(res);
    expect(f[0].type).toBe('init'); // …whose first-poll init resets the cursor
    expect(f.map(x => x.id)).toEqual([1, 2, 3]); // then the whole backlog follows
  });

  it('emits the replay_end boundary marker after the first-poll backlog drains; live frames follow it', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    mockGetEventsAfter
      .mockResolvedValueOnce([{ seq: 1, type: 'init', payload: { sessionId: 's1' } }])
      .mockResolvedValue([{ seq: 2, type: 'text', payload: { delta: 'live' } }]);
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(1);
    const raw = out(res);
    const boundary = raw.indexOf('"type":"replay_end"');
    expect(boundary).toBeGreaterThan(-1);
    expect(raw.indexOf('"type":"init"')).toBeLessThan(boundary); // backlog first
    expect(raw.indexOf('"delta":"live"')).toBeGreaterThan(boundary); // live after
    closeReq(req);
  });

  it('terminal ROW with no terminal event ends honestly (no fabricated complete)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    mockPrisma.agentRun.findUnique.mockResolvedValue({ status: 'completed' }); // finalized between polls
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(1);
    expect(res.writableEnded).toBe(true);
    expect(frames(res).filter(f => f.type === 'complete')).toHaveLength(0);
  });

  it('INTERRUPTED latest run → TAIL (stream stays open through the resume), never replay-and-close (2026-08-28 replay-loop fix)', async () => {
    mockGetLatestRun.mockResolvedValue({ id: 'r8', status: 'interrupted' });
    mockPrisma.agentRun.findUnique.mockResolvedValue({ status: 'interrupted' });
    const log = [
      { seq: 1, type: 'init', payload: { sessionId: 's1' } },
      { seq: 2, type: 'text', payload: { delta: 'partial' } },
    ];
    mockGetEventsAfter.mockImplementation(async (_id: string, after: number) => log.filter((r) => r.seq > after));
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(2); // immediate poll + 2 ticks with no new rows
    expect(frames(res).map(x => x.id)).toEqual([1, 2]);
    expect(res.writableEnded).toBe(false); // stays OPEN — no replay loop
    closeReq(req);
  });

  it('no active run → replay the LATEST run\'s log and end on its terminal event', async () => {
    mockGetLatestRun.mockResolvedValue({ id: 'r9', status: 'completed' });
    mockGetEventsAfter.mockResolvedValue([
      { seq: 1, type: 'init', payload: { sessionId: 's1' } },
      { seq: 2, type: 'text', payload: { delta: 'a' } },
      { seq: 3, type: 'complete', payload: { finalText: 'done', parts: [] } },
    ]);
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(0);
    expect(mockGetEventsAfter).toHaveBeenCalledWith('r9', -1, 5000);
    expect(frames(res).map(x => x.id)).toEqual([1, 2, 3]);
    expect(res.writableEnded).toBe(true);
  });

  it('replay honors a TRUSTED composite cursor: the first PAGE filters in SQL (finished-run attach resumes, 0c158104)', async () => {
    mockGetLatestRun.mockResolvedValue({ id: 'r9', status: 'completed' });
    mockGetEventsAfter.mockResolvedValue([
      { seq: 41, type: 'text', payload: { delta: 'tail' } },
      { seq: 42, type: 'complete', payload: { finalText: 'done', parts: [] } },
    ]);
    const req = mkReq({ headers: { 'last-event-id': 'r9:40' } }), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(0);
    expect(mockGetEventsAfter).toHaveBeenCalledWith('r9', 40, 5000);
    expect(frames(res).map(x => x.id)).toEqual([41, 42]);
  });

  it('replay paginates a longer-than-one-page log (no duplicate flood on reconnect)', async () => {
    mockGetLatestRun.mockResolvedValue({ id: 'r9', status: 'completed' });
    const page1 = Array.from({ length: 5000 }, (_, i) =>
      ({ seq: i + 1, type: i === 0 ? 'init' : 'text', payload: { delta: 'x' } }));
    mockGetEventsAfter
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([{ seq: 5001, type: 'complete', payload: { finalText: 'done', parts: [] } }]);
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(0);
    expect(mockGetEventsAfter).toHaveBeenNthCalledWith(1, 'r9', -1, 5000);
    expect(mockGetEventsAfter).toHaveBeenNthCalledWith(2, 'r9', 5000, 5000); // page 2 from the highest SEEN seq
    // Batch coalescing (2026-08-27): the 4999 text rows arrive as ONE merged
    // frame (lossless — all deltas concatenated, id = last seq of the group).
    const fr = frames(res);
    expect(fr).toHaveLength(3);
    expect(fr[0].type).toBe('init');
    expect(fr[1].id).toBe(5000);
    expect(fr[1].data.delta).toBe('x'.repeat(4999));
    expect(fr[2].type).toBe('complete');
    expect(res.writableEnded).toBe(true);
  });

  it('replay with no terminal event ends honestly after the log', async () => {
    mockGetLatestRun.mockResolvedValue({ id: 'r9', status: 'failed' });
    mockGetEventsAfter.mockResolvedValue([{ seq: 1, type: 'init', payload: { sessionId: 's1' } }]);
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(0);
    expect(frames(res).map(x => x.id)).toEqual([1]);
    expect(res.writableEnded).toBe(true);
  });

  it('no runs + session running + no lock → orphan reset + honest interrupted complete', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'running' });
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await flush();
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    const f = frames(res);
    expect(f).toEqual([{ id: null, type: 'complete', data: { finalText: '', parts: [], interrupted: true } }]);
    expect(res.writableEnded).toBe(true);
  });

  it('no runs + session running + lock held → no reset; honest close (client re-attaches)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'running' });
    mockIsLocked.mockResolvedValue(true);
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await flush();
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
    expect(frames(res).map(f => f.type)).toEqual(['progress']);
    expect(res.writableEnded).toBe(true);
  });

  it('no runs + idle session → 400 message is required (unchanged idle behavior)', async () => {
    const req = mkReq(), res = mkRes();
    await controller.streamRun(req, res);
    await flush();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'message is required' });
  });

  it('back-compat: a query message queues a run (owner) then tails it', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'queued' });
    const req = mkReq({ query: { message: 'legacy start' } }), res = mkRes();
    await controller.streamRun(req, res);
    await runTail(0);
    expect(mockQueueAgentRun).toHaveBeenCalledWith('s1', {
      message: 'legacy start', images: [], userId: 'u1',
      userTurnAt: expect.any(String), // the stream back-compat start is a real user turn
    });
    expect(frames(res)[0].type).toBe('progress'); // the synthetic queued event
    closeReq(req);
  });

  it('back-compat: a query message while busy → 409 (the in-txn gate throws SessionBusyError)', async () => {
    mockQueueAgentRun.mockRejectedValue(new SessionBusyError());
    const req = mkReq({ query: { message: 'legacy start' } }), res = mkRes();
    await controller.streamRun(req, res);
    await flush();
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: BUSY });
  });

  it('back-compat: a non-owner cannot start via the query string', async () => {
    const req = mkReq({ user: { id: 'u-member' }, query: { message: 'not mine' } }), res = mkRes();
    await controller.streamRun(req, res);
    await flush();
    expect(res.statusCode).toBe(403);
    expect(mockQueueAgentRun).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * (d) stop + steer — the cross-process Redis channels
 * ==================================================================== */
describe('stopRun', () => {
  it('(stop means stop) a queued continuation is cancelled FIRST — no cancel key is left behind for the next run', async () => {
    mockPrisma.agentRun.findMany.mockResolvedValue([{ id: 'c1', input: { message: '[HARNESS CONTINUATION r1/6] resume' } }]);
    mockGetActiveRun.mockResolvedValue(null); // the continuation was the only queued row — now cancelled
    const res = mkRes();
    await controller.stopRun(mkReq(), res);
    expect(mockPrisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1', status: 'queued' } }));
    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true, data: { stopping: false, cancelledContinuations: 1 } });
    await new Promise((r) => setImmediate(r));
    expect(mockStopMetric).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', meta: { reason: 'stopped', seam: 'stop', cancelled: 1 } }));
  });

  it('(stop means stop) a running run AND a queued continuation: both stopped', async () => {
    mockPrisma.agentRun.findMany.mockResolvedValue([{ id: 'c1', input: { message: '[HARNESS CONTINUATION r2/6] resume' } }]);
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const res = mkRes();
    await controller.stopRun(mkReq(), res);
    expect(mockPrisma.agentRun.updateMany).toHaveBeenCalledTimes(1);
    expect(mockRequestCancel).toHaveBeenCalledWith('s1');
    expect(res.body).toEqual({ success: true, data: { stopping: true, cancelledContinuations: 1 } });
  });

  it('active run → requestRunCancel + stopping:true', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const res = mkRes();
    await controller.stopRun(mkReq(), res);
    expect(mockRequestCancel).toHaveBeenCalledWith('s1');
    expect(res.body).toEqual({ success: true, data: { stopping: true } });
  });

  it('no active run + claimable row → stopping:false and NOT reset (a worker owns it)', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'running' });
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'r-old' }); // interrupted, worker-claimable
    const res = mkRes();
    await controller.stopRun(mkReq(), res);
    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockUpdateSessionState).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: true, data: { stopping: false } });
  });

  it('no active run + no claimable row + no lock → unstick the orphaned row', async () => {
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'running' });
    const res = mkRes();
    await controller.stopRun(mkReq(), res);
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
    expect(res.body).toEqual({ success: true, data: { stopping: false } });
  });

  it('unstick claimable lookup is freshness-bounded (stale rows do not block the Stop button)', async () => {
    // 2026-07-31 zombie incident: a stale queued/interrupted agent_runs row
    // (dead worker) must NOT keep a session stuck 'running' — the findFirst
    // must carry the same updatedAt lower bound as the orphan sweeper.
    mockGetSessionForUser.mockResolvedValue({ ...SESSION, status: 'running' });
    const res = mkRes();
    const before = Date.now();
    await controller.stopRun(mkReq(), res);
    const after = Date.now();
    const where = mockPrisma.agentRun.findFirst.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['queued', 'interrupted', 'running'] });
    const gte = where.updatedAt.gte as Date;
    expect(gte).toBeInstanceOf(Date);
    expect(gte.getTime()).toBeGreaterThanOrEqual(before - CLAIMABLE_ROW_FRESH_MS - 1000);
    expect(gte.getTime()).toBeLessThanOrEqual(after - CLAIMABLE_ROW_FRESH_MS + 1000);
    // And with no fresh row + no lock, the session unsticks.
    expect(mockUpdateSessionState).toHaveBeenCalledWith('s1', { status: 'ready' });
  });
});

describe('steerRun', () => {
  it('no active run → 409', async () => {
    const res = mkRes();
    await controller.steerRun(mkReq({ body: { message: 'turn left' } }), res);
    expect(res.statusCode).toBe(409);
    expect(mockPushSteer).not.toHaveBeenCalled();
  });

  it('active run → Redis steer + persisted user row + {steered:true}', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const res = mkRes();
    await controller.steerRun(mkReq({ body: { message: 'turn left' } }), res);
    expect(mockPushSteer).toHaveBeenCalledWith('s1', { text: 'turn left', images: [], messageIds: [expect.any(String)] });
    // P5-A: the persisted user row goes through the dual-writing data-service helper.
    // fc7b2ca7: the row id is pre-generated and rides the mailbox (second arg).
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', role: 'user', content: 'turn left',
    }), expect.any(String));
    expect(res.body).toEqual({ success: true, data: { steered: true } });
  });

  it('an HTTP steer (a REAL user turn) persists WITHOUT metadata — unmarked rows read as human in the fleet views', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const res = mkRes();
    await controller.steerRun(mkReq({ body: { message: 'turn left' } }), res);
    expect(mockAppendCodingMessage.mock.calls[0][0].metadata).toBeUndefined();
  });

  /* ── 7f546b03: a steer can carry staged chat uploads as REAL files ── */
  it('steer with uploadIds: files ride the Redis mailbox + metadata.attachments (NEVER base64 in parts)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const MD_B64 = Buffer.from('# notes\n').toString('base64');
    mockLoadAttachment.mockResolvedValue({ type: 'document', filename: 'notes.md', mimeType: 'text/markdown', base64: MD_B64, ownerUserId: 'u1' });
    const res = mkRes();
    await controller.steerRun(mkReq({ body: { message: 'turn left', uploadIds: ['up-1'] } }), res);
    expect(mockPushSteer).toHaveBeenCalledWith('s1', {
      text: 'turn left', images: [],
      files: [{ name: 'notes.md', mediaType: 'text/markdown', data: MD_B64 }],
      messageIds: [expect.any(String)],
    });
    const row = mockAppendCodingMessage.mock.calls[0][0];
    expect(row.metadata).toEqual({ attachments: [{ filename: 'notes.md', type: 'text/markdown' }] });
    expect(row.parts).toEqual([{ type: 'text', text: 'turn left' }]); // no file parts in the transcript row
    expect(res.body).toEqual({ success: true, data: { steered: true } });
  });

  it('steer with an EXPIRED uploadId → 400 (never silently dropped)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    mockLoadAttachment.mockResolvedValue(null);
    const res = mkRes();
    await controller.steerRun(mkReq({ body: { message: 'turn left', uploadIds: ['up-gone'] } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('expired');
    expect(mockPushSteer).not.toHaveBeenCalled();
  });

  it('an attachment-only steer (blank message + files) carries the FACTUAL marker — never a blank row (confirmation review B1)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const MD_B64 = Buffer.from('# notes\n').toString('base64');
    mockLoadAttachment.mockResolvedValue({ type: 'document', filename: 'notes.md', mimeType: 'text/markdown', base64: MD_B64, ownerUserId: 'u1' });
    const res = mkRes();
    await controller.steerRun(mkReq({ body: { message: '   ', uploadIds: ['up-1'] } }), res);
    expect(mockPushSteer).toHaveBeenCalledWith('s1', {
      text: 'Attached 1 file(s): notes.md', images: [],
      files: [{ name: 'notes.md', mediaType: 'text/markdown', data: MD_B64 }],
      messageIds: [expect.any(String)],
    });
    const row = mockAppendCodingMessage.mock.calls[0][0];
    expect(row.content).toBe('Attached 1 file(s): notes.md');
    expect(row.parts).toEqual([{ type: 'text', text: 'Attached 1 file(s): notes.md' }]);
    expect(row.metadata).toEqual({ attachments: [{ filename: 'notes.md', type: 'text/markdown' }] });
    expect(res.body).toEqual({ success: true, data: { steered: true } });
  });
});

describe('steerActiveRun (service-level) — fleet origin stamping (hardening round 2, 2026-08-23)', () => {
  it('stamps metadata.origin on the persisted steer row for a WEBHOOK-origin send (fleet.service MACHINE_ORIGINS)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    const r = await controller.steerActiveRun('s1', 'gateway down', [], { origin: 'webhook' });
    expect(r).toEqual({ steered: true });
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 's1', role: 'user', content: 'gateway down',
      metadata: { origin: 'webhook' },
    }), expect.any(String));
  });

  it('carries the sending chat id for an AGENT steer (mirrors the fresh-run stamp shape)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    await controller.steerActiveRun('s1', 'from the supervisor', [], { origin: 'agent', originSourceChatId: 'sup-1' });
    expect(mockAppendCodingMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { origin: 'agent', sourceChatId: 'sup-1' },
    }), expect.any(String));
  });

  // audit 2026-10-08 W2-9: the origin also rides the Redis steer MAILBOX so the
  // worker can frame a peer / webhook steer as not-the-owner's words.
  it('the steer mailbox payload carries the origin + sending chat (machine steers only)', async () => {
    mockGetActiveRun.mockResolvedValue({ id: 'r1', status: 'running' });
    await controller.steerActiveRun('s1', 'from the supervisor', [], { origin: 'agent', originSourceChatId: 'sup-1' });
    expect(mockPushSteer).toHaveBeenCalledWith('s1', expect.objectContaining({ text: 'from the supervisor', origin: 'agent', sourceChatId: 'sup-1' }));
    mockPushSteer.mockClear();
    await controller.steerActiveRun('s1', 'gateway down', [], { origin: 'webhook' });
    expect(mockPushSteer).toHaveBeenCalledWith('s1', expect.objectContaining({ origin: 'webhook' }));
    expect(mockPushSteer.mock.calls[0][1].sourceChatId).toBeUndefined();
  });
});

/* ====================================================================
 * (e) LEG 2c — approvals/questions resolve endpoints (web → worker mailbox)
 * ==================================================================== */
describe('postApproval (cross-process)', () => {
  it('401s without a user', async () => {
    const res = mkRes();
    await controller.postApproval(mkReq({ user: undefined, params: { approvalId: 'a1' }, body: { decision: 'allow' } }), res);
    expect(res.statusCode).toBe(401);
    expect(mockPublishApprovalRes).not.toHaveBeenCalled();
  });

  it('400s on an invalid decision', async () => {
    const res = mkRes();
    await controller.postApproval(mkReq({ params: { approvalId: 'a1' }, body: { decision: 'maybe' } }), res);
    expect(res.statusCode).toBe(400);
    expect(mockGetApprovalPending).not.toHaveBeenCalled();
  });

  it('unknown/expired id (no pending key) → success:false, no ownership lookup, no publish', async () => {
    const res = mkRes();
    await controller.postApproval(mkReq({ params: { approvalId: 'a-gone' }, body: { decision: 'allow' } }), res);
    expect(res.body).toEqual({ success: false });
    expect(mockGetSessionForUser).not.toHaveBeenCalled();
    expect(mockPublishApprovalRes).not.toHaveBeenCalled();
  });

  it('wrong owner → 403, nothing published', async () => {
    mockGetApprovalPending.mockResolvedValue('s1');
    mockGetSessionForUser.mockResolvedValue(null); // not the owner
    const res = mkRes();
    await controller.postApproval(mkReq({ params: { approvalId: 'a1' }, body: { decision: 'deny' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Not your approval to resolve' });
    expect(mockGetSessionForUser).toHaveBeenCalledWith('s1', 'u1', 'owner');
    expect(mockPublishApprovalRes).not.toHaveBeenCalled();
  });

  it('happy path: decision RPUSHed to the owning session\'s mailbox + success shape', async () => {
    mockGetApprovalPending.mockResolvedValue('s1');
    const res = mkRes();
    await controller.postApproval(mkReq({ params: { approvalId: 'a1' }, body: { decision: 'always' } }), res);
    expect(mockPublishApprovalRes).toHaveBeenCalledWith('s1', 'a1', 'always');
    expect(res.body).toEqual({ success: true });
  });
});

describe('postQuestion (cross-process)', () => {
  it('400s on an empty answer', async () => {
    const res = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q1' }, body: { answer: '  ' } }), res);
    expect(res.statusCode).toBe(400);
    expect(mockGetQuestionPending).not.toHaveBeenCalled();
  });

  it('unknown/expired id (no pending key) → success:false, no ownership lookup, no publish', async () => {
    const res = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q-gone' }, body: { answer: 'hi' } }), res);
    expect(res.body).toEqual({ success: false });
    expect(mockGetSessionForUser).not.toHaveBeenCalled();
    expect(mockPublishQuestionRes).not.toHaveBeenCalled();
  });

  it('wrong owner → 403, nothing published', async () => {
    mockGetQuestionPending.mockResolvedValue('s1');
    mockGetSessionForUser.mockResolvedValue(null);
    const res = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q1' }, body: { answer: 'mine' } }), res);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Not your question to answer' });
    expect(mockPublishQuestionRes).not.toHaveBeenCalled();
  });

  it('happy path: answer RPUSHed to the owning session\'s mailbox (sliced to 8000) + success shape', async () => {
    mockGetQuestionPending.mockResolvedValue('s1');
    const long = 'x'.repeat(9000);
    const res = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q1' }, body: { answer: long } }), res);
    expect(mockPublishQuestionRes).toHaveBeenCalledWith('s1', 'q1', long.slice(0, 8000));
    expect(res.body).toEqual({ success: true });
  });

  it('992c8374: a card answer also closes the matching flagged owner-question for the session', async () => {
    mockGetQuestionPending.mockResolvedValue('s1');
    mockReadConfirmPending.mockResolvedValue(new Map([['s1', {
      kind: 'question', id: 'q1',
      question: 'Spark Qwen3.8-Flash-Next bring-up — GO, NVFP4 first, or Hold?',
      options: ['GO', 'NVFP4 first', 'Hold'], ts: 1,
    }]]));
    const res = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q1' }, body: { answer: 'GO — NVFP4 first' } }), res);
    expect(res.body).toEqual({ success: true });
    expect(mockResolveOwnerQuestions).toHaveBeenCalledWith({
      chatId: 's1', userId: 'u1',
      askedQuestion: 'Spark Qwen3.8-Flash-Next bring-up — GO, NVFP4 first, or Hold?',
      answer: 'GO — NVFP4 first',
    });
  });

  it('992c8374: a presence entry for a DIFFERENT live wait skips the auto-resolve', async () => {
    mockGetQuestionPending.mockResolvedValue('s1');
    mockReadConfirmPending.mockResolvedValue(new Map([['s1', {
      kind: 'question', id: 'q-OTHER', question: 'Unrelated question', options: [], ts: 1,
    }]]));
    const res = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q1' }, body: { answer: 'hi' } }), res);
    expect(res.body).toEqual({ success: true });
    expect(mockResolveOwnerQuestions).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * (f) Phase 4 — durable-record fallback (pending key gone → coding:pend rec)
 * ==================================================================== */
describe('postApproval (durable fallback)', () => {
  const PENDING_REC: any = { id: 'a-old', kind: 'approval', sessionId: 's1', fingerprint: 'fp1', detail: 'p', status: 'pending', createdAt: 1 };

  it('no pending key + no record → success:false (the unchanged unknown shape)', async () => {
    const res = mkRes();
    await controller.postApproval(mkReq({ params: { approvalId: 'a-gone' }, body: { decision: 'allow' } }), res);
    expect(res.body).toEqual({ success: false });
    expect(mockLoadDurable).toHaveBeenCalledWith('approval', 'a-gone');
    expect(mockPublishApprovalRes).not.toHaveBeenCalled();
  });

  it('an already-decided record is IDEMPOTENT success (double-click / pre-restart click), nothing republished', async () => {
    mockLoadDurable.mockResolvedValue({ ...PENDING_REC, status: 'answered', resolution: 'always' });
    const res = mkRes();
    await controller.postApproval(mkReq({ params: { approvalId: 'a-old' }, body: { decision: 'deny' } }), res);
    expect(res.body).toEqual({ success: true });
    expect(mockGetSessionForUser).toHaveBeenCalledWith('s1', 'u1', 'owner');
    expect(mockMarkDurable).not.toHaveBeenCalled();
    expect(mockPublishApprovalRes).not.toHaveBeenCalled();
  });

  it('a pending record is marked resolved and delivered to the fingerprint\'s CURRENT id (the re-asked wait)', async () => {
    mockLoadDurable.mockResolvedValue(PENDING_REC);
    mockCurrentIdForFp.mockResolvedValue('a-new');
    const res = mkRes();
    await controller.postApproval(mkReq({ params: { approvalId: 'a-old' }, body: { decision: 'allow' } }), res);
    expect(mockMarkDurable).toHaveBeenCalledWith('approval', 'a-old', 'answered', 'allow');
    expect(mockCurrentIdForFp).toHaveBeenCalledWith('approval', 's1', 'fp1');
    expect(mockPublishApprovalRes).toHaveBeenCalledWith('s1', 'a-new', 'allow');
    expect(res.body).toEqual({ success: true });
  });

  it('a pending record with NO live re-ask publishes the original id (mailbox no-ops; the decision replays later)', async () => {
    mockLoadDurable.mockResolvedValue(PENDING_REC);
    const res = mkRes();
    await controller.postApproval(mkReq({ params: { approvalId: 'a-old' }, body: { decision: 'deny' } }), res);
    expect(mockMarkDurable).toHaveBeenCalledWith('approval', 'a-old', 'denied', 'deny');
    expect(mockPublishApprovalRes).toHaveBeenCalledWith('s1', 'a-old', 'deny');
    expect(res.body).toEqual({ success: true });
  });

  it('an expired record → success:false (same as unknown), nothing written', async () => {
    mockLoadDurable.mockResolvedValue({ ...PENDING_REC, status: 'expired' });
    const res = mkRes();
    await controller.postApproval(mkReq({ params: { approvalId: 'a-old' }, body: { decision: 'allow' } }), res);
    expect(res.body).toEqual({ success: false });
    expect(mockMarkDurable).not.toHaveBeenCalled();
    expect(mockPublishApprovalRes).not.toHaveBeenCalled();
  });

  it('a record owned by someone else → 403, nothing written', async () => {
    mockLoadDurable.mockResolvedValue(PENDING_REC);
    mockGetSessionForUser.mockResolvedValue(null);
    const res = mkRes();
    await controller.postApproval(mkReq({ params: { approvalId: 'a-old' }, body: { decision: 'allow' } }), res);
    expect(res.statusCode).toBe(403);
    expect(mockMarkDurable).not.toHaveBeenCalled();
    expect(mockPublishApprovalRes).not.toHaveBeenCalled();
  });
});

describe('postQuestion (durable fallback)', () => {
  const PENDING_Q: any = { id: 'q-old', kind: 'question', sessionId: 's1', fingerprint: 'fpq', detail: 'q', status: 'pending', createdAt: 1 };

  it('a pending record is marked answered and delivered to the fingerprint\'s CURRENT id', async () => {
    mockLoadDurable.mockResolvedValue(PENDING_Q);
    mockCurrentIdForFp.mockResolvedValue('q-new');
    const res = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q-old' }, body: { answer: 'the answer' } }), res);
    expect(mockMarkDurable).toHaveBeenCalledWith('question', 'q-old', 'answered', 'the answer');
    expect(mockPublishQuestionRes).toHaveBeenCalledWith('s1', 'q-new', 'the answer');
    expect(res.body).toEqual({ success: true });
  });

  it('992c8374: the durable path also auto-resolves the matching flagged owner-question (against the aliased CURRENT id)', async () => {
    mockLoadDurable.mockResolvedValue(PENDING_Q);
    mockCurrentIdForFp.mockResolvedValue('q-new');
    mockReadConfirmPending.mockResolvedValue(new Map([['s1', {
      kind: 'question', id: 'q-new',
      question: 'Spark Qwen3.8-Flash-Next bring-up — GO, NVFP4 first, or Hold?',
      options: ['GO', 'NVFP4 first', 'Hold'], ts: 1,
    }]]));
    const res = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q-old' }, body: { answer: 'the answer' } }), res);
    expect(res.body).toEqual({ success: true });
    expect(mockResolveOwnerQuestions).toHaveBeenCalledWith({
      chatId: 's1', userId: 'u1',
      askedQuestion: 'Spark Qwen3.8-Flash-Next bring-up — GO, NVFP4 first, or Hold?',
      answer: 'the answer',
    });
  });

  it('992c8374: a STALE presence id (not the aliased current id) skips the auto-resolve', async () => {
    mockLoadDurable.mockResolvedValue(PENDING_Q);
    mockCurrentIdForFp.mockResolvedValue('q-new');
    mockReadConfirmPending.mockResolvedValue(new Map([['s1', {
      kind: 'question', id: 'q-old', question: 'Stale presence from before the restart', options: [], ts: 1,
    }]]));
    const res = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q-old' }, body: { answer: 'the answer' } }), res);
    expect(res.body).toEqual({ success: true });
    expect(mockResolveOwnerQuestions).not.toHaveBeenCalled();
  });

  it('an already-answered record is idempotent success; an expired one → success:false', async () => {
    mockLoadDurable.mockResolvedValue({ ...PENDING_Q, status: 'answered', resolution: 'earlier' });
    const res1 = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q-old' }, body: { answer: 'again' } }), res1);
    expect(res1.body).toEqual({ success: true });
    expect(mockPublishQuestionRes).not.toHaveBeenCalled();

    mockLoadDurable.mockResolvedValue({ ...PENDING_Q, status: 'expired' });
    const res2 = mkRes();
    await controller.postQuestion(mkReq({ params: { questionId: 'q-old' }, body: { answer: 'late' } }), res2);
    expect(res2.body).toEqual({ success: false });
    expect(mockMarkDurable).not.toHaveBeenCalled();
  });
});

describe('createFrameWriter — replay/tail batch coalescing (2026-08-27)', () => {
  const { createFrameWriter } = require('./coding-stream.controller');
  const frames = (rows: Array<{ seq: number; type: string; payload: any }>) => {
    const out: string[] = [];
    const w = createFrameWriter((c: string) => out.push(c), 'run-1');
    for (const r of rows) w.writeRow(r);
    w.flush();
    return out;
  };

  it('merges consecutive same-kind delta rows into one frame carrying the LAST seq', () => {
    const out = frames([
      { seq: 1, type: 'text', payload: { delta: 'a' } },
      { seq: 2, type: 'text', payload: { delta: 'b' } },
      { seq: 3, type: 'tool_call', payload: { name: 'x' } },
      { seq: 4, type: 'text', payload: { delta: 'c' } },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('id: run-1:2');
    expect(JSON.parse(out[0].split('data: ')[1]).data.delta).toBe('ab');
    expect(out[1]).toContain('tool_call');
    expect(JSON.parse(out[2].split('data: ')[1]).data.delta).toBe('c');
  });

  it('frames carry the event wall-clock (2026-09-08): a merged block takes its FIRST row\'s createdAt; rows without createdAt carry no ts', () => {
    const out = frames([
      { seq: 1, type: 'text', payload: { delta: 'a' }, createdAt: new Date('2026-09-08T11:19:30.000Z') },
      { seq: 2, type: 'text', payload: { delta: 'b' }, createdAt: new Date('2026-09-08T11:19:31.000Z') },
      { seq: 3, type: 'tool_call', payload: { name: 'x' }, createdAt: new Date('2026-09-08T11:20:00.000Z') },
      { seq: 4, type: 'progress', payload: { message: 'm' } },
    ] as any);
    expect(out).toHaveLength(3);
    expect(JSON.parse(out[0].split('data: ')[1])).toEqual({ type: 'text', data: { delta: 'ab' }, ts: '2026-09-08T11:19:30.000Z' });
    expect(JSON.parse(out[1].split('data: ')[1])).toEqual({ type: 'tool_call', data: { name: 'x' }, ts: '2026-09-08T11:20:00.000Z' });
    expect(JSON.parse(out[2].split('data: ')[1])).toEqual({ type: 'progress', data: { message: 'm' } });
  });

  it('never merges across kinds, and non-delta payload shapes pass through raw (reasoning rows shown — HIDE_REASONING_DISABLED=1)', () => {
    process.env.HIDE_REASONING_DISABLED = '1';
    let out: string[];
    try {
      out = frames([
      { seq: 1, type: 'text', payload: { delta: 'a' } },
      { seq: 2, type: 'reasoning', payload: { delta: 'r' } },
      { seq: 3, type: 'text', payload: { delta: 'x', extra: true } }, // not a pure delta → raw
      ]);
    } finally { delete process.env.HIDE_REASONING_DISABLED; }
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('"delta":"a"');
    expect(out[1]).toContain('"delta":"r"');
    expect(out[2]).toContain('"extra":true');
    expect(out[2]).toContain('id: run-1:3');
  });

  it('stored reasoning rows never replay to a client (2026-10-04, thinking stays on the server)', () => {
    const out = frames([
      { seq: 1, type: 'text', payload: { delta: 'a' } },
      { seq: 2, type: 'reasoning', payload: { delta: 'secret chain of thought' } },
      { seq: 3, type: 'subagent:reasoning', payload: { delta: 'worker thoughts' } },
      { seq: 4, type: 'text', payload: { delta: 'b' } },
    ]);
    expect(out.join('')).not.toMatch(/chain of thought|worker thoughts|"reasoning"/);
    expect(out.join('')).toContain('"delta":"ab"');
  });
});
