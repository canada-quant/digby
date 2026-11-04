/**
 * chat-orphan-recovery (ticket 68bc5aec) — the plain-chat orphaned-turn
 * sweeper. Pins:
 *   RULE A (corpse-queued pendings): an old pending_chat_messages row behind
 *     a chat whose run DIED is drained (drainChatQueue(chatId, userId-from-
 *     row)) when the FAIL-CLOSED probe says idle; a busy chat is skipped; a
 *     probe ERROR aborts the whole pass with zero drains — and the sweep
 *     itself never throws (rule isolation: Rule B still runs).
 *   RULE B (unanswered user rows): an old latest-is-user transcript row is
 *     re-fired under a BOUNDED budget (MAX_RECOVERY_ATTEMPTS=3, ticket
 *     6c1e595c — startDetachedChatRun with content + recoveryForMessageId
 *     + the original createdAt anchor; the firedAt/attempts marker lands
 *     ONLY after a won claim; a firedAt-only row from the once-only era
 *     counts as 1 attempt); a budget-spent row escalates ONCE
 *     (attention_needed + one NX-gated notice row + escalatedAt, both
 *     naming the attempt count); escalated rows go fully silent; busy
 *     chats, chats with a live queue (Rule A owns), and machine-origin
 *     rows behave as designed; the SQL pins the grace cutoff, the
 *     latest-row clause, and the coding-session exclusion.
 *
 * chat-busy + message-queue.service are the REAL modules (the probe's
 * fail-closed semantics and peekOldest's peek are exactly what the sweeper
 * relies on) riding an in-memory Redis fake with REAL NX semantics and a
 * stand-in prisma; chat-agent.service + hooks.service are mocked at the
 * boundary (the dynamic-import seam the sweeper uses).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisStore = new Map<string, string>();
const redisLists = new Map<string, string[]>();
const mockRedis = {
  set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean; EX?: number }) => {
    if (opts?.NX && redisStore.has(k)) return null; // real SET NX contract
    redisStore.set(k, v);
    return 'OK';
  }),
  get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
  rPush: jest.fn(async (k: string, v: string) => {
    const l = redisLists.get(k) ?? [];
    l.push(v);
    redisLists.set(k, l);
    return l.length;
  }),
  lRange: jest.fn(async (k: string, start: number, stop: number) => {
    const l = redisLists.get(k) ?? [];
    // node-redis semantics: negative stop counts from the end (-1 = last).
    const end = stop < 0 ? l.length + stop : stop;
    return l.slice(start, end + 1);
  }),
  lRem: jest.fn(async (k: string, count: number, v: string) => {
    const l = redisLists.get(k) ?? [];
    let removed = 0;
    const kept = l.filter((x) => {
      if (x === v && removed < count) { removed += 1; return false; }
      return true;
    });
    redisLists.set(k, kept);
    return removed;
  }),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  pendingChatMessage: {
    findMany: jest.fn(async () => []), // Rule A's batch scan
    findFirst: jest.fn(async () => null), // message-queue peekOldest (Rule B's Rule-A-owns-it check)
  },
  crossModelMessage: {
    update: jest.fn(async () => ({})),
    create: jest.fn(async () => ({})),
    findFirst: jest.fn(async () => null), // deploy-drain latestChatRow
  },
  crossModelChat: { update: jest.fn(async () => ({})) },
  // chat-busy's durable layer (worker-tier coding runs) — none in these tests.
  agentRun: { findFirst: jest.fn(async () => null) },
  $queryRaw: jest.fn(async () => []), // Rule B's latest-is-user scan
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// message-queue.service → middleware/error-handler → config/env, which
// process.exit(1)s without env vars — mock AppError (same shape as the
// chat-agent.service suite).
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

const mockDrainChatQueue = jest.fn(async (..._a: any[]) => true);
const mockStartDetachedChatRun = jest.fn(async (..._a: any[]): Promise<string | null> => 'chat:c1');
jest.mock('./chat-agent.service', () => ({
  __esModule: true,
  drainChatQueue: (...a: any[]) => mockDrainChatQueue(...a),
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
}));

const mockEmitHookEventSafe = jest.fn(async (..._a: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
}));

import { sweepOrphanedChatTurns, drainDeployRequeue } from './orphan-recovery';
import { DEPLOY_INTERRUPT_ORIGIN, DEPLOY_REQUEUE_KEY } from './shutdown-interrupt';
import { claimChatLiveRun } from './chat-busy';
import { startLiveRun, endLiveRun } from '../coding/live-runs';
import logger from '../../../utils/logger';

const OLD = new Date(Date.now() - 60 * 60_000); // 60 min ago — past every grace
const MAX_BUDGET = 3; // mirrors the MAX_RECOVERY_ATTEMPTS default in orphan-recovery.ts (ticket 6c1e595c)

/** A Rule-B scan row (the raw-SQL join shape). */
function orphanRow(over: Partial<any> = {}) {
  return {
    id: 'm1',
    chatId: 'c1',
    content: 'orphaned question',
    metadata: null,
    createdAt: OLD,
    chatUserId: 'u1',
    chatMode: 'thinking',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  redisLists.clear();
  // clearAllMocks keeps implementations: restore the healthy defaults so a
  // per-test mockRejectedValue can never poison a later test (execution-order
  // independence — the 'probe throws' tests reject exists below).
  mockRedis.set.mockImplementation(async (k: string, v: string, opts?: { NX?: boolean; EX?: number }) => {
    if (opts?.NX && redisStore.has(k)) return null;
    redisStore.set(k, v);
    return 'OK';
  });
  mockRedis.get.mockImplementation(async (k: string) => redisStore.get(k) ?? null);
  mockRedis.del.mockImplementation(async (k: string) => (redisStore.delete(k) ? 1 : 0));
  mockRedis.exists.mockImplementation(async (k: string) => (redisStore.has(k) ? 1 : 0));
  mockRedis.rPush.mockImplementation(async (k: string, v: string) => {
    const l = redisLists.get(k) ?? [];
    l.push(v);
    redisLists.set(k, l);
    return l.length;
  });
  mockRedis.lRange.mockImplementation(async (k: string, start: number, stop: number) => {
    const l = redisLists.get(k) ?? [];
    const end = stop < 0 ? l.length + stop : stop;
    return l.slice(start, end + 1);
  });
  mockRedis.lRem.mockImplementation(async (k: string, count: number, v: string) => {
    const l = redisLists.get(k) ?? [];
    let removed = 0;
    const kept = l.filter((x) => {
      if (x === v && removed < count) { removed += 1; return false; }
      return true;
    });
    redisLists.set(k, kept);
    return removed;
  });
  mockPrisma.pendingChatMessage.findMany.mockResolvedValue([]);
  mockPrisma.pendingChatMessage.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelMessage.update.mockResolvedValue({});
  mockPrisma.crossModelMessage.create.mockResolvedValue({});
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelChat.update.mockResolvedValue({});
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockPrisma.$queryRaw.mockResolvedValue([]);
  mockDrainChatQueue.mockResolvedValue(true);
  mockStartDetachedChatRun.mockResolvedValue('chat:c1');
});

