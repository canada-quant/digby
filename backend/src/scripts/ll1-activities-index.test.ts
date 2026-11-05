/**
 * scripts/framework-audit/ll1-activities-index.js on a MOCKED Prisma client
 * (backlog LL-1): DRY RUN by default (measures rows / size / existing indexes,
 * writes nothing), --apply issues exactly ONE `CREATE INDEX CONCURRENTLY IF NOT
 * EXISTS` statement and reports the ACTUAL elapsed ms, an already-present index
 * is a no-op, and a previously-FAILED concurrent build (an INVALID index left
 * behind, which silently blocks the planner and the rebuild) refuses --apply and
 * prints the drop command instead of failing obscurely.
 *
 * The one property that matters for a write-hot table: the DDL must be
 * CONCURRENTLY (never a plain CREATE INDEX, which would hold a write lock and
 * block every audit insert for the whole build).
 */
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const script: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'll1-activities-index.js'));

type IndexRow = { indexname: string; indexdef: string; valid: boolean };

function makePrisma(opts: { indexes?: IndexRow[]; rows?: number; sizeBytes?: number } = {}) {
  const indexes = opts.indexes ?? [];
  const executed: string[] = [];
  const calls: any[][] = [];
  const prisma = {
    $queryRawUnsafe: jest.fn(async (...args: any[]): Promise<any> => {
      calls.push(args);
      const sql = String(args[0] ?? '');
      if (/FROM pg_indexes[\s\S]*ORDER BY i\.indexname/.test(sql)) return indexes;
      if (/FROM pg_indexes/.test(sql) && /i\.indexname = \$2/.test(sql)) {
        const name = args[2];
        return indexes.filter((i) => i.indexname === name);
      }
      if (/pg_total_relation_size/.test(sql)) {
        return [{ est_rows: opts.rows ?? 1_000_000, size_bytes: opts.sizeBytes ?? 256 * 1024 * 1024, heap_bytes: 0 }];
      }
      return [];
    }),
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      executed.push(sql);
      return 1;
    }),
  };
  return { prisma, executed };
}

async function runScript(prisma: any, argv: string[]) {
  const lines: string[] = [];
  const code = await script.run({ prisma, argv, out: (s: string) => lines.push(s) });
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  return { code, parsed, last: parsed[parsed.length - 1] };
}

describe('LL-1 activities index one-shot', () => {
  it('the DDL is CONCURRENTLY and idempotent — a plain CREATE INDEX would block every audit insert', () => {
    const sql: string = script.BUILD_SQL;
    expect(sql).toContain('CREATE INDEX CONCURRENTLY');
    expect(sql).toContain('IF NOT EXISTS');
    expect(sql).toContain('"activities"');
    // Column order is the reader's predicate order: userId, then action, then the createdAt window.
    expect(sql).toMatch(/\("userId", "action", "createdAt"\)/);
    // The locking form is unreachable through this module: the only DDL string
    // it can emit is BUILD_SQL, and that one always says CONCURRENTLY.
    expect(sql.split('CREATE INDEX CONCURRENTLY')).toHaveLength(2);
  });

  it('dry run measures and writes NOTHING', async () => {
    const { prisma, executed } = makePrisma();
    const { code, last } = await runScript(prisma, []);
    expect(code).toBe(0);
    expect(executed).toEqual([]);
    expect(last.dryRun).toBe(true);
    expect(last.apply).toBe(false);
    expect(last.rows).toBe(1_000_000);
    expect(last.sizeBytes).toBe(256 * 1024 * 1024);
    // The estimate is a real number the operator can sanity-check against sizeBytes.
    expect(last.estimateSeconds).toBeGreaterThan(0);
    expect(last.note).toContain('--apply');
  });

  it('--apply runs exactly one statement and reports the ACTUAL elapsed time', async () => {
    const { prisma, executed } = makePrisma();
    const { code, last } = await runScript(prisma, ['--apply']);
    expect(code).toBe(0);
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('CREATE INDEX CONCURRENTLY');
    expect(typeof last.elapsedMs).toBe('number');
    expect(last.built).toBe(true);
    // The follow-up (schema.prisma + a no-op migration) is named, not silently skipped.
    expect(last.next).toContain('schema.prisma');
  });

  it('an already-present index makes --apply a no-op (idempotent re-run after a partial rollout)', async () => {
    const { prisma, executed } = makePrisma({
      indexes: [{ indexname: script.INDEX_NAME, indexdef: 'CREATE INDEX …', valid: true }],
    });
    const { code, last } = await runScript(prisma, ['--apply']);
    expect(code).toBe(0);
    expect(executed).toEqual([]);
    expect(last.skipped).toBe('already_present');
  });

  it('a FAILED earlier CONCURRENTLY build (INVALID index) refuses and prints the drop command', async () => {
    const { prisma, executed } = makePrisma({
      indexes: [{ indexname: script.INDEX_NAME, indexdef: 'CREATE INDEX …', valid: false }],
    });
    const { code, last } = await runScript(prisma, ['--apply']);
    expect(code).toBe(1);
    expect(executed).toEqual([]);
    expect(last.refused).toBe('invalid_index_present');
    expect(last.next).toContain('DROP INDEX CONCURRENTLY');
  });

  it('reports the indexes already on the table so the operator sees the write-amplification cost', async () => {
    const { prisma } = makePrisma({
      indexes: [{ indexname: 'activities_userId_createdAt_idx', indexdef: 'CREATE INDEX …', valid: true }],
    });
    const { last } = await runScript(prisma, []);
    expect(last.otherIndexes).toContain('activities_userId_createdAt_idx');
    expect(last.otherIndexes).not.toContain(script.INDEX_NAME);
  });

  it('the estimate is coarse but monotone in table size (a bigger table cannot estimate faster)', () => {
    expect(script.estimateSeconds(1_000_000, 64 * 1024 * 1024)).toBeLessThanOrEqual(script.estimateSeconds(1_000_000, 512 * 1024 * 1024));
    // Never below the floor — a tiny table still reports a real (short) build.
    expect(script.estimateSeconds(10, 0)).toBeGreaterThanOrEqual(3);
  });

  it('arg parsing defaults to a DRY RUN and a 15-minute build wait', () => {
    expect(script.parseArgs([])).toMatchObject({ apply: false, timeoutMs: 900_000 });
    expect(script.parseArgs(['--apply'])).toMatchObject({ apply: true });
    expect(script.parseArgs(['--apply', '--timeout-ms', '60000'])).toMatchObject({ apply: true, timeoutMs: 60_000 });
    // A garbage timeout falls back to the default instead of producing NaN.
    expect(script.parseArgs(['--timeout-ms', 'abc']).timeoutMs).toBe(900_000);
  });
});