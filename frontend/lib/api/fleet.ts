/**
 * Fleet Management API — the Management section backend
 * (`/api/crossmodel/fleet/*`). All endpoints are JWT-authed via apiClient and
 * reject child accounts server-side (403). Responses are UNWRAPPED (no
 * `{ data }` envelope) — see fleet.controller.ts (`res.json(await service…)`).
 */

import apiClient from '../api-client';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FleetSupervisor {
  id: string;
  title: string;
  running: boolean;
  codeCapable: boolean;
  /** ChatCodingState.status — present only for coding-capable chats. */
  codingStatus?: string;
}

export interface FleetSupervisorResponse {
  /** The caller's auto-provisioned supervisor chat; null when not provisioned yet. */
  supervisor: FleetSupervisor | null;
  /** Optional = old-backend deploy skew: sidebar hides these chats + project folders. */
  hidden?: { chatIds: string[]; projectIds: string[] };
}

export interface FleetHookRow {
  id: string;
  /** Null = wildcard hook listening to ALL chats. */
  sourceChatId: string | null;
  sourceTitle: string | null;
  targetChatId: string;
  targetTitle: string | null;
  eventTypes: string[];
  enabled: boolean;
  debounceSec: number;
  lastFiredAt: string | null;
}

/** One supervisor OFF switch (owner 2026-09-26) — GET /admin/settings/supervisors + fleet/overview.supervisorSwitch. */
export interface SupervisorSwitchTargetState {
  target: 'fleet' | 'project';
  key: 'fleet_supervisor_enabled' | 'project_supervisors_enabled' | string;
  enabled: boolean;
  /** ISO of the last flip write; null = never set (env default in force). */
  since: string | null;
  /** Admin identity that last flipped it; null = never set. */
  updatedBy: string | null;
  /** Machine wakes skipped since the last flip; null = counter unreadable. */
  skipped: number | null;
  source: 'setting' | 'env';
  bootDefault: boolean;
  envVar: string;
}

export interface SupervisorSwitchState {
  fleet: SupervisorSwitchTargetState;
  project: SupervisorSwitchTargetState;
  /** Harness-composed "Fleet supervisor: OFF since … by … — wakes skipped: N"; null when both are ON. */
  line: string | null;
}

/** Refused self-renewals in the window (review-fixer 2026-09-27) — fleet/overview.renewRefusals. */
export interface RenewRefusalSummary {
  hours: number;
  /** Chains the governor STOPPED (no successor armed). */
  refused: number;
  /** Observe-only anchor misses — the successor still armed. */
  observed: number;
  byKind: Record<string, number>;
  chatIds: string[];
  /** Harness-composed "Self-armed watches stopped (last 24 h, harness-measured): N — …"; null when none. */
  line: string | null;
}

export interface FleetOverview {
  supervisor: FleetSupervisor | null;
  /** Optional = old-backend deploy skew / unreadable. Both supervisor OFF switches + the status line. */
  supervisorSwitch?: SupervisorSwitchState | null;
  /** Optional = old-backend deploy skew. Refused self-renewals (governor) in the last 24 h + the harness line. */
  renewRefusals?: RenewRefusalSummary | null;
  counts: {
    chats: number;
    projects: number;
    runningSessions: number;
    enabledSchedules: number;
    /** REAL total (the schedules list is capped at 100 rows). */
    totalSchedules?: number;
    queuedMessages: number;
  };
  projects: Array<{
    id: string;
    name: string;
    color: string | null;
    emoji: string | null;
    /** Optional = old-backend deploy skew. False = opted out of fleet supervision. */
    supervised?: boolean;
    /** Optional = old-backend deploy skew. True = the project's DEDICATED supervisor
     *  agent is enabled (separate from `supervised`'s fleet-wildcard opt-out). */
    projectSupervisorEnabled?: boolean;
    chatCount: number;
    runningCount: number;
    updatedAt: string;
  }>;
  sessions: Array<{
    chatId: string;
    title: string;
    status: string;
    branch: string | null;
    model: string | null;
    /** Optional = old-backend deploy skew: the lane's folder id (null = folderless). */
    projectId?: string | null;
    running: boolean;
    updatedAt: string;
  }>;
  schedules: Array<{
    id: string;
    chatId: string;
    chatTitle: string | null;
    kind: 'once' | 'recurring';
    intervalSec: number | null;
    nextRunAt: string | null;
    enabled: boolean;
    lastStatus: string | null;
    runsCount: number;
    promptSnippet: string;
  }>;
  /** Optional = old-backend deploy skew: supervisor event hooks (null source = wildcard). */
  hooks?: FleetHookRow[];
}

