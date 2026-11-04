/**
 * GOAL UNPLANNED — the attention-watchdog sub-sweep (architecture review #6
 * part 3, 2026-10-20). See platform/goal-unplanned.ts for the why.
 *
 * detectUnplannedGoals: for every ACTIVE goal of a project whose supervisor is
 * enabled, with ZERO open todos (pending / in_progress / blocked), older than
 * GOAL_UNPLANNED_MIN_AGE_MS, whose progress note does not lead with a hold,
 * and with NO lane chartered to it (crossmodel_chats.charterGoalId — plus the
 * assignees of its todos) that ran in the last 6 h, the project supervisor
 * gets ONE '[GOAL UNPLANNED]' direct wake per goal per 24 h (Redis NX; no
 * Redis ⇒ no wake, never a duplicate) and a `goal_unplanned` loop_metrics row.
 * Blocked goals are never candidates (status 'active' only); a supervisor
 * switched OFF / a paused project never wakes.
 *
 * Same posture as the other watchdog sub-sweeps: best-effort, per-project
 * isolation, never throws into the cron loop. Kill switch
 * GOAL_UNPLANNED_SIGNAL_DISABLED=1 (read per sweep).
 *
 * Review fix (same day): the wakes are BOUNDED — a 48 h first-deploy ramp
 * (outcome 'ramp' rows, no wakes) and a per-goal backoff (24 h → 72 h → 7 d,
 * then board-only until the goal's todo set changes); see goal-unplanned.ts.
 * A Redis outage is counted as `redisUnavailable` (metric outcome
 * 'redis_error'), never as a dedupe.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { getProjectSupervisorsEnabled, recordSupervisorSwitchSkip } from '../platform/supervisor-switch';
import {
  goalUnplannedSignalDisabled, isUnplannedGoal, renderGoalUnplannedWake, goalUnplannedWakeKey,
  GOAL_UNPLANNED_MIN_AGE_MS, GOAL_UNPLANNED_LANE_WINDOW_MS, GOAL_UNPLANNED_DEDUPE_SEC,
  GOAL_UNPLANNED_WAKE_RAMP_MS, GOAL_UNPLANNED_LIVE_SINCE_KEY, GOAL_UNPLANNED_LIVE_SINCE_TTL_SEC, goalUnplannedRampKey,
  GOAL_UNPLANNED_MAX_STREAK_WAKES, GOAL_UNPLANNED_STREAK_TTL_SEC, goalUnplannedStreakKey,
  goalUnplannedBackoffSec, goalUnplannedTodoFingerprint, goalUnplannedPriorWakes,
} from '../platform/goal-unplanned';

const SOURCE = 'goal-unplanned';
/** Bound on project supervisors swept per firing (pathology guard — mirrors the adoption ladder). */
export const UNPLANNED_MAX_PROJECTS = 200;
/** Bound on active goals read per project. */
export const UNPLANNED_MAX_GOALS_PER_PROJECT = 50;

export interface UnplannedSweepDeps {
  now?: Date;
  enqueueDirectWake?: (o: { targetChatId: string; prompt: string; meta?: Record<string, unknown> }) => Promise<{ ok: boolean; hookEventId?: string; error?: string }>;
  /** Redis-like client (set NX/EX + get + del). Default: config/redis via a dynamic import. */
  redis?: { set: (...a: any[]) => Promise<any>; del: (k: string) => Promise<any>; get?: (k: string) => Promise<any> } | null;
  /** First-deploy ramp length (default GOAL_UNPLANNED_WAKE_RAMP_MS; 0 = no ramp — tests). */
  rampMs?: number;
}

export interface UnplannedSweepCounters {
  projects: number;
  candidates: number;
  wakes: number;
  deduped: number;
  laneActive: number;
  failed: number;
  /** Withheld by the first-deploy ramp. */
  ramp: number;
  /** Streak exhausted (GOAL_UNPLANNED_MAX_STREAK_WAKES on an unchanged goal) — board-only. */
  backedOff: number;
  /** No Redis client, or a Redis call threw — the wake was lost, not deduped. */
  redisUnavailable: number;
}

const REDIS_FAILED = Symbol('redis-failed');

/**
 * TRUE while the first-deploy ramp holds. The stamp is SET NX on first sight;
 * an unreadable stamp (Redis failure / no get) counts as "in ramp" — the
 * storm-proof default (directive-age.service directiveAgeRampActive). Never throws.
 */
