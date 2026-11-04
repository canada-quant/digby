/**
 * 2026-09-10 OOM-herd fix — environmental verify deaths (tickets: shared dev
 * container 4GiB cgroup, oom_kill 159/day, SIGKILLed tsc masquerading as red
 * typecheck and wedging every PR gate).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runVerifyChain } from './verify.service';

const CHAIN = [{ key: 'typecheck', command: 'cd backend && npx tsc --noEmit' }];

beforeEach(() => {
  process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
});

const out = (text: string, code: number) => ({ stdout: `${text}\n__DIGBY_EXIT__ ${code}`, stderr: '' });

describe('environmental verify deaths (OOM/SIGKILL)', () => {
  it('reaps ancient orphaned tsc/jest processes BEFORE the chain and heap-caps every leg', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // the reap
      .mockResolvedValueOnce(out('', 0));
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(true);
    expect(String(exec.mock.calls[0][0])).toContain('pgrep -f "tsc --noEmit|node_modules/.bin/jest"');
    expect(String(exec.mock.calls[0][0])).toContain('-gt 1800');
    expect(String(exec.mock.calls[1][0])).toContain('export NODE_OPTIONS="--max-old-space-size=4096"');
  });

  it('exit 137 retries ONCE in-chain; a clean second attempt passes with no environmental flag', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })   // reap
      .mockResolvedValueOnce(out('', 137))                 // SIGKILL, empty
      .mockResolvedValueOnce(out('', 0));                  // retry clean
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(true);
    expect(r.stages[0].environmental).toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('a PERSISTENT environmental death fails the stage labeled ENVIRONMENTAL — never as a code red', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(out('', 137))
      .mockResolvedValueOnce(out('', 137));
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('typecheck');
    expect(r.stages[0].environmental).toBe(true);
    expect(r.stages[0].outputTail).toContain('ENVIRONMENTAL');
    expect(r.stages[0].outputTail).toContain('NOT a code failure');
  });

  it('exit 1 with an EMPTY tail is also environmental (a real tool failure always prints)', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(out('', 1))
      .mockResolvedValueOnce(out('', 1));
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.stages[0].environmental).toBe(true);
  });

  it('a REAL red (non-zero WITH diagnostics) never retries and never gets the environmental label', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(out('src/x.ts(3,1): error TS2304: Cannot find name', 1));
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(false);
    expect(r.stages[0].environmental).toBeUndefined();
    expect(r.stages[0].outputTail).toContain('TS2304');
    expect(exec).toHaveBeenCalledTimes(2); // reap + one leg — no retry
  });
});
