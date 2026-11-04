/**
 * Platform unification (P3) — the external platform REST API.
 *
 * Mounted at /api/crossmodel/platform (app.ts). Thin transport over
 * platform.service.ts — the SAME service the in-loop agent platform tools
 * (platform-tools.ts) call, so a curl script and a model inside a run get
 * identical behavior and identical permissions (owner/member authz + Activity
 * audit live in the service).
 *
 * Caller types (middleware/agent-auth.ts):
 *   1. User JWT      → full access to own resources.
 *   2. Agent token   → `dgt_…` Bearer token, scoped (chats:read/write,
 *                      folders:read/write, schedules:write, code:run); scope
 *                      enforced by requireScope BEFORE the service's
 *                      owner/member scoping.
 *
 * Token management (/tokens) is JWT-ONLY — an agent token must never mint,
 * list, or revoke tokens (rejectAgentToken). Child accounts are rejected from
 * token minting and code:run routes (rejectChild, same as the coding surface).
 *
 * Rate limit: 300 req/min per userId (platformRateLimit below), on top of the
 * global /api/crossmodel stream limiter in app.ts.
 */

import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import { validate } from '../../../middleware/validate';
import { rejectChild } from '../../../middleware/auth';
import { RedisRateLimitStore } from '../../../middleware/redis-rate-limit-store';
import {
  authenticatePlatform,
  requireScope,
  rejectAgentToken,
  hashAgentToken,
  AGENT_TOKEN_PREFIX,
  PlatformRequest,
} from '../../../middleware/agent-auth';
import * as platform from './platform.service';
import crossModelService from '../crossmodel.service';
import {
  platformListChatsSchema,
  platformCreateChatSchema,
  platformChatIdSchema,
  platformSendMessageSchema,
  platformChatMessagesSchema,
  platformSupervisorStateQuerySchema,
  platformStartCodeSchema,
  platformPatchChatSchema,
  platformPatchScheduleSchema,
  platformPatchHookSchema,
  platformGoalPremisesSchema,
  platformCreateFolderSchema,
  platformPatchFolderSchema,
  platformDeleteFolderSchema,
  platformFolderWorkspaceSchema,
  platformCreateScheduleSchema,
  platformMintTokenSchema,
  platformListGoalsSchema,
  platformCreateGoalSchema,
  platformPatchGoalSchema,
  platformListTodosSchema,
  platformCreateTodoSchema,
  platformPatchTodoSchema,
  platformListHooksSchema,
  platformSubscribeHookSchema,
  platformPutAutonomySchema,
  platformIdOrPrefixSchema,
  platformReceiptsQuerySchema,
  platformListFoldersSchema,
} from './platform.validation';

const router = Router();

// ── Rate limit: 300 req/min per user (falls back to IP pre-auth) ─────────────
const platformRateLimit = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as PlatformRequest).user?.id ?? req.ip ?? 'unknown',
  message: { error: 'Too many requests — the platform API allows 300 requests per minute.' },
  store: new RedisRateLimitStore('rl:platform:'), // shared across instances; fail-open
});

router.use(authenticatePlatform);
router.use(platformRateLimit);

/** Map platform.service AppError status codes like the existing controllers do. */
const handle = (fn: (req: PlatformRequest, res: Response) => Promise<void>) => {
  return async (req: PlatformRequest, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err: any) {
      if (err instanceof AppError && err.statusCode < 500) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      logger.error(`platform API ${req.method} ${req.path} error:`, err);
      res.status(500).json({ error: 'Platform request failed' });
    }
  };
};

const uid = (req: PlatformRequest) => req.user!.id;

// ── Chats ─────────────────────────────────────────────────────────────────────

