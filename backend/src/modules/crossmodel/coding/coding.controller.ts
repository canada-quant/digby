/**
 * Digby Code — REST controller (projects, sessions, GitHub repo listing).
 *
 * The agentic run endpoint (SSE) lives in coding-stream.controller.ts (P2).
 * All routes are auth-required + adult-only (rejectChild in the routes file).
 */

import { Request, Response } from 'express';
import axios from 'axios';
import prisma from '../../../config/database';
import { killSwitchOn } from '../../../utils/kill-switch';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import * as platformService from '../platform/platform.service';
import { getAllValidTokens, getValidToken } from '../github/token-manager';
import {
  removeWorktree,
  removeSessionEnv,
  git,
  worktreePath,
} from './workspace.service';
import { getPlan, applyPlan, planToUpdate, PlanUpdate, PlanStepStatus } from './plan.service';
import { commitKnowledgeFile } from './project-workspace.service';
import {
  listCodingProjects, createCodingProject, getCodingProjectForUser, deleteCodingProjectData,
  listCodingChats, getSessionForUser, updateSessionState,
  listCodingTranscript, listCodingTranscriptPage, stripInlineImageData, listRunningSessionIdsForUser,
  CodingProjectShape, CodingTranscriptRow,
} from './coding-data.service';
import { clearSessionMemory } from './coding-retrieval.service';
import { loadSessionUsage } from './usage-store';
import { getScheduleHealth } from './schedule.service';
import { listCredentials, upsertCredential, deleteCredential } from './credentials.service';
import { invalidateIntegrationStatusCache } from '../langgraph/integration-status-cache';
import { storeGet } from '../memory/context-store';
import { stopSessionContainer, removeSandboxHome } from './container.service';
import { resolveViewModeForRequest } from '../view/view-mode';
import { minimalMessages } from '../view/minimal-view';
import { annotateCredentialPaste } from '../platform/credential-paste';

const PERMISSION_MODES = new Set(['auto', 'plan', 'ask']);

/**
 * Transcript rows carry their metadata since 2026-09-15 (provenance stamps,
 * status cards). The one audit-only key — the evidence guard's pre-strike
 * `guardOriginal` text, ≤20k chars per struck row — never renders anywhere in
 * the client, so it is dropped from the response; everything else passes.
 */
function omitGuardOriginal(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata ?? undefined;
  if (!('guardOriginal' in (metadata as Record<string, unknown>))) return metadata;
  const { guardOriginal: _dropped, ...rest } = metadata as Record<string, unknown>;
  return rest;
}
const TODO_STATUSES: PlanStepStatus[] = ['pending', 'in_progress', 'completed', 'blocked'];
/** Lane lifecycle C3 (2026-10-21): =1 restores the satellite-only session-API archive (no archivedAt stamp). */
export function sessionApiArchiveStampDisabled(): boolean {
  return killSwitchOn(process.env.SESSION_API_ARCHIVE_STAMP_DISABLED);
}
/** Ceiling for getSession's `messageLimit` paging param (session-open perf). */
const TRANSCRIPT_PAGE_MAX = 200;

/**
 * Best-effort audit trail (Activity, resource 'platform') — mirrors
 * platform.service. This REST controller's delete paths bypass
 * platform.service, so their cascades must write their own rows
 * (feedback 138b0347: a chat vanished with zero signal).
 */
async function audit(userId: string, action: string, metadata?: Record<string, any>): Promise<void> {
  try {
    await prisma.activity.create({
      data: { userId, action, resource: 'platform', ...(metadata ? { metadata } : {}) },
    });
  } catch (err: any) {
    logger.warn(`coding audit write failed (${action}): ${err.message}`);
  }
}

