import { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { AppError } from '../../middleware/error-handler';
import * as platformService from './platform/platform.service';
import { getProjectSettings } from './langgraph/memory.graph';
import { normalizePatienceMode } from './types';
import { getLatestProjectStatus } from './fleet/project-status.service';
import { resolveViewModeForRequest } from './view/view-mode';
import { displayParentNestingDisabled } from './platform/display-parent';
import { isFrameworkProject, frameworkProjectRefusal } from './platform/platform.service';

/**
 * Helper: check if the user owns the project or is a member
 */
async function getProjectForUser(projectId: string, userId: string, requireOwnerOrEditor = false) {
  const project = await prisma.crossModelProject.findUnique({
    where: { id: projectId },
    include: {
      members: true,
      _count: { select: { chats: true, documents: true } },
    },
  });

  if (!project) return null;

  // Owner always has full access
  if (project.userId === userId) return { project, role: 'owner' as const };

  // Check membership
  const member = project.members.find((m) => m.userId === userId);
  if (!member) return null;

  if (requireOwnerOrEditor && member.role === 'viewer') return null;

  return { project, role: member.role as 'viewer' | 'editor' | 'admin' };
}

// ── List projects ─────────────────────────────────────────────────────────────
export async function listProjects(req: Request, res: Response) {
  try {
    const userId = req.user!.id;

    // P2: platform.service owns the folder list (owned + shared), now with
    // parentId/depth/path on each folder so clients can assemble the tree.
    // ?archived=true = the Archived browse view; default excludes archived
    // subtrees. String-compared — Express query params arrive as strings.
    const tree = await platformService.getFolderTree({
      userId,
      archived: String(req.query.archived) === 'true',
    });
    res.json(tree);
  } catch (err) {
    logger.error('listProjects error:', err);
    res.status(500).json({ error: 'Failed to list projects' });
  }
}

// ── Create project ────────────────────────────────────────────────────────────
export async function createProject(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { name, description, systemPrompt, emoji, color, parentId } = req.body;

    // P1: platform.service owns creation (+ audit) — one implementation shared
    // with the agent platform tools. P2: parentId nests the folder.
    const project = await platformService.createProject({
      userId, name, description, systemPrompt, emoji, color,
      parentId: parentId ?? null,
    });

    res.status(201).json(project);
  } catch (err: any) {
    if (err instanceof AppError && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error('createProject error:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
}

// ── Move folder (P2 folder tree) ──────────────────────────────────────────────
export async function moveProject(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { parentId = null } = req.body || {};

    const folder = await platformService.moveFolder({ userId, folderId: id, newParentId: parentId });
    res.json(folder);
  } catch (err: any) {
    if (err instanceof AppError && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error('moveProject error:', err);
    res.status(500).json({ error: 'Failed to move project' });
  }
}

// ── Breadcrumbs (P2 folder tree) ──────────────────────────────────────────────
export async function getProjectBreadcrumbs(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const chain = await platformService.getBreadcrumbs({ userId, folderId: id });
    res.json({ breadcrumbs: chain });
  } catch (err: any) {
    if (err instanceof AppError && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error('getProjectBreadcrumbs error:', err);
    res.status(500).json({ error: 'Failed to get breadcrumbs' });
  }
}

// ── Sessions view (session titles + topology, 2026-09-27) ────────────────────
// GET /projects/:id/sessions[?archived=1]: per chat the title halves, pin,
// status (running | scheduled | idle | archived), last mutating receipt age,
// today's spend and the charter — computed from the goal→lane index the
// topology pre-check reads. Same access rule as getProject (any member).
export async function getProjectSessions(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const result = await getProjectForUser(id, userId);
    if (!result) return res.status(404).json({ error: 'Project not found' });
    const { listProjectSessions } = await import('./platform/project-sessions');
    const includeArchived = String(req.query.archived ?? '') === '1' || String(req.query.archived ?? '') === 'true';
    // The index is OWNER-scoped (lanes belong to the project owner's account) — a member reads the owner's rows.
    const ownerId = (result.project as any).userId ?? userId;
    const out = await listProjectSessions(id, ownerId, { includeArchived });
    // Minimal view (2026-10-16): no receipt age or spend for this viewer.
    if ((await resolveViewModeForRequest(req as any)) === 'minimal' && Array.isArray((out as any).sessions)) {
      res.json({ projectId: id, ...out, sessions: (out as any).sessions.map((r: any) => ({ ...r, lastReceiptAgeSec: null, spendTodayUsd: null })) });
      return;
    }
    res.json({ projectId: id, ...out });
  } catch (err: any) {
    if (err instanceof AppError && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error('getProjectSessions error:', err);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
}

// ── Usage (supervisor side panel, 2026-10-08) ───────────────────────────────
// GET /projects/:id/usage: project-wide spend + tokens (today / 7 d / 30 d, a 14-day series, top chats) from the
// run_spend / run_tokens_* loop_metrics of the project's chats — platform/usage-rollup.ts. Same access rule as
// /sessions (any member; the owner's rows).
export async function getProjectUsage(req: Request, res: Response) {
  try {
    const { projectUsage, supervisorUsageDisabled } = await import('./platform/usage-rollup');
    if (supervisorUsageDisabled()) return res.status(404).json({ error: 'Not found' });
    // Minimal view (2026-10-16): no cost or token figures for this viewer — the panel hides itself on a 404.
    if ((await resolveViewModeForRequest(req as any)) === 'minimal') return res.status(404).json({ error: 'Not found' });
    const userId = req.user!.id;
    const { id } = req.params;
    const result = await getProjectForUser(id, userId);
    if (!result) return res.status(404).json({ error: 'Project not found' });
    const ownerId = (result.project as any).userId ?? userId;
    res.json(await projectUsage(id, ownerId));
  } catch (err: any) {
    logger.error('getProjectUsage error:', err);
    res.status(500).json({ error: 'Failed to load usage' });
  }
}

// ── Get project detail ────────────────────────────────────────────────────────
export async function getProject(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const result = await getProjectForUser(id, userId);
    if (!result) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { project } = result;

    // Load chats in this project — archived chats are excluded (default-list
    // rule; they live in the sidebar's Archived view and still load by id).
    // Lineage (2026-10-21, platform/display-parent.ts): the sidebar MERGES these
    // rows into its chat list when a folder expands — rows without
    // parentChatId always rendered as roots, so an older child of the folder's
    // Project Supervisor (6ef785c3 under daee2916) showed flat until a delta
    // re-delivered it. They now carry the same lineage fields as GET /chats
    // (+ owner / supervisor flags the sidebar's filters read). Not selected
    // under DISPLAY_PARENT_NESTING_DISABLED=1 — the rows are today's again.
    const projectChats = await prisma.crossModelChat.findMany({
      where: { projectId: id, archivedAt: null },
      select: {
        id: true,
        title: true,
        mode: true,
        createdAt: true,
        updatedAt: true,
        shareLink: { select: { shareToken: true, isActive: true } },
        ...(displayParentNestingDisabled()
          ? {}
          : { parentChatId: true, isSupervisor: true, userId: true, displayParentChatId: true }),
      },
      orderBy: { updatedAt: 'desc' },
    });

    // P0 2026-09-07 (folder-tree flavor bug): the sidebar folder tree merges
    // these rows into the page's `chats` array and loadChat branches the
    // CodeSessionView flavor on hasWorkspaceState — rows WITHOUT the
    // capability fields opened coding sessions as PLAIN chats. Same batched
    // pattern as listChats (crossmodel.service.ts P5-B): ONE satellite query
    // for the whole list, no per-chat N+1. codeCapable folds in the nearest
    // workspace folder, computed ONCE — every row here shares THIS project.
    const codingStates: Array<{ id: string }> = await (prisma as any).chatCodingState
      .findMany({
        where: { id: { in: projectChats.map((c) => c.id) } },
        select: { id: true },
      })
      .catch(() => []);
    const satelliteIds = new Set(codingStates.map((s) => s.id));
    const { getNearestWorkspaceFolder } = await import('./platform/folder-inheritance');
    const folderCodeCapable = !!(await getNearestWorkspaceFolder(id).catch(() => null));
    const chats = projectChats.map((chat) => ({
      ...chat,
      hasWorkspaceState: satelliteIds.has(chat.id),
      codeCapable: satelliteIds.has(chat.id) || folderCodeCapable,
    }));

    // Load documents
    const documents = await prisma.projectDocument.findMany({
      where: { projectId: id },
      select: {
        id: true,
        name: true,
        mimeType: true,
        sourceUrl: true,
        source: true,
        charCount: true,
        chunkCount: true,
        status: true,
        errorMsg: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Load members
    const members = await prisma.projectMember.findMany({
      where: { projectId: id },
      include: {
        user: { select: { id: true, name: true, email: true, avatar: true } },
      },
    });

    const projectSettings = await getProjectSettings(id);
    // Per-project supervisor (2026-09-14 rollout watch): the settings tab's
    // "Project supervisor" toggle reads its state from THIS response — #741
    // added the flag to the UPDATE path but not to this pick list, so after a
    // reload every enabled project rendered the toggle OFF (owner: "make sure
    // it's a supervised setting in ui"). Also surface the supervisor chat id
    // so the page can link straight to the lane (pause-never-delete: a paused
    // supervisor still has its chat).
    const supervisorChat = await prisma.crossModelChat
      .findFirst({ where: { projectId: id, isProjectSupervisor: true }, select: { id: true }, orderBy: { createdAt: 'asc' } })
      .catch(() => null);
    // Hourly project status card (owner ask 2026-09-14): the newest
    // project_status row's metadata ({origin, kind, generatedAt, since,
    // status}) from the project supervisor chat, or null when there is no lane
    // or no card yet. Same shape as the message row's metadata so the page can
    // reuse the chat's status-card renderer. Best-effort: never fails the GET.
    const latestProjectStatus = await getLatestProjectStatus(id).catch(() => null);

    res.json({
      id: project.id,
      name: project.name,
      description: project.description,
      systemPrompt: project.systemPrompt,
      emoji: project.emoji,
      color: project.color,
      isPublic: project.isPublic,
      shareToken: project.shareToken,
      userId: project.userId,
      // One-Digby: workspace fields (coding-project signal for the UI).
      repoUrl: project.repoUrl,
      repoProvider: project.repoProvider,
      workspaceAt: project.workspaceAt,
      archivedAt: project.archivedAt, // archive state — direct loads keep working; the UI offers Restore
      role: result.role,
      crossProjectMemory: projectSettings.crossProjectMemory,
      codingModel: projectSettings.codingModel ?? null,
      // Gmail auto-ingest (ticket 99145890) — the settings tab's toggle reads
      // from this field (same surface contract as crossProjectMemory).
      autoIngestGmailAttachments: projectSettings.autoIngestGmailAttachments === true,
      // Fleet-supervision opt-in flag (ticket 3217e287) — the settings tab's
      // "Supervise this folder" toggle renders its state from this field.
      supervised: project.supervised,
      // Per-project supervisor lane (#741 + 2026-09-14 rollout): the toggle's
      // state + the lane's chat id (null until the first scaffold).
      projectSupervisorEnabled: (project as any).projectSupervisorEnabled === true,
      projectSupervisorChatId: supervisorChat?.id ?? null,
      latestProjectStatus,
      // Auto-archive idle chats (ticket bb86cee8) — the settings tab's
      // auto-archive control renders from this; null = feature off.
      autoArchiveIdleDays: project.autoArchiveIdleDays ?? null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      chats,
      documents,
      members: members.map((m) => ({
        userId: m.userId,
        role: m.role,
        addedAt: m.addedAt,
        user: m.user,
      })),
    });
  } catch (err) {
    logger.error('getProject error:', err);
    res.status(500).json({ error: 'Failed to get project' });
  }
}

// ── Update project ────────────────────────────────────────────────────────────
export async function updateProject(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { name, description, systemPrompt, emoji, color, isPublic, supervised, crossProjectMemory, codingModel, projectSupervisorEnabled, autoArchiveIdleDays, autoIngestGmailAttachments } = req.body;

    // P1: platform.service owns update (+ authz + audit).
    const updated = await platformService.updateProject({
      userId, projectId: id, name, description, systemPrompt, emoji, color, isPublic, supervised, crossProjectMemory,
      ...(codingModel !== undefined ? { codingModel: String(codingModel) } : {}),
      // Per-project supervisor lane (2026-09-13) — the sidebar/dashboard toggle binds here.
      ...(projectSupervisorEnabled !== undefined ? { projectSupervisorEnabled: !!projectSupervisorEnabled } : {}),
      // Auto-archive idle chats (ticket bb86cee8) — null clears; 1..365 validated in the service.
      ...(autoArchiveIdleDays !== undefined ? { autoArchiveIdleDays: autoArchiveIdleDays === null ? null : Number(autoArchiveIdleDays) } : {}),
      // Gmail auto-ingest (ticket 99145890) — explicit boolean, default-off.
      ...(autoIngestGmailAttachments !== undefined ? { autoIngestGmailAttachments: !!autoIngestGmailAttachments } : {}),
    });

    res.json(updated);
  } catch (err: any) {
    if (err instanceof AppError && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error('updateProject error:', err);
    res.status(500).json({ error: 'Failed to update project' });
  }
}

// ── Delete project ────────────────────────────────────────────────────────────
export async function deleteProject(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    // P1: platform.service owns delete (owner-only + coding-chat/memory cleanup + audit).
    await platformService.deleteProject({ userId, projectId: id });

    res.json({ success: true });
  } catch (err: any) {
    if (err instanceof AppError && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error('deleteProject error:', err);
    res.status(500).json({ error: 'Failed to delete project' });
  }
}

// ── Archive / restore project (owner 2026-09-08) ──────────────────────────────
// Owner-only (matches delete's authorization). Archive stamps ONLY the folder
// row — its chats + descendant folders hide implicitly and restore brings the
// whole subtree back losslessly. 409s (running sessions / enabled schedules)
// surface with their honest message.
export async function archiveProject(req: Request, res: Response) {
  try {
    const result = await platformService.archiveProject({
      userId: req.user!.id,
      projectId: req.params.id,
      archived: true,
    });
    res.json({ success: true, data: result });
  } catch (err: any) {
    if (err instanceof AppError && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error('archiveProject error:', err);
    res.status(500).json({ error: 'Failed to archive project' });
  }
}

export async function restoreProject(req: Request, res: Response) {
  try {
    const result = await platformService.archiveProject({
      userId: req.user!.id,
      projectId: req.params.id,
      archived: false,
    });
    res.json({ success: true, data: result });
  } catch (err: any) {
    if (err instanceof AppError && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    logger.error('restoreProject error:', err);
    res.status(500).json({ error: 'Failed to restore project' });
  }
}

// ── Add member (invite by email) ──────────────────────────────────────────────
export async function addProjectMember(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { email, role = 'viewer' } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    if (!['viewer', 'editor', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'role must be viewer, editor, or admin' });
    }

    // Only owner or admin members can add members
    const project = await prisma.crossModelProject.findUnique({ where: { id } });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // Framework surface (ticket 9471d338): membership is a user-folder
    // mechanic — the platform's own project is owner-visible by construction
    // (owner sees everything) and gains no collaborators.
    if (isFrameworkProject(project)) {
      return res.status(403).json({ error: frameworkProjectRefusal('member') });
    }

    if (project.userId !== userId) {
      const member = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: id, userId } },
      });
      if (!member || (member.role !== 'admin')) {
        return res.status(403).json({ error: 'Only project owner or admin can invite members' });
      }
    }

    // Find the user to invite (case-insensitive — emails are normalized to
    // lowercase on registration, but older accounts may have mixed case)
    const normalizedEmail = email.toLowerCase().trim();
    let invitee = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (!invitee) {
      // Fallback: case-insensitive search for legacy accounts with mixed-case emails
      invitee = await prisma.user.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      });
    }
    if (!invitee) {
      return res.status(404).json({ error: `No user found with email: ${email}. They need to create an account at digby.example.com first, then you can invite them.` });
    }
    if (invitee.id === project.userId) {
      return res.status(400).json({ error: 'Cannot add project owner as member' });
    }

    // Upsert member
    const newMember = await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: id, userId: invitee.id } },
      create: { projectId: id, userId: invitee.id, role },
      update: { role },
      include: { user: { select: { id: true, name: true, email: true, avatar: true } } },
    });

    res.status(201).json({
      userId: newMember.userId,
      role: newMember.role,
      addedAt: newMember.addedAt,
      user: newMember.user,
    });
  } catch (err) {
    logger.error('addProjectMember error:', err);
    res.status(500).json({ error: 'Failed to add member' });
  }
}

