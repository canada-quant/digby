import { z } from 'zod';
import { uuidString } from '../../utils/zod-uuid';
import { PATIENCE_MODES } from './types';

// 2026-06-14: Use shared PATIENCE_MODES constant from types.ts instead of inline literals.
// Adding a new patience level now only requires updating types.ts — validation, controller,
// service, and frontend all derive from the same source of truth.
// P4: message/chat intakes also accept 'auto' (the heuristic Auto router — a
// per-message detent, NOT a level; resolved at the boundary). Owner 2026-09-26
// ("default all chats to auto even supervisors"): 'auto' is THE DEFAULT on
// every intake below and IS persisted as a chat's stored mode — the runtime
// routes a stored 'auto' per send (types.ts storedModeToPreset for the machine
// fallback). A caller that names a preset still gets that preset.
const modeWithAutoEnum = z.enum([...PATIENCE_MODES, 'auto']);

export const createChatSchema = z.object({
  body: z.object({
    title: z.string().min(1, 'Title is required').max(200),
    mode: modeWithAutoEnum.default('auto'),
    projectId: uuidString().optional().nullable(),
    // Ghost mode (owner 2026-10-22): a private chat — the run path routes every
    // leg to the admin-designated ghost endpoint and the chat is excluded from
    // memory/learning/cross-chat digests. Plain chats only (refused later on
    // supervisor rows; a coding conversion clears it).
    ghostMode: z.boolean().optional().default(false),
  }),
});

export const listChatsSchema = z.object({
  query: z.object({
    page: z.string().optional().transform(val => (val ? parseInt(val, 10) : 1)),
    limit: z.string().optional().transform(val => (val ? parseInt(val, 10) : 20)),
    // Archive: ?archived=true = the Archived browse view (own stamped chats
    // only); default lists exclude archived rows. String-compared — Express
    // query params arrive as strings ("false" is truthy).
    archived: z.string().optional().transform(val => val === 'true'),
  }),
});

/**
 * GET /chats/changes?since=<ISO>&limit=<n> — the sidebar's live delta poll
 * (ticket d6b2eef5): rows updated at/after the watermark, newest first.
 * includeArchived (ticket 6201e0ee): also return rows that just got archived
 * by ANOTHER lane (the push-kicked fetch) — the client filters rendering.
 */
export const listChatChangesSchema = z.object({
  query: z.object({
    since: z.string().refine(v => Number.isFinite(Date.parse(v)), { message: 'since must be an ISO date-time' }),
    limit: z.string().optional().transform(val => {
      const n = val ? parseInt(val, 10) : 50;
      return Number.isFinite(n) && n > 0 ? Math.min(50, n) : 50;
    }),
    includeArchived: z.string().optional(),
  }),
});

export const getChatSchema = z.object({
  params: z.object({
    id: uuidString('Invalid chat ID'),
  }),
  // Opt-in transcript paging (initial-load cap). BOTH absent = legacy full
  // transcript (all non-FE callers keep today's behavior byte-for-byte).
  // messageLimit present = newest-N page; messagesBefore pages older than a
  // message-id cursor (a previous page's nextMessagesBefore).
  query: z.object({
    messageLimit: z.coerce.number().int().min(1).max(200).optional(),
    messagesBefore: uuidString('Invalid before cursor').optional(),
  }),
});

export const updateChatSchema = z.object({
  params: z.object({
    id: uuidString('Invalid chat ID'),
  }),
  body: z.object({
    title: z.string().min(1).max(200).optional(),
    mode: modeWithAutoEnum.optional(),
    projectId: uuidString().optional().nullable(),
    // Standing instructions (capability gap audit T3b, 2026-09-24): the per-chat
    // systemPrompt the Session settings editor reads/writes; '' or null clears.
    systemPrompt: z.string().max(20000).optional().nullable(),
    // Per-chat lead-seat override (WI-O #4c, 2026-09-25): a built-in id or a
    // '<label>:<modelId>' registry spec; '' or null clears. Validated against
    // the Digby seat's pick set in crossModelService.updateChat.
    leadModel: z.string().max(200).optional().nullable(),
    // Ghost mode (owner 2026-10-22): flip a chat's private posture on/off.
    // Refused on supervisor / coding rows (crossmodel.service.updateChat).
    ghostMode: z.boolean().optional(),
  }),
});

export const deleteChatSchema = z.object({
  params: z.object({
    id: uuidString('Invalid chat ID'),
  }),
});

/** POST /chats/:id/archive + /chats/:id/restore — owner-only stamp flip. */
export const archiveChatSchema = z.object({
  params: z.object({
    id: uuidString('Invalid chat ID'),
  }),
});

