/**
 * ALLCOMPLETE-CHARTER-TERMINATION (supervisor SOTA round 2, 2026-10-20 — stop
 * paying for firings on finished boards; continuous goal delivery).
 *
 * WHY: a RECURRING schedule firing on a lane whose plan board is already 100 %
 * complete only ever got an ADVISORY ([ALL-COMPLETE BOARD], schedule.service
 * allCompleteBoardNotice) and still ran the full loop — 245
 * schedule_allcomplete_firing rows in 7 days at ≈ $3.04 per coding run
 * (≈ $745 / week), each holding a worker slot that a lane with real work was
 * waiting for. The 2026-09-27 skip switch (SCHEDULE_ALL_COMPLETE_SKIP_ENABLED)
 * was deleted unused on 2026-10-08 (switch-registry ledger) — it skipped
 * blindly; this one reads the lane's CHARTER and its ledger first.
 *
 * At FIRE time, for a recurring schedule firing (origin 'schedule', never a
 * supervisor chat) whose plan board is all-complete AND unchanged since the
 * last firing (planUnchangedSinceLastFire):
 *   CHARTER DONE — the chat's charter todo is done / dropped / gone /
 *     reassigned and its charter goal holds no open todo assigned to this
 *     lane, or (goal-only charter) the charter goal is done / archived / gone:
 *     the lane's work is finished. Recorded as action 'would_retire' and the
 *     firing proceeds with today's advisory. Opt-in
 *     SCHEDULE_CHARTER_TERMINATION_ENFORCE=1 PAUSES the row instead
 *     (enabled:false, lastStatus 'paused:charter_done', cancelledBy 'machine'
 *     — never a cancel, one resume_schedule brings it back; the pause is a
 *     guarded write on a still-enabled row and only a write that landed is
 *     recorded 'retired', else 'retire_lost') and emits schedule_disabled
 *     reason 'charter_done' (alarm-class — the supervisor hears it). An OWNER
 *     row (promptSetBy 'user' / legacy NULL / ownerSubscribed) is never paused.
 *   CHARTER OPEN — at least one ACTIONABLE todo assigned to this lane
 *     (in_progress, or pending with no open dependency): the advisory is
 *     REPLACED by [RE-PLAN FROM CHARTER], which lists only those: write a new
 *     plan for the next one, never re-audit.
 *   CHARTER WAITING — open, but nothing the lane can execute (its charter
 *     work is blocked / dependency-waiting, or the charter todo is unassigned):
 *     today's advisory, never "execute" (review fix — the 7d7268fb phantom
 *     urged execution of owner-gated work), never a retire or an idle skip.
 *   NO CHARTER and an EMPTY lane ledger since the last firing (no owner /
 *     agent message in the lane, no open todo assigned to it, no goal / todo
 *     change in its project, no live run, no pending hook row aimed at it): the firing is
 *     SKIPPED ('skipped:all_complete_idle' — no run; the sweep refunds the
 *     daily-cap token) and the next firing is STRETCHED: delay =
 *     clamp(2 × time since the last REAL firing, interval, 24 h) — anchored on
 *     lastFiredAt (stamped only by a real start), so the backoff grows ~×3 per
 *     skip and resets on the next run. 1 in ALL_COMPLETE_IDLE_CONTROL_RATE (10)
 *     would-be skips FIRE as a labelled control (action 'idle_control'). The
 *     first skip of an episode tells the supervisor ONCE per 24 h per row (a
 *     quiet schedule_cap_skipped, payload kind 'all_complete_idle' — counted
 *     in the fleet-event rollup under its own key, never as a cap hit). Never
 *     skipped: owner rows, rows with a deltaGate / requiredProbes (they are
 *     REGISTERED polls with their own gate), lanes whose project holds a live
 *     watched resource, and anything the ledger read cannot answer.
 *
 * Every read fails toward FIRING with today's advisory (a skip / pause needs
 * positive evidence). Kill switch SCHEDULE_ALLCOMPLETE_IDLE_SKIP_DISABLED=1
 * (ops) restores the notice-only behaviour byte-for-byte (no charter read, no
 * re-plan, no skip, no would_retire row). Telemetry: the existing
 * loop_metrics `schedule_allcomplete_firing` row, meta.action now one of
 * notice | replan | would_retire | retire_requested | idle_skip | idle_control
 * (+ why, ownerRow, nextRunAt, control); an enforced retire adds a follow-up
 * row from the sweep: retired (the pause landed) | retire_lost (the row was
 * no longer enabled, or the write failed).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** SCHEDULE_ALLCOMPLETE_IDLE_SKIP_DISABLED=1 (ops) — the all-complete firing is advisory-only again (no charter read / re-plan / skip). Read per call. */
