/**
 * sweep-triage.ts — decision-gate purpose 'sweep_triage' (N2, 2026-09-25).
 *
 *  - non-sweep prompts, the kill switch and mode 'off' never touch the DB or the seat;
 *  - the snapshot is CODE-COMPUTED from the ledger (runs / hook events / asks /
 *    tickets / status card / the supervisor's own last note) and bounded;
 *  - shadow → the stash rides the firing (no outcome row here);
 *  - act (designed, not enabled) → a confidently quiet sweep is skipped, with
 *    the heartbeat floor and the consecutive-skip ledger in lastStatus;
 *  - every failure (snapshot read, timeout, null gate, throw) fails OPEN.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn() },
  agentRun: { findMany: jest.fn() },
  eventHook: { findMany: jest.fn() },
  hookEvent: { findMany: jest.fn() },
  ownerQuestion: { findMany: jest.fn() },
  userFeatureRequest: { count: jest.fn() },
  crossModelMessage: { findFirst: jest.fn() },
  // audit 2026-10-06 T4-3: the supervisor's own ledger (open owner directives).
  supervisorState: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  stashDecision: (d: any, purpose: string) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'now' } : null),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

const mockClassify: jest.Mock = jest.fn((c: unknown) => (/no-op/i.test(String(c)) ? 'supervisor_noop' : 'supervisor_note'));
jest.mock('./supervisor.service', () => ({
  __esModule: true,
  classifySupervisorNote: (...a: any[]) => mockClassify(...(a as [unknown])),
}));

const mockLatestStatus: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockHourly: jest.Mock = jest.fn(() => true);
jest.mock('../fleet/project-status.service', () => ({
  __esModule: true,
  getLatestProjectStatus: (...a: any[]) => mockLatestStatus(...a),
  projectStatusHourlyEnabled: () => mockHourly(),
}));

import {
  buildSweepTriageState,
  computeSweepSnapshot,
  consecutiveSweepSkips,
  preTriageSweepFiring,
  setSweepControlSampler,
  sweepHeartbeatTicks,
  sweepSkipStatus,
  SWEEP_TRIAGE_QUESTION,
  SWEEP_TRIAGE_QUESTIONS,
  SWEEP_TRIAGE_DEFAULT_HEARTBEAT_TICKS,
  type SweepSnapshot,
} from './sweep-triage';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const FLEET_PROMPT = 'Fleet Supervisor sweep — a GOAL LEDGER diff, not a status bulletin.';
const PROJECT_PROMPT = 'Project Supervisor sweep for "CanLaw" (projectId p1) — a GOAL LEDGER diff.';

const ENV = ['DECISION_GATE_SWEEP_HEARTBEAT_TICKS'];
const saved: Record<string, string | undefined> = {};

const seedLedger = (over: Partial<Record<string, any>> = {}) => {
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'sup', userId: 'u1', projectId: 'p1', isSupervisor: false, isProjectSupervisor: true, ...over.chat });
  mockPrisma.crossModelChat.findMany.mockResolvedValue(over.scope ?? [{ id: 'lane-a' }, { id: 'lane-b' }]);
  mockPrisma.agentRun.findMany.mockResolvedValue(over.runs ?? [
    { status: 'running', sessionId: 'lane-a', startedAt: min(200) },
    { status: 'completed', sessionId: 'lane-b', startedAt: min(40) },
    { status: 'failed', sessionId: 'lane-b', startedAt: min(30) },
  ]);
  mockPrisma.eventHook.findMany.mockResolvedValue(over.hooks ?? [{ id: 'hook-1' }]);
  mockPrisma.hookEvent.findMany.mockResolvedValue(over.events ?? [
    { eventType: 'run_completed', status: 'delivered' },
    { eventType: 'run_failed', status: 'pending' },
  ]);
  mockPrisma.ownerQuestion.findMany.mockResolvedValue(over.asks ?? [{ createdAt: min(10) }, { createdAt: min(500) }]);
  mockPrisma.userFeatureRequest.count.mockResolvedValue(over.tickets ?? 1);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(over.note === null ? null : (over.note ?? { content: 'SWEEP: no-op — nothing moved since 10:00Z.', createdAt: min(61) }));
  mockLatestStatus.mockResolvedValue(over.card === null ? null : (over.card ?? {
    status: { headline: 'CanLaw: 2 of 3 goals active; 1 lane working', goals: { active: 2, done: 1, blocked: 0 }, todos: { inProgress: 1, pending: 2, blocked: 0, doneSince: 0 }, lanesRunning: 1, ownerItems: 1 },
    unchanged: true, quietChecks: 2, generatedAt: min(20).toISOString(),
  }));
};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  mockMode.mockReturnValue('off');
  mockDecide.mockResolvedValue(null);
  seedLedger();
  // backlog E12 (2026-09-28): the act path now fires 1 skip in 10 as a CONTROL
  // (Math.random). These pins describe the skip path, so the draw is pinned to
  // "never a control" here; the control sample itself is pinned in
  // sweep-triage.control.e12.test.ts.
  setSweepControlSampler(() => 1);
});
afterEach(() => {
  setSweepControlSampler(null);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('pure pieces', () => {
  it('the question is a criteria-bearing noul under the wake_triage key', () => {
    const q = SWEEP_TRIAGE_QUESTIONS[SWEEP_TRIAGE_QUESTION] as any;
    expect(SWEEP_TRIAGE_QUESTION).toBe('needs_turn_now');
    expect(q.type).toBe('noul');
    expect(q.criteria.true).toBeTruthy();
    expect(q.criteria.false).toBeTruthy();
  });

  it('consecutiveSweepSkips / sweepSkipStatus round-trip; anything else reads 0', () => {
    expect(consecutiveSweepSkips(undefined)).toBe(0);
    expect(consecutiveSweepSkips('started')).toBe(0);
    expect(consecutiveSweepSkips('skipped:delta_unchanged')).toBe(0);
    expect(consecutiveSweepSkips('skipped:sweep_quiet')).toBe(1);
    expect(consecutiveSweepSkips('skipped:sweep_quiet:2')).toBe(2);
    expect(consecutiveSweepSkips('skipped:sweep_quiet:x')).toBe(1);
    expect(sweepSkipStatus(3)).toBe('skipped:sweep_quiet:3');
    expect(consecutiveSweepSkips(sweepSkipStatus(0))).toBe(1);
  });

  it('heartbeat ticks: default 3, clamped 2..24', () => {
    expect(sweepHeartbeatTicks()).toBe(SWEEP_TRIAGE_DEFAULT_HEARTBEAT_TICKS);
    process.env.DECISION_GATE_SWEEP_HEARTBEAT_TICKS = '1';
    expect(sweepHeartbeatTicks()).toBe(2);
    process.env.DECISION_GATE_SWEEP_HEARTBEAT_TICKS = '99';
    expect(sweepHeartbeatTicks()).toBe(24);
  });

  it('buildSweepTriageState flattens the snapshot to counts first, prose last, and drops empty blocks', () => {
    const snap: SweepSnapshot = {
      sweep: 'fleet', since: '2026-09-25T10:00:00.000Z', windowMin: 120, scopeChats: 12,
      lanes: { running: 2, startedSince: 1, finishedSince: 3, failedSince: 1, cancelledSince: 0, queued: 0 },
      hookEvents: { total: 4, pending: 1, byType: { run_completed: 3, run_failed: 1 } },
      ownerAsks: { open: 2, newSince: 1 }, newTicketsSince: 0, projectStatus: null, lastNote: { kind: 'supervisor_noop', ageMin: 121, head: 'SWEEP: no-op' },
    };
    const state = buildSweepTriageState(snap);
    expect(state).toMatchObject({
      window_minutes_since_previous_sweep: 120, lanes_in_scope: 12, lanes_running_now: 2, runs_finished_since: 3, runs_failed_since: 1,
      hook_events_since: 4, hook_events_still_pending: 1, hook_event_types_since: { run_completed: 3, run_failed: 1 },
      owner_asks_open: 2, owner_asks_new_since: 1, tickets_filed_since: 0, total_movement_events_since: 10,
      previous_sweep_note: { class: 'supervisor_noop', minutes_ago: 121, head: 'SWEEP: no-op' },
    });
    expect(String(state.sweep)).toContain('fleet');
    expect(state).not.toHaveProperty('project_status_card');
    expect(JSON.stringify(state).length).toBeLessThan(2000);
  });
});

describe('computeSweepSnapshot', () => {
  it('a PROJECT sweep scopes to the project, counts runs/events/asks/tickets, reads the status card and classifies the last note', async () => {
    const snap = await computeSweepSnapshot({ sessionId: 'sup', sweep: 'project', since: min(60), now: NOW });
    expect(snap).toMatchObject({
      sweep: 'project', windowMin: 60, scopeChats: 2,
      lanes: { running: 1, finishedSince: 1, failedSince: 1, cancelledSince: 0, startedSince: 2, queued: 0 },
      hookEvents: { total: 2, pending: 1, byType: { run_completed: 1, run_failed: 1 } },
      ownerAsks: { open: 2, newSince: 1 }, newTicketsSince: 1,
      projectStatus: { headline: 'CanLaw: 2 of 3 goals active; 1 lane working', unchanged: true, quietChecks: 2, lanesRunning: 1, ownerItems: 1 },
      lastNote: { kind: 'supervisor_noop', ageMin: 61 },
    });
    expect(mockPrisma.crossModelChat.findMany.mock.calls[0][0].where).toMatchObject({ projectId: 'p1', archivedAt: null, id: { not: 'sup' } });
    expect(mockPrisma.agentRun.findMany.mock.calls[0][0].where.sessionId).toEqual({ in: ['lane-a', 'lane-b'] });
    expect(mockPrisma.hookEvent.findMany.mock.calls[0][0].where).toMatchObject({ hookId: { in: ['hook-1'] } });
    expect(mockPrisma.ownerQuestion.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'u1', status: 'open', chatId: { in: ['sup', 'lane-a', 'lane-b'] } });
    expect(mockLatestStatus).toHaveBeenCalledWith('p1');
  });

  it('2026-09-29 change-only cards: a card older than an hour reads as unchanged with quietChecks = whole hours since (the stub is no longer written)', async () => {
    mockHourly.mockReturnValue(false);
    try {
      seedLedger({ card: { status: { headline: 'CanLaw: 2 of 3 goals active', lanesRunning: 0, ownerItems: 0 }, unchanged: false, generatedAt: min(185).toISOString() } });
      let snap = await computeSweepSnapshot({ sessionId: 'sup', sweep: 'project', since: min(60), now: NOW });
      expect(snap!.projectStatus).toMatchObject({ unchanged: true, quietChecks: 3 });
      seedLedger({ card: { status: { headline: 'CanLaw: 2 of 3 goals active', lanesRunning: 0, ownerItems: 0 }, unchanged: false, generatedAt: min(20).toISOString() } });
      snap = await computeSweepSnapshot({ sessionId: 'sup', sweep: 'project', since: min(60), now: NOW });
      expect(snap!.projectStatus).toMatchObject({ unchanged: false });
      expect(snap!.projectStatus).not.toHaveProperty('quietChecks');
    } finally {
      mockHourly.mockReturnValue(true);
    }
  });

  it("a FLEET sweep scopes to the owner's chats (no project filter, no status card); an empty scope skips the run read", async () => {
    seedLedger({ chat: { projectId: null, isSupervisor: true, isProjectSupervisor: false }, scope: [], hooks: [], note: null });
    const snap = await computeSweepSnapshot({ sessionId: 'sup', sweep: 'fleet', since: min(120), now: NOW });
    expect(snap).toMatchObject({ sweep: 'fleet', scopeChats: 0, lanes: { running: 0, finishedSince: 0 }, hookEvents: { total: 0 }, projectStatus: null, lastNote: null });
    expect(mockPrisma.crossModelChat.findMany.mock.calls[0][0].where).toMatchObject({ userId: 'u1' });
    expect(mockPrisma.crossModelChat.findMany.mock.calls[0][0].where).not.toHaveProperty('projectId');
    expect(mockPrisma.agentRun.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.hookEvent.findMany).not.toHaveBeenCalled();
    expect(mockLatestStatus).not.toHaveBeenCalled();
  });

  it('a missing supervisor chat → null; a status-card read failure degrades to no card, not a throw', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    expect(await computeSweepSnapshot({ sessionId: 'gone', sweep: 'project', since: min(60), now: NOW })).toBeNull();
    seedLedger();
    mockLatestStatus.mockRejectedValue(new Error('card boom'));
    const snap = await computeSweepSnapshot({ sessionId: 'sup', sweep: 'project', since: min(60), now: NOW });
    expect(snap?.projectStatus).toBeNull();
    expect(snap?.lanes.running).toBe(1);
  });
});

describe('preTriageSweepFiring', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 'sch_sweep', sessionId: 'sup', prompt: PROJECT_PROMPT, lastFiredAt: min(60), intervalSec: 3600, lastStatus: 'started', ...over });
  const quiet = (noul = 0.05, mode: 'shadow' | 'act' = 'shadow') => ({ id: 'st1', mode, backend: 'TypeSafe Jev', ms: 6, answers: { needs_turn_now: { type: 'noul', noul } } });
  const NONE = { sweep: null, decision: null, stash: null, skip: null };

  it('a non-sweep prompt never touches the DB or the seat (even in act mode)', async () => {
    mockMode.mockReturnValue('act');
    expect(await preTriageSweepFiring(row({ prompt: 'watch the bench score' }), NOW)).toEqual(NONE);
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('mode off (the hermetic default) → nothing consulted', async () => {
    expect(await preTriageSweepFiring(row(), NOW)).toEqual(NONE);
    expect(mockPrisma.crossModelChat.findUnique).not.toHaveBeenCalled();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('SHADOW: the gate is asked over the code-computed state; the stash rides (no outcome row, no skip)', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(quiet(0.05));
    const r = await preTriageSweepFiring(row(), NOW);
    expect(r.sweep).toBe('project');
    expect(r.skip).toBeNull();
    expect(r.stash).toMatchObject({ id: 'st1', purpose: 'sweep_triage', mode: 'shadow', answers: { needs_turn_now: { type: 'noul', noul: 0.05 } } });
    expect(mockDecide).toHaveBeenCalledTimes(1);
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(questions).toBe(SWEEP_TRIAGE_QUESTIONS);
    expect(opts).toMatchObject({ purpose: 'sweep_triage', sessionId: 'sup' });
    expect(state).toMatchObject({ window_minutes_since_previous_sweep: 60, lanes_running_now: 1, runs_failed_since: 1, hook_events_still_pending: 1, owner_asks_new_since: 1, tickets_filed_since: 1 });
    expect(state.project_status_card).toMatchObject({ unchanged_since_previous_card: true, quiet_checks: 2 });
    expect(state.previous_sweep_note).toMatchObject({ class: 'supervisor_noop' });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('SHADOW with a "needs a turn" answer behaves identically — the stash rides, the label decides later', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(quiet(0.91));
    const r = await preTriageSweepFiring(row(), NOW);
    expect(r.skip).toBeNull();
    expect(r.stash?.id).toBe('st1');
  });

  it('the window is the previous firing, else one cadence back, never more than 24 h', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(quiet());
    await preTriageSweepFiring(row({ lastFiredAt: null, intervalSec: 7200 }), NOW);
    expect(mockDecide.mock.calls[0][0].window_minutes_since_previous_sweep).toBe(120);
    jest.clearAllMocks(); seedLedger(); mockMode.mockReturnValue('shadow'); mockDecide.mockResolvedValue(quiet());
    await preTriageSweepFiring(row({ lastFiredAt: min(3 * 24 * 60) }), NOW);
    expect(mockDecide.mock.calls[0][0].window_minutes_since_previous_sweep).toBe(24 * 60);
  });

  it('ACT (designed, not enabled): a confidently quiet sweep is SKIPPED with acted:true and the consecutive-skip ledger', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(quiet(0.05, 'act'));
    const r = await preTriageSweepFiring(row(), NOW);
    expect(r.skip).toEqual({ needsTurn: 0.05, consecutive: 1, sweep: 'project' });
    expect(r.stash).toBeNull();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toBe('sweep_triage');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'needs_turn_now', actual: null, acted: true, sessionId: 'sup' });
    // second consecutive skip
    jest.clearAllMocks(); seedLedger(); mockMode.mockReturnValue('act'); mockDecide.mockResolvedValue(quiet(0.05, 'act'));
    const r2 = await preTriageSweepFiring(row({ lastStatus: 'skipped:sweep_quiet:1' }), NOW);
    expect(r2.skip).toMatchObject({ consecutive: 2 });
  });

  it('ACT: the heartbeat floor fires the sweep after ticks−1 consecutive skips (default 3 → the 3rd tick fires), stash rides', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(quiet(0.05, 'act'));
    const r = await preTriageSweepFiring(row({ lastStatus: 'skipped:sweep_quiet:2' }), NOW);
    expect(r.skip).toBeNull();
    expect(r.stash?.purpose).toBe('sweep_triage');
    expect(mockRecord).not.toHaveBeenCalled();
    // a higher floor keeps skipping
    jest.clearAllMocks(); seedLedger(); mockMode.mockReturnValue('act'); mockDecide.mockResolvedValue(quiet(0.05, 'act'));
    process.env.DECISION_GATE_SWEEP_HEARTBEAT_TICKS = '6';
    expect((await preTriageSweepFiring(row({ lastStatus: 'skipped:sweep_quiet:2' }), NOW)).skip).toMatchObject({ consecutive: 3 });
  });

  it('ACT: a not-confident-enough answer (0.2 > 1 − 0.85) fires with the stash', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(quiet(0.2, 'act'));
    const r = await preTriageSweepFiring(row(), NOW);
    expect(r.skip).toBeNull();
    expect(r.stash?.id).toBe('st1');
  });

  it('FAIL-OPEN: a null gate, a throwing gate, a throwing snapshot read and a missing chat all return no triage (the sweep fires)', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(null);
    expect(await preTriageSweepFiring(row(), NOW)).toEqual({ ...NONE, sweep: 'project' });
    mockDecide.mockRejectedValue(new Error('seat down'));
    expect(await preTriageSweepFiring(row(), NOW)).toEqual(NONE);
    mockDecide.mockResolvedValue(quiet(0.01, 'act'));
    mockPrisma.agentRun.findMany.mockRejectedValue(new Error('db down'));
    expect(await preTriageSweepFiring(row(), NOW)).toEqual(NONE);
    seedLedger();
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    expect(await preTriageSweepFiring(row(), NOW)).toEqual({ ...NONE, sweep: 'project' });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN: a snapshot that exceeds the read deadline is abandoned (no decision) — fake timers', async () => {
    jest.useFakeTimers();
    try {
      mockMode.mockReturnValue('act');
      mockPrisma.agentRun.findMany.mockImplementation(() => new Promise(() => { /* never resolves */ }));
      const p = preTriageSweepFiring(row(), NOW);
      await jest.advanceTimersByTimeAsync(9000);
      expect(await p).toEqual(NONE);
      expect(mockDecide).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a FLEET sweep prompt classifies as fleet', async () => {
    seedLedger({ chat: { projectId: null, isSupervisor: true, isProjectSupervisor: false } });
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(quiet());
    const r = await preTriageSweepFiring(row({ prompt: FLEET_PROMPT, intervalSec: 7200 }), NOW);
    expect(r.sweep).toBe('fleet');
    expect(String(mockDecide.mock.calls[0][0].sweep)).toContain('fleet');
  });
});

