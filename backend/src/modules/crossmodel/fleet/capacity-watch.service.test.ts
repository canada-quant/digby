/**
 * Capacity watch (todo 0f58ddde, 2026-10-16 — the board-surface gap): the
 * fleet's shared coding box saturates three ways (drainer pool full,
 * dev-container memory >90%, ticket queue unmoved for 2 consecutive checks)
 * and the 2026-10-16 baseline was found by an EXTERNAL agent, not by any
 * harness line. This suite pins the detection surface end-to-end:
 *
 *   - the pure parsers/thresholds (drainer name-epoch, cgroup working set,
 *     the three breach predicates)
 *   - the 2-CONSECUTIVE-CHECK persistence window (ONE spike never alerts;
 *     stale rows read as unknown, never as a sustained breach)
 *   - the sweep integration (sweepInfraWatch section 5 → deliver() wake with
 *     the 6 h Redis dedupe, meta.kind='capacity', supervisor-OFF inheritance)
 *   - the wake text contract (playbook names the linked tickets ed057f9d /
 *     ff262da5 and forbids re-filing; verify line names the metric kinds)
 *   - the fleet [BOARD] capacity line (same evidence as the alert, compact,
 *     absent when healthy)
 *   - the ticket-drain writer (one capacity_ticket_queue row per drain,
 *     healthy included; kill switch; never throws)
 *
 * The prod shape this replays (measured 2026-10-16 ~13:05 PT on box C): all
 * 4 of 4 drainer slots in use, the oldest parked 99 min with 7 live runs;
 * digby-dev-83e4fbf9-e18 at 22.81 of 22.82 GiB; 3 of 3 ticket lanes running,
 * 6 waiting, 0 spawned, unchanged since 07:08.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => { if (opts?.NX && redisStore.has(k)) return null; redisStore.set(k, v); return 'OK'; }),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  },
}));

const NOW = new Date('2026-10-16T21:00:00.000Z');
const CAP_DRAINER = 'capacity_drainer_pool';
const CAP_MEM = 'capacity_dev_memory';
const CAP_QUEUE = 'capacity_ticket_queue';

// loop_metrics rows per kind — the classifier's only input.
const rowsByKind = new Map<string, Array<{ createdAt: Date; meta: any }>>();
const mockPrisma: any = {
  loopMetric: {
    findMany: jest.fn(async ({ where }: any) => {
      const out = (rowsByKind.get(String(where?.kind ?? '')) ?? [])
        .filter((r) => !where?.createdAt?.gte || r.createdAt >= where.createdAt.gte)
        .slice()
        .sort((a, b) => +b.createdAt - +a.createdAt); // newest first
      return out.slice(0, where?.take ?? 100);
    }),
  },
  crossModelChat: { findMany: jest.fn(async () => [{ id: 'fleet-sup-1', userId: 'owner-1' }]) },
  pendingConfirmation: { findMany: jest.fn(async () => []) },
  systemSetting: { findUnique: jest.fn(async () => null) },
  userFeatureRequest: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  agentRun: { count: jest.fn(async () => 0) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  parseDrainerNames,
  parseDevMemory,
  drainerBreach,
  devMemoryBreach,
  ticketQueueBreach,
  classifyCapacity,
  renderCapacityAlert,
  fleetCapacityBoardLine,
  recordTicketQueueDepth,
  drainerCap,
  DRAINER_NAME_RE,
  CAPACITY_STALE_MS,
  TICKET_DRAIN_INTERVAL_SEC,
  QUEUE_LIVE_FRESH_MS_DEFAULT,
  queueLiveFreshMs,
} from './capacity-watch.service';
import { sweepInfraWatch } from './infra-watch.service';
import { renderFleetBoardBlock } from '../platform/board-digest.service';

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const m = (minsAgo: number, meta: any) => ({ createdAt: new Date(NOW.getTime() - minsAgo * 60_000), meta });

beforeEach(() => {
  redisStore.clear();
  rowsByKind.clear();
  mockRecordLoopMetric.mockClear();
  mockPrisma.loopMetric.findMany.mockClear();
  mockPrisma.crossModelChat.findMany.mockClear();
  delete process.env.CAPACITY_WATCH_DISABLED;
  delete process.env.CAPACITY_DRAINER_OLDEST_MIN;
  delete process.env.WORKER_MAX_DRAINERS;
  delete process.env.CAPACITY_DEV_MEMORY_PCT;
});

// ── Pure parsing + thresholds ─────────────────────────────────────────────────

describe('capacity-watch — drainer pool parsing + breach', () => {
  it('parses park epochs from drainer names, rejects garbage and future epochs', () => {
    const nowSec = Math.floor(NOW.getTime() / 1000);
    const names = [
      'admin-worker-green-drain-1792176620', // the measured shape (99 min old at 21:00)
      'admin-worker-blue-drain-1792180000',
      'admin-worker-green',            // not parked — the live colour
      'admin-worker-blue-drain-abc',   // non-numeric epoch
      'admin-worker-blue-drain-0',     // zero epoch
      `admin-worker-blue-drain-${nowSec + 500}`, // future (clock skew) — dropped
      'unrelated',
    ];
    const parsed = parseDrainerNames(names, nowSec);
    expect(parsed.map((p) => p.name)).toEqual(['admin-worker-green-drain-1792176620', 'admin-worker-blue-drain-1792180000']);
    // 1792176620 is 7780 s before the test's NOW (21:00:00Z = 1792184400) → 130 min
    expect(parsed[0].ageMin).toBe(130);
    expect(DRAINER_NAME_RE.test('admin-worker-green-drain-1792176620')).toBe(true);
    expect(DRAINER_NAME_RE.test('admin-worker-blue-drain-1792176620-x')).toBe(false);
  });

  it('breach requires EVERY slot occupied AND the oldest parked ≥ 60 min (env-tunable)', () => {
    expect(drainerBreach({ occupied: 4, cap: 4, oldestAgeMin: 99 })).toBe(true);   // the measured state
    expect(drainerBreach({ occupied: 3, cap: 4, oldestAgeMin: 99 })).toBe(false);  // a free slot exists
    expect(drainerBreach({ occupied: 4, cap: 4, oldestAgeMin: 12 })).toBe(false);  // fresh wave — normal
    expect(drainerBreach({ occupied: 4, cap: 0, oldestAgeMin: 99 })).toBe(false);  // cap 0 = unparseable
    expect(drainerBreach({})).toBe(false);
    withEnv({ CAPACITY_DRAINER_OLDEST_MIN: '15' }, () => {
      expect(drainerBreach({ occupied: 4, cap: 4, oldestAgeMin: 16 })).toBe(true);
    });
  });

  it('drainerCap reads WORKER_MAX_DRAINERS with the deploy-script default of 4', () => {
    expect(drainerCap()).toBe(4);
    withEnv({ WORKER_MAX_DRAINERS: '6' }, () => expect(drainerCap()).toBe(6));
    withEnv({ WORKER_MAX_DRAINERS: 'garbage' }, () => expect(drainerCap()).toBe(4));
  });
});

describe('capacity-watch — dev-memory parsing + breach (WORKING SET)', () => {
  // cgroup v2: current, max, then events (oom_kill) + stat (inactive_file)
  const cg = (currentKb: number, maxKb: number, oomKill: number, inactiveFileKb: number) =>
    `${currentKb * 1024}\n${maxKb * 1024}\noom_kill ${oomKill}\n…\ninactive_file ${inactiveFileKb * 1024}\n…`;

  it('computes the WORKING SET (current − inactive_file) — the 2026-09-29 page-cache lesson', () => {
    const parsed = parseDevMemory(cg(20_000_000, 22_800_000, 3, 2_500_000))!;
    expect(parsed).not.toBeNull();
    expect(parsed.oomKill).toBe(3);
    expect(parsed.inactiveFileBytes).toBe(2_500_000 * 1024);
    // working set = 17.5M of 22.8M ≈ 76.8% — NOT the raw 87.7%
    const pct = ((20_000_000 - 2_500_000) / 22_800_000) * 100;
    expect(pct).toBeCloseTo(76.75, 1);
  });

  it('returns null on unlimited max, garbage, or inverted readings — never a guess', () => {
    expect(parseDevMemory(`${20_000_000 * 1024}\nmax\n`)).toBeNull(); // unlimited ceiling
    expect(parseDevMemory('garbage')).toBeNull();
    expect(parseDevMemory('')).toBeNull();
    expect(parseDevMemory(`${30_000_000 * 1024}\n${20_000_000 * 1024}\n`)).toBeNull(); // current > max
    expect(parseDevMemory('-5\n1000\n')).toBeNull();
  });

  it('breach fires at ≥ 90% working-set (env-tunable); raw-only rows cannot breach', () => {
    expect(devMemoryBreach({ pct: 93.4 })).toBe(true);  // the measured state (22.81/22.82 GiB raw; ws-corrected similar)
    expect(devMemoryBreach({ pct: 89.9 })).toBe(false);
    expect(devMemoryBreach({ rawPct: 99, pct: undefined })).toBe(false); // no working-set reading — say nothing
    expect(devMemoryBreach({})).toBe(false);
    withEnv({ CAPACITY_DEV_MEMORY_PCT: '95' }, () => {
      expect(devMemoryBreach({ pct: 93 })).toBe(false);
      expect(devMemoryBreach({ pct: 95.1 })).toBe(true);
    });
  });
});

describe('capacity-watch — ticket-queue breach', () => {
  it('breach = full occupancy AND waiting > 0 AND nothing spawned (the "unmoved" state)', () => {
    expect(ticketQueueBreach({ occupied: 3, cap: 3, waiting: 6, spawned: 0 })).toBe(true); // the measured state
    expect(ticketQueueBreach({ occupied: 3, cap: 3, waiting: 6, spawned: 1 })).toBe(false); // it MOVED
    expect(ticketQueueBreach({ occupied: 3, cap: 3, waiting: 0, spawned: 0 })).toBe(false); // nobody waiting
    expect(ticketQueueBreach({ occupied: 2, cap: 3, waiting: 6, spawned: 0 })).toBe(false); // a lane is free
    expect(ticketQueueBreach({})).toBe(false);
  });

  // ── Ticket 6808c3ef — the liveness axis (the 2026-10-20 18:09Z false alert) ──
  // The measured prod shape: 4/4 occupied, 4 waiting, 0 spawned, TWO
  // consecutive drains — and every one of the four occupied lanes live
  // mid-run (fresh queued/running agent_runs rows; run-level probe, ticket
  // 2dc0988c). Occupancy alone cannot tell "full and stuck" from "full and
  // working": that alert paged a priority-4 lane for a healthy busy queue.
  it('6808c3ef: a full-and-BUSY queue (every occupied lane provably live) does NOT breach', () => {
    expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 4 })).toBe(false); // the 18:09Z replay
    expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 7, spawned: 0, occupiedLive: 4 })).toBe(false); // the 21:39Z replay (waiting grew)
  });

  it('6808c3ef: a full queue with at least one non-live occupied lane (the zombie shape) still breaches', () => {
    expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 3 })).toBe(true); // one zombie
    expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 0 })).toBe(true); // all zombies (the ff262da5 shape)
  });

  it('6808c3ef: a MISSING axis never silences the signal — pre-fix rows (no occupiedLive) keep the volume rule', () => {
    expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 4, spawned: 0 })).toBe(true); // no axis at all
    expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: undefined })).toBe(true);
    expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: NaN })).toBe(true); // non-numeric axis = missing
  });

  it('6808c3ef: the liveness axis never MANUFACTURES a breach — volume gates still apply first', () => {
    expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 0, spawned: 0, occupiedLive: 0 })).toBe(false); // nobody waiting
    expect(ticketQueueBreach({ occupied: 3, cap: 4, waiting: 4, spawned: 0, occupiedLive: 0 })).toBe(false); // a lane is free
    expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 4, spawned: 1, occupiedLive: 0 })).toBe(false); // it MOVED
  });

  it('6808c3ef: CAPACITY_QUEUE_LIVENESS_DISABLED=1 restores the volume-only breach (operator escape hatch)', () => {
    withEnv({ CAPACITY_QUEUE_LIVENESS_DISABLED: '1' }, () => {
      expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 4 })).toBe(true); // would NOT breach with the axis on
    });
    // and back on, the same meta does not breach
    expect(ticketQueueBreach({ occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 4 })).toBe(false);
  });

  it('6808c3ef: the fresh-activity window defaults to two drain cadences and is env-tunable', () => {
    expect(QUEUE_LIVE_FRESH_MS_DEFAULT).toBe(2 * TICKET_DRAIN_INTERVAL_SEC * 1000);
    expect(queueLiveFreshMs()).toBe(QUEUE_LIVE_FRESH_MS_DEFAULT);
    withEnv({ CAPACITY_QUEUE_LIVE_FRESH_MS: '1000' }, () => expect(queueLiveFreshMs()).toBe(1000));
    withEnv({ CAPACITY_QUEUE_LIVE_FRESH_MS: 'garbage' }, () => expect(queueLiveFreshMs()).toBe(QUEUE_LIVE_FRESH_MS_DEFAULT));
    withEnv({ CAPACITY_QUEUE_LIVE_FRESH_MS: '0' }, () => expect(queueLiveFreshMs()).toBe(0)); // explicit '0' = status-only live read
  });

  // ── Review follow-up: the compose-forwarded EMPTY var must read as UNSET ──
  // docker-compose.app.yml forwards ${CAPACITY_QUEUE_LIVE_FRESH_MS:-} — an
  // unset box env lands as an EMPTY STRING in the container, and Number('') === 0,
  // so the naive read silently disabled the freshness half of the axis on
  // every untouched deployment (verified live on box A: the deployed container
  // had the var SET to 1 empty byte). Empty/whitespace = default, only an
  // EXPLICIT numeric value (including '0') is honored.
  it('6808c3ef review: an empty or whitespace CAPACITY_QUEUE_LIVE_FRESH_MS (the compose-unset shape) reads the DEFAULT, never 0', () => {
    withEnv({ CAPACITY_QUEUE_LIVE_FRESH_MS: '' }, () => expect(queueLiveFreshMs()).toBe(QUEUE_LIVE_FRESH_MS_DEFAULT));
    withEnv({ CAPACITY_QUEUE_LIVE_FRESH_MS: '  ' }, () => expect(queueLiveFreshMs()).toBe(QUEUE_LIVE_FRESH_MS_DEFAULT));
    withEnv({ CAPACITY_QUEUE_LIVE_FRESH_MS: undefined }, () => expect(queueLiveFreshMs()).toBe(QUEUE_LIVE_FRESH_MS_DEFAULT));
    withEnv({ CAPACITY_QUEUE_LIVE_FRESH_MS: '-5' }, () => expect(queueLiveFreshMs()).toBe(QUEUE_LIVE_FRESH_MS_DEFAULT));
    // and the explicit zero still means status-only (the operator's opt-out)
    withEnv({ CAPACITY_QUEUE_LIVE_FRESH_MS: '0' }, () => expect(queueLiveFreshMs()).toBe(0));
  });
});

// ── The persistence window (anti-flap) ────────────────────────────────────────

describe('capacity-watch — the 2-consecutive-check persistence window', () => {
  it('a single spike never alerts; the second consecutive breach does', async () => {
    rowsByKind.set(CAP_DRAINER, [m(1, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 99 })]); // ONE row
    expect(await classifyCapacity(NOW)).toEqual([]);
    rowsByKind.set(CAP_DRAINER, [
      m(1, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 99 }),
      m(16, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 84 }),
    ]);
    const alerts = await classifyCapacity(NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'capacity', signal: 'drainer_pool', subject: 'box-c', severity: 'warn' });
  });

  it('a breach sandwiched by a healthy reading does NOT alert (the dip proves it was not sustained)', async () => {
    rowsByKind.set(CAP_DRAINER, [
      m(1, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 99 }),
      m(16, { host: 'box-c', occupied: 1, cap: 4, oldestAgeMin: 99 }), // healthy between
      m(31, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 99 }),
    ]);
    expect(await classifyCapacity(NOW)).toEqual([]);
  });

  it('stale rows read as UNKNOWN — an all-breach pair older than the staleness window never alerts', async () => {
    const staleMin = Math.ceil(CAPACITY_STALE_MS / 60_000) + 1;
    rowsByKind.set(CAP_DRAINER, [
      m(staleMin, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 99 }),
      m(staleMin + 15, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 99 }),
    ]);
    expect(await classifyCapacity(NOW)).toEqual([]);
  });

  it('the persistence pair is the SAME container for dev-memory (a second container cannot vouch for the first)', async () => {
    rowsByKind.set(CAP_MEM, [
      m(1, { host: 'box-c', container: 'digby-dev-83e4fbf9-e18', pct: 93.4, workingSetKb: 23_926_272, maxKb: 24_499_638, oomKill: 319 }),
      m(16, { host: 'box-c', container: 'digby-dev-OTHER-2222', pct: 95 }), // a DIFFERENT container
    ]);
    expect(await classifyCapacity(NOW)).toEqual([]);
    rowsByKind.set(CAP_MEM, [
      m(1, { host: 'box-c', container: 'digby-dev-83e4fbf9-e18', pct: 93.4, workingSetKb: 23_926_272, maxKb: 24_499_638, oomKill: 319 }),
      m(16, { host: 'box-c', container: 'digby-dev-83e4fbf9-e18', pct: 92.8, workingSetKb: 23_700_000, maxKb: 24_499_638, oomKill: 310 }),
    ]);
    const alerts = await classifyCapacity(NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ signal: 'dev_memory', subject: 'digby-dev-83e4fbf9-e18' });
    expect(alerts[0].meta.oomKill).toBe(319);
  });

  it('the queue signal rides the drain cadence (30 min) — two consecutive stalled drains alert', async () => {
    rowsByKind.set(CAP_QUEUE, [
      m(5, { occupied: 3, cap: 3, waiting: 6, spawned: 0 }),
      m(35, { occupied: 3, cap: 3, waiting: 6, spawned: 0 }),
    ]);
    const alerts = await classifyCapacity(NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ signal: 'ticket_queue', subject: 'fleet' });
  });

  // ── Ticket 6808c3ef: the false-alert replay, end to end ──
  // The 18:09Z prod shape: two consecutive drains at occupied=4/cap=4,
  // waiting=4, spawned=0 — the exact breach tuple — with ALL FOUR occupied
  // lanes live mid-run. The old volume-only rule paged a priority-4 lane for
  // a healthy busy queue (this ticket's own birth). With the axis, no alert.
  it('6808c3ef: two consecutive FULL-AND-BUSY drains never alert (the 18:09Z false-alert replay)', async () => {
    rowsByKind.set(CAP_QUEUE, [
      m(5, { occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 4 }),
      m(35, { occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 4 }),
    ]);
    expect(await classifyCapacity(NOW)).toEqual([]);
    // and the axis must not turn movement into silence: a queue that SPAWNED
    // still reads healthy with a zombie present (spawned>0 fails the gate
    // before the axis is even read)
    rowsByKind.set(CAP_QUEUE, [
      m(5, { occupied: 4, cap: 4, waiting: 4, spawned: 1, occupiedLive: 0 }),
      m(35, { occupied: 4, cap: 4, waiting: 4, spawned: 1, occupiedLive: 0 }),
    ]);
    expect(await classifyCapacity(NOW)).toEqual([]);
  });

  it('6808c3ef: a sustained full queue WITH a zombie still alerts (the real-stall shape survives the axis)', async () => {
    rowsByKind.set(CAP_QUEUE, [
      m(5, { occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 3 }),
      m(35, { occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 2 }),
    ]);
    const alerts = await classifyCapacity(NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ signal: 'ticket_queue', subject: 'fleet' });
    // the alert carries the axis for the render
    expect(alerts[0]!.meta).toMatchObject({ occupiedLive: 3 });
  });

  it('6808c3ef: a mixed window reads by the persistence rule — a demonstrably-healthy older reading breaks the pair, a zombie-newest alerts', async () => {
    // newest row cannot compute the axis (missing) but the older row PROVES
    // the queue was full-and-busy 30 min ago: not a sustained stall — the
    // healthy reading breaks the persistence pair, no alert.
    rowsByKind.set(CAP_QUEUE, [
      m(5, { occupied: 4, cap: 4, waiting: 4, spawned: 0 }), // no axis (pre-fix shape)
      m(35, { occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 4 }),
    ]);
    expect(await classifyCapacity(NOW)).toEqual([]);
    // the dangerous direction: the NEWEST row shows a real zombie — must
    // alert even when the older row is pre-fix (missing axis reads true).
    rowsByKind.set(CAP_QUEUE, [
      m(5, { occupied: 4, cap: 4, waiting: 4, spawned: 0, occupiedLive: 2 }),
      m(35, { occupied: 4, cap: 4, waiting: 4, spawned: 0 }),
    ]);
    const alerts = await classifyCapacity(NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.meta).toMatchObject({ occupiedLive: 2 });
  });

  it('CAPACITY_WATCH_DISABLED=1 silences the classifier entirely', async () => {
    rowsByKind.set(CAP_DRAINER, [
      m(1, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 99 }),
      m(16, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 84 }),
    ]);
    withEnv({ CAPACITY_WATCH_DISABLED: '1' }, async () => {
      expect(await classifyCapacity(NOW)).toEqual([]);
    });
  });
});

// ── Wake text + board line contracts ──────────────────────────────────────────

describe('capacity-watch — render + board line contracts', () => {
  const drainerAlert = {
    kind: 'capacity' as const, signal: 'drainer_pool' as const, subject: 'box-c', severity: 'warn' as const,
    firstAt: new Date('2026-10-16T19:30:00.000Z'), lastAt: NOW,
    meta: { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 99, oldestName: 'admin-worker-green-drain-1792176620', drainers: [{ name: 'admin-worker-green-drain-1792176620', ageMin: 99, running: 7 }] },
  };

  it('the wake cites the linked ticket id, forbids re-filing, and names the verify surface', () => {
    const out = renderCapacityAlert(drainerAlert, NOW);
    expect(out).toContain('[INFRA ALERT — capacity: drainer pool full]');
    expect(out).toContain('box-c');
    expect(out).toContain('ed057f9d');           // the linked ticket — never re-filed
    expect(out).toContain('never re-file it');
    expect(out).toContain('capacity_drainer_pool'); // the verify line
    expect(out).toContain('do NOT cancel deploys'); // playbook restraint
  });

  it('each signal cites its OWN linked ticket (queue → ff262da5)', () => {
    const queueAlert = {
      kind: 'capacity' as const, signal: 'ticket_queue' as const, subject: 'fleet', severity: 'warn' as const,
      firstAt: new Date('2026-10-16T20:00:00.000Z'), lastAt: NOW,
      meta: { occupied: 3, cap: 3, waiting: 6, spawned: 0 },
    };
    const out = renderCapacityAlert(queueAlert, NOW);
    expect(out).toContain('ticket queue unmoved');
    expect(out).toContain('ff262da5');
    expect(out).toContain('capacity_ticket_queue');
    // 6808c3ef: the pre-fix shape (no axis) renders with NO liveness sentence
    expect(out).not.toContain('Liveness:');
    const memAlert = {
      kind: 'capacity' as const, signal: 'dev_memory' as const, subject: 'digby-dev-83e4fbf9-e18', severity: 'warn' as const,
      firstAt: new Date('2026-10-16T19:00:00.000Z'), lastAt: NOW,
      meta: { container: 'digby-dev-83e4fbf9-e18', host: 'box-c', pct: 93.4, workingSetKb: 23_926_272, maxKb: 24_499_638, oomKill: 319 },
    };
    const memOut = renderCapacityAlert(memAlert, NOW);
    expect(memOut).toContain('dev container memory');
    expect(memOut).toContain('ff262da5');
    expect(memOut).toContain('93.4%');
    expect(memOut).toContain('batch verify runs, never parallel'); // the playbook rule
  });

  it('the fleet board line is ONE compact line citing tickets + telemetry kinds; null when healthy', async () => {
    // healthy → null (the board stays clean)
    expect(await fleetCapacityBoardLine(NOW)).toBeNull();
    // sustained breach → the compact line
    rowsByKind.set(CAP_MEM, [
      m(1, { host: 'box-c', container: 'digby-dev-83e4fbf9-e18', pct: 93.4, workingSetKb: 23_926_272, maxKb: 24_499_638, oomKill: 319 }),
      m(16, { host: 'box-c', container: 'digby-dev-83e4fbf9-e18', pct: 92.8, workingSetKb: 23_700_000, maxKb: 24_499_638, oomKill: 310 }),
    ]);
    const line = await fleetCapacityBoardLine(NOW);
    expect(line).toContain('CAPACITY (capacity-watch, breaching on 2 consecutive checks');
    expect(line).toContain('digby-dev-83e4fbf9-e18 at 93.4% mem on box-c');
    expect(line).toContain('ff262da5');
    expect(line).toContain("view 'metrics' kinds capacity_*");
    // kill switch → null
    withEnv({ CAPACITY_WATCH_DISABLED: '1' }, async () => {
      expect(await fleetCapacityBoardLine(NOW)).toBeNull();
    });
  });

  it('renderFleetBoardBlock places the capacity line directly under the header (truncation-proof)', () => {
    const plain = renderFleetBoardBlock([{ name: 'p', projectId: 'pid-12345678', activeGoals: 1, blockedGoals: 0, openTodos: 2, blockedTodos: 0, openOwnerQuestions: 0 }], [], NOW);
    expect(plain).not.toContain('CAPACITY');
    const withCap = renderFleetBoardBlock([{ name: 'p', projectId: 'pid-12345678', activeGoals: 1, blockedGoals: 0, openTodos: 2, blockedTodos: 0, openOwnerQuestions: 0 }], [], NOW, 'CAPACITY (capacity-watch, sustained 2+ consecutive checks, since 19:30Z): drainer pool FULL 4/4 on box-c');
    const lines = withCap.split('\n');
    expect(lines[1]).toContain('CAPACITY');      // line 0 = header, line 1 = capacity
    expect(lines[2]).toContain('SUPERVISED PROJECTS');
  });
});

// ── The drain writer ──────────────────────────────────────────────────────────

describe('capacity-watch — the ticket-drain queue-depth writer', () => {
  it('records one capacity_ticket_queue row per call, healthy included, with the drain accounting', () => {
    recordTicketQueueDepth({ occupied: 3, cap: 3, waiting: 6, spawned: 0, heldByFiler: 1, archived: 2 });
    recordTicketQueueDepth({ occupied: 1, cap: 3, waiting: 0, spawned: 2 });
    const kinds = mockRecordLoopMetric.mock.calls.map((c) => c[0].kind);
    expect(kinds).toEqual([CAP_QUEUE, CAP_QUEUE]);
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).toMatchObject({ occupied: 3, cap: 3, waiting: 6, spawned: 0, heldByFiler: 1, archived: 2 });
    expect(mockRecordLoopMetric.mock.calls[1][0].meta).toMatchObject({ occupied: 1, cap: 3, waiting: 0, spawned: 2, heldByFiler: 0, archived: 0 });
  });

  it('kill switch + garbage input never throw (telemetry must never take the drain down)', () => {
    withEnv({ CAPACITY_WATCH_DISABLED: '1' }, () => {
      recordTicketQueueDepth({ occupied: 3, cap: 3, waiting: 6, spawned: 0 });
      expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    });
    expect(() => recordTicketQueueDepth({ occupied: NaN, cap: 0, waiting: -1, spawned: NaN })).not.toThrow();
  });

  // ── Ticket 6808c3ef: the liveness axis rides the row ──
  it('6808c3ef: occupiedLive lands in the row meta when the drain stamps it, and is ABSENT when it cannot be computed', () => {
    recordTicketQueueDepth({ occupied: 4, cap: 4, waiting: 7, spawned: 0, occupiedLive: 4 });
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).toMatchObject({ occupiedLive: 4 });
    // absent — the drain's countingDistinctLanes-off / states-read-failed shape
    recordTicketQueueDepth({ occupied: 4, cap: 4, waiting: 7, spawned: 0 });
    expect(mockRecordLoopMetric.mock.calls[1][0].meta).not.toHaveProperty('occupiedLive');
  });

  // ── TICKET-LANE ARCHIVE GAPS (2026-10-21): the lane-archive axes ride the row ──
  it('lane archive gaps: archivedAwaiting / archivedPrevious / healedRunning / closedScanRows land when passed, and are ABSENT otherwise (switch on)', () => {
    recordTicketQueueDepth({ occupied: 2, cap: 4, waiting: 0, spawned: 0, archived: 3, archivedAwaiting: 1, archivedPrevious: 2, healedRunning: 1, closedScanRows: 214 });
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).toMatchObject({ archived: 3, archivedAwaiting: 1, archivedPrevious: 2, healedRunning: 1, closedScanRows: 214 });
    recordTicketQueueDepth({ occupied: 2, cap: 4, waiting: 0, spawned: 0, archived: 3 });
    const meta = mockRecordLoopMetric.mock.calls[1][0].meta;
    for (const k of ['archivedAwaiting', 'archivedPrevious', 'healedRunning', 'closedScanRows']) expect(meta).not.toHaveProperty(k);
  });

  it('third review (2026-10-22): closedScanCapped / closedArchiveDeferred land only when they bit', () => {
    recordTicketQueueDepth({ occupied: 1, cap: 4, waiting: 0, spawned: 0, archived: 20, closedScanRows: 5000, closedScanCapped: true, closedArchiveDeferred: 5 });
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).toMatchObject({ closedScanCapped: true, closedArchiveDeferred: 5 });
    recordTicketQueueDepth({ occupied: 1, cap: 4, waiting: 0, spawned: 0, archived: 0, closedScanRows: 12, closedScanCapped: false });
    const meta = mockRecordLoopMetric.mock.calls[1][0].meta;
    for (const k of ['closedScanCapped', 'closedArchiveDeferred']) expect(meta).not.toHaveProperty(k);
  });
});

// ── The sweep integration (section 5 → deliver()) ─────────────────────────────

describe('sweepInfraWatch — section 5 capacity alerts over the admin fleet supervisor', () => {
  it('a sustained breach wakes the fleet supervisor once (6 h Redis dedupe) with meta.kind=capacity and the linked-ticket id', async () => {
    rowsByKind.set(CAP_DRAINER, [
      m(1, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 99, oldestName: 'admin-worker-green-drain-1792176620', drainers: [{ name: 'admin-worker-green-drain-1792176620', ageMin: 99, running: 7 }] }),
      m(16, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 84, oldestName: 'admin-worker-green-drain-1792170000', drainers: [] }),
    ]);
    const wake = jest.fn(async (_o: any) => ({}));
    const first = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null });
    expect(first.alerts).toBe(1);
    expect(wake).toHaveBeenCalledWith(expect.objectContaining({ targetChatId: 'fleet-sup-1', prompt: expect.stringContaining('[INFRA ALERT — capacity: drainer pool full]') }));
    const delivered = mockRecordLoopMetric.mock.calls.find((c) => c[0]?.kind === 'infra_alert');
    expect(delivered).toBeDefined();
    expect(delivered![0].sessionId).toBe('fleet-sup-1');
    expect(delivered![0].meta).toMatchObject({ kind: 'capacity', signal: 'drainer_pool', subject: 'box-c', severity: 'warn' });
    expect(wake.mock.calls[0]![0].prompt).toContain('ed057f9d');
    // the dedupe: a second sweep inside the window delivers nothing
    const second = await sweepInfraWatch({ now: new Date(NOW.getTime() + 60_000), enqueueDirectWake: wake, getGithubToken: async () => null });
    expect(second.alerts).toBe(0);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('healthy capacity rows alert nothing (the board surface stays silent when the fleet is healthy)', async () => {
    rowsByKind.set(CAP_DRAINER, [
      m(1, { host: 'box-c', occupied: 1, cap: 4, oldestAgeMin: 12 }),
      m(16, { host: 'box-c', occupied: 2, cap: 4, oldestAgeMin: 8 }),
    ]);
    rowsByKind.set(CAP_MEM, [
      m(1, { host: 'box-c', container: 'digby-dev-a', pct: 41 }),
      m(16, { host: 'box-c', container: 'digby-dev-a', pct: 39 }),
    ]);
    rowsByKind.set(CAP_QUEUE, [
      m(5, { occupied: 1, cap: 3, waiting: 0, spawned: 1 }),
      m(35, { occupied: 0, cap: 3, waiting: 2, spawned: 2 }),
    ]);
    const wake = jest.fn(async () => ({}));
    const r = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null });
    expect(r.alerts).toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });

  it('CAPACITY_WATCH_DISABLED=1 silences section 5 without touching the other sections', async () => {
    rowsByKind.set(CAP_DRAINER, [
      m(1, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 99 }),
      m(16, { host: 'box-c', occupied: 4, cap: 4, oldestAgeMin: 84 }),
    ]);
    const wake = jest.fn(async () => ({}));
    await withEnvAsync({ CAPACITY_WATCH_DISABLED: '1' }, async () => {
      const r = await sweepInfraWatch({ now: NOW, enqueueDirectWake: wake, getGithubToken: async () => null });
      expect(r.alerts).toBe(0);
    });
    expect(wake).not.toHaveBeenCalled();
  });
});

/** withEnv for async bodies (the sweep test's kill-switch case). */
async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
