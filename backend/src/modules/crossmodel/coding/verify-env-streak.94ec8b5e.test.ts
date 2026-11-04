/**
 * Ticket 94ec8b5e — mishap replay: a 3× verify-failure streak on session
 * 69752ea3 (run 5e0a6aa0, 2026-10-08 23:38–00:12Z) while it built ticket
 * 4e75cdea (Mac agent self-update). The breaker tripped on a MIXED streak —
 * one code red followed by two environmental deaths of the SAME tool — and
 * this suite pins that every leg was classified exactly per design:
 *
 *   1. typecheck exit 2 with the TS2339 diagnostics
 *      (agent-release.4e75cdea.test.ts(207/208/219,16): Property 'body' does
 *      not exist on type 'Response<…>') — a REAL code red on the session's
 *      OWN UNCOMMITTED DRAFT: its first commit a08cba110 landed 00:25Z, ~47 min
 *      AFTER the 23:38Z red; the draft's fakeRes() helper was typed
 *      `Response<…>` at those line numbers, while the version merged as PR
 *      #1366 (squash eb0914a55, 02:24Z) annotates the helper `: any` — on
 *      main, lines 207/208/219 are blank/`it(` headers and the res.body
 *      asserts sit at 205/216/217. Marker present + output present ⇒ NOT
 *      environmental, no retry — the chain never whitewashes a real red.
 *   2. + 3. typecheck "exit 1" with the tail
 *      `[ENVIRONMENTAL] stage terminated without an exit code (the wrapper
 *      shell died before the tool reported an exit code (external
 *      SIGKILL/OOM)); zero diagnostics` ×2 — the wrapper shell (7c5745d4
 *      class) died before the `__DIGBY_EXIT__` echo under a FLEET-WIDE memory
 *      window: loop_metrics verify_env_red shows 24 rows in 4h across six
 *      chats (69752ea3, a6248463, 65e10199, 5f90c628, c7419649, c9f7ac07),
 *      this session's at 00:00:23Z / 00:12:28Z matching the ticket legs to
 *      the millisecond. The "exit 1" is the missing-marker DEFAULT, not a tsc
 *      verdict — the stage had NO marker and NO output at all.
 *
 * Adjudication (2026-10-09): harness AS DESIGNED, model behavior + infra —
 * NOT a deterministic framework defect. The streak keys on the tool name, so
 * a code red followed by environmental deaths of the same `verify` tool is
 * ONE legitimate 3× trip (the 0e7eae65 mixed-shape rule). The session
 * self-healed per the 2026-09-10 doctrine: fixed its draft, and PR #1366
 * (4e75cdea) merged green at 02:24:52Z — main typechecks clean.
 *
 * What this suite pins (the classification this disposition rests on):
 *   (a) REPLAY leg 1: exit 2 with real TS diagnostics is a code red — no
 *       environmental flag, no retry, no whitewash (the 9c1ed093 leg-3 rule,
 *       replayed on this ticket's own bytes);
 *   (b) REPLAY legs 2-3: an empty-output typecheck with NO exit marker is
 *       terminated+ENVIRONMENTAL, retried exactly once, surfaced with the
 *       literal ticket tail and the external-SIGKILL/OOM cause;
 *   (c) the "exit 1" a terminated stage reports is the missing-marker default
 *       — 1, not a tool verdict (the subtle point that makes the ticket's
 *       legs 2-3 infra, not code);
 *   (d) the recovery: the same stage green on a cooled box passes clean —
 *       the re-run scenario that disproved every red.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { runVerifyChain } from './verify.service';

const TYPECHECK: [{ key: string; command: string }] = [{ key: 'typecheck', command: 'npx tsc --noEmit' }];

beforeEach(() => {
  process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
});

/** Leg 1 — the ticket's literal code red: exit 2, real TS2339 diagnostics. */
const TS2339_RED = [
  'src/modules/crossmodel/imessage/agent-release.4e75cdea.test.ts(207,16): error TS2339: Property \'body\' does not exist on type \'Response<any, Record<string, any>>\'.',
  'src/modules/crossmodel/imessage/agent-release.4e75cdea.test.ts(208,16): error TS2339: Property \'body\' does not exist on type \'Response<any, Record<string, any>>\'.',
  'src/modules/crossmodel/imessage/agent-release.4e75cdea.test.ts(219,16): error TS2339: Propert',
].join('\n');

