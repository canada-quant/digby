/**
 * Ticket fadc3563 — the owner-gate HOLD guard (2026-10-04 incident replay).
 *
 * The incident (06:56:55Z): the owner answered a store-wave gate with "Not
 * yet — hold the store wave"; the answer-consumption paths (inline
 * answerOwnerQuestion fan-out AND the owner-gate sweeper backstop, ticket
 * 356d21bb) treated ANY answered question as an unblock — goal e1e96be5 +
 * todo 3bf505f8 flipped active/pending with a note reading the HOLD as a
 * go-ahead, and the store wave was falsely executable ~2 minutes until the
 * project supervisor re-applied the block.
 *
 * Pins:
 *   - the classifier (owner-hold-answer.ts): hold/negative leads and hold
 *     phrases ARE holds; affirmatives, noun-phrase decisions, typed-option
 *     labels and benign "no …" continuations are NOT; the hold note carries
 *     none of the OWNER_WAIT_CLAIM_RE shapes (the unbacked-claim watchdog
 *     must never fire on the owner's own hold);
 *   - the choke point (goals.service unblockOwnerGatedItems): a hold answer
 *     keeps todo AND goal 'blocked' as the OWNER's hold (blockKind 'owner',
 *     closed card unlinked, reason quoting the owner's words), audits
 *     todo/goal.owner_gate_hold, wakes the assignee 'owner_hold' with a
 *     never-a-go-ahead prompt, telemeters loop_metrics 'owner_gate_hold';
 *   - precedence: a question-form reply takes the CanLaw asked-back arm
 *     (agent gate), never the hold arm;
 *   - the classic release survives: an affirmative answer still unblocks
 *     (356d21bb semantics preserved — hold-DETECTION, not an affirmative
 *     requirement);
 *   - provenance: a supervisor/default hold is labelled as such, never
 *     dressed as the owner's own words;
 *   - a hold answer blocks the gate (2026-10-30: the kill switch was retired
 *     and hold classification is unconditional);
 *   - the SWEEPER incident replay: gated rows parked before an answer whose
 *     oq row is answered-with-a-hold are HELD by the backstop pass, not
 *     unblocked (stats.heldTodos/heldGoals + owner_gate_sweep telemetry).
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

// ── Stateful fake DB (the 356d21bb sweeper harness) ─────────────────────────
const mockQuestions = createOwnerQuestionTable();
const todoRows: any[] = [];
const goalRows: any[] = [];
const matchLoose = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const cond: any = v;
      if ('not' in cond) return row[k] !== cond.not;
      if ('in' in cond) return cond.in.includes(row[k]);
      return row[k] === v;
    }
    return row[k] === v;
  });
const gatedTable = (rows: any[]) => ({
  findMany: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matchLoose(r, where))),
  findUnique: jest.fn(async ({ where }: any) => rows.find((r) => matchLoose(r, where)) ?? null),
  updateMany: jest.fn(async ({ where, data }: any) => {
    const m = rows.filter((r) => matchLoose(r, where));
    m.forEach((r) => Object.assign(r, data));
    return { count: m.length };
  }),
});
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: mockQuestions.crossModelChat,
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
    projectTodo: gatedTable(todoRows),
    projectGoal: gatedTable(goalRows),
    activity: { create: jest.fn(async () => ({})) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── In-memory Redis ──────────────────────────────────────────────────────────
const store = new Map<string, any>();
const mockRedis = {
  set: jest.fn(async (k: string, v: any, opts?: any) => {
    if (opts?.NX && store.has(k)) return null;
    store.set(k, String(v));
    return 'OK';
  }),
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
  mGet: jest.fn(async (keys: string[]) => keys.map((k) => store.get(k) ?? null)),
  scan: jest.fn(async (_cursor: number, opts?: any) => {
    const prefix = String(opts?.MATCH ?? '*').replace(/\*.*$/, '');
    return { cursor: 0, keys: [...store.keys()].filter((k) => k.startsWith(prefix)) };
  }),
  rPush: jest.fn(async (k: string, v: any) => {
    const arr = Array.isArray(store.get(k)) ? store.get(k) : [];
    arr.push(v); store.set(k, arr); return arr.length;
  }),
  lPop: jest.fn(async (k: string) => {
    const arr = Array.isArray(store.get(k)) ? store.get(k) : [];
    const v = arr.length ? arr.shift() : null;
    store.set(k, arr); return v ?? null;
  }),
  expire: jest.fn(async () => 1),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

// ── Boundary mocks (env-exit-safe graph) ─────────────────────────────────────
const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
}));
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(async () => {}),
}));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: jest.fn(async () => {}),
}));
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import { isHoldAnswer } from './owner-hold-answer';
import { unblockOwnerGatedItems } from './goals.service';
import { flagOwnerQuestion, answerOwnerQuestion, OWNER_WAIT_CLAIM_RE } from './owner-questions';
import { sweepOwnerGatesOnce } from './owner-gate-sweeper';

const NOW = new Date('2026-10-04T07:00:00Z');
/** The incident's exact answer text (oq_fee2d8eb, 2026-10-04 06:54Z). */
const HOLD_ANSWER = 'Not yet — hold the store wave';

