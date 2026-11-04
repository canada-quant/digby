/**
 * memory-embed-backfill — the repair cron for NULL-embedding memory rows
 * (ticket d7bf73c2, 2026-10-17).
 *
 * A DashScope 429 used to drop a whole memStore batch to keyword-only with no
 * retry and no repair (Box C, 2026-10-16: "0/7 row(s) stored keyword-only —
 * http_4xx … Too many requests … throttled"). The 429-aware backoff in
 * embed-failure.ts now recovers most throttled batches in-call; this cron is
 * the safety net for the rows that still land `embedding IS NULL` (throttle
 * window outlived the in-call budget, transient 5xx, a provider blip): every
 * 15 minutes it re-embeds the oldest NULL rows and writes their vectors in
 * place, guarded by `AND embedding IS NULL` so it can never overwrite a
 * fresher vector.
 *
 * Bounded by design: ≤ MEMORY_EMBED_BACKFILL_BATCH_SIZE rows per tick (default
 * 50), one embed call per row, rows older than MEMORY_EMBED_BACKFILL_MAX_AGE_DAYS
 * (default 7) are left keyword-only forever (a chunk older than that is past
 * the 14d age-decay floor anyway), rows younger than 10 minutes are skipped so
 * the cron never races a store still inside its in-call 429 backoff, and a row
 * the provider REJECTS (400/413/422 — a permanently poison input) goes on a
 * short in-process cooldown instead of burning a call every tick.
 *
 * DB-only (Postgres + the embed API) — claimable on every worker, NOT
 * volume-bound. Kill switch MEMORY_EMBED_BACKFILL_DISABLED=1. Never throws;
 * returns a ≤200-char pass summary for cron_jobs.lastStatus (the
 * session-history-sync pattern).
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { embedTexts, embedTextsForSpec, authoritativeEmbedTargetSpec, embeddingsBackendConfigured } from '../rag.service';
import { describeEmbedFailure, embedFailureRetryable, embedFailureRateLimited, type EmbedAbort } from './embed-failure';

export const SOURCE = 'memory-embed-backfill';
export const MEMORY_EMBED_BACKFILL_DISABLED_ENV = 'MEMORY_EMBED_BACKFILL_DISABLED';

export const BACKFILL_BATCH_SIZE_DEFAULT = 50;
/** Max age of a NULL row the cron will repair (2026-11-01 transport incident).
 *
 *  This was 7 days, and the 7-day window is why the repair never converged: the
 *  incident left 12,456 keyword-only rows whose OLDEST is 2026-07-29 (~95 days),
 *  so every row older than a week was permanently out of reach — the cron
 *  reported a clean tick while ~10% of the corpus stayed unembedded.
 *
 *  MEASURED 2026-11-01 (prod, digby_memory): NULL 12,456 / total 702,688, by age
 *  <1d 6,465 · <7d 4,942 · older 966 (of which the oldest is 95 days).
 *  BACKFILL_MAX_AGE_DAYS env still overrides; 120 days covers the whole tail. */
export const BACKFILL_MAX_AGE_DAYS_DEFAULT = 120;
/** A row younger than this may still be inside its store's in-call 429 backoff. */
export const BACKFILL_MIN_AGE_MINUTES_DEFAULT = 10;
/** A provider-REJECTED row waits this long before its next backfill attempt. */
export const BACKFILL_REJECT_COOLDOWN_MS_DEFAULT = 60 * 60 * 1000;

export function backfillDisabled(envSource: NodeJS.ProcessEnv = process.env): boolean {
  return envSource[MEMORY_EMBED_BACKFILL_DISABLED_ENV] === '1';
}