// GET /chats?folderId=&mode=&status=&q=&running=&codeCapable=&page=&limit=
// P6: ALL filters are service-layer (DB-level where possible; derived filters
// full-fetch + filter pre-pagination) — the old post-page in-memory filtering
// returned short pages and wrong totals for filtered lists.
router.get('/chats', requireScope('chats:read'), validate(platformListChatsSchema), handle(async (req, res) => {
  const { folderId, mode, status, q, running, codeCapable, archived, page, limit } = req.query as any;
  res.json(await platform.listChats({
    userId: uid(req), page, limit,
    ...(q ? { q } : {}),
    ...(folderId ? { projectId: folderId } : {}),
    ...(mode ? { mode } : {}),
    ...(status ? { status } : {}),
    ...(running !== undefined ? { running } : {}),
    ...(codeCapable !== undefined ? { codeCapable } : {}),
    ...(archived ? { archived: true } : {}), // Archived browse view; default excludes archived rows
  }));
}));

// POST /chats {title, folderId?, mode?}
router.post('/chats', requireScope('chats:write'), validate(platformCreateChatSchema), handle(async (req, res) => {
  const { title, folderId, mode } = req.body;
  const chat = await platform.createChat({
    userId: uid(req), title, mode, projectId: folderId ?? null,
  });
  res.status(201).json(chat);
}));

// GET /chats/:id/status — run state, coding state, plan progress
router.get('/chats/:id/status', requireScope('chats:read'), validate(platformChatIdSchema), handle(async (req, res) => {
  res.json(await platform.getChatStatus({ userId: uid(req), chatId: req.params.id }));
}));

// GET /chats/:id/messages?limit=&before= — paginated transcript read (P6: the
// fleet-supervisor HARVEST step; pages backward via the nextBefore cursor).
router.get('/chats/:id/messages', requireScope('chats:read'), validate(platformChatMessagesSchema), handle(async (req, res) => {
  const { limit, before } = req.query as any;
  res.json(await platform.getChatMessages({ userId: uid(req), chatId: req.params.id, limit, before }));
}));

// POST /chats/:id/messages {content, mode?, as?, delivery?} — queues a detached turn.
// A JWT send is a human turn (origin user + userTurnAt) unless it says as:'agent'.
// A dgt_ token is always agent origin: no userTurnAt, delivery defaults to queue,
// and as:'user' is refused. delivery omitted on a JWT keeps today's steer/preempt.
router.post('/chats/:id/messages', requireScope('chats:write'), validate(platformSendMessageSchema), handle(async (req, res) => {
  const agentCaller = req.agentScopes != null;
  const as = req.body.as as 'user' | 'agent' | undefined;
  if (agentCaller && as === 'user') {
    throw new AppError(403, 'Agent tokens cannot send as a user');
  }
  const asAgent = agentCaller || as === 'agent';
  const delivery = (req.body.delivery as 'queue' | 'steer' | 'interrupt' | undefined)
    ?? (asAgent ? 'queue' : undefined);
  res.status(202).json(await platform.sendChatMessage({
    userId: uid(req), chatId: req.params.id, content: req.body.content, mode: req.body.mode,
    ...(asAgent
      ? { origin: { kind: 'agent' as const } }
      : { origin: { kind: 'user' as const }, userTurnAt: new Date() }),
    ...(delivery ? { delivery } : {}),
  }));
}));

// POST /chats/:id/code {permissionMode?} — start a coding session in the chat's folder
router.post('/chats/:id/code', rejectChild, requireScope('code:run'), validate(platformStartCodeSchema), handle(async (req, res) => {
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: req.params.id },
    select: { userId: true, projectId: true, title: true },
  });
  if (!chat || chat.userId !== uid(req)) throw new AppError(404, 'Chat not found');
  if (!chat.projectId) throw new AppError(400, 'Chat is not in a folder — move it into a workspace folder first');
  const session = await platform.startCodingSession({
    userId: uid(req), projectId: chat.projectId,
    title: chat.title, permissionMode: req.body?.permissionMode,
    // T4c: model + first prompt (parity with start_coding_session)
    ...(req.body?.model ? { model: req.body.model } : {}),
    ...(req.body?.prompt ? { prompt: req.body.prompt } : {}),
  });
  res.status(201).json(session);
}));