describe('rule A — corpse-queued pending rows drain when the chat is idle', () => {
  it('old pending + idle → drainChatQueue(chatId, userId-from-row), oldest-first per distinct chat', async () => {
    mockPrisma.pendingChatMessage.findMany.mockResolvedValue([
      { chatId: 'c1', userId: 'u-owner' },
      { chatId: 'c1', userId: 'u-owner' }, // same chat — ONE drain (the drain's own FIFO unrolls)
      { chatId: 'c2', userId: 'u2' },
    ]);
    await sweepOrphanedChatTurns();
    expect(mockDrainChatQueue).toHaveBeenCalledTimes(2);
    expect(mockDrainChatQueue).toHaveBeenNthCalledWith(1, 'c1', 'u-owner');
    expect(mockDrainChatQueue).toHaveBeenNthCalledWith(2, 'c2', 'u2');
    // The grace cutoff rides the findMany (±5s tolerance).
    const [args] = mockPrisma.pendingChatMessage.findMany.mock.calls[0];
    const ageMs = Date.now() - args.where.createdAt.lt.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(300_000 - 5_000);
    expect(ageMs).toBeLessThan(300_000 + 5_000);
    expect(args.take).toBe(25);
  });

  it('busy chat (cross-process liveness key) → NOT drained; the idle chat in the same batch still drains', async () => {
    await claimChatLiveRun('c-busy'); // "instance A" owns this chat
    mockPrisma.pendingChatMessage.findMany.mockResolvedValue([
      { chatId: 'c-busy', userId: 'u1' },
      { chatId: 'c-idle', userId: 'u2' },
    ]);
    await sweepOrphanedChatTurns();
    expect(mockDrainChatQueue).toHaveBeenCalledTimes(1);
    expect(mockDrainChatQueue).toHaveBeenCalledWith('c-idle', 'u2');
  });

  it('busy chat (LOCAL run registry) → NOT drained', async () => {
    startLiveRun('chat:c-local');
    try {
      mockPrisma.pendingChatMessage.findMany.mockResolvedValue([{ chatId: 'c-local', userId: 'u1' }]);
      await sweepOrphanedChatTurns();
      expect(mockDrainChatQueue).not.toHaveBeenCalled();
    } finally {
      endLiveRun('chat:c-local');
    }
  });

  it('a probe ERROR aborts the whole pass — zero drains, no throw out of the sweep, Rule B still runs', async () => {
    mockRedis.exists.mockRejectedValue(new Error('redis down'));
    mockPrisma.pendingChatMessage.findMany.mockResolvedValue([
      { chatId: 'c1', userId: 'u1' },
      { chatId: 'c2', userId: 'u2' },
    ]);
    await expect(sweepOrphanedChatTurns()).resolves.toBeUndefined();
    expect(mockDrainChatQueue).not.toHaveBeenCalled(); // fail-CLOSED, never catch-to-idle
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rule A'));
    expect(mockPrisma.$queryRaw).toHaveBeenCalled(); // one rule's failure never skips the other
  });

  it('young pending rows are not even scanned (the cutoff is in the query) and an empty batch is a no-op', async () => {
    await sweepOrphanedChatTurns();
    expect(mockDrainChatQueue).not.toHaveBeenCalled();
  });
});

