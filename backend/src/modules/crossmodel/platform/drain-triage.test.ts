/**
 * drain-triage.ts — decision-gate purpose 'drain_triage' (N6, 2026-09-25).
 *
 *  - the kill switch, mode 'off' and non-agent rows never touch the DB, Redis or the seat;
 *  - the state is CODE-COMPUTED (row flags, sender-awaits-reply, open directives,
 *    user rows waiting) with the bodies LAST and capped;
 *  - shadow → the stash rides the drain (no outcome row here, no park);
 *  - act (designed, not enabled) → a confidently quiet batch is parked once,
 *    never with a user row behind it, never re-triaged inside the marker;
 *  - every failure (snapshot read, null gate, throw) fails OPEN.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn() },
  pendingChatMessage: { count: jest.fn(async () => 0) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const redisStore = new Map<string, string>();
const mockRedis = {
  get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { redisStore.delete(k); return 1; }),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
const optionThresholds: Record<string, number> = {};
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionOptionThreshold: (_p: string, option: string, fallback: number) => optionThresholds[option] ?? fallback,
  stashDecision: (d: any, purpose: string) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'now' } : null),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

const mockGetSupervisorState: jest.Mock = jest.fn(async (): Promise<any> => ({ directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  getSupervisorState: (...a: any[]) => mockGetSupervisorState(...a),
}));

import {
  DRAIN_TRIAGE_BODY_CAP,
  DRAIN_TRIAGE_QUESTION,
  DRAIN_TRIAGE_QUESTIONS,
  buildDrainTriageState,
  computeDrainSnapshot,
  drainTriageCodeFlags,
  drainTriageDeferMin,
  drainTriageWouldPark,
  preTriageDrainBatch,
  readDrainPark,
} from './drain-triage';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const CHAT = 'sup-chat-0001';

const ENV = ['DECISION_GATE_DRAIN_TRIAGE_DEFER_MIN'];
const saved: Record<string, string | undefined> = {};

const row = (id: string, content: string, ageMin = 3, source = 'agent') => ({ id, chatId: CHAT, userId: 'u1', content, mode: null, source, createdAt: min(ageMin) });
const origin = (sourceChatId: string, depth = 0) => ({ kind: 'agent', sourceChatId, depth });

const choice = (c: string, p: number, id = 'd1', mode: 'shadow' | 'act' = 'shadow') => ({
  id, mode, backend: 'TypeSafe Jev', ms: 12,
  answers: { [DRAIN_TRIAGE_QUESTION]: { type: 'choice', choice: c, probabilities: { ack_only: c === 'ack_only' ? p : (1 - p) / 2, coalesce: c === 'coalesce' ? p : (1 - p) / 2, act_now: c === 'act_now' ? p : (1 - p) / 2 }, confidence: p } },
});

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const k of Object.keys(optionThresholds)) delete optionThresholds[k];
  redisStore.clear();
  jest.clearAllMocks();
  mockMode.mockReturnValue('off');
  mockDecide.mockResolvedValue(null);
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: CHAT, isSupervisor: true, isProjectSupervisor: false });
  mockPrisma.pendingChatMessage.count.mockResolvedValue(0);
  mockGetSupervisorState.mockResolvedValue({ directives: [{ status: 'open' }, { status: 'done' }, { status: 'open' }], archived: [], dispatches: [], projects: [], notes: '', refutations: [] });
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('code-computed flags', () => {
  it('reads question / awaits-reply / failure / report-only / superseded cues, senders, ages and depth', () => {
    const rows = [
      row('r1', 'Lane A report-up: build green, PR #12 opened. FYI, no action needed.', 10),
      row('r2', 'Lane B: run FAILED on step 3 (exit code 1). Should I retry with the fallback model?', 2),
    ];
    const f = drainTriageCodeFlags(rows, [origin('lane-a', 1), origin('lane-b', 2)], [null, 'superseded'], NOW.getTime());
    expect(f).toMatchObject({
      rows: 2, distinct_senders: 2, oldest_row_age_min: 10, newest_row_age_min: 2,
      any_row_is_question_or_request: true, sender_awaits_reply: true, any_row_reports_failure_or_block: true,
      any_row_reads_report_only: true, any_row_superseded_by_owner: true, max_hook_depth: 2,
    });
  });

  it('a plain completion report reads as no question, nobody awaiting a reply, nothing failing', () => {
    const f = drainTriageCodeFlags([row('r1', 'Lane A: finished the migration; tests pass; merged to main.')], [origin('lane-a')], [null], NOW.getTime());
    expect(f).toMatchObject({ any_row_is_question_or_request: false, sender_awaits_reply: false, any_row_reports_failure_or_block: false, any_row_superseded_by_owner: false, max_hook_depth: 0 });
  });
});

describe('state + snapshot', () => {
  it('puts the code fields first, the ledger facts, then the bodies LAST — capped at the 4k budget', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`r${i}`, `message ${i} ` + 'x'.repeat(2000), i + 1));
    const flags = drainTriageCodeFlags(rows, rows.map((_, i) => origin(`lane-${i}`)), rows.map(() => null), NOW.getTime());
    const state = buildDrainTriageState({ snapshot: { target: 'fleet supervisor chat', openDirectives: 2, pendingUserRows: 1 }, flags, rows, origins: rows.map((_, i) => origin(`lane-${i}`)), now: NOW.getTime() });
    const keys = Object.keys(state);
    expect(keys[0]).toBe('target');
    expect(keys[keys.length - 1]).toBe('messages');
    expect(state).toMatchObject({ open_directives_on_ledger: 2, user_rows_waiting_behind: 1, rows: 6 });
    const messages = state.messages as Array<{ head: string; from_chat?: string; age_min?: number }>;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.reduce((n, m) => n + m.head.length, 0)).toBeLessThanOrEqual(DRAIN_TRIAGE_BODY_CAP);
    expect(messages[0]).toMatchObject({ from_chat: 'lane-0', age_min: 1 });
  });

  it('computeDrainSnapshot: supervisor chats count OPEN directives; a plain chat carries null; user rows are counted', async () => {
    mockPrisma.pendingChatMessage.count.mockResolvedValue(2);
    await expect(computeDrainSnapshot(CHAT)).resolves.toEqual({ target: 'fleet supervisor chat', openDirectives: 2, pendingUserRows: 2 });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: CHAT, isSupervisor: false, isProjectSupervisor: false });
    await expect(computeDrainSnapshot(CHAT)).resolves.toEqual({ target: 'plain chat', openDirectives: null, pendingUserRows: 2 });
    expect(mockGetSupervisorState).toHaveBeenCalledTimes(1);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    await expect(computeDrainSnapshot(CHAT)).resolves.toBeNull();
  });

  it('the question is a 3-way choice with a hold option', () => {
    expect(DRAIN_TRIAGE_QUESTIONS[DRAIN_TRIAGE_QUESTION].type).toBe('choice');
    expect(Object.keys((DRAIN_TRIAGE_QUESTIONS[DRAIN_TRIAGE_QUESTION] as any).criteria)).toEqual(['ack_only', 'coalesce', 'act_now']);
  });
});

describe('drainTriageWouldPark', () => {
  it('ack_only / coalesce park at or above their option threshold; act_now never parks', () => {
    expect(drainTriageWouldPark(choice('ack_only', 0.9).answers as any)).toMatchObject({ park: true, disposition: 'ack_only', p: 0.9, threshold: 0.85 });
    expect(drainTriageWouldPark(choice('coalesce', 0.86).answers as any)).toMatchObject({ park: true, disposition: 'coalesce' });
    expect(drainTriageWouldPark(choice('ack_only', 0.7).answers as any)).toMatchObject({ park: false });
    expect(drainTriageWouldPark(choice('act_now', 0.99).answers as any)).toMatchObject({ park: false, disposition: 'act_now' });
    optionThresholds.coalesce = 0.95;
    expect(drainTriageWouldPark(choice('coalesce', 0.9).answers as any)).toMatchObject({ park: false, threshold: 0.95 });
    expect(drainTriageWouldPark({} as any)).toBeNull();
  });
});

describe('preTriageDrainBatch', () => {
  const rows = [row('r1', 'Lane A report-up: build green.'), row('r2', 'Lane B: tests pass.')];
  const origins = [origin('lane-a'), origin('lane-b')];
  const notes = [null, null];

  it('mode off and non-agent rows never touch the DB, Redis or the seat', async () => {
    mockMode.mockReturnValue('off');
    await expect(preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW })).resolves.toEqual({ decision: null, stash: null, parked: null });
    mockMode.mockReturnValue('shadow');
    await expect(preTriageDrainBatch({ chatId: CHAT, rows: [row('u1', 'hello', 1, 'user')], origins: [null], supersededNotes: [null], now: NOW })).resolves.toEqual({ decision: null, stash: null, parked: null });
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
    expect(mockRedis.get).not.toHaveBeenCalled();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('SHADOW: asks the seat with the code-computed state and returns the stash — no park, no outcome row', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(choice('ack_only', 0.97));
    const r = await preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW });
    expect(r.parked).toBeNull();
    expect(r.stash).toMatchObject({ id: 'd1', purpose: 'drain_triage', mode: 'shadow' });
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(opts).toMatchObject({ purpose: 'drain_triage', sessionId: CHAT });
    expect(questions).toBe(DRAIN_TRIAGE_QUESTIONS);
    expect(state).toMatchObject({ target: 'fleet supervisor chat', rows: 2, distinct_senders: 2, open_directives_on_ledger: 2, user_rows_waiting_behind: 0 });
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('ACT: a confidently quiet batch with no user row behind it is PARKED once (marker = triagedAt + retryAt) and records acted:true', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('ack_only', 0.97, 'd2', 'act'));
    const r = await preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW });
    expect(r.parked).toMatchObject({ disposition: 'ack_only', p: 0.97, until: NOW.getTime() + drainTriageDeferMin() * 60_000 });
    expect(r.stash).toBeNull();
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: DRAIN_TRIAGE_QUESTION, actual: null, acted: true });
    await expect(readDrainPark(CHAT)).resolves.toMatchObject({ rowIds: ['r1', 'r2'], disposition: 'ack_only', triagedAt: NOW.toISOString() });
    // Still inside the park: held WITHOUT a second triage.
    mockDecide.mockClear();
    const again = await preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: new Date(NOW.getTime() + 60_000) });
    expect(again.parked).toMatchObject({ disposition: 'ack_only' });
    expect(mockDecide).not.toHaveBeenCalled();
    // Park lapsed: delivers, and is NOT re-triaged (bounded delay).
    const later = await preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: new Date(NOW.getTime() + 61 * 60_000) });
    expect(later).toEqual({ decision: null, stash: null, parked: null });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('ACT never parks when a USER row waits behind the batch — the stash rides instead', async () => {
    mockMode.mockReturnValue('act');
    mockPrisma.pendingChatMessage.count.mockResolvedValue(1);
    mockDecide.mockResolvedValue(choice('ack_only', 0.99, 'd3', 'act'));
    const r = await preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW });
    expect(r.parked).toBeNull();
    expect(r.stash).toMatchObject({ id: 'd3', purpose: 'drain_triage' });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('ACT requested but the RESULT came back shadow (uncalibrated backend, E2) → never parks', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('ack_only', 0.99, 'd4', 'shadow'));
    const r = await preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW });
    expect(r.parked).toBeNull();
    expect(r.stash).toMatchObject({ id: 'd4', mode: 'shadow' });
  });

  it('ACT: act_now never parks; a below-threshold quiet answer never parks', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(choice('act_now', 0.99, 'd5', 'act'));
    expect((await preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW })).parked).toBeNull();
    mockDecide.mockResolvedValue(choice('coalesce', 0.6, 'd6', 'act'));
    expect((await preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW })).parked).toBeNull();
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('fails OPEN: a snapshot read error, a null gate answer and a thrown decide all return NO_TRIAGE', async () => {
    mockMode.mockReturnValue('shadow');
    mockPrisma.crossModelChat.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW })).resolves.toEqual({ decision: null, stash: null, parked: null });
    mockDecide.mockResolvedValue(null);
    await expect(preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW })).resolves.toEqual({ decision: null, stash: null, parked: null });
    mockDecide.mockRejectedValueOnce(new Error('seat down'));
    await expect(preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW })).resolves.toEqual({ decision: null, stash: null, parked: null });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('a supervisor-state read failure degrades the directive count to null, the gate is still asked', async () => {
    mockMode.mockReturnValue('shadow');
    mockGetSupervisorState.mockRejectedValueOnce(new Error('ledger down'));
    mockDecide.mockResolvedValue(choice('ack_only', 0.9));
    const r = await preTriageDrainBatch({ chatId: CHAT, rows, origins, supersededNotes: notes, now: NOW });
    expect(r.stash).not.toBeNull();
    expect(mockDecide.mock.calls[0][0]).not.toHaveProperty('open_directives_on_ledger');
  });

  it('DECISION_GATE_DRAIN_TRIAGE_DEFER_MIN is clamped to 5..60', () => {
    expect(drainTriageDeferMin()).toBe(15);
    process.env.DECISION_GATE_DRAIN_TRIAGE_DEFER_MIN = '1';
    expect(drainTriageDeferMin()).toBe(5);
    process.env.DECISION_GATE_DRAIN_TRIAGE_DEFER_MIN = '500';
    expect(drainTriageDeferMin()).toBe(60);
    process.env.DECISION_GATE_DRAIN_TRIAGE_DEFER_MIN = 'nope';
    expect(drainTriageDeferMin()).toBe(15);
  });
});
