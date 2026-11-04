/**
 * TICKET-LANE ARCHIVE GAPS (2026-10-21) — every way a ticket lane escaped the
 * dispatcher's archive, from the lane-lifecycle prod probe LLC1021
 * (2026-10-21 19:10Z): the closed-ticket archive in the fresh-lane drain is
 * the ONLY retirement a ticket lane has (the child reapers key on
 * parentChatId; ticket lanes are parentless), and it missed:
 *
 *   B1  'awaiting_verification' rows (in neither the open scan nor the closed
 *       query) — lane 241242d0 of ticket 4a8fcbde sat idle 19 h;
 *   B2  a reopen inheriting the first close's laneArchivedAt (the next lane
 *       was never archived), and a verifier-reopened ticket waiting out the
 *       6 h / 8 h windows behind a lane that is already archived;
 *   B3  take:100 before the laneArchivedAt filter (88 of 89 lane rows in the
 *       prod window were already archived) and the 7-day window;
 *   B4  previousLanes orphans (undispatchedContext hands the row back to
 *       'open' with its lane unarchived) and B5 the superseded lane's single
 *       archive attempt;
 *   B6  a satellite stuck 'running' with no live run (archiveChat 409s).
 *
 * Kill switch TICKET_LANE_ARCHIVE_GAPS_DISABLED=1 restores every piece.
 *
 * Harness: the bf656696 suite's shape, with the SELECT/WHERE-faithful
 * userFeatureRequest table (ticket-dispatch.mock.9dacab1a.ts — it honours the
 * scan's JSON-path dispatchMode filter, skip/take paging and the id
 * tiebreak), chat rows with archivedAt / createdAt / a satellite status, and
 * schedule rows with promptSetBy.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { makeFaithfulFindMany, mockMatchesWhere, mockApplySelect, type MockRow } from './ticket-dispatch.mock.9dacab1a';

type Row = MockRow & {
  id: string; type: string; title: string; description: string; priority: number; source: string;
  status: string; adminNote: string | null; context: any; createdAt: Date; updatedAt: Date; userId?: string | null;
};
let tickets: Row[] = [];
let runs: Array<{ sessionId: string; status: string; createdAt: Date; updatedAt: Date }> = [];
type Chat = { userId: string; projectId: string | null; archivedAt: Date | null; createdAt: Date; updatedAt?: Date; isSupervisor?: boolean; isProjectSupervisor?: boolean; satellite?: string };
const chats = new Map<string, Chat>();
type Sched = { id: string; sessionId: string; kind: string; enabled: boolean; promptSetBy: string | null; ownerSubscribed?: boolean | null; renewedFromId?: string | null };
const schedules = new Map<string, Sched>();
// Second review fixer (2026-10-21): the house-rule reads (lane-family-facts readLaneKeepReasons).
const restoreMarkers = new Set<string>();
let childChats: Array<{ id: string; parentChatId: string; archivedAt: Date | null }> = [];
let ownerQuestions: Array<{ chatId: string; status: string }> = [];
let confirmations: Array<{ chatId: string; status: string; expiresAt: Date }> = [];
let openTodos: Array<{ assigneeChatId: string; status: string }> = [];
let userMessages: Array<{ chatId: string; role: string; createdAt: Date; metadata: any }> = [];
let shareLinks: Array<{ chatId: string; isActive: boolean; expiresAt: Date | null }> = [];
let chatWebhooks: Array<{ chatId: string; isActive: boolean }> = [];
let eventHooks: Array<{ targetChatId: string; enabled: boolean; createdVia: string | null }> = [];
const pinnedChats = new Set<string>();
// Third review (2026-10-22): the restore AUDIT (archiveChat's chat.restore / chat.archive Activity rows) the drain now reads too.
let activities: Array<{ userId: string; resource: string; action: string; createdAt: Date; metadata: any }> = [];
const inIds = (v: unknown, cond: any) => Array.isArray(cond?.in) && cond.in.includes(v);

const faithfulFindMany = makeFaithfulFindMany(() => tickets);

const mockPrisma: any = {
  crossModelChat: {
    findUnique: jest.fn(async ({ where, select }: any) => {
      const c = chats.get(where.id);
      return c ? mockApplySelect({ id: where.id, ...c }, select) : null;
    }),
    // WHERE-faithful (id IN, and the previous-lane sweep's archivedAt: null prefilter);
    // the house-rule family read asks for unarchived CHILDREN (parentChatId IN).
    findMany: jest.fn(async ({ where, select, take }: any) => {
      if (where?.parentChatId) return childChats.filter((c) => inIds(c.parentChatId, where.parentChatId) && !c.archivedAt).slice(0, take ?? Infinity).map((c) => ({ id: c.id, parentChatId: c.parentChatId }));
      return [...chats.entries()]
        .filter(([id, c]) => mockMatchesWhere({ id, ...c } as Record<string, any>, where))
        .slice(0, take ?? Infinity)
        .map(([id, c]) => mockApplySelect({ id, titlePinned: pinnedChats.has(id), ...c }, select));
    }),
  },
  projectTodo: { findMany: jest.fn(async ({ where }: any) => openTodos.filter((t) => inIds(t.assigneeChatId, where.assigneeChatId) && inIds(t.status, where.status))) },
  ownerQuestion: { findMany: jest.fn(async ({ where }: any) => ownerQuestions.filter((q) => inIds(q.chatId, where.chatId) && q.status === where.status)) },
  pendingConfirmation: { findMany: jest.fn(async ({ where }: any) => confirmations.filter((c) => inIds(c.chatId, where.chatId) && c.status === where.status && c.expiresAt > where.expiresAt.gt)) },
  crossModelMessage: { findMany: jest.fn(async ({ where, take }: any) => userMessages.filter((m) => inIds(m.chatId, where.chatId) && m.role === where.role && m.createdAt >= where.createdAt.gte).slice(0, take ?? Infinity)) },
  chatShareLink: { findMany: jest.fn(async ({ where }: any) => shareLinks.filter((x) => inIds(x.chatId, where.chatId))) },
  chatWebhook: { findMany: jest.fn(async ({ where }: any) => chatWebhooks.filter((w) => inIds(w.chatId, where.chatId) && (where.isActive === undefined || w.isActive === where.isActive))) },
  eventHook: { findMany: jest.fn(async ({ where }: any) => eventHooks.filter((h) => inIds(h.targetChatId, where.targetChatId) && h.enabled === where.enabled)) },
  crossModelProject: { findUnique: jest.fn(async () => null) },
  activity: {
    findMany: jest.fn(async ({ where, take }: any) => activities.filter((a) => inIds(a.userId, where.userId) && a.resource === where.resource
      && (Array.isArray(where.action?.in) ? where.action.in.includes(a.action) : a.action === where.action) && a.createdAt >= where.createdAt.gte
      && (!where.OR || where.OR.some((o: any) => a.metadata?.chatId === o.metadata.equals))).slice(0, take ?? Infinity)
      .map((a) => ({ action: a.action, metadata: a.metadata, createdAt: a.createdAt }))),
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
    // WHERE-faithful for the shapes the drain issues: sessionId IN, and the
    // previous-lane sweep's exact idle re-check (OR of updatedAt gte / status IN).
    findMany: jest.fn(async ({ where }: any) => runs.filter((r) => where.sessionId.in.includes(r.sessionId)
      && (!Array.isArray(where.status?.in) || where.status.in.includes(r.status))
      && (!Array.isArray(where.OR) || where.OR.some((b: any) => (b.updatedAt?.gte ? r.updatedAt >= b.updatedAt.gte : false)
        || (Array.isArray(b.status?.in) ? b.status.in.includes(r.status) : false))))),
    // Second review fixer: the lane states' per-(lane, status) aggregates (readLaneRunAggregates).
    groupBy: jest.fn(async ({ where }: any) => {
      const g = new Map<string, { sessionId: string; status: string; _count: { _all: number }; _min: { createdAt: Date }; _max: { updatedAt: Date } }>();
      for (const r of runs.filter((x) => where.sessionId.in.includes(x.sessionId))) {
        const k = `${r.sessionId}|${r.status}`;
        const cur = g.get(k);
        if (!cur) g.set(k, { sessionId: r.sessionId, status: r.status, _count: { _all: 1 }, _min: { createdAt: r.createdAt }, _max: { updatedAt: r.updatedAt } });
        else { cur._count._all++; if (r.createdAt < cur._min.createdAt) cur._min.createdAt = r.createdAt; if (r.updatedAt > cur._max.updatedAt) cur._max.updatedAt = r.updatedAt; }
      }
      return [...g.values()];
    }),
    count: jest.fn(async ({ where }: any) => runs.filter((r) => r.sessionId === where.sessionId
      && (!where.status?.in || where.status.in.includes(r.status))
      && (!where.updatedAt?.gte || r.updatedAt >= where.updatedAt.gte)).length),
  },
  chatCodingState: {
    findUnique: jest.fn(async ({ where }: any) => {
      const c = chats.get(where.id);
      return c?.satellite ? { status: c.satellite } : null;
    }),
    findMany: jest.fn(async () => []),
  },
  codingSchedule: {
    // WHERE- and SELECT-faithful: sessionId IN / id IN, enabled, and the owner-armed OR
    // (promptSetBy user|null, ownerSubscribed, renewedFromId not null).
    findMany: jest.fn(async ({ where, select }: any) => [...schedules.values()]
      .filter((s) => (!where?.sessionId?.in || where.sessionId.in.includes(s.sessionId))
        && (!where?.id?.in || where.id.in.includes(s.id))
        && (where?.enabled === undefined || s.enabled === where.enabled)
        && (!Array.isArray(where?.OR) || where.OR.some((b: any) => ('promptSetBy' in b ? (b.promptSetBy === null ? s.promptSetBy == null : s.promptSetBy === b.promptSetBy)
          : 'ownerSubscribed' in b ? s.ownerSubscribed === b.ownerSubscribed
            : 'renewedFromId' in b ? s.renewedFromId != null : false))))
      .map((s) => mockApplySelect({ ...s }, select ?? { sessionId: true }))),
  },
  contextStoreEntry: {
    findUnique: jest.fn(async () => null),
    // The restore marker (lane-family-facts storeGetMany over ['lane-lifecycle','restored']).
    findMany: jest.fn(async ({ where }: any) => (String(where?.namespacePath ?? '').includes('restored')
      ? (where.key?.in ?? []).filter((k: string) => restoreMarkers.has(k)).map((k: string) => ({ key: k, value: { at: new Date().toISOString() }, expiresAt: null }))
      : [])),
  },
  user: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const kv = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (key: string, value: string, opts?: any) => {
      if (opts?.NX && kv.has(key)) return null;
      kv.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
    incr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(n)); return n; }),
    incrBy: jest.fn(async (k: string, by: number) => { const n = Number(kv.get(k) ?? 0) + by; kv.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
    del: jest.fn(async (k: string) => { kv.delete(k); return 1; }),
    decr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) - 1; kv.set(k, String(n)); return n; }),
  },
}));

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

// B6: the single-id heal (its own predicates are pinned in coding-data.service.test.ts).
const mockHealOrphanedRunningSession = jest.fn();
jest.mock('../coding/coding-data.service', () => ({
  __esModule: true,
  healOrphanedRunningSession: (id: string) => mockHealOrphanedRunningSession(id),
}));

// Review 2026-10-21: an awaiting_verification row never completes its lane's ledger task.
const mockNoteTicketLaneClosed = jest.fn();
jest.mock('../platform/delegation-tasks', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/delegation-tasks'),
  noteTicketLaneClosed: (...a: any[]) => mockNoteTicketLaneClosed(...a),
}));

const mockRecordTicketQueueDepth = jest.fn();
jest.mock('../fleet/capacity-watch.service', () => ({
  __esModule: true,
  queueLiveFreshMs: () => 5 * 60_000,
  recordTicketQueueDepth: (i: any) => mockRecordTicketQueueDepth(i),
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
  drainOpenTicketsToLane, laneArchiveGapsDisabled, laneArchivedFor, withoutLaneArchiveStamp, previousLaneSweepCandidates,
  laneIdleClock, closedRowNewlyReached, memberPreviousLanes,
  LANE_ARCHIVE_STUCK_MS, CLOSED_LANE_SCAN_PAGE, PREVIOUS_LANE_ARCHIVE_MAX_PER_DRAIN,
  CLOSED_TICKET_LANE_RETIRE_DETAIL, SUPERSEDED_LANE_RETIRE_DETAIL, CLOSED_LANE_ARCHIVE_MAX_PER_DRAIN, CLOSED_LANE_SCAN_MAX_PAGES, TICKET_DRAIN_CASCADE_MAX,
  closedLaneArchiveOpts, TICKET_DRAIN_RETIRE_MAX_PER_HOUR, TICKET_DRAIN_CASCADE_MAX_PER_HOUR, TICKET_DRAIN_RETIRE_BUDGET_MS,
} from './ticket-dispatch.service';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';
const CLOSED_STATUSES = ['done', 'deployed_verified', 'resolved', 'closed', 'archived', 'rejected', 'duplicate', 'wontfix'];

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'bug_report', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 3, source: 'user', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 2 * DAY), updatedAt: new Date(Date.now() - MIN), ...over,
  };
}
const laneCtx = (lane: string, over: Record<string, unknown> = {}) => ({
  dispatchMode: 'ticket_lane', dispatchedTo: lane, dispatchedAt: new Date(Date.now() - 3 * H).toISOString(), laneDispatches: 1, ...over,
});
/** A lane chat row (a coding chat, not a supervisor), created 2 days ago. */
function lane(id: string, over: Partial<Chat> = {}): void {
  chats.set(id, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null, createdAt: new Date(Date.now() - 2 * DAY), ...over });
}
/** A finished run on the lane whose last activity was `agoMs` ago. */
function ranAgo(sessionId: string, agoMs: number, status = 'completed'): void {
  runs.push({ sessionId, status, createdAt: new Date(Date.now() - agoMs - 10 * MIN), updatedAt: new Date(Date.now() - agoMs) });
}
function sched(id: string, sessionId: string, promptSetBy: string | null, kind = 'recurring'): void {
  schedules.set(id, { id, sessionId, kind, enabled: true, promptSetBy });
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;
const archivedIds = () => mockArchiveChat.mock.calls.map((c) => c[0].chatId);
const lastQueueMeta = () => mockRecordTicketQueueDepth.mock.calls[mockRecordTicketQueueDepth.mock.calls.length - 1][0];
/** The closed-lane archive reads (closed statuses; no OR but the fifth-review keyset — the family-history read carries a title OR). */
const closedScanCalls = () => (mockPrisma.userFeatureRequest.findMany.mock.calls as Array<[any]>)
  .filter((c) => Array.isArray(c[0]?.where?.status?.in) && c[0].where.status.in.includes('done') && (!c[0].where.OR || c[0].where.OR.some((b: any) => b?.updatedAt?.lt)));

const ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  for (const k of ['TICKET_DISPATCH_FRESH_LANES_DISABLED', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_CONCURRENCY_NIGHT', 'TICKET_LANE_NO_RUN_REDISPATCH_HOURS',
    'TICKET_LANE_MAX_DISPATCHES', 'TICKET_LANE_LEGACY_REDISPATCH_DISABLED', 'TICKET_LANE_PROJECT_ID', 'TICKET_DISPATCH_DAILY_CAP', 'TICKET_DISPATCH_ANY_USER',
    'TICKET_LANE_ARCHIVE_PAUSE_DISABLED', 'TICKET_LANE_ARCHIVE_GAPS_DISABLED', 'TICKET_RECLAIM_TWO_PROBE_DISABLED']) delete process.env[k];
  // Night window off: the DAY cap applies whatever hour CI runs (the sibling suites' convention).
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope';
  tickets = [];
  runs = [];
  kv.clear();
  chats.clear();
  schedules.clear();
  restoreMarkers.clear();
  pinnedChats.clear();
  childChats = []; ownerQuestions = []; confirmations = []; openTodos = []; userMessages = []; shareLinks = []; chatWebhooks = []; eventHooks = []; activities = [];
  spawnSeq = 0;
  mockStartCodingSession.mockImplementation(async (_opts: any) => {
    const id = `${String(++spawnSeq).padStart(8, 'a')}-lane-session`;
    lane(id, { createdAt: new Date() });
    return { id };
  });
  // The real archiveChat refusals that matter here: a 'running' satellite and any enabled schedule.
  mockArchiveChat.mockImplementation(async ({ chatId }: any) => {
    const c = chats.get(chatId);
    if (!c) throw Object.assign(new Error('Chat not found'), { statusCode: 404 });
    if (c.satellite === 'running') throw Object.assign(new Error('This session is running — stop it before archiving'), { statusCode: 409 });
    if ([...schedules.values()].some((s) => s.sessionId === chatId && s.enabled)) throw Object.assign(new Error('This chat has enabled schedules — pause or cancel them before archiving'), { statusCode: 409 });
    c.archivedAt = new Date();
    return { id: chatId, archived: true };
  });
  mockPauseSchedulesForLaneArchive.mockImplementation(async (sessionId: string): Promise<number> => {
    const rows = [...schedules.values()].filter((s) => s.sessionId === sessionId && s.enabled);
    for (const s of rows) s.enabled = false;
    return rows.length;
  });
  mockHealOrphanedRunningSession.mockImplementation(async (id: string) => {
    const c = chats.get(id);
    if (c?.satellite !== 'running') return 'not_running';
    c.satellite = 'ready';
    return 'healed';
  });
  chats.set(STANDING, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null, createdAt: new Date(Date.now() - 90 * DAY) });
});
afterAll(() => { process.env = ENV; });

