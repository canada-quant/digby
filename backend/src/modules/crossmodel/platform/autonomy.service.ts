/**
 * Fleet supervisor (slice A) — per-chat AUTONOMY allowlist.
 *
 * A ChatAutonomy row (PK == crossmodel_chats.id) records which CONSEQUENTIAL
 * platform tools a chat may execute WITHOUT per-call confirmation. The bypass
 * applies to MACHINE-TRIGGERED runs (schedule firings, hook wakes — runs with
 * no ctx.userTurnAt, which otherwise can never pass the user-turn-anchored
 * confirmation gate in platform-tools.ts) AND, since 2026-08-07 (owner
 * directive; feedback f71b97d2/a631cfb3), to USER-ANCHORED runs — an explicit
 * owner grant means "this chat may do these things autonomously", so the gate
 * honors it in every run type. The row also carries the chat's
 * scheduled-firings-per-day cap (schedule.service reads it instead of the
 * global 48).
 *
 * Security posture (docs/FLEET_SUPERVISOR_DESIGN.md §1/§6):
 *   - Grant/revoke happens ONLY via the set_chat_autonomy consequential tool —
 *     itself EXCLUDED from the bypass in every run type (always
 *     new-user-message-anchored), so a machine-triggered run — or injected
 *     tool content in any run — can never escalate a chat's autonomy.
 *   - Subset exception (2026-09-11, ticket 9341e862): set_chat_autonomy still
 *     cards in every run type EXCEPT a SELF-request that cannot widen the
 *     caller's own authority — within the Agent-mode-Auto template it is an
 *     honest no-op (nothing written), and a subset/shrink/revoke of an
 *     existing stored grant auto-executes. Widening requests (new tools,
 *     higher cap) and ALL cross-chat grants stay carded. See
 *     selfGrantSubsetVerdict — fail-closed on any uncertainty.
 *   - Scoped cross-chat delegation (ticket eb4337fe, ruling oq_2674964f):
 *     the ONE cross-chat exception — a supervisor-class granter (Fleet
 *     Supervisor, or a project supervisor within its own project) may grant
 *     a SAME-OWNER supervised lane a subset of the granter's own effective
 *     authority, card-free (source 'machine_delegated'). Six scope guards
 *     (kill switch, resolvable non-self target, supervisor-class granter,
 *     same owner, project-scoped for project supervisors, tools/cap ⊆ the
 *     granter's effective set) — see supervisorDelegationVerdict. Everything
 *     else cross-chat still cards.
 *   - Owner-only: a scheduled/autonomous run executes with the CHAT OWNER's
 *     identity and tools, so letting a mere project member grant autonomy
 *     would be a confused deputy (same rationale as scheduleChatRun).
 *   - Revocation is immediate: the gate does a PK lookup per call, no cache.
 *   - Every grant/revoke writes an Activity audit row (resource 'platform'),
 *     best-effort (mirrors platform.service's audit helper).
 *   - EXCEPTION to "only via set_chat_autonomy" (owner 2026-09-07): a CODING
 *     chat whose Agent mode is AUTO gets the full grant materialized
 *     automatically (syncAutonomyWithAgentMode, source 'agent_mode_auto') and
 *     revoked when the mode leaves Auto. Setting the mode is itself an
 *     owner-only, user-driven action, so the no-self-escalation posture holds:
 *     a machine run still cannot widen its own authority.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import crossModelService from '../crossmodel.service';
import { isFullChatIdShape, nearMatchChatId, NEAR_MATCH_PREFIX_CHARS } from './chat-id-near-match';

/**
 * Gate flip 2026-09-11 (owner: full steam) — G19 schedule-target resolution
 * accepts the SAME unique ≥8-char prefix the schedule tools themselves invite
 * (cancel_schedule / update_schedule descriptions; the executor's
 * resolveScheduleIdForUser honours it). 7/7 staged schedule confirmations
 * since 09-08 were 8-char prefixes that would have passed on the full id.
 * Local mirror of coding/schedule.service resolveScheduleIdForUser
 * (MIN_SCHEDULE_ID_PREFIX_LEN = 8) — schedule.service dynamically imports THIS
 * module, so a static back-edge would be a cycle and would drag the scheduler
 * graph into every autonomy test. Owner-scoped in every query; an AMBIGUOUS
 * prefix resolves to null (fail-closed → the confirmation path), never to a
 * guess. Returns the schedule's chat, or null when nothing (or >1) matches.
 * Exported (autonomy loop #10, 2026-09-20) for platform-tools' staging-time
 * doomed-action check on update_schedule / cancel_schedule.
 */
const SCHEDULE_ID_PREFIX_MIN = 8;
export async function resolveOwnedScheduleTarget(userId: string, idOrPrefix: string): Promise<{ sessionId: string } | null> {
  const id = String(idOrPrefix || '').trim();
  if (!id) return null;
  const exact = await prisma.codingSchedule.findFirst({
    where: { id, userId },
    select: { sessionId: true },
  });
  if (exact) return exact;
  if (id.length < SCHEDULE_ID_PREFIX_MIN) return null;
  const matches = await prisma.codingSchedule.findMany({
    where: { userId, id: { startsWith: id } },
    select: { id: true, sessionId: true },
    take: 2,
  });
  if (!Array.isArray(matches) || matches.length !== 1) return null; // none, or ambiguous — fail closed
  return { sessionId: matches[0].sessionId };
}

/**
 * Schedule-id SELF-CORRECTION (autonomy loop #16, 2026-09-21). 88 update_schedule
 * calls in 48 h from five lanes were refused 'unresolved' — receipts carry
 * ids: {} (a placeholder: "none", "n/a", "00000000"…), and one lane retried the
 * same bad id five times in three minutes. The refusal text named no real id,
 * so nothing let the model correct itself. Two affordances:
 *   - SUBSTITUTE: update_schedule (never cancel) with an unresolvable id, when
 *     the CALLING chat has exactly ONE enabled machine-authored schedule → that
 *     schedule (the only thing "my schedule" can mean; same owner, same chat —
 *     the lane's own work).
 *   - LIST: otherwise the refusal carries the caller chat's schedules (id,
 *     kind, cadence, next fire, status) so the next call can name a real one.
 */
export interface CallerScheduleCandidate {
  id: string; kind: string; enabled: boolean; intervalSec: number | null;
  nextRunAt: Date | null; lastStatus: string | null; promptSetBy: string | null;
}
export type ScheduleForCaller =
  | { kind: 'resolved'; id: string }
  | { kind: 'substituted'; id: string; passed: string }
  | { kind: 'none'; passed: string; candidates: CallerScheduleCandidate[] };

async function resolveOwnedScheduleId(userId: string, idOrPrefix: string): Promise<string | null> {
  const id = String(idOrPrefix || '').trim();
  if (!id) return null;
  const exact = await prisma.codingSchedule.findFirst({ where: { id, userId }, select: { id: true } });
  if (exact) return exact.id;
  if (id.length < SCHEDULE_ID_PREFIX_MIN) return null;
  const matches = await prisma.codingSchedule.findMany({ where: { userId, id: { startsWith: id } }, select: { id: true }, take: 2 });
  return Array.isArray(matches) && matches.length === 1 ? matches[0].id : null;
}

export async function listCallerSchedules(userId: string, callerChatId: string): Promise<CallerScheduleCandidate[]> {
  const rows = await prisma.codingSchedule.findMany({
    where: { userId, sessionId: callerChatId },
    orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }],
    take: 5,
    select: { id: true, kind: true, enabled: true, intervalSec: true, nextRunAt: true, lastStatus: true, promptSetBy: true },
  });
  return (Array.isArray(rows) ? rows : []) as CallerScheduleCandidate[];
}

