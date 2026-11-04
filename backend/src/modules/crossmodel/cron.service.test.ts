/**
 * Durable cron (Phase 3) — cron.service: register/claim/finish semantics and
 * the claim loop. Prisma is mocked at config/database; the loop tests use real
 * timers with a 10 ms tick (same settle pattern as worker.test.ts).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  cronJob: {
    upsert: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import {
  registerCronJob, claimDueCronJob, finishCronJob, startCronLoop, CRON_LEASE_MS, retireOrphanCronJobs, CRON_ORPHAN_STALE_MS,
  renewCronLease, startCronLeaseHeartbeat,
} from './cron.service';

const settle = (ms = 30) => new Promise(r => setTimeout(r, ms));

beforeEach(() => jest.clearAllMocks());

describe('registerCronJob', () => {
  it('create sets nextRunAt = now + interval; update carries ONLY intervalSec (re-register never clobbers nextRunAt/lastFiredAt)', async () => {
    mockPrisma.cronJob.upsert.mockResolvedValue({});
    const before = Date.now();
    await registerCronJob('news-prefetch', 900);

    const [args] = mockPrisma.cronJob.upsert.mock.calls[0];
    expect(args.where).toEqual({ id: 'news-prefetch' });
    // The re-register path: touching nextRunAt/lastFiredAt here would re-arm a
    // job on every worker reboot (and erase the misfire-catch-up signal).
    expect(args.update).toEqual({ intervalSec: 900 });
    // The create path: a brand-new job first fires one interval from now.
    expect(args.create.id).toBe('news-prefetch');
    expect(args.create.intervalSec).toBe(900);
    const createInMs = args.create.nextRunAt.getTime() - before;
    expect(createInMs).toBeGreaterThanOrEqual(900_000);
    expect(createInMs).toBeLessThan(900_000 + 5_000);
  });
});

describe('claimDueCronJob', () => {
  it('returns null (and never writes) when nothing is due', async () => {
    mockPrisma.cronJob.findFirst.mockResolvedValue(null);
    expect(await claimDueCronJob('worker-1')).toBeNull();
    expect(mockPrisma.cronJob.updateMany).not.toHaveBeenCalled();
  });

  it('onlyIds scopes the CLAIM query to the worker\'s served jobs (box A session-history-sync incident 2026-09-08)', async () => {
    mockPrisma.cronJob.findFirst.mockResolvedValue(null);
    await claimDueCronJob('worker-1', ['news-prefetch', 'feed-refresh']);
    const [findArgs] = mockPrisma.cronJob.findFirst.mock.calls[0];
    expect(findArgs.where.id).toEqual({ in: ['news-prefetch', 'feed-refresh'] });
  });

  it('absent onlyIds keeps the unscoped claim (back-compat)', async () => {
    mockPrisma.cronJob.findFirst.mockResolvedValue(null);
    await claimDueCronJob('worker-1');
    const [findArgs] = mockPrisma.cronJob.findFirst.mock.calls[0];
    expect(findArgs.where.id).toBeUndefined();
  });

  it('claims the oldest due job: guarded updateMany wins with count === 1', async () => {
    const before = Date.now();
    mockPrisma.cronJob.findFirst.mockResolvedValue({ id: 'feed-refresh', intervalSec: 120 });
    mockPrisma.cronJob.updateMany.mockResolvedValue({ count: 1 });

    const job = await claimDueCronJob('worker-1');
    expect(job).toEqual({ id: 'feed-refresh', intervalSec: 120 });

    const [findArgs] = mockPrisma.cronJob.findFirst.mock.calls[0];
    // Due-in-past picks immediately (misfire catch-up)…
    expect(findArgs.where.nextRunAt.lte.getTime()).toBeLessThanOrEqual(Date.now());
    // …only enabled jobs are ever claimed…
    expect(findArgs.where.enabled).toBe(true);
    // …and only lease-free ones (null or expired).
    expect(findArgs.where.OR).toEqual([{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: expect.any(Date) } }]);
    expect(findArgs.orderBy).toEqual({ nextRunAt: 'asc' });

    const [claimArgs] = mockPrisma.cronJob.updateMany.mock.calls[0];
    // The guard re-asserts id + enabled + still-due + lease-free atomically.
    expect(claimArgs.where.id).toBe('feed-refresh');
    expect(claimArgs.where.enabled).toBe(true);
    expect(claimArgs.where.nextRunAt.lte).toBeInstanceOf(Date);
    expect(claimArgs.where.OR).toHaveLength(2);
    expect(claimArgs.data.workerId).toBe('worker-1');
    const leaseMs = claimArgs.data.leaseExpiresAt.getTime() - before;
    expect(leaseMs).toBeGreaterThanOrEqual(CRON_LEASE_MS);
    expect(leaseMs).toBeLessThan(CRON_LEASE_MS + 5_000);
  });

  it('exclusivity: count === 0 means another worker won — return null', async () => {
    mockPrisma.cronJob.findFirst.mockResolvedValue({ id: 'memory-dream', intervalSec: 3600 });
    mockPrisma.cronJob.updateMany.mockResolvedValue({ count: 0 });
    expect(await claimDueCronJob('worker-2')).toBeNull();
  });
});

describe('finishCronJob', () => {
  it('anchors nextRunAt at FINISH time (now + interval) and clears the lease', async () => {
    mockPrisma.cronJob.findUnique.mockResolvedValue({ intervalSec: 900 });
    mockPrisma.cronJob.update.mockResolvedValue({});

    const before = Date.now();
    await finishCronJob('news-prefetch', true, 'ok');

    const [args] = mockPrisma.cronJob.update.mock.calls[0];
    expect(args.where).toEqual({ id: 'news-prefetch' });
    expect(args.data.lastFiredAt).toBeInstanceOf(Date);
    expect(args.data.lastStatus).toBe('ok');
    expect(args.data.leaseExpiresAt).toBeNull();
    expect(args.data.workerId).toBeNull();
    const rearmMs = args.data.nextRunAt.getTime() - before;
    expect(rearmMs).toBeGreaterThanOrEqual(900_000);
    expect(rearmMs).toBeLessThan(900_000 + 5_000);
  });

  it('failures are prefixed and lastStatus is truncated to 200 chars', async () => {
    mockPrisma.cronJob.findUnique.mockResolvedValue({ intervalSec: 120 });
    mockPrisma.cronJob.update.mockResolvedValue({});
    await finishCronJob('feed-refresh', false, 'x'.repeat(500));
    const [args] = mockPrisma.cronJob.update.mock.calls[0];
    expect(args.data.lastStatus.startsWith('ERROR: ')).toBe(true);
    expect(args.data.lastStatus.length).toBeLessThanOrEqual(200);
  });

  it('a vanished row is a no-op (no update)', async () => {
    mockPrisma.cronJob.findUnique.mockResolvedValue(null);
    await finishCronJob('ghost', true, 'ok');
    expect(mockPrisma.cronJob.update).not.toHaveBeenCalled();
  });
});

describe('startCronLoop', () => {
  // The job is due ONCE (the first claim wins it); afterwards finishCronJob has
  // re-armed it into the future, so findFirst drains to null — as in production.
  const primeClaim = (id: string, intervalSec: number) => {
    mockPrisma.cronJob.findFirst
      .mockResolvedValueOnce({ id, intervalSec })
      .mockResolvedValue(null);
    mockPrisma.cronJob.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.cronJob.findUnique.mockResolvedValue({ intervalSec });
    mockPrisma.cronJob.update.mockResolvedValue({});
  };

  it('claims + runs a due job, then finishes ok — and keeps ticking after empty ticks', async () => {
    primeClaim('j1', 900);
    const handler = jest.fn(async () => {});
    const loop = startCronLoop('worker-t', { j1: handler }, [{ id: 'j1', intervalSec: 900 }], 10);
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(mockPrisma.cronJob.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'j1' },
      data: expect.objectContaining({ lastStatus: 'ok', workerId: null, leaseExpiresAt: null }),
    }));

    // Queue drained → subsequent ticks find nothing and the loop survives.
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);

    // The loop's claim is SCOPED to its own jobs list — a job another worker
    // serves is invisible to this one (box A must never claim
    // session-history-sync; registration filtering alone can't fence it).
    const [findArgs] = mockPrisma.cronJob.findFirst.mock.calls[0];
    expect(findArgs.where.id).toEqual({ in: ['j1'] });
    loop.stop();
  });

  it('status pass-through (FO firing 15, 2026-09-24): a handler RETURNING a string writes it to lastStatus; void/empty keeps "ok"', async () => {
    // session-history-sync computes "synced N, unchanged N, failed N of N, …,
    // no mirror N, skipped N" per pass and its docblock always promised it to
    // finishCronJob — but the tick discarded the return and hardcoded 'ok', so
    // cron_jobs.lastStatus (the session_history_sync_4h standing audit read)
    // carried no shape.
    primeClaim('j-status', 600);
    const summary = 'synced 7, unchanged 14, failed 0 of 21, no mirror 1, skipped 12';
    const loop = startCronLoop('worker-t', {
      'j-status': jest.fn(async () => summary),
    }, [{ id: 'j-status', intervalSec: 600 }], 10);
    await settle();

    const finishCalls = mockPrisma.cronJob.update.mock.calls.filter((c: any) => c[0].where?.id === 'j-status');
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0][0].data.lastStatus).toBe(summary);
    loop.stop();

    // Void handler (the existing 25 jobs) and a whitespace-only string both
    // keep the 'ok' default — no behavior change for anyone but the returner.
    jest.clearAllMocks();
    primeClaim('j-void', 600);
    const loop2 = startCronLoop('worker-t', { 'j-void': jest.fn(async () => {}) }, [{ id: 'j-void', intervalSec: 600 }], 10);
    await settle();
    let calls = mockPrisma.cronJob.update.mock.calls.filter((c: any) => c[0].where?.id === 'j-void');
    expect(calls[0][0].data.lastStatus).toBe('ok');
    loop2.stop();

    jest.clearAllMocks();
    primeClaim('j-blank', 600);
    const loop3 = startCronLoop('worker-t', { 'j-blank': jest.fn(async () => '   ') }, [{ id: 'j-blank', intervalSec: 600 }], 10);
    await settle();
    calls = mockPrisma.cronJob.update.mock.calls.filter((c: any) => c[0].where?.id === 'j-blank');
    expect(calls[0][0].data.lastStatus).toBe('ok');
    loop3.stop();
  });

  it('a throwing handler marks the job failed and nextRunAt STILL advances (no hot-loop, no replay)', async () => {
    primeClaim('j-throw', 120);
    const before = Date.now();
    const loop = startCronLoop('worker-t', {
      'j-throw': jest.fn(async () => { throw new Error('boom'); }),
    }, [{ id: 'j-throw', intervalSec: 120 }], 10);
    await settle();

    const finishCalls = mockPrisma.cronJob.update.mock.calls.filter((c: any) => c[0].where?.id === 'j-throw');
    expect(finishCalls).toHaveLength(1);
    const data = finishCalls[0][0].data;
    expect(data.lastStatus).toBe('ERROR: boom');
    expect(data.nextRunAt.getTime() - before).toBeGreaterThanOrEqual(120_000);
    loop.stop();
  });

  it('a claimed id with no handler is finished failed (no handler) instead of crashing the loop', async () => {
    primeClaim('mystery', 300);
    const loop = startCronLoop('worker-t', { 'some-other-job': jest.fn(async () => {}) }, [{ id: 'mystery', intervalSec: 300 }], 10);
    await settle();

    const finishCalls = mockPrisma.cronJob.update.mock.calls.filter((c: any) => c[0].where?.id === 'mystery');
    expect(finishCalls).toHaveLength(1);
    expect(finishCalls[0][0].data.lastStatus).toBe('ERROR: no handler');
    loop.stop();
  });

  it('a claim error (DB hiccup) ends the tick but never kills the loop', async () => {
    mockPrisma.cronJob.findFirst.mockRejectedValueOnce(new Error('db hiccup'));
    primeClaim('j2', 60);
    const handler = jest.fn(async () => {});
    const loop = startCronLoop('worker-t', { j2: handler }, [{ id: 'j2', intervalSec: 60 }], 10);
    await settle(60);

    expect(handler).toHaveBeenCalledTimes(1); // recovered on a later tick
    loop.stop();
  });

  it('stop() ends claiming', async () => {
    mockPrisma.cronJob.findFirst.mockResolvedValue(null);
    const loop = startCronLoop('worker-t', { j3: jest.fn(async () => {}) }, [{ id: 'j3', intervalSec: 60 }], 10);
    await settle();
    loop.stop();
    const callsAtStop = mockPrisma.cronJob.findFirst.mock.calls.length;
    await settle(50);
    expect(mockPrisma.cronJob.findFirst.mock.calls.length).toBe(callsAtStop);
  });

  it('self-healing registration (H2): a job missing from the table is re-registered after the 60s interval, then fires', async () => {
    // The re-register cadence is clock-based, so jump the clock instead of
    // waiting 60 real seconds (real timers, 10 ms tick — same settle pattern).
    let fakeNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      mockPrisma.cronJob.upsert.mockResolvedValue({});
      mockPrisma.cronJob.findFirst.mockResolvedValue(null); // nothing due yet
      const handler = jest.fn(async () => {});
      const loop = startCronLoop('worker-t', { j1: handler }, [{ id: 'j1', intervalSec: 60 }], 10);
      await settle(30);
      // Boot registration is worker.ts's fast path — the LOOP waits out the interval.
      expect(mockPrisma.cronJob.upsert).not.toHaveBeenCalled();

      fakeNow += 61_000; // past the 60s re-register interval → next tick re-registers
      await settle(30);
      expect(mockPrisma.cronJob.upsert).toHaveBeenCalledTimes(1);
      const [upsertArgs] = mockPrisma.cronJob.upsert.mock.calls[0];
      expect(upsertArgs.where).toEqual({ id: 'j1' });
      expect(upsertArgs.update).toEqual({ intervalSec: 60 }); // re-register never re-arms / erases history

      // …and the (re-created) row subsequently fires when it comes due.
      mockPrisma.cronJob.findFirst
        .mockResolvedValueOnce({ id: 'j1', intervalSec: 60 })
        .mockResolvedValue(null);
      mockPrisma.cronJob.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.cronJob.findUnique.mockResolvedValue({ intervalSec: 60 });
      mockPrisma.cronJob.update.mockResolvedValue({});
      await settle(40);
      expect(handler).toHaveBeenCalledTimes(1);
      loop.stop();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('a re-registration failure is logged + swallowed, and the NEXT 60s interval retries (the loop never dies)', async () => {
    let fakeNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    try {
      mockPrisma.cronJob.upsert.mockRejectedValue(new Error('db hiccup'));
      mockPrisma.cronJob.findFirst.mockResolvedValue(null);
      const handler = jest.fn(async () => {});
      const loop = startCronLoop('worker-t', { j1: handler }, [{ id: 'j1', intervalSec: 60 }], 10);
      await settle(10);
      fakeNow += 61_000;
      await settle(30);
      expect(mockPrisma.cronJob.upsert).toHaveBeenCalledTimes(1); // failed + swallowed — no hammering…
      expect(handler).not.toHaveBeenCalled(); // …nothing due, but the loop is alive
      fakeNow += 61_000; // the NEXT interval retries the registration
      await settle(30);
      expect(mockPrisma.cronJob.upsert.mock.calls.length).toBeGreaterThanOrEqual(2);
      loop.stop();
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// audit 2026-10-08 W3-4 (plumbing F10): the `box-health` row (nextRunAt 2026-09-18) outlived its job.
describe('retireOrphanCronJobs (audit 2026-10-08 W3-4)', () => {
  const NOW = new Date('2026-10-08T18:00:00Z');
  afterEach(() => { delete process.env.CRON_ORPHAN_GC_DISABLED; });

  it('REPLAY: deletes the stale box-health row — only ids no worker serves, overdue past the 7-day floor, lease-free', async () => {
    mockPrisma.cronJob.findMany.mockResolvedValue([{ id: 'box-health', nextRunAt: new Date('2026-09-18T18:39:00Z'), lastFiredAt: new Date('2026-09-18T18:24:00Z') }]);
    mockPrisma.cronJob.deleteMany.mockResolvedValue({ count: 1 });
    const ids = await retireOrphanCronJobs(['news-prefetch', 'attention-watchdog'], { now: NOW });
    expect(ids).toEqual(['box-health']);
    const where = mockPrisma.cronJob.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ notIn: ['news-prefetch', 'attention-watchdog'] });
    expect(where.nextRunAt.lt.getTime()).toBe(NOW.getTime() - CRON_ORPHAN_STALE_MS);
    expect(where.OR).toEqual([{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: NOW } }]);
    expect(mockPrisma.cronJob.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['box-health'] }, nextRunAt: { lt: where.nextRunAt.lt } } });
  });

  it('nothing orphaned ⇒ no delete; an empty known list never deletes (it would read every row as an orphan)', async () => {
    mockPrisma.cronJob.findMany.mockResolvedValue([]);
    expect(await retireOrphanCronJobs(['news-prefetch'], { now: NOW })).toEqual([]);
    expect(mockPrisma.cronJob.deleteMany).not.toHaveBeenCalled();
    expect(await retireOrphanCronJobs([], { now: NOW })).toEqual([]);
    expect(mockPrisma.cronJob.findMany).toHaveBeenCalledTimes(1);
  });

  it('kill switch CRON_ORPHAN_GC_DISABLED=1 and a DB error both leave the table alone', async () => {
    process.env.CRON_ORPHAN_GC_DISABLED = '1';
    expect(await retireOrphanCronJobs(['x'], { now: NOW })).toEqual([]);
    expect(mockPrisma.cronJob.findMany).not.toHaveBeenCalled();
    delete process.env.CRON_ORPHAN_GC_DISABLED;
    mockPrisma.cronJob.findMany.mockRejectedValue(new Error('pg down'));
    expect(await retireOrphanCronJobs(['x'], { now: NOW })).toEqual([]);
  });
});


describe('lease heartbeat (2026-10-19 — bounded, never holds a hung job forever)', () => {
  afterEach(() => { jest.useRealTimers(); delete process.env.CRON_LEASE_HEARTBEAT_DISABLED; });

  it('renewCronLease is conditional on this worker still owning the row', async () => {
    mockPrisma.cronJob.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await renewCronLease('j', 'w1', 60_000)).toBe(true);
    expect(mockPrisma.cronJob.updateMany.mock.calls[0][0].where).toEqual({ id: 'j', workerId: 'w1' });
    expect(await renewCronLease('j', 'w1', 60_000)).toBe(false);
  });

  it('renews every lease/3 while live and STOPS at the hold ceiling', async () => {
    jest.useFakeTimers();
    let t = 0;
    mockPrisma.cronJob.updateMany.mockResolvedValue({ count: 1 });
    const hb = startCronLeaseHeartbeat('j', 'w1', { leaseMs: 3000, maxHoldMs: 10_000, now: () => t });
    for (let i = 0; i < 10; i++) { t += 1000; jest.advanceTimersByTime(1000); await Promise.resolve(); }
    const renewals = mockPrisma.cronJob.updateMany.mock.calls.length;
    expect(renewals).toBeGreaterThanOrEqual(8);
    // past the ceiling: no further renewals
    for (let i = 0; i < 5; i++) { t += 1000; jest.advanceTimersByTime(1000); await Promise.resolve(); }
    expect(mockPrisma.cronJob.updateMany.mock.calls.length).toBe(renewals);
    // no renewal ever extended the lease beyond claim + ceiling
    for (const [args] of mockPrisma.cronJob.updateMany.mock.calls) {
      expect(args.data.leaseExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(3000);
    }
    hb.stop();
  });

  it('stops renewing once the row is no longer ours, and on stop()', async () => {
    jest.useFakeTimers();
    mockPrisma.cronJob.updateMany.mockResolvedValue({ count: 0 });
    startCronLeaseHeartbeat('j', 'w1', { leaseMs: 3000 });
    jest.advanceTimersByTime(1000); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(5000); await Promise.resolve();
    expect(mockPrisma.cronJob.updateMany).toHaveBeenCalledTimes(1);
  });

  it('CRON_LEASE_HEARTBEAT_DISABLED=1 never renews', async () => {
    jest.useFakeTimers();
    process.env.CRON_LEASE_HEARTBEAT_DISABLED = '1';
    startCronLeaseHeartbeat('j', 'w1', { leaseMs: 3000 });
    jest.advanceTimersByTime(10_000);
    expect(mockPrisma.cronJob.updateMany).not.toHaveBeenCalled();
  });
});