/**
 * audit 2026-10-06 T4-3 (spark.md F5): an OPEN OWNER directive on the
 * supervisor's own ledger is an owner ask (counted into owner_asks_open /
 * owner_asks_new_since) and PINS the sweep — an act-mode quiet verdict never
 * skips it. Supervisor-written rows never pin. Kill switch
 * SWEEP_TRIAGE_OWNER_DIRECTIVES_DISABLED=1.
 */
describe('T4-3 — open owner directives count as owner asks and pin the sweep', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 'sch_sweep', sessionId: 'sup', prompt: PROJECT_PROMPT, lastFiredAt: min(60), intervalSec: 3600, lastStatus: 'started', ...over });
  const quiet = (noul = 0.05, mode: 'shadow' | 'act' = 'act') => ({ id: 'st1', mode, backend: 'TypeSafe Jev', ms: 6, answers: { needs_turn_now: { type: 'noul', noul } } });
  const ledger = (directives: any[]) => ({ state: { directives, archived: [], dispatches: [], projects: [], notes: '', refutations: [] } });
  afterEach(() => { delete process.env.SWEEP_TRIAGE_OWNER_DIRECTIVES_DISABLED; mockPrisma.supervisorState.findUnique.mockResolvedValue(null); });

  it('snapshot folds open owner directives into ownerAsks (supervisor-written rows excluded)', async () => {
    mockPrisma.supervisorState.findUnique.mockResolvedValue(ledger([
      { id: 'd-owner-1', text: 'hmm now on the ui everything is down', at: min(30).toISOString(), status: 'open', origin: 'owner' },
      { id: 'd-sup-2', text: 'HOLD until green', at: min(30).toISOString(), status: 'open' },
    ]));
    const snap = await computeSweepSnapshot({ sessionId: 'sup', sweep: 'project', since: min(60), now: NOW });
    expect(snap!.ownerDirectives).toMatchObject({ open: 1, newSince: 1 });
    expect(snap!.ownerAsks).toEqual({ open: 3, newSince: 2 }); // 2 oq rows (1 new) + 1 directive (new)
  });

  it('ACT + quiet + an open owner directive → the sweep FIRES (no skip), the stash rides, a pin metric lands', async () => {
    mockPrisma.supervisorState.findUnique.mockResolvedValue(ledger([
      { id: 'd-owner-1', text: 'it seems it was powercycled off', at: min(120).toISOString(), status: 'open', origin: 'owner' },
    ]));
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(quiet(0.08));
    const r = await preTriageSweepFiring(row(), NOW);
    expect(r.skip).toBeNull();
    expect(r.stash?.purpose).toBe('sweep_triage');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sweep_triage_owner_pin', sessionId: 'sup', meta: expect.objectContaining({ ownerDirectivesOpen: 1, needsTurn: 0.08 }) }));
  });

  it('a supervisor-written open directive does NOT pin (the quiet sweep is skipped as before)', async () => {
    mockPrisma.supervisorState.findUnique.mockResolvedValue(ledger([
      { id: 'd-sup-2', text: 'HOLD until green', at: min(30).toISOString(), status: 'open' },
    ]));
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(quiet(0.05));
    const r = await preTriageSweepFiring(row(), NOW);
    expect(r.skip).toMatchObject({ consecutive: 1 });
  });

  it('kill switch SWEEP_TRIAGE_OWNER_DIRECTIVES_DISABLED=1 → no directive read, no pin, owner asks = oq rows only', async () => {
    process.env.SWEEP_TRIAGE_OWNER_DIRECTIVES_DISABLED = '1';
    mockPrisma.supervisorState.findUnique.mockResolvedValue(ledger([
      { id: 'd-owner-1', text: 'down again', at: min(30).toISOString(), status: 'open', origin: 'owner' },
    ]));
    const snap = await computeSweepSnapshot({ sessionId: 'sup', sweep: 'project', since: min(60), now: NOW });
    expect(snap!.ownerDirectives).toBeUndefined();
    expect(snap!.ownerAsks).toEqual({ open: 2, newSince: 1 });
    expect(mockPrisma.supervisorState.findUnique).not.toHaveBeenCalled();
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(quiet(0.05));
    const r = await preTriageSweepFiring(row(), NOW);
    expect(r.skip).toMatchObject({ consecutive: 1 });
  });
});
