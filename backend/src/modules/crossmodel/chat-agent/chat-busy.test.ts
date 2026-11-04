/**
 * chat-busy — the cross-process busy source of truth (P5 audit). Pins:
 *   - the ATOMIC start claim (Redis SET NX): concurrent claims on one chat
 *     have exactly ONE winner; release → claimable again; Redis outage fails
 *     OPEN (the local registry still closes the same-process race);
 *   - isChatBusy unions all three layers: local registry (both key forms),
 *     the Redis liveness key, and durable agent_runs rows;
 *   - getBusyChatIds batches: ONE MGET + ONE agent_runs query, never per-chat;
 *   - the cross-process stop channel round-trips (request → take once), reports
 *     honestly whether the flag landed, and a fresh claim clears a stale stop
 *     request left by the previous run;
 *   - getMachineLockedChatIds is the batched FAIL-SAFE machine-lock read
 *     (attention-watchdog zombie-run stop, 2026-09-10): machine-marked values
 *     only, ONE MGET, Redis outage → empty set.
 *
 * live-runs is the REAL in-memory registry; Redis is an in-memory fake with
 * REAL NX semantics (the atomicity under test); prisma is a stand-in.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisStore = new Map<string, string>();
const mockRedis = {
  set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean; EX?: number }) => {
    if (opts?.NX && redisStore.has(k)) return null; // real SET NX contract
    redisStore.set(k, v);
    return 'OK';
  }),
  get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
  mGet: jest.fn(async (keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import {
  claimChatLiveRun, refreshChatLiveRun, releaseChatLiveRun,
  requestChatRunStop, takeChatRunStopRequest,
  isChatBusy, isChatBusyLocally, isChatBusyStrict, getBusyChatIds, hasRemoteChatRun,
  getMachineLockedChatIds,
} from './chat-busy';
import { startLiveRun, endLiveRun } from '../coding/live-runs';

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
});

describe('claimChatLiveRun — the atomic cross-process start gate', () => {
  it('two concurrent starts → exactly ONE winner (SET NX)', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claimChatLiveRun('c1')));
    expect(results.filter(Boolean)).toHaveLength(1);
    // …and the loser on a DIFFERENT chat is unaffected.
    await expect(claimChatLiveRun('c2')).resolves.toBe(true);
  });

  it('release frees the slot for the next run (the drain re-claims after the finally)', async () => {
    await expect(claimChatLiveRun('c1')).resolves.toBe(true);
    await expect(claimChatLiveRun('c1')).resolves.toBe(false);
    await releaseChatLiveRun('c1');
    await expect(claimChatLiveRun('c1')).resolves.toBe(true);
  });

  it('fails OPEN on a Redis outage — the local registry still guards same-process', async () => {
    mockRedis.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(claimChatLiveRun('c1')).resolves.toBe(true);
  });

  it('sets the liveness key with a TTL and clears any stale stop request', async () => {
    await requestChatRunStop('c1'); // a Stop that raced the PREVIOUS run's end
    await claimChatLiveRun('c1');
    expect(mockRedis.set).toHaveBeenCalledWith('cm:liverun:c1', expect.any(String), { NX: true, EX: 60 });
    // The stale request must not cancel the run it never targeted.
    await expect(takeChatRunStopRequest('c1')).resolves.toBe(false);
  });
});

describe('cross-process stop channel', () => {
  it('round-trips: absent → false, request → take true, taken → false again', async () => {
    await expect(takeChatRunStopRequest('c1')).resolves.toBe(false);
    await requestChatRunStop('c1');
    await expect(takeChatRunStopRequest('c1')).resolves.toBe(true);
    await expect(takeChatRunStopRequest('c1')).resolves.toBe(false);
  });

  it('is per-chat', async () => {
    await requestChatRunStop('c1');
    await expect(takeChatRunStopRequest('c2')).resolves.toBe(false);
    await expect(takeChatRunStopRequest('c1')).resolves.toBe(true);
  });

  it('answers honestly whether the flag landed: true on success, false on a Redis outage (zombie-stop dedupe release, 2026-09-10)', async () => {
    await expect(requestChatRunStop('c1')).resolves.toBe(true);
    mockRedis.set.mockRejectedValueOnce(new Error('redis down'));
    await expect(requestChatRunStop('c2')).resolves.toBe(false);
    await expect(takeChatRunStopRequest('c2')).resolves.toBe(false); // and the flag truly never landed
  });
});

describe('getMachineLockedChatIds — batched machine-lock read (zombie-run stop, 2026-09-10)', () => {
  it('returns ONLY chats whose lock value carries the machine marker — user claims and idle chats are excluded', async () => {
    await claimChatLiveRun('c-machine', { machineTriggered: true });
    await claimChatLiveRun('c-user'); // user-triggered claim (bare pid value)
    redisStore.set('cm:liverun:c-labeled', '1:user'); // explicit non-machine label
    const locked = await getMachineLockedChatIds(['c-machine', 'c-user', 'c-labeled', 'c-idle']);
    expect([...locked]).toEqual(['c-machine']);
    // Batching pinned: ONE MGET over all four keys, never per-chat.
    expect(mockRedis.mGet).toHaveBeenCalledTimes(1);
    expect(mockRedis.mGet).toHaveBeenCalledWith([
      'cm:liverun:c-machine', 'cm:liverun:c-user', 'cm:liverun:c-labeled', 'cm:liverun:c-idle',
    ]);
  });

  it('fails SAFE: a Redis outage answers the empty set (a degraded read can never nominate a chat for a stop)', async () => {
    await claimChatLiveRun('c-machine', { machineTriggered: true });
    mockRedis.mGet.mockRejectedValueOnce(new Error('redis down'));
    await expect(getMachineLockedChatIds(['c-machine'])).resolves.toEqual(new Set());
  });

  it('empty input skips Redis entirely', async () => {
    await expect(getMachineLockedChatIds([])).resolves.toEqual(new Set());
    expect(mockRedis.mGet).not.toHaveBeenCalled();
  });
});

describe('isChatBusy — the ONE union check', () => {
  it('sees a LOCAL chat-agent run (chat:<id>) without touching Redis or the DB', async () => {
    startLiveRun('chat:c1');
    try {
      await expect(isChatBusy('c1')).resolves.toBe(true);
      expect(isChatBusyLocally('c1')).toBe(true);
      expect(mockRedis.exists).not.toHaveBeenCalled();
      expect(mockPrisma.agentRun.findFirst).not.toHaveBeenCalled();
    } finally {
      endLiveRun('chat:c1');
    }
  });

  it('sees a LOCAL coding run (bare id key form)', async () => {
    startLiveRun('c1');
    try {
      await expect(isChatBusy('c1')).resolves.toBe(true);
    } finally {
      endLiveRun('c1');
    }
  });

  it("sees ANOTHER process's chat run through its Redis liveness key", async () => {
    await claimChatLiveRun('c1'); // "instance A" claimed; we are "instance B"
    await expect(isChatBusy('c1')).resolves.toBe(true);
    await expect(hasRemoteChatRun('c1')).resolves.toBe(true);
    expect(mockPrisma.agentRun.findFirst).not.toHaveBeenCalled();
  });

  it('sees a WORKER-executed coding run through the durable agent_runs table', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run-1' });
    await expect(isChatBusy('c1')).resolves.toBe(true);
    expect(mockPrisma.agentRun.findFirst).toHaveBeenCalledWith({
      where: { sessionId: 'c1', status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
  });

  it('idle everywhere → false; Redis/DB hiccups degrade to "not busy", never throw', async () => {
    await expect(isChatBusy('c1')).resolves.toBe(false);
    mockRedis.exists.mockRejectedValueOnce(new Error('redis down'));
    mockPrisma.agentRun.findFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(isChatBusy('c1')).resolves.toBe(false);
  });
});

describe('isChatBusyStrict — the fail-CLOSED sweeper probe (ticket 68bc5aec)', () => {
  it('healthy answers match isChatBusy on every layer (local / remote / durable / idle)', async () => {
    // Idle everywhere → false.
    await expect(isChatBusyStrict('c1')).resolves.toBe(false);
    // Local registry.
    startLiveRun('chat:c-local');
    mockRedis.exists.mockClear(); // the idle probe above already used it
    try {
      await expect(isChatBusyStrict('c-local')).resolves.toBe(true);
      expect(mockRedis.exists).not.toHaveBeenCalled(); // local fast path short-circuits
    } finally {
      endLiveRun('chat:c-local');
    }
    // Remote liveness key.
    await claimChatLiveRun('c-remote');
    await expect(isChatBusyStrict('c-remote')).resolves.toBe(true);
    // Durable worker-tier run.
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run-1' });
    await expect(isChatBusyStrict('c-worker')).resolves.toBe(true);
    expect(mockPrisma.agentRun.findFirst).toHaveBeenCalledWith({
      where: { sessionId: 'c-worker', status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
  });

  it('PROPAGATES a Redis error instead of degrading to idle (the sweeper aborts its pass)', async () => {
    mockRedis.exists.mockRejectedValueOnce(new Error('redis down'));
    await expect(isChatBusyStrict('c1')).rejects.toThrow('redis down');
    // …where the fail-open sibling degrades to "not busy" on the same outage.
    mockRedis.exists.mockRejectedValueOnce(new Error('redis down'));
    await expect(isChatBusy('c1')).resolves.toBe(false);
  });

  it('PROPAGATES a DB error from the durable layer', async () => {
    mockPrisma.agentRun.findFirst.mockRejectedValueOnce(new Error('db down'));
    await expect(isChatBusyStrict('c1')).rejects.toThrow('db down');
  });
});

describe('getBusyChatIds — batched for list surfaces', () => {
  it('unions local + Redis + agent_runs in ONE MGET and ONE findMany', async () => {
    startLiveRun('chat:c-local');
    await claimChatLiveRun('c-remote');
    mockPrisma.agentRun.findMany.mockResolvedValue([{ sessionId: 'c-worker' }]);
    try {
      const busy = await getBusyChatIds(['c-local', 'c-remote', 'c-worker', 'c-idle']);
      expect([...busy].sort()).toEqual(['c-local', 'c-remote', 'c-worker']);
      // Batching pinned: one Redis round trip for every non-local chat…
      expect(mockRedis.mGet).toHaveBeenCalledTimes(1);
      expect(mockRedis.mGet).toHaveBeenCalledWith(['cm:liverun:c-remote', 'cm:liverun:c-worker', 'cm:liverun:c-idle']);
      // …and one durable query for whatever Redis did not resolve.
      expect(mockPrisma.agentRun.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.agentRun.findMany).toHaveBeenCalledWith({
        where: { sessionId: { in: ['c-worker', 'c-idle'] }, status: { in: ['queued', 'running'] } },
        select: { sessionId: true },
      });
    } finally {
      endLiveRun('chat:c-local');
    }
  });

  it('all-local input skips Redis and the DB entirely', async () => {
    startLiveRun('chat:c1');
    try {
      const busy = await getBusyChatIds(['c1']);
      expect(busy.has('c1')).toBe(true);
      expect(mockRedis.mGet).not.toHaveBeenCalled();
      expect(mockPrisma.agentRun.findMany).not.toHaveBeenCalled();
    } finally {
      endLiveRun('chat:c1');
    }
  });

  it('degrades gracefully: a Redis failure still returns the durable layer', async () => {
    mockRedis.mGet.mockRejectedValueOnce(new Error('redis down'));
    mockPrisma.agentRun.findMany.mockResolvedValue([{ sessionId: 'c2' }]);
    const busy = await getBusyChatIds(['c1', 'c2']);
    expect([...busy]).toEqual(['c2']);
  });

  it('refreshChatLiveRun extends the TTL without NX (owner refresh)', async () => {
    await claimChatLiveRun('c1');
    await refreshChatLiveRun('c1');
    expect(mockRedis.set).toHaveBeenLastCalledWith('cm:liverun:c1', expect.any(String), { EX: 60 });
  });
});