describe('rule B — re-fire an orphaned user turn (bounded budget, ticket 6c1e595c)', () => {
  it('idle + no pending + no marker → re-fired with content + recoveryForMessageId; marker written after the won claim', async () => {
    const row = orphanRow({ metadata: { authorId: 'u1' } });
    mockPrisma.$queryRaw.mockResolvedValue([row]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1',
      chatId: 'c1',
      message: 'orphaned question',
      mode: 'thinking',
      messageOrigin: 'user',
      userTurnAt: row.createdAt, // the ORIGINAL send's confirmation anchor
      recoveryForMessageId: 'm1',
    }));
    // The marker MERGES onto the existing metadata (nothing else is lost).
    const marker = mockPrisma.crossModelMessage.update.mock.calls.find((c: any[]) => c[0]?.where?.id === 'm1');
    expect(marker).toBeDefined();
    expect(marker[0].data.metadata.authorId).toBe('u1');
    expect(marker[0].data.metadata.recovery.by).toBe('orphan-sweeper');
    expect(typeof marker[0].data.metadata.recovery.firedAt).toBe('string');
    expect(marker[0].data.metadata.recovery.attempts).toBe(1); // first won re-fire of the budget
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  // 2026-10-04 (live query suite): the Rule-B SELECT is a snapshot; a run saves its answer BEFORE
  // releasing the busy marker, so a sweep straddling that pair saw "unanswered + idle" and answered
  // the same question twice. The fresh still-newest read closes it.
  it('a row ANSWERED between the snapshot and the busy probe is left alone (no second answer)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow()]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'a1' }); // the run's answer landed
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled(); // no recovery marker
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled(); // and no escalation
    const probe = mockPrisma.crossModelMessage.findFirst.mock.calls[0][0];
    expect(probe.where.chatId).toBe('c1');
    expect(probe.where.OR).toEqual([{ createdAt: { gt: orphanRow().createdAt } }, { createdAt: orphanRow().createdAt, id: { gt: 'm1' } }]);
  });

  it('CHAT_ORPHAN_LATEST_RECHECK_DISABLED=1 restores the snapshot-only behaviour', async () => {
    process.env.CHAT_ORPHAN_LATEST_RECHECK_DISABLED = '1';
    try {
      mockPrisma.$queryRaw.mockResolvedValue([orphanRow()]);
      mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'a1' });
      await sweepOrphanedChatTurns();
      expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.CHAT_ORPHAN_LATEST_RECHECK_DISABLED;
    }
  });

  it('stored chat modes normalize exactly like sendChatMessage (thinking/deep_research survive, legacy → L1)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({ id: 'm-t', chatId: 'c-t', chatMode: 'thinking' }),
      orphanRow({ id: 'm-d', chatId: 'c-d', chatMode: 'deep_research' }),
      orphanRow({ id: 'm-l4', chatId: 'c-l4', chatMode: 'deep_research_all' }),
      orphanRow({ id: 'm-f', chatId: 'c-f', chatMode: 'fast' }),
      orphanRow({ id: 'm-a', chatId: 'c-a', chatMode: 'auto' }),
    ]);
    await sweepOrphanedChatTurns();
    const modeOf = (chatId: string) =>
      mockStartDetachedChatRun.mock.calls.find((c: any[]) => c[0]?.chatId === chatId)?.[0]?.mode;
    expect(modeOf('c-t')).toBe('thinking');
    expect(modeOf('c-d')).toBe('deep_research');
    expect(modeOf('c-l4')).toBe('deep_research'); // L4 aliases to L3 (normalizePatienceMode)
    expect(modeOf('c-f')).toBe('single_thinking'); // retired fast tier → L1
    expect(modeOf('c-a')).toBe('thinking'); // the stored 'auto' default (2026-09-26) re-fires at the L2 preset fallback
  });

  it('a LOST start race (null key) leaves the row UNMARKED for a later pass', async () => {
    mockStartDetachedChatRun.mockResolvedValue(null);
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow()]);
    await sweepOrphanedChatTurns();
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
    // …and the next pass retries the re-fire (the row is still unmarked).
    mockStartDetachedChatRun.mockResolvedValue('chat:c1');
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(2);
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(1);
    const marker = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(marker.data.metadata.recovery.attempts).toBe(1);
  });

  it('busy chat → skip (no re-fire, no marker)', async () => {
    await claimChatLiveRun('c1');
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow()]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
  });

  it('a live pending queue → skip: Rule A owns this chat', async () => {
    mockPrisma.pendingChatMessage.findFirst.mockResolvedValue({ id: 'p1', chatId: 'c1' });
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow()]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
  });

  it('the scan SQL pins the 5-min grace, the latest-row clause, and the coding-session exclusion', async () => {
    await sweepOrphanedChatTurns();
    const sql = (mockPrisma.$queryRaw.mock.calls[0][0] as readonly string[]).join('?');
    expect(sql).toContain('crossmodel_messages');
    expect(sql).toContain(`m."role" = 'user'`);
    expect(sql).toContain('NOT EXISTS'); // the LATEST-message clause…
    expect(sql).toContain('newer."createdAt" > m."createdAt"');
    expect(sql).toContain('coding_sessions'); // …and the coding-chat exclusion
    const cutoff = mockPrisma.$queryRaw.mock.calls[0][1] as Date;
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(300_000 - 5_000); // a young row (inside grace) never matches
    expect(ageMs).toBeLessThan(300_000 + 5_000);
    expect(mockPrisma.$queryRaw.mock.calls[0][2]).toBe(50); // batch cap
  });

  it('a probe ERROR aborts the pass — no re-fires, no throw out of the sweep', async () => {
    mockRedis.exists.mockRejectedValue(new Error('redis down'));
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow()]);
    await expect(sweepOrphanedChatTurns()).resolves.toBeUndefined();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rule B'));
  });
});

