/**
 * Lane-chat existence probe (ticket 2dc0988c — "reclaim misses lane teardown").
 *
 * Prod shape this replays: a ticket lane whose CHAT is hard-deleted (owner
 * delete, or a reaper that drops the chat row) cascades its coding state and
 * agent_runs away with it. From the drain's point of view the lane then has
 * NO runs — indistinguishable from "spawned, provisioning, first prompt on
 * its way" — so it rode the 30-min FIRST_RUN_GRACE as a phantom slot and its
 * ticket parked in_progress until the 6 h no-run / 8 h idle windows opened.
 * With N lanes deleted, N slots leaked for the grace + the ticket waited
 * hours behind a chat that could never run anything again.
 *
 * Pins: a CONFIRMED-gone chat (no crossmodel_chats row) holds NO slot — no
 * grace — and its ticket re-queues on the SAME drain (dispatch budget still
 * applies, previousLanes records the dead lane, a waiting ticket gets the
 * freed slot). An EXISTING run-less lane keeps its grace exactly as before,
 * an ARCHIVED lane still counts as existing (archive is not deletion), and
 * the probe FAILS OPEN (lookup error ⇒ every lane exists ⇒ pre-fix behavior).
 *
 * Incident note (2026-10-17, for the record): the 16:05–17:55Z stall this
 * ticket was filed on was NOT this class — all three occupying lanes existed
 * with live heartbeating runs (eebace78 13:09Z→, fbdc568d 15:12–17:50Z,
 * b4475a28 14:35Z→); the queue was saturated with real work and the
 * reporter's get_chat_status "Chat not found" was a cross-account visibility
 * artifact. The fix hardens the class the ticket names so a REAL deletion
 * cannot reproduce the stall.
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
/** chat rows by id — a lane ABSENT from this map is "deleted" (no row). */
const chats = new Map<string, { userId: string; projectId: string | null; archivedAt: Date | null }>();
/** When set, crossModelChat.findMany throws — the FAIL-OPEN leg. */
let probeThrows = false;

function matchesWhere(r: Row, where: any): boolean {
  if (!where) return true;
  if (where.id && typeof where.id === 'string' && r.id !== where.id) return false;
  if (where.id?.in && !where.id.in.includes(r.id)) return false;
  if (typeof where.status === 'string' && r.status !== where.status) return false;
  if (where.status?.in && !where.status.in.includes(r.status)) return false;
  if (where.updatedAt?.gte && r.updatedAt < where.updatedAt.gte) return false;
  return true;
}

const mockPrisma: any = {
  crossModelChat: {
    findUnique: jest.fn(async ({ where }: any) => {
      const c = chats.get(where.id);
      return c ? { ...c } : null;
    }),
    // The 2dc0988c existence probe (readLaneStates): id-only findMany.
    findMany: jest.fn(async ({ where }: any) => {
      if (probeThrows) throw new Error('probe db down (test)');
      return where.id.in
        .filter((id: string) => chats.has(id))
        .map((id: string) => ({ id }));
    }),
  },
  crossModelProject: {
    findUnique: jest.fn(async ({ where }: any) => (where.id === 'proj-override' ? { id: 'proj-override', userId: 'owner-2' } : null)),
  },
  userFeatureRequest: {
    findMany: jest.fn(async ({ where }: any) => tickets
      .filter((r) => matchesWhere(r, where))
      .sort((a, b) => b.priority - a.priority || +a.createdAt - +b.createdAt)
      .map((r) => ({ ...r, context: r.context ? JSON.parse(JSON.stringify(r.context)) : r.context }))),
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
      && (!where.status?.in || where.status.in.includes(r.status))
      && (!where.updatedAt?.gte || r.updatedAt >= where.updatedAt.gte)).length),
  },
  chatCodingState: { findMany: jest.fn(async () => []) },
  // TICKET-LANE ARCHIVE GAPS review (2026-10-21): archiveTicketLane's owner-armed
  // schedule guard reads this (fail-closed without it) — no owner rows here.
  chatSchedule: { findMany: jest.fn(async () => []) },
  contextStoreEntry: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Redis with real NX semantics (the drain lock + per-ticket claims).
const kv = new Map<string, string>();
const mockRedisSet = jest.fn(async (key: string, value: string, opts?: any) => {
  if (opts?.NX && kv.has(key)) return null;
  kv.set(key, value);
  return 'OK';
});
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

import { drainOpenTicketsToLane } from './ticket-dispatch.service';

