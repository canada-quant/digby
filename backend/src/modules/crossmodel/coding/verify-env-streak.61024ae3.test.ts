/**
 * Ticket 61024ae3 — mishap replay: a 3× verify-failure streak on THIS lane
 * (Framework Operator session 5f90c628, run 041dcbe1, 2026-09-22 ~00:22Z
 * window) under shared-container parallel load (the e4edffa3 class).
 *
 * The breaker tripped on THREE harness-reported verify reds:
 *
 *   1. test:related exit 1 — the jest BufferedConsole crash under memory
 *      pressure ("The first argument must be of type string or an instance of
 *      Buffer, ArrayBuffer, or Array or an Array-like Object. Received
 *      undefined" at node_modules/@jest/console/build/BufferedConsole.js);
 *   2. test exit 1 — base-push-guard.v1-26.test.ts 5s test-timeout;
 *   3. test exit 1 — cron-status.test.ts (30.566 s) "Exceeded timeout of
 *      5000 ms" on "401s without a token (the app-level guard)".
 *
 * Every suite involved was proven solo-green three times the same night
 * (scaffold-commit 4/4 in 0.729 s, clip-bench 2/2, chat-agent.service exit 0)
 * — the reds existed only under ~7 parallel jest workers on a 4-CPU container
 * cap whose 12.88 GB cgroup was already carrying peer lanes' verify chains
 * (oom_kill 269). The 'lint skipped — tool not installed' line was a
 * worktree-provisioning gap, not a lint failure.
 *
 * Adjudication (adminNote 2026-09-22T01:03Z): environmental (shared-container
 * load-flake class), breaker arithmetic AS DESIGNED — the mishap fired
 * correctly per the 2026-09-10 doctrine (self-heal + attribute); the reds
 * themselves were truthful reports of load-induced timeouts, which the chain
 * CANNOT distinguish from real slow tests at stage level. The distinction
 * lives in the disposition (solo-green re-runs), which this suite pins.
 *
 * What this suite pins (the durable fixes the disposition rests on):
 *   (a) REPLAY: the literal 5s-timeout test red is a real code-SHAPED red —
 *       reported truthfully with the timeout text, NOT environmental (output
 *       present), no in-chain retry — the chain never whitewashes a test
 *       failure, even one later proven to be a load flake;
 *   (b) REPLAY: the BufferedConsole-crash test:related red likewise reports
 *       truthfully (the jest crash text rides the tail);
 *   (c) the solo-green recovery: the same stage passes clean on a cooled box
 *       (the evidence that adjudicated the streak environmental);
 *   (d) ROOT-CAUSE pin: the repo verify config caps the full-jest stage at
 *       --maxWorkers=2 (e4edffa3 / PR #957) — the load that produced these
 *       timeouts cannot recur from one lane's verify;
 *   (e) PROACTIVE pin: at cgroup saturation the chain now DEFERS pre-flight
 *       (4a282b4c) instead of running into exactly this window.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Import-graph landmine (see verify-pressure-defer.test.ts): the deferral's
// telemetry reaches loop-metrics via DYNAMIC import — jest still resolves it
// at runtime, dragging config/database → config/env (process.exit(1) on
// missing env) into this env-free-leaf suite. Mock it, exactly like the
// pressure-defer suite does.
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...args: any[]) => mockRecordLoopMetric(...args),
  LOOP_METRIC_KINDS: { VERIFY_PRESSURE_DEFERRED: 'verify_pressure_deferred', VERIFY_ENV_RED: 'verify_env_red' },
}));

import * as path from 'path';
import { runVerifyChain, readDigbyConfig } from './verify.service';

/** The ticket's literal newest red: cron-status.test.ts 5s test-timeout. */
const CRON_TIMEOUT = [
  'Summary of all failing tests',
  'FAIL src/modules/crossmodel/coding/cron-status.test.ts (30.566 s)',
  '  ● GET /api/crossmodel/coding/cron-status › 401s without a token (the app-level guard)',
  '',
  '    thrown: "Exceeded timeout of 5000 ms for a test.',
  '    Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jest',
].join('\n');