describe('pure helpers', () => {
  it('laneArchivedFor: a stamp naming the CURRENT lane (or a legacy stamp naming none) is archived; one naming an earlier lane is not', () => {
    expect(laneArchivedFor({ dispatchedTo: 'L2' })).toBe(false);
    expect(laneArchivedFor({ dispatchedTo: 'L2', laneArchivedAt: 'x' })).toBe(true); // legacy: trusted
    expect(laneArchivedFor({ dispatchedTo: 'L2', laneArchivedAt: 'x', laneArchivedLane: 'L2' })).toBe(true);
    expect(laneArchivedFor({ dispatchedTo: 'L2', laneArchivedAt: 'x', laneArchivedLane: 'L1' })).toBe(false);
  });

  it('withoutLaneArchiveStamp drops exactly the two stamp keys', () => {
    expect(withoutLaneArchiveStamp({ a: 1, laneArchivedAt: 'x', laneArchivedLane: 'L1', previousLanes: ['L0'] })).toEqual({ a: 1, previousLanes: ['L0'] });
  });

  it('previousLaneSweepCandidates: the union of previousLanes minus current dispatchedTo, the standing lane and the owned lanes, deduped and capped', () => {
    const sets = [
      [{ context: { previousLanes: ['P1', 'P2', 'CUR'] } }, { context: { dispatchedTo: 'CUR', previousLanes: ['P1'] } }],
      [{ context: { previousLanes: ['STAND', 'OWNED', 'P3'] } }],
      [{ context: { previousLanes: 'not-an-array' } }, { context: null }],
    ];
    expect(previousLaneSweepCandidates(sets, { standingLane: 'STAND', ownedLaneIds: new Set(['OWNED']) })).toEqual(['P1', 'P2', 'P3']);
    expect(previousLaneSweepCandidates(sets, { standingLane: 'STAND', ownedLaneIds: new Set() }, 2)).toEqual(['P1', 'P2']);
  });

  it('the kill switch reads like every switch of the 2026-10-21 wave (third review 2026-10-22): "1", "true" and "on" turn it on', () => {
    expect(laneArchiveGapsDisabled({})).toBe(false);
    for (const v of ['1', 'true', 'TRUE', ' on ']) expect(laneArchiveGapsDisabled({ TICKET_LANE_ARCHIVE_GAPS_DISABLED: v })).toBe(true);
    for (const v of ['', '0', 'false', 'off']) expect(laneArchiveGapsDisabled({ TICKET_LANE_ARCHIVE_GAPS_DISABLED: v })).toBe(false);
  });
});

describe('B1 — awaiting_verification lanes are archived', () => {
  it('ACCEPTANCE (4a8fcbde / 241242d0): an idle awaiting_verification ticket\'s lane is archived and BOTH stamp keys are written; the status is untouched', async () => {
    lane('241242d0-lane');
    ranAgo('241242d0-lane', 19 * H);
    tickets = [ticket('4a8fcbde-0', { status: 'awaiting_verification', context: laneCtx('241242d0-lane'), updatedAt: new Date(Date.now() - 19 * H) })];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['241242d0-lane']);
    expect(chats.get('241242d0-lane')!.archivedAt).toBeTruthy();
    const ctx = byId('4a8fcbde-0').context;
    expect(typeof ctx.laneArchivedAt).toBe('string');
    expect(ctx.laneArchivedLane).toBe('241242d0-lane');
    expect(byId('4a8fcbde-0').status).toBe('awaiting_verification'); // the verifier owns the next transition
    expect(lastQueueMeta()).toMatchObject({ archived: 1, archivedAwaiting: 1, archivedPrevious: 0, healedRunning: 0, closedScanRows: 1 });
    // A second drain does not re-archive (the stamp names the current lane).
    mockArchiveChat.mockClear();
    await drainOpenTicketsToLane();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });

  it('a LIVE awaiting_verification lane inside the 30-min window keeps its slot — no archive, and a waiting ticket does not spawn at concurrency 1', async () => {
    process.env.TICKET_LANE_CONCURRENCY = '1';
    process.env.TICKET_LANE_CONCURRENCY_NIGHT = '1';
    lane('await-live-01');
    runs = [{ sessionId: 'await-live-01', status: 'running', createdAt: new Date(Date.now() - 20 * MIN), updatedAt: new Date() }];
    tickets = [
      ticket('awaitlive-0', { status: 'awaiting_verification', context: laneCtx('await-live-01') }),
      ticket('waiting01-1', { priority: 2 }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(0);
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(byId('awaitlive-0').context.laneArchivedAt).toBeUndefined();
  });

  it('a family lane is not archived while a sibling still rides it — an awaiting row is never a rider', async () => {
    const fam = (role: string, l: string) => laneCtx(l, { family: { key: 'recurring-log-signature', role } });
    lane('famlane-0001');
    ranAgo('famlane-0001', 7 * H); // awaiting rows retire under the 6 h idle rule (review 2026-10-21)
    tickets = [
      ticket('fama0000-1', { title: 'Recurring log signature aaaaaaaa', status: 'awaiting_verification', context: fam('lead', 'famlane-0001') }),
      ticket('famb0000-2', { title: 'Recurring log signature bbbbbbbb', status: 'in_progress', context: fam('member', 'famlane-0001') }),
    ];
    await drainOpenTicketsToLane();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    // The last rider closes: the lane retires (the awaiting lead did not hold it).
    byId('famb0000-2').status = 'awaiting_verification';
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['famlane-0001']);
  });
});

describe('B3 — the closed-lane window no longer starves', () => {
  function archivedRows(n: number): Row[] {
    return Array.from({ length: n }, (_, i) => ticket(`arch${String(i).padStart(4, '0')}-x`, {
      status: 'done', context: laneCtx(`arch-lane-${i}`, { laneArchivedAt: new Date(Date.now() - i * MIN).toISOString() }), updatedAt: new Date(Date.now() - i * MIN),
    }));
  }

  it('150 already-archived closed lane rows NEWER than one unarchived row: the unarchived lane is still archived (pre-fix take:100 hid it)', async () => {
    lane('starved-lane');
    ranAgo('starved-lane', 4 * H);
    tickets = [...archivedRows(150), ticket('starved0-1', { status: 'done', context: laneCtx('starved-lane'), updatedAt: new Date(Date.now() - 3 * H) })];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['starved-lane']);
    expect(byId('starved0-1').context.laneArchivedLane).toBe('starved-lane');
    expect(lastQueueMeta().closedScanRows).toBe(151);
  });

  it('the scan PAGES: 450 archived rows newer than the unarchived one are read in 3 KEYSET pages of 200 (fifth review: each page starts after the previous page\'s last (updatedAt, id) — never OFFSET) and the lane is archived', async () => {
    lane('deep-lane-01');
    ranAgo('deep-lane-01', 9 * H);
    tickets = [...archivedRows(450), ticket('deeprow0-1', { status: 'done', context: laneCtx('deep-lane-01'), updatedAt: new Date(Date.now() - 8 * H) })];
    // the keyset anchor = the previous page's LAST row in (updatedAt desc, id desc) order (read before the stamp re-bumps one)
    const order = [...tickets].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1)).map((t) => ({ id: t.id, updatedAt: new Date(t.updatedAt) }));
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['deep-lane-01']);
    expect(lastQueueMeta().closedScanRows).toBe(451);
    const calls = closedScanCalls();
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c[0].skip)).toEqual([undefined, undefined, undefined]);
    expect(calls[0][0].where.OR).toBeUndefined();
    for (const [page, c] of calls.slice(1).entries()) {
      const anchor = order[(page + 1) * CLOSED_LANE_SCAN_PAGE - 1];
      expect(c[0].where.OR).toEqual([
        { updatedAt: { lt: anchor.updatedAt } },
        { updatedAt: { gte: anchor.updatedAt, lte: anchor.updatedAt }, id: { lt: anchor.id } },
      ]);
    }
    for (const c of calls) {
      expect(c[0].take).toBe(CLOSED_LANE_SCAN_PAGE);
      expect(c[0].orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
      expect(c[0].where.context).toEqual({ path: ['dispatchMode'], equals: 'ticket_lane' });
      expect(c[0].where.status.in).toEqual([...CLOSED_STATUSES, 'awaiting_verification']);
      expect(c[0].select).toEqual({ id: true, status: true, context: true, updatedAt: true });
    }
  });

  it('a closed lane row 20 days old is archived (the 7-day window was too short); 31 days is out of the window', async () => {
    lane('old-lane-020');
    lane('old-lane-031');
    ranAgo('old-lane-020', 20 * DAY);
    tickets = [
      ticket('old00020-1', { status: 'done', context: laneCtx('old-lane-020'), updatedAt: new Date(Date.now() - 20 * DAY) }),
      ticket('old00031-1', { status: 'done', context: laneCtx('old-lane-031'), updatedAt: new Date(Date.now() - 31 * DAY) }),
    ];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['old-lane-020']);
  });

  it('a stale laneArchivedLane naming an EARLIER lane reads unarchived — the current lane is archived and the stamp re-points at it', async () => {
    lane('second-lane1');
    ranAgo('second-lane1', 5 * H);
    tickets = [ticket('stale000-1', { status: 'done', context: laneCtx('second-lane1', { laneArchivedAt: new Date(Date.now() - 2 * DAY).toISOString(), laneArchivedLane: 'first-lane-1' }) })];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['second-lane1']);
    expect(byId('stale000-1').context.laneArchivedLane).toBe('second-lane1');
  });

  it('a legacy stamp with no laneArchivedLane is trusted — the row is never re-touched', async () => {
    lane('legacy-lane1');
    tickets = [ticket('legacy00-1', { status: 'done', context: laneCtx('legacy-lane1', { laneArchivedAt: new Date(Date.now() - DAY).toISOString() }) })];
    await drainOpenTicketsToLane();
    expect(mockArchiveChat).not.toHaveBeenCalled();
  });
});

