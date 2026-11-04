/**
 * Replay pin for feedback ticket 7fbc34cd (2026-10-09) — "Auto-verify
 * full-suite jest stage OOM-killed in shared dev container (2× SIGKILL, no
 * exit marker)".
 *
 * The mishap (ticket 7fbc34cd, lane digby/session-28954439, 2026-10-09
 * ~04:20–04:45Z): the auto-verify test stage (`cd backend && npx jest
 * --maxWorkers=2`, ~1114 test files) was killed externally TWICE in a row —
 * "[CAPTURE INCOMPLETE — no exit marker: the wrapper shell died before the
 * tool reported an exit code (external SIGKILL/OOM)]" — each after minutes of
 * PASS lines, zero FAIL lines, no Jest verdict. The env_probe at 04:32:09Z
 * showed the CONTAINER healthy: cgroup max 24,499,638,272 B, current
 * 7,817,211,904 B (32%). The kill pressure was HOST-level (container max
 * 24.5 GB vs host MemTotal 33,089,572,864 B leaves ~8.5 GB for everything
 * else; the kernel OOM-killer favors the largest RSS process — a full-suite
 * jest tree). Net effect: a no-code-change lane ends its firing on a red
 * verify tail it cannot fix and must not code around, and the auto-retry
 * budget burns on deterministic infra.
 *
 * Why every shipped defense missed it: the ≥92% cgroup pressure-defer
 * (Framework Operator run 3, 2026-09-22) reads the CONTAINER's cgroup — 32%
 * is nowhere near the threshold, so it provably could not fire. The
 * environmental classification + one retry already shipped; the ticket's
 * complaint is that the lane reached the retry AT ALL on a doomed box: the
 * two deaths are the cost the pre-flight must prevent.
 *
 * What ships on this branch (three seams, all pinned here):
 *  1. HOST-memory pre-flight: the one-round-trip reap now also prints
 *     `__MEM__ <availKb> <totalKb>` from /proc/meminfo — inside the container
 *     that file is the HOST's (no lxcfs mask; verified live 2026-10-09:
 *     MemTotal 32314036 kB == host 33,089,572,864 B). Host MemAvailable
 *     below VERIFY_HOST_PRESSURE_DEFER_PCT (default 15%) DEFERS the chain
 *     with the same hollow-pass semantics as the cgroup leg — the incident
 *     lane would have read "DEFERRED — host memory pressure" and burned
 *     nothing. Fail-open on every unreadable shape.
 *  2. The NODE_OPTIONS heap cap is no longer a POSIX-scoping NO-OP: the old
 *     `NODE_OPTIONS="…" cd backend && npx jest` bound the assignment to `cd`
 *     ONLY (verified: sh -c 'FOO=1 cd / && echo [$FOO]' prints []), so the
 *     2048 MB cap NEVER reached jest/tsc on any `cd X && …` leg — this repo's
 *     exact command shape. Legs now `export NODE_OPTIONS=…; <command>`.
 *  3. jest.config.js workerIdleMemoryLimit (the ticket's literal suggestion):
 *     bounded worker recycling for the full-suite tree, pinned in
 *     src/jest-config.test.ts (7fbc34cd describe block).
 *
 * This file pins THE TICKET'S exact incident shape against that shipped
 * surface: cgroup reads healthy (32%) while the HOST is starved → defer with
 * ZERO legs executed, never a red tail; the parser fail-opens; both kill
 * switches restore the old behavior; the leg form actually exports the cap;
 * and the reap round-trip still carries the orphan reaper + cgroup read (one
 * shell round-trip, not two).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Import-graph landmine (see verify-pressure-defer.test.ts): the deferral's
// telemetry reaches loop-metrics via DYNAMIC import — jest still resolves it
// at runtime, dragging config/database → config/env (process.exit(1) on
// missing env) into this env-free-leaf suite. Mock it the same way.
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { VERIFY_PRESSURE_DEFERRED: 'verify_pressure_deferred' },
}));

import { parseHostMemoryPressure, runVerifyChain } from './verify.service';

const CHAIN = [
  { key: 'typecheck', command: 'cd backend && npx tsc --noEmit' },
  { key: 'test', command: 'cd backend && npx jest --maxWorkers=2' },
];

const out = (text: string, code: number) => ({ stdout: `${text}\n__DIGBY_EXIT__ ${code}`, stderr: '' });

// THE INCIDENT SHAPE (7fbc34cd): cgroup HEALTHY at 32% (7,817,211,904 /
// 24,499,638,272 B — the env_probe numbers verbatim), HOST starved
// (MemAvailable 1,988,316 kB of MemTotal 32,314,036 kB ≈ 6.2% — the incident
// host's meminfo with the available memory the co-tenant spike ate).
const CG_HEALTHY__HOST_STARVED = {
  stdout: '__CG__ 7817211904 24499638272 0\n__MEM__ 1988316 32314036',
  stderr: '',
};

// The healthy pair: container 32%, host 88% available — the chain runs.
const CG_HEALTHY__HOST_HEALTHY = {
  stdout: '__CG__ 7817211904 24499638272 0\n__MEM__ 28526632 32314036',
  stderr: '',
};

// A shell that answers the reap (configurable), the related-tests git reads
// (clean tree, nothing derivable → the full stage runs), and every leg with a
// clean marker — the shape the existing verify suites use.
const shell = (calls: string[], reap: { stdout: string; stderr: string } = CG_HEALTHY__HOST_HEALTHY) =>
  async (command: string): Promise<{ stdout: string; stderr: string }> => {
    calls.push(command);
    if (command.startsWith('for p in')) return reap;
    if (command.startsWith('git diff') || command.startsWith('B=$(git merge-base')) return { stdout: '', stderr: '' };
    return out('', 0);
  };

beforeEach(() => {
  delete process.env.VERIFY_PRESSURE_DEFER_PCT;
  delete process.env.VERIFY_HOST_PRESSURE_DEFER_PCT;
  delete process.env.VERIFY_ENV_RETRY_BACKOFF_MS;
});

describe('7fbc34cd seam 1 — host-memory pre-flight deferral', () => {
  it('REPLAY: the incident shape (cgroup healthy 32%, host starved ~6%) DEFERS with ZERO legs — never the doomed-jest red tail', async () => {
    const exec = jest.fn().mockResolvedValue(CG_HEALTHY__HOST_STARVED);
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    // v1#30 hollow-pass semantics — identical to the cgroup defer leg.
    expect(r.passed).toBe(true);            // no fix-loop burn
    expect(r.ran).toBe(false);              // nothing ran
    expect(r.unverified).toBe(true);        // no green checkmark either
    expect(r.stages[0].deferred).toBe(true);
    expect(r.stages[0].key).toBe('host_pressure'); // ff262da5: the stage key names the arm
    expect(exec).toHaveBeenCalledTimes(1);  // the reap round-trip ONLY — zero legs
    // The tail names the HOST (not the cgroup), the ticket class, and both knobs.
    expect(r.stages[0].outputTail).toContain('host memory starved'); // ff262da5 ENV-STARVED wording
    expect(r.stages[0].outputTail).toContain('7fbc34cd');
    expect(r.stages[0].outputTail).toContain('not a code failure');
  });

  it('the healthy host runs the chain unchanged (both markers healthy → typecheck + test legs execute)', async () => {
    const calls: string[] = [];
    const r = await runVerifyChain(shell(calls) as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(true);
    expect(r.ran).toBe(true);
    expect(r.unverified).toBe(false);
    expect(r.stages.map(s => s.key)).toEqual(['typecheck', 'test']);
    // reap + typecheck leg + the related-tests git reads + the test leg — no retries.
    expect(calls).toHaveLength(5);
  });

  it('a SATURATED CGROUP still defers on the cgroup leg (host marker present but healthy — precedence preserved)', async () => {
    const saturated = {
      stdout: '__CG__ 13833408512 13841203200 x\n__MEM__ 28526632 32314036', // cgroup 99.95%, host 88% — healthy
      stderr: '',
    };
    const exec = jest.fn().mockResolvedValue(saturated);
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.ran).toBe(false);
    expect(r.stages[0].deferred).toBe(true);
    expect(r.stages[0].outputTail).toContain('ENV-STARVED'); // ff262da5: the defer arms share the ENV-STARVED shape
  });

  it('the custom floor (VERIFY_HOST_PRESSURE_DEFER_PCT) moves the defer line', async () => {
    process.env.VERIFY_HOST_PRESSURE_DEFER_PCT = '90'; // host at 88% available is now BELOW the floor
    const exec = jest.fn().mockResolvedValue(CG_HEALTHY__HOST_HEALTHY);
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.ran).toBe(false);
    expect(r.stages[0].deferred).toBe(true);
    expect(r.stages[0].outputTail).toContain('host memory starved'); // ff262da5 wording
  });

  it('the reap round-trip still carries the orphan reaper + cgroup read + host read (ONE shell round-trip)', async () => {
    const calls: string[] = [];
    await runVerifyChain(shell(calls) as any, '/wt', CHAIN, 1000);
    const reapCmd = calls[0];
    expect(reapCmd).toContain('pgrep -f "tsc --noEmit|node_modules/.bin/jest"');
    expect(reapCmd).toContain('-gt 1800');
    expect(reapCmd).toContain('__CG__');
    expect(reapCmd).toContain('/sys/fs/cgroup/memory.current');
    expect(reapCmd).toContain('/sys/fs/cgroup/memory.max');
    expect(reapCmd).toContain('__MEM__');
    expect(reapCmd).toContain('/proc/meminfo');
    expect(reapCmd).toContain('MemAvailable');
  });
});

describe('7fbc34cd seam 2 — the heap cap actually reaches the tool (export, not the POSIX no-op prefix)', () => {
  it('every leg EXPORTS NODE_OPTIONS (the prefix form binds to `cd` only — the 2026-10-09 no-op)', async () => {
    const calls: string[] = [];
    await runVerifyChain(shell(calls) as any, '/wt', CHAIN, 1000);
    const tscLeg = calls.find(c => c.includes('npx tsc --noEmit'))!;
    const jestLeg = calls.find(c => c.includes('npx jest --maxWorkers=2'))!;
    // The export form scopes the cap to the WHOLE leg, `cd … && npx jest` included.
    expect(tscLeg).toContain('export NODE_OPTIONS="--max-old-space-size=4096"; cd backend && npx tsc --noEmit');
    expect(jestLeg).toContain('export NODE_OPTIONS="--max-old-space-size=4096"; cd backend && npx jest --maxWorkers=2');
    // And the no-op prefix form is gone.
    expect(tscLeg).not.toMatch(/^NODE_OPTIONS="/);
    expect(jestLeg).not.toMatch(/^NODE_OPTIONS="/);
  });
});

describe('7fbc34cd — parseHostMemoryPressure (fail-open parser contract)', () => {
  it('parses the reap marker (kB → pct)', () => {
    const p = parseHostMemoryPressure('__MEM__ 1988316 32314036')!;
    expect(p.availPct).toBeCloseTo((1988316 / 32314036) * 100, 6);
    expect(p.availKb).toBe(1988316);
    expect(p.totalKb).toBe(32314036);
  });

  it('parses when the cgroup marker precedes it on the same stream (the real reap output)', () => {
    expect(parseHostMemoryPressure('__CG__ 7817211904 24499638272 0\n__MEM__ 1988316 32314036')).not.toBeNull();
  });

  it('fail-open: no marker / x sentinel / garbage / zero-total / avail>total → null (chain runs unchanged)', () => {
    expect(parseHostMemoryPressure('')).toBeNull();
    expect(parseHostMemoryPressure('__CG__ 13833408512 13841203200')).toBeNull(); // no __MEM__ line
    expect(parseHostMemoryPressure('__MEM__ x x')).toBeNull();
    expect(parseHostMemoryPressure('__MEM__ x 32314036')).toBeNull();
    expect(parseHostMemoryPressure('__MEM__ 1988316 x')).toBeNull();
    expect(parseHostMemoryPressure('__MEM__ -5 32314036')).toBeNull();
    expect(parseHostMemoryPressure('__MEM__ lots of memory')).toBeNull();
    expect(parseHostMemoryPressure('__MEM__ 1988316 0')).toBeNull();
    expect(parseHostMemoryPressure('__MEM__ 99999999 32314036')).toBeNull(); // avail > total — nonsense
  });
});