describe('rule B — bounded re-fire budget (ticket 6c1e595c)', () => {
  it('attempts increments on each won re-fire (1→2→3) and firedAt is refreshed every time', async () => {
    // Fixed OLD prior stamp: refreshed-ness must not depend on ms clock resolution.
    const PRIOR = '2026-08-28T00:00:00.000Z';
    for (let pass = 1; pass <= MAX_BUDGET; pass++) {
      const priorRecovery = pass === 1
        ? undefined
        : { firedAt: PRIOR, attempts: pass - 1, by: 'orphan-sweeper' };
      mockPrisma.$queryRaw.mockResolvedValue([orphanRow({
        metadata: priorRecovery ? { recovery: priorRecovery } : null,
      })]);
      await sweepOrphanedChatTurns();
      expect(mockEmitHookEventSafe).not.toHaveBeenCalled(); // never escalates while budget remains
      const marker = mockPrisma.crossModelMessage.update.mock.calls[pass - 1][0];
      expect(marker.data.metadata.recovery.attempts).toBe(pass);
      expect(typeof marker.data.metadata.recovery.firedAt).toBe('string');
      expect(Number.isNaN(Date.parse(marker.data.metadata.recovery.firedAt))).toBe(false);
      if (pass > 1) expect(marker.data.metadata.recovery.firedAt).not.toBe(PRIOR); // refreshed off the prior stamp
    }
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(MAX_BUDGET);
  });

  it('a LOST start race writes NO marker — attempts never increments without a won claim', async () => {
    mockStartDetachedChatRun.mockResolvedValue(null);
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow({
      metadata: { recovery: { firedAt: '2026-08-28T00:00:00.000Z', attempts: 2, by: 'orphan-sweeper' } },
    })]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1); // the re-fire was tried…
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled(); // …but nothing was marked
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('attempts=MAX-1 → the LAST re-fire is allowed and marks attempts=MAX', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow({
      metadata: { recovery: { firedAt: '2026-08-28T00:00:00.000Z', attempts: MAX_BUDGET - 1, by: 'orphan-sweeper' } },
    })]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      messageOrigin: 'user',
      recoveryForMessageId: 'm1',
    }));
    const marker = mockPrisma.crossModelMessage.update.mock.calls.find((c: any[]) => c[0]?.where?.id === 'm1');
    expect(marker[0].data.metadata.recovery.attempts).toBe(MAX_BUDGET);
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('attempts=MAX → NOT re-fired: escalates, and BOTH escalation surfaces name the attempt count', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow({
      metadata: { recovery: { firedAt: '2026-08-28T00:00:00.000Z', attempts: MAX_BUDGET, by: 'orphan-sweeper' } },
    })]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).toHaveBeenCalledTimes(1);
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c1', 'attention_needed', expect.stringContaining(`recovery attempts (${MAX_BUDGET}) also died`));
    const notice = mockPrisma.crossModelMessage.create.mock.calls.find((c: any[]) => c[0]?.data?.role === 'assistant');
    expect(notice).toBeDefined();
    expect(notice[0].data.content).toContain(`recovery attempts (${MAX_BUDGET}) also died`);
    expect(notice[0].data.content).toContain('resend');
  });

  it('LEGACY firedAt-only row (once-only era, no attempts field) → counts as 1 attempt: RE-FIRED, marker at attempts=2', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow({
      metadata: { recovery: { firedAt: '2026-08-28T00:00:00.000Z', by: 'orphan-sweeper' } },
    })]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      messageOrigin: 'user',
      recoveryForMessageId: 'm1',
    }));
    const marker = mockPrisma.crossModelMessage.update.mock.calls.find((c: any[]) => c[0]?.where?.id === 'm1');
    expect(marker[0].data.metadata.recovery.attempts).toBe(2); // the legacy fire + this one
    expect(marker[0].data.metadata.recovery.firedAt).not.toBe('2026-08-28T00:00:00.000Z'); // refreshed
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled(); // NOT escalated — budget remains
  });

  it('MACHINE paths honor the budget: cleanWake + agent re-fire at attempts<MAX and mark; attempts=MAX escalates', async () => {
    // cleanWake (schedule) at attempts=2 → re-fired with machineWake, attempts→3.
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({
        id: 'm-wake', chatId: 'c-wake',
        metadata: { origin: 'schedule', machineMessage: 'do the nightly sweep', recovery: { firedAt: '2026-08-28T00:00:00.000Z', attempts: MAX_BUDGET - 1, by: 'orphan-sweeper' } },
      }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      message: 'do the nightly sweep',
      messageOrigin: 'schedule',
      machineWake: true,
      recoveryForMessageId: 'm-wake',
    }));
    let marker = mockPrisma.crossModelMessage.update.mock.calls.find((c: any[]) => c[0]?.where?.id === 'm-wake');
    expect(marker[0].data.metadata.recovery.attempts).toBe(MAX_BUDGET);
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();

    // 'agent' at attempts=1 → re-fired content-as-is, machineWake OFF, attempts→2.
    jest.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({
        id: 'm-agent', chatId: 'c-agent', content: 'rank the top 300 superflex players',
        metadata: { origin: 'agent', recovery: { firedAt: '2026-08-28T00:00:00.000Z', attempts: 1, by: 'orphan-sweeper' } },
      }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    const agentArgs = mockStartDetachedChatRun.mock.calls[0][0] as any;
    expect(agentArgs).toMatchObject({
      message: 'rank the top 300 superflex players',
      messageOrigin: 'agent',
      recoveryForMessageId: 'm-agent',
    });
    expect('machineWake' in agentArgs).toBe(false);
    marker = mockPrisma.crossModelMessage.update.mock.calls.find((c: any[]) => c[0]?.where?.id === 'm-agent');
    expect(marker[0].data.metadata.recovery.attempts).toBe(2);
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();

    // Machine row at attempts=MAX → NO re-fire, escalate naming the count.
    jest.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({
        id: 'm-max', chatId: 'c-max',
        metadata: { origin: 'schedule', machineMessage: 'wake work', recovery: { firedAt: '2026-08-28T00:00:00.000Z', attempts: MAX_BUDGET, by: 'orphan-sweeper' } },
      }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-max', 'attention_needed', expect.stringContaining(`recovery attempts (${MAX_BUDGET}) also died`));
  });
});

