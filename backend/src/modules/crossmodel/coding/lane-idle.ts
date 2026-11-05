/**
 * LANE-IDLE-WAKE (supervisor SOTA round 2, 2026-10-20 — continuous goal
 * delivery: a lane holding open work never stalls silently).
 *
 * WHY (architecture review of production, "never stall"): a lane holding an
 * actionable assigned todo could sit idle from 30 min to 4.5 h — or forever:
 *   - the supervisor material gate counted a STALL only on a sweep
 *     (wake-material-rule 'stall', STALL_IDLE_MIN 30), so the project
 *     supervisor heard of an idle lane only at its next stock sweep (2 h, 4 h
 *     after the sweep backoff);
 *   - the ledger's stalledLanes (supervisor-wake-ledger) saw only in_progress
 *     todos, only on lanes with an agent_runs row, and ANY enabled schedule
 *     (a check armed for tomorrow) made the lane "armed";
 *   - lane-todos maybeStartNextLaneTodo treated any enabled schedule as
 *     'scheduled', and run-executor continued a lane only after a COMPLETED
 *     run (a failed run left its todo in_progress with nobody told).
 *
 * NOW: the finalize of every completed / failed lane run (never a supervisor,
 * never an archived chat, never a deploy-interrupted run — that row resumes
 * itself) asks ONE question: does the lane hold an ACTIONABLE assigned todo
 * (in_progress, or pending with no open dependency — blocked / done / dropped
 * never count) while NOTHING will wake it — no queued or running run on the
 * lane or on a child session it spawned, no pending hook row aimed at it, no
 * open owner question / pending confirmation card it waits on, and no enabled
 * schedule that ARMS it (scheduleArmsLane: due within STALL_ARMED_HORIZON_MS
 * = 2 h, or — a recurring row — within 1.5 × its own interval; the SAME rule
 * the sweep's stalledLanes uses, at finalize and at delivery)? Then ONE
 * durable direct wake is enqueued on the lane's supervisor (the project
 * supervisor; the Fleet Supervisor when the project has none — or project
 * supervisors are switched off — and is supervised; nobody while the Fleet's
 * own switch is off) with notBefore = now + LANE_IDLE_GRACE_MS (20 min) — the grace
 * window in which the T7-10 next-todo continuation or a queued message can
 * still move the lane. The wake row is a todo_wake (alarm-class: it is never
 * dropped at a spent cap) carrying payload.wakeKind 'lane_idle', which the
 * supervisor material gate reads as the DECISION reason 'lane_idle'. On
 * DELIVERY the harness re-reads the lane (revalidateLaneIdleWake): a live
 * run, a pending wake, an owner wait, an arming schedule, no actionable todo
 * left, or a newer run that was STOPPED ⇒ the row is consumed with no wake
 * (suppressedAtDelivery 'lane_idle:<why>'). A lane that ran again since the
 * enqueue and is idle again is a NEW idle episode: the row is handed back
 * (deferred) until that newest run is LANE_IDLE_GRACE_MS old, then delivered
 * with a prompt naming the newest run — so a finalize 'deduped' against the
 * still-pending row never loses its episode.
 *
 * A CANCELLED run never wakes the supervisor (review fix 2026-10-20): every
 * cancel is an explicit stop — the owner's Stop button or a chat's stop_run
 * (the zombie stop has no chat left) — and a stop means stop
 * (continuation-guard; ALARM-CAUSE-AWARE makes a chat's stop a quiet row). It
 * is recorded observe-only (outcome 'stopped'); the sweep's stalledLanes
 * still lists the lane, and no wake text offers to restart, re-dispatch or
 * reassign stopped work.
 *
 * Bounds: one enqueue per lane per LANE_IDLE_DEDUPE_SEC (6 h, Redis SET NX;
 * DB fallback when Redis is down; a deferral refreshes it); a suppressed
 * delivery — or a row a supervisor-OFF skip consumed (hooks.service) —
 * releases the key so the next genuine idle episode can wake. A row parked
 * behind a busy supervisor records its 'delivered' row ONCE per episode
 * (payload.laneIdleDeliveredAt, persisted by hooks.service).
 *
 * Every read fails toward "no enqueue" at FINALIZE (the next sweep's widened
 * stalledLanes still sees the lane) and toward DELIVERY at revalidation (a
 * read error never consumes a supervisor wake). Kill switch
 * LANE_IDLE_WAKE_DISABLED=1 (read per call) — also restores the old
 * stalledLanes shape and the any-enabled-schedule rule in
 * maybeStartNextLaneTodo. Telemetry: loop_metrics `lane_idle_wake`
 * {outcome, phase:'finalize'|'delivery', …}.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric } from '../platform/loop-metrics.service';
import { LOOP_METRIC_KINDS } from '../platform/loop-metric-kinds';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** LANE_IDLE_WAKE_DISABLED=1 — no lane-idle supervisor wake, the pre-2026-10-20 stalledLanes / next-todo schedule rules. Read per call. */
export function laneIdleWakeDisabled(): boolean {
  return onFlag(process.env.LANE_IDLE_WAKE_DISABLED);
}