export function scheduleAllCompleteIdleSkipDisabled(): boolean {
  return onFlag(process.env.SCHEDULE_ALLCOMPLETE_IDLE_SKIP_DISABLED);
}

/** SCHEDULE_CHARTER_TERMINATION_ENFORCE=1 (opt-in) — a charter-done all-complete firing PAUSES its machine row instead of recording would_retire. Read per call. */
export function scheduleCharterTerminationEnforce(): boolean {
  return onFlag(process.env.SCHEDULE_CHARTER_TERMINATION_ENFORCE);
}

export const RE_PLAN_FROM_CHARTER_MARKER = '[RE-PLAN FROM CHARTER';
/** The schedule lastStatus of a row the charter termination paused. */
export const CHARTER_DONE_LAST_STATUS = 'paused:charter_done';
/** fireScheduleTarget reasons. */
export const ALL_COMPLETE_IDLE_SKIP_REASON = 'all_complete_idle';
export const CHARTER_DONE_SKIP_REASON = 'charter_done';
/** 1 in N would-be idle skips fires as a labelled control. */
export const ALL_COMPLETE_IDLE_CONTROL_RATE = 10;
/** The stretch never pushes a firing further out than this. */
export const ALL_COMPLETE_IDLE_MAX_DELAY_MS = 24 * 3_600_000;
const NOTICE_TTL_SEC = 24 * 3600;
const MIN_DELAY_MS = 60_000;

let controlSampler: () => number = Math.random;
/** Test hook: inject the control draw's random source (null restores Math.random). */
export function setAllCompleteControlSampler(fn: (() => number) | null): void { controlSampler = fn ?? Math.random; }

/** Draw the control sample: true ⇒ this would-be skip fires as a control. Pure apart from the sampler. */
export function drawAllCompleteControl(rate: number = ALL_COMPLETE_IDLE_CONTROL_RATE, rand: () => number = controlSampler): boolean {
  return rate > 0 && rand() < 1 / rate;
}

/** Pure: an owner row is never paused or skipped (owner-armed, legacy unstamped, or owner-subscribed). */
export function isOwnerScheduleRow(r: { promptSetBy?: string | null; ownerSubscribed?: boolean | null }): boolean {
  return r.ownerSubscribed === true || r.promptSetBy === 'user' || r.promptSetBy == null;
}

/**
 * Pure: the stretched delay of an idle skip — twice the time since the last
 * REAL firing, never under the row's interval, never over 24 h. A row that
 * never fired keeps its interval.
 */
export function allCompleteIdleDelayMs(o: { now: Date; lastFiredAt: Date | null; intervalSec: number | null }): number {
  const intervalMs = Math.max(MIN_DELAY_MS, Number(o.intervalSec ?? 0) * 1000 || MIN_DELAY_MS);
  const floor = Math.min(intervalMs, ALL_COMPLETE_IDLE_MAX_DELAY_MS);
  const last = o.lastFiredAt ? o.lastFiredAt.getTime() : NaN;
  if (!Number.isFinite(last)) return floor;
  const since = Math.max(0, o.now.getTime() - last);
  return Math.min(ALL_COMPLETE_IDLE_MAX_DELAY_MS, Math.max(floor, 2 * since));
}

/** A charter-goal todo as the verdict reads it; `openDeps` = its open (not done / dropped) dependencies. */
export interface CharterTodoRow { id: string; title: string; status: string; assigneeChatId?: string | null; openDeps?: number }
export type CharterVerdict =
  | { state: 'none' }
  | { state: 'done'; why: string }
  /** Open charter, but nothing the lane can execute now (blocked / dependency-waiting / unassigned): today's advisory. */
  | { state: 'waiting'; why: string; waitingTodos: CharterTodoRow[] }
  | { state: 'open'; why: string; openTodos: CharterTodoRow[] };

const TODO_CLOSED = new Set(['done', 'dropped']);
const GOAL_CLOSED = new Set(['done', 'archived']);

