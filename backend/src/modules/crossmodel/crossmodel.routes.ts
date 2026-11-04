/**
 * Authenticated CrossModel routes.
 *
 * AUTH IS APP-LEVEL: this router deliberately has NO `router.use(authenticate)`.
 * app.ts mounts ONE guard (`app.use('/api/crossmodel', authenticate)`) ahead of
 * this router and every other authed crossmodel router, so a request that falls
 * through several routers is verified exactly once. The old per-router greedy
 * guards re-verified the JWT on every fall-through router (8x for /coding/*) —
 * the stacked-middleware footgun behind the 2026-07-23 duplicate-cm_access-cookie
 * nginx 502. Anonymous-capable and per-route-auth endpoints (SSE stream, upload,
 * feedback, OAuth callbacks, webhooks) live in crossmodel-open.routes.ts,
 * mounted BEFORE the guard. Do not add unauthenticated routes here.
 */
import { Router, Request, Response, NextFunction } from 'express';
import controller from './crossmodel.controller';
import { getViewMode, putViewMode } from './view/view-mode.controller';
import { getInstanceSetup } from './platform/instance-setup.controller';
import confirmationsController from './confirmations.controller';
import { rejectChild } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import {
  createChatSchema,
  listChatsSchema,
  listChatChangesSchema,
  getChatSchema,
  updateChatSchema,
  deleteChatSchema,
  archiveChatSchema,
  convertToCodingSchema,
  cancelChatScheduleSchema,
  updateChatScheduleSchema,
} from './crossmodel.validation';
import userMcpRoutes from './user-mcp/user-mcp.routes';
import { resolveEntityRefHandler } from './entity-refs';
import { getAdminDelegationTasks, getAdminDelegationTask } from './platform/delegation-tasks.controller'; // build 2026-10-08 D

const router = Router();

// ── User-added MCP servers (ticket e294f9a4) — the caller's own integrations:
// add / test / health / tools. Authed by the app-level guard; per-route
// rejectChild inside. USER_MCP_DISABLED=1 ⇒ 404.
router.use('/mcp-servers', userMcpRoutes);

// ── Voice: Transcription & TTS ────────────────────────────────────────────

/**
 * POST /api/crossmodel/transcribe
 * Transcribe audio on the Speech-to-text seat (speech.ts — DashScope qwen3-asr-flash by default).
 * Body: { audio: base64String, mimeType?: string, filename?: string }
 */
router.post('/transcribe', controller.transcribeAudio);

/**
 * POST /api/crossmodel/tts
 * Text-to-speech on the Text-to-speech seat (speech.ts — DashScope qwen3-tts-flash by default).
 * Body: { text: string, voice?: string }
 */
router.post('/tts', controller.textToSpeech);

/**
 * POST /api/crossmodel/tts/stream  (ticket 2774d2b7)
 * Progressive twin of /tts for read-aloud: each ≤600-char sentence chunk is
 * flushed as its own NDJSON line the moment it synthesizes (bounded
 * concurrency), so playback starts after the FIRST chunk instead of after the
 * whole answer. Lines: {"type":"chunk"|"done"|"error"|"ping", …} — the client
 * concatenates/plays by `index`. Keepalive pings every 20 s ride nginx's idle
 * timer. Body: { text: string, voice?: string }
 */
router.post('/tts/stream', controller.textToSpeechStream);

// ── Images ────────────────────────────────────────────────────────────────

/**
 * POST /api/crossmodel/images/generate
 * Generate an image on the Image generator seat (image-generate.ts) — the REST mirror of the generate_image tool; the result is saved as a generated file.
 * Body: { prompt, aspect?, style?, polish?, negativePrompt?, referenceUploadId?, referenceFileId?, chatId? }
 */
router.post('/images/generate', rejectChild, controller.generateImage);

// ── Fleet notice (2026-10-12 credential incident) ─────────────────────────
// ONE owner-written block every agent of this user reads until it expires —
// coding lanes, supervisors and chats (platform/fleet-notice.ts). Own row
// only; child accounts refused; secrets are redacted on save.

