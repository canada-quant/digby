/**
 * UNIFIED MEMORY — COLD TIER (digby_memory_archive, owner 2026-10-20: "archive
 * instead of delete when a store is full").
 *
 * Before: when a scope was full, unified-memory enforceScopeCap ran ONE
 * anti-join `DELETE … WHERE id NOT IN (newest-N keep set)` and the evicted rows
 * were gone for good (prod 2026-09-24: ~18k session rows evicted per day — a
 * lane's compaction summaries, worker digests and offloaded tool output that
 * search_memory had promised were "retrievable").
 *
 * Now the same eviction is ONE atomic statement that MOVES the rows:
 *   WITH moved AS (DELETE FROM digby_memory WHERE <today's predicate> RETURNING …)
 *   INSERT INTO digby_memory_archive (…) SELECT …, <reason> FROM moved
 * The hot store's cap, keep order and search cost are unchanged — only where an
 * evicted row lands changes. The archive is TEXT ONLY (no embedding, no HNSW):
 * a cold row is reachable through full-text search only (memSearchArchive), and
 * only the explicit search_memory tool tops up from it — never the per-turn
 * injected blocks. Retention bounds it: session rows 30 d, every other scope
 * 365 d (runMemoryArchiveRetention, a daily worker cron).
 *
 * Deletions that are a user's or an owner's intent (a chat / session / project
 * deleted, a ref explicitly removed) stay REAL deletions and clear the archived
 * copies too (unified-memory memClear / memDeleteRefs / an empty memReplaceRef).
 * A cap that evicts WHOLE refs (the code index's tiered cap, 2026-10-23) is an
 * eviction, so it archives too (memArchiveRefs → archiveRefsEvictionSql: one
 * archived generation per ref) — except refs with no live file behind them,
 * which it deletes and purges (memDeleteRefs); a file later deleted from the
 * checkout loses its archived copy (the code index tracks what its cap
 * archived, plus a daily complete-listing backstop, memPurgeArchivedRefsExcept).
 *
 * Pure SQL builders + the retention job live here; the write/read integration
 * lives in unified-memory.service.ts (which imports this leaf — never the
 * reverse, so there is no import cycle).
 *
 * Kill switch MEMORY_ARCHIVE_DISABLED=1: the cap sweep is today's plain DELETE
 * byte-for-byte. The table, the purges and the retention job keep running over
 * whatever was archived before the switch flipped (a user's deletion must still
 * clear old archived copies).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';

export const MEMORY_ARCHIVE_TABLE = 'digby_memory_archive';
/** Archived SESSION rows are kept this long (by archived_at). */
export const ARCHIVE_SESSION_RETENTION_DAYS = 30;
/** Archived rows of every other scope (user / project / chat) are kept this long. */
export const ARCHIVE_RETENTION_DAYS = 365;
export const ARCHIVE_RETENTION_BATCH_DEFAULT = 5000;
export const ARCHIVE_RETENTION_MAX_BATCHES_DEFAULT = 10;
/** Wall-clock bound for the search_memory cold leg (gate + FTS) — past it the hot result stands. */
export const ARCHIVE_SEARCH_TIMEOUT_MS = 1500;
/** The label a cold hit carries in the search_memory output. */
export const ARCHIVED_LABEL = '[archived]';

/** Kill switch: the cap sweep deletes (today's behaviour) instead of archiving. */
export function memoryArchiveDisabled(): boolean { return process.env.MEMORY_ARCHIVE_DISABLED === '1'; }

/** The columns an eviction moves hot → cold: digby_memory minus the embedding. */
export const ARCHIVE_MOVED_COLUMNS: readonly string[] = [
  'id', 'scope_type', 'scope_id', 'user_id', 'source', 'ref', 'title', 'content', 'created_at', 'last_hit_at',
];

/**
 * Idempotent DDL, run from unified-memory ensureTable() after the hot table's
 * own DDL. Same column types as digby_memory (minus the embedding) plus
 * archived_at / archive_reason. Indexes: scope lookup (search + purges),
 * archived_at (retention), and the SAME FTS expression as digby_mem_fts_idx so
 * the cold leg's @@ predicate can use it.
 */
