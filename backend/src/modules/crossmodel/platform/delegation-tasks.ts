/**
 * The delegation task ledger — ONE task object for delegated work
 * (build 2026-10-08 D-1; architecture.md item B, stage 1 "Shadow").
 *
 * WHY. Digby delegates through 13 paths (start_coding_session, background
 * workers, ticket lanes, agent sends, schedules, continuations, …) with 19
 * status vocabularies, and the one shared abstraction — the task card — is
 * display-only. "Did my delegation finish?" is re-derived from receipts, hooks
 * and prose on every wake: get_chat_status + list_chats + get_chat_messages
 * are 31 % of all platform calls (7 d to 10-08), and four classes are lost on
 * a restart with no record at all (background workers, council / call_in,
 * wait_for_chat, in-flight late cross-checks).
 *
 * WHAT (written in shadow; read by the stage-2 tools below): a row per
 * delegated piece of work, written by the harness at seams that already exist,
 * with ONE A2A-shaped state vocabulary:
 *   submitted → working → input_required → completed | failed | canceled
 * (terminal states are IMMUTABLE — a later contrary signal is counted as a
 * `terminal_conflict`, never applied). The seams:
 *   create   start_coding_session (kind session) · an agent send to another
 *            chat that ASKS for work (message_ask — a report up to the
 *            sender's own supervisor / parent is not a task) · the legacy
 *            standing-lane dispatch_platform_task (message_ask) · a fresh
 *            ticket lane (ticket; a re-dispatch supersedes the old lane's
 *            task) · a background worker start (background_worker) · a
 *            schedule firing that started a run (schedule_firing) · a turn
 *            continuation's task card (continuation)
 *   move     the child chat's run start (submitted → working) and run outcome
 *            hook (run_completed / run_failed / attention_needed), the task
 *            card's lifecycle (persistTaskCard — the hand-off's artifacts ride
 *            it), the background pool's phases, the ticket drain's close /
 *            re-dispatch-exhausted passes.
 * Every map from an existing vocabulary into the ONE vocabulary is a pure
 * function below (fromRunStatus / fromHookEvent / fromTaskCardStatus /
 * fromBackgroundPhase / fromTicketStatus) so the reconcile and the writers
 * agree by construction.
 *
 * Read path today: the admin view (GET /admin/delegation-tasks) and the
 * nightly reconcile (platform/delegation-tasks-reconcile.ts — the shadow bar:
 * ≥ 99 % terminal-state agreement against agent_runs / tickets / the
 * background pool's own metric rows / the task cards, 0 rows missing a
 * parent). Stage 2 ON since build 2026-10-11 DL-1 (owner "turn everything
 * remaining on" — reconcile at 98.76 % / 0 missing parents on 10-10): the
 * model-facing task_get / task_list reads (platform/delegation-task-tools.ts,
 * DELEGATION_TASK_TOOLS_DISABLED) and the tool-intent act's in-flight lookup
 * (coding/tool-intents.ts — a task carrying a call's idempotency key proves
 * that spawn / ask applied). The W6 diff and the task card still read their
 * own sources; nothing here changes a state from a read.
 *
 * Every export NEVER throws and never delays its caller: writers are
 * fire-and-forget; transitions for one chat are serialized in-process so a
 * run's start always lands before its outcome. No FKs on the table: a write
 * must never fail on a deleted chat. Kill switch DELEGATION_TASKS_DISABLED=1
 * (no rows written; the readers still answer from what exists).
 * Telemetry: loop_metrics `delegation_task` { phase: created | skipped (a
 * report up — no row) | duplicate_key | terminal_conflict }; a transition's
 * record is the row itself (events / completedAt), never a metric row.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './loop-metrics.service';
import { isClosedTicketStatus } from '../feedback/ticket-status';

// ── Vocabulary ───────────────────────────────────────────────────────────────

export const DELEGATION_STATES = ['submitted', 'working', 'input_required', 'completed', 'failed', 'canceled'] as const;
export type DelegationState = typeof DELEGATION_STATES[number];

export const TERMINAL_DELEGATION_STATES: readonly DelegationState[] = ['completed', 'failed', 'canceled'];
const TERMINAL = new Set<string>(TERMINAL_DELEGATION_STATES);
const OPEN_STATES: readonly DelegationState[] = ['submitted', 'working', 'input_required'];

export const DELEGATION_KINDS = ['session', 'message_ask', 'ticket', 'background_worker', 'schedule_firing', 'continuation'] as const;
export type DelegationKind = typeof DELEGATION_KINDS[number];

/** Kinds whose completion IS the child chat's next run outcome. */
export const RUN_BOUND_KINDS: readonly DelegationKind[] = ['session', 'message_ask', 'schedule_firing'];

