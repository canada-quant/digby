/**
 * Open CrossModel routes — mounted in app.ts BEFORE the single app-level
 * `authenticate` guard. Everything here is reachable without a Bearer token:
 *
 *  - Anonymous-capable endpoints (/stream, /stream/register, /upload, /feedback)
 *    carry per-route `optionalAuthenticate` — they identify the user when a
 *    token is present but never 401.
 *  - The SSE/EventSource endpoints that require a login (/profile/stream,
 *    /agent/attach) also use `optionalAuthenticate`
 *    (EventSource can't set Authorization headers — it relies on the cm_access
 *    cookie or ?token=) and their handlers self-check `req.user?.id` → 401.
 *  - The integration sub-routers (google, github, x, xero, slack, asana, plaid,
 *    imessage, telegram) self-authenticate PER-ROUTE — their OAuth callbacks,
 *    webhooks, and agent-transport endpoints must stay reachable without a JWT.
 *
 * ORDERING CONTRACT: never add `router.use(authenticate)` (or any middleware
 * that can end a request) to this router — non-matching requests MUST fall
 * through cleanly to the app-level guard mounted after it. New authenticated
 * routes belong in crossmodel.routes.ts (behind the guard), not here.
 */
import { Router } from 'express';
import controller from './crossmodel.controller';
import { optionalAuthenticate } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { uploadMiddleware, processUpload } from './upload.controller';
import googleOAuthRouter from './google/google-oauth.routes';
import driveWatchRouter from './google/drive-watch.routes';
import githubOAuthRouter from './github/github-oauth.routes';
import xOAuthRouter from './x/x-oauth.routes';
import slackOAuthRouter from './slack/slack-oauth.routes';
import asanaOAuthRouter from './asana/asana-oauth.routes';
import xeroOAuthRouter from './xero/xero-oauth.routes';
import plaidRouter from './plaid/plaid.routes';
import imessageRouter from './imessage/imessage.routes';
import telegramRouter from './telegram/telegram.routes';
import { webhookOpenRoutes } from './webhook.routes';
import { postVisitEvents } from './visitors/visitor.controller';
import { visitEventsBodyParser } from './visitors/visitor.routes';
import {
  streamQuerySchema,
  submitFeedbackSchema,
  uxBeaconSchema,
} from './crossmodel.validation';

const router = Router();

/**
 * @swagger
 * /api/crossmodel/stream:
 *   get:
 *     summary: Stream AI responses with Server-Sent Events
 *     description: >
 *       Public endpoint that supports both authenticated and anonymous access.
 *       If a valid Bearer token is provided the user's conversation history and
 *       cross-session memory are loaded automatically. Anonymous users get a
 *       session cookie (cm_session) that persists history for 24 hours.
 *     tags: [CrossModel]
 *     parameters:
 *       - in: query
 *         name: message
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: chatId
 *         description: Named chat ID (authenticated users only) for persistent history
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: mode
 *         schema:
 *           type: string
 *           enum: [fast, thinking]
 *       - in: query
 *         name: webSearch
 *         schema:
 *           type: boolean
 *     responses:
 *       200:
 *         description: SSE stream of AI responses
 */
router.get(
  '/stream',
  optionalAuthenticate,            // Identifies user if Bearer token present
  validate(streamQuerySchema),
  controller.streamQuery
);

/**
 * GET /api/crossmodel/chats/events — the sidebar's per-user invalidation
 * stream (ticket 6201e0ee). OPEN router + optionalAuthenticate because
 * EventSource cannot set headers — auth rides the same ?token= query
 * fallback the run-attach stream uses (route-posture keeps this anonymous-
 * reachable, 401 without a valid token). One SSE frame per chat-list
 * mutation (create/rename/move/archive/restore/session-spawn), emitted by
 * any box (Redis fan-out); the client answers by re-running the existing
 * /chats/changes delta fetch. CHAT_EVENTS_DISABLED=1 answers terminal
 * 'complete{disabled}' and the client falls back to the delta poll.
 */
router.get(
  '/chats/events',
  optionalAuthenticate,
  controller.chatEvents
);

/**
 * POST /api/crossmodel/stream/register
 *
 * Pre-registration for large messages that would exceed GET URL limits (~8KB).
 * Stores {message, chatId, mode, webSearch, uploadId[]} in-memory (10 min TTL)
 * and returns {streamToken} — a UUID the frontend uses in GET /stream?streamToken=xxx.
 * This keeps the SSE connection URL tiny regardless of message length.
 */
