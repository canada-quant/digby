/**
 * Environmental infra-red honesty (2026-09-10, follow-on to the OOM-herd fix):
 * the chain's `environmental` verdict previously died inside verify.service —
 * the recorded state, the telemetry, and the auto-verify feedback all treated
 * an OOM/SIGKILL death exactly like a code red. Pins the three surfaces:
 *   1. PERSIST — recordVerify carries environmental:true for an environmental
 *      failing stage (relayed chain → captureVerifyFingerprint → record; the
 *      chain knows the stage, only the record knows the sessionId), so the PR
 *      gate and the next firing can tell infra-red from code-red;
 *   2. TELEMETRY — exactly ONE loop_metrics row (kind verify_env_red) per
 *      environmental stage failure, with sessionId + meta {stage, exitCode};
 *   3. FEEDBACK — renderVerifyFeedback says infra / code NOT implicated /
 *      retry-later for an environmental stage instead of "Fix the underlying
 *      cause", which drove code edits on byte-identical code (db25c401).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// In-memory context store: recordVerify/getVerifyState round-trip for real.
const memStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => memStore.get(`${ns.join('/')}/${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { memStore.set(`${ns.join('/')}/${key}`, value); }),
}));

// Telemetry boundary: verify.service reaches loop-metrics via dynamic import
// (env-free-leaf convention) — jest.mock intercepts that import too.
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...args: any[]) => mockRecordLoopMetric(...args),
  LOOP_METRIC_KINDS: { VERIFY_ENV_RED: 'verify_env_red' },
}));

import { runVerifyChain, renderVerifyFeedback } from './verify.service';
import { captureVerifyFingerprint, getVerifyState, recordVerify } from './verify-state';
import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const CHAIN = [{ key: 'typecheck', command: 'npx tsc --noEmit' }];
const out = (text: string, code: number) => ({ stdout: `${text}\n__DIGBY_EXIT__ ${code}`, stderr: '' });

// reap preamble + two SIGKILLed attempts (the in-chain retry) = environmental red
const envFailExec = () => jest.fn()
  .mockResolvedValueOnce({ stdout: '', stderr: '' })
  .mockResolvedValueOnce(out('', 137))
  .mockResolvedValueOnce(out('', 137));

const codeFailExec = () => jest.fn()
  .mockResolvedValueOnce({ stdout: '', stderr: '' })
  .mockResolvedValueOnce(out("src/foo.ts(3,7): error TS2322: nope", 2));

const passExec = () => jest.fn()
  .mockResolvedValueOnce({ stdout: '', stderr: '' })
  .mockResolvedValueOnce(out('', 0));

describe('environmental infra-red: persistence + telemetry + feedback', () => {
  let wt: string;

  beforeEach(async () => {
    process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
    memStore.clear();
    mockRecordLoopMetric.mockClear();
    // Real git repo: captureVerifyFingerprint takes real sha/tree reads, and the
    // relay only rides a non-null fingerprint.
    wt = await fs.mkdtemp(path.join(os.tmpdir(), 'venvred-wt-'));
    const g = (args: string[]) => execFileSync('git', args, { cwd: wt, stdio: 'pipe' });
    g(['init', '-q', '-b', 'digby/x']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 't']);
    await fs.writeFile(path.join(wt, 'a.txt'), 'v1\n');
    g(['add', '.']);
    g(['commit', '-qm', 'c1']);
  });

  afterEach(async () => {
    await fs.rm(wt, { recursive: true, force: true });
  });

  it('round-trips environmental:true through chain → fingerprint → record → state, and the verdict is consumed exactly once', async () => {
    const r = await runVerifyChain(envFailExec() as any, wt, CHAIN, 1000);
    expect(r.stages[0].environmental).toBe(true);
    const fp = await captureVerifyFingerprint(wt);
    expect(fp!.environmental).toEqual({ stage: 'typecheck', exitCode: 137 });
    await recordVerify('sess-env', r.passed, r.failedStage || undefined, { fingerprint: fp });
    expect(await getVerifyState('sess-env')).toMatchObject({
      passed: false, failedStage: 'typecheck', environmental: true,
    });
    // Consumed on pickup: a second capture on the same worktree carries nothing.
    expect((await captureVerifyFingerprint(wt))!.environmental).toBeUndefined();
  });

  it('emits exactly ONE verify_env_red metric per environmental failure, with sessionId + {stage, exitCode}', async () => {
    const r = await runVerifyChain(envFailExec() as any, wt, CHAIN, 1000);
    await recordVerify('sess-env', r.passed, r.failedStage || undefined, {
      fingerprint: await captureVerifyFingerprint(wt),
    });
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith({
      kind: 'verify_env_red',
      sessionId: 'sess-env',
      meta: { stage: 'typecheck', exitCode: 137 },
    });
  });

  it('a CODE red records NO environmental flag and emits NO metric', async () => {
    const r = await runVerifyChain(codeFailExec() as any, wt, CHAIN, 1000);
    expect(r.stages[0].environmental).toBeUndefined();
    await recordVerify('sess-env', r.passed, r.failedStage || undefined, {
      fingerprint: await captureVerifyFingerprint(wt),
    });
    const vs = await getVerifyState('sess-env');
    expect(vs).toMatchObject({ passed: false, failedStage: 'typecheck' });
    expect(vs!.environmental).toBeUndefined();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('a stranded verdict (flow died between chain and record) cannot mislabel the NEXT chain outcome on the same worktree', async () => {
    // Env-fail parks a verdict but the flow "crashes" before capture …
    await runVerifyChain(envFailExec() as any, wt, CHAIN, 1000);
    // … the next chain's own terminal outcome replaces it: a code red must
    // record as code-red (no flag, no metric).
    const r = await runVerifyChain(codeFailExec() as any, wt, CHAIN, 1000);
    await recordVerify('sess-env', r.passed, r.failedStage || undefined, {
      fingerprint: await captureVerifyFingerprint(wt),
    });
    expect((await getVerifyState('sess-env'))!.environmental).toBeUndefined();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('a PASS clears a stranded verdict and a passing record is never flagged', async () => {
    await runVerifyChain(envFailExec() as any, wt, CHAIN, 1000); // stranded
    const r = await runVerifyChain(passExec() as any, wt, CHAIN, 1000);
    await recordVerify('sess-env', r.passed, undefined, {
      fingerprint: await captureVerifyFingerprint(wt),
    });
    const vs = await getVerifyState('sess-env');
    expect(vs).toMatchObject({ passed: true });
    expect(vs!.environmental).toBeUndefined();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});

describe('renderVerifyFeedback: infra-red vs code-red honesty', () => {
  beforeEach(() => {
    process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
  });

  it('an ENVIRONMENTAL stage gets infra feedback: code NOT implicated, retry later / other work — never "fix the cause"', async () => {
    const r = await runVerifyChain(envFailExec() as any, '/wt', CHAIN, 1000);
    const fb = renderVerifyFeedback(r, 1, 10);
    expect(fb).toContain('ENVIRONMENTAL');
    expect(fb).toContain('NOT implicated');
    expect(fb).toContain('Do NOT edit code');
    expect(fb).toContain('Retry verify later');
    expect(fb).not.toContain('Fix the underlying cause above and continue');
  });

  it('a code red keeps the fix-it feedback unchanged', async () => {
    const r = await runVerifyChain(codeFailExec() as any, '/wt', CHAIN, 1000);
    const fb = renderVerifyFeedback(r, 2, 10);
    expect(fb).toContain('[AUTO-VERIFY FAILED] stage: typecheck (exit 2) · attempt 2/10');
    expect(fb).toContain('Fix the underlying cause above and continue');
    expect(fb).not.toContain('ENVIRONMENTAL');
  });
});
