/**
 * REPLAY test — ticket 8f5a45f7 (mishap, filed 2026-09-15T03:48Z):
 * "Fleet-attention STALLED todo heuristic false-positives on watch lanes that
 * fire without todo writes".
 *
 * The mishap, verbatim from the ticket evidence: the FLEET ATTENTION
 * "STALLED / UNSTARTED TODOS" block in the supervisor's machine-wake
 * injection flagged in_progress todo 5f561c18 ("P2: PR #55747 shepherding")
 * as STALLED at 03:44Z 2026-09-15 because its updatedAt
 * (2026-09-14T14:41Z, ~13h) had crossed the 2h staleness threshold — while its
 * assignee lane 17f71915 was firing HOURLY (fired 03:18–03:21Z, firing
 * 109/500, self-audit PASSED). A GET-only watch lane has no reason to write
 * its todo when nothing changed upstream, so todo.updatedAt alone
 * false-positived on every supervisor wake and cost a reconcile probe each
 * time. Pre-fix, test 1 below FAILED (the healthy watch rendered as STALLED);
 * post-fix the assignee-liveness weighting suppresses it.
 *
 * The fix (ticket suggestion a): a stalled in_progress todo is suppressed when
 * its assignee lane RAN within STALE_IN_PROGRESS_MS + the lane's longest
 * enabled schedule cadence — UNLESS the todo is untouched past the 24h drift
 * backstop (a live lane drifting for a day still earns one reconcile).
 * UNSTARTED (pending) todos are untouched: a lane that fires but never STARTS
 * an assigned todo is a genuine signal, not a false positive.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  crossModelChat: { findUnique: jest.fn() },
  projectTodo: { findMany: jest.fn(async () => []) },
  codingSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  agentRun: { groupBy: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { buildFleetAttentionBlock } from './supervisor-state.service';

const UID = 'u1';
/** The ticket's watch lane (prefix) — hourly cadence, self-audits clean. */
const LANE = '17f71915-0000-4000-8000-watchlane01';
/** The wake that flagged the healthy watch (ticket evidence). */
const NOW = new Date('2026-09-15T03:44:00.000Z');
/** The ticket's todo stamp — ~13h untouched at the flagging wake. */
const TODO_STAMP = new Date('2026-09-14T14:41:00.000Z');

const stalledTodo = (over: Partial<any> = {}): any => ({
  title: 'P2: PR #55747 shepherding',
  assigneeChatId: LANE,
  updatedAt: TODO_STAMP,
  ...over,
});

/** Route the two projectTodo queries by their where.status. */
function mockTodos({ stalled = [] as any[], pending = [] as any[] } = {}) {
  mockPrisma.projectTodo.findMany.mockImplementation(async ({ where }: any) =>
    where?.status === 'in_progress' ? stalled : pending,
  );
}

/** Route the two codingSchedule queries: machinePrompts (where.userId) → [];
 *  assignee-cadence (where.sessionId.in) → cadenceRows. */
function mockSchedules(cadenceRows: any[] = []) {
  mockPrisma.codingSchedule.findMany.mockImplementation(async ({ where }: any) =>
    where?.sessionId?.in ? cadenceRows : [],
  );
}

/** agentRun.groupBy helper: sessionId → newest run stamp. */
const runAgg = (sessionId: string, newest: Date): any => ({ sessionId, _max: { updatedAt: newest } });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
  mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.groupBy.mockResolvedValue([]);
});

