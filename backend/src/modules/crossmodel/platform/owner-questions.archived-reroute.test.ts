/**
 * ARCHIVED-TARGET-RETIRE (c, 2026-10-20) — an owner resolution whose asking
 * lane is ARCHIVED is re-routed to the lane's inheriting supervisor (the
 * project's supervisor lane, else the Fleet Supervisor) with the question, the
 * answer and the archived lane id — and NO durable retry is armed onto the
 * archived chat (before: every answer to an archived lane armed a 24 h retry
 * row that the sweeper refused every ~3 min).
 *
 * Harness copied from owner-questions.remediation-p2.test.ts; the leaf
 * (archived-target-retire.ts) is REAL and reads the mocked chat table.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-characters-long!!';

const mockQuestions = createOwnerQuestionTable();
const mockChatFindUnique: jest.Mock = jest.fn(async (): Promise<any> => undefined);
const mockChatFindFirst: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockChatFindMany: jest.Mock = jest.fn(async (): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    ownerQuestionSecret: mockQuestions.ownerQuestionSecret,
    activity: mockQuestions.activity,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: {
      ...mockQuestions.crossModelChat,
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      findFirst: (...a: any[]) => mockChatFindFirst(...a),
      findMany: (...a: any[]) => mockChatFindMany(...a),
    },
    telegramLink: { findUnique: jest.fn(async () => null) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async (): Promise<number | null> => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
const mockArmRetry: jest.Mock = jest.fn(async () => ({ ok: true, scheduleId: 'sched-retry-1' }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
  armOwnerAnswerRetrySchedule: (...a: any[]) => mockArmRetry(...a),
}));

jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: jest.fn(async () => true),
}));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: jest.fn(async () => {}),
  appendOwnerRulingDirective: jest.fn(async () => ({ appended: false })),
}));
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: jest.fn(async () => ({ todos: 0, goals: 0 })),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k).toLowerCase() }),
}));

import { flagOwnerQuestion, answerOwnerQuestion, dismissOwnerQuestion, applyDefaultAnswerIfDue } from './owner-questions';

const flush = () => new Promise((r) => setImmediate(r));

/** The chat world: the asking lane (archived or not), its project supervisor and the Fleet Supervisor. */
function world(opts: { laneArchived: boolean; ps?: string | null; fs?: string | null }) {
  mockChatFindFirst.mockImplementation(async ({ where }: any) => {
    if (where?.isProjectSupervisor) return opts.ps && where.projectId === 'proj-1' ? { id: opts.ps } : null;
    if (where?.isSupervisor) return opts.fs ? { id: opts.fs } : null;
    if (where?.id === 'chat-1') {
      return { id: 'chat-1', userId: 'u1', projectId: 'proj-1', title: 'Spark lane', archivedAt: opts.laneArchived ? new Date('2026-10-19T09:00:00Z') : null, codingState: { status: opts.laneArchived ? 'archived' : 'ready' } };
    }
    return null;
  });
  // The archived lane refuses every machine wake ('archived'); supervisors start.
  mockFireScheduleTarget.mockImplementation(async ({ sessionId }: any) =>
    (sessionId === 'chat-1' && opts.laneArchived ? { started: false, reason: 'archived' } : { started: true }));
}

const flag = (over: Partial<Parameters<typeof flagOwnerQuestion>[0]> = {}) =>
  flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Which region should we deploy to?', ...over });

beforeEach(() => {
  delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED;
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockReset().mockResolvedValue(null);
  mockRefundDailyCapToken.mockReset().mockResolvedValue(undefined);
  mockArmRetry.mockReset().mockResolvedValue({ ok: true, scheduleId: 'sched-retry-1' });
  mockChatFindUnique.mockReset().mockResolvedValue({ userId: 'u1' });
  mockChatFindFirst.mockReset().mockResolvedValue(null);
  mockChatFindMany.mockReset().mockResolvedValue([]);
  mockRecordLoopMetric.mockReset();
});
afterAll(() => { delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED; });