describe('B2 — a reopen never inherits the previous lane\'s archive stamp', () => {
  it('ACCEPTANCE: a reopened (open) row carrying the old stamp spawns a lane WITHOUT it, and the next close archives the NEW lane', async () => {
    lane('reopen-old-1', { archivedAt: new Date(Date.now() - DAY) });
    ranAgo('reopen-old-1', DAY);
    tickets = [ticket('reopen00-1', { status: 'open', context: laneCtx('reopen-old-1', { laneArchivedAt: new Date(Date.now() - DAY).toISOString(), laneArchivedLane: 'reopen-old-1', reopenCount: 1 }) })];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    const ctx = byId('reopen00-1').context;
    const newLane = ctx.dispatchedTo as string;
    expect(newLane).not.toBe('reopen-old-1');
    expect(ctx).not.toHaveProperty('laneArchivedAt');
    expect(ctx).not.toHaveProperty('laneArchivedLane');
    expect(ctx.previousLanes).toContain('reopen-old-1');
    // The new lane ships the fix and its ticket closes: the lane is archived.
    byId('reopen00-1').status = 'done';
    await drainOpenTicketsToLane();
    expect(archivedIds()).toContain(newLane);
    expect(byId('reopen00-1').context.laneArchivedLane).toBe(newLane);
  });

  it('a family member\'s row is stripped too', async () => {
    const stamp = { laneArchivedAt: new Date(Date.now() - DAY).toISOString(), laneArchivedLane: 'gone-lane-01' };
    tickets = [
      ticket('famlead0-1', { title: 'Recurring log signature cccccccc', source: 'agent', context: { ...stamp } }),
      ticket('fammemb0-2', { title: 'Recurring log signature dddddddd', source: 'agent', context: { ...stamp } }),
    ];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(byId('fammemb0-2').context.family).toMatchObject({ role: 'member' });
    for (const id of ['famlead0-1', 'fammemb0-2']) {
      expect(byId(id).context).not.toHaveProperty('laneArchivedAt');
      expect(byId(id).context).not.toHaveProperty('laneArchivedLane');
    }
  });

  it('B2c: a VERIFIER-reopened row whose lane is archived re-dispatches on the SAME drain (no 6 h / 8 h windows, no two-probe gate)', async () => {
    lane('shipped-lane', { archivedAt: new Date(Date.now() - 2 * H) });
    ranAgo('shipped-lane', 2 * H);
    tickets = [ticket('verifier-1', { status: 'reopened', context: laneCtx('shipped-lane', { laneArchivedAt: new Date(Date.now() - 2 * H).toISOString(), laneArchivedLane: 'shipped-lane' }) })];
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(1);
    expect(mockStartCodingSession.mock.calls[0][0].prompt).toContain('verifier-1');
    const ctx = byId('verifier-1').context;
    expect(byId('verifier-1').status).toBe('in_progress');
    expect(ctx.previousLanes).toContain('shipped-lane');
    expect(ctx).not.toHaveProperty('laneArchivedAt');
  });

  it('B2c (review 2026-10-21): the archive STAMP alone does NOT re-dispatch — a stamped lane whose chat reads unarchived was RESTORED; a LIVE archived lane keeps its row too', async () => {
    lane('stamped-lane', { updatedAt: new Date(Date.now() - 40 * MIN) }); // restored by its owner
    ranAgo('stamped-lane', 2 * H);
    lane('liveagain-01', { archivedAt: new Date(Date.now() - H) });
    runs.push({ sessionId: 'liveagain-01', status: 'running', createdAt: new Date(Date.now() - 5 * MIN), updatedAt: new Date() });
    tickets = [
      ticket('stamped0-1', { status: 'reopened', context: laneCtx('stamped-lane', { laneArchivedAt: new Date(Date.now() - 2 * H).toISOString(), laneArchivedLane: 'stamped-lane' }) }),
      ticket('liveagn0-2', { status: 'reopened', context: laneCtx('liveagain-01', { laneArchivedAt: new Date(Date.now() - H).toISOString(), laneArchivedLane: 'liveagain-01' }) }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(0);
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(byId('stamped0-1').context.dispatchedTo).toBe('stamped-lane');
    expect(byId('liveagn0-2').context.dispatchedTo).toBe('liveagain-01');
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(chats.get('stamped-lane')!.archivedAt).toBeNull();
  });

  it('an in_progress row whose lane is archived is UNCHANGED (an owner-archived lane never auto-respawns inside the idle window)', async () => {
    lane('ownerarch-01', { archivedAt: new Date(Date.now() - 30 * MIN) });
    ranAgo('ownerarch-01', H);
    tickets = [ticket('ownerarc-1', { status: 'in_progress', context: laneCtx('ownerarch-01', { dispatchedAt: new Date(Date.now() - 2 * H).toISOString() }) })];
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(0);
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(byId('ownerarc-1').context.dispatchedTo).toBe('ownerarch-01');
  });
});

describe('B4 + B5 — orphaned previous lanes are retired', () => {
  /** An open row held out of dispatch (autoDispatch false) that names previous lanes — the undispatchedContext shape. */
  const holder = (id: string, previousLanes: string[], over: Partial<Row> = {}) => ticket(id, {
    adminNote: 'Waiting for a free ticket lane — at most 4 run at once; it starts automatically when one frees up.',
    context: { previousLanes, autoDispatch: false }, ...over,
  });

  it('ACCEPTANCE: an idle orphaned previous lane is archived; a live one, one idle < 6 h and the standing lane are not', async () => {
    lane('orphan-lane1'); ranAgo('orphan-lane1', 7 * H);
    lane('orphan-live1'); runs.push({ sessionId: 'orphan-live1', status: 'running', createdAt: new Date(Date.now() - H), updatedAt: new Date() });
    lane('orphan-young'); ranAgo('orphan-young', 2 * H);
    ranAgo(STANDING, 9 * H);
    tickets = [holder('holder00-1', ['orphan-lane1', 'orphan-live1', 'orphan-young', STANDING])];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['orphan-lane1']);
    expect(lastQueueMeta()).toMatchObject({ archivedPrevious: 1 });
  });

  it('a lane that NEVER ran is aged by its creation time', async () => {
    lane('neverran-old', { createdAt: new Date(Date.now() - 7 * H) });
    lane('neverran-new', { createdAt: new Date(Date.now() - 2 * H) });
    tickets = [holder('holder00-2', ['neverran-old', 'neverran-new'])];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['neverran-old']);
  });

  it('a lane another row is CURRENTLY dispatched to is never swept — in the scan, or beyond it (the DB-wide guard)', async () => {
    lane('shared-lane1'); ranAgo('shared-lane1', 7 * H);
    lane('hidden-lane1'); ranAgo('hidden-lane1', 7 * H);
    tickets = [
      holder('holder00-3', ['shared-lane1', 'hidden-lane1']),
      ticket('inscan00-4', { status: 'in_progress', context: laneCtx('shared-lane1', { dispatchedAt: new Date(Date.now() - 7 * H).toISOString() }) }),
      // A not-closed row no scan reads (plain 'queued', no family flag) still binds its lane.
      ticket('hidden00-5', { status: 'queued', context: laneCtx('hidden-lane1') }),
    ];
    await drainOpenTicketsToLane();
    expect(archivedIds()).not.toContain('shared-lane1');
    expect(archivedIds()).not.toContain('hidden-lane1');
  });

  it('an enabled OWNER-armed schedule (promptSetBy user / NULL) keeps a previous lane; a machine-armed one is paused and the lane archived', async () => {
    lane('owner-sched1'); ranAgo('owner-sched1', 7 * H); sched('s-owner', 'owner-sched1', 'user');
    lane('null-sched01'); ranAgo('null-sched01', 7 * H); sched('s-null', 'null-sched01', null);
    lane('mach-sched01'); ranAgo('mach-sched01', 7 * H); sched('s-mach', 'mach-sched01', 'machine', 'once');
    tickets = [holder('holder00-6', ['owner-sched1', 'null-sched01', 'mach-sched01'])];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['mach-sched01']);
    expect(schedules.get('s-mach')!.enabled).toBe(false);
    expect(schedules.get('s-owner')!.enabled).toBe(true);
    expect(schedules.get('s-null')!.enabled).toBe(true);
  });

  it('the per-drain cap holds: 12 orphans → 10 archived, the other 2 on the next drain', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `capped-lane-${String(i).padStart(2, '0')}`);
    for (const id of ids) { lane(id); ranAgo(id, 7 * H); }
    tickets = [holder('holder00-7', ids.slice(0, 5)), holder('holder00-8', ids.slice(5))];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toHaveLength(PREVIOUS_LANE_ARCHIVE_MAX_PER_DRAIN);
    expect(lastQueueMeta().archivedPrevious).toBe(10);
    await drainOpenTicketsToLane();
    expect(new Set(archivedIds())).toEqual(new Set(ids));
  });

  it('B5: a FAILED superseded-lane archive at re-dispatch is retried by the next drain\'s sweep', async () => {
    lane('superseded-1'); ranAgo('superseded-1', 7 * H);
    tickets = [ticket('redisp00-1', { status: 'open', context: laneCtx('superseded-1') })];
    mockArchiveChat.mockRejectedValueOnce(Object.assign(new Error('transient'), { statusCode: 500 }));
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(archivedIds()).toEqual(['superseded-1']); // the one attempt — refused
    expect(chats.get('superseded-1')!.archivedAt).toBeNull();
    expect(byId('redisp00-1').context.previousLanes).toEqual(['superseded-1']);
    await drainOpenTicketsToLane();
    expect(chats.get('superseded-1')!.archivedAt).toBeTruthy();
  });

  it('the exact idle re-check: a lane whose newest run fell outside the capped run read is NOT archived', async () => {
    lane('truncated-01');
    ranAgo('truncated-01', 9 * H);
    ranAgo('truncated-01', 1 * H); // the newest run — the capped oldest-first read drops it
    tickets = [holder('holder0-10', ['truncated-01'])];
    const faithful = mockPrisma.agentRun.findMany.getMockImplementation();
    mockPrisma.agentRun.findMany.mockImplementation(async (args: any) => (Array.isArray(args.where.OR)
      ? faithful(args)
      : runs.filter((r) => args.where.sessionId.in.includes(r.sessionId) && r.updatedAt < new Date(Date.now() - 6 * H))));
    try {
      await drainOpenTicketsToLane();
      expect(mockArchiveChat).not.toHaveBeenCalled();
    } finally {
      mockPrisma.agentRun.findMany.mockImplementation(faithful);
    }
  });

  it('FAIL CLOSED: a guard read failure archives nothing this drain', async () => {
    lane('guardfail-01'); ranAgo('guardfail-01', 7 * H);
    tickets = [holder('holder00-9', ['guardfail-01'])];
    mockPrisma.codingSchedule.findMany.mockRejectedValueOnce(new Error('db down'));
    await drainOpenTicketsToLane();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['guardfail-01']);
  });
});

describe('B6 — a satellite stuck \'running\' no longer blocks the archive', () => {
  it('ACCEPTANCE: a closed ticket\'s lane whose satellite is stuck running (no live run) is healed, then archived', async () => {
    lane('stuckrun-001', { satellite: 'running' });
    ranAgo('stuckrun-001', 3 * H, 'interrupted');
    tickets = [ticket('stuckrun-1', { status: 'done', context: laneCtx('stuckrun-001') })];
    await drainOpenTicketsToLane();
    expect(mockHealOrphanedRunningSession).toHaveBeenCalledWith('stuckrun-001');
    const healOrder = mockHealOrphanedRunningSession.mock.invocationCallOrder[0];
    expect(healOrder).toBeLessThan(mockArchiveChat.mock.invocationCallOrder[0]);
    expect(chats.get('stuckrun-001')!.archivedAt).toBeTruthy();
    expect(byId('stuckrun-1').context.laneArchivedLane).toBe('stuckrun-001');
    expect(lastQueueMeta()).toMatchObject({ healedRunning: 1, archived: 1 });
  });

  it('a ready satellite is never sent to the heal', async () => {
    lane('readysat-001', { satellite: 'ready' });
    tickets = [ticket('readysat-1', { status: 'done', context: laneCtx('readysat-001') })];
    await drainOpenTicketsToLane();
    expect(mockHealOrphanedRunningSession).not.toHaveBeenCalled();
    expect(archivedIds()).toEqual(['readysat-001']);
  });

  it.each(['owned', 'locked'])('heal says %s: nothing healed, archiveChat refuses, never stamped — and the 30-min stuck backstop releases the slot with ONE notice', async (verdict) => {
    process.env.TICKET_LANE_CONCURRENCY = '1';
    process.env.TICKET_LANE_CONCURRENCY_NIGHT = '1';
    mockHealOrphanedRunningSession.mockResolvedValue(verdict);
    lane('ownedrun-001', { satellite: 'running' });
    tickets = [
      ticket('ownedrun-1', { status: 'done', context: laneCtx('ownedrun-001') }),
      ticket('waitslot-2', { priority: 2 }),
    ];
    await drainOpenTicketsToLane();
    expect(mockHealOrphanedRunningSession).toHaveBeenCalledWith('ownedrun-001');
    expect(chats.get('ownedrun-001')!.archivedAt).toBeNull();
    expect(byId('ownedrun-1').context.laneArchivedAt).toBeUndefined();
    expect(lastQueueMeta().healedRunning).toBe(0);
    kv.set('ticket-dispatch:lane-archive-stuck:ownedrun-001', String(Date.now() - LANE_ARCHIVE_STUCK_MS - MIN));
    await drainOpenTicketsToLane();
    const notices = mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'attention_needed');
    expect(notices).toHaveLength(1);
    expect(notices[0][3]).toMatchObject({ reason: 'lane_archive_stuck', laneId: 'ownedrun-001' });
  });
});

