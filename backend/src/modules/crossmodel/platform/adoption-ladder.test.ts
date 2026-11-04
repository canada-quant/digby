/**
 * ADOPTION LADDER pins (tt-rd audit 2026-09-27, kpi-honesty-loops finding 3).
 * Pure: lastKpiMoveAt walks the premise history newest-first and counts only a
 * RECEIPTED move TOWARD the bar (falls back to the registration stamp);
 * computeAdoptionLadder counts completed runs on the assignee lanes since that
 * stamp and trips at K experiments / H hours; the renderers. Sweep: one
 * [NO-ADOPTION] wake per tripped goal per 24 h (Redis dedupe), a loop_metrics
 * adoption_ladder row per wake, and a paused project / OFF switch never wakes.
 * Never throws.
 */
const store = new Map<string, string>();
const mockRedis: any = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  projectGoal: { findMany: jest.fn(async () => []) },
  projectTodo: { findMany: jest.fn(async () => []) },
  agentRun: { findMany: jest.fn(async () => []) },
};
const mockRecordLoopMetric = jest.fn();
const mockSwitchEnabled = jest.fn(async (..._a: any[]) => true);
const mockSwitchSkip = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), LOOP_METRIC_KINDS: { ADOPTION_LADDER: 'adoption_ladder' } }));
jest.mock('./supervisor-switch', () => ({ __esModule: true, getProjectSupervisorsEnabled: (...a: any[]) => mockSwitchEnabled(...a), recordSupervisorSwitchSkip: (...a: any[]) => mockSwitchSkip(...a) }));

import {
  movedToward, lastKpiMoveAt, computeAdoptionLadder, renderAdoptionLadderInline, renderLaneLadderClause, renderNoAdoptionWake,
  loadAdoptionLadders, ladderForLane, sweepAdoptionLadder, ADOPTION_WAKE_PREFIX, ADOPTION_LADDER_DEDUPE_SEC,
  ladderIsNewEvidence, adoptionLadderK, adoptionLadderHours, ADOPTION_LADDER_SEEN_SEC,
} from './adoption-ladder';
import { adoptionLadderK as leafK, adoptionLadderHours as leafHours } from './kpi-of-record';

const NOW = new Date('2026-09-27T15:05:00Z');
const GOAL = '226be7b7-0000-4000-8000-000000000000';
const LANE = 'ddd26be0-0000-4000-8000-000000000000';
const SUP = '810c924d-0000-4000-8000-000000000000';
const PID = 'p-ttrd';
const RID = 'f5b42fe6-1111-4000-8000-000000000000';
/** The tt-rd KPI as the register held it on 2026-09-27: the only receipted move toward the bar was 3.44 → 5.08 on 09-21; later values flapped. */
const KPI = {
  key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', bar: 10, receiptId: RID, setAt: '2026-09-27T13:22:15Z',
  prev: { value: 2.464, setAt: '2026-09-27T03:34:40Z', receiptId: 'aaaa1111-2222-4000-8000-000000000000' },
  history: [
    { value: 3.44, setAt: '2026-09-19T08:00:00Z', receiptId: '11111111-2222-4000-8000-000000000000' },
    { value: 5.08, setAt: '2026-09-21T08:42:00Z', receiptId: '22222222-2222-4000-8000-000000000000' }, // the adoption (PR #706)
    { value: 5.364, setAt: '2026-09-26T10:00:00Z', receiptId: '33333333-2222-4000-8000-000000000000' }, // toward the bar, receipted
    { value: 2.464, setAt: '2026-09-27T03:34:40Z', receiptId: 'aaaa1111-2222-4000-8000-000000000000' }, // the diagnostic-window regression
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  delete process.env.ADOPTION_LADDER_K;
  delete process.env.ADOPTION_LADDER_HOURS;
  mockSwitchEnabled.mockResolvedValue(true);
});