export async function resolveScheduleForCaller(userId: string, callerChatId: string, idOrPrefix: string, tool: string): Promise<ScheduleForCaller> {
  const passed = String(idOrPrefix ?? '').trim();
  const resolved = await resolveOwnedScheduleId(userId, passed).catch(() => null);
  if (resolved) return { kind: 'resolved', id: resolved };
  const candidates = await listCallerSchedules(userId, callerChatId).catch(() => [] as CallerScheduleCandidate[]);
  if (tool === 'update_schedule') {
    const own = candidates.filter((c) => c.enabled && c.promptSetBy === 'machine');
    if (own.length === 1) {
      return { kind: 'substituted', id: own[0].id, passed };
    }
  }
  return { kind: 'none', passed, candidates };
}

/** One line per candidate for the refusal text — the model can copy a real id from it. */
export function describeCallerSchedules(candidates: CallerScheduleCandidate[]): string {
  if (!candidates.length) return '';
  const lines = candidates.map((c) => {
    const cadence = c.kind === 'recurring' && c.intervalSec ? `every ${Math.round(c.intervalSec / 60)} min` : c.kind;
    const next = c.nextRunAt ? new Date(c.nextRunAt).toISOString().slice(11, 16) + 'Z' : '—';
    return `${c.id} (${cadence}, next ${next}, ${c.lastStatus ?? 'new'}, ${c.enabled ? 'enabled' : 'disabled'}${c.promptSetBy ? `, set by ${c.promptSetBy}` : ''})`;
  });
  return `THIS chat's schedules — pass one of these full ids: ${lines.join('; ')}.`;
}

/**
 * Owner pending-card incident 2026-09-14 (rollout watch): five machine lanes'
 * send_chat_message calls to SAME-OWNER siblings / their own parent staged
 * confirmation cards the owner had to click ("that defeats the whole purpose
 * of the autonomy"). Every one of them named the target with the fleet's
 * 8-char idiom ("cec340f2", "daee2916") — the scope checks below looked the
 * target up with findUnique on that prefix, got null, and telemetered
 * 'foreign_owner' (17 refusals from 9 lanes in one day, ALL same-owner). The
 * executor did NOT resolve it either (crossmodel.service getChatById is an
 * exact lookup) — the same change added platform.service
 * resolveOwnedChatIdPrefix in front of sendChatMessage / scheduleChatRun
 * (platform-tools.ts) so the gate and the tool agree on the very id the tool
 * description invites. Keep the two resolvers in step: removing the executor
 * hop re-opens the gap (gate allows, executor 404s into did-you-mean).
 *
 * Resolve a chat target the way the executor does: exact id first (ANY
 * owner — the owner check happens on the resolved row so a foreign exact id
 * still surfaces as 'foreign_owner'), else a UNIQUE ≥8-char prefix scoped to
 * the caller's own chats (a prefix can never resolve to a foreign chat;
 * ambiguity fails closed → the confirmation path). A full-length (36-char)
 * miss — a reconstructed/corrupted UUID — never resolves: the executor would
 * 404 it too.
 */
const CHAT_ID_PREFIX_MIN = 8;
export type ChatTargetRow = { id: string; parentChatId: string | null; userId: string };
/**
 * Exported since 2026-09-18 for the gate's staging-time target validation
 * (platform-tools: a send_chat_message whose target cannot be resolved is
 * REFUSED with a did-you-mean instead of carding the owner). Owner 2026-09-18
 * ("aren't all these messages machine to machine to go autonomously?"): a
 * FULL-shape id that misses exactly now resolves to the ONE same-owner chat
 * sharing its 8-char prefix within NEAR_MATCH_MAX_DISTANCE characters
 * (chat-id-near-match.ts) — every card the owner had been clicking through
 * was a lane re-typing one hex character of a real id ('unresolved' ×48 in a
 * week, foreign targets ×0). Ambiguity still fails closed.
 */
export async function resolveChatTarget(userId: string, idOrPrefix: string): Promise<ChatTargetRow | null> {
  const id = String(idOrPrefix || '').trim();
  if (!id) return null;
  const exact = await prisma.crossModelChat.findUnique({
    where: { id },
    select: { parentChatId: true, userId: true },
  });
  if (exact) return { id, parentChatId: exact.parentChatId ?? null, userId: exact.userId };
  if (isFullChatIdShape(id)) {
    const candidates = (await prisma.crossModelChat.findMany({
      where: { userId, id: { startsWith: id.slice(0, NEAR_MATCH_PREFIX_CHARS).toLowerCase() } },
      select: { id: true, parentChatId: true, userId: true },
      take: 8,
    })) as Array<{ id: string; parentChatId: string | null; userId: string }>;
    const hit = nearMatchChatId(candidates, id);
    return hit ? { id: hit.id, parentChatId: hit.parentChatId ?? null, userId: hit.userId } : null;
  }
  if (id.length < CHAT_ID_PREFIX_MIN) return null;
  if (id.length >= 36) return healChatTarget(userId, id);
  const matches = await prisma.crossModelChat.findMany({
    where: { userId, id: { startsWith: id } },
    select: { id: true, parentChatId: true, userId: true },
    take: 2,
  });
  if (Array.isArray(matches) && matches.length > 1) return null; // ambiguous — fail closed
  if (!Array.isArray(matches) || matches.length !== 1) return healChatTarget(userId, id);
  return { id: matches[0].id, parentChatId: matches[0].parentChatId ?? null, userId: matches[0].userId };
}

/**
 * audit 2026-10-08 W3-3: the gate heals exactly what the executor heals
 * (platform.service resolveOwnedChatIdPrefix → platform/id-ref.ts): a ≥8-char
 * suffix, a prefix+suffix splice — OWNER-scoped, ambiguity fails closed.
 * Keeping the two in step is the 2026-09-14 rule above. ID_RESOLVER_HEAL_DISABLED=1.
 */
async function healChatTarget(userId: string, raw: string): Promise<ChatTargetRow | null> {
  try {
    const { healIdRef } = await import('./id-ref');
    const r = await healIdRef(raw, {
      byPrefix: async (prefix, take) => (((await prisma.crossModelChat.findMany({ where: { userId, id: { startsWith: prefix } }, select: { id: true }, take })) ?? []) as Array<{ id: string }>).map((x) => x.id),
      bySuffix: async (suffix, take) => (((await prisma.crossModelChat.findMany({ where: { userId, id: { endsWith: suffix } }, select: { id: true }, take })) ?? []) as Array<{ id: string }>).map((x) => x.id),
    }, 'chat_target');
    if (!r.ok) return null;
    const row = await prisma.crossModelChat.findUnique({ where: { id: r.id }, select: { parentChatId: true, userId: true } });
    return row && row.userId === userId ? { id: r.id, parentChatId: row.parentChatId ?? null, userId: row.userId } : null;
  } catch {
    return null;
  }
}

/** The consequential tools a chat may be granted autonomy for (set_chat_autonomy itself is NEVER grantable). */
export const AUTONOMY_GRANTABLE_TOOLS = [
  'send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule', 'update_schedule',
  // dispatch_platform_task (2026-08-22): grantable — a machine-triggered run
  // needs the grant or it stages a confirmation; that's intended.
  'dispatch_platform_task',
  // send_to_instance (Digby Edge Phase 5, 2026-08-30): grantable — a
  // machine-triggered fleet run may push to a paired edge instance unattended
  // when the owner granted it; the depth counter still bounds the chain.
  'send_to_instance',
  // control tools (capability gap audit P0, 2026-09-24): a supervisor seat is
  // pre-granted all five (repairAutonomyIfMissing's union-heal adds them to
  // pre-existing supervisor rows); approve_request still refuses ask-only
  // tools in machine runs at execution.
  'stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule',
  // T3b (capability gap audit, 2026-09-24): standing instructions on a TARGET
  // chat, and the two repo-bootstrap tools (GitHub credential + clone compute).
  // Supervisor seats receive them via grantFullAutonomy / the union-heal.
  'set_chat_instructions', 'configure_workspace', 'import_repo',
] as const;