// ── Update member role ────────────────────────────────────────────────────────
export async function updateProjectMember(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id, memberId } = req.params;
    const { role } = req.body;

    if (!['viewer', 'editor', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'role must be viewer, editor, or admin' });
    }

    // Only owner can change roles
    const project = await prisma.crossModelProject.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return res.status(403).json({ error: 'Only project owner can change roles' });
    }
    // Framework surface (ticket 9471d338): no membership mechanics.
    if (isFrameworkProject(project)) {
      return res.status(403).json({ error: frameworkProjectRefusal('member') });
    }

    const updated = await prisma.projectMember.update({
      where: { projectId_userId: { projectId: id, userId: memberId } },
      data: { role },
    });

    res.json(updated);
  } catch (err) {
    logger.error('updateProjectMember error:', err);
    res.status(500).json({ error: 'Failed to update member role' });
  }
}

// ── Remove member ─────────────────────────────────────────────────────────────
export async function removeProjectMember(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id, memberId } = req.params;

    // Owner can remove anyone; members can remove themselves
    const project = await prisma.crossModelProject.findUnique({ where: { id } });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // Framework surface (ticket 9471d338): no membership mechanics (a member
    // removing THEMSELVES is meaningless here — the surface gains no members).
    if (isFrameworkProject(project)) {
      return res.status(403).json({ error: frameworkProjectRefusal('member') });
    }

    if (project.userId !== userId && memberId !== userId) {
      return res.status(403).json({ error: 'Only project owner can remove other members' });
    }

    await prisma.projectMember.delete({
      where: { projectId_userId: { projectId: id, userId: memberId } },
    });

    res.json({ success: true });
  } catch (err) {
    logger.error('removeProjectMember error:', err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
}

// ── Get public project (no auth) ──────────────────────────────────────────────
export async function getPublicProject(req: Request, res: Response) {
  try {
    const { token } = req.params;

    const project = await prisma.crossModelProject.findUnique({
      where: { shareToken: token },
      include: {
        user: { select: { name: true, email: true } },
        chats: {
          // Archived chats stay off the public share page (default-list rule).
          where: { archivedAt: null },
          // NOTE: messages:true intentionally omitted — the deprecated JSONB column
          // could be large (50+ messages × 1KB each). Public project page only
          // needs chat titles/metadata, not message content.
          select: {
            id: true,
            title: true,
            mode: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: 'desc' },
        },
      },
    });

    if (!project || !project.isPublic) {
      return res.status(404).json({ error: 'Project not found or not public' });
    }

    res.json({
      id: project.id,
      name: project.name,
      description: project.description,
      emoji: project.emoji,
      color: project.color,
      ownerName: project.user.name ?? project.user.email,
      chats: project.chats,
      createdAt: project.createdAt,
    });
  } catch (err) {
    logger.error('getPublicProject error:', err);
    res.status(500).json({ error: 'Failed to get project' });
  }
}

// ── Generate / toggle project share token ─────────────────────────────────────
export async function shareProject(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { enable = true } = req.body;

    const project = await prisma.crossModelProject.findUnique({ where: { id } });
    if (!project || project.userId !== userId) {
      return res.status(404).json({ error: 'Project not found' });
    }
    // Framework surface (ticket 9471d338): the platform's own project is
    // never a public share link — its contents are platform-internal.
    if (isFrameworkProject(project)) {
      return res.status(403).json({ error: frameworkProjectRefusal('share') });
    }

    if (enable) {
      const shareToken = project.shareToken ?? randomBytes(20).toString('hex');
      const updated = await prisma.crossModelProject.update({
        where: { id },
        data: { isPublic: true, shareToken },
      });
      const host = process.env.FRONTEND_URL?.split(',')[0] ?? 'https://crossmodel.cozz';
      res.json({
        shareToken: updated.shareToken,
        shareUrl: `${host}/shared/project/${updated.shareToken}`,
      });
    } else {
      await prisma.crossModelProject.update({
        where: { id },
        data: { isPublic: false, shareToken: null },
      });
      res.json({ success: true, message: 'Project sharing disabled' });
    }
  } catch (err) {
    logger.error('shareProject error:', err);
    res.status(500).json({ error: 'Failed to update project sharing' });
  }
}

