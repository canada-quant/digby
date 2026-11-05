/**
 * Replay pin — ticket 97c06f46, the reclaim half (ticket-dispatch.service).
 *
 * THE INCIDENT: the supervisor's lane-chat lookup returned "Chat not found"
 * for LIVE lanes (access-scoped 404 misread as deletion — the lookup half is
 * pinned in platform-tools.97c06f46.test.ts), and the false "confirmed
 * DELETED" evidence fed the slot-reclaim judgment: the overnight ticket queue
 * stall produced a reclaim-flavored ticket (2dc0988c) whose lane-deletion
 * premise was false while both lanes were alive.
 *
 * THE FIX (this file's subject): the ticket-drain reclaim path never acts on
 * ONE absent read anymore.
 *   - claimingSessionAlive FAILS SAFE: a failed probe reads ALIVE-UNKNOWN
 *     (the ticket keeps its claim; next drain re-probes) — not dead.
 *     Kill switch TICKET_LIVENESS_FAILSAFE_DISABLED=1 restores dead-on-error.
 *   - confirmedAbsentTwice: the FIRST absent probe records a Redis stamp and
 *     HOLDS; only a drain that finds the stamp already set acts, then clears
 *     it. An ALIVE probe in between clears the stamp — consecutive means
 *     consecutive. Kill switch TICKET_RECLAIM_TWO_PROBE_DISABLED=1 restores
 *     single-probe behavior.
 *
 * Runs against the REAL drain (drainOpenTicketsToLane → drainToFreshLanes)
 * with the fresh-lanes scaffold: mocked prisma + real-NX redis (the same
 * harness ticket-dispatch.fresh-lanes.test.ts uses).
 */

const tickets: any[] = [];
const runs: any[] = [];
const kv = new Map<string, string>();
const chats = new Map<string, { userId: string; projectId: string | null; archivedAt: Date | null }>();

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const matchesWhere = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (v === undefined) return true;
    if (k === 'OR') return (v as any[]).some((c) => matchesWhere(row, c));
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    if (v && typeof v === 'object' && 'gte' in v) return new Date(row[k]) >= v.gte;
    if (v && typeof v === 'object' && 'lt' in v) return new Date(row[k]) < v.lt;
    return row[k] === v;
  });

const mockPrisma: any = {
  crossModelChat: {
    findUnique: jest.fn(async ({ where }: any) => chats.get(where.id) ?? null),
    update: jest.fn(async ({ where, data }: any) => { const c = chats.get(where.id); if (c) Object.assign(c, data); return c; }),
  },
  userFeatureRequest: {
    findMany: jest.fn(async ({ where }: any) => tickets.filter((t) => matchesWhere(t, where))),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      const ids = where?.id?.in;
      for (const t of tickets) {
        if (!ids || ids.includes(t.id)) { Object.assign(t, data, { updatedAt: new Date() }); count++; }
      }
      return { count };
    }),
    update: jest.fn(async ({ where, data }: any) => { const t = tickets.find((x) => x.id === where.id); if (t) Object.assign(t, data, { updatedAt: new Date() }); return t; }),
  },
  agentRun: {
    findMany: jest.fn(async ({ where }: any) => runs.filter((r) => where.sessionId.in.includes(r.sessionId))),
    count: jest.fn(async ({ where }: any) => runs.filter((r) => r.sessionId === where.sessionId
      && (!where.status?.in || where.status.in.includes(r.status))
      && (!where.updatedAt?.gte || r.updatedAt >= where.updatedAt.gte)).length),
  },
  chatCodingState: { findMany: jest.fn(async () => []) },
  // TICKET-LANE ARCHIVE GAPS review (2026-10-21): archiveTicketLane's owner-armed
  // schedule guard reads this (fail-closed without it) — no owner rows here.
  chatSchedule: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Redis with REAL NX semantics — the absent-confirm gate's first/second
// distinction is exactly an NX set (fresh-lanes harness pattern).
const mockRedisSet = jest.fn(async (key: string, value: string, opts?: any) => {
  if (opts?.NX && kv.has(key)) return null;
  kv.set(key, value);
  return 'OK';
});
const mockRedisDel = jest.fn(async (key: string) => { kv.delete(key); return 1; });
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (k: string, v: string, o?: any) => mockRedisSet(k, v, o),
    incr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
    del: (k: string) => mockRedisDel(k),
    decr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) - 1; kv.set(k, String(n)); return n; }),
  },
}));

