/**
 * Coding data-access layer (One-Digby merge, Phase 1 Commit A).
 *
 * Coding projects/sessions now live in the MERGED tables:
 *   - project  = crossmodel_projects row with repoProvider IS NOT NULL
 *   - session  = crossmodel_chats row (mode='code') + ChatCodingState satellite
 *                (same id — the chat id; physical table coding_sessions, unmoved)
 *
 * This module is the ONLY place that knows the mapping. Every function returns
 * the LEGACY shapes (`CodingProjectShape` / `CodingSessionShape`) so the
 * controllers and `/coding/*` API responses stay byte-compatible with the
 * pre-merge deployment (old UI keeps working during rollout).
 *
 * Authorization: reads accept project members ('read'+); ALL mutations require
 * the chat owner — runs execute with the owner's tokens and filesystem.
 * Member-write is explicitly deferred.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import { relocateFolderChildren } from '../platform/folder-tree-ops';
import { pgSafeDeep } from '../memory/text-utils';
import { storeDeleteChatScoped, type StoreDeleteClient } from '../memory/context-store';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { transcriptDualWriteEnabled, transcriptReadMode, pickTranscriptSource, type TranscriptSource } from './transcript-source';

// ── Legacy response shapes (frozen — the /coding/* API contract) ─────────────

export interface CodingProjectShape {
  id: string;
  userId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  provider: string;           // 'github' | 'git' | 'local' | 'blank'
  githubLabel: string | null;
  folderId: string | null;    // sidebar folder (additive — not part of the frozen legacy contract)
  createdAt: Date;
  updatedAt: Date;
  _count?: { sessions: number };
}

export interface CodingSessionShape {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  branch: string;
  baseBranch: string;
  worktreePath: string | null;
  permissionMode: string;
  model: string;
  /** Ticket b6acc1e3: provenance of the model stamp — NULL = default
   *  resolution; 'spawn-param' = explicit start_coding_session model arg
   *  (run-executor's project-codingModel override skips these). */
  modelSource?: string | null;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** The chat row's createdAt (review 2026-10-23): equal (to the ms) to `createdAt` for a chat BORN a coding session (createCodingChat writes both in one transaction); later for a plain chat that got a workspace attached. */
  chatCreatedAt?: Date;
  project?: CodingProjectShape;
}

// ── Shape mappers ─────────────────────────────────────────────────────────────

export function toLegacyProject(p: any, sessionCount?: number): CodingProjectShape {
  return {
    id: p.id,
    userId: p.userId,
    name: p.name,
    repoUrl: p.repoUrl ?? '',
    defaultBranch: p.defaultBranch ?? 'main',
    provider: p.repoProvider ?? 'blank',
    githubLabel: p.githubLabel ?? null,
    folderId: p.folderId ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    ...(sessionCount !== undefined ? { _count: { sessions: sessionCount } } : {}),
  };
}

/** chat + its codingState (+optionally its project) → legacy session shape. */
export function toLegacySession(chat: any, state: any, project?: any): CodingSessionShape {
  return {
    id: chat.id,
    projectId: state.projectId,
    userId: chat.userId,          // owner comes from the chat row
    title: chat.title,            // title comes from the chat row
    branch: state.branch,
    baseBranch: state.baseBranch,
    worktreePath: state.worktreePath,
    permissionMode: state.permissionMode,
    model: state.model,
    modelSource: state.modelSource ?? null,
    status: state.status,
    // Ticket 911b6c45: errorMessage only pairs with status 'error' — a legacy
    // row healed by a bare status flip can still carry stale failure text.
    errorMessage: state.status === 'error' ? state.errorMessage : null,
    createdAt: state.createdAt,
    updatedAt: chat.updatedAt > state.updatedAt ? chat.updatedAt : state.updatedAt,
    ...(chat.createdAt ? { chatCreatedAt: chat.createdAt } : {}),
    ...(project ? { project: toLegacyProject(project) } : {}),
  };
}

// ── Projects ──────────────────────────────────────────────────────────────────

const IS_CODING_PROJECT = { repoProvider: { not: null } } as const;

export async function listCodingProjects(userId: string): Promise<CodingProjectShape[]> {
  const projects = await prisma.crossModelProject.findMany({
    // Archived folders leave the coding-project pickers (default-list rule).
    where: { userId, archivedAt: null, ...IS_CODING_PROJECT },
    orderBy: { updatedAt: 'desc' },
    include: { _count: { select: { codingStates: true } } },
  });
  return projects.map(p => toLegacyProject(p, (p as any)._count?.codingStates ?? 0));
}

export async function createCodingProject(data: {
  userId: string; name: string; repoUrl: string; defaultBranch: string;
  provider: string; githubLabel: string | null;
}): Promise<CodingProjectShape> {
  const project = await prisma.crossModelProject.create({
    data: {
      userId: data.userId,
      name: data.name,
      emoji: '🛠️',
      repoUrl: data.repoUrl || null,
      repoProvider: data.provider,
      defaultBranch: data.defaultBranch,
      githubLabel: data.githubLabel,
    },
  });
  return toLegacyProject(project, 0);
}

/** Owner-only project lookup (all project mutations are owner-only). */
export async function getCodingProjectForUser(id: string, userId: string): Promise<CodingProjectShape | null> {
  const p = await prisma.crossModelProject.findFirst({ where: { id, userId, ...IS_CODING_PROJECT } });
  return p ? toLegacyProject(p) : null;
}

/** Set repoUrl/provider after a blank project's first push created a real repo. */
export async function persistProjectRepo(projectId: string, repoUrl: string): Promise<void> {
  await prisma.crossModelProject.update({
    where: { id: projectId },
    data: { repoUrl, repoProvider: 'github' },
  });
}

/**
 * Delete a coding project: coding chats are deleted (old Digby Code semantics —
 * NOT SetNull'd like plain chats), then the project row. Runtime cleanup
 * (containers/worktrees/memory) is the controller's job BEFORE calling this.
 * P5-B: coding chats are identified by their workspace satellite (no mode marker).
 *
 * P2 folder tree: child folders are promoted to truthful roots (parentId null,
 * depth 0, path '/'+id — descendants rewritten to match) BEFORE the project
 * row deletes, in the SAME transaction (platform/folder-tree-ops.ts — the same
 * helper platform.service.deleteProject uses). Without this the parentId FK's
 * SetNull fired on the children, orphaning them with a stale depth≥1 and a
 * path routed through the deleted id.
 */
export async function deleteCodingProjectData(projectId: string): Promise<void> {
  const project = await prisma.crossModelProject.findUnique({
    where: { id: projectId },
    select: { id: true, path: true },
  });
  const states = await prisma.chatCodingState.findMany({ where: { projectId }, select: { id: true } });
  await prisma.$transaction(async (tx) => {
    if (project) {
      await relocateFolderChildren(tx, { folder: project, reparent: null });
    }
    // codingMessages cascade from coding_sessions rows via the retained DB FK.
    await tx.chatCodingState.deleteMany({ where: { projectId } });
    // Privacy (2026-10-23): the deleted chats' FK-less chat-keyed store rows
    // (thread summary, supervisor cold archive) go in the same transaction.
    await storeDeleteChatScoped(states.map(s => s.id), tx as unknown as StoreDeleteClient);
    await tx.crossModelChat.deleteMany({ where: { id: { in: states.map(s => s.id) } } });
    await tx.crossModelProject.delete({ where: { id: projectId } });
  });
  // Second pass after the commit (fs-durable-memory re-review): the in-tx
  // sweep precedes the chat delete, so a racing supervisor write's cold puts
  // could land after it. Best-effort — the project is already gone.
  if (states.length) {
    await storeDeleteChatScoped(states.map(s => s.id)).catch((err: any) => logger.warn(`deleteCodingProjectData: post-commit chat-keyed store sweep failed for ${projectId}: ${err?.message ?? err}`));
  }
}

