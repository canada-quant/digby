/**
 * The delegation ledger's READ path for models — stage 2 of architecture.md
 * item B (build 2026-10-11 DL-1; owner "turn everything remaining on").
 *
 *   task_get   {id}                                         READ, never gated — ONE task by its id (or a unique
 *                                                           ≥ 8-char prefix) or by the CHILD chat it was handed to,
 *                                                           with its lifecycle events, artifacts and result ref
 *   task_list  {state?, kind?, sinceHours?, scope?, chatId?, limit?}
 *                                                           READ, never gated — the caller's delegations + counts
 *
 * WHY. "Did my delegation finish?" was re-derived from receipts, hooks and
 * prose on every wake: get_chat_status + list_chats + get_chat_messages were
 * 31 % of all platform calls (7 d to 10-08). The ledger (platform/delegation-
 * tasks.ts) keeps ONE A2A-shaped state per delegated piece of work; these two
 * reads make it the status source, so one task_list replaces a poll per lane.
 *
 * SCOPE — strict, never another account (every query carries the fence):
 *   account fence  task.userId = the caller (a null-userId row — a turn
 *                  continuation's task — only on the caller's OWN chat as parent)
 *   mine           tasks this chat delegated (parentChatId = this chat)
 *   project        a project supervisor: + every task whose project is its
 *                  project or whose parent / child chat lives in it
 *   account        the Fleet Supervisor: every task of the account
 * The seat (isSupervisor / isProjectSupervisor / projectId / owner) is read
 * from the CALLER's chat row — never from an argument; `scope` can only
 * NARROW it. task_get additionally sees a task whose CHILD is this chat (what
 * it was asked to do). A miss never says whether the id exists elsewhere.
 *
 * Machine reads are credential-redacted per string leaf (the get_run_receipts
 * policy). Telemetry: loop_metrics `delegation_task` phase `tool_read`
 * {tool, seat, scope, returned} — adoption vs the polling reads it replaces.
 * Switch DELEGATION_TASK_TOOLS_DISABLED=1: both tools answer ok:false
 * 'disabled' (naming the polling reads) and the doctrine rows drop out.
 *
 * Import-light (platform-tools.ts imports this statically): prisma, the
 * ledger and loop-metrics load dynamically inside the handler.
 */

import { redactStringsDeep, REDACTED_NOTE } from './secret-scan';
import { chatReadIsMachine } from './ops-tools';

export const DELEGATION_TASK_TOOL_NAMES = ['task_get', 'task_list'] as const;
export type DelegationTaskToolName = (typeof DELEGATION_TASK_TOOL_NAMES)[number];
export const isDelegationTaskTool = (name: string): name is DelegationTaskToolName =>
  (DELEGATION_TASK_TOOL_NAMES as readonly string[]).includes(name);

export function delegationTaskToolsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.DELEGATION_TASK_TOOLS_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

// Kept in step with platform/delegation-tasks.ts (a leaf here — that module imports prisma statically).
const KINDS = ['session', 'message_ask', 'ticket', 'background_worker', 'schedule_firing', 'continuation'] as const;
const STATES = ['submitted', 'working', 'input_required', 'completed', 'failed', 'canceled'] as const;
const OPEN_STATES = ['submitted', 'working', 'input_required'];
const TERMINAL = new Set(['completed', 'failed', 'canceled']);

export const DELEGATION_TASK_TOOL_SCHEMA = [
  { type: 'function' as const, function: { name: 'task_list', description: "The ONE status source for work you delegated: every task this chat handed off — coding sessions it started, work asks sent to other chats, ticket lanes, background workers, schedule firings — with its state (submitted → working → input_required → completed | failed | canceled), child chat, result ref, stale flag and age, plus counts by state. One call replaces polling each lane with get_chat_status / get_chat_messages: open a transcript only for a task that is input_required, failed or stale. Scope: this chat's own delegations; a project supervisor also sees its project's, the Fleet Supervisor the whole account's. Read-only.", parameters: { type: 'object', properties: {
    state: { type: 'string', description: "open (not finished) | submitted | working | input_required | completed | failed | canceled. Omitted = every state." },
    kind: { type: 'string', enum: [...KINDS], description: 'Only this kind of delegation.' },
    sinceHours: { type: 'number', description: 'Look-back window in hours (default 72, max 720).' },
    scope: { type: 'string', enum: ['mine', 'project', 'account'], description: "Narrow to this chat's own delegations ('mine'). Default = the widest your seat allows; it can never widen past it." },
    chatId: { type: 'string', description: 'Only tasks this chat id is the parent or the child of.' },
    limit: { type: 'number', description: 'Rows to return (default 25, max 50); the counts cover the whole window.' },
  } } } },
  { type: 'function' as const, function: { name: 'task_get', description: "Read ONE delegated task in full — by its task id (or a unique 8+-char prefix) or by the CHILD chat id it was handed to (that chat's newest task; the others are listed): state, brief, every lifecycle transition with its time, artifacts (files, PRs, canvases), result ref and the failure / cancel reason. Use it instead of re-reading a lane's transcript to learn whether it finished. Visible: tasks this chat delegated or was handed, and (supervisors) the tasks they oversee. Read-only.", parameters: { type: 'object', properties: {
    id: { type: 'string', description: 'A task id (or an 8+-char prefix), or the child chat id the work was handed to.' },
  }, required: ['id'] } } },
];

