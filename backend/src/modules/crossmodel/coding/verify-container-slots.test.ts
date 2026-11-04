/**
 * build 2026-10-09 VS — the per-CONTAINER verify-chain slot limit (verify-container-slots.ts).
 *
 * The incident replayed here (box C, 2026-10-09): the owner's lanes all run in ONE shared dev
 * container whose memory cgroup cap is host-derived — 24,499,638,272 B (22.8 GiB, the 7fbc34cd
 * env_probe number verbatim). Several lanes started this repo's verify chain together (cold
 * `tsc --noEmit` ≈ 2.5 GB, jest main + 2 workers), the container hit its cap and the kernel's
 * memory-cgroup OOM killer took ~2.5 GB node processes at 17:30, 19:21 and 19:24Z → "[ENVIRONMENTAL]
 * stage terminated without an exit code" reds, "Tool "verify" exceeded 900s and was aborted", and
 * "3× tool-failure streak: verify" tickets. The per-PROCESS FIFO (verify-limiter.ts) could not stop
 * it: the live worker and its parked drainers each run their own 2.
 *
 * Pinned: the slot math (22.8 GiB ⇒ 3), four lanes in that container ⇒ three run and the fourth
 * waits then runs (FIFO, status line, telemetry, the wait reported as queued time), a holder that
 * dies frees its slot after the lease while a LIVE holder's heartbeat keeps it, a dead waiter never
 * blocks the line, every Redis failure (error / hang / not-ready / no Redis) ⇒ no limit, the
 * bounded wait DEFERS (hollow pass — never a red, never a run on top), the kill switch restores the
 * per-process FIFO alone, and the wait never counts toward the chain's stage timeouts. Fake timers
 * throughout — no wall-clock races. The fake Redis mirrors the Lua scripts' semantics (the scripts
 * themselves were run against a real Lua interpreter — fakeredis + lupa — when written).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: unknown[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { VERIFY_SLOT_WAIT: 'verify_slot_wait', VERIFY_PRESSURE_DEFERRED: 'verify_pressure_deferred' },
}));

import {
  verifySlotsForCap, parseVerifySlotProbe, withContainerVerifySlot, runGatedVerifyChain,
  __setVerifySlotRedisForTest, verifySlotKeys, VERIFY_SLOT_ACQUIRE_LUA,
  VERIFY_SLOT_LEASE_MS, VERIFY_SLOT_MAX_WAIT_MS, VERIFY_SLOT_POLL_MS, VERIFY_SLOT_REDIS_TIMEOUT_MS,
  type VerifyGateHooks, type VerifySlotRedis,
} from './verify-container-slots';
import { verifyGateStats } from './verify-limiter';
import { runVerifyChain, type VerifyResult } from './verify.service';

// ── a fake Redis that executes the three scripts' semantics (server clock = Date.now(), faked) ─────────────
class FakeSlotRedis implements VerifySlotRedis {
  isReady = true;
  mode: 'ok' | 'throw' | 'hang' = 'ok';
  evals = 0;
  private z = new Map<string, Map<string, number>>();
  zset(k: string): Map<string, number> { let m = this.z.get(k); if (!m) { m = new Map(); this.z.set(k, m); } return m; }
  async eval(script: string, { keys, arguments: a }: { keys: string[]; arguments: string[] }): Promise<unknown> {
    this.evals += 1;
    if (this.mode === 'throw') throw new Error('connect ECONNREFUSED 10.0.0.22:7856');
    if (this.mode === 'hang') return new Promise(() => { /* never answers */ });
    const now = Date.now();
    const [H, Q, S] = keys.map(k => this.zset(k));
    if (script.startsWith('-- verify-slot:acquire')) {
      const [token, limit, lease, stale, , enqueue] = a;
      for (const [m, s] of [...H]) if (s <= now) H.delete(m);
      for (const [m, s] of [...S]) if (s <= now - Number(stale)) { Q.delete(m); S.delete(m); }
      const held = H.size;
      const line = [...Q.entries()].sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : 1)).map(e => e[0]);
      let ahead = line.indexOf(token);
      if (ahead < 0) ahead = line.length;
      if (held + ahead < Number(limit)) {
        Q.delete(token); S.delete(token); H.set(token, now + Number(lease));
        return [1, held + 1, 0];
      }
      if (enqueue === '1') { if (!Q.has(token)) Q.set(token, now); S.set(token, now); }
      return [0, held, ahead + 1];
    }
    if (script.startsWith('-- verify-slot:renew')) { H.set(a[0], now + Number(a[1])); return 1; }
    if (script.startsWith('-- verify-slot:release')) { H.delete(a[0]); Q.delete(a[0]); S.delete(a[0]); return 1; }
    throw new Error('unknown script');
  }
}