class CodingController {
  // ── GitHub repos the user can import ──────────────────────────────────────
  async listGithubRepos(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const accounts = await getAllValidTokens(userId);
      if (accounts.length === 0) {
        return res.json({ success: true, data: { connected: false, repos: [] } });
      }
      // Merge repos across all connected accounts (dedupe by full_name).
      const byName = new Map<string, any>();
      for (const acct of accounts) {
        try {
          const resp = await axios.get('https://api.github.com/user/repos', {
            headers: { Authorization: `Bearer ${acct.token}`, Accept: 'application/vnd.github+json' },
            params: { per_page: 100, sort: 'updated', affiliation: 'owner,collaborator,organization_member' },
            timeout: 15000,
          });
          for (const r of resp.data as any[]) {
            byName.set(r.full_name, {
              fullName: r.full_name,
              name: r.name,
              cloneUrl: r.clone_url,
              defaultBranch: r.default_branch || 'main',
              private: r.private,
              updatedAt: r.updated_at,
              githubLabel: acct.label,
            });
          }
        } catch (err: any) {
          logger.warn(`coding: repo list failed for account ${acct.label}: ${err.message}`);
        }
      }
      const repos = Array.from(byName.values()).sort((a, b) =>
        (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      res.json({ success: true, data: { connected: true, repos } });
    } catch (err: any) {
      logger.error(`coding.listGithubRepos error: ${err.message}`);
      res.status(500).json({ error: 'Failed to list repositories' });
    }
  }

  // ── Projects ──────────────────────────────────────────────────────────────
  async listProjects(req: Request, res: Response) {
    const userId = req.user!.id;
    const projects = await listCodingProjects(userId);
    res.json({ success: true, data: projects });
  }

  // Ids of the caller-visible sessions currently 'running'. The sidebar polls
  // this to reconcile its spinner against server truth — a run that finished
  // while its view was unmounted (or its SSE died) must stop spinning.
  async listRunningSessions(req: Request, res: Response) {
    try {
      const runningIds = await listRunningSessionIdsForUser(req.user!.id);
      res.json({ success: true, data: { runningIds } });
    } catch (err: any) {
      logger.error(`coding.listRunningSessions error: ${err.message}`);
      res.status(500).json({ error: 'Failed to list running sessions' });
    }
  }


  /**
   * One-Digby C5: commit a chat canvas into the project repo's knowledge branch
   * ("Save to project" in the Artifacts panel). Owner-only; requires a project
   * with a provisioned git workspace (github/git provider).
   */
  async commitCanvasKnowledge(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { projectId } = req.params;
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      if (!name || !content) return res.status(400).json({ error: 'name and content are required' });
      if (content.length > 500_000) return res.status(400).json({ error: 'Canvas too large to commit' });

      const project = await prisma.crossModelProject.findFirst({ where: { id: projectId, userId } });
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (!project.repoProvider || project.repoProvider === 'blank') {
        return res.status(409).json({ error: 'This project has no repository workspace yet — connect a repo in the project settings first.' });
      }

      const ok = await commitKnowledgeFile(projectId, { name, mimeType: 'text/markdown', text: content });
      if (!ok) return res.status(409).json({ error: 'Workspace not provisioned yet — open a coding session in this project first, then retry.' });
      res.json({ success: true, message: `Committed "${name}" to the project knowledge branch` });
    } catch (err: any) {
      logger.error(`coding.commitCanvasKnowledge error: ${err.message}`);
      res.status(500).json({ error: 'Failed to commit canvas to project' });
    }
  }

