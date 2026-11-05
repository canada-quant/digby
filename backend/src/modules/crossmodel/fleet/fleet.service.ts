/**
 * Fleet Management — the service layer behind the Management UI
 * (/api/crossmodel/fleet, fleet.routes.ts).
 *
 * Every owner has ONE auto-provisioned "Fleet Supervisor" chat (isSupervisor=
 * true — platform/supervisor.service.ts owns provisioning; there is NO manual
 * designation setting). The supervisor receives scheduled/autonomous machine
 * runs, which persist their wake prompts + replies as ordinary chat messages
 * (stamped metadata.origin — see chat-agent.service.ts / run-executor.ts),
 * flooding the transcript. This module powers:
 *
 *   - discovery:     GET /fleet/supervisor — the caller's supervisor chat +
 *                    its live view (read-only; never creates).
 *   - overview:      ONE aggregate of fleet counts (no transcripts).
 *   - thread:        the INTERACTIVE view of the supervisor chat — machine
 *                    noise (schedule wakes, agent messages, and their replies)
 *                    filtered out, cursor-paginated backward.
 *   - send:          sendSupervisorMessage — a busy supervisor no longer 409s;
 *                    the message lands in pending_chat_messages (the busy-chat
 *                    queue, chat-agent/message-queue.service.ts) and is drained
 *                    FIFO by the finishing run's own finally (chat-agent.
 *                    service drainChatQueue — the supervisor is a plain
 *                    detached chat, so it is covered by that drain).
 *   - log:           the merged RAW log (everything, noise included) — the
 *                    supervisor transcript + agent-originated Activity rows.
 *
 * Every function takes userId explicitly and is owner-scoped: the acting user
 * must OWN the supervisor chat (shared-project chats are never eligible — the
 * supervisor is per-OWNER by construction).
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import type { AgentAttachment } from '../chat-agent/chat-gate';
import type { Attachment } from '../upload.controller';
import { resolveStagedUploads, attachmentDropAnnotation } from '../attachment-resolution';
import { projectedDailyFiringsFor, clockDriftMinutesFor, projectNextFirings } from '../coding/schedule.service';
// Owner briefings (owner 2026-09-04): the plain-English layer over machine
// wake notes — the kind constant drives the noise-classifier exemption, and
// the generator backs the dashboard bootstrap (module keeps utility-llm
// behind a dynamic import, so this static import stays light).
import { OWNER_BRIEFING_KIND, generateOwnerBriefing } from './owner-briefing.service';
// Owner-armed scheduled digests (ticket 77c3a7e9): the ANSWER row of an
// owner-armed schedule firing — same leaf-module constant chat-agent stamps.
// machine-wake imports only coding/tool-scope (a pure leaf), so this static
// import adds no cycle.
import { OWNER_DIGEST_KIND } from '../chat-agent/machine-wake';
// Cross-process busy truth (P5 audit): the in-process registry alone missed
// runs on the other blue/green web instance AND every worker-executed coding
// run — the dashboard's headline "running" signal reported 0 during real runs.
import { isChatBusy, getBusyChatIds } from '../chat-agent/chat-busy';
import { instanceOwnRepoSlugSoft, isFrameworkProjectRow } from '../platform/framework-project';
// Supervisor OFF switch (owner 2026-09-26): the Management surfaces carry the
// switch state + the harness-composed status line.
import { getSupervisorSwitchState, type SupervisorSwitchState } from '../platform/supervisor-switch';
import { isChildRelayRow } from '../platform/child-session-relay';
// Refused self-renewals surface (review-fixer 2026-09-27): never throws, null line when none.
import { getRenewRefusalSummary } from '../coding/renew-refusal-surface';

/** Both supervisor switches for the Management UI; null when unreadable (deploy skew / outage). */
async function supervisorSwitchForUi(): Promise<SupervisorSwitchState | null> {
  try {
    return await getSupervisorSwitchState();
  } catch {
    return null;
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

export interface FleetSupervisorView {
  id: string;
  title: string;
  running: boolean;
  codeCapable: boolean;
  /** ChatCodingState.status — present only for coding-capable chats. */
  codingStatus?: string;
}

/**
 * The supervisor view for one chat — NULL when the chat is gone or not owned
 * by the user. (Ownership is structural: the supervisor is created for its
 * owner, but the check stays as a defense-in-depth guard.)
 */
async function supervisorViewFor(userId: string, chatId: string): Promise<FleetSupervisorView | null> {
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: { id: true, userId: true, title: true, projectId: true },
  });
  if (!chat || chat.userId !== userId) return null;
  const state = await prisma.chatCodingState
    .findUnique({ where: { id: chatId }, select: { status: true, worktreePath: true } })
    .catch(() => null);
  // MERGE-1 slice 1: this view used to compute `codeCapable = !!state` with no
  // folder-chain leg — it DRIFTED from getChatCapability, so a supervisor chat
  // filed in a workspace folder reported codeCapable=false here while the
  // sidebar and the folder tree both said true. One chat, two answers. The
  // predicate now comes from the one place that owns it.
  const { getChatCapability } = await import('../coding/coding-data.service');
  const capability = await getChatCapability(chat, state ? { worktreePath: state.worktreePath } : null)
    .catch(() => ({ codeCapable: false, hasWorkspaceState: false, workspaceReady: false }));
  return {
    id: chat.id,
    title: chat.title,
    running: await isChatBusy(chatId),
    codeCapable: capability.codeCapable,
    ...(state ? { codingStatus: state.status } : {}),
  };
}

/**
 * The user's fleet supervisor chat id (null when never provisioned).
 * Identification lives in platform/supervisor.service (isSupervisor=true) —
 * dynamic import per that module's discipline (it statically imports
 * autonomy.service → crossmodel.service).
 */
async function supervisorChatIdFor(userId: string): Promise<string | null> {
  const { findFleetSupervisorChat } = await import('../platform/supervisor.service');
  const chat = await findFleetSupervisorChat(userId);
  return chat?.id ?? null;
}

/**
 * SEND-path helper: self-heals via ensureFleetSupervisor when the supervisor
 * is missing (a fresh account whose sidebar ensure has not landed yet, or a
 * deleted supervisor — main re-creates it on sidebar load the same way);
 * ensure NEVER throws, so a null result means a real provisioning failure.
 * READ endpoints must NOT use this — a GET never provisions (getFleetSupervisor
 * and getSupervisorThread resolve read-only and report absence instead).
 */
async function requireSupervisor(userId: string): Promise<{ chatId: string; title: string }> {
  const sup = await import('../platform/supervisor.service');
  const existing = await sup.findFleetSupervisorChat(userId);
  const chat = existing ?? (await sup.ensureFleetSupervisor(userId));
  if (!chat) {
    throw new AppError(500, 'Fleet supervisor is not available yet — it is auto-provisioned; try again in a moment');
  }
  return { chatId: chat.id, title: chat.title };
}

// ── Origin classification (defensive Json reads — metadata is arbitrary) ──────

/** metadata.origin of a message row ('user' | 'schedule' | 'agent' | 'machine' | unknown→null). */
function rowOrigin(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const o = (metadata as Record<string, unknown>).origin;
  return typeof o === 'string' && o ? o : null;
}

function rowSourceChatId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const s = (metadata as Record<string, unknown>).sourceChatId;
  return typeof s === 'string' && s ? s : null;
}

/** metadata.childResult — the auto-wired child→parent RESULT hook stamped this
 *  wake (ticket 56d6b204). Defensive JSONB read. */
function rowChildResult(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as Record<string, unknown>).childResult === true;
}

/**
 * Agent CONTROL rows (review finding, ticket 739e8191): the harness's ack /
 * material-gate fan-out between lanes is `metadata.ackOnly` / `materialGate`.
 * A suppressed batch ("acked; no turn started") is NOT delivered work — it
 * must keep its machine classification even from a child chat, or internal
 * chatter renders as owner-facing content.
 */
function rowIsAgentControl(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const m = metadata as Record<string, unknown>;
  return m.ackOnly === true || m.materialGate === true;
}

/** metadata.kind of a message row — 'owner_briefing' marks the plain-English
 *  briefing layer (owner-briefing.service). Defensive JSONB read. */
function rowKind(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const k = (metadata as Record<string, unknown>).kind;
  return typeof k === 'string' && k ? k : null;
}

/** Origins that mark a row as MACHINE noise (not part of the interactive thread).
 *  'hook' — event-hook wake deliveries (stamped since audit p10; previously
 *  mis-stamped 'schedule', so older rows still carry that). */
const MACHINE_ORIGINS = new Set(['schedule', 'hook', 'machine', 'agent', 'webhook']);

/**
 * Sanitize metadata.attachments (stamped by chat-agent at send time) down to
 * filename+type chips (plus the uploadId/fileId join fields when present —
 * ticket c6e8edda: the inline-image render needs them). Defensive: metadata
 * is JSONB — any shape other than the expected array-of-objects renders as
 * no chips, never a crash.
 */
function attachmentsSummary(metadata: unknown): Array<{ filename: string; type: string; uploadId?: string; fileId?: string; mimeType?: string }> | undefined {
  const list = (metadata as Record<string, unknown> | null)?.attachments;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const clean = list
    .map((a) => ({
      filename: String((a as any)?.filename ?? ''),
      type: String((a as any)?.type ?? 'document'),
      ...(typeof (a as any)?.uploadId === 'string' && (a as any).uploadId ? { uploadId: (a as any).uploadId } : {}),
      ...(typeof (a as any)?.fileId === 'string' && (a as any).fileId ? { fileId: (a as any).fileId } : {}),
      ...(typeof (a as any)?.mimeType === 'string' && (a as any).mimeType ? { mimeType: (a as any).mimeType } : {}),
    }))
    .filter((a) => a.filename);
  return clean.length ? clean : undefined;
}

interface RawThreadRow {
  id: string;
  role: string;
  content: string;
  metadata: unknown;
  createdAt: Date;
}

interface ClassifiedRow extends RawThreadRow {
  /** Effective origin after retro-classification + assistant inheritance. */
  origin: string;
  noise: boolean;
}

/**
 * Classify raw transcript rows (MUST be chronological — assistant inheritance
 * flows from the nearest PRECEDING user row):
 *   - user + origin in MACHINE_ORIGINS → noise.
 *   - user + NO origin + content exactly matches one of the chat's schedule
 *     prompts → noise (retro-classifier for pre-marking machine runs).
 *   - assistant + metadata.kind 'owner_briefing' → NEVER noise (owner 2026-09-04:
 *     the plain-English briefing layer is written FOR the owner — it renders
 *     as a regular assistant bubble; the surrounding wake turns keep their
 *     noise state untouched).
 *   - assistant + own origin in MACHINE_ORIGINS → noise.
 *   - assistant + NO own origin → inherits the nearest preceding user row's
 *     noise state; no preceding user row in the fetched window → interactive.
 */
