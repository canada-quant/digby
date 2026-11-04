/**
 * Ticket 9c1ed093 — mishap replay: a 3× verify-failure streak on the
 * Triage-Race session c03ff58e (run 3093eb99, 2026-09-22 00:13Z window) under
 * the shared dev container's cgroup memory pressure (the e4edffa3 class).
 *
 * The breaker tripped on THREE harness-reported verify reds that were all
 * environmental, never code:
 *
 *   1. typecheck exit 137, output tail literally "Killed" — SIGKILL: the OOM
 *      killer took the tsc child while peer lanes' verify chains owned the
 *      cgroup (env_probe the same window: 12.15/12.88 GB, oom_kill climbing);
 *   2. typecheck exit 137 again — same shape;
 *   3. typecheck exit 1 with the npm banner "This is not the tsc command you
 *      are looking for" — npm exec resolving the placeholder `tsc` package
 *      while the freshly-provisioned worktree's node_modules was incomplete
 *      (provisioning-completeness race; self-resolved on the next attempt).
 *
 * Adjudication (adminNote 2026-09-22T01:03Z): environmental (shared-container
 * OOM class), breaker arithmetic AS DESIGNED. The same lane then recorded a
 * full green chain (~00:38Z, 10,095 tests) once the memory window freed, and
 * its PR #956 merged green (squash a87ea6ce) — the reds existed only under
 * pressure.
 *
 * What this suite pins (the durable fixes this mishap's disposition rests on):
 *   (a) exit 137 with the marker ⇒ ENVIRONMENTAL (one in-chain retry), never a
 *       code red — the 2026-09-10 OOM-herd predicate;
 *   (b) the exit-1 placeholder-tsc red is a code-shaped failure (not
 *       environmental, no retry) — pinning that the environmental predicate
 *       never whitewashes a REAL tool-resolution failure;
 *   (c) the PRE-FLIGHT cgroup-pressure DEFER (Framework Operator run 3,
 *       commit 4a282b4c — the proactive half of the e4edffa3 isolation class):
 *       at ≥92% saturation the chain DEFERS (hollow pass, zero legs) instead
 *       of running tsc into the OOM wall that produced this ticket's 137s;
 *   (d) the repo verify config keeps the full-jest stage worker-capped
 *       (--maxWorkers=2, PR #957) so one lane's verify cannot OOM peers — the
 *       repo-side half of the root-cause fix.
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

const TSC_KILLED = { stdout: 'Killed\n__DIGBY_EXIT__ 137', stderr: '' };

/** The ticket's literal leg-3 banner: npm exec found the placeholder `tsc` package. */
const PLACEHOLDER_TSC = [
  'This is not the tsc command you are looking for',
  '',
  'To get access to the TypeScript compiler, `tsc`, from the command line either:',
  '',
  '- Use `npm install typescript` to first add Type',
].join('\n');

beforeEach(() => {
  process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
  delete process.env.VERIFY_PRESSURE_DEFER_PCT;
});
afterEach(() => {
  delete process.env.VERIFY_ENV_RETRY_BACKOFF_MS;
});

describe('verify environmental streak replay (ticket 9c1ed093 — the exit-137 typecheck class)', () => {
  it('REPLAY legs 1-2: typecheck exit 137 with the "Killed" tail (marker present) is environmental, retried exactly once, never terminated', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '__CG__ 5533485056 13841203200', stderr: '' }) // reap + __CG__ (~40% — runs)
      .mockResolvedValueOnce(TSC_KILLED)  // attempt 1: OOM SIGKILL (ticket leg 1)
      .mockResolvedValueOnce(TSC_KILLED); // attempt 2: still under pressure (ticket leg 2)
    const r = await runVerifyChain(exec as any, '/wt', [{ key: 'typecheck', command: 'npx tsc --noEmit' }], 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('typecheck');
    expect(exec).toHaveBeenCalledTimes(3);          // reap + exactly ONE in-chain retry
    const st = r.stages[0];
    expect(st.environmental).toBe(true);
    expect(st.terminated).toBeUndefined();          // the marker survived — exit 137 is a real (infra) exit
    expect(st.exitCode).toBe(137);
    expect(st.outputTail).toContain('Killed');
    expect(st.outputTail).not.toContain('CAPTURE INCOMPLETE');
  });

  it('REPLAY leg 3: the exit-1 placeholder-tsc banner is a CODE-shaped failure — not environmental, no retry, no whitewash', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '__CG__ 5533485056 13841203200', stderr: '' })
      .mockResolvedValueOnce({ stdout: `${PLACEHOLDER_TSC}\n__DIGBY_EXIT__ 1`, stderr: '' });
    const r = await runVerifyChain(exec as any, '/wt', [{ key: 'typecheck', command: 'npx tsc --noEmit' }], 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('typecheck');
    expect(exec).toHaveBeenCalledTimes(2);          // reap + ONE attempt — the environmental retry does NOT fire
    const st = r.stages[0];
    expect(st.environmental).toBeFalsy();           // exit 1 + non-empty output = a real failure
    expect(st.terminated).toBeUndefined();
    expect(st.exitCode).toBe(1);
    expect(st.outputTail).toContain('This is not the tsc command you are looking for');
  });

  it('the ticket recovery: the same stage green on a cooled box passes the chain clean (the ~00:38Z re-run that disproved every red)', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '__CG__ 5533485056 13841203200', stderr: '' }) // reap + __CG__ (~40%)
      .mockResolvedValueOnce({ stdout: '__DIGBY_EXIT__ 0', stderr: '' });   // typecheck clean
    const r = await runVerifyChain(exec as any, '/wt', [{ key: 'typecheck', command: 'npx tsc --noEmit' }], 1000);
    expect(r.passed).toBe(true);
    expect(r.unverified).toBe(false);
    expect(r.stages[0].environmental).toBeUndefined();
    expect(r.stages[0].terminated).toBeUndefined();
  });

  it('PROACTIVE pin (4a282b4c, Framework Operator run 3): a SATURATED cgroup DEFERS the whole chain pre-flight — the 137s this ticket recorded never get the chance to run', async () => {
    const exec = jest.fn().mockResolvedValue({ stdout: '__CG__ 13833408512 13841203200', stderr: '' }); // 99.95% — the incident shape
    const r = await runVerifyChain(exec as any, '/wt', [{ key: 'typecheck', command: 'npx tsc --noEmit' }], 1000);
    expect(r.passed).toBe(true);            // v1#30: no fix-loop burn
    expect(r.ran).toBe(false);              // the chain did NOT run
    expect(r.unverified).toBe(true);        // ... and must not read as verified
    expect(r.stages).toHaveLength(1);
    expect(r.stages[0].deferred).toBe(true);
    expect(r.stages[0].key).toBe('pressure');
    expect(r.stages[0].outputTail).toContain('ENV-STARVED — container memory working set'); // ff262da5 wording
    expect(r.stages[0].outputTail).toContain('not a code failure'); // ff262da5: the ENV-STARVED envelope still marks the class it prevents
    expect(exec).toHaveBeenCalledTimes(1);  // the reap only — zero doomed legs
  });

});
