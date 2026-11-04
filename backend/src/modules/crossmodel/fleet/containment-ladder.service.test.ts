/**
 * S7 — containment ladder (remediation P8): pure threshold math + the
 * TELEMETRY-ONLY sweep against mocked Prisma/Redis boundaries.
 *
 * Gate flip 2026-09-11 (owner: full steam): the action path — claims_required
 * scheduler notice, ONCE-per-7d cadence halving, model-swap owner card,
 * CONTAINMENT_LADDER_ACTIONS opt-in — was REMOVED (not gated). These pins
 * guarantee that a lane at the TOP tier writes exactly one containment_ladder
 * transition row and touches NOTHING else: no schedule update, no owner card,
 * no Redis notice key, regardless of any env var. (`readContainmentNotice`
 * and its run-executor consumer were deleted outright.)
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { CONTAINMENT_LADDER: 'containment_ladder' },
}));

const mockFlagOwnerQuestion: jest.Mock = jest.fn(async () => ({ kind: 'created', question: { id: 'oq_1' } }));
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  flagOwnerQuestion: (...a: any[]) => mockFlagOwnerQuestion(...a),
}));

const mockPrisma: any = {
  loopMetric: { findMany: jest.fn(async () => []), aggregate: jest.fn(async () => ({ _sum: { value: 0 } })) },
  agentRun: { findMany: jest.fn(async () => []) },
  codingSchedule: { findFirst: jest.fn(async () => null), update: jest.fn(async () => ({})) },
  crossModelChat: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedisGet: jest.Mock = jest.fn(async () => null);
const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: (...a: any[]) => mockRedisSet(...a),
    del: (...a: any[]) => mockRedisDel(...a),
  },
}));

import * as ladder from './containment-ladder.service';
import {
  ladderStateForLane,
  strikeWeight,
  strikesMajorityMachineSeams,
  sweepContainmentLadder,
  MACHINE_RUN_SEAMS,
  ANNOTATION_ONLY_SEAMS,
  LADDER_STATE_KEY,
  LaneStrike,
} from './containment-ladder.service';

const NOW = new Date('2026-09-09T12:00:00Z');
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000);
const strikesOf = (n: number, seam = 'reject_back', minAgo = 5): LaneStrike[] =>
  Array.from({ length: n }, () => ({ seam, createdAt: at(minAgo) }));

const ENV_KEYS = ['CONTAINMENT_LADDER_DISABLED', 'CONTAINMENT_LADDER_ACTIONS'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockResolvedValue(1);
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
  mockPrisma.loopMetric.aggregate.mockResolvedValue({ _sum: { value: 0 } });
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
  mockPrisma.codingSchedule.findFirst.mockResolvedValue(null);
  mockPrisma.codingSchedule.update.mockResolvedValue({});
  mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
  mockFlagOwnerQuestion.mockResolvedValue({ kind: 'created', question: { id: 'oq_1' } });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('S7 ladderStateForLane (pure)', () => {
  it('below every threshold → normal (4 strikes / 10 runs)', () => {
    expect(ladderStateForLane(strikesOf(4), 10)).toBe('normal');
  });

  it('≥5 strikes in the last 10 runs → claims_required', () => {
    expect(ladderStateForLane(strikesOf(5), 10)).toBe('claims_required');
  });

  it('≥10 strikes in the last 20 runs → cadence_halved', () => {
    expect(ladderStateForLane(strikesOf(10), 20)).toBe('cadence_halved');
  });

  it('≥15 strikes in the last 30 runs → model_swap_proposed (highest tier wins)', () => {
    expect(ladderStateForLane(strikesOf(15), 30)).toBe('model_swap_proposed');
  });

  it('RECOVERY DECAY (2026-09-09): a cooling lane (9 old + only 4 recent, under the claims threshold) returns to NORMAL — a resolved storm cannot hold a tier', () => {
    const boundaries = { window10: at(30), window20: at(600) };
    const strikes = [...strikesOf(9, 'reject_back', 120), ...strikesOf(4, 'reject_back', 5)];
    expect(ladderStateForLane(strikes, 20, boundaries)).toBe('normal');
    // The same recent 4 on their own stay normal too.
    expect(ladderStateForLane(strikesOf(4, 'reject_back', 5), 20, boundaries)).toBe('normal');
  });

  it('a STILL-HOT lane keeps its full tier: 9 old + 5 recent (≥ claims threshold) = cadence_halved from the 20-run window', () => {
    const boundaries = { window10: at(30), window20: at(600) };
    const strikes = [...strikesOf(9, 'reject_back', 120), ...strikesOf(5, 'reject_back', 5)];
    expect(ladderStateForLane(strikes, 20, boundaries)).toBe('cadence_halved');
  });

  it('the stale-window incident shape: 74 old derails + 4 recent = NORMAL (was: model_swap_proposed for 16+ clean hours)', () => {
    const boundaries = { window10: at(30), window20: at(600), window30: at(1200) };
    const strikes = [...strikesOf(74, 'tool_derail_break', 900), ...strikesOf(4, 'reject_back', 5)];
    expect(ladderStateForLane(strikes, 30, boundaries)).toBe('normal');
  });

  it('strikes OLDER than the last-10-runs boundary do not satisfy claims_required', () => {
    const boundaries = { window10: at(30) };
    expect(ladderStateForLane(strikesOf(5, 'reject_back', 120), 20, boundaries)).toBe('normal');
  });

  it('fewer runs than the window is evaluated over what exists (5 strikes / 6 runs → claims_required)', () => {
    expect(ladderStateForLane(strikesOf(5), 6)).toBe('claims_required');
  });

  it('annotation-only seams count HALF: 15 numeric_provenance strikes / 30 runs = weight 7.5 → claims_required, NOT model_swap (2026-09-09 Hardening Bench calibration)', () => {
    expect(ladderStateForLane(strikesOf(15, 'numeric_provenance'), 30)).toBe('claims_required');
  });

  it('GATE FLIP 2026-09-11: zero_tool_prefinal is annotation-only too — 15 of them / 30 runs = weight 7.5 → claims_required, never a higher tier on its own', () => {
    expect(ANNOTATION_ONLY_SEAMS.has('zero_tool_prefinal')).toBe(true);
    expect(MACHINE_RUN_SEAMS.has('zero_tool_prefinal')).toBe(false);
    expect(ladderStateForLane(strikesOf(15, 'zero_tool_prefinal'), 30)).toBe('claims_required');
    // The supervisor shape (fires on essentially every wake): 30 observations / 30 runs → weight 15 hits the top tier
    // label, but the label is telemetry only — see the sweep pins below.
  });

  it('mixed shape (the real card): 10 enforcement + 5 numeric_provenance = weight 12.5 → cadence_halved, not model_swap', () => {
    const mixed = [...strikesOf(10, 'reject_back'), ...strikesOf(5, 'numeric_provenance')];
    expect(ladderStateForLane(mixed, 30)).toBe('cadence_halved');
  });

  it('strikeWeight: 0.5 for annotation-only seams, 1 for everything else (incl. seam-less)', () => {
    expect(strikeWeight('numeric_provenance')).toBe(0.5);
    expect(strikeWeight('zero_tool_prefinal')).toBe(0.5);
    expect(strikeWeight('reject_back')).toBe(1);
    expect(strikeWeight('')).toBe(1);
  });

  it('zero runs or zero strikes → normal', () => {
    expect(ladderStateForLane(strikesOf(20), 0)).toBe('normal');
    expect(ladderStateForLane([], 30)).toBe('normal');
  });
});

describe('S7 strikesMajorityMachineSeams (pure — telemetry attribution only since 2026-09-11)', () => {
  it('a strict majority of machine-run seams reads as machine-attributed', () => {
    expect(strikesMajorityMachineSeams([
      ...strikesOf(3, 'reject_back'),
      ...strikesOf(2, 'machine_wake_reject_back'), // chat-side — not a machine-run seam
    ])).toBe(true);
  });

  it('a tie or minority (incl. seam-less finalize strikes) reads as not machine-attributed; zero_tool_prefinal no longer counts as machine-run', () => {
    expect(strikesMajorityMachineSeams([
      ...strikesOf(2, 'reject_back'),
      ...strikesOf(2, ''),
    ])).toBe(false);
    expect(strikesMajorityMachineSeams(strikesOf(5, 'zero_tool_prefinal'))).toBe(false);
    expect(strikesMajorityMachineSeams([])).toBe(false);
  });
});

// ── Sweep scaffolding ─────────────────────────────────────────────────────────

/** One lane with `strikes` recent strike rows over `runs` runs. */
function primeLane(opts: { lane?: string; strikeCount: number; seam?: string; runCount: number }) {
  const lane = opts.lane ?? 'lane-1';
  const runs = Array.from({ length: opts.runCount }, (_, i) => ({ id: `run-${i}`, createdAt: at(10 + i) }));
  const strikeRows = Array.from({ length: opts.strikeCount }, () => ({
    meta: { seam: opts.seam ?? 'reject_back' }, createdAt: at(5),
  }));
  // Call 1: the 24h lane discovery; call 2 (per lane): the strike window read.
  mockPrisma.loopMetric.findMany
    .mockResolvedValueOnce([{ sessionId: lane }])
    .mockResolvedValueOnce(strikeRows);
  mockPrisma.agentRun.findMany.mockResolvedValue(runs);
  return lane;
}