export function backfillBatchSize(envSource: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(envSource.MEMORY_EMBED_BACKFILL_BATCH_SIZE || '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : BACKFILL_BATCH_SIZE_DEFAULT;
}

export function backfillMaxAgeDays(envSource: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(envSource.MEMORY_EMBED_BACKFILL_MAX_AGE_DAYS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : BACKFILL_MAX_AGE_DAYS_DEFAULT;
}

/** Per-row embed timeout.
 *
 *  BOUNDED BATCH (2026-11-01): a single-row embed answers in ~0.3–1.5 s, so the
 *  old 15 s was ~10× the real cost and it made the batch unbounded in practice —
 *  when /embeddings HANGS (the incident: no response at 90 s), 50 rows × 15 s =
 *  12.5 min, longer than the 8-min tick deadline, so the tick died before
 *  finishing its batch and the repaired-rows-per-hour rate collapsed. At 8 s
 *  50 rows worst case = 400 s < the tick deadline, so a full batch always lands
 *  inside its own tick. Matches EMBED_ROW_RETRY_TIMEOUT_MS (unified-memory). */
export const BACKFILL_EMBED_TIMEOUT_MS = 8_000;
/** The tick's own deadline (round-1 F2, adversarial review 2bae74f9): the cron
 *  lease is CRON_LEASE_MS = 10 min, and worst case (env cap 200 rows × 15 s
 *  embed timeout) is 50 min — a tick that outlives its lease hands the job to
 *  a second worker mid-pass. The rows stay correct either way (the UPDATE is
 *  guarded by AND embedding IS NULL), so this is duplicate provider load, not
 *  corruption — but the load lands exactly when the provider is down. The
 *  deadline stops the row loop at 8 min: unfinished rows simply ride the next
 *  tick (15 min later), which is the cron's own repair cadence. */
export const BACKFILL_TICK_DEADLINE_MS = 8 * 60 * 1000;

interface BackfillRow {
  id: string;
  title: string | null;
  content: string;
  createdAt: Date;
}

export interface BackfillResult {
  scanned: number;
  embedded: number;
  failed: number;
  cooldown: number;
  oldestHours: number | null;
  summary: string;
}

/** In-process cooldown for provider-REJECTED rows (id → retry-not-before).
 *  Process-local by design: it only keeps ONE tick from re-burning a call on a
 *  row the provider just rejected; a restart clears it, and the max-age window
 *  is the hard bound. */
const rejectCooldown = new Map<string, number>();

export function __resetBackfillCooldownForTests(): void {
  rejectCooldown.clear();
}

/** One bounded backfill pass. Never throws. `tickDeadlineMs` is injectable for
 *  tests (production default BACKFILL_TICK_DEADLINE_MS). */
export async function runMemoryEmbedBackfillOnce(opts?: { now?: Date; tickDeadlineMs?: number }): Promise<string> {
  const now = opts?.now ?? new Date();
  if (backfillDisabled()) return 'disabled (MEMORY_EMBED_BACKFILL_DISABLED=1)';
  // Self-host gate (2026-10-26): with no embeddings backend on this instance
  // (no embeddings seat override, no DASHSCOPE_API_KEY) every row fails and
  // the tick burns its full budget producing only error-log noise every 15
  // minutes. Check the CONFIG (pure — same resolution embedTexts uses, no
  // network) and idle quietly when nothing is configured (the news
  // scheduler's webSearchMissingOnInstance posture). Rows stay keyword-only
  // and the cron self-heals the moment an admin assigns the seat.
  if (!(await embeddingsBackendConfigured())) {
    return 'idle (no embeddings backend configured on this instance)';
  }
  const limit = backfillBatchSize();
  const maxAgeDays = backfillMaxAgeDays();
  const minAgeCutoff = new Date(now.getTime() - BACKFILL_MIN_AGE_MINUTES_DEFAULT * 60 * 1000);
  const maxAgeCutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
  const tickStartMs = Date.now();
  const tickDeadlineMs = opts?.tickDeadlineMs ?? BACKFILL_TICK_DEADLINE_MS;
  // Prune expired cooldown entries (round-2 follow-up 5): the map is set-only
  // with lazy expiry, so entries never leave; bounded in practice by incident
  // volume, but this keeps it airtight at zero cost.
  if (rejectCooldown.size) {
    for (const [id, at] of rejectCooldown) if (at <= now.getTime()) rejectCooldown.delete(id);
  }
  let rows: BackfillRow[] = [];
  try {
    rows = await prisma.$queryRawUnsafe<BackfillRow[]>(
      `SELECT id, title, content, created_at AS "createdAt" FROM digby_memory
        WHERE embedding IS NULL AND created_at >= $1 AND created_at <= $2
        ORDER BY created_at ASC LIMIT $3`,
      maxAgeCutoff, minAgeCutoff, limit,
    );
  } catch (err: any) {
    // Table absent (a fresh DB before any memStore) or a transient DB fault —
    // quiet: the next tick retries.
    logger.debug(`${SOURCE}: NULL-row scan skipped (non-fatal): ${err?.message ?? err}`);
    return 'scan skipped (table absent or db fault)';
  }
  // Drop rows still on the reject cooldown (bounded memory: only ids seen).
  const eligible = rows.filter(r => !rejectCooldown.has(r.id) || rejectCooldown.get(r.id)! <= now.getTime());
  const cooled = rows.length - eligible.length;
  let embedded = 0;
  let failed = 0;
  let deadlineStopped = 0;
  // Attribution of the LAST failed row this tick (goal 4e432dff). The summary
  // row carries it so the cron's own failures are dateable to a leg/side
  // instead of only being a number in `failed`.
  let lastFailureAbort: EmbedAbort | null = null;
  let lastFailureLeg: string | null = null;
  for (const r of eligible) {
    // Tick deadline (round-1 F2): stop before the cron lease (10 min) lapses;
    // the remaining rows ride the next tick. Measured as REAL elapsed time
    // from tick start (not the injected `now`, which tests pin for the SQL
    // cutoffs) — a production tick lives on the wall clock.
    if (Date.now() - tickStartMs > tickDeadlineMs) { deadlineStopped++; continue; }
    // Mirror memStore: the title is embedded WITH the content (the distilled
    // one-liner carries the searchable vocabulary).
    const text = r.title ? `${r.title}\n${r.content}` : r.content;
    try {
      // PINNED target, not the seat (2026-11-01): the repair must write into
      // the space the corpus lives in, and it must keep working while the
      // embeddings SEAT is the thing that is broken. embedTexts() follows the
      // seat, so during the incident every repair row burned its timeout on
      // the hanging route and the cron could never converge.
      const [vec] = await embedTextsForSpec(await authoritativeEmbedTargetSpec(), [text], { timeoutMs: BACKFILL_EMBED_TIMEOUT_MS, bucket: 'backfill' });
      if (!Array.isArray(vec) || !vec.length) throw new Error('provider returned no vector');
      const updated = await prisma.$executeRawUnsafe(
        `UPDATE digby_memory SET embedding = $2::vector WHERE id = $1 AND embedding IS NULL`,
        r.id, `[${vec.join(',')}]`,
      );
      if (updated > 0) { embedded++; continue; }
      // Zero rows updated: another writer filled it first — that is a success.
      embedded++;
    } catch (err: any) {
      failed++;
      const cause = describeEmbedFailure(err);
      lastFailureAbort = cause.abort;
      lastFailureLeg = cause.leg;
      if (embedFailureRateLimited(cause)) {
        // The provider is THROTTLING (round-2 follow-up 4): per-row calls
        // inside a throttle window all 429 — burning the rest of the batch
        // only feeds the throttle we are here to repair. Stop the row loop;
        // every remaining row retries on the next tick (15 min), same
        // reasoning as the in-call backoff in embed-failure.ts.
        deadlineStopped += eligible.length - (embedded + failed + cooled);
        logger.debug(`${SOURCE}: provider throttling (429) — tick stopped after ${embedded} embedded / ${failed} failed; remaining rows ride the next tick`);
        break;
      }
      if (embedFailureRetryable(cause)) {
        // A provider REJECTION is (almost certainly) permanent for this input —
        // cool the row down instead of re-burning a call every tick.
        rejectCooldown.set(r.id, now.getTime() + BACKFILL_REJECT_COOLDOWN_MS_DEFAULT);
      }
      logger.debug(`${SOURCE}: row ${r.id} re-embed failed (non-fatal): ${cause.kind}${cause.status !== null ? ` HTTP ${cause.status}` : ''} (${cause.message})`);
    }
  }
  const oldestHours = rows.length
    ? Math.round(((now.getTime() - new Date(rows[0].createdAt).getTime()) / 3_600_000) * 10) / 10
    : null;
  // COUNT FROM THE DATABASE, never from the logs (2026-11-01): the emit is a
  // once-per-process warn, so app_error_logs understates the real loss. This is
  // the honest backlog number — how many rows are still keyword-only — and it
  // is what tells an operator whether the repair is converging.
  let remainingNull: number | null = null;
  let totalRows: number | null = null;
  try {
    const counts = await prisma.$queryRawUnsafe<Array<{ nulls: bigint | number; total: bigint | number }>>(
      `SELECT count(*) FILTER (WHERE embedding IS NULL) AS nulls, count(*) AS total FROM digby_memory`,
    );
    const c = counts?.[0];
    if (c) {
      remainingNull = Number(c.nulls);
      totalRows = Number(c.total);
    }
  } catch { /* count is diagnostic — never fail the tick for it */ }
  const summary = `${SOURCE}: scanned ${rows.length} embedded ${embedded} failed ${failed} cooldown ${cooled}${deadlineStopped ? ` stopped ${deadlineStopped}` : ''}${oldestHours !== null ? ` oldest ${oldestHours}h` : ''}${remainingNull !== null ? ` remaining ${remainingNull}` : ''}`.slice(0, 200);
  logger.info(summary);
  void import('../platform/loop-metrics.service')
    .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MEMORY_EMBED_BACKFILL,
      value: embedded,
      unit: 'rows',
      // Numeric counters LEAD the meta: the fleet metrics view truncates at 240
      // chars (d2a1fa00) and the counters are what the operator charts.
      meta: {
        // BUCKET + LEG on the repair tick (goal 4e432dff). The backfill used to
        // emit counts ONLY, so a cron that failed N rows said so without ever
        // writing a row that could be attributed — the failure lived in the
        // `failed` counter, not in the failure population an operator reads.
        // This row is the cron's own ATTEMPT attribution, and it carries the
        // same two keys the 24 h unattributed probe reads, so the repair flow
        // is inside the KPI by construction rather than out of sight.
        bucket: 'backfill', abort: lastFailureAbort, leg: lastFailureLeg,
        scanned: rows.length, embedded, failed, cooldown: cooled, stopped: deadlineStopped, limit, maxAgeDays, oldestHours, remainingNull, totalRows,
      },
    }))
    .catch(() => undefined);
  return summary;
}