export const DEFAULT_SCHEDULE_CAP = 48;
// 2026-08-08 (owner directive, feedback 5fd3ada5: "i don't want caps, digby
// coding needs to be fully autonomous"): ceiling raised 288 → 1440. With the
// 15-min minimum schedule interval a single schedule fires ≤96×/day and a chat
// caps at ~5 active schedules (~480/day), so 1440 is effectively uncapped for
// legitimate autonomy while still backstopping a true runaway-firing bug.
// 2026-08-13: the backstop now covers HOOK WAKES too — deliverHookGroup
// (hooks.service) consumes the same dailyCapExceeded budget as schedule
// firings, so scheduleCap genuinely bounds a chat's total machine runs/day
// (hook deliveries previously bypassed every cap; the 60s debounce was the
// only brake on the supervisor's dominant wake source).
export const MAX_SCHEDULE_CAP = 1440;

/**
 * Grant provenance (owner 2026-09-07 auto-grant). 'manual' = owner-curated via
 * the Autonomy dialog / set_chat_autonomy — Agent-mode flips NEVER touch it.
 * 'agent_mode_auto' = materialized by syncAutonomyWithAgentMode because the
 * coding chat's Agent mode is Auto (#306: auto-mode = full autonomy) — revoked
 * automatically when the mode leaves Auto, and converted to 'manual' by any
 * manual save (so a later flip can't clobber an owner-curated set).
 */
export const AUTONOMY_SOURCE_MANUAL = 'manual';
export const AUTONOMY_SOURCE_AGENT_MODE = 'agent_mode_auto';
/**
 * Grant provenance (ticket eb4337fe, ruling oq_2674964f — Fleet Supervisor
 * answered under the owner's standing directives 2026-09-13 "APPROVE BOTH,
 * STOP ASKING ME SO MUCH…" / 2026-09-12 "CLEAR GATES ALWAYS ON MY BEHALF"):
 * 'machine_delegated' = a supervisor-class lane (the Fleet Supervisor, or a
 * project supervisor WITHIN its own project) granted a supervised lane a
 * subset of the supervisor's own effective authority via
 * delegateChatAutonomy — no owner card. The six scope guards in
 * supervisorDelegationVerdict bound it; the row is NOT a grant the target
 * wrote for itself and is treated like a curated row by Agent-mode flips
 * (syncAutonomyWithAgentMode never widens or deletes it).
 */
export const AUTONOMY_SOURCE_MACHINE_DELEGATED = 'machine_delegated';

export interface ChatAutonomyView {
  allowedTools: string[];
  scheduleCap: number;
  /** 'manual' | 'agent_mode_auto' — see AUTONOMY_SOURCE_* above. */
  source: string;
}

/** Best-effort audit trail (Activity, resource 'platform') — mirrors platform.service. */
async function audit(userId: string, action: string, metadata?: Record<string, any>): Promise<void> {
  try {
    await prisma.activity.create({
      data: { userId, action, resource: 'platform', ...(metadata ? { metadata } : {}) },
    });
  } catch (err: any) {
    logger.warn(`platform audit write failed (${action}): ${err.message}`);
  }
}

/**
 * Read a chat's autonomy grant (PK lookup). NULL = no grant — the normal
 * confirmation gate applies. Called per gated tool call, so revocation takes
 * effect immediately.
 */
export async function getChatAutonomy(chatId: string): Promise<ChatAutonomyView | null> {
  const row = await prisma.chatAutonomy.findUnique({
    where: { chatId },
    select: { allowedTools: true, scheduleCap: true, source: true },
  });
  return row ? { allowedTools: row.allowedTools, scheduleCap: row.scheduleCap, source: row.source } : null;
}

/**
 * Grant (or revoke — empty allowedTools) a chat's autonomy. Owner-only.
 * Throws AppError on unknown chat / non-owner / invalid tool names.
 *
 * Every save through here is a MANUAL curation (dialog PUT or the confirmed
 * set_chat_autonomy tool): the row is stamped source 'manual', which also
 * CONVERTS an agent-mode auto-granted row to manual — after an owner edits the
 * set by hand, Agent-mode flips no longer touch it (owner 2026-09-07).
 */
export async function setChatAutonomy(opts: {
  userId: string;
  chatId: string;
  allowedTools: string[];
  scheduleCap?: number;
  /**
   * INTERNAL provenance override (eb4337fe): every existing caller (dialog
   * PUT, the confirmed set_chat_autonomy tool) omits it and stamps 'manual'.
   * delegateChatAutonomy passes AUTONOMY_SOURCE_MACHINE_DELEGATED so the row
   * stays attributable to the supervising granter and survives mode flips
   * like a curated row.
   */
  source?: string;
}): Promise<{ granted: boolean; chatId: string; allowedTools: string[]; scheduleCap: number | null; source: string | null }> {
  const { userId, chatId } = opts;
  const source = opts.source ?? AUTONOMY_SOURCE_MANUAL;
  if (!chatId) throw new AppError(400, 'chatId is required');

  // Owner-only (mirrors platform.service.scheduleChatRun's access check).
  const { access, exists } = await crossModelService.getChatAccess(chatId, userId);
  if (!exists) throw new AppError(404, 'Chat not found');
  if (access !== 'owner') {
    throw new AppError(access === 'none' ? 404 : 403,
      access === 'none' ? 'Chat not found' : 'Only the chat owner can grant autonomy for it');
  }

  // allowedTools ⊆ the grantable consequential tools (deduped, order-stable).
  const grantable = new Set<string>(AUTONOMY_GRANTABLE_TOOLS);
  const allowedTools: string[] = [];
  for (const raw of opts.allowedTools ?? []) {
    const t = String(raw);
    if (!grantable.has(t)) {
      throw new AppError(400, `Invalid tool "${t}" — allowedTools must be a subset of: ${AUTONOMY_GRANTABLE_TOOLS.join(', ')}`);
    }
    if (!allowedTools.includes(t)) allowedTools.push(t);
  }

  // scheduleCap: finite number, clamped 1..MAX_SCHEDULE_CAP.
  let scheduleCap: number | undefined;
  if (opts.scheduleCap !== undefined && opts.scheduleCap !== null) {
    const n = Number(opts.scheduleCap);
    if (!Number.isFinite(n)) throw new AppError(400, `scheduleCap must be a number (1..${MAX_SCHEDULE_CAP})`);
    scheduleCap = Math.min(MAX_SCHEDULE_CAP, Math.max(1, Math.round(n)));
  }

  // Empty allowlist = REVOKE: delete the row (idempotent) so the confirmation
  // gate applies to machine-triggered runs again.
  if (allowedTools.length === 0) {
    await prisma.chatAutonomy.deleteMany({ where: { chatId } });
    await audit(userId, 'autonomy.revoke', { chatId });
    logger.info(`autonomy: revoked for chat ${chatId.slice(0, 8)} by user ${userId.slice(0, 8)}`);
    return { granted: false, chatId, allowedTools: [], scheduleCap: null, source: null };
  }

  const row = await prisma.chatAutonomy.upsert({
    where: { chatId },
    create: {
      chatId, userId, allowedTools, source,
      ...(scheduleCap !== undefined ? { scheduleCap } : {}),
    },
    update: {
      userId, allowedTools, source,
      ...(scheduleCap !== undefined ? { scheduleCap } : {}),
    },
    select: { allowedTools: true, scheduleCap: true },
  });
  await audit(userId, 'autonomy.grant', { chatId, allowedTools: row.allowedTools, scheduleCap: row.scheduleCap });
  logger.info(`autonomy: granted [${row.allowedTools.join(', ')}] for chat ${chatId.slice(0, 8)} by user ${userId.slice(0, 8)} (cap ${row.scheduleCap}/day)`);
  return { granted: true, chatId, allowedTools: row.allowedTools, scheduleCap: row.scheduleCap, source };
}

// ── Self-grant subset auto-approve (ticket 9341e862, owner 2026-09-11) ──────