const H = 3600_000;
const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'bug_report', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 3, source: 'user', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), ...over,
  };
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;
const ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  for (const k of ['TICKET_DISPATCH_FRESH_LANES_DISABLED', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_CONCURRENCY_NIGHT', 'TICKET_LANE_NIGHT_HOURS', 'TICKET_LANE_NO_RUN_REDISPATCH_HOURS',
    'TICKET_LANE_MAX_DISPATCHES', 'TICKET_LANE_LEGACY_REDISPATCH_DISABLED', 'TICKET_LANE_PROJECT_ID', 'TICKET_DISPATCH_DAILY_CAP', 'TICKET_DISPATCH_ANY_USER']) delete process.env[k];
  // A malformed window forces the day cap no matter what hour CI runs.
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope';
  tickets = [];
  runs = [];
  kv.clear();
  chats.clear();
  probeThrows = false;
  spawnSeq = 0;
  chats.set(STANDING, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
});
afterAll(() => { process.env = ENV; });

describe('lane-chat existence probe — a deleted lane frees its slot within ONE drain (2dc0988c)', () => {
  it('a lane DELETED mid-run (chat gone, runs cascade-deleted) inside the 30-min grace ⇒ no phantom slot, ticket re-queued on the same drain', async () => {
    const at = new Date(Date.now() - 10 * 60_000); // 10 min ago — INSIDE the 30-min grace
    // The lane chat was hard-deleted 5 min into its run: no chat row, no runs.
    tickets = [ticket('gone1111-0', { status: 'in_progress', adminNote: 'Queued — ticket lane gonelane starts it (…).', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'gonelane-000', dispatchedAt: at.toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 } })];
    kv.set('ticket-dispatch:gone1111-0', '1'); // the first dispatch's 30d claim
    await drainOpenTicketsToLane();
    // The slot was NOT held by the deleted lane: a fresh lane spawns NOW.
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    const brief = mockStartCodingSession.mock.calls[0][0].prompt;
    expect(brief).toContain('gone1111-0');
    expect(brief).toContain('dispatch 2 of 3');
    expect(brief).toContain('Earlier lanes on this ticket: gonelane');
    const t = byId('gone1111-0');
    expect(t.context).toMatchObject({ dispatchedTo: 'aaaaaaa1-lane-session', laneDispatches: 2, previousLanes: ['gonelane-000'] });
  });

  it('a lane deleted AFTER it ran ⇒ re-queued immediately, not after the 8 h idle window', async () => {
    const at = new Date(Date.now() - 2 * H); // ran, then the owner deleted the chat 1 h ago
    tickets = [ticket('ran1111-0', { status: 'in_progress', adminNote: 'Ticket lane ranlane working since x (dispatch 1 of 3).', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'ranlane-0000', dispatchedAt: at.toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 } })];
    // runs cascade-deleted with the chat — the drain sees an EMPTY run set.
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(byId('ran1111-0').context.laneDispatches).toBe(2);
  });

  it('the freed slot goes to a WAITING ticket in the same drain (spawned > 0)', async () => {
    const at = new Date(Date.now() - 10 * 60_000);
    tickets = [
      ticket('orphan111-0', { priority: 5, status: 'in_progress', adminNote: 'Queued — ticket lane orphanlan starts it (…).', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'orphanlane-0', dispatchedAt: at.toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 } }),
      ticket('wait1111-1', { priority: 4 }),
    ];
    await drainOpenTicketsToLane();
    // BOTH the orphaned ticket (re-queued onto a fresh lane) and the waiting
    // ticket spawn: the deleted lane held no slot, so 2 were free.
    expect(mockStartCodingSession).toHaveBeenCalledTimes(2);
    const prompts = mockStartCodingSession.mock.calls.map((c: any[]) => c[0].prompt);
    expect(prompts.some((p: string) => p.includes('orphan111-0'))).toBe(true);
    expect(prompts.some((p: string) => p.includes('wait1111-1'))).toBe(true);
  });

  it('surviving run rows under a deleted chat still free the slot — the existence check dominates liveness', async () => {
    // Defensive ordering: FK cascade makes this impossible in prod, but the
    // probe must dominate — a run row under a GONE chat can never progress.
    const at = new Date(Date.now() - 5 * 60_000);
    tickets = [ticket('zomb1111-0', { status: 'in_progress', adminNote: 'Queued — ticket lane zombielan starts it (…).', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'zorbielane-0', dispatchedAt: at.toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 } })];
    runs = [{ sessionId: 'zorbielane-0', status: 'running', createdAt: at, updatedAt: new Date() }];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(byId('zomb1111-0').context.laneDispatches).toBe(2);
  });
});

