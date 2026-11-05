/**
 * Ticket d34f1d6a — the OVERNIGHT QUEUE STALL (Oct 16-17): 3/3 day slots
 * held for 5h+ by live-but-IDLE deploy-poll lanes. A lane whose every
 * command is `sleep 300; gh run list …` keeps its agentRun row `running`
 * (each poll bumps updatedAt), so holdsSlot() counted it occupied forever —
 * 40 tickets waiting, 0 spawned, the queue dead until a human looked.
 *
 * Replay pins (the ticket's acceptance + the guards):
 *   1. IDLE SURRENDER: a LIVE lane whose whole trailing 20 min of
 *      agent_events tool_call rows is sleep/poll commands no longer counts
 *      as occupied — the slot is released and counted free WITHIN THE SAME
 *      DRAIN (a waiting ticket dispatches on that drain). The ticket stays
 *      in_progress (the lane keeps running; never a double dispatch).
 *   2. HARD CAP: a live lane dispatched > 3 h ago (TICKET_LANE_SLOT_CAP_HOURS)
 *      is force-released — slot free, ONE attention_needed notice to the
 *      supervisor thread, a ticket_lane_slot_release loop_metrics row, and a
 *      truthful adminNote. The lane is never stopped; the ticket is NOT
 *      re-dispatched while the lane still runs (the 8 h idle path owns
 *      re-dispatch — two lanes never race one ticket).
 *   3. The classifier (isIdlePollCommand): the prod stall shape
 *      (`sleep 300; gh run list …`) and its siblings surrender; real work
 *      (a build, a test, an edit), read-only lanes with no sleep, and an
 *      events outage NEVER surrender (fail-closed: unknown ⇒ keeps its slot).
 *   4. Episode discipline: the note / notice / metric fire ONCE per release
 *      episode; the SLOT stays free on every drain of the episode.
 *   5. Kill switch TICKET_LANE_SLOT_RELEASE_DISABLED=1 restores the pre-fix
 *      accounting (the idle lane holds its slot again).
 *   6. Window spanning: polling that only just started (the oldest event
 *      younger than the window minus one poll interval) does NOT surrender.
 *
 * Harness: the fresh-lanes suite's shape (mocked prisma/redis/platform
 * seams) + an agent_events fixture the drain's idle classifier reads.
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
type RunRow = { id: string; sessionId: string; status: string; createdAt: Date; updatedAt: Date };
let runs: RunRow[] = [];
type EventRow = { runId: string; type: string; payload: any; createdAt: Date };
let events: EventRow[] = [];
const chats = new Map<string, { userId: string; projectId: string | null; archivedAt: Date | null }>();

function matchesWhere(r: Row, where: any): boolean {
  if (!where) return true;
  if (where.id && typeof where.id === 'string' && r.id !== where.id) return false;
  if (where.id?.in && !where.id.in.includes(r.id)) return false;
  if (typeof where.status === 'string' && r.status !== where.status) return false;
  if (where.status?.in && !where.status.in.includes(r.status)) return false;
  if (where.updatedAt?.gte && r.updatedAt < where.updatedAt.gte) return false;
  return true;
}

const mockEmitHookEvent = jest.fn(async (..._args: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEvent(...(a as [])),
}));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...(a as [])),
}));

const mockArchiveChat = jest.fn(async ({ chatId }: any) => {
  const c = chats.get(chatId);
  if (c) c.archivedAt = new Date();
  return { id: chatId, archived: true };
});

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
    // Two call shapes: readLaneStates (select sessionId/status/createdAt/
    // updatedAt, orderBy createdAt asc) and the release pass's run-ids
    // lookup (select id+sessionId — ALL runs, newest first).
    findMany: jest.fn(async ({ where, orderBy, take, select }: any) => {
      if (select?.id) {
        // run-ids lookup (release pass)
        return runs
          .filter((r) => where.sessionId.in.includes(r.sessionId))
          .sort((a, b) => +b.createdAt - +a.createdAt)
          .slice(0, take ?? 200)
          .map((r) => ({ id: r.id, sessionId: r.sessionId }));
      }
      // readLaneStates shape
      return runs
        .filter((r) => where.sessionId.in.includes(r.sessionId))
        .sort((a, b) => +a.createdAt - +b.createdAt)
        .slice(0, take ?? 1000)
        .map((r) => ({ sessionId: r.sessionId, status: r.status, createdAt: r.createdAt, updatedAt: r.updatedAt }));
    }),
    count: jest.fn(async ({ where }: any) => runs.filter((r) => r.sessionId === where.sessionId
      && (!where.status?.in || where.status.in.includes(r.status))
      && (!where.updatedAt?.gte || r.updatedAt >= where.updatedAt.gte)).length),
  },
  agentEvent: {
    findMany: jest.fn(async ({ where, orderBy, take }: any) => {
      const dir = Array.isArray(orderBy) ? orderBy[0]?.createdAt : orderBy?.createdAt;
      return events
        .filter((e) => where.runId?.in?.includes(e.runId)
          && e.type === where.type
          && (!where.createdAt?.gte || e.createdAt >= where.createdAt.gte))
        .sort((a, b) => (dir === 'desc' ? +b.createdAt - +a.createdAt : +a.createdAt - +b.createdAt))
        .slice(0, take ?? 120)
        .map((e) => ({ payload: e.payload, createdAt: e.createdAt }));
    }),
  },
  chatCodingState: { findMany: jest.fn(async () => []) },
  // TICKET-LANE ARCHIVE GAPS review (2026-10-21): archiveTicketLane's owner-armed
  // schedule guard reads this (fail-closed without it) — no owner rows here.
  chatSchedule: { findMany: jest.fn(async () => []) },
  contextStoreEntry: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Redis with real NX semantics (drain lock, per-ticket claims, release episodes).
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
const mockStartCodingSession = jest.fn(async (_opts: any) => ({ id: `${String(++spawnSeq).padStart(8, 'p')}-lane-session` }));
jest.mock('../platform/platform.service', () => ({
  __esModule: true,
  startCodingSession: (o: any) => mockStartCodingSession(o),
  sendChatMessage: jest.fn(async () => ({ queued: true })),
  archiveChat: (o: any) => mockArchiveChat(o),
}));

import { drainOpenTicketsToLane, isIdlePollCommand } from './ticket-dispatch.service';

const H = 3600_000;
const MIN = 60_000;
const STANDING = 'b92ef13f-c3f8-487e-8267-767e56543150';
// 8-hex-char prefixes so DISPATCHER_NOTE_RE (Ticket lane [0-9a-f]{8} …)
// matches them — the note-ownership semantics are testable only with hex
// lane ids (review finding 11).
const PARKED = 'a11ce001-0000-0000-0000-000000000001';
const WORKER = 'b0b0b0b0-0000-0000-0000-000000000002';

function ticket(id: string, over: Partial<Row> = {}): Row {
  return {
    id, type: 'bug_report', title: `Ticket ${id} title words here`, description: `Description of ${id}.`,
    priority: 3, source: 'user', status: 'open', adminNote: null, context: {}, userId: 'owner-1',
    createdAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 60_000), ...over,
  };
}
const byId = (id: string) => tickets.find((t) => t.id === id)!;
const ENV = { ...process.env };

/** The prod idle-park command from the Oct 16-17 stall. */
const POLL_CMD = 'sleep 300; gh run list --limit 5 --json status,conclusion,databaseId';