// THE INCIDENT CONTAINER: box C's shared dev container (7fbc34cd env_probe cap, verbatim).
const BOX_C_DEV = 'a1b2c3d4e5f6';
const BOX_C_CAP = 24_499_638_272;
const probeLine = (id = BOX_C_DEV, cap: string | number = BOX_C_CAP) => ({ stdout: `__VSLOT__ ${id} ${cap}\n`, stderr: '' });

function lane(id: string, opts: { container?: string; cap?: string | number } = {}) {
  const lines: string[] = [];
  const queued: number[] = [];
  const execShell = jest.fn(async (cmd: string) => {
    if (cmd.includes('__VSLOT__')) return probeLine(opts.container ?? BOX_C_DEV, opts.cap ?? BOX_C_CAP);
    throw new Error(`unexpected command ${cmd}`);
  });
  const hooks: VerifyGateHooks = {
    seam: 'tool', sessionId: `lane-${id}`, runId: `run-${id}`,
    progress: (m) => lines.push(m),
    onQueuedWait: (ms) => queued.push(ms),
  };
  return { id, lines, queued, execShell, hooks, queuedTotal: () => queued.reduce((a, b) => a + b, 0) };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(r => { open = r; });
  return { opened, open };
}

const GREEN: VerifyResult = { passed: true, ran: true, stages: [{ key: 'typecheck', command: 'tsc', exitCode: 0, passed: true, outputTail: '' }], failedStage: null, unverified: false };
const rows = (outcome?: string) => mockRecordLoopMetric.mock.calls.map(c => c[0]).filter((r: any) => r.kind === 'verify_slot_wait' && (!outcome || r.meta.outcome === outcome));

let fake: FakeSlotRedis;
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-09T19:20:00Z'));
  fake = new FakeSlotRedis();
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
  expect(verifyGateStats()).toEqual({ active: 0, queued: 0 });
});

describe('slot math', () => {
  it('derives the slot count from the container cgroup cap: 22.8 GiB (box C dev container) ⇒ 3', () => {
    expect(verifySlotsForCap(BOX_C_CAP)).toBe(3); // floor(22.8 × 0.75 / 5)
    expect(verifySlotsForCap(12 * 1024 ** 3)).toBe(1); // the dev-container floor ceiling
    expect(verifySlotsForCap(2 * 1024 ** 3)).toBe(1); // a scoped per-session container — min 1
    expect(verifySlotsForCap(30 * 1024 ** 3)).toBe(4);
    expect(verifySlotsForCap(256 * 1024 ** 3)).toBe(4); // max 4
  });

  it('parses the probe; an unlimited / unreadable cap is "no cap", a missing identity is unusable', () => {
    expect(parseVerifySlotProbe(`__VSLOT__ ${BOX_C_DEV} ${BOX_C_CAP}`)).toEqual({ container: BOX_C_DEV, capBytes: BOX_C_CAP });
    expect(parseVerifySlotProbe(`__VSLOT__ ${BOX_C_DEV} max`)).toEqual({ container: BOX_C_DEV, capBytes: null });
    expect(parseVerifySlotProbe(`__VSLOT__ ${BOX_C_DEV} 9223372036854771712`)).toEqual({ container: BOX_C_DEV, capBytes: null }); // cgroup v1 "unlimited"
    expect(parseVerifySlotProbe(`__VSLOT__ ${BOX_C_DEV} x`)).toEqual({ container: BOX_C_DEV, capBytes: null });
    expect(parseVerifySlotProbe('__VSLOT__ x 1000')).toBeNull();
    expect(parseVerifySlotProbe('bash: echo: write error')).toBeNull();
    expect(parseVerifySlotProbe('')).toBeNull();
  });

  it('keys the three structures by container with one hash tag', () => {
    expect(verifySlotKeys(BOX_C_DEV)).toEqual([`verify-slots:{${BOX_C_DEV}}:holders`, `verify-slots:{${BOX_C_DEV}}:queue`, `verify-slots:{${BOX_C_DEV}}:seen`]);
    expect(VERIFY_SLOT_ACQUIRE_LUA.startsWith('-- verify-slot:acquire')).toBe(true);
  });
});