/** The wake's notBefore delay (the grace window) and the age a moved lane's newest run must reach before a deferred row delivers. */
export const LANE_IDLE_GRACE_MS = 20 * 60_000;
/** One lane-idle wake per lane per this many seconds. */
export const LANE_IDLE_DEDUPE_SEC = 6 * 3600;
/** payload.wakeKind of the supervisor wake row (the material gate's 'lane_idle' reason). */
export const LANE_IDLE_WAKE_KIND = 'lane_idle';
/** payload.trigger — distinct from lane-todos' own 'lane_idle' continuation trigger (that wake targets the LANE). */
export const LANE_IDLE_WAKE_TRIGGER = 'lane_idle_supervisor';
/** maybeStartNextLaneTodo: only a schedule due within this counts as "the lane is scheduled". */
export const LANE_TODO_SCHEDULED_HORIZON_MS = 30 * 60_000;
/** A schedule due within this arms a lane (the lane-idle wake AND the sweep's stalledLanes). */
export const STALL_ARMED_HORIZON_MS = 2 * 3_600_000;
/** A RECURRING schedule due within this many of its own intervals arms the lane too (its normal cadence). */
export const RECURRING_ARMED_INTERVALS = 1.5;

const DEDUPE_KEY = (laneChatId: string): string => `lane-idle-wake:${laneChatId}`;
const MAX_TODOS = 50;
const MAX_SCHEDULES = 20;
const MAX_CHILDREN = 50;

export type LaneRunEnd = 'completed' | 'failed' | 'cancelled';

export interface LaneIdleTodo { id: string; title: string; status: string; goalId: string; projectId: string }

export interface LaneIdleFacts {
  /** Actionable todos assigned to the lane: in_progress, or pending with no open dependency (oldest first). */
  todos: LaneIdleTodo[];
  /** A queued / running agent_runs row on the lane (the finalizing run excluded) or on a child session it spawned. */
  liveRun: boolean;
  /** A pending / delivering hook row aimed at the lane (a todo wake, a child result, a closing wake …). */
  pendingWake: boolean;
  /** The lane waits on the OWNER: an open owner question it flagged or a pending (unexpired) confirmation card it staged. */
  ownerWait?: boolean;
  /** An enabled schedule that arms the lane (scheduleArmsLane). */
  scheduleDueSoon: boolean;
}

export type LaneIdleWhy = 'no_open_work' | 'live_run' | 'pending_wake' | 'owner_wait' | 'schedule_due' | 'idle';

/** Pure: is the lane idle with open work — nothing will wake it? The first reason that keeps it moving wins. */
export function laneIdleVerdict(f: LaneIdleFacts): { idle: boolean; why: LaneIdleWhy } {
  if (!f.todos.length) return { idle: false, why: 'no_open_work' };
  if (f.liveRun) return { idle: false, why: 'live_run' };
  if (f.pendingWake) return { idle: false, why: 'pending_wake' };
  if (f.ownerWait) return { idle: false, why: 'owner_wait' };
  if (f.scheduleDueSoon) return { idle: false, why: 'schedule_due' };
  return { idle: true, why: 'idle' };
}