/** Populate `events` with poll tool_calls spaced `spacingMin` apart (default
 *  5 — the prod poll cadence), the oldest `spanMin` minutes old. */
function pollEvents(runId: string, spanMin: number, n = 5, cmd: string = POLL_CMD, spacingMin = 5): void {
  const now = Date.now();
  events = [];
  for (let i = 0; i < n; i++) {
    const ageMin = spanMin - i * spacingMin; // oldest = spanMin, newest = spanMin - (n-1)*spacing
    if (ageMin < 0) break; // never a future event
    events.push({ runId, type: 'tool_call', payload: { name: 'run_command', args: { command: cmd } }, createdAt: new Date(now - ageMin * MIN) });
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...ENV };
  process.env.TICKET_DISPATCH_ENABLED = 'true';
  process.env.PLATFORM_ENGINEER_CHAT_ID = STANDING;
  for (const k of ['TICKET_DISPATCH_FRESH_LANES_DISABLED', 'TICKET_LANE_CONCURRENCY', 'TICKET_LANE_CONCURRENCY_NIGHT', 'TICKET_LANE_NIGHT_HOURS',
    'TICKET_LANE_SLOT_RELEASE_DISABLED', 'TICKET_LANE_IDLE_SURRENDER_MINUTES', 'TICKET_LANE_SLOT_CAP_HOURS', 'TICKET_DISPATCH_DAILY_CAP']) delete process.env[k];
  process.env.TICKET_LANE_NIGHT_HOURS = 'nope'; // day cap no matter what hour CI runs
  tickets = [];
  runs = [];
  events = [];
  kv.clear();
  chats.clear();
  spawnSeq = 0;
  mockEmitHookEvent.mockClear();
  mockRecordLoopMetric.mockClear();
  chats.set(STANDING, { userId: 'owner-1', projectId: 'proj-crossmodel', archivedAt: null });
});
afterAll(() => { process.env = ENV; });

