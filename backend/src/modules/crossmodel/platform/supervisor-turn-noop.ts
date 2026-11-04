/**
 * Supervisor turn pre-triage — decision-gate purpose `supervisor_turn_noop`
 * (agent-decisions program, area "supervisor", 2026-09-27; shipped SHADOW).
 *
 * WHY: 14 days of prod (loop_metrics supervisor_noop / supervisor_action /
 * supervisor_note, verified 2026-09-27 via prodsql2.sh): the supervisors close
 * 4,914 turns as a no-op note — 2,988 hook wakes, 1,227 scheduled sweeps, 699
 * agent-message drains — at ≈ $0.22 each (~$36/day, range 25–67). The hook
 * origin is already governed by `wake_triage` (act, 922 labels, READY); the
 * sweep origin's `sweep_triage` sits flat at 57% band agreement and the drain
 * origin's `drain_triage` at 43% — both ask over the DELTA alone and never see
 * the per-target history. This purpose asks ONE typed noul over the TARGET's
 * own record (the AACT per-tenant feature — 7-day no-op / action rates,
 * consecutive no-ops, time since the last action; prod 2026-09-27: schedule
 * origin no-op share rises 44.7% → 59.6% → 81.8% → 100% across the prior-rate
 * buckets <40% / 40–70% / 70–90% / ≥90%), its last three notes, the board
 * counts and the pending inputs — code-computed first, prose last and capped.
 *
 * ORIGINS: `sweep` (a stock fleet/project sweep firing — coding/schedule
 * .service processDueScheduleRow, next to preTriageSweepFiring) and `drain`
 * (a queued agent-message batch — chat-agent.service drainChatQueue, next to
 * preTriageDrainBatch). Hook wakes are NOT re-keyed (judge edit 2026-09-27):
 * they keep `wake_triage`.
 *
 * QUESTIONS: `will_act` (the ACT question) — will this turn take a recorded
 * ACTION rather than close as a no-op note? `has_new_input` is a SHADOW PROBE
 * only: the same property is computed deterministically here (normalized
 * trigram containment of the pending inputs in the last three notes) and used
 * as a HARD PIN in the act rule — a batch that states a fact the notes do not
 * record is never skipped, whatever the model says. The probe question is
 * labelled at decision time from that code flag (like wake_triage's batch
 * nouls) so its calibration is measurable; it never enters the act rule.
 *
 * LABEL (decision-outcome-labels.ts): actual = the fired turn ACTED, judged
 * from HARNESS evidence only — a mutating platform tool call in the run's
 * transcript (PLATFORM_MUTATING_TOOLS minus the doctrine-mandated
 * update_supervisor_state; every receipt-minting mutation in
 * coding/run-receipts RECEIPT_TOOLS is inside that set — verified 2026-09-27).
 * The model's own "ACTIONS TAKEN" marker is NOT evidence (fixer 2026-09-27):
 * a final that claims actions with zero tool calls labels actual:false; the
 * note kind rides the row's note only. A SKIPPED turn has actual:null (the
 * run never happens). PINNED turns — new input / alarm / cap bypass / user
 * row waiting, which the act rule can never skip — stamp `pinned:true` (+
 * `pins`) on their stash extra and their outcome rows are excludeFromFit, so
 * the fit, the readiness ruler and the auto-demote window see only the
 * population the consumer could act on. In act, the labelled rows inside the
 * skip band are therefore the heartbeat-floor turns (`control:true`) plus the
 * rare fail-open deliveries (`parkWriteFailed:true`); in shadow they are the
 * unpinned turns the rule WOULD have skipped. The readiness bar is stricter
 * for this purpose (decision-gate-fit PURPOSE_READINESS_BARS: 30 band rows at
 * Wilson-LB ≥ 0.95; once floor turns exist, readinessVerdict also requires 30
 * of them with a quiet-rate Wilson-LB ≥ 0.95 — floor-turn action rate ≤ 5%)
 * and the auto-demote bar is 0.95.
 *
 * PROVENANCE of the per-target features (fixer 2026-09-27): notes_7d /
 * noop_rate_7d / action_rate_7d / consecutive_noops / last_action come from
 * loop_metrics rows the attention watchdog writes by running
 * classifySupervisorNote's REGEXES over the supervisor's own persisted notes
 * (fleet/attention-watchdog.service.ts) — regex-over-model-markers, not
 * harness receipts. They are FEATURES the gate may weigh, never labels.
 *
 * MODES (decisionMode('supervisor_turn_noop'); default shadow, NODE_ENV=test off):
 *   shadow — nothing changes; the stash rides the fired turn as a SIBLING of
 *            the origin's existing stash (DecisionStash.also) so both purposes
 *            are labelled from the same finalize.
 *   act    — designed, admitted only by the readiness ruler: when will_act ≤
 *            1 − τ (τ 0.85, DECISION_GATE_THRESHOLD_SUPERVISOR_TURN_NOOP) AND
 *            no new input AND no alarm / owner-card / child-result / [INFRA
 *            ALERT] row AND not a cap-bypass wake AND consecutive skips <
 *            heartbeat ticks − 1 ⇒ the turn is NOT started: a sweep firing is
 *            skipped (lastStatus 'skipped:turn_noop:<n>', cap token refunded
 *            by the caller), a drain batch is parked (Redis marker, rows stay
 *            pending, the orphan sweeper re-drains it after the defer window).
 *            Both record loop_metrics wake_parked reason 'turn_noop'. Once its
 *            mode is act this purpose REPLACES sweep_triage at the sweep site
 *            and drain_triage at the drain site (supervisorTurnNoopActive —
 *            the callers skip the older ask).
 * Fail-open everywhere: a facts read error / timeout, a null gate answer, a
 * Redis hiccup, a thrown anything ⇒ the turn runs exactly as before. Kill
 * switches: the gate-wide ones.
 *
 * LEAF: imports decision-gate, loop-metrics and decision-gate-math statically;
 * the supervisor note classifier and the supervisor state ledger are pulled
 * DYNAMICALLY (supervisor.service → schedule.service → this would cycle).
 */