describe('rule B — escalate ONCE when the recovery budget is spent', () => {
  // Budget-SPENT marker (ticket 6c1e595c): attempts at MAX_RECOVERY_ATTEMPTS.
  const FIRED = { recovery: { firedAt: '2026-08-28T00:00:00.000Z', attempts: MAX_BUDGET, by: 'orphan-sweeper' } };

  it('budget-spent row → attention_needed + ONE notice row + escalatedAt merged (firedAt + attempts preserved)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow({ metadata: { ...FIRED, authorId: 'u1' } })]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled(); // never a re-fire past the budget
    expect(mockEmitHookEventSafe).toHaveBeenCalledTimes(1);
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c1', 'attention_needed', expect.stringContaining('m1'));
    // The hook text names the attempt count (ticket 6c1e595c).
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c1', 'attention_needed', expect.stringContaining(`recovery attempts (${MAX_BUDGET}) also died`));
    // The honest in-chat notice, stamped as machine traffic.
    const notice = mockPrisma.crossModelMessage.create.mock.calls.find((c: any[]) => c[0]?.data?.role === 'assistant');
    expect(notice).toBeDefined();
    expect(notice[0].data.chatId).toBe('c1');
    expect(notice[0].data.metadata).toEqual({ origin: 'orphan-recovery' });
    expect(notice[0].data.content).toContain('resend');
    expect(notice[0].data.content).toContain(`recovery attempts (${MAX_BUDGET}) also died`); // the notice names the count too
    // escalatedAt merges ONTO the existing recovery marker (firedAt + attempts survive).
    const marker = mockPrisma.crossModelMessage.update.mock.calls.find((c: any[]) => c[0]?.where?.id === 'm1');
    expect(marker[0].data.metadata.recovery.firedAt).toBe(FIRED.recovery.firedAt);
    expect(marker[0].data.metadata.recovery.attempts).toBe(MAX_BUDGET);
    expect(typeof marker[0].data.metadata.recovery.escalatedAt).toBe('string');
    expect(marker[0].data.metadata.authorId).toBe('u1');
    // The chat is bumped so the notice surfaces in the sidebar.
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { updatedAt: expect.any(Date) } });
  });

  it('the notice is once-gated per message id (Redis NX): a claimed gate posts no second row but still marks', async () => {
    redisStore.set('cm:orphannotice:m1', '1'); // a previous pass (or the OTHER blue/green instance) already told the owner
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow({ metadata: FIRED })]);
    await sweepOrphanedChatTurns();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).toHaveBeenCalledTimes(1); // the hook event is NOT the once-gated surface
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(1); // escalatedAt still lands
  });

  it('a failed notice insert REOPENS the NX gate AND leaves escalatedAt unset, so the next pass retries (N1)', async () => {
    mockPrisma.crossModelMessage.create.mockRejectedValueOnce(new Error('db down'));
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow({ metadata: FIRED })]);
    await sweepOrphanedChatTurns();
    expect(redisStore.has('cm:orphannotice:m1')).toBe(false);
    // N1 (PR review 2026-08-28): the failed pass must NOT silence future ones.
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
    // The retry pass (create default-resolves now) posts the notice + marks.
    await sweepOrphanedChatTurns();
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(2); // pass-1 reject + pass-2 success
    expect(redisStore.get('cm:orphannotice:m1')).toBe('1');
    const marker = mockPrisma.crossModelMessage.update.mock.calls.find((c: any[]) => c[0]?.where?.id === 'm1');
    expect(marker[0].data.metadata.recovery.escalatedAt).toBeDefined();
  });

  it('a Redis error on the notice claim ALSO leaves escalatedAt unset (unknown ≠ told) — the next pass retries', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('redis down'));
    mockPrisma.$queryRaw.mockResolvedValue([orphanRow({ metadata: FIRED })]);
    await sweepOrphanedChatTurns();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
    // Recovered Redis → the retry posts + marks.
    await sweepOrphanedChatTurns();
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(1);
  });

  it('escalatedAt already present → fully silent (no re-fire, no hook, no notice, no write)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({ metadata: { recovery: { ...FIRED.recovery, escalatedAt: '2026-08-28T01:00:00.000Z' } } }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
  });

  it('LEGACY machine-origin rows (no clean-message stash, pre-bb2eca92) still escalate directly — never a lossy re-fire', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({ id: 'm-sched', chatId: 'c-sched', metadata: { origin: 'schedule' } }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-sched', 'attention_needed', expect.stringContaining('m-sched'));
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-sched', 'attention_needed', expect.stringContaining('clean-message stash'));
    const notice = mockPrisma.crossModelMessage.create.mock.calls.find((c: any[]) => c[0]?.data?.role === 'assistant');
    expect(notice).toBeDefined();
    const marker = mockPrisma.crossModelMessage.update.mock.calls.find((c: any[]) => c[0]?.where?.id === 'm-sched');
    expect(marker[0].data.metadata.recovery.escalatedAt).toBeDefined();
  });
});

