/**
 * DISPATCH/CLOSE RACE (ticket 1a6afc6a — mishap replay, 2026-10-24).
 *
 * Prod shape this replays: the drain's scan read ticket fa5f7ee3 open at
 * 08:10:20.3xx, claimed it and spawned a dedicated lane (chat db001b48) at
 * 08:10:20.383Z; the Fleet Supervisor closed the ticket done at
 * 08:10:20.937Z — 0.554s AFTER the dispatch stamp. Nothing between the scan
 * and startCodingSession re-read the row, and nothing in the lane's charter
 * told it to stand down on a closed ticket, so the lane planned 5 steps and
 * began re-executing a verified-done production config change until a
 * supervisor steered it down.
 *
 * Pins (1a6afc6a hardening):
 *   - the PRE-SPAWN RE-READ: a ticket that closed (done / deployed_verified /
 *     awaiting_verification / a legacy closed spelling) between the scan and
 *     the spawn NEVER gets its lane — claims released, cap token refunded,
 *     one ticket_dispatch_close_race loop_metric per blocked spawn;
 *   - the FAMILY shape: a closed RIDING MEMBER blocks the whole family spawn
 *     (a family closes as ONE — a closed member must never ride);
 *   - FAIL-CLOSED: a failed re-read skips the spawn too (never spawn on an
 *     unknown status);
 *   - the re-read must NOT block an open/in_progress/reopened row (the
 *     everyday path is unchanged);
 *   - the kill switch: TICKET_DISPATCH_CLOSE_RACE_DISABLED=1 restores the
 *     pre-fix claim→spawn byte-for-byte (the closed row gets its lane);
 *   - the charter: the STAND DOWN ON CLOSED clause rides both the solo and
 *     the family charter (the second half of the mishap — a lane dispatched
 *     before a close must stand down, not re-apply).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Row = {
  id: string; type: string; title: string; description: string; priority: number; source: string;
  status: string; adminNote: string | null; context: any; createdAt: Date; updatedAt: Date; userId?: string | null;
  user?: { role?: string | null } | null;
};
let tickets: Row[] = [];
let runs: Array<{ sessionId: string; status: string; createdAt: Date; updatedAt: Date }> = [];
const chats = new Map<string, { userId: string; projectId: string | null; archivedAt: Date | null }>();
const kv = new Map<string, string>();
const metricRows: any[] = [];

function matchesWhere(r: Row, where: any): boolean {
  if (!where) return true;
  if (where.id && typeof where.id === 'string' && r.id !== where.id) return false;
  if (where.id?.in && !where.id.in.includes(r.id)) return false;
  if (typeof where.status === 'string' && r.status !== where.status) return false;
  if (where.status?.in && !where.status.in.includes(r.status)) return false;
  if (where.updatedAt?.gte && r.updatedAt < where.updatedAt.gte) return false;
  if (where.context?.path && where.context.equals !== undefined) {
    const v = r.context?.[where.context.path[0]];
    if (v !== where.context.equals) return false;
  }
  return true;
}

import { withEmptyHouseRuleReads } from './ticket-dispatch.mock.9dacab1a';

const mockPrisma: any = {
  crossModelChat: {
    findUnique: jest.fn(async ({ where }: any) => {
      const c = chats.get(where.id);
      return c ? { ...c } : null;
    }),
  },
  crossModelProject: { findUnique: jest.fn(async () => null) },
  userFeatureRequest: {
    findMany: jest.fn(async ({ where, orderBy, take }: any) => {
      let out = tickets.filter((r) => matchesWhere(r, where));
      if (orderBy?.[0]?.priority) out = out.sort((a, b) => b.priority - a.priority || +a.createdAt - +b.createdAt);
      else if (orderBy?.createdAt) out = out.sort((a, b) => +a.createdAt - +b.createdAt);
      return (take ? out.slice(0, take) : out).map((r) => ({ ...r, context: r.context ? JSON.parse(JSON.stringify(r.context)) : r.context }));
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of tickets) {
        if (!matchesWhere(r, where)) continue;
        Object.assign(r, data, { updatedAt: new Date() });
        count++;
      }
      return { count };
    }),
    update: jest.fn(async () => ({})),
  },
  agentRun: {
    findMany: jest.fn(async ({ where }: any) => runs.filter((r) => where.sessionId.in.includes(r.sessionId))),
    count: jest.fn(async ({ where }: any) => runs.filter((r) => r.sessionId === where.sessionId
      && (!where.status?.in || where.status.in.includes(r.status))).length),
  },
  chatCodingState: { findMany: jest.fn(async () => []) },
  chatSchedule: { findMany: jest.fn(async () => []) },
  contextStoreEntry: { findUnique: jest.fn(async () => null) },
};
withEmptyHouseRuleReads(mockPrisma);
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

/**
 * The race simulation. The incident's window is: SCAN saw the row open →
 * CLAIM set the DEDUPE key → (0.554s: the Fleet Supervisor closed it) →
 * SPAWN ran. Flipping at the CLAIM reproduces it exactly: the flip MUST NOT
 * fire at the scan (the row would never be eligible) nor at the spawn (the
 * race would already be past). The redis `set` mock flips the row when the
 * DEDUPE key for THAT row is written — the claim is the incident's anchor.
 */
