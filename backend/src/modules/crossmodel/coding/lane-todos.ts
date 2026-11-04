/**
 * LANE TODOS at run start / run end (audit 2026-10-06, team T7 items 1, 9, 10).
 *
 * Three harness decisions share one read — the todos ASSIGNED to a lane chat:
 *
 *  T7-1 (stanne.md #4): the A4 machine-firing effort step-down
 *       (machine-firing-effort.ts) dropped a brand-new 4.5-h build to 'high'
 *       because the PREVIOUS run's plan board was all-complete. A firing that
 *       starts NEW work — its prompt names a todo, or the lane holds an
 *       actionable assigned todo — is not a cadence tick on a finished board.
 *  T7-9 (stanne.md #12): assigned todos were worked for hours while still
 *       'pending' (startedAt NULL) — the board, the brief and the supervisor
 *       read stale state. A lane run that starts on its CHARTER todo, or on a
 *       pending todo its prompt names, promotes it to in_progress through the
 *       goals service (updateTodo — the startedAt stamp + 'todo.update' audit
 *       with the acting chat / run).
 *  T7-10 (stanne.md #13): a lane that finishes a run with more pending,
 *       dependency-free todos assigned to it and no schedule / nothing queued
 *       went deaf until a supervisor hand-armed a one-shot per todo. The
 *       harness now wakes it for the next one through the same durable
 *       direct-wake outbox the todo_wake uses (hooks.service enqueueDirectWake),
 *       capped per lane per day and once per todo per 6 h.
 *
 * Every read fails open (no todo ⇒ today's behaviour). Kill switches, read per
 * call: MACHINE_FIRING_NEW_WORK_DISABLED (T7-1), LANE_TODO_AUTOPROMOTE_DISABLED
 * (T7-9), LANE_TODO_CONTINUATION_DISABLED (T7-10; cap LANE_TODO_CONTINUATION_MAX_PER_DAY,
 * default 6).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric } from '../platform/loop-metrics.service';
import { laneIdleWakeDisabled, LANE_TODO_SCHEDULED_HORIZON_MS } from './lane-idle';
// GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20): the continuation starts the todo of the
// highest-SCORED goal (P1..P4 + accrual), not the oldest (pure leaf).
import { goalPriorityOrderDisabled, pickHighestScoredTodo, goalPriorityLabel, type ScorableGoal } from '../platform/goal-priority';

function envOn(name: string): boolean {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
export function machineFiringNewWorkDisabled(): boolean { return envOn('MACHINE_FIRING_NEW_WORK_DISABLED'); }
export function laneTodoAutopromoteDisabled(): boolean { return envOn('LANE_TODO_AUTOPROMOTE_DISABLED'); }
export function laneTodoContinuationDisabled(): boolean { return envOn('LANE_TODO_CONTINUATION_DISABLED'); }
export function laneTodoContinuationMaxPerDay(): number {
  const n = Number(process.env.LANE_TODO_CONTINUATION_MAX_PER_DAY);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 6;
}

export interface LaneTodo {
  id: string;
  title: string;
  status: string;
  goalId: string;
  projectId: string;
  /** Open (not done / dropped) dependency edges. */
  openDeps: number;
}