function classifyThreadRows(
  rows: RawThreadRow[],
  schedulePrompts: Set<string>,
  /**
   * The chat's CHILD chat ids (ticket 739e8191) — see childChatIdsFor. A relay
   * FROM one of them is a sub-session reporting to its parent, i.e. delivered
   * content the owner is waiting on, not internal machine noise. Null/absent ⇒
   * today's behaviour exactly (no lineage known, nothing exempted).
   */
  childIds?: ReadonlySet<string> | null,
): ClassifiedRow[] {
  let lastUserNoise: boolean | null = null; // null = no user row seen in the window
  let lastUserOrigin = 'user';
  return rows.map((row) => {
    if (row.role === 'user') {
      const origin = rowOrigin(row.metadata);
      // Child-session relay (ticket 739e8191, owner report 2026-11-02): the
      // parent chat's reply to a sub-session that finished and reported back is
      // how the OWNER learns the work is done — the owner's complaint in chat
      // 99e63f86 was "you don't seem to communicate … after you get a message
      // from a sub session". That relay row is origin 'agent', so without this
      // exemption the noise filter drops the relay AND (via inheritance) the
      // answering reply, and the owner never sees either. Exempted BEFORE the
      // origin branch, exactly like owner_briefing/owner_digest; lastUserNoise
      // is set FALSE so the reply that follows inherits visibility. Lineage
      // (crossmodel_chats.parentChatId) is the authority — a relay from a
      // sibling lane or the Fleet Supervisor keeps its noise state.
      const childRelay = origin === 'agent' && !rowIsAgentControl(row.metadata) && isChildRelayRow(row, childIds);
      if (childRelay) {
        lastUserNoise = false;
        lastUserOrigin = origin;
        return { ...row, origin, noise: false };
      }
      const noise = origin != null ? MACHINE_ORIGINS.has(origin) : schedulePrompts.has(row.content);
      lastUserNoise = noise;
      lastUserOrigin = origin ?? (noise ? 'machine' : 'user');
      return { ...row, origin: lastUserOrigin, noise };
    }
    // Owner briefing (owner 2026-09-04): exempt BEFORE origin/inheritance —
    // a briefing typically lands right after its wake note, exactly where
    // inheritance would fold it into the machine turn. lastUserNoise is left
    // untouched so the NEXT assistant row still inherits its wake's noise.
    if (rowKind(row.metadata) === OWNER_BRIEFING_KIND) {
      return { ...row, origin: 'briefing', noise: false };
    }
    // Owner-armed scheduled digest (ticket 77c3a7e9): the ANSWER row of an
    // owner-armed firing — delivered content, exempted exactly like a briefing.
    // The row carries its own origin 'schedule', so without this exemption the
    // own-origin branch below would noise-classify it and the thread's noise
    // filter would drop it entirely (frontend parity: isOwnerDigest in
    // machine-turn-grouping). lastUserNoise untouched, same reasoning.
    if (rowKind(row.metadata) === OWNER_DIGEST_KIND) {
      return { ...row, origin: 'digest', noise: false };
    }
    // assistant (or anything else — treated like assistant)
    const own = rowOrigin(row.metadata);
    if (own != null) {
      return { ...row, origin: own, noise: MACHINE_ORIGINS.has(own) };
    }
    const inheritedNoise = lastUserNoise === true;
    return { ...row, origin: inheritedNoise ? lastUserOrigin : 'user', noise: inheritedNoise };
  });
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * The fleet artifacts the sidebar must HIDE (the Management page is their only
 * UI home):
 *   - chatIds:    EVERY supervisor chat — isSupervisor=true, plus legacy dupes
 *                 from before the flag existed. Legacy identity is REAL, not
 *                 name-only: the exact title AND the system-written stock
 *                 prompt opener (no endpoint edits a chat's systemPrompt, so
 *                 the opener marks a system-created row). A user chat merely
 *                 RENAMED 'Fleet Supervisor' has neither flag nor opener and
 *                 stays visible.
 *   - projectIds: every project that is EITHER the known runtime-created
 *                 artifact (name trimmed/case-insensitively 'fleet hq' — the
 *                 supervisor agent improvised it at runtime; hidden even when
 *                 empty so it stops rendering, but ONLY while it holds no
 *                 visible chat) OR a fleet-DEDICATED folder (≥1 hidden chat
 *                 and NOTHING else). A folder with ANY visible chat is NEVER
 *                 hidden — that would strand legit user chats.
 * ONE chats query + ONE projects query feed both computations.
 */
/**
 * Pure derivation of the sidebar-hidden fleet artifacts from already-fetched
 * chat/project rows. Shared by getSidebarHiddenFleetArtifacts (its own cheap
 * selects) and getFleetOverview (reuses the rows it already loaded — no extra
 * queries on the 20s dashboard poll). Rules: hide every isSupervisor chat plus
 * legacy title+stock-prompt dupes; hide a 'fleet hq' project only while every
 * chat in it (possibly none) is hidden; hide a folder only when it has ≥1 chat
 * and ALL are hidden (never strand a user chat).
 */
function deriveHiddenFleetArtifacts(
  chats: ReadonlyArray<{
    id: string;
    title: string;
    projectId: string | null;
    isSupervisor?: boolean | null;
    systemPrompt?: string | null;
  }>,
  projects: ReadonlyArray<{ id: string; name: string; repoUrl?: string | null }>,
  supervisorTitle: string,
  supervisorPromptOpener: string,
): { chatIds: Set<string>; projectIds: Set<string> } {
  const hiddenChatIds = new Set(
    chats
      .filter(
        (c) =>
          c.isSupervisor ||
          (c.title === supervisorTitle && !!c.systemPrompt?.startsWith(supervisorPromptOpener)),
      )
      .map((c) => c.id),
  );
  // Framework surface (ticket 9471d338): the platform's own project leaves
  // the sidebar entirely — Management → Framework is its home — and every
  // chat filed in it (framework lanes) hides with it. Identity is the same
  // repoUrl resolution the backend guards use; the soft slug resolves '' on
  // an instance with no own repo (nothing hides — yesterday's UI).
  const ownRepo = instanceOwnRepoSlugSoft();
  for (const p of projects) {
    if (isFrameworkProjectRow(p, ownRepo)) {
      for (const c of chats) {
        if (c.projectId === p.id) hiddenChatIds.add(c.id);
      }
    }
  }
  const chatsByProject = new Map<string, string[]>();
  for (const c of chats) {
    if (!c.projectId) continue;
    const list = chatsByProject.get(c.projectId) ?? [];
    list.push(c.id);
    chatsByProject.set(c.projectId, list);
  }
  const projectIds = new Set(
    projects
      .filter((p) => {
        // Framework surface (ticket 9471d338): the platform's own project is
        // hidden EVEN when it holds no chats (a fresh lane-less instance must
        // not show it either) — Management → Framework is its only home.
        if (isFrameworkProjectRow(p, ownRepo)) return true;
        const pChats = chatsByProject.get(p.id) ?? [];
        const allHidden = pChats.every((id) => hiddenChatIds.has(id)); // vacuously true when empty
        // Runtime artifact — hide even when EMPTY, but a 'Fleet HQ' folder a
        // user filled with real chats is THEIRS (names are user-editable).
        if (p.name.trim().toLowerCase() === 'fleet hq') return allHidden;
        return pChats.length > 0 && allHidden;
      })
      .map((p) => p.id),
  );
  return { chatIds: hiddenChatIds, projectIds };
}

export async function getSidebarHiddenFleetArtifacts(
  userId: string,
): Promise<{ chatIds: string[]; projectIds: string[] }> {
  const { SUPERVISOR_TITLE, SUPERVISOR_PROMPT_OPENER } = await import('../platform/supervisor.service');
  const [chats, projects] = await Promise.all([
    prisma.crossModelChat.findMany({
      where: { userId },
      select: { id: true, title: true, projectId: true, isSupervisor: true, systemPrompt: true },
    }),
    prisma.crossModelProject.findMany({
      where: { userId },
      select: { id: true, name: true, repoUrl: true },
    }),
  ]);
  const hidden = deriveHiddenFleetArtifacts(chats, projects, SUPERVISOR_TITLE, SUPERVISOR_PROMPT_OPENER);
  return { chatIds: [...hidden.chatIds], projectIds: [...hidden.projectIds] };
}

/**
 * GET /fleet/supervisor — the caller's auto-provisioned fleet supervisor chat
 * + its live view. READ-ONLY (never creates): supervisor is null when the
 * supervisor has not been provisioned yet (it is created lazily by chat /
 * coding-session creation and the sidebar's POST /supervisor/ensure). Also
 * returns `hidden` — the sidebar-hidden fleet artifact ids (above).
 */
export async function getFleetSupervisor(userId: string) {
  const [chatId, hidden] = await Promise.all([
    supervisorChatIdFor(userId),
    getSidebarHiddenFleetArtifacts(userId),
  ]);
  const supervisor = chatId ? await supervisorViewFor(userId, chatId) : null;
  return { supervisor, hidden };
}

// ── Overview ──────────────────────────────────────────────────────────────────

/**
 * GET /fleet/overview — ONE aggregate for the Management dashboard. Counts and
 * summary rows ONLY (never transcripts). All sources are owner-scoped.
 */
export async function getFleetOverview(userId: string) {
  // Resolve the supervisor view directly — NOT via getFleetSupervisor, whose
  // hidden-artifact queries are sidebar-only. Hidden projects ARE derived
  // below (pure computation over the already-fetched rows — no extra queries)
  // so the Dashboard's projects table matches the sidebar (no Fleet HQ etc.).
  const supervisorChatId = await supervisorChatIdFor(userId);
  const supervisor = supervisorChatId ? await supervisorViewFor(userId, supervisorChatId) : null;
  const [chats, projects, codingStates, schedules, enabledSchedules, totalSchedules, queuedMessages, eventHooks] = await Promise.all([
    prisma.crossModelChat.findMany({
      // Archived chats leave the dashboard counts/rows (archive = de-clutter).
      where: { userId, archivedAt: null },
      select: { id: true, title: true, projectId: true, isSupervisor: true, systemPrompt: true },
    }),
    prisma.crossModelProject.findMany({
      // Archived folders leave the dashboard projects table (archive = de-clutter).
      where: { userId, archivedAt: null },
      select: { id: true, name: true, color: true, emoji: true, supervised: true, projectSupervisorEnabled: true, isUserSpace: true, repoUrl: true, updatedAt: true },
    }),
    prisma.chatCodingState.findMany({
      where: { userId, status: { in: ['provisioning', 'ready', 'running', 'error'] } },
      select: { id: true, title: true, status: true, branch: true, model: true, updatedAt: true },
    }),
    prisma.chatSchedule.findMany({
      where: { userId },
      // Enabled rows FIRST (owner bug 2026-09-04): disabled schedules keep
      // stale past nextRunAt values, so a plain nextRunAt-asc sort filled the
      // whole 100-row cap with dead rows for automation-heavy accounts — the
      // dashboard showed "0 active" while ~20 live schedules sorted past the
      // cap. Live rows must always survive the window.
      orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }],
      take: 100,
    }),
    // A REAL count — the schedules list above is capped at 100 rows, so
    // filtering it would undercount automation-heavy users' tile.
    prisma.chatSchedule.count({ where: { userId, enabled: true } }),
    // REAL total for the same reason (the tile's "N inactive" subline).
    prisma.chatSchedule.count({ where: { userId } }),
    // Busy-chat queue depth across ALL of the user's chats (main's
    // pending_chat_messages — no claim states; a row is queued until drained).
    prisma.pendingChatMessage.count({ where: { userId } }),
    // Event-hook wiring (sourceChatId NULL = the supervisor's wildcard hook).
    prisma.eventHook.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  // ONE batched busy check for the whole fleet (local registry + one Redis
  // MGET + one agent_runs query) — never a serial per-chat await chain on the
  // 20s dashboard poll.
  const runningIds = await getBusyChatIds(chats.map((c) => c.id));
  const titleByChatId = new Map(chats.map((c) => [c.id, c.title]));
  // Lane → folder enrichment for the Dashboard's sessions table (the chats
  // rows already carry projectId — no extra query).
  const projectIdByChatId = new Map(chats.map((c) => [c.id, c.projectId]));

  // Hidden fleet artifacts (Fleet HQ folder, fleet-dedicated folders) are
  // derived from the rows already in hand and excluded from the projects
  // table + projects count so Management matches the sidebar. The hidden
  // USER-SPACE project (P3 — every auto-filed chat lives there) is excluded
  // too: its chats render as the sidebar's ungrouped section, and a
  // "Workspace" card holding every chat would be a phantom here.
  const { SUPERVISOR_TITLE, SUPERVISOR_PROMPT_OPENER } = await import('../platform/supervisor.service');
  const hidden = deriveHiddenFleetArtifacts(chats, projects, SUPERVISOR_TITLE, SUPERVISOR_PROMPT_OPENER);
  const visibleProjects = projects.filter((p) => !hidden.projectIds.has(p.id) && !p.isUserSpace && !isFrameworkProjectRow(p, instanceOwnRepoSlugSoft()));

  return {
    supervisor,
    // Supervisor OFF switch (owner 2026-09-26): the Status card renders
    // `supervisorSwitch.line` ("Fleet supervisor: OFF since … by … — wakes
    // skipped: N"); null = unreadable (the card shows nothing).
    supervisorSwitch: await supervisorSwitchForUi(),
    // Refused self-renewals (review-fixer 2026-09-27, finding B2 follow-up):
    // the Status card renders `renewRefusals.line` ("Self-armed watches
    // stopped (last 24 h, harness-measured): N — …"); null line = none.
    renewRefusals: await getRenewRefusalSummary({ scope: 'user', userId }),
    counts: {
      chats: chats.length,
      projects: visibleProjects.length,
      runningSessions: runningIds.size,
      enabledSchedules,
      totalSchedules,
      queuedMessages,
    },
    projects: visibleProjects.map((p) => {
      const pChats = chats.filter((c) => c.projectId === p.id);
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        emoji: p.emoji,
        supervised: p.supervised,
        // Dedicated per-project supervisor flag (2026-09-14) — the dashboard's
        // 'Supervisor' switch binds this; separate from `supervised` above.
        projectSupervisorEnabled: p.projectSupervisorEnabled ?? false,
        chatCount: pChats.length,
        runningCount: pChats.filter((c) => runningIds.has(c.id)).length,
        updatedAt: p.updatedAt,
      };
    }),
    sessions: codingStates.map((s) => ({
      chatId: s.id,
      title: titleByChatId.get(s.id) ?? s.title,
      status: s.status,
      branch: s.branch,
      model: s.model,
      projectId: projectIdByChatId.get(s.id) ?? null,
      running: runningIds.has(s.id),
      updatedAt: s.updatedAt,
    })),
    schedules: schedules.map((s) => ({
      id: s.id,
      chatId: s.sessionId,
      chatTitle: titleByChatId.get(s.sessionId) ?? null,
      kind: s.kind,
      intervalSec: s.intervalSec,
      nextRunAt: s.nextRunAt,
      enabled: s.enabled,
      lastStatus: s.lastStatus,
      runsCount: s.runsCount,
      promptSnippet: s.prompt.slice(0, 100),
    })),
    hooks: eventHooks.map((h) => ({
      id: h.id,
      sourceChatId: h.sourceChatId, // null = wildcard (all chats)
      sourceTitle: h.sourceChatId ? titleByChatId.get(h.sourceChatId) ?? null : null, // null for wildcard or a deleted chat
      targetChatId: h.targetChatId,
      targetTitle: titleByChatId.get(h.targetChatId) ?? null,
      eventTypes: h.eventTypes,
      enabled: h.enabled,
      debounceSec: h.debounceSec,
      lastFiredAt: h.lastFiredAt,
    })),
  };
}

