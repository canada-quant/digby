/**
 * Archive instead of delete (owner 2026-10-20: "archive instead of delete when a
 * store is full"). Before: enforceScopeCap's anti-join DELETE dropped evicted
 * rows for good (prod 2026-09-24: ~18k session rows / day). Pins:
 *   - ensureTable creates digby_memory_archive (no embedding, archived_at,
 *     archive_reason, scope / archived_at / FTS indexes); a DDL race that left
 *     the table in place still archives; a missing archive falls back to DELETE;
 *   - every keep-order variant (plain, hitAware, tiered, minAge floor) becomes
 *     ONE `WITH moved AS (<today's exact DELETE> RETURNING …) INSERT INTO
 *     digby_memory_archive` statement; the eviction metric keeps the count and
 *     says archived; a failing move falls back to the plain DELETE (logged once);
 *   - MEMORY_ARCHIVE_DISABLED=1 = today's DELETE byte-for-byte;
 *   - memClear / memDeleteRefs / an empty memReplaceRef purge archived copies
 *     (a replacement with items does not);
 *   - retention deletes by the two windows in bounded batches, never throws,
 *     one metric row;
 *   - memSearchArchive is FTS-only, scoped like memSearch, marks hits archived.
 */
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    $executeRawUnsafe: jest.fn(async () => 0), $queryRawUnsafe: jest.fn(async () => []),
    crossModelChat: { findMany: jest.fn(async () => [{ id: 's1', userId: 'u1', projectId: null }, { id: 's2', userId: 'someone-else', projectId: null }]) },
  },
}));
jest.mock('./memory-access', () => ({
  __esModule: true,
  authorizedProjectScopeIds: jest.fn(async (_u: string, ids: string[]) => ids.filter((id) => id === 'p-mine')),
  ownedProjectIds: jest.fn(async () => []),
  ownsAllProjects: jest.fn(async () => true),
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
  LOOP_METRIC_KINDS: { MEMORY_SCOPE_EVICTED: 'memory_scope_evicted', MEMORY_STORE_DEDUPED: 'memory_store_deduped', MEMORY_SEARCH_TIMING: 'memory_search_timing' },
}));
const mockWarn = jest.fn();
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: (...a: any[]) => mockWarn(...a), error: jest.fn(), debug: jest.fn() } }));

import prisma from '../../../config/database';
import {
  enforceScopeCap, applyStoreCap, memClear, memDeleteRefs, memReplaceRef, memSearchArchive, memSearchArchiveForUser,
  memArchiveRefs, memPurgeArchivedRefs, memPurgeArchivedRefsExcept,
  sessionCeilingKeepOrderSql, MEM_HIT_KEEP_DAYS_DEFAULT, SESSION_SCOPE_HARD_CAP_DEFAULT, __resetMemoryTablesForTests,
  runMemoryArchiveRetention as reexportedRetention,
} from './unified-memory.service';
import {
  archiveEvictionSql, archiveRefsEvictionSql, runMemoryArchiveRetention, ARCHIVE_MOVED_COLUMNS, ARCHIVE_PURGE_REFS_EXCEPT_SQL, ARCHIVE_SESSION_RETENTION_DAYS, ARCHIVE_RETENTION_DAYS,
  ARCHIVE_RETENTION_BATCH_DEFAULT, ARCHIVE_RETENTION_MAX_BATCHES_DEFAULT, ARCHIVE_DDL,
} from './memory-archive';

const mockExec = prisma.$executeRawUnsafe as jest.Mock;
const mockQuery = prisma.$queryRawUnsafe as jest.Mock;
const calls = () => mockExec.mock.calls.map((c: any[]) => ({ sql: String(c[0]), params: c.slice(1) }));
const moves = () => calls().filter((c) => c.sql.startsWith('WITH moved AS (DELETE FROM digby_memory WHERE'));
const plainDeletes = () => calls().filter((c) => c.sql.startsWith('DELETE FROM digby_memory WHERE'));
const archivePurges = () => calls().filter((c) => c.sql.startsWith('DELETE FROM digby_memory_archive'));
const COLS = 'id, scope_type, scope_id, user_id, source, ref, title, content, created_at, last_hit_at';
const settle = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  mockExec.mockReset(); mockExec.mockImplementation(async () => 0);
  mockQuery.mockReset(); mockQuery.mockImplementation(async () => []);
  mockRecordLoopMetric.mockClear(); mockWarn.mockClear();
  delete process.env.MEMORY_ARCHIVE_DISABLED; delete process.env.MEMORY_CEILING_TIERED_EVICTION_DISABLED;
  __resetMemoryTablesForTests();
});