describe('verify mixed-streak replay (ticket 94ec8b5e — one code red + two environmental deaths, same tool)', () => {
  it('REPLAY leg 1: typecheck exit 2 with real TS diagnostics is a CODE red — no environmental flag, no in-chain retry, no whitewash', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                        // the orphan reap / cgroup read — always call #1
      .mockResolvedValueOnce({ stdout: `${TS2339_RED}\n__DIGBY_EXIT__ 2`, stderr: '' });
    const r = await runVerifyChain(exec as any, '/wt', TYPECHECK, 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('typecheck');
    expect(exec).toHaveBeenCalledTimes(2);                                      // reap + ONE attempt — the environmental retry does NOT fire
    const st = r.stages[0];
    expect(st.environmental).toBeFalsy();                                       // marker + output = a real failure
    expect(st.terminated).toBeUndefined();
    expect(st.exitCode).toBe(2);
    expect(st.outputTail).toContain('error TS2339');
    expect(st.outputTail).toContain('agent-release.4e75cdea.test.ts(207,16)');
    expect(st.outputTail).not.toContain('[ENVIRONMENTAL]');
  });

  it('REPLAY legs 2-3: typecheck with NO marker and ZERO output (the wrapper shell died — external SIGKILL/OOM) is terminated+environmental, retried once, surfaced with the literal ticket tail', async () => {
    const killed = { stdout: '', stderr: '' };                                  // no marker anywhere, zero diagnostics
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                        // reap
      .mockResolvedValueOnce(killed)                                            // attempt 1: wrapper died before the echo
      .mockResolvedValueOnce(killed);                                           // attempt 2: still under pressure
    const r = await runVerifyChain(exec as any, '/wt', TYPECHECK, 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('typecheck');
    expect(exec).toHaveBeenCalledTimes(3);                                      // reap + exactly ONE in-chain retry
    const st = r.stages[0];
    expect(st.terminated).toBe(true);
    expect(st.environmental).toBe(true);
    // The subtle adjudication point: the ticket's "exit 1" is the missing-marker
    // DEFAULT, never a tsc verdict.
    expect(st.exitCode).toBe(1);
    expect(st.outputTail).toBe('[ENVIRONMENTAL] stage terminated without an exit code (the wrapper shell died before the tool reported an exit code (external SIGKILL/OOM)); zero diagnostics — infra, NOT a code failure. Retried once; retry the verify later rather than "fixing" code.');
  });

  it('the same mixed sequence cannot flip a code red into environmental: the TS red keeps its verdict even when the NEXT stage call dies empty (one chain, ordered)', async () => {
    // Legs arrive as separate verify calls in the real run; within ONE chain
    // the first real red fail-fasts the rest — pin that ordering too.
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                        // reap
      .mockResolvedValueOnce({ stdout: `${TS2339_RED}\n__DIGBY_EXIT__ 2`, stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                       // would-be leg 2 — never reached
    const r = await runVerifyChain(exec as any, '/wt', TYPECHECK, 1000);
    expect(r.passed).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);                                      // fail-fast: the code red ends the chain
    expect(r.stages[0].environmental).toBeFalsy();
  });

  it('the ticket recovery: the same typecheck stage green on a cooled box passes the chain clean (the re-run that disproved every red)', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                        // reap
      .mockResolvedValueOnce({ stdout: '__DIGBY_EXIT__ 0', stderr: '' });       // tsc clean
    const r = await runVerifyChain(exec as any, '/wt', TYPECHECK, 1000);
    expect(r.passed).toBe(true);
    expect(r.stages[0].environmental).toBeUndefined();
    expect(r.stages[0].terminated).toBeUndefined();
  });

  it('ROOT-CAUSE pin: the merged main helper this mishap red-flagged is `: any`-typed (agent-release.4e75cdea.test.ts fakeRes) and main typechecks — the red was a pre-merge draft, never merged code', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const file = path.resolve(__dirname, '../imessage/agent-release.4e75cdea.test.ts');
    expect(fs.existsSync(file)).toBe(true);                                     // shipped as PR #1366 (squash eb0914a55)
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toMatch(/function fakeRes\(\): any \{/);                        // the `any` the draft lacked
    // And the exact lines the ticket cited (207/208/219) are NOT res.body
    // asserts on main — they shifted when the draft was fixed pre-merge.
    const lines = src.split('\n');
    for (const n of [207, 208, 219]) {
      expect(lines[n - 1]).not.toMatch(/res\.body/);
    }
  });
});
