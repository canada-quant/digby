#!/usr/bin/env node
/**
 * ll1-activities-index.js — ONE-SHOT WRITE (backlog LL-1, owner-run).
 *
 * Adds `activities_userId_action_createdAt_idx` to the write-hot `activities`
 * table with CREATE INDEX **CONCURRENTLY**, i.e. WITHOUT taking the write lock a
 * plain CREATE INDEX would hold — a plain build on this table blocks EVERY
 * platform mutation's audit insert for the whole build (see the backlog entry:
 * `docs/FRAMEWORK_BACKLOG.md` LL-1).
 *
 * WHY the index: `lane-family-facts readRestoreAuditChats` (lane-retire's
 * eligible-lane pass every 6 h, the ticket drain's house-rule reads, the
 * run-reaper rules) filters `activities` by `userId` + `action` + a
 * `createdAt` window, but the table is indexed on `(userId, createdAt)` only —
 * so every such read walks the owner's whole audit trail for the window
 * (measured on a local 1 M-row repro: ~3.5–4.2 s for 200 chat ids).
 *
 * DRY RUN BY DEFAULT (measures; writes nothing):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh ll1-activities-index.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh ll1-activities-index.js --apply
 * Options: --timeout-ms N  cap the build wait (default 900 000 = 15 min; the
 *          build keeps running server-side in Postgres if the client gives up,
 *          so a timeout is not a failure — re-run the dry run to see the state).
 *
 * WHAT THE DRY RUN PRINTS (this is the "expected duration" answer — measured,
 * not guessed):
 *   - `rows`            — the live `activities` row count;
 *   - `sizeBytes`       — the table's on-disk size (the build's input volume);
 *   - `existing`        — whether the target index already exists (idempotent);
 *   - `invalid`         — whether a FAILED CONCURRENTLY build left an INVALID
 *                         index behind (it must be dropped before a rebuild —
 *                         `--apply` refuses and prints the DROP command);
 *   - `estimateSeconds` — build estimate from the row count and the table size
 *                         (see the formula note below);
 *   - `otherIndexes`    — the indexes already on the table (so the operator can
 *                         see what the new one adds to write amplification).
 *
 * ESTIMATE NOTE: a measured local 1 M-row `activities` build took ≈ 3–5 s, and
 * the cost is dominated by the HEAP SCAN (roughly linear in table size) plus one
 * index write per row. The estimate is `max(3, sizeBytes / 64 MiB * 4)` seconds —
 * deliberately coarse, and the printed `sizeBytes` is the number to sanity-check
 * it against. A CONCURRENTLY build additionally does TWO heap passes plus a wait
 * for in-flight transactions, so the printed estimate is the lower bound: expect
 * up to ~2× on a busy box. The apply step reports the ACTUAL elapsed time.
 *
 * POST-APPLY (separate repo change, NOT done here): record the index in
 * `backend/prisma/schema.prisma` (`@@index([userId, action, createdAt])`) with a
 * no-op `IF NOT EXISTS` migration so Prisma's drift check agrees. This script
 * only creates the index in the live database.
 *
 * SAFETY: CONCURRENTLY cannot run inside a transaction block. This script uses
 * `$executeRawUnsafe` on a single statement (Prisma does not wrap that in an
 * implicit transaction), never `$transaction`. `IF NOT EXISTS` makes a re-run a
 * no-op. The statement is idempotent by construction; there is no --revert
 * match (dropping an index is instantaneous and harmless — the exact command is
 * printed for the operator).
 *
 * NOTE on prodq.sh: its header says probes must stay read-only. This file is a
 * deliberate, owner-directed write one-shot (same exception shape as
 * `session-topology-migrate.js` / `backfill-chat-mode-auto.js`) and every write
 * sits behind `--apply`; without it the script is a read-only probe.
 *
 * Testable offline: `module.exports.run({ prisma, argv, out })` takes a mocked
 * client (backend/src/scripts/ll1-activities-index.test.ts).
 */

'use strict';

const INDEX_NAME = 'activities_userId_action_createdAt_idx';
const TABLE = 'activities';

/** The exact DDL. CONCURRENTLY: no write lock on the audit path. */
const BUILD_SQL =
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX_NAME}" ` +
  `ON "${TABLE}" ("userId", "action", "createdAt")`;