/**
 * Pure: does this ENABLED schedule wake the lane soon enough to count as
 * "armed"? Due within STALL_ARMED_HORIZON_MS (2 h), or — a RECURRING row —
 * within RECURRING_ARMED_INTERVALS (1.5) × its own interval: an hourly / 2-hourly
 * / daily lane between two firings is on its cadence, not idle. A one-shot
 * armed for tomorrow does NOT arm the lane (the original "any enabled
 * schedule" gap). An unreadable nextRunAt never arms. Shared by the finalize
 * check, the delivery revalidation and the sweep's stalledLanes.
 */
export function scheduleArmsLane(
  s: { nextRunAt?: Date | string | null; kind?: string | null; intervalSec?: number | null },
  now: Date,
): boolean {
  const at = s?.nextRunAt ? new Date(s.nextRunAt as any).getTime() : NaN;
  if (!Number.isFinite(at)) return false;
  const interval = Number(s.intervalSec);
  const cadenceMs = s.kind === 'recurring' && Number.isFinite(interval) && interval > 0 ? RECURRING_ARMED_INTERVALS * interval * 1000 : 0;
  return at <= now.getTime() + Math.max(STALL_ARMED_HORIZON_MS, cadenceMs);
}

/** Pure: the todo the wake names — the lane's in_progress todo first, else the oldest actionable one. */
export function laneIdleFocusTodo(todos: readonly LaneIdleTodo[]): LaneIdleTodo | null {
  return todos.find((t) => t.status === 'in_progress') ?? todos[0] ?? null;
}

