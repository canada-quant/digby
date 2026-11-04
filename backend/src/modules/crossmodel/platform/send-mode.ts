/**
 * THE per-send patience/level resolver — one path for every human and machine
 * entry point (audit 2026-09-26 "unify-routing", hazard H7: the web stream,
 * REST `POST /platform/chats/:id/messages`, the `send_chat_message` tool,
 * webhooks, Telegram and the queue drains used to resolve `mode` five
 * different ways — the always-Auto switch, the quota allowance, the
 * supervisor exclusion and the Level 3 floor each lived at ONE seam and were
 * missing at the others).
 *
 * What it decides for one send (pure apart from the injected readers):
 *   - `auto` (explicit, stored, or forced by `patience_auto_only`) ⇒ the Auto
 *     router with an ALLOWANCE on EVERY auto send (routing-unify-1: the
 *     allowance used to run only under the switch, so the default signed-in
 *     web send — wire mode 'auto' — could land a Level 3 it could not reserve
 *     and hard-error the stream instead of demoting to Ensemble);
 *   - a supervisor-class chat never runs the research council on a human
 *     turn (supervisors-auto-2: an L3 route swapped the supervisor profile /
 *     tools / doctrine for the council lead's) — clamped to Ensemble with
 *     reasonKey `supervisor_no_research`, segment 'supervisor';
 *   - a NON-human origin (agent / webhook / schedule / hook) never runs deep
 *     research — explicit, stored or auto-routed — floored to Ensemble with
 *     reasonKey `channel_floor` (routing-unify-5 / supervisors-auto-3: the
 *     webhook-only clamp let `send_chat_message mode:'deep_research'` convene
 *     an unmetered council on a machine turn); the chat-agent has a second,
 *     run-level floor (MACHINE_DEEP_RESEARCH_FLOOR_DISABLED) as defence in depth;
 *   - a CHATLESS human send (Telegram) routes like a web send but stays off
 *     Level 3 (no persisted row to post "Deeper findings" to, nothing to
 *     notify) — segment 'telegram' (routing-unify-6);
 *   - the label window (patience plan §4.1) is ARMED for a `picked` explicit
 *     level even under the switch (settings-switches-4 option A — the send is
 *     routed as Auto, but the pick is still a human label of the SAME
 *     message); the caller fires it once the send is admitted.
 *
 * The quota RESERVE stays at the caller (it is the atomic guard right before
 * the run starts) — every caller demotes an auto-routed Level 3 that loses
 * the reserve race to Ensemble (`demoteForQuota`), never errors.
 *
 * Kill switches (each restores the pre-audit behaviour of ONE change):
 *   AUTO_ROUTE_ALLOWANCE_DISABLED=1      the allowance runs only under patience_auto_only (the old rule)
 *   SUPERVISOR_AUTO_RESEARCH_ENABLED=1   supervisor chats may route / pick Level 3 again
 *   MACHINE_DEEP_RESEARCH_FLOOR_DISABLED=1  non-human origins keep an explicit / stored / routed Level 3 (webhooks stay clamped)
 *   PATIENCE_AUTO_ONLY_REST_DISABLED=1   the REST / tool seam ignores patience_auto_only (SSE seam only, the old rule)
 *   TELEGRAM_AUTO_ROUTE_DISABLED=1       Telegram sends run Level 1 as before
 */

import logger from '../../../utils/logger';
import { AUTO_MODE, normalizePatienceMode, storedModeToPreset, type RoutableLevel } from '../types';
import { routeMessageAuto, labelWindowNote, clampFor, type AutoRouteReasonKey, type AutoRouteSegment, type DeepResearchDenyReason, type ModeSource } from './auto-router-gate';
import { deepResearchAllowance, getPatienceAutoOnly } from '../rate-limit.service';

/** Where a send comes from. Human origins: web / rest / telegram / imessage. */
export type SendOrigin = 'web' | 'rest' | 'telegram' | 'imessage' | 'agent' | 'webhook' | 'schedule' | 'hook';
export const HUMAN_SEND_ORIGINS: ReadonlySet<SendOrigin> = new Set<SendOrigin>(['web', 'rest', 'telegram', 'imessage']);
export function isHumanSendOrigin(origin: SendOrigin): boolean { return HUMAN_SEND_ORIGINS.has(origin); }

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};
export function autoRouteAllowanceDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.AUTO_ROUTE_ALLOWANCE_DISABLED); }
export function supervisorAutoResearchEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.SUPERVISOR_AUTO_RESEARCH_ENABLED); }
export function machineDeepResearchFloorDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.MACHINE_DEEP_RESEARCH_FLOOR_DISABLED); }
export function patienceAutoOnlyRestDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.PATIENCE_AUTO_ONLY_REST_DISABLED); }
/**
 * PATIENCE_AUTO_ONLY_HONOUR_PRESET=1 — OPT-IN (audit 2026-09-26 docs-drift-3 #4,
 * branch audit/patience-auto-only-switch-state): under the switch a SIGNED-IN
 * user's stored client preset (modeSource 'default' with a concrete level —
 * since ticket c99b404a a REST / API send only: the Advanced tab that stored
 * web presets was removed) keeps that level (routingSource user_default, no
 * router, no label) instead of riding as routing.requestedMode. Default OFF =
 * the owner's "every human send is Auto" contract.
 * Guests, unsignalled sends and legacy-picker 'picked' / 'restored' are always routed.
 */
