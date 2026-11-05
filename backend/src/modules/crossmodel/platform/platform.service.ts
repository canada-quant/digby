/**
 * Platform unification (P1) — ONE service layer for platform operations.
 *
 * Everything a user can do in the UI (chat CRUD/move/archive/delete, project
 * CRUD, coding-session start, schedules) funnels through here, so the HTTP
 * controllers, the in-loop platform tools (platform-tools.ts), and the later
 * REST API (P3) share exactly ONE authorization + validation implementation.
 *
 * Authorization model (mirrors the pre-P1 controllers exactly):
 *   - Chats: owner-scoping; shared-project access via ProjectMember role
 *     (viewer → read ops only; editor/admin → write ops). Move + delete stay
 *     owner-only (crossModelService.getChatAccess / updateChat / deleteChat).
 *   - Projects: mutations owner or editor/admin member (viewer blocked);
 *     delete is owner-only. (projects.controller getProjectForUser semantics.)
 *   - Coding sessions: project owner-only (coding-data.service getCodingProjectForUser).
 *   - Schedules: chat-owner only (a scheduled run executes with the CHAT
 *     OWNER's identity and tools — letting a project member schedule one
 *     would be a confused deputy).
 *
 * Act-as-user: every function takes `userId` — the authenticated HTTP user or
 * the agent run's ToolContext.userId. No tokens exist in-loop.
 *
 * Audit: every successful mutation writes an Activity row (resource 'platform'),
 * best-effort — an audit failure never fails the mutation.
 */

import { randomUUID } from 'crypto';
import { isFrameworkProjectRow, instanceOwnRepoSlugSoft, frameworkGuardMessage, type FrameworkGuardAction } from './framework-project';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import type { AgentAttachment } from '../chat-agent/chat-gate';
import crossModelService from '../crossmodel.service';
import { PatienceMode, AUTO_MODE, RoutableLevel, normalizePatienceMode, PATIENCE_MODES, storedModeToPreset } from '../types';
// 2026-09-26 audit (unify-routing): THE per-send level resolver shared with the
// stream controller and Telegram, plus the deep-research reserve for this seam.
import { resolveSendMode, demoteForQuota, type SendRouting } from './send-mode';
import { reserveDeepResearchQuota } from '../rate-limit.service';
import { LOOP_METRIC_KINDS, recordLoopMetric } from './loop-metrics.service';
import { agentSendHeader, isAgentSendHeader, ownerDispatchEligible, ownerDispatchHeader } from './agent-send-header';
import {
  getCodingProjectForUser,
  createCodingChat,
  findPriorSession,
  updateSessionState,
  resolveStampedCodingModelDetailed,
  toLegacyProject,
  CodingProjectShape,
  CodingSessionShape,
  capabilityFrom,
} from '../coding/coding-data.service';
import {
  foldersInheritanceOn,
  getAncestorChain,
  getNearestWorkspaceFolder,
  MAX_FOLDER_DEPTH,
} from './folder-inheritance';
import { relocateFolderChildren } from './folder-tree-ops';
import { stashPendingFirstPrompt, deliverPendingFirstPrompt, PROVISIONING_FAILED_PREFIX } from './first-prompt-recovery';
import type { FirstPromptOrigin } from './first-prompt-recovery';
import { isPermissionModeExplicit, resolveSpawnPermissionMode } from './human-spawn';
import { isWriterRole, spawnAccessRefusal, spawnMemberAccessDisabled } from './shared-project-access';
import { stampDisplayParent } from './display-parent';
import { redactGuardChromeMessage } from '../guard-chrome-redact';
import { sessionBranchName } from '../coding/workspace.service';
import {
  createSchedule,
  listSchedulesForUser,
  getScheduleForUser,
  cancelScheduleForUser,
  cancelSchedule as cancelScheduleForSession,
  setScheduleEnabledForChat,
  updateScheduleForUser,
  deafLaneWarningForUser,
  UserScheduleView,
  ScheduleView,
} from '../coding/schedule.service';
// The near-cap predicate rides the dependency-free module (ticket b4d1096c) —
// no need to grow THIS file's schedule.service import edge for a pure fn.
import { scheduleNearCapCause } from '../coding/schedule-near-cap';
import { getPlan } from '../coding/plan.service';
import { isRunActive } from '../coding/live-runs';
import { publishChatListEvent } from './chat-events';
import { archiveCascadeDisabled, readLaneFamilyFacts, rememberLaneRestore, readLaneKeepReasons, proveMachineSpawned, LANE_HUMAN_WINDOW_MS, type LaneKeepReason, type RestoreAuditCache } from './lane-family-facts';
import { isChatBusy } from '../chat-agent/chat-busy';
import { getProjectSettings, setProjectSettings } from '../langgraph/memory.graph';
import { validateFiles, SessionFilePayload } from '../coding/chat-files';

// Same mode set coding.controller.ts uses for session creation. (The model
// set is gone — session model stamping is registry-aware via coding-data's
// resolveStampedCodingModel, ticket 68b1aba3.)
// PERMISSION_MODES moved to platform/human-spawn.ts (PERMISSION_MODE_VALUES) — the ONE spawn-mode resolver.

// ── Audit ─────────────────────────────────────────────────────────────────────

/** Best-effort audit trail for platform mutations (Activity, resource 'platform'). */
async function audit(userId: string, action: string, metadata?: Record<string, any>): Promise<void> {
  try {
    await prisma.activity.create({
      data: { userId, action, resource: 'platform', ...(metadata ? { metadata } : {}) },
    });
  } catch (err: any) {
    logger.warn(`platform audit write failed (${action}): ${err.message}`);
  }
}

// ── Shared access helpers ─────────────────────────────────────────────────────

type ProjectRole = 'owner' | 'viewer' | 'editor' | 'admin';

/**
 * Framework-surface helpers (ticket 9471d338): the platform's OWN project —
 * the workspace repoUrl names the instance's own repo — is a hardened
 * Management surface, not a user folder. Identity + the guard message come
 * from the pure leaf; the own-repo slug is computed here once per call (the
 * guards are mutation-frequency paths, a fresh resolve keeps prod-env reads
 * honest under the kill switch).
 */
export function isFrameworkProject(project: any): boolean {
  return isFrameworkProjectRow(project, instanceOwnRepoSlugSoft());
}

/** The refusal message for a framework-surface mutation — every guard below throws it. */
export function frameworkProjectRefusal(action: FrameworkGuardAction): string {
  return frameworkGuardMessage(action);
}

const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
/** rank (1-4) → role (index 0 unused). */
const RANK_ROLE: ProjectRole[] = ['viewer', 'viewer', 'editor', 'admin', 'owner'];

/**
 * Project access for a user (mirrors projects.controller.getProjectForUser):
 * owner → 'owner'; member → their role; otherwise null (treated as 404 so
 * existence isn't leaked).
 *
 * P2 ancestor inheritance (FOLDERS_INHERITANCE, default on): the explicit
 * member row on the folder itself is checked first; then the effective role
 * becomes max(own row, nearest ancestor row) with rank viewer<editor<admin,
 * and the owner of ANY ancestor folder gets full ('owner') access to the
 * whole subtree. Flag off → exact pre-P2 behavior (leaf row only).
 *
 * Exported: crossmodel.service.updateChat authorizes the DESTINATION project
 * of a chat move with this exact check (via dynamic import — this module
 * statically imports crossmodel.service, so a static edge would cycle).
 */
export async function getProjectAccess(projectId: string, userId: string): Promise<{ project: any; role: ProjectRole } | null> {
  const project = await prisma.crossModelProject.findUnique({
    where: { id: projectId },
    include: { members: true },
  });
  if (!project) return null;
  if (project.userId === userId) return { project, role: 'owner' };
  const member = (project.members as Array<{ userId: string; role: string }>).find((m) => m.userId === userId);
  let rank = member ? (ROLE_RANK[member.role as ProjectRole] ?? 0) : 0;
  if (foldersInheritanceOn()) {
    const chain = await getAncestorChain(projectId);
    const ancestors = chain.slice(0, -1); // root…parent (leaf = project itself)
    if (ancestors.some((f) => f.userId === userId)) return { project, role: 'owner' };
    if (ancestors.length) {
      const rows = await prisma.projectMember.findMany({
        where: { userId, projectId: { in: ancestors.map((f) => f.id) } },
        select: { role: true },
      });
      for (const r of rows) rank = Math.max(rank, ROLE_RANK[r.role as ProjectRole] ?? 0);
    }
  }
  if (!rank) return null;
  return { project, role: RANK_ROLE[rank] };
}

/**
 * chat-agent modes accepted by runChatAgentTurn. P4: retired modes alias here
 * too — `fast`/`single` → `single_thinking`, `deep_research_all` (L4) →
 * `deep_research` — so an old chat stored with a retired level runs its P4
 * successor; anything unrecognized falls back to L1 (unchanged behavior).
 */
function normalizeChatAgentMode(mode: string): RoutableLevel {
  // 2026-09-26: a stored 'auto' resolves to the L2 preset fallback here (a
  // machine sender cannot route per send) — types.ts storedModeToPreset.
  return storedModeToPreset(mode);
}

// ── Chats ─────────────────────────────────────────────────────────────────────

export type ListChatsFilters = {
  /** Case-insensitive title substring (DB-level). */
  q?: string;
  /** Folder/project id (DB-level). */
  projectId?: string;
  /** Stored chat mode (DB-level). */
  mode?: string;
  /** true = the Archived browse view (own stamped chats only). Default lists exclude archived rows (DB-level). */
  archived?: boolean;
  /**
   * Sidebar live delta (ticket 6201e0ee): include rows REGARDLESS of archive
   * state — the push-kicked /chats/changes must see another lane's archive
   * (the stamped row just left the DEFAULT list, and the feed's whole job is
   * to report rows that changed; the client filters what it renders). Only
   * meaningful together with updatedAfter; never with `archived`.
   */
  archivedAny?: boolean;
  /** Coding satellite status: provisioning | ready | running | error | archived (derived). */
  status?: string;
  /** Live-run registry state (derived). */
  running?: boolean;
  /** Coding capability — satellite attached or workspace in the folder chain (derived). */
  codeCapable?: boolean;
  /** Sidebar live refresh (ticket d6b2eef5): only rows with updatedAt ≥ this instant (DB-level). */
  updatedAfter?: Date;
  /**
   * SUPERVISION SCOPE (ticket 03d14b78) — projects to SUBTRACT from this read
   * (DB-level, applied to every arm: default, archived and derived-filter).
   * The Fleet Supervisor's machine-run tool reads pass the owner's opted-out
   * (`supervised:false`) project ids here so an opted-out project's chats never
   * reach a model-facing envelope. Absent/empty ⇒ byte-identical behaviour for
   * every other caller (the REST API, sidebar polls, ordinary chats).
   */
  excludeProjectIds?: readonly string[];
};

/**
 * List chats visible to the user (own + member projects). Same shape as the HTTP API.
 *
 * Two-tier filtering (P6 fleet-supervisor):
 *   - DB-level (q / projectId / mode) pushes into crossModelService.listChats'
 *     WHERE clause, so pagination stays correct at any fleet size.
 *   - Derived filters (running / codeCapable / coding status) depend on the
 *     live-run registry + satellite table, so they fetch the whole DB-narrowed
 *     set (bounded — a user's visible fleet is small; the cap guards a
 *     pathological shared folder), enrich, filter, and paginate in memory.
 * Every returned row is annotated with `running` (a cheap in-memory registry
 * check), so a supervisor can see fleet state in ONE call.
 */