// GET /chats/:id/receipts?runId=&limit= — the run tool receipts (evidence rows) for the latest runs (T3a, 2026-09-24).
router.get('/chats/:id/receipts', requireScope('chats:read'), validate(platformReceiptsQuerySchema), handle(async (req, res) => {
  const { executePlatformTool } = await import('./platform-tools');
  const raw = await executePlatformTool({ sessionId: '', userId: uid(req), permissionMode: 'auto' } as any, 'get_run_receipts', { chatId: req.params.id, runId: req.query.runId, limit: req.query.limit });
  const parsed = JSON.parse(raw);
  if (parsed?.ok === false) throw new AppError(parsed.reason === 'not_found' ? 404 : 400, parsed.message || 'receipts read failed');
  res.json(parsed);
}));

// GET /chats/:id/supervisor-state?section=&query=&limit= (ticket 2b8508cb) — the
// supervisor chat's durable state doc over the API: the monitor reads what the
// 6000-char wake block trims (dispatches, archived directives, notes — the
// doc's full shape, with a `truncated` flag when the JSON is bounded).
// Supervisor-CLASS gate (isSupervisor || isProjectSupervisor) + owner scoping —
// the same shape as the /status route; a plain chat is 404, another user's
// chat 404, a valid read 200. `query` (semantic search over the embedded
// `supervisor_state` memory rows) rides as `memHits` alongside the section.
router.get('/chats/:id/supervisor-state', requireScope('chats:read'), validate(platformSupervisorStateQuerySchema), handle(async (req, res) => {
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: req.params.id },
    select: { userId: true, isSupervisor: true, isProjectSupervisor: true },
  });
  if (!chat || chat.userId !== uid(req)) throw new AppError(404, 'Chat not found');
  if (chat.isSupervisor !== true && chat.isProjectSupervisor !== true) throw new AppError(404, 'Not a supervisor chat');
  const { readSupervisorStateSection } = await import('./supervisor-state.service');
  const out = await readSupervisorStateSection(req.params.id, {
    section: req.query.section,
    query: req.query.query,
    limit: req.query.limit,
  });
  if (req.query.query) {
    const mem: any = await import('./supervisor-state-memory').catch(() => null);
    const memHits = typeof mem?.searchSupervisorStateMem === 'function'
      ? await mem.searchSupervisorStateMem(req.params.id, String(req.query.query), 20).catch(() => [])
      : [];
    if (memHits?.length) out.memHits = memHits;
  }
  res.json(out);
}));

// PATCH /chats/:id {title?, mode?, folderId?, archived?, systemPrompt?}
router.patch('/chats/:id', requireScope('chats:write'), validate(platformPatchChatSchema), handle(async (req, res) => {
  const chatId = req.params.id;
  const { title, mode, folderId, archived, systemPrompt } = req.body;
  let result: any = null;
  if (title !== undefined) result = await platform.renameChat({ userId: uid(req), chatId, title });
  if (mode !== undefined) result = await platform.setChatMode({ userId: uid(req), chatId, mode });
  if (systemPrompt !== undefined) result = await platform.setChatInstructions({ userId: uid(req), chatId, systemPrompt });
  if (folderId !== undefined) result = await platform.moveChat({ userId: uid(req), chatId, projectId: folderId });
  if (archived !== undefined) result = await platform.archiveChat({ userId: uid(req), chatId, archived });
  res.json(result ?? { id: chatId });
}));

// DELETE /chats/:id
router.delete('/chats/:id', requireScope('chats:write'), validate(platformChatIdSchema), handle(async (req, res) => {
  res.json(await platform.deleteChat({ userId: uid(req), chatId: req.params.id }));
}));

// ── Folders ───────────────────────────────────────────────────────────────────