describe('adoption-ladder — pure', () => {
  it('movedToward: closer to the bar when one exists; any change otherwise', () => {
    expect(movedToward(3.44, 5.08, 10)).toBe(true);
    expect(movedToward(5.364, 2.464, 10)).toBe(false);
    expect(movedToward(5.08, 5.08, 10)).toBe(false);
    expect(movedToward(1, 2, undefined)).toBe(true);
    expect(movedToward(NaN, 2, 10)).toBe(false);
  });

  it('lastKpiMoveAt: the newest RECEIPTED new-best toward the bar (5.364 on 09-26), never the later regression nor the 2.464 → 5.08 recovery-to-a-known-value', () => {
    expect(lastKpiMoveAt(KPI)).toBe('2026-09-26T10:00:00Z');
    // Series ending at the regression: the same answer.
    const flat = { ...KPI, value: 2.464, setAt: '2026-09-27T03:34:40Z', receiptId: 'aaaa1111-2222-4000-8000-000000000000', history: KPI.history.slice(0, 3) };
    expect(lastKpiMoveAt(flat)).toBe('2026-09-26T10:00:00Z');
    // A genuine new best after the flap moves the clock.
    expect(lastKpiMoveAt({ ...KPI, value: 6.02, setAt: '2026-09-27T14:00:00Z' })).toBe('2026-09-27T14:00:00Z');
    // A move without a receipt does not count.
    const unreceipted = { key: 'kpi:x', value: 6, bar: 10, setAt: '2026-09-27T12:00:00Z', history: [{ value: 5, setAt: '2026-09-20T00:00:00Z', receiptId: RID }] };
    expect(lastKpiMoveAt(unreceipted)).toBe('2026-09-20T00:00:00Z');
    // No history: the registration stamp; no stamp at all: null.
    expect(lastKpiMoveAt({ key: 'kpi:y', value: 1, setAt: '2026-09-25T00:00:00Z' })).toBe('2026-09-25T00:00:00Z');
    expect(lastKpiMoveAt({ key: 'kpi:z', value: 1 })).toBeNull();
  });

  it('computeAdoptionLadder counts completed runs on the assignee lanes after the last move and trips at K / H', () => {
    const kpi = { key: 'kpi:e2e', value: 5.08, unit: 'tok/s', bar: 10, receiptId: RID, setAt: '2026-09-21T08:42:00Z' };
    const runs = [
      ...Array.from({ length: 27 }, (_, i) => ({ sessionId: LANE, finishedAt: new Date(Date.UTC(2026, 8, 25, i, 0, 0)) })),
      { sessionId: LANE, finishedAt: new Date('2026-09-20T00:00:00Z') }, // before the move — not counted
      { sessionId: 'other-lane', finishedAt: new Date('2026-09-26T00:00:00Z') }, // not an assignee — not counted
      { sessionId: LANE, finishedAt: null },
    ];
    const l = computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 'Serve Qwen3.8 on QB2', kpi, lanes: [LANE], completedRuns: runs, now: NOW })!;
    expect(l.experiments).toBe(27);
    expect(l.hours).toBeCloseTo(150.4, 0);
    expect(l.lastMoveAt).toBe('2026-09-21T08:42:00Z');
    expect(l.tripped).toBe(true);
    expect(renderAdoptionLadderInline(l)).toBe('KPI 5.08 tok/s unchanged since 09-21 08:42Z · 27 experiments / 6.3 d without adoption');
    expect(renderLaneLadderClause(l)).toBe('27 experiments since the last KPI move (kpi:e2e=5.08 tok/s since 09-21 08:42Z)');
    const wake = renderNoAdoptionWake(l, 'tt-rd', NOW);
    expect(wake.startsWith(`${ADOPTION_WAKE_PREFIX} goal 226be7b7 "Serve Qwen3.8 on QB2" in tt-rd: KPI kpi:e2e=5.08 tok/s (receipt f5b42fe6), bar ≥10, has not moved toward its bar since 09-21 08:42Z — 27 completed work sessions / 6d on lane(s) ddd26be0 without an adoption`)).toBe(true);
    for (const s of ['RE-PLAN', 'ADOPTION CRITERION', 'ESCALATE', 'STUCK-SINCE', 'Fold the negative result ONCE', 'Never a card']) expect(wake).toContain(s);
    // Below both thresholds nothing trips; a fresh registration renders no clause yet.
    const quiet = computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 't', kpi: { ...kpi, setAt: '2026-09-27T14:30:00Z' }, lanes: [LANE], completedRuns: runs, now: NOW })!;
    expect(quiet.experiments).toBe(0);
    expect(quiet.tripped).toBe(false);
    expect(renderAdoptionLadderInline(quiet)).toBe('');
    // Thresholds are env-tunable.
    process.env.ADOPTION_LADDER_K = '30';
    process.env.ADOPTION_LADDER_HOURS = '200';
    expect(computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 't', kpi, lanes: [LANE], completedRuns: runs, now: NOW })!.tripped).toBe(false);
    // No stamp at all ⇒ no ladder.
    expect(computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 't', kpi: { key: 'kpi:e2e', value: 1 }, lanes: [LANE], completedRuns: [], now: NOW })).toBeNull();
  });
});