/** POST /projects/:id/archive + /projects/:id/restore — owner-only stamp flip. */
export const archiveProjectSchema = z.object({
  params: z.object({
    id: uuidString('Invalid project ID'),
  }),
});

export const convertToCodingSchema = z.object({
  params: z.object({
    id: uuidString('Invalid chat ID'),
  }),
  body: z.object({
    projectId: uuidString('Invalid project ID').optional(),
  }),
});

export const streamQuerySchema = z.object({
  query: z.object({
    chatId: uuidString('Invalid chat ID').optional(),
    // message is optional when streamToken is provided (large-message two-phase flow)
    message: z.string().optional().default(''),
    streamToken: uuidString().optional(),
    // 2026-09-26: an omitted mode is Auto (the compute policy / Auto router
    // decide per send) — the web client always sends depthPrefToWire's value.
    mode: modeWithAutoEnum.default('auto'),
    webSearch: z.string().optional().default('false').transform(val => val === 'true'),
    // Ghost mode (owner 2026-10-22): a GUEST (or a send that opts in) asks for
    // the private posture — the run routes every leg to the admin-designated
    // ghost endpoint. For an AUTHED chat the chat row's flag wins (the stored
    // posture, not a per-send opt-out).
    ghost: z.string().optional().default('false').transform(val => val === 'true'),
    token: z.string().optional(), // JWT token passed via query for EventSource
    // Patience plan 1a label window (2026-09-25): how the client chose the
    // level — 'picked' (the user moved the picker this session), 'default',
    // 'restored' (a chat's stored mode). Unknown values are ignored downstream.
    modeSource: z.string().max(16).optional(),
    // Compute policy DIG DEEPER (2026-09-26): the assistant message id this send
    // escalates — the server runs the NEXT rung not yet spent on that message
    // in the same chat (verify → research). Signed-in only; DIG_DEEPER_DISABLED=1
    // rejects it gracefully at the controller. Never persisted as a user turn.
    escalationOf: uuidString('Invalid escalationOf message id').optional(),
  }),
});

/**
 * POST /api/crossmodel/ux/beacon — the frontend's perceived-latency beacon
 * (compute policy step 0, 2026-09-26): first paint of an answer, a revision
 * seen, a Dig-deeper tap, an abandon. Recorded as loop_metrics kind ux_beacon;
 * UX_BEACON_DISABLED=1 ⇒ 204 with nothing recorded.
 */
export const uxBeaconSchema = z.object({
  body: z.object({
    /** stream_drop / stream_resume (2026-10-20, stream drops): the live answer's SSE dropped / came back. */
    event: z.enum(['first_paint', 'revision_seen', 'tap', 'abandon', 'chip_seen', 'stream_drop', 'stream_resume']),
    chatId: uuidString().optional(),
    messageId: uuidString().optional(),
    /** guest sessions: the client-minted anonymous session uuid (keys the row `anon-<sid>` like ux_ttft / compute_policy) */
    sessionId: uuidString().optional(),
    /** client-measured ms (send → first paint, answer → revision seen, …) */
    ms: z.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
    mode: z.string().max(32).optional(),
    /** tap target: 'escalate' | 'signin_deeper' | … (bounded free text) */
    target: z.string().max(32).optional(),
    /** stream_drop / stream_resume: reconnect attempts so far */
    attempts: z.number().int().min(0).max(10_000).optional(),
    /** stream_drop / stream_resume: 'retrying' | 'resend' | 'resumed' | 'ended' | 'gone' | … (bounded slug) */
    outcome: z.string().max(32).regex(/^[a-z_]+$/).optional(),
    /** stream_drop / stream_resume: the client's own guest flag (a signed-in tab whose access cookie lapsed still says false) */
    guest: z.boolean().optional(),
  }),
});
export type UxBeaconInput = z.infer<typeof uxBeaconSchema>['body'];

/**
 * POST /api/crossmodel/client-error — client-side UI errors (ticket d4e643a5,
 * 2026-11-06). A React render crash / broken handler / rejected promise used to
 * reach nothing but the browser console; this intake persists it to
 * app_error_logs with source 'client-error' so the EXISTING hourly
 * log-signal-sweep auto-files it. Anonymous-capable (a crash on the login page
 * has no token), so every field is length-capped here and re-sanitized in the
 * controller (client-errors/client-error-sanitize.ts). `signature` is
 * deliberately NOT accepted: the server derives the dedupe key from the
 * sanitized message + first stack frame.
 */
