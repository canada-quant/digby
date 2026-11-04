/**
 * firing-superseded-gate.ts — decision-gate purpose 'firing_superseded' (N7, 2026-09-25).
 *
 *  - eligibility is the SAME predicate for every mode: recurring + machine-authored
 *    (promptSetBy machine/system) + not owner-subscribed + actually parked (busySkips > 0);
 *  - the finished-run facts are CODE-COMPUTED from the ledger (agent_runs + the coding
 *    transcript row) and bounded; no completed run since the last fire ⇒ nothing to judge;
 *    a run that finished BEFORE the parked window (+ slack) did not hold the lane ⇒
 *    'finished_before_park', facts surfaced, gate not asked (review 2026-09-25);
 *  - shadow → the stash rides the firing (no outcome row here);
 *  - act (designed, not enabled) → a confident drop/merge skips, keyed on the RESULT's mode;
 *  - every failure (read error, timeout, null gate, throw) fails OPEN.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentRun: { findFirst: jest.fn() },
  codingMessage: { findFirst: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// MERGE-1 slice 1: the gate now resolves its transcript through the read-switch seam.
// Mocked (not the real module) so this suite never drags in coding-data.service ->
// middleware/error-handler -> config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time. 'legacy' keeps every existing
// expectation (they seed mockPrisma.codingMessage) exactly as before this change.
jest.mock('./transcript-source', () => ({ __esModule: true, pickTranscriptSource: jest.fn(async () => 'legacy') }));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  stashDecision: (d: any, purpose: string) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'now' } : null),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

const mockClassify: jest.Mock = jest.fn((c: unknown) => (/no-op/i.test(String(c)) ? 'supervisor_noop' : 'supervisor_note'));
jest.mock('../platform/supervisor.service', () => ({
  __esModule: true,
  classifySupervisorNote: (...a: any[]) => mockClassify(...(a as [unknown])),
}));

import {
  buildFiringSupersededState,
  FIRING_SUPERSEDED_QUESTION,
  FIRING_SUPERSEDED_QUESTIONS,
  parkedFiringIneligibleReason,
  preGateParkedFiring,
  readFinishedRunFacts,
  SUPERSEDED_SKIP_STATUS,
  type ParkedFiringRow,
} from './firing-superseded-gate';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);

const row = (over: Partial<ParkedFiringRow> = {}): ParkedFiringRow => ({
  id: 'sch-1', sessionId: 'lane-1', prompt: 'Sweep the spark-cluster lanes: check S3 for new shards and report.',
  kind: 'recurring', intervalSec: 3600, busySkips: 4, promptSetBy: 'machine', ownerSubscribed: null,
  lastFiredAt: min(90), createdAt: min(10_000), ...over,
});

const seedLedger = (over: { run?: any; msg?: any } = {}) => {
  mockPrisma.agentRun.findFirst.mockResolvedValue('run' in over ? over.run : {
    id: 'run-abcdef12', startedAt: min(40), finishedAt: min(6), createdAt: min(41), input: { scheduleId: 'sch-1', triggerKind: 'schedule' },
  });
  mockPrisma.codingMessage.findFirst.mockResolvedValue('msg' in over ? over.msg : {
    content: 'Checked S3: 3 new shards found, reported to the supervisor. ' + 'x'.repeat(300),
    parts: [{ type: 'tool_call', name: 'run_command' }, { type: 'tool_call', name: 'send_chat_message' }, { type: 'text', text: 'done' }],
    metadata: { triggerKind: 'schedule', scheduleId: 'sch-1' },
  });
};

beforeEach(() => {
  mockPrisma.agentRun.findFirst.mockReset();
  mockPrisma.codingMessage.findFirst.mockReset();
  mockDecide.mockReset().mockResolvedValue(null);
  mockMode.mockReset().mockReturnValue('shadow');
  mockRecord.mockReset();
  mockClassify.mockClear();
});

describe('eligibility (the same predicate bounds shadow and act)', () => {
  it('a parked machine recurring row is eligible', () => {
    expect(parkedFiringIneligibleReason(row())).toBeNull();
    expect(parkedFiringIneligibleReason(row({ promptSetBy: 'system' }))).toBeNull();
  });
  it('one-shots, un-parked rows, owner-authored (user or NULL) and owner-subscribed rows are never judged', () => {
    expect(parkedFiringIneligibleReason(row({ kind: 'once' }))).toBe('one_shot');
    expect(parkedFiringIneligibleReason(row({ busySkips: 0 }))).toBe('not_parked');
    expect(parkedFiringIneligibleReason(row({ busySkips: null }))).toBe('not_parked');
    expect(parkedFiringIneligibleReason(row({ promptSetBy: 'user' }))).toBe('owner_authored');
    expect(parkedFiringIneligibleReason(row({ promptSetBy: null }))).toBe('owner_authored');
    expect(parkedFiringIneligibleReason(row({ ownerSubscribed: true }))).toBe('owner_subscribed');
  });
});

describe('readFinishedRunFacts — code-computed from the ledger', () => {
  it('reads the latest COMPLETED run since the last fire, its transcript final and counted receipts', async () => {
    seedLedger();
    const facts = await readFinishedRunFacts(row(), NOW);
    expect(facts).toMatchObject({
      runId: 'run-abcdef12', wasThisSchedulesFiring: true, triggerKind: 'schedule', finishedAgoMin: 6, durationMin: 34,
      toolCalls: 2, evidenceCalls: 2, mutatingCalls: 1, noteKind: 'supervisor_note', finishedBeforePark: false,
    });
    expect(facts!.finalHead.length).toBeLessThanOrEqual(1500);
    const runWhere = mockPrisma.agentRun.findFirst.mock.calls[0][0].where;
    expect(runWhere).toMatchObject({ sessionId: 'lane-1', status: 'completed' });
    expect(runWhere.finishedAt.gte.getTime()).toBe(min(90).getTime()); // since the schedule last fired
    const msgWhere = mockPrisma.codingMessage.findFirst.mock.calls[0][0].where;
    expect(msgWhere).toMatchObject({ chatId: 'lane-1', role: 'assistant' });
    expect(msgWhere.createdAt.gte.getTime()).toBe(min(40).getTime()); // the run's start
  });
  it('no completed run since the last fire ⇒ null (nothing to judge)', async () => {
    seedLedger({ run: null });
    expect(await readFinishedRunFacts(row(), NOW)).toBeNull();
    expect(mockPrisma.codingMessage.findFirst).not.toHaveBeenCalled();
  });
  it('a run with no transcript row still yields facts (empty final, zero receipts)', async () => {
    seedLedger({ msg: null });
    const facts = await readFinishedRunFacts(row(), NOW);
    expect(facts).toMatchObject({ finalHead: '', finalChars: 0, toolCalls: 0, evidenceCalls: 0, mutatingCalls: 0 });
  });
  it('a run that finished before the parked window (the SUM of the busy re-arm delays + 10 min slack) is flagged finishedBeforePark', async () => {
    // wake-cadence-6 geometric re-arm: busySkips 4 on a 60-min row ⇒ parked
    // 3+6+12+24 = 45 min; slack 10 ⇒ a run that finished 55 min ago is the
    // edge, 56 is before the park.
    seedLedger({ run: { id: 'run-old', startedAt: min(90), finishedAt: min(56), createdAt: min(91), input: { triggerKind: 'hook' } } });
    expect((await readFinishedRunFacts(row(), NOW))!).toMatchObject({ runId: 'run-old', finishedAgoMin: 56, finishedBeforePark: true, wasThisSchedulesFiring: false });
    seedLedger({ run: { id: 'run-edge', startedAt: min(90), finishedAt: min(55), createdAt: min(91), input: {} } });
    expect((await readFinishedRunFacts(row(), NOW))!).toMatchObject({ finishedAgoMin: 55, finishedBeforePark: false });
    // A longer park widens the window: busySkips 10 ⇒ 3+6+12+24×7 = 189 + 10 ⇒ the 56-minute-old run overlaps.
    seedLedger({ run: { id: 'run-old', startedAt: min(90), finishedAt: min(56), createdAt: min(91), input: {} } });
    expect((await readFinishedRunFacts(row({ busySkips: 10 }), NOW))!).toMatchObject({ finishedBeforePark: false });
  });
  it('the window never reaches back more than 24 h', async () => {
    seedLedger();
    await readFinishedRunFacts(row({ lastFiredAt: null, createdAt: min(60 * 24 * 7) }), NOW);
    const since: Date = mockPrisma.agentRun.findFirst.mock.calls[0][0].where.finishedAt.gte;
    expect(NOW.getTime() - since.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe('buildFiringSupersededState', () => {
  it('numbers first, prose last, bounded, no undefined keys', async () => {
    seedLedger();
    const facts = (await readFinishedRunFacts(row(), NOW))!;
    const state = buildFiringSupersededState(row({ prompt: 'p'.repeat(5000) }), facts, NOW);
    // parked_minutes = the SUM of the busy re-arm delays (wake-cadence-6
    // geometric backoff: 3+6+12+24 for 4 skips on a 60-min row).
    expect(state).toMatchObject({
      parked_minutes: 45, busy_skips: 4, cadence_minutes: 60, next_cadence_fires_in_minutes: 60, minutes_since_this_schedule_last_fired: 90,
      finished_run: { was_this_schedules_own_previous_firing: true, finished_minutes_ago: 6, tool_calls: 2, evidence_bearing_calls: 2, mutating_platform_calls: 1, final_class: 'supervisor_note' },
    });
    expect((state.schedule_prompt as string).length).toBe(2500);
    expect(Object.values(state).some((v) => v === undefined)).toBe(false);
    expect(JSON.stringify(state).length).toBeLessThan(6000);
  });
  it('the question is a three-way choice keyed fire / drop_superseded / merge_into_next', () => {
    const q = FIRING_SUPERSEDED_QUESTIONS[FIRING_SUPERSEDED_QUESTION];
    expect(q.type).toBe('choice');
    expect(Object.keys((q as any).criteria)).toEqual(['fire', 'drop_superseded', 'merge_into_next']);
  });
});

describe('preGateParkedFiring', () => {
  const decision = (choice: string, confidence: number, mode: 'shadow' | 'act' = 'shadow') => ({
    id: 'd1', mode, backend: 'TypeSafe Jev', ms: 80, answers: { [FIRING_SUPERSEDED_QUESTION]: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } },
  });

  it('ineligible rows and mode off never touch the DB or the seat', async () => {
    expect(await preGateParkedFiring(row({ kind: 'once' }), NOW)).toMatchObject({ ineligible: 'one_shot', decision: null, stash: null, skip: null });
    mockMode.mockReturnValue('off');
    expect((await preGateParkedFiring(row(), NOW)).ineligible).toBe('mode_off');
    expect(mockPrisma.agentRun.findFirst).not.toHaveBeenCalled();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('shadow: the stash rides the firing; no outcome row is written here; the firing is not skipped', async () => {
    seedLedger();
    mockDecide.mockResolvedValue(decision('drop_superseded', 0.97));
    const r = await preGateParkedFiring(row(), NOW);
    expect(r.skip).toBeNull();
    expect(r.stash).toMatchObject({ id: 'd1', purpose: 'firing_superseded' });
    expect(r.facts?.runId).toBe('run-abcdef12');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'firing_superseded', sessionId: 'lane-1' });
  });

  it('act: a confident drop_superseded / merge_into_next skips the firing (acted:true row); the caller stamps the matching lastStatus', async () => {
    seedLedger();
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(decision('merge_into_next', 0.95, 'act'));
    const r = await preGateParkedFiring(row(), NOW);
    expect(r.skip).toEqual({ disposition: 'merge_into_next', confidence: 0.95, finishedRunId: 'run-abcdef12' });
    expect(r.stash).toBeNull();
    expect(mockRecord).toHaveBeenCalledWith(expect.anything(), 'firing_superseded', expect.objectContaining({ actual: null, acted: true }));
    expect(SUPERSEDED_SKIP_STATUS[r.skip!.disposition]).toBe('skipped:merged_next');
    expect(SUPERSEDED_SKIP_STATUS.drop_superseded).toBe('skipped:superseded');
  });

  it('act: a confident fire, or a drop below the threshold, fires (stash rides)', async () => {
    seedLedger();
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(decision('fire', 0.99, 'act'));
    expect((await preGateParkedFiring(row(), NOW)).skip).toBeNull();
    mockDecide.mockResolvedValue(decision('drop_superseded', 0.7, 'act'));
    const r = await preGateParkedFiring(row(), NOW);
    expect(r.skip).toBeNull();
    expect(r.stash).toMatchObject({ purpose: 'firing_superseded' });
  });

  it("act requested but the RESULT's mode is shadow (uncalibrated backend, E2) ⇒ never skips", async () => {
    seedLedger();
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(decision('drop_superseded', 0.99, 'shadow'));
    const r = await preGateParkedFiring(row(), NOW);
    expect(r.skip).toBeNull();
    expect(r.stash).toMatchObject({ purpose: 'firing_superseded' });
  });

  it('finished_before_park: the latest completed run predates the park ⇒ not judged, facts surfaced, seat never called', async () => {
    // parked window = 45 min (geometric re-arm sums, wake-cadence-6) + 10 min
    // slack ⇒ a run that finished 80 min ago predates the park.
    seedLedger({ run: { id: 'run-old', startedAt: min(130), finishedAt: min(80), createdAt: min(131), input: { triggerKind: 'hook' } } });
    mockDecide.mockResolvedValue({ id: 'd1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 1, answers: { disposition: { type: 'choice', choice: 'drop_superseded', confidence: 0.99, probabilities: {} } } });
    const out = await preGateParkedFiring(row(), NOW);
    expect(out).toMatchObject({ ineligible: 'finished_before_park', decision: null, stash: null, skip: null });
    expect(out.facts).toMatchObject({ runId: 'run-old', finishedAgoMin: 80, finishedBeforePark: true });
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('fails OPEN: no finished run, a null gate answer, a ledger throw', async () => {
    seedLedger({ run: null });
    expect(await preGateParkedFiring(row(), NOW)).toMatchObject({ ineligible: 'no_finished_run', stash: null, skip: null });
    seedLedger();
    mockDecide.mockResolvedValue(null);
    expect(await preGateParkedFiring(row(), NOW)).toMatchObject({ ineligible: null, decision: null, stash: null, skip: null });
    mockPrisma.agentRun.findFirst.mockRejectedValue(new Error('db down'));
    mockMode.mockReturnValue('act');
    expect(await preGateParkedFiring(row(), NOW)).toMatchObject({ ineligible: 'error', stash: null, skip: null });
  });
});