describe('REPLAY — four lanes start verify in the 22.8 GiB shared container', () => {
  it('at most 3 chains run; the 4th waits (status line, queued time reported), then runs when one finishes', async () => {
    const lanes = ['ticket-a', 'ticket-b', 'proj-c', 'proj-d'].map(id => lane(id));
    const gates = lanes.map(() => gate());
    let running = 0; let peak = 0;
    const started: string[] = [];
    const results = lanes.map((l, i) => withContainerVerifySlot(l.execShell, '/ws/' + l.id, l.hooks, async () => {
      running += 1; peak = Math.max(peak, running); started.push(l.id);
      await gates[i].opened;
      running -= 1;
      return GREEN;
    }));
    await jest.advanceTimersByTimeAsync(0);
    expect(started).toEqual(['ticket-a', 'ticket-b', 'proj-c']);
    expect(lanes[3].lines[0]).toMatch(/^Waiting for a verify slot — 3 running in this container \(limit 3, from its 22\.8 GiB memory cap\); position 1 in line/);

    // the 4th keeps waiting while the three hold (heartbeats keep their leases past VERIFY_SLOT_LEASE_MS)
    await jest.advanceTimersByTimeAsync(VERIFY_SLOT_LEASE_MS + 30_000);
    expect(started).toHaveLength(3);
    expect(peak).toBe(3);

    gates[1].open(); // ticket-b finishes
    await jest.advanceTimersByTimeAsync(VERIFY_SLOT_POLL_MS);
    expect(started).toEqual(['ticket-a', 'ticket-b', 'proj-c', 'proj-d']);
    expect(peak).toBe(3);
    expect(lanes[3].lines.some(m => /^Verify slot granted after \d+s/.test(m))).toBe(true);
    for (const g of gates) g.open();
    for (const r of results) await expect(r).resolves.toBe(GREEN);

    // telemetry: three immediate, one acquired after the wait; the wait was reported as queued time
    expect(rows('immediate')).toHaveLength(3);
    const acquired = rows('acquired');
    expect(acquired).toHaveLength(1);
    expect(acquired[0]).toMatchObject({ sessionId: 'lane-proj-d', runId: 'run-proj-d', unit: 'ms', meta: { seam: 'tool', container: BOX_C_DEV, capGiB: 22.8, slots: 3, position: 1 } });
    const waited = acquired[0].value;
    expect(waited).toBeGreaterThanOrEqual(VERIFY_SLOT_LEASE_MS + 30_000);
    expect(lanes[3].queuedTotal()).toBe(waited);
    expect(lanes[0].queued).toEqual([]); // an immediate grant reports no queued time
    // every slot was released
    const [H, Q, S] = verifySlotKeys(BOX_C_DEV).map(k => fake.zset(k));
    expect([H.size, Q.size, S.size]).toEqual([0, 0, 0]);
  });

  it('serves waiters first-come-first-served', async () => {
    const lanes = ['h1', 'h2', 'h3', 'w1', 'w2', 'w3'].map(id => lane(id));
    const gates = lanes.map(() => gate());
    const started: string[] = [];
    const results: Promise<VerifyResult>[] = [];
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      results.push(withContainerVerifySlot(l.execShell, '/ws', l.hooks, async () => { started.push(l.id); await gates[i].opened; return GREEN; }));
      await jest.advanceTimersByTimeAsync(10); // arrivals 10 ms apart
    }
    expect(started).toEqual(['h1', 'h2', 'h3']);
    gates[0].open(); gates[1].open();
    await jest.advanceTimersByTimeAsync(VERIFY_SLOT_POLL_MS);
    expect(started).toEqual(['h1', 'h2', 'h3', 'w1', 'w2']);
    for (const g of gates) g.open();
    await jest.advanceTimersByTimeAsync(VERIFY_SLOT_POLL_MS);
    await Promise.all(results);
    expect(started).toEqual(['h1', 'h2', 'h3', 'w1', 'w2', 'w3']);
  });

  it('a different container is not limited by this one', async () => {
    const lanes = ['a', 'b', 'c'].map(id => lane(id));
    const g = gate();
    const held = lanes.map(l => withContainerVerifySlot(l.execShell, '/ws', l.hooks, async () => { await g.opened; return GREEN; }));
    await jest.advanceTimersByTimeAsync(0);
    const other = lane('per-session', { container: 'f00dfeedbeef', cap: 4 * 1024 ** 3 });
    const run = jest.fn(async () => GREEN);
    await expect(withContainerVerifySlot(other.execShell, '/ws', other.hooks, run)).resolves.toBe(GREEN);
    expect(run).toHaveBeenCalledTimes(1);
    expect(other.lines).toEqual([]);
    g.open();
    await Promise.all(held);
  });
});

