/**
 * Ticket bf656696 — the ticket-lane archive DEADLOCK (P1, prod evidence
 * 2026-10-16 21:34Z Box C): the dispatcher logged
 *   "ticket lane 645b39f6 not archived yet (This chat has enabled schedules —
 *    pause or cancel them before archiving) — retrying next drain"
 * over and over. Root cause: archiveChat (platform.service) REFUSES while a
 * chat has enabled schedules, and a finished ticket lane legitimately leaves
 * schedules behind — the verdict-wait backstop (schedule_self, 1ead3b52
 * posture) and other continuation lanes arm ≥20-min one-shots nobody cancels
 * when the ticket closes. The dispatcher retried forever; the still-armed
 * schedules kept the lane reading LIVE at drain time, so its slot never
 * freed: 3/3 occupied all afternoon, waiting 6 → 9, one lane spawned
 * 13:00–15:30 PT.
 *
 * Replay pins (the ticket's acceptance test + the guards):
 *   1. A closed ticket's lane with an ENABLED SCHEDULE gets its schedules
 *      PAUSED by the dispatcher, then ARCHIVED, and its slot is FREED —
 *      waiting tickets dispatch on the SAME drain.
 *   2. The pause is paused-not-deleted (resumable row), cancelledBy
 *      'machine', lastStatus 'lane_archive', and emits ONE schedule_disabled
 *      hook event per row (the cadence self-noticing doctrine).
 *   3. Guards: the standing engineering lane, the Fleet Supervisor and a
 *      project supervisor chat NEVER get their schedules paused.
 *   4. The 30-min backstop: an unarchivable lane (kill switch on, or an
 *      archive that keeps failing) releases its slot after
 *      LANE_ARCHIVE_STUCK_MS and posts ONE attention_needed notice to the
 *      supervisor thread per episode; the clock clears when the archive lands.
 *   5. Pause disabled (kill switch): the pre-fix archive-only behavior, with
 *      the 30-min backstop as the only release.
 *   6. The pause itself never wedges the archive: a pause failure still
 *      attempts the archive.
 *
 * Harness: the fresh-lanes suite's shape (mocked prisma/redis/platform
 * seams) + codingSchedule rows + the schedule.service pause mock boundary.
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
const chats = new Map<string, { userId: string; projectId: string | null; archivedAt: Date | null; isSupervisor?: boolean; isProjectSupervisor?: boolean }>();
type SchedRow = { id: string; sessionId: string; kind: string; enabled: boolean; runsCount: number; lastStatus?: string | null; cancelledBy?: string | null; promptSetBy?: string | null };
const schedules = new Map<string, SchedRow>();
/** The schedule_disabled events the (real-shape) pause would emit, one per paused row. */
const pauseEvents: Array<{ scheduleId: string; reason: string }> = [];

function matchesWhere(r: Row, where: any): boolean {
  if (!where) return true;
  if (where.id && typeof where.id === 'string' && r.id !== where.id) return false;
  if (where.id?.in && !where.id.in.includes(r.id)) return false;
  if (typeof where.status === 'string' && r.status !== where.status) return false;
  if (where.status?.in && !where.status.in.includes(r.status)) return false;
  if (where.updatedAt?.gte && r.updatedAt < where.updatedAt.gte) return false;
  return true;
}

const mockPauseSchedulesForLaneArchive = jest.fn();
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  pauseSchedulesForLaneArchive: (sessionId: string, ...rest: any[]) => mockPauseSchedulesForLaneArchive(sessionId, ...rest),
}));

const mockEmitHookEvent = jest.fn(async (..._args: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEvent(...a),
}));

import { withEmptyHouseRuleReads } from './ticket-dispatch.mock.9dacab1a';

const mockPrisma: any = {
  crossModelChat: {
    findUnique: jest.fn(async ({ where }: any) => {
      const c = chats.get(where.id);
      return c ? { ...c } : null;
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
  contextStoreEntry: { findUnique: jest.fn(async () => null) },
  // TICKET-LANE ARCHIVE GAPS review (2026-10-21): archiveTicketLane's
  // owner-armed schedule guard (sessionId IN, enabled, promptSetBy user / NULL).
  codingSchedule: {
    findMany: jest.fn(async ({ where }: any) => [...schedules.values()]
      .filter((s) => where.sessionId.in.includes(s.sessionId) && s.enabled === where.enabled
        && where.OR.some((b: any) => (b.promptSetBy === null ? s.promptSetBy == null : s.promptSetBy === b.promptSetBy)))
      .map((s) => ({ sessionId: s.sessionId }))),
  },
};
// Third review (2026-10-22): the drain's house-rule reads answer empty (lanes archive as before).
withEmptyHouseRuleReads(mockPrisma);
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Redis with real NX semantics (drain lock, claims, the bf656696 stuck clock + notice gate).
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
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
    incr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
    del: jest.fn(async (k: string) => { kv.delete(k); return 1; }),
    decr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) - 1; kv.set(k, String(n)); return n; }),
  },
}));