/**
 * Verdict for a set_chat_autonomy call, consulted by the platform-tools gate
 * BEFORE it stages an owner confirmation card. Owner complaint 2026-09-11
 * (9341e862): "isnt that agent session alreayd set to Auto ? doesnt Auto
 * selection already auto apprvoe all autonomy in fully" — an Agent-mode-Auto
 * coding lane asking for the standard fleet scope got a per-chat grant card
 * even though the mode ALREADY covers that scope at run time (the db747817
 * gate waiver + the materialized 'agent_mode_auto' row), because
 * set_chat_autonomy sits in NEVER_AUTONOMOUS_TOOLS and always carded.
 *
 * The anti-self-escalation invariant is preserved by CONSTRUCTION — a request
 * bypasses the card ONLY when it cannot widen the caller's own authority:
 *   - SELF only (chatId === the calling chat): every cross-chat grant cards —
 *     EXCEPT the scoped supervisor delegation (eb4337fe), a SECOND
 *     authority-neutral exception handled by supervisorDelegationVerdict in
 *     the gate after this verdict returns 'beyond';
 *   - requested tools ⊆ the caller's CURRENT effective autonomy (the mode
 *     template for an auto-mode coding orchestrator, else the stored grant);
 *   - requested scheduleCap (when given), clamped like setChatAutonomy clamps,
 *     ≤ the current effective cap (a raise is a real widening — it cards).
 * Everything else — new tools, higher caps, malformed args, a grant-row READ
 * failure — returns 'beyond' and stages exactly as before (fail-closed).
 *
 * Verdicts:
 *   - 'mode_covered'  — the request is already true at run time: an
 *     auto-mode coding orchestrator asking within the mode template, OR any
 *     caller asking a covered non-empty set against an AUTO-SOURCED row
 *     (mode-managed — writing it would stamp 'manual' and detach the grant
 *     from the Agent-mode lifecycle). The gate answers an honest
 *     already-covered no-op and writes NOTHING.
 *   - 'within_grant'  — the request is a subset of / equal to / a shrink of
 *     the caller's stored MANUAL grant (empty array = self-revoke, always
 *     within — shrinking needs no owner): the gate executes it without a
 *     card. A self-revoke against an auto-sourced row also executes — the
 *     dispatcher's mode_auto_implies_autonomy guard gives the honest answer.
 *   - 'beyond'        — stage the owner confirmation card, unchanged.
 */
export type SelfGrantSubsetVerdict =
  | { kind: 'mode_covered'; effectiveCap: number }
  | { kind: 'within_grant' }
  | { kind: 'beyond' };

export async function selfGrantSubsetVerdict(opts: {
  callerChatId: string;
  args: { chatId?: any; allowedTools?: any; scheduleCap?: any };
  /** The calling run is an auto-mode coding ORCHESTRATOR (the same conjuncts as the gate's db747817 waiver). */
  modeAuthority: boolean;
}): Promise<SelfGrantSubsetVerdict> {
  const { callerChatId, args, modeAuthority } = opts;
  const beyond: SelfGrantSubsetVerdict = { kind: 'beyond' };
  try {
    if (!callerChatId || String(args?.chatId || '') !== callerChatId) return beyond; // cross-chat always cards FROM THIS VERDICT (the eb4337fe delegation exception is the gate's supervisorDelegationVerdict, consulted after this returns 'beyond')
    if (!Array.isArray(args?.allowedTools)) return beyond; // malformed — the staged path validates as today
    const requestedTools: string[] = [];
    for (const raw of args.allowedTools) {
      const t = String(raw);
      if (!requestedTools.includes(t)) requestedTools.push(t);
    }
    // Live PK read, no cache (revocation immediacy). A read FAILURE throws →
    // fail closed into staging; only a genuine null (no row) is "no grant".
    const row = await getChatAutonomy(callerChatId);
    const effectiveCap = row?.scheduleCap ?? DEFAULT_SCHEDULE_CAP;
    const effectiveTools = new Set<string>(modeAuthority ? AUTONOMY_GRANTABLE_TOOLS : (row?.allowedTools ?? []));
    if (!requestedTools.every((t) => effectiveTools.has(t))) return beyond;
    if (args?.scheduleCap !== undefined && args?.scheduleCap !== null) {
      const n = Number(args.scheduleCap);
      if (!Number.isFinite(n)) return beyond;
      const clamped = Math.min(MAX_SCHEDULE_CAP, Math.max(1, Math.round(n)));
      if (clamped > effectiveCap) return beyond;
    }
    if (modeAuthority) return { kind: 'mode_covered', effectiveCap };
    // An auto-sourced row is MODE-MANAGED: writing it via setChatAutonomy
    // would stamp source 'manual' and detach the grant from the Agent-mode
    // lifecycle (a manual row survives mode flips — a silent authority
    // persistence the owner never chose). A covered non-empty request is
    // already true (the row itself bypasses for worker subagents; the gate
    // waiver for the orchestrator) → honest no-op. A SELF-REVOKE (empty)
    // still executes: the dispatcher's own mode_auto_implies_autonomy guard
    // refuses it with the honest explanation on a live-auto chat, and lets
    // it proceed on a non-auto chat — cleaning a STALE auto-sourced row.
    if (row?.source === AUTONOMY_SOURCE_AGENT_MODE && requestedTools.length > 0) {
      return { kind: 'mode_covered', effectiveCap };
    }
    return { kind: 'within_grant' };
  } catch {
    return beyond;
  }
}

// ── Scoped supervisor delegation (ticket eb4337fe, ruling oq_2674964f) ───────

/**
 * Verdict for a set_chat_autonomy call whose TARGET is a different chat,
 * consulted by the platform-tools gate AFTER the 9341e862 self-verdict fell
 * through as 'beyond'. Ticket eb4337fe: 5 owner confirmation cards in 24h
 * were all redundant re-confirmations — 3 were supervisor-initiated
 * set_chat_autonomy grants to lanes they supervise (one left an AWS monitor
 * unable to message peers ~110 min), 2 were first-use schedule_message cards
 * for recurring digests the owner asked for by name. The Fleet Supervisor
 * answered owner-question oq_2674964f (under the owner's standing directives
 * 2026-09-13 "APPROVE BOTH, STOP ASKING ME SO MUCH…" / 2026-09-12 "CLEAR
 * GATES ALWAYS ON MY BEHALF"): IMPLEMENT, with the scope guards below
 * (numbered from 2 — guard 1, a kill switch, is retired).
 *
 * The no-escalation invariant is preserved by CONSTRUCTION — a cross-chat
 * grant bypasses the card ONLY when the GRANTER is supervisor-class, the
 * target is a SAME-OWNER lane it supervises, and the request cannot exceed
 * the granter's own effective authority:
 *   2. target ≠ caller, non-empty (self is the 9341e862 path), resolvable;
 *   3. granter is supervisor-class (isSupervisorChat — fleet OR project);
 *   4. SAME OWNER only (cross-account targets stay carded);
 *   5. project supervisors delegate only WITHIN their own project (the fleet
 *      supervisor may reach any same-owner lane);
 *   6. requested tools ⊆ AUTONOMY_GRANTABLE_TOOLS AND ⊆ the GRANTER'S
 *      EFFECTIVE set (modeAuthority ? the full template : the stored row),
 *      and a requested scheduleCap (when given) ≤ the granter's effective
 *      cap — a raise is a real widening and still cards.
 * EVERY check fails closed: any throw/read failure returns 'beyond' and the
 * call stages exactly as before (older partial mocks keep pre-change
 * behavior because the gate optional-chains this helper).
 *
 * Verdicts: 'delegate' → the gate performs the write via
 * delegateChatAutonomy (source 'machine_delegated') with no owner card;
 * 'beyond' → staging, unchanged.
 */
export type SupervisorDelegationVerdict =
  | { kind: 'delegate' }
  | { kind: 'beyond'; reason?: string };