/** Run one sweep with archiving ON and once with the kill switch, returning both statements. */
async function bothForms(run: () => Promise<void>): Promise<{ moved: { sql: string; params: any[] }[]; plain: { sql: string; params: any[] }[] }> {
  await run();
  const moved = moves();
  mockExec.mockClear();
  process.env.MEMORY_ARCHIVE_DISABLED = '1';
  await run();
  const plain = plainDeletes();
  delete process.env.MEMORY_ARCHIVE_DISABLED;
  return { moved, plain };
}

describe('archive table DDL', () => {
  it('ensureTable creates digby_memory_archive: no embedding, archived_at + archive_reason, scope / archived_at / FTS indexes', async () => {
    await enforceScopeCap({ type: 'user', id: 'u1' }, 800);
    const sqls = calls().map((c) => c.sql);
    const hot = sqls.find((s) => s.includes('CREATE TABLE IF NOT EXISTS digby_memory ('))!;
    expect(hot).toContain('embedding vector(1536)'); // the hot DDL is untouched
    const cold = sqls.find((s) => s.includes('CREATE TABLE IF NOT EXISTS digby_memory_archive ('))!;
    expect(cold).toBeDefined();
    expect(cold).not.toContain('embedding');
    for (const col of ARCHIVE_MOVED_COLUMNS) expect(cold).toMatch(new RegExp(`\\b${col} `));
    expect(cold).toContain('archived_at timestamptz NOT NULL DEFAULT now()');
    expect(cold).toContain('archive_reason text');
    expect(sqls).toContain('CREATE INDEX IF NOT EXISTS digby_mem_archive_scope_idx ON digby_memory_archive (scope_type, scope_id)');
    expect(sqls).toContain('CREATE INDEX IF NOT EXISTS digby_mem_archive_archived_at_idx ON digby_memory_archive (archived_at)');
    expect(sqls).toContain(`CREATE INDEX IF NOT EXISTS digby_mem_archive_fts_idx ON digby_memory_archive USING gin (to_tsvector('english', coalesce(title,'') || ' ' || content))`);
    expect(sqls.some((s) => s.includes('HNSW') || /digby_memory_archive USING hnsw/.test(s))).toBe(false);
  });

  it('a concurrent-boot race (CREATE fails, the table exists) still archives', async () => {
    mockExec.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('CREATE TABLE IF NOT EXISTS digby_memory_archive')) throw new Error('duplicate key value violates unique constraint "pg_type_typname_nsp_index"');
      return 0;
    });
    mockQuery.mockImplementation(async (sql: string) => (String(sql).includes('to_regclass') ? [{ ok: true }] : []));
    await enforceScopeCap({ type: 'user', id: 'u1' }, 800);
    expect(moves()).toHaveLength(1);
    expect(plainDeletes()).toHaveLength(0);
  });

  it('an archive that cannot be created falls back to the plain DELETE (warned once) — a cap is never skipped', async () => {
    mockExec.mockImplementation(async (sql: string) => {
      if (String(sql).includes('digby_memory_archive (')) throw new Error('permission denied for schema public');
      return 0;
    });
    await enforceScopeCap({ type: 'user', id: 'u1' }, 800);
    await enforceScopeCap({ type: 'user', id: 'u1' }, 800);
    expect(moves()).toHaveLength(0);
    expect(plainDeletes()).toHaveLength(2);
    expect(mockWarn.mock.calls.filter((c) => String(c[0]).includes('archive table digby_memory_archive unavailable'))).toHaveLength(1);
  });
});