describe('review fixes (2026-10-21)', () => {
  /** An open row held out of dispatch that names previous lanes (the undispatchedContext shape). */
  const holderRow = (id: string, previousLanes: string[]) => ticket(id, {
    adminNote: 'Waiting for a free ticket lane — at most 4 run at once; it starts automatically when one frees up.',
    context: { previousLanes, autoDispatch: false },
  });
  const stuckNotices = () => mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'attention_needed' && c[3]?.reason === 'lane_archive_stuck');

  describe('pure helpers', () => {
    it('laneIdleClock: the later of run activity and the chat row write (a restore); createdAt only when neither is known', () => {
      expect(laneIdleClock({ lastActivityAt: 100, updatedAt: 300, createdAt: 50 })).toBe(300);
      expect(laneIdleClock({ lastActivityAt: 400, updatedAt: 300, createdAt: 50 })).toBe(400);
      expect(laneIdleClock({ lastActivityAt: null, updatedAt: 300, createdAt: 50 })).toBe(300);
      expect(laneIdleClock({ lastActivityAt: null, updatedAt: null, createdAt: 50 })).toBe(50);
      expect(laneIdleClock({ lastActivityAt: null, updatedAt: null, createdAt: null })).toBeNull();
    });

    it('closedRowNewlyReached: awaiting_verification, or a closed row past the pre-fix 7-day window', () => {
      const now = Date.now();
      expect(closedRowNewlyReached({ status: 'awaiting_verification', updatedAt: new Date(now) }, now)).toBe(true);
      expect(closedRowNewlyReached({ status: 'done', updatedAt: new Date(now - 6 * DAY) }, now)).toBe(false);
      expect(closedRowNewlyReached({ status: 'done', updatedAt: new Date(now - 8 * DAY) }, now)).toBe(true);
      expect(closedRowNewlyReached({ status: 'done' }, now)).toBe(false);
    });

    it('memberPreviousLanes: a re-homed lane row appends its old lane (deduped, last 5); anything else changes nothing', () => {
      expect(memberPreviousLanes({ dispatchMode: 'ticket_lane', dispatchedTo: 'OLD' }, 'NEW', 'STAND')).toEqual(['OLD']);
      expect(memberPreviousLanes({ dispatchMode: 'ticket_lane', dispatchedTo: 'OLD', previousLanes: ['a', 'b', 'c', 'd', 'e'] }, 'NEW', 'STAND')).toEqual(['b', 'c', 'd', 'e', 'OLD']);
      expect(memberPreviousLanes({ dispatchMode: 'ticket_lane', dispatchedTo: 'OLD', previousLanes: ['OLD'] }, 'NEW', 'STAND')).toBeNull();
      expect(memberPreviousLanes({ dispatchMode: 'ticket_lane', dispatchedTo: 'NEW' }, 'NEW', 'STAND')).toBeNull();
      expect(memberPreviousLanes({ dispatchMode: 'ticket_lane', dispatchedTo: 'STAND' }, 'NEW', 'STAND')).toBeNull();
      expect(memberPreviousLanes({ dispatchedTo: 'OLD' }, 'NEW', 'STAND')).toBeNull(); // not a lane row
      expect(memberPreviousLanes({}, 'NEW', 'STAND')).toBeNull();
    });
  });

  describe('#1 — the house-rule guards on every lane the commit newly reaches', () => {
    it('R2: an awaiting lane with an OWNER turn 5 min ago and owner-armed schedules (user / NULL) is untouched — nothing paused, never archived, never stamped', async () => {
      lane('await-own-01');
      ranAgo('await-own-01', 5 * MIN);
      sched('s-user', 'await-own-01', 'user');
      sched('s-null', 'await-own-01', null);
      tickets = [ticket('awaitown-1', { status: 'awaiting_verification', context: laneCtx('await-own-01') })];
      await drainOpenTicketsToLane();
      await drainOpenTicketsToLane();
      expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalled();
      expect(mockArchiveChat).not.toHaveBeenCalled();
      expect(schedules.get('s-user')!.enabled).toBe(true);
      expect(schedules.get('s-null')!.enabled).toBe(true);
      expect(chats.get('await-own-01')!.archivedAt).toBeNull();
      expect(byId('awaitown-1').context.laneArchivedAt).toBeUndefined();
    });

    it('the recent-run guard: an awaiting lane whose last run (a human turn) ended 5 min ago is kept; once it is 7 h idle it is archived', async () => {
      lane('await-run-01');
      ranAgo('await-run-01', 5 * MIN);
      tickets = [ticket('awaitrun-1', { status: 'awaiting_verification', context: laneCtx('await-run-01') })];
      await drainOpenTicketsToLane();
      expect(mockArchiveChat).not.toHaveBeenCalled();
      runs = [];
      ranAgo('await-run-01', 7 * H);
      await drainOpenTicketsToLane();
      expect(archivedIds()).toEqual(['await-run-01']);
      expect(byId('awaitrun-1').context.laneArchivedLane).toBe('await-run-01');
    });

    it('the recent-run guard is the EXACT DB re-check: a run the capped state read missed still keeps the lane', async () => {
      lane('await-cut-01');
      ranAgo('await-cut-01', 19 * H);
      ranAgo('await-cut-01', 20 * MIN); // the newest run — a capped oldest-first read would drop it
      tickets = [ticket('awaitcut-1', { status: 'awaiting_verification', context: laneCtx('await-cut-01') })];
      const faithful = mockPrisma.agentRun.findMany.getMockImplementation();
      mockPrisma.agentRun.findMany.mockImplementation(async (args: any) => (Array.isArray(args.where.OR)
        ? faithful(args)
        : runs.filter((r) => args.where.sessionId.in.includes(r.sessionId) && r.updatedAt < new Date(Date.now() - 6 * H))));
      try {
        await drainOpenTicketsToLane();
        expect(mockArchiveChat).not.toHaveBeenCalled();
      } finally {
        mockPrisma.agentRun.findMany.mockImplementation(faithful);
      }
    });

    it('a closed row PAST the old 7-day window gets the same rules: a run 1 h ago keeps its lane', async () => {
      lane('old-busy-020');
      ranAgo('old-busy-020', H);
      tickets = [ticket('oldbusy0-1', { status: 'done', context: laneCtx('old-busy-020'), updatedAt: new Date(Date.now() - 20 * DAY) })];
      await drainOpenTicketsToLane();
      expect(mockArchiveChat).not.toHaveBeenCalled();
      expect(byId('oldbusy0-1').context.laneArchivedAt).toBeUndefined();
    });

    it('FAIL CLOSED: a recent-run guard read failure keeps every awaiting lane this drain; the next drain archives it', async () => {
      lane('await-fail-1');
      ranAgo('await-fail-1', 19 * H);
      tickets = [ticket('awaitfai-1', { status: 'awaiting_verification', context: laneCtx('await-fail-1') })];
      const faithful = mockPrisma.agentRun.findMany.getMockImplementation();
      mockPrisma.agentRun.findMany.mockImplementation(async (args: any) => {
        if (Array.isArray(args.where.OR)) throw new Error('db down');
        return faithful(args);
      });
      try {
        await drainOpenTicketsToLane();
        expect(mockArchiveChat).not.toHaveBeenCalled();
      } finally {
        mockPrisma.agentRun.findMany.mockImplementation(faithful);
      }
      await drainOpenTicketsToLane();
      expect(archivedIds()).toEqual(['await-fail-1']);
    });

    it('the OWNER-ARMED schedule guard holds on every automatic caller: an awaiting lane, a done lane inside the old window and the superseded lane at re-dispatch are never paused or archived — a machine-armed sibling is', async () => {
      lane('own-await-01'); ranAgo('own-await-01', 19 * H); sched('s-a', 'own-await-01', 'user');
      lane('own-done-001'); ranAgo('own-done-001', 3 * H); sched('s-d', 'own-done-001', null);
      lane('own-super-01'); ranAgo('own-super-01', 9 * H); sched('s-s', 'own-super-01', 'user');
      lane('mach-done-01'); ranAgo('mach-done-01', 3 * H); sched('s-m', 'mach-done-01', 'machine');
      tickets = [
        ticket('ownawai0-1', { status: 'awaiting_verification', context: laneCtx('own-await-01') }),
        ticket('owndone0-2', { status: 'done', context: laneCtx('own-done-001') }),
        ticket('ownsupr0-3', { status: 'open', context: laneCtx('own-super-01') }),
        ticket('machdon0-4', { status: 'done', context: laneCtx('mach-done-01') }),
      ];
      await drainOpenTicketsToLane();
      expect(archivedIds()).toEqual(['mach-done-01']);
      expect(schedules.get('s-m')!.enabled).toBe(false);
      for (const id of ['s-a', 's-d', 's-s']) expect(schedules.get(id)!.enabled).toBe(true);
      expect(mockPauseSchedulesForLaneArchive.mock.calls.map((c) => c[0])).toEqual(['mach-done-01']);
      for (const l of ['own-await-01', 'own-done-001', 'own-super-01']) expect(chats.get(l)!.archivedAt).toBeNull();
      expect(byId('owndone0-2').context.laneArchivedAt).toBeUndefined();
      // The superseded lane still hands its ticket to a fresh lane (the
      // re-dispatch is not blocked — only the old lane's archive is).
      expect(byId('ownsupr0-3').context.previousLanes).toContain('own-super-01');
    });

    it('a done lane kept for its owner-armed schedule is not "stuck" — no backstop notice even past the 30-min window', async () => {
      lane('own-stuck-01'); ranAgo('own-stuck-01', 3 * H); sched('s-o', 'own-stuck-01', 'user');
      tickets = [ticket('ownstuc0-1', { status: 'done', context: laneCtx('own-stuck-01') })];
      kv.set('ticket-dispatch:lane-archive-stuck:own-stuck-01', String(Date.now() - LANE_ARCHIVE_STUCK_MS - MIN));
      await drainOpenTicketsToLane();
      expect(mockArchiveChat).not.toHaveBeenCalled();
      expect(stuckNotices()).toHaveLength(0);
    });

    it('FAIL CLOSED: an owner-schedule guard read failure archives nothing; the next drain archives the lane', async () => {
      lane('own-fail-001'); ranAgo('own-fail-001', 3 * H);
      tickets = [ticket('ownfail0-1', { status: 'done', context: laneCtx('own-fail-001') })];
      mockPrisma.codingSchedule.findMany.mockRejectedValueOnce(new Error('db down'));
      await drainOpenTicketsToLane();
      expect(mockArchiveChat).not.toHaveBeenCalled();
      await drainOpenTicketsToLane();
      expect(archivedIds()).toEqual(['own-fail-001']);
    });
  });

  describe('#2 — a lane the owner restored is not re-archived', () => {
    it('R1 (second review fixer): a superseded lane the owner RESTORED (archiveChat wrote the restore marker) is kept — 7 h later and 30 days later; a restore is permanent, never "6 h of activity"', async () => {
      lane('restored-001', { updatedAt: new Date(Date.now() - 10 * MIN) });
      ranAgo('restored-001', 3 * DAY);
      restoreMarkers.add('restored-001');
      lane('cur-lane-001', { archivedAt: new Date(Date.now() - 2 * DAY) });
      tickets = [ticket('closedr0-1', {
        status: 'done', updatedAt: new Date(Date.now() - 2 * DAY),
        context: laneCtx('cur-lane-001', { laneArchivedAt: new Date(Date.now() - 2 * DAY).toISOString(), laneArchivedLane: 'cur-lane-001', previousLanes: ['restored-001'] }),
      })];
      await drainOpenTicketsToLane();
      expect(archivedIds()).not.toContain('restored-001');
      chats.get('restored-001')!.updatedAt = new Date(Date.now() - 7 * H);
      await drainOpenTicketsToLane();
      expect(archivedIds()).not.toContain('restored-001');
      chats.get('restored-001')!.updatedAt = new Date(Date.now() - 30 * DAY);
      await drainOpenTicketsToLane();
      expect(archivedIds()).not.toContain('restored-001');
      expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalledWith('restored-001', expect.anything());
    });

    it('R1b-unmarked: a chat row write alone (no restore marker) still holds the sweep for the idle window, then the lane is archived', async () => {
      lane('bumped-0001', { updatedAt: new Date(Date.now() - 10 * MIN) });
      ranAgo('bumped-0001', 3 * DAY);
      lane('cur-lane-002', { archivedAt: new Date(Date.now() - 2 * DAY) });
      tickets = [ticket('closedr0-2', {
        status: 'done', updatedAt: new Date(Date.now() - 2 * DAY),
        context: laneCtx('cur-lane-002', { laneArchivedAt: new Date(Date.now() - 2 * DAY).toISOString(), laneArchivedLane: 'cur-lane-002', previousLanes: ['bumped-0001'] }),
      })];
      await drainOpenTicketsToLane();
      expect(archivedIds()).not.toContain('bumped-0001');
      chats.get('bumped-0001')!.updatedAt = new Date(Date.now() - 7 * H);
      await drainOpenTicketsToLane();
      expect(archivedIds()).toContain('bumped-0001');
    });

    it('R1b-audited (third review 2026-10-22): a restore made BEFORE the marker shipped (a chat.restore Activity row newer than the last chat.archive, no marker) keeps the lane past the idle window — the drain reads the restore audit like lane-retire', async () => {
      lane('audited-0001', { updatedAt: new Date(Date.now() - 7 * H) });
      ranAgo('audited-0001', 3 * DAY);
      activities.push(
        { userId: 'owner-1', resource: 'platform', action: 'chat.archive', createdAt: new Date(Date.now() - 2 * DAY), metadata: { chatId: 'audited-0001' } },
        { userId: 'owner-1', resource: 'platform', action: 'chat.restore', createdAt: new Date(Date.now() - 7 * H), metadata: { chatId: 'audited-0001' } },
      );
      lane('cur-lane-003', { archivedAt: new Date(Date.now() - 2 * DAY) });
      tickets = [ticket('closedr0-3', {
        status: 'done', updatedAt: new Date(Date.now() - 2 * DAY),
        context: laneCtx('cur-lane-003', { laneArchivedAt: new Date(Date.now() - 2 * DAY).toISOString(), laneArchivedLane: 'cur-lane-003', previousLanes: ['audited-0001'] }),
      })];
      await drainOpenTicketsToLane();
      expect(archivedIds()).not.toContain('audited-0001');
      expect(mockPrisma.activity.findMany).toHaveBeenCalled();
      // An archive AFTER that restore (the owner archived it again, then a restore was undone) no longer counts.
      activities.push({ userId: 'owner-1', resource: 'platform', action: 'chat.archive', createdAt: new Date(Date.now() - 6 * H), metadata: { chatId: 'audited-0001' } });
      await drainOpenTicketsToLane();
      expect(archivedIds()).toContain('audited-0001');
    });

    it('R1b: a verifier-reopened row whose archived lane the owner restored is NOT re-dispatched and the restored chat is not archived', async () => {
      lane('await-rest-1', { updatedAt: new Date(Date.now() - 2 * MIN) });
      ranAgo('await-rest-1', 40 * MIN);
      tickets = [ticket('awrest00-1', { status: 'reopened', context: laneCtx('await-rest-1', { laneArchivedAt: new Date(Date.now() - DAY).toISOString(), laneArchivedLane: 'await-rest-1' }) })];
      await drainOpenTicketsToLane();
      expect(mockStartCodingSession).not.toHaveBeenCalled();
      expect(mockArchiveChat).not.toHaveBeenCalled();
      expect(chats.get('await-rest-1')!.archivedAt).toBeNull();
    });
  });

  describe('#3 — an awaiting row is not a closed ticket', () => {
    it('R3: an awaiting lane still LIVE past the 30-min window frees its slot, but is never paused, archived or noticed; no awaiting row completes its ledger task (a done row does)', async () => {
      process.env.TICKET_LANE_CONCURRENCY = '1';
      process.env.TICKET_LANE_CONCURRENCY_NIGHT = '1';
      mockHealOrphanedRunningSession.mockResolvedValue('owned');
      lane('await-live-2', { satellite: 'running' });
      runs = [{ sessionId: 'await-live-2', status: 'running', createdAt: new Date(Date.now() - 40 * MIN), updatedAt: new Date() }];
      sched('s-live', 'await-live-2', 'machine');
      kv.set('ticket-dispatch:lane-archive-stuck:await-live-2', String(Date.now() - LANE_ARCHIVE_STUCK_MS - MIN));
      lane('done-idle-02'); ranAgo('done-idle-02', 3 * H);
      tickets = [
        ticket('awlive00-1', { status: 'awaiting_verification', context: laneCtx('await-live-2') }),
        ticket('doneidl0-2', { status: 'done', context: laneCtx('done-idle-02') }),
        ticket('waitslot-3', { priority: 2 }),
      ];
      await drainOpenTicketsToLane();
      expect(mockPauseSchedulesForLaneArchive.mock.calls.map((c) => c[0])).not.toContain('await-live-2');
      expect(archivedIds()).toEqual(['done-idle-02']);
      expect(schedules.get('s-live')!.enabled).toBe(true);
      expect(mockHealOrphanedRunningSession).not.toHaveBeenCalledWith('await-live-2');
      expect(stuckNotices()).toHaveLength(0);
      expect(mockStartCodingSession).toHaveBeenCalledTimes(1); // the slot was freed for the waiting ticket
      expect(mockNoteTicketLaneClosed.mock.calls.map((c) => c[0])).toEqual(['doneidl0-2']);
    });

    it('an IDLE awaiting lane whose archive keeps failing past the window gets ONE notice that says "awaiting post-deploy verification", never "is closed"', async () => {
      mockHealOrphanedRunningSession.mockResolvedValue('locked');
      lane('await-lock-1', { satellite: 'running' });
      // (second review fixer: an 'interrupted' run is LIVE — the house rules keep that lane; this one's last run finished)
      ranAgo('await-lock-1', 7 * H, 'completed');
      kv.set('ticket-dispatch:lane-archive-stuck:await-lock-1', String(Date.now() - LANE_ARCHIVE_STUCK_MS - MIN));
      tickets = [ticket('awlock00-1', { status: 'awaiting_verification', context: laneCtx('await-lock-1') })];
      await drainOpenTicketsToLane();
      expect(chats.get('await-lock-1')!.archivedAt).toBeNull();
      const notices = stuckNotices();
      expect(notices).toHaveLength(1);
      expect(notices[0][2]).toContain('is awaiting post-deploy verification');
      expect(notices[0][2]).not.toContain('is closed');
    });
  });

  describe('#4 — the archive stamp never clobbers a verifier write', () => {
    it('R4: a verifier write that lands while the archive runs is kept — the stamp merges onto a FRESH read', async () => {
      lane('verif-lane-1');
      ranAgo('verif-lane-1', 19 * H);
      tickets = [ticket('verifrow-1', { status: 'awaiting_verification', context: laneCtx('verif-lane-1', { verification: { lastVerdict: 'waiting' } }) })];
      mockArchiveChat.mockImplementationOnce(async ({ chatId }: any) => {
        const r = byId('verifrow-1');
        r.context = { ...r.context, verification: { ...r.context.verification, firstLiveAt: '2026-10-21T19:00:00.000Z' } };
        chats.get(chatId)!.archivedAt = new Date();
        return { id: chatId, archived: true };
      });
      await drainOpenTicketsToLane();
      const ctx = byId('verifrow-1').context;
      expect(ctx.verification).toEqual({ lastVerdict: 'waiting', firstLiveAt: '2026-10-21T19:00:00.000Z' });
      expect(ctx.laneArchivedLane).toBe('verif-lane-1');
      expect(typeof ctx.laneArchivedAt).toBe('string');
      // The write is guarded by the fresh status.
      const stampWrite = (mockPrisma.userFeatureRequest.updateMany.mock.calls as Array<[any]>).find((c) => c[0].data?.context?.laneArchivedLane === 'verif-lane-1');
      expect(stampWrite![0].where).toEqual({ id: 'verifrow-1', status: 'awaiting_verification' });
    });

    it('a row re-pointed at another lane since the scan is not stamped; a failed re-read stamps from the snapshot', async () => {
      lane('moved-lane-1'); ranAgo('moved-lane-1', 3 * H);
      lane('snap-lane-01'); ranAgo('snap-lane-01', 3 * H);
      tickets = [
        ticket('movedrw0-1', { status: 'done', context: laneCtx('moved-lane-1') }),
        ticket('snaprow0-2', { status: 'done', context: laneCtx('snap-lane-01') }),
      ];
      mockArchiveChat.mockImplementation(async ({ chatId }: any) => {
        if (chatId === 'moved-lane-1') byId('movedrw0-1').context = { ...byId('movedrw0-1').context, dispatchedTo: 'other-lane-1' };
        chats.get(chatId)!.archivedAt = new Date();
        return { id: chatId, archived: true };
      });
      const faithfulFindUnique = mockPrisma.userFeatureRequest.findUnique.getMockImplementation();
      mockPrisma.userFeatureRequest.findUnique.mockImplementation(async (args: any) => {
        if (args.where.id === 'snaprow0-2') throw new Error('db hiccup');
        return faithfulFindUnique(args);
      });
      try {
        await drainOpenTicketsToLane();
      } finally {
        mockPrisma.userFeatureRequest.findUnique.mockImplementation(faithfulFindUnique);
      }
      expect(byId('movedrw0-1').context.laneArchivedAt).toBeUndefined();
      expect(byId('snaprow0-2').context.laneArchivedLane).toBe('snap-lane-01');
    });
  });

  describe('#5 — the sweep caps AFTER dropping archived lanes', () => {
    it('R5: 100 already-archived previous lanes ahead of an idle orphan do not hide it — archived on the FIRST drain', async () => {
      const gone = Array.from({ length: 100 }, (_, i) => `gone-prev-${String(i).padStart(3, '0')}`);
      for (const id of gone) lane(id, { archivedAt: new Date(Date.now() - DAY) });
      lane('late-orphan1');
      ranAgo('late-orphan1', 9 * H);
      lane('closed-lane1', { archivedAt: new Date(Date.now() - DAY) });
      tickets = [
        ...Array.from({ length: 20 }, (_, i) => holderRow(`holdr${String(i).padStart(3, '0')}-x`, gone.slice(i * 5, i * 5 + 5))),
        ticket('closorph-1', {
          status: 'done', updatedAt: new Date(Date.now() - DAY),
          context: laneCtx('closed-lane1', { laneArchivedAt: new Date(Date.now() - DAY).toISOString(), laneArchivedLane: 'closed-lane1', previousLanes: ['late-orphan1'] }),
        }),
      ];
      await drainOpenTicketsToLane();
      expect(archivedIds()).toEqual(['late-orphan1']);
      const prefilter = (mockPrisma.crossModelChat.findMany.mock.calls as Array<[any]>).find((c) => c[0].where.archivedAt === null);
      expect(prefilter![0].where.id.in).toHaveLength(101);
      expect(prefilter![0].select).toEqual({ id: true });
    });
  });

  describe('#6 — a family member re-homed off its own lane keeps it in previousLanes', () => {
    it('R6: the member\'s old dead lane lands in its previousLanes and the sweep archives it on the next drain', async () => {
      process.env.TICKET_RECLAIM_TWO_PROBE_DISABLED = '1';
      lane('deadsolo-001');
      ranAgo('deadsolo-001', 9 * H);
      tickets = [
        ticket('leadnew0-1', { title: 'Recurring log signature ffffffff', source: 'agent', priority: 5, createdAt: new Date() }),
        ticket('membold0-2', {
          title: 'Recurring log signature eeeeeeee', source: 'agent', priority: 1, status: 'in_progress', createdAt: new Date(Date.now() - 12 * H),
          context: laneCtx('deadsolo-001', { dispatchedAt: new Date(Date.now() - 10 * H).toISOString() }),
        }),
      ];
      await drainOpenTicketsToLane();
      expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
      const member = byId('membold0-2').context;
      expect(member.family).toMatchObject({ role: 'member', lead: 'leadnew0-1' });
      expect(member.dispatchedTo).toBe(byId('leadnew0-1').context.dispatchedTo);
      expect(member.previousLanes).toEqual(['deadsolo-001']);
      await drainOpenTicketsToLane();
      expect(chats.get('deadsolo-001')!.archivedAt).toBeTruthy();
    });
  });
});