  async importProject(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { name, repoUrl, defaultBranch, githubLabel, provider } = req.body || {};
      const isBlank = provider === 'blank';

      if (!isBlank) {
        if (!repoUrl || typeof repoUrl !== 'string') {
          return res.status(400).json({ error: 'repoUrl is required' });
        }
        // Same SSRF jail as POST /projects/:id/workspace + the import_repo tool
        // (capability gap review 2026-09-24: this route only checked the scheme).
        const { validateRepoUrl } = await import('./project-workspace.service');
        const urlError = validateRepoUrl(repoUrl);
        if (urlError) {
          return res.status(400).json({ error: urlError });
        }
      } else if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'A project name is required for a blank project' });
      }

      const derivedName = isBlank
        ? String(name).trim()
        : ((name && String(name).trim()) || repoUrl.replace(/\.git$/, '').split('/').slice(-1)[0] || 'project');

      const project = await createCodingProject({
        userId,
        name: derivedName,
        repoUrl: isBlank ? '' : repoUrl,
        defaultBranch: (defaultBranch && String(defaultBranch)) || 'main',
        provider: isBlank ? 'blank' : (provider === 'git' ? 'git' : 'github'),
        githubLabel: isBlank ? null : (githubLabel || null),
      });
      res.json({ success: true, data: project });
    } catch (err: any) {
      logger.error(`coding.importProject error: ${err.message}`);
      res.status(500).json({ error: 'Failed to import project' });
    }
  }

  async deleteProject(req: Request, res: Response) {
    const userId = req.user!.id;
    const { id } = req.params;
    const project = await getCodingProjectForUser(id, userId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // Best-effort cleanup for every coding chat: stop its container + background
    // processes, then remove the worktree. (Retrieval chunks cascade via delete.)
    const states = await prisma.chatCodingState.findMany({ where: { projectId: id }, select: { id: true } });
    for (const st of states) {
      await stopSessionContainer(st.id).catch(() => {});
      await removeSandboxHome(st.id).catch(() => {}); // durable HOME (e267b760) too
      await clearSessionMemory(st.id).catch(() => {});
      await removeWorktree(project.id, st.id).catch(() => {});
      await removeSessionEnv(st.id).catch(() => {}); // delete the env-seed sidecar too
      // Ticket 1c767622: the chat rows die with the project — drop the shared
      // snapshot too (reap deliberately keeps it; delete does not).
      const { deleteWorktreeSnapshot } = await import('./worktree-snapshot.service');
      await deleteWorktreeSnapshot(st.id).catch(() => {});
    }
    await deleteCodingProjectData(project.id);
    // Attribution (feedback 138b0347): per-chat rows for the cascade + the
    // umbrella project.delete — this REST path bypasses platform.service's
    // deleteProject (which writes its own rows).
    for (const st of states) {
      await audit(userId, 'chat.auto_delete', { chatId: st.id, projectId: project.id, reason: 'project delete cascade (coding API)' });
    }
    await audit(userId, 'project.delete', { projectId: project.id, via: 'coding.deleteProject' });
    res.json({ success: true });
  }

  // ── Sessions ────────────────────────────────────────────────────────────────
  async listSessions(req: Request, res: Response) {
    const userId = req.user!.id;
    const { projectId } = req.params;
    // Owner or project member may list (read); mutations stay owner-only.
    let project = await getCodingProjectForUser(projectId, userId);
    if (!project) {
      const member = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } }, select: { role: true },
      });
      if (member) {
        const p = await prisma.crossModelProject.findFirst({ where: { id: projectId, repoProvider: { not: null } } });
        if (p) project = { ...p, repoUrl: p.repoUrl ?? '', provider: p.repoProvider ?? 'blank' } as unknown as CodingProjectShape;
      }
    }
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const sessions = await listCodingChats(projectId);
    res.json({ success: true, data: sessions });
  }

  async createSession(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { projectId } = req.params;
      const { title, permissionMode } = req.body || {};
      // P1 platform unification: the session-start path (authz, prefs, chat+state
      // creation, branch, continuity, background provisioning) lives in
      // platform.service.startCodingSession — shared with the start_coding_session
      // platform tool so agent loops and HTTP get identical behavior.
      const session = await platformService.startCodingSession({
        userId,
        projectId,
        title: title ? String(title) : undefined,
        permissionMode: permissionMode ? String(permissionMode) : undefined,
      });
      // First-party visitor analytics (owner 2026-10-07): a human-started coding session is a funnel step.
      void import('../visitors/visitor.service').then((m) => m.recordServerVisitEvent({ type: 'coding_session_started', userId, req: req as any, props: { via: 'ui' } })).catch(() => {});
      res.json({ success: true, data: session });
    } catch (err: any) {
      if (err instanceof AppError && err.statusCode < 500) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      logger.error(`coding.createSession error: ${err.message}`);
      res.status(500).json({ error: 'Failed to create session' });
    }
  }

  async getSession(req: Request, res: Response) {
    const userId = req.user!.id;
    const { id } = req.params;
    const session = await getSessionForUser(id, userId, 'read', { includeProject: true });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // The transcript comes from crossmodel_messages — the only transcript table
    // since MERGE-1 completed (2026-11-04); the legacy table is never read.
    // Paged transcript (2026-08-31 session-open perf): `messageLimit` returns the
    // NEWEST N rows + hasMoreMessages/nextMessagesBefore (pass as
    // `messagesBefore` for the next older page) — the session view always pages,
    // the full unpaged read remains for old clients.
    const rawLimit = parseInt(String(req.query.messageLimit ?? ''), 10);
    const messageLimit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), TRANSCRIPT_PAGE_MAX) : undefined;
    const messagesBefore = typeof req.query.messagesBefore === 'string' && req.query.messagesBefore ? req.query.messagesBefore : undefined;
    let messages: CodingTranscriptRow[];
    let hasMoreMessages: boolean | undefined;
    let nextMessagesBefore: string | undefined;
    try {
      if (messageLimit !== undefined) {
        const page = await listCodingTranscriptPage(id, { limit: messageLimit, before: messagesBefore });
        messages = page.rows;
        hasMoreMessages = page.hasMore;
        nextMessagesBefore = page.nextBefore;
      } else {
        messages = await listCodingTranscript(id);
      }
    } catch (err: any) {
      if (err instanceof AppError && err.statusCode < 500) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      throw err;
    }
    // Legacy shape: messages carry sessionId (the chat id). metadata rides the
    // row since 2026-09-15 (provenance stamps + status cards); the audit-only
    // guardOriginal attachment (≤20k chars per struck row) is dropped from the
    // response — no client reads it.
    const legacyMessages = messages.map(m => ({ ...m, sessionId: m.chatId, metadata: omitGuardOriginal((m as any).metadata) }));
    // Ticket f95e1e30 (part 2): the one-tap "vault this" flag on the OWNER's own
    // pastes, derived per read (platform/credential-paste.ts). Computed AFTER the
    // guardOriginal strip so a struck attachment can never contribute a span, and
    // owner-only — this view also serves project members at read access, and a
    // member must not see a button the vault route would 404 on.
    if (session.userId === userId) {
      for (const m of legacyMessages as any[]) m.metadata = annotateCredentialPaste(m, { ownerViewer: true });
    }
    // Inline base64 images → lazy same-origin URLs (payload can be tens of MB
    // of screenshots otherwise; getMessageImage serves the bytes on demand).
    stripInlineImageData(id, legacyMessages);
    // Durable whole-session token/cost totals (sidebar meter seed on open) +
    // UI prefs the agent configured for the user (e.g. the preview port a dev
    // server it started declared via ready.port) + schedule heartbeat health
    // (active monitors with lastFiredAt/lastStatus — status readers can see a
    // silently-skipped or stalled heartbeat instead of a bare running flag).
    const [sessionUsage, uiState, scheduleHealth] = await Promise.all([
      loadSessionUsage(id).catch(() => null),
      storeGet<{ previewPort?: number }>([id, 'coding-ui'], 'state').catch(() => null),
      getScheduleHealth(id).catch(() => null),
    ]);
    // Minimal view (2026-10-16, view/minimal-view.ts): no machinery, no model ids, no token / cost figures.
    const minimal = (await resolveViewModeForRequest(req as any)) === 'minimal';
    const viewSession: any = minimal ? { ...session, model: undefined } : session;
    res.json({
      success: true,
      data: {
        ...viewSession,
        messages: minimal ? minimalMessages(legacyMessages) : legacyMessages,
        sessionUsage: minimal ? null : sessionUsage,
        uiState, scheduleHealth,
        ...(messageLimit !== undefined
          ? { hasMoreMessages, ...(nextMessagesBefore ? { nextMessagesBefore } : {}) }
          : {}),
      },
    });
  }

  /**
   * Lazy binary for a transcript image part — getSession strips inline base64
   * into this URL so the transcript payload stays lean; the <img> fetches the
   * bytes only when rendered (auth: the app-level guard via the same-origin
   * cm_access cookie, no token param needed).
   */
  async getMessageImage(req: Request, res: Response) {
    const userId = req.user!.id;
    const { id, messageId, partIndex } = req.params;
    const session = await getSessionForUser(id, userId, 'read');
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const idx = Number.parseInt(partIndex, 10);
    if (!Number.isInteger(idx) || idx < 0 || String(idx) !== partIndex) {
      return res.status(400).json({ error: 'Invalid part index' });
    }
    // `crossmodel_messages` is the only transcript table (MERGE-1 complete), so
    // the row id resolves there and nowhere else.
    const row = await prisma.crossModelMessage.findUnique({
      where: { id: messageId },
      select: { chatId: true, parts: true },
    });
    if (!row || row.chatId !== id) return res.status(404).json({ error: 'Message not found' });
    const part = Array.isArray(row.parts) ? (row.parts as any[])[idx] : null;
    if (!part || part.type !== 'image' || typeof part.data !== 'string' || !part.data) {
      return res.status(404).json({ error: 'Image not found' });
    }
    const buf = Buffer.from(part.data, 'base64');
    res.setHeader('Content-Type', typeof part.mediaType === 'string' && part.mediaType ? part.mediaType : 'application/octet-stream');
    res.setHeader('Content-Length', buf.length);
    // Image parts live in user/steer rows, which are never rewritten after
    // insert (only the in-flight assistant row is) — cache for an hour.
    // private: the bytes are owner-only behind the auth guard.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  }

  async updateSession(req: Request, res: Response) {
    const userId = req.user!.id;
    const { id } = req.params;
    const { title, permissionMode, archived, model } = req.body || {};
    const session = await getSessionForUser(id, userId, 'owner');
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const data: any = {};
    if (typeof title === 'string' && title.trim()) data.title = title.trim();
    if (PERMISSION_MODES.has(permissionMode)) data.permissionMode = permissionMode;
    // Per-session model (capability gap audit T2, 2026-09-24): the REST twin of
    // set_session_model — validated like the project pick; stamped 'explicit' so
    // run-executor keeps it over the project default. Applies to the next run.
    if (typeof model === 'string' && model.trim()) {
      const { resolveOneCodingPick } = await import('./coding-data.service');
      const resolved = await resolveOneCodingPick(model.trim(), userId);
      if (!resolved) return res.status(400).json({ error: `"${model.trim()}" is not a built-in coding model or an enabled, [coding]-flagged "<label>:<modelId>" endpoint model.` });
      data.model = resolved;
      data.modelSource = 'explicit';
    }
    // Archive / unarchive. Don't clobber an in-flight run's status.
    if (typeof archived === 'boolean' && session.status !== 'running') {
      // One-Digby 1B: unarchive always lands on 'ready' — a missing worktree is
      // re-provisioned on demand by the run start path (fixes the latent
      // unarchive-never-provisions gap).
      data.status = archived ? 'archived' : 'ready';
    }
    await updateSessionState(id, data);
    // 90d71ae7 (2026-09-10): unarchiving via the SESSION API must complete the
    // unarchive — the archive_chat path parks BOTH the satellite and the chat's
    // archivedAt stamp; clearing only the satellite leaves the chat invisible
    // to list_chats while its session runs. (The ARCHIVE direction used to
    // deliberately NOT stamp the chat — "satellite-archived sessions keep their
    // list visibility"; since 2026-10-21 it stamps it too, see below.)
    if (archived === false && session.status === 'archived') {
      // SESSION-API ARCHIVE STAMP review fixer (2026-10-21): the archive half goes
      // through archiveChat (C3), so the restore half does too whenever the chat
      // row is stamped — the cascade restore (children the archive took come
      // back), the lane-retire restore marker, the audit row and the sidebar push
      // ride along, plus the same hook / schedule re-arm. A refusal, a row that
      // reads unstamped (a satellite-only archive) or SESSION_API_ARCHIVE_STAMP_DISABLED=1
      // keeps the direct clear below.
      let viaArchiveChat = false;
      if (!sessionApiArchiveStampDisabled()) {
        const row = await Promise.resolve().then(() => prisma.crossModelChat.findUnique({ where: { id }, select: { archivedAt: true } })).catch(() => null);
        if (row?.archivedAt) {
          try {
            await platformService.archiveChat({ userId, chatId: id, archived: false, source: 'session_api' });
            viaArchiveChat = true;
          } catch (err: any) {
            logger.info(`updateSession: chat ${id} restored directly (archiveChat ${err?.statusCode ?? '-'}: ${err?.message ?? err})`);
          }
        }
      }
      if (!viaArchiveChat) {
        await prisma.crossModelChat.updateMany({ where: { id }, data: { archivedAt: null } }).catch(() => {});
        // audit 2026-10-08 W3-5: re-arm the hooks the archive paused (archiveChat's restore does the same).
        void import('../platform/hooks.service').then((m) => m.resumeHooksForRestoredChat(id)).catch(() => {});
        // ARCHIVED-TARGET-RETIRE (2026-10-20): …and the schedules it paused.
        void import('./schedule.service').then((m) => m.resumeSchedulesForRestoredChat(id)).catch(() => {});
        // Lane lifecycle second review fixer (2026-10-21): the direct clear is a
        // restore too — remember it, or lane-retire (which never reads
        // chat.updatedAt) re-archives the lane on its next pass. Written only
        // while a marker reader is on (all switches set = nothing written).
        void import('../platform/lane-family-facts').then((m) => m.rememberLaneRestore(id, { source: 'session_api' })).catch(() => {});
      }
    }
    // ARCHIVED-TARGET-RETIRE (d, 2026-10-20): archiving through the SESSION API
    // used to leave the lane's schedules + hooks live — every firing / wake was
    // then refused at dispatch forever (the satellite is 'archived', the heal
    // refuses machine wakes). Retire the lane's machine work like archiveChat
    // does: pause its schedules (remembered — the restore above re-arms
    // exactly them), pause its hooks, unassign its live todos (one todo_wake
    // to the supervisor). Best-effort, after the state write; kill switch
    // ARCHIVED_TARGET_RETIRE_DISABLED=1.
    if (archived === true && data.status === 'archived' && session.status !== 'archived') {
      const retire = await import('../platform/archived-target-retire').catch(() => null);
      if (retire && !retire.archivedTargetRetireDisabled()) {
        try {
          const { pauseSchedulesForLaneArchive } = await import('./schedule.service');
          await pauseSchedulesForLaneArchive(id, { archiveRetire: { detail: 'the owner archived this coding session' } });
        } catch { /* best-effort */ }
        try {
          const hooksMod = await import('../platform/hooks.service');
          await hooksMod.pauseHooksForArchivedSource(userId, id);
        } catch { /* best-effort */ }
        await retire.unassignTodosForArchivedLane({ userId, chatId: id, source: 'session_archive' });
      }
      // SESSION-API ARCHIVE STAMP (lane lifecycle C3, 2026-10-21): the archive
      // also stamps crossmodel_chats.archivedAt through archiveChat (audit row,
      // sidebar push, cascade) — a satellite-only archive left the chat in the
      // sidebar for good (prod: 5 such chats) and every reaper skips a satellite
      // already 'archived'. The web client no longer calls this door (its
      // archiveSession has no callers); API scripts do. The satellite is already
      // 'archived' (no re-flip) and the schedules are paused above; a refusal
      // (e.g. a 409 because ARCHIVED_TARGET_RETIRE_DISABLED=1 left them enabled)
      // keeps today's satellite-only state. SESSION_API_ARCHIVE_STAMP_DISABLED=1
      // restores the satellite-only archive.
      if (!sessionApiArchiveStampDisabled()) {
        try {
          await platformService.archiveChat({ userId, chatId: id, source: 'session_api' });
        } catch (err: any) {
          logger.info(`updateSession: chat ${id} stays satellite-archived (archiveChat ${err?.statusCode ?? '-'}: ${err?.message ?? err})`);
        }
      }
    }
    const updated = await getSessionForUser(id, userId, 'owner');
    res.json({ success: true, data: updated });
  }

  async deleteSession(req: Request, res: Response) {
    const userId = req.user!.id;
    const { id } = req.params;
    const session = await getSessionForUser(id, userId, 'owner');
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // P5-B: delegate to the CHAT delete (DELETE /chats/:id is the canonical
    // equivalent) — same owner-only rule, same runtime cleanup (container,
    // worktree, session memory) + satellite delete.
    try {
      const { default: crossModelService } = await import('../crossmodel.service');
      await crossModelService.deleteChat(id, userId);
    } catch (err: any) {
      return res.status(err.statusCode || 500).json({ error: err.message || 'Failed to delete session' });
    }
    res.json({ success: true });
  }

  /** Push the session branch to GitHub (UI button). */
  async pushSession(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const session = await getSessionForUser(id, userId, 'owner', { includeProject: true });
      if (!session || !session.worktreePath || !session.project) return res.status(404).json({ error: 'Session not ready' });
      const { pushSessionBranch } = await import('./tools');
      const result = await pushSessionBranch({
        worktree: worktreePath(session.id), sessionId: session.id, userId,
        permissionMode: 'auto', emit: () => {}, alwaysAllow: new Set(),
        execShell: async () => ({ stdout: '', stderr: '' }),
        requestApproval: async () => 'allow',
        repoUrl: session.project!.repoUrl, provider: session.project!.provider,
        projectId: session.project!.id, projectName: session.project!.name,
        branch: session.branch, baseBranch: session.baseBranch,
        getGithubToken: () => getValidToken(userId, session.project!.githubLabel || undefined),
        // Explicit human "Push" click (mirrors prGateBypass on the PR button):
        // user-present, and the click itself is the base-push confirmation.
        userTurnAt: new Date(),
      }, { allowBase: true });
      const ok = result.startsWith('Pushed');
      res.json({ success: ok, data: { message: result } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Open a PR from the session branch (UI button). */
  async openSessionPr(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const { title, body } = req.body || {};
      const session = await getSessionForUser(id, userId, 'owner', { includeProject: true });
      if (!session || !session.worktreePath || !session.project) return res.status(404).json({ error: 'Session not ready' });
      const { executeCodingTool } = await import('./tools');
      const result = await executeCodingTool({
        worktree: worktreePath(session.id), sessionId: session.id, userId,
        permissionMode: 'auto', emit: () => {}, alwaysAllow: new Set(),
        execShell: async () => ({ stdout: '', stderr: '' }),
        requestApproval: async () => 'allow',
        repoUrl: session.project!.repoUrl, provider: session.project!.provider,
        projectId: session.project!.id, projectName: session.project!.name,
        branch: session.branch, baseBranch: session.baseBranch,
        getGithubToken: () => getValidToken(userId, session.project!.githubLabel || undefined),
        prGateBypass: true, // explicit human "Open PR" click — not gated on verify (also skips the post-push CI poll: a UI click must not hang ~30s)
        userTurnAt: new Date(), // human click = user-present (base-push guard)
      }, 'open_pull_request', { title: title || `Digby Code: ${session.title}`, body: body || '' });
      const ok = result.startsWith('Opened PR');
      res.json({ success: ok, data: { message: result } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /** Git status/diff for the session worktree (for the UI's changes view). */
  async getSessionDiff(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      // T4b (2026-09-24): ONE implementation with the get_session_diff tool —
      // on a web box the diff rides the Redis request/reply to the box that
      // hosts the worktree instead of silently answering an empty tree.
      const { sessionDiffForUser } = await import('./session-diff');
      const d = await sessionDiffForUser(id, userId);
      if (!d) {
        return res.status(404).json({ error: 'Session worktree not ready' });
      }
      res.json({
        success: true,
        data: { status: d.status, diffStat: d.diffStat, branch: d.branch, source: d.source },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  // ── CLI/API credentials (Cloudflare, AWS, Namecheap, Brev, custom) ────────
  /** Masked summaries only — the API never returns a stored value. */
  async listCodingCredentials(req: Request, res: Response) {
    const rows = await listCredentials(req.user!.id);
    res.json({ success: true, data: rows });
  }

  /** Upsert one env-key credential (write-only; validated + deny-listed). Optional
   *  `label` stores an ADDITIONAL credential under the same env key (injected as
   *  envKey_LABEL) instead of overwriting the primary. */
  async saveCodingCredential(req: Request, res: Response) {
    const { provider, envKey, value, label } = req.body || {};
    try {
      const row = await upsertCredential(req.user!.id, String(provider || 'custom'), String(envKey || ''), String(value || ''), String(label || ''));
      // Ticket c02b85bf: the chat-side integration-status block now lists the
      // NAMES of stored credentials — drop its Redis cache so the new key is
      // visible to the next chat turn, not after the 5-min TTL.
      invalidateIntegrationStatusCache(req.user!.id).catch(() => {});
      res.json({ success: true, data: row });
    } catch (e: any) {
      res.status(400).json({ error: e.message || 'Could not save credential' });
    }
  }

  async deleteCodingCredential(req: Request, res: Response) {
    const ok = await deleteCredential(req.user!.id, String(req.params.id || ''));
    if (!ok) return res.status(404).json({ error: 'Credential not found' });
    invalidateIntegrationStatusCache(req.user!.id).catch(() => {});
    res.json({ success: true });
  }

  // ── Shared tailnet dev container (owner decision 2026-08-22, 3ba5d35d) ────
  /** Live status: enabled/running/tailscale state — never the auth key. */
  // 2026-10-13: every dev-container operation is ROUTED to the box that has
  // Docker (dev-container-remote.ts) — the web boxes have none since
  // 2026-09-24, so the in-process calls reported a fake "not running" and
  // Restart was a no-op. DEV_CONTAINER_REMOTE_OPS_DISABLED=1 restores them.
  async getDevContainerStatus(req: Request, res: Response) {
    const { routedDevContainerStatus } = await import('./dev-container-remote');
    res.json({ success: true, data: await routedDevContainerStatus(req.user!.id) });
  }

  /** Answer a routed dev-container action: started/done 200, refused 409, unreachable 503. */
  private async sendDevContainerAction(req: Request, res: Response, action: 'restart' | 'tailnet_restart' | 'tailnet_reconnect') {
    const { routedDevContainerAction } = await import('./dev-container-remote');
    const r = await routedDevContainerAction(req.user!.id, action);
    if (r.kind === 'refused') return res.status(409).json({ success: false, error: r.note, data: r.status });
    if (r.kind === 'unreachable') return res.status(503).json({ success: false, error: r.note, data: r.status });
    return res.json({ success: true, data: r.status });
  }

  /** Recreate the user's dev container from scratch (fresh tailnet join with the saved key). */
  async restartDevContainer(req: Request, res: Response) {
    return this.sendDevContainerAction(req, res, 'restart');
  }

  /** Bounce ONLY tailscaled inside the dev container (mid-run-safe recourse). */
  async restartDevTailnet(req: Request, res: Response) {
    return this.sendDevContainerAction(req, res, 'tailnet_restart');
  }

  /** Rejoin the running dev container to the tailnet with the SAVED key (mid-run safe; 2026-10-13). */
  async reconnectDevTailnet(req: Request, res: Response) {
    return this.sendDevContainerAction(req, res, 'tailnet_reconnect');
  }

  // ── Per-session tailnet egress scoping (ticket 4ed6eb2e) ─────────────────
  /** The per-user default tailnet egress allowlist (null = allow-all). */
  async getTailnetEgressPolicy(req: Request, res: Response) {
    const { getUserEgressPolicy } = await import('./dev-container.service');
    res.json({ success: true, data: await getUserEgressPolicy(req.user!.id) });
  }

  /** Set the per-user default allowlist: body { allow: string[] | null }.
   *  Validated rule strings (host / .suffix / CIDR / *, optional :port);
   *  null clears back to allow-all. Live-pushed to the running container. */
  async saveTailnetEgressPolicy(req: Request, res: Response) {
    const { routedSaveUserEgressPolicy: saveUserEgressPolicy } = await import('./dev-container-remote');
    try {
      const raw = req.body && Object.prototype.hasOwnProperty.call(req.body, 'allow') ? req.body.allow : undefined;
      if (raw === undefined) return res.status(400).json({ error: 'body must be { "allow": string[] | null }' });
      res.json({ success: true, data: await saveUserEgressPolicy(req.user!.id, raw) });
    } catch (e: any) {
      res.status(400).json({ error: e.message || 'Invalid egress policy' });
    }
  }

  /** Set a per-SESSION tailnet egress override: body { allow: string[] | null }.
   *  null clears the override (session inherits the user default). Owner-only;
   *  404 for other users' sessions (no existence leak). */
  async saveSessionTailnetEgress(req: Request, res: Response) {
    const sessionId = String(req.params.id || '');
    const row = await prisma.chatCodingState.findUnique({ where: { id: sessionId }, select: { userId: true } }).catch(() => null);
    if (!row || row.userId !== req.user!.id) return res.status(404).json({ error: 'Session not found' });
    const { routedSaveSessionEgressOverride } = await import('./dev-container-remote');
    try {
      const raw = req.body && Object.prototype.hasOwnProperty.call(req.body, 'allow') ? req.body.allow : undefined;
      if (raw === undefined) return res.status(400).json({ error: 'body must be { "allow": string[] | null }' });
      res.json({ success: true, data: await routedSaveSessionEgressOverride(req.user!.id, sessionId, raw) });
    } catch (e: any) {
      res.status(400).json({ error: e.message || 'Invalid egress policy' });
    }
  }

  // ── Durable cron supervision (Phase 3) ───────────────────────────────────
  /**
   * Ops surface: the cron_jobs rows (last fire/status, next due, lease owner)
   * plus live agent_runs queue counts. Proves the worker's durable cron keeps
   * firing across deploys — after a deploy, lastFiredAt keeps advancing.
   */
  async getCronStatus(req: Request, res: Response) {
    try {
      const since24h = new Date(Date.now() - 24 * 3600 * 1000);
      const [jobs, byStatus, failedLast24h, completedLast24h] = await Promise.all([
        prisma.cronJob.findMany({ orderBy: { id: 'asc' } }),
        prisma.agentRun.groupBy({
          by: ['status'],
          where: { status: { in: ['queued', 'running', 'interrupted'] } },
          _count: { _all: true },
        }),
        prisma.agentRun.count({ where: { status: 'failed', finishedAt: { gte: since24h } } }),
        prisma.agentRun.count({ where: { status: 'completed', finishedAt: { gte: since24h } } }),
      ]);
      const runs = { queued: 0, running: 0, interrupted: 0, failedLast24h, completedLast24h };
      for (const g of byStatus) {
        if (g.status === 'queued' || g.status === 'running' || g.status === 'interrupted') {
          runs[g.status] = g._count._all;
        }
      }
      res.json({ success: true, data: { jobs, runs } });
    } catch (err: any) {
      logger.error(`coding.getCronStatus error: ${err.message}`);
      res.status(500).json({ error: 'Failed to load cron status' });
    }
  }

  // ── Plan / Goal / Todos (the sidebar's Overview) ──────────────────────────
  /** Current goal + acceptance criteria + todos for a session (or null). */
  async getSessionPlan(req: Request, res: Response) {
    const userId = req.user!.id;
    const { id } = req.params;
    const session = await getSessionForUser(id, userId, 'read');
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const plan = await getPlan(session.id);
    res.json({ success: true, data: { plan } });
  }

  /**
   * Apply a user-driven plan edit from the sidebar. Loads the current plan,
   * runs `transform` over its full-rewrite form, then feeds it through the same
   * applyPlan normalization the agent uses (so a user todo is indistinguishable
   * from one the agent added, and shows up in the next <plan> reminder). The plan
   * is locked while the agent is mid-run to avoid racing its own update_plan.
   */
  private async applyUserPlanMutation(
    req: Request,
    res: Response,
    transform: (u: ReturnType<typeof planToUpdate>) => PlanUpdate | null,
  ) {
    const userId = req.user!.id;
    const { id } = req.params;
    const session = await getSessionForUser(id, userId, 'owner');
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // Only edit the plan when the session is READY. While RUNNING it would race the
    // agent's own update_plan; while PROVISIONING the worktree doesn't exist yet, and
    // writing .digby/session/todo.md would create the directory early — ensureWorktree
    // then sees an existing path and returns a NON-git-worktree, permanently breaking
    // every later git tool in the session.
    if (session.status !== 'ready') {
      const why = session.status === 'running'
        ? 'The agent is running — the plan is locked until it finishes.'
        : `The session isn't ready yet (status: ${session.status}).`;
      return res.status(409).json({ error: why });
    }
    const current = await getPlan(session.id);
    const update = transform(planToUpdate(current));
    if (!update) return res.status(400).json({ error: 'Todo not found' });
    const wt = session.worktreePath || worktreePath(session.id);
    const { plan } = await applyPlan(session.id, wt, update);
    res.json({ success: true, data: { plan } });
  }

  /** Append a user-authored todo (a pending step) to the plan. */
  async addTodo(req: Request, res: Response) {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'Todo text is required' });
    return this.applyUserPlanMutation(req, res, (u) => {
      u.steps.push({ text, status: 'pending' });
      return u;
    });
  }

  /** Set a todo's status (checkbox / cycle in the sidebar). */
  async setTodoStatus(req: Request, res: Response) {
    const stepId = Number(req.params.stepId);
    const status = String(req.body?.status ?? '') as PlanStepStatus;
    if (!TODO_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    return this.applyUserPlanMutation(req, res, (u) => {
      const s = u.steps[stepId - 1];
      if (!s) return null;
      // A user marking one step in_progress means THAT one is now active — clear
      // any other in_progress first so applyPlan doesn't demote the clicked step.
      if (status === 'in_progress') u.steps.forEach(st => { if (st.status === 'in_progress') st.status = 'pending'; });
      s.status = status;
      return u;
    });
  }

  /** Remove a todo from the plan. */
  async deleteTodo(req: Request, res: Response) {
    const stepId = Number(req.params.stepId);
    return this.applyUserPlanMutation(req, res, (u) => {
      if (!u.steps[stepId - 1]) return null;
      u.steps.splice(stepId - 1, 1);
      return u;
    });
  }

  /** Set (or clear) the goal + optional acceptance criteria from the sidebar. */
  async setGoal(req: Request, res: Response) {
    const goal = String(req.body?.goal ?? '').trim();
    const rawAc = req.body?.acceptanceCriteria;
    const acceptanceCriteria = Array.isArray(rawAc)
      ? rawAc.map((c: any) => String(c).trim()).filter(Boolean)
      : undefined;
    return this.applyUserPlanMutation(req, res, (u) => {
      u.goal = goal;
      if (acceptanceCriteria) u.acceptance_criteria = acceptanceCriteria;
      return u;
    });
  }
}

export default new CodingController();