/** GET /api/crossmodel/fleet-notice — { notice: {text, expiresAt, updatedAt} | null, active, maxChars, maxDays } */
router.get('/fleet-notice', rejectChild, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { getFleetNotice, fleetNoticeActive, fleetNoticeDisabled, FLEET_NOTICE_MAX_CHARS, FLEET_NOTICE_MAX_DAYS } = await import('./platform/fleet-notice');
    const notice = await getFleetNotice(req.user!.id, { fresh: true });
    res.json({ notice, active: fleetNoticeActive(notice), disabled: fleetNoticeDisabled(), maxChars: FLEET_NOTICE_MAX_CHARS, maxDays: FLEET_NOTICE_MAX_DAYS });
  } catch (err) { next(err); }
});

/** PUT /api/crossmodel/fleet-notice — body { text, days? | expiresAt? } → { notice, redacted[] } (400 on validation) */
router.put('/fleet-notice', rejectChild, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { setFleetNotice } = await import('./platform/fleet-notice');
    const body = (req.body || {}) as { text?: unknown; days?: unknown; expiresAt?: unknown };
    const r = await setFleetNotice(req.user!.id, {
      text: typeof body.text === 'string' ? body.text : '',
      ...(body.days !== undefined ? { days: Number(body.days) } : {}),
      ...(typeof body.expiresAt === 'string' && body.expiresAt ? { expiresAt: body.expiresAt } : {}),
    });
    if (!r.ok) { res.status(400).json({ error: r.error }); return; }
    res.json({ notice: r.notice, redacted: r.redacted });
  } catch (err) { next(err); }
});