/** pending + in_progress todos assigned to this chat (blocked / done / dropped excluded), with open-dependency counts. Never throws. */
export async function listLaneTodos(chatId: string): Promise<LaneTodo[]> {
  try {
    const rows: Array<{ id: string; title: string; status: string; goalId: string; projectId: string }> = await prisma.projectTodo.findMany({
      where: { assigneeChatId: chatId, status: { in: ['pending', 'in_progress'] } },
      select: { id: true, title: true, status: true, goalId: true, projectId: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    if (!rows.length) return [];
    const deps: Array<{ todoId: string; dependsOnTodoId: string }> = await prisma.todoDependency.findMany({
      where: { todoId: { in: rows.map((r) => r.id) } },
      select: { todoId: true, dependsOnTodoId: true },
    }).catch(() => []);
    let open = new Set<string>();
    if (deps.length) {
      const targets: Array<{ id: string; status: string }> = await prisma.projectTodo.findMany({
        where: { id: { in: Array.from(new Set(deps.map((d) => d.dependsOnTodoId))) } },
        select: { id: true, status: true },
      }).catch(() => []);
      open = new Set(targets.filter((t) => t.status !== 'done' && t.status !== 'dropped').map((t) => t.id));
    }
    return rows.map((r) => ({ ...r, openDeps: deps.filter((d) => d.todoId === r.id && open.has(d.dependsOnTodoId)).length }));
  } catch {
    return [];
  }
}

/** The todo_wake / lane-continuation header names the todo by TITLE (`Todo: "<title>"`) — pure. */
export function todoWakeTitle(text: string | null | undefined): string | null {
  const m = String(text ?? '').match(/\[Fleet goal board[^\]\n]*\][^\n]*\n\s*Todo:\s*"([^"\n]{1,300})"/);
  return m ? m[1] : null;
}

/** Hex id prefixes (≥ 8) the text puts next to the word "todo" — pure. */
export function todoIdRefsInText(text: string | null | undefined): string[] {
  const out: string[] = [];
  const re = /\btodos?\b[^\n]{0,24}?\b([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}(?:-[0-9a-f]{12})?)\b/gi;
  let m: RegExpExecArray | null;
  const t = String(text ?? '');
  while ((m = re.exec(t))) {
    const id = m[1].toLowerCase();
    if (!out.includes(id)) out.push(id);
    if (out.length >= 10) break;
  }
  return out;
}

/** The lane's todos the prompt names (an id prefix or the todo-wake title) — pure. */
export function todosNamedInPrompt(todos: LaneTodo[], text: string | null | undefined): LaneTodo[] {
  const refs = todoIdRefsInText(text);
  const title = todoWakeTitle(text);
  return todos.filter((t) => refs.some((r) => t.id.toLowerCase().startsWith(r)) || (title !== null && t.title === title));
}

// ── T7-1: does this machine firing start NEW work? ──────────────────────────

/**
 * True when the lane holds an actionable (pending / in_progress, no open
 * dependency) assigned todo, or the firing prompt names a todo of this lane.
 * Fails CLOSED to false (= today's step-down) on a read error — the decision
 * it feeds only ever raises the effort back to the seat's own.
 */
export async function firingStartsNewWork(chatId: string, prompt: string | null | undefined): Promise<{ newWork: boolean; todoIds: string[] }> {
  const todos = await listLaneTodos(chatId);
  const named = todosNamedInPrompt(todos, prompt);
  const actionable = todos.filter((t) => t.openDeps === 0);
  const hit = named.length ? named : actionable;
  return { newWork: hit.length > 0, todoIds: hit.map((t) => t.id.slice(0, 8)) };
}

// ── T7-9: promote the todo a run starts on ──────────────────────────────────

/**
 * At run start: the lane's CHARTER todo (crossmodel_chats.charterTodoId) and
 * any PENDING todo of this lane the run's prompt names → in_progress via
 * goals.service updateTodo (stamps startedAt once; audits 'todo.update' with
 * the acting chat + run). Blocked / done / dropped / other lanes' todos are
 * never touched; a todo with an open dependency is never started. Never throws.
 */
export async function promoteLaneTodosAtRunStart(o: { chatId: string; userId: string; runId: string; prompt: string | null | undefined; machineTriggered: boolean }): Promise<string[]> {
  if (laneTodoAutopromoteDisabled()) return [];
  try {
    const todos = (await listLaneTodos(o.chatId)).filter((t) => t.status === 'pending' && t.openDeps === 0);
    const chat = await prisma.crossModelChat.findUnique({ where: { id: o.chatId }, select: { charterTodoId: true, charterGoalId: true, isSupervisor: true, isProjectSupervisor: true } }).catch(() => null) as { charterTodoId?: string | null; charterGoalId?: string | null; isSupervisor?: boolean; isProjectSupervisor?: boolean } | null;
    // audit 2026-10-08 W5-4: an UNASSIGNED pending todo of the lane's charter goal that the prompt names is the lane's
    // work too — it is assigned to the lane as it starts (LANE_TODO_PLAN_RECONCILE_DISABLED=1: assigned todos only).
    const unassignedNamed: Array<LaneTodo & { assign?: true }> = [];
    if (!laneTodoPlanReconcileDisabled() && chat?.charterGoalId && !chat.isSupervisor && !chat.isProjectSupervisor) {
      const goalTodos = (await listLaneCandidateTodos(o.chatId, chat.charterGoalId)).filter((t) => !t.assigneeChatId && t.status === 'pending' && t.openDeps === 0);
      for (const t of todosNamedInPrompt(goalTodos, o.prompt)) unassignedNamed.push({ ...t, assign: true });
    }
    if (!todos.length && !unassignedNamed.length) return [];
    const charter = chat?.charterTodoId ? todos.filter((t) => t.id === chat.charterTodoId) : [];
    const named = todosNamedInPrompt(todos, o.prompt);
    const pick = Array.from(new Map<string, LaneTodo & { assign?: true }>([...charter, ...named, ...unassignedNamed].map((t) => [t.id, t])).values()).slice(0, 3);
    if (!pick.length) return [];
    const { updateTodo } = await import('../platform/goals.service');
    const promoted: string[] = [];
    for (const t of pick) {
      try {
        await updateTodo({
          userId: o.userId, todoId: t.id, status: 'in_progress',
          ...(t.assign ? { assigneeChatId: o.chatId } : {}),
          machineTriggered: o.machineTriggered, actingChatId: o.chatId, actingRunId: o.runId,
        });
        promoted.push(t.id);
        if (t.assign) void import('../platform/session-titles').then((m) => m.bindCharter(o.chatId, { goalId: t.goalId, todoId: t.id }, { reason: 'todo' })).catch(() => {});
        recordLoopMetric({
          kind: 'lane_todo_autopromote', sessionId: o.chatId, runId: o.runId,
          meta: { todoId: t.id, source: charter.some((c) => c.id === t.id) ? 'charter' : t.assign ? 'prompt_goal_unassigned' : 'prompt', machine: o.machineTriggered },
        });
      } catch (err: any) {
        logger.warn(`lane-todos: auto-promote of todo ${t.id.slice(0, 8)} on ${o.chatId.slice(0, 8)} failed (non-fatal): ${err?.message ?? err}`);
      }
    }
    return promoted;
  } catch {
    return [];
  }
}

// ── T7-10: start the next todo when a lane goes idle ────────────────────────

export const LANE_TODO_REWAKE_TTL_SEC = 6 * 3600;

/** The lane-continuation wake prompt (the todo_wake 'assigned' shape — re-read first, act on CURRENT state). Pure. */
export function laneTodoContinuationPrompt(todo: { title: string }, goalTitle: string | null, remaining: number, nowIso: string): string {
  return `[Fleet goal board — this lane finished its run with ${remaining} pending todo(s) still assigned to it and nothing scheduled]\n`
    + `Todo: "${todo.title}"\nGoal: "${goalTitle ?? 'unknown goal'}"\n`
    + `(Transition: lane idle with assigned work — the harness started the next dependency-free todo; wake sent ${nowIso}.)\n\n`
    + 'Re-read this todo with todo_get FIRST and act only on its CURRENT state: if it still reads actionable (pending/in_progress, '
    + 'assigned to this chat, not blocked), START it now — execution, not a status audit. If it now reads blocked/done/dropped or '
    + 'assigned elsewhere, do NOT start it. If a real blocker remains, set the todo to blocked with a blockedReason naming exactly what you need.';
}

export type LaneContinuationOutcome = 'started' | 'disabled' | 'no_todo' | 'scheduled' | 'queued' | 'capped' | 'recent' | 'enqueue_failed' | 'error';

/**
 * GOAL-PRIORITY-SPEND (2026-10-20): which of the lane's actionable todos the
 * continuation starts — the one whose GOAL scores highest (goal-priority.ts:
 * owner-set P1..P4 first, then due / age / KPI-gap / unblock accrual; ties
 * keep FIFO). Before this the oldest todo always went first, whatever the
 * owner valued. One goal read; a read error (or GOAL_PRIORITY_ORDER_DISABLED=1)
 * ⇒ the oldest todo (`todos[0]`, today's pick). Never throws.
 */
export async function pickNextLaneTodo(todos: LaneTodo[], now: Date = new Date()): Promise<{ todo: LaneTodo; pickedBy: 'score' | 'fifo'; score: number | null; priority: string | null }> {
  const fifo = { todo: todos[0], pickedBy: 'fifo' as const, score: null, priority: null };
  if (todos.length <= 1 || goalPriorityOrderDisabled()) return fifo;
  try {
    const rows = ((await (prisma.projectGoal as any).findMany({
      where: { id: { in: [...new Set(todos.map((t) => t.goalId))] } },
      select: { id: true, priority: true, prioritySource: true, dueAt: true, createdAt: true, premises: true, status: true },
    })) ?? []) as ScorableGoal[];
    const byId = new Map<string, ScorableGoal>(rows.map((g) => [String(g.id), g]));
    const best = pickHighestScoredTodo(todos, byId, { now: now.getTime() });
    if (!best) return fifo;
    return { todo: best.todo, pickedBy: 'score', score: best.score, priority: goalPriorityLabel(byId.get(best.todo.goalId)?.priority) };
  } catch {
    return fifo;
  }
}

/**
 * At run end (a COMPLETED run of a lane — never a supervisor): when the lane
 * still holds a pending, dependency-free assigned todo, has no enabled
 * schedule due within 30 min (LANE-IDLE-WAKE 2026-10-20; any enabled schedule
 * under LANE_IDLE_WAKE_DISABLED=1) and nothing queued, enqueue ONE durable wake for the
 * highest-scored such todo (pickNextLaneTodo — GOAL-PRIORITY-SPEND 2026-10-20; the
 * oldest under GOAL_PRIORITY_ORDER_DISABLED=1). Bounded: LANE_TODO_CONTINUATION_MAX_PER_DAY
 * wakes per lane per UTC day and one per todo per 6 h (Redis; a Redis failure starts nothing). One
 * loop_metrics `lane_todo_continuation` row per decision that found a todo.
 * Never throws.
 */
export async function maybeStartNextLaneTodo(o: { chatId: string; userId: string; runId: string; now?: Date }): Promise<LaneContinuationOutcome> {
  if (laneTodoContinuationDisabled()) return 'disabled';
  const record = (outcome: LaneContinuationOutcome, meta: Record<string, unknown> = {}): LaneContinuationOutcome => {
    recordLoopMetric({ kind: 'lane_todo_continuation', sessionId: o.chatId, runId: o.runId, meta: { outcome, ...meta } });
    return outcome;
  };
  try {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: o.chatId }, select: { isSupervisor: true, isProjectSupervisor: true, archivedAt: true } }).catch(() => null);
    if (!chat || chat.isSupervisor || chat.isProjectSupervisor || chat.archivedAt) return 'no_todo';
    const todos = (await listLaneTodos(o.chatId)).filter((t) => t.status === 'pending' && t.openDeps === 0);
    if (!todos.length) return 'no_todo';
    const pick = await pickNextLaneTodo(todos, o.now ?? new Date());
    const next = pick.todo;
    // LANE-IDLE-WAKE (2026-10-20, coding/lane-idle.ts): only a schedule due within LANE_TODO_SCHEDULED_HORIZON_MS
    // (30 min) means "the lane is scheduled" — a check armed for tomorrow left the next todo idle all day.
    // LANE_IDLE_WAKE_DISABLED=1 restores "any enabled schedule".
    const dueSoon = laneIdleWakeDisabled() ? {} : { nextRunAt: { lte: new Date((o.now ?? new Date()).getTime() + LANE_TODO_SCHEDULED_HORIZON_MS) } };
    const scheduled = await prisma.codingSchedule.count({ where: { sessionId: o.chatId, enabled: true, ...dueSoon } }).catch(() => 1);
    if (scheduled > 0) return record('scheduled', { todoId: next.id });
    const queued = await prisma.agentRun.count({ where: { sessionId: o.chatId, status: { in: ['queued', 'running'] }, NOT: { id: o.runId } } }).catch(() => 1);
    if (queued > 0) return record('queued', { todoId: next.id });
    const redis = (await import('../../../config/redis').catch(() => null))?.default;
    if (!redis) return record('error', { todoId: next.id, detail: 'no redis' });
    const day = (o.now ?? new Date()).toISOString().slice(0, 10);
    const perTodo = await redis.set(`lane-todo-cont:todo:${next.id}`, '1', { NX: true, EX: LANE_TODO_REWAKE_TTL_SEC }).catch(() => null);
    if (perTodo !== 'OK') return record('recent', { todoId: next.id });
    const dayKey = `lane-todo-cont:day:${o.chatId}:${day}`;
    const n = Number(await redis.incr(dayKey).catch(() => Number.POSITIVE_INFINITY));
    if (n === 1) await redis.expire(dayKey, 26 * 3600).catch(() => undefined);
    if (!Number.isFinite(n) || n > laneTodoContinuationMaxPerDay()) {
      await redis.del(`lane-todo-cont:todo:${next.id}`).catch(() => undefined);
      return record('capped', { todoId: next.id, count: Number.isFinite(n) ? n : null, cap: laneTodoContinuationMaxPerDay() });
    }
    const goal = await prisma.projectGoal.findUnique({ where: { id: next.goalId }, select: { title: true } }).catch(() => null);
    const { enqueueDirectWake } = await import('../platform/hooks.service');
    const res = await enqueueDirectWake({
      targetChatId: o.chatId,
      prompt: laneTodoContinuationPrompt(next, goal?.title ?? null, todos.length, (o.now ?? new Date()).toISOString()),
      meta: { todoId: next.id, goalId: next.goalId, trigger: 'lane_idle' },
    });
    if (!res.ok) {
      await redis.del(`lane-todo-cont:todo:${next.id}`).catch(() => undefined);
      return record('enqueue_failed', { todoId: next.id, error: String(res.error ?? '').slice(0, 120) });
    }
    return record('started', {
      todoId: next.id, remaining: todos.length, hookEventId: res.hookEventId ?? null, count: n,
      // GOAL-PRIORITY-SPEND: how the todo was chosen (score / fifo) — the ordering's evidence row.
      pickedBy: pick.pickedBy, ...(pick.score !== null ? { score: pick.score, priority: pick.priority, oldestTodoId: todos[0].id } : {}),
    });
  } catch (err: any) {
    logger.warn(`lane-todos: next-todo continuation for ${o.chatId.slice(0, 8)} failed (non-fatal): ${err?.message ?? err}`);
    return 'error';
  }
}

