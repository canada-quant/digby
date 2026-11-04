import { DEFAULT_PRICE, PRICES, UsageAccumulator, estimateTurnUsage, turnCostUsd } from './cost';

describe('cost accounting', () => {
  it('estimateTurnUsage converts chars at ~4/token and flags the estimate', () => {
    const u = estimateTurnUsage(4000, 800);
    expect(u.promptTokens).toBe(1000);
    expect(u.completionTokens).toBe(200);
    expect(u.estimated).toBe(true);
  });

  it('turnCostUsd prices known models and falls back for unknown ones', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, estimated: false };
    expect(turnCostUsd('glm-5.2', usage)).toBeCloseTo(1.4 + 4.4, 5); // Z.ai list (build 2026-10-08 Q-1)
    expect(turnCostUsd('never-heard-of-it', usage)).toBeGreaterThan(0);
  });

  it('accumulates per-agent rows and totals across turns', () => {
    const acc = new UsageAccumulator();
    acc.record('Digby', 'glm-5.2', { promptTokens: 1000, completionTokens: 500, estimated: false });
    acc.record('Digby', 'glm-5.2', { promptTokens: 2000, completionTokens: 700, estimated: false });
    acc.record('Fix tests', 'deepseek-v4-flash', { promptTokens: 400, completionTokens: 100, estimated: true }, 'coder');

    const s = acc.snapshot();
    expect(s.totalInTokens).toBe(3400);
    expect(s.totalOutTokens).toBe(1300);
    expect(s.turns).toBe(3);
    expect(s.estimated).toBe(true); // one estimated row taints the total flag
    expect(s.agents).toHaveLength(2);

    const digby = s.agents.find(a => a.agent === 'Digby')!;
    expect(digby.inTokens).toBe(3000);
    expect(digby.turns).toBe(2);
    expect(digby.estimated).toBe(false);

    const worker = s.agents.find(a => a.agent === 'Fix tests')!;
    expect(worker.role).toBe('coder');
    expect(worker.estimated).toBe(true);
    expect(s.totalCostUsd).toBeCloseTo(digby.costUsd + worker.costUsd, 10);
  });

  it('rows sort by cost, most expensive first', () => {
    const acc = new UsageAccumulator();
    acc.record('cheap', 'deepseek-v4-flash', { promptTokens: 10, completionTokens: 10, estimated: false });
    acc.record('pricey', 'kimi-k3', { promptTokens: 100_000, completionTokens: 100_000, estimated: false });
    expect(acc.snapshot().agents[0].agent).toBe('pricey');
  });
});

describe('cachedTokens accumulation (audit #8 rider — cache visibility in cost records)', () => {
  it('sums cachedTokens per agent row and into totalCachedTokens', () => {
    const acc = new UsageAccumulator();
    acc.record('Digby', 'kimi-k3', { promptTokens: 1000, completionTokens: 100, cachedTokens: 800, estimated: false });
    acc.record('Digby', 'kimi-k3', { promptTokens: 2000, completionTokens: 200, cachedTokens: 1500, estimated: false });
    acc.record('Worker', 'glm-5.2', { promptTokens: 500, completionTokens: 50, estimated: false }); // no cache reported

    const s = acc.snapshot();
    const digby = s.agents.find(a => a.agent === 'Digby')!;
    expect(digby.cachedTokens).toBe(2300);
    expect(digby.inTokens).toBe(3000); // cached is a SUBSET marker, never subtracted
    const worker = s.agents.find(a => a.agent === 'Worker')!;
    expect(worker.cachedTokens).toBeUndefined(); // absent when never reported
    expect(s.totalCachedTokens).toBe(2300);
  });

  it('no cache reported anywhere → totalCachedTokens 0 and rows stay lean', () => {
    const acc = new UsageAccumulator();
    acc.record('Digby', 'glm-5.2', { promptTokens: 10, completionTokens: 10, estimated: false });
    const s = acc.snapshot();
    expect(s.totalCachedTokens).toBe(0);
    expect(s.agents[0].cachedTokens).toBeUndefined();
  });

  it('a zero cachedTokens turn is treated like absent (no spurious 0-cache rows)', () => {
    const acc = new UsageAccumulator();
    acc.record('Digby', 'kimi-k3', { promptTokens: 10, completionTokens: 10, cachedTokens: 0, estimated: false });
    expect(acc.snapshot().agents[0].cachedTokens).toBeUndefined();
  });
});