describe('enforceScopeCap moves evicted rows into the archive (same predicate as today)', () => {
  const variants: Array<[string, () => Promise<void>, string]> = [
    ['plain (user scope cap)', () => enforceScopeCap({ type: 'user', id: 'u1' }, 800), 'scope_cap'],
    ['project per-source cap', () => enforceScopeCap({ type: 'project', id: 'p1' }, 40_000, 'code'), 'source_cap'],
    ['hitAware + minAge floor (session source cap)', () => enforceScopeCap({ type: 'session', id: 's1' }, 800, 'orchestrator', { minAgeHours: 24, reason: 'source_cap', hitAware: true }), 'source_cap'],
    ['tiered (session hard ceiling)', () => enforceScopeCap({ type: 'session', id: 's1' }, SESSION_SCOPE_HARD_CAP_DEFAULT, undefined, { reason: 'hard_ceiling', tiered: true }), 'hard_ceiling'],
  ];

  it.each(variants)('%s: WITH moved AS (<the exact DELETE> RETURNING …) INSERT INTO digby_memory_archive', async (_name, run, reason) => {
    const { moved, plain } = await bothForms(run);
    expect(moved).toHaveLength(1);
    expect(plain).toHaveLength(1);
    // The archived statement wraps the kill-switch statement byte-for-byte.
    expect(moved[0].sql).toBe(archiveEvictionSql(plain[0].sql, plain[0].params.length + 1));
    expect(moved[0].sql).toBe(`WITH moved AS (${plain[0].sql} RETURNING ${COLS}) INSERT INTO digby_memory_archive (${COLS}, archive_reason) SELECT ${COLS}, $${plain[0].params.length + 1}::text FROM moved ON CONFLICT (id) DO NOTHING`);
    expect(moved[0].params).toEqual([...plain[0].params, reason]);
  });

  it('MEMORY_ARCHIVE_DISABLED=1 is today\'s DELETE byte-for-byte (plain cap + hit-aware floor + tiered ceiling)', async () => {
    process.env.MEMORY_ARCHIVE_DISABLED = '1';
    await enforceScopeCap({ type: 'user', id: 'u1' }, 800);
    await enforceScopeCap({ type: 'session', id: 's1' }, 800, 'orchestrator', { minAgeHours: 24, reason: 'source_cap', hitAware: true });
    await enforceScopeCap({ type: 'session', id: 's1' }, 6000, undefined, { reason: 'hard_ceiling', tiered: true });
    const d = plainDeletes();
    expect(moves()).toHaveLength(0);
    expect(d[0].sql).toBe(`DELETE FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND id NOT IN (
         SELECT id FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 ORDER BY created_at DESC LIMIT 800)`);
    expect(d[0].params).toEqual(['user', 'u1']);
    expect(d[1].sql).toBe(`DELETE FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND source = $3 AND created_at < now() - make_interval(hours => 24) AND id NOT IN (
         SELECT id FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND source = $3 ORDER BY (last_hit_at IS NOT NULL AND last_hit_at > now() - make_interval(days => ${MEM_HIT_KEEP_DAYS_DEFAULT})) DESC, created_at DESC LIMIT 800)`);
    expect(d[1].params).toEqual(['session', 's1', 'orchestrator']);
    expect(d[2].sql).toBe(`DELETE FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND id NOT IN (
         SELECT id FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 ${sessionCeilingKeepOrderSql()} LIMIT 6000)`);
  });

  it('a session store archives both of its sweeps (source cap with the floor, then the tiered ceiling)', async () => {
    await applyStoreCap({ type: 'session', id: 's9' }, 'orchestrator');
    const m = moves();
    expect(m).toHaveLength(2);
    expect(m[0].sql).toContain('created_at < now() - make_interval(hours => 24)');
    expect(m[0].params).toEqual(['session', 's9', 'orchestrator', 'source_cap']);
    expect(m[1].sql).toContain(sessionCeilingKeepOrderSql());
    expect(m[1].params).toEqual(['session', 's9', 'hard_ceiling']);
  });

  it('the eviction metric keeps the moved-row count and says archived', async () => {
    mockExec.mockImplementation(async (sql: string) => (String(sql).startsWith('WITH moved AS') ? 11 : 0));
    await enforceScopeCap({ type: 'session', id: 's5' }, 800, 'orchestrator', { minAgeHours: 24, reason: 'source_cap', hitAware: true });
    await settle();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'memory_scope_evicted', value: 11,
      meta: expect.objectContaining({ reason: 'source_cap', source: 'orchestrator', cap: 800, archived: true, hitAware: true, minAgeHours: 24 }),
    }));
  });

  it('a failing move falls back to the plain DELETE (warned once, counted archiveFailed) — the cap is never skipped', async () => {
    mockExec.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.startsWith('WITH moved AS')) throw new Error('relation "digby_memory_archive" does not exist');
      return s.startsWith('DELETE FROM digby_memory WHERE') ? 4 : 0;
    });
    await enforceScopeCap({ type: 'user', id: 'u1' }, 800);
    await enforceScopeCap({ type: 'user', id: 'u2' }, 800);
    expect(plainDeletes().map((d) => d.params)).toEqual([['user', 'u1'], ['user', 'u2']]);
    expect(mockWarn.mock.calls.filter((c) => String(c[0]).includes('archiving eviction failed'))).toHaveLength(1);
    await settle();
    const meta = mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'memory_scope_evicted');
    expect(meta).toHaveLength(2);
    for (const r of meta) { expect(r.value).toBe(4); expect(r.meta.archiveFailed).toBe(true); expect(r.meta.archived).toBeUndefined(); }
  });
});