export async function listChats(opts: { userId: string; page?: number; limit?: number } & ListChatsFilters) {
  const { userId } = opts;
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(200, Math.max(1, opts.limit ?? 20));
  const dbFilters = {
    ...(opts.q ? { q: opts.q } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.archived ? { archived: true } : {}), // Archived browse view; default excludes archived rows
    ...(opts.updatedAfter ? { updatedAfter: opts.updatedAfter } : {}), // sidebar delta poll watermark
    ...(opts.archivedAny ? { archivedAny: true } : {}), // sidebar delta poll sees just-archived rows (6201e0ee)
    // SUPERVISION SCOPE (ticket 03d14b78) — MUST be projected here: this literal
    // is the ONLY filter payload crossModelService.listChats ever sees, so a
    // field declared on ListChatsFilters but missing from this object is
    // silently dropped and the scope filter becomes a no-op (review finding 1).
    ...(opts.excludeProjectIds?.length ? { excludeProjectIds: opts.excludeProjectIds } : {}),
  };
  const derivedActive = opts.running !== undefined || opts.codeCapable !== undefined || !!opts.status;

  const annotateRunning = async (rows: any[]) => {
    const { chatRunKey } = await import('../chat-agent/chat-agent.service');
    // crossModelService.listChats already annotates `running` (in-process registry
    // OR durable agent_runs — worker-process coding runs included) and
    // `awaitingInput`/`awaitingKind` (Redis pending approval/question keys).
    // Only TOP UP running with the registry check here — never downgrade a
    // worker-process run back to false.
    return rows.map((c) => ({ ...c, running: c.running === true || isRunActive(chatRunKey(c.id)) || isRunActive(c.id) }));
  };

  if (!derivedActive) {
    const result = await crossModelService.listChats(userId, page, limit, dbFilters);
    return { ...result, chats: await annotateRunning(result.chats as any[]) };
  }

  const DERIVED_CAP = 1000;
  const all = await crossModelService.listChats(userId, 1, DERIVED_CAP, dbFilters);
  let chats = await annotateRunning(all.chats as any[]);

  if (opts.status) {
    const states: Array<{ id: string; status: string }> = await (prisma as any).chatCodingState
      .findMany({ where: { id: { in: chats.map((c) => c.id) } }, select: { id: true, status: true } })
      .catch(() => [] as Array<{ id: string; status: string }>);
    const byId = new Map(states.map((s) => [s.id, s.status]));
    chats = chats.filter((c) => byId.get(c.id) === opts.status);
  }
  if (opts.codeCapable !== undefined) chats = chats.filter((c) => c.codeCapable === opts.codeCapable);
  if (opts.running !== undefined) chats = chats.filter((c) => c.running === opts.running);

  const total = chats.length;
  const start = (page - 1) * limit;
  return {
    chats: chats.slice(start, start + limit),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

/**
 * Paginated transcript read (P6 fleet-supervisor HARVEST step) — the bounded
 * counterpart to getChatById's full-transcript load. Read access (owner or any
 * project member, mirroring getChatById 'read'). Pages BACKWARD from the
 * newest message: `before` is a message-id cursor (a previous page's
 * nextBefore). Messages within a page are chronological.
 */
export async function getChatMessages(opts: {
  userId: string; chatId: string; limit?: number; before?: string;
}) {
  const { userId, chatId } = opts;
  const { access, exists } = await crossModelService.getChatAccess(chatId, userId);
  if (!exists || access === 'none') throw new AppError(404, 'Chat not found'); // no existence leak
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));

  let before: { createdAt: Date; id: string } | undefined;
  if (opts.before) {
    // 2026-09-24 (platform/chat-cursor.ts): accept the citation-doctrine 8-char
    // prefix + explain the recovery — 30 failures/7d were models passing what
    // they had been told to cite.
    const { resolveBeforeCursor } = await import('./chat-cursor');
    const resolved = await resolveBeforeCursor({
      byId: (id) => prisma.crossModelMessage.findUnique({ where: { id }, select: { id: true, chatId: true, createdAt: true } }),
      byPrefixInChat: (cid, prefix) => prisma.crossModelMessage.findMany({ where: { chatId: cid, id: { startsWith: prefix } }, select: { id: true, chatId: true, createdAt: true }, take: 2 }),
    }, chatId, opts.before);
    if (!resolved.ok) throw new AppError(400, resolved.message);
    before = resolved.before;
  }

  const rows = await prisma.crossModelMessage.findMany({
    // Compound cursor (createdAt, id) mirroring the sort below — ticket 68916075,
    // same precedent as crossmodel.service.getChatById: createdAt is ms-precision,
    // so a plain `createdAt < c` strands a tied row in NO page (it sorts below the
    // cursor by id yet `lt` excludes equality) — "older" =
    // createdAt < c OR (createdAt = c AND id < c.id).
    where: {
      chatId,
      ...(before
        ? {
            OR: [
              { createdAt: { lt: before.createdAt } },
              { createdAt: before.createdAt, id: { lt: before.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, role: true, content: true, createdAt: true, updatedAt: true },
  });
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse(); // chronological within the page
  return {
    chatId,
    // Guard-chrome redaction (2026-08-30 phantom-recurrence fix C): this is the
    // fleet supervisor's harvest path (get_chat_messages) — a guard-REPLACED
    // note's audit-quote of the confabulation used to reach the harvesting
    // agent RAW here (the four history seams redact it; this API didn't), so
    // the supervisor could read a struck "PR #338 merged" quote as fact and
    // carry it into wakes/digests. Same placeholder swap as the model-facing
    // seams; the full wrapper remains in the DB for the UI/audit.
    messages: messages.map((m) => {
      const r = redactGuardChromeMessage(m);
      return {
        id: r.id, role: r.role, content: r.content, createdAt: r.createdAt.toISOString(),
        // Ticket 68916075: last-write stamp (≈ finalize time for coding-run
        // placeholder rows); null for rows predating the field. createdAt stays
        // insert-time (the ordering/cursor contract) — never restamped.
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
      };
    }),
    hasMore,
    ...(hasMore && messages.length > 0 ? { nextBefore: messages[0].id } : {}),
  };
}

/**
 * audit 2026-10-08 W2-6: ONE message of a chat, in full (get_chat_messages
 * `messageId` — the read the clipped listing points at). Same access rule as
 * getChatMessages (owner or project member; 404 otherwise, no existence leak).
 * `messageId` may be the full id or a unique ≥ 8-char prefix within the chat.
 * Guard-chrome redaction as on the listing.
 */
export async function getChatMessage(opts: { userId: string; chatId: string; messageId: string }) {
  const { userId, chatId } = opts;
  const { access, exists } = await crossModelService.getChatAccess(chatId, userId);
  if (!exists || access === 'none') throw new AppError(404, 'Chat not found');
  const want = String(opts.messageId || '').trim();
  if (want.length < 8) throw new AppError(400, `messageId "${want}" is too short — pass the full message id (or at least its first 8 characters) from a get_chat_messages listing.`);
  const select = { id: true, chatId: true, role: true, content: true, createdAt: true, updatedAt: true } as const;
  let row = await prisma.crossModelMessage.findUnique({ where: { id: want }, select }).catch(() => null);
  if (!row || row.chatId !== chatId) {
    const hits = await prisma.crossModelMessage.findMany({ where: { chatId, id: { startsWith: want } }, select, take: 2 });
    if (hits.length !== 1) {
      throw new AppError(404, hits.length ? `messageId prefix "${want}" matches more than one message in chat ${chatId} — pass more characters.` : `No message "${want}" in chat ${chatId}.`);
    }
    row = hits[0];
  }
  const r = redactGuardChromeMessage(row);
  return { chatId, message: { id: r.id, role: r.role, content: r.content, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null } };
}

/**
 * Create a chat. With a projectId, the caller needs write access to the project
 * (owner/editor/admin — viewers blocked, mirroring createProjectChat).
 */
export async function createChat(opts: {
  userId: string; title: string; mode?: PatienceMode | typeof AUTO_MODE; projectId?: string | null; ghostMode?: boolean;
}) {
  const { userId, title } = opts;
  // P4 boundary: retired modes alias on intake (`deep_research_all` →
  // `deep_research`, `fast`/`single` → `single_thinking`). Owner 2026-09-26
  // ("default all chats to auto even supervisors"): 'auto' IS persisted and is
  // the default — the runtime routes a stored 'auto' per send (human turns →
  // the Auto router; machine wakes → the compute policy with the L2 preset as
  // the fail-open fallback, types.ts storedModeToPreset). A named preset is
  // stored as that preset (the Advanced "Default depth" still rides per send).
  const mode: PatienceMode | typeof AUTO_MODE = opts.mode === AUTO_MODE || opts.mode === undefined
    ? AUTO_MODE
    : normalizePatienceMode(opts.mode);
  const projectId = opts.projectId || null;
  if (projectId) {
    const access = await getProjectAccess(projectId, userId);
    if (!access) throw new AppError(404, 'Project not found or no access');
    if (access.role === 'viewer') throw new AppError(403, 'Viewers cannot create chats in this project');
  }
  const chat = await crossModelService.createChat(userId, title, mode, projectId, opts.ghostMode === true);
  await audit(userId, 'chat.create', { chatId: chat.id, projectId, mode });
  // Sidebar push (6201e0ee): a chat created anywhere (another tab, an agent
  // lane's create_chat) invalidates connected sidebars immediately.
  publishChatListEvent(userId, { kind: 'chat.created', chatId: chat.id });
  return chat;
}

/**
 * Live status snapshot for one chat: run state, coding state (branch/status),
 * and the session plan summary. Read access (owner or any project member).
 * NOTE: no PR url is persisted anywhere today — the PR lives in the transcript's
 * pr_opened event only — so it is intentionally absent here.
 */
export async function getChatStatus(opts: { userId: string; chatId: string }) {
  const { userId, chatId } = opts;
  const chat = await crossModelService.getChatById(chatId, userId, 'read'); // throws 404/403

  // Cross-process truth (P5 audit): local registry + Redis liveness key +
  // durable agent_runs — a run on the other blue/green instance or the worker
  // reports running here too.
  const running = await isChatBusy(chatId);

  const state = await (prisma as any).chatCodingState
    .findUnique({
      where: { id: chatId },
      select: { status: true, branch: true, baseBranch: true, permissionMode: true, model: true, errorMessage: true },
    })
    .catch(() => null);

  // P5-B: the coding CAPABILITY rides the status DTO (FE/agent polling branches
  // on it — the retired mode='code' marker is gone). The satellite lookup above
  // doubles as hasWorkspaceState; the folder-chain leg only runs when no
  // satellite exists. MERGE-1 slice 1: the PREDICATE is no longer restated
  // here — capabilityFrom is the single copy (this site drifted from the
  // others once already, and drift is what the slice exists to prevent).
  let folderCodeCapable = false;
  if (!state && chat.projectId) {
    const { getNearestWorkspaceFolder } = await import('./folder-inheritance');
    folderCodeCapable = !!(await getNearestWorkspaceFolder(chat.projectId).catch(() => null));
  }
  const capability = capabilityFrom(!!state, undefined, folderCodeCapable);
  const codeCapable = capability.codeCapable;

  let plan: { goal: string; total: number; completed: number } | null = null;
  if (state) {
    const p = await getPlan(chatId).catch(() => null);
    if (p) {
      plan = {
        goal: p.goal || '',
        total: p.steps.length,
        completed: p.steps.filter((s) => s.status === 'completed').length,
      };
    }
  }

  // Attention state: pending approvals (permission requests) + ask_user
  // questions the run is blocked on RIGHT NOW, from the Redis pending keys
  // (worker-published; best-effort — degrades to empty on a Redis hiccup).
  const { getSessionAttention } = await import('../coding/session-run-lock');
  const attention = await getSessionAttention(chatId).catch(() => ({ approvals: [] as string[], questions: [] as string[] }));

  // F3 honest queued status (owner incident 2026-09-04): queue depth for this
  // chat — total pending rows and the USER-typed subset — so no status surface
  // reports a bare "idle" while a message sits waiting. Additive; best-effort
  // (a lookup hiccup degrades to zeros, never a failed status read).
  const { countPending, countPendingUser } = await import('../chat-agent/message-queue.service');
  const [queuedCount, queuedUserCount] = await Promise.all([
    countPending(chatId).catch(() => 0),
    countPendingUser(chatId).catch(() => 0),
  ]);

  // Cadence visibility (overnight forensics 2026-08-24, fix 3b): this status
  // probe returned ZERO schedule data, so a supervisor sweep could not SEE that
  // a chat's cadence had stopped or was overdue. Fresh from the DB on every
  // call (no memory needed): enabled count, the soonest next fire, and how many
  // schedules were disabled recently (enabled:false + lastFiredAt in 24h — no
  // disabledAt column exists). Best-effort: a lookup hiccup degrades to zeros,
  // never a failed status read.
  // Run-cap utilization (ticket b4d1096c): per-row runsCount/maxRuns for capped
  // enabled rows + a nearCap count riding schedule.service's single
  // scheduleNearCapCause predicate — a supervisor re-arms pre-emptively from
  // THIS probe, no per-schedule schedule_get needed.
  let schedules: { enabled: number; nextRunAt: string | null; recentlyDisabled: number; nearCap: number; runCaps: Array<{ id: string; runsCount: number; maxRuns: number }> } =
    { enabled: 0, nextRunAt: null, recentlyDisabled: 0, nearCap: 0, runCaps: [] };
  try {
    const RECENT_DISABLE_MS = 24 * 60 * 60 * 1000;
    const now = new Date();
    const [enabledRows, recentlyDisabled] = await Promise.all([
      prisma.chatSchedule.findMany({ where: { sessionId: chatId, enabled: true }, select: { id: true, nextRunAt: true, kind: true, runsCount: true, maxRuns: true, expiresAt: true } }),
      prisma.chatSchedule.count({
        where: { sessionId: chatId, enabled: false, lastFiredAt: { gte: new Date(Date.now() - RECENT_DISABLE_MS) } },
      }),
    ]);
    const nextMs = enabledRows.length
      ? Math.min(...enabledRows.map((r: any) => new Date(r.nextRunAt).getTime()))
      : null;
    schedules = {
      enabled: enabledRows.length,
      nextRunAt: nextMs !== null && Number.isFinite(nextMs) ? new Date(nextMs).toISOString() : null,
      recentlyDisabled,
      nearCap: enabledRows.filter((r: any) => scheduleNearCapCause(r, now) != null).length,
      runCaps: enabledRows
        .filter((r: any) => r.maxRuns != null)
        .map((r: any) => ({ id: r.id, runsCount: r.runsCount, maxRuns: r.maxRuns })),
    };
  } catch { /* visibility must never break the status read */ }

  // Ticket e44e1219: condition wakes are NOT schedules — they live in
  // store['await-condition'] + a delayed backstop hook event. A supervisor
  // verifying a lane's "condition wake registered (backstop HH:MMZ)" claim
  // needs the open wakes in THIS probe, or schedules.enabled=0 reads as "no
  // wake exists" (the blind spot that filed the ticket). Best-effort, newest
  // first, never throws — visibility must never break the status read.
  let conditionWakes: Array<{ condition: string; repo: string; sha?: string | null; pullNumber?: number | null; horizonAt: string | null; createdAt: string | null; checks?: number; summary?: string | null }> = [];
  try {
    const { listOpenConditionWakesForChat } = await import('../coding/condition-wake-visibility');
    conditionWakes = await listOpenConditionWakesForChat(chatId, { limit: 20 });
  } catch { /* best-effort visibility */ }

  let spend24h: { chatUsd: number; projectUsd: number | null } | null = null;
  if (state) {
    try {
      const { trailingSpend24h } = await import('../coding/spend-cap.service');
      const sp = await trailingSpend24h(chat.id);
      spend24h = { chatUsd: sp.chatUsd, projectUsd: sp.projectUsd };
    } catch { spend24h = null; }
  }
  return {
    id: chat.id,
    title: chat.title,
    mode: chat.mode,
    projectId: chat.projectId,
    access: chat.access,
    updatedAt: chat.updatedAt,
    running,
    codeCapable,
    hasWorkspaceState: !!state,
    // Queue depth (F3): total pending + the user-typed subset. A user row
    // queued means the chat is NOT honestly "idle" even when running=false.
    queued: { count: queuedCount, userCount: queuedUserCount },
    attention: {
      awaitingInput: attention.approvals.length > 0 || attention.questions.length > 0,
      pendingApprovals: attention.approvals,
      pendingQuestions: attention.questions,
    },
    schedules,
    // Ticket e44e1219: open condition wakes (registered await_condition waits).
    // NOT schedules — a supervisor verifying a lane's "condition wake
    // registered" claim reads THIS block (schedules.enabled=0 + a non-empty
    // conditionWakes = the wake is real and armed).
    conditionWakes,
    coding: state
      ? {
          status: state.status,
          branch: state.branch,
          baseBranch: state.baseBranch,
          permissionMode: state.permissionMode,
          model: state.model,
          // Ticket 911b6c45: never surface an errorMessage beside a non-error
          // status — legacy rows healed by a status flip (orphan sweep / claim
          // / healUnrunnableSession) can still carry the failed attempt's text,
          // which contradicts and misleads (a healthy 'ready' lane read as
          // provisioning-broken). The reaper backfills the column itself.
          errorMessage: state.status === 'error' ? state.errorMessage : null,
          // Trailing-24h spend (capability gap audit T2, 2026-09-24): the same
          // cached read the spend-cap gate uses — best-effort, null on a hiccup.
          spend24h,
        }
      : null,
    plan,
  };
}

/**
 * Queue a user message into a chat and start a DETACHED turn (no SSE client
 * attached — the run persists its answer and any viewer can attach via the
 * live-run registry). Write access (owner or project editor/admin); the run
 * executes as the ACTING user (mirrors the HTTP stream path).
 *
 * P5 per-message profile routing (CAPABILITY, not sticky mode): a message to a
 * code-capable chat (workspace satellite attached, or one resolvable from its
 * folder chain) starts a CODING-harness run — the satellite attaches lazily on
 * the owner's message; legacy mode='code' chats all carry the satellite, so
 * their behavior is preserved. Plain chats run the chat-agent profile below.
 * Coding run starts stay owner-only (members get a clear error).
 *
 * P4: `opts.mode` is an optional PER-MESSAGE override (the chat's stored mode
 * is the default and is never mutated here). mode='auto' resolves through the
 * zero-latency heuristic router (auto-router.ts) — 'auto' itself is never
 * persisted or passed to a pipeline — and the decision is returned as
 * `routing` AND handed to the run (emitted as a 'routing' SSE event + stored
 * in the assistant message metadata).
 */
/**
 * Depth propagation for AGENT-origin sends (the hooks.service loop bound): an
 * agent that is itself hook-woken carries a live wake-depth stamp; its
 * send_chat_message must re-stamp that depth onto the TARGET chat, or the
 * target's run_completed emits at depth 0 and the supervisor→nudge→
 * run_completed→wake cycle loops forever — MAX_HOOK_DEPTH never binds through
 * send hops (audit 2026-08-13). Dynamic import: hooks.service statically
 * imports crossmodel.service, so a static edge from here would cycle.
 * Best-effort — 0 / no-op on any failure (matches the ladder's posture).
 */
async function agentSendDepth(origin?: { kind: 'user' | 'agent' | 'webhook'; sourceChatId?: string }): Promise<number> {
  if (origin?.kind !== 'agent' || !origin.sourceChatId) return 0;
  try {
    const hooks = await import('./hooks.service');
    return await hooks.depthForChat(origin.sourceChatId);
  } catch { return 0; }
}

/** Stamp the sender's depth onto the send target (monotonic max). Best-effort. */
async function stampSendDepth(targetChatId: string, depth: number): Promise<void> {
  if (depth <= 0) return;
  try {
    const hooks = await import('./hooks.service');
    await hooks.stampHookDepth(targetChatId, depth);
  } catch { /* best-effort */ }
}

/**
 * Best-effort title of the SENDING chat for the agent-send provenance header
 * (hardening 2026-09-14). Never throws — a miss falls back to the id prefix
 * inside agentSendHeader. The sender is the same user's chat (the fleet is
 * per-user), so surfacing its title to the recipient leaks nothing.
 */
async function agentSendSource(
  sourceChatId: string | undefined,
  /** Owner-turn dispatch (2026-09-30): also read the sender's owner / project /
   *  supervisor flags. Only an owner-turn send asks — every other send keeps
   *  the 2026-09-18 select byte-for-byte. */
  opts?: { withRole?: boolean },
): Promise<{
  title: string | null;
  projectName: string | null;
  /** Null unless withRole AND the row was read (fail-closed → today's header). */
  role: { userId: string | null; projectId: string | null; isSupervisor: boolean; isProjectSupervisor: boolean } | null;
}> {
  if (!sourceChatId) return { title: null, projectName: null, role: null };
  try {
    const row: any = await prisma.crossModelChat.findUnique({
      where: { id: sourceChatId },
      select: opts?.withRole
        ? { title: true, project: { select: { name: true } }, userId: true, projectId: true, isSupervisor: true, isProjectSupervisor: true }
        : { title: true, project: { select: { name: true } } },
    });
    return {
      title: row?.title ?? null,
      projectName: row?.project?.name ?? null,
      role: opts?.withRole && row
        ? {
          userId: row.userId ?? null,
          projectId: row.projectId ?? null,
          isSupervisor: row.isSupervisor === true,
          isProjectSupervisor: row.isProjectSupervisor === true,
        }
        : null,
    };
  } catch { return { title: null, projectName: null, role: null }; }
}

/**
 * The project a chat belongs to (owner 2026-09-18): get_chat_messages stamps a
 * CROSS-PROJECT READ notice when the caller reads a chat from another project,
 * so owner words found there are never mistaken for directives here. Null
 * fields when unknown; never throws.
 */
export async function getChatProjectScope(chatId: string): Promise<{ projectId: string | null; projectName: string | null }> {
  try {
    const row: any = await prisma.crossModelChat.findUnique({
      where: { id: String(chatId || '') },
      select: { projectId: true, project: { select: { name: true } } },
    });
    return { projectId: row?.projectId ?? null, projectName: row?.project?.name ?? null };
  } catch { return { projectId: null, projectName: null }; }
}

export async function sendChatMessage(opts: {
  userId: string; chatId: string; content: string; mode?: string;
  /** Confirmation anchor: a REAL user turn passes its arrival time; machine-triggered callers omit it. */
  userTurnAt?: Date;
  /**
   * The SENDING run is a human OWNER turn (2026-09-30): userTurnAt set AND
   * the run is not machine-triggered (work-tools isHumanTurn — an agent-origin
   * run can carry a userTurnAt anchor, so the anchor alone over-counts). Only
   * the send_chat_message executor passes it; together with a supervisor-class
   * source it selects the owner-dispatch provenance header. Absent ⇒ today's
   * agent-send header.
   */
  ownerTurn?: boolean;
  /**
   * Fleet origin marking: who/what this message is from. REST/UI sends pass
   * { kind: 'user' } (the default when omitted); an in-loop agent's
   * send_chat_message passes { kind: 'agent', sourceChatId: <sending chat> };
   * an inbound webhook fire passes { kind: 'webhook' } (no source chat).
   * Stamped as metadata.origin on the persisted rows (plain-chat path) and
   * recorded on the Activity audit row (both paths — the fleet log's
   * agent-traffic source).
   */
  origin?: { kind: 'user' | 'agent' | 'webhook'; sourceChatId?: string };
  /**
   * Resolved upload content for the run (fleet supervisor attachments): images
   * + extracted document text. Only meaningful on the PLAIN path, and only for
   * an IMMEDIATELY-started run — a busy send instead persists queueUploadIds
   * on the pending row and the drain re-resolves them (ac65d51e). Never pass
   * these from agent-triggered sends.
   */
  agentAttachments?: AgentAttachment;
  /** Filename+type+uploadId summary persisted on the user row (metadata.attachments). */
  attachmentMeta?: Array<{ filename: string; type: string; uploadId?: string }>;
  /**
   * Staged /crossmodel/upload ids (ticket ac65d51e): when this send QUEUES
   * (busy chat or lost start race) the ids persist on the pending row and the
   * drain resolves them into the run — queued messages no longer drop files.
   * On the CODING surface they inline into the steered/started content.
   */
  queueUploadIds?: string[];
  /**
   * DW-5 measure-first (FO firing 68, owner 2026-09-11 "feels stuck 3-7 s"):
   * 'fleet' = stamp ONE supervisor_send_timing loop_metrics row on this
   * send's PLAIN-path terminals — value = total ms-to-durable-accept, meta =
   * the seam breakdown (authMs / modeMs / busyMs / preemptMs / deliverMs).
   * Only the Management fleet surface sets it. (RSW-1 2026-10-30: the
   * SUPERVISOR_SEND_TIMING_DISABLED kill switch was deleted — NF_INERT, never
   * forwarded by compose, so prod only ever stamped.)
   */
  timingSurface?: 'fleet';
  /**
   * How a busy chat takes this send. Omitted = today's behaviour (coding
   * steers into the live run; a human plain send answers ask_user and
   * preempts). `queue` never injects into the live run. `steer` injects only
   * on a coding session, and only with the caller's own origin (an agent
   * steer is not a user turn). `interrupt` preempts only for a human origin;
   * an agent interrupt queues instead.
   */
  delivery?: 'queue' | 'steer' | 'interrupt';
}) {
  const { userId, chatId } = opts;
  // `let`: the coding surface inlines staged-upload content into the string.
  let content = String(opts.content || '').trim();
  const hasAttachments = !!(opts.agentAttachments?.userImages?.length || opts.agentAttachments?.documentText);
  // Attachment-only sends are legal (ac65d51e): resolved attachments (idle
  // path) or staged ids (queue/steer path) carry the message.
  if (!content && !hasAttachments && !opts.queueUploadIds?.length) throw new AppError(400, 'content is required');

  // DW-5 measure-first (FO firing 68; owner 2026-09-11 "feels stuck 3-7 s"):
  // seam timing for a Management fleet-surface send — the marks are cheap
  // Date.now() deltas, the ONE row lands at the plain-path terminal (started /
  // queued / question_answer; the coding branch never carries this marker —
  // only fleet.service sets it, and supervisor chats are plain). (RSW-1
  // 2026-10-30: the SUPERVISOR_SEND_TIMING_DISABLED kill switch was deleted —
  // NF_INERT, never forwarded by compose, so prod only ever ran the stamping
  // branch; instrumentation only, the send itself is identical either way.)
  const timing = opts.timingSurface === 'fleet';
  const t0 = timing ? Date.now() : 0;
  let tAuth = 0; let tMode = 0; let tBusy = 0; let tPreempt = 0;
  const stampTiming = (outcome: string, extra?: Record<string, unknown>) => {
    if (!timing) return;
    const total = Date.now() - t0;
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SUPERVISOR_SEND_TIMING,
      sessionId: chatId,
      value: total,
      unit: 'ms',
      meta: {
        surface: 'fleet',
        outcome,
        authMs: tAuth,
        modeMs: tMode,
        busyMs: tBusy,
        preemptMs: tPreempt,
        deliverMs: Math.max(0, total - tAuth - tMode - tBusy - tPreempt),
        ...extra,
      },
    });
  };

  // DW-5 fix (FO firing 110, 2026-10-10; owner 2026-09-11 "feels stuck 3-7 s"):
  // the send path's auth fetch used getChatById's LEGACY branch — the FULL
  // transcript load (findMany with no limit + attachment/author/pending
  // resolution) — for a send that reads only the access check and the chat
  // row's scalar fields. Measured on the Fleet Supervisor chat
  // (c0e22e36, 16,674 rows / ~263 MB): every supervisor_send_timing row
  // showed authMs = 95–99% of total (4.1–4.8 s idle, 19–20 s busy) — the
  // owner's band, server-side, NOT the F1 preempt wait the DW-5 entry
  // expected (preemptMs ≤ 5 s, deliverMs ≤ 37 ms). messageLimit: 0 takes
  // the PAGED branch: same access gate, same chat-row select, ZERO
  // transcript rows. messageLimit: 0 takes
  // the PAGED branch: same access gate, same chat-row select, ZERO
  // transcript rows.
  const chat = await crossModelService.getChatById(
    chatId, userId, 'write',
    { messageLimit: 0 },
  ); // throws 404/403
  if (timing) tAuth = Date.now() - t0;

  // ARCHIVED target (autonomy loop #13, 2026-09-20): an archive is a stop —
  // the owner's stand-down or the lane-scoped ending. An AGENT or WEBHOOK send
  // must not revive it (the coding-dispatch heal used to un-archive with no
  // audit row; the hook path now retires such wakes). Honest, failure-shaped
  // refusal so the sending model re-plans; a real USER send still restores.
  if ((chat as any)?.archivedAt && opts.origin?.kind && opts.origin.kind !== 'user') {
    void import('./loop-metrics.service')
      .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.MACHINE_DISPATCH_ARCHIVED_REFUSED, sessionId: chatId, meta: { origin: opts.origin!.kind, surface: 'send', sourceChatId: opts.origin?.sourceChatId ?? null } }))
      .catch(() => {});
    throw new AppError(409, `Chat ${chatId.slice(0, 8)} is ARCHIVED (retired) — messages from agents do not revive it. If the work genuinely resumes, restore it first (archive_chat with archived:false); otherwise send to a live lane.`);
  }

  // The sender's OWN words — routing heuristics and audit snippets read this,
  // never the provenance-prefixed `content` below (the header would inflate
  // the auto-router's length thresholds and break its `^opener` regexes).
  const body = content;

  // Agent-send provenance header (hardening 2026-09-14): an in-loop
  // send_chat_message from another chat stamps metadata.origin 'agent', but
  // history renders {role, content} only — the recipient model saw a bare
  // user row and weighed a supervisor's routed request as an OWNER directive
  // (the 2026-09-11 spark fan-out root cause). Prefixed ONCE here, the single
  // choke point every delivery path below shares (plain start, busy-queue
  // drain, coding start AND steer), so the marker rides the persisted row and
  // every future history render — the same fix machineFiringHeader applied to
  // schedule/hook firings (fbe65673). Never for 'user' (a human turn) or
  // 'webhook' (already framed upstream); skipped when the text already
  // carries one (a relay forwarding a headed message). Provenance only — no
  // gate, card, or refusal.
  //
  // Owner-turn dispatch (2026-09-30, TB 2.1 traces): when the OWNER typed the
  // ask on a supervisor's own turn and the supervisor relays it to its lane,
  // the "NOT the owner … not an instruction" framing made lanes weigh the
  // owner's task as optional. That one case gets ownerDispatchHeader ("ASSIGNED
  // WORK … carry it out to completion"); the predicate (ownerDispatchEligible)
  // needs an owner turn, a same-user supervisor-class source and a target in
  // its project (or a Fleet Supervisor source). Every other send — machine
  // wakes, peer lanes, cross-project — keeps agentSendHeader byte-for-byte;
  // any lookup miss/error falls back to it too.
  //
  // Owner-dispatch RUN classification (2026-10-01): the SAME eligible send
  // also stamps `ownerDispatch: true` on the run it STARTS (coding
  // startScheduledRun / plain startDetachedChatRun), so the lane run is
  // USER-anchored — mirroring the 2026-09-28 human-spawn rule. The persisted
  // row keeps origin 'agent'. Steers into an already-running run and queued /
  // yielded sends carry no flag (the drain runs unanchored — machine, as
  // before).
  let ownerDispatchRun = false;
  let headerSourceTitle: string | null = null;
  if (opts.origin?.kind === 'agent' && !isAgentSendHeader(content)) {
    const ownerTurnCandidate = opts.ownerTurn === true && !!opts.userTurnAt;
    const source = await agentSendSource(opts.origin.sourceChatId, ownerTurnCandidate ? { withRole: true } : undefined);
    headerSourceTitle = source.title;
    let header: string | null = null;
    if (ownerTurnCandidate) {
      try {
        if (ownerDispatchEligible({
          originKind: opts.origin.kind,
          ownerTurn: true,
          userTurnAt: opts.userTurnAt,
          userId,
          sourceChatId: opts.origin.sourceChatId,
          source: source.role,
          targetChatId: chatId,
          target: { userId: chat?.userId ?? null, projectId: chat?.projectId ?? null },
        })) {
          header = ownerDispatchHeader(
            source.title, opts.origin.sourceChatId, source.projectName, opts.userTurnAt,
            source.role?.isSupervisor === true ? 'fleet' : 'project',
          );
          ownerDispatchRun = true;
        }
      } catch { header = null; ownerDispatchRun = false; }
    }
    content = (header ?? agentSendHeader(source.title, opts.origin.sourceChatId, source.projectName)) + content;
  }

  // Machine-message notification (ticket a4370dd1): an agent-to-agent send
  // was invisible to the receiving user's UI until the next poll — the row's
  // origin 'agent' deliberately never lights the unread dot (owner 2026-09-16)
  // and no event fired on insert. Every accept terminal below emits ONE
  // 'chat.message' notice on the existing per-user push channel, so the
  // sidebar can reconcile the row within ~1 s (the same wire the
  // 6201e0ee list mutations ride — no new endpoint, no new auth surface;
  // the toast itself was retired by 9d07fd1f's quiet front end).
  // The notice names the SENDER (id + title, same-user fleet) and never the
  // content. Best-effort by design (publishChatListEvent never throws); a
  // human-origin send emits nothing — the sender's own UI already optimistically
  // renders its own messages.
  const notifyMachineMessage = opts.origin?.kind === 'agent';
  const notifyAgentMessage = () => {
    if (!notifyMachineMessage) return;
    // Title containment (review a4370dd1-8): the title rides only when the
    // recipient IS the acting user — the fleet norm (the sending run acts on
    // its own user's chats). A member's send into another owner's chat
    // withholds the sender's title (the notice's id is opaque; any re-added
    // arrival surface falls back to a generic label) — the row itself still
    // 404s without access.
    const sameUserFleet = (chat?.userId ?? userId) === userId;
    publishChatListEvent(chat?.userId ?? userId, {
      kind: 'chat.message',
      chatId,
      sourceChatId: opts.origin?.sourceChatId,
      ...(sameUserFleet && headerSourceTitle ? { sourceTitle: headerSourceTitle } : {}),
    });
  };

  // Loop bound: an agent send from a hook-woken chat carries the sender's
  // wake-depth; it is re-stamped onto the target at every accept point below
  // (steer / run start / queue stash) so MAX_HOOK_DEPTH binds through hops.
  const sendDepth = await agentSendDepth(opts.origin);

  // ── P5 routing (User Space §4 — THE ROUTING RULE): the SATELLITE decides. ──
  // A turn runs the CODING harness iff a ChatCodingState satellite exists —
  // NEVER off folder capability. With auto-filing every chat sits in a capable
  // (user-space) project, so codeCapable now means exactly one thing:
  // "attachable on demand".
  //
  // MERGE-1 slice 2 (2026-11-03): the rule itself — capability read, owner /
  // supervisor / escalation / kid guards, the code-intent trigger and the
  // task-kind attach gate — moved into platform/send-profile.ts. It was
  // re-implemented here AND at two controller seams, and the copies drifted
  // (the GET ?message= start had no gate at all). One rule, three callers.
  {
    const { resolveSendProfile } = await import('./send-profile');
    const decision = await resolveSendProfile({
      chat,
      senderUserId: userId,
      message: body,
      origin: opts.origin?.kind ?? 'user',
      hasUploads: !!opts.queueUploadIds?.length,
    });
    if (decision.profile === 'coding') {
      // Kid guard (§4c, defense in depth): coding stays an adult surface —
      // mirrors the streamChatRun / streamCapabilityRun 403s. Today reachable
      // only via REST on an already-capable chat (kid spaces are plain).
      // NOTE: this gates the ROUTED path, not the attach — resolveSendProfile
      // already refuses the probe for a child sender, so reaching here as a
      // child means the chat ALREADY carried a satellite.
      const sender = await prisma.user
        .findUnique({ where: { id: userId }, select: { isChild: true } })
        .catch(() => null);
      if (sender?.isChild) throw new AppError(403, 'Coding is not available for child accounts');
      // Resolved chat-upload files (7f546b03) — filled by the queueUploadIds
      // block below, then threaded into the steer / fresh run.
      let files: SessionFilePayload[] = [];
      if (opts.queueUploadIds?.length) {
        // Steer preserves attachments (ac65d51e + 7f546b03): staged uploads
        // with retained base64 ride the coding run as REAL FILES (RunInput.files
        // / the steer mailbox) — the executor stages the raw bytes into the
        // worktree and the agent reads the file itself, never a 20K text
        // preview. ALL types take this path including images (a platform send
        // never had a vision channel — staged bytes beat a "can't forward"
        // note). Only LEGACY Redis blobs (uploaded before base64 retention,
        // text-preview-only) still inline as [Attached: filename] blocks;
        // expired blobs annotate rather than vanish.
        const { loadAttachment } = await import('../upload.controller');
        const loaded = await Promise.all(opts.queueUploadIds.map(async (id) => ({ id, a: await loadAttachment(id) })));
        const resolved = loaded.map((l) => l.a).filter((a): a is NonNullable<typeof a> => a !== null);
        const expired = loaded.length - resolved.length;
        // Persistent chat files (2026-08-25): durable copy of the consumed
        // uploads (fire-and-forget; idempotent per (uploadId, chatId) — the
        // original send's own persist and any later re-steer are no-ops).
        if (resolved.length) {
          void import('../chat-files.service')
            .then((m) => m.persistChatUploads({
              chatId,
              userId,
              loaded: loaded
                .filter((l): l is { id: string; a: NonNullable<(typeof loaded)[number]['a']> } => l.a !== null)
                .map((l) => ({ id: l.id, attachment: l.a })),
            }))
            .catch(() => {});
        }
        const blocks: string[] = [];
        for (const f of resolved) {
          if (f.base64) {
            const payload: SessionFilePayload = { name: f.filename, mediaType: f.mimeType || 'application/octet-stream', data: f.base64 };
            // 7b5ee09b: carry the upload-time text extract too — the executor
            // stages it as a readable sibling, so a PDF reaching a coding run
            // via a platform send is readable without a pdftotext (the same
            // contract coding-stream.controller resolveUploadIdsToFiles keeps).
            if (typeof f.extractedText === 'string' && f.extractedText) payload.extractedText = f.extractedText;
            files.push(payload);
          } else if (f.extractedText) {
            blocks.push(`[Attached: ${f.filename}]\n${f.extractedText.slice(0, 20000)}`);
          } else {
            blocks.push(`[Attached: ${f.filename} (${f.type} — no extractable text)]`);
          }
        }
        if (expired > 0) blocks.push(`[${expired} attachment(s) expired before they could be attached — please re-send ${expired === 1 ? 'it' : 'them'}.]`);
        if (blocks.length) content = `${content ? `${content}\n\n` : ''}${blocks.join('\n\n')}`;
        // Loud validation (never silently strip): the resolved payloads must
        // survive the same gauntlet every other coding entry point applies.
        const fileCheck = validateFiles(files);
        if (!fileCheck.ok) throw new AppError(400, fileCheck.error);
        files = fileCheck.files;
      } else if (hasAttachments) {
        // The coding run body is a plain message string — there is no upload
        // channel; refuse loudly instead of dropping the files.
        throw new AppError(400, 'Attachments are not supported on the coding surface — send them in a regular chat.');
      }
      if (chat.userId !== userId) {
        throw new AppError(400, 'This chat runs on the coding surface — only the owner can start runs (attach via GET /chats/:id/stream).');
      }
      // Routing Rule: the satellite ALWAYS exists inside this branch (the
      // router gate above attached it for a code-intent send when it was
      // missing) — the old lazy attach-on-send is gone from here.
      const { startScheduledRun, steerActiveRun } = await import('../coding/coding-stream.controller');
      // Busy-chat queue (2026-08-07): a BUSY coding session's right semantics
      // is STEER — deliver the message INTO the active run (Redis mailbox +
      // persisted user row) instead of 409-ing and losing it. steerActiveRun
      // self-gates on an active run row; when it reports none (idle, or the
      // run finished in the race window), fall through to start a fresh run.
      // The fleet origin rides along (hardening round 2, 2026-08-23): the
      // persisted steer row is stamped metadata.origin exactly like the
      // fresh-run path — without it fleet.service counted a webhook/agent
      // steer as a HUMAN turn.
      // Delivery (platform API): omitted = today's always-steer. `queue`
      // never injects into the live run. An agent `interrupt` queues too —
      // an agent token must not join the live run as a user turn. `steer`
      // injects with the caller's own origin and never a userTurnAt.
      const originKind = opts.origin?.kind ?? 'user';
      const skipSteer = opts.delivery === 'queue' || (originKind === 'agent' && opts.delivery === 'interrupt');
      if (!skipSteer) {
        const steer = await steerActiveRun(chatId, content, {
          origin: originKind,
          ...(opts.origin?.sourceChatId ? { originSourceChatId: opts.origin.sourceChatId } : {}),
          ...(files.length ? { files } : {}),
        });
        if (steer.steered) {
          // The steer joins the ACTIVE run — that run's completion emission is
          // (partly) this send's effect, so the depth hop still applies.
          await stampSendDepth(chatId, sendDepth);
          notifyAgentMessage();
          await audit(userId, 'chat.message', {
            chatId, profile: 'coding', delivery: 'steer',
            ...(opts.origin ? { origin: opts.origin.kind, sourceChatId: opts.origin.sourceChatId } : { origin: 'user' }),
          });
          return { queued: true, chatId, profile: 'coding', delivery: 'steer' };
        }
      }
      // Confirmation anchor: threaded from the CALLER — a real user turn (REST
      // send, user-confirmed send_chat_message) passes its turn timestamp; a
      // machine-triggered caller (autonomous supervisor nudge) passes NOTHING,
      // so the target run stays unanchored and can never confirm pendings
      // (platform/pending-confirmations.ts — an autonomous send must not
      // launder a machine turn into a user-anchored one).
      // The fleet origin rides along explicitly: an agent's in-loop
      // send_chat_message must persist origin 'agent' (+ sourceChatId), not
      // the userTurnAt heuristic's 'user'.
      const startArgs = {
        ...(opts.userTurnAt ? { userTurnAt: opts.userTurnAt } : {}),
        origin: originKind,
        ...(opts.origin?.sourceChatId ? { originSourceChatId: opts.origin.sourceChatId } : {}),
        ...(files.length ? { files } : {}),
        // Owner-dispatch (2026-10-01): the run is classified 'user' (origin stays 'agent').
        ...(ownerDispatchRun ? { ownerDispatch: true } : {}),
      };
      let started = await startScheduledRun(chatId, content, startArgs);
      // A queued delivery that finds the chat busy waits behind the live run
      // (the once-schedule queue-behind-busy path) instead of 409-ing.
      if (!started.started && started.reason === 'busy' && skipSteer) {
        started = await startScheduledRun(chatId, content, { ...startArgs, queueBehindBusy: true });
      }
      if (!started.started) {
        throw new AppError(409, started.reason === 'busy'
          ? 'A run is already in progress for this chat. Wait for it to finish (or Stop it) before sending another message.'
          : started.reason || 'Could not start the run');
      }
      const queuedBehind = skipSteer && !!started.queued;
      await stampSendDepth(chatId, sendDepth);
      notifyAgentMessage();
      await audit(userId, 'chat.message', {
        chatId, profile: 'coding',
        ...(opts.origin ? { origin: opts.origin.kind, sourceChatId: opts.origin.sourceChatId } : { origin: 'user' }),
        contentSnippet: body.slice(0, 140),
        ...(queuedBehind ? { delivery: 'queue' as const } : {}),
      });
      return {
        queued: true,
        chatId,
        profile: 'coding' as const,
        delivery: queuedBehind ? 'queue' as const : 'started' as const,
        ...(started.runId ? { runId: started.runId } : {}),
      };
    }
  }

  const { startDetachedChatRun } = await import('../chat-agent/chat-agent.service');

  // Resolve the per-message level FIRST — a busy chat enqueues with the
  // RESOLVED mode so the drain replays exactly what this send intended
  // ('auto' runs the Auto router NOW; its routing SSE card only exists for an
  // immediately-started run). ONE resolver for every seam (2026-09-26 audit,
  // platform/send-mode.ts): the patience_auto_only switch now covers this
  // seam too (settings-switches-3); an auto-routed Level 3 carries the quota
  // ALLOWANCE (routing-unify-1); a supervisor chat never runs the council on
  // a human turn (supervisors-auto-2); EVERY non-human origin — agent /
  // webhook — is floored to Ensemble, explicit, stored or routed
  // (routing-unify-5 / supervisors-auto-3: the old clamp was webhook-only).
  let mode: RoutableLevel;
  let routing: SendRouting | undefined;
  // Patience plan 1a (2026-09-25): how the level was chosen — rides the run's
  // metadata + run_spend stamp (auto_heuristic / auto_decision; a machine
  // origin is stamped 'machine' by the run itself; an explicit user level
  // over REST carries no modeSource → user_explicit).
  let routingSource: string | undefined;
  const originKind = opts.origin?.kind ?? 'user';
  const humanSend = originKind === 'user';
  const resolved = await resolveSendMode({
    mode: opts.mode, storedMode: chat.mode, userId,
    isSupervisorChat: !!(chat.isSupervisor || chat.isProjectSupervisor),
    origin: humanSend ? 'rest' : originKind,
    content: body, sessionId: chat.id,
    hasWorkspace: async () => (chat.projectId ? !!(await getNearestWorkspaceFolder(chat.projectId).catch(() => null)) : false),
  });
  if (timing) tMode = Date.now() - t0 - tAuth;
  mode = (resolved.mode === 'browser_agent' ? 'thinking' : resolved.mode) as RoutableLevel;
  routing = resolved.routing;
  routingSource = humanSend ? resolved.routingSource : undefined;

  // Research routing by the TURN PLAN on this seam too (roster 2026-10-06 A-3, platform/lane-depth.ts — the same helper
  // as the web stream): for a sender the research-lane feature acts for, a confident research lane routes to Level 3
  // through the reserve below (lost ⇒ demoted to Ensemble) and a keyword Level 3 the turn plan does not call research is
  // retired. The answered plan rides into the run. Anyone else: no ask. Fails open to the router's level.
  let turnPlanPrefetched: import('./turn-plan').TurnPlan | null = null;
  if (humanSend && resolved.autoRouted && resolved.mode !== 'browser_agent') {
    try {
      const { routeResearchLane } = await import('./lane-depth');
      const lr = await routeResearchLane({
        seam: 'rest', userId, chatId, message: body,
        images: opts.agentAttachments?.userImages?.length ?? 0, documents: opts.agentAttachments?.documentText ? 1 : 0,
        mode, routing, autoRouted: true, segment: resolved.segment,
        isSupervisorChat: !!(chat.isSupervisor || chat.isProjectSupervisor), isChild: false, escalation: false,
        // 2026-10-20: the router's Level 3 allowance verdict — a quota-denied sender is never lane-routed to a council.
        deepResearchAllowed: resolved.allowDeepResearch, deepResearchDenyReason: resolved.allowDeepResearchReason,
        // Ghost mode (integ/ghost-composer review fix): a ghost chat's text never reaches the cloud turn plan (the
        // run's own ghost_skip then applies). getChatById selects the flag on both branches.
        ghost: (chat as { ghostMode?: boolean | null }).ghostMode === true,
      });
      if (lr.mode !== mode) {
        mode = lr.mode as RoutableLevel;
        routing = (lr.routing ?? routing) as SendRouting | undefined;
        if (lr.routingSource) routingSource = lr.routingSource;
      }
      turnPlanPrefetched = lr.turnPlan;
    } catch (err: any) {
      logger.warn(`platform send: research lane routing failed (${err?.message ?? err}) — the router's level stands`);
    }
  }

  // The council quota is RESERVED on this seam too (audit 2026-09-26
  // routing-unify-5 / settings-switches-3 / tests-gaps-3: it used to be
  // "enforced only at the interactive stream site", so a REST / nudge send
  // launched an UNMETERED council). A human Level 3 that loses the reserve is
  // demoted to Ensemble exactly like the stream seam — never a 429 for an
  // Auto-routed pick.
  if (humanSend && mode === 'deep_research') {
    const quota = await reserveDeepResearchQuota(userId);
    if (!quota.allowed) {
      const demoted = demoteForQuota(routing);
      mode = demoted.mode;
      routing = demoted.routing;
      logger.info(`platform send: deep-research reserve refused for ${userId} (${quota.used}/${quota.limit}) — demoted to thinking`);
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.DEEP_RESEARCH_QUOTA_REJECTED, sessionId: chatId,
        meta: { scope: 'user', anon: false, mode: 'deep_research', routingSource, limit: quota.limit, used: quota.used, autoOnly: resolved.autoOnly, autoRouted: resolved.autoRouted, demoted: true, seam: 'platform' },
      });
    }
  }

  // Busy-chat queue (2026-08-07): a run is already answering in this PLAIN
  // chat — persist the message to pending_chat_messages instead of 409-ing
  // and losing it. The active run's finally drains the queue automatically
  // (chat-agent.service drainChatQueue). The row's source carries the sender's
  // origin kind through the queue (audit p10 — a hardcoded 'agent' here made a
  // REST/UI send to a busy chat drain with agent provenance). The fleet origin +
  // the sender's wake-depth ride the enqueue (Redis stash) so the drained run
  // starts MARKED and the depth ladder survives the hop — a pre-stamp here
  // would wrongly elevate the ACTIVE run's emission instead. The ONLY
  // remaining 409 here is a full per-chat queue (MAX_QUEUE_DEPTH).
  // Cross-process (P5 audit): isChatBusy sees runs on the OTHER blue/green
  // instance too; the atomic claim inside startDetachedChatRun backstops any
  // race this check loses.
  //
  // F1 (owner incident 2026-09-04): a HUMAN send (REST/UI/fleet composer —
  // origin absent or 'user'; agent/webhook sends stay pure queue traffic)
  // preempts a REPLAYABLE machine-triggered run instead of waiting behind it:
  // request cancellation, bounded wait for teardown, freed → start now.
  // Not freed → the queue below is the guarantee (F2 drains user rows first).
  let busyNow = await isChatBusy(chatId);
  // DW-5: the STARTED terminal stamps the ENTRY state (a freed preempt started
  // the run — busy:true + preempted:true is that send's honest story).
  const enteredBusy = busyNow;
  let preemptedMachineRun = false;
    // `queue` and `steer` opt out of the human preempt (and the ask_user
    // answer that rides inside it). An agent origin already fails the
    // kind check, so a dgt_ interrupt never answers a question or preempts.
    if (busyNow && (!opts.origin || opts.origin.kind === 'user') && opts.delivery !== 'queue' && opts.delivery !== 'steer') {
    // Message-as-answer (ticket 356d21bb): a LIVE ask_user card on this chat
    // treats this inbound message AS the answer — resolve the wait with the
    // text BEFORE any preempt/queue decision (the preempt below cancels a
    // machine run and null-resolves its waits; the answer must land first).
    const { resolveParkedQuestionWithOwnerText } = await import('../message-as-answer');
    const answered = await resolveParkedQuestionWithOwnerText({ chatId, userId, text: content }).catch(() => ({ resolved: false }));
    const { preemptMachineRunForUserMessage } = await import('../chat-agent/chat-agent.service');
    if (timing) tBusy = Date.now() - t0 - tAuth - tMode;
    const p = await preemptMachineRunForUserMessage(chatId).catch(() => ({ preempted: false, freed: false }));
    if (timing) tPreempt = Date.now() - t0 - tAuth - tMode - tBusy;
    preemptedMachineRun = p.preempted;
    if (p.freed) busyNow = false; // slot freed — start the user's run immediately below
    // Ticket a5b36dc6 — the IN-FLIGHT marker stamp lives INSIDE
    // preemptMachineRunForUserMessage (chat-agent.service), the single choke
    // point this REST path and the SSE stream controller both share, so every
    // preempt route (browser UI included) checkpoints the interrupted run's
    // in-flight intents.
    if (busyNow && answered.resolved && !preemptedMachineRun) {
      // USER run parked on the card (Gap B): the message WAS the answer — the
      // parked run resumed with it; nothing to queue, no new run to start.
      stampTiming('question_answer', { busy: true, preempted: preemptedMachineRun });
      await audit(userId, 'chat.message', {
        chatId, mode, delivery: 'question_answer',
        ...(opts.origin ? { origin: opts.origin.kind, sourceChatId: opts.origin.sourceChatId } : { origin: 'user' }),
        contentSnippet: body.slice(0, 140),
      });
      return {
        ok: true, queued: true, chatId,
        note: 'Delivered as the answer to the open question — the current run is continuing with it.',
      };
    }
  }
  // Hook-starvation YIELD (autonomy loop #11, 2026-09-20): an AGENT send that
  // finds the chat idle used to START a run at once — jumping a hook backlog
  // the chat's own finalize had just been unable to deliver (11:52Z: a Fleet
  // Supervisor steer took the crossmodel Supervisor's idle window 22 s after a
  // retiring-colour finalize; its 8 run_completed rows then waited 50 min).
  // When the target's oldest pending hook row is starving, this send is queued
  // exactly as if the chat were busy and the hook digest is kicked — that
  // wake's finalize drains the queue next. User and webhook sends never yield
  // (humans preempt; webhooks are external alerts). hooks.service is optional
  // here (partial mocks): no helper, no yield.
  let yieldToHooks = false;
  if (!busyNow && opts.origin?.kind === 'agent') {
    const hooksMod: any = await import('./hooks.service').catch(() => null);
    yieldToHooks = typeof hooksMod?.hookBacklogStarving === 'function'
      ? await Promise.resolve(hooksMod.hookBacklogStarving(chatId)).catch(() => false)
      : false;
    if (yieldToHooks) {
      try { hooksMod?.drainHookEventsForTarget?.(chatId); } catch { /* the kick is best-effort */ }
      logger.info(`platform: agent send to idle chat ${chatId.slice(0, 8)} yields to its starving hook backlog — queued; hook digest kicked`);
      void import('./loop-metrics.service')
        .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.HOOK_STARVATION_YIELD, sessionId: chatId, meta: { entrant: 'agent_send', sourceChatId: opts.origin?.sourceChatId ?? null } }))
        .catch(() => {});
    }
  }
  if (busyNow || yieldToHooks) {
    if (hasAttachments && !opts.queueUploadIds?.length) {
      // Resolved attachments but NO staged ids to persist — queueing would
      // drop the files while the UI shows their chips; refuse so the caller
      // re-sends when idle. (With staged ids the queue carries them — ac65d51e.)
      throw new AppError(409, 'Queued messages can’t carry attachments — wait for the current run to finish, then send again.');
    }
    const { enqueueChatMessage } = await import('../chat-agent/message-queue.service');
    const { position, coalesced } = await enqueueChatMessage({
      chatId, userId, content, mode,
      source: opts.origin?.kind ?? 'user',
      // Queued attachments (ac65d51e): the drain resolves these into the run.
      ...(opts.queueUploadIds?.length ? { uploadIds: opts.queueUploadIds } : {}),
      ...(opts.origin?.kind === 'agent' || opts.origin?.kind === 'webhook'
        ? {
            origin: {
              kind: opts.origin.kind,
              // sourceChatId + wake-depth exist only for agent sends.
              ...(opts.origin.kind === 'agent'
                ? { sourceChatId: opts.origin.sourceChatId, depth: sendDepth }
                : {}),
            },
          }
        : {}),
    });
    notifyAgentMessage();
    await audit(userId, 'chat.message', {
      chatId, mode, queuedPending: true, position, ...(coalesced ? { coalesced: true } : {}),
      ...(opts.origin ? { origin: opts.origin.kind, sourceChatId: opts.origin.sourceChatId } : { origin: 'user' }),
      contentSnippet: body.slice(0, 140),
    });
    // F2(b) enqueue-side nudge: if the busy check raced the finishing run's
    // finalize drain, attempt an immediate drain shortly (no-op while busy).
    const { nudgeQueueDrainSoon } = await import('../chat-agent/chat-agent.service');
    nudgeQueueDrainSoon(chatId, userId);
    stampTiming('queued', { busy: true, preempted: preemptedMachineRun });
    return {
      ok: true, queued: true, chatId, position,
      ...(coalesced ? { coalesced: true } : {}),
      note: coalesced
        ? `Message queued — this chat's queue was full (${position} ahead), so it was merged into your earlier queued message to it; both parts deliver together as one message when the current run finishes.`
        : preemptedMachineRun
        ? 'Message queued with priority — the current machine run was asked to stop; this message runs next.'
        : yieldToHooks
          ? 'Message queued behind this chat\'s pending event wakes (they have waited longer) — it runs right after that wake finishes.'
          : 'Message queued — it will run automatically when the current run finishes.',
    };
  }

  const started = await startDetachedChatRun({
    userId, chatId, message: content, mode, ...(routing ? { routing } : {}),
    ...(routingSource ? { routingSource } : {}),
    // Roster 2026-10-06 A-3: the research route's answered turn plan (the run never asks twice).
    ...(turnPlanPrefetched ? { turnPlanPrefetched } : {}),
    // Fleet origin marking (default 'user' — every REST/UI send is a human turn).
    messageOrigin: opts.origin?.kind ?? 'user',
    originSourceChatId: opts.origin?.sourceChatId,
    // Owner-dispatch (2026-10-01): this STARTED run is not machine-triggered
    // (chat-agent machineOriginRun); the rows keep messageOrigin 'agent'.
    ...(ownerDispatchRun ? { ownerDispatch: true } : {}),
    // A webhook fire is a MACHINE wake (like schedule/hook): pin titling
    // (machineWake) so the alert payload never names — or repeatedly re-names
    // — the chat (adversarial review 2026-08-23; titling guards pin on
    // machineWake, not on the origin stamp).
    ...(opts.origin?.kind === 'webhook' ? { machineWake: true } : {}),
    // Confirmation anchor threaded from the caller (see the coding branch
    // above) — absent for machine-triggered sends.
    ...(opts.userTurnAt ? { userTurnAt: opts.userTurnAt } : {}),
    // Resolved upload content (fleet supervisor attachments) — images force a
    // vision orchestrator downstream; document text rides the user message.
    ...(opts.agentAttachments?.userImages?.length ? { userImages: opts.agentAttachments.userImages } : {}),
    ...(opts.agentAttachments?.documentText ? { documentText: opts.agentAttachments.documentText } : {}),
    ...(opts.attachmentMeta?.length ? { attachmentMeta: opts.attachmentMeta } : {}),
  });
  if (!started) {
    if (hasAttachments && !opts.queueUploadIds?.length) {
      // Lost the start race with resolved attachments but no staged ids (see
      // the busy branch above) — refuse identically instead of dropping them.
      throw new AppError(409, 'Queued messages can’t carry attachments — wait for the current run to finish, then send again.');
    }
    // Lost the start race — a run is active NOW, so queue exactly as above
    // (its finally drains us) rather than failing the send.
    const { enqueueChatMessage } = await import('../chat-agent/message-queue.service');
    const { position } = await enqueueChatMessage({
      chatId, userId, content, mode,
      source: opts.origin?.kind ?? 'user',
      // Queued attachments (ac65d51e): the drain resolves these into the run.
      ...(opts.queueUploadIds?.length ? { uploadIds: opts.queueUploadIds } : {}),
      ...(opts.origin?.kind === 'agent' || opts.origin?.kind === 'webhook'
        ? {
            origin: {
              kind: opts.origin.kind,
              // sourceChatId + wake-depth exist only for agent sends.
              ...(opts.origin.kind === 'agent'
                ? { sourceChatId: opts.origin.sourceChatId, depth: sendDepth }
                : {}),
            },
          }
        : {}),
    });
    notifyAgentMessage();
    await audit(userId, 'chat.message', {
      chatId, mode, queuedPending: true, position,
      ...(opts.origin ? { origin: opts.origin.kind, sourceChatId: opts.origin.sourceChatId } : { origin: 'user' }),
      contentSnippet: body.slice(0, 140),
    });
    // F2(b) enqueue-side nudge (same as the busy branch above): the race this
    // branch exists for — a run started between the checks — can equally end
    // before anyone drains; attempt an immediate drain shortly.
    const { nudgeQueueDrainSoon } = await import('../chat-agent/chat-agent.service');
    nudgeQueueDrainSoon(chatId, userId);
    stampTiming('queued_race', { busy: false, preempted: false });
    return {
      ok: true, queued: true, chatId, position,
      note: 'Message queued — it will run automatically when the current run finishes.',
    };
  }
  await stampSendDepth(chatId, sendDepth);
  stampTiming('started', { busy: enteredBusy, preempted: preemptedMachineRun });
  notifyAgentMessage();
  await audit(userId, 'chat.message', {
    chatId, mode, ...(routing ? { routing } : {}),
    ...(opts.origin ? { origin: opts.origin.kind, sourceChatId: opts.origin.sourceChatId } : { origin: 'user' }),
    contentSnippet: body.slice(0, 140),
  });
    return { queued: true, chatId, mode, delivery: 'started' as const, runId: started, ...(routing ? { routing } : {}) };
}

