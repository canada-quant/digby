/**
 * Characterization test — ticket 2c9dfc66
 * (STALLED detector readback credit: recurring schedules credit without a
 * due-freshness bound — the 09880586/PR #1791 review N-1 gap).
 *
 * This is a RECORD, not a fix: the ticket is observe/record ("no code change
 * is requested until the width demonstrably hides a genuine stall"), and the
 * 2026-10-19T22:25Z/22:27Z live census (probe-2c9dfc66.js, box A via
 * prodq.sh) found the fleet NOT BITTEN:
 *   - 15 stale in_progress todos → 9 dropped by the <12h fresh-note rule →
 *     6 dropped by lane liveness → 0 post-liveness rows (nothing is past the
 *     24h drift backstop at all — the credit layer hides nothing today);
 *   - latent exposure: 10 stale rows carry a credit, 9 recurring-only, 9 of
 *     the 10 currently also saved by the fresh-note rule (the 10th saved by
 *     lane liveness, <24h quiet); 0 past-backstop credit-only; 0 crediting
 *     watches dead (every recurring row lastStatus 'started', nextRunAt in
 *     the future);
 *   - the 09880586 exemplar (todo fea78360, 4h quiet) credits via its ONE-
 *     SHOT 0059e4e4 (nextRunAt 2026-10-23T21:30:17Z) — the designed-wait
 *     shape works exactly as merged.
 *
 * What this file PINS (the current, deliberate width of scheduleCreditsTodo —
 * supervisor-state.service.ts, ticket 09880586):
 *   1. a kind:'recurring' schedule whose prompt names the todo credits the
 *      todo PAST the 24h drift backstop, even on a dead/never-ran lane —
 *      recurring rows have NO nextRunAt/expiresAt due-freshness bound;
 *   2. even a DEAD-LOOKING recurring row (nextRunAt days overdue) still
 *      credits — the only recurring bounds are enabled:true and not-past
 *      expiresAt;
 *   3. a once schedule past its nextRunAt credits NOTHING (the one-shot
 *      expiry bound the recurring rows lack);
 *   4. the kill switch FLEET_ATTENTION_READBACK_CREDIT_DISABLED=1 restores
 *      the bare clock on the recurring-credited shape.
 *
 * WHY PIN A WIDTH THE TICKET WANTS TO SOMEDAY TIGHTEN: so a future
 * tightening (ticket options (a) kind:'once'-only leg A, (b) nextRunAt
 * within N days, (c) explicit prompt marker) is a DELIBERATE red on these
 * pins — not an accident. A tightening PR must flip pins 1-2 red INTENTIONALLY,
 * extend the DETECTOR-RECALL REPLAY set (below, and in
 * supervisor-state.09880586.test.ts) so the fea78360/0059e4e4 designed-wait
 * case still credits, and ship behind the existing kill switch. Until a
 * census finds a genuinely dead todo hidden behind a stale recurring watch
 * (the dead-watch verdict_hint in probe-2c9dfc66.js), the width stays.
 *
 * DETECTOR-RECALL REPLAY: the final suite re-runs the STALLED detector's
 * prior true-positive shapes (8f5a45f7 silent lane, never-ran lane) and
 * asserts they STILL fire with this file's fixtures — the characterization
 * must never become a silent detector relaxation.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  projectTodo: { findMany: jest.fn(async () => []) },
  chatSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  agentRun: { groupBy: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { buildFleetAttentionBlock } from './supervisor-state.service';

const UID = 'u1';
const LANE = 'daee2916-0000-4000-8000-crossmodel-sup';
/** A wake well past the drift backstop — 2026-10-21, two days after the census. */
const NOW = new Date('2026-10-21T12:00:00.000Z');
/** The todo has been quiet 30h at NOW — past the 24h STALLED_BACKSTOP_MS. */
const TODO_STAMP = new Date('2026-10-20T06:00:00.000Z');

/** A long-lived standing-watch todo of the shape the census found 9 of. */
const TODO_ID = '71c98f40-0000-4000-8000-000000000001';
const WATCH_TODO = (over: Partial<any> = {}): any => ({
  id: TODO_ID,
  title: 'Enumerate all clips per camera Aug→now + dedupe/offline-decrement (standing watch)',
  assigneeChatId: LANE,
  updatedAt: TODO_STAMP,
  progressNote: 'standing watch — hourly sweep reconciles the clip index',
  ...over,
});

/** The recurring schedule that names it — the census specimen shape (999346a4-class). */
const SCHED_ID = '999346a4-0000-4000-8000-000000000002';
const WATCH_SCHED = (over: Partial<any> = {}): any => ({
  id: SCHED_ID,
  kind: 'recurring',
  enabled: true,
  intervalSec: 6 * 3600,
  nextRunAt: new Date('2026-10-21T17:00:00.000Z'),
  expiresAt: null,
  prompt: 'TICK — camera clip watch (todo 71c98f40): enumerate new clips, reconcile the index, report.',
  ...over,
});

/** Route the two projectTodo queries by their where.status. */
function mockTodos({ stalled = [] as any[], pending = [] as any[] } = {}) {
  mockPrisma.projectTodo.findMany.mockImplementation(async ({ where }: any) =>
    where?.status === 'in_progress' ? stalled : pending,
  );
}
/** Route chatSchedule queries: readback pull (no sessionId/promptSetBy) →
 *  readbackRows; machinePrompts → []; assignee-cadence (sessionId.in) → cadenceRows. */