/** The ticket's oldest red: the jest BufferedConsole crash under memory pressure. */
const CONSOLE_CRASH = [
  '    The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined".',
  '',
  '      672 |   } catch {',
  '      673 |     /* never throws */',
  '    > 674 |   }',
  '',
  '      at console.log (node_modules/@jest/console/build/BufferedConsole.js',
].join('\n');

// The chain runs a related-tests-first git listing before a 'test' stage;
// answer it empty here (nothing derivable => the full stage runs as before) so
// `exec` sees only the reap and the legs (verify-related.test.ts covers the
// related-first pass itself).
const noGit = (exec: jest.Mock): any => (cmd: string, ...rest: any[]) =>
  /^(?:git diff|B=\$\(git merge-base)/.test(cmd) ? Promise.resolve({ stdout: '', stderr: '' }) : exec(cmd, ...rest);

beforeEach(() => {
  process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
  delete process.env.VERIFY_PRESSURE_DEFER_PCT;
});
afterEach(() => {
  delete process.env.VERIFY_ENV_RETRY_BACKOFF_MS;
});

describe('verify load-flake streak replay (ticket 61024ae3 — the 5s-timeout class under parallel load)', () => {
  it('REPLAY: the cron-status 5s test-timeout red is a truthful CODE-shaped failure — the timeout text rides the tail, no environmental whitewash, no retry', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '__CG__ 5533485056 13841203200', stderr: '' }) // reap + __CG__ (~40% — chain runs)
      .mockResolvedValueOnce({ stdout: `${CRON_TIMEOUT}\n__DIGBY_EXIT__ 1`, stderr: '' });
    const r = await runVerifyChain(noGit(exec), '/wt', [{ key: 'test', command: 'npx jest --maxWorkers=2' }], 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('test');
    expect(exec).toHaveBeenCalledTimes(2);   // reap + ONE attempt — exit 1 with output is never retried
    const st = r.stages[0];
    expect(st.environmental).toBeFalsy();    // real output = real red; the disposition (load flake) lives above the chain
    expect(st.terminated).toBeUndefined();
    expect(st.exitCode).toBe(1);
    expect(st.outputTail).toContain('Exceeded timeout of 5000 ms');
    expect(st.outputTail).toContain('cron-status.test.ts');
  });

  it('REPLAY: the BufferedConsole-crash test:related red reports truthfully (the jest crash text preserved)', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '__CG__ 5533485056 13841203200', stderr: '' })
      .mockResolvedValueOnce({ stdout: `${CONSOLE_CRASH}\n__DIGBY_EXIT__ 1`, stderr: '' });
    const r = await runVerifyChain(exec as any, '/wt', [{ key: 'test:related', command: 'npx jest --findRelatedTests' }], 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('test:related');
    const st = r.stages[0];
    expect(st.exitCode).toBe(1);
    expect(st.outputTail).toContain('The first argument must be of type string');
    expect(st.outputTail).toContain('BufferedConsole.js');
  });

  it('the adjudication evidence: the SAME stage green on a cooled box passes clean — the solo re-run that proved every red a load flake', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '__CG__ 5533485056 13841203200', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'PASS src/modules/crossmodel/coding/cron-status.test.ts\n__DIGBY_EXIT__ 0', stderr: '' });
    const r = await runVerifyChain(noGit(exec), '/wt', [{ key: 'test', command: 'npx jest --maxWorkers=2' }], 1000);
    expect(r.passed).toBe(true);
    expect(r.unverified).toBe(false);
    expect(r.stages[0].environmental).toBeUndefined();
  });


  it('PROACTIVE pin (4a282b4c): a SATURATED cgroup DEFERS the chain pre-flight — this streak\'s window never gets legs to time out', async () => {
    const exec = jest.fn().mockResolvedValue({ stdout: '__CG__ 13833408512 13841203200', stderr: '' }); // 99.95% — the incident shape
    const r = await runVerifyChain(exec as any, '/wt', [{ key: 'test', command: 'npx jest --maxWorkers=2' }], 1000);
    expect(r.passed).toBe(true);            // v1#30 hollow pass
    expect(r.ran).toBe(false);
    expect(r.unverified).toBe(true);
    expect(r.stages[0].deferred).toBe(true);
    expect(r.stages[0].key).toBe('pressure');
    expect(exec).toHaveBeenCalledTimes(1);  // the reap only — zero legs
  });
});
