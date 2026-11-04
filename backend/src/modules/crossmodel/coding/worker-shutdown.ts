/**
 * Worker shutdown flush (audit 2026-10-08 W3-1 — plumbing F1, lanes).
 *
 * The coding worker's SIGTERM path was `drain()` → `prisma.$disconnect()` →
 * `process.exit(0)`. `drain()` returns the moment the last active run's
 * executeClaimedRun resolves — but that run's finalize starts its follow-up
 * work fire-and-forget (the run_completed / run_failed hook emit, the
 * coding-memory fold, the project-decision extraction, the run journal) and its
 * run_spend / run_tokens rows sit in the loop-metrics buffer (flushed on an
 * unref'd 2 s timer). The exit killed all of it: 15 runs in 48 h with no spend
 * rows ($188 missing from API costs and spend_daily_rollups), no memory fold,
 * and — run 887e8789 on lane 7bd45d57 — no run_completed wake for the parent.
 *
 * finishWorkerShutdown runs AFTER drain()/stop() and BEFORE $disconnect:
 *   1. a short settle (WORKER_SHUTDOWN_SETTLE_MS, default 2 s) for untracked
 *      fire-and-forget writes the finalize started just before resolving;
 *   2. awaits every tracked background task (utils/background-tasks), bounded
 *      by WORKER_SHUTDOWN_BACKGROUND_MAX_MS (default 60 s);
 *   3. records ONE `worker_shutdown_flush` loop_metrics row and drains the
 *      loop-metrics buffer + in-flight batches (bounded 10 s).
 * Never throws. Kill switch WORKER_SHUTDOWN_FLUSH_DISABLED=1 restores the
 * immediate disconnect (nothing awaited, nothing flushed).
 */
import logger from '../../../utils/logger';
import { awaitBackgroundTasks, pendingBackgroundCount } from '../../../utils/background-tasks';
import { recordLoopMetric, drainLoopMetrics } from '../platform/loop-metrics.service';

export const WORKER_SHUTDOWN_FLUSH_KIND = 'worker_shutdown_flush';
export const WORKER_SHUTDOWN_BACKGROUND_MAX_MS_DEFAULT = 60_000;
export const WORKER_SHUTDOWN_SETTLE_MS_DEFAULT = 2_000;
export const WORKER_SHUTDOWN_METRICS_MAX_MS = 10_000;

export function workerShutdownFlushDisabled(): boolean {
  const v = String(process.env.WORKER_SHUTDOWN_FLUSH_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export interface WorkerShutdownFlushResult {
  skipped: boolean;
  background: { initial: number; remaining: number; timedOut: boolean; ms: number; remainingLabels: string[] } | null;
  metrics: { buffered: number; inflight: number; timedOut: boolean } | null;
}

/**
 * Await the finished runs' follow-up work + flush telemetry before the worker
 * disconnects. `opts` override the env bounds (tests pass settleMs 0).
 */
export async function finishWorkerShutdown(opts?: {
  workerId?: string;
  signal?: string;
  mode?: 'drain' | 'stop';
  settleMs?: number;
  backgroundMaxMs?: number;
  metricsMaxMs?: number;
}): Promise<WorkerShutdownFlushResult> {
  if (workerShutdownFlushDisabled()) return { skipped: true, background: null, metrics: null };
  const t0 = Date.now();
  try {
    const settleMs = opts?.settleMs ?? envMs('WORKER_SHUTDOWN_SETTLE_MS', WORKER_SHUTDOWN_SETTLE_MS_DEFAULT);
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    const backgroundMaxMs = opts?.backgroundMaxMs ?? envMs('WORKER_SHUTDOWN_BACKGROUND_MAX_MS', WORKER_SHUTDOWN_BACKGROUND_MAX_MS_DEFAULT);
    const pendingAtStart = pendingBackgroundCount();
    const background = await awaitBackgroundTasks(backgroundMaxMs);
    if (background.timedOut) {
      logger.warn(`worker shutdown: ${background.remaining} background task(s) still running after ${backgroundMaxMs}ms (${background.remainingLabels.join(', ')}) — disconnecting anyway`);
    }
    // The decision row is recorded BEFORE the final drain so it lands in it.
    recordLoopMetric({
      kind: WORKER_SHUTDOWN_FLUSH_KIND,
      value: Date.now() - t0,
      unit: 'ms',
      meta: {
        workerId: opts?.workerId ?? null,
        signal: opts?.signal ?? null,
        mode: opts?.mode ?? null,
        backgroundInitial: Math.max(pendingAtStart, background.initial),
        backgroundRemaining: background.remaining,
        backgroundTimedOut: background.timedOut,
        ...(background.remainingLabels.length ? { remainingLabels: background.remainingLabels } : {}),
      },
    });
    const metrics = await drainLoopMetrics(opts?.metricsMaxMs ?? WORKER_SHUTDOWN_METRICS_MAX_MS);
    logger.info(`worker shutdown: awaited ${background.initial} background task(s) (${background.remaining} left${background.timedOut ? ', timed out' : ''}), flushed ${metrics.buffered} buffered metric row(s) in ${Date.now() - t0}ms`);
    return { skipped: false, background, metrics };
  } catch (err: any) {
    logger.warn(`worker shutdown flush failed (non-fatal): ${err?.message ?? err}`);
    return { skipped: false, background: null, metrics: null };
  }
}