// GET /folders?archived= — owned + shared folders (flat lists with parentId/depth/path; client assembles the tree); archived=true = the Archived browse view
router.get('/folders', requireScope('folders:read'), validate(platformListFoldersSchema), handle(async (req, res) => {
  const archived = (req.query as { archived?: boolean }).archived === true;
  res.json(await platform.getFolderTree({ userId: uid(req), archived }));
}));

// POST /folders {name, parentId?, emoji?, color?, systemPrompt?}
router.post('/folders', requireScope('folders:write'), validate(platformCreateFolderSchema), handle(async (req, res) => {
  const { name, parentId, emoji, color, systemPrompt, description } = req.body;
  const folder = await platform.createProject({
    userId: uid(req), name, parentId: parentId ?? null, emoji, color, systemPrompt, description,
  });
  res.status(201).json(folder);
}));

// PATCH /folders/:id {name?, parentId?, emoji?, color?, systemPrompt?, description?, archived?}
router.patch('/folders/:id', requireScope('folders:write'), validate(platformPatchFolderSchema), handle(async (req, res) => {
  const folderId = req.params.id;
  const { name, parentId, emoji, color, systemPrompt, description, archived } = req.body;
  let result: any = null;
  if (archived !== undefined) {
    result = await platform.archiveProject({ userId: uid(req), projectId: folderId, archived });
  }
  if (parentId !== undefined) {
    result = await platform.moveFolder({ userId: uid(req), folderId, newParentId: parentId });
  }
  if ([name, emoji, color, systemPrompt, description].some((v) => v !== undefined)) {
    result = await platform.updateProject({
      userId: uid(req), projectId: folderId, name, emoji, color, systemPrompt, description,
    });
  }
  res.json(result ?? { id: folderId });
}));

// DELETE /folders/:id?reparentTo=
router.delete('/folders/:id', requireScope('folders:write'), validate(platformDeleteFolderSchema), handle(async (req, res) => {
  res.json(await platform.deleteProject({
    userId: uid(req), projectId: req.params.id, reparentTo: (req.query as any).reparentTo ?? null,
  }));
}));

// POST /folders/:id/workspace — start a coding session in this folder's workspace
router.post('/folders/:id/workspace', rejectChild, requireScope('code:run'), validate(platformFolderWorkspaceSchema), handle(async (req, res) => {
  const session = await platform.startCodingSession({
    userId: uid(req), projectId: req.params.id,
    title: req.body?.title, permissionMode: req.body?.permissionMode,
    prompt: req.body?.prompt,
    ...(req.body?.model ? { model: req.body.model } : {}), // T4c
  });
  res.status(201).json(session);
}));

// POST /supervisor/ensure — ensure the caller's ONE global "Fleet Supervisor"
// chat exists (idempotent, self-healing) and return it. The frontend fires
// this once per sidebar load; chat/session creation also ensures server-side.
// No params, no body: the supervisor belongs to the caller, full stop.
// Agent tokens are rejected outright (an autonomous agent must not spin up
// another autonomous agent); child accounts are confined to the kid pipeline.
router.post('/supervisor/ensure', rejectAgentToken, rejectChild, requireScope('chats:write'), handle(async (req, res) => {
  const userId = uid(req);
  const { ensureFleetSupervisor } = await import('./supervisor.service');
  const chat = await ensureFleetSupervisor(userId);
  if (!chat) throw new AppError(500, 'Failed to ensure the Fleet Supervisor');
  res.json(chat);
}));

// ── Schedules ─────────────────────────────────────────────────────────────────
// NOTE: schedules:write gates BOTH reads and writes here (list included) — a
// schedule fires with the chat owner's identity, so even reading them is
// treated as a privileged operation. JWT callers are unaffected (full access).