type Ctx = { sessionId: string; userId: string; userTurnAt?: Date | null; machineTriggered?: boolean };

export type DelegationSeat = 'chat' | 'project_supervisor' | 'fleet_supervisor';
export type DelegationScope = 'mine' | 'project' | 'account';

export interface CallerSeat {
  userId: string;
  chatId: string;
  /** The caller owns its chat (a shared-project member never gets supervisor reach or null-userId rows). */
  owner: boolean;
  seat: DelegationSeat;
  projectId: string | null;
}

/** Pure: the caller's seat from its chat row. Never trusts an argument. */
export function callerSeatFrom(ctx: Pick<Ctx, 'sessionId' | 'userId'>, chat: { userId?: string | null; isSupervisor?: boolean | null; isProjectSupervisor?: boolean | null; projectId?: string | null } | null | undefined): CallerSeat {
  const owner = !!chat && chat.userId === ctx.userId;
  const projectId = owner && chat?.projectId ? String(chat.projectId) : null;
  const seat: DelegationSeat = !owner ? 'chat'
    : chat?.isSupervisor ? 'fleet_supervisor'
      : chat?.isProjectSupervisor && projectId ? 'project_supervisor' : 'chat';
  return { userId: ctx.userId, chatId: ctx.sessionId, owner, seat, projectId };
}

/** Pure: the widest scope a seat allows. */
export function maxScopeFor(seat: DelegationSeat): DelegationScope {
  return seat === 'fleet_supervisor' ? 'account' : seat === 'project_supervisor' ? 'project' : 'mine';
}

/** Pure: the scope a call gets — the requested one only when it is not wider than the seat's (else null = refused). */
export function resolveDelegationScope(seat: DelegationSeat, requested: unknown): DelegationScope | null {
  const max = maxScopeFor(seat);
  if (requested === undefined || requested === null || requested === '') return max;
  const order: DelegationScope[] = ['mine', 'project', 'account'];
  const r = String(requested) as DelegationScope;
  if (!order.includes(r)) return null;
  if (order.indexOf(r) > order.indexOf(max)) return null;
  // A Fleet Supervisor has no single project: 'project' narrows to its own delegations.
  if (r === 'project' && seat === 'fleet_supervisor') return 'mine';
  return r;
}

/**
 * Pure: the Prisma `where` that fences a read to the caller. Every branch
 * carries `userId = caller` except the caller's OWN chat's null-userId rows.
 * `projectChatIds` = the project's chats (project scope only).
 */
export function delegationScopeWhere(c: CallerSeat, scope: DelegationScope, projectChatIds: readonly string[] = [], opts: { includeChild?: boolean } = {}): Record<string, unknown> {
  const uid = c.userId;
  const or: Array<Record<string, unknown>> = [{ userId: uid, parentChatId: c.chatId }];
  if (c.owner) or.push({ userId: null, parentChatId: c.chatId });
  if (opts.includeChild) or.push({ userId: uid, childChatId: c.chatId });
  if (scope === 'project' && c.projectId) {
    or.push({ userId: uid, projectId: c.projectId });
    if (projectChatIds.length) {
      or.push({ userId: uid, parentChatId: { in: [...projectChatIds] } });
      or.push({ userId: uid, childChatId: { in: [...projectChatIds] } });
    }
  }
  if (scope === 'account') or.push({ userId: uid });
  return { OR: or };
}

const iso = (d: unknown): string | null => (d ? new Date(d as any).toISOString() : null);