describe('second review fixer (2026-10-21) — house rules, owner-armed chains, remembered pauses, untruncated lane states', () => {
  const holder = (id: string, previousLanes: string[], over: Partial<Row> = {}) => ticket(id, {
    adminNote: 'Waiting for a free ticket lane — at most 4 run at once; it starts automatically when one frees up.',
    context: { previousLanes, autoDispatch: false }, ...over,
  });

  it('REPRO (finding 2): a previous lane stalled on an open owner question with a live child session, restored by the owner, is NOT archived 7 h later — the answer is not re-routed and the child\'s hook is not paused', async () => {
    lane('stall-lane-1', { updatedAt: new Date(Date.now() - 7 * H) });
    ranAgo('stall-lane-1', 2 * DAY);
    ownerQuestions.push({ chatId: 'stall-lane-1', status: 'open' });
    childChats.push({ id: 'stall-kid-01', parentChatId: 'stall-lane-1', archivedAt: null });
    runs.push({ sessionId: 'stall-kid-01', status: 'running', createdAt: new Date(Date.now() - 20 * MIN), updatedAt: new Date() });
    restoreMarkers.add('stall-lane-1');
    tickets = [holder('stallhol-1', ['stall-lane-1'])];
    await drainOpenTicketsToLane();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalled();
  });

  it('every house rule keeps a previous lane on its own; the free one is archived with its machine schedules paused REMEMBERED (archiveRetire)', async () => {
    const rules: Array<[string, () => void]> = [
      ['hr-restored-1', () => restoreMarkers.add('hr-restored-1')],
      ['hr-question-1', () => ownerQuestions.push({ chatId: 'hr-question-1', status: 'open' })],
      ['hr-confirm-01', () => confirmations.push({ chatId: 'hr-confirm-01', status: 'pending', expiresAt: new Date(Date.now() + H) })],
      ['hr-todo-0001', () => openTodos.push({ assigneeChatId: 'hr-todo-0001', status: 'in_progress' })],
      ['hr-livekid-1', () => { childChats.push({ id: 'hr-kid', parentChatId: 'hr-livekid-1', archivedAt: null }); schedules.set('s-kid', { id: 's-kid', sessionId: 'hr-kid', kind: 'recurring', enabled: true, promptSetBy: 'machine' }); }],
      ['hr-human-001', () => userMessages.push({ chatId: 'hr-human-001', role: 'user', createdAt: new Date(Date.now() - 10 * DAY), metadata: null })],
      ['hr-shared-01', () => shareLinks.push({ chatId: 'hr-shared-01', isActive: true, expiresAt: null })],
      ['hr-pinned-01', () => pinnedChats.add('hr-pinned-01')],
      ['hr-webhook-1', () => chatWebhooks.push({ chatId: 'hr-webhook-1', isActive: true })],
      ['hr-hook-0001', () => eventHooks.push({ targetChatId: 'hr-hook-0001', enabled: true, createdVia: 'rest' })],
      ['hr-interr-01', () => runs.push({ sessionId: 'hr-interr-01', status: 'interrupted', createdAt: new Date(Date.now() - 9 * H), updatedAt: new Date(Date.now() - 8 * H) })],
    ];
    for (const [id, arm] of rules) { lane(id); ranAgo(id, 9 * H); arm(); }
    lane('hr-free-0001'); ranAgo('hr-free-0001', 9 * H); sched('s-free', 'hr-free-0001', 'machine');
    tickets = [holder('hrholder-1', [...rules.map(([id]) => id), 'hr-free-0001'])];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['hr-free-0001']);
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledWith('hr-free-0001', { archiveRetire: { detail: 'the ticket dispatcher retired this idle lane chat' } });
  });

  it('the same house rules gate an AWAITING lane (the newly-reached branch); a CLOSED ticket\'s own lane inside the old window pauses REMEMBERED too (third review 2026-10-22 — its own detail)', async () => {
    lane('aw-question1'); ranAgo('aw-question1', 19 * H); ownerQuestions.push({ chatId: 'aw-question1', status: 'open' });
    lane('aw-free-0001'); ranAgo('aw-free-0001', 19 * H); sched('s-aw', 'aw-free-0001', 'machine');
    lane('done-own-001'); ranAgo('done-own-001', 3 * H); sched('s-do', 'done-own-001', 'machine');
    tickets = [
      ticket('awquest0-1', { status: 'awaiting_verification', context: laneCtx('aw-question1') }),
      ticket('awfree00-2', { status: 'awaiting_verification', context: laneCtx('aw-free-0001') }),
      ticket('doneown0-3', { status: 'done', context: laneCtx('done-own-001') }),
    ];
    await drainOpenTicketsToLane();
    expect(archivedIds().sort()).toEqual(['aw-free-0001', 'done-own-001']);
    expect(byId('awquest0-1').context.laneArchivedAt).toBeUndefined();
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledWith('aw-free-0001', { archiveRetire: { detail: 'the ticket dispatcher retired this idle lane chat' } });
    expect(mockPauseSchedulesForLaneArchive.mock.calls.find((c) => c[0] === 'done-own-001')).toEqual(['done-own-001', { archiveRetire: { detail: CLOSED_TICKET_LANE_RETIRE_DETAIL } }]);
  });

  it('FAIL CLOSED: a failed house-rule read archives no previous / awaiting lane this drain; the next drain does', async () => {
    lane('hrfail-prev1'); ranAgo('hrfail-prev1', 9 * H);
    lane('hrfail-awai1'); ranAgo('hrfail-awai1', 19 * H);
    tickets = [holder('hrfailho-1', ['hrfail-prev1']), ticket('hrfailaw-2', { status: 'awaiting_verification', context: laneCtx('hrfail-awai1') })];
    mockPrisma.ownerQuestion.findMany.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down'));
    await drainOpenTicketsToLane();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    await drainOpenTicketsToLane();
    expect(archivedIds().sort()).toEqual(['hrfail-awai1', 'hrfail-prev1']);
  });

  it('owner-armed schedules include an owner-SUBSCRIBED digest and the renewal successors of an owner-armed root (stamped system); a machine root\'s successor is paused; a broken chain reads owner-armed', async () => {
    lane('own-sub-0001'); ranAgo('own-sub-0001', 9 * H);
    schedules.set('s-sub', { id: 's-sub', sessionId: 'own-sub-0001', kind: 'recurring', enabled: true, promptSetBy: 'system', ownerSubscribed: true });
    lane('own-chain-01'); ranAgo('own-chain-01', 9 * H);
    schedules.set('s-root', { id: 's-root', sessionId: 'own-chain-01', kind: 'recurring', enabled: false, promptSetBy: 'user' });
    schedules.set('s-gen1', { id: 's-gen1', sessionId: 'own-chain-01', kind: 'recurring', enabled: false, promptSetBy: 'system', renewedFromId: 's-root' });
    schedules.set('s-gen2', { id: 's-gen2', sessionId: 'own-chain-01', kind: 'recurring', enabled: true, promptSetBy: 'system', renewedFromId: 's-gen1' });
    lane('mach-chain-1'); ranAgo('mach-chain-1', 9 * H);
    schedules.set('s-mroot', { id: 's-mroot', sessionId: 'mach-chain-1', kind: 'recurring', enabled: false, promptSetBy: 'machine' });
    schedules.set('s-mgen1', { id: 's-mgen1', sessionId: 'mach-chain-1', kind: 'recurring', enabled: true, promptSetBy: 'system', renewedFromId: 's-mroot' });
    lane('broken-chn-1'); ranAgo('broken-chn-1', 9 * H);
    schedules.set('s-orphan', { id: 's-orphan', sessionId: 'broken-chn-1', kind: 'recurring', enabled: true, promptSetBy: 'system', renewedFromId: 's-gone' });
    tickets = [holder('chainhol-1', ['own-sub-0001', 'own-chain-01', 'mach-chain-1', 'broken-chn-1'])];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['mach-chain-1']);
    expect(schedules.get('s-mgen1')!.enabled).toBe(false);
    for (const id of ['s-sub', 's-gen2', 's-orphan']) expect(schedules.get(id)!.enabled).toBe(true);
  });

  it('REPRO (finding 7): 1200 runs on a closed, owner-guarded lane no longer truncate the lane states — the RUNNING lane keeps its slot, no second lane spawns past the cap, the kept lane is never re-dispatched', async () => {
    process.env.TICKET_LANE_CONCURRENCY = '1';
    process.env.TICKET_LANE_CONCURRENCY_NIGHT = '1';
    // A: in progress, its lane running (run 10 min ago, dispatched 1 h ago).
    lane('a-live-lane1');
    runs.push({ sessionId: 'a-live-lane1', status: 'running', createdAt: new Date(Date.now() - 10 * MIN), updatedAt: new Date() });
    // D: done 1 d ago, owner-armed schedule (never archived), 1200 OLDER runs.
    lane('d-guarded-l1'); sched('s-d-own', 'd-guarded-l1', 'user');
    for (let i = 0; i < 1200; i++) runs.push({ sessionId: 'd-guarded-l1', status: 'completed', createdAt: new Date(Date.now() - 3 * DAY + i * 1000), updatedAt: new Date(Date.now() - 3 * DAY + i * 1000 + 500) });
    tickets = [
      ticket('a-ticket-01', { status: 'in_progress', context: laneCtx('a-live-lane1', { dispatchedAt: new Date(Date.now() - H).toISOString() }) }),
      ticket('d-ticket-01', { status: 'done', updatedAt: new Date(Date.now() - DAY), context: laneCtx('d-guarded-l1') }),
      ticket('w-ticket-01', { priority: 2 }),
    ];
    // The faithful Postgres shape of the pre-fix read: createdAt ASC, take 1000 — the newest rows fall off.
    const faithful = mockPrisma.agentRun.findMany.getMockImplementation();
    mockPrisma.agentRun.findMany.mockImplementation(async (args: any) => {
      const rows = await faithful(args);
      if (args.orderBy?.createdAt === 'asc' && args.take) return [...rows].sort((x: any, y: any) => x.createdAt - y.createdAt).slice(0, args.take);
      return rows;
    });
    try {
      await drainOpenTicketsToLane();
      expect(lastQueueMeta()).toMatchObject({ occupiedLive: 1, spawned: 0 });
      expect(mockStartCodingSession).not.toHaveBeenCalled();
      // the run facts came from the per-(lane, status) aggregates
      expect(mockPrisma.agentRun.groupBy).toHaveBeenCalledWith(expect.objectContaining({ by: ['sessionId', 'status'], _count: { _all: true }, _min: { createdAt: true }, _max: { updatedAt: true } }));
      // a failed aggregate read degrades to the pre-fix capped read (the drain still runs)
      mockPrisma.agentRun.groupBy.mockRejectedValueOnce(new Error('db hiccup'));
      await drainOpenTicketsToLane();
      expect(lastQueueMeta()).toMatchObject({ spawned: expect.any(Number) });
    } finally {
      mockPrisma.agentRun.findMany.mockImplementation(faithful);
    }
  });
});

