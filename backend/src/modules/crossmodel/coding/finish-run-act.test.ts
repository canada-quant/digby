/**
 * build 2026-10-11 FA-4 — the FINISH_RUN_ACT=seats decision: one aggregate loop_metrics read per process per
 * hour, a seat acts only at ≥ FINISH_RUN_ACT_SEAT_BAR over ≥ FINISH_RUN_ACT_SEAT_MIN_RUNS rows, and every
 * failure is SHADOW (fail-safe). off / on never touch the DB.
 */

const mockQueryRaw: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { $queryRaw: (...a: any[]) => mockQueryRaw(...a) } }));

import { resolveFinishRunAct, finishRunSeatStats, resetFinishRunActCache, FINISH_RUN_ACT_STATS_TTL_MS } from './finish-run-act';

const ROWS = [
  { seat: 'cql-litellm:api-optimize-zai-glm-5.3', runs: BigInt(120), valid: BigInt(116) },
  { seat: 'cql-litellm:api-optimize-moonshot-kimi-k3', runs: BigInt(250), valid: BigInt(180) },
  { seat: 'glm-5.3', runs: 9, valid: 9 },
  { seat: null, runs: 3, valid: 0 },
];

beforeEach(() => { resetFinishRunActCache(); mockQueryRaw.mockReset(); });

describe('resolveFinishRunAct', () => {
  it('on / unset / off never read the DB', async () => {
    expect(await resolveFinishRunAct('glm-5.3', {})).toMatchObject({ mode: 'on', act: true });
    expect(await resolveFinishRunAct('glm-5.3', { FINISH_RUN_ACT: 'on' })).toMatchObject({ mode: 'on', act: true });
    expect(await resolveFinishRunAct('glm-5.3', { FINISH_RUN_ACT: 'off' })).toMatchObject({ mode: 'off', act: false });
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('seats: a seat over the bar acts, one below / with a small sample / unmeasured stays shadow — one cached read', async () => {
    mockQueryRaw.mockResolvedValue(ROWS);
    const env = { FINISH_RUN_ACT: 'seats' };
    expect(await resolveFinishRunAct('cql-litellm:api-optimize-zai-glm-5.3', env)).toMatchObject({ act: true, reason: 'seat_meets_bar', seatRate: 0.967, seatRuns: 120 });
    expect(await resolveFinishRunAct('cql-litellm:api-optimize-moonshot-kimi-k3', env)).toMatchObject({ act: false, reason: 'seat_below_bar', seatRate: 0.72 });
    expect(await resolveFinishRunAct('glm-5.3', env)).toMatchObject({ act: false, reason: 'seat_sample_small' });
    expect(await resolveFinishRunAct('deepseek-flash', env)).toMatchObject({ act: false, reason: 'seat_unmeasured' });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('seats: a failed read is shadow (seat_stats_unavailable) and is retried on the next run', async () => {
    mockQueryRaw.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(ROWS);
    const env = { FINISH_RUN_ACT: 'seats' };
    expect(await resolveFinishRunAct('cql-litellm:api-optimize-zai-glm-5.3', env)).toMatchObject({ act: false, reason: 'seat_stats_unavailable' });
    expect(await resolveFinishRunAct('cql-litellm:api-optimize-zai-glm-5.3', env)).toMatchObject({ act: true });
  });

  it('the stats are cached for ≤ 1 h, then re-read', async () => {
    mockQueryRaw.mockResolvedValue(ROWS);
    const t0 = 1_000_000;
    await finishRunSeatStats(t0);
    await finishRunSeatStats(t0 + FINISH_RUN_ACT_STATS_TTL_MS - 1);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    await finishRunSeatStats(t0 + FINISH_RUN_ACT_STATS_TTL_MS);
    expect(mockQueryRaw).toHaveBeenCalledTimes(2);
  });
});
