/**
 * Replay pin — finding B1 (coding schedules / schedule_self chaining,
 * 2026-09-27, bench lane 66f0b0c9).
 *
 * THE INCIDENT: a lane re-armed a fresh `once` row from EVERY firing's run —
 * 29 one-shots in 26h, 35 identical SSM probes, $3.03/run, every row "GRID-
 * GATED :3001 REDEPLOY RESUME" — and no recurring control ever saw it: the
 * duplicate-backstop guard scans `kind: input.kind` only; the dormancy gate
 * and renew accounting are recurring-only; maxRuns is 1 so the cap-cadence
 * guard projects nothing; a busy one-shot rides queue-behind-busy instead of
 * the busy-skip accounting.
 *
 * THE FIX (this file pins it): a firing's own schedule id rides the run's
 * ToolContext (firedByScheduleId); schedule_self / own-chat schedule_message
 * pass it as chainedFromScheduleId; createSchedule same-session-checks and
 * STAMPS it, walks the chain over a rolling 24h window, and a chain of ≥3
 * links is RECURRING-LIKE: cap-cadence math on the chain's OBSERVED cadence
 * (a warning for the can-never-fit class — observe-only), dedupe against an
 * enabled recurring twin, a loud advisory on the arm response, the fire-time
 * dormancy check (observe-only), and the busy re-arm + busySkips accounting
 * instead of queue-behind-busy. loop_metrics schedule_once_chain records
 * every link.
 *
 * Mock boundary mirrors schedule-queue-behind-busy.3405e332.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockScheduleFindUnique = jest.fn(async (..._args: any[]): Promise<any> => ({ enabled: true }));
const mockScheduleFindFirst = jest.fn(async (..._args: any[]): Promise<any> => null);
const mockScheduleFindMany = jest.fn(async (..._args: any[]): Promise<any[]> => []);
const mockScheduleCount = jest.fn(async (..._args: any[]): Promise<number> => 0);
const mockScheduleCreate = jest.fn(async (...args: any[]): Promise<any> => ({ id: 'sch_new', createdAt: new Date(), ...(args[0]?.data ?? {}) }));
const mockScheduleUpdate = jest.fn(async (...a: any[]): Promise<any> => ({ ...a[0]?.data, id: a[0]?.where?.id ?? 'sch_1' }));
const mockScheduleUpdateMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 1 }));
const mockScheduleDeleteMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 0 }));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));

jest.mock('../../../config/database', () => {
  const codingSchedule = {
    findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
    findFirst: (...a: any[]) => mockScheduleFindFirst(...a),
    findMany: (...a: any[]) => mockScheduleFindMany(...a),
    count: (...a: any[]) => mockScheduleCount(...a),
    create: (...a: any[]) => mockScheduleCreate(...a),
    update: (...a: any[]) => mockScheduleUpdate(...a),
    updateMany: (...a: any[]) => mockScheduleUpdateMany(...a),
    deleteMany: (...a: any[]) => mockScheduleDeleteMany(...a),
  };
  return {
    __esModule: true,
    default: {
      codingSchedule,
      $transaction: async (fn: any) => fn({ codingSchedule }),
      agentRun: {
        findFirst: (...a: any[]) => mockRunFindFirst(...a),
        create: (...a: any[]) => mockRunCreate(...a),
        count: (...a: any[]) => mockRunCount(...a),
      },
      schedulePromptHistory: {
        create: jest.fn(async () => ({ id: 'ph-1' })),
        count: jest.fn(async () => 0),
        findFirst: jest.fn(async () => null),
      },
      crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
      crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
      chatCodingState: { findUnique: jest.fn(async () => null) },
    },
  };
});

const mockSet = jest.fn(async (..._args: any[]): Promise<any> => 'OK');
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (...a: any[]) => mockSet(...a), del: jest.fn(async () => 1),
    get: jest.fn(async () => null), getDel: jest.fn(async () => null),
    pTTL: jest.fn(async () => -2), incr: jest.fn(async () => 1), incrBy: jest.fn(async () => 1),
    expire: jest.fn(async () => {}), decr: jest.fn(async () => {}),
  },
}));

const mockGetChatAutonomy = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  getChatAutonomy: (...a: any[]) => mockGetChatAutonomy(...a),
}));

jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: jest.fn(async () => {}),
  sweepHookEvents: jest.fn(async () => {}),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...(jest.requireActual('../platform/loop-metrics.service')),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: jest.fn(),
  maybeFileStoppedScheduleDecision: jest.fn(async () => ({ filed: false, reason: 'lane_alive' })),
}));

jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: jest.fn(async () => 0),
}));

jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: jest.fn(async () => null),
}));

const mockStartScheduledRun = jest.fn(async (..._args: any[]) => ({ started: true }) as any);
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

const mockStartDetachedChatRun = jest.fn((..._args: any[]): string | null => 'chat:s1');
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

const mockEnqueueChatMessage = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'pend-1', position: 1 }));
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  enqueueChatMessage: (...a: any[]) => mockEnqueueChatMessage(...a),
}));

jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  consumeSpendCapSkipNotice: jest.fn(async () => 0),
  restoreSpendCapSkipNotice: jest.fn(async () => {}),
  spendSkipNoticeText: (n: number) => `${n} spend-capped firing(s)`,
  checkSpendCap: jest.fn(async () => null),
  recordSpendCapSkip: jest.fn(async () => {}),
  maybeAskSpendCapQuestion: jest.fn(async () => {}),
}));

// Sweeper deps for the fire-time park case.
const mockEvaluateScheduleDormancy = jest.fn(async (..._a: any[]): Promise<any> => ({ dormant: false, reason: 'live' }));
jest.mock('./dormancy-gate.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./dormancy-gate.service')),
  evaluateScheduleDormancy: (...a: any[]) => mockEvaluateScheduleDormancy(...a),
}));
jest.mock('../platform/supervisor-switch', () => ({
  __esModule: true,
  ...(jest.requireActual('../platform/supervisor-switch')),
  supervisorWakeSkip: jest.fn(async () => null),
  supervisorWakeSkipById: jest.fn(async () => null),
}));
jest.mock('./retiring', () => ({ __esModule: true, isRetiring: () => false }));

import {
  walkOnceChain, chainCadenceSec, onceChainWarning,
  ONCE_CHAIN_RECURRING_LINKS, ONCE_CHAIN_WINDOW_MS,
} from './schedule-once-chain';
import { createSchedule, fireScheduleTarget, fireDue, MIN_INTERVAL_SEC } from './schedule.service';

const H = 3600_000;
// Real clock: createSchedule / fireDue read Date.now() themselves, so the chain
// rows must be relative to the same instant (a fixed timestamp would skew the
// observed cadence by the test's own age).
const now = Date.now();
const at = (hoursAgo: number) => new Date(now - hoursAgo * H);

/** A chain of `n` links, newest first, each armed `gapH` hours after the last; the newest is the parent of the link under test. */
function chainRows(n: number, gapH: number, opts: { intervalSec?: number } = {}) {
  const rows: any[] = [];
  for (let i = 0; i < n; i += 1) {
    rows.push({
      id: `link_${n - i}`,
      chainedFromScheduleId: n - i > 1 ? `link_${n - i - 1}` : null,
      createdAt: at(gapH * (i + 1)),
      intervalSec: opts.intervalSec ?? MIN_INTERVAL_SEC,
      kind: 'once',
      enabled: false,
      runsCount: 1,
      maxRuns: 1,
      prompt: 'GRID-GATED :3001 REDEPLOY RESUME',
    });
  }
  return rows;
}