describe('rule B — MACHINE-origin rows re-fire down the path the original send ran (bb2eca92, bounded by 6c1e595c)', () => {
  it('a machineWake row (origin schedule + machineMessage stash) re-fires with machineWake:true on the CLEAN message — fresh preamble re-baked downstream', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({
        id: 'm-wake', chatId: 'c-wake',
        metadata: { origin: 'schedule', machineMessage: 'do the nightly sweep' },
      }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith({
      userId: 'u1',
      chatId: 'c-wake',
      // The stashed PRE-PREAMBLE message — NOT the baked row content (a
      // machineWake:true re-fire of the content would double the preamble).
      message: 'do the nightly sweep',
      mode: 'thinking',
      messageOrigin: 'schedule',
      machineWake: true,
      recoveryForMessageId: 'm-wake',
    });
    // NO userTurnAt: machine sends carry no confirmation anchor — the re-fired
    // run must fail confirmation-gating exactly like its predecessor.
    const callArgs = mockStartDetachedChatRun.mock.calls[0][0] as any;
    expect('userTurnAt' in callArgs).toBe(false);
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled(); // no escalation — the turn runs
    // The marker lands after the won claim (same as the human path).
    const marker = mockPrisma.crossModelMessage.update.mock.calls.find((c: any[]) => c[0]?.where?.id === 'm-wake');
    expect(marker).toBeDefined();
    expect(typeof marker[0].data.metadata.recovery.firedAt).toBe('string');
    expect(marker[0].data.metadata.recovery.by).toBe('orphan-sweeper');
    expect(marker[0].data.metadata.recovery.attempts).toBe(1);
  });

  it('a hook-wake row re-fires with its origin + sourceChatId re-stamped', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({
        id: 'm-hook', chatId: 'c-hook',
        metadata: { origin: 'hook', sourceChatId: 'src-9', machineMessage: 'event wake payload' },
      }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      message: 'event wake payload',
      messageOrigin: 'hook',
      originSourceChatId: 'src-9',
      machineWake: true,
      recoveryForMessageId: 'm-hook',
    }));
  });

  it("an 'agent' row (supervisor send_chat_message — original ran the INTERACTIVE path) re-fires content-as-is with machineWake OFF", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({
        id: 'm-agent', chatId: 'c-agent',
        content: 'rank the top 300 superflex players',
        metadata: { origin: 'agent', sourceChatId: 'sup-1' },
      }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    const callArgs = mockStartDetachedChatRun.mock.calls[0][0] as any;
    expect(callArgs).toMatchObject({
      userId: 'u1',
      chatId: 'c-agent',
      message: 'rank the top 300 superflex players', // byte-faithful — nothing was ever baked in
      mode: 'thinking',
      messageOrigin: 'agent',
      originSourceChatId: 'sup-1',
      recoveryForMessageId: 'm-agent',
    });
    expect('machineWake' in callArgs).toBe(false); // the original send had no wake semantics
    expect('userTurnAt' in callArgs).toBe(false);
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it("an origin 'machine' row (action-verifier correction inject) is NEVER an orphan: no re-fire, no escalation, no marker, no notice (ticket 540176d2)", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({
        id: 'm-inj', chatId: 'c-inj',
        content: '[ACTION VERIFIER — automated integrity check] Your last status note claimed action(s) that did NOT execute…',
        metadata: { origin: 'machine', verifier: 'action-verifier' },
      }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled(); // no orphan notice row
  });

  it("an origin 'machine' inject as one chat's latest row does not block a DIFFERENT chat's genuine orphan in the same pass", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({ id: 'm-inj', chatId: 'c-inj', metadata: { origin: 'machine', verifier: 'action-verifier' } }),
      orphanRow({ id: 'm-human', chatId: 'c-human', content: 'real question' }), // metadata null → human turn
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'c-human',
      message: 'real question',
      messageOrigin: 'user',
      recoveryForMessageId: 'm-human',
    }));
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('a LOST start race on a machine re-fire leaves the row UNMARKED for a later pass', async () => {
    mockStartDetachedChatRun.mockResolvedValue(null);
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({ id: 'm-lost', chatId: 'c-lost', metadata: { origin: 'schedule', machineMessage: 'wake work' } }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
    // The next pass retries the re-fire (the row is still unmarked).
    mockStartDetachedChatRun.mockResolvedValue('chat:c-lost');
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(2);
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(1);
  });

  it('a machine row whose recovery budget is SPENT escalates (the re-fires died too) — never a re-fire past the budget', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({
        id: 'm-twice', chatId: 'c-twice',
        metadata: { origin: 'schedule', machineMessage: 'wake work', recovery: { firedAt: '2026-08-28T00:00:00.000Z', attempts: MAX_BUDGET, by: 'orphan-sweeper' } },
      }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-twice', 'attention_needed', expect.stringContaining('m-twice'));
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c-twice', 'attention_needed', expect.stringContaining(`recovery attempts (${MAX_BUDGET}) also died`));
  });

  it('a WEBHOOK wake on a deep_research-stored chat re-fires CLAMPED to thinking (review B1 — mirror of the platform.service unmetered-council clamp)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({
        id: 'm-wh', chatId: 'c-wh', chatMode: 'deep_research',
        metadata: { origin: 'webhook', machineMessage: 'alert payload' },
      }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      message: 'alert payload',
      messageOrigin: 'webhook',
      machineWake: true,
      mode: 'thinking', // NOT deep_research — no unmetered council on untrusted external traffic
      recoveryForMessageId: 'm-wh',
    }));
  });

  it('a SCHEDULE wake on a deep_research-stored chat re-fires at deep_research (fireScheduleTarget applies no clamp — the stored mode is faithful there)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([
      orphanRow({
        id: 'm-l3', chatId: 'c-l3', chatMode: 'deep_research',
        metadata: { origin: 'schedule', machineMessage: 'council work order' },
      }),
    ]);
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({ mode: 'deep_research', machineWake: true }));
  });
});

describe('env knob clamp (review N5)', () => {
  it('garbage CHAT_ORPHAN_UNANSWERED_GRACE_MS falls back to the 5-min default — no NaN anywhere', async () => {
    process.env.CHAT_ORPHAN_UNANSWERED_GRACE_MS = 'garbage';
    try {
      mockPrisma.$queryRaw.mockResolvedValue([orphanRow()]);
      await sweepOrphanedChatTurns();
      // The 60-min-old row is still detected (default grace applies)…
      expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
      // …and no Invalid Date (Number('garbage') === NaN) reached the SQL params.
      const flat = mockPrisma.$queryRaw.mock.calls.flat();
      const invalidDates = flat.filter((a: any) => a instanceof Date && Number.isNaN(a.getTime()));
      expect(invalidDates).toEqual([]);
    } finally {
      delete process.env.CHAT_ORPHAN_UNANSWERED_GRACE_MS;
    }
  });
});

// ── Deploy-interrupt requeue (feedback 56159c5a) ─────────────────────────────

/** Seed one raw requeue-list entry; returns the raw (for keep/retire asserts). */
function pushEntry(over: Record<string, unknown> = {}): string {
  const raw = JSON.stringify({ chatId: 'c1', userMessageId: 'm1', reason: 'deploy', at: new Date().toISOString(), ...over });
  redisLists.set(DEPLOY_REQUEUE_KEY, [...(redisLists.get(DEPLOY_REQUEUE_KEY) ?? []), raw]);
  return raw;
}

/**
 * Route $queryRaw by SQL shape: the load-one-user-row query (drain + Rule C)
 * returns `byId`; the Rule-C scan returns `interruptRows`; the Rule-B scan
 * gets [] unless `ruleBRows` says otherwise.
 */
function mockQueryRouter(opts: { byId?: any | null; interruptRows?: any[]; ruleBRows?: any[] } = {}) {
  mockPrisma.$queryRaw.mockImplementation(async (strings: any, ..._values: any[]) => {
    const sql = String(strings?.join ? strings.join('?') : strings);
    if (sql.includes('WHERE m."id" = ')) return opts.byId ? [opts.byId] : [];
    if (sql.includes(`metadata"->>'origin'`)) return opts.interruptRows ?? [];
    return opts.ruleBRows ?? [];
  });
}

const INTERRUPT_META = { origin: DEPLOY_INTERRUPT_ORIGIN, interruptedMessageId: 'm1', reason: 'deploy' };

