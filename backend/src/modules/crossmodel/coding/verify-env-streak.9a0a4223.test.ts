/**
 * Ticket 9a0a4223 — mishap replay: a 3× verify-failure streak on lane b92ef13f
 * (run 13b4279d, 2026-09-22 00:29–00:44Z) under peer-lane memory pressure in the
 * shared dev container (cgroup 12,881,997,824/12,884,901,888 = 99.98%, oom_kill
 * 269). The breaker tripped on THREE harness-reported verify reds that were all
 * environmental, never code:
 *
 *   1. typecheck: exit 137, output tail literally "Killed" (SIGKILL — the OOM
 *      killer took the tsc child; the wrapper survived to echo the marker);
 *   2. test:related ×2: a PASS-stream cut off MID-WORD ("PASS src/modul"), no
 *      FAILED/ERROR lines, no summary, no exit marker — the 16 MiB capture
 *      kill shape (7c5745d4 class).
 *
 * Every suite involved passed solo in the same worktree, and the full chain was
 * green in a clean window the same night — the reds existed only under cgroup
 * pressure. Adjudication (ticket adminNote 2026-09-22T01:03Z): harness AS
 * DESIGNED (the breaker fired on truthful environmental reds); the failures
 * were infra. The durable fixes this file pins:
 *   (a) exit 137 with the marker ⇒ ENVIRONMENTAL (one in-chain retry), never a
 *       code red — the 2026-09-10 OOM-herd predicate;
 *   (b) a truncated PASS-stream with NO marker ⇒ terminated+ENVIRONMENTAL with
 *       the CAPTURE INCOMPLETE cause note — ticket 7c5745d4's fix (PR #960);
 *   (c) the verify chain's full-jest stage is worker-capped (--maxWorkers=2)
 *       so one lane's verify cannot OOM the shared cgroup — ticket e4edffa3's
 *       root-cause fix (PR #957), the suggestion-(a) half this mishap asked for.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as path from 'path';
import { runVerifyChain, readDigbyConfig } from './verify.service';
import { isExportTree } from '../../../utils/export-mode';

// The chain runs a related-tests-first git listing before a 'test' stage;
// answer it empty here (nothing derivable => the full stage runs as before) so
// `exec` sees only the reap and the legs (verify-related.test.ts covers the
// related-first pass itself).
const noGit = (exec: jest.Mock): any => (cmd: string, ...rest: any[]) =>
  /^(?:git diff|B=\$\(git merge-base)/.test(cmd) ? Promise.resolve({ stdout: '', stderr: '' }) : exec(cmd, ...rest);

beforeEach(() => {
  process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
});

/** The ticket's literal middle failure: "✗ typecheck (exit 137)" + tail "Killed". */
const TSC_KILLED = { stdout: 'Killed\n__DIGBY_EXIT__ 137', stderr: '' };

/** The ticket's literal test:related failures: a PASS stream cut mid-word, no marker. */
const TRUNCATED_JEST = [
  'PASS src/modules/crossmodel/coding/agent-derail-break.f95bd4c8.test.ts',
  'PASS src/modules/crossmodel/coding/agent-k3-conformance.22c309f4.test.ts',
  'PASS src/modules/crossmodel/coding/agent-derail-break.d50a6300.test.ts',
  'PASS src/modul',
].join('\n');