// ── Sessions (coding chats) ───────────────────────────────────────────────────

export async function listCodingChats(projectId: string): Promise<CodingSessionShape[]> {
  // P5-B: a "coding session" is a chat with a workspace satellite — mode is no
  // longer the marker (it never carries 'code'). Derive from the satellite.
  // Chat-level archived rows leave the session list (default-list rule; the
  // satellite's own 'archived' STATUS still lists — that has always rendered).
  const states = await prisma.chatCodingState.findMany({
    where: { projectId, chat: { is: { archivedAt: null } } },
    include: { chat: true },
    orderBy: { updatedAt: 'desc' },
  });
  return states
    .filter(s => (s as any).chat)
    .map(s => toLegacySession((s as any).chat, s))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function createCodingChat(data: {
  projectId: string; userId: string; title: string; permissionMode: string; model: string;
  /** Ticket b6acc1e3: 'spawn-param' when the model came from an explicit
   *  start_coding_session argument (default resolution leaves it NULL). */
  modelSource?: string | null;
  /** Ticket 161d39e9: 'spawn-param' when the title came from an explicit
   *  start_coding_session `title` argument (default/derived leaves it NULL) —
   *  the executor keeps such titles by provenance, not heuristic. */
  titleSource?: string | null;
}): Promise<CodingSessionShape> {
  const result = await prisma.$transaction(async tx => {
    const chat = await tx.crossModelChat.create({
      data: {
        userId: data.userId,
        projectId: data.projectId,
        title: data.title,
        // P5-B: 'code' is NOT a mode — coding is the satellite below. The chat's
        // mode records only the patience pipeline; 2026-09-26: 'auto' is the
        // stored default everywhere (a plain send into this chat routes per
        // send; the L2 preset is the machine fallback — storedModeToPreset).
        mode: 'auto',
        messages: [],
      },
    });
    const state = await tx.chatCodingState.create({
      data: {
        id: chat.id,               // satellite shares the chat id
        projectId: data.projectId,
        userId: data.userId,       // retained for rollback; reads come from the chat
        title: data.title,         // retained for rollback
        branch: 'pending',
        permissionMode: data.permissionMode,
        model: data.model,
        // Ticket b6acc1e3: stamp the provenance alongside the model so the
        // run-time project override can honor an explicit spawn-time pick.
        ...(data.modelSource ? { modelSource: data.modelSource } : {}),
        // Ticket 161d39e9: same provenance discipline for the TITLE — the
        // executor's sticky-title gate keys on it.
        ...(data.titleSource ? { titleSource: data.titleSource } : {}),
      },
    });
    // Supervision opt-out (ticket 3217e287): read the project's flag in the
    // same transaction so the auto-provisioning trigger below can gate on it.
    const proj = await tx.crossModelProject.findUnique({
      where: { id: data.projectId },
      select: { supervised: true },
    });
    return { chat, state, proj };
  });

  // Fleet Supervisor (best-effort, fire-and-forget): lazily ensure the owner's
  // ONE global supervisor chat (full fleet autonomy). Its wildcard hook already
  // covers this new session chat — no per-chat wiring. NEVER awaited — a
  // supervisor hiccup must not fail session creation. Dynamic import per the
  // fleet modules' import discipline.
  // Gated on the project's `supervised` flag (owner 2026-09-13, ticket
  // 3217e287): a session created in an opted-OUT project must not scaffold the
  // fleet-supervisor framework — mirrors the wildcard emission gate.
  if (result.proj?.supervised !== false) {
    void import('../platform/supervisor.service')
      .then((sup) => sup.ensureFleetSupervisor(data.userId))
      .catch((err: any) => logger.warn(`fleet supervisor ensure failed (session ${result.chat.id.slice(0, 8)}): ${err?.message}`));
  }

  // Agent-mode auto-grant (owner 2026-09-07): a session CREATED in Auto gets
  // its Autonomy grant materialized immediately (all grantable tools, default
  // cap 48, source 'agent_mode_auto'). Awaited so the grant exists before the
  // session is handed back, but best-effort — a grant hiccup must not fail
  // creation (the gate's ctx auto-mode bypass covers the run either way).
  if (data.permissionMode === 'auto') {
    await import('../platform/autonomy.service')
      .then((a) => a.syncAutonomyWithAgentMode({ chatId: result.chat.id, permissionMode: 'auto' }))
      .catch((err: any) => logger.warn(`autonomy auto-grant failed (session ${result.chat.id.slice(0, 8)}): ${err?.message}`));
  }

  return toLegacySession(result.chat, result.state);
}

/**
 * Access-checked session lookup. `minAccess`:
 *   'owner' — chat.userId === userId (all mutations)
 *   'read'  — owner OR project member (viewer+) — transcripts/plan/diff/SSE attach
 */
export async function getSessionForUser(
  id: string,
  userId: string,
  minAccess: 'read' | 'owner' = 'owner',
  opts?: { includeProject?: boolean },
): Promise<CodingSessionShape | null> {
  // Blank/undefined id = not-found (FO firing 44, 2026-09-28): a caller passing
  // an absent id (receipt rows without sessionId, a hand-minted route param)
  // must get null, not a ~2.5 KB raw Prisma validation error in the logs —
  // this class fired ~6×/day via error-handler ("id: undefined").
  if (!id) return null;
  const chat = await prisma.crossModelChat.findUnique({
    where: { id },
    include: { codingState: opts?.includeProject ? { include: { project: true } } : true },
  });
  const state = (chat as any)?.codingState;
  if (!chat || !state) return null;

  let allowed = chat.userId === userId;
  if (!allowed && minAccess === 'read' && chat.projectId) {
    // 7acaa7ba: ancestor inheritance — a member row on an ANCESTOR folder counts,
    // matching getChatAccess/getProjectAccess semantics. (The coding surface
    // grants READ to any role; write/start stays owner-only at the controllers.)
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: chat.projectId, userId } },
      select: { role: true },
    });
    allowed = !!member;
    if (!allowed && process.env.FOLDERS_INHERITANCE !== 'off') {
      const { getAncestorChain } = await import('../platform/folder-inheritance');
      const chain = await getAncestorChain(chat.projectId);
      const ancestors = chain.slice(0, -1); // root…parent (leaf = the chat's own folder)
      if (ancestors.some((f) => f.userId === userId)) {
        allowed = true; // the ancestor folder's owner reads the whole subtree
      } else if (ancestors.length) {
        const rows = await prisma.projectMember.findMany({
          where: { userId, projectId: { in: ancestors.map((f) => f.id) } },
          select: { role: true },
        });
        allowed = rows.length > 0;
      }
    }
  }
  if (!allowed) return null;

  return toLegacySession(chat, state, opts?.includeProject ? state.project : undefined);
}

