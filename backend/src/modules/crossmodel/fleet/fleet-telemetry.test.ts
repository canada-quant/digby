/**
 * Fleet telemetry (owner 2026-09-18) — the `get_fleet_telemetry` assembly:
 * arg clamping, the four views' shapes over mocked prisma / loop-metrics /
 * GitHub fetchers, and the deterministic deploy reading.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn() } }));
const mockPrisma: any = {
  loopMetric: { findMany: jest.fn(async () => []) },
  pendingConfirmation: { findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []) },
  appErrorLog: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
  userFeatureRequest: { count: jest.fn(async () => 0) },
};
// WI-M (2026-09-25): the live https probe is a module seam — never hit the network from a test.
const mockProbe: jest.Mock = jest.fn(async () => ({ status: 'healthy', checkedAt: '2026-09-18T20:00:00.000Z', frontendCode: 200, backendCode: 200, baseUrl: 'https://digby.ai', cached: false }));
jest.mock('./deploy-health', () => ({
  __esModule: true,
  ...jest.requireActual('./deploy-health'),
  probeDeployHealth: (...a: any[]) => mockProbe(...a),
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockQuery: jest.Mock = jest.fn(async () => []);
const mockSummary: jest.Mock = jest.fn(async () => []);
const mockOutcomes: jest.Mock = jest.fn(async () => ({ flag: null, buckets: [], byUnit: [], window: { total: 0, ok: 0, fail: 0, unlabeled: 0, rate: null } }));
const mockPayloads: jest.Mock = jest.fn(async () => []);
// Ticket b5f4d5e2: the per-leg attribution aggregate. Mocked because it is a
// raw GROUP BY — the real one must never run against the fake prisma here.
const mockLegs: jest.Mock = jest.fn(async () => []);
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  queryLoopMetrics: (...a: any[]) => mockQuery(...a),
  queryLoopMetricOutcomes: (...a: any[]) => mockOutcomes(...a),
  queryLoopMetricPayloadSizes: (...a: any[]) => mockPayloads(...a),
  queryLoopMetricLegs: (...a: any[]) => mockLegs(...a),
  summarizeLoopMetrics: (...a: any[]) => mockSummary(...a),
  recordLoopMetric: jest.fn(),
}));

import {
  backupRoleOf,
  clampTelemetryArgs,
  classifyWorkerLag,
  DECISION_DOWN_STALE_MS,
  failedMarkerSuperseded,
  fleetTelemetry,
  readBackupPicture,
  readDeployPicture,
  shapeBoxes,
  shapeDeployRuns,
  TELEMETRY_DEFAULT_HOURS,
  TELEMETRY_MAX_HOURS,
  TELEMETRY_MAX_BUCKETS,
  TELEMETRY_MAX_LIMIT,
} from './fleet-telemetry';
import { boxShaTransitions, classifyBoxSha, BACKUP_STALE_H } from './infra-watch.service';

const NOW = new Date('2026-09-18T20:00:00.000Z');
const HEALTH_ROWS = [
  { createdAt: new Date('2026-09-18T19:50:00Z'), meta: { host: 'box-a', process: 'web', sha: '834efb4e', diskPct: 10, diskFreeGb: 932.3, memFreePct: 47, load1: 0.1, upMin: 12 } },
  { createdAt: new Date('2026-09-18T19:49:00Z'), meta: { host: 'box-b', process: 'web', sha: '834efb4e', diskPct: 5, diskFreeGb: 983.8, memFreePct: 63, load1: 0.06 } },
  { createdAt: new Date('2026-09-18T18:55:00Z'), meta: { host: 'box-c', process: 'worker', sha: 'b6fb4ad5', diskPct: 17, diskFreeGb: 800.1, memFreePct: 70, load1: 1.2 } },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
  mockQuery.mockResolvedValue([]);
  mockSummary.mockResolvedValue([]);
});

describe('clampTelemetryArgs', () => {
  it('requires a known view and, for metrics, a kind', () => {
    expect(clampTelemetryArgs({})).toMatchObject({ error: expect.stringContaining("view = 'boxes' | 'deploy' | 'metrics' | 'kinds'") });
    expect(clampTelemetryArgs({ view: 'metrics' })).toMatchObject({ error: expect.stringContaining('requires kind') });
  });

  it('clamps hours/limit and defaults bucket', () => {
    expect(clampTelemetryArgs({ view: 'boxes' })).toMatchObject({ view: 'boxes', hours: TELEMETRY_DEFAULT_HOURS, bucket: 'hour', limit: 20 });
    expect(clampTelemetryArgs({ view: 'metrics', kind: 'guard_strike', hours: 99999, limit: 999, bucket: 'day' })).toMatchObject({ hours: TELEMETRY_MAX_HOURS, limit: TELEMETRY_MAX_LIMIT, bucket: 'day' });
    expect(clampTelemetryArgs({ view: 'kinds', hours: -5, limit: 0 })).toMatchObject({ hours: TELEMETRY_DEFAULT_HOURS, limit: 20 });
  });

  it('accepts a chat id only in uuid-ish shape', () => {
    expect(clampTelemetryArgs({ view: 'metrics', kind: 'x', chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' })).toMatchObject({ chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' });
    expect((clampTelemetryArgs({ view: 'metrics', kind: 'x', chatId: 'DROP TABLE' }) as any).chatId).toBeUndefined();
  });
});

describe('view boxes', () => {
  it('returns the latest row per box with age and staleness', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(HEALTH_ROWS);
    const out: any = await fleetTelemetry({ view: 'boxes' }, { userId: 'owner', now: NOW });
    expect(out.ok).toBe(true);
    expect(out.boxes.map((b: any) => b.host)).toEqual(['box-a', 'box-b', 'box-c']);
    expect(mockPrisma.loopMetric.findMany).toHaveBeenCalled();
    expect(out.boxes[0]).toMatchObject({ host: 'box-a', process: 'web', sha: '834efb4e', diskPct: 10, ageMin: 10, stale: false });
    expect(out.boxes[2]).toMatchObject({ host: 'box-c', sha: 'b6fb4ad5', ageMin: 65, stale: true });
  });

  it('says so when no reporter has written anything', async () => {
    const out: any = await fleetTelemetry({ view: 'boxes' }, { userId: 'owner', now: NOW });
    expect(out.boxes).toEqual([]);
    expect(out.note).toContain('no box_health rows');
  });
});

describe('backup role annotation (ticket 533087b7)', () => {
  // The live fleet, 2026-10-31T01:49Z: box-a runs digby-backup.timer (enabled,
  // 08:30Z daily) and reports fresh dumps + status ok; box-b's timer is
  // DISABLED by design (docs/BACKUPS.md — the role lives on A only) and its
  // /opt/crossmodel-backups holds leftovers from 2026-07-29 + one ad-hoc
  // 2026-09-18 dump; worker rows carry no /backups mount at all.
  const FRESH = { count: 3, ageH: 16.5, newestAt: '2026-10-30T09:10:23.712Z', status: 'ok' as const, statusAt: '2026-10-30T09:10:35Z' };
  const LEFTOVER = { count: 3, ageH: 1031.8, newestAt: '2026-09-18T01:56:43.957Z' };
  const LIVE_ROWS = [
    { host: 'box-a', process: 'web', sha: 'db6b009a', diskPct: 34, diskFreeGb: 685.3, memFreePct: 70, load1: 0.06, backup: FRESH, at: new Date('2026-10-31T01:38:34Z') },
    { host: 'box-a', process: 'worker', sha: 'db6b009a', diskPct: 34, diskFreeGb: 685.3, memFreePct: 70, load1: 0.06, at: new Date('2026-10-31T01:38:33Z') },
    { host: 'box-b', process: 'web', sha: 'db6b009a', diskPct: 14, diskFreeGb: 897.2, memFreePct: 65, load1: 0.27, backup: LEFTOVER, at: new Date('2026-10-31T01:45:41Z') },
    { host: 'box-c', process: 'worker', sha: '9d23ad99', diskPct: 41, diskFreeGb: 611.6, memFreePct: 89, load1: 0.09, at: new Date('2026-10-31T01:41:43Z') },
  ];
  const LIVE_NOW = new Date('2026-10-31T01:49:56Z');

  it('names the producer role on the row so a by-design leftover cannot read as a silent gap', () => {
    const shaped = shapeBoxes(LIVE_ROWS as any, LIVE_NOW, ['box-a']);
    const a = shaped.find((b) => b.host === 'box-a' && b.process === 'web')!;
    const b = shaped.find((b) => b.host === 'box-b')!;
    expect(a).toMatchObject({ backupRole: 'producer', backupGap: false });
    // The number is still reported (it is a true fact) — but it is NOT a gap.
    expect(b.backup).toMatchObject({ ageH: 1031.8, count: 3 });
    expect(b).toMatchObject({ backupRole: 'non-producer', backupGap: false });
  });

  it('classifies an unmounted surface (every worker row) as by-design, never as missing', () => {
    expect(backupRoleOf(undefined, 'box-a', ['box-a'])).toEqual({ backupRole: 'unmounted', backupGap: false });
    expect(backupRoleOf(null, 'box-c', ['box-a'])).toEqual({ backupRole: 'unmounted', backupGap: false });
  });

  it('still flags a REAL gap on the producer — stale, missing and failed all raise backupGap', () => {
    expect(backupRoleOf({ count: 3, ageH: BACKUP_STALE_H + 0.1, newestAt: '2026-09-17T08:36:00.000Z' }, 'box-a', ['box-a']))
      .toEqual({ backupRole: 'producer', backupGap: true });
    expect(backupRoleOf({ count: 0, ageH: null }, 'box-a', ['box-a'])).toEqual({ backupRole: 'producer', backupGap: true });
    expect(backupRoleOf({ count: 3, ageH: 2, status: 'failed' }, 'box-a', ['box-a'])).toEqual({ backupRole: 'producer', backupGap: true });
    // ...and only for a host that OWNS the role: a stale-looking box-b never raises one.
    expect(backupRoleOf({ count: 3, ageH: 900, newestAt: '2026-09-18T01:56:43.957Z' }, 'box-b', ['box-a']).backupGap).toBe(false);
  });

  it('reads the fleet backup off the PRODUCER only and says the leftovers are by design', () => {
    const v = readBackupPicture(shapeBoxes(LIVE_ROWS as any, LIVE_NOW, ['box-a']), LIVE_NOW, ['box-a']);
    expect(v).toMatchObject({ producers: ['box-a'], ageH: 16.5, newestAt: '2026-10-30T09:10:23.712Z', status: 'ok' });
    expect(v.leftovers).toEqual([{ host: 'box-b', process: 'web', ageH: 1031.8, newestAt: '2026-09-18T01:56:43.957Z' }]);
    expect(v.unmounted.map((u) => `${u.host}/${u.process}`)).toEqual(['box-a/worker', 'box-c/worker']);
    // The sentence a supervisor can quote instead of re-deriving the wiring.
    expect(v.reading).toContain('Backup is healthy: the newest dump on the producer (box-a) is 16.5h old');
    expect(v.reading).toContain('box-b/web newest 1031.8h');
    expect(v.reading).toContain('BY-DESIGN leftovers, never a gap');
    expect(v.reading).toContain('do not open a ticket on it');
    expect(v.reading).toContain('2 row(s) with backup:null are WORKER processes (box-a/worker, box-c/worker) — by design');
  });

  it('keeps a real producer shortfall alertable through the same read (stale/failed/missing)', () => {
    const staleRows = [{ ...LIVE_ROWS[0], backup: { count: 1, ageH: 41.2, newestAt: '2026-09-17T06:20:00.000Z' } }, LIVE_ROWS[2]];
    expect(readBackupPicture(shapeBoxes(staleRows as any, LIVE_NOW, ['box-a']), LIVE_NOW, ['box-a']))
      .toMatchObject({ status: 'stale', ageH: 41.2 });
    const failedRows = [{ ...LIVE_ROWS[0], backup: { count: 3, ageH: 6, status: 'failed' as const, statusAt: '2026-10-31T01:00:00Z' } }];
    expect(readBackupPicture(shapeBoxes(failedRows as any, LIVE_NOW, ['box-a']), LIVE_NOW, ['box-a']).status).toBe('failed');
    const missingRows = [{ ...LIVE_ROWS[0], backup: { count: 0, ageH: null } }];
    expect(readBackupPicture(shapeBoxes(missingRows as any, LIVE_NOW, ['box-a']), LIVE_NOW, ['box-a']).status).toBe('missing');
  });

  it('reports UNKNOWN, not "missing", when no producer surface reported at all', () => {
    const v = readBackupPicture(shapeBoxes([LIVE_ROWS[2]] as any, LIVE_NOW, ['box-a']), LIVE_NOW, ['box-a']);
    expect(v.status).toBe('unreported');
    expect(v.ageH).toBeNull();
    expect(v.reading).toContain('the backup picture is UNKNOWN, not "missing"');
  });

  it('does NOT call it failed when a stale failed marker is superseded by a newer dump (reviewer finding 1)', () => {
    // digby-backup.sh writes backup-status.json best-effort: a later run's dump
    // can land while an older 'failed' marker survives. The alert path
    // (classifyBackupAge) filters exactly this condition; if this read did not,
    // it would publish "BACKUP FAILED" + backupGap while no alert fires — the
    // same misleading-read class this ticket exists to kill, inverted.
    const superseded = { count: 3, ageH: 2, status: 'failed' as const, statusAt: '2026-10-31T01:00:00Z', newestAt: '2026-10-31T05:00:00Z' };
    expect(failedMarkerSuperseded(superseded)).toBe(true);
    expect(backupRoleOf(superseded, 'box-a', ['box-a'])).toEqual({ backupRole: 'producer', backupGap: false });
    const rows = [{ ...LIVE_ROWS[0], backup: superseded }];
    expect(readBackupPicture(shapeBoxes(rows as any, LIVE_NOW, ['box-a']), LIVE_NOW, ['box-a']).status).not.toBe('failed');
    // ...and the marker STILL alerts when a newer dump did not supersede it.
    const notSuperseded = { count: 3, ageH: 6, status: 'failed' as const, statusAt: '2026-10-31T01:00:00Z', newestAt: '2026-10-30T09:10:00Z' };
    expect(failedMarkerSuperseded(notSuperseded)).toBe(false);
    expect(backupRoleOf(notSuperseded, 'box-a', ['box-a']).backupGap).toBe(true);
    expect(readBackupPicture(shapeBoxes([{ ...LIVE_ROWS[0], backup: notSuperseded }] as any, LIVE_NOW, ['box-a']), LIVE_NOW, ['box-a']).status).toBe('failed');
  });

  it('says the AGE is unknown, never "produced nothing", when dumps exist but cannot be aged (reviewer finding 2)', () => {
    const unageable = [{ ...LIVE_ROWS[0], backup: { count: 2, ageH: null } }];
    const v = readBackupPicture(shapeBoxes(unageable as any, LIVE_NOW, ['box-a']), LIVE_NOW, ['box-a']);
    expect(v.status).toBe('unknown_age');
    expect(v.reading).toContain('dumps are present but none can be aged');
    expect(v.reading).not.toContain('has produced nothing');
  });

  it('flags a producer that heartbeats but reports no dump at all, instead of reading it as UNKNOWN (reviewer finding 3)', () => {
    // The pre-4f6cb3610 mount-lapse class: distinguishable from a real
    // non-report because the heartbeat row exists.
    const rows = [{ host: 'box-a', process: 'web', sha: 'db6b009a', diskPct: 34, diskFreeGb: 685.3, memFreePct: 70, load1: 0.06, at: new Date('2026-10-31T01:45:00Z') }];
    const v = readBackupPicture(shapeBoxes(rows as any, LIVE_NOW, ['box-a']), LIVE_NOW, ['box-a']);
    expect(v.status).toBe('producer_unmounted');
    expect(v.reading).toContain('the pre-4f6cb3610 class');
  });
});

describe('view kinds + metrics', () => {
  it('kinds passes the window through to the summary', async () => {
    mockSummary.mockResolvedValue([{ kind: 'box_health', count: 40, sum: 400 }]);
    const out: any = await fleetTelemetry({ view: 'kinds', hours: 6 }, { userId: 'owner', now: NOW });
    expect(mockSummary).toHaveBeenCalledWith(6);
    expect(out).toMatchObject({ view: 'kinds', windowHours: 6, kinds: [{ kind: 'box_health', count: 40 }] });
  });

  it('metrics returns series + latest rows with truncated meta, scoped to a chat when asked', async () => {
    mockQuery.mockResolvedValue([
      { bucket: '2026-09-18T18:00:00.000Z', kind: 'confirmation_staged', count: 2, sum: 0, avg: null },
      { bucket: '2026-09-18T19:00:00.000Z', kind: 'confirmation_staged', count: 1, sum: 0, avg: null },
    ]);
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date('2026-09-18T19:10:00Z'), sessionId: 'c0e22e36-1c74-4295-8049-9b48335c6c37', runId: null, value: null, unit: null, meta: { tool: 'send_chat_message', machine: true, pad: 'x'.repeat(400) } },
    ]);
    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'confirmation_staged', hours: 24, chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37', limit: 5 }, { userId: 'owner', now: NOW });
    expect(mockQuery).toHaveBeenCalledWith('confirmation_staged', { hours: 24, bucket: 'hour' });
    const where = mockPrisma.loopMetric.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ kind: 'confirmation_staged', sessionId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' });
    expect(mockPrisma.loopMetric.findMany.mock.calls[0][0].take).toBe(5);
    expect(out).toMatchObject({ kind: 'confirmation_staged', known: true, total: 3, chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' });
    expect(out.series).toHaveLength(2);
    expect(out.latest[0]).toMatchObject({ chat: 'c0e22e36', run: null });
    expect(out.latest[0].meta.length).toBeLessThanOrEqual(245);
    expect(out.latest[0].meta.endsWith('…')).toBe(true);
  });

  it('flags an unregistered kind with no rows', async () => {
    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'no_such_kind' }, { userId: 'owner', now: NOW });
    expect(out).toMatchObject({ known: false, total: 0 });
    expect(out.note).toContain('not a registered loop_metrics kind');
  });

  // ── Ticket d59499f4: the ok/fail aggregate, grouped by unit ────────────────
  it('returns a per-bucket / per-unit ok-fail aggregate plus a window total', async () => {
    mockOutcomes.mockResolvedValue({
      flag: 'ok',
      buckets: [
        { bucket: '2026-09-18T19:00:00.000Z', unit: 'attempt', total: 7, ok: 6, fail: 1, unlabeled: 0, rate: 0.8571 },
        { bucket: '2026-09-18T19:00:00.000Z', unit: null, total: 22, ok: 21, fail: 1, unlabeled: 0, rate: 0.9545 },
      ],
      byUnit: [
        { unit: null, total: 22, ok: 21, fail: 1, unlabeled: 0, rate: 0.9545 },
        { unit: 'attempt', total: 7, ok: 6, fail: 1, unlabeled: 0, rate: 0.8571 },
      ],
      window: { total: 29, ok: 27, fail: 2, unlabeled: 0, rate: 0.931 },
    });
    mockPayloads.mockResolvedValue([{ unit: 'attempt', field: 'chars', n: 7, p50: 1200, p95: 7800, max: 9100, avg: 2100 }]);

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call', hours: 6 }, { userId: 'owner', now: NOW });

    // The aggregate is window-bounded by the SAME hours/bucket the counts use.
    expect(mockOutcomes).toHaveBeenCalledWith('rag_embed_call', { hours: 6, bucket: 'hour' });
    expect(mockPayloads).toHaveBeenCalledWith('rag_embed_call', { hours: 6 });
    expect(out.outcomes.window).toMatchObject({ total: 29, ok: 27, fail: 2, rate: 0.931 });
    // Both units survive — the caller must name which rate it cites.
    expect(out.outcomes.byUnit.map((g: any) => g.unit)).toEqual([null, 'attempt']);
    expect(out.outcomes.byUnit[1].rate).toBe(0.8571);
    // Ticket d59499f4 #1: the payload distribution, so chunk sizing is not blind.
    expect(out.payloadSizes).toEqual([{ unit: 'attempt', field: 'chars', n: 7, p50: 1200, p95: 7800, max: 9100, avg: 2100 }]);
    // The ambiguity is NAMED in the note, not left for the caller to discover.
    expect(out.note).toContain('cite ONE group');
  });

  // ── Ticket b5f4d5e2: attribute attempts BY LEG, not by inference ───────────
  it('returns the per-leg x per-abort aggregate so "which leg failed" is a read', async () => {
    mockLegs.mockResolvedValue([
      { leg: 'spark-a367.stanne.local:8001', abort: 'caller_timeout', total: 70, ok: 0, fail: 70, p50Ms: 8001, p95Ms: 8003 },
      { leg: 'agx-a.stanne.local:8001', abort: null, total: 691, ok: 691, fail: 0, p50Ms: 990, p95Ms: 1400 },
    ]);

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call', hours: 6 }, { userId: 'owner', now: NOW });

    // Window-bounded by the SAME hours the counts use — an aggregate on a
    // different window would be a silently mismatched denominator.
    expect(mockLegs).toHaveBeenCalledWith('rag_embed_call', { hours: 6 });
    expect(out.legs).toEqual([
      { leg: 'spark-a367.stanne.local:8001', abort: 'caller_timeout', total: 70, ok: 0, fail: 70, p50Ms: 8001, p95Ms: 8003 },
      { leg: 'agx-a.stanne.local:8001', abort: null, total: 691, ok: 691, fail: 0, p50Ms: 990, p95Ms: 1400 },
    ]);
  });

  it('a leg-less aggregate is null, not an empty list pretending every attempt named a leg', async () => {
    // Rows written before this build carry no `leg` key at all — the honest
    // answer is "this kind reports no legs", never a fabricated "" group.
    mockLegs.mockResolvedValue([]);
    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call', hours: 6 }, { userId: 'owner', now: NOW });
    expect(out.legs).toBeNull();
  });

  it('never mixes a chat-scoped sample with the window-wide leg aggregate', async () => {
    mockLegs.mockResolvedValue([{ leg: 'agx', abort: null, total: 1, ok: 1, fail: 0, p50Ms: 10, p95Ms: 10 }]);
    const out: any = await fleetTelemetry(
      { view: 'metrics', kind: 'rag_embed_call', hours: 6, chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' },
      { userId: 'owner', now: NOW }
    );
    expect(mockLegs).not.toHaveBeenCalled();
    expect(out.legs).toBeNull();
  });

  it('says so when no row carries a success flag or a payload size — it never guesses', async () => {
    mockOutcomes.mockResolvedValue({
      flag: null,
      buckets: [],
      byUnit: [],
      window: { total: 12, ok: 0, fail: 0, unlabeled: 12, rate: null },
    });
    mockPayloads.mockResolvedValue([]);

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'confirmation_staged' }, { userId: 'owner', now: NOW });
    expect(out.outcomes.window.rate).toBeNull();
    expect(out.payloadSizes).toBeNull();
    expect(out.note).toContain('no row in this window carries a boolean-ish success flag');
    expect(out.note).toContain('no payload-size field');
  });

  it('never takes the counts down when the aggregate read fails — best effort, honestly empty', async () => {
    mockQuery.mockResolvedValue([{ bucket: '2026-09-18T19:00:00.000Z', kind: 'rag_embed_call', count: 9, sum: 0, avg: null }]);
    mockOutcomes.mockRejectedValue(new Error('db down'));
    mockPayloads.mockRejectedValue(new Error('db down'));

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call' }, { userId: 'owner', now: NOW });
    expect(out.total).toBe(9);
    expect(out.outcomes).toBeNull();
    expect(out.payloadSizes).toBeNull();
  });

  it('skips the aggregate on a chat-scoped read instead of mixing scopes silently', async () => {
    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call', chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' }, { userId: 'owner', now: NOW });
    expect(mockOutcomes).not.toHaveBeenCalled();
    expect(mockPayloads).not.toHaveBeenCalled();
    expect(out.outcomes).toBeNull();
  });

  // ── Ticket ecfc9bf8: `latest` is a SAMPLE, and the answer must say so ──────
  // The live 2026-11-01 read: limit:200 against a 6h window of 10,447 rows
  // returned exactly 50 rows, with no disclosure anywhere in the response. A
  // satisfaction gate was written against that array and could never open. The
  // row COUNT is unreadable from the array (one embed call writes two rows), so
  // the fix is disclosure + a machine-readable `latestSample`, never a bigger cap.
  it('discloses the limit ceiling instead of silently returning fewer rows', async () => {
    mockQuery.mockResolvedValue([{ bucket: '2026-09-18T19:00:00.000Z', kind: 'rag_embed_call', count: 10_447, sum: 0, avg: null }]);
    mockOutcomes.mockResolvedValue({
      flag: 'ok',
      buckets: [],
      byUnit: [{ unit: null, total: 5_224, ok: 5_000, fail: 224, unlabeled: 0, rate: 0.9571 }],
      window: { total: 10_447, ok: 10_000, fail: 447, unlabeled: 0, rate: 0.9572 },
    });
    mockPrisma.loopMetric.findMany.mockResolvedValue(
      Array.from({ length: TELEMETRY_MAX_LIMIT }, (_, i) => ({
        createdAt: new Date(Date.UTC(2026, 8, 18, 19, i)), sessionId: null, runId: null, value: 100, unit: null, meta: {},
      })),
    );

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call', hours: 6, limit: 200 }, { userId: 'owner', now: NOW });

    // The ceiling was applied...
    expect(mockPrisma.loopMetric.findMany.mock.calls[0][0].take).toBe(TELEMETRY_MAX_LIMIT);
    expect(out.latest).toHaveLength(TELEMETRY_MAX_LIMIT);
    // ...and DISCLOSED on both surfaces: the note names the clamp, the block
    // carries the numbers a gate can assert on.
    expect(out.note).toContain('exceeds the ceiling');
    expect(out.note).toContain('not 200');
    expect(out.latestSample).toMatchObject({
      returned: TELEMETRY_MAX_LIMIT,
      requested: 200,
      limit: TELEMETRY_MAX_LIMIT,
      maxLimit: TELEMETRY_MAX_LIMIT,
      windowTotal: 10_447,
      complete: false,
    });
    // ...and the note points at the aggregate that DOES count, so a caller is
    // never left deriving a rate from 50 rows.
    expect(out.note).toContain('newest-50 SAMPLE of 10447 row(s)');
    expect(out.note).toContain('from `outcomes`');
  });

  it('says latest is complete only when it covers every row in the window', async () => {
    mockQuery.mockResolvedValue([{ bucket: '2026-09-18T19:00:00.000Z', kind: 'confirmation_staged', count: 3, sum: 0, avg: null }]);
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date('2026-09-18T19:10:00Z'), sessionId: null, runId: null, value: null, unit: null, meta: {} },
      { createdAt: new Date('2026-09-18T19:05:00Z'), sessionId: null, runId: null, value: null, unit: null, meta: {} },
      { createdAt: new Date('2026-09-18T19:01:00Z'), sessionId: null, runId: null, value: null, unit: null, meta: {} },
    ]);

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'confirmation_staged' }, { userId: 'owner', now: NOW });
    expect(out.latestSample).toMatchObject({ returned: 3, windowTotal: 3, complete: true });
    // A fully-covered window must NOT carry the sample warning.
    expect(out.note ?? '').not.toContain('SAMPLE of');
  });

  it('does not point a chat-scoped read at an outcomes block it does not return', async () => {
    // `total` is PLATFORM-WIDE (900) while `latest` is chat-scoped (1 row).
    // Comparing them would invent a 1-in-900 truncation ratio for the chat, so
    // the honest answer is null/unknown — never a fabricated `complete:false`.
    mockQuery.mockResolvedValue([{ bucket: '2026-09-18T19:00:00.000Z', kind: 'rag_embed_call', count: 900, sum: 0, avg: null }]);
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date('2026-09-18T19:10:00Z'), sessionId: 'c0e22e36-1c74-4295-8049-9b48335c6c37', runId: null, value: 1, unit: null, meta: {} },
    ]);

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call', chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' }, { userId: 'owner', now: NOW });
    expect(out.outcomes).toBeNull();
    expect(out.latestSample).toMatchObject({ returned: 1, windowTotal: null, complete: null });
    // The rate is genuinely uncomputable on a chat-scoped read — say so rather
    // than naming an aggregate that is null in this very answer, and never
    // print the platform-wide total as if it were this chat's.
    expect(out.note).toContain('no success rate is computable');
    expect(out.note).not.toContain('from `outcomes`');
    expect(out.note).not.toContain('900');
  });

  it('discloses when older buckets are outside the capped series', async () => {
    // 60 hourly buckets > TELEMETRY_MAX_BUCKETS (48): the freshest 48 are shown
    // but `total` counts all 60 — a silent gap without this line.
    mockQuery.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({ bucket: `2026-09-${String(16 + Math.floor(i / 24)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00:00.000Z`, kind: 'box_health', count: 1, sum: 1, avg: 1 })),
    );

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'box_health', hours: 60 }, { userId: 'owner', now: NOW });
    expect(out.series).toHaveLength(TELEMETRY_MAX_BUCKETS);
    expect(out.total).toBe(60);
    expect(out.note).toContain('freshest 48 of 60 buckets');
  });

  // ── Adversarial review findings 2 and 3 on PR #2282 ───────────────────────
  it('names the scope of `total` so it is never compared to a chat-scoped latest', async () => {
    // Review finding 2: `total` comes from queryLoopMetrics with NO chatId, so
    // a chat-scoped answer carried a platform-wide total next to 1 chat's row —
    // exactly the comparison `windowTotal: null` exists to prevent. The field
    // itself cannot change (other readers), so it now states its own scope.
    mockQuery.mockResolvedValue([{ bucket: '2026-09-18T19:00:00.000Z', kind: 'rag_embed_call', count: 900, sum: 0, avg: null }]);
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date('2026-09-18T19:10:00Z'), sessionId: 'c0e22e36-1c74-4295-8049-9b48335c6c37', runId: null, value: 1, unit: null, meta: {} },
    ]);

    const scoped: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call', chatId: 'c0e22e36-1c74-4295-8049-9b48335c6c37' }, { userId: 'owner', now: NOW });
    expect(scoped.totalScope).toContain('IGNORES chatId');

    const whole: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call' }, { userId: 'owner', now: NOW });
    expect(whole.totalScope).toBe('window (this kind)');
  });

  it('never promises an outcomes rate that the aggregate cannot supply', async () => {
    // Review finding 3: `outcomes` is non-null even when the kind carries no
    // ok/flag, in which case window.rate is null. Pointing at it as the place to
    // "take success RATES" contradicted the very next sentence. Gate on `flag`.
    mockQuery.mockResolvedValue([{ bucket: '2026-09-18T19:00:00.000Z', kind: 'rag_embed_call', count: 900, sum: 0, avg: null }]);
    mockOutcomes.mockResolvedValue({
      flag: null,
      buckets: [],
      byUnit: [{ unit: null, total: 900, ok: 0, fail: 0, unlabeled: 900, rate: null }],
      window: { total: 900, ok: 0, fail: 0, unlabeled: 900, rate: null },
    });
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date('2026-09-18T19:10:00Z'), sessionId: null, runId: null, value: 1, unit: null, meta: {} },
    ]);

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call' }, { userId: 'owner', now: NOW });
    expect(out.outcomes).not.toBeNull();
    expect(out.outcomes.window.rate).toBeNull();
    // Must not claim a rate is available from a null-flag aggregate.
    expect(out.note).toContain('cannot supply a rate for this kind');
    expect(out.note).not.toContain('take COUNTS and success RATES');
  });

  it('discloses a capped outcomes.buckets list too', async () => {
    // Review finding 4: outcomes.buckets is capped at the SAME limit as series,
    // so a long window's per-(bucket, unit) history was silently short.
    mockQuery.mockResolvedValue([{ bucket: '2026-09-18T19:00:00.000Z', kind: 'rag_embed_call', count: 10, sum: 0, avg: null }]);
    mockOutcomes.mockResolvedValue({
      flag: 'ok',
      buckets: Array.from({ length: 60 }, (_, i) => ({ bucket: `2026-09-18T${String(i % 24).padStart(2, '0')}:00:00.000Z`, unit: null, total: 1, ok: 1, fail: 0, unlabeled: 0, rate: 1 })),
      byUnit: [{ unit: null, total: 10, ok: 10, fail: 0, unlabeled: 0, rate: 1 }],
      window: { total: 10, ok: 10, fail: 0, unlabeled: 0, rate: 1 },
    });
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date('2026-09-18T19:10:00Z'), sessionId: null, runId: null, value: 1, unit: null, meta: {} },
    ]);

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call' }, { userId: 'owner', now: NOW });
    expect(out.outcomes.buckets).toHaveLength(TELEMETRY_MAX_BUCKETS);
    expect(out.note).toContain('freshest 48 of 60 (bucket × unit) groups');
    // It must also say the WINDOW aggregate still covers everything, so a caller
    // is steered to the number that is not capped.
    expect(out.note).toContain('byUnit still cover the WHOLE window');
  });

  it('emits the disclosure BEFORE the bulk latest array that a display cap truncates', async () => {
    // Review finding 1: a tool result is cut at DISPLAY_RESULT_CAP (8000 chars)
    // in the persisted transcript. 50 latest rows are >8000 chars alone, so an
    // answer that put `latest` first showed the operator the sample and never
    // the warning. Key order is therefore load-bearing — assert it directly.
    mockQuery.mockResolvedValue([{ bucket: '2026-09-18T19:00:00.000Z', kind: 'rag_embed_call', count: 10_447, sum: 0, avg: null }]);
    mockOutcomes.mockResolvedValue({
      flag: 'ok', buckets: [],
      byUnit: [{ unit: null, total: 5_224, ok: 5_000, fail: 224, unlabeled: 0, rate: 0.9571 }],
      window: { total: 10_447, ok: 10_000, fail: 447, unlabeled: 0, rate: 0.9572 },
    });
    mockPrisma.loopMetric.findMany.mockResolvedValue(
      Array.from({ length: TELEMETRY_MAX_LIMIT }, (_, i) => ({
        createdAt: new Date(Date.UTC(2026, 8, 18, 19, i)), sessionId: null, runId: null, value: 100, unit: null, meta: { pad: 'x'.repeat(200) },
      })),
    );

    const out: any = await fleetTelemetry({ view: 'metrics', kind: 'rag_embed_call', hours: 6, limit: 50 }, { userId: 'owner', now: NOW });
    const keys = Object.keys(out);
    const latestAt = keys.indexOf('latest');
    expect(latestAt).toBeGreaterThan(keys.indexOf('latestSample'));
    expect(latestAt).toBeGreaterThan(keys.indexOf('note'));
    expect(latestAt).toBeGreaterThan(keys.indexOf('outcomes'));
    // And the disclosure really does precede 8000 chars of body.
    const serialized = JSON.stringify(out);
    const noteIdx = serialized.indexOf('newest-50 SAMPLE');
    expect(noteIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeLessThan(8000);
  });
});

describe('view cards', () => {
  it("lists the caller's staged confirmations in the window with byTool/byChat counts", async () => {
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([
      { id: 'cf_1', chatId: '615723ba-2bcc-4964-baa4-47596', tool: 'send_chat_message', status: 'pending', summary: 'Send this message to chat 615723ba… as you: ' + 'y'.repeat(300), createdAt: new Date('2026-09-18T18:20:00Z'), resolvedAt: null },
      { id: 'cf_2', chatId: '615723ba-2bcc-4964-baa4-47596', tool: 'send_chat_message', status: 'consumed', summary: 'Send…', createdAt: new Date('2026-09-18T17:20:00Z'), resolvedAt: new Date('2026-09-18T17:25:00Z') },
      { id: 'cf_3', chatId: 'f5c2c1f4-898f-467f-8aee-0ddd2', tool: 'set_chat_autonomy', status: 'expired', summary: 'Grant…', createdAt: new Date('2026-09-18T16:20:00Z'), resolvedAt: null },
    ]);
    const out: any = await fleetTelemetry({ view: 'cards', hours: 24, limit: 10 }, { userId: 'owner-1', now: NOW });
    const q = mockPrisma.pendingConfirmation.findMany.mock.calls[0][0];
    expect(q.where).toMatchObject({ userId: 'owner-1' }); // the per-user gate: only the caller's cards
    expect(q.take).toBe(10);
    expect(out).toMatchObject({ view: 'cards', total: 3 });
    expect(out.byTool).toEqual([{ tool: 'send_chat_message', n: 2 }, { tool: 'set_chat_autonomy', n: 1 }]);
    expect(out.byChat).toEqual([{ chat: '615723ba', n: 2 }, { chat: 'f5c2c1f4', n: 1 }]);
    expect(out.cards[0]).toMatchObject({ id: 'cf_1', chat: '615723ba', tool: 'send_chat_message', status: 'pending', resolvedAt: null });
    expect(out.cards[0].summary.length).toBeLessThanOrEqual(201);
    expect(out.cards[1].resolvedAt).toBe('2026-09-18T17:25:00.000Z');
    expect(out.note).toBeUndefined();
  });
});

describe('view deploy', () => {
  const RUNS = [
    { id: 35383021971, head_sha: '834efb4e0000000000000000000000000000ffff', status: 'in_progress', conclusion: null, display_title: 'scheduling: cap-cadence guard', created_at: '2026-09-18T18:55:45Z', updated_at: '2026-09-18T18:56:00Z', html_url: 'https://gh/r/1' },
    { id: 35382321719, head_sha: '98e7d4620000000000000000000000000000ffff', status: 'completed', conclusion: 'cancelled', display_title: 'fix(fleet): per-process box-health reporter', created_at: '2026-09-18T18:48:28Z', updated_at: '2026-09-18T18:55:50Z', html_url: 'https://gh/r/2' },
    { id: 35381000000, head_sha: '764f9ee10000000000000000000000000000ffff', status: 'completed', conclusion: 'success', display_title: 'feat(schedules): delta gate', created_at: '2026-09-18T18:20:00Z', updated_at: '2026-09-18T18:40:00Z', html_url: 'https://gh/r/3' },
  ];

  it('without a GitHub token still answers boxes and says what is missing', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(HEALTH_ROWS);
    const out: any = await fleetTelemetry({ view: 'deploy' }, { userId: 'u', now: NOW, getGithubToken: async () => null });
    expect(out.github).toContain('no connected GitHub account');
    expect(out.boxes).toHaveLength(3);
    // No deploy facts were readable — the reading says so, and (ticket 533087b7)
    // follows with the backup verdict rather than leaving `backup` for the
    // reader to interpret. HEALTH_ROWS carry a fresh box-a heartbeat but NO dump
    // reading, which is the pre-4f6cb3610 mount-lapse class — we CAN tell that
    // apart from a genuine non-report (the heartbeat row exists), so the honest
    // verdict is producer_unmounted, never a silent 'missing'.
    expect(out.reading).toContain('No deploy facts available.');
    expect(out.backup).toMatchObject({ producers: ['box-a'], status: 'producer_unmounted', ageH: null });
    expect(out.reading).toContain('its heartbeat is fresh but it reports NO dump reading at all');
  });

  it('with a token: main head, runs, in-flight flag, onMainHead per box and the reading', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(HEALTH_ROWS);
    const out: any = await fleetTelemetry({ view: 'deploy' }, {
      userId: 'owner', now: NOW,
      getGithubToken: async () => 'tok',
      fetchHead: async () => ({ sha: '834efb4e0000000000000000000000000000ffff', committedAt: '2026-09-18T18:55:00Z', title: 'scheduling: cap-cadence guard at arm/update time (#858)' }),
      fetchRuns: async () => RUNS,
    });
    expect(out.mainHead).toMatchObject({ sha: '834efb4e' });
    expect(out.inFlight).toBe(true);
    expect(out.runs).toHaveLength(3);
    expect(out.runs[0]).toMatchObject({ id: 35383021971, sha: '834efb4e', status: 'in_progress', conclusion: null, url: 'https://gh/r/1' });
    expect(out.boxes.map((b: any) => [b.host, b.onMainHead])).toEqual([['box-a', true], ['box-b', true], ['box-c', false]]);
    expect(out.reading).toContain('main head is 834efb4e.');
    expect(out.reading).toContain('1 deploy run(s) in flight (834efb4e in_progress)');
    expect(out.reading).toContain('Last completed deploy run: 98e7d462 → cancelled (cancelled runs are normally a coalesced wave');
    expect(out.reading).toContain('On main head: box-a/web, box-b/web.');
    expect(out.reading).toContain('NOT on main head: box-c/worker runs b6fb4ad5.');
    // Reviewer finding 5: the with-token path carries the backup view too — this
    // assertion fails if `backup` or the backup clause is dropped from it.
    expect(out.backup).toMatchObject({ producers: ['box-a'], status: 'producer_unmounted' });
    expect(out.reading).toContain('its heartbeat is fresh but it reports NO dump reading at all');
  });

  it('a GitHub failure degrades to unavailable, never a throw', async () => {
    const out: any = await fleetTelemetry({ view: 'deploy' }, {
      userId: 'owner', now: NOW,
      getGithubToken: async () => 'tok',
      fetchHead: async () => { throw new Error('boom'); },
      fetchRuns: async () => { throw new Error('boom'); },
    });
    expect(out.mainHead).toBe('unavailable');
    expect(out.runs).toEqual([]);
    expect(out.inFlight).toBe(false);
  });

  // DEPLOY-WATCH-BLIND (2026-10-20): an empty runs list used to read as "no
  // runs" whatever GitHub answered — the view now names a read it could not make.
  describe('DEPLOY-WATCH-BLIND — "github: blind (<reason>)"', () => {
    afterEach(() => { delete process.env.INFRA_WATCH_BLIND_ALARM_DISABLED; });

    it('a refused deploy-runs read is blind (http_<n>), never an empty "no runs"; a thrown read is blind (network)', async () => {
      const out: any = await fleetTelemetry({ view: 'deploy' }, {
        userId: 'owner', now: NOW, getGithubToken: async () => 'tok', fetchHead: async () => null,
        fetchRunsWithStatus: async () => ({ runs: [], status: 401 }),
        readDeployWatchBlind: async () => null,
      });
      expect(out.github).toMatch(/^blind \(http_401\)/);
      expect(out.runs).toEqual([]);
      expect(out.reading).toContain('GitHub deploy runs are UNREADABLE (blind: http_401)');
      const thrown: any = await fleetTelemetry({ view: 'deploy' }, {
        userId: 'owner', now: NOW, getGithubToken: async () => 'tok', fetchHead: async () => null,
        fetchRuns: async () => { throw new Error('boom'); }, readDeployWatchBlind: async () => null,
      });
      expect(thrown.github).toMatch(/^blind \(network\)/);
    });

    it('no token for this user reads "blind (no_token)"; a 200 read carries no github field', async () => {
      const none: any = await fleetTelemetry({ view: 'deploy' }, { userId: 'u', now: NOW, getGithubToken: async () => null, readDeployWatchBlind: async () => null });
      expect(none.github).toMatch(/^blind \(no_token\) — no connected GitHub account/);
      const seeing: any = await fleetTelemetry({ view: 'deploy' }, {
        userId: 'owner', now: NOW, getGithubToken: async () => 'tok', fetchHead: async () => null,
        fetchRunsWithStatus: async () => ({ runs: RUNS, status: 200 }), readDeployWatchBlind: async () => null,
      });
      expect(seeing.github).toBeUndefined();
      expect(seeing.runs).toHaveLength(3);
      expect(seeing.deployWatch).toBeUndefined();
    });

    it('the infra-watch SWEEP\'s own blind episode rides the view even when this user\'s read works', async () => {
      const out: any = await fleetTelemetry({ view: 'deploy' }, {
        userId: 'owner', now: NOW, getGithubToken: async () => 'tok', fetchHead: async () => null,
        fetchRunsWithStatus: async () => ({ runs: RUNS, status: 200 }),
        readDeployWatchBlind: async () => ({ consecutive: 5, since: '2026-09-18T18:00:00.000Z', reason: 'no_token' }),
      });
      expect(out.deployWatch).toContain('Infra-watch deploy sweep is BLIND (no_token) since 2026-09-18T18:00:00.000Z (5 consecutive sweep(s))');
      expect(out.reading).toContain('Infra-watch deploy sweep is BLIND (no_token)');
    });

    it('kill switch INFRA_WATCH_BLIND_ALARM_DISABLED=1 restores the pre-change wording (no blind field, no sweep line)', async () => {
      process.env.INFRA_WATCH_BLIND_ALARM_DISABLED = '1';
      const readBlind = jest.fn(async () => ({ consecutive: 5, since: 'x', reason: 'no_token' as const }));
      const none: any = await fleetTelemetry({ view: 'deploy' }, { userId: 'u', now: NOW, getGithubToken: async () => null, readDeployWatchBlind: readBlind });
      expect(none.github).toMatch(/^unavailable — no connected GitHub account/);
      const refused: any = await fleetTelemetry({ view: 'deploy' }, {
        userId: 'owner', now: NOW, getGithubToken: async () => 'tok', fetchHead: async () => null,
        fetchRunsWithStatus: async () => ({ runs: [], status: 401 }), readDeployWatchBlind: readBlind,
      });
      expect(refused.github).toBeUndefined();
      expect(refused.deployWatch).toBeUndefined();
      expect(readBlind).not.toHaveBeenCalled();
    });
  });
});

describe('deployHealth (WI-M 2026-09-25 — shared with the REST admin job-health endpoint)', () => {
  it("view jobHealth carries deployHealth from the shared probe (the old 'not included here' note is gone)", async () => {
    mockPrisma.appErrorLog.count.mockResolvedValue(2);
    mockPrisma.userFeatureRequest.count.mockResolvedValue(1);
    const out: any = await fleetTelemetry({ view: 'jobHealth' }, { userId: 'u', now: NOW });
    expect(out.ok).toBe(true);
    expect(out.deployHealth).toEqual({ status: 'healthy', checkedAt: '2026-09-18T20:00:00.000Z', frontendCode: 200, backendCode: 200, baseUrl: 'https://digby.ai', cached: false });
    expect(out.note).toBeUndefined();
    expect(mockProbe).toHaveBeenCalledWith({ now: NOW });
    expect(out.errorSummary.last24h.error).toBe(2);
    expect(out.ticketPipeline.open).toBe(1);
  });

  it('view deploy carries deployHealth too (with and without a GitHub token)', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(HEALTH_ROWS);
    const noToken: any = await fleetTelemetry({ view: 'deploy' }, { userId: 'u', now: NOW, getGithubToken: async () => null });
    expect(noToken.deployHealth).toMatchObject({ status: 'healthy', frontendCode: 200, backendCode: 200 });
    const withToken: any = await fleetTelemetry({ view: 'deploy' }, { userId: 'u', now: NOW, getGithubToken: async () => 'tok', fetchHead: async () => null, fetchRuns: async () => [] });
    expect(withToken.deployHealth).toMatchObject({ status: 'healthy' });
  });

  it('an injected probeDeployHealth seam wins over the module; a throwing probe degrades to unknown, never a throw', async () => {
    const seam = jest.fn(async () => ({ status: 'skipped' as const, checkedAt: NOW.toISOString(), reason: 'DEPLOY_HEALTH_PROBE_DISABLED=1' }));
    const out: any = await fleetTelemetry({ view: 'jobHealth' }, { userId: 'u', now: NOW, probeDeployHealth: seam });
    expect(out.deployHealth).toMatchObject({ status: 'skipped', reason: expect.stringContaining('DEPLOY_HEALTH_PROBE_DISABLED') });
    expect(seam).toHaveBeenCalledWith(NOW);
    expect(mockProbe).not.toHaveBeenCalled();
    const boom: any = await fleetTelemetry({ view: 'jobHealth' }, { userId: 'u', now: NOW, probeDeployHealth: async () => { throw new Error('boom'); } });
    expect(boom.ok).toBe(true);
    expect(boom.deployHealth).toEqual({ status: 'unknown', checkedAt: NOW.toISOString() });
  });
});

describe('view deploy — deployInterrupts24h (WI-G, 2026-09-25)', () => {
  const INTERRUPT_ROWS = [
    { createdAt: new Date('2026-09-18T19:30:00Z'), sessionId: 'c0e22e36-0000-0000-0000-000000000000', meta: { reason: 'deploy', runKey: 'chat:c0e22e36', isSupervisorWake: true, runAgeSeconds: 910 } },
    { createdAt: new Date('2026-09-18T15:00:00Z'), sessionId: 'c0e22e36-0000-0000-0000-000000000000', meta: { reason: 'deploy', runKey: 'chat:c0e22e36' } },
    { createdAt: new Date('2026-09-18T12:00:00Z'), sessionId: 'abcdef01-0000-0000-0000-000000000000', meta: { reason: 'deploy', runKey: 'chat:abcdef01', isSupervisorWake: false } },
    { createdAt: new Date('2026-09-18T11:00:00Z'), sessionId: 'ffffffff-0000-0000-0000-000000000000', meta: { reason: 'user_stop', runKey: 'chat:ffffffff' } },
  ];
  const byKind = async (q: any) => (q?.where?.kind === 'chat_run_interrupted' ? INTERRUPT_ROWS : HEALTH_ROWS);

  it('counts deploy-reason interrupts per chat (24 h window), flags supervisor wakes, and names them in the reading — token or not', async () => {
    mockPrisma.loopMetric.findMany.mockImplementation(byKind);
    const out: any = await fleetTelemetry({ view: 'deploy' }, { userId: 'u', now: NOW, getGithubToken: async () => null });
    expect(out.deployInterrupts24h).toEqual({
      total: 3,
      supervisorWakes: 1,
      byChat: [{ chat: 'c0e22e36', count: 2 }, { chat: 'abcdef01', count: 1 }],
      lastAt: '2026-09-18T19:30:00.000Z',
    });
    expect(out.reading).toContain('3 chat run(s) were interrupted by deploy teardowns in the last 24 h (1 supervisor wake(s); chats c0e22e36×2, abcdef01×1)');
    const q = mockPrisma.loopMetric.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.kind === 'chat_run_interrupted');
    expect(q.where.createdAt.gte).toEqual(new Date(NOW.getTime() - 24 * 3600 * 1000));

    const withToken: any = await fleetTelemetry({ view: 'deploy' }, {
      userId: 'owner', now: NOW, getGithubToken: async () => 'tok',
      fetchHead: async () => ({ sha: '834efb4e0000000000000000000000000000ffff', committedAt: '2026-09-18T18:55:00Z', title: 't' }),
      fetchRuns: async () => [],
    });
    expect(withToken.deployInterrupts24h.total).toBe(3);
    expect(withToken.reading).toContain('interrupted by deploy teardowns');
  });

  it('zero interrupts adds nothing to the reading; a DB failure degrades to null, never a throw', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(HEALTH_ROWS);
    const clean: any = await fleetTelemetry({ view: 'deploy' }, { userId: 'u', now: NOW, getGithubToken: async () => null });
    expect(clean.deployInterrupts24h).toEqual({ total: 0, supervisorWakes: 0, byChat: [], lastAt: null });
    // THE POINT OF THIS TEST: zero interrupts contributes NO clause. (The base
    // sentence plus the ticket-533087b7 backup verdict may still be present.)
    expect(clean.reading).not.toContain('interrupted by deploy teardowns');
    expect(clean.reading).toContain('No deploy facts available.');

    mockPrisma.loopMetric.findMany.mockImplementation(async (q: any) => { if (q?.where?.kind === 'chat_run_interrupted') throw new Error('db down'); return HEALTH_ROWS; });
    const degraded: any = await fleetTelemetry({ view: 'deploy' }, { userId: 'u', now: NOW, getGithubToken: async () => null });
    expect(degraded.deployInterrupts24h).toBeNull();
    expect(degraded.boxes).toHaveLength(3);
  });

  it('a repo-scoped read carries no framework interrupt count (it is not that repo\'s fact)', async () => {
    mockPrisma.loopMetric.findMany.mockImplementation(byKind);
    const out: any = await fleetTelemetry({ view: 'deploy', repo: 'example-org/optcg' }, {
      userId: 'owner', now: NOW, getGithubToken: async () => 'tok',
      fetchRepoRuns: async () => ({ ok: true, runs: [] } as any),
      fetchRepoHead: async () => null,
    });
    expect(out.deployInterrupts24h).toBeUndefined();
  });
});

describe('readDeployPicture', () => {
  it('names the not-live-yet case when main head has no successful run and nothing is in flight', () => {
    const runs = shapeDeployRuns([
      { id: 2, head_sha: 'bbbbbbbb1', status: 'completed', conclusion: 'failure', created_at: '', updated_at: '', html_url: '' },
      { id: 1, head_sha: 'aaaaaaaa1', status: 'completed', conclusion: 'success', created_at: '', updated_at: '', html_url: '' },
    ]);
    const text = readDeployPicture({ sha: 'bbbbbbbb1' }, runs, [{ host: 'box-a', process: 'web', sha: 'aaaaaaaa' }]);
    expect(text).toContain('No successful deploy run for main head bbbbbbbb yet (last success aaaaaaaa): main is NOT what production runs.');
    expect(text).toContain('NOT on main head: box-a/web runs aaaaaaaa.');
  });

  it('explains a missing sha as a pre-passthrough process', () => {
    const text = readDeployPicture({ sha: 'cccccccc' }, [], [{ host: 'box-c', process: 'worker', sha: null }]);
    expect(text).toContain('No sha reported by box-c/worker');
  });

  it('renders a per-box worker-lag verdict when a lagging box reports a sha (the static backend-change sentence is gone)', () => {
    const boxes = [
      { host: 'box-a', process: 'web', sha: 'bbbbbbbb' },
      { host: 'box-c', process: 'worker', sha: 'aaaaaaaa' },
    ];
    const withVerdict = readDeployPicture({ sha: 'bbbbbbbb' }, [], boxes, null, [
      { box: 'box-c/worker', verdict: { kind: 'expected', changed: ['backend/src/x.test.ts'], reason: 'the un-rolled delta is a backend test-only or docs-only wave — the deploy script\'s input hash is unchanged' } },
    ]);
    expect(withVerdict).toContain('box-c/worker: lag EXPECTED — the un-rolled delta is a backend test-only or docs-only wave');
    expect(withVerdict).not.toContain('a lag after a backend change means');
    const real = readDeployPicture({ sha: 'bbbbbbbb' }, [], boxes, null, [
      { box: 'box-c/worker', verdict: { kind: 'real', changed: ['backend/src/foo.ts'], reason: 'worker inputs DID change (backend/src/foo.ts)' } },
    ]);
    expect(real).toContain('box-c/worker: lag REAL — worker inputs DID change');
  });
});

describe('classifyWorkerLag (2026-10-07 — the live box-c case that falsified the old static sentence)', () => {
  // Mirrors deploy-coding-worker.sh's input-hash find(1) rules — when that
  // script's HASH block changes, these expectations change with it.
  it('a backend *.test.ts-only delta is the by-design skip (the live 2026-10-07 box-c lag)', () => {
    const v = classifyWorkerLag([
      { filename: '.digby/notes/learnings.md' },
      { filename: 'AGENTS.md' },
      { filename: 'backend/src/modules/crossmodel/coding/journal-recurrence.f94.pin.test.ts' },
      { filename: 'frontend/app/account/FeedbackTab.tsx' },
      { filename: 'frontend/lib/sw-version.ts' },
      { filename: 'memory-bank/crossmodel-activeContext.md' },
      { filename: 'scripts/framework-audit/audit-live-state.js' },
    ]);
    expect(v.kind).toBe('expected');
    expect(v.reason).toContain('the deploy script\'s input hash is unchanged');
  });

  it('a real backend source change is a REAL lag pointing at the deploy step', () => {
    const v = classifyWorkerLag([{ filename: 'backend/src/modules/crossmodel/fleet/fleet-telemetry.ts' }, { filename: 'frontend/lib/x.ts' }]);
    expect(v.kind).toBe('real');
    expect(v.reason).toContain('worker inputs DID change (backend/src/modules/crossmodel/fleet/fleet-telemetry.ts)');
    expect(v.reason).toContain('"Deploy coding box" step failed or was skipped');
  });

  it('a REAL lag read while the head\'s deploy wave is still running is the mid-wave window, NOT a failed step (live 2026-10-09: all 4 boxes accused mid-run)', () => {
    const files = [
      { filename: 'backend/src/modules/crossmodel/coding/schedule.service.ts' },
      { filename: 'backend/src/modules/crossmodel/coding/schedule-delivery-rung.2c7cee17.test.ts' },
      { filename: 'backend/src/modules/crossmodel/platform/switch-registry.ts' },
      { filename: 'docker-compose.app.yml' },
    ];
    const midWave = classifyWorkerLag(files, { headDeployInFlight: true });
    expect(midWave.kind).toBe('real');
    expect(midWave.reason).toContain('STILL RUNNING');
    expect(midWave.reason).toContain('normal mid-wave window, not a deploy failure');
    // The false accusation must be GONE mid-wave…
    expect(midWave.reason).not.toContain('failed or was skipped');
    // …and the deferred escalation (what to do once the wave completes) present.
    expect(midWave.reason).toContain('persists past a COMPLETED wave');
    // The delta is still named either way — kind 'real' is unchanged so the
    // rollup seams keyed on kind are untouched (the *.test.ts is hash-excluded,
    // so the named inputs are the three real ones).
    expect(midWave.reason).toContain('worker inputs DID change (backend/src/modules/crossmodel/coding/schedule.service.ts, backend/src/modules/crossmodel/platform/switch-registry.ts, docker-compose.app.yml)');
    // And the exact same files with NO run in flight keep the old accusation.
    const settled = classifyWorkerLag(files);
    expect(settled.kind).toBe('real');
    expect(settled.reason).toContain('no deploy run for the current main head is in flight');
    expect(settled.reason).toContain('"Deploy coding box" step failed or was skipped');
  });

  it('the deferral arm: inputs changed but the head wave concluded inside the 2h self-heal bound is presumptively the benign window-defer, NOT lag REAL (2026-10-21 FO f175, WL-1 — 4th sighting)', () => {
    // The 1b569f27-wave inputs verbatim: step 17 concluded success with
    // "worker-rollout-window: deferred hash=6e21929a820d last_rollout_age=1651s
    // min_interval=1800s" — 44 min later the old verdict read lag REAL and cost
    // a dispatch round.
    const files = [
      { filename: 'backend/src/modules/crossmodel/platform/owner-questions.ts' },
      { filename: 'backend/src/modules/crossmodel/platform/secret-scan.ts' },
    ];
    const deferred = classifyWorkerLag(files, { headWaveAgeMs: 44 * 60 * 1000 });
    expect(deferred.kind).toBe('unknown');
    expect(deferred.reason).toContain('presumptively the benign window-defer');
    expect(deferred.reason).toContain('worker-rollout-window: deferred');
    expect(deferred.reason).toContain('WARNING: coding-worker deploy failed');
    expect(deferred.reason).toContain('worker inputs DID change (backend/src/modules/crossmodel/platform/owner-questions.ts, backend/src/modules/crossmodel/platform/secret-scan.ts)');
    // Past the 2h self-heal bound the failed-or-skipped verdict returns…
    const stale = classifyWorkerLag(files, { headWaveAgeMs: 3 * 3600 * 1000 });
    expect(stale.kind).toBe('real');
    expect(stale.reason).toContain('"Deploy coding box" step failed or was skipped');
    // …exactly at the bound too (the script force-rolls at pending_age >= 7200s).
    expect(classifyWorkerLag(files, { headWaveAgeMs: 2 * 3600 * 1000 }).kind).toBe('real');
    // No wave-age context keeps the old verdict (a missing wave IS suspicious).
    const noCtx = classifyWorkerLag(files);
    expect(noCtx.kind).toBe('real');
    expect(noCtx.reason).toContain('failed or was skipped');
    // A still-running wave keeps the mid-wave reading — the arm never masks it.
    const midWave = classifyWorkerLag(files, { headDeployInFlight: true, headWaveAgeMs: 5 * 60 * 1000 });
    expect(midWave.kind).toBe('real');
    expect(midWave.reason).toContain('STILL RUNNING');
  });

  it('the compose file and non-test backend files count as worker inputs; env/dist/tests/md under backend/ do not', () => {
    expect(classifyWorkerLag([{ filename: 'docker-compose.app.yml' }]).kind).toBe('real');
    expect(classifyWorkerLag([{ filename: 'backend/prisma/schema.prisma' }]).kind).toBe('real');
    // .spec.ts is NOT in the script's exclusion list (only *.test.ts) — it
    // flips the input hash and rebuilds, so it reads REAL. Mirrors exactly.
    expect(classifyWorkerLag([{ filename: 'backend/src/x.spec.ts' }]).kind).toBe('real');
    expect(classifyWorkerLag([{ filename: 'backend/src/x.test.ts' }, { filename: 'backend/README.md' }]).kind).toBe('expected');
    expect(classifyWorkerLag([{ filename: 'backend/.env.local' }, { filename: 'backend/dist/x.js' }]).kind).toBe('expected');
    expect(classifyWorkerLag([{ filename: 'frontend/public/sw.js' }]).kind).toBe('expected');
    expect(classifyWorkerLag([{ filename: 'docs/FRAMEWORK_OPERATOR.md' }]).kind).toBe('expected');
  });

  it('null/empty compare degrades honestly: null = classify by hand, [] = no changes at all', () => {
    expect(classifyWorkerLag(null).kind).toBe('unknown');
    expect(classifyWorkerLag(null).reason).toContain('classify by hand');
    const none = classifyWorkerLag([]);
    expect(none.kind).toBe('expected');
    expect(none.reason).toContain('no changed files at all');
  });
});

describe('view deploy — worker-lag verdicts (fetchCompare seam)', () => {
  it('classifies every lagging box through the compare seam and exposes workerLag; a compare failure degrades to unknown, never a throw', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(HEALTH_ROWS);
    const compare: jest.Mock = jest.fn(async (_t: string, base: string) =>
      base === 'b6fb4ad5'
        ? [{ filename: 'backend/src/modules/crossmodel/coding/journal-recurrence.f94.pin.test.ts' }, { filename: 'frontend/lib/sw-version.ts' }]
        : null);
    const out: any = await fleetTelemetry({ view: 'deploy' }, {
      userId: 'owner', now: NOW,
      getGithubToken: async () => 'tok',
      fetchHead: async () => ({ sha: '834efb4e0000000000000000000000000000ffff', committedAt: '2026-09-18T18:55:00Z', title: 't' }),
      fetchRuns: async () => [],
      fetchCompare: compare,
    });
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledWith('tok', 'b6fb4ad5', '834efb4e');
    expect(out.workerLag).toEqual([
      expect.objectContaining({ box: 'box-c/worker', kind: 'expected', changed: ['backend/src/modules/crossmodel/coding/journal-recurrence.f94.pin.test.ts', 'frontend/lib/sw-version.ts'] }),
    ]);
    expect(out.reading).toContain('box-c/worker: lag EXPECTED — the un-rolled delta is a backend test-only or docs-only wave');

    // A throwing compare seam degrades to the hand-classify line, not a throw.
    const boom: any = await fleetTelemetry({ view: 'deploy' }, {
      userId: 'owner', now: NOW,
      getGithubToken: async () => 'tok',
      fetchHead: async () => ({ sha: '834efb4e0000000000000000000000000000ffff', committedAt: '', title: '' }),
      fetchRuns: async () => [],
      fetchCompare: async () => { throw new Error('compare down'); },
    });
    expect(boom.workerLag[0].kind).toBe('unknown');
    expect(boom.reading).toContain('box-c/worker: compare unavailable — classify by hand');
  });

  it('a REAL lag is reported as the mid-wave window while the head\'s deploy run is still executing (2026-10-09 live case: all 4 boxes accused of a failed step mid-run)', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(HEALTH_ROWS);
    const out: any = await fleetTelemetry({ view: 'deploy' }, {
      userId: 'owner', now: NOW,
      getGithubToken: async () => 'tok',
      fetchHead: async () => ({ sha: '834efb4e0000000000000000000000000000ffff', committedAt: '2026-10-09T15:49:22Z', title: 't' }),
      fetchRuns: async () => [
        // The in-flight wave FOR the head — boxes lag it because it is running.
        { id: 1, head_sha: '834efb4e0000000000000000000000000000ffff', status: 'in_progress', conclusion: null, created_at: '', updated_at: '', html_url: '' },
      ] as any[],
      fetchCompare: async () => [{ filename: 'backend/src/modules/crossmodel/coding/schedule.service.ts' }, { filename: 'docker-compose.app.yml' }],
    });
    expect(out.inFlight).toBe(true);
    expect(out.workerLag[0].kind).toBe('real');
    expect(out.workerLag[0].reason).toContain('STILL RUNNING');
    expect(out.workerLag[0].reason).toContain('normal mid-wave window, not a deploy failure');
    expect(out.reading).toContain('box-c/worker: lag REAL — worker inputs DID change (backend/src/modules/crossmodel/coding/schedule.service.ts, docker-compose.app.yml) — but the deploy wave for the current main head is STILL RUNNING');
    // The false accusation must not appear anywhere in the mid-wave reading.
    expect(out.reading).not.toContain('failed or was skipped');
  });

  it('the settled case keeps the failed-step accusation: a completed (non-in-flight) run for the head with the box still lagging', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(HEALTH_ROWS);
    const out: any = await fleetTelemetry({ view: 'deploy' }, {
      userId: 'owner', now: NOW,
      getGithubToken: async () => 'tok',
      fetchHead: async () => ({ sha: '834efb4e0000000000000000000000000000ffff', committedAt: '2026-10-09T15:49:22Z', title: 't' }),
      fetchRuns: async () => [
        // Wave DONE for the head, boxes never picked it up — the real defect case.
        { id: 1, head_sha: '834efb4e0000000000000000000000000000ffff', status: 'completed', conclusion: 'success', created_at: '', updated_at: '', html_url: '' },
      ] as any[],
      fetchCompare: async () => [{ filename: 'backend/src/modules/crossmodel/coding/schedule.service.ts' }, { filename: 'docker-compose.app.yml' }],
    });
    expect(out.inFlight).toBe(false);
    expect(out.workerLag[0].kind).toBe('real');
    expect(out.workerLag[0].reason).toContain('no deploy run for the current main head is in flight');
    expect(out.workerLag[0].reason).toContain('"Deploy coding box" step failed or was skipped');
  });
});

describe("view collab (owner 2026-09-19: which lanes work alone and offline)", () => {
  const profile = (sessionId: string, meta: Record<string, unknown>, at = '2026-09-18T19:30:00Z') => ({ sessionId, meta, createdAt: new Date(at) });

  it('clampTelemetryArgs accepts the view', () => {
    expect(clampTelemetryArgs({ view: 'collab' })).toMatchObject({ view: 'collab', hours: TELEMETRY_DEFAULT_HOURS });
  });

  it('aggregates run_tool_profile rows per lane, names only the CALLER\'s chats, flags alone lanes at ≥ minRuns, includes supervisor rows', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      ...Array.from({ length: 5 }, (_, i) => profile('lane-a', { calls: 40, memory: 0, web: 0, delegate: 0, spawn: 0, messages: 1, connectors: 0, runCommand: 30, machine: true, seat: 'kimi-k3' }, `2026-09-18T1${i}:00:00Z`)),
      profile('lane-b', { calls: 20, memory: 3, web: 1, delegate: 0, spawn: 2, messages: 0, connectors: 0, runCommand: 5, machine: false, seat: 'glm-5.3' }),
      profile('lane-b', { calls: 10, memory: 1, web: 0, delegate: 1, spawn: 0, messages: 0, connectors: 0, runCommand: 2, machine: true, seat: 'glm-5.3' }),
      profile('sup-1', { calls: 12, memory: 0, web: 0, delegate: 0, spawn: 1, messages: 3, connectors: 0, runCommand: 0, machine: true, seat: 'kimi-k3' }),
      profile('foreign', { calls: 9, memory: 0, web: 0, delegate: 0, spawn: 0, messages: 0, connectors: 0, runCommand: 9, machine: true }),
    ]);
    mockPrisma.crossModelChat.findMany.mockImplementation(async ({ where }: any) => {
      expect(where.userId).toBe('owner'); // the per-user gate rides the chat lookup
      return [
        { id: 'lane-a', title: 'node-a Qwen3.8 Speed Mission Successor', isSupervisor: false, isProjectSupervisor: false, project: { name: 'tt-rd' } },
        { id: 'lane-b', title: 'Hardening Bench', isSupervisor: false, isProjectSupervisor: false, project: { name: 'crossmodel' } },
        { id: 'sup-1', title: 'Fleet Supervisor', isSupervisor: true, isProjectSupervisor: false, project: null },
      ]; // 'foreign' is another user's chat — never named
    });
    const out: any = await fleetTelemetry({ view: 'collab' }, { userId: 'owner', now: NOW });
    expect(out.ok).toBe(true);
    expect(out.minRuns).toBe(4);
    expect(out.lanes.map((l: any) => l.chat)).toEqual(['lane-a', 'lane-b', 'sup-1']); // sorted by runs desc; foreign absent
    const a = out.lanes[0];
    expect(a).toMatchObject({ runs: 5, machineRuns: 5, aloneRuns: 5, calls: 200, memory: 0, web: 0, delegate: 0, spawn: 0, messages: 5, runCommand: 150, alone: true, kind: 'lane', project: 'tt-rd', seats: ['kimi-k3'] });
    const b = out.lanes[1];
    expect(b).toMatchObject({ runs: 2, aloneRuns: 0, memory: 4, web: 1, delegate: 1, spawn: 2, alone: false });
    expect(out.lanes[2]).toMatchObject({ kind: 'fleet-supervisor', runs: 1, alone: false, aloneRuns: 0 }); // spawn counts as collaboration
    expect(out.totals).toEqual({ runs: 8, memory: 4, web: 1, delegate: 1, spawn: 3 });
    expect(out.reading).toContain('1 of 1 active lane(s) (≥ 4 runs) worked ALONE');
    expect(out.reading).toContain('lane-a "node-a Qwen3.8 Speed Mission Successor"');
  });

  it('with no profile rows yet the reading says so instead of declaring the fleet alone', async () => {
    const out: any = await fleetTelemetry({ view: 'collab' }, { userId: 'owner', now: NOW });
    expect(out.lanes).toEqual([]);
    expect(out.reading).toContain('no run_tool_profile rows in the window yet');
  });
});

/** audit budgets-cost-6 (2026-09-26): the 'boxes' view's decisionGate tile — latched (401/403) decision backends in the
 *  window, recovered or still active, and the all-legs-failed count — the read the [INFRA ALERT — decision backend down]
 *  playbook and verify step cite. */
