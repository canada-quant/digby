/**
 * Drain-time reprioritization (ticket 9dacab1a) — the DISPATCH integration
 * of the ticket-priority leaf, replayed on the fresh-lanes drain harness.
 *
 * Round-1 review rebuild: the prisma mock is now SELECT-FAITHFUL and
 * WHERE-FAITHFUL (ticket-dispatch.mock.9dacab1a.ts — the old mock ignored
 * `select` and `where.id.startsWith`, the root cause of the vacuity
 * findings). Every pinned test asserts its fetch shape returned rows
 * (non-vacuity), and the old pins were mutation-tested against the F1 fix
 * per the 7b2990fa learning.
 *
 * Pins:
 *  - SCORING changes WHO spawns first when slots are scarce (a reopened,
 *    multi-unblocking P0 overtakes a plain P0; an old starved row overtakes
 *    fresh rows);
 *  - the AGE STRATUM fetch on the REAL starvation shape: 60 fresh
 *    HIGHER-priority noise rows + 1 ancient low-priority row — the static
 *    top-60 fetch never reaches the ancient row, only the stratum does
 *    (AGE_STRATUM_ROWS=0 makes this test FAIL — mutation-proven);
 *  - DEPENDENCY GATING through the DEDICATED blocker index (F1): a ticket
 *    with an open blocker never spawns (no slot, no claim) and carries the
 *    wait note; the blocker closing auto-unblocks on the next drain. A
 *    queued / awaiting_verification / outside-the-7d-lookback blocker GATES
 *    (invisible to the old open-scan+closed-fetch index); a closed blocker
 *    does not; an unknown blocker id reads UNBLOCKED;
 *  - a dispatch-stamped row with deps is NOT gated (defense in depth: the
 *    reclaim paths own dispatched rows);
 *  - the BATCH drain (fresh-lanes kill switch ON) gates + wait-notes an
 *    undispatched gated row and it never enters the batch (F6), and the
 *    auto-unblock clears the wait note when the blocker closes;
 *  - the kill switch reverts ordering to the static queue byte-for-byte.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { makeFaithfulFindMany, mockMatchesWhere, mockApplySelect, type MockRow } from './ticket-dispatch.mock.9dacab1a';

type Row = MockRow & {
  id: string; type: string; title: string; description: string; priority: number; source: string;
  status: string; adminNote: string | null; context: any; createdAt: Date; updatedAt: Date; userId?: string | null;
  user?: { role?: string | null } | null;
};
let tickets: Row[] = [];
let runs: Array<{ sessionId: string; status: string; createdAt: Date; updatedAt: Date }> = [];
const chats = new Map<string, { userId: string; projectId: string | null; archivedAt: Date | null }>();

/** The SELECT-FAITHFUL, WHERE-FAITHFUL findMany (round-1 review fix). */
const faithfulFindMany = makeFaithfulFindMany(() => tickets);

const mockPrisma: any = {
  crossModelChat: {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const c = chats.get(where.id);
      if (!c) return null;
      return mockApplySelect({ ...c }, select);
    }),
    findMany: jest.fn(async ({ where, take }: any) => {
      const ids: string[] = Array.isArray(where?.id?.in) ? where.id.in : [];
      return [...chats.entries()].filter(([id]) => ids.includes(id)).slice(0, take ?? Infinity).map(([id, c]) => ({ id, ...c }));
    }),
  },
  crossModelProject: {
    findUnique: jest.fn(async () => null),
  },
  userFeatureRequest: {
    findMany: jest.fn((args: any) => faithfulFindMany(args)),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of tickets) {
        if (!mockMatchesWhere(r as Record<string, any>, where)) continue;
        Object.assign(r, data, { updatedAt: new Date() });
        count++;
      }
      return { count };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = tickets.find((t) => t.id === where.id);
      if (r) Object.assign(r, data, { updatedAt: new Date() });
      return r ?? {};
    }),
    findUnique: jest.fn(async ({ where, select }: any) => {
      const r = tickets.find((t) => t.id === where.id);
      return r ? mockApplySelect({ ...r }, select) : null;
    }),
  },
  agentRun: {
    findMany: jest.fn(async ({ where }: any) => runs.filter((r) => where.sessionId.in.includes(r.sessionId))),
    count: jest.fn(async ({ where }: any) => runs.filter((r) => r.sessionId === where.sessionId
      && (!where.status?.in || where.status.in.includes(r.status))).length),
  },
  chatCodingState: { findMany: jest.fn(async () => []) },
  // TICKET-LANE ARCHIVE GAPS review (2026-10-21): archiveTicketLane's owner-armed
  // schedule guard reads this (fail-closed without it) — no owner rows here.
  chatSchedule: { findMany: jest.fn(async () => []) },
  contextStoreEntry: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

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
const mockSendChatMessage = jest.fn(async (_msg: any) => ({ queued: true }));
const mockArchiveChat = jest.fn(async ({ chatId }: any) => {
  const c = chats.get(chatId);
  if (c) c.archivedAt = new Date();
  return { id: chatId, archived: true };
});
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: (o: any) => mockStartCodingSession(o),
  sendChatMessage: (...a: any[]) => mockSendChatMessage(a[0]),
  archiveChat: (o: any) => mockArchiveChat(o),
}));