export async function supervisorDelegationVerdict(opts: {
  callerChatId: string;
  targetChatId: string;
  userId: string;
  args: { allowedTools?: any; scheduleCap?: any };
  /** The GRANTING run is an auto-mode coding orchestrator (same conjunct as the gate's db747817 waiver). */
  modeAuthority: boolean;
}): Promise<SupervisorDelegationVerdict> {
  const { callerChatId, targetChatId, userId, args, modeAuthority } = opts;
  const beyond = (reason?: string): SupervisorDelegationVerdict => ({ kind: 'beyond', ...(reason ? { reason } : {}) });
  try {
    // Guard 2 — a different, non-empty chat (self is the 9341e862 path).
    const target = String(targetChatId || '').trim();
    if (!target || target === callerChatId) return beyond('self or empty target');
    // Guard 2b — the TARGET chat must resolve (exact id; same-owner checked on
    // the resolved row so a foreign id surfaces as cross-owner, not phantom).
    const targetRow = await prisma.crossModelChat.findUnique({
      where: { id: target },
      select: { userId: true, projectId: true },
    });
    if (!targetRow) return beyond('target unresolvable');
    // Guard 3 — the GRANTER must be supervisor-class (fleet OR project).
    const supervisorMod: any = await import('./supervisor-state.service');
    const isSupervisor = await Promise.resolve(
      (supervisorMod?.isSupervisorChat as any)?.(callerChatId) ?? false,
    ).catch(() => false);
    if (!isSupervisor) return beyond('granter not supervisor-class');
    // Guard 4 + 5 — read the CALLER row: same owner; fleet supervisor reaches
    // any same-owner lane, a project supervisor only its OWN project's lanes.
    const callerRow = await prisma.crossModelChat.findUnique({
      where: { id: callerChatId },
      select: { userId: true, projectId: true, isSupervisor: true, isProjectSupervisor: true },
    });
    if (!callerRow) return beyond('granter row unresolvable');
    // The acting user must BE the granter chat's owner (a run executes with
    // the chat owner's identity; anything else is a confused deputy).
    if (callerRow.userId !== userId) return beyond('acting user is not the granter chat owner');
    if (callerRow.userId !== targetRow.userId) return beyond('cross-owner target');
    if (callerRow.isSupervisor !== true && callerRow.isProjectSupervisor !== true) return beyond('granter not supervisor-class (row)');
    if (callerRow.isSupervisor !== true) {
      // project supervisor: its own project's lanes only.
      if (!targetRow.projectId || targetRow.projectId !== callerRow.projectId) return beyond('project supervisor targeting another project');
    }
    // Guard 6a — requested tools: array, non-empty, ⊆ grantable AND ⊆ the
    // granter's EFFECTIVE set (live PK read; a read failure throws → beyond).
    if (!Array.isArray(args?.allowedTools) || args.allowedTools.length === 0) return beyond('malformed or empty allowedTools');
    const grantable = new Set<string>(AUTONOMY_GRANTABLE_TOOLS);
    const granterRow = await getChatAutonomy(callerChatId);
    const effectiveTools: Set<string> = new Set<string>(
      modeAuthority ? [...AUTONOMY_GRANTABLE_TOOLS] : (granterRow?.allowedTools ?? []),
    );
    for (const raw of args.allowedTools) {
      const t = String(raw);
      if (!grantable.has(t)) return beyond(`tool not grantable: ${t}`);
      if (!effectiveTools.has(t)) return beyond(`tool beyond granter's authority: ${t}`);
    }
    // Guard 6b — a requested cap (when given) may not exceed the granter's
    // effective cap (a raise is widening → card).
    if (args?.scheduleCap !== undefined && args?.scheduleCap !== null) {
      const n = Number(args.scheduleCap);
      if (!Number.isFinite(n)) return beyond('non-finite scheduleCap');
      const clamped = Math.min(MAX_SCHEDULE_CAP, Math.max(1, Math.round(n)));
      const effectiveCap = modeAuthority ? MAX_SCHEDULE_CAP : (granterRow?.scheduleCap ?? DEFAULT_SCHEDULE_CAP);
      if (clamped > effectiveCap) return beyond('scheduleCap beyond granter cap');
    }
    return { kind: 'delegate' };
  } catch {
    return beyond('internal failure'); // fail closed — the confirmation gate applies
  }
}

/**
 * Perform the supervisor-delegated grant (eb4337fe): the same validation as
 * setChatAutonomy (owner-only access check, grantable-subset, cap clamp) but
 * stamped source 'machine_delegated' and audited with its own action so the
 * granter is attributable on the Activity trail. Only ever called after
 * supervisorDelegationVerdict returned 'delegate' (the gate owns that check).
 *
 * Reviewer D4 (adversarial review of 21ab2e33c): the card-free write REFUSES
 * — returns null, nothing written, the gate falls through to staging so the
 * OWNER CARD names the change — when the TARGET's existing row is
 * owner-curated (source 'manual'): silently replacing a grant the owner set
 * by hand is an unaudited narrowing of what the owner chose. Overwriting an
 * 'agent_mode_auto' target row is mode-managed and PROCEEDS — with the audit
 * rows below (autonomy.grant.machine_delegated + the gate's
 * auditAutonomousExecution). A target-row READ failure throws → the gate's
 * catch → staging (fail-closed, like every other guard).
 */
export async function delegateChatAutonomy(opts: {
  granterChatId: string;
  targetChatId: string;
  userId: string;
  allowedTools: string[];
  scheduleCap?: number;
}): Promise<{ granted: boolean; chatId: string; allowedTools: string[]; scheduleCap: number | null; source: string | null } | null> {
  const { granterChatId, targetChatId, userId } = opts;
  // D4 fail-closed: never card-free-overwrite an owner-curated manual row.
  const existingTarget = await prisma.chatAutonomy.findUnique({
    where: { chatId: targetChatId },
    select: { source: true },
  });
  if (existingTarget?.source === AUTONOMY_SOURCE_MANUAL) {
    logger.info(
      `autonomy: machine-delegated grant to chat ${targetChatId.slice(0, 8)} by supervisor ${granterChatId.slice(0, 8)} REFUSED — target holds an owner-curated manual grant (eb4337fe D4); staging an owner card instead`,
    );
    return null;
  }
  const r = await setChatAutonomy({
    userId,
    chatId: targetChatId,
    allowedTools: opts.allowedTools,
    ...(opts.scheduleCap !== undefined ? { scheduleCap: opts.scheduleCap } : {}),
    source: AUTONOMY_SOURCE_MACHINE_DELEGATED,
  });
  await audit(userId, 'autonomy.grant.machine_delegated', {
    granterChatId, targetChatId, allowedTools: r.allowedTools, scheduleCap: r.scheduleCap,
  });
  logger.info(
    `autonomy: machine-delegated grant [${r.allowedTools.join(', ')}] for chat ${targetChatId.slice(0, 8)} by supervisor ${granterChatId.slice(0, 8)} (user ${userId.slice(0, 8)}, cap ${r.scheduleCap}/day) (eb4337fe)`,
  );
  return r;
}

// ── Preference-covered recurring digests (eb4337fe, limb B) ──────────────────

/**
 * Token families used by the CONSERVATIVE conjunctive digest-preference
 * match (eb4337fe limb B): a stored UserMemoryFact row counts as a digest
 * preference iff its content carries BOTH a cadence/time signal AND a
 * delivery/content signal (the two regexes below). Reviewer D2 (adversarial
 * review of 21ab2e33c — five live probes, P1/P2/P4/P5 WRONGLY covered on
 * single-generic-word overlap, incidental facts and unconstrained cadence;
 * P3 control correct) tightened the PROMPT side to a three-rule conjunct,
 * ALL required:
 *   1. the PROMPT names a DELIVERY-FAMILY keyword (DIGEST_PROMPT_DELIVERY_RE)
 *      — what the schedule delivers;
 *   2. ≥ DIGEST_MIN_SHARED_KEYWORDS SHARED meaningful keywords between the
 *      preference content and the prompt (stopwords and incidental numeric
 *      facts excluded — a single generic word or a shared date/time is not
 *      coverage);
 *   3. the recurring cadence is hourly or slower (intervalMinutes ≥
 *      DIGEST_MIN_INTERVAL_MINUTES) — anything faster fails and cards.
 */
