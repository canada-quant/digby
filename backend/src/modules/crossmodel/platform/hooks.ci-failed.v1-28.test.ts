/**
 * v1#28c (P5 publish-path remediation) — the `ci_failed` hook event type.
 *
 * Pins: registration in HOOK_EVENT_TYPES (subscribable via hook_subscribe /
 * the REST schema), deliberately NOT an alarm TYPE (per-lane work signal, not a
 * fleet smoke detector — no daily-cap bypass, no busy-target parking; only the
 * ci-watch ESCALATION row is alarm-class, by payload — hooks.service.test.ts),
 * and emission wiring (a subscribed hook receives a ci_failed outbox row).
 * Mock-everything preamble copied from hooks.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  eventHook: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(async () => ({})),
    delete: jest.fn(async () => ({})),
  },
  hookEvent: {
    create: jest.fn(async () => ({})),
    findMany: jest.fn(),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  crossModelChat: {
    findUnique: jest.fn(),
    update: jest.fn(async () => ({})),
    // CI-WATCH review fix: which project-hook targets are project-supervisor chats.
    findMany: jest.fn(async (args: any) => ((args?.where?.id?.in ?? []) as string[]).filter((id) => id === 'ps-chat').map((id) => ({ id }))),
  },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  activity: { create: jest.fn(async () => ({})) },
  $queryRaw: jest.fn(),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));
// error-handler imports config/env, which calls process.exit(1) without env
// vars and kills the jest worker at import time — mock AppError (same shape).
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
// platform.validation imports middleware/agent-auth → utils/jwt → config/env.
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('../crossmodel.service', () => ({ __esModule: true, default: {} }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: jest.fn(),
  dailyCapExceeded: jest.fn(async () => false),
  refundDailyCapToken: jest.fn(),
  notifyDailyCapOnce: jest.fn(),
}));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { CI_WATCH: 'ci_watch' },
}));
// CI-WATCH (2026-10-20): the project-supervisor gate's two probes.
const mockCiWatchDisabled = jest.fn(() => false);
const mockIsLaneLive = jest.fn(async (_chatId: string) => false);
jest.mock('../coding/ci-watch.service', () => ({
  __esModule: true,
  ciWatchDisabled: () => mockCiWatchDisabled(),
  isLaneLive: (chatId: string) => mockIsLaneLive(chatId),
}));
// The stock project-supervisor event universe (the real module drags the whole supervisor graph in).
jest.mock('./project-supervisor.service', () => {
  const STOCK = new Set(['run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'schedule_cap_skipped', 'schedule_disabled', 'todo_done', 'schedule_near_cap', 'ci_failed']);
  return { __esModule: true, isStockProjectHookEventSet: (t: string[]) => t.length > 0 && t.every((x) => STOCK.has(x)) };
});

import { HOOK_EVENT_TYPES, ALARM_EVENT_TYPES, emitHookEvent, emitHookEventCounted, isAlarmEvent } from './hooks.service';
import { isPsFirstEventType } from './fleet-ps-first';
import { platformSubscribeHookSchema } from './platform.validation';
import { recordLoopMetric } from './loop-metrics.service';

describe('v1#28c: ci_failed hook event type', () => {
  it('is registered in HOOK_EVENT_TYPES (the vocabulary is now 9 types)', () => {
    expect(HOOK_EVENT_TYPES).toContain('ci_failed');
    expect(HOOK_EVENT_TYPES).toHaveLength(9);
  });

  it('is NOT alarm-class — a per-lane work signal gets no cap bypass or parking', () => {
    expect(ALARM_EVENT_TYPES as readonly string[]).not.toContain('ci_failed');
  });

  it('the REST subscribe schema accepts it (and still rejects unknown types)', () => {
    const base = { sourceChatId: '11111111-1111-4111-8111-111111111111', targetChatId: '22222222-2222-4222-8222-222222222222' };
    expect(platformSubscribeHookSchema.safeParse({ body: { ...base, eventTypes: ['ci_failed'] } }).success).toBe(true);
    expect(platformSubscribeHookSchema.safeParse({ body: { ...base, eventTypes: ['ci_exploded'] } }).success).toBe(false);
  });

  it('emission wiring: a hook subscribed to ci_failed receives the outbox row with the sha passthrough', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValueOnce([
      { id: 'h1', userId: 'u1', sourceChatId: 'chat-src', targetChatId: 'chat-tgt', eventTypes: ['ci_failed'], enabled: true },
    ]);
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ title: 'Lane', userId: 'u1', project: { supervised: true } });
    await emitHookEvent('chat-src', 'ci_failed', 'CI FAILED on pushed commit abc123: backend-tests', { sha: 'a'.repeat(40) });
    expect(mockPrisma.hookEvent.create).toHaveBeenCalledTimes(1);
    const row = mockPrisma.hookEvent.create.mock.calls[0][0].data;
    expect(row.eventType).toBe('ci_failed');
    expect(row.payload).toMatchObject({ eventType: 'ci_failed', sourceChatId: 'chat-src', sha: 'a'.repeat(40) });
  });
});

/**
 * CI-WATCH (2026-10-20): the project supervisor hears ci_failed LANE FIRST.
 * Its project-scope row is written only when the source lane is not live, or
 * when the emission carries the ci-watch escalation (the lane-first leg already
 * ran); a DIRECT hook (the lane's own subscriber) is never gated; the kill
 * switch drops project-scope ci_failed rows; a probe failure delivers.
 */