beforeEach(() => {
  mockQuestions.reset();
  todoRows.length = 0;
  goalRows.length = 0;
  store.clear();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockEnqueueDirectWake.mockReset().mockResolvedValue({ ok: true, hookEventId: 'he-1' });
  mockRecordLoopMetric.mockReset();
  delete process.env.OWNER_PROVENANCE_STRICT_DISABLED;
});

// ── The classifier ───────────────────────────────────────────────────────────
describe('fadc3563 — isHoldAnswer (pure)', () => {
  it('the incident answer and the hold/negative class ARE holds', () => {
    for (const a of [
      HOLD_ANSWER,
      'not yet',
      'Not now',
      'no',
      'Nope',
      'hold',
      'Hold the store wave',
      'hold off for now',
      'stop',
      'stop everything',
      'halt it',
      'pause',
      'wait',
      'wait until Friday',
      'later',
      'deferred',
      'postpone the launch',
      "don't start the store wave",
      'do not ship this yet',
      'no — hold off',
      'keep it blocked',
      'leave it stopped',
      'leave them as is',
      'put it on hold',
      'stand down',
      'stays blocked',
      'too early',
      'not ready',
    ]) {
      expect(isHoldAnswer(a)).toBe(true);
    }
  });

  it('affirmatives, decisions and benign "no …" continuations are NOT holds (356d21bb semantics preserved)', () => {
    for (const a of [
      'ca-central-1',
      'yes go — use the post-CPT base',
      'yes — deploy to ca',
      'Play ORG account + allow free D&B lookup (recommended)',
      'go ahead',
      'proceed with the deploy',
      'ship it',
      'option 2',
      'Path C',
      'no problem, go ahead',
      'no, proceed',
      'no rush — ship whenever',
      'not a problem at all',
      'approve both',
      'okay',
      'sure',
    ]) {
      expect(isHoldAnswer(a)).toBe(false);
    }
  });

  it('empty input is never a hold', () => {
    expect(isHoldAnswer('')).toBe(false);
    expect(isHoldAnswer(undefined as any)).toBe(false);
  });
});

