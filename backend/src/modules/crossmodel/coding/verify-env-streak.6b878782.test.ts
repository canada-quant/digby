/**
 * Ticket 6b878782 — mishap replay: a 3× verify tool-failure streak on session
 * cd1d922b (run 0bfe6335, 2026-10-09 17:33–18:39Z) while it built ticket 4e74f0bb
 * (model-pick latency evidence recency arm — the TTFT regression). The breaker
 * filed at 18:39:43Z, one second after the third leg landed.
 *
 * The streak's three legs, exactly as filed (newest first):
 *
 *   3. `Tool "verify" exceeded 900s and was aborted. Do not retry it; …` —
 *      the 15-min hard-timeout race firing on a call that was still running
 *      (the verify receipt 45a418f8 landed at 18:39:42Z, 15 min after the
 *      18:24:36Z run_command that preceded it);
 *   2. `Verify FAILED at "typecheck"` with the tail
 *      `[ENVIRONMENTAL] stage terminated without an exit code (the wrapper
 *      shell died before the tool reported an exit code (external
 *      SIGKILL/OOM)); zero diagnostics` — receipt 95b5e6c5 at 17:45:08Z, the
 *      7c5745d4 wrapper-death class (no `__DIGBY_EXIT__` marker, zero output);
 *   1. the same abort text again — receipt a0e52f24 at 17:33:12Z, 15 min
 *      after the 17:18:00Z open_pull_request attempt that preceded it.
 *
 * Adjudication (2026-10-10, this lane):
 *   · BREAKER AS DESIGNED — the streak keys on the tool name, and a mixed
 *     streak (two hard-timeout aborts + one environmental red of the same
 *     `verify` tool) is ONE legitimate 3× trip: every leg IS a failure-shaped
 *     result (learnings-index FAILURE_MARKERS matches both texts — replayed
 *     below), and the doctrine the breaker executes (2026-09-10: self-heal +
 *     attribute, never just escalate) is exactly what happened next:
 *   · MODEL SELF-HEALED — the same run went green at 21:15:14Z (receipt
 *     56903131, `passed: true`), opened PR #1385, merged it (squash
 *     e6d47c9183d9, deploy run 37993320198) and closed 4e74f0bb with full
 *     evidence — the run completed at 21:53:16Z with error: null.
 *   · NOT a NEW deterministic framework defect in THIS streak's texts:
 *     `git log -S` on both literal failure texts since 2026-10-01 returns
 *     empty — no framework change authored them (the ticket's "diff the
 *     failure texts against recent framework changes" leg, executed).
 *   · BUT the capacity CLASS the two aborts + the environmental red share —
 *     N lanes' verify chains stacking in ONE shared dev container until the
 *     memory-cgroup OOM killer SIGKILLs tsc/jest (kills at 17:30, 19:21,
 *     19:24Z — this streak's window) — WAS a real framework gap, fixed hours
 *     after the filing by commit f4448a999 ("per-container verify-chain slot
 *     limit — box C cgroup OOM", build 2026-10-09 VS; committed
 *     2026-10-10T01:20:08Z — its git face "2026-10-09 18:20:08 -0700" is the
 *     Pacific local face, NOT UTC), whose message cites this exact ticket
 *     shape ("3x tool-failure-streak tickets"). The fix landed ~39 min BEFORE
 *     this lane was dispatched (2026-10-10T01:58:59Z), so the ticket reached
 *     the lane already solved at the CLASS level (the incident itself was
 *     live while the fix was still being built). This suite pins that fix's
 *     two relevant mechanics so the class stays closed.
 *
 * What this suite pins (the disposition this ticket rests on):
 *   (a) REPLAY leg 3 + leg 1: the hard-timeout abort text — with NOTHING
 *       queued reported — fires at exactly 15 min and IS failure-shaped
 *       (the breaker's arithmetic is correct; this streak was a true trip);
 *   (b) REPLAY leg 2: a typecheck stage with NO exit marker and ZERO output
 *       is terminated+environmental, retried once, surfaced with the literal
 *       ticket tail — "exit 1" is the missing-marker default, never a tsc
 *       verdict (the subtle point that makes leg 2 infra, not code);
 *   (c) the mixed-streak rule: the three filed texts, replayed through
 *       looksLikeToolFailure in filed order, all read as failures — one
 *       legitimate 3× trip, not a miscount;
 *   (d) ROOT-CAUSE pin: the shipped capacity fix — box C's dev-container cap
 *       (24 499 638 272 B) admits exactly 3 concurrent verify chains
 *       (floor(cap × 0.75 / 5 GiB)), and the hard-timeout race re-arms by
 *       queued ms so a verify merely WAITING for a slot is never answered
 *       "exceeded 900s" — both halves of what produced legs 1 and 3;
 *   (e) the recovery: the same stage green on a cooled box passes the chain
 *       clean — the re-run that ended the streak (21:15:14Z, passed: true);
 *   (f) the self-heal's artifact: the recovered lane's own replay tests
 *       (model-evidence.recency.4e74f0bb.test.ts, shipped in PR #1385) exist
 *       on this branch and cite 4e74f0bb — the work the streak interrupted
 *       still landed, verified.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The breaker's failure classifier (learnings-index.service) is NOT an env-free
// leaf — it drags memory + loop-metrics into its import graph (see
// learnings-index.1ad6f358.test.ts for the same mock stack). Mock those, then
// import the pure classifier.
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => 1),
  memSearch: jest.fn(async () => []),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { INDEX_SWEPT: 'index_swept' },
}));

import { raceToolHardTimeout } from './tool-hard-timeout';
import { looksLikeToolFailure } from './learnings-index.service';
import { runVerifyChain } from './verify.service';
import { verifySlotsForCap, VERIFY_STAGE_PEAK_BYTES, VERIFY_SLOT_HEADROOM } from './verify-container-slots';

const TYPECHECK: [{ key: string; command: string }] = [{ key: 'typecheck', command: 'cd backend && npx tsc --noEmit' }];

/** The 15-min hard timeout the abort text renders from (agent.ts). */
const HARD = 15 * 60 * 1000;
/** The ticket's literal abort text — legs 1 and 3, verbatim. */
const ABORT = 'Tool "verify" exceeded 900s and was aborted. Do not retry it; proceed with what you have.';

