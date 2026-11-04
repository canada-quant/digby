/**
 * [PROJECT SCHEDULES] block — REPLAY TEST for mishap ticket 69d0c808.
 *
 * The mishap (2026-09-14, chat 615723ba): a PROJECT supervisor's 16:07Z
 * machine-wake note claimed a worker lane had "two enabled re-arms already
 * queued" (sched `87b434c5`, 17:03Z future sched `184533b6`) — schedule ids
 * that exist NOWHERE in the owner's fleet; the lane's six schedules were ALL
 * stopped (the lane itself had just reported "No live wake path remains —
 * terminal by design"). The wake carried NO live per-lane schedule truth
 * (the fleet attention/liveness blocks are owner-scoped, fleet-lane only —
 * chat-agent.service injects them only for isSupervisor), so the cadence
 * claim was composed from memory and guardMachineWakeFinalAnswer struck the
 * note pre-delivery.
 *
 * The fix: buildProjectScheduleBlock injects per-lane schedule ground truth
 * into the PROJECT supervisor's machine wakes, so an "enabled re-arms
 * queued" claim is either citable from the injected block or visibly false
 * at compose time. These tests replay the mishap's exact lane shapes and pin
 * the block that refutes the phantom.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockChatFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockSchedFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockSchedGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockRunGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: { findMany: (...a: any[]) => mockChatFindMany(...a) },
    codingSchedule: {
      findMany: (...a: any[]) => mockSchedFindMany(...a),
      groupBy: (...a: any[]) => mockSchedGroupBy(...a),
    },
    agentRun: { groupBy: (...a: any[]) => mockRunGroupBy(...a) },
  },
}));

import { buildProjectScheduleBlock } from './supervisor-state.service';

const NOW = new Date('2026-09-14T16:07:00Z');
const minutesAhead = (m: number) => new Date(NOW.getTime() + m * 60_000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

beforeEach(() => {
  jest.clearAllMocks();
  mockChatFindMany.mockResolvedValue([]);
  mockSchedFindMany.mockResolvedValue([]);
  mockSchedGroupBy.mockResolvedValue([]);
  mockRunGroupBy.mockResolvedValue([]);
});

describe('buildProjectScheduleBlock (ticket 69d0c808 replay)', () => {
  it('REPLAY: the mishap lane shapes — the all-stopped citator lane renders NO enabled schedules (the phantom "two enabled re-arms queued" is visibly false), the armed worker renders citable ids + next fires', async () => {
    // The mishap's project: citator lane d1c21ad4 with SIX stopped schedules
    // (phantom claimed two ENABLED re-arms on it) + a harvest worker with two
    // enabled rows + the supervisor's own chat with its sweep.
    const CITATOR = 'd1c21ad4-4162-4049-8886-4a1925ea512c';
    const WORKER = '184abfe9-0000-4000-8000-000000000001';
    const SUP = '615723ba-2bcc-4964-baa4-4759616e8fc5';
    mockChatFindMany.mockResolvedValue([
      { id: CITATOR, title: 'CanLegalBench Step 9 Citator Rescrape' },
      { id: WORKER, title: 'Harvest worker PRs #92/#94' },
      { id: SUP, title: 'Project Supervisor' },
    ]);
    // The id/next-fire leg: enabled rows only, already next-fire ascending.
    mockSchedFindMany.mockResolvedValue([
      { id: '0e4f0382-610e-449f-90a8-b378b2bc9862', sessionId: SUP, nextRunAt: minutesAhead(33) },
      { id: 'aaaa0001-0000-4000-8000-000000000001', sessionId: WORKER, nextRunAt: minutesAhead(56) },
      { id: 'aaaa0002-0000-4000-8000-000000000002', sessionId: WORKER, nextRunAt: minutesAhead(116) },
    ]);
    // The counts leg: UNCAPPED grouped rows — the citator's six stopped
    // schedules can never be truncated away into a false "enabled" reading.
    mockSchedGroupBy.mockResolvedValue([
      { sessionId: SUP, enabled: true, _count: { _all: 1 }, _max: { lastFiredAt: hoursAgo(1) } },
      { sessionId: WORKER, enabled: true, _count: { _all: 2 }, _max: { lastFiredAt: hoursAgo(2) } },
      { sessionId: CITATOR, enabled: false, _count: { _all: 6 }, _max: { lastFiredAt: hoursAgo(4) } },
    ]);
    mockRunGroupBy.mockResolvedValue([{ sessionId: WORKER, _count: { _all: 1 } }]);

    const block = await buildProjectScheduleBlock('proj-canlegal', NOW);

    expect(block).toContain('[PROJECT SCHEDULES');
    expect(block).toContain('cite schedule state/ids ONLY from here or from a this-wake tool pull');
    // The phantom-refuting line: the citator lane has ZERO enabled schedules —
    // "two enabled re-arms already queued (sched 87b434c5 / 184533b6)" is
    // contradicted IN CONTEXT at compose time.
    // audit 2026-10-08 W1-7: the lane's FULL chat id (was "…25ea512c" — a suffix no tool resolves).
    expect(block).toContain(`- chat ${CITATOR} "CanLegalBench Step 9 Citator Rescrape": NO enabled schedules (deaf unless a run is live), 6 stopped, 0 live run(s)`);
    // The fabricated ids are nowhere; the REAL enabled ids are citable.
    expect(block).not.toContain('87b434c5');
    expect(block).not.toContain('184533b6');
    expect(block).toContain('0e4f0382 next 16:40Z');
    // Armed lanes sort first (enabled desc), with next-fire times ascending.
    const workerLine = block.split('\n').find((l) => l.includes('Harvest worker'))!;
    expect(workerLine).toContain('2 enabled: aaaa0001 next 17:03Z; aaaa0002 next 18:03Z');
    expect(workerLine).toContain('last firing 2h ago');
    expect(workerLine).toContain('1 live run(s)');
    const supLine = block.split('\n').find((l) => l.includes('Project Supervisor'))!;
    expect(supLine).toContain('1 enabled: 0e4f0382 next 16:40Z');
    expect(supLine).toContain('last firing 1h ago');
    // Deterministic order: 2-enabled lane first, then 1-enabled, then the deaf lane.
    const idx = (s: string) => block.indexOf(s);
    expect(idx('Harvest worker')).toBeLessThan(idx('Project Supervisor'));
    expect(idx('Project Supervisor')).toBeLessThan(idx('Citator Rescrape'));
  });

  it('a project with NO chats renders nothing (and never queries schedules)', async () => {
    expect(await buildProjectScheduleBlock('proj-empty', NOW)).toBe('');
    expect(mockSchedFindMany).not.toHaveBeenCalled();
  });

  it('a project whose chats have ZERO schedule rows and ZERO live runs renders nothing (no empty-table spam)', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'c1', title: 'Idle lane' }]);
    expect(await buildProjectScheduleBlock('proj-quiet', NOW)).toBe('');
  });

  it('a lane with no schedules but a LIVE run is listed (alive via run, not deaf-by-omission)', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'c1', title: 'Running lane' }]);
    mockRunGroupBy.mockResolvedValue([{ sessionId: 'c1', _count: { _all: 1 } }]);
    const block = await buildProjectScheduleBlock('proj-run', NOW);
    expect(block).toContain('- chat c1 "Running lane": NO enabled schedules (deaf unless a run is live), 1 live run(s)');
  });

  it('more than 3 enabled rows on one lane caps the id list with a +N more marker', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'c1', title: 'Busy lane' }]);
    mockSchedFindMany.mockResolvedValue(
      [0, 1, 2, 3, 4].map((i) => ({
        id: `bbbb000${i}-0000-4000-8000-00000000000${i}`,
        sessionId: 'c1',
        nextRunAt: minutesAhead(10 + i),
      })),
    );
    mockSchedGroupBy.mockResolvedValue([{ sessionId: 'c1', enabled: true, _count: { _all: 5 }, _max: { lastFiredAt: null } }]);
    const block = await buildProjectScheduleBlock('proj-busy', NOW);
    expect(block).toContain('5 enabled: bbbb0000 next 16:17Z; bbbb0001 next 16:18Z; bbbb0002 next 16:19Z +2 more');
  });

  it('a lane whose enabled COUNT exceeds the pulled id rows still renders the true count (the groupBy-counts hardening — the cap can never fabricate a deaf signal)', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'c1', title: 'Capped lane' }]);
    // Only 2 id rows came back (findMany cap) but the grouped count says 7 —
    // the line must say 7 enabled, never "NO enabled schedules".
    mockSchedFindMany.mockResolvedValue([
      { id: 'cccc0001-0000-4000-8000-000000000001', sessionId: 'c1', nextRunAt: minutesAhead(10) },
      { id: 'cccc0002-0000-4000-8000-000000000002', sessionId: 'c1', nextRunAt: minutesAhead(20) },
    ]);
    mockSchedGroupBy.mockResolvedValue([{ sessionId: 'c1', enabled: true, _count: { _all: 7 }, _max: { lastFiredAt: hoursAgo(1) } }]);
    const block = await buildProjectScheduleBlock('proj-capped', NOW);
    expect(block).toContain('7 enabled: cccc0001 next 16:17Z; cccc0002 next 16:27Z +5 more');
    expect(block).not.toContain('"Capped lane": NO enabled schedules');
  });

  it('never throws — any query failure degrades to an empty block', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'c1', title: 'Lane' }]);
    mockSchedFindMany.mockRejectedValue(new Error('db down'));
    mockSchedGroupBy.mockRejectedValue(new Error('db down'));
    mockRunGroupBy.mockRejectedValue(new Error('db down'));
    // Each leg failure is caught per-leg (degrades to []) — and with no rows
    // there is nothing to table, matching the fleet block's no-spam doctrine.
    expect(await buildProjectScheduleBlock('proj-err', NOW)).toBe('');
    mockChatFindMany.mockRejectedValue(new Error('db down'));
    expect(await buildProjectScheduleBlock('proj-err', NOW)).toBe('');
  });

  it('lanes beyond the line cap are dropped and the block stays within its char cap', async () => {
    const chats = Array.from({ length: 30 }, (_, i) => ({ id: `lane-${String(i).padStart(2, '0')}`, title: `Lane ${i} with a moderately long title here` }));
    mockChatFindMany.mockResolvedValue(chats);
    mockSchedFindMany.mockResolvedValue(
      chats.map((c, i) => ({ id: `cccc${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`, sessionId: c.id, nextRunAt: minutesAhead(5 + i) })),
    );
    mockSchedGroupBy.mockResolvedValue(
      chats.map((c) => ({ sessionId: c.id, enabled: true, _count: { _all: 1 }, _max: { lastFiredAt: hoursAgo(1) } })),
    );
    const block = await buildProjectScheduleBlock('proj-wide', NOW);
    const lineCount = block.split('\n').filter((l) => l.startsWith('- chat ')).length;
    expect(lineCount).toBeLessThanOrEqual(16);
    expect(block.length).toBeLessThanOrEqual(2850); // cap raised 1600 → 2400 for IDLE CADENCE annotations (autonomy loop #12); → 2850 for full chat ids (audit 2026-10-08 W1-7)
  });

  it('run-cap utilization (ticket b4d1096c): an enabled recurring row renders its runs/max fraction; a ≥90% row carries the NEAR-CAP re-arm flag', async () => {
    const LANE = '184abfe9-0000-4000-8000-000000000001';
    mockChatFindMany.mockResolvedValue([{ id: LANE, title: 'CanLaw coordinator watch' }]);
    const far = new Date(NOW.getTime() + 20 * 86_400_000);
    mockSchedFindMany.mockResolvedValue([
      // The ticket's field shape: the coordinator watch burning 482/500.
      { id: '66cee89e-610e-449f-90a8-b378b2bc9862', sessionId: LANE, nextRunAt: minutesAhead(33), kind: 'recurring', runsCount: 482, maxRuns: 500, expiresAt: far },
      { id: 'aaaa0001-0000-4000-8000-000000000001', sessionId: LANE, nextRunAt: minutesAhead(56), kind: 'recurring', runsCount: 100, maxRuns: 500, expiresAt: far },
    ]);
    mockSchedGroupBy.mockResolvedValue([{ sessionId: LANE, enabled: true, _count: { _all: 2 }, _max: { lastFiredAt: hoursAgo(1) } }]);
    const block = await buildProjectScheduleBlock('proj-canlaw', NOW);
    expect(block).toContain('66cee89e next');
    expect(block).toContain('482/500 ⚠NEAR-CAP — re-arm pre-emptively');
    expect(block).toContain('aaaa0001 next');
    expect(block).toContain('100/500');
    expect(block).not.toContain('100/500 ⚠NEAR-CAP');
  });
});