// ── Create chat inside a project ──────────────────────────────────────────────
export async function createProjectChat(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    // P4: normalize at the intake boundary (this endpoint reads a RAW body —
    // retired modes alias to their successors). 2026-09-26: 'auto' is the
    // default AND is persisted (the runtime routes a stored 'auto' per send).
    const rawMode = typeof req.body?.mode === 'string' && req.body.mode ? req.body.mode : 'auto';
    const mode = normalizePatienceMode(rawMode);
    const { title } = req.body;

    const result = await getProjectForUser(id, userId, false);
    if (!result) {
      return res.status(404).json({ error: 'Project not found or no access' });
    }

    // Editors and owners can create chats; viewers cannot
    if (result.role === 'viewer') {
      return res.status(403).json({ error: 'Viewers cannot create chats in this project' });
    }

    // NOTE: deprecated messages JSONB column intentionally omitted — never read,
    // all message storage uses the normalized crossModelMessage table.
    const chat = await prisma.crossModelChat.create({
      data: {
        userId,
        projectId: id,
        title: title?.trim() || 'New Chat',
        mode,
      },
    });

    // Fleet Supervisor (best-effort, fire-and-forget): lazily ensure the
    // owner's ONE global supervisor chat (full fleet autonomy). Its wildcard
    // hook already covers this new chat — no per-chat wiring. NEVER awaited —
    // mirrors crossmodel.service.createChat's trigger.
    // Gated on the project's `supervised` flag (owner 2026-09-13, ticket
    // 3217e287): a chat created in an opted-OUT project must not scaffold the
    // fleet-supervisor framework — mirrors the wildcard emission gate.
    if (result.project.supervised !== false) {
      void import('./platform/supervisor.service')
        .then((sup) => sup.ensureFleetSupervisor(userId))
        .catch((err: any) => logger.warn(`fleet supervisor ensure failed (chat ${chat.id.slice(0, 8)}): ${err?.message}`));
    }

    // Third review (2026-10-22): the create has no `select`, so Prisma returns
    // EVERY scalar — the display-parent column included. Under
    // DISPLAY_PARENT_NESTING_DISABLED the 201 body is the pre-2026-10-21 one
    // (the key is dropped; its value is always null on this path anyway).
    if (displayParentNestingDisabled()) {
      const { displayParentChatId: _displayParent, ...preWave } = chat as typeof chat & { displayParentChatId?: string | null };
      res.status(201).json(preWave);
      return;
    }
    res.status(201).json(chat);
  } catch (err) {
    logger.error('createProjectChat error:', err);
    res.status(500).json({ error: 'Failed to create chat' });
  }
}

