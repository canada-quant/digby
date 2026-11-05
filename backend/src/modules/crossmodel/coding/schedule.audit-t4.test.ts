/**
 * audit 2026-10-06 — team T4 (schedules & supervisor cadence) pins for
 * coding/schedule.service.ts:
 *   T4-2 schedule_disabled carries the ACTOR (actorChatId) of a tool-driven
 *        cancel / pause — absent for owner / system disables; kill switch
 *        SCHEDULE_DISABLED_ACTOR_DISABLED=1.
 *   T4-6 a fast-lane [HARNESS CONTINUATION] is framed as a continuation of the
 *        finalizing run (no "scheduled firing", no "≥15 minutes old");
 *        kill switch CONTINUATION_FRAMING_DISABLED=1.
 *   T4-8 one sweep per supervisor chat: a machine sweep-shaped recurring arm
 *        beside the enabled stock sweep is refused with the update_schedule
 *        next step; a stock-sweep firing retires the chat's other
 *        machine/system sweep-shaped rows; kill switch
 *        SUPERVISOR_ONE_SWEEP_DISABLED=1.
 * Harness mirrors schedule.near-cap.b4d1096c.test.ts (mock-everything).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreate = jest.fn();
const mockCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockUpdate = jest.fn(async (...a: any[]): Promise<any> => ({ ...(a[0]?.data ?? {}), id: a[0]?.where?.id }));
const mockUpdateMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 1 }));
const mockScheduleFindUnique = jest.fn(async (..._args: any[]): Promise<any> => ({ enabled: true }));
const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-cont-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockActivityCreate = jest.fn(async (..._a: any[]): Promise<any> => ({}));
const mockRunFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTodoFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);

jest.mock('../../../config/database', () => {
  const db: any = {
    chatSchedule: {
      create: (...a: any[]) => mockCreate(...a),
      count: (...a: any[]) => mockCount(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      findFirst: (...a: any[]) => mockFindFirst(...a),
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      update: (...a: any[]) => mockUpdate(...a),
      updateMany: (...a: any[]) => mockUpdateMany(...a),
    },
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      findMany: (...a: any[]) => mockRunFindMany(...a),
      create: (...a: any[]) => mockRunCreate(...a),
      count: (...a: any[]) => mockRunCount(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: jest.fn(async () => ({})) },
    crossModelMessage: { create: jest.fn(async () => ({})) },
    activity: { create: (...a: any[]) => mockActivityCreate(...a) },
    // ALARM-CAUSE-AWARE (2026-10-20): assigned todos exist for the self-stop test but never count as live work
    // (platform/lane-self-driving.ts reads runs + schedules only — review fix 2026-10-20).
    projectTodo: { findMany: (...a: any[]) => mockTodoFindMany(...a) },
    todoDependency: { findMany: jest.fn(async () => []) },
  };
  db.$transaction = async (fn: any) => fn(db);
  return { __esModule: true, default: db };
});

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), get: jest.fn(async () => null),
    getDel: jest.fn(async () => null), pTTL: jest.fn(async () => -2), incr: jest.fn(async () => 1),
    incrBy: jest.fn(async () => 1), expire: jest.fn(async () => {}), decr: jest.fn(async () => {}),
  },
}));

jest.mock('../platform/autonomy.service', () => ({ __esModule: true, getChatAutonomy: jest.fn(async () => null) }));

const mockEmitHookEvent = jest.fn(async (..._args: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  sweepHookEvents: jest.fn(async () => {}),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { WAKE_DELIVERED: 'wake_delivered', SCHEDULE_BUSY_SKIP: 'schedule_busy_skip', SCHEDULE_CLOCK_DRIFT: 'schedule_clock_drift', SCHEDULE_ONCE_CHAIN: 'schedule_once_chain' },
}));

jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: jest.fn(),
  maybeFileStoppedScheduleDecision: jest.fn(async () => ({ filed: false, reason: 'lane_alive' })),
}));
jest.mock('../platform/owner-questions', () => ({ __esModule: true, resolveStoppedScheduleDecisionsForSession: jest.fn(async () => 0) }));
jest.mock('../../../middleware/agent-auth', () => ({ __esModule: true, AGENT_TOKEN_SCOPES: ['chats:read'] as const }));

const mockGetPlanStrict = jest.fn(async (..._args: any[]) => ({ steps: [{ status: 'pending' }] }) as any);
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: (...a: any[]) => mockGetPlanStrict(...a),
}));
jest.mock('./continuation-guard', () => ({ __esModule: true, isSessionArchived: async () => false }));
jest.mock('./spend-cap.service', () => ({ __esModule: true, consumeSpendCapSkipNotice: async () => 0, restoreSpendCapSkipNotice: async () => {} }));
jest.mock('./infra-blockers.service', () => ({ __esModule: true, appendInfraBlockerNotice: async (p: string) => p }));
jest.mock('./terminal-stop', () => ({
  __esModule: true,
  ...(jest.requireActual('./terminal-stop')),
}));

import {
  cancelScheduleForUser, setScheduleEnabledForChat, emitScheduleDisabled,
  queueContinuationRun, createSchedule, foldDuplicateSweepsAtFire, sweepShapedPrompt,
} from './schedule.service';
import { continuationPrompt } from './plan.service';
import { PROJECT_SWEEP_PROMPT_OPENER } from '../platform/supervisor-doctrine';

const ENV = ['SCHEDULE_DISABLED_ACTOR_DISABLED', 'CONTINUATION_FRAMING_DISABLED', 'SUPERVISOR_ONE_SWEEP_DISABLED', 'HOOK_ALARM_CAUSE_AWARE_DISABLED'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const disabledEmits = () => mockEmitHookEvent.mock.calls.filter((c: any[]) => c[1] === 'schedule_disabled');

describe('T4-2 — schedule_disabled carries the actor chat (actorChatId)', () => {
  const ROW = { id: 'sch-lane-1', sessionId: 'lane-1', userId: 'u1', kind: 'recurring', runsCount: 4, enabled: true, prompt: 'p' };

  it('a tool-driven cancel names the cancelling chat; an owner/REST cancel carries none', async () => {
    mockFindFirst.mockResolvedValue({ ...ROW });
    await cancelScheduleForUser('u1', 'sch-lane-1', { initiator: 'machine', actorChatId: 'sup-1' });
    expect(disabledEmits()[0][3]).toMatchObject({ scheduleId: 'sch-lane-1', reason: 'cancelled', actorChatId: 'sup-1' });

    mockEmitHookEvent.mockClear();
    await cancelScheduleForUser('u1', 'sch-lane-1', { initiator: 'owner' });
    expect(disabledEmits()[0][3]).not.toHaveProperty('actorChatId');
  });

  it('pause (setScheduleEnabledForChat) names the pausing chat', async () => {
    mockFindFirst.mockResolvedValue({ ...ROW });
    await setScheduleEnabledForChat('lane-1', 'sch-lane-1', false, { actorChatId: 'sup-1' });
    expect(disabledEmits()[0][3]).toMatchObject({ reason: 'paused', actorChatId: 'sup-1' });
  });

  it('kill switch SCHEDULE_DISABLED_ACTOR_DISABLED=1 drops the field (pre-fix emission)', async () => {
    process.env.SCHEDULE_DISABLED_ACTOR_DISABLED = '1';
    await emitScheduleDisabled({ id: 'x', sessionId: 'lane-1', kind: 'recurring' }, 'cancelled', 1, { actorChatId: 'sup-1' });
    expect(disabledEmits()[0][3]).not.toHaveProperty('actorChatId');
  });
});

describe('ALARM-CAUSE-AWARE (2026-10-20) — a lane self-stop names its live work', () => {
  it('a lane cancelling its OWN schedule while another schedule is armed ⇒ stoppedByChatId + laneLiveWork:true (a quiet row in hooks.service)', async () => {
    mockCount.mockResolvedValueOnce(1); // remainingEnabled: the other schedule
    mockFindMany.mockImplementation(async (args: any) => (args?.where?.enabled === true && args?.where?.sessionId?.in ? [{ sessionId: 'lane-1' }] : []));
    await emitScheduleDisabled({ id: 'x', sessionId: 'lane-1', kind: 'recurring' }, 'cancelled', 3, { actorChatId: 'lane-1' });
    expect(disabledEmits()[0][3]).toMatchObject({ actorChatId: 'lane-1', stoppedByChatId: 'lane-1', laneLiveWork: true, remainingEnabled: 1 });
    // The armed-schedule read is unbounded for a self-stop (any enabled schedule keeps the lane alive).
    const q = mockFindMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.sessionId?.in);
    expect(q.where.nextRunAt).toBeUndefined();
    mockFindMany.mockReset(); mockFindMany.mockImplementation(async () => []);
  });

  it('the lane\'s own RUNNING run does not count; nothing left ⇒ laneLiveWork:false (the alarm stands)', async () => {
    mockRunFindMany.mockResolvedValueOnce([{ sessionId: 'lane-1', status: 'running' }]);
    await emitScheduleDisabled({ id: 'x', sessionId: 'lane-1', kind: 'recurring' }, 'cancelled', 3, { actorChatId: 'lane-1' });
    expect(disabledEmits()[0][3]).toMatchObject({ stoppedByChatId: 'lane-1', laneLiveWork: false });
  });

  it('review fix 2026-10-20: cancelling the LAST schedule while holding an in_progress todo is the DEAF lane — never quiet; nor with a queued run', async () => {
    // The TT-RD shape: an in_progress assigned todo, no other schedule — the summary says DEAF and the alarm must stand.
    mockTodoFindMany.mockResolvedValue([{ id: 't1', status: 'in_progress', assigneeChatId: 'lane-1' }]);
    await emitScheduleDisabled({ id: 'x', sessionId: 'lane-1', kind: 'recurring' }, 'cancelled', 3, { actorChatId: 'lane-1' });
    const [, , summary, payload] = disabledEmits()[0];
    expect(String(summary)).toContain('DEAF');
    expect(payload).toMatchObject({ stoppedByChatId: 'lane-1', laneLiveWork: false, remainingEnabled: 0 });
    // Zero enabled schedules left is never quiet, even with a queued run (the run ends; the standing work stays deaf).
    mockEmitHookEvent.mockClear();
    mockRunFindMany.mockResolvedValueOnce([{ sessionId: 'lane-1', status: 'queued' }]);
    await emitScheduleDisabled({ id: 'x', sessionId: 'lane-1', kind: 'recurring' }, 'paused', 3, { actorChatId: 'lane-1' });
    expect(disabledEmits()[0][3]).toMatchObject({ stoppedByChatId: 'lane-1', laneLiveWork: false });
    mockTodoFindMany.mockReset(); mockTodoFindMany.mockImplementation(async () => []);
  });

  it('another actor, a successor rollover, or the kill switch ⇒ no self-stop fields', async () => {
    await emitScheduleDisabled({ id: 'x', sessionId: 'lane-1', kind: 'recurring' }, 'cancelled', 3, { actorChatId: 'sup-1' });
    await emitScheduleDisabled({ id: 'x', sessionId: 'lane-1', kind: 'recurring' }, 'max_runs', 3, { actorChatId: 'lane-1', successorId: 'succ-1' });
    process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED = '1';
    await emitScheduleDisabled({ id: 'x', sessionId: 'lane-1', kind: 'recurring' }, 'cancelled', 3, { actorChatId: 'lane-1' });
    for (const c of disabledEmits()) {
      expect(c[3]).not.toHaveProperty('stoppedByChatId');
      expect(c[3]).not.toHaveProperty('laneLiveWork');
    }
  });
});

describe('T4-6 — continuation fast lane is framed as a continuation', () => {
  beforeEach(() => {
    mockRunFindFirst.mockImplementation(async (args: any) => (args?.where?.status === 'running' ? { id: 'abcdef12-3456-7890-abcd-ef1234567890' } : null));
    mockCount.mockResolvedValue(0);
  });

  it('header names the finalizing run, the count sentence drops "≥15 minutes old", RunInput.continuationOf is set', async () => {
    const r = await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: continuationPrompt(1, 6, 4) });
    expect(r.ok).toBe(true);
    const { data } = mockRunCreate.mock.calls[0][0];
    expect(data.input.message).toMatch(/^\[MACHINE-TRIGGERED RUN — a harness continuation of run abcdef12 on this chat/);
    expect(data.input.message).not.toContain('scheduled firing');
    expect(data.input.message).not.toContain('≥15 minutes old');
    expect(data.input.message).toContain('The previous run (abcdef12) ended with 4 unfinished plan step(s)');
    expect(data.input.message).toContain('[HARNESS CONTINUATION r1/6]');
    expect(data.input.origin).toBe('schedule');
    expect(data.input.continuationOf).toBe('abcdef12-3456-7890-abcd-ef1234567890');
    // header stays ONE bracketed line (strip regex + UI WAKE_PREFIX contract)
    const firstLine = String(data.input.message).split('\n')[0];
    expect(firstLine.indexOf(']')).toBe(firstLine.length - 1);
  });

  it('kill switch CONTINUATION_FRAMING_DISABLED=1 restores the schedule framing byte-for-byte', async () => {
    process.env.CONTINUATION_FRAMING_DISABLED = '1';
    await queueContinuationRun({ sessionId: 's1', userId: 'u1', prompt: continuationPrompt(1, 6, 4) });
    const { data } = mockRunCreate.mock.calls[0][0];
    expect(data.input.message).toMatch(/^\[MACHINE-TRIGGERED RUN — a scheduled firing of a recurring\/one-shot schedule/);
    expect(data.input.message).toContain('A previous run ended with 4 unfinished plan step(s), but that snapshot is ≥15 minutes old');
    expect(data.input).not.toHaveProperty('continuationOf');
  });
});

describe('T4-8 — one sweep per supervisor chat', () => {
  const STOCK = `${PROJECT_SWEEP_PROMPT_OPENER} for "tt-rd" (projectId p1) — a GOAL LEDGER diff, not a status bulletin.`;
  const stockRow = { id: 'stock-1', sessionId: 'sup', prompt: STOCK, kind: 'recurring', intervalSec: 14_400, runsCount: 5, maxRuns: 500, enabled: true, promptSetBy: 'system', createdAt: new Date(), nextRunAt: new Date(), expiresAt: null };

  it('sweepShapedPrompt: stock openers and "sweep" in the first words; polls / watches are not sweeps', () => {
    expect(sweepShapedPrompt(STOCK)).toBe(true);
    expect(sweepShapedPrompt('Project sweep every 3h per OWNER DIRECTIVE: diff the ledger')).toBe(true);
    expect(sweepShapedPrompt('[OWNER DIRECTIVE] Fleet sweep (3h)')).toBe(true);
    expect(sweepShapedPrompt('Wind-down poll: check lane X before the next sweep')).toBe(false);
    expect(sweepShapedPrompt('Upstream watch: llama.cpp releases')).toBe(false);
  });

  it('ARM: a machine sweep-shaped recurring arm beside the enabled stock sweep is REFUSED with the update_schedule next step (nothing created, the stock row untouched)', async () => {
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false, isProjectSupervisor: true });
    mockFindMany.mockResolvedValue([{ ...stockRow }]);
    const res = await createSchedule({ sessionId: 'sup', userId: 'u1', prompt: 'Project sweep every 3h per OWNER DIRECTIVE: diff the ledger', kind: 'recurring', intervalSec: 10_800, promptSetBy: 'machine' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('one sweep per supervisor');
    expect(res.error).toContain('update_schedule({id:"stock-1", intervalMinutes:180})');
    expect(res.error).toContain('every 240 min');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'supervisor_sweep_folded', meta: expect.objectContaining({ seam: 'arm', outcome: 'refused_second_sweep', stockId: 'stock-1', requestedSec: 10_800 }) }));
  });

  it('ARM: a below-floor request names the floor in the next step; an OWNER arm and a non-supervisor chat are never refused', async () => {
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false, isProjectSupervisor: true });
    mockFindMany.mockResolvedValue([{ ...stockRow }]);
    const res = await createSchedule({ sessionId: 'sup', userId: 'u1', prompt: 'Project sweep — every 30 min', kind: 'recurring', intervalSec: 1800, promptSetBy: 'machine' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('intervalMinutes:120})');
    expect(res.error).toContain('machine floor for stock sweeps: 120 min');

    mockCreate.mockReset().mockResolvedValue({ ...stockRow, id: 'new-owner', prompt: 'Project sweep every 3h', promptSetBy: 'user' });
    const owner = await createSchedule({ sessionId: 'sup', userId: 'u1', prompt: 'Project sweep every 3h', kind: 'recurring', intervalSec: 10_800, promptSetBy: 'user' });
    expect(owner.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    mockCreate.mockClear();
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false, isProjectSupervisor: false });
    const lane = await createSchedule({ sessionId: 'lane', userId: 'u1', prompt: 'Project sweep every 3h', kind: 'recurring', intervalSec: 10_800, promptSetBy: 'machine' });
    expect(lane.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('ARM kill switch SUPERVISOR_ONE_SWEEP_DISABLED=1: the second sweep is created as before', async () => {
    process.env.SUPERVISOR_ONE_SWEEP_DISABLED = '1';
    mockChatFindUnique.mockResolvedValue({ isSupervisor: false, isProjectSupervisor: true });
    mockFindMany.mockResolvedValue([{ ...stockRow }]);
    mockCreate.mockReset().mockResolvedValue({ ...stockRow, id: 'm-new', prompt: 'Project sweep every 3h' });
    const res = await createSchedule({ sessionId: 'sup', userId: 'u1', prompt: 'Project sweep every 3h', kind: 'recurring', intervalSec: 10_800, promptSetBy: 'machine' });
    expect(res.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'supervisor_sweep_folded' }));
  });

  it('HEAL: a stock-sweep firing retires the other MACHINE/SYSTEM sweep-shaped rows only (non-alarm event with successorId)', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'm1', prompt: 'Project sweep every 3h per OWNER DIRECTIVE', kind: 'recurring', runsCount: 15, promptSetBy: 'machine', intervalSec: 10_800 },
      { id: 'w1', prompt: 'Wind-down poll: check lane X', kind: 'recurring', runsCount: 18, promptSetBy: 'machine', intervalSec: 2700 },
      { id: 'o1', prompt: 'Sweep the weekly report', kind: 'recurring', runsCount: 2, promptSetBy: 'user', intervalSec: 86_400 },
    ]);
    const out = await foldDuplicateSweepsAtFire({ id: 'stock-1', sessionId: 'sup', prompt: STOCK, kind: 'recurring' });
    expect(out).toEqual(['m1']);
    expect(mockUpdateMany).toHaveBeenCalledWith({ where: { id: 'm1', enabled: true }, data: expect.objectContaining({ enabled: false, lastStatus: 'cancelled', cancelledBy: 'machine' }) });
    expect(disabledEmits()).toHaveLength(1);
    expect(disabledEmits()[0][3]).toMatchObject({ scheduleId: 'm1', successorId: 'stock-1' });
    expect(disabledEmits()[0][2]).toContain('the stock sweep stock-1 is the one sweep');
    expect(disabledEmits()[0][2]).toContain('update_schedule({id:"stock-1", intervalMinutes:180})');
    expect(disabledEmits()[0][2]).not.toContain('same-cadence successor');
  });

  it('HEAL: a non-stock firing or the kill switch does nothing', async () => {
    mockFindMany.mockResolvedValue([{ id: 'm1', prompt: 'Project sweep every 3h', kind: 'recurring', runsCount: 1, promptSetBy: 'machine' }]);
    expect(await foldDuplicateSweepsAtFire({ id: 'x', sessionId: 'sup', prompt: 'Project sweep every 3h', kind: 'recurring' })).toEqual([]);
    process.env.SUPERVISOR_ONE_SWEEP_DISABLED = '1';
    expect(await foldDuplicateSweepsAtFire({ id: 'stock-1', sessionId: 'sup', prompt: STOCK, kind: 'recurring' })).toEqual([]);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