const DIGEST_CADENCE_SIGNAL_RE = /\b\d{1,2}\s*(am|pm)\b/i;
const DIGEST_TIME_WORD_RE = /morning/i;
const DIGEST_DELIVERY_SIGNAL_RE = /slack|digest|update/i;

/**
 * Rule 1 (reviewer D2): the schedule PROMPT must name WHAT it delivers.
 * Word-START matched (so 'digest' also covers 'digests'/'digesting',
 * 'report' covers 'reports'/'reporting'): the ticket's redundant cards were
 * all recurring DIGEST prompts, and the delivery word is what keeps an
 * arbitrary recurring work prompt (a re-verification sweep, a drift check)
 * from riding a stored preference.
 */
const DIGEST_PROMPT_DELIVERY_WORDS = [
  'digest', 'summary', 'report', 'roundup', 'recap', 'briefing',
  'update', 'notify', 'notification', 'morning', 'daily', 'weekly', 'hourly',
] as const;
const DIGEST_PROMPT_DELIVERY_RE = new RegExp(`\\b(?:${DIGEST_PROMPT_DELIVERY_WORDS.join('|')})`, 'i');

/** Rule 2 (reviewer D2): minimum SHARED meaningful keywords, prompt ↔ preference. */
const DIGEST_MIN_SHARED_KEYWORDS = 2;

/** Rule 3 (reviewer D2): the covered path is for HOURLY-OR-SLOWER cadences only. */
const DIGEST_MIN_INTERVAL_MINUTES = 60;

/**
 * Rule 2 (reviewer D2): stopwords excluded from the prompt↔preference
 * overlap — grammatical filler, the generic ask/report verbs every
 * preference row and prompt carries, and the BARE cadence words (rule 1
 * already requires a delivery word; the shared count must come from CONTENT
 * — 'daily' alone never proves the schedule delivers what the owner asked
 * for).
 */
const DIGEST_OVERLAP_STOPWORDS = new Set([
  // grammatical filler
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'their', 'his', 'her', 'my', 'your', 'our', 'i', 'we', 'you', 'he', 'she', 'they', 'them', 'me', 'us',
  'every', 'each', 'any', 'all', 'some', 'no', 'not', 'none', 'about', 'into', 'over', 'under', 'again', 'please',
  // generic ask/report verbs — present in every preference and every prompt
  'wants', 'want', 'wanted', 'needs', 'need', 'likes', 'like', 'prefers', 'prefer',
  'send', 'sends', 'sent', 'post', 'posts', 'get', 'gets', 'make', 'gives', 'give', 'tell', 'keep', 'run', 'check',
  // the ask's frame, not the delivered content
  'owner', 'chat', 'user',
  // bare cadence words (rule 1 covers delivery; these are not content)
  'daily', 'weekly', 'hourly', 'day', 'week', 'hour', 'minute', 'time',
]);

/**
 * Rule 2 (reviewer D2): the MEANINGFUL keyword tokens of a text for the
 * prompt↔preference overlap — word/identifier tokens (letters, digits,
 * hyphens, underscores; quoted strings shed their quotes and count),
 * lowercased, stopwords excluded, and tokens that START with a digit
 * excluded (dates, times, quantities are the reviewer's P2 incidental-fact
 * class, not content). 'x' (the X/Twitter platform) is the one sub-3-char
 * token that counts.
 */
function digestOverlapKeywords(text: string): Set<string> {
  const out = new Set<string>();
  const lower = String(text ?? '').toLowerCase();
  for (const raw of lower.split(/[^a-z0-9_-]+/)) {
    const tok = raw.replace(/^[-_]+|[-_]+$/g, '');
    if (!tok) continue;
    if (DIGEST_OVERLAP_STOPWORDS.has(tok)) continue;
    if (/[0-9]/.test(tok[0])) continue; // incidental fact: a date/time/number, not content
    if (tok.length < 3 && tok !== 'x') continue;
    out.add(tok);
  }
  return out;
}

/**
 * True (with the matched preference key) when a RECURRING schedule_message
 * prompt is covered by a STORED owner preference the owner themselves wrote
 * (UserMemoryFact — "key: value" rows the owner's own memory wrote, not agent
 * prose). Ticket eb4337fe: the owner asked for recurring digests BY NAME
 * ("daily 8AM Slack digest of X trends"), yet each lane's FIRST
 * schedule_message for one staged a first-use confirmation card — a
 * re-confirmation of a standing owner instruction. This matcher lets those
 * arm card-free while everything else keeps the confirmation protocol.
 *
 * The prompt-side conjunct (reviewer D2, all three rules required):
 *   1. the prompt names a DELIVERY-FAMILY keyword (digest/summary/report/
 *      roundup/recap/briefing/update/notify/morning/daily/weekly/hourly);
 *   2. ≥2 SHARED meaningful keywords between the preference content and the
 *      prompt (stopword-excluded; a single generic word or an incidental
 *      date/number never covers);
 *   3. the cadence is hourly or slower (intervalMinutes ≥ 60) — a fast
 *      recurring cadence fails and cards even with perfect keyword overlap.
 *
 * Fail-closed everywhere: kind ≠ 'recurring' (a one-shot is one-off work, not a standing preference),
 * a missing/invalid intervalMinutes (fail-closed to card), read
 * failure/empty facts, or no qualifying row → { covered: false } → the gate
 * stages exactly as before.
 */
export async function ownerDigestPreferenceCoversDigest(opts: {
  userId: string;
  prompt: string;
  kind: string;
  intervalMinutes?: any;
}): Promise<{ covered: boolean; preferenceKey?: string }> {
  try {
    if (String(opts?.kind ?? '') !== 'recurring') return { covered: false };
    // Rule 3 — the covered path is for hourly-or-slower recurring digests.
    // A missing/non-finite interval is NOT covered (fail-closed: card).
    const intervalMinutes = Number(opts?.intervalMinutes);
    if (!Number.isFinite(intervalMinutes) || intervalMinutes < DIGEST_MIN_INTERVAL_MINUTES) return { covered: false };
    const promptText = String(opts?.prompt ?? '');
    // Rule 1 — the prompt must name WHAT it delivers.
    if (!DIGEST_PROMPT_DELIVERY_RE.test(promptText)) return { covered: false };
    const promptKeywords = digestOverlapKeywords(promptText);
    if (promptKeywords.size < DIGEST_MIN_SHARED_KEYWORDS) return { covered: false }; // nothing meaningful to match on
    const rows = await prisma.userMemoryFact.findMany({
      where: { userId: opts.userId },
      select: { key: true, content: true },
      take: 200,
    });
    if (!Array.isArray(rows) || !rows.length) return { covered: false };
    for (const row of rows) {
      const content = String(row?.content ?? '');
      if (!content) continue;
      const hasCadence = DIGEST_CADENCE_SIGNAL_RE.test(content) || DIGEST_TIME_WORD_RE.test(content);
      if (!hasCadence) continue;
      if (!DIGEST_DELIVERY_SIGNAL_RE.test(content)) continue;
      // Rule 2 — the prompt must share ≥2 MEANINGFUL keywords with the
      // preference's content (stopwords and digit-leading tokens excluded).
      const prefKeywords = digestOverlapKeywords(content);
      let shared = 0;
      for (const kw of prefKeywords) if (promptKeywords.has(kw)) shared += 1;
      if (shared < DIGEST_MIN_SHARED_KEYWORDS) continue;
      return { covered: true, preferenceKey: String(row?.key ?? '') || undefined };
    }
    return { covered: false };
  } catch {
    return { covered: false }; // fail closed — the confirmation gate applies
  }
}

// ── Agent-mode auto-grant (owner 2026-09-07) ─────────────────────────────────

