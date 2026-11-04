/**
 * TICKET-FAMILY-ROUTING (2026-10-20) — the dispatcher half.
 *
 * Prod shape this replays: framework-signal-sweep filed 14 tickets over
 * 10-18..10-20; 12 got a SOLO ticket lane (incomplete-card / missed-bug and
 * the action verifier's per-chat mishaps were not batching families) and
 * only one was a true defect. Pins:
 *   - the three V2 families batch (one lane each); TICKET_FAMILY_PREFIX_V2_DISABLED=1
 *     restores solo lanes;
 *   - a NOISY family (≥ 3 of its last 5 closes false positives / siblings)
 *     runs at most ONE lane per UTC day: its queued members ride that lane,
 *     the day token is set, and while it is spent queued members stay queued
 *     and open members carry the day-wait note (no slot, no claim);
 *   - a high-severity sighting is never day-gated;
 *   - TICKET_FAMILY_PRECISION_ROUTING_DISABLED=1 never strands a queued member;
 *   - a never-laned sighting that PREDATES a merged class fix (its explicit
 *     close time — context.closedAt, never updatedAt) is absorbed (closed as a
 *     linked duplicate of the fix); one observed after the fix, or of another
 *     class, is not; a DETECTOR-WIDE class is never absorbed — the family
 *     lane's brief names its pre-narrowing members on a re-check line
 *     (review 2026-10-20);
 *   - review 2026-10-20: an out-of-scope family-queued row goes back to open
 *     with the held note; the standing-lane path hands family-queued rows back
 *     to open (it reads open only).
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
    findMany: jest.fn(async ({ where }: any) => (where.id.in as string[]).map((id) => chats.get(id)).filter(Boolean).map((c: any) => ({ id: c.id }))),
  },
  crossModelProject: { findUnique: jest.fn(async () => null) },
  userFeatureRequest: {
    findMany: jest.fn(async ({ where, take }: any) => tickets
      .filter((r) => matchesWhere(r, where))
      .sort((a, b) => b.priority - a.priority || +a.createdAt - +b.createdAt)
      .slice(0, typeof take === 'number' ? take : undefined)
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
    findMany: jest.fn(async ({ where }: any) => {
      if (where.sessionId?.in) return runs.filter((r) => (where.sessionId.in as string[]).includes(r.sessionId));
      return runs.filter((r) => r.sessionId === where.sessionId);
    }),
    count: jest.fn(async ({ where }: any) => runs.filter((r) => r.sessionId === where.sessionId
      && (!where.status?.in || where.status.in.includes(r.status))
      && (!where.updatedAt?.gte || r.updatedAt >= where.updatedAt.gte)).length),
  },
  chatCodingState: { findMany: jest.fn(async () => []) },
  // TICKET-LANE ARCHIVE GAPS review (2026-10-21): archiveTicketLane's owner-armed
  // schedule guard reads this (fail-closed without it) — no owner rows here.
  codingSchedule: { findMany: jest.fn(async () => []) },
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

import { drainOpenTicketsToLane, isDispatcherNote } from './ticket-dispatch.service';

const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';
const DAY = () => new Date().toISOString().slice(0, 10);
const H = 3600_000;

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'bug_report', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 2, source: 'agent', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 90 * 60_000), updatedAt: new Date(Date.now() - 90 * 60_000), ...over,
  };
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;
/** A closed family row the lane recorded as a FALSE POSITIVE (the precision history). */
function fpClose(id: string, title: string, hoursAgo = 10): Row {
  const at = new Date(Date.now() - hoursAgo * H);
  return ticket(id, { title, status: 'done', adminNote: 'False positive — the detector misread a self-contained card; no defect.', createdAt: at, updatedAt: at });
}
const ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  for (const k of ['TICKET_FAMILY_BATCHING_DISABLED', 'TICKET_FAMILY_PREFIX_V2_DISABLED', 'TICKET_FAMILY_PRECISION_ROUTING_DISABLED', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_CONCURRENCY_NIGHT', 'TICKET_LANE_MAX_DISPATCHES', 'TICKET_DISPATCH_DAILY_CAP', 'TICKET_DISPATCH_ANY_USER', 'TICKET_DISPATCH_FRESH_LANES_DISABLED']) delete process.env[k];
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope'; // force the DAY cap (4) whenever CI runs
  tickets = [];
  runs = [];
  kv.clear();
  chats.clear();
  spawnSeq = 0;
  chats.set(STANDING, { id: STANDING, userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
});
afterAll(() => { process.env = ENV; });

describe('V2 families batch (incomplete-card / missed-bug / av-mishap)', () => {
  function v2Rows(): Row[] {
    return [
      ticket('a1000001-1', { title: 'Incomplete owner card oq_d5948' }),
      ticket('a1000002-2', { title: 'Incomplete owner card oq_ea52c' }),
      ticket('a1000003-3', { title: 'Incomplete owner card oq_93960' }),
      ticket('b1000001-4', { title: 'Missed bug: owner frustration in chat 1a2b3c4d' }),
      ticket('b1000002-5', { title: 'Missed bug: owner frustration in chat 5e6f7a8b' }),
      ticket('c1000001-6', { type: 'mishap', title: 'Phantom evidence citation: chat cited id(s) that do not exist (chat 0a1b2c3d)', context: { verifier: 'action-verifier', sessionId: '0a1b2c3d-x' } }),
      ticket('c1000002-7', { type: 'mishap', title: 'Supervisor phantom claim: narrated action(s) never executed (chat 9f8e7d6c)', context: { verifier: 'action-verifier', sessionId: '9f8e7d6c-x' } }),
    ];
  }

  it('seven sweep / verifier rows take THREE family lanes, not seven solo lanes', async () => {
    tickets = v2Rows();
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 3 });
    const prompts = mockStartCodingSession.mock.calls.map((c) => c[0].prompt as string);
    expect(prompts.filter((p) => p.includes('family incomplete-card, 3 tickets'))).toHaveLength(1);
    expect(prompts.filter((p) => p.includes('family missed-bug, 2 tickets'))).toHaveLength(1);
    expect(prompts.filter((p) => p.includes('family av-mishap, 2 tickets'))).toHaveLength(1);
    for (const t of tickets) expect(t.status).toBe('in_progress');
  });

  it('TICKET_FAMILY_PREFIX_V2_DISABLED=1 restores one solo lane per row (day cap 4)', async () => {
    process.env.TICKET_FAMILY_PREFIX_V2_DISABLED = '1';
    tickets = v2Rows();
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(4);
    for (const c of mockStartCodingSession.mock.calls) expect(c[0].prompt).not.toContain('ticket-family lane');
  });
});