describe('walkOnceChain (pure)', () => {
  it('no parent ⇒ no chain', () => {
    expect(walkOnceChain(chainRows(3, 1), null, now, now)).toMatchObject({ links: 0, recurringLike: false, rootId: null });
  });

  it('counts the new link + every ancestor inside the 24h window; the 3rd link is recurring-like', () => {
    const rows = chainRows(2, 1); // link_2 (1h ago) ← link_1 (2h ago)
    const v = walkOnceChain(rows, 'link_2', now, now);
    expect(v.links).toBe(3);
    expect(v.recurringLike).toBe(true);
    expect(v.rootId).toBe('link_1');
    expect(v.observedCadenceSec).toBe(3600); // 2h span / 2 gaps
  });

  it('a parent older than the window ends the walk — 2 links is not recurring-like', () => {
    const rows = [
      { id: 'p', chainedFromScheduleId: 'gp', createdAt: at(2), intervalSec: 900 },
      { id: 'gp', chainedFromScheduleId: null, createdAt: new Date(now - ONCE_CHAIN_WINDOW_MS - H), intervalSec: 900 },
    ];
    const v = walkOnceChain(rows, 'p', now, now);
    expect(v.links).toBe(2);
    expect(v.recurringLike).toBe(false);
  });

  it('a cycle in hostile data terminates', () => {
    const rows = [
      { id: 'a', chainedFromScheduleId: 'b', createdAt: at(1), intervalSec: 900 },
      { id: 'b', chainedFromScheduleId: 'a', createdAt: at(2), intervalSec: 900 },
    ];
    expect(walkOnceChain(rows, 'a', now, now).links).toBe(3);
  });

  it('chainCadenceSec is the larger of the requested delay and the observed cadence', () => {
    const v = walkOnceChain(chainRows(2, 1), 'link_2', now, now); // observed 3600
    expect(chainCadenceSec(900, v)).toBe(3600);
    expect(chainCadenceSec(7200, v)).toBe(7200);
    expect(chainCadenceSec(900, { links: 1, recurringLike: false, observedCadenceSec: null, rootId: null })).toBe(900);
  });

  it('the advisory names the link count and the observed cadence', () => {
    const v = walkOnceChain(chainRows(2, 1), 'link_2', now, now);
    const w = onceChainWarning(v, 900)!;
    expect(w).toMatch(/ONE-SHOT CHAIN: this is link 3/);
    expect(w).toMatch(/~60 min/);
    expect(w).toMatch(/ONE recurring schedule/);
    expect(ONCE_CHAIN_RECURRING_LINKS).toBe(3);
  });
});