export async function unplannedRampActive(redis: UnplannedSweepDeps['redis'], now: Date, rampMs: number): Promise<boolean> {
  if (!(rampMs > 0)) return false;
  if (!redis) return true;
  try {
    const set = await redis.set(GOAL_UNPLANNED_LIVE_SINCE_KEY, String(now.getTime()), { NX: true, EX: GOAL_UNPLANNED_LIVE_SINCE_TTL_SEC });
    if (set === 'OK') return true; // first run — the ramp starts now
    if (typeof redis.get !== 'function') return true;
    const since = Number(await redis.get(GOAL_UNPLANNED_LIVE_SINCE_KEY));
    if (!Number.isFinite(since)) return true;
    return now.getTime() - since < rampMs;
  } catch {
    return true;
  }
}

export async function detectUnplannedGoals(deps: UnplannedSweepDeps = {}): Promise<UnplannedSweepCounters> {
  const counters: UnplannedSweepCounters = { projects: 0, candidates: 0, wakes: 0, deduped: 0, laneActive: 0, failed: 0, ramp: 0, backedOff: 0, redisUnavailable: 0 };
  if (goalUnplannedSignalDisabled()) return counters;
  const now = deps.now ?? new Date();
  let sups: Array<{ id: string; projectId: string | null }> = [];
  try {
    sups = ((await prisma.crossModelChat.findMany({
      where: { isProjectSupervisor: true, projectId: { not: null }, archivedAt: null },
      select: { id: true, projectId: true },
      take: UNPLANNED_MAX_PROJECTS,
    })) ?? []) as Array<{ id: string; projectId: string | null }>;
  } catch (err: any) {
    logger.warn(`${SOURCE}: supervisor listing failed: ${err?.message ?? err}`, { source: SOURCE });
    return counters;
  }
  sups = sups.filter((s) => !!s?.projectId);
  if (!sups.length) return counters;
  const projects = ((await prisma.crossModelProject.findMany({
    where: { id: { in: sups.map((s) => s.projectId as string) } },
    select: { id: true, name: true, projectSupervisorEnabled: true, archivedAt: true },
  }).catch(() => [] as any[])) ?? []) as Array<{ id: string; projectSupervisorEnabled: boolean; archivedAt: Date | null }>;
  const enabled = new Set(projects.filter((p) => p.projectSupervisorEnabled === true && !p.archivedAt).map((p) => p.id));
  sups = sups.filter((s) => enabled.has(s.projectId as string));
  if (!sups.length) return counters;
  if (!(await getProjectSupervisorsEnabled().catch(() => true))) {
    for (const s of sups) recordSupervisorSwitchSkip({ target: 'project', source: SOURCE, chatId: s.id });
    return counters;
  }
  let redis = deps.redis;
  if (redis === undefined) {
    redis = ((await import('../../../config/redis').catch(() => null)) as any)?.default ?? null;
  }
  const wake = deps.enqueueDirectWake ?? (async (o: { targetChatId: string; prompt: string; meta?: Record<string, unknown> }) => (await import('../platform/hooks.service')).enqueueDirectWake(o));
  // Review fix (2026-10-20): the first-deploy ramp, computed ONCE per sweep.
  const inRamp = redis ? await unplannedRampActive(redis, now, deps.rampMs ?? GOAL_UNPLANNED_WAKE_RAMP_MS) : true;
  const seen = new Set<string>(); // one supervisor per project (a duplicate PS row never double-wakes)
  for (const sup of sups) {
    const projectId = sup.projectId as string;
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    counters.projects += 1;
    try {
      const goals = ((await prisma.projectGoal.findMany({
        where: { projectId, status: 'active', createdAt: { lte: new Date(now.getTime() - GOAL_UNPLANNED_MIN_AGE_MS) } },
        select: { id: true, title: true, status: true, progressNote: true, createdAt: true },
        take: UNPLANNED_MAX_GOALS_PER_PROJECT,
      })) ?? []) as Array<{ id: string; title: string; status: string; progressNote: string | null; createdAt: Date }>;
      if (!goals.length) continue;
      const todos = ((await prisma.projectTodo.findMany({
        where: { goalId: { in: goals.map((g) => g.id) } },
        select: { goalId: true, status: true, assigneeChatId: true },
      })) ?? []) as Array<{ goalId: string; status: string; assigneeChatId: string | null }>;
      for (const g of goals) {
        const rows = todos.filter((t) => t.goalId === g.id);
        const open = rows.filter((t) => t.status === 'pending' || t.status === 'in_progress' || t.status === 'blocked').length;
        if (!isUnplannedGoal(g, open)) continue;
        counters.candidates += 1;
        // A lane working the goal ran recently ⇒ it is being worked, not unplanned.
        const chartered = ((await prisma.crossModelChat.findMany({ where: { charterGoalId: g.id }, select: { id: true }, take: 20 }).catch(() => [])) ?? []) as Array<{ id: string }>;
        const lanes = Array.from(new Set([...chartered.map((c) => String(c.id)), ...rows.map((t) => t.assigneeChatId).filter((x): x is string => !!x)]));
        if (lanes.length) {
          const recent = Number(await prisma.agentRun.count({
            where: {
              sessionId: { in: lanes },
              OR: [{ status: { in: ['running', 'queued'] } }, { updatedAt: { gte: new Date(now.getTime() - GOAL_UNPLANNED_LANE_WINDOW_MS) } }],
            },
          }).catch(() => 1)) || 0; // a failed read counts as "a lane ran" — never wake on a missing fact
          if (recent > 0) { counters.laneActive += 1; continue; }
        }
        const doneTodos = rows.filter((t) => t.status === 'done').length;
        const droppedTodos = rows.filter((t) => t.status === 'dropped').length;
        const ageH = Math.round((now.getTime() - new Date(g.createdAt).getTime()) / 360_000) / 10;
        const record = (outcome: string, extra: Record<string, unknown> = {}): void => {
          try {
            recordLoopMetric({
              kind: LOOP_METRIC_KINDS.GOAL_UNPLANNED, sessionId: sup.id,
              meta: { goalId: g.id, projectId, outcome, doneTodos, droppedTodos, ageH: Number.isFinite(ageH) ? ageH : null, ...extra },
            });
          } catch { /* telemetry never blocks */ }
        };
        // No dedupe store ⇒ no wake (never a duplicate) — counted as an outage, never as a dedupe.
        if (!redis) { counters.redisUnavailable += 1; continue; }
        if (inRamp) {
          // First-deploy ramp: recorded once per goal per 24 h, never woken.
          counters.ramp += 1;
          const first = await redis.set(goalUnplannedRampKey(g.id), now.toISOString(), { NX: true, EX: GOAL_UNPLANNED_DEDUPE_SEC }).catch(() => REDIS_FAILED);
          if (first === 'OK') record('ramp');
          continue;
        }
        // Backoff: consecutive wakes on an unchanged todo set stretch the window; the cap leaves the board tag only.
        const fp = goalUnplannedTodoFingerprint(rows);
        const streakKey = goalUnplannedStreakKey(g.id);
        const rawStreak = typeof redis.get === 'function' ? await redis.get(streakKey).catch(() => REDIS_FAILED) : null;
        if (rawStreak === REDIS_FAILED) { counters.redisUnavailable += 1; continue; }
        const prior = goalUnplannedPriorWakes(rawStreak, fp);
        if (prior >= GOAL_UNPLANNED_MAX_STREAK_WAKES) { counters.backedOff += 1; continue; }
        const key = goalUnplannedWakeKey(g.id);
        const windowSec = goalUnplannedBackoffSec(prior);
        const claimed = await redis.set(key, now.toISOString(), { NX: true, EX: windowSec }).catch(() => REDIS_FAILED);
        if (claimed === REDIS_FAILED) { counters.redisUnavailable += 1; continue; }
        if (claimed !== 'OK') { counters.deduped += 1; continue; }
        const res: any = await wake({
          targetChatId: sup.id,
          prompt: renderGoalUnplannedWake({ goalId: g.id, title: g.title, doneTodos, droppedTodos, now }),
          meta: { origin: SOURCE, kind: 'goal_unplanned', goalId: g.id, projectId },
        }).catch((err: any) => ({ ok: false, error: err?.message ?? String(err) }));
        const ok = !!res && res.ok !== false;
        const streak = prior + 1;
        if (!ok) {
          await redis.del(key).catch(() => {}); // nothing enqueued — the window must not be spent
          counters.failed += 1;
          record('enqueue_failed', { error: String(res?.error ?? 'unknown').slice(0, 160) });
        } else {
          counters.wakes += 1;
          await redis.set(streakKey, JSON.stringify({ n: streak, fp, at: now.toISOString() }), { EX: GOAL_UNPLANNED_STREAK_TTL_SEC }).catch(() => {});
          record('woken', { streak, windowH: Math.round(windowSec / 3600), ...(streak >= GOAL_UNPLANNED_MAX_STREAK_WAKES ? { final: true } : {}) });
        }
      }
    } catch (err: any) {
      logger.warn(`${SOURCE}: project ${projectId.slice(0, 8)} sweep failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }
  }
  if (counters.wakes || counters.failed) logger.info(`${SOURCE}: sweep projects=${counters.projects} candidates=${counters.candidates} wakes=${counters.wakes} deduped=${counters.deduped} laneActive=${counters.laneActive} failed=${counters.failed} ramp=${counters.ramp} backedOff=${counters.backedOff}`, { source: SOURCE });
  if (counters.redisUnavailable) logger.warn(`${SOURCE}: ${counters.redisUnavailable} unplanned-goal wake(s) withheld — Redis unavailable (no dedupe store ⇒ no wake)`, { source: SOURCE });
  return counters;
}
