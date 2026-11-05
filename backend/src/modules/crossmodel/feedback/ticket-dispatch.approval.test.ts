/**
 * audit 2026-10-08 W5-1a — the admin approval path for HELD tickets.
 *
 * 7d6b6e09 (owner-only ticket autonomy) holds every other account's ticket
 * "until an admin approves it" — but nothing could set
 * context.dispatchApproved short of a DB write. Account → Admin → Feedback now
 * lists the held tickets and "Approve for a ticket lane" stamps the approval
 * (+ who / when), rewrites the held note, audits, and kicks the drain; the next
 * drain then gives the ticket its own lane.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

type Row = {
  id: string; type: string; title: string; description: string; priority: number; source: string;
  status: string; adminNote: string | null; context: any; createdAt: Date; updatedAt: Date; userId: string | null;
  user?: { email: string; name: string | null; role?: string | null } | null;
};
let tickets: Row[] = [];
const chats = new Map<string, { userId: string; projectId: string | null; archivedAt: Date | null }>();
const activities: any[] = [];

function matchesWhere(r: Row, where: any): boolean {
  if (!where) return true;
  if (where.id && typeof where.id === 'string' && r.id !== where.id) return false;
  if (where.status?.in && !where.status.in.includes(r.status)) return false;
  if (typeof where.status === 'string' && r.status !== where.status) return false;
  if (where.updatedAt?.gte && r.updatedAt < where.updatedAt.gte) return false;
  if (Array.isArray(where.OR) && !where.OR.some((c: any) => (c.userId === null ? r.userId === null : c.userId?.not !== undefined ? r.userId !== c.userId.not : true))) return false;
  return true;
}

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn(async ({ where }: any) => { const c = chats.get(where.id); return c ? { ...c } : null; }) },
  crossModelProject: { findUnique: jest.fn(async () => null) },
  userFeatureRequest: {
    findMany: jest.fn(async ({ where }: any) => tickets.filter((r) => matchesWhere(r, where)).map((r) => ({ ...r, context: JSON.parse(JSON.stringify(r.context ?? {})) }))),
    findUnique: jest.fn(async ({ where }: any) => { const r = tickets.find((t) => t.id === where.id); return r ? { ...r, context: JSON.parse(JSON.stringify(r.context ?? {})) } : null; }),
    update: jest.fn(async ({ where, data }: any) => { const r = tickets.find((t) => t.id === where.id)!; Object.assign(r, data); return { ...r }; }),
    updateMany: jest.fn(async ({ where, data }: any) => { let count = 0; for (const r of tickets) if (matchesWhere(r, where)) { Object.assign(r, data); count++; } return { count }; }),
  },
  agentRun: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  activity: { create: jest.fn(async ({ data }: any) => { activities.push(data); return data; }) },
  contextStoreEntry: { findUnique: jest.fn(async () => null) },
  // TICKET-LANE ARCHIVE GAPS review (2026-10-21): archiveTicketLane's owner-armed
  // schedule guard reads this (fail-closed without it) — no owner rows here.
  chatSchedule: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const kv = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, o?: any) => { if (o?.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; }),
    incr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
    del: jest.fn(async (k: string) => { kv.delete(k); return 1; }),
    decr: jest.fn(async () => 0),
  },
}));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

let spawnSeq = 0;
const mockStartCodingSession = jest.fn(async (_o: any) => ({ id: `${String(++spawnSeq).padStart(8, 'a')}-lane-session` }));
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: (o: any) => mockStartCodingSession(o),
  sendChatMessage: jest.fn(async () => ({ queued: true })),
  archiveChat: jest.fn(async () => ({})),
}));

import logger from '../../../utils/logger';
import {
  approveTicketForLane, listHeldTickets, drainOpenTicketsToLane, HELD_FOR_OWNER_NOTE, APPROVED_FOR_LANE_NOTE_PREFIX, isDispatcherNote,
} from './ticket-dispatch.service';

const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';
const ENV = { ...process.env };

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'mishap', title: `Ticket ${id}`, description: `Description of ${id}.`, priority: 3, source: 'agent', status: 'open',
    adminNote: HELD_FOR_OWNER_NOTE, context: { verifier: 'action-verifier', sessionId: 'ext-chat' }, userId: 'external-9',
    user: { email: 'someone@example.com', name: null },
    createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), ...over,
  };
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  for (const k of ['TICKET_DISPATCH_FRESH_LANES_DISABLED', 'TICKET_LANE_PROJECT_ID', 'TICKET_DISPATCH_ANY_USER', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_CONCURRENCY_NIGHT', 'TICKET_LANE_NIGHT_HOURS']) delete process.env[k];
  // A malformed window forces the day cap no matter what hour CI runs.
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope';
  tickets = [];
  kv.clear();
  chats.clear();
  activities.length = 0;
  spawnSeq = 0;
  chats.set(STANDING, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
});
afterAll(() => { process.env = ENV; });

describe('listHeldTickets — what the Admin → Feedback panel shows', () => {
  it("lists another account's open ticket (held), never the owner's own, never an approved or linked one", async () => {
    tickets = [
      ticket('held0001-aaaa'),
      ticket('own00001-aaaa', { userId: 'owner-1' }),
      ticket('appr0001-aaaa', { context: { dispatchApproved: true } }),
      ticket('link0001-aaaa', { context: { autoDispatch: false, duplicateOf: 'x' } }),
      ticket('done0001-aaaa', { status: 'done' }),
    ];
    const r = await listHeldTickets();
    expect(r.ownerResolved).toBe(true);
    expect(r.tickets.map((t) => t.id)).toEqual(['held0001-aaaa']);
    expect(r.tickets[0]).toMatchObject({ harness: true, user: { email: 'someone@example.com' } });
  });

  it('an ADMIN-role author on another account is not listed (they auto-dispatch); a USER-role author stays held', async () => {
    tickets = [
      ticket('admin001-aaaa', { userId: 'admin-author', user: { email: 'admin@example.com', name: null, role: 'ADMIN' } }),
      ticket('user0001-aaaa', { userId: 'external-9', user: { email: 'someone@example.com', name: null, role: 'USER' } }),
      ticket('appr0002-aaaa', { userId: 'external-9', context: { dispatchApproved: true }, user: { email: 'someone@example.com', name: null, role: 'USER' } }),
    ];
    const r = await listHeldTickets();
    expect(r.ownerResolved).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.tickets.map((t) => t.id)).toEqual(['user0001-aaaa']);
  });

  it('withholds the held list when the lane-home owner cannot be resolved (missing home)', async () => {
    delete process.env.PLATFORM_ENGINEER_CHAT_ID;
    delete process.env.TICKET_LANE_PROJECT_ID;
    tickets = [ticket('held0001-aaaa')];
    const before = mockPrisma.userFeatureRequest.findMany.mock.calls.length;
    const r = await listHeldTickets();
    expect(r).toMatchObject({ ownerResolved: false, degraded: true, tickets: [] });
    expect(r.error).toMatch(/withheld/);
    expect(mockPrisma.userFeatureRequest.findMany.mock.calls.length).toBe(before);
    process.env.PLATFORM_ENGINEER_CHAT_ID = 'b92ef13f-c3f8-487e-8267-767e56543150';
  });

  it('logs a thrown owner lookup and still withholds the list', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => {
      throw new Error('db down');
    });
    tickets = [ticket('held0001-aaaa')];
    const r = await listHeldTickets();
    expect(r).toMatchObject({ ownerResolved: false, degraded: true, tickets: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ticket-lane owner lookup failed'), expect.anything());
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => {
      const c = chats.get(where.id);
      return c ? { ...c } : null;
    });
  });
});

describe('approveTicketForLane — the audited approval', () => {
  it('stamps dispatchApproved + by + at, rewrites the held note, audits, records a metric', async () => {
    tickets = [ticket('held0002-aaaa')];
    const r = await approveTicketForLane({ ticketId: 'held0002-aaaa', adminUserId: 'admin-7', now: new Date('2026-10-08T20:00:00Z') });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(byId('held0002-aaaa').context).toMatchObject({ dispatchApproved: true, dispatchApprovedBy: 'admin-7', dispatchApprovedAt: '2026-10-08T20:00:00.000Z' });
    expect(byId('held0002-aaaa').adminNote?.startsWith(APPROVED_FOR_LANE_NOTE_PREFIX)).toBe(true);
    expect(isDispatcherNote(byId('held0002-aaaa').adminNote)).toBe(true); // the next drain may overwrite it with "Queued — …"
    expect(activities).toEqual([expect.objectContaining({ userId: 'admin-7', action: 'feedback.dispatch_approve', resource: 'feedback', metadata: expect.objectContaining({ ticketId: 'held0002-aaaa', ticketUserId: 'external-9' }) })]);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ticket_dispatch_approval', meta: expect.objectContaining({ approved: true }) }));
  });

  it('END-TO-END: held → approved → the drain the approval kicks gives it its own ticket lane', async () => {
    tickets = [ticket('held0003-aaaa')];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled(); // held
    await approveTicketForLane({ ticketId: 'held0003-aaaa', adminUserId: 'admin-7' });
    for (let i = 0; i < 50 && !mockStartCodingSession.mock.calls.length; i++) await flush(); // the kicked drain is fire-and-forget
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(byId('held0003-aaaa').context).toMatchObject({ dispatchMode: 'ticket_lane', dispatchApproved: true });
  });

  it('an ADMIN-role ticket on another account dispatches without an approval', async () => {
    tickets = [ticket('admin002-aaaa', { userId: 'external-9', user: { email: 'admin@example.com', name: null, role: 'admin' } })];
    await drainOpenTicketsToLane();
    for (let i = 0; i < 50 && !mockStartCodingSession.mock.calls.length; i++) await flush();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(byId('admin002-aaaa').status).toBe('in_progress');
    expect(byId('admin002-aaaa').context).toMatchObject({ dispatchMode: 'ticket_lane' });
  });

  it('revoke (approved:false) removes the approval and restores the held note', async () => {
    tickets = [ticket('held0004-aaaa', { context: { dispatchApproved: true, dispatchApprovedBy: 'admin-7' }, adminNote: `${APPROVED_FOR_LANE_NOTE_PREFIX} at x — …` })];
    const r = await approveTicketForLane({ ticketId: 'held0004-aaaa', adminUserId: 'admin-7', approved: false });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(byId('held0004-aaaa').context.dispatchApproved).toBeUndefined();
    expect(byId('held0004-aaaa').adminNote).toBe(HELD_FOR_OWNER_NOTE);
    expect(activities[0]).toMatchObject({ action: 'feedback.dispatch_revoke' });
  });

  it('refuses a closed ticket, a linked duplicate, and an unknown id', async () => {
    tickets = [ticket('done0002-aaaa', { status: 'done' }), ticket('link0002-aaaa', { context: { autoDispatch: false } })];
    expect(await approveTicketForLane({ ticketId: 'done0002-aaaa', adminUserId: 'a' })).toMatchObject({ ok: false, status: 409 });
    expect(await approveTicketForLane({ ticketId: 'link0002-aaaa', adminUserId: 'a' })).toMatchObject({ ok: false, status: 409 });
    expect(await approveTicketForLane({ ticketId: 'nope0000-aaaa', adminUserId: 'a' })).toMatchObject({ ok: false, status: 404 });
    expect(activities).toEqual([]);
  });

  it('a lane note already on the ticket ("Queued — …") is never overwritten by the approval note', async () => {
    tickets = [ticket('held0005-aaaa', { adminNote: 'Queued — ticket lane abcd1234 starts it (dispatched x).' })];
    await approveTicketForLane({ ticketId: 'held0005-aaaa', adminUserId: 'admin-7' });
    expect(byId('held0005-aaaa').adminNote).toBe('Queued — ticket lane abcd1234 starts it (dispatched x).');
  });
});
