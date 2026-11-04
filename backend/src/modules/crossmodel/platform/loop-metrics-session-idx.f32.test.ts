/**
 * FO firing 32 — REPLAY test for the supervisor-turn-noop facts timeout (iter 22).
 *
 * The incident (prod, box A, 2026-09-27): `computeSupervisorTurnNoopFacts`
 * (supervisor-turn-noop.ts) — also shared by `lookupWakeTargetFacts`
 * (hooks.service.ts, wake_triage v3 target_facts) — reads
 *   prisma.loopMetric.findMany({
 *     where: { sessionId, kind IN (supervisor_noop, supervisor_action,
 *               supervisor_note), createdAt >= now − 7 d },
 *     orderBy: { createdAt: 'desc' }, take: 400 })
 * but LoopMetric carried only @@index([kind, createdAt]) + @@index([createdAt]).
 * The planner chose loop_metrics_createdAt_idx BACKWARD over the whole fleet's
 * 7-day rows and filtered sessionId in the heap: prod EXPLAIN ANALYZE —
 * Execution Time 7658.216 ms, Rows Removed by Filter: 60591, 40858 hit /
 * 8891 read buffers, 174 MB / ~377k rows — against the 1500 ms facts deadline
 * (SUPERVISOR_TURN_NOOP_FACTS_TIMEOUT_MS). Every sweep/drain firing of the
 * Fleet Supervisor chat failed open with
 * "supervisor-turn-noop: <chat> failed open (supervisor turn facts timed out
 * after 1500ms)" (4/4 in the 4 h audit window), so the SHADOW purpose never
 * asked the gate, accumulated zero calibration rows, and could never
 * graduate to act.
 *
 * The fix is ADDITIVE ONLY: @@index([sessionId, createdAt]) on LoopMetric +
 * migration 20260927104600_loop_metrics_session_idx (plain CREATE INDEX
 * IF NOT EXISTS, the 9df506cc F3 precedent shape). This replay pins the fix
 * on three fronts so a regression cannot silently return:
 *   1. SCHEMA — the schema.prisma text carries the composite index
 *      (a dropped @@index fails here before any prod query can regress);
 *   2. MIGRATION — the migration file exists and its SQL creates exactly
 *      that index (IF NOT EXISTS, no other DDL — additive-only shape);
 *   3. QUERY SHAPE — computeSupervisorTurnNoopFacts actually filters by
 *      sessionId + createdAt range on the loopMetric leg, so the index is
 *      the one the live query needs (no schema/prod drift on the column).
 * Static-file pattern copied from hooks.retired-target.9df506cc.test.ts —
 * no DB, no app singletons, env-less.
 */
import fs from 'fs';
import path from 'path';

const here = __dirname;
const schemaPath = path.resolve(here, '../../../../prisma/schema.prisma');
const migrationsDir = path.resolve(here, '../../../../prisma/migrations');
const turnNoopPath = path.resolve(here, 'supervisor-turn-noop.ts');

describe('iter 22 (FO firing 32): loop_metrics sessionId+createdAt index — supervisor-turn-noop facts timeout', () => {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const turnNoopSrc = fs.readFileSync(turnNoopPath, 'utf8');

  const loopMetricBlock = (() => {
    const m = schema.match(/^model LoopMetric \{[\s\S]*?^\}/m);
    return m ? m[0] : '';
  })();

  // 1. SCHEMA — the composite index is declared on the model.
  it('schema.prisma declares @@index([sessionId, createdAt]) on LoopMetric', () => {
    expect(loopMetricBlock).not.toBe('');
    expect(loopMetricBlock).toContain('@@index([sessionId, createdAt])');
  });

  it('the LoopMetric index set is exactly the intended additive set (no silent index removal)', () => {
    const idx = loopMetricBlock.match(/@@index\(\[[^\]]*\]\)/g) ?? [];
    // iter 23 (FO firing 33) added the 3-col [sessionId, kind, createdAt] on
    // top of iter 22's [sessionId, createdAt] — see
    // loop-metrics-session-kind-idx.w33.test.ts for why the 2-col alone was
    // not enough for the supervisor-turn-noop facts read.
    expect(idx.sort()).toEqual([
      '@@index([createdAt])',
      '@@index([kind, createdAt])',
      '@@index([sessionId, createdAt])',
      '@@index([sessionId, kind, createdAt])',
    ]);
  });

  // 2. MIGRATION — exactly one new additive index, idempotent, no other DDL.
  it('migration 20260927104600_loop_metrics_session_idx exists and creates the index additively', () => {
    const dir = path.join(migrationsDir, '20260927104600_loop_metrics_session_idx');
    expect(fs.existsSync(path.join(dir, 'migration.sql'))).toBe(true);
    const sql = fs.readFileSync(path.join(dir, 'migration.sql'), 'utf8');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "loop_metrics_sessionId_createdAt_idx"');
    expect(sql).toContain('ON "loop_metrics"("sessionId", "createdAt")');
    // additive-only shape: no DROP, no ALTER, no TRUNCATE, no DELETE anywhere
    expect(sql.match(/\b(DROP|ALTER|TRUNCATE|DELETE)\b/i)).toBeNull();
  });

  it('no OTHER pending migration also writes loop_metrics indexes (single source of truth)', () => {
    const dirs = fs.readdirSync(migrationsDir).filter((d) => d.startsWith('2026'));
    // index DDL ON loop_metrics — the original 20260902 table creation
    // (CREATE TABLE + its two indexes) is expected and stays.
    const idxDdl = /(CREATE|DROP)\s+(UNIQUE\s+)?INDEX[^;]*ON\s+"loop_metrics"/i;
    const touching = dirs.filter((d) => {
      const p = path.join(migrationsDir, d, 'migration.sql');
      if (!fs.existsSync(p)) return false;
      const sql = fs.readFileSync(p, 'utf8');
      // ignore the initial table-creation migration's own indexes
      if (/CREATE TABLE\s+"loop_metrics"/i.test(sql)) return false;
      return idxDdl.test(sql);
    });
    // iter 23 (FO firing 33) added its own loop_metrics index migration
    // (20260927120000_loop_metrics_session_kind_idx) — this f32 pin keeps its
    // "single source of truth" meaning: the FULL additive index-migration set.
    expect(touching.sort()).toEqual([
      '20260927104600_loop_metrics_session_idx',
      '20260927120000_loop_metrics_session_kind_idx',
    ]);
  });

  // 3. QUERY SHAPE — the live facts query filters sessionId + createdAt on
  //    the loopMetric leg, so the indexed columns are the queried columns.
  it('computeSupervisorTurnNoopFacts filters loopMetric by sessionId + createdAt (desc, take-capped)', () => {
    expect(turnNoopSrc).toContain('prisma.loopMetric.findMany({');
    expect(turnNoopSrc).toMatch(/where:\s*\{\s*sessionId:\s*chatId,\s*kind:\s*\{\s*in:/);
    expect(turnNoopSrc).toMatch(/orderBy:\s*\{\s*createdAt:\s*'desc'\s*\}/);
  });

  it('the facts deadline the index must fit is still 1500 ms (SUPERVISOR_TURN_NOOP_FACTS_TIMEOUT_MS)', () => {
    expect(turnNoopSrc).toContain('SUPERVISOR_TURN_NOOP_FACTS_TIMEOUT_MS = 1500');
  });
});