/** Every side effect the removed action path used to produce. */
function expectNoActions() {
  const noticeWrites = mockRedisSet.mock.calls.filter((c: any[]) => String(c[0]).includes('containment:notice'));
  const cadenceWrites = mockRedisSet.mock.calls.filter((c: any[]) => String(c[0]).includes('containment:cadence'));
  const cardWrites = mockRedisSet.mock.calls.filter((c: any[]) => String(c[0]).includes('containment:swapcard'));
  expect(noticeWrites).toHaveLength(0);
  expect(cadenceWrites).toHaveLength(0);
  expect(cardWrites).toHaveLength(0);
  expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
  expect(mockPrisma.codingSchedule.findFirst).not.toHaveBeenCalled();
  expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
}

describe('S7 sweepContainmentLadder — TELEMETRY ONLY (gate flip 2026-09-11, owner: full steam)', () => {
  it('claims_required: emits the transition metric (outcome observed, machineMajority stamped) and persists the state — nothing else', async () => {
    const lane = primeLane({ strikeCount: 5, runCount: 10 });
    expect(await sweepContainmentLadder({ now: NOW })).toBe(1);

    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'containment_ladder',
      sessionId: lane,
      meta: expect.objectContaining({ lane, state: 'claims_required', prev: 'normal', strikes: 5, runs: 10, machineMajority: true, outcome: 'observed' }),
    }));
    const stateWrite = mockRedisSet.mock.calls.find((c) => c[0] === LADDER_STATE_KEY(lane));
    expect(stateWrite).toBeDefined();
    expect(stateWrite![1]).toBe('claims_required');
    expectNoActions();
  });

  it('cadence_halved tier: NO schedule mutation — the interval is never touched (12 halvings on 9 lanes was the harm)', async () => {
    primeLane({ strikeCount: 10, runCount: 20 });
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: 'sched-1', intervalSec: 1800, promptSetBy: 'machine' });
    expect(await sweepContainmentLadder({ now: NOW })).toBe(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ state: 'cadence_halved', outcome: 'observed' }),
    }));
    expectNoActions();
  });

  it('model_swap_proposed tier: NO owner card — the tier is a label on a metric row, not a decision for the owner', async () => {
    primeLane({ strikeCount: 15, runCount: 30 });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', title: 'Nightly monitor' });
    expect(await sweepContainmentLadder({ now: NOW })).toBe(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ state: 'model_swap_proposed', outcome: 'observed' }),
    }));
    expectNoActions();
  });

  it('the removed CONTAINMENT_LADDER_ACTIONS opt-in re-arms NOTHING — same top-tier lane, env set, still no action', async () => {
    process.env.CONTAINMENT_LADDER_ACTIONS = '1';
    primeLane({ strikeCount: 15, runCount: 30 });
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: 'sched-1', intervalSec: 1800, promptSetBy: 'machine' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'u1', title: 't' });
    expect(await sweepContainmentLadder({ now: NOW })).toBe(1);
    expectNoActions();
    // And the action helpers are gone from the module surface entirely.
    expect((ladder as any).readLadderState).toBeUndefined();
    expect((ladder as any).ladderActionsEnabled).toBeUndefined();
    expect((ladder as any).CLAIMS_REQUIRED_NOTICE).toBeUndefined();
    expect((ladder as any).SWAP_ALTERNATIVES).toBeUndefined();
  });

  it('the retired CONTAINMENT_LADDER_DISABLED kill-switch no longer short-circuits telemetry (there is nothing left to switch off)', async () => {
    process.env.CONTAINMENT_LADDER_DISABLED = '1';
    primeLane({ strikeCount: 5, runCount: 10 });
    expect(await sweepContainmentLadder({ now: NOW })).toBe(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
  });

  it('NON-machine-majority strikes are telemetered the same way, stamped machineMajority:false', async () => {
    primeLane({ strikeCount: 10, seam: 'machine_wake_reject_back', runCount: 20 });
    expect(await sweepContainmentLadder({ now: NOW })).toBe(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ state: 'cadence_halved', machineMajority: false }),
    }));
    expectNoActions();
  });

  it('no state change → no transition metric (Redis remembers the prior state)', async () => {
    primeLane({ strikeCount: 5, runCount: 10 });
    mockRedisGet.mockResolvedValue('claims_required');
    expect(await sweepContainmentLadder({ now: NOW })).toBe(1);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('recovery to normal emits a transition metric too', async () => {
    primeLane({ strikeCount: 1, runCount: 10 });
    mockRedisGet.mockResolvedValue('claims_required');
    expect(await sweepContainmentLadder({ now: NOW })).toBe(0);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ state: 'normal', prev: 'claims_required' }),
    }));
    expectNoActions();
  });

  it('a lane with no runs is skipped (nothing to evaluate)', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValueOnce([{ sessionId: 'lane-x' }]);
    mockPrisma.agentRun.findMany.mockResolvedValue([]);
    expect(await sweepContainmentLadder({ now: NOW })).toBe(0);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('never throws into the caller — a DB failure returns 0', async () => {
    mockPrisma.loopMetric.findMany.mockRejectedValue(new Error('db down'));
    await expect(sweepContainmentLadder({ now: NOW })).resolves.toBe(0);
  });
});
