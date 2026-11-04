/**
 * Dynamic SESSION-scope retention (owner 2026-09-24 "shouldn't session scope
 * memory be more dynamic"). Pins: a session store sweeps PER SOURCE with the
 * 24 h retention floor and then the scope-wide hard ceiling; project keeps its
 * per-source cap with no floor; user keeps the plain cap; the eviction metric
 * carries reason + minAgeHours.
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
  LOOP_METRIC_KINDS: { MEMORY_SCOPE_EVICTED: 'memory_scope_evicted' },
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import prisma from '../../../config/database';
import { memStore, memSearch, enforceScopeCap, applyStoreCap, SESSION_SCOPE_HARD_CAP_DEFAULT, SESSION_SCOPE_MIN_RETENTION_HOURS_DEFAULT, MEM_HIT_KEEP_DAYS_DEFAULT, sessionCeilingKeepOrderSql } from './unified-memory.service';

const mockExec = prisma.$executeRawUnsafe as jest.Mock;
const BODY = 'x'.repeat(260);
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
const deletes = () => mockExec.mock.calls.filter(([sql]: [string]) => isEviction(sql)).map((c: any[]) => unwrapEviction(c));

describe('dynamic session-scope retention', () => {
  beforeEach(() => { mockExec.mockClear(); mockRecordLoopMetric.mockClear(); delete process.env.SESSION_SCOPE_HARD_CAP; delete process.env.SESSION_SCOPE_MIN_RETENTION_HOURS; });

  it('a session store sweeps per source with the retention floor, then the scope-wide hard ceiling', async () => {
    expect(await memStore({ type: 'session', id: 's1' }, 'orchestrator', [{ content: BODY }])).toBe(1);
    const d = deletes();
    expect(d).toHaveLength(2);
    expect(d[0].sql).toContain('AND source = $3');
    expect(d[0].sql).toContain(`created_at < now() - make_interval(hours => ${SESSION_SCOPE_MIN_RETENTION_HOURS_DEFAULT})`);
    expect(d[0].sql).toContain('LIMIT 800');
    expect(d[0].params).toEqual(['session', 's1', 'orchestrator']);
    expect(d[1].sql).not.toContain('AND source =');
    expect(d[1].sql).not.toContain('created_at < now()'); // no retention floor on the ceiling (its keep ORDER is tiered — audit X2)
    expect(d[1].sql).toContain(`LIMIT ${SESSION_SCOPE_HARD_CAP_DEFAULT}`);
    expect(d[1].params).toEqual(['session', 's1']);
  });

  it('compaction rows have their own budget: the orchestrator sweep never names them', async () => {
    await memStore({ type: 'session', id: 's2' }, 'compaction', [{ content: BODY }]);
    expect(deletes()[0].params).toEqual(['session', 's2', 'compaction']);
  });

  it('project keeps its per-source cap without a floor; user keeps the plain cap', async () => {
    await applyStoreCap({ type: 'project', id: 'p1' }, 'code');
    await applyStoreCap({ type: 'user', id: 'u1' }, 'conversation');
    const d = deletes();
    expect(d).toHaveLength(2);
    expect(d[0].params).toEqual(['project', 'p1', 'code']); expect(d[0].sql).not.toContain('make_interval');
    expect(d[1].params).toEqual(['user', 'u1']); expect(d[1].sql).not.toContain('AND source =');
  });

  it('env tunes the floor and ceiling', async () => {
    process.env.SESSION_SCOPE_MIN_RETENTION_HOURS = '48'; process.env.SESSION_SCOPE_HARD_CAP = '9000';
    await applyStoreCap({ type: 'session', id: 's4' }, 'orchestrator');
    const d = deletes();
    expect(d[0].sql).toContain('make_interval(hours => 48)'); expect(d[1].sql).toContain('LIMIT 9000');
  });

  it('the eviction metric carries source, reason and the floor', async () => {
    mockExec.mockImplementation(async (sql: string) => (isEviction(sql) ? 7 : 0));
    await enforceScopeCap({ type: 'session', id: 's5' }, 800, 'orchestrator', { minAgeHours: 24, reason: 'source_cap' });
    await new Promise((r) => setTimeout(r, 5));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'memory_scope_evicted', value: 7, meta: expect.objectContaining({ source: 'orchestrator', reason: 'source_cap', minAgeHours: 24, cap: 800 }) }));
    mockExec.mockImplementation(async () => 0);
  });

  it('the session source cap is HIT-AWARE: recently-hit rows sort ahead of never-hit rows', async () => {
    await applyStoreCap({ type: 'session', id: 's6' }, 'orchestrator');
    const d = deletes();
    expect(d[0].sql).toContain(`ORDER BY (last_hit_at IS NOT NULL AND last_hit_at > now() - make_interval(days => ${MEM_HIT_KEEP_DAYS_DEFAULT})) DESC, created_at DESC`);
    expect(d[1].sql).toContain(sessionCeilingKeepOrderSql()); // the hard ceiling is TIERED since audit X2 (unified-memory.ceiling.test.ts)
  });
});

describe('hit stamping (memSearch → last_hit_at)', () => {
  const queryMock = prisma.$queryRawUnsafe as jest.Mock;
  const row = (id: string) => ({ id, ref: 'r', title: 't', source: 'orchestrator', content: 'c'.repeat(40), scope_type: 'session', scope_id: 's7', created_at: new Date() });
  beforeEach(() => { mockExec.mockClear(); queryMock.mockImplementation(async () => [row('m1'), row('m2')]); });
  afterEach(() => { queryMock.mockImplementation(async () => []); });

  it('stamps exactly the returned rows, fire-and-forget', async () => {
    const hits = await memSearch([{ type: 'session', id: 's7' }], 'what did the build say', 6);
    expect(hits.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 5));
    const upd = mockExec.mock.calls.find(([sql]: [string]) => typeof sql === 'string' && sql.startsWith('UPDATE digby_memory SET last_hit_at'));
    expect(upd).toBeDefined();
    expect(upd![1]).toEqual(expect.arrayContaining(['m1', 'm2']));
  });
});
