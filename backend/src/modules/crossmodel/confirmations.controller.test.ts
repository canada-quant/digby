/**
 * First-class confirmation UX — HTTP surface.
 *  - postChatQuestion: ownership (404 non-owner) → in-process registry resolve
 *    (unknown/expired → success:false, resolved → success:true), and on a local
 *    miss the CROSS-INSTANCE path (2026-08-16): Redis pending key → resolution
 *    mailbox — the run lives on the peer web instance and its heartbeat drains.
 *  - getPendingConfirmations: one (non-archived) chat query + one batched
 *    presence read → { pending: [...] } with chat titles merged in.
 *
 * Boundaries mocked per .digby/notes/learnings.md (config/database and
 * config/redis pull config/env, which exits the process at import): prisma is
 * a stand-in, confirm-pending + question-registry are jest.mock'd seams.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { findFirst: jest.fn(), findMany: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockQuestionSession: jest.Mock = jest.fn();
const mockResolveAnswer: jest.Mock = jest.fn();
jest.mock('./coding/question-registry', () => ({
  questionSession: (...a: any[]) => mockQuestionSession(...a),
  resolveAnswer: (...a: any[]) => mockResolveAnswer(...a),
}));

const mockReadPending: jest.Mock = jest.fn(async () => new Map());
jest.mock('./confirm-pending', () => ({
  readConfirmPendingForChats: (...a: any[]) => mockReadPending(...a),
}));

// Cross-instance seam (dynamically imported on a local-registry miss): the Redis
// pending key + resolution mailbox from the coding module.
const mockGetPendingSession: jest.Mock = jest.fn(async () => null);
const mockPublishResolution: jest.Mock = jest.fn(async () => undefined);
jest.mock('./coding/session-run-lock', () => ({
  getQuestionPendingSession: (...a: any[]) => mockGetPendingSession(...a),
  publishQuestionResolution: (...a: any[]) => mockPublishResolution(...a),
}));

// The DB-persisted consequential-tool registry + the confirmed-execution seam
// (dynamically imported by the confirm handler — mocked here so the ownership /
// one-shot composition is tested without the heavy platform-tools graph).
const mockGetPending: jest.Mock = jest.fn();
const mockListPending: jest.Mock = jest.fn(async () => []);
const mockListExpired: jest.Mock = jest.fn(async () => []);
const mockResolvePending: jest.Mock = jest.fn();
const mockRecordResult: jest.Mock = jest.fn();
const mockResolveIfMoot: jest.Mock = jest.fn(async () => null); // 3ce5f6d0: default never-moot
jest.mock('./platform/pending-confirmations', () => ({
  getPendingConfirmation: (...a: any[]) => mockGetPending(...a),
  listPendingConfirmationsForUser: (...a: any[]) => mockListPending(...a),
  listRecentlyExpiredConfirmationsForUser: (...a: any[]) => mockListExpired(...a),
  resolvePendingConfirmation: (...a: any[]) => mockResolvePending(...a),
  recordConfirmationResult: (...a: any[]) => mockRecordResult(...a),
  resolveConfirmationIfMoot: (...a: any[]) => mockResolveIfMoot(...a),
}));

// The "Needs owner" persistent-inbox store (ticket 7705fec2) + the 992c8374
// decision-card coherence seam (a card answer auto-resolves the matching flag).
const mockListOwnerQuestions: jest.Mock = jest.fn(async () => []);
const mockAnswerOwnerQuestion: jest.Mock = jest.fn(async () => 'ok');
const mockDismissOwnerQuestion: jest.Mock = jest.fn(async () => 'ok');
const mockResolveOwnerQuestions: jest.Mock = jest.fn(async () => ({ resolved: 0, ids: [] }));
jest.mock('./platform/owner-questions', () => ({
  listOpenOwnerQuestionsForUser: (...a: any[]) => mockListOwnerQuestions(...a),
  answerOwnerQuestion: (...a: any[]) => mockAnswerOwnerQuestion(...a),
  dismissOwnerQuestion: (...a: any[]) => mockDismissOwnerQuestion(...a),
  resolveOwnerQuestionsForChatAnswer: (...a: any[]) => mockResolveOwnerQuestions(...a),
  // N3 typed options: the REAL tolerant parser (pure — its module's only
  // static import is node:crypto).
  parseStoredOptions: jest.requireActual('./platform/owner-questions').parseStoredOptions,
}));

const mockExecConfirmed: jest.Mock = jest.fn();
jest.mock('./platform/platform-tools', () => ({
  executeConfirmedPlatformTool: (...a: any[]) => mockExecConfirmed(...a),
}));

// The receipt writer (review 2026-09-25): the card path mints the execution's
// run_tool_receipts row. extractReceipt stays REAL (dependency-free leaf).
const mockRecordReceipt: jest.Mock = jest.fn();
jest.mock('./coding/run-receipts.service', () => ({
  recordRunReceiptAsync: (...a: any[]) => mockRecordReceipt(...a),
}));

import controller from './confirmations.controller';

const mkReq = (over: any = {}): any => ({
  params: { chatId: 'c1', questionId: 'q-1' },
  body: { answer: 'use staging' },
  user: { id: 'u1' },
  ...over,
});
const mkRes = (): any => {
  const res: any = {
    statusCode: 200,
    body: undefined as any,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((b: any) => { res.body = b; return res; }),
  };
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'c1' });
  mockQuestionSession.mockReturnValue('c1');
  mockResolveAnswer.mockReturnValue(true);
  mockReadPending.mockResolvedValue(new Map()); // clearAllMocks keeps prior mockResolvedValue — reset the default
  mockListPending.mockResolvedValue([]);
  mockListExpired.mockResolvedValue([]);
  mockResolvePending.mockResolvedValue(true);
  mockRecordResult.mockResolvedValue(undefined);
  mockExecConfirmed.mockResolvedValue('done: cancelled sch1');
});

describe('postChatQuestion', () => {
  it('resolves a pending question in-process → { success: true }', async () => {
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith({ where: { id: 'c1', userId: 'u1' }, select: { id: true } });
    expect(mockResolveAnswer).toHaveBeenCalledWith('q-1', 'use staging');
    expect(res.body).toEqual({ success: true });
  });

  it('unknown/expired question (registry miss) → { success: false, error: unknown_or_expired }', async () => {
    mockQuestionSession.mockReturnValue(null); // not awaiting anywhere
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(mockResolveAnswer).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'unknown_or_expired' });
  });

  it('a question owned by ANOTHER chat is unknown here (no cross-chat resolve)', async () => {
    mockQuestionSession.mockReturnValue('c2');
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(mockResolveAnswer).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'unknown_or_expired' });
  });

  it('cross-instance: local registry miss + Redis pending key for THIS chat → mailbox publish + success', async () => {
    mockQuestionSession.mockReturnValue(null); // run lives on the peer web instance
    mockGetPendingSession.mockResolvedValue('c1');
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(mockResolveAnswer).not.toHaveBeenCalled(); // nothing local to resolve
    expect(mockPublishResolution).toHaveBeenCalledWith('c1', 'q-1', 'use staging');
    expect(res.body).toEqual({ success: true });
  });

  it('cross-instance: Redis pending key belongs to ANOTHER chat → unknown, nothing published', async () => {
    mockQuestionSession.mockReturnValue(null);
    mockGetPendingSession.mockResolvedValue('c2');
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(mockPublishResolution).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'unknown_or_expired' });
  });

  it('a resolve race (registered but already resolved) → success:false', async () => {
    mockResolveAnswer.mockReturnValue(false);
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(res.body).toEqual({ success: false, error: 'unknown_or_expired' });
  });

  it('non-owner → 404 (no existence leak), registry never touched', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(res.statusCode).toBe(404);
    expect(mockQuestionSession).not.toHaveBeenCalled();
  });

  it('missing/blank answer → 400; unauthenticated → 401', async () => {
    const res400 = mkRes();
    await controller.postChatQuestion(mkReq({ body: { answer: '   ' } }), res400);
    expect(res400.statusCode).toBe(400);
    const res401 = mkRes();
    await controller.postChatQuestion(mkReq({ user: undefined }), res401);
    expect(res401.statusCode).toBe(401);
  });

  // Ticket 992c8374 (2026-09-05 "the card won't dismiss" incident): an answer
  // on the in-chat ask_user decision card must also close the matching flagged
  // owner-question — otherwise the fleet-attention block re-lists it every
  // wake and the supervisor re-asks a decision the owner already answered.
  const SPARK_ASK = 'Spark Qwen3.8-Flash-Next bring-up — GO, NVFP4 first, or Hold?';
  const sparkPresence = () => new Map([['c1', {
    kind: 'question', id: 'q-1', question: SPARK_ASK, options: ['GO', 'NVFP4 first', 'Hold'], ts: 1,
  }]]);

  it('992c8374: a resolved card answer auto-resolves the matching flagged owner-question', async () => {
    mockReadPending.mockResolvedValue(sparkPresence() as any);
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(res.body).toEqual({ success: true });
    expect(mockResolveOwnerQuestions).toHaveBeenCalledWith({
      chatId: 'c1', userId: 'u1', askedQuestion: SPARK_ASK, answer: 'use staging',
    });
  });

  it('992c8374: the cross-instance success path auto-resolves it too', async () => {
    mockQuestionSession.mockReturnValue(null); // run lives on the peer web instance
    mockGetPendingSession.mockResolvedValue('c1');
    mockReadPending.mockResolvedValue(sparkPresence() as any);
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(mockPublishResolution).toHaveBeenCalledWith('c1', 'q-1', 'use staging');
    expect(res.body).toEqual({ success: true });
    expect(mockResolveOwnerQuestions).toHaveBeenCalledWith({
      chatId: 'c1', userId: 'u1', askedQuestion: SPARK_ASK, answer: 'use staging',
    });
  });

  it('992c8374: a FAILED resolve never touches the flagged questions', async () => {
    mockResolveAnswer.mockReturnValue(false); // resolve race — already resolved
    mockReadPending.mockResolvedValue(sparkPresence() as any);
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(res.body).toEqual({ success: false, error: 'unknown_or_expired' });
    expect(mockResolveOwnerQuestions).not.toHaveBeenCalled();
  });

  it('992c8374: a presence entry for a DIFFERENT wait leaves the match text empty', async () => {
    mockReadPending.mockResolvedValue(new Map([['c1', {
      kind: 'question', id: 'q-OTHER', question: 'Unrelated question', options: [], ts: 1,
    }]]) as any);
    const res = mkRes();
    await controller.postChatQuestion(mkReq(), res);
    expect(res.body).toEqual({ success: true });
    expect(mockResolveOwnerQuestions).toHaveBeenCalledWith({
      chatId: 'c1', userId: 'u1', askedQuestion: '', answer: 'use staging',
    });
  });
});

describe('getPendingConfirmations', () => {
  it('aggregates confirm:pending entries over the user\'s non-archived chats', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([
      { id: 'c1', title: 'Deploy chat' },
      { id: 'c2', title: 'Side project' },
      { id: 'c3', title: 'Idle chat' },
    ]);
    mockReadPending.mockResolvedValue(new Map([
      ['c1', { kind: 'question', id: 'q-1', question: 'Which environment?', options: ['staging', 'prod'], ts: 100 }],
      ['c2', { kind: 'approval', id: 'a-2', question: 'Allow delete_chat?', options: ['allow', 'always', 'deny'], tool: 'delete_chat', ts: 200 }],
    ]));
    const res = mkRes();
    await controller.getPendingConfirmations(mkReq({ params: {} }), res);
    // Non-archived = neither the chat-level archivedAt stamp (owner 2026-09-08)
    // nor the coding-satellite 'archived' status (reaper-parked sessions).
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', archivedAt: null, NOT: { codingState: { status: 'archived' } } },
      select: { id: true, title: true },
    });
    expect(mockReadPending).toHaveBeenCalledWith(['c1', 'c2', 'c3']);
    expect(res.body).toEqual({
      pending: [
        { chatId: 'c1', title: 'Deploy chat', kind: 'question', id: 'q-1', question: 'Which environment?', options: ['staging', 'prod'], ts: 100 },
        { chatId: 'c2', title: 'Side project', kind: 'approval', id: 'a-2', question: 'Allow delete_chat?', options: ['allow', 'always', 'deny'], tool: 'delete_chat', ts: 200 },
      ],
    });
  });

  it('nothing pending → { pending: [] }', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c1', title: 't' }]);
    const res = mkRes();
    await controller.getPendingConfirmations(mkReq({ params: {} }), res);
    expect(res.body).toEqual({ pending: [] });
  });

  it('a live staged action maps to a Confirm/Cancel card; a STALE one stays listed with Dismiss + stale:true (7705fec2)', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c1', title: 'Deploy chat' }]);
    mockListPending.mockResolvedValue([
      {
        id: 'cf-live', chatId: 'c1', tool: 'send_chat_message', summary: 'Send a nudge',
        createdAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 60_000), status: 'pending',
      },
      {
        id: 'cf-stale', chatId: 'c1', tool: 'schedule_message', summary: 'Schedule: nightly digest',
        createdAt: new Date(1000), expiresAt: new Date(Date.now() - 60_000), status: 'pending',
      },
    ]);
    const res = mkRes();
    await controller.getPendingConfirmations(mkReq({ params: {} }), res);
    const byId = new Map(res.body.pending.map((p: any) => [p.id, p]));
    expect(byId.get('cf-live')).toMatchObject({ kind: 'confirmation', options: ['Confirm', 'Cancel'] });
    expect(byId.get('cf-live')).not.toHaveProperty('stale');
    // The stale card PERSISTS in the listing (never vanishes on a timer) but
    // is not confirmable — the client renders Dismiss + a re-stage hint.
    expect(byId.get('cf-stale')).toMatchObject({ kind: 'confirmation', options: ['Dismiss'], stale: true });
  });

  it('recently-expired staged actions surface as non-actionable expired traces (f789d84e)', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c1', title: 'Deploy chat' }]);
    mockListExpired.mockResolvedValue([{
      id: 'cf-9', chatId: 'c1', tool: 'schedule_message', summary: 'Schedule: nightly digest',
      createdAt: new Date(1000), expiresAt: new Date(2000), status: 'expired',
    }]);
    const res = mkRes();
    await controller.getPendingConfirmations(mkReq({ params: {} }), res);
    expect(res.body).toEqual({
      pending: [{
        chatId: 'c1', title: 'Deploy chat', kind: 'confirmation', id: 'cf-9',
        question: 'Schedule: nightly digest', options: [], tool: 'schedule_message',
        ts: 1000, expiresAt: 2000, expired: true,
      }],
    });
  });

  it('open owner questions merge in as never-expiring owner_question entries (7705fec2)', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c1', title: 'Fleet Supervisor' }]);
    mockListOwnerQuestions.mockResolvedValue([{
      id: 'oq-1', chatId: 'c1', question: 'Approve the cadence change?', createdAt: new Date(3000),
    }]);
    const res = mkRes();
    await controller.getPendingConfirmations(mkReq({ params: {} }), res);
    expect(res.body).toEqual({
      pending: [{
        chatId: 'c1', title: 'Fleet Supervisor', kind: 'owner_question', id: 'oq-1',
        question: 'Approve the cadence change?', options: [], ts: 3000,
      }],
    });
  });

  it("the Decisions rail lists rows in supervisor triage WITH a triaged marker + deadline (owner 2026-09-18: 'chats say waiting for me but my inbox is empty')", async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c1', title: 'Kernel lane' }]);
    mockListOwnerQuestions.mockResolvedValue([
      { id: 'oq-t', chatId: 'c1', question: 'Scale out to 3 boxes?', createdAt: new Date(5000), triaged: true, triageUntil: new Date(9000) },
      { id: 'oq-s', chatId: 'c1', question: 'Surfaced one', createdAt: new Date(6000), triaged: false },
    ]);
    const res = mkRes();
    await controller.getPendingConfirmations(mkReq({ params: {} }), res);
    // The listing is asked for the triaged rows too (includeTriaged) — the
    // marker travels to the client, which renders them muted and keeps them
    // out of the needs-you count.
    expect(mockListOwnerQuestions).toHaveBeenCalledTimes(1);
    expect(mockListOwnerQuestions).toHaveBeenCalledWith('u1', { includeTriaged: true });
    expect(res.body).toEqual({
      pending: [
        { chatId: 'c1', title: 'Kernel lane', kind: 'owner_question', id: 'oq-t', question: 'Scale out to 3 boxes?', options: [], ts: 5000, triaged: true, triageUntil: 9000 },
        { chatId: 'c1', title: 'Kernel lane', kind: 'owner_question', id: 'oq-s', question: 'Surfaced one', options: [], ts: 6000 },
      ],
    });
  });

  it('typed owner-question options render numbered in the question + as tappable option labels (remediation P2 N3)', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c1', title: 'Fleet Supervisor' }]);
    mockListOwnerQuestions.mockResolvedValue([{
      id: 'oq-2', chatId: 'c1', question: 'GO on the Machete swap?', createdAt: new Date(4000),
      options: [{ id: 'go', label: 'GO', consequence: 'swap runs now' }, { id: 'hold', label: 'Hold' }],
    }]);
    const res = mkRes();
    await controller.getPendingConfirmations(mkReq({ params: {} }), res);
    const entry = res.body.pending[0];
    expect(entry.options).toEqual(['GO', 'Hold']);
    expect(entry.question).toContain('GO on the Machete swap?');
    expect(entry.question).toContain('1. GO — swap runs now');
    expect(entry.question).toContain('2. Hold');
  });

  it('unauthenticated → 401', async () => {
    const res = mkRes();
    await controller.getPendingConfirmations(mkReq({ params: {}, user: undefined }), res);
    expect(res.statusCode).toBe(401);
  });
});

describe('postConfirmationConfirm (DB-persisted staged actions)', () => {
  const mkRow = (over: any = {}): any => ({
    id: 'cf_1', userId: 'u1', chatId: 'c1', tool: 'cancel_schedule',
    args: { id: 'sch1' }, summary: 'Cancel schedule sch1', status: 'pending',
    createdAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 60_000),
    resolvedAt: null, result: null, ...over,
  });

  it('owner + pending → one-shot consume → executes the STORED args (never client input) → records the result', async () => {
    mockGetPending.mockResolvedValue(mkRow());
    const res = mkRes();
    // A malicious client body tries to substitute different args — ignored.
    await controller.postConfirmationConfirm(
      mkReq({ params: { confirmationId: 'cf_1' }, body: { args: { id: 'EVIL' } } }), res);
    expect(mockResolvePending).toHaveBeenCalledWith('cf_1', 'consumed');
    expect(mockExecConfirmed).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', sessionId: 'c1' }),
      'cancel_schedule',
      { id: 'sch1' },
    );
    expect(mockRecordResult).toHaveBeenCalledWith('cf_1', expect.objectContaining({ output: expect.any(String) }));
    expect(res.body).toEqual({ success: true, result: expect.any(String) });
  });

  it('unknown id → 404 (no existence leak); another user\'s row → 404, never consumed', async () => {
    mockGetPending.mockResolvedValue(null);
    const res404 = mkRes();
    await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_nope' } }), res404);
    expect(res404.statusCode).toBe(404);
    mockGetPending.mockResolvedValue(mkRow({ userId: 'u2' }));
    const resCross = mkRes();
    await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), resCross);
    expect(resCross.statusCode).toBe(404);
    expect(mockResolvePending).not.toHaveBeenCalled();
    expect(mockExecConfirmed).not.toHaveBeenCalled();
  });

  it('an already-resolved row → { success: false, error: already_resolved } without re-consuming', async () => {
    mockGetPending.mockResolvedValue(mkRow({ status: 'cancelled' }));
    const res = mkRes();
    await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), res);
    expect(res.body).toEqual({ success: false, error: 'already_resolved' });
    expect(mockResolvePending).not.toHaveBeenCalled();
  });

  it('an expired row flips to expired → { success: false, error: expired }, never executed', async () => {
    mockGetPending.mockResolvedValue(mkRow({ expiresAt: new Date(Date.now() - 1000) }));
    const res = mkRes();
    await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), res);
    expect(mockResolvePending).toHaveBeenCalledWith('cf_1', 'expired');
    expect(mockExecConfirmed).not.toHaveBeenCalled();
    expect(res.body).toEqual({ success: false, error: 'expired' });
  });

  it('losing the one-shot race (a simultaneous model re-call won) → already_resolved, never executed twice', async () => {
    mockGetPending.mockResolvedValue(mkRow());
    mockResolvePending.mockResolvedValue(false); // the conditional flip found status != pending
    const res = mkRes();
    await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), res);
    expect(res.body).toEqual({ success: false, error: 'already_resolved' });
    expect(mockExecConfirmed).not.toHaveBeenCalled();
  });

  it('an execution failure is recorded as failed and surfaced (not misreported as already_resolved)', async () => {
    mockGetPending.mockResolvedValue(mkRow());
    mockExecConfirmed.mockRejectedValue(new Error('schedule service down'));
    const res = mkRes();
    await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), res);
    expect(mockRecordResult).toHaveBeenCalledWith('cf_1', { error: 'schedule service down' }, true);
    expect(res.body).toEqual({ success: false, error: 'schedule service down' });
  });

  it('unauthenticated → 401', async () => {
    const res = mkRes();
    await controller.postConfirmationConfirm(
      mkReq({ params: { confirmationId: 'cf_1' }, user: undefined }), res);
    expect(res.statusCode).toBe(401);
    expect(mockGetPending).not.toHaveBeenCalled();
  });

  describe('the card execution mints the run_tool_receipts row the agent loop would have (review 2026-09-25)', () => {
    const envelope = JSON.stringify({ ok: true, tool: 'pause_schedule', ids: { scheduleId: 'sch1', chatId: 'c-lane' }, changed: true, enabled: false });

    it('success → ok:true receipt on the staging chat, runId null, ids = the envelope ids + {confirmationId, ownerConfirmed}', async () => {
      mockGetPending.mockResolvedValue(mkRow({ tool: 'pause_schedule', args: { id: 'sch1' } }));
      mockExecConfirmed.mockResolvedValue(envelope);
      const res = mkRes();
      await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), res);
      expect(res.body).toEqual({ success: true, result: expect.any(String) });
      expect(mockRecordReceipt).toHaveBeenCalledTimes(1);
      const r = mockRecordReceipt.mock.calls[0][0];
      expect(r).toMatchObject({
        chatId: 'c1', runId: null, tool: 'pause_schedule', ok: true,
        ids: { scheduleId: 'sch1', chatId: 'c-lane', confirmationId: 'cf_1', ownerConfirmed: true },
      });
      expect(typeof r.id).toBe('string');
      expect(r.id.length).toBeGreaterThanOrEqual(32);
      expect(r.inputHash).toEqual(expect.any(String));
      expect(r.outputHash).toEqual(expect.any(String));
      expect(r.createdAt).toBeInstanceOf(Date);
      // The staged row's own marker never leaks onto the executed row.
      expect(r.ids.staged).toBeUndefined();
    });

    it('a thrown execution → ok:false receipt (the failure is visible, never a phantom success)', async () => {
      mockGetPending.mockResolvedValue(mkRow({ tool: 'stop_run', args: { chatId: 'c-lane' } }));
      mockExecConfirmed.mockRejectedValue(new Error('run-state down'));
      const res = mkRes();
      await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), res);
      expect(res.body).toEqual({ success: false, error: 'run-state down' });
      expect(mockRecordReceipt).toHaveBeenCalledTimes(1);
      expect(mockRecordReceipt.mock.calls[0][0]).toMatchObject({ chatId: 'c1', runId: null, tool: 'stop_run', ok: false, ids: { confirmationId: 'cf_1', ownerConfirmed: true } });
    });

    it('a non-receipt tool leaves no row; an anon- chat is skipped (no FK target)', async () => {
      mockGetPending.mockResolvedValue(mkRow({ tool: 'set_chat_instructions_not_a_receipt_tool', args: {} }));
      await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), mkRes());
      expect(mockRecordReceipt).not.toHaveBeenCalled();

      mockExecConfirmed.mockResolvedValue(envelope);
      mockGetPending.mockResolvedValue(mkRow({ tool: 'pause_schedule', args: { id: 'sch1' }, chatId: 'anon-abc' }));
      await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), mkRes());
      expect(mockRecordReceipt).not.toHaveBeenCalled();
    });

    // WP-3 (backlog 2026-11-03, todo 52050bfb; review 66007a6e advisory A5):
    // the web-probe receipt class is COLLECTOR-ONLY. The agent seam skips
    // recordRunReceiptAsync for it (agent.ts:6262-6270); this controller is the
    // ONE other writer, so a hypothetical future stageable web tool must NOT
    // start writing run_tool_receipts rows from the card path. LATENT seam —
    // unreachable today (web tools execute read-only, never confirmation-staged).
    it('WP-3 — a hypothetical stageable WEB tool mints no row (collector-only invariant)', async () => {
      for (const webTool of ['scrape_as_markdown', 'search_engine', 'web_pipe', 'youtube_pipe', 'scrape_batch']) {
        mockRecordReceipt.mockClear();
        mockGetPending.mockResolvedValue(mkRow({ tool: webTool, args: { url: 'https://example.com/' } }));
        mockExecConfirmed.mockResolvedValue('page body');
        const res = mkRes();
        await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), res);
        // The card still EXECUTES and answers normally — only the row is skipped.
        expect(res.body).toEqual({ success: true, result: expect.any(String) });
        expect(mockRecordReceipt).not.toHaveBeenCalled();
      }
      // Control: a real receipt tool on the same path still mints exactly one row
      // (the skip must be class-scoped, not a blanket regression).
      mockRecordReceipt.mockClear();
      mockGetPending.mockResolvedValue(mkRow({ tool: 'pause_schedule', args: { id: 'sch1' } }));
      mockExecConfirmed.mockResolvedValue(envelope);
      await controller.postConfirmationConfirm(mkReq({ params: { confirmationId: 'cf_1' } }), mkRes());
      expect(mockRecordReceipt).toHaveBeenCalledTimes(1);
    });
  });
});

describe('postConfirmationCancel', () => {
  const mkRow = (over: any = {}): any => ({
    id: 'cf_1', userId: 'u1', chatId: 'c1', tool: 'cancel_schedule',
    args: { id: 'sch1' }, summary: 's', status: 'pending',
    createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    resolvedAt: null, result: null, ...over,
  });

  it('owner cancels → row flipped to cancelled → { success: true }', async () => {
    mockGetPending.mockResolvedValue(mkRow());
    const res = mkRes();
    await controller.postConfirmationCancel(mkReq({ params: { confirmationId: 'cf_1' } }), res);
    expect(mockResolvePending).toHaveBeenCalledWith('cf_1', 'cancelled');
    expect(res.body).toEqual({ success: true });
  });

  it('another user\'s row → 404, never cancelled', async () => {
    mockGetPending.mockResolvedValue(mkRow({ userId: 'u2' }));
    const res = mkRes();
    await controller.postConfirmationCancel(mkReq({ params: { confirmationId: 'cf_1' } }), res);
    expect(res.statusCode).toBe(404);
    expect(mockResolvePending).not.toHaveBeenCalled();
  });

  it('losing the race → { success: false, error: already_resolved }', async () => {
    mockGetPending.mockResolvedValue(mkRow());
    mockResolvePending.mockResolvedValue(false);
    const res = mkRes();
    await controller.postConfirmationCancel(mkReq({ params: { confirmationId: 'cf_1' } }), res);
    expect(res.body).toEqual({ success: false, error: 'already_resolved' });
  });

  it('unauthenticated → 401', async () => {
    const res = mkRes();
    await controller.postConfirmationCancel(
      mkReq({ params: { confirmationId: 'cf_1' }, user: undefined }), res);
    expect(res.statusCode).toBe(401);
    expect(mockGetPending).not.toHaveBeenCalled();
  });
});

describe('postOwnerQuestionAnswer / postOwnerQuestionDismiss (ticket 7705fec2 — "Needs owner" inbox)', () => {
  it('empty answer → 400', async () => {
    const res = mkRes();
    await controller.postOwnerQuestionAnswer(
      mkReq({ params: { id: 'oq_1' }, body: { answer: '   ' } }), res);
    expect(res.statusCode).toBe(400);
    expect(mockAnswerOwnerQuestion).not.toHaveBeenCalled();
  });

  it('owner answer → success, service scoped to (id, userId)', async () => {
    const res = mkRes();
    await controller.postOwnerQuestionAnswer(
      mkReq({ params: { id: 'oq_1' }, body: { answer: 'yes, ship it' } }), res);
    // Ticket ad4fae90: the paste-intent flag rides the call (false when the
    // request did not set credentialPaste — a plain text answer).
    expect(mockAnswerOwnerQuestion).toHaveBeenCalledWith('oq_1', 'u1', 'yes, ship it', { credentialPaste: false });
    expect(res.body).toEqual({ success: true });
  });

  it('credentialPaste: true rides the service call (ticket ad4fae90 — the card secret input)', async () => {
    const res = mkRes();
    await controller.postOwnerQuestionAnswer(
      mkReq({ params: { id: 'oq_1' }, body: { answer: 'stg_live_9f8e7d6c5b4a3210fedcba98', credentialPaste: true } }), res);
    expect(mockAnswerOwnerQuestion).toHaveBeenCalledWith('oq_1', 'u1', 'stg_live_9f8e7d6c5b4a3210fedcba98', { credentialPaste: true });
    expect(res.body).toEqual({ success: true });
  });

  it('unknown/other-user question → 404', async () => {
    mockAnswerOwnerQuestion.mockResolvedValue('not_found');
    const res = mkRes();
    await controller.postOwnerQuestionAnswer(
      mkReq({ params: { id: 'oq_1' }, body: { answer: 'x' } }), res);
    expect(res.statusCode).toBe(404);
  });

  it('already resolved → { success: false, error: not_open }', async () => {
    mockAnswerOwnerQuestion.mockResolvedValue('not_open');
    const res = mkRes();
    await controller.postOwnerQuestionAnswer(
      mkReq({ params: { id: 'oq_1' }, body: { answer: 'x' } }), res);
    expect(res.body).toEqual({ success: false, error: 'not_open' });
  });

  it('todo 0dd7d3f2: reply_recorded (choice/yes_no mismatch) → its OWN error code, never credential_pending', async () => {
    // Specimen oq_17b85b72: a typed reply on a CHOICE card showed the owner
    // the credential banner ("needs a credential, not a text answer") because
    // the controller mapped the mismatch return to the same code. The card
    // surfaces branch on error — reply_recorded must stay distinct so the
    // Inbox toasts "sent as a reply" and clears the draft.
    mockAnswerOwnerQuestion.mockResolvedValue('reply_recorded');
    const res = mkRes();
    await controller.postOwnerQuestionAnswer(
      mkReq({ params: { id: 'oq_1' }, body: { answer: 'here is why: the console said 502' } }), res);
    expect(res.body).toEqual({
      success: false,
      error: 'reply_recorded',
      // 2026-10-20: the message covers the credential card too (its WORDS
      // answer the same code now — the lane is woken; the key still has to
      // land through the key field).
      // 2026-10-21 (ticket c1714329): the wake now fires on a choice/yes_no
      // card too — the message finally tells the truth on every typed gate.
      message: 'Sent to the chat as a reply — the asking chat is being woken with it (ticket c1714329): the reply is delivered and the lane acts on any instruction in your words, even though the card stays open until it gets the answer shape it declared: an option pick, a yes/no ruling, or the key through the key field, which you can do right on the card.',
    });
  });

  it('credential_pending stays its own code (the credential branch is unchanged — todo 0dd7d3f2 regression pin)', async () => {
    mockAnswerOwnerQuestion.mockResolvedValue('credential_pending');
    const res = mkRes();
    await controller.postOwnerQuestionAnswer(
      mkReq({ params: { id: 'oq_1' }, body: { answer: 'yes public' } }), res);
    expect(res.body.error).toBe('credential_pending');
    expect(res.body.message).toContain('needs a credential');
    expect(res.body.success).toBe(false);
  });

  it('ticket 238c9e2a: the credential_pending toast names ALL three lift channels — the card key field too, never store_secret-only', async () => {
    // The pre-fix toast said "(store_secret / Account → Coding credentials)"
    // — 2 of 3 channels, missing the card's own key field, the fastest lift
    // for the owner already looking at the card. Mirrors ccc2e7ad's
    // canonical channel list (PR #1851).
    mockAnswerOwnerQuestion.mockResolvedValue('credential_pending');
    const res = mkRes();
    await controller.postOwnerQuestionAnswer(
      mkReq({ params: { id: 'oq_1' }, body: { answer: 'yes public' } }), res);
    expect(res.body.error).toBe('credential_pending');
    // All three channels, in the owner-facing message.
    expect(res.body.message).toContain("the card's key field, store_secret or Account → Coding credentials");
    // The 2-of-3 fragment is gone.
    expect(res.body.message).not.toContain('store_secret / Account → Coding credentials');
    expect(res.body.success).toBe(false);
  });

  it('dismiss → success; unauthenticated → 401', async () => {
    const res = mkRes();
    await controller.postOwnerQuestionDismiss(mkReq({ params: { id: 'oq_1' } }), res);
    expect(mockDismissOwnerQuestion).toHaveBeenCalledWith('oq_1', 'u1');
    expect(res.body).toEqual({ success: true });
    const res2 = mkRes();
    await controller.postOwnerQuestionDismiss(mkReq({ params: { id: 'oq_1' }, user: undefined }), res2);
    expect(res2.statusCode).toBe(401);
  });
});