/** Update coding run state; title updates land on the CHAT row (+ satellite copy for rollback). */
export async function updateSessionState(
  id: string,
  data: Partial<{
    branch: string; baseBranch: string; worktreePath: string | null; permissionMode: string;
    model: string; status: string; errorMessage: string | null; title: string;
    /** 'spawn-param' | 'explicit' (set_session_model / PUT /coding/sessions/:id {model}) — run-executor keeps these over the project default. */
    modelSource: string | null;
  }>,
): Promise<void> {
  const { title, ...stateData } = data;
  // Ticket 911b6c45: errorMessage is only meaningful while status === 'error'.
  // A status flip to ANY other state (ready/running/provisioning/…) implies
  // whatever failed was recovered or superseded — the message must not survive
  // it. Historically only ensureProvisioned's success sites cleared the field,
  // so heal/claim/orphan-sweep flips left a stale "Workspace provisioning
  // failed: …" printed beside status:'ready' for hours, misleading supervisor
  // lanes into treating a healthy lane as broken. Callers may still pass an
  // explicit errorMessage with a non-error status (none do today); an explicit
  // null/undefined otherwise means "clear it".
  if (stateData.status !== undefined && stateData.status !== 'error' && stateData.errorMessage === undefined) {
    stateData.errorMessage = null;
  }
  const writes: any[] = [];
  if (Object.keys(stateData).length) {
    writes.push(prisma.chatCodingState.update({ where: { id }, data: stateData }));
  }
  if (title !== undefined) {
    writes.push(prisma.crossModelChat.update({ where: { id }, data: { title } }));
    writes.push(prisma.chatCodingState.update({ where: { id }, data: { title } }));
  }
  if (writes.length) await prisma.$transaction(writes);

  // Agent-mode auto-grant sync (owner 2026-09-07): every permissionMode write
  // (the side panel's Mode row → coding.controller.updateSession is the only
  // caller that sets it) keeps the chat's Autonomy grant in step — flip TO auto
  // materializes the full grant (source 'agent_mode_auto'), flip AWAY revokes
  // ONLY an auto-granted row (a manually-curated grant is never touched).
  // Awaited + propagated: a failed revoke must surface, not silently leave a
  // stale grant on a chat the owner just put back under supervision.
  if (typeof data.permissionMode === 'string') {
    const { syncAutonomyWithAgentMode } = await import('../platform/autonomy.service');
    await syncAutonomyWithAgentMode({ chatId: id, permissionMode: data.permissionMode });
  }
}

/**
 * Bump the chat row's updatedAt so coding activity keeps the chat sorted
 * correctly in the sidebar (amendment D2 — coding runs only touched the
 * satellite before, so active coding chats sank in the list).
 */
export async function touchChat(chatId: string): Promise<void> {
  await prisma.crossModelChat
    .update({ where: { id: chatId }, data: { updatedAt: new Date() } })
    .catch(() => {});
}

/**
 * Boot-time orphan recovery: rows left status='running' by an instance that
 * died hard (crash / SIGKILLed deploy — no shutdown finalization ran). The
 * Redis run-lock is the liveness signal: a GENUINELY live run always holds it
 * (acquired before the row flips to 'running', refreshed while it runs), so
 * 'running' + no lock is definitionally orphaned — reset it so the session
 * isn't stuck un-runnable until someone happens to attach. Safe during
 * blue-green overlap: the still-draining color's runs hold their locks.
 *
 * Phase-2 (worker tier) GUARD: a session with a CLAIMABLE agent_runs row
 * (queued / interrupted / running — one batched lookup, not N queries) is NOT
 * orphaned even with no lock held: a worker owns it or will claim it within
 * seconds (worker SIGTERM deliberately leaves sessions 'running' — the run IS
 * still logically running). Flipping those to 'ready' would let a second run
 * queue on top of the resumable one.
 *
 * FRESHNESS BOUND (2026-07-31 zombie incident): the claimable lookup only
 * counts rows touched within CLAIMABLE_ROW_FRESH_MS. The unbounded match
 * assumed "a worker owns it or will claim it within seconds" — true only
 * while a worker is ALIVE. classifyClaim's resume/fresh/fail self-healing
 * runs ON CLAIM; with the worker dead there is no claim, so stale
 * queued/interrupted rows blocked the sweep (and the Stop-button unstick)
 * forever. Stale rows no longer count — see the constant's docblock.
 *
 * The bare-'interrupted' match (no checkpoint condition) is CORRECT as of the
 * H1/H2 review fixes: every interrupted row is claimable and self-healing —
 * classifyClaim maps it to resume (checkpoint) / fresh (input) / fail (which
 * flips the session to 'ready'), and a shutdown-interrupted run that never
 * checkpointed cold-retries as 'queued' — so an interrupted row always means
 * "a worker will own this session". Same for the stopRun unstick check.
 *
 * Phase-3 review H1 — the sweep now FAILS CLOSED:
 *  - Grace window: sessions whose updatedAt is younger than ORPHAN_SWEEP_GRACE_MS
 *    are skipped outright — a session that just flipped 'running' is inside the
 *    queue/claim window (its row/lock appears within seconds), so a young
 *    'running'-with-no-row is NOT an orphan.
 *  - The claimable-row batch lookup ABORTS THE ENTIRE PASS on a DB error
 *    (never catch-to-[]: a hiccup would make every unlocked running session
 *    look orphaned).
 *  - The lock check uses isSessionRunLockedStrict: a Redis error on ANY
 *    session aborts the pass (never catch-to-0: a hiccup would make
 *    actively-executing sessions look unlocked).
 */

/**
 * Sessions flipped 'running' less than this long ago are inside the
 * queue/claim window — their agent_runs row / Redis lock appears within
 * seconds — so the sweep must not mistake them for orphans (Phase-3 H1).
 */
export const ORPHAN_SWEEP_GRACE_MS = 2 * 60 * 1000;

/**
 * A queued/interrupted/running agent_runs row only proves worker-ownership
 * while it is FRESH: a live worker claims/heartbeats/resumes within seconds,
 * so any row it genuinely owns stays recently-touched. A row untouched for
 * longer than this means NO live worker owns it (e.g. the worker died and
 * boot-reconcile flipped its runs to 'interrupted', or a queued row was never
 * claimed) — counting it as claimable would park the session 'running'
 * forever (prod incident 2026-07-31: worker died 01:29Z, boot-reconcile
 * flipped the rows 02:00Z, and 5 sessions sat zombie-'running' for 12–30h →
 * client SSE wipe-and-replay loop). 15 min is comfortably longer than any
 * worker restart / blue-green deploy (~9 min) so a draining worker's rows
 * still count, yet far shorter than a real orphan should keep a session
 * un-runnable. Healing is never destructive: a late claim on a 'ready'
 * session re-flips it ready→running at the queue gate, and a new user run
 * supersedes the stale interrupted row (supersedeInterruptedRuns).
 */
export const CLAIMABLE_ROW_FRESH_MS = 15 * 60 * 1000;

/**
 * Ids of the caller-visible sessions currently 'running' — the caller's own
 * plus sessions in projects they belong to (mirrors listChats visibility).
 * Powers the sidebar spinner reconciliation: the client polls this so a run
 * that finished while its view was unmounted (or its SSE died in a
 * backgrounded PWA) stops spinning instead of spinning forever.
 */
