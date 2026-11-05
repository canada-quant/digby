/**
 * Platform unification (P3) — zod schemas for the external platform REST API
 * (/api/crossmodel/platform). Conventions match crossmodel.validation.ts
 * ({ body | query | params } objects consumed by middleware/validate).
 */

import { z } from 'zod';
import { PATIENCE_MODES } from '../types';
import { AGENT_TOKEN_SCOPES } from '../../../middleware/agent-auth';
import { UUID_SHAPE, uuidString } from '../../../utils/zod-uuid';

const modeEnum = z.enum(PATIENCE_MODES);
// P4: 'auto' — the heuristic Auto router detent (per-message, never persisted).
// Exported as the SINGLE SOURCE OF TRUTH for mode inputs: the REST schemas below
// AND the in-loop platform tools (platform-tools.ts) validate with the same
// enum, so tool args can never smuggle a retired mode (e.g. 'code') past the
// boundary the REST layer enforces.
export const platformModeWithAutoEnum = z.enum([...PATIENCE_MODES, 'auto']);
const modeWithAutoEnum = platformModeWithAutoEnum;
const idParam = z.object({ id: uuidString('Invalid ID') });
/** uuid, or a unique ≥8-char hex prefix (schedules and todos resolve these). */
const idOrPrefixParam = z.object({
  id: z.string().refine(
    (v) => UUID_SHAPE.test(v) || /^[0-9a-f]{8,}$/i.test(v),
    'Invalid ID',
  ),
});
/** schedule.service MIN_INTERVAL_SEC — this leaf stays free of that import. */
const MIN_SCHEDULE_INTERVAL_SEC = 15 * 60;

// ── Chats ─────────────────────────────────────────────────────────────────────

export const platformListChatsSchema = z.object({
  query: z.object({
    folderId: uuidString('Invalid folder ID').optional(),
    mode: modeWithAutoEnum.optional(),
    status: z.enum(['provisioning', 'ready', 'running', 'error', 'archived']).optional(),
    q: z.string().max(200).optional(),
    running: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
    codeCapable: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
    // Archive browse view (own archivedAt-stamped chats only); default lists exclude archived rows.
    archived: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
    page: z.string().optional().transform((v) => (v ? parseInt(v, 10) : 1)),
    limit: z.string().optional().transform((v) => {
      const n = v ? parseInt(v, 10) : 50;
      if (!Number.isFinite(n)) return 50;
      return Math.min(200, Math.max(1, n));
    }),
  }),
});

export const platformCreateChatSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'title is required').max(200),
    folderId: uuidString('Invalid folder ID').optional().nullable(),
    mode: modeWithAutoEnum.optional(),
  }),
});

export const platformChatIdSchema = z.object({ params: idParam });

export const platformSendMessageSchema = z.object({
  params: idParam,
  body: z.object({
    content: z.string().min(1, 'content is required').max(100_000),
    // P4: optional PER-MESSAGE patience override; 'auto' routes via the
    // heuristic router. Omitted → the chat's stored mode. Never persisted.
    mode: modeWithAutoEnum.optional(),
    /** JWT only. A dgt_ token that sends as:'user' is refused by the route. */
    as: z.enum(['user', 'agent']).optional(),
    /**
     * Omitted on a JWT keeps today's steer/preempt. A dgt_ token defaults to
     * `queue` in the route (never injected into a live run as a user turn).
     */
    delivery: z.enum(['queue', 'steer', 'interrupt']).optional(),
  }),
});

// P6: paginated transcript read (fleet-supervisor harvest) — `before` is a
// message-id cursor from the previous page's nextBefore.
export const platformChatMessagesSchema = z.object({
  params: idParam,
  query: z.object({
    limit: z.string().optional().transform((v) => (v ? parseInt(v, 10) : 50)),
    before: uuidString('Invalid before cursor').optional(),
  }),
});

export const platformStartCodeSchema = z.object({
  params: idParam,
  body: z.object({
    permissionMode: z.enum(['auto', 'plan', 'ask']).optional(),
    // REST parity with start_coding_session (T4c, 2026-09-24): pin the agent + a first prompt.
    model: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(100_000).optional(),
  }).optional().default({}),
});