describe('deploy requeue drain — the old color’s interrupted turns re-fire on the new one', () => {
  it('valid entry + latest-is-user → re-fired with recoveryForMessageId + marker, entry RETIRED', async () => {
    pushEntry();
    mockQueryRouter({ byId: orphanRow() });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'm1', role: 'user', metadata: null });
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'c1',
      message: 'orphaned question',
      recoveryForMessageId: 'm1',
      userTurnAt: OLD,
    }));
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(1); // the recovery marker
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });

  it('latest is the deploy-interrupt row REFERENCING the user row → still re-fires (ritual row stands between)', async () => {
    pushEntry();
    mockQueryRouter({ byId: orphanRow() });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'm-int', role: 'assistant', metadata: INTERRUPT_META });
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({ recoveryForMessageId: 'm1' }));
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });

  it('latest is a REAL answer (the doomed run finished anyway) → entry RETIRED without re-firing', async () => {
    pushEntry();
    mockQueryRouter({ byId: orphanRow() });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'm-ans', role: 'assistant', metadata: { origin: 'user' } });
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });

  it('busy chat → entry KEPT for a later pass, never double-fired', async () => {
    await claimChatLiveRun('c1'); // another instance's run owns the chat
    const raw = pushEntry();
    mockQueryRouter({ byId: orphanRow() });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'm1', role: 'user', metadata: null });
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([raw]);
  });

  it('lost start race → entry KEPT and NO marker (the marker lands only after a won claim)', async () => {
    mockStartDetachedChatRun.mockResolvedValue(null);
    const raw = pushEntry();
    mockQueryRouter({ byId: orphanRow() });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'm1', role: 'user', metadata: null });
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([raw]);
  });

  it('malformed, stale (>TTL), and missing-row entries are RETIRED without re-firing', async () => {
    pushEntry();
    redisLists.set(DEPLOY_REQUEUE_KEY, [
      'not-json',
      JSON.stringify({ chatId: 'c1', userMessageId: 'm1', reason: 'deploy', at: new Date(Date.now() - 3 * 3600_000).toISOString() }),
      JSON.stringify({ chatId: 'c1', userMessageId: 'm-gone', reason: 'deploy', at: new Date().toISOString() }),
    ]);
    mockQueryRouter({ byId: null }); // referenced rows are gone
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });

  it('budget-spent referenced row → escalate ONCE naming the attempt count, entry RETIRED', async () => {
    pushEntry();
    mockQueryRouter({ byId: orphanRow({ metadata: { recovery: { firedAt: OLD.toISOString(), attempts: MAX_BUDGET } } }) });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'm1', role: 'user', metadata: null });
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('c1', 'attention_needed', expect.stringContaining(`recovery attempts (${MAX_BUDGET}) also died`));
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });

  it('an lRange failure aborts the pass FAIL-CLOSED — entries kept, nothing fired', async () => {
    const raw = pushEntry();
    mockRedis.lRange.mockRejectedValue(new Error('redis down'));
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('fail-closed'));
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([raw]);
  });

  it('the SWEEP drains the requeue list too (boot-drain is the fast path, the sweep the steady one)', async () => {
    pushEntry();
    mockQueryRouter({ byId: orphanRow() });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: 'm1', role: 'user', metadata: null });
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({ recoveryForMessageId: 'm1' }));
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });
});

describe('rule C — deploy-interrupt row backstop (the requeue entry never landed)', () => {
  it('old latest-is-deploy-interrupt row → the REFERENCED user row re-fires down the shared path', async () => {
    mockQueryRouter({
      interruptRows: [{ id: 'm-int', chatId: 'c1', metadata: INTERRUPT_META }],
      byId: orphanRow(),
    });
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      chatId: 'c1',
      recoveryForMessageId: 'm1',
      userTurnAt: OLD,
    }));
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(1); // the shared attempts marker
    // The scan pins the deploy-interrupt origin as a bound parameter.
    const flat = mockPrisma.$queryRaw.mock.calls.flat();
    expect(flat).toContain(DEPLOY_INTERRUPT_ORIGIN);
  });

  it('no interrupt rows → a no-op pass (Rule B unaffected)', async () => {
    mockQueryRouter({ ruleBRows: [orphanRow({ id: 'm-ruleB' })] });
    await sweepOrphanedChatTurns();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({ recoveryForMessageId: 'm-ruleB' }));
  });
});

describe('audit 2026-09-26: a deploy-cut Dig-deeper rung re-fires AS the rung (never a plain re-ask)', () => {
  const ORIG_ID = 'm-orig-asst';
  const AT = new Date(Date.now() - 60_000).toISOString();
  beforeEach(() => {
    mockPrisma.crossModelMessage.findUnique = jest.fn(async () => ({ id: ORIG_ID, chatId: 'c1', createdAt: new Date('2026-09-26T20:00:00Z'), metadata: { depth: { plan: { preset: 'thinking' }, escalations: [{ rung: 'research', at: AT, status: 'interrupted' }] } } }));
    mockPrisma.crossModelChat.findUnique = jest.fn(async () => ({ userId: 'u1', archivedAt: null }));
    mockPrisma.crossModelMessage.findFirst.mockImplementation(async (q: any) => (q?.where?.role === 'user' ? { content: 'the original question' } : null));
  });
  it('re-fires startDetachedChatRun with `escalation` + the rung mode + the original question; the entry is retired', async () => {
    pushEntry({ userMessageId: 'm-user-q', escalation: { ofMessageId: ORIG_ID, rung: 'research' }, at: AT });
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', chatId: 'c1', message: 'the original question', mode: 'deep_research', escalation: { ofMessageId: ORIG_ID, rung: 'research' },
    }));
    expect(mockStartDetachedChatRun.mock.calls[0][0].recoveryForMessageId).toBeUndefined();
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });
  it('a verify rung re-fires at thinking', async () => {
    pushEntry({ userMessageId: 'm-user-q', escalation: { ofMessageId: ORIG_ID, rung: 'verify' }, at: AT });
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).toHaveBeenCalledWith(expect.objectContaining({ mode: 'thinking', escalation: { ofMessageId: ORIG_ID, rung: 'verify' } }));
  });
  it('already landed (a "Deeper findings" row naming the message after the interrupt) → retired silently', async () => {
    mockPrisma.crossModelMessage.findFirst.mockImplementation(async (q: any) => (q?.where?.role === 'assistant' ? { metadata: { kind: 'deeper_findings', escalationOf: ORIG_ID } } : { content: 'q' }));
    pushEntry({ userMessageId: 'm-user-q', escalation: { ofMessageId: ORIG_ID, rung: 'research' }, at: AT });
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });
  it('a busy chat keeps the entry for a later pass', async () => {
    mockStartDetachedChatRun.mockResolvedValueOnce(null);
    const raw = pushEntry({ userMessageId: 'm-user-q', escalation: { ofMessageId: ORIG_ID, rung: 'research' }, at: AT });
    await drainDeployRequeue();
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([raw]);
  });
});