/**
 * Prefix lookup over the caller's VISIBLE chats (same scope as listChats: the
 * caller's own chats + chats in projects they belong to) — backs the
 * self-correcting send_chat_message 404. Agents occasionally mis-transcribe a
 * chat id (uuid-v1 ids share a time prefix, so a garbled suffix still looks
 * plausible); matching the leading characters against visible chats — with the
 * window relaxing 12→4 on a miss, like suggestProjectsByIdPrefix — lets the
 * tool error say "did you mean …?" instead of dead-ending (feedback
 * 2026-08-04: a fleet supervisor burned two nudges on a never-existent id).
 * Returns at most `limit` (≤5) {id, title} rows, most recently updated first.
 * Never returns chats the caller could not already list — no existence leak.
 */
export async function suggestChatsByIdPrefix(opts: { userId: string; chatIdPrefix: string; limit?: number }) {
  const { userId } = opts;
  const raw = String(opts.chatIdPrefix || '').toLowerCase().replace(/[^0-9a-f-]/g, '');
  if (raw.length < 4) return [];
  const limit = Math.min(5, Math.max(1, opts.limit ?? 3));
  const memberProjectIds = (
    await prisma.projectMember.findMany({ where: { userId }, select: { projectId: true } })
  ).map((m) => m.projectId);
  // Same window relaxation as suggestProjectsByIdPrefix (2026-08-31, ticket
  // 23783c5b): an agent that invents a plausible uuid suffix garbles characters
  // INSIDE the 12-char window (uuid-v1 ids share a time prefix), so the old
  // fixed 12-char match returned nothing and the run dead-ended into a false
  // "visibility bug" ticket. Relax 12 → 4 until something visible matches.
  const scope = [{ userId }, ...(memberProjectIds.length > 0 ? [{ projectId: { in: memberProjectIds } }] : [])];
  // audit 2026-10-08 W3-3: a "…ec52d820" suffix names no prefix — suggest by its tail first.
  const typedSuffix = /^\s*(?:…|\.{2,})/.test(String(opts.chatIdPrefix || ''));
  if (typedSuffix && raw.replace(/-/g, '').length >= 8 && process.env.ID_RESOLVER_HEAL_DISABLED !== '1') {
    const rows = await prisma.crossModelChat.findMany({
      where: { id: { endsWith: raw.replace(/^-+/, '') }, OR: scope },
      select: { id: true, title: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    if (rows.length > 0) return rows;
  }
  for (const n of [12, 10, 8, 6, 4]) {
    if (raw.length < n) continue;
    const rows = await prisma.crossModelChat.findMany({
      where: {
        id: { startsWith: raw.slice(0, n) },
        OR: scope,
      },
      select: { id: true, title: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    if (rows.length > 0) return rows;
  }
  return [];
}

/**
 * Canonical chat id for a chat-TARGETED tool call (owner pending-card incident
 * 2026-09-14): the fleet names chats with the 8-char idiom every list tool
 * prints, the autonomy scope checks now resolve that prefix
 * (autonomy.service resolveChatTarget), and the executor must agree — else a
 * send passes the gate and 404s here with a "did you mean" hint, costing the
 * lane a tool round for an id it already had. Exact id → unchanged (any
 * access mode — getChatById still decides); UNIQUE ≥8-char prefix among the
 * caller's OWN chats → the full id; anything else (short, ambiguous, unknown,
 * a reconstructed 36-char id) → the input unchanged so the existing 404 +
 * suggestChatsByIdPrefix path speaks. Owner-scoped on purpose: a prefix can
 * never widen to a member-shared or foreign chat; those need the full id.
 *
 * Ticket 4057952b (2026-10-09): the implementation moved to the leaf module
 * platform/chat-id-resolver.ts (goals.service needs the SAME resolution for
 * todo assignee ids but must not import platform.service's heavy graph) and
 * re-exports here verbatim — ONE implementation, no behavior change.
 */
export { resolveOwnedChatIdPrefix, ownedChatIdLookup, CHAT_ID_PREFIX_MIN } from './chat-id-resolver';

/**
 * Own-delete tombstone for the chat-id 404 recovery (feedback 88f90ed5): when a
 * chat-id-taking tool 404s on an id with NO near-miss among visible chats, the
 * common real-world cause is that the caller (or their UI session) DELETED the
 * chat after listing it — a fleet supervisor read its own list_chats output back
 * minutes later and the bare "not visible" message accused it of mis-transcribing
 * a verbatim id, producing a phantom visibility-gap bug. Deletion is already
 * audited (crossmodel.service.deleteChat → Activity action 'chat.delete',
 * feedback 138b0347), so the tombstone is free — no schema change.
 *
 * Scoped to the caller's OWN audit rows on purpose: a hit only ever confirms
 * something the caller themselves did, so this lookup can never leak another
 * user's chat existence. Every other 404 cause (never existed, deleted by
 * someone else, private to another account) keeps the deliberate
 * exists/no-access ambiguity of the generic recovery message.
 */
export async function getOwnChatDeletion(opts: { userId: string; chatId: string }): Promise<{ deletedAt: Date } | null> {
  const row = await prisma.activity
    .findFirst({
      where: {
        userId: opts.userId,
        action: 'chat.delete',
        resource: 'platform',
        metadata: { path: ['chatId'], equals: opts.chatId },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    .catch(() => null);
  return row ? { deletedAt: row.createdAt } : null;
}

/**
 * ADMIN existence truth for one chat id (ticket 97c06f46). The 404 every
 * chat-id tool returns is ACCESS-scoped by design (getChatById: no existence
 * leak to strangers), and an admin Fleet Supervisor whose own userId differs
 * from a lane's owner (a second admin account, or any lane in a project the
 * supervisor is not a member of) therefore reads "Chat not found" for a chat
 * that very much exists — which the supervisor then reported as "confirmed
 * DELETED" lanes, filing a false slot-reclaim ticket whose premise the
 * production probe disproved (the "deleted" lanes were live, one with a run
 * updated minutes later).
 *
 * This answers the EXISTENCE question directly, and ONLY for admins — a
 * supervisor- or admin-role caller may be told "the chat exists but is not
 * visible to you" (never an owner id, never a title); every other caller
 * keeps the deliberate ambiguity. Returns null on any error (fail-closed to
 * the existing generic branch).
 *
 * @param opts.userId the CALLER (must hold role ADMIN for the truth; others get null)
 * @param opts.chatId the exact chat id probed (no prefix/near-match healing here —
 *        the recovery path already tried those tiers before it reaches this)
 */
export async function getChatExistenceTruth(opts: { userId: string; chatId: string }): Promise<{ exists: boolean; archivedAt: Date | null } | null> {
  try {
    const caller = await prisma.user.findUnique({ where: { id: opts.userId }, select: { role: true } });
    if (!caller || String(caller.role).toUpperCase() !== 'ADMIN') return null;
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: opts.chatId },
      select: { id: true, archivedAt: true },
    });
    return { exists: !!chat, archivedAt: chat?.archivedAt ?? null };
  } catch {
    return null;
  }
}

/** Rename a chat (owner or project editor/admin). Coding chats also sync the satellite title. */
/**
 * Set a plain chat's stored patience level (capability gap audit T2, 2026-09-24)
 * — the stored preset (Account → Advanced default depth; the composer picker
 * left in the 2026-09-26 compute-policy wave) as a service call. WI-O #4c (2026-09-25): optionally the
 * chat's LEAD-MODEL override too (`leadModel`; null/'' clears) — validated and
 * refused for supervisor/coding chats inside crossModelService.updateChat. At
 * least one of mode / leadModel must be given.
 */
export async function setChatMode(opts: { userId: string; chatId: string; mode?: string; leadModel?: string | null }) {
  const { userId, chatId } = opts;
  const patch: { mode?: any; leadModel?: string | null } = {};
  if (opts.mode !== undefined) {
    // Inline enum (not platform.validation — that module reaches config/env via
    // agent-auth → jwt, which exits a keyless jest at import).
    const mode = String(opts.mode || '');
    if (mode !== 'auto' && !(PATIENCE_MODES as readonly string[]).includes(mode)) throw new AppError(400, 'mode must be single_thinking | thinking | deep_research | auto');
    patch.mode = mode;
  }
  if (opts.leadModel !== undefined) patch.leadModel = opts.leadModel === null ? null : String(opts.leadModel);
  if (patch.mode === undefined && patch.leadModel === undefined) throw new AppError(400, 'mode or leadModel is required');
  const chat = await crossModelService.updateChat(chatId, userId, patch);
  await audit(userId, 'chat.mode', { chatId, ...(patch.mode !== undefined ? { mode: patch.mode } : {}), ...(patch.leadModel !== undefined ? { leadModel: (chat as any)?.leadModel ?? null } : {}) });
  return chat;
}

/** Set / clear a chat's standing instructions (T3b, 2026-09-24) — the Session settings editor and PATCH /platform/chats/:id as a service call. Owner-only; supervisor chats refused inside updateChat. */
export async function setChatInstructions(opts: { userId: string; chatId: string; systemPrompt: string | null }) {
  const { userId, chatId } = opts;
  const chat = await crossModelService.updateChat(chatId, userId, { systemPrompt: opts.systemPrompt ?? '' });
  await audit(userId, 'chat.instructions', { chatId, chars: (opts.systemPrompt ?? '').trim().length });
  return chat;
}

export async function renameChat(opts: { userId: string; chatId: string; title: string; /** Session titles (2026-09-27): false = a lane's goal-half override of its OWN chat (the harness keeps refreshing the step half); default true = a PIN (every renderer / repair path stops). */ pin?: boolean }) {
  const { userId, chatId } = opts;
  const title = String(opts.title || '').trim();
  if (!title) throw new AppError(400, 'title is required');
  const pin = opts.pin !== false;
  const chat = await crossModelService.updateChat(chatId, userId, { title }, { pinTitle: pin });
  // Coding chats carry a satellite title copy (rollback column) — keep it in sync
  // (mirrors coding updateSession → updateSessionState title handling). The
  // provenance stamp follows the pin: 'user' for a pin, 'harness' for a lane's
  // own goal-half override.
  await (prisma as any).chatCodingState
    .update({ where: { id: chatId }, data: { title, titleSource: pin ? 'user' : 'harness' } })
    .catch(() => {});
  await audit(userId, 'chat.rename', { chatId, title, ...(pin ? {} : { pin: false }) });
  // Sidebar push (6201e0ee): a rename from ANY surface (another tab, an agent
  // lane's rename_chat, harness title refresh) invalidates connected sidebars.
  publishChatListEvent(userId, { kind: 'chat.renamed', chatId });
  return chat;
}

/**
 * Archive/unarchive a chat (owner 2026-09-08: archive is the primary
 * de-clutter path — delete stays the permanent one). Stamps
 * crossmodel_chats.archivedAt on ANY chat: archived chats leave the default
 * lists/search but still load by direct id (not tombstoning); restore clears
 * the stamp losslessly. Owner-only, matching deleteChat's access level.
 *
 * Guards (archive must stay lossless, so it REFUSES instead of force-stopping
 * the way delete does): 409 while a coding run is active (the pre-existing
 * archive convention) and 409 while the chat has ENABLED schedules — a cadence
 * silently firing runs into a hidden chat is the surprise this blocks; pause or
 * cancel first. The Fleet Supervisor is a pinned system row — never archivable
 * (mirrors its rename/move refusal).
 *
 * Coding chats ALSO flip their satellite status ('archived'/'ready') so the
 * coding-session surfaces (dormant-session reuse, reaper, confirmations) keep
 * their existing semantics; unarchive lands on 'ready' — a missing worktree is
 * re-provisioned at run start (same as coding.controller.updateSession).
 *
 * `actorChatId` (archived-target-retire review 2026-10-20) is the chat whose
 * turn is archiving (the archive_chat tool's session): when it is the
 * supervisor that inherits the lane's unassigned todos, it gets them back as
 * `actorInherited` on the result instead of a todo_wake about its own action.
 *
 * CASCADE (lane lifecycle C2, 2026-10-21): archiving a chat also archives its
 * IDLE children (parentChatId only — never a display parent), recursively to
 * ARCHIVE_CASCADE_MAX_DEPTH; a child that is a supervisor, running, scheduled
 * (its schedules are never paused here), has a live descendant, holds an open
 * todo, waits on the owner (open question / pending confirmation), had a human
 * message in 7 d or any run / message in 6 h stays. A restore brings back
 * exactly the children that archive took (the [chatId,'archive-cascade']
 * marker, ±120 s of its stamp). `cascadeOf` / `cascadeDepth` / `source` ride the
 * audit row only when set, so a plain call writes it byte-for-byte as before.
 * ARCHIVE_CASCADE_DISABLED=1 restores the single-chat archive.
 *
 * RESTORE MARKER (review fixer 2026-10-21): restoring a chat that WAS archived
 * writes the lane-family-facts marker, so lane-retire never archives it (or a
 * parent whose cascade would take it) again; nothing is written only when every
 * marker reader is off (LANE_IDLE_RETIRE_DISABLED=1 + ARCHIVE_CASCADE_DISABLED=1
 * + TICKET_LANE_ARCHIVE_GAPS_DISABLED=1).
 *
 * WHO ARCHIVES (second review fixer 2026-10-21): `ownerAction: true` — the
 * owner's own archive (the web Archive button, an archive_chat call on a HUMAN
 * turn) — keeps the cascade above as it is. Every other caller is a MACHINE
 * (lane-retire, the ticket drain, the run-reaper, the idle-chat archiver, a
 * supervisor's archive_chat, the platform / session REST APIs): its cascade
 * also applies the root's own rules to each child (cascadeMachineBlocker — the
 * restore marker, machine-spawn proof, a 14-day human window, an active share
 * link, a pinned title, an inbound integration, the current lane of an owning
 * ticket, the standing lane), takes only children in the PARENT'S folder, and
 * stops after `cascadeBudget` children (default ARCHIVE_CASCADE_MACHINE_MAX_TOTAL
 * per archive; lane-retire hands in its pass-wide budget).
 *
 * Third review (2026-10-22): a MACHINE cascade is never looser than the rule
 * that archived its root — `cascadeIdleMs` (the caller's own idle bar:
 * lane-retire 7 d, the idle archiver its folder's N days, the reaper 7 d / 6 h)
 * is each child's quiet window too (never below ARCHIVE_CASCADE_QUIET_MS), and
 * a child whose CHARTER is open (its charter todo open and its own or
 * unassigned, or its charter goal active / blocked — lane-retire's
 * charterOpen) stays. The OWNER's cascade keeps a child that is pinned,
 * shared, wired to an inbound integration or filed in another folder (it
 * takes only the parent's folder), and an archive_chat on a HUMAN turn of a
 * SUPERVISOR chat (actorChatId a Fleet / Project Supervisor) cascades as a
 * machine archive — the model picked the lanes, not the owner.
 */
export async function archiveChat(opts: { userId: string; chatId: string; archived?: boolean; actorChatId?: string | null; cascadeOf?: string; cascadeDepth?: number; source?: string; ownerAction?: boolean; cascadeBudget?: { remaining: number }; cascadeIdleMs?: number; restoreAuditCache?: RestoreAuditCache }): Promise<{ id: string; archived: boolean; actorInherited?: import('./archived-target-retire').ArchivedLaneTodo[] }> {
  const { userId, chatId } = opts;
  const archived = opts.archived !== false;
  // The restore leg also reads archivedAt: a REAL restore (the chat was archived) is remembered for lane-retire below.
  const chat: { userId: string; isSupervisor: boolean; isProjectSupervisor: boolean; archivedAt?: Date | null } | null = await prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: { userId: true, isSupervisor: true, isProjectSupervisor: true, ...(archived ? {} : { archivedAt: true }) },
  });
  if (!chat || chat.userId !== userId) throw new AppError(404, 'Chat not found');
  if (chat.isSupervisor) throw new AppError(400, 'The Fleet Supervisor chat cannot be archived');
  // A PROJECT supervisor lane has the same pause-never-delete contract
  // (hardening 2026-09-14): hooks.service carries no archivedAt filter, so an
  // archived lane keeps waking on hooks/sweep while the sidebar hides it and
  // the folder toggle still says ON. Refuse the ARCHIVE leg only — restoring a
  // lane archived before this guard landed must stay possible (a refusal
  // there would strand it hidden forever).
  if (chat.isProjectSupervisor && archived) {
    throw new AppError(400, "A project supervisor chat cannot be archived — pause it from the folder's Project supervisor toggle instead");
  }

  // NO .catch: a DB error must fail the archive, not silently misclassify a
  // coding chat as plain (the updateChat satellite-lookup discipline).
  const state: { status: string } | null = await (prisma as any).chatCodingState.findUnique({
    where: { id: chatId },
    select: { status: true },
  });

  if (archived) {
    if (state?.status === 'running') throw new AppError(409, 'Cannot archive while a run is active');
    const enabledSchedules = await prisma.chatSchedule.count({
      where: { sessionId: chatId, enabled: true },
    });
    if (enabledSchedules > 0) {
      throw new AppError(409, 'This chat has enabled schedules — pause or cancel them before archiving');
    }
  }

  await prisma.crossModelChat.update({
    where: { id: chatId },
    data: { archivedAt: archived ? new Date() : null },
  });
  // Coding satellite rides along; restore only flips a satellite that archive
  // parked (never stomps provisioning/error states).
  if (state && (archived ? state.status !== 'archived' : state.status === 'archived')) {
    await updateSessionState(chatId, { status: archived ? 'archived' : 'ready' });
  }
  await audit(userId, archived ? 'chat.archive' : 'chat.restore', { chatId, ...(opts.cascadeOf ? { cascadeOf: opts.cascadeOf } : {}), ...(opts.source ? { source: opts.source } : {}) });
  // audit 2026-10-06 T3-12: an archived chat's OUTGOING hooks pause; a restore re-arms exactly those (best-effort).
  try { const hooksMod = await import('./hooks.service'); await (archived ? hooksMod.pauseHooksForArchivedSource(userId, chatId) : hooksMod.resumeHooksForRestoredSource(userId, chatId)); } catch { /* best-effort */ }
  // ARCHIVED-TARGET-RETIRE (e, 2026-10-20): an archived lane's live todos are
  // UNASSIGNED (progressNote 'lane archived …', ONE todo_wake to the project's
  // supervisor, else the Fleet Supervisor) — the board stops reading them as
  // owned by a chat that will never run. A restore re-arms the schedules the
  // archive paused (the sweeper pauses rows refused 'archived'; the session
  // API's archive pauses them up front). Best-effort; kill switch
  // ARCHIVED_TARGET_RETIRE_DISABLED=1 (both helpers read it).
  let actorInherited: import('./archived-target-retire').ArchivedLaneTodo[] | undefined;
  try {
    if (archived) {
      const { unassignTodosForArchivedLane } = await import('./archived-target-retire');
      const r = await unassignTodosForArchivedLane({ userId, chatId, source: 'archive_chat', actorChatId: opts.actorChatId ?? null });
      if (r.actorInherited?.length) actorInherited = r.actorInherited;
    } else {
      const { resumeSchedulesForRestoredChat } = await import('../coding/schedule.service');
      await resumeSchedulesForRestoredChat(chatId);
    }
  } catch { /* best-effort */ }
  // Session titles (2026-09-27): the step half reads "archived" / comes back — best-effort, never on the result.
  try { const { refreshSessionTitle } = await import('./session-titles'); void refreshSessionTitle(chatId, archived ? 'archive' : 'restore', { force: true }); } catch { /* best-effort */ }
  // Sidebar push (6201e0ee): an archive/restore from ANY surface (the owner's
  // other tab, a supervisor lane's archive_chat, the idle archiver) must
  // invalidate connected sidebars — the delta feed alone can never report an
  // archive (archived rows leave the default list), so without this push the
  // row lingered until a manual page refresh.
  publishChatListEvent(userId, { kind: archived ? 'chat.archived' : 'chat.restored', chatId });
  // LANE-IDLE-RETIRE review fixer (2026-10-21): a restore of a chat that WAS
  // archived is remembered (lane-family-facts restore marker) — lane-retire never
  // archives it again, nor the parent whose cascade would take it back. Without
  // this the next 6-hourly pass re-archived a lane the owner had just restored.
  // Never throws; LANE_IDLE_RETIRE_DISABLED=1 writes nothing.
  if (!archived && chat.archivedAt) {
    await rememberLaneRestore(chatId, { source: opts.source ?? null, actorChatId: opts.actorChatId ?? null, cascade: (opts.cascadeDepth ?? 0) > 0 });
  }
  // CASCADE (C2): the idle children follow the parent; a restore brings back what the archive took. Never throws.
  if (!archiveCascadeDisabled() && (opts.cascadeDepth ?? 0) < ARCHIVE_CASCADE_MAX_DEPTH) {
    try {
      if (archived) {
        const owner = opts.ownerAction === true && !(await actorIsSupervisorOrUnknown(opts.actorChatId));
        // A machine archive's cascade is bounded: the caller's budget, else a fresh per-archive one.
        const budget = owner ? undefined : (opts.cascadeBudget ?? { remaining: ARCHIVE_CASCADE_MACHINE_MAX_TOTAL });
        // Fifth review (2026-10-22): ONE restore-audit memo for the whole cascade
        // tree (the caller's per-pass memo when it hands one in).
        const restoreAuditCache = owner ? undefined : (opts.restoreAuditCache ?? new Map());
        await cascadeArchiveChildren(userId, chatId, opts.cascadeDepth ?? 0, { owner, budget, idleMs: owner ? 0 : Math.max(0, Number(opts.cascadeIdleMs) || 0), ...(restoreAuditCache ? { restoreAuditCache } : {}) });
      } else await cascadeRestoreChildren(userId, chatId, opts.cascadeDepth ?? 0);
    } catch (err: any) {
      logger.warn(`archiveChat: cascade for ${chatId} failed (non-fatal): ${err?.message ?? err}`);
    }
  }
  return { id: chatId, archived, ...(actorInherited ? { actorInherited } : {}) };
}

// ── Archive cascade (lane lifecycle C2, 2026-10-21) ──────────────────────────

/** How deep a cascade reaches (parent → child → grandchild → great-grandchild). */
export const ARCHIVE_CASCADE_MAX_DEPTH = 3;
/** Children examined per archived chat (oldest first). */
export const ARCHIVE_CASCADE_MAX_CHILDREN = 25;
/** A human message on the child inside this window keeps it (the owner's archive; a machine archive uses LANE_HUMAN_WINDOW_MS, 14 d). */
export const ARCHIVE_CASCADE_HUMAN_WINDOW_MS = 7 * 86400_000;
/** Any run / message on the child inside this window keeps it. */
export const ARCHIVE_CASCADE_QUIET_MS = 6 * 3600_000;
/** A restore brings back a child only when its archivedAt sits this close to the time ITS archive ran (the marker's per-child window; the legacy single stamp otherwise). */
export const ARCHIVE_CASCADE_RESTORE_WINDOW_MS = 120_000;
/** A MACHINE archive's cascade takes at most this many children in all (every level), unless the caller hands in its own budget. */
export const ARCHIVE_CASCADE_MACHINE_MAX_TOTAL = 50;
/** The root rules a machine cascade also reads per child (the rest the child read below already covers). */
const CASCADE_MACHINE_LEGS: readonly LaneKeepReason[] = ['share_link', 'title_pinned', 'inbound_integration', 'ticket_owned', 'standing_lane'];
/** Third review (2026-10-22): the rules the OWNER's own cascade keeps a child on — the owner archived the parent, not a chat they pinned, shared or wired an integration to. */
const CASCADE_OWNER_LEGS: readonly LaneKeepReason[] = ['share_link', 'title_pinned', 'inbound_integration'];
/** lane-retire / session-topology charterOpen: an open charter todo (its own or unassigned) or an active / blocked charter goal. */
const CASCADE_OPEN_TODO = ['pending', 'in_progress', 'blocked'];
const CASCADE_OPEN_GOAL = ['active', 'blocked'];

/**
 * Third review (2026-10-22): an archive_chat on a HUMAN turn is the owner's own
 * archive only when the acting chat is not a supervisor — on a Fleet / Project
 * Supervisor chat the model picked the lanes, so their children cascade under
 * the machine rules. No actor (the web Archive button) = the owner. A failed or
 * empty actor read reads as a supervisor (the stricter cascade). Never throws.
 */
async function actorIsSupervisorOrUnknown(actorChatId: string | null | undefined): Promise<boolean> {
  if (!actorChatId) return false;
  try {
    const actor = await prisma.crossModelChat.findUnique({ where: { id: actorChatId }, select: { isSupervisor: true, isProjectSupervisor: true } });
    return !actor || actor.isSupervisor === true || actor.isProjectSupervisor === true;
  } catch {
    return true;
  }
}

/**
 * Third review (2026-10-22): the child's CHARTER is open — session-topology's
 * charterOpen (lane-retire rule 4) on a fresh read: its charter todo is open and
 * its own or unassigned, or its charter goal is active / blocked. A missing row
 * is not open; a failed read throws (the cascade then keeps the child).
 */
async function cascadeCharterOpen(child: { id: string; charterGoalId?: string | null; charterTodoId?: string | null }): Promise<boolean> {
  if (!child.charterGoalId && !child.charterTodoId) return false;
  const [todo, goal] = await Promise.all([
    child.charterTodoId ? prisma.projectTodo.findUnique({ where: { id: child.charterTodoId }, select: { status: true, assigneeChatId: true } }) : Promise.resolve(null),
    child.charterGoalId ? prisma.projectGoal.findUnique({ where: { id: child.charterGoalId }, select: { status: true } }) : Promise.resolve(null),
  ]);
  const todoOpen = !!todo && CASCADE_OPEN_TODO.includes(String(todo.status)) && (todo.assigneeChatId == null || todo.assigneeChatId === child.id);
  const goalOpen = !!goal && CASCADE_OPEN_GOAL.includes(String(goal.status));
  return todoOpen || goalOpen;
}
const ARCHIVE_CASCADE_NS = (chatId: string): string[] => [chatId, 'archive-cascade'];
const ARCHIVE_CASCADE_KEY = 'children';
const CASCADE_MACHINE_ORIGINS = new Set(['agent', 'webhook', 'schedule', 'hook', 'machine']);

/** ARCHIVE_CASCADE_DISABLED=1 restores the single-chat archive (the env read lives in the lane-family-facts leaf, which the coding dispatch heal loads too). */
export { archiveCascadeDisabled };

/**
 * Why a child must NOT follow its parent into the archive (null = it may).
 * Fresh reads; a failed read keeps the child. Review fixer (2026-10-21): a child
 * parked on the owner (an open owner question / a pending confirmation — the
 * answer would re-route to a supervisor) and a child with a LIVE descendant
 * (archiving it pauses the result hook that descendant reports through) stay too.
 * Second review fixer: under a MACHINE archive (`machine`) the human window is
 * the root's 14 days, a child carrying the restore marker (or, fourth review
 * 2026-10-22, a restore AUDIT row the marker never recorded) stays, and the
 * root's remaining rules apply (cascadeMachineBlocker).
 */
async function cascadeChildBlocker(child: { id: string; isSupervisor: boolean; isProjectSupervisor: boolean; charterGoalId?: string | null; charterTodoId?: string | null }, machine: boolean, idleMs = 0, restoreAuditCache?: RestoreAuditCache): Promise<string | null> {
  if (child.isSupervisor || child.isProjectSupervisor) return 'supervisor';
  const now = Date.now();
  // Third review (2026-10-22): a machine cascade's quiet window is the root rule's own idle bar (never below 6 h).
  const quiet = new Date(now - (machine ? Math.max(ARCHIVE_CASCADE_QUIET_MS, idleMs) : ARCHIVE_CASCADE_QUIET_MS));
  // A machine cascade uses the root's 14-day human window (lane-retire rule 12) and reads the restore marker.
  const humanWindowMs = machine ? LANE_HUMAN_WINDOW_MS : ARCHIVE_CASCADE_HUMAN_WINDOW_MS;
  const [state, liveRun, schedules, openTodo, recentRun, recentMsg, userRows, ownerQuestion, confirmation, family] = await Promise.all([
    (prisma as any).chatCodingState.findUnique({ where: { id: child.id }, select: { status: true } }),
    prisma.agentRun.findFirst({ where: { sessionId: child.id, status: { in: ['queued', 'running', 'interrupted'] } }, select: { id: true } }),
    prisma.chatSchedule.count({ where: { sessionId: child.id, enabled: true } }),
    prisma.projectTodo.findFirst({ where: { assigneeChatId: child.id, status: { in: ['pending', 'in_progress', 'blocked'] } }, select: { id: true } }),
    prisma.agentRun.findFirst({ where: { sessionId: child.id, updatedAt: { gte: quiet } }, select: { id: true } }),
    prisma.crossModelMessage.findFirst({ where: { chatId: child.id, createdAt: { gte: quiet } }, select: { id: true } }),
    prisma.crossModelMessage.findMany({ where: { chatId: child.id, role: 'user', createdAt: { gte: new Date(now - humanWindowMs) } }, select: { metadata: true }, take: 200 }),
    prisma.ownerQuestion.findFirst({ where: { chatId: child.id, status: 'open' }, select: { id: true } }),
    prisma.pendingConfirmation.findFirst({ where: { chatId: child.id, status: 'pending', expiresAt: { gt: new Date(now) } }, select: { id: true } }),
    // Fourth review (2026-10-22): a machine cascade reads the restore AUDIT too — a
    // restore made before the marker shipped (an audit row, no marker) keeps the
    // child exactly as the drain and lane-retire read it.
    // Fifth review (2026-10-22): the audit comes from the cascade's memo (pre-filled
    // for every child + descendant in ONE read before the loop), never one
    // activities scan per child.
    readLaneFamilyFacts([child.id], machine ? { restored: true, restoreAudit: true, ...(restoreAuditCache ? { restoreAuditCache } : {}) } : { restored: false }),
  ]);
  if (state?.status === 'running' || state?.status === 'provisioning' || liveRun) return 'running';
  if (schedules > 0) return 'schedule';
  if (!family || family.liveRoots.has(child.id)) return 'live_child';
  // A child the owner restored is the owner's from then on (the lane-family-facts marker).
  if (machine && family.restoredRoots.has(child.id)) return 'owner_restored';
  if (openTodo) return 'open_todo';
  if (ownerQuestion || confirmation) return 'awaiting_owner';
  // A full page with no human row found still reads human (fail-safe).
  const human = (userRows as Array<{ metadata: unknown }>).some((r) => {
    const o = String((r.metadata && typeof r.metadata === 'object' ? (r.metadata as any).origin : '') ?? '').trim();
    return !CASCADE_MACHINE_ORIGINS.has(o);
  });
  if (human || userRows.length >= 200) return 'human_recent';
  if (recentRun || recentMsg) return 'recent_activity';
  if (!machine) return cascadeOwnerBlocker(child.id);
  // Third review (2026-10-22): lane-retire refuses a root whose charter is open — so does its cascade.
  if (await cascadeCharterOpen(child)) return 'charter_open';
  return cascadeMachineBlocker(child.id);
}

/** Third review (2026-10-22): the OWNER cascade keeps a pinned, shared or integration-wired child. A failed read keeps it. */
async function cascadeOwnerBlocker(childId: string): Promise<string | null> {
  const keep = await readLaneKeepReasons([childId], { legs: CASCADE_OWNER_LEGS });
  if (!keep) return 'read_failed';
  return keep.get(childId) ?? null;
}

/**
 * The root's own rules on a child of a MACHINE archive (second review fixer
 * 2026-10-21) — lane-retire never archives a chat on these, and the cascade
 * must not archive one either just because its parent went: an active share
 * link (archiving never revokes it), a pinned title, an inbound integration,
 * the current lane of an owning ticket, the standing lane, and no
 * machine-spawn proof (an owner-created child — a human-turn spawn, an API
 * session — is archived only by its owner or the opted-in idle archiver). A
 * failed read keeps the child.
 */
async function cascadeMachineBlocker(childId: string): Promise<string | null> {
  const [keep, proofs] = await Promise.all([
    readLaneKeepReasons([childId], { legs: CASCADE_MACHINE_LEGS }),
    proveMachineSpawned([childId]),
  ]);
  if (!keep) return 'read_failed';
  const reason = keep.get(childId);
  if (reason) return reason;
  if (!proofs.has(childId)) return 'owner_created';
  return null;
}

async function cascadeArchiveChildren(userId: string, chatId: string, depth: number, mode: { owner: boolean; budget?: { remaining: number }; idleMs?: number; restoreAuditCache?: RestoreAuditCache }): Promise<void> {
  // A cascade takes only the children filed in the parent's own folder (an
  // idle-archiver pass in an opted-in folder must not reach folders that never
  // opted in; third review 2026-10-22: the owner archived THIS folder's chat — a
  // child they moved into another folder stays too). A failed scope read
  // cascades nothing.
  if (mode.budget && mode.budget.remaining <= 0) return;
  const parent = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { projectId: true } }).catch(() => null);
  if (!parent) return;
  const scope = { projectId: parent.projectId ?? null };
  const children = await prisma.crossModelChat.findMany({
    where: { parentChatId: chatId, userId, archivedAt: null, projectId: scope.projectId },
    select: { id: true, isSupervisor: true, isProjectSupervisor: true, charterGoalId: true, charterTodoId: true },
    orderBy: { createdAt: 'asc' }, take: ARCHIVE_CASCADE_MAX_CHILDREN,
  });
  if (!children.length) return;
  // Fifth review (2026-10-22): a MACHINE cascade reads the restore AUDIT for
  // every child and its descendants in ONE batched read (into the cascade's
  // memo) before the loop — the per-child read was one full activities scan per
  // child, charged to no budget (a kept child cost a scan and nothing else). A
  // failed read keeps every child (the per-child rule's own fail-closed).
  if (!mode.owner) {
    const cache = mode.restoreAuditCache ?? (mode.restoreAuditCache = new Map());
    const pre = await readLaneFamilyFacts(children.map((c) => c.id), { restored: true, restoreAudit: true, restoreAuditCache: cache });
    if (!pre) {
      logger.info(`archiveChat: cascade of ${chatId} kept its ${children.length} child(ren) — the restore read failed`);
      return;
    }
  }
  const at = new Date();
  const archivedIds: string[] = [];
  // Per child, the window its own archive ran in — a restore matches each child
  // against ITS window, so a slow, deep tree never strands a late child (the
  // single `at` stamp was taken before the sequential, recursive loop).
  const windows: Record<string, { from: string; to: string }> = {};
  for (const child of children) {
    if (mode.budget && mode.budget.remaining <= 0) {
      logger.info(`archiveChat: cascade of ${chatId} stopped at its budget — ${children.length - archivedIds.length} child(ren) not examined`);
      break;
    }
    try {
      const blocker = await cascadeChildBlocker(child, !mode.owner, mode.idleMs ?? 0, mode.restoreAuditCache);
      if (blocker) { logger.info(`archiveChat: cascade kept child ${child.id} of ${chatId} (${blocker})`); continue; }
      const from = new Date();
      if (mode.budget) mode.budget.remaining--;
      try {
        await archiveChat({ userId, chatId: child.id, cascadeOf: chatId, cascadeDepth: depth + 1, ...(mode.owner ? { ownerAction: true } : {}), ...(mode.budget ? { cascadeBudget: mode.budget } : {}), ...(mode.idleMs ? { cascadeIdleMs: mode.idleMs } : {}), ...(mode.restoreAuditCache ? { restoreAuditCache: mode.restoreAuditCache } : {}) });
      } catch (err) {
        if (mode.budget) mode.budget.remaining++;
        throw err;
      }
      windows[child.id] = { from: from.toISOString(), to: new Date().toISOString() };
      archivedIds.push(child.id);
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.LANE_RETIRED, sessionId: child.id, meta: { phase: 'cascade', parentChatId: chatId, chatId: child.id, depth: depth + 1 } });
    } catch (err: any) {
      // A refusal (409: a run / schedule appeared in the race window) or any error keeps that child; the rest continue.
      logger.info(`archiveChat: cascade child ${child.id} of ${chatId} not archived (${err?.statusCode ?? '-'}: ${err?.message ?? err})`);
    }
  }
  if (!archivedIds.length) return;
  const { storePut } = await import('../memory/context-store');
  await storePut(ARCHIVE_CASCADE_NS(chatId), ARCHIVE_CASCADE_KEY, { childIds: archivedIds, at: at.toISOString(), windows });
}