describe('createSchedule — one-shot chain links (finding B1)', () => {
  const base = { sessionId: 's1', userId: 'u1', prompt: 'GRID-GATED :3001 REDEPLOY RESUME', kind: 'once' as const, intervalSec: MIN_INTERVAL_SEC, promptSetBy: 'machine' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleFindMany.mockImplementation(async (args: any) => (args?.where?.kind === 'once' && args?.select?.chainedFromScheduleId ? [] : []));
    mockScheduleFindFirst.mockResolvedValue(null);
    mockScheduleCount.mockResolvedValue(0);
  });

  /** Route the two findMany shapes: the chain walk (select + kind 'once') vs the dedupe scan (enabled: true). */
  function routeFindMany(chain: any[], enabledRows: any[] = []) {
    mockScheduleFindMany.mockImplementation(async (args: any) => {
      if (args?.select?.chainedFromScheduleId) return chain;
      if (args?.where?.enabled === true) {
        const k = args.where.kind;
        const kinds: string[] = typeof k === 'string' ? [k] : Array.isArray(k?.in) ? k.in : [];
        return enabledRows.filter((r) => kinds.includes(r.kind));
      }
      return [];
    });
  }

  it('first link: stamps chainedFromScheduleId (parent verified in-session), records the metric, no warning', async () => {
    routeFindMany([]);
    mockScheduleFindFirst.mockResolvedValue({ id: 'parent_1' }); // parent older than the window, but this session's row
    const res = await createSchedule({ ...base, chainedFromScheduleId: 'parent_1' });
    expect(res.ok).toBe(true);
    expect(mockScheduleCreate.mock.calls[0][0].data.chainedFromScheduleId).toBe('parent_1');
    expect(mockScheduleFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'parent_1', sessionId: 's1' } }));
    const metric = mockRecordLoopMetric.mock.calls.find((c) => c[0].kind === 'schedule_once_chain')?.[0];
    expect(metric).toMatchObject({ sessionId: 's1', value: 1, meta: expect.objectContaining({ chainedFrom: 'parent_1', links: 1, recurringLike: false, outcome: 'armed' }) });
    expect(res.warning).toBeUndefined();
  });

  it('a parent that is NOT this session\'s row is never stamped (foreign lineage)', async () => {
    routeFindMany([]);
    mockScheduleFindFirst.mockResolvedValue(null);
    const res = await createSchedule({ ...base, chainedFromScheduleId: 'someone_elses' });
    expect(res.ok).toBe(true);
    expect(mockScheduleCreate.mock.calls[0][0].data.chainedFromScheduleId).toBeUndefined();
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0].kind === 'schedule_once_chain')).toBe(false);
  });

  it('recurring arms and non-machine arms ignore chainedFromScheduleId', async () => {
    routeFindMany([]);
    // (hourly — a 15-min machine recurring is refused by the cap-cadence guard itself)
    const rec = await createSchedule({ ...base, kind: 'recurring', intervalSec: 3600, chainedFromScheduleId: 'parent_1' });
    expect(rec.ok).toBe(true);
    expect(mockScheduleCreate.mock.calls[0][0].data.chainedFromScheduleId).toBeUndefined();
    const user = await createSchedule({ ...base, promptSetBy: 'user', chainedFromScheduleId: 'parent_1' });
    expect(user.ok).toBe(true);
    expect(mockScheduleCreate.mock.calls[1][0].data.chainedFromScheduleId).toBeUndefined();
  });

  it('3rd link in 24h: the arm LANDS with the chain advisory and the metric says recurringLike', async () => {
    routeFindMany(chainRows(2, 1)); // ~60-min observed cadence ⇒ 24/day, under the 36 headroom line
    const res = await createSchedule({ ...base, chainedFromScheduleId: 'link_2' });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/ONE-SHOT CHAIN: this is link 3/);
    expect(mockScheduleCreate.mock.calls[0][0].data.chainedFromScheduleId).toBe('link_2');
    const metric = mockRecordLoopMetric.mock.calls.find((c) => c[0].kind === 'schedule_once_chain')?.[0];
    expect(metric.meta).toMatchObject({ links: 3, recurringLike: true, rootId: 'link_1', observedCadenceSec: 3600, cadenceSec: 3600, outcome: 'armed' });
  });

  it('DEFAULT (observe-only): a recurring-like chain whose OBSERVED cadence can never fit the daily cap LANDS with the CAP MATH warning — never refused', async () => {
    // 4 links 15 min apart ⇒ observed 900s ⇒ 96/day vs cap 48 — the class
    // that would be refused as a recurring machine arm. A lane's own
    // one-shot re-arm is never refused by default (gate-flip doctrine).
    routeFindMany(chainRows(3, 0.25));
    const res = await createSchedule({ ...base, chainedFromScheduleId: 'link_3' });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/⚠️ CAP MATH/);
    expect(res.warning).toMatch(/can NEVER fit/);
    expect(res.warning).toMatch(/ONE-SHOT CHAIN: this is link 4/);
    expect(res.warning).toMatch(/warned, never refused/);
    expect(mockScheduleCreate).toHaveBeenCalledTimes(1);
    expect(mockScheduleCreate.mock.calls[0][0].data.chainedFromScheduleId).toBe('link_3');
    const outcomes = mockRecordLoopMetric.mock.calls.filter((c) => c[0].kind === 'schedule_once_chain').map((c) => c[0].meta.outcome);
    expect(outcomes).toEqual(['warned_cap_cadence', 'armed']);
    const warned = mockRecordLoopMetric.mock.calls.find((c) => c[0].kind === 'schedule_once_chain')?.[0];
    expect(warned.meta).toMatchObject({ outcome: 'warned_cap_cadence', wouldRefuse: true, cap: 48, links: 4 });
    expect(outcomes).not.toContain('refused_cap_cadence');
  });

  it('a fitting chain (under the cap) never writes warned_cap_cadence', async () => {
    routeFindMany(chainRows(2, 1)); // ~60 min ⇒ 24/day
    const res = await createSchedule({ ...base, chainedFromScheduleId: 'link_2' });
    expect(res.ok).toBe(true);
    expect(res.warning).not.toMatch(/CAP MATH/);
    const outcomes = mockRecordLoopMetric.mock.calls.filter((c) => c[0].kind === 'schedule_once_chain').map((c) => c[0].meta.outcome);
    expect(outcomes).toEqual(['armed']);
  });

  it('a chain at ≥75% of the cap lands with the CAP HEADROOM warning alongside the chain advisory', async () => {
    // 3 links 30 min apart ⇒ observed 1800s ⇒ 48/day = the whole budget (warn, never refuse).
    routeFindMany(chainRows(2, 0.5));
    const res = await createSchedule({ ...base, chainedFromScheduleId: 'link_2' });
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/ONE-SHOT CHAIN/);
    expect(res.warning).toMatch(/CAP HEADROOM/);
  });

  it('recurring-like link dedupes against an enabled RECURRING twin (same normalized prompt)', async () => {
    const twin = { id: 'rec_1', kind: 'recurring', enabled: true, runsCount: 3, maxRuns: 500, prompt: 'grid-gated :3001 redeploy resume', intervalSec: 3600, nextRunAt: new Date(now + H), sessionId: 's1' };
    routeFindMany(chainRows(2, 1), [twin]);
    const res = await createSchedule({ ...base, chainedFromScheduleId: 'link_2' });
    expect(res.ok).toBe(true);
    expect(res.deduped).toBe(true);
    expect(res.schedule?.id).toBe('rec_1');
    expect(mockScheduleCreate).not.toHaveBeenCalled();
    expect(mockScheduleFindMany.mock.calls.some((c) => c[0]?.where?.enabled === true && Array.isArray(c[0]?.where?.kind?.in))).toBe(true);
    const metric = mockRecordLoopMetric.mock.calls.find((c) => c[0].kind === 'schedule_once_chain')?.[0];
    expect(metric.meta).toMatchObject({ outcome: 'deduped', dupeId: 'rec_1', dupeKind: 'recurring' });
  });

  it('a plain (non-chain) one-shot never widens the dedupe scan to recurring rows', async () => {
    const twin = { id: 'rec_1', kind: 'recurring', enabled: true, runsCount: 3, maxRuns: 500, prompt: 'grid-gated :3001 redeploy resume' };
    routeFindMany([], [twin]);
    const res = await createSchedule({ ...base });
    expect(res.ok).toBe(true);
    expect(res.deduped).toBeUndefined();
    expect(mockScheduleFindMany.mock.calls.some((c) => c[0]?.where?.enabled === true && c[0]?.where?.kind === 'once')).toBe(true);
  });

  it('a chain read error fails OPEN — the arm lands as a plain one-shot', async () => {
    mockScheduleFindMany.mockImplementation(async (args: any) => {
      if (args?.select?.chainedFromScheduleId) throw new Error('db hiccup');
      return [];
    });
    const res = await createSchedule({ ...base, chainedFromScheduleId: 'link_2' });
    expect(res.ok).toBe(true);
    expect(mockScheduleCreate.mock.calls[0][0].data.chainedFromScheduleId).toBeUndefined();
  });
});