function mockSchedules(readbackRows: any[] = [], cadenceRows: any[] = []) {
  mockPrisma.chatSchedule.findMany.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    if (w.sessionId?.in) return cadenceRows;
    if (w.promptSetBy) return [];
    return readbackRows;
  });
}
const runAgg = (sessionId: string, newest: Date): any => ({ sessionId, _max: { updatedAt: newest } });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.chatSchedule.findMany.mockResolvedValue([]);
  mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.groupBy.mockResolvedValue([]);
});

afterEach(() => {
  delete process.env.FLEET_ATTENTION_READBACK_CREDIT_DISABLED;
});

describe('ticket 2c9dfc66 — characterization: the recurring readback-credit width (recorded, not tightened)', () => {
  it('WIDTH PIN 1 — a recurring schedule naming the todo credits PAST the 24h drift backstop on a dead lane (30h quiet, lane never ran)', async () => {
    // The lane NEVER ran (agentRun.groupBy → []) so liveness keeps the row;
    // 30h quiet trips the drift backstop — yet the recurring credit (leg A)
    // suppresses it. This is the exact width ticket 2c9dfc66 records: for a
    // recurring watch the credit overrides the backstop for the schedule's
    // LIFETIME, with no due-freshness bound. Census 2026-10-19: 0 such rows
    // live (every latent credit was fresh-note saved, every watch alive).
    mockTodos({ stalled: [WATCH_TODO()] });
    mockSchedules([WATCH_SCHED()]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([]); // lane never ran
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('STALLED todo');
    expect(block).toBe('');
  });

  it('WIDTH PIN 2 — even a DEAD-LOOKING recurring row (nextRunAt 3 DAYS overdue) still credits — the width has no due-freshness bound at all', async () => {
    // The bitten shape the ticket names: a genuinely dead todo hidden behind
    // a stale recurring watch. If a census (probe-2c9dfc66.js verdict_hint
    // 'BITTEN-CANDIDATE') ever finds this live, tightening option (a)/(b)/(c)
    // ships behind FLEET_ATTENTION_READBACK_CREDIT_DISABLED — and THIS pin
    // flips red by design.
    mockTodos({ stalled: [WATCH_TODO()] });
    mockSchedules([WATCH_SCHED({ nextRunAt: new Date('2026-10-18T00:00:00.000Z') })]); // 3.5d overdue
    mockPrisma.agentRun.groupBy.mockResolvedValue([]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).not.toContain('STALLED todo');
    expect(block).toBe('');
  });

  it('BOUND — a once schedule PAST its nextRunAt credits nothing (the one-shot expiry bound the recurring rows lack)', async () => {
    mockTodos({ stalled: [WATCH_TODO()] });
    mockSchedules([WATCH_SCHED({ kind: 'once', nextRunAt: new Date('2026-10-21T06:00:00.000Z') })]); // fired 6h before NOW
    mockPrisma.agentRun.groupBy.mockResolvedValue([]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
    expect(block).toContain('Enumerate all clips'); // title, the only row text the line renders
  });

  it('KILL SWITCH — FLEET_ATTENTION_READBACK_CREDIT_DISABLED=1 restores the bare clock on the recurring-credited shape', async () => {
    process.env.FLEET_ATTENTION_READBACK_CREDIT_DISABLED = '1';
    mockTodos({ stalled: [WATCH_TODO()] });
    mockSchedules([WATCH_SCHED()]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
    expect(block).toContain('Enumerate all clips');
  });
});

describe('ticket 2c9dfc66 — DETECTOR-RECALL REPLAY: the characterization is not a relaxation', () => {
  it('DETECTOR-RECALL REPLAY — 8f5a45f7: a SILENT lane (live cadence row, last run 8h ago) with NO referencing schedule still flags', async () => {
    // progressNote null: with a fresh (<12h) note the e13f216e reconcile rule
    // would drop the row BEFORE liveness — this replay isolates the 8f5a45f7
    // liveness shape, so the row must reach it.
    mockTodos({ stalled: [WATCH_TODO({ updatedAt: new Date('2026-10-21T09:00:00.000Z'), progressNote: null })] }); // 3h quiet
    mockSchedules(
      [],
      [{ sessionId: LANE, intervalSec: 3600 }], // hourly cadence
    );
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LANE, new Date('2026-10-21T04:00:00.000Z'))]); // 8h silent
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
  });

  it('DETECTOR-RECALL REPLAY — 8f5a45f7: a never-ran lane with NO referencing schedule still flags (the liveness never-ran branch, under the backstop)', async () => {
    // 13h quiet — UNDER the 24h backstop so liveness reaches its never-ran
    // branch (a 30h row would flag via the backstop before the never-ran
    // check; the genuine never-ran coverage needs the todo fresh enough that
    // ONLY the missing lane run explains the flag).
    mockTodos({ stalled: [WATCH_TODO({ updatedAt: new Date('2026-10-20T23:00:00.000Z') })] }); // 13h quiet
    mockSchedules(); // no schedules at all
    mockPrisma.agentRun.groupBy.mockResolvedValue([]); // lane never ran
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo');
    expect(block).toContain('Enumerate all clips');
  });
});
