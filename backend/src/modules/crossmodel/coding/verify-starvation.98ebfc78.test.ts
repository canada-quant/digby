/**
 * REPLAY for ticket 98ebfc78 — "3× tool-failure streak: verify on
 * 'ticket 2c7cee17: One-shot re-delivery ru' — framework or model?" (P0 mishap;
 * session 9b2f03fe, run af262b0c, breaker tripped 2026-10-09T19:20:32Z).
 *
 * THE STREAK (filed texts, newest first — all three on tool `verify`, call
 * args `{}` = the full chain, i.e. post-commit gates, never targeted retries):
 *   · `Tool "verify" exceeded 900s and was aborted. Do not retry it; proceed
 *     with what you have.`                                     (19:20:25Z)
 *   · `Verify FAILED at "typecheck": ✗ typecheck (exit 1)` + the
 *     `[ENVIRONMENTAL] stage terminated without an exit code (the wrapper
 *     shell died before the tool reported an exit code (external SIGKILL/OOM))`
 *     tail                                                      (18:09:13Z)
 *   · the same 900s abort text again                            (17:19:06Z)
 *
 * WHAT ACTUALLY HAPPENED (adjudicated against run af262b0c's receipts, not
 * narration): the lane's verify timeline was 15:12 FAILED-at-test (a real red
 * it fixed), 15:19 PASSED (receipt 6044bf86 — a same-tool success that reset
 * the streak), then the three filed failures. Between them the run banked ~50
 * successful run_command receipts and four commits (b8db23206, be6e55bfd,
 * be91e5a60, 981e089d5) — PRs #1378 (squash 15d6d26d2) and #1380 (squash
 * 4e3ff803f) both MERGED. Every verify call followed a fresh tree state: this
 * was never a same-args retry loop against "Do not retry" (the 21ee14ce
 * model-behavior class) — each call was a legitimate new gate.
 *
 * NOT a streak-machinery defect either: all three envelopes are real
 * harness-authored shapes (agent.ts's hard-timer backstop, verify.service's
 * ENVIRONMENTAL tail), so `looksLikeToolFailure` counted truthfully; the
 * ladder keys on tc.name='verify' and only a SAME-TOOL success resets it
 * (agent.ts), so the ~50 interleaved run_command successes never reset the
 * verify streak — the documented mixed-shape/single-streak class of ticket
 * 0e7eae65. The breaker filed exactly what it saw.
 *
 * ROOT CAUSE (deterministic, CAPACITY — the box C incident build 2026-10-09 VS
 * was written for): every coding lane runs in ONE shared dev container
 * (22.8 GiB memory cgroup), and the then-current defenses were per-PROCESS
 * (verify-limiter.ts's FIFO × the live worker + up to 4 deploy drainers) with
 * point-in-time pre-flights that all read "healthy" before N cold chains
 * (tsc ≈ 2.5 GB, jest main + 2 workers ≈ 5 GB) allocated together. The kernel
 * OOM-killed ~2.5 GB node processes at 17:30, 19:21 and 19:24Z (text #2: a
 * SIGKILLed tsc leg), and starved verifies burned their whole 15-min hard
 * timer in line (texts #1/#3 — the 17:19 abort is a call started ≈17:04).
 * Sibling tickets b8eb66f8 (18:43Z, three 900s aborts) and 6b878782 (18:39Z,
 * abort + ENVIRONMENTAL) filed from two OTHER lanes in the same window — a
 * herd, not one lane's misuse.
 *
 * THE FIX (already shipped — this ticket's trip PREDATES it by ~6 h): commit
 * f4448a999, build 2026-10-09 VS, main at 2026-10-10T01:20Z — the per-container
 * Redis slot semaphore (verify-container-slots.ts: ≤3 chains in a 22.8 GiB
 * container, FIFO across worker processes), a BOUNDED 10-min wait that DEFERS
 * (hollow pass — never a failure shape, so never streak food), and the queued-ms
 * re-arm of the tool hard timer (tool-hard-timeout.ts) so a merely-queued
 * verify is never answered "exceeded 900s". Live in prod: verify_slot_wait rows
 * at 2026-10-10T02:45–02:48Z (container 49e506f86e0b, 22.8 GiB ⇒ 3 slots).
 *
 * These tests pin, through the real primitives:
 *   1. the three filed texts ARE failure-shaped (the streak counted real
 *      envelopes — no phantom-failure defect to fix in the classifier);
 *   2. REPLAY of the middle failure through the REAL chain: a typecheck leg
 *      SIGKILLed twice with no exit marker renders byte-for-byte the filed
 *      ENVIRONMENTAL red;
 *   3. the 900s aborts, pre-fix race vs post-fix re-arm: with nothing queued
 *      reported (the pre-2026-10-09 gate) a starved verify aborts at exactly
 *      15 min with the filed text; with the gate's live queued-ms reports the
 *      incident arithmetic — 10 min in line + 12 min of chain = 22 min wall
 *      clock — completes;
 *   4. the post-fix DEFERRED shapes can never feed the streak: three chains
 *      hold the 22.8 GiB container, the fourth DEFERS after the bounded wait
 *      (hollow pass, queued time reported, chain never run on top), and no
 *      DEFERRED envelope is failure-shaped.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: unknown[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    VERIFY_SLOT_WAIT: 'verify_slot_wait',
    VERIFY_ENV_RED: 'verify_env_red',
    INDEX_SWEPT: 'index_swept',
  },
}));

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

import { looksLikeToolFailure } from './learnings-index.service';
import { runVerifyChain, type VerifyResult } from './verify.service';
import { raceToolHardTimeout } from './tool-hard-timeout';
import {
  withContainerVerifySlot, verifySlotsBusyResult, __setVerifySlotRedisForTest, VERIFY_SLOT_MAX_WAIT_MS, type VerifySlotRedis,
} from './verify-container-slots';
import { verifyGateStats } from './verify-limiter';

// ── the filed texts, 98ebfc78 (the ticket's captures are 1200-char prefixes
// of these full harness-authored envelopes — the markers sit at position 0) ────
const ABORT = 'Tool "verify" exceeded 900s and was aborted. Do not retry it; proceed with what you have.';
const ENV_RED = 'Verify FAILED at "typecheck": ✗ typecheck (exit 1)\n--- typecheck output tail ---\n[ENVIRONMENTAL] stage terminated without an exit code (the wrapper shell died before the tool reported an exit code (external SIGKILL/OOM)); zero diagnostics — infra, NOT a code failure. Retried once; retry the verify later rather than "fixing" code.';

// The incident container (build 2026-10-09 VS): box C's shared dev container.
const BOX_C_DEV = 'a1b2c3d4e5f6';
const BOX_C_CAP = 24_499_638_272; // 22.8 GiB (the 7fbc34cd env_probe number, verbatim)
const HARD = 15 * 60 * 1000;      // agent.ts TOOL_HARD_TIMEOUT_MS — the "900s"

const GREEN: VerifyResult = { passed: true, ran: true, stages: [{ key: 'typecheck', command: 'tsc', exitCode: 0, passed: true, outputTail: '' }], failedStage: null, unverified: false };

// ── 1. the filed texts are real failure shapes — the streak counted truthfully ──
describe('98ebfc78 — the three filed texts are failure-shaped (truthful counting, no classifier defect)', () => {
  it('both DISTINCT shapes of the streak count: the 900s abort (×2) and the ENVIRONMENTAL red (×1)', () => {
    expect(looksLikeToolFailure(ABORT)).toBe(true);   // ^Tool "…" exceeded \d+s and was aborted
    expect(looksLikeToolFailure(ENV_RED)).toBe(true); // ^Verify FAILED at
  });

  it('the mixed-shape single-streak class (0e7eae65): two different texts, one tool, one trip — and no needsConfirmation exemption applies', () => {
    expect(ABORT).not.toBe(ENV_RED);
    expect(ENV_RED.startsWith('Verify FAILED at "typecheck"')).toBe(true);
    expect(/needsConfirmation/.test(ABORT)).toBe(false); // not the 1ab1a52b staging shape
  });
});

// ── 2. REPLAY the middle failure through the REAL chain (the box-C OOM kill) ──
describe("98ebfc78 REPLAY — a SIGKILLed typecheck leg renders exactly the filed ENVIRONMENTAL red", () => {
  const ENV = { ...process.env };

  beforeEach(() => {
    process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1'; // real timers; the 20 s backoff would slow the replay
    mockRecordLoopMetric.mockClear();
  });
  afterEach(() => { process.env = ENV; });

  it('healthy pre-flight reads, then two marker-less stage deaths ⇒ failedStage typecheck + the verbatim [ENVIRONMENTAL] tail', async () => {
    // The pre-fix gap in one mock: point-in-time reads look healthy (cgroup 32%,
    // host MemAvailable 62%) — then the cold tsc leg is SIGKILLed anyway, twice,
    // before its wrapper can echo the exit marker (the 17:30/19:21/19:24Z kills).
    const execShell = jest.fn()
      // the reap preamble: cgroup 7.8/24.5 GiB (32% < 92%), host 20.0/32.3 GB (62% ≥ 15% floor) — no deferral
      .mockResolvedValueOnce({ stdout: '__CG__ 7817211904 24499638272 0\n__MEM__ 20000000 32314036\n', stderr: '' })
      // typecheck attempt 1: the wrapper shell died before the marker — zero output
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      // the in-chain retry: killed again
      .mockResolvedValueOnce({ stdout: '', stderr: '' });

    const r = await runVerifyChain(execShell as any, '/wt-98ebfc78', [{ key: 'typecheck', command: 'cd backend && npx tsc --noEmit' }], 300_000);

    expect(execShell).toHaveBeenCalledTimes(3); // reap + two killed attempts
    expect(r).toMatchObject({ passed: false, ran: true, failedStage: 'typecheck', unverified: false });
    expect(r.stages[0]).toMatchObject({ key: 'typecheck', passed: false, environmental: true });
    // byte-for-byte the tail the ticket filed at 18:09:13Z
    expect(r.stages[0].outputTail).toBe('[ENVIRONMENTAL] stage terminated without an exit code (the wrapper shell died before the tool reported an exit code (external SIGKILL/OOM)); zero diagnostics — infra, NOT a code failure. Retried once; retry the verify later rather than "fixing" code.');
    // …and the envelope tools.ts renders over it is the filed text #2 (marker at position 0)
    expect(looksLikeToolFailure(`Verify FAILED at "${r.failedStage}": ✗ typecheck (exit ${r.stages[0].exitCode})\n--- ${r.stages[0].key} output tail ---\n${r.stages[0].outputTail}`)).toBe(true);
  });
});

// ── 3. the 900s aborts: pre-fix race vs the post-fix queued-ms re-arm ──────────
describe('98ebfc78 REPLAY — the hard timer that authored texts #1/#3 (17:19, 19:20Z)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  function never<T>(): Promise<T> { return new Promise<T>(() => { /* a tool still running */ }); }

  it('PRE-FIX (the gate reports nothing — pre-2026-10-09): a starved verify is aborted at exactly 15 min with the filed text', async () => {
    const out = raceToolHardTimeout(never<string>(), HARD, () => ABORT, () => 0);
    let settled: string | undefined;
    void out.then(v => { settled = v; });
    await jest.advanceTimersByTimeAsync(HARD - 1);
    expect(settled).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(ABORT); // texts #1/#3: the call started ≈17:04, aborted 17:19:06
  });

  it('POST-FIX (f4448a999): the incident arithmetic — 10 min queued (the bounded slot wait) + 12 min of chain = 22 min wall clock, NOT aborted', async () => {
    let queued = 0;
    let resolveWork!: (v: string) => void;
    const work = new Promise<string>(r => { resolveWork = r; });
    const out = raceToolHardTimeout(work, HARD, () => ABORT, () => queued);
    let settled: string | undefined;
    void out.then(v => { settled = v; });
    // the gate reports its wait as it accrues (5 s polls), for the bounded 10 min
    for (let t = 0; t < 10 * 60_000; t += 5_000) { await jest.advanceTimersByTimeAsync(5_000); queued += 5_000; }
    // then the chain's own 12 min — pre-fix this call was already dead at 15:00
    await jest.advanceTimersByTimeAsync(12 * 60_000);
    expect(settled).toBeUndefined();
    resolveWork('Verify PASSED: ✓ typecheck (exit 0)');
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe('Verify PASSED: ✓ typecheck (exit 0)');
  });
});