/**
 * The cascade took this child — its archivedAt lies within the window its own
 * archive ran in (±ARCHIVE_CASCADE_RESTORE_WINDOW_MS), or, on a marker written
 * before per-child windows existed, within that slack of the marker's stamp.
 * A child archived again on its own later stays archived. Pure.
 */
export function cascadeTookChild(archivedAt: Date | string | null | undefined, window: { from?: unknown; to?: unknown } | undefined, markerAt: number): boolean {
  if (!archivedAt) return false;
  const t = new Date(archivedAt).getTime();
  if (!Number.isFinite(t)) return false;
  const from = window ? new Date(String(window.from ?? '')).getTime() : NaN;
  const to = window ? new Date(String(window.to ?? '')).getTime() : NaN;
  if (Number.isFinite(from) && Number.isFinite(to)) return t >= from - ARCHIVE_CASCADE_RESTORE_WINDOW_MS && t <= to + ARCHIVE_CASCADE_RESTORE_WINDOW_MS;
  return Number.isFinite(markerAt) && Math.abs(t - markerAt) <= ARCHIVE_CASCADE_RESTORE_WINDOW_MS;
}

async function cascadeRestoreChildren(userId: string, chatId: string, depth: number): Promise<void> {
  const { storeGet, storeDelete } = await import('../memory/context-store');
  const marker = await storeGet<{ childIds?: unknown; at?: unknown; windows?: unknown }>(ARCHIVE_CASCADE_NS(chatId), ARCHIVE_CASCADE_KEY);
  if (!marker) return;
  const ids = Array.isArray(marker.childIds) ? marker.childIds.map(String).filter(Boolean) : [];
  const at = new Date(String(marker.at ?? '')).getTime();
  const windows = marker.windows && typeof marker.windows === 'object' ? marker.windows as Record<string, { from?: unknown; to?: unknown }> : {};
  if (ids.length && (Number.isFinite(at) || Object.keys(windows).length)) {
    const rows = await prisma.crossModelChat.findMany({ where: { id: { in: ids }, userId, archivedAt: { not: null } }, select: { id: true, archivedAt: true } });
    for (const r of rows) {
      // Only what THIS cascade archived — a child archived again on its own later stays archived.
      if (!cascadeTookChild(r.archivedAt, windows[r.id], at)) continue;
      try {
        await archiveChat({ userId, chatId: r.id, archived: false, cascadeDepth: depth + 1 });
      } catch (err: any) {
        logger.info(`archiveChat: cascade restore of child ${r.id} (parent ${chatId}) failed (non-fatal): ${err?.message ?? err}`);
      }
    }
  }
  await storeDelete(ARCHIVE_CASCADE_NS(chatId), ARCHIVE_CASCADE_KEY);
}