/**
 * Keep a CODING chat's autonomy grant in sync with its Agent mode
 * (permissionMode). Owner directive 2026-09-07 (closing the #306 "auto-mode =
 * full autonomy" gap): a coding chat set to AUTO gets its Autonomy grant
 * materialized automatically — ALL grantable tools, the DEFAULT run cap (48;
 * never raised) — as if the owner had checked every box, stamped source
 * 'agent_mode_auto' so it stays attributable and mode-flip-revocable.
 *
 * Semantics (deliberate, mirrors the dialog contract):
 *   - mode → 'auto': upsert the full grant — UNLESS a MANUAL grant exists (an
 *     owner-curated set is never touched by mode flips, in either direction);
 *     re-syncing an identical auto grant is a no-op (no audit spam).
 *   - mode → anything else: delete the grant ONLY if it is auto-sourced (the
 *     delete filters on source, so a concurrent manual save can't be clobbered).
 *   - The row's userId is always the CHAT OWNER (resolved live) — a scheduled
 *     run executes with the owner's identity, so attribution must match.
 *   - Callers pass the mode they just persisted; this never flips modes itself.
 *
 * Runtime enforcement note: the platform-tools gate ALREADY waives confirmation
 * for auto-mode coding orchestrator runs via ctx (db747817) — this materialized
 * row is what makes the grant VISIBLE and true everywhere else (the Autonomy
 * dialog, GET /chats/:id/autonomy, schedule-cap reads, worker-subagent calls),
 * and what gets honestly revoked when the mode leaves Auto.
 */
export async function syncAutonomyWithAgentMode(opts: {
  chatId: string;
  permissionMode: string;
}): Promise<'granted' | 'revoked' | 'unchanged'> {
  const { chatId, permissionMode } = opts;
  if (!chatId) return 'unchanged';

  const existing = await prisma.chatAutonomy.findUnique({
    where: { chatId },
    select: { userId: true, allowedTools: true, scheduleCap: true, source: true },
  });

  if (permissionMode === 'auto') {
    // An owner-curated (manual) grant — or a supervisor-DELEGATED one
    // (eb4337fe, source 'machine_delegated') — is never widened/overwritten
    // by a mode flip: the delegated grant carries the granter supervisor's
    // authority, not the mode's.
    if (existing && existing.source !== AUTONOMY_SOURCE_AGENT_MODE) return 'unchanged';
    // Idempotent: an identical auto grant needs no rewrite (or audit row).
    if (
      existing &&
      existing.scheduleCap === DEFAULT_SCHEDULE_CAP &&
      existing.allowedTools.length === AUTONOMY_GRANTABLE_TOOLS.length &&
      AUTONOMY_GRANTABLE_TOOLS.every((t) => existing.allowedTools.includes(t))
    ) return 'unchanged';

    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { userId: true } });
    if (!chat) return 'unchanged'; // chat vanished — nothing to grant against
    const allowedTools = [...AUTONOMY_GRANTABLE_TOOLS];
    await prisma.chatAutonomy.upsert({
      where: { chatId },
      create: { chatId, userId: chat.userId, allowedTools, scheduleCap: DEFAULT_SCHEDULE_CAP, source: AUTONOMY_SOURCE_AGENT_MODE },
      update: { userId: chat.userId, allowedTools, scheduleCap: DEFAULT_SCHEDULE_CAP, source: AUTONOMY_SOURCE_AGENT_MODE },
      select: { chatId: true },
    });
    await audit(chat.userId, 'autonomy.grant', {
      chatId, allowedTools, scheduleCap: DEFAULT_SCHEDULE_CAP, source: AUTONOMY_SOURCE_AGENT_MODE,
    });
    logger.info(`autonomy: auto-granted [${allowedTools.join(', ')}] for chat ${chatId.slice(0, 8)} (agent mode auto, cap ${DEFAULT_SCHEDULE_CAP}/day)`);
    return 'granted';
  }

  // Leaving auto: revoke ONLY an agent-mode auto-granted row; manual grants
  // stay — and so do supervisor-DELEGATED rows (eb4337fe): the delete filters
  // on source, so a delegated grant survives mode flips like a curated one.
  if (!existing || existing.source !== AUTONOMY_SOURCE_AGENT_MODE) return 'unchanged';
  await prisma.chatAutonomy.deleteMany({ where: { chatId, source: AUTONOMY_SOURCE_AGENT_MODE } });
  await audit(existing.userId, 'autonomy.revoke', { chatId, source: AUTONOMY_SOURCE_AGENT_MODE });
  logger.info(`autonomy: auto-grant revoked for chat ${chatId.slice(0, 8)} (agent mode left auto → ${permissionMode})`);
  return 'revoked';
}

/**
 * Audit an AUTONOMOUS consequential execution (the gate's allowlist bypass):
 * an Activity row (resource 'platform') + a log line, both best-effort — an
 * audit hiccup must never block an otherwise-authorized autonomous action.
 * `note` distinguishes the authority that allowed the execution (default: the
 * stored-grant/auto-mode wording, unchanged; the implicit parent→child scope
 * passes its own so the audit trail can tell the two apart).
 */
export async function auditAutonomousExecution(opts: { chatId: string; tool: string; userId: string; note?: string }): Promise<void> {
  const note = opts.note ?? 'autonomous execution';
  logger.info(
    `autonomous execution: tool ${opts.tool} in chat ${opts.chatId.slice(0, 8)} (user ${opts.userId.slice(0, 8)}, resource 'platform', note '${note}')`,
  );
  await audit(opts.userId, 'autonomy.execute', { chatId: opts.chatId, tool: opts.tool, note });
}

// ── Sub-sessions (2026-09-02): IMPLICIT parent→child autonomy ────────────────

/**
 * The consequential tools a parent chat may run against ITS OWN first-degree
 * child sessions without a stored grant. Deliberately NARROW: steering the
 * child (send_chat_message) and tuning/retiring the child's cadence
 * (update_schedule / cancel_schedule). NOT included: start_coding_session
 * (spawning grandchildren must stay gated), schedule_message (arming NEW
 * unattended cadences is a persistence primitive), set_chat_autonomy (never
 * bypassable anywhere), dispatch_platform_task / send_to_instance (unrelated
 * to the parent-child relationship).
 */
export const PARENT_IMPLICIT_TOOLS = [
  'send_chat_message', 'update_schedule', 'cancel_schedule',
  // control tools (2026-09-24): a parent stops, answers, decides for and
  // pauses/resumes ITS OWN first-degree children — the same relationship.
  'stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule',
  'set_chat_instructions', // T3b: a parent may set standing rules on its first-degree child
] as const;

/** Tools whose target is named by args.chatId (the others name a schedule id). */
const CHAT_ID_TARGETED_TOOLS = new Set(['send_chat_message', 'schedule_message', 'stop_run', 'answer_chat_question', 'approve_request', 'set_chat_instructions']);

/**
 * True when a MACHINE-triggered run in `callerChatId` may execute `tool`
 * because the call targets the caller's OWN first-degree child session.
 *
 * Security posture (deliberate, mirrors docs/FLEET_SUPERVISOR_DESIGN.md):
 *   - LIVE reads only — the target chat's CURRENT parentChatId is fetched per
 *     call (no caching), so a re-parent/deletion revokes the scope instantly;
 *   - first-degree only — target.parentChatId must equal the caller's chat id
 *     EXACTLY (a grandchild's parent is the child, not the caller);
 *   - same-owner only — the target chat must belong to the acting user (a
 *     confused-deputy target owned by anyone else never qualifies);
 *   - schedule targets resolve by exact id OR a UNIQUE ≥8-char prefix + same
 *     owner (gate flip 2026-09-11 — the prefix the tools themselves invite; an
 *     ambiguous prefix still falls back to the confirmation path);
 *   - fail-CLOSED: any lookup error returns false.
 */