beforeEach(() => {
  process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.VERIFY_ENV_RETRY_BACKOFF_MS;
});

const out = (text: string, code: number) => ({ stdout: `${text}\n__DIGBY_EXIT__ ${code}`, stderr: '' });

function never<T>(): Promise<T> { return new Promise<T>(() => { /* a tool still running */ }); }

describe('verify mixed-streak replay (ticket 6b878782 — two hard-timeout aborts + one environmental red, same tool)', () => {
  it('(a) REPLAY legs 1+3: nothing queued ⇒ the hard-timeout race aborts at exactly 15 min with the literal ticket text', async () => {
    const fired = raceToolHardTimeout(never<string>(), HARD, () => ABORT, () => 0);
    let settled: string | undefined;
    void fired.then(v => { settled = v; });
    await jest.advanceTimersByTimeAsync(HARD - 1);
    expect(settled).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(ABORT);
  });

  it('(a) REPLAY legs 1+3: the abort text IS failure-shaped — the breaker counted real failures, never a miscount', () => {
    expect(looksLikeToolFailure(ABORT)).toBe(true);
  });

  it('(b) REPLAY leg 2: typecheck with NO marker and ZERO output (wrapper shell died — external SIGKILL/OOM) is terminated+environmental, retried once, surfaced with the literal ticket tail', async () => {
    jest.useRealTimers();
    const killed = { stdout: '', stderr: '' };                               // no marker anywhere, zero diagnostics
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                     // the orphan-reap / cgroup pre-flight probe — always call #1
      .mockResolvedValueOnce(killed)                                         // attempt 1: wrapper died before the echo
      .mockResolvedValueOnce(killed);                                        // attempt 2: still under pressure
    const r = await runVerifyChain(exec as any, '/wt', TYPECHECK, 1000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe('typecheck');
    expect(exec).toHaveBeenCalledTimes(3);                                   // probe + exactly ONE in-chain retry
    const st = r.stages[0];
    expect(st.terminated).toBe(true);
    expect(st.environmental).toBe(true);
    // The subtle adjudication point: the ticket's "exit 1" is the missing-marker
    // DEFAULT, never a tsc verdict.
    expect(st.exitCode).toBe(1);
    expect(st.outputTail).toBe('[ENVIRONMENTAL] stage terminated without an exit code (the wrapper shell died before the tool reported an exit code (external SIGKILL/OOM)); zero diagnostics — infra, NOT a code failure. Retried once; retry the verify later rather than "fixing" code.');
  });

  it('(c) REPLAY the filed order: the breaker texts — abort, environmental red, abort — ALL read as failures (one legitimate 3× trip)', () => {
    // Newest first as the ticket filed them; reverse to replay oldest → newest.
    const filed = [ABORT, `Verify FAILED at "typecheck": 1 failed\n--- typecheck output tail ---\n[ENVIRONMENTAL] stage terminated without an exit code (the wrapper shell died before the tool reported an exit code (external SIGKILL/OOM)); zero diagnostics — infra, NOT a code failure. Retried once; retry the verify later rather than "fixing" code.`, ABORT];
    for (const text of filed.reverse()) expect(looksLikeToolFailure(text)).toBe(true);
  });

  it('(d) ROOT-CAUSE pin: the box C dev-container cap (24 499 638 272 B) admits exactly 3 concurrent verify chains — the f4448a999 capacity fix for this streak class', () => {
    const BOX_C_CAP = 24_499_638_272;                                        // f4448a999: the incident container's memory.max
    expect(verifySlotsForCap(BOX_C_CAP)).toBe(3);                            // floor(22.8 GiB × 0.75 / 5 GiB)
    expect(VERIFY_STAGE_PEAK_BYTES).toBe(5 * 1024 ** 3);
    expect(VERIFY_SLOT_HEADROOM).toBe(0.25);
    expect(verifySlotsForCap(2 * 1024 ** 3)).toBe(1);                        // a scoped per-session container — min 1
    expect(verifySlotsForCap(256 * 1024 ** 3)).toBe(4);                      // max 4
  });

  it('(d) ROOT-CAUSE pin: a verify queued 10 min is never aborted — the hard timer re-arms by the queued ms the tool reported (the leg-1/leg-3 class, fixed)', async () => {
    let queued = 0;
    let resolveWork!: (v: string) => void;
    const work = new Promise<string>(r => { resolveWork = r; });
    const fired = raceToolHardTimeout(work, HARD, () => ABORT, () => queued);
    let settled: string | undefined;
    void fired.then(v => { settled = v; });
    // the slot gate reports its wait as it accrues (5 s polls), for 10 minutes
    for (let t = 0; t < 10 * 60_000; t += 5_000) { await jest.advanceTimersByTimeAsync(5_000); queued += 5_000; }
    await jest.advanceTimersByTimeAsync(12 * 60_000);                        // 22 min wall clock, 12 min of the tool's own time
    expect(settled).toBeUndefined();
    resolveWork('Verify passed');
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe('Verify passed');
  });

  it('(e) the recovery: the same typecheck stage green on a cooled box passes the chain clean (the 21:15:14Z re-run that ended the streak)', async () => {
    const exec = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                     // probe
      .mockResolvedValueOnce(out('', 0));                                    // tsc clean
    const r = await runVerifyChain(exec as any, '/wt', TYPECHECK, 1000);
    expect(r.passed).toBe(true);
    expect(r.stages[0].environmental).toBeUndefined();
    expect(r.stages[0].terminated).toBeUndefined();
  });

  it('(f) the self-heal artifact: the recovered 4e74f0bb replay tests shipped in PR #1385 exist on this branch and cite the ticket — the interrupted work landed, verified', async () => {
    const fs = await import('fs');
    const path = await import('path');
    for (const f of ['model-evidence.recency.4e74f0bb.test.ts', 'model-pick.recency.4e74f0bb.test.ts']) {
      const file = path.resolve(__dirname, '../platform/', f);
      expect(fs.existsSync(file)).toBe(true);                                // shipped as PR #1385 (squash e6d47c9183d9)
      expect(fs.readFileSync(file, 'utf8')).toContain('4e74f0bb');
    }
  });
});