/**
 * Move a chat into a project (projectId null = the owner's hidden user-space
 * project — User Space §3: "No folder (ungrouped)" re-files there instead of
 * disconnecting; only a user-space hiccup falls back to a real disconnect).
 * Owner-only on the
 * CHAT, and the mover must also hold write access (owner or editor/admin
 * member) on the DESTINATION project. Coding chats may move ONLY into a plain
 * folder (repoProvider NULL) — detaching the session from its repo project;
 * moves to another workspace project or to null are refused. All of it is
 * enforced inside crossModelService.updateChat.
 */
export async function moveChat(opts: { userId: string; chatId: string; projectId: string | null }) {
  const { userId, chatId, projectId } = opts;
  // Framework surface (ticket 9471d338): crossmodel.service.updateChat (the
  // shared chokepoint every move rides) refuses system-lane moves in/out of
  // the platform's own project; this seam refuses a move INTO it early. The
  // destination 404-shape matches updateChat's target authorization.
  if (projectId) {
    const dest = await prisma.crossModelProject.findUnique({
      where: { id: projectId },
      select: { repoUrl: true },
    });
    if (dest && isFrameworkProject(dest)) {
      throw new AppError(403, frameworkProjectRefusal('move-into'));
    }
  }
  const chat = await crossModelService.updateChat(chatId, userId, { projectId });
  await audit(userId, 'chat.move', { chatId, projectId });
  // Sidebar push (6201e0ee): a move from ANY surface (another tab, an agent
  // lane's move_chat) invalidates connected sidebars — a moved row changes
  // folder grouping, and the delta feed only refreshes rows that stay visible.
  publishChatListEvent(userId, { kind: 'chat.moved', chatId });
  return chat;
}

/**
 * Convert a PLAIN chat into a coding session in place: attach the
 * ChatCodingState satellite (id == chat id) and return the session view.
 * History is preserved automatically — the coding transcript reads
 * crossmodel_messages, so there is no backfill and no `mode` write ('code' is
 * a retired marker). Owner-only; the Fleet Supervisor chat is refused
 * (conversion is meaningless for it — updateChat refuses its moves too).
 *
 * Optional folder move FIRST (opts.projectId ≠ current): the move rides
 * crossModelService.updateChat while the satellite does not exist yet, so a
 * plain chat can still move INTO a workspace project (the coding-move guards
 * key off the satellite). Idempotent: a chat whose satellite is already
 * attached gets its existing session back (ensureChatWorkspaceState's early
 * return is a plain read).
 */
export async function convertChatToCoding(opts: { userId: string; chatId: string; projectId?: string }) {
  const { userId, chatId } = opts;
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: { id: true, userId: true, projectId: true, title: true, isSupervisor: true, isProjectSupervisor: true, ghostMode: true },
  });
  // 404-shaped like updateChat — a non-owner must not learn the chat exists.
  if (!chat || chat.userId !== userId) throw new AppError(404, 'Chat not found');
  // Ghost mode (owner 2026-10-22): the satellite's agent model is set with
  // set_session_model — the ghost posture cannot survive a conversion (the
  // coding path never reads ghostMode). Clear it so the row never LIES about
  // being private while the coding run streams through normal seats.
  if (chat.ghostMode) {
    await crossModelService.updateChat(chatId, userId, { ghostMode: false });
  }
  if (chat.isSupervisor) throw new AppError(400, 'The Fleet Supervisor chat cannot be converted to a coding session');
  if (chat.isProjectSupervisor) throw new AppError(400, 'A project supervisor chat cannot be converted to a coding session — it orchestrates workers, it is not one');
  // Kids (User Space §4c): coding stays an adult surface — the same 403 as
  // streamChatRun / streamCapabilityRun / sendChatMessage's satellite branch.
  const sender = await prisma.user
    .findUnique({ where: { id: userId }, select: { isChild: true } })
    .catch(() => null);
  if (sender?.isChild) throw new AppError(403, 'Coding is not available for child accounts');

  const projectId = opts.projectId ?? chat.projectId;
  if (opts.projectId && opts.projectId !== chat.projectId) {
    await crossModelService.updateChat(chatId, userId, { projectId: opts.projectId });
  }

  // Same lazy-attach helper sendChatMessage uses (dynamic import — see there).
  const { ensureChatWorkspaceState } = await import('../coding/coding-data.service');
  const session = await ensureChatWorkspaceState({ id: chat.id, userId: chat.userId, projectId, title: chat.title });
  if (!session) throw new AppError(400, 'No workspace resolves for this chat — attach one to its folder first.');
  await audit(userId, 'chat.convert-to-coding', { chatId, projectId });
  return session;
}

/** Delete a chat. Owner-only; coding runtime state is cleaned up inside the shared path. */
export async function deleteChat(opts: { userId: string; chatId: string }) {
  const { userId, chatId } = opts;
  // The chat.delete Activity row is written INSIDE crossModelService.deleteChat
  // (feedback 138b0347) so the coding-session DELETE endpoint — which
  // delegates there directly — is audited too. No second row here.
  const deleted = await crossModelService.deleteChat(chatId, userId);
  // Sidebar push (6201e0ee, review N5): a DELETED row never returns in any
  // delta response (unlike an archived row with includeArchived), so without
  // this notice the sidebar keeps a ghost row until the next full refetch.
  // The client drops the id locally on chat.deleted.
  publishChatListEvent(userId, { kind: 'chat.deleted', chatId });
  return deleted;
}

// ── Projects ──────────────────────────────────────────────────────────────────

/**
 * Create a project (owner = the caller). Mirrors projects.controller.createProject.
 *
 * P2 folder tree: with a `parentId` the project becomes a nested folder — the
 * caller needs owner or editor/admin access on the parent chain (viewers
 * blocked), and the resulting depth (parent.depth + 1) must not exceed
 * MAX_FOLDER_DEPTH. `depth`/`path` (materialized `/rootId/.../id`) are ALWAYS
 * set — including roots (depth 0, path '/'+id), which pre-P2 creates omitted.
 */
export async function createProject(opts: {
  userId: string; name: string; description?: string; systemPrompt?: string; emoji?: string; color?: string;
  parentId?: string | null;
}) {
  const { userId } = opts;
  if (!opts.name?.trim()) throw new AppError(400, 'name is required');

  let parentId: string | null = null;
  let depth = 0;
  const id = randomUUID();
  let path = `/${id}`;
  if (opts.parentId) {
    const access = await getProjectAccess(opts.parentId, userId);
    if (!access) throw new AppError(404, 'Parent folder not found or no access');
    if (access.role === 'viewer') throw new AppError(403, 'Viewers cannot create subfolders in this folder');
    // Framework surface (ticket 9471d338): not a folder to file user projects
    // under — the same move-into refusal the move seam enforces.
    if (isFrameworkProject(access.project)) {
      throw new AppError(403, frameworkProjectRefusal('move-into'));
    }
    const parent = access.project;
    depth = (parent.depth ?? 0) + 1;
    if (depth > MAX_FOLDER_DEPTH) {
      throw new AppError(400, `Folder depth limit reached (max depth ${MAX_FOLDER_DEPTH})`);
    }
    parentId = parent.id;
    path = `${parent.path || `/${parent.id}`}/${id}`;
  }

  const project = await prisma.crossModelProject.create({
    data: {
      id,
      userId,
      name: opts.name.trim(),
      description: opts.description?.trim() || null,
      systemPrompt: opts.systemPrompt?.trim() || null,
      emoji: opts.emoji || '📁',
      color: opts.color || 'violet',
      parentId,
      depth,
      path,
    },
  });
  await audit(userId, 'project.create', { projectId: project.id, name: project.name, ...(parentId ? { parentId } : {}) });

  return project;
}

/**
 * Move a folder (and its whole subtree) to a new parent — or to the root with
 * newParentId null. OWNER-only (like deleteProject): the caller must own both
 * the folder and the target parent (trees are per-owner).
 *
 * Checks: no cycles (target can't be the folder itself or inside its subtree);
 * depth cap (target.depth + 1 + subtreeHeight ≤ MAX_FOLDER_DEPTH). The
 * materialized `path` is prefix-swapped for the folder AND all descendants in
 * one transaction; depths shift by the delta.
 */
export async function moveFolder(opts: { userId: string; folderId: string; newParentId: string | null }) {
  const { userId, folderId, newParentId } = opts;
  const folder = await prisma.crossModelProject.findUnique({ where: { id: folderId } });
  if (!folder || folder.userId !== userId) {
    throw new AppError(404, 'Project not found or not owner');
  }
  // Framework surface (ticket 9471d338): the platform's own project is a
  // pinned root in the tree, and nothing may be filed INSIDE it either (it is
  // not a user folder to nest under) — both directions refuse.
  if (isFrameworkProject(folder)) {
    throw new AppError(403, frameworkProjectRefusal('move'));
  }
  if (newParentId === folderId) {
    throw new AppError(400, 'Cannot move a folder into itself');
  }

  const oldPath = folder.path || `/${folder.id}`;
  let newParent: any = null;
  if (newParentId) {
    newParent = await prisma.crossModelProject.findUnique({ where: { id: newParentId } });
    if (!newParent || newParent.userId !== userId) {
      throw new AppError(404, 'Target folder not found or not owner');
    }
    if (isFrameworkProject(newParent)) {
      throw new AppError(403, frameworkProjectRefusal('move'));
    }
    const parentPath = newParent.path || `/${newParent.id}`;
    // Cycle check: the target must not live inside the folder's own subtree.
    if (parentPath.startsWith(`${oldPath}/`)) {
      throw new AppError(400, 'Cannot move a folder into its own subtree');
    }
  }

  // Subtree: every row whose path sits under the folder's (rooted order).
  const subtree = await prisma.crossModelProject.findMany({
    where: { path: { startsWith: `${oldPath}/` } },
    orderBy: { depth: 'asc' },
    select: { id: true, path: true, depth: true },
  });
  const subtreeHeight = subtree.length
    ? Math.max(...subtree.map((d) => d.depth)) - folder.depth
    : 0;

  const newDepth = newParent ? newParent.depth + 1 : 0;
  if (newDepth + subtreeHeight > MAX_FOLDER_DEPTH) {
    throw new AppError(400, `Move would exceed the folder depth limit (max depth ${MAX_FOLDER_DEPTH})`);
  }

  const newPath = newParent ? `${newParent.path || `/${newParent.id}`}/${folder.id}` : `/${folder.id}`;
  const delta = newDepth - folder.depth;

  await prisma.$transaction(async (tx) => {
    // Depth shift FIRST — matched on the OLD path prefix. Swapping paths
    // before this would make the updateMany match zero rows, leaving
    // descendant depths stale (corrupts subtreeHeight / depth-limit math).
    if (delta !== 0 && subtree.length) {
      await tx.crossModelProject.updateMany({
        where: { path: { startsWith: `${oldPath}/` } },
        data: { depth: { increment: delta } },
      });
    }
    for (const d of subtree) {
      await tx.crossModelProject.update({
        where: { id: d.id },
        data: { path: newPath + d.path.slice(oldPath.length) },
      });
    }
    await tx.crossModelProject.update({
      where: { id: folderId },
      data: { parentId: newParent?.id ?? null, depth: newDepth, path: newPath },
    });
  });

  await audit(userId, 'project.move', {
    folderId, newParentId: newParent?.id ?? null, subtreeSize: subtree.length + 1, depthDelta: delta,
  });
  return prisma.crossModelProject.findUnique({ where: { id: folderId } });
}

/**
 * Folder tree for the sidebar: the user's owned + shared folders (flat lists,
 * each with parentId/depth/path — the client assembles the tree). This is the
 * P2 list implementation behind GET /projects (additive fields only).
 *
 * Archive (owner 2026-09-08): the DEFAULT tree excludes archived folders AND
 * their descendants (folder archival stamps only the root of the archived
 * subtree — descendants ride along via the materialized path, so restore is
 * one stamp-clear). `archived: true` flips to the Archived browse view:
 * ONLY the individually-stamped folders (their descendants stay hidden — they
 * are restored WITH their archived ancestor).
 */