export async function listRunningSessionIdsForUser(userId: string): Promise<string[]> {
  const memberProjectIds = (
    await prisma.projectMember.findMany({ where: { userId }, select: { projectId: true } })
  ).map((m) => m.projectId);
  // Scope on the CHAT row (the module's ownership source of truth), joining the
  // coding satellite for run state — never the satellite's rollback columns.
  const rows = await prisma.crossModelChat.findMany({
    where: {
      codingState: { is: { status: 'running' } },
      OR: [
        { userId },
        ...(memberProjectIds.length > 0 ? [{ projectId: { in: memberProjectIds } }] : []),
      ],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function sweepOrphanedRunningSessions(): Promise<number> {
  // Lazy import: session-run-lock pulls in the Redis client, whose import-time
  // connection must not become a hard dependency of this (unit-tested) module.
  const { isSessionRunLockedStrict } = await import('./session-run-lock');
  const rows = await prisma.chatCodingState.findMany({
    where: { status: 'running' },
    select: { id: true, updatedAt: true },
  }).catch(() => [] as { id: string; updatedAt: Date }[]);
  if (!rows.length) return 0;
  // Grace window FIRST (before any per-session work): a just-flipped session
  // is mid-queue/mid-claim, not orphaned.
  const graceCutoff = Date.now() - ORPHAN_SWEEP_GRACE_MS;
  const candidates = rows.filter(r => r.updatedAt.getTime() <= graceCutoff);
  if (!candidates.length) return 0;
  // ONE batched lookup: sessions with a FRESH claimable run row are worker-owned.
  // FAIL CLOSED: a DB error aborts the whole pass — catching to [] would make
  // every unlocked running session look orphaned (H1).
  // Freshness-bound (CLAIMABLE_ROW_FRESH_MS): a stale row proves no live worker
  // owns it — see the constant's docblock (2026-07-31 zombie incident).
  let claimable: Array<{ sessionId: string }>;
  try {
    claimable = await prisma.agentRun.findMany({
      where: {
        sessionId: { in: candidates.map(r => r.id) },
        status: { in: ['queued', 'interrupted', 'running'] },
        updatedAt: { gte: new Date(Date.now() - CLAIMABLE_ROW_FRESH_MS) },
      },
      select: { sessionId: true },
    });
  } catch (err: any) {
    logger.warn(`coding sweep: claimable-row lookup failed — aborting the pass (fail-closed): ${err.message}`);
    return 0;
  }
  const workerOwned = new Set(claimable.map(r => r.sessionId));
  let healed = 0;
  const healedIds: string[] = [];
  for (const { id } of candidates) {
    if (workerOwned.has(id)) continue; // a worker owns / will claim this run
    // FAIL CLOSED: a Redis error aborts the whole pass — catching to 0 would
    // make actively-executing sessions look unlocked (H1).
    let locked: boolean;
    try {
      locked = await isSessionRunLockedStrict(id);
    } catch (err: any) {
      logger.warn(`coding sweep: run-lock check failed for ${id} — aborting the pass (fail-closed): ${err.message}`);
      return 0;
    }
    if (locked) continue; // live on some instance
    // Ticket 911b6c45: heal flips must clear errorMessage too (the seam
    // updateSessionState now enforces this for its callers; this raw prisma
    // write bypasses it).
    await prisma.chatCodingState.update({ where: { id }, data: { status: 'ready', errorMessage: null } })
      .then(() => { healed++; healedIds.push(id); })
      .catch(() => {});
  }
  if (healed) {
    logger.info(`coding sweep: reset ${healed} orphaned running session(s) to ready`);
    // Stranded-steer recovery (ticket 6a99225c): a healed zombie may hold
    // unconsumed user messages in its Redis steer mailbox — queue them as a
    // follow-up run instead of leaving them to die silently. Lazy import
    // keeps this module's import-time graph Redis-free (the helper pulls
    // session-run-lock transitively); per-session best-effort — the heal
    // itself already landed and must not be clawed back by a recovery error.
    try {
      const { recoverStrandedSteers } = await import('./steer-recovery');
      for (const id of healedIds) {
        await recoverStrandedSteers(id, 'orphan-heal').catch(() => {});
      }
    } catch { /* recovery is best-effort */ }
  }
  return healed;
}

/** The single-id heal's verdict (healOrphanedRunningSession). */
export type OrphanHealVerdict = 'healed' | 'not_running' | 'grace' | 'owned' | 'locked' | 'error';

/**
 * The orphan sweep above for ONE session (TICKET-LANE ARCHIVE GAPS B6,
 * 2026-10-21): the ticket dispatcher calls it before archiving a lane whose
 * satellite still reads 'running' — archiveChat 409s on that status, and a
 * worker that died hard leaves it there until the sweep happens to pass (or,
 * with a fresh-looking row, forever). The SAME predicates, in the same order:
 * status 'running'; updatedAt older than ORPHAN_SWEEP_GRACE_MS; no
 * queued / interrupted / running agent_runs row touched within
 * CLAIMABLE_ROW_FRESH_MS ('owned'); isSessionRunLockedStrict false
 * ('locked'). FAILS CLOSED: any read error answers 'error' and nothing is
 * written. The heal write is guarded on status 'running' (a run that claimed
 * the session in between wins) and clears errorMessage like the sweep
 * (911b6c45); stranded steers are recovered best-effort, as the sweep does.
 * Never throws.
 */
export async function healOrphanedRunningSession(chatId: string): Promise<OrphanHealVerdict> {
  try {
    const row = await prisma.chatCodingState.findUnique({ where: { id: chatId }, select: { id: true, status: true, updatedAt: true } });
    if (!row || row.status !== 'running') return 'not_running';
    if (row.updatedAt.getTime() > Date.now() - ORPHAN_SWEEP_GRACE_MS) return 'grace';
    const claimable = await prisma.agentRun.count({
      where: {
        sessionId: chatId,
        status: { in: ['queued', 'interrupted', 'running'] },
        updatedAt: { gte: new Date(Date.now() - CLAIMABLE_ROW_FRESH_MS) },
      },
    });
    if (claimable > 0) return 'owned';
    // Lazy import, like the sweep: session-run-lock pulls in the Redis client.
    const { isSessionRunLockedStrict } = await import('./session-run-lock');
    if (await isSessionRunLockedStrict(chatId)) return 'locked';
    const res = await prisma.chatCodingState.updateMany({ where: { id: chatId, status: 'running' }, data: { status: 'ready', errorMessage: null } });
    if (!res.count) return 'not_running';
    logger.info(`coding heal: reset orphaned running session ${chatId.slice(0, 8)} to ready (single-id heal)`);
    try {
      const { recoverStrandedSteers } = await import('./steer-recovery');
      await recoverStrandedSteers(chatId, 'orphan-heal').catch(() => {});
    } catch { /* recovery is best-effort */ }
    return 'healed';
  } catch (err: any) {
    logger.warn(`coding heal: single-id orphan check failed for ${chatId.slice(0, 8)} (fail-closed, nothing written): ${err?.message ?? err}`);
    return 'error';
  }
}

/** Delete one coding chat (chat + satellite; messages cascade via both FKs). */
export async function deleteCodingChatData(id: string): Promise<void> {
  await prisma.$transaction([
    prisma.chatCodingState.delete({ where: { id } }),
    prisma.crossModelChat.delete({ where: { id } }),
  ]);
  // Privacy (2026-10-23): the chat's FK-less chat-keyed store rows — best-effort after the delete.
  await storeDeleteChatScoped([id]).catch((err: any) => logger.warn(`deleteCodingChatData: chat-keyed store cleanup failed for ${id}: ${err?.message ?? err}`));
}

/** Most recent prior session in a project (continuity chaining), excluding one id. */
export async function findPriorSession(projectId: string, excludeId: string): Promise<CodingSessionShape | null> {
  const state = await prisma.chatCodingState.findFirst({
    where: { projectId, id: { not: excludeId }, status: { in: ['ready', 'archived'] }, branch: { not: 'pending' } },
    orderBy: { updatedAt: 'desc' },
    include: { chat: true },
  });
  if (!state) return null;
  return toLegacySession((state as any).chat, state);
}

// ── P5-B: coding as a per-message CAPABILITY (not a sticky mode) ─────────────
//
// A chat CAN run the coding harness when it is code-capable:
//   - it already carries a ChatCodingState workspace satellite (every legacy
//     mode='code' chat does — they keep working unchanged), OR
//   - its folder's nearest ancestor chain owns a workspace (repoProvider set).
// The satellite attaches ON DEMAND (User Space §4 — THE ROUTING RULE): the
// coding pipeline (view AND sends) keys off the satellite, NEVER off folder
// capability — codeCapable means exactly "attachable on demand" (the send-time
// router §4a / attach_workspace §4b / the ⋯-menu item converge on
// ensureChatWorkspaceState; streamCapabilityRun keeps its lazy attach purely
// as the backstop for callers that already chose the coding entry).
//
// Per-message profile routing rule (User Space §4, superseding the P5-B
// capability routing): a turn runs the CODING profile iff the chat HAS the
// satellite. Satellite-less chats — capable or not — always run the chat
// profile, exactly as before.

export interface ChatCapability {
  /** The chat can GAIN the coding harness on demand (satellite attached, or a workspace resolvable from its folder chain). User Space §4: this gates ONLY the attach triggers — it never routes a send or the view. */
  codeCapable: boolean;
  /** A ChatCodingState satellite is attached to this chat — THE ROUTING RULE: this alone selects the coding pipeline (view AND sends). */
  hasWorkspaceState: boolean;
  /** The satellite exists AND its worktree is provisioned on disk (status/worktreePath set). */
  workspaceReady: boolean;
}

/**
 * Capability snapshot for one chat. `preloadedState` lets batch callers (chat
 * lists) skip the per-chat satellite query.
 */
export async function getChatCapability(
  chat: { id: string; projectId?: string | null },
  preloadedState?: { worktreePath: string | null } | null,
): Promise<ChatCapability> {
  const state = preloadedState !== undefined
    ? preloadedState
    : await (prisma as any).chatCodingState
        .findUnique({ where: { id: chat.id }, select: { worktreePath: true } })
        .catch(() => null);
  const hasWorkspaceState = !!state;
  const workspaceReady = hasWorkspaceState && !!state!.worktreePath;
  let codeCapable = hasWorkspaceState;
  if (!codeCapable && chat.projectId) {
    const { getNearestWorkspaceFolder } = await import('../platform/folder-inheritance');
    codeCapable = !!(await getNearestWorkspaceFolder(chat.projectId).catch(() => null));
  }
  return { codeCapable, hasWorkspaceState, workspaceReady };
}

/**
 * Stored codingModel pref → the model stamped on a NEW coding session.
 * Built-in ids pass through (incl. the kimi-k2.6 → kimi-k3 and glm-5.2 →
 * glm-5.3 legacy aliases, the latter owner 2026-09-03 GLM-5.3 cutover); a
 * Digby Edge '<label>:<modelId>' custom-endpoint spec survives while it still
 * resolves to an enabled, coding-capable registry model; anything else falls
 * back to glm-5.3. THE single resolution shared by platform.service's
 * startCodingSession and the lazy-attach defaults below — the two drifted
 * once (2026-09-03, ticket 68b1aba3: the creation path re-stamped registry
 * specs to the default → runs went to api.z.ai keyless → HTTP 401 on Edge).
 */
export async function resolveStampedCodingModel(storedPref: string | null | undefined, userId: string, projectId?: string): Promise<string> {
  return (await resolveStampedCodingModelDetailed(storedPref, userId, projectId)).model;
}

/**
 * Same resolution with the governing SOURCE (seats govern sessions, 2026-09-28):
 * under the default the ONE resolver in seat-governance.ts decides — explicit
 * session pick → HUMAN-set project override → a preference the user set
 * THEMSELVES → the coding_default seat live; SEAT_GOVERNS_SESSIONS_DISABLED=1
 * restores the pre-2026-09-28 chain below (project → any resolvable pref →
 * seat), where a default "glm-5.2" preference row counted as a pick.
 */
export async function resolveStampedCodingModelDetailed(storedPref: string | null | undefined, userId: string, projectId?: string): Promise<{ model: string; source: 'explicit' | 'project' | 'preference' | 'seat' | 'stamp' }> {
  const governance = await import('./seat-governance');
  if (!governance.seatGovernsSessionsDisabled()) {
    const decision = await governance.resolveGoverningCodingModel({ userId, projectId: projectId ?? null, storedPref: storedPref ?? null });
    return { model: decision.model, source: decision.source };
  }
  // Project-level pick wins (owner ask 2026-09-04): the side-panel "coding
  // agent" picker writes ProjectSettings.codingModel; a valid one beats the
  // user's pref. Invalid/stale picks fall through to the pref (WARNed).
  if (projectId) {
    const projPick = await projectCodingModel(projectId);
    if (projPick) {
      const resolved = await resolveOneCodingPick(projPick, userId);
      if (resolved) return { model: resolved, source: 'project' };
      logger.warn(`coding: project ${projectId.slice(0, 8)} codingModel "${projPick}" no longer resolves — falling back to the user pref`);
    }
  }
  const fromPref = await resolveOneCodingPick(storedPref, userId);
  if (fromPref) return { model: fromPref, source: 'preference' };
  // No (valid) stored pick → the instance's coding_default SEAT (model-roles
  // config; glm-5.3 when unset). On Edge this is what makes every new
  // workspace session run the admin's endpoint without a per-user pick.
  const { resolveRoleModelForRun } = await import('./coding-model');
  return { model: await resolveRoleModelForRun('coding_default', 'glm-5.3'), source: 'seat' };
}

/** ONE candidate coding-model pick → the model string to run, or null when it
 *  is not a built-in and does not resolve to an enabled [coding] endpoint
 *  model. Shared by the pref path, the project override, and the run-time
 *  project swap (run-executor). */
export async function resolveOneCodingPick(pick: string | null | undefined, userId: string): Promise<string | null> {
  // Legacy aliases forward: kimi-k2.6 → kimi-k3 (2026-07-17), glm-5.2 → glm-5.3
  // (2026-09-03), deepseek-v4-pro → deepseek-flash (V4.1 Flash cutover 2026-09-10).
  const aliased = pick === 'kimi-k2.6' ? 'kimi-k3'
    : pick === 'glm-5.2' ? 'glm-5.3'
    : pick === 'deepseek-v4-pro' ? 'deepseek-flash'
    : (pick || '');
  if (['glm-5.3', 'deepseek-flash', 'kimi-k3'].includes(aliased)) return aliased;
  // Digby Edge (Phase 2): a stored '<label>:<modelId>' survives while it still
  // resolves to an enabled, coding-capable custom endpoint model.
  if (aliased.includes(':')) {
    const { resolveRegistryModel } = await import('../model-endpoints/model-endpoints.service');
    if ((await resolveRegistryModel(aliased, userId).catch(() => null))?.coding) return aliased;
  }
  return null;
}

/** The project's codingModel setting (folder-inherited), or null. Fail-open:
 *  a settings hiccup must never block session creation or a run. */
export async function projectCodingModel(projectId: string): Promise<string | null> {
  try {
    const { getProjectSettings } = await import('../langgraph/memory.graph');
    return (await getProjectSettings(projectId)).codingModel || null;
  } catch {
    return null;
  }
}

/** Provenance of the project's codingModel override (seats govern sessions,
 *  2026-09-28): 'user' = a human set it (side panel / REST / a tool call on a
 *  human turn); 'machine' = a lane or supervisor wrote it on a machine turn
 *  (never shadows the admin seat); null = a legacy override with no record
 *  (treated as user-set; the apply-seats action clears the built-in ones).
 *  Fail-open null. */
export async function projectCodingModelSource(projectId: string): Promise<'user' | 'machine' | null> {
  try {
    const { getProjectSettings } = await import('../langgraph/memory.graph');
    const s = await getProjectSettings(projectId);
    return s.codingModelSource === 'user' || s.codingModelSource === 'machine' ? s.codingModelSource : null;
  } catch {
    return null;
  }
}

/** Default coding prefs for a lazily-attached workspace (same resolution startCodingSession uses). */
async function codingDefaultsFor(userId: string, projectId?: string): Promise<{ permissionMode: string; model: string }> {
  const prefs = await prisma.userPreferences.findUnique({ where: { userId } }).catch(() => null);
  const model = await resolveStampedCodingModel((prefs as any)?.codingModel, userId, projectId);
  const permissionMode = ['auto', 'plan', 'ask'].includes((prefs as any)?.codingPermissionMode || '')
    ? (prefs as any).codingPermissionMode
    : 'auto'; // platform default 'auto' since 2026-09-17 (owner oq_93a7e24c)
  return { permissionMode, model };
}

/**
 * LAZY workspace attach (P5-B): ensure a ChatCodingState satellite exists for
 * `chat` and return the session view. If the satellite is already there this is
 * a plain read; otherwise it is created on demand — the chat must be
 * code-capable, i.e. its folder chain must resolve a workspace (nearest
 * ancestor with repoProvider, falling back to the leaf folder itself).
 *
 * The worktree is NOT provisioned here: the run-start path's ensureRunnable
 * re-provisions on demand (reattachWorktree), exactly like a session whose
 * worktree was reaped. The branch is assigned eagerly (sessionBranchName) so
 * continuity chaining and the UI have a stable identity from the start.
 *
 * Owner-only semantics are the CALLER's job (every entry path already
 * authorizes). Returns null when no workspace can be resolved.
 */
export async function ensureChatWorkspaceState(chat: {
  id: string; userId: string; projectId: string | null; title: string;
}): Promise<CodingSessionShape | null> {
  const existing = await getSessionForUser(chat.id, chat.userId, 'owner', { includeProject: true });
  if (existing) return existing;
  if (!chat.projectId) return null;
  // Supervisor lanes (fleet or per-project) are plain chats BY DESIGN — they
  // orchestrate workers, they are not workers. Every attach entry point
  // (send-time router, attach_workspace tool, convertChatToCoding) funnels
  // here, so this is the belt behind those braces (rollout watch 2026-09-14:
  // two project supervisors were lazily attached by an agent send and woke
  // as coding runs).
  const flags = await prisma.crossModelChat
    .findUnique({ where: { id: chat.id }, select: { isSupervisor: true, isProjectSupervisor: true } })
    .catch(() => null);
  if (flags?.isSupervisor === true || (flags as any)?.isProjectSupervisor === true) {
    logger.info(`p5b: refusing to attach workspace state to supervisor lane ${chat.id.slice(0, 8)} (plain chat by design)`);
    return null;
  }

  // Workspace resolution mirrors startCodingSession: the satellite is filed
  // under the nearest workspace-owning folder (the whole run path reads
  // session.project.repoUrl/provider off state.projectId).
  let project = await getCodingProjectForUser(chat.projectId, chat.userId);
  let projectId = chat.projectId;
  if (!project) {
    const { getNearestWorkspaceFolder } = await import('../platform/folder-inheritance');
    const wsFolder = await getNearestWorkspaceFolder(chat.projectId).catch(() => null);
    if (wsFolder) {
      project = toLegacyProject(wsFolder);
      projectId = wsFolder.id;
    }
  }
  if (!project) return null;

  const { permissionMode, model } = await codingDefaultsFor(chat.userId, projectId);
  const { sessionBranchName } = await import('./workspace.service');
  const state = await prisma.chatCodingState.create({
    data: {
      id: chat.id, // satellite shares the chat id
      projectId,
      userId: chat.userId,
      title: chat.title,
      branch: sessionBranchName(chat.id),
      baseBranch: project.defaultBranch,
      permissionMode,
      model,
      // status stays 'provisioning' + worktreePath null: ensureRunnable (run
      // start) re-provisions on demand — no eager clone for a maybe-never run.
    },
  });
  logger.info(`p5b: lazily attached workspace state to chat ${chat.id} (folder ${projectId})`);

  // Agent-mode auto-grant (owner 2026-09-07): a lazily-attached workspace whose
  // resolved default mode is Auto is a session CREATED in Auto — materialize
  // the grant (best-effort, same posture as createCodingChat).
  if (permissionMode === 'auto') {
    await import('../platform/autonomy.service')
      .then((a) => a.syncAutonomyWithAgentMode({ chatId: chat.id, permissionMode: 'auto' }))
      .catch((err: any) => logger.warn(`autonomy auto-grant failed (lazy attach ${chat.id.slice(0, 8)}): ${err?.message}`));
  }

  return toLegacySession(
    { id: chat.id, userId: chat.userId, title: chat.title, updatedAt: new Date() },
    { ...state, project },
    project,
  );
}

/**
 * Post-cutover reconciliation (also see scripts/reconcile-coding-unify.ts):
 * sweep rows written by OLD code during the blue-green overlap into the merged
 * tables, and remove orphaned code chats (amendment D3). Idempotent.
 */
export async function reconcileCodingUnify(): Promise<{ projects: number; chats: number; orphans: number }> {
  const [projects, chats] = await prisma.$transaction([
    prisma.$executeRawUnsafe(`
      INSERT INTO "crossmodel_projects"
        ("id","userId","name","emoji","repoUrl","repoProvider","defaultBranch","githubLabel","createdAt","updatedAt")
      SELECT cp."id", cp."userId", cp."name", '🛠️', NULLIF(cp."repoUrl",''), cp."provider",
             cp."defaultBranch", cp."githubLabel", cp."createdAt", cp."updatedAt"
      FROM "coding_projects" cp
      ON CONFLICT ("id") DO NOTHING`),
    prisma.$executeRawUnsafe(`
      INSERT INTO "crossmodel_chats"
        ("id","userId","projectId","title","mode","messages","createdAt","updatedAt")
      SELECT cs."id", cs."userId", cs."projectId", cs."title", 'code', ARRAY[]::jsonb[],
             cs."createdAt", cs."updatedAt"
      FROM "coding_sessions" cs
      ON CONFLICT ("id") DO NOTHING`),
  ]);
  // Orphan sweep: code chats whose satellite is gone can never run — remove.
  const orphans = await prisma.$executeRawUnsafe(`
    DELETE FROM "crossmodel_chats" c
    WHERE c."mode" = 'code'
      AND NOT EXISTS (SELECT 1 FROM "coding_sessions" s WHERE s."id" = c."id")`);
  if (projects || chats || orphans) {
    logger.info(`coding reconcile: swept ${projects} project(s), ${chats} chat(s); removed ${orphans} orphan code chat(s)`);
  }
  return { projects, chats, orphans };
}

// ── Transcripts (P5-A: dual-write + read-switch) ────────────────────────────
//
// One transcript table, in two steps (DIGBY_PLATFORM_UNIFICATION_PLAN Option 3,
// phase 5). P5-A (this block):
//   - WRITE: every CodingMessage insert/update ALSO writes the mirrored
//     CrossModelMessage in the SAME transaction — same id (uuids are
//     table-independent, so replays are idempotent), sessionId → chatId,
//     role/content/parts 1:1, createdAt preserved, metadata left NULL (no
//     counterpart on CodingMessage). Gate: TRANSCRIPT_DUAL_WRITE !== 'off'
//     (default ON).
//   - READ: TRANSCRIPT_READ='merged' (default) serves transcripts from
//     crossmodel_messages, falling back to coding_messages ONLY for chats with
//     legacy rows but zero mirrored rows (the not-yet-backfilled window — one
//     warn per chat). 'legacy' forces the pre-switch behavior.
// scripts/backfill-coding-transcripts.ts closes the historical gap; P5-B drops
// the legacy table after the read-switch proves out.

/** The CodingMessage row shape — identical on either side of the read-switch. */
export interface CodingTranscriptRow {
  id: string;
  chatId: string; // physical column is sessionId on the legacy side
  role: string;
  content: string;
  parts: unknown;
  createdAt: Date;
  /** Ticket 68916075: last-write stamp (≈ finalize); NULL on rows predating the field. */
  updatedAt: Date | null;
  /**
   * Json metadata. Historically mirror-only (fleet origin marking rode the
   * crossmodel_messages mirror); since P4 (CanLaw L5 guardOriginal
   * attachments) coding_messages carries the column too — writes land on both
   * sides, toMirror/toMirrorUpdate include it when present.
   */
  metadata?: unknown;
}

/**
 * Dual-write gate + read-switch + source picker now live in the LEAF module
 * `transcript-source.ts` and are re-exported here unchanged (MERGE-1 slice 1).
 *
 * They moved because this file's import of `middleware/error-handler` reaches
 * `config/env`, which calls `process.exit(1)` at import time when the env is not fully
 * populated — harmless in production, but it made this module a hostile import for the
 * 24 `schedule*.test.ts` suites that reach it transitively through
 * firing-superseded-gate. Keeping the predicates in a leaf module lets the six former
 * bypass readers share the seam without dragging that edge into every schedule suite.
 * Behaviour is identical: the bodies were moved verbatim.
 */
export { transcriptDualWriteEnabled, transcriptReadMode, pickTranscriptSource } from './transcript-source';
export type { TranscriptSource } from './transcript-source';

/** CodingMessage row → CrossModelMessage create data (column mapping, explicit). */
function toMirror(row: CodingTranscriptRow) {
  return {
    id: row.id, // reused across tables — idempotency for free
    chatId: row.chatId, // sessionId → chatId
    role: row.role, // 1:1 ('user' | 'assistant' | 'system')
    content: row.content,
    ...(row.parts != null ? { parts: row.parts as unknown as object[] } : {}),
    // Fleet origin marking: metadata has no CodingMessage counterpart — it is
    // threaded through by appendCodingMessage and lands on the mirror only.
    ...(row.metadata != null ? { metadata: row.metadata as any } : {}),
    createdAt: row.createdAt, // preserved — ordering + the backfill checksum depend on it
  };
}

/** Mirror update payload for the upsert's update branch (content always; parts + metadata when present). */
function toMirrorUpdate(row: CodingTranscriptRow) {
  return {
    content: row.content,
    ...(row.parts != null ? { parts: row.parts as unknown as object[] } : {}),
    ...(row.metadata != null ? { metadata: row.metadata as any } : {}),
  };
}

/**
 * Insert a CodingMessage AND — unless dual-write is off — its CrossModelMessage
 * mirror in the SAME transaction. The mirror is an upsert so a retried insert
 * (same id) converges instead of failing. `metadata` (fleet origin marking) is
 * mirror-only — coding_messages has no such column.
 */
export async function appendCodingMessage(data: {
  chatId: string; role: string; content: string; parts?: unknown; metadata?: unknown;
}, id?: string): Promise<CodingTranscriptRow> {
  // 22P05 guard (FO firing 20): lone surrogates / NULs in content, parts or
  // metadata fail the codingMessage.create AND the crossModelMessage mirror
  // upsert in one transaction — run e8975be5's final transcript persist failed
  // 5× on exactly this. Strip at the boundary so a bad byte can never fail a
  // transcript write (telemetry only when something was dropped).
  const report = { stripped: false, dropped: 0 };
  const content = pgSafeDeep(data.content, report);
  const parts = data.parts !== undefined ? pgSafeDeep(data.parts, report) : undefined;
  const metadata = data.metadata !== undefined ? pgSafeDeep(data.metadata, report) : undefined;
  if (report.stripped) {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.PG_UNSAFE_STRIPPED, value: report.dropped, unit: 'chars',
      sessionId: data.chatId, meta: { seam: 'coding_message_append' } });
  }
  const create = {
    // fc7b2ca7: an optional caller-supplied id (the steer path pre-generates it
    // so the id can ride the Redis mailbox — the stranded-steer recovery then
    // adopts this row instead of inserting a duplicate). Default: autogen.
    ...(id ? { id } : {}),
    chatId: data.chatId,
    role: data.role,
    content: content as unknown as string,
    ...(parts !== undefined ? { parts: parts as unknown as object[] } : {}),
    // coding_messages.metadata exists since P4 (guardOriginal attachments) —
    // stored on BOTH sides now, still mirrored as before.
    ...(metadata !== undefined ? { metadata: metadata as any } : {}),
  };
  if (!transcriptDualWriteEnabled()) {
    return prisma.codingMessage.create({ data: create });
  }
  return prisma.$transaction(async tx => {
    const row = await tx.codingMessage.create({ data: create });
    const mirrorRow: CodingTranscriptRow = data.metadata !== undefined ? { ...row, metadata: data.metadata } : row;
    await tx.crossModelMessage.upsert({
      where: { id: row.id },
      create: toMirror(mirrorRow),
      update: toMirrorUpdate(mirrorRow),
    });
    return row;
  });
}

/**
 * Update a CodingMessage (the run loop rewrites the assistant row's content +
 * parts as partials accumulate) and mirror the change in the SAME transaction.
 * The mirror upsert CREATES the row when a pre-dual-write message has no mirror
 * yet — the backfill would eventually fill it, but this keeps the mirror live.
 */
export async function updateCodingMessage(
  id: string,
  data: { content: string; parts?: unknown; metadata?: unknown },
): Promise<CodingTranscriptRow> {
  // 22P05 guard (FO firing 20) — same strip as appendCodingMessage: this is
  // the FINAL-transcript persist path (run-executor rewrites the assistant row
  // content+parts here), the seam that failed 5× for run e8975be5.
  const report = { stripped: false, dropped: 0 };
  const content = pgSafeDeep(data.content, report);
  const parts = data.parts !== undefined ? pgSafeDeep(data.parts, report) : undefined;
  const metadata = data.metadata !== undefined ? pgSafeDeep(data.metadata, report) : undefined;
  if (report.stripped) {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.PG_UNSAFE_STRIPPED, value: report.dropped, unit: 'chars',
      meta: { seam: 'coding_message_update' } });
  }
  const update = {
    content: content as unknown as string,
    ...(parts !== undefined ? { parts: parts as unknown as object[] } : {}),
    // P4 (CanLaw L5): guardOriginal attachments ride the row + its mirror.
    ...(metadata !== undefined ? { metadata: metadata as any } : {}),
  };
  if (!transcriptDualWriteEnabled()) {
    return prisma.codingMessage.update({ where: { id }, data: update });
  }
  return prisma.$transaction(async tx => {
    const row = await tx.codingMessage.update({ where: { id }, data: update });
    await tx.crossModelMessage.upsert({
      where: { id: row.id },
      create: toMirror(row),
      update: toMirrorUpdate(row),
    });
    return row;
  });
}