describe('third review (2026-10-22) — a lane the owner restored is never re-archived by the drain; bounded drains', () => {
  const lifecycleNotices = () => mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'attention_needed' && c[3]?.reason === 'lane_archive_stuck');
  /** A closed (done) ticket's own lane row, closed inside the pre-fix 7-day window. */
  const closedRow = (id: string, laneId: string, over: Partial<Row> = {}) => ticket(id, { status: 'done', context: laneCtx(laneId), updatedAt: new Date(Date.now() - 10 * MIN), ...over });

  it('REPRO S3 (major): restore → the defect recurs → the B2b reopen strip → a re-close while slots are full — the restored lane is NOT archived (the owner talked to it 12 min ago and its run ended 10 min ago); no stuck notice past 30 min', async () => {
    lane('restored-L01', { updatedAt: new Date(Date.now() - 12 * MIN) });
    ranAgo('restored-L01', 10 * MIN);
    restoreMarkers.add('restored-L01');
    userMessages.push({ chatId: 'restored-L01', role: 'user', createdAt: new Date(Date.now() - 12 * MIN), metadata: null });
    // The reopen stripped laneArchivedAt / laneArchivedLane (B2b) and kept dispatchedTo; the row closed again.
    tickets = [closedRow('reclose0-1', 'restored-L01', { context: laneCtx('restored-L01', { reopenCount: 1 }) })];
    await drainOpenTicketsToLane();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalled();
    expect(byId('reclose0-1').context.laneArchivedAt).toBeUndefined();
    // 40 minutes later the stuck clock is past the window: still kept, and never noticed as "could not be archived".
    kv.set('ticket-dispatch:lane-archive-stuck:restored-L01', String(Date.now() - LANE_ARCHIVE_STUCK_MS - 10 * MIN));
    await drainOpenTicketsToLane();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(lifecycleNotices()).toHaveLength(0);
  });

  it('a CLOSED ticket\'s own lane clears every retire-path house rule — the restore marker, a restore AUDIT row (pre-marker restore), a human in 14 d, an owner question, an open todo, a live child, a share link, a pinned title, an inbound integration each keep it; the free lane is archived', async () => {
    const rules: Array<[string, () => void]> = [
      ['cl-marker-01', () => restoreMarkers.add('cl-marker-01')],
      ['cl-audit-001', () => activities.push(
        { userId: 'owner-1', resource: 'platform', action: 'chat.archive', createdAt: new Date(Date.now() - 2 * DAY), metadata: { chatId: 'cl-audit-001' } },
        { userId: 'owner-1', resource: 'platform', action: 'chat.restore', createdAt: new Date(Date.now() - DAY), metadata: { chatId: 'cl-audit-001' } },
      )],
      ['cl-human-001', () => userMessages.push({ chatId: 'cl-human-001', role: 'user', createdAt: new Date(Date.now() - 3 * DAY), metadata: null })],
      ['cl-question1', () => ownerQuestions.push({ chatId: 'cl-question1', status: 'open' })],
      ['cl-todo-0001', () => openTodos.push({ assigneeChatId: 'cl-todo-0001', status: 'pending' })],
      ['cl-livekid-1', () => { childChats.push({ id: 'cl-kid', parentChatId: 'cl-livekid-1', archivedAt: null }); runs.push({ sessionId: 'cl-kid', status: 'running', createdAt: new Date(Date.now() - MIN), updatedAt: new Date() }); }],
      ['cl-shared-01', () => shareLinks.push({ chatId: 'cl-shared-01', isActive: true, expiresAt: null })],
      ['cl-pinned-01', () => pinnedChats.add('cl-pinned-01')],
      ['cl-webhook-1', () => chatWebhooks.push({ chatId: 'cl-webhook-1', isActive: true })],
    ];
    for (const [id, arm] of rules) { lane(id); ranAgo(id, 3 * H); arm(); }
    lane('cl-free-0001'); ranAgo('cl-free-0001', 3 * H);
    // A machine-written user row (origin agent) is never "a human".
    userMessages.push({ chatId: 'cl-free-0001', role: 'user', createdAt: new Date(Date.now() - DAY), metadata: { origin: 'agent' } });
    tickets = [...rules.map(([id], i) => closedRow(`clrule0${i}-x`, id)), closedRow('clfree00-1', 'cl-free-0001')];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['cl-free-0001']);
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledWith('cl-free-0001', { archiveRetire: { detail: CLOSED_TICKET_LANE_RETIRE_DETAIL } });
    for (const [id] of rules) expect(byId(tickets.find((t) => t.context.dispatchedTo === id)!.id).context.laneArchivedAt).toBeUndefined();
  });

  it('FAIL CLOSED: a failed house-rule read keeps every closed ticket\'s lane this drain (no notice even past the window); the next drain archives it', async () => {
    lane('cl-hrfail-01'); ranAgo('cl-hrfail-01', 3 * H);
    kv.set('ticket-dispatch:lane-archive-stuck:cl-hrfail-01', String(Date.now() - LANE_ARCHIVE_STUCK_MS - MIN));
    tickets = [closedRow('clhrfai0-1', 'cl-hrfail-01')];
    mockPrisma.ownerQuestion.findMany.mockRejectedValueOnce(new Error('db down'));
    await drainOpenTicketsToLane();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    expect(lifecycleNotices()).toHaveLength(0);
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['cl-hrfail-01']);
  });

  it('a closed ticket\'s lane still LIVE past the 30-min window keeps the bf656696 pause-cure even when the owner talked to it (its leftover machine backstops keep it live) — but a lane the owner RESTORED is never paused or archived, live or not', async () => {
    for (const id of ['live-human-1', 'live-restor-1']) {
      lane(id);
      runs.push({ sessionId: id, status: 'running', createdAt: new Date(Date.now() - 50 * MIN), updatedAt: new Date() });
      userMessages.push({ chatId: id, role: 'user', createdAt: new Date(Date.now() - DAY), metadata: null });
      sched(`s-${id}`, id, 'machine', 'once');
      kv.set(`ticket-dispatch:lane-archive-stuck:${id}`, String(Date.now() - LANE_ARCHIVE_STUCK_MS - MIN));
    }
    restoreMarkers.add('live-restor-1');
    tickets = [closedRow('livehum0-1', 'live-human-1'), closedRow('liveres0-2', 'live-restor-1')];
    await drainOpenTicketsToLane();
    // Fourth review (2026-10-22): the stuck-live cure is the PLAIN bf656696 pause
    // (alarm-class 'lane_archive', never remembered), and a KEPT lane (a human in
    // 14 d) is only paused — never archived.
    expect(mockPauseSchedulesForLaneArchive.mock.calls.filter((c) => c[0] === 'live-human-1')).toEqual([['live-human-1', { keptLane: { reason: 'human_recent' } }]]);
    expect(archivedIds()).not.toContain('live-human-1');
    expect(mockPauseSchedulesForLaneArchive.mock.calls.filter((c) => c[0] === 'live-restor-1')).toEqual([]);
    expect(archivedIds()).not.toContain('live-restor-1');
  });

  it('REPRO (reopen with a FREE slot — the superseded lane): a reopened ticket whose lane the owner restored gets a fresh lane, and the restored lane is NOT archived — not at re-dispatch, not by the previous-lane sweep later', async () => {
    lane('restored-L02', { updatedAt: new Date(Date.now() - 30 * MIN) });
    ranAgo('restored-L02', 2 * H);
    restoreMarkers.add('restored-L02');
    tickets = [ticket('reopenfr-1', { status: 'open', context: laneCtx('restored-L02', { reopenCount: 1 }) })];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(byId('reopenfr-1').context.previousLanes).toContain('restored-L02');
    expect(archivedIds()).not.toContain('restored-L02');
    chats.get('restored-L02')!.updatedAt = new Date(Date.now() - 30 * DAY);
    runs = runs.filter((r) => r.sessionId !== 'restored-L02');
    ranAgo('restored-L02', 30 * DAY);
    await drainOpenTicketsToLane();
    expect(archivedIds()).not.toContain('restored-L02');
    expect(mockPauseSchedulesForLaneArchive).not.toHaveBeenCalledWith('restored-L02', expect.anything());
  });

  it('REPRO S1: a VERIFIER-reopened ticket on a lane the owner restored is re-dispatched after the idle window + two probes, and the restored lane stays', async () => {
    lane('restored-L03', { updatedAt: new Date(Date.now() - 9 * H) });
    ranAgo('restored-L03', 9 * H);
    restoreMarkers.add('restored-L03');
    tickets = [ticket('verifre0-1', { status: 'reopened', context: laneCtx('restored-L03', { dispatchedAt: new Date(Date.now() - 10 * H).toISOString() }) })];
    await drainOpenTicketsToLane();
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(archivedIds()).not.toContain('restored-L03');
  });

  it('a superseded lane with no keep is archived at re-dispatch with its machine schedules paused REMEMBERED (its own detail) and the drain\'s cascade budget', async () => {
    lane('superseded-2'); ranAgo('superseded-2', 7 * H); sched('s-sup2', 'superseded-2', 'machine', 'once');
    tickets = [ticket('redisp00-2', { status: 'open', context: laneCtx('superseded-2') })];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(archivedIds()).toEqual(['superseded-2']);
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledWith('superseded-2', { archiveRetire: { detail: SUPERSEDED_LANE_RETIRE_DETAIL } });
    // Fifth review (2026-10-22): + the drain's restore-audit memo (the cascade answers its children's audit reads from it).
    expect(mockArchiveChat.mock.calls[0][0]).toEqual({ userId: 'owner-1', chatId: 'superseded-2', cascadeBudget: { remaining: TICKET_DRAIN_CASCADE_MAX }, restoreAuditCache: expect.any(Map) });
  });

  it('BOUND: the closed loop archives at most CLOSED_LANE_ARCHIVE_MAX_PER_DRAIN lanes per drain (the rest untouched — no pause, no stamp — and counted as closedArchiveDeferred); the next drain takes the rest', async () => {
    const n = CLOSED_LANE_ARCHIVE_MAX_PER_DRAIN + 5;
    const ids = Array.from({ length: n }, (_, i) => `bound-lane-${String(i).padStart(2, '0')}`);
    for (const id of ids) { lane(id); ranAgo(id, 3 * H); }
    tickets = ids.map((id, i) => closedRow(`bound${String(i).padStart(3, '0')}-x`, id, { updatedAt: new Date(Date.now() - (10 + i) * MIN) }));
    await drainOpenTicketsToLane();
    expect(archivedIds()).toHaveLength(CLOSED_LANE_ARCHIVE_MAX_PER_DRAIN);
    expect(mockPauseSchedulesForLaneArchive).toHaveBeenCalledTimes(CLOSED_LANE_ARCHIVE_MAX_PER_DRAIN);
    expect(lastQueueMeta()).toMatchObject({ archived: CLOSED_LANE_ARCHIVE_MAX_PER_DRAIN, closedArchiveDeferred: 5 });
    expect(tickets.filter((t) => t.context.laneArchivedAt)).toHaveLength(CLOSED_LANE_ARCHIVE_MAX_PER_DRAIN);
    await drainOpenTicketsToLane();
    expect(new Set(archivedIds())).toEqual(new Set(ids));
    expect(lastQueueMeta()).not.toHaveProperty('closedArchiveDeferred');
  });

  it('ONE cascade budget per drain: every archive of the drain (closed lane, superseded lane, previous-lane sweep) hands archiveChat the SAME budget object', async () => {
    lane('cb-closed-01'); ranAgo('cb-closed-01', 3 * H);
    lane('cb-supers-01'); ranAgo('cb-supers-01', 7 * H);
    lane('cb-orphan-01'); ranAgo('cb-orphan-01', 7 * H);
    tickets = [
      closedRow('cbclosed-1', 'cb-closed-01'),
      ticket('cbsupers-2', { status: 'open', context: laneCtx('cb-supers-01') }),
      ticket('cbholder-3', { adminNote: 'Waiting for a free ticket lane — at most 4 run at once; it starts automatically when one frees up.', context: { previousLanes: ['cb-orphan-01'], autoDispatch: false } }),
    ];
    await drainOpenTicketsToLane();
    expect(new Set(archivedIds())).toEqual(new Set(['cb-closed-01', 'cb-supers-01', 'cb-orphan-01']));
    const budgets = mockArchiveChat.mock.calls.map((c) => c[0].cascadeBudget);
    expect(budgets.every((b) => b && b === budgets[0])).toBe(true);
    expect(budgets[0]).toEqual({ remaining: TICKET_DRAIN_CASCADE_MAX });
  });

  it('the closed-lane scan reads the WHOLE window (no 1000-row starvation) and flags the pathology ceiling: rows past CLOSED_LANE_SCAN_MAX_PAGES pages are reported as closedScanCapped', async () => {
    // 1200 archived lane rows NEWER than one unarchived row — the second-review 1000-row cap hid it.
    const archived = (n: number) => Array.from({ length: n }, (_, i) => ticket(`win${String(i).padStart(5, '0')}-x`, {
      status: 'done', context: laneCtx(`win-lane-${i}`, { laneArchivedAt: new Date().toISOString(), laneArchivedLane: `win-lane-${i}` }), updatedAt: new Date(Date.now() - i * 1000),
    }));
    lane('window-tail1'); ranAgo('window-tail1', 4 * H);
    tickets = [...archived(1200), closedRow('wintail0-1', 'window-tail1', { updatedAt: new Date(Date.now() - 2 * H) })];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['window-tail1']);
    expect(lastQueueMeta()).toMatchObject({ closedScanRows: 1201 });
    expect(lastQueueMeta()).not.toHaveProperty('closedScanCapped');
    // Past the ceiling: the scan stops at CLOSED_LANE_SCAN_MAX_PAGES and says so.
    mockArchiveChat.mockClear();
    tickets = archived(CLOSED_LANE_SCAN_PAGE * CLOSED_LANE_SCAN_MAX_PAGES + 1);
    await drainOpenTicketsToLane();
    const lastScan = closedScanCalls().slice(-CLOSED_LANE_SCAN_MAX_PAGES);
    expect(lastScan).toHaveLength(CLOSED_LANE_SCAN_MAX_PAGES);
    expect(lastScan.every((c) => c[0].skip === undefined)).toBe(true);
    expect(lastQueueMeta()).toMatchObject({ closedScanCapped: true, closedScanRows: CLOSED_LANE_SCAN_PAGE * CLOSED_LANE_SCAN_MAX_PAGES });
  });

  it('closedLaneArchiveOpts: switch on → none (the bf656696 pause); off → remembered, with the closed-ticket detail unless the row is newly reached; a lane still LIVE → none (fourth review: the stuck-live cure keeps the plain pause)', () => {
    expect(closedLaneArchiveOpts(true, false)).toEqual({});
    expect(closedLaneArchiveOpts(false, true)).toEqual({ retirePause: true });
    expect(closedLaneArchiveOpts(false, false)).toEqual({ retirePause: true, retireDetail: CLOSED_TICKET_LANE_RETIRE_DETAIL });
    expect(closedLaneArchiveOpts(false, false, true)).toEqual({});
    expect(closedLaneArchiveOpts(true, false, true)).toEqual({});
  });

  it('KILL SWITCH: the closed loop and the superseded lane read no house rule and archive with the pre-fix call (bare pause, {userId, chatId})', async () => {
    process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED = '1';
    lane('ks-closed-01'); ranAgo('ks-closed-01', 3 * H); restoreMarkers.add('ks-closed-01');
    lane('ks-supers-01'); ranAgo('ks-supers-01', 7 * H); restoreMarkers.add('ks-supers-01');
    tickets = [closedRow('ksclosed-1', 'ks-closed-01'), ticket('kssupers-2', { status: 'open', context: laneCtx('ks-supers-01') })];
    await drainOpenTicketsToLane();
    expect(new Set(archivedIds())).toEqual(new Set(['ks-closed-01', 'ks-supers-01']));
    for (const c of mockArchiveChat.mock.calls) expect(Object.keys(c[0]).sort()).toEqual(['chatId', 'userId']);
    for (const c of mockPauseSchedulesForLaneArchive.mock.calls) expect(c).toHaveLength(1);
    expect(mockPrisma.ownerQuestion.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.activity.findMany).not.toHaveBeenCalled();
  });
});