export async function implicitParentAutonomyAllows(opts: {
  callerChatId: string;
  userId: string;
  tool: string;
  args: any;
}): Promise<boolean> {
  try {
    const { callerChatId, userId, tool } = opts;
    if (!callerChatId || !userId) return false;
    if (!(PARENT_IMPLICIT_TOOLS as readonly string[]).includes(tool)) return false;

    // Resolve the call's TARGET chat.
    let targetChatId: string | null = null;
    if (CHAT_ID_TARGETED_TOOLS.has(tool)) {
      // Exact id OR unique ≥8-char own-scoped prefix (2026-09-14 — see
      // resolveChatTarget); the first-degree + same-owner check below runs on
      // the RESOLVED row.
      const raw = String(opts.args?.chatId || '');
      if (!raw || raw === callerChatId) return false;
      const target = await resolveChatTarget(userId, raw);
      return !!target && target.id !== callerChatId && target.parentChatId === callerChatId && target.userId === userId;
    } else {
      // update_schedule / cancel_schedule name a schedule id, not a chat.
      // Gate flip 2026-09-11 (owner: full steam): exact id OR unique ≥8-char
      // prefix (resolveOwnedScheduleTarget) — ambiguity still fails closed.
      const scheduleId = String(opts.args?.id || '');
      if (!scheduleId) return false;
      const sched = await resolveOwnedScheduleTarget(userId, scheduleId);
      targetChatId = sched?.sessionId ?? null;
    }
    if (!targetChatId || targetChatId === callerChatId) return false;

    // First-degree + same-owner check against the CURRENT DB row.
    const target = await prisma.crossModelChat.findUnique({
      where: { id: targetChatId },
      select: { parentChatId: true, userId: true },
    });
    return !!target && target.parentChatId === callerChatId && target.userId === userId;
  } catch {
    return false; // fail closed — the confirmation gate applies
  }
}

// ── G19 (remediation 2026-09-09): bounded auto-mode bypass ───────────────────

/**
 * The chat-TARGETED consequential tools the AUTO-MODE waiver must scope: each
 * names (directly or via a schedule id) a chat the call acts ON. Tools with no
 * chat target (start_coding_session / dispatch_platform_task)
 * are the lane's own work by construction and are not listed here.
 * send_to_instance targets a chat on a REMOTE instance — never own scope.
 */
export const AUTO_MODE_TARGET_SCOPED_TOOLS = [
  'send_chat_message', 'schedule_message', 'update_schedule', 'cancel_schedule', 'send_to_instance',
  // control tools (2026-09-24) — same lane-scope bound.
  'stop_run', 'answer_chat_question', 'approve_request', 'pause_schedule', 'resume_schedule',
  'set_chat_instructions', // T3b: chatId-targeted
] as const;

/**
 * True when a chat-TARGETED consequential call from an auto-mode coding lane
 * stays within THE LANE'S OWN WORK: the target chat is the caller's own chat
 * or a first-degree child (target.parentChatId === caller, same owner).
 *
 * Why (spark G19): the db747817 waiver executed EVERY consequential tool for
 * auto-mode coding runs — a coding session ingests untrusted repo/ticket/web
 * text, so injected content could arm schedules on ANY owned chat, steer the
 * supervisor, or push to paired instances on the strength of the mode alone.
 * Owner ruling: auto-mode = full autonomy FOR THE LANE'S OWN WORK — so the
 * implicit MODE authority (the ctx waiver AND its materialized
 * 'agent_mode_auto' grant row) is bounded to own-chat/first-degree-child
 * targets; anything else stages a confirmation. EXPLICIT owner grants
 * (source 'manual' — e.g. the fleet supervisor's steering grant) are not
 * bounded here: the owner named the tools by hand.
 *
 * Same security posture as implicitParentAutonomyAllows: live reads per call,
 * first-degree + same-owner only, schedule-id resolution by exact id or a
 * UNIQUE ≥8-char owner-scoped prefix (gate flip 2026-09-11 — the prefix the
 * schedule tools themselves invite; ambiguity fails closed), fail-CLOSED on
 * any error. (The G19 kill switch was retired 2026-10-30; the bound is
 * unconditional.)
 */
export async function autoModeTargetAllows(opts: {
  callerChatId: string;
  userId: string;
  tool: string;
  args: any;
}): Promise<boolean> {
  try {
    const { callerChatId, userId, tool } = opts;
    if (!callerChatId || !userId) return false;
    if (!(AUTO_MODE_TARGET_SCOPED_TOOLS as readonly string[]).includes(tool)) return true; // no chat target = own work
    if (tool === 'send_to_instance') return false; // remote-instance chat — never the lane's own scope (trust boundary)

    // Resolve the call's TARGET chat.
    let target: ChatTargetRow | null = null;
    if (CHAT_ID_TARGETED_TOOLS.has(tool)) {
      // schedule_message's missing chatId is stamped to the caller's own chat
      // by the gate BEFORE any bypass runs; treat a still-missing id as own.
      const raw = String(opts.args?.chatId || '') || callerChatId;
      if (raw === callerChatId) return true; // the lane's own chat
      // Exact id OR unique ≥8-char own-scoped prefix (owner pending-card
      // incident 2026-09-14 — the fleet's 8-char idiom used to miss findUnique
      // here and stage as 'foreign_owner'). A miss is UNRESOLVED, not foreign:
      // the two reasons were conflated and hid the bug for a day.
      target = await resolveChatTarget(userId, raw);
      if (!target) return false; // unresolved
      if (target.id === callerChatId) return true; // own chat, named by prefix
    } else {
      // update_schedule / cancel_schedule name a schedule id, not a chat.
      // Gate flip 2026-09-11 (owner: full steam): exact id OR unique ≥8-char
      // owner-scoped prefix (resolveOwnedScheduleTarget) — 7/7 stagings since
      // 09-08 were 8-char prefixes the tool description invites; an ambiguous
      // or unknown prefix still fails closed into the confirmation path.
      const scheduleId = String(opts.args?.id || '');
      if (!scheduleId) return false; // unresolved
      const sched = await resolveOwnedScheduleTarget(userId, scheduleId);
      const targetChatId = sched?.sessionId ?? null;
      if (!targetChatId) return false; // unresolved
      if (targetChatId === callerChatId) return true; // the lane's own chat
      const row = await prisma.crossModelChat.findUnique({
        where: { id: targetChatId },
        select: { parentChatId: true, userId: true },
      });
      if (!row) return false; // unresolved
      target = { id: targetChatId, parentChatId: row.parentChatId ?? null, userId: row.userId };
    }

    // First-degree family + same-owner check against CURRENT DB rows:
    // caller→child (the lane steering a lane it spawned) AND child→PARENT
    // (a delegated lane reporting back — integration addition 2026-09-09:
    // without the parent arm, every child lane's send_chat_message report to
    // the chat that spawned it staged a confirmation nobody answers on
    // machine runs, silently stalling delegation trees).
    const caller = await prisma.crossModelChat.findUnique({
      where: { id: callerChatId },
      select: { parentChatId: true, userId: true },
    });
    if (target.userId !== userId) return false; // foreign_owner
    if (target.parentChatId === callerChatId) return true; // caller → its child
    if (!!caller && caller.userId === userId && caller.parentChatId === target.id) return true; // child → its parent
    // FLEET SCOPE (owner directive 2026-09-10: "the framework and fleet operate
    // autonomously" — 8 stale cross-lane confirmations had staged in one night,
    // one lane re-arming a sibling's wake schedule hourly into the void). An
    // auto-mode machine lane may coordinate ANY same-owner chat with these
    // tools: sibling messaging IS the fleet bus, and sibling schedule
    // management is how burn-down/supervisor lanes keep the fleet armed.
    // Injection posture is preserved by the layers that gate CONTENT and
    // AUTHORITY, not topology: the outbound-claim audit + relay citation
    // anchoring govern messages; the 5/day machine prompt-rewrite cap +
    // schedule_prompt_history govern schedule edits; set_chat_autonomy /
    // create_share_link stay NEVER_AUTONOMOUS; send_to_instance (a trust
    // boundary, not a sibling) is refused above.
    if (!!caller && caller.userId === userId) return true; // same-owner fleet sibling
    return false; // foreign_owner
  } catch {
    return false; // fail closed — the confirmation gate applies
  }
}
