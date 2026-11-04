/**
 * Fleet supervisor (slice B) — EVENT HOOKS + supervisor wake (durable outbox).
 * Spec: docs/FLEET_SUPERVISOR_DESIGN.md §3.
 *
 * An EventHook subscription says: when sourceChatId emits one of eventTypes,
 * wake targetChatId with the rendered promptTemplate. Emission
 * (emitHookEvent) inserts one PENDING HookEvent outbox row per matching hook
 * and never blocks the emitting run; the WEB process's 60s schedule sweeper
 * (schedule.service.ts — the SAME sweeper that fires due schedules) delivers
 * them via sweepHookEvents().
 *
 * Loop bounds (§6):
 *   - self-loop suppression: a hook whose target == source is never written;
 *   - DEPTH CAP: payloads carry `depth`; a wake delivery stamps
 *     `fleet:hookdepth:<targetChatId>` = depth+1 (1h TTL) and a woken run's
 *     own emissions READ that stamp (emitHookEvent, when extra.depth is
 *     undefined) — emissions at depth >= MAX_HOOK_DEPTH are dropped. The
 *     finalize paths (run-executor / chat-agent) CLEAR the stamp after
 *     emitting so the bump applies to exactly one run. Agent-origin sends
 *     (send_chat_message) re-stamp the SENDER's live depth onto the send
 *     target via stampHookDepth (platform.service / queue drain), so the
 *     ladder climbs through send hops instead of resetting to 0;
 *   - DAILY BUDGET: every delivered wake consumes the target chat's daily
 *     machine-run budget (schedule.service dailyCapExceeded — the SAME
 *     counter schedule firings consume; ChatAutonomy.scheduleCap ?? 48). A
 *     capped NON-ALARM wake is DROPPED (rows failed + log +
 *     schedule_cap_skipped event), never left to queue forever; ALARM-class
 *     events (ALARM_EVENT_TYPES — audit #3) BYPASS the cap and deliver;
 *   - debounce: a hook that fired < debounceSec ago keeps its events pending
 *     (they coalesce into the next delivery's bullet-list summary); the
 *     window is enforced cross-instance by a Redis SET NX PX gate. ALARM-class
 *     batches BYPASS the debounce entirely (owner 2026-09-04 wake economy —
 *     the supervisor wildcard window is 3600s now, and an alarm must never
 *     wait it out): any group containing an alarm event delivers immediately
 *     as one coalesced wake;
 *   - busy target (v1#1): EVERY event parks — ALARM-class rows park pending
 *     with attempts frozen (per-target backlog capped at PARKED_ALARM_CAP)
 *     and drain on the first sweep after the target's run finalizes; non-alarm
 *     rows TTL-park (pending, retryAt = now + BUSY_PARK_MS, attempts frozen).
 *     Attempt-burn survives only for transient delivery ERRORS; the 24h
 *     pending horizon dead-letters anything undeliverable ('failed:horizon',
 *     owner-noticed). Fairness: the sweep batch is alarm-first, then per-hook
 *     round-robin (selectFairBatch), and a DISABLED hook's pending rows are
 *     terminal-marked 'skipped:hook_disabled' instead of clogging the batch.
 *     The per-hook cap is FAIRNESS only (review 2026-09-13 issue 1): the hook
 *     that wins its debounce window DRAINS its whole deliverable backlog into
 *     one digest wake (drainWindowBacklog / WINDOW_DRAIN_CAP), and whatever a
 *     wake could not show (drain-cap remainder, stale-consumed rows) is said
 *     in the wake itself.
 *   - FLEET-FEED SHED (Project-supervisor preflight 2026-09-14, route-only):
 *     when a source chat's project has projectSupervisorEnabled=true AND an
 *     enabled project-scope hook receives the event, the OWNER-scope wildcard
 *     does not get that project's QUIET rows (FLEET_FEED_SHED_EVENT_TYPES:
 *     run_completed / todo_done) — the project supervisor fans them in and
 *     reports up; alarm-class rows still reach both lanes. The PROJECT
 *     SUPERVISOR'S OWN quiet completions are shed too (hardening 2026-09-14):
 *     its only project hook targets itself (self-loop suppressed), and its
 *     channel up is send_chat_message — so its run_completed / todo_done rows
 *     have no fan-in by construction and must not re-enter the fleet feed the
 *     shed exists to shrink. The window drain / digest above is keyed on
 *     hookId and applies to project-scope hooks identically.
 *   - ACTOR-ECHO SUPPRESSION (hardening 2026-09-14): an emitter may name the
 *     chat that PERFORMED the action (extra.actorChatId — goals.service
 *     todo_done passes the closing chat while the SOURCE stays the assignee so
 *     direct per-worker hooks keep firing). A hook whose target IS the actor
 *     is skipped exactly like the target==source self-loop above: a project
 *     supervisor closing a worker's todo must not be woken ten minutes later
 *     to re-audit its own close. Route-only — nothing is refused; other
 *     targets still get the row, and a user/UI close (no actor) wakes as before.
 *
 *   - INSTANT DELIVERY (owner 2026-09-14 "make hooks instant — no idle time"):
 *     emission KICKS a targeted sweep for the hooks it just wrote (push, not
 *     poll — the 30 s sweeper is the cross-instance safety net), and every
 *     run finalize KICKS a targeted drain for its own chat that ignores the
 *     busy-park retryAt (the chat is idle NOW). Debounce is 0 on both
 *     supervisor lanes: coalescing happens naturally while a target is busy
 *     (parked rows ship as one digest at run end).
 *
 * Security: same-owner only — checked at subscribe (owner-or-write on BOTH
 * chats) AND re-checked at delivery (hook.userId must still OWN both chats,
 * else the hook is deleted). Liveness: RETIRED-TARGET hygiene is also
 * re-checked at delivery (ticket 57154856) — a hook whose target chat owns no
 * live work (archived, or a coding lane with 0 enabled schedules + 0 open
 * todos) gets its wake SKIPPED and the hook AUTO-PAUSED (rows
 * 'skipped:target_retired', audit hook.auto_pause; one hook_update
 * re-enables). system:* hooks, supervisor chats and plain
 * (non-coding) chats are exempt. Wake delivery reuses fireScheduleTarget (the
 * schedule sweeper's machine-run path): plain chat → detached chat-agent turn,
 * code-capable chat → queued coding run — always WITHOUT a userTurnAt, so the
 * woken run stays machine-triggered (it can register pending confirmations but
 * never confirm them; consequential tools need a ChatAutonomy grant).
 *
 * Import discipline (mirrors autonomy.service): this module is only ever
 * loaded via DYNAMIC import (schedule.service's sweep tick + seam,
 * run-executor / chat-agent finalize, session-run-lock attention emit), so a
 * static import of crossmodel.service here can never cycle back. Callers that
 * statically reach this module would create one — don't add one.
 */

import { Prisma } from '@prisma/client';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { AppError } from '../../../middleware/error-handler';
import crossModelService from '../crossmodel.service';
import {
  fireScheduleTarget, dailyCapExceeded, refundDailyCapToken, notifyDailyCapOnce,
  claimCapWindowGate,
} from '../coding/schedule.service';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './loop-metrics.service';
import { noteChatRunEvent } from './delegation-tasks'; // build 2026-10-08 D-1 (SHADOW ledger)
import {
  decide, decisionMode, decisionThreshold, recordDecisionOutcome,
  stashDecision, reconstructDecision, type DecisionStash,
} from './decision-gate';
import { noteFleetEventEmitted, noteFleetEventDelivered } from './fleet-event-rollup.service';
import { isRetiring } from '../coding/retiring';
// Supervisor OFF switch (owner 2026-09-26): a wake aimed at a switched-off
// supervisor chat is terminal-marked here, never delivered, never replayed.
import { supervisorWakeSkip, SUPERVISOR_SWITCH_SKIPPED_STATUS, SUPERVISOR_SWITCH_SKIP_REASON, getProjectSupervisorsEnabled } from './supervisor-switch';
// FLEET-PS-FIRST (supervisor SOTA round 2, 2026-10-20): a PS-covered project's
// alarms reach the Fleet Supervisor only as a delayed escalation (pure leaf).
import {
  appendPsEscalation, fleetAlarmPsFirstDisabled, isHeldPsEscalation, isPsFirstEventType, newPsEscalation, pickAlarmHandles, psEscalationCapMs,
  psEscalationVerdict, psEscalationWanted, psShedPhase, readPsEscalation, renderPsEscalationPrompt, HOOK_STATUS_PS_HANDLED, PS_ESCALATION_DELAY_MS,
  PS_ESCALATION_METRIC_KIND, PS_ESCALATION_ORIGIN, PS_ESCALATION_MAX_PS, type PsEscalationAlarm, type PsMark,
} from './fleet-ps-first';
// Cohesive chat live fixes (2026-09-28): a child-result wake aimed at a HUMAN's
// plain chat is skipped when the hand-off already told the user — leaf, no imports.
import { decideHandoffParentWake, HOOK_STATUS_HANDOFF_POSTED, HOOK_STATUS_PS_COVERS_CHILD, rowRunId, rowSummary, type HandoffWakeRow } from './handoff-parent-wake';
// Ticket f8c62820: an auto-wired child→parent result hook whose child lane's
// ownership moved away from the spawning parent is skipped at delivery.
import {
  decideChildResultOwnershipWake, HOOK_STATUS_OWNERSHIP_MOVED,
  type ChildOwnershipWakeDecision,
} from './child-ownership-wake';
import {
  WAKE_TRIAGE_LANE_LOOKUP_MAX, WAKE_TRIAGE_RUN_LABELLED_QUESTIONS, buildWakeTriageRequest, wakeTriageAnsweredKeys,
  wakeTriageCodeLabels, wakeTriageSourceIds, wakeTriageV2Note, type WakeSourceLaneFacts,
  drawWakeTriageControl, WAKE_TRIAGE_CONTROL_EXTRA,
} from './wake-triage-request';
// audit 2026-10-06 T3-3: hook summaries are redacted with the shared scanner (leaf, no imports).
import { redactSecrets } from './secret-scan';
// audit 2026-10-08 W6-2: the deterministic material-change wake gate for supervisor targets.
import { closeStashesForGateSkip, materialGateForHook, readInflightMachineWakeStart, readWakeHighWaterMark, recordMaterialGateAgreement, type MaterialGateResult } from './supervisor-wake-ledger';
import { HOOK_STATUS_NO_MATERIAL_CHANGE, HOOK_STATUS_PROGRESS_SELF_DRIVING } from './wake-material-rule';
import { quietAlarmCause } from './alarm-cause';
import { archivedTargetRetireDisabled } from './archived-target-retire';
// SHARED-PROJECT-DISPATCH (2026-10-20): a member-spawned child runs as the project
// OWNER, so its child-result hook is cross-owner by construction (leaf, no imports).
import { spawnMemberAccessDisabled } from './shared-project-access';

/**
 * audit 2026-10-06 T3-3 (schooltime F1): a hook event's summary is persisted in
 * hook_events and rendered verbatim into the woken supervisor's prompt — a
 * run_completed summary is the run's FINAL ANSWER, so an owner-typed password
 * echoed there rode a Fleet Supervisor wake (01c079e3) to the LLM gateway.
 * Redacted with the shared redactSecrets at emission (and again at delivery
 * for rows stored before the fix). Never throws. Kill switch
 * HOOK_SUMMARY_SECRET_REDACT_DISABLED=1.
 */
export function redactHookSummary(text: unknown): string {
  const s = String(text ?? '');
  if (process.env.HOOK_SUMMARY_SECRET_REDACT_DISABLED === '1') return s;
  try { return redactSecrets(s).text; } catch { return s; }
}

/** Terminal statuses for rows the sweep DROPS without a delivery attempt — the
 *  source chat was deleted / changed owner / left the project (`source_gone`)
 *  or the target chat did (`target_gone`). Prefixed like 'failed:horizon' so
 *  LIKE 'failed%' consumers keep seeing them, while audits can tell a dead
 *  chat from a real delivery failure (2026-09-19: two Fleet Supervisor rows
 *  from a deleted chat read as "hook delivery failed" in the 4-hourly audit). */
export const HOOK_STATUS_SOURCE_GONE = 'failed:source_gone';
export const HOOK_STATUS_TARGET_GONE = 'failed:target_gone';
/**
 * Terminal status for rows whose delivery was SKIPPED because the TARGET chat
 * owns no live work (ticket 57154856 — retired-target hygiene, 2026-09-20):
 * the hook is auto-paused in the same pass, so a stood-down lane stops burning
 * runs on stale peer events. 'skipped:*' (like 'skipped:hook_disabled'), NOT
 * 'failed:*' — nothing broke; LIKE 'failed%' consumers (dead-letter notices,
 * the 4-hourly "failed hooks" audit) must not count retirement as breakage.
 */
export const HOOK_STATUS_TARGET_RETIRED = 'skipped:target_retired';
/** Supervisor OFF switch (owner 2026-09-26): rows aimed at a switched-off
 *  supervisor chat. Terminal like 'skipped:hook_disabled' — a re-enable
 *  resumes with NEW events; nothing skipped is replayed. */
export const HOOK_STATUS_SUPERVISOR_OFF = SUPERVISOR_SWITCH_SKIPPED_STATUS;
/** audit 2026-10-06 T3-11: a run_completed row whose run already messaged the target directly. Terminal, never replayed. */
export const HOOK_STATUS_REPORTED_IN_RUN = 'skipped:reported_in_run';
/** audit 2026-10-06 T3-12: a row from an ARCHIVED source chat. Terminal, never replayed. */
export const HOOK_STATUS_SOURCE_ARCHIVED = 'skipped:source_archived';
/** audit 2026-10-06 T3-11: a report-up this close to the run's completion counts as the same news. */
export const REPORTED_IN_RUN_WINDOW_MS = 15 * 60 * 1000;

/** The wake's entry-point label for the supervisor_switch telemetry: a direct
 *  wake carries its producer in payload.origin (infra-watch, follow-through,
 *  product-watch, …); a plain hook event is 'hook'. */
export function hookWakeSource(rows: any[]): string {
  const origins = [...new Set(rows.map((r) => (r?.payload as any)?.origin).filter((o) => typeof o === 'string' && o))].sort();
  return origins.length ? `hook:${origins.join('+')}` : 'hook';
}

/**
 * Todo states that count as LIVE WORK for a hook target (ticket 57154856):
 * pending | in_progress | blocked — anything an assignee still has to act on
 * (blocked included: an owner/deps-gated todo is still the lane's open loop).
 * done | dropped are terminal and leave the lane with no board work.
 */
export const LIVE_TODO_STATUSES = ['pending', 'in_progress', 'blocked'] as const;

export const HOOK_EVENT_TYPES = [
  'run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'todo_done', 'schedule_cap_skipped',
  // A schedule flipped enabled:false — cancelled / expired / max_runs / obsolete
  // (overnight forensics 2026-08-24, fix 2: a self-cancelled cadence previously
  // emitted NOTHING, so no supervisor could notice the stop).
  'schedule_disabled',
  // PRE-EMPTIVE run-cap/lifetime warning (ticket b4d1096c): a recurring
  // schedule crossed ≥90% of maxRuns or entered the last 10% of its lifetime
  // window — emitted ONCE per row (nearCapAlertedAt stamp) BEFORE the gap
  // opens, so a supervisor can re-arm pre-emptively instead of learning from
  // the post-death schedule_disabled. Deliberately NOT alarm-class: it is a
  // planning heads-up, and schedule_disabled stays the alarm-class backstop
  // that a capped supervisor still hears when the row actually dies.
  'schedule_near_cap',
  // Remote CI observed FAILING on a sha the emitting coding session pushed
  // (P5 v1#28, coding/ci-status.ts: the post-push observation and later
  // check_ci reads). Deliberately NOT alarm-class: it is a per-lane work
  // signal ("your pushed work is red — fix it"), not a fleet smoke detector;
  // the lane's own hooks subscribe to it.
  'ci_failed',
] as const;
export type HookEventType = typeof HOOK_EVENT_TYPES[number];

/**
 * Direct-wake event type (v1#7 durable todo-unblock wake): NOT in
 * HOOK_EVENT_TYPES (never user-subscribable, never emitted by emitHookEvent) —
 * rows of this type enter the outbox ONLY via enqueueDirectWake, on a per-chat
 * SYSTEM self-hook, and ride the same sweep/park/dead-letter machinery every
 * other wake does. Alarm-class: a busy assignee parks the wake (attempts
 * frozen) instead of dropping it, and a spent daily cap does not silence it.
 */
export const TODO_WAKE_EVENT_TYPE = 'todo_wake';

/**
 * Todo states in which a todo_wake delivery is STALE (feedback 7d7268fb): the
 * wake's purpose is "a todo is actionable for you NOW" — a todo that is
 * blocked (incl. owner-gated: blockKind/gateQuestionId ride the row), done,
 * or dropped at DELIVERY time is not startable, so the parked "UNBLOCKED /
 * ASSIGNED … START now" summary must not fire. 'pending' and 'in_progress'
 * stay deliverable (both are actionable for the assignee).
 */
export const TODO_WAKE_STALE_STATUSES = ['blocked', 'done', 'dropped'] as const;

/**
 * CanLaw stall 2026-09-15 (verified live 06:25Z): todo_wake rows whose PURPOSE
 * is "this todo is BLOCKED and the block is yours to examine" — the unbacked
 * owner-claim wake (goals.service noteUnbackedOwnerWaitClaim, which may target
 * the project supervisor rather than the assignee) and the owner-asked-back
 * wake (unblockOwnerGatedItems → wakeTodoAssignee 'owner_asked_back'). The
 * actionable-NOW revalidation above would suppress every one of them
 * ('status:blocked' / 'reassigned_away' — all four first corrective wakes were
 * consumed with no run). For these triggers a delivery is stale only when the
 * todo is gone, closed (done/dropped), or NO LONGER blocked (the correction
 * already happened); the target need not be the assignee.
 */
export const BLOCKED_TODO_WAKE_TRIGGERS = new Set(['owner_claim_unbacked', 'owner_asked_back']);

/**
 * Best-effort audit trail (Activity, resource 'platform') — mirrors
 * autonomy.service. Wiring changes (subscribe / unsubscribe / AUTO-DELETE)
 * must never be silent: feedback be89b75d lost a wildcard supervisor hook with
 * zero signal and no way to attribute the deletion afterwards.
 */
async function audit(userId: string, action: string, metadata?: Record<string, any>): Promise<void> {
  try {
    await prisma.activity.create({
      data: { userId, action, resource: 'platform', ...(metadata ? { metadata } : {}) },
    });
  } catch (err: any) {
    logger.warn(`hook audit write failed (${action}): ${err.message}`);
  }
}

/** Autonomous loop bound: a wake chain deeper than this stops emitting. */
export const MAX_HOOK_DEPTH = 3;
/** A busy target keeps its events pending until this many delivery attempts. */
export const MAX_DELIVERY_ATTEMPTS = 60;
export const DEFAULT_DEBOUNCE_SEC = 60;
export const MAX_DEBOUNCE_SEC = 3600;

/**
 * Alarm-class wake priority (audit roadmap #3): these event types are the
 * fleet's smoke detectors — a capped or busy supervisor must still hear them.
 * They (and ONLY they) get two carve-outs in deliverHookGroup:
 *   (a) daily-cap BYPASS — an alarm wake delivers even when the target chat's
 *       machine-run budget is spent (non-alarm rows in the same group keep the
 *       existing drop-at-cap contract, byte for byte);
 *   (b) busy-target PARK — instead of burning delivery attempts toward the
 *       MAX_DELIVERY_ATTEMPTS death, alarm rows go back to 'pending' with
 *       attempts FROZEN (the durable hook_events outbox row IS the parking
 *       slot) and drain automatically: the 60 s sweeper retries pending rows,
 *       so the wake lands on the first tick after the target's run finalizes
 *       and frees the session. PARKED_ALARM_CAP bounds the per-target backlog
 *       (oldest evicted + warn) against alarm storms.
 * Everything else — debounce, depth caps, ownership re-checks, wildcard
 * filtering — applies to alarms unchanged.
 */
export const ALARM_EVENT_TYPES = ['attention_needed', 'run_failed', 'goal_blocked', 'schedule_disabled', TODO_WAKE_EVENT_TYPE] as const;
/** Max PENDING alarm rows per TARGET chat — oldest beyond this are evicted. */
export const PARKED_ALARM_CAP = 20;
/**
 * Alarm classification is (eventType, payload)-aware since P3 (v1#14): a
 * schedule_disabled that CARRIES a successorId is a routine renewOnExhaustion
 * rollover — it still delivers as a normal hook event, but loses the alarm
 * carve-outs (cap bypass, debounce bypass, frozen-attempt park): a spent link
 * with an armed successor is exactly NOT a smoke detector.
 *
 * CAUSE-AWARE (supervisor SOTA 2026-10-20, platform/alarm-cause.ts): a
 * run_failed for a run a chat STOPPED (payload.cancelledBy), a run_failed whose
 * provider-limit RESUME is already queued (payload.resumeQueued), and a lane's
 * own schedule_disabled while it still has live work are quiet rows too — they
 * flow through the supervisor material gate adding no reason of their own.
 * Kill switch HOOK_ALARM_CAUSE_AWARE_DISABLED=1 (type-based again).
 *
 * CI-WATCH ESCALATION (round-2 interactions fix, 2026-10-20): ci-watch marks a
 * sha 'escalated' (terminal; a lane_loop escalation also stops waking the lane
 * for 24 h) once its ci_failed row is WRITTEN, so that row must not be
 * droppable at delivery — a ci_failed carrying payload.ciWatchEscalation is
 * alarm-class (cap bypass, debounce bypass, frozen-attempt park, STALE banner
 * instead of a silent consume). Every other ci_failed (the lane's own
 * check_ci) stays quiet. ci_failed is no PS-first type and no stock Fleet hook
 * carries it, so it is never held / re-escalated to the Fleet; it stays out of
 * the PARKED_ALARM_CAP census (bounded by ci-watch's per-sha claim, never
 * evicted). CI_WATCH_DISABLED=1 restores the quiet class.
 */
export function isAlarmEvent(eventType: unknown, payload?: unknown): boolean {
  const t = String(eventType ?? '');
  if (t === 'ci_failed') {
    const esc = payload && typeof payload === 'object' ? (payload as any).ciWatchEscalation : null;
    return typeof esc === 'string' && esc.trim() !== '' && process.env.CI_WATCH_DISABLED !== '1';
  }
  if (!(ALARM_EVENT_TYPES as readonly string[]).includes(t)) return false;
  if (t === 'schedule_disabled' && payload && typeof payload === 'object' && (payload as any).successorId) return false;
  if (quietAlarmCause(t, payload)) return false;
  // ARCHIVED-TARGET-RETIRE (2026-10-20): a schedule paused because its chat is
  // ARCHIVED is the archive executing, not a smoke detector — it delivers as a
  // normal (quiet) hook event. Kill switch ARCHIVED_TARGET_RETIRE_DISABLED=1.
  if (t === 'schedule_disabled' && payload && typeof payload === 'object' && (payload as any).reason === 'target_archived' && !archivedTargetRetireDisabled()) return false;
  return true;
}
const isAlarmRow = (r: any): boolean => isAlarmEvent(r?.eventType, r?.payload);

/**
 * Project-supervisor preflight 2026-09-14: FLEET-FEED SHED. When a chat's
 * project has an ENABLED per-project supervisor (projectSupervisorEnabled +
 * an enabled project-scope hook that receives the event), the OWNER-SCOPE
 * wildcard (the Fleet Supervisor) no longer receives these QUIET event types
 * from that project — the project supervisor is the fan-in for quiet events
 * and reports up. Alarm-class events (attention_needed, goal_blocked,
 * run_failed, schedule_disabled, schedule_cap_skipped) keep flowing to BOTH
 * lanes. Without this the layer was purely additive (#741 review: the fleet
 * feed GREW when a project supervisor was enabled). Route-only: the row is
 * still written to the project-scope hook; nothing is refused or lost.
 */
export const FLEET_FEED_SHED_EVENT_TYPES = ['run_completed', 'todo_done'] as const;

const SUMMARY_CAP = 2000;

/**
 * Clean truncation for hook-event summaries: cut at the last word/line boundary
 * before the cap and append an explicit marker. A mid-word slice looks like a
 * COMPLETE digest — the fleet supervisor acted on one ("8/15" vs the real 7/15;
 * a mid-finalize "0 result.json files" read as data loss). Ticket 62799318.
 */
export function truncateSummary(text: unknown, cap: number = SUMMARY_CAP): string {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  const MARKER = '\n…[truncated — read the source chat for the full text]';
  const room = Math.max(0, cap - MARKER.length);
  const cut = s.slice(0, room);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  return (lastBreak > room * 0.5 ? cut.slice(0, lastBreak) : cut).trimEnd() + MARKER;
}
const SWEEP_BATCH = 50;
/** Fairness scan window (v1#1): rows considered per sweep before partitioning. */
export const SWEEP_SCAN = 200;
/** Fairness cap (v1#1): max NON-ALARM rows per hook per sweep batch. This is a
 *  FAIRNESS cap ACROSS hooks (selectFairBatch) — NOT a throughput cap for the
 *  hook that wins its debounce window: deliverHookGroup drains that hook's
 *  whole deliverable backlog into the one wake (WINDOW_DRAIN_CAP). */
export const SWEEP_PER_HOOK_CAP = 10;
/**
 * Review 2026-09-13 issue 1 — WINDOW DRAIN. The supervisor wildcard hook
 * (debounceSec 3600) used to receive at most SWEEP_PER_HOOK_CAP quiet rows
 * per hour-long window while the fleet emitted ~15/h: the FIFO backlog grew
 * ~5/h, hourly wakes carried rows aged up to 22.8h, and the #712 stale guard
 * then CONSUMED the overflow (~30% of run_completed) with no wake, no notice
 * and no metric. Now a hook that WINS its window (or an alarm that owns it)
 * pulls in EVERY other deliverable pending row of that hook (status pending,
 * retryAt null/past) so the backlog ships as ONE coalesced digest wake —
 * throughput scales with arrival. WINDOW_DRAIN_CAP bounds one delivery; when
 * it binds the NEWEST rows are taken and the wake carries an explicit "N
 * older … not shown" line.
 */
export const WINDOW_DRAIN_CAP = 200;

/**
 * SIBLING DRAIN (hardening loop 2026-09-24). A supervisor is fed by SEVERAL
 * hooks (the Fleet Supervisor: 12 — one wildcard + per-lane child-result and
 * per-source hooks). The window drain above is keyed on ONE hook, so a wake
 * fired by the wildcard hook left the sibling hooks' pending rows behind:
 * prod showed 7 run_completed rows on a 1-hour-debounce sibling busy-parked
 * for 77 min while the wildcard hook woke the same chat twice — each sibling
 * row would later cost its own wake (or re-park again). When the firing hook
 * is the WILDCARD one (the supervisor's main feed), every enabled sibling
 * hook's pending rows for the same target + owner join the group: one wake,
 * one digest, and the sibling hooks' debounce clocks reset with it. Excluded:
 * child-result-template hooks (their rows carry a different contract) unless
 * the firing hook is one, and rows without a payload.sourceChatId (the
 * wildcard branch's ownership filter needs it). Bounded by SIBLING_DRAIN_CAP.
 */
export const SIBLING_DRAIN_CAP = 100;
/** Digest rendering (issue 1): above this many QUIET rows a wake renders each
 *  quiet event as ONE compact line; alarm rows stay verbatim regardless. */
export const DIGEST_COMPACT_THRESHOLD = SWEEP_PER_HOOK_CAP;
/** Digest rendering (issue 1): max QUIET lines shown (NEWEST preferred); the
 *  rest collapse into one "N more — use list_chats" line. All rows are still
 *  marked delivered — the cap is on the prose, never on consumption. */
export const DIGEST_MAX_LINES = 40;
/** Digest rendering (issue 1): per-line clip for compact quiet bullets. */
export const DIGEST_LINE_CHARS = 240;
/** Busy-target TTL-park backoff (v1#1): non-alarm rows re-sweep after this. */
export const BUSY_PARK_MS = 3 * 60 * 1000;
/** Decision-gate wake triage (2026-09-24): how long an ACT-mode "no action
 *  needed now" batch waits before it delivers on its own (it rides any earlier
 *  wake). DECISION_GATE_WAKE_TRIAGE_DEFER_MIN, default 30, clamped 5–105.
 *  Ceiling (WI-R, 2026-09-25): the old 180-min cap exceeded the 2 h
 *  STALE_QUIET_EVENT_MS bound below — a triaged row is quiet by construction,
 *  so a park of ≥120 min would have been CONSUMED as stale at delivery with no
 *  wake, making the "nothing is lost" promise false. The cap now sits 15 min
 *  under the stale bound (WAKE_TRIAGE_DEFER_MAX_MIN); the stale guard also
 *  exempts triaged rows (see deliverHookGroup) for the park + busy-streak case. */
export const WAKE_TRIAGE_DEFER_MAX_MIN = 105;
export function WAKE_TRIAGE_DEFER_MS(): number {
  const raw = Number(process.env.DECISION_GATE_WAKE_TRIAGE_DEFER_MIN);
  const min = Number.isFinite(raw) && raw > 0 ? Math.min(WAKE_TRIAGE_DEFER_MAX_MIN, Math.max(5, raw)) : 30;
  return min * 60 * 1000;
}

/**
 * PARKED WAKES RIDE, NEVER START ONE ON THEIR OWN (audit 2026-10-06 T3-1).
 * Prod (crosscutting / fleet F2 / schooltime F3 / stanne #10): 29/42, 27/37,
 * 13/13 and 6/9 triage-parked rows were later delivered ALONE as exactly the
 * no-op turns the gate predicted — three leaks: (a) the run-finalize drain
 * (sweepHookEvents ignoreRetryAt) and the retiring-colour un-park released a
 * parked row the moment ANY turn ended; (b) the 30-min retryAt expiry started
 * a solo wake that was never re-triaged; (c) a parked row merged into a fresh
 * group (window / sibling drain) SKIPPED triage for the whole group
 * (`rows.some(triagedAt)`). Now:
 *   - a HELD park (payload.triagedAt, retryAt in the future) never starts a
 *     group from the finalize drain / un-park and is never "deliverable now"
 *     for the hooks-first arbitration — it only RIDES a wake something else
 *     starts (window + sibling drain pull it in, exactly as before);
 *   - a group is triaged whenever triage would run, parked rows included —
 *     a batch made only of parked rows (retryAt expired) is RE-TRIAGED and
 *     re-parks while still quiet;
 *   - a MAX HOLD (WAKE_TRIAGE_MAX_HOLD_MIN, default 120, clamped 30..1380 —
 *     under the 24 h dead-letter horizon) bounds the deferral, counted from
 *     the FIRST park (payload.firstTriagedAt): past it the rows deliver
 *     without a fresh triage (the STALE banner of WI-R still applies);
 *   - the park decision's stash rides in the row (payload.triageParkStash)
 *     and is labelled by the finalize of the wake the row later rides
 *     (DecisionStash.also). Only a delivery made purely of parked rows whose
 *     hold expired enters the fit; every other ride (a fresh row or an alarm
 *     in the batch, a re-triage that changed its mind) is a measured fact
 *     stamped excludeFromFit (extra.pinned) — its attribution is ambiguous.
 * Kill switch WAKE_TRIAGE_PARK_RIDE_DISABLED=1 restores the pre-audit
 * behaviour byte-for-byte (finalize drains + un-park release parks, a group
 * holding any parked row is never triaged, no max hold, no stash in the row).
 */