// ── 4. the post-fix DEFERRED shape can never feed the streak ───────────────────
describe('98ebfc78 REPLAY — three chains hold the 22.8 GiB container: the fourth DEFERS, never a red', () => {
  /** A Redis whose container is FULL: every acquire says 3 holders, we are position 1. */
  class FullBoxRedis implements VerifySlotRedis {
    isReady = true;
    evals = 0;
    async eval(script: string): Promise<unknown> {
      this.evals += 1;
      if (script.startsWith('-- verify-slot:acquire')) return [0, 3, 1];
      return 1; // renew / release
    }
  }

  let fake: FullBoxRedis;
  beforeEach(() => {
    jest.useFakeTimers();
    fake = new FullBoxRedis();
    __setVerifySlotRedisForTest(fake);
    mockRecordLoopMetric.mockClear();
    delete process.env.VERIFY_SLOT_LIMIT_DISABLED;
    delete process.env.VERIFY_GATE_CONCURRENCY;
  });
  afterEach(() => {
    __setVerifySlotRedisForTest(undefined);
    jest.useRealTimers();
    delete process.env.VERIFY_SLOT_LIMIT_DISABLED;
    delete process.env.VERIFY_GATE_CONCURRENCY;
    expect(verifyGateStats()).toEqual({ active: 0, queued: 0 }); // the process FIFO always releases
  });

  it('after the bounded wait the chain does NOT run on top: hollow pass + deferred stage + the wait reported as queued time', async () => {
    const lines: string[] = [];
    const queued: number[] = [];
    const execShell = jest.fn(async (cmd: string) => {
      if (cmd.includes('__VSLOT__')) return { stdout: `__VSLOT__ ${BOX_C_DEV} ${BOX_C_CAP}\n`, stderr: '' };
      throw new Error(`unexpected command ${cmd}`); // the chain must never start a leg
    });
    const run = jest.fn(async () => GREEN);

    const p = withContainerVerifySlot(execShell, '/ws/late', {
      seam: 'tool', sessionId: 'lane-98ebfc78', runId: 'af262b0c',
      progress: (m) => lines.push(m),
      onQueuedWait: (ms) => queued.push(ms),
    }, run);

    await jest.advanceTimersByTimeAsync(0);
    expect(lines[0]).toMatch(/^Waiting for a verify slot — 3 running in this container \(limit 3, from its 22\.8 GiB memory cap\); position 1 in line\. The wait does not count against this run's time\./);

    await jest.advanceTimersByTimeAsync(VERIFY_SLOT_MAX_WAIT_MS);
    const r = await p;

    expect(run).not.toHaveBeenCalled();          // never on top of a full container
    expect(execShell).toHaveBeenCalledTimes(1);   // the probe only
    expect(r).toMatchObject({ passed: true, ran: false, unverified: true, failedStage: null });
    expect(r.stages[0]).toMatchObject({ key: 'verify_slots', deferred: true, skipped: true, passed: true });
    expect(r.stages[0].outputTail).toMatch(/^\[DEFERRED — verify slots busy\] 3 verify chain\(s\) are already running in this container \(limit 3, derived from its 22\.8 GiB memory cap/);
    expect(queued.reduce((a, b) => a + b, 0)).toBe(VERIFY_SLOT_MAX_WAIT_MS); // the whole wait re-arms the hard timer
    const rows = mockRecordLoopMetric.mock.calls.map(c => c[0]).filter((x: any) => x.kind === 'verify_slot_wait');
    expect(rows[0]).toMatchObject({ value: VERIFY_SLOT_MAX_WAIT_MS, meta: { outcome: 'timeout', holders: 3, position: 1, slots: 3 } });
  });

  it('NO DEFERRED envelope is failure-shaped — the post-fix answer can never be streak food (the 98ebfc78 recurrence guard)', async () => {
    // (a) the slot-busy deferral (f4448a999) — the real constructor, the incident numbers
    const busy = verifySlotsBusyResult({ holders: 3, slots: 3, capGiB: 22.8, waitedMs: 10 * 60_000, position: 1 });
    expect(busy).toMatchObject({ passed: true, ran: false, unverified: true, failedStage: null });
    expect(busy.stages[0]).toMatchObject({ deferred: true, skipped: true, passed: true });

    // (b) the sibling pressure-defer tails (8fa33b39 cgroup leg / 7fbc34cd host leg) —
    // driven through the REAL chain so the tails are the shipped strings, not copies:
    // a saturated cgroup (working set 98% of the 22.8 GiB cap) and a healthy cgroup
    // with a HOST below the 15% MemAvailable floor each defer BEFORE any stage runs.
    const deferChain = async (reap: string) => {
      const execShell = jest.fn(async () => ({ stdout: reap, stderr: '' }));
      const r = await runVerifyChain(execShell as any, '/wt-98ebfc78', [{ key: 'typecheck', command: 'cd backend && npx tsc --noEmit' }], 300_000);
      expect(execShell).toHaveBeenCalledTimes(1); // the reap only — no leg ever ran
      expect(r).toMatchObject({ passed: true, ran: false, unverified: true, failedStage: null });
      expect(r.stages[0].deferred).toBe(true);
      return r.stages[0].outputTail;
    };
    const cgroupTail = await deferChain('__CG__ 24000000000 24499638272 0\n__MEM__ 20000000 32314036\n'); // 98% working set
    const hostTail = await deferChain('__CG__ 7817211904 24499638272 0\n__MEM__ 2900000 32314036\n');    // cgroup 32%, host 9.0%
    expect(cgroupTail).toMatch(/^\[ENV-STARVED — container memory working set/); // ff262da5
    expect(hostTail).toMatch(/^\[ENV-STARVED — host memory starved/); // ff262da5

    // (c) the envelope tools.ts renders over a deferred result (runVerifyChainForTool,
    // tools.ts:3083 — `Verify DEFERRED: ${summary}\n${outputTail}\n…`) — the DEFERRED
    // prefix is none of the failure markers, and the tail carries no [exit: N] line.
    const envelopeOf = (tail: string, key: string) =>
      `Verify DEFERRED: ⏸ ${key} (deferred — container memory pressure; retry when peer load subsides)\n${tail}\nThe verify chain did NOT run — this is neither a pass nor a failure. Do NOT edit code in response: re-run verify when peer load subsides (typically minutes).`;

    for (const text of [
      busy.stages[0].outputTail,
      cgroupTail,
      hostTail,
      envelopeOf(busy.stages[0].outputTail, 'verify_slots'),
      envelopeOf(cgroupTail, 'pressure'),
      envelopeOf(hostTail, 'pressure'),
    ]) {
      expect(looksLikeToolFailure(text)).toBe(false);
    }
  });
});
