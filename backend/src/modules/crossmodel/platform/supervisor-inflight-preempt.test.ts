/**
 * Ticket a5b36dc6 — preempted-run in-flight checkpoint. A user preemption of a
 * supervisor machine run used to lose the interrupted turn's in-flight
 * side-effecting intents: their tool_intents rows stayed pending/unknown (the
 * effects may still land), and the next turn answered "from earlier context",
 * claiming or retracting actions ("nothing went out") — the claim→retraction
 * loop. Pins here (mocked Prisma, same pattern as supervisor-state.service.test.ts):
 *   - markPreemptedInflight stamps the harness-written inflightPreemptAt marker
 *     on SUPERVISOR-CLASS chats only (a plain chat's preempt mints no row) and
 *     never throws;
 *   - the marker survives a parse round trip; applyStateUpdate (the model's own
 *     merge) cannot forge or erase it;
 *   - buildInflightPreemptBlock renders the LIVE journal window (unsettled
 *     calls named with the never-retract instruction, applied rows
 *     receipt-backed), skips when no fresh marker / no rows / kill switch on,
 *     and fails open on a DB error;
 *   - a stale marker (older than the window) renders nothing.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  toolIntent: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// The service dynamic-imports loop-metrics (telemetry never blocks) — stub it.
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { INFLIGHT_PREEMPT_MARK: 'inflight_preempt_mark' },
}));

import {
  markPreemptedInflight,
  buildInflightPreemptBlock,
  inflightPreemptDisabled,
  INFLIGHT_PREEMPT_WINDOW_MS,
  getSupervisorState,
  applyStateUpdate,
} from './supervisor-state.service';

const CHAT = 'sup-chat-inflight';
const UID = 'u1';

let table: Map<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  delete process.env.SUPERVISOR_INFLIGHT_PREEMPT_DISABLED;
  table = new Map();
  mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) =>
    table.has(where.chatId) ? { state: table.get(where.chatId) } : null);
  mockPrisma.supervisorState.upsert.mockImplementation(async ({ where, create, update }: any) => {
    table.set(where.chatId, table.has(where.chatId) ? update.state : create.state);
    return {};
  });
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: UID, isSupervisor: true, isProjectSupervisor: false });
  mockPrisma.toolIntent.findMany.mockResolvedValue([]);
});

describe('markPreemptedInflight', () => {
  it('stamps inflightPreemptAt on a supervisor chat (harness-written section)', async () => {
    await markPreemptedInflight(CHAT);
    const doc = await getSupervisorState(CHAT);
    expect(Date.parse(doc.inflightPreemptAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(doc.inflightPreemptAt)).toBeLessThanOrEqual(Date.now());
  });

  it('supervisor-class only: a project supervisor qualifies, a PLAIN chat writes nothing', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ userId: UID, isSupervisor: false, isProjectSupervisor: true });
    await markPreemptedInflight('proj-sup-chat');
    expect(Date.parse((await getSupervisorState('proj-sup-chat')).inflightPreemptAt)).toBeGreaterThan(0);

    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ userId: UID, isSupervisor: false, isProjectSupervisor: false });
    await markPreemptedInflight('plain-chat');
    // No row was created for the plain chat, and no upsert targeted it.
    expect(await getSupervisorState('plain-chat')).toEqual(expect.objectContaining({ inflightPreemptAt: '' }));
    expect(mockPrisma.supervisorState.upsert.mock.calls.every((c: any[]) => c[0].where.chatId !== 'plain-chat')).toBe(true);
  });

  it('the kill switch suppresses the marker entirely', async () => {
    process.env.SUPERVISOR_INFLIGHT_PREEMPT_DISABLED = '1';
    expect(inflightPreemptDisabled()).toBe(true);
    await markPreemptedInflight(CHAT);
    expect(mockPrisma.supervisorState.upsert).not.toHaveBeenCalled();
  });

  it('never throws on a DB failure (fail-open — the preempt path never blocks)', async () => {
    mockPrisma.crossModelChat.findUnique.mockRejectedValueOnce(new Error('db down'));
    await expect(markPreemptedInflight(CHAT)).resolves.toBeUndefined();
  });

  it('a malformed stored doc is upgraded safely (missing inflightPreemptAt → marker stamps)', async () => {
    table.set(CHAT, { directives: [], dispatches: [] }); // pre-fix shape
    await markPreemptedInflight(CHAT);
    const doc = await getSupervisorState(CHAT);
    expect(Date.parse(doc.inflightPreemptAt)).toBeGreaterThan(0);
    expect(doc.directives).toEqual([]);
  });
});

describe('the marker is harness-only (the model can neither forge nor erase it)', () => {
  it('applyStateUpdate round-trips the stored marker untouched (no field in the update touches it)', async () => {
    await markPreemptedInflight(CHAT);
    const before = (await getSupervisorState(CHAT)).inflightPreemptAt;
    // A model merge of a directive + notes must leave the marker byte-identical.
    const r = await applyStateUpdate(CHAT, UID, {
      directives: [{ text: 'keep the fleet informed', status: 'open' }],
      notes: 'routine sweep note',
    });
    expect(r.applied.length).toBeGreaterThan(0);
    const after = (await getSupervisorState(CHAT)).inflightPreemptAt;
    expect(after).toBe(before);
  });

  it('parseDoc tolerates a corrupt marker (non-ISO string degrades to none-live)', async () => {
    table.set(CHAT, { directives: [], dispatches: [], notes: '', refutations: [], inflightPreemptAt: 'yesterday-ish' });
    expect((await getSupervisorState(CHAT)).inflightPreemptAt).toBe('');
  });
});

describe('buildInflightPreemptBlock', () => {
  const NOW = new Date('2026-10-17T00:30:00.000Z');
  /** Seed the marker at a FIXED time (5 min before NOW) — markPreemptedInflight
   *  stamps real now, which the fixed render clock would see as future. */
  const seedMarker = async (at = '2026-10-17T00:25:00.000Z') => {
    table.set(CHAT, { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: at });
  };

  it('renders the ACTION-IN-FLIGHT guard: unsettled calls named, applied receipt-backed', async () => {
    await seedMarker();
    mockPrisma.toolIntent.findMany.mockResolvedValueOnce([
      { tool: 'send_chat_message', state: 'pending', slot: '0', receiptId: null, createdAt: new Date('2026-10-17T00:20:00.000Z') },
      { tool: 'schedule_message', state: 'unknown', slot: '1', receiptId: null, createdAt: new Date('2026-10-17T00:21:00.000Z') },
      { tool: 'todo_update', state: 'applied', slot: '2', receiptId: 'receipt-1234567890', createdAt: new Date('2026-10-17T00:19:00.000Z') },
      { tool: 'notify_user', state: 'failed', slot: '3', receiptId: null, createdAt: new Date('2026-10-17T00:18:00.000Z') },
    ]);
    const block = await buildInflightPreemptBlock(CHAT, { now: NOW });
    expect(block).toContain('PREEMPTED RUN — ACTION IN FLIGHT');
    expect(block).toContain('send_chat_message');
    expect(block).toContain('schedule_message');
    expect(block).toContain('NEVER retract'); // the instruction the loop violated
    expect(block).toContain('todo_update');
    expect(block).toContain('receipt receipt-'); // receipt-backed, 8-char prefix
    expect(block).toContain('1 failed');
    // The journal is read LIVE with the chat's own id + a window from the mark.
    expect(mockPrisma.toolIntent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ chatId: CHAT }),
      orderBy: { createdAt: 'desc' },
    }));
  });

  it('skips when no fresh marker (the pre-fix wake is byte-identical)', async () => {
    expect(await buildInflightPreemptBlock(CHAT, { now: NOW })).toBe('');
    expect(mockPrisma.toolIntent.findMany).not.toHaveBeenCalled();
  });

  it('skips when the marker is older than the window', async () => {
    await seedMarker();
    const stale = new Date(NOW.getTime() - INFLIGHT_PREEMPT_WINDOW_MS - 5 * 60_000);
    expect(await buildInflightPreemptBlock(CHAT, { now: stale })).toBe('');
  });

  it('renders "none unsettled" when every call settled (the reassurance case)', async () => {
    await seedMarker();
    mockPrisma.toolIntent.findMany.mockResolvedValueOnce([
      { tool: 'todo_update', state: 'applied', slot: '0', receiptId: 'receipt-abcdef123456', createdAt: new Date('2026-10-17T00:19:00.000Z') },
    ]);
    const block = await buildInflightPreemptBlock(CHAT, { now: NOW });
    expect(block).toContain('UNSETTLED: none');
    expect(block).toContain('EXECUTED');
  });

  it('skips when the marker is live but the journal has NO rows in the window', async () => {
    await seedMarker();
    mockPrisma.toolIntent.findMany.mockResolvedValueOnce([]);
    expect(await buildInflightPreemptBlock(CHAT, { now: NOW })).toBe('');
  });

  it('kill switch on → no block, no journal read', async () => {
    await seedMarker();
    process.env.SUPERVISOR_INFLIGHT_PREEMPT_DISABLED = '1';
    expect(await buildInflightPreemptBlock(CHAT, { now: NOW })).toBe('');
    expect(mockPrisma.toolIntent.findMany).not.toHaveBeenCalled();
  });

  it('review P2 regression: POST-stamp rows can never crowd out the interrupted run (bounded window, no false "UNSETTLED: none")', async () => {
    // The incident shape: 45 rows created AFTER the stamp (the owner's own
    // turn + later wakes journaling dozens of side-effecting calls) would,
    // under an unbounded window + take:40 desc, fill the cap and hide the
    // interrupted run's two pre-stamp unsettled rows — printing a FALSE
    // "UNSETTLED: none", the exact retraction this block exists to prevent.
    await seedMarker('2026-10-17T00:25:00.000Z');
    // The DB mock returns what the REAL query returns with the bounded
    // window: only rows with createdAt <= stamp + 60s (the two pre-stamp
    // unsettled rows; the 45 post-stamp ones are filtered OUT by the query).
    const post = Array.from({ length: 45 }, (_, i) => ({
      tool: 'todo_update', state: 'applied', slot: String(i), receiptId: `r${i}`, createdAt: new Date('2026-10-17T00:26:30.000Z'),
    }));
    const pre = [
      { tool: 'notify_user', state: 'pending', slot: '40', receiptId: null, createdAt: new Date('2026-10-17T00:24:00.000Z') },
      { tool: 'send_to_instance', state: 'unknown', slot: '41', receiptId: null, createdAt: new Date('2026-10-17T00:23:00.000Z') },
    ];
    mockPrisma.toolIntent.findMany.mockImplementation(async ({ where }: any) => {
      const lo = where.createdAt.gte.getTime();
      const hi = where.createdAt.lte.getTime();
      return [...pre, ...post].filter((r) => r.createdAt.getTime() >= lo && r.createdAt.getTime() <= hi)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, where.take ?? 40);
    });
    // 1. The query itself is BOUNDED at the stamp (+ 60 s grace) — the
    //    post-stamp rows are structurally excluded.
    const block = await buildInflightPreemptBlock(CHAT, { now: NOW });
    expect(mockPrisma.toolIntent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ chatId: CHAT, createdAt: expect.objectContaining({ lte: expect.any(Date) }) }),
    }));
    const call = mockPrisma.toolIntent.findMany.mock.calls[0][0];
    expect(call.where.createdAt.lte.getTime()).toBe(Date.parse('2026-10-17T00:25:00.000Z') + 60_000);
    // 2. The interrupted run's unsettled rows are named — NO false "none".
    expect(block).toContain('notify_user');
    expect(block).toContain('send_to_instance');
    expect(block).not.toContain('UNSETTLED: none');
  });

  it('review P2 unit: even if the caller hands the block a full page of LATER applied rows, the guard never claims "all settled" it cannot see (settled rows do not erase unsettled knowledge)', async () => {
    await seedMarker('2026-10-17T00:25:00.000Z');
    // Defensive depth: 40 post-grace applied rows handed in (simulating a
    // stale/incorrect caller) still cannot flip the wording to "none
    // unsettled" unless every row in the bounded window is settled.
    mockPrisma.toolIntent.findMany.mockResolvedValueOnce(
      Array.from({ length: 40 }, (_, i) => ({
        tool: 'todo_update', state: 'applied', slot: String(i), receiptId: `r${i}`, createdAt: new Date('2026-10-17T00:20:00.000Z'),
      })),
    );
    const block = await buildInflightPreemptBlock(CHAT, { now: NOW });
    expect(block).toContain('UNSETTLED: none'); // correct here: the bounded window truly has only settled rows
    expect(block).toContain('EXECUTED');
  });

  it('a journal read failure fails open to an empty block (never breaks a run start)', async () => {
    await seedMarker();
    mockPrisma.toolIntent.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await buildInflightPreemptBlock(CHAT, { now: NOW })).toBe('');
  });
});