export function wakeTriageParkRideDisabled(): boolean {
  return process.env.WAKE_TRIAGE_PARK_RIDE_DISABLED === '1';
}
export const WAKE_TRIAGE_MAX_HOLD_DEFAULT_MIN = 120; // integrator 2026-10-06: matches the 2 h stock sweep cadence (T3 shipped 360)
export function WAKE_TRIAGE_MAX_HOLD_MS(): number {
  const raw = Number(process.env.WAKE_TRIAGE_MAX_HOLD_MIN);
  const min = Number.isFinite(raw) && raw > 0 ? Math.min(23 * 60, Math.max(30, raw)) : WAKE_TRIAGE_MAX_HOLD_DEFAULT_MIN;
  return min * 60 * 1000;
}
/** A row the decision gate parked (payload.triagedAt stamped). */
export function isTriageParkedRow(r: any): boolean {
  return !!(r?.payload as any)?.triagedAt;
}
/** When the row was FIRST parked (firstTriagedAt → triagedAt → createdAt). NaN-safe: an unreadable stamp falls through. */
export function triageParkFirstAtMs(r: any): number {
  const p = (r?.payload ?? {}) as any;
  for (const v of [p.firstTriagedAt, p.triagedAt, r?.createdAt]) {
    const t = v instanceof Date ? v.getTime() : new Date(String(v ?? '')).getTime();
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}
/** The parked row's max hold has elapsed — it delivers (rides or alone) without a fresh triage. */
export function triageHoldExpired(r: any, nowMs: number = Date.now()): boolean {
  return isTriageParkedRow(r) && nowMs - triageParkFirstAtMs(r) >= WAKE_TRIAGE_MAX_HOLD_MS();
}
/**
 * LANE-IDLE-WAKE (2026-10-20, coding/lane-idle.ts): a DELAYED direct wake
 * carries payload.notBefore (and retryAt = notBefore at insert). Until then it
 * is not due ANYWHERE — not on the sweep (the retryAt filter), not on a
 * run-finalize drain that ignores busy parks, not riding a window / sibling
 * drain, not in the hooks-first arbitration, not released by the retiring
 * colour's un-park — and a claimed group hands it back to 'pending' at once
 * (deliverHookGroup). Only rows that carry the stamp are affected. Pure.
 */
export function hookRowNotYetDue(r: any, nowMs: number = Date.now()): boolean {
  const nb = (r?.payload as any)?.notBefore;
  if (nb === undefined || nb === null || nb === '') return false;
  const t = new Date(String(nb)).getTime();
  return Number.isFinite(t) && t > nowMs;
}
/** A parked row still inside its park window (retryAt in the future, hold not expired): rides, never starts a wake. */
export function isHeldTriagePark(r: any, nowMs: number = Date.now()): boolean {
  if (wakeTriageParkRideDisabled() || !isTriageParkedRow(r)) return false;
  const retryMs = r?.retryAt ? new Date(r.retryAt).getTime() : NaN;
  return Number.isFinite(retryMs) && retryMs > nowMs && !triageHoldExpired(r, nowMs);
}
/** The park decision's stash as it rides in a hook row: no challengers, no siblings (bounded row size). */
function slimParkStash(s: DecisionStash | null): DecisionStash | null {
  if (!s) return null;
  const { challengers: _c, also: _a, ...rest } = s;
  return rest as DecisionStash;
}
/**
 * The park stashes riding a delivered wake (audit 2026-10-06 T3-1), one per
 * distinct park decision, each stamped extra.parkRide. `clean` (a wake made
 * purely of parked rows delivered on the max hold, no fresh triage) leaves the
 * label in the fit; anything else stamps extra.pinned → the finalize writes
 * excludeFromFit (decision-outcome-labels.ts). Exported for tests.
 */
export function parkRideLabelStashes(riders: any[], opts: { clean: boolean }): DecisionStash[] {
  const seen = new Set<string>();
  const out: DecisionStash[] = [];
  for (const r of riders) {
    const s = (r?.payload as any)?.triageParkStash;
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ ...s, extra: { ...(s.extra && typeof s.extra === 'object' ? s.extra : {}), parkRide: opts.clean ? 'hold_expired' : 'ride', ...(opts.clean ? {} : { pinned: true }) } });
  }
  return out;
}
/** Retry horizon (v1#1): a pending row older than this dead-letters as
 *  'failed:horizon' — visible (owner notice + warn + metric), never silent. */
export const RETRY_HORIZON_MS = 24 * 60 * 60 * 1000;
const STALE_DELIVERING_MS = 5 * 60 * 1000;
/**
 * Stale-event freshness bound (ticket 2b1609b2, 2026-09-13): a parked row can
 * wait behind a busy target for HOURS (busy parks freeze attempts by design,
 * so only the 24h horizon bounded the wait) and then deliver VERBATIM as if
 * fresh — observed: a supervisor wake at 09:46Z delivering run_completed
 * summaries emitted ~21h earlier, and a child result-hook delivered ~9h late;
 * both woken runs burned a full machine run just to re-verify and dismiss
 * day-old state. At delivery, QUIET (non-alarm) rows older than this are
 * consumed (delivered, annotated) with NO wake; ALARM rows older than this
 * still deliver but carry an explicit STALE banner so the woken run treats
 * them as historical. 2h = 2× the supervisor wildcard debounce window — well
 * above legitimate busy parks, far below the 24h dead-letter horizon.
 */
export const STALE_QUIET_EVENT_MS = 2 * 60 * 60 * 1000;
const DEPTH_TTL_SEC = 60 * 60;
const DEPTH_KEY = (chatId: string) => `fleet:hookdepth:${chatId}`;
/** Cross-instance debounce gate: SET NX PX per hook (see deliverHookGroup). */
const DEBOUNCE_GATE_KEY = (hookId: string) => `fleet:hookdebounce:${hookId}`;

/**
 * Rendered when hook.promptTemplate is empty. Placeholders: {{eventType}}
 * {{sourceChatTitle}} {{sourceChatId}} {{summary}}.
 *
 * Hardening 2026-09-14: the wake used to name the source chat by TITLE only
 * ("Worker task" / "Untitled session" collide across a project), so the woken
 * supervisor resolved the id by title via list_chats — ambiguous — and then
 * called get_chat_status on the wrong child or cited a fabricated id (~3
 * invented ids per wake observed). The id now rides the wake itself, on its
 * own line right after the event line (the first line is pinned by tests and
 * by every custom template that embeds it). Multi-source digests carry each
 * id in the per-source "### title (chat <id>)" header (see coalesce).
 */
export const DEFAULT_PROMPT_TEMPLATE =
  'Fleet event from chat "{{sourceChatTitle}}" ({{eventType}}): {{summary}}\n' +
  // No literal "### " in this text — header-count pins (/### /g) must count only real per-source headers.
  'Source chat id: {{sourceChatId}} — copy it VERBATIM as the tool input for get_chat_status / get_chat_messages / ' +
  'send_chat_message (a multi-source digest carries each id in its per-source header as "(chat <id>)"); cite only its first 8 chars in your note.\n\n' +
  // Layered prompts (2026-09-27): the tier is generic ("supervisor wake") — a
  // project supervisor and the fleet seat receive the same template.
  '[This is an autonomous supervisor wake — no user is on this turn. React as the supervisor: ' +
  'check on the source chat, nudge or dispatch follow-up work within your granted autonomy, and keep it brief.]';

export interface HookEventPayload {
  eventType: string;
  sourceChatId: string;
  sourceChatTitle: string;
  summary: string;
  depth: number;
  runId?: string;
  /** Emitter-supplied passthrough fields (e.g. schedule_disabled's scheduleId/
   *  kind/runsCount/reason) — the fixed fields above always win on collision. */
  [extra: string]: unknown;
}

export interface EventHookView {
  id: string;
  sourceChatId: string | null; // null = wildcard (every chat owned by the hook's userId)
  targetChatId: string;
  /** Present only on PROJECT-SCOPE hooks (sourceChatId null + projectId set —
   *  the per-project supervisor lane): only chats in this project emit. */
  projectId?: string;
  eventTypes: string[];
  promptTemplate: string;
  enabled: boolean;
  debounceSec: number;
  lastFiredAt: string | null;
  createdAt: string;
  /** Creator provenance (ticket dd3a19fa) — present only on rows stamped at
   *  create time (rows predating the columns carry none). createdVia:
   *  'tool:hook_subscribe' | 'rest' (POST /platform/hooks) |
   *  'system:child-result-hook' | 'system:direct-wake' |
   *  'system:fleet-supervisor'; createdByChatId/createdByRunId name the lane +
   *  agent run that made the call (absent on REST creates). */
  createdVia?: string;
  createdByChatId?: string;
  createdByRunId?: string;
  /** Set ONLY on a subscribe that found the (source, target) pair already
   *  wired (ticket c65de47c pair dedup): the existing row was updated in
   *  place and re-armed — NO second hook row was created. Absent on fresh
   *  creates and on every other read path. */
  deduped?: boolean;
}

function toView(h: any): EventHookView {
  return {
    id: h.id,
    sourceChatId: h.sourceChatId,
    targetChatId: h.targetChatId,
    ...(h.projectId ? { projectId: h.projectId } : {}),
    eventTypes: h.eventTypes ?? [],
    promptTemplate: h.promptTemplate ?? '',
    enabled: h.enabled !== false,
    debounceSec: h.debounceSec ?? DEFAULT_DEBOUNCE_SEC,
    lastFiredAt: h.lastFiredAt ? (h.lastFiredAt instanceof Date ? h.lastFiredAt.toISOString() : h.lastFiredAt) : null,
    createdAt: h.createdAt instanceof Date ? h.createdAt.toISOString() : h.createdAt,
    ...(h.createdVia ? { createdVia: h.createdVia } : {}),
    ...(h.createdByChatId ? { createdByChatId: h.createdByChatId } : {}),
    ...(h.createdByRunId ? { createdByRunId: h.createdByRunId } : {}),
  };
}

/* ── Depth propagation (loop bound) ──────────────────────────────────────────
 * A delivered wake stamps fleet:hookdepth:<targetChatId> = incoming depth + 1
 * (1h TTL). The woken run's OWN emissions read the stamp via depthForChat
 * (when the caller passes no explicit depth). The finalize paths clear the
 * stamp after emitting.
 *
 * SEND HOPS: the delivery stamp alone is NOT enough — a hook-woken
 * supervisor's send_chat_message starts the target's run outside this module,
 * so without propagation the target emits run_completed at depth 0 and the
 * supervisor→nudge→run_completed→wake cycle loops forever (the cap never
 * binds; audit finding 2026-08-13). Agent-origin send paths
 * (platform.service.sendChatMessage + the busy-chat queue drain) therefore
 * call stampHookDepth with the SENDER's live depth, so the nudged chat's
 * completion emits AT the sender's rung and the ladder genuinely climbs to
 * MAX_HOOK_DEPTH through send hops. */

/** The depth a chat's next emission should carry. Best-effort: Redis hiccup ⇒ 0. */
export async function depthForChat(chatId: string): Promise<number> {
  try {
    const v = await redisClient.get(DEPTH_KEY(chatId));
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** Clear a chat's depth stamp (the finalize paths call this after emitting). Best-effort. */
export async function clearHookDepth(chatId: string): Promise<void> {
  await redisClient.del(DEPTH_KEY(chatId)).catch(() => {});
}

/**
 * Raise a chat's wake-depth stamp to AT LEAST `depth` (1h TTL). Monotonic MAX
 * — never lowers an existing stamp, so a concurrent shallower writer (another
 * hook's delivery, a second agent send) cannot understate the ladder. Callers:
 * wake delivery (deliverHookGroup, depth+1) and the agent-origin send paths
 * propagating the sender's depth onto the send target (see the section note
 * above). No-op at depth <= 0; best-effort (Redis hiccup ⇒ the ladder degrades
 * to whatever is already stamped, exactly like depthForChat's 0 fallback).
 */
export async function stampHookDepth(chatId: string, depth: number): Promise<void> {
  if (!Number.isFinite(depth) || depth <= 0) return;
  try {
    const current = await depthForChat(chatId);
    if (current >= depth) return;
    await redisClient.set(DEPTH_KEY(chatId), String(Math.floor(depth)), { EX: DEPTH_TTL_SEC });
  } catch { /* best-effort */ }
}

/**
 * Ladder/route controls an emitter may pass alongside its passthrough fields.
 * `actorChatId` (hardening 2026-09-14) names the chat that PERFORMED the
 * action when it differs from the source (goals.service todo_done: source =
 * assignee, actor = the chat that ran todo_update); a hook targeting the actor
 * is skipped (actor-echo suppression) and the field never lands in the payload.
 */
export type HookEmitExtra = { runId?: string; depth?: number; actorChatId?: string } & Record<string, unknown>;

/**
 * The fleet-event rollup key of an emission (fleet-event-rollup.service). An
 * ALLCOMPLETE-CHARTER-TERMINATION idle-skip notice rides schedule_cap_skipped
 * (payload kind 'all_complete_idle') but is NOT a daily-cap hit, so it is
 * counted under its own key `schedule_cap_skipped:all_complete_idle` and never
 * inflates the cap-skip KPI. Every other emission keeps its event type. Pure.
 */
export function fleetRollupEventKey(eventType: string, extra?: Record<string, unknown> | null): string {
  return eventType === 'schedule_cap_skipped' && extra?.kind === 'all_complete_idle'
    ? 'schedule_cap_skipped:all_complete_idle'
    : eventType;
}

/**
 * Emit one fleet event: insert a pending HookEvent per enabled hook on
 * sourceChatId subscribed to eventType. NEVER throws (the emitting run's
 * finalize must not depend on the outbox). Self-loops are skipped; emissions
 * at/above the depth cap are dropped; the source chat title is looked up once.
 */
export async function emitHookEvent(
  sourceChatId: string,
  eventType: HookEventType,
  summary: string,
  extra?: HookEmitExtra,
): Promise<void> {
  await emitHookEventCounted(sourceChatId, eventType, summary, extra);
}

/**
 * emitHookEvent, reporting what happened (CI-WATCH review fix 2026-10-20 —
 * the ci-watch escalation must know whether anyone heard it): `written` =
 * outbox rows inserted; `error` = the emission failed (an exception, or every
 * matching insert failed) — a caller may retry. A zero-subscriber / depth-capped
 * / deduped emission is `{ written: 0, error: false }`. NEVER throws.
 */
export async function emitHookEventCounted(
  sourceChatId: string,
  eventType: HookEventType,
  summary: string,
  extra?: HookEmitExtra,
): Promise<{ written: number; error: boolean }> {
  // build 2026-10-08 D-1: every run outcome of every chat passes here — the delegation ledger moves the tasks this
  // chat was working (SHADOW, fire-and-forget, before the depth cap: the lifecycle happened whoever listens).
  noteChatRunEvent(sourceChatId, eventType, typeof extra?.runId === 'string' ? extra.runId : null);
  try {
    const depth = extra?.depth ?? (await depthForChat(sourceChatId));
    if (depth >= MAX_HOOK_DEPTH) return { written: 0, error: false }; // depth cap — autonomous loops die here
    // Actor-echo suppression handle (hardening 2026-09-14): the chat that
    // performed the action, when the emitter knows it and it is not the source.
    const actorChatId = typeof extra?.actorChatId === 'string' && extra.actorChatId.trim() ? extra.actorChatId.trim() : null;

    // KPI ledger (feedback 4e36ee4a): EVERY emission admitted past the depth
    // ladder counts here — BEFORE the zero-subscriber short-circuit below, so
    // an emission with no matching hook still lands in the durable rollup (it
    // persists no HookEvent row anywhere). Fire-and-forget; the delivered half
    // lands after the fan-out loop. Depth-capped drops above are deliberately
    // NOT counted: the ladder killed them, they were never emitted.
    noteFleetEventEmitted(fleetRollupEventKey(eventType, extra));

    // ── EMIT-TIME FINGERPRINT DEDUPE (audit 2026-10-16 item 3 fix B, todo
    // 21c11618) ──
    // A re-emission of the SAME (eventType, source, summary) within a short
    // window — a lane re-registering the same pending question/approval after
    // a restart, a retry loop re-firing the same alert — previously minted a
    // fresh hook_events row per call and every alarm row is a guaranteed
    // immediate wake (alarm rows bypass debounce, cap, material-gate and
    // triage). One Redis NX key per fingerprint (all hooks share it: the row
    // never existed, so no target is starved); window env-tunable
    // HOOK_EVENT_DEDUPE_WINDOW_SEC (default 600, 0 = off); FAIL-OPEN — any
    // Redis error emits as before. Kill switch HOOK_EVENT_DEDUPE_DISABLED=1.
    if (
      eventType === 'attention_needed' || eventType === 'schedule_disabled' || eventType === 'schedule_cap_skipped'
    ) {
      if (process.env.HOOK_EVENT_DEDUPE_DISABLED !== '1' && Number(process.env.HOOK_EVENT_DEDUPE_WINDOW_SEC ?? 600) > 0) {
        try {
          const win = Math.max(15, Number(process.env.HOOK_EVENT_DEDUPE_WINDOW_SEC ?? 600));
          // Fingerprint on the RAW summary head — redaction happens later
          // (safeSummary) and must not change the fingerprint's meaning; both
          // sides of a duplicate carry the same raw text anyway.
          const fp = Buffer.from(JSON.stringify([eventType, sourceChatId, String(summary ?? '').slice(0, 120)])).toString('base64url').slice(0, 120);
          const key = `hookemit:dedupe:${fp}`;
          const first = await redisClient.set(key, String(Date.now()), { NX: true, EX: win });
          if (first !== 'OK') {
            logger.info(`hooks: deduped ${eventType} from ${sourceChatId.slice(0, 8)} — identical emission within ${win}s (audit 2026-10-16 21c11618 fix B)`);
            recordLoopMetric({ kind: 'hook_emit_deduped', sessionId: sourceChatId, value: 1, meta: { eventType, windowSec: win } });
            return { written: 0, error: false };
          }
        } catch { /* fail-open: emit as before */ }
      }
    }


    // Specific hooks match their one sourceChatId; WILDCARD hooks
    // (sourceChatId NULL — the Fleet Supervisor's) match every chat.
    const hooks = await prisma.eventHook.findMany({
      where: {
        enabled: true,
        eventTypes: { has: eventType },
        OR: [{ sourceChatId }, { sourceChatId: null }],
      },
    });
    if (!hooks.length) return { written: 0, error: false };

    const sourceChat = await prisma.crossModelChat
      .findUnique({
        where: { id: sourceChatId },
        // projectId (scalar) alongside the project relation: the project-scope
        // hook lane matches on the scalar; the owner-scope wildcard lane reads
        // project.supervised for the fleet opt-out skip and
        // project.projectSupervisorEnabled for the fleet-feed shed.
        // isProjectSupervisor (hardening 2026-09-14): the shed also covers the
        // project supervisor's OWN quiet completions (see fleetFeedShed).
        // audit 2026-10-06 T3-2: + isSupervisor / codingState — the owner's
        // plain personal chats are shed from the Fleet's wildcard feed.
        select: {
          title: true, userId: true, projectId: true, isProjectSupervisor: true, isSupervisor: true,
          codingState: { select: { id: true } },
          project: { select: { supervised: true, projectSupervisorEnabled: true } },
        },
      })
      .catch(() => null);
    const sourceChatTitle = sourceChat?.title ?? '';

    // Project-supervisor preflight 2026-09-14: the fleet-feed shed applies to
    // this emission when (a) it is a QUIET shed-class event, (b) the source
    // chat's project has projectSupervisorEnabled=true, (c) EITHER the source
    // chat IS the project supervisor (hardening 2026-09-14: its only project
    // hook targets itself and self-loop-suppresses, so its own run_completed /
    // todo_done has no fan-in by construction and its channel up is
    // send_chat_message — without this clause every supervisor wake, "WAKE:
    // no-op" included, re-entered the fleet digest the shed exists to shrink)
    // OR the SAME fetched hook set holds an enabled, same-owner project-scope
    // hook for that project subscribed to this event type whose target is
    // neither the source nor the acting chat (so the row provably lands in
    // the project supervisor's outbox — the fleet never sheds into a void;
    // the actor clause keeps that promise honest under actor-echo
    // suppression below). Keeping (b) means a PAUSED lane's turns still reach
    // the fleet unchanged.
    const shedProjectId = sourceChat?.projectId ?? null;
    const selfSource = sourceChat?.isProjectSupervisor === true;
    const quietShedType = (FLEET_FEED_SHED_EVENT_TYPES as readonly string[]).includes(eventType);
    const projectHookCovers = () => hooks.some((h) =>
      h.sourceChatId === null && h.projectId != null && h.projectId === shedProjectId
      && h.enabled !== false && h.userId === sourceChat?.userId && h.targetChatId !== sourceChatId
      && h.targetChatId !== actorChatId);
    const fleetFeedShed =
      quietShedType
      && shedProjectId != null
      && sourceChat?.project?.projectSupervisorEnabled === true
      && (selfSource || projectHookCovers());
    // audit 2026-10-06 T3-2 — what the Fleet Supervisor is NOT woken by (each
    // route-only, owner-scope wildcard / fleet-targeted lanes only, alarm rows
    // untouched): (a) a project supervisor's OWN quiet completions whatever its
    // project's toggle says (a "disabled" PS that still parents lanes ran 116
    // turns → 48 Fleet rows); (b) run_completed of the owner's PLAIN non-coding,
    // non-supervisor chats (personal Q&A — penne pictures, calendars, X digests);
    // (c) a DIRECT per-chat hook into the Fleet when an enabled project
    // supervisor already fans the same quiet event in (legacy 34144716 doubled
    // every crossmodel lane completion). Kill switches, one each:
    // HOOK_FLEET_SHED_PS_ANY_TOGGLE_DISABLED / HOOK_FLEET_SHED_PLAIN_CHAT_DISABLED /
    // HOOK_FLEET_SHED_DIRECT_COVERED_DISABLED.
    const psSelfAnyToggleShed = !fleetFeedShed
      && process.env.HOOK_FLEET_SHED_PS_ANY_TOGGLE_DISABLED !== '1'
      && quietShedType && selfSource;
    const plainChatShed = process.env.HOOK_FLEET_SHED_PLAIN_CHAT_DISABLED !== '1'
      && eventType === 'run_completed'
      && !!sourceChat && 'codingState' in (sourceChat as object) && (sourceChat as any).codingState === null
      && (sourceChat as any).isSupervisor !== true && sourceChat.isProjectSupervisor !== true;
    // (b), (c) and T3-5 (below) need to know which hook TARGETS are Fleet
    // Supervisor chats — one bounded read, only when a candidate exists.
    // Fail-open (no shed).
    const directCoveredOn = process.env.HOOK_FLEET_SHED_DIRECT_COVERED_DISABLED !== '1'
      && quietShedType && shedProjectId != null && sourceChat?.project?.projectSupervisorEnabled === true && !selfSource
      && projectHookCovers();
    // audit 2026-10-06 T3-5: a schedule_disabled whose ACTOR (the chat whose
    // run cancelled / paused the row — schedule.service passes actorChatId) is
    // the PROJECT SUPERVISOR that owns it (its own chat or a lane of its
    // project) is a supervisor-initiated wind-down: the actor is never woken
    // (actor-echo below) and it is not forwarded to the Fleet either. Absent
    // actor (owner UI / system stops) = today's alarm to both lanes.
    // Kill switch HOOK_SCHEDULE_DISABLED_ACTOR_SHED_DISABLED=1.
    //
    // audit 2026-10-16 item 3 (todo 21c11618) — the LANE SELF-CANCEL class:
    // actor === source (the lane's own run called cancel_schedule /
    // pause_schedule on its own row) is the SAME supervisor-initiated wind-down
    // seen from the other side: the lane chose to stop itself, its project
    // supervisor still hears it through the project-scope hook, and forwarding
    // it to the Fleet Supervisor is pure noise (baseline 10-13→10-15: 31 of 40
    // schedule_disabled rows were self-cancels; 16 woke the Fleet via the
    // owner-scope wildcard — every one a no-op wake). Same routing as T3-5:
    // shed the owner-scope wildcard + direct Fleet-targeted lanes only, alarm
    // class to the PROJECT hook unchanged. Kill switch
    // HOOK_SCHEDULE_DISABLED_SELF_ACTOR_SHED_DISABLED=1.
    let supervisorActorOwns = false;
    let selfActorShed = false;
    if (eventType === 'schedule_disabled' && actorChatId && process.env.HOOK_SCHEDULE_DISABLED_ACTOR_SHED_DISABLED !== '1') {
      try {
        const actor = actorChatId === sourceChatId
          ? sourceChat
          : await prisma.crossModelChat.findUnique({ where: { id: actorChatId }, select: { userId: true, projectId: true, isProjectSupervisor: true } });
        supervisorActorOwns = !!actor && actor.isProjectSupervisor === true && actor.userId === sourceChat?.userId
          && (actorChatId === sourceChatId || (!!actor.projectId && actor.projectId === sourceChat?.projectId));
        selfActorShed = !supervisorActorOwns
          && process.env.HOOK_SCHEDULE_DISABLED_SELF_ACTOR_SHED_DISABLED !== '1'
          && actorChatId === sourceChatId
          && (sourceChat as any)?.isSupervisor !== true; // a Fleet Supervisor's own rows keep today's routing
      } catch { supervisorActorOwns = false; selfActorShed = false; }
    }
    // FLEET-PS-FIRST (supervisor SOTA round 2, 2026-10-20; platform/fleet-ps-first.ts):
    // an alarm-class / cadence event from a lane whose project has an ENABLED
    // project supervisor that provably receives it (the same projectHookCovers
    // test the quiet shed uses — a PS's own events are never covered, its hook
    // targets itself) and the project-supervisor switch ON does NOT write the
    // Fleet Supervisor's OWNER-SCOPE WILDCARD row: an alarm-class row is held
    // as ONE delayed escalation, a quiet row (cadence signal / quiet cause) is
    // shed (below, after the loop). Direct hooks into the Fleet (an explicit
    // watch, a child-result hook) are never held. Fail-open: a switch read
    // error, an enqueue error ⇒ today's immediate row. Kill switch
    // HOOK_FLEET_ALARM_PS_FIRST_DISABLED=1.
    let psFirst = !fleetAlarmPsFirstDisabled()
      && isPsFirstEventType(eventType)
      && shedProjectId != null
      && sourceChat?.project?.projectSupervisorEnabled === true
      && !selfSource && (sourceChat as any)?.isSupervisor !== true
      && projectHookCovers();
    if (psFirst) {
      try { psFirst = await getProjectSupervisorsEnabled(); } catch { psFirst = false; }
    }
    // (b) and T3-5 shed from the owner-scope wildcard only when its target IS a
    // Fleet Supervisor chat — a user may wire a wildcard to any chat (shipped
    // feature) and that deliberate feed is never thinned.
    let fleetTargetIds = new Set<string>();
    if (directCoveredOn || supervisorActorOwns || selfActorShed || plainChatShed || psFirst) {
      const candidates = [...new Set(hooks
        .filter((h) => (h.sourceChatId === sourceChatId && h.targetChatId !== sourceChatId && h.userId === sourceChat?.userId
          && !isChildResultTemplate(h.promptTemplate) && h.createdVia !== 'system:child-result-hook')
          || ((plainChatShed || supervisorActorOwns || selfActorShed || psFirst) && h.sourceChatId === null && h.projectId == null && h.userId === sourceChat?.userId))
        .map((h) => h.targetChatId))];
      if (candidates.length) {
        try {
          const sups = await prisma.crossModelChat.findMany({ where: { id: { in: candidates }, isSupervisor: true }, select: { id: true } });
          fleetTargetIds = new Set((sups ?? []).map((s: any) => String(s.id)));
        } catch { fleetTargetIds = new Set(); }
      }
    }

    // Alarm-class self-loop exemption (v1#8): a supervisor's wildcard hook
    // targets the supervisor chat itself, so goal_blocked emitted from a
    // supervisor-created goal's chat used to self-suppress — the fleet's own
    // watcher was the one chat that could never hear its goals block. Alarm
    // events (the smoke detectors) now pass the self-loop gate; quiet events
    // keep the suppression (they are exactly the class that loops forever).
    // The depth ladder still bounds any alarm self-cycle at MAX_HOOK_DEPTH.
    // Gate flip 2026-09-11 (owner: full steam): the exemption is now DEFAULT
    // OFF — all 41 self-loop alarm rows since deploy were the Fleet Supervisor
    // alarming ITSELF about its OWN schedules (busy-skips + once-cancels),
    // 7 of them a wake woken by its own alarm alarming again; 0 goal_blocked /
    // run_failed self-events ever occurred. Self-loops are suppressed for
    // every event class.
    const writtenHookIds: string[] = [];
    let insertFailures = 0;
    // CI-WATCH (2026-10-20, coding/ci-watch.service.ts): the project supervisor
    // hears ci_failed LANE FIRST — its project-scope row is written only when
    // the source lane is not live (no run in flight, no wake queued) or when
    // the emission says the lane-first leg already ran (ci-watch escalation:
    // extra.ciWatchEscalation). An in-run check_ci / post-push emission is
    // the lane reading its own red CI — the supervisor is not woken for it;
    // the ci-watch cron escalates later if the sha stays red while the lane
    // idles. Resolved once per emission, lazily (only ci_failed reaches it).
    // Fail toward delivery: any probe error delivers.
    // Review fix: the gate covers ONLY the hooks ci-watch provisioned — a
    // project-scope hook whose target is a project-supervisor chat and whose
    // types are all stock (project-supervisor.service isStockProjectHookEventSet;
    // the ensure unions ci_failed into exactly those). A hand-made project hook
    // (any other target, or a custom type) delivers as before. Kill switch
    // CI_WATCH_DISABLED=1 drops ci_failed on the gated hooks only (their
    // subscription exists because of ci-watch — pre-2026-10-20 no stock hook
    // carried it); every other subscriber is delivered exactly as before.
    let ciPsVerdict: 'deliver' | 'lane_live' | 'disabled' | null = null;
    const ciPsGate = async (): Promise<'deliver' | 'lane_live' | 'disabled'> => {
      if (ciPsVerdict) return ciPsVerdict;
      try {
        const cw = await import('../coding/ci-watch.service');
        if (cw.ciWatchDisabled()) ciPsVerdict = 'disabled';
        else if (typeof extra?.ciWatchEscalation === 'string' && extra.ciWatchEscalation) ciPsVerdict = 'deliver';
        else ciPsVerdict = (await cw.isLaneLive(sourceChatId)) ? 'lane_live' : 'deliver';
      } catch {
        ciPsVerdict = 'deliver';
      }
      if (ciPsVerdict !== 'deliver') {
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.CI_WATCH, sessionId: sourceChatId, value: 1, meta: { phase: 'ps_row_skipped', reason: ciPsVerdict, sha: typeof extra?.sha === 'string' ? extra.sha : null } });
      }
      return ciPsVerdict;
    };
    let ciManagedTargets: Set<string> | null = null;
    const ciWatchManagedHook = async (hook: { sourceChatId: string | null; projectId?: string | null; targetChatId: string; eventTypes?: string[] | null }): Promise<boolean> => {
      if (hook.sourceChatId !== null || hook.projectId == null) return false;
      try {
        if (!ciManagedTargets) {
          const ids = [...new Set(hooks.filter((h) => h.sourceChatId === null && h.projectId != null).map((h) => h.targetChatId))];
          const rows = ids.length
            ? await prisma.crossModelChat.findMany({ where: { id: { in: ids }, isProjectSupervisor: true }, select: { id: true } })
            : [];
          ciManagedTargets = new Set((rows ?? []).map((r: any) => String(r.id)));
        }
        if (!ciManagedTargets.has(hook.targetChatId)) return false;
        const ps = await import('./project-supervisor.service');
        return ps.isStockProjectHookEventSet(Array.isArray(hook.eventTypes) ? hook.eventTypes : []);
      } catch {
        return false; // fail toward delivery: an unclassifiable hook delivers as before
      }
    };
    // audit 2026-10-06 T3-3: redact once per emission; a hit is observable.
    const safeSummary = redactHookSummary(summary);
    let redactionNoted = false;
    // One outbox row for one hook (the payload carries the passthrough fields). True when written.
    const writeRow = async (hook: (typeof hooks)[number]): Promise<boolean> => {
      // Passthrough: extra fields beyond the ladder/route controls (runId/depth/
      // actorChatId) land in the payload verbatim (schedule_disabled carries
      // scheduleId/sessionId/kind/runsCount/reason). Fixed fields win on
      // collision — spread first.
      const { runId: _runId, depth: _depth, actorChatId: _actorChatId, ...passthrough } = extra ?? {};
      const payload: HookEventPayload = {
        ...passthrough,
        eventType,
        sourceChatId,
        sourceChatTitle,
        // audit 2026-10-06 T3-3: a run_completed summary is the run's final
        // answer — an owner-typed password there rode a Fleet wake (01c079e3).
        summary: truncateSummary(safeSummary),
        depth,
        ...(extra?.runId ? { runId: extra.runId } : {}),
      };
      if (!redactionNoted && safeSummary !== String(summary ?? '')) {
        redactionNoted = true;
        recordLoopMetric({ kind: 'hook_summary_redacted', sessionId: sourceChatId, value: 1, meta: { eventType, stage: 'emit' } });
      }
      try {
        await prisma.hookEvent.create({
          data: { hookId: hook.id, userId: hook.userId, eventType, payload: payload as unknown as object },
        });
        writtenHookIds.push(hook.id);
        // Owner 2026-09-29 ("operate off hooks"): a project-scope hook row may
        // carry a milestone for the owner — ask for a (debounced, change-only)
        // project status check of its supervisor chat.
        if (hook.sourceChatId === null && hook.projectId != null) {
          void import('../fleet/project-status.service')
            .then((m) => m.requestProjectStatusCheck(hook.targetChatId, eventType))
            .catch(() => {});
        }
        return true;
      } catch (err: any) {
        insertFailures++;
        logger.warn(`hook event insert failed (hook ${String(hook.id).slice(0, 8)}, ${eventType}): ${err?.message}`);
        return false;
      }
    };
    // FLEET-PS-FIRST: Fleet Supervisor chat → its owner-scope wildcard hook(s) whose row is held / shed.
    const psFirstHeld = new Map<string, Array<(typeof hooks)[number]>>();
    // FLEET-PS-FIRST: Fleet chats this emission already reached through a DIRECT hook (an explicit watch / child-result).
    const psFirstDirectWritten = new Set<string>();
    for (const hook of hooks) {
      if (hook.targetChatId === sourceChatId) continue; // self-loop suppression (all classes)
      // ACTOR-ECHO SUPPRESSION (hardening 2026-09-14): the chat that performed
      // the action must not be woken by its own action. todo_done emits FROM
      // the assignee (so direct per-worker hooks keep firing), so target==source
      // above never caught a project supervisor closing a worker's todo — the
      // project hook (todo_done subscribed) parked the row and woke the same
      // supervisor after the 600 s window to re-audit its own close (the
      // observed "self-audit" wakes). Same class as the self-loop line;
      // route-only — other targets still get the
      // row, a user/UI close (no actor) wakes as before. Observable: one info
      // line per skipped row (a dedicated loop-metric kind lives in
      // loop-metrics.service — out of this module's hands).
      if (actorChatId && hook.targetChatId === actorChatId) {
        logger.info(`hook ${String(hook.id).slice(0, 8)}: actor-echo suppressed (${eventType} from ${sourceChatId.slice(0, 8)}, actor ${actorChatId.slice(0, 8)} is the target)`);
        continue;
      }
      // audit 2026-10-06 T3-2(c) / T3-5: a DIRECT hook into a Fleet Supervisor
      // chat — shed when an enabled project supervisor already fans this quiet
      // event in, or when the schedule_disabled actor is that project's own
      // supervisor (its wind-down, not a smoke detector for the Fleet).
      if (hook.sourceChatId === sourceChatId && fleetTargetIds.has(hook.targetChatId) && (directCoveredOn || supervisorActorOwns)) {
        continue;
      }
      // Wildcard hooks receive ONLY same-owner emissions — without this filter
      // every user's events would fan into every wildcard hook's outbox (and
      // the delivery ownership re-check would then delete the hook). Applies
      // to BOTH wildcard lanes (owner-scope and project-scope).
      if (hook.sourceChatId === null && hook.userId !== sourceChat?.userId) continue;
      // Project-scope lane (per-project supervisors, 2026-09-13): sourceChatId
      // NULL + projectId SET matches only chats IN that project. Deliberate
      // plumbing — its lifecycle is the enabled flag + the project's
      // projectSupervisorEnabled toggle, so the project.supervised fleet
      // opt-out below deliberately does NOT skip this lane.
      if (hook.sourceChatId === null && hook.projectId != null && sourceChat?.projectId !== hook.projectId) continue;
      // CI-WATCH (2026-10-20): lane first, then the project supervisor (see ciPsGate above).
      if (eventType === 'ci_failed' && (await ciWatchManagedHook(hook)) && (await ciPsGate()) !== 'deliver') {
        logger.info(`hook ${String(hook.id).slice(0, 8)}: ci_failed from ${sourceChatId.slice(0, 8)} not routed to the project supervisor (${ciPsVerdict}) — lane first; ci-watch escalates if the sha stays red`);
        continue;
      }
      // Supervision opt-out: a chat in an UNSUPERVISED project emits nothing to
      // OWNER-SCOPE WILDCARD hooks (the automatic fleet-supervisor framework).
      // Explicitly wired DIRECT hooks — and project-scope hooks above — are
      // deliberate plumbing: they still fire.
      if (hook.sourceChatId === null && hook.projectId == null && sourceChat?.project?.supervised === false) continue;
      // Project-supervisor preflight 2026-09-14: FLEET-FEED SHED (route-only).
      // The project supervisor is the fan-in for this project's quiet events
      // (run_completed / todo_done) and reports up; the owner-scope wildcard
      // keeps every alarm-class row. See FLEET_FEED_SHED_EVENT_TYPES.
      if (fleetFeedShed && hook.sourceChatId === null && hook.projectId == null) {
        continue;
      }
      // audit 2026-10-06 T3-2(a)/(b) + T3-5: the owner-scope wildcard (the
      // Fleet Supervisor's feed) — see the shed flags above.
      const fleetShedReason = hook.sourceChatId === null && hook.projectId == null
        ? (psSelfAnyToggleShed ? 'ps_self_any_toggle'
          : fleetTargetIds.has(hook.targetChatId) ? (plainChatShed ? 'plain_chat' : supervisorActorOwns ? 'supervisor_actor' : selfActorShed ? 'self_actor' : null)
          : null)
        : null;
      if (fleetShedReason) {
        continue;
      }
      // FLEET-PS-FIRST: the Fleet Supervisor's OWNER-SCOPE WILDCARD row for a
      // PS-covered event is decided after the loop (one delayed escalation per
      // Fleet chat, or shed). A DIRECT hook into the Fleet — a deliberate
      // subscribe_to_chat watch, a child-result hook the Fleet waits on — is
      // never held: the Fleet asked to hear that lane at once.
      if (psFirst && fleetTargetIds.has(hook.targetChatId) && hook.sourceChatId === null && hook.projectId == null) {
        const held = psFirstHeld.get(hook.targetChatId) ?? [];
        held.push(hook);
        psFirstHeld.set(hook.targetChatId, held);
        continue;
      }
      const written = await writeRow(hook);
      if (written && psFirst && hook.sourceChatId === sourceChatId) psFirstDirectWritten.add(hook.targetChatId);
    }
    // FLEET-PS-FIRST: hold the escalation(s) for alarm-class rows; shed the
    // quiet ones (a cadence signal / quiet cause would otherwise become an
    // alarm-class todo_wake at the Fleet); a Fleet chat this emission already
    // reached through a direct hook keeps today's immediate wildcard row; an
    // enqueue failure writes the Fleet's original row(s) at once (fail toward
    // delivery).
    if (psFirstHeld.size) {
      const { runId: _r, depth: _d, actorChatId: _a, ...pass } = extra ?? {};
      const isAlarm = isAlarmEvent(eventType, { ...pass, eventType, sourceChatId });
      const wanted = psEscalationWanted(eventType, isAlarm);
      const handles = pickAlarmHandles(extra);
      const psChatIds = [...new Set(hooks
        .filter((h) => h.sourceChatId === null && h.projectId != null && h.projectId === shedProjectId && h.enabled !== false
          && h.userId === sourceChat?.userId && h.targetChatId !== sourceChatId && h.targetChatId !== actorChatId)
        .map((h) => h.targetChatId))].slice(0, PS_ESCALATION_MAX_PS);
      for (const [fleetChatId, heldHooks] of psFirstHeld) {
        const metricBase = { eventType, projectId: shedProjectId, sourceChatId, psChatIds, alarm: isAlarm };
        if (psFirstDirectWritten.has(fleetChatId)) {
          recordLoopMetric({ kind: PS_ESCALATION_METRIC_KIND, sessionId: fleetChatId, value: 1, meta: { ...metricBase, phase: 'direct_watch' } });
          for (const h of heldHooks) await writeRow(h);
          continue;
        }
        if (!wanted) {
          recordLoopMetric({ kind: PS_ESCALATION_METRIC_KIND, sessionId: fleetChatId, value: 1, meta: { ...metricBase, phase: psShedPhase(eventType) } });
          continue;
        }
        const res = await holdPsEscalation({
          fleetChatId,
          projectId: shedProjectId as string,
          psChatIds,
          alarm: {
            eventType, sourceChatId, ...(sourceChatTitle ? { sourceChatTitle } : {}), at: new Date().toISOString(), summary: safeSummary,
            ...(handles ? { handles } : {}),
          },
        });
        if (res.ok) {
          recordLoopMetric({ kind: PS_ESCALATION_METRIC_KIND, sessionId: fleetChatId, value: 1, meta: { ...metricBase, phase: res.mode, hookEventId: res.hookEventId ?? null } });
          continue;
        }
        logger.warn(`hooks: PS-first escalation hold failed for Fleet chat ${fleetChatId.slice(0, 8)} (${res.error}) — delivering the ${eventType} row at once`);
        recordLoopMetric({ kind: PS_ESCALATION_METRIC_KIND, sessionId: fleetChatId, value: 1, meta: { ...metricBase, phase: 'direct_fallback' } });
        for (const h of heldHooks) await writeRow(h);
      }
    }
    // KPI ledger (4e36ee4a): the delivered half — one increment per HookEvent
    // outbox row actually written (rows whose insert failed were logged above
    // and are not counted).
    if (writtenHookIds.length) noteFleetEventDelivered(fleetRollupEventKey(eventType, extra), writtenHookIds.length);
    // INSTANT DELIVERY: push the rows we just wrote instead of waiting for the
    // sweeper tick. Targeted sweep (only these hooks), same delivery path —
    // debounce gate, busy park, window drain, budget — so a busy target still
    // parks and a debounced hook still coalesces. Detached: emission never
    // waits on delivery.
    if (writtenHookIds.length) {
      setImmediate(() => { void sweepHookEvents({ hookIds: writtenHookIds }); });
    }
    return { written: writtenHookIds.length, error: insertFailures > 0 && writtenHookIds.length === 0 };
  } catch (err: any) {
    logger.warn(`hook event emission failed (${eventType} from ${sourceChatId.slice(0, 8)}): ${err?.message}`);
    return { written: 0, error: true };
  }
}