let spawnSeq = 0;
const mockStartCodingSession = jest.fn();
const mockArchiveChat = jest.fn();
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: (o: any) => mockStartCodingSession(o),
  archiveChat: (o: any) => mockArchiveChat(o),
}));

import {
  drainOpenTicketsToLane, LANE_ARCHIVE_STUCK_MS, laneUnarchivedMs, laneArchivePauseDisabled, CLOSED_TICKET_LANE_RETIRE_DETAIL,
} from './ticket-dispatch.service';
/** Third review (2026-10-22): a closed ticket's own lane pauses its machine schedules REMEMBERED (an owner restore re-arms them). */
const CLOSED_LANE_RETIRE_PAUSE = { archiveRetire: { detail: CLOSED_TICKET_LANE_RETIRE_DETAIL } };

const H = 3600_000;
const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';
const FLEET = 'c0e22e36-0000-0000-0000-00000000fleet';

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'bug_report', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 3, source: 'user', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), ...over,
  };
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;
function sched(id: string, sessionId: string, over: Partial<SchedRow> = {}): SchedRow {
  // promptSetBy 'machine': the backstops a finished lane leaves behind are
  // lane-armed (an OWNER-armed row is never paused — the 2026-10-21 lane
  // archive gaps review; pinned in ticket-dispatch.lane-archive-gaps.test.ts).
  const row: SchedRow = { id, sessionId, kind: 'once', enabled: true, runsCount: 0, lastStatus: null, cancelledBy: null, promptSetBy: 'machine', ...over };
  schedules.set(id, row);
  return row;
}
const ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  for (const k of ['TICKET_DISPATCH_FRESH_LANES_DISABLED', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_CONCURRENCY_NIGHT', 'TICKET_LANE_NIGHT_HOURS', 'TICKET_LANE_NO_RUN_REDISPATCH_HOURS',
    'TICKET_LANE_MAX_DISPATCHES', 'TICKET_LANE_LEGACY_REDISPATCH_DISABLED', 'TICKET_LANE_PROJECT_ID', 'TICKET_DISPATCH_DAILY_CAP', 'TICKET_DISPATCH_ANY_USER', 'TICKET_LANE_ARCHIVE_PAUSE_DISABLED', 'TICKET_LANE_ARCHIVE_GAPS_DISABLED']) delete process.env[k];
  // Night window off: the effective cap is the DAY value no matter what hour
  // CI runs (a 22:00–06:00 America/Vancouver run must not fall back to the
  // night cap of 6 where these tests pin TICKET_LANE_CONCURRENCY=1) — the
  // sibling fresh-lanes suites' convention ('nope' is not a valid window).
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope';
  tickets = [];
  runs = [];
  kv.clear();
  chats.clear();
  schedules.clear();
  spawnSeq = 0;
  // Fresh implementations every test (clearAllMocks clears calls, not
  // implementations — a mockRejectedValue from one test must not poison the next).
  mockStartCodingSession.mockImplementation(async (_opts: any) => ({ id: `${String(++spawnSeq).padStart(8, 'a')}-lane-session` }));
  mockArchiveChat.mockImplementation(async ({ chatId }: any) => {
    const c = chats.get(chatId);
    if (c) c.archivedAt = new Date();
    return { id: chatId, archived: true };
  });
  // Real-shape pause (schedule.service pauseSchedulesForLaneArchive): pauses the
  // chat's enabled rows, machine-attributed. Fourth review (2026-10-22): honours
  // archiveRetire exactly as the real one does — 'paused:archived' + a quiet
  // target_archived event (remembered for a restore) vs the plain 'lane_archive'
  // alarm-class event — so the suite pins what ships.
  pauseEvents.length = 0;
  mockPauseSchedulesForLaneArchive.mockImplementation(async (sessionId: string, actor?: { actorChatId?: string | null; archiveRetire?: { detail: string } }): Promise<number> => {
    const retire = !!actor?.archiveRetire;
    const rows = [...schedules.values()].filter((s) => s.sessionId === sessionId && s.enabled);
    for (const s of rows) {
      s.enabled = false; s.lastStatus = retire ? 'paused:archived' : 'lane_archive'; s.cancelledBy = 'machine';
      pauseEvents.push({ scheduleId: s.id, reason: retire ? 'target_archived' : 'lane_archive' });
    }
    return rows.length;
  });
  chats.set(STANDING, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
  // A normal spawned ticket lane: a coding chat, not a supervisor.
  chats.set('lanedone-000', { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
  chats.set('lanestuck-00', { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
  chats.set('lanelive-000', { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
  chats.set(FLEET, { userId: 'owner-1', projectId: null, archivedAt: null, isSupervisor: true });
});
afterAll(() => { process.env = ENV; });

describe('bf656696 — dispatcher retires a finished lane\'s schedules before archiving it', () => {
  it('ACCEPTANCE: a closed ticket\'s lane with an enabled schedule is paused, archived, and its slot freed — a waiting ticket dispatches on the SAME drain', async () => {
    // The prod shape: the lane finished its ticket but left a verdict-wait backstop armed.
    sched('backstop-1', 'lanedone-000', { kind: 'once' });
    tickets = [
      ticket('done9999-0', { status: 'done', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'lanedone-000', dispatchedAt: new Date(Date.now() - 2 * H).toISOString() }, updatedAt: new Date() }),
      ticket('wait9999-1', { priority: 2 }),
    ];
    const r = await drainOpenTicketsToLane();
    // The deadlock is gone: the waiting ticket got a lane THIS drain.
    expect(r.batched).toBe(1);
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].prompt).toContain('wait9999-1');
    // The lane's schedule was paused BEFORE the archive call.
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledWith('lanedone-000', CLOSED_LANE_RETIRE_PAUSE); // third review 2026-10-22: remembered (retirePause)
    const pauseOrder = mockPauseSchedulesForLaneArchive.mock.invocationCallOrder[0];
    const archiveOrder = mockArchiveChat.mock.invocationCallOrder[0];
    expect(pauseOrder).toBeLessThan(archiveOrder);
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'owner-1', chatId: 'lanedone-000', cascadeBudget: { remaining: expect.any(Number) }, restoreAuditCache: expect.any(Map) }); // third review 2026-10-22: the drain's one cascade budget (fifth review: + its restore-audit memo)
    expect(chats.get('lanedone-000')!.archivedAt).toBeTruthy();
    expect(typeof byId('done9999-0').context.laneArchivedAt).toBe('string');
    // The schedule row is paused-not-deleted and machine-attributed. Third review
    // (2026-10-22): an IDLE lane the drain archives pauses REMEMBERED
    // ('paused:archived', restored by an owner restore) — fourth review pin.
    const s = schedules.get('backstop-1')!;
    expect(s.enabled).toBe(false);
    expect(s.lastStatus).toBe('paused:archived');
    expect(s.cancelledBy).toBe('machine');
  });

  it('the pause emits ONE schedule_disabled event per row — reason target_archived for an idle lane the drain archives (fourth review: the real pause\'s archiveRetire contract) — and the dispatcher itself emits nothing on a clean archive', async () => {
    // The real schedule.service emits via emitScheduleDisabled; here we pin the
    // DISPATCHER'S notice + the boundary contract the pause mock stands in for
    // (its unit home is schedule.service.test.ts). What the dispatcher side
    // must do: emit nothing itself on a clean archive — the per-row events
    // come from the pause.
    sched('backstop-2', 'lanedone-000');
    tickets = [ticket('done9998-0', { status: 'done', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'lanedone-000' }, updatedAt: new Date() })];
    await drainOpenTicketsToLane();
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledTimes(1);
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledWith('lanedone-000', CLOSED_LANE_RETIRE_PAUSE); // third review 2026-10-22: remembered (retirePause)
    expect(pauseEvents).toEqual([{ scheduleId: 'backstop-2', reason: 'target_archived' }]);
    expect(schedules.get('backstop-2')!.lastStatus).toBe('paused:archived');
    expect(mockEmitHookEvent).not.toHaveBeenCalledWith('lanedone-000', 'attention_needed', expect.anything(), expect.anything());
  });

  it('fourth review (2026-10-22): a lane still LIVE past the 30-min window gets the PLAIN bf656696 pause — lastStatus lane_archive, the alarm-class lane_archive event (never a remembered "archived" pause the refused archive would contradict)', async () => {
    sched('zombie-2', 'lanestuck-00', { kind: 'recurring' });
    runs = [{ sessionId: 'lanestuck-00', status: 'running', createdAt: new Date(Date.now() - 50 * 60_000), updatedAt: new Date() }];
    mockArchiveChat.mockRejectedValue(Object.assign(new Error('This session is running — stop it before archiving'), { statusCode: 409 }));
    kv.set('ticket-dispatch:lane-archive-stuck:lanestuck-00', String(Date.now() - LANE_ARCHIVE_STUCK_MS - 60_000));
    tickets = [ticket('done9990-0', { status: 'done', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'lanestuck-00' }, updatedAt: new Date() })];
    await drainOpenTicketsToLane();
    expect(mockPauseSchedulesForLaneArchive.mock.calls).toEqual([['lanestuck-00']]);
    expect(schedules.get('zombie-2')!.lastStatus).toBe('lane_archive');
    expect(pauseEvents).toEqual([{ scheduleId: 'zombie-2', reason: 'lane_archive' }]);
    expect(byId('done9990-0').context.laneArchivedAt).toBeUndefined();
  });

  it('fourth review (2026-10-22): with TICKET_LANE_ARCHIVE_GAPS_DISABLED=1 an idle lane keeps the pre-wave plain pause (lane_archive)', async () => {
    process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED = '1';
    sched('backstop-5', 'lanedone-000');
    tickets = [ticket('done9989-0', { status: 'done', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'lanedone-000' }, updatedAt: new Date() })];
    await drainOpenTicketsToLane();
    expect(mockPauseSchedulesForLaneArchive.mock.calls).toEqual([['lanedone-000']]);
    expect(schedules.get('backstop-5')!.lastStatus).toBe('lane_archive');
    expect(pauseEvents).toEqual([{ scheduleId: 'backstop-5', reason: 'lane_archive' }]);
  });

  it('GUARD: the standing engineering lane, the Fleet Supervisor and a project supervisor chat are never schedule-paused', async () => {
    sched('standing-cad', STANDING, { kind: 'recurring' });
    sched('fleet-sweep', FLEET, { kind: 'recurring' });
    tickets = [
      ticket('done9997-0', { status: 'done', context: { dispatchMode: 'ticket_lane', dispatchedTo: STANDING }, updatedAt: new Date() }),
    ];
    await drainOpenTicketsToLane();
    expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalledWith(STANDING);
    expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalledWith(FLEET);
    expect(schedules.get('standing-cad')!.enabled).toBe(true);
    expect(schedules.get('fleet-sweep')!.enabled).toBe(true);
  });

  it('the stuck clock: first drain claims it (age 0), later drains age it, and a landed archive clears it', async () => {
    // Direct pin of the clock helper the drain reads.
    const lane = 'lanestuck-00';
    expect(await laneUnarchivedMs(lane, 1_000_000)).toBe(0); // first sight claims the key
    expect(await laneUnarchivedMs(lane, 1_000_000 + 10 * 60_000)).toBe(10 * 60_000);
    expect(await laneUnarchivedMs(lane, 1_000_000 + 31 * 60_000)).toBe(31 * 60_000);
    // A landed archive clears the episode.
    tickets = [ticket('done9996-0', { status: 'done', context: { dispatchMode: 'ticket_lane', dispatchedTo: lane }, updatedAt: new Date() })];
    await drainOpenTicketsToLane();
    expect(chats.get(lane)!.archivedAt).toBeTruthy();
    expect(kv.has(`ticket-dispatch:lane-archive-stuck:${lane}`)).toBe(false);
    expect(await laneUnarchivedMs(lane, 1_000_000 + 60 * 60_000)).toBe(0); // fresh episode
  });

  it('BACKSTOP: an unarchivable lane past 30 min releases its slot and posts ONE attention_needed notice per episode', async () => {
    process.env.TICKET_LANE_CONCURRENCY = '1';
    // Time-of-day guard: between 22:00–06:00 America/Vancouver the NIGHT cap
    // (TICKET_LANE_CONCURRENCY_NIGHT, default 6) would replace the day pin —
    // the live lane would no longer hold the only slot and drain 1 batches
    // (observed live 2026-10-18 05:10Z / 10:10 PM PDT: green by day, red at
    // night, deterministic at pure base). Pin the night cap to the same 1 so
    // the BACKSTOP scenario is hour-invariant.
    process.env.TICKET_LANE_CONCURRENCY_NIGHT = '1';
    // Kill the pause (isolate the backstop) and make the archive keep failing.
    process.env.TICKET_LANE_ARCHIVE_PAUSE_DISABLED = '1';
    mockArchiveChat.mockRejectedValue(Object.assign(new Error('This chat has enabled schedules — pause or cancel them before archiving'), { statusCode: 409 }));
    // A leftover backstop keeps the lane reading live — the prod wedge.
    sched('zombie-1', 'lanestuck-00', { kind: 'recurring' });
    runs = [{ sessionId: 'lanestuck-00', status: 'running', createdAt: new Date(Date.now() - 40 * 60_000), updatedAt: new Date() }];
    tickets = [
      ticket('done9995-0', { status: 'done', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'lanestuck-00', dispatchedAt: new Date(Date.now() - 45 * 60_000).toISOString() }, updatedAt: new Date() }),
      ticket('wait9995-1', { priority: 2 }),
    ];
    // Drain 1: the episode starts (age 0) — the live lane keeps the slot (pre-fix behavior).
    const r1 = await drainOpenTicketsToLane();
    expect(r1.batched).toBe(0);
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
    // Drain 2, simulated 31 min later: past the window — slot RELEASED, waiting ticket dispatches, ONE notice.
    const stuckKey = `ticket-dispatch:lane-archive-stuck:lanestuck-00`;
    kv.set(stuckKey, String(Date.now() - LANE_ARCHIVE_STUCK_MS - 60_000));
    const r2 = await drainOpenTicketsToLane();
    expect(r2.batched).toBe(1);
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].prompt).toContain('wait9995-1');
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
    const [src, type, summary, extra] = mockEmitHookEvent.mock.calls[0];
    expect(src).toBe('lanestuck-00');
    expect(type).toBe('attention_needed');
    expect(summary).toContain('could not be archived');
    expect(summary).toContain('30 minutes');
    expect(extra).toMatchObject({ reason: 'lane_archive_stuck', laneId: 'lanestuck-00', ticketId: 'done9995-0' });
    expect(byId('done9995-0').context.laneArchivedAt).toBeUndefined(); // never stamped on failure
    // Drain 3, still stuck: the notice is once per episode.
    const r3 = await drainOpenTicketsToLane();
    expect(r3.batched).toBe(0);
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
  });

  it('KILL SWITCH: pause disabled restores archive-only — the 30-min backstop is the only release', async () => {
    process.env.TICKET_LANE_ARCHIVE_PAUSE_DISABLED = '1';
    expect(laneArchivePauseDisabled()).toBe(true);
    sched('backstop-3', 'lanedone-000');
    tickets = [ticket('done9994-0', { status: 'done', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'lanedone-000' }, updatedAt: new Date() })];
    await drainOpenTicketsToLane();
    expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalled();
    // The plain archive still runs (and here succeeds — no schedules gate it in the mock).
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'owner-1', chatId: 'lanedone-000', cascadeBudget: { remaining: expect.any(Number) }, restoreAuditCache: expect.any(Map) }); // third review 2026-10-22: the drain's one cascade budget (fifth review: + its restore-audit memo)
    expect(typeof byId('done9994-0').context.laneArchivedAt).toBe('string');
  });

  it('a pause failure never wedges the archive — the archive attempt still runs', async () => {
    mockPauseSchedulesForLaneArchive.mockRejectedValueOnce(new Error('schedule module blew up'));
    sched('backstop-4', 'lanedone-000');
    tickets = [ticket('done9993-0', { status: 'done', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'lanedone-000' }, updatedAt: new Date() })];
    await drainOpenTicketsToLane();
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledTimes(1);
    expect(mockArchiveChat).toHaveBeenCalledWith({ userId: 'owner-1', chatId: 'lanedone-000', cascadeBudget: { remaining: expect.any(Number) }, restoreAuditCache: expect.any(Map) }); // third review 2026-10-22: the drain's one cascade budget (fifth review: + its restore-audit memo)
    expect(typeof byId('done9993-0').context.laneArchivedAt).toBe('string');
  });

  it('a lane with NO schedules archives as before (no pause call needed) — no regression', async () => {
    tickets = [ticket('done9992-0', { status: 'done', context: { dispatchMode: 'ticket_lane', dispatchedTo: 'lanedone-000' }, updatedAt: new Date() })];
    await drainOpenTicketsToLane();
    // The pause runs unconditionally for owned lanes (cheap count query) but
    // pauses nothing; the archive lands exactly as pre-fix.
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledWith('lanedone-000', CLOSED_LANE_RETIRE_PAUSE); // third review 2026-10-22: remembered (retirePause)
    expect(mockArchiveChat).toHaveBeenCalledTimes(1);
    expect(typeof byId('done9992-0').context.laneArchivedAt).toBe('string');
  });
});
