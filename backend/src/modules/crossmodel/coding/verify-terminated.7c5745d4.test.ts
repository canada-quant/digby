/**
 * Ticket 7c5745d4 — auto-verify 'test' gate false red: a pytest stage killed at
 * 99% (harness timeout SIGTERM / 16 MiB maxBuffer kill / external kill) surfaced
 * as exit 1 with a huge truncated tail and NO summary line — byte-for-byte
 * indistinguishable from a test failure at the classification site, while the
 * same suite passed on manual re-run (5969 passed, PYTEST_EXIT=0).
 *
 * Root cause: the wrapper `bash -c '<leg>; echo "__DIGBY_EXIT__ $?"'` died BEFORE
 * the echo, so no exit marker existed and verify.service collapsed the missing
 * marker to `exitCode = 1` with no record — and the environmental predicate
 * (137 | empty output) could never match a killed-mid-stream run.
 *
 * Fix pinned here: a stage with NO __DIGBY_EXIT__ marker anywhere in its output
 * is `terminated` — deterministic proof the wrapper was killed before the tool
 * reported a verdict — and is classified ENVIRONMENTAL (one in-chain retry,
 * [ENVIRONMENTAL]/[CAPTURE INCOMPLETE] surfacing with the derived cause), never
 * a code red. A real red WITH the marker is untouched.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Telemetry boundary (T2e, ticket 7ec6200b): verify.service now reaches
// loop-metrics from the TIMEOUT-class path too (noteVerifyStageTimeout — a
// stage killed at the per-command timeout emits verify_stage_timeout), and
// this suite exercises that path with a raw stderr 'timed out' shape. Mock
// the boundary like the sibling suites (verify-env-red.test.ts) — the real
// module drags config/database → config/env → process.exit(1) into the
// worker, which kills it before a single test runs.
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...args: any[]) => mockRecordLoopMetric(...args),
  LOOP_METRIC_KINDS: { VERIFY_ENV_RED: 'verify_env_red', VERIFY_STAGE_TIMEOUT: 'verify_stage_timeout' },
}));

import { runVerifyChain } from './verify.service';

// The ticket's stage is 'test'; the classifier is stage-agnostic.
const CHAIN = [{ key: 'test', command: 'pytest -q' }];

// The chain runs a related-tests-first git listing before a 'test' stage;
// answer it empty here (nothing derivable => the full stage runs as before) so
// `exec` sees only the reap and the legs (verify-related.test.ts covers the
// related-first pass itself).
const noGit = (exec: jest.Mock): any => (cmd: string, ...rest: any[]) =>
  /^(?:git diff|B=\$\(git merge-base)/.test(cmd) ? Promise.resolve({ stdout: '', stderr: '' }) : exec(cmd, ...rest);

beforeEach(() => {
  process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
});

const out = (text: string, code: number) => ({ stdout: `${text}\n__DIGBY_EXIT__ ${code}`, stderr: '' });

/** The ticket's signature: a 99% pytest stream cut off mid-line, NO summary,
 *  NO exit marker — with the exec layer's kill stamp in stderr. */
const TRUNCATED_PYTEST = [
  'tests/test_citation_resolution.py::test_r1 PASSED',
  'tests/test_scorecard.py::test_hash PASSED',
  'tests/test_no_prompt_gold_contamination.py::test_r1_flags_statutory_text_shared_across_gold_answers',
].join('\n');