// ── audit 2026-10-08 W5-4: the todo a lane actually WORKS ───────────────────
//
// goals.md F6: goal-bound lanes worked todos that were NOT assigned to them —
// lane 3532d1ad (spawned with charterGoalId only) wrote "Implement chat mobile
// fixes (todo 5ca3996f)" / "(todo e07c8bd2)" / "(todo de893432)" into its plan
// and worked them for two hours while the board read them pending /
// unassigned; all three closed in one burst at the end (11 of 27 closed todos
// in the window went pending→done without ever starting). Auto-promote (T7-9)
// only ever looked at ASSIGNED todos, and nothing reconciled the board at run
// end: lane 7bd45d57 finished "Plan is 10/10 complete" with its assigned todo
// still in_progress for 2 h 47 m until a supervisor closed it from the relay.
//
// Now, on every update_plan and at the start of each run:
//  - the lane's CANDIDATE todos are the ones assigned to it plus the UNASSIGNED
//    todos of its charter goal (never another lane's, never blocked / done /
//    dropped);
//  - a plan step (text or note) NAMES a candidate by an id prefix (≥ 8 hex)
//    or by its full title (≥ 3 words);
//  - a named todo moves pending → in_progress (assigned to the lane when it had
//    no assignee) once a naming step is in_progress or completed.
//
// NEVER DONE FROM PLAN PROGRESS (mishap 260dd714, 2026-10-09): plan steps used
// to also close a named todo done once every naming step completed — but a step
// that NAMES a todo is not evidence its DELIVERABLE landed. Lane 0037460b's
// step 1 "re-read the todos a62eb6ce / 276c004d" (a bookkeeping re-read) closed
// both todos three times in 8 minutes, auto-completing goal a8c755c8 each time
// while the lane was mid-execution; every update_plan after a supervisor
// reopen re-fired the false close. A todo now reaches done ONLY through an
// explicit todo_update(status:'done', evidence) by the lane (the closing wake
// below asks for exactly that) or a human/supervisor close — plan shape alone
// never writes done.
// And at the end of a COMPLETED run whose plan was updated in that run and is
// all-complete (≥ 2 steps): open assigned todos get ONE cheap closing wake
// ("close each with evidence, or say what remains") instead of a guess — the
// harness never writes done from plan shape (mishap 260dd714). Kill switches:
// LANE_TODO_PLAN_RECONCILE_DISABLED=1 (plan
// naming + the unassigned-at-run-start promotion), LANE_TODO_PLAN_CLOSE_DISABLED=1
// (the run-end close / closing wake). Telemetry: loop_metrics
// lane_todo_plan_reconcile, lane_todo_plan_close.

