/**
 * Stopped-schedule decision cards (SA0906) — the ACTIVE alert for a lane whose
 * heartbeat died.
 *
 * Prod gap (verified 2026-09-06): when a recurring schedule stops permanently
 * (MAX_RUNS exhaustion / 30-day lifetime expiry / a machine-turn cancel) while
 * its project has an ACTIVE goal, the only surfaces were the hourly digest
 * summary + schedule_error attention items — passive and easy to miss. This
 * module files a first-class owner DECISION through the owner-questions
 * machinery (#624 pending-decisions queue: badge + push + one-tap resolve),
 * attributed to the SESSION CHAT that owns the schedule, so the owner's answer
 * relays back to a chat that can act (it holds schedule_self/update_schedule
 * for its own cadences).
 *
 * CRY-WOLF GUARD (SA0906 revision — prod replay b95e9df6): self-renewing
 * schedule_self chains arm a fresh schedule per spent link, so "a recurring row
 * exhausted its run budget" is NOT "the lane died" — spark-cluster showed 10
 * exhausted links + 1 enabled successor + 15 runs/48h, a perfectly healthy
 * lane. A decision files ONLY when the lane's heartbeat is provably dead at
 * CHECK time:
 *   - NO other ENABLED schedule on the session (no successor), AND
 *   - NO agent run created within the trailing LANE_ACTIVITY_WINDOW_MS (6h),
 * and the check runs on a DELAYED re-check (queueStoppedScheduleAlert — a
 * fire-and-forget ~12-min timer, so a lane that re-arms moments after
 * exhaustion never files). The timer is worker-death-lossy by design; the
 * hourly project-digest sweep is the durable backstop (it re-calls
 * maybeFileStoppedScheduleDecision for genuinely-dead stopped cadences, and
 * the per-scheduleId dedupe makes the two lanes idempotent).
 *
 * Never files: one-shot ('once') schedules, owner-explicit disables (Schedules
 * tab pause/DELETE, user-anchored cancel_schedule — the callers gate those),
 * sessions outside a project, projects without an OPEN (active OR blocked —
 * v1#11) goal, lanes that are
 * alive or of UNKNOWN liveness (a read error fails CLOSED for filing — a
 * missed alert beats a cry-wolf card), FINISHED lanes (ticket 3ce5f6d0 case C:
 * every goal the chat served is done/archived, or the lane cancelled its own
 * renewal inside its last completed run — a done lane looks identical to a
 * dead one), and chats that already carry an open stopped-schedule decision
 * (per-chat dedupe — one card per lane ever, 3ce5f6d0).
 *
 * Fail-open everywhere: filing must never break a stop path or the digest
 * sweep. Lazy prisma + lazy logger (the owner-questions.ts discipline): this
 * module is dynamically imported from schedule.service stop paths and the
 * digest sweep — a static config chain would pull env validation into every
 * jest graph that reaches them.
 */

type Prisma = typeof import('../../../config/database').default;
let _db: Prisma | null = null;
async function db(): Promise<Prisma> {
  if (!_db) _db = (await import('../../../config/database')).default;
  return _db;
}

async function logAlert(level: 'info' | 'warn', msg: string): Promise<void> {
  try {
    const logger = (await import('../../../utils/logger')).default;
    logger[level](msg);
  } catch { /* logging must never break the alert path */ }
}

/** Trailing window in which ANY agent run counts as lane life. */
export const LANE_ACTIVITY_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Delay before the fast-lane liveness re-check — long enough for a
 *  self-renewing chain's final run to arm its successor. */
export const STOPPED_ALERT_RECHECK_DELAY_MS = 12 * 60 * 1000;

/** Grace after a completed run's finish during which a machine self-cancel of
 *  the lane's own renewal still counts as the lane's deliberate LAST ACT
 *  (ticket 3ce5f6d0 case C — a self-stopped finished lane files no card). */
export const SELF_STOP_GRACE_MS = 15 * 60 * 1000;

/** Active goals named in the decision body (the rest collapse to "+K more"). */
export const MAX_GOALS_IN_DECISION = 3;

export type StoppedScheduleStopCause = 'max_runs' | 'expired' | 'cancelled';