describe('explicit deletions purge the archive too', () => {
  it('memClear deletes the hot rows, then the scope\'s archived rows', async () => {
    await memClear({ type: 'session', id: 's1' });
    const c = calls().filter((x) => x.sql.startsWith('DELETE'));
    expect(c.map((x) => x.sql)).toEqual([
      'DELETE FROM digby_memory WHERE scope_type = $1 AND scope_id = $2',
      'DELETE FROM digby_memory_archive WHERE scope_type = $1 AND scope_id = $2',
    ]);
    expect(c[1].params).toEqual(['session', 's1']);
  });

  it('memClear still purges the archive under MEMORY_ARCHIVE_DISABLED=1 and when the hot delete fails', async () => {
    process.env.MEMORY_ARCHIVE_DISABLED = '1';
    mockExec.mockImplementation(async (sql: string) => { if (String(sql).startsWith('DELETE FROM digby_memory WHERE')) throw new Error('boom'); return 0; });
    await expect(memClear({ type: 'project', id: 'p1' })).resolves.toBeUndefined();
    expect(archivePurges().map((p) => p.params)).toEqual([['project', 'p1']]);
  });

  it('memDeleteRefs purges the same refs from the archive and returns the hot count', async () => {
    mockExec.mockImplementation(async (sql: string) => (String(sql).startsWith('DELETE FROM digby_memory WHERE') ? 3 : 0));
    const n = await memDeleteRefs({ type: 'chat', id: 'c1' }, 'supervisor_state', ['a', 'b', 'a']);
    expect(n).toBe(3);
    const p = archivePurges();
    expect(p).toHaveLength(1);
    expect(p[0].sql).toBe('DELETE FROM digby_memory_archive WHERE scope_type = $1 AND scope_id = $2 AND source = $3 AND ref = ANY($4::text[])');
    expect(p[0].params).toEqual(['chat', 'c1', 'supervisor_state', ['a', 'b']]);
  });

  it('an EMPTY memReplaceRef (an explicit ref deletion) purges archived copies; a replacement with items does not', async () => {
    await memReplaceRef({ type: 'user', id: 'u1' }, 'conversation', 'chat-1', []);
    expect(archivePurges().map((p) => p.params)).toEqual([['user', 'u1', 'conversation', ['chat-1']]]);
    mockExec.mockClear();
    await memReplaceRef({ type: 'project', id: 'p1' }, 'code', 'src/a.ts', [{ content: 'export const a = 1; // '.padEnd(260, 'x') }], { skipCap: true });
    expect(archivePurges()).toHaveLength(0);
    expect(moves()).toHaveLength(0); // a replacement is not an eviction — never archived
  });
});