describe('fireScheduleTarget — a recurring-like chain link keeps the busy re-arm (no queue-behind-busy)', () => {
  const onceRow = { enabled: true, kind: 'once', runsCount: 0, maxRuns: 1, expiresAt: null, lastFiredAt: null, promptSetBy: 'machine', ownerSubscribed: null };

  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleFindUnique.mockResolvedValue(onceRow);
  });

  it('plain chat, busy: an ordinary one-shot enqueues; a chain link ≥3 reports busy instead', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast' }); // no codingState → plain chat
    mockStartDetachedChatRun.mockReturnValue(null); // busy
    const plain = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'poll the grid' });
    expect(plain).toMatchObject({ started: true, queued: true });
    expect(mockEnqueueChatMessage).toHaveBeenCalledTimes(1);

    mockEnqueueChatMessage.mockClear();
    const link = await fireScheduleTarget({ id: 'sch_3', sessionId: 's1', prompt: 'poll the grid', onceChainRecurringLike: true });
    expect(link).toMatchObject({ started: false, reason: 'busy' });
    expect(mockEnqueueChatMessage).not.toHaveBeenCalled();
  });

  it('plain chat: the fired schedule id rides to the run as firedByScheduleId (chain provenance)', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast' });
    mockStartDetachedChatRun.mockReturnValue('chat:s1');
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'poll the grid' });
    expect(mockStartDetachedChatRun.mock.calls[0][0]).toMatchObject({ firedByScheduleId: 'sch_1', messageOrigin: 'schedule' });
    mockStartDetachedChatRun.mockClear();
    await fireScheduleTarget({ id: 'hook-9', sessionId: 's1', prompt: 'wake', origin: 'hook' });
    expect(mockStartDetachedChatRun.mock.calls[0][0].firedByScheduleId).toBeUndefined();
  });

  it('coding session: queueBehindBusy is withheld for a chain link ≥3', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'poll the grid' });
    expect(mockStartScheduledRun.mock.calls[0][2]).toMatchObject({ queueBehindBusy: true, scheduleId: 'sch_1' });
    mockStartScheduledRun.mockClear();
    await fireScheduleTarget({ id: 'sch_3', sessionId: 's1', prompt: 'poll the grid', onceChainRecurringLike: true });
    expect(mockStartScheduledRun.mock.calls[0][2].queueBehindBusy).toBeUndefined();
  });
});