describe('cohesive-chat wave 2026-09-28 (review fix 3): a deploy-cut turn-continuation round re-queues AS the round', () => {
  const ORIG_ID = 'm-orig-asst';
  const AT = new Date(Date.now() - 60_000).toISOString();
  const STASH = { taskId: 't-1', round: 2, maxRounds: 3, reason: 'deadline_mid_task', ofMessageId: ORIG_ID, startedAt: '2026-09-28T00:00:00.000Z', askText: 'find the thread' };
  const PROMPT = '[HARNESS CONTINUATION r2/3 task=t-1 of=m-orig-asst reason=deadline_mid_task since=2026-09-28T00:00:00.000Z] — resume';
  const origRow = (status: string) => ({ id: ORIG_ID, chatId: 'c1', content: 'partial', parts: [{ type: 'text', text: 'partial' }], metadata: { task: { taskId: 't-1', kind: 'continuation', status } } });
  const pendingCreated: any[] = [];
  beforeEach(() => {
    pendingCreated.length = 0;
    mockPrisma.crossModelMessage.findUnique = jest.fn(async () => origRow('running'));
    // crossModelMessage.findMany serves TWO readers here: the supersede check
    // (role 'user' rows newer than the task — none by default) and the merged
    // task-events persist's carrier scan (role 'assistant' — the orig row,
    // which already carries metadata.task; never an invented row).
    mockPrisma.crossModelMessage.findMany = jest.fn(async (q: any) => (q?.where?.role === 'assistant' ? [origRow('running')] : []));
    mockPrisma.crossModelChat.findUnique = jest.fn(async () => ({ userId: 'u1', archivedAt: null }));
    mockPrisma.pendingChatMessage.count = jest.fn(async () => 0);
    mockPrisma.pendingChatMessage.create = jest.fn(async (a: any) => { const row = { id: `pend-${pendingCreated.length + 1}`, ...a.data }; pendingCreated.push(row); return row; });
  });
  afterAll(() => { delete mockPrisma.crossModelMessage.findMany; delete mockPrisma.pendingChatMessage.count; delete mockPrisma.pendingChatMessage.create; });

  it('re-enqueues the SAME round (source schedule + the continuation stash) and drains the chat; the entry is retired; never startDetachedChatRun with the prompt as a plain ask', async () => {
    pushEntry({ userMessageId: ORIG_ID, continuation: { stash: STASH, prompt: PROMPT, mode: 'thinking' }, at: AT });
    await drainDeployRequeue();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(pendingCreated).toHaveLength(1);
    expect(pendingCreated[0]).toMatchObject({ chatId: 'c1', userId: 'u1', content: PROMPT, mode: 'thinking', source: 'schedule' });
    expect(JSON.parse(redisStore.get('chat:pendingorigin:pend-1')!)).toEqual({ kind: 'schedule', continuation: STASH });
    expect(mockDrainChatQueue).toHaveBeenCalledWith('c1', 'u1');
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });
  it('a card no longer "running" for this task (settled meanwhile) → retired silently', async () => {
    mockPrisma.crossModelMessage.findUnique = jest.fn(async () => origRow('done'));
    pushEntry({ userMessageId: ORIG_ID, continuation: { stash: STASH, prompt: PROMPT, mode: 'thinking' }, at: AT });
    await drainDeployRequeue();
    expect(pendingCreated).toHaveLength(0);
    expect(mockDrainChatQueue).not.toHaveBeenCalled();
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });
  it('a user message newer than the task supersedes it: the card is settled waiting_user with the superseded line, nothing re-queued, entry retired', async () => {
    mockPrisma.crossModelMessage.findMany = jest.fn(async (q: any) => (q?.where?.role === 'assistant' ? [origRow('running')] : [{ id: 'user-newer', metadata: null }]));
    pushEntry({ userMessageId: ORIG_ID, continuation: { stash: STASH, prompt: PROMPT, mode: 'thinking' }, at: AT });
    await drainDeployRequeue();
    expect(pendingCreated).toHaveLength(0);
    const upd = mockPrisma.crossModelMessage.update.mock.calls.find((c: any) => c[0].where.id === ORIG_ID)?.[0];
    expect(upd.data.metadata.task).toMatchObject({ taskId: 't-1', status: 'waiting_user' });
    expect(upd.data.parts.some((p: any) => p.type === 'task' && /newer message took over/.test(p.task.note))).toBe(true);
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });
  it('an enqueue failure (queue full) settles the card as failed so it never stays running; entry retired', async () => {
    mockPrisma.pendingChatMessage.count = jest.fn(async () => 20);
    pushEntry({ userMessageId: ORIG_ID, continuation: { stash: STASH, prompt: PROMPT, mode: 'thinking' }, at: AT });
    await drainDeployRequeue();
    expect(pendingCreated).toHaveLength(0);
    const upd = mockPrisma.crossModelMessage.update.mock.calls.find((c: any) => c[0].where.id === ORIG_ID)?.[0];
    expect(upd.data.metadata.task).toMatchObject({ taskId: 't-1', status: 'failed' });
    expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([]);
  });
  it('a busy chat keeps the entry for a later pass', async () => {
    startLiveRun('chat:c1');
    try {
      const raw = pushEntry({ userMessageId: ORIG_ID, continuation: { stash: STASH, prompt: PROMPT, mode: 'thinking' }, at: AT });
      await drainDeployRequeue();
      expect(pendingCreated).toHaveLength(0);
      expect(redisLists.get(DEPLOY_REQUEUE_KEY)).toEqual([raw]);
    } finally {
      endLiveRun('chat:c1');
    }
  });
});