/** Fields selected on merged reads so the row shape is byte-identical to CodingMessage. */
// Ticket 68916075: updatedAt rides the select so transcript reads can distinguish
// last-write (≈ finalize) from insert-time createdAt for coding-run placeholder rows.
// 2026-09-15 (owner ask — session status cards + folding machine notes):
// metadata rides the merged read too. Until now the legacy codingMessage path
// returned the full row while this select dropped metadata, so a coding
// session's client never saw origin/kind/status and every harness card or
// provenance stamp degraded to plain prose. The controller strips the one
// large key (guardOriginal, ≤20k chars of audit text) before responding.
const TRANSCRIPT_SELECT = { id: true, chatId: true, role: true, content: true, parts: true, metadata: true, createdAt: true, updatedAt: true } as const;

/** Session-view transcript, ascending — same shape/order as the legacy codingMessage.findMany. */
export async function listCodingTranscript(chatId: string): Promise<CodingTranscriptRow[]> {
  const source = await pickTranscriptSource(chatId);
  if (source === 'legacy') {
    return prisma.codingMessage.findMany({ where: { chatId }, orderBy: { createdAt: 'asc' } });
  }
  return prisma.crossModelMessage.findMany({ where: { chatId }, orderBy: { createdAt: 'asc' }, select: TRANSCRIPT_SELECT });
}