/** A task with no terminal state past this age is STALE (counted by the reconcile, shown in the admin view — never auto-failed in shadow). */
export const DELEGATION_STALE_AFTER_MS: Readonly<Record<DelegationKind, number>> = Object.freeze({
  session: 24 * 3_600_000,
  message_ask: 12 * 3_600_000,
  ticket: 72 * 3_600_000,
  background_worker: 6 * 3_600_000,
  schedule_firing: 6 * 3_600_000,
  continuation: 2 * 3_600_000,
});

/** Kinds that must name a parent chat (the reconcile's `missingParent` count). Tickets and schedule firings may come from no chat (a UI filing, a REST arm). */
export const PARENT_REQUIRED_KINDS: readonly DelegationKind[] = ['session', 'message_ask', 'background_worker', 'continuation'];

const MAX_EVENTS = 24;
const MAX_ARTIFACTS = 24;
const BRIEF_CHARS = 600;

export function delegationTasksDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.DELEGATION_TASKS_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export function isDelegationState(v: unknown): v is DelegationState {
  return typeof v === 'string' && (DELEGATION_STATES as readonly string[]).includes(v);
}

export function isTerminalDelegationState(v: unknown): boolean {
  return typeof v === 'string' && TERMINAL.has(v);
}

/** Pure: may a task move from → to? Terminal states are immutable; nothing moves back to submitted; a no-op is not a move. */
export function canTransitionDelegation(from: string, to: string): boolean {
  if (!isDelegationState(to) || from === to) return false;
  if (TERMINAL.has(from)) return false;
  if (to === 'submitted') return false;
  return true;
}

// ── The ONE vocabulary: maps from the existing ones (pure) ───────────────────

/** agent_runs.status → the vocabulary. 'interrupted' resumes, so it is still working. */
export function fromRunStatus(status: unknown): DelegationState | null {
  switch (String(status ?? '')) {
    case 'queued': return 'submitted';
    case 'running': case 'interrupted': return 'working';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': case 'canceled': return 'canceled';
    default: return null;
  }
}

/** hooks.service event types → the vocabulary (null = not a lifecycle event). */
export function fromHookEvent(eventType: unknown): DelegationState | null {
  switch (String(eventType ?? '')) {
    case 'run_completed': return 'completed';
    case 'run_failed': return 'failed';
    case 'attention_needed': return 'input_required';
    default: return null;
  }
}

/** The task card's status (chat-agent/task-events.ts TaskStatus) → the vocabulary. */
export function fromTaskCardStatus(status: unknown): DelegationState | null {
  switch (String(status ?? '')) {
    case 'running': return 'working';
    case 'done': return 'completed';
    case 'failed': return 'failed';
    case 'waiting_user': return 'input_required';
    default: return null;
  }
}

/** The background pool's lifecycle phases (coding/background-delegation.ts BackgroundPhase) → the vocabulary. */
export function fromBackgroundPhase(phase: unknown): DelegationState | null {
  switch (String(phase ?? '')) {
    case 'start': return 'working';
    case 'injected': case 'status': case 'posted_late': return 'completed';
    case 'cancelled': return 'canceled';
    case 'unposted': case 'lost_on_resume': return 'failed';
    default: return null;
  }
}

/** A ticket's status → completed when closed, else nothing (an open ticket says nothing about the lane). */
export function fromTicketStatus(status: unknown): DelegationState | null {
  return isClosedTicketStatus(status) ? 'completed' : null;
}

