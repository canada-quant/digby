/**
 * Ticket bfc3209a — REPLAY test for the orphaned `_prisma_migrations` row.
 *
 * The incident (prod, 2026-10-20): PR #1834's deploy (run 39508001379) applied
 * migration 20261020210000_user_feed_last_error at 22:44:43.359Z; five minutes
 * later the topic-feeds retirement PR #1836 (squash dbd154ef4) merged at
 * 22:49:19Z and DELETED that migration's file — while its row stayed applied
 * in prod's _prisma_migrations. The repo then no longer reproduced prod's
 * applied history: `prisma migrate status` drifts and a DB restored from prod
 * cannot be reconciled with `migrate dev`.
 *
 * The fix is migration 20261021002000_prisma_migrations_orphan_cleanup, which
 * deletes exactly that bookkeeping row (schema untouched — the deleted
 * migration only ALTERed user_feeds columns, and user_feeds is dropped by the
 * retirement's own 20261020190000 migration). This replay pins the fix on
 * four fronts so the drift class cannot silently return:
 *   1. MIGRATION — the cleanup migration exists and its ONLY statement is the
 *      name-scoped DELETE (a no-op on fresh DBs by construction, so it is
 *      safe in every replay of the repo's history);
 *   2. RETIREMENT STATE — the deleted migration's directory stays deleted: if
 *      anyone ever restores the file, this DELETE would remove a LEGITIMATE
 *      applied row instead of an orphan — the collision must fail here first;
 *   3. BOOKKEEPING EXCLUSIVITY — the cleanup migration is the ONLY migration
 *      that touches _prisma_migrations (the table is Prisma's own; a second
 *      hand-rolled writer would be a new incident, not a fix);
 *   4. ORDERING — the cleanup sorts after the retirement migration, so in any
 *      replay the feed tables are already gone when it runs.
 * Static-file pattern copied from loop-metrics-session-idx.f32.test.ts —
 * no DB, no app singletons, env-less.
 */
import fs from 'fs';
import path from 'path';

const here = __dirname;
const migrationsDir = path.resolve(here, '../../../../prisma/migrations');

const ORPHAN = '20261020210000_user_feed_last_error';
const CLEANUP = '20261021002000_prisma_migrations_orphan_cleanup';
const RETIREMENT = '20261020190000_retire_topic_feeds';

describe('bfc3209a: orphaned _prisma_migrations row cleanup', () => {
  const cleanupDir = path.join(migrationsDir, CLEANUP);
  const sql = fs.existsSync(path.join(cleanupDir, 'migration.sql'))
    ? fs.readFileSync(path.join(cleanupDir, 'migration.sql'), 'utf8')
    : '';

  // The executable body with DO-block internals whitespace-collapsed: compares
  // the SQL's executable content, not its formatting.
  const executable = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  it('1. MIGRATION — the cleanup migration exists', () => {
    expect(sql).not.toBe('');
  });

  it('1. MIGRATION — its only statement is the guarded, name-scoped DELETE (DO block)', () => {
    expect(executable).toBe(
      `DO $$ BEGIN DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${ORPHAN}'; ` +
        `EXCEPTION WHEN undefined_table THEN NULL; END $$;`
    );
  });

  it('1. MIGRATION — a bare unguarded DELETE would break shadow replay (pin the guard)', () => {
    // The live failure this guard exists for (caught by
    // `migrate diff --from-migrations … --to-schema …` before the guard was
    // added): Prisma's shadow replay runs each migration file WITHOUT
    // _prisma_migrations present, and the 42P01 fires at PARSE time —
    // parserOpenTable opening the DELETE TARGET — so a WHERE-clause guard
    // (e.g. to_regclass) cannot save it. If this pin fails, someone stripped
    // or restructured the DO block; re-run the shadow gate before shipping.
    expect(executable).toContain('EXCEPTION WHEN undefined_table THEN NULL');
    // ...and the DELETE must stay inside the DO block (guard reachable).
    expect(executable).toMatch(/^DO \$\$ BEGIN DELETE FROM "_prisma_migrations"/);
    // ...and stay name-scoped to exactly the orphan.
    expect(executable.match(/DELETE FROM "_prisma_migrations"/g)).toHaveLength(1);
  });

  it('2. RETIREMENT STATE — the deleted migration file stays deleted', () => {
    expect(fs.existsSync(path.join(migrationsDir, ORPHAN))).toBe(false);
  });

  it('2. RETIREMENT STATE — the retirement migration that deleted it still exists', () => {
    expect(fs.existsSync(path.join(migrationsDir, RETIREMENT))).toBe(true);
  });

  it('3. BOOKKEEPING EXCLUSIVITY — the cleanup is the ONLY migration touching _prisma_migrations', () => {
    // Every dir with a migration.sql — no date filter (a 2027-dated offender
    // must fail this pin too), case-insensitive match on the table name.
    const offenders: string[] = [];
    for (const d of fs.readdirSync(migrationsDir)) {
      const p = path.join(migrationsDir, d, 'migration.sql');
      if (!fs.existsSync(p)) continue; // skips migration_lock.toml + plain files
      if (d === CLEANUP) continue;
      if (fs.readFileSync(p, 'utf8').toLowerCase().includes('_prisma_migrations')) {
        offenders.push(d);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('4. ORDERING — the cleanup applies after the retirement on any replay', () => {
    const dirs = fs
      .readdirSync(migrationsDir)
      .filter((d) => fs.existsSync(path.join(migrationsDir, d, 'migration.sql')))
      .sort();
    // The invariant is relative order, not "last dir": a later additive
    // migration (20261021120000_chat_display_parent, lane lifecycle
    // 2026-10-21; 20261022050000_chat_ghost_mode, ghost mode 2026-10-22)
    // must not fail this pin. The orphan's own dir stays deleted
    // (pin 2), so nothing after the cleanup can re-create its row.
    expect(dirs).toContain(CLEANUP);
    expect(dirs.indexOf(CLEANUP)).toBeGreaterThan(dirs.indexOf(RETIREMENT));
    // and it sorts after both the retirement and the orphan it cleans up.
    expect(CLEANUP > RETIREMENT).toBe(true);
    expect(CLEANUP > ORPHAN).toBe(true);
    // (2026-10-22, ghost-mode migration): a LATER unrelated migration is fine —
    // the replay invariant is only that nothing AFTER the cleanup also writes
    // _prisma_migrations (it would re-create rows the cleanup deleted).
    const later = dirs.slice(dirs.indexOf(CLEANUP) + 1);
    for (const d of later) {
      expect(fs.readFileSync(path.join(migrationsDir, d, 'migration.sql'), 'utf8').toLowerCase()).not.toContain('_prisma_migrations');
    }
  });
});