/**
 * POST /fleet/schedules/:id/cancel — dismiss (disable) one of the caller's
 * schedules from the Management Dashboard. Thin owner-scoped wrapper over
 * platform.service.cancelSchedule (which audits `schedule.cancel`); reversible
 * by design — the row stays, it just stops firing. 404 when the schedule is
 * not the caller's (or already gone).
 */
export async function dismissFleetSchedule(userId: string, scheduleId: string): Promise<{ ok: true }> {
  const { cancelSchedule } = await import('../platform/platform.service');
  const ok = await cancelSchedule({ userId, id: scheduleId });
  if (!ok) throw new AppError(404, 'Schedule not found');
  return { ok: true };
}

/**
 * GET /fleet/schedules — the Management Schedules tab: EVERY schedule row the
 * caller owns (enabled first, then by next firing), joined with chat titles in
 * ONE batched lookup (never per-row). Unlike the Dashboard's 100-row overview
 * slice, this carries the full lifecycle fields (maxRuns / expiresAt /
 * lastFiredAt) and a longer prompt snippet so the tab can stand alone.
 */
export async function getFleetSchedules(userId: string) {
  const schedules = await prisma.chatSchedule.findMany({
    where: { userId },
    orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }],
    take: 200,
  });
  const sessionIds = [...new Set(schedules.map((s) => s.sessionId))];
  const chats = sessionIds.length
    ? await prisma.crossModelChat.findMany({ where: { id: { in: sessionIds } }, select: { id: true, title: true } })
    : [];
  const titleByChatId = new Map(chats.map((c) => [c.id, c.title]));
  return {
    schedules: schedules.map((s) => ({
      id: s.id,
      chatId: s.sessionId,
      chatTitle: titleByChatId.get(s.sessionId) ?? null, // null = chat deleted (row lingers until GC)
      kind: s.kind,
      intervalSec: s.intervalSec,
      nextRunAt: s.nextRunAt,
      lastFiredAt: s.lastFiredAt,
      lastStatus: s.lastStatus,
      runsCount: s.runsCount,
      maxRuns: s.maxRuns,
      expiresAt: s.expiresAt,
      enabled: s.enabled,
      promptSnippet: s.prompt.slice(0, 140),
      // Cap-burn projection (ticket 2694a581): firings/day if every tick fires — the tab flags rows whose cadence alone eats the chat's daily cap.
      projectedDailyFirings: projectedDailyFiringsFor(s.kind, s.intervalSec),
      // Clock drift (ticket 903249e5): signed per-firing drift for a ≥12h
      // cadence that is not day-aligned (it marches around the clock) — the
      // tab flags it. Next-3 projection from the row's own nextRunAt.
      clockDriftMinutes: clockDriftMinutesFor(s.kind, s.intervalSec),
      projectedNextFirings: s.nextRunAt ? projectNextFirings(s.kind, s.intervalSec, s.nextRunAt, 3) : null,
    })),
  };
}

// ── Interactive thread ────────────────────────────────────────────────────────

const THREAD_SELECT = { id: true, role: true, content: true, metadata: true, createdAt: true } as const;

/** A backward-paging cursor: strictly (createdAt, id) < (at, id) when id is present. */
interface PageCursor {
  at: Date;
  id?: string;
}

/**
 * Prisma where-fragment for a PageCursor. The id tiebreak matches the
 * [createdAt desc, id desc] page order — an lt-only bound would silently skip
 * sibling rows persisted in the cursor row's exact millisecond (createdAt is
 * TIMESTAMP(3); machine wakes persist prompt+reply back-to-back). An id-less
 * cursor (legacy plain-ISO log cursor) degrades to the old strict-lt bound.
 */
function beforeBound(cursor: PageCursor | undefined) {
  if (!cursor) return {};
  if (!cursor.id) return { createdAt: { lt: cursor.at } };
  return {
    OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }],
  };
}

/**
 * One raw page of supervisor-chat messages, newest-first, with a hasMore flag
 * (the take+1 pattern). `before` bounds (createdAt, id) — cursor resolution
 * lives in the callers, which know the right error semantics.
 */