/** Pure: one task row as the model reads it (compact — task_get adds events / artifacts / the full brief). */
export function taskRowForModel(t: any, now = Date.now()): Record<string, unknown> {
  const open = !TERMINAL.has(String(t?.state));
  const stale = open && !!t?.staleAfter && new Date(t.staleAfter).getTime() < now;
  const created = t?.createdAt ? new Date(t.createdAt).getTime() : null;
  return {
    id: t.id,
    kind: t.kind,
    state: t.state,
    ...(stale ? { stale: true } : {}),
    brief: typeof t.brief === 'string' ? (t.brief.length > 160 ? `${t.brief.slice(0, 159)}…` : t.brief) : null,
    parentChatId: t.parentChatId ?? null,
    childChatId: t.childChatId ?? null,
    ...(t.childRef ? { childRef: t.childRef } : {}),
    ...(t.resultRef ? { resultRef: t.resultRef } : {}),
    ...(t.reason ? { reason: t.reason } : {}),
    ...(Array.isArray(t.artifacts) && t.artifacts.length ? { artifacts: t.artifacts.length } : {}),
    ...(t.duplicateOfId ? { duplicateOfId: t.duplicateOfId } : {}),
    createdAt: iso(t.createdAt),
    lastEventAt: iso(t.lastEventAt),
    ...(t.completedAt ? { completedAt: iso(t.completedAt) } : {}),
    ...(created !== null && Number.isFinite(created) ? { ageMin: Math.max(0, Math.round((now - created) / 60_000)) } : {}),
  };
}

const out = (o: Record<string, unknown>): string => JSON.stringify(o, null, 1);

async function db(): Promise<any> { return (await import('../../../config/database')).default; }

function refuse(tool: string, reason: string, message: string, extra: Record<string, unknown> = {}): string {
  return out({ ok: false, tool, reason, message, ...extra });
}

/** Machine reads: redact credential-shaped strings per leaf (get_run_receipts policy). Fail-open. */
function redacted(ctx: Ctx, envelope: Record<string, unknown>): string {
  try {
    const r = redactStringsDeep(envelope, { machineRun: chatReadIsMachine(ctx) });
    if (!r.hits.length) return out(envelope);
    return out({ secretRedactionNotice: `CREDENTIALS REDACTED — this envelope contained credential-shaped strings (${r.hits.join(', ')}); each was replaced with "${REDACTED_NOTE}" before you saw it.`, ...r.value });
  } catch {
    return out(envelope);
  }
}

async function readMetric(ctx: Ctx, meta: Record<string, unknown>): Promise<void> {
  try {
    const m: any = await import('./loop-metrics.service');
    m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS?.DELEGATION_TASK ?? 'delegation_task', sessionId: ctx.sessionId, meta: { phase: 'tool_read', ...meta } });
  } catch { /* telemetry never blocks a read */ }
}

async function loadSeat(prisma: any, ctx: Ctx): Promise<CallerSeat> {
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: ctx.sessionId },
    select: { userId: true, isSupervisor: true, isProjectSupervisor: true, projectId: true },
  }).catch(() => null);
  return callerSeatFrom(ctx, chat);
}

async function projectChatIds(prisma: any, c: CallerSeat): Promise<string[]> {
  if (!c.projectId) return [];
  const rows: Array<{ id: string }> = await prisma.crossModelChat.findMany({
    where: { userId: c.userId, projectId: c.projectId }, select: { id: true }, take: 500,
  }).catch(() => []);
  return rows.map((r) => r.id);
}