// POST /schedules {chatId, prompt, kind, intervalSec}
router.post('/schedules', requireScope('schedules:write'), validate(platformCreateScheduleSchema), handle(async (req, res) => {
  const { chatId, prompt, kind, intervalSec } = req.body;
  res.status(201).json(await platform.scheduleChatRun({
    userId: uid(req), chatId, prompt, kind, intervalSec, promptSetBy: 'user',
    // Owner-subscription (ticket 4565991a): a REST create is an explicit
    // owner request — its firings are delivered content, rendered expanded.
    ownerSubscribed: true,
  }));
}));

// GET /schedules — the user's schedules across all chats
router.get('/schedules', requireScope('schedules:write'), handle(async (req, res) => {
  res.json({ schedules: await platform.listSchedules({ userId: uid(req) }) });
}));

// PATCH /schedules/:id {enabled} — pause (false) / resume (true); the schedule's
// chat must be owned by the caller. 404 unknown, 409 with the honest reason
// when it cannot resume (completed / too many active / dormant project).
router.patch('/schedules/:id', requireScope('schedules:write'), validate(platformPatchScheduleSchema), handle(async (req, res) => {
  const userId = uid(req);
  const { resolveScheduleIdForUser } = await import('../coding/schedule.service');
  const scheduleId = await resolveScheduleIdForUser(userId, req.params.id);
  if (!scheduleId) throw new AppError(404, 'Schedule not found');
  const rows = await platform.listSchedules({ userId });
  const row = rows.find((x) => x.id === scheduleId);
  if (!row) throw new AppError(404, 'Schedule not found');
  const { enabled, prompt, intervalSec } = req.body;
  let result: any = null;
  if (prompt !== undefined || intervalSec !== undefined) {
    // T4c: prompt / cadence edits ride the same service as update_schedule (cap + cadence guards inside).
    const { updateScheduleForUser } = await import('../coding/schedule.service');
    const r = await updateScheduleForUser(userId, scheduleId, { ...(prompt !== undefined ? { prompt } : {}), ...(intervalSec !== undefined ? { intervalSec } : {}) });
    if (!r.ok) throw new AppError(400, r.error || 'Schedule update refused');
    result = { schedule: r.schedule, ...(r.warning ? { warning: r.warning } : {}) };
  }
  if (enabled !== undefined) result = await platform.setChatScheduleEnabled({ userId, chatId: row.sessionId, scheduleId, enabled });
  res.json(result ?? { id: scheduleId });
}));

// DELETE /schedules/:id
router.delete('/schedules/:id', requireScope('schedules:write'), validate(platformIdOrPrefixSchema), handle(async (req, res) => {
  const ok = await platform.cancelSchedule({ userId: uid(req), id: req.params.id });
  if (!ok) throw new AppError(404, 'Schedule not found');
  res.json({ success: true });
}));

// ── Fleet supervisor (slice D): goals / todos / hooks / autonomy ─────────────
// Thin transport over goals.service / hooks.service / autonomy.service — the
// SAME services the in-loop fleet tools call, so REST callers and agents get
// identical behavior and permissions (ownership/membership + audit live in the
// services). The fleet services are loaded via DYNAMIC import — the same
// import-graph discipline as platform-tools.ts (they pull config/database →
// config/env, and hooks.service is dynamic-import-only BY DESIGN so a static
// edge into it can never cycle through crossmodel.service). Scopes mirror the
// resource: goals/todos are folder-scoped, hooks + autonomy chat-scoped. There
// is deliberately NO delete for goals/todos — archive status instead (design
// §5); hooks unsubscribe via DELETE.

// GET /goals?projectId=&includeDescendants=&status= — projectId optional:
// omitted = account-wide across every project the caller OWNS, tagged with
// projectName (owner decision 2026-08-13, 'All projects, tagged').
router.get('/goals', requireScope('folders:read'), validate(platformListGoalsSchema), handle(async (req, res) => {
  const { projectId, includeDescendants, status } = req.query as any;
  const { listGoals } = await import('./goals.service');
  res.json({ goals: await listGoals({ userId: uid(req), projectId, includeDescendants, status }) });
}));