describe('memArchiveRefs — a whole-ref cap eviction MOVES rows into the archive (code index tiered cap, 2026-10-23)', () => {
  const P = ['project', 'p1', 'code', ['a.ts', 'b.ts']];
  const refMoves = () => calls().filter((c) => c.sql.startsWith('WITH prior AS (DELETE FROM digby_memory_archive'));

  it('one statement: drops the refs\' previous archived generation and moves their hot rows (count = rows moved)', async () => {
    mockExec.mockImplementation(async (sql: string) => (String(sql).startsWith('WITH prior AS') ? 7 : 0));
    const out = await memArchiveRefs({ type: 'project', id: 'p1' }, 'code', ['a.ts', 'b.ts', 'a.ts'], 'code_index_tiered');
    expect(out).toEqual({ evicted: 7, archived: true, archiveFailed: false });
    const m = refMoves();
    expect(m).toHaveLength(1);
    const pred = 'scope_type = $1 AND scope_id = $2 AND source = $3 AND ref = ANY($4::text[])';
    expect(m[0].sql).toBe(`WITH prior AS (DELETE FROM digby_memory_archive WHERE ${pred}), moved AS (DELETE FROM digby_memory WHERE ${pred} RETURNING ${COLS}) INSERT INTO digby_memory_archive (${COLS}, archive_reason) SELECT ${COLS}, $5::text FROM moved ON CONFLICT (id) DO NOTHING`);
    expect(m[0].sql).toBe(archiveRefsEvictionSql());
    expect(m[0].params).toEqual([...P, 'code_index_tiered']);
    expect(plainDeletes()).toHaveLength(0);
    expect(archivePurges()).toHaveLength(0); // never a purge of what was just archived
  });

  it('MEMORY_ARCHIVE_DISABLED=1 is the plain delete + archived-copy purge (memDeleteRefs semantics)', async () => {
    process.env.MEMORY_ARCHIVE_DISABLED = '1';
    mockExec.mockImplementation(async (sql: string) => (String(sql).startsWith('DELETE FROM digby_memory WHERE') ? 4 : 0));
    const out = await memArchiveRefs({ type: 'project', id: 'p1' }, 'code', ['a.ts', 'b.ts'], 'code_index_tiered');
    expect(out).toEqual({ evicted: 4, archived: false, archiveFailed: false });
    expect(refMoves()).toHaveLength(0);
    expect(plainDeletes().map((c) => [c.sql, c.params])).toEqual([['DELETE FROM digby_memory WHERE scope_type = $1 AND scope_id = $2 AND source = $3 AND ref = ANY($4::text[])', P]]);
    expect(archivePurges().map((c) => c.params)).toEqual([P]);
  });

  it('a failing move falls back to the plain delete + purge (warned once, archiveFailed) — the eviction is never skipped', async () => {
    mockExec.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('WITH prior AS')) throw new Error('relation "digby_memory_archive" does not exist');
      return String(sql).startsWith('DELETE FROM digby_memory WHERE') ? 2 : 0;
    });
    const out = await memArchiveRefs({ type: 'project', id: 'p1' }, 'code', ['a.ts', 'b.ts'], 'code_index_tiered');
    expect(out).toEqual({ evicted: 2, archived: false, archiveFailed: true });
    expect(plainDeletes()).toHaveLength(1);
    expect(archivePurges()).toHaveLength(1);
    expect(mockWarn.mock.calls.filter((c) => /archiving eviction failed/.test(String(c[0])))).toHaveLength(1);
  });

  it('no refs: no statement at all', async () => {
    expect(await memArchiveRefs({ type: 'project', id: 'p1' }, 'code', [], 'code_index_tiered')).toEqual({ evicted: 0, archived: false, archiveFailed: false });
    expect(calls()).toHaveLength(0);
  });

  it('memPurgeArchivedRefsExcept (the code index\'s complete-listing backstop, round 4): ONE statement purges archived rows of the scope + source NOT in the keep list (NULL refs too); hot rows untouched', async () => {
    mockExec.mockImplementation(async (sql: string) => (String(sql).startsWith('DELETE FROM digby_memory_archive') ? 5 : 0));
    const n = await memPurgeArchivedRefsExcept({ type: 'project', id: 'p1' }, 'code', ['a.ts', 'b.ts', 'a.ts']);
    expect(n).toBe(5);
    const purges = archivePurges();
    expect(purges).toHaveLength(1);
    expect(purges[0].sql).toBe('DELETE FROM digby_memory_archive WHERE scope_type = $1 AND scope_id = $2 AND source = $3 AND (ref IS NULL OR NOT (ref = ANY($4::text[])))');
    expect(purges[0].sql).toBe(ARCHIVE_PURGE_REFS_EXCEPT_SQL);
    expect(purges[0].params).toEqual(['project', 'p1', 'code', ['a.ts', 'b.ts']]);
    expect(plainDeletes()).toHaveLength(0);
    expect(moves()).toHaveLength(0);
  });

  it('memPurgeArchivedRefsExcept answers null on a failing statement (the caller retries later) — never throws', async () => {
    mockExec.mockImplementation(async (sql: string) => {
      if (String(sql).startsWith('DELETE FROM digby_memory_archive')) throw new Error('connection reset');
      return 0;
    });
    await expect(memPurgeArchivedRefsExcept({ type: 'project', id: 'p1' }, 'code', ['a.ts'])).resolves.toBeNull();
  });

  it('memPurgeArchivedRefs purges only the archived copies (hot rows untouched); no refs ⇒ no statement', async () => {
    await memPurgeArchivedRefs({ type: 'project', id: 'p1' }, 'code', ['a.ts', 'b.ts', 'b.ts']);
    expect(plainDeletes()).toHaveLength(0);
    expect(archivePurges().map((c) => c.params)).toEqual([P]);
    mockExec.mockClear();
    await memPurgeArchivedRefs({ type: 'project', id: 'p1' }, 'code', []);
    expect(calls()).toHaveLength(0);
  });
});

