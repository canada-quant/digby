/**
 * finish_run stage 2 — the act decision per seat (build 2026-10-11 FA-4; design: the 2026-10-08 finish-run
 * deep dive §5 stage 2 — "miss the bar on a seat → keep that seat in shadow").
 *
 * FINISH_RUN_ACT (finish-run.ts finishRunActMode): off | seats | on (unset = on, owner 2026-10-11). Only
 * `seats` needs data: a seat acts when ITS 7-day finish_run valid rate — rows `kind='finish_run'` with
 * meta.seat = the seat, valid = meta.valid (the run reached a valid finish within one nudge; an auto-finish
 * counts as a miss) — is ≥ FINISH_RUN_ACT_SEAT_BAR over ≥ FINISH_RUN_ACT_SEAT_MIN_RUNS rows. One aggregate
 * query (the kind+createdAt index) per process per FINISH_RUN_ACT_STATS_TTL_MS; a slow / failed read is
 * fail-safe SHADOW (reason seat_stats_unavailable) — act never starts on a guess.
 *
 * prisma is imported lazily (self-audit-receipt-rule pattern) so the module stays cheap to import.
 */

import { finishRunActDecision, finishRunActMode, type FinishActDecision } from './finish-run';

/** Seat stats cache lifetime (≤ 1 h per the owner order). */
export const FINISH_RUN_ACT_STATS_TTL_MS = 60 * 60_000;
/** The aggregate read's bound — past it the decision is shadow (fail-safe). */
export const FINISH_RUN_ACT_STATS_TIMEOUT_MS = 1_500;
const WINDOW_MS = 7 * 24 * 60 * 60_000;

export type SeatStats = Map<string, { runs: number; valid: number }>;

let cache: { at: number; stats: SeatStats } | null = null;
let inflight: Promise<SeatStats | null> | null = null;

/** Test seam: drop the process cache. */
export function resetFinishRunActCache(): void { cache = null; inflight = null; }

async function readSeatStats(now: number): Promise<SeatStats> {
  const { default: prisma } = await import('../../../config/database');
  const since = new Date(now - WINDOW_MS);
  const rows = await (prisma as any).$queryRaw`
    SELECT meta->>'seat' AS seat, count(*) AS runs, count(*) FILTER (WHERE meta->>'valid' = 'true') AS valid
    FROM loop_metrics WHERE kind = 'finish_run' AND "createdAt" >= ${since} GROUP BY 1` as Array<{ seat: string | null; runs: unknown; valid: unknown }>;
  const stats: SeatStats = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.seat !== 'string' || !r.seat) continue;
    stats.set(r.seat, { runs: Number(r.runs) || 0, valid: Number(r.valid) || 0 });
  }
  return stats;
}

/** The per-seat 7-day stats, cached ≤ TTL per process; null when the read failed or timed out. Never throws. */
export async function finishRunSeatStats(now: number = Date.now()): Promise<SeatStats | null> {
  if (cache && now - cache.at < FINISH_RUN_ACT_STATS_TTL_MS) return cache.stats;
  if (!inflight) {
    inflight = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stats = await Promise.race([
          readSeatStats(now),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), FINISH_RUN_ACT_STATS_TIMEOUT_MS); }),
        ]);
        cache = { at: now, stats };
        return stats;
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
        inflight = null;
      }
    })();
  }
  return inflight;
}

/**
 * The act decision for one run's seat. off / on never touch the DB; seats reads the cached stats
 * (fail-safe shadow on any error). Never throws.
 */
export async function resolveFinishRunAct(seat: string, env: NodeJS.ProcessEnv = process.env): Promise<FinishActDecision> {
  const mode = finishRunActMode(env);
  if (mode !== 'seats') return finishRunActDecision(mode);
  try {
    const stats = await finishRunSeatStats();
    if (!stats) return finishRunActDecision(mode, null, false);
    return finishRunActDecision(mode, stats.get(String(seat ?? '')) ?? null, true);
  } catch {
    return finishRunActDecision(mode, null, false);
  }
}