// POST /goals {projectId, title, description?, dependsOnGoalIds?, priority?, dueAt?}
router.post('/goals', requireScope('folders:write'), validate(platformCreateGoalSchema), handle(async (req, res) => {
  const { projectId, title, description, dependsOnGoalIds, priority, dueAt } = req.body;
  const { createGoal } = await import('./goals.service');
  res.status(201).json(await createGoal({
    userId: uid(req), projectId, title, description, dependsOnGoalIds,
    // GOAL-PRIORITY-SPEND (2026-10-20): a JWT caller ranks as the OWNER (goals.service stamps 'member' when the
    // caller is not the PROJECT owner — a shared project's editor); a dgt_ agent token as a machine.
    ...(priority !== undefined || dueAt !== undefined ? {
      ...(priority !== undefined ? { priority } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      rankingWriter: req.agentScopes != null ? 'machine' as const : 'owner' as const,
    } : {}),
    // 2026-10-20 goal_transition actorKind: a dgt_ agent token is a machine principal.
    ...(req.agentScopes != null ? { machineTriggered: true } : {}),
  }));
}));

// GET /goals/:id — full detail (deps + dependents with status, todos)
router.get('/goals/:id', requireScope('folders:read'), validate(platformChatIdSchema), handle(async (req, res) => {
  const { getGoal } = await import('./goals.service');
  res.json(await getGoal({ userId: uid(req), goalId: req.params.id }));
}));

// POST /goals/:id/premises {premises, mode?} — parity with goal_premise_set (T4c, 2026-09-24)
router.post('/goals/:id/premises', requireScope('folders:write'), validate(platformGoalPremisesSchema), handle(async (req, res) => {
  const { setGoalPremises } = await import('./goals.service');
  res.json(await setGoalPremises({ userId: uid(req), goalId: req.params.id, premises: req.body.premises, mode: req.body.mode }));
}));

// PATCH /goals/:id {title?, description?, status?, blockedReason?, dependsOnGoalIds?, force?, priority?, dueAt?}
router.patch('/goals/:id', requireScope('folders:write'), validate(platformPatchGoalSchema), handle(async (req, res) => {
  const { title, description, status, blockedReason, dependsOnGoalIds, force, priority, dueAt } = req.body;
  const { updateGoal } = await import('./goals.service');
  res.json(await updateGoal({
    userId: uid(req), goalId: req.params.id, title, description, status, blockedReason, dependsOnGoalIds, force,
    // GOAL-PRIORITY-SPEND (2026-10-20): a JWT caller ranks as the OWNER (never overwritten by a machine) — or as
    // 'member' when it is not the PROJECT owner (allowed, not a lock, never over the owner's ranking; goals.service);
    // a dgt_ agent token ranks as a machine (refused on an owner-set goal — priorityNote says so).
    ...(priority !== undefined || dueAt !== undefined ? {
      ...(priority !== undefined ? { priority } : {}),
      ...(dueAt !== undefined ? { dueAt } : {}),
      rankingWriter: req.agentScopes != null ? 'machine' as const : 'owner' as const,
    } : {}),
    // GOAL-OUTCOME-UNMET review fix (2026-10-20): a JWT caller is the OWNER
    // writing directly — a 'done' close with the outcome bar unmet accepts it;
    // a dgt_ agent token is a machine principal (it wakes the supervisor).
    ...(req.agentScopes != null ? { machineTriggered: true } : { ownerExplicit: true }),
  }));
}));

// GET /todos?goalId=|projectId= (at most one — enforced by the zod refine;
// neither = account-wide across the caller's OWNED projects, tagged)
router.get('/todos', requireScope('folders:read'), validate(platformListTodosSchema), handle(async (req, res) => {
  const { goalId, projectId } = req.query as any;
  const { listTodos } = await import('./goals.service');
  res.json({ todos: await listTodos({ userId: uid(req), goalId, projectId }) });
}));

// POST /todos {goalId, title, assigneeChatId?, dependsOnTodoIds?}
router.post('/todos', requireScope('folders:write'), validate(platformCreateTodoSchema), handle(async (req, res) => {
  const { goalId, title, assigneeChatId, dependsOnTodoIds } = req.body;
  const { createTodo } = await import('./goals.service');
  res.status(201).json(await createTodo({
    userId: uid(req), goalId, title, assigneeChatId, dependsOnTodoIds,
    // 2026-10-20 todo_transition actorKind: a dgt_ agent token is a machine principal.
    ...(req.agentScopes != null ? { machineTriggered: true } : {}),
  }));
}));

// PATCH /todos/:id {title?, status?, blockedReason?, assigneeChatId?, dependsOnTodoIds?, force?}
// GET /todos/:id — parity with todo_get (T4c, 2026-09-24); a unique ≥8-char prefix resolves.
router.get('/todos/:id', requireScope('folders:read'), validate(platformIdOrPrefixSchema), handle(async (req, res) => {
  const { getTodo } = await import('./goals.service');
  res.json(await getTodo({ userId: uid(req), todoId: req.params.id }));
}));

router.patch('/todos/:id', requireScope('folders:write'), validate(platformPatchTodoSchema), handle(async (req, res) => {
  const { title, status, blockedReason, assigneeChatId, dependsOnTodoIds, force } = req.body;
  const { updateTodo } = await import('./goals.service');
  res.json(await updateTodo({
    userId: uid(req), todoId: req.params.id, title, status, blockedReason, assigneeChatId, dependsOnTodoIds, force,
  }));
}));

// PATCH /hooks/:id {eventTypes?, promptTemplate?, debounceSec?, enabled?} — parity with hook_update (T4c, 2026-09-24)
router.patch('/hooks/:id', requireScope('chats:write'), validate(platformPatchHookSchema), handle(async (req, res) => {
  const { updateHook } = await import('./hooks.service');
  const { eventTypes, promptTemplate, debounceSec, enabled } = req.body;
  const view = await updateHook({ userId: uid(req), hookId: req.params.id, eventTypes, promptTemplate, debounceSec, enabled });
  if (!view) throw new AppError(404, 'Hook not found');
  res.json(view);
}));

// GET /hooks?sourceChatId=|targetChatId=
router.get('/hooks', requireScope('chats:read'), validate(platformListHooksSchema), handle(async (req, res) => {
  const { sourceChatId, targetChatId } = req.query as any;
  const { listHooks } = await import('./hooks.service');
  res.json({ hooks: await listHooks({ userId: uid(req), sourceChatId, targetChatId }) });
}));

// POST /hooks {sourceChatId?, projectId?, targetChatId, eventTypes, promptTemplate?, debounceSec?}
// Subscribe a target chat to events. Omitted/null sourceChatId = owner-scope WILDCARD (all owned chats emit to the target).
// projectId = PROJECT-SCOPE wildcard: only chats in that OWNED project emit — parity with the
// hook_subscribe tool (WI-E 2026-09-25); mutually exclusive with sourceChatId (400).
router.post('/hooks', requireScope('chats:write'), validate(platformSubscribeHookSchema), handle(async (req, res) => {
  const { sourceChatId, projectId, targetChatId, eventTypes, promptTemplate, debounceSec } = req.body;
  const { subscribeHook } = await import('./hooks.service');
  res.status(201).json(await subscribeHook({
    userId: uid(req), sourceChatId, targetChatId, eventTypes, promptTemplate, debounceSec,
    ...(projectId ? { projectId } : {}),
    // Creator provenance (ticket dd3a19fa): a REST create is stamped so
    // hook_list / GET /hooks can tell an API-wired hook from a tool- or
    // system-wired one. No chat/run to name — the caller is a token or JWT.
    createdVia: 'rest',
  }));
}));

// DELETE /hooks/:id — unsubscribe (owner-scoped; pending events are discarded)
router.delete('/hooks/:id', requireScope('chats:write'), validate(platformChatIdSchema), handle(async (req, res) => {
  const { unsubscribeHook } = await import('./hooks.service');
  const ok = await unsubscribeHook({ userId: uid(req), hookId: req.params.id });
  if (!ok) throw new AppError(404, 'Hook not found');
  res.json({ success: true });
}));

// GET /chats/:id/autonomy — the chat's autonomy grant (404 when none exists).
// Any caller with read access to the chat may read it; writes stay owner-only.
router.get('/chats/:id/autonomy', requireScope('chats:read'), validate(platformChatIdSchema), handle(async (req, res) => {
  const chatId = req.params.id;
  const { access, exists } = await crossModelService.getChatAccess(chatId, uid(req));
  if (!exists || access === 'none') throw new AppError(404, 'Chat not found');
  const { getChatAutonomy } = await import('./autonomy.service');
  const grant = await getChatAutonomy(chatId);
  if (!grant) throw new AppError(404, 'No autonomy grant for this chat');
  res.json({ chatId, ...grant });
}));

// PUT /chats/:id/autonomy {allowedTools, scheduleCap?} — grant or revoke (empty
// allowedTools) a chat's autonomy. Owner-only: setChatAutonomy enforces it.
// JWT only — NEVER agent-token (a machine principal must not be able to
// self-grant autonomy; same rationale as the token-management routes) and
// never a child account.
router.put('/chats/:id/autonomy', rejectAgentToken, rejectChild, requireScope('chats:write'), validate(platformPutAutonomySchema), handle(async (req, res) => {
  const { allowedTools, scheduleCap } = req.body;
  const { setChatAutonomy } = await import('./autonomy.service');
  res.json(await setChatAutonomy({ userId: uid(req), chatId: req.params.id, allowedTools, scheduleCap }));
}));

// ── Agent tokens (JWT only — NEVER agent-token; child accounts blocked) ───────

const tokenRouterGuards = [rejectAgentToken, rejectChild] as const;

// GET /tokens — the user's tokens (never the hash)
router.get('/tokens', ...tokenRouterGuards, handle(async (req, res) => {
  const tokens = await prisma.agentToken.findMany({
    where: { userId: uid(req) },
    select: {
      id: true, name: true, tokenPrefix: true, scopes: true,
      lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ tokens });
}));

// POST /tokens {name, scopes[], expiresAt?} — returns the RAW token exactly once
router.post('/tokens', ...tokenRouterGuards, validate(platformMintTokenSchema), handle(async (req, res) => {
  const { name, scopes, expiresAt } = req.body;
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    throw new AppError(400, 'expiresAt must be in the future');
  }

  const raw = AGENT_TOKEN_PREFIX + randomBytes(24).toString('hex'); // dgt_ + 48 hex chars
  const record = await prisma.agentToken.create({
    data: {
      userId: uid(req),
      name: name.trim(),
      tokenHash: hashAgentToken(raw), // only the sha256 hash is stored
      tokenPrefix: raw.slice(0, 12),  // "dgt_ab12cd34" — UI identification only
      scopes,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    },
    select: {
      id: true, name: true, tokenPrefix: true, scopes: true,
      expiresAt: true, createdAt: true,
    },
  });
  res.status(201).json({ ...record, token: raw }); // shown ONCE — never retrievable again
}));

// DELETE /tokens/:id — revoke (sets revokedAt; the row stays for audit)
router.delete('/tokens/:id', ...tokenRouterGuards, validate(platformChatIdSchema), handle(async (req, res) => {
  const token = await prisma.agentToken.findFirst({
    where: { id: req.params.id, userId: uid(req) },
  });
  if (!token) throw new AppError(404, 'Token not found');
  await prisma.agentToken.update({
    where: { id: token.id },
    data: { revokedAt: token.revokedAt ?? new Date() },
  });
  res.json({ success: true });
}));

export default router;