let flipOnClaim: Map<string, string> = new Map();

const mockRedisSet = jest.fn(async (key: string, value: string, opts?: any) => {
  if (opts?.NX && kv.has(key)) return null;
  const flip = flipOnClaim.get(key);
  if (flip) {
    const row = tickets.find((t) => DEDUPE_KEY_PREFIX + t.id === key);
    if (row) row.status = flip;
  }
  kv.set(key, value);
  return 'OK';
});
const DEDUPE_KEY_PREFIX = 'ticket-dispatch:';
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: (k: string, v: string, o?: any) => mockRedisSet(k, v, o),
    incr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
    del: jest.fn(async (k: string) => { kv.delete(k); return 1; }),
    decr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) - 1; kv.set(k, String(n)); return n; }),
  },
}));

let spawnSeq = 0;
const mockStartCodingSession = jest.fn(async (_opts: any) => ({ id: `${String(++spawnSeq).padStart(8, 'a')}-lane-session` }));
const mockArchiveChat = jest.fn(async ({ chatId }: any) => {
  const c = chats.get(chatId);
  if (c) c.archivedAt = new Date();
  return { id: chatId, archived: true };
});
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: (o: any) => mockStartCodingSession(o),
  sendChatMessage: jest.fn(async () => ({ queued: true })),
  archiveChat: (o: any) => mockArchiveChat(o),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (row: any) => { metricRows.push(row); },
  LOOP_METRIC_KINDS: { TICKET_DISPATCH_CLOSE_RACE: 'ticket_dispatch_close_race', TICKET_FAMILY_ROUTING: 'ticket_family_routing' },
}));

import {
  drainOpenTicketsToLane, ticketLaneCharter, familyLaneCharter, ticketDispatchCloseRaceDisabled,
} from './ticket-dispatch.service';

const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';
const ENV = { ...process.env };

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'bug_report', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 3, source: 'user', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), ...over,
  };
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;
/** The mishap specimen: the scan sees the row open; the close lands at the
 *  claim — 1a6afc6a's dispatch stamp (08:10:20.383Z) → close (08:10:20.937Z). */
const closesAtClaim = (id: string, closedStatus: string): Row => {
  const row = ticket(id);
  flipOnClaim.set(DEDUPE_KEY_PREFIX + id, closedStatus);
  return row;
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  for (const k of ['TICKET_DISPATCH_FRESH_LANES_DISABLED', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_CONCURRENCY_NIGHT', 'TICKET_LANE_NIGHT_HOURS', 'TICKET_LANE_NO_RUN_REDISPATCH_HOURS',
    'TICKET_LANE_MAX_DISPATCHES', 'TICKET_LANE_LEGACY_REDISPATCH_DISABLED', 'TICKET_LANE_PROJECT_ID', 'TICKET_DISPATCH_DAILY_CAP', 'TICKET_DISPATCH_ANY_USER',
    'TICKET_DISPATCH_CLOSE_RACE_DISABLED', 'TICKET_FAMILY_BATCHING_DISABLED', 'TICKET_FAMILY_PRECISION_ROUTING_DISABLED', 'TICKET_FAMILY_PREFIX_V2_DISABLED']) delete process.env[k];
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope';
  tickets = [];
  runs = [];
  kv.clear();
  chats.clear();
  metricRows.length = 0;
  spawnSeq = 0;
  flipOnClaim = new Map();
  chats.set(STANDING, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
});
afterAll(() => { process.env = ENV; });

