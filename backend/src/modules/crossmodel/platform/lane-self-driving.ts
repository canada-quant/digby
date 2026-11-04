/**
 * Is a lane DRIVING ITSELF? (supervisor SOTA 2026-10-20 — SUP-WAKE-TIERS (2)
 * and ALARM-CAUSE-AWARE (3)).
 *
 * One bounded read over a set of lane chat ids answering, per lane:
 *   liveRun        a queued / running agent_runs row
 *   armedSoon      an enabled schedule whose nextRunAt ≤ now + horizon
 *                  (horizon null = any enabled schedule)
 *
 * A lane is self-driving when something will actually RUN it: a live run or a
 * schedule armed soon. An assigned todo never counts on its own (review fix
 * 2026-10-20): a todo does not make an idle lane run — in_progress work with no
 * live run and no armed schedule is exactly the ledger's STALL shape
 * (supervisor-wake-ledger stalledLanes), and a lane that cancels its last
 * schedule while holding one is DEAF (the 2026-08-24 TT-RD / 2026-08-30
 * Post-CPT incidents). A pending todo the T7-10 next-todo continuation picks
 * up (coding/lane-todos maybeStartNextLaneTodo) shows as a queued run once its
 * wake lands; until then the supervisor wake delivers.
 *
 * The material gate skips a PROGRESS-tier supervisor wake only when EVERY
 * source lane is self-driving (supervisor-wake-ledger evaluate); more than
 * SELF_DRIVING_MAX_LANES source lanes is never "every lane" (the read would
 * truncate — the caller delivers). schedule_disabled reads the same facts
 * (without the lane's own running run) to decide whether a lane's self-stop
 * still leaves it driven (coding/schedule.service emitScheduleDisabled).
 *
 * Reads THROW on a DB error (no per-section catch): an unreadable section must
 * never read as "no work" for one fact and "work" for another — the callers
 * catch and fail toward DELIVERY / ALARM.
 */

import prisma from '../../../config/database';

/** A schedule armed this soon counts as the lane driving itself (SUP-WAKE-TIERS design: 30 min). */
export const SELF_DRIVING_ARMED_HORIZON_MS = 30 * 60_000;
/** The most lanes one read covers; a larger set is never judged "every lane self-driving". */
export const SELF_DRIVING_MAX_LANES = 50;
const MAX_ROWS = 500;

export interface LaneDriveFacts { chatId: string; liveRun: boolean; armedSoon: boolean }

/** Pure: one lane's verdict — a live run or a schedule armed soon (an assigned todo alone never drives a lane). */
export function isLaneSelfDriving(f: Pick<LaneDriveFacts, 'liveRun' | 'armedSoon'>): boolean {
  return f.liveRun === true || f.armedSoon === true;
}

/** Pure: the distinct non-empty lane ids, first-seen order. */
export function dedupeLaneIds(laneIds: readonly string[]): string[] {
  return [...new Set(laneIds.filter((x) => typeof x === 'string' && x))];
}

/**
 * Pure: every lane's facts from the row sets. `countRunning:false` ignores
 * RUNNING rows (a lane's own run that is emitting the event is not "further"
 * work); queued rows always count.
 */
export function laneDriveFactsFromRows(
  laneIds: readonly string[],
  rows: {
    runs: ReadonlyArray<{ sessionId: string; status: string }>;
    schedules: ReadonlyArray<{ sessionId: string }>;
  },
  opts: { countRunning?: boolean } = {},
): LaneDriveFacts[] {
  const countRunning = opts.countRunning !== false;
  return laneIds.map((chatId) => ({
    chatId,
    liveRun: rows.runs.some((r) => r.sessionId === chatId && (r.status === 'queued' || (countRunning && r.status === 'running'))),
    armedSoon: rows.schedules.some((s) => s.sessionId === chatId),
  }));
}

/**
 * Read the facts for `laneIds` (deduped, ≤ SELF_DRIVING_MAX_LANES — callers
 * that must judge EVERY lane use allLanesSelfDriving, which refuses a larger
 * set). Throws on any DB error. `horizonMs` null ⇒ any enabled schedule counts
 * as armed.
 */
export async function readLaneDriveFacts(
  laneIds: readonly string[],
  now: Date = new Date(),
  opts: { horizonMs?: number | null; countRunning?: boolean } = {},
): Promise<LaneDriveFacts[]> {
  const ids = dedupeLaneIds(laneIds).slice(0, SELF_DRIVING_MAX_LANES);
  if (!ids.length) return [];
  const horizonMs = opts.horizonMs === undefined ? SELF_DRIVING_ARMED_HORIZON_MS : opts.horizonMs;
  const [runs, schedules] = await Promise.all([
    prisma.agentRun.findMany({ where: { sessionId: { in: ids }, status: { in: ['queued', 'running'] } }, select: { sessionId: true, status: true }, take: MAX_ROWS }),
    prisma.codingSchedule.findMany({
      where: { sessionId: { in: ids }, enabled: true, ...(horizonMs === null ? {} : { nextRunAt: { lte: new Date(now.getTime() + horizonMs) } }) },
      select: { sessionId: true },
      take: MAX_ROWS,
    }),
  ]);
  return laneDriveFactsFromRows(ids, { runs, schedules }, { countRunning: opts.countRunning });
}

/**
 * Every lane in `laneIds` is self-driving (false for an empty set — nothing
 * proves the work moves on its own). More than SELF_DRIVING_MAX_LANES distinct
 * lanes reads NOTHING and answers false with `truncated:true`: the lanes past
 * the bound would go unchecked, and an unchecked lane is never "driving
 * itself" (fail toward delivery). Throws on a DB error.
 */
export async function allLanesSelfDriving(laneIds: readonly string[], now: Date = new Date()): Promise<{ selfDriving: boolean; lanes: LaneDriveFacts[]; truncated?: boolean }> {
  if (dedupeLaneIds(laneIds).length > SELF_DRIVING_MAX_LANES) return { selfDriving: false, lanes: [], truncated: true };
  const lanes = await readLaneDriveFacts(laneIds, now);
  return { selfDriving: lanes.length > 0 && lanes.every(isLaneSelfDriving), lanes };
}