import { drainOpenTicketsToLane } from './ticket-dispatch.service';

/** AGE_STRATUM_ROWS (ticket-dispatch.service.ts) — the stratum fetch's take. */
const AGE_STRATUM_ROWS = 15;

const H = 3600_000;
const DAY = 24 * H;
const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'bug_report', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 0, source: 'user', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), ...over,
  };
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;
const ENV = { ...process.env };

/** The findMany calls whose `where` mentions a given key (test-local probe). */
const findManyCalls = () => mockPrisma.userFeatureRequest.findMany.mock.calls as Array<[any]>;
/** Calls whose where shape names `status: { in: [...] }` (the open scan / closed fetch). */
const statusInCalls = (statuses: string[]) => findManyCalls().filter((c) => JSON.stringify(c[0]?.where?.status?.in) === JSON.stringify(statuses));
/** The blocker-index id-IN fetches (dedicated index, F1). */
const blockerIndexCalls = () => findManyCalls().filter((c) => Array.isArray(c[0]?.where?.id?.in) && !c[0]?.orderBy);
/** Calls whose where carries an id startsWith (the prefix backstop). */
const prefixCalls = (prefix: string) => findManyCalls().filter((c) => c[0]?.where?.id?.startsWith === prefix);

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  for (const k of ['TICKET_DISPATCH_FRESH_LANES_DISABLED', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_CONCURRENCY_NIGHT', 'TICKET_LANE_NIGHT_HOURS', 'TICKET_LANE_NO_RUN_REDISPATCH_HOURS',
    'TICKET_LANE_MAX_DISPATCHES', 'TICKET_LANE_LEGACY_REDISPATCH_DISABLED', 'TICKET_LANE_PROJECT_ID', 'TICKET_DISPATCH_DAILY_CAP', 'TICKET_DISPATCH_ANY_USER', 'TICKET_DISPATCH_SCORING_DISABLED']) delete process.env[k];
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope'; // force the day cap path
  tickets = [];
  runs = [];
  kv.clear();
  chats.clear();
  spawnSeq = 0;
  chats.set(STANDING, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
});
afterAll(() => { process.env = ENV; });

