/**
 * Re-runnable repro for ticket 696d4346 — the guarded empty-expected context
 * write vs a SQL-NULL jsonb column on the repo's own stack (Prisma 7.9.1 +
 * PrismaPg driver adapter + Postgres).
 *
 * WHY THIS EXISTS: the fix (commit fd2433249b, `equals: Prisma.AnyNull`) and
 * its comment in feedback.service.ts / crossmodel.controller.ts claim the OLD
 * shape `OR [{ context: { equals: {} } }, { context: { equals: null } }]`
 * matched NEITHER arm for a SQL-NULL context row — every held-ticket
 * escalation stamp on a never-touched ticket failed as context_conflict, so
 * the sweep re-carded ticket 233faf3c-15b5-45b1-b9d6-63c72759e597 every
 * ~30 min despite nine owner Dismiss answers (2026-10-27T19:02Z →
 * 2026-10-28T03:17Z). The unit tests pin the WHERE shape but cannot pin the
 * DATABASE SEMANTICS. This script does, against any Postgres you point it at.
 *
 * The unit-test seam cannot carry this evidence: the miss lives in the
 * driver-adapter fold (Prisma emits `("context" = 'null'::jsonb OR
 * "context" IS NULL)` INSIDE one nested filter object, which the PrismaPg
 * adapter drops), and a fake driver adapter cannot reproduce the REAL
 * adapter's fold — the semantics must be measured on a real Postgres.
 *
 * LIVE CORROBORATION (2026-10-28T04:19Z, get_fleet_telemetry
 * kind=held_ticket_escalation, 24 h window): ticket 233faf3c-… was carded on
 * EVERY ~30-min pass since 2026-10-27T19:02Z — 12+ cards, every card-phase
 * row `stamped:false`, every pass `decided:0` — the exact failure shape the
 * context_conflict-every-stamp root cause predicts (the answer existed in the
 * owner-question ledger, the stamp write never landed, the stamp is the
 * sweep's only signal).
 *
 * Observed on the repo's stack against the production RDS instance
 * (2026-10-28, during the fix run — re-run to confirm on any stack change):
 *   OLD shape on a SQL-NULL row: count=0  ← THE DEFECT (never matched)
 *   NEW shape (equals:{} OR equals:Prisma.AnyNull): SQL-NULL row count=1,
 *     'null'::jsonb row count=1, {} row count=1, populated row count=0
 *
 * Self-cleaning: creates ONE scratch table `repro_696d4346_guard` (nullable
 * jsonb, no default — the userFeatureRequest.context shape), never touches
 * application tables, drops the table on the way out (even on failure).
 *
 * Usage:
 *   cd backend && DATABASE_URL=postgres://… npx tsx scripts/repro-696d4346-null-guard.ts
 * Exit 0 = semantics as documented; exit 1 = drift (re-examine the guard).
 */
import { Prisma } from '@prisma/client';

const TABLE = 'repro_696d4346_guard';
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (the semantics must be measured on a real Postgres — see the header).');
    return 1;
  }
  const prisma = (await import('../src/config/database')).default;
  const raw = (sql: string) => prisma.$queryRawUnsafe(sql);
  let failures = 0;
  try {
    await raw(`DROP TABLE IF EXISTS ${q(TABLE)}`);
    await raw(`CREATE TABLE ${q(TABLE)} (id text PRIMARY KEY, ctx jsonb)`); // nullable jsonb, no default
    await raw(`INSERT INTO ${q(TABLE)} (id, ctx) VALUES
      ('null_row', NULL), ('json_null_row', 'null'::jsonb),
      ('empty_row', '{}'::jsonb), ('populated_row', '{"a":1}'::jsonb)`);

    // The two guard shapes as Prisma's JsonNullableFilter expands them per arm
    // (the feedback.service.ts comment documents the equals:null expansion).
    const OLD = `"ctx" = '{}'::jsonb OR ("ctx" = 'null'::jsonb OR "ctx" IS NULL)`;
    const NEW = `"ctx" = '{}'::jsonb OR "ctx" IS NULL OR "ctx" = 'null'::jsonb`;
    const count = async (shape: string, row: string): Promise<number> =>
      ((await raw(`SELECT count(*)::int AS n FROM ${q(TABLE)} WHERE id = $1 AND (${shape})`, row)) as Array<{ n: number }>)[0].n;

    const oldNullRow = await count(OLD, 'null_row');
    console.log(`OLD shape on the SQL-NULL row: count=${oldNullRow}${oldNullRow === 0 ? '  ← THE DEFECT (never matched → context_conflict on every stamp)' : '  (matches — the defect does NOT reproduce on THIS stack; re-examine the fix narrative)'}`);
    if (oldNullRow !== 0) failures += 1;

    const cases: Array<[string, string, number]> = [
      ['SQL-NULL row', 'null_row', 1],
      ["jsonb 'null' row", 'json_null_row', 1],
      ['{} row', 'empty_row', 1],
      ['populated row', 'populated_row', 0],
    ];
    for (const [label, row, want] of cases) {
      const got = await count(NEW, row);
      const ok = got === want;
      if (!ok) failures += 1;
      console.log(`NEW shape on the ${label}: count=${got} (want ${want}) ${ok ? '✓' : '✗ DRIFT'}`);
    }
  } finally {
    await raw(`DROP TABLE IF EXISTS ${q(TABLE)}`).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
  console.log(failures === 0 ? 'PASS — guard semantics as documented.' : `FAIL — ${failures} drift check(s).`);
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error('repro failed:', err?.message ?? err);
  process.exit(1);
});