export function laneTodoPlanReconcileDisabled(): boolean { return envOn('LANE_TODO_PLAN_RECONCILE_DISABLED'); }
export function laneTodoPlanCloseDisabled(): boolean { return envOn('LANE_TODO_PLAN_CLOSE_DISABLED'); }

export interface LaneCandidateTodo extends LaneTodo { assigneeChatId: string | null }

export interface PlanLike {
  goal?: string;
  updatedAt?: string;
  steps?: Array<{ id?: number; text?: string; status?: string; note?: string }>;
}

/** The lane's candidate todos: assigned to it, plus UNASSIGNED todos of its charter goal (pending / in_progress). Never throws. */
export async function listLaneCandidateTodos(chatId: string, charterGoalId: string | null | undefined): Promise<LaneCandidateTodo[]> {
  try {
    const rows: Array<{ id: string; title: string; status: string; goalId: string; projectId: string; assigneeChatId: string | null }> = await prisma.projectTodo.findMany({
      where: {
        status: { in: ['pending', 'in_progress'] },
        OR: [
          { assigneeChatId: chatId },
          ...(charterGoalId ? [{ goalId: charterGoalId, assigneeChatId: null }] : []),
        ],
      },
      select: { id: true, title: true, status: true, goalId: true, projectId: true, assigneeChatId: true },
      orderBy: { createdAt: 'asc' },
      take: 60,
    });
    if (!rows.length) return [];
    const deps: Array<{ todoId: string; dependsOnTodoId: string }> = await prisma.todoDependency.findMany({
      where: { todoId: { in: rows.map((r) => r.id) } },
      select: { todoId: true, dependsOnTodoId: true },
    }).catch(() => []);
    let open = new Set<string>();
    if (deps.length) {
      const targets: Array<{ id: string; status: string }> = await prisma.projectTodo.findMany({
        where: { id: { in: Array.from(new Set(deps.map((d) => d.dependsOnTodoId))) } },
        select: { id: true, status: true },
      }).catch(() => []);
      open = new Set(targets.filter((t) => t.status !== 'done' && t.status !== 'dropped').map((t) => t.id));
    }
    return rows.map((r) => ({ ...r, assigneeChatId: r.assigneeChatId ?? null, openDeps: deps.filter((d) => d.todoId === r.id && open.has(d.dependsOnTodoId)).length }));
  } catch {
    return [];
  }
}

