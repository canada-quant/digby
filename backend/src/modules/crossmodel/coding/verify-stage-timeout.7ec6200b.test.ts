/**
 * verify-stage-timeout.7ec6200b.test.ts — T2e (todo a04cda91, ticket
 * 7ec6200b): the per-command-timeout death is a FAILURE class, split OUT of
 * the environmental class.
 *
 * The ticket's original complaint: environmental stage deaths were counted as
 * code failures, blind-retried, and the resize only ever grew. The
 * 2026-09-10/ff262da5 waves already fixed env-red honesty (verify-env-red
 * .test.ts) and pressure deferral; this file pins the REMAINING split:
 *
 *   1. A stage killed at the harness per-command timeout ('— timed out' exec
 *      stamp, no exit marker) is stageTimeout:true, NOT environmental — a
 *      hung test may be a code defect (infinite loop, deadlock), so it is
 *      surfaced as a failure with its own tail text, never auto-labeled infra.
 *   2. It is NOT blind-retried: the exec mock is called exactly the reap
 *      preamble + ONE stage attempt (attempt 0) — the retry loop breaks.
 *   3. It emits the verify_stage_timeout telemetry row (via
 *      noteVerifyStageTimeout from the failing-stage site) and does NOT park
 *      an env-red verdict (consumeEnvironmentalRed returns null).
 *   4. The ACCEPTANCE TEST from the ticket, verbatim in spirit: a simulated
 *      LOW-MEMORY run (exit 137, no diagnostics) stays env-classified —
 *      environmental:true, no stageTimeout, retried once, env-red parked.
 *   5. An OOM-class death still never counts as a code failure.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const memStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => memStore.get(`${ns.join('/')}/${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { memStore.set(`${ns.join('/')}/${key}`, value); }),
}));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...args: any[]) => mockRecordLoopMetric(...args),
  LOOP_METRIC_KINDS: { VERIFY_ENV_RED: 'verify_env_red', VERIFY_STAGE_TIMEOUT: 'verify_stage_timeout' },
}));

import { runVerifyChain } from './verify.service';
import { consumeEnvironmentalRed } from './verify.service';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const CHAIN = [{ key: 'typecheck', command: 'npx tsc --noEmit' }];

/** The harness per-command timeout kill shape: NO __DIGBY_EXIT__ marker
 *  anywhere + the exec layer's '[exit: error — timed out]' stamp (the exact
 *  stamp verify.service's terminatedCause parses). */
const timeoutKillExec = () => jest.fn()
  .mockResolvedValueOnce({ stdout: '', stderr: '' }) // reap preamble
  .mockResolvedValueOnce({ stdout: 'jest output line 1\nline 2\n', stderr: 'Error: [exit: error — timed out]' });

/** The OOM shape (the ticket's simulated low-memory run): exit 137 twice,
 *  zero diagnostics — the env class, retried once. */
const oomKillExec = () => jest.fn()
  .mockResolvedValueOnce({ stdout: '', stderr: '' }) // reap preamble
  .mockResolvedValueOnce({ stdout: '', stderr: '__DIGBY_EXIT__ 137' })
  .mockResolvedValueOnce({ stdout: '', stderr: '__DIGBY_EXIT__ 137' });

describe('T2e: stage timeout is a FAILURE class, split from the environmental class (ticket 7ec6200b)', () => {
  let wt: string;

  beforeEach(async () => {
    process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
    memStore.clear();
    mockRecordLoopMetric.mockClear();
    wt = await fs.mkdtemp(path.join(os.tmpdir(), 'vst-wt-'));
    const g = (args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'pipe' });
    g(['init', '-q', '-b', 'digby/x']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 't']);
    await fs.writeFile(path.join(wt, 'a.txt'), 'v1\n');
    g(['add', '.']);
    g(['commit', '-qm', 'c1']);
  });

  afterEach(async () => {
    delete process.env.VERIFY_ENV_RETRY_BACKOFF_MS;
    await fs.rm(wt, { recursive: true, force: true }).catch(() => {});
  });

  test('a per-command timeout kill is stageTimeout (NOT environmental), never blind-retried, fails loudly', async () => {
    const exec = timeoutKillExec();
    const r = await runVerifyChain(exec as any, wt, CHAIN, 120_000);
    expect(r.passed).toBe(false);
    expect(r.ran).toBe(true);
    const st = r.stages.find((s) => s.key === 'typecheck')!;
    expect(st.stageTimeout).toBe(true);
    expect(st.environmental).toBeUndefined(); // THE split: not infra
    expect(st.outputTail).toContain('STAGE TIMEOUT');
    expect(st.outputTail).toContain('not classified environmental');
    // Not blind-retried: reap preamble (1) + exactly ONE stage attempt — no
    // second attempt for a timeout (attempt 0 breaks the loop).
    expect(exec).toHaveBeenCalledTimes(2);
  });

  test('the ticket ACCEPTANCE TEST: a simulated low-memory run (exit 137, zero diagnostics) stays ENV-classified and is NOT a code failure', async () => {
    const exec = oomKillExec();
    const r = await runVerifyChain(exec as any, wt, CHAIN, 120_000);
    expect(r.passed).toBe(false);
    expect(r.ran).toBe(true);
    const st = r.stages.find((s) => s.key === 'typecheck')!;
    expect(st.environmental).toBe(true); // env class intact
    expect(st.stageTimeout).toBeUndefined();
    expect(st.outputTail).toContain('ENVIRONMENTAL');
    // Retried exactly once: preamble + 2 attempts.
    expect(exec).toHaveBeenCalledTimes(3);
  });

  test('a timeout parks NO env-red verdict (it would mislabel a possible code defect as infra)', async () => {
    await runVerifyChain(timeoutKillExec() as any, wt, CHAIN, 120_000);
    expect(consumeEnvironmentalRed(wt)).toBeNull();
  });

  test('an OOM death still parks the env-red verdict (the 2026-09-10 honesty, unchanged)', async () => {
    await runVerifyChain(oomKillExec() as any, wt, CHAIN, 120_000);
    const env = consumeEnvironmentalRed(wt);
    expect(env).not.toBeNull();
    expect(env!.stage).toBe('typecheck');
    expect(env!.exitCode).toBe(137);
  });
});
