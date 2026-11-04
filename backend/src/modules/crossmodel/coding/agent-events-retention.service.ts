/**
 * agent_events retention (owner 2026-09-22: "yes do all of that now").
 *
 * agent_events is the coding runs' per-step event stream — live streaming,
 * reconnect catch-up, transcript rewind. It had NO retention: 19 GB, 26.8 M
 * rows older than 14 days, ~500k new rows a day, and only the run reaper's
 * targeted deletes. After a run finalizes the durable record lives elsewhere
 * (coding_messages, run_journal_entries, run_tool_receipts, compaction
 * records), so events only need to stay hot while someone can replay them.
 *
 * Tiered retention, step 1 (this module): a bounded, steady, worker-driven
 * delete of rows older than AGENT_EVENTS_RETENTION_DAYS (default 30).
 *
 *   - Batches walk the BigInt primary key from the oldest row upward — ids are
 *     monotonic with time and the table has no createdAt index, so every batch
 *     is a cheap PK range scan; the walk stops at the first range whose newest
 *     row is inside the retention window.
 *   - At most AGENT_EVENTS_RETENTION_MAX_BATCHES batches of
 *     AGENT_EVENTS_RETENTION_BATCH rows per tick (defaults 4 × 5,000 every 60 s
 *     ≈ 29 M rows/day of capacity — the backlog drains in about a day without a
 *     DELETE storm; plain DELETE on RDS hands pages back through autovacuum, so
 *     steady beats big).
 *   - AGENT_EVENTS_RETENTION_DRY_RUN=1 reports what a tick WOULD delete and
 *     deletes nothing; AGENT_EVENTS_RETENTION_DISABLED=1 stops the job.
 *   - One loop_metrics row per tick that found work (kind
 *     agent_events_retention: value = rows deleted or would-delete; meta
 *     {mode, batches, cutoff, oldestRemaining, ms}).
 *
 * Step 1b (audit 2026-10-06 T9): TIERED compaction inside the window — see
 * runAgentEventsCompactionOnce below (reader map + tiers in its header).
 *
 * Step 2 (when growth warrants): native range partitioning by week so retention
 * becomes DROP PARTITION. Step 3 (owner's call, costs a bucket): archive expired
 * partitions to S3 before dropping.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { storeGet, storePut } from '../memory/context-store';
import { hideReasoningDisabled } from './reasoning-wire';
// MERGE-1 slice 1: the ONE read-switch seam. The retention lateral used to hard-code
// coding_messages and so was the only transcript reader invisible to the switch.
import { transcriptReadMode } from './transcript-source';

export const AGENT_EVENTS_RETENTION_DISABLED_ENV = 'AGENT_EVENTS_RETENTION_DISABLED';
export const AGENT_EVENTS_RETENTION_DRY_RUN_ENV = 'AGENT_EVENTS_RETENTION_DRY_RUN';
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_BATCH_ROWS = 5000;
export const DEFAULT_MAX_BATCHES_PER_TICK = 4;
const MIN_RETENTION_DAYS = 7; // a misconfigured env can never shred last week's runs

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
export function retentionDays(): number { return envInt('AGENT_EVENTS_RETENTION_DAYS', DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, 3650); }
export function batchRows(): number { return envInt('AGENT_EVENTS_RETENTION_BATCH', DEFAULT_BATCH_ROWS, 100, 50_000); }
export function maxBatchesPerTick(): number { return envInt('AGENT_EVENTS_RETENTION_MAX_BATCHES', DEFAULT_MAX_BATCHES_PER_TICK, 1, 50); }
export function retentionDisabled(): boolean { return process.env[AGENT_EVENTS_RETENTION_DISABLED_ENV] === '1'; }
export function retentionDryRun(): boolean { return process.env[AGENT_EVENTS_RETENTION_DRY_RUN_ENV] === '1'; }

export interface RetentionTickResult {
  mode: 'delete' | 'dry_run' | 'disabled';
  cutoff: string;
  batches: number;
  /** rows deleted (delete mode) or rows that would have been deleted (dry run) */
  rows: number;
  /** createdAt of the oldest row still in the table after the tick (null = table empty) */
  oldestRemaining: string | null;
  /** true when the tick stopped because it reached the retention boundary (backlog clear) */
  reachedBoundary: boolean;
  ms: number;
}