export interface FleetThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  origin: string;
  /** metadata.kind flattened server-side — 'owner_briefing' rows are the
   *  plain-English briefing layer (owner 2026-09-04): regular assistant
   *  bubbles, exempt from the machine-turn accordions. */
  kind?: string;
  /**
   * metadata.childResult flattened server-side (ticket 56d6b204): true on a
   * wake user row delivered by the auto-wired child→parent result hook. The
   * grouping probe reads it off the group's ANCHOR row so the machine turn
   * mounts EXPANDED with a "results" marker — a delivered sub-session result
   * must never hide behind the collapsed accordion.
   */
  childResult?: boolean;
  /**
   * metadata.ownerAskReply flattened server-side (fixer 2026-09-27, finding
   * upward-chatter-1): true on the wake user row of an [OWNER ASK UNANSWERED]
   * re-wake / [FOLLOW-THROUGH] nudge and on its answering assistant row. The
   * grouping probe reads it off the group's ANCHOR row so the machine turn
   * mounts EXPANDED with an "answer" marker — the reply the owner asked for
   * must never hide behind the collapsed accordion.
   */
  ownerAskReply?: boolean;
  /**
   * Attachment chips stamped at send time (filename + type only — never blob
   * content). `localPreview` is CLIENT-ONLY: the optimistic echo bubble fills
   * it with the staged blob URL so thumbnails show before the server row lands.
   * Chips stamped with an uploadId gain fileId + mimeType at read time
   * (ticket c6e8edda — the fleet thread joins the durable ChatFile rows) so
   * image chips render inline via the authed byte routes.
   */
  attachments?: Array<{ filename: string; type: string; uploadId?: string; fileId?: string; mimeType?: string; localPreview?: string }>;
}

export interface FleetThreadPage {  chatId: string;
  running: boolean;
  queuedCount: number;
  /** USER-typed subset of queuedCount (F3, additive — old backends omit it):
   *  drives the honest "answering your message next" status instead of "Idle"
   *  while the owner's send waits in the queue. */
  queuedUserCount?: number;
  /** Chronological within the page; `before` pages backward. */
  messages: FleetThreadMessage[];
  hasMore: boolean;
  nextBefore?: string;
}

/** The dashboard Fleet-summary card's source (platform task 2026-09-03): the
 *  durable transcript's newest machine wake note — single source of truth,
 *  never a second summarizer. note=null when no machine note exists yet.
 *  kind (owner 2026-09-04, additive — old backends omit it): 'briefing' = a
 *  plain-English owner briefing (friendly paragraph rendering), 'wake' = the
 *  technical machine wake note (existing headline+chips parse). */
export interface FleetLatestSummary {
  chatId: string | null;
  note: { id: string; createdAt: string; content: string; kind?: 'briefing' | 'wake' } | null;
}

export interface FleetSendResult {
  queued: boolean;
  /** Queue position — present only when queued (HTTP 202). */
  position?: number;
}

export interface FleetLogRow {
  at: string;
  kind: 'user_message' | 'machine_wake' | 'agent_message' | 'supervisor_reply';
  from: string;
  to: string;
  summary: string;
  chatId?: string;
  sourceId: string;
}

export interface FleetLogPage {
  /** Newest-first. Field name matches the backend getFleetLog response. */
  messages: FleetLogRow[];
  hasMore: boolean;
  nextBefore?: string;
}

// ── Schedules tab (GET /fleet/schedules — every schedule the caller owns) ────