// ── The choke point ──────────────────────────────────────────────────────────
describe('fadc3563 — unblockOwnerGatedItems: a HOLD answer keeps the gate closed', () => {
  const holdTodo = (over: any = {}) => ({
    id: 't1', userId: 'u1', goalId: 'g1', projectId: 'p1', title: 'Execute ORG-dependent Play Console items',
    status: 'blocked', blockedReason: 'Waiting on the owner (gate oq_1)', blockKind: 'owner',
    gateQuestionId: 'oq_1', progressNote: null, assigneeChatId: 'lane-1', ...over,
  });
  const holdGoal = (over: any = {}) => ({
    id: 'g1', userId: 'u1', projectId: 'p1', title: 'Mobile store wave', status: 'blocked',
    blockedReason: 'Waiting on the owner (gate oq_1)', blockKind: 'owner', gateQuestionId: 'oq_1',
    progressNote: null, ...over,
  });

  it('the incident: todo stays blocked as the OWNER hold — blockKind owner, card unlinked, reason quotes the words, owner_hold wake, hold audit + metric', async () => {
    todoRows.push(holdTodo());
    const out = await unblockOwnerGatedItems({
      userId: 'u1', questionId: 'oq_1', question: 'Proceed with the store wave?', answer: HOLD_ANSWER, source: 'owner inbox answer',
    });
    expect(out).toEqual({ todos: 0, goals: 0, heldTodos: 1, heldGoals: 0 });
    const t = todoRows[0];
    expect(t.status).toBe('blocked');            // THE defect: was 'pending'
    expect(t.blockKind).toBe('owner');           // the owner's hold — a lane must not lift it
    expect(t.gateQuestionId).toBeNull();         // closed card unlinked (no stale-gate re-listing)
    expect(t.blockedReason).toContain(HOLD_ANSWER);
    expect(t.blockedReason).toContain('HELD');
    expect(t.blockedReason).toContain('fadc3563');
    expect(t.blockedReason.length).toBeLessThanOrEqual(200);
    // the unbacked-claim watchdog must NEVER fire on the owner's own hold
    expect(t.blockedReason).not.toMatch(OWNER_WAIT_CLAIM_RE);
    // audit + metric
    const auditCalls = (jest.requireMock('../../../config/database').default.activity.create as jest.Mock);
    expect(auditCalls).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'todo.owner_gate_hold' }) }),
    );
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner_gate_hold', meta: expect.objectContaining({ questionId: 'oq_1' }) }),
    );
    // the assignee is woken 'owner_hold' — never "START it now"
    expect(mockEnqueueDirectWake).toHaveBeenCalledTimes(1);
    const wake = mockEnqueueDirectWake.mock.calls[0][0];
    expect(wake.meta).toEqual(expect.objectContaining({ todoId: 't1', trigger: 'owner_hold' }));
    expect(wake.prompt).toContain('HELD this todo');
    expect(wake.prompt).toContain(HOLD_ANSWER);
    expect(wake.prompt).toContain('do NOT unblock this todo yourself');
    expect(wake.prompt).not.toContain('START it now');
  });

  it('goal arm: stays blocked as the owner hold, audited goal.owner_gate_hold, no wake', async () => {
    goalRows.push(holdGoal());
    const out = await unblockOwnerGatedItems({
      userId: 'u1', questionId: 'oq_1', question: 'Proceed with the store wave?', answer: HOLD_ANSWER, source: 'owner-gate sweeper',
    });
    expect(out).toEqual({ todos: 0, goals: 0, heldTodos: 0, heldGoals: 1 });
    const g = goalRows[0];
    expect(g.status).toBe('blocked');            // THE defect: was 'active'
    expect(g.blockKind).toBe('owner');
    expect(g.gateQuestionId).toBeNull();
    expect(g.blockedReason).toContain(HOLD_ANSWER);
    expect(g.blockedReason).not.toMatch(OWNER_WAIT_CLAIM_RE);
    const auditCalls = (jest.requireMock('../../../config/database').default.activity.create as jest.Mock);
    expect(auditCalls).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'goal.owner_gate_hold' }) }),
    );
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });

  it('precedence: a question-form reply takes the CanLaw asked-back arm (agent gate), never the hold arm', async () => {
    todoRows.push(holdTodo());
    const out = await unblockOwnerGatedItems({
      userId: 'u1', questionId: 'oq_1', question: 'Proceed?', answer: 'not yet — can we hold it until Friday?', source: 'owner inbox answer', counterQuestion: true,
    });
    expect(out).toEqual({ todos: 1, goals: 0, heldTodos: 0, heldGoals: 0 });
    expect(todoRows[0].blockKind).toBe('agent');
    expect(mockEnqueueDirectWake.mock.calls[0][0].meta).toEqual(expect.objectContaining({ trigger: 'owner_asked_back' }));
  });

  it('the classic release survives: an affirmative answer still unblocks (START-now wake, owner_gate_unblock audit)', async () => {
    todoRows.push(holdTodo());
    const out = await unblockOwnerGatedItems({
      userId: 'u1', questionId: 'oq_1', question: 'Proceed with the store wave?', answer: 'yes — go ahead with the ORG account', source: 'owner inbox answer',
    });
    expect(out).toEqual({ todos: 1, goals: 0, heldTodos: 0, heldGoals: 0 });
    expect(todoRows[0].status).toBe('pending');
    expect(todoRows[0].blockKind).toBeNull();
    expect(mockEnqueueDirectWake.mock.calls[0][0].meta).toEqual(expect.objectContaining({ trigger: 'unblocked' }));
    expect(mockEnqueueDirectWake.mock.calls[0][0].prompt).toContain('START it now');
  });

  it('provenance: a supervisor hold is labelled a supervisor ruling, never the owner\'s own words', async () => {
    todoRows.push(holdTodo());
    await unblockOwnerGatedItems({
      userId: 'u1', questionId: 'oq_1', question: 'Proceed?', answer: 'hold — not yet', source: 'owner inbox answer', answeredBy: 'supervisor',
    });
    expect(todoRows[0].status).toBe('blocked');
    // OWNER-PROVENANCE-STRICT (2026-10-20): a supervisor's hold is the TEAM's revisable gate, never blockKind 'owner'.
    expect(todoRows[0].blockKind).toBe('agent');
    expect(todoRows[0].blockedReason).toContain('supervisor ruling');
    expect(todoRows[0].blockedReason).toContain('when the supervisor revises it or the owner overrules it');
    expect(todoRows[0].blockedReason).not.toMatch(OWNER_WAIT_CLAIM_RE);
    // the wake names the actual actor — never "the OWNER just HELD"
    const wake = mockEnqueueDirectWake.mock.calls[0][0];
    expect(wake.meta).toEqual(expect.objectContaining({ trigger: 'owner_hold' }));
    expect(wake.prompt).toContain('the FLEET SUPERVISOR just HELD this todo');
    expect(wake.prompt).toContain('not the owner\'s own words');
    expect(wake.prompt).not.toContain('the OWNER just HELD');
    expect(wake.prompt).not.toContain('START it now');
  });

  it('provenance: a preset-DEFAULT hold re-blocks as the team\'s gate on todo AND goal, and the wake says preset default', async () => {
    todoRows.push(holdTodo());
    goalRows.push(holdGoal());
    const out = await unblockOwnerGatedItems({
      userId: 'u1', questionId: 'oq_1', question: 'Proceed?', answer: 'hold — not yet', source: 'preset default answer', answeredBy: 'default',
    });
    expect(out).toEqual({ todos: 0, goals: 0, heldTodos: 1, heldGoals: 1 });
    expect(todoRows[0].blockKind).toBe('agent');
    expect(goalRows[0].blockKind).toBe('agent');
    expect(todoRows[0].blockedReason).toContain('HOLD (preset default)');
    const wake = mockEnqueueDirectWake.mock.calls[0][0];
    expect(wake.prompt).toContain('PRESET DEFAULT');
    expect(wake.prompt).not.toContain('the OWNER just HELD');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_gate_hold', meta: expect.objectContaining({ answeredBy: 'default', blockKind: 'agent' }) }));
  });

  it('an OWNER hold stays blockKind owner; kill switch OWNER_PROVENANCE_STRICT_DISABLED=1 restores owner for a supervisor hold', async () => {
    todoRows.push(holdTodo());
    await unblockOwnerGatedItems({ userId: 'u1', questionId: 'oq_1', question: 'Proceed?', answer: 'hold — not yet', source: 'owner inbox answer', answeredBy: 'owner' });
    expect(todoRows[0].blockKind).toBe('owner');
    expect(mockEnqueueDirectWake.mock.calls[0][0].prompt).toContain('the OWNER just HELD this todo');
    todoRows.length = 0;
    store.clear();
    process.env.OWNER_PROVENANCE_STRICT_DISABLED = '1';
    todoRows.push(holdTodo({ id: 't2', assigneeChatId: 'lane-2' }));
    await unblockOwnerGatedItems({ userId: 'u1', questionId: 'oq_1', question: 'Proceed?', answer: 'hold — not yet', source: 'owner inbox answer', answeredBy: 'supervisor' });
    expect(todoRows[0].blockKind).toBe('owner');
    expect(todoRows[0].blockedReason).toContain('lifts only on newer owner words');
  });

  });

