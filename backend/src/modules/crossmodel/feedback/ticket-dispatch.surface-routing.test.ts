/**
 * SURFACE ROUTING at the dispatcher (ticket a2540aaa): a product-surface
 * missed-bug ticket (context.about 'user_project' + context.userProjectId,
 * stamped by the framework-signal sweep at filing time) spawns its ticket
 * lane in THAT product project; platform tickets spawn at the platform lane
 * home exactly as today. Refusals degrade to the platform home (mis-filing
 * is safer than mis-routing); the kill switch restores byte-for-byte.
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
const projects: Record<string, { id: string; userId: string; repoUrl: string | null; name: string } | null> = {};

function matchesWhere(r: Row, where: any): boolean {
  if (!where) return true;
  if (where.id && typeof where.id === 'string' && r.id !== where.id) return false;
  if (where.id?.in && !where.id.in.includes(r.id)) return false;
  if (typeof where.status === 'string' && r.status !== where.status) return false;
  if (where.status?.in && !where.status.in.includes(r.status)) return false;
  if (where.updatedAt?.gte && r.updatedAt < where.updatedAt.gte) return false;
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
  crossModelProject: {
    findUnique: jest.fn(async ({ where }: any) => (projects[where.id] !== undefined ? { ...projects[where.id] } : null)),
    findMany: jest.fn(async () => []),
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
  codingSchedule: { findMany: jest.fn(async () => []) },
  contextStoreEntry: { findUnique: jest.fn(async () => null) },
};
withEmptyHouseRuleReads(mockPrisma);
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
    incr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) + 1; kv.set(k, String(n)); return n; }),
    expire: jest.fn(async () => 1),
    del: jest.fn(async (k: string) => { kv.delete(k); return 1; }),
    decr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) - 1; kv.set(k, String(n)); return n; }),
  },
}));

let spawnSeq = 0;
const mockStartCodingSession = jest.fn(async (_opts: any) => ({ id: `${String(++spawnSeq).padStart(8, 'a')}-lane-session` }));
const mockSendChatMessage = jest.fn(async () => ({ queued: true }));
const mockArchiveChat = jest.fn(async ({ chatId }: any) => {
  const c = chats.get(chatId);
  if (c) c.archivedAt = new Date();
  return { id: chatId, archived: true };
});
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: (o: any) => mockStartCodingSession(o),
  sendChatMessage: (...a: any[]) => mockSendChatMessage(...(a as [])),
  archiveChat: (o: any) => mockArchiveChat(o),
}));

import { drainOpenTicketsToLane, ticketLaneCharter } from './ticket-dispatch.service';

const H = 3600_000;
const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'bug_report', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 3, source: 'agent', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), ...over,
  };
}
/** A missed-bug ticket STAMPED for product routing (what the sweep files). */
const routedTicket = (id: string, projectId = 'proj-deckpose'): Row => ticket(id, {
  title: `Missed bug: owner frustration in chat ${id.slice(0, 8)}`,
  context: { about: 'user_project', userProjectId: projectId },
});
const byId = (id: string) => tickets.find((t) => t.id === id)!;
const ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  for (const k of ['TICKET_DISPATCH_FRESH_LANES_DISABLED', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_CONCURRENCY_NIGHT', 'TICKET_LANE_NIGHT_HOURS', 'TICKET_LANE_NO_RUN_REDISPATCH_HOURS',
    'TICKET_LANE_MAX_DISPATCHES', 'TICKET_LANE_LEGACY_REDISPATCH_DISABLED', 'TICKET_LANE_PROJECT_ID', 'TICKET_DISPATCH_DAILY_CAP', 'TICKET_DISPATCH_ANY_USER', 'TICKET_LANE_SURFACE_ROUTING_DISABLED']) delete process.env[k];
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope';
  tickets = [];
  runs = [];
  kv.clear();
  chats.clear();
  for (const k of Object.keys(projects)) delete projects[k];
  spawnSeq = 0;
  chats.set(STANDING, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
  projects['proj-crossmodel'] = { id: 'proj-crossmodel', userId: 'owner-1', repoUrl: 'https://github.com/canada-quant/digby', name: 'crossmodel' };
  projects['proj-deckpose'] = { id: 'proj-deckpose', userId: 'owner-1', repoUrl: 'https://github.com/canada-quant/example-repo', name: 'deckpose' };
  projects['proj-foreign'] = { id: 'proj-foreign', userId: 'owner-2', repoUrl: 'https://github.com/other/thing', name: 'foreign' };
});
afterAll(() => { process.env = ENV; });