/** Pure: a todo the lane can EXECUTE now — assigned to it, in_progress, or pending with no open dependency. Blocked never is. */
export function isActionableCharterTodo(t: CharterTodoRow, laneChatId: string): boolean {
  if (t.assigneeChatId !== laneChatId) return false;
  return t.status === 'in_progress' || (t.status === 'pending' && !(Number(t.openDeps ?? 0) > 0));
}

/**
 * Pure: is the lane's charter finished? `todo` / `goal` are the charter rows
 * (null = the id is set but the row is gone — a deleted charter is finished);
 * `openTodos` are the charter goal's open (pending / in_progress / blocked)
 * todos; only those ASSIGNED TO THIS LANE count (an unassigned goal todo is
 * the supervisor's to dispatch — never this lane's to start). A charter todo
 * now assigned to ANOTHER lane is not this lane's open work.
 *
 * Review fix (2026-10-20): 'open' — the [RE-PLAN FROM CHARTER] notice that
 * says "execute" — needs at least one ACTIONABLE todo (in_progress, or pending
 * with no open dependency). A charter whose remaining work is all blocked /
 * dependency-waiting, or whose charter todo was unassigned, is 'waiting' (the
 * firing keeps today's plain advisory — never an urge to execute owner-gated
 * work, the 7d7268fb phantom shape) and is never retired.
 */
export function classifyCharter(o: {
  laneChatId: string;
  charterTodoId?: string | null;
  charterGoalId?: string | null;
  todo?: { status: string; assigneeChatId?: string | null; title?: string; openDeps?: number } | null;
  goal?: { status: string } | null;
  openTodos: CharterTodoRow[];
}): CharterVerdict {
  if (!o.charterTodoId && !o.charterGoalId) return { state: 'none' };
  const lane = o.laneChatId;
  const goalOpen = !!o.goal && !GOAL_CLOSED.has(String(o.goal.status));
  const charterRow: CharterTodoRow | null = o.charterTodoId && o.todo
    ? { id: o.charterTodoId, title: String(o.todo.title ?? ''), status: String(o.todo.status), assigneeChatId: o.todo.assigneeChatId ?? null, openDeps: o.todo.openDeps }
    : null;
  const charterOpen = !!charterRow && !TODO_CLOSED.has(charterRow.status);
  const goalRows = goalOpen
    ? o.openTodos.filter((t) => t.assigneeChatId === lane && !TODO_CLOSED.has(String(t.status)) && t.id !== o.charterTodoId)
    : [];
  const mine = [...(charterOpen && charterRow!.assigneeChatId === lane ? [charterRow!] : []), ...goalRows];
  const actionable = mine.filter((t) => isActionableCharterTodo(t, lane));
  const waiting = mine.filter((t) => !isActionableCharterTodo(t, lane));
  if (o.charterTodoId) {
    if (actionable.length) {
      const charterActionable = actionable.some((t) => t.id === o.charterTodoId);
      return { state: 'open', why: charterActionable ? `charter_todo_${charterRow!.status}` : 'charter_goal_has_open_todos', openTodos: actionable };
    }
    // The charter todo is still open for this lane (or unassigned — the supervisor's move): waiting, never done.
    if (charterOpen && (charterRow!.assigneeChatId === lane || !charterRow!.assigneeChatId)) {
      const why = !charterRow!.assigneeChatId ? 'charter_todo_unassigned'
        : charterRow!.status === 'pending' ? 'charter_todo_pending_deps' : `charter_todo_${charterRow!.status}`;
      return { state: 'waiting', why, waitingTodos: waiting };
    }
    if (waiting.length) return { state: 'waiting', why: 'charter_goal_todos_waiting', waitingTodos: waiting };
    const elsewhere = !!charterRow?.assigneeChatId && charterRow.assigneeChatId !== lane;
    return { state: 'done', why: !o.todo ? 'charter_todo_missing' : elsewhere ? 'charter_todo_reassigned' : `charter_todo_${o.todo.status}` };
  }
  if (!goalOpen) return { state: 'done', why: o.goal ? `charter_goal_${o.goal.status}` : 'charter_goal_missing' };
  if (actionable.length) return { state: 'open', why: `charter_goal_${o.goal!.status}`, openTodos: actionable };
  return { state: 'waiting', why: waiting.length ? 'charter_goal_todos_waiting' : 'charter_goal_nothing_assigned', waitingTodos: waiting };
}