export const platformPatchChatSchema = z.object({
  params: idParam,
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    // Patience level (capability gap audit T2, 2026-09-24) — plain chats.
    mode: z.enum(['single_thinking', 'thinking', 'deep_research', 'auto']).optional(),
    folderId: uuidString('Invalid folder ID').optional().nullable(),
    archived: z.boolean().optional(),
    // Standing instructions (T3b, 2026-09-24); '' or null clears.
    systemPrompt: z.string().max(20000).optional().nullable(),
  }),
});

// PATCH /platform/schedules/:id {enabled} (capability gap audit P0, 2026-09-24):
// pause (false) / resume (true) — the agent-token twin of PATCH /chats/:id/schedules/:scheduleId.
export const platformPatchScheduleSchema = z.object({
  params: idOrPrefixParam,
  // T4c (2026-09-24): prompt / intervalSec join enabled — parity with update_schedule.
  body: z.object({
    enabled: z.boolean().optional(),
    prompt: z.string().min(1).max(100_000).optional(),
    intervalSec: z.number().int().min(MIN_SCHEDULE_INTERVAL_SEC).max(31 * 86_400).optional(),
  }).refine((b) => b.enabled !== undefined || b.prompt !== undefined || b.intervalSec !== undefined, { message: 'Pass enabled, prompt and/or intervalSec' }),
});

const goalStatusEnum = z.enum(['active', 'blocked', 'done', 'archived']);
const todoStatusEnum = z.enum(['pending', 'in_progress', 'blocked', 'done', 'dropped']);
const hookEventTypeEnum = z.enum(['run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'todo_done', 'schedule_cap_skipped', 'schedule_disabled', 'ci_failed', 'schedule_near_cap']);

/** PATCH /hooks/:id (T4c, 2026-09-24) — parity with hook_update. */
export const platformPatchHookSchema = z.object({
  params: idParam,
  body: z.object({
    eventTypes: z.array(hookEventTypeEnum).min(1).max(32).optional(),
    promptTemplate: z.string().max(8000).optional(),
    debounceSec: z.number().int().min(0).max(3600).optional(),
    enabled: z.boolean().optional(),
  }).refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Pass at least one field' }),
});

/** POST /goals/:id/premises (T4c) — parity with goal_premise_set. */
export const platformGoalPremisesSchema = z.object({
  params: idParam,
  body: z.object({
    premises: z.unknown(),
    mode: z.enum(['merge', 'replace']).optional(),
  }),
});

// ── Folders ───────────────────────────────────────────────────────────────────

export const platformCreateFolderSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'name is required').max(200),
    parentId: uuidString('Invalid parent folder ID').optional().nullable(),
    emoji: z.string().max(8).optional(),
    color: z.string().max(32).optional(),
    systemPrompt: z.string().max(20000).optional().nullable(),
    description: z.string().max(5000).optional().nullable(),
  }),
});

export const platformPatchFolderSchema = z.object({
  params: idParam,
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    parentId: uuidString('Invalid parent folder ID').optional().nullable(),
    emoji: z.string().max(8).optional(),
    color: z.string().max(32).optional(),
    systemPrompt: z.string().max(20000).optional().nullable(),
    description: z.string().max(5000).optional().nullable(),
    // Archive / restore the folder subtree (T4a, 2026-09-24) — owner-only, 409 while running.
    archived: z.boolean().optional(),
  }),
});

export const platformDeleteFolderSchema = z.object({
  params: idParam,
  query: z.object({
    reparentTo: uuidString('Invalid reparent folder ID').optional(),
  }),
});

export const platformFolderWorkspaceSchema = z.object({
  params: idParam,
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    permissionMode: z.enum(['auto', 'plan', 'ask']).optional(),
    // P6: optional first goal — delivered as the session's first user message
    // once the workspace is ready (one-call fleet dispatch).
    prompt: z.string().min(1).max(100_000).optional(),
    // T4c: pin the coding agent for the spawn (stamped 'spawn-param').
    model: z.string().min(1).max(200).optional(),
  }).optional().default({}),
});

// ── Schedules ─────────────────────────────────────────────────────────────────

export const platformCreateScheduleSchema = z.object({
  body: z.object({
    chatId: uuidString('Invalid chat ID'),
    prompt: z.string().min(1, 'prompt is required').max(100_000),
    kind: z.enum(['once', 'recurring']),
    intervalSec: z.number().int().min(MIN_SCHEDULE_INTERVAL_SEC),
  }),
});