describe('noisy family: queued members, one lane per UTC day', () => {
  function noisyHistory(): Row[] {
    return [
      fpClose('d0000001-1', 'Incomplete owner card oq_00001', 20),
      fpClose('d0000002-2', 'Incomplete owner card oq_00002', 15),
      fpClose('d0000003-3', 'Incomplete owner card oq_00003', 10),
    ];
  }
  const queued = (id: string, title: string): Row => ticket(id, { status: 'queued', title, adminNote: 'Queued for the next incomplete-card family lane — …', context: { familyQueued: true, familyQueue: { key: 'incomplete-card' } } });

  it('queued members ride ONE family lane; the day token is set and the drain row says why', async () => {
    tickets = [...noisyHistory(), queued('e0000001-1', 'Incomplete owner card oq_10001'), queued('e0000002-2', 'Incomplete owner card oq_10002')];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].prompt).toContain('family incomplete-card, 2 tickets');
    for (const id of ['e0000001-1', 'e0000002-2']) {
      expect(byId(id).status).toBe('in_progress');
      expect(byId(id).context.family.key).toBe('incomplete-card');
    }
    expect(kv.get(`ticket-dispatch:family-day:incomplete-card:${DAY()}`)).toBeTruthy();
    const routing = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((m) => m.kind === 'ticket_family_routing');
    expect(routing.meta).toMatchObject({ phase: 'drain', noisySpawns: ['incomplete-card'], queuedRiding: 2 });
    expect(routing.meta.noisy[0]).toMatchObject({ family: 'incomplete-card', considered: 3, falsePositives: 3 });
  });

  it('a spent day: queued members stay queued, open members wait with the day note — no spawn, no claim', async () => {
    kv.set(`ticket-dispatch:family-day:incomplete-card:${DAY()}`, 'lane-earlier');
    tickets = [...noisyHistory(), queued('e0000001-1', 'Incomplete owner card oq_10001'), ticket('f0000001-1', { title: 'Incomplete owner card oq_20001' })];
    const r = await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(r.batched).toBe(0);
    expect(byId('e0000001-1').status).toBe('queued');
    expect(byId('e0000001-1').context.dispatchedTo).toBeUndefined();
    const open = byId('f0000001-1');
    expect(open.status).toBe('open');
    expect(open.adminNote).toMatch(/^Waiting for the next incomplete-card family lane — this family already ran its one lane today \(3 false positives \+ 0 siblings in its last 3 closes\)/);
    expect(isDispatcherNote(open.adminNote)).toBe(true);
    expect(kv.has('ticket-dispatch:f0000001-1')).toBe(false);
  });

  it('a HIGH-severity sighting in a spent noisy family still dispatches (fail toward delivery)', async () => {
    kv.set(`ticket-dispatch:family-day:raw-marker:${DAY()}`, 'lane-earlier');
    tickets = [
      fpClose('d1000001-1', 'Raw marker HARNESS survived in chat 11111111', 20),
      fpClose('d1000002-2', 'Raw marker HARNESS survived in chat 22222222', 15),
      fpClose('d1000003-3', 'Raw marker BATCH survived in chat 33333333', 10),
      ticket('a9000001-1', { priority: 1, title: 'Raw marker SEND_EMAIL (high) survived in chat 44444444', context: { severity: 'high', marker: 'SEND_EMAIL' } }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(1);
    expect(byId('a9000001-1').status).toBe('in_progress');
  });

  it('TICKET_FAMILY_PRECISION_ROUTING_DISABLED=1: a queued member is still drained (never stranded), day token ignored', async () => {
    process.env.TICKET_FAMILY_PRECISION_ROUTING_DISABLED = '1';
    kv.set(`ticket-dispatch:family-day:incomplete-card:${DAY()}`, 'lane-earlier');
    tickets = [...noisyHistory(), queued('e0000001-1', 'Incomplete owner card oq_10001')];
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(1);
    expect(byId('e0000001-1').status).toBe('in_progress');
    expect(mockRecordLoopMetric.mock.calls.map((c) => c[0].kind)).not.toContain('ticket_family_routing');
  });

  it('a family whose closes were true defects is not noisy — no day gate', async () => {
    kv.set(`ticket-dispatch:family-day:incomplete-card:${DAY()}`, 'lane-earlier');
    const at = new Date(Date.now() - 10 * H);
    tickets = [
      ticket('d2000001-1', { title: 'Incomplete owner card oq_00001', status: 'done', adminNote: 'Fixed the card writer.\n[machine-close evidence: commit abcdef1234567 (format-verified)]', createdAt: at, updatedAt: at }),
      ticket('d2000002-2', { title: 'Incomplete owner card oq_00002', status: 'done', adminNote: 'Fixed.\n[machine-close evidence: commit abcdef7654321 (format-verified)]', createdAt: at, updatedAt: at }),
      ticket('d2000003-3', { title: 'Incomplete owner card oq_00003', status: 'done', adminNote: 'False positive.', createdAt: at, updatedAt: at }),
      ticket('f0000001-1', { title: 'Incomplete owner card oq_20001' }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(1);
    expect(byId('f0000001-1').status).toBe('in_progress');
  });
});

describe('class-fix absorption: sightings that predate a merged class fix', () => {
  const FIX_NOTE = 'False positive: the HARNESS bracket was quoted inside a code block — detector narrowed.\n[machine-close evidence: commit abcdef1234567 (format-verified; existence not checkable server-side — no repo checkout in this process)]';

  it('absorbs a pre-fix raw-marker sighting of the SAME marker; dispatches a post-fix one and another marker', async () => {
    const fixedAt = new Date(Date.now() - 1 * H);
    tickets = [
      ticket('aaaa0001-fix', { title: 'Raw marker HARNESS survived in chat aaaa1111', status: 'done', adminNote: FIX_NOTE, context: { marker: 'HARNESS', closedAt: fixedAt.toISOString() }, createdAt: new Date(Date.now() - 5 * H), updatedAt: fixedAt }),
      ticket('bbbb0001-pre', { title: 'Raw marker HARNESS survived in chat bbbb2222', context: { marker: 'HARNESS' }, createdAt: new Date(Date.now() - 3 * H) }),
      ticket('cccc0001-post', { title: 'Raw marker HARNESS survived in chat cccc3333', context: { marker: 'HARNESS' }, createdAt: new Date(Date.now() - 30 * 60_000) }),
      ticket('dddd0001-other', { title: 'Raw marker SECRET survived in chat dddd4444', context: { marker: 'SECRET' }, createdAt: new Date(Date.now() - 3 * H) }),
    ];
    await drainOpenTicketsToLane();
    const pre = byId('bbbb0001-pre');
    expect(pre.status).toBe('done');
    expect(pre.context.duplicateOf).toBe('aaaa0001-fix');
    expect(pre.context.absorbedByClassFix).toMatchObject({ ticketId: 'aaaa0001-fix', key: 'raw-marker:HARNESS', commitSha: 'abcdef1234567' });
    expect(pre.context.autoDispatch).toBe(false);
    expect(pre.adminNote).toMatch(/^Absorbed at .+ — this raw-marker sighting predates the merged class fix in ticket aaaa0001-fix \(commit abcdef123456\)/);
    // The post-fix sighting and the other marker ride the raw-marker family lane.
    expect(byId('cccc0001-post').status).toBe('in_progress');
    expect(byId('dddd0001-other').status).toBe('in_progress');
    const prompt = mockStartCodingSession.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain('bbbb0001-pre');
    const routing = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((m) => m.kind === 'ticket_family_routing');
    expect(routing.meta.absorbed).toBe(1);
  });

  it('a sighting OBSERVED before the fix but filed after it (the sweep lookback) is absorbed via observedAt', async () => {
    const fixedAt = new Date(Date.now() - 1 * H);
    tickets = [
      ticket('aaaa0001-fix', { title: 'Raw marker HARNESS survived in chat aaaa1111', status: 'done', adminNote: FIX_NOTE, context: { marker: 'HARNESS', closedAt: fixedAt.toISOString() }, updatedAt: fixedAt }),
      ticket('bbbb0001-late', { title: 'Raw marker HARNESS survived in chat bbbb2222', context: { marker: 'HARNESS', observedAt: new Date(Date.now() - 2 * H).toISOString() }, createdAt: new Date(Date.now() - 20 * 60_000) }),
    ];
    await drainOpenTicketsToLane();
    expect(byId('bbbb0001-late').status).toBe('done');
    expect(mockStartCodingSession).not.toHaveBeenCalled();
  });

  it('detector-wide classes are NEVER absorbed (review 2026-10-20) — a detector narrowing puts the pre-narrowing members on a RE-CHECK line', async () => {
    const fixedAt = new Date(Date.now() - 1 * H);
    tickets = [
      ticket('aaaa0002-fix', { title: 'Incomplete owner card oq_fix01', status: 'done', adminNote: 'Fixed the card payload writer for this flow.\n[machine-close evidence: commit abcdef1234567 (format-verified)]', context: { closedAt: fixedAt.toISOString() }, updatedAt: fixedAt }),
      ticket('bbbb0002-pre', { title: 'Incomplete owner card oq_pre01', createdAt: new Date(Date.now() - 3 * H) }),
    ];
    await drainOpenTicketsToLane();
    expect(byId('bbbb0002-pre').status).toBe('in_progress'); // not absorbed
    expect(mockStartCodingSession.mock.calls[0][0].prompt).not.toContain('DETECTOR NARROWED'); // an instance fix is no narrowing

    jest.clearAllMocks();
    kv.clear();
    tickets = [
      ticket('aaaa0003-fix', { title: 'Missed bug: owner frustration in chat 1111aaaa', status: 'done', adminNote: 'False positive — owner was venting; detector narrowed.\n[machine-close evidence: commit 1234567abcdef (format-verified)]', context: { closedAt: fixedAt.toISOString() }, updatedAt: fixedAt }),
      // Each is a DIFFERENT chat's owner complaint — the narrowing says nothing about them.
      ticket('bbbb0003-pre', { title: 'Missed bug: owner frustration in chat 2222bbbb', createdAt: new Date(Date.now() - 3 * H) }),
      ticket('bbbb0004-pre', { title: 'Missed bug: owner frustration in chat 3333cccc', createdAt: new Date(Date.now() - 2 * H) }),
      ticket('bbbb0005-post', { title: 'Missed bug: owner frustration in chat 4444dddd', createdAt: new Date(Date.now() - 20 * 60_000) }),
    ];
    await drainOpenTicketsToLane();
    for (const id of ['bbbb0003-pre', 'bbbb0004-pre', 'bbbb0005-post']) {
      expect(byId(id).status).toBe('in_progress');
      expect(byId(id).context.duplicateOf).toBeUndefined();
    }
    const prompt = mockStartCodingSession.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('DETECTOR NARROWED — RE-CHECK: ticket aaaa0003-fix (commit 1234567abcde)');
    const recheck = prompt.split('\n').find((l) => l.startsWith('DETECTOR NARROWED'))!;
    expect(recheck).toContain('bbbb0003-pre');
    expect(recheck).toContain('bbbb0004-pre');
    expect(recheck).not.toContain('bbbb0005-post'); // sighted after the narrowing
    // The re-check line rides the TRUSTED region (before the untrusted fence).
    expect(prompt.indexOf('DETECTOR NARROWED')).toBeLessThan(prompt.indexOf('UNTRUSTED'));
    const routing = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((m) => m.kind === 'ticket_family_routing');
    expect(routing.meta).toMatchObject({ absorbed: 0, detectorRecheck: 2 });
  });

  it('the fix time is the CLOSE stamp, not updatedAt: a sighting after the close but before a later write (lane archive) is NOT absorbed', async () => {
    const closedAt = new Date(Date.now() - 5 * H);
    tickets = [
      // The lead closed 5 h ago; laneArchivedAt landed 1 h ago (its last rider closed) and moved updatedAt.
      ticket('aaaa0001-fix', { title: 'Raw marker SEND_EMAIL survived in chat aaaa1111', status: 'done', adminNote: FIX_NOTE, context: { marker: 'SEND_EMAIL', closedAt: closedAt.toISOString(), laneArchivedAt: new Date(Date.now() - 1 * H).toISOString() }, updatedAt: new Date(Date.now() - 1 * H) }),
      ticket('bbbb0006-recur', { title: 'Raw marker SEND_EMAIL survived in chat bbbb6666', context: { marker: 'SEND_EMAIL' }, createdAt: new Date(Date.now() - 3 * H) }),
      // An UNSTAMPED close (legacy / admin REST) never anchors an absorption.
      ticket('aaaa0007-nostamp', { title: 'Raw marker BATCH survived in chat aaaa7777', status: 'done', adminNote: FIX_NOTE, context: { marker: 'BATCH' }, updatedAt: new Date(Date.now() - 1 * H) }),
      ticket('bbbb0007-pre', { title: 'Raw marker BATCH survived in chat bbbb7777', context: { marker: 'BATCH' }, createdAt: new Date(Date.now() - 3 * H) }),
    ];
    await drainOpenTicketsToLane();
    expect(byId('bbbb0006-recur').status).toBe('in_progress');
    expect(byId('bbbb0006-recur').context.duplicateOf).toBeUndefined();
    expect(byId('bbbb0007-pre').status).toBe('in_progress');
  });

  it('a row a lane already carried, or one carrying a lane / admin note, is never absorbed', async () => {
    const fixedAt = new Date(Date.now() - 1 * H);
    tickets = [
      ticket('aaaa0001-fix', { title: 'Raw marker HARNESS survived in chat aaaa1111', status: 'done', adminNote: FIX_NOTE, context: { marker: 'HARNESS', closedAt: fixedAt.toISOString() }, updatedAt: fixedAt }),
      ticket('bbbb0008-stopped', { title: 'Raw marker HARNESS survived in chat bbbb8888', adminNote: 'Auto re-dispatch stopped — 3 ticket lanes ran without closing it; it needs a human look.', context: { marker: 'HARNESS', previousLanes: ['lane-a', 'lane-b', 'lane-c'], laneDispatches: 3 }, createdAt: new Date(Date.now() - 3 * H) }),
      ticket('bbbb0009-noted', { title: 'Raw marker HARNESS survived in chat bbbb9999', adminNote: 'Investigated: a different renderer path — still open.', context: { marker: 'HARNESS' }, createdAt: new Date(Date.now() - 3 * H) }),
    ];
    await drainOpenTicketsToLane();
    for (const id of ['bbbb0008-stopped', 'bbbb0009-noted']) {
      expect(byId(id).status).not.toBe('done');
      expect(byId(id).context.duplicateOf).toBeUndefined();
    }
  });

  it('a row already dispatched to a lane is never absorbed (its lane owns it)', async () => {
    const fixedAt = new Date(Date.now() - 1 * H);
    tickets = [
      ticket('aaaa0001-fix', { title: 'Raw marker HARNESS survived in chat aaaa1111', status: 'done', adminNote: FIX_NOTE, context: { marker: 'HARNESS', closedAt: fixedAt.toISOString() }, updatedAt: fixedAt }),
      ticket('bbbb0004-lane', { title: 'Raw marker HARNESS survived in chat bbbb2222', status: 'in_progress', context: { marker: 'HARNESS', dispatchMode: 'ticket_lane', dispatchedTo: 'lane-x', dispatchedAt: new Date().toISOString() }, createdAt: new Date(Date.now() - 3 * H) }),
    ];
    await drainOpenTicketsToLane();
    expect(byId('bbbb0004-lane').status).toBe('in_progress');
    expect(byId('bbbb0004-lane').context.duplicateOf).toBeUndefined();
  });

  it('TICKET_FAMILY_PRECISION_ROUTING_DISABLED=1: nothing is absorbed', async () => {
    process.env.TICKET_FAMILY_PRECISION_ROUTING_DISABLED = '1';
    tickets = [
      ticket('aaaa0001-fix', { title: 'Raw marker HARNESS survived in chat aaaa1111', status: 'done', adminNote: FIX_NOTE, context: { marker: 'HARNESS', closedAt: new Date(Date.now() - 1 * H).toISOString() }, updatedAt: new Date(Date.now() - 1 * H) }),
      ticket('bbbb0001-pre', { title: 'Raw marker HARNESS survived in chat bbbb2222', context: { marker: 'HARNESS' }, createdAt: new Date(Date.now() - 3 * H) }),
    ];
    await drainOpenTicketsToLane();
    expect(byId('bbbb0001-pre').status).toBe('in_progress');
  });
});

describe('review 2026-10-20: family-queued rows never strand', () => {
  const queuedFor = (id: string, title: string, over: Partial<Row> = {}): Row => ticket(id, { status: 'queued', title, adminNote: 'Queued for the next av-mishap family lane — this auto-filer family\'s recent closes were mostly not defects (…). It is queued, not lost.', context: { familyQueued: true, familyQueue: { key: 'av-mishap' }, verifier: 'action-verifier' }, ...over });

  it('an OUT-OF-SCOPE family-queued row goes back to open with the held note (approvable), never rides a lane', async () => {
    tickets = [
      queuedFor('c2000001-1', 'Phantom action claim: chat asserted action(s) never executed (chat 1a2b3c4d)', { userId: 'someone-else', user: { role: 'USER' } }),
      queuedFor('c2000002-2', 'Phantom action claim: chat asserted action(s) never executed (chat 5e6f7a8b)'),
    ];
    await drainOpenTicketsToLane();
    const held = byId('c2000001-1');
    expect(held.status).toBe('open');
    expect(held.adminNote).toMatch(/^Held for owner review/);
    expect(held.context.familyQueued).toBeUndefined();
    expect(held.context.familyUnqueued).toMatchObject({ reason: 'out_of_owner_scope' });
    expect(held.context.dispatchedTo).toBeUndefined();
    // The owner's own queued member still rides its family lane.
    expect(byId('c2000002-2').status).toBe('in_progress');
    expect(mockStartCodingSession.mock.calls[0][0].prompt).not.toContain('c2000001-1');
    const routing = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((m) => m.kind === 'ticket_family_routing');
    expect(routing.meta.unqueued).toBe(1);
  });

  it('one family\'s day-gated backlog never starves another family\'s queued members (per-family window)', async () => {
    kv.set(`ticket-dispatch:family-day:incomplete-card:${DAY()}`, 'lane-earlier');
    const old = (i: number) => new Date(Date.now() - (300 - i) * 60_000);
    tickets = [
      fpClose('d0000001-1', 'Incomplete owner card oq_00001', 20),
      fpClose('d0000002-2', 'Incomplete owner card oq_00002', 15),
      fpClose('d0000003-3', 'Incomplete owner card oq_00003', 10),
      fpClose('d1000001-1', 'Missed bug: owner frustration in chat 11111111', 20),
      fpClose('d1000002-2', 'Missed bug: owner frustration in chat 22222222', 15),
      fpClose('d1000003-3', 'Missed bug: owner frustration in chat 33333333', 10),
      // 45 OLDER incomplete-card members waiting for tomorrow's lane (more than the old 40-row window)…
      ...Array.from({ length: 45 }, (_, i) => ticket(`e${String(i).padStart(7, '0')}-1`, { status: 'queued', title: `Incomplete owner card oq_${String(10000 + i)}`, adminNote: 'Queued for the next incomplete-card family lane — …', context: { familyQueued: true }, createdAt: old(i), updatedAt: old(i) })),
      // …and one NEWER missed-bug member whose family has not run today.
      ticket('f9000001-1', { status: 'queued', title: 'Missed bug: owner frustration in chat 9f9f9f9f', adminNote: 'Queued for the next missed-bug family lane — …', context: { familyQueued: true } }),
    ];
    await drainOpenTicketsToLane();
    expect(byId('f9000001-1').status).toBe('in_progress');
    expect(mockStartCodingSession.mock.calls.map((c) => c[0].prompt as string).some((p) => p.includes('family missed-bug'))).toBe(true);
    // The spent family's members stay queued (no note churn, no claim).
    expect(tickets.filter((t) => t.title.startsWith('Incomplete owner card oq_1') && t.status === 'queued')).toHaveLength(45);
  });

  it('the STANDING-LANE path (fresh lanes off) hands family-queued rows back to open — it reads open rows only', async () => {
    process.env.TICKET_DISPATCH_FRESH_LANES_DISABLED = '1';
    tickets = [queuedFor('c3000001-1', 'Phantom action claim: chat asserted action(s) never executed (chat 1a2b3c4d)')];
    await drainOpenTicketsToLane();
    const row = byId('c3000001-1');
    expect(row.status).not.toBe('queued');
    expect(row.context.familyQueued).toBeUndefined();
    expect(row.context.familyUnqueued).toMatchObject({ reason: 'standing_lane_path' });
  });
});