describe('surface routing at dispatch (a2540aaa)', () => {
  it('spawns a routed ticket\'s lane in its PRODUCT project, with the product charter line and the routed context', async () => {
    tickets = [routedTicket('rt111111-1')];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    const call = mockStartCodingSession.mock.calls[0][0];
    expect(call).toMatchObject({
      userId: 'owner-1',
      projectId: 'proj-deckpose',
      permissionMode: 'auto',
      promptOrigin: { kind: 'agent' },
      chainFromPrior: false,
    });
    // The routed charter line is present on the brief…
    expect(call.prompt).toContain('SURFACE ROUTING: this ticket was classified to the product project this lane runs in');
    // …and absent from a platform ticket's brief (see the test below).
    const t = byId('rt111111-1');
    expect(t.status).toBe('in_progress');
    expect(t.context).toMatchObject({ dispatchMode: 'ticket_lane', dispatchedTo: 'aaaaaaa1-lane-session', laneDispatches: 1 });
  });

  it('a PLATFORM ticket keeps the platform project AND carries no routed charter line', async () => {
    tickets = [ticket('pt222222-2')];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    const call = mockStartCodingSession.mock.calls[0][0];
    expect(call.projectId).toBe('proj-crossmodel');
    expect(call.prompt).not.toContain('SURFACE ROUTING:');
  });

  it('TICKET_LANE_SURFACE_ROUTING_DISABLED=1 restores the platform home byte-for-byte', async () => {
    process.env.TICKET_LANE_SURFACE_ROUTING_DISABLED = '1';
    tickets = [routedTicket('ks333333-3')];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    const call = mockStartCodingSession.mock.calls[0][0];
    expect(call.projectId).toBe('proj-crossmodel');
    expect(call.prompt).not.toContain('SURFACE ROUTING:');
    const t = byId('ks333333-3');
    expect(t.context.dispatchMode).toBe('ticket_lane');
  });

  it('refusals degrade to the platform home (no repo binding / another user / unknown project / routed-to-platform stamp)', async () => {
    tickets = [
      routedTicket('nrf44444-4', 'proj-norepo'),      // no repoUrl
      routedTicket('for55555-5', 'proj-foreign'),     // another owner
      routedTicket('unk66666-6', 'proj-ghost'),       // deleted
      // A manual context stamp pointing AT the platform project is refused.
      ticket('plat7777-7', { context: { about: 'user_project', userProjectId: 'proj-crossmodel' } }),
    ];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(4);
    const homes = mockStartCodingSession.mock.calls.map((c) => c[0].projectId);
    expect(homes).toEqual(['proj-crossmodel', 'proj-crossmodel', 'proj-crossmodel', 'proj-crossmodel']);
    // The un-routable stamps STILL get the platform lane (not dropped, not wedged)…
    for (const id of ['nrf44444-4', 'for55555-5', 'unk66666-6']) {
      expect(byId(id).context.dispatchMode).toBe('ticket_lane');
    }
    // …and their briefs carry NO routed line (they are not routed lanes).
    const briefs = mockStartCodingSession.mock.calls.map((c) => c[0].prompt);
    for (let i = 0; i < 3; i++) expect(briefs[i]).not.toContain('SURFACE ROUTING:');
  });

  it('a routed ticket never rides a platform family batch (the one-lane-per-family invariant stays single-surface)', async () => {
    process.env.TICKET_DISPATCH_DAILY_CAP = '20';
    const plat = ticket('leadaaaa-0', {
      title: 'Raw marker HARNESS_STAMP (high) survived in chat abcdef01',
      priority: 5,
    });
    const routed = routedTicket('ridebbbb-1');
    tickets = [plat, routed];
    await drainOpenTicketsToLane();
    // TWO lanes, not one batch: the routed member did not ride the platform lead.
    expect(mockStartCodingSession).toHaveBeenCalledTimes(2);
    const homes = mockStartCodingSession.mock.calls.map((c) => c[0].projectId);
    expect(new Set(homes)).toEqual(new Set(['proj-crossmodel', 'proj-deckpose']));
    expect(homes).toContain('proj-deckpose');
  });

  it('a routed ticket never LEADS a family batch either (its lane accepts no riders)', async () => {
    process.env.TICKET_DISPATCH_DAILY_CAP = '20';
    tickets = [
      routedTicket('rlead111-0'),
      ticket('memb2222-1', { title: 'Raw marker HARNESS_STAMP (high) survived in chat abcdef02', priority: 4 }),
    ];
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).toHaveBeenCalledTimes(2);
    const routedCall = mockStartCodingSession.mock.calls.find((c) => c[0].projectId === 'proj-deckpose')!;
    const memberCall = mockStartCodingSession.mock.calls.find((c) => c[0].projectId === 'proj-crossmodel')!;
    // The ROUTED brief carries the surface-routing charter and never the
    // family charter — a routed lane accepts no riders…
    expect(routedCall[0].prompt).toContain('SURFACE ROUTING:');
    expect(routedCall[0].prompt).not.toContain('DEDICATED ticket-family lane');
    // …while the platform member keeps the family-lane charter (the cross-
    // drain one-slot invariant: a solo family row is still a FAMILY lane).
    expect(memberCall[0].prompt).toContain('DEDICATED ticket-family lane');
  });

  it('ticketLaneCharter renders the routed line only when opts.routed', () => {
    expect(ticketLaneCharter('t-1', { dispatchNo: 1, maxDispatches: 3, routed: true })).toContain('SURFACE ROUTING:');
    expect(ticketLaneCharter('t-1', { dispatchNo: 1, maxDispatches: 3 })).not.toContain('SURFACE ROUTING:');
  });
});