const clip = (v: unknown, n: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * Pure: the supervisor's wake prompt (re-read first; ONE decision). Only a
 * completed / failed run ever reaches it — a stopped run never wakes the
 * supervisor (a stop means stop).
 */
export function laneIdleWakePrompt(o: {
  laneChatId: string;
  laneTitle: string | null;
  todos: readonly LaneIdleTodo[];
  runId: string;
  finalStatus: 'completed' | 'failed';
  endedAt: Date;
  graceMin: number;
}): string {
  const focus = laneIdleFocusTodo(o.todos);
  const more = o.todos.length > 1 ? ` (+${o.todos.length - 1} more open todo(s) assigned to it)` : '';
  const ended = o.finalStatus === 'failed' ? 'FAILED' : 'completed';
  const lane = `${o.laneChatId}${o.laneTitle ? ` ("${clip(o.laneTitle, 60)}")` : ''}`;
  const armedH = Math.round(STALL_ARMED_HORIZON_MS / 3_600_000);
  return `[LANE IDLE WITH OPEN WORK — harness check, lane ${o.laneChatId.slice(0, 8)}]\n`
    + `Lane ${lane} holds todo ${focus ? `${focus.id.slice(0, 8)} "${clip(focus.title, 80)}" (${focus.status})` : '(unknown)'}${more} `
    + 'and NOTHING will wake it: no queued or running run (its own or a child session\'s), no pending wake, no open owner question or confirmation card, '
    + `no schedule due within ${armedH} h (a recurring one: within ${RECURRING_ARMED_INTERVALS}× its own interval). `
    + `Its last run ${o.runId.slice(0, 8)} ${ended} at ${o.endedAt.toISOString()}; the harness waited ${o.graceMin} min and re-checked at delivery — the lane has not moved since.\n\n`
    + 'Re-read the lane (get_chat_status) and the todo (todo_get) FIRST, then make ONE decision: steer the lane to start / continue it '
    + '(send_chat_message), re-dispatch it to a fresh lane, arm a schedule if it waits on something timed, or block / drop the todo with a '
    + 'reason if it is not actionable. '
    + 'A lane that is waiting on purpose should say so on the board (blocked with a blockedReason), so this check stays quiet.';
}

/**
 * The lane's facts (THROWS on a DB error — the callers choose the fail
 * direction). `excludeRunId` drops the run being finalized from the live-run
 * count.
 */
export async function readLaneIdleFacts(laneChatId: string, now: Date, opts: { excludeRunId?: string | null } = {}): Promise<LaneIdleFacts> {
  const rows: Array<{ id: string; title: string; status: string; goalId: string; projectId: string }> = await prisma.projectTodo.findMany({
    where: { assigneeChatId: laneChatId, status: { in: ['pending', 'in_progress'] } },
    select: { id: true, title: true, status: true, goalId: true, projectId: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_TODOS,
  });
  let todos = rows;
  const pendingIds = rows.filter((r) => r.status === 'pending').map((r) => r.id);
  if (pendingIds.length) {
    const deps: Array<{ todoId: string; dependsOnTodoId: string }> = await prisma.todoDependency.findMany({
      where: { todoId: { in: pendingIds } },
      select: { todoId: true, dependsOnTodoId: true },
    });
    if (deps.length) {
      const targets: Array<{ id: string; status: string }> = await prisma.projectTodo.findMany({
        where: { id: { in: [...new Set(deps.map((d) => d.dependsOnTodoId))] } },
        select: { id: true, status: true },
      });
      const open = new Set(targets.filter((t) => t.status !== 'done' && t.status !== 'dropped').map((t) => t.id));
      const waiting = new Set(deps.filter((d) => open.has(d.dependsOnTodoId)).map((d) => d.todoId));
      todos = rows.filter((r) => !(r.status === 'pending' && waiting.has(r.id)));
    }
  }
  if (!todos.length) return { todos: [], liveRun: false, pendingWake: false, ownerWait: false, scheduleDueSoon: false };
  const [live, children, wakes, questions, cards, schedules] = await Promise.all([
    prisma.agentRun.count({ where: { sessionId: laneChatId, status: { in: ['queued', 'running'] }, ...(opts.excludeRunId ? { NOT: { id: opts.excludeRunId } } : {}) } }),
    // A lane that handed its work to a child sub-session (spawn-ends-turn) is woken by the child's result hook.
    prisma.crossModelChat.findMany({ where: { parentChatId: laneChatId, archivedAt: null }, select: { id: true }, take: MAX_CHILDREN }),
    prisma.hookEvent.count({ where: { status: { in: ['pending', 'delivering'] }, hook: { targetChatId: laneChatId, enabled: true } } }),
    prisma.ownerQuestion.count({ where: { chatId: laneChatId, status: 'open' } }),
    prisma.pendingConfirmation.count({ where: { chatId: laneChatId, status: 'pending', expiresAt: { gt: now } } }),
    prisma.chatSchedule.findMany({
      where: { sessionId: laneChatId, enabled: true },
      select: { nextRunAt: true, kind: true, intervalSec: true },
      orderBy: { nextRunAt: 'asc' },
      take: MAX_SCHEDULES,
    }),
  ]);
  const childIds = ((children ?? []) as Array<{ id: string }>).map((c) => c.id);
  const childLive = childIds.length
    ? Number(await prisma.agentRun.count({ where: { sessionId: { in: childIds }, status: { in: ['queued', 'running'] } } })) > 0
    : false;
  return {
    todos,
    liveRun: Number(live) > 0 || childLive,
    pendingWake: Number(wakes) > 0,
    ownerWait: Number(questions) > 0 || Number(cards) > 0,
    scheduleDueSoon: ((schedules ?? []) as Array<{ nextRunAt: Date | null; kind: string | null; intervalSec: number | null }>).some((s) => scheduleArmsLane(s, now)),
  };
}

/** Is the admin supervisor switch for this tier ON (platform/supervisor-switch)? Fail-open: any failure = ON (the pre-switch routing). */
async function supervisorTierOn(target: 'fleet' | 'project'): Promise<boolean> {
  try {
    const m = await import('../platform/supervisor-switch');
    return await (target === 'fleet' ? m.getFleetSupervisorEnabled() : m.getProjectSupervisorsEnabled());
  } catch {
    return true;
  }
}

/**
 * The supervisor that owns the lane's work: the project supervisor, else the
 * Fleet Supervisor of a supervised project. A switched-off tier owns nothing
 * (review fix, 2026-10-20): with project supervisors OFF the Fleet owns the
 * project (readPsCoveredProjects' definition) — a wake on the PS would be
 * skipped at delivery and hold the 6 h slot; with the Fleet OFF, nobody.
 * Never throws (null = nobody).
 */
export async function resolveLaneSupervisor(userId: string, projectId: string | null): Promise<{ chatId: string; kind: 'project' | 'fleet' } | null> {
  try {
    if (projectId) {
      const project = await prisma.crossModelProject.findUnique({ where: { id: projectId }, select: { supervised: true, projectSupervisorEnabled: true } });
      if (project?.projectSupervisorEnabled && await supervisorTierOn('project')) {
        const ps = await prisma.crossModelChat.findFirst({ where: { userId, projectId, isProjectSupervisor: true, archivedAt: null }, select: { id: true } });
        if (ps?.id) return { chatId: ps.id, kind: 'project' };
      }
      if (project && project.supervised === false) return null;
    }
    if (!(await supervisorTierOn('fleet'))) return null;
    const fleet = await prisma.crossModelChat.findFirst({ where: { userId, isSupervisor: true, archivedAt: null }, select: { id: true } });
    return fleet?.id ? { chatId: fleet.id, kind: 'fleet' } : null;
  } catch {
    return null;
  }
}

async function redisClient(): Promise<any> {
  return (await import('../../../config/redis').catch(() => null))?.default ?? null;
}

/**
 * Claim the per-lane dedupe slot. Redis SET NX first; with Redis down, a DB
 * read of the lane-idle rows enqueued in the window decides (a DB error there
 * claims nothing — the next sweep's stalledLanes still sees the lane).
 */
async function claimLaneIdleSlot(laneChatId: string, supervisorChatId: string, now: Date): Promise<'claimed' | 'deduped'> {
  const redis = await redisClient();
  if (redis) {
    const r = await redis.set(DEDUPE_KEY(laneChatId), now.toISOString(), { NX: true, EX: LANE_IDLE_DEDUPE_SEC }).catch(() => 'ERR');
    if (r === 'OK') return 'claimed';
    if (r !== 'ERR') return 'deduped';
  }
  try {
    const recent = await prisma.hookEvent.count({
      where: {
        status: { in: ['pending', 'delivering', 'delivered'] },
        createdAt: { gte: new Date(now.getTime() - LANE_IDLE_DEDUPE_SEC * 1000) },
        eventType: 'todo_wake',
        hook: { targetChatId: supervisorChatId },
        payload: { path: ['laneChatId'], equals: laneChatId },
      },
    });
    return Number(recent) > 0 ? 'deduped' : 'claimed';
  } catch {
    return 'deduped';
  }
}

/** Release the lane's dedupe slot (a suppressed delivery, a failed enqueue, a supervisor-OFF skip in hooks.service). Never throws. */
export async function releaseLaneIdleSlot(laneChatId: string): Promise<void> {
  try {
    const redis = await redisClient();
    if (redis) await redis.del(DEDUPE_KEY(laneChatId)).catch(() => undefined);
  } catch { /* best-effort */ }
}

/** A deferred row still owns the episode: keep the slot for a fresh window so no second row is enqueued meanwhile. */
async function refreshLaneIdleSlot(laneChatId: string, now: Date): Promise<void> {
  try {
    const redis = await redisClient();
    if (redis) await redis.set(DEDUPE_KEY(laneChatId), now.toISOString(), { EX: LANE_IDLE_DEDUPE_SEC }).catch(() => undefined);
  } catch { /* best-effort */ }
}

export type LaneIdleOutcome =
  | 'disabled' | 'not_lane' | 'no_open_work' | 'live_run' | 'pending_wake' | 'owner_wait' | 'schedule_due'
  | 'stopped' | 'no_supervisor' | 'deduped' | 'enqueued' | 'enqueue_failed' | 'error';

/**
 * Run finalize (completed / failed lane runs; a cancelled run is recorded
 * observe-only as 'stopped' and never wakes anyone): enqueue ONE delayed
 * supervisor wake when the lane is idle with open work. One loop_metrics row
 * per decision that found open work. Never throws.
 */
export async function maybeWakeSupervisorForIdleLane(o: { chatId: string; userId: string; runId: string; finalStatus: LaneRunEnd; now?: Date }): Promise<LaneIdleOutcome> {
  if (laneIdleWakeDisabled()) return 'disabled';
  const now = o.now ?? new Date();
  const record = (outcome: LaneIdleOutcome, meta: Record<string, unknown> = {}): LaneIdleOutcome => {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.LANE_IDLE_WAKE, sessionId: o.chatId, runId: o.runId, meta: { phase: 'finalize', outcome, finalStatus: o.finalStatus, ...meta } });
    return outcome;
  };
  try {
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: o.chatId },
      select: { title: true, projectId: true, isSupervisor: true, isProjectSupervisor: true, archivedAt: true },
    });
    if (!chat || chat.isSupervisor || chat.isProjectSupervisor || chat.archivedAt) return 'not_lane';
    const facts = await readLaneIdleFacts(o.chatId, now, { excludeRunId: o.runId });
    const verdict = laneIdleVerdict(facts);
    if (verdict.why === 'no_open_work') return 'no_open_work';
    const focus = laneIdleFocusTodo(facts.todos);
    const base = { todoId: focus?.id ?? null, openTodos: facts.todos.length };
    // A stop means stop: the owner's Stop button or a chat's stop_run ended this run. Observe-only.
    if (o.finalStatus === 'cancelled') return record('stopped', { ...base, idle: verdict.idle });
    if (!verdict.idle) return record(verdict.why as LaneIdleOutcome, base);
    const sup = await resolveLaneSupervisor(o.userId, focus?.projectId || chat.projectId || null);
    if (!sup) return record('no_supervisor', base);
    if (await claimLaneIdleSlot(o.chatId, sup.chatId, now) !== 'claimed') return record('deduped', { ...base, supervisorChatId: sup.chatId });
    const notBefore = new Date(now.getTime() + LANE_IDLE_GRACE_MS);
    const { enqueueDirectWake } = await import('../platform/hooks.service');
    const res = await enqueueDirectWake({
      targetChatId: sup.chatId,
      prompt: laneIdleWakePrompt({
        laneChatId: o.chatId, laneTitle: chat.title ?? null, todos: facts.todos, runId: o.runId,
        finalStatus: o.finalStatus, endedAt: now, graceMin: Math.round(LANE_IDLE_GRACE_MS / 60_000),
      }),
      meta: {
        wakeKind: LANE_IDLE_WAKE_KIND, trigger: LANE_IDLE_WAKE_TRIGGER, laneChatId: o.chatId,
        ...(focus ? { laneTodoId: focus.id } : {}), laneRunId: o.runId, laneRunStatus: o.finalStatus, enqueuedAt: now.toISOString(),
      },
      notBefore,
    });
    if (!res.ok) {
      await releaseLaneIdleSlot(o.chatId);
      return record('enqueue_failed', { ...base, supervisorChatId: sup.chatId, error: String(res.error ?? '').slice(0, 120) });
    }
    return record('enqueued', { ...base, supervisorChatId: sup.chatId, supervisorKind: sup.kind, hookEventId: res.hookEventId ?? null, notBefore: notBefore.toISOString() });
  } catch (err: any) {
    logger.warn(`lane-idle: finalize check for ${o.chatId.slice(0, 8)} failed (non-fatal — the next sweep's stalledLanes still sees the lane): ${err?.message ?? err}`);
    return 'error';
  }
}