// ── Fleet supervisor (slice D): goals / todos / hooks / autonomy ─────────────
// The status/event enums MIRROR GOAL_STATUSES / TODO_STATUSES
// (platform/goals.service.ts), HOOK_EVENT_TYPES (platform/hooks.service.ts) and
// AUTONOMY_GRANTABLE_TOOLS (platform/autonomy.service.ts) — hardcoded here so
// this module keeps its light import graph (the fleet services are deliberately
// DYNAMIC-import-only — pulling them in statically would drag config/database →
// config/env into every consumer of this leaf; same discipline as the
// platform-tools.ts schema enums). The enums themselves are declared once,
// above platformPatchHookSchema.
const dependencyIds = z.array(uuidString('Invalid dependency ID')).max(100);

export const platformListGoalsSchema = z.object({
  query: z.object({
    // Optional: omitted = account-wide across every project the caller owns
    // (rows tagged with projectName — owner decision 2026-08-13).
    projectId: uuidString('Invalid project ID').optional(),
    includeDescendants: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
    status: goalStatusEnum.optional(),
  }),
});

/** GOAL-PRIORITY-SPEND (2026-10-20): 1..4 or 'P1'..'P4'; null clears. */
const goalPriority = z.union([z.number().int().min(1).max(4), z.string().regex(/^[Pp]?[1-4]$/, 'priority must be 1..4 or P1..P4'), z.null()]);
/** GOAL-PRIORITY-SPEND: an ISO date string; null clears. */
const goalDueAt = z.union([z.string().max(40), z.null()]);

export const platformCreateGoalSchema = z.object({
  body: z.object({
    projectId: uuidString('Invalid project ID'),
    title: z.string().min(1, 'title is required').max(500),
    description: z.string().max(20000).optional(),
    dependsOnGoalIds: dependencyIds.optional(),
    // GOAL-PRIORITY-SPEND (2026-10-20): P1 (highest) .. P4 (lowest); null/absent = P2. The service validates
    // (goal-priority.ts parseGoalPriorityInput / parseGoalDueAtInput) — the shapes here only bound the input.
    priority: goalPriority.optional(),
    dueAt: goalDueAt.optional(),
  }),
});

export const platformPatchGoalSchema = z.object({
  params: idParam,
  body: z.object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(20000).optional(),
    status: goalStatusEnum.optional(),
    blockedReason: z.string().max(2000).optional(),
    dependsOnGoalIds: dependencyIds.optional(),
    force: z.boolean().optional(),
    // GOAL-PRIORITY-SPEND (2026-10-20): null clears.
    priority: goalPriority.optional(),
    dueAt: goalDueAt.optional(),
  }),
});

export const platformListTodosSchema = z.object({
  query: z.object({
    // Both optional: neither = account-wide across every project the caller
    // owns (rows tagged with projectName); never both together.
    goalId: uuidString('Invalid goal ID').optional(),
    projectId: uuidString('Invalid project ID').optional(),
  }).refine((q) => !(q.goalId && q.projectId), { message: 'Pass at most one of goalId or projectId' }),
});

export const platformCreateTodoSchema = z.object({
  body: z.object({
    goalId: uuidString('Invalid goal ID'),
    title: z.string().min(1, 'title is required').max(500),
    assigneeChatId: uuidString('Invalid assignee chat ID').optional(),
    dependsOnTodoIds: dependencyIds.optional(),
  }),
});

export const platformPatchTodoSchema = z.object({
  params: idOrPrefixParam,
  body: z.object({
    title: z.string().min(1).max(500).optional(),
    status: todoStatusEnum.optional(),
    blockedReason: z.string().max(2000).optional(),
    assigneeChatId: uuidString('Invalid assignee chat ID').optional().nullable(),
    dependsOnTodoIds: dependencyIds.optional(),
    force: z.boolean().optional(),
  }),
});

export const platformListHooksSchema = z.object({
  query: z.object({
    sourceChatId: uuidString('Invalid source chat ID').optional(),
    targetChatId: uuidString('Invalid target chat ID').optional(),
  }),
});

