/**
 * Schedule priority slot — the sweep must not starve behind hook wakes
 * (autonomy loop #4, 2026-09-19; direct fire loop #10, 2026-09-20).
 *
 * THE STARVATION: a run's finalize immediately drains the chat's queued
 * messages and pending hook events into the next run, so a busy supervisor
 * chat is never idle at the moment its 30 s schedule sweeper looks — the
 * recurring SWEEP (the periodic full review: board, telemetry, collaboration
 * watch, verify-before-done) is skipped "busy" and re-armed +3 min, forever.
 * Live 2026-09-19 08:07Z: the Fleet Supervisor's 2 h sweep at busySkips 98
 * (~5 h without a full sweep) while it answered 18 reactive hook wakes; a
 * 15-min lane schedule at 43.
 *
 * THE RULE: when a chat's run finalizes and one of its ENABLED recurring
 * schedules has been busy-skipped ≥ SCHEDULE_PRIORITY_SKIPS times, the
 * finalize drain YIELDS once — it leaves the queue/hook backlog alone, pulls
 * that schedule's nextRunAt to now and FIRES IT DIRECTLY through the sweep's
 * own row pass (schedule.service fireDueScheduleNow: same atomic claim, caps,
 * delta gate and bookkeeping). The sweep's own finalize then drains the
 * backlog as usual. Nothing is dropped or refused; the wake order changes
 * once per starvation streak.
 *
 * WHY DIRECT (loop #10): the #4 version only pulled nextRunAt forward and
 * waited for the sweeper's next tick (≤ 30 s). Live 2026-09-20 the Fleet
 * Supervisor's sweep got four priority slots in 7 h and fired in ONE — the
 * other three slots went to `origin: agent` coalesced-message wakes that found
 * the idle chat first (busySkips 50, last real sweep 3.5 h old). Firing inside
 * the finalize closes that window. When the direct fire reports the schedule
 * will NOT run now (cap skip, dormancy park, expiry, error) the finalize does
 * not yield — the drain proceeds as before the feature existed.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';

export const SCHEDULE_PRIORITY_SKIPS = 10;

/** The direct fire's report — mirrors schedule.service FireNowOutcome without a static import (that module dynamically imports chat-agent, which imports this). */
export interface FiredOutcome { outcome: string; reason?: string; message?: string }

export interface StarvedSchedule { id: string; busySkips: number; intervalSec: number | null; fired: string }

/**
 * Does the finalize still YIELD its drain after the direct fire reported
 * `fired`? Yes when a schedule run for this chat is starting or about to:
 * started; another sweeper claimed the row first (lost_claim / not_due — it
 * fires it); this process is retiring (the new colour's sweeper fires it
 * within a tick); the chat was already busy (someone else took the slot — that
 * run's finalize drains). No fire at all (module unavailable)
 * keeps the pre-#10 behaviour: yield and let the sweeper fire. Everything
 * else means the schedule will NOT run now — drain as if nothing were starved.
 */
export function slotYields(fired: FiredOutcome | null): boolean {
  if (!fired) return true;
  switch (fired.outcome) {
    case 'started': case 'lost_claim': case 'not_due': case 'retiring': return true;
    case 'skipped': return fired.reason === 'busy';
    default: return false;
  }
}

/**
 * Find the chat's most-starved enabled recurring schedule (busySkips ≥ the
 * threshold), pull its nextRunAt to `now`, fire it directly, log one line
 * and return it when the finalize should yield its drain. Null when nothing
 * is starved or the schedule cannot fire now. Never
 * throws — a lookup failure yields null.
 */
export async function claimStarvedScheduleSlot(chatId: string, now: Date = new Date()): Promise<StarvedSchedule | null> {
  if (!chatId) return null;
  try {
    const row = await prisma.chatSchedule.findFirst({
      where: { sessionId: chatId, enabled: true, kind: 'recurring', busySkips: { gte: SCHEDULE_PRIORITY_SKIPS } },
      orderBy: { busySkips: 'desc' },
      select: { id: true, busySkips: true, intervalSec: true, nextRunAt: true },
    });
    if (!row) return null;
    if (row.nextRunAt.getTime() > now.getTime()) {
      await prisma.chatSchedule.update({ where: { id: row.id }, data: { nextRunAt: now } });
    }
    let fired: FiredOutcome | null = null;
    try {
      const sched: any = await import('./schedule.service');
      if (typeof sched?.fireDueScheduleNow === 'function') fired = await sched.fireDueScheduleNow(row.id);
    } catch (err: any) {
      logger.warn(`schedule-priority: direct fire of ${row.id.slice(0, 8)} failed (drain proceeds; the sweeper keeps the pulled-forward row): ${err?.message ?? err}`);
      fired = { outcome: 'error', message: String(err?.message ?? err).slice(0, 120) };
    }
    const yields = slotYields(fired);
    const firedLabel = fired ? `${fired.outcome}${fired.reason ? `:${fired.reason}` : ''}` : 'deferred';
    logger.info(`schedule-priority: chat ${chatId.slice(0, 8)} — schedule ${row.id.slice(0, 8)} starved ${row.busySkips} busy-skips, pulled to now, direct fire ${firedLabel}; finalize drain ${yields ? 'YIELDS' : 'proceeds'}`);
    return yields ? { id: row.id, busySkips: row.busySkips, intervalSec: row.intervalSec, fired: fired?.outcome ?? 'deferred' } : null;
  } catch (err: any) {
    logger.warn(`schedule-priority: lookup failed for ${chatId.slice(0, 8)} (drain proceeds): ${err?.message ?? err}`);
    return null;
  }
}