describe('runMemoryArchiveRetention', () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const exists = () => mockQuery.mockImplementation(async (sql: string) => (String(sql).includes('to_regclass') ? [{ ok: true }] : []));
  const retentionCalls = () => calls().filter((c) => c.sql.startsWith('DELETE FROM digby_memory_archive WHERE id IN'));

  it('deletes session rows past 30 d and every other scope past 365 d, by archived_at, in bounded batches', async () => {
    exists();
    const res = await runMemoryArchiveRetention({ now: NOW });
    const r = retentionCalls();
    expect(r).toHaveLength(2);
    expect(r[0].sql).toBe(`DELETE FROM digby_memory_archive WHERE id IN (SELECT id FROM digby_memory_archive WHERE scope_type = 'session' AND archived_at < $1::timestamptz ORDER BY archived_at LIMIT ${ARCHIVE_RETENTION_BATCH_DEFAULT})`);
    expect(r[0].params).toEqual([new Date(NOW - ARCHIVE_SESSION_RETENTION_DAYS * 86_400_000).toISOString()]);
    expect(r[1].sql).toContain(`scope_type <> 'session' AND archived_at < $1::timestamptz`);
    expect(r[1].params).toEqual([new Date(NOW - ARCHIVE_RETENTION_DAYS * 86_400_000).toISOString()]);
    expect(ARCHIVE_SESSION_RETENTION_DAYS).toBe(30);
    expect(ARCHIVE_RETENTION_DAYS).toBe(365);
    expect(res).toEqual({ deleted: 0 });
  });

  it('keeps batching while a batch is full, stops at maxBatches per window, and counts every row', async () => {
    exists();
    let sessionLeft = 25; // 10 + 10 + 5
    let otherLeft = 100;  // capped at 3 batches × 10
    mockExec.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (!s.startsWith('DELETE FROM digby_memory_archive WHERE id IN')) return 0;
      if (s.includes(`scope_type = 'session'`)) { const n = Math.min(10, sessionLeft); sessionLeft -= n; return n; }
      const n = Math.min(10, otherLeft); otherLeft -= n; return n;
    });
    const res = await runMemoryArchiveRetention({ now: NOW, batch: 10, maxBatches: 3 });
    expect(res).toEqual({ deleted: 25 + 30 });
    expect(retentionCalls()).toHaveLength(3 + 3);
    await settle();
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'memory_scope_evicted', value: 55,
      meta: expect.objectContaining({ reason: 'archive_retention', scopeType: 'archive', sessionDeleted: 25, otherDeleted: 30, batches: 6, capped: true, batch: 10, maxBatches: 3 }),
    }));
  });

  it('defaults: 5000-row batches, up to 10 per window', () => {
    expect(ARCHIVE_RETENTION_BATCH_DEFAULT).toBe(5000);
    expect(ARCHIVE_RETENTION_MAX_BATCHES_DEFAULT).toBe(10);
  });

  it('no archive table: a quiet no-op with one metric row', async () => {
    const res = await runMemoryArchiveRetention({ now: NOW });
    expect(res).toEqual({ deleted: 0 });
    expect(retentionCalls()).toHaveLength(0);
    await settle();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reason: 'archive_retention', skipped: 'no_table' }) }));
  });

  it('never throws: a failing batch keeps what was deleted and records the error', async () => {
    exists();
    let n = 0;
    mockExec.mockImplementation(async (sql: string) => {
      if (!String(sql).startsWith('DELETE FROM digby_memory_archive WHERE id IN')) return 0;
      n += 1;
      if (n === 2) throw new Error('canceling statement due to statement timeout');
      return 5000;
    });
    await expect(runMemoryArchiveRetention({ now: NOW })).resolves.toEqual({ deleted: 5000 });
    await settle();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ value: 5000, meta: expect.objectContaining({ error: expect.stringContaining('statement timeout') }) }));
  });

  it('is re-exported from unified-memory.service', () => {
    expect(reexportedRetention).toBe(runMemoryArchiveRetention);
  });
});