import { createHash } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import {
  decide, decisionMode, decisionThreshold, recordDecisionOutcome, stashDecision,
  type DecideResult, type DecisionQuestion, type DecisionStash,
} from './decision-gate';
import { bucketMinutes } from './decision-gate-math';
import { harnessNoteKind, supervisorHarnessReceiptsDisabled } from './harness-receipts';
import { recordLoopMetric, LOOP_METRIC_KINDS } from './loop-metrics.service';

// ── Tunables ─────────────────────────────────────────────────────────────────

export const SUPERVISOR_TURN_NOOP_PURPOSE = 'supervisor_turn_noop' as const;
/** The ACT question key on every decision/outcome row. */
export const SUPERVISOR_TURN_NOOP_QUESTION = 'will_act';
/** The shadow probe (code-labelled at decision time; never in the act rule). */
export const SUPERVISOR_TURN_NOOP_PROBE_QUESTION = 'has_new_input';
/** Acting confidence (DECISION_GATE_THRESHOLD_SUPERVISOR_TURN_NOOP overrides; clamped by decisionThreshold). */
export const SUPERVISOR_TURN_NOOP_DEFAULT_THRESHOLD = 0.85;
/** Gate deadline — a small slice of the 30 s sweeper tick / a queue hop (the sibling asks' 4 s). */
export const SUPERVISOR_TURN_NOOP_TIMEOUT_MS = 4000;
/** Facts read deadline — past it the gate is NOT asked (no state, no decision). 1.5 s (fixer
 *  2026-09-27, was 3 s): both callers run this ask CONCURRENTLY with the sibling triage
 *  (sweep_triage snapshot 8 s + decide 4 s; drain_triage snapshot 3 s + decide 4 s), so the
 *  1.5 s + 4 s bound sits inside the sibling's and adds no serial wall clock to a firing or a
 *  drain; the hook origin's v3 lookup shares hooks.service WAKE_TRIAGE_LANE_LOOKUP_MS (1.5 s). */
export const SUPERVISOR_TURN_NOOP_FACTS_TIMEOUT_MS = 1500;
/** ACT heartbeat floor: the turn runs on every Nth eligible tick regardless (env DECISION_GATE_SUPERVISOR_TURN_NOOP_HEARTBEAT_TICKS, clamped 2..24). */
export const SUPERVISOR_TURN_NOOP_DEFAULT_HEARTBEAT_TICKS = 3;
/** ACT drain park length in minutes (env DECISION_GATE_SUPERVISOR_TURN_NOOP_DEFER_MIN, clamped 5..60). */
export const SUPERVISOR_TURN_NOOP_DEFAULT_DEFER_MIN = 15;
/** lastStatus stamped on an ACT sweep skip: `skipped:turn_noop:<consecutive>`. */
export const TURN_NOOP_SKIP_STATUS_PREFIX = 'skipped:turn_noop';
/** The per-target feature window (the AACT 7-day rates). */
export const SUPERVISOR_TURN_NOOP_FEATURE_DAYS = 7;
/** Bounds on the state (≤ 4k chars total; pending rows ≤ 8, summary head ≤ 300, note head ≤ 160). */
export const SUPERVISOR_TURN_NOOP_STATE_MAX_CHARS = 4000;
export const SUPERVISOR_TURN_NOOP_MAX_PENDING = 8;
export const SUPERVISOR_TURN_NOOP_SUMMARY_CHARS = 300;
export const SUPERVISOR_TURN_NOOP_NOTE_HEAD_CHARS = 160;
export const SUPERVISOR_TURN_NOOP_LAST_NOTES = 3;
/** The deterministic new-input rule: a pending input is NEW when fewer than this share of its word trigrams appear in any of the last notes. */
export const TURN_NOOP_NEW_INPUT_CONTAINMENT = 0.6;
/** Bounds on the ledger reads (pathology guards). */
export const SUPERVISOR_TURN_NOOP_MAX_METRIC_ROWS = 400;
export const SUPERVISOR_TURN_NOOP_MAX_SCOPE_CHATS = 2000;
export const SUPERVISOR_TURN_NOOP_NOTE_TEXT_CHARS = 6000;
/** How long the drain park marker outlives the park (the "already triaged" memory). */
export const TURN_NOOP_PARK_MARKER_TTL_SEC = 2 * 60 * 60;

/** The ACT heartbeat floor in ticks (every Nth eligible tick runs the turn regardless). */
export function supervisorTurnNoopHeartbeatTicks(): number {
  const raw = Number(process.env.DECISION_GATE_SUPERVISOR_TURN_NOOP_HEARTBEAT_TICKS);
  const v = Number.isFinite(raw) ? Math.floor(raw) : SUPERVISOR_TURN_NOOP_DEFAULT_HEARTBEAT_TICKS;
  return Math.min(24, Math.max(2, v));
}

/** The ACT drain park length in minutes (clamped 5..60). */
export function supervisorTurnNoopDeferMin(): number {
  const raw = Number(process.env.DECISION_GATE_SUPERVISOR_TURN_NOOP_DEFER_MIN);
  const v = Number.isFinite(raw) ? Math.floor(raw) : SUPERVISOR_TURN_NOOP_DEFAULT_DEFER_MIN;
  return Math.min(60, Math.max(5, v));
}

/**
 * Is this purpose governing its sites (effective mode 'act')? The
 * sweep and drain callers skip the OLDER purpose's ask (sweep_triage /
 * drain_triage) while this is true — one act consumer per site. Never throws
 * (a partial decision-gate mock reads as "not active").
 */
export function supervisorTurnNoopActive(): boolean {
  try {
    return decisionMode(SUPERVISOR_TURN_NOOP_PURPOSE) === 'act';
  } catch { return false; }
}

/**
 * Will an origin consult the gate at all (mode not 'off')? The
 * callers gate their pending-input reads on this so an off purpose costs no
 * query (fixer 2026-09-27). Never throws.
 */
export function supervisorTurnNoopConsulted(): boolean {
  try {
    return decisionMode(SUPERVISOR_TURN_NOOP_PURPOSE) !== 'off';
  } catch { return false; }
}