const clip = (v: unknown, n: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Pure: the [RE-PLAN FROM CHARTER] notice that replaces the all-complete advisory while the charter is open. */
export function rePlanFromCharterNotice(o: {
  at: Date;
  steps: number;
  goal: { title: string; status: string } | null;
  todo: { title: string; status: string } | null;
  openTodos: CharterTodoRow[];
}): string {
  const charter = [
    o.goal ? `goal "${clip(o.goal.title, 80)}" (${o.goal.status})` : null,
    o.todo ? `todo "${clip(o.todo.title, 80)}" (${o.todo.status})` : null,
  ].filter(Boolean).join(', ') || 'your charter';
  // Only ACTIONABLE todos assigned to this lane ever reach this list (classifyCharter) — never a blocked,
  // dependency-waiting or unassigned one.
  const open = o.openTodos.slice(0, 6).map((t) => `${t.id.slice(0, 8)} "${clip(t.title, 70)}" (${t.status})`);
  const list = open.length
    ? `Actionable todo(s) assigned to this lane: ${open.join('; ')}${o.openTodos.length > open.length ? `; +${o.openTodos.length - open.length} more (todo_list)` : ''}.`
    : 'No actionable todo is assigned to you right now — report the charter\'s real state in ONE line; do not start unassigned work (your supervisor dispatches it).';
  return `${RE_PLAN_FROM_CHARTER_MARKER} — harness-verified at fire time ${o.at.toISOString()}] Your plan board (${o.steps} step(s)) is 100% complete and nothing on it changed since the last firing, but your charter is still OPEN: ${charter}. ${list} `
    + 'Write a NEW plan (update_plan) for the next actionable item above and execute it — do not re-audit, re-probe or re-fold the finished board. '
    + 'If none of them can move now, mark what blocks each (todo_update status:\'blocked\' with a blockedReason) and answer in ONE line.';
}

/** The lane's charter verdict + the rows it read. THROWS on a DB error (the caller fires with the advisory). */
export async function readCharterVerdict(chat: { id: string; charterGoalId?: string | null; charterTodoId?: string | null }): Promise<{ verdict: CharterVerdict; goal: { title: string; status: string } | null; todo: { title: string; status: string } | null }> {
  if (!chat.charterTodoId && !chat.charterGoalId) return { verdict: { state: 'none' }, goal: null, todo: null };
  const todo = chat.charterTodoId
    ? await prisma.projectTodo.findUnique({ where: { id: chat.charterTodoId }, select: { title: true, status: true, goalId: true, assigneeChatId: true } })
    : null;
  const goalId = chat.charterGoalId || (todo as any)?.goalId || null;
  const goal = goalId ? await prisma.projectGoal.findUnique({ where: { id: goalId }, select: { title: true, status: true } }) : null;
  // Review fix: only the charter goal's todos ASSIGNED TO THIS LANE (an unassigned one is the supervisor's to dispatch).
  const goalTodos: CharterTodoRow[] = goalId
    ? await prisma.projectTodo.findMany({
      where: { goalId, status: { in: ['pending', 'in_progress', 'blocked'] }, assigneeChatId: chat.id },
      select: { id: true, title: true, status: true, assigneeChatId: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    })
    : [];
  // Open dependencies of every PENDING row (the charter todo included): a pending todo waiting on one is not actionable.
  const pendingIds = [...new Set([
    ...goalTodos.filter((t) => t.status === 'pending').map((t) => t.id),
    ...(chat.charterTodoId && todo && String(todo.status) === 'pending' ? [chat.charterTodoId] : []),
  ])];
  const openDeps = new Map<string, number>();
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
      const open = new Set(targets.filter((t) => !TODO_CLOSED.has(String(t.status))).map((t) => t.id));
      for (const d of deps) if (open.has(d.dependsOnTodoId)) openDeps.set(d.todoId, (openDeps.get(d.todoId) ?? 0) + 1);
    }
  }
  const openTodos = goalTodos.map((t) => ({ ...t, openDeps: openDeps.get(t.id) ?? 0 }));
  const charterTodo = todo
    ? { title: String(todo.title ?? ''), status: String(todo.status ?? ''), assigneeChatId: (todo as any).assigneeChatId ?? null, openDeps: chat.charterTodoId ? openDeps.get(chat.charterTodoId) ?? 0 : 0 }
    : null;
  return {
    verdict: classifyCharter({ laneChatId: chat.id, charterTodoId: chat.charterTodoId, charterGoalId: chat.charterGoalId, todo: charterTodo, goal, openTodos }),
    goal: goal ? { title: String(goal.title ?? ''), status: String(goal.status ?? '') } : null,
    todo: todo ? { title: String(todo.title ?? ''), status: String(todo.status ?? '') } : null,
  };
}