router.post(
  '/stream/register',
  optionalAuthenticate,
  controller.registerStreamQuery
);

/**
 * @swagger
 * /api/crossmodel/profile/stream:
 *   get:
 *     summary: Profile interview chat with Digby (SSE)
 *     description: >
 *       Digby conducts a friendly profile interview. Requires authentication
 *       via Bearer token header or ?token= query param (for EventSource).
 *       Extracts [MEMORY:key=value] tags and saves to UserMemory automatically.
 *     tags: [CrossModel]
 *     parameters:
 *       - in: query
 *         name: message
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: history
 *         description: URL-encoded JSON array of prior conversation messages
 *         schema:
 *           type: string
 *       - in: query
 *         name: token
 *         description: JWT access token (for EventSource which can't set headers)
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: SSE stream of Digby's profile interview responses
 *       401:
 *         description: Authentication required
 */
router.get(
  '/profile/stream',
  optionalAuthenticate,
  controller.profileStream
);

/**
 * @swagger
 * /api/crossmodel/upload:
 *   post:
 *     summary: Upload a file (images, PDF, DOCX, XLSX, text — incl. sniffed plain-text like .log) for use in the next message
 *     tags: [CrossModel]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Upload processed, returns uploadId
 */
router.post('/upload', optionalAuthenticate, uploadMiddleware, processUpload);

// ── Google OAuth + Workspace integration ─────────────────────────────────────
// Mounted BEFORE the app-level authenticate guard because the OAuth callback
// is a public endpoint (called by Google, no token available).
// Individual route handlers apply their own auth where needed.
router.use('/google', googleOAuthRouter);

// ── Google Drive watch webhook (owner-confirmed cf_822011a4) ────────────────
// Same pattern as google-oauth: the push receiver is a public endpoint (called
// by Google, no token available) and self-authenticates by verifying the
// channelId+resourceId headers against the stored DriveWatch row.
router.use('/google/drive-watch', driveWatchRouter);

// ── GitHub OAuth + Repository integration ─────────────────────────────────────
// Same pattern as Google: mounted before the guard because the
// OAuth callback is a public endpoint (called by GitHub, no token available).
router.use('/github', githubOAuthRouter);

// ── X (Twitter) OAuth + posting/reading integration ───────────────────────────
// Same pattern: callback is public (called by X). Reads via Bright Data scrape,
// writes via X API v2 with per-user OAuth tokens.
router.use('/x', xOAuthRouter);

// ── Xero OAuth + Accounting integration ───────────────────────────────────────
// Same pattern as Google: mounted before the guard because the
// OAuth callback is a public endpoint (called by Xero, no token available).
router.use('/xero', xeroOAuthRouter);

// ── Slack OAuth + Workspace MCP integration ───────────────────────────────────
// Same pattern as GitHub: callback is public (called by Slack). Reads channels,
// messages, search, and users via the self-hosted slack-mcp container.
router.use('/slack', slackOAuthRouter);

// ── Asana OAuth + Tasks MCP integration ───────────────────────────────────────
// Same pattern as Xero (OAuth with refresh tokens). Reads workspaces, projects,
// and tasks via the self-hosted asana-mcp container.
router.use('/asana', asanaOAuthRouter);

// ── Plaid banking integration ─────────────────────────────────────────────────
// All Plaid routes require authentication (no public callback — Plaid Link is client-side).
// They self-authenticate PER-ROUTE inside the sub-router.
router.use('/plaid', plaidRouter);

// ── macOS iMessage bridge agent ───────────────────────────────────────────────
// Mounted before the app-level authenticate guard: the agent's pairing-complete
// and long-poll/result transport endpoints carry no JWT (they use the agent bearer
// token instead). User-facing routes inside apply `authenticate` individually.
router.use('/imessage', imessageRouter);

// ── Telegram bot integration ──────────────────────────────────────────────────
// Mounted before the app-level authenticate guard: the /telegram/webhook
// endpoint is public (called by Telegram with no JWT — verified via the
// X-Telegram-Bot-Api-Secret-Token header). User routes inside apply auth.
router.use('/telegram', telegramRouter);

// ── Per-chat inbound webhooks ─────────────────────────────────────────────────
// Mounted before the app-level authenticate guard: POST /webhooks/:chatId/fire
// is public (called by the owner's external systems — monitors, CI, deploy
// hooks — with no JWT). It self-authenticates via the per-chat `dgw_` bearer
// token (constant-time sha256 compare — webhook.service) and is rate-limited
// per chat in app.ts. Token lifecycle routes live BEHIND the guard
// (webhookAuthedRoutes, mounted in app.ts).
router.use('/webhooks', webhookOpenRoutes);