describe('CI-WATCH: project-scope ci_failed routing (lane first, then the supervisor)', () => {
  const hooks = [
    // The ci-watch-provisioned hook: project scope, a project-supervisor target, stock types only.
    { id: 'h-ps', userId: 'u1', sourceChatId: null, projectId: 'p1', targetChatId: 'ps-chat', eventTypes: ['run_completed', 'ci_failed'], enabled: true },
    { id: 'h-direct', userId: 'u1', sourceChatId: 'lane-1', projectId: null, targetChatId: 'parent-chat', eventTypes: ['ci_failed'], enabled: true },
  ];
  // Hand-made project hooks: never gated (delivered exactly as before ci-watch).
  const handMadeOther = { id: 'h-other', userId: 'u1', sourceChatId: null, projectId: 'p1', targetChatId: 'dashboard-chat', eventTypes: ['ci_failed'], enabled: true };
  const handMadePs = { id: 'h-ps-custom', userId: 'u1', sourceChatId: null, projectId: 'p1', targetChatId: 'ps-chat', eventTypes: ['ci_failed', 'merge_blocked'], enabled: true };
  const lane = { title: 'Lane', userId: 'u1', projectId: 'p1', isProjectSupervisor: false, isSupervisor: false, codingState: { id: 'lane-1' }, project: { supervised: true, projectSupervisorEnabled: true } };
  const targets = () => mockPrisma.hookEvent.create.mock.calls.map((c: any[]) => c[0].data.hookId);

  beforeEach(() => {
    jest.clearAllMocks();
    mockCiWatchDisabled.mockReturnValue(false);
    mockIsLaneLive.mockResolvedValue(false);
    mockPrisma.eventHook.findMany.mockResolvedValue(hooks);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(lane);
  });

  it('lane LIVE (its own in-run check_ci): the supervisor row is withheld; the direct subscriber still gets it', async () => {
    mockIsLaneLive.mockResolvedValue(true);
    await emitHookEvent('lane-1', 'ci_failed', 'CI FAILED on pushed commit abc: tests', { sha: 'a'.repeat(40) });
    expect(mockIsLaneLive).toHaveBeenCalledWith('lane-1');
    expect(targets()).toEqual(['h-direct']);
    expect(recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci_watch', meta: expect.objectContaining({ phase: 'ps_row_skipped', reason: 'lane_live' }) }));
  });

  it('lane idle: the supervisor row is written', async () => {
    await emitHookEvent('lane-1', 'ci_failed', 'CI FAILED on pushed commit abc: tests', { sha: 'a'.repeat(40) });
    expect(targets().sort()).toEqual(['h-direct', 'h-ps']);
  });

  it('a ci-watch escalation delivers to the supervisor even while the lane is live (no liveness probe)', async () => {
    mockIsLaneLive.mockResolvedValue(true);
    await emitHookEvent('lane-1', 'ci_failed', 'CI FAILED … ci-watch woke the lane', { sha: 'a'.repeat(40), ciWatchEscalation: 'max_hold' });
    expect(mockIsLaneLive).not.toHaveBeenCalled();
    expect(targets().sort()).toEqual(['h-direct', 'h-ps']);
    const ps = mockPrisma.hookEvent.create.mock.calls.find((c: any[]) => c[0].data.hookId === 'h-ps')[0].data;
    expect(ps.payload).toMatchObject({ eventType: 'ci_failed', ciWatchEscalation: 'max_hold', sha: 'a'.repeat(40) });
  });

  it('kill switch CI_WATCH_DISABLED=1: only the ci-watch-provisioned supervisor hook drops ci_failed; every other subscriber delivers as before', async () => {
    mockCiWatchDisabled.mockReturnValue(true);
    mockPrisma.eventHook.findMany.mockResolvedValue([...hooks, handMadeOther, handMadePs]);
    await emitHookEvent('lane-1', 'ci_failed', 'CI FAILED', { sha: 'a'.repeat(40) });
    expect(targets().sort()).toEqual(['h-direct', 'h-other', 'h-ps-custom']);
    expect(mockIsLaneLive).not.toHaveBeenCalled();
  });

  it('the lane-live gate covers ONLY the ci-watch-provisioned hook — a hand-made project hook (other target / custom types) still hears the in-run emission', async () => {
    mockIsLaneLive.mockResolvedValue(true);
    mockPrisma.eventHook.findMany.mockResolvedValue([...hooks, handMadeOther, handMadePs]);
    await emitHookEvent('lane-1', 'ci_failed', 'CI FAILED on pushed commit abc: tests', { sha: 'a'.repeat(40) });
    expect(targets().sort()).toEqual(['h-direct', 'h-other', 'h-ps-custom']);
  });

  it('a target-classification failure delivers (fail toward delivery)', async () => {
    mockIsLaneLive.mockResolvedValue(true);
    mockPrisma.crossModelChat.findMany.mockRejectedValueOnce(new Error('db down'));
    await emitHookEvent('lane-1', 'ci_failed', 'CI FAILED', { sha: 'a'.repeat(40) });
    expect(targets().sort()).toEqual(['h-direct', 'h-ps']);
  });

  it('emitHookEventCounted reports rows written (the ci-watch escalation knows who heard it) and a failed emission', async () => {
    expect(await emitHookEventCounted('lane-1', 'ci_failed', 'CI FAILED', { sha: 'a'.repeat(40), ciWatchEscalation: 'lane_idle' })).toEqual({ written: 2, error: false });
    mockPrisma.eventHook.findMany.mockResolvedValueOnce([]);
    expect(await emitHookEventCounted('lane-1', 'ci_failed', 'CI FAILED', { sha: 'a'.repeat(40) })).toEqual({ written: 0, error: false });
    mockPrisma.hookEvent.create.mockRejectedValue(new Error('insert failed'));
    expect(await emitHookEventCounted('lane-1', 'ci_failed', 'CI FAILED', { sha: 'a'.repeat(40), ciWatchEscalation: 'lane_idle' })).toEqual({ written: 0, error: true });
    mockPrisma.hookEvent.create.mockImplementation(async () => ({}));
    mockPrisma.eventHook.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await emitHookEventCounted('lane-1', 'ci_failed', 'CI FAILED', { sha: 'a'.repeat(40) })).toEqual({ written: 0, error: true });
  });

  it('fail toward delivery: a liveness probe failure writes the supervisor row', async () => {
    mockIsLaneLive.mockRejectedValue(new Error('redis down'));
    await emitHookEvent('lane-1', 'ci_failed', 'CI FAILED', { sha: 'a'.repeat(40) });
    expect(targets().sort()).toEqual(['h-direct', 'h-ps']);
  });

  it('r2 interactions: the alarm-class escalation is never held PS-first — ci_failed is no PS-first type, so a Fleet hears it only through a hook wired to ci_failed, at once (no delayed todo_wake)', async () => {
    expect(isPsFirstEventType('ci_failed')).toBe(false);
    expect(isAlarmEvent('ci_failed', { ciWatchEscalation: 'lane_loop' })).toBe(true);
    const fleetCustom = { id: 'h-fleet', userId: 'u1', sourceChatId: null, projectId: null, targetChatId: 'fleet-chat', eventTypes: ['run_failed', 'ci_failed'], enabled: true };
    mockPrisma.eventHook.findMany.mockResolvedValue([...hooks, fleetCustom]);
    await emitHookEvent('lane-1', 'ci_failed', 'CI FAILED … ci-watch woke the lane', { sha: 'a'.repeat(40), ciWatchEscalation: 'lane_loop' });
    expect(targets().sort()).toEqual(['h-direct', 'h-fleet', 'h-ps']);
    expect(mockPrisma.hookEvent.create.mock.calls.every((c: any[]) => c[0].data.eventType === 'ci_failed')).toBe(true);
  });

  it('other event types never consult the gate', async () => {
    mockPrisma.eventHook.findMany.mockResolvedValue(hooks.map((h) => ({ ...h, eventTypes: ['run_failed'] })));
    await emitHookEvent('lane-1', 'run_failed', 'run failed', {});
    expect(mockIsLaneLive).not.toHaveBeenCalled();
    expect(mockCiWatchDisabled).not.toHaveBeenCalled();
  });
});