/**
 * Run-finalize drain (owner 2026-09-14): the chat just went idle — deliver its
 * pending rows NOW, including busy-parked rows whose retryAt is still in the
 * future (the park existed only because the chat was busy). Detached; never
 * throws. Called by chat-agent (plain runs) and run-executor (coding runs)
 * after the live-run claim is released.
 */
/**
 * Run-finalize FAIRNESS (owner 2026-09-14 — the fleet chat had 36 quiet rows
 * parked since 11:10Z): chat-agent's finalize drains the busy-chat MESSAGE
 * queue first and only drains hook events when nothing was queued — with a
 * lane report-up landing every ~7 min the fleet's queue was never empty, so
 * its hook backlog starved forever. When the oldest pending row for a target
 * is older than this, the finalize drains HOOKS first (one digest wake) and
 * that wake's own finalize drains the message queue next — alternating when
 * both backlogs exist. Alarm-class rows already bypass every window.
 */
export const HOOK_STARVATION_MS = 5 * 60 * 1000;

/** Age (ms) of the oldest pending hook row targeting `targetChatId`; 0 when none (or on DB error — fail toward the queue-first default). */
export async function oldestPendingHookAgeMs(targetChatId: string, now: Date = new Date()): Promise<number> {
  try {
    const row = await prisma.hookEvent.findFirst({
      where: { status: { in: ['pending', 'delivering'] }, hook: { targetChatId, enabled: true } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
    if (!row?.createdAt) return 0;
    return Math.max(0, now.getTime() - new Date(row.createdAt).getTime());
  } catch {
    return 0;
  }
}

/**
 * Hook-starvation YIELD window (autonomy loop #11, 2026-09-20). The finalize's
 * hooks-first check above only governs ONE of the idle-window entrants. Live
 * 2026-09-20 11:51Z: the crossmodel Supervisor's run ended on a RETIRING
 * colour (its finalize drains are no-ops there), 22 s later a Fleet Supervisor
 * send_chat_message found the chat idle and started a run directly, and the
 * chat's 8 pending run_completed rows (oldest 27 min) waited another 22 min —
 * 50 min end to end, re-parked 7×. Every entrant that can take an idle chat
 * for MACHINE traffic (drainChatQueue — the nudge + orphan sweeper path — and
 * an idle-chat agent send) now asks hookBacklogStarving first and, when it is
 * true, kicks the hook digest instead and lets ITS finalize drain the queue.
 * Bounded above: a backlog older than HOOK_STARVATION_YIELD_MAX_MS is stuck for
 * another reason (cap, depth, disabled target) — yielding to it forever would
 * starve the queue instead, so the queue proceeds. User sends never yield.
 */
export const HOOK_STARVATION_YIELD_MAX_MS = 45 * 60 * 1000;

export type HooksFirstReason = 'no_hooks' | 'young' | 'stuck' | 'undeliverable' | 'user_waiting' | 'queue_older' | 'hooks_first' | 'error';
/** Head of the chat's busy-message queue as seen by the arbitration: age of its oldest row and 'user' when any human row waits. */
export interface QueueHead { ageMs: number; source: string | null }
export interface HooksFirstVerdict { hooksFirst: boolean; reason: HooksFirstReason; hookAgeMs: number; queueHeadAgeMs: number }
const NO_QUEUE_HEAD: QueueHead = { ageMs: 0, source: null };

/**
 * QUEUE FAIRNESS (autonomy loop #15, 2026-09-21). The hooks-first rule above
 * promised alternation ("that wake's own finalize drains the message queue
 * next") but never delivered it under steady lane traffic: a hook wake runs
 * 10–20 min, every RUN_OUTCOME row that lands meanwhile is busy-parked and is
 * already ≥ HOOK_STARVATION_MS old at the wake's finalize, so hooks won AGAIN
 * — forever. Live 00:07–04:07Z: the Fleet Supervisor's queue held 20 rows
 * (17 project-supervisor report-ups + an owner-answer retry + two INFRA-ALERT
 * follow-throughs), the oldest 3.8 h, while 9 wakes ran and 8 more sends were
 * refused as "queue full". The verdict now compares HEADS: hooks go first
 * only when their oldest deliverable row has waited at least as long as the
 * queue's oldest row; a waiting USER row always wins (humans preempt); a
 * young (< 5 min), stuck (> 45 min) or undeliverable backlog never blocks the
 * queue.
 */
export interface HooksFirstOptions {
  /** Upper bound above which a backlog counts as 'stuck' (default HOOK_STARVATION_YIELD_MAX_MS). The run FINALIZE
   *  passes Infinity (loop #17): it AWAITS the wake and falls through to the queue if nothing starts, so an old
   *  deliverable backlog can never starve the queue there — while the idle-window entrants keep the cap. */
  capMs?: number;
}

export async function hooksFirstVerdict(targetChatId: string, queueHead: QueueHead = NO_QUEUE_HEAD, now: Date = new Date(), opts: HooksFirstOptions = {}): Promise<HooksFirstVerdict> {
  const q = Math.max(0, Number(queueHead?.ageMs) || 0);
  const capMs = typeof opts.capMs === 'number' ? opts.capMs : HOOK_STARVATION_YIELD_MAX_MS;
  const v = (hooksFirst: boolean, reason: HooksFirstReason, hookAgeMs: number): HooksFirstVerdict => ({ hooksFirst, reason, hookAgeMs, queueHeadAgeMs: q });
  if (!targetChatId) return v(false, 'no_hooks', 0);
  try {
    // 'delivering' rows count as backlog (loop #17): a sweep claims rows
    // pending→delivering BEFORE it tries to start the wake, so a fairness
    // check that saw only 'pending' rows answered 'no_hooks' exactly while a
    // hook wake was about to take the idle chat — the queue drain won the
    // window and the wake parked. Live 10:48–12:13Z: five alarm-class
    // schedule_disabled rows to the Fleet Supervisor re-parked every 30 s for
    // 85 min behind back-to-back agent report-up turns.
    const scanned = await prisma.hookEvent.findMany({
      where: { status: { in: ['pending', 'delivering'] }, hook: { targetChatId, enabled: true } },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: { createdAt: true, eventType: true, payload: true, retryAt: true, hook: { select: { debounceSec: true, lastFiredAt: true } } },
    });
    // audit 2026-10-06 T3-1: a HELD triage park is never "deliverable now" —
    // it only rides a wake something else starts (a yield to it would kick a
    // drain that delivers nothing). WAKE_TRIAGE_PARK_RIDE_DISABLED=1 counts it.
    // FLEET-PS-FIRST: a held PS escalation is not deliverable now either.
    // LANE-IDLE-WAKE: nor a not-yet-due delayed wake (payload.notBefore).
    const rows = (scanned ?? []).filter((r: any) => !isHeldTriagePark(r, now.getTime()) && !isHeldPsEscalation(r, now.getTime()) && !hookRowNotYetDue(r, now.getTime()));
    if (!rows.length) return v(false, 'no_hooks', 0);
    const age = now.getTime() - new Date(rows[0].createdAt).getTime();
    if (age < HOOK_STARVATION_MS) return v(false, 'young', age);
    if (age > capMs) return v(false, 'stuck', age);
    // DELIVERABLE NOW? (autonomy loop #12, 2026-09-20 — the first live day of
    // the yield): the Fleet Supervisor's wildcard hook carries a 600 s
    // debounce; inside that window deliverHookGroup leaves the rows pending,
    // so a yield held the message queue while NOTHING could take the idle
    // chat — 17 yields in 14 min, the chat idle the whole time (14:20–14:35Z).
    // Yield only when at least one pending row can fire now: alarm-class rows
    // bypass the debounce; a quiet row fires once its hook's window has
    // passed (lastFiredAt null / debounce 0 / lastFiredAt + debounce ≤ now).
    const t = now.getTime();
    const deliverable = rows.some((r: any) => {
      if (isAlarmRow(r)) return true;
      const debounceMs = Math.max(0, Number(r.hook?.debounceSec ?? 0)) * 1000;
      if (!debounceMs || !r.hook?.lastFiredAt) return true;
      return t - new Date(r.hook.lastFiredAt).getTime() >= debounceMs;
    });
    if (!deliverable) return v(false, 'undeliverable', age);
    if (queueHead?.source === 'user') return v(false, 'user_waiting', age);
    if (q > age) return v(false, 'queue_older', age);
    return v(true, 'hooks_first', age);
  } catch {
    return v(false, 'error', 0); // fail toward the pre-yield default (the queue drains)
  }
}

/** Boolean form for the idle-window entrants (drainChatQueue, an idle-chat agent send). `queueHead` (loop #15) lets the caller state how long its own oldest row has waited. */
export async function hookBacklogStarving(targetChatId: string, now: Date = new Date(), queueHead?: QueueHead): Promise<boolean> {
  if (!targetChatId) return false;
  return (await hooksFirstVerdict(targetChatId, queueHead ?? NO_QUEUE_HEAD, now)).hooksFirst;
}

/**
 * Retiring-colour hand-off (autonomy loop #11): a finalize on the retiring
 * colour can start nothing, so it clears the busy-park retryAt on the chat's
 * pending rows — the NEW colour's next 30 s tick then delivers them at once
 * instead of waiting out a park set while the chat was still busy. Returns
 * the rows un-parked; never throws.
 */
export async function unparkHookEventsForTarget(targetChatId: string): Promise<number> {
  if (!targetChatId) return 0;
  try {
    const where = { status: 'pending', retryAt: { not: null }, hook: { targetChatId, enabled: true } };
    // audit 2026-10-06 T3-1: TRIAGE parks are not busy parks — the retiring
    // colour's hand-off releases only the busy-parked rows; a triage park keeps
    // its retryAt (it rides the next wake or is re-triaged at expiry).
    // FLEET-PS-FIRST: a held PS escalation keeps its retryAt too (the project
    // supervisor's window, not a busy park). LANE-IDLE-WAKE: so does a delayed
    // direct wake — its retryAt IS its notBefore (never released early).
    const keepTriage = !wakeTriageParkRideDisabled();
    const keepEscalations = !fleetAlarmPsFirstDisabled();
    {
      const nowMs = Date.now();
      const keep = (p: any): boolean =>
        (keepTriage && isTriageParkedRow(p)) || (keepEscalations && isHeldPsEscalation(p, nowMs)) || hookRowNotYetDue(p, nowMs);
      const parked: any[] = (await prisma.hookEvent.findMany({ where, select: { id: true, payload: true, retryAt: true }, take: 500 })) ?? [];
      if (parked.some(keep)) {
        const ids = parked.filter((p) => !keep(p)).map((p) => p.id);
        if (!ids.length) return 0;
        const r = await prisma.hookEvent.updateMany({ where: { id: { in: ids }, status: 'pending' }, data: { retryAt: null } });
        return Number(r?.count ?? 0);
      }
    }
    const r = await prisma.hookEvent.updateMany({
      where,
      data: { retryAt: null },
    });
    return Number(r?.count ?? 0);
  } catch (err: any) {
    logger.warn(`hook events: un-park for ${targetChatId.slice(0, 8)} failed (the parked retryAt stands): ${err?.message ?? err}`);
    return 0;
  }
}

export function drainHookEventsForTarget(targetChatId: string): void {
  if (!targetChatId) return;
  setImmediate(() => { void sweepHookEvents({ targetChatId, ignoreRetryAt: true }); });
}

/**
 * AWAITED variant for the run finalize's hooks-first branch (autonomy loop
 * #17, 2026-09-21). The fire-and-forget kick above ran on the next tick, so
 * the finalize returned with the chat idle and ANOTHER entrant (the enqueue
 * nudge, the orphan sweeper) took the window with a queue drain; the sweep's
 * own start then found the chat busy and parked the rows — every time the
 * queue had something waiting. The Fleet Supervisor delivered 2 of 8 hook
 * events in 4 h while its queue turned over 5–8 messages an hour. Awaiting the
 * sweep here means the hook wake claims the chat BEFORE the finalize returns.
 * Resolves true when at least one wake was delivered to the target by this
 * sweep (rows flipped to 'delivered' since it began). Never throws.
 */
export async function drainHookEventsForTargetNow(targetChatId: string): Promise<boolean> {
  if (!targetChatId) return false;
  const t0 = new Date();
  await sweepHookEvents({ targetChatId, ignoreRetryAt: true }).catch(() => {});
  const delivered = await prisma.hookEvent.count({
    where: { status: 'delivered', updatedAt: { gte: t0 }, hook: { targetChatId } },
  }).catch(() => 0);
  return delivered > 0;
}

/** emitHookEvent wrapped so even a pathological failure is a log line, never a throw. */
export async function emitHookEventSafe(
  sourceChatId: string,
  eventType: HookEventType,
  summary: string,
  extra?: HookEmitExtra,
): Promise<void> {
  try {
    await emitHookEvent(sourceChatId, eventType, summary, extra);
  } catch (err: any) {
    logger.warn(`hook event emission failed (${eventType}): ${err?.message}`);
  }
}

/* ── Sweep (delivery) ────────────────────────────────────────────────────────
 * ONE SWEEPER PER WEB INSTANCE: the 60s schedule sweeper (fireDue in
 * schedule.service.ts, registered in server.ts) calls this, and prod runs one
 * per web instance (blue + green) — cross-process claim races are REAL (the
 * 2026-08-12 duplicate-wake incident, PR #207). Two locks make delivery safe:
 * the pending→delivering flip is an atomic UPDATE…RETURNING (each sweeper
 * delivers exactly the rows IT claimed), and the debounce window is a Redis
 * SET NX PX gate (at most one wake per hook per window across instances).
 * Do NOT "simplify" either back to a read-then-write — that reintroduces the
 * double-delivery race. The worker process never sweeps; it only EMITS via
 * the DB outbox. */

/** Exported for unit tests (internal shape — not a route surface). */
export function renderPrompt(
  template: string,
  vars: { eventType: string; sourceChatTitle: string; summary: string; sourceChatId?: string },
): string {
  return template
    // Function-form replacements: a string replacement makes replaceAll
    // interpret dollar-patterns in the VALUE (dollar-quote = template tail,
    // dollar-backtick = template head, dollar-ampersand = the placeholder) —
    // an event summary containing one would splice template text into the wake
    // prompt (same footgun as edit_file, feedback b6013de0). Values are
    // agent-influenced payloads, so they must substitute LITERALLY.
    .replaceAll('{{eventType}}', () => vars.eventType)
    .replaceAll('{{sourceChatTitle}}', () => vars.sourceChatTitle)
    // Hardening 2026-09-14: the source chat ID rides the wake (see DEFAULT_PROMPT_TEMPLATE).
    .replaceAll('{{sourceChatId}}', () => vars.sourceChatId ?? '')
    .replaceAll('{{summary}}', () => vars.summary);
}

/** Short UTC stamp for digest lines: "MM-DD HH:MMZ" (a drained digest can span days). */
function shortStamp(d: unknown): string {
  const t = new Date(d as any);
  if (Number.isNaN(t.getTime())) return '??-?? ??:??Z';
  return t.toISOString().slice(5, 16).replace('T', ' ') + 'Z';
}

/** Review 2026-09-13 issue 1: one compact line per QUIET event in a digest — first line of the summary, clipped. */
function compactBullet(row: any): string {
  const p = (row?.payload ?? {}) as Partial<HookEventPayload>;
  const firstLine = String(p.summary ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  const clipped = firstLine.length > DIGEST_LINE_CHARS ? firstLine.slice(0, DIGEST_LINE_CHARS - 1).trimEnd() + '…' : firstLine;
  return `- [${p.eventType}] ${shortStamp(row?.createdAt)} ${clipped}`;
}

/**
 * Coalesce a group's rows into the wake-prompt pieces. Exported for tests
 * (internal shape — not a route surface).
 *
 * Review 2026-09-13 issue 1 — DIGEST MODE: a group with more than
 * DIGEST_COMPACT_THRESHOLD quiet rows (the window-drained supervisor backlog)
 * renders each quiet event as ONE line (compactBullet) under the existing
 * per-source headers, shows at most DIGEST_MAX_LINES quiet lines preferring
 * the NEWEST, and collapses the remainder into one "N more — use list_chats"
 * line. ALARM rows are verbatim and never trimmed away. Smaller groups render
 * exactly as before (byte-identical).
 *
 * Hardening 2026-09-14 — SOURCE CHAT ID: `sourceChatId` is the ONE distinct
 * id when every row shares a source (the common single-lane wake), else the
 * literal 'multiple (see per-source headers)' — never payloads[0]'s id, which
 * would pin the first chat's id onto a digest and misattribute the rest. Every
 * per-source header renders as "### <title> (chat <id>)" (the Map key IS the
 * id; the '(chat …)' suffix is omitted only when the id is empty).
 */
/**
 * E7 (2026-09-25): the source lanes' status + last run outcome for the
 * wake-triage state — the code-computed facts the v1 prose lacked. Bounded
 * (WAKE_TRIAGE_LANE_LOOKUP_MAX lanes, WAKE_TRIAGE_LANE_LOOKUP_MS wall clock)
 * and FAIL-OPEN: any error or timeout yields null and the request carries
 * `source_lanes: null`. Never throws. Exported for tests.
 */
export const WAKE_TRIAGE_LANE_LOOKUP_MS = 1500;
export async function lookupWakeSourceLanes(sourceIds: readonly string[]): Promise<WakeSourceLaneFacts[] | null> {
  const ids = sourceIds.slice(0, WAKE_TRIAGE_LANE_LOOKUP_MAX);
  if (!ids.length) return null;
  const one = async (chatId: string): Promise<WakeSourceLaneFacts> => {
    const [coding, run] = await Promise.all([
      Promise.resolve().then(() => prisma.chatCodingState.findUnique({ where: { id: chatId }, select: { status: true } })).catch(() => null),
      Promise.resolve().then(() => prisma.agentRun.findFirst({ where: { sessionId: chatId }, orderBy: { createdAt: 'desc' }, select: { status: true, finishedAt: true, error: true } })).catch(() => null),
    ]);
    return {
      chat_id: chatId,
      coding_status: coding?.status ?? null,
      last_run: run
        ? {
            status: String(run.status),
            ended_min_ago: run.finishedAt ? Math.max(0, Math.round((Date.now() - new Date(run.finishedAt).getTime()) / 60000)) : null,
            error_head: run.error ? String(run.error).replace(/\s+/g, ' ').slice(0, 160) : null,
          }
        : null,
    };
  };
  try {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), WAKE_TRIAGE_LANE_LOOKUP_MS); });
    const out = await Promise.race([Promise.all(ids.map(one)), timeout]);
    if (timer) clearTimeout(timer);
    return out;
  } catch {
    return null;
  }
}