describe('sweeper — fire-time dormancy park for a recurring-like chain link', () => {
  const dueLink = {
    id: 'link_3', sessionId: 's1', userId: 'u1', prompt: 'GRID-GATED :3001 REDEPLOY RESUME', kind: 'once', intervalSec: MIN_INTERVAL_SEC,
    nextRunAt: new Date(now - 60_000), enabled: true, runsCount: 0, maxRuns: 1, expiresAt: new Date(now + 10 * H), lastFiredAt: null,
    promptSetBy: 'machine', busySkips: 0, chainedFromScheduleId: 'link_2', createdAt: at(0.5),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
    mockScheduleFindUnique.mockResolvedValue({ ...dueLink });
  });

  function routeSweep(due: any[], chain: any[]) {
    mockScheduleFindMany.mockImplementation(async (args: any) => {
      if (args?.select?.chainedFromScheduleId) return chain;
      if (args?.where?.enabled === true && args?.where?.nextRunAt) return due;
      return [];
    });
  }

  it('DEFAULT (observe-only): dormant project + chain of 3 ⇒ metric would_park_dormant, the link FIRES, nothing is parked', async () => {
    routeSweep([dueLink], chainRows(2, 1));
    mockEvaluateScheduleDormancy.mockResolvedValue({ dormant: true, reason: 'project "bench" is dormant' });
    await fireDue();
    expect(mockEvaluateScheduleDormancy).toHaveBeenCalledWith('s1', 'machine');
    expect(mockScheduleUpdate.mock.calls.some((c) => c[0]?.data?.lastStatus === 'parked:dormant')).toBe(false);
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    const metric = mockRecordLoopMetric.mock.calls.find((c) => c[0].kind === 'schedule_once_chain')?.[0];
    expect(metric).toMatchObject({ sessionId: 's1', meta: expect.objectContaining({ scheduleId: 'link_3', chainedFrom: 'link_2', outcome: 'would_park_dormant', reason: 'project "bench" is dormant' }) });
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0].kind === 'schedule_once_chain' && c[0].meta?.outcome === 'parked_dormant')).toBe(false);
  });

  it('a recurring row on a dormant project still parks exactly as before (the observe-only default is chain-links only)', async () => {
    const rec = { ...dueLink, id: 'rec_1', kind: 'recurring', intervalSec: 3600, maxRuns: 500, chainedFromScheduleId: null };
    routeSweep([rec], []);
    mockEvaluateScheduleDormancy.mockResolvedValue({ dormant: true, reason: 'dormant' });
    await fireDue();
    const park = mockScheduleUpdate.mock.calls.find((c) => c[0]?.data?.lastStatus === 'parked:dormant');
    expect(park?.[0]).toMatchObject({ where: { id: 'rec_1' } });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric.mock.calls.some((c) => c[0].kind === 'schedule_once_chain')).toBe(false);
  });

  it('a plain one-shot (no chain) on a dormant project is NOT gated — fires as today', async () => {
    const plain = { ...dueLink, id: 'once_1', chainedFromScheduleId: null };
    routeSweep([plain], []);
    mockEvaluateScheduleDormancy.mockResolvedValue({ dormant: true, reason: 'dormant' });
    await fireDue();
    expect(mockEvaluateScheduleDormancy).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
  });

  it('a chain link below the threshold (2 links) is NOT gated', async () => {
    routeSweep([dueLink], chainRows(1, 1));
    mockEvaluateScheduleDormancy.mockResolvedValue({ dormant: true, reason: 'dormant' });
    await fireDue();
    expect(mockEvaluateScheduleDormancy).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
  });

  it('live project + chain of 3 ⇒ fires, and the run start carries no queueBehindBusy', async () => {
    routeSweep([dueLink], chainRows(2, 1));
    mockEvaluateScheduleDormancy.mockResolvedValue({ dormant: false, reason: 'live' });
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun.mock.calls[0][2].queueBehindBusy).toBeUndefined();
  });
});
