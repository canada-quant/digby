/**
 * Digby Code routes — all auth-required, adult-only (coding is an adult surface).
 * Authenticated by the app-level /api/crossmodel guard in app.ts — deliberately
 * NO router.use(authenticate) here (see the ordering contract in app.ts).
 * The SSE run endpoint (query-token auth) lives in coding-public.routes.ts.
 */

import { Router } from 'express';
import { rejectChild } from '../../../middleware/auth';
import controller from './coding.controller';
import streamController from './coding-stream.controller';

const router = Router();

// NOTE: the SSE run route (query-token auth) lives in coding-public.routes.ts,
// mounted before the app-level guard to avoid the greedy-authenticate 401.

// Everything here is header-auth (app-level guard) + adult-only.
router.use(rejectChild);

// Approve/deny an ask-mode permission request.
router.post('/coding/approvals/:approvalId', streamController.postApproval.bind(streamController));
// Answer an ask_user question the orchestrator is blocked on.
router.post('/coding/questions/:questionId', streamController.postQuestion.bind(streamController));

// Start a run — the message rides the POST BODY (header-auth), so long prompts /
// pasted logs don't hit the URL-length limit of the EventSource query string. The
// client then opens the SSE stream in attach mode to watch it.
// P5-B: the CANONICAL mount is POST /chats/:id/run (crossmodel.routes.ts) —
// this path stays as a working compat alias.
router.post('/coding/sessions/:id/run', streamController.startRun.bind(streamController));

// Stop a running session (graceful cancel, or unstick an orphaned 'running' row).
// P5-B: canonical mounts are POST /chats/:id/stop|steer — these stay as aliases.
router.post('/coding/sessions/:id/stop', streamController.stopRun.bind(streamController));
router.post('/coding/sessions/:id/steer', streamController.steerRun.bind(streamController));

// GitHub repos available to import
router.get('/coding/github-repos', controller.listGithubRepos.bind(controller));

// ── CLI/API credentials for coding sessions (Cloudflare, AWS, Namecheap, Brev, …) ──
// Values are write-only: list returns masked previews, never the stored value.
router.get('/coding/credentials', controller.listCodingCredentials.bind(controller));
router.put('/coding/credentials', controller.saveCodingCredential.bind(controller));
router.delete('/coding/credentials/:id', controller.deleteCodingCredential.bind(controller));

// ── Shared tailnet dev container (Account → Coding; ticket 3ba5d35d) ──
router.get('/coding/dev-container/status', controller.getDevContainerStatus.bind(controller));
router.post('/coding/dev-container/restart', controller.restartDevContainer.bind(controller));
router.post('/coding/dev-container/tailnet/restart', controller.restartDevTailnet.bind(controller));
router.post('/coding/dev-container/tailnet/reconnect', controller.reconnectDevTailnet.bind(controller));

// ── Per-session tailnet egress scoping (ticket 4ed6eb2e) ──
// Per-user default allowlist (null = allow-all) + per-session overrides.
router.get('/coding/dev-container/egress', controller.getTailnetEgressPolicy.bind(controller));
router.put('/coding/dev-container/egress', controller.saveTailnetEgressPolicy.bind(controller));
router.put('/coding/sessions/:id/tailnet-egress', controller.saveSessionTailnetEgress.bind(controller));

// Projects
router.get('/coding/projects', controller.listProjects.bind(controller));
router.post('/coding/projects', controller.importProject.bind(controller));
router.delete('/coding/projects/:id', controller.deleteProject.bind(controller));

// Sessions (nested under a project for create/list)
// P5-B COMPAT aliases over the unified chat+satellite model: a "session" IS a
// chat carrying a workspace satellite. create delegates to
// platform.service.startCodingSession (the same path the start_coding_session
// platform tool uses); list derives from the satellite (no mode marker).
router.get('/coding/projects/:projectId/sessions', controller.listSessions.bind(controller));
router.post('/coding/projects/:projectId/sessions', controller.createSession.bind(controller));
// One-Digby C5: "Save canvas to project" → knowledge branch commit
router.post('/coding/projects/:projectId/knowledge', controller.commitCanvasKnowledge.bind(controller));

// Durable cron supervision (Phase 3): cron_jobs rows + agent_runs queue counts
// (worker-claimed schedulers keep firing across deploys — see docs/durable-cron-phase3.md).
router.get('/coding/cron-status', controller.getCronStatus.bind(controller));

// Individual session
// NOTE: /coding/sessions/running MUST precede /coding/sessions/:id (Express
// matches in order — otherwise 'running' is captured as an :id).
// Sidebar spinner reconciliation: ids of the caller's currently-running
// sessions, polled so finished runs stop spinning even when their view was
// unmounted or its SSE died.
router.get('/coding/sessions/running', controller.listRunningSessions.bind(controller));
// P5-B COMPAT aliases: get/patch carry coding-only fields (transcript view,
// permissionMode, archived) that have no chat-URL equivalent — thin handlers
// over the shared data services. delete delegates to the canonical
// DELETE /chats/:id path (see coding.controller.deleteSession).
router.get('/coding/sessions/:id', controller.getSession.bind(controller));
// Lazy binary for a transcript image part (getSession strips inline base64 →
// this URL). Same-origin <img> loads ride the app-level guard's cm_access cookie.
router.get('/coding/sessions/:id/messages/:messageId/image/:partIndex', controller.getMessageImage.bind(controller));
router.put('/coding/sessions/:id', controller.updateSession.bind(controller));
router.delete('/coding/sessions/:id', controller.deleteSession.bind(controller));
router.get('/coding/sessions/:id/diff', controller.getSessionDiff.bind(controller));
router.post('/coding/sessions/:id/push', controller.pushSession.bind(controller));
router.post('/coding/sessions/:id/pr', controller.openSessionPr.bind(controller));

// Plan / goal / todos (the sidebar Overview — user-editable when idle)
router.get('/coding/sessions/:id/plan', controller.getSessionPlan.bind(controller));
router.put('/coding/sessions/:id/plan/goal', controller.setGoal.bind(controller));
router.post('/coding/sessions/:id/plan/todos', controller.addTodo.bind(controller));
router.patch('/coding/sessions/:id/plan/todos/:stepId', controller.setTodoStatus.bind(controller));
router.delete('/coding/sessions/:id/plan/todos/:stepId', controller.deleteTodo.bind(controller));

export default router;