// main's d34f1d6a noticeLaneSlotReleased lazy-imports hooks.service →
// error-handler → config/env (process.exit(1) env-less, kills the worker) —
// mock it out for this suite (the slot-release behavior is d34f1d6a's own
// suite's subject, not ours).
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  depthForChat: jest.fn(async () => 1),
}));

let spawnSeq = 0;
const mockStartCodingSession = jest.fn(async (_o: any) => ({ id: `lane${++spawnSeq}-0000-0000-0000-000000000000` }));
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: (o: any) => mockStartCodingSession(o),
  sendChatMessage: jest.fn(async () => ({ queued: true })),
  archiveChat: jest.fn(async ({ chatId }: any) => { const c = chats.get(chatId); if (c) c.archivedAt = new Date(); return { id: chatId, archived: true }; }),
}));

import { drainOpenTicketsToLane } from './ticket-dispatch.service';

const H = 3600_000;
const LANE_HOME = 'home-lane-0000-0000-0000-000000000000';
const ENV = { ...process.env };

function claimed(id: string, laneSession: string, over: any = {}) {
  return {
    id, type: 'bug_report', title: `Ticket ${id}`, description: 'd', priority: 2, source: 'user',
    status: 'in_progress', adminNote: null, userId: 'owner-1',
    createdAt: new Date(Date.now() - 48 * H), updatedAt: new Date(Date.now() - 10 * H),
    context: { dispatchMode: 'ticket_lane', dispatchedTo: laneSession, dispatchedAt: new Date(Date.now() - 10 * H).toISOString(), laneDispatches: 1 },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = LANE_HOME;
  delete process.env.TICKET_DISPATCH_FRESH_LANES_DISABLED;
  for (const k of ['TICKET_LIVENESS_FAILSAFE_DISABLED', 'TICKET_RECLAIM_TWO_PROBE_DISABLED', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_NIGHT_HOURS', 'TICKET_LANE_MAX_DISPATCHES']) delete process.env[k];
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope'; // force the day cap regardless of CI hour
  tickets.length = 0;
  runs.length = 0;
  kv.clear();
  chats.clear();
  spawnSeq = 0;
  chats.set(LANE_HOME, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
});
afterAll(() => { process.env = ENV; });

describe('97c06f46 — the reclaim needs TWO consecutive confirmed-absent probes', () => {
  it('a dead claiming session: the FIRST absent drain records + holds; only the SECOND reclaims', async () => {
    tickets.push(claimed('aaaaaaa1-0', 'lane-dead-0000-0000-0000-000000000000'));
    runs.length = 0; // the claiming session has no runs at all → absent

    // Drain 1: the first absent probe — holds, records the stamp, NO reclaim.
    const r1 = await drainOpenTicketsToLane();
    expect(r1.batched ?? 0).toBe(0);
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(tickets[0].status).toBe('in_progress');
    expect([...kv.keys()].some((k) => k.startsWith('ticket-dispatch:absent:'))).toBe(true);

    // Drain 2: the second consecutive absent probe — reclaims and re-dispatches.
    const r2 = await drainOpenTicketsToLane();
    expect(r2.result).toBe('sent');
    expect(mockStartCodingSession).toHaveBeenCalled();
    expect(tickets[0].status).toBe('in_progress'); // re-dispatched to a fresh lane
    expect(String(tickets[0].context.dispatchedTo)).not.toBe('lane-dead-0000-0000-0000-000000000000');
  });

  it('an ALIVE probe between two absent drains CLEARS the episode (consecutive means consecutive)', async () => {
    tickets.push(claimed('aaaaaaa2-0', 'lane-flap-0000-0000-0000-000000000000'));
    runs.length = 0;

    // Drain 1: absent → stamp + hold.
    await drainOpenTicketsToLane();
    expect([...kv.keys()].some((k) => k.startsWith('ticket-dispatch:absent:'))).toBe(true);

    // The lane comes back to life (a run inside the activity window) → drain 2
    // probes ALIVE: not reclaimed AND the absent episode is cleared.
    runs.push({ sessionId: 'lane-flap-0000-0000-0000-000000000000', status: 'running', createdAt: new Date(), updatedAt: new Date() });
    const r2 = await drainOpenTicketsToLane();
    expect(r2.batched ?? 0).toBe(0);
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect([...kv.keys()].some((k) => k.startsWith('ticket-dispatch:absent:'))).toBe(false);

    // Drain 3: absent again — but this is a FRESH episode (first probe), so it
    // holds once more; only a fourth (second-consecutive) drain would act.
    runs.length = 0;
    const r3 = await drainOpenTicketsToLane();
    expect(r3.batched ?? 0).toBe(0);
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(tickets[0].status).toBe('in_progress');
  });

  it('a FAILED liveness probe reads ALIVE-UNKNOWN, fail-safe: the claim holds and no absent stamp is written', async () => {
    // A LEGACY dispatch (no ticket_lane mode) — this is the branch whose
    // liveness probe is claimingSessionAlive (agentRun.count), the exact
    // probe whose error class the fail-safe exists for.
    tickets.push(claimed('aaaaaaa3-0', 'lane-err-0000-0000-0000-000000000000', { context: { dispatchedTo: 'lane-err-0000-0000-0000-000000000000', dispatchedAt: new Date(Date.now() - 10 * H).toISOString() } }));
    // The DB error the fail-safe exists for: the agentRun probe throws.
    mockPrisma.agentRun.count.mockRejectedValueOnce(new Error('connection reset'));

    const r = await drainOpenTicketsToLane();
    expect(r.batched ?? 0).toBe(0);
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(tickets[0].status).toBe('in_progress');
    // No absent-confirmation episode for a probe we could not read.
    expect([...kv.keys()].some((k) => k.startsWith('ticket-dispatch:absent:'))).toBe(false);
  });

  it('MAJOR-1 (review 97c06f46): two rows sharing ONE claiming session still need TWO consecutive absent drains — row 2 may not ride row 1 stamp within one drain', async () => {
    // Two stale legacy in_progress rows, both dispatched to the SAME dead
    // session (the parallel-batch shape). Without the per-drain memo, row 1's
    // confirmedAbsentTwice writes the stamp (hold) and row 2 finds it, consumes
    // it and acts — one liveness read reclaiming both rows. With the memo, row
    // 2 sees row 1's HOLD: drain 1 reclaims NOTHING, drain 2 reclaims both.
    tickets.push(
      claimed('aaaaaaa6-0', 'shared-dead-0000-0000-000000000000', { context: { dispatchedTo: 'shared-dead-0000-0000-000000000000', dispatchedAt: new Date(Date.now() - 10 * H).toISOString() } }),
      claimed('aaaaaaa7-0', 'shared-dead-0000-0000-000000000000', { context: { dispatchedTo: 'shared-dead-0000-0000-000000000000', dispatchedAt: new Date(Date.now() - 10 * H).toISOString() } }),
    );
    runs.length = 0; // the shared claiming session is dead

    // Drain 1: BOTH rows hold (the shared session's first absent probe).
    const r1 = await drainOpenTicketsToLane();
    expect(r1.batched ?? 0).toBe(0);
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(tickets.every((t) => t.status === 'in_progress')).toBe(true);

    // Drain 2 (fresh map): the second consecutive absent probe — both rows act.
    const r2 = await drainOpenTicketsToLane();
    expect(r2.result).toBe('sent');
    expect(mockStartCodingSession).toHaveBeenCalledTimes(2);
  });

  it('TICKET_RECLAIM_TWO_PROBE_DISABLED=1 restores single-probe reclaim byte-for-byte', async () => {
    process.env.TICKET_RECLAIM_TWO_PROBE_DISABLED = '1';
    tickets.push(claimed('aaaaaaa4-0', 'lane-dead-0000-0000-0000-000000000000'));
    runs.length = 0;

    const r = await drainOpenTicketsToLane();
    expect(r.result).toBe('sent'); // first drain acts — the pre-fix behavior
    expect(mockStartCodingSession).toHaveBeenCalled();
    // and the gate wrote no stamps while disabled
    expect([...kv.keys()].some((k) => k.startsWith('ticket-dispatch:absent:'))).toBe(false);
  });

  it('TICKET_LIVENESS_FAILSAFE_DISABLED=1 restores dead-on-error (legacy)', async () => {
    process.env.TICKET_LIVENESS_FAILSAFE_DISABLED = '1';
    tickets.push(claimed('aaaaaaa5-0', 'lane-err-0000-0000-0000-000000000000'));
    mockPrisma.agentRun.count.mockRejectedValueOnce(new Error('connection reset'));

    // Drain 1: error → dead (legacy) → first absent stamp.
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled(); // two-probe gate still on
    expect([...kv.keys()].some((k) => k.startsWith('ticket-dispatch:absent:'))).toBe(true);
    // Drain 2 with a clean read (still dead) → acts.
    const r2 = await drainOpenTicketsToLane();
    expect(r2.result).toBe('sent');
  });
});