export interface CodingTranscriptPage {
  rows: CodingTranscriptRow[];
  hasMore: boolean;
  /** Id of the page's OLDEST row — pass as `before` for the next older page (only when hasMore). */
  nextBefore?: string;
}

/**
 * Paged session-view transcript (session-open perf, 2026-08-31): the newest
 * `limit` rows — optionally older than the `before` cursor — chronological
 * within the page. Same compound (createdAt, id) cursor contract as the
 * plain-chat paging (crossmodel.service.getChatById): createdAt is ms-precision,
 * so ties are possible and a plain `createdAt < c` filter would strand a tied
 * row between pages — "older" = createdAt < c OR (createdAt = c AND id < c.id).
 */
export async function listCodingTranscriptPage(
  chatId: string,
  opts: { limit: number; before?: string },
): Promise<CodingTranscriptPage> {
  const source = await pickTranscriptSource(chatId);
  let before: { createdAt: Date; id: string } | undefined;
  if (opts.before) {
    const select = { chatId: true, createdAt: true } as const;
    const cursor = source === 'legacy'
      ? await prisma.codingMessage.findUnique({ where: { id: opts.before }, select })
      : await prisma.crossModelMessage.findUnique({ where: { id: opts.before }, select });
    if (!cursor || cursor.chatId !== chatId) throw new AppError(400, 'Invalid before cursor for this session');
    before = { createdAt: cursor.createdAt, id: opts.before };
  }
  const beforeClause = before
    ? {
        OR: [
          { createdAt: { lt: before.createdAt } },
          { createdAt: before.createdAt, id: { lt: before.id } },
        ],
      }
    : {};
  const orderBy = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
  const take = opts.limit + 1; // +1 row = the hasMore probe
  const rows: CodingTranscriptRow[] = source === 'legacy'
    ? await prisma.codingMessage.findMany({ where: { chatId, ...beforeClause }, orderBy, take })
    : await prisma.crossModelMessage.findMany({ where: { chatId, ...beforeClause }, orderBy, take, select: TRANSCRIPT_SELECT });
  const hasMore = rows.length > opts.limit;
  const page = rows.slice(0, opts.limit).reverse(); // chronological within the page
  return { rows: page, hasMore, ...(hasMore && page.length ? { nextBefore: page[0].id } : {}) };
}