const normTitle = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** The candidates a text NAMES: an id prefix (≥ 8 hex) of the todo, or its full normalized title (≥ 3 words). Pure. */
export function todosNamedInText<T extends { id: string; title: string }>(todos: ReadonlyArray<T>, text: unknown): T[] {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  const hexes = new Set<string>();
  for (const m of s.toLowerCase().matchAll(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}(?:-[0-9a-f]{12})?\b/g)) hexes.add(m[0]);
  const hay = ` ${normTitle(s)} `;
  return todos.filter((t) => {
    const id = t.id.toLowerCase();
    for (const h of hexes) if (id.startsWith(h)) return true;
    const title = normTitle(t.title);
    return title.split(' ').length >= 3 && hay.includes(` ${title} `);
  });
}

export interface PlanTodoTransition<T> { todo: T; target: 'in_progress'; stepIds: number[]; evidenceSteps: Array<{ id: number; text: string; note?: string }> }

/**
 * Per named todo: the plan steps naming it decide the move — any naming step
 * in_progress / completed ⇒ in_progress (only from pending). NEVER done: a
 * step that names a todo is not evidence its deliverable landed (mishap
 * 260dd714 — a "re-read the todos …" bookkeeping step closed them); done is
 * an explicit todo_update(done, evidence) by the lane (the closing wake asks
 * for exactly that). Pure.
 */
