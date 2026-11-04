/**
 * PIN (ticket fffacaee, 2026-10-20) — LEG 2 of 2: the DISPATCH side. One
 * infra-alert key never takes TWO dedicated ticket lanes.
 *
 * THE DEFECT THIS PINS: deploy run 39441731823 (sha 51946acc) produced two
 * alert tickets (b612be26 + 9e0c9f5a, ~50 s apart) and the drain opened a
 * DEDICATED lane for EACH (815f7de8 + 66c8d2ed, both dispatched ~15:09Z) —
 * two parallel lanes chartered to fix one failure; the Fleet Supervisor had
 * to de-conflict by hand and one lane's spend was pure duplication.
 *
 * THE FIX (dispatch side, ticket-dispatch.service.ts): the drain builds
 * infraAlertHeld (keys held by LIVE lanes' tickets) + claimedAlertKeys (keys
 * claimed by a row spawned EARLIER IN THE SAME DRAIN — the incident shape:
 * both rows open, no lane exists yet, one drain would have spawned BOTH) and
 * the eligibility loop refuses a same-key row: no lane, no slot, no claim;
 * the duplicate carries the collision note (registered in
 * DISPATCHER_NOTE_RE) and the holder's row records context.collisions for
 * the supervisor.
 *
 * The FILING leg is pinned in infra-alert-key.fffacaee.test.ts. This file
 * runs the drain on the 9dacab1a SELECT/WHERE-faithful mock harness.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { makeFaithfulFindMany, mockMatchesWhere, mockApplySelect, type MockRow } from './ticket-dispatch.mock.9dacab1a';

// The incident's verbatim rows (both real titles + description heads).
const RUN = '39441731823';
const SHA = '51946acc';
const REPO = 'canada-quant/digby';
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN}`;
const TITLE_A = `Deploy run ${RUN} failed (sha ${SHA}, CI also red) — fix and re-run`;
const TITLE_B = `Deploy run ${RUN} failed on main head ${SHA} — fix and re-run`;
const DESC_A = `INFRA ALERT (deploy failed, seen 2026-10-20T14:53Z): GitHub deploy run ${RUN} for sha ${SHA} ("Merge remote-tracking branch 'origin/main'…") concluded FAILURE (started 2026-10-20T14:42:47Z): ${RUN_URL} — and the same-sha CI (ci.yml) verdict is ALSO failure, so the code on main is genuinely red.`;
const DESC_B = `[INFRA ALERT — deploy failed, fleet supervisor dispatch 2026-10-20T14:54Z]\n\nFailed run: ${RUN_URL}\n- Deploy run ${RUN} for sha ${SHA} ("Merge remote-tracking branch 'origin/main' into claude/relaxed-pasteur-0k7de0", committed 2026-10-20T14:38:31Z) concluded FAILURE (started 14:42:47Z, ended 14:47:52Z).`;

type Row = MockRow & {
  id: string; type: string; title: string; description: string; priority: number; source: string;
  status: string; adminNote: string | null; context: any; createdAt: Date; updatedAt: Date; userId?: string | null;
  user?: { role?: string | null } | null;
};
let tickets: Row[] = [];
let runs: Array<{ sessionId: string; status: string; createdAt: Date; updatedAt: Date }> = [];
const chats = new Map<string, { userId: string; projectId: string | null; archivedAt: Date | null }>();

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
  crossModelProject: { findUnique: jest.fn(async () => null) },
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
    del: jest.fn(async (k: string) => { kv.delete(k); return 1; }),
    decr: jest.fn(async (k: string) => { const n = Number(kv.get(k) ?? 0) - 1; kv.set(k, String(n)); return n; }),
  },
}));

let spawnSeq = 0;
const mockStartCodingSession = jest.fn(async (_opts: any) => ({ id: `${String(++spawnSeq).padStart(8, 'e')}-lane-session` }));
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: (o: any) => mockStartCodingSession(o),
  sendChatMessage: jest.fn(async () => ({ queued: true })),
  archiveChat: jest.fn(async ({ chatId }: any) => ({ id: chatId, archived: true })),
}));

// The slot-release notice dynamically imports hooks.service, whose graph
// (error-handler → config/env) calls process.exit without env vars — mock the
// boundary (bf656696 harness pattern).
const mockEmitHookEventSafe = jest.fn(async () => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...(a as [])),
}));

import { drainOpenTicketsToLane, isDispatcherNote } from './ticket-dispatch.service';

const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'enhancement', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 0, source: 'agent', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), ...over,
  };
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;
const ENV = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  delete process.env.FEEDBACK_INFRA_ALERT_DEDUP_DISABLED;
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope'; // force the day cap path
  tickets = [];
  runs = [];
  kv.clear();
  chats.clear();
  spawnSeq = 0;
  chats.set(STANDING, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
});
afterAll(() => { process.env = ENV; });

describe('fffacaee — DISPATCH leg: no second lane for one infra-alert key', () => {
  it('THE INCIDENT SHAPE: two OPEN alert tickets, same run id, no lane yet — ONE lane spawns, the duplicate is held with the collision note and the holder records the collision', async () => {
    tickets = [
      ticket('alert-815f-0000-0000000000b1', { priority: 4, title: TITLE_A, description: DESC_A, createdAt: new Date(Date.now() - 20 * 60_000) }),
      ticket('alert-66c8-0000-0000000000b2', { priority: 4, title: TITLE_B, description: DESC_B, createdAt: new Date(Date.now() - 19 * 60_000) }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 }); // ONE spawn, not two
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    // The FIRST row (scan order: same priority, older createdAt first) spawned.
    const spawnedId = 'alert-815f-0000-0000000000b1';
    expect(byId(spawnedId).status).toBe('in_progress');
    expect(byId(spawnedId).context.dispatchedTo).toBeTruthy();
    // The duplicate: still open, no dispatch stamp, collision note set.
    const dup = byId('alert-66c8-0000-0000000000b2');
    expect(dup.status).toBe('open');
    expect(dup.context.dispatchedTo).toBeUndefined();
    expect(String(dup.adminNote)).toMatch(/^Held — duplicate infra alert: ticket /);
    expect(String(dup.adminNote)).toContain('ticket alert-81'); // the holder's 8-char id prefix
    expect(String(dup.adminNote)).toContain('lane spawning this drain'); // same-drain claim, no lane id yet
    expect(isDispatcherNote(dup.adminNote)).toBe(true); // registered shape — later drains keep owning the note
    // The holder's row records the collision for the supervisor.
    const collisions = byId(spawnedId).context.collisions;
    expect(Array.isArray(collisions)).toBe(true);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({ ticketId: 'alert-66c8-0000-0000000000b2', key: `deploy-failure:${RUN}:${REPO}` });
  });

  it('CROSS-DRAIN: a NEW same-key open ticket is refused while the holder\'s lane is LIVE; the kill switch reverts the guard', async () => {
    // The holder: dispatched 20h ago, lane live (a running agent run).
    const liveLane = 'lane-00000-0000-0000-0000-0000000000c1';
    tickets = [
      ticket('held-0000-0000-0000000000c2', {
        priority: 4, status: 'in_progress', title: TITLE_A, description: DESC_A,
        adminNote: 'Queued — ticket lane lane-0000 starts it (dispatched 2026-10-20T15:09:17.782Z, dispatch 1 of 3).',
        context: { dispatchMode: 'ticket_lane', dispatchedTo: liveLane, dispatchedAt: new Date(Date.now() - 20 * 3600_000).toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 },
        createdAt: new Date(Date.now() - 21 * 3600_000), updatedAt: new Date(Date.now() - 20 * 3600_000),
      }),
      ticket('dup-00000-0000-0000000000c3', { priority: 4, title: TITLE_B, description: DESC_B, createdAt: new Date(Date.now() - 30 * 60_000) }),
    ];
    runs = [{ sessionId: liveLane, status: 'running', createdAt: new Date(Date.now() - 5 * 60_000), updatedAt: new Date(Date.now() - 60_000) }];
    chats.set(liveLane, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
    let r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'deduped', batched: 0 }); // refused — nothing spawned
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(String(byId('dup-00000-0000-0000000000c3').adminNote)).toMatch(/^Held — duplicate infra alert: ticket /);
    // The holder's row records the collision (surface to the supervisor).
    expect(byId('held-0000-0000-0000000000c2').context.collisions).toHaveLength(1);
    // The kill switch reverts the guard (the duplicate spawns — pre-fix behavior).
    process.env.FEEDBACK_INFRA_ALERT_DEDUP_DISABLED = '1';
    r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
  });

  it('NON-ALERT tickets are untouched: two ordinary open tickets both spawn (regression guard)', async () => {
    tickets = [
      ticket('plain-0000-0000-0000000000c4', { priority: 4, title: 'Send button unresponsive on mobile', description: 'Tapping send does nothing.' }),
      ticket('plain-0000-0000-0000000000c5', { priority: 4, title: 'Search box loses focus on iOS', description: 'The keyboard dismisses.' }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r).toEqual({ result: 'sent', batched: 2 });
    expect(mockStartCodingSession).toHaveBeenCalledTimes(2);
    expect(byId('plain-0000-0000-0000000000c4').adminNote).toMatch(/^Queued — ticket lane /);
    expect(byId('plain-0000-0000-0000000000c5').adminNote).toMatch(/^Queued — ticket lane /);
  });

  it('A META ticket about the duplicate-alert defect never collides with the alert holder (strict gating on the dispatch side)', async () => {
    const liveLane = 'lane-00000-0000-0000-0000-0000000000e1';
    tickets = [
      ticket('held-0000-0000-0000000000e2', {
        priority: 4, status: 'in_progress', title: TITLE_A, description: DESC_A,
        context: { dispatchMode: 'ticket_lane', dispatchedTo: liveLane, dispatchedAt: new Date(Date.now() - 20 * 3600_000).toISOString() },
      }),
      // fffacaee's own shape: names the run id + URL in prose, but is NOT alert-shaped.
      ticket('meta-0000-0000-0000000000e3', {
        priority: 2, title: 'Infra-alert dispatcher double-files/double-dispatches one failed deploy run (two tickets ~50s apart, two lanes)',
        description: `Evidence: deploy run ${RUN} (sha ${SHA}) produced two tickets. See ${RUN_URL}. Fix: dedup on the stable key.`,
        createdAt: new Date(Date.now() - 30 * 60_000),
      }),
    ];
    runs = [{ sessionId: liveLane, status: 'running', createdAt: new Date(Date.now() - 5 * 60_000), updatedAt: new Date(Date.now() - 60_000) }];
    chats.set(liveLane, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
    const r = await drainOpenTicketsToLane();
    // the meta ticket dispatches normally — it is a DIFFERENT ticket.
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(byId('meta-0000-0000-0000000000e3').status).toBe('in_progress');
    expect(String(byId('meta-0000-0000-0000000000e3').adminNote)).toMatch(/^Queued — ticket lane /);
  });

  it('the collision note does not wedge a lane\'s OWN note: a row whose adminNote was written by a lane keeps it (isDispatcherNote gate)', async () => {
    const laneNote = 'Lane 7 report: fix in progress on branch x.';
    const liveLane = 'lane-00000-0000-0000-0000-0000000000d1';
    tickets = [
      ticket('held-0000-0000-0000000000d2', {
        priority: 4, status: 'in_progress', title: TITLE_A, description: DESC_A,
        context: { dispatchMode: 'ticket_lane', dispatchedTo: liveLane, dispatchedAt: new Date(Date.now() - 20 * 3600_000).toISOString() },
      }),
      ticket('dup-00000-0000-0000000000d3', { priority: 4, title: TITLE_B, description: DESC_B, adminNote: laneNote }),
    ];
    runs = [{ sessionId: liveLane, status: 'running', createdAt: new Date(Date.now() - 5 * 60_000), updatedAt: new Date(Date.now() - 60_000) }];
    chats.set(liveLane, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
    await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    // the lane's note survives (the guard never overwrites a non-dispatcher note)
    expect(byId('dup-00000-0000-0000000000d3').adminNote).toBe(laneNote);
  });

  it('A DEAD holder lane releases the key: a same-key duplicate whose holder went idle+stale dispatches (no wedge)', async () => {
    const deadLane = 'lane-00000-0000-0000-0000-0000000000f1';
    tickets = [
      ticket('held-0000-0000-0000000000f2', {
        priority: 4, status: 'in_progress', title: TITLE_A, description: DESC_A,
        adminNote: 'Queued — ticket lane lane-0000 starts it (dispatched 2026-10-20T15:09:17.782Z, dispatch 1 of 3).',
        context: { dispatchMode: 'ticket_lane', dispatchedTo: deadLane, dispatchedAt: new Date(Date.now() - 30 * 3600_000).toISOString(), laneDispatches: 1, laneDispatchEpoch: 0 },
        createdAt: new Date(Date.now() - 31 * 3600_000), updatedAt: new Date(Date.now() - 30 * 3600_000),
      }),
      ticket('dup-00000-0000-0000000000f3', { priority: 4, title: TITLE_B, description: DESC_B, createdAt: new Date(Date.now() - 30 * 60_000) }),
    ];
    // The holder lane exists but has NO live run and its last activity is old.
    runs = [{ sessionId: deadLane, status: 'COMPLETED', createdAt: new Date(Date.now() - 30 * 3600_000), updatedAt: new Date(Date.now() - 28 * 3600_000) }];
    chats.set(deadLane, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
    const r = await drainOpenTicketsToLane();
    // The dead holder no longer holds the key: the duplicate's OWN row is the
    // reclaimable one here — one spawn happens (the stale reclaim path owns
    // the holder), never zero (nothing wedged behind a dead lane).
    expect(r.result).toBe('sent');
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
  });
});
