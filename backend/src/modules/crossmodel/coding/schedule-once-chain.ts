/**
 * One-shot schedule CHAINS (finding B1, 2026-09-27 — bench lane 66f0b0c9).
 *
 * A firing's run that arms a fresh `once` row on its OWN chat is a CHAIN LINK.
 * Every recurring control — the duplicate-backstop guard (per kind), the
 * dormancy gate and renew accounting (recurring-only), the cap-cadence guard
 * (projects nothing for maxRuns 1), queue-behind-busy (one-shots ride the
 * queue instead of the busy-skip accounting) — is bypassed by a lane that
 * re-arms a one-shot from every firing: bench 66f0b0c9 armed 29 one-shots in
 * 26 h (35 identical SSM probes, $3.03/run, every row "GRID-GATED :3001
 * REDEPLOY RESUME") and no control ever saw a cadence.
 *
 * This leaf makes the chain VISIBLE and classifies it: createSchedule stamps
 * `chainedFromScheduleId` (the firing's own schedule id, threaded through the
 * run's ToolContext.firedByScheduleId) on a machine `once` arm targeting the
 * run's own chat; the chain is walked back over a rolling 24 h window, and a
 * chain of ≥ ONCE_CHAIN_RECURRING_LINKS links is RECURRING-LIKE — the
 * recurring controls then apply to the link (cap-cadence math on the
 * OBSERVED cadence at arm time; fire-time dormancy park; busy re-arm +
 * busySkips accounting instead of queue-behind-busy). Pure helpers here;
 * the DB walk is one indexed findMany on the session's recent `once` rows.
 *
 * OBSERVE-ONLY on the two controls that would STOP a lane's own deferred
 * work (the gate-flip doctrine: a gate on a machine lane's own work is
 * telemetry + a note, never a refusal): the arm-time cap-cadence check on a
 * can-never-fit observed cadence lands as a ⚠️ CAP MATH warning, and the
 * fire-time dormancy check on a dormant project records `would_park_dormant`
 * and FIRES the link. The busy re-arm + busySkips accounting and the
 * recurring-twin dedupe are not stops and stay on.
 *
 * Every reader fails OPEN (a chain read error ⇒ not recurring-like).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';

/** Links (rows) inside the window at which a chain is governed as a recurring cadence. */
export const ONCE_CHAIN_RECURRING_LINKS = 3;
/** Rolling window over which chain links are counted. */
export const ONCE_CHAIN_WINDOW_MS = 24 * 3600 * 1000;
/** Hard bound on the in-memory walk (a chain longer than this is already recurring-like). */
export const ONCE_CHAIN_MAX_WALK = 200;

/** The minimal row shape the walk needs (a subset of coding_schedules). */
export interface OnceChainRow {
  id: string;
  chainedFromScheduleId: string | null;
  createdAt: Date | string;
  intervalSec: number | null;
}

export interface OnceChainVerdict {
  /** Links inside the window INCLUDING the link being evaluated (≥ 1 when a parent exists). */
  links: number;
  /** links ≥ ONCE_CHAIN_RECURRING_LINKS. */
  recurringLike: boolean;
  /** Observed seconds between consecutive link arms inside the window (null with < 2 links). */
  observedCadenceSec: number | null;
  /** Oldest link's id inside the window (the chain's visible root). */
  rootId: string | null;
}

const NO_CHAIN: OnceChainVerdict = { links: 0, recurringLike: false, observedCadenceSec: null, rootId: null };

/**
 * Pure chain walk: starting at `parentId`, follow chainedFromScheduleId
 * backwards through `rows` (the session's recent `once` rows), counting every
 * row whose createdAt falls inside the window. `linkCreatedAt` is the arm time
 * of the link being evaluated (the new row, or the due row itself at fire
 * time) — it counts as one link. Bounded; a cycle (hostile data) ends the walk.
 */