describe('lane-chat existence probe — boundaries (what must NOT be reclaimed)', () => {
  it('an EXISTING run-less lane inside the 30-min grace keeps its slot exactly as before', async () => {
    const at = new Date(Date.now() - 10 * 60_000); // inside the grace
    chats.set('younglane-00', { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
    tickets = [
      ticket('young111-0', { priority: 5, status: 'in_progress', adminNote: 'Queued — ticket lane younglan starts it (…).', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'younglane-00', dispatchedAt: at.toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 } }),
      ticket('open1111-1', { priority: 1 }),
    ];
    await drainOpenTicketsToLane();
    // The real lane holds its grace slot; only the free slots serve the rest.
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].prompt).toContain('open1111-1');
    expect(byId('young111-0').context.dispatchedTo).toBe('younglane-00');
  });

  it('an EXISTING run-less lane inside the 6 h no-run window is left alone (only the slot frees after the grace)', async () => {
    const at = new Date(Date.now() - 2 * H);
    chats.set('slowlane-000', { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
    tickets = [ticket('slow1111-0', { status: 'in_progress', adminNote: 'Queued — ticket lane slowlane starts it (…).', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'slowlane-000', dispatchedAt: at.toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 } })];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(byId('slow1111-0').status).toBe('in_progress');
  });

  it('an ARCHIVED lane chat still counts as existing (archive is not deletion — a live run keeps its slot)', async () => {
    const at = new Date(Date.now() - 2 * H);
    chats.set('archivelane', { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: new Date(Date.now() - H) });
    tickets = [ticket('arch1111-0', { priority: 5, status: 'in_progress', adminNote: 'Queued — ticket lane archivela starts it (…).', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'archivelane', dispatchedAt: at.toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 } })];
    runs = [{ sessionId: 'archivelane', status: 'running', createdAt: at, updatedAt: new Date() }];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled(); // its live run keeps the slot
  });

  it('FAILS OPEN: a probe lookup error keeps the pre-fix behavior (grace retained, no re-queue)', async () => {
    const at = new Date(Date.now() - 10 * 60_000); // inside the grace
    probeThrows = true;
    tickets = [ticket('prob1111-0', { status: 'in_progress', adminNote: 'Queued — ticket lane problelan starts it (…).', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'problelane-0', dispatchedAt: at.toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 } })];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(byId('prob1111-0').context.dispatchedTo).toBe('problelane-0');
  });

  it('the dispatch budget still stops re-queue on a deleted lane (a dead lane does not mint dispatches)', async () => {
    const at = new Date(Date.now() - 10 * 60_000);
    tickets = [ticket('spent111-0', { status: 'in_progress', adminNote: 'Queued — ticket lane spentlan starts it (…).', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'spentlane-00', dispatchedAt: at.toISOString(), laneDispatches: 3, laneDispatchEpoch: 0 } })];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    const t = byId('spent111-0');
    expect(t.status).toBe('open');
    expect(t.adminNote).toBe('Auto re-dispatch stopped — 3 ticket lanes ran without closing it; it needs a human look.');
  });

  it('an OPEN-status row whose lane was deleted re-dispatches (no double-up skip on a phantom lane)', async () => {
    // F5: a lane that re-opened its own ticket mid-run, then the chat was
    // deleted — the open+holdsSlot skip must NOT hold for a gone chat.
    const at = new Date(Date.now() - 10 * 60_000);
    tickets = [ticket('reopen111-0', { status: 'open', adminNote: 'Reopened automatically at 2026-10-06T00:00:00Z: the defect recurred after closure (sighting 4).', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'reopenlane-0', dispatchedAt: at.toISOString(), laneDispatches: 1, laneDispatchEpoch: 1, reopenCount: 1 } })];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(byId('reopen111-0').context).toMatchObject({ laneDispatches: 2, laneDispatchEpoch: 1 });
    expect(byId('reopen111-0').context.previousLanes).toContain('reopenlane-0');
  });

  it('a CLOSED ticket whose lane chat is GONE with surviving run rows frees the slot immediately (archive loop, review F1)', async () => {
    // F5/F1: the closedLanes occupancy check reads liveness only in the
    // pre-fix code — a gone chat with orphaned run rows could hold a phantom
    // slot for the full 30-min stuck window. Existence must gate it.
    const closedAt = new Date(Date.now() - 10 * 60_000);
    tickets = [
      { ...ticket('closed111-0', { status: 'done', adminNote: 'FIXED, MERGED.', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'closedlane-0', dispatchedAt: closedAt.toISOString(), laneDispatches: 1 } }), updatedAt: closedAt },
      ticket('next1111-1', { priority: 4 }),
    ];
    // Orphaned run rows: status running under a chat that no longer exists.
    runs = [{ sessionId: 'closedlane-0', status: 'running', createdAt: closedAt, updatedAt: new Date() }];
    await drainOpenTicketsToLane();
    // The gone lane holds NO slot despite its orphaned "running" row: the
    // waiting ticket spawns in the SAME drain.
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].prompt).toContain('next1111-1');
    // archiveTicketLane on a gone chat reports true (nothing to archive) and
    // the row is stamped laneArchivedAt so it never re-enters the loop.
    expect(byId('closed111-0').context.laneArchivedAt).toBeTruthy();
  });
});