/** DELETE /api/crossmodel/fleet-notice — clears the notice (idempotent) */
router.delete('/fleet-notice', rejectChild, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clearFleetNotice } = await import('./platform/fleet-notice');
    await clearFleetNotice(req.user!.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── User preferences routes ───────────────────────────────────────────────

/**
 * @swagger
 * /api/crossmodel/preferences:
 *   get:
 *     summary: Get user's model set preference (frontier vs open_source)
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current model set preference
 */
router.get('/preferences', controller.getPreferences);

/**
 * @swagger
 * /api/crossmodel/preferences:
 *   put:
 *     summary: Update user's model set preference
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [modelSet]
 *             properties:
 *               modelSet:
 *                 type: string
 *                 enum: [frontier, open_source]
 *     responses:
 *       200:
 *         description: Preference updated
 */
router.put('/preferences', controller.updatePreferences);

// Minimal view (2026-10-16): what this viewer sees, and an admin's Debug mode switch (view/view-mode.ts).
router.get('/view-mode', getViewMode);
router.put('/view-mode', putViewMode);
// Instance setup (2026-10-20): what THIS instance has configured — the Admin → Setup checklist and the
// Integrations / Feeds tabs' "not set up on this instance" states (platform/instance-setup.ts). Any
// signed-in user gets the booleans; admins also get the missing env NAMES + how-to (never values).
router.get('/instance/setup', getInstanceSetup);

// ── Memory management routes ──────────────────────────────────────────────

/**
 * @swagger
 * /api/crossmodel/memory:
 *   get:
 *     summary: Get user's AI memory facts
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Memory facts object
 */
router.get('/memory', controller.getMemory);

/**
 * @swagger
 * /api/crossmodel/memory:
 *   put:
 *     summary: Add or update a memory fact
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [key, value]
 *             properties:
 *               key:
 *                 type: string
 *               value:
 *                 type: string
 *     responses:
 *       200:
 *         description: Fact saved
 */
router.put('/memory', controller.updateMemoryFact);

/**
 * @swagger
 * /api/crossmodel/memory:
 *   delete:
 *     summary: Delete a specific memory fact (?key=xxx) or clear all memory
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: key
 *         schema:
 *           type: string
 *         description: If provided, deletes only this fact key. Otherwise clears all.
 *     responses:
 *       200:
 *         description: Memory updated
 */
router.delete('/memory', controller.deleteMemory);

/**
 * @swagger
 * /api/crossmodel/memory/consolidate:
 *   post:
 *     summary: Consolidate/improve user memory profile using AI
 *     description: >
 *       Digby reviews existing memory facts and recent conversation topics
 *       to produce an improved, consolidated profile. This is the "scheduled
 *       memory ingestion" triggered on demand from the profile page.
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Consolidated memory facts
 */
router.post('/memory/consolidate', controller.consolidateMemory);
/**
 * @swagger
 * /api/crossmodel/memory/rebuild:
 *   post:
 *     summary: Rebuild my personal memory from my own past conversations
 *     description: >
 *       2026-09-15 memory-wipe recovery. Re-reads the caller's OWN real
 *       exchanges (non-supervisor, non-coding chats; newest 150, replayed
 *       oldest first) through the grounded fact extractor as a background
 *       job — one per user at a time. Returns immediately; poll GET.
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Job started ({ started, total }) or nothing to rebuild from
 *       409:
 *         description: A rebuild is already running for this user
 *   get:
 *     summary: My memory rebuild status
 *     description: The caller's latest rebuild bookkeeping (progress, before/after fact counts) and current fact count.
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: { status, running, facts }
 */
router.post('/memory/rebuild', controller.rebuildMemory);
router.get('/memory/rebuild', controller.rebuildMemoryStatus);

/**
 * @swagger
 * /api/crossmodel/chats:
 *   post:
 *     summary: Create a new CrossModel chat
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *             properties:
 *               title:
 *                 type: string
 *               mode:
 *                 type: string
 *                 enum: [fast, thinking]
 *     responses:
 *       201:
 *         description: Chat created successfully
 */
router.post('/chats', validate(createChatSchema), controller.createChat);
// One-Digby: explicit stop for a detached agent chat run.
router.post('/agent/stop', controller.stopAgentRun);
// One-Digby: live-run check (authenticated — normal fetch, Bearer header works).
router.get('/agent/active', controller.agentRunActive);

// ── P5-B: the CANONICAL coding run surface lives on the chat id ─────────────
// Coding is a per-message capability of a chat (workspace satellite), so its
// run controls mount here; the /coding/* paths remain as thin compat aliases.
// Lazy import: the coding module graph (agent loop) is heavy + cycle-prone —
// the same dynamic-import pattern crossmodel.controller uses. rejectChild
// mirrors the /coding router (coding is an adult surface).
const codingRun = (fn: 'startRun' | 'steerRun' | 'stopRun' | 'postApproval' | 'worktreeTree' | 'worktreeFile' | 'worktreeRaw') =>
  (req: Request, res: Response, next: NextFunction) =>
    import('./coding/coding-stream.controller')
      .then(m => (m.default as any)[fn](req, res))
      .catch(next);
router.post('/chats/:id/run', rejectChild, codingRun('startRun'));
router.post('/chats/:id/steer', rejectChild, codingRun('steerRun'));
router.post('/chats/:id/stop', rejectChild, codingRun('stopRun'));
router.post('/chats/:id/approvals/:approvalId', rejectChild, codingRun('postApproval'));
// Phase-1 worktree Files tab (feedback 999e3dbe): lazy READ-ONLY tree + inline
// UTF-8 file viewer over the chat's coding worktree. Owner-only + path-escape
// guarded inside worktree-files.ts (see coding-stream.controller.worktreeTree).
// Ticket 1c767622: when this box's volume lacks the worktree (ALB scatter), the
// Redis-published snapshot serves instead — responses carry an optional
// additive `snapshot: { publishedAt, branch? }` marker in that case.
router.get('/chats/:chatId/worktree/tree', rejectChild, codingRun('worktreeTree'));
router.get('/chats/:chatId/worktree/file', rejectChild, codingRun('worktreeFile'));
// Ticket 19fbd876: the DOWNLOAD companion — a worktree file's REAL BYTES
// (binary included) as application/octet-stream + Content-Disposition, so the
// Files tab's download button never hands over a .txt of the 415 notice text.
// Same ownership + path-escape guards as /worktree/file; 16 MB cap instead of
// the viewer's 256 KB; serve order disk → shared snapshot → live cross-box.
router.get('/chats/:chatId/worktree/raw', rejectChild, codingRun('worktreeRaw'));
// POST /api/crossmodel/chats/:id/coding — convert a plain chat to a coding session in place (attach workspace satellite; optional folder move).
router.post('/chats/:id/coding', rejectChild, validate(convertToCodingSchema), controller.convertChatToCoding);

// ── First-class confirmation UX ─────────────────────────────────────────────
// Answer an ask_user question a CHAT run is blocked on (chat runs execute
// in-process, so this resolves the process-local question-registry directly;
// coding-session questions keep their cross-process endpoint in
// coding-stream.controller).
router.post('/chats/:chatId/questions/:questionId', confirmationsController.postChatQuestion);
// Clickable references in answers (2026-10-08, ./entity-refs.ts): "session fbb5c9ca" / "goal …" / "todo …" /
// "receipt …" → where the chip opens. Owner-scoped; an ambiguous or foreign prefix is a 404.
router.get('/refs/:kind/:id', rejectChild, (req, res) => resolveEntityRefHandler(req as any, res));
// Sidebar indicator poll: every chat of the user's currently blocked on a human.
router.get('/confirmations/pending', confirmationsController.getPendingConfirmations);
// Sidebar pending-action card: the owner confirms (executes the stored args
// server-side) or cancels a DB-persisted consequential-tool staging.
router.post('/confirmations/:confirmationId/confirm', confirmationsController.postConfirmationConfirm);
router.post('/confirmations/:confirmationId/cancel', confirmationsController.postConfirmationCancel);
// "Needs owner" inbox (ticket 7705fec2): answer / dismiss a flagged
// owner_question (merged into GET /confirmations/pending).
router.post('/owner-questions/:id/answer', confirmationsController.postOwnerQuestionAnswer);
router.post('/owner-questions/:id/dismiss', confirmationsController.postOwnerQuestionDismiss);
router.post('/owner-questions/:id/secrets/:ordinal/reveal', confirmationsController.postOwnerQuestionSecretReveal);

/**
 * @swagger
 * /api/crossmodel/chats:
 *   get:
 *     summary: List user's CrossModel chats
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of chats
 */
router.get('/chats', validate(listChatsSchema), controller.listChats);

/**
 * GET /api/crossmodel/chats/changes?since=<ISO>&limit=<n>
 * Sidebar live delta (ticket d6b2eef5): chats visible to the caller updated
 * at/after `since`, newest first, same row shape as GET /chats. Registered
 * BEFORE `/chats/:id` so "changes" is a literal route, never a chat id.
 */
router.get('/chats/changes', validate(listChatChangesSchema), controller.listChatChanges);

/**
 * GET /api/crossmodel/chats/search?q=...
 * Deep search across ALL the caller's own chats — by chat title AND by message
 * content (case-insensitive). Returns ranked, capped results for the sidebar
 * search box. MUST be registered BEFORE `/chats/:id` so "search" is matched as
 * this literal route, not captured as a chat id by the `:id` param.
 */
router.get('/chats/search', controller.searchChats);

/**
 * @swagger
 * /api/crossmodel/chats/{id}:
 *   get:
 *     summary: Get chat by ID
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Chat details
 */
router.get('/chats/:id', validate(getChatSchema), controller.getChat);

/**
 * GET /api/crossmodel/chats/:id/schedules
 * The chat's schedule rows (enabled + terminal) for the session panel's
 * Schedules section — works for any chat (coding or plain). Owner-or-member
 * read, same as the chat itself.
 */
router.get('/chats/:id/schedules', validate(getChatSchema), controller.listChatSchedules);

/**
 * DELETE /api/crossmodel/chats/:id/schedules/:scheduleId
 * Cancel (disable) one schedule on this chat — the Schedules tab's
 * no-confirmation cancel (the UI offers a short Undo instead). Owner-only;
 * exact cancel_schedule tool parity (lastStatus 'cancelled', schedule_disabled
 * hook event, 'schedule.cancel' audit); reversible via the PATCH below until
 * the terminal-row GC (~30 days).
 */
router.delete('/chats/:id/schedules/:scheduleId', validate(cancelChatScheduleSchema), controller.cancelChatSchedule);

/**
 * PATCH /api/crossmodel/chats/:id/schedules/:scheduleId {enabled}
 * Pause (false) / resume (true) one schedule on this chat. Owner-only. Resume
 * recomputes a stale nextRunAt (never an immediate catch-up fire), re-checks
 * the active-schedule cap, and refuses completed schedules (409).
 */
router.patch('/chats/:id/schedules/:scheduleId', validate(updateChatScheduleSchema), controller.updateChatSchedule);

/**
 * @swagger
 * /api/crossmodel/chats/{id}:
 *   put:
 *     summary: Update chat
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               mode:
 *                 type: string
 *                 enum: [fast, thinking]
 *     responses:
 *       200:
 *         description: Chat updated successfully
 */
router.put('/chats/:id', validate(updateChatSchema), controller.updateChat);

/**
 * @swagger
 * /api/crossmodel/chats/{id}:
 *   delete:
 *     summary: Delete chat
 *     tags: [CrossModel]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Chat deleted successfully
 */
router.delete('/chats/:id', validate(deleteChatSchema), controller.deleteChat);

/**
 * POST /api/crossmodel/chats/:id/archive
 * Archive a chat — owner-only, the same access level as delete.
 * It leaves the default lists/search but still loads by direct id. 409 while a
 * coding run is active or while the chat has enabled schedules (archive is
 * lossless — it never force-stops the way delete does).
 */
router.post('/chats/:id/archive', validate(archiveChatSchema), controller.archiveChat);

/**
 * POST /api/crossmodel/chats/:id/restore
 * Restore an archived chat — owner-only, the lossless inverse of archive.
 * Clears the archive stamp; the chat reappears in place.
 */
router.post('/chats/:id/restore', validate(archiveChatSchema), controller.restoreChat);

/**
 * GET /api/crossmodel/feedback/summary
 * Get feedback summary for the autopilot dashboard (admin only in future).
 * Returns counts by type/reason and recent unresolved items.
 */
router.get('/feedback/summary', controller.getFeedbackSummary);

// ── Feature Requests / Bug Reports ───────────────────────────────────────────

/**
 * POST /api/crossmodel/feature-request
 * Submit a feature request, bug report, or general feedback.
 * Body: { type, title, description }
 */
router.post('/feature-request', controller.submitFeatureRequest);

/**
 * GET /api/crossmodel/feature-requests
 * Get the authenticated user's own feature requests/bug reports.
 */
router.get('/feature-requests', controller.getFeatureRequests);

/**
 * PATCH /api/crossmodel/feature-requests/:id/resolve
 * Let the authenticated user mark their own submission as "done".
 */
router.patch('/feature-requests/:id/resolve', controller.resolveOwnFeatureRequest);

// ── Admin: Feature Request + Feedback management ──────────────────────────────

/**
 * GET /api/crossmodel/admin/feature-requests
 * List ALL feature requests across all users (admin only).
 * Query: ?status=open|in_progress|done  ?type=bug_report|feature_request  ?limit=100
 */
router.get('/admin/feature-requests', controller.adminListFeatureRequests);

/**
 * GET /api/crossmodel/admin/feature-requests/held
 * Tickets the owner-only ticket-lane rule holds (another account's, not yet approved) — admin only.
 */
router.get('/admin/feature-requests/held', controller.adminListHeldFeatureRequests);

/**
 * POST /api/crossmodel/admin/feature-requests/:id/approve-dispatch
 * Approve (or { approved: false } revoke) a held ticket for an auto-merging ticket lane — admin only, audited.
 */
router.post('/admin/feature-requests/:id/approve-dispatch', controller.adminApproveFeatureRequestDispatch);

/**
 * PATCH /api/crossmodel/admin/feature-requests/:id
 * Update status and/or adminNote on a single feature request (admin only).
 * Body: { status?, adminNote?, priority? }
 */
router.patch('/admin/feature-requests/:id', controller.adminUpdateFeatureRequest);

/**
 * PATCH /api/crossmodel/admin/feedback/:id/resolve
 * Mark a MessageFeedback item as resolved/unresolved (admin only).
 * Body: { resolved: true|false }
 */
router.patch('/admin/feedback/:id/resolve', controller.adminResolveFeedback);

// ── Admin: System Settings & Deep Research Usage ──────────────────────────────

/**
 * GET /api/crossmodel/admin/settings
 * Returns all SystemSettings (admin only — ADMIN role or paul@sunday.market).
 */
router.get('/admin/settings', controller.getAdminSettings);

/**
 * GET /api/crossmodel/admin/web-search-config
 * Web-search provider status (admin only — ticket 6f4d42f2): the source the
 * search backend resolves RIGHT NOW ('env' | 'store' | null), the stored
 * key's masked preview (never the key), zone, enabled, env-precedence.
 */
router.get('/admin/web-search-config', controller.getWebSearchConfig);

/**
 * PUT /api/crossmodel/admin/web-search-config
 * Save the Bright Data key/zone for self-hosted/Edge search (admin only,
 * ticket 6f4d42f2). Body: { apiKey?, zone?, enabled?, clear? }. The response
 * is the status — the key is NEVER echoed back.
 */
router.put('/admin/web-search-config', controller.updateWebSearchConfig);

/**
 * GET /api/crossmodel/admin/settings/supervisors
 * The supervisor OFF switches (owner 2026-09-26): fleet + project, each with
 * enabled / since / updatedBy / skipped, plus the harness status line (admin only).
 */
router.get('/admin/settings/supervisors', controller.getAdminSupervisorSettings);

/**
 * GET /api/crossmodel/admin/settings/patience-auto-only
 * The always-Auto switch (patience plan; prod =1 since 2026-09-26 20:35Z) with
 * enabled / since / updatedBy / source (admin only). Flip with
 * PUT /admin/settings/patience_auto_only { value: '0'|'1' }.
 */
router.get('/admin/settings/patience-auto-only', controller.getAdminPatienceAutoOnly);

/**
 * GET /api/crossmodel/admin/settings/patience (alias of the GET above — both audit branches merged 2026-09-26)
 * The Always-Auto switch (`patience_auto_only`, audit 2026-09-26): enabled /
 * since / updatedBy / source / bootDefault + the harness status line (admin only).
 */
router.get('/admin/settings/patience', controller.getAdminPatienceSettings);

/**
 * PUT /api/crossmodel/admin/settings/:key
 * Updates a single SystemSetting value (admin only).
 * Body: { value: string }
 * `fleet_supervisor_enabled` / `project_supervisors_enabled` / `patience_auto_only`
 * take '0'|'1' (also true|false|on|off) — validated, idempotent, audited, telemetered.
 */
router.put('/admin/settings/:key', controller.updateAdminSetting);

/**
 * POST /api/crossmodel/admin/prompts/rescaffold
 * Layered prompts (2026-09-27): re-scaffold every stored supervisor prompt
 * (fleet + project, PAUSED projects included) and every stock sweep body onto
 * the layered composition built from each project's own brief. Admin only.
 * Body: { userId?: string, dryRun?: boolean, sweeps?: boolean, limit?: number }
 * — dryRun reports per-chat outcomes without writing.
 */
router.post('/admin/prompts/rescaffold', controller.rescaffoldPrompts);

/**
 * GET /api/crossmodel/admin/deep-research-usage
 * Returns today's deep_research usage across all users (admin only).
 */
router.get('/admin/deep-research-usage', controller.getAdminDeepResearchUsage);

/**
 * GET /api/crossmodel/admin/stats
 * Returns high-level admin stats: total users, chats, signups, open tickets (admin only).
 */
router.get('/admin/stats', controller.getAdminStats);

/**
 * GET /api/crossmodel/admin/users
 * Returns all users with role, status, chat count, message count, last active (admin only).
 */
router.get('/admin/users', controller.getAdminUsers);

/**
 * DELETE /api/crossmodel/admin/users/:id
 * Hard-delete a user and all their related data (cascade). Admin only.
 * Cannot delete yourself.
 */
router.delete('/admin/users/:id', controller.adminDeleteUser);

/**
 * PATCH /api/crossmodel/admin/users/:id/role  { role: 'ADMIN' | 'USER' }
 * Promote a user to admin or back to user (admin only; never yourself, never the owner, never a Digby Kids account).
 */
router.patch('/admin/users/:id/role', controller.adminSetUserRole);

/**
 * GET /api/crossmodel/admin/api-costs
 * Returns API cost metrics: per-model counts, daily trends, estimated costs (admin only).
 * Query: ?days=30 (default 30, max 90)
 */
router.get('/admin/api-costs', controller.getAdminApiCosts);

// ── Admin: Error Logs ─────────────────────────────────────────────────────────

/**
 * GET /api/crossmodel/admin/error-logs
 * Returns paginated app error/warning logs from the database (admin only).
 * Query: ?level=error|warn  &page=1  &limit=50  &since=ISO  &until=ISO  &search=text
 */
router.get('/admin/error-logs', controller.getAdminErrorLogs);

/**
 * DELETE /api/crossmodel/admin/error-logs
 * Purge old error logs (admin only).
 * Query: ?olderThanDays=30 (default 30)
 */
router.delete('/admin/error-logs', controller.purgeAdminErrorLogs);

// ── Admin: Job Health ─────────────────────────────────────────────────────────

/**
 * GET /api/crossmodel/admin/job-health
 * Returns the health dashboard: error summary, ticket pipeline, deploy health,
 * error-spike detection (admin only).
 */
router.get('/admin/job-health', controller.getAdminJobHealth);

// ── Admin: Loop Metrics (audit #12) ───────────────────────────────────────────

/**
 * GET /api/crossmodel/admin/loop-metrics
 * Unified loop telemetry (admin only). ?kind=&hours=&bucket=hour|day →
 * bucketed count/sum/avg for that kind; without ?kind → compact summary of
 * all kinds (count + sum) over the window (default 24h).
 */
router.get('/admin/loop-metrics', controller.getAdminLoopMetrics);

// ── Admin: Delegation tasks (build 2026-10-08 D — the SHADOW ledger) ──────────

/**
 * GET /api/crossmodel/admin/delegation-tasks
 * The delegation ledger + tool-intent journal readout (admin only, read-only):
 * ?kind=&state=(…|open)&stale=1&chatId=&hours=&limit= → summary, tasks,
 * toolIntents, lastReconcile.
 */
router.get('/admin/delegation-tasks', getAdminDelegationTasks);

/**
 * GET /api/crossmodel/admin/delegation-tasks/:id
 * One delegation task with its lifecycle events + artifact refs (admin only).
 */
router.get('/admin/delegation-tasks/:id', getAdminDelegationTask);

// ── Deep Research Quota (authenticated users) ─────────────────────────────────

/**
 * GET /api/crossmodel/deep-research/quota
 * Returns the user's remaining deep_research quota for today.
 * Authenticated only (the app-level guard 401s anonymous callers; the
 * controller returns the quota for the resolved req.user).
 */
router.get('/deep-research/quota', controller.getDeepResearchQuota);

/**
 * GET /api/crossmodel/depth/policy
 * { autoOnly } — is every human send routed as Auto right now (the
 * patience_auto_only switch)? Read by REST / API clients (the web app stopped
 * reading it when the Advanced tab was removed — roster 2026-10-06 B-3
 * retired the radios it displayed, ticket c99b404a 2026-10-27 removed the
 * tab); kept for API clients. Authenticated (app-level guard); fails open to
 * autoOnly:false.
 */
router.get('/depth/policy', controller.getDepthPolicy);

// ── Feeds (RETIRED, ticket 43c24152, 2026-10-20) ─────────────────────────────
// Topic feeds are gone: create_feed/list_feeds/set_feed/refresh_feed/delete_feed
// were removed from the platform tool surface and the Feeds tab from Settings.
// A topic digest is a schedule on a real chat (schedule_message) — existing
// feeds were migrated to schedules by 20261020190000_retire_topic_feeds.
// The routes below stay as 410 tombstones so a stale client (cached Feeds tab)
// gets a clear answer instead of a 404 that looks like a routing bug.
const feedRetired = (_req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'feeds_retired',
      message: 'Topic feeds were retired (2026-10-20). Your feed was converted to a schedule on its chat — manage it there ("pause/resume my schedule") or ask Digby in that chat. New topic digests: ask Digby to schedule a daily digest on any chat.',
    },
  });
};
router.post('/feeds', feedRetired);
router.get('/feeds', feedRetired);
router.get('/feeds/:id', feedRetired);
router.put('/feeds/:id', feedRetired);
router.delete('/feeds/:id', feedRetired);
router.post('/feeds/enhance', feedRetired);
router.post('/feeds/:id/refresh', feedRetired);