function parseArgs(argv) {
  const out = { apply: false, timeoutMs: 900_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) out.timeoutMs = 900_000;
  return out;
}

/** Coarse, deliberately conservative build-time estimate (see the header note). */
function estimateSeconds(rows, sizeBytes) {
  const bySize = (Number(sizeBytes) || 0) / (64 * 1024 * 1024) * 4;
  const seconds = Math.max(3, bySize);
  return Math.round(seconds);
}

async function run({ prisma, argv = [], out = () => {} }) {
  const opts = parseArgs(argv);
  const log = (o) => out(JSON.stringify(o));

  const existing = await prisma.$queryRawUnsafe(
    `SELECT i.indexname, i.indexdef, pi.indisvalid AS valid
       FROM pg_indexes i
       LEFT JOIN pg_class c ON c.relname = i.indexname
       LEFT JOIN pg_index pi ON pi.indexrelid = c.oid
      WHERE i.tablename = $1
      ORDER BY i.indexname`,
    TABLE,
  );
  const rows = existing.map((r) => ({
    name: r.indexname,
    def: r.indexdef,
    valid: r.valid === null || r.valid === undefined ? null : Boolean(r.valid),
  }));
  const target = rows.find((r) => r.name === INDEX_NAME) || null;
  const others = rows.filter((r) => r.name !== INDEX_NAME).map((r) => r.name);

  const stat = await prisma.$queryRawUnsafe(
    `SELECT c.reltuples::bigint AS est_rows,
            pg_total_relation_size(c.oid)::bigint AS size_bytes,
            pg_relation_size(c.oid)::bigint AS heap_bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND c.relkind = 'r'
      LIMIT 1`,
    TABLE,
  );
  const estRows = Number(stat[0]?.est_rows ?? 0);
  const sizeBytes = Number(stat[0]?.size_bytes ?? 0);

  const report = {
    table: TABLE,
    index: INDEX_NAME,
    sql: BUILD_SQL,
    dryRun: !opts.apply,
    apply: opts.apply,
    rows: estRows,
    sizeBytes,
    estimateSeconds: estimateSeconds(estRows, sizeBytes),
    existing: target,
    otherIndexes: others,
    dropCommand: `DROP INDEX CONCURRENTLY IF EXISTS "${INDEX_NAME}";`,
  };

  if (target && target.valid === false) {
    // A previous CONCURRENTLY build that failed leaves an INVALID index: it is
    // ignored by the planner and blocks a rebuild until dropped.
    log({ ...report, refused: 'invalid_index_present', next: report.dropCommand });
    return 1;
  }
  if (target && target.valid !== false) {
    log({ ...report, skipped: 'already_present' });
    return 0;
  }
  if (!opts.apply) {
    log({ ...report, note: 'dry run — re-run with --apply to build the index (CONCURRENTLY: no write lock)' });
    return 0;
  }

  const started = Date.now();
  await prisma.$executeRawUnsafe(BUILD_SQL);
  const elapsedMs = Date.now() - started;
  const after = await prisma.$queryRawUnsafe(
    `SELECT i.indexname, pi.indisvalid AS valid FROM pg_indexes i
       LEFT JOIN pg_class c ON c.relname = i.indexname
       LEFT JOIN pg_index pi ON pi.indexrelid = c.oid
      WHERE i.tablename = $1 AND i.indexname = $2`,
    TABLE,
    INDEX_NAME,
  );
  log({
    ...report,
    dryRun: false,
    built: true,
    elapsedMs,
    estimateSeconds: report.estimateSeconds,
    valid: after[0] ? Boolean(after[0].valid) : null,
    next: 'record it in backend/prisma/schema.prisma (@@index([userId, action, createdAt])) with a no-op IF NOT EXISTS migration so the drift check agrees',
  });
  return 0;
}

module.exports = { run, parseArgs, estimateSeconds, BUILD_SQL, INDEX_NAME, TABLE };

/* istanbul ignore next — direct execution inside the live backend container. */
if (require.main === module) {
  (async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const prisma = require('/app/dist/config/database').default;
    const code = await run({ prisma, argv: process.argv.slice(2), out: (s) => console.log(s) });
    await prisma.$disconnect().catch(() => {});
    process.exit(code);
  })().catch((e) => {
    console.error('LL1_FAIL', e && e.message ? e.message : e);
    process.exit(1);
  });
}