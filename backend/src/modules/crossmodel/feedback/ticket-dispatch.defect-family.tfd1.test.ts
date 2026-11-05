/**
 * TFD-1 (2026-10-30) — the DEFECT-FAMILY single-lane gate, dispatch half.
 *
 * Prod shape this replays (filed by ticket lane b65d2c1f, after that lane
 * finished as the THIRD ticket lane opened on one defect family — the
 * tool-call truncation family c42e8099 → efdb3d31 → b61794e3 → bf3a61e6):
 * every supervisor wake that hit a cut filed a FRESH ticket, the dispatcher
 * minted a brand-new lane for it, and the third lane's run reported it built
 * nothing because a third independent fix for the family is refused. One full
 * run of pure duplicate classification.
 *
 * The gate is deliberately CONSERVATIVE and FAIL-OPEN. Pins here:
 *   (a) a same-family sighting filed while the canonical ticket's lane is
 *       STILL RUNNING takes no second lane — its occurrence is bumped onto the
 *       canonical ticket, the linkage (context.duplicateOf) is recorded, and
 *       the canonical row carries context.familySightings;
 *   (b) the same filing while that lane is IDLE / finished dispatches
 *       normally (never suppress when the canonical lane is done);
 *   (c) an unrelated defect dispatches normally;
 *   (d) an AMBIGUOUS family (unreadable / unstamped) dispatches normally;
 *   (e) an OWNER-FILED ticket is never suppressed, even same-family;
 *   (f) kill switch TICKET_DEFECT_FAMILY_GATE_DISABLED=1 restores
 *       always-dispatch byte-for-byte.
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
const chats = new Map<string, { id: string; userId: string; projectId: string | null; archivedAt: Date | null }>();

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
    findMany: jest.fn(async ({ where }: any) => (where.id.in as string[]).map((id) => chats.get(id)).filter(Boolean).map((c: any) => ({ id: c.id, archivedAt: c.archivedAt }))),
  },
  crossModelProject: { findUnique: jest.fn(async () => null) },
  userFeatureRequest: {
    findMany: jest.fn(async ({ where, take }: any) => tickets
      .filter((r) => matchesWhere(r, where))
      .sort((a, b) => b.priority - a.priority || +a.createdAt - +b.createdAt)
      .slice(0, typeof take === 'number' ? take : undefined)
      .map((r) => ({ ...r, context: r.context ? JSON.parse(JSON.stringify(r.context)) : r.context }))),
    findUnique: jest.fn(async ({ where }: any) => {
      const r = tickets.find((t) => t.id === where.id);
      if (!r) return null;
      return { id: r.id, context: r.context ? JSON.parse(JSON.stringify(r.context)) : r.context };
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
    findMany: jest.fn(async ({ where }: any) => {
      if (where.sessionId?.in) return runs.filter((r) => (where.sessionId.in as string[]).includes(r.sessionId));
      return runs.filter((r) => r.sessionId === where.sessionId);
    }),
    groupBy: jest.fn(async ({ where }: any) => {
      const ids: string[] = where.sessionId?.in ?? [];
      const by = new Map<string, { sessionId: string; status: string; _count: { _all: number } }>();
      for (const r of runs) {
        if (!ids.includes(r.sessionId)) continue;
        const k = `${r.sessionId}|${r.status}`;
        const cur = by.get(k);
        if (cur) cur._count._all += 1;
        else by.set(k, { sessionId: r.sessionId, status: r.status, _count: { _all: 1 } });
      }
      return [...by.values()];
    }),
    count: jest.fn(async ({ where }: any) => runs.filter((r) => r.sessionId === where.sessionId
      && (!where.status?.in || where.status.in.includes(r.status))
      && (!where.updatedAt?.gte || r.updatedAt >= where.updatedAt.gte)).length),
  },
  chatCodingState: { findMany: jest.fn(async () => []) },
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
    del: jest.fn(async (k: string | string[]) => { for (const key of Array.isArray(k) ? k : [k]) kv.delete(key); return 1; }),
    decr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) - 1; kv.set(k, String(n)); return n; }),
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
  },
}));

// #2137 shipped this suite WITHOUT mocking ../platform/hooks.service. The
// dynamic `await import('../platform/hooks.service')` inside
// noticeLaneSlotReleased then pulls hooks.service -> error-handler ->
// config/env, whose parseEnv() calls process.exit(1) when env is not fully
// populated — taking the whole jest worker down (reported only as "Jest
// worker encountered 4 child process exceptions"). Every sibling suite in this
// directory mocks it for exactly this reason (see lane-archive.bf656696).
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => undefined),
}));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

let spawnSeq = 0;
const mockStartCodingSession = jest.fn(async (_opts: any) => ({ id: `${String(++spawnSeq).padStart(8, '0')}-f1e2-d3c4-b5a6-97886970615243` }));
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: (o: any) => mockStartCodingSession(o),
  sendChatMessage: jest.fn(async () => ({ queued: true })),
  archiveChat: jest.fn(async ({ chatId }: any) => ({ id: chatId, archived: true })),
}));

import { drainOpenTicketsToLane } from './ticket-dispatch.service';
import { normalizeDefectFamily } from './ticket-family';

const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';
const CANON_LANE = 'aaaa1111-c3f8-487e-8267-767e56543150';
const FAMILY = 'tool-call-truncation';

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'bug_report', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 2, source: 'agent', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 90 * 60_000), updatedAt: new Date(Date.now() - 90 * 60_000), ...over,
  };
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;

/** The canonical ticket of the family, already dispatched to a lane. */
function canonical(over: Partial<Row> = {}): Row {
  return ticket('c0000001-canonical', {
    status: 'in_progress',
    adminNote: 'Queued — ticket lane aaaa1111 starts it (dispatched 2026-10-30T05:00:00.000Z, dispatch 1 of 3).',
    context: { defectFamily: FAMILY, dispatchMode: 'ticket_lane', dispatchedTo: CANON_LANE, dispatchedAt: '2026-10-30T05:00:00.000Z', laneDispatches: 1 },
    ...over,
  });
}