/**
 * Gate flip 2026-09-11 (owner: full steam): the "Resume the stopped schedule?"
 * owner card is OBSERVE-ONLY by default — 7 cards since 09-08, 4 answered by
 * the owner (every one "leave stopped"), 0 resumes, 3 auto-moot; each patch
 * chased the previous false positive with another filter clause. The whole
 * detection pipeline (cry-wolf guard, finished-lane, purpose-complete,
 * attribution) still runs and logs ONE info line per genuinely-dead lane;
 * the Fleet Supervisor already receives every
 * schedule_disabled hook and can schedule_message. Opt-in
 * STOPPED_SCHEDULE_CARDS=1 restores the owner card.
 */
export function stoppedScheduleCardsEnabled(): boolean {
  return process.env.STOPPED_SCHEDULE_CARDS === '1';
}

export type StoppedScheduleFileResult =
  | { filed: true; questionId: string }
  | {
      filed: false;
      reason:
        | 'observe_only'
        | 'not_found'
        | 'not_recurring'
        | 'still_enabled'
        | 'lane_alive'
        | 'lane_unknown'
        | 'no_project'
        | 'no_active_goals'
        | 'finished_lane'
        | 'self_stopped'
        | 'purpose_complete'
        | 'already_open'
        | 'flag_refused'
        | 'error';
    };

/**
 * Feedback-ticket statuses that mean "this ticket's work is over" — ONE
 * vocabulary shared with the feedback service and the closure manifest
 * (feedback/ticket-status.ts, backlog audit T8 2026-09-28; an import-free
 * leaf, so this module's dynamic-import discipline holds). Re-exported for
 * the existing importers.
 */
import { CLOSED_TICKET_STATUSES } from '../feedback/ticket-status';
export { CLOSED_TICKET_STATUSES };
const TICKET_REF_RE = /\bticket\s+([0-9a-f]{8})\b/gi;

/**
 * Purpose check for MACHINE-armed follow-ups (2026-09-11, the burn-down resume
 * cards e90a4b63 / 80c7bd85): a lane's own "STEER-KEEPER + close loop for
 * mishap ticket 9a9911bb" / "lifecycle finisher for ticket db25c401" cadence is
 * finished when the tickets it names are. True only when the prompt names ≥1
 * ticket, every named ticket resolves to a row, and every row is in a closed
 * status. Unknown refs and read errors are NOT evidence of completion
 * (fail-open: never suppress on a hunch).
 */
export async function referencedTicketsAllClosed(prisma: Prisma, prompt: string | null | undefined): Promise<boolean> {
  const ids = [...new Set([...String(prompt ?? '').matchAll(TICKET_REF_RE)].map(m => m[1].toLowerCase()))];
  if (!ids.length) return false;
  try {
    const rows: Array<{ id: string; status: string }> = await prisma.userFeatureRequest.findMany({
      where: { OR: ids.map(id => ({ id: { startsWith: id } })) },
      select: { id: true, status: true },
    });
    if (rows.length < ids.length) return false;
    return rows.every(r => CLOSED_TICKET_STATUSES.includes(String(r.status)));
  } catch {
    return false;
  }
}

/**
 * Lane liveness at CHECK time: true = provably alive (an enabled successor
 * schedule, or an agent run created in the trailing 6h), false = provably
 * dead, null = UNKNOWN (a read failed). Callers must treat null as "do not
 * file" — a cry-wolf card is worse than a missed fast-lane alert (the digest
 * backstop retries hourly). NOTE: plain-chat firings create no agent_runs
 * rows, so for non-coding lanes the successor check is the live signal.
 */
export async function isLaneAlive(sessionId: string, excludeScheduleId: string): Promise<boolean | null> {
  try {
    const prisma = await db();
    // v1#12 successor honesty: only an enabled RECURRING row is a successor —
    // a pending one-shot (a continuation, a "remind me once") is not a lane
    // heartbeat, and counting it auto-suppressed real dead-lane decisions.
    const successors = await prisma.chatSchedule.count({
      where: { sessionId, enabled: true, kind: 'recurring', id: { not: excludeScheduleId } },
    });
    if (successors > 0) return true;
    const recentRuns = await prisma.agentRun.count({
      where: { sessionId, createdAt: { gte: new Date(Date.now() - LANE_ACTIVITY_WINDOW_MS) } },
    });
    return recentRuns > 0;
  } catch (err: any) {
    await logAlert('warn', `stopped-schedule alert: lane-liveness read failed for chat ${sessionId}: ${err?.message ?? err}`);
    return null;
  }
}