describe('fourth review (2026-10-22) — a restore is read independently of the first rule; a kept lane is never archived; known keeps never starve the bound; one restore-audit read per chat per drain', () => {
  const lifecycleNotices = () => mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'attention_needed' && c[3]?.reason === 'lane_archive_stuck');
  const closedRow = (id: string, laneId: string, over: Partial<Row> = {}) => ticket(id, { status: 'done', context: laneCtx(laneId), updatedAt: new Date(Date.now() - 10 * MIN), ...over });
  const stuckPastWindow = (laneId: string) => kv.set(`ticket-dispatch:lane-archive-stuck:${laneId}`, String(Date.now() - LANE_ARCHIVE_STUCK_MS - 20 * MIN));
  const pauseCallsFor = (laneId: string) => mockPauseSchedulesForLaneArchive.mock.calls.filter((c) => c[0] === laneId);

  it('REPRO A (major): a RESTORED lane still running 50 min after its ticket re-closed, with a child whose machine schedule is enabled (first reported rule: live_child) — never paused, never archived, its machine schedule stays armed', async () => {
    lane('rest-live-01');
    runs.push({ sessionId: 'rest-live-01', status: 'running', createdAt: new Date(Date.now() - 50 * MIN), updatedAt: new Date() });
    restoreMarkers.add('rest-live-01');
    sched('s-rest-live', 'rest-live-01', 'machine', 'once');
    childChats.push({ id: 'rl-kid-0001', parentChatId: 'rest-live-01', archivedAt: null });
    sched('s-rl-kid', 'rl-kid-0001', 'machine');
    stuckPastWindow('rest-live-01');
    tickets = [closedRow('restlive-1', 'rest-live-01')];
    await drainOpenTicketsToLane();
    expect(pauseCallsFor('rest-live-01')).toEqual([]);
    expect(schedules.get('s-rest-live')!.enabled).toBe(true);
    expect(archivedIds()).not.toContain('rest-live-01');
    expect(lifecycleNotices()).toHaveLength(0);
  });

  it('REPRO A2 (major): a lane restored BEFORE the marker shipped (restore audit only) with a QUEUED run (satellite ready — archiveChat would not refuse it) and a running child is never paused or archived, and the ticket is never stamped', async () => {
    lane('rest-queue-1', { satellite: 'ready' });
    runs.push({ sessionId: 'rest-queue-1', status: 'queued', createdAt: new Date(Date.now() - 50 * MIN), updatedAt: new Date(Date.now() - 50 * MIN) });
    activities.push(
      { userId: 'owner-1', resource: 'platform', action: 'chat.archive', createdAt: new Date(Date.now() - 3 * DAY), metadata: { chatId: 'rest-queue-1' } },
      { userId: 'owner-1', resource: 'platform', action: 'chat.restore', createdAt: new Date(Date.now() - 2 * DAY), metadata: { chatId: 'rest-queue-1' } },
    );
    childChats.push({ id: 'rq-kid-0001', parentChatId: 'rest-queue-1', archivedAt: null });
    runs.push({ sessionId: 'rq-kid-0001', status: 'running', createdAt: new Date(Date.now() - 5 * MIN), updatedAt: new Date() });
    stuckPastWindow('rest-queue-1');
    tickets = [closedRow('restque0-1', 'rest-queue-1')];
    await drainOpenTicketsToLane();
    expect(pauseCallsFor('rest-queue-1')).toEqual([]);
    expect(archivedIds()).not.toContain('rest-queue-1');
    expect(byId('restque0-1').context.laneArchivedAt).toBeUndefined();
  });

  it('REPRO B (major): a lane NOT restored but kept (an open owner question + an active share link) with a queued run past the window gets ONLY the plain bf656696 pause — never archived, never noticed, on any drain', async () => {
    lane('kept-live-01', { satellite: 'ready' });
    runs.push({ sessionId: 'kept-live-01', status: 'queued', createdAt: new Date(Date.now() - 50 * MIN), updatedAt: new Date(Date.now() - 50 * MIN) });
    ownerQuestions.push({ chatId: 'kept-live-01', status: 'open' });
    shareLinks.push({ chatId: 'kept-live-01', isActive: true, expiresAt: null });
    sched('s-kept-live', 'kept-live-01', 'machine', 'once');
    stuckPastWindow('kept-live-01');
    tickets = [closedRow('keptliv0-1', 'kept-live-01')];
    await drainOpenTicketsToLane();
    // the PLAIN pause rows (lane_archive, never remembered) — its event says the lane is KEPT, never "being archived"
    expect(pauseCallsFor('kept-live-01')).toEqual([['kept-live-01', { keptLane: { reason: 'awaiting_owner' } }]]);
    expect(schedules.get('s-kept-live')!.enabled).toBe(false);
    expect(archivedIds()).not.toContain('kept-live-01');
    expect(lifecycleNotices()).toHaveLength(0);
    await drainOpenTicketsToLane();
    expect(archivedIds()).not.toContain('kept-live-01');
    expect(byId('keptliv0-1').context.laneArchivedAt).toBeUndefined();
  });

  it('CONTROL: a lane no rule keeps, still live past the window, gets the plain bf656696 pause and the archive attempt (the pre-wave cure)', async () => {
    lane('free-live-01');
    runs.push({ sessionId: 'free-live-01', status: 'running', createdAt: new Date(Date.now() - 50 * MIN), updatedAt: new Date() });
    sched('s-free-live', 'free-live-01', 'machine', 'once');
    stuckPastWindow('free-live-01');
    tickets = [closedRow('freeliv0-1', 'free-live-01')];
    await drainOpenTicketsToLane();
    expect(pauseCallsFor('free-live-01')).toEqual([['free-live-01']]);
    expect(archivedIds()).toContain('free-live-01');
  });

  it('BOUND (minor): 2 × CLOSED_LANE_ARCHIVE_MAX_PER_DRAIN newer closed lanes kept by an owner-armed schedule never charge the attempt bound — an older idle closed lane behind them is archived on the FIRST drain', async () => {
    const n = 2 * CLOSED_LANE_ARCHIVE_MAX_PER_DRAIN;
    const ids = Array.from({ length: n }, (_, i) => `owner-kept-${String(i).padStart(2, '0')}`);
    for (const [i, id] of ids.entries()) { lane(id); ranAgo(id, 3 * H); sched(`s-ok-${i}`, id, 'user'); }
    lane('old-closed-1'); ranAgo('old-closed-1', 4 * DAY);
    tickets = [
      ...ids.map((id, i) => closedRow(`ownkep${String(i).padStart(2, '0')}-x`, id, { updatedAt: new Date(Date.now() - (5 + i) * MIN) })),
      closedRow('oldclos0-1', 'old-closed-1', { updatedAt: new Date(Date.now() - 3 * DAY) }),
    ];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['old-closed-1']);
    expect(lastQueueMeta()).not.toHaveProperty('closedArchiveDeferred');
    for (const id of ids) expect(pauseCallsFor(id)).toEqual([]);
    expect(lifecycleNotices()).toHaveLength(0);
  });

  it('FAIL CLOSED: a failed batched owner-schedule read keeps every closed ticket\'s lane this drain; the next drain archives', async () => {
    lane('own-pre-fail'); ranAgo('own-pre-fail', 3 * H);
    tickets = [closedRow('ownprefa-1', 'own-pre-fail')];
    const faithful = mockPrisma.codingSchedule.findMany.getMockImplementation();
    mockPrisma.codingSchedule.findMany.mockImplementation(async (args: any) => {
      if (Array.isArray(args?.where?.OR)) throw new Error('db down');
      return faithful!(args);
    });
    await drainOpenTicketsToLane();
    expect(mockArchiveChat).not.toHaveBeenCalled();
    mockPrisma.codingSchedule.findMany.mockImplementation(faithful);
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['own-pre-fail']);
  });

  it('DB LOAD (minor): the superseded lanes of one drain\'s re-dispatches share ONE restore-audit read (the drain\'s memo), and no chat id is read twice by the drain\'s house-rule sites', async () => {
    lane('ac-closed-01'); ranAgo('ac-closed-01', 3 * H);
    lane('ac-orphan-01'); ranAgo('ac-orphan-01', 7 * H);
    lane('ac-supers-01'); ranAgo('ac-supers-01', 7 * H);
    lane('ac-supers-02'); ranAgo('ac-supers-02', 7 * H);
    tickets = [
      closedRow('acclosed-1', 'ac-closed-01'),
      ticket('acholder-2', { adminNote: 'Waiting for a free ticket lane — at most 4 run at once; it starts automatically when one frees up.', context: { previousLanes: ['ac-orphan-01'], autoDispatch: false } }),
      ticket('acsuper0-3', { status: 'open', context: laneCtx('ac-supers-01') }),
      ticket('acsuper0-4', { status: 'open', context: laneCtx('ac-supers-02') }),
    ];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(2);
    expect(new Set(archivedIds())).toEqual(new Set(['ac-closed-01', 'ac-orphan-01', 'ac-supers-01', 'ac-supers-02']));
    const asked = (mockPrisma.activity.findMany.mock.calls as Array<[any]>).map((c) => (c[0].where.OR ?? []).map((o: any) => String(o.metadata.equals)));
    const flat = asked.flat();
    expect(new Set(flat).size).toBe(flat.length);
    const supersededReads = asked.filter((ids) => ids.includes('ac-supers-01') || ids.includes('ac-supers-02'));
    expect(supersededReads).toHaveLength(1);
    expect(new Set(supersededReads[0])).toEqual(new Set(['ac-supers-01', 'ac-supers-02']));
  });
});

