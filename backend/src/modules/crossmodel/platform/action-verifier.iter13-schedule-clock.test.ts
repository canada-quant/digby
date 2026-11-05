/**
 * Operator iteration 13 (2026-09-25) — the machine-wake clock guard treats the
 * owner's enabled schedules' fire times as quoted forward data
 * (scheduleClockHaystack), whether or not THIS run listed them.
 *
 * Incident (Fleet Supervisor c0e22e36, 10:46:17Z): "| canlegal-bench |
 * Unchanged — harvest waits on your morning Mac paste | morning nudge 7:31 AM
 * PDT |" struck +229 min; the morning nudge IS a real enabled schedule
 * (nextRunAt 14:31Z). The reject-back retry came back clean at ≈4 min.
 * Boundary-mocked like the sibling incident pins; the REAL guard executes.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a) }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: jest.fn(async () => {}),
  getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })),
}));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import { guardMachineWakeFinalAnswer, scheduleClockHaystack } from './action-verifier';

const CHAT = 'c0e22e36-1c74-4295-8049-9b48335c6c37';
const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
const NOW = new Date('2026-09-25T10:46:17.195Z');
const NOTE = [
  '**Fleet sweep — 3:46 AM PDT (10:46Z)**',
  '',
  '| Project | Status | Next |',
  '|---|---|---|',
  '| canlegal-bench | Unchanged — harvest waits on your morning Mac paste | morning nudge 7:31 AM PDT |',
].join('\n');
const NUDGE = { id: '3f9a2c11-5b6e-4d7f-8a9b-0c1d2e3f4a5b', nextRunAt: new Date('2026-09-25T14:31:12.000Z'), lastFiredAt: new Date('2026-09-24T14:31:15.000Z') };

const guard = (extra: Record<string, unknown> = {}) =>
  guardMachineWakeFinalAnswer({
    chatId: CHAT, userId: OWNER, finalText: NOTE, parts: [] as any, receipts: [],
    runStartedAt: new Date('2026-09-25T10:44:00.000Z'), machineTriggered: true, now: NOW, ...extra,
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
});

describe('schedule-clock haystack (operator iteration 13)', () => {
  // build 2026-10-08 Q-3: pins the LEGACY replace lane (FUTURE_CLOCK_REPLACE_ENABLED=1 restore path);
  // the default clock policy is pinned in action-verifier.future-clock-policy.q3.test.ts.
  beforeAll(() => { process.env.FUTURE_CLOCK_REPLACE_ENABLED = '1'; });
  afterAll(() => { delete process.env.FUTURE_CLOCK_REPLACE_ENABLED; });
  it('PRE-FIX SHAPE: with no schedule row the incident note still strikes +229 min', async () => {
    const res = await guard();
    expect(res.struck).toBe(true);
    expect(res.futureClocks?.map((h) => h.token)).toEqual(['7:31 AM PDT']);
    expect(res.futureClocks?.[0].minutesAhead).toBe(225);
  });

  it('REPLAY: the enabled morning-nudge schedule (nextRunAt 14:31Z) exonerates "7:31 AM PDT" — note delivered unmodified', async () => {
    mockPrisma.chatSchedule.findMany.mockResolvedValue([NUDGE]);
    const res = await guard();
    expect(res.struck).toBe(false);
    expect(res.finalText).toBe(NOTE);
    const where = mockPrisma.chatSchedule.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe(OWNER);
    expect(where.enabled).toBe(true);
  });

  it('per-STAMP: a schedule at another time exonerates nothing, and a co-line invented clock still convicts next to a real fire time', async () => {
    // (a recurring schedule's lastFiredAt shares its fire time-of-day, so the
    // other-time row moves BOTH stamps — the clock-only stamp asserts no day)
    mockPrisma.chatSchedule.findMany.mockResolvedValue([{ ...NUDGE, nextRunAt: new Date('2026-09-25T16:00:00.000Z'), lastFiredAt: new Date('2026-09-24T16:00:03.000Z') }]);
    expect((await guard()).struck).toBe(true);
    mockPrisma.chatSchedule.findMany.mockResolvedValue([NUDGE]);
    const res = await guard({ finalText: NOTE + '\n- box probe read clean 5:15 AM PDT' });
    expect(res.struck).toBe(true);
    expect(res.futureClocks?.map((h) => h.token)).toEqual(['5:15 AM PDT']);
  });

  it('a DB error fails open to [] (the haystack is armed)', async () => {
    mockPrisma.chatSchedule.findMany.mockRejectedValue(new Error('db down'));
    expect(await scheduleClockHaystack(OWNER)).toEqual([]);
    expect((await guard()).struck).toBe(true);
  });

  it('haystack shape carries the instants the cross-format leg reads', async () => {
    mockPrisma.chatSchedule.findMany.mockResolvedValue([NUDGE]);
    const hs = await scheduleClockHaystack(OWNER);
    expect(hs).toEqual(['[harness schedule 3f9a2c11] nextRunAt 2026-09-25T14:31:12.000Z lastFiredAt 2026-09-24T14:31:15.000Z']);
  });
});