describe('peakPromptTokens accumulation (E5 context_window_used — the surfaced fill primitive)', () => {
  it('keeps the LARGEST single-turn prompt_tokens per row, not the sum', () => {
    const acc = new UsageAccumulator();
    // A coding loop re-sends the whole transcript every step: turn 1 is small,
    // turn 5 carries the grown transcript — the PEAK is the fill signal.
    acc.record('Digby', 'glm-5.3', { promptTokens: 20_000, completionTokens: 500, estimated: false });
    acc.record('Digby', 'glm-5.3', { promptTokens: 90_000, completionTokens: 800, estimated: false });
    acc.record('Digby', 'glm-5.3', { promptTokens: 60_000, completionTokens: 400, estimated: false }); // post-compaction dip
    const s = acc.snapshot();
    const row = s.agents.find(a => a.agent === 'Digby')!;
    expect(row.peakPromptTokens).toBe(90_000);
    expect(row.inTokens).toBe(170_000); // the SUM still accumulates unchanged
  });

  it('an ESTIMATED turn never mints a peak (chars/4 is not a window measurement)', () => {
    const acc = new UsageAccumulator();
    acc.record('Digby', 'glm-5.3', { promptTokens: 30_000, completionTokens: 10, estimated: true });
    expect(acc.snapshot().agents[0].peakPromptTokens).toBeUndefined();
    // ...even after a real (smaller) provider-reported turn landed first
    acc.record('Digby', 'glm-5.3', { promptTokens: 5_000, completionTokens: 10, estimated: false });
    expect(acc.snapshot().agents[0].peakPromptTokens).toBe(5_000); // the real 5k stands; the estimated 30k did not overwrite it
  });

  it('rows are independent — two workers on the same model each keep their own peak', () => {
    const acc = new UsageAccumulator();
    acc.record('Digby', 'deepseek-flash', { promptTokens: 80_000, completionTokens: 100, estimated: false });
    acc.record('Worker', 'deepseek-flash', { promptTokens: 10_000, completionTokens: 100, estimated: false });
    const s = acc.snapshot();
    expect(s.agents.find(a => a.agent === 'Digby')!.peakPromptTokens).toBe(80_000);
    expect(s.agents.find(a => a.agent === 'Worker')!.peakPromptTokens).toBe(10_000);
  });
});

describe('v1#17 — price table reconcile + cached-input rate (remediation P0)', () => {
  it('PINS the whole price table (a silent price edit must move this snapshot with it)', () => {
    // build 2026-10-08 Q-1: every row re-read on the vendor's own pricing page (cost.ts header).
    expect(PRICES).toEqual({
      'glm-5.3': { in: 1.4, out: 4.4, cachedIn: 0.26 }, // docs.z.ai (was 0.6 / 2.2, no cached rate)
      'glm-5.2': { in: 1.4, out: 4.4, cachedIn: 0.26 },
      'glm-5.3-flash': { in: 0.15, out: 0.5, cachedIn: 0.03 },
      'deepseek-v4-pro': { in: 0.66, out: 1.98, cachedIn: 0.022 }, // api-docs.deepseek.com off-peak
      'deepseek-v4-flash': { in: 0.15, out: 0.6, cachedIn: 0.003 },
      'deepseek-flash': { in: 0.15, out: 0.6, cachedIn: 0.003 }, // V4.1 Flash, off-peak list rate
      // kimi-k3: VENDOR-SOURCED (moonshot-cache.ts, kimi pricing page verified
      // 2026-09-02, re-read 2026-10-08): $3.00/M miss, $0.30/M cache hit, $15.00/M out.
      'kimi-k3': { in: 3.0, out: 15.0, cachedIn: 0.3 },
      'kimi-k2.6': { in: 0.6, out: 2.5 },
      'qwen3.6-27b': { in: 0.6, out: 3.6 }, // Alibaba Model Studio (Singapore, ≤256K), no cache discount
      'qwen3.6-flash': { in: 0.25, out: 1.5, cachedIn: 0.025 },
    });
    expect(DEFAULT_PRICE).toEqual({ in: 0.6, out: 2.4 });
  });

  it('kimi-k3 prices at the moonshot-cache vendor numbers (was 1.20/5.00)', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, estimated: false };
    expect(turnCostUsd('kimi-k3', usage)).toBeCloseTo(3.0 + 15.0, 5);
  });

  it('cached prompt tokens bill at the CACHED rate, not full input (was full price)', () => {
    // 1M prompt, 800k of it cache-served: 200k @ $3/M + 800k @ $0.30/M + out.
    const usage = { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 800_000, estimated: false };
    expect(turnCostUsd('kimi-k3', usage)).toBeCloseTo(0.2 * 3.0 + 0.8 * 0.3, 6);
  });

  it('models WITHOUT a documented cached rate bill cached tokens at the full input rate (unchanged)', () => {
    const plain = { promptTokens: 1_000_000, completionTokens: 0, estimated: false };
    const cached = { ...plain, cachedTokens: 900_000 };
    expect(turnCostUsd('qwen3.6-27b', cached)).toBeCloseTo(turnCostUsd('qwen3.6-27b', plain), 10);
  });

  it('cachedTokens is clamped to [0, promptTokens] — a corrupt over-count can never go negative', () => {
    const over = { promptTokens: 100, completionTokens: 0, cachedTokens: 100_000, estimated: false };
    expect(turnCostUsd('kimi-k3', over)).toBeCloseTo((100 * 0.3) / 1_000_000, 12);
    const negative = { promptTokens: 100, completionTokens: 0, cachedTokens: -5, estimated: false };
    expect(turnCostUsd('kimi-k3', negative)).toBeCloseTo((100 * 3.0) / 1_000_000, 12);
  });
});