describe('view boxes — decisionGate tile (budgets-cost-6)', () => {
  const t = (s: number) => new Date(NOW.getTime() - s * 1000);
  it('groups the backend-down rows per (spec, status): an open episode reads active with downSec to now, a recovered one carries recoveredAt; all_legs_failed counted; foreign rows ignored', async () => {
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.kind === 'decision_gate_backend_down') {
        return [
          { createdAt: t(60), meta: { event: 'relatched', spec: 'jev', backend: 'TypeSafe Jev', status: 403, purpose: 'wake_triage', relatches: 2, since: t(240).toISOString() } },
          { createdAt: t(150), meta: { event: 'latched', spec: 'jev', backend: 'TypeSafe Jev', status: 403, purpose: 'sweep_triage', relatches: 0, since: t(240).toISOString() } },
          { createdAt: t(300), meta: { event: 'recovered', spec: 'deepseek-flash', backend: 'DeepSeek logprob readout', status: 401, purpose: 'auto_route', downMs: 100_000, since: t(400).toISOString() } },
          { createdAt: t(400), meta: { event: 'latched', spec: 'deepseek-flash', backend: 'DeepSeek logprob readout', status: 401, purpose: 'auto_route', since: t(400).toISOString() } },
          { createdAt: t(500), meta: { event: 'all_legs_failed', purpose: 'drain_triage', streak: 1 } },
          { createdAt: t(520), meta: { host: 'box-a', diskPct: 10 } },
        ];
      }
      return HEALTH_ROWS;
    });
    const out: any = await fleetTelemetry({ view: 'boxes' }, { userId: 'owner', now: NOW });
    expect(out.ok).toBe(true);
    expect(out.boxes).toHaveLength(3);
    expect(out.decisionGate.active).toEqual(['jev']);
    expect(out.decisionGate.allLegsFailed).toBe(1);
    expect(out.decisionGate.backends).toHaveLength(2);
    expect(out.decisionGate.backends[0]).toMatchObject({ spec: 'jev', backend: 'TypeSafe Jev', status: 403, active: true, relatches: 2, recoveredAt: null, since: t(240).toISOString(), lastAt: t(60).toISOString(), downSec: 240 });
    expect(out.decisionGate.backends[1]).toMatchObject({ spec: 'deepseek-flash', status: 401, active: false, recoveredAt: t(300).toISOString(), since: t(400).toISOString(), downSec: 100 });
    expect(out.decisionGate.note).toBeUndefined();
  });

  it('says so when nothing was latched and every ask kept a leg', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(HEALTH_ROWS);
    const out: any = await fleetTelemetry({ view: 'boxes' }, { userId: 'owner', now: NOW });
    expect(out.decisionGate).toMatchObject({ backends: [], active: [], allLegsFailed: 0 });
    expect(out.decisionGate.note).toContain('no decision backend was latched');
  });

  /** Ticket e7b9521b (2026-10-12): only the process that latched a backend can write its 'recovered' row
   *  (platform/decision-gate.ts noteBackendAuthRecovered early-returns when the running process holds no latch),
   *  so when the latch-holder dies latched (a DRAINING worker replaced mid-outage, still on the revoked key) the
   *  episode stays open in the rows forever and the tile read active for the whole 24 h row window while the live
   *  fleet was healthy. The fix: an open episode whose newest latched/relatched row is older than
   *  DECISION_DOWN_STALE_MS reads stale (inactive) — a live outage cannot cross that horizon because every elapsed
   *  latch cooldown (authLatchMs, clamped 10 s..10 min) that sees an ask writes a fresh latched/relatched row. */
  it('reads an open episode STALE (inactive) once its newest latch row is older than DECISION_DOWN_STALE_MS — the latch-holder died latched and can never write the recovered row (e7b9521b)', async () => {
    // The incident's exact shape: a relatch, then NOTHING for past the horizon — the drain worker that held the
    // latch was replaced and no recovered row exists. The fixture is built FROM the exported constant so the
    // horizon is pinned, not merely bracketed: lastAt sits exactly 1 s past DECISION_DOWN_STALE_MS.
    const pastHorizonS = Math.round(DECISION_DOWN_STALE_MS / 1000) + 1;
    const relatchAgeS = pastHorizonS + 310;
    const latchedAgeS = pastHorizonS + 400;
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.kind === 'decision_gate_backend_down') {
        return [
          { createdAt: t(relatchAgeS), meta: { event: 'relatched', spec: 'jev', backend: 'TypeSafe Jev', status: 401, purpose: 'sweep_triage', relatches: 84, since: t(latchedAgeS) } },
          { createdAt: t(latchedAgeS), meta: { event: 'latched', spec: 'jev', backend: 'TypeSafe Jev', status: 401, purpose: 'wake_triage', relatches: 0, since: t(latchedAgeS) } },
        ];
      }
      return HEALTH_ROWS;
    });
    const out: any = await fleetTelemetry({ view: 'boxes' }, { userId: 'owner', now: NOW });
    expect(out.decisionGate.active).toEqual([]); // the tile the playbook checks is empty
    expect(out.decisionGate.backends).toHaveLength(1);
    expect(out.decisionGate.backends[0]).toMatchObject({ spec: 'jev', status: 401, active: false, stale: true, recoveredAt: null, relatches: 84 });
    expect(out.decisionGate.backends[0].downSec).toBe(90); // frozen at the newest row (relatch 310 s after the first latch), not climbing to now
    expect(out.decisionGate.note).toContain('stale');
    expect(out.decisionGate.note).toContain('jev');
    expect(out.decisionGate.note).toContain('died latched');
  });

  it('keeps an episode ACTIVE while its newest latch row is inside DECISION_DOWN_STALE_MS — a live outage keeps writing rows, and a recovered row still closes it at once', async () => {
    // The active fixture is built from the same constant: lastAt sits exactly 1 s INSIDE the horizon (and the
    // episode began past it — since is older — which must NOT matter; only the newest row's age does).
    const insideHorizonS = Math.round(DECISION_DOWN_STALE_MS / 1000) - 1;
    mockPrisma.loopMetric.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.kind === 'decision_gate_backend_down') {
        return [
          // fresh relatch — inside the horizon by 1 s, still latched
          { createdAt: t(insideHorizonS), meta: { event: 'relatched', spec: 'jev', backend: 'TypeSafe Jev', status: 403, purpose: 'auto_route', relatches: 12, since: t(insideHorizonS + 600) } },
          { createdAt: t(insideHorizonS + 600), meta: { event: 'latched', spec: 'jev', backend: 'TypeSafe Jev', status: 403, purpose: 'auto_route', relatches: 0, since: t(insideHorizonS + 600) } },
          // an episode whose newest latch row is past the horizon but which RECOVERED — recoveredAt still wins, stale:false
          { createdAt: t(Math.round(DECISION_DOWN_STALE_MS / 1000) + 100), meta: { event: 'latched', spec: 'deepseek-flash', backend: 'DeepSeek logprob readout', status: 401, purpose: 'drain_triage', relatches: 0, since: t(Math.round(DECISION_DOWN_STALE_MS / 1000) + 200) } },
          { createdAt: t(Math.round(DECISION_DOWN_STALE_MS / 1000) + 50), meta: { event: 'recovered', spec: 'deepseek-flash', backend: 'DeepSeek logprob readout', status: 401, purpose: 'drain_triage', downMs: 150_000, since: t(Math.round(DECISION_DOWN_STALE_MS / 1000) + 200) } },
        ];
      }
      return HEALTH_ROWS;
    });
    const out: any = await fleetTelemetry({ view: 'boxes' }, { userId: 'owner', now: NOW });
    expect(out.decisionGate.active).toEqual(['jev']); // fresh row: still the live outage it is
    const jev = out.decisionGate.backends.find((b: any) => b.spec === 'jev');
    expect(jev).toMatchObject({ active: true, stale: false, recoveredAt: null, relatches: 12 });
    expect(jev.downSec).toBe(insideHorizonS + 600); // since → now while active
    const ds = out.decisionGate.backends.find((b: any) => b.spec === 'deepseek-flash');
    expect(ds).toMatchObject({ active: false, stale: false, recoveredAt: t(Math.round(DECISION_DOWN_STALE_MS / 1000) + 50).toISOString(), relatches: 0 });
  });
});