export async function getFolderTree(opts: { userId: string; archived?: boolean }) {
  const { userId } = opts;

  // Owned projects
  const ownedProjects = await prisma.crossModelProject.findMany({
    where: { userId },
    include: {
      // Archive: sidebar chat counts must match the visible (non-archived) chats.
      _count: { select: { chats: { where: { archivedAt: null } }, documents: true } },
      members: {
        include: { user: { select: { id: true, name: true, email: true } } },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Shared projects (where user is a member)
  const memberRows = await prisma.projectMember.findMany({
    where: { userId },
    include: {
      project: {
        include: {
          user: { select: { id: true, name: true, email: true } },
          _count: { select: { chats: { where: { archivedAt: null } }, documents: true } },
        },
      },
    },
  });

  const sharedProjects = memberRows.map((m: any) => ({
    ...m.project,
    memberRole: m.role,
    ownerName: m.project.user.name ?? m.project.user.email,
  }));

  // Archive visibility: a folder is hidden when it (or any path ancestor) is
  // archived. Both legs are already fully fetched, so the subtree check is a
  // cheap in-memory path-prefix pass — no extra queries.
  const archivedPaths = [...ownedProjects, ...sharedProjects]
    .filter((p: any) => p.archivedAt)
    .map((p: any) => p.path || `/${p.id}`);
  const underArchived = (p: any) => {
    const path = p.path || `/${p.id}`;
    return archivedPaths.some((a) => path === a || path.startsWith(`${a}/`));
  };
  const visible = opts.archived
    ? (p: any) => !!p.archivedAt // Archived view: individually-stamped rows only
    : (p: any) => !underArchived(p); // default: hide archived subtrees entirely

  return {
    owned: ownedProjects.filter(visible).map((p: any) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      systemPrompt: p.systemPrompt,
      emoji: p.emoji,
      color: p.color,
      isPublic: p.isPublic,
      // Per-project supervisor lane toggle (2026-09-13) — the UIs bind this.
      projectSupervisorEnabled: p.projectSupervisorEnabled ?? false,
      // User Space (P3 §5): the marker the frontend filters on — the hidden
      // user-space project never renders in the tree/pickers (its chats show
      // as the ungrouped section).
      isUserSpace: p.isUserSpace ?? false,
      // Framework surface (ticket 9471d338): the marker the sidebar and the
      // Management tab filter on — the platform's own project leaves the
      // user-facing tree and renders under Management → Framework instead.
      isFrameworkProject: isFrameworkProject(p),
      // Fleet-supervision scope (ticket dca83b85): `supervised:false` removes
      // the project from the Fleet's automated view. The framework project is
      // PERMANENTLY supervised, so it always reads true here.
      supervised: isFrameworkProject(p) ? true : (p.supervised ?? true),
      // One-Digby: the workspace fields tell the UI a project is a coding
      // project, so "new chat" there can create a coding session.
      repoUrl: p.repoUrl,
      repoProvider: p.repoProvider,
      workspaceAt: p.workspaceAt,
      // P2 folder tree
      parentId: p.parentId,
      depth: p.depth,
      path: p.path,
      chatCount: p._count.chats,
      documentCount: p._count.documents,
      memberCount: p.members.length,
      archivedAt: p.archivedAt ?? null, // archive state — the Archived view renders it
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    shared: sharedProjects.filter(visible).map((p: any) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      emoji: p.emoji,
      color: p.color,
      // Per-project supervisor lane toggle (2026-09-13).
      projectSupervisorEnabled: p.projectSupervisorEnabled ?? false,
      // Framework surface (ticket 9471d338) — same marker as owned rows.
      isFrameworkProject: isFrameworkProject(p),
      // Fleet-supervision scope (ticket dca83b85) — same contract as owned rows.
      supervised: isFrameworkProject(p) ? true : (p.supervised ?? true),
      repoUrl: p.repoUrl,
      repoProvider: p.repoProvider,
      workspaceAt: p.workspaceAt,
      // P2 folder tree
      parentId: p.parentId,
      depth: p.depth,
      path: p.path,
      chatCount: p._count.chats,
      documentCount: p._count.documents,
      ownerName: p.ownerName,
      memberRole: p.memberRole,
      archivedAt: p.archivedAt ?? null, // archive state — the Archived view renders it
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
  };
}

/**
 * Breadcrumb chain for a folder: root→leaf (from the materialized path, one
 * batched query). Read access required (owner or any member). Not flag-gated —
 * breadcrumbs describe the tree structure, which is always maintained.
 */
export async function getBreadcrumbs(opts: { userId: string; folderId: string }) {
  const { userId, folderId } = opts;
  const access = await getProjectAccess(folderId, userId);
  if (!access) throw new AppError(404, 'Project not found or no access');

  const leaf = access.project;
  const ids = (leaf.path || '').split('/').filter(Boolean);
  let chain: any[] = [leaf];
  if (ids.length > 1 && ids[ids.length - 1] === leaf.id) {
    const rows = await prisma.crossModelProject.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, emoji: true, color: true, parentId: true, depth: true, path: true },
    });
    const byId = new Map(rows.map((r: any) => [r.id, r]));
    chain = ids.map((id: string) => byId.get(id)).filter(Boolean);
    if (!chain.length) chain = [leaf];
  } else {
    chain = [{
      id: leaf.id, name: leaf.name, emoji: leaf.emoji, color: leaf.color,
      parentId: leaf.parentId, depth: leaf.depth, path: leaf.path,
    }];
  }
  return chain.map((f: any) => ({
    id: f.id, name: f.name, emoji: f.emoji, color: f.color,
    parentId: f.parentId ?? null, depth: f.depth ?? 0, path: f.path || `/${f.id}`,
  }));
}

/**
 * Read a project back (name/description/systemPrompt/emoji/color/isPublic/
 * supervised/crossProjectMemory + hierarchy + caller role). Any project member
 * incl. viewers — read access mirrors getChatStatus. Exists so agents can VERIFY
 * update_project writes (feedback 831903a9: write-without-read hid silent
 * failures like truncations or wrong-project writes).
 */
export async function getProject(opts: { userId: string; projectId: string }) {
  const { userId } = opts;
  let projectId = String(opts.projectId ?? '');
  let access = await getProjectAccess(projectId, userId);
  if (!access) {
    // Ticket 1ab445cc (2026-10-27, tool-failure-streak family): get_spend scope
    // 'project' 404'd 3× on the fleet's 8-char idiom ('2d554c9e') for REAL,
    // visible projects — this read was the lone exact-id outlier left: every
    // other id family (goal / todo / schedule / hook / chat) already resolves
    // the idiom (fb3ea311, 225b878f4, 4057952b). Heal ONLY on the exact-id
    // miss, with the SAME resolver + guards as goals.service's tool seam
    // (resolveProjectIdForTool): 8–35-char prefixes need exactly ONE
    // caller-visible candidate (visibility via the same getProjectAccess gate —
    // nothing new is disclosed); a full-shape miss may heal a ≤2-char typo or
    // an invented suffix (T5-3 doctrine — garbage never silently resolves).
    // An exact hit never takes the extra query. Kill switch
    // PROJECT_ID_SUFFIX_HEAL_DISABLED=1 restores exact-id-only. Fail-open: any
    // resolution error keeps the exact-id 404.
    try {
      const goals = await import('./goals.service');
      if (!goals.projectIdHealDisabled()) {
        const resolved = await goals.resolveProjectIdForTool(projectId, userId);
        if (resolved?.id && resolved.id !== projectId) {
          access = await getProjectAccess(resolved.id, userId);
          if (access) projectId = resolved.id;
        }
      }
    } catch { /* keep the exact-id 404 */ }
  }
  if (!access) throw new AppError(404, 'Project not found or no access');
  const settings = await getProjectSettings(projectId);
  const p = access.project;
  // Trailing-24h spend across every chat filed in the project (WI-O #7,
  // 2026-09-25) — the same loop_metrics ledger get_spend/spend caps read,
  // beside the cap it is measured against. Best-effort: null = unknown.
  let projectSpend24h: { usd: number; runs: number } | null = null;
  try {
    const { trailingProjectSpend24h } = await import('../coding/spend-cap.service');
    projectSpend24h = await trailingProjectSpend24h(p.id);
  } catch { projectSpend24h = null; }
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? null,
    systemPrompt: p.systemPrompt ?? null,
    emoji: p.emoji ?? null,
    color: p.color ?? null,
    isPublic: p.isPublic,
    supervised: p.supervised,
    projectSupervisorEnabled: p.projectSupervisorEnabled ?? false,
    autoArchiveIdleDays: p.autoArchiveIdleDays ?? null, // idle-chat auto-archive window (ticket bb86cee8); null = off
    parentId: p.parentId ?? null,
    depth: p.depth ?? 0,
    crossProjectMemory: settings.crossProjectMemory,
    codingModel: settings.codingModel ?? null,
    spendCapUsdPerDay: settings.spendCapUsdPerDay ?? null,
    projectSpend24h, // { usd, runs } over the trailing 24h (loop_metrics run_spend), or null when the read failed
    selfMerge: (settings as any).selfMerge ?? null, // machine self-merge policy (T4c UI, 2026-09-24): 'on' | 'off' | null = platform default
    role: access.role,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * Update a project. Owner or editor/admin member (viewer blocked) — mirrors
 * projects.controller.updateProject, including the crossProjectMemory Store row.
 */
export async function updateProject(opts: {
  userId: string; projectId: string;
  name?: string; description?: string; systemPrompt?: string; emoji?: string; color?: string;
  isPublic?: boolean; supervised?: boolean; crossProjectMemory?: boolean;
  /** Per-project supervisor lane (2026-09-13): true scaffolds the project's
   *  dedicated supervisor (chat + project-scope hook + hourly sweep); false
   *  PAUSES them (hooks/schedules disabled — never deleted). */
  projectSupervisorEnabled?: boolean;
  /** Project-level coding agent (owner ask 2026-09-04): built-in id or
   *  '<label>:<modelId>' endpoint spec; '' clears the override. */
  codingModel?: string;
  /** Who set `codingModel` (seats govern sessions, 2026-09-28): 'user' (REST /
   *  side panel / a tool call on a human turn) or 'machine' (a lane or
   *  supervisor on a machine turn — never shadows the admin seat). Omitted =
   *  'user' (the REST default). Ignored when codingModel is not given. */
  codingModelSource?: 'user' | 'machine';
  /** Spend cap (P7 N7/S1a): max trailing-24h machine-run spend (USD) for
   *  chats in this project; null (or a non-positive number) clears it. */
  spendCapUsdPerDay?: number | null;
  /** Machine self-merge policy (owner directive 2026-09-09): 'on' lets the
   *  merge_pull_request gate engine merge this project's PRs autonomously;
   *  'off' keeps owner-click merges; null clears back to inference/ask. */
  selfMerge?: 'on' | 'off' | null;
  /** Auto-archive idle chats (ticket bb86cee8): null clears the setting
   *  (feature off); an integer 1..365 = the idle-chat-archiver cron archives
   *  this folder's chats idle longer than that many days. */
  autoArchiveIdleDays?: number | null;
  /** Gmail auto-ingest (ticket 99145890): true = a gmail_get_attachment run
   *  in this project files the attachment into the KB automatically (deduped
   *  by messageId+filename); false/unset = off (the default). Editor+ (same
   *  gate as every other settings key — a viewer cannot enable it). */
  autoIngestGmailAttachments?: boolean;
}) {
  const { userId, projectId } = opts;
  const access = await getProjectAccess(projectId, userId);
  if (!access || access.role === 'viewer') {
    throw new AppError(404, 'Project not found or insufficient permissions');
  }
  // Framework surface (ticket 9471d338): the platform's own project cannot be
  // RENAMED — its identity is pinned by its repo. Settings/model/supervisor
  // toggles ride (they configure the surface, they never impersonate a user
  // folder; there is deliberately NO framework refusal for them).
  if (opts.name !== undefined && isFrameworkProject(access.project)) {
    throw new AppError(403, frameworkProjectRefusal('rename'));
  }
  // TICKET dca83b85 (owner ruling, requirement 1): the framework project is
  // PERMANENTLY fleet-supervised — no write path may opt it out, and the
  // Management surface renders no off control for it. Refused BEFORE the row
  // update so nothing half-applies; `supervised: true` (or an unchanged value)
  // still passes so a stale client re-sending its whole settings form works.
  if (opts.supervised === false && isFrameworkProject(access.project)) {
    throw new AppError(403, frameworkProjectRefusal('unsupervise'));
  }
  // Defence in depth: even a path that skips this function must never leave the
  // framework row opted out — the identity is repo-derived, so a row that WAS
  // flipped (a legacy row, a direct DB edit) is read back as supervised.
  const supervisedRequested = opts.supervised === undefined
    ? undefined
    : (isFrameworkProject(access.project) ? true : opts.supervised);
  const { name, description, systemPrompt, emoji, color, isPublic, supervised, crossProjectMemory, codingModel, spendCapUsdPerDay, selfMerge, projectSupervisorEnabled, autoArchiveIdleDays, autoIngestGmailAttachments } = { ...opts, supervised: supervisedRequested };
  // Project-supervisor toggle is OWNER-only (hardening 2026-09-14): the lane
  // is scaffolded AS the project's owner (ensureProjectSupervisor(updated.
  // userId) → grantFullAutonomy: start_coding_session with the owner's repo
  // tokens, send_to_instance to the owner's edge instances, schedule_message
  // on the owner's cap) — actions an editor/admin member could not take
  // directly; a member could also pause the owner's running supervisor. Same
  // ROW-owner comparison deleteProject/archiveProject use (`project.userId !==
  // userId`, not the role — ancestor inheritance can grant role 'owner' on a
  // member-created subfolder whose row owner is the member). Checked BEFORE
  // the row update so nothing half-applies. Machine lanes act as the owner's
  // userId, so autonomy is untouched — this is authz on a foreign-identity
  // lever, not a gate on a lane's own work.
  if (projectSupervisorEnabled !== undefined && access.project.userId !== userId) {
    throw new AppError(403, 'Only the project owner can enable or pause the project supervisor (it runs as the owner)');
  }
  // Gmail auto-ingest is OWNER-only (review F3, ticket 99145890): enabling it
  // makes EVERY member's gmail_get_attachment run in this project file that
  // member's mail attachment into a KB all members read — a cross-member
  // data-flow lever, the same class projectSupervisorEnabled is owner-only
  // for. Same ROW-owner comparison (not the role — ancestor inheritance can
  // grant role 'owner' on a member-created subfolder whose row owner is the
  // member). Checked BEFORE anything half-applies.
  if (autoIngestGmailAttachments !== undefined && access.project.userId !== userId) {
    throw new AppError(403, 'Only the project owner can change auto-save Gmail attachments (it affects every member\'s mail)');
  }
  let autoArchive: number | null | undefined;
  if (autoArchiveIdleDays !== undefined) {
    // Validated BEFORE the row update (a bad value must not half-apply the
    // other fields): null clears (feature off); otherwise an integer 1..365.
    if (autoArchiveIdleDays === null) {
      autoArchive = null;
    } else {
      const n = Number(autoArchiveIdleDays);
      if (!Number.isInteger(n) || n < 1 || n > 365) {
        throw new AppError(400, 'autoArchiveIdleDays must be null (feature off) or an integer between 1 and 365 (days).');
      }
      autoArchive = n;
    }
  }
  const updated = await prisma.crossModelProject.update({
    where: { id: projectId },
    data: {
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description?.trim() || null }),
      ...(systemPrompt !== undefined && { systemPrompt: systemPrompt?.trim() || null }),
      ...(emoji !== undefined && { emoji }),
      ...(color !== undefined && { color }),
      ...(isPublic !== undefined && { isPublic }),
      ...(supervised !== undefined && { supervised }),
      ...(projectSupervisorEnabled !== undefined && { projectSupervisorEnabled }),
      ...(autoArchive !== undefined && { autoArchiveIdleDays: autoArchive }),
    },
  });
  // crossProjectMemory + codingModel live in the Store (not the project row).
  let settings = await getProjectSettings(projectId);
  if (crossProjectMemory !== undefined) {
    settings = await setProjectSettings(projectId, { crossProjectMemory: !!crossProjectMemory });
  }
  if (codingModel !== undefined) {
    const pick = String(codingModel).trim();
    if (pick) {
      // Same validity contract as the user pref: a built-in id or a registry
      // spec that currently resolves enabled + [coding]-flagged — a pick the
      // run path would silently fall back from must not persist.
      const { resolveOneCodingPick } = await import('../coding/coding-data.service');
      if (!(await resolveOneCodingPick(pick, userId))) {
        throw new AppError(400, `"${pick}" is not a built-in coding model or an enabled, [coding]-flagged "<label>:<modelId>" endpoint model.`);
      }
    }
    // Provenance (seats govern sessions, 2026-09-28): a MACHINE-written override
    // is recorded as such and never shadows the admin's coding_default seat.
    const codingModelSource: 'user' | 'machine' = opts.codingModelSource === 'machine' ? 'machine' : 'user';
    settings = await setProjectSettings(projectId, pick ? { codingModel: pick, codingModelSource } : { codingModel: pick });
  }
  if (spendCapUsdPerDay !== undefined) {
    // Owner opt-in spend cap (P7 N7/S1a): a finite positive number sets it;
    // null / 0 / negative CLEARS it (setProjectSettings drops the key — the
    // default stays "no cap"). Bounded so a typo can't store a nonsense cap.
    const n = spendCapUsdPerDay === null ? NaN : Number(spendCapUsdPerDay);
    if (Number.isFinite(n) && n > 0 && n > 1_000_000) {
      throw new AppError(400, 'spendCapUsdPerDay must be at most 1,000,000 (USD per trailing 24h).');
    }
    settings = await setProjectSettings(projectId, { spendCapUsdPerDay: Number.isFinite(n) && n > 0 ? n : (undefined as any) });
  }
  if (selfMerge !== undefined) {
    // Self-merge policy (2026-09-09): an explicit set is owner-sourced —
    // it outranks inference and (for 'off') survives the inferred-off
    // asymmetry in resolveSelfMergePolicy. null clears back to inference/ask.
    if (selfMerge !== null && selfMerge !== 'on' && selfMerge !== 'off') {
      throw new AppError(400, 'selfMerge must be "on", "off", or null (clear).');
    }
    settings = await setProjectSettings(projectId, {
      selfMerge: (selfMerge ?? undefined) as any,
      selfMergeSource: (selfMerge ? 'owner' : undefined) as any,
      selfMergeWhy: (selfMerge ? 'set via update_project' : undefined) as any,
    });
  }
  if (autoIngestGmailAttachments !== undefined) {
    // Gmail auto-ingest (ticket 99145890): explicit boolean, default-off.
    settings = await setProjectSettings(projectId, { autoIngestGmailAttachments: !!autoIngestGmailAttachments } as any);
  }
  // Per-project supervisor lane (2026-09-13): the toggle's side effects ride
  // a fire-and-forget dynamic import — scaffold on enable (or a RENAME while
  // enabled, so the '<name> Supervisor' title/prompt re-interpolate), pause
  // on disable. The lane is owned by the PROJECT's owner (updated.userId) —
  // the toggle itself is owner-only since 2026-09-14 (guard above); a member
  // RENAME on an enabled project still re-fires the idempotent heal as the
  // owner (no new grant). NEVER blocks or fails the update response (the
  // service itself also never throws).
  if (updated.projectSupervisorEnabled === true &&
      (projectSupervisorEnabled === true || (name !== undefined && name.trim() !== access.project.name))) {
    void import('./project-supervisor.service')
      .then((m) => m.ensureProjectSupervisor(updated.userId, projectId))
      .catch((err: any) => logger.warn(`platform: project-supervisor ensure after update failed (non-fatal): ${err?.message}`));
  } else if (projectSupervisorEnabled === false) {
    void import('./project-supervisor.service')
      .then((m) => m.pauseProjectSupervisor(updated.userId, projectId))
      .catch((err: any) => logger.warn(`platform: project-supervisor pause after update failed (non-fatal): ${err?.message}`));
  }
  await audit(userId, 'project.update', { projectId, fields: Object.keys(opts).filter((k) => (opts as any)[k] !== undefined && k !== 'userId' && k !== 'projectId') });
  // Owner 2026-10-27 (stale-rename sweep, review round 2 defect 2): a folder
  // RENAME must reach every other open sidebar — the chat-row delta feed can
  // never see folder rows. Only a NAME change is a list mutation the sidebar
  // renders (emoji/color/description/settings live on the settings page,
  // which reloads its own state). Best-effort, never throws into the update.
  if (name !== undefined && name.trim() !== access.project.name) {
    await publishProjectNotice(projectId, { kind: 'project.renamed', projectId });
  }
  return { ...updated, crossProjectMemory: settings.crossProjectMemory, codingModel: settings.codingModel ?? null, spendCapUsdPerDay: settings.spendCapUsdPerDay ?? null, selfMerge: (settings as any).selfMerge ?? null };
}

/**
 * Owner 2026-10-27 (stale-list sweep, review round 2 defect 2): notify every
 * user who can SEE a folder that its row mutated (rename/archive/restore/
 * delete) — the row owner + every ProjectMember. The chat-row delta feed is
 * chat-scoped and can never report folder rows, so a folder renamed/archived
 * in one tab kept its stale name/count in every other tab until a manual
 * reload. Notice is hint-only (kind + projectId); the client answers with ONE
 * projectsApi.list() pull, so authorization and visibility stay in that path.
 * Best-effort fire-and-forget, like publishChatListEvent.
 */
async function publishProjectNotice(projectId: string, event: { kind: 'project.renamed' | 'project.archived' | 'project.restored' | 'project.deleted'; projectId: string }): Promise<void> {
  try {
    const owner = await prisma.crossModelProject.findUnique({ where: { id: projectId }, select: { userId: true } });
    const memberRows = await prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } });
    const targets = new Set<string>([...(owner ? [owner.userId] : []), ...memberRows.map((m) => m.userId)]);
    for (const target of targets) publishChatListEvent(target, event);
  } catch { /* best-effort — never fails the mutation it observes */ }
}

/**
 * Delete a project. OWNER-only (members — even admins — cannot delete).
 * Coding chats die with their project (runtime cleanup first); plain chats are
 * SetNull'd by the FK. Mirrors projects.controller.deleteProject.
 *
 * P2 folder tree: children are relocated BEFORE the delete (one transaction,
 * platform/folder-tree-ops.ts) — each direct child becomes a truthful root
 * (parentId null, depth 0, path '/'+id) with its descendants' depth/path
 * rewritten to match, so the parentId FK's SetNull never fires on rows we
 * care about (the old post-delete fixup ran after the SetNull and was
 * best-effort). With `reparentTo`, the children move under that folder
 * instead (normal move semantics: cycle + depth-cap checks).
 */
export async function deleteProject(opts: { userId: string; projectId: string; reparentTo?: string | null }) {
  const { userId, projectId } = opts;
  const project = await prisma.crossModelProject.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) {
    throw new AppError(404, 'Project not found or not owner');
  }
  // Framework surface (ticket 9471d338): the platform's own project is a
  // system row — deleting it would cascade its lanes, goals and worktrees.
  if (isFrameworkProject(project)) {
    throw new AppError(403, frameworkProjectRefusal('delete'));
  }

  const projectPath = project.path || `/${project.id}`;

  // Resolve the children's new root BEFORE the delete (reparentTo, if given).
  let reparent: any = null;
  if (opts.reparentTo) {
    reparent = await prisma.crossModelProject.findUnique({ where: { id: opts.reparentTo } });
    if (!reparent || reparent.userId !== userId) {
      throw new AppError(404, 'reparentTo folder not found or not owner');
    }
    if (isFrameworkProject(reparent)) {
      throw new AppError(403, frameworkProjectRefusal('move-into'));
    }
    const reparentPath = reparent.path || `/${reparent.id}`;
    if (reparent.id === projectId || reparentPath.startsWith(`${projectPath}/`)) {
      throw new AppError(400, 'Cannot reparent children into the folder being deleted or its subtree');
    }
  }

  // Coding chats DIE with their project (their worktree/branch/memory are
  // project-keyed) — clean their runtime state and delete them explicitly.
  const codingStates = await (prisma as any).chatCodingState
    .findMany({ where: { projectId }, select: { id: true } })
    .catch(() => [] as Array<{ id: string }>);
  if (codingStates.length) {
    try {
      const { stopSessionContainer, removeSandboxHome } = await import('../coding/container.service');
      const { removeWorktree, removeSessionEnv } = await import('../coding/workspace.service');
      const { clearSessionMemory } = await import('../coding/coding-retrieval.service');
      const { deleteWorktreeSnapshot } = await import('../coding/worktree-snapshot.service');
      for (const st of codingStates) {
        await stopSessionContainer(st.id).catch(() => {});
        await removeSandboxHome(st.id).catch(() => {}); // durable HOME (e267b760) too
        await removeWorktree(projectId, st.id).catch(() => {});
        await removeSessionEnv(st.id).catch(() => {}); // env-seed sidecar too
        await clearSessionMemory(st.id).catch(() => {});
        // Ticket 1c767622: the chat row dies — its shared snapshot must too
        // (worktree removal alone doesn't: a REAPED session keeps its snapshot
        // on purpose, so the delete lives HERE, at true session deletion).
        await deleteWorktreeSnapshot(st.id).catch(() => {});
      }
    } catch { /* best-effort */ }
    await (prisma as any).chatCodingState.deleteMany({ where: { projectId } }).catch(() => {});
    // P5-B: coding chats are the chats that CARRIED a satellite (mode='code'
    // is gone) — delete exactly those chat rows.
    const chatRowsDeleted = await prisma.crossModelChat
      .deleteMany({ where: { id: { in: codingStates.map((s: { id: string }) => s.id) } } })
      .then(() => true)
      .catch((err: any) => {
        logger.warn(`deleteProject cascade: chat-row deleteMany failed for project ${projectId}: ${err.message}`);
        return false;
      });
    // Per-chat attribution (feedback 138b0347): each coding chat dying in this
    // cascade gets its own audit row — "where did chat X go?" must be
    // answerable without spelunking the umbrella project.delete row. Only on
    // a CONFIRMED delete (reviewer L1): a falsely-claimed auto_delete row is
    // worse than none for exactly the forensics this trail exists for.
    if (chatRowsDeleted) {
      for (const st of codingStates) {
        await audit(userId, 'chat.auto_delete', { chatId: st.id, projectId, reason: 'project delete cascade' });
      }
      // Privacy (fs-durable-memory re-review, 2026-10-23): the dead chats'
      // FK-less rows go with them, as in crossmodel.service deleteChat — the
      // context store's chat-keyed namespaces ([chatId,'thread'], and a
      // stray-satellite supervisor's cold archive [chatId,'supervisor-archive'])
      // and the chat-scope memory (the supervisor ledger's mirror). Only on a
      // CONFIRMED chat delete; best-effort, never blocking.
      const deadChatIds = codingStates.map((s: { id: string }) => s.id);
      try {
        const { storeDeleteChatScoped } = await import('../memory/context-store');
        await storeDeleteChatScoped(deadChatIds);
      } catch (err: any) {
        logger.warn(`deleteProject cascade: chat-keyed store cleanup failed for project ${projectId}: ${err?.message ?? err}`);
      }
      try {
        const { memClear } = await import('../memory/unified-memory.service');
        for (const id of deadChatIds) await memClear({ type: 'chat', id }).catch(() => {});
      } catch { /* best-effort */ }
    }
  }

  // Unified memory: drop the project's scope rows (code index etc.) + its
  // code-index sync state. Best-effort — never blocks the delete.
  try {
    const { memClear } = await import('../memory/unified-memory.service');
    const { storePut, storeDelete } = await import('../memory/context-store');
    await memClear({ type: 'project', id: projectId }).catch(() => {});
    await storePut([projectId, 'code-index'], 'state', { files: {} } as any).catch(() => {});
    // + the small freshness record search_code_semantic reads (walk v2).
    await storeDelete([projectId, 'code-index'], 'meta').catch(() => {});
  } catch { /* best-effort */ }

  // Children are relocated BEFORE the delete, in the SAME transaction: each
  // direct child becomes a truthful root (or moves under reparentTo) with its
  // subtree's depth/path rewritten — the parentId FK SetNull then has nothing
  // left to fire on (every former child already points at its real parent).
  const childCount = await prisma.$transaction(async (tx) => {
    const n = await relocateFolderChildren(tx, { folder: { id: projectId, path: projectPath }, reparent });
    // Cascade deletes members, documents, chunks via FK constraints.
    await tx.crossModelProject.delete({ where: { id: projectId } });
    return n;
  });

  await audit(userId, 'project.delete', {
    projectId, name: project.name,
    childrenPromoted: reparent ? 0 : childCount,
    ...(reparent ? { reparentTo: reparent.id, childrenMoved: childCount } : {}),
  });
  // Owner 2026-10-27 (stale-list sweep, defect 2): the folder row is GONE —
  // every other open sidebar re-pulls the folder list and drops it. Published
  // AFTER the audit so the row is truly gone server-side when clients pull.
  await publishProjectNotice(projectId, { kind: 'project.deleted', projectId });
  return { success: true };
}