describe('crash safety', () => {
  it('a holder that dies (no heartbeat, no release) frees its slot after the lease TTL', async () => {
    const [H] = verifySlotKeys(BOX_C_DEV).map(k => fake.zset(k));
    // three holders on a worker that was SIGKILLed mid-chain (deploy drain cut): leases granted, never renewed
    for (const t of ['dead-1', 'dead-2', 'dead-3']) H.set(t, Date.now() + VERIFY_SLOT_LEASE_MS);
    const l = lane('survivor');
    const run = jest.fn(async () => GREEN);
    const p = withContainerVerifySlot(l.execShell, '/ws', l.hooks, run);
    await jest.advanceTimersByTimeAsync(VERIFY_SLOT_LEASE_MS - VERIFY_SLOT_POLL_MS);
    expect(run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2 * VERIFY_SLOT_POLL_MS);
    expect(run).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toBe(GREEN);
    expect(rows('acquired')).toHaveLength(1);
  });

  it('a waiter that dies leaves the line — it never blocks the waiters behind it', async () => {
    const lanes = ['h1', 'h2', 'h3'].map(id => lane(id));
    const gates = lanes.map(() => gate());
    const held = lanes.map((l, i) => withContainerVerifySlot(l.execShell, '/ws', l.hooks, async () => { await gates[i].opened; return GREEN; }));
    await jest.advanceTimersByTimeAsync(0);
    const [, Q, S] = verifySlotKeys(BOX_C_DEV).map(k => fake.zset(k));
    Q.set('dead-waiter', Date.now() - 1); S.set('dead-waiter', Date.now() - 1); // first in line, then crashed
    const l = lane('next');
    const run = jest.fn(async () => GREEN);
    const p = withContainerVerifySlot(l.execShell, '/ws', l.hooks, run);
    await jest.advanceTimersByTimeAsync(0);
    expect(l.lines[0]).toMatch(/position 2 in line/);
    gates[0].open(); // ONE slot frees — the dead waiter is first in line for it
    await jest.advanceTimersByTimeAsync(VERIFY_SLOT_POLL_MS);
    expect(run).not.toHaveBeenCalled(); // the dead waiter still counts until it goes stale
    await jest.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1); // pruned after VERIFY_SLOT_WAITER_STALE_MS — the live waiter gets the slot
    expect(Q.has('dead-waiter')).toBe(false);
    for (const g of gates) g.open();
    await Promise.all([...held, p]);
  });

  it('a chain that throws releases its slot and the error propagates unchanged', async () => {
    const l = lane('boom');
    await expect(withContainerVerifySlot(l.execShell, '/ws', l.hooks, async () => { throw new Error('tsc crashed'); })).rejects.toThrow('tsc crashed');
    const [H] = verifySlotKeys(BOX_C_DEV).map(k => fake.zset(k));
    expect(H.size).toBe(0);
  });
});