describe('verify environmental streak replay (ticket 9a0a4223 — infra reds must never classify as code)', () => {
  it('REPLAY leg 1: typecheck exit 137 with the "Killed" tail (marker present) is environmental, retried once, NOT terminated, no CAPTURE note', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // the orphan reap — always call #1
      .mockResolvedValueOnce(TSC_KILLED)                 // attempt 1: OOM SIGKILL
      .mockResolvedValueOnce(TSC_KILLED);                // attempt 2: still under pressure
    const r = await runVerifyChain(exec as any, '/wt', [{ key: 'typecheck', command: 'npx tsc --noEmit' }], 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('typecheck');
    expect(exec).toHaveBeenCalledTimes(3);               // reap + exactly ONE in-chain retry
    const st = r.stages[0];
    expect(st.environmental).toBe(true);
    expect(st.terminated).toBeUndefined();               // the marker survived — exit 137 is a real (infra) exit
    expect(st.exitCode).toBe(137);
    expect(st.outputTail).toContain('Killed');
    expect(st.outputTail).not.toContain('CAPTURE INCOMPLETE');
  });

  it('REPLAY leg 2: a test stage whose PASS stream is cut mid-word with NO exit marker (the 16 MiB capture kill) is terminated+environmental with the CAPTURE INCOMPLETE cause note', async () => {
    const killed = { stdout: TRUNCATED_JEST, stderr: '\n[exit: ERR_CHILD_PROCESS_STDIO_MAXBUFFER]' };
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce(killed)
      .mockResolvedValueOnce(killed);
    const r = await runVerifyChain(noGit(exec), '/wt', [{ key: 'test', command: 'npx jest' }], 1000);
    expect(r.passed).toBe(false);
    expect(exec).toHaveBeenCalledTimes(3);               // reap + exactly ONE retry — never a fail-fast code red
    const st = r.stages[0];
    expect(st.terminated).toBe(true);
    expect(st.environmental).toBe(true);
    expect(st.exitCode).toBe(1);                         // the missing-marker default, NOT a test verdict
    expect(st.outputTail).toContain('[CAPTURE INCOMPLETE — no exit marker:');
    expect(st.outputTail).toContain('capture buffer');
    expect(st.outputTail).toContain('NOT a test verdict');
    expect(st.outputTail).toContain(TRUNCATED_JEST.split('\n')[0]); // the stream is preserved below the note
  });

  it('the ticket recovery: the same stages green on a cooled box PASS the chain clean (the solo re-run scenario that disproved every red)', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                    // reap
      .mockResolvedValueOnce({ stdout: '__DIGBY_EXIT__ 0', stderr: '' });   // typecheck clean
    const r = await runVerifyChain(exec as any, '/wt', [{ key: 'typecheck', command: 'npx tsc --noEmit' }], 1000);
    expect(r.passed).toBe(true);
    expect(r.stages[0].environmental).toBeUndefined();
    expect(r.stages[0].terminated).toBeUndefined();
  });

  it('ROOT-CAUSE pin (e4edffa3, PR #957): every jest the lane test stage can spawn is worker-capped --maxWorkers=2 (b73b1460: the cap moved from the config string into the verify-scoped wrapper)', async () => {
    const root = path.resolve(__dirname, '../../../../..');
    // EXPORT TREE (todo 13069ce2, 2026-11-05): `.digby/config.json` is dropped by
    // the public export, so this read is null for a tree reason, not a verify
    // regression. Assert the ABSENCE — that keeps a pin in both trees and fails
    // if an export ever ships the private config.
    if (isExportTree(root)) {
      expect(await readDigbyConfig(root)).toBeNull();
      return;
    }
    const config = await readDigbyConfig(root);
    expect(config).not.toBeNull();
    const testCmd = config?.commands?.test ?? '';
    const testOneCmd = config?.commands?.testOne ?? '';
    const typecheckCmd = config?.commands?.typecheck ?? '';
    // The scoped chain: jest runs behind backend/src/scripts/verify-scoped.ts.
    // The wrapper's spawn argsets (full/smoke/scoped) carry the cap — pinned in
    // verify-scoped.test.ts; here pin that the chain really routes through the
    // wrapper (a bare `npx jest` command string would be UNCAPPED again).
    expect(testCmd).toContain('verify-scoped.ts --stage test');
    expect(testCmd).not.toMatch(/\bnpx\s+jest\b/); // review F6: ANY bare npx jest in the config string would be an UNCAPPED spawn
    expect(testOneCmd).not.toMatch(/maxWorkers/);
    expect(typecheckCmd).not.toMatch(/maxWorkers/);
  });
});