describe('adoption-ladder — readers + sweep', () => {
  const goalRow = { id: GOAL, projectId: PID, title: 'Serve Qwen3.8 on QB2', status: 'active', premises: [{ key: 'host_tail_ms', value: 12 }, { ...KPI, value: 5.08, setAt: '2026-09-21T08:42:00Z', prev: undefined, history: [] }] };
  const wire = () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([goalRow, { id: 'g-nokpi', projectId: PID, title: 'no kpi', status: 'active', premises: [] }]);
    mockPrisma.projectTodo.findMany.mockResolvedValue([{ goalId: GOAL, assigneeChatId: LANE }, { goalId: GOAL, assigneeChatId: null }]);
    mockPrisma.agentRun.findMany.mockResolvedValue(Array.from({ length: 9 }, (_, i) => ({ sessionId: LANE, finishedAt: new Date(Date.UTC(2026, 8, 26, i, 0, 0)) })));
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: SUP, projectId: PID }]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: PID, name: 'tt-rd', projectSupervisorEnabled: true, archivedAt: null }]);
  };

  it('loadAdoptionLadders returns a ladder per KPI goal only (a goal without kpi: has no signal); ladderForLane finds the lane\'s goal', async () => {
    wire();
    const ladders = await loadAdoptionLadders(PID, NOW);
    expect([...ladders.keys()]).toEqual([GOAL]);
    expect(ladders.get(GOAL)!.experiments).toBe(9);
    expect(ladders.get(GOAL)!.lanes).toEqual([LANE]);
    expect(mockPrisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ sessionId: { in: [LANE] }, status: 'completed' }) }));
    mockPrisma.projectTodo.findMany.mockResolvedValueOnce([{ goalId: GOAL }]); // the lane's own todos
    const mine = await ladderForLane(LANE, NOW);
    expect(mine?.goalId).toBe(GOAL);
    expect(mine?.experiments).toBe(9);
    // a lane with no KPI goal: null; a read error: null (never throws)
    mockPrisma.projectTodo.findMany.mockResolvedValueOnce([]);
    expect(await ladderForLane('lane-x', NOW)).toBeNull();
    mockPrisma.projectTodo.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await ladderForLane(LANE, NOW)).toBeNull();
    mockPrisma.projectGoal.findMany.mockRejectedValueOnce(new Error('db down'));
    expect((await loadAdoptionLadders(PID, NOW)).size).toBe(0);
  });

  it('sweep: a tripped goal wakes its project supervisor ONCE per 24 h with [NO-ADOPTION] + one adoption_ladder row; the switch/paused project never wake', async () => {
    wire();
    const wake = jest.fn(async (_o: any) => ({ ok: true }));
    const out = await sweepAdoptionLadder({ now: NOW, enqueueDirectWake: wake });
    expect(out).toEqual({ projects: 1, tripped: 1, wakes: 1, unchanged: 0 });
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0][0]).toEqual(expect.objectContaining({ targetChatId: SUP, meta: expect.objectContaining({ origin: 'adoption-ladder', kind: 'no_adoption', goalId: GOAL, experiments: 9 }) }));
    expect(String((wake.mock.calls[0][0] as any).prompt).startsWith(ADOPTION_WAKE_PREFIX)).toBe(true);
    expect(mockRedis.set).toHaveBeenCalledWith(`adoption:noadopt:${GOAL}`, expect.any(String), { EX: ADOPTION_LADDER_DEDUPE_SEC });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'adoption_ladder', sessionId: SUP, meta: expect.objectContaining({ goalId: GOAL, experiments: 9, kpiKey: 'kpi:client_visible_e2e_tok_s', woken: true }) }));
    // deduped on the second sweep
    const again = await sweepAdoptionLadder({ now: NOW, enqueueDirectWake: wake });
    expect(again.wakes).toBe(0);
    expect(wake).toHaveBeenCalledTimes(1);
    store.clear();
    // supervisor OFF switch: skip rows, no wake
    mockSwitchEnabled.mockResolvedValueOnce(false);
    expect((await sweepAdoptionLadder({ now: NOW, enqueueDirectWake: wake })).wakes).toBe(0);
    expect(mockSwitchSkip).toHaveBeenCalledWith(expect.objectContaining({ target: 'project', chatId: SUP }));
    // paused project (projectSupervisorEnabled false): never scanned
    mockPrisma.crossModelProject.findMany.mockResolvedValueOnce([{ id: PID, name: 'tt-rd', projectSupervisorEnabled: false, archivedAt: null }]);
    expect((await sweepAdoptionLadder({ now: NOW, enqueueDirectWake: wake })).projects).toBe(0);
    expect(wake).toHaveBeenCalledTimes(1);
    // a wake failure is swallowed
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: PID, name: 'tt-rd', projectSupervisorEnabled: true, archivedAt: null }]);
    const boom = jest.fn(async (_o: any) => { throw new Error('hooks down'); });
    await expect(sweepAdoptionLadder({ now: NOW, enqueueDirectWake: boom })).resolves.toEqual(expect.objectContaining({ wakes: 0 }));
  });
});