export function walkOnceChain(
  rows: readonly OnceChainRow[],
  parentId: string | null | undefined,
  linkCreatedAt: Date | number,
  now: Date | number = Date.now(),
): OnceChainVerdict {
  if (!parentId) return NO_CHAIN;
  const nowMs = typeof now === 'number' ? now : now.getTime();
  const since = nowMs - ONCE_CHAIN_WINDOW_MS;
  const byId = new Map<string, OnceChainRow>();
  for (const r of rows) byId.set(r.id, r);
  const armTimes: number[] = [];
  const linkMs = typeof linkCreatedAt === 'number' ? linkCreatedAt : linkCreatedAt.getTime();
  if (Number.isFinite(linkMs) && linkMs >= since) armTimes.push(linkMs);
  const seen = new Set<string>();
  let cursor: string | null | undefined = parentId;
  let rootId: string | null = null;
  let hops = 0;
  while (cursor && !seen.has(cursor) && hops < ONCE_CHAIN_MAX_WALK) {
    seen.add(cursor);
    hops += 1;
    const row = byId.get(cursor);
    if (!row) break; // parent older than the window (or another session) — the chain's visible tail ends here
    const t = new Date(row.createdAt).getTime();
    if (!Number.isFinite(t) || t < since) break;
    armTimes.push(t);
    rootId = row.id;
    cursor = row.chainedFromScheduleId;
  }
  const links = armTimes.length;
  if (links === 0) return NO_CHAIN;
  armTimes.sort((a, b) => a - b);
  const observedCadenceSec = links >= 2
    ? Math.max(1, Math.round((armTimes[armTimes.length - 1] - armTimes[0]) / 1000 / (links - 1)))
    : null;
  return {
    links,
    recurringLike: links >= ONCE_CHAIN_RECURRING_LINKS,
    observedCadenceSec,
    rootId,
  };
}

/**
 * The cadence the cap-cadence guard should project for a recurring-like
 * chain: a chain cannot arm faster than its requested delay, and its OBSERVED
 * cadence is what it actually does (a 15-min delay behind a 40-min run is a
 * ~55-min cadence, not a 96/day one) — the larger of the two.
 */
export function chainCadenceSec(requestedIntervalSec: number, verdict: OnceChainVerdict): number {
  const req = Math.max(1, Math.round(requestedIntervalSec));
  return verdict.observedCadenceSec ? Math.max(req, verdict.observedCadenceSec) : req;
}

/** The session's `once` rows created inside the window — the walk's input. Fail-open (empty). */
export async function loadOnceChainRows(sessionId: string, now: Date | number = Date.now()): Promise<OnceChainRow[]> {
  const nowMs = typeof now === 'number' ? now : now.getTime();
  try {
    const rows = await prisma.codingSchedule.findMany({
      where: { sessionId, kind: 'once', createdAt: { gte: new Date(nowMs - ONCE_CHAIN_WINDOW_MS) } },
      select: { id: true, chainedFromScheduleId: true, createdAt: true, intervalSec: true },
      take: ONCE_CHAIN_MAX_WALK,
      orderBy: { createdAt: 'desc' },
    });
    return rows as OnceChainRow[];
  } catch (err: any) {
    logger.warn(`schedule once-chain: rows read failed for ${String(sessionId).slice(0, 8)} (fail-open — no chain): ${err?.message ?? err}`);
    return [];
  }
}

/**
 * Fire-time verdict for a due `once` row: walk from the row's own parent,
 * counting the row itself as a link. Cheap (one indexed read) and only called
 * for rows that carry chainedFromScheduleId. Fail-open.
 */
export async function evaluateDueOnceChain(row: { id: string; sessionId: string; kind: string; chainedFromScheduleId?: string | null; createdAt: Date | string }, now: Date | number = Date.now()): Promise<OnceChainVerdict> {
  if (row.kind !== 'once' || !row.chainedFromScheduleId) return NO_CHAIN;
  const rows = await loadOnceChainRows(row.sessionId, now);
  return walkOnceChain(rows, row.chainedFromScheduleId, new Date(row.createdAt), now);
}

/** The non-blocking advisory that rides the arm response once a chain is recurring-like. */
export function onceChainWarning(verdict: OnceChainVerdict, requestedIntervalSec: number): string | undefined {
  if (!verdict.recurringLike) return undefined;
  const cadenceMin = Math.round(chainCadenceSec(requestedIntervalSec, verdict) / 60);
  // The advisory names what ACTUALLY happens — a lane must never be told its
  // link parks or is refused when it is not.
  const dormancy = 'dormancy check at fire time (recorded — the link still fires)';
  const capMath = 'daily-cap math on the observed cadence (a cadence that can never fit the cap is warned, never refused)';
  return (
    `⚠️ ONE-SHOT CHAIN: this is link ${verdict.links} of a self-re-arming one-shot chain on this chat in the last 24h (observed cadence ~${cadenceMin} min). ` +
    `The chain is now governed as a RECURRING cadence — ${dormancy}, ${capMath}, busy re-arm + busy-skip accounting instead of queue-behind-busy. ` +
    `If this is a poll/wait loop, arm ONE recurring schedule (with a deltaGate when a cheap probe can tell "nothing changed") instead of re-arming a one-shot from every firing; if the work is genuinely done, stop re-arming.`
  );
}