/**
 * Is the lane's ledger EMPTY since `since` (the last real firing)? false the
 * moment anything moved: an owner / agent message in the lane, a queued /
 * running run, an open todo assigned to it, a goal / todo change in its
 * project, a pending hook row aimed at it. THROWS on a DB error (the caller fires).
 */
export async function laneLedgerQuietSince(chat: { id: string; projectId?: string | null }, since: Date): Promise<{ quiet: boolean; why: string }> {
  const msgs = await prisma.$queryRawUnsafe<Array<{ n: number | bigint }>>(
    `SELECT COUNT(*)::int AS n FROM crossmodel_messages
      WHERE "chatId" = $1 AND role = 'user' AND "createdAt" > $2
        AND COALESCE(metadata->>'origin', '') IN ('', 'user', 'agent')`,
    chat.id, since,
  );
  if (Number((Array.isArray(msgs) && msgs[0]?.n) ?? 0) > 0) return { quiet: false, why: 'message' };
  const [live, assigned, wakes, todos, goals] = await Promise.all([
    prisma.agentRun.count({ where: { sessionId: chat.id, status: { in: ['queued', 'running'] } } }),
    prisma.projectTodo.count({ where: { assigneeChatId: chat.id, status: { in: ['pending', 'in_progress', 'blocked'] } } }),
    prisma.hookEvent.count({ where: { status: { in: ['pending', 'delivering'] }, hook: { targetChatId: chat.id, enabled: true } } }),
    chat.projectId ? prisma.projectTodo.count({ where: { projectId: chat.projectId, updatedAt: { gt: since } } }) : Promise.resolve(0),
    chat.projectId ? prisma.projectGoal.count({ where: { projectId: chat.projectId, updatedAt: { gt: since } } }) : Promise.resolve(0),
  ]);
  if (Number(live) > 0) return { quiet: false, why: 'live_run' };
  if (Number(assigned) > 0) return { quiet: false, why: 'assigned_todo' };
  if (Number(wakes) > 0) return { quiet: false, why: 'pending_wake' };
  if (Number(todos) + Number(goals) > 0) return { quiet: false, why: 'board_changed' };
  return { quiet: true, why: 'quiet' };
}

/** A registered poll (own gate) or a project clock the lane may watch: never idle-skipped. THROWS on a DB error. */
async function registeredPoll(scheduleId: string, projectId: string | null | undefined, now: Date): Promise<string | null> {
  const row = await prisma.codingSchedule.findUnique({ where: { id: scheduleId }, select: { deltaGate: true, requiredProbes: true } });
  if (row && ((row as any).deltaGate != null || (row as any).requiredProbes != null)) return 'registered_gate';
  if (projectId) {
    const live = await prisma.watchedResource.count({ where: { projectId, OR: [{ reservationEndsAt: null }, { reservationEndsAt: { gt: now } }] } });
    if (Number(live) > 0) return 'watched_resource';
  }
  return null;
}

export type AllCompleteDecision =
  | { action: 'notice'; why: string }
  | { action: 'replan'; why: string; notice: string; openTodos: number }
  | { action: 'would_retire'; why: string; ownerRow: boolean }
  | { action: 'retire'; why: string }
  | { action: 'idle_skip'; why: string; nextRunAt: Date; delayMs: number }
  | { action: 'idle_control'; why: string };

/**
 * The fire-time decision for a recurring firing on an all-complete board that
 * did not change since the last firing. Never throws — any read error answers
 * { action:'notice' } (today's advisory; the firing proceeds).
 */