describe('ticket 8f5a45f7 replay — STALLED heuristic vs live watch lanes', () => {
  it('REPLAY: the ticket wake — todo untouched 13h, hourly lane fired 23m ago → NOT flagged STALLED', async () => {
    mockTodos({ stalled: [stalledTodo()] });
    mockSchedules([{ sessionId: LANE, intervalSec: 3600 }]); // hourly watch
    mockPrisma.agentRun.groupBy.mockResolvedValue([
      runAgg(LANE, new Date('2026-09-15T03:21:00.000Z')), // fired 23m before the wake
    ]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    // Pre-fix this block contained `- STALLED todo "P2: PR #55747 shepherding"`.
    expect(block).not.toContain('STALLED todo');
    expect(block).not.toContain('55747');
    expect(block).toBe(''); // nothing else to flag — the false positive is simply gone
  });

  it('a SILENT lane stays flagged: hourly cadence but last run 5h ago (window 2h+1h)', async () => {
    mockTodos({ stalled: [stalledTodo()] });
    mockSchedules([{ sessionId: LANE, intervalSec: 3600 }]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([
      runAgg(LANE, new Date('2026-09-14T22:44:00.000Z')), // 5h before the wake — lane is dead/stuck
    ]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo "P2: PR #55747 shepherding"');
    expect(block).toContain('13h');
  });

  it('a lane that NEVER ran stays flagged (no liveness evidence ≠ alive)', async () => {
    mockTodos({ stalled: [stalledTodo()] });
    mockSchedules([{ sessionId: LANE, intervalSec: 3600 }]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([]); // no run rows for the lane
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo "P2: PR #55747 shepherding"');
  });

  it('an unassigned stalled todo stays flagged (no lane to liveness-check)', async () => {
    mockTodos({ stalled: [stalledTodo({ assigneeChatId: null })] });
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo "P2: PR #55747 shepherding"');
    expect(block).toContain('assignee chat none'); // audit 2026-10-08 W1-7: full-id rendering (was "…none")
    // No assignee ids → the liveness lookups are skipped entirely.
    expect(mockPrisma.agentRun.groupBy).not.toHaveBeenCalled();
  });

  it('drift backstop: a LIVE lane whose todo is untouched >24h still reconciles once', async () => {
    mockTodos({ stalled: [stalledTodo({ updatedAt: new Date('2026-09-14T02:00:00.000Z') })] }); // ~25.7h
    mockSchedules([{ sessionId: LANE, intervalSec: 3600 }]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([
      runAgg(LANE, new Date('2026-09-15T03:40:00.000Z')), // lane fired 4m ago — demonstrably alive
    ]);
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo "P2: PR #55747 shepherding"');
    expect(block).toContain('untouched 25h');
  });

  it('cadence widening: a 4h-cadence watch firing 3h ago is NOT late (window 2h+4h); firing 7h ago IS', async () => {
    mockSchedules([{ sessionId: LANE, intervalSec: 4 * 3600 }]);
    mockTodos({ stalled: [stalledTodo()] });
    // 3h since the lane's last run < 2h base + 4h cadence → suppressed.
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LANE, new Date('2026-09-15T00:44:00.000Z'))]);
    await expect(buildFleetAttentionBlock(UID, NOW)).resolves.toBe('');
    // 7h since the last run > 6h window → the lane is genuinely silent → flagged.
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LANE, new Date('2026-09-14T20:44:00.000Z'))]);
    await expect(buildFleetAttentionBlock(UID, NOW)).resolves.toContain('STALLED todo "P2: PR #55747 shepherding"');
  });

  it('hook-woken lane (no schedule): base 2h window applies — run 90m ago suppresses, 3h ago flags', async () => {
    mockSchedules([]); // no enabled schedule rows for the lane
    mockTodos({ stalled: [stalledTodo()] });
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LANE, new Date('2026-09-15T02:14:00.000Z'))]); // 90m
    await expect(buildFleetAttentionBlock(UID, NOW)).resolves.toBe('');
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LANE, new Date('2026-09-15T00:44:00.000Z'))]); // 3h
    await expect(buildFleetAttentionBlock(UID, NOW)).resolves.toContain('STALLED todo');
  });

  it('liveness-lookup failure degrades to FLAGGING (never hides a stall, never throws)', async () => {
    mockTodos({ stalled: [stalledTodo()] });
    mockPrisma.codingSchedule.findMany.mockImplementation(async ({ where }: any) =>
      where?.sessionId?.in ? Promise.reject(new Error('db down')) : [],
    );
    mockPrisma.agentRun.groupBy.mockRejectedValue(new Error('db down'));
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('STALLED todo "P2: PR #55747 shepherding"');
  });

  it('UNSTARTED is untouched by lane liveness: a pending todo the live lane never STARTS still flags', async () => {
    mockTodos({
      pending: [{ title: 'Kick off the canary rebuild', assigneeChatId: LANE, updatedAt: new Date('2026-09-14T05:44:00.000Z') }], // 22h
    });
    mockSchedules([{ sessionId: LANE, intervalSec: 3600 }]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([runAgg(LANE, new Date('2026-09-15T03:41:00.000Z'))]); // fired 3m ago
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(block).toContain('UNSTARTED todo "Kick off the canary rebuild"');
    expect(block).toContain('22h');
  });

  it('over-fetch headroom: a page of live-lane watches cannot hide the genuine stall behind them', async () => {
    const live = Array.from({ length: 6 }, (_, i) =>
      stalledTodo({ title: `live watch ${i}`, assigneeChatId: `lane-live-${i}` }),
    );
    const dead = stalledTodo({ title: 'dead lane rebuild', assigneeChatId: 'lane-dead' });
    mockTodos({ stalled: [...live, dead] });
    mockSchedules([]);
    mockPrisma.agentRun.groupBy.mockResolvedValue([
      ...live.map((_, i) => runAgg(`lane-live-${i}`, new Date('2026-09-15T03:30:00.000Z'))), // all fresh
      runAgg('lane-dead', new Date('2026-09-14T20:00:00.000Z')), // 7.7h > 2h base window
    ]);
    // The stalled query must over-fetch past the render cap so the 7th
    // (genuine) stall is still a candidate after suppression drops the 6.
    const block = await buildFleetAttentionBlock(UID, NOW);
    const stalledCall = mockPrisma.projectTodo.findMany.mock.calls.find(([a]: any[]) => a?.where?.status === 'in_progress');
    expect(stalledCall?.[0]?.take).toBeGreaterThan(6);
    expect(block).not.toContain('live watch');
    expect(block).toContain('STALLED todo "dead lane rebuild"');
  });
});