export function coalesce(rows: any[]): { eventType: string; sourceChatTitle: string; sourceChatId: string; summary: string; depth: number } {
  const payloads = rows.map((r) => (r.payload ?? {}) as Partial<HookEventPayload>);
  const types = [...new Set(payloads.map((p) => String(p.eventType ?? '')))];
  const eventType = types.length === 1 ? types[0] : 'multiple';
  const sourceChatTitle = String(payloads[0]?.sourceChatTitle ?? '');
  const sourceIds = [...new Set(payloads.map((p) => String(p.sourceChatId ?? '').trim()).filter(Boolean))];
  const sourceChatId = sourceIds.length === 1 ? sourceIds[0] : sourceIds.length === 0 ? 'unknown' : 'multiple (see per-source headers)';
  let summary: string;
  if (rows.length === 1) {
    summary = String(payloads[0]?.summary ?? '');
  } else {
    // Phase 5 (2026-08-22): a multi-event wake groups its bullets under
    // per-source headers instead of one flat list — a wildcard supervisor wake
    // fans in from many chats, and the source of each event must be obvious at
    // a glance. First-seen source order; creation order within a group (rows
    // arrive createdAt-asc). Keyed by sourceChatId (two chats CAN share a
    // title); the header is the title, 'unknown chat' when empty.
    const quiet = rows.filter((r) => !isAlarmRow(r));
    const compact = quiet.length > DIGEST_COMPACT_THRESHOLD;
    let shown = rows;
    let omitted: any[] = [];
    if (compact && quiet.length > DIGEST_MAX_LINES) {
      // Newest-preferred trim (issue 1 option C(b)): the freshest completions
      // carry the current state; the older tail collapses to a count.
      const newestFirst = [...quiet].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
      const keep = new Set(newestFirst.slice(0, DIGEST_MAX_LINES).map((r) => r.id));
      omitted = newestFirst.slice(DIGEST_MAX_LINES);
      shown = rows.filter((r) => isAlarmRow(r) || keep.has(r.id));
    }
    const groups = new Map<string, { title: string; bullets: string[] }>();
    for (const r of shown) {
      const p = (r.payload ?? {}) as Partial<HookEventPayload>;
      const key = String(p.sourceChatId ?? '');
      const bullet = compact && !isAlarmRow(r) ? compactBullet(r) : `- [${p.eventType}] ${String(p.summary ?? '')}`;
      const bucket = groups.get(key);
      if (bucket) {
        bucket.bullets.push(bullet);
      } else {
        groups.set(key, { title: String(p.sourceChatTitle ?? '').trim() || 'unknown chat', bullets: [bullet] });
      }
    }
    // Hardening 2026-09-14: the header carries the chat ID (the Map key) so a
    // digest's reader can address each source by id, never by a colliding title.
    summary = [...groups.entries()]
      .map(([key, g]) => `### ${g.title}${key ? ` (chat ${key})` : ''}\n${g.bullets.join('\n')}`)
      .join('\n');
    if (compact) {
      const stamps = rows.map((r) => +new Date(r.createdAt)).filter(Number.isFinite);
      const span = stamps.length ? ` emitted ${shortStamp(Math.min(...stamps))} → ${shortStamp(Math.max(...stamps))}` : '';
      summary =
        `Coalesced digest — ${rows.length} event(s) (${quiet.length} quiet, ${rows.length - quiet.length} alarm)${span}. ` +
        'Quiet events are one line each (read the source chat for detail); alarm events are verbatim.\n' + summary;
    }
    if (omitted.length) {
      const oldest = Math.min(...omitted.map((r) => +new Date(r.createdAt)).filter(Number.isFinite));
      summary +=
        `\n(+${omitted.length} more older quiet event(s) not listed — oldest ${Number.isFinite(oldest) ? new Date(oldest).toISOString() : 'unknown'}; ` +
        'all are marked delivered. Use list_chats / get_chat_status for the full picture.)';
    }
  }
  const depth = Math.max(0, ...payloads.map((p) => Number(p.depth ?? 0) || 0));
  return { eventType, sourceChatTitle, sourceChatId, summary, depth };
}

/**
 * Review 2026-09-13 issue 1 — WINDOW DRAIN (see WINDOW_DRAIN_CAP). Called by
 * deliverHookGroup AFTER the debounce gate is decided and BEFORE the atomic
 * claim: every other deliverable pending row of THIS hook joins the group so
 * the atomic UPDATE…RETURNING claims (and one wake delivers) the whole
 * backlog. NEWEST rows are fetched first so a capped drain keeps the freshest
 * state; `leftBehind` reports how many older rows stayed pending (they ride
 * the next window) so the wake can say it is partially blind. Never throws —
 * any failure delivers the fair-batch group exactly as before.
 *
 * Hardening 2026-09-14 — BUSY-PARKED ROWS RIDE THE WAKE: the drain pulls
 * EVERY pending row of the hook, retryAt included. A wake to this target is
 * being delivered NOW; the TTL-park existed only to stop 60 s re-attempts
 * against a busy chat, not to hold a quiet completion out of a wake that is
 * already going to the same target. Excluding them made a parked
 * run_completed miss the next wake, and once that wake wrote lastFiredAt (and
 * the alarm path SET the Redis gate PX debounceSec) the due rows waited out
 * the whole 600 s project window — 11-14 min late for a "react within
 * minutes" lane, each miss its own machine run. Parked rows still never
 * START a wake (the sweep scan at sweepHookEvents keeps its retryAt filter);
 * they only RIDE one already owned. If the target turns out busy, the merged
 * group re-parks via the existing busy path (retryAt refreshed +BUSY_PARK_MS,
 * attempts frozen) — acceptable: it coalesces them with the newer rows.
 */
async function drainWindowBacklog(
  hookId: string,
  rows: any[],
): Promise<{ rows: any[]; drained: number; leftBehind: { n: number; before: Date } | null }> {
  try {
    const have = new Set(rows.map((r) => r.id));
    const where = { hookId, status: 'pending' };
    const found: any[] = (await prisma.hookEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: WINDOW_DRAIN_CAP })) ?? [];
    // Defensive re-filter (a concurrent sweeper or a stale read can hand back
    // rows that are no longer this hook's / pending, or already in the group).
    // FLEET-PS-FIRST: a held PS escalation never rides early — the Fleet must
    // not see it before the project supervisor has had its window.
    // LANE-IDLE-WAKE: a not-yet-due delayed wake never rides a window drain.
    const nowMs = Date.now();
    const extra = found.filter((r) =>
      r && r.hookId === hookId && !have.has(r.id) && r.status === 'pending' && !isHeldPsEscalation(r, nowMs) && !hookRowNotYetDue(r, nowMs));
    let leftBehind: { n: number; before: Date } | null = null;
    if (found.length >= WINDOW_DRAIN_CAP) {
      const floor = new Date(found[found.length - 1].createdAt);
      try {
        const n = await prisma.hookEvent.count({ where: { ...where, createdAt: { lt: floor } } });
        if (n > 0) leftBehind = { n, before: floor };
      } catch (err: any) {
        logger.warn(`hook ${hookId.slice(0, 8)}: window-drain remainder count failed (non-fatal): ${err?.message}`);
      }
    }
    if (!extra.length && !leftBehind) return { rows, drained: 0, leftBehind: null };
    const merged = [...rows, ...extra].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    logger.info(
      `hook ${hookId.slice(0, 8)}: window drain — ${extra.length} more pending row(s) join this wake (group ${rows.length}→${merged.length})` +
      (leftBehind ? `; ${leftBehind.n} older row(s) before ${leftBehind.before.toISOString()} stay pending (drain cap ${WINDOW_DRAIN_CAP})` : ''),
    );
    return { rows: merged, drained: extra.length, leftBehind };
  } catch (err: any) {
    logger.warn(`hook ${hookId.slice(0, 8)}: window drain failed (non-fatal — delivering the fair-batch group): ${err?.message}`);
    return { rows, drained: 0, leftBehind: null };
  }
}

/** Pending rows of the OTHER enabled hooks on the same target + owner (see SIBLING_DRAIN_CAP). */
async function drainSiblingBacklog(
  hook: { id: string; userId: string; targetChatId: string; sourceChatId: string | null; promptTemplate: string },
  rows: any[],
): Promise<{ rows: any[]; drained: number; siblingHookIds: string[] }> {
  const none = { rows, drained: 0, siblingHookIds: [] as string[] };
  if (hook.sourceChatId) return none; // wildcard feed only
  try {
    const have = new Set(rows.map((r) => r.id));
    const found: any[] = (await prisma.hookEvent.findMany({
      where: { status: 'pending', hook: { targetChatId: hook.targetChatId, userId: hook.userId, enabled: true, id: { not: hook.id } } },
      include: { hook: { select: { id: true, promptTemplate: true } } },
      orderBy: { createdAt: 'asc' },
      take: SIBLING_DRAIN_CAP,
    })) ?? [];
    const firingIsChildResult = isChildResultTemplate(hook.promptTemplate);
    const extra = found.filter((r) => {
      if (!r || have.has(r.id) || r.status !== 'pending' || r.hookId === hook.id) return false;
      if (!String((r.payload as any)?.sourceChatId ?? '')) return false;
      if (isHeldPsEscalation(r)) return false; // FLEET-PS-FIRST: held for the project supervisor's window
      if (hookRowNotYetDue(r)) return false; // LANE-IDLE-WAKE: a delayed direct wake never rides early
      const tmpl = String(r.hook?.promptTemplate ?? '');
      if (isChildResultTemplate(tmpl) && !firingIsChildResult) return false;
      return true;
    });
    if (!extra.length) return none;
    const siblingHookIds = [...new Set(extra.map((r) => String(r.hookId)))];
    const merged = [...rows, ...extra].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
    logger.info(`hook ${hook.id.slice(0, 8)}: sibling drain — ${extra.length} pending row(s) from ${siblingHookIds.length} other hook(s) on the same target join this wake (group ${rows.length}→${merged.length})`);
    return { rows: merged, drained: extra.length, siblingHookIds };
  } catch (err: any) {
    logger.warn(`hook ${hook.id.slice(0, 8)}: sibling drain failed (non-fatal — delivering this hook's group): ${err?.message}`);
    return none;
  }
}

/** Flip a claimed group back to pending (attempts+1), failing rows that exhausted attempts. */
async function retryOrFail(rows: any[], reason: string): Promise<void> {
  const retrying = rows.filter((r) => (r.attempts ?? 0) + 1 < MAX_DELIVERY_ATTEMPTS).map((r) => r.id);
  const failing = rows.filter((r) => (r.attempts ?? 0) + 1 >= MAX_DELIVERY_ATTEMPTS).map((r) => r.id);
  if (retrying.length) {
    await prisma.hookEvent.updateMany({
      where: { id: { in: retrying } },
      data: { status: 'pending', attempts: { increment: 1 } },
    }).catch(() => {});
  }
  if (failing.length) {
    await prisma.hookEvent.updateMany({
      where: { id: { in: failing } },
      data: { status: 'failed', attempts: { increment: 1 } },
    }).catch(() => {});
    logger.warn(`hook events: ${failing.length} event(s) failed after ${MAX_DELIVERY_ATTEMPTS} delivery attempts (${reason})`);
    await notifyHookDeaths(rows.filter((r) => failing.includes(r.id)), reason);
  }
}

/**
 * Owner-visible hook death notice (2026-08-30 fleet audit): events that exhaust
 * MAX_DELIVERY_ATTEMPTS used to flip to 'failed' with ONLY a warn log — a busy
 * supervisor ate its own wake backlog and the fleet went silently deaf (30
 * dead events found in prod, invisible to everyone). Post ONE assistant
 * message per HOOK per 24h (Redis NX — mirrors notifyScheduleTerminalOnce) to
 * the hook's TARGET chat saying what was lost and from where. Best-effort,
 * never throws: a notice failure must not break the sweep.
 */
async function notifyHookDeaths(deadRows: any[], reason: string, cause: 'attempts' | 'horizon' = 'attempts'): Promise<void> {
  try {
    const byHook = new Map<string, any[]>();
    for (const r of deadRows) {
      const k = String(r.hookId ?? '');
      if (!k) continue;
      const bucket = byHook.get(k);
      if (bucket) bucket.push(r); else byHook.set(k, [r]);
    }
    for (const [hookId, hookRows] of byHook) {
      const key = `fleet:hookdeath:${hookId}`;
      const claimed = await redisClient.set(key, '1', { NX: true, EX: 24 * 60 * 60 }).catch(() => null);
      if (claimed !== 'OK') continue; // already told this window (or Redis hiccup — stay quiet)
      const hook = await prisma.eventHook.findUnique({ where: { id: hookId } }).catch(() => null);
      if (!hook) continue;
      const sources = [...new Set(hookRows.map((r) => String((r.payload as any)?.sourceChatTitle ?? '').trim()).filter(Boolean))];
      const types = [...new Set(hookRows.map((r) => String(r.eventType ?? '')).filter(Boolean))];
      await prisma.crossModelMessage.create({
        data: {
          chatId: hook.targetChatId,
          role: 'assistant',
          content:
            `⚠️ **Fleet hook delivery failed permanently** — ${hookRows.length} event(s) (${types.join(', ') || 'unknown type'})` +
            `${sources.length ? ` from ${sources.map((s) => `"${s}"`).join(', ')}` : ''} ` +
            (cause === 'horizon'
              ? `stayed undeliverable for ${Math.round(RETRY_HORIZON_MS / 3600000)}h and were dead-lettered ('failed:horizon'). `
              : `died after ${MAX_DELIVERY_ATTEMPTS} delivery attempts (last reason: ${reason}). `) +
            `Those events are LOST — this chat was likely busy or capped each time the sweeper tried. ` +
            `Check the source chat(s) manually for what completed, and consider raising this chat's daily cap with set_chat_autonomy if it keeps happening.`,
        },
      }).catch(async (err: any) => {
        await redisClient.del(key).catch(() => {}); // claim-then-fail must not lose the notice forever
        logger.warn(`hook death notice persist failed (${hookId.slice(0, 8)}): ${err?.message}`);
      });
      // Bump the chat so the notice surfaces in the updatedAt-sorted sidebar.
      await prisma.crossModelChat.update({ where: { id: hook.targetChatId }, data: { updatedAt: new Date() } }).catch(() => {});
      await audit(hook.userId, 'hook.events_died', {
        hookId, count: hookRows.length, reason, eventTypes: types,
      });
    }
  } catch (err: any) {
    logger.warn(`hook death notices failed: ${err?.message}`);
  }
}

/**
 * PARK alarm rows whose target is busy (audit #3): flip them back to 'pending'
 * WITHOUT the attempts increment retryOrFail applies — an alarm must never
 * exhaust MAX_DELIVERY_ATTEMPTS just because its target chat ran something for
 * an hour (the 2026-08-30 deaf-fleet failure mode: a busy supervisor ate its
 * own wake backlog). The park is durable (the outbox row itself) and drains on
 * the next sweep tick after the target's run finalizes and frees the session.
 * Alarm-storm guard: at most PARKED_ALARM_CAP pending alarm rows per TARGET
 * chat — the oldest beyond the cap are failed with a warn (newest survive:
 * the freshest alarms carry the current state). Never throws.
 */
/**
 * Telemetry dedupe for wake_parked (rollout watch 2026-09-14: the 30 s sweeper
 * re-claims and re-parks the SAME pending rows while a target is busy, so the
 * metric counted ~2 rows/min per stuck event — 351 rows in 3 h for the fleet
 * for a handful of real parks). One wake_parked per event per process
 * lifetime; a re-park is folded into `meta.reparked`. Process-local on
 * purpose: the sweeper is single-instance and a restart costs one extra count.
 */
const PARK_SEEN = new Map<string, number>();
const PARK_SEEN_MAX = 20_000;
const PARK_SEEN_TTL_MS = 24 * 60 * 60 * 1000;
export function splitFreshParks(rows: any[]): { fresh: any[]; reparked: number } {
  const now = Date.now();
  if (PARK_SEEN.size > PARK_SEEN_MAX) {
    for (const [id, at] of PARK_SEEN) if (now - at > PARK_SEEN_TTL_MS) PARK_SEEN.delete(id);
    if (PARK_SEEN.size > PARK_SEEN_MAX) PARK_SEEN.clear();
  }
  const fresh: any[] = [];
  let reparked = 0;
  for (const r of rows) {
    if (PARK_SEEN.has(r.id)) reparked++;
    else { fresh.push(r); PARK_SEEN.set(r.id, now); }
  }
  return { fresh, reparked };
}
/** Test seam. */
export function resetParkSeenForTests(): void { PARK_SEEN.clear(); }

function recordParkMetric(targetChatId: string, rows: any[], meta: Record<string, unknown>): void {
  const { fresh, reparked } = splitFreshParks(rows);
  if (!fresh.length) return; // every row already counted on its first park
  recordLoopMetric({ kind: LOOP_METRIC_KINDS.WAKE_PARKED, sessionId: targetChatId, value: fresh.length, meta: reparked ? { ...meta, reparked } : meta });
}

async function parkAlarmRows(targetChatId: string, rows: any[], reason: string): Promise<void> {
  if (!rows.length) return;
  // LANE-IDLE-WAKE review fix (2026-10-20): a lane_idle row re-runs its lane
  // revalidation (~10 reads) on every claim, so it TTL-parks (retryAt
  // +BUSY_PARK_MS) instead of being re-claimed on every 30 s tick; the
  // run-finalize drain (ignoreRetryAt) still delivers it the moment the
  // supervisor goes idle. Every other alarm row parks exactly as before.
  const laneIdle = rows.filter((r) => (r?.payload as any)?.wakeKind === 'lane_idle');
  const plain = rows.filter((r) => !laneIdle.includes(r));
  if (plain.length) {
    await prisma.hookEvent.updateMany({
      where: { id: { in: plain.map((r) => r.id) } },
      data: { status: 'pending' }, // attempts deliberately NOT incremented — parked, not retried-toward-death
    }).catch(() => {});
  }
  if (laneIdle.length) {
    await prisma.hookEvent.updateMany({
      where: { id: { in: laneIdle.map((r) => r.id) } },
      data: { status: 'pending', retryAt: new Date(Date.now() + BUSY_PARK_MS) }, // attempts frozen too
    }).catch(() => {});
  }
  logger.info(`hook events: parked ${rows.length} alarm event(s) for busy chat ${targetChatId.slice(0, 8)} (${reason}) — attempts frozen, drains on a post-finalize sweep`);
  recordParkMetric(targetChatId, rows, { reason });
  try {
    const scanned = await prisma.hookEvent.findMany({
      where: { status: 'pending', eventType: { in: [...ALARM_EVENT_TYPES] }, hook: { targetChatId } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, payload: true, retryAt: true },
    });
    // FLEET-PS-FIRST: a held PS escalation is not a parked alarm (one per Fleet
    // chat × project, bounded by construction) — never counted, never evicted.
    // LANE-IDLE-WAKE review fix (2026-10-20): nor is a DELAYED direct wake not
    // yet due (payload.notBefore in the future — a lane_idle row), so neither
    // can push a genuine run_failed / attention_needed alarm out of the backlog.
    // A ci-watch escalation (alarm-class ci_failed) is not in this census at all.
    const nowMs = Date.now();
    const parked = (scanned ?? []).filter((p: any) => !isHeldPsEscalation(p, nowMs) && !hookRowNotYetDue(p, nowMs));
    if (parked.length > PARKED_ALARM_CAP) {
      const evict = parked.slice(0, parked.length - PARKED_ALARM_CAP).map((p) => p.id);
      await prisma.hookEvent.updateMany({ where: { id: { in: evict } }, data: { status: 'failed' } }).catch(() => {});
      logger.warn(`hook events: parked-alarm cap (${PARKED_ALARM_CAP}) exceeded for chat ${targetChatId.slice(0, 8)} — evicted the ${evict.length} oldest parked alarm(s)`);
    }
  } catch (err: any) {
    logger.warn(`hook events: parked-alarm cap check failed (non-fatal): ${err?.message}`);
  }
}

/**
 * LANE-IDLE-WAKE review fix (2026-10-20): a lane_idle row a supervisor-OFF
 * skip consumed releases the lane's 6 h dedupe slot (coding/lane-idle) — the
 * wake reached nobody, so the lane's next idle episode must be able to wake
 * (the Fleet, while project supervisors stay off). Never throws.
 */
async function releaseLaneIdleSlotsOf(rows: any[]): Promise<void> {
  const lanes = [...new Set(rows
    .filter((r) => (r?.payload as any)?.wakeKind === 'lane_idle')
    .map((r) => String((r.payload as any)?.laneChatId ?? ''))
    .filter(Boolean))];
  if (!lanes.length) return;
  try {
    const m = await import('../coding/lane-idle');
    for (const lane of lanes) await m.releaseLaneIdleSlot(lane);
  } catch { /* best-effort — the slot expires on its own */ }
}

/**
 * TTL-park NON-ALARM rows whose target is busy (v1#1): pending with a
 * retryAt backoff instead of the attempts+1 burn — a chat that legitimately
 * runs for an hour must not age its quiet backlog toward the 60-attempt
 * death (spark B17/B18: child→parent run_completed rows died exactly there).
 * The sweep skips rows whose retryAt is in the future; the 24h horizon
 * dead-letters what never delivers. Never throws.
 */
async function parkBusyRows(targetChatId: string, rows: any[]): Promise<void> {
  if (!rows.length) return;
  await prisma.hookEvent.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: 'pending', retryAt: new Date(Date.now() + BUSY_PARK_MS) }, // attempts deliberately NOT incremented
  }).catch(() => {});
  logger.info(`hook events: TTL-parked ${rows.length} event(s) for busy chat ${targetChatId.slice(0, 8)} — retry in ~${Math.round(BUSY_PARK_MS / 60000)} min, attempts frozen`);
  recordParkMetric(targetChatId, rows, { reason: 'busy', ttlPark: true });
}

/**
 * RETIRED-TARGET HYGIENE (ticket 57154856, 2026-09-20): should a delivery to
 * this hook's TARGET chat be skipped as a wake to a lane that owns no live
 * work? A stood-down lane (observed: "Kernel Optimization for GLM-5.3 W4A16",
 * retired under the owner's stop directive) kept getting woken by a leftover
 * peer hook on EVERY todo_done from the still-active lane — each wake burned
 * a full machine run on a chat with nothing to do (one derail-killed run)
 * until the Fleet Supervisor paused the hook by hand. Schedules have
 * ownership re-checks + recentlyDisabled bookkeeping; hooks had nothing.
 *
 * Retired means ANY of:
 *   - the chat is ARCHIVED (archivedAt set — explicit retirement; the
 *     2026-09-20 lane-scoped ending now archives finished sub-sessions, so
 *     stale peer hooks would otherwise fire into shelved chats forever);
 *   - a CODING lane (codingState present) with NO enabled CodingSchedule AND
 *     NO open ProjectTodo (LIVE_TODO_STATUSES) assigned to it.
 *
 * Deliberate exemptions (false-positive guards — pausing these would break
 * framework machinery or interactive use):
 *   - SYSTEM hooks (createdVia 'system:*' — child-result wakes, the todo_wake
 *     direct-wake self-hook, fleet-supervisor wiring): bounded by construction
 *     and the REACTIVATION path a stood-down lane is woken back through (a new
 *     todo assignment rides enqueueDirectWake, which re-enables its own hook);
 *   - supervisor chats (isSupervisor / isProjectSupervisor): standing lanes;
 *   - PLAIN chats (no codingState): an interactive chat with no board work is
 *     a normal user surface, not a retired lane — user-wired notifications to
 *     it must keep firing (they burn cheap chat-agent turns, by request).
 *
 * A prisma hiccup on the counts fails OPEN (deliver) — same doctrine as the
 * todo_wake revalidation below: the outbox must not wedge on a transient.
 */
/**
 * CHILD-RESULT SIGNATURE match (ticket 9df506cc F1, 2026-09-20): the
 * createdVia 'system:*' exemption above misses LEGACY child-result hooks —
 * rows wired by ensureChildResultHook BEFORE the createdVia provenance column
 * existed (pre-dd3a19fa) carry createdVia NULL, so a dormant parent's
 * result hook — exactly the wake path a verdict-waiting lane depends on —
 * could be auto-paused by the sweep. Identify the ensureChildResultHook
 * wiring by its invariants instead: the canonical prompt template AND the
 * exact terminal/attention event set (a user-NARROWED variant keeps the
 * template but not the set — it is covered by the ensureChildResultHook
 * self-heal re-enable at the next spawn, not by this exemption).
 */
function isChildResultHookSignature(hook: any): boolean {
  if (!isChildResultTemplate(hook?.promptTemplate)) return false;
  const types = (Array.isArray(hook?.eventTypes) ? hook.eventTypes : []).map((e: any) => String(e)).sort();
  const want = [...CHILD_RESULT_EVENT_TYPES].slice().sort();
  return types.length === want.length && types.every((t: string, i: number) => t === want[i]);
}
// Exported for the jest pins (legacy-template coverage, 2026-09-24): the F1
// exemption originally shipped without a test, and the exact-match hole lived
// in prod for 4 days before the sibling-drain steer re-exposed the seam.
export { isChildResultHookSignature };

async function hookTargetRetired(hook: any, tgt: any): Promise<boolean> {
  if (String(hook.createdVia ?? '').startsWith('system:')) return false;
  // Legacy child-result hooks (createdVia NULL, pre-provenance) — exempt by
  // SIGNATURE regardless of provenance (ticket 9df506cc F1).
  if (isChildResultHookSignature(hook)) return false;
  if (tgt.archivedAt) return true;
  // ARCHIVED-TARGET-RETIRE (d, 2026-10-20): a coding session archived through
  // the session API parks only its satellite ('archived') — the dispatch heal
  // refuses every machine wake into it exactly like an archivedAt stamp, so it
  // is retired here too (before the live-work count, which an archived lane's
  // leftover rows would otherwise satisfy). Kill switch
  // ARCHIVED_TARGET_RETIRE_DISABLED=1.
  if (tgt.codingState?.status === 'archived' && !archivedTargetRetireDisabled()) return true;
  if (tgt.isSupervisor || tgt.isProjectSupervisor) return false;
  if (!tgt.codingState) return false;
  try {
    const [enabledSchedules, liveTodos] = await Promise.all([
      prisma.codingSchedule.count({ where: { sessionId: hook.targetChatId, enabled: true } }),
      prisma.projectTodo.count({ where: { assigneeChatId: hook.targetChatId, status: { in: [...LIVE_TODO_STATUSES] } } }),
    ]);
    return enabledSchedules === 0 && liveTodos === 0;
  } catch (err: any) {
    logger.warn(`hook ${String(hook.id ?? '').slice(0, 8)}: retired-target check failed (${err?.message}) — delivering as-is`);
    return false;
  }
}

/**
 * The hand-off × child-result wake decision for ONE delivery group (platform/
 * handoff-parent-wake.ts): the leaf decides; this wrapper supplies the two
 * side-effecting probes — the hand-off's store record for a run, and the
 * parent's task-card flip to FAILED for a run_failed row (the card on the
 * answer row that spawned the child; a chat with no such card keeps its
 * wake). Every probe fails OPEN (deliver).
 */
async function handoffParentWakeSkip(hook: any, tgt: any, rows: any[]): Promise<{ skip: boolean; reason: string; failedRows: HandoffWakeRow[] }> {
  try {
    const handoff = await import('../coding/deliverable-handoff');
    return await decideHandoffParentWake({
      hook: { id: hook.id, sourceChatId: hook.sourceChatId ?? null, targetChatId: hook.targetChatId },
      target: tgt,
      rows,
      hasRecord: async (childChatId, runId) => {
        const store = await import('../memory/context-store');
        const rec = await store.storeGet<Record<string, unknown>>([handoff.HANDOFF_STORE_NS, childChatId], runId);
        return !!rec && typeof rec === 'object' && typeof (rec as any).postedAt === 'string';
      },
      // audit 2026-10-06 T3-4: the child's project has an ENABLED project
      // supervisor whose project-scope hook receives run_completed (and is not
      // this parent) — it owns the lane, so an un-posted completion does not
      // also machine-wake the human parent. Any read error ⇒ false (deliver).
      psCoversChild: async (childChatId) => {
        const child = await prisma.crossModelChat.findUnique({
          where: { id: childChatId },
          select: { projectId: true, userId: true, project: { select: { projectSupervisorEnabled: true } } },
        });
        if (!child?.projectId || child.userId !== hook.userId || child.project?.projectSupervisorEnabled !== true) return false;
        const covering = await prisma.eventHook.findFirst({
          where: {
            userId: hook.userId, sourceChatId: null, projectId: child.projectId, enabled: true,
            eventTypes: { has: 'run_completed' }, NOT: [{ targetChatId: childChatId }, { targetChatId: hook.targetChatId }],
          },
          select: { id: true },
        });
        return !!covering;
      },
      flipFailedCard: async (row) => {
        const te = await import('../chat-agent/task-events');
        if (te.taskCardDisabled()) return false;
        const childChatId = String(hook.sourceChatId);
        const title = String((row?.payload as any)?.sourceChatTitle ?? '').trim();
        const cause = rowSummary(row).replace(/\s+/g, ' ').trim().slice(0, 300);
        const payload = te.buildTaskEvent({
          taskId: handoff.taskIdForSession(childChatId),
          chatId: hook.targetChatId,
          childChatId,
          kind: 'session',
          status: 'failed',
          title: title || 'Task',
          note: cause ? `The sub-session's run failed: ${cause}` : 'The sub-session\'s run failed before it delivered anything.',
        });
        const rowId = await te.persistTaskCard(hook.targetChatId, payload, { preferCarrier: true });
        if (!rowId) return false;
        te.emitTaskEvent(hook.targetChatId, payload);
        return true;
      },
    });
  } catch (err: any) {
    logger.warn(`hook ${String(hook?.id ?? '').slice(0, 8)}: hand-off wake check failed (${err?.message ?? err}) — delivering as before`);
    return { skip: false, reason: 'error', failedRows: [] };
  }
}

/**
 * Ticket f8c62820 — the ownership-moved gate for ONE auto-wired child→parent
 * result hook (platform/child-ownership-wake.ts): the pure leaf decides from
 * agent-sent steers; this wrapper supplies the single DB probe — the newest
 * agent-sent messages into the CHILD chat (crossModelMessage rows, role
 * 'user', metadata.origin 'agent', the SENDING lane in
 * metadata.originSourceChatId — there is no dedicated sender column). Only
 * the auto-wired kind (createdVia 'system:child-result-hook') is gated; user
 * hooks and other system kinds deliver untouched. Returns the leaf's skip
 * decision, or null = deliver (not the kind, kill switch, probe error, or
 * the leaf said wake). Every failure path is fail-open.
 */