describe('memSearchArchive (cold read)', () => {
  const arow = (id: string, extra: Record<string, unknown> = {}) => ({
    id, ref: `ref-${id}`, title: '', source: 'orchestrator', content: `content ${id}`, scope_type: 'session', scope_id: 's1',
    created_at: '2026-10-01T00:00:00.000Z', archived_at: '2026-10-10T00:00:00.000Z', score: 0.5, ...extra,
  });

  it('FTS only over digby_memory_archive, scoped exactly like memSearch, marks hits archived', async () => {
    mockQuery.mockImplementation(async (sql: string) => (String(sql).includes('FROM digby_memory_archive') ? [arow('a1'), arow('a2')] : []));
    const hits = await memSearchArchive([{ type: 'session', id: 's1' }, { type: 'project', id: 'p1' }], 'build error in src/app.ts', 6, { sources: ['orchestrator'] });
    const q = mockQuery.mock.calls.find((c: any[]) => String(c[0]).includes('FROM digby_memory_archive'))!;
    const sql = String(q[0]);
    expect(sql).toContain('WHERE ((scope_type = $1 AND scope_id = $2) OR (scope_type = $3 AND scope_id = $4)) AND source = ANY($6::text[])');
    expect(sql).toContain(`to_tsvector('english', coalesce(title,'') || ' ' || content) @@ websearch_to_tsquery('english', $5)`);
    expect(sql).toContain('LIMIT 6');
    expect(sql).not.toContain('<=>'); // no vector leg — the archive has no embedding
    expect(q.slice(1)).toEqual(['session', 's1', 'project', 'p1', 'build error in src/app.ts', ['orchestrator']]);
    expect(hits).toEqual([
      expect.objectContaining({ ref: 'ref-a1', content: 'content a1', scopeType: 'session', scopeId: 's1', archived: true, archivedAt: '2026-10-10T00:00:00.000Z' }),
      expect.objectContaining({ ref: 'ref-a2', archived: true }),
    ]);
  });

  it('never throws: a failing query is []; empty query / scopes do not hit the DB', async () => {
    mockQuery.mockImplementation(async () => { throw new Error('relation does not exist'); });
    await expect(memSearchArchive([{ type: 'session', id: 's1' }], 'q', 6)).resolves.toEqual([]);
    mockQuery.mockClear();
    await expect(memSearchArchive([], 'q', 6)).resolves.toEqual([]);
    await expect(memSearchArchive([{ type: 'session', id: 's1' }], '  ', 6)).resolves.toEqual([]);
    expect(mockQuery.mock.calls.filter((c: any[]) => String(c[0]).includes('digby_memory_archive'))).toHaveLength(0);
  });

  it('memSearchArchiveForUser drops scopes the caller may not read (fail closed: no user ⇒ no query)', async () => {
    await expect(memSearchArchiveForUser('', [{ type: 'session', id: 's1' }], 'q', 6)).resolves.toEqual([]);
    expect(mockQuery.mock.calls.filter((c: any[]) => String(c[0]).includes('digby_memory_archive'))).toHaveLength(0);
    await memSearchArchiveForUser('u1', [{ type: 'session', id: 's1' }, { type: 'session', id: 's2' }, { type: 'project', id: 'p-mine' }, { type: 'project', id: 'p-theirs' }, { type: 'user', id: 'u2' }], 'q', 6);
    const q = mockQuery.mock.calls.find((c: any[]) => String(c[0]).includes('FROM digby_memory_archive'))!;
    expect(q.slice(1)).toEqual(['session', 's1', 'project', 'p-mine', 'q']);
  });

  it('the DDL list carries no vector column or index (cold tier is text only)', () => {
    expect(ARCHIVE_DDL.join('\n')).not.toMatch(/\bvector\(|hnsw|embedding/i);
  });
});
