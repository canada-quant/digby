/**
 * sweep-triage.ts — backlog E12 (2026-09-28): the ACT CONTROL SAMPLE.
 *
 * A sweep the gate skips in act yields no turn and therefore no label, so the
 * act band held ~4 rows in prod while the purpose ran at 50 % act-period
 * agreement — auto-demote could never fire. Pins:
 *   - one confident-quiet act skip in N (default 10; env
 *     DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE) FIRES anyway, no acted row, the
 *     stash stamped extra.control:true (controlReason 'sample');
 *   - the heartbeat-floor fire is stamped the same way ('heartbeat');
 *   - a missed draw is the byte-identical skip path; shadow stashes carry no
 *     control; SWEEP_TRIAGE_CONTROL_SAMPLE_DISABLED=1 never fires a control;
 *   - labels-off + a control fire ⇒ the decision-time row carries the control.
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
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  stashDecision: (d: any, purpose: string, opts?: any) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'now', ...(opts?.extra ? { extra: opts.extra } : {}) } : null),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));
jest.mock('./supervisor.service', () => ({ __esModule: true, classifySupervisorNote: () => 'supervisor_noop' }));
jest.mock('../fleet/project-status.service', () => ({ __esModule: true, getLatestProjectStatus: jest.fn(async () => null) }));

import {
  preTriageSweepFiring, setSweepControlSampler, drawSweepControl, sweepControlSampleRate, SWEEP_TRIAGE_CONTROL_SAMPLE_DEFAULT_N,
} from './sweep-triage';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const PROJECT_PROMPT = 'Project Supervisor sweep for "CanLaw" (projectId p1) — a GOAL LEDGER diff.';
const ENV = ['DECISION_GATE_SWEEP_HEARTBEAT_TICKS', 'DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE', 'SWEEP_TRIAGE_CONTROL_SAMPLE_DISABLED'];
const saved: Record<string, string | undefined> = {};

const seedLedger = () => {
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ id: 'sup', userId: 'u1', projectId: 'p1', isSupervisor: false, isProjectSupervisor: true });
  mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'lane-a' }]);
  mockPrisma.agentRun.findMany.mockResolvedValue([{ status: 'completed', sessionId: 'lane-a', startedAt: min(40) }]);
  mockPrisma.eventHook.findMany.mockResolvedValue([{ id: 'hook-1' }]);
  mockPrisma.hookEvent.findMany.mockResolvedValue([]);
  mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.count.mockResolvedValue(0);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ content: 'SWEEP: no-op — nothing moved.', createdAt: min(61) });
};
const row = (over: Record<string, any> = {}) => ({ id: 'sch', sessionId: 'sup', prompt: PROJECT_PROMPT, lastFiredAt: min(60), intervalSec: 3600, lastStatus: 'started', ...over });
const quietAct = (mode: 'act' | 'shadow' = 'act') => ({ id: 'd-ctl', mode, backend: 'TypeSafe Jev', ms: 1, answers: { needs_turn_now: { type: 'noul', noul: 0.05 } } });

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  mockMode.mockReturnValue('off');
  mockDecide.mockResolvedValue(null);
  seedLedger();
});
afterEach(() => {
  setSweepControlSampler(null);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('E12 control sample — rate + draw (pure)', () => {
  it('default 1/10; env DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE (clamped 0..1, garbage ⇒ default); kill switch ⇒ 0; drawSweepControl draws by the sampler', () => {
    expect(sweepControlSampleRate()).toBeCloseTo(1 / SWEEP_TRIAGE_CONTROL_SAMPLE_DEFAULT_N, 9);
    process.env.DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE = '0.5';
    expect(sweepControlSampleRate()).toBe(0.5);
    setSweepControlSampler(() => 0.7);
    expect(drawSweepControl()).toBe(false);
    setSweepControlSampler(() => 0.2);
    expect(drawSweepControl()).toBe(true);
    process.env.DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE = '7';
    expect(sweepControlSampleRate()).toBe(1);
    expect(drawSweepControl()).toBe(true);
    process.env.DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE = 'garbage';
    expect(sweepControlSampleRate()).toBeCloseTo(0.1, 9);
    process.env.DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE = '0';
    expect(drawSweepControl()).toBe(false);
    delete process.env.DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE;
    process.env.SWEEP_TRIAGE_CONTROL_SAMPLE_DISABLED = '1';
    expect(sweepControlSampleRate()).toBe(0);
    expect(drawSweepControl()).toBe(false);
  });
});

describe('preTriageSweepFiring — E12 control sample', () => {
  it('ACT + quiet + the draw hits ⇒ the sweep FIRES (no skip, no acted row) and the stash carries extra.control:true (controlReason sample)', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(quietAct());
    setSweepControlSampler(() => 0.0);
    const r = await preTriageSweepFiring(row(), NOW);
    expect(r.skip).toBeNull();
    expect(r.stash).toMatchObject({ id: 'd-ctl', purpose: 'sweep_triage', extra: { control: true, controlReason: 'sample' } });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('ACT + quiet + the draw misses ⇒ the skip path is byte-identical (acted:true row, consecutive ledger); the kill switch never fires a control', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(quietAct());
    setSweepControlSampler(() => 0.99);
    const r = await preTriageSweepFiring(row(), NOW);
    expect(r.skip).toEqual({ needsTurn: 0.05, consecutive: 1, sweep: 'project' });
    expect(r.stash).toBeNull();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ acted: true, actual: null });
    expect(mockRecord.mock.calls[0][2]).not.toHaveProperty('extra');
    jest.clearAllMocks(); seedLedger(); mockMode.mockReturnValue('act'); mockDecide.mockResolvedValue(quietAct());
    process.env.SWEEP_TRIAGE_CONTROL_SAMPLE_DISABLED = '1';
    setSweepControlSampler(() => 0.0);
    const r2 = await preTriageSweepFiring(row(), NOW);
    expect(r2.skip).toMatchObject({ consecutive: 1 });
  });

  it('the heartbeat-floor fire is stamped control:true (controlReason heartbeat); shadow stashes carry no control', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(quietAct());
    setSweepControlSampler(() => 0.99);
    const r = await preTriageSweepFiring(row({ lastStatus: 'skipped:sweep_quiet:2' }), NOW);
    expect(r.skip).toBeNull();
    expect(r.stash).toMatchObject({ extra: { control: true, controlReason: 'heartbeat' } });
    jest.clearAllMocks(); seedLedger(); mockMode.mockReturnValue('shadow'); mockDecide.mockResolvedValue(quietAct('shadow'));
    setSweepControlSampler(() => 0.0);
    const s = await preTriageSweepFiring(row(), NOW);
    expect(s.skip).toBeNull();
    expect(s.stash).not.toHaveProperty('extra');
  });
});