describe('terminated verify stages (ticket 7c5745d4 — capture truncation must never be a code red)', () => {
  it('REPLAY: a pytest stage killed at 99% (16 MiB maxBuffer capture kill — the ticket signature) is environmental+terminated, retried once, surfaced with its cause', async () => {
    const killed = { stdout: TRUNCATED_PYTEST, stderr: '\n[exit: ERR_CHILD_PROCESS_STDIO_MAXBUFFER]' };
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // the orphan reap — always call #1
      .mockResolvedValueOnce(killed)                     // attempt 1: killed mid-stream
      .mockResolvedValueOnce(killed);                    // attempt 2: still dying (peer pressure)
    const r = await runVerifyChain(noGit(exec), '/wt', CHAIN, 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('test');
    expect(exec).toHaveBeenCalledTimes(3);               // reap + exactly ONE in-chain retry
    const st = r.stages[0];
    expect(st.terminated).toBe(true);
    expect(st.environmental).toBe(true);
    expect(st.exitCode).toBe(1);                         // the missing-marker default, not a verdict
    expect(st.outputTail).toContain('[CAPTURE INCOMPLETE — no exit marker:');
    expect(st.outputTail).toContain('capture buffer');
    expect(st.outputTail).toContain('NOT a test verdict');
    expect(st.outputTail).toContain(TRUNCATED_PYTEST.split('\n')[0]); // the stream is preserved below the note
  });

  it('a stage killed at the harness per-command timeout (no marker, — timed out stamp) names the timeout as the cause', async () => {
    const killed = { stdout: TRUNCATED_PYTEST, stderr: '\n[exit: error — timed out]' };
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(killed)
      .mockResolvedValueOnce(killed);
    const r = await runVerifyChain(noGit(exec), '/wt', CHAIN, 1000);
    const st = r.stages[0];
    expect(st.terminated).toBe(true);
    // T2e (ticket 7ec6200b): the per-command timeout is the FAILURE-class
    // split — stageTimeout, NOT environmental (a hung stage may be a code
    // defect); the maxbuffer kill below keeps the environmental class.
    expect(st.stageTimeout).toBe(true);
    expect(st.environmental).toBeUndefined();
    expect(st.outputTail).toContain('per-command timeout (1000 ms)');
    expect(st.outputTail).toContain('not classified environmental');
    // Not blind-retried: preamble + ONE attempt only (the second mock value is
    // deliberately unused now).
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('a stage killed with NO stamp at all (external SIGKILL of the wrapper) falls back to the external-kill cause', async () => {
    const killed = { stdout: TRUNCATED_PYTEST, stderr: '' };
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(killed)
      .mockResolvedValueOnce(killed);
    const r = await runVerifyChain(noGit(exec), '/wt', CHAIN, 1000);
    const st = r.stages[0];
    expect(st.terminated).toBe(true);
    expect(st.environmental).toBe(true);
    expect(st.outputTail).toContain('external SIGKILL/OOM');
  });

  it('the ticket recovery: a terminated attempt followed by a clean retry PASSES the chain with no flags (the manual-re-run-passes scenario)', async () => {
    const killed = { stdout: TRUNCATED_PYTEST, stderr: '\n[exit: ERR_CHILD_PROCESS_STDIO_MAXBUFFER]' };
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(killed)
      .mockResolvedValueOnce(out('5969 passed, 106 skipped, 13 xfailed in 379.61s', 0));
    const r = await runVerifyChain(noGit(exec), '/wt', CHAIN, 1000);
    expect(r.passed).toBe(true);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(r.stages[0].terminated).toBeUndefined();
    expect(r.stages[0].environmental).toBeUndefined();
  });

  it('a REAL red WITH the exit marker (1 failed) stays a code red: no retry, no terminated/environmental flags, no CAPTURE note', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(out('FAILED tests/test_x.py::test_y\n1 failed, 5968 passed in 380.12s', 1));
    const r = await runVerifyChain(noGit(exec), '/wt', CHAIN, 1000);
    expect(r.passed).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);               // reap + one leg — NO retry
    const st = r.stages[0];
    expect(st.terminated).toBeUndefined();
    expect(st.environmental).toBeUndefined();
    expect(st.outputTail).not.toContain('CAPTURE INCOMPLETE');
    expect(st.outputTail).toContain('1 failed');
  });

  it('a stage terminated with ZERO output (killed before printing anything) gets the terminated zero-diagnostics environmental message', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })   // reap
      .mockResolvedValueOnce({ stdout: '', stderr: '' })   // attempt 1: died silently, no stamp
      .mockResolvedValueOnce({ stdout: '', stderr: '' });  // attempt 2: same
    const r = await runVerifyChain(noGit(exec), '/wt', CHAIN, 1000);
    const st = r.stages[0];
    expect(st.terminated).toBe(true);
    expect(st.environmental).toBe(true);
    expect(st.outputTail).toContain('[ENVIRONMENTAL] stage terminated without an exit code');
    expect(st.outputTail).toContain('zero diagnostics');
  });

  it('a literal __DIGBY_EXIT__ line INSIDE the tool output still defeats termination detection (last-marker-wins is preserved)', async () => {
    // Accepted hazard, pinned deliberately: a tool that prints the marker text
    // itself is classified by that marker (exit 0 here), never as terminated.
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(out('log line mentioning __DIGBY_EXIT__ 0 from an old artifact', 1));
    const r = await runVerifyChain(noGit(exec), '/wt', CHAIN, 1000);
    expect(r.passed).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);               // code red — no retry
    expect(r.stages[0].terminated).toBeUndefined();
    expect(r.stages[0].exitCode).toBe(1);                // LAST marker won
  });
});