/**
 * Archive/unarchive a project (owner 2026-09-08: archive is the primary
 * de-clutter path — delete stays the permanent one). OWNER-only, matching
 * deleteProject. Stamps ONLY this row: the folder's chats and descendant
 * folders ride along implicitly (default lists hide the whole subtree via the
 * materialized path — see archive-scope.ts), so restore is one stamp-clear and
 * loses nothing. The hidden user-space project is infrastructure, never
 * archivable (its chats ARE the ungrouped section).
 *
 * Guards — unlike delete (which force-stops containers and cascades), archive
 * must stay lossless, so it REFUSES with a clear 409 when the subtree has:
 *   - RUNNING coding sessions (stop them first), or
 *   - ENABLED schedules (a cadence firing runs into a hidden folder is the
 *     surprise this blocks; pause or cancel them first).
 */
export async function archiveProject(opts: { userId: string; projectId: string; archived?: boolean }) {
  const { userId, projectId } = opts;
  const archived = opts.archived !== false;
  const project = await prisma.crossModelProject.findUnique({ where: { id: projectId } });
  if (!project || project.userId !== userId) {
    throw new AppError(404, 'Project not found or not owner');
  }
  if (project.isUserSpace) throw new AppError(400, 'The personal Workspace folder cannot be archived');
  // Framework surface (ticket 9471d338): never archivable — its lanes and
  // schedules ARE the platform's own heartbeat (the same reason the hidden
  // user-space folder is refused above).
  if (isFrameworkProject(project)) {
    throw new AppError(403, frameworkProjectRefusal('archive'));
  }

  if (archived) {
    // The guard covers the WHOLE subtree — descendants are hidden with the root.
    const projectPath = project.path || `/${project.id}`;
    const descendants = await prisma.crossModelProject.findMany({
      where: { path: { startsWith: `${projectPath}/` } },
      select: { id: true },
    });
    const subtreeIds = [projectId, ...descendants.map((d) => d.id)];
    const running = await (prisma as any).chatCodingState.count({
      where: { projectId: { in: subtreeIds }, status: 'running' },
    });
    if (running > 0) {
      throw new AppError(409, `Cannot archive: ${running} coding session(s) in this folder are running — stop them first`);
    }
    const enabledSchedules = await prisma.chatSchedule.count({
      // The project supervisor lane's OWN schedules don't block archiving —
      // the archive pauses the lane below (pause-never-delete), so they are
      // exactly what the pause disables. Every other schedule still 409s.
      where: { enabled: true, chat: { projectId: { in: subtreeIds }, isProjectSupervisor: false } },
    });
    if (enabledSchedules > 0) {
      throw new AppError(409, `Cannot archive: ${enabledSchedules} enabled schedule(s) on chats in this folder — pause or cancel them first`);
    }
  }

  await prisma.crossModelProject.update({
    where: { id: projectId },
    data: { archivedAt: archived ? new Date() : null },
  });
  // Per-project supervisor lane (2026-09-13): archiving PAUSES the lane —
  // hooks + schedules disabled, nothing deleted (a restore re-scaffolds via
  // the watchdog heal while the flag stays on). Fire-and-forget, never fails
  // the archive.
  if (archived && project.projectSupervisorEnabled === true) {
    void import('./project-supervisor.service')
      .then((m) => m.pauseProjectSupervisor(userId, projectId))
      .catch((err: any) => logger.warn(`platform: project-supervisor pause on archive failed (non-fatal): ${err?.message}`));
  }
  await audit(userId, archived ? 'project.archive' : 'project.restore', { projectId, name: project.name });
  // Owner 2026-10-27 (stale-list sweep, defect 2): the folder row left/returned
  // — every other open sidebar re-pulls the folder list.
  await publishProjectNotice(projectId, { kind: archived ? 'project.archived' : 'project.restored', projectId });
  return { id: projectId, archived };
}

// ── Coding sessions ───────────────────────────────────────────────────────────

export type StartedCodingSession = CodingSessionShape & { branch: string; baseBranch: string;
  /** audit 2026-10-08 W2-1: the explicit branch the worktree was asked to continue (when any). */
  startFromBranch?: string;
  /** audit 2026-10-08 W2-1: the prior session whose branch the worktree chained from (the UI "continue my work" path). */
  chainedFromSession?: string;
};

/**
 * Where a coding session for `projectId` should live — the SINGLE resolution
 * shared by startCodingSession (execution) and the start_coding_session
 * staging-time validation in platform-tools, so a staged confirmation can never
 * be accepted for a target execution would reject (feedback 2026-08-16: a card
 * staged with an unresolvable projectId confirmed cleanly, then failed at
 * execution with a bare "Project not found").
 *
 * Resolution order (owner-only — coding sessions execute with the owner's
 * tokens/filesystem, so membership never qualifies):
 *   1. direct   — the project itself is workspace-backed (repoProvider set).
 *   2. ancestor — P2 folder tree: a plain child folder files the session into
 *                 the NEAREST workspace-owning ancestor (projectId rewritten).
 *   3. blank    — a plain (repo-less) owned project with no workspace ancestor
 *                 provisions a per-session blank workspace (net-new builds —
 *                 scrapers, DBs, prototypes — are a first-class use case; the
 *                 legacy 'blank' provider path in provisionWorktree/run-executor
 *                 already implements it). toLegacyProject maps repoProvider
 *                 null → provider 'blank'.
 *   not_found   — no owned project with that id at all.
 *
 * SHARED-PROJECT-DISPATCH (2026-10-20, ticket 22d667e7; platform/shared-
 * project-access.ts): a caller who does not own the project but holds WRITE
 * membership on it (editor / admin, getProjectAccess — the same semantics
 * goal_create / todo_create already admit) resolves through the same three
 * legs, carrying `callerRole` + `runUserId` (the PROJECT OWNER — the session
 * runs, spends and is quota-counted as the owner; the member only authorizes
 * the start). A VIEWER never resolves (`reason: 'read_only'`), and every
 * refusal carries the caller's role. Kill switch SPAWN_MEMBER_ACCESS_DISABLED=1
 * restores the owner-only resolver (the refusal still names the role).
 */
export type CodingSessionTarget =
  | {
    ok: true; project: CodingProjectShape; projectId: string; source: 'direct' | 'ancestor' | 'blank';
    /** SHARED-PROJECT-DISPATCH: set only when the caller resolved through MEMBERSHIP (never for the owner). */
    callerRole?: 'admin' | 'editor';
    /** SHARED-PROJECT-DISPATCH: the account the session runs as (the project owner) when it is not the caller. */
    runUserId?: string;
  }
  | { ok: false; reason: 'not_found' | 'read_only'; callerRole?: ProjectRole | null; memberAccessDisabled?: boolean };

/**
 * Canonicalize what an agent passed as a project reference (owner report
 * 2026-09-25: "agents were having trouble initializing a workspace"). Over
 * 14 days every failed start_coding_session target was one of: the project's
 * NAME ("crossmodel" ×6), the 'chat' sentinel (×2 — account-tools' "this
 * chat's project" marker leaking into a projectId arg), a CHAT id where a
 * project id was expected, or an invented uuid. Accepts, in order: an exact
 * project id; a chat id the caller owns (→ that chat's project); a unique
 * case-insensitive NAME among the caller's visible projects; a unique ≥8-char
 * id prefix. Returns null when nothing unambiguous matches (the caller keeps
 * its not_found + did-you-mean path). Never widens access: every branch is
 * scoped to projects the caller can already see.
 */
export async function canonicalizeProjectReference(userId: string, raw: string): Promise<{ id: string; via: 'id' | 'chat' | 'name' | 'prefix' } | null> {
  const ref = String(raw || '').trim();
  if (!ref || ref === 'chat' || ref === 'this' || ref === 'current') return null;
  const exact = await prisma.crossModelProject.findUnique({ where: { id: ref }, select: { id: true } }).catch(() => null);
  if (exact) return { id: exact.id, via: 'id' };
  // A chat id in place of a project id — the chat's project (owner-scoped).
  if (/^[0-9a-f-]{32,36}$/i.test(ref)) {
    const chat = await prisma.crossModelChat.findFirst({ where: { id: ref, userId }, select: { projectId: true } }).catch(() => null);
    if (chat?.projectId) return { id: chat.projectId, via: 'chat' };
  }
  const memberProjectIds = (
    await prisma.projectMember.findMany({ where: { userId }, select: { projectId: true } }).catch(() => [] as Array<{ projectId: string }>)
  ).map((m) => m.projectId);
  const scope = [{ userId }, ...(memberProjectIds.length > 0 ? [{ id: { in: memberProjectIds } }] : [])];
  // Exact NAME (case-insensitive) among visible, non-archived projects — unique or nothing.
  const byName = await prisma.crossModelProject.findMany({
    where: { name: { equals: ref, mode: 'insensitive' }, archivedAt: null, OR: scope },
    select: { id: true }, take: 2,
  }).catch(() => [] as Array<{ id: string }>);
  if (byName.length === 1) return { id: byName[0].id, via: 'name' };
  // Unique id prefix (≥ 8 chars) among visible projects.
  const prefix = ref.toLowerCase();
  if (/^[0-9a-f-]{8,35}$/.test(prefix)) {
    const byPrefix = await prisma.crossModelProject.findMany({ where: { id: { startsWith: prefix }, OR: scope }, select: { id: true }, take: 2 }).catch(() => [] as Array<{ id: string }>);
    if (byPrefix.length === 1) return { id: byPrefix[0].id, via: 'prefix' };
  }
  return null;
}

export async function resolveCodingSessionTarget(userId: string, requestedProjectId: string): Promise<CodingSessionTarget> {
  // Name / chat-id / prefix references resolve to the real id first (2026-09-25).
  const canon = await canonicalizeProjectReference(userId, requestedProjectId).catch(() => null);
  const projectId = canon?.id ?? requestedProjectId;
  const direct = await getCodingProjectForUser(projectId, userId);
  if (direct) return { ok: true, project: direct, projectId, source: 'direct' };
  const leaf = await prisma.crossModelProject.findFirst({
    where: { id: projectId, userId },
    select: {
      id: true, userId: true, name: true, repoUrl: true, repoProvider: true,
      defaultBranch: true, githubLabel: true, createdAt: true, updatedAt: true,
    },
  });
  if (!leaf) return resolveMemberCodingSessionTarget(userId, projectId);
  if (foldersInheritanceOn()) {
    const wsFolder = await getNearestWorkspaceFolder(projectId);
    if (wsFolder) return { ok: true, project: toLegacyProject(wsFolder), projectId: wsFolder.id, source: 'ancestor' };
  }
  return { ok: true, project: toLegacyProject(leaf), projectId, source: 'blank' };
}

/**
 * SHARED-PROJECT-DISPATCH (2026-10-20): the MEMBERSHIP leg of
 * resolveCodingSessionTarget — reached only when the caller owns neither the
 * coding project nor the leaf. A write member (editor / admin) resolves
 * through the same direct → ancestor → blank order with the PROJECT OWNER as
 * the run identity; a viewer is 'read_only'; no role is 'not_found'. The
 * ancestor leg needs write access on the workspace folder too (its owner is
 * the run identity), else the session stays on the leaf (blank). Never throws:
 * a lookup error is 'not_found' (today's refusal), never a widened grant.
 */
async function resolveMemberCodingSessionTarget(userId: string, projectId: string): Promise<CodingSessionTarget> {
  let access: { project: any; role: ProjectRole } | null = null;
  try {
    access = await getProjectAccess(projectId, userId);
  } catch (err: any) {
    logger.warn(`platform: member spawn access lookup failed for ${projectId.slice(0, 8)} (${err?.message ?? err}) — refusing as not found`);
    return { ok: false, reason: 'not_found', callerRole: null };
  }
  if (!access) return { ok: false, reason: 'not_found', callerRole: null };
  const role = access.role;
  if (role === 'viewer') return { ok: false, reason: 'read_only', callerRole: 'viewer' };
  const disabled = spawnMemberAccessDisabled();
  // An ancestor-derived 'owner' (the caller owns a parent folder) is still not
  // the leaf's owner — it runs as the leaf's owner like any member.
  const callerRole: 'admin' | 'editor' = role === 'editor' ? 'editor' : 'admin';
  if (disabled) return { ok: false, reason: 'not_found', callerRole: role, memberAccessDisabled: true };
  const p = access.project;
  if (!p || !p.userId) return { ok: false, reason: 'not_found', callerRole: role };
  if (p.repoProvider) {
    return { ok: true, project: toLegacyProject(p), projectId: p.id, source: 'direct', callerRole, runUserId: String(p.userId) };
  }
  if (foldersInheritanceOn()) {
    try {
      const wsFolder = await getNearestWorkspaceFolder(projectId);
      if (wsFolder && (wsFolder as any).userId) {
        const wsAccess = (wsFolder as any).userId === userId
          ? { role: 'owner' as ProjectRole }
          : await getProjectAccess(wsFolder.id, userId).catch(() => null);
        if (wsAccess && isWriterRole(wsAccess.role)) {
          // The caller owns the workspace folder itself: the plain owner path.
          if ((wsFolder as any).userId === userId) return { ok: true, project: toLegacyProject(wsFolder), projectId: wsFolder.id, source: 'ancestor' };
          return { ok: true, project: toLegacyProject(wsFolder), projectId: wsFolder.id, source: 'ancestor', callerRole, runUserId: String((wsFolder as any).userId) };
        }
      }
    } catch { /* no workspace ancestor reachable — the leaf's blank workspace below */ }
  }
  return { ok: true, project: toLegacyProject(p), projectId: p.id, source: 'blank', callerRole, runUserId: String(p.userId) };
}

/**
 * Prefix lookup over the caller's VISIBLE projects (own + member) — backs the
 * self-correcting start_coding_session staging/execution errors. Same failure
 * mode as suggestChatsByIdPrefix (agents mis-transcribe a uuid: shared time
 * prefix, garbled suffix — feedback 2026-08-16 staged a card with exactly
 * that), so the match window RELAXES from 12 chars down to 4 until something
 * visible matches. Never returns projects the caller could not already see.
 */
export async function suggestProjectsByIdPrefix(opts: { userId: string; projectIdPrefix: string; limit?: number }) {
  const { userId } = opts;
  const raw = String(opts.projectIdPrefix || '').toLowerCase().replace(/[^0-9a-f-]/g, '');
  if (raw.length < 4) return [];
  const limit = Math.min(5, Math.max(1, opts.limit ?? 3));
  const memberProjectIds = (
    await prisma.projectMember.findMany({ where: { userId }, select: { projectId: true } })
  ).map((m) => m.projectId);
  const scope = [{ userId }, ...(memberProjectIds.length > 0 ? [{ id: { in: memberProjectIds } }] : [])];
  for (const n of [12, 10, 8, 6, 4]) {
    if (raw.length < n) continue;
    const rows = await prisma.crossModelProject.findMany({
      where: { id: { startsWith: raw.slice(0, n) }, OR: scope },
      select: { id: true, name: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
    if (rows.length > 0) return rows;
  }
  return [];
}

/**
 * Start a coding session in a project — THE service path behind
 * coding.controller.createSession (re-pointed to here in P1) and the
 * start_coding_session platform tool. Owner-only coding project; worktree
 * provisioning continues in the background (the session polls status).
 */
export async function startCodingSession(opts: {
  userId: string; projectId: string; title?: string; permissionMode?: string; prompt?: string;
  /** Ticket b6acc1e3: explicit coding-model pick from the start_coding_session
   *  tool's `model` param. Validated with the SAME one-candidate resolver the
   *  pref/project picks use (resolveOneCodingPick — built-ins + legacy aliases
   *  + enabled [coding] '<label>:<modelId>' Edge specs); an unresolvable value
   *  is a 400, never a silent fall-back. When present it WINS over the default
   *  stamp resolution (project pick → user pref → seat) and is stamped with
   *  modelSource 'spawn-param' so the run-time project override honors it. */
  model?: string;
  /** Fleet origin of the first prompt's AUTHOR (ticket 2e9e5264): machine
   *  spawners (start_coding_session tool, ticket-dispatch batch) pass
   *  { kind: 'agent' } so the session's FIRST run is stamped agent/machine,
   *  not the sendChatMessage 'user' default. Omitted by the REST/UI routes —
   *  a human-typed first prompt stays origin 'user'. */
  promptOrigin?: { kind: 'user' | 'agent' | 'webhook'; sourceChatId?: string };
  /** Cohesive chat live fixes (2026-09-28, platform/human-spawn.ts): the spawn
   *  is the user's OWN ask — a human turn of a non-supervisor chat. The child
   *  defaults to permissionMode 'auto' (an explicit `permissionMode` or a
   *  preference the user set THEMSELVES still wins) and its first run is
   *  USER-anchored: origin 'user' + this anchor threaded through the
   *  first-prompt stash, so run-executor never classifies it "unattended
   *  machine-triggered" and the permission gate never auto-denies it.
   *  Omitted = the machine-spawn path byte-for-byte. */
  humanSpawn?: { userTurnAt: Date };
  /** Ticket lanes (2026-10-06, ticket-dispatch fresh lanes): false = start from
   *  the project's base branch with NO prior-session continuity — no branch
   *  chain, no plan or session-memory inheritance. findPriorSession picks the
   *  most recently updated session in the project (any lane), so a dedicated
   *  ticket lane in a busy project would otherwise base its branch on an
   *  unrelated lane's unmerged work. Omitted/true = today's continuity. */
  chainFromPrior?: boolean;
  /** audit 2026-10-08 W2-1 (lanes.md F2): an EXPLICIT branch the caller asked
   *  the new session to continue (start_coding_session `continueBranch` — e.g.
   *  a reviewer continuing its parent's branch). The worktree is cut from it
   *  (falling back to origin/<default branch> when it does not resolve in the
   *  mirror); no plan / session-memory inheritance rides it. Independent of
   *  chainFromPrior (pass chainFromPrior:false with it). */
  startFromBranch?: string;
}): Promise<StartedCodingSession & { permissionSource: string; spawnedByUserId?: string; spawnedByRole?: 'admin' | 'editor' }> {
  const callerUserId = opts.userId;
  const requestedProjectId = String(opts.projectId || '');
  const target = await resolveCodingSessionTarget(callerUserId, requestedProjectId);
  if (!target.ok) {
    // The project id itself does not resolve for this user — name it (never a
    // bare "Project not found") and point at the likely cause: a stale or
    // mis-transcribed id baked into a staged confirmation's args.
    logger.warn(`platform: startCodingSession target resolution failed — user ${callerUserId}, projectId "${requestedProjectId}", role ${target.callerRole ?? 'none'}`, {
      userId: callerUserId,
      projectId: requestedProjectId,
      source: 'platform-start-coding-session',
    });
    // SHARED-PROJECT-DISPATCH: a viewer / a member under the kill switch gets
    // the role-naming refusal (403 — the caller CAN see the project); no role
    // keeps the existence-safe 404 + the stale-args hint, now naming the role.
    if (target.reason === 'read_only' || target.memberAccessDisabled) {
      throw new AppError(403, spawnAccessRefusal({ projectId: requestedProjectId, role: target.callerRole ?? null, memberAccessDisabled: target.memberAccessDisabled }));
    }
    throw new AppError(
      404,
      `${spawnAccessRefusal({ projectId: requestedProjectId, role: target.callerRole ?? null })} If this came from a staged confirmation, its staged arguments may be stale or corrupted — re-list projects and stage a fresh start_coding_session with the exact id.`,
    );
  }
  const project = target.project;
  const projectId = target.projectId;
  // SHARED-PROJECT-DISPATCH: a member-authorized start runs as the PROJECT
  // OWNER — the chat row, preferences, model stamp, first-prompt delivery,
  // spend and quota are the owner's; the caller is recorded as spawnedBy.
  const memberSpawn = !!(target.runUserId && target.runUserId !== callerUserId && target.callerRole);
  const userId = memberSpawn ? String(target.runUserId) : callerUserId;
  const spawnedBy = memberSpawn ? { spawnedByUserId: callerUserId, spawnedByRole: target.callerRole as 'admin' | 'editor' } : null;

  const prefs = await prisma.userPreferences.findUnique({ where: { userId } });
  // Registry-aware model stamping (Digby Edge): a '<label>:<modelId>' pref
  // survives while it resolves enabled+coding-capable. The built-in-only set
  // check here once silently re-stamped registry specs to glm-5.2 — runs then
  // went to api.z.ai keyless and 401'd on Edge (ticket 68b1aba3).
  // Ticket b6acc1e3: an explicit `model` argument (start_coding_session param)
  // WINS over the whole default chain — that is the point of the param (a
  // supervisor routing a spawn around a provider outage, where the project
  // pick / pref / seat may all point at the dead route). Validated with the
  // SAME resolveOneCodingPick the pref/project picks use; an unresolvable
  // value is a hard 400 (never a silent re-stamp to the default — the caller
  // asked for a specific route and must know it is not getting it).
  const explicitModel = opts.model?.trim();
  let model: string;
  let modelSource: string | null = null;
  // Seats govern sessions (2026-09-28): what governed the default stamp (project |
  // preference | seat | stamp) — recorded on the audit row; the stored modelSource
  // stays NULL for a default resolution (the stamp is a RECORD, not the authority).
  let modelGovernor: 'explicit' | 'project' | 'preference' | 'seat' | 'stamp' = 'explicit';
  if (explicitModel) {
    const { resolveOneCodingPick } = await import('../coding/coding-data.service');
    const resolved = await resolveOneCodingPick(explicitModel, userId);
    if (!resolved) {
      throw new AppError(
        400,
        `Cannot start a coding session: model "${explicitModel}" is not a built-in coding model (glm-5.3 | deepseek-flash | kimi-k3) or an enabled, [coding]-flagged "<label>:<modelId>" endpoint model. Nothing was created — re-call with a valid model or omit the param for the default resolution.`,
      );
    }
    model = resolved;
    modelSource = 'spawn-param';
  } else {
    const decision = await resolveStampedCodingModelDetailed(prefs?.codingModel, userId, projectId);
    model = decision.model;
    modelGovernor = decision.source;
  }
  // Permission mode (platform/human-spawn.ts): explicit arg → the user's own
  // DELIBERATE preference → 'auto'. A machine spawn resolves exactly as before
  // (explicit → stored preference → 'auto'); a HUMAN spawn ignores a stored
  // non-auto preference the user never set themselves (the pre-2026-09-17
  // 'ask' default — a stored 'ask' row is indistinguishable from a choice
  // unless the settings write marked it explicit).
  const humanSpawn = !!opts.humanSpawn;
  const prefExplicit = humanSpawn && prefs?.codingPermissionMode && prefs.codingPermissionMode !== 'auto'
    ? await isPermissionModeExplicit(userId, prefs.codingPermissionMode)
    : false;
  const resolvedMode = resolveSpawnPermissionMode({
    explicit: opts.permissionMode, prefMode: prefs?.codingPermissionMode, prefExplicit, humanSpawn,
  });
  const mode = resolvedMode.mode;
  const permissionSource = resolvedMode.source;
  // A human-spawned child's first run is the user's turn: origin 'user' (the
  // parent chat as sourceChatId for lineage) + the parent turn's anchor.
  // SHARED-PROJECT-DISPATCH review fix (2026-10-20): a MEMBER's spawn is never
  // the OWNER's turn — the lane runs on the owner's account, so its first run
  // is stamped origin 'agent' (lineage kept), never a USER turn the owner
  // never typed.
  const promptOrigin: FirstPromptOrigin | undefined = memberSpawn
    ? { kind: 'agent', ...(opts.promptOrigin?.sourceChatId ? { sourceChatId: opts.promptOrigin.sourceChatId } : {}) }
    : humanSpawn
      ? { kind: 'user', ...(opts.promptOrigin?.sourceChatId ? { sourceChatId: opts.promptOrigin.sourceChatId } : {}), userTurnAt: opts.humanSpawn!.userTurnAt.toISOString() }
      : opts.promptOrigin;

  // Create the chat + coding-state rows first so we have the id for the
  // branch/worktree names (chat id == session id, One-Digby merge).
  const session = await createCodingChat({
    projectId,
    userId,
    title: (opts.title && String(opts.title).trim()) || 'Untitled session',
    permissionMode: mode,
    model,
    modelSource,
    // Ticket 161d39e9: provenance for the TITLE, same discipline as the model
    // stamp — 'spawn-param' when an explicit `title` argument named the work.
    // The executor's sticky-title gate keys on it: provenance beats the
    // placeholder heuristic, which misread an explicit title that echoes its
    // own task brief (a ≥20-char substring of the first message) as
    // scaffolding and let the LLM verdict-phrase overwrite it (11449a0a).
    titleSource: opts.title && String(opts.title).trim() ? 'spawn-param' : null,
  });
  const branch = sessionBranchName(session.id);
  await updateSessionState(session.id, { branch, baseBranch: project.defaultBranch });
  // Display-only sidebar nesting (2026-10-21, platform/display-parent.ts): an
  // agent-origin spawn — the ticket drain's fresh / family lanes and batch
  // sessions, a supervisor's or lane's start_coding_session, a member's
  // machine-turn tool spawn — nests under the folder's Project Supervisor when
  // it has no in-list parent. Keyed on the CALLER-supplied origin, never the
  // member-coerced `promptOrigin` (review fix 2026-10-21): that override only
  // keeps the owner's first run from reading as a user turn; it must not make
  // a member's "New session" click or human-turn spawn look supervisor-
  // dispatched. Never parentChatId (billing / autonomy / hand-off / wakes /
  // reapers key on it); stamped before the chat.created push below so the
  // first sidebar row already carries it. Best-effort: a failure never fails
  // the spawn. Kill switch DISPLAY_PARENT_NESTING_DISABLED=1.
  if (opts.promptOrigin?.kind === 'agent' && !opts.humanSpawn) await stampDisplayParent({ chatId: session.id, projectId, userId }).catch(() => null);

  // Continuity: a new session picks up the MOST RECENT prior session's work in
  // this project (its committed code + plan/summary); falls back to the base branch.
  const prior = opts.chainFromPrior === false ? null : await findPriorSession(projectId, session.id);

  // P6: optional first-goal prompt — delivered as the session's first user
  // message once the workspace is READY (sendChatMessage refuses while the
  // satellite is still provisioning, so deliver-on-ready polls; bounded).
  const prompt = opts.prompt?.trim();

  // Provision the worktree in the background — return immediately so the UI
  // can show a "provisioning" state and poll.
  // Ticket 43de2735: a session dispatched WITH its own first-goal prompt (fleet
  // spawn / ticket batch / start_coding_session brief) must NOT inherit the
  // most-recent prior session's unfinished PLAN. findPriorSession is
  // project-wide (most recently updated session, any lane), so with sibling
  // ticket lanes running in parallel the "prior" can be an UNRELATED lane —
  // the spawned child then boots carrying a different ticket's goal, which
  // persists (update_plan retains an omitted goal server-side) into
  // get_chat_status's plan.goal and the child's own per-turn <plan> reminder.
  // Prompt-less UI "continue my work" sessions keep the inheritance.
  // audit 2026-10-08 W2-1: an explicit continueBranch is the ONLY chain a
  // spawn gets (validated shape — never an option-looking or empty ref).
  const startFromBranch = validStartFromBranch(opts.startFromBranch);
  void provisionWorktree(session.id, project, branch, prior || undefined, { inheritPriorPlan: !prompt, ...(startFromBranch ? { startRef: startFromBranch } : {}) });

  if (prompt) {
    // Durable stash FIRST (nightly 2026-08-28: three spawned batch sessions
    // sat ready-and-empty forever — the fire-and-forget delivery below died
    // with the process and the prompt existed nowhere else). The recovery
    // sweeper delivers the stash if this process doesn't.
    await stashPendingFirstPrompt(session.id, prompt, promptOrigin).then((stashed) => {
      void deliverPromptWhenReady(session.id, userId, prompt, stashed, promptOrigin)
        .catch((e: any) => logger.warn(`platform: first-prompt delivery failed for ${session.id}: ${e.message}`));
    });
  }

  await audit(userId, 'code.session_start', { chatId: session.id, projectId, model, modelSource, modelGovernor, permissionMode: mode, permissionSource, humanSpawn, prompted: !!prompt, chainedFrom: startFromBranch ?? (prior ? prior.branch : null), ...(spawnedBy ?? {}) });
  if (spawnedBy) {
    // SHARED-PROJECT-DISPATCH: the member's own trail — the same start, under
    // the caller's account, naming the owner it runs as. Never throws (audit).
    await audit(callerUserId, 'code.session_start_member', { chatId: session.id, projectId, runUserId: userId, role: spawnedBy.spawnedByRole, source: target.source });
    try {
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.MEMBER_SPAWN, sessionId: session.id, meta: { projectId, runUserId: userId, spawnedByUserId: callerUserId, role: spawnedBy.spawnedByRole, source: target.source } });
    } catch { /* telemetry never blocks a spawn */ }
  }
  // Sidebar push (6201e0ee): a session spawned from ANY surface (the UI's own
  // create button in another tab, a supervisor lane's start_coding_session, a
  // ticket-dispatch child) must appear in connected sidebars immediately —
  // the delta poll's idle cadence is 60 s, which is exactly the "refresh the
  // page to see it" gap this closes.
  publishChatListEvent(userId, { kind: 'chat.created', chatId: session.id });
  if (spawnedBy) publishChatListEvent(callerUserId, { kind: 'chat.created', chatId: session.id });
  return { ...session, branch, baseBranch: project.defaultBranch, permissionSource, ...(spawnedBy ?? {}), ...(startFromBranch ? { startFromBranch } : prior ? { chainedFromSession: prior.id } : {}) };
}

/** audit 2026-10-08 W2-1: a continueBranch value safe to hand git as a start
 *  ref — a plain ref name (letters, digits, . _ / -), never option-shaped,
 *  never a range / revision expression. Anything else ⇒ undefined (fresh base). Pure. */
export function validStartFromBranch(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 200) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(s)) return undefined;
  if (s.includes('..') || s.endsWith('/') || s.endsWith('.lock')) return undefined;
  return s;
}

