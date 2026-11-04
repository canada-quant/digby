/**
 * FO firing 33 — REPLAY test for the supervisor-turn-noop facts timeout, round 2
 * (iter 23, Fleet-Supervisor-wake 2026-09-27).
 *
 * The incident (prod, box A, 11:45Z, post-88faf443): iter 22's
 * `@@index([sessionId, createdAt])` + migration 20260927104600 landed and the
 * index was VALID — but the facts query STILL walked loop_metrics_createdAt_idx
 * BACKWARD (live EXPLAIN ANALYZE 1559.515 ms, Rows Removed by Filter 60150) on
 * every box already serving 88faf443, and the strike class continued:
 *   "supervisor-turn-noop: <chat> failed open (supervisor turn facts timed out
 *   after 1500ms)" — bbac4b42 11:35:11Z (daee2916 sweep), ecaf86cd 11:37:44Z
 *   (c0e22e36 drain), cc06330a 11:40:28Z (c0e22e36 drain).
 *
 * Root cause: the facts read also filters kind IN (supervisor_noop,
 * supervisor_action, supervisor_note). With `kind` uncovered by the 2-col
 * index, the (sessionId, createdAt) path needs a HEAP FETCH PER ROW, and the
 * Fleet Supervisor's own chat is the noisiest writer in the fleet (planner
 * MCV ≈ 22.7k rows = 5.9% of the table; 16.8k in any 7-day window) — so the
 * planner correctly priced the 2-col path above the 1.5 s createdAt backward
 * scan. Quiet chats used the 2-col index fine (idx_scan 77). The lesson:
 * AN INDEX ON THE FILTERED COLUMNS IS NOT ENOUGH — the index must COVER the
 * query's other equality (kind) and the selected columns, or the planner will
 * reject it exactly where the query is most repetitive (the supervisor chats
 * this purpose serves).
 *
 * The fix is ADDITIVE ONLY: `@@index([sessionId, kind, createdAt])` on
 * LoopMetric + migration 20260927120000_loop_metrics_session_kind_idx. The
 * 2-col index STAYS (it serves kind-less sessionId+createdAt reads).
 *
 * Pins (a regression cannot silently return):
 *   1. SCHEMA — the 3-col index is declared on the model;
 *   2. MIGRATION — the migration exists, creates exactly that index
 *      (IF NOT EXISTS, additive-only, no DROP/ALTER/TRUNCATE/DELETE);
 *   3. NO ORPHAN DDL — the only migrations touching loop_metrics indexes are
 *      the table creation, iter 22's, and iter 23's;
 *   4. QUERY SHAPE — computeSupervisorTurnNoopFacts still filters
 *      sessionId + kind IN (the 3 kinds) + createdAt ≥ 7d, ordered desc,
 *      take-capped, so the 3-col index is the index the live query needs.
 * Static-file pattern — no DB, no app singletons, env-less (f32 precedent).
 */
import fs from 'fs';
import path from 'path';

const here = __dirname;
const schemaPath = path.resolve(here, '../../../../prisma/schema.prisma');
const migrationsDir = path.resolve(here, '../../../../prisma/migrations');
const turnNoopPath = path.resolve(here, 'supervisor-turn-noop.ts');

const IT23 = 'iter 23 (FO firing 33): loop_metrics (sessionId, kind, createdAt) index — supervisor-turn-noop facts timeout round 2';

describe(IT23, () => {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const turnNoopSrc = fs.readFileSync(turnNoopPath, 'utf8');

  const loopMetricBlock = (() => {
    const m = schema.match(/^model LoopMetric \{[\s\S]*?^\}/m);
    return m ? m[0] : '';
  })();

  // 1. SCHEMA — the 3-col index is declared on the model.
  it('schema.prisma declares @@index([sessionId, kind, createdAt]) on LoopMetric', () => {
    expect(loopMetricBlock).not.toBe('');
    expect(loopMetricBlock).toContain('@@index([sessionId, kind, createdAt])');
  });

  it('the iter-22 2-col index also stays (kind-less sessionId reads keep it)', () => {
    expect(loopMetricBlock).toContain('@@index([sessionId, createdAt])');
  });

  // 2. MIGRATION — exactly one new additive index, idempotent, no other DDL.
  it('migration 20260927120000_loop_metrics_session_kind_idx exists and creates the 3-col index additively', () => {
    const dir = path.join(migrationsDir, '20260927120000_loop_metrics_session_kind_idx');
    expect(fs.existsSync(path.join(dir, 'migration.sql'))).toBe(true);
    const sql = fs.readFileSync(path.join(dir, 'migration.sql'), 'utf8');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "loop_metrics_sessionId_kind_createdAt_idx"');
    expect(sql).toContain('ON "loop_metrics"("sessionId", "kind", "createdAt")');
    // additive-only shape: no DROP, no ALTER, no TRUNCATE, no DELETE anywhere
    expect(sql.match(/\b(DROP|ALTER|TRUNCATE|DELETE)\b/i)).toBeNull();
  });

  // 3. NO ORPHAN DDL — only the table creation + iter 22 + iter 23 touch
  //    loop_metrics index DDL (single source of truth for the index set).
  it('the only loop_metrics index migrations are the table creation, iter 22 and iter 23', () => {
    const dirs = fs.readdirSync(migrationsDir).filter((d) => d.startsWith('2026'));
    const idxDdl = /(CREATE|DROP)\s+(UNIQUE\s+)?INDEX[^;]*ON\s+"loop_metrics"/i;
    const touching = dirs.filter((d) => {
      const p = path.join(migrationsDir, d, 'migration.sql');
      if (!fs.existsSync(p)) return false;
      const sql = fs.readFileSync(p, 'utf8');
      // ignore the initial table-creation migration's own indexes
      if (/CREATE TABLE\s+"loop_metrics"/i.test(sql)) return false;
      return idxDdl.test(sql);
    });
    expect(touching.sort()).toEqual([
      '20260927104600_loop_metrics_session_idx',
      '20260927120000_loop_metrics_session_kind_idx',
    ]);
  });

  // 4. QUERY SHAPE — the live facts query filters sessionId + kind + createdAt
  //    on the loopMetric leg: the 3-col index columns ARE the queried columns.
  it('computeSupervisorTurnNoopFacts filters loopMetric by sessionId + kind IN the 3 kinds + createdAt (desc, take-capped)', () => {
    expect(turnNoopSrc).toContain('prisma.loopMetric.findMany({');
    expect(turnNoopSrc).toMatch(
      /where:\s*\{\s*sessionId:\s*chatId,\s*kind:\s*\{\s*in:\s*\[?\s*'supervisor_noop',\s*'supervisor_action',\s*'supervisor_note'/,
    );
    expect(turnNoopSrc).toMatch(/orderBy:\s*\{\s*createdAt:\s*'desc'\s*\}/);
    // the deadline the index must fit (unchanged by this fix)
    expect(turnNoopSrc).toContain('SUPERVISOR_TURN_NOOP_FACTS_TIMEOUT_MS = 1500');
  });

  it('the facts leg selects ONLY kind + createdAt — both index-resident in the 3-col index (index-only walk)', () => {
    // select: { kind: true, createdAt: true } — with (sessionId, kind,
    // createdAt) every column the query touches lives in the index.
    expect(turnNoopSrc).toMatch(/select:\s*\{\s*kind:\s*true,\s*createdAt:\s*true\s*\}/);
  });
});