describe('fail-open — no limit whenever the limiter cannot be trusted', () => {
  it('Redis error ⇒ the chain runs at once (no limit) and a fail_open row says why', async () => {
    fake.mode = 'throw';
    const l = lane('x');
    const run = jest.fn(async () => GREEN);
    await expect(withContainerVerifySlot(l.execShell, '/ws', l.hooks, run)).resolves.toBe(GREEN);
    expect(run).toHaveBeenCalledTimes(1);
    expect(rows('fail_open')[0].meta).toMatchObject({ reason: expect.stringContaining('ECONNREFUSED'), container: BOX_C_DEV, slots: 3 });
  });

  it('a hung Redis is an outage after the bounded call timeout, never a hung verify', async () => {
    fake.mode = 'hang';
    const l = lane('x');
    const run = jest.fn(async () => GREEN);
    const p = withContainerVerifySlot(l.execShell, '/ws', l.hooks, run);
    await jest.advanceTimersByTimeAsync(VERIFY_SLOT_REDIS_TIMEOUT_MS);
    await expect(p).resolves.toBe(GREEN);
    expect(rows('fail_open')[0].meta.reason).toMatch(/exceeded 3000ms/);
  });

  it('a malformed reply (a stub client) is an outage too — it never parks the chain', async () => {
    const stub: VerifySlotRedis = { isReady: true, eval: jest.fn(async () => undefined) };
    __setVerifySlotRedisForTest(stub);
    const run = jest.fn(async () => GREEN);
    const l = lane('x');
    await expect(withContainerVerifySlot(l.execShell, '/ws', l.hooks, run)).resolves.toBe(GREEN);
    expect(rows('fail_open')).toHaveLength(1);
  });

  it('no Redis (no REDIS_URL / a client that is not ready) ⇒ today\'s path: no probe, no row', async () => {
    __setVerifySlotRedisForTest(null);
    const l = lane('x');
    const run = jest.fn(async () => GREEN);
    await withContainerVerifySlot(l.execShell, '/ws', l.hooks, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(l.execShell).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it('an unreadable probe or a container without a memory cap ⇒ no limit (no_limit row)', async () => {
    const unlimited = lane('u', { cap: 'max' });
    const run = jest.fn(async () => GREEN);
    await withContainerVerifySlot(unlimited.execShell, '/ws', unlimited.hooks, run);
    const broken = lane('b');
    broken.execShell.mockRejectedValueOnce(new Error('docker exec failed'));
    await withContainerVerifySlot(broken.execShell, '/ws', broken.hooks, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(rows('no_limit').map((r: any) => r.meta.reason)).toEqual(['no_memory_cap', 'probe_unreadable']);
    expect(fake.evals).toBe(0);
  });
});

describe('the bounded wait DEFERS (never runs on top of a full container)', () => {
  it('after VERIFY_SLOT_MAX_WAIT_MS in line the chain does NOT run: a deferred hollow pass, the waiter leaves the line', async () => {
    const holders = ['h1', 'h2', 'h3'].map(id => lane(id));
    const g = gate();
    const held = holders.map(l => withContainerVerifySlot(l.execShell, '/ws', l.hooks, async () => { await g.opened; return GREEN; }));
    await jest.advanceTimersByTimeAsync(0);
    const l = lane('late');
    const run = jest.fn(async () => GREEN);
    const p = withContainerVerifySlot(l.execShell, '/ws', l.hooks, run);
    await jest.advanceTimersByTimeAsync(VERIFY_SLOT_MAX_WAIT_MS);
    const r = await p;
    expect(run).not.toHaveBeenCalled();
    expect(r).toMatchObject({ passed: true, ran: false, unverified: true, failedStage: null });
    expect(r.stages[0]).toMatchObject({ key: 'verify_slots', deferred: true, skipped: true, passed: true });
    expect(r.stages[0].outputTail).toMatch(/^\[DEFERRED — verify slots busy\] 3 verify chain\(s\) are already running in this container \(limit 3/);
    expect(r.stages[0].outputTail).not.toMatch(/Verify FAILED|\[ENVIRONMENTAL\]|\[CAPTURE INCOMPLETE/); // never an env-red / failure shape ⇒ no streak ticket
    expect(rows('timeout')[0]).toMatchObject({ value: VERIFY_SLOT_MAX_WAIT_MS, meta: { holders: 3, position: 1, slots: 3 } });
    expect(l.queuedTotal()).toBe(VERIFY_SLOT_MAX_WAIT_MS); // all of it reported as queued time
    // status lines while waiting: the first at once, then about once a minute
    expect(l.lines.length).toBeGreaterThanOrEqual(10);
    const [, Q, S] = verifySlotKeys(BOX_C_DEV).map(k => fake.zset(k));
    expect([Q.size, S.size]).toEqual([0, 0]);
    g.open();
    await Promise.all(held);
  });
});

describe('kill switch VERIFY_SLOT_LIMIT_DISABLED=1', () => {
  it('restores the per-process FIFO alone: no probe, no Redis, no rows, no queued-time reports', async () => {
    process.env.VERIFY_SLOT_LIMIT_DISABLED = '1';
    process.env.VERIFY_GATE_CONCURRENCY = '1';
    const a = lane('a'); const b = lane('b');
    const g = gate();
    const pa = runGatedVerifyChain(a.execShell, '/ws', a.hooks, async () => { await g.opened; return GREEN; });
    const pb = runGatedVerifyChain(b.execShell, '/ws', b.hooks, async () => GREEN);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(b.lines).toEqual(['Verify queued (position 1; max 1 run at once on this box) — waiting for a free slot']);
    g.open();
    await Promise.all([pa, pb]);
    expect(a.execShell).not.toHaveBeenCalled();
    expect(fake.evals).toBe(0);
    expect(rows()).toEqual([]);
    expect(b.queued).toEqual([]);
  });
});

describe('the wait is never charged to the run', () => {
  it('the per-process FIFO wait is reported as queued time AS IT ACCRUES (the hard timer reads it live)', async () => {
    process.env.VERIFY_GATE_CONCURRENCY = '1';
    const a = lane('a'); const b = lane('b');
    const g = gate();
    const pa = runGatedVerifyChain(a.execShell, '/ws', a.hooks, async () => { await g.opened; return GREEN; });
    const pb = runGatedVerifyChain(b.execShell, '/ws', b.hooks, async () => GREEN);
    await jest.advanceTimersByTimeAsync(0);
    expect(b.lines).toEqual(['Verify queued (position 1; max 1 run at once on this box) — waiting for a free slot']);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(b.queuedTotal()).toBeGreaterThanOrEqual(45_000); // ticks while still queued
    await jest.advanceTimersByTimeAsync(5_000);
    g.open();
    await Promise.all([pa, pb]);
    expect(b.queuedTotal()).toBe(65_000);
    expect(a.queued).toEqual([]);
  });

  it('REPLAY: a lane queued behind three full chains starts its stages only once it holds the slot — every leg keeps its full per-command timeout', async () => {
    const holders = ['h1', 'h2', 'h3'].map(id => lane(id));
    const g = gate();
    const held = holders.map(l => withContainerVerifySlot(l.execShell, '/ws', l.hooks, async () => { await g.opened; return GREEN; }));
    await jest.advanceTimersByTimeAsync(0);

    const PER_COMMAND_TIMEOUT_MS = 300_000; // .digby/config.json loop.perCommandTimeoutMs
    const legCalls: Array<{ cmd: string; timeoutMs?: number; at: number }> = [];
    const execShell = jest.fn(async (cmd: string, _cwd?: string, timeoutMs?: number) => {
      if (cmd.includes('__VSLOT__')) return probeLine();
      legCalls.push({ cmd, timeoutMs, at: Date.now() });
      if (cmd.includes('__CG__')) return { stdout: '__CG__ 7817211904 24499638272 0\n__MEM__ 20000000 32314036\n', stderr: '' };
      return { stdout: 'ok\n__DIGBY_EXIT__ 0', stderr: '' };
    });
    const queued: number[] = [];
    const t0 = Date.now();
    const p = runGatedVerifyChain(execShell, '/ws/late', {
      seam: 'auto', sessionId: 'late', progress: () => {}, onQueuedWait: (ms) => queued.push(ms),
    }, () => runVerifyChain(execShell, '/ws/late', [{ key: 'typecheck', command: 'cd backend && npx tsc --noEmit' }], PER_COMMAND_TIMEOUT_MS));
    await jest.advanceTimersByTimeAsync(4 * 60_000); // four minutes in line
    expect(legCalls).toEqual([]); // nothing of the chain ran while queued
    g.open();
    await jest.advanceTimersByTimeAsync(VERIFY_SLOT_POLL_MS);
    const r = await p;
    expect(r.passed).toBe(true);
    const grantedAt = t0 + queued.reduce((a, b) => a + b, 0);
    expect(queued.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(4 * 60_000);
    const leg = legCalls.find(c => c.cmd.startsWith('export NODE_OPTIONS'))!; // the typecheck leg (the reap leg names tsc too)
    expect(leg.timeoutMs).toBe(PER_COMMAND_TIMEOUT_MS); // the stage clock is untouched by the wait
    expect(leg.at).toBeGreaterThanOrEqual(grantedAt);
    await Promise.all(held);
  });
});