function liveRun(sessionId: string, status = 'running'): void {
  runs.push({ sessionId, status, createdAt: new Date(Date.now() - 20 * 60_000), updatedAt: new Date(Date.now() - 60_000) });
}

const ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  for (const k of ['TICKET_DEFECT_FAMILY_GATE_DISABLED', 'TICKET_FAMILY_BATCHING_DISABLED', 'TICKET_FAMILY_PREFIX_V2_DISABLED', 'TICKET_FAMILY_PRECISION_ROUTING_DISABLED', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_CONCURRENCY_NIGHT', 'TICKET_LANE_MAX_DISPATCHES', 'TICKET_DISPATCH_DAILY_CAP', 'TICKET_DISPATCH_ANY_USER', 'TICKET_DISPATCH_FRESH_LANES_DISABLED']) delete process.env[k];
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope'; // force the DAY cap (4) whenever CI runs
  tickets = [];
  runs = [];
  kv.clear();
  chats.clear();
  spawnSeq = 0;
  chats.set(STANDING, { id: STANDING, userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
  chats.set(CANON_LANE, { id: CANON_LANE, userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
});
afterAll(() => { process.env = ENV; });

describe('TFD-1 (a) same-family sighting while the canonical lane RUNS', () => {
  it('takes NO second lane: the occurrence is bumped and the linkage recorded', async () => {
    const sighting = ticket('c0000002-sighting', { context: { defectFamily: FAMILY } });
    tickets = [canonical(), sighting];
    liveRun(CANON_LANE);

    const r = await drainOpenTicketsToLane();

    // No lane was spawned for the sighting at all.
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(r.batched).toBe(0);

    // The canonical ticket absorbs it: occurrences bumped, sighting listed by id.
    const canon = byId('c0000001-canonical');
    expect(canon.context.occurrences).toBe(2);
    expect(canon.context.familySightings.map((s: any) => s.ticketId)).toEqual(['c0000002-sighting']);
    expect(canon.context.familySightings[0].family).toBe(FAMILY);
    expect(canon.context.lastSeen).toEqual(expect.any(String));

    // The sighting is a LINKED record — never a second lane.
    const held = byId('c0000002-sighting');
    expect(held.context.dispatchedTo).toBeUndefined();
    expect(held.context.duplicateOf).toBe('c0000001-canonical');
    expect(held.context.duplicateMatch).toBe('defect-family-live-lane');
    expect(held.adminNote).toContain('Held — same defect family: ticket c0000001');
  });

  it('two same-family rows arriving in ONE drain spawn ONE lane (the same-drain claim)', async () => {
    tickets = [
      ticket('d0000001-a', { context: { defectFamily: FAMILY } }),
      ticket('d0000002-b', { context: { defectFamily: FAMILY } }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(r.batched).toBe(1);
    const second = byId('d0000002-b');
    expect(second.context.duplicateOf).toBe('d0000001-a');
    expect(second.context.duplicateMatch).toBe('defect-family-live-lane');
  });
});

describe('TFD-1 (b) same-family filing while the canonical lane is IDLE / finished', () => {
  it('dispatches normally — an idle lane suppresses nothing', async () => {
    tickets = [canonical(), ticket('c0000003-sighting', { context: { defectFamily: FAMILY } })];
    // No live run: the canonical lane finished (its last run is 'completed').
    runs.push({ sessionId: CANON_LANE, status: 'completed', createdAt: new Date(Date.now() - 5 * 3600_000), updatedAt: new Date(Date.now() - 4 * 3600_000) });

    await drainOpenTicketsToLane();

    const fresh = byId('c0000003-sighting');
    expect(fresh.context.dispatchedTo).toEqual(expect.any(String));
    expect(fresh.context.duplicateOf).toBeUndefined();
    expect(fresh.status).toBe('in_progress');
    // The canonical ticket was NOT bumped (nothing was absorbed into it).
    expect(byId('c0000001-canonical').context.occurrences).toBeUndefined();
  });
});

describe('TFD-1 (c) an unrelated defect', () => {
  it('dispatches normally while another family runs', async () => {
    tickets = [canonical(), ticket('c0000004-other', { context: { defectFamily: 'embeddings-storm' } })];
    liveRun(CANON_LANE);

    await drainOpenTicketsToLane();

    const other = byId('c0000004-other');
    expect(other.context.dispatchedTo).toEqual(expect.any(String));
    expect(other.context.duplicateOf).toBeUndefined();
    expect(byId('c0000001-canonical').context.occurrences).toBeUndefined();
  });
});

describe('TFD-1 (d) an AMBIGUOUS family — fail open', () => {
  it('an UNSTAMPED row dispatches normally (no family = no gate)', async () => {
    tickets = [canonical(), ticket('c0000005-plain')];
    liveRun(CANON_LANE);

    await drainOpenTicketsToLane();

    expect(byId('c0000005-plain').context.dispatchedTo).toEqual(expect.any(String));
    expect(byId('c0000005-plain').context.duplicateOf).toBeUndefined();
  });

  it('an UNREADABLE family slug dispatches normally (never a guess)', async () => {
    // The stamp was written by an older path / a bad caller: a pure-digit slug
    // carries no defect identity, so normalizeDefectFamily returns null.
    expect(normalizeDefectFamily('12345')).toBeNull();
    expect(normalizeDefectFamily('')).toBeNull();
    expect(normalizeDefectFamily(null)).toBeNull();
    expect(normalizeDefectFamily('x')).toBeNull(); // too short
    expect(normalizeDefectFamily('Tool Call Truncation')).toBe('tool-call-truncation');

    tickets = [canonical(), ticket('c0000006-ambiguous', { context: { defectFamily: '12345' } })];
    liveRun(CANON_LANE);

    await drainOpenTicketsToLane();

    expect(byId('c0000006-ambiguous').context.dispatchedTo).toEqual(expect.any(String));
    expect(byId('c0000006-ambiguous').context.duplicateOf).toBeUndefined();
  });
});

describe('TFD-1 (e) owner-filed tickets are never suppressed', () => {
  it('a user-filed same-family ticket still gets its lane', async () => {
    tickets = [canonical(), ticket('c0000007-user', { source: 'user', context: { defectFamily: FAMILY } })];
    liveRun(CANON_LANE);

    await drainOpenTicketsToLane();

    const userRow = byId('c0000007-user');
    expect(userRow.context.dispatchedTo).toEqual(expect.any(String));
    expect(userRow.context.duplicateOf).toBeUndefined();
  });
});

describe('TFD-1 (f) kill switch', () => {
  it('TICKET_DEFECT_FAMILY_GATE_DISABLED=1 restores always-dispatch', async () => {
    process.env.TICKET_DEFECT_FAMILY_GATE_DISABLED = '1';
    tickets = [canonical(), ticket('c0000008-sighting', { context: { defectFamily: FAMILY } })];
    liveRun(CANON_LANE);

    await drainOpenTicketsToLane();

    const fresh = byId('c0000008-sighting');
    expect(fresh.context.dispatchedTo).toEqual(expect.any(String));
    expect(fresh.context.duplicateOf).toBeUndefined();
    expect(byId('c0000001-canonical').context.occurrences).toBeUndefined();
  });
});