async function fetchRawMessages(chatId: string, before: PageCursor | undefined, take: number) {
  const rows = await prisma.crossModelMessage.findMany({
    where: { chatId, ...beforeBound(before) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: take + 1,
    select: THREAD_SELECT,
  });
  return { rows: rows.slice(0, take), hasMore: rows.length > take };
}

/** Resolve a thread `before` cursor (message id) to its (createdAt, id) bound. */
async function threadCursor(chatId: string, before: string): Promise<PageCursor> {
  const cursor = await prisma.crossModelMessage.findUnique({
    where: { id: before },
    select: { chatId: true, createdAt: true },
  });
  if (!cursor || cursor.chatId !== chatId) throw new AppError(400, 'Invalid before cursor for this chat');
  return { at: cursor.createdAt, id: before };
}

/**
 * This chat's CHILD chat ids (ticket 739e8191) — the lineage source for
 * child-session relay exemption in classifyThreadRows. `crossmodel_chats.
 * parentChatId` is the one lineage authority (pinned in the schema), and the
 * column is indexed, so this is ONE cheap lookup per thread read (never
 * per row). A failure degrades to "no lineage known" (today's behaviour) —
 * a preference for hiding noise must never break the thread.
 */
async function childChatIdsFor(chatId: string): Promise<Set<string>> {
  try {
    const kids = await prisma.crossModelChat.findMany({
      where: { parentChatId: chatId },
      select: { id: true },
    });
    return new Set(kids.map((k: { id: string }) => k.id));
  } catch (err: any) {
    // Degrade to "no lineage known" (pre-fix behaviour) — but NEVER silently:
    // a swallowed Prisma error (renamed column, dropped connection) would
    // disable the exemption permanently with no trace. Every neighbouring
    // best-effort path in this file logs the same way.
    logger.warn(`fleet: child-chat lineage lookup failed for ${chatId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
    return new Set();
  }
}

export interface FleetThreadPage {
  /** Null when no supervisor exists yet — a GET never provisions one. */
  chatId: string | null;
  running: boolean;
  queuedCount: number;
  /** USER-typed subset of queuedCount (F3, incident 2026-09-04) — drives the
   *  honest "answering your message next" Status card instead of "Idle". */
  queuedUserCount: number;
  messages: Array<{
    id: string; role: string; content: string; createdAt: string; origin: string;
    /** metadata.kind flattened for the client's grouping probe — currently
     *  only 'owner_briefing' (rows that must render as regular assistant
     *  bubbles, never folded into a machine-turn accordion). */
    kind?: string;
    /** metadata.childResult flattened (ticket 56d6b204): true on a wake user
     *  row delivered by the auto-wired child→parent result hook — the client's
     *  grouping probe reads it off the group's ANCHOR row to mount the machine
     *  turn EXPANDED with a "results" marker (a delivered sub-session result
     *  must not hide behind the collapsed accordion). */
    childResult?: boolean;
    /** metadata.ownerAskReply flattened (fixer 2026-09-27, finding
     *  upward-chatter-1): true on the wake user row of an [OWNER ASK
     *  UNANSWERED] re-wake / [FOLLOW-THROUGH] nudge and on its answering
     *  assistant row — the client's grouping probe reads it off the ANCHOR row
     *  to mount the machine turn EXPANDED with an "answer" marker (the owner
     *  asked; the reply must not fold behind the collapsed accordion). */
    ownerAskReply?: boolean;
    /** Attachment chips stamped at send time (filename + type only). */
    attachments?: Array<{ filename: string; type: string }>;
  }>;
  hasMore: boolean;
  nextBefore?: string;
}

/**
 * GET /fleet/supervisor/thread — the INTERACTIVE view of the supervisor chat:
 * machine noise (schedule wakes, agent messages, retro-classified legacy wakes,
 * and their assistant replies) filtered out. Pages BACKWARD from the newest
 * interactive message; messages within a page are chronological.
 *
 * HONEST READ: a GET never provisions. When no supervisor exists (fresh
 * account, or the owner deleted theirs) this returns an EMPTY thread shape —
 * provisioning stays on the send path and POST /supervisor/ensure.
 *
 * Correctness: filtering AFTER pagination would break cursors (a page of pure
 * noise would look like the end of the thread), so this OVER-FETCHES raw pages
 * (each `limit` rows) until `limit` interactive rows are collected or the
 * transcript is exhausted. The cheap budget is 5 pages; past it the scan
 * continues ONLY while the window is still ALL noise — an all-noise first page
 * returns `messages: []` with hasMore:true, which the client rendered as a
 * fake empty thread ("i see no messages", owner report 2026-08-15). The hard
 * cap (40 pages ≈ 2000 raw rows at limit 50, i.e. days of machine traffic)
 * makes an empty page effectively unreachable while interactive rows exist.
 * hasMore is true when interactive rows were dropped from the window OR raw
 * rows remain unfetched.
 */

/**
 * The supervisor's LATEST machine wake note (platform task 2026-09-03 — the
 * dashboard Fleet-summary card): the durable transcript's newest assistant
 * row classified as machine noise by the SAME retro-classifier the thread
 * endpoint uses — the single source of truth, so the card renders exactly
 * what the chat shows (never a second summarizer/model pass that could
 * diverge). Pages backward from the newest row; the first (newest)
 * non-empty SUBSTANTIVE machine assistant note wins — one-line no-op notes
 * (see isNoopWakeNote, feedback f3256715) are skipped so the card never goes
 * permanently content-empty; an all-no-op window still returns the newest
 * no-op rather than nothing. HONEST READ: never provisions —
 * no supervisor → { chatId: null, note: null }.
 *
 * Known edge: a note whose wake user-row fell on the OLDER page can't
 * inherit noise inside its own page and is skipped — the scan simply finds
 * the previous note instead (modern rows carry their own origin stamps, so
 * this is the legacy-rows-only case).
 */
/**
 * No-op wake notes (owner-directed 2026-09-03: the supervisor writes ONE-LINE
 * no-op notes for routine wakes) must not occupy the dashboard Fleet-summary
 * slot — with only no-op notes landing, the card went permanently
 * content-empty (feedback f3256715).
 * Classifier: the note is a single line (the owner-directed no-op shape) AND
 * carries an explicit no-op marker. Multi-line notes are ALWAYS substantive —
 * a real summary's headline may legitimately mention "no-ops" (e.g.
 * "2 lane completions, both no-ops"), so a marker-only match would
 * false-positive on exactly the notes the card exists to surface.
 */
export function isNoopWakeNote(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0 || trimmed.includes('\n')) return false;
  return /\bno[\s-]?ops?\b/i.test(trimmed);
}

/**
 * A verifier-struck wake note: the action verifier REPLACED or ANNOTATED the
 * delivered content, so it leads with a guard banner ('[ACTION VERIFIER —' /
 * '[HARNESS EVIDENCE GUARD —'). Owner bug 2026-09-04: the dashboard Fleet
 * summary picked one of these — the parsed "headline" was the verifier's
 * conviction explanation and the chips were its struck-citation detail lines
 * (incl. the ⛔ removed-line marker). A struck note is guard chrome around a
 * dubious note, never a fleet summary.
 */
export function isVerifierStruckNote(content: string): boolean {
  const lead = (content || '').trimStart();
  return lead.startsWith('[ACTION VERIFIER —') || lead.startsWith('[HARNESS EVIDENCE GUARD —');
}

/** How recent an owner briefing must be to headline the dashboard card, and
 *  how recent a wake note must be to seed the bootstrap generation. */
const BRIEFING_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One dashboard-card note: kind 'briefing' = plain-English owner briefing
 *  (owner-briefing.service rows), 'wake' = the technical machine wake note. */
export interface FleetSummaryNote {
  id: string;
  createdAt: string;
  content: string;
  kind: 'briefing' | 'wake';
}

export async function getLatestSupervisorWakeNote(
  userId: string,
): Promise<{ chatId: string | null; note: FleetSummaryNote | null }> {
  const chatId = await supervisorChatIdFor(userId);
  if (!chatId) return { chatId: null, note: null };
  const schedules = await prisma.chatSchedule.findMany({
    where: { sessionId: chatId },
    select: { prompt: true },
  });
  const schedulePrompts = new Set(schedules.map((s) => s.prompt));
  let cursor: PageCursor | undefined;
  // Bounded backward scan: the hourly cadence puts the latest note in the
  // first page in practice; the cap bounds pathological all-chrome stretches.
  let noopFallback: FleetSummaryNote | null = null;
  let struckFallback: FleetSummaryNote | null = null;
  let wakeNote: FleetSummaryNote | null = null;
  const freshFloor = Date.now() - BRIEFING_FRESH_WINDOW_MS;
  scan: for (let page = 0; page < 10; page++) {
    const { rows, hasMore } = await fetchRawMessages(chatId, cursor, 50);
    if (rows.length === 0) break;
    // Rows arrive newest-first; classify chronologically (assistant noise
    // inheritance flows from the nearest PRECEDING user row).
    const classified = classifyThreadRows([...rows].reverse(), schedulePrompts);
    for (let i = classified.length - 1; i >= 0; i--) {
      const r = classified[i];
      if (r.role !== 'assistant' || (r.content || '').trim().length === 0) continue;
      const fresh = r.createdAt.getTime() >= freshFloor;
      // Owner briefing (owner 2026-09-04): the plain-English layer WINS over
      // every wake note — even a newer one — while it is <24h old. Newest-first
      // scan ⇒ the first fresh briefing met is the newest briefing.
      if (rowKind(r.metadata) === OWNER_BRIEFING_KIND) {
        if (fresh) {
          return {
            chatId,
            note: { id: r.id, createdAt: r.createdAt.toISOString(), content: r.content, kind: 'briefing' },
          };
        }
        continue; // a stale briefing never outranks newer wake notes
      }
      if (!r.noise) continue;
      const note: FleetSummaryNote = { id: r.id, createdAt: r.createdAt.toISOString(), content: r.content, kind: 'wake' };
      if (isVerifierStruckNote(r.content)) {
        // Guard-struck note (owner bug 2026-09-04): hold the NEWEST one as
        // the last-resort fallback and keep scanning for a clean note — the
        // summary card must never headline verifier chrome when a clean
        // sweep exists in the window.
        if (!struckFallback) struckFallback = note;
        continue;
      }
      if (isNoopWakeNote(r.content)) {
        // Newest-first scan: the first no-op note met is the NEWEST one —
        // hold it as the degenerate fallback and keep scanning for the last
        // SUBSTANTIVE note (feedback f3256715).
        if (!noopFallback) noopFallback = note;
        continue;
      }
      if (!wakeNote) wakeNote = note;
      // Holding the newest substantive note AND the scan has crossed the
      // briefing-freshness horizon (every remaining row is older) → nothing
      // left can outrank it. Stop.
      if (!fresh) break scan;
    }
    if (!hasMore) break;
    const last = rows[rows.length - 1];
    cursor = { at: last.createdAt, id: last.id };
    // Same horizon check across pages: the next page is entirely older.
    if (wakeNote && last.createdAt.getTime() < freshFloor) break;
  }
  // Degenerate fallbacks, most-truthful first: a quiet one-liner ("all idle")
  // is honest fleet state; a struck note is only shown when NOTHING else
  // exists in the window (the frontend parser strips its chrome lines).
  const note = wakeNote ?? noopFallback ?? struckFallback;
  // BOOTSTRAP (owner 2026-09-04, instant owner value): no briefing exists in
  // the 24h window but a CLEAN (non-struck) wake note does, and it is itself
  // fresh — fire-and-forget generate a briefing from it (the generator's own
  // Redis NX lock caps this at one attempt per ~90min across every poll and
  // instance) and return the technical fallback for THIS request; the
  // dashboard's next poll picks the briefing up.
  if (
    note &&
    note !== struckFallback &&
    Date.parse(note.createdAt) >= freshFloor
  ) {
    void generateOwnerBriefing({ chatId, userId, noteContent: note.content, sourceNoteId: note.id })
      .catch((err: any) => logger.warn(`fleet: bootstrap owner-briefing failed (non-fatal): ${err?.message ?? err}`));
  }
  return { chatId, note };
}

export async function getSupervisorThread(
  userId: string,
  opts: { before?: string; limit?: number; includeMachine?: boolean },
): Promise<FleetThreadPage> {
  const chatId = await supervisorChatIdFor(userId);
  if (!chatId) {
    return { chatId: null, running: false, queuedCount: 0, queuedUserCount: 0, messages: [], hasMore: false };
  }  // Opt-in escape hatch (feedback 18061f31): the pane's noise filter hides
  // machine-triggered wake prompts + their replies — the exact turns the owner
  // wants to skim after a background run. Default stays filtered (the API
  // contract other consumers rely on); includeMachine returns the full
  // transcript with origin stamps so the client can label machine turns.
  const includeMachine = opts.includeMachine === true;
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const before = opts.before ? await threadCursor(chatId, opts.before) : undefined;

  // Retro-classifier source: this chat's schedule prompts, fetched once.
  const schedules = await prisma.chatSchedule.findMany({
    where: { sessionId: chatId },
    select: { prompt: true },
  });
  const schedulePrompts = new Set(schedules.map((s) => s.prompt));

  // Child-session relays (ticket 739e8191): the parent's reply to a sub-session
  // that finished and reported back is how the owner learns the work is done.
  // ONE indexed lineage lookup per read — never per row — threaded into every
  // classify pass below so the page scan and the final classification agree
  // (they must: the scan counts interactive rows to decide how far to page).
  const childIds = await childChatIdsFor(chatId);

  // Over-fetch raw pages until we hold enough INTERACTIVE rows (bounded).
  const RAW_PAGE_BUDGET = 5; // the cheap scan every request pays for
  const RAW_PAGE_HARD_CAP = 40; // all-noise windows keep scanning to this cap
  const raw: RawThreadRow[] = [];
  let rawHasMore = true;
  let cursor = before;
  let oldestRawId: string | undefined; // oldest raw row examined (the raw cursor)
  for (let page = 0; page < RAW_PAGE_HARD_CAP; page++) {
    const { rows, hasMore } = await fetchRawMessages(chatId, cursor, limit);
    raw.push(...rows);
    rawHasMore = hasMore;
    if (rows.length > 0) oldestRawId = rows[rows.length - 1].id;
    if (!hasMore || rows.length === 0) break;
    const last = rows[rows.length - 1];
    cursor = { at: last.createdAt, id: last.id };
    // Cheap early exit: enough raw rows that the interactive subset could fill the page.
    // (includeMachine keeps everything, so the raw count IS the kept count.)
    const interactiveSoFar = includeMachine
      ? raw.length
      : classifyThreadRows([...raw].reverse(), schedulePrompts, childIds).filter((r) => !r.noise).length;
    if (interactiveSoFar >= limit) break;
    // Past the cheap budget, only an ALL-NOISE window justifies scanning on —
    // an empty page renders as a fake empty thread, so reach the interactive
    // rows behind the noise whenever they exist.
    if (interactiveSoFar > 0 && page + 1 >= RAW_PAGE_BUDGET) break;
  }

  // Classify chronologically (oldest → newest) so assistant inheritance works.
  const classified = classifyThreadRows([...raw].reverse(), schedulePrompts, childIds);
  const interactive = includeMachine ? classified : classified.filter((r) => !r.noise);
  const pageRows = interactive.slice(-limit); // newest `limit`, chronological
  const hasMore = interactive.length > limit || rawHasMore;

  // nextBefore accompanies EVERY hasMore — including an all-noise page (0
  // interactive rows): without a usable cursor the client's "Load earlier"
  // renders but can never fire. Fall back to the oldest RAW row examined; the
  // next request resolves its createdAt exactly like the loop cursor above
  // (the re-fetched noise simply re-filters — idempotent).
  const nextBefore = pageRows.length > 0 ? pageRows[0].id : oldestRawId;

  // Inline image attachments (ticket c6e8edda): chips stamped with an
  // uploadId gain fileId + mimeType from the durable ChatFile rows so the
  // supervisor thread can render images inline — the same ONE batched lookup
  // getChatById pays (chip-less threads cost zero queries). Runs on the page
  // slice only — never on the over-fetched raw window.
  const pageRowsWithFiles = await import('../chat-files.service')
    .then((m) => m.injectChatFileIds(chatId, pageRows))
    .catch(() => pageRows);

  const [queuedCount, queuedUserCount] = await Promise.all([getQueuedCount(chatId), getQueuedUserCount(chatId)]);
  return {
    chatId,
    running: await isChatBusy(chatId),
    queuedCount,
    // F3 (owner incident 2026-09-04): the USER-typed subset of the queue, so
    // the Status card can say "answering your message next" instead of the
    // dishonest "Idle — waiting for your next message" while a send waits.
    queuedUserCount,
    messages: pageRowsWithFiles.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      origin: m.origin,
      // Owner briefings carry their kind so the client grouping probe can
      // exempt them from the machine-turn accordions (owner 2026-09-04). The
      // owner-armed scheduled digest ANSWER (ticket 77c3a7e9) rides the same
      // channel — the probe's isOwnerDigest keys on it.
      ...(rowKind(m.metadata) === OWNER_BRIEFING_KIND ? { kind: OWNER_BRIEFING_KIND } : {}),
      ...(rowKind(m.metadata) === OWNER_DIGEST_KIND ? { kind: OWNER_DIGEST_KIND } : {}),
      // Child-result wake marker (ticket 56d6b204): flattened for the client's
      // grouping probe — a child→parent result-hook wake mounts EXPANDED so
      // the delivered sub-session result never hides behind the accordion.
      //
      // Child-SESSION relay (ticket 739e8191, owner report 2026-11-02): the
      // far more common shape is a lane that finishes and REPORTS BACK through
      // send_chat_message — an [AGENT-SENT MESSAGE] row from a child chat. It
      // carries no childResult stamp (the result HOOK does), so it used to
      // flatten as nothing and the client folded the sub-session's result and
      // its answering reply behind the collapsed accordion. Lineage decides:
      // a relay whose SENDER is this chat's child is delivered content, and it
      // rides the SAME marker every consumer already understands.
      ...(rowChildResult(m.metadata) || isChildRelayRow(m, childIds) ? { childResult: true } : {}),
      // Owner-ask wake marker (fixer 2026-09-27): flattened for the client's
      // grouping probe — the answer to an owner ask mounts EXPANDED.
      ...((m.metadata as Record<string, unknown> | null)?.ownerAskReply === true ? { ownerAskReply: true } : {}),
      // Attachment chips stamped at send time (chat-agent attachmentMeta) —
      // filename + type only, never blob content.
      ...(attachmentsSummary(m.metadata) ? { attachments: attachmentsSummary(m.metadata) } : {}),
    })),
    hasMore,
    ...(hasMore && nextBefore ? { nextBefore } : {}),
  };
}

// ── Send with queue ───────────────────────────────────────────────────────────

/**
 * Queue depth for one chat — main's busy-chat queue: a row is queued until
 * the active run's finally drains it (chat-agent.service drainChatQueue).
 */
export async function getQueuedCount(chatId: string): Promise<number> {
  const { countPending } = await import('../chat-agent/message-queue.service');
  return countPending(chatId);
}

/** USER-typed subset of the queue (F3 — "your message is queued" must count
 *  the owner's own sends, not machine relay traffic sharing the queue). */
export async function getQueuedUserCount(chatId: string): Promise<number> {
  const { countPendingUser } = await import('../chat-agent/message-queue.service');
  return countPendingUser(chatId);
}

/**
 * POST /fleet/supervisor/messages — send to the supervisor chat. A busy chat
 * no longer fails the user with 409: the message lands in the durable FIFO
 * queue (pending_chat_messages) and is drained when the chat goes idle. The
 * supervisor is a PLAIN chat, and main's platform.sendChatMessage already
 * runs exactly that busy→enqueue / idle→start flow for plain chats (the
 * active run's finally drains the queue automatically), so this delegates and
 * maps the result onto the Management contract:
 *   - position present → enqueued behind a busy run → { queued: true, position }
 *   - otherwise        → a detached run started now → { queued: false }
 * The defensive 409→enqueue fallback covers a hypothetical coding-surface
 * supervisor (its busy path still 409s); a FULL queue's 409 propagates.
 */
export async function sendSupervisorMessage(userId: string, content: string, uploadIds?: string[]) {
  const { chatId } = await requireSupervisor(userId);
  const text = String(content || '').trim();
  if (!text) throw new AppError(400, 'content is required');

  // Attachments: resolve the staged /crossmodel/upload blobs (Redis, 15-min
  // TTL) and merge them EXACTLY like the plain-chat SSE path
  // (combineAttachments), then map onto agent inputs (images → userImages,
  // doc/PDF text → documentText). Ticket 1aefc929: NEVER silently deliver
  // text-only — EVERY staged blob gone → hard 410 (same ethos as the busy-409:
  // this surface refuses to silently drop files); SOME gone → the message
  // carries the honest drop annotation (queued-drain idiom).
  let agentAttachments: AgentAttachment | undefined;
  let attachmentMeta: Array<{ filename: string; type: string; uploadId?: string }> | undefined;
  let loadedUploads: Array<{ id: string; attachment: Attachment }> = [];
  let contentText = text;
  if (uploadIds?.length) {
    const { loadAttachment, combineAttachments } = await import('../upload.controller');
    const { mapAttachmentForAgent } = await import('../chat-agent/chat-gate');
    const resolution = await resolveStagedUploads(uploadIds, loadAttachment);
    if (resolution.fatalMessage) throw new AppError(410, resolution.fatalMessage);
    loadedUploads = resolution.loaded;
    if (resolution.droppedCount > 0) {
      contentText = `${text}\n\n${attachmentDropAnnotation(resolution.droppedCount)}`;
    }
    // Chips carry the staged uploadId (ticket c6e8edda) — the read-time
    // fileId injection joins it against the durable ChatFile row so image
    // chips render inline in the transcript.
    attachmentMeta = loadedUploads.map((l) => ({ filename: l.attachment.filename, type: l.attachment.type, uploadId: l.id }));
    const mapped = mapAttachmentForAgent(combineAttachments(loadedUploads.map((l) => l.attachment)));
    if (mapped.userImages?.length || mapped.documentText) agentAttachments = mapped;
  }
  // Persistent chat files (2026-08-25): durably persist the consumed uploads
  // once the send is ACCEPTED (started, queued, or the 409 fallback enqueue).
  // Fire-and-forget + idempotent per (uploadId, chatId) — the queue drain's
  // own persist of the same staged ids is a no-op.
  const persistLoadedUploads = () => {
    if (!loadedUploads.length) return;
    void import('../chat-files.service')
      .then((m) => m.persistChatUploads({ chatId, userId, loaded: loadedUploads }))
      .catch(() => {});
  };

  const platformService = await import('../platform/platform.service');
  // DW-5 measure-first (FO firing 68): stamp supervisor_send_timing rows for
  // this send. (RSW-1 2026-10-30: the SUPERVISOR_SEND_TIMING_DISABLED kill
  // switch was deleted — NF_INERT, never forwarded by compose, so prod only
  // ever ran the stamping branch.)
  const timingStart = Date.now();
  try {
    const result: any = await platformService.sendChatMessage({
      userId, chatId, content: contentText,
      userTurnAt: new Date(), // a REAL user turn (Management UI) — the run's confirmation anchor
      origin: { kind: 'user' },
      timingSurface: 'fleet',
      ...(agentAttachments ? { agentAttachments } : {}),
      ...(attachmentMeta?.length ? { attachmentMeta } : {}),
      // Queued attachments (ac65d51e): if this send queues (busy chat), the
      // staged ids persist on the pending row and the drain re-resolves them.
      ...(uploadIds?.length ? { queueUploadIds: uploadIds } : {}),
    });
    persistLoadedUploads();
    if (typeof result?.position === 'number') {
      logger.info(`fleet: queued message for busy supervisor chat ${chatId} (position ${result.position})`);
      return { queued: true, position: result.position };
    }
    return { queued: false };
  } catch (err: any) {
    if (!(err instanceof AppError && err.statusCode === 409)) throw err;
    // Queued attachments (ac65d51e): the staged ids ride the fallback enqueue
    // too — the drain resolves them exactly like an immediate send.
    const { enqueueChatMessage } = await import('../chat-agent/message-queue.service');
    const { position } = await enqueueChatMessage({
      chatId, userId, content: contentText, source: 'user',
      ...(uploadIds?.length ? { uploadIds } : {}),
    });
    persistLoadedUploads();
    logger.info(`fleet: queued message for busy supervisor chat ${chatId} (position ${position}, 409 fallback)`);
    {
      const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('../platform/loop-metrics.service');
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.SUPERVISOR_SEND_TIMING,
        sessionId: chatId,
        value: Date.now() - timingStart,
        unit: 'ms',
        meta: { surface: 'fleet', outcome: 'queued_409', note: 'platform send refused 409 — the fleet fallback enqueued directly' },
      });
    }
    return { queued: true, position };
  }
}

// ── Raw log ───────────────────────────────────────────────────────────────────

export interface FleetLogRow {
  at: string;
  kind: 'user_message' | 'machine_wake' | 'agent_message' | 'supervisor_reply';
  from: string;
  to: string;
  summary: string;
  chatId?: string;
  /** Message id (transcript rows) or Activity id — dedupe key for the client. */
  sourceId: string;
}

/** The log cursor wire format: '<ISO>|<sourceId>' (legacy plain-ISO accepted — no tiebreak). */
function parseLogCursor(before: string): PageCursor {
  const sep = before.indexOf('|');
  const atRaw = sep === -1 ? before : before.slice(0, sep);
  const id = sep === -1 ? '' : before.slice(sep + 1);
  const t = new Date(atRaw);
  if (Number.isNaN(t.getTime())) throw new AppError(400, 'Invalid before cursor — expected an ISO timestamp');
  return { at: t, ...(id ? { id } : {}) };
}

/** (at, id) ordering key of a merged log row — id is the sourceId (uuid in both sources). */
interface LogPoint {
  at: string;
  id: string;
}

/** Compare two log points: negative when a is OLDER than b (ISO strings compare chronologically). */
function cmpLogPoint(a: LogPoint, b: LogPoint): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const logPointOf = (r: FleetLogRow): LogPoint => ({ at: r.at, id: r.sourceId });
const logCursorOf = (p: LogPoint): string => `${p.at}|${p.id}`;

/**
 * GET /fleet/log — the merged RAW log, newest-first: the supervisor transcript
 * (noise included) + agent-originated Activity rows (chat.message audits with
 * metadata.origin='agent' — incl. agent traffic to OTHER chats). `before` is
 * the previous page's nextBefore ('<ISO>|<sourceId>'; a legacy plain ISO
 * timestamp still parses, without the tie-safe id bound).
 *
 * Merge strategy: each source is queried with (createdAt, id) < before (take
 * limit), merge-sorted desc with the sourceId tiebreak, then cut at the SAFE
 * BOUNDARY — the newest not-fully-scanned point among sources that still have
 * rows — so a row from one source is never emitted past unscanned rows of the
 * other. hasMore when either source has unscanned rows or the merge overflowed
 * the limit, and nextBefore then ALWAYS accompanies it (the thread endpoint's
 * invariant): the activities scan is agent-filtered in JS, so a page of pure
 * user-origin audits would otherwise return hasMore with no kept rows and
 * dead-end the client's "Load more" forever.
 */
export async function getFleetLog(userId: string, opts: { before?: string; limit?: number }) {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50));
  const before = opts.before ? parseLogCursor(opts.before) : undefined;

  // from/to labels resolve through the user's chat titles (the overview builds
  // the same map) — raw UUIDs are unreadable in the Raw Log.
  const chats = await prisma.crossModelChat.findMany({
    where: { userId },
    select: { id: true, title: true },
  });
  const titleByChatId = new Map(chats.map((c) => [c.id, c.title]));

  // ── Source 1: the supervisor transcript (skipped when none configured). ──
  const transcriptRows: FleetLogRow[] = [];
  let transcriptHasMore = false;
  let transcriptFloor: LogPoint | null = null; // oldest SCANNED transcript row
  const chatId = await supervisorChatIdFor(userId);
  const supervisor = chatId ? await supervisorViewFor(userId, chatId) : null;
  if (chatId && supervisor) {
    const schedules = await prisma.chatSchedule.findMany({
      where: { sessionId: chatId },
      select: { prompt: true },
    });
    const schedulePrompts = new Set(schedules.map((s) => s.prompt));
    const { rows: transcript, hasMore } = await fetchRawMessages(chatId, before, limit);
    transcriptHasMore = hasMore;
    if (transcript.length > 0) {
      const oldest = transcript[transcript.length - 1];
      transcriptFloor = { at: oldest.createdAt.toISOString(), id: oldest.id };
    }
    for (const m of transcript) {
      transcriptRows.push({ ...classifyLogRow(m, schedulePrompts, supervisor.title, titleByChatId), chatId });
    }
  }

  // ── Source 2: agent-originated Activity audit rows (any target chat). ──
  const activities = await prisma.activity.findMany({
    where: {
      userId,
      resource: 'platform',
      action: 'chat.message',
      ...beforeBound(before),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  const activityHasMore = activities.length >= limit;
  const oldestActivity = activities[activities.length - 1];
  const activityFloor: LogPoint | null = oldestActivity
    ? { at: oldestActivity.createdAt.toISOString(), id: oldestActivity.id }
    : null;
  const activityRows: FleetLogRow[] = [];
  for (const a of activities) {
    const meta = (a.metadata && typeof a.metadata === 'object' ? a.metadata : {}) as Record<string, unknown>;
    if (meta.origin !== 'agent') continue; // only agent traffic (user sends are in the transcript)
    const targetChatId = typeof meta.chatId === 'string' ? meta.chatId : '?';
    // Dedupe: an agent send TO the supervisor also persisted a transcript row
    // (metadata.origin='agent') that source 1 renders — the transcript is the
    // canonical record, so drop the Activity twin whenever source 1 is live.
    if (supervisor && targetChatId === chatId) continue;
    const sourceChatId = typeof meta.sourceChatId === 'string' ? meta.sourceChatId : '?';
    activityRows.push({
      at: a.createdAt.toISOString(),
      kind: 'agent_message',
      from: `Agent (${titleByChatId.get(sourceChatId) ?? sourceChatId})`,
      to: titleByChatId.get(targetChatId) ?? `Chat ${targetChatId}`,
      summary: typeof meta.contentSnippet === 'string' ? meta.contentSnippet : '',
      ...(targetChatId !== '?' ? { chatId: targetChatId } : {}),
      sourceId: a.id,
    });
  }

  // ── Merge with a safe emit boundary. ──
  const candidates = [...transcriptRows, ...activityRows].sort(
    (a, b) => -cmpLogPoint(logPointOf(a), logPointOf(b)), // newest first
  );
  // Rows older than a still-has-more source's scan floor cannot be emitted yet
  // (that source may hold unscanned rows above them) — cut at the NEWEST such
  // floor. Floor rows themselves were scanned, so resuming strictly below the
  // boundary never skips anything.
  const floors: LogPoint[] = [];
  if (transcriptHasMore && transcriptFloor) floors.push(transcriptFloor);
  if (activityHasMore && activityFloor) floors.push(activityFloor);
  const boundary = floors.length > 0
    ? floors.reduce((a, b) => (cmpLogPoint(a, b) >= 0 ? a : b))
    : null;
  const emittable = boundary
    ? candidates.filter((r) => cmpLogPoint(logPointOf(r), boundary) >= 0)
    : candidates;
  const pageRows = emittable.slice(0, limit);
  const hasMore = transcriptHasMore || activityHasMore || emittable.length > limit;

  // nextBefore accompanies EVERY hasMore: a filled page resumes below its last
  // row; a short page resumes at the boundary (everything newer was emitted,
  // and the boundary row itself was already scanned — an all-filtered
  // activities page thus still hands the client a cursor that makes progress).
  const nextBefore =
    pageRows.length >= limit
      ? logCursorOf(logPointOf(pageRows[pageRows.length - 1]))
      : boundary
        ? logCursorOf(boundary)
        : pageRows.length > 0
          ? logCursorOf(logPointOf(pageRows[pageRows.length - 1]))
          : undefined;
  return {
    messages: pageRows,
    hasMore,
    ...(nextBefore ? { nextBefore } : {}),
  };
}

/** Classify one transcript row for the raw log (retro-classifier included). */
function classifyLogRow(
  m: RawThreadRow,
  schedulePrompts: Set<string>,
  supervisorTitle: string,
  titleByChatId: ReadonlyMap<string, string>,
): Omit<FleetLogRow, 'chatId'> {
  const base = { at: m.createdAt.toISOString(), summary: m.content.slice(0, 200), sourceId: m.id };
  if (m.role === 'assistant') {
    return { ...base, kind: 'supervisor_reply', from: supervisorTitle, to: 'You' };
  }
  const origin = rowOrigin(m.metadata);
  if (origin === 'agent') {
    const sourceChatId = rowSourceChatId(m.metadata);
    const sourceLabel = sourceChatId ? titleByChatId.get(sourceChatId) ?? sourceChatId : 'unknown';
    return { ...base, kind: 'agent_message', from: `Agent (${sourceLabel})`, to: supervisorTitle };
  }
  if ((origin != null && MACHINE_ORIGINS.has(origin)) || (origin == null && schedulePrompts.has(m.content))) {
    return { ...base, kind: 'machine_wake', from: 'Scheduler', to: supervisorTitle };
  }
  return { ...base, kind: 'user_message', from: 'You', to: supervisorTitle };
}

// ── Project digests (READ-ONLY projection of the hourly cron's rows) ──────────

export interface FleetDigestRow {
  projectId: string | null;
  /** null-project bucket → 'Ungrouped'. */
  projectName: string;
  status: string; // blocked | needs_attention | on_track | idle
  summary: string;
  attentionItems: unknown; // DigestAttentionItem[] + key/acknowledged projection (below)
  stats: unknown;          // DigestStats
  /** Project Pulse (owner 2026-09-04): DigestGoalProgress[] — per-goal counts +
   *  computed honest ETA, written by the hourly sweep. [] on legacy rows. */
  goalProgress: unknown;
  /** DigestEtaSummary | null — the project-level ETA rollup (null = no goals). */
  etaSummary: unknown;
  /** Program-truth reader (P7 G16): the project's .digby/rules/00-current-state.md
   *  (bounded 4k) as read from the bare mirror's default branch at digest build;
   *  null = no mirror / no file / legacy row. */
  programState: string | null;
  /**
   * When the summary TEXT was actually written (stats.generatedAt, stamped by
   * the sweep on every content rewrite; the signature-skip touch never moves
   * it). Legacy rows without the stamp fall back to updatedAt.
   */
  generatedAt: string;
  /** The row's updatedAt — every sweep touches it, so this feeds the stale badge. */
  updatedAt: string;
}

/** Severity sort: blocked first, then needs_attention, on_track, idle. */
const DIGEST_SEVERITY: Record<string, number> = {
  blocked: 0,
  needs_attention: 1,
  on_track: 2,
  idle: 3,
};

/** The stored attention-item fields the ack key reads (JSON projection — all optional). */
export interface DigestAttentionKeyInput {
  kind?: unknown;
  title?: unknown;
  goalId?: unknown;
  todoId?: unknown;
  chatId?: unknown;
  /** Accepted but deliberately NOT keyed on (see digestAttentionItemKey). */
  runId?: unknown;
  /** Keyed on for schedule-scoped kinds — durable across fires (2026-08-16). */
  scheduleId?: unknown;
}

/**
 * Alertmanager-silence key for ONE digest attention item — "{kind}:{ref}" where
 * ref is the first available of todoId → goalId → chatId → title. STABILITY is
 * the whole contract: the hourly digest sweep overwrites attentionItems, so the
 * key must survive regeneration while the underlying condition persists:
 *  - blocked_todo keys on the TODO (its goalId is a backlink — the todo is the
 *    thing that is blocked), blocked_goal on the goal;
 *  - schedule-scoped kinds key on the SCHEDULE row (scheduleId is durable
 *    across fires, unlike runId): keying them on the chat collided two
 *    schedules on one chat under a single `schedule_error:<chatId>` key, so
 *    acking schedule A's error silenced schedule B's future unrelated one
 *    (review 2026-08-16). Pre-existing chat-keyed schedule acks lapse once —
 *    the item resurfaces and a re-ack mints the durable key;
 *  - the remaining chatId kinds (awaiting_input, failed_run, session_error,
 *    stalled_session, stuck_message) key on the CHAT — runId is deliberately
 *    NOT used: a fresh run row each hour would mint a new key and silently
 *    defeat the ack;
 *  - the human title is the last-resort fallback (stable while the condition's
 *    label is).
 */
export function digestAttentionItemKey(item: DigestAttentionKeyInput): string {
  const kind = typeof item.kind === 'string' && item.kind ? item.kind : 'unknown';
  const ref = [item.todoId, item.goalId, item.scheduleId, item.chatId, item.title].find(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  return `${kind}:${ref ?? ''}`;
}

/** One row of the digest_item_acks table, as loaded for the ack projection. */
interface DigestItemAckRow {
  itemKey: string;
  snoozeUntil: Date | string | null;
}

/**
 * Attach `key` to every object item and split acked from live items.
 * An item is ACKED when an ack row exists AND (snoozeUntil == null OR the
 * snooze has not lapsed) — an EXPIRED snooze resurfaces the item (the stale row
 * is left for the hourly sweep's 30-day prune). showAcked=false drops acked
 * items; showAcked=true keeps them flagged `acknowledged: true` (+ snoozeUntil
 * when set). Live items get NO acknowledged flag (a tidy JSON shape).
 */
function projectAttentionItems(items: unknown, activeAcks: Map<string, Date | null>, showAcked: boolean): unknown[] {
  if (!Array.isArray(items)) return [];
  const out: Record<string, unknown>[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const key = digestAttentionItemKey(item);
    const ack = activeAcks.get(key); // undefined = no ACTIVE ack row
    if (ack === undefined) {
      out.push({ ...item, key });
    } else if (showAcked) {
      out.push({
        ...item,
        key,
        acknowledged: true,
        ...(ack ? { snoozeUntil: ack.toISOString() } : {}),
      });
    }
  }
  return out;
}

/**
 * GET /fleet/digests — the stored hourly per-project digests for the owner,
 * sorted by severity (most urgent first; most-recent first within a severity).
 * READ ONLY: this NEVER computes a digest or calls the LLM — rows are written
 * by the worker's hourly `project-digest` cron (fleet/project-digest.service.ts).
 * Hidden fleet artifacts (the Fleet HQ folder) are excluded; supervisor chats
 * never have digest rows by construction (the sweep buckets them out).
 *
 * Ack projection: the caller's digest_item_acks silences are applied HERE (not
 * in the cron) so an ack survives the hourly attentionItems overwrite. By
 * default acked items are EXCLUDED; opts.showAcked includes them flagged.
 */
export async function getProjectDigests(
  userId: string,
  opts: { showAcked?: boolean } = {},
): Promise<{ digests: FleetDigestRow[] }> {
  const [rows, directProjects, hidden, acks] = await Promise.all([
    prisma.projectDigest.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.crossModelProject.findMany({
      // Owned ∪ member-of (reviewer B1, PR #484): the sweep buckets the user's
      // CHATS by projectId, and a chat can be filed in a project shared with
      // the user (moveChat does not require ownership) — digest rows for
      // member projects are legitimate and must keep their real names.
      where: { OR: [{ userId }, { members: { some: { userId } } }] },
      select: { id: true, name: true, path: true, archivedAt: true },
    }),
    getSidebarHiddenFleetArtifacts(userId),
    prisma.digestItemAck.findMany({ where: { userId } }),
  ]);
  // Ancestor inheritance (reviewer B1-residual, getProjectAccess semantics —
  // platform.service.ts:106-129 grants 'owner'/inherited rank via OWNED or
  // MEMBER ancestors, flag default-on): a chat can be filed in a subfolder the
  // user reaches only through an ancestor, so that subfolder's digest rows are
  // legitimate too. Resolve descendants of every owned/member folder via the
  // materialized path prefixes (path = '/rootId/.../id'; a descendant's path
  // starts with the ancestor's path + '/' — the trailing slash prevents
  // sibling-id prefix collisions). Only a project invisible through EVERY leg
  // (deleted / access revoked) is an orphan.
  const directPaths = directProjects.map((p: any) => p.path || `/${p.id}`);
  const inheritedProjects = directPaths.length > 0
    ? await prisma.crossModelProject.findMany({
        where: { OR: directPaths.map((pre: string) => ({ path: { startsWith: `${pre}/` } })) },
        select: { id: true, name: true },
      })
    : [];
  const projects = [...directProjects, ...inheritedProjects];
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const hiddenProjects = new Set(hidden.projectIds);
  // Archived folders leave Project Pulse like hidden fleet artifacts do —
  // their subtrees ride along via the same path-prefix idiom used above
  // (the sweep also stops generating rows for them; this hides the stale ones).
  const archivedPaths = directProjects
    .filter((p: any) => p.archivedAt)
    .map((p: any) => p.path || `/${p.id}`);
  if (archivedPaths.length > 0) {
    for (const p of directProjects as any[]) {
      const path = p.path || `/${p.id}`;
      if (archivedPaths.some((a: string) => path === a || path.startsWith(`${a}/`))) hiddenProjects.add(p.id);
    }
    const archivedDescendants = await prisma.crossModelProject.findMany({
      where: { OR: archivedPaths.map((pre: string) => ({ path: { startsWith: `${pre}/` } })) },
      select: { id: true },
    });
    for (const d of archivedDescendants) hiddenProjects.add(d.id);
  }

  // Active silences only: snoozeUntil null (indefinite) or still in the future.
  const nowMs = Date.now();
  const activeAcks = new Map<string, Date | null>();
  for (const a of acks as DigestItemAckRow[]) {
    const snoozeUntil = a.snoozeUntil ? new Date(a.snoozeUntil) : null;
    if (!snoozeUntil || snoozeUntil.getTime() > nowMs) activeAcks.set(a.itemKey, snoozeUntil);
  }

  const digests: FleetDigestRow[] = rows
    // Orphan drop (ticket a8387f3f): a digest row whose project is no longer
    // visible to the user (deleted, or access revoked) must NEVER render —
    // served as-is it becomes a phantom dashboard card ("Unknown project",
    // 🟢 running, N schedules armed) for a project the owner deleted. FK
    // onDelete:Cascade + the sweep's ghost cleanup are the primary defenses;
    // this filter is the last resort for whatever slips past them (the
    // Promise.all read race, FK drift, legacy rows). Member-project rows
    // survive via the widened projects query above; the UNGROUPED bucket
    // (projectId null) is not a project row and always survives.
    .filter((r: any) => !r.projectId || nameById.has(r.projectId))
    .filter((r: any) => !(r.projectId && hiddenProjects.has(r.projectId)))
    .map((r: any) => {
      const updatedAt = (r.updatedAt instanceof Date ? r.updatedAt : new Date(r.updatedAt)).toISOString();
      const stats = (r.stats && typeof r.stats === 'object' ? r.stats : {}) as Record<string, unknown>;
      return {
        projectId: r.projectId ?? null,
        projectName: r.projectId ? nameById.get(r.projectId) ?? 'Unknown project' : 'Ungrouped',
        status: r.status,
        summary: r.summary,
        attentionItems: projectAttentionItems(r.attentionItems ?? [], activeAcks, !!opts.showAcked),
        stats: r.stats ?? {},
        // Additive Project Pulse fields — legacy rows (pre-migration sweep)
        // read as "no goal facts yet" rather than a malformed shape.
        goalProgress: Array.isArray(r.goalProgress) ? r.goalProgress : [],
        etaSummary: r.etaSummary && typeof r.etaSummary === 'object' ? r.etaSummary : null,
        // P7 G16 — additive; legacy rows read null.
        programState: typeof r.programState === 'string' && r.programState ? r.programState : null,
        // Honest generation time: the sweep stamps stats.generatedAt only when
        // it rewrites the content; a signature-skip touch moves updatedAt alone.
        generatedAt: typeof stats.generatedAt === 'string' ? stats.generatedAt : updatedAt,
        updatedAt,
      };
    })
    .sort((a: FleetDigestRow, b: FleetDigestRow) => {
      const sev = (DIGEST_SEVERITY[a.status] ?? 99) - (DIGEST_SEVERITY[b.status] ?? 99);
      return sev !== 0 ? sev : a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
    });

  return { digests };
}

/** Input bounds for ackDigestItem (the route's body contract). */
export const DIGEST_ACK_KEY_MAX = 300;
export const DIGEST_ACK_SNOOZE_MAX_HOURS = 720; // 30 days

/**
 * POST /fleet/digests/ack — alertmanager-style silence for ONE attention item.
 * The silence lives in digest_item_acks keyed by digestAttentionItemKey, so it
 * SURVIVES the hourly digest regeneration. snoozeHours set → the item
 * resurfaces when the snooze lapses; omitted → an indefinite ack. Re-acking
 * upserts (refreshes the snooze window / re-silences a lapsed one).
 */
export async function ackDigestItem(
  userId: string,
  input: { key?: unknown; snoozeHours?: unknown },
): Promise<{ success: true; key: string; snoozeUntil: string | null }> {
  const key = input?.key;
  if (typeof key !== 'string' || key.length === 0 || key.length > DIGEST_ACK_KEY_MAX) {
    throw new AppError(400, `key is required (non-empty string, ≤${DIGEST_ACK_KEY_MAX} chars)`);
  }
  let snoozeUntil: Date | null = null;
  if (input.snoozeHours !== undefined && input.snoozeHours !== null) {
    const n = input.snoozeHours;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > DIGEST_ACK_SNOOZE_MAX_HOURS) {
      throw new AppError(400, `snoozeHours must be an integer between 1 and ${DIGEST_ACK_SNOOZE_MAX_HOURS}`);
    }
    snoozeUntil = new Date(Date.now() + n * 3_600_000);
  }
  await prisma.digestItemAck.upsert({
    where: { userId_itemKey: { userId, itemKey: key } },
    create: { userId, itemKey: key, snoozeUntil },
    update: { snoozeUntil },
  });
  return { success: true, key, snoozeUntil: snoozeUntil ? snoozeUntil.toISOString() : null };
}

/**
 * DELETE /fleet/digests/ack/:key — lift a silence. deleteMany (idempotent):
 * un-acking a key that was never acked is a no-op, not a 404.
 */
export async function unackDigestItem(userId: string, key: string): Promise<{ success: true }> {
  await prisma.digestItemAck.deleteMany({ where: { userId, itemKey: key } });
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// FLEET PULSE — the management dashboard's quick digest (owner ask 2026-08-24:
// "reflect the new framework": the self-shipping loop needs PR/deploy, ticket
// queue, and guard-health visibility in one glance). Redis-cached 60s; the
// GitHub sections ride the owner's connected GitHub token (same token path the
// evidence guard uses) and the queue/shipping sections are ADMIN-only.
// ═══════════════════════════════════════════════════════════════════════════

const PULSE_CACHE_TTL_SEC = 60;
// Instance isolation boundary (ticket c75b5f34): the pulse's shipping tile
// reads the instance's OWN repo from env — production keeps its historical
// default; a non-prod instance with GITHUB_REPO_SLUG unset has NO repo to read
// (the tile hides) and one configured to the production repo refuses LOUDLY.
// No silent production fallback anywhere.
import { resolveInstanceRepoTarget } from '../platform/instance-targets';
const GITHUB_REPO_SLUG = (): string | null => {
  const r = resolveInstanceRepoTarget(process.env);
  return r.ok ? r.slug : null;
};

export interface FleetPulsePr {
  number: number;
  title: string;
  state: 'merged' | 'open' | 'closed';
  at: string; // merged_at || created_at
}

export interface FleetPulse {
  generatedAt: string;
  /** null = no GitHub token / non-admin — the UI hides the section. */
  shipping: {
    mergedToday: number;
    openPrs: number;
    recent: FleetPulsePr[];
    latestDeploy: { status: string; conclusion: string | null; at: string; url: string } | null;
    repo: string;
  } | null;
  /** null = non-admin. */
  queue: {
    open: number;
    inProgress: number;
    doneToday: number;
    doneTotal: number;
    openList: Array<{ id: string; title: string; status: string; type: string; source: string; createdAt: string }>;
  } | null;
  /** Evidence-guard health (catch counts, receipt rollups) — ADMIN-only
   *  internals (ticket 24dd04d5): null = non-admin, the UI hides the tile. */
  guard: {
    catches24h: number;
    lastCatchAt: string | null;
    /**
     * run_tool_receipts 24h rollup (run-receipts follow-up — Management-UI
     * visibility). OMITTED on any DB error — the pulse must never throw.
     */
    receipts?: { total24h: number; failed24h: number; topTools24h: string[] };
  } | null;
}

async function pulseGithub(userId: string): Promise<FleetPulse['shipping']> {
  let token: string | null = null;
  try {
    const { getValidToken } = await import('../github/token-manager');
    token = await getValidToken(userId);
  } catch { token = null; }
  if (!token) return null;
  const slug = GITHUB_REPO_SLUG();
  if (!slug) {
    // Isolation boundary (c75b5f34): a non-prod instance with no own-repo env
    // reads NOTHING (no silent production fallback). Never throws.
    logger.warn('fleet pulse: no instance repo configured (isolation boundary) — shipping tile hidden');
    return null;
  }
  const gh = async (path: string): Promise<any | null> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'digby-fleet-pulse' },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; } finally { clearTimeout(timer); }
  };
  const [pulls, runs] = await Promise.all([
    gh(`/repos/${slug}/pulls?state=all&sort=created&direction=desc&per_page=20`),
    gh(`/repos/${slug}/actions/workflows/deploy.yml/runs?per_page=1`),
  ]);
  if (!Array.isArray(pulls)) return null;
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const recent: FleetPulsePr[] = pulls.slice(0, 12).map((p: any) => ({
    number: p.number,
    title: String(p.title || '').slice(0, 90),
    state: p.merged_at ? 'merged' : (p.state === 'open' ? 'open' : 'closed'),
    at: p.merged_at || p.created_at,
  }));
  const run = runs?.workflow_runs?.[0];
  return {
    mergedToday: pulls.filter((p: any) => p.merged_at && new Date(p.merged_at) >= dayStart).length,
    openPrs: pulls.filter((p: any) => p.state === 'open').length,
    recent,
    latestDeploy: run ? { status: String(run.status), conclusion: run.conclusion ? String(run.conclusion) : null, at: String(run.created_at), url: String(run.html_url || '') } : null,
    repo: slug,
  };
}

async function pulseQueue(): Promise<NonNullable<FleetPulse['queue']>> {
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const [byStatus, doneToday, openRows] = await Promise.all([
    prisma.userFeatureRequest.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.userFeatureRequest.count({ where: { status: 'done', updatedAt: { gte: dayStart } } }),
    prisma.userFeatureRequest.findMany({
      where: { status: { in: ['open', 'in_progress'] } },
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: 20,
      select: { id: true, title: true, status: true, type: true, source: true, createdAt: true },
    }),
  ]);
  const counts: Record<string, number> = {};
  for (const g of byStatus) counts[g.status] = g._count._all;
  // status asc is alphabetical (in_progress < open) — acceptable here: shows
  // in_progress first, which IS the intended reading order for a pulse.
  return {
    open: counts.open ?? 0,
    inProgress: counts.in_progress ?? 0,
    doneToday,
    doneTotal: counts.done ?? 0,
    openList: openRows.map(r => ({ ...r, title: r.title.slice(0, 100), createdAt: r.createdAt.toISOString() })),
  };
}

/** run_tool_receipts 24h rollup for the guard tile — two grouped COUNT queries.
 *  Confirmation-STAGED rows (ids.staged:true, WI-K 2026-09-25) are excluded:
 *  the tile counts executions and failures, and a call parked on an owner
 *  card is neither.
 *  Raw SQL on purpose (review 2026-09-25): the Prisma JSON-path filter
 *  `NOT: { ids: { path: ['staged'], equals: true } }` compiles to
 *  `NOT (("ids" #> '{staged}')::jsonb = 'true')` — for every ordinary receipt
 *  the key is absent, `#>` yields SQL NULL, `NOT NULL` is NULL and the row is
 *  DROPPED, zeroing the tile. `@>` is null-safe: it returns false (never NULL)
 *  when the key is absent, so only rows literally carrying staged:true leave. */
async function pulseGuardReceipts(since: Date): Promise<NonNullable<FleetPulse['guard']>['receipts']> {
  const [byOk, byTool] = await Promise.all([
    prisma.$queryRaw<Array<{ ok: boolean; n: number }>>`SELECT r."ok" AS ok, COUNT(*)::int AS n FROM "run_tool_receipts" r WHERE r."createdAt" >= ${since} AND NOT (r."ids" @> '{"staged":true}'::jsonb) GROUP BY 1`,
    prisma.$queryRaw<Array<{ tool: string; n: number }>>`SELECT r."tool" AS tool, COUNT(*)::int AS n FROM "run_tool_receipts" r WHERE r."createdAt" >= ${since} AND NOT (r."ids" @> '{"staged":true}'::jsonb) GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 3`,
  ]);
  return {
    total24h: byOk.reduce((n, g) => n + Number(g.n), 0),
    failed24h: Number(byOk.find((g) => g.ok === false)?.n ?? 0),
    topTools24h: byTool.map((g) => g.tool),
  };
}

async function pulseGuard(): Promise<FleetPulse['guard']> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const rows = await prisma.runJournalEntry.findMany({
    where: { goal: { startsWith: 'HARNESS EVIDENCE GUARD' }, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
    take: 100,
  }).catch(() => [] as Array<{ createdAt: Date }>);
  // lastCatchAt beyond the 24h window too (a "silent for 3d" story needs it)
  let lastCatchAt: string | null = rows[0]?.createdAt.toISOString() ?? null;
  if (!lastCatchAt) {
    const last = await prisma.runJournalEntry.findFirst({
      where: { goal: { startsWith: 'HARNESS EVIDENCE GUARD' } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }).catch(() => null);
    lastCatchAt = last?.createdAt.toISOString() ?? null;
  }
  // The receipts rollup is additive visibility — a DB hiccup OMITS the field,
  // never fails the pulse.
  const receipts = await pulseGuardReceipts(since).catch(() => undefined);
  return { catches24h: rows.length, lastCatchAt, ...(receipts ? { receipts } : {}) };
}

/** The management dashboard's one-glance pulse. Cached 60s per user. */
export async function getFleetPulse(userId: string, role: string): Promise<FleetPulse> {
  const cacheKey = `fleet:pulse:${userId.slice(0, 12)}`;
  try {
    const hit = await redisClient.get(cacheKey);
    if (hit) return JSON.parse(hit);
  } catch { /* cache miss path */ }
  // Evidence-guard internals are admin-only (ticket 24dd04d5): harness chrome,
  // catch counts and tool-receipt rollups are framework bookkeeping — a regular
  // user's management dashboard must not read them. Consistent with the
  // shipping/queue sections right above (null = the UI hides the tile).
  const isAdmin = role === 'ADMIN';
  const [shipping, queue, guard] = await Promise.all([
    isAdmin ? pulseGithub(userId) : Promise.resolve(null),
    isAdmin ? pulseQueue() : Promise.resolve(null),
    isAdmin ? pulseGuard() : Promise.resolve(null),
  ]);
  const pulse: FleetPulse = { generatedAt: new Date().toISOString(), shipping, queue, guard };
  try { await redisClient.set(cacheKey, JSON.stringify(pulse), { EX: PULSE_CACHE_TTL_SEC }); } catch { /* best effort */ }
  return pulse;
}