/**
 * Ticket 9c0caf1c — a single `boxes` read is not evidence by itself.
 *
 * Two supervisors published, then retracted, a "box-a flipped to <sha>" claim
 * during a coalesced deploy wave on 2026-10-30: `boxes` handed back one bare
 * sha per surface with nothing saying whether it was a settled state or a
 * transient mid-wave reading, so a one-read claim was unfalsifiable. These
 * tests pin the three outcomes the ticket names — a settled read, a mid-flap
 * read, and a wave-in-flight read — plus the rule that an UNREAD wave is never
 * reported as "no wave".
 */
describe('ticket 9c0caf1c — boxes sha evidence', () => {
  const shaRows = (spec: Array<{ at: string; host: string; process: string; sha: string }>) =>
    spec.map((r) => ({
      createdAt: new Date(r.at),
      meta: { host: r.host, process: r.process, sha: r.sha, diskPct: 10, diskFreeGb: 900, memFreePct: 50, load1: 0.2 },
    }));
  const COMPLETED = [
    { id: 9001, head_sha: 'aaaaaaaa0000000000000000000000000000ffff', status: 'completed', conclusion: 'success', display_title: 'fix: something', created_at: '2026-09-18T18:00:00Z', updated_at: '2026-09-18T18:30:00Z', html_url: 'https://gh/r/9' },
  ];
  const RUNNING = [
    { id: 9002, head_sha: 'bbbbbbbb0000000000000000000000000000ffff', status: 'in_progress', conclusion: null, display_title: 'fix: next', created_at: '2026-09-18T19:40:00Z', updated_at: '2026-09-18T19:45:00Z', html_url: 'https://gh/r/10' },
    ...COMPLETED,
  ];
  const readWith = (runs: any[]) => ({
    userId: 'owner', now: NOW,
    getGithubToken: async () => 'tok',
    fetchHead: async () => null,
    fetchRuns: async () => runs,
  });

  it('SETTLED: a sha continuously reported past the flap window with a corroborating row is citable', async () => {
    // three readings across 40 min on the same sha — the shape of a landed deploy
    mockPrisma.loopMetric.findMany.mockResolvedValue(shaRows([
      { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T19:20:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T18:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'boxes' }, readWith(COMPLETED));
    const box = out.boxes[0];
    expect(box).toMatchObject({ host: 'box-a', process: 'web', sha: '834efb4e', shaState: 'settled', shaRows: 3, shaChanges: 1, settled: true, previousSha: null });
    expect(box.shaSince).toBe('2026-09-18T18:50:00.000Z'); // the EARLIEST row carrying the sha = the real first observation
    expect(box.shaAgeMin).toBe(70);                          // 18:50 → 20:00
    expect(out.shaEvidence).toMatchObject({ settled: true, code: 'settled' });
    expect(out.shaEvidence.reason).toContain('citable as settled serving state');
    expect(out.deployWave).toMatchObject({ read: 'read', inFlight: false });
  });

  it('MID-FLAP: a sha that changed inside the flap window is never settled, and the previous sha is named', async () => {
    // box-a flipped 834efb4e → cccccccc ten minutes ago
    mockPrisma.loopMetric.findMany.mockResolvedValue(shaRows([
      { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: 'cccccccc' },
      { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: 'cccccccc' },
      { at: '2026-09-18T19:40:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T19:10:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'boxes' }, readWith(COMPLETED));
    const box = out.boxes[0];
    expect(box).toMatchObject({ sha: 'cccccccc', shaState: 'flapping', shaChanges: 2, settled: false, previousSha: '834efb4e' });
    expect(box.previousShaAt).toBe('2026-09-18T19:40:00.000Z');
    expect(out.shaEvidence).toMatchObject({ settled: false, code: 'flapping' });
    expect(out.shaEvidence.reason).toContain('box-a/web');
    expect(out.shaEvidence.reason).toContain('may be catching the box mid-flip');
  });

  it('A→B→A is a flap, not a stable sha (contiguous runs, not a distinct-sha set)', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(shaRows([
      { at: '2026-09-18T19:55:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T19:45:00Z', host: 'box-a', process: 'web', sha: 'cccccccc' },
      { at: '2026-09-18T19:30:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T19:00:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'boxes' }, readWith(COMPLETED));
    expect(out.boxes[0]).toMatchObject({ sha: '834efb4e', shaChanges: 3, shaState: 'flapping', settled: false });
    expect(out.shaEvidence.code).toBe('flapping');
  });

  it('WAVE IN FLIGHT: the view names the running deploy and refuses to call any sha settled', async () => {
    // the same stable-looking history as the settled case, but a wave is running
    mockPrisma.loopMetric.findMany.mockResolvedValue(shaRows([
      { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T19:20:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T18:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'boxes' }, readWith(RUNNING));
    expect(out.deployWave).toMatchObject({ read: 'read', inFlight: true });
    expect(out.deployWave.runs[0]).toMatchObject({ id: 9002, sha: 'bbbbbbbb', status: 'in_progress' });
    expect(out.deployWave.newest).toMatchObject({ id: 9002, sha: 'bbbbbbbb' });
    // the box's own history looked settled — the in-flight wave downgrades it
    expect(out.boxes[0]).toMatchObject({ shaState: 'flapping', settled: false });
    expect(out.shaEvidence).toMatchObject({ settled: false, code: 'wave_in_flight' });
    expect(out.shaEvidence.reason).toContain('deploy run 9002');
    expect(out.shaEvidence.reason).toContain('still moving');
    expect(out.inFlight).toBe(true); // the top-level flag the acceptance asks for
  });

  it('UNCONFIRMED: one row, no corroborating reading — not settled even when the sha looks old', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(shaRows([
      { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'boxes' }, readWith(COMPLETED));
    expect(out.boxes[0]).toMatchObject({ shaState: 'unconfirmed', shaRows: 1, settled: false });
    expect(out.shaEvidence).toMatchObject({ settled: false, code: 'unconfirmed' });
    expect(out.shaEvidence.reason).toContain('SINGLE box_health row');
  });

  it('UNREAD WAVE: no GitHub account is "wave_unread", never "no wave in flight"', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(shaRows([
      { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T19:20:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T18:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'boxes' }, { userId: 'owner', now: NOW, getGithubToken: async () => null });
    expect(out.deployWave).toMatchObject({ read: 'unavailable', inFlight: null });
    expect(out.deployWave.inFlight).not.toBe(false); // the whole point: unread ≠ "no wave"
    expect(out.shaEvidence).toMatchObject({ settled: false, code: 'wave_unread' });
    expect(out.shaEvidence.reason).toContain('could not be read');
  });

  it('a refused deploy-runs read stays blind, not an empty "no runs"', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(shaRows([
      { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T19:20:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T18:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'boxes' }, {
      userId: 'owner', now: NOW, getGithubToken: async () => 'tok',
      fetchRunsWithStatus: async () => ({ runs: [], status: 401 }),
    });
    expect(out.deployWave).toMatchObject({ read: 'blind', inFlight: null });
    expect(out.shaEvidence.code).toBe('wave_unread');
  });

  it('a wave in flight puts the reason on the view note so a skim cannot miss it', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(shaRows([
      { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T19:20:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'boxes' }, readWith(RUNNING));
    expect(out.note).toContain('deploy run 9002');
    expect(out.note).toContain('settled state');
  });

  it('the deploy view carries the same annotation — reading its sibling cannot bypass the protection', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(shaRows([
      { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: 'cccccccc' },
      { at: '2026-09-18T19:40:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'deploy' }, readWith(COMPLETED));
    expect(out.boxes[0]).toMatchObject({ sha: 'cccccccc', shaState: 'flapping', previousSha: '834efb4e' });
    expect(out.shaEvidence).toMatchObject({ settled: false, code: 'flapping' });
    expect(out.reading).toContain('SHA EVIDENCE:');
  });

  it('a box that reports no sha is unknown, not settled', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue([
      { createdAt: new Date('2026-09-18T19:50:00Z'), meta: { host: 'box-z', process: 'web', diskPct: 1, diskFreeGb: 900, memFreePct: 50, load1: 0.1 } },
      ...shaRows([
        { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
        { at: '2026-09-18T19:20:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
        { at: '2026-09-18T18:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      ]),
    ]);
    const out: any = await fleetTelemetry({ view: 'boxes' }, readWith(COMPLETED));
    const z = out.boxes.find((b: any) => b.host === 'box-z');
    expect(z).toMatchObject({ sha: null, shaState: 'unknown', settled: false });
    // and it does not block a genuinely settled fleet
    expect(out.shaEvidence).toMatchObject({ settled: true, code: 'settled' });
  });
});

/** Reviewer-hardening (ticket 9c0caf1c): the history builder's edge cases —
 *  interleaved surfaces, rows with no sha, and the exact flap-window boundary. */
describe('ticket 9c0caf1c — boxShaTransitions / classifyBoxSha edge cases', () => {
  const r = (at: string, host: string, process: string, sha: string | null) => ({ at: new Date(at), host, process, sha });

  it('interleaved surfaces do not cross-contaminate', () => {
    const h = boxShaTransitions([
      r('2026-09-18T19:55:00Z', 'box-a', 'web', 'aaaa1111'),
      r('2026-09-18T19:54:00Z', 'box-b', 'web', 'bbbb2222'),
      r('2026-09-18T19:30:00Z', 'box-a', 'web', 'aaaa1111'),
      r('2026-09-18T19:29:00Z', 'box-b', 'web', 'cccc3333'),
    ], NOW);
    expect(h.get('box-a/web')).toMatchObject({ sha: 'aaaa1111', shaRows: 2, shaChanges: 1 });
    // box-b's previous sha was last seen at 19:29 — BEFORE the 19:30 window edge,
    // so it is not a change INSIDE the window; and one row cannot corroborate the
    // new sha, so 'unconfirmed' (never 'settled'). Both surfaces stay distinct.
    expect(h.get('box-b/web')).toMatchObject({ sha: 'bbbb2222', previousSha: 'cccc3333', shaChanges: 1, state: 'unconfirmed' });
  });

  it('a previous sha seen INSIDE the window is a flap', () => {
    const h = boxShaTransitions([
      r('2026-09-18T19:55:00Z', 'box-b', 'web', 'bbbb2222'),
      r('2026-09-18T19:50:00Z', 'box-b', 'web', 'bbbb2222'),
      r('2026-09-18T19:40:00Z', 'box-b', 'web', 'cccc3333'),
      r('2026-09-18T19:00:00Z', 'box-b', 'web', 'cccc3333'),
    ], NOW);
    expect(h.get('box-b/web')).toMatchObject({ sha: 'bbbb2222', shaRows: 2, previousSha: 'cccc3333', shaChanges: 2, state: 'flapping' });
  });

  it('a row carrying NO sha splits the run — it never merges into a real sha run', () => {
    const h = boxShaTransitions([
      r('2026-09-18T19:55:00Z', 'box-a', 'web', 'aaaa1111'),
      r('2026-09-18T19:50:00Z', 'box-a', 'web', null),
      r('2026-09-18T19:20:00Z', 'box-a', 'web', 'aaaa1111'),
      r('2026-09-18T19:00:00Z', 'box-a', 'web', 'aaaa1111'),
    ], NOW);
    // the newest run holds ONE row; the null row is its own run, so this is a flap
    expect(h.get('box-a/web')).toMatchObject({ sha: 'aaaa1111', shaRows: 1, shaChanges: 2, state: 'flapping' });
  });

  it('a surface that never reported a sha is unknown, not settled', () => {
    const h = boxShaTransitions([r('2026-09-18T19:55:00Z', 'box-z', 'web', null)], NOW);
    expect(h.get('box-z/web')).toMatchObject({ sha: null, state: 'unknown' });
  });

  it('the flap-window boundary is inclusive at 30 min and flapping 1 ms inside it', () => {
    const at = (iso: string) => classifyBoxSha({ sha: 'a', shaSince: iso, newestAt: '2026-09-18T19:55:00.000Z', shaRows: 5, shaChanges: 1 }, NOW, 30 * 60 * 1000);
    expect(at('2026-09-18T19:30:00.000Z')).toBe('settled');   // exactly 30 min old
    expect(at('2026-09-18T19:30:00.001Z')).toBe('flapping');  // 1 ms younger
  });

  it('a genuinely flapping box can never be labelled settled', () => {
    // 2+ rows, old enough, but TWO sha runs inside the window
    expect(classifyBoxSha({ sha: 'a', shaSince: '2026-09-18T18:00:00Z', newestAt: '2026-09-18T19:55:00.000Z', shaRows: 9, shaChanges: 3 }, NOW)).toBe('flapping');
  });
});

/** Reviewer-hardening round 2 (ticket 9c0caf1c): the five findings from the
 *  independent adversarial review of the first cut — each is the exact
 *  fabrication class this ticket exists to close, pinned by a regression test. */
describe('ticket 9c0caf1c — reviewer findings', () => {
  const COMPLETED_RUNS = [
    { id: 9001, head_sha: 'aaaaaaaa0000000000000000000000000000ffff', status: 'completed', conclusion: 'success', display_title: 'fix: something', created_at: '2026-09-18T18:00:00Z', updated_at: '2026-09-18T18:30:00Z', html_url: 'https://gh/r/9' },
  ];
  const withRuns = (runs: any[]) => ({
    userId: 'owner', now: NOW,
    getGithubToken: async () => 'tok',
    fetchHead: async () => null,
    fetchRunsWithStatus: async () => ({ runs, status: 200 }),
    readDeployWatchBlind: async () => null,
  });
  const rows = (spec: Array<{ at: string; host: string; process: string; sha: string }>) =>
    spec.map((r) => ({
      createdAt: new Date(r.at),
      meta: { host: r.host, process: r.process, sha: r.sha, diskPct: 10, diskFreeGb: 900, memFreePct: 50, load1: 0.2 },
    }));
  const settledRows = () => rows([
    { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    { at: '2026-09-18T19:20:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    { at: '2026-09-18T18:50:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
  ]);

  it('FINDING 1: the blind-alarm kill switch never turns a refused read into "no wave"', async () => {
    // INFRA_WATCH_BLIND_ALARM_DISABLED=1 covers WORDING only — the wave stamp's
    // truth must be independent of it, or a 401 would yield settled:true.
    const prev = process.env.INFRA_WATCH_BLIND_ALARM_DISABLED;
    process.env.INFRA_WATCH_BLIND_ALARM_DISABLED = '1';
    try {
      mockPrisma.loopMetric.findMany.mockResolvedValue(settledRows());
      const out: any = await fleetTelemetry({ view: 'deploy' }, {
        userId: 'owner', now: NOW,
        getGithubToken: async () => 'tok',
        fetchHead: async () => null,
        fetchRunsWithStatus: async () => ({ runs: [], status: 401 }),
        readDeployWatchBlind: async () => null,
      });
      expect(out.deployWave).toMatchObject({ read: 'blind', inFlight: null });
      expect(out.shaEvidence).toMatchObject({ settled: false, code: 'wave_unread' });
    } finally {
      if (prev === undefined) delete process.env.INFRA_WATCH_BLIND_ALARM_DISABLED;
      else process.env.INFRA_WATCH_BLIND_ALARM_DISABLED = prev;
    }
  });

  it('FINDING 2: a skipped read (non-prod, no watch repo) is blind in BOTH views — the siblings agree', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(settledRows());
    const deps = {
      userId: 'owner', now: NOW,
      getGithubToken: async () => 'tok',
      fetchHead: async () => null,
      fetchRunsWithStatus: async () => ({ runs: [], status: null, skipped: 'no_repo' as const }),
      readDeployWatchBlind: async () => null,
    };
    const boxes: any = await fleetTelemetry({ view: 'boxes' }, deps);
    const deploy: any = await fleetTelemetry({ view: 'deploy' }, deps);
    expect(boxes.deployWave.read).toBe('blind');
    expect(deploy.deployWave.read).toBe('blind');
    expect(deploy.shaEvidence.settled).toBe(false);
  });

  it('FINDING 3: a box silent past the freshness threshold is stale, never settled', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(rows([
      { at: '2026-09-18T18:55:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T18:25:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
      { at: '2026-09-18T17:55:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'boxes' }, withRuns(COMPLETED_RUNS));
    expect(out.boxes[0]).toMatchObject({ sha: '834efb4e', shaState: 'stale', settled: false });
    expect(out.shaEvidence).toMatchObject({ settled: false, code: 'stale' });
    expect(out.shaEvidence.reason).toContain('RAN');
  });

  it('FINDING 4: an HTTP 200 whose body has no workflow_runs array is blind, not "no wave"', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(settledRows());
    const out: any = await fleetTelemetry({ view: 'boxes' }, {
      userId: 'owner', now: NOW,
      getGithubToken: async () => 'tok',
      fetchRunsWithStatus: async () => ({ runs: [], status: 200, malformed: true }),
    });
    expect(out.deployWave).toMatchObject({ read: 'blind', inFlight: null });
    expect(out.shaEvidence).toMatchObject({ settled: false, code: 'wave_unread' });
  });

  it('FINDING 5: the deploy view carries settled + previousShaAt exactly like the boxes view', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue(rows([
      { at: '2026-09-18T19:50:00Z', host: 'box-a', process: 'web', sha: 'cccccccc' },
      { at: '2026-09-18T19:40:00Z', host: 'box-a', process: 'web', sha: '834efb4e' },
    ]));
    const out: any = await fleetTelemetry({ view: 'deploy' }, withRuns(COMPLETED_RUNS));
    const b = out.boxes[0];
    expect(b.shaState).toBe('flapping');
    expect('settled' in b).toBe(true);
    expect('previousShaAt' in b).toBe(true);
    expect(b.settled).toBe(false);
    expect(b.previousShaAt).toBe('2026-09-18T19:40:00.000Z');
  });
});