export const platformSubscribeHookSchema = z.object({
  body: z.object({
    // Omitted/null = owner-scope WILDCARD: every chat the user owns emits to
    // the target (the fleet-supervisor pattern; hooks.service stores NULL).
    sourceChatId: uuidString('Invalid source chat ID').optional().nullable(),
    // PROJECT-SCOPE hook (parity with the hook_subscribe tool, WI-E 2026-09-25):
    // a wildcard bounded to ONE project the caller owns — only chats in that
    // project emit. Mutually exclusive with sourceChatId (the refine below —
    // the same rule platform-tools.ts enforces for the tool); ownership is
    // checked in hooks.service.subscribeHook (404 when not owned).
    projectId: uuidString('Invalid project ID').optional().nullable(),
    targetChatId: uuidString('Invalid target chat ID'),
    eventTypes: z.array(hookEventTypeEnum).min(1, 'at least one event type is required'),
    promptTemplate: z.string().max(8000).optional(),
    debounceSec: z.number().int().min(0).max(3600).optional(),
  }).refine((b) => !(b.projectId && b.sourceChatId), {
    message: 'projectId is mutually exclusive with sourceChatId — a project-scope hook is a wildcard bounded to one project',
    path: ['projectId'],
  }),
});

export const platformPutAutonomySchema = z.object({
  params: idParam,
  body: z.object({
    // Mirror of GRANTABLE_TOOL_NAMES (autonomy.service.ts) — see the note
    // above. = AUTONOMY_GRANTABLE_TOOLS + EXPLICIT_GRANT_ONLY_TOOLS
    // (create_chat_webhook: nameable in a grant, never auto-provisioned —
    // owner ruling oq_d45410a4 / ticket d53eed71). An EMPTY array revokes all
    // autonomy for the chat (setChatAutonomy deletes the row).
    allowedTools: z.array(z.enum(['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule', 'update_schedule', 'dispatch_platform_task', 'send_to_instance', 'create_chat_webhook'])),
    // Max mirrors MAX_SCHEDULE_CAP in autonomy.service.ts (1440 as of
    // 2026-08-08 — effectively uncapped; see the constant's comment).
    scheduleCap: z.number().int().min(1).max(1440).optional(),
  }),
});

// ── Agent tokens ──────────────────────────────────────────────────────────────

export const platformMintTokenSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'name is required').max(100),
    scopes: z.array(z.enum(AGENT_TOKEN_SCOPES)).min(1, 'at least one scope is required'),
    expiresAt: z.string().datetime({ offset: true }).optional(),
  }),
});

export type PlatformMintTokenInput = z.infer<typeof platformMintTokenSchema>['body'];

/** uuid, or a unique ≥8-char hex prefix. Schedules and todos only. */
export const platformIdOrPrefixSchema = z.object({ params: idOrPrefixParam });

/**
 * GET /chats/:id/supervisor-state?section=&query=&limit= (ticket 2b8508cb) —
 * the supervisor's durable state doc over the API: the monitor reads state
 * the 6000-char wake block trims (dispatches, archived directives, notes).
 * `query` additionally runs a semantic search over the embedded
 * `supervisor_state` memory rows (same source the per-turn recall reads).
 */
export const platformSupervisorStateQuerySchema = z.object({
  params: idParam,
  query: z.object({
    section: z.enum(['directives', 'archived', 'dispatches', 'projects', 'notes', 'refutations', 'all']).optional(),
    query: z.string().max(500).optional(),
    limit: z.string().optional().transform((v) => {
      if (v == null || v === '') return undefined;
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) return undefined;
      return Math.min(100, Math.max(1, n));
    }),
  }),
});

/**
 * GET /chats/:id/receipts?runId=&limit= — omitted limit stays the tool
 * default (3); present values clamp 1–50. The executor still caps at 10.
 * runId accepts a durable agent_runs id (uuid) OR a chat turn's telemetry
 * id (chat-<uuid>, ticket e225aad8) — a chat/supervisor turn's receipts
 * resolve over REST the same way they do through the get_run_receipts tool.
 */
export const platformReceiptsQuerySchema = z.object({
  params: idParam,
  query: z.object({
    runId: z.string().regex(/^(chat-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'runId must be a run id (uuid) or a chat-turn id (chat-<uuid>)').optional(),
    limit: z.string().optional().transform((v) => {
      if (v == null || v === '') return undefined;
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) return undefined;
      return Math.min(50, Math.max(1, n));
    }),
  }),
});

/** GET /folders?archived=true|false */
export const platformListFoldersSchema = z.object({
  query: z.object({
    archived: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
  }),
});