export const clientErrorSchema = z.object({
  body: z.object({
    /** The thrown message / rejection reason (scrubbed + capped server-side). */
    message: z.string().min(1).max(4_000),
    /** Error.stack — the frame list (scrubbed + capped server-side). */
    stack: z.string().max(20_000).optional(),
    /** The page URL; reduced to origin+pathname server-side (query + fragment dropped). */
    url: z.string().max(2_000).optional(),
    userAgent: z.string().max(1_000).optional(),
    /** The deploy sha the tab is running (lib/client-error-reporter.ts reads it from the build). */
    buildSha: z.string().max(64).optional(),
    /** The client route (pathname) — a hint only, sanitized server-side. */
    route: z.string().max(500).optional(),
    /** Which handler fired. */
    source: z.enum(['onerror', 'unhandledrejection', 'error-boundary']).optional(),
    /** How many identical throws this tab collapsed into this one report. */
    occurrences: z.number().int().min(1).max(10_000).optional(),
    /** window.onerror's line / column, when known. */
    line: z.number().int().min(0).max(10_000_000).optional(),
    column: z.number().int().min(0).max(10_000_000).optional(),
  }),
});
export type ClientErrorInput = z.infer<typeof clientErrorSchema>['body'];

// ── Chat schedules (workspace-panel Schedules tab; rm9) ───────────────────────

/** DELETE /chats/:id/schedules/:scheduleId — cancel one schedule on this chat. */
export const cancelChatScheduleSchema = z.object({
  params: z.object({
    id: uuidString('Invalid chat ID'),
    scheduleId: uuidString('Invalid schedule ID'),
  }),
});

/** PATCH /chats/:id/schedules/:scheduleId {enabled} — pause/resume one schedule. */
export const updateChatScheduleSchema = z.object({
  params: z.object({
    id: uuidString('Invalid chat ID'),
    scheduleId: uuidString('Invalid schedule ID'),
  }),
  body: z.object({
    enabled: z.boolean({ error: (iss) => (iss.input === undefined ? 'enabled is required' : 'enabled must be a boolean') }),
  }),
});

export const updateMemoryFactSchema = z.object({
  body: z.object({
    key: z.string().min(1, 'Key is required').max(100),
    value: z.string().min(1, 'Value is required').max(1000),
  }),
});

export type UpdateMemoryFactInput = z.infer<typeof updateMemoryFactSchema>['body'];

export type CreateChatInput = z.infer<typeof createChatSchema>['body'];
export type ListChatsQuery = z.infer<typeof listChatsSchema>['query'];
export type ListChatChangesQuery = z.infer<typeof listChatChangesSchema>['query'];
export type GetChatParams = z.infer<typeof getChatSchema>['params'];
export type GetChatQuery = z.infer<typeof getChatSchema>['query'];
export type UpdateChatInput = z.infer<typeof updateChatSchema>['body'];
export type UpdateChatParams = z.infer<typeof updateChatSchema>['params'];
export type DeleteChatParams = z.infer<typeof deleteChatSchema>['params'];
export type StreamQueryParams = z.infer<typeof streamQuerySchema>['query'];

// ── Projects / folders (P2 folder tree) ───────────────────────────────────────

export const createProjectSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'name is required').max(200),
    description: z.string().max(5000).optional().nullable(),
    systemPrompt: z.string().max(20000).optional().nullable(),
    emoji: z.string().max(8).optional(),
    color: z.string().max(32).optional(),
    parentId: uuidString('Invalid parent folder ID').optional().nullable(),
  }),
});

export const moveProjectSchema = z.object({
  params: z.object({
    id: uuidString('Invalid project ID'),
  }),
  body: z.object({
    parentId: uuidString('Invalid parent folder ID').nullable(),
  }),
});

export const getBreadcrumbsSchema = z.object({
  params: z.object({
    id: uuidString('Invalid project ID'),
  }),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>['body'];
export type MoveProjectInput = z.infer<typeof moveProjectSchema>['body'];

// ── Feedback ──────────────────────────────────────────────────────────────────

export const submitFeedbackSchema = z.object({
  body: z.object({
    messageId: uuidString().optional(),
    chatId:    uuidString('Invalid chat ID'),
    type:      z.enum(['thumbs_down', 'thumbs_up', 'report']),
    reason:    z.enum(['wrong', 'harmful', 'slow', 'formatting', 'incomplete', 'other']).optional(),
    comment:   z.string().max(1000).optional(),
    modelSet:  z.enum(['frontier', 'open_source']).optional(),
  }),
});

export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>['body'];