describe('UsageAccumulator runId (Phase 1 resume)', () => {
  it('generates a unique runId by default', () => {
    const a = new UsageAccumulator();
    const b = new UsageAccumulator();
    expect(a.runId).toBeTruthy();
    expect(a.runId).not.toBe(b.runId);
  });

  it('a resumed run reuses its checkpoint runId (commitRunUsage stays idempotent)', () => {
    const acc = new UsageAccumulator('rFIXED123');
    expect(acc.runId).toBe('rFIXED123');
    expect(acc.snapshot().runId).toBe('rFIXED123');
  });
});

describe('shared turn ledger (WI-D — one accumulator across a chat turn\'s loops)', () => {
  it('plain accumulators ignore retain/release/close (pre-WI-D behaviour is byte-identical)', () => {
    const acc = new UsageAccumulator();
    expect(acc.shared).toBe(false);
    acc.retain(); acc.release(); acc.close();
    expect(acc.holdCount).toBe(0);
  });

  it('settles exactly once, when the LAST hold drops — whichever side (caller or a participant loop) is last', () => {
    const settle = jest.fn();
    const acc = new UsageAccumulator().shareAcrossRuns(settle);
    expect(acc.shared).toBe(true);
    expect(acc.holdCount).toBe(1); // the caller's own hold
    acc.retain(); // the lead loop
    acc.retain(); // the Double Checker loop
    acc.record('Digby', 'kimi-k3', { promptTokens: 1000, completionTokens: 200, estimated: false });
    acc.release(); // lead done
    acc.close();   // caller done — the checker is still running
    expect(settle).not.toHaveBeenCalled();
    acc.record('Cross-checker', 'deepseek-flash', { promptTokens: 500, completionTokens: 100, estimated: false }, 'cross_checker');
    acc.release(); // checker done → the last hold
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle.mock.calls[0][0]).toBe(acc);
    expect(acc.snapshot().agents.map(a => a.model).sort()).toEqual(['deepseek-flash', 'kimi-k3']);
    // A straggler retain/release after settle can never re-settle (no double row).
    acc.retain(); acc.release();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(acc.holdCount).toBe(0);
  });

  it('the lead retry shape: a second loop retaining AFTER the first released still lands on the same settle', () => {
    const settle = jest.fn();
    const acc = new UsageAccumulator().shareAcrossRuns(settle);
    acc.retain(); acc.record('Digby', 'kimi-k3', { promptTokens: 10, completionTokens: 0, estimated: false }); acc.release();
    acc.retain(); acc.record('Digby', 'kimi-k3', { promptTokens: 20, completionTokens: 5, estimated: false }); acc.release();
    expect(settle).not.toHaveBeenCalled(); // the caller still holds
    acc.close();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(acc.snapshot().turns).toBe(2);
  });

  it('a settle callback that throws never escapes into the run', () => {
    const acc = new UsageAccumulator().shareAcrossRuns(() => { throw new Error('boom'); });
    expect(() => acc.close()).not.toThrow();
  });
});