function causePhrase(cause: StoppedScheduleStopCause, row: { maxRuns: number | null; runsCount: number }): string {
  switch (cause) {
    case 'max_runs':
      return `hit its ${row.maxRuns ?? row.runsCount}-run cap`;
    case 'expired':
      return 'reached its 30-day lifetime expiry';
    case 'cancelled':
      return 'was cancelled by a machine-triggered run';
  }
}

/**
 * File ONE owner decision for a permanently-stopped schedule — after
 * re-verifying everything against the LIVE row (the schedule is re-read, so a
 * row resumed/GC'd between the stop and this check never files). `cause` is
 * trusted only for 'cancelled'; cap-vs-expiry is re-derived from the row
 * (both digest-backstop callers and the sweep's dual-condition disable can't
 * always tell them apart). Returns a structured result (pinned by tests);
 * NEVER throws.
 */
export async function maybeFileStoppedScheduleDecision(
  scheduleId: string,
  cause: StoppedScheduleStopCause,
): Promise<StoppedScheduleFileResult> {
  try {
    const prisma = await db();
    const row = await prisma.chatSchedule.findUnique({ where: { id: scheduleId } });
    if (!row) return { filed: false, reason: 'not_found' }; // GC'd — nothing to resume
    if (row.kind !== 'recurring') return { filed: false, reason: 'not_recurring' };
    if (row.enabled) return { filed: false, reason: 'still_enabled' }; // resumed before the re-check

    // Heartbeat check — the cry-wolf guard. UNKNOWN fails closed.
    const alive = await isLaneAlive(row.sessionId, row.id);
    if (alive === true) return { filed: false, reason: 'lane_alive' };
    if (alive === null) return { filed: false, reason: 'lane_unknown' };

    const chat = await prisma.crossModelChat.findUnique({
      where: { id: row.sessionId },
      select: { title: true, userId: true, projectId: true },
    });
    if (!chat || !chat.projectId) return { filed: false, reason: 'no_project' };

    // FINISHED-LANE suppression (ticket 3ce5f6d0 case C — owner-inbox noise,
    // 2026-09-10): a lane that is DONE looks exactly like a dead one (no
    // enabled schedule, no recent runs) and filed two noise resume cards on
    // the kernel lane (oq_9ffc4f5a + oq_dfe04aab) whose goal was long done.
    // (i) Every ProjectGoal THIS CHAT served (todos assigned to it) is
    //     done/archived → the lane finished its work; a project-wide open
    //     goal served by OTHER lanes must not resurrect it. A chat with NO
    //     assigned todos falls through — its service is unknown and the
    //     project-wide check below stays the behavior.
    const servedGoalIds = (
      await prisma.projectTodo.findMany({
        where: { assigneeChatId: row.sessionId },
        select: { goalId: true },
        distinct: ['goalId'],
      })
    ).map((t: any) => t?.goalId).filter(Boolean);
    if (servedGoalIds.length > 0) {
      const served = await prisma.projectGoal.findMany({
        where: { id: { in: servedGoalIds } },
        select: { status: true },
      });
      if (served.length > 0 && served.every((g: any) => g?.status === 'done' || g?.status === 'archived')) {
        await logAlert('info', `stopped-schedule alert: suppressed for schedule ${row.id} on chat ${row.sessionId} — every goal the lane served is done/archived (finished lane, 3ce5f6d0)`);
        return { filed: false, reason: 'finished_lane' };
      }
    }
    // (ii) The lane cancelled its own renewal as its last act: cancelledBy
    //      'machine' with the disable landing INSIDE (or within
    //      SELF_STOP_GRACE_MS after) the lane's most recent COMPLETED run —
    //      the deterministic proxy for the ticket's "a run whose journal is a
    //      completed audit": the lane deliberately ended its own cadence
    //      after finishing; it did not die silently.
    if (row.cancelledBy === 'machine' && row.disabledAt) {
      const lastDone = await prisma.agentRun.findFirst({
        where: { sessionId: row.sessionId, status: 'completed' },
        orderBy: { finishedAt: 'desc' },
        select: { createdAt: true, finishedAt: true },
      });
      const disabledMs = new Date(row.disabledAt).getTime();
      const runStartMs = lastDone?.createdAt ? new Date(lastDone.createdAt).getTime() : null;
      const runEndMs = lastDone?.finishedAt ? new Date(lastDone.finishedAt).getTime() : null;
      if (runStartMs != null && runEndMs != null && disabledMs >= runStartMs && disabledMs <= runEndMs + SELF_STOP_GRACE_MS) {
        await logAlert('info', `stopped-schedule alert: suppressed for schedule ${row.id} on chat ${row.sessionId} — the lane cancelled its own renewal inside its last completed run (self-stopped finished lane, 3ce5f6d0)`);
        return { filed: false, reason: 'self_stopped' };
      }
    }

    // v1#11: BLOCKED goals count too — a project whose every goal is blocked
    // is exactly the lane that most needs its stopped cadence surfaced (the
    // active-only filter silently skipped it). blockedReason rides into the
    // decision body so the owner sees WHAT the lane is waiting on.
    const projectGoals = await prisma.projectGoal.findMany({
      where: { projectId: chat.projectId, status: { in: ['active', 'blocked'] } },
      select: { id: true, title: true, status: true, blockedReason: true, createdByChatId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (projectGoals.length === 0) return { filed: false, reason: 'no_active_goals' };

    // Goal ATTRIBUTION for machine-armed cadences (2026-09-11 — the burn-down
    // resume cards that #664's finished-lane rule cannot catch): a chat with NO
    // assigned todos falls through the finished-lane check above, and a
    // PROJECT-wide goal read then treats every chat in a project with standing
    // program goals as a lane serving them — the crossmodel project always has
    // open programs, so every burn-down chat whose finite, MACHINE-armed
    // follow-up ("close loop for ticket X") ran out looked like a dead lane.
    // A machine-armed cadence is judged against the goals the CHAT itself
    // serves — ones it created or holds an open todo on. Owner-armed cadences
    // (promptSetBy 'user') and legacy unstamped rows keep the project-wide
    // read: the owner chose that heartbeat, so its death is always worth a card.
    const machineArmed = row.promptSetBy === 'machine' || row.promptSetBy === 'system';
    let activeGoals = projectGoals;
    if (machineArmed) {
      activeGoals = [];
      for (const g of projectGoals) {
        if (g.createdByChatId === row.sessionId) { activeGoals.push(g); continue; }
        const assigned = await prisma.projectTodo.count({
          where: { goalId: g.id, assigneeChatId: row.sessionId, status: { not: 'done' } },
        });
        if (assigned > 0) activeGoals.push(g);
      }
      if (activeGoals.length === 0) return { filed: false, reason: 'no_active_goals' };
      // The cadence's own stated purpose: a follow-up that names only closed
      // tickets is finished even when the chat serves a live goal.
      if (await referencedTicketsAllClosed(prisma, row.prompt)) return { filed: false, reason: 'purpose_complete' };
    }

    const effectiveCause: StoppedScheduleStopCause =
      cause === 'cancelled'
        ? 'cancelled'
        : row.maxRuns != null && row.runsCount >= row.maxRuns
          ? 'max_runs'
          : 'expired';

    // Gate flip 2026-09-11 (owner: full steam): a genuinely-dead lane is
    // LOGGED (info), never turned into an owner card — opt-in
    // STOPPED_SCHEDULE_CARDS=1 restores the card path below.
    if (!stoppedScheduleCardsEnabled()) {
      await logAlert('info', `stopped-schedule alert: detected dead lane for schedule ${row.id} (${effectiveCause}) on chat ${row.sessionId} serving ${activeGoals.length} open goal(s) — observed only (STOPPED_SCHEDULE_CARDS unset; no owner card)`);
      return { filed: false, reason: 'observe_only' };
    }

    const {
      flagOwnerQuestion,
      hasOpenStoppedScheduleDecisionForChat,
      stoppedScheduleMarker,
    } = await import('../platform/owner-questions');

    // Per-CHAT dedupe (ticket 3ce5f6d0 case C): ONE open stopped-schedule
    // decision per lane ever — two stopped links of the same lane must not
    // stack two cards (the 2026-09-10 19:07Z double on the kernel lane). The
    // marker still carries THIS schedule's id for the session-scoped
    // auto-resolve, and flagOwnerQuestion's exact-question dedupe backstops.
    if (await hasOpenStoppedScheduleDecisionForChat(row.sessionId)) return { filed: false, reason: 'already_open' };

    // Remaining (not-done) todos per named goal — the "which goal was this
    // serving" facts of the decision body.
    const named = activeGoals.slice(0, MAX_GOALS_IN_DECISION);
    const goalLines: string[] = [];
    for (const g of named) {
      const remaining = await prisma.projectTodo.count({
        where: { goalId: g.id, status: { not: 'done' } },
      });
      const blockedTag = (g as any).status === 'blocked'
        ? ` — BLOCKED: ${String((g as any).blockedReason ?? 'no reason recorded').slice(0, 120)}`
        : '';
      goalLines.push(`"${g.title}" (${remaining} todo${remaining === 1 ? '' : 's'} remaining${blockedTag})`);
    }
    const moreGoals = activeGoals.length - named.length;

    const cadence = row.intervalSec ? `every ${Math.round(row.intervalSec / 60)} min` : 'recurring';
    const question = `Resume the stopped schedule ${row.id.slice(0, 8)} on "${chat.title}"?`;
    const context = [
      // Marker FIRST — the 4000-char context cap must never truncate it away.
      stoppedScheduleMarker(row.id),
      `Schedule ${row.id} on chat "${chat.title}" stopped permanently — it ${causePhrase(effectiveCause, row)}. ` +
        `Cadence: ${cadence}; runs used: ${row.runsCount}${row.maxRuns != null ? `/${row.maxRuns}` : ''}; last status: ${row.lastStatus ?? 'unknown'}. ` +
        'It will NOT fire again on its own, the chat has no other enabled schedule, and no runs have landed recently — this lane is silent until someone acts.',
      `Open goal${activeGoals.length === 1 ? '' : 's'} (active/blocked) it was serving: ${goalLines.join('; ')}${moreGoals > 0 ? `; +${moreGoals} more` : ''}.`,
      'Reply "resume" to restart it — the chat will re-arm the same cadence (a fresh schedule with a fresh nextRunAt) — or reply "leave stopped" to keep it off.',
    ].join('\n');

    const res = await flagOwnerQuestion({ chatId: row.sessionId, userId: chat.userId, question, context });
    if (res.kind === 'created') {
      void logAlert('info', `stopped-schedule alert: filed decision ${res.question.id} for schedule ${row.id} (${effectiveCause}) on chat ${row.sessionId}`);
      return { filed: true, questionId: res.question.id };
    }
    if (res.kind === 'deduped') return { filed: false, reason: 'already_open' };
    void logAlert('warn', `stopped-schedule alert: flag refused (${res.refused}) for schedule ${row.id} on chat ${row.sessionId}`);
    return { filed: false, reason: 'flag_refused' };
  } catch (err: any) {
    await logAlert('warn', `stopped-schedule alert: filing failed for schedule ${scheduleId}: ${err?.message ?? err}`);
    return { filed: false, reason: 'error' };
  }
}

/**
 * Fast lane: queue the delayed liveness re-check for a schedule that just
 * stopped by a machine path. Fire-and-forget and unref'd — worker-death-lossy
 * by design (the hourly digest sweep is the durable backstop). Synchronous and
 * throw-free so stop paths can call it inline.
 */
export function queueStoppedScheduleAlert(
  scheduleId: string,
  cause: StoppedScheduleStopCause,
  opts?: { delayMs?: number },
): void {
  try {
    const t = setTimeout(() => {
      void maybeFileStoppedScheduleDecision(scheduleId, cause).catch(() => {});
    }, opts?.delayMs ?? STOPPED_ALERT_RECHECK_DELAY_MS);
    (t as any).unref?.();
  } catch { /* never break the stop path */ }
}