async function childOwnershipWakeSkip(
  hook: any,
  rows: any[],
): Promise<Extract<ChildOwnershipWakeDecision, { action: 'skip' }> | null> {
  try {
    if (!rows.length) return null;
    if (String(hook?.createdVia ?? '') !== 'system:child-result-hook') return null;
    const childChatId = String(hook.sourceChatId ?? '');
    if (!childChatId) return null;
    // Bounded newest-first probe: the newest agent-sent rows into the child
    // (take: 10 — a parent engagement pushed out of the window by ≥10 newer
    // external steers is overwhelming ownership-move evidence anyway).
    // Unattributable rows (no originSourceChatId) are dropped, never counted
    // as a takeover signal.
    const sent = await prisma.crossModelMessage.findMany({
      where: { chatId: childChatId, role: 'user', metadata: { path: ['origin'], equals: 'agent' } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { createdAt: true, metadata: true },
    });
    const steers = sent
      .filter((m: any) => typeof m?.metadata?.originSourceChatId === 'string' && m.metadata.originSourceChatId)
      .map((m: any) => ({ sourceChatId: String(m.metadata.originSourceChatId), createdAt: new Date(m.createdAt) }));
    // Newest-first: the FIRST parent row is the parent's newest engagement.
    const parentLastAt = steers.find((s) => s.sourceChatId === hook.targetChatId)?.createdAt ?? null;
    const decision = decideChildResultOwnershipWake({
      hook: { id: String(hook.id ?? ''), sourceChatId: childChatId, targetChatId: String(hook.targetChatId), createdVia: hook.createdVia ?? null },
      rows: rows.map((r) => ({ id: String(r?.id ?? '') })),
      steers,
      parentLastAt,
    });
    return decision.action === 'skip' ? decision : null;
  } catch (err: any) {
    logger.warn(`hook ${String(hook?.id ?? '').slice(0, 8)}: child-ownership wake check failed (${err?.message ?? err}) — delivering as before`);
    return null;
  }
}

/** True when a send receipt's target id names `targetChatId` (full id, or a ≥8-char prefix either way). */
function sendTargetsChat(ids: unknown, targetChatId: string): boolean {
  const t = ids && typeof ids === 'object' ? String((ids as any).chatId ?? '').trim().toLowerCase() : '';
  const want = String(targetChatId ?? '').toLowerCase();
  if (!t || !want) return false;
  if (t === want) return true;
  return t.length >= 8 && (want.startsWith(t) || t.startsWith(want));
}

/**
 * audit 2026-10-06 T3-11: the group's run_completed rows whose run already sent
 * its report to the hook TARGET (ok send_chat_message receipt, same runId,
 * within REPORTED_IN_RUN_WINDOW_MS of the row). Alarm rows never qualify (only
 * run_completed is checked). Fail-open: any error ⇒ []. Exported for tests.
 */
export async function reportedInRunRows(hook: { targetChatId: string }, rows: any[]): Promise<any[]> {
  if (process.env.HOOK_REPORTED_IN_RUN_SKIP_DISABLED === '1') return [];
  const candidates = rows.filter((r) => String(r?.eventType ?? '') === 'run_completed' && rowRunId(r as HandoffWakeRow)
    && String((r?.payload as any)?.sourceChatId ?? '') !== hook.targetChatId);
  if (!candidates.length) return [];
  try {
    const runIds = [...new Set(candidates.map((r) => rowRunId(r as HandoffWakeRow) as string))];
    const receipts: any[] = (await prisma.runToolReceipt.findMany({
      where: { runId: { in: runIds }, tool: 'send_chat_message', ok: true },
      select: { runId: true, ids: true, createdAt: true },
      take: 200,
    })) ?? [];
    if (!receipts.length) return [];
    return candidates.filter((r) => {
      const runId = rowRunId(r as HandoffWakeRow);
      const at = new Date(r?.createdAt).getTime();
      return receipts.some((rc) => rc?.runId === runId && sendTargetsChat(rc.ids, hook.targetChatId)
        && (!Number.isFinite(at) || Math.abs(at - new Date(rc.createdAt).getTime()) <= REPORTED_IN_RUN_WINDOW_MS));
    });
  } catch (err: any) {
    logger.warn(`hooks: reported-in-run check failed (${err?.message ?? err}) — delivering as before`);
    return [];
  }
}

/**
 * SHARED-PROJECT-DISPATCH review fix (2026-10-20): does a SPECIFIC hook whose
 * source chat is owned by ANOTHER account still hold at delivery? Only the
 * auto-wired child-result hook of a MEMBER-caused spawn does: an editor /
 * admin member's supervisor starts a lane in a shared project, the lane runs
 * as the PROJECT OWNER (platform.service startCodingSession), and
 * ensureChildResultHook wired child → member's chat under the member's
 * account (subscribeHook admits write access to the source). All of:
 *  - member spawns on (SPAWN_MEMBER_ACCESS_DISABLED unset);
 *  - createdVia 'system:child-result-hook' (only ensureChildResultHook stamps it);
 *  - the source's lineage parent (crossmodel_chats.parentChatId) IS the hook
 *    target — the child was spawned by, and still belongs to, that chat;
 *  - the hook user still has WRITE access to the source (getChatAccess —
 *    owner / editor / admin membership; a demotion to viewer or a removal
 *    retires the hook like any ownership drift).
 * The target is re-checked as the hook user's own chat before this runs.
 * 'unknown' = the access lookup failed (the caller requeues the rows — never a
 * silent delete on a transient error). Exported for tests.
 */
export async function memberChildResultSourceVerdict(
  hook: { userId: string; sourceChatId?: string | null; targetChatId: string; createdVia?: string | null },
  src: { userId?: string | null; parentChatId?: string | null } | null | undefined,
): Promise<'holds' | 'lapsed' | 'unknown'> {
  if (!src || !hook.sourceChatId) return 'lapsed';
  if (src.userId && src.userId === hook.userId) return 'holds';
  if (spawnMemberAccessDisabled()) return 'lapsed';
  if (String(hook.createdVia ?? '') !== 'system:child-result-hook') return 'lapsed';
  if (hook.sourceChatId === hook.targetChatId) return 'lapsed';
  if (!src.parentChatId || src.parentChatId !== hook.targetChatId) return 'lapsed';
  try {
    const { access } = await crossModelService.getChatAccess(hook.sourceChatId, hook.userId);
    return access === 'owner' || access === 'write' ? 'holds' : 'lapsed';
  } catch (err: any) {
    logger.warn(`hook: member child-result source check failed for ${String(hook.sourceChatId).slice(0, 8)} (${err?.message ?? err}) — rows requeued`);
    return 'unknown';
  }
}

/** Deliver ONE hook's coalesced event group to its target chat. Never throws. */
async function deliverHookGroup(hookId: string, rows: any[]): Promise<void> {
  const hook = await prisma.eventHook.findUnique({ where: { id: hookId } });
  if (!hook || !hook.enabled) return; // leave pending — a re-enabled hook drains its backlog

  // ALARM-CLASS DEBOUNCE BYPASS (owner 2026-09-04 — the wake-economy
  // counterpart of the daily-cap bypass below): the supervisor's wildcard
  // debounce is now 3600s (supervisor.service SUPERVISOR_HOOK_DEBOUNCE_SEC —
  // the 60s window let quiet run_completed ticks author a full supervisor
  // wake note every 2-10 min: observed storm 02:13Z/02:15Z/02:23Z/02:26Z,
  // 2026-09-04). At an hour-long window, alarms waiting out the debounce
  // would delay failure response by up to an hour — unacceptable. A pending
  // batch containing ANY alarm-class event (ALARM_EVENT_TYPES — the fleet's
  // smoke detectors) therefore delivers IMMEDIATELY, still as ONE coalesced
  // wake (the group's quiet rows ride along); a non-alarm-only batch respects
  // the debounce unchanged.
  const groupHasAlarm = rows.some(isAlarmRow);

  let debounceGateHeld = false;
  if (!groupHasAlarm) {
    // Debounce fast-path: fired recently → leave pending; the events coalesce
    // for the next sweep. This DB read is only a fast-path, not a lock — the
    // cross-instance window is enforced by the Redis gate below.
    if (hook.lastFiredAt && Date.now() - new Date(hook.lastFiredAt).getTime() < hook.debounceSec * 1000) return;

    // ATOMIC debounce gate (SET NX PX): two overlapping sweeps (one per web
    // instance) can BOTH read a stale lastFiredAt above, split-claim one event
    // group, and deliver TWO wakes inside a single window — the residue #207's
    // row-level claim fix consciously accepted ("at worst a split coalesce").
    // The gate lets exactly one instance own a hook's debounce window; the
    // loser's rows stay pending and coalesce into the winner's next delivery.
    // A failed delivery releases the gate so busy-retry pacing stays
    // sweep-driven (60s), not debounce-driven. Redis hiccup ⇒ fail open — the
    // atomic row claim below still prevents duplicate EVENT delivery; only the
    // one-wake-per-window guarantee degrades to today's best-effort.
    if (hook.debounceSec > 0) {
      try {
        const gate = await redisClient.set(DEBOUNCE_GATE_KEY(hookId), '1', { NX: true, PX: hook.debounceSec * 1000 });
        if (gate !== 'OK') return; // another instance owns this window — events stay pending
        debounceGateHeld = true;
      } catch { /* fail open */ }
    }
  } else if (hook.debounceSec > 0) {
    // An alarm wake OWNS the window it starts: reset the gate (plain SET PX,
    // deliberately not NX — bypass means delivering even inside an active
    // window), so follow-on quiet events debounce against THIS delivery.
    // Released below on a failed delivery, exactly like the NX path. Duplicate
    // EVENT delivery stays impossible either way (the atomic row claim); the
    // accepted worst case remains #207's split coalesce.
    try {
      await redisClient.set(DEBOUNCE_GATE_KEY(hookId), '1', { PX: hook.debounceSec * 1000 });
      debounceGateHeld = true;
    } catch { /* fail open */ }
  }

  // Review 2026-09-13 issue 1: WINDOW DRAIN — this instance owns the hook's
  // window (gate held, alarm-owned, or debounce 0), so every other deliverable
  // pending row of the hook joins the group and ships in THIS wake. The
  // fairness cap above (selectFairBatch) only decided WHICH hooks get a turn
  // per sweep; it must not ration the winner's backlog into hourly slices.
  // Lines the wake must carry about what it could NOT show accumulate here.
  const blindSpots: string[] = [];
  const drain = await drainWindowBacklog(hookId, rows);
  rows = drain.rows;
  const sib = await drainSiblingBacklog(hook, rows);
  rows = sib.rows;
  if (drain.leftBehind) {
    blindSpots.push(
      `(${drain.leftBehind.n} older pending event(s) emitted before ${drain.leftBehind.before.toISOString()} were NOT included in this wake — ` +
      `the per-delivery drain cap (${WINDOW_DRAIN_CAP}) bound; they deliver on the next window. Use list_chats / get_chat_status to fill the gap.)`,
    );
  }
  const ids = rows.map((r) => r.id);

  // Claim the group (pending → delivering) ATOMICALLY and deliver only the rows
  // THIS statement flipped. Prod runs one sweeper per web instance (A + B): two
  // overlapping sweeps can interleave a plain updateMany claim row-by-row under
  // READ COMMITTED, each winning a subset — yet both would proceed to deliver the
  // whole original group (claim.count > 0 for each), double-delivering every wake
  // (the 2026-08-12 duplicate-wake race, feedback 790ce794). UPDATE … RETURNING
  // hands each sweeper exactly the rows it claimed: no duplicates, at worst a
  // split coalesce.
  const claimed = await prisma.$queryRaw<any[]>`
    UPDATE hook_events
    SET status = 'delivering', "updatedAt" = NOW()
    WHERE id IN (${Prisma.join(ids)}) AND status = 'pending'
    RETURNING *
  `;
  if (claimed.length === 0) return; // concurrently handled (or cascade-deleted with the hook)
  rows = claimed;

  // LANE-IDLE-WAKE (2026-10-20): a DELAYED direct wake (payload.notBefore) that
  // reached a claimed group early — whatever pulled it in — goes straight back
  // to 'pending' with retryAt = its notBefore (attempts untouched); the rest of
  // the group delivers as before.
  {
    const nowMs = Date.now();
    const early = rows.filter((r) => hookRowNotYetDue(r, nowMs));
    if (early.length) {
      for (const r of early) {
        await prisma.hookEvent.updateMany({
          where: { id: r.id, status: 'delivering' },
          data: { status: 'pending', retryAt: new Date(String((r.payload as any)?.notBefore)) },
        }).catch(() => {});
      }
      rows = rows.filter((r) => !early.includes(r));
      if (!rows.length) {
        if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
        return;
      }
    }
  }

  // Ownership re-check AT DELIVERY: hook.userId must still OWN the target chat
  // (subscribe allowed owner-or-write; delivery executes with the target's
  // full identity, so anything less than ownership retires the hook). The
  // extra selects feed the retired-target hygiene check directly below.
  const tgt = await prisma.crossModelChat.findUnique({
    where: { id: hook.targetChatId },
    select: { userId: true, archivedAt: true, isSupervisor: true, isProjectSupervisor: true, codingState: { select: { id: true, status: true } } },
  });
  if (!tgt || tgt.userId !== hook.userId) {
    logger.info(`hook ${hookId.slice(0, 8)}: target ownership no longer holds (hook user ${hook.userId.slice(0, 8)}) — deleting hook and retiring its events`);
    // Status prefixes (autonomy loop #2, 2026-09-19): a row dropped because its
    // chat is gone / changed hands is NOT a delivery failure — plain 'failed'
    // made every "failed hooks" audit count deleted-chat drops as breakage.
    // 'failed:*' keeps the LIKE 'failed%' consumers (dead-letter notices,
    // telemetry) while the suffix names the cause, like 'failed:horizon'.
    await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: HOOK_STATUS_TARGET_GONE } }).catch(() => {});
    await prisma.eventHook.delete({ where: { id: hookId } }).catch(() => {}); // cascade clears the outbox rows
    await audit(hook.userId, 'hook.auto_delete', {
      hookId, reason: `target chat ${hook.targetChatId} ${!tgt ? 'deleted' : 'changed owner'}`,
      targetChatId: hook.targetChatId, sourceChatId: hook.sourceChatId,
    });
    return;
  }

  // SUPERVISOR OFF SWITCH (owner 2026-09-26; platform/supervisor-switch.ts):
  // the target is a Fleet / project supervisor chat whose admin switch is
  // OFF — skip the wake (no run, no daily-cap token: the cap reserve runs
  // below), terminal-mark the rows 'skipped:supervisor_off' (NEVER replayed
  // on re-enable, exactly like 'skipped:hook_disabled') and release the
  // debounce gate like every other no-wake path. The hook itself is left
  // enabled — turning the switch back on resumes with NEW events. Fail-open:
  // a read hiccup inside the gate delivers as before.
  const switchedOff = await supervisorWakeSkip(tgt, hookWakeSource(rows), hook.targetChatId);
  if (switchedOff) {
    await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: HOOK_STATUS_SUPERVISOR_OFF } }).catch(() => {});
    await releaseLaneIdleSlotsOf(rows);
    logger.info(`hook ${hookId.slice(0, 8)}: ${switchedOff} supervisor switch is OFF — ${rows.length} event(s) for chat ${hook.targetChatId.slice(0, 8)} skipped (not replayed on re-enable)`);
    if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
    return;
  }

  // HAND-OFF ALREADY TOLD THE USER (cohesive chat live fixes 2026-09-28;
  // platform/handoff-parent-wake.ts): a child-result run_completed /
  // run_failed batch aimed at a HUMAN-owned NON-supervisor parent is skipped
  // when the deliverable hand-off posted the result row (+ flipped the task
  // card) for that run — the raw `[MACHINE-TRIGGERED RUN …]` wake in a
  // human's plain chat was the live-acceptance defect (parent b9ee9c20).
  // A run_failed row flips the parent's running card to FAILED with the
  // cause instead. Rows terminal-mark 'skipped:handoff_posted' (NEVER
  // replayed), the debounce gate releases like every other no-wake path, no
  // cap token is spent; supervisor parents, attention_needed rows, a
  // hand-off that did not post, and a chat with no card to flip all deliver
  // exactly as before.
  const handoffSkip = await handoffParentWakeSkip(hook, tgt, rows);
  if (handoffSkip.skip) {
    const skipStatus = handoffSkip.reason === 'ps_covers_child' ? HOOK_STATUS_PS_COVERS_CHILD : HOOK_STATUS_HANDOFF_POSTED;
    await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: skipStatus } }).catch(() => {});
    logger.info(`hook ${hookId.slice(0, 8)}: child ${String(hook.sourceChatId ?? '').slice(0, 8)} → human parent ${hook.targetChatId.slice(0, 8)}: ${rows.length} event(s) skipped (${handoffSkip.reason}) — the hand-off's result row / task card is the notification`);
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.HANDOFF_PARENT_WAKE_SKIPPED,
      sessionId: hook.targetChatId,
      value: rows.length,
      meta: {
        hookId,
        childChatId: hook.sourceChatId ?? null,
        eventTypes: [...new Set(rows.map((r) => String(r?.eventType ?? '')))],
        runIds: rows.map((r) => rowRunId(r as HandoffWakeRow)).filter(Boolean),
        reason: handoffSkip.reason,
        cardFlipped: handoffSkip.failedRows.length,
      },
    });
    if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
    return;
  }

  // REPORTED IN RUN (audit 2026-10-06 T3-11, others F7 — tt-rd 7/18, CanLaw
  // 9/44, crossmodel 12/75 hook wakes self-identified as duplicates): a
  // run_completed row whose RUN already sent its report straight to this
  // hook's target (an ok send_chat_message receipt naming the target, within
  // REPORTED_IN_RUN_WINDOW_MS of the completion) duplicates that agent
  // message, which wakes the target on its own. The row is terminal-marked
  // 'skipped:reported_in_run' (mirror of 'skipped:handoff_posted'); the rest
  // of the group delivers as before. Fail-open. Kill switch
  // HOOK_REPORTED_IN_RUN_SKIP_DISABLED=1.
  const reported = await reportedInRunRows(hook, rows);
  if (reported.length) {
    const reportedIds = new Set(reported.map((r) => r.id));
    await prisma.hookEvent.updateMany({ where: { id: { in: [...reportedIds] } }, data: { status: HOOK_STATUS_REPORTED_IN_RUN } }).catch(() => {});
    rows = rows.filter((r) => !reportedIds.has(r.id));
    logger.info(`hook ${hookId.slice(0, 8)}: ${reported.length} run_completed row(s) for chat ${hook.targetChatId.slice(0, 8)} skipped — the run already reported to it directly (send_chat_message)`);
    recordLoopMetric({
      kind: 'hook_reported_in_run_skipped',
      sessionId: hook.targetChatId,
      value: reported.length,
      meta: { hookId, runIds: reported.map((r) => rowRunId(r as HandoffWakeRow)).filter(Boolean), wakeFollowed: rows.length > 0 },
    });
    if (!rows.length) {
      if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
      return;
    }
  }

  // OWNERSHIP MOVED (ticket f8c62820; platform/child-ownership-wake.ts): the
  // 2026-09-29 incident — child b811d9f7 taken over by a supervisor steer
  // (6e05992f) while its auto-wired child-result hook kept firing full-cost
  // wakes on the ex-parent (PR #1251). When the child lane's newest
  // agent-sent steer comes from a chat OTHER than the parent and is newer
  // than the parent's last engagement, the wake is skipped: rows
  // terminal-marked 'skipped:ownership_moved' (NEVER replayed), the hook
  // stays ARMED and self-heals (a newer parent steer re-establishes
  // ownership and the next child event wakes the parent again), the
  // debounce gate releases like every no-wake path, no cap token is spent.
  // Kill switch CHILD_OWNERSHIP_WAKE_DISABLED=1; every probe failure
  // delivers as before.
  const ownershipMoved = await childOwnershipWakeSkip(hook, rows);
  if (ownershipMoved) {
    await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: HOOK_STATUS_OWNERSHIP_MOVED } }).catch(() => {});
    logger.info(`hook ${hookId.slice(0, 8)}: child ${String(hook.sourceChatId ?? '').slice(0, 8)} ownership moved from ex-parent ${hook.targetChatId.slice(0, 8)} — ${rows.length} event(s) skipped (${ownershipMoved.reason})`);
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.CHILD_OWNERSHIP_WAKE_SKIPPED,
      sessionId: hook.targetChatId,
      value: rows.length,
      meta: {
        hookId,
        childChatId: hook.sourceChatId ?? null,
        eventTypes: [...new Set(rows.map((r) => String(r?.eventType ?? '')))],
        reason: ownershipMoved.reason,
      },
    });
    if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
    return;
  }

  // RETIRED-TARGET HYGIENE AT DELIVERY (ticket 57154856): the target still
  // belongs to the owner but owns NO LIVE WORK — skip the wake (no run burned,
  // no daily-cap token consumed) and AUTO-PAUSE the hook, exactly the band-aid
  // the Fleet Supervisor applied by hand to hook 97b2573e on 2026-09-20.
  // Pause-never-delete: one hook_update re-enables it when the lane is stood
  // back up (a re-subscribe also re-enables in place — pair-dedup path), and
  // the sweep's disabled-hook lane terminal-marks any straggler rows. The
  // debounce gate is released like every other no-wake path (ticket 85856e4f).
  if (await hookTargetRetired(hook, tgt)) {
    logger.info(
      `hook ${hookId.slice(0, 8)}: target chat ${hook.targetChatId.slice(0, 8)} owns no live work (retired) — skipping ${rows.length} event(s), auto-pausing hook`,
    );
    await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: HOOK_STATUS_TARGET_RETIRED } }).catch(() => {});
    // CAS pause (ticket 9df506cc F4): condition the write on enabled=true so
    // an already-paused hook is never re-written (idempotent pause — narrows
    // the pre-existing non-CAS class where a late pause write could clobber
    // state after a racing disable/re-enable).
    const retiredPause = await prisma.eventHook
      .updateMany({ where: { id: hookId, enabled: true }, data: { enabled: false } })
      .catch(() => ({ count: 0 }));
    // ARCHIVED-TARGET-RETIRE (2026-10-20): a hook paused because its target is
    // ARCHIVED (stamp or satellite) is remembered with the archive's own pauses,
    // so restoring the chat re-arms it with the rest.
    const retireOn = !archivedTargetRetireDisabled();
    const targetArchived = !!tgt.archivedAt || (retireOn && (tgt as any).codingState?.status === 'archived');
    if (targetArchived && retireOn && (retiredPause?.count ?? 0) > 0) {
      await rememberArchivePausedHooks(hook.targetChatId, [hookId]);
    }
    await audit(hook.userId, 'hook.auto_pause', {
      hookId,
      reason: `target chat ${hook.targetChatId} retired (${targetArchived ? 'archived' : 'no enabled schedules, no open todos'}) — wake skipped, hook paused; re-enable with one hook_update when the lane is stood back up`,
      targetChatId: hook.targetChatId, sourceChatId: hook.sourceChatId,
    });
    if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
    return;
  }

  if (hook.sourceChatId) {
    // SPECIFIC hook: the one source chat must still be the owner's (its
    // deletion cascades the hook anyway — this catches ownership drift).
    const src = await prisma.crossModelChat.findUnique({ where: { id: hook.sourceChatId }, select: { userId: true, archivedAt: true, parentChatId: true } });
    // SHARED-PROJECT-DISPATCH review fix (2026-10-20): a MEMBER-spawned child
    // runs as the PROJECT OWNER, so the child-result hook the member's
    // supervisor got at spawn is cross-owner by construction — the plain
    // ownership re-check below deleted it on the child's FIRST event, and the
    // supervisor that was told "this chat is WOKEN when it completes" never
    // was. memberChildResultSourceVerdict holds it ONLY for the auto-wired
    // system:child-result-hook whose source's lineage parent IS the target
    // and whose hook user still has write access to the source (project
    // membership); a lookup error requeues the rows (fail toward delivery,
    // never a silent delete). SPAWN_MEMBER_ACCESS_DISABLED=1 restores the
    // plain owner check.
    let sourceHeld = !!src && src.userId === hook.userId;
    if (src && !sourceHeld) {
      const verdict = await memberChildResultSourceVerdict(hook, src);
      if (verdict === 'unknown') {
        await prisma.hookEvent.updateMany({
          where: { id: { in: rows.map((r) => r.id) }, status: 'delivering' },
          data: { status: 'pending', retryAt: new Date(Date.now() + 60_000) },
        }).catch(() => {});
        if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
        return;
      }
      sourceHeld = verdict === 'holds';
      if (sourceHeld) {
        logger.info(`hook ${hookId.slice(0, 8)}: member-spawned child ${hook.sourceChatId.slice(0, 8)} (owner ${String(src.userId ?? '').slice(0, 8)}) → parent ${hook.targetChatId.slice(0, 8)} — cross-owner child-result hook held (write membership)`);
      }
    }
    // ARCHIVED SOURCE (audit 2026-10-06 T3-12, schooltime P3 — hooks from the
    // archived child 5e828694 stayed enabled): a retired source's events never
    // wake anyone — rows 'skipped:source_archived', the hook auto-paused
    // (pause-never-delete; archiveChat already pauses it at archive time and a
    // restore re-arms it). Self-hooks (the todo_wake direct-wake lane) are
    // judged on their TARGET at dispatch instead. Kill switch
    // HOOK_SOURCE_ARCHIVED_SKIP_DISABLED=1.
    if (src && sourceHeld && (src as any).archivedAt && hook.sourceChatId !== hook.targetChatId
      && process.env.HOOK_SOURCE_ARCHIVED_SKIP_DISABLED !== '1') {
      await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: HOOK_STATUS_SOURCE_ARCHIVED } }).catch(() => {});
      const pause = await prisma.eventHook.updateMany({ where: { id: hookId, enabled: true }, data: { enabled: false } }).catch(() => ({ count: 0 }));
      if ((pause?.count ?? 0) > 0) await rememberArchivePausedHooks(hook.sourceChatId, [hookId]);
      await audit(hook.userId, 'hook.auto_pause', {
        hookId, reason: `source chat ${hook.sourceChatId} is archived — wake skipped, hook paused; restoring the chat re-arms it`,
        targetChatId: hook.targetChatId, sourceChatId: hook.sourceChatId,
      });
      recordLoopMetric({
        kind: 'hook_source_archived',
        sessionId: hook.targetChatId,
        value: rows.length,
        meta: { hookId, sourceChatId: hook.sourceChatId, eventTypes: [...new Set(rows.map((r) => String(r?.eventType ?? '')))], autoPaused: (pause?.count ?? 0) > 0 },
      });
      if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
      return;
    }
    if (!src || !sourceHeld) {
      logger.info(`hook ${hookId.slice(0, 8)}: source ownership no longer holds (hook user ${hook.userId.slice(0, 8)}) — deleting hook and retiring its events`);
      await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: HOOK_STATUS_SOURCE_GONE } }).catch(() => {});
      await prisma.eventHook.delete({ where: { id: hookId } }).catch(() => {});
      await audit(hook.userId, 'hook.auto_delete', {
        hookId, reason: `source chat ${hook.sourceChatId} ${!src ? 'deleted' : 'changed owner'}`,
        targetChatId: hook.targetChatId, sourceChatId: hook.sourceChatId,
      });
      return;
    }
  } else {
    // WILDCARD lanes (sourceChatId NULL): the group's events can span many
    // source chats — all same-owner at emission. Re-check per row: a chat
    // DELETED since emission just loses its rows (failed); the hook itself
    // survives — chats come and go, the supervisor's watch must not.
    const sourceIds = [...new Set(rows.map((r) => String((r.payload as any)?.sourceChatId ?? '')).filter(Boolean))];
    const srcChats = sourceIds.length
      ? await prisma.crossModelChat.findMany({
          where: { id: { in: sourceIds } },
          select: { id: true, userId: true, projectId: true, project: { select: { supervised: true } } },
        })
      : [];
    const okIds = new Set(srcChats.filter((c) => c.userId === hook.userId).map((c) => c.id));
    if (hook.projectId != null) {
      // PROJECT-scope hook (per-project supervisors): keep only events whose
      // source chat is STILL owned by the hook's user AND still in the hook's
      // project — a chat moved out of the project between emission and
      // delivery loses its rows; the hook itself survives (pause-never-delete).
      // The project.supervised flag deliberately does NOT filter this lane.
      const inProjectIds = new Set(srcChats.filter((c) => c.projectId === hook.projectId).map((c) => c.id));
      const keep = rows.filter((r) => {
        const sid = String((r.payload as any)?.sourceChatId ?? '');
        return okIds.has(sid) && inProjectIds.has(sid);
      });
      const dropped = rows.length - keep.length;
      if (dropped > 0) {
        const dropIds = rows.filter((r) => !keep.includes(r)).map((r) => r.id);
        await prisma.hookEvent.updateMany({ where: { id: { in: dropIds } }, data: { status: HOOK_STATUS_SOURCE_GONE } }).catch(() => {});
        logger.info(`project hook ${hookId.slice(0, 8)}: dropped ${dropped} event(s) (source left project/foreign)`);
      }
      if (!keep.length) return;
      rows = keep;
    } else {
    // OWNER-SCOPE wildcard hook (projectId NULL).
    // Supervision re-check AT DELIVERY: a project flipped UNSUPERVISED between
    // emission and delivery loses its pending rows here (the emit-time filter
    // in emitHookEvent only covers new emissions). Ungrouped chats (no project
    // row) are always supervised — `undefined !== false` keeps them.
    const supervisedIds = new Set(srcChats.filter((c) => c.project?.supervised !== false).map((c) => c.id));
    const keep = rows.filter((r) => {
      const sid = String((r.payload as any)?.sourceChatId ?? '');
      return okIds.has(sid) && supervisedIds.has(sid);
    });
    const dropped = rows.length - keep.length;
    if (dropped > 0) {
      const droppedRows = rows.filter((r) => !keep.includes(r));
      const dropIds = droppedRows.map((r) => r.id);
      await prisma.hookEvent.updateMany({ where: { id: { in: dropIds } }, data: { status: HOOK_STATUS_SOURCE_GONE } }).catch(() => {});
      // Owner-owned but unsupervised = the supervision drop (vs deleted/foreign).
      const unsupervisedDrops = droppedRows.filter((r) => okIds.has(String((r.payload as any)?.sourceChatId ?? ''))).length;
      logger.info(
        unsupervisedDrops > 0
          ? `wildcard hook ${hookId.slice(0, 8)}: dropped ${dropped} event(s) (${dropped - unsupervisedDrops} deleted/foreign source, ${unsupervisedDrops} now-unsupervised project)`
          : `wildcard hook ${hookId.slice(0, 8)}: dropped ${dropped} event(s) from deleted/foreign source chats`,
      );
    }
    if (!keep.length) return;
    rows = keep;
    }
  }

  // FLEET-PS-FIRST REVALIDATION (2026-10-20): a held escalation whose project
  // supervisor completed a wake after every alarm it carries is dropped
  // ('skipped:ps_handled'); one whose newest unhandled alarm has not had the
  // PS's full window is re-held; the rest wake the Fleet Supervisor with only
  // the unhandled alarms. Fail-open (a read error delivers). Kill switch
  // HOOK_FLEET_ALARM_PS_FIRST_DISABLED=1.
  rows = await revalidatePsEscalations(hookId, hook.targetChatId, rows);
  if (!rows.length) {
    if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
    return;
  }

  // STALE-EVENT GUARD AT DELIVERY (ticket 2b1609b2, 2026-09-13): a row can
  // PARK behind a busy target for hours (busy parks freeze attempts by
  // design — the 24h horizon was the only bound), then deliver verbatim as
  // if fresh; the woken run then burns a full machine run re-verifying and
  // dismissing day-old state (observed: 21h-old run_completed batch waking
  // the supervisor; a 9h-late child result-hook). Consume QUIET rows older
  // than STALE_QUIET_EVENT_MS (delivered + annotated, NO wake — mirrors the
  // todo_wake suppression idiom below, feedback 7d7268fb); ALARM rows older
  // than the bound still deliver (a smoke detector is never silently
  // dropped) but carry an explicit STALE banner so the woken run classifies
  // them as historical at a glance. WI-R (2026-09-25): a TRIAGE-PARKED row
  // (payload.triagedAt — the decision gate judged it fresh once and the
  // harness itself deferred it) takes the alarm path too: the harness's own
  // deferral plus a busy-park streak must never become a silent drop.
  const staleSuppressed: Array<{ row: any; ageH: number }> = [];
  rows = rows
    .map((r) => {
      const ageMs = Date.now() - new Date(r.createdAt).getTime();
      if (!(ageMs > STALE_QUIET_EVENT_MS)) return r;
      const ageH = Math.round(ageMs / 3600000);
      if (isAlarmRow(r) || (r.payload as any)?.triagedAt) {
        const banner = `[STALE — emitted ${new Date(r.createdAt).toISOString()} (~${ageH}h before this delivery): treat as historical; re-verify current state before acting] `;
        return { ...r, payload: { ...(r.payload as any), summary: banner + String((r.payload as any)?.summary ?? '') } };
      }
      staleSuppressed.push({ row: r, ageH });
      return null;
    })
    .filter((r): r is any => r !== null);
  if (staleSuppressed.length) {
    for (const { row, ageH } of staleSuppressed) {
      await prisma.hookEvent.updateMany({
        where: { id: row.id },
        data: { status: 'delivered', payload: { ...(row.payload as any), suppressedAtDelivery: `stale:${ageH}h` } },
      }).catch(() => {});
    }
    logger.info(
      `hook ${hookId.slice(0, 8)}: suppressed ${staleSuppressed.length} stale quiet event(s) at delivery (${staleSuppressed.map((s) => `${s.row.eventType}:${s.ageH}h`).join(', ')}) — older than ${Math.round(STALE_QUIET_EVENT_MS / 3600000)}h, no wake`,
    );
    await audit(hook.userId, 'hook.stale_suppressed', {
      hookId,
      targetChatId: hook.targetChatId,
      suppressed: staleSuppressed.map((s) => ({ id: s.row.id, eventType: s.row.eventType, ageH: s.ageH })),
    });
    // Review 2026-09-13 issue 1 (option C): stale consumption is never silent
    // again — the delivered wake (when one follows) says exactly which span it
    // is blind to.
    const maxAgeH = Math.max(...staleSuppressed.map((s) => s.ageH));
    const staleTypes = [...new Set(staleSuppressed.map((s) => String(s.row.eventType ?? '')))];
    const staleStamps = staleSuppressed.map((s) => +new Date(s.row.createdAt)).filter(Number.isFinite);
    if (staleStamps.length) {
      const since = new Date(Math.min(...staleStamps)).toISOString();
      const until = new Date(Math.max(...staleStamps)).toISOString();
      blindSpots.push(
        `(${staleSuppressed.length} older completion(s) [${staleTypes.join(', ')}] emitted between ${since} and ${until} were NOT shown — ` +
        `consumed as stale (>${Math.round(STALE_QUIET_EVENT_MS / 3600000)}h old at delivery, oldest ~${maxAgeH}h). ` +
        'This wake is partially blind to that span; use list_chats / get_chat_status to fill the gap.)',
      );
    }
    if (!rows.length) {
      // Every row in the group was stale — nothing to wake for. Release the
      // debounce gate exactly like the todo_wake all-stale path below
      // (ticket 85856e4f): a phantom window must not delay the NEXT genuine
      // wake by up to debounceSec (as long as 3600 s).
      if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
      return;
    }
  }

  // STALE-WAKE REVALIDATION AT DELIVERY (feedback 7d7268fb, 2026-09-11): a
  // durable todo_wake row is enqueued at a GENUINE transition (dep auto-
  // unblock / manual unblock / assignment) but can PARK behind a busy
  // assignee — alarm-class parks hold until the run finalizes, potentially
  // for hours. The 2026-09-11 phantom: a 14:53Z unblock wake delivered at
  // 16:27Z onto a todo re-blocked (owner gate oq_…) at ~15:52Z, and the
  // parked summary still asserted "a todo was just UNBLOCKED to this chat …
  // START now — execution, not a status audit" — urging execution of an
  // owner-gated, production-blast-radius todo. The wake's PURPOSE is "a todo
  // is actionable for you NOW", so re-read the todo at delivery: missing,
  // reassigned away, or not actionable (blocked/done/dropped) ⇒ the wake is
  // stale — consume the row (delivered, annotated) with NO wake. A prisma
  // hiccup fails OPEN (deliver): the outbox must not wedge, and the woken
  // run re-reads the board at source before acting (goals.service prompt).
  if (rows.some((r) => r.eventType === TODO_WAKE_EVENT_TYPE)) {
    const survivors: typeof rows = [];
    const suppressed: Array<{ row: any; reason: string }> = [];
    const deferred: Array<{ row: any; until: Date }> = [];
    for (const r of rows) {
      if (r.eventType !== TODO_WAKE_EVENT_TYPE) { survivors.push(r); continue; }
      // LANE-IDLE-WAKE (2026-10-20, coding/lane-idle.ts): a supervisor wake ABOUT
      // an idle lane is stale when the lane is running / woken / waiting on the
      // owner / armed by a schedule, a newer run was stopped, or it holds no
      // actionable todo any more. A lane that ran again and went idle again is a
      // NEW episode: deferred until its newest run is past the grace window, then
      // delivered with a re-rendered prompt. Its target is the supervisor (never
      // the assignee), so the actionable-for-the-assignee check below must not
      // judge it. Fail-open: a read error delivers. The first delivery of an
      // episode is stamped (payload.laneIdleDeliveredAt, persisted — review fix
      // 2026-10-20) so a row a busy supervisor re-parks records its 'delivered'
      // lane_idle_wake row once (the psEscalation.escalatedAt pattern).
      if ((r.payload as any)?.wakeKind === 'lane_idle') {
        const v = await import('../coding/lane-idle')
          .then((m) => m.revalidateLaneIdleWake(r.payload))
          .catch(() => null);
        if (v?.action === 'suppress') suppressed.push({ row: r, reason: `lane_idle:${v.reason}` });
        else if (v?.action === 'defer') deferred.push({ row: r, until: v.until });
        else {
          let row = r;
          if (v?.action === 'deliver' && v.deliveredAt) {
            row = { ...r, payload: { ...(r.payload as any), laneIdleDeliveredAt: v.deliveredAt } };
            await prisma.hookEvent.updateMany({ where: { id: r.id }, data: { payload: row.payload as unknown as object } }).catch(() => {});
          }
          survivors.push(v?.action === 'deliver' && v.prompt
            ? { ...row, payload: { ...(row.payload as any), summary: truncateSummary(redactHookSummary(v.prompt)) } }
            : row);
        }
        continue;
      }
      const todoId = String((r.payload as any)?.todoId ?? '');
      if (!todoId) { survivors.push(r); continue; } // no revalidation handle — deliver as-is
      try {
        const todo = await prisma.projectTodo.findUnique({
          where: { id: todoId },
          select: { status: true, assigneeChatId: true },
        });
        // A wake ABOUT a blocked todo (BLOCKED_TODO_WAKE_TRIGGERS) is the
        // inverse shape: stale when the todo is gone, closed, or no longer
        // blocked; the target may be the supervisor, not the assignee.
        const aboutBlocked = BLOCKED_TODO_WAKE_TRIGGERS.has(String((r.payload as any)?.trigger ?? ''));
        const reason = !todo
          ? 'todo_missing'
          : aboutBlocked
            ? (String(todo.status) === 'blocked' ? null : `status:${todo.status}`)
            : todo.assigneeChatId !== hook.targetChatId
              ? 'reassigned_away'
              : (TODO_WAKE_STALE_STATUSES as readonly string[]).includes(String(todo.status))
                ? `status:${todo.status}`
                : null;
        if (reason) suppressed.push({ row: r, reason });
        else survivors.push(r);
      } catch (err: any) {
        logger.warn(`hook ${hookId.slice(0, 8)}: todo_wake revalidation failed for todo ${todoId.slice(0, 8)} (${err?.message}) — delivering as-is`);
        survivors.push(r); // fail open
      }
    }
    if (suppressed.length) {
      for (const { row, reason } of suppressed) {
        await prisma.hookEvent.updateMany({
          where: { id: row.id },
          data: { status: 'delivered', payload: { ...(row.payload as any), suppressedAtDelivery: reason } },
        }).catch(() => {});
      }
      logger.info(
        `hook ${hookId.slice(0, 8)}: suppressed ${suppressed.length} stale todo_wake row(s) at delivery (${suppressed.map((s) => s.reason).join(', ')}) — the todo is not actionable for the assignee now`,
      );
      await audit(hook.userId, 'todo.wake_suppressed', {
        hookId,
        targetChatId: hook.targetChatId,
        suppressed: suppressed.map((s) => ({ todoId: String((s.row.payload as any)?.todoId ?? (s.row.payload as any)?.laneTodoId ?? ''), reason: s.reason })),
      });
    }
    // LANE-IDLE-WAKE review fix: a deferred lane_idle row goes back to 'pending' with a
    // NEW notBefore (= retryAt) — hookRowNotYetDue keeps it out of every drain until then
    // (attempts untouched; the row still owns the lane's idle episode).
    for (const { row, until } of deferred) {
      await prisma.hookEvent.updateMany({
        where: { id: row.id, status: 'delivering' },
        data: {
          status: 'pending',
          retryAt: until,
          payload: { ...(row.payload as any), notBefore: until.toISOString(), laneIdleDeferrals: Number((row.payload as any)?.laneIdleDeferrals ?? 0) + 1 },
        },
      }).catch(() => {});
    }
    if (deferred.length) {
      logger.info(`hook ${hookId.slice(0, 8)}: deferred ${deferred.length} lane_idle wake(s) — the lane ran again since the enqueue; re-checked once its newest run is past the grace window`);
    }
    rows = survivors;
    if (!rows.length) {
      // Every wake in the group was stale — no delivery happened. Release the
      // debounce gate exactly like the not-started path below does (ticket
      // 85856e4f): a phantom window must not delay the NEXT genuine wake by
      // up to debounceSec (as long as 3600 s).
      if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
      return;
    }
  }

  // Alarm-class split (audit #3): alarm rows get the daily-cap bypass here and
  // the busy-target park below; non-alarm rows keep today's contract byte for
  // byte (drop-at-cap, retry-then-fail on busy).
  const alarmRows = rows.filter(isAlarmRow);
  const nonAlarmRows = rows.filter((r) => !isAlarmRow(r));

  // DAILY BUDGET: a hook wake consumes the target chat's per-day machine-run
  // budget — the SAME counter schedule firings consume (dailyCapExceeded,
  // ChatAutonomy.scheduleCap ?? 48). Hook deliveries used to bypass it
  // entirely, leaving a wake loop with no budget at all (audit 2026-08-13).
  // A capped NON-ALARM wake is DROPPED (rows failed + log + schedule_cap_skipped
  // event + one owner notice per window), never left pending — a capped chat
  // must not bank an unbounded backlog that all fires when the window resets.
  // ALARM-class rows (audit #3) BYPASS the cap instead: the events that mean
  // "something is wrong" are exactly the ones a spent budget must not silence.
  let capBypassed = false;
  const exceededCap = await dailyCapExceeded(hook.targetChatId);
  if (exceededCap !== null) {
    if (nonAlarmRows.length) {
      await prisma.hookEvent.updateMany({ where: { id: { in: nonAlarmRows.map((r) => r.id) } }, data: { status: 'failed' } }).catch(() => {});
      logger.warn(
        `hook ${hookId.slice(0, 8)}: wake for chat ${hook.targetChatId.slice(0, 8)} hit the ${exceededCap}/day machine-run cap — dropped ${nonAlarmRows.length} event(s)`,
      );
      // The skip event carries the depth this wake WOULD have stamped, so a
      // deep chain's cap-skip notifications die at MAX_HOOK_DEPTH too.
      // Deduped to ONE per chat per cap window — the SAME 'daily' gate the
      // sweeper's firing skips claim (feedback a30b6ad9): whether the cap was
      // tripped by a schedule firing or a wake drop, "chat is capped" reaches
      // the supervisor once per window, not once per skip.
      const droppedDepth = Math.max(0, ...nonAlarmRows.map((r) => Number((r.payload as any)?.depth ?? 0) || 0));
      if (await claimCapWindowGate(hook.targetChatId, 'daily')) {
        await emitHookEventSafe(
          hook.targetChatId, 'schedule_cap_skipped',
          `Hook wake skipped: chat hit the ${exceededCap}/day machine-run cap (${nonAlarmRows.length} event(s) dropped; further identical skips are muted until the window resets)`,
          { depth: droppedDepth + 1 },
        );
      }
      await notifyDailyCapOnce(hook.targetChatId, exceededCap).catch(() => {});
    }
    if (!alarmRows.length) return;
    // Alarm-class BYPASS: deliver the alarms anyway. No budget token is held
    // here (dailyCapExceeded refunds its speculative INCR when over the cap),
    // so the busy path below must not refund one either (capBypassed).
    rows = alarmRows;
    capBypassed = true;
    logger.warn(`hook ${hookId.slice(0, 8)}: ${rows.length} alarm-class event(s) BYPASS the ${exceededCap}/day machine-run cap for chat ${hook.targetChatId.slice(0, 8)}`);
  }

  // MATERIAL-CHANGE GATE (audit 2026-10-08 W6-2; platform/supervisor-wake-ledger.ts
  // + wake-material-rule.ts): a SUPERVISOR target's group is judged by ONE
  // deterministic rule over the ledger diff since its last completed wake —
  // no material change and no alarm-class row ⇒ the group is skipped below
  // (rows 'skipped:no_material_change', never replayed; the next wake's
  // [SINCE YOUR LAST WAKE] lists them). Evaluated BEFORE the Jev triage so the
  // shadow ask still runs beside it (agreement recorded); the Jev wake purposes
  // are capped at shadow while this gate acts (decision-gate-modes). Fail-open.
  // Kill switch SUPERVISOR_MATERIAL_GATE_DISABLED=1; observe-only SUPERVISOR_MATERIAL_GATE_SHADOW=1.
  const materialGate: MaterialGateResult | null = (tgt.isSupervisor || tgt.isProjectSupervisor) && rows.length
    ? await materialGateForHook({ targetChatId: hook.targetChatId, rows, alarm: alarmRows.length > 0 || capBypassed, isAlarmRow }).catch(() => null)
    : null;

  // DECISION GATE — WAKE TRIAGE (2026-09-24). The Fleet Supervisor was
  // saturated (121 turns / 24 h, p50 8 min per turn, 66 of them single ~1.2 KB
  // report-ups): every non-alarm event group cost a full reasoning turn. A
  // typed noul over the coalesced summary asks whether the batch needs the
  // supervisor NOW. SHADOW (default) only records; ACT parks a confidently
  // no-action batch for WAKE_TRIAGE_DEFER_MS (pending, attempts frozen,
  // payload.triagedAt stamped so it is never triaged twice) — it then rides
  // the next wake or delivers on its own after the deferral, so nothing is
  // lost and the delay is bounded. Alarm rows and cap-bypass wakes are never
  // triaged; any error fails open to delivery.
  // OUTCOME LABEL (WI-C, 2026-09-25): a delivered (non-parked) decision is no
  // longer closed here with actual:null — its stash rides the wake through
  // fireScheduleTarget to the run that finalizes it, where the label is
  // derived from what the run DID (decision-outcome-labels.ts). Shadow-safe:
  // nothing about delivery changes; only the outcome row moves.
  let triageStash: DecisionStash | null = null;
  // 2026-10-04 control sample: a confident-quiet ACT verdict that the draw
  // (drawWakeTriageControl, 1 in 10) let DELIVER instead of park — its stash /
  // outcome rows carry WAKE_TRIAGE_CONTROL_EXTRA so the finalize label lands in
  // the act band (mode act, inActBand, acted false) and the E12 + durable
  // auto-demote windows can finally judge the park band.
  let triageControl = false;
  const triageMode = decisionMode('wake_triage');
  // audit 2026-10-06 T3-1: a parked row no longer disables triage for its
  // batch — the merged group (fresh rows + riding parks) is triaged, a batch
  // of parked rows only is RE-triaged; only a park past its max hold delivers
  // untriaged. Kill switch: the pre-audit "any triagedAt ⇒ never triage" rule.
  const parkRide = !wakeTriageParkRideDisabled();
  const triageNowMs = Date.now();
  const parkedInGroup = parkRide ? rows.filter(isTriageParkedRow) : [];
  const parkHoldExpired = parkRide && parkedInGroup.some((r) => triageHoldExpired(r, triageNowMs));
  const triageEligible = parkRide ? !parkHoldExpired : !rows.some((r) => (r.payload as any)?.triagedAt);
  let reTriaged = false;
  if (triageMode !== 'off' && !alarmRows.length && !capBypassed && rows.length && triageEligible) {
    reTriaged = parkedInGroup.length > 0;
    try {
      const preview = coalesce(rows);
      // E7 (2026-09-25): the request is built by wake-triage-request.ts —
      // code-computed fields + bounded lane facts first, prose last and
      // capped, and a fan-out of five questions (needs_turn_now kept
      // verbatim). The ACT path below keys on needs_turn_now alone; the park
      // stays bounded, never re-triaged.
      const target = tgt.isSupervisor ? 'fleet supervisor chat' : tgt.isProjectSupervisor ? 'project supervisor chat' : 'supervised chat';
      // E7 lane facts are looked up under the WAKE_TRIAGE_LANE_LOOKUP_MS budget.
      const lanes: WakeSourceLaneFacts[] | null = await lookupWakeSourceLanes(wakeTriageSourceIds(rows));
      const request = buildWakeTriageRequest({ target, rows, preview, lanes, isAlarm: isAlarmRow });
      // E3b (2026-09-25): the memo keys the request's MEMO-STABLE projection
      // (bucketed ages + the batch's event ids), so the busy re-ask of the
      // same batch next sweep answers from the memo; a batch with a new event
      // id, a row without an id, or an alarm row is never memoised
      // (memo:false). The backend still sees `request.state` verbatim.
      const gate = await decide(request.state, request.questions, {
        purpose: 'wake_triage', timeoutMs: 4000, sessionId: hook.targetChatId,
        ...(request.memoable && request.memoState ? { memoState: request.memoState } : { memo: false }),
      });
      if (gate) {
        // The two batch-property nouls are labelled NOW from the code flags
        // (they are facts of the batch, not of the run) — one outcome row each.
        for (const l of wakeTriageCodeLabels(gate, request.flags)) {
          recordDecisionOutcome(gate, 'wake_triage', { question: l.question, actual: l.actual, acted: false, sessionId: hook.targetChatId, note: 'decision-time code flag' });
        }
        const p = (gate.answers.needs_turn_now as { noul: number }).noul;
        const threshold = decisionThreshold('wake_triage', 0.85);
        // E2 (2026-09-25): act on the RESULT's mode — decide() returns 'shadow'
        // for an act purpose answered by an uncalibrated backend.
        // 2026-10-04: ONE confident park in N delivers as a CONTROL instead (the
        // sweep_triage E12 design) — a parked wake is never labelled, so without
        // this the act band held zero act-period labels and auto-demote could
        // never judge the purpose. Only this confident-park path draws.
        const confidentPark = gate.mode === 'act' && p <= 1 - threshold;
        if (confidentPark && drawWakeTriageControl()) {
          triageControl = true;
          logger.info(`hook ${hookId.slice(0, 8)}: decision gate control sample — ${rows.length} ${preview.eventType} event(s) for chat ${hook.targetChatId.slice(0, 8)} DELIVER instead of park (needs_turn_now ${p.toFixed(2)}); the run's finalize labels the act band`);
        } else if (confidentPark) {
          const deferMs = WAKE_TRIAGE_DEFER_MS();
          const retryAt = new Date(Date.now() + deferMs);
          // audit 2026-10-06 T3-1: the park decision rides in the row (slim — no
          // challengers) so the finalize of the wake the row later rides labels
          // it; the first park time anchors the max hold, which also caps retryAt.
          const parkStash = parkRide ? slimParkStash(stashDecision(gate, 'wake_triage')) : null;
          const maxHoldMs = WAKE_TRIAGE_MAX_HOLD_MS();
          const nowIso = new Date().toISOString();
          for (const r of rows) {
            const prev = (r.payload ?? {}) as any;
            const data = parkRide
              ? {
                  status: 'pending',
                  retryAt: isTriageParkedRow(r) ? new Date(Math.min(retryAt.getTime(), triageParkFirstAtMs(r) + maxHoldMs)) : retryAt,
                  payload: {
                    ...prev, triagedAt: nowIso, triageNoul: Number(p.toFixed(3)),
                    firstTriagedAt: isTriageParkedRow(r) ? new Date(triageParkFirstAtMs(r)).toISOString() : nowIso,
                    ...(parkStash ? { triageParkStash: parkStash } : {}),
                  },
                }
              : { status: 'pending', retryAt, payload: { ...prev, triagedAt: new Date().toISOString(), triageNoul: Number(p.toFixed(3)) } };
            await prisma.hookEvent.updateMany({
              where: { id: r.id },
              data,
            }).catch(() => {});
          }
          if (!capBypassed) await refundDailyCapToken(hook.targetChatId);
          if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
          recordLoopMetric({ kind: LOOP_METRIC_KINDS.WAKE_PARKED, sessionId: hook.targetChatId, value: rows.length, meta: { reason: 'triage', ttlPark: true, deferMs, eventType: preview.eventType, hookId, ...(reTriaged ? { retriaged: parkedInGroup.length } : {}) } });
          const v2 = wakeTriageV2Note(gate.answers);
          recordDecisionOutcome(gate, 'wake_triage', { question: 'needs_turn_now', actual: null, acted: true, sessionId: hook.targetChatId, note: `parked ${rows.length} row(s) for ${Math.round(deferMs / 60000)} min${reTriaged ? ` (re-triaged ${parkedInGroup.length} parked)` : ''}${v2 ? `; ${v2}` : ''}` });
          logger.info(`hook ${hookId.slice(0, 8)}: decision gate parked ${rows.length} ${preview.eventType} event(s) for chat ${hook.targetChatId.slice(0, 8)} (needs_turn_now ${p.toFixed(2)}) — they ride the next wake or deliver in ~${Math.round(deferMs / 60000)} min`);
          return;
        }
        const controlExtra = triageControl ? { extra: { ...WAKE_TRIAGE_CONTROL_EXTRA } } : {};
        triageStash = stashDecision(gate, 'wake_triage', controlExtra);
      }
    } catch (err: any) {
      logger.warn(`hook ${hookId.slice(0, 8)}: wake triage failed open (${err?.message || err}) — delivering`);
    }
  }

  // audit 2026-10-06 T3-1: the parks riding this wake carry their own park
  // decision; the run that finalizes this wake labels them (DecisionStash.also).
  // Only a wake made purely of parked rows delivered on the max hold (no fresh
  // triage) enters the fit; every other ride is ambiguous → excludeFromFit.
  const parkRiders = parkRide ? rows.filter(isTriageParkedRow) : [];
  const parkRideStashes = parkRideLabelStashes(parkRiders, {
    clean: parkRiders.length === rows.length && parkHoldExpired && !triageStash,
  });
  const fireDecision: DecisionStash | null = triageStash
    ? (parkRideStashes.length ? { ...triageStash, also: [...(triageStash.also ?? []), ...parkRideStashes] } : triageStash)
    : parkRideStashes.length ? { ...parkRideStashes[0], ...(parkRideStashes.length > 1 ? { also: parkRideStashes.slice(1) } : {}) } : null;

  // W6-2: the deterministic verdict vs the Jev shadow ask at this site, then the skip.
  // SUP-WAKE-TIERS (2026-10-20): a progress-only group whose lanes drive themselves is stamped
  // 'skipped:progress_self_driving' — terminal like no_material_change, listed in the next diff.
  if (materialGate) recordMaterialGateAgreement(materialGate, [triageStash]);
  if (materialGate?.skip) {
    const progressHold = materialGate.skipReason === 'progress_self_driving';
    await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: progressHold ? HOOK_STATUS_PROGRESS_SELF_DRIVING : HOOK_STATUS_NO_MATERIAL_CHANGE } }).catch(() => {});
    if (!capBypassed) await refundDailyCapToken(hook.targetChatId);
    if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
    // Every decision that rode this group pairs with one (unlabelled) outcome row.
    if (triageStash) {
      const answered = new Set(wakeTriageAnsweredKeys(triageStash.answers));
      for (const question of WAKE_TRIAGE_RUN_LABELLED_QUESTIONS.filter((q) => q === 'needs_turn_now' || answered.has(q))) {
        recordDecisionOutcome(reconstructDecision(triageStash), 'wake_triage', { question, actual: null, acted: false, sessionId: hook.targetChatId, note: progressHold ? 'not started: material gate skip (progress, lanes self-driving)' : 'not started: material gate skip (no material change)' });
      }
    }
    void closeStashesForGateSkip(parkRideStashes, hook.targetChatId, 'hook');
    logger.info(progressHold
      ? `hook ${hookId.slice(0, 8)}: material gate — ${rows.length} ${String(rows[0]?.eventType ?? '')} event(s) for supervisor ${hook.targetChatId.slice(0, 8)} held: progress only (${(materialGate.verdict?.reasons ?? []).join(', ')}) and every source lane is driving itself — ${materialGate.verdict?.sinceMin ?? '?'} min since its last wake (SUP-WAKE-TIERS 2026-10-20)`
      : `hook ${hookId.slice(0, 8)}: material gate — ${rows.length} ${String(rows[0]?.eventType ?? '')} event(s) for supervisor ${hook.targetChatId.slice(0, 8)} skipped: no material change since its last wake ${materialGate.verdict?.sinceMin ?? '?'} min ago (audit 2026-10-08 W6)`);
    return;
  }

  const coalesced = coalesce(rows);
  // Review 2026-09-13 issue 1: what this wake could NOT show rides inside the
  // summary so every template (default, custom, child result-hook) carries it.
  if (blindSpots.length) coalesced.summary = `${coalesced.summary}\n${blindSpots.join('\n')}`;
  // audit 2026-10-06 T3-3: rows stored before the emission-time redaction.
  coalesced.summary = redactHookSummary(coalesced.summary);
  const template = String(hook.promptTemplate ?? '').trim() || DEFAULT_PROMPT_TEMPLATE;
  const prompt = renderPrompt(template, coalesced);

  // Deliver via the SAME internal machine-run path the schedule sweeper uses
  // (fireScheduleTarget): code-capable chat → queued coding run; plain chat →
  // detached chat-agent turn. No userTurnAt — the wake stays machine-triggered.
  // origin 'hook' (audit p10): a hook wake is NOT a CodingSchedule firing —
  // the fleet views must attribute it to the hooks subsystem, not the sweeper.
  let res: { started: boolean; reason?: string; decisionDeferred?: boolean };
  try {
    // Child→parent result wake (ticket 56d6b204): this delivery is the
    // auto-wired sub-session RESULT path — the parent SPAWNED the source
    // session and is waiting on its verdict, so the wake turn is DELIVERED
    // CONTENT, not internal wake noise. childResult:true rides the firing so
    // the persisted wake user row carries metadata.childResult and the
    // frontend renders the turn EXPANDED with a "results" marker (the
    // 2026-09-25 incident, chat 6e36c834: the completed DB-audit result
    // stayed hidden behind the collapsed machine accordion). Template OR
    // provenance: 34 enabled prod hooks still carry the LEGACY pre-2026-09-14
    // template (createdVia NULL — pre-provenance), and a same-shape CUSTOM
    // template (isChildResultTemplate false) is NOT a child-result wake and
    // must stay collapsed.
    const childResultWake = isChildResultTemplate(template) || hook.createdVia === 'system:child-result-hook';
    // Owner-ask wake (fixer 2026-09-27, finding upward-chatter-1): the
    // [OWNER ASK UNANSWERED] re-wake (platform/owner-asks.ts) and the
    // [FOLLOW-THROUGH] nudge (fleet/follow-through.service.ts) both ride the
    // direct-wake outbox with payload.kind 'owner_ask_unanswered' +
    // payload.askMessageId. Thread the ask ids into the run so the chat-agent
    // finalize can CLOSE the ask on the wake's real reply — before this the
    // close ran only on owner turns, so the very wakes built to answer an ask
    // could never close it (72 h of re-injection, nudge + escalation).
    const ownerAskMessageIds = [...new Set(rows
      .map((r) => (r?.payload as any))
      .filter((p) => p?.kind === 'owner_ask_unanswered' && typeof p?.askMessageId === 'string' && p.askMessageId.trim())
      .map((p) => String(p.askMessageId).trim().slice(0, 64)))];
    res = await fireScheduleTarget({ id: `hook-${hookId}`, sessionId: hook.targetChatId, prompt, origin: 'hook', ...(fireDecision ? { decision: fireDecision } : {}), ...(childResultWake ? { childResult: true } : {}), ...(ownerAskMessageIds.length ? { ownerAskMessageIds } : {}) });
  } catch (err: any) {
    res = { started: false, reason: `error:${String(err?.message).slice(0, 60)}` };
  }
  // WI-C: a stash only reaches a finalize when a run STARTED and carried it;
  // a busy park (re-triaged next sweep — a fresh decision row), a steer into
  // an active run, or a queue-behind-busy row close the decision here,
  // unlabelled, so every decision row still pairs with exactly one outcome.
  if (triageStash && !(res.started && res.decisionDeferred)) {
    // E7: a v2 stash closes every RUN-labelled question it answered (the
    // batch-property nouls were already labelled at decision time); a v1
    // stash still closes needs_turn_now alone.
    const answered = new Set(wakeTriageAnsweredKeys(triageStash.answers));
    const questions = WAKE_TRIAGE_RUN_LABELLED_QUESTIONS.filter((q) => q === 'needs_turn_now' || answered.has(q));
    for (const question of questions) {
      recordDecisionOutcome(reconstructDecision(triageStash), 'wake_triage', {
        question, actual: null, acted: false, sessionId: hook.targetChatId,
        note: res.started ? 'delivered (steered/queued — outcome not attributable)' : `not started: ${res.reason ?? 'unknown'}`,
        // 2026-10-04: an unstarted CONTROL keeps its stamp (unlabelled — counts the draws that never reached a finalize).
        ...(triageControl ? { extra: { ...WAKE_TRIAGE_CONTROL_EXTRA } } : {}),
      });
    }
  }

  if (res.started) {
    // Mark DELIVERED only the rows actually delivered — for a wildcard hook the
    // ownership re-check may have failed some rows (deleted/foreign sources);
    // the stale pre-filter `ids` would resurrect them as delivered.
    await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: 'delivered' } }).catch(() => {});
    await prisma.eventHook.update({ where: { id: hookId }, data: { lastFiredAt: new Date() } }).catch(() => {});
    if (sib.siblingHookIds.length) {
      // Their rows rode this wake — reset their debounce clocks so they do not
      // fire a redundant wake for events the target has already been told about.
      await prisma.eventHook.updateMany({ where: { id: { in: sib.siblingHookIds } }, data: { lastFiredAt: new Date() } }).catch(() => {});
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.HOOK_SIBLING_DRAIN,
        sessionId: hook.targetChatId,
        value: sib.drained,
        meta: { hookId, siblingHooks: sib.siblingHookIds.length, rows: sib.drained },
      });
    }
    // Depth propagation: the woken run's own emissions carry depth+1 (monotonic
    // MAX — a concurrent shallower stamp must not lower the ladder).
    await stampHookDepth(hook.targetChatId, coalesced.depth + 1);
    logger.info(
      `hook ${hookId.slice(0, 8)}: delivered ${rows.length} event(s) (${coalesced.eventType}) to chat ${hook.targetChatId.slice(0, 8)} at depth ${coalesced.depth + 1}`,
    );
    // Review 2026-09-13 issue 1: `drained` = rows the window drain added beyond the fair batch.
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.WAKE_DELIVERED, sessionId: hook.targetChatId, value: rows.length, meta: { eventType: coalesced.eventType, hookId, capBypassed, drained: drain.drained, ...(triageControl ? { triageControl: true } : {}), ...(parkRiders.length ? { parkedRode: parkRiders.length, parkHoldExpired, reTriaged } : {}) } });
  } else {
    // Busy target (or a transient not_found/error): non-alarm rows stay
    // pending with attempts+1 (failed at MAX_DELIVERY_ATTEMPTS) — unchanged.
    // Refund the speculative budget token (no run started — mirrors fireDue's
    // busy-skip refund, feedback 94bb9c2f) UNLESS this was an alarm cap-bypass
    // (no token was held), and release the debounce gate so the retry stays
    // sweep-paced instead of waiting out a phantom window.
    if (!capBypassed) await refundDailyCapToken(hook.targetChatId);
    if (debounceGateHeld) await redisClient.del(DEBOUNCE_GATE_KEY(hookId)).catch(() => {});
    // Busy-target PARK (audit #3, widened by v1#1): a busy target now parks
    // EVERY row instead of aging any of them toward the MAX_DELIVERY_ATTEMPTS
    // death — busy is the target's normal working state, not a delivery
    // failure (child→parent run_completed wakes died at ~60 attempts while
    // the parent legitimately worked for an hour). Alarm rows park exactly as
    // before (pending, attempts frozen, PARKED_ALARM_CAP); non-alarm rows
    // TTL-park (pending, retryAt = now + BUSY_PARK_MS, attempts frozen) so
    // the sweep stops re-attempting them every 60s. The 24h pending horizon
    // in sweepHookEvents ('failed:horizon') is the dead-letter bound for
    // both. Only the 'busy' verdict parks: transient errors keep the bounded
    // retry/fail lane so a permanently erroring target still surfaces via the
    // owner-visible death notice.
    if (res.reason === SUPERVISOR_SWITCH_SKIP_REASON) {
      // Supervisor switch flipped OFF between the pre-fire gate above and the
      // dispatch (fireScheduleTarget's backstop answered) — same terminal
      // mark as the pre-fire lane: no attempt burn, no park, no replay.
      await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: HOOK_STATUS_SUPERVISOR_OFF } }).catch(() => {});
      await releaseLaneIdleSlotsOf(rows);
      logger.info(`hook ${hookId.slice(0, 8)}: target chat ${hook.targetChatId.slice(0, 8)} is a switched-off supervisor — ${rows.length} event(s) skipped at dispatch, no wake`);
    } else if (res.reason === 'archived') {
      // Archived target AT DISPATCH (autonomy loop #13): the chat retired after
      // the pre-fire check above, or a system:* hook (exempt from the
      // retired-target pause) woke it. The rows retire exactly like the
      // pre-fire lane — no attempt burn, no park, no death notice — and the
      // hook itself is left as it is (system hooks are bounded by
      // construction; a non-system hook was already paused pre-fire).
      await prisma.hookEvent.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: HOOK_STATUS_TARGET_RETIRED } }).catch(() => {});
      logger.info(`hook ${hookId.slice(0, 8)}: target chat ${hook.targetChatId.slice(0, 8)} is ARCHIVED — ${rows.length} event(s) retired at dispatch, no wake`);
    } else if (res.reason === 'busy') {
      const alarmPark = rows.filter(isAlarmRow);
      const busyPark = rows.filter((r) => !alarmPark.includes(r));
      if (busyPark.length) await parkBusyRows(hook.targetChatId, busyPark);
      if (alarmPark.length) await parkAlarmRows(hook.targetChatId, alarmPark, 'busy');
    } else {
      await retryOrFail(rows, res.reason ?? 'unknown');
    }
    logger.info(`hook ${hookId.slice(0, 8)}: target chat ${hook.targetChatId.slice(0, 8)} not deliverable (${res.reason}) — events stay pending`);
  }
}