/** What the delivery revalidation decided for a lane_idle wake row. */
export type LaneIdleDeliveryVerdict =
  /**
   * Wake the supervisor; `prompt` (when set) replaces the row's summary — the lane moved since the enqueue and went
   * idle again. `deliveredAt` is set on the pass that recorded the episode's 'delivered' row: the caller persists it
   * as payload.laneIdleDeliveredAt.
   */
  | { action: 'deliver'; prompt?: string; deliveredAt?: string }
  /** Stale: consume the row with no wake. */
  | { action: 'suppress'; reason: string }
  /** A new idle episode still inside its grace window: hand the row back until `until`. */
  | { action: 'defer'; until: Date; reason: string };

/**
 * DELIVERY revalidation of a lane-idle wake row. Never throws — a read error
 * delivers (a supervisor never misses a stall on a DB hiccup). A stale
 * verdict releases the dedupe slot so the lane's next idle episode can wake;
 * a deferral refreshes it (the row still owns the episode). One loop_metrics
 * row per verdict — a 'delivered' row once per EPISODE (review fix
 * 2026-10-20): a busy supervisor re-parks the row and the sweep re-claims it,
 * so a row already stamped payload.laneIdleDeliveredAt records nothing more
 * unless the newest run the re-rendered prompt names ended after the stamp.
 */