describe('fifth review (2026-10-22) — a lane restored after the drain read it is never retired; one kept-lane pause per episode; an hourly retirement window; a retire budget; the drain lock is the holder\'s', () => {
  const lifecycleNotices = () => mockEmitHookEvent.mock.calls.filter((c) => c[1] === 'attention_needed' && c[3]?.reason === 'lane_archive_stuck');
  const closedRow = (id: string, laneId: string, over: Partial<Row> = {}) => ticket(id, { status: 'done', context: laneCtx(laneId), updatedAt: new Date(Date.now() - 10 * MIN), ...over });
  const stuckPastWindow = (laneId: string) => kv.set(`ticket-dispatch:lane-archive-stuck:${laneId}`, String(Date.now() - LANE_ARCHIVE_STUCK_MS - 20 * MIN));
  const pauseCallsFor = (laneId: string) => mockPauseSchedulesForLaneArchive.mock.calls.filter((c) => c[0] === laneId);
  const hourKey = (kind: string) => `ticket-dispatch:retire-window:${kind}:${Math.floor(Date.now() / 3600_000)}`;
  /** The owner RESTORES `laneId` the moment the drain's archive step re-reads it (after the drain-start snapshot read it archived). */
  function restoreOnReRead(laneId: string): void {
    const faithful = mockPrisma.crossModelChat.findUnique.getMockImplementation()!;
    let restored = false;
    mockPrisma.crossModelChat.findUnique.mockImplementation(async (args: any) => {
      if (args?.where?.id === laneId && !restored) {
        restored = true;
        chats.get(laneId)!.archivedAt = null;
        chats.get(laneId)!.updatedAt = new Date();
        restoreMarkers.add(laneId);
        activities.push({ userId: 'owner-1', resource: 'platform', action: 'chat.restore', createdAt: new Date(), metadata: { chatId: laneId } });
      }
      return faithful(args);
    });
  }
  afterEach(() => { jest.restoreAllMocks(); });

  it('REPRO (major, plain path): a lane the drain read ARCHIVED and the owner restored before its turn in the loop is NOT archived, paused or stamped; the next drain keeps it (owner_restored)', async () => {
    lane('race-plain-1', { archivedAt: new Date(Date.now() - 2 * H) });
    ranAgo('race-plain-1', 3 * H);
    sched('s-race-plain', 'race-plain-1', 'machine');
    schedules.get('s-race-plain')!.enabled = false; // the archive paused it
    tickets = [closedRow('raceplai-1', 'race-plain-1')];
    restoreOnReRead('race-plain-1');
    await drainOpenTicketsToLane();
    expect(archivedIds()).not.toContain('race-plain-1');
    expect(pauseCallsFor('race-plain-1')).toEqual([]);
    expect(chats.get('race-plain-1')!.archivedAt).toBeNull();
    expect(byId('raceplai-1').context.laneArchivedAt).toBeUndefined();
    expect(lifecycleNotices()).toHaveLength(0);
    await drainOpenTicketsToLane();
    expect(archivedIds()).not.toContain('race-plain-1');
    expect(byId('raceplai-1').context.laneArchivedAt).toBeUndefined();
  });

  it('REPRO (major, newly-reached path): the same race on a ticket closed 10 days ago — not archived, not stamped', async () => {
    lane('race-newly-1', { archivedAt: new Date(Date.now() - 9 * DAY) });
    ranAgo('race-newly-1', 10 * DAY);
    tickets = [closedRow('racenewl-1', 'race-newly-1', { updatedAt: new Date(Date.now() - 10 * DAY) })];
    restoreOnReRead('race-newly-1');
    await drainOpenTicketsToLane();
    expect(archivedIds()).not.toContain('race-newly-1');
    expect(pauseCallsFor('race-newly-1')).toEqual([]);
    expect(byId('racenewl-1').context.laneArchivedAt).toBeUndefined();
  });

  it('CONTROL: a lane still archived when the loop reaches it is only stamped (no archive call, no pause)', async () => {
    lane('still-arch-1', { archivedAt: new Date(Date.now() - 2 * H) });
    ranAgo('still-arch-1', 3 * H);
    tickets = [closedRow('stillarc-1', 'still-arch-1')];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual([]);
    expect(pauseCallsFor('still-arch-1')).toEqual([]);
    expect(byId('stillarc-1').context.laneArchivedLane).toBe('still-arch-1');
  });

  it('REPRO (minor): a KEPT lane live past the window gets its pause-cure ONCE per stuck episode — a row the owner resumed is never re-paused by the next drain', async () => {
    lane('kept-once-01', { satellite: 'ready' });
    runs.push({ sessionId: 'kept-once-01', status: 'queued', createdAt: new Date(Date.now() - 50 * MIN), updatedAt: new Date(Date.now() - 50 * MIN) });
    userMessages.push({ chatId: 'kept-once-01', role: 'user', createdAt: new Date(Date.now() - DAY), metadata: {} });
    sched('s-kept-once', 'kept-once-01', 'machine');
    stuckPastWindow('kept-once-01');
    tickets = [closedRow('keptonce-1', 'kept-once-01')];
    await drainOpenTicketsToLane();
    expect(pauseCallsFor('kept-once-01')).toEqual([['kept-once-01', { keptLane: { reason: 'human_recent' } }]]);
    expect(schedules.get('s-kept-once')!.enabled).toBe(false);
    schedules.get('s-kept-once')!.enabled = true; // the owner resumes it (resume_schedule keeps promptSetBy 'machine')
    await drainOpenTicketsToLane();
    await drainOpenTicketsToLane();
    expect(pauseCallsFor('kept-once-01')).toHaveLength(1);
    expect(schedules.get('s-kept-once')!.enabled).toBe(true);
    expect(archivedIds()).not.toContain('kept-once-01');
  });

  it('sixth review: a pause-cure that FAILED does not spend the episode claim — the next drain retries it', async () => {
    lane('kept-retry-01', { satellite: 'ready' });
    runs.push({ sessionId: 'kept-retry-01', status: 'queued', createdAt: new Date(Date.now() - 50 * MIN), updatedAt: new Date(Date.now() - 50 * MIN) });
    userMessages.push({ chatId: 'kept-retry-01', role: 'user', createdAt: new Date(Date.now() - DAY), metadata: {} });
    sched('s-kept-retry', 'kept-retry-01', 'machine');
    stuckPastWindow('kept-retry-01');
    tickets = [closedRow('keptretr-1', 'kept-retry-01')];
    const realImpl = mockPauseSchedulesForLaneArchive.getMockImplementation();
    mockPauseSchedulesForLaneArchive.mockImplementationOnce(async () => { throw new Error('schedule store down'); });
    await drainOpenTicketsToLane();
    expect(kv.has('ticket-dispatch:lane-kept-paused:kept-retry-01')).toBe(false); // given back
    expect(schedules.get('s-kept-retry')!.enabled).toBe(true);
    if (realImpl) mockPauseSchedulesForLaneArchive.mockImplementation(realImpl);
    await drainOpenTicketsToLane();
    expect(pauseCallsFor('kept-retry-01')).toHaveLength(2);
    expect(schedules.get('s-kept-retry')!.enabled).toBe(false);
    expect(kv.has('ticket-dispatch:lane-kept-paused:kept-retry-01')).toBe(true); // spent by the pause that ran
    expect(archivedIds()).not.toContain('kept-retry-01');
  });

  it('a landed archive ends the episode: the kept-pause marker is cleared with the stuck clock', async () => {
    kv.set('ticket-dispatch:lane-kept-paused:ends-epi-01', '1');
    lane('ends-epi-01'); ranAgo('ends-epi-01', 3 * H);
    tickets = [closedRow('endsepi0-1', 'ends-epi-01')];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['ends-epi-01']);
    expect(kv.has('ticket-dispatch:lane-kept-paused:ends-epi-01')).toBe(false);
  });

  it('REPRO (minor): the retirement window is per CLOCK HOUR across drains — back-to-back drains (one per agent filing) archive at most TICKET_DRAIN_RETIRE_MAX_PER_HOUR closed lanes this hour; the next hour takes the rest', async () => {
    const n = TICKET_DRAIN_RETIRE_MAX_PER_HOUR + 12;
    const ids = Array.from({ length: n }, (_, i) => `hour-lane-${String(i).padStart(2, '0')}`);
    for (const id of ids) { lane(id); ranAgo(id, 3 * H); }
    tickets = ids.map((id, i) => closedRow(`hourrow${String(i).padStart(2, '0')}-x`, id, { updatedAt: new Date(Date.now() - (5 + i) * MIN) }));
    for (let i = 0; i < 4; i++) await drainOpenTicketsToLane();
    expect(archivedIds()).toHaveLength(TICKET_DRAIN_RETIRE_MAX_PER_HOUR);
    expect(Number(kv.get(hourKey('archives')))).toBe(TICKET_DRAIN_RETIRE_MAX_PER_HOUR);
    expect(lastQueueMeta().closedArchiveDeferred).toBe(n - TICKET_DRAIN_RETIRE_MAX_PER_HOUR);
    // a deferred lane is untouched — no pause, no stamp, no notice
    const deferred = ids.filter((id) => !archivedIds().includes(id));
    for (const id of deferred) expect(pauseCallsFor(id)).toEqual([]);
    expect(lifecycleNotices()).toHaveLength(0);
    kv.delete(hourKey('archives')); // the next clock hour
    await drainOpenTicketsToLane();
    expect(new Set(archivedIds())).toEqual(new Set(ids));
  });

  it('the hourly window is shared by the previous-lane sweep, and the drain cascade budget is what this hour has left (min with the per-drain budget); a landed archive counts the children its cascade took', async () => {
    kv.set(hourKey('archives'), String(TICKET_DRAIN_RETIRE_MAX_PER_HOUR - 1));
    kv.set(hourKey('cascade'), String(TICKET_DRAIN_CASCADE_MAX_PER_HOUR - 5));
    lane('win-closed-1'); ranAgo('win-closed-1', 3 * H);
    lane('win-orphan-1'); ranAgo('win-orphan-1', 7 * H);
    tickets = [
      closedRow('winclose-1', 'win-closed-1'),
      ticket('winhold0-2', { adminNote: 'Waiting for a free ticket lane — at most 4 run at once; it starts automatically when one frees up.', context: { previousLanes: ['win-orphan-1'], autoDispatch: false } }),
    ];
    const seenBudget: number[] = [];
    const real = mockArchiveChat.getMockImplementation()!;
    mockArchiveChat.mockImplementation(async (o: any) => { seenBudget.push(o.cascadeBudget?.remaining); o.cascadeBudget.remaining -= 3; return real(o); });
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['win-closed-1']); // the window had ONE archive left; the orphan waits
    expect(seenBudget).toEqual([5]);
    expect(Number(kv.get(hourKey('archives')))).toBe(TICKET_DRAIN_RETIRE_MAX_PER_HOUR);
    expect(Number(kv.get(hourKey('cascade')))).toBe(TICKET_DRAIN_CASCADE_MAX_PER_HOUR - 2);
    expect(chats.get('win-orphan-1')!.archivedAt).toBeNull();
  });

  it('an unreadable window falls back to the per-drain bounds (never a dead drain)', async () => {
    const redis = jest.requireMock('../../../config/redis').default;
    const realGet = redis.get.getMockImplementation();
    redis.get.mockImplementation(async (k: string) => { if (String(k).includes('retire-window')) throw new Error('redis down'); return realGet(k); });
    lane('nowin-lane-1'); ranAgo('nowin-lane-1', 3 * H);
    tickets = [closedRow('nowinlan-1', 'nowin-lane-1')];
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['nowin-lane-1']);
    expect(mockArchiveChat.mock.calls[0][0].cascadeBudget).toEqual({ remaining: TICKET_DRAIN_CASCADE_MAX });
    redis.get.mockImplementation(realGet);
  });

  it('REPRO (major, drain lock): the retirement half stops starting archives once the drain has run TICKET_DRAIN_RETIRE_BUDGET_MS — the rest are deferred untouched', async () => {
    let clock = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    for (const id of ['slow-lane-01', 'slow-lane-02', 'slow-lane-03']) { lane(id); ranAgo(id, 3 * H); }
    tickets = ['slow-lane-01', 'slow-lane-02', 'slow-lane-03'].map((id, i) => closedRow(`slowlan${i}-x`, id, { updatedAt: new Date(clock - (5 + i) * MIN) }));
    const real = mockArchiveChat.getMockImplementation()!;
    mockArchiveChat.mockImplementation(async (o: any) => { clock += TICKET_DRAIN_RETIRE_BUDGET_MS + 1_000; return real(o); }); // one slow archive (its cascade)
    await drainOpenTicketsToLane();
    expect(archivedIds()).toEqual(['slow-lane-01']);
    expect(lastQueueMeta().closedArchiveDeferred).toBe(2);
    expect(pauseCallsFor('slow-lane-02')).toEqual([]);
  });

  it('REPRO (major, drain lock): a drain that outlived its lock never deletes the NEXT drain\'s lock', async () => {
    lane('lock-lane-01'); ranAgo('lock-lane-01', 3 * H);
    tickets = [closedRow('locklane-1', 'lock-lane-01')];
    const real = mockArchiveChat.getMockImplementation()!;
    mockArchiveChat.mockImplementation(async (o: any) => {
      kv.set('ticket-dispatch:fresh-drain-lock', 'a-later-drain'); // our lock expired; another drain took it
      return real(o);
    });
    await drainOpenTicketsToLane();
    expect(kv.get('ticket-dispatch:fresh-drain-lock')).toBe('a-later-drain');
    // a drain that still holds its own lock releases it
    kv.delete('ticket-dispatch:fresh-drain-lock');
    mockArchiveChat.mockImplementation(real);
    await drainOpenTicketsToLane();
    expect(kv.has('ticket-dispatch:fresh-drain-lock')).toBe(false);
  });
});

describe('KILL SWITCH TICKET_LANE_ARCHIVE_GAPS_DISABLED=1 — the pre-fix archive byte-for-byte', () => {
  beforeEach(() => { process.env.TICKET_LANE_ARCHIVE_GAPS_DISABLED = '1'; });

  it('the closed read is the pre-fix take:100 / 7-day / closed-only query, one call', async () => {
    tickets = [ticket('swdone00-1', { status: 'done', context: laneCtx('sw-lane-0001') })];
    lane('sw-lane-0001');
    await drainOpenTicketsToLane();
    const calls = closedScanCalls();
    expect(calls).toHaveLength(1);
    const args = calls[0][0];
    expect(Object.keys(args).sort()).toEqual(['orderBy', 'select', 'take', 'where']);
    expect(args.where).toEqual({ status: { in: CLOSED_STATUSES }, updatedAt: { gte: expect.any(Date) } });
    expect(Math.abs(Date.now() - 7 * DAY - args.where.updatedAt.gte.getTime())).toBeLessThan(60_000);
    expect(args.orderBy).toEqual({ updatedAt: 'desc' });
    expect(args.take).toBe(100);
    expect(args.select).toEqual({ id: true, context: true });
    // The pre-fix stamp: laneArchivedAt only. The existence probe is id-only.
    expect(byId('swdone00-1').context.laneArchivedAt).toEqual(expect.any(String));
    expect(byId('swdone00-1').context).not.toHaveProperty('laneArchivedLane');
    const probe = (mockPrisma.crossModelChat.findMany.mock.calls as Array<[any]>).find((c) => c[0].where.id.in.includes('sw-lane-0001'));
    expect(probe![0].select).toEqual({ id: true });
  });

  it('pins every pre-fix gap: awaiting lane kept, 150-row starvation, previous orphan kept, running satellite never healed, stamp inherited, no new metric fields', async () => {
    lane('sw-await-001'); ranAgo('sw-await-001', 19 * H);
    lane('sw-orphan-01'); ranAgo('sw-orphan-01', 7 * H);
    lane('sw-running-1', { satellite: 'running' });
    lane('sw-starved-1'); ranAgo('sw-starved-1', 4 * H);
    tickets = [
      ticket('swawait0-1', { status: 'awaiting_verification', context: laneCtx('sw-await-001') }),
      ticket('swhold00-2', { context: { previousLanes: ['sw-orphan-01'], autoDispatch: false } }),
      ticket('swrun000-3', { status: 'done', context: laneCtx('sw-running-1'), updatedAt: new Date(Date.now() - 10 * MIN) }),
      ...Array.from({ length: 150 }, (_, i) => ticket(`swarch${String(i).padStart(3, '0')}-x`, {
        status: 'done', context: laneCtx(`sw-arch-${i}`, { laneArchivedAt: new Date().toISOString() }), updatedAt: new Date(Date.now() - i * 1000),
      })),
      ticket('swstarv0-4', { status: 'done', context: laneCtx('sw-starved-1'), updatedAt: new Date(Date.now() - 3 * H) }),
    ];
    await drainOpenTicketsToLane();
    expect(archivedIds()).not.toContain('sw-await-001');
    expect(archivedIds()).not.toContain('sw-orphan-01');
    expect(archivedIds()).not.toContain('sw-starved-1');
    expect(mockPrisma.chatCodingState.findUnique).not.toHaveBeenCalled();
    expect(mockHealOrphanedRunningSession).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.findMany).not.toHaveBeenCalled();
    const meta = lastQueueMeta();
    for (const k of ['archivedAwaiting', 'archivedPrevious', 'healedRunning', 'closedScanRows']) expect(meta).not.toHaveProperty(k);
  });

  it('the spawn stamp keeps an inherited laneArchivedAt, so the next close never archives the new lane (the pre-fix reopen bug)', async () => {
    lane('swreopen-old', { archivedAt: new Date(Date.now() - DAY) });
    ranAgo('swreopen-old', DAY);
    tickets = [ticket('swreopn0-1', { status: 'open', context: laneCtx('swreopen-old', { laneArchivedAt: new Date(Date.now() - DAY).toISOString() }) })];
    await drainOpenTicketsToLane();
    const newLane = byId('swreopn0-1').context.dispatchedTo as string;
    expect(byId('swreopn0-1').context.laneArchivedAt).toEqual(expect.any(String));
    byId('swreopn0-1').status = 'done';
    await drainOpenTicketsToLane();
    expect(archivedIds()).not.toContain(newLane);
  });

  it('a verifier-reopened row on an archived lane waits for the old windows (no same-drain re-dispatch)', async () => {
    lane('swshipped-01', { archivedAt: new Date(Date.now() - 2 * H) });
    ranAgo('swshipped-01', 2 * H);
    tickets = [ticket('swverif0-1', { status: 'reopened', context: laneCtx('swshipped-01', { laneArchivedAt: new Date().toISOString() }) })];
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(0);
    expect(mockStartCodingSession).not.toHaveBeenCalled();
  });
});