/**
 * Inline base64 image parts explode the transcript payload (a handful of
 * screenshots = tens of MB of JSON to download + parse before first paint).
 * Swap each persisted image part's `data` for a same-origin URL served by
 * getMessageImage — the transcript GET stays lean and the bytes only fetch
 * when an <img> actually renders (auth via the cm_access cookie). MUTATES the
 * passed rows (response-shaping, run after the DB read).
 */
export function stripInlineImageData(chatId: string, messages: Array<{ id: string; parts?: unknown }>): void {
  for (const m of messages) {
    if (!Array.isArray(m.parts)) continue;
    m.parts = (m.parts as any[]).map((p, i) =>
      p && p.type === 'image' && typeof p.data === 'string' && p.data.length > 0
        ? { ...p, data: undefined, url: `/api/crossmodel/coding/sessions/${chatId}/messages/${m.id}/image/${i}` }
        : p);
  }
}

/** Newest-first transcript slice (run history) under the same switch. */
export async function listRecentCodingTranscript(chatId: string, take: number): Promise<CodingTranscriptRow[]> {
  const source = await pickTranscriptSource(chatId);
  if (source === 'legacy') {
    return prisma.codingMessage.findMany({ where: { chatId }, orderBy: { createdAt: 'desc' }, take });
  }
  return prisma.crossModelMessage.findMany({ where: { chatId }, orderBy: { createdAt: 'desc' }, take, select: TRANSCRIPT_SELECT });
}

