/**
 * Remediation P0 item N6 — metric STAMPING: every loop_metrics row written by
 * the agent loop / run executor / chat agent should carry meta.model,
 * meta.provider (derived from the model), meta.profile and meta.triggerKind.
 * Implemented as a per-run `stamp` object threaded through recordLoopMetric /
 * recordRunSpend (built once where the run's identity is known) instead of
 * hand-composing meta at ~30 call sites.
 *
 * Also pinned here (same item's riders):
 *   - providerOfModel: the pure model-id → provider mapping;
 *   - adjudicateStrike: the jsonb-merge meta.adjudication writer for the
 *     future nightly guard-strike adjudication job.
 * (The LOOP_METRICS_P0_DISABLED kill switch was deleted in build 2026-10-08 S-2.)
 *
 * Red-green: every test in this file fails on pre-P0 code (no `stamp` support,
 * no providerOfModel/adjudicateStrike exports, no kill switch).
 *
 * Prisma + logger mocked (loop-metrics.service.test.ts pattern).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreateMany: jest.Mock = jest.fn();
const mockExecuteRaw: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    loopMetric: { createMany: (...a: any[]) => mockCreateMany(...a) },
    $executeRaw: (...a: any[]) => mockExecuteRaw(...a),
  },
}));

import {
  LOOP_METRIC_KINDS,
  adjudicateStrike,
  flushLoopMetrics,
  providerOfModel,
  recordLoopMetric,
  recordRunSpend,
  __resetLoopMetricsForTest,
} from './loop-metrics.service';

beforeEach(() => {
  jest.clearAllMocks();
  __resetLoopMetricsForTest();
  mockCreateMany.mockResolvedValue({ count: 0 });
  mockExecuteRaw.mockResolvedValue(1);
});

const flushedRows = (): any[] => mockCreateMany.mock.calls.flatMap((c: any[]) => c[0].data);

// ── providerOfModel (pure) ────────────────────────────────────────────────────

describe('providerOfModel', () => {
  it('maps every built-in model family to its provider', () => {
    expect(providerOfModel('kimi-k3')).toBe('moonshot');
    expect(providerOfModel('kimi-k2.6')).toBe('moonshot');
    expect(providerOfModel('glm-5.3')).toBe('zai');
    expect(providerOfModel('glm-5.3-flash')).toBe('zai');
    expect(providerOfModel('deepseek-flash')).toBe('deepseek');
    // Legacy ids still stamped on old runs keep mapping (prefix match).
    expect(providerOfModel('deepseek-v4-pro')).toBe('deepseek');
    expect(providerOfModel('deepseek-v4-flash')).toBe('deepseek');
    expect(providerOfModel('qwen3.6-27b')).toBe('dashscope');
    expect(providerOfModel('gpt-5.6-sol')).toBe('openai');
    expect(providerOfModel('grok-4.5')).toBe('xai');
    expect(providerOfModel('gemini-3.5-flash')).toBe('google');
    expect(providerOfModel('claude-sonnet-4-20250514')).toBe('anthropic');
  });

  it('a registry "<label>:<modelId>" spec maps to its label', () => {
    expect(providerOfModel('myollama:llama4-70b')).toBe('myollama');
  });

  it('unknown families and garbage return undefined — never a guess', () => {
    expect(providerOfModel('never-heard-of-it')).toBeUndefined();
    expect(providerOfModel('')).toBeUndefined();
    expect(providerOfModel(undefined)).toBeUndefined();
    expect(providerOfModel(null)).toBeUndefined();
  });
});

// ── stamp merge in recordLoopMetric ───────────────────────────────────────────

describe('recordLoopMetric stamp merge (N6)', () => {
  it('merges the stamp UNDER meta with provider derived from the model', async () => {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
      sessionId: 's1',
      runId: 'r1',
      stamp: { model: 'kimi-k3', profile: 'coding', triggerKind: 'schedule' },
      meta: { seam: 'reject_back' },
    });
    await flushLoopMetrics();
    const [row] = flushedRows();
    expect(row.meta).toEqual({
      model: 'kimi-k3',
      provider: 'moonshot',
      profile: 'coding',
      triggerKind: 'schedule',
      seam: 'reject_back',
    });
  });

  it('2026-10-04: stamp.agentRunId rides meta.agentRunId (run_spend joins agent_runs — its runId column is the usage id)', async () => {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.GUARD_STRIKE, sessionId: 's1', runId: 'usage-1', stamp: { model: 'glm-5.3', agentRunId: 'ar-7' } });
    await flushLoopMetrics();
    const [row] = flushedRows();
    expect(row.meta).toMatchObject({ agentRunId: 'ar-7', model: 'glm-5.3' });
  });

  it('explicit meta keys WIN over stamp fields (a per-row model overrides the run stamp)', async () => {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.GUARD_STRIKE,
      stamp: { model: 'kimi-k3', profile: 'coding' },
      meta: { model: 'glm-5.3' },
    });
    await flushLoopMetrics();
    const [row] = flushedRows();
    expect(row.meta.model).toBe('glm-5.3');
    expect(row.meta.profile).toBe('coding');
  });

  it('an explicit stamp.provider beats derivation; a stamp without meta still lands', async () => {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SELF_AUDIT_RUN,
      stamp: { model: 'kimi-k3', provider: 'custom-gw', profile: 'coding', triggerKind: 'user' },
    });
    await flushLoopMetrics();
    const [row] = flushedRows();
    expect(row.meta).toEqual({ model: 'kimi-k3', provider: 'custom-gw', profile: 'coding', triggerKind: 'user' });
  });

  it('no stamp, no meta → meta stays undefined (pre-N6 shape untouched)', async () => {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.GUARD_MISS, sessionId: 's1' });
    await flushLoopMetrics();
    const [row] = flushedRows();
    expect(row.meta).toBeUndefined();
  });
});

// ── recordRunSpend stamp threading ────────────────────────────────────────────

describe('recordRunSpend stamp threading (N6)', () => {
  it('token rows carry their OWN model + derived provider; run_spend carries the run stamp', async () => {
    recordRunSpend('r1', 's1', {
      totalInTokens: 1500, totalOutTokens: 300, totalCostUsd: 0.02, turns: 3,
      agents: [
        { model: 'kimi-k3', inTokens: 1000, outTokens: 200, costUsd: 0.015 },
        { model: 'glm-5.3', inTokens: 500, outTokens: 100, costUsd: 0.005 },
      ],
    }, { model: 'kimi-k3', profile: 'coding', triggerKind: 'hook' });
    await flushLoopMetrics();
    const rows = flushedRows();

    const kimiIn = rows.find(r => r.kind === 'run_tokens_in' && r.meta.model === 'kimi-k3');
    expect(kimiIn.meta.provider).toBe('moonshot');
    expect(kimiIn.meta.profile).toBe('coding');
    expect(kimiIn.meta.triggerKind).toBe('hook');

    const glmIn = rows.find(r => r.kind === 'run_tokens_in' && r.meta.model === 'glm-5.3');
    expect(glmIn.meta.provider).toBe('zai'); // the ROW's model wins, provider re-derived

    const spend = rows.find(r => r.kind === 'run_spend');
    expect(spend.meta).toMatchObject({
      model: 'kimi-k3', provider: 'moonshot', profile: 'coding', triggerKind: 'hook',
    });
  });

  it('stamp omitted → byte-identical pre-N6 rows (no stamp fields, token rows included)', async () => {
    recordRunSpend('r1', 's1', {
      totalInTokens: 10, totalOutTokens: 5, totalCostUsd: 0.001, turns: 1,
      agents: [{ model: 'glm-5.3', inTokens: 10, outTokens: 5, costUsd: 0.001 }],
    });
    await flushLoopMetrics();
    const spend = flushedRows().find(r => r.kind === 'run_spend');
    // audit 2026-10-08 W3-2: the run's prompt-cache fields ride every run_spend row (data, not stamp fields).
    expect(spend.meta).toEqual({ models: ['glm-5.3'], turns: 1, estimated: false, inTokens: 10, cachedTokens: 0, cacheHitRatio: 0 });
    const tokensIn = flushedRows().find(r => r.kind === 'run_tokens_in');
    expect(tokensIn.meta).toEqual({ model: 'glm-5.3', estimated: false }); // no derived provider without a stamp
  });

  it('stamp omitted + PROMPT_CACHE_METRICS_DISABLED=1 → byte-identical pre-N6 rows', async () => {
    process.env.PROMPT_CACHE_METRICS_DISABLED = '1';
    try {
      recordRunSpend('r1', 's1', {
        totalInTokens: 10, totalOutTokens: 5, totalCostUsd: 0.001, turns: 1,
        agents: [{ model: 'glm-5.3', inTokens: 10, outTokens: 5, costUsd: 0.001 }],
      });
      await flushLoopMetrics();
      expect(flushedRows().find(r => r.kind === 'run_spend').meta).toEqual({ models: ['glm-5.3'], turns: 1, estimated: false });
    } finally {
      delete process.env.PROMPT_CACHE_METRICS_DISABLED;
    }
  });
});

// ── adjudicateStrike ──────────────────────────────────────────────────────────

describe('adjudicateStrike (nightly-adjudication seam)', () => {
  it('jsonb-merges meta.adjudication onto the row and reports the hit', async () => {
    mockExecuteRaw.mockResolvedValue(1);
    await expect(adjudicateStrike('row-1', 'false_positive')).resolves.toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // Template-literal call: the SQL strings ride arg 0, the values follow.
    const sql = (mockExecuteRaw.mock.calls[0][0] as readonly string[]).join('?');
    expect(sql).toContain(`COALESCE("meta", '{}'::jsonb)`);
    expect(sql).toContain('jsonb_build_object');
    expect(mockExecuteRaw.mock.calls[0]).toContain('false_positive');
    expect(mockExecuteRaw.mock.calls[0]).toContain('row-1');
  });

  it('a missing row reports false; empty id/verdict never touch the DB', async () => {
    mockExecuteRaw.mockResolvedValue(0);
    await expect(adjudicateStrike('gone', 'true_positive')).resolves.toBe(false);
    mockExecuteRaw.mockClear();
    await expect(adjudicateStrike('', 'x')).resolves.toBe(false);
    await expect(adjudicateStrike('row-1', '  ')).resolves.toBe(false);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });
});