/** Background worktree provisioning (fire-and-forget from startCodingSession). */
async function provisionWorktree(
  sessionId: string,
  project: CodingProjectShape,
  branch: string,
  prior?: { id: string; branch: string },
  opts?: { inheritPriorPlan?: boolean; startRef?: string },
): Promise<void> {
  try {
    const { ensureWorktree, isWorkspaceVolumeOwner } = await import('../coding/workspace.service');
    let wt: string;
    // Ticket a086c69d (2026-09-28, cross-box split-brain): a web process on a box
    // that does NOT own the coding-workspaces volume (e.g. CODING_WORKER_CONCURRENCY=0,
    // or CODING_WORKSPACE_VOLUME_OWNER=0) provisions worktrees against a STALE local
    // copy of the volume while the real one lives on the owner box — copies diverge
    // daily, sessions re-provision, .digby/rules/00-current-state.md ENOENTs, and the
    // web-box work is wasted. Mirror the proven BLANK_PROVISION_DEFER shape (FO
    // 2026-09-23): a non-owner web process must NOT touch disk — flip the session
    // ready WITHOUT a worktreePath and let the volume-owner worker's ensureRunnable
    // (run-executor.ts:349-384) re-provision on first run; run-reaper.ts:176-194
    // relies on exactly that contract. Chain-from-prior is dropped here for the same
    // reason as the blank path: the prior worktree sits on the worker box's volume,
    // unreachable from this web box anyway.
    if (
      project.provider !== 'blank' &&
      !isWorkspaceVolumeOwner()
    ) {
      await updateSessionState(sessionId, { status: 'ready', errorMessage: null });
      await import('../platform/loop-metrics.service')
        .then(m => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.REPO_PROVISION_DEFERRED, sessionId, meta: {} }))
        .catch(() => {});
      return;
    }
    if (project.provider === 'blank') {
      // Cross-box lattice (FO 2026-09-23, prod chats 26e38cce / 8a898e61): the
      // web box serving this spawn and the coding worker that claims the run do
      // NOT share /app/coding-workspaces — a blank worktree provisioned HERE is
      // invisible to the worker, whose ensureRunnable then failed the run hard
      // ("Workspace missing on disk"; a standalone blank repo has no mirror to
      // rebuild from, unlike repo-backed sessions). So do NOT provision: flip
      // ready WITHOUT a worktreePath and let the worker's P5-B path build the
      // repo on the box that actually executes it (a fresh spawn self-heals
      // there — run-executor's blankSessionIsFresh). Chain-from-prior is
      // dropped on this path: the prior session's worktree sits on some web
      // box's local disk, unreachable from the worker anyway.
      await updateSessionState(sessionId, { status: 'ready', errorMessage: null });
      await import('../platform/loop-metrics.service')
        .then(m => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.BLANK_PROVISION_DEFERRED, sessionId, meta: {} }))
        .catch(() => {});
      return;
    }
    const token = project.provider === 'git'
      ? null
      : await (await import('../github/token-manager')).getValidToken(project.userId, project.githubLabel || undefined);
    wt = await ensureWorktree(
      project.id, sessionId, project.repoUrl, project.defaultBranch, branch, token,
      opts?.startRef ?? prior?.branch,
    );
    // Continuity: carry the prior session's UNFINISHED plan + session memory into
    // this one. Best-effort — never blocks ready.
    // Plan inheritance is gated on opts.inheritPriorPlan (default ON for the
    // prompt-less UI "continue my work" flow): a session created WITH an
    // explicit first-goal prompt skips it (ticket 43de2735) — the prompt IS the
    // goal, and the project-wide "most recent prior" can be an unrelated sibling
    // lane, whose foreign goal would otherwise persist into get_chat_status and
    // the child's per-turn <plan> reminder. Session-MEMORY inheritance is
    // unaffected (durable memory, not a goal/plan claim).
    if (prior) {
      try {
        if (opts?.inheritPriorPlan !== false) {
          const { applyPlan, planToUpdate } = await import('../coding/plan.service');
          const priorPlan = await getPlan(prior.id);
          const unfinished = priorPlan?.steps.some((s) => s.status !== 'completed');
          if (priorPlan && unfinished && (priorPlan.goal || priorPlan.steps.length)) {
            await applyPlan(sessionId, wt, planToUpdate(priorPlan));
          }
        }
      } catch (e: any) { logger.debug(`platform: plan inheritance skipped: ${e.message}`); }
      const { inheritSessionMemory } = await import('../coding/coding-memory.service');
      await inheritSessionMemory(prior.id, sessionId).catch(() => {});
    }
    // Ensure the agent guide (AGENTS.md + .digby framework): scaffold on first
    // provision, then assess + safely refresh untouched scaffolds on stack drift.
    // Best-effort (chained catch: even a missing export can't fail provisioning).
    await import('../coding/scaffolding.service')
      .then((m) => m.ensureProjectDocs(wt, { projectName: project.name, defaultBranch: project.defaultBranch, repoHygiene: false }))
      .catch(() => {});
    // Install the project's dependencies so the real toolchain (tsc/jest/…) is
    // present and `verify` runs for real. Imported projects only (a blank
    // project deferred above); best-effort.
    await installDependencies(sessionId, wt).catch(() => {});
    await updateSessionState(sessionId, { worktreePath: wt, status: 'ready', errorMessage: null });
    // Ticket 1c767622: publish the provision-time snapshot so the Files tab
    // works on ANY web box from the moment the session exists — not only on
    // the box that served the creation request. origin:'provision' — the
    // serve-order fence treats it as a TIE with a disk copy (same generation
    // of data; disk then wins for full fidelity), never as an override.
    // Fire-and-forget, never throws.
    void import('../coding/worktree-snapshot.service')
      .then(m => m.publishWorktreeSnapshot(sessionId, 'provision'))
      .catch(() => {});
  } catch (err: any) {
    logger.error(`platform: provisioning failed for session ${sessionId}: ${err.message}`);
    // Honest error mapping: the session error state carries the REAL failure
    // reason (it renders verbatim in the UI chrome) — a workspace command
    // failure must never reach the user as a bare/misleading "Project not
    // found" (prod session 7d4360ff-…, 2026-08-16: zero-commit repo, git died
    // on "invalid reference: HEAD", UI reported the project missing).
    const reason = String(err.message || 'unknown error').slice(0, 440);
    await updateSessionState(sessionId, { status: 'error', errorMessage: `${PROVISIONING_FAILED_PREFIX}: ${reason}` }).catch(() => {});
  }
}

/**
 * P6: deliver start_coding_session's optional `prompt` as the session's first
 * user message ONCE the workspace reaches 'ready' — the run then starts
 * automatically (sendChatMessage fires the coding harness). Polls the
 * satellite, bounded to ~5 min. A 409 at delivery time (the user typed their
 * own first message first, or a run is already active) surfaces as an
 * AppError to the caller's .catch — logged, never retried forever.
 */
async function deliverPromptWhenReady(chatId: string, userId: string, prompt: string, stashed: boolean, origin?: FirstPromptOrigin): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const state = await (prisma as any).chatCodingState
      .findUnique({ where: { id: chatId }, select: { status: true } })
      .catch(() => null);
    if (!state) throw new Error('coding state row missing');
    if (state.status === 'error') throw new Error('workspace provisioning failed');
    if (state.status === 'ready') {
      // Race-safe with the recovery sweeper: deliver through the shared
      // Redis-locked path. The in-memory prompt is the fallback ONLY when the
      // stash failed — a stashed prompt that reads null was already delivered
      // (by us or the sweeper), and re-sending the in-memory copy would
      // double-fire the session (adversarial-review F1). 'already'/'moot'/
      // 'locked' all mean another path owns/owned it. The author's origin
      // (ticket 2e9e5264) rides as the fallback origin — a LANDED stash
      // carries its own origin, which wins inside deliverPendingFirstPrompt.
      const result = await deliverPendingFirstPrompt(chatId, userId, stashed ? undefined : prompt, origin);
      if (result === 'delivered') {
        logger.info(`platform: first-prompt delivered to session ${chatId} — run started`);
      }
      return;
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for workspace ready');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Install the project's dependencies at scaffold time (imported projects) so the
 * detected toolchain actually exists. Capped + best-effort — never blocks ready.
 */
async function installDependencies(sessionId: string, worktree: string): Promise<void> {
  const DEP_INSTALL_TIMEOUT_MS = 8 * 60 * 1000;
  const { readDigbyConfig } = await import('../coding/verify.service');
  const config = await readDigbyConfig(worktree).catch(() => null);
  const install = config?.commands?.install;
  if (!install) return; // no detected package manager — nothing to install
  try {
    const { ensureSessionContainer, execInContainer, hostExecFallbackAllowed, dockerProbeSkipReason } = await import('../coding/container.service');
    const useContainer = await ensureSessionContainer(sessionId).catch(() => false);
    // FAIL CLOSED (2026-10-20): in container mode the install never runs as
    // bash inside this process — it is skipped (best-effort, like a failed
    // install); the session's own isolated shell can install later. A process
    // with no daemon BY DESIGN (web tier / cron-only) logs info, not warn.
    if (!useContainer && !hostExecFallbackAllowed()) {
      const byDesign = dockerProbeSkipReason();
      const line = `platform: dep install skipped for session ${sessionId} — no isolated container here${byDesign ? ` (${byDesign})` : ''} and container mode refuses host execution`;
      if (byDesign) logger.info(line); else logger.warn(line, { source: 'platform', sessionId });
      return;
    }
    logger.info(`platform: installing deps for session ${sessionId} (${install}, container=${useContainer})`);
    if (useContainer) {
      await execInContainer(sessionId, install, worktree, DEP_INSTALL_TIMEOUT_MS);
    } else {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      await promisify(execFile)('bash', ['-lc', install], {
        cwd: worktree, timeout: DEP_INSTALL_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
        env: { PATH: process.env.PATH, HOME: worktree, CI: '1', GIT_TERMINAL_PROMPT: '0' },
      });
    }
    logger.info(`platform: dep install finished for session ${sessionId}`);
  } catch (err: any) {
    logger.warn(`platform: dep install failed for session ${sessionId} (non-fatal): ${err.message}`, { source: 'platform', sessionId });
  }
}
/** Test seam (2026-10-20 fail-closed install). */
export const __installDependenciesForTest = installDependencies;

// ── Schedules ─────────────────────────────────────────────────────────────────

/**
 * Schedule a run against ANY chat (generalized ChatSchedule): mode='code'
 * chats fire a coding run; other chats fire a detached chat-agent turn
 * (schedule.service sweeper owns the branch). OWNER-only — a firing executes
 * with the chat owner's identity/tools.
 */
export async function scheduleChatRun(opts: {
  userId: string; chatId: string; prompt: string;
  kind: 'once' | 'recurring'; intervalSec: number; maxRuns?: number;
  /** Who wrote the prompt — 'user' (REST / user-anchored run) | 'machine' (autonomous run). */
  promptSetBy?: string;
  /** Owner-subscription marker (ticket 4565991a) — persisted verbatim; gated at the callers. */
  ownerSubscribed?: boolean;
  /** Delta gate (ticket 0b1dbe75, recurring only): {probes:[{url,headers?,jsonPath?|pattern?}],heartbeatHours?} — strictly validated in createSchedule. */
  deltaGate?: unknown;
  /** One-shot CHAIN link (finding B1): the firing schedule this machine `once` arm descends from (own chat only) — createSchedule same-session-checks and stamps it. */
  chainedFromScheduleId?: string;
}): Promise<UserScheduleView & { capWarning?: string; superseded?: string[] }> {
  const { userId, chatId } = opts;
  const { access, exists } = await crossModelService.getChatAccess(chatId, userId);
  if (!exists) throw new AppError(404, 'Chat not found');
  if (access !== 'owner') {
    throw new AppError(access === 'none' ? 404 : 403,
      access === 'none' ? 'Chat not found' : 'Only the chat owner can schedule runs in it');
  }
  const res = await createSchedule({
    sessionId: chatId,
    userId,
    prompt: opts.prompt,
    kind: opts.kind,
    intervalSec: opts.intervalSec,
    maxRuns: opts.maxRuns,
    ...(opts.promptSetBy ? { promptSetBy: opts.promptSetBy } : {}),
    ...(opts.ownerSubscribed !== undefined ? { ownerSubscribed: opts.ownerSubscribed } : {}),
    ...(opts.deltaGate !== undefined ? { deltaGate: opts.deltaGate } : {}),
    ...(opts.chainedFromScheduleId ? { chainedFromScheduleId: opts.chainedFromScheduleId } : {}),
  });
  if (!res.ok || !res.schedule) throw new AppError(400, res.error || 'Could not create schedule');
  await audit(userId, 'schedule.create', { scheduleId: res.schedule.id, chatId, kind: opts.kind });
  // Cap-cadence advisory (ticket 2694a581) rides the create response so the
  // schedule_message tool / REST caller can surface the burn math. The
  // same-cadence collapse ids (ticket ae20da66) ride too — already-cancelled
  // rows the caller must not cancel again.
  return {
    ...res.schedule,
    sessionId: chatId,
    ...(res.warning ? { capWarning: res.warning } : {}),
    ...(res.superseded?.length ? { superseded: res.superseded } : {}),
  };
}

/** All of the user's schedules (across all their chats) — active rows first (never truncated), then the newest-100 terminal history. */
export async function listSchedules(opts: { userId: string }): Promise<UserScheduleView[]> {
  return listSchedulesForUser(opts.userId);
}

/** One of the user's schedules by exact id / unique ≥8-char prefix, ANY status — even past the
 *  listing's newest-100 terminal window (ticket 03aef0da). null = none; an ambiguous prefix throws. */
export async function getSchedule(opts: { userId: string; id: string }): Promise<UserScheduleView | null> {
  return getScheduleForUser(opts.userId, opts.id);
}

/**
 * Cancel (disable) one of the user's schedules. Widened from coding-session
 * scope to the owning user. `initiator` (SA0906): defaults to 'owner' (REST
 * DELETE, fleet dashboard actions — explicit human choices, no
 * stopped-schedule decision); the cancel_schedule TOOL passes 'machine' for a
 * machine-triggered run (no ctx.userTurnAt) so a machine cancel of a recurring
 * cadence gets the same delayed dead-lane owner-decision check as a cap stop.
 */
export async function cancelSchedule(opts: { userId: string; id: string; initiator?: 'owner' | 'machine'; actorChatId?: string | null }): Promise<boolean> {
  // audit 2026-10-06 T4-2: the cancelling RUN's chat rides schedule_disabled as actorChatId (tool path only).
  const ok = await cancelScheduleForUser(opts.userId, opts.id, { initiator: opts.initiator ?? 'owner', ...(opts.actorChatId ? { actorChatId: opts.actorChatId } : {}) });
  if (ok) await audit(opts.userId, 'schedule.cancel', { scheduleId: opts.id });
  return ok;
}

/** Post-cancel deaf-lane warning — see schedule.service.deafLaneWarningForUser. */
export async function deafLaneWarning(opts: { userId: string; scheduleId: string }): Promise<string | null> {
  return deafLaneWarningForUser(opts.userId, opts.scheduleId);
}

/**
 * Update one of the user's schedules (feedback c6147f39) — mutable: prompt
 * and/or cadence. Stale autonomous schedules firing superseded instructions
 * were a production hazard; cancel+recreate loses the row id (and history).
 */
export async function updateSchedule(opts: {
  userId: string; id: string; prompt?: string; intervalSec?: number; promptSetBy?: string;
  /** Owner-subscription marking (ticket 4565991a): true/false marks/unmarks; undefined PRESERVES the row's mark. */
  ownerSubscribed?: boolean;
  /** P7 (G13): [{tool, argPattern?}] receipts each machine firing must carry; null/[] clears. */
  requiredProbes?: unknown;
  /** Delta gate (ticket 0b1dbe75): {probes:[…],heartbeatHours?} — null clears; strictly validated in updateScheduleForUser. */
  deltaGate?: unknown;
}): Promise<{ ok: boolean; schedule?: UserScheduleView; error?: string; warning?: string }> {
  const res = await updateScheduleForUser(opts.userId, opts.id, {
    prompt: opts.prompt, intervalSec: opts.intervalSec,
    ...(opts.promptSetBy ? { promptSetBy: opts.promptSetBy } : {}),
    ...(opts.ownerSubscribed !== undefined ? { ownerSubscribed: opts.ownerSubscribed } : {}),
    ...(opts.requiredProbes !== undefined ? { requiredProbes: opts.requiredProbes } : {}),
    ...(opts.deltaGate !== undefined ? { deltaGate: opts.deltaGate } : {}),
  });
  if (res.ok) await audit(opts.userId, 'schedule.update', { scheduleId: opts.id, fields: [opts.prompt !== undefined && 'prompt', opts.intervalSec !== undefined && 'intervalSec', opts.requiredProbes !== undefined && 'requiredProbes', opts.deltaGate !== undefined && 'deltaGate'].filter(Boolean) });
  return res;
}

// ── Chat-scoped schedule management (the workspace panel's Schedules tab) ──────

/**
 * Owner gate shared by the chat-scoped schedule REST surface: schedules fire
 * with the chat OWNER's identity (the same reasoning as scheduleChatRun), so
 * managing them is owner-only. Unknown chat / no relationship → 404 (no
 * existence leak, mirrors listChatSchedules); project member → 403 (they can
 * SEE the chat's schedules via the GET, but not stop the owner's cadences).
 */
async function requireChatOwnerForSchedules(userId: string, chatId: string): Promise<void> {
  const { access, exists } = await crossModelService.getChatAccess(chatId, userId);
  if (!exists || access === 'none') throw new AppError(404, 'Chat not found');
  if (access !== 'owner') throw new AppError(403, 'Only the chat owner can manage its schedules');
}

/**
 * DELETE /chats/:id/schedules/:scheduleId — cancel (disable) one schedule ON a
 * specific chat, with the cancel_schedule platform tool's EXACT semantics: the
 * row persists (enabled:false, lastStatus 'cancelled' — nothing is destroyed,
 * so the PATCH enabled:true resume path can undo it until the ~30-day terminal
 * GC), schedule.service emits the ONE schedule_disabled hook event (deaf-lane
 * suffix included) so a subscribed supervisor hears the cadence stop, and the
 * mutation lands the same 'schedule.cancel' Activity audit row the tool path
 * writes. Chat-scoped: a scheduleId that exists on ANOTHER chat 404s.
 * Idempotent: an already-disabled row is a quiet success (no duplicate hook
 * event, no re-audit). The returned deaf-lane warning (chat left with ZERO
 * enabled schedules) is for the UI to surface — the same honesty the tool
 * result carries to the model.
 */
export async function cancelChatSchedule(opts: { userId: string; chatId: string; scheduleId: string }): Promise<{ cancelled: boolean; alreadyDisabled: boolean; warning: string | null }> {
  const { userId, chatId, scheduleId } = opts;
  await requireChatOwnerForSchedules(userId, chatId);
  const row = await prisma.chatSchedule.findFirst({ where: { id: scheduleId, sessionId: chatId } });
  if (!row) throw new AppError(404, 'Schedule not found');
  if (!row.enabled) return { cancelled: true, alreadyDisabled: true, warning: null };
  const ok = await cancelScheduleForSession(chatId, scheduleId);
  if (!ok) throw new AppError(404, 'Schedule not found'); // deleted between the two reads
  await audit(userId, 'schedule.cancel', { scheduleId, chatId });
  const warning = await deafLaneWarningForUser(userId, scheduleId).catch(() => null);
  return { cancelled: true, alreadyDisabled: false, warning };
}

/**
 * PATCH /chats/:id/schedules/:scheduleId {enabled} — pause (false) / resume
 * (true) one schedule on this chat. The cadence rules live in
 * schedule.service.setScheduleEnabledForChat (stale-nextRunAt recompute on
 * resume, completed/active-cap guards, 'paused' schedule_disabled emission);
 * this wrapper owns the chat-owner gate and the Activity audit
 * ('schedule.pause' / 'schedule.resume' — only when the state actually
 * changed). Rule violations surface as 409 with the service's honest message.
 */
export async function setChatScheduleEnabled(opts: { userId: string; chatId: string; scheduleId: string; enabled: boolean; actorChatId?: string | null }): Promise<{ schedule: ScheduleView; changed: boolean }> {
  const { userId, chatId, scheduleId, enabled } = opts;
  await requireChatOwnerForSchedules(userId, chatId);
  // audit 2026-10-06 T4-2: pause_schedule passes the pausing run's chat (actorChatId); REST passes none.
  const res = opts.actorChatId
    ? await setScheduleEnabledForChat(chatId, scheduleId, enabled, { actorChatId: opts.actorChatId })
    : await setScheduleEnabledForChat(chatId, scheduleId, enabled);
  if (!res.ok) {
    if (res.reason === 'not_found') throw new AppError(404, 'Schedule not found');
    throw new AppError(409, res.error);
  }
  if (res.changed) await audit(userId, enabled ? 'schedule.resume' : 'schedule.pause', { scheduleId, chatId });
  return { schedule: res.schedule, changed: res.changed };
}