describe('1a6afc6a — pre-spawn re-read blocks the close race', () => {
  it('a ticket that closed between the scan and the spawn NEVER gets its lane (the fa5f7ee3 shape)', async () => {
    tickets = [closesAtClaim('fa5f7ee3-0000-4000-8000-000000000001', 'done')];
    const r = await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(r.batched).toBe(0);
    // The row was closed DURING the drain: it keeps its closed status —
    // never re-stamped in_progress by the spawn stamp.
    expect(byId('fa5f7ee3-0000-4000-8000-000000000001').status).toBe('done');
    // Claims released + cap token refunded: a LATER drain on a genuinely
    // reopened row must not be wedged behind this drain's claim.
    expect(kv.has('ticket-dispatch:fa5f7ee3-0000-4000-8000-000000000001')).toBe(false);
    expect(metricRows.find((m) => m.kind === 'ticket_dispatch_close_race')).toEqual(expect.objectContaining({
      meta: expect.objectContaining({ phase: 'pre_spawn', laneFor: 'fa5f7ee3-0000-4000-8000-000000000001', blocked: ['fa5f7ee3:done'] }),
    }));
  });

  it.each(['done', 'deployed_verified', 'awaiting_verification', 'resolved', 'wontfix'] as const)(
    'every closed spelling blocks the spawn — status %s',
    async (closedStatus) => {
      tickets = [closesAtClaim(`race${closedStatus.length}-0000-4000-8000-000000000001`.slice(0, 36), closedStatus)];
      await drainOpenTicketsToLane();
      expect(mockStartCodingSession).not.toHaveBeenCalled();
    },
  );

  it('the everyday path is unchanged: an OPEN row still spawns (the re-read must not over-block)', async () => {
    tickets = [ticket('openrow000-0000-4000-8000-000000000001')];
    const r = await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(r.batched).toBe(1);
    expect(byId('openrow000-0000-4000-8000-000000000001').status).toBe('in_progress');
    expect(metricRows.find((m) => m.kind === 'ticket_dispatch_close_race')).toBeUndefined();
  });

  it('a FAILED re-read fails closed — no spawn on an unknown status', async () => {
    const row = ticket('failread0-0000-4000-8000-000000000001');
    tickets = [row];
    const realFindMany = mockPrisma.userFeatureRequest.findMany;
    // Fail ONLY the pre-spawn re-read — its exact query shape: a findMany
    // whose select is EXACTLY {id, status} over an id-in list. The scan
    // reads full rows (no select) and the closed-lane scan selects 4 fields
    // (id, status, context, updatedAt), so neither trips this; a wide
    // failure window would kill an UNRELATED read and make this test pass
    // vacuously even on pre-fix code (review finding 2a, 1a6afc6a).
    mockPrisma.userFeatureRequest.findMany = jest.fn(async (args: any) => {
      const sel = args?.select as Record<string, unknown> | undefined;
      if (sel && Object.keys(sel).length === 2 && sel.id && sel.status && args.where?.id?.in) {
        throw new Error('ECONNRESET');
      }
      return realFindMany(args);
    });
    try {
      const r = await drainOpenTicketsToLane();
      expect(mockStartCodingSession).not.toHaveBeenCalled();
      expect(r.batched).toBe(0);
      expect(kv.has('ticket-dispatch:failread0-0000-4000-8000-000000000001')).toBe(false);
      // PROOF the no-spawn came from the fail-closed path itself (not an
      // unrelated crash elsewhere in the drain): the drain logged its
      // fail-closed warn for this ticket and returned a normal result.
      const { default: logger } = await import('../../../utils/logger');
      const warns = (logger.warn as jest.Mock).mock.calls.map((c: any[]) => String(c[0])).filter((m: string) => m.includes('failread') && m.includes('fail-closed'));
      expect(warns.length).toBeGreaterThan(0);
      // No metric on the fail-closed path: only a POSITIVE closed-sighting records.
      expect(metricRows.find((m) => m.kind === 'ticket_dispatch_close_race')).toBeUndefined();
    } finally {
      mockPrisma.userFeatureRequest.findMany = realFindMany;
    }
  });

  it('a closed RIDING MEMBER blocks the whole family spawn (a family closes as ONE)', async () => {
    const lead = ticket('famlead00-0000-4000-8000-000000000001', {
      title: 'Recurring log signature 1a6afc6a', source: 'agent', priority: 2,
    });
    const member = ticket('fammemb00-0000-4000-8000-000000000002', {
      title: 'Recurring log signature 1a6afc6b', source: 'agent', priority: 2,
    });
    tickets = [lead, member];
    // The member closes at its claim (the scan saw it open; the lead's claim
    // set the family — the member's claim is the riding attach).
    flipOnClaim.set(DEDUPE_KEY_PREFIX + member.id, 'done');
    const r = await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(r.batched).toBe(0);
    expect(byId('famlead00-0000-4000-8000-000000000001').status).toBe('open');
    expect(byId('fammemb00-0000-4000-8000-000000000002').status).toBe('done');
    // BOTH claims released — a capped family must never wedge its members.
    expect(kv.has('ticket-dispatch:famlead00-0000-4000-8000-000000000001')).toBe(false);
    expect(kv.has('ticket-dispatch:fammemb00-0000-4000-8000-000000000002')).toBe(false);
  });

  it('a row ABSENT from the re-read (hard-deleted mid-drain) does NOT block the spawn', async () => {
    const row = ticket('harddelt0-0000-4000-8000-000000000001');
    tickets = [row];
    const realFindMany = mockPrisma.userFeatureRequest.findMany;
    // The re-read's query shape returns EMPTY for the row: simulate the row
    // being hard-deleted between the scan and the re-read (the map has no
    // entry → absent ≠ closed; the post-spawn stamp and the liveness
    // reclaim own the deleted-row case, not the race guard).
    mockPrisma.userFeatureRequest.findMany = jest.fn(async (args: any) => {
      const sel = args?.select as Record<string, unknown> | undefined;
      if (sel && Object.keys(sel).length === 2 && sel.id && sel.status && args.where?.id?.in) return [];
      return realFindMany(args);
    });
    try {
      const r = await drainOpenTicketsToLane();
      expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
      expect(r.batched).toBe(1);
      expect(metricRows.find((m) => m.kind === 'ticket_dispatch_close_race')).toBeUndefined();
    } finally {
      mockPrisma.userFeatureRequest.findMany = realFindMany;
    }
  });

  it('the kill switch restores the pre-fix claim→spawn byte-for-byte (the closed row gets its lane)', async () => {
    process.env.TICKET_DISPATCH_CLOSE_RACE_DISABLED = '1';
    expect(ticketDispatchCloseRaceDisabled()).toBe(true);
    tickets = [closesAtClaim('killswit0-0000-4000-8000-000000000001', 'done')];
    const r = await drainOpenTicketsToLane();
    // Pre-fix behavior: the lane spawns anyway.
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(r.batched).toBe(1);
    expect(metricRows.find((m) => m.kind === 'ticket_dispatch_close_race')).toBeUndefined();
  });
});

describe('1a6afc6a — the charter STAND DOWN ON CLOSED clause', () => {
  it('the solo charter tells a dispatched lane to stand down on a closed ticket', () => {
    const c = ticketLaneCharter('fa5f7ee3-1', { dispatchNo: 1, maxDispatches: 3 });
    expect(c).toContain('STAND DOWN ON CLOSED');
    expect(c).toContain('BEFORE your first mutating action');
    expect(c).toContain('STOP IMMEDIATELY');
    expect(c).toContain('do not re-apply any production change');
    expect(c).toContain('not yours to reopen');
  });

  it('the family charter scopes the stand-down per member', () => {
    const c = familyLaneCharter('famlead00-1', ['fammemb00-2'], 'recurring-log-signature', { dispatchNo: 1, maxDispatches: 3 });
    expect(c).toContain('STAND DOWN ON CLOSED');
    expect(c).toContain('STOP work on THAT member IMMEDIATELY');
    expect(c).toContain('keep working the other members');
  });
});