export function planTodoTransitions<T extends { id: string; title: string; status: string }>(todos: ReadonlyArray<T>, plan: PlanLike | null | undefined): Array<PlanTodoTransition<T>> {
  const steps = Array.isArray(plan?.steps) ? plan!.steps! : [];
  const out: Array<PlanTodoTransition<T>> = [];
  for (const t of todos) {
    const naming = steps.filter((st) => st && todosNamedInText([t], `${st.text ?? ''}\n${st.note ?? ''}`).length > 0);
    if (!naming.length) continue;
    const started = naming.some((st) => st.status === 'in_progress' || st.status === 'completed');
    const stepIds = naming.map((st) => Number(st.id ?? 0));
    const evidenceSteps = naming.map((st) => ({ id: Number(st.id ?? 0), text: String(st.text ?? ''), ...(st.note ? { note: String(st.note) } : {}) }));
    if (started && t.status === 'pending') out.push({ todo: t, target: 'in_progress', stepIds, evidenceSteps });
  }
  return out;
}

async function readLaneChat(chatId: string): Promise<{ charterGoalId: string | null; charterTodoId: string | null; supervisor: boolean; archived: boolean } | null> {
  const chat: any = await prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: { charterGoalId: true, charterTodoId: true, isSupervisor: true, isProjectSupervisor: true, archivedAt: true },
  }).catch(() => null);
  if (!chat) return null;
  return { charterGoalId: chat.charterGoalId ?? null, charterTodoId: chat.charterTodoId ?? null, supervisor: !!(chat.isSupervisor || chat.isProjectSupervisor), archived: !!chat.archivedAt };
}