describe('drain-time scoring — who spawns first when slots are scarce (9dacab1a)', () => {
  it('ONE slot, two P0 rows: the POST-DEPLOY-REOPENED one dispatches first', async () => {
    process.env.TICKET_LANE_CONCURRENCY = '1';
    // The two-probe gate (97c06f46) holds a dead-lane reclaim on its FIRST
    // absent probe BY DESIGN — not the behavior under test here. Disable it
    // so this test isolates the SCORING question (who wins the slot).
    process.env.TICKET_RECLAIM_TWO_PROBE_DISABLED = '1';
    // The true verifier-reopen shape: the row KEEPS its lane stamps (the
    // verifier writes status/priority/verification only) and its lane is
    // long dead (last activity 20h ago) so both rows are eligible NOW.
    const deadLane = 'dead00000-0000-0000-0000-0000000000aa';
    tickets = [
      ticket('plain-0000-0000-000000000001', { priority: 0, createdAt: new Date(Date.now() - 1 * DAY) }),
      ticket('reopen-0000-0000-000000000002', {
        priority: 0, status: 'reopened', createdAt: new Date(Date.now() - 30 * DAY),
        context: {
          dispatchMode: 'ticket_lane', dispatchedTo: deadLane,
          dispatchedAt: new Date(Date.now() - 30 * DAY).toISOString(),
          verification: { lastVerdict: 'reopened', reopenedAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
        },
      }),
    ];
    runs = [{ sessionId: deadLane, status: 'COMPLETED', createdAt: new Date(Date.now() - 30 * DAY), updatedAt: new Date(Date.now() - 20 * 3600_000) }];
    chats.set(deadLane, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('reopen-0000');
    // The loser keeps its row untouched — no note, still open.
    expect(byId('plain-0000-0000-000000000001').status).toBe('open');
    // NON-VACUITY: the open scan actually saw both rows.
    expect(statusInCalls(['open', 'in_progress', 'reopened'])[0][0].take).toBe(60);
    const openScanRows = await faithfulFindMany({ where: { status: { in: ['open', 'in_progress', 'reopened'] } }, take: 60 });
    expect(openScanRows).toHaveLength(2);
  });

  it('ONE slot: a multi-unblock P0 overtakes a plain P0 (the leverage term)', async () => {
    process.env.TICKET_LANE_CONCURRENCY = '1';
    tickets = [
      ticket('plain-0000-0000-000000000003', { priority: 0, createdAt: new Date(Date.now() - 2 * DAY) }),
      ticket('block-0000-0000-000000000004', { priority: 0, createdAt: new Date(Date.now() - 1 * DAY) }),
      ticket('dep1-0000-0000-000000000005', { priority: 0, context: { dependsOnTicketIds: ['block-0000-0000-000000000004'] }, createdAt: new Date(Date.now() - 1 * DAY) }),
      ticket('dep2-0000-0000-000000000006', { priority: 0, context: { dependsOnTicketIds: ['block-0000-0000-000000000004'] }, createdAt: new Date(Date.now() - 1 * DAY) }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('block-0000');
    // NON-VACUITY: the blocker index fetched the deps the scan rows name.
    expect(blockerIndexCalls().length).toBeGreaterThan(0);
    expect(blockerIndexCalls().some((c) => (c[0].where.id.in as string[]).includes('block-0000-0000-000000000004'))).toBe(true);
  });

  it('STARVATION RELIEF: an old occurrences-heavy P0 overtakes a fresh P0', async () => {
    process.env.TICKET_LANE_CONCURRENCY = '1';
    tickets = [
      ticket('fresh-0000-0000-000000000007', { priority: 0, createdAt: new Date(Date.now() - 1 * DAY) }),
      ticket('old-00000-0000-000000000008', { priority: 0, createdAt: new Date(Date.now() - 60 * DAY), context: { occurrences: 6 } }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('old-00000');
  });

  it('priority still rules: a P3 beats every accrual stack (kill switch OFF)', async () => {
    process.env.TICKET_LANE_CONCURRENCY = '1';
    tickets = [
      ticket('p3-00000-0000-000000000009', { priority: 3, createdAt: new Date(Date.now()) }),
      ticket('stacked00-0000-00000000000a', {
        priority: 0, status: 'reopened', createdAt: new Date(Date.now() - 120 * DAY), context: { occurrences: 50 },
      }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('p3-00000');
  });

  it('AGE STRATUM on the REAL starvation shape: 60 fresh HIGHER-priority noise rows hide an ancient P0 that only the stratum rescues', async () => {
    // The REAL starvation shape: 60 noise rows with HIGHER priority (1) and
    // RECENT createdAt fill the static [{priority desc},{createdAt asc}]
    // top-FRESH_SCAN=60 fetch entirely — the ancient priority-0 row NEVER
    // enters it (pre-fix starvation: no in-memory ranking could reach a row
    // the fetch never scanned). The noise rows carry autoDispatch:false (the
    // dispatch_platform_task non-admin degrade opt-out) so they are scanned
    // but never claim a slot; the ancient row, rescued ONLY by the
    // oldest-first stratum pass, is the one dispatchable row and claims the
    // single slot. Mutation-proven: AGE_STRATUM_ROWS=0 (no stratum rows)
    // makes this test FAIL — nothing dispatchable is ever scanned.
    process.env.TICKET_LANE_CONCURRENCY = '1';
    tickets = [ticket('ancient00-0000-00000000000b', {
      priority: 0, createdAt: new Date(Date.now() - 200 * DAY), context: { occurrences: 3 },
    })];
    for (let i = 0; i < 60; i++) {
      tickets.push(ticket(`noise${String(i).padStart(4, '0')}-0000-0000000000nc`, {
        priority: 1, createdAt: new Date(Date.now() - (1 + i) * DAY),
        context: { autoDispatch: false }, // scanned, never dispatched
      }));
    }
    expect(tickets).toHaveLength(61);
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    // NON-VACUITY + the starvation shape itself: the static pass (priority
    // desc top-60) contains ZERO 'ancient00' rows — only the stratum pass
    // (createdAt asc) can have scanned it.
    const staticPass = await faithfulFindMany({ where: { status: { in: ['open', 'in_progress', 'reopened'] } }, orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }], take: 60 });
    expect(staticPass).toHaveLength(60);
    expect(staticPass.some((x) => x.id === 'ancient00-0000-00000000000b')).toBe(false);
    const stratumPass = await faithfulFindMany({ where: { status: { in: ['open', 'in_progress', 'reopened'] } }, orderBy: { createdAt: 'asc' }, take: AGE_STRATUM_ROWS });
    expect(stratumPass.length).toBeGreaterThan(0);
    expect(stratumPass[0].id).toBe('ancient00-0000-00000000000b');
    // The drain really issued both passes, and the ancient row WON the slot.
    expect(findManyCalls().filter((c) => Array.isArray(c[0]?.orderBy) && c[0].take === 60)).toHaveLength(1);
    expect(findManyCalls().filter((c) => c[0]?.orderBy?.createdAt === 'asc' && c[0].take === AGE_STRATUM_ROWS)).toHaveLength(1);
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('ancient00');
  });

  it('AGE STRATUM boundary: the stratum row loses to a higher BAND even though it entered the scan', async () => {
    // The invariant priority-is-sacred: the stratum lets the old row INTO
    // the scan, but a fresh P1 still outranks it (no self-accrual stack
    // crosses a band).
    process.env.TICKET_LANE_CONCURRENCY = '1';
    tickets = [
      ticket('ancient00-0000-00000000000c', { priority: 0, createdAt: new Date(Date.now() - 200 * DAY), context: { occurrences: 9 } }),
      ticket('p1fresh00-0000-00000000000d', { priority: 1, createdAt: new Date(Date.now() - 1 * DAY) }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('p1fresh00');
  });

  it('kill switch TICKET_DISPATCH_SCORING_DISABLED=1 restores the static order', async () => {
    process.env.TICKET_LANE_CONCURRENCY = '1';
    process.env.TICKET_DISPATCH_SCORING_DISABLED = '1';
    // TICKET-LANE ARCHIVE GAPS (2026-10-21): the paged closed-lane scan also
    // orders by an array ([updatedAt desc, id desc]); this pin counts the
    // OPEN-scan passes, so it runs on the pre-gaps closed read (the restore).
    process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED = '1';
    tickets = [
      ticket('fresh-0000-0000-00000000000c', { priority: 0, createdAt: new Date(Date.now() - 1 * DAY) }),
      ticket('old-00000-0000-00000000000d', { priority: 0, createdAt: new Date(Date.now() - 60 * DAY), context: { occurrences: 6 } }),
      ticket('p1-00000-0000-00000000000e', { priority: 1, createdAt: new Date(Date.now()) }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    // Static order: priority desc first → the P1 row wins (regardless of age
    // or occurrences), and only ONE orderBy-array findMany call fired (no
    // stratum fetch).
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('p1-00000');
    const findManyCallsLocal = mockPrisma.userFeatureRequest.findMany.mock.calls;
    expect(findManyCallsLocal.filter((c: any[]) => Array.isArray(c[0]?.orderBy))).toHaveLength(1);
  });
});

describe('dependency gating — the ticket waits, then auto-unblocks (9dacab1a, dedicated blocker index F1)', () => {
  it('a ticket with an OPEN blocker never spawns and carries the wait note', async () => {
    tickets = [
      ticket('block-0000-0000-000000000010', { priority: 0, createdAt: new Date(Date.now() - 2 * DAY) }),
      ticket('gated-0000-0000-000000000011', {
        priority: 5, // even the highest priority waits
        context: { dependsOnTicketIds: ['block-0000-0000-000000000010'] },
        createdAt: new Date(Date.now() - 1 * DAY),
      }),
    ];
    const r = await drainOpenTicketsToLane();
    // The blocker dispatched; the gated row did NOT (no second spawn, no claim).
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('block-0000');
    const gated = byId('gated-0000-0000-000000000011');
    expect(gated.status).toBe('open');
    expect(String(gated.adminNote)).toMatch(/^Waiting on ticket dependencies block-00\b/);
    expect(r).toEqual({ result: 'sent', batched: 1 });
    // NON-VACUITY: the dedicated blocker index fetched the dep id by id-IN.
    expect(blockerIndexCalls().some((c) => (c[0].where.id.in as string[]).includes('block-0000-0000-000000000010'))).toBe(true);
  });

  it('AUTO-UNBLOCK: the blocker closing dispatches the gated ticket on the next drain', async () => {
    tickets = [
      ticket('block-0000-0000-000000000012', { priority: 0 }),
      ticket('gated-0000-0000-000000000013', { context: { dependsOnTicketIds: ['block-0000-0000-000000000012'] } }),
    ];
    await drainOpenTicketsToLane(); // blocker spawns, gated waits
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    // The blocker's fix ships: its lane closes it.
    byId('block-0000-0000-000000000012').status = 'done';
    // A second drain: the closed blocker unblocks; the gated row dispatches,
    // its wait note rewritten by the fresh-lane stamp.
    const r2 = await drainOpenTicketsToLane();
    expect(r2).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession).toHaveBeenCalledTimes(2);
    expect(mockStartCodingSession.mock.calls[1][0].title).toContain('gated-0000');
    expect(String(byId('gated-0000-0000-000000000013').adminNote)).toMatch(/^Queued — ticket lane /);
    // NON-VACUITY (drain 2): the blocker index still resolved the dep id —
    // and found the CLOSED row (status carried by the dedicated index now).
    const idx = blockerIndexCalls().filter((c) => (c[0].where.id.in as string[]).includes('block-0000-0000-000000000012'));
    expect(idx.length).toBeGreaterThan(0);
    // The dedicated index SELECTS status (the F1 fix — the old closed fetch's
    // {id,context}-only select made every closed blocker read open forever).
    expect(idx[0][0].select.status).toBe(true);
  });

  it('a CLOSED blocker never gated: the ticket dispatches immediately', async () => {
    // TICKET-LANE ARCHIVE GAPS (2026-10-21): the non-vacuity pin below reads
    // the PRE-gaps closed fetch (every closed row, take:100); the gaps scan is
    // lane rows only + awaiting_verification — this pins the restore.
    process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED = '1';
    tickets = [
      ticket('shipped-0000-000000000014', { status: 'done', updatedAt: new Date(Date.now() - 5 * 60_000) }),
      ticket('gated-0000-0000-000000000015', { context: { dependsOnTicketIds: ['shipped-0000-000000000014'] } }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('gated-0000');
    // NON-VACUITY: the closed-row fetch (lane archival) ran over closed
    // statuses and returned the shipped row. The real closed vocabulary
    // (ticket-priority isClosedTicketRow) includes 'deployed_verified'.
    const closedCalls = statusInCalls(['done', 'deployed_verified', 'resolved', 'closed', 'archived', 'rejected', 'duplicate', 'wontfix']);
    expect(closedCalls.length).toBeGreaterThan(0);
    const closedRows = await faithfulFindMany({ where: closedCalls[0][0].where, orderBy: closedCalls[0][0].orderBy, take: closedCalls[0][0].take });
    expect(closedRows.some((x) => x.id === 'shipped-0000-000000000014')).toBe(true);
  });

  it('a QUEUED blocker GATES via the dedicated index (invisible to the old open-scan + closed-fetch index)', async () => {
    // 'queued' is not in the open scan's status-in list and not closed —
    // pre-F1 the blocker was invisible and the dependent read unblocked.
    tickets = [
      ticket('queued-b-0000-000000000016', { status: 'queued', updatedAt: new Date(Date.now() - 30 * DAY) }),
      ticket('gated-0000-0000-000000000017', { context: { dependsOnTicketIds: ['queued-b-0000-000000000016'] } }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'deduped', batched: 0 }); // nothing spawned: the gated row waits
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(String(byId('gated-0000-0000-000000000017').adminNote)).toMatch(/^Waiting on ticket dependencies queued-b/);
    // NON-VACUITY: the blocker index resolved the queued row by id.
    const idx = blockerIndexCalls().filter((c) => (c[0].where.id.in as string[]).includes('queued-b-0000-000000000016'));
    expect(idx.length).toBeGreaterThan(0);
    const resolved = await faithfulFindMany(idx[0][0]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].status).toBe('queued');
  });

  it('an AWAITING_VERIFICATION blocker GATES via the dedicated index', async () => {
    tickets = [
      ticket('awaitb-0000-000000000018', { status: 'awaiting_verification', updatedAt: new Date(Date.now() - 30 * DAY) }),
      ticket('gated-0000-0000-000000000019', { context: { dependsOnTicketIds: ['awaitb-0000-000000000018'] } }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'deduped', batched: 0 });
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(String(byId('gated-0000-0000-000000000019').adminNote)).toMatch(/^Waiting on ticket dependencies awaitb-/);
  });

  it('a blocker OUTSIDE the 7d archive-lookback window (old updatedAt) still gates', async () => {
    // Pre-F1 the dependency index drew on the closed fetch bounded by
    // updatedAt >= now - 7d: an OPEN blocker last touched 30 days ago was
    // outside the closed fetch AND (being open-but-stale) it IS in the open
    // scan here — so pin the stronger shape: a QUEUED blocker with an
    // updatedAt 30 days old (outside EVERY window) still gates via the id
    // fetch, which has no updatedAt bound at all.
    tickets = [
      ticket('oldb-00000-0000-00000000001a', { status: 'queued', updatedAt: new Date(Date.now() - 30 * DAY), createdAt: new Date(Date.now() - 40 * DAY) }),
      ticket('gated-0000-0000-00000000001b', { context: { dependsOnTicketIds: ['oldb-00000-0000-00000000001a'] } }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'deduped', batched: 0 });
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(String(byId('gated-0000-0000-00000000001b').adminNote)).toMatch(/^Waiting on ticket dependencies oldb-000/);
    // NON-VACUITY: no fetch the drain issued uses an updatedAt bound that
    // would exclude the 30d-old row from the blocker index (the id fetch has
    // none), and the id fetch DID return it.
    const idx = blockerIndexCalls().filter((c) => (c[0].where.id.in as string[]).includes('oldb-00000-0000-00000000001a'));
    expect(idx).toHaveLength(1);
    expect(idx[0][0].where.updatedAt).toBeUndefined();
    const resolved = await faithfulFindMany(idx[0][0]);
    expect(resolved).toHaveLength(1);
  });

  it('unknown blocker id reads UNBLOCKED (an admin typo never wedges the ticket)', async () => {
    // The ghost dep id is a plausible ticket id shape (length 36, so no
    // prefix backstop fires) that matches NO row: the dedicated id-IN fetch
    // returns nothing for it, it stays unresolved, and the drain reads it
    // UNBLOCKED (fail-open) — the dependent dispatches normally.
    tickets = [
      ticket('typo-00000-0000-000000000018', { context: { dependsOnTicketIds: ['ghost-0000-0000-00000000dead'] } }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('typo-00000');
    // NON-VACUITY + the exact root cause of the old failure: the id-IN fetch
    // for the ghost id ran and returned ZERO rows for it. The ghost id is 28
    // chars (≥8, <36) so the PREFIX BACKSTOP legitimately fires too — and
    // also returns 0 matches, leaving the dep UNRESOLVED → the drain reads it
    // UNBLOCKED (fail-open: an admin typo never wedges the ticket).
    const idx = blockerIndexCalls().filter((c) => (c[0].where.id.in as string[]).includes('ghost-0000-0000-00000000dead'));
    expect(idx).toHaveLength(1);
    expect(await faithfulFindMany(idx[0][0])).toHaveLength(0);
    expect(prefixCalls('ghost-0000-0000-00000000dead')).toHaveLength(1); // the backstop fired…
    expect((await faithfulFindMany(prefixCalls('ghost-0000-0000-00000000dead')[0][0])).length).toBe(0); // …and matched nothing → unresolved → unblocked
  });

  it('a PREFIX dep id resolves via the unique-match backstop and gates on the canonical row', async () => {
    // F2 read side: a stored 8-char prefix names exactly one row → the
    // backstop maps it to that row (id first-8) and the gate engages.
    tickets = [
      ticket('block-0000-0000-000000000020', { priority: 0 }),
      ticket('gated-0000-0000-000000000021', { context: { dependsOnTicketIds: ['block-0000'] } }),
    ];
    const r = await drainOpenTicketsToLane();
    // The blocker spawned; the gated row waits on it.
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('block-0000');
    expect(String(byId('gated-0000-0000-000000000021').adminNote)).toMatch(/^Waiting on ticket dependencies block-00\b/);
    expect(r).toEqual({ result: 'sent', batched: 1 });
    // NON-VACUITY: the prefix backstop fired for the 8-char dep id.
    expect(prefixCalls('block-0000')).toHaveLength(1);
  });

  it('an AMBIGUOUS prefix dep id (two rows share it) reads UNBLOCKED — never a wrong gate', async () => {
    tickets = [
      ticket('samepfx00-0000-000000000022', { priority: 0 }),
      ticket('samepfx00-0000-000000000023', { priority: 0 }),
      ticket('gated-0000-0000-000000000024', { context: { dependsOnTicketIds: ['samepfx00-0000'] } }),
    ];
    const r = await drainOpenTicketsToLane();
    // The two blockers spawned (2 lanes); the gated row was NOT gated (the
    // ambiguous prefix cannot pick a row) and spawned too.
    expect(r).toEqual({ result: 'sent', batched: 3 });
    expect(String(byId('gated-0000-0000-000000000024').adminNote ?? '')).not.toMatch(/^Waiting on ticket dependencies/);
    // NON-VACUITY: the backstop ran and found TWO rows (the ambiguity).
    expect(prefixCalls('samepfx00-0000')).toHaveLength(1);
    expect((await faithfulFindMany(prefixCalls('samepfx00-0000')[0][0])).length).toBe(2);
  });

  it('defense in depth: a dispatch-stamped row with deps is NOT gated (the reclaim owns it)', async () => {
    // Hand-written state (a row stamped to a lane AND carrying deps): the
    // gate must not strand a live dispatch behind its own blockers.
    const lane = '11111111-2222-3333-4444-555555555555';
    tickets = [
      ticket('live-00000-0000-000000000016', {
        status: 'in_progress',
        adminNote: 'Ticket lane 11111111 working since 2026-10-18T00:00:00Z (dispatch 1 of 3).',
        context: { dispatchedTo: lane, dispatchMode: 'ticket_lane', dispatchedAt: new Date(Date.now() - 60_000).toISOString(), dependsOnTicketIds: ['block-0000-0000-000000000017'] },
      }),
      ticket('block-0000-0000-000000000017', { priority: 0 }),
    ];
    runs = [{ sessionId: lane, status: 'running', createdAt: new Date(Date.now() - 30_000), updatedAt: new Date(Date.now() - 30_000) }];
    chats.set(lane, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
    const r = await drainOpenTicketsToLane();
    // The live row keeps its lane note (the gate skipped it), the blocker
    // spawns normally, and nothing is stranded.
    expect(String(byId('live-00000-0000-000000000016').adminNote)).toMatch(/^Ticket lane 11111111 working since/);
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].title).toContain('block-0000');
    expect(r).toEqual({ result: 'sent', batched: 1 });
  });

  it('ROUND-2 MINOR-2 (19e0c050): a chunk-1 fetch failure does NOT abort the remaining chunks — a chunk-2 blocker still gates (uniform fail-open)', async () => {
    // Round-1's single .catch OUTSIDE the chunk loop meant a transient error
    // on chunk 1 aborted chunks 2..N: every dep named by a later chunk read
    // UNBLOCKED. With 501 distinct dep ids (chunk size is 500), the first
    // chunk holds the failing dep and chunk 2 holds the live blocker — under
    // the old code the early return left the chunk-2 blocker unresolved →
    // the dependent read unblocked → it DISPATCHED. Per-chunk try/catch: the
    // failed chunk's ids fail open, the healthy chunk's ids still GATE.
    const depA = 'chunka00-0000-4000-8000-00000000001c'; // chunk-1 id (36 chars: no prefix backstop)
    const depB = 'chunkb00-0000-4000-8000-00000000001d'; // chunk-2 id
    const fillers = Array.from({ length: 499 }, (_, i) =>
      `f${String(i + 1).padStart(7, '0')}-0000-4000-8000-000000000000`); // 36-char ghosts
    tickets = [
      ticket(depA, { status: 'queued' }), // would gate if resolved
      ticket(depB, { status: 'queued' }), // the healthy chunk's blocker
      ticket('depwait0-0000-4000-8000-000000000020', { context: { dependsOnTicketIds: [depA, ...fillers, depB] } }),
    ];
    // Fail ONLY the id-IN fetch whose chunk contains depA (chunk 1); every
    // other findMany (open scan, closed fetch, age stratum, chunk 2) is the
    // faithful one.
    const realFindMany = faithfulFindMany;
    const originalImpl = mockPrisma.userFeatureRequest.findMany.getMockImplementation();
    mockPrisma.userFeatureRequest.findMany.mockImplementation(async (args: any) => {
      if (Array.isArray(args?.where?.id?.in) && args.where.id.in.includes(depA)) {
        throw new Error('transient chunk failure');
      }
      return realFindMany(args);
    });
    try {
      const r = await drainOpenTicketsToLane();
      // NON-VACUITY: chunk 1 really failed and chunk 2 really ran.
      const failedChunks = findManyCalls().filter((c) => Array.isArray(c[0]?.where?.id?.in) && c[0].where.id.in.includes(depA));
      expect(failedChunks.length).toBeGreaterThan(0);
      const chunk2 = findManyCalls().filter((c) => Array.isArray(c[0]?.where?.id?.in) && c[0].where.id.in.includes(depB));
      expect(chunk2.length).toBeGreaterThan(0);
      // The chunk-2 blocker gated the dependent: it waits (never spawned) —
      // under the round-1 code the early return left depB unresolved and the
      // dependent read unblocked (fail-open everywhere).
      expect(mockStartCodingSession).not.toHaveBeenCalled();
      expect(String(byId('depwait0-0000-4000-8000-000000000020').adminNote)).toMatch(/^Waiting on ticket dependencies chunkb00/);
      expect(r).toEqual({ result: 'deduped', batched: 0 });
    } finally {
      mockPrisma.userFeatureRequest.findMany.mockImplementation(originalImpl);
    }
  });
});

describe('batch drain dependency gating (F6 — the legacy batch cannot ride a gated ticket out)', () => {
  // The batch path runs when the fresh-lanes kill switch is ON; the standing
  // lane chat exists and is idle (deliverBatch falls back to sendToLane).
  beforeEach(() => { process.env.TICKET_DISPATCH_FRESH_LANES_DISABLED = '1'; });

  it('the batch drain skips + wait-notes an undispatched gated row and it never enters the batch', async () => {
    tickets = [
      ticket('block-0000-0000-000000000025', { priority: 0 }),
      ticket('gated-0000-0000-000000000026', { priority: 1, context: { dependsOnTicketIds: ['block-0000-0000-000000000025'] } }),
    ];
    const r = await drainOpenTicketsToLane();
    // The batch contained ONLY the blocker — the gated row never entered it.
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockSendChatMessage).toHaveBeenCalledTimes(1);
    const brief = mockSendChatMessage.mock.calls[0][0].content;
    expect(brief).toContain('block-0000');
    expect(brief).not.toContain('gated-0000');
    // The gated row carries the dependency wait note.
    const gated = byId('gated-0000-0000-000000000026');
    expect(String(gated.adminNote)).toMatch(/^Waiting on ticket dependencies block-00\b/);
    expect(gated.status).toBe('open');
    // NON-VACUITY: the batch's blocker index resolved the dep id.
    expect(blockerIndexCalls().some((c) => (c[0].where.id.in as string[]).includes('block-0000-0000-000000000025'))).toBe(true);
  });

  it('AUTO-UNBLOCK on the batch path: closing the blocker clears the wait note and the row batches', async () => {
    tickets = [
      ticket('block-0000-0000-000000000027', { priority: 0 }),
      ticket('gated-0000-0000-000000000028', { priority: 1, context: { dependsOnTicketIds: ['block-0000-0000-000000000027'] } }),
    ];
    await drainOpenTicketsToLane(); // gated row waits, blocker batches
    expect(String(byId('gated-0000-0000-000000000028').adminNote)).toMatch(/^Waiting on ticket dependencies/);
    // The blocker's fix ships and its claim is released (a closed row is not
    // re-dispatched; clearing the kv simulates the 30d claim lapsing).
    byId('block-0000-0000-000000000027').status = 'done';
    kv.clear();
    const r2 = await drainOpenTicketsToLane();
    expect(r2).toEqual({ result: 'sent', batched: 1 });
    const brief2 = mockSendChatMessage.mock.calls[1][0].content;
    expect(brief2).toContain('gated-0000');
    // The wait note is CLEARED (auto-unblock) and the row was dispatched.
    const gated = byId('gated-0000-0000-000000000028');
    expect(String(gated.adminNote)).toMatch(/^Dispatched to the engineering lane at /);
    expect(gated.status).toBe('in_progress');
  });
});
