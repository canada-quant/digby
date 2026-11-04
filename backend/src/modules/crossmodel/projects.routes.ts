import { Router } from 'express';
import { rejectChild } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { createProjectSchema, moveProjectSchema, getBreadcrumbsSchema, archiveProjectSchema } from './crossmodel.validation';
import controller from './projects.controller';

const router = Router();

// NOTE: the public /shared/project/:token route lives in public-share.routes.ts,
// mounted before the app-level authenticate guard.

// Authenticated by the app-level guard (app.ts) — no router.use(authenticate).
router.use(rejectChild); // Digby Kids: adult workspace — child tokens are rejected

// ── Projects CRUD ─────────────────────────────────────────────────────────────
router.get('/projects', controller.listProjects);
router.post('/projects', validate(createProjectSchema), controller.createProject);
router.get('/projects/:id', controller.getProject);
// Sessions view (session titles + topology, 2026-09-27): title halves, status, last receipt age, today's spend, charter per chat.
router.get('/projects/:id/sessions', controller.getProjectSessions);
router.get('/projects/:id/usage', controller.getProjectUsage);
router.put('/projects/:id', controller.updateProject);
router.delete('/projects/:id', controller.deleteProject);

// ── Archive / restore (owner-only — matches delete's authorization).
// GET /projects?archived=true lists the archived folders. ──

// Archive a folder — hides it + its chats/subfolders from default lists (409 while sessions run / schedules enabled)
router.post('/projects/:id/archive', validate(archiveProjectSchema), controller.archiveProject);
// Restore an archived folder — the lossless inverse; the whole subtree reappears in place
router.post('/projects/:id/restore', validate(archiveProjectSchema), controller.restoreProject);

// ── Folder tree (P2): move + breadcrumbs ──────────────────────────────────────
router.post('/projects/:id/move', validate(moveProjectSchema), controller.moveProject);
router.get('/projects/:id/breadcrumbs', validate(getBreadcrumbsSchema), controller.getProjectBreadcrumbs);

// ── Project sharing ───────────────────────────────────────────────────────────
router.post('/projects/:id/share', controller.shareProject);

// ── Project members ───────────────────────────────────────────────────────────
router.post('/projects/:id/members', controller.addProjectMember);
router.put('/projects/:id/members/:memberId', controller.updateProjectMember);
router.delete('/projects/:id/members/:memberId', controller.removeProjectMember);

// ── Create chat inside a project ──────────────────────────────────────────────
router.post('/projects/:id/chats', controller.createProjectChat);

// ── One-Digby workspace (Phase 1B) — app-level guard + router-level rejectChild apply
router.get('/projects/:id/workspace', controller.getProjectWorkspace);
router.post('/projects/:id/workspace', controller.configureProjectWorkspace);
router.post('/projects/:id/workspace/sync', controller.syncProjectWorkspace);

export default router;