/**
 * Apply the plan → todo moves for a lane (called after every update_plan and
 * at run end). Never throws; returns the todo ids moved.
 */
export async function reconcileLaneTodosFromPlan(o: { chatId: string; userId: string; runId?: string | null; plan: PlanLike | null | undefined; machineTriggered: boolean }): Promise<string[]> {
  if (laneTodoPlanReconcileDisabled() || !o.plan) return [];
  try {
    const chat = await readLaneChat(o.chatId);
    if (!chat || chat.supervisor) return [];
    const candidates = await listLaneCandidateTodos(o.chatId, chat.charterGoalId);
    if (!candidates.length) return [];
    const moves = planTodoTransitions(candidates, o.plan).slice(0, 5);
    if (!moves.length) return [];
    const { updateTodo } = await import('../platform/goals.service');
    const moved: string[] = [];
    for (const mv of moves) {
      const t = mv.todo;
      // An open dependency still holds the todo: never start it (and never close
      // it — there is no plan-driven close at all since mishap 260dd714).
      if (t.openDeps > 0) continue;
      const assign = !t.assigneeChatId;
      try {
        // Promotion ONLY (pending → in_progress): a plan step naming the todo is
        // evidence the lane WORKS it, never that its deliverable landed — done
        // is an explicit todo_update(done, evidence) by the lane (mishap 260dd714).
        await updateTodo({
          userId: o.userId, todoId: t.id, status: mv.target,
          ...(assign ? { assigneeChatId: o.chatId } : {}),
          machineTriggered: o.machineTriggered, actingChatId: o.chatId, ...(o.runId ? { actingRunId: o.runId } : {}),
        });
        moved.push(t.id);
        // A harness assignment binds the lane's charter like a tool assignment does (first bind, or a stale-charter rebind).
        if (assign) void import('../platform/session-titles').then((m) => m.bindCharter(o.chatId, { goalId: t.goalId, todoId: t.id }, { reason: 'todo' })).catch(() => {});
        recordLoopMetric({
          kind: 'lane_todo_plan_reconcile', sessionId: o.chatId, ...(o.runId ? { runId: o.runId } : {}),
          meta: { todoId: t.id, from: t.status, to: mv.target, assigned: assign, steps: mv.stepIds, machine: o.machineTriggered },
        });
      } catch (err: any) {
        logger.warn(`lane-todos: plan reconcile of todo ${t.id.slice(0, 8)} on ${o.chatId.slice(0, 8)} failed (non-fatal): ${err?.message ?? err}`);
      }
    }
    return moved;
  } catch {
    return [];
  }
}

export const LANE_TODO_CLOSE_WAKE_TTL_SEC = 6 * 3600;

/** The one cheap closing wake for several open assigned todos after an all-complete plan. Pure. */
export function laneTodoClosingPrompt(todos: Array<{ id: string; title: string; status: string }>, planDone: number, nowIso: string): string {
  return `[Fleet goal board — this lane finished its plan ${planDone}/${planDone} complete with ${todos.length} assigned todo(s) still open]\n`
    + todos.slice(0, 8).map((t) => `- todo ${t.id.slice(0, 8)} (${t.status}): "${t.title.slice(0, 160)}"`).join('\n')
    + `\n(Transition: run finished with an all-complete plan — the harness asks for the ledger to match; wake sent ${nowIso}.)\n\n`
    + 'ONE short turn, no new work: for EACH todo above, if the finished plan completed it, close it with todo_update status:"done" and evidence citing this run\'s receipt / commit / PR; if it is not finished, leave it open and say in one line what remains; if something blocks it, set status:"blocked" with the reason.';
}

