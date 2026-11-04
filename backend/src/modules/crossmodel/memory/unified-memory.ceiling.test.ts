/**
 * Audit 2026-10-06 finding 4 / X2: the session-scope HARD CEILING (6000 rows)
 * was pure recency, so a long-lived chat (the Fleet Supervisor) lost compaction
 * summaries, worker digests and just-retrieved rows to fresh tool-output
 * copies — a ~17 h memory span, ~97 % of offloads evicted unread. Pins: the
 * ceiling's keep set is tiered (hit → fresh → unique records → newest), the
 * re-fetchable source list covers every worker role, a `<role> digest` row is
 * never classed as a copy, the ceiling size is unchanged, the metric says
 * `tiered`, and MEMORY_CEILING_TIERED_EVICTION_DISABLED=1 restores recency.
 */
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { $executeRawUnsafe: jest.fn(async () => 0), $queryRawUnsafe: jest.fn(async () => []) },
}));
jest.mock('../rag.service', () => ({
  __esModule: true,
  embedTexts: jest.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  rerankTexts: jest.fn(async () => []),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { MEMORY_SCOPE_EVICTED: 'memory_scope_evicted', MEMORY_STORE_DEDUPED: 'memory_store_deduped' },
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import prisma from '../../../config/database';
import { ROLES } from '../coding/roles';
import {
  applyStoreCap, memStore, sessionCeilingKeepOrderSql, refetchableRowSql, REFETCHABLE_SESSION_SOURCES,
  MEMORY_CEILING_FRESH_HOURS, MEM_HIT_KEEP_DAYS_DEFAULT, SESSION_SCOPE_HARD_CAP_DEFAULT,
} from './unified-memory.service';

const mockExec = prisma.$executeRawUnsafe as jest.Mock;
// Archive-instead-of-delete (2026-10-20, memory-archive.ts): the eviction DELETE
// rides as the CTE of one atomic move into digby_memory_archive — unwrap it (the
// predicate is byte-identical) and drop the trailing archive_reason param.
const ARCHIVE_WRAP = 'WITH moved AS (';
const isEviction = (sql: unknown) => typeof sql === 'string' && /^(WITH moved AS \()?DELETE FROM digby_memory WHERE/.test(sql);
const unwrapEviction = (c: any[]) => {
  const raw = String(c[0]);
  const wrapped = raw.startsWith(ARCHIVE_WRAP);
  return { sql: wrapped ? raw.slice(ARCHIVE_WRAP.length, raw.indexOf(' RETURNING ')) : raw, params: wrapped ? c.slice(1, -1) : c.slice(1) };
};
const deletes = () => mockExec.mock.calls
  .filter(([sql]: [string]) => isEviction(sql))
  .map((c: any[]) => unwrapEviction(c));
const ceiling = () => deletes().find((d) => !d.sql.includes('AND source = $3'))!;

/** Evaluate refetchableRowSql() for one (source, ref) in JS — a tiny
 *  interpreter for exactly the shape the predicate emits. */
function isRefetchable(source: string, ref: string | null): boolean {
  const sql = refetchableRowSql();
  const list = /source IN \(([^)]*)\)/.exec(sql)![1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  return list.includes(source) && !/ digest$/.test(ref ?? '');
}

describe('session hard ceiling — tiered eviction (audit X2)', () => {
  beforeEach(() => {
    mockExec.mockReset(); mockExec.mockImplementation(async () => 0); mockRecordLoopMetric.mockClear();
    delete process.env.MEMORY_CEILING_TIERED_EVICTION_DISABLED; delete process.env.SESSION_SCOPE_HARD_CAP; delete process.env.MEM_HIT_KEEP_DAYS;
  });

  it('keep order: recently hit → fresh → unique records → newest; the ceiling size is unchanged', async () => {
    await applyStoreCap({ type: 'session', id: 'fleet' }, 'compaction');
    const c = ceiling();
    expect(c.params).toEqual(['session', 'fleet']);
    expect(c.sql).toContain(`LIMIT ${SESSION_SCOPE_HARD_CAP_DEFAULT}`);
    const order = c.sql.slice(c.sql.indexOf('ORDER BY'));
    const hit = order.indexOf(`last_hit_at > now() - make_interval(days => ${MEM_HIT_KEEP_DAYS_DEFAULT})`);
    const fresh = order.indexOf(`created_at > now() - make_interval(hours => ${MEMORY_CEILING_FRESH_HOURS})`);
    const unique = order.indexOf(`${refetchableRowSql()} ASC`);
    const newest = order.lastIndexOf('created_at DESC');
    expect(hit).toBeGreaterThan(-1);
    expect(fresh).toBeGreaterThan(hit);
    expect(unique).toBeGreaterThan(fresh);
    expect(newest).toBeGreaterThan(unique);
    expect(c.sql).toContain(sessionCeilingKeepOrderSql());
  });

  it('the per-source sweep is unchanged (hit-aware, retention floor, not tiered)', async () => {
    await applyStoreCap({ type: 'session', id: 's1' }, 'orchestrator');
    const src = deletes().find((d) => d.sql.includes('AND source = $3'))!;
    expect(src.sql).toContain('make_interval(hours => 24)');
    expect(src.sql).not.toContain('NOT LIKE');
  });

  it('every worker role (and the orchestrator / pipes) is a re-fetchable source; unique records are not', () => {
    for (const r of Object.keys(ROLES)) expect(REFETCHABLE_SESSION_SOURCES).toContain(r);
    for (const s of ['orchestrator', 'web_pipe', 'youtube_pipe']) expect(isRefetchable(s, 'src/app.ts')).toBe(true);
    expect(isRefetchable('explorer', 'backend/src/x.ts')).toBe(true);
    expect(isRefetchable('orchestrator', 'run_command: npm test')).toBe(true);
    // unique records: compaction summaries, receipt-backed intermediates, worker digests, unknown sources
    expect(isRefetchable('compaction', 'compacted earlier-run transcript (part 1/3)')).toBe(false);
    expect(isRefetchable('intermediate', 'intermediate:run1:4')).toBe(false);
    expect(isRefetchable('explorer', 'explorer digest')).toBe(false);
    expect(isRefetchable('cross_checker', 'cross_checker digest')).toBe(false);
    expect(isRefetchable('some_new_source', null)).toBe(false); // unknown ⇒ kept like a unique record
  });

  it('the eviction metric says tiered on the ceiling sweep', async () => {
    mockExec.mockImplementation(async (sql: string) => (isEviction(sql) && !String(sql).includes('AND source = $3') ? 42 : 0));
    await memStore({ type: 'session', id: 'fleet2' }, 'compaction', [{ content: 'x'.repeat(260) }]);
    await new Promise((r) => setTimeout(r, 5));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'memory_scope_evicted', value: 42,
      meta: expect.objectContaining({ reason: 'hard_ceiling', tiered: true, cap: SESSION_SCOPE_HARD_CAP_DEFAULT }),
    }));
  });

  it('kill switch MEMORY_CEILING_TIERED_EVICTION_DISABLED=1 restores pure recency', async () => {
    process.env.MEMORY_CEILING_TIERED_EVICTION_DISABLED = '1';
    mockExec.mockImplementation(async (sql: string) => (isEviction(sql) && !String(sql).includes('AND source = $3') ? 3 : 0));
    await applyStoreCap({ type: 'session', id: 'fleet3' }, 'compaction');
    const c = ceiling();
    expect(c.sql).toContain('ORDER BY created_at DESC LIMIT');
    expect(c.sql).not.toContain('last_hit_at');
    expect(c.sql).not.toContain('NOT LIKE');
    await new Promise((r) => setTimeout(r, 5));
    const meta = mockRecordLoopMetric.mock.calls.map((a) => a[0].meta).find((m) => m?.reason === 'hard_ceiling');
    expect(meta).toBeDefined();
    expect(meta.tiered).toBeUndefined();
  });

  it('project and user scopes never get the tiered order', async () => {
    await applyStoreCap({ type: 'project', id: 'p1' }, 'code');
    await applyStoreCap({ type: 'user', id: 'u1' }, 'conversation');
    for (const d of deletes()) expect(d.sql).not.toContain('NOT LIKE');
  });
});