export interface FleetScheduleRow {
  id: string;
  chatId: string;
  /** Null = the chat was deleted (the schedule row lingers until GC). */
  chatTitle: string | null;
  kind: 'once' | 'recurring';
  intervalSec: number | null;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastStatus: string | null;
  runsCount: number;
  maxRuns: number | null;
  expiresAt: string | null;
  enabled: boolean;
  /** First 140 chars of the fired prompt. */
  promptSnippet: string;
  /** Raw cadence projection (ticket 2694a581): firings/day if every tick fires; null for one-shots. */
  projectedDailyFirings: number | null;
  /** Signed per-firing clock drift in minutes (ticket 903249e5): negative = each
   *  firing lands EARLIER than the last (a ≥12h non-day-aligned cadence marches
   *  around the clock); 0 = day-aligned; null for one-shots. */
  clockDriftMinutes: number | null;
  /** Projected next 3 firings, ISO (ticket 903249e5); null for one-shots. */
  projectedNextFirings: string[] | null;
}

// ── Project digests (GET /fleet/digests — the hourly cron's stored rows) ──────

export type FleetDigestStatus = 'blocked' | 'needs_attention' | 'on_track' | 'idle';

export type FleetDigestAttentionKind =
  | 'blocked_goal'
  | 'blocked_todo'
  | 'awaiting_input'
  | 'failed_run'
  | 'stuck_message'
  | 'schedule_error'
  | 'session_error'
  | 'stalled_session';

export interface FleetDigestAttentionItem {
  kind: FleetDigestAttentionKind;
  /** Human label: the goal/todo title, chat title, or schedule prompt snippet. */
  title: string;
  /** Why: blockedReason, run error, schedule lastStatus, session errorMessage… */
  detail: string | null;
  /** Drill-down ids (present iff relevant to the kind). */
  chatId?: string;
  goalId?: string;
  todoId?: string;
  runId?: string;
  scheduleId?: string;
  /** ISO timestamp of the underlying signal (stable across sweeps). */
  at: string;
  /**
   * Silence key ("{kind}:{ref|title}") — attached by the backend; stable across
   * the hourly regenerations. Optional only for deploy skew with an old backend.
   */
  key?: string;
  /** Present (true) only on acked items, and only when fetched with showAcked. */
  acknowledged?: boolean;
  /** Snooze expiry (ISO) when the ack is a timed snooze rather than indefinite. */
  snoozeUntil?: string;
}

export interface FleetDigestStats {
  chatCount: number;
  activeChats: number;
  messages: {
    total: number;
    user: number;
    assistant: number;
    byOrigin: Record<string, number>;
  };
  runs: { started: number; completed: number; failed: number; active: number };
  todos: { total: number; done: number; blocked: number; createdInWindow: number; completedInWindow: number };
  goals: {
    total: number;
    done: number;
    blocked: number;
    createdInWindow: number;
    completedInWindow: number;
    /** Terminal goals with status 'archived' (done counted above) — ticket 7ee38c8e. */
    archived: number;
    /** YYYY-MM-DD (UTC) of the newest terminal goal's updatedAt; null = none. */
    lastFinishedAt: string | null;
  };
  schedules: { firedInWindow: number; errored: number };
  queuedMessages: number;
}

// ── Project Pulse (owner 2026-09-04): goal progress + honest computed ETA ─────

/** Ticket C1 (2026-09-27): 'held' (the goal's own or the freshest OPEN todo's
 *  progress note LEADS with a HOLD/HELD/BLOCKED/ON HOLD marker and does not
 *  say it was lifted — a fact about the note, rendered "held per note", never
 *  an owner-set status) and 'behind_deadline' (the pace projection overshoots
 *  a registered deadline premise) joined the ladder — done > blocked > held >
 *  behind_deadline > on_pace > no_movement. */
export type FleetGoalEtaClass = 'on_pace' | 'no_movement' | 'blocked' | 'held' | 'behind_deadline' | 'done'
  // GOAL-UNPLANNED (2026-10-20): an ACTIVE goal with zero open todos — "needs a plan", never "done".
  | 'unplanned';

/** Ticket C1: the nearest deadline premise on the goal (server-computed). */
export interface FleetGoalEtaDeadline {
  key: string;
  /** ISO instant of the deadline. */
  at: string;
  /** Days left at sweep time (negative = passed); display only, never re-derived. */
  daysLeft: number;
}

export interface FleetGoalEta {
  /** Todos still open (total - done). */
  remaining: number;
  /** Completions per day over the trailing week (computed server-side). */
  pacePerDay: number;
  /** remaining / pacePerDay (1 decimal); null when pace is 0 or nothing remains. */
  etaDays: number | null;
  class: FleetGoalEtaClass;
  /** Present only when a deadline premise is registered on the goal. */
  deadline?: FleetGoalEtaDeadline;
}