export type LanePlanCloseOutcome = 'disabled' | 'no_plan' | 'plan_open' | 'stale_plan' | 'nothing_open' | 'pending_only' | 'wake_sent' | 'recent' | 'error';

/**
 * At the end of a COMPLETED lane run (never a supervisor): when the plan was
 * updated in this run and is all-complete (≥ 2 steps), reconcile the named
 * todos, then — with open assigned todos left — send ONE closing wake (once
 * per lane per 6 h) asking the lane to close each finished one explicitly
 * with todo_update(done, evidence). NEVER writes done itself (mishap 260dd714:
 * plan shape is not deliverable evidence — the harness used to close a lone
 * in-progress todo purely on plan shape). Never throws.
 */
export async function closeLaneTodosOnPlanComplete(o: { chatId: string; userId: string; runId: string; runStartedAt?: Date | null; now?: Date }): Promise<LanePlanCloseOutcome> {
  if (laneTodoPlanCloseDisabled()) return 'disabled';
  const record = (outcome: LanePlanCloseOutcome, meta: Record<string, unknown> = {}): LanePlanCloseOutcome => {
    recordLoopMetric({ kind: 'lane_todo_plan_close', sessionId: o.chatId, runId: o.runId, meta: { outcome, ...meta } });
    return outcome;
  };
  try {
    const chat = await readLaneChat(o.chatId);
    if (!chat || chat.supervisor || chat.archived) return 'nothing_open';
    const { getPlan } = await import('./plan.service');
    const plan = await getPlan(o.chatId);
    const steps = Array.isArray(plan?.steps) ? plan!.steps : [];
    if (steps.length < 2) return 'no_plan';
    if (!steps.every((s) => s.status === 'completed')) return 'plan_open';
    const updatedAt = Date.parse(String(plan?.updatedAt ?? ''));
    if (!o.runStartedAt || !Number.isFinite(updatedAt) || updatedAt < o.runStartedAt.getTime()) return 'stale_plan';
    await reconcileLaneTodosFromPlan({ chatId: o.chatId, userId: o.userId, runId: o.runId, plan, machineTriggered: true });
    const open = await listLaneTodos(o.chatId); // assigned pending + in_progress, re-read after the reconcile
    if (!open.length) return 'nothing_open';
    // Nothing in progress: the plan never started an assigned todo — the next-todo continuation (T7-10) owns that.
    if (!open.some((t) => t.status === 'in_progress')) return 'pending_only';
    // Open todos remain: ask, never guess — the harness never writes done from
    // plan shape (mishap 260dd714); the lane closes each with explicit
    // todo_update(done, evidence). In-progress todos listed first.
    const redis = (await import('../../../config/redis').catch(() => null))?.default;
    if (!redis) return record('error', { open: open.length, detail: 'no redis' });
    const once = await redis.set(`lane-todo-close:${o.chatId}`, '1', { NX: true, EX: LANE_TODO_CLOSE_WAKE_TTL_SEC }).catch(() => null);
    if (once !== 'OK') return record('recent', { open: open.length });
    const { enqueueDirectWake } = await import('../platform/hooks.service');
    const res = await enqueueDirectWake({
      targetChatId: o.chatId,
      prompt: laneTodoClosingPrompt([...open.filter((t) => t.status === 'in_progress'), ...open.filter((t) => t.status !== 'in_progress')], steps.length, (o.now ?? new Date()).toISOString()),
      meta: { todoIds: open.map((t) => t.id).slice(0, 8), trigger: 'plan_complete_open_todos' },
    });
    if (!res.ok) {
      await redis.del(`lane-todo-close:${o.chatId}`).catch(() => undefined);
      return record('error', { open: open.length, error: String(res.error ?? '').slice(0, 120) });
    }
    return record('wake_sent', { open: open.length, todoIds: open.map((t) => t.id.slice(0, 8)), hookEventId: res.hookEventId ?? null });
  } catch (err: any) {
    logger.warn(`lane-todos: plan-complete close for ${o.chatId.slice(0, 8)} failed (non-fatal): ${err?.message ?? err}`);
    return 'error';
  }
}
