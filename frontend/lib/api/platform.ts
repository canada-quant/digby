import apiClient from '../api-client';
import type { CrossModelChat } from './crossmodel';

/**
 * Platform unification (P3) — external platform API + scoped agent tokens.
 * The UI only needs the token-management endpoints (JWT-only); the rest of the
 * platform surface is for external agents/scripts (see docs/DIGBY_PLATFORM_API.md).
 */

export type AgentTokenScope =
  | 'chats:read'
  | 'chats:write'
  | 'folders:read'
  | 'folders:write'
  | 'schedules:write'
  | 'code:run';

export interface AgentTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string; // "dgt_ab12cd34" — display only
  scopes: AgentTokenScope[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface MintedAgentToken extends Omit<AgentTokenSummary, 'lastUsedAt' | 'revokedAt'> {
  /** The RAW token — returned exactly once at mint; never retrievable again. */
  token: string;
}

export const agentTokensApi = {
  list: async (): Promise<AgentTokenSummary[]> => {
    const r = await apiClient.get('/crossmodel/platform/tokens');
    return r.data.tokens;
  },
  mint: async (body: { name: string; scopes: AgentTokenScope[]; expiresAt?: string }): Promise<MintedAgentToken> => {
    const r = await apiClient.post('/crossmodel/platform/tokens', body);
    return r.data;
  },
  revoke: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/platform/tokens/${id}`);
  },
};

// ── Fleet supervisor (mission control) ────────────────────────────────────────
// Mirrors backend/src/modules/crossmodel/platform/platform.routes.ts (slice D):
// goals/todos are folder-scoped, hooks + autonomy chat-scoped. Goal/todo writes
// return the updated view; 'done' transitions 409 on unmet deps unless
// force: true. There is no delete for goals/todos — archive instead.

export type FleetGoalStatus = 'active' | 'blocked' | 'done' | 'archived';
export type FleetTodoStatus = 'pending' | 'in_progress' | 'blocked' | 'done'
  // DROPPED is terminal owner-cancelled work and IS emitted by the backend
  // (`todo_update` status 'dropped'); it was missing from this union, so a
  // dropped row typed as an unknown string at every consumer.
  | 'dropped';

/** Todo summary embedded in goal list/detail responses (no dep arrays). */
export interface FleetGoalTodoSummary {
  id: string;
  title: string;
  status: FleetTodoStatus;
}

export interface FleetGoal {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: FleetGoalStatus;
  blockedReason: string | null;
  createdByChatId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Embedded todo summaries (list + detail responses). */
  todos: FleetGoalTodoSummary[];
  /** Goals this goal waits on (list response). */
  dependsOnGoalIds: string[];
  /** Goals waiting on THIS goal (list response). */
  dependentGoalIds: string[];
  /** Owning project's name — present on the account-wide listing (listGoals
   *  with NO projectId, Phase D fleet panel); absent on project-scoped calls. */
  projectName?: string | null;
}

export interface FleetTodo {
  id: string;
  goalId: string;
  projectId: string;
  title: string;
  status: FleetTodoStatus;
  blockedReason: string | null;
  assigneeChatId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  dependsOnTodoIds: string[];
}

export type FleetHookEventType =
  | 'run_completed'
  | 'run_failed'
  | 'attention_needed'
  | 'goal_blocked'
  | 'todo_done'
  | 'schedule_cap_skipped'
  | 'schedule_disabled'
  | 'schedule_near_cap';

export const FLEET_HOOK_EVENT_TYPES: FleetHookEventType[] = [
  'run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'todo_done', 'schedule_cap_skipped', 'schedule_disabled', 'schedule_near_cap',
];

export interface FleetHook {
  id: string;
  sourceChatId: string;
  targetChatId: string;
  eventTypes: string[];
  promptTemplate: string;
  enabled: boolean;
  debounceSec: number;
  lastFiredAt: string | null;
  createdAt: string;
}

/** The consequential tools a chat may be granted autonomy for (mirrors backend AUTONOMY_GRANTABLE_TOOLS). */
export type FleetAutonomyTool =
  | 'send_chat_message' | 'start_coding_session' | 'schedule_message'
  | 'cancel_schedule' | 'update_schedule' | 'dispatch_platform_task'
  | 'send_to_instance';

export const FLEET_AUTONOMY_TOOLS: FleetAutonomyTool[] = [
  'send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule', 'update_schedule',
  'dispatch_platform_task', 'send_to_instance',
];

/** The maximum scheduled firings per day a grant can allow (backend MAX_SCHEDULE_CAP) — the "full access" switch grants this. */
export const FLEET_MAX_SCHEDULE_CAP = 1440;

/**
 * Grant provenance (backend AUTONOMY_SOURCE_*): 'manual' = owner-curated via
 * this dialog / the set_chat_autonomy tool; 'agent_mode_auto' = granted
 * automatically because the coding chat's Agent mode is Auto (owner 2026-09-07)
 * — revoked when the mode leaves Auto, converted to 'manual' by any manual save.
 */
export type FleetAutonomySource = 'manual' | 'agent_mode_auto';

export interface FleetAutonomyGrant {
  chatId: string;
  allowedTools: string[];
  scheduleCap: number;
  source?: FleetAutonomySource;
}

export interface FleetAutonomyPutResult {
  granted: boolean;
  chatId: string;
  allowedTools: string[];
  scheduleCap: number | null;
  source?: FleetAutonomySource | null;
}

/** A scheduled run (mirrors backend UserScheduleView — schedule.service.ts), including the Phase-2 daily-cap state. */
export interface FleetSchedule {
  id: string;
  sessionId: string;
  kind: string;                    // 'once' | 'recurring'
  prompt: string;
  intervalSec: number | null;
  nextRunAt: string;
  enabled: boolean;
  runsCount: number;
  maxRuns: number | null;
  expiresAt: string | null;
  lastFiredAt: string | null;
  lastStatus: string | null;       // 'fired' | 'skipped:daily_cap' | 'cancelled' | 'expired' | …
  cancelledBy: string | null;      // who disabled the row ('owner' | 'machine'); null while enabled/resumed
  disabledAt: string | null;       // when the row was last disabled (ISO); null while enabled/resumed
  dailyFiresUsed: number | null;   // null when the Redis counter is unreadable
  dailyCapLimit: number;
  capWindowResetsAt: string | null;
  projectedDailyFirings: number | null; // raw cadence projection (ticket 2694a581); null for one-shots
  clockDriftMinutes: number | null;     // signed per-firing drift, min (ticket 903249e5); 0 = day-aligned; null for one-shots
  projectedNextFirings: string[] | null; // next 3 projected firings, ISO (ticket 903249e5); null for one-shots
}

/** Minimal chat row for id→title maps (GET /platform/chats?limit=50). */
export interface FleetChatRef {
  id: string;
  title: string;
}

export const fleetApi = {
  // ── Chats ──
  /**
   * The caller's chats (newest first, cap 50 — the platform list endpoint's
   * page shape is `{ chats, pagination }`; rows are mapped down to the minimal
   * id/title pair the dashboards need for id→title lookups).
   */
  listChats: async (opts?: { signal?: AbortSignal }): Promise<FleetChatRef[]> => {
    const r = await apiClient.get('/crossmodel/platform/chats', { params: { limit: 50 }, signal: opts?.signal });
    const rows = Array.isArray(r.data?.chats) ? r.data.chats : [];
    return rows.map((c: { id: string; title?: string | null }) => ({ id: c.id, title: c.title ?? '' }));
  },
  /**
   * Nudge a lane: POST a user message into the chat's queue (owner-scoped;
   * the lane picks it up on its next turn). 202 Accepted — nothing to return.
   */
  nudgeChat: async (chatId: string, content: string): Promise<void> => {
    await apiClient.post(`/crossmodel/platform/chats/${chatId}/messages`, { content });
  },

  // ── Goals ──
  // projectId optional (Phase D widening): omitted = account-wide listing of
  // every owned project, with rows tagged `projectName` (backend already
  // treats the param as optional — this only widens the client signature).
  listGoals: async (projectId?: string, opts?: { includeDescendants?: boolean; status?: FleetGoalStatus; signal?: AbortSignal }): Promise<FleetGoal[]> => {
    const r = await apiClient.get('/crossmodel/platform/goals', {
      params: {
        ...(projectId ? { projectId } : {}),
        ...(opts?.includeDescendants ? { includeDescendants: 'true' } : {}),
        ...(opts?.status ? { status: opts.status } : {}),
      },
      signal: opts?.signal,
    });
    return r.data.goals || [];
  },
  createGoal: async (body: { projectId: string; title: string; description?: string; dependsOnGoalIds?: string[] }): Promise<FleetGoal> => {
    const r = await apiClient.post('/crossmodel/platform/goals', body);
    return r.data;
  },
  updateGoal: async (id: string, body: {
    title?: string; description?: string; status?: FleetGoalStatus; blockedReason?: string;
    dependsOnGoalIds?: string[]; force?: boolean;
  }): Promise<FleetGoal> => {
    const r = await apiClient.patch(`/crossmodel/platform/goals/${id}`, body);
    return r.data;
  },

  // ── Todos (exactly one of goalId|projectId — server-enforced) ──
  listTodos: async (filter: { goalId: string } | { projectId: string }): Promise<FleetTodo[]> => {
    const r = await apiClient.get('/crossmodel/platform/todos', { params: filter });
    return r.data.todos || [];
  },
  createTodo: async (body: { goalId: string; title: string; assigneeChatId?: string; dependsOnTodoIds?: string[] }): Promise<FleetTodo> => {
    const r = await apiClient.post('/crossmodel/platform/todos', body);
    return r.data;
  },
  updateTodo: async (id: string, body: {
    title?: string; status?: FleetTodoStatus; blockedReason?: string;
    assigneeChatId?: string | null; dependsOnTodoIds?: string[]; force?: boolean;
  }): Promise<FleetTodo> => {
    const r = await apiClient.patch(`/crossmodel/platform/todos/${id}`, body);
    return r.data;
  },

  // ── Hooks ──
  listHooks: async (filter?: { sourceChatId?: string; targetChatId?: string }): Promise<FleetHook[]> => {
    const r = await apiClient.get('/crossmodel/platform/hooks', { params: filter });
    return r.data.hooks || [];
  },
  createHook: async (body: {
    sourceChatId: string; targetChatId: string; eventTypes: FleetHookEventType[];
    promptTemplate?: string; debounceSec?: number;
  }): Promise<FleetHook> => {
    const r = await apiClient.post('/crossmodel/platform/hooks', body);
    return r.data;
  },
  deleteHook: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/platform/hooks/${id}`);
  },

  // ── Autonomy (GET 404s when no grant exists) ──
  getAutonomy: async (chatId: string): Promise<FleetAutonomyGrant> => {
    const r = await apiClient.get(`/crossmodel/platform/chats/${chatId}/autonomy`);
    return r.data;
  },
  /** Empty allowedTools revokes the grant. */
  putAutonomy: async (chatId: string, body: { allowedTools: FleetAutonomyTool[]; scheduleCap?: number }): Promise<FleetAutonomyPutResult> => {
    const r = await apiClient.put(`/crossmodel/platform/chats/${chatId}/autonomy`, body);
    return r.data;
  },

  // ── Fleet Supervisor (global) ──
  /** Idempotently create+return the caller's ONE global "Fleet Supervisor" chat (full autonomy pre-granted server-side, wildcard-hooked to every chat). No body. */
  ensureSupervisor: async (): Promise<CrossModelChat> => {
    const r = await apiClient.post('/crossmodel/platform/supervisor/ensure');
    return r.data;
  },

  // ── Schedules (the user's scheduled runs across every chat, with cap state) ──
  listSchedules: async (): Promise<FleetSchedule[]> => {
    const r = await apiClient.get('/crossmodel/platform/schedules');
    return r.data.schedules || [];
  },
  cancelSchedule: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/platform/schedules/${id}`);
  },
};