/** The hard pins that keep a turn running whatever the gate says (the act rule's ∧ ¬pinned). Pure. */
export function turnNoopPins(f: { newInput: boolean; alarm: boolean; capBypassed: boolean; userRowsWaiting: number }): string[] {
  const out: string[] = [];
  if (f.newInput) out.push('new_input');
  if (f.alarm) out.push('alarm');
  if (f.capBypassed) out.push('cap_bypass');
  if (f.userRowsWaiting > 0) out.push('user_rows');
  return out;
}

/** Consecutive ACT sweep skips encoded in the row's lastStatus (0 for anything else). Pure. */
export function consecutiveTurnNoopSkips(lastStatus: unknown): number {
  if (typeof lastStatus !== 'string' || !lastStatus.startsWith(TURN_NOOP_SKIP_STATUS_PREFIX)) return 0;
  const tail = lastStatus.slice(TURN_NOOP_SKIP_STATUS_PREFIX.length);
  if (!tail) return 1;
  const n = Number(tail.replace(/^:/, ''));
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** The lastStatus for an ACT sweep skip. Pure. */
export function turnNoopSkipStatus(consecutive: number): string {
  return `${TURN_NOOP_SKIP_STATUS_PREFIX}:${Math.max(1, Math.floor(consecutive))}`;
}

// ── Deterministic new-input rule ─────────────────────────────────────────────

const clip = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Word trigrams of a normalized text (lower-cased, punctuation stripped, ids kept). Pure. */
export function wordTrigrams(text: unknown): Set<string> {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (words.length === 0) return out;
  if (words.length < 3) { out.add(words.join(' ')); return out; }
  for (let i = 0; i + 2 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/** Share of `needle`'s trigrams present in `haystack` (1 when the needle is empty). Pure. */
export function trigramContainment(needle: Set<string>, haystack: Set<string>): number {
  if (needle.size === 0) return 1;
  let hit = 0;
  for (const t of needle) if (haystack.has(t)) hit += 1;
  return hit / needle.size;
}

/**
 * The HARD PIN: do the pending inputs state a fact the last notes do not? A
 * pending input is NEW when its best containment in any note is below
 * TURN_NOOP_NEW_INPUT_CONTAINMENT. No pending inputs ⇒ false; pending inputs
 * and no notes ⇒ true (fail toward "new"). Pure; never throws.
 */
export function hasNewInput(pendingTexts: readonly string[], noteTexts: readonly string[]): boolean {
  const pending = pendingTexts.map((t) => clip(t, SUPERVISOR_TURN_NOOP_NOTE_TEXT_CHARS)).filter(Boolean);
  if (!pending.length) return false;
  const notes = noteTexts.map((t) => wordTrigrams(clip(t, SUPERVISOR_TURN_NOOP_NOTE_TEXT_CHARS))).filter((s) => s.size > 0);
  if (!notes.length) return true;
  return pending.some((p) => {
    const tri = wordTrigrams(p);
    if (tri.size === 0) return false;
    const best = Math.max(...notes.map((n) => trigramContainment(tri, n)));
    return best < TURN_NOOP_NEW_INPUT_CONTAINMENT;
  });
}

// ── The per-target facts (AACT features + last notes + board counts) ─────────

export type TurnNoopOrigin = 'sweep' | 'drain';
export type TurnNoopTargetKind = 'fleet supervisor chat' | 'project supervisor chat' | 'supervised chat';
export type TurnNoopNoteKind = 'supervisor_noop' | 'supervisor_action' | 'supervisor_note' | 'unclassified';

export interface TurnNoopTargetFacts {
  target: TurnNoopTargetKind;
  projectId: string | null;
  /** Classified notes in the 7-day window (loop_metrics supervisor_noop / _action / _note / _report_up rows for this chat;
   *  a report-up — wake-cadence-5 — counts as a NO-OP here: the wake did no lane work). */
  notes7d: number;
  noopRate7d: number | null;
  actionRate7d: number | null;
  /** Newest-first run of no-op notes (0 when the newest classified note was not a no-op). */
  consecutiveNoops: number;
  lastActionAgoMin: number | null;
  /** The last N assistant notes — the model sees the HEAD only, and ONLY for supervisor-class
   *  targets (fixer 2026-09-27: a 'supervised chat' can be a human's own conversation, so its
   *  reply text never leaves the box — kind + age only); the full texts feed the deterministic
   *  new-input rule server-side for every target. */
  lastNotes: Array<{ kind: TurnNoopNoteKind; head?: string; ageMin: number }>;
  /** NEVER enters the state — the deterministic hasNewInput input (clipped). */
  noteTexts: string[];
  board: {
    openDirectives: number | null;
    lanesRunning: number;
    pendingHookEvents: number;
    openOwnerAsks: number;
    userRowsWaiting: number;
  };
}

/**
 * Read the target's record from the ledger. Every read is bounded; a missing
 * chat returns null (no facts ⇒ no decision). Throws propagate to the caller,
 * which fails open.
 */
export async function computeSupervisorTurnNoopFacts(chatId: string, now: Date = new Date(), legMs?: Record<string, number>): Promise<TurnNoopTargetFacts | null> {
  // FO firing 35: optional per-leg timing bank — see legTimingNote. A leg banks
  // when it COMPLETES (resolve or reject); a leg still in flight at the caller's
  // 1.5 s deadline simply never banks. Never changes behavior.
  const lm: Record<string, number> = legMs ?? {};
  // FO firing 37: a leg banks −1 the instant it STARTS (the in-flight sentinel);
  // timed() overwrites it with the elapsed ms on settle. A snapshot taken at the
  // caller's 1.5 s deadline therefore shows every still-in-flight leg as −1 —
  // the stall suspects are NAMED, not inferred by absence (firing 35's tail
  // could not distinguish "stalled" from "banked fast and sliced out by the
  // 6-leg cap" — four legs were missing from the 21:05:49Z strike).
  const timed = <T>(name: string, p: Promise<T>): Promise<T> => {
    const t0 = Date.now();
    lm[name] = -1;
    return p.then((v) => { lm[name] = Date.now() - t0; return v; }, (e) => { lm[name] = Date.now() - t0; throw e; });
  };
  const chat = await timed('chat', prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: { id: true, userId: true, projectId: true, isSupervisor: true, isProjectSupervisor: true },
  }));
  if (!chat) return null;
  const target: TurnNoopTargetKind = chat.isSupervisor ? 'fleet supervisor chat' : chat.isProjectSupervisor ? 'project supervisor chat' : 'supervised chat';
  const since = new Date(now.getTime() - SUPERVISOR_TURN_NOOP_FEATURE_DAYS * 86_400_000);
  const projectScoped = chat.isProjectSupervisor && !!chat.projectId;

  const [metrics, notes, hooks, openOwnerAsks, userRowsWaiting, scope, openDirectives] = await Promise.all([
    timed('metrics', prisma.loopMetric.findMany({
      // wake-cadence-5 (fixer 2026-09-27): supervisor_report_up rows are read too and
      // counted as no-ops below — before this the new kind silently vanished from the
      // facts, so a lane that only ever reported up read as having NO classified notes.
      where: { sessionId: chatId, kind: { in: ['supervisor_noop', 'supervisor_action', 'supervisor_note', 'supervisor_report_up'] }, createdAt: { gte: since } },
      select: { kind: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: SUPERVISOR_TURN_NOOP_MAX_METRIC_ROWS,
    })),
    timed('notes', prisma.crossModelMessage.findMany({
      where: { chatId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
      take: SUPERVISOR_TURN_NOOP_LAST_NOTES,
      // HARNESS-RECEIPTS (2026-10-20): metadata carries the harness count the kind below prefers.
      select: { content: true, createdAt: true, ...(supervisorHarnessReceiptsDisabled() ? {} : { metadata: true }) },
    })),
    timed('hooks', prisma.eventHook.findMany({ where: { targetChatId: chatId, enabled: true }, select: { id: true } })),
    timed('asks', prisma.ownerQuestion.count({ where: { userId: chat.userId, status: 'open' } }).catch(() => 0)),
    timed('userRows', prisma.pendingChatMessage.count({ where: { chatId, source: 'user' } }).catch(() => 0)),
    timed('scope', prisma.crossModelChat.findMany({
      where: { id: { not: chatId }, archivedAt: null, ...(projectScoped ? { projectId: chat.projectId as string } : { userId: chat.userId }) },
      select: { id: true },
      take: SUPERVISOR_TURN_NOOP_MAX_SCOPE_CHATS,
    })),
    target === 'supervised chat'
      ? Promise.resolve<number | null>(null)
      : timed('directives', import('./supervisor-state.service')
          .then((m) => m.getSupervisorState(chatId))
          .then((doc) => (Array.isArray(doc?.directives) ? doc.directives.filter((d: any) => d?.status === 'open').length : 0))
          .catch(() => null)),
  ]);

  const hookIds = hooks.map((h) => h.id);
  const [pendingHookEvents, lanesRunning] = await Promise.all([
    hookIds.length ? timed('pendHooks', prisma.hookEvent.count({ where: { hookId: { in: hookIds }, status: 'pending' } }).catch(() => 0)) : Promise.resolve(0),
    scope.length ? timed('lanes', prisma.agentRun.count({ where: { sessionId: { in: scope.map((c) => c.id) }, status: 'running' } }).catch(() => 0)) : Promise.resolve(0),
  ]);

  let noop = 0; let action = 0; let consecutiveNoops = 0; let streakOpen = true; let lastActionAt: Date | null = null;
  for (const m of metrics) {
    if (m.kind === 'supervisor_noop' || m.kind === 'supervisor_report_up') { noop += 1; if (streakOpen) consecutiveNoops += 1; }
    else {
      streakOpen = false;
      if (m.kind === 'supervisor_action') { action += 1; if (!lastActionAt) lastActionAt = m.createdAt; }
    }
  }
  const notes7d = metrics.length;

  let classify: ((c: unknown) => TurnNoopNoteKind) | null = null;
  try {
    const { classifySupervisorNote } = await import('./supervisor.service');
    classify = classifySupervisorNote as (c: unknown) => TurnNoopNoteKind;
  } catch { classify = null; }
  // Heads leave the box ONLY for supervisor-class targets (fixer 2026-09-27): a
  // 'supervised chat' can be a human's own conversation — its assistant replies
  // stay server-side (kind + age only; the full texts still feed hasNewInput here).
  const shareHeads = target !== 'supervised chat';
  // HARNESS-RECEIPTS-AND-CLAIMS (supervisor SOTA round 3, 2026-10-20): a note stamped with the
  // harness count (metadata.harnessActions) is classified from that record — a report-up reads as a
  // plain note, the kind the reported-shape marker gives; older rows keep the marker regex.
  const harnessKindOf = (n: unknown): TurnNoopNoteKind | null => {
    const k = harnessNoteKind((n as { metadata?: unknown }).metadata);
    return k === 'supervisor_report_up' ? 'supervisor_note' : k;
  };
  const lastNotes = notes.map((n) => ({
    kind: harnessKindOf(n) ?? (classify ? classify(n.content) : 'unclassified' as TurnNoopNoteKind),
    ...(shareHeads ? { head: clip(n.content, SUPERVISOR_TURN_NOOP_NOTE_HEAD_CHARS) } : {}),
    ageMin: Math.max(0, Math.round((now.getTime() - n.createdAt.getTime()) / 60000)),
  }));

  return {
    target,
    projectId: chat.projectId ?? null,
    notes7d,
    noopRate7d: notes7d ? noop / notes7d : null,
    actionRate7d: notes7d ? action / notes7d : null,
    consecutiveNoops,
    lastActionAgoMin: lastActionAt ? Math.max(0, Math.round((now.getTime() - lastActionAt.getTime()) / 60000)) : null,
    lastNotes,
    noteTexts: notes.map((n) => clip(n.content, SUPERVISOR_TURN_NOOP_NOTE_TEXT_CHARS)),
    board: { openDirectives, lanesRunning, pendingHookEvents, openOwnerAsks, userRowsWaiting },
  };
}

/** A note row for a state / memo projection: kind + age, the head only when the facts carry one. Pure. */
const noteView = (n: { kind: TurnNoopNoteKind; head?: string; ageMin: number }, age: number | string): Record<string, unknown> =>
  ({ kind: n.kind, ...(typeof age === 'number' ? { minutes_ago: age } : { age }), ...(n.head ? { head: n.head } : {}) });

// ── The request (pure builder) ───────────────────────────────────────────────

/** Minimal pending-input shape both origins map onto (hook_events rows / pending_chat_messages rows). */
export interface TurnNoopPendingInput {
  id?: string;
  eventType: string;
  /** The SOURCE chat id — hashed before it reaches the state. */
  sourceChatId?: string;
  /** The emitter-authored text (summary / body) — clipped to SUPERVISOR_TURN_NOOP_SUMMARY_CHARS in the state; the full text feeds the new-input rule. */
  text: string;
  depth?: number;
  createdAt?: Date | string;
  /** Alarm-class / owner-card / child-result / [INFRA ALERT] — the caller's predicate; any true row pins "run the turn". */
  alarm?: boolean;
}

/** Conservative alarm-class fallback when hooks.service's predicate is unavailable: any of these pins the turn. */
const ALARM_FALLBACK_RE = /^(?:attention_needed|run_failed|goal_blocked|schedule_disabled|todo_wake|owner_question|child_result)$|infra_alert/i;
const ALARM_TEXT_RE = /\[INFRA ALERT|\[OWNER CARD|owner card|child result|flag_owner_question/i;

/**
 * Is this pending input alarm-class (never skipped)? hooks.service isAlarmEvent
 * when loadable (dynamic — hooks.service imports this leaf), else the
 * conservative fallback above; an [INFRA ALERT] / owner-card / child-result
 * text always pins. Never throws.
 */
export async function pendingInputIsAlarm(eventType: unknown, payload: unknown, text: unknown): Promise<boolean> {
  if (ALARM_TEXT_RE.test(String(text ?? ''))) return true;
  try {
    const m = await import('./hooks.service');
    if (typeof m.isAlarmEvent === 'function') return m.isAlarmEvent(eventType, payload);
  } catch { /* fall through */ }
  return ALARM_FALLBACK_RE.test(String(eventType ?? ''));
}

/**
 * The sweep origin's pending inputs: hook events still PENDING for this
 * supervisor (they ride the next wake — the facts a sweep would read first),
 * oldest first, bounded. Fail-open: [] on any error.
 */
export async function loadSweepPendingInputs(chatId: string): Promise<TurnNoopPendingInput[]> {
  try {
    const hooks = await prisma.eventHook.findMany({ where: { targetChatId: chatId, enabled: true }, select: { id: true } });
    if (!hooks.length) return [];
    const rows = await prisma.hookEvent.findMany({
      where: { hookId: { in: hooks.map((h) => h.id) }, status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: SUPERVISOR_TURN_NOOP_MAX_PENDING,
      select: { id: true, eventType: true, payload: true, createdAt: true },
    });
    return Promise.all(rows.map(async (r) => {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      const text = String(p.summary ?? '');
      return {
        id: r.id,
        eventType: String(r.eventType ?? p.eventType ?? ''),
        sourceChatId: p.sourceChatId ? String(p.sourceChatId) : undefined,
        text,
        depth: typeof p.depth === 'number' ? p.depth : undefined,
        createdAt: r.createdAt,
        alarm: await pendingInputIsAlarm(r.eventType, r.payload, text),
      };
    }));
  } catch { return []; }
}

/** sha256 head of a source id — the state never carries a raw chat id. Pure. */
export function hashRef(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}

/** Quantise a rate to a coarse bucket for the memo projection ('0.0'..'1.0' in tenths). Pure. */
export function quantiseRate(r: number | null): string | null {
  if (r === null || !Number.isFinite(r)) return null;
  return (Math.round(Math.min(1, Math.max(0, r)) * 10) / 10).toFixed(1);
}

/** Coarse bucket for a streak count. Pure. */
export function bucketCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n === 1) return '1';
  if (n === 2) return '2';
  if (n <= 5) return '3-5';
  return '6+';
}

export interface TurnNoopRequest {
  state: Record<string, unknown>;
  /** The memo-stable projection (ages bucketed, rates quantised, ids hashed) — null when the batch is not memoable. */
  memoState: Record<string, unknown> | null;
  memoable: boolean;
  questions: Record<string, DecisionQuestion>;
  flags: { has_new_input: boolean; any_alarm: boolean; pending: number };
}

const ageMinOf = (createdAt: Date | string | undefined, now: number): number | null => {
  if (createdAt === undefined || createdAt === null) return null;
  const t = createdAt instanceof Date ? createdAt.getTime() : new Date(String(createdAt)).getTime();
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60000)) : null;
};

/** The typed questions. */
export const SUPERVISOR_TURN_NOOP_QUESTIONS: Record<string, DecisionQuestion> = {
  [SUPERVISOR_TURN_NOOP_QUESTION]: {
    type: 'noul',
    instructions: 'Given this supervisor\'s own record (its recent no-op and action rates, its last notes), the board counts and the pending inputs, a full supervisor turn started now would take a RECORDED ACTION — send a steer or dispatch to a lane, change a schedule, file a ticket, run an infra action, or raise an owner card — rather than close as a "WAKE: no-op" / "SWEEP: no-op" note.',
    criteria: {
      true: 'the pending inputs or the board call for a decision, dispatch, re-arm, unblock or escalation the supervisor has not already handled; or the supervisor has been acting recently on similar inputs',
      false: 'nothing pending needs a decision, the board matches the last notes, and this supervisor has been closing similar turns as no-op notes — a turn now would only re-read the board and write another no-op',
    },
  },
  [SUPERVISOR_TURN_NOOP_PROBE_QUESTION]: {
    type: 'noul',
    instructions: 'At least one pending input states a fact that the supervisor\'s last three notes do not already record.',
    criteria: {
      true: 'a pending input reports something (a result, a failure, a request, a change) absent from every recent note',
      false: 'every pending input restates what the recent notes already cover, or there are no pending inputs',
    },
  },
};

/**
 * The gate request — code-computed target facts first, board counts, the
 * deterministic new-input flag (visible to the model AND the hard pin), the
 * last note heads, the pending inputs LAST and capped. ≤ 4k chars; no user
 * id, no raw chat id (source ids hashed), no note text beyond the head. Pure.
 */
export function buildSupervisorTurnNoopRequest(input: {
  origin: TurnNoopOrigin;
  facts: TurnNoopTargetFacts;
  pending: readonly TurnNoopPendingInput[];
  now?: number;
}): TurnNoopRequest {
  const now = input.now ?? Date.now();
  const rows = input.pending.slice(0, SUPERVISOR_TURN_NOOP_MAX_PENDING);
  const newInput = hasNewInput(input.pending.map((p) => p.text), input.facts.noteTexts);
  const anyAlarm = input.pending.some((p) => p.alarm === true);
  const perRow = Math.max(80, Math.min(SUPERVISOR_TURN_NOOP_SUMMARY_CHARS, Math.floor(2000 / Math.max(1, rows.length))));
  const pendingView = rows.map((p) => ({
    event_type: clip(p.eventType, 40) || 'unknown',
    ...(hashRef(p.sourceChatId) ? { from: hashRef(p.sourceChatId) } : {}),
    ...(ageMinOf(p.createdAt, now) !== null ? { age_min: ageMinOf(p.createdAt, now) } : {}),
    ...(typeof p.depth === 'number' ? { depth: p.depth } : {}),
    ...(p.alarm ? { alarm: true } : {}),
    head: clip(p.text, perRow),
  }));
  const f = input.facts;
  const state: Record<string, unknown> = {
    origin: input.origin === 'sweep' ? 'scheduled supervisor sweep firing' : 'queued agent-message drain (report-ups sent while this chat was busy)',
    target: f.target,
    target_notes_7d: f.notes7d,
    target_noop_rate_7d: f.noopRate7d === null ? null : Number(f.noopRate7d.toFixed(2)),
    target_action_rate_7d: f.actionRate7d === null ? null : Number(f.actionRate7d.toFixed(2)),
    target_consecutive_noops: f.consecutiveNoops,
    target_last_action_min_ago: f.lastActionAgoMin,
    board: {
      open_directives: f.board.openDirectives,
      lanes_running: f.board.lanesRunning,
      pending_hook_events: f.board.pendingHookEvents,
      owner_asks_open: f.board.openOwnerAsks,
      user_rows_waiting: f.board.userRowsWaiting,
    },
    pending_inputs: input.pending.length,
    pending_inputs_shown: rows.length,
    pending_input_is_new_vs_last_notes: newInput,
    any_pending_alarm: anyAlarm,
    last_notes: f.lastNotes.map((n) => noteView(n, n.ageMin)),
    pending: pendingView,
  };
  // Hard cap: trim pending heads until the state fits (the facts are small; the prose is what grows).
  let text = JSON.stringify(state);
  let cap = perRow;
  while (text.length > SUPERVISOR_TURN_NOOP_STATE_MAX_CHARS && cap > 40) {
    cap = Math.floor(cap / 2);
    state.pending = pendingView.map((r) => ({ ...r, head: clip(r.head, cap) }));
    text = JSON.stringify(state);
  }
  if (text.length > SUPERVISOR_TURN_NOOP_STATE_MAX_CHARS) { state.pending = []; state.pending_inputs_shown = 0; }

  // Memo projection: same facts, volatile fields bucketed / quantised, the batch identified by its input ids.
  const ids = rows.map((p) => (p.id === undefined || p.id === null ? '' : String(p.id).trim()));
  const memoable = !anyAlarm && (rows.length === 0 || ids.every(Boolean));
  const memoState: Record<string, unknown> | null = memoable ? {
    origin: input.origin,
    target: f.target,
    notes_7d: bucketCount(f.notes7d),
    noop_rate_7d: quantiseRate(f.noopRate7d),
    action_rate_7d: quantiseRate(f.actionRate7d),
    consecutive_noops: bucketCount(f.consecutiveNoops),
    last_action_ago: f.lastActionAgoMin === null ? null : bucketMinutes(f.lastActionAgoMin),
    board: {
      open_directives: f.board.openDirectives,
      lanes_running: f.board.lanesRunning,
      pending_hook_events: f.board.pendingHookEvents,
      owner_asks_open: f.board.openOwnerAsks,
      user_rows_waiting: f.board.userRowsWaiting,
    },
    input_ids: [...new Set(ids)].sort(),
    new_input: newInput,
    last_notes: f.lastNotes.map((n) => noteView(n, bucketMinutes(n.ageMin))),
    pending: (state.pending as Array<Record<string, unknown>>).map((r) => ({ ...r, age: typeof r.age_min === 'number' ? bucketMinutes(r.age_min as number) : undefined, age_min: undefined })),
  } : null;
  return { state, memoState, memoable, questions: SUPERVISOR_TURN_NOOP_QUESTIONS, flags: { has_new_input: newInput, any_alarm: anyAlarm, pending: input.pending.length } };
}

// ── ACT drain park marker (Redis; the hook-event triagedAt / retryAt idiom) ──

const PARK_KEY = (chatId: string) => `chat:turnnoop:${chatId}`;

export interface TurnNoopParkMarker {
  /** ms epoch the park lapses. */
  until: number;
  triagedAt: string;
  rowIds: string[];
  p: number;
  /** Consecutive ACT skips (the drain origin's heartbeat ledger). */
  skips: number;
}

async function redis(): Promise<any | null> {
  try { return (await import('../../../config/redis')).default; } catch { return null; }
}

/** The park marker for a chat, or null (absent / unreadable). Never throws. */
export async function readTurnNoopPark(chatId: string): Promise<TurnNoopParkMarker | null> {
  try {
    const r = await redis();
    const raw = r ? await r.get(PARK_KEY(chatId)) : null;
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<TurnNoopParkMarker>;
    if (typeof m?.until !== 'number' || !Number.isFinite(m.until)) return null;
    return { until: m.until, triagedAt: String(m.triagedAt ?? ''), rowIds: Array.isArray(m.rowIds) ? m.rowIds.map(String) : [], p: Number(m.p ?? 0), skips: Number.isInteger(m.skips) && (m.skips as number) > 0 ? (m.skips as number) : 1 };
  } catch { return null; }
}

/** Write the park marker (TTL = the longer of the park and the memory). Never throws; false on failure. */
export async function writeTurnNoopPark(chatId: string, marker: TurnNoopParkMarker): Promise<boolean> {
  try {
    const r = await redis();
    if (!r) return false;
    const ttlSec = Math.max(TURN_NOOP_PARK_MARKER_TTL_SEC, Math.ceil((marker.until - Date.now()) / 1000) + 60);
    await r.set(PARK_KEY(chatId), JSON.stringify(marker), { EX: ttlSec });
    return true;
  } catch { return false; }
}

/** Clear the marker (a turn ran / tests). Never throws. */
export async function clearTurnNoopPark(chatId: string): Promise<void> {
  try { const r = await redis(); if (r) await r.del(PARK_KEY(chatId)); } catch { /* best-effort */ }
}

// ── The consumer entry point (schedule.service sweep firing / chat-agent drain) ──

export interface TurnNoopTriageInput {
  origin: TurnNoopOrigin;
  chatId: string;
  pending: readonly TurnNoopPendingInput[];
  /** sweep origin: consecutive ACT skips from the row's lastStatus (consecutiveTurnNoopSkips); drain origin reads its own marker. */
  consecutiveSkips?: number;
  /** A cap-bypass (alarm) firing is never skipped. */
  capBypassed?: boolean;
  now?: Date;
}

export interface TurnNoopTriageResult {
  decision: DecideResult | null;
  /** The stash the fired turn carries to its finalize (null when labels are off or no decision). */
  stash: DecisionStash | null;
  /** ACT only: the caller does NOT start the turn (sweep: stamp the skip status + refund; drain: the rows are already parked here). */
  skip: { p: number; consecutive: number; until?: number } | null;
  /** ACT: this turn runs because the heartbeat floor forced it — its label is a control row (stash.extra.control). */
  control: boolean;
  /** The deterministic new-input flag (null when the gate was not consulted). */
  hasNewInput: boolean | null;
  /** The hard pins that held this turn (turnNoopPins; [] when none / not consulted). A pinned turn's stash carries
   *  `extra.pinned:true` (+ `pins`) and its outcome row is excludeFromFit (fixer 2026-09-27). */
  pins: string[];
  /** drain origin: an EARLIER park still holds — the caller returns without a turn and without a new decision. */
  parked: { until: number; p: number } | null;
}

const NO_TRIAGE: TurnNoopTriageResult = { decision: null, stash: null, skip: null, control: false, hasNewInput: null, pins: [], parked: null };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * FO firing 35 (2026-09-27) — diagnosability for the intermittent facts timeout.
 * computeSupervisorTurnNoopFacts banks each leg's elapsed ms into a shared `legMs`
 * (a leg banks when it COMPLETES; a stalled leg simply never banks — its absence
 * in the note IS the diagnosis). The fail-open warn appends ` [leg:ms …]`, hottest
 * first, capped at 6. Firing 35 proved the cause is NOT query cost (9 legs ≈ 135 ms
 * live on the noisiest chat vs the 1500 ms budget; the neighbors decision-gate
 * 1207 ms / unified-memory 1200 ms fail in the same windows) — without leg evidence
 * every firing had to re-guess. Pure observability: never throws, zero behavior
 * change on any path, and the strike message stays greppable-class identical
 * ("supervisor turn facts timed out after 1500ms" — audit-live-state.js matches it).
 */
const legTimingNote = (legMs: Record<string, number>): string => {
  // FO firing 37: legs that STARTED but never settled still hold the −1
  // in-flight sentinel — those are the stall suspects and are NAMED first
  // (`stalled:a,b`), so a live strike is its own diagnosis. Settled legs follow
  // hottest-first, capped at 6. Pure observability: never throws, zero behavior
  // change, and the strike message keeps the greppable prefix
  // ("supervisor turn facts timed out after 1500ms" — audit-live-state.js
  // matches that substring).
  const stalled = Object.entries(legMs).filter(([, ms]) => ms < 0).map(([leg]) => leg);
  const top = Object.entries(legMs).filter(([, ms]) => ms >= 0).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([leg, ms]) => `${leg}:${Math.round(ms)}ms`).join(' ');
  const parts: string[] = [];
  if (stalled.length) parts.push(`stalled:${stalled.join(',')}`);
  if (top) parts.push(top);
  return parts.length ? ` [${parts.join(' ')}]` : '';
};

/**
 * Pre-triage ONE supervisor turn about to start. Mode 'off' returns
 * NO_TRIAGE without touching the DB, Redis or the seat. Never
 * throws — every failure returns NO_TRIAGE so the turn starts as before.
 */
export async function preTriageSupervisorTurn(input: TurnNoopTriageInput): Promise<TurnNoopTriageResult> {
  // FO firing 35: the per-leg timing bank — hoisted ABOVE the try so the catch
  // below can read whatever the legs had banked at the moment of failure.
  const legMs: Record<string, number> = {};
  try {
    const mode = decisionMode(SUPERVISOR_TURN_NOOP_PURPOSE);
    if (mode === 'off') return NO_TRIAGE;
    const now = input.now ?? new Date();

    // drain origin: an earlier ACT park still holds ⇒ no turn, no new decision; a lapsed park re-triages with its skip ledger.
    let consecutive = Math.max(0, Math.floor(input.consecutiveSkips ?? 0));
    if (input.origin === 'drain') {
      const park = await readTurnNoopPark(input.chatId);
      if (park) {
        if (now.getTime() < park.until) return { ...NO_TRIAGE, parked: { until: park.until, p: park.p } };
        consecutive = park.skips;
      }
    }

    // FO firing 35: the facts read banks per-leg ms into legMs; on ANY failure
    // (timeout, DB error) the banked entries ride the fail-open warn in the catch.
    const facts = await withTimeout(computeSupervisorTurnNoopFacts(input.chatId, now, legMs), SUPERVISOR_TURN_NOOP_FACTS_TIMEOUT_MS, 'supervisor turn facts');
    if (!facts) return NO_TRIAGE;
    const request = buildSupervisorTurnNoopRequest({ origin: input.origin, facts, pending: input.pending, now: now.getTime() });

    const decision = await decide(request.state, request.questions, {
      purpose: SUPERVISOR_TURN_NOOP_PURPOSE, timeoutMs: SUPERVISOR_TURN_NOOP_TIMEOUT_MS, sessionId: input.chatId,
      ...(request.memoable && request.memoState ? { memoState: request.memoState } : { memo: false }),
    });
    if (!decision) return { ...NO_TRIAGE, hasNewInput: request.flags.has_new_input };

    // The probe question is a property of the batch — labelled NOW from the code flag (never from the run).
    if (decision.answers[SUPERVISOR_TURN_NOOP_PROBE_QUESTION]) {
      recordDecisionOutcome(decision, SUPERVISOR_TURN_NOOP_PURPOSE, {
        question: SUPERVISOR_TURN_NOOP_PROBE_QUESTION, actual: request.flags.has_new_input, acted: false, sessionId: input.chatId,
        note: 'decision-time code flag (trigram containment)', extra: { origin: input.origin },
      });
    }

    const a = decision.answers[SUPERVISOR_TURN_NOOP_QUESTION];
    const p = a && a.type === 'noul' ? a.noul : 1;
    const threshold = decisionThreshold(SUPERVISOR_TURN_NOOP_PURPOSE, SUPERVISOR_TURN_NOOP_DEFAULT_THRESHOLD);
    const quiet = p <= 1 - threshold;
    const pins = turnNoopPins({ newInput: request.flags.has_new_input, alarm: request.flags.any_alarm, capBypassed: input.capBypassed === true, userRowsWaiting: facts.board.userRowsWaiting });
    const pinned = pins.length > 0;
    const ticks = supervisorTurnNoopHeartbeatTicks();
    let control = false;
    let parkWriteFailed = false;
    // The RESULT's mode gates acting — an uncalibrated backend answers as 'shadow'.
    if (decision.mode === 'act' && quiet && !pinned) {
      if (consecutive < ticks - 1) {
        const next = consecutive + 1;
        let until: number | undefined;
        if (input.origin === 'drain') {
          until = now.getTime() + supervisorTurnNoopDeferMin() * 60_000;
          const ok = await writeTurnNoopPark(input.chatId, { until, triagedAt: now.toISOString(), rowIds: input.pending.map((r) => String(r.id ?? '')).filter(Boolean), p: Number(p.toFixed(3)), skips: next });
          if (!ok) { until = undefined; parkWriteFailed = true; } // marker write failed — deliver (fail open); the label still applies below
        }
        if (input.origin === 'sweep' || until !== undefined) {
          recordDecisionOutcome(decision, SUPERVISOR_TURN_NOOP_PURPOSE, {
            question: SUPERVISOR_TURN_NOOP_QUESTION, actual: null, acted: true, sessionId: input.chatId,
            note: `skipped ${input.origin} turn (will_act ${p.toFixed(2)}, skip ${next}/${ticks - 1})`, extra: { origin: input.origin, consecutive: next },
          });
          recordLoopMetric({
            kind: LOOP_METRIC_KINDS.WAKE_PARKED, sessionId: input.chatId, value: Math.max(1, input.pending.length),
            meta: { reason: 'turn_noop', origin: input.origin, consecutive: next, p: Number(p.toFixed(3)), ...(until !== undefined ? { deferMs: until - now.getTime() } : {}) },
          });
          return { decision, stash: null, skip: { p, consecutive: next, ...(until !== undefined ? { until } : {}) }, control: false, hasNewInput: request.flags.has_new_input, pins, parked: null };
        }
      } else {
        // Heartbeat floor — the turn runs regardless; its label is the control row of the skip band.
        control = true;
        logger.info(`supervisor-turn-noop: ${input.chatId.slice(0, 8)} heartbeat floor — ${input.origin} turn runs after ${consecutive} quiet skip(s) (will_act ${p.toFixed(2)})`);
      }
    }
    if (input.origin === 'drain') await clearTurnNoopPark(input.chatId);
    // The stash extra rides the outcome row: `pinned` + `pins` mark a turn the act rule could never
    // skip (decision-outcome-labels stamps its row excludeFromFit); `control` marks the heartbeat floor.
    const extra = {
      origin: input.origin, control, ...(control ? { floor: true, consecutive } : {}), newInput: request.flags.has_new_input,
      ...(pinned ? { pinned: true, pins: pins.join(',') } : {}), ...(parkWriteFailed ? { parkWriteFailed: true } : {}),
    };
    return { decision, stash: stashDecision(decision, SUPERVISOR_TURN_NOOP_PURPOSE, { extra }), skip: null, control, hasNewInput: request.flags.has_new_input, pins, parked: null };
  } catch (err: any) {
    logger.warn(`supervisor-turn-noop: ${String(input?.chatId ?? '').slice(0, 8)} failed open (${err?.message ?? err})${legTimingNote(legMs)} — the ${input?.origin ?? ''} turn runs as before`);
    return NO_TRIAGE;
  }
}

/** Close a stash whose turn never started (busy re-arm, steer, lost race): one unlabelled outcome row so every decision pairs. Never throws. */
export function closeUnstartedTurnNoop(stash: DecisionStash | null | undefined, sessionId: string, reason: string): void {
  try {
    if (!stash || stash.purpose !== SUPERVISOR_TURN_NOOP_PURPOSE) return;
    const decision: DecideResult = { id: stash.id, answers: stash.answers, backend: stash.backend, ms: 0, mode: stash.mode, ...(stash.backendSpec ? { backendSpec: stash.backendSpec } : {}) };
    recordDecisionOutcome(decision, SUPERVISOR_TURN_NOOP_PURPOSE, { question: SUPERVISOR_TURN_NOOP_QUESTION, actual: null, acted: false, sessionId, note: `not started: ${reason}`.slice(0, 160), extra: stash.extra, ...(stash.extra?.pinned === true ? { excludeFromFit: true } : {}) });
  } catch { /* telemetry never throws */ }
}

/** Attach a sibling stash to the stash that rides a firing (DecisionStash.also) — or make it the rider when none exists. Pure. */
export function withSiblingStash(primary: DecisionStash | null, sibling: DecisionStash | null): DecisionStash | null {
  if (!sibling) return primary;
  if (!primary) return sibling;
  return { ...primary, also: [...(primary.also ?? []), sibling] };
}