export interface FleetDigestGoalProgress {
  goalId: string;
  title: string;
  /** The goal row's status — only 'active' | 'blocked' goals are tracked. */
  status: string;
  todosDone: number;
  todosTotal: number;
  /** Blocked todos under this goal (gates the ETA class). */
  blockedCount: number;
  /** Todos completed in the trailing 24h / 7d (done-row updatedAt proxy). */
  completed24h: number;
  completed7d: number;
  eta: FleetGoalEta;
}

export interface FleetDigestEtaSummary {
  goalsTracked: number;
  goalsBlocked: number;
  todosDone: number;
  todosTotal: number;
  todosRemaining: number;
  blockedCount: number;
  pacePerDay: number;
  etaDays: number | null;
  class: FleetGoalEtaClass;
  /** Ticket C1: the deadline the rollup class was judged against, when any goal carries one. */
  deadline?: FleetGoalEtaDeadline;
}

export interface FleetDigest {
  /** Null = the "Ungrouped" bucket (chats without a project). */
  projectId: string | null;
  /** 'Ungrouped' when projectId is null; 'Unknown project' when deleted. */
  projectName: string;
  status: FleetDigestStatus;
  summary: string;
  attentionItems: FleetDigestAttentionItem[];
  stats: FleetDigestStats;
  /** Project Pulse per-goal facts. Optional only for deploy skew with an old backend. */
  goalProgress?: FleetDigestGoalProgress[];
  /** Project-level ETA rollup; null = no active/blocked goals (incl. Ungrouped). */
  etaSummary?: FleetDigestEtaSummary | null;
  /** When the digest CONTENT was last (re)written — the honest text age (signature-skip does not move it). */
  generatedAt: string;
  /** Pipeline liveness: the hourly sweep touches this even when the content is unchanged — drives the stale hint (f3256715). */
  updatedAt: string;
}

export interface FleetDigestsResponse {
  /** Pre-sorted by severity (blocked first), most-recent first within a severity. */
  digests: FleetDigest[];
}

// ── API ───────────────────────────────────────────────────────────────────────

// ── Fleet Pulse (management dashboard hero digest) ────────────────────────────

export interface FleetPulsePr {
  number: number;
  title: string;
  state: 'merged' | 'open' | 'closed';
  at: string;
}

export interface FleetPulse {
  generatedAt: string;
  shipping: {
    mergedToday: number;
    openPrs: number;
    recent: FleetPulsePr[];
    latestDeploy: { status: string; conclusion: string | null; at: string; url: string } | null;
    repo: string;
  } | null;
  queue: {
    open: number;
    inProgress: number;
    doneToday: number;
    doneTotal: number;
    openList: Array<{ id: string; title: string; status: string; type: string; source: string; createdAt: string }>;
  } | null;
  /** Evidence-guard health (catch counts, receipt rollups) — ADMIN-only internals
   *  (ticket 24dd04d5): null for a non-admin viewer; the dashboard hides the tile. */
  guard: {
    catches24h: number;
    lastCatchAt: string | null;
    /** run_tool_receipts 24h rollup — absent on old backends / rollup errors; hide the line then. */
    receipts?: { total24h: number; failed24h: number; topTools24h: string[] };
  } | null;
}

