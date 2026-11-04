/**
 * agent_events retention (owner 2026-09-22). Pins: the sweep walks the PK from
 * the oldest row in bounded ranges and deletes whole expired ranges; at the
 * boundary range it deletes only the expired rows and stops; it never touches a
 * range whose oldest row is inside the window; dry run counts one range and
 * deletes nothing; the kill switch does nothing; a misconfigured retention
 * below 7 days is clamped; one metric row per tick that found work.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), LOOP_METRIC_KINDS: { AGENT_EVENTS_RETENTION: 'agent_events_retention' } }));
const mockQuery: jest.Mock = jest.fn();
const mockExecute: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { $queryRawUnsafe: (...a: any[]) => mockQuery(...a), $executeRawUnsafe: (...a: any[]) => mockExecute(...a) } }));
// MERGE-1 slice 1: the service now imports the read-switch from coding-data.service,
// which reaches middleware/error-handler -> config/env, which calls process.exit(1)
// without env vars and kills the whole jest worker at import time. Mock AppError (same
// shape) exactly as coding-data.service.test.ts does.
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); }
  },
}));

import { runAgentEventsRetentionOnce, retentionDays, DEFAULT_RETENTION_DAYS } from './agent-events-retention.service';

const NOW = new Date('2026-09-22T18:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

/** An in-memory table: rows {id, createdAt}; the mock answers the three SQL shapes the sweep uses. */
function table(rows: Array<{ id: number; createdAt: Date }>) {
  const live = () => rows.filter((r) => !(r as any).deleted);
  mockQuery.mockImplementation(async (sql: string, ...params: any[]) => {
    if (sql.includes('ORDER BY id ASC LIMIT 1')) { const r = live().sort((a, b) => a.id - b.id)[0]; return r ? [{ id: BigInt(r.id), createdAt: r.createdAt }] : []; }
    if (sql.includes('MAX("createdAt") AS newest')) { const [lo, hi] = params.map(Number); const inR = live().filter((r) => r.id >= lo && r.id < hi); return [{ n: BigInt(inR.length), newest: inR.length ? new Date(Math.max(...inR.map((r) => r.createdAt.getTime()))) : null }]; }
    if (sql.includes('COUNT(*)::bigint AS n FROM agent_events WHERE id >= $1 AND id < $2 AND "createdAt" < $3')) { const [lo, hi, cutoff] = params; return [{ n: BigInt(live().filter((r) => r.id >= Number(lo) && r.id < Number(hi) && r.createdAt < cutoff).length) }]; }
    throw new Error(`unexpected query ${sql}`);
  });
  mockExecute.mockImplementation(async (sql: string, ...params: any[]) => {
    const [lo, hi, cutoff] = params;
    let n = 0;
    for (const r of rows) {
      if ((r as any).deleted) continue;
      if (r.id >= Number(lo) && r.id < Number(hi) && (!cutoff || r.createdAt < cutoff)) { (r as any).deleted = true; n++; }
    }
    return n;
  });
  return { remaining: () => live().map((r) => r.id) };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ['AGENT_EVENTS_RETENTION_DISABLED', 'AGENT_EVENTS_RETENTION_DRY_RUN', 'AGENT_EVENTS_RETENTION_DAYS', 'AGENT_EVENTS_RETENTION_BATCH', 'AGENT_EVENTS_RETENTION_MAX_BATCHES']) delete process.env[k];
});

describe('runAgentEventsRetentionOnce', () => {
  it('deletes whole expired PK ranges oldest-first, trims the boundary range to expired rows only, and stops there', async () => {
    process.env.AGENT_EVENTS_RETENTION_BATCH = '100';
    process.env.AGENT_EVENTS_RETENTION_MAX_BATCHES = '10';
    const rows = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: 1 + i, createdAt: at(60) })),      // range 1..100: all expired
      ...Array.from({ length: 100 }, (_, i) => ({ id: 101 + i, createdAt: at(45) })),    // range 101..200: all expired
      ...Array.from({ length: 50 }, (_, i) => ({ id: 201 + i, createdAt: at(31) })),     // boundary range 201..300: half expired…
      ...Array.from({ length: 50 }, (_, i) => ({ id: 251 + i, createdAt: at(2) })),      // …half live
      ...Array.from({ length: 20 }, (_, i) => ({ id: 301 + i, createdAt: at(1) })),      // live
    ];
    const t = table(rows);
    const r = await runAgentEventsRetentionOnce(NOW);
    expect(r.mode).toBe('delete');
    expect(r.rows).toBe(250);
    expect(r.batches).toBe(3);
    expect(r.reachedBoundary).toBe(true);
    expect(t.remaining().length).toBe(70);
    expect(Math.min(...t.remaining())).toBe(251);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent_events_retention', value: 250, meta: expect.objectContaining({ mode: 'delete', batches: 3, reachedBoundary: true }) }));
  });

  it('caps the work per tick and leaves the rest for the next tick', async () => {
    process.env.AGENT_EVENTS_RETENTION_BATCH = '100'; // the floor — smaller values clamp up
    process.env.AGENT_EVENTS_RETENTION_MAX_BATCHES = '2';
    const t = table(Array.from({ length: 250 }, (_, i) => ({ id: 1 + i, createdAt: at(90) })));
    const r = await runAgentEventsRetentionOnce(NOW);
    expect(r.rows).toBe(200);
    expect(r.batches).toBe(2);
    expect(r.reachedBoundary).toBe(false);
    expect(t.remaining().length).toBe(50);
  });

  it('a table whose oldest row is inside the window is left alone (no delete, no metric)', async () => {
    table(Array.from({ length: 30 }, (_, i) => ({ id: 1 + i, createdAt: at(3) })));
    const r = await runAgentEventsRetentionOnce(NOW);
    expect(r.rows).toBe(0);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    expect(r.reachedBoundary).toBe(true);
  });

  it('dry run counts one range and deletes nothing; the kill switch does nothing at all', async () => {
    process.env.AGENT_EVENTS_RETENTION_DRY_RUN = '1';
    process.env.AGENT_EVENTS_RETENTION_BATCH = '100';
    const t = table(Array.from({ length: 300 }, (_, i) => ({ id: 1 + i, createdAt: at(60) })));
    const r = await runAgentEventsRetentionOnce(NOW);
    expect(r.mode).toBe('dry_run');
    expect(r.rows).toBe(100);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(t.remaining().length).toBe(300);
    delete process.env.AGENT_EVENTS_RETENTION_DRY_RUN;
    process.env.AGENT_EVENTS_RETENTION_DISABLED = '1';
    const off = await runAgentEventsRetentionOnce(NOW);
    expect(off.mode).toBe('disabled');
    expect(mockQuery).toHaveBeenCalledTimes(2); // only the dry run's two reads
  });

  it('retention days default to 30 and never drop below 7', () => {
    expect(retentionDays()).toBe(DEFAULT_RETENTION_DAYS);
    process.env.AGENT_EVENTS_RETENTION_DAYS = '1';
    expect(retentionDays()).toBe(7);
    process.env.AGENT_EVENTS_RETENTION_DAYS = 'junk';
    expect(retentionDays()).toBe(30);
  });
});