// ── The sweeper incident replay (the true 06:56:55Z path) ────────────────────
describe('fadc3563 — sweeper replay: gates parked before a HOLD answer are HELD by the backstop, not unblocked', () => {
  it('the incident sequence: answer the gate with the hold, THEN sweep parked rows — held, never unblocked', async () => {
    const r = await flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Proceed with the M1.5 store wave?' });
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', HOLD_ANSWER)).toBe('ok');
    // rows parked on the gate (present at answer time or parked after — the
    // sweeper is the backstop for both)
    todoRows.push({
      id: 't-1', userId: 'u1', goalId: 'g-1', projectId: 'p1', title: 'Execute ORG-dependent Play Console items',
      status: 'blocked', blockedReason: 'Waiting on owner', blockKind: 'owner', gateQuestionId: r.question.id, assigneeChatId: 'lane-1',
    });
    goalRows.push({
      id: 'g-1', userId: 'u1', projectId: 'p1', title: 'Mobile store wave', status: 'blocked',
      blockedReason: 'Waiting on owner', blockKind: 'owner', gateQuestionId: r.question.id,
    });

    const stats = await sweepOwnerGatesOnce(NOW);

    expect(stats.unblockedTodos).toBe(0);        // THE defect: was 1
    expect(stats.unblockedGoals).toBe(0);        // THE defect: was 1
    expect(stats.heldTodos).toBe(1);
    expect(stats.heldGoals).toBe(1);
    expect(todoRows[0].status).toBe('blocked');
    expect(todoRows[0].blockKind).toBe('owner');
    expect(todoRows[0].gateQuestionId).toBeNull();
    expect(goalRows[0].status).toBe('blocked');
    expect(goalRows[0].blockKind).toBe('owner');
    expect(mockEnqueueDirectWake).toHaveBeenCalledWith(
      expect.objectContaining({ targetChatId: 'lane-1', meta: expect.objectContaining({ todoId: 't-1', trigger: 'owner_hold' }) }),
    );
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner_gate_sweep', meta: expect.objectContaining({ heldTodos: 1, heldGoals: 1, unblockedTodos: 0, unblockedGoals: 0 }) }),
    );
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner_gate_hold', meta: expect.objectContaining({ source: 'owner-gate sweeper' }) }),
    );
  });
});
