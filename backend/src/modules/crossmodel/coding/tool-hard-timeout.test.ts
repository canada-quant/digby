/**
 * build 2026-10-09 VS — the agent loop's per-tool hard-timeout race (tool-hard-timeout.ts), re-armed by QUEUED
 * time. The incident: lanes' `verify` calls waited in line behind peer chains and were answered
 * `Tool "verify" exceeded 900s and was aborted.` — a failure shape that fed "3× tool-failure streak" tickets for
 * work that had merely been queued. Pinned: with nothing queued the race is the old one exactly (same abort at
 * 15 min, same text); queued time reported during the call (live, in increments — the verify gate's shape)
 * moves the abort out by exactly that much; queued time from an EARLIER call never extends this one; the tool
 * itself is never cancelled. Fake timers only.
 */
import { raceToolHardTimeout } from './tool-hard-timeout';

const HARD = 15 * 60 * 1000;
const ABORT = 'Tool "verify" exceeded 900s and was aborted. Do not retry it; proceed with what you have.';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

function never<T>(): Promise<T> { return new Promise<T>(() => { /* a tool still running */ }); }

describe('raceToolHardTimeout', () => {
  it('nothing queued ⇒ the old race: aborts at exactly 15 min with the old text', async () => {
    const out = raceToolHardTimeout(never<string>(), HARD, () => ABORT, () => 0);
    let settled: string | undefined;
    void out.then(v => { settled = v; });
    await jest.advanceTimersByTimeAsync(HARD - 1);
    expect(settled).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(ABORT);
  });

  it('a tool that finishes first wins and clears the timer', async () => {
    let resolveWork!: (v: string) => void;
    const out = raceToolHardTimeout(new Promise<string>(r => { resolveWork = r; }), HARD, () => ABORT);
    await jest.advanceTimersByTimeAsync(60_000);
    resolveWork('Verify passed: ✓ typecheck (exit 0)');
    await expect(out).resolves.toBe('Verify passed: ✓ typecheck (exit 0)');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('REPLAY: a verify queued 10 min then running 12 min is NOT aborted (its own time is 12 min < 15)', async () => {
    let queued = 0;
    let resolveWork!: (v: string) => void;
    const work = new Promise<string>(r => { resolveWork = r; });
    const out = raceToolHardTimeout(work, HARD, () => ABORT, () => queued);
    let settled: string | undefined;
    void out.then(v => { settled = v; });
    // the gate reports its wait as it accrues (5 s polls), for 10 minutes
    for (let t = 0; t < 10 * 60_000; t += 5_000) { await jest.advanceTimersByTimeAsync(5_000); queued += 5_000; }
    await jest.advanceTimersByTimeAsync(12 * 60_000); // 22 min wall clock, 12 min of the tool's own time
    expect(settled).toBeUndefined();
    resolveWork('Verify passed');
    await jest.advanceTimersByTimeAsync(0);
    expect(settled).toBe('Verify passed');
  });

  it('the tool still gets exactly 15 min of its OWN time: queued 10 min ⇒ aborted at 25 min wall clock', async () => {
    let queued = 0;
    const out = raceToolHardTimeout(never<string>(), HARD, () => ABORT, () => queued);
    let settled: string | undefined;
    void out.then(v => { settled = v; });
    for (let t = 0; t < 10 * 60_000; t += 5_000) { await jest.advanceTimersByTimeAsync(5_000); queued += 5_000; }
    await jest.advanceTimersByTimeAsync(15 * 60_000 - 1);
    expect(settled).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(settled).toBe(ABORT);
  });

  it('a wait longer than 15 min that is still being reported keeps the call alive (merely queued is never aborted)', async () => {
    let queued = 0;
    const out = raceToolHardTimeout(never<string>(), HARD, () => ABORT, () => queued);
    let settled: string | undefined;
    void out.then(v => { settled = v; });
    for (let t = 0; t < 20 * 60_000; t += 15_000) { await jest.advanceTimersByTimeAsync(15_000); queued += 15_000; }
    expect(settled).toBeUndefined();
  });

  it('queued time from an EARLIER call never extends this one', async () => {
    const queued = 7 * 60_000; // already on the counter when the call starts
    const out = raceToolHardTimeout(never<string>(), HARD, () => ABORT, () => queued);
    let settled: string | undefined;
    void out.then(v => { settled = v; });
    await jest.advanceTimersByTimeAsync(HARD);
    expect(settled).toBe(ABORT);
  });

  it('a throwing counter is treated as "nothing queued"', async () => {
    const out = raceToolHardTimeout(never<string>(), HARD, () => ABORT, () => { throw new Error('x'); });
    await jest.advanceTimersByTimeAsync(HARD);
    await expect(out).resolves.toBe(ABORT);
  });
});