// ── Home Page News Headlines ──────────────────────────────────────────────────

/**
 * GET /api/crossmodel/news
 * Returns personalized news headlines for the home screen.
 * Uses user memory (location, interests) + web search to generate tailored headlines.
 * Cached per user for 30 minutes.
 */
router.get('/news', controller.getNewsHeadlines);

// ── Home Page Personalized Starter Questions ──────────────────────────────────

/**
 * GET /api/crossmodel/suggested-questions
 * Returns 6 personalized conversation-starter questions for the home screen,
 * generated from user memory (interests, occupation, location) + recent chat
 * topics. Cached per user for 24h; falls back to generic defaults while
 * generation is pending (pending: true).
 */
router.get('/suggested-questions', controller.getSuggestedQuestions);

// ── Home Page Weather ─────────────────────────────────────────────────────────

/**
 * GET /api/crossmodel/weather
 * Returns the user's location + current weather (Open-Meteo) for the home
 * screen header. Location comes from user memory (location/timezone facts);
 * returns { available: false } when no location is known.
 */
router.get('/weather', controller.getWeatherForHome);

// ── Home Page Calendar Events ─────────────────────────────────────────────────

/**
 * GET /api/crossmodel/calendar-events
 * Returns today's calendar events for the home screen.
 * Requires Google Calendar to be connected.
 */
router.get('/calendar-events', controller.getCalendarEventsForHome);

export default router;
