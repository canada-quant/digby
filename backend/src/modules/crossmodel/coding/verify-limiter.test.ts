/**
 * Verify-gate thundering-herd limiter (ticket 6bf8ce36): the process-wide FIFO
 * semaphore that caps concurrent verify chains. Covers the four invariants that
 * make it safe to put in front of the PR gate: (a) at most N holders run at
 * once, (b) queued waiters are granted strictly FIFO (with onQueued positions),
 * (c) a throwing holder still releases its slot (try/finally + idempotent
 * release — no deadlock), (d) the VERIFY_GATE_CONCURRENCY env override is
 * respected, with invalid values falling back to the default.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { acquireVerifySlot, withVerifySlot, verifyGateConcurrency, verifyGateStats } from './verify-limiter';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => { resolve = res; });
  return { promise, resolve };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

const ENV_KEY = 'VERIFY_GATE_CONCURRENCY';
const savedEnv = process.env[ENV_KEY];

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  // Module state is shared across tests — every test must drain its holders.
  expect(verifyGateStats()).toEqual({ active: 0, queued: 0 });
});

describe('concurrency cap (a)', () => {
  it('never runs more than the limit concurrently', async () => {
    process.env[ENV_KEY] = '2';
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => deferred());
    const tasks = gates.map(g => withVerifySlot(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await g.promise;
      running -= 1;
    }));
    await flush();
    expect(running).toBe(2);
    expect(verifyGateStats()).toEqual({ active: 2, queued: 4 });
    for (const g of gates) { g.resolve(); await flush(); }
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });
});

describe('FIFO order (b)', () => {
  it('grants queued waiters in arrival order and reports queue positions', async () => {
    process.env[ENV_KEY] = '1';
    const order: string[] = [];
    const positions: number[] = [];
    const hold = deferred();
    const t0 = withVerifySlot(async () => { order.push('hold'); await hold.promise; });
    await flush();
    const queued = ['a', 'b', 'c'].map(id =>
      withVerifySlot(async () => { order.push(id); }, position => positions.push(position)));
    await flush();
    expect(positions).toEqual([1, 2, 3]); // each waiter learned its place in line
    hold.resolve();
    await Promise.all([t0, ...queued]);
    expect(order).toEqual(['hold', 'a', 'b', 'c']);
  });
});

describe('release on throw (c)', () => {
  it('releases the slot when the gated work throws', async () => {
    process.env[ENV_KEY] = '1';
    await expect(withVerifySlot(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The slot is free again — the next caller runs without ever queueing.
    const onQueued = jest.fn();
    await withVerifySlot(async () => 'ok', onQueued);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it('release is idempotent — a double release cannot free a second slot', async () => {
    process.env[ENV_KEY] = '1';
    const release = await acquireVerifySlot();
    release();
    release();
    expect(verifyGateStats().active).toBe(0); // not -1
    const release2 = await acquireVerifySlot();
    expect(verifyGateStats().active).toBe(1); // the double release didn't corrupt the count
    release2();
  });
});

describe('env override (d)', () => {
  it('respects VERIFY_GATE_CONCURRENCY', async () => {
    process.env[ENV_KEY] = '4';
    expect(verifyGateConcurrency()).toBe(4);
    let running = 0;
    const gates = Array.from({ length: 6 }, () => deferred());
    const tasks = gates.map(g => withVerifySlot(async () => { running += 1; await g.promise; running -= 1; }));
    await flush();
    expect(running).toBe(4);
    for (const g of gates) { g.resolve(); await flush(); }
    await Promise.all(tasks);
  });

  it('falls back to the default (2) on unset or invalid values', () => {
    delete process.env[ENV_KEY];
    expect(verifyGateConcurrency()).toBe(2);
    process.env[ENV_KEY] = '0';
    expect(verifyGateConcurrency()).toBe(2);
    process.env[ENV_KEY] = '-3';
    expect(verifyGateConcurrency()).toBe(2);
    process.env[ENV_KEY] = 'nope';
    expect(verifyGateConcurrency()).toBe(2);
    process.env[ENV_KEY] = '3.9';
    expect(verifyGateConcurrency()).toBe(3); // fractional values floor
  });
});
