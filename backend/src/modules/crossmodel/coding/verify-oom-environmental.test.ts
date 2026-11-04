/**
 * Replay pin for feedback tickets db25c401 + 5a4e47ce (duplicate root cause) —
 * "Coding workspace tsc OOM-killed by the 4 GiB cgroup limit — masquerades as
 * a typecheck failure with empty diagnostics" / "Shared coding container 4 GiB
 * cgroup OOMs under concurrent tsc legs — verify chains blocked fleet-wide".
 *
 * The mishap: in the shared dev container, co-tenant verify chains pinned the
 * 4 GiB cgroup (memory.current ≥99.5% of memory.max for hours; oom_kill
 * 70→159/day). The OOM killer SIGKILLed `tsc --noEmit` — exit 137, a bare
 * "Killed" line or ZERO output, no compiler diagnostics — which the verify
 * chain reported as a red "typecheck failed", driving fruitless fix-loops on
 * byte-identical code and refusing PR verify gates fleet-wide (PR #647's
 * watcher never got an exit-0 tsc all session; PR #646 blocked per 5a4e47ce).
 *
 * What shipped on main c03ab2724: 12g container, heap-capped verify legs
 * (NODE_OPTIONS=--max-old-space-size=2048 — later found to be a POSIX no-op
 * on `cd X &&` legs and made real at 4096, ticket 7fbc34cd), a >30-min
 * pre-chain orphan reap,
 * and ENVIRONMENTAL classification (exit 137 or empty output, one in-chain
 * retry, "NOT a code failure" labeling). This file pins THE TICKETS' exact
 * failure signatures against that shipped surface so the masquerade can never
 * silently return. The complementary hardening on this branch (env-tunable
 * ceiling via CODING_DEV_CONTAINER_MEMORY, live-grow of legacy containers, and
 * the run-start worktree-scoped orphan reaper) is pinned in
 * dev-container.service.test.ts and container.service.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runVerifyChain } from './verify.service';

const CHAIN = [
  { key: 'typecheck', command: 'cd backend && npx tsc --noEmit' },
  { key: 'lint', command: 'cd backend && npx eslint .' },
  { key: 'test', command: 'cd backend && npx jest' },
];

beforeEach(() => {
  // Keep the guard's one in-chain retry far under jest's 5s default timeout.
  process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
});

const out = (text: string, code: number) => ({ stdout: `${text}\n__DIGBY_EXIT__ ${code}`, stderr: '' });

describe('tickets db25c401 + 5a4e47ce: the OOM masquerade can never read as a code red again', () => {
  it('db25c401 signature: tsc SIGKILLed (exit 137) with ZERO diagnostics fails ENVIRONMENTAL, never as a typecheck red', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })   // pre-chain reap
      .mockResolvedValueOnce(out('', 137))                 // attempt 1: OOM kill, empty
      .mockResolvedValueOnce(out('', 137));                // in-chain retry: still OOM
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('typecheck');
    expect(r.stages).toHaveLength(1); // fail-fast — lint/test never ran
    expect(r.stages[0].exitCode).toBe(137);
    expect(r.stages[0].environmental).toBe(true);
    expect(r.stages[0].outputTail).toContain('ENVIRONMENTAL');
    expect(r.stages[0].outputTail).toContain('NOT a code failure');
    expect(exec).toHaveBeenCalledTimes(3); // reap + exactly one retry
  });

  it('5a4e47ce signature: heap-capped tsc leg dies at 137 mid-herd → leg carried the heap cap AND fails environmental', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(out('', 137))
      .mockResolvedValueOnce(out('', 137));
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(String(exec.mock.calls[0][0])).toContain('pgrep -f "tsc --noEmit|node_modules/.bin/jest"'); // the >30-min pre-chain reap
    expect(String(exec.mock.calls[1][0])).toContain('export NODE_OPTIONS="--max-old-space-size=4096"');
    expect(r.stages[0].environmental).toBe(true);
  });

  it('a REAL typecheck failure always wins: "error TS" diagnostics → no environmental flag, no retry, diagnostics preserved', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(out("src/foo.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", 2));
    const r = await runVerifyChain(exec as any, '/wt', CHAIN, 1000);
    expect(r.passed).toBe(false);
    expect(r.stages[0].environmental).toBeUndefined();
    expect(r.stages[0].outputTail).toContain('error TS2322');
    expect(exec).toHaveBeenCalledTimes(2); // reap + one leg — no retry on real reds
  });

  it('the 127 missing-tool lane (v1#30 unverified) is never mislabeled environmental', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(out('bash: npx: command not found', 127));
    const r = await runVerifyChain(exec as any, '/wt', CHAIN.slice(0, 1), 1000);
    expect(r.stages[0].skipped).toBe(true);
    expect(r.stages[0].environmental).toBeUndefined();
    expect(r.passed).toBe(true); // a missing tool cannot fail the chain
    expect(r.unverified).toBe(true);
  });
});
