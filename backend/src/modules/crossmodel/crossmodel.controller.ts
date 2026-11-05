import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import crossModelService from './crossmodel.service';
import * as platformService from './platform/platform.service';
import { subscribeChatEvents } from './platform/chat-events';
import { openSSEStream } from './coding/live-runs';
// isAdminViewer = ONE admin predicate: ADMIN role, or the owner e-mail on PRODUCTION only — the inline
// `email !== 'example-user@example.com'` checks made that address a super-admin on any open-registration
// self-host (self-host setup hardening 2026-10-20).
import { resolveViewModeForRequest, isAdminViewer } from './view/view-mode';
import { wrapSseResponse } from './view/minimal-sse';
import { minimalChatDto } from './view/minimal-view';
import { AUTO_MODE, normalizePatienceMode } from './types';
import { routeMessageAuto } from './platform/auto-router-gate';
// Self-host setup hardening (2026-10-20): instance-level configuration truth (pure leaf).
import { webSearchMissingOnInstance, webSearchStatus } from './platform/instance-setup';
import { utilityChainUnconfigured } from '../../utils/utility-llm';
import { queryLoopMetrics, queryLoopMetricOutcomes, queryLoopMetricPayloadSizes, summarizeLoopMetrics, recordLoopMetric, LOOP_METRIC_KINDS } from './platform/loop-metrics.service';
import { turnCostUsd, resolvePrice } from './coding/cost';
import contextService from './context.service';
import { isGuestSessionRunActive } from './chat-agent/guest-session-run';
import { guestStreamAttachDisabled, sseEarlyHeartbeatDisabled, recordSseViewerDrop, recordSseReattach, streamSessionKey, STREAM_BEACON_EVENTS, allowStreamBeacon } from './chat-agent/stream-drops';
import { hashedClientKey } from '../../middleware/rate-limit-paths';
// moonshotIntegration — still used by profileStream + consolidateMemory
import moonshotIntegration from './integrations/moonshot.integration';
import logger from '../../utils/logger';
import redisClient from '../../config/redis';
import {
  StreamQueryRegistration,
  registrationIdentity,
  reserveRegistrationSlot,
  releaseRegistrationSlot,
  storeRegistration,
  consumeRegistration,
} from './stream-registration';
import {
  CreateChatInput,
  ListChatsQuery,
  ListChatChangesQuery,
  GetChatParams,
  GetChatQuery,
  UpdateChatInput,
  UpdateChatParams,
  DeleteChatParams,
  StreamQueryParams,
} from './crossmodel.validation';
import { loadAttachment, combineAttachments, Attachment } from './upload.controller';
import { resolveStagedUploads, attachmentDropAnnotation } from './attachment-resolution';
import { persistChatUploads } from './chat-files.service';
import prisma from '../../config/database';
import { decisionSpendSummary } from './platform/decision-gate-spend';
import { decisionPriceFor, decisionCallUsd, DECISION_SPEND_PROFILE, DECISION_GATE_SYNTHETIC_SESSION } from './platform/decision-gate-pricing';
import { FEEDBACK_TYPES } from './feedback/feedback.service';
import { normalizeTicketStatus, ticketStatusRank } from './feedback/ticket-status';
import { updateContextAsync } from './langgraph/memory.graph';
import { streamKidResponse, generateKidStatus } from './integrations/qwen-kid.integration';
import { searchWithBrightData } from './mcp-search';
import { boundSerpForContext } from './chat-agent/serp-bound';
import { runBrowserAgentSession } from './browser-agent';
import { decideChatGate, mapAttachmentForAgent, chatWriteAccessGranted, chatReadAccessGranted, streamAccessDeniedError } from './chat-agent/chat-gate';

/**
 * Bound staged-upload id lists at the SSE boundary (review M1, ac65d51e) —
 * queued sends now PERSIST ids and re-resolve them at drain, so mirror the
 * fleet zod schema exactly (fleet.validation.ts): strings, ≤64 chars, ≤8 ids.
 */
function sanitizeUploadIds(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64)
    .slice(0, 8);
}
import { buildIntegrationContext, buildIntegrationContextBounded } from './integration-context';
import { buildGuestLocationBlock } from './guest-location';
import { parseCalendarEventsText } from './calendar-events.parser';
import {
  checkDeepResearchQuota,
  reserveDeepResearchQuota,
  reserveAnonDeepResearchQuota,
  refundDeepResearchQuota,
  queuedCouncilQuotaDisabled,
  getDeepResearchDailyLimit,
  getAllDeepResearchUsageToday,
  invalidateLimitCache,
  getPatienceAutoOnly,
  getPatienceAutoOnlyState,
  setPatienceAutoOnly,
  getDepthPolicyPublic,
  deepResearchAllowance,
  PATIENCE_AUTO_ONLY_KEY,
  // Audit 2026-09-26: the Always-Auto switch flips through the audited shape
  // (strict value, idempotent, `_by` row, `patience_switch` telemetry) + a GET
  // with since / by. (The signed-in Advanced preset is honoured only under the
  // PATIENCE_AUTO_ONLY_HONOUR_PRESET opt-in — platform/send-mode.ts.)
  parsePatienceSwitchValue,
} from './rate-limit.service';
// Patience plan 1a (2026-09-25): the explicit-level LABEL WINDOW + modeSource.
import { shadowAutoRouteAgainst, normalizeModeSource } from './platform/auto-router-gate';
// 2026-09-26 audit (unify-routing): THE per-send level resolver every entry point
// shares (web stream here, REST / tool seam in platform.service, Telegram).
import { resolveSendMode, demoteForQuota, type SendRouting } from './platform/send-mode';
// Supervisor OFF switch (owner 2026-09-26): the two admin-only SystemSettings
// ride the generic PUT /admin/settings/:key with validation + audit + telemetry.
import { getSupervisorSwitchState, isSupervisorSwitchKey, parseSwitchValue, setSupervisorSwitch } from './platform/supervisor-switch';
// Web-search provider config (ticket 6f4d42f2): admin-settable Bright Data
// credentials for self-hosted/Edge instances — Admin → Settings → Web search.
import { getWebSearchConfigStatus, saveWebSearchConfig } from './platform/search-provider-config';
// Compute policy (2026-09-26, branch cp/harness): DIG DEEPER (escalationOf →
// the next rung on a persisted assistant message), the DepthBudget refusal of
// the next rung, the early SSE header flush switch and the UX beacon endpoint.
import { nextRungForMessage, digDeeperDisabled, uxBeaconDisabled, escalationPlan, attachGuestStateChips, type NextRung } from './chat-agent/compute-policy-wiring';
import { labelComputePolicyEscalated, labelRevisionMaterialFromMetadata, labelDraftsAgreeFromMetadata, factsFromDepthMetadata } from './chat-agent/compute-policy-labels';
// 2026-06-15: IP normalization to fix IPv4-mapped IPv6 mismatches in stream token verification
import { normalizeIp, sameIpSession, maskIp } from './langgraph/pipeline-utils';

/**
 * Extract and normalize the client IP from a request.
 * Handles x-forwarded-for header (first IP in chain) with normalizeIp()
 * to strip the ::ffff: IPv4-mapped IPv6 prefix.
 *
 * 2026-06-17: Extracted from 2 inline duplicate patterns to prevent divergence.
 */
export function getClientIp(req: Request): string {
  return normalizeIp(
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown'
  );
}

/**
 * The client IP for the GUEST DEEP-RESEARCH QUOTA KEY ONLY (patience plan 1a
 * §3.4, 2026-09-25). Behind ALB → nginx → Express with `trust proxy 1`
 * (app.ts) `req.ip` is the ALB node, and getClientIp's FIRST X-Forwarded-For
 * hop is header-writable — neither is a trustworthy per-client key. Once the
 * Phase 0 hop-count probe records the real number of trusted proxies, set
 * QUOTA_TRUSTED_PROXY_HOPS=<n> (expected 2: ALB + nginx) and this takes the
 * XFF entry the LAST trusted proxy appended — the entry `n` from the right
 * (the socket peer itself never appears in XFF), which a client cannot forge
 * by prepending hops. Unset (today) ⇒ byte-identical to getClientIp, which
 * itself stays UNTOUCHED: it also keys registration slots and the anon
 * stream-token binding, and switching those to a shared ALB address would
 * collapse every guest onto a handful of keys. Exported for tests.
 */
export function quotaClientIp(req: Request): string {
  const hops = Number(process.env.QUOTA_TRUSTED_PROXY_HOPS);
  if (!Number.isInteger(hops) || hops < 1) return getClientIp(req);
  const raw = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(raw) ? raw.join(',') : String(raw ?? '')).split(',').map(s => s.trim()).filter(Boolean);
  if (chain.length < hops) return getClientIp(req);
  return normalizeIp(chain[chain.length - hops]);
}

/** Cookie name for anonymous session identity */
const SESSION_COOKIE = 'cm_session';
/** How long the anonymous session cookie lasts (24 h) */
const SESSION_COOKIE_MAX_AGE = 86400 * 1000;
/** Guest sessions (ticket 63bb607f): the explicit ?sessionId an anonymous
    client may use to NAME its own ephemeral context — UUID-shaped only. */
const GUEST_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Ticket 054daeb7 (2026-10-27): accounts the DEPLOY GATE depends on —
// deploy-auth-smoke.sh logs in as the canonical user on every wave
// (SMOKE_CANON_EMAIL); deleting it makes every subsequent deploy fail the
// authenticated smoke with a bare 401 the CI log does not even surface.
// Default protects the documented canonical account (AGENTS.md); override with
// a comma-separated ADMIN_DELETE_PROTECTED_EMAILS (empty string = unprotected).
const ADMIN_DELETE_PROTECTED_EMAILS_DEFAULT = 'claudebot@digby.ai';
const adminDeleteProtectedEmails = (): string[] => {
  const raw = process.env.ADMIN_DELETE_PROTECTED_EMAILS !== undefined
    ? process.env.ADMIN_DELETE_PROTECTED_EMAILS
    : ADMIN_DELETE_PROTECTED_EMAILS_DEFAULT;
  return String(raw)
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
};

/** ms since an epoch stamp, or undefined when unknown (stream-drop telemetry). */
const elapsedSince = (startedAt: number | null | undefined): number | undefined =>
  typeof startedAt === 'number' ? Date.now() - startedAt : undefined;

// ── Stream Query Pre-registration ─────────────────────────────────────────────
// Used when message is too large to fit safely in a GET URL query string (>~1.5KB).
// POST /stream/register stores the full params and returns a streamToken UUID;
// GET /stream consumes them by token (single-use). Redis-backed (see
// stream-registration.ts) — the register POST and the EventSource GET land on
// DIFFERENT web instances behind the ALB, so this state must never live in
// module memory (2026-08-16 prod 410 class).

// ── News Headlines — delegated to news.service.ts ────────────────────────────
// The news.service.ts module handles Redis caching + background pre-fetch scheduler.
// We import lazily inside the handler to avoid circular-dependency issues at startup.

export class CrossModelController {

  // ── User Preferences (model set) ──────────────────────────────────────────