export const fleetApi = {
  /** The caller's auto-provisioned fleet supervisor chat (null while still provisioning). */
  getSupervisor: async (): Promise<FleetSupervisorResponse> => {
    const response = await apiClient.get('/crossmodel/fleet/supervisor');
    return response.data;
  },

  /** Fleet-wide counts + summary rows for the Dashboard tab. */
  getOverview: async (opts?: { signal?: AbortSignal }): Promise<FleetOverview> => {
    const response = await apiClient.get('/crossmodel/fleet/overview', { signal: opts?.signal });
    return response.data;
  },
  /** One-glance pulse: PRs/deploy + ticket queue (admin sections) + guard health. */
  getPulse: async (opts?: { signal?: AbortSignal }): Promise<FleetPulse> => {
    const response = await apiClient.get('/crossmodel/fleet/pulse', { signal: opts?.signal });
    return response.data;
  },

  /**
   * Cancel (disable) one of the caller's schedules from the Dashboard. The row
   * stays (audited, reversible by re-scheduling); 404 when it's not the
   * caller's.
   */
  cancelSchedule: async (id: string): Promise<{ ok: boolean }> => {
    const response = await apiClient.post(`/crossmodel/fleet/schedules/${id}/cancel`);
    return response.data;
  },

  /** Supervisor transcript. Interactive-only by default (machine noise excluded server-side); pass includeMachine to see machine-triggered turns. */
  getSupervisorThread: async (params?: { before?: string; limit?: number; includeMachine?: boolean }): Promise<FleetThreadPage> => {
    const response = await apiClient.get('/crossmodel/fleet/supervisor/thread', { params });
    return response.data;
  },

  /** The dashboard Fleet-summary card: the supervisor chat's newest machine wake note, parsed server-side from the durable transcript. */
  getLatestSupervisorSummary: async (opts?: { signal?: AbortSignal }): Promise<FleetLatestSummary> => {
    const response = await apiClient.get('/crossmodel/fleet/supervisor/latest-summary', { signal: opts?.signal });
    return response.data;
  },

  /**
   * Send a user message to the supervisor. 200 { queued: false } when a run
   * started immediately; 202 { queued: true, position } when enqueued behind a
   * busy run (axios treats 202 as success — no special handling needed).
   * uploadIds: staged /crossmodel/upload ids — a BUSY supervisor 409s instead
   * of queueing (the text-only queue would silently drop the files); surface
   * the error and leave the composer's attachment bar untouched.
   */
  sendSupervisorMessage: async (content: string, uploadIds?: string[]): Promise<FleetSendResult> => {
    const response = await apiClient.post('/crossmodel/fleet/supervisor/messages', {
      content,
      ...(uploadIds?.length ? { uploadIds } : {}),
    });
    return response.data;
  },

  /** The merged raw log (transcript + agent audits), newest-first. */
  getFleetLog: async (params?: { before?: string; limit?: number }, opts?: { signal?: AbortSignal }): Promise<FleetLogPage> => {
    const response = await apiClient.get('/crossmodel/fleet/log', { params, signal: opts?.signal });
    return response.data;
  },

  /**
   * Every schedule the caller owns (enabled first, then by next firing) with
   * full lifecycle fields — the Schedules tab's full-page list. The Dashboard
   * keeps its own 100-row overview slice; this is the standalone inventory.
   */
  getSchedules: async (opts?: { signal?: AbortSignal }): Promise<{ schedules: FleetScheduleRow[] }> => {
    const response = await apiClient.get('/crossmodel/fleet/schedules', { signal: opts?.signal });
    return response.data;
  },

  /**
   * The stored hourly per-project digests (severity-sorted). READ-ONLY — rows
   * are written by the worker's hourly project-digest cron, never computed here.
   * Acknowledged attention items are excluded by default; showAcked returns them
   * flagged `acknowledged` (+ snoozeUntil when the silence is a timed snooze).
   */
  getDigests: async (opts?: { showAcked?: boolean; signal?: AbortSignal }): Promise<FleetDigestsResponse> => {
    const response = await apiClient.get('/crossmodel/fleet/digests', {
      params: opts?.showAcked ? { showAcked: 1 } : undefined,
      signal: opts?.signal,
    });
    return response.data;
  },

  /**
   * Silence one digest attention item (alertmanager-style): the ack lives
   * server-side in digest_item_acks keyed by the item's stable key, so it
   * survives the hourly digest regeneration. snoozeHours → timed snooze (the
   * item resurfaces when it lapses); omitted → indefinite ack.
   */
  ackDigestItem: async (
    key: string,
    snoozeHours?: number,
  ): Promise<{ success: boolean; key: string; snoozeUntil: string | null }> => {
    const response = await apiClient.post('/crossmodel/fleet/digests/ack', {
      key,
      ...(snoozeHours !== undefined ? { snoozeHours } : {}),
    });
    return response.data;
  },

  /** Lift a digest-item silence (idempotent). The key is percent-encoded (titles can hold '/'). */
  unackDigestItem: async (key: string): Promise<{ success: boolean }> => {
    const response = await apiClient.delete(`/crossmodel/fleet/digests/ack/${encodeURIComponent(key)}`);
    return response.data;
  },
};