/** Per-role transcript count (opening-turn detection) under the same switch. */
export async function countCodingTranscriptMessages(chatId: string, role: string): Promise<number> {
  const source = await pickTranscriptSource(chatId);
  if (source === 'legacy') return prisma.codingMessage.count({ where: { chatId, role } });
  return prisma.crossModelMessage.count({ where: { chatId, role } });
}

/** Fresh title read off the chat row (the source of truth — see toLegacySession). */
export async function getCodingSessionTitle(chatId: string): Promise<string | null> {
  const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { title: true } });
  return chat?.title ?? null;
}

/** Title PROVENANCE (ticket 161d39e9): 'spawn-param' = the title came from an
 *  explicit start_coding_session `title` argument (NULL = default/derived) —
 *  the executor's sticky-title gate keys on it. */
export async function getCodingSessionTitleSource(chatId: string): Promise<string | null> {
  const state = await prisma.chatCodingState.findUnique({ where: { id: chatId }, select: { titleSource: true } });
  return state?.titleSource ?? null;
}

/** Oldest user transcript message text (title-repair input) under the same switch. */
export async function getFirstUserCodingMessage(chatId: string): Promise<string | null> {
  const source = await pickTranscriptSource(chatId);
  const row = source === 'legacy'
    ? await prisma.codingMessage.findFirst({ where: { chatId, role: 'user' }, orderBy: { createdAt: 'asc' }, select: { content: true } })
    : await prisma.crossModelMessage.findFirst({ where: { chatId, role: 'user' }, orderBy: { createdAt: 'asc' }, select: { content: true } });
  return row?.content ?? null;
}

/**
 * Run-finalize strip for SUPERVISOR lanes (rollout watch 2026-09-14). A
 * fleet/project supervisor is a plain chat by design; the send-time router
 * lazily attached a workspace to two project supervisors before the
 * isProjectSupervisor guards existed, so their wakes ran as CODING runs (a
 * worker slot per wake, a worktree on box C). The 15-min heal
 * (project-supervisor.service stripStrayCodingState) never catches a lane
 * that wakes back-to-back — canlegal-bench's supervisor ran 6 consecutive
 * coding runs 12:41→13:48Z — so run-executor calls THIS at its own finalize,
 * when the lane is provably idle: cancel any queued coding wakes (the worker
 * must never claim a run whose session row is gone; the lane's next hook /
 * schedule wake runs as a plain chat) and delete the satellite. prisma-only
 * (this module is already a static import of run-executor — no platform
 * import chain, no test-harness process.exit). Never throws; false = no-op.
 */
export async function stripSupervisorCodingSatelliteAtFinalize(chatId: string): Promise<boolean> {
  try {
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: chatId },
      select: { userId: true, isSupervisor: true, isProjectSupervisor: true },
    });
    if (!chat || !(chat.isSupervisor === true || (chat as any).isProjectSupervisor === true)) return false;
    const state = await prisma.chatCodingState.findUnique({ where: { id: chatId }, select: { id: true, branch: true, worktreePath: true } });
    if (!state) return false;
    const running = await prisma.agentRun.count({ where: { sessionId: chatId, status: 'running' } });
    if (running > 0) return false; // another run claimed it already — its finalize will strip
    const cancelled = await prisma.agentRun.updateMany({
      where: { sessionId: chatId, status: 'queued' },
      data: { status: 'cancelled', error: 'supervisor lane restored to a plain chat — this queued coding wake is superseded by the lane\'s next hook/schedule wake', finishedAt: new Date() },
    });
    await prisma.chatCodingState.delete({ where: { id: chatId } });
    await prisma.activity.create({
      data: {
        userId: chat.userId,
        action: 'project_supervisor.strip_coding_state',
        resource: 'platform',
        metadata: {
          chatId, branch: state.branch, worktreePath: state.worktreePath, cancelledQueuedRuns: cancelled?.count ?? 0, path: 'run-finalize',
          reason: 'supervisor lanes are plain chats by design — a lazily attached workspace satellite was removed at run finalize (rollout watch 2026-09-14)',
        } as any,
      },
    }).catch(() => {});
    logger.warn(`coding-data: stripped stray coding satellite from supervisor lane ${chatId.slice(0, 8)} at finalize (branch ${state.branch}${cancelled?.count ? `, ${cancelled.count} queued wake(s) cancelled` : ''})`);
    return true;
  } catch (err: any) {
    logger.warn(`coding-data: finalize supervisor strip failed for ${chatId.slice(0, 8)}: ${err?.message}`);
    return false;
  }
}