  /**
   * GET /api/crossmodel/preferences
   * Returns the user's current model set preference.
   */
  async getPreferences(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const prefs = await prisma.userPreferences.findUnique({ where: { userId } });
      // Seats govern sessions (2026-09-28): is the stored codingModel a pick the user
      // made THEMSELVES (context-store marker), and what does the Workspace default
      // seat resolve to right now — Account → Coding renders "Following the admin
      // seat (<model>)" when there is no explicit pick. Fail-open on both.
      const governance = await import('./coding/seat-governance').catch(() => null);
      const [codingModelExplicit, codingSeatModel] = governance
        ? await Promise.all([
          governance.isCodingModelExplicit(userId, prefs?.codingModel).catch(() => false),
          governance.resolveCodingSeatModel().catch(() => 'glm-5.3'),
        ])
        : [false, 'glm-5.3'];
      res.json({
        success: true,
        data: {
          modelSet: prefs?.modelSet || 'open_source',
          // Legacy aliases: stored kimi-k2.6 reads as kimi-k3 (2026-07-17 switch);
          // stored glm-5.2 reads as glm-5.3 (owner 2026-09-03 GLM-5.3 cutover);
          // stored deepseek-v4-pro reads as deepseek-flash (V4.1 Flash cutover 2026-09-10).
          codingModel: (prefs?.codingModel === 'kimi-k2.6' ? 'kimi-k3'
            : prefs?.codingModel === 'glm-5.2' ? 'glm-5.3'
            : prefs?.codingModel === 'deepseek-v4-pro' ? 'deepseek-flash'
            : prefs?.codingModel) || 'glm-5.3',
          codingModelExplicit,
          codingSeatModel,
          codingPermissionMode: prefs?.codingPermissionMode || 'auto', // platform default 'auto' since 2026-09-17 (owner oq_93a7e24c)
          // chatEngine was persisted by PUT + returned there, but OMITTED here —
          // so the Digby Agent toggle saved yet reverted to off on every reload
          // (the read never echoed the stored value). Owner-reported 2026-07-22.
          chatEngine: (prefs as any)?.chatEngine ?? '',
          devContainerEnabled: prefs?.devContainerEnabled ?? false,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/crossmodel/preferences
   * Upsert the user's model set preference. Body: { modelSet: 'frontier' | 'open_source' }
   */
  async updatePreferences(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { modelSet, codingModel, codingPermissionMode, devContainerEnabled } = req.body as {
        modelSet?: string; codingModel?: string; codingPermissionMode?: string; devContainerEnabled?: boolean;
      };

      if (modelSet !== undefined && modelSet !== 'frontier' && modelSet !== 'open_source') {
        return res.status(400).json({ success: false, message: 'modelSet must be "frontier" or "open_source"' });
      }
      // Digby Code: open-source models ONLY. (kimi-k2.6 → kimi-k3, 2026-07-17;
      // glm-5.2 → glm-5.3, owner 2026-09-03; stored legacy prefs are mapped
      // forward on read, new writes must use the current ids — glm-5.2 is
      // still ACCEPTED here so in-flight clients don't 400 mid-rollout, and is
      // normalized forward at resolution time.)
      const OS_CODING = ['glm-5.3', 'glm-5.2', 'deepseek-flash', 'deepseek-v4-pro', 'kimi-k3'];
      // '' = "follow the admin's Workspace default seat" (seats govern sessions, 2026-09-28).
      if (codingModel !== undefined && codingModel !== '' && !OS_CODING.includes(codingModel)) {
        // Digby Edge (Phase 2): a '<label>:<modelId>' spec is accepted when it
        // resolves to an enabled, coding-capable custom endpoint model.
        const { resolveRegistryModel } = await import('./model-endpoints/model-endpoints.service');
        const reg = await resolveRegistryModel(codingModel, userId).catch(() => null);
        if (!reg?.coding) {
          return res.status(400).json({ success: false, message: `codingModel must be one of ${OS_CODING.join(', ')} or a "<label>:<modelId>" custom endpoint model` });
        }
      }
      if (codingPermissionMode !== undefined && !['auto', 'plan', 'ask'].includes(codingPermissionMode)) {
        return res.status(400).json({ success: false, message: 'codingPermissionMode must be auto|plan|ask' });
      }
      if (devContainerEnabled !== undefined && typeof devContainerEnabled !== 'boolean') {
        return res.status(400).json({ success: false, message: 'devContainerEnabled must be a boolean' });
      }
      // 2026-07-23 agentic-only cutover: chatEngine is no longer validated or
      // persisted — every chat runs the agent engine now. The column stays in
      // the schema (old clients still send/read the key; it is accepted and
      // ignored here, and echoed from storage below).

      const data: any = {};
      if (modelSet !== undefined) data.modelSet = modelSet;
      if (codingModel !== undefined) data.codingModel = codingModel;
      if (codingPermissionMode !== undefined) data.codingPermissionMode = codingPermissionMode;
      if (devContainerEnabled !== undefined) data.devContainerEnabled = devContainerEnabled;

      const prefs = await prisma.userPreferences.upsert({
        where: { userId },
        update: data,
        create: { userId, ...data },
      });
      // A permission mode the user set THEMSELVES (cohesive chat live fixes
      // 2026-09-28, platform/human-spawn.ts): marks the preference DELIBERATE
      // so a human-turn spawn honours a non-auto choice — a stored pre-flip
      // 'ask' default that was never chosen does not cripple the user's ask.
      if (codingPermissionMode !== undefined) {
        void import('./platform/human-spawn').then((m) => m.markPermissionModeExplicit(userId, codingPermissionMode, 'settings')).catch(() => {});
      }
      // Seats govern sessions (2026-09-28): a coding model saved here is an EXPLICIT pick
      // (the marker names the stored value); '' / the schema default clears the marker so
      // the admin's Workspace default seat governs the user's sessions again.
      if (codingModel !== undefined) {
        await import('./coding/seat-governance').then((m) => m.markCodingModelExplicit(userId, codingModel, 'settings')).catch(() => {});
      }

      // Refresh the Redis modelSet cache when it changed (see 2026-06-20 note).
      if (modelSet !== undefined) {
        redisClient.setEx(`user:modelset:${userId}`, 60, modelSet).catch(() => {});
      }

      logger.info(`Preferences updated: userId=${userId} ${JSON.stringify(data)}`);
      res.json({
        success: true,
        data: {
          modelSet: prefs.modelSet,
          codingModel: prefs.codingModel,
          codingPermissionMode: prefs.codingPermissionMode,
          chatEngine: (prefs as any).chatEngine ?? '',
          devContainerEnabled: prefs.devContainerEnabled ?? false,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Create new chat
   */
  /** One-Digby: is a detached agent run live for this chat? (UI attach check +
   *  the queued-drain watch's poll target.)
   *  Access is READ level (P5 audit): project members can queue messages into
   *  a shared chat (chatWriteAccessGranted), so their drain watch must get a
   *  real answer here — the old owner-only 404 read as "idle" and cleared the
   *  Queued badge before the answer existed. Busy state is the CROSS-PROCESS
   *  truth (chat-busy), not this process's registry alone. */
  async agentRunActive(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const chatId = String(req.query.chatId || '');
      if (!chatId) return res.status(400).json({ error: 'chatId is required' });
      const { access, exists } = await crossModelService.getChatAccess(chatId, userId);
      if (!chatReadAccessGranted({ userId, access, exists })) {
        return res.status(404).json({ error: 'Chat not found' }); // no existence leak
      }
      const { isChatBusy } = await import('./chat-agent/chat-busy');
      return res.json({ success: true, data: { active: await isChatBusy(chatId) } });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * GET /api/crossmodel/session/:sessionId/state — GUEST resume (owner report
   * 2026-09-26: a guest who reloaded mid-answer came back to a chat with the
   * assistant turn GONE). Anonymous-only: the guest chat lives in the browser
   * plus the 24h Redis `cm_session:<id>` history the run appends to at finalize
   * (detached runs finish without a viewer), so a reloaded tab reads BOTH the
   * answer the tab never received and whether the run is still live
   * (guest-session-run.ts marker — truthful on either blue/green instance).
   * Returns { active, messages:[{role, content}] }. A signed-in caller gets 404
   * (their chats have rows + the /chats/:id/stream attach); a non-UUID id 400.
   */
  async guestSessionState(req: Request, res: Response) {
    try {
      if (req.user?.id) return res.status(404).json({ error: 'Not found' });
      const sessionId = String(req.params.sessionId || '');
      if (!GUEST_SESSION_ID_RE.test(sessionId)) return res.status(400).json({ error: 'sessionId must be a UUID' });
      const [active, ctx] = await Promise.all([
        isGuestSessionRunActive(sessionId),
        contextService.loadSessionContext(sessionId),
      ]);
      const history = (ctx.fullHistory ?? []).map(m => ({ role: m.role, content: m.content }));
      // Depth UX (2026-09-26, audit sse-ui-restore-14): the guest's depth chip
      // (`signin_deeper`, or none under DIG_DEEPER_DISABLED=1) rides the LAST
      // assistant message — the reloaded tab hydrates the same control the
      // streaming tab showed (the Redis history keeps content only).
      const messages = attachGuestStateChips(history);
      return res.json({ success: true, data: { active, messages } });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * GET /api/crossmodel/session/:sessionId/stream — GUEST reattach (stream
   * drops, 2026-10-20). A guest whose SSE dropped mid-answer used to be told
   * "Connection lost — send your message again" while the run kept going (and a
   * resend then hit "Digby is still working…"). This is the guest twin of
   * GET /chats/:id/stream, with the same credential model as /state: the
   * unguessable guest session UUID in the path (anonymous-ONLY — a signed-in
   * caller gets 404; a non-UUID 400). The run key and the mirror key are both
   * DERIVED from that id (`chat:session:<sid>` / `cm:runevents:session:<sid>`),
   * so a caller can only ever read the session it names. Precedence:
   *   1. a run ACTIVE in THIS process — replay + tail;
   *   2. a guest run live on the OTHER box (cross-process marker) — tail its
   *      Redis mirror (chat-agent.service mirrors guest runs too);
   *   3. a run that just finished in THIS process (its 30 s retention) —
   *      replay it;
   *   4. a run that just finished on the other box — replay its mirror;
   *   5. otherwise one complete{interrupted:true} (the client then reads
   *      /state for the answer the session history holds).
   * A LIVE run outranks every finished one (review 2026-10-20): the retained
   * run here can be the guest's PREVIOUS turn while the turn the tab waits on
   * runs on the other box. A finished replay still cannot say which question
   * it answered, so the client resolves every guest-attach complete against
   * the session history (CodeSessionView startGuestResume) — never appends it.
   * Rate-limited per client in app.ts. GUEST_STREAM_ATTACH_DISABLED=1 ⇒ 404.
   */
  async guestSessionStream(req: Request, res: Response) {
    if (guestStreamAttachDisabled()) return res.status(404).json({ error: 'Not found' });
    if (req.user?.id) return res.status(404).json({ error: 'Not found' });
    const sessionId = String(req.params.sessionId || '');
    if (!GUEST_SESSION_ID_RE.test(sessionId)) return res.status(400).json({ error: 'sessionId must be a UUID' });
    // Minimal view (2026-10-16): the same per-viewer frame filter as the stream it resumes.
    res = wrapSseResponse(res, await resolveViewModeForRequest(req as any));
    const liveRuns = await import('./coding/live-runs');
    const { chatSessionRunKey } = await import('./chat-agent/guest-session-run');
    const sessionKey = streamSessionKey(null, sessionId);
    const runKey = chatSessionRunKey(sessionId);
    const attachLocal = () => {
      recordSseReattach({ surface: 'guest', source: liveRuns.isRunTruncated(runKey) ? 'truncated' : 'local', sessionKey, guest: true });
      return liveRuns.attachRunToResponse({
        req, res, runKey,
        onDrop: (d) => { recordSseViewerDrop({ surface: 'guest', path: 'local', sessionKey, elapsedMs: d.elapsedMs, eventsWritten: d.eventsWritten, runElapsedMs: elapsedSince(liveRuns.runStartedAt(runKey)), guest: true }); },
      });
    };
    if (liveRuns.isRunActive(runKey)) return attachLocal();
    const { attachRemoteChatRun, replayFinishedRemoteRun, guestMirrorId } = await import('./chat-agent/run-event-mirror');
    const mirrorId = guestMirrorId(sessionId);
    if (await isGuestSessionRunActive(sessionId)) {
      return attachRemoteChatRun({
        req, res, chatId: mirrorId,
        isBusy: () => isGuestSessionRunActive(sessionId),
        onReplay: (r) => { recordSseReattach({ surface: 'guest', source: r.truncated ? 'truncated' : 'remote', sessionKey, events: r.events, guest: true }); },
        onDrop: (d) => { recordSseViewerDrop({ surface: 'guest', path: 'remote', sessionKey, elapsedMs: d.elapsedMs, eventsWritten: d.eventsWritten, guest: true }); },
      });
    }
    // Only once nothing is live anywhere: this process's retained finished run.
    if (liveRuns.runExists(runKey)) return attachLocal();
    if (await replayFinishedRemoteRun(res, mirrorId)) return;
    const hb = liveRuns.openSSEStream(res);
    return liveRuns.endSSEWithEvent(res, hb, 'complete', { interrupted: true });
  }

  /**
   * P4: RETIRED in favor of the unified GET /chats/:id/stream (one endpoint for
   * BOTH pipelines). 308-redirects, preserving every query param but moving
   * ?chatId= into the path. (308 = permanent, method-preserving.)
   */
  async attachAgentRun(req: Request, res: Response) {
    const chatId = String(req.query.chatId || '');
    if (!chatId) return res.status(400).json({ error: 'chatId is required' });
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query)) {
      if (k === 'chatId') continue;
      if (typeof v === 'string') params.set(k, v);
      else if (Array.isArray(v)) for (const item of v) if (typeof item === 'string') params.append(k, item);
    }
    const qs = params.toString();
    return res.redirect(308, `/api/crossmodel/chats/${encodeURIComponent(chatId)}/stream${qs ? `?${qs}` : ''}`);
  }

  /**
   * P4 — THE one SSE run stream: GET /api/crossmodel/chats/:id/stream.
   *
   * Attaches to the chat's ACTIVE run regardless of pipeline: chat-agent runs
   * register in-process under `chat:${id}`; coding runs execute on the WORKER
   * tier (#74/#75) and are followed through the durable agent_events log via
   * the coding stream controller. Replays what the client missed, then tails
   * live. A viewer disconnect never cancels the run (runs are detached;
   * stopping is an explicit action on the stop endpoints).
   *
   * Auth: header JWT or ?token= (EventSource can't set headers) via
   * optionalAuthenticate; access = owner or any project member (read) — the
   * same rule as platform getChatStatus.
   *
   * Query params (inherited from the two retired attach endpoints):
   *   - token    — query JWT (unchanged).
   *   - message  — BACK-COMPAT start: the retired coding GET stream accepted a
   *                message to START a run; honored here for code-capable chats
   *                by delegating to the coding stream controller (409 when a run
   *                is already active). Plain chats never started runs from a
   *                GET — send via POST /stream or POST /chats/:id/messages.
   *
   * The retired endpoints 308 here: GET /agent/attach and
   * GET /coding/sessions/:id/stream (query string preserved).
   */
  async streamChatRun(req: Request, res: Response) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    // Minimal view (2026-10-16, view/minimal-sse.ts): every frame written below is filtered for this viewer.
    res = wrapSseResponse(res, await resolveViewModeForRequest(req as any));
    const chatId = String(req.params.id || '');
    if (!chatId) return res.status(400).json({ error: 'chat id is required' });

    // Same access rule as getChatStatus: owner or project member, read level.
    let chat: { id: string; title: string; mode: string; userId: string; projectId: string | null };
    try {
      chat = await crossModelService.getChatById(chatId, userId, 'read');
    } catch (err: any) {
      return res.status(err.statusCode || 404).json({ error: err.message || 'Chat not found' });
    }

    const message = typeof req.query.message === 'string' ? req.query.message : '';
    const liveRuns = await import('./coding/live-runs');

    // P5: the coding surface follows CAPABILITY (workspace satellite / folder
    // workspace), never a stored mode — legacy mode='code' chats all carry the
    // satellite, so this is behavior-preserving. Computed lazily, once.
    // (User Space §4: the ATTACH precedence below keys off hasWorkspaceState;
    // the capability read here feeds only the kid 403 + the back-compat
    // ?message= start, whose lazy attach inside streamCapabilityRun is the
    // sanctioned backstop.)
    let capability: { codeCapable: boolean; hasWorkspaceState: boolean; workspaceReady: boolean } | null = null;
    const getCap = async () => {
      if (!capability) {
        const { getChatCapability } = await import('./coding/coding-data.service');
        capability = await getChatCapability(chat)
          .catch(() => ({ codeCapable: false, hasWorkspaceState: false, workspaceReady: false }));
      }
      return capability;
    };

    // Coding stays an adult surface (mirrors the retired coding stream endpoint).
    if ((req.user as any)?.isChild && (await getCap()).codeCapable) {
      return res.status(403).json({ error: 'Coding is not available for child accounts' });
    }

    // ── Back-compat START (?message=… — see docstring). ──────────────────────
    // MERGE-1 slice 2 (2026-11-03): this branch used to read
    // `if (capability.codeCapable) streamCapabilityRun(...)`. codeCapable
    // includes the folder-chain leg and every chat is auto-filed into a capable
    // user-space project, so ANY `GET /chats/<plain>/stream?message=hello`
    // attached a PERMANENT workspace satellite — silently converting the chat
    // into a coding session for good, with no code-intent trigger, no
    // supervisor guard and no task-kind gate. A mutating GET, ungated, at the
    // exact seam the 2026-10-20 workspace-attach audit exists to close.
    // It now asks the SAME per-message resolver as the two POST send seams
    // (platform/send-profile.ts): the satellite routes, the gates decide
    // whether this send may attach one.
    if (message.trim()) {
      const { resolveSendProfile } = await import('./platform/send-profile');
      const decision = await resolveSendProfile({
        chat,
        senderUserId: userId,
        message,
        origin: 'user',
        hasUploads: false,
      });
      if (decision.profile === 'coding') {
        const { default: codingStreamController } = await import('./coding/coding-stream.controller');
        return codingStreamController.streamCapabilityRun(req, res, chat, message);
      }
      // Busy is the CROSS-PROCESS truth (chat-busy): the local registry alone
      // missed runs live on the other blue/green instance (wrong error text).
      const { isChatBusy } = await import('./chat-agent/chat-busy');
      if (await isChatBusy(chatId)) {
        return res.status(409).json({ error: 'A run is already in progress for this chat. Wait for it to finish (or Stop it) before sending another message.' });
      }
      return res.status(400).json({ error: 'This endpoint attaches to runs — send chat messages via POST /api/crossmodel/stream (or the platform messages endpoint).' });
    }

    // ── ATTACH precedence (durable-runs tier, #74/#75): ──
    //  1. an in-process CHAT-AGENT run (live-runs registry, chat:${id}) — replay+tail;
    //  2. a workspace-state chat → the coding DURABLE event log via the coding
    //     stream controller (tails queued/running rows, replays the latest
    //     finished run, and owns the orphaned-'running' reset — never
    //     duplicate that logic here);
    //  3. a BUSY plain chat with no local run → the run is live on the OTHER
    //     blue/green instance (chat runs are in-process; the ALB has no
    //     stickiness) — tail its Redis event mirror instead of lying
    //     "interrupted" while the chat list simultaneously reports running;
    //  4. an idle plain chat → a single interrupted complete (client reloads).
    const runKey = liveRuns.findLiveRunKey(chatId);
    if (runKey) {
      // Stream drops (2026-10-20, chat-agent/stream-drops.ts): the reattach and
      // a viewer that leaves mid-run become throttled loop_metrics rows.
      recordSseReattach({ surface: 'attach', source: liveRuns.isRunTruncated(runKey) ? 'truncated' : 'local', sessionKey: chatId, guest: false });
      return liveRuns.attachRunToResponse({
        req, res, runKey,
        onDrop: (d) => { recordSseViewerDrop({ surface: 'attach', path: 'local', sessionKey: chatId, elapsedMs: d.elapsedMs, eventsWritten: d.eventsWritten, runElapsedMs: elapsedSince(liveRuns.runStartedAt(runKey)), guest: false }); },
      });
    }
    if ((await getCap()).hasWorkspaceState) {
      const { default: codingStreamController } = await import('./coding/coding-stream.controller');
      return codingStreamController.streamRun(req, res);
    }
    const { isChatBusy } = await import('./chat-agent/chat-busy');
    const { attachRemoteChatRun, replayFinishedRemoteRun } = await import('./chat-agent/run-event-mirror');
    if (await isChatBusy(chatId)) {
      return attachRemoteChatRun({
        req, res, chatId,
        onReplay: (r) => { recordSseReattach({ surface: 'attach', source: r.truncated ? 'truncated' : 'remote', sessionKey: chatId, events: r.events, guest: false }); },
        onDrop: (d) => { recordSseViewerDrop({ surface: 'attach', path: 'remote', sessionKey: chatId, elapsedMs: d.elapsedMs, eventsWritten: d.eventsWritten, guest: false }); },
      });
    }
    // The run may have JUST finished on the peer instance (local
    // FINISHED_RETENTION_MS replay only exists where the run executed) — the
    // mirror still holds the full window incl. the terminal; replay it rather
    // than reporting an interruption that never happened.
    if (await replayFinishedRemoteRun(res, chatId)) return;
    const hb = liveRuns.openSSEStream(res);
    return liveRuns.endSSEWithEvent(res, hb, 'complete', { interrupted: true });
  }

  /** One-Digby: explicitly stop a detached agent chat run (never inferred from disconnects). */
  async stopAgentRun(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const chatId = String(req.body?.chatId || '');
      if (!chatId) return res.status(400).json({ error: 'chatId is required' });
      const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { userId: true } });
      if (!chat || chat.userId !== userId) return res.status(404).json({ error: 'Chat not found' });
      const { chatRunKey } = await import('./chat-agent/chat-agent.service');
      const { isRunActive, cancelRun } = await import('./coding/live-runs');
      const key = chatRunKey(chatId);
      if (isRunActive(key)) {
        cancelRun(key);
        // A Stop ALSO releases any ask_user wait immediately (coding Stop parity —
        // run-executor does the same): the chat run keys its questions on the chat
        // id, and without this a run parked inside awaitAnswer would sit out the
        // 60-min registry window before finalizing 'cancelled'. The askUser
        // wrapper clears the confirm:pending presence key as the wait unwinds.
        const { resolvePendingForSession } = await import('./coding/question-registry');
        resolvePendingForSession(chatId);
        return res.json({ success: true, data: { stopping: true } });
      }
      // Cross-process stop (P5 audit): the run may be executing on the OTHER
      // blue/green instance — its heartbeat owns the Redis liveness key. Leave
      // a stop-request flag the owning process's heartbeat polls and applies
      // (it cancels + releases parked ask_user waits there), instead of the old
      // process-local stopping:false lie.
      const { hasRemoteChatRun, requestChatRunStop } = await import('./chat-agent/chat-busy');
      if (await hasRemoteChatRun(chatId)) {
        await requestChatRunStop(chatId);
        return res.json({ success: true, data: { stopping: true } });
      }
      return res.json({ success: true, data: { stopping: false } });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * GET /api/crossmodel/chats/:id/queue — the caller's OWN user messages
   * waiting behind a live run, in the order the drain will deliver them
   * (ticket ea04454c). Position + content + attachment count; machine relay
   * rows and other people's rows are never listed (queue-controls.ts).
   */
  async listChatQueue(req: Request, res: Response) {
    try {
      const userId = req.user!.id;
      const chatId = String(req.params.id || '');
      if (!chatId) return res.status(400).json({ error: 'chatId is required' });
      const { access, exists } = await crossModelService.getChatAccess(chatId, userId);
      if (!chatReadAccessGranted({ userId, access, exists })) {
        return res.status(404).json({ error: 'Chat not found' }); // no existence leak
      }
      const { listUserQueue } = await import('./chat-agent/queue-controls');
      return res.json({ success: true, data: { queue: await listUserQueue(chatId, userId) } });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /api/crossmodel/chats/:id/queue/:pendingId/cancel — drop a queued
   * message before it fires (ticket ea04454c: the owner had only wait-or-stop).
   */
  async cancelChatQueueItem(req: Request, res: Response) {
    return this.applyQueueControl(req, res, (chatId, userId, pendingId) =>
      import('./chat-agent/queue-controls').then((m) => m.cancelQueuedUserMessage(chatId, userId, pendingId)));
  }

  /**
   * POST /api/crossmodel/chats/:id/queue/:pendingId/promote — make it the NEXT
   * turn. Deliberately does NOT stop the live run: the UI pairs it with the
   * existing Stop control so the person chooses whether to interrupt, instead
   * of the server deciding for them.
   */
  async promoteChatQueueItem(req: Request, res: Response) {
    return this.applyQueueControl(req, res, (chatId, userId, pendingId) =>
      import('./chat-agent/queue-controls').then((m) => m.promoteQueuedUserMessage(chatId, userId, pendingId)));
  }

  /** POST /api/crossmodel/chats/:id/queue/:pendingId/move { direction } — one slot up/down (reorder). */
  async moveChatQueueItem(req: Request, res: Response) {
    const direction = req.body?.direction === 'down' ? 'down' : req.body?.direction === 'up' ? 'up' : null;
    if (!direction) return res.status(400).json({ error: "direction must be 'up' or 'down'" });
    return this.applyQueueControl(req, res, (chatId, userId, pendingId) =>
      import('./chat-agent/queue-controls').then((m) => m.moveQueuedUserMessage(chatId, userId, pendingId, direction)));
  }

  /** Shared auth/ownership + refusal→HTTP mapping for the three queue controls. */
  private async applyQueueControl(
    req: Request,
    res: Response,
    run: (chatId: string, userId: string, pendingId: string) => Promise<import('./chat-agent/queue-controls').QueueControlResult>,
  ) {
    try {
      const userId = req.user!.id;
      const chatId = String(req.params.id || '');
      const pendingId = String(req.params.pendingId || '');
      if (!chatId || !pendingId) return res.status(400).json({ error: 'chatId and pendingId are required' });
      const { access, exists } = await crossModelService.getChatAccess(chatId, userId);
      if (!chatReadAccessGranted({ userId, access, exists })) {
        return res.status(404).json({ error: 'Chat not found' }); // no existence leak
      }
      const result = await run(chatId, userId, pendingId);
      if (result.ok) return res.json({ success: true, data: { queue: result.queue } });
      // Honest, distinguishable refusals: the UI names what happened instead of
      // silently dropping the click ("no longer queued" vs "not yours").
      if (result.refusal === 'not_owned' || result.refusal === 'not_a_user_row') {
        return res.status(403).json({
          error: result.refusal === 'not_owned'
            ? 'Only the sender can change that queued message.'
            : 'That queued message came from a machine sender — it cannot be edited from here.',
          code: result.refusal === 'not_owned' ? 'QUEUE_NOT_OWNER' : 'QUEUE_NOT_USER_ROW',
          data: { queue: result.queue },
        });
      }
      if (result.refusal === 'blocked') {
        // Another person is waiting on the row in the way — their place is not
        // ours to move (they cannot see or undo it).
        return res.status(409).json({
          error: 'Someone else is waiting on the message next to that one — its position is theirs to keep.',
          code: 'QUEUE_BLOCKED_BY_OTHER',
          data: { queue: result.queue },
        });
      }
      return res.status(404).json({
        error: 'That message is no longer queued — the list has been refreshed.',
        code: 'QUEUE_ITEM_GONE',
        data: { queue: result.queue },
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  async createChat(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { title, mode } = req.body as CreateChatInput;
      const projectId = req.body.projectId || null;
      const ghostMode = req.body.ghostMode === true;

      // P1: platform.service owns creation (+ authz for project chats) — one
      // implementation shared with the agent platform tools.
      const chat = await platformService.createChat({ userId, title, mode, projectId, ghostMode });

      res.status(201).json({
        success: true,
        data: chat,
        message: 'Chat created successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List chats
   */
  async listChats(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { page, limit, archived } = req.query as unknown as ListChatsQuery;

      // ?archived=true = the Archived browse view; default excludes archived rows.
      const result = await platformService.listChats({ userId, page, limit, ...(archived ? { archived: true } : {}) });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/chats/changes?since=<ISO>&limit=<n> — the sidebar's
   * live delta (ticket d6b2eef5): every chat the caller can see whose
   * updatedAt is at/after `since`, newest first, in the SAME row shape as
   * GET /chats (lineage-completed, running / attention / schedule flags), so a
   * supervisor-spawned session shows up in the open sidebar without a reload
   * and a renamed / re-parented / re-foldered row refreshes in place. The
   * client keeps the newest updatedAt it has seen as the next watermark — no
   * server clock is involved.
   * includeArchived=1 (ticket 6201e0ee): ALSO rows that just got archived (a
   * supervisor lane's archive_chat bumps updatedAt, but the archived row
   * left the DEFAULT list, so the feed could never report it — the sidebar's
   * row lingered until a manual refresh). The client filters what it renders
   * by archivedAt exactly as the live list does; the feed is a superset.
   */
  async listChatChanges(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { since, limit } = req.query as unknown as ListChatChangesQuery;
      // includeArchived: the push-kicked delta must see OTHER lanes' archives
      // (6201e0ee) — own-action archives are already optimistically patched.
      const includeArchived = (req.query as any).includeArchived === '1' || (req.query as any).includeArchived === 'true';
      const result = await platformService.listChats({ userId, page: 1, limit, updatedAfter: new Date(since), ...(includeArchived ? { archivedAny: true } : {}) });
      res.json({ success: true, data: { chats: result.chats, total: result.pagination.total } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/chats/events — per-user SSE stream of chat-list
   * invalidation notices (ticket 6201e0ee). The sidebar keeps this open
   * (EventSource, ?token= auth); each notice is a HINT to re-run the existing
   * /chats/changes delta fetch — it carries no chat data, so authorization
   * and row shape stay in exactly one place (the list path). Emissions fire
   * on the platform.service chat mutations (create/rename/move/archive/
   * restore/session-spawn) from ANY box — the Redis leg crosses boxes behind
   * the ALB.
   */
  async chatEvents(req: Request, res: Response, _next: NextFunction) {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const unsubscribe = subscribeChatEvents(userId, (event) => {
      if (res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify({ type: 'chat-list-changed', data: event })}\n\n`); } catch { /* viewer gone */ }
    });
    const heartbeat = openSSEStream(res);
    // A ready event so the client can tell "connected" from "connecting".
    try { res.write(`data: ${JSON.stringify({ type: 'ready', data: { userId } })}\n\n`); } catch { /* viewer gone */ }
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  /**
   * POST /api/crossmodel/chats/:id/archive — archive a chat (owner-only,
   * matching delete's access level). The chat leaves the default lists/search
   * but still loads by direct id; restore below is the lossless inverse.
   * Refusals (409: run active / enabled schedules) ride next(error).
   */
  async archiveChat(req: Request, res: Response, next: NextFunction) {
    try {
      // The owner's own Archive button (second review fixer 2026-10-21): the cascade keeps its owner-wide semantics.
      const result = await platformService.archiveChat({ userId: req.user!.id, chatId: req.params.id, archived: true, ownerAction: true });
      res.json({ success: true, data: result, message: 'Chat archived' });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/crossmodel/chats/:id/restore — clear the archive stamp (owner-only). */
  async restoreChat(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await platformService.archiveChat({ userId: req.user!.id, chatId: req.params.id, archived: false });
      res.json({ success: true, data: result, message: 'Chat restored' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/chats/search?q=... — deep search across ALL the
   * caller's own chats, by chat title AND message content (case-insensitive).
   * Returns ranked, capped results for the sidebar search box. Inline-validated
   * (the same idiom as listChatSchedules): an empty / too-short query returns an
   * empty result set rather than 400 — the box calls this on every keystroke, so
   * a blank/1-char box must never error. Scoped to req.user.id in the service.
   */
  async searchChats(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const q = String(req.query.q ?? '').trim();
      // <2 chars: not worth a full-table substring scan; return empty quietly.
      if (q.length < 2) {
        return res.json({ success: true, data: { results: [], query: q } });
      }
      const bounded = q.slice(0, 200); // guard against pathological long inputs
      const { results } = await crossModelService.searchChatsAndMessages(userId, bounded);
      return res.json({ success: true, data: { results, query: bounded } });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * GET /api/crossmodel/chats/:id/schedules — the chat's schedule rows (both
   * enabled and terminal), powering the session panel's Schedules section for
   * ANY chat (coding or plain). Same access rule as streamChatRun (owner or
   * project member, read level — 404 without existence leak), via the cheap
   * getChatAccess lookup rather than getChatById (a poll endpoint must not
   * load the whole transcript).
   */
  async listChatSchedules(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const chatId = String(req.params.id || '');
      if (!chatId) return res.status(400).json({ error: 'chat id is required' });
      const { access, exists } = await crossModelService.getChatAccess(chatId, userId);
      if (!exists || access === 'none') return res.status(404).json({ error: 'Chat not found' });
      // Dynamic import: schedule.service pulls config/redis — the same lazy
      // boundary the other coding-module touches in this controller use.
      const { listSchedules } = await import('./coding/schedule.service');
      return res.json({ success: true, data: { schedules: await listSchedules(chatId) } });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * DELETE /api/crossmodel/chats/:id/schedules/:scheduleId — cancel (disable)
   * one schedule on this chat, NO confirmation round-trip (owner directive
   * 2026-09-02: "you need to be able to delete or cancel them without
   * asking" — the UI offers a short Undo instead). Owner-only: unlike the
   * read-level GET above, stopping a cadence acts AS the chat (schedules fire
   * with the owner's identity). The exact cancel_schedule tool semantics —
   * lastStatus 'cancelled', schedule_disabled hook event (supervisor-audible),
   * 'schedule.cancel' Activity audit — live in platformService.cancelChatSchedule;
   * the response carries the deaf-lane warning when the chat is left with no
   * enabled schedules.
   */
  async cancelChatSchedule(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id, scheduleId } = req.params as { id: string; scheduleId: string };
      const result = await platformService.cancelChatSchedule({ userId, chatId: id, scheduleId });
      return res.json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * PATCH /api/crossmodel/chats/:id/schedules/:scheduleId {enabled} — pause
   * (false) / resume (true) one schedule on this chat. Owner-only, same gate
   * as the cancel above. Resume recomputes a stale nextRunAt (never an
   * immediate catch-up fire), re-checks the active-schedule cap, and refuses
   * completed schedules (409 with the honest reason); it also serves as the
   * Undo for a just-cancelled row (cancel persists as enabled:false — nothing
   * is destroyed). See platformService.setChatScheduleEnabled.
   */
  async updateChatSchedule(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id, scheduleId } = req.params as { id: string; scheduleId: string };
      const { enabled } = req.body as { enabled: boolean };
      const result = await platformService.setChatScheduleEnabled({ userId, chatId: id, scheduleId, enabled });
      return res.json({ success: true, data: result });
    } catch (error) {
      return next(error);
    }
  }

  /**
   * Get chat by ID
   */
  async getChat(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id } = req.params as GetChatParams;
      // Opt-in transcript paging (validated + coerced by getChatSchema; the
      // validate middleware writes parsed values back onto req.query).
      const { messageLimit, messagesBefore } = req.query as unknown as GetChatQuery;

      const chat = await crossModelService.getChatById(id, userId, 'read', { messageLimit, messagesBefore });
      // P5-B: the FE branches on the coding CAPABILITY (CodeSessionView vs
      // chat view) — expose it on the DTO (single chat → direct lookup).
      const { getChatCapability } = await import('./coding/coding-data.service');
      const cap = await getChatCapability(chat).catch(() => null);

      // Minimal view (2026-10-16, view/minimal-view.ts): machinery never leaves the server for this viewer.
      const viewChat: any = (await resolveViewModeForRequest(req as any)) === 'minimal' ? minimalChatDto(chat) : chat;

      res.json({
        success: true,
        data: {
          ...viewChat,
          codeCapable: cap?.codeCapable ?? false,
          hasWorkspaceState: cap?.hasWorkspaceState ?? false,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update chat (rename; move between projects via projectId)
   */
  async updateChat(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id } = req.params as UpdateChatParams;
      const data = req.body as UpdateChatInput;

      // P1: rename → platform.service.renameChat; move (projectId present) →
      // platform.service.moveChat; a bare mode change keeps the legacy path.
      // All three share the one authz implementation with the platform tools.
      let chat;
      // Fields the rename / move paths do not carry (2026-10-04 — a {title, leadModel} PUT used to apply the rename
      // and silently drop the lead pick; a move dropped standing instructions the same way).
      const rest = {
        ...(data.leadModel !== undefined ? { leadModel: data.leadModel } : {}),
        ...(data.systemPrompt !== undefined ? { systemPrompt: data.systemPrompt } : {}),
        // Ghost mode (owner 2026-10-22): flips with a rename / move the same
        // way — the posture must survive a re-file into a folder.
        ...(data.ghostMode !== undefined ? { ghostMode: data.ghostMode } : {}),
      };
      if (data.projectId !== undefined) {
        chat = await platformService.moveChat({ userId, chatId: id, projectId: data.projectId ?? null });
        // A mode change may ride along with a move — apply it through the same path.
        if (data.mode !== undefined || data.title !== undefined || Object.keys(rest).length) {
          chat = await crossModelService.updateChat(id, userId, { ...(data.title !== undefined ? { title: data.title } : {}), ...(data.mode !== undefined ? { mode: data.mode } : {}), ...rest });
        }
      } else if (data.title !== undefined && data.mode === undefined) {
        chat = await platformService.renameChat({ userId, chatId: id, title: data.title });
        if (Object.keys(rest).length) chat = await crossModelService.updateChat(id, userId, rest);
      } else {
        chat = await crossModelService.updateChat(id, userId, data);
      }

      res.json({
        success: true,
        data: chat,
        message: 'Chat updated successfully',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Convert a plain chat to a coding session in place: attach the workspace
   * satellite (id == chat id); optionally move the chat into a target folder
   * first. Idempotent — re-converting returns the existing session.
   * Errors ride next(error) — the global errorHandler maps AppError (this
   * file's convention; a direct AppError import here would drag env.ts into
   * suites that mock the service graph).
   */
  async convertChatToCoding(req: Request, res: Response, next: NextFunction) {
    try {
      const session = await platformService.convertChatToCoding({
        userId: req.user!.id,
        chatId: req.params.id,
        projectId: req.body?.projectId,
      });
      res.json({ success: true, data: session });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete chat
   */
  async deleteChat(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id } = req.params as DeleteChatParams;

      const result = await platformService.deleteChat({ userId, chatId: id });

      res.json({
        success: true,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  }

  // ── Profile Chat ───────────────────────────────────────────────────────────

  /**
   * GET /api/crossmodel/profile/stream?message=...&history=...&token=...
   *
   * SSE endpoint — Digby conducts a friendly profile interview.
   * Streams Digby's response, parses [MEMORY:key=value] tags inline,
   * saves extracted facts to UserMemory, strips tags before displaying.
   */
  async profileStream(req: Request, res: Response, next: NextFunction) {
    try {
      // Profile stream requires authentication (SSE uses ?token= since EventSource can't set headers)
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required. Please log in to use the profile feature.' });
        return;
      }
      const userId = req.user.id;
      const message = (req.query.message as string) || '';
      const historyRaw = req.query.history as string | undefined;
      // mode=continuation → Digby knows the user and helps update their profile
      // mode=setup (default) → Digby runs the full profile interview
      const profileMode = (req.query.mode as string) === 'continuation' ? 'continuation' : 'setup';

      let conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [];
      if (historyRaw) {
        try {
          conversationHistory = JSON.parse(decodeURIComponent(historyRaw));
        } catch { /* use empty history */ }
      }

      // Always load existing facts — needed for continuation mode, also useful for setup
      // (Digby can skip questions whose answers are already known)
      let existingFacts: Record<string, string> = {};
      try {
        existingFacts = await contextService.getUserMemory(userId);
      } catch { /* non-critical */ }

      // SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/proxy buffering
      res.flushHeaders();

      const sendEvent = (type: string, data: any) => {
        res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
      };

      let fullResponse = '';

      if (profileMode === 'continuation') {
        // Continuation: Digby knows the user, casual update conversation
        for await (const chunk of moonshotIntegration.profileStreamContinuation(
          message, existingFacts, conversationHistory
        )) {
          fullResponse += chunk;
          sendEvent('chunk', { content: chunk });
        }
      } else {
        // Setup: full profile interview
        for await (const chunk of moonshotIntegration.profileStream(message, conversationHistory)) {
          fullResponse += chunk;
          sendEvent('chunk', { content: chunk });
        }
      }

      // Parse [MEMORY:key=value] tags from complete response
      const newFacts: Record<string, string> = {};
      const memoryRegex = /\[MEMORY:([^=\]]+)=([^\]]+)\]/g;
      let match: RegExpExecArray | null;
      while ((match = memoryRegex.exec(fullResponse)) !== null) {
        const key = match[1].trim().toLowerCase().replace(/\s+/g, '_');
        const value = match[2].trim();
        newFacts[key] = value;
      }

      // Save extracted facts to UserMemory
      for (const [key, value] of Object.entries(newFacts)) {
        await contextService.updateMemoryFact(userId, key, value);
      }

      // After saving profile facts, trigger LangGraph context update so the
      // user's persona, tech_level, and response_style are reflected in all
      // future chat responses immediately (fire-and-forget).
      if (Object.keys(newFacts).length > 0) {
        const factSummary = Object.entries(newFacts).map(([k, v]) => `${k}: ${v}`).join(', ');
        updateContextAsync({
          userId,
          projectId: null,
          chatId: null,  // profile stream is not chat-specific
          userMessage: `[Profile update] ${factSummary}`,
          synthesis: fullResponse.replace(/\[MEMORY:[^\]]+\]/g, '').replace(/\[PROFILE_COMPLETE\]/g, '').trim(),
        });
      }

      const isComplete = fullResponse.includes('[PROFILE_COMPLETE]');

      // Clean response (strip all special tags)
      const cleanResponse = fullResponse
        .replace(/\[MEMORY:[^\]]+\]/g, '')
        .replace(/\[PROFILE_COMPLETE\]/g, '')
        .trim();

      logger.info(`profileStream: userId=${userId}, mode=${profileMode}, extracted ${Object.keys(newFacts).length} facts, complete=${isComplete}`);

      sendEvent('complete', {
        message: cleanResponse,
        factsExtracted: newFacts,
        profileComplete: isComplete,
      });

      res.end();
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/crossmodel/memory/consolidate
   *
   * Digby reviews all existing memory facts + recent chat titles and
   * returns an improved consolidated profile. This is the "scheduled
   * ingestion" — triggered on demand from the profile page.
   */
  async consolidateMemory(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;

      // Get current memory facts
      const currentFacts = await contextService.getUserMemory(userId);

      // Get recent chat titles for context
      const recentResult = await crossModelService.listChats(userId, 1, 10);
      const recentTitles: string[] = recentResult.chats.map((c: any) => c.title);

      if (Object.keys(currentFacts).length === 0 && recentTitles.length === 0) {
        return res.json({
          success: true,
          data: { facts: {}, consolidated: 0 },
          message: 'No data to consolidate yet — start chatting to build your profile!',
        });
      }

      logger.info(`consolidateMemory: userId=${userId}, ${Object.keys(currentFacts).length} existing facts, ${recentTitles.length} chats`);

      // Ask Digby to consolidate
      const consolidatedFacts = await moonshotIntegration.consolidateMemory(currentFacts, recentTitles);

      // Save consolidated facts
      for (const [key, value] of Object.entries(consolidatedFacts)) {
        await contextService.updateMemoryFact(userId, key.toLowerCase().replace(/\s+/g, '_'), String(value));
      }

      const updatedFacts = await contextService.getUserMemory(userId);

      res.json({
        success: true,
        data: {
          facts: updatedFacts,
          consolidated: Object.keys(consolidatedFacts).length,
        },
        message: `Profile consolidated — ${Object.keys(consolidatedFacts).length} facts updated`,
      });
    } catch (error) {
      next(error);
    }
  }

  // ── Memory Management ──────────────────────────────────────────────────────

  /**
   * GET /api/crossmodel/memory
   * Returns the current user's memory facts.
   */
  async getMemory(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      // `meta` (2026-10-20, additive): key → { since, source, sourceChatId } from the fact's
      // current version (memory/fact-versions.ts). {} when FACT_VERSIONS_DISABLED=1 or unknown.
      const { getFactMeta } = await import('./memory/fact-versions');
      const [facts, allMeta] = await Promise.all([contextService.getUserMemory(userId), getFactMeta(userId)]);
      const meta = Object.fromEntries(Object.entries(allMeta).filter(([k]) => Object.prototype.hasOwnProperty.call(facts, k)));
      res.json({ success: true, data: { facts, meta } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/crossmodel/memory/rebuild — rebuild the caller's personal memory
   * from THEIR OWN past conversations (2026-09-15 memory-wipe recovery). One
   * job per user at a time; returns immediately, poll GET /memory/rebuild.
   * Scoped to req.user — never another user's chats.
   */
  async rebuildMemory(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { startUserMemoryRebuild } = await import('./langgraph/memory.graph');
      const r = await startUserMemoryRebuild(userId);
      if (!r.started) {
        return res.status(r.reason === 'already_running' ? 409 : 200).json({
          success: r.reason !== 'already_running',
          data: { started: false, reason: r.reason, total: 0 },
          message: r.reason === 'already_running'
            ? 'A rebuild is already running — it finishes within a few minutes.'
            : 'No past conversations to rebuild from yet — start chatting and Digby will build your memory as you go.',
        });
      }
      res.json({ success: true, data: { started: true, total: r.total }, message: `Rebuilding your memory from ${r.total} past exchange(s) — this runs in the background.` });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/crossmodel/memory/rebuild — the caller's rebuild status + current fact count. */
  async rebuildMemoryStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { getUserMemoryRebuildStatus } = await import('./langgraph/memory.graph');
      res.json({ success: true, data: await getUserMemoryRebuildStatus(userId) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/crossmodel/memory
   * Upsert a single fact. Body: { key: string, value: string }
   */
  async updateMemoryFact(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { key, value } = req.body as { key: string; value: string };
      // The user typing a fact into the Memory tab is an explicit remember — it lifts an older
      // "forget this topic" ban on the same fact (ticket ccd634fb).
      await contextService.updateMemoryFact(userId, key, value, 'api', { liftRejections: true });
      res.json({ success: true, message: `Fact "${key}" saved` });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/crossmodel/memory
   * - If ?key=xxx is provided: delete that single fact
   * - Otherwise: clear all memory
   */
  async deleteMemory(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const key = typeof req.query.key === 'string' ? req.query.key : undefined;

      if (key) {
        await contextService.deleteMemoryFact(userId, key);
        res.json({ success: true, message: `Fact "${key}" deleted` });
      } else {
        await contextService.clearUserMemory(userId);
        res.json({ success: true, message: 'All memory cleared' });
      }
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/crossmodel/stream/register
   *
   * Pre-registration endpoint for large messages that would exceed GET URL limits.
   * Stores query params in-memory for 10 minutes and returns a streamToken UUID.
   * The frontend then connects via GET /stream?streamToken=xxx (tiny URL).
   */
  async registerStreamQuery(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const { message, chatId, mode, webSearch, uploadId, modeSource, escalationOf, sessionId: bodySessionId, ghost: bodyGhost } = req.body as {
        message: string;
        chatId?: string;
        mode?: string;
        webSearch?: string;
        uploadId?: string | string[];
        modeSource?: string;
        escalationOf?: string;
        sessionId?: string;
        ghost?: boolean | string;
      };

      const uploadIds: string[] = sanitizeUploadIds(uploadId);

      // 2026-06-25: Normalize the literal strings "undefined"/"null" to empty. A failed
      // frontend template literal (e.g. `${someVar}` where someVar is undefined) sends the
      // STRING "undefined" as the message — which is truthy and slips past the !message?.trim()
      // guard, surfacing as an "undefined" chat title / user bubble in production. The GET
      // /stream path already guards this (line ~703); mirror it here at the register boundary
      // so a malformed body is rejected (or, with an upload, treated as an empty prompt).
      // 2026-06-30: Added "[object Object]" — a caller that String()-ifies an object
      // before sending (failed `${obj}` interpolation) lands a literal "[object Object]"
      // here, the object-shaped sibling of the "undefined"/"null" stringification bug.
      const sanitizedMessage =
        typeof message === 'string' && /^(undefined|null|\[object Object\])$/i.test(message.trim()) ? '' : message;
      if (!sanitizedMessage?.trim() && uploadIds.length === 0) {
        return res.status(400).json({ error: 'message or attachment is required' });
      }

      // Per-identity pending cap (userId for authed, IP for anon) — Redis
      // counter shared across both web instances, released on consume.
      // 2026-06-17: Use getClientIp() helper (DRY — previously duplicated inline)
      const clientIp = getClientIp(req);
      const identity = registrationIdentity(userId, clientIp);
      if (!(await reserveRegistrationSlot(identity))) {
        logger.warn(`Stream registration per-identity limit hit: ${userId ? `userId=${userId}` : `ip=${maskIp(clientIp)}`}`);
        return res.status(429).json({ error: 'Too many pending requests. Please wait before sending more.' });
      }

      const streamToken = randomUUID();

      const registration: StreamQueryRegistration = {
        message: sanitizedMessage,
        chatId: chatId || undefined,
        // P4 normalizePatienceMode: retired FAST tiers (`single`/`fast`) →
        // `single_thinking`; retired L4 `deep_research_all` → `deep_research`.
        // 'auto' passes through (resolved per-message by the router in streamQuery)
        // and is the DEFAULT for an omitted mode (owner 2026-09-26).
        mode: normalizePatienceMode(mode || AUTO_MODE),
        webSearch: String(webSearch ?? 'true') !== 'false', // store as boolean
        uploadIds,
        userId,
        clientIp: userId ? undefined : clientIp, // only store IP for anonymous users
        // Ghost mode (owner 2026-10-22): the per-send ghost opt-in rides the
        // token exactly like the guest session key (the >1500-char long-message
        // path must not silently drop the toggle).
        ...(bodyGhost === true || bodyGhost === 'true' ? { ghost: true } : {}),
        ...(normalizeModeSource(modeSource) ? { modeSource: normalizeModeSource(modeSource) } : {}),
        // Dig deeper (compute policy): a well-formed message id rides the token;
        // the stream consumer validates ownership + the rung.
        ...(typeof escalationOf === 'string' && GUEST_SESSION_ID_RE.test(escalationOf) ? { escalationOf } : {}),
        // Guest sessions (audit 2026-09-26 guest-persistence-1): a >1500-char
        // guest message used to lose its NAMED session key here and run on the
        // cookie's (= the LAST session streamed in that browser) — a silent
        // same-browser context bleed + a reload that could not find the turn.
        ...(!userId && typeof bodySessionId === 'string' && GUEST_SESSION_ID_RE.test(bodySessionId) ? { sessionId: bodySessionId } : {}),
      };
      try {
        await storeRegistration(streamToken, registration);
      } catch (redisErr) {
        // Fail CLOSED: a token we could not store must not be handed out. Short
        // messages (direct GET /stream) keep working through a Redis outage.
        await releaseRegistrationSlot(identity);
        logger.error('registerStreamQuery: Redis store failed', redisErr);
        return res.status(503).json({ error: 'Server is busy. Please try again in a moment.' });
      }

      logger.info(`registerStreamQuery: token=${streamToken}, msgLen=${message?.length ?? 0}, uploads=${uploadIds.length}, userId=${userId || 'anon'}`);
      res.json({ streamToken });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Stream query with Server-Sent Events
   *
   * Thin HTTP layer that delegates to the LangGraph Query Pipeline.
   * Handles: param resolution, SSE setup/teardown, fire-and-forget persistence.
   * The pipeline graph handles: context → models → synthesis → post-processing.
   */
  async streamQuery(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      // Minimal view (2026-10-16, view/minimal-sse.ts): every frame this send writes is filtered for its viewer.
      res = wrapSseResponse(res, await resolveViewModeForRequest(req as any));

      // ── Resolve params — from query string OR pre-registered cache ────────
      let message: string;
      let chatId: string | undefined;
      let mode: 'single' | 'single_thinking' | 'fast' | 'thinking' | 'deep_research' | 'deep_research_all' | 'browser_agent' | 'auto';
      let uploadIds: string[];
      // Patience plan 1a label window: the client's account of how the level
      // was chosen ('picked' | 'default' | 'restored'); undefined = no signal.
      let modeSource: ReturnType<typeof normalizeModeSource>;
      // Compute policy Dig deeper (2026-09-26): the assistant message this send
      // escalates (validated uuid; ownership + rung resolved below).
      let escalationOf: string | undefined;
      // Guest sessions: the named session key a registration carried (token path).
      let registeredSessionId: string | undefined;
      // Ghost mode (owner 2026-10-22): the per-send ghost opt-in (GUESTS have no
      // chat row — this is their toggle). For an AUTHED chat the row's stored
      // flag wins; a per-send `ghost=true` from a signed-in user is honoured for
      // an ephemeral/legacy (chatId-less) send, ignored when a chat row exists
      // and is not ghost (the stored posture governs).
      let ghostSend = false;

      const streamToken = req.query.streamToken as string | undefined;
      if (streamToken) {
        // Atomic single-use consume from Redis — works regardless of which web
        // instance served the register POST (TTL expiry is Redis-enforced).
        const cached = await consumeRegistration(streamToken);
        if (!cached) {
          res.status(410).json({ error: 'Stream query expired or not found. Please resend your message.' });
          return;
        }
        // Free the registrant's pending-cap slot now that the token is consumed.
        await releaseRegistrationSlot(registrationIdentity(cached.userId, cached.clientIp || ''));
        // Ownership check: if the token was registered by a specific user, only that
        // user can consume it. This prevents cross-user token theft even if the UUID
        // were guessable. Previously this check was `if (userId && cached.userId && ...)`
        // which allowed an unauthenticated requester to consume an authenticated user's token.
        if (cached.userId && cached.userId !== userId) {
          logger.warn(`Stream token userId mismatch: token owner=${cached.userId}, requester=${userId || 'anon'}`);
          res.status(403).json({ error: 'Stream token does not belong to this user.' });
          return;
        }
        // 2026-06-11: For anonymous tokens, verify the requester's IP matches the IP that
        // registered the token. This prevents an authenticated user (or different anonymous
        // user) from consuming another anonymous user's stream token if they know the UUID.
        // While UUIDs are cryptographically random and unguessable, defense-in-depth.
        if (!cached.userId && cached.clientIp) {
          // 2026-06-17: Use getClientIp() helper (DRY — previously duplicated inline)
          // 2026-06-26: Compare network PREFIX (sameIpSession), not an exact match.
          // Mobile/CGNAT clients often rotate their last octet between /register and
          // /stream within the 3-min TTL, which caused false 403s. The token is a
          // single-use random UUID, so prefix-level defense-in-depth is sufficient.
          const requesterIp = getClientIp(req);
          if (!sameIpSession(requesterIp, cached.clientIp)) {
            // 2026-06-28: Mask both IPs to their network prefix — full user IPs in the
            // app log (→ AppErrorLog) carry no diagnostic value beyond the /24-/64 the
            // check already compares, and logging them raw has privacy implications.
            logger.warn(`Stream token IP mismatch: token ip=${maskIp(cached.clientIp)}, requester ip=${maskIp(requesterIp)}`);
            res.status(403).json({ error: 'Stream token does not belong to this session.' });
            return;
          }
        }
        message = cached.message;
        chatId = cached.chatId;
        // Legacy single-model FAST tier (`single`) and the deprecated 3-models-fast
        // pipeline (`fast`) were both retired (2026-06) → `single_thinking`; the L4
        // all-models tier (`deep_research_all`) was retired in P4 → `deep_research`.
        // Both aliases live in normalizePatienceMode (registration time already
        // applied it; this belt-and-suspenders covers pre-P4 cached entries).
        // `browser_agent` and `auto` pass through untouched. Any unrecognized
        // value collapses to `single_thinking`.
        const cachedMode = normalizePatienceMode(cached.mode);
        mode = (
          cachedMode === 'auto'          ? 'auto' :
          cachedMode === 'deep_research' ? 'deep_research' :
          cachedMode === 'thinking'      ? 'thinking' :
          cachedMode === 'browser_agent' ? 'browser_agent' : // open-source web-automation mode (preserve)
          'single_thinking'   // covers 'single_thinking', legacy 'single'/'fast', unknown values
        ) as 'single' | 'single_thinking' | 'fast' | 'thinking' | 'deep_research' | 'deep_research_all' | 'browser_agent' | 'auto';
        // cached.webSearch is stored for wire compatibility only — inert since
        // the 2026-09-03 search-force removal (web tools are always available).
        uploadIds = cached.uploadIds;
        modeSource = normalizeModeSource(cached.modeSource);
        escalationOf = typeof cached.escalationOf === 'string' && GUEST_SESSION_ID_RE.test(cached.escalationOf) ? cached.escalationOf : undefined;
        registeredSessionId = !cached.userId && typeof cached.sessionId === 'string' && GUEST_SESSION_ID_RE.test(cached.sessionId) ? cached.sessionId : undefined;
        ghostSend = cached.ghost === true;
        logger.info(`streamQuery via token: msgLen=${message.length}, userId=${userId || 'anon'}`);
      } else {
        const params = req.query as unknown as StreamQueryParams;
        message = params.message;
        chatId = params.chatId;
        // P4 normalizePatienceMode: retired FAST tiers (`single`/`fast`) →
        // `single_thinking`; retired L4 `deep_research_all` → `deep_research`.
        // `browser_agent` and `auto` pass through untouched; an omitted mode
        // is Auto (owner 2026-09-26 — the zod default says the same).
        mode = normalizePatienceMode(params.mode || AUTO_MODE);
        // params.webSearch is accepted for wire compatibility only — inert since
        // the 2026-09-03 search-force removal (web tools are always available).
        const rawIds = req.query.uploadId;
        uploadIds = sanitizeUploadIds(rawIds);
        modeSource = normalizeModeSource((req.query as Record<string, unknown>).modeSource);
        escalationOf = typeof params.escalationOf === 'string' && GUEST_SESSION_ID_RE.test(params.escalationOf) ? params.escalationOf : undefined;
        // Ghost mode per-send opt-in (zod already coerced 'true'/'false').
        ghostSend = params.ghost === true;
      }

      // ── Digby Kids lookup HOISTED above routing (patience plan 1a §3.5) ──
      // The child branch below detects the child from the DB (not only the
      // token). Read it ONCE up here so the Auto router, the always-Auto
      // switch and the label window can all skip kids (zero decision_gate
      // rows for a kid session) and the coding satellite gate sees the DB
      // truth too. A read failure propagates (fail closed: no adult pipeline).
      const childRow = userId
        ? await prisma.user.findUnique({ where: { id: userId }, select: { isChild: true, childAge: true, childGuardrails: true } })
        : null;
      const isChild = !!childRow?.isChild;

      // ── Session ID for anonymous users (hoisted 2026-09-26 — the cookie must
      // be set BEFORE the early header flush below) ────────────────────────
      let sessionId: string | undefined;
      if (!userId) {
        // Guest sessions (ticket 63bb607f): an anonymous client may NAME its
        // own context key with an explicit ?sessionId=<uuid>. An unguessable
        // UUID keys an ephemeral 24h Redis context — naming it is equivalent
        // to the random-UUID context any anonymous client already gets; no
        // auth surface change (authed users IGNORE the param entirely — the
        // branch below never runs for them).
        const requested = typeof req.query.sessionId === 'string' && GUEST_SESSION_ID_RE.test(req.query.sessionId)
          ? req.query.sessionId
          : undefined;
        sessionId = requested || registeredSessionId || req.cookies?.[SESSION_COOKIE] || randomUUID();
      }

      // ── SSE setup — IDEMPOTENT (compute policy step 0, 2026-09-26) ────────
      // Headers flush BEFORE the router / plan await (design §5 step 0: the
      // old order — `res.flushHeaders()` after `routeMessageAuto` — put the
      // gate's round-trip in front of the first byte). The Dig-deeper refusal
      // (which answers before the early flush) goes through this same helper,
      // so nothing double-sets headers.
      let headersFlushed = false;
      let clientDisconnected = false;
      const streamOpenedAt = Date.now();
      req.on('close', () => { clientDisconnected = true; });
      // SSE keepalive — prevents nginx proxy_read_timeout / the ALB's 60 s idle
      // timeout during long operations. Stream drops (2026-10-20): it starts AT
      // the header flush (flushSse below), so the routing / plan / research-
      // routing awaits are covered too; SSE_EARLY_HEARTBEAT_DISABLED=1 starts it
      // after those awaits again (the pre-fix spot). startKeepalive is
      // idempotent — one timer per request whichever site starts it.
      let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
      const startKeepalive = () => {
        if (keepaliveTimer) return;
        keepaliveTimer = setInterval(() => {
          if (clientDisconnected || res.writableEnded) {
            clearInterval(keepaliveTimer);
            return;
          }
          try { res.write(': heartbeat\n\n'); } catch { /* client gone */ }
        }, 20000);
        // A keepalive must never HOLD the event loop: under mocked-res test
        // harnesses res.writableEnded never flips and req 'close' never fires,
        // so a ref'd interval hangs jest's exit (auto-verify test:related).
        // In prod the open socket itself keeps the process alive. Same idiom
        // as loop-metrics.service.ts's flush timer.
        keepaliveTimer.unref();
      };
      const flushSse = () => {
        if (headersFlushed) return;
        headersFlushed = true;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/proxy buffering
        if (sessionId) {
          res.cookie(SESSION_COOKIE, sessionId, {
            maxAge: SESSION_COOKIE_MAX_AGE,
            httpOnly: true,
            sameSite: 'lax',
          });
        }
        res.flushHeaders();
        if (!sseEarlyHeartbeatDisabled()) startKeepalive();
      };
      const sendEvent = (type: string, data: any) => {
        if (!res.writableEnded && !clientDisconnected) {
          try {
            res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
          } catch { /* client gone — ignore write errors */ }
        }
      };

      // ── Compute policy DIG DEEPER (2026-09-26, design §4/§5 step 2) ──────
      // escalationOf names a persisted ASSISTANT row of this chat; the server
      // runs the NEXT rung not yet spent on it (verify → research) with the
      // ORIGINAL question, never a new user turn. Guests get the sign-in
      // affordance, kids/supervisor chats never escalate, DIG_DEEPER_DISABLED=1
      // and an exhausted / over-budget message refuse with a plain SSE error.
      let escalation: { ofMessageId: string; rung: NextRung } | null = null;
      if (escalationOf) {
        const refuseEscalation = (msg: string, code: string) => {
          flushSse();
          sendEvent('error', { message: msg, code });
          if (!res.writableEnded) res.end();
        };
        if (digDeeperDisabled()) { refuseEscalation('Dig deeper is switched off on this instance right now.', 'DIG_DEEPER_DISABLED'); return; }
        if (!userId || isChild) { refuseEscalation('Sign in for a deeper look — Dig deeper needs a free account.', 'SIGNIN_DEEPER'); return; }
        if (!chatId) { refuseEscalation('Dig deeper needs the chat the answer lives in.', 'ESCALATION_NO_CHAT'); return; }
        // Access FIRST (audit 2026-10-03): the tap used to read the answer row,
        // the original question and WRITE compute_policy / revision_material /
        // drafts_agree labels before the H1 write check further down — any
        // signed-in user holding a chatId + messageId could label another
        // user's decision. Same posture as H1 (non-leaking "not found").
        {
          const { access, exists } = await crossModelService.getChatAccess(chatId, userId).catch(() => ({ access: 'none' as const, exists: false }));
          if (!chatWriteAccessGranted({ userId, access, exists })) { refuseEscalation('That answer was not found in this chat.', 'ESCALATION_NOT_FOUND'); return; }
          // Supervisor chats never carry the chip (depthChipFor is disabled there) and
          // the run-level supervisor clamp does not apply to an escalation's preset —
          // a hand-built tap would have run the council lead on a supervisor chat.
          const escChat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { isSupervisor: true, isProjectSupervisor: true } }).catch(() => null);
          if (escChat?.isSupervisor || escChat?.isProjectSupervisor) { refuseEscalation('Dig deeper is not available in supervisor chats.', 'ESCALATION_SUPERVISOR'); return; }
        }
        const row = await prisma.crossModelMessage
          .findUnique({ where: { id: escalationOf }, select: { id: true, chatId: true, role: true, metadata: true, createdAt: true } })
          .catch(() => null);
        if (!row || row.chatId !== chatId || row.role !== 'assistant') { refuseEscalation('That answer was not found in this chat.', 'ESCALATION_NOT_FOUND'); return; }
        const rung = nextRungForMessage(row.metadata);
        if (!rung) { refuseEscalation('This answer has already had the deepest look available.', 'ESCALATION_EXHAUSTED'); return; }
        const escMeta = (row.metadata && typeof row.metadata === 'object') ? row.metadata as Record<string, any> : {};
        // Owner directive 2026-09-27 ("no cost caps anywhere in the framework
        // unless set by a user at the project settings level"): the per-message
        // USD refusal (`DEPTH_BUDGET_EXCEEDED` against `budget.maxUsd`, default
        // $0.25) is GONE — a Dig-deeper tap is never refused on cost. The
        // message's cumulative spend (`messageSpentUsd`) stays a RECORD on the
        // row for readouts; nothing gates on it.
        // A research rung is a council: refuse on an exhausted daily allowance
        // BEFORE the label is written / the mode is rewritten (audit 2026-09-26
        // routing-unify-2 — the tap used to die at the reserve with the generic
        // RATE_LIMIT_DEEP_RESEARCH after the chip promised ~20 minutes).
        if (rung === 'research') {
          const allowance = await deepResearchAllowance({ userId, strict: true }).catch(() => ({ allowed: false, reasonKey: 'quota_unavailable' as const, remaining: 0, limit: 0 }));
          if (!allowance.allowed) {
            const left = typeof allowance.remaining === 'number' ? allowance.remaining : 0;
            refuseEscalation(allowance.reasonKey === 'quota_unavailable'
              ? 'The deeper look could not be started right now (quota service unavailable) — try again in a minute.'
              : `No deeper looks left today (${left} of ${allowance.limit ?? '?'} remaining) — resets at midnight UTC.`, 'ESCALATION_QUOTA');
            return;
          }
        }
        // The ORIGINAL question: the user row right before the escalated answer.
        const question = await prisma.crossModelMessage
          .findFirst({ where: { chatId, role: 'user', createdAt: { lte: row.createdAt } }, orderBy: { createdAt: 'desc' }, select: { content: true } })
          .catch(() => null);
        const original = String(question?.content ?? '').trim();
        if (!original) { refuseEscalation('The question behind that answer could not be found.', 'ESCALATION_NO_QUESTION'); return; }
        message = original;
        uploadIds = [];
        // The ONE escalation resolver (compute-policy-wiring escalationPlan — the
        // gate's duplicate was deleted 2026-09-26): the rung's preset IS the mode.
        mode = escalationPlan(rung, 0).preset;
        escalation = { ofMessageId: row.id, rung };
        // The tap IS the label (design §4 D2: `escalated`, primary; ≤ 30 min window;
        // cp/labels: a later tap writes the SECONDARY `escalated_late` row instead of
        // nothing, and a tap on an 'updated' row — or a 'checked' row whose gate
        // withheld the rewrite in act (acted:true; audit 2026-09-26) — also labels
        // revision_material).
        labelComputePolicyEscalated({ decisionStash: escMeta.depth?.decision, messageCreatedAt: row.createdAt, rung, sessionId: chatId, facts: factsFromDepthMetadata(escMeta) });
        labelRevisionMaterialFromMetadata(escMeta, 'escalated', chatId);
        // drafts_agree (2026-09-26): a tap on an answer whose reconcile was SKIPPED (acted) says the skip mattered — acted:true, actual false.
        labelDraftsAgreeFromMetadata(escMeta, 'escalated', chatId);
        // Dynamic roster (2026-10-03): the tap says the turn needed the NEXT lane up (turn_plan primary label).
        void import('./chat-agent/turn-plan-labels').then(m => m.labelTurnPlan(escMeta, 'tap', { sessionId: chatId, messageCreatedAt: row.createdAt })).catch(() => {});
        logger.info(`dig deeper: userId=${userId} chat=${chatId.slice(0, 8)} message=${row.id.slice(0, 8)} rung=${rung}`);
      }

      // ── First-party visitor analytics (owner 2026-10-07): the AUTHORITATIVE chat_sent (+ the derived first_chat)
      // or dig_deeper for this human send — the web capture may be blocked. A guest turn bills run_spend to
      // `anon-<session>` (chat-agent runSessionId); it rides as spendSessionId so the guest's API cost lands on the
      // visitor (visitors/visitor-analytics.service.ts). Digby Kids never (isChild = the DB truth read above).
      // Fire-and-forget: never awaited, never throws. VISITOR_ANALYTICS_DISABLED=1 records nothing.
      if (!isChild && !(req.user as any)?.isChild) {
        void import('./visitors/visitor.service').then((m) => m.recordServerVisitEvent({
          type: escalation ? 'dig_deeper' : 'chat_sent',
          userId: userId ?? null,
          isChild: false,
          req,
          path: '/crossmodel',
          spendSessionId: !userId && !chatId && sessionId ? `anon-${sessionId}` : null,
          props: { surface: chatId ? 'chat' : userId ? 'chatless' : 'guest', ...(escalation ? { rung: escalation.rung } : {}) },
        })).catch(() => {});
      }

      // ── P5: per-message profile routing — the SATELLITE, not sticky mode ──
      // (User Space §4 — THE ROUTING RULE). A turn runs the CODING harness iff
      // a ChatCodingState workspace satellite is attached; folder capability
      // alone NEVER routes (it means exactly "attachable on demand" — with
      // auto-filing every chat is capable, and capability-routing would push
      // every message, "what's the weather" included, to the durable worker).
      // The send-time router (§4a) is the attach trigger evaluated BEFORE the
      // satellite check: an owner + adult + non-supervisor send carrying
      // code/repo intent to a satellite-less capable chat attaches the
      // workspace NOW, so THIS message routes coding. Legacy mode='code' chats
      // all carry the satellite, so their behavior is preserved. Coding stays
      // owner-only + adult-only: members and kids fall through to the chat
      // pipeline below.
      // The chat row read here is reused by the Auto router (workspace
      // lookup), the always-Auto switch and the label window (supervisor
      // exclusion) — one read per send.
      let targetChat: { id: string; userId: string; projectId: string | null; title: string; isSupervisor: boolean; isProjectSupervisor: boolean; ghostMode?: boolean } | null = null;
      if (userId && chatId && !(req.user as any)?.isChild && !isChild) {
        // (an escalation never routes to the coding harness — it deepens a chat answer)
        targetChat = await prisma.crossModelChat
          // ghostMode (integ/ghost-composer review fix): the research route below never asks a ghost chat's turn plan.
          .findUnique({ where: { id: chatId }, select: { id: true, userId: true, projectId: true, title: true, isSupervisor: true, isProjectSupervisor: true, ghostMode: true } })
          .catch(() => null);
        if (targetChat && targetChat.userId === userId) {
          // MERGE-1 slice 2 (2026-11-03): this seam held the THIRD copy of the
          // per-message routing guards (capability read, owner/supervisor/
          // escalation checks, the code-intent trigger and the attach gate).
          // All of it now lives in platform/send-profile.ts — the same resolver
          // the platform send seam and the ?message= back-compat start use.
          const { resolveSendProfile } = await import('./platform/send-profile');
          const decision = await resolveSendProfile({
            chat: targetChat,
            senderUserId: userId,
            message,
            origin: 'user',
            segment: 'user',
            hasUploads: uploadIds.length > 0,
            // `escalation` is the Dig-deeper descriptor ({ofMessageId, rung}) or
            // null — the resolver only needs "is this an escalation".
            escalation: !!escalation,
            // The kid read already happened above (isChild / req.user.isChild)
            // — pass it so the resolver never re-queries it.
            senderIsChild: false,
          });
          if (decision.attached) {
            logger.info(`userspace: router attached workspace to chat ${String(chatId).slice(0, 8)} (code-intent send; ${decision.gate?.reason ?? 'attached'})`);
          }
          if (decision.profile === 'coding') {
            const { default: codingStreamController } = await import('./coding/coding-stream.controller');
            // 7f546b03: the parsed uploadIds ride along — staged chat uploads
            // resolve into REAL files for the coding run (previously dropped).
            return codingStreamController.streamCapabilityRun(req, res, targetChat, message, uploadIds);
          }
        }
      }

      // ── Guard against undefined / empty / literal-"undefined" messages ───────
      // 2026-06-24: Re-ask analysis surfaced ~19 chats where the literal string
      // "undefined" (or an empty/whitespace-only value) reached the pipeline as the
      // user's message — the frontend occasionally serialized an unset value into the
      // `message` query param (failed template literal / stale state). Downstream a
      // regex `.test(message)` silently coerces `undefined` → the string "undefined"
      // and passes it through, so the garbage propagated all the way to the models and
      // showed up as bogus user turns. Reject it here, at the single param chokepoint,
      // before any SSE headers are sent. A real question that merely *mentions* the
      // word undefined (e.g. "what does undefined mean in JS") is longer than the bare
      // token and is unaffected.
      // 2026-06-30: Reject "null" and "[object Object]" alongside "undefined" — all three
      // are upstream stringification bugs (`String(undefinedVar)` / `${obj}`), never a real
      // user question. A genuine question that merely mentions one of these words is longer
      // than the bare token (matched whole-string here) and is unaffected.
      const bareTok = typeof message === 'string' ? message.trim().toLowerCase() : '';
      if (typeof message !== 'string' || bareTok === '' || bareTok === 'undefined' || bareTok === 'null' || bareTok === '[object object]') {
        res.status(400).json({ error: 'Message is required.' });
        return;
      }

      // Compute policy step 0 (2026-09-26): the first byte goes out BEFORE the
      // router / plan await — nothing below this line answers with a status
      // code (every refusal is an SSE 'error' frame). Design §5 step 0
      // (`controller:1398` flush vs `:1264` routeMessageAuto await).
      flushSse();

      // ── P4 Auto router: 'auto' is a per-message DETENT, not a level ──────
      // Resolve it to a concrete patience level with the zero-latency heuristic
      // (no model call) and tell the client what was chosen via a 'routing'
      // SSE event (the transcript shows which level Auto picked). The chat's
      // stored mode is untouched — 'auto' is never persisted. `browser_agent`
      // and code routing are NOT the router's business.
      let routing: SendRouting | null = null;
      // Patience plan 1a: how the level was chosen (persisted on the assistant
      // row + stamped on the turn's run_spend / chat_search_usage rows).
      let routingSource: string | undefined;
      const isSupervisorChat = !!(targetChat?.isSupervisor || targetChat?.isProjectSupervisor);
      // suggestCode / the gate's state need to know whether this chat can
      // actually gain the Code capability: its folder (or nearest ancestor)
      // owns a workspace. Resolved lazily — only the router and the label
      // window read it.
      const resolveHasWorkspace = async (): Promise<boolean> => {
        if (!userId || !chatId) return false;
        const projectId = targetChat?.projectId
          ?? (await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { projectId: true } }).catch(() => null))?.projectId;
        if (!projectId) return false;
        const { getNearestWorkspaceFolder } = await import('./platform/folder-inheritance');
        return !!(await getNearestWorkspaceFolder(projectId).catch(() => null));
      };

      // ── THE send-mode resolver (2026-09-26 audit, unify-routing) ──────────
      // platform/send-mode.ts resolveSendMode: the patience_auto_only switch
      // (§3.1), the quota allowance on EVERY Auto send (§3.4 — no longer only
      // under the switch), the supervisor-chat clamp, the chatless / machine
      // floors and the label window arming all live there — the REST / tool
      // seam and Telegram call the same function, so the seams cannot drift.
      // Kids skip routing ENTIRELY (§3.5): the child branch below ignores the
      // mode and runs its own single model; browser_agent passes through.
      // CONTRACT under patience_auto_only (audit 2026-09-26; the prod row has
      // read 1 since 2026-09-26 20:35Z): the switch is the owner's "every
      // human send is Auto" — it overrides an explicit preset send too
      // (modeSource 'default' rides as routing.requestedMode only) and
      // routes GUESTS through the router (guest_no_research keeps them off
      // Level 3). Turning the switch OFF restores the preset / guest
      // semantics.
      const resolved = await resolveSendMode({
        mode, userId, clientIp: () => quotaClientIp(req), isChild, isSupervisorChat, escalation: !!escalation,
        origin: 'web', content: message, hasWorkspace: resolveHasWorkspace, sessionId: chatId || undefined, modeSource,
      });
      mode = resolved.mode as typeof mode;
      routing = resolved.routing ?? null;
      routingSource = resolved.routingSource;
      const autoOnly = resolved.autoOnly;
      const autoRouted = resolved.autoRouted;
      // Label window (patience plan 1a §4.1 stream 2): a PICKED explicit level
      // from a signed-in adult in a non-supervisor chat is a human label of
      // this message — armed here (also under the switch, which routes the
      // send as Auto: settings-switches-4 option A), FIRED only once the send
      // is actually admitted (after the deep-research reserve below — a
      // refused Level 3 send is not a label either). Non-blocking.
      let fireLabelWindow: (() => void) | null = null;
      if (resolved.labelWindowLevel && userId) {
        const explicitLevel = resolved.labelWindowLevel;
        fireLabelWindow = () => {
          fireLabelWindow = null;
          void resolveHasWorkspace()
            .then(hasWorkspace => shadowAutoRouteAgainst({ content: message, hasWorkspace, sessionId: chatId || undefined }, explicitLevel, { modeSource, segment: 'user' }))
            .catch(() => { /* never surfaces */ });
        };
      }

      // ── Web search: model-disciplined, not harness-forced (owner 2026-09-03) ──
      // The 2026-06 always-on force (`webSearch = true` here, plus the eager B1
      // SERP fired at run start) is REMOVED: every agentic model at every level
      // has live web tools and a search-discipline doctrine (chat-agent
      // chatDoctrine) telling it exactly when memory is not enough. The
      // `webSearch` request param is still parsed/stored for wire compatibility
      // (StreamQueryRegistration) but gates NOTHING — web tools are always
      // available regardless. Grounding rates are watched post-launch via the
      // 'chat_search_usage' loop metric (chat-agent finalize).

      // ── Sanitize message: strip trailing UUIDs ──────────────────────────────
      // 2026-06-11: Root cause fix for UUID-garbled messages. The stream token system
      // or frontend occasionally appends a UUID to the user message (e.g.
      // "They oppose th,f498b2b9-d862-432c-adc4-32615fb0f48e"). Previously we only
      // stripped UUIDs in the title repair path, but the garbled message was still sent
      // to AI models, causing poor responses and re-ask patterns. Now we strip UUIDs
      // from the message itself before it enters the pipeline.
      // 2026-07-02: The stream-token bug always GLUES the UUID directly onto the
      // preceding text (comma or word char, no space) — "They oppose th,f498b2b9…".
      // The leading (?<=\S) makes stripping require that glue, so a UUID a user
      // typed/pasted intentionally with a space before it ("my id is 30530794-…")
      // is left untouched. Prevents truncating legitimate content that merely ends
      // in a space-separated UUID (e.g. pasted SEC-filing / config text).
      const UUID_SUFFIX_RE = /(?<=\S),?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (UUID_SUFFIX_RE.test(message)) {
        const cleaned = message.replace(UUID_SUFFIX_RE, '').trim();
        if (cleaned.length > 0) {
          logger.warn(`streamQuery: stripped trailing UUID from message: "${message.substring(message.length - 50)}" → "${cleaned.substring(cleaned.length - 50)}"`);
          message = cleaned;
        }
      }

      // ── Build attachment ──────────────────────────────────────────────────
      // Ticket 1aefc929: NEVER silently deliver text-only when the caller
      // staged attachments. EVERY staged blob gone (15-min TTL expired / lost)
      // → hard SSE 'error' BEFORE anything runs or persists (the client toasts
      // `error` events — CodeSessionView); the pre-fix behavior proceeded
      // text-only with only a server-side warn — the exact silent drop behind
      // the owner report. SOME gone → proceed with the survivors and annotate
      // the message honestly (the queued-drain idiom, chat-agent.service.ts).
      const stagedResolution = await resolveStagedUploads(uploadIds, loadAttachment);
      if (stagedResolution.fatalMessage) {
        res.write(`data: ${JSON.stringify({ type: 'error', data: { message: stagedResolution.fatalMessage } })}\n\n`);
        res.end();
        return;
      }
      if (stagedResolution.droppedCount > 0) {
        message = `${message ? `${message}\n\n` : ''}${attachmentDropAnnotation(stagedResolution.droppedCount)}`;
      }
      const loadedOk = stagedResolution.loaded;
      const rawAttachments = loadedOk.map(l => l.attachment);
      // Shared merge (upload.controller.combineAttachments) — identical to the
      // fleet supervisor send path.
      const attachment = combineAttachments(rawAttachments);
      // Single-upload requests: expose the uploadId to tool-calling models so
      // follow-up tools (fill_pdf_form) can pull the same binary from Redis
      // during its 15-min TTL. Ambiguous with multiple uploads — left unset.
      if (attachment && loadedOk.length === 1) {
        attachment.uploadId = loadedOk[0].id;
      }

      // ── Research routing by the TURN PLAN (roster 2026-10-06 A-3, platform/lane-depth.ts) ──
      // For a sender the research-lane feature acts for (store flag laneResearch + the owner canary), the
      // turn plan is asked HERE — before the routing card and the quota reserve — so a confident research lane
      // routes to the council through the reserve below (an Auto send that loses it is demoted to Ensemble,
      // never an error) and a keyword Level 3 the turn plan does not call research is retired to Ensemble. The
      // answered plan rides into the run (args.turnPlanPrefetched — one ask per turn). Anyone else: no ask, no
      // added latency. Fails open: any error / no answer ⇒ the router's level stands.
      let turnPlanPrefetched: import('./platform/turn-plan').TurnPlan | null = null;
      let laneResearchRouted = false;
      if (!escalation && !isChild && autoRouted && mode !== 'browser_agent') {
        try {
          const { routeResearchLane } = await import('./platform/lane-depth');
          const laneFiles = attachment ? [attachment, ...((attachment as Attachment).additionalFiles ?? [])] : [];
          const laneImages = laneFiles.filter((f: any) => f?.type === 'image').length;
          const lr = await routeResearchLane({
            seam: 'web', userId: userId ?? null, chatId: chatId ?? null, message,
            images: laneImages, documents: laneFiles.length - laneImages,
            mode, routing, autoRouted, segment: resolved.segment, isSupervisorChat, isChild, escalation: false,
            // 2026-10-20: the router's Level 3 allowance verdict — a guest / quota-denied sender is never lane-routed to a council.
            deepResearchAllowed: resolved.allowDeepResearch, deepResearchDenyReason: resolved.allowDeepResearchReason,
            // Ghost mode (integ/ghost-composer review fix): the turn plan is a CLOUD decision call carrying the
            // message + prior turns — a ghost turn is never asked here (the run's own ghost_skip then applies). The
            // row's stored flag governs a chat with a row (as in the run); a chatId-less send (guest / the
            // createChat-failure fallback) — or a row read that failed — carries the per-send opt-in.
            ghost: targetChat ? targetChat.ghostMode === true : ghostSend,
          });
          if (lr.mode !== mode) {
            mode = lr.mode as typeof mode;
            routing = (lr.routing ?? routing) as SendRouting | null;
            if (lr.routingSource) routingSource = lr.routingSource;
          }
          laneResearchRouted = lr.route === 'research';
          turnPlanPrefetched = lr.turnPlan;
        } catch (err: any) {
          logger.warn(`streamQuery: research lane routing failed (${err?.message ?? err}) — the router's level stands`);
        }
      }

      // P4: an Auto-routed message announces its resolved level up front.
      if (routing) sendEvent('routing', routing);

      // SSE keepalive — already running since the header flush (stream drops
      // 2026-10-20); here only under SSE_EARLY_HEARTBEAT_DISABLED=1 (no-op otherwise).
      startKeepalive();

      try {
        // ── Digby Kids: child sub-accounts take a totally separate path ──────
        // A child account is NOT routed through the multi-model pipeline. It gets
        // one simple model (Qwen 3.6 Flash) + web search + a strict Socratic prompt
        // (age + parental guardrails). Everything else — modelSet, deep research,
        // Google/GitHub context, RAG, multi-model synthesis — is bypassed. We detect
        // the child from the DB (not just the token) so an older token still routes
        // correctly, and refuse anonymous "kid mode" entirely.
        if (userId) {
          // childRow was read above the router (patience plan 1a hoist).
          if (childRow?.isChild) {
            // Self-host setup hardening (2026-10-20): with no search backend the
            // kid path neither narrates a search nor runs the doomed call.
            const kidWebConfigured = webSearchStatus().configured;
            sendEvent('init', { mode: 'kids', webSearch: kidWebConfigured });
            // Fun, kid-friendly "thinking" status — DYNAMICALLY written by the utility
            // LLM for THIS question (a punny, playful line), the same dynamic approach
            // normal users get for commentary/reasoning summaries. Fire-and-forget so it
            // never blocks; it emits as soon as the helper returns. No hardcoded text.
            const searchStatusEmitted = kidWebConfigured
              ? generateKidStatus(message, childRow.childAge, 'search')
                .then(s => { if (s) sendEvent('progress', { message: s, stage: 'query' }); })
                .catch(() => {})
              : Promise.resolve();

            // Web search is the child's only tool — inject results as grounding.
            // 2026-08-29 (ticket 5e84448a): bound the raw BrightData SERP through
            // the SAME serp-bound.ts choke point every chat-agent model context
            // uses (ticket ba968a07) — the kid path previously injected the
            // verbatim 30-80KB blob (junk hosts, duplicate mentions, unbounded
            // length) into the child-facing system prompt. boundSerpForContext is
            // pure and never throws, but it rides inside the same try so ANY failure
            // still degrades to "no grounding", never a dead stream.
            let webContext = '';
            if (kidWebConfigured) {
              try {
                webContext = boundSerpForContext(await searchWithBrightData(message)).text;
              } catch (e: any) {
                logger.warn(`kid web search failed (non-fatal): ${e?.message}`);
              }
            }
            // Self-host setup hardening (2026-10-20): an EMPTY grounding on an
            // instance with no search backend is a configuration fact, not a
            // thin topic — the kid prompt says so instead of promising a lookup.
            const kidNoLiveWeb = !webContext && !kidWebConfigured;
            // A second dynamically-generated playful beat before the answer streams.
            // 2026-06-26: chain off the first status so the 'think' beat can never be
            // emitted BEFORE the 'search' beat. The first call is fire-and-forget with a
            // 6s cap, so if web search returned fast it could otherwise still be pending
            // and resolve after this one — showing the two status lines out of order.
            // Still off the main response path (the answer stream below never awaits it).
            searchStatusEmitted.then(() =>
              generateKidStatus(message, childRow.childAge, 'think')
                .then(s => { if (s) sendEvent('progress', { message: s, stage: 'analyzing' }); })
                .catch(() => {})
            );

            // Short prior history for continuity (kept small for young learners).
            // Read from the normalized crossModelMessage table — the JSONB
            // `messages[]` column on crossModelChat is deprecated and left empty
            // for new chats, so loading from it broke kid conversation continuity.
            let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
            if (chatId) {
              try {
                const rawMsgs = await prisma.crossModelMessage.findMany({
                  where: { chatId },
                  orderBy: { createdAt: 'desc' },
                  take: 6,
                  select: { role: true, content: true },
                });
                history = rawMsgs
                  .reverse()
                  .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
                  .map(m => ({ role: m.role as 'user' | 'assistant', content: String(m.content).slice(0, 4000) }));
              } catch { /* no history is fine */ }
            }

            const started = Date.now();
            let kidText = '';
            let kidModel = 'qwen3.6-flash'; // overwritten with the Digby Kids seat's served model
            try {
              const r = await streamKidResponse(
                message,
                { age: childRow.childAge, guardrails: childRow.childGuardrails, webContext, history, noLiveWeb: kidNoLiveWeb },
                (delta) => sendEvent('chunk', { content: delta }),
              );
              kidModel = r.model;
              kidText = r.text;
            } catch (kidErr: any) {
              logger.error(`kid chat failed: ${kidErr?.message}`);
              const friendly = "Oops! I had a little trouble just now. Can you try asking me again? 🙂";
              if (!kidText) sendEvent('chunk', { content: friendly });
              kidText = kidText || friendly;
            }

            sendEvent('complete', {
              summary: kidText,
              models: { qwen_kid: { response: kidText, model: kidModel, time: Date.now() - started, webSearchUsed: Boolean(webContext) } },
              synthesisTime: Date.now() - started,
            });
            // Persist the turn so kid chats have continuity across reloads — the
            // history read above (crossModelMessage) found nothing before this,
            // making every kid chat amnesiac (session b92ef13f explorer finding).
            // Fire-and-forget (ownership-checked inside) so it never delays end().
            if (chatId) {
              contextService.saveToChatHistory(
                chatId, userId, message, kidText,
                { modelResponses: [{ model: kidModel, time: Date.now() - started }] } as any,
              ).catch(err => logger.error('Failed to save kid chat history:', err));
            }
            clearInterval(keepaliveTimer);
            if (!res.writableEnded) res.end();
            return;
          }
        }

        // ── Agentic-only gate (2026-07-23 cutover) ──────────────────────────
        // EVERY non-kids, non-browser_agent chat request now runs the agent
        // engine — all patience modes, both model sets, anonymous AND logged-in,
        // with or without attachments. The legacy LangGraph pipeline (and the
        // chatEngine/modelSet engine prefs) are gone. decideChatGate is the pure
        // decision; quota + integration pre-fetch stay here (I/O).
        const gate = decideChatGate({ mode, userId, ...(laneResearchRouted ? { lane: 'research' as const } : {}) });
        if (gate.action === 'auth_required') {
          // (No mode requires an account today — guests got deep research
          // 2026-09-23; kept for a future gated mode.)
          sendEvent('error', { message: gate.message, code: gate.code });
          clearInterval(keepaliveTimer);
          if (!res.writableEnded) res.end();
          return;
        }
        if (gate.action === 'agent') {
          // H1 (adversarial review 2026-07-23): a chatId on the request is an
          // assertion of WRITE access — the run persists user/assistant rows
          // (and maybe the title) under that id. Verify BEFORE anything else:
          // anonymous callers can never own a chat (their history lives in the
          // Redis session store), and project-shared chats accept the owner OR
          // a project editor/admin (mirrors getChatAccess 'write' — a project
          // member CAN legitimately send messages in a shared chat; viewers
          // may read but not inject). 'Chat not found' avoids leaking existence.
          if (chatId) {
            const { access, exists } = userId
              ? await crossModelService.getChatAccess(chatId, userId).catch(() => ({ access: 'none' as const, exists: false }))
              : { access: 'none' as const, exists: false };
            if (!chatWriteAccessGranted({ userId, access, exists })) {
              // Anonymous arrival (stale/missing cm_access cookie) gets an
              // actionable session-expired message; an authenticated VIEWER
              // member gets the actionable view-access message (7acaa7ba); an
              // authenticated stranger keeps the non-leaking 'Chat not found'.
              sendEvent('error', streamAccessDeniedError({ userId, access }));
              clearInterval(keepaliveTimer);
              if (!res.writableEnded) res.end();
              return;
            }
          }

          // Persistent chat files (2026-08-25): every staged upload this send
          // resolved (above, BEFORE the busy check — an immediate run and a
          // busy-queue enqueue share that one load) becomes a durable ChatFile
          // row so the file outlives the 15-min Redis TTL. AFTER the H1 write
          // check so a stranger's chatId can't pin files into a chat they
          // can't write. Idempotent per (uploadId, chatId): the queue drain
          // re-resolves the same staged ids and its persist is a no-op.
          // Fire-and-forget — a persistence failure must never fail the send.
          if (userId && chatId && loadedOk.length) {
            void persistChatUploads({
              chatId,
              userId,
              loaded: loadedOk.map(l => ({ id: l.id, attachment: l.attachment as Attachment })),
            });
          }

          // DETACHED run (2026-07-15): the run executes independently of this
          // SSE response — a dropped mobile connection just unsubscribes the
          // viewer; the run completes and the answer persists. Stopping is an
          // explicit endpoint action, never inferred from a disconnect.
          const { startDetachedChatRun, chatAgentRunKey, preemptMachineRunForUserMessage, nudgeQueueDrainSoon } = await import('./chat-agent/chat-agent.service');
          const { isRunActive: chatRunActive, subscribeRun: subscribeChatRun } = await import('./coding/live-runs');

          // Busy-chat queue (2026-08-07): a run is already answering in this
          // chat — persist the message to pending_chat_messages and tell the
          // client it's QUEUED (additive SSE event; the active run's finally
          // drains the queue automatically — chat-agent.service drainChatQueue)
          // instead of dropping the message with an error. Queue-full surfaces
          // the 409 message as an error event; a queue write failure falls back
          // to the legacy busy error so the stream never breaks. Anonymous
          // sessions have no chat row to queue against — they keep the legacy
          // error (their message was never persistable anyway).
          // Set once THIS send holds a deep-research slot (the direct reserve
          // below, or the queue path's own) — a lost start race that queues
          // after the direct reserve must never charge twice.
          let councilSlotReserved = false;
          const queueBusyMessage = async (): Promise<void> => {
            // Dig deeper never queues: a queued escalation would replay as a
            // plain re-ask of the original question. Say so; the chip stays.
            if (escalation) {
              sendEvent('error', { message: 'Digby is still working in this chat — tap Dig deeper again when it finishes.', code: 'ESCALATION_BUSY' });
              return;
            }
            if (chatId && userId) {
              // Queued Level 3 (audit 2026-10-03): the drain starts the row's
              // mode with no reserve of its own, so a council queued behind a
              // busy run ran UNMETERED. Reserve the slot now (the send will
              // run); an Auto-routed Level 3 that loses the reserve is queued
              // as Ensemble (never an error, §3.4), an explicit one errors like
              // the direct path; a failed enqueue gives the slot back.
              // QUEUED_COUNCIL_QUOTA_DISABLED=1 restores the unmetered queue.
              const councilQueued = mode === 'deep_research' || mode === 'deep_research_all';
              if (councilQueued && !councilSlotReserved && !queuedCouncilQuotaDisabled()) {
                const quota = await reserveDeepResearchQuota(userId);
                if (quota.allowed) {
                  councilSlotReserved = true;
                } else if (autoRouted) {
                  const demoted = demoteForQuota(routing ?? undefined);
                  mode = demoted.mode;
                  routing = demoted.routing;
                  sendEvent('routing', routing);
                  recordLoopMetric({
                    kind: LOOP_METRIC_KINDS.DEEP_RESEARCH_QUOTA_REJECTED, sessionId: chatId,
                    meta: { scope: 'user', anon: false, mode: 'deep_research', routingSource, limit: quota.limit, used: quota.used, autoOnly, autoRouted: true, demoted: true, queued: true },
                  });
                } else {
                  recordLoopMetric({
                    kind: LOOP_METRIC_KINDS.DEEP_RESEARCH_QUOTA_REJECTED, sessionId: chatId,
                    meta: { scope: 'user', anon: false, mode, routingSource, limit: quota.limit, used: quota.used, autoOnly, autoRouted: false, demoted: false, queued: true },
                  });
                  sendEvent('error', { message: `Daily deep research limit reached (${quota.used}/${quota.limit}). Resets at midnight UTC.`, code: 'RATE_LIMIT_DEEP_RESEARCH' });
                  return;
                }
              }
              try {
                const { enqueueChatMessage } = await import('./chat-agent/message-queue.service');
                const { id: pendingId, position } = await enqueueChatMessage({
                  chatId, userId, content: message, mode, source: 'user',
                  // Queued attachments (ac65d51e): the staged upload ids ride
                  // the pending row; the drain resolves them into the run.
                  ...(uploadIds.length ? { uploadIds } : {}),
                }).catch(async (err) => {
                  // Neither started nor queued — the slot goes back.
                  if (councilSlotReserved) { councilSlotReserved = false; await refundDeepResearchQuota(userId); }
                  throw err;
                });
                // `id` (ticket ea04454c): the row's handle, so the client can
                // promote/cancel THIS message immediately — "Send now" =
                // queue → stop → promote needs the id without a second GET.
                sendEvent('queued', { position, id: pendingId });
                // F2(b) enqueue-side nudge (incident 2026-09-04): if the busy
                // check raced the active run's finalize (its drain already ran),
                // nothing would deliver this row until the sweep — attempt an
                // immediate drain shortly (no-op while genuinely busy).
                nudgeQueueDrainSoon(chatId, userId);
                return;
              } catch (err: any) {
                if (err?.statusCode === 409) {
                  sendEvent('error', { message: err.message || 'The message queue for this chat is full — wait for the active run to finish, then resend.' });
                  return;
                }
                logger.warn(`streamQuery: busy-queue enqueue failed for ${chatId}: ${err?.message ?? err}`);
              }
            }
            sendEvent('error', { message: 'Digby is still working on the previous message in this chat — wait for it to finish, then resend.' });
          };

          // Active-run guard — BEFORE the quota reserve (M1: a rejected
          // double-submit must not burn a daily deep-research slot). The guard
          // key is only computable/meaningful when chatId or sessionId exists;
          // the ephemeral case (logged-in, no chat, no session) mints a fresh
          // key inside startDetachedChatRun and can't collide by construction.
          // Chat runs check the CROSS-PROCESS truth (chat-busy, P5 audit) so a
          // run on the other blue/green instance queues here too instead of
          // burning a council-quota slot and losing the atomic claim below;
          // anonymous session runs stay process-local (no chatId to share on).
          if (chatId || sessionId) {
            const { isChatBusy } = await import('./chat-agent/chat-busy');
            // Anonymous sessions (audit 2026-09-26 guest-persistence-5): the
            // cross-process marker too — a reloaded guest tab lands on the OTHER
            // blue/green box half the time and used to start a second run.
            const busy = chatId
              ? await isChatBusy(chatId)
              : (chatRunActive(chatAgentRunKey({ chatId, sessionId })) || (sessionId ? await isGuestSessionRunActive(sessionId) : false));
            if (busy) {
              // Message-as-answer (ticket 356d21bb): a LIVE ask_user card on
              // this chat treats this inbound message AS the answer — resolve
              // the wait with the text BEFORE any preempt/queue decision.
              // Doing it FIRST matters for a parked MACHINE run: the preempt
              // below cancels that run and null-resolves its waits, so the
              // answer (durable record + flagged rows) must be stamped first.
              let answeredParkedQuestion = false;
              if (chatId && userId) {
                const { resolveParkedQuestionWithOwnerText } = await import('./message-as-answer');
                answeredParkedQuestion = (await resolveParkedQuestionWithOwnerText({ chatId, userId, text: message }).catch(() => ({ resolved: false }))).resolved;
              }
              // F1 (owner incident 2026-09-04): a USER-TYPED message never sits
              // behind REPLAYABLE machine work. If the active run is
              // machine-triggered (wake/schedule/hook/agent/webhook — the Redis
              // claim carries the marker), request its cancellation and wait a
              // bounded ~5s for graceful teardown; freed → fall through and
              // start THIS message immediately (a lost start race below still
              // queues). A user-triggered run is never touched — the marker
              // gate fails safe — and coding runs never carry it.
              let freed = false;
              let preempted = false;
              if (chatId && userId) {
                const p = await preemptMachineRunForUserMessage(chatId).catch(() => ({ preempted: false, freed: false }));
                freed = p.freed;
                preempted = p.preempted;
              }
              if (!freed) {
                if (answeredParkedQuestion && !preempted) {
                  // USER run parked on the card (Gap B): the message WAS the
                  // answer — the parked run is resuming with it right now, so
                  // there is nothing to queue. Send-ack (additive event; the
                  // client's normalizer drops unknown types) and end — the
                  // run's own ask_user_resolved SSE clears the card.
                  sendEvent('question_answered', {});
                  clearInterval(keepaliveTimer);
                  if (!res.writableEnded) res.end();
                  return;
                }
                // Still busy (user run, teardown slower than the wait, or a
                // coding run) — QUEUE the message with user priority (F2): the
                // run's finalize drain delivers user rows first. When the
                // message just answered a MACHINE run's card, the queue still
                // carries it: the cancelled run may not act on the answer, and
                // F1 says the user's turn runs next.
                await queueBusyMessage();
                clearInterval(keepaliveTimer);
                if (!res.writableEnded) res.end();
                return;
              }
            }
          }

          // Council modes (deep_research / deep_research_all) share the daily
          // deep-research quota. Atomic reserve (INCR-first) closes the
          // check-then-increment race.
          // Guests (owner 2026-09-23) draw on a smaller per-IP allowance
          // (reserveAnonDeepResearchQuota — fails closed) and are pointed at
          // a free account when it runs out.
          if (gate.councilMode) {
            const quota = userId
              ? await reserveDeepResearchQuota(userId)
              : await reserveAnonDeepResearchQuota(quotaClientIp(req));
            if (quota.allowed && userId) councilSlotReserved = true;
            if (!quota.allowed && autoRouted) {
              // §3.4: ANY Auto-routed Level 3 that loses the reserve race is
              // demoted to Ensemble — the routing card is rewritten and the
              // run continues (patience plan: "Auto never errors a user on
              // quota"; 2026-09-26 audit routing-unify-1: this used to need
              // the switch, so the default signed-in wire mode 'auto' errored).
              const demoted = demoteForQuota(routing ?? undefined);
              mode = demoted.mode;
              routing = demoted.routing;
              sendEvent('routing', routing);
              logger.info(`auto router: quota demotion after reserve refusal (userId=${userId || 'anon'} ${quota.used}/${quota.limit})`);
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.DEEP_RESEARCH_QUOTA_REJECTED, sessionId: chatId ?? (sessionId ? `anon-${sessionId}` : undefined),
                meta: { scope: userId ? 'user' : 'anon', anon: !userId, mode: 'deep_research', routingSource, limit: quota.limit, used: quota.used, autoOnly, autoRouted: true, demoted: true, ...(laneResearchRouted ? { lane: 'research', laneSource: 'turn_plan' } : {}) },
              });
            } else if (!quota.allowed) {
              // Telemetry gap (patience plan 1a §2 "Telemetry that already
              // exists"): the refusal used to be visible only as a log line.
              recordLoopMetric({
                kind: LOOP_METRIC_KINDS.DEEP_RESEARCH_QUOTA_REJECTED, sessionId: chatId ?? (sessionId ? `anon-${sessionId}` : undefined),
                meta: { scope: userId ? 'user' : 'anon', anon: !userId, mode, routingSource, limit: quota.limit, used: quota.used, autoOnly, autoRouted: false, demoted: false },
              });
              sendEvent('error', userId
                ? {
                    message: `Daily deep research limit reached (${quota.used}/${quota.limit}). Resets at midnight UTC.`,
                    code: 'RATE_LIMIT_DEEP_RESEARCH',
                  }
                : {
                    message: quota.limit > 0
                      ? `You've used today's free Deep Research runs as a guest (${quota.limit}/day). Create a free account for more — Quick and Ensemble are still available.`
                      : 'Deep Research needs a free account. Quick and Ensemble are still available as a guest.',
                    code: 'RATE_LIMIT_DEEP_RESEARCH_GUEST',
                  });
              clearInterval(keepaliveTimer);
              if (!res.writableEnded) res.end();
              return;
            }
            logger.info(`${mode} (agent council): userId=${userId} usage=${quota.used}/${quota.limit}`);
          }
          // The send is admitted (access, busy-queue and quota gates passed):
          // a picked explicit level now becomes a label-window row.
          fireLabelWindow?.();
          logger.info(`streamQuery (agent): userId=${userId || 'anon'}, chatId=${chatId || 'none'}, mode=${mode}`);

          // Attachments → agent inputs (images → vision orchestrator override;
          // doc/PDF text → a capped context block on the user message).
          const { userImages, documentText } = mapAttachmentForAgent(attachment);
          // Connected-integration data (Google/GitHub/X/Slack/Asana/Xero/Plaid/
          // iMessage) pre-fetched into the system prompt; the iMessage lookup
          // also yields the paired Mac agent id for the post-answer draft
          // classifier inside the run. Ticket 11d98377: the prefetch is
          // BOUNDED — this await sits before the run starts, so without a
          // deadline it is first-word latency on every lane (the nightly suite
          // breached the Quick-lane bar on a wedged X trends prefetch). The
          // race starts the run with whatever settled; legs keep settling in
          // the background.
          const { additionalContext: integrationContext, imessagePairedAgentId } = await buildIntegrationContextBounded(() =>
            buildIntegrationContext({ userId: userId ?? null, message, sendEvent }),
          );
          // Guest location (owner 2026-09-23): guests have no memory `location`
          // fact, so local questions ("best place for tacos") had nothing to
          // anchor on. Browser-reported ?userLocation first, else an
          // approximate IP lookup (fail-soft, cached). Signed-in users keep
          // their memory fact path.
          let guestLocationBlock: string | undefined;
          if (!userId) {
            try {
              guestLocationBlock = await buildGuestLocationBlock({ clientLocation: req.query.userLocation, clientIp: getClientIp(req) });
            } catch { /* non-critical — the doctrine asks for the city instead */ }
          }
          const additionalContext = [integrationContext, guestLocationBlock].filter(Boolean).join('\n\n') || undefined;

          // H2: subscribe with the key the run ACTUALLY registered under
          // (returned here), never a recomputed key — the ephemeral case
          // mints a fresh uuid key inside, which a recomputation can't match.
          const runKey = await startDetachedChatRun({
            userId: userId ?? null,
            chatId: chatId ?? null,
            sessionId: sessionId ?? null,
            message,
            mode: mode as 'single_thinking' | 'thinking' | 'deep_research' | 'deep_research_all',
            // Ghost mode (owner 2026-10-22): the per-send opt-in (guests /
            // chatId-less sends). For a chat with a row, the run seam reads
            // the stored flag and THIS param is ignored.
            ...(ghostSend ? { ghost: true } : {}),
            ...(routing ? { routing } : {}),
            ...(routingSource ? { routingSource } : {}),
            // Dig deeper (compute policy): the rung + the message it deepens.
            ...(escalation ? { escalation } : {}),
            // Roster 2026-10-06 A-3: the turn plan the research route already asked (the run never asks twice).
            ...(turnPlanPrefetched ? { turnPlanPrefetched } : {}),
            additionalContext,
            imessagePairedAgentId,
            userImages,
            documentText,
            // User-row attachment chips (ticket c6e8edda): the resolved
            // filename+type PLUS the staged uploadId — the run persists them
            // as metadata.attachments, and getChatById later joins the
            // uploadId against the durable ChatFile row (persisted above) to
            // inject fileId so image chips render inline after a reload.
            ...(loadedOk.length
              ? { attachmentMeta: loadedOk.map(l => ({ filename: (l.attachment as Attachment).filename, type: (l.attachment as Attachment).type, uploadId: l.id })) }
              : {}),
            // A REAL user turn triggered this run (request arrival) — the
            // confirmation anchor for consequential platform tools.
            userTurnAt: new Date(),
          });
          if (!runKey) {
            // Lost the start race (e.g. double-submit) — a run is active NOW,
            // so queue exactly like the guard branch (its finally drains us).
            await queueBusyMessage();
            clearInterval(keepaliveTimer);
            if (!res.writableEnded) res.end();
            return;
          }
          let unsubChat: (() => void) | null = null;
          let viewerEventsWritten = 0;
          const endChatSub = () => {
            clearInterval(keepaliveTimer);
            unsubChat?.();
            if (!res.writableEnded) res.end();
          };
          unsubChat = subscribeChatRun(runKey, (e) => {
            if (res.writableEnded || clientDisconnected) return;
            try { res.write(`data: ${JSON.stringify({ type: e.type, data: e.data, ...(e.ts ? { ts: e.ts } : {}) })}\n\n`); viewerEventsWritten++; } catch { /* viewer gone */ }
            if (e.type === 'complete' || e.type === 'error') endChatSub();
          });
          if (!unsubChat) { endChatSub(); return; } // run ended in the same tick
          req.on('close', () => {
            // Stream drops (2026-10-20): the viewer left before the final event
            // while the run is still going — one throttled sse_viewer_drop row.
            if (!res.writableEnded && chatRunActive(runKey)) {
              recordSseViewerDrop({ surface: 'stream', path: 'local', sessionKey: streamSessionKey(chatId, sessionId), elapsedMs: Date.now() - streamOpenedAt, eventsWritten: viewerEventsWritten, guest: !userId });
            }
            unsubChat?.(); clearInterval(keepaliveTimer);
          }); // detach viewer ONLY — the run continues
          return;
        }

        // ── Browser Agent (open-source web automation) ──────────────────────
        // Patience-independent mode: GLM-5.3 (reasoning_effort:"high") drives a real
        // browser. The agent REASONS which backend to use — cloud BrightData browser
        // (via the Digby MCP gateway) or the user's own Mac (paired local agent). It
        // bypasses the multi-model pipeline entirely. Requires an account (we route to
        // the user's paired Mac and gate cloud usage to authenticated users).
        if (mode === 'browser_agent') {
          if (!userId) {
            sendEvent('error', {
              message: 'Browser agent requires an account. Please sign in.',
              code: 'AUTH_REQUIRED_BROWSER_AGENT',
            });
            clearInterval(keepaliveTimer);
            if (!res.writableEnded) res.end();
            return;
          }
          sendEvent('init', { mode: 'browser_agent', webSearch: false });
          try {
            const r = await runBrowserAgentSession({
              userId,
              chatId: chatId || null,
              message,
              attachment,
              sessionId,
              // ea3ad8a8: the hosted hardened browser's per-chat context key.
              sessionKey: chatId ? `chat:${chatId}` : null,
              sendEvent,
            });
            sendEvent('complete', {
              summary: r.finalResponse,
              models: {
                browser_agent: {
                  response: r.finalResponse,
                  time: r.elapsed,
                  model: `browser-${r.driverUsed}`,
                },
              },
              synthesisTime: r.elapsed,
              message: 'Browser automation complete',
              sessionId: sessionId || null,
              autoTitle: r.title || null,
            });
          } catch (e: any) {
            logger.error(`Browser agent failed: ${e?.message || e}`);
            sendEvent('error', { message: `Browser agent failed: ${e?.message || e}` });
          }
          clearInterval(keepaliveTimer);
          if (!res.writableEnded) res.end();
          return;
        }

      } catch (streamError: any) {
        clearInterval(keepaliveTimer);
        logger.error('Stream error:', streamError);
        sendEvent('error', { message: streamError.message || 'An error occurred during processing' });
        res.end();
      }
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/crossmodel/ux/beacon — compute policy step 0 (2026-09-26).
   * The frontend's perceived-latency beacon: first paint of an answer, a
   * revision seen, a Dig-deeper / sign-in tap, an abandon. ONE loop_metrics
   * row (kind ux_beacon, value = client ms when sent); never a model call, never
   * a user-visible effect. UX_BEACON_DISABLED=1 ⇒ 204 with nothing recorded.
   * Anonymous-capable: the row carries only chat/message ids the client already
   * holds and a guest flag.
   */
  async uxBeacon(req: Request, res: Response, next: NextFunction) {
    try {
      if (uxBeaconDisabled()) { res.status(204).end(); return; }
      const userId = (req as any).user?.id ?? null;
      const { event, chatId, messageId, ms, mode, target, sessionId: bodySessionId, attempts, outcome, guest: bodyGuest } = req.body as { event: string; chatId?: string; messageId?: string; ms?: number; mode?: string; target?: string; sessionId?: string; attempts?: number; outcome?: string; guest?: boolean };
      // Guest rows key on `anon-<sid>` (audit 2026-09-26 guest-persistence-4) —
      // the SAME key ux_ttft / compute_policy stamp — so beacon rows join them.
      const guestSid = !chatId && !userId
        ? (typeof bodySessionId === 'string' && GUEST_SESSION_ID_RE.test(bodySessionId) ? bodySessionId : (typeof req.cookies?.[SESSION_COOKIE] === 'string' ? req.cookies[SESSION_COOKIE] : undefined))
        : undefined;
      const beaconSessionId = chatId ?? (guestSid ? `anon-${guestSid}` : undefined);
      // Stream drops (2026-10-20): the client's stream_drop / stream_resume
      // beacons carry { attempts, ms = since the send, outcome, guest } and ride
      // the stream-drop throttle (this endpoint is public — a flapping client
      // must not flood loop_metrics); SSE_DROP_TELEMETRY_DISABLED=1 ⇒ nothing.
      // Their own budget, capped per client (the hashed hops-anchored client
      // ip — never req.ip, the ALB node): a client rotating chat uuids can
      // neither silence the server's own drop rows nor everyone else's beacons.
      const streamEvent = STREAM_BEACON_EVENTS.has(event);
      if (streamEvent) {
        const client = hashedClientKey(req as any);
        if (!allowStreamBeacon(event, beaconSessionId ?? (client ? `ip:${client}` : undefined), client)) { res.status(204).end(); return; }
      }
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.UX_BEACON,
        sessionId: beaconSessionId,
        ...(typeof ms === 'number' ? { value: ms, unit: 'ms' } : {}),
        meta: {
          event, ...(messageId ? { messageId } : {}), ...(mode ? { mode } : {}), ...(target ? { target } : {}),
          guest: streamEvent && typeof bodyGuest === 'boolean' ? bodyGuest : !userId,
          ...(streamEvent && typeof attempts === 'number' ? { attempts } : {}),
          ...(streamEvent && outcome ? { outcome } : {}),
        },
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/crossmodel/transcribe
   * Transcribe audio on the Speech-to-text (ASR) seat (speech.ts: override →
   * self-hosted STT → DashScope qwen3-asr-flash).
   */
  async transcribeAudio(req: Request, res: Response, next: NextFunction) {
    try {
      const { audio, mimeType = 'audio/webm', filename = 'recording.webm' } = req.body as {
        audio: string;
        mimeType?: string;
        filename?: string;
      };
      if (!audio?.trim()) {
        return res.status(400).json({ error: 'audio is required (base64 encoded)' });
      }
      const buffer = Buffer.from(audio, 'base64');
      const { transcribeAudio } = await import('./speech');
      const text = await transcribeAudio(buffer, filename, mimeType);
      logger.info(`transcribeAudio: ${text.length} chars transcribed`);
      res.json({ success: true, text });
    } catch (error: any) {
      logger.error('Transcription error:', error.response?.data || error.message);
      res.status(500).json({ error: 'Transcription failed', details: error.response?.data?.error?.message || error.message });
    }
  }

  /**
   * POST /api/crossmodel/tts
   * Text-to-speech on the Text-to-speech seat (speech.ts: override →
   * DashScope qwen3-tts-flash). Returns base64 audio + its MIME type (the
   * client plays whatever type comes back).
   */
  async textToSpeech(req: Request, res: Response, next: NextFunction) {
    try {
      const { text, voice } = req.body as { text: string; voice?: string };
      if (!text?.trim()) {
        return res.status(400).json({ error: 'text is required' });
      }
      const { textToSpeech } = await import('./speech');
      const spoken = await textToSpeech(text, voice);
      const base64Audio = spoken.audio.toString('base64');
      logger.info(`textToSpeech: ${text.length} chars -> ${base64Audio.length} base64 bytes (${spoken.model}, voice ${spoken.voice}, ${spoken.mimeType})`);
      res.json({ success: true, audio: base64Audio, mimeType: spoken.mimeType, model: spoken.model, voice: spoken.voice });
    } catch (error: any) {
      logger.error('TTS error:', error.response?.data || error.message);
      res.status(500).json({ error: 'Text-to-speech failed', details: error.message });
    }
  }

  /**
   * POST /api/crossmodel/tts/stream  (ticket 2774d2b7)
   *
   * Progressive twin of POST /tts for read-aloud: the answer's ≤600-char
   * sentence chunks synthesize with bounded concurrency and each one is
   * flushed as its own NDJSON line the moment it is ready, so audio starts
   * playing after the FIRST chunk (~5-15 s) instead of after the whole answer
   * — the legacy single-JSON response spent ~14 s per chunk sequentially
   * (50-130 s for a multi-paragraph answer), which outlived both the web
   * client's 45 s axios timeout and nginx's 60 s idle ceiling: the speaker
   * button "just spins and dies" with no audio and no backend error.
   *
   * Wire shape — one JSON object per \n-terminated line:
   *   {"type":"chunk","index":<text order>,"total":<chunks>,"mimeType":"audio/wav","audio":"<base64>"}
   *   {"type":"done","delivered":<n>,"model":"qwen3-tts-flash","voice":"Cherry"}
   *   {"type":"error","message":"…","partial":true?}   (after chunks = partial audio)
   *   {"type":"ping"}                                   (20 s keepalive — resets
   *                                                      nginx's idle timer, the
   *                                                      same doctrine as the SSE
   *                                                      heartbeat comments)
   * The tts seat override (a /audio/speech mp3 model) yields exactly one chunk
   * line — the client plays it alone, no WAV join. Chunks may arrive out of
   * completion order; the client concatenates/plays by `index`.
   */
  async textToSpeechStream(req: Request, res: Response, next: NextFunction) {
    const { text, voice } = (req.body || {}) as { text?: string; voice?: string };
    if (!text?.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no'); // nginx must forward each line now, not buffer the stream
    res.flushHeaders();
    let wrote = false;
    const write = (line: Record<string, unknown>) => {
      if (res.writableEnded) return false;
      res.write(`${JSON.stringify(line)}\n`);
      wrote = true;
      return true;
    };
    // Keepalive while the vendor synthesizes (a slow first chunk must not hit
    // nginx's 60 s idle ceiling — memory-bank SSE doctrine, NDJSON flavour).
    const keepalive = setInterval(() => { write({ type: 'ping' }); }, 20_000);
    // The listener gone (stop button, navigation): stop paying the vendor for
    // chunks nobody will hear.
    let clientGone = false;
    res.on('close', () => { clientGone = true; });
    try {
      const { synthesizeSpeechProgressively } = await import('./speech');
      const result = await synthesizeSpeechProgressively(
        text,
        voice,
        { dashscopeKey: process.env.DASHSCOPE_API_KEY || '' },
        (part, total) => {
          if (clientGone) return;
          write({ type: 'chunk', index: part.index, total, mimeType: part.mimeType, audio: part.audio.toString('base64') });
        },
      );
      if (!clientGone) {
        write({ type: 'done', delivered: result.delivered, model: result.model, voice: result.voice, mimeType: result.mimeType });
        logger.info(`tts/stream: ${text.length} chars -> ${result.delivered} chunk(s) on ${result.model} (${result.mimeType})`);
      }
    } catch (error: any) {
      const partial = !!(error as Error & { partial?: boolean })?.partial;
      logger.error('TTS stream error:', error.response?.data || error.message);
      if (!wrote && !clientGone) {
        // Nothing was delivered — answer as a normal JSON error so the client
        // can show its toast (headers are already sent as NDJSON; the body line
        // carries the same shape).
        write({ type: 'error', message: error.message || 'Text-to-speech failed' });
      } else if (!clientGone) {
        write({ type: 'error', message: error.message || 'Text-to-speech failed', partial });
      }
    } finally {
      clearInterval(keepalive);
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * POST /api/crossmodel/images/generate
   * Image generation on the Image generator seat (image-generate.ts) — the
   * REST mirror of the generate_image tool (owner 2026-09-24): identical
   * validation, reference resolution, rate slots (8/hour/chat, 40/day/user)
   * and storage — the bytes land in generated_files and are served by
   * GET /generated-files/:id/inline (+ /download). Authed + rejectChild.
   * Body: { prompt, aspect?, style?, polish?, negativePrompt?, referenceUploadId?, referenceFileId?, chatId? }
   * 200 { success, fileId, filename, mimeType, width?, height?, size, model, provider, referenceMode, editLegSource?, latencyMs, inlineUrl, downloadUrl }
   * 400 bad input · 401 · 403 child · 404 reference not found · 413 { error:'quota' }
   * 422 { error:'refused' } · 429 { error:'rate_limited', scope } · 502 provider · 503 { error:'unconfigured' }
   * 503 { error:'owner_unresolved' } — the caller's account could not be resolved
   * (stale/deleted user row), so nothing was persisted; ticket e4d345a9.
   */
  async generateImage(req: Request, res: Response) {
    const t0 = Date.now();
    try {
      const userId = req.user!.id;
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, any>;
      // n is never model-exposed and never accepted here: a second image is a
      // second call, which the caps meter.
      if (body.n !== undefined && body.n !== null && Number(body.n) !== 1) {
        return res.status(400).json({ error: 'n must be 1 — request a second image with a second call.' });
      }
      const te = await import('./tool-executor');
      const parsed = te.validateGenerateImageArgs(body);
      if (!parsed.ok) return res.status(400).json({ error: parsed.message });
      const { prompt, aspect, style, polish, negativePrompt } = parsed.input;

      // Chat attribution follows the tool's rule: only one of the caller's own
      // chats may be named (the Files sidebar filters by chatId).
      let chatId: string | null = null;
      if (body.chatId !== undefined && body.chatId !== null && body.chatId !== '') {
        if (typeof body.chatId !== 'string') return res.status(400).json({ error: 'chatId must be a string' });
        chatId = await new te.ToolCache(userId, null).generatedFileChatId(body.chatId);
        if (!chatId) return res.status(400).json({ error: 'chatId must be one of your own chats' });
      }

      const ref = await te.resolveImageReference(userId, { referenceFileId: body.referenceFileId, referenceUploadId: body.referenceUploadId });
      if (!ref.ok) return res.status(ref.status).json({ error: ref.message });

      // Storage quota pre-flight BEFORE the slots and the paid provider call
      // (review 2026-09-24) — the tool's order exactly; 413 like the post-call
      // byte-accurate refusal in storeGeneratedImage.
      const quotaPre = await te.preflightImageQuota(userId);
      if (quotaPre) return res.status(413).json({ error: 'quota', message: quotaPre });

      // Caps BEFORE the provider call; refunded on any failure below.
      const slots = await te.takeImageGenerationSlots(userId, chatId ?? `rest-${userId}`);
      if (!slots.ok) {
        void te.recordImageGenerationMetric(chatId, 0, { surface: 'rest', ok: false, rateLimited: true, scope: slots.scope, cap: slots.cap, chatId: chatId ?? undefined });
        return res.status(429).json({ error: 'rate_limited', scope: slots.scope, cap: slots.cap, message: slots.message });
      }

      let img: import('./image-generate').GeneratedImage;
      try {
        const { generateImage } = await import('./image-generate');
        img = await generateImage({ prompt, aspect, style, polish, negativePrompt, reference: ref.reference });
      } catch (error: any) {
        await slots.refund();
        const code = typeof error?.code === 'string' ? error.code : 'provider';
        // Scrubbed message only — never the request body, never error.config
        // (axios echoes Authorization + base64 bodies there).
        const details = te.scrubImageSecrets(String(error?.message || 'unknown error')).slice(0, 300);
        logger.error(`generateImage (${code}) failed after ${Date.now() - t0}ms user=${userId}: ${details}`);
        void te.recordImageGenerationMetric(chatId, Date.now() - t0, { surface: 'rest', ok: false, code, chatId: chatId ?? undefined });
        if (code === 'refused') return res.status(422).json({ error: 'refused', message: details });
        if (code === 'unconfigured') return res.status(503).json({ error: 'unconfigured', message: details });
        return res.status(502).json({ error: 'Image generation failed', details, code });
      }

      let stored: { id: string; filename: string };
      try {
        stored = await te.storeGeneratedImage(userId, chatId, img, { prompt, aspect, style });
      } catch (error: any) {
        await slots.refund();
        if (error?.code === 'quota') return res.status(413).json({ error: 'quota', message: String(error.message) });
        // Ticket e4d345a9: same typed containment as the tool seam — an
        // unresolvable owner is a 503 with one honest sentence, never a 500
        // carrying the raw prisma FK text.
        if (error?.code === 'owner_unresolved') return res.status(503).json({ error: 'owner_unresolved', message: String(error.message) });
        throw error;
      }

      const mimeType = te.sniffGeneratedImageMime(img.bytes) ?? img.mimeType;
      void te.recordImageGenerationMetric(chatId, img.latencyMs, {
        surface: 'rest', ok: true, model: img.model, provider: img.provider, spec: img.spec, aspect: aspect ?? 'square',
        referenceMode: img.referenceMode, editLegSource: img.editLegSource, bytes: img.bytes.length, chatId: chatId ?? undefined,
        // 09a03aef: the observable substitution signal — keys present ONLY on
        // a substituted serve (servingSpec != seat spec).
        ...(img.substitutedFor ? { substitutedFor: img.substitutedFor, substitutionReason: img.substitutionReason } : {}),
      });
      logger.info(`generateImage: ${stored.filename} (${mimeType}, ${img.bytes.length} bytes; ${img.model} via ${img.provider}, ${img.latencyMs}ms${img.substitutedFor ? `, SUBSTITUTED for ${img.substitutedFor} (${img.substitutionReason})` : ''}) user=${userId}`);
      res.json({
        success: true,
        fileId: stored.id,
        filename: stored.filename,
        mimeType,
        width: img.width,
        height: img.height,
        size: img.bytes.length,
        model: img.model,
        provider: img.provider,
        referenceMode: img.referenceMode,
        editLegSource: img.editLegSource,
        // 09a03aef: API consumers see the same substitution flag the tool path does.
        substitutedFor: img.substitutedFor,
        substitutionReason: img.substitutionReason,
        latencyMs: img.latencyMs,
        inlineUrl: te.inlineGeneratedPath(stored.id),
        downloadUrl: `/api/crossmodel/generated-files/${stored.id}/download`,
      });
    } catch (error: any) {
      logger.error(`generateImage error: ${error?.message || error}`);
      res.status(500).json({ error: 'Image generation failed' });
    }
  }

  // ── User Feedback ──────────────────────────────────────────────────────────

  /**
   * POST /api/crossmodel/feedback
   * Submit feedback on an AI response (thumbs_down / thumbs_up / report).
   * Works for both authenticated and anonymous users.
   */
  async submitFeedback(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user?.id ?? null;
      const { messageId, chatId, type, reason, comment, modelSet } = req.body as {
        messageId?: string;
        chatId: string;
        type: 'thumbs_down' | 'thumbs_up' | 'report';
        reason?: string;
        comment?: string;
        modelSet?: string;
      };

      // Ownership check: if authenticated, verify the chatId belongs to this user
      if (userId) {
        const chat = await prisma.crossModelChat.findFirst({ where: { id: chatId, userId } });
        if (!chat) {
          return res.status(403).json({ error: 'Forbidden: chat does not belong to this user' });
        }
      }

      // Message link check (ticket bd5b95b5, 2026-10-06 — coding-session answers now carry the feedback row too):
      // message_feedback.messageId is a FOREIGN KEY to crossmodel_messages, so an id that is not a row of THIS chat
      // (a legacy coding_messages id from a not-yet-mirrored session, another chat's row) used to 500 the whole
      // submission. Now such an id is not linked — the feedback still saves (chat-scoped) and the ticket names the
      // id. A lookup error keeps the old behaviour (link as sent). FEEDBACK_MESSAGE_LINK_CHECK_DISABLED=1 restores it.
      let linkedMessageId: string | null = messageId ?? null;
      let unlinkedMessageId: string | null = null;
      if (messageId && process.env.FEEDBACK_MESSAGE_LINK_CHECK_DISABLED !== '1') {
        try {
          const row = await prisma.crossModelMessage.findFirst({ where: { id: messageId, chatId }, select: { id: true } });
          if (!row) {
            linkedMessageId = null;
            unlinkedMessageId = messageId;
          }
        } catch (lookupErr: any) {
          logger.debug(`submitFeedback: message link check skipped (${lookupErr?.message ?? lookupErr})`);
        }
      }

      const feedback = await prisma.messageFeedback.create({
        data: {
          messageId: linkedMessageId,
          chatId,
          userId,
          type,
          reason: reason ?? null,
          comment: comment ?? null,
          modelSet: modelSet ?? null,
        },
      });
      // Compute policy (cp/labels 2026-09-26, design §4 D2 "thumbs+reason"): a
      // thumbs on an answer that carries a compute_policy decision labels it
      // (+ revision_material when the pill read 'updated'). Off the response
      // path — fire-and-forget, never a throw.
      if (linkedMessageId && (type === 'thumbs_up' || type === 'thumbs_down')) {
        void import('./chat-agent/compute-policy-label-hooks')
          .then((m) => m.labelThumbsForMessage({ messageId: linkedMessageId, chatId, type, reason: reason ?? null, sessionId: chatId }))
          .catch(() => {});
      }

      // Also create a user_feature_requests entry so in-chat feedback appears
      // in the user's Feedback tab (Account → Feedback). Only for authenticated
      // users with negative feedback (thumbs_down / report).
      let featureRequestId: string | null = null;
      if (userId && (type === 'thumbs_down' || type === 'report')) {
        try {
          const reasonLabels: Record<string, string> = {
            wrong:       'Wrong answer',
            incomplete:  'Incomplete response',
            slow:        'Too slow',
            formatting:  'Formatting issue',
            harmful:     'Harmful content',
            other:       'Other issue',
          };
          const reasonLabel = reason ? (reasonLabels[reason] || reason) : 'AI response issue';
          const frType = (reason === 'wrong' || reason === 'harmful' || type === 'report')
            ? 'bug_report'
            : 'general_feedback';
          const frTitle = `In-chat feedback: ${reasonLabel}`;
          const descParts: string[] = [];
          if (comment?.trim()) descParts.push(comment.trim());
          if (reason) descParts.push(`Reason: ${reasonLabel}`);
          if (modelSet) descParts.push(`Model set: ${modelSet}`);
          descParts.push(`Chat ID: ${chatId}`);
          if (unlinkedMessageId) descParts.push(`Message ID: ${unlinkedMessageId} (not a message row of this chat — feedback saved unlinked)`);
          const frDescription = descParts.join('\n');

          const featureRequest = await prisma.userFeatureRequest.create({
            data: {
              userId,
              type: frType,
              title: frTitle,
              description: frDescription,
            },
          });
          featureRequestId = featureRequest.id;
          logger.info(`In-chat feedback also created feature request ${featureRequest.id} for visibility in Feedback tab`);
        } catch (frError: any) {
          // Non-critical — the message_feedback was already saved
          logger.warn(`Failed to create feature request from in-chat feedback: ${frError.message}`);
        }
      }

      logger.info(`Feedback submitted: ${type} on chat ${chatId} by ${userId || 'anonymous'}`);
      res.json({ success: true, id: feedback.id, featureRequestId });
    } catch (error: any) {
      logger.error('submitFeedback error:', error.message);
      res.status(500).json({ error: 'Failed to submit feedback' });
    }
  }

  // ── Feature Requests ──────────────────────────────────────────────────────

  /**
   * POST /api/crossmodel/feature-request
   * Submit a feature request, bug report, or general feedback.
   * Body: { type, title, description }
   * type is validated against the SHARED FEEDBACK_TYPES (feedback service) so
   * users can file the agent-loop categories (mishap/enhancement/research_idea) too.
   */
  async submitFeatureRequest(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { type, title, description } = req.body as {
        type: string;
        title: string;
        description: string;
      };

      if (!(FEEDBACK_TYPES as readonly string[]).includes(type)) {
        return res.status(400).json({ error: `type must be one of: ${FEEDBACK_TYPES.join(', ')}` });
      }
      if (!title?.trim()) {
        return res.status(400).json({ error: 'title is required' });
      }
      if (!description?.trim()) {
        return res.status(400).json({ error: 'description is required' });
      }

      const request = await prisma.userFeatureRequest.create({
        data: {
          userId,
          type,
          title: title.trim(),
          description: description.trim(),
        },
      });

      logger.info(`Feature request submitted: type=${type}, userId=${userId}`);

      // Live ticket hook (Phase 4): route USER-filed tickets into the platform
      // engineer lane (a coding-session chat) so they get worked continuously.
      // Fire-and-forget — a dispatch hiccup must never fail the user's filing;
      // the service is env-gated and never throws. Dynamic import keeps the
      // controller's static import graph untouched.
      void import('./feedback/ticket-dispatch.service')
        .then((m) => Promise.all([
          m.dispatchTicketToLane(request),
          // Burn-down drain (2026-08-22): every filing also batches the open
          // backlog into the lane (the new ticket is dedupe-skipped there).
          m.drainOpenTicketsToLane(),
        ]))
        .catch(() => {});

      res.status(201).json({ success: true, data: request });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/crossmodel/feature-requests/:id/resolve
   * Lets the authenticated user mark their own submission as "done".
   * Only the owner can resolve their own ticket.
   */
  async resolveOwnFeatureRequest(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;

      // Verify the ticket belongs to this user
      const existing = await prisma.userFeatureRequest.findFirst({
        where: { id, userId },
      });

      if (!existing) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      // A harness ticket is not the user's submission (audit 2026-10-08 W5-1b) — invisible, so not resolvable either.
      const { hiddenFromSubjectTab } = await import('./feedback/harness-ticket');
      if (hiddenFromSubjectTab(existing, (req as any).user?.role === 'ADMIN')) {
        return res.status(404).json({ error: 'Submission not found' });
      }

      if (existing.status === 'done') {
        return res.json({ success: true, data: existing });
      }

      const updated = await prisma.userFeatureRequest.update({
        where: { id },
        data: {
          status: 'done',
          adminNote: existing.adminNote && !existing.adminNote.includes('kanban_task:')
            ? existing.adminNote
            : 'Marked as resolved by user.',
        },
      });

      logger.info(`User ${userId} resolved their own feature request ${id}`);
      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/feature-requests
   * Returns the authenticated user's own feature requests, newest first.
   * Cleans up generic/internal adminNotes before returning to the user.
   */
  async getFeatureRequests(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;

      // Fetch a generous page (was take:50 — a user with 300+ tickets saw their
      // history vanish past the newest 50, and per-tab counts reflected only
      // that slice, which read as 'older tickets are gone'; owner report
      // 2026-08-23). Counts below are computed across ALL the user's tickets so
      // the tab numbers are always the true totals regardless of the page size.
      const allRequests = await prisma.userFeatureRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      // Exact per-status + per-source totals across the user's whole history.
      const [byStatus, bySource] = await Promise.all([
        prisma.userFeatureRequest.groupBy({ by: ['status'], where: { userId }, _count: { _all: true } }),
        prisma.userFeatureRequest.groupBy({ by: ['source'], where: { userId }, _count: { _all: true } }),
      ]).catch(() => [[], []] as any);
      // HARNESS tickets (a detector-stamped mishap / verifier / class row the
      // framework filed ABOUT a run on this account) are internal framework
      // records — a non-admin never sees them in their own tab (audit
      // 2026-10-08 W5-1b: an external account saw the "Phantom action claim …"
      // ticket the verifier filed about their chat). The totals subtract the
      // hidden rows (one bounded agent-row read — groupBy cannot read the JSON
      // stamp). Kill switch FEEDBACK_HARNESS_HIDE_FROM_SUBJECT_DISABLED=1.
      const { hiddenFromSubjectTab, harnessHideFromSubjectDisabled } = await import('./feedback/harness-ticket');
      const requesterIsAdmin = (req as any).user?.role === 'ADMIN';
      const requests = allRequests.filter((r) => !hiddenFromSubjectTab(r, requesterIsAdmin));
      let hiddenRows: Array<{ status: string; source: string }> = [];
      if (!requesterIsAdmin && !harnessHideFromSubjectDisabled()) {
        const agentRows = await prisma.userFeatureRequest.findMany({
          where: { userId, source: 'agent' },
          select: { status: true, source: true, context: true },
          take: 5000,
        }).catch(() => [] as any[]);
        hiddenRows = (agentRows as any[]).filter((r) => hiddenFromSubjectTab(r, false));
      }
      const counts = {
        total: 0,
        open: 0, in_progress: 0, done: 0, resolved: 0,
        bySource: { user: 0, agent: 0 } as Record<string, number>,
      };
      for (const g of byStatus as any[]) {
        // A legacy closed spelling ('resolved') counts as done (ticket-status.ts,
        // audit T8) — the `resolved` key stays for old clients and reads 0.
        const key = normalizeTicketStatus(g.status);
        (counts as any)[key] = ((counts as any)[key] ?? 0) + g._count._all;
        counts.total += g._count._all;
      }
      for (const g of bySource as any[]) counts.bySource[g.source] = g._count._all;
      for (const h of hiddenRows) {
        const key = normalizeTicketStatus(h.status);
        (counts as any)[key] = Math.max(0, ((counts as any)[key] ?? 0) - 1);
        counts.total = Math.max(0, counts.total - 1);
        counts.bySource[h.source] = Math.max(0, (counts.bySource[h.source] ?? 0) - 1);
      }

      // Clean up adminNotes for user-facing display:
      // - Replace old generic "Digby Kanban autopilot" notes with friendlier versions
      // - Strip internal metadata (kanban_task:, retries:, etc.)
      const cleaned = requests.map(r => {
        let note = r.adminNote || '';

        // Strip internal-only notes entirely
        if (/^kanban_task:/.test(note) || /^retries:\d+$/.test(note.trim()) || note.startsWith('Awaiting clarification')) {
          note = '';
        }

        // Replace old generic autopilot notes with a friendlier summary
        if (/^(Fixed|Implemented|Addressed) by Digby Kanban autopilot on \d{4}-\d{2}-\d{2}\.\s*(Changes committed and deployed|Feature deployed|Your feedback.*has been reviewed)/.test(note)) {
          const title = r.title || '';
          if (r.type === 'bug_report') {
            note = `Fixed! "${title}" has been corrected and deployed. Refresh the page to see the changes.`;
          } else if (r.type === 'feature_request') {
            note = `Done! "${title}" has been built and deployed. It should be live now — try it out!`;
          } else {
            note = `Thanks for the feedback! "${title}" has been reviewed and changes have been deployed.`;
          }
        }

        // Lift the dedup occurrence count so the UI can badge recurring
        // tickets (agent filings merge repeat sightings into one row —
        // feedback.service bumpDedupedTicket). Same convention as the admin
        // listFeedback mapper.
        const ctx = (r.context ?? {}) as Record<string, unknown>;
        const occurrences = typeof ctx.occurrences === 'number' ? ctx.occurrences : 1;

        // A legacy closed spelling reads as 'done' so the Feedback tab's
        // open / active / done filters show the row (audit T8).
        return { ...r, status: normalizeTicketStatus(r.status), adminNote: note, occurrences };
      });

      // Backward compatible: `data` stays the array old clients read; `counts`
      // + `truncated` are additive so the UI can show true totals and a
      // 'showing newest N' note when a user has more than the page size.
      res.json({ success: true, data: cleaned, counts, truncated: counts.total > requests.length });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/admin/feature-requests
   * Returns ALL feature requests across all users (admin only).
   * Supports ?status=open|in_progress|queued|done&type=bug_report|feature_request|general_feedback
   */
  async adminListFeatureRequests(req: Request, res: Response, next: NextFunction) {
    try {
      if ((req as any).user?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Forbidden: admin access required' });
      }

      const { status, type, limit = '100' } = req.query as Record<string, string>;

      const requests = await prisma.userFeatureRequest.findMany({
        where: {
          ...(status ? { status } : {}),
          ...(type   ? { type   } : {}),
        },
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
        // NOTE: no status in orderBy — alphabetical enum order is 'done' <
        // 'in_progress' < 'open', the opposite of the intended open-first
        // grouping (same bug fixed in feedback.service listFeedbackTickets,
        // ticket a1ca6bfc). Open-first is applied via the explicit rank below.
        orderBy: [
          { priority:  'desc' },
          { createdAt: 'desc' },
        ],
        take: Math.min(parseInt(limit) || 100, 500),
      });
      // Rank + read via the shared vocabulary (ticket-status.ts, audit T8): a
      // legacy 'resolved' row ranks and reads as done.
      requests.sort((a, b) => ticketStatusRank(a.status) - ticketStatusRank(b.status));
      const data = requests.map((r) => ({ ...r, status: normalizeTicketStatus(r.status) }));

      res.json({ success: true, data, total: data.length });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/crossmodel/admin/feature-requests/:id
   * Update status and/or adminNote on a feature request (admin only).
   * Body: { status?: 'open'|'in_progress'|'done', adminNote?: string }
   */
  async adminUpdateFeatureRequest(req: Request, res: Response, next: NextFunction) {
    try {
      if ((req as any).user?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Forbidden: admin access required' });
      }

      const { id } = req.params;
      const { status, adminNote, priority, dependsOnTicketIds } = req.body as {
        status?: string;
        adminNote?: string;
        priority?: number;
        dependsOnTicketIds?: string[] | null;
      };

      const validStatuses = ['open', 'in_progress', 'queued', 'done'];
      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Must be open, in_progress, queued, or done.' });
      }

      // ── Ticket dependencies (9dacab1a) ──
      // The admin REST path is the HUMAN writer for dependsOnTicketIds: an
      // owner gates one ticket on another (same validation as the tool path —
      // unknown blocker 404, self-reference 400, cycle 409). The validated
      // list lands in the row's context Json (the ticket-side home for
      // dispatch state — dispatchedTo / family / verification live there).
      //
      // ROUND-1 REVIEW (F7/F8/F9): the branch no longer early-returns on
      // success — deps + status/adminNote/priority apply in ONE update; the
      // context write is optimistic-concurrency-guarded (expectContext, one
      // fresh-read retry, then a clean 409); and a DISPATCHED row is refused
      // (reason dispatched_elsewhere) before any validation, mirroring the
      // tool path — a live lane's row is its lane's, deps or no deps.
      if (dependsOnTicketIds !== undefined) {
        const { setTicketDependencies } = await import('./feedback/ticket-priority');
        const { getFeedbackTicketById } = await import('./feedback/feedback.service');
        const loadTicket = async (depId: string) => {
          const r = await getFeedbackTicketById(depId).catch(() => null);
          return r && r.ok ? (r.ticket as any) : null;
        };
        // F9: refuse a dispatched row first — deps gate UNdispatched tickets
        // only (the drain's reclaim paths own dispatched rows; gating a live
        // row would strand it behind its own blockers).
        const selfRow = await prisma.userFeatureRequest.findUnique({ where: { id }, select: { id: true, context: true } });
        if (selfRow) {
          const selfCtx = (selfRow.context ?? {}) as Record<string, unknown>;
          const selfDispatchedTo = typeof selfCtx.dispatchedTo === 'string' ? selfCtx.dispatchedTo.trim() : '';
          if (selfDispatchedTo) {
            return res.status(409).json({ error: `Ticket ${id} is dispatched to a lane (${selfDispatchedTo.slice(0, 8)}) — dependencies gate tickets that are NOT on a lane. Wait for the lane to finish (or close/stall), then gate it.` });
          }
        }
        const verdict = await setTicketDependencies(id, dependsOnTicketIds, loadTicket);
        if (!verdict.ok) {
          return res.status(verdict.status).json({ error: verdict.error });
        }
        const nextList = verdict.dependsOnTicketIds;
        const prevCtx = (selfRow?.context ?? {}) as Record<string, unknown>;
        const nextCtx: Record<string, unknown> = nextList.length
          ? { ...prevCtx, dependsOnTicketIds: nextList }
          : (() => { const { dependsOnTicketIds: _drop, ...rest } = prevCtx; return rest; })();
        // F8: guard the context write on the context this handler read. ONE
        // fresh-read retry on a conflict; a second miss is a real race — 409.
        const applyDeps = async (ctxToWrite: Record<string, unknown>, expect: unknown): Promise<boolean> => {
          // Prisma on this stack (client 7.x + PrismaPg driver adapter): a
          // SQL-NULL context matches NEITHER `equals: {}` NOR `equals: null`
          // inside one filter — only `equals: Prisma.AnyNull` does (verified
          // against a real Postgres, ticket 696d4346, 2026-10-28; the
          // guarded write in feedback.service updateFeedbackTicket carries
          // the same fix with the full evidence note).
          const expectCtx = (expect && typeof expect === 'object' && !Array.isArray(expect))
            ? expect as Record<string, unknown> : {};
          const guarded = Object.keys(expectCtx).length === 0
            ? { id, OR: [{ context: { equals: {} as any } }, { context: { equals: Prisma.AnyNull } }] }
            : { id, context: { equals: expectCtx as any } };
          const res2 = await prisma.userFeatureRequest.updateMany({
            where: guarded as any,
            data: {
              context: ctxToWrite as any,
              ...(status !== undefined ? { status } : {}),
              ...(adminNote !== undefined ? { adminNote } : {}),
              ...(priority !== undefined ? { priority } : {}),
            },
          });
          return res2.count > 0;
        };
        let landed = await applyDeps(nextCtx, prevCtx);
        if (!landed) {
          const freshRow = await prisma.userFeatureRequest.findUnique({ where: { id }, select: { context: true } });
          const freshCtx = (freshRow?.context ?? {}) as Record<string, unknown>;
          // ROUND-2 B2 (ticket 19e0c050): re-run the dispatched gate against
          // the FRESH context before the retry — between the first read and
          // this one the dispatcher may have stamped dispatchedTo (the
          // concurrent write is exactly what makes the guard miss). Retrying
          // blind would write deps onto a row a lane now owns. Refuse;
          // nothing was mutated.
          const freshDispatchedTo = typeof freshCtx.dispatchedTo === 'string' ? freshCtx.dispatchedTo.trim() : '';
          if (freshDispatchedTo) {
            return res.status(409).json({ error: `Ticket ${id} was dispatched to a lane (${freshDispatchedTo.slice(0, 8)}) while the dependencies were being written — the write was abandoned and nothing was mutated. Dependencies gate tickets that are NOT on a lane; wait for the lane to finish (or close/stall), then gate it.` });
          }
          const retryCtx: Record<string, unknown> = nextList.length
            ? { ...freshCtx, dependsOnTicketIds: nextList }
            : (() => { const { dependsOnTicketIds: _drop, ...rest } = freshCtx; return rest; })();
          landed = await applyDeps(retryCtx, freshCtx);
          if (!landed) {
            return res.status(409).json({ error: 'The ticket changed while the dependencies were being written — reload it and retry.' });
          }
        }
        logger.info(`Admin set ticket ${id} dependencies: ${nextList.length ? nextList.map((x: string) => x.slice(0, 8)).join(', ') : '(cleared)'}`);
        // The updated row (deps + any sibling fields) for the UI.
        const updated = await prisma.userFeatureRequest.findUnique({ where: { id } });
        return res.json({ success: true, data: { ...updated, dependsOnTicketIds: nextList } });
      }

      const updated = await prisma.userFeatureRequest.update({
        where: { id },
        data: {
          ...(status    !== undefined && { status }),
          ...(adminNote !== undefined && { adminNote }),
          ...(priority  !== undefined && { priority }),
        },
      });

      logger.info(`Admin updated feature request ${id}: status=${status}, hasNote=${!!adminNote}`);
      res.json({ success: true, data: updated });
    } catch (error: any) {
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Feature request not found' });
      }
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/admin/feature-requests/held
   * The tickets the owner-only ticket-lane rule HOLDS (another account's, no
   * admin approval yet) — Account → Admin → Feedback (audit 2026-10-08 W5-1a).
   */
  async adminListHeldFeatureRequests(req: Request, res: Response, next: NextFunction) {
    try {
      if ((req as any).user?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Forbidden: admin access required' });
      }
      const { listHeldTickets } = await import('./feedback/ticket-dispatch.service');
      const { ownerResolved, degraded, error: listError, tickets } = await listHeldTickets();
      res.json({ success: true, data: tickets, ownerResolved, degraded, error: listError, total: tickets.length });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/crossmodel/admin/feature-requests/:id/approve-dispatch
   * Body: { approved?: boolean } (default true; false revokes). An admin
   * approves a HELD ticket for an auto-merging ticket lane — sets
   * context.dispatchApproved (+ by / at), audited (audit 2026-10-08 W5-1a).
   */
  async adminApproveFeatureRequestDispatch(req: Request, res: Response, next: NextFunction) {
    try {
      if ((req as any).user?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Forbidden: admin access required' });
      }
      const { approveTicketForLane } = await import('./feedback/ticket-dispatch.service');
      const approved = (req.body as { approved?: unknown } | undefined)?.approved !== false;
      const r = await approveTicketForLane({ ticketId: String(req.params.id ?? ''), adminUserId: req.user!.id, approved });
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      res.json({ success: true, data: r.ticket, changed: r.changed });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/crossmodel/admin/feedback/:id/resolve
   * Mark a MessageFeedback item as resolved (admin only).
   * Body: { resolved: boolean }
   */
  async adminResolveFeedback(req: Request, res: Response, next: NextFunction) {
    try {
      if ((req as any).user?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Forbidden: admin access required' });
      }

      const { id } = req.params;
      const { resolved = true } = req.body as { resolved?: boolean };

      const updated = await prisma.messageFeedback.update({
        where: { id },
        data: { resolved: Boolean(resolved) },
      });

      logger.info(`Admin ${resolved ? 'resolved' : 'reopened'} feedback ${id}`);
      res.json({ success: true, data: updated });
    } catch (error: any) {
      if (error.code === 'P2025') {
        return res.status(404).json({ error: 'Feedback item not found' });
      }
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/feedback/summary
   * Returns aggregate feedback data for the autopilot to read.
   * Counts by type/reason + recent unresolved comments.
   */
  async getFeedbackSummary(req: Request, res: Response, next: NextFunction) {
    try {
      // Admin-only endpoint — reject non-admin users
      // NOTE: Prisma Role enum is 'ADMIN' (uppercase) — match exactly
      if ((req as any).user?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Forbidden: admin access required' });
      }

      const [byType, byReason, recent] = await Promise.all([
        // Count by type (last 30 days)
        prisma.messageFeedback.groupBy({
          by: ['type'],
          _count: { type: true },
          where: { createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
        }),

        // Count by reason (last 30 days, non-null reasons)
        prisma.messageFeedback.groupBy({
          by: ['reason'],
          _count: { reason: true },
          where: {
            reason: { not: null },
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
          orderBy: { _count: { reason: 'desc' } },
          take: 10,
        }),

        // Most recent unresolved items with comments
        prisma.messageFeedback.findMany({
          where: {
            resolved: false,
            type: { in: ['thumbs_down', 'report'] },
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            type: true,
            reason: true,
            comment: true,
            modelSet: true,
            chatId: true,
            createdAt: true,
          },
        }),
      ]);

      res.json({
        success: true,
        summary: {
          byType: byType.reduce((acc, r) => ({ ...acc, [r.type]: r._count.type }), {} as Record<string, number>),
          byReason: byReason.reduce((acc, r) => r.reason ? { ...acc, [r.reason]: r._count.reason } : acc, {} as Record<string, number>),
          total: byType.reduce((sum, r) => sum + r._count.type, 0),
          recentUnresolved: recent,
        },
      });
    } catch (error: any) {
      logger.error('getFeedbackSummary error:', error.message);
      res.status(500).json({ error: 'Failed to get feedback summary' });
    }
  }

  // ── Deep Research Quota (for authenticated users) ─────────────────────────

  /**
   * GET /api/crossmodel/deep-research/quota
   * Returns the user's remaining deep_research quota for today.
   */
  async getDeepResearchQuota(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) {
        return res.json({ success: true, data: { used: 0, limit: 0, remaining: 0, authenticated: false } });
      }
      const quota = await checkDeepResearchQuota(userId);
      // Depth UX (2026-09-26, audit sse-ui-restore-14): the patience_auto_only
      // switch reaches Account → Advanced as `autoOnly` — while it is on the
      // presets are honest only as paused (every explicit preset is routed as
      // Auto in streamQuery). A reader failure reads as off (fail open).
      let autoOnly = false;
      try { autoOnly = await getPatienceAutoOnly(); } catch { autoOnly = false; }
      return res.json({
        success: true,
        data: { ...quota, authenticated: true, autoOnly },
      });
    } catch (error: any) {
      logger.error('getDeepResearchQuota error:', error.message);
      return res.status(500).json({ error: 'Failed to get quota' });
    }
  }

  // ── Admin: System Settings ────────────────────────────────────────────────

  /**
   * GET /api/crossmodel/admin/settings
   * Returns all SystemSettings (admin only).
   */
  async getAdminSettings(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }

    try {
      const settings = await prisma.systemSetting.findMany();
      const result: Record<string, string> = {};
      for (const s of settings) {
        result[s.key] = s.value;
      }
      return res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('getAdminSettings error:', error.message);
      return res.status(500).json({ error: 'Failed to get settings' });
    }
  }

  /**
   * PUT /api/crossmodel/admin/settings/:key
   * Updates a single SystemSetting value (admin only).
   * Body: { value: string }
   */
  async updateAdminSetting(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }

    try {
      const { key } = req.params;
      const { value } = req.body as { value: string };

      if (value === undefined || value === null) {
        return res.status(400).json({ error: 'value is required' });
      }

      // Supervisor OFF switch (owner 2026-09-26): `fleet_supervisor_enabled` /
      // `project_supervisors_enabled` accept ONLY 1|0|true|false|on|off, are
      // idempotent (an unchanged value writes nothing, so `since` stays the
      // real flip time), stamp the `<key>_by` audit row with the admin's
      // identity, invalidate the 60 s cache, reset the skipped-wake counter and
      // write the {action:'flipped'} telemetry row — all inside
      // setSupervisorSwitch. The response carries the fresh state.
      if (isSupervisorSwitchKey(key)) {
        const parsed = parseSwitchValue(value);
        if (parsed === null) {
          return res.status(400).json({ error: `value must be one of 1|0|true|false|on|off for ${key}` });
        }
        const flip = await setSupervisorSwitch(key, parsed, String(user?.email || user?.id || 'admin'));
        if (flip.changed) logger.info(`Admin updated setting: ${key}=${parsed ? '1' : '0'} (by ${user?.email ?? user?.id})`);
        const state = await getSupervisorSwitchState();
        return res.json({ success: true, data: flip.setting ?? { key, value: parsed ? '1' : '0' }, changed: flip.changed, state });
      }

      // Always-Auto switch (patience plan; audited since the 2026-09-26 audit):
      // the same contract as the supervisor switches — 1|0|true|false|on|off
      // only, idempotent (an unchanged value writes nothing, so `since` stays
      // the real flip time), `patience_auto_only_by` stamped with the admin's
      // identity, the 60 s cache invalidated; the response carries the state.
      if (key === PATIENCE_AUTO_ONLY_KEY) {
        const parsed = parsePatienceSwitchValue(value);
        if (parsed === null) {
          return res.status(400).json({ error: `value must be one of 1|0|true|false|on|off for ${key}` });
        }
        const flip = await setPatienceAutoOnly(parsed, String(user?.email || user?.id || 'admin'));
        if (flip.changed) logger.info(`Admin updated setting: ${key}=${parsed ? '1' : '0'} (by ${user?.email ?? user?.id})`);
        const state = await getPatienceAutoOnlyState();
        return res.json({ success: true, data: flip.setting ?? { key, value: parsed ? '1' : '0' }, changed: flip.changed, state });
      }

      const setting = await prisma.systemSetting.upsert({
        where: { key },
        update: { value: String(value) },
        create: { key, value: String(value) },
      });

      // Invalidate in-memory cache for rate limit settings
      if (key === 'deep_research_daily_limit') {
        invalidateLimitCache();
      }
      // Rollout self-governance (2026-09-27): the automaton's switch read through
      // the generic path drops its 60 s cache too (PUT /admin/model-roles/decision-rollout is the audited path).
      if (key === 'decision_gate_auto_rollout') {
        try { (await import('./platform/decision-gate-rollout')).invalidateRolloutSettingCache(); } catch { /* fail-open */ }
      }

      // The generic path names the admin too (audit 2026-09-26: the 20:35Z
      // flip's log line carried no identity, and the container is gone).
      logger.info(`Admin updated setting: ${key}=${value} (by ${user?.email ?? user?.id ?? 'admin'})`);
      return res.json({ success: true, data: setting });
    } catch (error: any) {
      logger.error('updateAdminSetting error:', error.message);
      return res.status(500).json({ error: 'Failed to update setting' });
    }
  }

  /**
   * GET /api/crossmodel/admin/web-search-config
   * The web-search provider status (admin only — Admin → Settings → Web
   * search, ticket 6f4d42f2): what the search backend resolves RIGHT NOW
   * (source 'env' | 'store' | null), the stored key's masked preview (the key
   * itself is NEVER returned), zone, enabled, env-precedence, updatedBy/At.
   */
  async getWebSearchConfig(req: Request, res: Response) {
    const user = (req as any).user;
    if (user?.role !== 'ADMIN' && user?.email !== 'example-user@example.com') {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    try {
      const status = await getWebSearchConfigStatus();
      return res.json({ success: true, data: status });
    } catch (error: any) {
      logger.error('getWebSearchConfig error:', error.message);
      return res.status(500).json({ error: 'Failed to read web-search config' });
    }
  }

  /**
   * PUT /api/crossmodel/admin/web-search-config
   * Save the Bright Data key/zone (admin only, ticket 6f4d42f2). Body:
   * { apiKey?, zone?, enabled?, clear? } — apiKey is required the first time;
   * a save NEVER echoes the key back (the response is the status with a masked
   * preview). Validation errors map to 400 with the operator-actionable text.
   */
  async updateWebSearchConfig(req: Request, res: Response) {
    const user = (req as any).user;
    if (user?.role !== 'ADMIN' && user?.email !== 'example-user@example.com') {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    try {
      const body = req.body as { apiKey?: string; zone?: string; enabled?: boolean; clear?: boolean };
      const status = await saveWebSearchConfig(
        {
          ...(body.apiKey !== undefined ? { apiKey: String(body.apiKey) } : {}),
          ...(body.zone !== undefined ? { zone: String(body.zone) } : {}),
          ...(body.enabled !== undefined ? { enabled: !!body.enabled } : {}),
          ...(body.clear !== undefined ? { clear: !!body.clear } : {}),
        },
        String(user?.email || user?.id || 'admin'),
      );
      return res.json({ success: true, data: status });
    } catch (error: any) {
      // Validation failures carry operator-actionable text — surface it.
      if (error instanceof Error && error.message) {
        return res.status(400).json({ error: error.message });
      }
      logger.error('updateWebSearchConfig error:', error?.message || error);
      return res.status(500).json({ error: 'Failed to save web-search config' });
    }
  }

  /**
   * GET /api/crossmodel/admin/settings/patience
   * The Always-Auto switch (`patience_auto_only`) with `enabled`, `since` (the
   * row's last write), `updatedBy` (the `patience_auto_only_by` audit row —
   * null for the unattributed 2026-09-26 20:35Z prod flip), `source`
   * ('setting' = store row in force, 'env' = boot default), `bootDefault` and
   * the harness status `line`. Admin only. Flip with
   * PUT /admin/settings/patience_auto_only, body { value: '0' | '1' }.
   */
  async getAdminPatienceSettings(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    try {
      const state = await getPatienceAutoOnlyState();
      return res.json({ success: true, data: state });
    } catch (error: any) {
      logger.error('getAdminPatienceSettings error:', error?.message ?? error);
      return res.status(500).json({ error: 'Failed to get the patience switch' });
    }
  }

  /**
   * GET /api/crossmodel/admin/settings/supervisors
   * The two supervisor OFF switches (owner 2026-09-26) with `since` (the last
   * flip write), `updatedBy` (the admin who flipped it), `skipped` (machine
   * wakes skipped since the flip) and the harness-composed status `line`.
   * Admin only. Flip with PUT /admin/settings/fleet_supervisor_enabled or
   * /admin/settings/project_supervisors_enabled, body { value: '0' | '1' }.
   */
  async getAdminSupervisorSettings(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    try {
      const state = await getSupervisorSwitchState();
      return res.json({ success: true, data: state });
    } catch (error: any) {
      logger.error('getAdminSupervisorSettings error:', error.message);
      return res.status(500).json({ error: 'Failed to get supervisor settings' });
    }
  }

  /**
   * POST /api/crossmodel/admin/prompts/rescaffold — layered prompts
   * (2026-09-27): re-scaffold every stored supervisor prompt + stock sweep
   * body from each project's own brief (platform/prompt-migrate.ts). Admin
   * only; `dryRun: true` reports without writing. The per-wake path (ensure /
   * the watchdog heal) converges the same rows one lane at a time — this is
   * the whole-account sweep for the day the layering ships.
   */
  async rescaffoldPrompts(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    try {
      const body = (req.body ?? {}) as { userId?: unknown; dryRun?: unknown; sweeps?: unknown; limit?: unknown };
      const { migrateSupervisorPrompts } = await import('./platform/prompt-migrate');
      const report = await migrateSupervisorPrompts({
        userId: typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : null,
        dryRun: body.dryRun === true || body.dryRun === 'true',
        sweeps: body.sweeps !== false && body.sweeps !== 'false',
        limit: typeof body.limit === 'number' ? body.limit : undefined,
      });
      return res.json({ success: true, data: report });
    } catch (error: any) {
      logger.error('rescaffoldPrompts error:', error.message);
      return res.status(500).json({ error: 'Failed to re-scaffold supervisor prompts' });
    }
  }

  /**
   * GET /api/crossmodel/admin/settings/patience-auto-only
   * The always-Auto switch with `since` (the last flip write) and `updatedBy`
   * (the admin who flipped it; null for the pre-audit 2026-09-26 20:35Z row).
   * Admin only. Flip with PUT /admin/settings/patience_auto_only { value: '0'|'1' }.
   */
  async getAdminPatienceAutoOnly(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    try {
      const state = await getPatienceAutoOnlyState();
      return res.json({ success: true, data: state });
    } catch (error: any) {
      logger.error('getAdminPatienceAutoOnly error:', error.message);
      return res.status(500).json({ error: 'Failed to get the always-Auto switch' });
    }
  }

  /**
   * GET /api/crossmodel/depth/policy
   * The user-facing depth policy: `autoOnly` true = every human send is routed
   * as Auto right now (an Account → Advanced preset is recorded as the
   * requested depth but does not pick the run). Signed-in only (the app-level
   * guard). No admin facts leak here — just the flag the Advanced tab needs to
   * be honest. Never 500s on a reader failure: the flag fails open to false.
   */
  async getDepthPolicy(_req: Request, res: Response) {
    const policy = await getDepthPolicyPublic();
    return res.json({ success: true, data: policy });
  }

  /**
   * GET /api/crossmodel/admin/deep-research-usage
   * Returns today's deep_research usage across all users (admin only).
   * Enriches with user email from the database.
   */
  async getAdminDeepResearchUsage(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }

    try {
      const usageData = await getAllDeepResearchUsageToday();
      const limit = await getDeepResearchDailyLimit();

      // Enrich with user emails
      const userIds = usageData.map(u => u.userId);
      const users = userIds.length > 0
        ? await prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true, name: true },
          })
        : [];
      const userMap = new Map(users.map(u => [u.id, u]));

      const enriched = usageData.map(u => ({
        userId: u.userId,
        email: userMap.get(u.userId)?.email || 'unknown',
        name: userMap.get(u.userId)?.name || null,
        count: u.count,
      }));

      return res.json({
        success: true,
        data: {
          limit,
          usage: enriched,
          date: new Date().toISOString().slice(0, 10),
        },
      });
    } catch (error: any) {
      logger.error('getAdminDeepResearchUsage error:', error.message);
      return res.status(500).json({ error: 'Failed to get usage data' });
    }
  }

  // ── Admin: Clarification Requests ────────────────────────────────────────

  /**
   * GET /api/crossmodel/admin/stats
   * Returns high-level admin stats: total users, chats, signups today/7d/30d, open tickets.
   * Admin only (example-user@example.com or ADMIN role).
   */
  async getAdminStats(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }

    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOf7d  = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
      const startOf30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const [totalUsers, totalChats, newUsersToday, newUsers7d, newUsers30d, openTickets] = await Promise.all([
        prisma.user.count(),
        prisma.crossModelChat.count(),
        prisma.user.count({ where: { createdAt: { gte: startOfDay } } }),
        prisma.user.count({ where: { createdAt: { gte: startOf7d  } } }),
        prisma.user.count({ where: { createdAt: { gte: startOf30d } } }),
        prisma.userFeatureRequest.count({ where: { status: 'open' } }),
      ]);

      return res.json({
        success: true,
        data: { totalUsers, totalChats, newUsersToday, newUsers7d, newUsers30d, openTickets },
      });
    } catch (error: any) {
      logger.error('getAdminStats error:', error.message);
      return res.status(500).json({ error: 'Failed to get stats' });
    }
  }

  /**
   * GET /api/crossmodel/admin/users
   * Returns all users with role, status, chat count, message count, last active.
   * Admin only (example-user@example.com or ADMIN role).
   */
  async getAdminUsers(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    try {
      const users = await prisma.user.findMany({
        select: {
          id: true, email: true, name: true, role: true,
          isActive: true, createdAt: true, updatedAt: true,
          _count: { select: { crossModelChats: true, featureRequests: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      // lastActive — HUMAN-shaped activity, not machine traffic (ticket feae4828).
      // The old shape was MAX(crossmodel_chats.updatedAt) over ALL chats, which
      // scheduled/hook/agent runs bump constantly (supervisor lanes idle-
      // heartbeats alone): prod probe 2026-10-26 showed 15/21 users "active
      // <24h" when the human truth was 4/21, worst overstatement ~30 days, all
      // driven by supervisor-chat updatedAt. Align with the Traffic tab's
      // trafficUsers last_active (visitor-analytics.service.ts): the user's
      // last HUMAN message (role='user' + metadata.origin absent or 'user'),
      // else the latest human-shaped chat row (non-supervisor, non-project-
      // supervisor, not a spawned sub-session), floored by createdAt so a
      // never-active user shows their join date (lastActive is therefore never
      // null now — the frontend's `—` branch is dead but harmless).
      // Known residual (same as the Traffic tab, by alignment): parentless
      // machine-spawned lanes (ticket/batch/family coding sessions carry no
      // parentChatId) and late machine writes on a human chat can still bump
      // the chat leg — bounded overstatement, machine WAKES on supervisor
      // lanes (the reported symptom) no longer count at all.
      const msgCounts = await prisma.$queryRaw<Array<{
        userId: string; messageCount: bigint;
      }>>`
        SELECT c."userId", COUNT(m.id) as "messageCount"
        FROM crossmodel_chats c
        JOIN crossmodel_messages m ON m."chatId" = c.id
        WHERE m.role = 'assistant'
        GROUP BY c."userId"
      `;
      // Human-chat rows only: supervisor / project-supervisor / spawned
      // sub-session lanes are machine traffic and never count as user activity.
      const humanChats = await prisma.$queryRaw<Array<{ userId: string; lastActiveAt: Date | null }>>`
        SELECT c."userId", MAX(c."updatedAt") as "lastActiveAt"
        FROM crossmodel_chats c
        WHERE c."isSupervisor" = false AND c."isProjectSupervisor" = false AND c."parentChatId" IS NULL
        GROUP BY c."userId"
      `;
      const msgMap = new Map(msgCounts.map(m => [m.userId, Number(m.messageCount)]));
      const humanChatMap = new Map(humanChats.map(h => [h.userId, h.lastActiveAt]));
      // The human message leg: the user's own last message, machine-origin
      // rows ('agent'/'schedule'/'hook'/'webhook'/'machine') excluded.
      const humanMsgRows = await prisma.$queryRaw<Array<{ userId: string; lastActiveAt: Date | null }>>`
        SELECT c."userId", MAX(m."createdAt") as "lastActiveAt"
        FROM crossmodel_chats c
        JOIN crossmodel_messages m ON m."chatId" = c.id
        WHERE m.role = 'user' AND COALESCE(m."metadata"->>'origin', 'user') = 'user'
        GROUP BY c."userId"
      `;
      const humanMsgMap = new Map(humanMsgRows.map(h => [h.userId, h.lastActiveAt]));
      const data = users.map(u => {
        const legs = [
          humanMsgMap.get(u.id) || null,   // last human-authored message
          humanChatMap.get(u.id) || null,  // last human-shaped chat touch (rename/archive)
          u.createdAt,                     // floor: never before the account existed
        ].filter((d): d is Date => !!d);
        const lastActive = legs.length ? new Date(Math.max(...legs.map(d => d.getTime()))) : null;
        return {
          id: u.id, email: u.email, name: u.name, role: u.role,
          isActive: u.isActive, createdAt: u.createdAt.toISOString(),
          lastActive: lastActive ? lastActive.toISOString() : null,
          chatCount: u._count.crossModelChats,
          messageCount: msgMap.get(u.id) || 0,
          ticketCount: u._count.featureRequests,
        };
      });
      return res.json({ success: true, data });
    } catch (error: any) {
      logger.error('getAdminUsers error:', error.message);
      return res.status(500).json({ error: 'Failed to get users' });
    }
  }

  /**
   * DELETE /api/crossmodel/admin/users/:id
   * Hard-delete a user and all their related data (cascade).
   * Admin only (example-user@example.com or ADMIN role).
   * Cannot delete yourself.
   */
  async adminDeleteUser(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    const targetId = req.params.id;
    if (!targetId) {
      return res.status(400).json({ error: 'User ID is required' });
    }
    // Prevent self-deletion
    if (targetId === user?.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    try {
      const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, email: true } });
      if (!target) {
        return res.status(404).json({ error: 'User not found' });
      }
      // Ticket 054daeb7 (2026-10-27): the canonical deploy-smoke account is
      // load-bearing infrastructure, not just a test row — deploy-auth-smoke.sh
      // logs in as it on EVERY wave and the deploy aborts before the traffic
      // switch when it cannot (owner deleted it 2026-10-27 04:13:43Z; every
      // wave after was red for hours with a 401 the CI log did not even show).
      // Refuse here unless the operator explicitly empties the protected list.
      const protectedEmails = adminDeleteProtectedEmails();
      if (protectedEmails.includes(String(target.email || '').toLowerCase())) {
        logger.warn(
          `adminDeleteUser REFUSED protected deploy-smoke account ${target.email} (id ${targetId}) — the deploy gate's authenticated smoke depends on it (ADMIN_DELETE_PROTECTED_EMAILS)`,
        );
        return res.status(400).json({
          error: `Cannot delete ${target.email}: it is a protected deploy-smoke account the deploy gate depends on (remove it from ADMIN_DELETE_PROTECTED_EMAILS to override)`,
        });
      }
      // Review 2026-10-23: the FK cascade alone left the FK-less rows behind
      // (memory facts, the user's store namespace, thread summaries, the
      // supervisor ledger's cold archive of owner directives and its memory
      // mirror) — the same cleanup the self-service delete runs.
      const { purgeUserAccount } = await import('../auth/auth.service');
      await purgeUserAccount(targetId);
      logger.info(`Admin ${user.email} deleted user ${target.email} (${targetId})`);
      return res.json({ success: true, message: `User ${target.email} deleted` });
    } catch (error: any) {
      logger.error('adminDeleteUser error:', error.message);
      return res.status(500).json({ error: 'Failed to delete user' });
    }
  }

  /**
   * PATCH /api/crossmodel/admin/users/:id/role  { role: 'ADMIN' | 'USER' }
   * Owner 2026-10-16: "the ability to edit users as an admin to upgrade them to an admin". Admin only; an admin
   * never changes their own role (no self-lockout), the owner account is never demoted, a Digby Kids account is
   * never an admin. The new role reaches the user's session at its next token refresh (≤ 15 min) or sign-in.
   */
  async adminSetUserRole(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    const targetId = String(req.params.id || '');
    const role = String((req.body as any)?.role || '').toUpperCase();
    if (!targetId) return res.status(400).json({ error: 'User ID is required' });
    if (role !== 'ADMIN' && role !== 'USER') return res.status(400).json({ error: "role must be 'ADMIN' or 'USER'" });
    if (targetId === user?.id) return res.status(400).json({ error: 'You cannot change your own role' });
    try {
      const target = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, email: true, role: true, isChild: true } });
      if (!target) return res.status(404).json({ error: 'User not found' });
      if (role === 'USER' && target.email.toLowerCase() === 'example-user@example.com') {
        return res.status(400).json({ error: 'The owner account is always an admin' });
      }
      if (role === 'ADMIN' && target.isChild) return res.status(400).json({ error: 'A Digby Kids account cannot be an admin' });
      if (target.role === role) return res.json({ success: true, data: { id: target.id, email: target.email, role } });
      const updated = await prisma.user.update({ where: { id: targetId }, data: { role: role as any }, select: { id: true, email: true, role: true } });
      logger.info(`Admin ${user.email} changed the role of ${target.email} (${targetId}) ${target.role} → ${role}`);
      return res.json({ success: true, data: updated });
    } catch (error: any) {
      logger.error('adminSetUserRole error:', error.message);
      return res.status(500).json({ error: 'Failed to change role' });
    }
  }

  /** Continued in getAdminApiCosts below */
  async getAdminApiCosts(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }
    try {
      const days = Math.min(parseInt(req.query.days as string, 10) || 30, 90);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      // ── Chat query volume (truthful message counts — kept from the legacy panel) ──
      const messages = await prisma.crossModelMessage.findMany({
        where: { role: 'assistant', createdAt: { gte: since } },
        select: { metadata: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      const dailyCounts: Record<string, Record<string, number>> = {};
      const modeCounts: Record<string, number> = { fast: 0, thinking: 0, deep_research: 0, deep_research_all: 0 };
      let totalMessages = 0;
      for (const msg of messages) {
        const meta = msg.metadata as any;
        if (!meta?.models) continue;
        totalMessages++;
        if (meta.mode && modeCounts[meta.mode] !== undefined) modeCounts[meta.mode]++;
        const dateKey = msg.createdAt.toISOString().slice(0, 10);
        if (!dailyCounts[dateKey]) dailyCounts[dateKey] = {};
        dailyCounts[dateKey]['_total'] = (dailyCounts[dateKey]['_total'] || 0) + 1;
      }
      const dailyTrend = Object.entries(dailyCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, counts]) => ({ date, total: counts['_total'] || 0 }));

      // ── REAL spend (ticket e553c81b): the loop_metrics run_spend / run_tokens_*
      // rows recorded at every top-level run finalize (chat AND coding since
      // 2026-09-13, agent.ts:3911-3920). Retention is 30 days — the spend window
      // clamps even when the message-count window is longer. The legacy panel's
      // flat per-call guesses + synthesized 'moonshot' row are gone: per-model
      // dollars are list-price estimates from RECORDED tokens via the coding
      // cost table; the headline total is the recorded run_spend sum.
      const spendWindowDays = Math.min(days, 30);
      const spendSince = new Date(Date.now() - spendWindowDays * 24 * 60 * 60 * 1000);
      const [tokenRows, spendSplitRows, perUserRows] = await Promise.all([
        prisma.$queryRaw<Array<{ model: string | null; kind: string; profile: string | null; tokens: number | null; cached: number | null; estimated: boolean | null; runs: number | null }>>`
          SELECT lm."meta"->>'model' AS model, lm."kind" AS kind,
                 CASE WHEN lm."meta"->>'profile' = ${DECISION_SPEND_PROFILE} THEN ${DECISION_SPEND_PROFILE} ELSE NULL END AS profile,
                 SUM(lm."value")::float AS tokens,
                 SUM(COALESCE((lm."meta"->>'cachedTokens')::float, 0))::float AS cached,
                 BOOL_OR(COALESCE((lm."meta"->>'estimated')::boolean, false)) AS estimated,
                 COUNT(DISTINCT lm."runId")::int AS runs
          FROM "loop_metrics" lm
          WHERE lm."kind" IN ('run_tokens_in', 'run_tokens_out') AND lm."createdAt" >= ${spendSince}
          GROUP BY 1, 2, 3`,
        prisma.$queryRaw<Array<{ profile: string | null; trigger_kind: string | null; usd: number | null }>>`
          SELECT COALESCE(lm."meta"->>'profile', 'coding') AS profile,
                 COALESCE(lm."meta"->>'triggerKind', 'user') AS trigger_kind,
                 SUM(lm."value")::float AS usd
          FROM "loop_metrics" lm
          WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${spendSince}
          GROUP BY 1, 2`,
        prisma.$queryRaw<Array<{ user_id: string | null; profile: string | null; usd: number | null }>>`
          SELECT c."userId" AS user_id,
                 COALESCE(lm."meta"->>'profile', 'coding') AS profile,
                 SUM(lm."value")::float AS usd
          FROM "loop_metrics" lm
          LEFT JOIN "crossmodel_chats" c ON c."id" = lm."sessionId"
          WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${spendSince}
            AND COALESCE(lm."sessionId", '') <> ${DECISION_GATE_SYNTHETIC_SESSION}
          GROUP BY 1, 2`,
      ]);
      // Decision gate (2026-09-28, owner "add jev to api costs"): the block the panel renders
      // (calls / tokens / $ per backend + purpose, p50, what-it-replaced estimate). Fail-open: null on error.
      const decisionGate = await decisionSpendSummary({ since: spendSince, windowDays: spendWindowDays }).catch(() => null);
      // Seats govern sessions (2026-09-28): what GOVERNED each coding run's model in the
      // window (run_spend meta.modelSource — 'explicit' | 'project' | 'preference' | 'seat'
      // | 'stamp'; rows older than the change read 'unstamped'). Fail-open: [] on error.
      const governanceRows = await prisma.$queryRaw<Array<{ source: string | null; runs: number | null; usd: number | null }>>`
        SELECT COALESCE(lm."meta"->>'modelSource', 'unstamped') AS source,
               COUNT(*)::int AS runs,
               SUM(lm."value")::float AS usd
        FROM "loop_metrics" lm
        WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${spendSince}
          AND COALESCE(lm."meta"->>'profile', 'coding') = 'coding'
        GROUP BY 1`.catch(() => [] as Array<{ source: string | null; runs: number | null; usd: number | null }>);
      const modelGovernance = (Array.isArray(governanceRows) ? governanceRows : [])
        .map((r) => ({ source: String(r.source || 'unstamped'), runs: Number(r.runs) || 0, usd: Math.round((Number(r.usd) || 0) * 100) / 100 }))
        .sort((a, b) => b.runs - a.runs);

      // Per-model pivot: real recorded tokens; cost recomputed at list price.
      // audit 2026-10-08 W3-4: history recorded a gateway model under its bare id on coding rows and its
      // registry spec on chat rows — fold a bare id that exactly ONE enabled endpoint serves into that spec
      // (SPEND_MODEL_KEY_NORMALIZE_DISABLED=1 skips the fold). Fail-open: no registry read ⇒ no fold.
      let bareToSpec = new Map<string, string>();
      if (String(process.env.SPEND_MODEL_KEY_NORMALIZE_DISABLED ?? '').trim() !== '1') {
        try {
          const eps = await (prisma as any).modelEndpoint?.findMany?.({ select: { label: true, enabled: true, models: true } });
          const { bareToSpecMap } = await import('./platform/spend-model-keys');
          const { PRICES } = await import('./coding/cost');
          bareToSpec = bareToSpecMap(Array.isArray(eps) ? eps : [], (id) => Object.prototype.hasOwnProperty.call(PRICES, id));
        } catch { bareToSpec = new Map(); }
      }
      const runsByName = new Map<string, Map<string, number>>();
      const byModel = new Map<string, { model: string; inTokens: number; outTokens: number; cachedTokens: number; runs: number; estimated: boolean; custom: boolean; listCostUsd: number; cacheHitPct?: number | null; profile?: 'decision'; priceSource?: string; unpriced?: boolean; priceNote?: string }>();
      for (const row of tokenRows) {
        const recorded = row.model || 'unknown';
        const model = row.profile === DECISION_SPEND_PROFILE ? recorded : (recorded.includes(':') ? recorded : (bareToSpec.get(recorded) ?? recorded));
        // Decision-gate rows (profile 'decision') pivot SEPARATELY from the chat / coding rows of the same
        // vendor (deepseek-flash as the logprob readout vs as the Double Checker) and price via the decision
        // price table (Jev list / env price, registry price, self-hosted $0) — never DEFAULT_PRICE.
        const isDecision = row.profile === DECISION_SPEND_PROFILE;
        const key = isDecision ? `decision:${model}` : model;
        let acc = byModel.get(key);
        if (!acc) {
          acc = { model, inTokens: 0, outTokens: 0, cachedTokens: 0, runs: 0, estimated: false, custom: model.includes(':'), listCostUsd: 0, ...(isDecision ? { profile: 'decision' as const } : {}) };
          byModel.set(key, acc);
        }
        const tokens = Number(row.tokens) || 0;
        if (row.kind === 'run_tokens_in') { acc.inTokens += tokens; acc.cachedTokens += Number(row.cached) || 0; }
        else if (row.kind === 'run_tokens_out') acc.outTokens += tokens;
        // runs per recorded name = max(in, out) as before; a folded key sums its names (disjoint row sets)
        const perName = runsByName.get(key) ?? new Map<string, number>();
        perName.set(recorded, Math.max(perName.get(recorded) ?? 0, Number(row.runs) || 0));
        runsByName.set(key, perName);
        acc.runs = [...perName.values()].reduce((a, b) => a + b, 0);
        acc.estimated = acc.estimated || row.estimated === true;
      }
      // Registry prices for the decision gate's custom backends (Laya on cql-litellm): resolved once per spec.
      const registryPrice = new Map<string, { in?: number; out?: number } | null>();
      // build 2026-10-08 Q-1: chat / coding custom specs resolve their registry price too (it wins over the family price).
      for (const acc of byModel.values()) {
        if (!acc.custom || registryPrice.has(acc.model)) continue;
        try {
          const { resolveRegistryModel } = await import('./model-endpoints/model-endpoints.service');
          const reg = await resolveRegistryModel(acc.model);
          registryPrice.set(acc.model, reg ? { ...(typeof reg.usdPerMTokIn === 'number' ? { in: reg.usdPerMTokIn } : {}), ...(typeof reg.usdPerMTokOut === 'number' ? { out: reg.usdPerMTokOut } : {}) } : null);
        } catch { registryPrice.set(acc.model, null); }
      }
      const models = [...byModel.values()].map((acc) => {
        if (acc.profile === 'decision') {
          const price = decisionPriceFor(acc.model, { registryPrice: registryPrice.get(acc.model) ?? null });
          const usd = decisionCallUsd(price, acc.inTokens, acc.outTokens);
          return { ...acc, listCostUsd: Math.round(usd * 10_000) / 10_000, priceSource: price.source, unpriced: price.source === 'unpriced' || price.source === 'self_hosted', priceNote: price.note };
        }
        // Custom Edge endpoints ('<label>:<modelId>') have no PRICES entry — they price at their registry
        // price, else their model family's list price, else DEFAULT_PRICE (build 2026-10-08 Q-1).
        // audit 2026-10-08 W3-2: cached input prices at the model's cache rate when one is known (cost.ts PRICES cachedIn).
        // build 2026-10-08 Q-1: registry price > family list price > default (cost.ts resolvePrice); priceSource says which.
        const reg = acc.custom ? (registryPrice.get(acc.model) ?? null) : undefined;
        const listCostUsd = turnCostUsd(acc.model, { promptTokens: acc.inTokens, completionTokens: acc.outTokens, cachedTokens: acc.cachedTokens, estimated: acc.estimated }, reg);
        const cacheHitPct = acc.inTokens > 0 && acc.cachedTokens > 0 ? Math.round((acc.cachedTokens / acc.inTokens) * 1000) / 10 : acc.inTokens > 0 ? 0 : null;
        const resolved = resolvePrice(acc.model, reg);
        return { ...acc, cacheHitPct, listCostUsd: Math.round(listCostUsd * 100) / 100, priceSource: resolved.source === 'family' && resolved.family ? `family:${resolved.family}` : resolved.source };
      }).sort((a, b) => b.listCostUsd - a.listCostUsd);
      // audit 2026-10-08 W3-2: prompt-cache hit rate per profile from the run_spend rows that carry it
      // (rows recorded before the change have no inTokens field and are left out). Fail-open: [].
      const cacheProfileRows = await prisma.$queryRaw<Array<{ profile: string | null; runs: number | null; in_tokens: number | null; cached: number | null }>>`
        SELECT COALESCE(lm."meta"->>'profile', 'coding') AS profile,
               COUNT(*)::int AS runs,
               SUM((lm."meta"->>'inTokens')::float)::float AS in_tokens,
               SUM(COALESCE((lm."meta"->>'cachedTokens')::float, 0))::float AS cached
        FROM "loop_metrics" lm
        WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${spendSince} AND lm."meta" ? 'inTokens'
        GROUP BY 1`.catch(() => [] as Array<{ profile: string | null; runs: number | null; in_tokens: number | null; cached: number | null }>);
      const promptCacheByProfile = (Array.isArray(cacheProfileRows) ? cacheProfileRows : [])
        .map((r) => {
          const inTokens = Number(r.in_tokens) || 0;
          const cachedTokens = Number(r.cached) || 0;
          return { profile: String(r.profile || 'coding'), runs: Number(r.runs) || 0, inTokens, cachedTokens, cacheHitPct: inTokens > 0 ? Math.round((cachedTokens / inTokens) * 1000) / 10 : 0 };
        })
        .filter((r) => r.inTokens > 0)
        .sort((a, b) => b.inTokens - a.inTokens);

      // Surface + trigger splits + the recorded total. triggerKind is stamped
      // with FOUR values, not two: 'user' | 'machine' | 'schedule' | 'hook'
      // (agent.ts stamps schedule/hook wakes; run-executor.ts likewise) — each
      // gets its own bucket; anything missing/unexpected defaults to 'user'
      // (the SQL already COALESCEs absent meta to 'user').
      const surfaceSpend: Record<string, number> = { coding: 0, chat: 0, chat_research: 0, decision: 0 };
      const triggerSpend: Record<string, number> = { user: 0, machine: 0, schedule: 0, hook: 0, decision: 0 };
      let totalSpendUsd = 0;
      for (const row of spendSplitRows) {
        const usd = Number(row.usd) || 0;
        totalSpendUsd += usd;
        const profile = row.profile && surfaceSpend[row.profile] !== undefined ? row.profile : 'coding';
        surfaceSpend[profile] += usd;
        // Decision-gate rows carry no triggerKind (a decision serves whatever consumer asked) — their own bucket,
        // never 'user' by default.
        const trigger = profile === DECISION_SPEND_PROFILE ? 'decision' : row.trigger_kind === 'machine' || row.trigger_kind === 'schedule' || row.trigger_kind === 'hook' ? row.trigger_kind : 'user';
        triggerSpend[trigger] += usd;
      }

      // Per-user rollup (top 20 by spend); rows whose chat was deleted join to
      // user_id NULL — kept as an explicit '(deleted chat)' bucket (soft refs).
      const perUserMap = new Map<string, { userId: string | null; totalUsd: number; codingUsd: number; chatUsd: number; chatResearchUsd: number }>();
      for (const row of perUserRows) {
        const key = row.user_id ?? '';
        let acc = perUserMap.get(key);
        if (!acc) {
          acc = { userId: row.user_id, totalUsd: 0, codingUsd: 0, chatUsd: 0, chatResearchUsd: 0 };
          perUserMap.set(key, acc);
        }
        const usd = Number(row.usd) || 0;
        acc.totalUsd += usd;
        if (row.profile === 'chat') acc.chatUsd += usd;
        else if (row.profile === 'chat_research') acc.chatResearchUsd += usd;
        else acc.codingUsd += usd;
      }
      const topUsers = [...perUserMap.values()].sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 20);
      const userIds = topUsers.map((u) => u.userId).filter((id): id is string => !!id);
      const userRows = userIds.length
        ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } })
        : [];
      const emailById = new Map(userRows.map((u) => [u.id, u.email || u.name || u.id]));
      const perUser = topUsers.map((u) => ({
        userId: u.userId,
        email: u.userId ? emailById.get(u.userId) || u.userId : '(deleted chat)',
        totalUsd: Math.round(u.totalUsd * 100) / 100,
        codingUsd: Math.round(u.codingUsd * 100) / 100,
        chatUsd: Math.round((u.chatUsd + u.chatResearchUsd) * 100) / 100,
      }));

      const round2 = (n: number) => Math.round(n * 100) / 100;
      return res.json({
        success: true,
        data: {
          days, spendWindowDays,
          spendRecordedSince: '2026-09-13',
          totalSpendUsd: round2(totalSpendUsd),
          surfaceSpend: { coding: round2(surfaceSpend.coding), chat: round2(surfaceSpend.chat + surfaceSpend.chat_research), chatResearch: round2(surfaceSpend.chat_research), decision: Math.round(surfaceSpend.decision * 10_000) / 10_000 },
          triggerSpend: { user: round2(triggerSpend.user), machine: round2(triggerSpend.machine), schedule: round2(triggerSpend.schedule), hook: round2(triggerSpend.hook), decision: Math.round(triggerSpend.decision * 10_000) / 10_000 },
          models, perUser,
          decisionGate,
          modelGovernance,
          promptCacheByProfile,
          totalMessages, modeCounts, dailyTrend,
        },
      });
    } catch (error: any) {
      logger.error('getAdminApiCosts error:', error.message);
      return res.status(500).json({ error: 'Failed to get API cost data' });
    }
  }

  // ── Feeds (RETIRED, ticket 43c24152, 2026-10-20) ────────────────────────────
  // Topic feeds are gone from the product; the routes answer 410 tombstones
  // (see crossmodel.routes.ts) and every handler below was deleted with the
  // feed.service module. A topic digest is a schedule on a real chat.

  // ── Home Page News Headlines ────────────────────────────────────────────────

  // ── Home Page News Headlines ──────────────────────────────────────────────

  async getNewsHeadlines(req: Request, res: Response) {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: 'Authentication required' });
    const userId = user.id;

    try {
      // Self-host setup hardening (2026-10-20): on a NON-production instance
      // with no search backend the briefing can never be built — say so once
      // (no background prefetch, no "checking every few seconds" poll loop).
      if (webSearchMissingOnInstance()) {
        return res.json({ success: true, data: [], unconfigured: true, unconfiguredReason: 'search' });
      }
      // Edge formatter hardening (2026-10-26, the digby.cql.ca outage): search
      // can be configured while the utility FORMATTER is not — a gateway-only
      // self-host with no DEEPSEEK_API_KEY / DASHSCOPE_API_KEY and no Utility
      // seat assignment. Previously that corner degraded forever
      // ("temporarily unavailable — we'll retry automatically") while retrying
      // could never succeed: the missing piece is configuration, not a
      // transient outage. Same terminal honesty as the search gate — one
      // response, no prefetch kick, no poll loop.
      // CAPABILITY-keyed, not instance-kind-keyed (review F1, 2026-10-27):
      // NOT conjunct-guarded on !isProdInstance() — an Edge deployed without
      // DIGBY_INSTANCE reads as 'prod' and the gate must still fire (the
      // reported digby.cql.ca box may be exactly that shape). Prod-safe on
      // its own: production's env keys make utilityChainUnconfigured() false
      // before any config read, and a read error fail-opens to false.
      if (await utilityChainUnconfigured()) {
        return res.json({ success: true, data: [], unconfigured: true, unconfiguredReason: 'formatter' });
      }
      // ── Step 1: Check Redis cache (instant — headlines pre-fetched by scheduler) ──
      const { getNewsFromCache, prefetchNewsForUser, isNewsFetchInProgress, MIN_HEALTHY_HEADLINES } = await import('./news.service');
      const cached = await getNewsFromCache(userId);
      if (cached && cached.length > 0) {
        logger.info(`getNewsHeadlines: cache hit for userId=${userId} (${cached.length} headlines)`);
        // Thin briefing (junk filtered down or degenerate fetch): still render it,
        // but kick a background refresh so it repairs without user action. The
        // Redis NX fetching lock + in-memory set dedupe concurrent kicks.
        if (cached.length < MIN_HEALTHY_HEADLINES && !isNewsFetchInProgress(userId)) {
          prefetchNewsForUser(userId).catch((err: any) => {
            logger.error(`getNewsHeadlines: background thin-cache repair failed for userId=${userId}: ${err.message}`);
          });
        }
        return res.json({ success: true, data: cached });
      }

      // ── Step 2: Cache miss — respond immediately, fetch in background ──
      // Instead of blocking the HTTP response for 15-180s while OpenAI generates
      // news, we return immediately with pending=true. The frontend retries every
      // few seconds and will pick up the cached result once the background fetch
      // completes. This ensures the home page loads instantly every time.
      const { isNewsFailureBackoff, isNewsFetchCircuitOpen } = await import('./news.service');
      // Honest degraded signal (ticket d86cf931): when the backend already knows
      // it recently failed (per-user 5-min failure backoff armed, or the fetch
      // circuit breaker open on a sustained outage), say so — the home news card
      // switches to "temporarily unavailable" + a 60s cadence instead of lying
      // "checking every few seconds" for the length of an outage (2026-08-29 ~6h).
      const degraded = (await isNewsFailureBackoff(userId)) || isNewsFetchCircuitOpen();
      const alreadyFetching = isNewsFetchInProgress(userId);
      if (!alreadyFetching) {
        logger.info(`getNewsHeadlines: cache miss for userId=${userId} — triggering background fetch`);
        // Fire-and-forget — don't await. prefetchNewsForUser handles its own errors.
        prefetchNewsForUser(userId).catch((err: any) => {
          logger.error(`getNewsHeadlines: background prefetch failed for userId=${userId}: ${err.message}`);
        });
      } else {
        logger.info(`getNewsHeadlines: cache miss for userId=${userId} — fetch already in progress`);
      }

      return res.json({ success: true, data: [], pending: true, degraded });
    } catch (error: any) {
      logger.error('getNewsHeadlines error:', error.message);
      // The read itself failed — that IS a degraded state; say so honestly.
      return res.json({ success: true, data: [], pending: true, degraded: true });
    }
  }

  // ── Home Page Personalized Starter Questions ────────────────────────────────

  async getSuggestedQuestions(req: Request, res: Response) {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: 'Authentication required' });
    const userId = user.id;

    try {
      const { getQuestionsFromCache, generateQuestionsForUser, isQuestionsFetchInProgress, isQuestionsFailureBackoff, isQuestionsStale, DEFAULT_QUESTIONS } =
        await import('./suggested-questions.service');

      // Edge/self-host hardening (2026-10-26, same class as the news
      // formatter gate): generation rides the utility chain — on a
      // gateway-only instance with no DEEPSEEK_API_KEY / DASHSCOPE_API_KEY
      // and no Utility seat, every background run returns '' , the 5-min
      // failure backoff re-arms forever and the home screen polls for
      // ~140 s on every visit serving generic defaults. Answer the same
      // TERMINAL unconfigured state the news card uses: defaults (honest —
      // they are the generic chips), no pending, no generation kick, no
      // poll loop.
      // CAPABILITY-keyed, not instance-kind-keyed (review F1, 2026-10-27):
      // not conjunct-guarded on !isProdInstance() — an Edge deployed without
      // DIGBY_INSTANCE reads as 'prod' and must still get the honest answer.
      // Prod-safe on its own: production's keys make the gate false.
      if (await utilityChainUnconfigured()) {
        return res.json({ success: true, data: DEFAULT_QUESTIONS, unconfigured: true });
      }

      const cached = await getQuestionsFromCache(userId);
      if (cached && cached.length > 0) {
        // Stale-while-revalidate (2026-09-08): a fact writer marked the set
        // stale. Keep serving the last good set (pending:true so the frontend
        // re-polls) and regenerate in the background — the reasoning pipeline
        // takes 1-2.5 min and must never show generic defaults to a user who
        // already had a personalized set.
        const stale = await isQuestionsStale(userId);
        if (stale && !isQuestionsFetchInProgress(userId) && !(await isQuestionsFailureBackoff(userId))) {
          generateQuestionsForUser(userId).catch((err: any) => {
            logger.error(`getSuggestedQuestions: stale regeneration failed for userId=${userId}: ${err.message}`);
          });
        }
        return res.json({ success: true, data: cached, ...(stale ? { pending: true } : {}) });
      }

      // Cache miss — same pattern as news: respond instantly with the defaults
      // and pending=true, generate in the background, frontend re-fetches.
      // Skip re-triggering during a transient-failure backoff window (avoids
      // hammering the LLM on every home load after a timeout) — generation
      // resumes automatically once the backoff lapses.
      if (!isQuestionsFetchInProgress(userId) && !(await isQuestionsFailureBackoff(userId))) {
        generateQuestionsForUser(userId).catch((err: any) => {
          logger.error(`getSuggestedQuestions: background generation failed for userId=${userId}: ${err.message}`);
        });
      }
      return res.json({ success: true, data: DEFAULT_QUESTIONS, pending: true });
    } catch (error: any) {
      logger.error('getSuggestedQuestions error:', error.message);
      const { DEFAULT_QUESTIONS } = await import('./suggested-questions.service');
      return res.json({ success: true, data: DEFAULT_QUESTIONS, pending: true });
    }
  }

  // ── Home Page Weather ───────────────────────────────────────────────────────

  async getWeatherForHome(req: Request, res: Response) {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: 'Authentication required' });

    try {
      const { getWeatherForUser } = await import('./weather.service');
      const weather = await getWeatherForUser(user.id);
      return res.json({ success: true, data: weather });
    } catch (error: any) {
      logger.error('getWeatherForHome error:', error.message);
      return res.json({ success: true, data: { available: false } });
    }
  }

  // ── Home Page Calendar Events ───────────────────────────────────────────────

  async getCalendarEventsForHome(req: Request, res: Response) {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: 'Authentication required' });
    const userId = user.id;
    // Owner 2026-10-21 ("where did the calendar view go from the main
    // homepage?"): a connected calendar whose fetch failed used to answer
    // `connected:false` (the catch) or `connected:true, events:[]` (the fan-out
    // failure text parsed to nothing) — both made the home Today card vanish
    // as if the calendar had never been connected. `connected` now tracks the
    // Google row, and a failed read carries `error:'unavailable'` so the card
    // can say so and offer a retry.
    let connected = false;

    try {
      if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
        return res.json({ success: true, data: { connected: false, events: [] } });
      }

      const googleRow = await (prisma as any).googleOAuthToken.findFirst({
        where: { userId },
        select: { userId: true },
      });

      if (!googleRow) {
        return res.json({ success: true, data: { connected: false, events: [] } });
      }
      connected = true;

      const googleMcp = await import('./google/google-mcp');

      // Dead credentials (the 2026-10-21 case: Google OAuth client id / secret
      // rotated ⇒ every refresh token minted under the old client fails) —
      // `getAllValidTokens` then yields no account and the fetch returned ''
      // = "Nothing today". Say RECONNECT instead; the card links to
      // Account → Integrations.
      const resolution = await googleMcp.resolveGoogleAccount(userId);
      if (!resolution.ok) {
        if (resolution.reason === 'refresh_failed') {
          logger.warn(`getCalendarEventsForHome: Google token refresh failed for userId=${userId} — reconnect needed`);
          return res.json({ success: true, data: { connected: true, events: [], error: 'reconnect' } });
        }
        if (resolution.reason === 'not_connected') {
          return res.json({ success: true, data: { connected: false, events: [] } });
        }
      }

      // Load user's timezone from memory so we query the correct "today"
      // (server runs in UTC; without this, a user at 10 PM EDT sees tomorrow's events)
      let userTz = 'UTC';
      try {
        const mem = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } });
        const facts = (mem?.facts as Record<string, string>) || {};
        if (facts.timezone) userTz = facts.timezone;
      } catch { /* non-fatal — fall back to UTC */ }

      // Compute start/end of "today" in the user's local timezone, then convert to UTC.
      // We get the user's local date string (e.g. "2026-04-13") and build midnight/end-of-day
      // in their timezone by computing the UTC offset from the timezone.
      const now = new Date();
      const localDateStr = now.toLocaleDateString('en-CA', { timeZone: userTz }); // "2026-04-13" (ISO format)

      // Compute the UTC offset for the user's timezone by comparing the same instant
      // formatted in UTC vs the user's timezone. This correctly handles DST.
      const utcParts = now.toLocaleString('en-US', { timeZone: 'UTC', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const tzParts  = now.toLocaleString('en-US', { timeZone: userTz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const parseLocaleDate = (s: string) => {
        // Format: "MM/DD/YYYY, HH:MM:SS" — parse to a comparable timestamp
        const m = s.match(/(\d+)\/(\d+)\/(\d+),?\s*(\d+):(\d+):(\d+)/);
        if (!m) return 0;
        return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] === 24 ? 0 : +m[4], +m[5], +m[6]);
      };
      const utcMs = parseLocaleDate(utcParts);
      const tzMs  = parseLocaleDate(tzParts);
      // offsetMs = how many ms to ADD to a "local wall clock" Date to get UTC
      // e.g. for EDT (UTC-4): offsetMs = +4h (local midnight + 4h = UTC midnight of that local day)
      const offsetMs = utcMs - tzMs;

      // Build start/end of day as UTC ISO strings
      const startUtc = new Date(new Date(`${localDateStr}T00:00:00Z`).getTime() + offsetMs);
      const endUtc   = new Date(new Date(`${localDateStr}T23:59:59Z`).getTime() + offsetMs);

      logger.info(`getCalendarEventsForHome: userTz=${userTz}, localDate=${localDateStr}, queryRange=${startUtc.toISOString()} to ${endUtc.toISOString()}`);

      const rawEvents = await googleMcp.getCalendarEvents(userId, startUtc.toISOString(), endUtc.toISOString(), 25, userTz);

      if (!rawEvents || rawEvents.trim() === '') {
        return res.json({ success: true, data: { connected: true, events: [] } });
      }
      // The fan-out returns its failure text (no section header) when EVERY
      // account failed — that is an outage to report, not an empty day.
      if (!rawEvents.includes('[Google Calendar Events]')) {
        logger.warn(`getCalendarEventsForHome: calendar fetch failed for userId=${userId}: ${rawEvents.slice(0, 200)}`);
        return res.json({ success: true, data: { connected: true, events: [], error: 'unavailable' } });
      }

      const events = parseCalendarEventsText(rawEvents, userTz);
      logger.info(`getCalendarEventsForHome: found ${events.length} events for userId=${userId}`);
      return res.json({ success: true, data: { connected: true, events: events.slice(0, 20) } });
    } catch (error: any) {
      logger.error('getCalendarEventsForHome error:', error.message);
      return res.json({ success: true, data: { connected, events: [], ...(connected ? { error: 'unavailable' } : {}) } });
    }
  }

  // (The frontier fact-check stream — GET /fact-check/stream, a direct Gemini
  // call critiquing an open-source transcript — was RETIRED 2026-09-22: the
  // owner removed every frontier model and its UI trigger had been gone since
  // the C3 transcript rewrite.)

  // ── Admin: Error Logs ─────────────────────────────────────────────────────

  /**
   * GET /api/crossmodel/admin/error-logs
   * Returns paginated app error/warning logs from the database.
   * Admin only (example-user@example.com or ADMIN role).
   * Query: ?level=error|warn  &page=1  &limit=50  &since=ISO  &until=ISO  &search=text
   */
  async getAdminErrorLogs(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }

    try {
      const page  = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
      const level = req.query.level as string | undefined;
      const since = req.query.since ? new Date(req.query.since as string) : undefined;
      const until = req.query.until ? new Date(req.query.until as string) : undefined;
      const search = (req.query.search as string || '').trim();

      const where: any = {};
      if (level && ['error', 'warn'].includes(level)) {
        where.level = level;
      }
      if (since || until) {
        where.createdAt = {};
        if (since) where.createdAt.gte = since;
        if (until) where.createdAt.lte = until;
      }
      if (search) {
        where.message = { contains: search, mode: 'insensitive' };
      }

      const [logs, total] = await Promise.all([
        (prisma as any).appErrorLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        (prisma as any).appErrorLog.count({ where }),
      ]);

      return res.json({
        success: true,
        data: logs,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error: any) {
      logger.error('getAdminErrorLogs error:', error.message);
      return res.status(500).json({ error: 'Failed to get error logs' });
    }
  }

  /**
   * DELETE /api/crossmodel/admin/error-logs
   * Purge old error logs. Admin only.
   * Query: ?olderThanDays=30 (default 30)
   */
  async purgeAdminErrorLogs(req: Request, res: Response) {
    const user = (req as any).user;
    if (!isAdminViewer(user)) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }

    try {
      const days = Math.max(1, parseInt(req.query.olderThanDays as string) || 30);
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const result = await (prisma as any).appErrorLog.deleteMany({
        where: { createdAt: { lt: cutoff } },
      });

      logger.info(`Admin purged ${result.count} error logs older than ${days} days`);
      return res.json({ success: true, deleted: result.count });
    } catch (error: any) {
      logger.error('purgeAdminErrorLogs error:', error.message);
      return res.status(500).json({ error: 'Failed to purge error logs' });
    }
  }

  // ── Admin: Job Health ───────────────────────────────────────────────────
  async getAdminJobHealth(req: Request, res: Response) {
    const u = (req as any).user;
    if (!isAdminViewer(u)) return res.status(403).json({ error: 'Forbidden' });
    try {
      const now = new Date(), h1 = new Date(+now - 3600000), h24 = new Date(+now - 86400000), d7 = new Date(+now - 604800000);
      const [e24, w24, e7, w7, e1h] = await Promise.all([
        (prisma as any).appErrorLog.count({ where: { level: 'error', createdAt: { gte: h24 } } }),
        (prisma as any).appErrorLog.count({ where: { level: 'warn',  createdAt: { gte: h24 } } }),
        (prisma as any).appErrorLog.count({ where: { level: 'error', createdAt: { gte: d7  } } }),
        (prisma as any).appErrorLog.count({ where: { level: 'warn',  createdAt: { gte: d7  } } }),
        (prisma as any).appErrorLog.count({ where: { level: 'error', createdAt: { gte: h1  } } }),
      ]);
      const recent = await (prisma as any).appErrorLog.findMany({ where: { level: 'error' }, orderBy: { createdAt: 'desc' }, take: 15, select: { id: true, level: true, message: true, source: true, createdAt: true } });
      const [oT, iT, dT, tT] = await Promise.all([
        prisma.userFeatureRequest.count({ where: { status: 'open' } }),
        prisma.userFeatureRequest.count({ where: { status: 'in_progress' } }),
        prisma.userFeatureRequest.count({ where: { status: 'done', updatedAt: { gte: d7 } } }),
        prisma.userFeatureRequest.count(),
      ]);
      // WI-M (2026-09-25): the live https probe moved to fleet/deploy-health.ts
      // so get_fleet_telemetry views 'jobHealth' / 'deploy' answer the SAME
      // probe (60 s cache; DEPLOY_HEALTH_PROBE_DISABLED=1 → status 'skipped').
      let dh: any = { status: 'unknown', checkedAt: now.toISOString() };
      try {
        const { probeDeployHealth } = await import('./fleet/deploy-health');
        dh = await probeDeployHealth({ now });
      } catch { /* ok */ }
      const avg = e24 > 0 ? e24 / 24 : 0;
      return res.json({ success: true, data: {
        errorSummary: { last24h: { error: e24, warn: w24 }, last7d: { error: e7, warn: w7 }, last1h: { error: e1h }, avgErrorsPerHour: Math.round(avg * 10) / 10, errorSpike: e1h > 5 && e1h > avg * 3 },
        recentErrors: recent.map((e: any) => ({ ...e, message: String(e.message).substring(0, 200), createdAt: e.createdAt?.toISOString?.() || e.createdAt })),
        ticketPipeline: { open: oT, inProgress: iT, done7d: dT, total: tT },
        deployHealth: dh,
      }});
    } catch (err: any) { logger.error('getAdminJobHealth error:', err.message); return res.status(500).json({ error: 'Failed to get job health' }); }
  }

  // ── Admin: Loop Metrics (audit #12) ─────────────────────────────────────
  /**
   * GET /api/crossmodel/admin/loop-metrics
   * Unified loop telemetry. With ?kind= → per-hour/day buckets (count, sum,
   * avg) for that kind over ?hours= (default 24; ?bucket=hour|day), PLUS the
   * ok/fail outcome aggregate grouped by `meta.unit` (ticket d59499f4 — a rate
   * pooled across units is ambiguous: one embed call writes an attempt row and
   * a call roll-up at the same timestamp) and the p50/p95 payload sizes when
   * the rows carry one. Both extras are best-effort: a failed read leaves them
   * null rather than taking the counts down. Without ?kind= → compact summary
   * of ALL kinds (count + sum) over the window.
   * Admin only (same posture as /admin/job-health).
   */
  async getAdminLoopMetrics(req: Request, res: Response) {
    const u = (req as any).user;
    if (!isAdminViewer(u)) return res.status(403).json({ error: 'Forbidden' });
    try {
      const kindRaw = req.query.kind;
      const kind = typeof kindRaw === 'string' && kindRaw.trim() ? kindRaw.trim() : undefined;
      const hours = Math.min(24 * 90, Math.max(1, parseInt(req.query.hours as string) || 24));
      const bucket = req.query.bucket === 'day' ? ('day' as const) : ('hour' as const);
      if (!kind) {
        const kinds = await summarizeLoopMetrics(hours);
        return res.json({ success: true, data: { mode: 'summary', hours, kinds } });
      }
      const [buckets, outcomes, payloadSizes] = await Promise.all([
        queryLoopMetrics(kind, { hours, bucket }),
        queryLoopMetricOutcomes(kind, { hours, bucket }).catch(() => null),
        queryLoopMetricPayloadSizes(kind, { hours }).catch(() => null),
      ]);
      return res.json({ success: true, data: { mode: 'series', kind, hours, bucket, buckets, outcomes, payloadSizes: payloadSizes?.length ? payloadSizes : null } });
    } catch (err: any) { logger.error('getAdminLoopMetrics error:', err.message); return res.status(500).json({ error: 'Failed to get loop metrics' }); }
  }

}

export default new CrossModelController();