describe('ARCHIVED-TARGET-RETIRE (c) — owner answer to an archived lane', () => {
  it('re-routes the wake to the PROJECT supervisor carrying the question, the answer and the archived lane id — no retry armed onto the archived chat', async () => {
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'ca-central-1')).toBe('ok');

    const calls = mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.sessionId)).toEqual(['chat-1', 'ps-1']);
    // (f) both wakes are the owner_answer surface.
    expect(calls.every((c: any) => c.origin === 'hook' && c.dispatchSurface === 'owner_answer')).toBe(true);
    const rerouted = calls[1].prompt as string;
    expect(rerouted).toMatch(/^\[Owner inbox — RE-ROUTED to the project supervisor: the asking lane "Spark lane" \(chat-1\) is ARCHIVED\]/);
    expect(rerouted).toContain(`for question ${r.question.id}`);
    expect(rerouted).toContain('Which region should we deploy to?');
    expect(rerouted).toContain('ca-central-1');
    expect(rerouted).toContain('--- original wake for lane chat-1 ---');
    expect(mockArmRetry).not.toHaveBeenCalled();
    expect(mockRefundDailyCapToken).toHaveBeenCalledWith('chat-1');
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'archived_target_retire', sessionId: 'chat-1',
      meta: expect.objectContaining({ surface: 'owner_answer', action: 'rerouted', outcome: 'rerouted', targetChatId: 'ps-1', tier: 'project', questionId: r.question.id }),
    }));
  });

  it('no project supervisor → the Fleet Supervisor inherits; a busy supervisor arms its retry on the SUPERVISOR, never the archived lane', async () => {
    world({ laneArchived: true, ps: null, fs: 'fs-1' });
    mockFireScheduleTarget.mockImplementation(async ({ sessionId }: any) =>
      (sessionId === 'chat-1' ? { started: false, reason: 'archived' } : { started: false, reason: 'busy' }));
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    expect(mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0].sessionId)).toEqual(['chat-1', 'fs-1']);
    expect(mockFireScheduleTarget.mock.calls[1][0].prompt).toContain('RE-ROUTED to the Fleet Supervisor');
    expect(mockArmRetry).toHaveBeenCalledTimes(1);
    expect(mockArmRetry.mock.calls[0][0]).toMatchObject({ sessionId: 'fs-1', marker: `[owner-answer-retry:${r.question.id}]` });
    expect(mockArmRetry.mock.calls[0][0].prompt).toContain('RE-ROUTED');
  });

  it('a DISMISSAL of an archived lane\'s card is DROPPED — no supervisor wake, no retry (review: a supervisor\'s own dismissal sweep used to echo back as one retry row per card)', async () => {
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(r.question.id, 'u1', { dismissedBy: 'supervisor' })).toBe('ok');
    expect(mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0].sessionId)).toEqual(['chat-1']);
    expect(mockArmRetry).not.toHaveBeenCalled();
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'archived_target_retire', sessionId: 'chat-1',
      meta: expect.objectContaining({ surface: 'owner_answer', action: 'dropped', outcome: 'dismissal_dropped', seam: 'wake', questionId: r.question.id }),
    }));
  });

  it('a SUPERSEDED-card notice to an archived lane is dropped too (the replacement card lives on the filer)', async () => {
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    const old = await flag();
    if (old.kind !== 'created') throw new Error('expected created');
    const next = await flag({ chatId: 'ps-1', question: 'Which region should we deploy to — ca-central-1 or us-east-1?', supersedes: old.question.id });
    if (next.kind !== 'created') throw new Error(`expected created, got ${next.kind}`);
    expect(mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0].sessionId)).toEqual(['chat-1']);
    expect(mockArmRetry).not.toHaveBeenCalled();
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ action: 'dropped', outcome: 'superseded_dropped', questionId: old.question.id }),
    }));
  });

  it('a cross-chat DUPLICATE closed on an archived lane is dropped — the asker already carries the answer', async () => {
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    const r = await flag({ chatId: 'ps-1' });
    if (r.kind !== 'created') throw new Error('expected created');
    mockQuestions.rows.push({ id: 'oq_dupe0000-0000-0000-0000-000000000000', userId: 'u1', chatId: 'chat-1', question: 'Which region should we deploy to?', status: 'open', context: null, answer: null, createdAt: new Date(Date.now()), resolvedAt: null });
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'ca-central-1')).toBe('ok');
    expect(mockQuestions.rows.find((q: any) => q.id === 'oq_dupe0000-0000-0000-0000-000000000000')?.status).toBe('answered');
    expect(mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0].sessionId)).toEqual(['ps-1', 'chat-1']);
    expect(mockFireScheduleTarget.mock.calls.some((c: any[]) => String(c[0].prompt).includes('RE-ROUTED'))).toBe(false);
    expect(mockArmRetry).not.toHaveBeenCalled();
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ action: 'dropped', outcome: 'duplicate_dropped', questionId: 'oq_dupe0000-0000-0000-0000-000000000000' }),
    }));
  });

  it('no supervisor anywhere → nothing re-routed and still NO retry onto the archived lane (the transcript note remains)', async () => {
    world({ laneArchived: true, ps: null, fs: null });
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'go')).toBe('ok');
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    expect(mockArmRetry).not.toHaveBeenCalled();
    expect(mockQuestions.crossModelMessage.create).toHaveBeenCalled(); // the [Owner inbox] note on the lane
  });

  it('the supervisor is the question\'s LINKED chat (forChatId) → no duplicate re-route, it gets the answer once through the linked wake', async () => {
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    const r = await flag({ forChatId: 'ps-1' });
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    expect(mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0].sessionId)).toEqual(['chat-1', 'ps-1']);
    expect(mockFireScheduleTarget.mock.calls[1][0].prompt).not.toContain('RE-ROUTED'); // the plain linked-lane wake
    expect(mockArmRetry).not.toHaveBeenCalled();
  });

  it('the SUPERVISOR asks on behalf of the archived lane (chatId = PS, forChatId = lane) → the PS gets the answer ONCE, the lane\'s refused wake is not re-routed back onto it', async () => {
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    const r = await flag({ chatId: 'ps-1', forChatId: 'chat-1' });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'ca-central-1')).toBe('ok');
    const calls = mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.sessionId)).toEqual(['ps-1', 'chat-1']);
    expect(calls.some((c: any) => String(c.prompt).includes('RE-ROUTED'))).toBe(false);
    expect(mockArmRetry).not.toHaveBeenCalled();
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'archived_target_retire', sessionId: 'chat-1',
      meta: expect.objectContaining({ surface: 'owner_answer', outcome: 'linked_chat_woken', targetChatId: 'ps-1', laneRole: 'linked' }),
    }));
  });

  it('the Fleet Supervisor asks for an archived lane whose project has its own supervisor → the PS gets ONE re-routed wake naming the LINKED lane', async () => {
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    const r = await flag({ chatId: 'fs-1', forChatId: 'chat-1' });
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    const calls = mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.sessionId)).toEqual(['fs-1', 'chat-1', 'ps-1']);
    expect(calls[2].prompt).toMatch(/^\[Owner inbox — RE-ROUTED to the project supervisor: the linked lane "Spark lane" \(chat-1\) is ARCHIVED\]/);
    expect(mockArmRetry).not.toHaveBeenCalled();
  });

  it('the Fleet Supervisor asks for an archived lane with NO project supervisor → no second FS turn on the same answer', async () => {
    world({ laneArchived: true, ps: null, fs: 'fs-1' });
    const r = await flag({ chatId: 'fs-1', forChatId: 'chat-1' });
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    expect(mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0].sessionId)).toEqual(['fs-1', 'chat-1']);
    expect(mockArmRetry).not.toHaveBeenCalled();
  });

  it('asker AND linked lane both ARCHIVED in one project → the PS gets ONE re-routed wake, not one per archived chat', async () => {
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    const lane = mockChatFindFirst.getMockImplementation()!;
    mockChatFindFirst.mockImplementation(async (q: any) => (q?.where?.id === 'chat-2'
      ? { id: 'chat-2', userId: 'u1', projectId: 'proj-1', title: 'Probe lane', archivedAt: new Date('2026-10-19T09:00:00Z'), codingState: null }
      : lane(q)));
    mockFireScheduleTarget.mockImplementation(async ({ sessionId }: any) =>
      (sessionId === 'chat-1' || sessionId === 'chat-2' ? { started: false, reason: 'archived' } : { started: true }));
    const r = await flag({ forChatId: 'chat-2' });
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    const calls = mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.sessionId)).toEqual(['chat-1', 'ps-1', 'chat-2']);
    expect(calls[1].prompt).toContain('the asking lane "Spark lane" (chat-1)');
    expect(mockArmRetry).not.toHaveBeenCalled();
  });

  it('a preset-DEFAULT auto-answer (asker = PS, linked = archived lane) wakes the PS once — no re-route echo', async () => {
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    const r = await flag({ chatId: 'ps-1', forChatId: 'chat-1', options: [{ id: 'keep', label: 'Keep it' }, { id: 'release', label: 'Release it' }], defaultAfterDays: 3, defaultOption: 'release' });
    if (r.kind !== 'created') throw new Error('expected created');
    const row: any = mockQuestions.rows.find((q: any) => q.id === r.question.id);
    const now = new Date(Date.now() + 4 * 86_400_000);
    expect(await applyDefaultAnswerIfDue(row, now)).toBe(true);
    const calls = mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.sessionId)).toEqual(['ps-1', 'chat-1']);
    expect(calls.some((c: any) => String(c.prompt).includes('RE-ROUTED'))).toBe(false);
    expect(mockArmRetry).not.toHaveBeenCalled();
  });

  it('the answering ACTOR is the inheriting supervisor (FS answers an archived lane\'s card in its own turn) → no re-route back onto it', async () => {
    world({ laneArchived: true, ps: null, fs: 'fs-1' });
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'go', { actorChatId: 'fs-1' })).toBe('ok');
    expect(mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0].sessionId)).toEqual(['chat-1']);
    expect(mockArmRetry).not.toHaveBeenCalled();
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ outcome: 'actor_is_target', targetChatId: 'fs-1', tier: 'fleet' }),
    }));
  });

  it('an archived lane at its daily CAP (the wake never reached fireScheduleTarget) → the refused retry arm re-routes the answer instead of dropping it', async () => {
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    mockDailyCapExceeded.mockImplementation(async (chatId: string) => (chatId === 'chat-1' ? 40 : null));
    mockArmRetry.mockImplementation(async ({ sessionId }: any) => (sessionId === 'chat-1' ? { ok: false, reason: 'archived' } : { ok: true, scheduleId: 'sched-retry-1' }));
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    const calls = mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0]);
    expect(calls.map((c: any) => c.sessionId)).toEqual(['ps-1']);
    expect(calls[0].prompt).toContain('RE-ROUTED to the project supervisor');
    expect(mockArmRetry.mock.calls.map((c: any[]) => c[0].sessionId)).toEqual(['chat-1']); // refused — never re-armed elsewhere
    await flush();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ outcome: 'rerouted', seam: 'retry_arm', targetChatId: 'ps-1' }),
    }));
  });

  it('a LIVE lane is untouched (one wake, no re-route); a BUSY live lane still arms its own retry', async () => {
    world({ laneArchived: false, ps: 'ps-1', fs: 'fs-1' });
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    expect(mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0].sessionId)).toEqual(['chat-1']);
    mockFireScheduleTarget.mockReset().mockResolvedValue({ started: false, reason: 'busy' });
    const r2 = await flag({ question: 'Second decision?' });
    if (r2.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r2.question.id, 'u1', 'go');
    expect(mockArmRetry).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-1' }));
  });

  it('kill switch ARCHIVED_TARGET_RETIRE_DISABLED=1 restores the pre-fix path: no re-route, the retry is armed onto the archived lane', async () => {
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    world({ laneArchived: true, ps: 'ps-1', fs: 'fs-1' });
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    await answerOwnerQuestion(r.question.id, 'u1', 'go');
    expect(mockFireScheduleTarget.mock.calls.map((c: any[]) => c[0].sessionId)).toEqual(['chat-1']);
    expect(mockArmRetry).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-1' }));
  });
});