// (GET /fact-check/stream — the frontier fact-check — was RETIRED 2026-09-22
// together with every frontier model; see crossmodel.controller.ts.)

// ── User Feedback ─────────────────────────────────────────────────────────────
// Uses optionalAuthenticate because feedbackApi.submit uses raw fetch (not
// apiClient with token refresh). With optionalAuthenticate, the endpoint works
// for both authenticated and anonymous users — and if the user IS authenticated,
// it also creates a user_feature_requests entry so the feedback appears in the
// Account → Feedback tab.

/**
 * POST /api/crossmodel/feedback
 * Submit feedback on an AI response (thumbs down, report, thumbs up).
 * Works for both authenticated and anonymous users.
 * Body: { messageId?, chatId, type, reason?, comment?, modelSet? }
 */
router.post('/feedback', optionalAuthenticate, validate(submitFeedbackSchema), controller.submitFeedback);

/**
 * POST /api/crossmodel/ux/beacon — compute policy step 0 (2026-09-26): the
 * frontend's perceived-latency beacon (first paint / revision seen / tap /
 * abandon) → loop_metrics kind ux_beacon. Anonymous-capable (guests send
 * beacons too); per-route optionalAuthenticate keeps the open posture.
 * UX_BEACON_DISABLED=1 ⇒ 204, nothing recorded.
 */
router.post('/ux/beacon', optionalAuthenticate, validate(uxBeaconSchema), controller.uxBeacon);

/**
 * POST /api/crossmodel/visit-events — first-party visitor analytics (owner 2026-10-07): the web capture's batched
 * page views / funnel steps + first / last-touch attribution (frontend/lib/visitor-analytics.ts). Anonymous-capable
 * (a visitor has no account yet) — optionalAuthenticate links the visitor to a signed-in adult; a Digby Kids token
 * stores nothing. Accepts a sendBeacon text/plain body. Rate-limited per client in app.ts. 204 always on success /
 * skip; VISITOR_ANALYTICS_DISABLED=1 ⇒ 204, nothing stored. Never an IP — an HMAC hash (visitors/ip-hash.ts).
 */
router.post('/visit-events', visitEventsBodyParser, optionalAuthenticate, postVisitEvents);

// One-Digby: EventSource re-attach for a live agent run (mobile resume). MUST
// stay in this OPEN router (before the app-level guard) — EventSource can only
// pass ?token=/cookie, which optionalAuthenticate honors and authenticate does
// not. The handler self-checks req.user?.id → 401.
router.get('/agent/attach', optionalAuthenticate, controller.attachAgentRun);

/**
 * GET /api/crossmodel/session/:sessionId/state — GUEST resume (2026-09-26): the
 * anonymous session's Redis history + whether its run is still live, so a
 * reloaded guest tab shows the answer it never received (or "still working")
 * instead of a vanished turn. Anonymous-ONLY (a signed-in caller gets 404 —
 * their chats have rows + the /chats/:id/stream attach); optionalAuthenticate
 * keeps the open posture. GUEST_SESSION_RESUME_DISABLED=1 ⇒ 404.
 */
router.get('/session/:sessionId/state', optionalAuthenticate, controller.guestSessionState);

/**
 * GET /api/crossmodel/session/:sessionId/stream — GUEST reattach (stream
 * drops, 2026-10-20): the anonymous twin of GET /chats/:id/stream, so a guest
 * whose SSE dropped mid-answer reconnects to the still-running run (this box's
 * buffer, or the other box's Redis mirror) instead of being told to resend.
 * Same credential as /state — the unguessable session UUID in the path;
 * anonymous-ONLY (a signed-in caller gets 404). EventSource can't set headers,
 * so it MUST stay in this open router; rate-limited per client in app.ts.
 * GUEST_STREAM_ATTACH_DISABLED=1 ⇒ 404.
 */
router.get('/session/:sessionId/stream', optionalAuthenticate, controller.guestSessionStream);

// P4: THE one SSE run stream — attaches to a chat's active run regardless of
// pipeline (chat-agent in-process registry; coding via the worker tier's
// durable event log), and honors the retired coding GET ?message= run-start
// for code-capable chats. Same open-posture reasoning as /agent/attach; the
// handler self-checks req.user?.id → 401 and authorizes owner-or-member.
router.get('/chats/:id/stream', optionalAuthenticate, controller.streamChatRun);

export default router;