// ── One-Digby (Phase 1B): project workspace ──────────────────────────────────

/** GET /projects/:id/workspace — workspace state (owner or member). */
export async function getProjectWorkspace(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const project = await prisma.crossModelProject.findFirst({
      where: { id, OR: [{ userId }, { members: { some: { userId } } }] },
      select: { id: true },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { getWorkspace } = await import('./coding/project-workspace.service');
    const ws = await getWorkspace(id);
    res.json({ success: true, data: ws });
  } catch (err: any) {
    logger.error('getProjectWorkspace error:', err);
    res.status(500).json({ error: 'Failed to load workspace' });
  }
}

/** POST /projects/:id/workspace — configure + provision (owner only). */
export async function configureProjectWorkspace(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { repoUrl, provider, defaultBranch, githubLabel } = req.body || {};
    const svc = await import('./coding/project-workspace.service');
    const ws = await svc.configureWorkspace(id, userId, {
      repoUrl: typeof repoUrl === 'string' && repoUrl ? repoUrl : undefined,
      provider: ['github', 'git', 'local'].includes(provider) ? provider : undefined,
      defaultBranch: typeof defaultBranch === 'string' && defaultBranch ? defaultBranch : undefined,
      githubLabel: typeof githubLabel === 'string' ? githubLabel : null,
    });
    void ws;
    // Provision immediately so the first knowledge commit / coding chat is instant.
    const { getValidToken } = await import('./github/token-manager');
    await svc.ensureProvisioned(id, () => getValidToken(userId, (req.body?.githubLabel as string) || undefined));
    res.json({ success: true, data: await svc.getWorkspace(id) });
  } catch (err: any) {
    const status = err.status || 500;
    if (status >= 500) logger.error('configureProjectWorkspace error:', err);
    res.status(status).json({ error: err.message || 'Failed to configure workspace' });
  }
}

/** POST /projects/:id/workspace/sync — commit not-yet-committed docs (owner only). */
export async function syncProjectWorkspace(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const project = await prisma.crossModelProject.findFirst({ where: { id, userId }, select: { id: true } });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { syncKnowledgeToRepo } = await import('./coding/project-workspace.service');
    const result = await syncKnowledgeToRepo(id);
    res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error('syncProjectWorkspace error:', err);
    res.status(500).json({ error: 'Failed to sync knowledge' });
  }
}

export default {
  listProjects,
  createProject,
  getProject,
  getProjectSessions,
  getProjectUsage,
  updateProject,
  deleteProject,
  archiveProject,
  restoreProject,
  moveProject,
  getProjectBreadcrumbs,
  addProjectMember,
  updateProjectMember,
  removeProjectMember,
  getPublicProject,
  shareProject,
  createProjectChat,
  getProjectWorkspace,
  configureProjectWorkspace,
  syncProjectWorkspace,
};