/**
 * Pure: is an agent send from `sender` to `target` a REPORT UP (no task) rather
 * than an ask? Up = to the Fleet Supervisor from anyone below it, to the
 * sender's own project supervisor from a lane of that project, or to the
 * sender's own parent chat. Everything else (down, sideways) asks for work.
 */
export function isReportUp(
  sender: { id: string; isSupervisor?: boolean | null; isProjectSupervisor?: boolean | null; projectId?: string | null; parentChatId?: string | null } | null | undefined,
  target: { id: string; isSupervisor?: boolean | null; isProjectSupervisor?: boolean | null; projectId?: string | null } | null | undefined,
): boolean {
  if (!sender || !target) return false;
  if (sender.id === target.id) return true; // a note to itself is no delegation
  if (target.isSupervisor && !sender.isSupervisor) return true;
  if (target.isProjectSupervisor && !sender.isSupervisor && !sender.isProjectSupervisor && !!sender.projectId && sender.projectId === target.projectId) return true;
  if (sender.parentChatId && sender.parentChatId === target.id) return true;
  return false;
}

export interface DelegationEvent { at: string; from: string | null; to: string; seam: string; ref?: string }

/** Pure: append one lifecycle event, keeping the first and the newest MAX_EVENTS - 1. */
export function appendDelegationEvent(events: unknown, ev: DelegationEvent): DelegationEvent[] {
  const list = Array.isArray(events) ? (events as DelegationEvent[]).filter((e) => e && typeof e === 'object') : [];
  const next = [...list, ev];
  return next.length <= MAX_EVENTS ? next : [next[0], ...next.slice(-(MAX_EVENTS - 1))];
}

export interface DelegationArtifact { kind: string; ref: string; name?: string }