export function patienceAutoOnlyHonourPreset(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.PATIENCE_AUTO_ONLY_HONOUR_PRESET); }
export function telegramAutoRouteDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.TELEGRAM_AUTO_ROUTE_DISABLED); }

/**
 * Roster 2026-10-06 A-3 (platform/lane-depth.ts routeResearchLane): the turn plan re-routed an Auto send —
 * 'turn_plan_research' = a confident research lane routed to Level 3; 'turn_plan_lane' = a keyword Level 3 the
 * turn plan does not call research was retired to Ensemble. Both carry source 'turn_plan'.
 */
export type LaneRouteReasonKey = 'turn_plan_research' | 'turn_plan_lane';

export interface SendRouting {
  level: string; reason: string; suggestCode: boolean;
  reasonKey?: AutoRouteReasonKey | LaneRouteReasonKey; source?: string; clamped?: string; requestedMode?: string; modeSource?: ModeSource; confidence?: number; backend?: string;
}

export interface ResolveSendModeInput {
  /** The wire / requested mode: 'auto', a level, a legacy alias, 'browser_agent', or undefined (⇒ the stored mode). */
  mode: string | undefined | null;
  /** The chat's STORED mode (platform seam; the stream controller passes none — its mode is always explicit). */
  storedMode?: string | null;
  userId: string | null | undefined;
  /** The quota client ip for a GUEST allowance — a thunk so it is only read on the auto path (a harness request may carry no headers). */
  clientIp?: string | (() => string);
  isChild?: boolean;
  isSupervisorChat?: boolean;
  /** A Dig-deeper escalation: the rung IS the level — nothing here applies. */
  escalation?: boolean;
  origin: SendOrigin;
  /** No persisted chat row (Telegram): never Level 3 (nothing to post a council answer to). */
  chatless?: boolean;
  content: string;
  /** Lazy — only the router reads it. */
  hasWorkspace?: () => Promise<boolean>;
  sessionId?: string;
  modeSource?: ModeSource;
}

export interface ResolvedSendMode {
  /** The level the run gets ('browser_agent' / a kid send pass through untouched). */
  mode: string;
  routing?: SendRouting;
  routingSource?: string;
  /** patience_auto_only forced this explicit level to Auto. */
  autoOnly: boolean;
  /** The Auto router picked the level (explicit 'auto', stored 'auto' or forced by the switch). */
  autoRouted: boolean;
  requestedMode?: string;
  segment: AutoRouteSegment;
  /** Non-null when a `picked` explicit level should feed the label window once the send is admitted (actual = that level). */
  labelWindowLevel: RoutableLevel | null;
  /** A floor / clamp applied after the level was chosen (audit only). */
  floored?: 'channel_floor' | 'supervisor_no_research' | 'chatless_no_research';
  /**
   * The Level 3 ALLOWANCE verdict of an Auto-routed send (set on the auto path only — explicit levels carry none).
   * routing.clamped exists only when the router itself picked Level 3, so a guest / quota-exhausted sender whose
   * router said Level 2 carries no clamp — the turn plan's research route (platform/lane-depth.ts routeResearchLane,
   * A-3) reads THIS verdict so it never lane-routes a sender to a council the router would not have given them
   * (2026-10-20: the guest gap — `guest_no_research` keeps guests off Level 3 on every route, not only the keyword one).
   */
  allowDeepResearch?: boolean;
  allowDeepResearchReason?: DeepResearchDenyReason;
}

/** The sender segment every telemetry row agrees on (auto_route + compute_policy rows used to disagree on supervisor chats). */
export function sendSegment(i: Pick<ResolveSendModeInput, 'userId' | 'isSupervisorChat' | 'origin'>): AutoRouteSegment {
  if (i.isSupervisorChat) return 'supervisor';
  if (!isHumanSendOrigin(i.origin)) return 'machine';
  if (i.origin === 'telegram') return 'telegram';
  return i.userId ? 'user' : 'guest';
}

const LEVELS: readonly string[] = ['single_thinking', 'thinking', 'deep_research'];

