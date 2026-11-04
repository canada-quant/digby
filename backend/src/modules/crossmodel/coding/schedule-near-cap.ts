/**
 * Near-cap schedule alerting — PURE predicate + constants (ticket b4d1096c).
 *
 * This module is deliberately DEPENDENCY-FREE (no prisma/redis/env imports):
 * the predicate is the single semantics shared by the sweeper's emission AND
 * every read surface (get_chat_status schedules field, [FLEET LIVENESS],
 * [PROJECT SCHEDULES]), and those consumers live in modules whose import
 * graphs must not pull schedule.service's redis/env chain (the 2026-09-21
 * liveness-suite worker crashes: a static supervisor-state → schedule.service
 * edge loaded config/env at suite scope and called process.exit(1)).
 * schedule.service re-exports everything below, so existing import sites
 * (tests included) keep working.
 */

/** 30 days — the recurring-schedule lifetime ceiling (slides on every fire). */
export const MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Near-cap pre-emptive alert (ticket b4d1096c): a recurring schedule used to
 * die silently at its run cap — renewal was cancel+recreate and the ONLY
 * signal was the POST-death schedule_disabled hook (or the next fleet sweep).
 * The sweeper now emits ONE schedule_near_cap hook event per row when it
 * crosses ≥NEAR_CAP_FRACTION of maxRuns or enters the last
 * NEAR_EXPIRY_WINDOW_MS of its lifetime — BEFORE the gap opens.
 */
export const NEAR_CAP_FRACTION = 0.9;
/**
 * wake-cadence-4 (2026-09-27 tt-rd audit): a row that will NOT renew at its
 * cap (owner-authored, or renewOnExhaustion explicitly false) goes SILENT at
 * the cap, so its owner needs the warning earlier — 80 % instead of 90 %.
 * Renewing rows stay a non-event at 90 % (their successor arms itself).
 */
export const NEAR_CAP_FRACTION_NO_RENEW = 0.8;
/** Last 10% of the 30-day lifetime ceiling = 3 days. */
export const NEAR_EXPIRY_WINDOW_MS = MAX_LIFETIME_MS / 10;

export type ScheduleNearCapCause = 'run_cap' | 'expiry_window';

/**
 * The near-cap fraction for a row: 0.8 when the row is KNOWN not to renew
 * (renewOnExhaustion false, or NULL on a non-machine/system author — the same
 * derivation maybeRenewOnExhaustion uses), else 0.9. A row whose authorship
 * is not selected at all (promptSetBy undefined) keeps the classic 0.9 so a
 * read surface that omits the column never renders a different verdict from
 * one that carries it. Pure.
 */
export function nearCapFractionFor(s: { promptSetBy?: string | null; renewOnExhaustion?: boolean | null }): number {
  if (s.renewOnExhaustion === true) return NEAR_CAP_FRACTION;
  if (s.renewOnExhaustion === false) return NEAR_CAP_FRACTION_NO_RENEW;
  if (s.promptSetBy === undefined) return NEAR_CAP_FRACTION;
  return s.promptSetBy === 'machine' || s.promptSetBy === 'system' ? NEAR_CAP_FRACTION : NEAR_CAP_FRACTION_NO_RENEW;
}

/**
 * Run count at which a capped recurring schedule is NEAR its cap (≥90% burned;
 * ≥80% for a row that will not renew — see nearCapFractionFor).
 * NULL when the cap is too small for a meaningful pre-warning — when
 * ceil(fraction·maxRuns) == maxRuns the final run IS the cap, and the max_runs
 * disable + renewOnExhaustion notice already carries that signal.
 */
export function nearCapRunThreshold(maxRuns: number | null | undefined, fraction: number = NEAR_CAP_FRACTION): number | null {
  if (maxRuns == null || !Number.isFinite(maxRuns)) return null;
  const t = Math.ceil(maxRuns * fraction);
  return t >= 1 && t < maxRuns ? t : null;
}

/**
 * Pure near-cap predicate — the SINGLE semantics shared by the sweeper's
 * emission and every read surface, so a row never renders near-cap in a
 * surface without having alerted (or vice versa). 'run_cap' wins when both
 * legs trip. An at-cap row returns null — it is handled by the max_runs
 * disable path, not the warning.
 */
export function scheduleNearCapCause(
  s: { kind: string; runsCount: number; maxRuns: number | null; expiresAt: Date | null; promptSetBy?: string | null; renewOnExhaustion?: boolean | null },
  now: Date,
): ScheduleNearCapCause | null {
  if (s.kind !== 'recurring') return null;
  // wake-cadence-4: the fraction follows the row's renewal derivation — a row
  // that will not renew alerts at 80 %; callers that select promptSetBy /
  // renewOnExhaustion (the sweeper, [PROJECT SCHEDULES]) get the early
  // warning, callers that do not keep the classic 90 % verdict.
  const t = nearCapRunThreshold(s.maxRuns, nearCapFractionFor(s as { promptSetBy?: string | null; renewOnExhaustion?: boolean | null }));
  if (t != null && s.maxRuns != null && s.runsCount >= t && s.runsCount < s.maxRuns) return 'run_cap';
  if (s.expiresAt) {
    const remainingMs = s.expiresAt.getTime() - now.getTime();
    if (remainingMs > 0 && remainingMs < NEAR_EXPIRY_WINDOW_MS) return 'expiry_window';
  }
  return null;
}