export async function executeDelegationTaskTool(ctx: Ctx, name: DelegationTaskToolName | string, args: any): Promise<string> {
  if (delegationTaskToolsDisabled()) {
    return refuse(name, 'disabled', 'The delegation task tools are switched off on this instance — read lane state with list_chats / get_chat_status instead.');
  }
  if (!ctx?.userId || ctx.userId === 'anonymous' || !ctx.sessionId || /^(anon|chatless)-/.test(ctx.sessionId)) {
    return refuse(name, 'anonymous', `${name} needs a signed-in chat — there is no delegation ledger for this run.`);
  }
  try {
    const prisma = await db();
    const tasks = prisma.delegationTask;
    const caller = await loadSeat(prisma, ctx);
    const now = Date.now();

    if (name === 'task_list') {
      const scope = resolveDelegationScope(caller.seat, args?.scope);
      if (!scope) {
        return refuse(name, 'scope', `scope "${String(args?.scope)}" is wider than this chat's seat allows (${maxScopeFor(caller.seat)}) — omit scope for the widest view you have.`);
      }
      const ids = scope === 'project' ? await projectChatIds(prisma, caller) : [];
      const fence = delegationScopeWhere(caller, scope, ids);
      const hours = Math.min(720, Math.max(1, Number(args?.sinceHours) || 72));
      const limit = Math.min(50, Math.max(1, Number(args?.limit) || 25));
      const and: Array<Record<string, unknown>> = [fence, { createdAt: { gte: new Date(now - hours * 3_600_000) } }];
      const kind = typeof args?.kind === 'string' ? args.kind.trim() : '';
      if (kind) {
        if (!(KINDS as readonly string[]).includes(kind)) return refuse(name, 'invalid', `kind must be one of ${KINDS.join(' | ')}.`);
        and.push({ kind });
      }
      const state = typeof args?.state === 'string' ? args.state.trim().toLowerCase() : '';
      if (state === 'open') and.push({ state: { in: OPEN_STATES } });
      else if (state) {
        if (!(STATES as readonly string[]).includes(state)) return refuse(name, 'invalid', `state must be open | ${STATES.join(' | ')}.`);
        and.push({ state });
      }
      const chatFilter = typeof args?.chatId === 'string' ? args.chatId.trim() : '';
      if (chatFilter) and.push({ OR: [{ parentChatId: chatFilter }, { childChatId: chatFilter }] });
      const where = { AND: and };
      const [rows, groups] = await Promise.all([
        tasks.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
        tasks.groupBy({ by: ['state'], where, _count: { _all: true } }).catch(() => []),
      ]);
      const byState: Record<string, number> = {};
      let total = 0;
      for (const g of groups as Array<{ state: string; _count: { _all: number } }>) {
        const n = Number(g?._count?._all ?? 0);
        byState[g.state] = n;
        total += n;
      }
      const list = (rows as any[]).map((t) => taskRowForModel(t, now));
      const staleN = list.filter((t) => t.stale === true).length;
      void readMetric(ctx, { tool: name, seat: caller.seat, scope, returned: list.length, total, open: OPEN_STATES.reduce((a, s) => a + (byState[s] ?? 0), 0) });
      return redacted(ctx, {
        ok: true, tool: name, scope, seat: caller.seat, sinceHours: hours,
        total, byState, returned: list.length, ...(staleN ? { staleShown: staleN } : {}),
        tasks: list,
        ...(total === 0 ? { note: scope === 'mine' ? 'No delegations from this chat in the window — nothing it handed off is outstanding.' : 'No delegations in this scope and window.' } : {}),
      });
    }

    if (name === 'task_get') {
      const raw = typeof args?.id === 'string' ? args.id.trim().toLowerCase() : '';
      if (raw.length < 8) return refuse(name, 'invalid', 'id must be a task id or a child chat id (at least 8 characters).');
      const scope = maxScopeFor(caller.seat);
      const ids = scope === 'project' ? await projectChatIds(prisma, caller) : [];
      const fence = delegationScopeWhere(caller, scope, ids, { includeChild: true });
      // 1) a task id (exact, else a unique prefix) — always inside the fence (no existence leak).
      let task: any = await tasks.findFirst({ where: { AND: [fence, { id: raw }] } });
      if (!task) {
        const hits: any[] = await tasks.findMany({ where: { AND: [fence, { id: { startsWith: raw } }] }, take: 2 });
        if (hits.length === 1) task = hits[0];
        else if (hits.length > 1) return refuse(name, 'ambiguous', `"${raw}" matches more than one task — pass more of the id (task_list shows them).`);
      }
      // 2) a child chat id — its newest visible task; the rest are listed.
      let others: any[] = [];
      let via: 'task' | 'child_chat' = 'task';
      if (!task) {
        const childWhere = raw.length >= 36 ? { childChatId: raw } : { childChatId: { startsWith: raw } };
        const forChat: any[] = await tasks.findMany({ where: { AND: [fence, childWhere] }, orderBy: { createdAt: 'desc' }, take: 6 });
        if (forChat.length) { task = forChat[0]; others = forChat.slice(1); via = 'child_chat'; }
      }
      if (!task) {
        void readMetric(ctx, { tool: name, seat: caller.seat, scope, returned: 0 });
        return refuse(name, 'not_found', 'No delegated task you can see matches that id — task_list shows the tasks in your scope.');
      }
      const events = (Array.isArray(task.events) ? task.events : []).map((e: any) => ({ at: e?.at ?? null, from: e?.from ?? null, to: e?.to ?? null, seam: e?.seam ?? null, ...(e?.ref ? { ref: e.ref } : {}) }));
      const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
      void readMetric(ctx, { tool: name, seat: caller.seat, scope, returned: 1, via });
      return redacted(ctx, {
        ok: true, tool: name, via,
        task: {
          ...taskRowForModel(task, now),
          brief: typeof task.brief === 'string' ? task.brief : null,
          source: task.source ?? null,
          origin: task.origin ?? null,
          projectId: task.projectId ?? null,
          ...(task.parentRunId ? { parentRunId: task.parentRunId } : {}),
          ...(task.staleAfter ? { staleAfter: iso(task.staleAfter) } : {}),
          events,
          artifacts,
        },
        ...(others.length ? { otherTasksForChat: others.map((t) => ({ id: t.id, kind: t.kind, state: t.state, createdAt: iso(t.createdAt) })) } : {}),
      });
    }
    return refuse(name, 'invalid', `Unknown delegation task tool ${name}.`);
  } catch (err: any) {
    return refuse(name, 'unavailable', `The delegation ledger could not be read right now (${String(err?.message ?? err).slice(0, 120)}) — fall back to get_chat_status for this wake.`);
  }
}