/**
 * Fair batch selection (v1#1 / spark B17+B18) — pure, exported for tests.
 * The old sweep took the 50 OLDEST pending rows fleet-wide, so one dying
 * hook's backlog monopolized every sweep and starved live hooks (a deaf
 * fleet with a full outbox). Order: ALL alarm-class rows first (oldest-first
 * — the smoke detectors are few and bounded by PARKED_ALARM_CAP per target),
 * then a per-hook round-robin over the quiet remainder, at most
 * SWEEP_PER_HOOK_CAP quiet rows per hook per sweep.
 */
export function selectFairBatch(rows: any[], batchSize: number = SWEEP_BATCH, perHookCap: number = SWEEP_PER_HOOK_CAP): any[] {
  const alarms = rows.filter(isAlarmRow);
  const quiet = rows.filter((r) => !alarms.includes(r));
  const batch: any[] = alarms.slice(0, batchSize);
  if (batch.length >= batchSize) return batch;
  const byHook = new Map<string, any[]>();
  for (const r of quiet) {
    const g = byHook.get(r.hookId);
    if (g) g.push(r);
    else byHook.set(r.hookId, [r]);
  }
  const taken = new Map<string, number>();
  let progressed = true;
  while (batch.length < batchSize && progressed) {
    progressed = false;
    for (const [hookId, list] of byHook) {
      const n = taken.get(hookId) ?? 0;
      if (n >= perHookCap || n >= list.length) continue;
      batch.push(list[n]);
      taken.set(hookId, n + 1);
      progressed = true;
      if (batch.length >= batchSize) break;
    }
  }
  return batch;
}