export async function revalidateLaneIdleWake(payload: unknown, now: Date = new Date()): Promise<LaneIdleDeliveryVerdict> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const lane = typeof p.laneChatId === 'string' ? p.laneChatId : '';
  if (!lane) return { action: 'deliver' };
  let verdict: LaneIdleDeliveryVerdict = { action: 'deliver' };
  let newestRunId: string | null = null;
  let newestEndedMs: number | null = null;
  try {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: lane }, select: { archivedAt: true, title: true } });
    if (!chat) verdict = { action: 'suppress', reason: 'lane_missing' };
    else if (chat.archivedAt) verdict = { action: 'suppress', reason: 'lane_archived' };
    else {
      const facts = await readLaneIdleFacts(lane, now);
      const idle = laneIdleVerdict(facts);
      if (!idle.idle) verdict = { action: 'suppress', reason: idle.why };
      else {
        const enqueuedMs = Date.parse(String(p.enqueuedAt ?? ''));
        const newest = Number.isFinite(enqueuedMs)
          ? await prisma.agentRun.findFirst({
            where: { sessionId: lane, createdAt: { gt: new Date(enqueuedMs) } },
            orderBy: { createdAt: 'desc' },
            select: { id: true, status: true, createdAt: true, finishedAt: true },
          })
          : null;
        if (newest) {
          newestRunId = String(newest.id);
          const endedMs = new Date((newest.finishedAt ?? newest.createdAt) as any).getTime();
          if (Number.isFinite(endedMs)) newestEndedMs = endedMs;
          if (String(newest.status) === 'cancelled') verdict = { action: 'suppress', reason: 'lane_stopped' }; // a stop means stop
          else if (Number.isFinite(endedMs) && now.getTime() - endedMs < LANE_IDLE_GRACE_MS) {
            verdict = { action: 'defer', until: new Date(endedMs + LANE_IDLE_GRACE_MS), reason: 'lane_moved' };
          } else {
            // The lane ran again, then went idle again ≥ the grace window ago — a NEW idle episode (its own
            // finalize was deduped against this row): deliver, naming the newest run.
            verdict = {
              action: 'deliver',
              prompt: laneIdleWakePrompt({
                laneChatId: lane, laneTitle: (chat as any).title ?? null, todos: facts.todos, runId: newestRunId,
                finalStatus: String(newest.status) === 'failed' ? 'failed' : 'completed',
                endedAt: new Date(Number.isFinite(endedMs) ? endedMs : now.getTime()), graceMin: Math.round(LANE_IDLE_GRACE_MS / 60_000),
              }),
            };
          }
        }
      }
    }
  } catch (err: any) {
    logger.debug?.(`lane-idle: delivery revalidation for ${lane.slice(0, 8)} failed (${err?.message ?? err}) — delivering`);
    return { action: 'deliver' };
  }
  const todoId = typeof p.laneTodoId === 'string' ? p.laneTodoId : null;
  const stampMs = Date.parse(String(p.laneIdleDeliveredAt ?? ''));
  const firstDelivery = verdict.action === 'deliver' && (!Number.isFinite(stampMs) || (newestEndedMs !== null && newestEndedMs > stampMs));
  if (verdict.action !== 'deliver' || firstDelivery) recordLoopMetric({
    kind: LOOP_METRIC_KINDS.LANE_IDLE_WAKE, sessionId: lane,
    meta: {
      phase: 'delivery',
      outcome: verdict.action === 'suppress' ? 'suppressed' : verdict.action === 'defer' ? 'deferred' : 'delivered',
      ...(verdict.action !== 'deliver' ? { reason: verdict.reason } : {}),
      ...(verdict.action === 'defer' ? { until: verdict.until.toISOString() } : {}),
      ...(verdict.action === 'deliver' && verdict.prompt ? { newEpisode: true } : {}),
      ...(newestRunId ? { newestRunId } : {}),
      todoId,
    },
  });
  if (verdict.action === 'suppress') await releaseLaneIdleSlot(lane);
  else if (verdict.action === 'defer') await refreshLaneIdleSlot(lane, now);
  return firstDelivery && verdict.action === 'deliver' ? { ...verdict, deliveredAt: now.toISOString() } : verdict;
}