/** An explicit / stored value → the level it names ('auto' stays 'auto'; legacy ids alias; unknown ⇒ L1 — storedModeToPreset). */
function toLevelOrAuto(mode: unknown): RoutableLevel | 'auto' {
  const m = normalizePatienceMode(String(mode ?? '').trim());
  if (m === AUTO_MODE) return 'auto';
  return storedModeToPreset(m);
}

/** Ensemble-floor a routing card (the level is rewritten, the audit string says why). Pure. */
export function floorRouting(routing: SendRouting | undefined, reasonKey: DeepResearchDenyReason, why: string): SendRouting | undefined {
  if (!routing) return routing;
  if (routing.level !== 'deep_research') return routing;
  return { ...routing, level: 'thinking', reasonKey, clamped: clampFor(reasonKey), reason: `${routing.reason} — ${why}` };
}

/**
 * Resolve one send. Never throws (every reader fails toward the safer, cheaper
 * level). The caller still RESERVES the deep-research quota for a resolved
 * Level 3 and demotes on refusal (`demoteForQuota`).
 */
export async function resolveSendMode(input: ResolveSendModeInput): Promise<ResolvedSendMode> {
  const userId = input.userId ?? null;
  const human = isHumanSendOrigin(input.origin);
  const segment = sendSegment({ userId, isSupervisorChat: input.isSupervisorChat, origin: input.origin });
  const base: ResolvedSendMode = { mode: String(input.mode ?? input.storedMode ?? 'auto'), autoOnly: false, autoRouted: false, segment, labelWindowLevel: null };

  // Pass-throughs: browser automation, kids (their pipeline never routes), escalations (the rung is the level).
  const rawMode = String(input.mode ?? '').trim();
  if (rawMode === 'browser_agent') return { ...base, mode: 'browser_agent' };
  if (input.isChild) return { ...base, mode: rawMode || toLevelOrAuto(input.storedMode) };
  if (input.escalation) return { ...base, mode: rawMode, routingSource: 'escalation' };

  // Telegram (chatless human): route like a web send unless the kill switch keeps Level 1.
  if (input.origin === 'telegram' && telegramAutoRouteDisabled()) return { ...base, mode: 'single_thinking', routingSource: 'user_explicit' };

  let requested: RoutableLevel | 'auto' = input.mode != null && rawMode ? toLevelOrAuto(rawMode) : toLevelOrAuto(input.storedMode ?? 'auto');
  const storedAuto = input.mode == null && requested === 'auto';
  let autoOnly = false;
  let requestedMode: string | undefined;

  // patience_auto_only (patience plan §3.1): every HUMAN send into a non-supervisor
  // chat that carries an explicit level is routed as Auto (the level survives as
  // routing.requestedMode). Kids / supervisor chats / browser_agent never.
  // The REST + tool seam honours it too (settings-switches-3) unless
  // PATIENCE_AUTO_ONLY_REST_DISABLED=1 keeps the old SSE-only rule.
  if (human && requested !== 'auto' && !input.isSupervisorChat && !(input.origin === 'rest' && patienceAutoOnlyRestDisabled())) {
    try { autoOnly = await getPatienceAutoOnly(); } catch { autoOnly = false; }
    if (autoOnly && !!userId && input.modeSource === 'default' && patienceAutoOnlyHonourPreset()) {
      // Opt-in only: the stored Advanced preset is the explicit level (the explicit
      // branch below stamps routingSource user_default; no router, no label window).
      logger.info(`send-mode: auto-only honouring the signed-in Advanced preset mode=${requested} (userId=${userId})`);
    } else if (autoOnly) { requestedMode = requested; requested = 'auto'; }
  }

  // A picked explicit level is a human label of this message whether or not
  // the switch then routes it (settings-switches-4 option A).
  const labelWindowLevel: RoutableLevel | null =
    human && !!userId && !input.isSupervisorChat && input.modeSource === 'picked' && (requestedMode ?? (requested !== 'auto' ? requested : null)) && LEVELS.includes(String(requestedMode ?? requested))
      ? ((requestedMode ?? requested) as RoutableLevel)
      : null;

  if (requested === 'auto') {
    // Machine senders into a stored-'auto' chat run the L2 preset fallback (the
    // compute policy decides the rest inside the run) — the router is for humans.
    if (!human && storedAuto) {
      return { ...base, mode: 'thinking', autoOnly, autoRouted: false, requestedMode, labelWindowLevel };
    }
    // §3.4 quota- and auth-aware allowance on EVERY auto send (routing-unify-1).
    let allowDeepResearch = true;
    let allowDeepResearchReason: DeepResearchDenyReason | undefined;
    if (!human) {
      allowDeepResearch = machineDeepResearchFloorDisabled() && input.origin !== 'webhook';
      allowDeepResearchReason = 'channel_floor';
    } else if (input.isSupervisorChat && !supervisorAutoResearchEnabled()) {
      allowDeepResearch = false;
      allowDeepResearchReason = 'supervisor_no_research';
    } else if (input.chatless) {
      allowDeepResearch = false;
      allowDeepResearchReason = 'chatless_no_research';
    } else if (autoOnly || !autoRouteAllowanceDisabled()) {
      let clientIp: string | undefined;
      try { clientIp = typeof input.clientIp === 'function' ? input.clientIp() : input.clientIp; } catch { clientIp = undefined; }
      const allowance = await deepResearchAllowance({ userId: userId ?? undefined, clientIp, strict: true }).catch(() => ({ allowed: false, reasonKey: 'quota_unavailable' as const }));
      allowDeepResearch = allowance.allowed;
      allowDeepResearchReason = allowance.reasonKey;
    }
    const hasWorkspace = input.hasWorkspace ? await input.hasWorkspace().catch(() => false) : false;
    const decision = await routeMessageAuto({
      content: input.content, hasWorkspace, sessionId: input.sessionId,
      allowDeepResearch, allowDeepResearchReason, segment, modeSource: input.modeSource, requestedMode,
    });
    const routing: SendRouting = {
      level: decision.level, reason: decision.reason, suggestCode: decision.suggestCode,
      reasonKey: decision.reasonKey, source: decision.source,
      ...(decision.clamped ? { clamped: decision.clamped } : {}),
      ...(decision.confidence !== undefined ? { confidence: decision.confidence } : {}),
      ...(decision.backend ? { backend: decision.backend } : {}),
      ...(requestedMode ? { requestedMode } : {}),
      ...(input.modeSource ? { modeSource: input.modeSource } : {}),
    };
    logger.info(`send-mode: origin=${input.origin} userId=${userId || 'anon'} level=${decision.level} source=${decision.source} reasonKey=${decision.reasonKey}${decision.clamped ? ` clamped=${decision.clamped}` : ''}${requestedMode ? ` requestedMode=${requestedMode}` : ''} segment=${segment} suggestCode=${decision.suggestCode} reason="${decision.reason}"`);
    return {
      ...base, mode: decision.level, routing, routingSource: `auto_${decision.source}`, autoOnly, autoRouted: true, requestedMode, labelWindowLevel,
      allowDeepResearch, ...(!allowDeepResearch && allowDeepResearchReason ? { allowDeepResearchReason } : {}),
    };
  }

  // An explicit / stored level.
  let mode: string = requested;
  let floored: ResolvedSendMode['floored'];
  let routing: SendRouting | undefined;
  if (mode === 'deep_research') {
    if (!human && (input.origin === 'webhook' || !machineDeepResearchFloorDisabled())) {
      mode = 'thinking'; floored = 'channel_floor';
    } else if (human && input.isSupervisorChat && !supervisorAutoResearchEnabled()) {
      mode = 'thinking'; floored = 'supervisor_no_research';
    } else if (human && input.chatless) {
      mode = 'thinking'; floored = 'chatless_no_research';
    }
    if (floored) {
      routing = { level: 'thinking', reason: `explicit deep_research floored to Ensemble (${floored.replace(/_/g, ' ')})`, suggestCode: false, reasonKey: floored, clamped: clampFor(floored), requestedMode: 'deep_research' };
      logger.info(`send-mode: origin=${input.origin} userId=${userId || 'anon'} explicit deep_research floored → thinking (${floored})`);
    }
  }
  return {
    ...base, mode, routing, autoOnly, autoRouted: false, requestedMode, labelWindowLevel, ...(floored ? { floored } : {}),
    // Machine origins are stamped 'machine' by the run itself; a SIGNED-IN human's
    // explicit level notes how it was chosen (guests carry none — nothing labels them).
    ...(human && userId ? { routingSource: labelWindowNote(input.modeSource) } : {}),
  };
}

/**
 * The Ensemble demotion after a LOST deep-research reserve (the atomic guard at
 * the run site refused): every seam applies the same rewrite — never an error
 * for an Auto-routed Level 3 (patience plan §3.4 "Auto never errors a user on
 * quota"). Pure.
 */
export function demoteForQuota(routing: SendRouting | undefined): { mode: 'thinking'; routing: SendRouting } {
  const r: SendRouting = routing ?? { level: 'deep_research', reason: 'deep research', suggestCode: false };
  return { mode: 'thinking', routing: { ...r, level: 'thinking', reasonKey: 'quota_exhausted', clamped: 'quota', reason: `${r.reason} — demoted to Ensemble (deep research quota)` } };
}
