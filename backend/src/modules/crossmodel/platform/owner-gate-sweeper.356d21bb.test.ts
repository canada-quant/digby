/**
 * Ticket 356d21bb — the owner-gate sweeper backstop (owner-gate-sweeper.ts):
 *
 *   (a) todos/goals blocked on an ANSWERED gateQuestionId unblock through the
 *       REAL goals.service choke point (todo → pending + wake, goal → active);
 *       a DISMISSED gate row never unblocks anything (dismiss ≠ decision).
 *   (b) an OPEN row matching a recently-answered same-user decision auto-
 *       resolves through the REAL canonical answerOwnerQuestion path (flip +
 *       transcript note + wake); non-matching rows survive.
 *   (c) a STALE live ask_user pending (confirm:pending:* older than the
 *       15-min floor) matching an answered question gets the recorded answer
 *       via the durable record + resolution mailbox; a FRESH pending is left
 *       for the owner (the threshold guard).
 *   (d) kill switch OWNER_GATE_SWEEPER_DISABLED=1 → no interval.
 *
 * Full-composition suite: the real sweeper + real goals.service + real
 * owner-questions + real pending-durable/session-run-lock over a stateful
 * fake Prisma + in-memory Redis.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

// ── Stateful fake DB ─────────────────────────────────────────────────────────
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

// ── In-memory Redis (confirm-pending scan + durable records + mailbox + wake debounce) ──
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
  rPush: jest.fn(async (k: string, v: string) => {
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
    constructor(public statusCode: number, public message: string, public isOperational = true) {
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

import { sweepOwnerGatesOnce, startOwnerGateSweeper, stopOwnerGateSweeper } from './owner-gate-sweeper';
import { flagOwnerQuestion, answerOwnerQuestion } from './owner-questions';
import { loadDurablePending, saveDurablePending } from '../coding/pending-durable';
import { drainResolutions } from '../coding/session-run-lock';

const NOW = new Date('2026-09-13T12:00:00Z');

beforeEach(() => {
  mockQuestions.reset();
  todoRows.length = 0;
  goalRows.length = 0;
  store.clear();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockEnqueueDirectWake.mockReset().mockResolvedValue({ ok: true, hookEventId: 'he-1' });
  mockRecordLoopMetric.mockReset();
  delete process.env.OWNER_GATE_SWEEPER_DISABLED;
});

afterEach(() => {
  stopOwnerGateSweeper();
  jest.useRealTimers();
});

const seedAnsweredRow = async (over: any = {}) => {
  const r = await flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Which region should we deploy to?', ...over });
  if (r.kind !== 'created') throw new Error('expected created');
  expect(await answerOwnerQuestion(r.question.id, over.userId ?? 'u1', over.answer ?? 'ca-central-1')).toBe('ok');
  return r.question.id;
};

describe('356d21bb sweeper — action (a): gates on ANSWERED questions unblock', () => {
  it('a todo + goal parked on an answered gate flip actionable (todo wakes its assignee); telemetry records the pass', async () => {
    const oqId = await seedAnsweredRow();
    todoRows.push({
      id: 't1', userId: 'u1', goalId: 'g1', projectId: 'p1', title: 'Ship', status: 'blocked',
      blockedReason: 'Waiting on owner', blockKind: 'owner', gateQuestionId: oqId, assigneeChatId: 'lane-1',
    });
    goalRows.push({
      id: 'g1', userId: 'u1', projectId: 'p1', title: 'Goal', status: 'blocked',
      blockedReason: 'Waiting on owner', blockKind: 'owner', gateQuestionId: oqId,
    });

    const stats = await sweepOwnerGatesOnce(NOW);

    expect(stats.unblockedTodos).toBe(1);
    expect(stats.unblockedGoals).toBe(1);
    expect(todoRows[0]).toMatchObject({ status: 'pending', blockedReason: null, blockKind: null, gateQuestionId: null });
    expect(goalRows[0]).toMatchObject({ status: 'active', blockedReason: null, blockKind: null, gateQuestionId: null });
    expect(mockEnqueueDirectWake).toHaveBeenCalledWith(
      expect.objectContaining({ targetChatId: 'lane-1', meta: expect.objectContaining({ todoId: 't1', trigger: 'unblocked' }) }),
    );
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner_gate_sweep', meta: expect.objectContaining({ unblockedTodos: 1, unblockedGoals: 1 }) }),
    );
  });

  it('a DISMISSED gate row never unblocks anything (dismiss ≠ decision)', async () => {
    const r = await flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Keep the reservation?' });
    if (r.kind !== 'created') throw new Error('expected created');
    const { dismissOwnerQuestion } = await import('./owner-questions');
    expect(await dismissOwnerQuestion(r.question.id, 'u1')).toBe('ok');
    todoRows.push({
      id: 't9', userId: 'u1', goalId: 'g9', projectId: 'p1', title: 'Parked', status: 'blocked',
      blockedReason: 'Waiting on owner', blockKind: 'owner', gateQuestionId: r.question.id,
    });

    const stats = await sweepOwnerGatesOnce(NOW);
    expect(stats.unblockedTodos).toBe(0);
    expect(todoRows[0].status).toBe('blocked');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
  });
});

describe('356d21bb sweeper — action (b): OPEN duplicates of an answered decision auto-resolve', () => {
  it('the dupe flips answered (answeredBy owner) + its chat is woken; non-matching rows survive', async () => {
    await seedAnsweredRow({ answer: 'ca-central-1' });
    const dupe = await flagOwnerQuestion({ chatId: 'chat-2', userId: 'u1', question: 'Which region should we deploy to?' });
    if (dupe.kind !== 'created') throw new Error('expected created');
    const unrelated = await flagOwnerQuestion({ chatId: 'chat-3', userId: 'u1', question: 'Rename the staging bucket?' });
    if (unrelated.kind !== 'created') throw new Error('expected created');
    mockFireScheduleTarget.mockClear();

    const stats = await sweepOwnerGatesOnce(NOW);

    expect(stats.dupesResolved).toBe(1);
    const dupeRow = mockQuestions.rows.find((r) => r.id === dupe.question.id);
    expect(dupeRow).toMatchObject({ status: 'answered', answer: 'ca-central-1', answeredBy: 'owner' });
    expect(mockFireScheduleTarget).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'chat-2' }));
    const unrelatedRow = mockQuestions.rows.find((r) => r.id === unrelated.question.id);
    expect(unrelatedRow.status).toBe('open');
  });
});

describe('356d21bb sweeper — action (c): STALE live pendings get the recorded answer', () => {
  it('a pending older than the floor matching an answered question resolves via durable record + mailbox', async () => {
    await seedAnsweredRow({ answer: 'ca-central-1' });
    const staleTs = NOW.getTime() - 20 * 60 * 1000; // 20 min parked
    store.set('confirm:pending:chat-1', JSON.stringify({
      kind: 'question', id: 'q-stale-1', question: 'Which region should we deploy to?', options: [], ts: staleTs,
    }));
    await saveDurablePending({
      id: 'q-stale-1', kind: 'question', sessionId: 'chat-1', fingerprint: null,
      detail: 'region gate', status: 'pending', createdAt: staleTs,
    });

    const stats = await sweepOwnerGatesOnce(NOW);

    expect(stats.pendingsResolved).toBe(1);
    const rec = await loadDurablePending('question', 'q-stale-1');
    expect(rec).toMatchObject({ status: 'answered', resolution: 'ca-central-1' });
    expect(await drainResolutions('chat-1')).toEqual([{ kind: 'question', id: 'q-stale-1', answer: 'ca-central-1' }]);
  });

  it('a FRESH pending under the floor is NOT resolved — the owner gets the floor first', async () => {
    await seedAnsweredRow({ answer: 'ca-central-1' });
    store.set('confirm:pending:chat-1', JSON.stringify({
      kind: 'question', id: 'q-fresh-1', question: 'Which region should we deploy to?', options: [], ts: NOW.getTime() - 2 * 60 * 1000,
    }));

    const stats = await sweepOwnerGatesOnce(NOW);
    expect(stats.pendingsResolved).toBe(0);
    expect(await drainResolutions('chat-1')).toEqual([]);
  });

  it('a stale pending matching NOTHING answered stays parked', async () => {
    store.set('confirm:pending:chat-1', JSON.stringify({
      kind: 'question', id: 'q-lonely', question: 'Approve the budget?', options: [], ts: NOW.getTime() - 60 * 60 * 1000,
    }));
    const stats = await sweepOwnerGatesOnce(NOW);
    expect(stats.pendingsResolved).toBe(0);
    expect(await drainResolutions('chat-1')).toEqual([]);
  });
});

describe('356d21bb sweeper — kill switch', () => {
  it('OWNER_GATE_SWEEPER_DISABLED=1 → no interval is scheduled', async () => {
    jest.useFakeTimers();
    process.env.OWNER_GATE_SWEEPER_DISABLED = '1';
    startOwnerGateSweeper();
    expect(jest.getTimerCount()).toBe(0);
    delete process.env.OWNER_GATE_SWEEPER_DISABLED;
    startOwnerGateSweeper();
    expect(jest.getTimerCount()).toBe(1);
    stopOwnerGateSweeper();
    expect(jest.getTimerCount()).toBe(0);
  });
});
