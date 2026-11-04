/**
 * worker-slots.ts — the live coding-worker slot registry (2026-10-20).
 *
 * Covered:
 *   - machineClaimableSlots: the worker's interactive reserve (concurrency − 1; 1 stays 1; ≤ 0 ⇒ 0)
 *   - workerBoxLabel: BOX_NAME wins, else the 12-char container hostname (infra-watch's rule)
 *   - liveWorkerSlotsFromHash (pure): fresh only, newest per box, boxes summed, malformed / 0-slot /
 *     stale ignored, future-stamped counts as fresh, missing machineSlots derived, null when empty
 *   - publishWorkerSlots: HSET shape, 0-slot publishes nothing, prunes fields older than 10 min
 *     (own + fresh kept), fail-open on a throwing / incapable client, kill switch
 *   - clearWorkerSlots / readLiveWorkerSlots: best-effort, fail-open, kill switch
 *   - startWorkerSlotPublisher: immediate + interval publish, SYNC stop clears the entry, 0-slot no-op
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockHSet: jest.Mock = jest.fn(async () => 1);
const mockHGetAll: jest.Mock = jest.fn(async () => ({}));
const mockHDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    hSet: (...a: any[]) => mockHSet(...a),
    hGetAll: (...a: any[]) => mockHGetAll(...a),
    hDel: (...a: any[]) => mockHDel(...a),
  },
}));

import {
  WORKER_SLOTS_KEY,
  WORKER_SLOTS_FRESH_MS,
  WORKER_SLOTS_PRUNE_MS,
  machineClaimableSlots,
  workerBoxLabel,
  buildWorkerSlotEntry,
  liveWorkerSlotsFromHash,
  describeLiveWorkerSlots,
  publishWorkerSlots,
  clearWorkerSlots,
  readLiveWorkerSlots,
  startWorkerSlotPublisher,
  __resetWorkerSlotsRedisForTest,
} from './worker-slots';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const entry = (workerId: string, box: string, concurrency: number, at: string, extra: Record<string, unknown> = {}) =>
  [workerId, JSON.stringify({ workerId, box, concurrency, machineSlots: machineClaimableSlots(concurrency), at, ...extra })] as const;
const hash = (...rows: ReadonlyArray<readonly [string, string]>) => Object.fromEntries(rows);

const waitFor = async (cond: () => boolean, timeoutMs = 1_000, stepMs = 2): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() <= deadline) await new Promise(r => setTimeout(r, stepMs));
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.WORKER_SLOT_REGISTRY_DISABLED;
  delete process.env.BOX_NAME;
  mockHSet.mockResolvedValue(1);
  mockHGetAll.mockResolvedValue({});
  mockHDel.mockResolvedValue(1);
  __resetWorkerSlotsRedisForTest();
});

describe('machineClaimableSlots — the interactive reserve (worker.ts lastSlot)', () => {
  it('reserves one slot when there is a spare one; a single-slot worker serves everything; nothing below 1', () => {
    expect(machineClaimableSlots(32)).toBe(31);
    expect(machineClaimableSlots(2)).toBe(1);
    expect(machineClaimableSlots(1)).toBe(1);
    expect(machineClaimableSlots(0)).toBe(0);
    expect(machineClaimableSlots(-3)).toBe(0);
    expect(machineClaimableSlots(Number.NaN)).toBe(0);
    expect(machineClaimableSlots(12.7)).toBe(11); // floored first
  });
});

describe('workerBoxLabel', () => {
  it('BOX_NAME from the box env overrides wins; else the 12-char container hostname', () => {
    expect(workerBoxLabel({ BOX_NAME: ' box-c ' } as any, 'abcdef123456ffff')).toBe('box-c');
    expect(workerBoxLabel({} as any, 'abcdef123456ffff')).toBe('abcdef123456');
  });

  it('buildWorkerSlotEntry carries the machine-claimable count and floors / zeroes the concurrency', () => {
    const e = buildWorkerSlotEntry({ workerId: 'w1', concurrency: 32, box: 'box-c', now: new Date(NOW) });
    expect(e).toEqual({ workerId: 'w1', box: 'box-c', concurrency: 32, machineSlots: 31, at: iso(0) });
    expect(buildWorkerSlotEntry({ workerId: 'w0', concurrency: 0, box: 'box-a' })).toMatchObject({ concurrency: 0, machineSlots: 0 });
    expect(buildWorkerSlotEntry({ workerId: 'w0', concurrency: Number.NaN, box: 'box-a' })).toMatchObject({ concurrency: 0, machineSlots: 0 });
  });
});

describe('liveWorkerSlotsFromHash (pure fold)', () => {
  it('null on nothing: undefined, empty, only malformed / 0-slot / stale rows', () => {
    expect(liveWorkerSlotsFromHash(undefined, NOW)).toBeNull();
    expect(liveWorkerSlotsFromHash({}, NOW)).toBeNull();
    expect(liveWorkerSlotsFromHash({ junk: 'not json', empty: '' }, NOW)).toBeNull();
    expect(liveWorkerSlotsFromHash(hash(entry('w0', 'box-a', 0, iso(0))), NOW)).toBeNull();
    expect(liveWorkerSlotsFromHash(hash(entry('w1', 'box-c', 32, iso(-WORKER_SLOTS_FRESH_MS - 1))), NOW)).toBeNull();
  });

  it('one fresh box C entry ⇒ 31 machine slots of 32 raw', () => {
    const v = liveWorkerSlotsFromHash(hash(entry('w1', 'box-c', 32, iso(-10_000))), NOW);
    expect(v).toMatchObject({ slots: 31, rawSlots: 32, workers: 1, boxes: 1 });
    expect(v!.entries.map(e => e.workerId)).toEqual(['w1']);
    expect(describeLiveWorkerSlots(v!)).toBe('32 worker slot(s) − 1 interactive reserve = 31 machine-claimable slot(s) on 1 live worker(s) / 1 box(es): box-c=32');
  });

  it('two workers on ONE box (deploy overlap) ⇒ the newest wins, never a doubled sum; the worker count still says 2', () => {
    const v = liveWorkerSlotsFromHash(hash(entry('w-old', 'box-c', 32, iso(-30_000)), entry('w-new', 'box-c', 24, iso(-1_000))), NOW);
    expect(v).toMatchObject({ slots: 23, rawSlots: 24, workers: 2, boxes: 1 });
    expect(v!.entries[0].workerId).toBe('w-new');
  });

  it('two boxes SUM; a stale third box is left out', () => {
    const v = liveWorkerSlotsFromHash(hash(
      entry('wc', 'box-c', 32, iso(-5_000)),
      entry('wd', 'box-d', 16, iso(-5_000)),
      entry('we', 'box-e', 64, iso(-WORKER_SLOTS_FRESH_MS - 5_000)),
    ), NOW);
    expect(v).toMatchObject({ slots: 46, rawSlots: 48, workers: 2, boxes: 2 });
    expect(describeLiveWorkerSlots(v!)).toContain('2 live worker(s) / 2 box(es): box-c=32, box-d=16');
  });

  it('a future-stamped entry (clock skew) counts as fresh — fail-open; missing machineSlots / box are derived', () => {
    const raw = { w1: JSON.stringify({ concurrency: 8, at: iso(+60_000) }) };
    const v = liveWorkerSlotsFromHash(raw, NOW);
    expect(v).toMatchObject({ slots: 7, rawSlots: 8, workers: 1, boxes: 1 });
    expect(v!.entries[0]).toMatchObject({ workerId: 'w1', box: 'w1', machineSlots: 7 });
  });

  it('a single-slot box has no reserve (1 ⇒ 1) and the description drops the reserve clause', () => {
    const v = liveWorkerSlotsFromHash(hash(entry('w1', 'box-x', 1, iso(0))), NOW)!;
    expect(v).toMatchObject({ slots: 1, rawSlots: 1 });
    expect(describeLiveWorkerSlots(v)).toBe('1 machine-claimable worker slot(s) on 1 live worker(s) / 1 box(es): box-x=1');
  });
});

describe('publishWorkerSlots', () => {
  it('HSETs {workerId, box, concurrency, machineSlots, at} under the registry key and prunes fields older than the prune window (own + fresh kept)', async () => {
    mockHGetAll.mockResolvedValue(hash(
      entry('w1', 'box-c', 32, iso(-WORKER_SLOTS_PRUNE_MS * 3)), // own field, ancient — never pruned by its owner
      entry('w-gone', 'box-c', 32, iso(-WORKER_SLOTS_PRUNE_MS - 1)), // a replaced container's pid — pruned
      entry('w-fresh', 'box-d', 16, iso(-1_000)), // kept
      ['w-junk', 'not json'], // unparsable — pruned
    ));
    const ok = await publishWorkerSlots({ workerId: 'w1', concurrency: 32, box: 'box-c', now: new Date(NOW) });
    expect(ok).toBe(true);
    expect(mockHSet).toHaveBeenCalledTimes(1);
    const [key, field, value] = mockHSet.mock.calls[0];
    expect(key).toBe(WORKER_SLOTS_KEY);
    expect(field).toBe('w1');
    expect(JSON.parse(value)).toEqual({ workerId: 'w1', box: 'box-c', concurrency: 32, machineSlots: 31, at: iso(0) });
    expect(mockHDel).toHaveBeenCalledWith(WORKER_SLOTS_KEY, ['w-gone', 'w-junk']);
  });

  it('a 0-slot (cron-only) worker publishes NOTHING — it holds no slots', async () => {
    expect(await publishWorkerSlots({ workerId: 'wa', concurrency: 0, box: 'box-a' })).toBe(false);
    expect(mockHSet).not.toHaveBeenCalled();
  });

  it('fail-open: a throwing HSET returns false and never throws; a client without hSet publishes nothing; no prune call when nothing is stale', async () => {
    mockHSet.mockRejectedValue(new Error('redis down'));
    await expect(publishWorkerSlots({ workerId: 'w1', concurrency: 32, box: 'box-c' })).resolves.toBe(false);
    expect(await publishWorkerSlots({ workerId: 'w1', concurrency: 32, box: 'box-c' }, {} as any)).toBe(false);
    expect(await publishWorkerSlots({ workerId: 'w1', concurrency: 32, box: 'box-c' }, null)).toBe(false);
    mockHSet.mockResolvedValue(1);
    mockHGetAll.mockResolvedValue(hash(entry('w1', 'box-c', 32, iso(0))));
    expect(await publishWorkerSlots({ workerId: 'w1', concurrency: 32, box: 'box-c', now: new Date(NOW) })).toBe(true);
    expect(mockHDel).not.toHaveBeenCalled();
  });

  it('kill switch WORKER_SLOT_REGISTRY_DISABLED=1 publishes nothing', async () => {
    process.env.WORKER_SLOT_REGISTRY_DISABLED = '1';
    expect(await publishWorkerSlots({ workerId: 'w1', concurrency: 32, box: 'box-c' })).toBe(false);
    expect(mockHSet).not.toHaveBeenCalled();
  });
});

describe('clearWorkerSlots / readLiveWorkerSlots', () => {
  it('clear HDELs the worker field; a throwing client is swallowed', async () => {
    await clearWorkerSlots('w1');
    expect(mockHDel).toHaveBeenCalledWith(WORKER_SLOTS_KEY, 'w1');
    mockHDel.mockRejectedValue(new Error('redis down'));
    await expect(clearWorkerSlots('w1')).resolves.toBeUndefined();
    await expect(clearWorkerSlots('w1', {} as any)).resolves.toBeUndefined();
  });

  it('read folds the hash; disabled / throwing / incapable ⇒ null (the caller falls back)', async () => {
    mockHGetAll.mockResolvedValue(hash(entry('w1', 'box-c', 32, iso(-1_000))));
    expect(await readLiveWorkerSlots(undefined, NOW)).toMatchObject({ slots: 31, boxes: 1 });
    expect(mockHGetAll).toHaveBeenCalledWith(WORKER_SLOTS_KEY);
    mockHGetAll.mockRejectedValue(new Error('redis down'));
    expect(await readLiveWorkerSlots(undefined, NOW)).toBeNull();
    expect(await readLiveWorkerSlots({} as any, NOW)).toBeNull();
    expect(await readLiveWorkerSlots(null, NOW)).toBeNull();
    process.env.WORKER_SLOT_REGISTRY_DISABLED = '1';
    mockHGetAll.mockResolvedValue(hash(entry('w1', 'box-c', 32, iso(-1_000))));
    expect(await readLiveWorkerSlots(undefined, NOW)).toBeNull();
  });
});

describe('startWorkerSlotPublisher', () => {
  it('publishes at once and on the interval; stop() is synchronous, clears the interval and removes the entry best-effort', async () => {
    const stop = startWorkerSlotPublisher({ workerId: 'w1', concurrency: 32, box: 'box-c', intervalMs: 5 });
    await waitFor(() => mockHSet.mock.calls.length >= 2);
    expect(mockHSet.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockHSet.mock.calls[0][1]).toBe('w1');
    expect(stop()).toBeUndefined(); // sync — never a promise on the stop() / drain() path
    await waitFor(() => mockHDel.mock.calls.length >= 1);
    expect(mockHDel).toHaveBeenCalledWith(WORKER_SLOTS_KEY, 'w1');
    const after = mockHSet.mock.calls.length;
    await new Promise(r => setTimeout(r, 25));
    expect(mockHSet.mock.calls.length).toBe(after); // interval cleared
    stop(); // idempotent
    expect(mockHDel).toHaveBeenCalledTimes(1);
  });

  it('a 0-slot worker (and the kill switch) gets a no-op publisher', async () => {
    const stop0 = startWorkerSlotPublisher({ workerId: 'wa', concurrency: 0, box: 'box-a', intervalMs: 5 });
    process.env.WORKER_SLOT_REGISTRY_DISABLED = '1';
    const stopOff = startWorkerSlotPublisher({ workerId: 'wc', concurrency: 32, box: 'box-c', intervalMs: 5 });
    await new Promise(r => setTimeout(r, 20));
    expect(mockHSet).not.toHaveBeenCalled();
    stop0();
    stopOff();
    expect(mockHDel).not.toHaveBeenCalled();
  });
});