/**
 * One sweep pass over the outbox. Called from each web instance's 60s
 * schedule sweeper (one sweeper PER INSTANCE — see the design note above for
 * the two locks that make that safe); errors are isolated per hook group and
 * the sweep itself never throws.
 *
 * P3 (v1#1) lanes, in order:
 *   (a)  stale-'delivering' reclaim (unchanged);
 *   (a2) DISABLED-hook rows → terminal 'skipped:hook_disabled' — a paused
 *        hook's backlog must not clog the shared batch (it used to stay
 *        pending forever and starve live hooks). Visible terminal status,
 *        never a silent drop. NOTE this supersedes the old "re-enable drains
 *        the backlog" contract: a re-enabled hook resumes with NEW events;
 *        the skipped rows stay auditable in the table.
 *   (a3) 24h retry-horizon dead-letter: pending rows older than
 *        RETRY_HORIZON_MS flip to 'failed:horizon' + owner death notice —
 *        parked rows (busy targets) are bounded, never immortal.
 *   (b)  fairness scan/selection (selectFairBatch) — alarm-class first, then
 *        per-hook round-robin; rows TTL-parked with a future retryAt are
 *        skipped.
 */
export interface HookSweepOptions {
  /** Emission-time kick: only rows of these hooks (poll-path housekeeping skipped). */
  hookIds?: string[];
  /** Run-finalize drain: only rows targeting this chat (housekeeping skipped). */
  targetChatId?: string;
  /** With targetChatId: deliver busy-parked rows too (retryAt in the future) — the target is idle NOW. */
  ignoreRetryAt?: boolean;
}

export async function sweepHookEvents(opts: HookSweepOptions = {}): Promise<void> {
  // Retiring colour (2026-09-18): a draining backend never claims hook rows —
  // neither on its 30 s tick nor on the emission kicks / finalize drains its
  // own finishing runs fire (those used to claim → be refused by the retiring
  // gate → park the row 3 min while the new colour sat idle). The new colour's
  // sweeper picks every row up on its next tick. See schedule.service
  // sweepTickBody for the measured cost.
  if (isRetiring()) return;
  const targeted = !!(opts.hookIds?.length || opts.targetChatId);
  try {
    if (!targeted) {
    // (a) Reclaim rows stuck 'delivering' (a crash/restart mid-delivery).
    await prisma.hookEvent.updateMany({
      where: { status: 'delivering', updatedAt: { lt: new Date(Date.now() - STALE_DELIVERING_MS) } },
      data: { status: 'pending' },
    }).catch((err: any) => logger.warn(`hook sweep: stale-delivering reclaim failed: ${err?.message}`));

    // (a2) Disabled-hook rows → terminal, visible, out of the shared batch.
    await prisma.hookEvent.updateMany({
      where: { status: 'pending', hook: { enabled: false } },
      data: { status: 'skipped:hook_disabled' },
    }).then((r: any) => {
      if (r?.count > 0) logger.info(`hook sweep: marked ${r.count} pending event(s) of disabled hooks 'skipped:hook_disabled'`);
    }).catch((err: any) => logger.warn(`hook sweep: disabled-hook skip failed: ${err?.message}`));

    // (a3) Retry-horizon dead-letter — visible, owner-noticed, never silent.
    try {
      const horizonCutoff = new Date(Date.now() - RETRY_HORIZON_MS);
      const dead = await prisma.hookEvent.findMany({
        where: { status: 'pending', createdAt: { lt: horizonCutoff } },
        orderBy: { createdAt: 'asc' },
        take: 100,
      });
      if (dead.length) {
        await prisma.hookEvent.updateMany({
          where: { id: { in: dead.map((r: any) => r.id) } },
          data: { status: 'failed:horizon' },
        });
        logger.warn(`hook sweep: ${dead.length} pending event(s) crossed the ${Math.round(RETRY_HORIZON_MS / 3600000)}h retry horizon — dead-lettered 'failed:horizon'`);
        await notifyHookDeaths(dead, 'retry horizon (24h) exhausted', 'horizon');
      }
    } catch (err: any) {
      logger.warn(`hook sweep: retry-horizon pass failed: ${err?.message}`);
    }
    } // end poll-path housekeeping (targeted kicks skip it — the 30 s sweeper owns it)

    // (b) Scan + fair selection, grouped by hook (creation order preserved in-group).
    const now = new Date();
    const retryFilter = opts.ignoreRetryAt ? {} : { OR: [{ retryAt: null }, { retryAt: { lte: now } }] };
    const targetFilter = {
      ...(opts.hookIds?.length ? { hookId: { in: opts.hookIds } } : {}),
      ...(opts.targetChatId ? { hook: { enabled: true, targetChatId: opts.targetChatId } } : {}),
    };
    let scan = await prisma.hookEvent.findMany({
      where: { status: 'pending', ...(opts.targetChatId ? {} : { hook: { enabled: true } }), ...retryFilter, ...targetFilter },
      orderBy: { createdAt: 'asc' },
      take: SWEEP_SCAN,
    });
    // audit 2026-10-06 T3-1: the run-finalize drain ignores the BUSY-park
    // retryAt (the chat is idle now) — never a TRIAGE park's: a held park only
    // rides a group a non-parked row starts (window / sibling drain).
    // FLEET-PS-FIRST: nor a held PS escalation's (its hold is the project
    // supervisor's window, not a busy park). LANE-IDLE-WAKE: a delayed direct
    // wake (payload.notBefore) is never due before its time, busy-park drain or not.
    if (opts.ignoreRetryAt && scan?.length) scan = scan.filter((r: any) => !isHeldTriagePark(r, now.getTime()) && !isHeldPsEscalation(r, now.getTime()) && !hookRowNotYetDue(r, now.getTime()));
    if (!scan?.length) return;
    const rows = selectFairBatch(scan);
    const groups = new Map<string, any[]>();
    for (const row of rows) {
      const g = groups.get(row.hookId);
      if (g) g.push(row);
      else groups.set(row.hookId, [row]);
    }

    // (c) Deliver each group sequentially — per-group errors are caught inside.
    // In-group creation order is restored explicitly: the alarm-first fair
    // batch can interleave one hook's rows out of createdAt order.
    for (const [hookId, group] of groups) {
      group.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
      await deliverHookGroup(hookId, group).catch((err: any) =>
        logger.warn(`hook sweep: group ${hookId.slice(0, 8)} failed: ${err?.message}`),
      );
    }
  } catch (err: any) {
    logger.warn(`hook sweep error: ${err?.message}`);
  }
}

/* ── Subscription management (slice C tools call these) ────────────────────── */

/** Owner-or-write check on BOTH chats (mirrors autonomy.service's access pattern). */
async function requireChatWriteAccess(userId: string, chatId: string, label: string): Promise<void> {
  const { access, exists } = await crossModelService.getChatAccess(chatId, userId);
  if (!exists) throw new AppError(404, `${label} chat not found`);
  if (access !== 'owner' && access !== 'write') {
    throw new AppError(
      access === 'none' ? 404 : 403,
      access === 'none' ? `${label} chat not found` : `You need write access to the ${label.toLowerCase()} chat`,
    );
  }
}

/**
 * The (source, target) pair lookup for subscribeHook's dedup (ticket
 * c65de47c) — the same findFirst shape the internal lanes self-dedup with
 * (ensureChildResultHook / enqueueDirectWake). sourceChatId null = the
 * wildcard is matched EXPLICITLY (Prisma `null` → IS NULL), and the two
 * NULL-source lanes are kept apart by projectId: an owner-scope wildcard
 * (projectId null) never steals a project-scope hook's row or vice versa —
 * they are different source sets with their own partial unique indexes.
 * A SPECIFIC pair always has projectId null (validated above), so it needs
 * no projectId term.
 */
function hookPairWhere(userId: string, sourceChatId: string | null, targetChatId: string, projectId: string | null) {
  return {
    userId, sourceChatId, targetChatId,
    ...(sourceChatId ? {} : { projectId: projectId ?? null }),
  };
}

/**
 * Subscribe targetChatId to sourceChatId's events — or, when sourceChatId is
 * omitted/empty/null, to EVERY chat the user owns (the owner-scope WILDCARD,
 * the fleet-supervisor pattern; stored as sourceChatId NULL, so chats created
 * later are covered automatically). Validates: target writable by the caller
 * (the source too, for a SPECIFIC hook — a wildcard has no single source to
 * check; its userId scopes emission/delivery instead), eventTypes a non-empty
 * subset of HOOK_EVENT_TYPES, debounceSec clamped 0..3600. A SPECIFIC source
 * may not equal the target (self-hooks never deliver); a wildcard targeting
 * its own would-be source is allowed — emission suppresses that self-loop.
 */
export async function subscribeHook(opts: {
  userId: string;
  sourceChatId?: string | null;
  targetChatId: string;
  eventTypes: string[];
  promptTemplate?: string;
  debounceSec?: number;
  /** PROJECT-SCOPE hook: scope an owner-wildcard hook to ONE project. Only
   *  valid with sourceChatId null; the project must exist and belong to
   *  userId. Callers: the project-supervisor lane, the hook_subscribe tool
   *  (T3a 2026-09-24) and POST /platform/hooks (WI-E 2026-09-25). */
  projectId?: string | null;
  /** Creator provenance (ticket dd3a19fa): stamped on CREATE only — a pair-
   *  dedup rewire keeps the row's original creator (the rewire itself is
   *  audited via the hook.subscribe Activity row). All three optional; rows
   *  predating the columns stay unprovenanced (null). */
  createdVia?: string | null;
  createdByChatId?: string | null;
  createdByRunId?: string | null;
}): Promise<EventHookView> {
  const { userId } = opts;
  const rawSource = String(opts.sourceChatId ?? '').trim();
  const sourceChatId = rawSource || null; // null = owner-scope WILDCARD
  const targetChatId = String(opts.targetChatId ?? '');
  if (!targetChatId) throw new AppError(400, 'targetChatId is required');
  if (sourceChatId && sourceChatId === targetChatId) throw new AppError(400, 'sourceChatId and targetChatId must differ — a chat cannot subscribe to itself');

  // Project-scope lane (internal): a wildcard scoped to ONE project. The
  // project must exist and be OWNED by the hook's user (emission + delivery
  // re-check same-owner per source chat against this userId).
  const projectId = String(opts.projectId ?? '').trim() || null;
  if (projectId) {
    if (sourceChatId) throw new AppError(400, 'projectId requires a wildcard hook (sourceChatId must be null)');
    const proj = await prisma.crossModelProject.findUnique({ where: { id: projectId }, select: { userId: true } }).catch(() => null);
    if (!proj || proj.userId !== userId) throw new AppError(404, 'Project not found or not owned by this user');
  }

  // eventTypes ⊆ HOOK_EVENT_TYPES, non-empty (deduped, order-stable).
  const valid = new Set<string>(HOOK_EVENT_TYPES);
  const eventTypes: string[] = [];
  for (const raw of opts.eventTypes ?? []) {
    const t = String(raw);
    if (!valid.has(t)) {
      throw new AppError(400, `Invalid event type "${t}" — eventTypes must be a subset of: ${HOOK_EVENT_TYPES.join(', ')}`);
    }
    if (!eventTypes.includes(t)) eventTypes.push(t);
  }
  if (!eventTypes.length) {
    throw new AppError(400, `eventTypes must be a non-empty subset of: ${HOOK_EVENT_TYPES.join(', ')}`);
  }

  let debounceSec: number | undefined;
  if (opts.debounceSec !== undefined && opts.debounceSec !== null) {
    const n = Number(opts.debounceSec);
    if (!Number.isFinite(n)) throw new AppError(400, 'debounceSec must be a number (0..3600)');
    debounceSec = Math.min(MAX_DEBOUNCE_SEC, Math.max(0, Math.round(n)));
  }

  // A SPECIFIC source must be writable by the caller. A WILDCARD skips that
  // check — there is no single source chat; the hook's userId scopes which
  // chats emit into it (emission filters same-owner, delivery re-checks
  // ownership per source chat and drops deleted/foreign rows).
  if (sourceChatId) await requireChatWriteAccess(userId, sourceChatId, 'Source');
  await requireChatWriteAccess(userId, targetChatId, 'Target');

  // Pair dedup (ticket c65de47c): ONE hook per (source, target) pair — a
  // double-wire used to wake the target TWICE per event (doubled machine
  // runs, doubled budget burn). An existing pair row is UPDATED IN PLACE
  // with the fresh request's values and returned with deduped:true; the
  // event_hooks_one_hook_per_pair unique index backs the race (P2002 →
  // converge on the winner's row below).
  const pairWhere = hookPairWhere(userId, sourceChatId, targetChatId, projectId);
  const rewireExisting = async (existingId: string): Promise<EventHookView> => {
    const row = await prisma.eventHook.update({
      where: { id: existingId },
      data: {
        eventTypes,
        promptTemplate: String(opts.promptTemplate ?? '').slice(0, 8000),
        // Mirror fresh-create semantics: an omitted debounceSec resets to the
        // model default — re-subscribing means "make the wiring look like
        // THIS request". lastFiredAt (the debounce anchor) is kept.
        debounceSec: debounceSec !== undefined ? debounceSec : DEFAULT_DEBOUNCE_SEC,
        // A fresh subscribe is an AFFIRMATIVE wire request: a previously
        // disabled (paused) hook is re-armed, not duplicated.
        enabled: true,
      },
    });
    logger.info(
      `hook ${row.id.slice(0, 8)}: re-subscribe deduped — chat ${targetChatId.slice(0, 8)} updated in place to [${eventTypes.join(', ')}] from ${sourceChatId ? sourceChatId.slice(0, 8) : projectId ? `project ${projectId.slice(0, 8)}` : 'wildcard'} (user ${userId.slice(0, 8)})`,
    );
    await audit(userId, 'hook.subscribe', { hookId: row.id, sourceChatId, targetChatId, eventTypes, ...(projectId ? { projectId } : {}), deduped: true });
    return { ...toView(row), deduped: true };
  };

  const existing = await prisma.eventHook.findFirst({ where: pairWhere });
  if (existing) return rewireExisting(existing.id);

  let row;
  try {
    row = await prisma.eventHook.create({
      data: {
        userId, sourceChatId, targetChatId, eventTypes,
        ...(projectId ? { projectId } : {}),
        promptTemplate: String(opts.promptTemplate ?? '').slice(0, 8000),
        ...(debounceSec !== undefined ? { debounceSec } : {}),
        // Creator provenance (ticket dd3a19fa) — stamped ONCE here; the
        // rewireExisting path deliberately does NOT overwrite it (the original
        // creator stays on the row; the rewire rides the Activity audit).
        ...(opts.createdVia ? { createdVia: String(opts.createdVia).slice(0, 64) } : {}),
        ...(opts.createdByChatId ? { createdByChatId: String(opts.createdByChatId) } : {}),
        ...(opts.createdByRunId ? { createdByRunId: String(opts.createdByRunId) } : {}),
      },
    });
  } catch (err: any) {
    // P2002 (event_hooks_one_hook_per_pair, or the wildcard/project partial
    // unique indexes): a racing subscribe won the create between our lookup
    // and insert — converge on the winner's row exactly like a pre-create
    // hit (the supervisor lanes' find-then-create idiom). Any other unique
    // violation rethrows.
    if (err?.code !== 'P2002') throw err;
    const winner = await prisma.eventHook.findFirst({ where: pairWhere });
    if (!winner) throw err;
    return rewireExisting(winner.id);
  }
  logger.info(
    `hook ${row.id.slice(0, 8)}: subscribed chat ${targetChatId.slice(0, 8)} to [${eventTypes.join(', ')}] from ${sourceChatId ? sourceChatId.slice(0, 8) : projectId ? `project ${projectId.slice(0, 8)}` : 'wildcard'} (user ${userId.slice(0, 8)})`,
  );
  await audit(userId, 'hook.subscribe', {
    hookId: row.id, sourceChatId, targetChatId, eventTypes,
    ...(projectId ? { projectId } : {}),
    ...(opts.createdVia ? { createdVia: String(opts.createdVia).slice(0, 64) } : {}),
    ...(opts.createdByChatId ? { createdByChatId: String(opts.createdByChatId) } : {}),
    ...(opts.createdByRunId ? { createdByRunId: String(opts.createdByRunId) } : {}),
  });
  return toView(row);
}

// ── Sub-sessions (2026-09-02): auto result-hook at spawn ─────────────────────

/** The events a parent chat is auto-subscribed to on its spawned children. */
export const CHILD_RESULT_EVENT_TYPES: HookEventType[] = ['run_completed', 'run_failed', 'attention_needed'];

/** Wake prompt for the auto-created child→parent result hook. Parent-flavored:
 *  the DEFAULT template addresses a fleet supervisor, which the parent is not —
 *  it is the session that spawned the work and wants the result back. */
export const CHILD_RESULT_PROMPT_TEMPLATE =
  // Hardening 2026-09-14: the child's chat id rides the wake — "get_chat_status
  // on that session" with no id was the same invented-id defect class as the
  // default template (see DEFAULT_PROMPT_TEMPLATE).
  'Your sub-session "{{sourceChatTitle}}" (chat id {{sourceChatId}}) reported {{eventType}}: {{summary}}\n\n' +
  '[Autonomous parent wake — no user is on this turn. This chat SPAWNED that session: harvest its result ' +
  '(get_chat_messages / get_chat_status), fold it into your own work, and steer or answer the sub-session ' +
  'if it needs input. Keep it brief.]';

/**
 * The PRE-2026-09-14 child-result template (wired by ensureChildResultHook from
 * 60ad0549a, 2026-09-02, until 62173bd6e added the chat-id parenthetical).
 * Prod 2026-09-24: 34 enabled hooks still carry this string (all createdVia
 * NULL — pre-provenance 6600c1b14), e.g. six on the Fleet Supervisor's target
 * c0e22e36. Every exact `=== CHILD_RESULT_PROMPT_TEMPLATE` site must treat
 * BOTH strings as the child-result contract — the 9df506cc F1 legacy exemption
 * compared against the NEW string only, so the very hooks it was written to
 * exempt (old template, createdVia NULL) failed its signature check and stayed
 * pauseable by the retired-target sweep; the 72a01d94 sibling-drain exclusion
 * had the same hole (legacy child-result rows would merge into a fleet digest).
 */
export const LEGACY_CHILD_RESULT_PROMPT_TEMPLATE =
  'Your sub-session "{{sourceChatTitle}}" reported {{eventType}}: {{summary}}\n\n' +
  '[Autonomous parent wake — no user is on this turn. This chat SPAWNED that session: harvest its result ' +
  '(get_chat_messages / get_chat_status), fold it into your own work, and steer or answer the sub-session ' +
  'if it needs input. Keep it brief.]';

/** True when the template is ANY generation of the auto-wired child→parent
 *  result-hook contract (current or legacy — see LEGACY_CHILD_RESULT_PROMPT_TEMPLATE). */
export function isChildResultTemplate(tmpl: unknown): boolean {
  const s = String(tmpl ?? '');
  return s === CHILD_RESULT_PROMPT_TEMPLATE || s === LEGACY_CHILD_RESULT_PROMPT_TEMPLATE;
}

/**
 * Auto result-hook at sub-session spawn (sub-session promotion, piece 2):
 * subscribe the PARENT chat to its CHILD's terminal/attention events so
 * results flow back without polling. COMPOSES the existing machinery —
 * subscribeHook keeps all validation/audit/logging; this helper adds only
 *   (a) the DEDUPE: any existing child→parent hook of this owner wins —
 *       including one the user narrowed deliberately — so a duplicate spawn
 *       call can never double-wire a wake; and
 *   (b) the SELF-HEAL (ticket 9df506cc F1, 2026-09-20): an existing hook that
 *       is PAUSED is re-enabled in place — a dead result hook is a silently
 *       lost verdict (e.g. a legacy createdVia-NULL hook auto-paused by the
 *       retired-target sweep, ticket 57154856, while the parent owned no live
 *       work; the spawn that reaches this line IS proof the parent is active
 *       again). Idempotent: an already-enabled hook is untouched; and
 *   (c) the never-throw contract: hook wiring failing must not fail the spawn
 *       that requested it (the caller degrades to "poll get_chat_status").
 * Returns the existing-or-created hook view, or null when wiring failed.
 */
export async function ensureChildResultHook(opts: {
  userId: string;
  parentChatId: string;
  childChatId: string;
}): Promise<EventHookView | null> {
  const { userId, parentChatId, childChatId } = opts;
  try {
    if (!userId || !parentChatId || !childChatId || parentChatId === childChatId) return null;
    const existing = await prisma.eventHook.findFirst({
      where: { userId, sourceChatId: childChatId, targetChatId: parentChatId },
    });
    if (existing) {
      // Self-heal (b): a paused child→parent hook is a dead verdict-wait path —
      // re-enable it idempotently so the new child's result can never be
      // silently dropped. userId is pinned in the WHERE so ownership drift
      // can never re-arm another account's hook.
      if (!existing.enabled) {
        const revived = await prisma.eventHook.update({
          where: { id: existing.id },
          data: { enabled: true },
        });
        logger.info(
          `hooks: child result-hook ${String(existing.id).slice(0, 8)} re-enabled at spawn (was paused) — verdict-wait path restored (child ${String(childChatId).slice(0, 8)} → parent ${String(parentChatId).slice(0, 8)})`,
        );
        return toView(revived);
      }
      return toView(existing); // dedupe — the pair is already wired
    }
    return await subscribeHook({
      userId,
      sourceChatId: childChatId,
      targetChatId: parentChatId,
      eventTypes: [...CHILD_RESULT_EVENT_TYPES],
      promptTemplate: CHILD_RESULT_PROMPT_TEMPLATE,
      createdVia: 'system:child-result-hook',
      createdByChatId: parentChatId,
    });
  } catch (err: any) {
    logger.warn(
      `hooks: child result-hook wiring failed (child ${String(childChatId).slice(0, 8)} → parent ${String(parentChatId).slice(0, 8)}): ${err?.message}`,
    );
    return null;
  }
}

// ── Direct wakes (v1#7 — durable todo-unblock wake) ──────────────────────────

/**
 * Enqueue ONE durable wake for a target chat through the hook outbox — the
 * fire-and-forget alternative paths (goals.service wakeTodoAssignee's direct
 * fireScheduleTarget) LOST the wake whenever the target was busy or capped.
 * Mechanism: a per-chat SYSTEM self-hook (source == target, eventTypes
 * [TODO_WAKE_EVENT_TYPE], promptTemplate '{{summary}}') carries a directly
 * inserted outbox row whose summary IS the wake prompt. Nothing ever EMITS
 * todo_wake (it is not in HOOK_EVENT_TYPES), so the self-hook can never catch
 * organic events; delivery, busy-park (alarm-class ⇒ attempts frozen),
 * cap-bypass, 24h horizon and death notices all ride the standard sweep.
 * Returns { ok:false } instead of throwing — the caller releases its debounce
 * gate when nothing was actually enqueued.
 *
 * `notBefore` (LANE-IDLE-WAKE, 2026-10-20): a FUTURE time makes the row a
 * delayed wake — inserted with retryAt = notBefore and payload.notBefore, so
 * nothing delivers it early (hookRowNotYetDue). A past / invalid value is
 * ignored (an ordinary immediate wake).
 */