export async function decideAllCompleteFiring(o: {
  scheduleId: string;
  sessionId: string;
  promptSetBy: string | null;
  ownerSubscribed: boolean | null;
  lastFiredAt: Date | null;
  intervalSec: number | null;
  steps: number;
  now: Date;
}): Promise<AllCompleteDecision> {
  if (scheduleAllCompleteIdleSkipDisabled()) return { action: 'notice', why: 'disabled' };
  try {
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: o.sessionId },
      select: { id: true, projectId: true, charterGoalId: true, charterTodoId: true, isSupervisor: true, isProjectSupervisor: true },
    });
    if (!chat) return { action: 'notice', why: 'no_chat' };
    if (chat.isSupervisor || chat.isProjectSupervisor) return { action: 'notice', why: 'supervisor' };
    const ownerRow = isOwnerScheduleRow(o);
    const charter = await readCharterVerdict(chat);
    if (charter.verdict.state === 'done') {
      if (ownerRow) return { action: 'would_retire', why: charter.verdict.why, ownerRow: true };
      return scheduleCharterTerminationEnforce()
        ? { action: 'retire', why: charter.verdict.why }
        : { action: 'would_retire', why: charter.verdict.why, ownerRow: false };
    }
    if (charter.verdict.state === 'open') {
      return {
        action: 'replan', why: charter.verdict.why, openTodos: charter.verdict.openTodos.length,
        notice: rePlanFromCharterNotice({ at: o.now, steps: o.steps, goal: charter.goal, todo: charter.todo, openTodos: charter.verdict.openTodos }),
      };
    }
    // An open charter with nothing actionable for the lane (blocked / dependency-waiting / unassigned):
    // today's plain advisory — never "execute", never a retire, never an idle skip.
    if (charter.verdict.state === 'waiting') return { action: 'notice', why: `charter_waiting:${charter.verdict.why}` };
    if (ownerRow) return { action: 'notice', why: 'owner_row' };
    if (!o.lastFiredAt) return { action: 'notice', why: 'never_fired' };
    const poll = await registeredPoll(o.scheduleId, chat.projectId, o.now);
    if (poll) return { action: 'notice', why: poll };
    const ledger = await laneLedgerQuietSince(chat, o.lastFiredAt);
    if (!ledger.quiet) return { action: 'notice', why: ledger.why };
    if (drawAllCompleteControl()) return { action: 'idle_control', why: 'control' };
    const delayMs = allCompleteIdleDelayMs({ now: o.now, lastFiredAt: o.lastFiredAt, intervalSec: o.intervalSec });
    return { action: 'idle_skip', why: 'quiet', nextRunAt: new Date(o.now.getTime() + delayMs), delayMs };
  } catch (err: any) {
    logger.warn(`allcomplete-charter: decision for schedule ${o.scheduleId} failed (the firing proceeds with the advisory): ${err?.message ?? err}`);
    return { action: 'notice', why: 'error' };
  }
}

/**
 * The supervisor notice of an idle-skip episode: ONE quiet schedule_cap_skipped
 * per row per 24 h (Redis SET NX; a Redis failure sends nothing — the skip row
 * and the board still show it). Never throws.
 */
export async function noticeAllCompleteIdleSkipOnce(s: { id: string; sessionId: string }, nextRunAt: Date): Promise<boolean> {
  try {
    const redis = (await import('../../../config/redis').catch(() => null))?.default;
    if (!redis) return false;
    const claimed = await redis.set(`cm:sched:allcomplete-idle:${s.id}`, '1', { NX: true, EX: NOTICE_TTL_SEC }).catch(() => null);
    if (claimed !== 'OK') return false;
    const { emitHookEventSafe } = await import('../platform/hooks.service');
    await emitHookEventSafe(
      s.sessionId, 'schedule_cap_skipped',
      `Schedule ${s.id} idle-skipped: its lane's plan board is 100% complete, nothing on it or in the lane's ledger changed since the last firing, and the lane has no charter — the harness skipped the firing instead of paying for an audit-only run and stretched the next one to ${nextRunAt.toISOString()} (≤ 24 h; 1 in ${ALL_COMPLETE_IDLE_CONTROL_RATE} skips still fires as a control). If this lane polls something external, register it (a delta gate on the schedule, or a watched resource) or give it a charter todo; otherwise let it rest or cancel it. (Further skips of this row are muted for 24 h.)`,
      { scheduleId: s.id, kind: 'all_complete_idle', nextRunAt: nextRunAt.toISOString() } as any,
    );
    return true;
  } catch {
    return false;
  }
}