/** A live lane ticket row: dispatched to `lane`, running, with a run row. */
function laneTicket(id: string, lane: string, dispatchedAgoMs: number, note = 'Queued — ticket lane x starts it.'): Row {
  const at = new Date(Date.now() - dispatchedAgoMs).toISOString();
  runs.push({ id: `run-${lane}`, sessionId: lane, status: 'running', createdAt: new Date(Date.now() - dispatchedAgoMs + 60_000), updatedAt: new Date() });
  return ticket(id, {
    status: 'in_progress', adminNote: note,
    context: { dispatchMode: 'ticket_lane', dispatchedTo: lane, dispatchedAt: at, laneDispatches: 1, laneDispatchEpoch: 0 },
  });
}
// ── 1. Idle surrender: the slot is released WITHIN THE SAME DRAIN ────────────

describe('d34f1d6a — idle sleep/poll lane surrenders its slot', () => {
  it('a live lane parked on sleep/deploy-poll for 20+ min frees its slot on THIS drain — a waiting ticket dispatches immediately', async () => {
    // The Oct 16-17 shape: dispatched 4 h ago, its whole trailing window is
    // sleep 300; gh run list (under the 3 h cap? NO — 4h > 3h cap. Use 2.5h
    // so the IDLE path fires, not the cap path.)
    tickets = [
      laneTicket('parked111-0', PARKED, 2.5 * H, 'Ticket lane a11ce001 working since earlier (dispatch 1 of 3).'),
      ticket('wait1111-1', { priority: 1 }),
    ];
    pollEvents(`run-${PARKED}`, 20);
    const r = await drainOpenTicketsToLane();
    // The waiting ticket spawned ON THIS DRAIN: 3 slots, 1 parked lane
    // released ⇒ 2 free ⇒ wait1111-1 gets a lane.
    expect(r).toEqual({ result: 'sent', batched: 1 });
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].prompt).toContain('wait1111-1');
    // The parked lane's ticket stays in_progress, its lane untouched.
    expect(byId('parked111-0').status).toBe('in_progress');
    expect(byId('parked111-0').context.dispatchedTo).toBe(PARKED);
    expect(mockArchiveChat).not.toHaveBeenCalledWith(expect.objectContaining({ chatId: PARKED }));
    // Truthful note: the surrender is on the row.
    expect(byId('parked111-0').adminNote).toContain('surrendered its ticket-lane slot');
    expect(byId('parked111-0').adminNote).toContain('sleep/poll');
    // ONE supervisor notice for the episode.
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
    const [chatId, type, text] = mockEmitHookEvent.mock.calls[0];
    expect(chatId).toBe(PARKED);
    expect(type).toBe('attention_needed');
    expect(text).toContain('sleep/poll');
    // The telemetry row.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ticket_lane_slot_release', meta: expect.objectContaining({ reason: 'idle', laneId: PARKED }) }));
  });

  it('the slot stays free on the NEXT drain of the episode (no re-notice, no re-metric, still not occupied)', async () => {
    tickets = [laneTicket('parked111-0', PARKED, 2.5 * H, 'Ticket lane a11ce001 working since earlier (dispatch 1 of 3).')];
    pollEvents(`run-${PARKED}`, 20);
    await drainOpenTicketsToLane(); // first drain: episode claimed
    mockEmitHookEvent.mockClear();
    mockRecordLoopMetric.mockClear();
    tickets.push(ticket('wait2222-1', { priority: 1 }));
    await drainOpenTicketsToLane(); // second drain, same episode
    // The waiting ticket spawns (the parked lane STILL does not count).
    expect(mockStartCodingSession).toHaveBeenCalledTimes(1);
    expect(mockStartCodingSession.mock.calls[0][0].prompt).toContain('wait2222-1');
    // No second notice / metric for the same episode.
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('a lane doing REAL work keeps its slot (a build/test command in the window)', async () => {
    tickets = [
      laneTicket('busy1111-0', WORKER, 2.5 * H, 'Ticket lane b0b0b0b0 working since earlier (dispatch 1 of 3).'),
      ticket('wait3333-1', { priority: 1 }),
    ];
    // Trailing window: one poll + one real build command.
    pollEvents(`run-${WORKER}`, 20, 5);
    events.unshift({ runId: `run-${WORKER}`, type: 'tool_call', payload: { name: 'run_command', args: { command: 'cd backend && npm test -- --watchAll=false' } }, createdAt: new Date(Date.now() - 3 * MIN) });
    const r = await drainOpenTicketsToLane();
    // The busy lane holds its slot: 3 slots, 1 occupied ⇒ 2 free anyway, so
    // the waiting ticket spawns — but the busy lane's note must still be the
    // dispatcher's working note, and NO release fired.
    expect(r.batched).toBe(1);
    expect(byId('busy1111-0').adminNote).not.toContain('surrendered');
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('a read-only lane with NO sleep commands is NOT idle-park (fail-closed for slow reads)', async () => {
    tickets = [laneTicket('read1111-0', WORKER, 2.5 * H)];
    // Trailing window: read_file / list_dir calls — no sleep, no poll.
    const now = Date.now();
    events = [];
    for (let i = 0; i < 5; i++) {
      events.push({ runId: `run-${WORKER}`, type: 'tool_call', payload: { name: 'read_file', args: { path: 'src/x.ts' } }, createdAt: new Date(now - (20 - i * 4) * MIN) });
    }
    await drainOpenTicketsToLane();
    expect(byId('read1111-0').adminNote).not.toContain('surrendered');
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  it('an events outage (no tool_call rows in the window) keeps the slot (fail-closed)', async () => {
    tickets = [laneTicket('quiet111-0', PARKED, 2.5 * H)];
    // No events at all — the classifier must read NOT idle.
    await drainOpenTicketsToLane();
    expect(byId('quiet111-0').adminNote).not.toContain('surrendered');
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  it('polling that only just started (window not spanned) does NOT surrender', async () => {
    tickets = [laneTicket('fresh111-0', PARKED, 2.5 * H)];
    pollEvents(`run-${PARKED}`, 8); // oldest event 8 min old — inside the 20-min window but not spanning it
    await drainOpenTicketsToLane();
    expect(byId('fresh111-0').adminNote).not.toContain('surrendered');
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  it('TICKET_LANE_IDLE_SURRENDER_MINUTES tunes the window (5 min ⇒ a 6-min-old park surrenders)', async () => {
    process.env.TICKET_LANE_IDLE_SURRENDER_MINUTES = '5';
    tickets = [laneTicket('tuned111-0', PARKED, 30 * MIN)];
    pollEvents(`run-${PARKED}`, 4, 3, POLL_CMD, 2); // events 4, 2, 0 min old — all inside the 5-min window, oldest 4 ≥ 2.5
    await drainOpenTicketsToLane();
    expect(byId('tuned111-0').adminNote).toContain('surrendered');
  });

  it('review f1: a lane/human note is NEVER overwritten by the release (the notice + metric still fire)', async () => {
    tickets = [laneTicket('noted111-0', PARKED, 2.5 * H, 'PROGRESS: fix built, waiting on deploy')];
    pollEvents(`run-${PARKED}`, 20);
    await drainOpenTicketsToLane();
    expect(byId('noted111-0').adminNote).toBe('PROGRESS: fix built, waiting on deploy');
    // But the release still happened (notice + metric).
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ticket_lane_slot_release', meta: expect.objectContaining({ reason: 'idle' }) }));
  });

  it('review f4: a live lane on a SELF-REOPENED (open) ticket is also released — the cap cannot be bypassed by status', async () => {
    const at = new Date(Date.now() - 5 * H).toISOString();
    runs.push({ id: `run-${WORKER}`, sessionId: WORKER, status: 'running', createdAt: new Date(Date.now() - 5 * H), updatedAt: new Date() });
    tickets = [
      ticket('reopen111-0', {
        status: 'open', adminNote: null,
        context: { dispatchMode: 'ticket_lane', dispatchedTo: WORKER, dispatchedAt: at, laneDispatches: 1, laneDispatchEpoch: 0 },
      }),
      ticket('wait6666-1', { priority: 1 }),
    ];
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(1); // the waiting ticket spawned — the 5h open-status lane's slot is free
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ticket_lane_slot_release', meta: expect.objectContaining({ reason: 'cap', laneId: WORKER }) }));
  });

  it('review f7: the idle note reports the PARK duration (oldest poll event), not the dispatch age', async () => {
    // Dispatched 2.5 h ago (under the 3 h cap so the IDLE path fires);
    // polling only for the last 20 min.
    tickets = [laneTicket('dur1111-0', PARKED, 2.5 * H)];
    pollEvents(`run-${PARKED}`, 20);
    await drainOpenTicketsToLane();
    const note = String(byId('dur1111-0').adminNote ?? '');
    // ~20 min (the oldest poll event's age), NOT ~150 min (the dispatch age).
    expect(note).toMatch(/for (1[5-9]|2[0-9]) min/);
    expect(note).not.toMatch(/for 1[0-9]{2} min/);
  });

  it('kill switch TICKET_LANE_SLOT_RELEASE_DISABLED=1 restores the pre-fix accounting (the parked lane holds its slot)', async () => {
    process.env.TICKET_LANE_SLOT_RELEASE_DISABLED = '1';
    tickets = [
      laneTicket('killed111-0', PARKED, 2.5 * H, 'Ticket lane a11ce001 working since earlier (dispatch 1 of 3).'),
      ticket('wait4444-1', { priority: 1 }),
    ];
    pollEvents(`run-${PARKED}`, 20);
    const r = await drainOpenTicketsToLane();
    // 3 slots, 1 held by the parked lane ⇒ 2 free ⇒ the waiting ticket still
    // spawns — but NO release happened (no note, no notice, no metric).
    expect(r.batched).toBe(1);
    expect(byId('killed111-0').adminNote).not.toContain('surrendered');
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});

// ── 2. The hard per-lane slot cap ────────────────────────────────────────────

describe('d34f1d6a — hard per-lane slot cap (default 3 h)', () => {
  it('a live lane dispatched > 3 h ago is force-released: slot free, ONE supervisor notice, a metric row, a truthful note', async () => {
    // The eebace78 shape: 5h+ hold, productively running (real commands —
    // the cap fires regardless of what the lane is doing).
    tickets = [
      laneTicket('long1111-0', WORKER, 5 * H, 'Ticket lane b0b0b0b0 working since earlier (dispatch 1 of 3).'),
      ticket('wait5555-1', { priority: 1 }),
    ];
    const now = Date.now();
    events = [{ runId: `run-${WORKER}`, type: 'tool_call', payload: { name: 'run_command', args: { command: 'cd backend && npm test' } }, createdAt: new Date(now - 2 * MIN) }];
    const r = await drainOpenTicketsToLane();
    expect(r.batched).toBe(1); // the waiting ticket spawned — the capped lane's slot is free
    expect(byId('long1111-0').status).toBe('in_progress'); // the ticket stays with its lane
    expect(byId('long1111-0').adminNote).toContain('hit the 3 h ticket-lane slot cap');
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
    const [chatId, type] = mockEmitHookEvent.mock.calls[0];
    expect(chatId).toBe(WORKER);
    expect(type).toBe('attention_needed');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ticket_lane_slot_release', meta: expect.objectContaining({ reason: 'cap', laneId: WORKER }) }));
  });

  it('the capped lane keeps running and its ticket is NOT re-dispatched while it is live (no two lanes on one ticket)', async () => {
    tickets = [laneTicket('long2222-0', WORKER, 5 * H)];
    events = [];
    const r = await drainOpenTicketsToLane();
    expect(mockStartCodingSession).not.toHaveBeenCalled(); // nothing waiting — and the capped ticket itself is NOT re-dispatched
    expect(r.batched).toBe(0);
    expect(byId('long2222-0').context.dispatchedTo).toBe(WORKER);
  });

  it('inside the cap a live lane keeps its slot', async () => {
    tickets = [laneTicket('young222-0', WORKER, 2 * H)];
    events = [];
    await drainOpenTicketsToLane();
    expect(byId('young222-0').adminNote).not.toContain('slot cap');
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  it('TICKET_LANE_SLOT_CAP_HOURS tunes the cap', async () => {
    process.env.TICKET_LANE_SLOT_CAP_HOURS = '0.5'; // 30 min
    tickets = [laneTicket('tuned333-0', WORKER, 45 * MIN)];
    events = [];
    await drainOpenTicketsToLane();
    expect(byId('tuned333-0').adminNote).toContain('slot cap');
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
  });

  it('a lane-past-cap whose ticket is CLOSED is left to the bf656696 archive path (the cap is for in_progress lanes)', async () => {
    // Closed tickets never reach the release pass (their lanes retire through
    // the archive path); pin that the cap note is not written on a closed row.
    const at = new Date(Date.now() - 5 * H).toISOString();
    tickets = [ticket('closed111-0', {
      status: 'done',
      context: { dispatchMode: 'ticket_lane', dispatchedTo: WORKER, dispatchedAt: at, laneDispatches: 1, laneArchivedAt: new Date().toISOString() },
    })];
    runs.push({ id: `run-${WORKER}`, sessionId: WORKER, status: 'running', createdAt: new Date(Date.now() - 5 * H), updatedAt: new Date() });
    await drainOpenTicketsToLane();
    expect(byId('closed111-0').adminNote ?? '').not.toContain('slot cap');
  });
});

// ── 3. The classifier table ─────────────────────────────────────────────────

describe('isIdlePollCommand — the idle-park classifier', () => {
  const cases: Array<[unknown, boolean, string]> = [
    ['sleep 300; gh run list --limit 5 --json status,conclusion', true, 'the prod stall shape'],
    ['sleep 600 && gh run view 39039436585 --log-failed | tail -40', true, 'sleep + log tail'],
    ['sleep 300; gh pr checks 1680 --watch', true, 'a watch is a poll'],
    ['sleep 60; git status --porcelain | wc -l', true, 'git status poll'],
    ['sleep 300; gh run list | grep fail | wc -l', true, 'a read-only pipe is a poll'],
    ['sleep 300; echo "still waiting"; true', true, 'echo/true padding'],
    ['sleep 300; git log --oneline -5; gh run view 123', true, 'mixed read-only git+gh'],
    // review finding 3 — MUTATING git/gh must NOT classify as a poll
    ['sleep 300; git commit -am x && git push', false, 'a git commit/push is work'],
    ['sleep 60; gh pr merge 1680 --squash', false, 'gh pr merge is work'],
    ['sleep 60; curl -X POST https://api.example.com/deploy', false, 'curl -X POST is work'],
    ['sleep 60; gh run list | xargs rm -rf', false, 'an xargs pipe is not read-only'],
    ['sleep 300; gh run list > /tmp/out.json', false, 'a redirect writes'],
    ['sleep 60; git push origin main', false, 'plain git push'],
    ['sleep 5; node scripts/verify.js', false, 'node work'],
    ['sleep 300; npm test', false, 'a real build after the sleep'],
    ['cd backend && sleep 120 && gh run list', false, 'leading cd means no leading sleep'],
    ['gh run list --limit 5', false, 'a poll with NO leading sleep'],
    ['npm test -- --watchAll=false', false, 'plain work'],
    ['docker ps', false, 'docker work'],
    ['', false, 'empty'],
    [undefined, false, 'not a string'],
    [null, false, 'null'],
  ];
  it.each(cases)('%j ⇒ %s (%s)', (cmd, expected) => {
    expect(isIdlePollCommand(cmd)).toBe(expected);
  });
});