export const ARCHIVE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS digby_memory_archive (
          id text PRIMARY KEY,
          scope_type text NOT NULL,
          scope_id text NOT NULL,
          user_id text,
          source text NOT NULL,
          ref text,
          title text,
          content text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          last_hit_at timestamptz,
          archived_at timestamptz NOT NULL DEFAULT now(),
          archive_reason text
        )`,
  `CREATE INDEX IF NOT EXISTS digby_mem_archive_scope_idx ON digby_memory_archive (scope_type, scope_id)`,
  `CREATE INDEX IF NOT EXISTS digby_mem_archive_archived_at_idx ON digby_memory_archive (archived_at)`,
  `CREATE INDEX IF NOT EXISTS digby_mem_archive_fts_idx ON digby_memory_archive USING gin (to_tsvector('english', coalesce(title,'') || ' ' || content))`,
];

/** Existence probe — the concurrent-boot fallback (two processes racing the
 *  same CREATE … IF NOT EXISTS can fail one of them on a catalog unique key). */
export const ARCHIVE_EXISTS_SQL = `SELECT to_regclass('digby_memory_archive') IS NOT NULL AS ok`;

/**
 * Wrap an eviction DELETE (built by enforceScopeCap, unchanged) so its rows
 * move into the archive in the same statement. `reasonParam` is the 1-based
 * index of the archive_reason bind parameter (after the DELETE's own params).
 * The statement's row count is the INSERT's — every moved row is inserted (ids
 * are random UUIDs; ON CONFLICT only guards a re-archived id), so it is the
 * eviction count the existing metric reports.
 */
export function archiveEvictionSql(deleteSql: string, reasonParam: number): string {
  const cols = ARCHIVE_MOVED_COLUMNS.join(', ');
  return `WITH moved AS (${deleteSql} RETURNING ${cols}) INSERT INTO digby_memory_archive (${cols}, archive_reason) SELECT ${cols}, $${reasonParam}::text FROM moved ON CONFLICT (id) DO NOTHING`;
}

/**
 * A cap eviction of WHOLE refs (the code index's tiered row cap, 2026-10-23):
 * ONE statement that drops those refs' previous archived generation and moves
 * their hot rows into the archive, so a ref the cap evicts, re-embeds and
 * evicts again holds ONE archived copy (the latest), never a growing pile.
 * The `prior` CTE runs to completion even though nothing reads it; it cannot
 * see the rows this statement inserts (one snapshot), so it never deletes the
 * new generation. Params: $1 scope_type, $2 scope_id, $3 source, $4 refs
 * text[], $5 archive_reason. Row count = the rows moved.
 */
export function archiveRefsEvictionSql(): string {
  const cols = ARCHIVE_MOVED_COLUMNS.join(', ');
  const pred = 'scope_type = $1 AND scope_id = $2 AND source = $3 AND ref = ANY($4::text[])';
  return `WITH prior AS (DELETE FROM digby_memory_archive WHERE ${pred}), moved AS (DELETE FROM digby_memory WHERE ${pred} RETURNING ${cols}) INSERT INTO digby_memory_archive (${cols}, archive_reason) SELECT ${cols}, $5::text FROM moved ON CONFLICT (id) DO NOTHING`;
}

/** Purge every archived row of one scope (the scope itself was deleted). Params: $1 scope_type, $2 scope_id. */
export const ARCHIVE_PURGE_SCOPE_SQL = `DELETE FROM digby_memory_archive WHERE scope_type = $1 AND scope_id = $2`;
/** Purge the archived copies of explicitly-deleted refs. Params: $1 scope_type, $2 scope_id, $3 source, $4 refs text[]. */
export const ARCHIVE_PURGE_REFS_SQL = `DELETE FROM digby_memory_archive WHERE scope_type = $1 AND scope_id = $2 AND source = $3 AND ref = ANY($4::text[])`;
/**
 * Purge every archived row of (scope, source) whose ref is NOT in a keep list —
 * the code index's backstop on a COMPLETE checkout listing (2026-10-23 round 4):
 * a file not listed is gone from the repo, so an archived copy of it is
 * content that should have been deleted (an untracked copy: a legacy-era
 * eviction, a purge that failed). A NULL ref has no file behind it either.
 * Params: $1 scope_type, $2 scope_id, $3 source, $4 keep refs text[].
 */
export const ARCHIVE_PURGE_REFS_EXCEPT_SQL = `DELETE FROM digby_memory_archive WHERE scope_type = $1 AND scope_id = $2 AND source = $3 AND (ref IS NULL OR NOT (ref = ANY($4::text[])))`;

/** One bounded retention batch. Param: $1 the cutoff (timestamptz, ISO string). */
export function archiveRetentionBatchSql(session: boolean, batch: number): string {
  const scopeCond = session ? `scope_type = 'session'` : `scope_type <> 'session'`;
  return `DELETE FROM digby_memory_archive WHERE id IN (SELECT id FROM digby_memory_archive WHERE ${scopeCond} AND archived_at < $1::timestamptz ORDER BY archived_at LIMIT ${Math.max(1, Math.floor(batch))})`;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo ? Math.min(hi, Math.floor(n)) : dflt;
}

/**
 * Retention for the cold tier: delete archived rows older (by archived_at)
 * than ARCHIVE_SESSION_RETENTION_DAYS for scope_type 'session' and
 * ARCHIVE_RETENTION_DAYS for every other scope, in bounded batches — at most
 * `maxBatches` × `batch` rows per window per call (defaults 10 × 5000), oldest
 * first. A missing table (archive never created on this database) is a quiet
 * no-op. Never throws. Records ONE loop_metrics row per call (kind
 * memory_scope_evicted, meta.reason 'archive_retention', meta.scopeType
 * 'archive' — the existing eviction kind, so the audit's eviction views show
 * the cold tier's end of life beside the hot tier's evictions).
 */
export async function runMemoryArchiveRetention(opts?: { now?: Date | number; batch?: number; maxBatches?: number }): Promise<{ deleted: number }> {
  const t0 = Date.now();
  const nowMs = opts?.now instanceof Date ? opts.now.getTime() : typeof opts?.now === 'number' && Number.isFinite(opts.now) ? opts.now : Date.now();
  const batch = clampInt(opts?.batch, 1, 50_000, ARCHIVE_RETENTION_BATCH_DEFAULT);
  const maxBatches = clampInt(opts?.maxBatches, 1, 100, ARCHIVE_RETENTION_MAX_BATCHES_DEFAULT);
  const windows = [
    { key: 'session' as const, session: true, days: ARCHIVE_SESSION_RETENTION_DAYS },
    { key: 'other' as const, session: false, days: ARCHIVE_RETENTION_DAYS },
  ];
  const deletedBy = { session: 0, other: 0 };
  let batches = 0;
  let capped = false;
  let skipped: string | undefined;
  let error: string | undefined;
  try {
    const probe = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(ARCHIVE_EXISTS_SQL);
    if (!(Array.isArray(probe) && probe[0]?.ok)) {
      skipped = 'no_table';
    } else {
      for (const w of windows) {
        const cutoff = new Date(nowMs - w.days * 86_400_000).toISOString();
        for (let i = 0; i < maxBatches; i++) {
          const n = await prisma.$executeRawUnsafe(archiveRetentionBatchSql(w.session, batch), cutoff);
          batches += 1;
          const got = typeof n === 'number' && n > 0 ? n : 0;
          deletedBy[w.key] += got;
          if (got < batch) break;
          if (i === maxBatches - 1) capped = true; // more remains — the next run continues
        }
      }
    }
  } catch (e: any) {
    error = String(e?.message ?? e).slice(0, 300);
    logger.warn(`memory-archive: retention pass failed after ${deletedBy.session + deletedBy.other} row(s) (non-fatal, next run retries): ${error}`);
  }
  const deleted = deletedBy.session + deletedBy.other;
  try {
    const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('../platform/loop-metrics.service');
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MEMORY_SCOPE_EVICTED,
      value: deleted,
      unit: 'rows',
      meta: {
        reason: 'archive_retention', scopeType: 'archive', table: MEMORY_ARCHIVE_TABLE,
        sessionDeleted: deletedBy.session, otherDeleted: deletedBy.other,
        sessionRetentionDays: ARCHIVE_SESSION_RETENTION_DAYS, retentionDays: ARCHIVE_RETENTION_DAYS,
        batch, maxBatches, batches, ms: Date.now() - t0,
        ...(capped ? { capped: true } : {}), ...(skipped ? { skipped } : {}), ...(error ? { error } : {}),
      },
    });
  } catch { /* telemetry is best-effort */ }
  if (deleted > 0) logger.info(`memory-archive: retention deleted ${deleted} archived row(s) (session ${deletedBy.session} > ${ARCHIVE_SESSION_RETENTION_DAYS} d, other ${deletedBy.other} > ${ARCHIVE_RETENTION_DAYS} d${capped ? '; batch budget reached — the next run continues' : ''})`);
  return { deleted };
}