/** Pure: merge artifact refs, deduped by kind + ref, capped. */
export function mergeDelegationArtifacts(existing: unknown, add: DelegationArtifact[] | undefined): DelegationArtifact[] {
  const base = Array.isArray(existing) ? (existing as DelegationArtifact[]).filter((a) => a && typeof a === 'object' && a.ref) : [];
  if (!add?.length) return base;
  const seen = new Set(base.map((a) => `${a.kind}\n${a.ref}`));
  const out = [...base];
  for (const a of add) {
    if (!a?.ref) continue;
    const k = `${a.kind}\n${a.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: String(a.kind || 'file'), ref: String(a.ref).slice(0, 300), ...(a.name ? { name: String(a.name).slice(0, 160) } : {}) });
  }
  return out.slice(0, MAX_ARTIFACTS);
}

// ── DB seam ──────────────────────────────────────────────────────────────────

// Untyped on purpose: the delegate exists once the build runs `prisma generate`
// against the new model; a client without it rejects and every writer swallows.
const db = (): any => (prisma as any).delegationTask;

function metric(meta: Record<string, unknown>, sessionId?: string | null, runId?: string | null): void {
  try {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.DELEGATION_TASK, ...(sessionId ? { sessionId } : {}), ...(runId ? { runId } : {}), meta });
  } catch { /* telemetry never breaks a seam */ }
}

function warn(where: string, err: unknown): void {
  try { logger.debug(`delegation-tasks: ${where} failed (shadow write, non-fatal): ${(err as any)?.message ?? err}`); } catch { /* never throws */ }
}

/** Per-key serial chains (in-process): a chat's run start always lands before its outcome; a worker's start before its report. */
const chains = new Map<string, Promise<unknown>>();
function serial(key: string, fn: () => Promise<unknown>): Promise<void> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn).then(() => undefined, (err) => { warn(`serial ${key.slice(0, 24)}`, err); });
  chains.set(key, next);
  void next.then(() => { if (chains.get(key) === next) chains.delete(key); });
  return next;
}

/** Test seam: settle every pending serial chain. */
export async function flushDelegationTaskWrites(): Promise<void> {
  for (let i = 0; i < 5 && chains.size; i++) await Promise.all([...chains.values()]);
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface NewDelegationTask {
  kind: DelegationKind;
  /** the seam: start_coding_session | send_chat_message | dispatch_platform_task | ticket_lane | delegate_background | schedule | turn_continuation */
  source: string;
  userId?: string | null;
  parentChatId?: string | null;
  parentRunId?: string | null;
  childChatId?: string | null;
  childRef?: string | null;
  projectId?: string | null;
  brief?: string | null;
  /** Explicit initial state; else derived from deliveredAs; else submitted. */
  state?: DelegationState;
  /** How the work was handed over: steer (into a running run ⇒ working), queued (behind a run ⇒ submitted),
   *  started (a new run — working on a plain chat, submitted on a coding session until the worker claims it). */
  deliveredAs?: 'started' | 'steer' | 'queued';
  origin?: 'user' | 'machine' | null;
  /** tool_intents.idemKey of the call that created it (ToolContext.intentKey). */
  idempotencyKey?: string | null;
  /** message_ask: skip a report up (isReportUp) — reads both chats. */
  skipIfReportUp?: boolean;
  /** ticket re-dispatch: the earlier lane's open task for the same ticket is canceled (reason superseded). */
  supersedesChildChatId?: string | null;
}

/** Awaitable core (tests + the serial chains). Returns the new row id, or null (skipped / off / failed). */
export async function createDelegationTask(t: NewDelegationTask): Promise<string | null> {
  if (delegationTasksDisabled()) return null;
  try {
    if (!(DELEGATION_KINDS as readonly string[]).includes(t.kind)) return null;
    const parentChatId = t.parentChatId || null;
    const childChatId = t.childChatId || null;
    if (parentChatId && /^(anon|chatless)-/.test(parentChatId)) return null;
    if (t.skipIfReportUp && parentChatId && childChatId) {
      if (parentChatId === childChatId) return null;
      const rows: Array<{ id: string; isSupervisor: boolean | null; isProjectSupervisor: boolean | null; projectId: string | null; parentChatId: string | null }> =
        await prisma.crossModelChat.findMany({
          where: { id: { in: [parentChatId, childChatId] } },
          select: { id: true, isSupervisor: true, isProjectSupervisor: true, projectId: true, parentChatId: true },
        });
      const sender = rows.find((r) => r.id === parentChatId);
      const target = rows.find((r) => r.id === childChatId);
      if (isReportUp(sender, target)) {
        metric({ phase: 'skipped', reason: 'report_up', kind: t.kind, source: t.source }, parentChatId, t.parentRunId);
        return null;
      }
    }
    let state: DelegationState = t.state ?? 'submitted';
    if (!t.state && t.deliveredAs) {
      if (t.deliveredAs === 'steer') state = 'working';
      else if (t.deliveredAs === 'queued') state = 'submitted';
      else {
        // started: a coding session's run is QUEUED for the worker (its claim moves it to working); a plain chat's run is running now.
        const coding = childChatId
          ? await prisma.chatCodingState.findUnique({ where: { id: childChatId }, select: { id: true } }).catch(() => null)
          : null;
        state = coding ? 'submitted' : 'working';
      }
    }
    let duplicateOfId: string | null = null;
    if (t.idempotencyKey) {
      const dup = await db().findFirst({ where: { idempotencyKey: t.idempotencyKey }, orderBy: { createdAt: 'asc' }, select: { id: true } }).catch(() => null);
      duplicateOfId = dup?.id ?? null;
    }
    const now = new Date();
    const row = await db().create({
      data: {
        kind: t.kind,
        source: String(t.source || 'unknown').slice(0, 64),
        state,
        userId: t.userId || null,
        parentChatId,
        parentRunId: t.parentRunId || null,
        childChatId,
        childRef: t.childRef ? String(t.childRef).slice(0, 200) : null,
        projectId: t.projectId && t.projectId !== 'chat' ? t.projectId : null,
        brief: t.brief ? String(t.brief).replace(/\s+/g, ' ').trim().slice(0, BRIEF_CHARS) : null,
        origin: t.origin ?? null,
        idempotencyKey: t.idempotencyKey || null,
        duplicateOfId,
        artifacts: [],
        events: [{ at: now.toISOString(), from: null, to: state, seam: String(t.source || 'unknown').slice(0, 64) }],
        staleAfter: new Date(now.getTime() + DELEGATION_STALE_AFTER_MS[t.kind]),
        lastEventAt: now,
      },
      select: { id: true },
    });
    const id: string | null = row?.id ?? null;
    if (!id) return null;
    metric({ phase: 'created', kind: t.kind, source: t.source, state, origin: t.origin ?? null, taskId: id }, parentChatId, t.parentRunId);
    if (duplicateOfId) metric({ phase: 'duplicate_key', kind: t.kind, source: t.source, taskId: id, duplicateOfId }, parentChatId, t.parentRunId);
    if (t.kind === 'ticket' && t.childRef && t.supersedesChildChatId && t.supersedesChildChatId !== childChatId) {
      await transitionTasks(
        { kind: 'ticket', childRef: String(t.childRef), childChatId: t.supersedesChildChatId, state: { in: OPEN_STATES as unknown as string[] }, id: { not: id } },
        'canceled', 'ticket_redispatch', { reason: 'superseded', ref: id },
      );
    }
    return id;
  } catch (err) {
    warn(`create ${t.kind}`, err);
    return null;
  }
}

/** Fire-and-forget create (the seams' entry). Serialized on the child chat so a run start / outcome for it orders after the row exists. */
export function recordDelegationTask(t: NewDelegationTask): void {
  if (delegationTasksDisabled()) return;
  const key = t.childChatId ? `chat:${t.childChatId}` : t.childRef ? `ref:${t.childRef}` : `create:${t.kind}`;
  void serial(key, () => createDelegationTask(t));
}

// ── Transitions ──────────────────────────────────────────────────────────────

interface TransitionPatch { resultRef?: string | null; reason?: string | null; ref?: string | null; artifacts?: DelegationArtifact[] }

/**
 * Move every matching task to `to` (guarded per row on its current state —
 * a racing writer wins once). Returns how many moved. Terminal rows never move;
 * a contrary terminal signal is a `terminal_conflict` row.
 */
async function transitionTasks(where: Record<string, unknown>, to: DelegationState, seam: string, patch: TransitionPatch = {}): Promise<number> {
  const rows: Array<{ id: string; state: string; kind: string; source: string; events: unknown; artifacts: unknown; parentChatId: string | null; parentRunId: string | null }> =
    await db().findMany({ where, select: { id: true, state: true, kind: true, source: true, events: true, artifacts: true, parentChatId: true, parentRunId: true }, take: 50 });
  let moved = 0;
  for (const r of rows) {
    if (!canTransitionDelegation(r.state, to)) {
      if (TERMINAL.has(r.state) && TERMINAL.has(to) && r.state !== to) {
        metric({ phase: 'terminal_conflict', kind: r.kind, source: r.source, from: r.state, to, seam, taskId: r.id }, r.parentChatId, r.parentRunId);
      }
      if (patch.artifacts?.length) {
        // A result's artifacts may land after the state did (the hand-off posts after the run outcome) — refs only, the state stays.
        await db().update({ where: { id: r.id }, data: { artifacts: mergeDelegationArtifacts(r.artifacts, patch.artifacts) } }).catch(() => undefined);
      }
      continue;
    }
    const now = new Date();
    const terminal = TERMINAL.has(to);
    const data: Record<string, unknown> = {
      state: to,
      lastEventAt: now,
      events: appendDelegationEvent(r.events, { at: now.toISOString(), from: r.state, to, seam: seam.slice(0, 64), ...(patch.ref ? { ref: String(patch.ref).slice(0, 80) } : {}) }),
      ...(terminal ? { completedAt: now } : {}),
      ...(patch.resultRef ? { resultRef: String(patch.resultRef).slice(0, 200) } : {}),
      ...(patch.reason ? { reason: String(patch.reason).slice(0, 120) } : {}),
      ...(patch.artifacts?.length ? { artifacts: mergeDelegationArtifacts(r.artifacts, patch.artifacts) } : {}),
    };
    // The table row IS the record of a transition (completedAt / events) — no metric row per move.
    const res = await db().updateMany({ where: { id: r.id, state: r.state }, data });
    if (res && Number(res.count) > 0) moved++;
  }
  return moved;
}

/** A chat's run STARTED (run-executor claim / the chat run's live-run claim): its submitted tasks are now being worked. */
export function noteChatRunStarted(chatId: string, runId?: string | null): void {
  if (delegationTasksDisabled() || !chatId) return;
  void serial(`chat:${chatId}`, () => transitionTasks(
    { childChatId: chatId, state: 'submitted', kind: { in: [...RUN_BOUND_KINDS, 'ticket'] } },
    'working', 'run_started', { ref: runId ?? null },
  ));
}

/**
 * A chat emitted a hook event (hooks.service emitHookEvent — every run outcome
 * of every chat passes there). run_completed / run_failed close the RUN-BOUND
 * tasks that were being worked (a task still `submitted` is queued for a LATER
 * run); attention_needed parks them on input_required; a ticket lane's task
 * closes only when its ticket is closed.
 */
export function noteChatRunEvent(chatId: string, eventType: string, runId?: string | null): void {
  if (delegationTasksDisabled() || !chatId) return;
  const to = fromHookEvent(eventType);
  if (!to) return;
  void serial(`chat:${chatId}`, async () => {
    const open: Array<{ id: string; kind: string; state: string; childRef: string | null }> = await db().findMany({
      where: { childChatId: chatId, state: { in: OPEN_STATES as unknown as string[] } },
      select: { id: true, kind: true, state: true, childRef: true },
      take: 50,
    });
    if (!open.length) return;
    if (to === 'input_required') {
      await transitionTasks({ childChatId: chatId, state: 'working', kind: { in: RUN_BOUND_KINDS as unknown as string[] } }, 'input_required', eventType, { ref: runId ?? null });
      return;
    }
    const runBound = open.filter((t) => (RUN_BOUND_KINDS as readonly string[]).includes(t.kind));
    if (runBound.length) {
      let target: DelegationState = to;
      // A worker run names its agent_runs row: a cancelled run is `canceled`, and a task still `submitted`
      // that was created BEFORE this run started was picked up by it (its start note lost a cross-process race).
      let run: { status: string; startedAt: Date | null; createdAt: Date } | null = null;
      if (runId && (to === 'failed' || runBound.some((t) => t.state === 'submitted'))) {
        run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true, startedAt: true, createdAt: true } }).catch(() => null);
      }
      if (to === 'failed' && fromRunStatus(run?.status) === 'canceled') target = 'canceled';
      const pickedUp: string[] = [];
      if (run && runBound.some((t) => t.state === 'submitted')) {
        const startedAt = run.startedAt ?? run.createdAt;
        const subs: Array<{ id: string; createdAt: Date }> = await db().findMany({
          where: { id: { in: runBound.filter((t) => t.state === 'submitted').map((t) => t.id) } },
          select: { id: true, createdAt: true },
        });
        for (const s of subs) if (new Date(s.createdAt).getTime() <= new Date(startedAt).getTime()) pickedUp.push(s.id);
      }
      await transitionTasks(
        {
          childChatId: chatId, kind: { in: RUN_BOUND_KINDS as unknown as string[] },
          OR: [{ state: { in: ['working', 'input_required'] } }, ...(pickedUp.length ? [{ id: { in: pickedUp } }] : [])],
        },
        target, eventType, { resultRef: runId ?? null, ref: runId ?? null },
      );
    }
    for (const t of open.filter((x) => x.kind === 'ticket' && x.childRef)) {
      const ticket = await prisma.userFeatureRequest.findUnique({ where: { id: String(t.childRef) }, select: { status: true } }).catch(() => null);
      if (fromTicketStatus(ticket?.status) === 'completed') {
        await transitionTasks({ id: t.id }, 'completed', 'ticket_closed', { resultRef: runId ?? null, ref: runId ?? null });
      }
    }
  });
}

/**
 * The task card's lifecycle (chat-agent/task-events.ts persistTaskCard — the
 * ONE place every card state is written): a SESSION card moves the spawn's
 * task (the hand-off's done card carries its artifacts); a CONTINUATION card
 * creates / moves its own task. The card is the record; this mirrors it.
 */
export function noteTaskCardLifecycle(chatId: string, payload: unknown): void {
  if (delegationTasksDisabled() || !chatId || !payload || typeof payload !== 'object') return;
  const p = payload as Record<string, any>;
  const to = fromTaskCardStatus(p.status);
  const taskId = typeof p.taskId === 'string' ? p.taskId : '';
  if (!to || !taskId) return;
  const artifacts: DelegationArtifact[] = (Array.isArray(p.artifacts) ? p.artifacts : [])
    .filter((a: any) => a && typeof a === 'object' && (a.url || a.name))
    .map((a: any) => ({ kind: String(a.kind || 'file'), ref: String(a.url || a.name), ...(a.name ? { name: String(a.name) } : {}) }));
  const resultRef = typeof p.resultMessageId === 'string' && p.resultMessageId ? p.resultMessageId : null;
  if (p.kind === 'session' && typeof p.childChatId === 'string' && p.childChatId) {
    const child = p.childChatId;
    void serial(`chat:${child}`, () => transitionTasks(
      { kind: 'session', childChatId: child },
      to, 'task_card', { resultRef, artifacts, ref: taskId },
    ));
    return;
  }
  if (p.kind === 'continuation') {
    void serial(`ref:${taskId}`, async () => {
      const existing = await db().findFirst({ where: { kind: 'continuation', childRef: taskId, parentChatId: chatId }, select: { id: true } });
      if (!existing) {
        await createDelegationTask({
          kind: 'continuation', source: 'turn_continuation', parentChatId: chatId, childChatId: chatId, childRef: taskId,
          brief: typeof p.title === 'string' ? p.title : null, state: to === 'working' ? 'working' : 'submitted', origin: 'user',
        });
        if (to === 'working') return;
      }
      await transitionTasks({ kind: 'continuation', childRef: taskId, parentChatId: chatId }, to, 'task_card', { resultRef, artifacts, reason: to === 'input_required' && typeof p.note === 'string' ? p.note : null });
    });
  }
}

/** The background pool's phases (agent.ts bgMetric — one call per phase). */
export function noteBackgroundWorkerPhase(
  phase: string,
  w: { id: string; role: string; title: string } | null,
  ctx: { sessionId: string; runId?: string | null; userId?: string | null; machine?: boolean },
): void {
  if (delegationTasksDisabled() || !w || !ctx.sessionId || /^(anon|chatless)-/.test(ctx.sessionId)) return;
  const to = fromBackgroundPhase(phase);
  if (!to) return;
  const key = `bg:${ctx.sessionId}:${w.id}`;
  if (phase === 'start') {
    void serial(key, () => createDelegationTask({
      kind: 'background_worker', source: 'delegate_background', userId: ctx.userId && ctx.userId !== 'anonymous' ? ctx.userId : null,
      parentChatId: ctx.sessionId, parentRunId: ctx.runId ?? null, childRef: w.id,
      brief: `${w.role}: ${w.title}`, state: 'working', origin: ctx.machine ? 'machine' : 'user',
    }));
    return;
  }
  void serial(key, () => transitionTasks(
    { kind: 'background_worker', parentChatId: ctx.sessionId, childRef: w.id },
    to, `background_${phase}`, { resultRef: phase, reason: phase === 'unposted' ? 'late report could not be posted' : null },
  ));
}

/** Background workers a resumed run lost with the dead process (agent.ts lostBackgroundWorkerIds). */
export function noteBackgroundWorkersLost(workerIds: string[], ctx: { sessionId: string }): void {
  if (delegationTasksDisabled() || !ctx.sessionId || !workerIds?.length) return;
  for (const id of workerIds) {
    void serial(`bg:${ctx.sessionId}:${id}`, () => transitionTasks(
      { kind: 'background_worker', parentChatId: ctx.sessionId, childRef: id },
      'failed', 'background_lost_on_resume', { reason: 'lost_on_resume' },
    ));
  }
}

/** The ticket drain saw this lane's ticket CLOSED (feedback/ticket-dispatch.service freshLaneDrainLocked). */
export function noteTicketLaneClosed(ticketId: string, laneChatId: string): void {
  if (delegationTasksDisabled() || !ticketId) return;
  void serial(`ref:${ticketId}`, () => transitionTasks(
    { kind: 'ticket', childRef: ticketId, ...(laneChatId ? { childChatId: laneChatId } : {}) },
    'completed', 'ticket_closed',
  ));
}

/** The ticket drain stopped re-dispatching (N lanes ran without closing it — it needs a human). */
export function noteTicketDispatchExhausted(ticketId: string): void {
  if (delegationTasksDisabled() || !ticketId) return;
  void serial(`ref:${ticketId}`, () => transitionTasks(
    { kind: 'ticket', childRef: ticketId },
    'failed', 'ticket_dispatch_exhausted', { reason: 'dispatch_exhausted' },
  ));
}

// ── Read path (admin view, readout script) ───────────────────────────────────

export interface DelegationTaskFilter { kind?: string; state?: string; chatId?: string; hours?: number; limit?: number; staleOnly?: boolean }

export async function listDelegationTasks(f: DelegationTaskFilter = {}): Promise<any[]> {
  try {
    const hours = Math.min(24 * 90, Math.max(1, Number(f.hours) || 72));
    const limit = Math.min(200, Math.max(1, Number(f.limit) || 50));
    const where: Record<string, unknown> = { createdAt: { gte: new Date(Date.now() - hours * 3_600_000) } };
    if (f.kind && (DELEGATION_KINDS as readonly string[]).includes(f.kind)) where.kind = f.kind;
    if (f.state === 'open') where.state = { in: OPEN_STATES as unknown as string[] };
    else if (f.state && isDelegationState(f.state)) where.state = f.state;
    if (f.chatId) where.OR = [{ parentChatId: f.chatId }, { childChatId: f.chatId }];
    if (f.staleOnly) { where.state = { in: OPEN_STATES as unknown as string[] }; where.staleAfter = { lt: new Date() }; }
    return await db().findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
  } catch (err) {
    warn('list', err);
    return [];
  }
}

/** One task by id (a ≥ 8-char unique prefix resolves too). */
export async function getDelegationTask(idOrPrefix: string): Promise<any | null> {
  try {
    const id = String(idOrPrefix ?? '').trim().toLowerCase();
    if (id.length < 8) return null;
    const exact = await db().findUnique({ where: { id } });
    if (exact) return exact;
    const hits = await db().findMany({ where: { id: { startsWith: id } }, take: 2 });
    return hits.length === 1 ? hits[0] : null;
  } catch (err) {
    warn('get', err);
    return null;
  }
}

export interface DelegationSummary {
  hours: number;
  total: number;
  byKind: Record<string, Record<string, number>>;
  open: number;
  stale: number;
  duplicateKeys: number;
}

export async function summarizeDelegationTasks(hours = 168): Promise<DelegationSummary> {
  const h = Math.min(24 * 90, Math.max(1, Number(hours) || 168));
  const out: DelegationSummary = { hours: h, total: 0, byKind: {}, open: 0, stale: 0, duplicateKeys: 0 };
  try {
    const since = new Date(Date.now() - h * 3_600_000);
    const groups: Array<{ kind: string; state: string; _count: { _all: number } }> = await db().groupBy({
      by: ['kind', 'state'], where: { createdAt: { gte: since } }, _count: { _all: true },
    });
    for (const g of groups) {
      const n = Number(g._count?._all ?? 0);
      (out.byKind[g.kind] ??= {})[g.state] = n;
      out.total += n;
      if (!TERMINAL.has(g.state)) out.open += n;
    }
    out.stale = await db().count({ where: { state: { in: OPEN_STATES as unknown as string[] }, staleAfter: { lt: new Date() } } });
    out.duplicateKeys = await db().count({ where: { createdAt: { gte: since }, duplicateOfId: { not: null } } });
  } catch (err) {
    warn('summary', err);
  }
  return out;
}