/** Bounded sweep: at most maxBatches PK ranges of batch rows, oldest first, stopping at the retention boundary. Never throws. */
export async function runAgentEventsRetentionOnce(now: Date = new Date()): Promise<RetentionTickResult> {
  const t0 = Date.now();
  const cutoff = new Date(now.getTime() - retentionDays() * 24 * 60 * 60 * 1000);
  const base: RetentionTickResult = { mode: retentionDryRun() ? 'dry_run' : 'delete', cutoff: cutoff.toISOString(), batches: 0, rows: 0, oldestRemaining: null, reachedBoundary: false, ms: 0 };
  if (retentionDisabled()) return { ...base, mode: 'disabled', ms: Date.now() - t0 };
  const batch = batchRows();
  const maxBatches = maxBatchesPerTick();
  try {
    for (let i = 0; i < maxBatches; i++) {
      const oldest = await prisma.$queryRawUnsafe<Array<{ id: bigint; createdAt: Date }>>(
        `SELECT id, "createdAt" FROM agent_events ORDER BY id ASC LIMIT 1`,
      );
      if (!oldest.length) { base.oldestRemaining = null; base.reachedBoundary = true; break; }
      const lo = BigInt(oldest[0].id);
      base.oldestRemaining = new Date(oldest[0].createdAt).toISOString();
      if (new Date(oldest[0].createdAt) >= cutoff) { base.reachedBoundary = true; break; }
      const hi = lo + BigInt(batch);
      // The newest row in this PK range decides whether the WHOLE range is expired.
      const edge = await prisma.$queryRawUnsafe<Array<{ n: bigint; newest: Date | null }>>(
        `SELECT COUNT(*)::bigint AS n, MAX("createdAt") AS newest FROM agent_events WHERE id >= $1 AND id < $2`,
        lo, hi,
      );
      const n = Number(edge[0]?.n ?? 0);
      const newest = edge[0]?.newest ? new Date(edge[0].newest) : null;
      if (n === 0) { continue; } // a gap in the id space — the next loop re-reads the oldest row
      if (newest && newest >= cutoff) {
        // Mixed range at the boundary: delete only the expired rows inside it (bounded by the range), then stop.
        if (base.mode === 'delete') {
          const del = await prisma.$executeRawUnsafe(`DELETE FROM agent_events WHERE id >= $1 AND id < $2 AND "createdAt" < $3`, lo, hi, cutoff);
          base.rows += Number(del) || 0;
        } else {
          const cnt = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM agent_events WHERE id >= $1 AND id < $2 AND "createdAt" < $3`, lo, hi, cutoff);
          base.rows += Number(cnt[0]?.n ?? 0);
        }
        base.batches++;
        base.reachedBoundary = true;
        break;
      }
      if (base.mode === 'delete') {
        const del = await prisma.$executeRawUnsafe(`DELETE FROM agent_events WHERE id >= $1 AND id < $2`, lo, hi);
        base.rows += Number(del) || 0;
      } else {
        base.rows += n;
        // A dry run cannot advance past this range (nothing was deleted) — one range is the sample.
        base.batches++;
        break;
      }
      base.batches++;
    }
  } catch (err: any) {
    logger.warn(`agent-events-retention: tick failed after ${base.batches} batch(es), ${base.rows} row(s): ${err?.message ?? err}`);
  }
  base.ms = Date.now() - t0;
  if (base.rows > 0 || base.batches > 0) {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.AGENT_EVENTS_RETENTION,
      value: base.rows,
      unit: 'rows',
      meta: { mode: base.mode, batches: base.batches, cutoff: base.cutoff, oldestRemaining: base.oldestRemaining, reachedBoundary: base.reachedBoundary, ms: base.ms },
    });
    logger.info(`agent-events-retention: ${base.mode === 'dry_run' ? 'would delete' : 'deleted'} ${base.rows} row(s) in ${base.batches} batch(es) older than ${base.cutoff} (${base.ms} ms; oldest remaining ${base.oldestRemaining ?? 'none'}${base.reachedBoundary ? '; boundary reached' : ''})`);
  }
  return base;
}

/* ══════════════════════════════════════════════════════════════════════════
 * Tiered compaction INSIDE the retention window (audit 2026-10-06 T9; owner:
 * "look if there are wasted agent events or duplicates").
 *
 * Measured on prod (0.5 % page sample, 2026-10-06): 19.4 M rows — heap 8.2 GB
 * + TOAST 3.5 GB + indexes 8.7 GB. 81 % of the ROWS are `reasoning` (44 %) +
 * `subagent:reasoning` (37 %) — never written since 5dc95748 (2026-10-04,
 * reasoning-wire.ts) and never read back. By BYTES: `context` ~1.4 GB (one per
 * turn, cumulative usage), `browser_observation` ~1.0 GB (base64 frames),
 * `reasoning` ~0.95 GB, `tool_result` ~0.46 GB, `complete` ~0.44 GB (a copy of
 * the final coding_messages.parts), `image` ~0.3 GB (base64).
 *
 * WHO READS agent_events (T9-1), and what each still needs once a run is
 * TERMINAL (completed | failed | cancelled):
 *   - coding-stream.controller tailActiveRun — the live tail (queued / running /
 *     interrupted). Never a terminal run's old rows (a run aged past the walk
 *     frontier finished days ago).
 *   - coding-stream.controller replayRun — attach to a session's LATEST run when
 *     nothing is active. The web client attaches only while the session reads
 *     'running' (a finished-meanwhile race), and on the replayed `complete` an
 *     attach reloads the transcript over REST (reloadSession) — the replayed
 *     parts are discarded; mobile uses `complete` as a terminal signal only.
 *   - createFrameWriter — drops `reasoning` / `subagent:reasoning` rows before
 *     any client sees them (withholdFromClient) unless HIDE_REASONING_DISABLED=1.
 *   - run-state getMaxAgentEventSeq — seq priming at claim / resume: queued or
 *     interrupted runs only. A terminal run is never re-claimed (a new run gets
 *     a new id and adopts the checkpoint), so deleting its rows can never make a
 *     seq collide.
 *   - run-state getLatestEventRunId — existence only (no live caller).
 *   - run-reaper rule (c) + the retention sweep above — ids / createdAt only.
 *   - owner-run audit scripts (scripts/framework-audit backtest-agent-decisions:
 *     progress, plan_update, tool_call, tool_result, text, complete-createdAt,
 *     verify_result, guard_marker, draft_discarded; verify-568d3652-*:
 *     tool_call / tool_result; probe-e0d5b63d*: subagent:tool_call /
 *     tool_result / progress / text; audit-live-state + playbook.sh: counts).
 *   ⇒ after a run is terminal NOTHING reads `reasoning` / `subagent:reasoning`;
 *     only the LAST `context` matters (cumulative); screenshots / image bytes
 *     are panel-only (the transcript keeps the image part); `complete.parts`
 *     duplicates the final coding_messages row. Every other type is read by an
 *     audit script and is KEPT (tier c adds nothing).
 *
 * Tiers, applied per PK range of a walk that covers the table ONCE and then
 * only new ranges (persisted cursor in the context store):
 *   (a) reasoning — `reasoning` / `subagent:reasoning` rows of TERMINAL runs are
 *       deleted at any age (skipped while HIDE_REASONING_DISABLED=1 — then they
 *       replay to clients again);
 *   (b) runs finished more than AGENT_EVENTS_COMPACTION_AFTER_DAYS (2) ago:
 *       every `context` row but the run's LAST one is deleted; `browser_observation`
 *       loses `screenshotBase64` and `image` loses `data` (stub
 *       {omitted:true, omittedField, omittedBytes} — the row and its seq stay);
 *       `complete` loses `parts` when the run's final assistant coding_messages
 *       row exists (stub {partsOmitted:true, partsCount, messageId, omittedBytes};
 *       finalText kept — the same `partsOmitted` flag new events carry).
 *
 * Gentle by construction (the DB is IOPS-bound): ≤ AGENT_EVENTS_COMPACTION_MAX_RANGES
 * (2) ranges of AGENT_EVENTS_COMPACTION_RANGE (2,000) ids per 60 s tick and a
 * AGENT_EVENTS_COMPACTION_TICK_BUDGET_MS (20 s) budget ⇒ ≤ 4,000 ids / min
 * (≈ 5.8 M / day); rows are reached ONLY through the primary key — one
 * payload-free PK range read per range, then statements on explicit ids (the
 * table has no createdAt / type index, and the (runId, seq) index would read
 * whole runs) — and the only (runId, seq) use is the context EXISTS probe to
 * the run's next context row; the walk stops at a
 * frontier AFTER_DAYS + 1 days old (runs up to a day long are already aged
 * when their rows are walked) and SKIPS ranges the 30-day retention deletes
 * within a day (no writes to rows about to vanish). A range whose statements
 * fail is retried next tick and passed over after 3 straight failures.
 * AGENT_EVENTS_COMPACTION_DISABLED=1 stops it; AGENT_EVENTS_COMPACTION_DRY_RUN=1
 * (or the retention's AGENT_EVENTS_RETENTION_DRY_RUN=1) counts what each tier
 * WOULD touch and writes nothing to agent_events, walking its OWN cursor so a
 * dry run estimates the whole backlog without moving the real one. One
 * loop_metrics row per tick that did work (kind agent_events_compaction).
 * ══════════════════════════════════════════════════════════════════════════ */

export const AGENT_EVENTS_COMPACTION_DISABLED_ENV = 'AGENT_EVENTS_COMPACTION_DISABLED';
export const AGENT_EVENTS_COMPACTION_DRY_RUN_ENV = 'AGENT_EVENTS_COMPACTION_DRY_RUN';
export const DEFAULT_COMPACTION_AFTER_DAYS = 2;
export const DEFAULT_COMPACTION_RANGE_IDS = 2000;
export const DEFAULT_COMPACTION_MAX_RANGES = 2;
export const DEFAULT_COMPACTION_TICK_BUDGET_MS = 20_000;
/** Ranges passed over (about to expire) per tick — each costs two single-row PK probes. */
export const COMPACTION_MAX_SKIPS_PER_TICK = 200;
/** A range whose statements fail this many ticks in a row is passed over (never a stuck walk). */
export const COMPACTION_MAX_RANGE_FAILURES = 3;
/** The walk frontier trails the "aged" cutoff by this much, so runs up to a day long are aged when walked. */
const FRONTIER_SLACK_DAYS = 1;
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
export const COMPACTION_CURSOR_NS = ['instance', 'agent-events-compaction'];
export const COMPACTION_CURSOR_KEY = 'cursor';
export const COMPACTION_DRY_RUN_CURSOR_KEY = 'dry-run-cursor';
const DAY_MS = 24 * 60 * 60 * 1000;

const envFlag = (name: string): boolean => {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
};
export function compactionDisabled(): boolean { return envFlag(AGENT_EVENTS_COMPACTION_DISABLED_ENV); }
export function compactionDryRun(): boolean { return envFlag(AGENT_EVENTS_COMPACTION_DRY_RUN_ENV) || retentionDryRun(); }
export function compactionAfterDays(): number { return envInt('AGENT_EVENTS_COMPACTION_AFTER_DAYS', DEFAULT_COMPACTION_AFTER_DAYS, 1, 14); }
export function compactionRangeIds(): number { return envInt('AGENT_EVENTS_COMPACTION_RANGE', DEFAULT_COMPACTION_RANGE_IDS, 100, 20_000); }
export function compactionMaxRanges(): number { return envInt('AGENT_EVENTS_COMPACTION_MAX_RANGES', DEFAULT_COMPACTION_MAX_RANGES, 1, 50); }
export function compactionTickBudgetMs(): number { return envInt('AGENT_EVENTS_COMPACTION_TICK_BUDGET_MS', DEFAULT_COMPACTION_TICK_BUDGET_MS, 1_000, 300_000); }

export type CompactionTier = 'reasoning' | 'context' | 'screenshots' | 'images' | 'complete';
export const COMPACTION_TIERS: readonly CompactionTier[] = ['reasoning', 'context', 'screenshots', 'images', 'complete'];

export interface CompactionTickResult {
  mode: 'apply' | 'dry_run' | 'disabled';
  /** ranges compacted this tick */
  ranges: number;
  /** ranges passed over because the 30-day retention deletes them within a day */
  skips: number;
  /** first id this tick looked at (null = nothing to do) */
  fromId: string | null;
  /** the persisted cursor after the tick (the next tick starts at the first row ≥ it) */
  cursor: string | null;
  /** true when the walk caught up with the frontier (backlog done for now) */
  reachedFrontier: boolean;
  /** per tier: rows deleted / stripped (or would be) and approx bytes (stripped field size, or stored row size for deletes / dry runs) */
  tiers: Record<CompactionTier, { rows: number; bytes: number }>;
  rows: number;
  bytes: number;
  ms: number;
}

/**
 * The tier statements. A range is read ONCE through the primary key (id, runId,
 * type — no payload); the rows each tier may touch are picked in JS (run status
 * from ONE agent_runs read) and every statement then targets those explicit ids
 * ($1 = bigint[]), so the planner can only reach rows through the PK — never the
 * (runId, seq) index over whole runs (a 50k-row run would be re-read per range).
 * The type predicate is re-checked in SQL. Each returns {n, bytes}; the leading
 * comment tags it for pg_stat_statements / tests. `apply` mutates; `dry` counts
 * the same predicate with no write.
 */
const BY_IDS = `e.id = ANY($1::bigint[])`;
const DELETE_STMT = (tag: string, pred: string) => ({
  apply: `/* t9:${tag}:apply */ WITH d AS (DELETE FROM agent_events e WHERE ${BY_IDS} ${pred} RETURNING pg_column_size(e.payload) AS b) SELECT COUNT(*)::bigint AS n, COALESCE(SUM(b), 0)::bigint AS bytes FROM d`,
  dry: `/* t9:${tag}:dry */ SELECT COUNT(*)::bigint AS n, COALESCE(SUM(pg_column_size(e.payload)), 0)::bigint AS bytes FROM agent_events e WHERE ${BY_IDS} ${pred}`,
});
const STRIP_STMT = (tag: string, type: string, field: string) => ({
  apply: `/* t9:${tag}:apply */ WITH u AS (UPDATE agent_events e SET payload = (e.payload - '${field}') || jsonb_build_object('omitted', true, 'omittedField', '${field}', 'omittedBytes', octet_length(e.payload->>'${field}')) WHERE ${BY_IDS} AND e.type = '${type}' AND jsonb_typeof(e.payload->'${field}') = 'string' RETURNING (e.payload->>'omittedBytes')::bigint AS b) SELECT COUNT(*)::bigint AS n, COALESCE(SUM(b), 0)::bigint AS bytes FROM u`,
  dry: `/* t9:${tag}:dry */ SELECT COUNT(*)::bigint AS n, COALESCE(SUM(pg_column_size(e.payload)), 0)::bigint AS bytes FROM agent_events e WHERE ${BY_IDS} AND e.type = '${type}' AND jsonb_typeof(e.payload->'${field}') = 'string'`,
});
/**
 * The run's final assistant transcript row: same chat, created inside the run's window, with parts (IS NOT NULL —
 * never detoasts a multi-MB transcript; run-executor always persists an array). Rides the transcript table's
 * (chat, createdAt) index backwards with LIMIT 1.
 *
 * MERGE-1 slice 1: the table is a PARAMETER, resolved through the existing read-switch
 * (`transcriptReadMode()` in coding-data.service.ts) by `compactionSql()`. Before this the
 * lateral hard-coded `coding_messages`, so it was the one reader invisible to the switch —
 * and after the drop it would have raised 42P01 on every range, been swallowed by the
 * retry/skip path, and silently stopped stripping `agent_events.payload.parts`.
 * `coding_messages` names the chat column `sessionId`; the mirror `crossmodel_messages`
 * names it `chatId` — the only two differences.
 */
const TRANSCRIPT_TABLE = {
  legacy: { table: 'coding_messages', chatCol: 'sessionId' },
  merged: { table: 'crossmodel_messages', chatCol: 'chatId' },
} as const;
type TranscriptSource = keyof typeof TRANSCRIPT_TABLE;

const finalMessageLateral = (source: TranscriptSource): string => {
  const { table, chatCol } = TRANSCRIPT_TABLE[source];
  return `CROSS JOIN LATERAL (
    SELECT cm.id FROM ${table} cm
    WHERE cm."${chatCol}" = r."sessionId" AND cm.role = 'assistant' AND cm.parts IS NOT NULL
      AND cm."createdAt" >= r."createdAt" AND cm."createdAt" <= COALESCE(r."finishedAt", r."updatedAt") + interval '10 minutes'
    ORDER BY cm."createdAt" DESC LIMIT 1
  ) m`;
};
/**
 * The tier statements for ONE transcript source. `merged` is the default and the
 * drop-safe shape; `legacy` is what every tier statement used before slice 1 and is
 * kept so `TRANSCRIPT_READ=legacy` behaves exactly as it does today.
 */
export function compactionSql(source: TranscriptSource): Record<CompactionTier, { apply: string; dry: string }> {
  const LATERAL = finalMessageLateral(source);
  return {
    reasoning: DELETE_STMT('reasoning', `AND e.type IN ('reasoning', 'subagent:reasoning')`),
    // Every context row with a LATER context row in the same run goes — the (runId, seq) index answers the EXISTS.
    context: DELETE_STMT('context', `AND e.type = 'context' AND EXISTS (SELECT 1 FROM agent_events l WHERE l."runId" = e."runId" AND l.seq > e.seq AND l.type = 'context')`),
    screenshots: STRIP_STMT('screenshots', 'browser_observation', 'screenshotBase64'),
    images: STRIP_STMT('images', 'image', 'data'),
    complete: {
      apply: `/* t9:complete:apply */ WITH u AS (UPDATE agent_events e SET payload = (e.payload - 'parts') || jsonb_build_object('partsOmitted', true, 'partsCount', jsonb_array_length(e.payload->'parts'), 'messageId', m.id, 'omittedBytes', octet_length((e.payload->'parts')::text)) FROM agent_runs r ${LATERAL} WHERE ${BY_IDS} AND r.id = e."runId" AND e.type = 'complete' AND jsonb_typeof(e.payload->'parts') = 'array' RETURNING (e.payload->>'omittedBytes')::bigint AS b) SELECT COUNT(*)::bigint AS n, COALESCE(SUM(b), 0)::bigint AS bytes FROM u`,
      dry: `/* t9:complete:dry */ SELECT COUNT(*)::bigint AS n, COALESCE(SUM(pg_column_size(e.payload)), 0)::bigint AS bytes FROM agent_events e JOIN agent_runs r ON r.id = e."runId" ${LATERAL} WHERE ${BY_IDS} AND e.type = 'complete' AND jsonb_typeof(e.payload->'parts') = 'array'`,
    },
  };
}
/** Merged-shape statements (the default read switch) — kept as a named export for the suites that pin statement shape. */
export const COMPACTION_SQL = compactionSql('merged');
/** The event types each tier may touch (re-checked in SQL). */
const TIER_TYPES: Record<CompactionTier, ReadonlySet<string>> = {
  reasoning: new Set(['reasoning', 'subagent:reasoning']),
  context: new Set(['context']),
  screenshots: new Set(['browser_observation']),
  images: new Set(['image']),
  complete: new Set(['complete']),
};
const FIRST_ROW_SQL = `/* t9:probe */ SELECT id, "createdAt" FROM agent_events WHERE id >= $1 ORDER BY id ASC LIMIT 1`;
const LAST_ROW_BEFORE_SQL = `/* t9:probe-last */ SELECT id, "createdAt" FROM agent_events WHERE id < $1 ORDER BY id DESC LIMIT 1`;
// Two trivially index-driven reads (a PK range without payloads, then agent_runs by PK).
const RANGE_ROWS_SQL = `/* t9:range-rows */ SELECT id, "runId", type FROM agent_events WHERE id >= $1 AND id < $2`;
const RUN_STATUS_SQL = `/* t9:run-status */ SELECT id, status, "finishedAt" FROM agent_runs WHERE id = ANY($1::text[])`;

interface CursorRecord { nextId: string; failures?: number; updatedAt?: string }

async function firstRowAtOrAfter(id: bigint): Promise<{ id: bigint; createdAt: Date } | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint; createdAt: Date }>>(FIRST_ROW_SQL, id);
  return rows.length ? { id: BigInt(rows[0].id), createdAt: new Date(rows[0].createdAt) } : null;
}

async function lastRowBefore(id: bigint): Promise<{ id: bigint; createdAt: Date } | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint; createdAt: Date }>>(LAST_ROW_BEFORE_SQL, id);
  return rows.length ? { id: BigInt(rows[0].id), createdAt: new Date(rows[0].createdAt) } : null;
}

function emptyTiers(): CompactionTickResult['tiers'] {
  return { reasoning: { rows: 0, bytes: 0 }, context: { rows: 0, bytes: 0 }, screenshots: { rows: 0, bytes: 0 }, images: { rows: 0, bytes: 0 }, complete: { rows: 0, bytes: 0 } };
}

/** Compact ONE PK range [lo, hi). Throws on a statement failure (the caller retries the range next tick). */
async function compactRange(lo: bigint, hi: bigint, dry: boolean, agedBefore: Date, tiers: CompactionTickResult['tiers'], sql: ReturnType<typeof compactionSql>): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: bigint | number | string; runId: string; type: string }>>(RANGE_ROWS_SQL, lo, hi);
  if (!rows.length) return;
  const runs = await prisma.$queryRawUnsafe<Array<{ id: string; status: string; finishedAt: Date | null }>>(RUN_STATUS_SQL, [...new Set(rows.map((r) => r.runId))]);
  const terminal = runs.filter((r) => TERMINAL_RUN_STATUSES.has(r.status));
  const terminalRuns = new Set(terminal.map((r) => r.id));
  const agedRuns = new Set(terminal.filter((r) => r.finishedAt && new Date(r.finishedAt) < agedBefore).map((r) => r.id));
  for (const tier of COMPACTION_TIERS) {
    if (tier === 'reasoning' && hideReasoningDisabled()) continue; // reasoning replays to clients again — keep it
    const eligible = tier === 'reasoning' ? terminalRuns : agedRuns;
    const ids = rows.filter((r) => TIER_TYPES[tier].has(r.type) && eligible.has(r.runId)).map((r) => String(r.id));
    if (!ids.length) continue;
    const out = await prisma.$queryRawUnsafe<Array<{ n: bigint | number; bytes: bigint | number | null }>>(dry ? sql[tier].dry : sql[tier].apply, ids);
    tiers[tier].rows += Number(out[0]?.n ?? 0);
    tiers[tier].bytes += Number(out[0]?.bytes ?? 0);
  }
}

/**
 * One bounded compaction tick (see the block comment above). Never throws.
 * `now` is injectable for tests.
 */
export async function runAgentEventsCompactionOnce(now: Date = new Date()): Promise<CompactionTickResult> {
  const t0 = Date.now();
  const dry = compactionDryRun();
  const res: CompactionTickResult = { mode: dry ? 'dry_run' : 'apply', ranges: 0, skips: 0, fromId: null, cursor: null, reachedFrontier: false, tiers: emptyTiers(), rows: 0, bytes: 0, ms: 0 };
  if (compactionDisabled()) return { ...res, mode: 'disabled', ms: Date.now() - t0 };
  const cursorKey = dry ? COMPACTION_DRY_RUN_CURSOR_KEY : COMPACTION_CURSOR_KEY;
  const rangeIds = BigInt(compactionRangeIds());
  const maxRanges = compactionMaxRanges();
  const budgetMs = compactionTickBudgetMs();
  const afterDays = compactionAfterDays();
  const agedBefore = new Date(now.getTime() - afterDays * DAY_MS);
  const frontier = new Date(now.getTime() - (afterDays + FRONTIER_SLACK_DAYS) * DAY_MS);
  // Rows this old are deleted by the 30-day sweep within a day — compacting them first would only add writes.
  const expiresSoon = new Date(now.getTime() - (retentionDays() - 1) * DAY_MS);

  let stored: CursorRecord | null = null;
  try { stored = await storeGet<CursorRecord>(COMPACTION_CURSOR_NS, cursorKey); } catch { /* fresh walk */ }
  // MERGE-1 slice 1: resolve the transcript source ONCE per tick through the existing
  // read-switch, exactly as the routed transcript reads do. 'merged' (default) makes the
  // complete tier's lateral read crossmodel_messages — the drop-safe shape; 'legacy' keeps
  // today's coding_messages behaviour byte-for-byte.
  const sql = compactionSql(transcriptReadMode() === 'legacy' ? 'legacy' : 'merged');
  let cursor = 0n;
  try { if (stored?.nextId) cursor = BigInt(stored.nextId); } catch { cursor = 0n; }
  const startCursor = cursor;
  // Consecutive failed ticks on the range at the stored cursor (a range that keeps failing is passed over — never a stuck walk).
  const storedFailures = Math.max(0, Number(stored?.failures) || 0);
  let failures = storedFailures;
  let failed: string | null = null;
  try {
    let first = await firstRowAtOrAfter(cursor);
    if (!first) res.reachedFrontier = true; // nothing at / after the cursor
    while (first && res.ranges < maxRanges && res.skips < COMPACTION_MAX_SKIPS_PER_TICK && Date.now() - t0 < budgetMs) {
      if (first.createdAt >= frontier) { res.reachedFrontier = true; break; }
      const lo = first.id;
      const hi = lo + rangeIds;
      // The range's NEWEST row (ids are monotonic with time) decides: inside the frontier ⇒ wait until it has aged.
      const newest = (await lastRowBefore(hi)) ?? first;
      if (newest.createdAt >= frontier) { res.reachedFrontier = true; break; }
      if (res.fromId === null) res.fromId = lo.toString();
      if (newest.createdAt < expiresSoon) {
        res.skips++;
      } else {
        try {
          await compactRange(lo, hi, dry, agedBefore, res.tiers, sql);
          res.ranges++;
        } catch (err: any) {
          failed = err?.message ?? String(err);
          // The tick's FIRST range continues the stored streak; a later range starts a new one.
          failures = cursor === startCursor ? storedFailures + 1 : 1;
          if (failures < COMPACTION_MAX_RANGE_FAILURES) { cursor = lo; break; } // retry this range next tick
          logger.warn(`agent-events-compaction: passing over ids [${lo}, ${hi}) after ${failures} failed tick(s): ${failed}`);
        }
      }
      failures = 0; // the cursor moves past this range
      cursor = hi;
      first = await firstRowAtOrAfter(hi);
    }
  } catch (err: any) {
    failed = failed ?? (err?.message ?? String(err));
  }
  if (failed) logger.warn(`agent-events-compaction: tick stopped after ${res.ranges} range(s): ${failed}`);
  if (cursor !== startCursor || failures !== storedFailures) {
    try { await storePut(COMPACTION_CURSOR_NS, cursorKey, { nextId: cursor.toString(), failures, updatedAt: new Date().toISOString() }); } catch (err: any) {
      logger.warn(`agent-events-compaction: cursor persist failed (${err?.message ?? err}) — the next tick re-walks from ${startCursor}`);
    }
  }
  res.cursor = cursor.toString();
  for (const t of COMPACTION_TIERS) { res.rows += res.tiers[t].rows; res.bytes += res.tiers[t].bytes; }
  res.ms = Date.now() - t0;
  if (res.ranges > 0 || res.skips > 0) {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.AGENT_EVENTS_COMPACTION,
      value: res.rows,
      unit: 'rows',
      meta: { mode: res.mode, ranges: res.ranges, skips: res.skips, fromId: res.fromId, cursor: res.cursor, reachedFrontier: res.reachedFrontier, bytes: res.bytes, tiers: res.tiers, afterDays, rangeIds: Number(rangeIds), ms: res.ms },
    });
    logger.info(`agent-events-compaction: ${res.mode === 'dry_run' ? 'would touch' : 'touched'} ${res.rows} row(s) ≈ ${res.bytes} bytes in ${res.ranges} range(s)${res.skips ? ` (+${res.skips} skipped, expiring)` : ''} from id ${res.fromId} → cursor ${res.cursor} (${COMPACTION_TIERS.map((t) => `${t} ${res.tiers[t].rows}`).join(', ')}; ${res.ms} ms${res.reachedFrontier ? '; frontier reached' : ''})`);
  }
  return res;
}
