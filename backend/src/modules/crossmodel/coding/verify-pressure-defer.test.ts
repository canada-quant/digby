/**
 * Framework Operator run 3 (2026-09-22) — PRE-FLIGHT cgroup pressure deferral
 * for the verify chain (the e4edffa3 isolation class, proactive leg).
 *
 * The 2026-09-21/22 incident window: three concurrent coding lanes' verify
 * stages share ONE dev-container memory cgroup (12.87/12.88 GB, 99.95%,
 * oom_kill 236→249 in ~25 min); the same suites passed 3/3 and 67/67 in 2.0 s
 * in isolation. Every existing defense is REACTIVE — the chain discovers peer
 * pressure by dying: 2× doomed legs (up to 10 min each with the in-chain
 * environmental retry), exit-137 false reds, lanes burning runs on retries.
 * This suite pins the PRE-FLIGHT leg: the reap round-trip now also prints the
 * cgroup v2 memory.current/memory.max, and a saturated cgroup DEFERS the chain
 * (hollow pass, v1#30 semantics) instead of running it into the OOM wall.
 *
 * Pins:
 *   1. parseCgroupPressure — marker/markerless/units/sentinels/garbage;
 *   2. ≥92% defers: passed:true + ran:false + unverified:true + ONE deferred
 *      stage whose tail names the pressure, tells the lane NOT to edit code,
 *      and names both env knobs; NO leg executes (exec called exactly once —
 *      the reap);
 *   3. below-threshold pressure runs the chain unchanged;
 *   4. fail-open: unreadable cgroup files (the `x` sentinel) never defer;
 *   6. the reap command still carries the orphan reaper + the __CG__ read
 *      (one shell round-trip, not two);
 *   7. the deferral rides the v1#30 PR-gate semantics (unverified note), so
 *      the pressure-deferred state never masquerades as a verified pass.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Import-graph landmine (see verify-env-red.test.ts): the deferral's telemetry
// reaches loop-metrics via DYNAMIC import — jest still resolves it at runtime,
// dragging config/database → config/env (process.exit(1) on missing env) into
// this env-free-leaf suite. Mock it, exactly like the env-red suite does.
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...args: any[]) => mockRecordLoopMetric(...args),
  LOOP_METRIC_KINDS: { VERIFY_PRESSURE_DEFERRED: 'verify_pressure_deferred' },
}));

import { runVerifyChain, parseCgroupPressure } from './verify.service';

const CHAIN = [
  { key: 'typecheck', command: 'npx tsc --noEmit -p .' },
];

// 12 GiB cgroup at 99.95% — the observed incident shape (12.878/12.885 GB).
const SATURATED = { stdout: '__CG__ 13833408512 13841203200', stderr: '' };
const HEALTHY = { stdout: '__CG__ 5533485056 13841203200', stderr: '' }; // ~40%
const UNREADABLE = { stdout: '__CG__ x x', stderr: '' };

const out = (text: string, code: number) => ({ stdout: `${text}\n__DIGBY_EXIT__ ${code}`, stderr: '' });

beforeEach(() => {
  delete process.env.VERIFY_PRESSURE_DEFER_PCT;
  delete process.env.VERIFY_ENV_RETRY_BACKOFF_MS;
});

describe('parseCgroupPressure', () => {
  it('2026-09-29: with inactive_file the pct is the WORKING SET (current − inactive_file), raw kept alongside', () => {
    // the box C reading: 9.84 GB current / 12 GiB max, 4.34 GB inactive file cache
    const p = parseCgroupPressure('__CG__ 9836904448 12884901888 4341600256')!;
    expect(p.pct).toBeCloseTo(((9836904448 - 4341600256) / 12884901888) * 100, 6);
    expect(p.rawPct).toBeCloseTo((9836904448 / 12884901888) * 100, 6);
    expect(p.workingSetKb).toBe(Math.round((9836904448 - 4341600256) / 1024));
    expect(p.inactiveFileKb).toBe(Math.round(4341600256 / 1024));
    expect(p.pct).toBeLessThan(92); // a cache-full container no longer defers
  });
  it('2026-09-29: an unreadable / nonsensical inactive_file keeps the RAW reading (fail-open to the old behaviour)', () => {
    for (const third of ['x', 'abc', '-5', '99999999999999']) {
      const p = parseCgroupPressure(`__CG__ 13833408512 13841203200 ${third}`)!;
      expect(p.pct).toBeCloseTo((13833408512 / 13841203200) * 100, 6);
      expect(p.rawPct).toBeUndefined();
    }
  });
  it('2026-09-29: VERIFY_PRESSURE_RAW_CURRENT=1 restores the raw memory.current reading', () => {
    process.env.VERIFY_PRESSURE_RAW_CURRENT = '1';
    try {
      const p = parseCgroupPressure('__CG__ 9836904448 12884901888 4341600256')!;
      expect(p.pct).toBeCloseTo((9836904448 / 12884901888) * 100, 6);
      expect(p.rawPct).toBeUndefined();
    } finally { delete process.env.VERIFY_PRESSURE_RAW_CURRENT; }
  });
  it('2026-09-29: a genuinely full working set still defers (anon memory, little cache)', () => {
    const p = parseCgroupPressure('__CG__ 12800000000 12884901888 100000000')!;
    expect(p.pct).toBeGreaterThanOrEqual(92);
  });
  it('parses current/max bytes into pct + KB', () => {
    const p = parseCgroupPressure('__CG__ 13833408512 13841203200');
    expect(p).not.toBeNull();
    expect(p!.pct).toBeGreaterThan(99.9);
    expect(p!.currentKb).toBe(13509188);
    expect(p!.maxKb).toBe(13516800);
  });

  it('returns null for no marker, non-numerics, the unlimited/readable sentinels, and nonsense', () => {
    expect(parseCgroupPressure('')).toBeNull();
    expect(parseCgroupPressure('no marker here')).toBeNull();
    expect(parseCgroupPressure('__CG__ abc 100')).toBeNull();
    expect(parseCgroupPressure('__CG__ 100 abc')).toBeNull();
    expect(parseCgroupPressure('__CG__ 100 max')).toBeNull(); // unlimited
    expect(parseCgroupPressure('__CG__ 100 x')).toBeNull(); // unreadable file
    expect(parseCgroupPressure('__CG__ 100 0')).toBeNull(); // max <= 0
    expect(parseCgroupPressure('__CG__ 200 100')).toBeNull(); // current > max
  });
});

describe('pre-flight cgroup pressure deferral (e4edffa3 isolation class)', () => {
  it('a saturated cgroup DEFERS the chain: hollow pass, one deferred stage, zero legs', async () => {
    const exec = jest.fn().mockResolvedValue(SATURATED); // the reap (+__CG__ read)
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(true);            // v1#30: no fix-loop burn
    expect(r.ran).toBe(false);              // the chain did NOT run
    expect(r.unverified).toBe(true);        // ... and must not read as verified
    expect(r.stages).toHaveLength(1);
    const st = r.stages[0];
    expect(st.deferred).toBe(true);
    expect(st.key).toBe('pressure');
    expect(st.outputTail).toContain('ENV-STARVED — container memory working set'); // ff262da5: the ticket's own verdict class
    expect(st.outputTail).toContain('not a code failure'); // ff262da5 rewording
    expect(st.outputTail).toContain('VERIFY_PRESSURE_DEFER_PCT');
    expect(exec).toHaveBeenCalledTimes(1);  // the reap only — no doomed legs
  });

  it('below-threshold pressure runs the chain unchanged', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce(HEALTHY) // reap + __CG__ (40% — fine)
      .mockResolvedValueOnce(out('ok', 0)); // typecheck
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(true);
    expect(r.unverified).toBe(false);
    expect(r.stages.map(s => s.key)).toEqual(['typecheck']);
  });

  it('fail-open: unreadable cgroup files (x sentinel) never defer', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce(UNREADABLE)
      .mockResolvedValueOnce(out('ok', 0))
      .mockResolvedValueOnce(out('ok', 0));
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(true);
    expect(r.unverified).toBe(false);
  });

  it('the reap leg still reaps ancient orphans AND reads the cgroup in ONE round-trip', async () => {
    const exec = jest.fn().mockResolvedValue(SATURATED);
    await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    const reapCmd = String(exec.mock.calls[0][0]);
    expect(reapCmd).toContain('pgrep -f "tsc --noEmit|node_modules/.bin/jest"');
    expect(reapCmd).toContain('-gt 1800');
    expect(reapCmd).toContain('__CG__');
    expect(reapCmd).toContain('/sys/fs/cgroup/memory.current');
    expect(reapCmd).toContain('/sys/fs/cgroup/memory.max');
  });

  it('the custom threshold env (VERIFY_PRESSURE_DEFER_PCT) moves the defer line', async () => {
    process.env.VERIFY_PRESSURE_DEFER_PCT = '30'; // HEALTHY ~40% — now ABOVE the line
    const exec = jest.fn().mockResolvedValue(HEALTHY);
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(true);
    expect(r.unverified).toBe(true);
    expect(r.stages[0].deferred).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1); // deferred pre-flight — zero legs ran
  });
});