// ── Fixer follow-up 2026-09-27 (branch review finding 2): the wake fires only on what the harness measured ──
describe('adoption-ladder — fixer follow-up: measured states only', () => {
  const kpi = { key: 'kpi:e2e', value: 5.08, unit: 'tok/s', bar: 10, receiptId: RID, setAt: '2026-09-20T08:42:00Z' }; // 7.3 days before NOW
  const goalRow = { id: GOAL, projectId: PID, title: 'Serve Qwen3.8 on QB2', status: 'active', premises: [{ ...KPI, value: 5.08, setAt: '2026-09-21T08:42:00Z', prev: undefined, history: [] }] };
  const wire = (runs = 9) => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([goalRow]);
    mockPrisma.projectTodo.findMany.mockResolvedValue([{ goalId: GOAL, assigneeChatId: LANE }]);
    mockPrisma.agentRun.findMany.mockResolvedValue(Array.from({ length: runs }, (_, i) => ({ sessionId: LANE, finishedAt: new Date(Date.UTC(2026, 8, 26, i, 0, 0)) })));
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: SUP, projectId: PID }]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: PID, name: 'tt-rd', projectSupervisorEnabled: true, archivedAt: null }]);
  };

  it('the thresholds are the leaf\'s (kpi-of-record) so the doctrine budget and the wake agree', () => {
    expect(adoptionLadderK).toBe(leafK);
    expect(adoptionLadderHours).toBe(leafHours);
    expect(adoptionLadderK()).toBe(8);
    expect(adoptionLadderHours()).toBe(48);
  });

  it('the hours branch trips only with ≥ 1 completed experiment in the window — 7 idle days measured nothing about the lane', () => {
    const idle = computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 't', kpi, lanes: [LANE], completedRuns: [], now: NOW })!;
    expect(idle.experiments).toBe(0);
    expect(idle.hours).toBeGreaterThan(48);
    expect(idle.tripped).toBe(false);
    const one = computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 't', kpi, lanes: [LANE], completedRuns: [{ sessionId: LANE, finishedAt: new Date('2026-09-25T00:00:00Z') }], now: NOW })!;
    expect(one.experiments).toBe(1);
    expect(one.tripped).toBe(true);
    // K experiments trip regardless of hours
    const fresh = { ...kpi, setAt: '2026-09-27T10:00:00Z' };
    const busy = computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 't', kpi: fresh, lanes: [LANE], completedRuns: Array.from({ length: 8 }, (_, i) => ({ sessionId: LANE, finishedAt: new Date(Date.UTC(2026, 8, 27, 10, i + 1, 0)) })), now: NOW })!;
    expect(busy.hours).toBeLessThan(48);
    expect(busy.tripped).toBe(true);
  });

  it('a goal whose value already satisfies its bar has no ladder (nothing left to adopt toward) — counts-up and counts-down alike', () => {
    const met = { key: 'kpi:e2e', value: 10.5, unit: 'tok/s', bar: 10, receiptId: RID, setAt: '2026-09-20T08:42:00Z', history: [{ value: 3.44, setAt: '2026-09-19T08:00:00Z', receiptId: RID }] };
    expect(computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 't', kpi: met, lanes: [LANE], completedRuns: [{ sessionId: LANE, finishedAt: new Date('2026-09-25T00:00:00Z') }], now: NOW })).toBeNull();
    const down = { key: 'kpi:p95_ms', value: 180, unit: 'ms', bar: 200, receiptId: RID, setAt: '2026-09-20T08:42:00Z', history: [{ value: 340, setAt: '2026-09-19T08:00:00Z', receiptId: RID }] };
    expect(computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 't', kpi: down, lanes: [LANE], completedRuns: [], now: NOW })).toBeNull();
    // below the bar the ladder exists as before
    expect(computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 't', kpi: { ...met, value: 9.9 }, lanes: [LANE], completedRuns: [], now: NOW })).not.toBeNull();
  });

  it('a BLOCKED goal is never laddered (its lanes are not expected to move the KPI); the readers ask for active goals only', async () => {
    wire();
    mockPrisma.projectGoal.findMany.mockResolvedValue([{ ...goalRow, status: 'blocked' }]);
    expect((await loadAdoptionLadders(PID, NOW)).size).toBe(0);
    expect(mockPrisma.projectGoal.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ projectId: PID, status: 'active' }) }));
    mockPrisma.projectTodo.findMany.mockResolvedValueOnce([{ goalId: GOAL }]);
    expect(await ladderForLane(LANE, NOW)).toBeNull();
    expect(mockPrisma.projectGoal.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'active' }) }));
  });

  it('the wake narrates only measured runs (no "every firing produced an artifact" on 0 experiments) and never instructs pause_schedule', () => {
    const busy = computeAdoptionLadder({ goalId: GOAL, projectId: PID, goalTitle: 't', kpi, lanes: [LANE], completedRuns: Array.from({ length: 27 }, (_, i) => ({ sessionId: LANE, finishedAt: new Date(Date.UTC(2026, 8, 25, i, 0, 0)) })), now: NOW })!;
    const wake = renderNoAdoptionWake(busy, 'tt-rd', NOW);
    expect(wake).toContain('27 completed work sessions since that move and no receipted KPI move');
    expect(wake).toContain('The harness measures completed runs, not artifacts');
    expect(wake).not.toContain('Every firing produced a different artifact');
    expect(wake).not.toContain('pause_schedule');
    expect(wake).toContain('The harness never pauses a lane for this');
    for (const s of ['(a) RE-PLAN', '(b) ESCALATE', 'STUCK-SINCE', 'Fold the negative result ONCE', 'Never a card']) expect(wake).toContain(s);
    const idle = { ...busy, experiments: 0 };
    expect(renderNoAdoptionWake(idle, 'tt-rd', NOW)).toContain('No work session has completed on the assignee lane(s) since that move');
  });

  it('ladderIsNewEvidence: nothing seen → new; same ladder with the same or a lower count → not new; more experiments or a moved KPI → new', () => {
    const l = { experiments: 9, lastMoveAt: '2026-09-21T08:42:00Z' };
    expect(ladderIsNewEvidence(l, null)).toBe(true);
    expect(ladderIsNewEvidence(l, { experiments: 9, lastMoveAt: '2026-09-21T08:42:00Z' })).toBe(false);
    expect(ladderIsNewEvidence(l, { experiments: 12, lastMoveAt: '2026-09-21T08:42:00Z' })).toBe(false);
    expect(ladderIsNewEvidence({ ...l, experiments: 10 }, { experiments: 9, lastMoveAt: '2026-09-21T08:42:00Z' })).toBe(true);
    expect(ladderIsNewEvidence({ ...l, lastMoveAt: '2026-09-27T14:00:00Z' }, { experiments: 9, lastMoveAt: '2026-09-21T08:42:00Z' })).toBe(true);
  });

  it('sweep: after the 24 h dedupe lapses the SAME count is not re-sent (unchanged), a higher count is — the daily no-op repeat is gone', async () => {
    wire(9);
    const wake = jest.fn(async (_o: any) => ({ ok: true }));
    expect(await sweepAdoptionLadder({ now: NOW, enqueueDirectWake: wake })).toEqual({ projects: 1, tripped: 1, wakes: 1, unchanged: 0 });
    expect(mockRedis.set).toHaveBeenCalledWith(`adoption:noadopt:seen:${GOAL}`, JSON.stringify({ experiments: 9, lastMoveAt: '2026-09-21T08:42:00Z' }), { EX: ADOPTION_LADDER_SEEN_SEC });
    store.delete(`adoption:noadopt:${GOAL}`); // the 24 h key expired; the 7-day seen stamp did not
    expect(await sweepAdoptionLadder({ now: NOW, enqueueDirectWake: wake })).toEqual({ projects: 1, tripped: 1, wakes: 0, unchanged: 1 });
    expect(wake).toHaveBeenCalledTimes(1);
    wire(12); // the lane kept firing without an adoption — new evidence
    store.delete(`adoption:noadopt:${GOAL}`);
    expect((await sweepAdoptionLadder({ now: NOW, enqueueDirectWake: wake })).wakes).toBe(1);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(wake.mock.calls[1][0]).toEqual(expect.objectContaining({ meta: expect.objectContaining({ experiments: 12 }) }));
  });
});