export async function enqueueDirectWake(opts: {
  targetChatId: string;
  prompt: string;
  meta?: Record<string, unknown>;
  /**
   * Hold the row until this instant: retryAt = notBefore (the sweep never
   * claims it earlier) and payload.notBefore (no drain lets it ride early —
   * hookRowNotYetDue). Past/absent = immediately sweepable. Used by
   * FLEET-PS-FIRST escalations and LANE-IDLE-WAKE (2026-10-20).
   */
  notBefore?: Date | null;
}): Promise<{ ok: boolean; hookEventId?: string; error?: string }> {
  try {
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: opts.targetChatId },
      select: { userId: true, title: true },
    });
    if (!chat) return { ok: false, error: 'target chat not found' };
    let hook = await prisma.eventHook.findFirst({
      where: {
        userId: chat.userId,
        sourceChatId: opts.targetChatId,
        targetChatId: opts.targetChatId,
        eventTypes: { has: TODO_WAKE_EVENT_TYPE },
      },
    });
    if (!hook) {
      try {
        hook = await prisma.eventHook.create({
          data: {
            userId: chat.userId,
            sourceChatId: opts.targetChatId,
            targetChatId: opts.targetChatId,
            eventTypes: [TODO_WAKE_EVENT_TYPE],
            promptTemplate: '{{summary}}',
            debounceSec: 0,
            createdVia: 'system:direct-wake',
          },
        });
      } catch (err: any) {
        // event_hooks_one_hook_per_pair (ticket c65de47c) made this find-
        // then-create racable: a concurrent direct-wake ensure for the same
        // chat won — converge on the winner's row instead of losing the wake.
        if (err?.code !== 'P2002') throw err;
        hook = await prisma.eventHook.findFirst({
          where: {
            userId: chat.userId,
            sourceChatId: opts.targetChatId,
            targetChatId: opts.targetChatId,
            eventTypes: { has: TODO_WAKE_EVENT_TYPE },
          },
        });
        if (!hook) throw err;
      }
    } else if (hook.enabled === false) {
      // A disabled direct-wake hook would silently terminal-skip every row
      // (sweep lane a2) — re-enable it; this hook is framework plumbing, not
      // a user subscription.
      await prisma.eventHook.update({ where: { id: hook.id }, data: { enabled: true } }).catch(() => {});
    }
    const notBefore = opts.notBefore instanceof Date && Number.isFinite(opts.notBefore.getTime()) && opts.notBefore.getTime() > Date.now()
      ? opts.notBefore
      : null;
    const payload: HookEventPayload = {
      ...(opts.meta ?? {}),
      eventType: TODO_WAKE_EVENT_TYPE,
      sourceChatId: opts.targetChatId,
      sourceChatTitle: chat.title ?? '',
      // audit 2026-10-06 T3-3: direct wakes quote owner / lane text too.
      summary: truncateSummary(redactHookSummary(opts.prompt)),
      depth: await depthForChat(opts.targetChatId),
      ...(notBefore ? { notBefore: notBefore.toISOString() } : {}),
    };
    // KPI ledger (4e36ee4a): the direct-wake lane bypasses emitHookEvent, so
    // it counts itself — the emission here, the single-row fan-out after the
    // create below succeeds.
    noteFleetEventEmitted(TODO_WAKE_EVENT_TYPE);
    const row = await prisma.hookEvent.create({
      data: { hookId: hook.id, userId: chat.userId, eventType: TODO_WAKE_EVENT_TYPE, payload: payload as unknown as object, ...(notBefore ? { retryAt: notBefore } : {}) },
    });
    noteFleetEventDelivered(TODO_WAKE_EVENT_TYPE, 1);
    logger.info(`hooks: direct wake enqueued for chat ${opts.targetChatId.slice(0, 8)} (event ${String(row.id).slice(0, 8)})${notBefore ? ` — held until ${notBefore.toISOString()}` : ''}`);
    return { ok: true, hookEventId: row.id };
  } catch (err: any) {
    logger.warn(`hooks: direct wake enqueue failed for chat ${String(opts.targetChatId).slice(0, 8)}: ${err?.message}`);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** FLEET-PS-FIRST: the per (Fleet chat × project) escalation lock (serializes find → append / create across processes). */
const PS_ESCALATION_LOCK_KEY = (fleetChatId: string, projectId: string) => `hookps:esc:${fleetChatId}:${projectId}`;
const PS_ESCALATION_LOCK_TTL_MS = 10_000;
/** How long an emission waits for a held lock before proceeding unlocked (the CAS still guards the append). */
export const PS_ESCALATION_LOCK_WAIT_MS = 2_000;
const PS_ESCALATION_LOCK_POLL_MS = 100;

/** Take the escalation lock (SET NX PX, polled ≤ PS_ESCALATION_LOCK_WAIT_MS). Null = not held (timeout / Redis error). Never throws. */
async function acquirePsEscalationLock(key: string): Promise<string | null> {
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const deadline = Date.now() + PS_ESCALATION_LOCK_WAIT_MS;
  try {
    for (;;) {
      if ((await redisClient.set(key, token, { NX: true, PX: PS_ESCALATION_LOCK_TTL_MS })) === 'OK') return token;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, PS_ESCALATION_LOCK_POLL_MS));
    }
  } catch {
    return null;
  }
}

/** Release only our own lock (a lock that expired and was re-taken is left alone). Never throws. */
async function releasePsEscalationLock(key: string, token: string | null): Promise<void> {
  if (!token) return;
  try {
    if ((await redisClient.get(key)) === token) await redisClient.del(key);
  } catch { /* the TTL frees it */ }
}

/**
 * FLEET-PS-FIRST (2026-10-20; platform/fleet-ps-first.ts): hold ONE delayed
 * escalation per (Fleet Supervisor chat × project). A second alarm from the
 * same project while the row is still HELD (pending, retryAt in the future) is
 * appended to it. Two guards keep concurrent alarms (two lanes failing in the
 * same second, two backend instances) from losing one: a short Redis lock per
 * (Fleet chat × project) serializes the find → append / create, and the append
 * is a CAS on status 'pending' AND the stored psEscalation.count (a lost race
 * re-reads once; a row a sweep already claimed is never rewritten — the alarm
 * then opens a fresh row, never dropped). A lock that cannot be taken in
 * PS_ESCALATION_LOCK_WAIT_MS (or a Redis error) proceeds unlocked. A new row
 * is a direct wake with notBefore = now + PS_ESCALATION_DELAY_MS. Alarm
 * summaries arrive already redacted (the emission's safeSummary); the rendered
 * prompt is redacted again by enqueueDirectWake. Never throws — { ok:false }
 * makes the caller write the Fleet's row at once.
 */
export async function holdPsEscalation(opts: {
  fleetChatId: string;
  projectId: string;
  psChatIds: string[];
  alarm: PsEscalationAlarm;
}): Promise<{ ok: boolean; mode?: 'held' | 'appended'; hookEventId?: string; error?: string }> {
  const lockKey = PS_ESCALATION_LOCK_KEY(opts.fleetChatId, opts.projectId);
  let lock: string | null = null;
  try {
    lock = await acquirePsEscalationLock(lockKey);
    const now = new Date();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const open = await prisma.hookEvent.findFirst({
        where: {
          status: 'pending',
          eventType: TODO_WAKE_EVENT_TYPE,
          retryAt: { gt: now },
          hook: { targetChatId: opts.fleetChatId },
          payload: { path: ['psEscalation', 'projectId'], equals: opts.projectId },
        },
        orderBy: { createdAt: 'desc' },
      }).catch(() => null);
      const prev = open ? readPsEscalation(open.payload) : null;
      if (!open || !prev) break;
      const meta = appendPsEscalation(prev, opts.alarm, opts.psChatIds);
      const payload = { ...(open.payload as Record<string, unknown>), psEscalation: meta, summary: truncateSummary(redactHookSummary(renderPsEscalationPrompt(meta))) };
      const storedCount = (open.payload as any)?.psEscalation?.count;
      const where = {
        id: open.id,
        status: 'pending',
        ...(typeof storedCount === 'number' && Number.isFinite(storedCount) ? { payload: { path: ['psEscalation', 'count'], equals: storedCount } } : {}),
      };
      const upd = await prisma.hookEvent.updateMany({ where, data: { payload: payload as unknown as object } })
        .catch(() => ({ count: 0 }));
      if ((upd?.count ?? 0) > 0) return { ok: true, mode: 'appended', hookEventId: open.id };
    }
    let projectName: string | null = null;
    try {
      const proj = await prisma.crossModelProject.findUnique({ where: { id: opts.projectId }, select: { name: true } });
      projectName = proj?.name ?? null;
    } catch { projectName = null; }
    const meta = newPsEscalation({ projectId: opts.projectId, projectName, psChatIds: opts.psChatIds, alarm: opts.alarm });
    const res = await enqueueDirectWake({
      targetChatId: opts.fleetChatId,
      prompt: renderPsEscalationPrompt(meta),
      meta: { origin: PS_ESCALATION_ORIGIN, psEscalation: meta },
      notBefore: new Date(now.getTime() + PS_ESCALATION_DELAY_MS),
    });
    return res.ok ? { ok: true, mode: 'held', hookEventId: res.hookEventId } : { ok: false, error: res.error ?? 'enqueue failed' };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    await releasePsEscalationLock(lockKey, lock);
  }
}

/**
 * FLEET-PS-FIRST delivery revalidation (one group): every escalation row is
 * re-judged against its project supervisors' high-water marks
 * (psEscalationVerdict). 'handled' ⇒ terminal 'skipped:ps_handled';
 * 'rehold' ⇒ back to pending with the later retryAt (the PS still has its
 * window for a newer alarm, or a PS wake that started after the alarm is
 * still running — read only when the row would otherwise escalate before its
 * cap); 'escalate' ⇒ the row stays in the group with its prompt re-rendered
 * (revalidated wording) to the unhandled alarms only. The escalation is
 * stamped once (payload.psEscalation.escalatedAt + the re-rendered summary,
 * persisted): a busy Fleet re-parks the row and the 30 s sweeper re-claims it
 * every tick, so the 'escalated' metric is recorded only on the stamping pass
 * (the re-check itself repeats on purpose — a PS that handles the alarms
 * while the Fleet is busy still drops the row). A mark read error counts as
 * no mark (⇒ escalate); the kill switch delivers every row untouched. Returns
 * the surviving rows. Never throws.
 */
export async function revalidatePsEscalations(hookId: string, targetChatId: string, rows: any[], now: Date = new Date()): Promise<any[]> {
  if (fleetAlarmPsFirstDisabled() || !rows.some((r) => readPsEscalation(r?.payload))) return rows;
  const out: any[] = [];
  const nowMs = now.getTime();
  const marks = new Map<string, PsMark | null>();
  const markOf = async (psChatId: string): Promise<PsMark | null> => {
    if (marks.has(psChatId)) return marks.get(psChatId) ?? null;
    let m: PsMark | null = null;
    try { m = typeof readWakeHighWaterMark === 'function' ? await readWakeHighWaterMark(psChatId, now) : null; } catch { m = null; }
    marks.set(psChatId, m);
    return m;
  };
  const inflight = new Map<string, number>();
  const inflightOf = async (psChatId: string): Promise<number> => {
    if (inflight.has(psChatId)) return inflight.get(psChatId) as number;
    let ms = NaN;
    try {
      const at = typeof readInflightMachineWakeStart === 'function' ? await readInflightMachineWakeStart(psChatId) : null;
      ms = at instanceof Date ? at.getTime() : NaN;
    } catch { ms = NaN; }
    inflight.set(psChatId, ms);
    return ms;
  };
  for (const r of rows) {
    const meta = readPsEscalation(r?.payload);
    if (!meta) { out.push(r); continue; }
    try {
      const markList = await Promise.all(meta.psChatIds.map(markOf));
      let v = psEscalationVerdict(meta, markList, nowMs);
      if (v.action === 'escalate' && psEscalationCapMs(meta) > nowMs && meta.psChatIds.length) {
        const starts = (await Promise.all(meta.psChatIds.map(inflightOf))).filter((x) => Number.isFinite(x));
        if (starts.length) v = psEscalationVerdict(meta, markList, nowMs, { inflightStartMs: Math.max(...starts) });
      }
      const base = { projectId: meta.projectId, psChatIds: meta.psChatIds, alarms: meta.count, handled: v.handled, hookEventId: r.id, hookId };
      const rawPayload = (r.payload && typeof r.payload === 'object' ? r.payload : {}) as Record<string, any>;
      const rawEsc = (rawPayload.psEscalation && typeof rawPayload.psEscalation === 'object' ? rawPayload.psEscalation : {}) as Record<string, unknown>;
      if (v.action === 'handled') {
        await prisma.hookEvent.updateMany({ where: { id: r.id }, data: { status: HOOK_STATUS_PS_HANDLED } }).catch(() => {});
        logger.info(`hook ${hookId.slice(0, 8)}: PS escalation ${String(r.id).slice(0, 8)} for chat ${targetChatId.slice(0, 8)} skipped — the project supervisor completed a wake after all ${v.handled} alarm(s)`);
        recordLoopMetric({ kind: PS_ESCALATION_METRIC_KIND, sessionId: targetChatId, value: 1, meta: { ...base, phase: 'ps_handled' } });
        continue;
      }
      if (v.action === 'rehold') {
        // A re-held row that had escalated before loses its stamp: its next escalation is a new one.
        const { escalatedAt: _was, ...unstamped } = rawEsc;
        const data = meta.escalatedAt
          ? { status: 'pending', retryAt: v.until, payload: { ...rawPayload, psEscalation: unstamped } as unknown as object }
          : { status: 'pending', retryAt: v.until };
        await prisma.hookEvent.updateMany({ where: { id: r.id }, data }).catch(() => {});
        recordLoopMetric({ kind: PS_ESCALATION_METRIC_KIND, sessionId: targetChatId, value: 1, meta: { ...base, phase: 'rehold', reason: v.reason, until: v.until.toISOString() } });
        continue;
      }
      const summary = truncateSummary(redactHookSummary(renderPsEscalationPrompt(meta, { alarms: v.unhandled, revalidated: true, inflight: v.inflight })));
      const payload = { ...rawPayload, summary, psEscalation: { ...rawEsc, escalatedAt: meta.escalatedAt ?? now.toISOString() } };
      if (!meta.escalatedAt) {
        await prisma.hookEvent.updateMany({ where: { id: r.id }, data: { payload: payload as unknown as object } }).catch(() => {});
        recordLoopMetric({ kind: PS_ESCALATION_METRIC_KIND, sessionId: targetChatId, value: 1, meta: { ...base, phase: 'escalated', unhandled: v.unhandled.length, psMarkAt: v.psMarkAt, inflight: v.inflight, heldMin: Math.round((nowMs - Date.parse(meta.firstAt)) / 60_000) } });
      }
      out.push({ ...r, payload });
    } catch (err: any) {
      logger.warn(`hook ${hookId.slice(0, 8)}: PS escalation revalidation failed for ${String(r?.id ?? '').slice(0, 8)} (${err?.message ?? err}) — delivering it as-is`);
      out.push(r);
    }
  }
  return out;
}

// ── Preempted-wake redelivery (spark B21) ─────────────────────────────────────

/** How far back a preemption looks for the delivered rows that woke the run. */
export const PREEMPT_REDELIVERY_LOOKBACK_MS = 15 * 60 * 1000;

/**
 * A machine wake preempted by a user message finalizes as if it completed —
 * but the hook events that woke it were consumed ('delivered') by a run that
 * never did the work. Requeue them ONCE: recent delivered rows targeting this
 * chat flip back to 'pending' with payload.preemptRequeued = true (the
 * once-guard — a second preemption of the redelivered wake lets it die
 * normally instead of ping-ponging). Schedule firings need no analogue (the
 * cadence re-fires on its own). Never throws; returns the requeued count.
 */
export async function requeuePreemptedHookEvents(targetChatId: string): Promise<number> {
  try {
    const rows = await prisma.hookEvent.findMany({
      where: {
        status: 'delivered',
        updatedAt: { gte: new Date(Date.now() - PREEMPT_REDELIVERY_LOOKBACK_MS) },
        hook: { targetChatId },
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    let requeued = 0;
    for (const r of rows) {
      const payload = (r.payload ?? {}) as Record<string, unknown>;
      if (payload.preemptRequeued === true) continue; // already redelivered once
      const flip = await prisma.hookEvent.updateMany({
        where: { id: r.id, status: 'delivered' },
        data: { status: 'pending', retryAt: null, payload: { ...payload, preemptRequeued: true } as unknown as object },
      }).catch(() => ({ count: 0 }));
      requeued += flip.count;
    }
    if (requeued > 0) {
      logger.info(`hooks: requeued ${requeued} delivered event(s) for preempted machine run in chat ${targetChatId.slice(0, 8)}`);
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.WAKE_PARKED, sessionId: targetChatId, value: requeued, meta: { reason: 'preempted_redelivery' } });
    }
    return requeued;
  } catch (err: any) {
    logger.warn(`hooks: preempted-wake requeue failed for chat ${String(targetChatId).slice(0, 8)}: ${err?.message}`);
    return 0;
  }
}

/** Minimum length for an id PREFIX to resolve (8 = the prefix style agent-facing
 *  truncation produces). Shorter inputs stay exact-only. */
export const MIN_HOOK_ID_PREFIX_LEN = 8;

/**
 * Exact-id-or-unique-prefix resolution (owner-scoped). Nightly-lane postmortem
 * (2026-08-27): agent-facing payloads can sever an id mid-string (message-content
 * caps) and older blocks taught 8-char-prefix citations, so a lane holding only
 * "6bdedc2a-…" dead-ended with "No such hook" while holding a perfectly
 * identifying prefix. Order: exact id → unique ≥8-char prefix. Zero matches →
 * null (not found, exactly as before); MULTIPLE → AppError(400) listing the
 * candidate full ids — never guess. Never crosses the owner boundary.
 */
export async function resolveHookIdForUser(userId: string, idOrPrefix: string): Promise<string | null> {
  const id = String(idOrPrefix || '').trim();
  if (!id) return null;
  const exact = await prisma.eventHook.findFirst({ where: { id, userId } });
  if (exact) return exact.id;
  if (id.length < MIN_HOOK_ID_PREFIX_LEN) return null;
  const matches = await prisma.eventHook.findMany({
    where: { userId, id: { startsWith: id } },
    select: { id: true },
    take: 5,
  });
  if (!matches.length) {
    // audit 2026-10-08 W3-3: the shared heal tier — a ≥8-char suffix / prefix+suffix splice, owner-scoped.
    const { healIdRef } = await import('./id-ref');
    const healed = await healIdRef(id, {
      byPrefix: async (prefix, take) => ((await prisma.eventHook.findMany({ where: { userId, id: { startsWith: prefix } }, select: { id: true }, take })) ?? []).map((r: any) => r.id),
      bySuffix: async (suffix, take) => ((await prisma.eventHook.findMany({ where: { userId, id: { endsWith: suffix } }, select: { id: true }, take })) ?? []).map((r: any) => r.id),
    }, 'hook');
    if (healed.ok) return healed.id;
    if (healed.reason === 'ambiguous') {
      throw new AppError(400, `Ambiguous hook id "${id}" — matches ${healed.candidates.length} of your hooks: ${healed.candidates.join(', ')}. Pass the full id.`);
    }
    return null;
  }
  if (matches.length > 1) {
    throw new AppError(400, `Ambiguous hook id prefix "${id}" — matches ${matches.length} of your hooks: ${matches.map((m) => m.id).join(', ')}. Pass the full id.`);
  }
  return matches[0].id;
}

/**
 * Update an existing hook owned by this user IN PLACE (ticket c4135a9f — the
 * fleet layer previously forced unsubscribe+resubscribe to change anything,
 * which loses the hook id, its lastFiredAt debounce anchor, and any pending
 * outbox rows). Subscribe-grade validation on every PROVIDED field; omitted
 * fields keep their stored values. The wiring endpoints (sourceChatId /
 * targetChatId) are deliberately NOT updatable — rewiring is a new
 * subscription, so the ownership model stays exactly as subscribe-time
 * checked it. enabled:false pauses the hook: NEW events stop being emitted
 * into it, and any rows still pending are terminal-marked
 * 'skipped:hook_disabled' by the next sweep (v1#1 — a paused hook's backlog
 * used to sit pending forever and starve the shared sweep batch). A re-enable
 * resumes with fresh events; the skipped rows stay auditable in the table.
 * Returns null when the hook does not exist (or is not this user's).
 */
export async function updateHook(opts: {
  userId: string;
  hookId: string;
  eventTypes?: string[];
  promptTemplate?: string;
  debounceSec?: number;
  enabled?: boolean;
}): Promise<EventHookView | null> {
  if (!opts.hookId) throw new AppError(400, 'hookId is required');

  // Validate BEFORE the ownership lookup — same field rules as subscribeHook.
  const data: Record<string, unknown> = {};
  if (opts.eventTypes !== undefined) {
    const valid = new Set<string>(HOOK_EVENT_TYPES);
    const eventTypes: string[] = [];
    for (const raw of opts.eventTypes ?? []) {
      const t = String(raw);
      if (!valid.has(t)) {
        throw new AppError(400, `Invalid event type "${t}" — eventTypes must be a subset of: ${HOOK_EVENT_TYPES.join(', ')}`);
      }
      if (!eventTypes.includes(t)) eventTypes.push(t);
    }
    if (!eventTypes.length) {
      throw new AppError(400, `eventTypes must be a non-empty subset of: ${HOOK_EVENT_TYPES.join(', ')}`);
    }
    data.eventTypes = eventTypes;
  }
  if (opts.promptTemplate !== undefined) {
    data.promptTemplate = String(opts.promptTemplate ?? '').slice(0, 8000);
  }
  if (opts.debounceSec !== undefined && opts.debounceSec !== null) {
    const n = Number(opts.debounceSec);
    if (!Number.isFinite(n)) throw new AppError(400, 'debounceSec must be a number (0..3600)');
    data.debounceSec = Math.min(MAX_DEBOUNCE_SEC, Math.max(0, Math.round(n)));
  }
  if (opts.enabled !== undefined && opts.enabled !== null) data.enabled = !!opts.enabled;
  if (Object.keys(data).length === 0) {
    throw new AppError(400, 'Nothing to update — pass at least one of eventTypes, promptTemplate, debounceSec, enabled');
  }

  // Ownership scoping in the where clause, exactly like unsubscribeHook.
  // Prefix-tolerant (resolveHookIdForUser): an id severed from a truncated
  // payload resolves to the one hook it identifies; ambiguity rejects above.
  const resolvedHookId = await resolveHookIdForUser(opts.userId, opts.hookId);
  if (!resolvedHookId) return null;
  const row = await prisma.eventHook.findFirst({ where: { id: resolvedHookId, userId: opts.userId } });
  if (!row) return null;

  const updated = await prisma.eventHook.update({ where: { id: row.id }, data });
  logger.info(`hook ${row.id.slice(0, 8)}: updated by user ${opts.userId.slice(0, 8)} (${Object.keys(data).join(', ')})`);
  await audit(opts.userId, 'hook.update', {
    hookId: row.id, sourceChatId: row.sourceChatId, targetChatId: row.targetChatId, changes: data,
  });
  return toView(updated);
}

/** Remove a subscription owned by this user. Returns false when not found. */
export async function unsubscribeHook(opts: { userId: string; hookId: string }): Promise<boolean> {
  if (!opts.hookId) throw new AppError(400, 'hookId is required');
  const resolvedHookId = await resolveHookIdForUser(opts.userId, opts.hookId);
  if (!resolvedHookId) return false;
  const row = await prisma.eventHook.findFirst({ where: { id: resolvedHookId, userId: opts.userId } });
  if (!row) return false;
  await prisma.eventHook.delete({ where: { id: row.id } }); // cascade clears pending outbox rows
  logger.info(`hook ${row.id.slice(0, 8)}: unsubscribed by user ${opts.userId.slice(0, 8)}`);
  await audit(opts.userId, 'hook.unsubscribe', { hookId: row.id, sourceChatId: row.sourceChatId, targetChatId: row.targetChatId });
  return true;
}

/** List the user's hooks, optionally narrowed to a source or target chat. */
export async function listHooks(opts: {
  userId: string;
  sourceChatId?: string;
  targetChatId?: string;
}): Promise<EventHookView[]> {
  const rows = await prisma.eventHook.findMany({
    where: {
      userId: opts.userId,
      ...(opts.sourceChatId ? { sourceChatId: opts.sourceChatId } : {}),
      ...(opts.targetChatId ? { targetChatId: opts.targetChatId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return rows.map(toView);
}

/**
 * Duplicate-coverage probe (ticket dd3a19fa, 2026-09-20): the ENABLED hooks
 * that already wake `targetChatId` on any of `eventTypes` — EXCLUDING the
 * owner-scope wildcard row (sourceChatId null + projectId null), which a
 * wildcard hook_subscribe pair-dedups INTO (update-in-place, never a second
 * wake source). What remains — a project-scope hook or a specific-source hook
 * — is exactly what a NEW owner-scope wildcard would double-cover, waking the
 * target TWICE per matching event (the shape that re-derailed the
 * canlegal-bench lane). The platform tool refuses that subscribe from a
 * machine-triggered run and warns on a user-anchored one.
 */
export async function findCoveringHooks(opts: {
  userId: string;
  targetChatId: string;
  eventTypes: string[];
}): Promise<EventHookView[]> {
  if (!opts.eventTypes.length) return [];
  const rows = await prisma.eventHook.findMany({
    where: {
      userId: opts.userId,
      targetChatId: opts.targetChatId,
      enabled: true,
      NOT: { sourceChatId: null, projectId: null },
      eventTypes: { hasSome: opts.eventTypes },
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  return rows.map(toView);
}

// ── Archived source (audit 2026-10-06 T3-12) ─────────────────────────────────

/** Context-store slot holding the hook ids an archive paused (so a restore re-arms exactly those). */
export const ARCHIVE_PAUSED_HOOKS_NS = (chatId: string): string[] => ['hooks', 'archive-paused', chatId];
export function archivedSourceHookPauseDisabled(): boolean {
  return process.env.HOOK_SOURCE_ARCHIVED_SKIP_DISABLED === '1';
}

/** Merge hook ids into the chat's archive-paused record (read-modify-write; best-effort — a miss leaves the hook for one hook_update). */
async function rememberArchivePausedHooks(chatId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    const store = await import('../memory/context-store');
    const prev = await store.storeGet<{ ids?: unknown }>(ARCHIVE_PAUSED_HOOKS_NS(chatId), 'ids').catch(() => null);
    const merged = [...new Set([...(Array.isArray(prev?.ids) ? (prev!.ids as unknown[]).map(String) : []), ...ids])];
    await store.storePut(ARCHIVE_PAUSED_HOOKS_NS(chatId), 'ids', { ids: merged, at: new Date().toISOString() });
  } catch { /* best-effort */ }
}

/**
 * Archiving a chat (platform.service archiveChat) PAUSES every enabled hook
 * whose SOURCE is that chat (schooltime P3: the archived child 5e828694 kept
 * two enabled hooks into its parent and the Fleet Supervisor). Specific hooks
 * only — wildcards are never touched, and the chat's own direct-wake self-hook
 * (source == target) is left to the dispatch-time archived check. The paused
 * ids are remembered so a restore re-arms exactly them. Pause-never-delete;
 * one hook.auto_pause audit row. Never throws; returns the paused count.
 */
/**
 * audit 2026-10-08 W3-5 (plumbing P2): 192 enabled hooks TARGETED archived
 * chats — the T3-12 pause covered only a chat's OUTGOING hooks, and the
 * delivery-time retired-target pause exempts every `system:*` hook (child-result
 * wakes, todo_wake self-hooks), so those kept waking shelved chats. Archiving a
 * chat now also pauses every enabled hook that TARGETS it (system hooks and the
 * chat's own self-hook included — their self-heal paths, enqueueDirectWake and
 * ensureChildResultHook, re-enable them on new work), remembered with the
 * outgoing ones so a restore re-arms exactly them. Kill switch
 * HOOK_TARGET_ARCHIVED_PAUSE_DISABLED=1 restores outgoing-only.
 */
export function archivedTargetHookPauseDisabled(): boolean {
  return process.env.HOOK_TARGET_ARCHIVED_PAUSE_DISABLED === '1';
}

export async function pauseHooksForArchivedSource(userId: string, chatId: string): Promise<number> {
  if (!userId || !chatId || archivedSourceHookPauseDisabled()) return 0;
  try {
    const hooks = await prisma.eventHook.findMany({
      where: { userId, sourceChatId: chatId, enabled: true, NOT: { targetChatId: chatId } },
      select: { id: true, targetChatId: true },
    });
    // audit 2026-10-08 W3-5: the hooks that wake THIS chat pause with it.
    const targeting = archivedTargetHookPauseDisabled()
      ? []
      : ((await prisma.eventHook.findMany({
          where: { userId, targetChatId: chatId, enabled: true },
          select: { id: true, sourceChatId: true, createdVia: true },
        })) ?? []);
    const outgoingIds = (hooks ?? []).map((h) => h.id);
    const targetIds = targeting.map((h: any) => String(h.id)).filter((id: string) => !outgoingIds.includes(id));
    const ids = [...outgoingIds, ...targetIds];
    if (!ids.length) return 0;
    const r = await prisma.eventHook.updateMany({ where: { id: { in: ids }, enabled: true }, data: { enabled: false } });
    await rememberArchivePausedHooks(chatId, ids);
    await audit(userId, 'hook.auto_pause', {
      reason: `chat ${chatId} archived — ${outgoingIds.length} outgoing hook(s)${targetIds.length ? ` and ${targetIds.length} hook(s) that wake it` : ''} paused (restore re-arms them)`,
      sourceChatId: chatId, hookIds: ids, ...(targetIds.length ? { targetHookIds: targetIds } : {}),
    });
    recordLoopMetric({ kind: 'hook_source_archived', sessionId: chatId, value: Number(r?.count ?? ids.length), meta: { phase: 'archive', hookIds: outgoingIds, ...(targetIds.length ? { targetHookIds: targetIds } : {}) } });
    return Number(r?.count ?? 0);
  } catch (err: any) {
    logger.warn(`hooks: archive-time pause for chat ${String(chatId).slice(0, 8)} failed (non-fatal): ${err?.message ?? err}`);
    return 0;
  }
}

/**
 * audit 2026-10-08 W3-5: the restore half for the unarchive paths that bypass
 * platform.service archiveChat (the coding session API's archived:false and the
 * user-turn dispatch heal) — they cleared archivedAt without re-arming what the
 * archive paused. Looks up the chat's owner; never throws.
 */
export async function resumeHooksForRestoredChat(chatId: string): Promise<number> {
  try {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { userId: true } });
    return chat?.userId ? await resumeHooksForRestoredSource(chat.userId, chatId) : 0;
  } catch {
    return 0;
  }
}

/** Restore half: re-enable exactly the hooks the archive paused (still this user's, still sourced from the chat). Never throws. */
export async function resumeHooksForRestoredSource(userId: string, chatId: string): Promise<number> {
  if (!userId || !chatId || archivedSourceHookPauseDisabled()) return 0;
  try {
    const store = await import('../memory/context-store');
    const rec = await store.storeGet<{ ids?: unknown }>(ARCHIVE_PAUSED_HOOKS_NS(chatId), 'ids');
    const ids = Array.isArray(rec?.ids) ? (rec!.ids as unknown[]).map(String).filter(Boolean) : [];
    if (!ids.length) return 0;
    // audit 2026-10-08 W3-5: the remembered set holds outgoing AND targeting hooks — both re-arm (still this user's, still wired to the chat).
    const wiredToChat = archivedTargetHookPauseDisabled() ? { sourceChatId: chatId } : { OR: [{ sourceChatId: chatId }, { targetChatId: chatId }] };
    const r = await prisma.eventHook.updateMany({ where: { id: { in: ids }, userId, enabled: false, ...wiredToChat }, data: { enabled: true } });
    await store.storeDelete(ARCHIVE_PAUSED_HOOKS_NS(chatId), 'ids').catch(() => {});
    await audit(userId, 'hook.update', { reason: `source chat ${chatId} restored — hooks paused by its archive re-armed`, sourceChatId: chatId, hookIds: ids });
    recordLoopMetric({ kind: 'hook_source_archived', sessionId: chatId, value: Number(r?.count ?? 0), meta: { phase: 'restore', hookIds: ids } });
    return Number(r?.count ?? 0);
  } catch (err: any) {
    logger.warn(`hooks: restore-time re-arm for chat ${String(chatId).slice(0, 8)} failed (non-fatal): ${err?.message ?? err}`);
    return 0;
  }
}
