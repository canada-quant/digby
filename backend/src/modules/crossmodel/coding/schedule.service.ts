/**
 * Digby Code — durable scheduling for chats (coding sessions AND plain chats).
 *
 * Lets the ORCHESTRATOR schedule its OWN session to re-run later (schedule_self),
 * and — P1 platform unification — lets the user (via the schedule_message
 * platform tool / platform.service.scheduleChatRun) schedule a prompt against
 * ANY chat they own. A schedule is a DB row swept by a boot-registered timer,
 * so it survives deploys/reaps and can drive multi-day loops. Each firing
 * targets the chat by its workspace satellite (P5-B — mode='code' is gone):
 * satellite present → a FRESH detached coding run (full agent toolkit) via
 * the same path the HTTP handler uses; no satellite → a detached chat-agent
 * turn (startDetachedChatRun).
 *
 * Guardrails (deliberately fenced — this restarts the agent unattended):
 *   - MIN_INTERVAL_SEC (15 min): no hammering.
 *   - Lifetime ceiling: MAX_RUNS (500) AND MAX_LIFETIME (30 days) — whichever comes
 *     first disables the schedule. The orchestrator can schedule_self again to renew.
 *   - MAX_ACTIVE per session: a small cap so a confused agent can't fan out schedules.
 *   - Duplicate-backstop guard (ticket 1ead3b52): a MACHINE arm identical
 *     (normalized prompt) to an already-enabled live schedule of the same kind
 *     returns the EXISTING row — no stacked copies.
 *   - Skip-if-busy: never starts a run while one is already active on the session.
 *   - Redis NX lock per fire: blue-green safe (only one app instance fires a due row).
 */

import { storedModeToPreset } from '../types';
import prisma from '../../../config/database';
import { Prisma } from '@prisma/client';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import type { ModelErrorKind } from './agent';
import type { RunInput } from './run-state';
import { machineFiringHeader } from '../chat-agent/machine-wake';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { recordDelegationTask } from '../platform/delegation-tasks'; // build 2026-10-08 D-1 (SHADOW ledger)
import {
  decide, decisionMode, decisionThreshold, recordDecisionOutcome,
  stashDecision, reconstructDecision, type DecisionStash,
} from '../platform/decision-gate';
import { classifySweepPrompt, rebuildSweepPromptDoctrine } from '../platform/sweep-doctrine-rebuild';
import { formatDeltaLastRunOutcome } from './delta-last-run-outcome';
import { preTriageSweepFiring, sweepSkipStatus, SWEEP_TRIAGE_QUESTION } from '../platform/sweep-triage';
// agent-decisions 2026-09-27: the per-target supervisor turn pre-triage (sweep origin).
import {
  preTriageSupervisorTurn, supervisorTurnNoopActive, supervisorTurnNoopConsulted, consecutiveTurnNoopSkips, turnNoopSkipStatus, closeUnstartedTurnNoop, withSiblingStash,
  loadSweepPendingInputs, type TurnNoopPendingInput,
} from '../platform/supervisor-turn-noop';
// audit 2026-10-08 W6-2: the deterministic material-change gate (stock sweeps on supervisor chats).
import { closeStashesForGateSkip, materialGateForSweep, recordMaterialGateAgreement, type MaterialGateResult } from '../platform/supervisor-wake-ledger';
import { SCHEDULE_STATUS_NO_MATERIAL_CHANGE, SCHEDULE_STATUS_PROGRESS_SELF_DRIVING } from '../platform/wake-material-rule';
import { CHARTER_DONE_LAST_STATUS } from './allcomplete-charter';
import { hookAlarmCauseAwareDisabled } from '../platform/alarm-cause';
import { preGateParkedFiring, BUSY_REARM_MIN, FIRING_SUPERSEDED_QUESTION, SUPERSEDED_SKIP_STATUS, supersededAskEligibleAtSite, closeUnstartedSupersededStash, type FiringSupersededResult } from './firing-superseded-gate';
// wake-cadence (2026-09-27 tt-rd audit): steer dedupe + delta header, adaptive
// cadence stretch, stock-sweep floor + backoff, [SCHEDULE STATE] renewal
// clause, prompt lint, busy re-arm backoff — pure leaf, every piece kill-switched.
import {
  busySteerDeltaBody,
  adaptiveCadenceOwnerRowsEnabled, cadenceStretchFor, cadenceStretchStatus, cadenceStretchStateLine, medianMs, CADENCE_STRETCH_SAMPLE,
  sweepBackoffFor, scheduleNoopStreak, PROJECT_SWEEP_INTERVAL_SEC as STOCK_PROJECT_SWEEP_INTERVAL_SEC,
  stockSweepFloorRefusal, stockSweepFloorSec, scheduleStateRenewClause, isFleetManagedCadence, lintSchedulePrompt, busyRearmDelayMs,
  INTERVAL_ATTRIBUTION_OWNER_SOURCE, INTERVAL_ATTRIBUTION_MACHINE_SOURCE,
  type CadenceStretch, type SweepBackoff,
} from './schedule-cadence';
// Open-ended block escalation (todo 27c215d6): a lane monitor whose firings
// keep reporting the SAME no-end-date blocker backs off instead of re-reporting.
import {
  BLOCK_STREAK_TRIGGER, BLOCK_STREAK_SCAN, blockStreakCount, blockStreakBackoffFor, blockStreakBackoffDisabled,
  blockStreakCardsEnabled, blockStreakStateLine, mergeCadenceInterval,
  type BlockStreakBackoff,
} from './block-escalation';
import { extractTicketRefs, buildTerminalStopNotice, type ClosedTicketRef } from './terminal-stop';
import { appendInfraBlockerNotice } from './infra-blockers.service';
import { appendBatchTrainNotice } from './batch-train.service';
import { DORMANT_LAST_STATUS, evaluateScheduleDormancy } from './dormancy-gate.service';
// One-shot CHAIN governance (finding B1, 2026-09-27): a machine `once` arm from
// a schedule firing on its own chat is a chain link; ≥3 links in 24h ⇒ the
// recurring controls apply.
import {
  walkOnceChain, loadOnceChainRows, evaluateDueOnceChain, chainCadenceSec, onceChainWarning,
  type OnceChainVerdict,
} from './schedule-once-chain';
import { validateDeltaGate, parseStoredDeltaGate, evaluateDeltaGate, type DeltaGate } from './delta-gate.service';
import { isRetiring } from './retiring';
// Supervisor OFF switch (owner 2026-09-26): a firing on a switched-off
// supervisor chat is skipped at the sweeper (before triage / caps) and
// refused by fireScheduleTarget as the backstop for every other caller.
import {
  supervisorWakeSkip, supervisorWakeSkipById,
  SUPERVISOR_SWITCH_SKIPPED_STATUS, SUPERVISOR_SWITCH_SKIP_REASON, SUPERVISOR_SWITCH_ONCE_REARM_MS,
} from '../platform/supervisor-switch';
import {
  MAX_LIFETIME_MS, NEAR_EXPIRY_WINDOW_MS, scheduleNearCapCause,
} from './schedule-near-cap';
import type { ScheduleNearCapCause } from './schedule-near-cap';
import {
  archivedTargetRetireDisabled, ARCHIVED_SCHEDULE_LAST_STATUS, ARCHIVE_PAUSED_SCHEDULES_NS,
  isArchivedScheduleTarget, isArchivedTargetRow, archivedTargetRefusal, recordArchivedTargetRetire,
} from '../platform/archived-target-retire';

export const MIN_INTERVAL_SEC = 15 * 60;         // 15 minutes
export const MAX_PROMPT_CHARS = 8000;            // reject over-length prompts (documented in schedule_self tool)
/** P6 (N4 — the 128-rewrites lane): MACHINE-authored prompt rewrites per
 *  schedule per rolling 24h above which a warn line is logged. Gate flip 2026-09-11 (owner: full steam): the cap is OBSERVE-ONLY —
 *  the rewrite LANDS (0 refusals ever fired; the refusal's failure shape was a
 *  lane believing it re-briefed itself while the OLD prompt kept firing). */
export const MACHINE_PROMPT_REWRITES_PER_DAY = 5;
export const MAX_RUNS = 500;
/**
 * Self-re-arming cap (finding B2, 2026-09-27 — canlaw watch 7fbd168c: a 16/16
 * system-armed "S3 DURABILITY WATCH" renewed itself 8 times through
 * renewOnExhaustion — 125 runs, 0 commits, $77 — because the successor chain
 * had no generation bound). A successor's GENERATION is derived from the
 * UNIQUE renewedFromId chain (root = 0; no schema column needed): at
 * RENEW_MAX_GENERATIONS the renewal is REFUSED, the exhausted row stops with
 * the 🛑 note naming the cap, and the schedule_disabled event carries the
 * reason (alarm-class again, so the supervisor/owner decide — a fresh,
 * deliberate arm resets the chain). Governs MACHINE/SYSTEM-authored rows on
 * lane chats only: owner-authored rows and supervisor chats (fleet / project
 * sweeps have their own dormancy park + ensure) are exempt. Default 3;
 * RENEW_MAX_GENERATIONS overrides.
 */
export const RENEW_MAX_GENERATIONS_DEFAULT = 3;
export function renewMaxGenerations(): number {
  const raw = process.env.RENEW_MAX_GENERATIONS;
  if (raw == null || raw === '') return RENEW_MAX_GENERATIONS_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return RENEW_MAX_GENERATIONS_DEFAULT;
  return Math.min(n, 1000);
}
/**
 * Renewal ANCHOR (finding B2, same fix; review-fixer 2026-09-27): a
 * machine/system watch that has ALREADY renewed itself once (generation ≥ 1 —
 * a root's first renewal is the pre-B2 contract and the cap bounds the chain)
 * should renew only while the thing it watches is still open — the project
 * has an active/blocked goal, a LIVE watched-resource registration
 * (`register_watched_resource`: no end or an end in the future) or a
 * registered training artifact still awaiting `verify_durable`
 * (`register_artifact` → training_artifacts.durableVerifiedAt null — the
 * "S3 durability watch" anchor). Stricter than the dormancy gate on purpose:
 * open todos and live runs alone keep a project "not dormant" yet say nothing
 * about the watch itself.
 *
 * OBSERVE-ONLY BY DEFAULT (gate-flip doctrine 2026-09-11: a gate on a machine
 * lane's own work is telemetry + note, never a refusal, unless opted in): the
 * lookups run, a `schedule_renew_refused` row with `meta.outcome:'observed'`
 * is written, and the successor STILL arms. `RENEW_ANCHOR_CHECK_ENFORCE=1`
 * makes it refuse. Projectless chats and supervisor chats are out of scope;
 * any evaluation error passes (fail-open).
 */
export function renewAnchorCheckEnforced(): boolean {
  const v = process.env.RENEW_ANCHOR_CHECK_ENFORCE || '';
  return v === '1' || /^true$/i.test(v);
}
// MAX_LIFETIME_MS + the near-cap predicate/constants live in the
// DEPENDENCY-FREE ./schedule-near-cap module (ticket b4d1096c): ONE semantics
// for the sweeper's emission and every read surface, importable by
// supervisor-state/platform modules without pulling this module's redis/env
// chain (the 2026-09-21 liveness-suite worker crashes). Re-exported here so
// existing import sites (tests included) keep working.
export {
  MAX_LIFETIME_MS, NEAR_CAP_FRACTION, NEAR_EXPIRY_WINDOW_MS,
  nearCapRunThreshold, scheduleNearCapCause,
} from './schedule-near-cap';
export const MAX_ACTIVE_PER_SESSION = 5;
// Owner 2026-09-14 ("make hooks instant"): 30 s. Hook delivery is push-first
// now (emission kick + run-end drain); this sweeper is the cross-instance
// safety net and the schedule-firing clock — halving it halves the worst-case
// idle for both without measurable DB cost (two small indexed queries).
const SWEEP_INTERVAL_MS = 30_000;
const MAX_FIRES_PER_SESSION_PER_DAY = 48; // default daily firing cap — ChatAutonomy.scheduleCap overrides per chat
const FIRES_KEY = (sessionId: string) => `coding:sched:fires:${sessionId}`; // live daily firing counter (INCR + 24h TTL)
const SECONDS_PER_DAY = 86_400;
/** Cap-cadence guard (ticket 2694a581): a recurring schedule whose cadence
 *  math alone meets/exceeds the chat's daily firing cap guarantees daily-cap
 *  DEAFNESS for everything else sharing the counter (one-shot schedules, hook
 *  wakes). A MACHINE arm whose projection can never fit the cap is refused at
 *  arm time; any arm at/above this fraction of the cap lands with a loud
 *  warning instead of deafening the chat silently. */
const CAP_HEADROOM_WARN_FRACTION = 0.75;

/** Raw cadence projection (ticket 2694a581): firings per 24h if every tick
 *  fires. Null for one-shots — their interval is a delay, not a cadence. */
export function projectedDailyFiringsFor(kind: string, intervalSec: number | null | undefined): number | null {
  if (kind !== 'recurring' || !intervalSec || intervalSec <= 0) return null;
  return Math.floor(SECONDS_PER_DAY / intervalSec);
}

// ── Clock-drift math (ticket 903249e5) ────────────────────────────────────────
// The sweeper re-arms from FIRE time, not wall clock (nextRunAt = firedAt +
// intervalSec): a recurring cadence whose interval is not a whole number of
// days marches around the clock by (intervalSec mod 86400) per firing. The
// owner's daily digest was armed at 1219m "for 7:30 AM" — 1219 mod 1440 = 221,
// so each firing landed 3h41m EARLIER than the last, waking them at 4 AM with
// zero signal anywhere. Only the ≥12h regime warns: a sub-daily cadence cycles
// the clock by design (a monitor loop), while a once-or-twice-daily cadence is
// almost always a "daily at HH:MM" intent the drift silently violates.
export const CLOCK_DRIFT_WARN_MIN_INTERVAL_SEC = 12 * 3600; // ≥12h = daily-intent regime

/** Signed per-firing clock drift, in MINUTES (ticket 903249e5): how much
 *  earlier (negative) or later (positive) each firing lands than the last.
 *  0 = the cadence is CYCLE-ALIGNED — the interval divides the day evenly
 *  (fires at a repeating set of times, e.g. every 8h) or is a whole-day
 *  multiple (every N days at the same time); the ticket's "does not divide
 *  1440" class is everything else. Null for one-shots / non-positive.
 *  Pure — exported for tests and read surfaces. */
export function clockDriftMinutesFor(kind: string, intervalSec: number | null | undefined): number | null {
  if (kind !== 'recurring' || !intervalSec || intervalSec <= 0) return null;
  if (SECONDS_PER_DAY % intervalSec === 0 || intervalSec % SECONDS_PER_DAY === 0) return 0;
  let r = intervalSec % SECONDS_PER_DAY;
  if (r < 0) r += SECONDS_PER_DAY; // hostile/negative input — same contract as the modulo below
  if (r > SECONDS_PER_DAY / 2) r -= SECONDS_PER_DAY; // smallest signed residue: 1219m → −221, not +1219
  return Math.round(r / 60);
}

/** True when this cadence deserves a drift warning (ticket 903249e5): a
 *  daily-regime (≥12h) recurring cadence that is not day-aligned. Pure. */
export function clockDriftWarns(kind: string, intervalSec: number | null | undefined): boolean {
  if (kind !== 'recurring' || !intervalSec || intervalSec <= 0) return false;
  if (intervalSec < CLOCK_DRIFT_WARN_MIN_INTERVAL_SEC) return false;
  return (clockDriftMinutesFor(kind, intervalSec) ?? 0) !== 0;
}

/** Project the NEXT n firing ISO timestamps from an anchor (ticket 903249e5).
 *  Pure projection of the sweeper's re-arm arithmetic (anchor + k·interval) —
 *  skips, pauses and cap windows can delay real firings, but the DRIFT is
 *  exact. Null for one-shots / non-positive intervals. */
export function projectNextFirings(kind: string, intervalSec: number | null | undefined, anchor: Date | string | number, n = 3): string[] | null {
  if (kind !== 'recurring' || !intervalSec || intervalSec <= 0 || n <= 0) return null;
  const t = new Date(anchor).getTime();
  if (!Number.isFinite(t)) return null;
  return Array.from({ length: n }, (_, k) => new Date(t + (k + 1) * intervalSec * 1000).toISOString());
}

/** The non-blocking drift advisory for an arm/update response (ticket
 *  903249e5). Undefined when the cadence is day-aligned, sub-daily, or a
 *  one-shot — the arm always LANDS; this only makes the march visible, exactly
 *  like the cap-cadence warning it rides alongside. */
export function clockDriftWarningFor(kind: string, intervalSec: number | null | undefined, anchor: Date | string | number): string | undefined {
  if (!clockDriftWarns(kind, intervalSec)) return undefined;
  const driftMin = clockDriftMinutesFor(kind, intervalSec)!;
  const intervalMin = Math.round((intervalSec ?? 0) / 60);
  const direction = driftMin < 0 ? 'EARLIER' : 'LATER';
  const next = projectNextFirings(kind, intervalSec, anchor, 3) ?? [];
  const nearestDivisor = intervalMin > 1440
    ? Math.round(intervalMin / 1440) * 1440
    : (1440 % intervalMin === 0 ? intervalMin : null);
  const fix = nearestDivisor
    ? `For a fixed time of day, re-arm at a whole-day cadence (${nearestDivisor} min instead of ${intervalMin}).`
    : `For a fixed time of day, re-arm at a whole-day cadence (e.g. 1440 min) — a non-day-divisor interval can never hold a fixed time.`;
  return (
    `⚠️ CLOCK DRIFT: this ${intervalMin}-min recurring cadence is not day-aligned — every firing lands ${Math.abs(driftMin)} min ${direction} than the last, so a "daily" digest silently marches around the clock (a 1219m cadence starts at 7:30 AM and reaches 4 AM within two days). ` +
    (next.length ? `Projected next firings: ${next.join(' · ')}. ` : '') +
    fix
  );
}

export interface ScheduleView {
  id: string;
  kind: string;
  prompt: string;
  intervalSec: number | null;
  nextRunAt: string;
  enabled: boolean;
  runsCount: number;
  maxRuns: number | null;
  expiresAt: string | null;
  lastFiredAt: string | null;
  lastStatus: string | null;
  /** Who disabled the row ('owner' | 'machine'); null while enabled/resumed — the
   *  cancel actor, surfaced so a lane can attribute a stop (ticket ff0f6ad9). */
  cancelledBy: string | null;
  /** When the row was last disabled (ISO); null while enabled/resumed. */
  disabledAt: string | null;
  /** Who last wrote the prompt ('user' | 'machine' | 'system'); null = predates the column. */
  promptSetBy: string | null;
  /** Owner-subscription marker (ticket 4565991a) — surfaced so schedule_get (the write-verification read) and the Schedules UI can confirm marking. */
  ownerSubscribed: boolean | null;
  /** Consecutive busy-skipped firings (a real start — or a resume — resets it to 0). */
  busySkips: number;
  // ── Daily-cap visibility (the FIRES_KEY counter, previously write-only) ──
  /** Firings used in the current 24h window; null when unreadable (Redis hiccup). */
  dailyFiresUsed: number | null;
  /** The chat's daily firing cap (ChatAutonomy.scheduleCap ?? 48). */
  dailyCapLimit: number;
  /** When the current 24h cap window resets (ISO); null when no live window exists. */
  capWindowResetsAt: string | null;
  /** Raw cadence projection (ticket 2694a581): firings per 24h if every tick
   *  fires — compare against dailyCapLimit to see the cap burn BEFORE it
   *  happens. Null for one-shots. */
  projectedDailyFirings: number | null;
  /** Signed per-firing clock drift in MINUTES (ticket 903249e5): negative =
   *  each firing lands EARLIER than the last, positive = LATER; 0 = the
   *  cadence is day-aligned (same wall-clock time every day). Null for
   *  one-shots. */
  clockDriftMinutes: number | null;
  /** Projected next 3 firings, ISO (ticket 903249e5) — pure projection of the
   *  sweeper's re-arm arithmetic from nextRunAt, so drift is visible on
   *  inspection. Null for one-shots. */
  projectedNextFirings: string[] | null;
  /** Delta gate (ticket 0b1dbe75) — REDACTED view: each probe maps to
   *  { url, jsonPath?, pattern?, marker?, checkedAt?, lastError?, headers: string[] }
   *  where headers carries header NAMES only — values may be secrets and are
   *  never echoed. null when no gate is armed. */
  deltaGate: unknown | null;
}

/** Redact a stored delta gate for read surfaces: header VALUES never leave the
 *  row (they may carry secrets like Authorization) — only their names. */
function redactDeltaGate(raw: unknown): unknown | null {
  const gate = parseStoredDeltaGate(raw);
  if (!gate) return null;
  return {
    probes: gate.probes.map((p) => ({
      url: p.url,
      ...(p.jsonPath ? { jsonPath: p.jsonPath } : {}),
      ...(p.pattern ? { pattern: p.pattern } : {}),
      ...(p.marker !== undefined ? { marker: p.marker } : {}),
      ...(p.checkedAt !== undefined ? { checkedAt: p.checkedAt } : {}),
      ...(p.lastError !== undefined ? { lastError: p.lastError } : {}),
      headers: Object.keys(p.headers ?? {}),
    })),
    heartbeatHours: gate.heartbeatHours,
  };
}

function toView(s: any): ScheduleView {
  return {
    id: s.id, kind: s.kind, prompt: s.prompt, intervalSec: s.intervalSec ?? null,
    nextRunAt: s.nextRunAt instanceof Date ? s.nextRunAt.toISOString() : s.nextRunAt,
    enabled: s.enabled, runsCount: s.runsCount, maxRuns: s.maxRuns ?? null,
    expiresAt: s.expiresAt ? (s.expiresAt instanceof Date ? s.expiresAt.toISOString() : s.expiresAt) : null,
    lastFiredAt: s.lastFiredAt ? (s.lastFiredAt instanceof Date ? s.lastFiredAt.toISOString() : s.lastFiredAt) : null,
    lastStatus: s.lastStatus ?? null,
    cancelledBy: s.cancelledBy ?? null,
    disabledAt: s.disabledAt ? (s.disabledAt instanceof Date ? s.disabledAt.toISOString() : s.disabledAt) : null,
    promptSetBy: s.promptSetBy ?? null,
    // Owner-subscription marker (ticket 4565991a) — surfaced so schedule_get
    // (the write-verification read) and the Schedules UI can confirm marking.
    ownerSubscribed: s.ownerSubscribed ?? null,
    busySkips: s.busySkips ?? 0,
    // Cap state is stamped by enrichWithCapState after mapping — toView stays sync.
    dailyFiresUsed: null, dailyCapLimit: MAX_FIRES_PER_SESSION_PER_DAY, capWindowResetsAt: null,
    projectedDailyFirings: projectedDailyFiringsFor(s.kind, s.intervalSec ?? null),
    // Clock drift (ticket 903249e5): projected from nextRunAt — the row's own
    // anchor — so every read surface (list/get/REST/UI) sees the march.
    clockDriftMinutes: clockDriftMinutesFor(s.kind, s.intervalSec ?? null),
    projectedNextFirings: s.nextRunAt
      ? projectNextFirings(s.kind, s.intervalSec ?? null, s.nextRunAt, 3)
      : null,
    deltaGate: redactDeltaGate(s.deltaGate ?? null),
  };
}

export interface CreateScheduleInput {
  sessionId: string;
  userId: string;
  prompt: string;
  kind: 'once' | 'recurring';
  /** For 'once': delay from now. For 'recurring': the cadence. */
  intervalSec: number;
  maxRuns?: number;
  /** Who wrote the prompt ('user' | 'machine' | 'system') — drift surfacing, see schema. */
  promptSetBy?: string;
  /**
   * Owner-subscription marker (ticket 4565991a): TRUE when this arm's firings
   * are content the OWNER asked to receive. Stamped ONLY by the gated callers
   * (platform-tools: a real user turn, or a run that was ITSELF an
   * owner-subscribed schedule firing re-arming its OWN chat — the one-shot
   * ladder inheritance for dormant-gated chats). NEVER defaulted inside
   * createSchedule: a plain machine arm must not launder wake noise into
   * expanded owner-subscribed render. Persists orthogonally to promptSetBy
   * (which flips on every machine prompt rewrite — the 6ef770a1 latent hole
   * this column closes).
   */
  ownerSubscribed?: boolean;
  /** Delta gate (ticket 0b1dbe75, RECURRING only): {probes: [{url, headers?,
   *  jsonPath?|pattern?}], heartbeatHours?} — the platform polls the probes at
   *  each fire time and skips the model run when nothing changed. Strictly
   *  validated here; invalid input refuses the whole create. */
  deltaGate?: unknown;
  /**
   * One-shot CHAIN link (finding B1, 2026-09-27): the id of the schedule whose
   * FIRING is arming this `once` row on its OWN chat — threaded from the run's
   * ToolContext.firedByScheduleId by schedule_self / own-chat schedule_message.
   * Stamped verbatim (after a same-session check) as chainedFromScheduleId;
   * ignored for 'recurring' arms and for non-machine authorship. The chain is
   * walked over a rolling 24h window and a ≥3-link chain is governed as a
   * recurring cadence (schedule-once-chain.ts).
   */
  chainedFromScheduleId?: string;
}

export interface CreateScheduleResult {
  ok: boolean;
  error?: string;
  schedule?: ScheduleView;
  /** True when the duplicate-backstop guard (ticket 1ead3b52) returned an
   *  already-enabled identical row instead of creating a stacked copy. */
  deduped?: boolean;
  /** Non-blocking cap-burn advisory (ticket 2694a581): the arm LANDED, but its
   *  cadence math burns most/all of the chat's daily firing cap — surfaced in
   *  the tool response so the lane can re-space before one-shot schedules and
   *  hook wakes (same counter) start skipping daily_cap. */
  warning?: string;
  /** True when a deduped re-arm CARRYING a delta gate (ticket 0b1dbe75)
   *  (re)armed it on the existing row because it differed from the stored one
   *  (markerless store → the next evaluation fires once to re-baseline). */
  gateUpdated?: boolean;
  /** Ids of same-cadence machine recurring rows this arm ATOMICALLY superseded
   *  in the create transaction (ticket ae20da66) — already cancelled; the
   *  caller must NOT cancel_schedule them again. */
  superseded?: string[];
  /** Finding B3 (2026-09-27): set when the arm-time duration fit STRETCHED a
   *  machine recurring cadence — the intervalSec the caller REQUESTED; the
   *  returned schedule carries the stretched one (≥2× the lane's p50 run
   *  length). The `warning` field says so in prose. */
  stretchedFrom?: number;
}

/** Normalization for the duplicate-backstop guard (ticket 1ead3b52): trim,
 *  collapse whitespace runs, lowercase — a trivial rewrite of the same job
 *  still counts as the same arm. */
function normalizeArmPrompt(p: string): string {
  return String(p ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * One-shot CHAIN link resolution for createSchedule (finding B1, 2026-09-27):
 * a MACHINE `once` arm naming the firing schedule it descends from. Returns
 * null when the arm is not a link (recurring, non-machine, no parent, a
 * parent that is not THIS session's row — a foreign lineage is never stamped).
 * The walk fails OPEN: an error yields null (a plain one-shot, as today).
 */
async function resolveOnceChainLink(
  input: CreateScheduleInput,
  intervalSec: number,
): Promise<{ chainedFrom: string; verdict: OnceChainVerdict; warning: string | undefined } | null> {
  if (input.kind !== 'once' || input.promptSetBy !== 'machine' || !input.chainedFromScheduleId) return null;
  try {
    const parentId = String(input.chainedFromScheduleId);
    const rows = await loadOnceChainRows(input.sessionId);
    if (!rows.some((r) => r.id === parentId)) {
      const parent = await prisma.chatSchedule.findFirst({ where: { id: parentId, sessionId: input.sessionId }, select: { id: true } });
      if (!parent) return null;
    }
    const verdict = walkOnceChain(rows, parentId, Date.now());
    return { chainedFrom: parentId, verdict, warning: onceChainWarning(verdict, intervalSec) };
  } catch (err: any) {
    logger.warn(`coding schedule: once-chain evaluation failed for session ${input.sessionId.slice(0, 8)} (fail-open — plain one-shot): ${err?.message ?? err}`);
    return null;
  }
}

// ── One sweep per supervisor chat (audit 2026-10-06 T4-8, others.md F8) ────
// tt-rd's project supervisor held its STOCK 4 h sweep AND a machine-armed
// "every 3h per OWNER DIRECTIVE" sweep — 15 + 13 sweeps in 43 h with back-to-
// back pairs (the ensure dedupes only stock-opener rows, so a customized
// machine copy stood beside the stock forever). Two deterministic seams, both
// MACHINE/SYSTEM-authored rows only (an owner-armed sweep is the owner's
// cadence — the ensure already treats it as standing in for the stock):
//   - ARM: a machine RECURRING arm on a supervisor chat whose prompt is
//     sweep-shaped, while the chat's STOCK sweep is enabled, creates nothing —
//     refused with the exact update_schedule call that changes the stock
//     sweep's cadence instead (the stock row keeps sweep_triage, the backoff
//     and the doctrine rebuild a custom copy never gets).
//   - HEAL: each stock-sweep firing disables any OTHER machine/system
//     sweep-shaped recurring row on the same chat (lastStatus 'cancelled',
//     schedule_disabled with successorId = the stock row ⇒ non-alarm).
// Kill switch SUPERVISOR_ONE_SWEEP_DISABLED=1 (both seams). Fail-open.

export function supervisorOneSweepDisabled(): boolean { return process.env.SUPERVISOR_ONE_SWEEP_DISABLED === '1'; }

/** "Sweep-shaped": a stock sweep opener, or the word "sweep" within the prompt's first four words (after any leading brackets / labels). Pure. */
export function sweepShapedPrompt(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false;
  if (classifySweepPrompt(prompt)) return true;
  return /^[\s\W]*(?:[\w'’.-]+[\s\W]+){0,3}sweep(?:s|ing)?\b/i.test(prompt.slice(0, 200));
}

/**
 * ARM seam: a machine sweep-shaped recurring arm on a supervisor chat whose
 * STOCK sweep is enabled creates nothing — it is refused with the exact next
 * step (update_schedule on the stock row, whose own guards — the machine
 * floor, owner-set cadences — then apply). The stock row is never edited here
 * (an owner-set stock cadence stays the owner's). Null = proceed with the
 * create. Never throws (fail-open).
 */
async function oneSweepArmRefusal(input: CreateScheduleInput, prompt: string, intervalSec: number): Promise<CreateScheduleResult | null> {
  try {
    if (supervisorOneSweepDisabled()) return null;
    if (input.kind !== 'recurring' || input.promptSetBy !== 'machine' || !sweepShapedPrompt(prompt)) return null;
    const chat = await prisma.crossModelChat.findUnique({ where: { id: input.sessionId }, select: { isSupervisor: true, isProjectSupervisor: true } });
    if (!(chat as any)?.isSupervisor && !(chat as any)?.isProjectSupervisor) return null;
    const rows = await prisma.chatSchedule.findMany({
      where: { sessionId: input.sessionId, kind: 'recurring', enabled: true },
      orderBy: { createdAt: 'asc' },
    });
    const stock = (rows ?? []).find((r: any) => classifySweepPrompt(r.prompt) && (r.maxRuns == null || r.runsCount < r.maxRuns));
    if (!stock) return null;
    const cls = classifySweepPrompt(stock.prompt)!;
    const floorMin = Math.round(stockSweepFloorSec(cls) / 60);
    const currentMin = typeof stock.intervalSec === 'number' ? Math.round(stock.intervalSec / 60) : null;
    const wantMin = Math.round(intervalSec / 60);
    recordLoopMetric({ kind: 'supervisor_sweep_folded', sessionId: input.sessionId, meta: { seam: 'arm', outcome: 'refused_second_sweep', stockId: stock.id, sweep: cls, requestedSec: intervalSec, stockIntervalSec: stock.intervalSec ?? null } });
    logger.info(`coding schedule: second sweep arm refused on supervisor chat ${input.sessionId.slice(0, 8)} — stock sweep ${stock.id} already runs (audit 2026-10-06 T4-8)`);
    return {
      ok: false,
      error: `Refused (one sweep per supervisor): this chat already runs its stock sweep ${stock.id}${currentMin != null ? ` every ${currentMin} min` : ''} — a second sweep schedule would double the wakes, so none was created. To change the sweep cadence${wantMin !== currentMin ? ` to ${wantMin} min` : ''}, call update_schedule({id:"${stock.id}", intervalMinutes:${Math.max(wantMin, floorMin)}})${wantMin < floorMin ? ` (machine floor for stock sweeps: ${floorMin} min)` : ''}; put any extra sweep instructions in your state doc (update_supervisor_state notes) — every sweep reads it.`,
    };
  } catch (err: any) {
    logger.warn(`coding schedule: one-sweep arm check failed open for ${input.sessionId.slice(0, 8)} (the arm proceeds): ${err?.message ?? err}`);
    return null;
  }
}

/** HEAL seam: a stock-sweep firing disables the chat's other machine/system sweep-shaped recurring rows. Returns the ids disabled. Never throws. */
export async function foldDuplicateSweepsAtFire(s: { id: string; sessionId: string; prompt: string; kind: string }): Promise<string[]> {
  try {
    if (supervisorOneSweepDisabled() || s.kind !== 'recurring' || !classifySweepPrompt(s.prompt)) return [];
    const rows = await prisma.chatSchedule.findMany({
      where: { sessionId: s.sessionId, kind: 'recurring', enabled: true, id: { not: s.id } },
      select: { id: true, prompt: true, kind: true, runsCount: true, promptSetBy: true, intervalSec: true },
    });
    const doomed = (rows ?? []).filter((r: any) => r.id !== s.id && !classifySweepPrompt(r.prompt)
      && (r.promptSetBy === 'machine' || r.promptSetBy === 'system') && sweepShapedPrompt(r.prompt));
    const out: string[] = [];
    for (const r of doomed) {
      const res = await prisma.chatSchedule.updateMany({
        where: { id: r.id, enabled: true },
        data: { enabled: false, lastStatus: 'cancelled', cancelledBy: 'machine', disabledAt: new Date() },
      }).catch(() => ({ count: 0 }));
      if (res.count !== 1) continue;
      out.push(r.id);
      const mins = typeof r.intervalSec === 'number' ? Math.round(r.intervalSec / 60) : null;
      await emitScheduleDisabled({ id: r.id, sessionId: s.sessionId, kind: r.kind }, 'cancelled', r.runsCount ?? 0, {
        successorId: s.id,
        detail: `a second sweep schedule on this supervisor chat — folded into the stock sweep ${s.id} (one sweep per supervisor)`,
        successorNote: `It was a SECOND sweep on this supervisor chat — the stock sweep ${s.id} is the one sweep (one sweep per supervisor); the chat is NOT deaf.${mins != null ? ` If its ${mins}-min cadence mattered, set it on the stock sweep: update_schedule({id:"${s.id}", intervalMinutes:${mins}}).` : ''}`,
      }).catch(() => {});
      recordLoopMetric({ kind: 'supervisor_sweep_folded', sessionId: s.sessionId, meta: { seam: 'fire', stockId: s.id, foldedId: r.id, foldedIntervalSec: r.intervalSec ?? null, promptSetBy: r.promptSetBy ?? null } });
      logger.warn(`coding schedule: duplicate sweep ${r.id} on supervisor chat ${s.sessionId.slice(0, 8)} disabled — the stock sweep ${s.id} is the one sweep (audit 2026-10-06 T4-8)`);
    }
    return out;
  } catch (err: any) {
    logger.warn(`coding schedule: duplicate-sweep heal failed open for ${s.id}: ${err?.message ?? err}`);
    return [];
  }
}

/** Create a self-schedule with all guardrails enforced. */
export async function createSchedule(input: CreateScheduleInput): Promise<CreateScheduleResult> {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) return { ok: false, error: 'prompt is required' };
  // Over-length prompts are rejected here — surface an ACTIONABLE error so the
  // caller shortens and retries instead of silently losing the wake (1d4c8a14).
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      error: `prompt too long (${prompt.length} chars; max ${MAX_PROMPT_CHARS}). No schedule was created — shorten it (reference a plan/file instead of pasting long content) and call again.`,
    };
  }
  if (input.kind !== 'once' && input.kind !== 'recurring') return { ok: false, error: "kind must be 'once' or 'recurring'" };

  // ARCHIVED-TARGET-RETIRE (b, 2026-10-20): an archived chat never takes a
  // machine wake (autonomy loop #13), so a schedule armed on it would only be
  // refused at every firing — refuse the ARM with the actionable next step.
  // Fail-open (an unreadable chat arms as before); kill switch
  // ARCHIVED_TARGET_RETIRE_DISABLED=1.
  if (await isArchivedScheduleTarget(input.sessionId)) {
    recordArchivedTargetRetire(input.sessionId, { surface: 'arm', action: 'refused', arm: 'create', kind: input.kind, promptSetBy: input.promptSetBy ?? null, chatId: input.sessionId });
    logger.info(`coding schedule: arm refused on ARCHIVED chat ${input.sessionId.slice(0, 8)} (archived-target-retire)`);
    return { ok: false, error: archivedTargetRefusal(input.sessionId, 'create') };
  }

  let interval = Math.round(Number(input.intervalSec));
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_SEC) {
    return { ok: false, error: `interval must be ≥ ${MIN_INTERVAL_SEC}s (15 min) — the minimum between self-runs` };
  }

  const maxRuns = input.kind === 'once' ? 1 : Math.min(MAX_RUNS, Math.max(1, input.maxRuns ?? MAX_RUNS));

  // Arm-time duration fit (finding B3, 2026-09-27): a MACHINE recurring cadence
  // shorter than 2× this lane's p50 run length is STRETCHED to fit (the row
  // carries the stretched interval; the result says so) — a cadence shorter
  // than the run only busy-skips. Runs BEFORE the cap-cadence guard so every
  // downstream check (cap math, dedup, same-cadence collapse, clock drift)
  // sees the interval the row will actually carry. Owner arms are advised,
  // never overridden. Fail-open.
  let durationWarning: string | undefined;
  let stretchedFrom: number | undefined;
  // First-firing delay (fixer pass on B3, 2026-09-27): the stretch is a
  // RECURRENCE change only — the first firing keeps the REQUESTED delay
  // (min(requested, stretched)), so a lane that ends its run with
  // `schedule_self recurring 15 min` to continue is picked up in 15 min when it
  // is idle; a still-busy lane rides the sweeper's +3-min busy-skip retry
  // (fires within 3 min of going idle — exactly the pre-B3 shape), and the
  // post-fire re-arm (the claim: nextRunAt = firedAt + intervalSec) carries the
  // stretched cadence from then on. SCHEDULE_DURATION_FIT_FIRST_FIRING_STRETCHED=1
  // restores first-firing-waits-the-full-stretched-interval.
  let firstDelaySec = interval;
  if (input.kind === 'recurring') {
    const fit = await durationFitGuard(input.sessionId, interval, input.promptSetBy === 'machine');
    if (fit) {
      durationWarning = fit.warn;
      if (fit.stretched) {
        stretchedFrom = interval;
        interval = fit.intervalSec;
        firstDelaySec = durationFitFirstFiringStretched() ? interval : Math.min(stretchedFrom, interval);
        if (firstDelaySec < interval) {
          durationWarning = `${fit.warn} The FIRST firing keeps your requested delay (+${Math.round(firstDelaySec / 60)} min); the stretched cadence applies from the second firing on.`;
        }
        logger.info(`coding schedule: recurring machine arm for session ${input.sessionId.slice(0, 8)} stretched ${stretchedFrom}s → ${interval}s (first firing +${firstDelaySec}s; p50 run ${Math.round(fit.p50RunMs / 60000)} min over ${fit.samples} runs; finding B3)`);
      }
    }
  }

  // Cap-cadence guard (ticket 2694a581): a recurring cadence whose own
  // projection can NEVER fit the chat's daily firing cap is REFUSED for
  // machine arms (the 15m-at-cap-48 class — the sweeper would skip every
  // firing past the cap and the chat would go deaf to one-shots and hook
  // wakes sharing the counter). Owner arms and ≥75%-of-cap cadences land
  // with a loud warning instead. Placed BEFORE the duplicate-backstop guard
  // so an identical re-arm of an un-fittable cadence gets the actionable
  // refusal, not a silent dedup.
  let cadenceWarning: string | undefined;
  if (input.kind === 'recurring') {
    const verdict = await capCadenceGuard(input.sessionId, interval, maxRuns, input.promptSetBy === 'machine');
    if (verdict?.refuse) {
      logger.info(`coding schedule: recurring arm refused for session ${input.sessionId.slice(0, 8)} — ${interval}s projects ${verdict.effectiveDaily}/day vs cap ${verdict.cap} (ticket 2694a581)`);
      return { ok: false, error: verdict.refuse };
    }
    cadenceWarning = verdict?.warn;
  }

  // One-shot CHAIN (finding B1, 2026-09-27 — bench 66f0b0c9: 29 one-shots in
  // 26h, every one re-armed by the previous firing's run, and NO recurring
  // control ever saw a cadence: dedupe is per kind, dormancy/renew are
  // recurring-only, maxRuns is 1 so the cap-cadence math projects nothing).
  // A MACHINE `once` arm that names the firing schedule it descends from is a
  // chain LINK: stamp chainedFromScheduleId, walk the chain over the rolling
  // 24h window, and once it reaches ONCE_CHAIN_RECURRING_LINKS govern the link
  // as a recurring cadence — here the cap-cadence guard on the chain's
  // OBSERVED cadence (a 15-min delay behind a 40-min run is a ~55-min
  // cadence). OBSERVE-ONLY: the can-never-fit class lands with the ⚠️ CAP
  // MATH warning (the same text an owner arm gets) and a `warned_cap_cadence`
  // metric — never a refusal on a lane's OWN one-shot re-arm (a blocking gate
  // on machine work). The dedupe below also matches an enabled RECURRING
  // twin; the sweeper applies the fire-time dormancy check (observe-only) and
  // the busy-skip accounting. The arm-time dormancy gate is deliberately NOT
  // evaluated: the arming run is itself a live run, so the predicate can
  // never be dormant here. The parent must be a row of THIS session (a
  // foreign id is dropped, never stamped). Telemetry records every stamped
  // link; the walk fails open.
  const chainLink = await resolveOnceChainLink(input, interval);
  const onceChain: OnceChainVerdict | null = chainLink?.verdict ?? null;
  const chainedFrom: string | null = chainLink?.chainedFrom ?? null;
  const chainWarning = chainLink?.warning;
  const chainRecurringLike = onceChain?.recurringLike === true;
  const chainMetricBase = onceChain && chainedFrom
    ? {
        chainedFrom, rootId: onceChain.rootId, links: onceChain.links, recurringLike: onceChain.recurringLike,
        intervalSec: interval, observedCadenceSec: onceChain.observedCadenceSec, cadenceSec: chainCadenceSec(interval, onceChain),
        guardDisabled: false,
      }
    : null;
  if (chainRecurringLike && onceChain) {
    const cadence = chainCadenceSec(interval, onceChain);
    const projected = Math.floor(SECONDS_PER_DAY / cadence);
    // machineActor=false: the owner-arm shape (warn, never refuse) so a lane's
    // own re-arm always lands.
    const verdict = await capCadenceGuard(input.sessionId, cadence, projected, false);
    if (verdict?.warn && verdict.effectiveDaily > verdict.cap) {
      // The can-never-fit class, observed: the arm lands with the CAP MATH
      // warning; the metric names what enforcement would have done.
      logger.info(`coding schedule: one-shot chain link for session ${input.sessionId.slice(0, 8)} can never fit the cap — chain of ${onceChain.links} links at ~${Math.round(cadence / 60)} min projects ${verdict.effectiveDaily}/day vs cap ${verdict.cap}; armed with a warning (observe-only, finding B1)`);
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.SCHEDULE_ONCE_CHAIN, sessionId: input.sessionId, value: onceChain.links, meta: { ...chainMetricBase, outcome: 'warned_cap_cadence', cap: verdict.cap, wouldRefuse: true } });
    }
    cadenceWarning = [cadenceWarning, verdict?.warn].filter(Boolean).join('\n\n') || undefined;
  }

  // Delta gate (ticket 0b1dbe75): recurring-only, strictly validated BEFORE the
  // dedup guard below — an invalid gate refuses the WHOLE arm (a silently-
  // dropped gate would leave the caller believing the cheap-poll skip is armed
  // while burning full runs).
  let deltaGate: DeltaGate | undefined;
  if (input.deltaGate !== undefined) {
    if (input.kind === 'once') {
      return { ok: false, error: 'deltaGate only applies to recurring schedules (a one-shot fires exactly once — there is nothing to skip). No schedule was created — re-arm with kind \'recurring\' or drop deltaGate.' };
    }
    const v = validateDeltaGate(input.deltaGate);
    if (v.error || !v.gate) return { ok: false, error: `${v.error ?? 'invalid deltaGate'} No schedule was created.` };
    deltaGate = v.gate;
  }

  // Duplicate-backstop guard (ticket 1ead3b52): a MACHINE-authored arm whose
  // normalized prompt EXACTLY matches an already-enabled, still-live schedule
  // of the same kind on this session returns the EXISTING row (deduped:true)
  // instead of stacking a copy — the observed churn was a verdict-waiting lane
  // holding TWO enabled once-schedules ~1 min apart for the same backstop job.
  // Machine arms only: an owner-typed schedule is explicit instruction, never
  // second-guessed. "Live" = runsCount < maxRuns (or uncapped): a one-shot
  // that already FIRED stays enabled until the next sweeper tick disables it
  // and must NOT swallow the lane's next-link re-arm. Placed before the
  // active-count cap so a deduped arm never trips the cap either.
  if (input.promptSetBy === 'machine') {
    // A recurring-like chain link (finding B1) ALSO matches an enabled
    // RECURRING twin: a lane that already holds the recurring version of the
    // job must not stack one-shot links beside it.
    const enabledRows = await prisma.chatSchedule.findMany({
      where: { sessionId: input.sessionId, kind: chainRecurringLike ? { in: ['once', 'recurring'] } : input.kind, enabled: true },
    });
    const want = normalizeArmPrompt(prompt);
    const dupe = enabledRows.find((r) =>
      (r.maxRuns == null || r.runsCount < r.maxRuns) && normalizeArmPrompt(r.prompt) === want);
    if (dupe && chainMetricBase) {
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.SCHEDULE_ONCE_CHAIN, sessionId: input.sessionId, value: onceChain?.links ?? 0, meta: { ...chainMetricBase, outcome: 'deduped', dupeId: dupe.id, dupeKind: dupe.kind } });
    }
    if (dupe) {
      // Delta gate (review finding, ticket 0b1dbe75): a deduped re-arm that
      // CARRIES a gate must not silently drop it — (re)arm it on the EXISTING
      // row when it differs from what's stored (platform-maintained marker/
      // checkedAt/lastError are stripped from both sides before comparing, so
      // an identical config never churns a re-baseline). A replaced gate
      // stores markerless probes → the next evaluation FIRES once to
      // re-baseline. An arm WITHOUT a gate leaves the existing row's gate
      // untouched (clearing is update_schedule's explicit job).
      if (deltaGate) {
        const storedBare = validateDeltaGate((dupe as any).deltaGate).gate;
        const differs = JSON.stringify(storedBare ?? null) !== JSON.stringify(deltaGate);
        let row = dupe;
        if (differs) {
          row = await prisma.chatSchedule.update({ where: { id: dupe.id }, data: { deltaGate: deltaGate as any } });
          logger.info(`coding schedule: delta gate (re)armed on deduped row ${dupe.id} (ticket 0b1dbe75)`);
        }
        const [schedule] = await enrichWithCapState([toView(row)], () => input.sessionId);
        return { ok: true, schedule, deduped: true, gateUpdated: differs };
      }
      logger.info(`coding schedule: duplicate ${input.kind} arm deduped for session ${input.sessionId.slice(0, 8)} — returning existing ${dupe.id} (ticket 1ead3b52)`);
      const [schedule] = await enrichWithCapState([toView(dupe)], () => input.sessionId);
      return { ok: true, schedule, deduped: true };
    }
  }

  // One sweep per supervisor chat (audit 2026-10-06 T4-8): a machine
  // sweep-shaped recurring arm beside the enabled stock sweep is refused with
  // the update_schedule next step.
  const secondSweep = await oneSweepArmRefusal(input, prompt, interval);
  if (secondSweep) return secondSweep;

  // Cap active schedules per session.
  const active = await prisma.chatSchedule.count({ where: { sessionId: input.sessionId, enabled: true } });
  if (active >= MAX_ACTIVE_PER_SESSION) {
    return { ok: false, error: `Too many active schedules (${active}/${MAX_ACTIVE_PER_SESSION}) for this session. cancel_schedule one first.` };
  }

  // Goal-gate (ticket b1d435fd, owner directive 2026-09-18): a MACHINE/SYSTEM
  // recurring wake may arm only while its project has live work (an
  // active/blocked goal, an open todo, a live/queued run, or a live watched
  // resource). Arming on a dormant project is refused with the one-line
  // reason — zero-work heartbeats must never START, not just be parked later.
  // Owner-authored arms (promptSetBy 'user') and one-shots are never gated;
  // the predicate fails open on error.
  if (input.kind === 'recurring') {
    const dormancy = await evaluateScheduleDormancy(input.sessionId, input.promptSetBy);
    if (dormancy.dormant) {
      logger.info(`coding schedule: recurring arm refused for session ${input.sessionId.slice(0, 8)} — ${dormancy.reason}`);
      return {
        ok: false,
        error:
          `Refused: ${dormancy.reason}. No schedule was created — a recurring wake may arm only while its project has live work. ` +
          `The wake path for new work is event hooks, not heartbeats. If the owner explicitly wants this monitor anyway, they can arm it themselves (owner-authored schedules are never gated).`,
      };
    }
  }

  const now = Date.now();
  // Clock-drift advisory (ticket 903249e5): a daily-regime (≥12h) cadence that
  // is not day-aligned marches around the clock — the owner's 1219m "daily"
  // digest landed 221 min earlier every firing and woke them at 4 AM. NON-
  // blocking (the arm lands, exactly like the cap-cadence advisory); rides the
  // same `warning` field so every tool surface renders it. Computed AFTER every
  // refusal/dedup exit so only a genuinely-created row carries it.
  const driftWarning = clockDriftWarningFor(input.kind, interval, now);
  // wake-cadence-4 (observe-only prompt lint): a machine-authored prompt that
  // carries a cap-driven successor/hand-off clause gets a notice on the tool
  // result + one loop_metrics row — never a refusal.
  const lint = lintSchedulePrompt(prompt, input.promptSetBy);
  if (lint) {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.SCHEDULE_PROMPT_LINT, sessionId: input.sessionId, meta: { rule: lint.rule, seam: 'create', kind: input.kind } });
  }
  // The one-shot chain advisory (finding B1) rides the same field — the arm
  // LANDS; the lane learns it is now a governed cadence and how to re-shape it.
  const armWarning = [durationWarning, chainWarning, cadenceWarning, driftWarning, lint?.notice].filter(Boolean).join('\n\n') || undefined;
  // (maxRuns is computed above — the cap-cadence guard needs it; deltaGate was
  // strictly validated above, before the dedup guard.)
  //
  // Same-cadence collapse (ticket ae20da66): a MACHINE recurring arm SUPERSEDES
  // every other enabled machine/system recurring row on this session at the
  // SAME interval — in the SAME transaction as the create. The mishap: an
  // agent-driven renewal is two separate tool calls (create-new, then
  // cancel-old); a deploy SIGTERM between them left BOTH 120m sweeps enabled on
  // one chat (the 1ead3b52 dedup guard is prompt-identical-only, and the
  // 5ba5f03e deploy resume brief only bars repeating EXECUTED calls — nothing
  // re-ran the stranded cancel), double-burning the chat's daily cap until a
  // supervisor hand-cancelled. Collapsing at the store makes renewal atomic
  // from the caller's side: create-new IS cancel-old, deploy-safe at any
  // interrupt point. Owner-armed rows ('user') and legacy NULL-promptSetBy rows
  // are NEVER collapsed — explicit instruction is never second-guessed (same
  // doctrine as the dedup guard and the dormancy gate); a genuinely different
  // second job rides a different interval. Placed after the 1ead3b52 dedup
  // guard, so an identical-prompt re-arm still ADOPTS the existing row and
  // never reaches here.
  // A STRETCHED arm skips the collapse (fixer pass on B3, 2026-09-27): the fit
  // erases the interval as the job discriminator the collapse relies on — two
  // different machine jobs requested at 15 and 30 min on a 600-min lane both
  // land at the floor, and the collapse would cancel the older one as a
  // "renewal". The requested cadence is not stored on the row, so no finer
  // discriminator exists: a stretched arm never collapses (the 1ead3b52 dedup
  // still adopts an identical prompt; the +3-min busy-skip retry absorbs any
  // overlap). SCHEDULE_DURATION_FIT_COLLAPSE_STRETCHED=1 restores collapse-at-
  // the-stretched-cadence.
  const collapseSkippedForStretch = stretchedFrom !== undefined && !durationFitCollapseStretched();
  const collapseSameCadence = input.kind === 'recurring' && input.promptSetBy === 'machine' && !collapseSkippedForStretch;
  const { row, superseded } = await prisma.$transaction(async (tx) => {
    const created = await tx.chatSchedule.create({
      data: {
        sessionId: input.sessionId,
        userId: input.userId,
        prompt,
        kind: input.kind,
        intervalSec: interval,
        nextRunAt: new Date(now + firstDelaySec * 1000),
        maxRuns,
        expiresAt: new Date(now + MAX_LIFETIME_MS),
        enabled: true,
        ...(input.promptSetBy ? { promptSetBy: input.promptSetBy } : {}),
        // Owner-subscription marker (ticket 4565991a): persisted VERBATIM from
        // the gated caller — never defaulted here (a plain machine arm stays
        // NULL/unmarked so wake noise can never launder itself into expanded
        // owner-subscribed render).
        ...(input.ownerSubscribed !== undefined ? { ownerSubscribed: input.ownerSubscribed } : {}),
        ...(deltaGate ? { deltaGate: deltaGate as any } : {}),
        // One-shot CHAIN link (finding B1): the firing schedule this machine
        // one-shot descends from — same-session-checked above; NULL otherwise.
        ...(chainedFrom ? { chainedFromScheduleId: chainedFrom } : {}),
      },
    });
    let stale: Array<{ id: string; runsCount: number }> = [];
    if (collapseSameCadence) {
      // Re-read INSIDE the transaction (not the dedup guard's earlier read) so
      // a sibling run's same-cadence arm racing the create is seen too.
      stale = await tx.chatSchedule.findMany({
        where: {
          sessionId: input.sessionId,
          kind: 'recurring',
          enabled: true,
          intervalSec: interval,
          id: { not: created.id },
          promptSetBy: { in: ['machine', 'system'] },
        },
        select: { id: true, runsCount: true },
      });
      if (stale.length) {
        await tx.chatSchedule.updateMany({
          where: { id: { in: stale.map((s) => s.id) } },
          data: { enabled: false, lastStatus: 'cancelled', cancelledBy: 'machine', disabledAt: new Date() },
        });
      }
    }
    return { row: created, superseded: stale };
  });
  logger.info(
    `coding schedule: created ${row.id} (${input.kind}, every ${interval}s${firstDelaySec !== interval ? `, first firing +${firstDelaySec}s` : ''}) for session ${input.sessionId.slice(0, 8)}` +
    (superseded.length ? ` — atomically superseded ${superseded.length} same-cadence row(s): ${superseded.map((s) => s.id).join(', ')} (ticket ae20da66)` : '') +
    (collapseSkippedForStretch ? ' — same-cadence collapse skipped: stretched cadence (fixer B3)' : ''),
  );
  // One schedule_disabled per superseded row, emitted OUTSIDE the transaction
  // (the emission does its own prisma/redis work). successorId = the new row ⇒
  // non-alarm class (hooks.service.isAlarmEvent) and the "lane is NOT deaf"
  // note — this is a routine rollover, not a stopped cadence.
  for (const s of superseded) {
    await emitScheduleDisabled(
      { id: s.id, sessionId: input.sessionId, kind: 'recurring' },
      'cancelled', s.runsCount,
      { successorId: row.id },
    );
  }
  // Lane revival (SA0906): a fresh enabled schedule closes any open
  // stopped-schedule decision on this chat — the successor IS the resolution
  // (named in the resolution note, v1#12; only a RECURRING row counts).
  if (input.kind === 'recurring') await resolveStoppedScheduleDecisionsSafe(input.sessionId, row.id);
  // One-shot chain telemetry (finding B1): every stamped link records, guard
  // on or off — the chain's shape (links / observed cadence) is the signal.
  if (chainMetricBase && onceChain) {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.SCHEDULE_ONCE_CHAIN, sessionId: input.sessionId, value: onceChain.links, meta: { ...chainMetricBase, scheduleId: row.id, outcome: 'armed' } });
    if (chainRecurringLike) {
      logger.info(`coding schedule: ${row.id} is link ${onceChain.links} of a one-shot chain on session ${input.sessionId.slice(0, 8)} (observed cadence ~${Math.round((onceChain.observedCadenceSec ?? interval) / 60)} min) — governed as a recurring cadence (finding B1)`);
    }
  }
  const [schedule] = await enrichWithCapState([toView(row)], () => input.sessionId);
  return {
    ok: true,
    schedule,
    ...(armWarning ? { warning: armWarning } : {}),
    ...(superseded.length ? { superseded: superseded.map((s) => s.id) } : {}),
    ...(stretchedFrom !== undefined ? { stretchedFrom } : {}),
  };
}

/** All schedules for a session (both enabled and finished/cancelled). ENABLED
 *  rows are queried EXPLICITLY and never windowed by the history cap — the old
 *  newest-50 window silently dropped a long-lived ACTIVE recurring schedule
 *  once 50+ newer (mostly terminal) rows accumulated, so list_schedules
 *  reported a live monitor as gone (ticket dd0d37ac; getScheduleHealth below
 *  carries the same fix for the status payload). Terminal history stays capped. */
export async function listSchedules(sessionId: string): Promise<ScheduleView[]> {
  const [enabled, terminal] = await Promise.all([
    prisma.chatSchedule.findMany({ where: { sessionId, enabled: true }, orderBy: { createdAt: 'desc' } }),
    prisma.chatSchedule.findMany({ where: { sessionId, enabled: false }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  // A row flipping enabled between the two parallel reads could land in BOTH
  // halves — dedup by id, active wins (same race handled in
  // listSchedulesForUser). Merged list stays newest-first.
  const byId = new Map<string, (typeof enabled)[number]>();
  for (const s of [...enabled, ...terminal]) if (!byId.has(s.id)) byId.set(s.id, s);
  const rows = [...byId.values()].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  return enrichWithCapState(rows.map(toView), () => sessionId);
}

/** Cancel (disable) a schedule owned by this session. Returns false if not found.
 *  v1#13: stamps cancelledBy + disabledAt. The only production caller is the
 *  workspace-panel Schedules tab (platform.service.cancelChatSchedule — an
 *  explicit OWNER action), so the default attribution is 'owner'; a machine
 *  caller must say so via opts so the digest backstop can re-offer its lane. */
export async function cancelSchedule(sessionId: string, id: string, opts?: { initiator?: 'owner' | 'machine'; actorChatId?: string | null }): Promise<boolean> {
  const row = await prisma.chatSchedule.findFirst({ where: { id, sessionId } });
  if (!row) return false;
  await prisma.chatSchedule.update({
    where: { id },
    data: { enabled: false, lastStatus: 'cancelled', cancelledBy: opts?.initiator ?? 'owner', disabledAt: new Date() },
  });
  logger.info(`coding schedule: cancelled ${id} for session ${sessionId.slice(0, 8)} (initiator ${opts?.initiator ?? 'owner'})`);
  await emitScheduleDisabled({ ...row, sessionId }, 'cancelled', row.runsCount, opts?.actorChatId ? { actorChatId: opts.actorChatId } : undefined);
  return true;
}

/**
 * Ticket bf656696 — the ticket-lane archive deadlock. archiveChat REFUSES
 * while a chat has enabled schedules (platform.service 409 "This chat has
 * enabled schedules — pause or cancel them before archiving"), and a finished
 * ticket lane legitimately leaves schedules behind: the verdict-wait BACKSTOP
 * (schedule_self, ticket 1ead3b52 posture) and other continuation lanes arm
 * ≥20-min one-shots that nobody cancels when the ticket closes. The dispatcher
 * retried the archive every drain (30 min) forever — "not archived yet …
 * retrying next drain" — while the still-armed schedules kept the lane reading
 * LIVE, so its slot never freed: prod sat 3/3 occupied all afternoon with the
 * queue climbing. The dispatcher now pauses the lane's enabled schedules
 * itself (it OWNS the lane chat — it spawned it) before archiving, exactly
 * what an owner would do by hand on the Schedules tab.
 *
 * PAUSE (enabled:false + cancelledBy 'machine'), never DELETE: the row stays
 * inspectable/resumable, and every disable site emits ONE schedule_disabled
 * hook event (the cadence self-noticing doctrine, 2026-08-24 fix 2) so a
 * subscribed supervisor learns the cadence stopped the minute it happens.
 * One event PER ROW — the doctrine is per disable, not per batch. Returns the
 * number paused; never throws (the archive attempt proceeds regardless).
 */
export async function pauseSchedulesForLaneArchive(
  sessionId: string,
  actor: { actorChatId?: string | null; archiveRetire?: { detail: string }; keptLane?: { reason: string } } = {},
): Promise<number> {
  // Lane lifecycle fourth review (2026-10-22): `keptLane` — the dispatcher's
  // pause-ONLY cure for a closed ticket's lane a house rule KEEPS (an owner
  // question, a human in it, …) that was still running past the 30-min window:
  // the rows pause exactly as the plain path does ('lane_archive', alarm-class,
  // never remembered), but the event says the lane is KEPT, never "being archived".
  // ARCHIVED-TARGET-RETIRE (d, 2026-10-20): the coding session API's archive
  // passes archiveRetire — its rows pause as 'paused:archived' with a
  // target_archived (non-alarm) event and are REMEMBERED so a restore re-arms
  // exactly them. The ticket dispatcher's call (no archiveRetire) is unchanged.
  const retire = actor.archiveRetire && !archivedTargetRetireDisabled() ? actor.archiveRetire : null;
  try {
    const rows = await prisma.chatSchedule.findMany({ where: { sessionId, enabled: true } });
    for (const row of rows) {
      await prisma.chatSchedule.update({
        where: { id: row.id },
        data: { enabled: false, lastStatus: retire ? ARCHIVED_SCHEDULE_LAST_STATUS : 'lane_archive', cancelledBy: 'machine', disabledAt: new Date() },
      });
      if (retire) {
        logger.info(`coding schedule: paused ${row.id} for session ${sessionId.slice(0, 8)} (session archived — archived-target-retire)`);
        await emitScheduleDisabled({ id: row.id, sessionId, kind: row.kind }, 'target_archived', row.runsCount, { detail: retire.detail });
        continue;
      }
      logger.info(`coding schedule: paused ${row.id} for session ${sessionId.slice(0, 8)} (lane archive — ticket bf656696${actor.keptLane ? ', lane kept' : ''})`);
      const detail = actor.keptLane
        ? `the ticket dispatcher paused this kept lane's schedules (kept: ${actor.keptLane.reason})`
        : 'the ticket dispatcher archived this lane chat';
      await emitScheduleDisabled(
        { id: row.id, sessionId, kind: row.kind },
        'lane_archive',
        row.runsCount,
        { ...(actor.actorChatId ? { actorChatId: actor.actorChatId } : {}), detail, ...(actor.keptLane ? { keptLane: true } : {}) },
      );
    }
    if (retire && rows.length) {
      await rememberArchivePausedSchedules(sessionId, rows.map((r) => r.id));
      recordArchivedTargetRetire(sessionId, { surface: 'schedule', action: 'paused', seam: 'session_archive', chatId: sessionId, scheduleIds: rows.map((r) => r.id).slice(0, 20) }, rows.length);
    }
    return rows.length;
  } catch (err: any) {
    logger.warn(`coding schedule: lane-archive pause failed for ${sessionId.slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
    return 0;
  }
}

/**
 * ARCHIVED-TARGET-RETIRE (2026-10-20): merge schedule ids into the chat's
 * archive-paused record (read-modify-write, the hooks.service
 * rememberArchivePausedHooks twin). Best-effort — a miss leaves the row for
 * one resume_schedule.
 */
export async function rememberArchivePausedSchedules(chatId: string, ids: string[]): Promise<void> {
  if (!chatId || !ids.length) return;
  try {
    const store = await import('../memory/context-store');
    const prev = await store.storeGet<{ ids?: unknown }>(ARCHIVE_PAUSED_SCHEDULES_NS(chatId), 'ids').catch(() => null);
    const merged = [...new Set([...(Array.isArray(prev?.ids) ? (prev!.ids as unknown[]).map(String) : []), ...ids])];
    await store.storePut(ARCHIVE_PAUSED_SCHEDULES_NS(chatId), 'ids', { ids: merged, at: new Date().toISOString() });
  } catch { /* best-effort */ }
}

/**
 * ARCHIVED-TARGET-RETIRE (2026-10-20) — the RESTORE half: re-enable exactly the
 * schedules the archive paused (the remembered ids that are still this chat's,
 * still disabled and still 'paused:archived' — a row someone cancelled since
 * stays cancelled). Each row resumes through setScheduleEnabledForChat, so the
 * completed / active-cap / stale-nextRunAt / lapsed-expiry rules apply exactly
 * as for an owner resume. Called by every unarchive path (archiveChat restore,
 * the session API's archived:false, the user-turn dispatch heal). Never
 * throws; returns the number resumed.
 */
export async function resumeSchedulesForRestoredChat(chatId: string): Promise<number> {
  if (!chatId || archivedTargetRetireDisabled()) return 0;
  try {
    const store = await import('../memory/context-store');
    const rec = await store.storeGet<{ ids?: unknown }>(ARCHIVE_PAUSED_SCHEDULES_NS(chatId), 'ids');
    const ids = Array.isArray(rec?.ids) ? (rec!.ids as unknown[]).map(String).filter(Boolean) : [];
    if (!ids.length) return 0;
    const rows = await prisma.chatSchedule.findMany({
      where: { id: { in: ids }, sessionId: chatId, enabled: false, lastStatus: ARCHIVED_SCHEDULE_LAST_STATUS },
      select: { id: true },
    });
    const resumed: string[] = [];
    for (const r of rows ?? []) {
      const res = await setScheduleEnabledForChat(chatId, r.id, true, { restore: true }).catch(() => null);
      if (res?.ok && res.changed) resumed.push(r.id);
    }
    await store.storeDelete(ARCHIVE_PAUSED_SCHEDULES_NS(chatId), 'ids').catch(() => {});
    logger.info(`coding schedule: chat ${chatId.slice(0, 8)} restored — re-armed ${resumed.length}/${ids.length} schedule(s) its archive paused (archived-target-retire)`);
    recordArchivedTargetRetire(chatId, { surface: 'schedule', action: 'restored', chatId, scheduleIds: resumed.slice(0, 20), remembered: ids.length }, resumed.length);
    return resumed.length;
  } catch (err: any) {
    logger.warn(`coding schedule: restore-time re-arm for chat ${chatId.slice(0, 8)} failed (non-fatal): ${err?.message ?? err}`);
    return 0;
  }
}

/**
 * Cadence self-noticing (overnight forensics 2026-08-24, fix 2): EVERY site
 * that flips a schedule to enabled:false emits ONE schedule_disabled hook
 * event, so a subscribed supervisor learns a cadence stopped the minute it
 * happens — the TT-RD session cancelled its own recurring watch after a
 * self-audit and NOTHING noticed until the owner did. Payload carries
 * {scheduleId, sessionId, kind, runsCount, reason}; delivery/dedupe/depth all
 * ride the existing hook outbox. Best-effort via the dynamic-import seam —
 * emission must never break the disable it reports.
 */
export type ScheduleDisabledReason = 'cancelled' | 'charter_done' | 'containment' | 'expired' | 'lane_archive' | 'max_runs' | 'obsolete' | 'paused' | 'probes_missing' | 'provider_failures' | 'parked_dormant' | 'target_archived' | 'workspace_missing';
/**
 * audit 2026-10-06 T4-2 (others.md F6): the ACTOR of a disable — the chat whose
 * RUN cancelled / paused the schedule (cancel_schedule / pause_schedule tools);
 * null/absent for the owner UI, REST and every system path (dormancy park,
 * renewal, caps). It rides the hook emission as the route-control field
 * `actorChatId` (HookEmitExtra): hooks.service skips a hook whose target IS the
 * actor (actor-echo suppression — a supervisor is never woken by its own
 * cancel) and the hooks team consumes it for the fleet-forward rule. Kill
 * switch SCHEDULE_DISABLED_ACTOR_DISABLED=1 drops the field (pre-fix emission
 * byte-for-byte). Read per call.
 */
export function scheduleDisabledActorDisabled(): boolean {
  return process.env.SCHEDULE_DISABLED_ACTOR_DISABLED === '1';
}

export async function emitScheduleDisabled(
  s: { id: string; sessionId: string; kind: string },
  reason: ScheduleDisabledReason,
  runsCount: number,
  opts?: { successorId?: string; detail?: string; actorChatId?: string | null; successorNote?: string; keptLane?: boolean },
): Promise<void> {
  // Deaf-lane suffix (2026-08-30 Post-CPT incident): a cancel that leaves the
  // chat with ZERO enabled schedules reads as routine cleanup in the supervisor
  // wake that consumes this summary — while the lane is actually deaf until
  // re-armed. Say so explicitly. Best-effort: never break the disable we report.
  // 'paused' (REST Schedules tab) gets the same suffix: a paused last schedule
  // leaves the lane exactly as deaf until the owner resumes it.
  let suffix = '';
  let remainingEnabled: number | undefined;
  if (reason === 'cancelled' || reason === 'paused' || reason === 'containment') {
    try {
      remainingEnabled = await prisma.chatSchedule.count({ where: { sessionId: s.sessionId, enabled: true } });
      if (remainingEnabled === 0) {
        suffix = ' The chat now has NO enabled schedules — if it runs standing work (monitors, assigned goal todos), it is DEAF until a new schedule is armed.';
      }
    } catch { /* suffix is advisory only */ }
  }
  // ALARM-CAUSE-AWARE (supervisor SOTA 2026-10-20, platform/alarm-cause.ts): a
  // stop whose ACTOR is the lane itself while something still DRIVES the lane
  // (another enabled schedule or a queued run — the lane's own RUNNING run,
  // which is the one stopping it, does not count) is not a smoke detector: the
  // payload carries stoppedByChatId + laneLiveWork and
  // hooks.service.isAlarmEvent makes the row quiet. An assigned todo never
  // counts, and a stop that leaves ZERO enabled schedules (the DEAF suffix
  // above) is never quiet whatever else is queued (review fix 2026-10-20: a
  // lane cancelling its last watch while holding an in_progress todo is the
  // TT-RD deaf-lane case, and this alarm is its only immediate signal — SA0906
  // never files for a lane that stopped its own row). A lookup error leaves
  // laneLiveWork unset (the alarm stands). HOOK_ALARM_CAUSE_AWARE_DISABLED=1.
  const actorForPayload = opts?.actorChatId && !scheduleDisabledActorDisabled() ? opts.actorChatId : null;
  let selfStopFacts: { stoppedByChatId: string; laneLiveWork: boolean } | null = null;
  if (actorForPayload && actorForPayload === s.sessionId && !opts?.successorId && !hookAlarmCauseAwareDisabled()) {
    try {
      const { readLaneDriveFacts, isLaneSelfDriving } = await import('../platform/lane-self-driving');
      const [facts] = await readLaneDriveFacts([s.sessionId], new Date(), { horizonMs: null, countRunning: false });
      selfStopFacts = { stoppedByChatId: actorForPayload, laneLiveWork: remainingEnabled !== 0 && !!facts && isLaneSelfDriving(facts) };
    } catch { selfStopFacts = null; }
  }
  // renewOnExhaustion successor (v1#14): when the disable already armed a
  // same-cadence successor, this event is a routine rollover — the payload
  // carries successorId, which hooks.service.isAlarmEvent reads to strip the
  // alarm carve-outs (cap bypass / debounce bypass / frozen-attempt park).
  const successorNote = opts?.successorId
    ? (opts.successorNote ? ` ${opts.successorNote}` : ` A same-cadence successor schedule ${opts.successorId} is already armed — the lane is NOT deaf; no action needed.`)
    // Governor refusal (finding B2): a max_runs stop with NO successor and a
    // detail is a refused self-renewal — say why, so the woken supervisor
    // judges "re-arm or let it rest" instead of reflexively re-arming.
    : (reason === 'max_runs' && opts?.detail ? ` ${opts.detail}.` : '');
  await emitHookEventSafe(
    s.sessionId, 'schedule_disabled',
    reason === 'parked_dormant'
      // Goal-gate (ticket b1d435fd): a policy park, NOT a terminal stop — the
      // one-line dormancy reason IS the message; no DEAF suffix (dormant-by-
      // design is the desired state), no "will NOT fire again on its own"
      // (the lane's ensure re-arms it once the project has live work again).
      ? `Schedule ${s.id} (${s.kind}) auto-parked after ${runsCount} run(s) — ${opts?.detail ?? 'its project is dormant (no live work)'}. It stays parked while the project is dormant; event hooks (not heartbeats) are the wake path when work appears, and the owner can resume it any time.`
      : reason === 'lane_archive' && opts?.keptLane
      // Lane lifecycle fourth review (2026-10-22): the pause-ONLY cure on a lane a
      // house rule keeps — the chat is NOT being archived.
      ? `Schedule ${s.id} (${s.kind}) paused by the ticket dispatcher after ${runsCount} run(s) — its ticket is closed and the lane chat was still running 30 min later, so its leftover machine schedules were paused (bf656696); the chat itself is KEPT (${opts?.detail ?? 'a house rule keeps it'}) and is NOT archived. Resume this row (resume_schedule) if the lane still needs it.`
      : reason === 'lane_archive'
      // bf656696: the ticket dispatcher retiring a FINISHED lane chat — the
      // row is paused (resumable), the chat it belonged to is archived, so no
      // DEAF suffix (deafness is moot on a retired chat).
      ? `Schedule ${s.id} (${s.kind}) paused by the ticket dispatcher after ${runsCount} run(s) — its lane chat is being archived now that the ticket is closed (ticket-dispatch, bf656696). It will not fire again; the paused row stays inspectable on the chat.`
      : reason === 'target_archived'
      // ARCHIVED-TARGET-RETIRE (2026-10-20): the chat is archived — a stop, so
      // the row is paused (resumable) instead of being refused at every
      // firing. No DEAF suffix (deafness is moot on an archived chat); the
      // payload reason makes the event non-alarm (hooks.service isAlarmEvent).
      ? `Schedule ${s.id} (${s.kind}) paused after ${runsCount} run(s) — its chat is ARCHIVED (an archive is a stop; machine wakes never revive it)${opts?.detail ? `: ${opts.detail}` : ''}. Nothing to do unless the lane should come back — restoring the chat re-arms this schedule automatically.`
      : reason === 'charter_done'
      // ALLCOMPLETE-CHARTER-TERMINATION (2026-10-20, opt-in SCHEDULE_CHARTER_TERMINATION_ENFORCE):
      // the lane's charter is finished and its board has stayed 100% complete — a pause, never a cancel.
      ? `Schedule ${s.id} (${s.kind}) paused after ${runsCount} run(s) — its lane's charter is finished (${opts?.detail ?? 'charter done'}) and its plan board has been 100% complete with nothing changed since the last firing, so further firings would only re-audit a finished board. Resume it (resume_schedule) if the lane still has standing work, give the lane a new charter todo, or let it rest.`
      : reason === 'paused'
      ? `Schedule ${s.id} (${s.kind}) disabled — paused by the owner after ${runsCount} run(s). It will NOT fire again until the owner resumes it.${suffix}`
      : `Schedule ${s.id} (${s.kind}) disabled — ${reason} after ${runsCount} run(s). It will NOT fire again on its own.${successorNote}${suffix}`,
    {
      scheduleId: s.id, sessionId: s.sessionId, kind: s.kind, runsCount, reason,
      ...(opts?.successorId ? { successorId: opts.successorId } : {}),
      ...(opts?.detail ? { detail: opts.detail } : {}),
      ...(opts?.keptLane ? { keptLane: true } : {}),
      ...(remainingEnabled !== undefined ? { remainingEnabled } : {}),
      ...(opts?.actorChatId && !scheduleDisabledActorDisabled() ? { actorChatId: opts.actorChatId } : {}),
      ...(selfStopFacts ?? {}),
    },
  );
}

/**
 * schedule_near_cap emission (ticket b4d1096c): the PRE-emptive counterpart of
 * emitScheduleDisabled — one hook event per schedule row, fired by the sweeper
 * when scheduleNearCapCause first trips (deduped by the nearCapAlertedAt
 * atomic stamp, claimed by the caller BEFORE this runs). The payload's
 * willAutoRenew is the renewOnExhaustion CONFIG derivation (machine/system
 * rows renew by default, user rows stop by design) so the woken supervisor
 * knows whether "re-arm a replacement" is even its job; the runtime dormancy
 * gate still applies at exhaustion and is not pre-computed here.
 * Best-effort via the same dynamic-import seam — emission never breaks the
 * firing it precedes.
 */
export async function emitScheduleNearCap(
  s: { id: string; sessionId: string; kind: string; runsCount: number; maxRuns: number | null; expiresAt: Date | null; promptSetBy?: string | null; renewOnExhaustion?: boolean | null; renewedFromId?: string | null; ownerSubscribed?: boolean | null },
  cause: ScheduleNearCapCause,
): Promise<void> {
  const configRenew = s.renewOnExhaustion ?? (s.promptSetBy === 'machine' || s.promptSetBy === 'system');
  // Governor preview (review-fixer 2026-09-27): the near-cap event used to
  // promise "auto-renew is ON — no action needed" from the row's config alone,
  // so a chain the governor was about to refuse told the supervisor NOT to
  // act and the lane then stopped. A machine/system row whose config says
  // "renew" is now asked what the self-re-arming governor WILL do at
  // exhaustion. A refusal flips the wording to OFF + the reason so the
  // supervisor re-arms deliberately BEFORE the stop; an observe-only anchor
  // miss keeps ON and adds a note. Any error ⇒ the config derivation (as before).
  let willAutoRenew = !!configRenew;
  let preview: RenewRefusal = {};
  let previewVerdict: 'renew' | 'refuse' | 'observed' = 'renew';
  if (configRenew && renewalGoverned(s)) {
    try {
      const v = await renewalGovernor(s, preview);
      if (!v.renew) { willAutoRenew = false; previewVerdict = 'refuse'; }
      else if (v.observed) previewVerdict = 'observed';
    } catch {
      preview = {};
      previewVerdict = 'renew';
    }
  }
  const renewNote = previewVerdict === 'refuse'
    ? ` Auto-renew (renewOnExhaustion) is configured ON but the self-re-arming governor WILL REFUSE the successor at exhaustion — ${preview.reason ?? preview.kind ?? 'refused'}. The lane goes SILENT at the cap unless a replacement is armed deliberately (schedule_self / schedule_message a fresh row and say why); re-arm NOW if this cadence still matters.`
    : willAutoRenew
    ? ` Auto-renew (renewOnExhaustion) is ON — a same-cadence successor arms at exhaustion; no action needed unless the cadence should change or stop.${previewVerdict === 'observed' && preview.observedReason ? ` Governor note (observe-only today — the successor still arms): ${preview.observedReason}.` : ''}`
    : ' Auto-renew is OFF — the lane goes SILENT at the cap unless a replacement is armed (schedule_message a fresh row, or cancel+recreate); re-arm NOW if this cadence still matters.';
  const summary = cause === 'run_cap'
    ? `Schedule ${s.id} (recurring) is NEAR its run cap: ${s.runsCount}/${s.maxRuns} runs burned (≥90%).${renewNote}`
    : `Schedule ${s.id} (recurring) is NEAR its lifetime expiry: ${s.expiresAt ? s.expiresAt.toISOString() : 'unknown'} — under ${Math.round(NEAR_EXPIRY_WINDOW_MS / 86_400_000)} day(s) left. A FIRING recurring schedule slides its expiry 30 days past its last run, so a row this close is not firing — investigate the lane.${renewNote}`;
  await emitHookEventSafe(s.sessionId, 'schedule_near_cap', summary, {
    scheduleId: s.id, sessionId: s.sessionId, kind: s.kind, cause,
    runsCount: s.runsCount, maxRuns: s.maxRuns ?? null,
    expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null,
    willAutoRenew: !!willAutoRenew,
    // wake-cadence-4: a NON-renewing row alerts at 80 % (schedule-near-cap
    // nearCapFractionFor) and is the owner-visible class — renewing rows are a
    // non-event for the owner (their successor arms itself).
    ownerVisible: !willAutoRenew,
    ...(previewVerdict === 'refuse' && preview.kind ? { renewRefusalKind: preview.kind } : {}),
    ...(previewVerdict === 'observed' && preview.observedKind ? { renewGovernorObserved: preview.observedKind } : {}),
  });
}

/**
 * renewOnExhaustion (v1#14 / spark G1 / CanLaw L1): a machine/self-created
 * RECURRING schedule that spends its final allowed run (runsCount reaching
 * maxRuns) arms a same-cadence SUCCESSOR row instead of letting the lane go
 * deaf — MAX_RUNS is a runaway bound, not a work order to stop. Called BEFORE
 * emitScheduleDisabled so the disable event can carry successorId (and thereby
 * lose its alarm class — hooks.service.isAlarmEvent).
 *
 * Default: row.renewOnExhaustion when set; NULL derives TRUE only for
 * machine/system-authored recurring rows (promptSetBy 'machine' | 'system') —
 * a USER-created maxRuns is a deliberate stop and stays terminal.
 *
 * Idempotency (deploy-boundary proof): the successor stamps
 * renewedFromId = the exhausted row's id, which is DB-UNIQUE — two racing
 * sweepers (blue+green, or the fired-final and already-at-cap branches on
 * consecutive ticks) can never double-create: the read-check catches the
 * common case and the unique index P2002s the race loser, which then re-reads
 * and reports the winner's successor.
 *
 * Duplicate guard (ticket eb710676): the renewedFromId key cannot see a
 * MANUAL/STEERED replacement (it stamps none) — an enabled, still-live
 * recurring row with the same normalized prompt is ADOPTED as the successor
 * instead of stacking a second identical loop on the lane (arm-path parity,
 * ticket 1ead3b52). The exhausted row itself is excluded explicitly
 * (r.id !== s.id): since the f24 crash-window fix BOTH call sites reach here
 * BEFORE their disable write (renewal-first ordering), so the row is still
 * enabled:true at scan time and that clause is LOAD-BEARING — without it the
 * exhausted row would ADOPT ITSELF as its own successor.
 */
/** Out-param for maybeRenewOnExhaustion: `kind`/`reason` are set ONLY when the
 *  renewal was REFUSED by the self-re-arming governor (finding B2) so the call
 *  sites can name the reason in the 🛑 stop note + the schedule_disabled
 *  event. `observedKind`/`observedReason` carry an OBSERVE-ONLY anchor miss
 *  (review-fixer 2026-09-27: the successor still armed; telemetry only).
 *  `generation` is filled whenever the chain walk succeeded. Dormancy /
 *  user-row nulls leave it untouched (those are not refusals of a
 *  renewal that would otherwise have happened under the pre-B2 contract). */
export interface RenewRefusal {
  kind?: 'generation_cap' | 'no_anchor';
  reason?: string;
  generation?: number;
  /** Observe-only verdict (anchor not enforced): what WOULD have refused. */
  observedKind?: 'no_anchor';
  observedReason?: string;
  /** Root author of the renewedFromId chain when the walk reached it. */
  rootPromptSetBy?: string | null;
  /** Crash-window fix (shortfall hunt f24): id of the successor row THIS call
   *  CREATED — set only on the fresh-create path (adoption, idempotent-existing
   *  and P2002-winner returns leave it unset). The fired-final call site arms
   *  the successor BEFORE its disable write and uses this to undo a FRESH
   *  successor when the post-fire bump loses to a mid-fire cancel
   *  (bump.count===0): a deliberate cancel must never be resurrected. */
  createdId?: string;
}

/** Governor verdict: `renew` false ⇒ refused (out.kind/reason set); `observed`
 *  true ⇒ renews, but an observe-only rule would have refused (out.observed*). */
export interface RenewGovernorVerdict { renew: boolean; observed?: boolean }

/** Chain facts from walking the UNIQUE renewedFromId links. */
export interface RenewalChainInfo {
  /** 0 for a root; N for the N-th successor; capped at `limit` ("≥ limit"). */
  generation: number;
  /** True when the walk reached a row with no parent (the root) — false when
   *  it stopped at `rootLimit` hops with links still ahead. */
  rootReached: boolean;
  /** The root row's promptSetBy when reached (undefined = not reached). */
  rootPromptSetBy?: string | null;
  /** The root row's explicit renewOnExhaustion when reached. */
  rootRenewOnExhaustion?: boolean | null;
}

/** Bound on the root-author walk (review-fixer 2026-09-27): only the REFUSAL
 *  path walks past the cap — a chain under the cap reaches its root inside the
 *  cap+1 window at no extra cost. */
export const RENEW_ROOT_WALK_LIMIT = 64;

/**
 * Walk a schedule row's renewOnExhaustion chain (review-fixer 2026-09-27 —
 * generalises `renewalGeneration`): generation 0 for a root (renewedFromId
 * null), N for the N-th successor, counted up to `limit` hops (the cap only
 * needs "≥ cap", never the exact depth); the walk itself may continue past
 * `limit` up to `rootLimit` hops to learn WHO armed the root (its
 * promptSetBy) — the owner-root exemption needs it, and only the refusal path
 * asks for a `rootLimit` above `limit`. `renewedFromId` undefined on the input
 * = the caller did not select it → one lookup. Throws on a DB error — the
 * governor treats that as unknown (fail-open).
 */
export async function renewalChain(
  s: { id: string; renewedFromId?: string | null; promptSetBy?: string | null; renewOnExhaustion?: boolean | null },
  limit: number = renewMaxGenerations() + 1,
  rootLimit: number = limit,
): Promise<RenewalChainInfo> {
  let parentId: string | null | undefined = s.renewedFromId;
  if (parentId === undefined) {
    const row = await prisma.chatSchedule.findUnique({ where: { id: s.id }, select: { renewedFromId: true } });
    parentId = row?.renewedFromId ?? null;
  }
  if (!parentId) {
    return { generation: 0, rootReached: true, rootPromptSetBy: s.promptSetBy ?? null, rootRenewOnExhaustion: s.renewOnExhaustion ?? null };
  }
  let generation = 0;
  let hops = 0;
  const maxHops = Math.max(limit, rootLimit);
  const seen = new Set<string>([s.id]);
  let last: { renewedFromId: string | null; promptSetBy?: string | null; renewOnExhaustion?: boolean | null } | null = null;
  while (parentId && hops < maxHops) {
    hops += 1;
    if (generation < limit) generation += 1;
    if (seen.has(parentId)) break; // defensive — the UNIQUE key makes cycles impossible
    seen.add(parentId);
    const parent: { renewedFromId: string | null; promptSetBy?: string | null; renewOnExhaustion?: boolean | null } | null =
      await prisma.chatSchedule.findUnique({ where: { id: parentId }, select: { renewedFromId: true, promptSetBy: true, renewOnExhaustion: true } });
    last = parent;
    parentId = parent?.renewedFromId ?? null;
  }
  const rootReached = !parentId;
  return {
    generation,
    rootReached,
    ...(rootReached ? { rootPromptSetBy: last?.promptSetBy ?? null, rootRenewOnExhaustion: last?.renewOnExhaustion ?? null } : {}),
  };
}

/**
 * Generation of a schedule row in its renewOnExhaustion chain: 0 for a root
 * (renewedFromId null), N for the N-th successor. Derived by walking the
 * UNIQUE renewedFromId links (bounded at `limit` hops — the cap only needs to
 * know "≥ cap", never the exact depth of a long chain). `renewedFromId`
 * undefined on the input = the caller did not select it → one lookup.
 * Throws on a DB error — the governor treats that as unknown (fail-open).
 */
export async function renewalGeneration(
  s: { id: string; renewedFromId?: string | null },
  limit: number = renewMaxGenerations() + 1,
): Promise<number> {
  return (await renewalChain(s, limit, limit)).generation;
}

/** Owner-authored root (review-fixer 2026-09-27): `user` or a legacy NULL
 *  stamp — the same convention the dormancy gate and the stopped-schedule
 *  alert use for "the owner chose this heartbeat". */
export function isOwnerAuthoredStamp(promptSetBy: string | null | undefined): boolean {
  return promptSetBy == null || promptSetBy === 'user';
}

/** Is this exhausted row in the governor's scope at all? Machine/system rows
 *  only; an owner-subscribed digest (ticket 4565991a) is owner instruction and
 *  is never governed even though its successors are stamped 'system'. */
export function renewalGoverned(s: { promptSetBy?: string | null; ownerSubscribed?: boolean | null }): boolean {
  if (s.ownerSubscribed === true) return false;
  return s.promptSetBy === 'machine' || s.promptSetBy === 'system';
}

/**
 * Self-re-arming governor (finding B2; review-fixer 2026-09-27): may THIS
 * machine/system row arm a fresh successor? Returns {renew:true} (renew),
 * {renew:false} with `out.kind/reason` filled (refused), or {renew:true,
 * observed:true} with `out.observedKind/observedReason` (an observe-only rule
 * would have refused — the successor still arms). Every check is fail-open —
 * any lookup error renews as before — and every check skips supervisor chats
 * (their sweeps are framework heartbeats parked by the dormancy gate and
 * re-armed by the ensure, never a runaway lane watch) and chains whose ROOT
 * was armed by the owner (a successor is stamped 'system', so from generation
 * 1 on the exhausted row itself never says 'user' — the chain's root does).
 */
async function renewalGovernor(
  s: { id: string; sessionId: string; renewedFromId?: string | null; promptSetBy?: string | null; renewOnExhaustion?: boolean | null },
  out: RenewRefusal,
): Promise<RenewGovernorVerdict> {
  let chat: { projectId: string | null; isSupervisor?: boolean | null; isProjectSupervisor?: boolean | null } | null = null;
  try {
    chat = await prisma.crossModelChat.findUnique({
      where: { id: s.sessionId },
      select: { projectId: true, isSupervisor: true, isProjectSupervisor: true },
    }) as any;
  } catch (err: any) {
    logger.warn(`coding schedule: renewal governor chat lookup failed for ${s.id} (fail-open — renewing): ${err?.message ?? err}`);
    return { renew: true };
  }
  if (!chat) return { renew: true }; // row missing — fail-open
  if ((chat as any).isSupervisor === true || (chat as any).isProjectSupervisor === true) return { renew: true };
  const max = renewMaxGenerations();
  // Chain walk: bounded at cap+1 for the generation; the root author is read
  // in the same pass when the root lies inside that window (every chain under
  // the cap) and, for a chain at/over the cap, in a second bounded stretch of
  // the same walk (RENEW_ROOT_WALK_LIMIT) — only the would-refuse path pays it.
  let chainInfo: RenewalChainInfo | null = null;
  try {
    chainInfo = await renewalChain(s, max + 1, max + 1);
    if (!chainInfo.rootReached) chainInfo = await renewalChain(s, max + 1, RENEW_ROOT_WALK_LIMIT);
  } catch (err: any) {
    logger.warn(`coding schedule: renewal generation walk failed for ${s.id} (fail-open on the cap — anchor still judged): ${err?.message ?? err}`);
  }
  if (chainInfo) {
    out.generation = chainInfo.generation;
    if (chainInfo.rootReached) out.rootPromptSetBy = chainInfo.rootPromptSetBy ?? null;
    // Owner-root exemption: the chain was armed by the owner (a 'user' or
    // legacy-NULL root, incl. an explicit renewOnExhaustion:true) — owner
    // instruction is never governed, at any depth, anchored or not.
    if (chainInfo.rootReached && chainInfo.generation > 0 && isOwnerAuthoredStamp(chainInfo.rootPromptSetBy)) {
      return { renew: true };
    }
  }
  if (chainInfo) {
    const generation = chainInfo.generation;
    if (generation >= max) {
      out.kind = 'generation_cap';
      out.reason = `auto-renew generation cap reached (this row is renewal ${generation} of ${max} allowed — RENEW_MAX_GENERATIONS); the watch has re-armed itself ${generation} time(s) without a deliberate re-arm. If it still matters, arm it fresh with schedule_self / schedule_message and say why in the prompt`;
      return { renew: false };
    }
  }
  // Anchor: generation ≥ 1 only — a root's FIRST renewal is the pre-B2
  // contract. "Root" is known from the selected link (null) or the walk (0);
  // an unselected link with a failed walk is unknown ⇒ skipped (fail-open).
  const knownRoot = s.renewedFromId === null || (chainInfo != null && chainInfo.generation === 0);
  const knownSuccessor = (typeof s.renewedFromId === 'string' && s.renewedFromId.length > 0) || (chainInfo != null && chainInfo.generation > 0);
  if (chat.projectId && !knownRoot && knownSuccessor) {
    try {
      const now = new Date();
      const [activeGoals, liveWatched, openArtifacts] = await Promise.all([
        prisma.projectGoal.count({ where: { projectId: chat.projectId, status: { in: ['active', 'blocked'] } } }),
        prisma.watchedResource.count({ where: { projectId: chat.projectId, OR: [{ reservationEndsAt: null }, { reservationEndsAt: { gt: now } }] } }),
        prisma.trainingArtifact.count({ where: { projectId: chat.projectId, durableVerifiedAt: null } }),
      ]);
      if ((Number(activeGoals) || 0) === 0 && (Number(liveWatched) || 0) === 0 && (Number(openArtifacts) || 0) === 0) {
        const reason = 'nothing left to watch — the project has no active/blocked goal, no live watched-resource registration (register_watched_resource) and no registered artifact awaiting verify_durable (register_artifact), so a self-armed watch has no open anchor to renew against. Re-open the goal, register the resource or the artifact before re-arming';
        if (renewAnchorCheckEnforced()) {
          out.kind = 'no_anchor';
          out.reason = reason;
          return { renew: false };
        }
        out.observedKind = 'no_anchor';
        out.observedReason = reason;
        return { renew: true, observed: true };
      }
    } catch (err: any) {
      logger.warn(`coding schedule: renewal anchor check failed for ${s.id} (fail-open — renewing): ${err?.message ?? err}`);
    }
  }
  return { renew: true };
}

export async function maybeRenewOnExhaustion(s: {
  id: string; sessionId: string; userId: string; prompt: string; kind: string;
  intervalSec: number | null; maxRuns: number | null;
  promptSetBy?: string | null; renewOnExhaustion?: boolean | null;
  requiredProbes?: unknown;
  /** Owner-subscription marker (ticket 4565991a) — inherited by the successor row. */
  ownerSubscribed?: boolean | null;
  /** Chain link (finding B2): undefined = not selected → looked up; null = root. */
  renewedFromId?: string | null;
}, out: RenewRefusal = {}): Promise<string | null> {
  try {
    if (s.kind !== 'recurring') return null;
    const shouldRenew = s.renewOnExhaustion ?? (s.promptSetBy === 'machine' || s.promptSetBy === 'system');
    if (!shouldRenew) return null;
    // Goal-gate (ticket b1d435fd): the successor is a machine recurring wake —
    // renewing onto a DORMANT project would re-arm a zero-work heartbeat
    // forever. Refuse the renewal; the exhausted row still expires/terminates
    // normally (no successorId on the disable event). Fail-open via the
    // predicate (an evaluation error renews as before).
    const dormancy = await evaluateScheduleDormancy(s.sessionId, s.promptSetBy);
    if (dormancy.dormant) {
      logger.info(`coding schedule: successor renewal refused for ${s.id} — ${dormancy.reason}`);
      return null;
    }
    const existing = await prisma.chatSchedule.findFirst({ where: { renewedFromId: s.id }, select: { id: true } });
    if (existing) return existing.id; // already renewed (earlier tick / peer instance)
    // Duplicate guard (ticket eb710676): a MANUAL/STEERED replacement stamps no
    // renewedFromId, so the idempotency key above cannot see it — without this
    // check a supervisor-steered re-arm of the same prompt PLUS this
    // auto-successor leaves the lane running TWO identical loops (double burn,
    // duplicate work — the live shape the ticket documented: a steered manual
    // re-arm queued while the exhausted row approached its cap). Arm-path
    // parity (ticket 1ead3b52): an enabled, still-live recurring row on this
    // session with the same normalized prompt IS the renewal — adopt it.
    // "Live" = runsCount < maxRuns (or uncapped): a spent row awaiting the
    // sweeper's disable must not swallow the renewal. The exhausted row is
    // excluded explicitly (r.id !== s.id): since the f24 crash-window fix
    // BOTH call sites reach here BEFORE their disable write (renewal-first
    // ordering), so this row is still enabled:true in the scan above — the
    // clause is LOAD-BEARING, not defense-in-depth: without it the exhausted
    // row would ADOPT ITSELF as its own successor.
    const enabledRows = await prisma.chatSchedule.findMany({
      where: { sessionId: s.sessionId, kind: 'recurring', enabled: true },
      // requiredProbes/expiresAt ride the select for the adoption repairs
      // below (ticket feaca3e8) — a bare adopt could otherwise carry the
      // renewal on a gate-less or near-expiry row.
      select: { id: true, prompt: true, maxRuns: true, runsCount: true, requiredProbes: true, expiresAt: true },
    });
    const want = normalizeArmPrompt(s.prompt);
    const dupe = enabledRows.find((r) =>
      r.id !== s.id && (r.maxRuns == null || r.runsCount < r.maxRuns) && normalizeArmPrompt(r.prompt) === want);
    if (dupe) {
      // Adoption repairs (ticket feaca3e8): the adopted row IS the successor,
      // so it must carry the same contract a fresh arm creates below —
      //  (c) probe-gate parity (P7 G13): inherit the parent's requiredProbes
      //      when the dupe has none — a gate-less adoption would carry the
      //      renewal silently, un-gating a probe-gated lane. A dupe with its
      //      OWN probes keeps them (deliberately armed).
      //  (e) lifetime parity: refresh expiresAt to the standard lifetime a
      //      created successor gets — a near-expiry dupe adopted as-is would
      //      die hours later (expiry NEVER renews; only the max_runs branches
      //      call here) and the lane goes deaf again. Adopt-and-repair (not
      //      skipping the candidate) keeps the eb710676 double-burn guard
      //      intact: skipping would stack a duplicate loop for the overlap
      //      window. A null expiresAt (never-expires) is left untouched.
      // Best-effort: a failed repair must not break the adoption — the lane
      // staying alive dominates (fail-open, same as the outer catch).
      const repair: { requiredProbes?: Prisma.InputJsonValue; expiresAt?: Date } = {};
      if (s.requiredProbes != null && dupe.requiredProbes == null) {
        repair.requiredProbes = s.requiredProbes as Prisma.InputJsonValue;
      }
      if (dupe.expiresAt != null) {
        repair.expiresAt = new Date(Date.now() + MAX_LIFETIME_MS);
      }
      if (Object.keys(repair).length > 0) {
        await prisma.chatSchedule.update({ where: { id: dupe.id }, data: repair }).then(() => {
          logger.info(`coding schedule: renewOnExhaustion repaired adopted ${dupe.id} (${Object.keys(repair).join('+')}, ticket feaca3e8)`);
        }).catch((err: any) => {
          logger.warn(`coding schedule: renewOnExhaustion adoption repair failed for ${dupe.id} (adopting anyway): ${err?.message ?? err}`);
        });
      }
      logger.info(`coding schedule: renewOnExhaustion adopts already-armed ${dupe.id} for exhausted ${s.id} (identical prompt — no duplicate loop, ticket eb710676)`);
      return dupe.id;
    }
    // Self-re-arming governor (finding B2): generation cap + open-anchor
    // requirement for MACHINE/SYSTEM rows. Runs AFTER the adoption guard on
    // purpose — an already-armed manual/steered replacement IS a deliberate
    // re-arm and is reported as the successor regardless of chain depth; only
    // the CREATE of a fresh unattended successor is governed. A user row with
    // an explicit renewOnExhaustion:true, an owner-subscribed digest and a
    // chain whose ROOT the owner armed (review-fixer 2026-09-27 — successors
    // are stamped 'system', the governor reads the root) are owner
    // instruction — never gated. The anchor rule is OBSERVE-ONLY unless
    // RENEW_ANCHOR_CHECK_ENFORCE=1: an observed miss writes the same telemetry
    // row with outcome 'observed' and the successor still arms.
    if (renewalGoverned(s)) {
      const verdict = await renewalGovernor(s, out);
      if (!verdict.renew) {
        logger.info(`coding schedule: renewOnExhaustion REFUSED for ${s.id} (${out.kind}) — ${out.reason}`);
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SCHEDULE_RENEW_REFUSED, sessionId: s.sessionId,
          value: out.generation ?? 0,
          meta: { scheduleId: s.id, kind: out.kind, outcome: 'refused', generation: out.generation ?? null, maxGenerations: renewMaxGenerations(), promptSetBy: s.promptSetBy, ...(out.rootPromptSetBy !== undefined ? { rootPromptSetBy: out.rootPromptSetBy } : {}) },
        });
        return null;
      }
      if (verdict.observed) {
        logger.info(`coding schedule: renewOnExhaustion OBSERVED for ${s.id} (${out.observedKind}, observe-only — successor still arms; RENEW_ANCHOR_CHECK_ENFORCE=1 refuses) — ${out.observedReason}`);
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SCHEDULE_RENEW_REFUSED, sessionId: s.sessionId,
          value: out.generation ?? 0,
          meta: { scheduleId: s.id, kind: out.observedKind, outcome: 'observed', generation: out.generation ?? null, maxGenerations: renewMaxGenerations(), promptSetBy: s.promptSetBy, ...(out.rootPromptSetBy !== undefined ? { rootPromptSetBy: out.rootPromptSetBy } : {}) },
        });
      }
    }
    const now = Date.now();
    const interval = s.intervalSec ?? MIN_INTERVAL_SEC;
    try {
      const row = await prisma.chatSchedule.create({
        data: {
          sessionId: s.sessionId,
          userId: s.userId,
          prompt: s.prompt,
          kind: 'recurring',
          intervalSec: interval,
          nextRunAt: new Date(now + interval * 1000),
          maxRuns: s.maxRuns ?? MAX_RUNS,
          expiresAt: new Date(now + MAX_LIFETIME_MS),
          enabled: true,
          promptSetBy: 'system',
          // Owner-subscription inheritance (ticket 4565991a): the successor
          // serves the SAME subscription as the exhausted row — an owner-
          // subscribed digest stays expanded across run-cap rollovers.
          ...(s.ownerSubscribed === true ? { ownerSubscribed: true } : {}),
          renewOnExhaustion: s.renewOnExhaustion ?? true, // successors keep renewing unless explicitly opted out
          // P7 G13: the successor keeps the parent's probe gate — dropping
          // requiredProbes here un-gated probe-gated lanes at the first maxRuns
          // rollover. Spread-conditional: Prisma rejects JS null on Json? fields.
          ...(s.requiredProbes != null ? { requiredProbes: s.requiredProbes as Prisma.InputJsonValue } : {}),
          renewedFromId: s.id, // UNIQUE — the idempotency key
        },
        select: { id: true },
      });
      logger.info(`coding schedule: renewOnExhaustion armed successor ${row.id} for exhausted ${s.id} (every ${interval}s${out.generation != null ? `, generation ${out.generation + 1}/${renewMaxGenerations()}` : ''})`);
      // Crash-window fix (f24): name the row THIS call created so the fired-
      // final call site (which arms BEFORE its disable write) can undo it if
      // the post-fire bump loses to a mid-fire cancel. Adoption / existing /
      // P2002-winner returns deliberately leave it unset — those successors
      // were not minted by this call and must not be torn down by it.
      out.createdId = row.id;
      // Lane revival: the successor IS the resolution for any open
      // stopped-schedule decision on this chat (same as createSchedule).
      await resolveStoppedScheduleDecisionsSafe(s.sessionId, row.id);
      return row.id;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Race loser — the peer's successor won; report it.
        const winner = await prisma.chatSchedule.findFirst({ where: { renewedFromId: s.id }, select: { id: true } }).catch(() => null);
        return winner?.id ?? null;
      }
      throw err;
    }
  } catch (err: any) {
    logger.warn(`coding schedule: renewOnExhaustion failed for ${s.id} (lane may go deaf — the stopped-schedule alert is the backstop): ${err?.message ?? err}`);
    return null;
  }
}

/**
 * Stopped-schedule decision card, fast lane (SA0906): a recurring schedule
 * that permanently stops by a MACHINE path queues a DELAYED lane-liveness
 * re-check (stopped-schedule-alert.ts) which files an owner decision through
 * the owner-questions queue iff the lane's heartbeat actually died (no enabled
 * successor, no recent runs) and the project has an ACTIVE goal. Self-renewing
 * schedule_self chains (a fresh schedule per spent link — prod lane b95e9df6)
 * therefore never file. Owner-explicit disables (Schedules-tab pause/DELETE,
 * user-anchored cancel_schedule) never reach this. Best-effort via the
 * dynamic-import seam — alerting must never break the stop it reports.
 */
async function queueStoppedScheduleAlertSafe(
  scheduleId: string,
  cause: 'max_runs' | 'expired' | 'cancelled',
): Promise<void> {
  try {
    const { queueStoppedScheduleAlert } = await import('./stopped-schedule-alert');
    queueStoppedScheduleAlert(scheduleId, cause);
  } catch (err: any) {
    logger.warn(`coding schedule: stopped-schedule alert queue failed for ${scheduleId}: ${err?.message ?? err}`);
  }
}

/**
 * Lane revival auto-resolve (SA0906): EVERY path that arms an enabled schedule
 * on a chat (createSchedule, the Schedules-tab resume) closes any open
 * stopped-schedule decisions on that chat — a successor IS the resolution, so
 * the decision card must stop asking. Best-effort: an inbox hiccup must never
 * break the arm/resume it reacts to.
 */
async function resolveStoppedScheduleDecisionsSafe(sessionId: string, successorId?: string): Promise<void> {
  try {
    const { resolveStoppedScheduleDecisionsForSession } = await import('../platform/owner-questions');
    await resolveStoppedScheduleDecisionsForSession(sessionId, successorId);
  } catch (err: any) {
    logger.warn(`coding schedule: stopped-schedule decision auto-resolve failed for chat ${sessionId}: ${err?.message ?? err}`);
  }
}

/**
 * Post-cancel deaf-lane warning for the cancel_schedule TOOL result (same
 * 2026-08-30 incident as the emitScheduleDisabled suffix): the cancelling agent
 * hears IMMEDIATELY when it just disabled the chat's last enabled schedule —
 * the hook event above only reaches a SUBSCRIBED supervisor. Returns null when
 * the chat still has enabled schedules (nothing to warn about) or the id does
 * not resolve for this user.
 */
export async function deafLaneWarningForUser(userId: string, id: string): Promise<string | null> {
  const scheduleId = await resolveScheduleIdForUser(userId, id);
  if (!scheduleId) return null;
  const row = await prisma.chatSchedule.findFirst({ where: { id: scheduleId, userId }, select: { sessionId: true } });
  if (!row) return null;
  const remaining = await prisma.chatSchedule.count({ where: { sessionId: row.sessionId, enabled: true } });
  if (remaining > 0) return null;
  return `WARNING — chat ${row.sessionId} now has NO enabled schedules: if it runs standing work (monitors, assigned goal todos), it is DEAF until re-armed. Arm the replacement NOW with schedule_message — never defer a re-arm to a note or state doc (notes get compacted away; only an armed schedule fires).`;
}

// NOTE: session-scoped schedule updates are handled by the platform-level
// update_schedule tool (updateScheduleForUser below) — a session-scoped variant
// here would be shadowed by platform dispatch and drift out of sync.

// ── Pause / resume (workspace-panel Schedules tab REST surface) ────────────────

export type SetScheduleEnabledResult =
  | { ok: true; schedule: ScheduleView; changed: boolean }
  | { ok: false; reason: 'not_found' | 'completed' | 'too_many_active' | 'dormant' | 'archived'; error: string };

/**
 * Pause (enabled:false) or resume (enabled:true) ONE schedule on a chat — the
 * workspace panel's Schedules tab (owner-only REST; the chat-ownership gate
 * lives in platform.service.setChatScheduleEnabled). Chat-scoped lookup: the
 * id must belong to sessionId — a wrong-chat id is indistinguishable from a
 * missing one ('not_found', no existence leak).
 *
 * Pause follows the enabled:false doctrine (see emitScheduleDisabled: EVERY
 * disable site emits ONE schedule_disabled hook event) with reason 'paused' —
 * lastStatus says 'paused' (so a resume is an expected follow-up), and a
 * subscribed supervisor still hears the cadence stop, deaf-lane suffix
 * included (a paused last schedule leaves the lane just as deaf).
 *
 * Resume respects the platform's cadence rules rather than blindly flipping
 * the bit:
 *   - a COMPLETED schedule (runsCount ≥ maxRuns — every fired 'once' included)
 *     stays terminal: re-enabling would only have the sweeper disable it again
 *     as 'expired' on its next tick. Honest error instead.
 *   - MAX_ACTIVE_PER_SESSION is re-checked — a resume arms a schedule exactly
 *     like a create does.
 *   - a STALE nextRunAt (in the past — the usual state after any pause longer
 *     than the gap to the next firing) is recomputed to now + intervalSec so a
 *     resume never triggers an immediate catch-up fire.
 *   - a lapsed expiresAt slides to now + MAX_LIFETIME_MS (the sliding-expiry
 *     doctrine: an explicit owner resume is at least as alive as a firing).
 *
 * Both directions are IDEMPOTENT: a row already in the requested state is a
 * quiet no-op (changed:false) — no duplicate hook event, and no lastStatus
 * rewrite (a re-pause must not relabel a 'cancelled' row as 'paused').
 * Resuming a 'cancelled' row IS allowed — cancel persists as enabled:false +
 * lastStatus, nothing else is destroyed, and this is what the UI's short
 * "Cancelled — Undo" affordance calls.
 */
export async function setScheduleEnabledForChat(sessionId: string, scheduleId: string, enabled: boolean, opts?: { actorChatId?: string | null; restore?: boolean }): Promise<SetScheduleEnabledResult> {
  const row = await prisma.chatSchedule.findFirst({ where: { id: scheduleId, sessionId } });
  if (!row) return { ok: false, reason: 'not_found', error: 'Schedule not found' };

  if (row.enabled === enabled) {
    const [schedule] = await enrichWithCapState([toView(row)], () => sessionId);
    return { ok: true, schedule, changed: false };
  }

  if (!enabled) {
    const updated = await prisma.chatSchedule.update({ where: { id: row.id }, data: { enabled: false, lastStatus: 'paused', cancelledBy: 'owner', disabledAt: new Date() } });
    logger.info(`coding schedule: paused ${row.id} for session ${sessionId.slice(0, 8)}`);
    await emitScheduleDisabled(row, 'paused', row.runsCount, opts?.actorChatId ? { actorChatId: opts.actorChatId } : undefined);
    const [schedule] = await enrichWithCapState([toView(updated)], () => sessionId);
    return { ok: true, schedule, changed: true };
  }

  // ARCHIVED-TARGET-RETIRE (b, 2026-10-20): a resume on an ARCHIVED chat would
  // only be refused at every firing — refuse it with the next step. The
  // restore path (resumeSchedulesForRestoredChat, opts.restore) IS the
  // unarchive and skips the check. Fail-open; kill switch
  // ARCHIVED_TARGET_RETIRE_DISABLED=1.
  if (!opts?.restore && await isArchivedScheduleTarget(sessionId)) {
    recordArchivedTargetRetire(sessionId, { surface: 'arm', action: 'refused', arm: 'resume', scheduleId: row.id, chatId: sessionId });
    return { ok: false, reason: 'archived', error: archivedTargetRefusal(sessionId, 'resume') };
  }

  // Resume — cadence rules first.
  if ((row.maxRuns != null && row.runsCount >= row.maxRuns) || (row.kind === 'once' && row.runsCount >= 1)) {
    return {
      ok: false, reason: 'completed',
      error: `Schedule already completed its run${row.maxRuns != null && row.maxRuns > 1 ? `s (${row.runsCount}/${row.maxRuns})` : ''} — it cannot resume; create a new schedule instead.`,
    };
  }
  const active = await prisma.chatSchedule.count({ where: { sessionId, enabled: true } });
  if (active >= MAX_ACTIVE_PER_SESSION) {
    return {
      ok: false, reason: 'too_many_active',
      error: `Too many active schedules (${active}/${MAX_ACTIVE_PER_SESSION}) on this chat — cancel or pause one first.`,
    };
  }
  // Dormancy-aware re-arm (ticket b101ad89): a goal-gate AUTO-PARKED row
  // ('parked:dormant', ticket b1d435fd) resumes only if the underlying
  // dormancy has actually lifted. Resuming while the project stays dormant
  // would violate the owner's standing zero-wake directive AND be futile —
  // the fire-time gate re-parks the row on its very next tick (park → resume
  // → park churn). The row stays parked with the honest one-line reason;
  // the way back is the same as every other dormant lane: live work
  // reappears (goal/todo/run) and the ensure/resume paths re-arm a RECURRING
  // row. The gate predicate never throws (fail-open), and an OWNER-authored row
  // (promptSetBy 'user'/NULL) is never gated by design — the owner's own
  // explicit instruction is exactly the override this check honors.
  if (row.lastStatus === DORMANT_LAST_STATUS) {
    const dormancy = await evaluateScheduleDormancy(sessionId, row.promptSetBy);
    if (dormancy.dormant) {
      logger.info(`coding schedule: resume refused for ${row.id} — still dormant: ${dormancy.reason}`);
      const wayBack = 'it re-arms itself once the project has live work again (an active goal, an open todo, or a live run), or you can resume it from that project\'s chat once work resumes.';
      return {
        ok: false, reason: 'dormant',
        error: `This schedule is auto-parked because ${dormancy.reason}. Resuming it now would violate the zero-wake rule for dormant projects — ${wayBack}`,
      };
    }
  }
  const now = Date.now();
  // busySkips: 0 — a resume starts a FRESH streak: the old count already spent
  // its alarm crossings, so a resumed-then-blocked lane could never alarm again.
  const data: { enabled: true; lastStatus: string; cancelledBy: null; disabledAt: null; busySkips: 0; nextRunAt?: Date; expiresAt?: Date } =
    { enabled: true, lastStatus: 'resumed', cancelledBy: null, disabledAt: null, busySkips: 0 }; // a re-enabled row is no longer a stop (v1#13)
  const nextAt = new Date(row.nextRunAt as any).getTime();
  if (!Number.isFinite(nextAt) || nextAt <= now) data.nextRunAt = new Date(now + (row.intervalSec ?? MIN_INTERVAL_SEC) * 1000);
  const expAt = row.expiresAt ? new Date(row.expiresAt as any).getTime() : null;
  if (expAt !== null && expAt <= now) data.expiresAt = new Date(now + MAX_LIFETIME_MS);
  const updated = await prisma.chatSchedule.update({ where: { id: row.id }, data });
  logger.info(`coding schedule: resumed ${row.id} for session ${sessionId.slice(0, 8)}${data.nextRunAt ? ' (stale nextRunAt recomputed)' : ''}${data.expiresAt ? ' (lapsed expiry slid)' : ''}`);
  // Lane revival (SA0906): a resume closes the chat's open stopped-schedule
  // decisions — the re-enabled cadence IS the resolution. v1#12: only a
  // RECURRING row is a successor (a resumed one-shot is not a lane heartbeat).
  if (row.kind === 'recurring') await resolveStoppedScheduleDecisionsSafe(sessionId, row.id);
  const [schedule] = await enrichWithCapState([toView(updated)], () => sessionId);
  return { ok: true, schedule, changed: true };
}

/**
 * Cap-skip notice, so a session LEARNS its firings were skipped (previously the
 * only trace was lastStatus + a log line — the chat could never self-heal). The
 * sweeper INCRs on each daily-cap skip; the next run start (any entry path)
 * consumes the count, which the executor injects as SYSTEM context (never into
 * the persisted message). The 36h TTL outlives the 24h cap window it describes.
 */
const SKIP_NOTICE_TTL_SEC = 36 * 60 * 60;
const skipNoticeKey = (sessionId: string) => `coding:sched:skipnotice:${sessionId}`;

async function recordCapSkip(sessionId: string): Promise<void> {
  try {
    const n = await redisClient.incr(skipNoticeKey(sessionId));
    if (n === 1) await redisClient.expire(skipNoticeKey(sessionId), SKIP_NOTICE_TTL_SEC).catch(() => {});
  } catch { /* best-effort — the lastStatus + log line remain the fallback */ }
}

/**
 * Read + clear the pending cap-skip count (0 = none). GETDEL (Redis 6.2+) makes
 * the read+clear ATOMIC — the old GET-then-DEL pair could destroy a concurrent
 * recordCapSkip INCR that landed between the two commands (that skip was
 * deleted without ever being reported). Called at run start; if the run then
 * fails to start, the caller puts the count back via restoreCapSkipNotice.
 */
export async function consumeCapSkipNotice(sessionId: string): Promise<number> {
  try {
    const raw = await redisClient.getDel(skipNoticeKey(sessionId));
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

/**
 * Put a consumed cap-skip count BACK — the run it was meant for never started
 * (busy gate / queue error), so deleting it would lose the self-healing signal
 * exactly in the congested-chat scenario it exists for. INCRBY (not SET)
 * preserves any skips recorded since the consume; the TTL refresh keeps the
 * restored notice alive for the retry. Best-effort, like recordCapSkip.
 */
export async function restoreCapSkipNotice(sessionId: string, count: number): Promise<void> {
  if (!Number.isFinite(count) || count <= 0) return;
  try {
    await redisClient.incrBy(skipNoticeKey(sessionId), Math.round(count));
    await redisClient.expire(skipNoticeKey(sessionId), SKIP_NOTICE_TTL_SEC).catch(() => {});
  } catch { /* best-effort — worst case the count is lost, same as the pre-restore behavior */ }
}

/* ── Consecutive provider-killed scheduled runs (feedback cff523e7 + d36344ed) ─
 * A schedule-fired run whose agent loop gave up on the model provider (429
 * budget exhausted, a capability 400, billing) used to finalize agent_runs as
 * 'completed' with only the provider's note in the transcript — a SILENT
 * failure (~6 consecutive 429-killed monitoring runs once delayed incident
 * detection ~1h15m; a 30-min monitor on a tool-less seat died 3+ firings in a
 * row as "success" and kept burning its cap, ticket d36344ed). Since d36344ed
 * the executor finalizes such MACHINE runs as 'failed' (run_failed hook event,
 * provider cause on the row) AND calls recordScheduleProviderFail for every
 * schedule-triggered run whose AgentRunResult carries modelErrored;
 * resetScheduleProviderFail runs on a genuine success.
 * Past the threshold the schedule is surfaced TWO ways:
 *   (a) coding_schedules.lastStatus = 'error:provider_<status|kind>' (e.g.
 *       'error:provider_429', 'error:provider_400') — the project digest's
 *       isScheduleError() (/^(error|failed)/i) picks it up automatically;
 *   (b) ONE attention_needed hook event per crossing (the fleet supervisor's
 *       default hook subscribes to it) — NX-gated so failures past the threshold
 *       don't spam; the gate is cleared by the reset on the next genuine success.
 * Observe-only (gate flip 2026-09-11 doctrine): the cadence keeps firing and
 * every firing is an honest failed run + counted.
 * ALL of this is best-effort: it must never throw into the run finalize path.
 * The counter lives in Redis (no migration); the 7d TTL outlives any sane
 * cadence gap between consecutive failures while still GC-ing counters of
 * long-deleted schedules.
 */
export const PROVIDER_FAIL_ALERT_THRESHOLD = 3;
const PROVIDER_FAIL_TTL_SEC = 7 * 24 * 60 * 60;
const providerFailKey = (scheduleId: string) => `coding:sched:provfail:${scheduleId}`;
const providerFailAlertedKey = (scheduleId: string) => `coding:sched:provfail:alerted:${scheduleId}`;

/* ── Delta-gate dead-source alarm (FO firing 9, 2026-09-23) ─────────────────
 * A delta-gated recurring schedule whose probe source DIES (a deleted repo's
 * api.github.com URL 404ing — the canlegal-bench case: 16 consecutive
 * delta-gate errors over ~45 min at a 3-min cadence, each one a full
 * fail-open model run) fires silently forever: the gate's own doctrine is
 * fail-open (a gate failure must never silence a schedule), so nothing sees
 * it. The busy-skip and
 * provider-fail paths each already alarm on their OWN consecutive-failure
 * streak; this is the delta gate's equivalent.
 *   (a) each error VERDICT (not each thrown evaluation — the try/catch
 *       around evaluateDeltaGate already fails open and does NOT count)
 *       increments a per-schedule Redis counter (7d TTL, same GC story as
 *       the provider-fail counter);
 *   (b) a CLEAN evaluation (any non-error verdict: baseline/delta/heartbeat/
 *       unchanged) resets the streak + the NX gate, so a flaky source that
 *       recovers never alarms and a re-dying source re-alarms;
 *   (c) at the threshold crossing (3 consecutive — same arithmetic as
 *       provider-fail and busy-skip FIRST) ONE attention_needed hook event
 *       fires (NX-gated per streak) naming the failing probe, plus a
 *       digest-visible lastStatus 'alarm:delta_gate_errors';
 *   (d) OBSERVE-ONLY on the cadence itself (2026-09-11 gate-flip doctrine):
 *       the schedule keeps firing fail-open — the alarm informs, it never
 *       pauses; there is no opt-in pause switch to flip.
 * ALL of this is best-effort: it must never throw into the fire path. */
export const DELTA_ERR_ALARM_THRESHOLD = 3;
const DELTA_ERR_TTL_SEC = 7 * 24 * 60 * 60;
const deltaErrKey = (scheduleId: string) => `coding:sched:deltaerr:${scheduleId}`;
const deltaErrAlertedKey = (scheduleId: string) => `coding:sched:deltaerr:alerted:${scheduleId}`;
/** One delta-gate probe evaluation errored → bump the streak; at the threshold
 *  crossing emit the ONE alarm (hook + digest status). Returns the
 *  consecutive-error count (0 when Redis is down). */
async function recordDeltaGateErrorStreak(scheduleId: string, sessionId: string, detail: string): Promise<number> {
  try {
    const key = deltaErrKey(scheduleId);
    const n = await redisClient.incr(key);
    if (n === 1) await redisClient.expire(key, DELTA_ERR_TTL_SEC).catch(() => {});
    if (n >= DELTA_ERR_ALARM_THRESHOLD) {
      const clipped = detail.slice(0, 140);
      // digest-visible status — safe to repeat (same value every time)
      await prisma.chatSchedule
        .update({ where: { id: scheduleId }, data: { lastStatus: 'alarm:delta_gate_errors' } })
        .catch(() => {});
      const claimed = await redisClient
        .set(deltaErrAlertedKey(scheduleId), String(n), { NX: true, EX: DELTA_ERR_TTL_SEC })
        .catch(() => null);
      if (claimed) {
        await emitHookEventSafe(
          sessionId,
          'attention_needed',
          `Schedule ${scheduleId}: the delta gate's probe has errored ${n} firings in a row (${clipped}). Every firing still runs FAIL-OPEN (a gate failure never silences a schedule), so this cadence is burning a full model run each time the source is dead. Fix or clear the gate (update_schedule with deltaGate:null), or disable the schedule if its purpose is gone.`,
          { scheduleId, sessionId, consecutiveErrors: n, detail: clipped },
        );
        logger.warn(`coding schedule: ${scheduleId} delta gate errored ${n} firings in a row — attention_needed emitted`);
      }
    }
    return n;
  } catch {
    return 0; // best-effort — the fail-open firing remains
  }
}
/** A clean delta-gate evaluation (any non-error verdict) → clear the streak + the one-shot gate. */
async function resetDeltaGateErrorStreak(scheduleId: string): Promise<void> {
  try {
    await redisClient.del(deltaErrKey(scheduleId));
    await redisClient.del(deltaErrAlertedKey(scheduleId));
  } catch { /* best-effort — a stuck counter self-heals via the 7d TTL */ }
}
/** Digest-visible lastStatus for a provider-killed streak — names the REAL cause
 *  (HTTP status when known, else the recovery class), never a hardcoded 429. */
export function providerFailLastStatus(info: ScheduleProviderFailInfo = {}): string {
  return `error:provider_${info.status ?? info.kind ?? 'killed'}`;
}

export interface ScheduleProviderFailInfo {
  /** HTTP status of the provider's killing turn (429, 5xx, …), when known. */
  status?: number;
  /** Which model-error recovery class gave up. */
  kind?: ModelErrorKind;
  /** The agent_runs row of the provider-killed run (forensics trail). */
  runId?: string;
}

/**
 * Record ONE provider-killed scheduled run; returns the consecutive-failure
 * count (0 when Redis is unreachable — the run finalize never sees the error).
 * At the threshold crossing: flips lastStatus (idempotently re-asserted on every
 * failure at/past the threshold so the sweeper's fire-time 'started' stamp can't
 * hide it) and fires the ONE-SHOT attention event.
 */
export async function recordScheduleProviderFail(scheduleId: string, sessionId: string, info: ScheduleProviderFailInfo = {}): Promise<number> {
  try {
    const key = providerFailKey(scheduleId);
    const n = await redisClient.incr(key);
    if (n === 1) await redisClient.expire(key, PROVIDER_FAIL_TTL_SEC).catch(() => {});
    if (n >= PROVIDER_FAIL_ALERT_THRESHOLD) {
      const cause = `${info.kind ?? 'provider'} failure${info.status ? ` (HTTP ${info.status})` : ''}`;
      // Observe-only per the 2026-09-11 gate flip — the honest failed runs +
      // the counter + the attention event are the response.
      // (a) digest-visible status — safe to repeat (same value every time).
      await prisma.chatSchedule
        .update({
          where: { id: scheduleId },
          data: { lastStatus: providerFailLastStatus(info) },
        })
        .catch(() => {});
      // (b) ONE attention event per crossing — the NX marker arms the gate;
      // resetScheduleProviderFail clears it so a RECOVERED-then-failing-again
      // schedule re-alerts on its next crossing.
      const claimed = await redisClient
        .set(providerFailAlertedKey(scheduleId), String(n), { NX: true, EX: PROVIDER_FAIL_TTL_SEC })
        .catch(() => null);
      if (claimed) {
        await emitHookEventSafe(
          sessionId,
          'attention_needed',
          `Schedule ${scheduleId}: ${n} consecutive scheduled runs were killed by the model provider (${cause}) — each finalized as a FAILED run; this cadence has produced nothing for its last ${n} firings. ${info.kind === 'capability' ? 'The model seat rejects the request shape (tool calling is not enabled on the endpoint, or the model does not serve tools) — retries cannot help until the endpoint or the seat changes.' : "Check the provider's quota/rate limits, then re-verify the monitor's purpose is still being served."}`,
          {
            scheduleId,
            sessionId,
            consecutiveFailures: n,
            modelErrorStatus: info.status,
            modelErrorKind: info.kind,
            paused: false,
            ...(info.runId ? { runId: info.runId } : {}),
          },
        );
        logger.warn(`coding schedule: ${scheduleId} hit ${n} consecutive provider-killed runs (${cause}) — attention_needed emitted`);
      }
    }
    return n;
  } catch {
    return 0; // best-effort — the honest finalText note in the run remains the fallback
  }
}

/* ── Workspace missing on disk (hardening loop 2026-09-23) ────────────────────
 * A blank-provider session whose worktree vanished (box roll, volume prune)
 * fails EVERY firing with the permanent "Workspace missing on disk — start a
 * new session" error: prod showed one chat failing 4×/h all afternoon while
 * its recurring schedule kept firing and nobody was told. Same posture as the
 * provider-failure streak (gate-flip doctrine — observe by default):
 *   ONE attention_needed hook event per session (NX-gated, 24 h) naming the
 *   session and the recovery (start a new session; it chains from this one)
 *   — the supervisor's default hook subscription delivers it; the cadence
 *   keeps firing and every firing is an honest failed run.
 * Best-effort: never throws into the executor's not-runnable path. */
const workspaceMissingAlertedKey = (sessionId: string) => `coding:sched:wsmissing:${sessionId}`;
const WORKSPACE_MISSING_TTL_SEC = 24 * 3600;
export async function recordWorkspaceMissing(sessionId: string, detail: string): Promise<{ alerted: boolean; paused: number }> {
  let alerted = false;
  try {
    const claimed = await redisClient
      .set(workspaceMissingAlertedKey(sessionId), new Date().toISOString(), { NX: true, EX: WORKSPACE_MISSING_TTL_SEC })
      .catch(() => null);
    if (claimed) {
      alerted = true;
      await emitHookEventSafe(
        sessionId,
        'attention_needed',
        `Session ${sessionId.slice(0, 8)}: its workspace is MISSING on disk, so every scheduled firing fails before the model runs (${detail.slice(0, 160)}). ` +
        `This cannot self-repair — start a NEW coding session for the same work (it chains from this one if the repo survived) and retire this one's schedules` +
        ` (its recurring schedules keep firing as honest failed runs until you cancel them).`,
        { sessionId, reason: 'workspace_missing', paused: 0 },
      );
      logger.warn(`coding schedule: session ${sessionId} workspace missing on disk — attention_needed emitted`);
    }
  } catch (err: any) {
    logger.warn(`recordWorkspaceMissing failed (non-fatal): ${err?.message ?? err}`);
  }
  return { alerted, paused: 0 };
}

/** A genuine success on a schedule-fired run: clear the failure streak + the one-shot alert gate. */
export async function resetScheduleProviderFail(scheduleId: string): Promise<void> {
  try {
    await redisClient.del(providerFailKey(scheduleId));
    await redisClient.del(providerFailAlertedKey(scheduleId));
  } catch { /* best-effort — a stuck counter self-heals via the 7d TTL */ }
}

/* ── Required probes — the probe-shape gate (remediation P7, spark G13) ───────
 * coding_schedules.requiredProbes (Json?) optionally lists [{tool, argPattern?}]
 * receipts a MACHINE run fired by this schedule must carry at finalize
 * (argPattern, when set, is tested against the receipt's canonical ids
 * envelope — receipts store only hashes of args/output, never text). The
 * run-executor finalize calls recordScheduleProbeMiss when any probe is
 * missing / resetScheduleProbeMiss when all are present:
 *   - every miss ARMS a scheduler notice for the schedule's NEXT firing
 *     (Redis, consumed at fire time like the cap-skip notice) and writes a
 *     deterministic journal row ('(required probe missing: X)').
 *   - Gate flip 2026-09-11 (owner: full steam): the 3-CONSECUTIVE-miss PAUSE
 *     (enabled:false, lastStatus 'paused:required_probes', schedule_disabled
 *     reason 'probes_missing') + ONE owner decision card is OPT-IN via
 *     REQUIRED_PROBES_PAUSE_ENABLED=1 — by default a miss only counts and arms
 *     the next-firing notice (the tier never fired in prod; the only schedule
 *     that declared requiredProbes was a machine run arming an owner-click
 *     gate on its OWN cadence). Setting the env restores enforcement.
 */
export const REQUIRED_PROBE_PAUSE_THRESHOLD = 3;
export function requiredProbesPauseEnabled(): boolean {
  return process.env.REQUIRED_PROBES_PAUSE_ENABLED === '1';
}
const PROBE_MISS_TTL_SEC = 7 * 24 * 60 * 60;
const probeMissKey = (scheduleId: string) => `coding:sched:probemiss:${scheduleId}`;
const probeNoticeKey = (scheduleId: string) => `coding:sched:probenotice:${scheduleId}`;
const probeCardKey = (scheduleId: string) => `coding:sched:probecard:${scheduleId}`;

export interface RequiredProbe { tool: string; argPattern?: string }

/** Tolerant parse of a stored requiredProbes Json — malformed entries drop. */
export function parseRequiredProbes(raw: unknown): RequiredProbe[] {
  if (!Array.isArray(raw)) return [];
  const out: RequiredProbe[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const tool = String((p as any).tool ?? '').trim().slice(0, 60);
    if (!tool) continue;
    const argPattern = String((p as any).argPattern ?? '').trim().slice(0, 200);
    if (argPattern) {
      try { new RegExp(argPattern); } catch { continue; } // an invalid pattern never gates
      out.push({ tool, argPattern });
    } else {
      out.push({ tool });
    }
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Which required probes have NO matching receipt? A probe matches a receipt
 * with the same tool name, ok:true, and (when argPattern is set) whose ids
 * envelope matches the pattern. Pure — exported for tests.
 */
export function missingRequiredProbes(
  probes: RequiredProbe[],
  receipts: Array<{ tool: string; ok: boolean; ids?: Record<string, unknown> | null }>,
): string[] {
  const missing: string[] = [];
  for (const probe of probes) {
    let re: RegExp | null = null;
    if (probe.argPattern) {
      try { re = new RegExp(probe.argPattern); } catch { re = null; }
    }
    const hit = (receipts ?? []).some((r) => {
      if (!r || r.tool !== probe.tool || !r.ok) return false;
      if (!re) return true;
      try { return re.test(JSON.stringify(r.ids ?? {})); } catch { return true; }
    });
    if (!hit) missing.push(probe.argPattern ? `${probe.tool} (~${probe.argPattern})` : probe.tool);
  }
  return missing;
}

/**
 * Record ONE probe-less machine firing for a schedule; returns the consecutive
 * miss count (0 on Redis failure). Arms the next-firing scheduler notice on
 * every miss; at the threshold it PAUSES the schedule and files the owner card
 * ONLY when REQUIRED_PROBES_PAUSE_ENABLED=1. NEVER throws into the finalize
 * path. (`_sessionId` is kept for the run-executor call shape.)
 */
export async function recordScheduleProbeMiss(scheduleId: string, _sessionId: string, missing: string[]): Promise<number> {
  try {
    const label = missing.join(', ').slice(0, 300);
    // Next-firing notice (consumed by fireScheduleTarget, restored on non-start).
    await redisClient.set(probeNoticeKey(scheduleId), label, { EX: PROBE_MISS_TTL_SEC }).catch(() => {});
    const n = await redisClient.incr(probeMissKey(scheduleId));
    if (n === 1) await redisClient.expire(probeMissKey(scheduleId), PROBE_MISS_TTL_SEC).catch(() => {});
    if (n < REQUIRED_PROBE_PAUSE_THRESHOLD) return n;
    // Gate flip 2026-09-11 (owner: full steam): the pause + owner card tier is
    // observe-only by default — the count and the next-firing notice are the
    // whole response — opt-in REQUIRED_PROBES_PAUSE_ENABLED=1 restores enforcement.
    if (!requiredProbesPauseEnabled()) {
      logger.warn(`coding schedule: ${scheduleId} hit ${n} consecutive probe-less machine firings (missing: ${label}) — observed only (REQUIRED_PROBES_PAUSE_ENABLED unset; no pause, no card)`);
      return n;
    }
    // Threshold: pause the schedule + ONE owner card (NX-gated vs races/repeats).
    const row = await prisma.chatSchedule.findUnique({
      where: { id: scheduleId },
      select: { id: true, sessionId: true, kind: true, runsCount: true, userId: true, enabled: true, prompt: true },
    }).catch(() => null);
    if (!row || !row.enabled) return n; // already stopped by another path
    await prisma.chatSchedule.update({
      where: { id: scheduleId },
      data: { enabled: false, lastStatus: 'paused:required_probes', cancelledBy: 'machine', disabledAt: new Date() },
    }).catch(() => {});
    logger.warn(`coding schedule: ${scheduleId} paused after ${n} consecutive probe-less machine firings (missing: ${label})`);
    await emitScheduleDisabled({ id: row.id, sessionId: row.sessionId, kind: row.kind }, 'probes_missing', row.runsCount);
    const claimed = await redisClient.set(probeCardKey(scheduleId), '1', { NX: true, EX: PROBE_MISS_TTL_SEC }).catch(() => null);
    if (claimed === 'OK') {
      try {
        const { flagOwnerQuestion } = await import('../platform/owner-questions');
        await flagOwnerQuestion({
          chatId: row.sessionId,
          userId: row.userId,
          question: `Schedule ${scheduleId.slice(0, 8)} was PAUSED after ${n} consecutive firings without its required probes (${label}). Resume it, or drop the probe requirement?`,
          context:
            `This schedule declares requiredProbes — receipts each machine firing must produce (e.g. a real curl/status check). ` +
            `${n} consecutive firings finished without them, so the monitoring it claims to do was not evidenced and the schedule was paused ` +
            `(lastStatus 'paused:required_probes'). Resume it from the chat's Schedules tab once the lane runs its probes, or clear requiredProbes via update_schedule if the requirement is obsolete.\n` +
            `Schedule prompt (head): ${String(row.prompt ?? '').slice(0, 300)}`,
          options: [
            { id: 'resume', label: 'Resume the schedule (lane must run its probes)', consequence: 'the lane keeps its cadence; the probe gate keeps watching' },
            { id: 'drop_probes', label: 'Drop the probe requirement and resume', consequence: 'firings stop being probe-verified' },
            { id: 'leave_paused', label: 'Leave it paused', consequence: 'the lane stays stopped until someone re-arms it' },
          ],
          machineTriggered: true,
          // A per-event card (this pause): an owner ruling on an EARLIER pause
          // annotates it, never refuses it — the result is not read here.
          harnessEventAt: new Date(),
        });
      } catch (err: any) {
        // Claim-then-fail must not silence the lane's ONLY card for 7 days:
        // reopen the NX gate so the next miss retries the card (the
        // notifyScheduleTerminalOnce pattern; the pause itself persists).
        await redisClient.del(probeCardKey(scheduleId)).catch(() => {});
        logger.warn(`coding schedule: probe-pause owner card failed for ${scheduleId} (non-fatal): ${err?.message ?? err}`);
      }
    }
    return n;
  } catch {
    return 0; // best-effort — the journal row remains the fallback trace
  }
}

/** A compliant machine firing (all required probes present): clear the streak. */
export async function resetScheduleProbeMiss(scheduleId: string): Promise<void> {
  try {
    await redisClient.del(probeMissKey(scheduleId));
    await redisClient.del(probeCardKey(scheduleId));
  } catch { /* best-effort — the 7d TTL self-heals */ }
}

/** Read+clear the pending next-firing probe notice (fireScheduleTarget). */
export async function consumeProbeNotice(scheduleId: string): Promise<string | null> {
  try {
    const raw = await redisClient.getDel(probeNoticeKey(scheduleId));
    return raw ? String(raw) : null;
  } catch { return null; }
}

/** Put a consumed probe notice back — the firing it was built for never started. */
export async function restoreProbeNotice(scheduleId: string, label: string): Promise<void> {
  if (!label) return;
  try { await redisClient.set(probeNoticeKey(scheduleId), label, { EX: PROBE_MISS_TTL_SEC }); } catch { /* best-effort */ }
}

/* ── Continuation fast-lane (audit roadmap #2) ────────────────────────────────
 * A finalizing run with unfinished plan steps used to schedule its own
 * follow-up as a `once` schedule at MIN_INTERVAL_SEC — a mandatory 15-minute
 * "continuation tax" whose wake arrived stale (the fire-time staleness guard
 * in fireScheduleTarget exists purely to clean up after it). The fast lane
 * requeues the continuation DIRECTLY as a new agent_runs row: machine-origin
 * input carrying the same [HARNESS CONTINUATION] prompt, claimable by the
 * worker after a short NOT-BEFORE (~45 s — riding leaseExpiresAt exactly like
 * run-claim's lock-contention requeue backoff, so no new column and no worker
 * change). No coding_schedules row is created, so a continuation consumes NO
 * schedule daily-cap token and never waits out the 15-minute floor. The legacy
 * once-schedule remains the explicit FALLBACK (run-executor logs the switch)
 * for a session that is somehow already busy.
 */
export const CONTINUATION_REQUEUE_DELAY_MS = 45_000; // "~15–60 s" — enough for the caller's finalize to land

/**
 * Provider-throttled continuation delay (ticket cffaa701, 2026-09-14): when the
 * finalizing run was KILLED by an exhausted provider transient lane (429/5xx),
 * re-firing its continuation at the usual ~45 s just re-enters the
 * still-limited rate window — the canlegal-bench loop that afternoon (six
 * worker deaths in ~1.5h) was exactly that: every wake re-died on the same
 * throttle. A throttled wake is delayed 3–5 min (base + 0–120 s jitter, so
 * concurrent throttled lanes don't re-fire in lockstep on the shared provider
 * bucket). Env override CONTINUATION_PROVIDER_THROTTLE_DELAY_MS sets an EXACT
 * delay in ms (tests/ops).
 */
export const PROVIDER_THROTTLE_REQUEUE_DELAY_MS = 180_000;
export function providerThrottleRequeueDelayMs(rand: () => number = Math.random): number {
  const raw = parseInt(process.env.CONTINUATION_PROVIDER_THROTTLE_DELAY_MS || '', 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return PROVIDER_THROTTLE_REQUEUE_DELAY_MS + Math.floor(rand() * 120_000);
}

export interface ContinuationQueueResult { ok: boolean; runId?: string; reason?: string }

/** audit 2026-10-06 T4-6: CONTINUATION_FRAMING_DISABLED=1 restores the "scheduled firing" header + "≥15 minutes old" sentence on fast-lane continuations. Read per call. */
export function continuationFramingDisabled(): boolean {
  return process.env.CONTINUATION_FRAMING_DISABLED === '1';
}

/**
 * True when a fast-lane continuation row is already waiting for this session —
 * the queued-row twin of run-executor's pending once-schedule dedupe (the same
 * stall guard, widened to both lanes). Fail-open to false: a read error lets
 * the caller fall through to the legacy schedule path rather than losing the
 * resumption.
 */
export async function hasQueuedContinuationRun(sessionId: string): Promise<boolean> {
  const n = await prisma.agentRun.count({
    where: { sessionId, status: 'queued', input: { path: ['message'], string_contains: '[HARNESS CONTINUATION' } },
  }).catch(() => 0);
  return n > 0;
}

/**
 * Queue a continuation follow-up DIRECTLY as an agent_runs row (audit #2).
 *
 * Busy gate (studied from run-state.queueAgentRun): the canonical queue path
 * gates on session status 'ready' — unusable here, because the FINALIZING run
 * still owns the session (status 'running') when this is called. The invariant
 * that matters is queueAgentRun's "exactly ONE claimable row per session": the
 * caller's own row is 'running' (terminal moments later, never claimable
 * again), so BUSY = any OTHER 'queued' row already waiting (e.g. a
 * lock-contention requeue of a colliding schedule firing). That case returns
 * { ok:false, reason:'busy' } so the caller falls back to the legacy
 * once-schedule path, whose sweeper-side busy re-arm + fire-time staleness
 * guard already handle a congested session.
 */
export async function queueContinuationRun(opts: {
  sessionId: string;
  userId: string;
  prompt: string;
  delayMs?: number;
  /** 2026-09-29 (transient-resume.ts): a provider-limit RESUME — skips the zero-unfinished obsolete check (no plan was ever written). */
  resume?: boolean;
  /** audit 2026-10-06 T4-6: the finalizing run this continues (else looked up: the session's running row). */
  previousRunId?: string;
}): Promise<ContinuationQueueResult> {
  const delayMs = opts.delayMs ?? CONTINUATION_REQUEUE_DELAY_MS;
  let skipped = 0;
  let spendSkipped = 0;
  try {
    const queued = await prisma.agentRun.findFirst({
      where: { sessionId: opts.sessionId, status: 'queued' },
      select: { id: true },
    });
    if (queued) return { ok: false, reason: 'busy' };
    // STOP MEANS STOP (2026-09-29, continuation-guard.ts): an ARCHIVED session
    // never gets a continuation. TERMINAL for the caller — never the legacy
    // once-schedule fallback. Fail-open read (not archived on error).
    {
      const { isSessionArchived } = await import('./continuation-guard');
      if (await isSessionArchived(opts.sessionId)) return { ok: false, reason: 'archived' };
    }
    // RECURRING-OWNER skip (CanLaw L8 / spark B14): when an enabled RECURRING
    // schedule owns this lane, its next firing resumes the plan anyway — a
    // separate continuation only fires into a completed board later (the 173
    // dead skipped:obsolete once-rows in prod were exactly this). The caller
    // must treat 'recurring_lane' as terminal (no legacy fallback).
    const recurringOwners = await prisma.chatSchedule.count({
      where: { sessionId: opts.sessionId, enabled: true, kind: 'recurring' },
    }).catch(() => 0);
    if (recurringOwners > 0) return { ok: false, reason: 'recurring_lane' };
    // OBSOLETE check (CanLaw L8): the slow lane re-reads the plan at FIRE time
    // (fireScheduleTarget) — the fast lane now checks at QUEUE time too: a
    // sibling run may have finished the steps between the caller's plan read
    // and this queue. A plan READ ERROR never skips (uncertainty must not
    // drop a real resumption — same doctrine as the fire-time guard).
    if (!opts.resume) try {
      const { getPlanStrict } = await import('./plan.service');
      const plan = await getPlanStrict(opts.sessionId).catch(() => undefined);
      if (plan !== undefined) {
        const unfinished = (plan?.steps ?? []).filter((st: any) => st.status === 'pending' || st.status === 'in_progress');
        if (unfinished.length === 0) return { ok: false, reason: 'obsolete' };
      }
    } catch { /* uncertainty never drops a resumption */ }
    // Cap-skip self-healing parity with startScheduledRun: the continuation IS
    // the session's next run start, so it consumes (and, on failure, restores)
    // any pending skipped-firings notice.
    skipped = await consumeCapSkipNotice(opts.sessionId).catch(() => 0);
    // Spend-skip parity (P7): same consume-or-restore contract as above.
    spendSkipped = await import('./spend-cap.service')
      .then((m) => m.consumeSpendCapSkipNotice(opts.sessionId))
      .catch(() => 0);
    // Terminal-stop parity (feedback 065caccb): the fast lane bypasses
    // fireScheduleTarget, so a continuation prompt naming a now-CLOSED ticket
    // would echo-re-audit it (lane e8b27fcd × 4 on done 7503189b). Decorate
    // here too — same advisory/fail-open doctrine.
    const decoratedPrompt0 = await appendTerminalStopNotice(opts.prompt, `continuation:${opts.sessionId.slice(0, 8)}`);
    // Infra-blocker advisory parity (feedback 2b45941b): the fast lane
    // bypasses fireScheduleTarget, so decorate here too.
    const decoratedPrompt1 = await appendInfraBlockerNotice(decoratedPrompt0, `continuation:${opts.sessionId.slice(0, 8)}`);
    // Batch-train advisory parity (T2c, todo 9c89ab21): same seam, same
    // doctrine — cache-only read, fail-open, advisory never a skip.
    const decoratedPrompt = await appendBatchTrainNotice(decoratedPrompt1, `continuation:${opts.sessionId.slice(0, 8)}`);
    // audit 2026-10-06 T4-6 (litellm.md F6): a continuation is framed as what
    // it is — "a harness continuation of run <id>", not "a scheduled firing of
    // a recurring/one-shot schedule" — and the count sentence drops the false
    // "≥15 minutes old" caveat (this lane queues ~45 s after the finalize).
    // The run id is the finalizing run (still 'running' at this moment).
    // Origin stays 'schedule' (the executor's machine classification is
    // unchanged); RunInput.continuationOf marks the row for telemetry/audits.
    // Kill switch CONTINUATION_FRAMING_DISABLED=1 restores the schedule framing.
    const ownFraming = !continuationFramingDisabled();
    let previousRunId: string | undefined;
    let framedPrompt = decoratedPrompt;
    if (ownFraming) {
      previousRunId = opts.previousRunId;
      if (!previousRunId) {
        try {
          const prev = await prisma.agentRun.findFirst({
            where: { sessionId: opts.sessionId, status: 'running' },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          });
          previousRunId = typeof prev?.id === 'string' ? prev.id : undefined;
        } catch { previousRunId = undefined; }
      }
      const { CONTINUATION_COUNT_CAPTURE_RE, continuationCountSentence } = await import('./plan.service');
      framedPrompt = decoratedPrompt.replace(CONTINUATION_COUNT_CAPTURE_RE, (_m: string, n: string) =>
        continuationCountSentence(Number(n), { queuedAtFinalize: true, previousRunId: previousRunId ?? null }));
    }
    // Machine-origin input — the same shape startScheduledRun queues for a
    // schedule firing (provenance header + origin 'schedule') — but NO
    // scheduleId: this is not a coding_schedules firing, so it must never feed
    // a schedule's provider-fail counter (RunInput.scheduleId doctrine) or the
    // schedule daily cap.
    const input: RunInput = {
      message: (ownFraming ? machineFiringHeader('continuation', { continuationOf: previousRunId ?? null }) : machineFiringHeader('schedule')) + framedPrompt,
      images: [],
      userId: opts.userId,
      origin: 'schedule',
      ...(ownFraming ? { continuationOf: previousRunId ?? 'unknown' } : {}),
      ...(skipped > 0 ? { capSkippedNotice: skipped } : {}),
      ...(spendSkipped > 0 ? { spendCapSkippedNotice: spendSkipped } : {}),
    };
    const row = await prisma.agentRun.create({
      data: {
        sessionId: opts.sessionId,
        status: 'queued',
        input: input as unknown as object,
        // NOT-BEFORE: run-claim's queued predicate skips the row until
        // leaseExpiresAt passes — the channel requeueRun already uses for its
        // lock-contention backoff.
        leaseExpiresAt: new Date(Date.now() + delayMs),
      },
      select: { id: true },
    });
    logger.info(`coding schedule: continuation fast-lane queued run ${row.id} for session ${opts.sessionId.slice(0, 8)} (not-before ~${Math.round(delayMs / 1000)}s)`);
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.WAKE_DELIVERED, sessionId: opts.sessionId, runId: row.id, meta: { lane: 'continuation_fastlane' } });
    return { ok: true, runId: row.id };
  } catch (err: any) {
    if (skipped > 0) await restoreCapSkipNotice(opts.sessionId, skipped).catch(() => {});
    if (spendSkipped > 0) {
      await import('./spend-cap.service')
        .then((m) => m.restoreSpendCapSkipNotice(opts.sessionId, spendSkipped))
        .catch(() => {});
    }
    return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
  }
}

/* ── Durable owner-answer wake retry (remediation P2 v1#6, 2026-09-09) ────────
 * The owner-questions answer wake is fire-and-forget (fireScheduleTarget): a
 * busy chat, a spent daily budget, or a mid-call process death parked the
 * OWNER'S ANSWER until the chat's next organic wake. This arms a DB-backed
 * one-shot retry through the existing sweeper — the row survives deploys,
 * busy-skips re-arm every ~3 min, cap-skips retry each interval, and the 24h
 * expiresAt bounds it. The prompt LEADS with a machine-readable marker
 * ([owner-answer-retry:<oq id>]) used for the per-question dedupe below.
 * Direct row create (not createSchedule): the 15-min interval floor and the
 * per-session active cap are agent-fan-out guardrails; this is ONE harness-
 * authored retry per answered question, wanted within minutes.
 */
export const OWNER_ANSWER_RETRY_MARKER_PREFIX = '[owner-answer-retry:';
const OWNER_ANSWER_RETRY_DELAY_SEC = 180; // first attempt ~3 min out; busy re-arms keep the same pace
const OWNER_ANSWER_RETRY_LIFETIME_MS = 24 * 60 * 60 * 1000;

export async function armOwnerAnswerRetrySchedule(opts: {
  sessionId: string;
  prompt: string;
  marker: string;
}): Promise<{ ok: boolean; scheduleId?: string; reason?: string }> {
  try {
    const marker = String(opts.marker || '').slice(0, 120);
    if (!marker.startsWith(OWNER_ANSWER_RETRY_MARKER_PREFIX)) {
      return { ok: false, reason: 'bad_marker' };
    }
    // Per-question dedupe: one live retry row per marker.
    const existing = await prisma.chatSchedule.findFirst({
      where: { sessionId: opts.sessionId, enabled: true, prompt: { startsWith: marker } },
      select: { id: true },
    });
    if (existing) return { ok: true, scheduleId: existing.id };
    const retireOn = !archivedTargetRetireDisabled();
    const chat = await prisma.crossModelChat.findUnique({
      where: { id: opts.sessionId },
      select: retireOn ? { userId: true, archivedAt: true, codingState: { select: { status: true } } } : { userId: true },
    });
    if (!chat) return { ok: false, reason: 'not_found' };
    // ARCHIVED-TARGET-RETIRE (b, 2026-10-20): never arm a retry ONTO an
    // archived chat — every attempt would be refused for 24 h (the owner
    // answer is re-routed to a supervisor upstream, owner-questions.ts).
    if (retireOn && isArchivedTargetRow(chat as any)) {
      recordArchivedTargetRetire(opts.sessionId, { surface: 'arm', action: 'refused', arm: 'owner_answer_retry', marker, chatId: opts.sessionId });
      logger.info(`coding schedule: owner-answer retry refused on ARCHIVED chat ${opts.sessionId.slice(0, 8)} (${marker}) — archived-target-retire`);
      return { ok: false, reason: 'archived' };
    }
    const now = Date.now();
    const prompt = `${marker}\n${String(opts.prompt || '').trim()}`.slice(0, MAX_PROMPT_CHARS);
    const row = await prisma.chatSchedule.create({
      data: {
        sessionId: opts.sessionId,
        userId: chat.userId,
        prompt,
        kind: 'once',
        intervalSec: OWNER_ANSWER_RETRY_DELAY_SEC,
        nextRunAt: new Date(now + OWNER_ANSWER_RETRY_DELAY_SEC * 1000),
        maxRuns: 1,
        expiresAt: new Date(now + OWNER_ANSWER_RETRY_LIFETIME_MS),
        enabled: true,
        promptSetBy: 'system', // harness-authored — never counts as autonomous drift
      },
      select: { id: true },
    });
    logger.info(`coding schedule: owner-answer durable retry ${row.id} armed on ${opts.sessionId.slice(0, 8)} (${marker})`);
    return { ok: true, scheduleId: row.id };
  } catch (err: any) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
  }
}

/* ── Machine-run wall-clock deadline (v1#33) ──────────────────────────────────
 * A wedged MACHINE coding run held its lane busy forever: the busy skip re-arms
 * the schedule +3 min, so the watchdog's overdue scan read the lane as healthy
 * while nothing had produced output for hours. Machine runs now get a SOFT
 * deadline the agent loop already understands (AgentProfile.runDeadlineMs —
 * past it, the next step is forced to be the last and the model must answer
 * honestly with work-so-far). User runs are untouched (no latency contract).
 */

/** Soft-deadline floor for machine coding runs. */
export const MACHINE_RUN_DEADLINE_FLOOR_MS = 20 * 60 * 1000;

/**
 * Soft deadline for one machine run on this chat:
 * max(20 min, 0.8 × the shortest ENABLED RECURRING interval on the chat) — a
 * run should finish inside its own cadence, with 20 min as the floor so short
 * cadences never strangle real work. null = no deadline (the DEFAULT since
 * 2026-09-11). A read hiccup degrades to the floor: uncertainty must not
 * return an unbounded run.
 *
 * Gate flip 2026-09-11 (owner: full steam): the machine-run soft deadline is
 * OFF by default — it truncated 11.3% of machine runs (516 tools-off collapses
 * on 113 runs, 76 Partial / 23 Failed) and never freed a lane, while wedges
 * are already bounded by maxSteps, per-call timeouts, lease reclaim and the
 * zombie stop — opt-in RUN_DEADLINE_ENABLED=1 restores enforcement (the old
 * RUN_DEADLINE_DISABLED kill-switch is retired). Chat/supervisor/cross-checker
 * profile deadlines in agent-profiles.ts are latency contracts and untouched.
 */
export async function computeMachineRunDeadlineMs(sessionId: string): Promise<number | null> {
  if (process.env.RUN_DEADLINE_ENABLED !== '1') return null;
  try {
    const rows = await prisma.chatSchedule.findMany({
      where: { sessionId, enabled: true, kind: 'recurring', intervalSec: { not: null } },
      select: { intervalSec: true },
    });
    const shortest = rows.reduce(
      (min: number, r: any) => (typeof r.intervalSec === 'number' && r.intervalSec > 0 && r.intervalSec < min ? r.intervalSec : min),
      Number.POSITIVE_INFINITY,
    );
    const fromInterval = Number.isFinite(shortest) ? Math.round(shortest * 1000 * 0.8) : 0;
    return Math.max(MACHINE_RUN_DEADLINE_FLOOR_MS, fromInterval);
  } catch {
    return MACHINE_RUN_DEADLINE_FLOOR_MS;
  }
}

/** Soft-deadline multiplier for a run FIRED BY a recurring machine schedule
 *  (finding B3, 2026-09-27): 3 × the schedule's interval. With the arm-time
 *  duration fit (interval ≥ the p50 run length at the default 1× multiplier)
 *  this is ≥ 3 × the lane's typical run, so it binds only on a genuinely
 *  wedged run. */
export const SCHEDULE_FIRING_DEADLINE_MULTIPLIER = 3;

/** max(20-min floor, 3 × intervalSec) in ms. Pure. */
export function scheduleFiringDeadlineMs(intervalSec: number): number {
  const fromInterval = Number.isFinite(intervalSec) && intervalSec > 0
    ? Math.round(intervalSec * 1000 * SCHEDULE_FIRING_DEADLINE_MULTIPLIER)
    : 0;
  return Math.max(MACHINE_RUN_DEADLINE_FLOOR_MS, fromInterval);
}

/**
 * Soft deadline for a run fired by a RECURRING machine/system schedule: 3 × its
 * interval, delivered through the same AgentProfile.runDeadlineMs seam as
 * v1#33 (past it the NEXT step is forced to be the last — tools off, the model
 * answers with work-so-far; never a kill, approval waits excluded). OPT-IN:
 * null unless SCHEDULE_DURATION_DEADLINE_ENABLED=1 — the 2026-09-11 gate flip
 * turned the machine-run deadline off because 0.8× cadence truncated 11.3% of
 * machine runs, and the owner's "full steam" rule stands. This variant is far
 * looser (3× the cadence, and the cadence itself now follows the run) and is
 * here for the owner to arm once the arm-time fit has re-spaced the fleet.
 * Owner-armed rows ('user' / legacy NULL promptSetBy) and one-shots never carry
 * it. Fail-open: any read error → null (no deadline).
 */
export async function computeScheduleFiringDeadlineMs(scheduleId: string | null | undefined): Promise<number | null> {
  if (process.env.SCHEDULE_DURATION_DEADLINE_ENABLED !== '1' || !scheduleId) return null;
  try {
    const row = await prisma.chatSchedule.findUnique({
      where: { id: scheduleId },
      select: { kind: true, intervalSec: true, promptSetBy: true },
    });
    if (!row || row.kind !== 'recurring') return null;
    if (row.promptSetBy !== 'machine' && row.promptSetBy !== 'system') return null;
    if (typeof row.intervalSec !== 'number' || row.intervalSec <= 0) return null;
    return scheduleFiringDeadlineMs(row.intervalSec);
  } catch {
    return null;
  }
}

/** Grace floor a RE-CLAIMED attempt keeps even when the run's durable clock is
 *  already past its budget — enough to wrap up honestly, never born expired. */
export const RECLAIM_DEADLINE_GRACE_MS = 3 * 60 * 1000;

/**
 * Deadline budget REMAINING for this attempt, anchored to the run's durable
 * first-claim startedAt (P0 L13 — preserved across re-claims). Deploy-churn
 * fix (2026-09-09 watcher jam): the soft deadline used to restart on every
 * worker re-claim, so back-to-back deploys kept a 15-min-cadence run alive
 * 90+ minutes while its lane busy-skipped 20 firings. Pure.
 */
export function remainingRunDeadlineMs(deadlineMs: number, startedAt: Date | null | undefined, now = Date.now()): number {
  const elapsed = startedAt ? Math.max(0, now - startedAt.getTime()) : 0;
  return Math.max(RECLAIM_DEADLINE_GRACE_MS, deadlineMs - elapsed);
}

/** Compact heartbeat view of a session's schedules for status payloads. */
export async function getScheduleHealth(sessionId: string): Promise<{ active: number; terminal: number; items: Array<Pick<ScheduleView, 'id' | 'kind' | 'intervalSec' | 'nextRunAt' | 'lastFiredAt' | 'lastStatus' | 'runsCount' | 'maxRuns' | 'busySkips'>> }> {
  // Active rows are queried EXPLICITLY (bounded by MAX_ACTIVE_PER_SESSION, so no
  // take needed) — the old newest-50-then-filter window dropped a long-lived
  // recurring row once 50+ newer terminal rows accumulated, reporting a live
  // monitor as dead (active: 0) and inviting a duplicate recreation.
  const [rows, terminal] = await Promise.all([
    prisma.chatSchedule.findMany({ where: { sessionId, enabled: true }, orderBy: { createdAt: 'desc' } }),
    prisma.chatSchedule.count({ where: { sessionId, enabled: false } }),
  ]);
  const items = rows.map(r => ({
    id: r.id, kind: r.kind, intervalSec: r.intervalSec ?? null,
    nextRunAt: r.nextRunAt instanceof Date ? r.nextRunAt.toISOString() : (r.nextRunAt as string),
    lastFiredAt: r.lastFiredAt ? (r.lastFiredAt instanceof Date ? r.lastFiredAt.toISOString() : (r.lastFiredAt as string)) : null,
    lastStatus: r.lastStatus ?? null, runsCount: r.runsCount, maxRuns: r.maxRuns ?? null,
    // A lane held busy is invisible in lastStatus alone — surface the streak.
    busySkips: r.busySkips ?? 0,
  }));
  return { active: items.length, terminal, items };
}

const GC_INTERVAL_MS = 60 * 60 * 1000;                 // run GC at most hourly
const TERMINAL_ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // keep terminal rows 30 days (audit trail of what fired and why it stopped)
let lastGcAt = 0;

/**
 * Delete terminal (disabled) rows whose last activity is older than the TTL —
 * they otherwise accumulate forever (65+ dead rows observed on one fleet, and
 * listSchedules' take:50 then silently truncates LIVE history). The table has no
 * updatedAt, so "last activity" = lastFiredAt when present else createdAt; BOTH
 * createdAt and lastFiredAt must be older than the cutoff. Called hourly from the
 * sweeper; deleteMany is idempotent, so blue-green instances race harmlessly.
 */
export async function gcTerminalSchedules(olderThanMs = TERMINAL_ROW_TTL_MS): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const res = await prisma.chatSchedule.deleteMany({
    where: { enabled: false, createdAt: { lt: cutoff }, OR: [{ lastFiredAt: null }, { lastFiredAt: { lt: cutoff } }] },
  }).catch(() => ({ count: 0 }));
  if (res.count > 0) logger.info(`coding schedule GC: deleted ${res.count} terminal row(s) idle >${Math.round(olderThanMs / 86_400_000)}d`);
  return res.count;
}

// ── User-scoped variants (P1 platform unification) ────────────────────────────
// The platform tools / future REST API operate as the USER, not as one session.

/** Minimum length for an id PREFIX to resolve (8 = the prefix style agent-facing
 *  truncation produces). Shorter inputs stay exact-only. */
export const MIN_SCHEDULE_ID_PREFIX_LEN = 8;

/**
 * Exact-id-or-unique-prefix resolution (owner-scoped) — same contract as the
 * hook tools' resolveHookIdForUser (nightly-lane postmortem 2026-08-27): a lane
 * holding only a severed prefix ("6bdedc2a-…", from a message-content cap or
 * the 8-char citation style) dead-ended with "No such schedule". Order: exact
 * id → unique ≥8-char prefix. Zero matches → null; MULTIPLE → throw listing the
 * candidate full ids — never guess. Plain Error (not AppError): this module is
 * imported by jest suites that do not mock the error-handler (its config/env
 * chain exits the worker at import), and the tool surface renders any
 * rejection's message to the model either way.
 */
export async function resolveScheduleIdForUser(userId: string, idOrPrefix: string): Promise<string | null> {
  const id = String(idOrPrefix || '').trim();
  if (!id) return null;
  const exact = await prisma.chatSchedule.findFirst({ where: { id, userId } });
  if (exact) return exact.id;
  if (id.length < MIN_SCHEDULE_ID_PREFIX_LEN) return null;
  const matches = await prisma.chatSchedule.findMany({
    where: { userId, id: { startsWith: id } },
    select: { id: true },
    take: 5,
  });
  if (!matches.length) {
    // audit 2026-10-08 W3-3: the shared heal tier — a ≥8-char suffix / prefix+suffix splice, owner-scoped.
    const { healIdRef } = await import('../platform/id-ref');
    const healed = await healIdRef(id, {
      byPrefix: async (prefix, take) => (await prisma.chatSchedule.findMany({ where: { userId, id: { startsWith: prefix } }, select: { id: true }, take })).map((r) => r.id),
      bySuffix: async (suffix, take) => (await prisma.chatSchedule.findMany({ where: { userId, id: { endsWith: suffix } }, select: { id: true }, take })).map((r) => r.id),
    }, 'schedule');
    if (healed.ok) return healed.id;
    if (healed.reason === 'ambiguous') {
      throw new Error(`Ambiguous schedule id "${id}" — matches ${healed.candidates.length} of your schedules: ${healed.candidates.join(', ')}. Pass the full id.`);
    }
    return null;
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous schedule id prefix "${id}" — matches ${matches.length} of your schedules: ${matches.map((m) => m.id).join(', ')}. Pass the full id.`);
  }
  return matches[0].id;
}

export interface UserScheduleView extends ScheduleView {
  /** The target chat (== crossmodel_chats.id; a coding session iff it carries a workspace satellite). */
  sessionId: string;
}

/**
 * ONE of this user's schedules, ANY status, by exact id or unique ≥8-char
 * prefix (ticket 03aef0da): the listing behind schedule_get keeps every active
 * row but only the newest-100 TERMINAL rows, so a schedule stopped after a
 * [FLEET ATTENTION] block named it (and older than that window) read "No such
 * schedule" — an id the harness itself had just printed. Owner-scoped; an
 * ambiguous prefix throws with the candidates (resolveScheduleIdForUser).
 */
export async function getScheduleForUser(userId: string, idOrPrefix: string): Promise<UserScheduleView | null> {
  const id = await resolveScheduleIdForUser(userId, idOrPrefix);
  if (!id) return null;
  const row = await prisma.chatSchedule.findFirst({ where: { id, userId } });
  if (!row) return null;
  const [view] = await enrichWithCapState([{ ...toView(row), sessionId: row.sessionId }], (v) => v.sessionId);
  return view ?? null;
}

/** All of a user's schedules across every chat (both enabled and finished),
 *  newest first. */
export async function listSchedulesForUser(userId: string): Promise<UserScheduleView[]> {
  // ACTIVE rows are queried EXPLICITLY (per-chat actives are bounded by
  // MAX_ACTIVE_PER_SESSION, so no take needed) and never windowed out by the
  // history cap — the same live-monitor-invisible bug as listSchedules
  // (ticket dd0d37ac / feedback dd0d37ac: an active 242-run recurring schedule
  // vanished from two consecutive full listings while it kept firing — the old
  // newest-first take window dropped it once enough newer terminal rows piled
  // up, and "the listing looked complete"). Terminal history stays capped at
  // the newest 100. A row flipping enabled between the two parallel reads
  // could land in BOTH halves — dedup by id, active wins. The merged list is
  // re-sorted newest-first (matches listSchedules above).
  const [active, terminal] = await Promise.all([
    prisma.chatSchedule.findMany({ where: { userId, enabled: true }, orderBy: { createdAt: 'desc' } }),
    prisma.chatSchedule.findMany({ where: { userId, enabled: false }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  const byId = new Map<string, (typeof active)[number]>();
  for (const s of [...active, ...terminal]) if (!byId.has(s.id)) byId.set(s.id, s);
  const rows = [...byId.values()].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
  return enrichWithCapState(rows.map((s) => ({ ...toView(s), sessionId: s.sessionId })), (v) => v.sessionId);
}

/**
 * Cancel (disable) a schedule owned by this USER. Returns false if not found.
 * `initiator` (SA0906): 'owner' (default — REST DELETE, fleet dashboard,
 * user-anchored cancel_schedule) is an explicit human choice and files NO
 * stopped-schedule decision; 'machine' (a machine-triggered run's tool call —
 * platform-tools passes ctx.userTurnAt ? 'owner' : 'machine') queues the
 * delayed lane-liveness re-check exactly like a cap/expiry stop.
 */
export async function cancelScheduleForUser(
  userId: string,
  id: string,
  opts?: { initiator?: 'owner' | 'machine'; actorChatId?: string | null },
): Promise<boolean> {
  const scheduleId = await resolveScheduleIdForUser(userId, id);
  if (!scheduleId) return false;
  const row = await prisma.chatSchedule.findFirst({ where: { id: scheduleId, userId } });
  if (!row) return false;
  // v1#13: persist WHO disabled it + WHEN — the digest backstop re-offers
  // machine-cancelled recurring lanes durably (the 12-min timer is only the
  // lossy fast path), and forensics stop guessing from lastStatus alone.
  await prisma.chatSchedule.update({
    where: { id: row.id },
    data: { enabled: false, lastStatus: 'cancelled', cancelledBy: opts?.initiator === 'machine' ? 'machine' : 'owner', disabledAt: new Date() },
  });
  logger.info(`schedule: cancelled ${row.id} for user ${userId.slice(0, 8)} (initiator ${opts?.initiator ?? 'owner'})`);
  await emitScheduleDisabled(row, 'cancelled', row.runsCount, opts?.actorChatId ? { actorChatId: opts.actorChatId } : undefined);
  if (opts?.initiator === 'machine' && row.kind === 'recurring') {
    await queueStoppedScheduleAlertSafe(row.id, 'cancelled');
  }
  return true;
}

/**
 * Update a schedule owned by this USER (feedback c6147f39): prompts and cadence
 * were immutable, so multi-day autonomous work left STALE schedules firing
 * superseded instructions — a production hazard when a phase transition makes
 * an old prompt actively wrong. Mutable here: prompt and/or intervalSec
 * (recurring cadence). kind/maxRuns stay immutable — cancel + recreate for
 * those. An interval change keeps the current nextRunAt: the next firing
 * happens on the old timing, subsequent ones on the new cadence.
 */
export async function updateScheduleForUser(
  userId: string,
  id: string,
  updates: { prompt?: string; intervalSec?: number; promptSetBy?: string; requiredProbes?: unknown; deltaGate?: unknown; ownerSubscribed?: boolean },
): Promise<{ ok: boolean; schedule?: UserScheduleView; error?: string; warning?: string; stretchedFrom?: number }> {
  const scheduleId = await resolveScheduleIdForUser(userId, id);
  if (!scheduleId) return { ok: false, error: `No such schedule "${id}".` };
  const row = await prisma.chatSchedule.findFirst({ where: { id: scheduleId, userId } });
  if (!row) return { ok: false, error: `No such schedule "${id}".` };
  // CanLaw B1: updating a DISABLED/terminal row used to "succeed" silently —
  // the caller believed its cadence was re-steered while the row would never
  // fire again. Refuse with an honest envelope naming the state and the fix.
  if (!row.enabled) {
    return {
      ok: false,
      error: `Schedule ${row.id} is DISABLED (last status: ${row.lastStatus ?? 'unknown'}) — it will never fire again, so updating it changes nothing. ` +
        `Nothing was updated. ${row.lastStatus === 'paused' || row.lastStatus === 'cancelled' || row.lastStatus === 'parked:dormant' ? 'Resume it first (resume_schedule, or the Schedules tab), or ' : ''}create a fresh schedule with schedule_message/schedule_self instead.`,
    };
  }
  const data: { prompt?: string; intervalSec?: number; nextRunAt?: Date; promptSetBy?: string; requiredProbes?: any; deltaGate?: any; ownerSubscribed?: boolean } = {};
  // Once-row retime (82c13b77): set when this update retimes a kind:'once'
  // row — the 'retimed' line is logged AFTER the write so a later
  // whole-update refusal never reports a retime that did not land (review C3).
  let onceRetime = false;
  if (updates.prompt !== undefined) {
    const prompt = updates.prompt.trim();
    if (!prompt) return { ok: false, error: 'Prompt cannot be empty.' };
    data.prompt = prompt;
    // A prompt rewrite re-stamps authorship (an interval-only tweak keeps it).
    if (updates.promptSetBy) data.promptSetBy = updates.promptSetBy;
  }
  // Owner-subscription marking (ticket 4565991a): true marks the row's
  // firings as owner-subscribed content (renders EXPANDED); false unmarks.
  // Deliberately INDEPENDENT of a prompt rewrite — a machine update_schedule
  // that rewrites the prompt (restamping promptSetBy 'machine') passes
  // ownerSubscribed undefined and PRESERVES the mark (the 6ef770a1 latent
  // hole: the mark used to live in promptSetBy and collapsed the digest
  // again on every machine rewrite). The gates live in platform-tools: a
  // real user turn, or a firing that was ITSELF owner-subscribed updating
  // its OWN chat's row (ladder inheritance) — never a plain machine arm.
  if (updates.ownerSubscribed !== undefined) data.ownerSubscribed = updates.ownerSubscribed;
  if (updates.intervalSec !== undefined) {
    if (!Number.isFinite(updates.intervalSec) || updates.intervalSec < MIN_INTERVAL_SEC) {
      return { ok: false, error: `Interval must be at least ${Math.round(MIN_INTERVAL_SEC / 60)} minutes.` };
    }
    // ── wake-cadence-3 (2026-09-27 tt-rd audit): STOCK-SWEEP FLOOR. The tt-rd
    //    project supervisor halved its own stock sweep to 30 min during an
    //    outage wake (receipt f089cbf4, 2026-09-24 01:55Z) and nothing ever
    //    restored it — the only project sweep in the fleet below default, 48
    //    sweeps/day at 76 % no-op. A MACHINE turn may not set a stock sweep
    //    (fleet or project opener) below its default cadence; owner turns may. ──
    if (row.kind === 'recurring') {
      const floorRefusal = stockSweepFloorRefusal({ cls: classifySweepPrompt(row.prompt), machineActor: updates.promptSetBy === 'machine', intervalSec: Math.round(updates.intervalSec) });
      if (floorRefusal) {
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.SWEEP_BACKOFF, sessionId: row.sessionId, meta: { chatId: row.sessionId, scheduleId: row.id, kind: 'floor_refused', from: row.intervalSec ?? null, to: Math.round(updates.intervalSec) } });
        logger.info(`schedule: interval update refused for stock sweep ${row.id} — ${Math.round(updates.intervalSec / 60)} min is below the stock-sweep floor (wake-cadence-3)`);
        return { ok: false, error: `Refused: ${floorRefusal}` };
      }
    }
    // ── Once-row retime (2026-09-21, Fleet-reported d2e1f633 class) ──────────
    // intervalMinutes on a kind:'once' row used to be a SILENT NO-OP with a
    // lying envelope: intervalSec was stored (meaningless — the row fires once
    // and dies at runsCount>=1, maybeRenewOnExhaustion refuses non-recurring)
    // while nextRunAt never moved, so the caller's "fire later" intent was
    // dropped — yet the response printed "now every N min", which the CanLaw
    // supervisor read as a flip to a recurring 27-minute cadence, and the lane
    // burned 3 cancel+re-arm rows (d2e1f633/da38d705/c79a0960) getting the
    // timing right. Create-time semantics (createSchedule line ~368) make
    // intervalSec the DELAY to the single firing — retiming now means exactly
    // that: nextRunAt = now + interval, kind stays 'once', and the log line
    // records the retime.
    if (row.kind === 'once') {
      const newRunAt = new Date(Date.now() + Math.round(updates.intervalSec) * 1000);
      // Review C1 (2026-09-22): expiresAt is a HARD lifetime ceiling the sweeper
      // enforces BEFORE firing (processDueScheduleRow disables 'expired' first) —
      // a retime landing past it would return ok:true for a row that can NEVER
      // fire (a NEW lost-firing mode; the old no-op at least kept the original
      // firing time). Refuse honestly, naming the ceiling.
      if (row.expiresAt && newRunAt.getTime() > row.expiresAt.getTime()) {
        return {
          ok: false,
          error: `Schedule ${row.id} is a ONE-SHOT whose lifetime expires at ${row.expiresAt.toISOString()} — a retime to +${Math.round(updates.intervalSec / 60)} min would land past that ceiling and the row would be disabled 'expired' WITHOUT ever firing. ` +
            `Nothing was updated. Pick a firing time before the expiry, or cancel this row and arm a fresh one-shot.`,
        };
      }
      data.intervalSec = Math.round(updates.intervalSec);
      data.nextRunAt = newRunAt;
      onceRetime = true;
      // The 'retimed' line is logged AFTER the write (review C3): later
      // whole-update refusals (requiredProbes / deltaGate / the prompt-rewrite
      // cap) must never report a retime that did not land.
    } else {
      data.intervalSec = Math.round(updates.intervalSec);
    }
  }
  // Required probes (P7 G13): null clears the gate; an array must survive
  // parseRequiredProbes (tool required; argPattern a valid regex) or the whole
  // update is refused with the shape spelled out — a silently-dropped probe
  // list would leave the caller believing the gate is armed.
  if (updates.requiredProbes !== undefined) {
    if (updates.requiredProbes === null || (Array.isArray(updates.requiredProbes) && updates.requiredProbes.length === 0)) {
      // Prisma nullable-Json contract: JS null is rejected at runtime — DbNull
      // writes an SQL NULL (the project-digest etaSummary pattern).
      data.requiredProbes = Prisma.DbNull as any;
    } else {
      const probes = parseRequiredProbes(updates.requiredProbes);
      if (!probes.length) {
        return { ok: false, error: 'requiredProbes must be an array of {tool, argPattern?} entries (tool = the receipt tool name; argPattern = an optional VALID regex tested against the receipt ids envelope), or null/[] to clear. Nothing was updated.' };
      }
      data.requiredProbes = probes as any;
    }
  }
  // Delta gate (ticket 0b1dbe75): null clears the gate (Prisma.DbNull — the
  // requiredProbes contract above); otherwise strict validation — the whole
  // update is refused with the shape spelled out. A REPLACED gate stores
  // markerless probes (validateDeltaGate strips platform-maintained fields),
  // so the next evaluation FIRES once to re-baseline. 'once' rows are refused:
  // a single firing has nothing to skip.
  if (updates.deltaGate !== undefined) {
    if (updates.deltaGate === null) {
      data.deltaGate = Prisma.DbNull as any;
    } else {
      if (row.kind === 'once') {
        return { ok: false, error: 'deltaGate only applies to recurring schedules (a one-shot fires exactly once — there is nothing to skip). Nothing was updated.' };
      }
      const v = validateDeltaGate(updates.deltaGate);
      if (v.error || !v.gate) {
        return { ok: false, error: `${v.error ?? 'invalid deltaGate'} Shape: {probes: [{url (https only, no credentials), headers? (≤8 name/value pairs), jsonPath? | pattern? — exactly one}], heartbeatHours? (1-168, default 6)}; or null to clear. Nothing was updated.` };
      }
      data.deltaGate = v.gate as any;
    }
  }
  if (!Object.keys(data).length) return { ok: false, error: 'Nothing to update — pass prompt, intervalMinutes, requiredProbes and/or deltaGate.' };

  // Cap-cadence guard (ticket 2694a581) — the same math as createSchedule,
  // keyed off the runs the row has LEFT (a nearly-exhausted row cannot burn
  // the cap). A refusal rejects the WHOLE update — nothing half-applies.
  let cadenceWarning: string | undefined;
  let durationWarning: string | undefined;
  let stretchedFrom: number | undefined;
  if (data.intervalSec !== undefined && row.kind === 'recurring') {
    // Arm-time duration fit (finding B3, 2026-09-27) — the same math as
    // createSchedule: a MACHINE cadence shorter than 2× the lane's p50 run
    // length is stretched; the cap guard below evaluates the stretched value.
    const fit = await durationFitGuard(row.sessionId, data.intervalSec, updates.promptSetBy === 'machine', row.id);
    if (fit) {
      durationWarning = fit.warn;
      if (fit.stretched) {
        logger.info(`schedule: interval update for ${row.id} stretched ${data.intervalSec}s → ${fit.intervalSec}s (p50 run ${Math.round(fit.p50RunMs / 60000)} min over ${fit.samples} runs; finding B3)`);
        stretchedFrom = data.intervalSec;
        data.intervalSec = fit.intervalSec;
      }
    }
    const remaining = Math.max(0, (row.maxRuns ?? MAX_RUNS) - (row.runsCount ?? 0));
    const verdict = await capCadenceGuard(row.sessionId, data.intervalSec, remaining, updates.promptSetBy === 'machine');
    if (verdict?.refuse) {
      logger.info(`schedule: interval update refused for ${row.id} — ${data.intervalSec}s projects ${verdict.effectiveDaily}/day vs cap ${verdict.cap} (ticket 2694a581)`);
      return { ok: false, error: `${verdict.refuse} Nothing was updated.` };
    }
    cadenceWarning = verdict?.warn;
  }
  // ── P6 (N4): prompt-rewrite ledger + machine-rewrite cap. Applies only to a
  // REAL prompt change (interval-only tweaks and no-op rewrites skip both). ──
  if (data.prompt !== undefined && data.prompt !== row.prompt) {
    const author = updates.promptSetBy || 'user';
    if (author === 'machine') {
      // Count today's machine rewrites from the ledger (fail-open on a read
      // error — uncertainty must never block a legitimate update).
      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const rewrites = await prisma.schedulePromptHistory
        .count({ where: { scheduleId: row.id, author: 'machine', createdAt: { gte: since } } })
        .catch(() => 0);
      if (rewrites >= MACHINE_PROMPT_REWRITES_PER_DAY) {
        // Gate flip 2026-09-11 (owner: full steam): the cap LOGS instead of
        // refusing — the rewrite falls through to the ledger append + update
        // below.
        logger.warn(`schedule: machine prompt-rewrite cap crossed for ${row.id} (${rewrites} in 24h ≥ ${MACHINE_PROMPT_REWRITES_PER_DAY}/day) — observed; the rewrite lands`);
      }
    }
    // Preserve the OUTGOING prompt BEFORE overwriting (append-only ledger; also
    // the cap's counting record and the fire-time "prompt changed (vN)" notice).
    // Best-effort: a ledger hiccup must not block a legitimate update.
    await prisma.schedulePromptHistory
      .create({ data: { scheduleId: row.id, prompt: row.prompt, author } })
      .catch((err: any) => logger.warn(`schedule: prompt-history append failed for ${row.id} (non-fatal): ${err?.message}`));
  }
  // Clock-drift advisory (ticket 903249e5) — the same math as createSchedule,
  // evaluated against the cadence the row will CARRY after the update (the new
  // interval when changing it, else the unchanged stored one: a prompt-only
  // rewrite of an already-drifting row surfaces the drift too). Computed after
  // every refusal so only a genuinely-written update carries it;
  // non-blocking — the update lands, the warning rides the response.
  const postInterval = data.intervalSec !== undefined ? data.intervalSec : row.intervalSec;
  const driftWarning = clockDriftWarningFor(row.kind, postInterval, Date.now());
  // wake-cadence-4 (observe-only prompt lint) — same rule as createSchedule, on a REAL prompt change only.
  const lint = data.prompt !== undefined && data.prompt !== row.prompt ? lintSchedulePrompt(data.prompt, updates.promptSetBy) : null;
  if (lint) {
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.SCHEDULE_PROMPT_LINT, sessionId: row.sessionId, meta: { rule: lint.rule, seam: 'update', scheduleId: row.id } });
  }
  const armWarning = [durationWarning, cadenceWarning, driftWarning, lint?.notice].filter(Boolean).join('\n\n') || undefined;
  const updated = await prisma.chatSchedule.update({ where: { id: row.id }, data });
  logger.info(`schedule: updated ${row.id} for user ${userId.slice(0, 8)} (${Object.keys(data).join('+')})`);
  // Owner-armed cadence edited by a MACHINE run (fixer 2026-09-27, AUDIT CHURN
  // finding 1): the supervisors' doctrine scopes "lengthen its cadence" to
  // machine-armed rows and says an owner-armed cadence (promptSetBy user, or a
  // legacy NULL — the same reading the project-supervisor heal uses) is
  // reported UP, never edited. This row measures the residual; it never
  // refuses (gates on machine lanes stay observe-only). The update above has
  // already landed.
  if (data.intervalSec !== undefined && updates.promptSetBy === 'machine' && (row.promptSetBy === 'user' || row.promptSetBy == null)
      && data.intervalSec !== row.intervalSec) {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SCHEDULE_OWNER_CADENCE_EDIT,
      sessionId: row.sessionId,
      meta: { scheduleId: row.id, kind: row.kind, fromIntervalSec: row.intervalSec ?? null, toIntervalSec: data.intervalSec, promptSetBy: row.promptSetBy ?? null },
    });
    logger.info(`schedule: machine run changed the cadence of OWNER-ARMED schedule ${row.id} (${row.intervalSec ?? '∅'}s → ${data.intervalSec}s) — observed (doctrine: report UP, never edit)`);
  }
  // wake-cadence-3 (fixer 2026-09-27): ATTRIBUTE a recurring row's interval
  // write to its author — the stock-sweep floor heal
  // (project-supervisor.service ensureProjectSweepSchedule) reads the newest
  // attributed `schedule.update` row and leaves an OWNER-lowered stock sweep
  // alone (the floor refusal promises "An owner turn may still set it lower").
  // Same discriminator as the floor refusal: promptSetBy 'machine' is a machine
  // turn (the update_schedule tool always passes the actor); anything else —
  // the Schedules-tab REST edit, a real user turn — is the owner. Best-effort:
  // the Activity write never blocks the update.
  if (row.kind === 'recurring' && data.intervalSec !== undefined && data.intervalSec !== row.intervalSec) {
    try {
      await prisma.activity.create({
        data: {
          userId, action: 'schedule.update', resource: 'platform',
          metadata: {
            scheduleId: row.id, chatId: row.sessionId, fields: ['intervalSec'],
            source: updates.promptSetBy === 'machine' ? INTERVAL_ATTRIBUTION_MACHINE_SOURCE : INTERVAL_ATTRIBUTION_OWNER_SOURCE,
            from: row.intervalSec ?? null, to: data.intervalSec,
          },
        },
      });
    } catch { /* attribution is best-effort */ }
  }
  if (onceRetime) {
    logger.info(`schedule: retimed one-shot ${row.id} — single firing now at ${updated.nextRunAt instanceof Date ? updated.nextRunAt.toISOString() : updated.nextRunAt}`);
  }
  const [schedule] = await enrichWithCapState([{ ...toView(updated), sessionId: updated.sessionId }], (v) => v.sessionId);
  return { ok: true, schedule, ...(armWarning ? { warning: armWarning } : {}), ...(stretchedFrom !== undefined ? { stretchedFrom } : {}) };
}

// ── Sweeper ────────────────────────────────────────────────────────────────────
let sweeperTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

/**
 * The chat's daily firing cap: its ChatAutonomy.scheduleCap (owner-granted via
 * set_chat_autonomy) when a row exists, else the default 48. autonomy.service is
 * loaded via dynamic import (its chain pulls in crossmodel.service →
 * platform.service → THIS module — a static import would cycle); a lookup
 * failure falls back to the default (fail-safe, never wedges).
 */
/** Supervisor lanes never sit below this daily machine-run cap (env-tunable).
 *  Rollout watch 2026-09-14 19:42Z: the Fleet Supervisor — the aggregation
 *  point for five project supervisors, whose children's firings also bill it —
 *  hit its manual 96/day grant and DROPPED quiet hook events for the rest of
 *  the UTC day. Project supervisors were granted 480 at preflight; the fleet
 *  grant predated them. A supervisor's effective cap is max(explicit grant,
 *  this floor); the storm breaker + spend envelope remain the cost guards. */
export const SUPERVISOR_MACHINE_RUN_DAILY_CAP_ENV = 'SUPERVISOR_MACHINE_RUN_DAILY_CAP';
export function supervisorDailyCapFloor(): number {
  const n = Number(process.env[SUPERVISOR_MACHINE_RUN_DAILY_CAP_ENV]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 480;
}

export async function capForSession(sessionId: string): Promise<number> {
  let cap = MAX_FIRES_PER_SESSION_PER_DAY;
  try {
    const { getChatAutonomy } = await import('../platform/autonomy.service');
    cap = (await getChatAutonomy(sessionId))?.scheduleCap ?? MAX_FIRES_PER_SESSION_PER_DAY;
  } catch { /* autonomy lookup hiccup → default cap */ }
  try {
    const chat = await prisma.crossModelChat.findUnique({ where: { id: sessionId }, select: { isSupervisor: true, isProjectSupervisor: true } });
    if (chat && ((chat as any).isSupervisor === true || (chat as any).isProjectSupervisor === true)) {
      cap = Math.max(cap, supervisorDailyCapFloor());
    }
  } catch { /* chat lookup hiccup → the grant/default stands */ }
  return cap;
}

/** Verdict of the cap-cadence guard (ticket 2694a581). */
export interface CapCadenceVerdict {
  /** Set when the arm is refused outright (machine arms whose cadence can never fit the cap). */
  refuse?: string;
  /** Set when the arm lands but must carry a loud cap-burn advisory. */
  warn?: string;
  /** Raw ticks/day the interval implies. */
  projectedDaily: number;
  /** min(projectedDaily, runs the row has left) — what can actually burn the cap. */
  effectiveDaily: number;
  /** The chat's effective daily firing cap used for the math. */
  cap: number;
}

/**
 * Cadence-vs-cap math for a recurring arm/update (ticket 2694a581 — a 30m
 * recurring alone consumes exactly 48 firings/day, the entire default cap, so
 * any one-shot steer or hook wake on the chat then skips daily_cap and the
 * chat goes deaf; a 15m recurring can never fit at all). effectiveDaily caps
 * the raw projection by the runs the row has LEFT — a short bounded burst
 * (small maxRuns, or a nearly-exhausted row on update) never trips the guard.
 * `machineActor` selects refuse-vs-warn for the can-never-fit class: an
 * explicit human cadence choice is warned, never overridden (owner autonomy —
 * the same scoping as the duplicate-backstop guard and the dormancy gate).
 * Resume of a pre-existing row is intentionally NOT re-guarded (the
 * firing-path cap still bounds it); the guard lives on the arm/update paths.
 */
export async function capCadenceGuard(
  sessionId: string,
  intervalSec: number,
  maxRunsRemaining: number,
  machineActor: boolean,
): Promise<CapCadenceVerdict | null> {
  const cap = await capForSession(sessionId);
  const projectedDaily = Math.floor(SECONDS_PER_DAY / intervalSec);
  const effectiveDaily = Math.min(projectedDaily, Math.max(0, maxRunsRemaining));
  if (!Number.isFinite(effectiveDaily) || effectiveDaily <= 0) return null;
  /** Smallest cadence whose projection fits the cap at all (minutes). */
  const minFittingMin = Math.ceil(SECONDS_PER_DAY / cap / 60);
  /** Cadence that leaves ≥50% of the cap as headroom for one-shots/hook wakes. */
  const roomyMin = Math.max(minFittingMin, Math.ceil(SECONDS_PER_DAY / (cap * 0.5) / 60));
  if (effectiveDaily > cap) {
    const msg =
      `this cadence (every ${Math.round(intervalSec / 60)} min) projects ~${projectedDaily} firings/day against the chat's daily schedule cap of ${cap} — it can NEVER fit: every firing past ${cap}/day skips daily_cap, and one-shot schedules + hook wakes share the same counter, so the chat goes DEAF for the rest of each window. ` +
      `Minimum fitting cadence at this cap: ${minFittingMin} min (${cap}/day); ≥${roomyMin} min leaves headroom for one-shots and hook wakes. ` +
      `To run a tighter loop, a real user turn can raise the chat's cap with set_chat_autonomy (scheduleCap, up to 1440/day).`;
    return machineActor
      ? { refuse: `Refused: ${msg} No schedule was created — re-arm at ≥${minFittingMin} min.`, projectedDaily, effectiveDaily, cap }
      : { warn: `⚠️ CAP MATH: ${msg}`, projectedDaily, effectiveDaily, cap };
  }
  if (effectiveDaily >= Math.ceil(cap * CAP_HEADROOM_WARN_FRACTION)) {
    const wholeBudget = effectiveDaily >= cap;
    const warn =
      `⚠️ CAP HEADROOM: this recurring alone projects ~${effectiveDaily} firings/day — ${wholeBudget ? `the chat's ENTIRE ${cap}/day schedule budget` : `${Math.round((effectiveDaily / cap) * 100)}% of the chat's ${cap}/day schedule budget`}. ` +
      `One-shot schedules and hook wakes share the same counter and will start skipping daily_cap once the window fills. ≥${roomyMin} min leaves headroom; set_chat_autonomy (scheduleCap) raises the cap from a real user turn.`;
    return { warn, projectedDaily, effectiveDaily, cap };
  }
  return null;
}

/* ── Arm-time duration fit (finding B3, 2026-09-27) ──────────────────────────
 * The cap-cadence guard above never looked at how long this lane's runs
 * actually TAKE, and coding runs carry no deadline (CODING_PROFILE.runDeadlineMs
 * is undefined) — so 15–30-min cadences were armed on lanes whose runs last
 * 546–991 min (one lane: 3,643 busy-skips over its life; four 15-min rows
 * fired 0×). A cadence shorter than the run only busy-skips: every firing
 * finds the lane held, re-arms +3 min, and produces nothing but noise. At
 * arm/update time a MACHINE recurring cadence is compared with the lane's p50
 * run length over its last DURATION_FIT_SAMPLE_RUNS FINISHED agent_runs and
 * auto-stretched to ≥ durationFitMultiplier() × p50 (1× by default — the
 * fixer pass on 2026-09-27 lowered the branch's 2×: at 2× every machine lane
 * whose run exceeds half its cadence idled ≈ p50 between firings (50 % duty)
 * against the owner's 2026-09-11 "full steam" rule; at 1× a busy-skip occurs
 * only on an above-median run and clears within the +3-min retry; env
 * SCHEDULE_DURATION_FIT_MULTIPLIER re-spaces harder — rounded up to 5 min,
 * capped at one day); the result SAYS so (`warning` + `stretchedFrom`). The
 * stretch is a RECURRENCE change only: the first firing keeps the requested
 * delay and the ae20da66 same-cadence collapse is skipped for a stretched arm
 * (createSchedule; the two SCHEDULE_DURATION_FIT_*_STRETCHED envs below
 * restore each). Owner
 * arms are advised, never overridden (the same scoping as the cap guard and
 * the dormancy gate). Complements — does not duplicate — the fire-time
 * busy-skip handling: this prevents the mis-fit at the source. Fail-open
 * everywhere: fewer than DURATION_FIT_MIN_SAMPLES finished runs, or any read
 * error, leaves the requested cadence untouched.
 */
export const DURATION_FIT_SAMPLE_RUNS = 10;
export const DURATION_FIT_MIN_SAMPLES = 3;
/** Default cadence-floor multiplier: 1 × p50 (fixer pass 2026-09-27; the branch
 *  shipped 2×). Env SCHEDULE_DURATION_FIT_MULTIPLIER overrides (finite, > 0,
 *  clamped at DURATION_FIT_MULTIPLIER_MAX); `SCHEDULE_DURATION_FIT_MULTIPLIER=2`
 *  restores the branch's spacing. */
export const DURATION_FIT_MULTIPLIER = 1;
export const DURATION_FIT_MULTIPLIER_MAX = 10;
export const DURATION_FIT_ROUND_SEC = 5 * 60;
export const DURATION_FIT_MAX_INTERVAL_SEC = SECONDS_PER_DAY;

/** The live multiplier: env SCHEDULE_DURATION_FIT_MULTIPLIER when it parses to a
 *  finite number > 0 (clamped at DURATION_FIT_MULTIPLIER_MAX), else the
 *  DURATION_FIT_MULTIPLIER default. Junk never changes behaviour. */
export function durationFitMultiplier(): number {
  const raw = String(process.env.SCHEDULE_DURATION_FIT_MULTIPLIER ?? '').trim();
  if (!raw) return DURATION_FIT_MULTIPLIER;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DURATION_FIT_MULTIPLIER;
  return Math.min(DURATION_FIT_MULTIPLIER_MAX, n);
}

function envFlag(name: string): boolean {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** SCHEDULE_DURATION_FIT_FIRST_FIRING_STRETCHED=1: a stretched arm's FIRST
 *  firing waits the full stretched interval (the branch's original shape).
 *  Default OFF — the first firing keeps the requested delay. */
export function durationFitFirstFiringStretched(): boolean {
  return envFlag('SCHEDULE_DURATION_FIT_FIRST_FIRING_STRETCHED');
}

/** SCHEDULE_DURATION_FIT_COLLAPSE_STRETCHED=1: a stretched arm still runs the
 *  ae20da66 same-cadence collapse at the STRETCHED interval (the branch's
 *  original shape, which cancels a different sub-floor job). Default OFF. */
export function durationFitCollapseStretched(): boolean {
  return envFlag('SCHEDULE_DURATION_FIT_COLLAPSE_STRETCHED');
}

/** Median of the positive durations (ms); null when none. Pure. */
export function p50Ms(durationsMs: number[]): number | null {
  const xs = durationsMs.filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
}

/** The cadence floor a run length implies: multiplier × p50 (the live
 *  durationFitMultiplier() unless given), rounded UP to a DURATION_FIT_ROUND_SEC
 *  boundary, never below MIN_INTERVAL_SEC, capped at
 *  DURATION_FIT_MAX_INTERVAL_SEC (one day). Pure. */
export function durationFitFloorSec(p50RunMs: number, multiplier: number = durationFitMultiplier()): number {
  const raw = (multiplier * p50RunMs) / 1000;
  const rounded = Math.ceil(raw / DURATION_FIT_ROUND_SEC) * DURATION_FIT_ROUND_SEC;
  return Math.min(DURATION_FIT_MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, rounded));
}

/** Pure fit: the interval a row should carry given the lane's p50 run length. */
export function fitIntervalToRunLength(intervalSec: number, p50RunMs: number, multiplier: number = durationFitMultiplier()): { intervalSec: number; floorSec: number; stretched: boolean } {
  const floorSec = durationFitFloorSec(p50RunMs, multiplier);
  return intervalSec < floorSec
    ? { intervalSec: floorSec, floorSec, stretched: true }
    : { intervalSec, floorSec, stretched: false };
}

/** Wall-clock lengths (ms) of this lane's last `take` FINISHED runs (both
 *  startedAt and finishedAt set), newest first. Throws on a read error — the
 *  guard catches. */
export async function recentRunDurationsMs(sessionId: string, take = DURATION_FIT_SAMPLE_RUNS): Promise<number[]> {
  const rows = await prisma.agentRun.findMany({
    where: { sessionId, startedAt: { not: null }, finishedAt: { not: null } },
    orderBy: { startedAt: 'desc' },
    take,
    select: { startedAt: true, finishedAt: true },
  });
  return (rows ?? [])
    .map((r: any) => (r?.finishedAt && r?.startedAt ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : 0))
    .filter((d: number) => Number.isFinite(d) && d > 0);
}

/** Verdict of the arm-time duration fit (finding B3). */
export interface DurationFitVerdict {
  /** The cadence the caller asked for. */
  requestedSec: number;
  /** The cadence the row should carry (== requestedSec unless stretched). */
  intervalSec: number;
  /** multiplier × p50, rounded/capped. */
  floorSec: number;
  p50RunMs: number;
  samples: number;
  /** The multiplier the floor was computed with (durationFitMultiplier()). */
  multiplier: number;
  /** True only for a MACHINE actor whose cadence was raised to floorSec. */
  stretched: boolean;
  /** Prose for the tool response (rides the existing `warning` field). */
  warn: string;
}

/**
 * Compare a recurring cadence with the lane's measured run length. null =
 * nothing to say (too few finished runs, the cadence already fits, or a read
 * error — all fail-open). A MACHINE actor's short cadence comes
 * back `stretched` with the interval to store; an owner's is advised only.
 */
export async function durationFitGuard(
  sessionId: string,
  intervalSec: number,
  machineActor: boolean,
  scheduleId?: string,
): Promise<DurationFitVerdict | null> {
  try {
    const durations = await recentRunDurationsMs(sessionId);
    if (durations.length < DURATION_FIT_MIN_SAMPLES) return null;
    const p50 = p50Ms(durations);
    if (p50 == null) return null;
    const multiplier = durationFitMultiplier();
    const fit = fitIntervalToRunLength(intervalSec, p50, multiplier);
    if (!fit.stretched) return null;
    const floorPhrase = multiplier === 1 ? 'the p50 run length' : `${multiplier}× the p50 run length`;
    const reqMin = Math.round(intervalSec / 60);
    const p50Min = Math.round(p50 / 60000);
    const floorMin = Math.round(fit.floorSec / 60);
    const facts =
      `this lane's last ${durations.length} runs take ~${p50Min} min each (p50) — every ${reqMin} min is shorter than the run itself, ` +
      `so most firings would find the lane BUSY, re-arm +${BUSY_REARM_MIN} min and produce nothing (a cadence shorter than the run fires ~0× and only counts busy-skips).`;
    const base = { requestedSec: intervalSec, floorSec: fit.floorSec, p50RunMs: p50, samples: durations.length, multiplier };
    if (machineActor) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.SCHEDULE_DURATION_FIT,
        sessionId,
        meta: { outcome: 'stretched', requestedSec: intervalSec, intervalSec: fit.intervalSec, floorSec: fit.floorSec, p50RunMs: p50, samples: durations.length, multiplier, ...(scheduleId ? { scheduleId } : {}) },
      });
      return {
        ...base,
        intervalSec: fit.intervalSec,
        stretched: true,
        warn:
          `⏱ CADENCE STRETCHED: ${facts} Armed at every ${floorMin} min instead (≥ ${floorPhrase}` +
          `${fit.floorSec >= DURATION_FIT_MAX_INTERVAL_SEC ? ', the one-day ceiling' : ''}). ` +
          `For a tighter loop make each run FINISH sooner (smaller steps; checkpoint and schedule_self the rest) — the cadence follows the run, not the other way round.`,
      };
    }
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SCHEDULE_DURATION_FIT,
      sessionId,
      meta: { outcome: 'warned', requestedSec: intervalSec, intervalSec, floorSec: fit.floorSec, p50RunMs: p50, samples: durations.length, multiplier, ...(scheduleId ? { scheduleId } : {}) },
    });
    return {
      ...base,
      intervalSec,
      stretched: false,
      warn: `⚠️ CADENCE vs RUN LENGTH: ${facts} Your cadence is kept as requested (owner-authored cadences are never overridden); ≥${floorMin} min would fit the run.`,
    };
  } catch (err: any) {
    logger.warn(`coding schedule: duration fit skipped for session ${sessionId.slice(0, 8)} (fail-open): ${err?.message ?? err}`);
    return null;
  }
}

/** Live daily-cap counter state for one chat (the FIRES_KEY counter + its 24h window). */
export interface CapState {
  /** Firings used in the current window; null when unreadable (Redis hiccup). */
  dailyFiresUsed: number | null;
  /** The chat's daily firing cap (ChatAutonomy.scheduleCap ?? 48). */
  dailyCapLimit: number;
  /** When the window resets (ISO); null when no live window exists (never fired / key lost its TTL / hiccup). */
  capWindowResetsAt: string | null;
}

/**
 * Cap-state VISIBILITY — the fires counter was previously write-only, so a chat
 * just silently stopped firing at the cap (lastStatus skipped:daily_cap). Read
 * it for ONE chat: GET + PTTL the fires key. Missing key → 0 used, no reset; a
 * key without its TTL (PTTL -2/-1) → counter visible but no reset time; PTTL>0
 * → the window resets at now+pttl. A Redis hiccup yields nulls — visibility
 * must never throw into a list path.
 */
export async function capStateForSession(sessionId: string): Promise<CapState> {
  const dailyCapLimit = await capForSession(sessionId);
  try {
    const [raw, pttl] = await Promise.all([redisClient.get(FIRES_KEY(sessionId)), redisClient.pTTL(FIRES_KEY(sessionId))]);
    return {
      dailyFiresUsed: raw != null ? Number(raw) : 0,
      dailyCapLimit,
      capWindowResetsAt: typeof pttl === 'number' && pttl > 0 ? new Date(Date.now() + pttl).toISOString() : null,
    };
  } catch {
    return { dailyFiresUsed: null, dailyCapLimit, capWindowResetsAt: null }; // Redis hiccup → nulls, never throw
  }
}

/**
 * Stamp cap state onto schedule views. The counter is PER-CHAT (pooled across
 * every schedule of one session), so views are grouped by session: ONE Redis
 * round-trip per DISTINCT session (Promise.all), and the same values land on
 * every row of that chat. toView stays sync — enrichment happens after mapping.
 */
async function enrichWithCapState<T extends ScheduleView>(views: T[], sessionIdOf: (v: T) => string): Promise<T[]> {
  if (!views.length) return views;
  const distinct = [...new Set(views.map(sessionIdOf))];
  const bySession = new Map(await Promise.all(distinct.map(async (sid) => [sid, await capStateForSession(sid)] as const)));
  return views.map((v) => ({ ...v, ...bySession.get(sessionIdOf(v))! }));
}

/**
 * Aggregate runaway backstop: cap TOTAL machine firings per session per rolling
 * 24h, independent of how many schedule rows exist or how often the orchestrator
 * renews them (per-row maxRuns/expiry can be trivially re-created; this cannot).
 * Redis INCR with a 24h TTL. Returns the cap so the caller can report it, or
 * null when firing is still under the cap. The cap is per-chat — see capForSession.
 * Exported: hook-wake deliveries (hooks.service deliverHookGroup) consume the
 * SAME budget as schedule firings — every machine wake counts against one cap.
 */
/**
 * Ensure an INCR'd counter key carries its TTL (P3 pin, item 14b): the TTL was
 * set only on the FIRST INCR — a key that lost its TTL (Redis restart
 * persistence quirk, INCR racing the expiry) became an IMMORTAL counter that
 * capped the chat forever instead of for 24h. Now every INCR re-checks:
 * first increment sets it; later increments set it only when PTTL reports
 * none (-1). Best-effort — a Redis hiccup never wedges the fire path.
 */
async function ensureCounterTtl(key: string, ttlSec: number, isFirst: boolean): Promise<void> {
  try {
    if (isFirst) { await redisClient.expire(key, ttlSec); return; }
    const pttl = await redisClient.pTTL(key);
    if (typeof pttl === 'number' && pttl < 0) await redisClient.expire(key, ttlSec);
  } catch { /* best-effort */ }
}

/**
 * ~80%-of-budget EARLY WARNING (feedback 190d68aa): the daily firing cap used to
 * be invisible until skips BEGAN — a watch lane exhausting its 48/day budget at
 * ~08:38Z went deaf ~24h (self-recovery only at window roll) while the work it
 * monitored kept running; schedule_cap_skipped was the ONLY signal and it fired
 * per-skip ~48 min AFTER deafness began. Warn ONCE per chat per window when the
 * live counter crosses ceil(0.8·cap), reusing the schedule_cap_skipped event
 * type with kind:'warn' so existing supervisor wildcard hooks receive it with
 * NO re-wiring — the supervisor can then re-space the lane's interval schedules
 * BEFORE the cap trips. Dedupe rides claimCapWindowGate's 'warn' flavor
 * (PTTL-aligned to the same FIRES_KEY window it warns about, so each fresh
 * window warns once). Best-effort: a lost warn must never wedge the fire path,
 * and the warn check runs only on the non-capped branch (an over-cap INCR keeps
 * the skip-path signaling).
 */
const DAILY_CAP_WARN_FRACTION = 0.8;
export function dailyCapWarnThreshold(cap: number): number {
  return Math.max(1, Math.ceil(cap * DAILY_CAP_WARN_FRACTION));
}

async function maybeWarnDailyCapBudget(chatId: string, used: number, cap: number): Promise<void> {
  try {
    if (used < dailyCapWarnThreshold(cap)) return;
    if (!(await claimCapWindowGate(chatId, 'warn'))) return; // already warned this window
    await emitHookEventSafe(
      chatId,
      'schedule_cap_skipped',
      `Daily firing budget warning: ${used}/${cap} firings used in the current 24h window (≥80%) — re-space this chat's interval schedules NOW (fewer, longer-interval firings, or raise the cap with set_chat_autonomy) or it goes deaf when the ${cap}/day cap trips`,
      { kind: 'warn', used, cap, threshold: dailyCapWarnThreshold(cap) },
    );
  } catch { /* a warn must never break scheduling */ }
}

export async function dailyCapExceeded(sessionId: string): Promise<number | null> {
  const cap = await capForSession(sessionId);
  const key = FIRES_KEY(sessionId);
  try {
    const n = await redisClient.incr(key);
    await ensureCounterTtl(key, 24 * 60 * 60, n === 1);
    if (n > cap) {
      await redisClient.decr(key).catch(() => {}); // don't let a blocked day inflate forever
      return cap;
    }
    await maybeWarnDailyCapBudget(sessionId, n, cap);
    // Sub-session budget attribution (2026-09-02, sub-session promotion): a
    // CHILD chat's machine firing consumes its PARENT's daily budget too — a
    // parent must not evade its own cap by fanning work out to spawned
    // children. Same INCR-first reservation on the parent's counter; over the
    // parent's cap ⇒ refund BOTH tokens and report the parent's cap (the
    // child firing is skipped). First-degree only; the parent link is a LIVE
    // read (parentChatIdOf, fail-null) so a detached child bills only itself.
    const parentId = await parentChatIdOf(sessionId);
    if (parentId) {
      const parentCap = await capForSession(parentId);
      const parentKey = FIRES_KEY(parentId);
      const pn = await redisClient.incr(parentKey);
      await ensureCounterTtl(parentKey, 24 * 60 * 60, pn === 1);
      if (pn > parentCap) {
        await redisClient.decr(parentKey).catch(() => {});
        await redisClient.decr(key).catch(() => {});
        return parentCap;
      }
      await maybeWarnDailyCapBudget(parentId, pn, parentCap); // the parent's budget is what a fleet lane actually burns
    }
    return null;
  } catch {
    return null; // Redis hiccup must not wedge scheduling
  }
}

/**
 * Sub-session lineage read for the budget attribution above/below: the parent
 * chat a CHILD session bills its machine firings to. LIVE read per call (no
 * caching — a re-parent/delete changes billing immediately); any failure
 * degrades to null (no attribution), never a throw into the fire path.
 */
async function parentChatIdOf(sessionId: string): Promise<string | null> {
  try {
    const row = await prisma.crossModelChat.findUnique({
      where: { id: sessionId },
      select: { parentChatId: true },
    });
    return row?.parentChatId ?? null;
  } catch {
    return null;
  }
}

/**
 * Surface an auto-DISABLED schedule to the chat's OWNER (feedback dd0d37ac): a
 * schedule that lapses (lifetime expiry / run cap) used to just flip
 * enabled:false + lastStatus — the chat went quiet with no in-band signal, and
 * the row later scrolled out of the list_schedules history window, so a
 * long-lived monitor "silently vanished" overnight. Post ONE assistant message
 * per schedule row (Redis NX) saying WHAT ended, that it will not resume on
 * its own, and how to re-arm. One-shot completions are the expected end and
 * stay quiet (the caller only invokes this for lapses + recurring run-caps).
 */
const TERMINAL_NOTICE_TTL_SEC = 30 * 24 * 60 * 60; // outlives the terminal row's GC window
export async function notifyScheduleTerminalOnce(s: { id: string; sessionId: string }, why: string): Promise<void> {
  const key = `coding:sched:terminalnotice:${s.id}`;
  const claimed = await redisClient.set(key, '1', { NX: true, EX: TERMINAL_NOTICE_TTL_SEC }).catch(() => null);
  if (claimed !== 'OK') return; // already told the owner (or Redis hiccup — stay quiet rather than spam)
  await prisma.crossModelMessage.create({
    data: {
      chatId: s.sessionId,
      role: 'assistant',
      content: `🛑 **Schedule ${s.id} stopped** — it ${why} and was disabled automatically; it will NOT fire or resume again (schedule ids and run history are not reusable). If this loop should continue, arm a fresh one with schedule_message / schedule_self.`,
    },
  }).catch(async (err: any) => {
    // Claim-then-fail must not lose the one-shot notice forever: reopen the NX
    // gate so the next sweep tick retries (the row's terminal state persists).
    await redisClient.del(key).catch(() => {});
    logger.warn(`coding schedule: terminal notice failed for ${s.id}: ${err?.message}`);
  });
  // Bump the chat so the notice actually surfaces — an expiry notice lands in
  // a chat idle ~30 days, buried pages deep in the updatedAt-sorted sidebar
  // (mirrors notifyDailyCapOnce's deliberate bump).
  await prisma.crossModelChat.update({ where: { id: s.sessionId }, data: { updatedAt: new Date() } }).catch(() => {});
}

/**
 * Owner-visible notice for a goal-gate AUTO-PARK (ticket b1d435fd) — the
 * one-line reason the ticket demands, delivered to the affected chat. NX-gated
 * one-per-row like notifyScheduleTerminalOnce, but phrased for a POLICY park,
 * not a terminal stop: the row CAN be resumed (Schedules tab) once the project
 * has live work again, so it must not read as "will NOT fire or resume again".
 * A chat message costs zero model tokens — the directive bans wasted WAKES,
 * not the visibility of the park itself.
 */
export async function notifyDormancyParkOnce(s: { id: string; sessionId: string }, reason: string): Promise<void> {
  const key = `coding:sched:parknotice:${s.id}`;
  const claimed = await redisClient.set(key, '1', { NX: true, EX: TERMINAL_NOTICE_TTL_SEC }).catch(() => null);
  if (claimed !== 'OK') return; // already noticed (or Redis hiccup — stay quiet rather than spam)
  await prisma.crossModelMessage.create({
    data: {
      chatId: s.sessionId,
      role: 'assistant',
      content: `⏸️ **Schedule ${s.id} auto-parked** — ${reason}. It will NOT fire while the project stays dormant (zero-wake owner directive for goal-less projects). When the project has live work again (a goal, an open todo, a live run), resume it from the Schedules tab or arm a fresh one with schedule_message / schedule_self.`,
    },
  }).catch(async (err: any) => {
    await redisClient.del(key).catch(() => {});
    logger.warn(`coding schedule: dormancy-park notice failed for ${s.id}: ${err?.message}`);
  });
  await prisma.crossModelChat.update({ where: { id: s.sessionId }, data: { updatedAt: new Date() } }).catch(() => {});
}

/**
 * Refund one speculative daily-cap token when a claimed firing did NOT start a
 * run (busy / not-runnable / error). dailyCapExceeded reserves via INCR-first
 * (atomic across blue/green claimants); without the refund, busy-skip retries
 * re-arming every ~3 min drained the chat's daily cap (feedback 94bb9c2f:
 * 85/144 consumed with only 4 real runs). Best-effort, mirrors the over-cap
 * DECR above — the 24h TTL bounds any residual leak. Exported for the same
 * reason dailyCapExceeded is: hook wakes reserve/refund the shared budget.
 */
export async function refundDailyCapToken(sessionId: string): Promise<void> {
  try { await redisClient.decr(FIRES_KEY(sessionId)); } catch { /* best-effort */ }
  // Sub-session attribution refund: dailyCapExceeded reserved a PARENT token
  // alongside a child's — it must not leak when no run started. Same
  // best-effort posture; the 24h TTL bounds any residual drift.
  try {
    const parentId = await parentChatIdOf(sessionId);
    if (parentId) await redisClient.decr(FIRES_KEY(parentId));
  } catch { /* best-effort */ }
}

/**
 * Surface a daily-cap skip to the chat's OWNER (feedback 619ba9f9/34c1c60b):
 * the hook event reaches a subscribed supervisor, but the target chat itself
 * showed nothing — monitors looked active in list_schedules yet never fired,
 * with the only signal being `lastStatus: skipped:daily_cap` (invisible unless
 * polled). Post ONE assistant message per 24h cap window (Redis NX) explaining
 * what happened and how to fix the cadence.
 */
export async function notifyDailyCapOnce(sessionId: string, cap: number): Promise<void> {
  const key = `coding:sched:capnotice:${sessionId}`;
  const claimed = await redisClient.set(key, '1', { NX: true, EX: 24 * 60 * 60 }).catch(() => null);
  if (claimed !== 'OK') return; // already notified this window (or Redis hiccup — stay quiet)
  await prisma.crossModelMessage.create({
    data: {
      chatId: sessionId,
      role: 'assistant',
      content: `⏸️ **Scheduled runs paused for ~24h** — this chat hit the ${cap}-firings/day scheduled-run cap (runaway protection), so recurring schedules are being skipped. They stay active and resume automatically when the rolling 24h window resets (within a day of the first capped firing — no action needed). IMPORTANT: this pause never cancels a schedule — if list_schedules shows one [stopped] with last=cancelled/expired, that happened separately and it will NOT resume on its own: recreate it (or re-engage the chat to). To stay under the cap, consolidate to fewer, longer-interval schedules (e.g. one hourly check instead of several 30-minute ones) — or raise the chat's cap with set_chat_autonomy.`,
    },
  }).catch((err) => logger.warn(`coding schedule: cap notice persist failed: ${err?.message}`));
  await prisma.crossModelChat.update({ where: { id: sessionId }, data: { updatedAt: new Date() } }).catch(() => {});
}

/**
 * Per-window dedupe gate for schedule_cap_skipped hook events (feedback
 * a30b6ad9): a chat parked at its daily firing cap used to emit a FRESH
 * schedule_cap_skipped event on EVERY skipped firing — two 30-min schedules
 * meant ~6+ identical wakes of the Fleet Supervisor per window, zero new
 * information each. Claim once per chat per window (Redis NX), mirroring
 * notifyDailyCapOnce: the first skip in a window emits; later identical skips
 * stay supervisor-silent (the per-skip recordCapSkip count + the one owner
 * notice still carry the full picture in-lane). The gate's TTL aligns to the
 * FIRES_KEY window it describes (PTTL), so the NEXT window's first skip emits
 * again; the 24h flat fallback covers a spend-cap skip where no FIRES_KEY
 * exists yet (the spend check runs BEFORE the daily-cap INCR). Flavors
 * ('daily' | 'spend') gate independently so one flavor never suppresses the
 * other. Fail-OPEN: a Redis hiccup must never silence a cap signal — a rare
 * duplicate wake beats a lost one.
 */
const CAP_EVENT_GATE_FALLBACK_TTL_SEC = 24 * 60 * 60;
const capEventGateKey = (sessionId: string, flavor: string) => `coding:sched:capevent:${sessionId}:${flavor}`;

export async function claimCapWindowGate(sessionId: string, flavor: 'daily' | 'spend' | 'warn', ttlSec?: number): Promise<boolean> {
  try {
    let ttl = ttlSec;
    if (ttl == null) {
      const pttl = await redisClient.pTTL(FIRES_KEY(sessionId));
      ttl = typeof pttl === 'number' && pttl > 0 ? Math.max(1, Math.ceil(pttl / 1000)) : CAP_EVENT_GATE_FALLBACK_TTL_SEC;
    }
    const claimed = await redisClient.set(capEventGateKey(sessionId, flavor), '1', { NX: true, EX: Math.max(1, Math.floor(ttl)) });
    return claimed === 'OK';
  } catch {
    return true; // fail-open — see the header comment
  }
}

/**
 * Fleet supervisor (§3) — hook-event emission seam. hooks.service.ts (slice B)
 * implements emitHookEvent(sourceChatId, eventType, summary, extra?); loaded
 * via dynamic import + try/catch: emission must never break the sweeper (and
 * the module's static chain — crossmodel.service → platform.service → THIS
 * module — would cycle on a static import).
 */
async function emitHookEventSafe(sourceChatId: string, eventType: string, summary: string, extra?: Record<string, any>): Promise<void> {
  try {
    const mod: any = await import('../platform/hooks.service').catch(() => null);
    await mod?.emitHookEvent?.(sourceChatId, eventType, summary, extra);
  } catch (err: any) {
    logger.warn(`hook event emission failed (${eventType}): ${err?.message}`);
  }
}

/**
 * Terminal-stop contract (feedback 065caccb): machine lanes kept re-auditing
 * CLOSED ticket batches on later machine firings because the (days-old,
 * machine-authored) prompt still named the ticket and nothing in the wake said
 * the work was terminal (2026-09-15: two full re-audits of the done 6fac1460
 * batch on lane b92ef13f — one inside a DMG-watch firing whose brief even said
 * "stop quietly"; 4 echo continuations on done 7503189b on lane e8b27fcd).
 * Scan the fully-decorated prompt for ticket refs, resolve each against the
 * LIVE store, and append a [TERMINAL-STOP] block for every one already
 * status=done — a verified completion is terminal and the fired run must not
 * re-verify it. ADVISORY ONLY: never a skip (a watch's own OPEN criteria must
 * still run — the 20:18Z DMG-watch firing is the shape to preserve), and
 * fail-open (a lookup hiccup never drops a firing). Shared by BOTH machine-wake
 * seams — fireScheduleTarget (schedule firings + hook wakes) and
 * queueContinuationRun (the continuation fast lane, which bypasses
 * fireScheduleTarget — the e8b27fcd echo-continuation lane). The fb8b609f
 * staleness guards are the direct precedent; this generalizes them from plan
 * boards to ticket refs. Dynamic import of the resolver: feedback.service →
 * platform graph — a static edge from here would cycle.
 */
export async function appendTerminalStopNotice(prompt: string, label: string): Promise<string> {
  try {
    const refs = extractTicketRefs(prompt);
    if (!refs.length) return prompt;
    const { getFeedbackTicketById } = await import('../feedback/feedback.service');
    const closedRefs: ClosedTicketRef[] = [];
    const seenTicketIds = new Set<string>();
    for (const ref of refs) {
      const res = await getFeedbackTicketById(ref).catch(() => null);
      if (res && res.ok && res.ticket?.status === 'done' && !seenTicketIds.has(res.ticket.id)) {
        seenTicketIds.add(res.ticket.id);
        closedRefs.push({
          id: res.ticket.id,
          title: res.ticket.title ?? null,
          updatedAt: res.ticket.updatedAt ?? null,
          adminNote: res.ticket.adminNote ?? null,
        });
      }
    }
    return closedRefs.length ? `${prompt}\n\n${buildTerminalStopNotice(closedRefs, new Date())}` : prompt;
  } catch (err: any) {
    logger.warn(`coding schedule: [TERMINAL-STOP] scan failed for ${label} (firing proceeds without it): ${err?.message ?? err}`);
    return prompt;
  }
}

/**
 * Fire ONE claimed schedule row against its target chat (P1 generalization —
 * schedules now target ANY chat, not just coding sessions):
 *   - a chat WITH a workspace satellite → the existing coding run path
 *     (startScheduledRun). P5-B: the satellite is the marker (mode='code' is
 *     gone); legacy coding chats all carry one, so behavior is preserved.
 *   - any other chat  → a DETACHED chat-agent turn (startDetachedChatRun) for
 *     the queued prompt, no SSE client attached; the answer persists in the chat.
 * The run executes as the CHAT OWNER (resolved from the chat row) — the same
 * identity resolution startScheduledRun uses for coding runs.
 * Returns { started, queued? } or { started: false, reason } ('busy' | 'not_found' | ...).
 * queued:true = the firing did not start inline but is DURABLY queued behind the
 * busy lane (3405e332, kind:'once' only) — the sweeper consumes the row exactly
 * like a started firing.
 *
 * s.origin: fleet origin stamp for the wake. Defaults to 'schedule' (the
 * sweeper's own firings); hooks.service passes 'hook' for event-hook wake
 * deliveries — audit p10: hook wakes used to be mis-stamped 'schedule',
 * pointing overnight-run investigations at a subsystem that never fired.
 */
/*
 * Busy-session firing STEER (owner 2026-09-24: "it makes no sense how … it
 * takes too long waiting … why can't more sessions be launched in parallel"):
 * 462 schedule firings and 40 hook wakes in 48 h queued BEHIND the same
 * session's own running run (53 waited > 10 min, worst 307 min) while agent
 * messages — delivered as steers — never waited. A firing/wake that lands on a
 * coding session with an active (running or queued) run is now delivered INTO
 * that run as a steer, exactly like send_chat_message does: the run sees it at
 * its next step boundary and acts on it, no follow-up run is queued, and the
 * schedule/hook accounting treats it as a real firing.
 * EXCEPTIONS (both deterministic, both 2026-10-09):
 *   - audit 2026-10-06 T4-7: a ONE-SHOT armed while the run was already active
 *     is that run's own follow-up → queued behind it, never steered.
 *   - ticket 2c7cee17: a kind-'once' firing whose stored prompt is a ZERO-TOOL
 *     DELIVERY body (no-tools directive + verbatim/fence marker —
 *     isZeroToolDeliveryPrompt) exists to post ONE standalone transcript row;
 *     a steer is structurally incompatible with that purpose → queued behind
 *     the busy run, never steered.
 */

/** audit 2026-10-06 T4-7: BUSY_STEER_OWN_ONESHOT_QUEUE_DISABLED=1 steers a run's own follow-up one-shot into it again. Read per call. */
export function busySteerOwnOneShotQueueDisabled(): boolean { return process.env.BUSY_STEER_OWN_ONESHOT_QUEUE_DISABLED === '1'; }

/**
 * audit 2026-10-06 T4-7 (others.md F14): TRUE when this one-shot was armed
 * after the session's ACTIVE (running|queued) run started — i.e. it is that
 * run's own follow-up, so a busy-steer would fold it into the very run it is
 * meant to follow. Records ONE loop_metrics row when it decides to queue.
 * Never throws; any lookup error (or a missing createdAt) ⇒ false (steer as before).
 */
export async function oneShotArmedDuringActiveRun(sessionId: string, scheduleId: string, createdAt: Date | null): Promise<boolean> {
  try {
    if (busySteerOwnOneShotQueueDisabled() || !createdAt) return false;
    const armedMs = new Date(createdAt).getTime();
    if (!Number.isFinite(armedMs)) return false;
    const active = await prisma.agentRun.findFirst({
      where: { sessionId, status: { in: ['running', 'queued'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, startedAt: true },
    });
    if (!active) return false;
    const runStart = (active as any).startedAt ?? (active as any).createdAt;
    const runStartMs = runStart ? new Date(runStart).getTime() : NaN;
    if (!Number.isFinite(runStartMs) || armedMs < runStartMs) return false;
    recordLoopMetric({ kind: 'busy_steer_own_oneshot_queued', sessionId, meta: { scheduleId, runId: (active as any).id, armedAfterRunStartMin: Math.round((armedMs - runStartMs) / 60_000) } });
    logger.info(`coding schedule: one-shot ${scheduleId} was armed during the active run ${String((active as any).id).slice(0, 8)} of ${sessionId.slice(0, 8)} — queued behind it, not steered into it (audit 2026-10-06 T4-7)`);
    return true;
  } catch {
    return false;
  }
}
/** ticket 2c7cee17: BUSY_STEER_DELIVERY_RUNG_QUEUE_DISABLED=1 steers a zero-tool
 *  delivery rung into the active run again (reverts this fix). Read per call. */
export function busySteerDeliveryRungQueueDisabled(): boolean { return process.env.BUSY_STEER_DELIVERY_RUNG_QUEUE_DISABLED === '1'; }

// ticket 2c7cee17 — the TWO halves a zero-tool delivery firing must carry to
// skip the busy-steer. Grounded in the incident's stored prompt (msg 701b5fd6,
// schedule 23323ecd): the body opened "ONE-SHOT CLEAN RE-DELIVERY — reply with
// the digest text below VERBATIM as your final answer … Do NOT call any
// tools" and fenced the payload "=== BEGIN DIGEST === … === END DIGEST ===".
// The halves are (1) a no-tools directive AND (2) an EXPLICIT-delivery marker:
// the literal word "verbatim" OR a delimited BEGIN…END fence pair (either
// suffices — review 2c7cee17 F1: requiring BOTH markers made the fence dead
// code and left a fenced body without the word "verbatim" steered, the bug
// persisting for that shape). A no-tools directive ALONE stays a non-match: it
// appears in ordinary short-task prompts ("do not call any tools, answer from
// memory"), and those must keep the busy-steer. Case-insensitive throughout
// ("Do not call ANY tools", "--- begin digest ---" still match); the fence
// needs BOTH a BEGIN and an END marker so a working prompt that merely quotes
// a lone "=== BEGIN DIGEST ===" does not match.
const NO_TOOLS_DIRECTIVE_RE = /\bdo\s+not\s+call\s+any\s+tools\b/i;
const VERBATIM_DIRECTIVE_RE = /\bverbatim\b/i;
const DELIVERY_FENCE_RE = /(?:===|---|```+)\s*begin\b[\s\S]*?(?:===|---|```+)\s*end\b/i;

/**
 * ticket 2c7cee17: TRUE when a firing's prompt is a ZERO-TOOL VERBATIM
 * DELIVERY body — "reply with the text below VERBATIM, Do NOT call any
 * tools, BEGIN/END fenced payload". Such a firing exists to post ONE clean
 * standalone transcript row (the 4565991a digest re-delivery mitigation):
 * absorbing it as a busy-steer into an active run is structurally
 * incompatible with its purpose — all assistant turns of one run accumulate
 * into ONE final row, so the steered run's row is its own report, never the
 * delivered digest. Pure + total: never throws, never reads the DB, and a
 * non-matching prompt returns false (the busy-steer keeps its 2026-09-24
 * semantics for everything else).
 */
export function isZeroToolDeliveryPrompt(prompt: string | null | undefined): boolean {
  try {
    if (busySteerDeliveryRungQueueDisabled() || !prompt) return false;
    const text = String(prompt);
    if (text.length > 200_000) return false; // a delivery body is a bounded artifact, never a mega-prompt
    return NO_TOOLS_DIRECTIVE_RE.test(text) && (VERBATIM_DIRECTIVE_RE.test(text) || DELIVERY_FENCE_RE.test(text));
  } catch {
    return false;
  }
}

export function busyFiringSteerHeader(origin: 'schedule' | 'hook', id: string): string {
  const what = origin === 'hook' ? 'FLEET EVENT WAKE' : 'SCHEDULED FIRING';
  return `[MACHINE-TRIGGERED ${what} (${id.slice(0, 13)}) — NOT typed by the user — arrived WHILE this run was active and was delivered INTO the run as a steer instead of a queued follow-up run (busy-session steer, 2026-09-24). Treat what follows as new input for THIS run: fold it into your current work at the next natural point, do not start over, and do not wait for a separate run.]`;
}

// ── delta_material state: last-run outcome field (E5, 2026-09-25) ────────────
// The eval doc prescribed a "last run one-line outcome" in the delta_material
// state; the 2026-09-24 site passed only {schedule_prompt, watched_change}. The
// line is HARNESS-derived from the previous delta-gated firing's labelled
// outcome row (decision-outcome-labels.ts: note class + mutating / evidence
// tool counts) — never lane prose — plus the schedule row's own last status.

// ── zero-unfinished continuation skip (agent-decisions prerequisite 5): the
//    fire-time re-read guards EVERY origin. RSW-1 cl30 (2026-11-02): the
//    schedule-only release switch expired 2026-11-12 and was deleted.

// ── ALL-COMPLETE BOARD firings (tt-rd audit 2026-09-27, finding self-audit-
// churn-5): the zero-unfinished skip above guards ONLY prompts that start with
// '[HARNESS CONTINUATION'; a RECURRING schedule firing whose plan board is
// already 100 % complete got the full loop, and lane-authored prompts
// ("EVERY firing ships ≥1 countable delta", "Derive ALL state fresh each
// firing" — 218a2e7f) turned that firing into an audit pass (ddd26be0: three
// consecutive 30-min "self-audit the prior run's claims" ticks while the box
// was dark; ≈ 9 audit-only firings / day × ≈ $2). The firing now carries an
// ADVISORY notice (never a skip) and writes ONE loop_metrics row
// (schedule_allcomplete_firing) so the residual is measurable.
// Fixer 2026-09-27 (finding 2): a board with ANY blocked step is NOT
// all-complete — it is a WAIT lane (the PR-review / bounty-poll shape) whose
// firing is governed by VERDICT_WAIT_POSTURE ("ONE fresh read for the
// signal") and by the harness blocked-board audit ("re-confirm each BLOCKED
// step's blocker … one cheap check"). The first cut counted blocked steps as
// complete, so a wait lane got "do not re-probe" from this notice and
// "probe the external condition" from the audit in the same firing. The
// notice never applies to a blocked board now.

/** Pure: a non-empty plan whose EVERY step is completed. A board with any
 *  blocked step is a wait lane, never all-complete (fixer 2026-09-27, finding 2). */
export function planBoardAllComplete(plan: { steps?: Array<{ status?: string }> } | null | undefined): boolean {
  const steps = plan?.steps ?? [];
  return steps.length > 0 && steps.every((st) => st?.status === 'completed');
}

export const ALL_COMPLETE_BOARD_MARKER = '[ALL-COMPLETE BOARD';

/** The advisory appended to a recurring firing on an all-complete board. Pure. */
export function allCompleteBoardNotice(opts: { at: Date; unchanged: boolean; steps: number }): string {
  return `${ALL_COMPLETE_BOARD_MARKER} — harness-verified at fire time ${opts.at.toISOString()}] Your plan board (${opts.steps} step(s)) is 100% complete (no blocked step)${opts.unchanged ? ' and nothing on it changed since the last firing' : ''}. Either (a) pull the NEXT queued item (todo_list) and write a NEW plan for it, or (b) answer in ONE line and stop. Do not re-audit, re-probe or re-fold the completed board — the harness ran its one audit when the board was finished.`;
}

/** The previous delta-gated firing's labelled outcome for this lane (formatDeltaLastRunOutcome — pure leaf
 *  `delta-last-run-outcome.ts`); null on any failure. Never throws. */
export async function deltaMaterialLastRunOutcome(
  s: { sessionId: string; lastStatus?: string | null; lastFiredAt?: Date | null },
  now: Date,
): Promise<string | null> {
  try {
    const prev = await prisma.loopMetric.findFirst({
      where: {
        sessionId: s.sessionId,
        kind: LOOP_METRIC_KINDS.DECISION_GATE,
        AND: [
          { meta: { path: ['purpose'], equals: 'delta_material' } },
          { meta: { path: ['phase'], equals: 'outcome' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, meta: true },
    });
    return formatDeltaLastRunOutcome(prev ?? null, s, now);
  } catch (err: any) {
    logger.debug(`coding schedule: last-run outcome lookup failed for ${s.sessionId} (field omitted): ${err?.message ?? err}`);
    return null;
  }
}

/**
 * s.decision (WI-C, 2026-09-25): a shadow decision-gate stash (wake_triage from
 * hooks.service, delta_material from fireDue) that rides the STARTED run —
 * RunInput.decision on the coding path, ChatAgentRunArgs.decision on the plain
 * path — so the finalize can label its outcome. `decisionDeferred: true` in the
 * result means a run now carries it; every other result (busy, steer into an
 * active run, plain-chat queue-behind-busy) leaves it with the caller, who
 * closes the decision row unlabelled. Never changes what fires.
 *
 * s.childResult (ticket 56d6b204): set ONLY by hooks.service when the wake is
 * a child→parent RESULT hook delivery (isChildResultTemplate — the auto-wired
 * sub-session verdict path). Threads into BOTH delivery branches so the
 * persisted wake user row carries metadata.childResult:true, which the
 * frontend machine-turn grouping reads off the group's ANCHOR row to render
 * the whole machine turn EXPANDED — the owner's 2026-09-25 report (chat
 * 6e36c834): the sub-session's completed DB-audit work was folded behind a
 * collapsed machine accordion and never read. Guarded at the persist seam on
 * origin 'hook' (a stray flag on any other origin must never stamp), exactly
 * like the scheduleOwnerArmed guard.
 *
 * s.ownerAskMessageIds (fixer 2026-09-27, finding upward-chatter-1): set ONLY
 * by hooks.service when the delivered rows carry payload.kind
 * 'owner_ask_unanswered' (the [OWNER ASK UNANSWERED] re-wake / the
 * [FOLLOW-THROUGH] nudge). Threads into the PLAIN-chat branch only —
 * supervisor chats are plain chats — so the chat-agent finalize can close the
 * ask on the wake's real reply and stamp the reply row metadata.ownerAskReply.
 */
export async function fireScheduleTarget(s: {
  id: string; sessionId: string; prompt: string; origin?: 'schedule' | 'hook'; decision?: DecisionStash | null; childResult?: boolean;
  /** wake-cadence-2: the stretch this firing's claim just wrote (rendered on [SCHEDULE STATE]). */
  cadenceStretch?: CadenceStretch | null;
  /** todo 27c215d6: the block-streak backoff this firing's claim just wrote (rendered on [SCHEDULE STATE]). */
  blockStreakBackoff?: BlockStreakBackoff | null;
  /** One-shot chain link ≥3 in 24h (finding B1): governed as recurring — no queue-behind-busy, the busy re-arm + busySkips accounting applies. */
  onceChainRecurringLike?: boolean;
  ownerAskMessageIds?: string[];
  /**
   * ARCHIVED-TARGET-RETIRE (f, 2026-10-20): the dispatch surface the archived
   * refusal row names when it is not the origin itself — the owner-inbox
   * answer wake rides origin 'hook' but is its own surface ('owner_answer').
   */
  dispatchSurface?: 'owner_answer';
}): Promise<{
  started: boolean; reason?: string; queued?: boolean; steered?: boolean; decisionDeferred?: boolean;
  /** ALLCOMPLETE-CHARTER-TERMINATION: an idle skip's stretched next firing (the sweep writes it). */
  nextRunAt?: Date;
  /** ALLCOMPLETE-CHARTER-TERMINATION: why a 'charter_done' pause applies (the charter verdict). */
  detail?: string;
}> {
  const origin = s.origin ?? 'schedule';
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: s.sessionId },
    select: { userId: true, mode: true, archivedAt: true, isSupervisor: true, isProjectSupervisor: true, codingState: { select: { id: true } } },
  });
  if (!chat) return { started: false, reason: 'not_found' };
  // SUPERVISOR OFF SWITCH backstop (owner 2026-09-26): every machine wake —
  // the sweeper (already gated upstream), hook deliveries, todo wakes, the
  // owner-inbox answer wake — funnels through here; a switched-off supervisor
  // chat starts no run. Distinct reason: hooks terminal-mark the rows, the
  // sweeper stamps skipped:supervisor_off with no busy re-arm. A user turn
  // never comes through this path, so it is never refused. Fail-open.
  const supervisorOff = await supervisorWakeSkip(chat as any, `dispatch:${origin}`, s.sessionId);
  if (supervisorOff) {
    logger.info(`coding schedule: ${s.id} targets ${supervisorOff} supervisor chat ${s.sessionId.slice(0, 8)} while its switch is OFF — ${origin} wake skipped`);
    return { started: false, reason: SUPERVISOR_SWITCH_SKIP_REASON };
  }
  // ARCHIVED target (autonomy loop #13, 2026-09-20): an archive is a stop —
  // the owner's stand-down or the lane-scoped ending — so a schedule firing
  // or hook wake never revives it (lane b95e9df6, archived under the owner's
  // 09-17 order, was woken by a leftover peer hook and silently un-archived).
  // Distinct reason (not 'busy'): the sweep stamps skipped:archived with no
  // 3-min re-arm and no busy-skip; hooks retire the rows. Both surfaces
  // (plain + coding) funnel through here. A user turn restores, never this.
  if ((chat as any).archivedAt) {
    logger.info(`coding schedule: ${s.id} targets ARCHIVED chat ${s.sessionId.slice(0, 8)} — ${origin} wake refused (the archive is a stop; a user turn restores it)`);
    // ARCHIVED-TARGET-RETIRE (f, 2026-10-20): meta.surface names WHAT aimed at
    // the archived chat — schedule | hook | owner_answer — so the residual can
    // be attributed to its source (the sweeper retires schedule rows, the
    // owner inbox re-routes, hooks retire at delivery); the chat kind moves to
    // chatSurface. Kill switch ARCHIVED_TARGET_RETIRE_DISABLED=1 restores the
    // pre-fix {origin, surface: coding|plain} row.
    const chatSurface = chat.codingState ? 'coding' : 'plain';
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MACHINE_DISPATCH_ARCHIVED_REFUSED, sessionId: s.sessionId,
      meta: archivedTargetRetireDisabled()
        ? { origin, surface: chatSurface }
        : { origin, surface: s.dispatchSurface ?? origin, chatSurface, ...(origin === 'schedule' ? { scheduleId: s.id } : {}) },
    });
    return { started: false, reason: 'archived' };
  }

  // Stale-firing guard (fbe65673): the sweeper claims due rows with an atomic
  // conditional update, but a cancel/expire landing BETWEEN that claim and this
  // fire used to queue the run anyway — observed overriding an explicit owner
  // pause 3 min after the schedule was cancelled (2026-08-27). Re-read the row
  // at fire time: gone or disabled → the cancel wins. Hook wakes carry
  // synthetic `hook-*` ids (no schedule row exists) and are scoped out by the
  // origin check. A read ERROR never skips — uncertainty must not drop a real
  // firing (same doctrine as the continuation guard below).
  // promptSetBy (ticket 6ef770a1): the owner-armed signal — 'user' rows were
  // armed by a real owner turn (schedule_message / platform-tools.ts stamps
  // promptSetBy 'user' from ctx.userTurnAt), so their fired content is
  // DELIVERED CONTENT, not internal wake noise. Threading it (below) lets the
  // persisted wake user row carry metadata.scheduleOwnerArmed so the frontend
  // renders the turn EXPANDED. Legacy NULL and machine/system rows are NOT
  // owner-armed — only the explicit 'user' stamp counts.
  // ownerSubscribed (ticket 4565991a): the SUBSCRIPTION signal — orthogonal to
  // promptSetBy because promptSetBy flips to 'machine' on every machine prompt
  // rewrite while the owner's subscription persists. Covers (a) the ONE-SHOT
  // LADDER: dormant-gated chats cannot hold machine recurring rows, so an
  // owner-requested digest re-arms itself daily with promptSetBy 'machine' on
  // every rung — platform-tools stamps the successor ownerSubscribed when the
  // FIRING run was itself owner-subscribed; and (b) the 6ef770a1 latent hole:
  // a machine update_schedule that rewrites an owner-armed row's prompt
  // restamps promptSetBy 'machine', which alone would re-collapse the digest.
  // Either signal renders the firing EXPANDED ("requested" marker).
  let scheduleRow: { enabled: boolean; kind: string; runsCount: number; maxRuns: number | null; expiresAt: Date | null; lastFiredAt: Date | null; promptSetBy: string | null; ownerSubscribed: boolean | null; renewOnExhaustion?: boolean | null; intervalSec?: number | null; createdAt?: Date | null; prompt?: string | null } | null | undefined;
  if (origin === 'schedule') {
    scheduleRow = await prisma.chatSchedule.findUnique({
      where: { id: s.id },
      // renewOnExhaustion + intervalSec (wake-cadence-4 / -1): the [SCHEDULE
      // STATE] renewal clause and the busy-steer delta header read them.
      // createdAt (audit 2026-10-06 T4-7): a one-shot armed DURING the active
      // run is that run's own follow-up and is never steered into it.
      // prompt (ticket 2c7cee17): the STORED body decides whether this one-shot
      // is a zero-tool verbatim delivery rung (never steered into a busy run).
      select: { enabled: true, kind: true, runsCount: true, maxRuns: true, expiresAt: true, lastFiredAt: true, promptSetBy: true, ownerSubscribed: true, renewOnExhaustion: true, intervalSec: true, createdAt: true, prompt: true },
    }).catch(() => undefined);
    if (scheduleRow !== undefined && !scheduleRow?.enabled) {
      logger.info(`coding schedule: ${s.id} cancelled/expired before fire — skipping stale firing`);
      return { started: false, reason: 'cancelled' };
    }
  }

  // Continuation staleness guard (feedback fb8b609f): a [HARNESS CONTINUATION]
  // once-schedule bakes the unfinished-step count in at SCHEDULE time, but fires
  // ~15 min later — by which point a follow-up turn has usually finished the
  // work. The stale wake then burns a full run re-auditing a completed board
  // (observed ×3 in one night on session b92ef13f, plus Tenstorrent/Spark lanes)
  // and can trip the evidence guard. Re-read the plan at FIRE time: zero
  // unfinished steps → skip the wake; the sweeper disables the one-shot row on
  // reason 'obsolete'. A plan READ ERROR never skips — uncertainty must not
  // drop a real resumption. A drifted-but-nonzero count rewrites the prompt so
  // the fired run gets truthful context.
  let prompt = s.prompt;
  // agent-decisions prerequisite 5 (2026-09-27): the fire-time re-read used to
  // guard ONLY origin 'schedule' — a hook-origin (or any other) continuation
  // wake on a completed board still ran the full loop to a "Continuation
  // no-op" one-liner (39 machine + 11 hook of the 85 no-op finals / 14 d, $73
  // of $84; design §2.7 step 0). Every origin is guarded now, and each skip
  // writes ONE loop_metrics row (kind schedule_continuation_skip) so the
  // residual can be measured. (RSW-1 cl30, 2026-11-02: the schedule-only
  // release switch expired 2026-11-12 and was deleted — the guard is
  // unconditional on every origin.)
  // The claim-time twin for queued rows lives in run-executor.ts.
  const continuationGuarded = prompt.startsWith('[HARNESS CONTINUATION');
  if (continuationGuarded) {
    const { getPlanStrict, CONTINUATION_COUNT_RE, continuationCountSentence } = await import('./plan.service');
    const plan = await getPlanStrict(s.sessionId).catch(() => undefined);
    if (plan !== undefined) {
      const unfinished = (plan?.steps ?? []).filter((st: any) => st.status === 'pending' || st.status === 'in_progress');
      if (unfinished.length === 0) {
        logger.info(`coding schedule: ${s.id} continuation obsolete (origin ${origin}) — plan board already complete; skipping wake`);
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SCHEDULE_CONTINUATION_SKIP, sessionId: s.sessionId,
          meta: { scheduleId: s.id, origin, seam: 'fire', steps: (plan?.steps ?? []).length },
        });
        return { started: false, reason: 'obsolete' };
      }
      prompt = prompt.replace(
        CONTINUATION_COUNT_RE,
        continuationCountSentence(unfinished.length, { verifiedAtFireTime: true }),
      );
    }
  }

  // ── ALL-COMPLETE BOARD (tt-rd audit 2026-09-27 finding 5 — see the helpers
  //    next to planBoardAllComplete): a RECURRING schedule firing on a plan
  //    board that is already 100 % complete (every step completed — a blocked
  //    step makes it a wait lane, which never takes this path) is told so
  //    (advisory, appended) and counted. getPlan (error-swallowing) is
  //    deliberate here: a plan READ ERROR must never add a notice. ──
  //    ALLCOMPLETE-CHARTER-TERMINATION (2026-10-20, ./allcomplete-charter.ts):
  //    an all-complete board UNCHANGED since the last firing reads the lane's
  //    charter — DONE ⇒ would_retire (the opt-in SCHEDULE_CHARTER_TERMINATION_ENFORCE
  //    pauses a machine row: reason 'charter_done'), OPEN ⇒ the advisory becomes
  //    [RE-PLAN FROM CHARTER] with the open todos, NO charter + an empty lane
  //    ledger ⇒ skipped 'all_complete_idle' with a stretched next firing (1 in 10
  //    fires as a control). Any read error fires with today's advisory. Kill
  //    switch SCHEDULE_ALLCOMPLETE_IDLE_SKIP_DISABLED=1 (advisory only). ──
  if (origin === 'schedule' && scheduleRow?.kind === 'recurring' && !continuationGuarded) {
    try {
      const { getPlan } = await import('./plan.service');
      const plan = await getPlan(s.sessionId);
      if (plan && planBoardAllComplete(plan)) {
        const now = new Date();
        const lastFired = scheduleRow.lastFiredAt ? new Date(scheduleRow.lastFiredAt) : null;
        const planAt = plan.updatedAt ? new Date(plan.updatedAt) : null;
        const unchanged = !!(lastFired && planAt && !Number.isNaN(planAt.getTime()) && planAt.getTime() <= lastFired.getTime());
        const decision = unchanged
          ? await import('./allcomplete-charter')
            .then((m) => m.decideAllCompleteFiring({
              scheduleId: s.id, sessionId: s.sessionId, promptSetBy: scheduleRow?.promptSetBy ?? null, ownerSubscribed: scheduleRow?.ownerSubscribed ?? null,
              lastFiredAt: lastFired, intervalSec: scheduleRow?.intervalSec ?? null, steps: plan.steps.length, now,
            }))
            .catch(() => null)
          : null;
        // 'retire_requested': the sweep's guarded pause records the follow-up 'retired' / 'retire_lost' row.
        const action = !decision || decision.action === 'notice' ? 'notice' : decision.action === 'retire' ? 'retire_requested' : decision.action;
        const decisionMeta = decision && !(decision.action === 'notice' && decision.why === 'disabled')
          ? {
            why: decision.why,
            ...(decision.action === 'would_retire' ? { ownerRow: decision.ownerRow } : {}),
            ...(decision.action === 'replan' ? { openTodos: decision.openTodos } : {}),
            ...(decision.action === 'idle_skip' ? { nextRunAt: decision.nextRunAt.toISOString(), delayMin: Math.round(decision.delayMs / 60_000) } : {}),
            ...(decision.action === 'idle_control' ? { control: true } : {}),
          }
          : {};
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SCHEDULE_ALLCOMPLETE_FIRING, sessionId: s.sessionId,
          meta: { scheduleId: s.id, steps: plan.steps.length, planUnchangedSinceLastFire: unchanged, action, ...decisionMeta },
        });
        if (decision?.action === 'retire') {
          logger.info(`coding schedule: ${s.id} charter done on an unchanged all-complete board (${decision.why}) — pausing the row (SCHEDULE_CHARTER_TERMINATION_ENFORCE)`);
          return { started: false, reason: 'charter_done', detail: decision.why };
        }
        if (decision?.action === 'idle_skip') {
          logger.info(`coding schedule: ${s.id} idle-skipped — all-complete board, no charter, empty lane ledger since ${lastFired?.toISOString()}; next firing ${decision.nextRunAt.toISOString()}`);
          await import('./allcomplete-charter').then((m) => m.noticeAllCompleteIdleSkipOnce({ id: s.id, sessionId: s.sessionId }, decision.nextRunAt)).catch(() => false);
          return { started: false, reason: 'all_complete_idle', nextRunAt: decision.nextRunAt };
        }
        prompt = decision?.action === 'replan'
          ? `${prompt}\n\n${decision.notice}`
          : `${prompt}\n\n${allCompleteBoardNotice({ at: now, unchanged, steps: plan.steps.length })}`;
      }
    } catch (err: any) {
      logger.warn(`coding schedule: all-complete board check failed for ${s.id} (firing proceeds without it): ${err?.message ?? err}`);
    }
  }

  // [SCHEDULE STATE] injection (v1#14 / spark G1 / CanLaw L1): every schedule
  // firing's wake context carries the row's OWN exhaustion state — before
  // this, a lane could not know it was on its final firing (or one skip from
  // its daily cap) and lanes died mid-plan with no warning in-context.
  // Appended (never prepended — title seeds and the [HARNESS CONTINUATION
  // startsWith contract read the head). Best-effort: a state-build hiccup
  // must never skip a real firing.
  // wake-cadence-1: the built block is kept aside — a busy-steer delta header
  // carries it (short) instead of the whole prompt.
  let scheduleStateBlock: string | null = null;
  if (origin === 'schedule' && scheduleRow && typeof scheduleRow.runsCount === 'number') {
    try {
      const capState = await capStateForSession(s.sessionId);
      const firingNo = scheduleRow.runsCount + 1;
      const maxLabel = scheduleRow.maxRuns != null ? String(scheduleRow.maxRuns) : '∞';
      const expLabel = scheduleRow.expiresAt ? new Date(scheduleRow.expiresAt).toISOString().slice(0, 10) : 'never';
      const dailyLabel = `${capState.dailyFiresUsed ?? '?'}/${capState.dailyCapLimit}`;
      // wake-cadence-4 (2026-09-27 tt-rd audit): the block used to read like a
      // death clock ("firing 332 of 500") — a lane-authored "SUCCESSOR at
      // 480/500" clause then spawned a new chat + owner card + lost context at
      // 480 while the harness would have armed a same-cadence successor
      // anyway. The clause is computed with the SAME derivation
      // maybeRenewOnExhaustion uses.
      const renewClause = scheduleStateRenewClause({ kind: scheduleRow.kind, maxRuns: scheduleRow.maxRuns, promptSetBy: scheduleRow.promptSetBy, renewOnExhaustion: scheduleRow.renewOnExhaustion ?? null, fleetManaged: isFleetManagedCadence(s.id) });
      // wake-cadence-2: the claim that fired this row just stretched its cadence — say so in-context.
      const stretchLine = s.cadenceStretch ? cadenceStretchStateLine(s.cadenceStretch) : null;
      // todo 27c215d6: same visibility for the block-streak backoff.
      const blockStreakLine = s.blockStreakBackoff ? blockStreakStateLine(s.blockStreakBackoff) : null;
      // Docs-only PR churn (tt-rd audit 2026-09-27, finding docs-churn-log-1):
      // the lane sees how many of ITS OWN PRs in the last 24 h were docs-only
      // (every changed file markdown — the open_pull_request receipt flag) so
      // "a PR per firing" is visible to the lane that does it. Best-effort.
      let docsOnlyLabel = '';
      try {
        const pds = await import('./pr-diff-shape');
        {
          const { getRecentChatReceipts } = await import('./run-receipts.service');
          // Tool-filtered at the DB (fixer 2026-09-27): the unfiltered 500-row
          // cap reached back < 24 h on a busy lane, truncating this count.
          const n = pds.docsOnlyPrCount(await getRecentChatReceipts(s.sessionId, pds.docsOnlyPrBatchMs(), { tools: ['open_pull_request'] }), new Date(), pds.docsOnlyPrBatchMs());
          if (n > 0) docsOnlyLabel = ` · docs-only PRs opened by this lane in the last ${Math.round(pds.docsOnlyPrBatchMs() / 3_600_000)}h: ${n} (a results/tracker append is a record, not a change — batch appends, one PR per day)`;
        }
      } catch { /* the churn line is best-effort */ }
      // Adoption ladder (tt-rd audit 2026-09-27, finding 3): the lane sees its
      // own experiments-since-last-KPI-move so it can self-close a ladder.
      // Best-effort; '' on any read miss (ADOPTION_LADDER_DISABLED=1 too).
      let ladderClause = '';
      try {
        const { ladderForLane, renderLaneLadderClause } = await import('../platform/adoption-ladder');
        const ladder = await ladderForLane(s.sessionId);
        if (ladder && ladder.experiments > 0) ladderClause = ` · ${renderLaneLadderClause(ladder)}`;
      } catch { /* the firing never waits on the ladder */ }
      scheduleStateBlock = `[SCHEDULE STATE] firing ${firingNo} of ${maxLabel} · expires ${expLabel} · daily ${dailyLabel}${renewClause ? ` · ${renewClause}` : ''}${ladderClause}${docsOnlyLabel}${stretchLine ? `\n[SCHEDULE STATE] ${stretchLine}` : ''}${blockStreakLine ? `\n[SCHEDULE STATE] ${blockStreakLine}` : ''}`;
      prompt = `${prompt}\n\n${scheduleStateBlock}`;
      // ── Terminal-step checklist (ticket 0973bdd7, 2026-11-01) ────────────
      // A digest prompt that ends "…THEN call notify_user with a 1-3 line
      // summary" states a REQUIRED terminal side-effect, but as prose at the
      // end of a 1,600-char instruction it reads as an afterthought — and a
      // run that spends all 8 chatProfile('thinking') rounds on the data pull
      // reaches the tools-off final turn without ever making the call. This
      // block promotes the mandate to a checklist item WITH a budget rule,
      // so the obligation is weighed BEFORE the pull instead of discovered at
      // the wall. Appended like every other [SCHEDULE STATE]-family block
      // (never prepended — the prompt HEAD is read by title seeds and the
      // [HARNESS CONTINUATION] startsWith contract). Emitted ONLY when the
      // schedule's OWN stored prompt declares the step, so schedules that ask
      // for no ping pay no prompt cost. Best-effort: a detector hiccup must
      // never skip a real firing.
      try {
        const { declareTerminalStep, renderTerminalStepBrief } = await import('../chat-agent/terminal-step-brief');
        const terminalBlock = renderTerminalStepBrief(declareTerminalStep(String(scheduleRow.prompt ?? '')));
        if (terminalBlock) prompt = `${prompt}\n\n${terminalBlock}`;
      } catch { /* the brief block is best-effort — the firing itself must never be blocked */ }
    } catch (err: any) {
      logger.warn(`coding schedule: [SCHEDULE STATE] block build failed for ${s.id} (firing proceeds without it): ${err?.message ?? err}`);
    }
  }

  // ── P6 (N4): prompt-change wake notice. When the schedule's prompt was
  // rewritten since its LAST firing (ledger row newer than lastFiredAt), the
  // fired run is told — a lane whose brief silently changed under it must know
  // it is running the CURRENT version, not the one it remembers. Best-effort;
  // only when the stale-guard read above succeeded (scheduleRow known).
  // APPENDED after the exhaustion block (never prepended — title seeds and the
  // [HARNESS CONTINUATION startsWith contract read the head of the prompt). ──
  // wake-cadence-1: the busy-steer delta header reuses this verdict — a prompt
  // that changed since the last firing is delivered in full, and (fixer
  // 2026-09-27) it also bypasses the once-per-run steer dedupe, so a rewrite
  // reaches a run that already holds a steer instead of waiting for the next
  // fresh start (the supervisor doctrine steers clauses OUT of a lane's prompt
  // with update_schedule — that rewrite must land in the running run).
  let promptChangedSinceLastFiring = false;
  if (origin === 'schedule' && scheduleRow) {
    try {
      const latest = await prisma.schedulePromptHistory.findFirst({
        where: { scheduleId: s.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, author: true },
      });
      if (latest && (!scheduleRow.lastFiredAt || latest.createdAt > scheduleRow.lastFiredAt)) {
        promptChangedSinceLastFiring = true;
        const versions = await prisma.schedulePromptHistory.count({ where: { scheduleId: s.id } });
        prompt = `${prompt}\n\n[SCHEDULE STATE: this schedule's prompt CHANGED since its last firing (now v${versions + 1}, last rewritten by ${latest.author || 'unknown'}). The message above is the CURRENT prompt — do not act on remembered older versions of it.]`;
      }
    } catch { /* notice is best-effort — the firing itself must never be blocked */ }
  }

  // ── P7 (G13): required-probe notice. When the schedule's PREVIOUS machine
  // firing finished without its required probe receipts, this firing is told —
  // appended like the other [SCHEDULE STATE] blocks (never prepended). Consumed
  // atomically here; restored below when the firing does not start, so a
  // busy-skip never eats the notice.
  let probeNotice: string | null = null;
  // wake-cadence-1: kept aside so a busy-steer delta header can carry it.
  let probeNoticeBlock: string | null = null;
  if (origin === 'schedule') {
    probeNotice = await consumeProbeNotice(s.id);
    if (probeNotice) {
      probeNoticeBlock = `[SCHEDULER NOTICE] Your previous firing finished WITHOUT the receipts this schedule REQUIRES (${probeNotice}). Run those probes THIS firing and let their tool receipts land${requiredProbesPauseEnabled() ? ` — after ${REQUIRED_PROBE_PAUSE_THRESHOLD} consecutive probe-less firings this schedule is paused` : ' — consecutive probe-less firings are counted and journaled'}.`;
      prompt = `${prompt}\n\n${probeNoticeBlock}`;
    }
  }

  // ── Terminal-stop contract (feedback 065caccb) — see appendTerminalStopNotice. ──
  prompt = await appendTerminalStopNotice(prompt, s.id);
  // ── Infra-blocker advisory (feedback 2b45941b): a deploy-runbook firing rides
  //    the fleet-wide blocker registry — see appendInfraBlockerNotice. ──
  prompt = await appendInfraBlockerNotice(prompt, s.id);
  // ── Batch-train advisory (T2c, todo 9c89ab21): while a train is boarding,
  //    a deploy-runbook firing learns it BEFORE it merges a code PR into
  //    main — the merge gate refuses it, but the notice is the cheaper
  //    teacher. Same advisory/fail-open doctrine as the blocker notice. ──
  prompt = await appendBatchTrainNotice(prompt, s.id);

  // ── Trigger-keyed sweep-doctrine rebuild (R&D stream 3 experiment #2,
  //    2026-09-18; placement fixed experiment #3 review finding C6): stock
  //    sweep bodies no longer inline the standing doctrine — it rides the
  //    lane's cached system prompt. Probe THAT lane's system prompt at fire
  //    time: doctrine absent there → rebuild it into the firing message (NO
  //    wake ever runs doctrine-less); a legacy pre-heal stored body (doctrine
  //    still inline) passes through un-doubled. Only sweep firings pay the one
  //    extra systemPrompt select. A read ERROR resolves TOWARD doctrine
  //    (systemPrompt null → inline fallback) — uncertainty must never produce
  //    a doctrine-less wake, and never skip a firing.
  //    C6 PLACEMENT (2026-09-18): applied per branch to the FINAL message —
  //    after the [SCHEDULE STATE]/cap/spend/terminal-stop appends — so the
  //    end-injected doctrine is the composite's absolute suffix and the
  //    user-role clip's retained 7,000c tail keeps the whole block (the
  //    doctrine ≤7k tail budget is pinned in sweep-doctrine-rebuild.test.ts).
  //    Exactly one branch runs per firing, so the probe still fires once. ──
  const applySweepDoctrineRebuild = async (text: string): Promise<string> => {
    if (!classifySweepPrompt(text)) return text;
    let laneSystemPrompt: string | null = null;
    try {
      const lane = await prisma.crossModelChat.findUnique({
        where: { id: s.sessionId },
        select: { systemPrompt: true },
      });
      laneSystemPrompt = lane?.systemPrompt ?? null;
    } catch (err: any) {
      logger.warn(`coding schedule: sweep-doctrine probe failed for ${s.sessionId} (rebuild inlines the doctrine): ${err?.message ?? err}`);
      laneSystemPrompt = null;
    }
    const rebuilt = rebuildSweepPromptDoctrine({
      prompt: text,
      systemPrompt: laneSystemPrompt,
      forceInline: process.env.SWEEP_DOCTRINE_FORCE_INLINE === '1',
    });
    if (rebuilt.mode === 'inlined-fallback') {
      logger.warn(`coding schedule: sweep doctrine REBUILT into firing for ${s.sessionId} — lane system prompt lacks the doctrine marker (the stock-prompt heal should repair this)`);
    }
    return rebuilt.prompt;
  };

  if ((chat as any).codingState) {
    const { startScheduledRun } = await import('./coding-stream.controller');
    // Owner-armed/owner-subscribed firing (tickets 6ef770a1 + 4565991a): the
    // SAME signal the plain-chat branch threads to startDetachedChatRun, now
    // on the CODING path too — promptSetBy 'user' (armed from a real user
    // turn) OR ownerSubscribed (the subscription marker that survives machine
    // prompt rewrites and one-shot ladder re-arms). The executor stamps the
    // wake user row's metadata.scheduleOwnerArmed (frontend mounts the whole
    // machine turn EXPANDED with a "requested" marker) and the final answer
    // row's metadata.kind 'owner_digest' (the digest ANSWER renders as a
    // normal visible bubble), and threads the subscription into the agent
    // loop so the firing's own-chat re-arms keep the mark. The plain-chat
    // branch below computes the SAME expression from the same inputs (its own
    // local const predates this change and is left untouched — the two
    // branches are exclusive, so the values can never diverge).
    // Hook wakes (synthetic hook-* ids, origin 'hook') never arm — origin-gated.
    const scheduleOwnerArmed = origin === 'schedule'
      && (scheduleRow?.promptSetBy === 'user' || scheduleRow?.ownerSubscribed === true);
    // Provider-failure attribution (feedback cff523e7): stamp the REAL schedule
    // row id onto the queued run's input so the executor can count consecutive
    // provider-killed runs per schedule. CRITICAL: hook-wake deliveries reuse
    // this path with a synthetic `hook-${hookId}` id (hooks.service.ts) — never
    // stamp those; a hook wake is not a schedule firing and must not feed the
    // schedule's failure counter.
    prompt = await applySweepDoctrineRebuild(prompt);
    // Busy-session steer (see busyFiringSteerHeader): an active run takes the
    // firing as a steer. steerActiveRun self-gates on an active run row and
    // persists the steer as an origin-stamped user row (transcript honesty);
    // a parked ask_user wait receives it as the answer (message-as-answer).
    // Optional-chained so suites that mock the controller partially keep the
    // pre-change start path byte for byte.
    // audit 2026-10-06 T4-7 (others.md F14): a ONE-SHOT armed WHILE the
    // session's current run was already active is that run's own follow-up
    // (a "clean re-delivery" / "after this finishes" wake) — steering it INTO
    // the run it is meant to follow folded the Workspace AI digest's
    // standalone re-delivery into the still-running digest run (posted 75–100
    // min late, the model armed more one-shots). Such a firing skips the
    // busy-steer and takes the queue-behind-busy path below (it starts right
    // after the active run finishes). Deterministic: schedule.createdAt ≥ the
    // active run's start. Recurring rows, hook wakes and one-shots armed
    // before the run started steer as before. Kill switch
    // BUSY_STEER_OWN_ONESHOT_QUEUE_DISABLED=1. Fail-open (lookup error ⇒ steer).
    // ticket 2c7cee17: a ZERO-TOOL VERBATIM DELIVERY one-shot (the digest
    // "clean re-delivery" rung) must never become a steer — its whole purpose
    // is ONE standalone transcript row, and a steer folds it into the active
    // run's own (accumulated) final row, structurally. The T4-7 arm-time
    // carve-out above only catches rungs armed DURING the active run; the
    // incident's rung was armed BEFORE an unrelated ladder run started
    // (23323ecd armed 14:36Z, run e3d3555f started 14:49Z, rung fired 14:51Z
    // → steered). The prompt-shape predicate is deterministic on content, so
    // it covers BOTH orderings. Same kill switch family: steer semantics for
    // everything else are untouched (recurring rows, hook wakes, ordinary
    // working one-shots keep the 2026-09-24 busy-steer).
    const deliveryRungOneShot = origin === 'schedule' && scheduleRow?.kind === 'once'
      ? isZeroToolDeliveryPrompt(scheduleRow?.prompt ?? null)
      : false;
    if (deliveryRungOneShot) {
      recordLoopMetric({ kind: 'busy_steer_delivery_rung_queued', sessionId: s.sessionId, meta: { scheduleId: s.id } });
      logger.info(`coding schedule: one-shot ${s.id} of ${s.sessionId.slice(0, 8)} is a zero-tool verbatim delivery rung (ticket 2c7cee17) — queued behind the active run, never steered into it`);
    }
    const ownFollowUpOneShot = (origin === 'schedule' && scheduleRow?.kind === 'once')
      && (deliveryRungOneShot || await oneShotArmedDuringActiveRun(s.sessionId, s.id, scheduleRow?.createdAt ?? null));
    if (!ownFollowUpOneShot) {
      try {
        const ctl: any = await import('./coding-stream.controller');
        if (typeof ctl?.steerActiveRun === 'function') {
          // ── wake-cadence-1 (2026-09-27 tt-rd audit): a RECURRING schedule
          //    steers at most ONCE into a given active run, and a steer into
          //    the run this schedule itself started carries a SHORT delta
          //    header instead of the whole stored prompt. Before this, every
          //    30-min firing that landed on the running run was delivered in
          //    full with "fold it into your current work" and consumed a
          //    firing, so the run never reached a natural end (117…257-min
          //    runs with 1…8 steers, ~115k prompt tokens re-sent per turn).
          //    Deterministic (an atomic Redis INCR per schedule×run), cheap,
          //    fail-open: any lookup error keeps the pre-change full steer.
          let steerText = `${busyFiringSteerHeader(origin, s.id)}\n\n${prompt}`;
          let activeRun: { id: string; input: any } | null = null;
          const recurringSchedule = origin === 'schedule' && scheduleRow?.kind === 'recurring';
          if (recurringSchedule) {
            try {
              activeRun = await prisma.agentRun.findFirst({
                where: { sessionId: s.sessionId, status: { in: ['queued', 'running'] } },
                orderBy: { createdAt: 'desc' },
                select: { id: true, input: true },
              });
            } catch (err: any) {
              logger.warn(`coding schedule: active-run lookup for the busy-steer dedupe failed for ${s.id} (full steer, no dedupe): ${err?.message ?? err}`);
              activeRun = null;
            }
          }
          if (activeRun) {
            let steersInRun = 0;
            try {
              const key = `cm:sched:steer:${s.id}:${activeRun.id}`;
              const n = await redisClient.incr(key);
              if (n === 1) await redisClient.expire(key, 24 * 3600).catch(() => {});
              steersInRun = Math.max(0, Number(n) - 1);
            } catch (err: any) {
              logger.warn(`coding schedule: busy-steer dedupe counter failed for ${s.id} (steering as before): ${err?.message ?? err}`);
              steersInRun = 0;
            }
            // fixer 2026-09-27: a prompt REWRITTEN since the last firing bypasses
            // the dedupe ONCE — delivered in full (the delta header is gated on
            // the same verdict below). The steer stamps lastFiredAt, so the next
            // unchanged firing is deduped again; the counter keeps counting.
            if (steersInRun >= 1 && !promptChangedSinceLastFiring) {
              logger.info(`coding schedule: ${s.id} NOT steered again into run ${activeRun.id.slice(0, 8)} of ${s.sessionId.slice(0, 8)} — it already holds ${steersInRun} steer(s) from this schedule (wake-cadence-1 dedupe; firing not consumed, cap token refunded)`);
              recordLoopMetric({ kind: LOOP_METRIC_KINDS.SCHEDULE_STEER_DEDUPED, sessionId: s.sessionId, meta: { scheduleId: s.id, runId: activeRun.id, steersInRun } });
              if (probeNotice) await restoreProbeNotice(s.id, probeNotice).catch(() => {});
              return { started: false, reason: 'steer_duplicate' };
            }
            if (steersInRun >= 1) {
              logger.info(`coding schedule: ${s.id} steered AGAIN into run ${activeRun.id.slice(0, 8)} of ${s.sessionId.slice(0, 8)} — its prompt changed since the last firing, so the rewrite is delivered in full (wake-cadence-1 dedupe bypassed once)`);
            }
          }
          if (activeRun && String(activeRun.input?.scheduleId ?? '') === s.id && !promptChangedSinceLastFiring) {
            steerText = `${busyFiringSteerHeader(origin, s.id)}\n\n${busySteerDeltaBody(s.id, [scheduleStateBlock ?? '', probeNoticeBlock ?? ''])}`;
          }
          const steer = await ctl.steerActiveRun(s.sessionId, steerText, { origin, ...(scheduleOwnerArmed ? { scheduleOwnerArmed: true } : {}) });
          if (steer?.steered) {
            logger.info(`coding schedule: ${s.id} (${origin}) delivered as a STEER into the active run of ${s.sessionId.slice(0, 8)} (${steer.reason ?? 'steered'}) — no run queued`);
            // wake-cadence-2: remember that this row's latest firing was a
            // steer — the next fire-time stretch reads it (consumed by the
            // stretch it triggers at that claim; cleared on a real start).
            if (recurringSchedule) {
              try {
                await redisClient.set(`cm:sched:steered:${s.id}`, activeRun?.id ?? '1', { EX: 24 * 3600 });
              } catch { /* best-effort — the stretch has two other triggers */ }
            }
            return { started: true, steered: true };
          }
        }
      } catch (err: any) {
        logger.warn(`coding schedule: busy-session steer probe failed for ${s.id} (falling back to the run start): ${err?.message ?? err}`);
      }
    }
    const res = await startScheduledRun(s.sessionId, prompt, {
      origin,
      ...(origin === 'schedule' ? { scheduleId: s.id } : {}),
      // Owner-subscribed firing (ticket 4565991a coding leg): threads the
      // subscription into the queued RunInput so the executor stamps BOTH
      // rows (wake user row scheduleOwnerArmed + final answer kind
      // 'owner_digest') and the agent loop's own-chat re-arms inherit the
      // mark — the dormant-gate one-shot ladder never loses it again.
      ...(scheduleOwnerArmed ? { scheduleOwnerArmed: true } : {}),
      // Queue-behind-busy (ticket 3405e332): a ONE-SHOT firing on a busy
      // session rides the agent_runs queue BEHIND the active run instead of
      // the sweeper's 3-min skip+re-arm, which can drift it for hours while
      // runs stays 0/1. RECURRING schedules keep the re-arm — queueing every
      // interval would pile runs up behind a long busy stretch. Hook wakes
      // (synthetic hook-* ids, no row read) never take this path. A
      // recurring-like one-shot CHAIN link (finding B1) keeps the re-arm too.
      ...(origin === 'schedule' && scheduleRow?.kind === 'once' && !s.onceChainRecurringLike ? { queueBehindBusy: true } : {}),
      // WI-C: the decision stash rides RunInput.decision (inline start AND the
      // queue-behind-busy row carry the same built input).
      ...(s.decision ? { decision: s.decision } : {}),
      // Child-result wake (ticket 56d6b204): the executor stamps the wake user
      // row's metadata.childResult so the frontend renders the sub-session's
      // delivered result EXPANDED, not folded behind the machine accordion.
      ...(s.childResult ? { childResult: true } : {}),
      // ARCHIVED-TARGET-RETIRE (f): the heal's archived-refusal row names this surface.
      ...(s.dispatchSurface ? { dispatchSurface: s.dispatchSurface } : {}),
    });
    if (!res.started && probeNotice) await restoreProbeNotice(s.id, probeNotice).catch(() => {});
    return res.started && s.decision ? { ...res, decisionDeferred: true } : res;
  }

  // Non-code chat → detached chat-agent turn. Dynamic import: chat-agent.service
  // pulls in the whole agent loop (which imports coding/tools → platform-tools →
  // platform.service → THIS module) — a static import would cycle.
  // machineWake: true — schedule firings AND hook wakes (both funnel through
  // here) get the freshness preamble, skip the forced SERP/cross-checker, and
  // use the deeper history slice (postmortem 2026-08-11, ONE_SESSION_PLATFORM.md).
  const { startDetachedChatRun } = await import('../chat-agent/chat-agent.service');
  // The wake's PRESET (2026-09-26, types.ts storedModeToPreset): a stored
  // level is that level (legacy chats behave identically); the stored default
  // 'auto' is the L2 preset fallback — the chat-agent's compute policy then
  // decides checker / effort per wake (chat-agent.service machinePresetPlan +
  // machine rails: never a checker wait, never an auto council).
  const mode = storedModeToPreset(chat.mode);
  // Cap-skip notice for PLAIN-CHAT lanes (CanLaw B8): the skipped-firings
  // counter was consumed only by the CODING entry paths (startScheduledRun /
  // queueContinuationRun), so a plain chat whose firings were capped never
  // learned it — the notice rides the wake prompt here. Consumed before the
  // start; restored when the run did not start (same contract as the coding
  // paths). Best-effort either way.
  let plainSkipped = 0;
  let plainSpendSkipped = 0;
  let message = prompt;
  try {
    plainSkipped = await consumeCapSkipNotice(s.sessionId);
    if (plainSkipped > 0) {
      message += `\n\n[SCHEDULER NOTICE] ${plainSkipped} scheduled firing(s) were skipped since this chat's last machine run because it hit its daily firing cap. Re-space the cadence (longer interval via update_schedule) or ask the owner to raise scheduleCap via set_chat_autonomy.`;
    }
  } catch { /* best-effort */ }
  // Spend-skip notice parity (P7 N7/S1a): plain-chat lanes learn their firings
  // were spend-capped exactly like the daily-cap notice above. Consumed before
  // the start; restored when the run did not start. Best-effort either way.
  // Ticket 1769c8d1: the parked verdict rides along so the notice NAMES the
  // cap (scope + figure + where it lives), not just "a spend cap".
  try {
    const { consumeSpendCapSkipNotice, spendSkipNoticeText, readParkedSpendCapVerdict } = await import('./spend-cap.service');
    plainSpendSkipped = await consumeSpendCapSkipNotice(s.sessionId);
    if (plainSpendSkipped > 0) {
      const verdict = await readParkedSpendCapVerdict(s.sessionId);
      message += `\n\n[SCHEDULER NOTICE] ${spendSkipNoticeText(plainSpendSkipped, verdict)}`;
    }
  } catch { /* best-effort */ }
  // C6 placement: rebuild on the FINAL message (cap/spend notices already
  // appended) so the end-injected doctrine is the absolute suffix.
  const preDoctrineMessage = message;
  message = await applySweepDoctrineRebuild(message);
  // ── Queued report-up RIDER (hardening loop iteration 7, 2026-09-24): agent
  //    rows queued behind this busy chat ride THIS wake instead of costing a
  //    separate drain turn (message-queue.service peekWakeRider — bounded,
  //    user/upload rows never ride, WAKE_QUEUE_RIDER_DISABLED=1 kills it).
  //    Appended BEFORE the doctrine suffix (a second rebuild on the composite
  //    keeps the C6 tail contract), and ONLY on the message the run starts
  //    with: the queue-behind-busy fallback below enqueues `message` (no
  //    rider) so a busy skip never duplicates the rows. Deleted after the run
  //    STARTS (peek → start → delete, exactly like drainChatQueue). ──
  let rider: import('../chat-agent/message-queue.service').WakeRider | null = null;
  let wakeMessage = message;
  try {
    const mq: any = await import('../chat-agent/message-queue.service');
    if (typeof mq?.peekWakeRider === 'function') rider = await mq.peekWakeRider(s.sessionId);
    if (rider) wakeMessage = await applySweepDoctrineRebuild(`${preDoctrineMessage}\n\n${rider.text}`);
  } catch { rider = null; wakeMessage = message; }
  // Fleet origin marking: a schedule firing or hook wake is a MACHINE wake —
  // stamped metadata.origin ('schedule' or 'hook', per the trigger) on both
  // rows so the fleet views can filter it AND attribute it to the right
  // subsystem. Busy detection is startDetachedChatRun's own ATOMIC gate (local
  // registry + cross-process Redis claim, P5 audit) — a separate pre-check
  // would only reopen the TOCTOU it closes. null = a run owns the chat
  // somewhere.
  // Owner-armed signal (ticket 6ef770a1): promptSetBy 'user' = the owner
  // armed this schedule from a real user turn (schedule_message) — the fired
  // digest is DELIVERED CONTENT, not internal wake noise, and must render
  // EXPANDED in the transcript accordion. Only the explicit 'user' stamp
  // counts: legacy NULL and machine/system rows keep today's collapsed
  // render exactly. Threading here persists metadata.scheduleOwnerArmed on
  // the wake user row (chat-agent.service userMetadata compose), which the
  // frontend grouping reads off the group's ANCHOR row.
  const scheduleOwnerArmed = origin === 'schedule'
    && (scheduleRow?.promptSetBy === 'user' || scheduleRow?.ownerSubscribed === true);
  const started = await startDetachedChatRun({
    // `message` is built from the rewritten `prompt` above (never s.prompt) —
    // the [SCHEDULE STATE] exhaustion block and the P6 prompt-change notice
    // must reach the chat lane too. `wakeMessage` = message (+ the queued
    // report-up rider when one rides this wake).
    userId: chat.userId, chatId: s.sessionId, message: wakeMessage, mode, machineWake: true, messageOrigin: origin,
    ...(scheduleOwnerArmed ? { scheduleOwnerArmed: true } : {}),
    // One-shot chain provenance (finding B1): the fired schedule's id rides
    // to the run's ToolContext so its OWN-chat one-shot re-arms stamp the link.
    ...(origin === 'schedule' ? { firedByScheduleId: s.id } : {}),
    // Child-result wake (ticket 56d6b204): the wake user row's
    // metadata.childResult marks the machine turn as a DELIVERED SUB-SESSION
    // RESULT — content the owner is waiting on, not internal wake noise — so
    // the frontend renders the turn EXPANDED with a "results" marker (the
    // 2026-09-25 incident: the parent's DB-audit answer stayed hidden behind
    // the collapsed accordion while the owner waited for it).
    ...(s.childResult ? { childResult: true } : {}),
    // Owner-ask wake (fixer 2026-09-27): the ask ids the finalize closes on a
    // real reply (chat-agent ownerAskMessageIds).
    ...(s.ownerAskMessageIds?.length ? { ownerAskMessageIds: s.ownerAskMessageIds } : {}),
    // WI-C: the decision stash rides the detached run's args to the chat finalize.
    ...(s.decision ? { decision: s.decision } : {}),
  });
  if (started && rider) {
    try {
      const mq: any = await import('../chat-agent/message-queue.service');
      const removed = typeof mq?.consumeWakeRider === 'function' ? await mq.consumeWakeRider(rider) : 0;
      if (removed !== rider.rows.length) {
        logger.error(`coding schedule: wake rider on ${s.sessionId.slice(0, 8)} deleted ${removed}/${rider.rows.length} queued row(s) — a survivor may re-deliver on the next drain`);
      }
      if (rider.maxDepth > 0) {
        // Depth propagation through the ridden hop (hooks.service ladder) — the
        // same stamp drainChatQueue applies for a coalesced batch.
        const hooksMod: any = await import('../platform/hooks.service').catch(() => null);
        await Promise.resolve(hooksMod?.stampHookDepth?.(s.sessionId, rider.maxDepth)).catch(() => {});
      }
      logger.info(`coding schedule: ${origin} wake on ${s.sessionId.slice(0, 8)} carried ${rider.rows.length} queued agent message(s) as a rider (${rider.text.length} chars${rider.remaining ? `, ${rider.remaining} more still queued` : ''})`);
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.WAKE_QUEUE_RIDER,
        sessionId: s.sessionId,
        value: rider.rows.length,
        meta: { origin, chars: rider.text.length, remaining: rider.remaining, ...(origin === 'schedule' ? { scheduleId: s.id } : { hookId: s.id }) },
      });
    } catch (err: any) {
      logger.error(`coding schedule: wake rider consume failed on ${s.sessionId.slice(0, 8)} (rows may re-deliver): ${err?.message ?? err}`);
    }
  }
  // A recurring-like one-shot CHAIN link (finding B1) keeps the busy re-arm.
  if (!started && origin === 'schedule' && scheduleRow?.kind === 'once' && !s.onceChainRecurringLike) {
    // Queue-behind-busy (ticket 3405e332): a ONE-SHOT firing on a busy plain
    // chat rides pending_chat_messages — the same queue a user/agent message
    // takes while a run is active, drained by the finishing run's finally —
    // instead of the sweeper's 3-min skip+re-arm, which can drift a "check
    // back in 90 minutes" for HOURS on a continuously-busy lane (the Fleet
    // Supervisor one-shots sat runs 0/1 for 7h/3h and fired stale, if ever).
    // The fully-built message ([SCHEDULE STATE] blocks + cap/spend notices)
    // rides the queued row; the drain starts it as machineWake/messageOrigin
    // 'schedule' and enforces cancel-wins against the stashed scheduleId.
    // RECURRING schedules keep the re-arm — queueing every interval would pile
    // runs up. A full queue (20) or any enqueue error falls back to the busy
    // skip below.
    try {
      const { enqueueChatMessage } = await import('../chat-agent/message-queue.service');
      const queuedRow = await enqueueChatMessage({
        chatId: s.sessionId,
        userId: chat.userId,
        content: message,
        mode,
        source: 'schedule',
        origin: { kind: 'schedule', scheduleId: s.id, ...(scheduleOwnerArmed ? { ownerArmed: true } : {}) },
      });
      logger.info(`coding schedule: ${s.id} queued behind busy chat ${s.sessionId.slice(0, 8)} as pending message ${queuedRow.id} (position ${queuedRow.position})`);
      recordLoopMetric({ kind: LOOP_METRIC_KINDS.WAKE_DELIVERED, sessionId: s.sessionId, meta: { lane: 'schedule_queue_behind_busy', scheduleId: s.id, pendingId: queuedRow.id } });
      return { started: true, queued: true };
    } catch (queueErr: any) {
      logger.warn(`coding schedule: ${s.id} queue-behind-busy enqueue failed (${queueErr?.message ?? queueErr}) — falling back to busy re-arm`);
    }
  }
  if (!started && plainSkipped > 0) await restoreCapSkipNotice(s.sessionId, plainSkipped).catch(() => {});
  if (!started && plainSpendSkipped > 0) {
    try {
      const { restoreSpendCapSkipNotice } = await import('./spend-cap.service');
      await restoreSpendCapSkipNotice(s.sessionId, plainSpendSkipped);
    } catch { /* best-effort */ }
  }
  if (!started && probeNotice) await restoreProbeNotice(s.id, probeNotice).catch(() => {});
  return started ? { started: true, ...(s.decision ? { decisionDeferred: true } : {}) } : { started: false, reason: 'busy' };
}

/* ── Busy-skip alarm escalation (v1#33 follow-up) ─────────────────────────────
 * The original alarm fired only at strict busySkips === 3 and never again — one
 * prod lane reached 75 consecutive skips in silence. The alarm now fires on
 * threshold CROSSINGS: 3, 10, then every 25 (25, 50, 75, …).
 * Gate flip 2026-09-11 (owner: full steam): a crossing logs a line instead
 * of an attention_needed hook wake — opt-in BUSY_SKIP_ALARM_HOOK=1 restores the hook,
 * and only from the BUSY_SKIP_ALARM_ESCALATE (≥10) crossing. The
 * schedule_busy_skip metric + busySkips column (the zombie watchdog's inputs)
 * are untouched. */
export const BUSY_SKIP_ALARM_FIRST = 3;
export const BUSY_SKIP_ALARM_ESCALATE = 10;
export const BUSY_SKIP_ALARM_REPEAT_EVERY = 25;

/**
 * Escalation level for a busy-skip count: 0 below 3, 1 at 3–9, 2 at 10–24,
 * then 2 + floor(n/25). The sweeper alarms when one increment RAISES the level
 * (level(n) > level(n-1)) — derived from the persisted count alone, so a
 * swallowed skip-write or a crashed emit can delay a crossing but never skip a
 * level (the next threshold still fires). Pure — exported for tests.
 */
export function busySkipAlarmLevel(n: number): number {
  if (!Number.isFinite(n) || n < BUSY_SKIP_ALARM_FIRST) return 0;
  if (n < BUSY_SKIP_ALARM_ESCALATE) return 1;
  if (n < BUSY_SKIP_ALARM_REPEAT_EVERY) return 2;
  return 2 + Math.floor(n / BUSY_SKIP_ALARM_REPEAT_EVERY);
}

/** What holds the lane at a busy-skip crossing: a live agent run, a stuck
 *  coding-session row, or a run outside agent_runs (a plain-chat lane's own
 *  turn / a cross-instance claim — the case the code already tolerates). */
export type BusySkipBlockerKind = 'run' | 'stuck_row' | 'outside';

/**
 * Log level for a busy-skip alarm crossing (the line is written at EVERY
 * crossing regardless — this only picks its level). The tolerated cases stay at info: the 3-skip level (9 min busy,
 * under the p50 legitimate run) and a plain-chat lane's own turn holding the
 * lane ('outside' — 100 % false-positive over 192 wakes / 48 h when it woke
 * the supervisor; 485 warn rows / 7 d since). A ≥10-skip crossing with a
 * NAMED blocker (a live run or a stuck row) stays warn — that is the wedged-
 * lane signal the reader wants. `BUSY_SKIP_ALARM_WARN_ALL=1` restores warn at
 * every crossing. Pure — exported for tests.
 */
export function busySkipAlarmLogLevel(n: number, blocker: BusySkipBlockerKind, envSource: NodeJS.ProcessEnv = process.env): 'warn' | 'info' {
  if (envSource.BUSY_SKIP_ALARM_WARN_ALL === '1') return 'warn';
  if (blocker === 'outside') return 'info';
  return n >= BUSY_SKIP_ALARM_ESCALATE ? 'warn' : 'info';
}

/** Per-tick wall-clock deadline (v1#16): past it fireDue logs, resets the
 *  process-local `sweeping` latch and lets the next timer tick sweep — a
 *  single wedged await used to hold `sweeping=true` forever and deafen the
 *  instance's whole scheduling+hook-delivery lane until redeploy. */
export const SWEEP_TICK_DEADLINE_MS = 120_000;
let sweepTickGen = 0;

/** One sweeper tick: claim due schedules and fire them. Exported for tests (the boot sweeper drives it via timer). */
export async function fireDue(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  const gen = ++sweepTickGen;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), SWEEP_TICK_DEADLINE_MS);
    (timer as any).unref?.();
  });
  try {
    const result = await Promise.race([sweepTickBody().then(() => 'done' as const), deadline]);
    if (result === 'timeout') {
      logger.warn(`coding schedule sweep: tick exceeded its ${Math.round(SWEEP_TICK_DEADLINE_MS / 1000)}s deadline — resetting the sweeping latch (the wedged tick keeps running detached; its writes are all guarded/idempotent)`);
    }
  } finally {
    if (timer) clearTimeout(timer);
    // Generation guard: a wedged tick that finally finishes must not clear a
    // NEWER tick's latch (its own gen is stale by then).
    if (sweepTickGen === gen) sweeping = false;
  }
}

/** One log line per retirement, not one per 30 s tick. */
let retiringSweepLogged = false;

/** The actual tick body — catches all its own errors (never rejects). */
async function sweepTickBody(): Promise<void> {
  // Retiring colour (2026-09-18 audit, wave 414b9cce): the OLD backend kept
  // SWEEPING during its drain — it claimed due schedules and pending hook
  // events, then startDetachedChatRun refused the start (retiring gate), so
  // every claim became a busy-skip (busySkips 50 on the Fleet Supervisor,
  // schedule_busy_alarm rows with "a run outside agent_runs" — a phantom
  // blocker) or a 3-min busy PARK that delayed a wake the NEW colour could
  // have delivered at once (233 refusals in 2.5 h). A retiring process does
  // not sweep at all: the new colour's sweeper owns every due row within one
  // tick, and nothing it refuses is ever counted against the lane.
  if (isRetiring()) {
    if (!retiringSweepLogged) {
      retiringSweepLogged = true;
      logger.info('coding schedule sweep: this process is RETIRING — schedule + hook sweeps handed to the new colour');
    }
    return;
  }
  try {
    const now = new Date();
    // Hourly GC of long-dead terminal rows (cancelled/expired) — they accumulate
    // forever otherwise and listSchedules' take:50 silently truncates live history.
    if (now.getTime() - lastGcAt > GC_INTERVAL_MS) {
      lastGcAt = now.getTime();
      await gcTerminalSchedules().catch(() => {});
    }
    const due = await prisma.chatSchedule.findMany({
      where: { enabled: true, nextRunAt: { lte: now } },
      orderBy: { nextRunAt: 'asc' },
      take: 10,
    });
    for (const s of due) {
      await processDueScheduleRow(s, now);
    }

    // Fleet supervisor (§3): deliver due hook events on the SAME tick. NOTE:
    // prod runs one of these sweepers PER WEB INSTANCE (blue + green), so
    // cross-process claim races are real — hooks.service handles them with an
    // atomic UPDATE…RETURNING claim + a Redis NX debounce gate (the 2026-08-12
    // duplicate-wake incident, PR #207). The worker process only emits via the
    // DB outbox. Sequential after schedule firing; isolated so a hook-sweep
    // failure can never break scheduling (sweepHookEvents never throws either).
    try {
      const mod: any = await import('../platform/hooks.service').catch(() => null);
      await mod?.sweepHookEvents?.();
    } catch (err: any) {
      logger.warn(`hook event sweep failed: ${err?.message}`);
    }
  } catch (err: any) {
    logger.warn(`coding schedule sweep error: ${err?.message}`);
  }
}

/** One due row as the sweeper reads it. */
type DueScheduleRow = Awaited<ReturnType<typeof prisma.chatSchedule.findMany>>[number];

/**
 * Outcome of one due-row pass — the sweep loop body, shared with the schedule
 * priority path's direct fire (fireDueScheduleNow).
 */
export type DueRowOutcome =
  | { outcome: 'started' }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'disabled'; reason: 'expired' | 'max_runs' | 'parked_dormant' }
  | { outcome: 'lost_claim' }
  | { outcome: 'error'; message: string };

/**
 * Process ONE due schedule row exactly as the 30 s sweep does: expiry / run-cap
 * retirement → ATOMIC claim (guarded on the row's current nextRunAt + runsCount,
 * so only one caller across blue/green/direct-fire wins) → dormancy gate → spend
 * cap → daily cap → delta gate → fire + bookkeeping. Every branch that used to
 * `continue` the sweep loop returns its outcome instead. Never throws for the
 * fire itself (that branch catches and stamps `error:*`); a pre-claim DB error
 * propagates to the caller like it did to the sweep's outer catch.
 */
/**
 * wake-cadence-2 / -3 (2026-09-27 tt-rd audit): CADENCE RECONCILIATION at
 * claim time — the one place nothing in the harness had: a comparison of a
 * recurring row's interval against what the lane actually does.
 *
 *   - NON-STOCK recurring rows (a lane's own monitor / self-schedule): the
 *     harness-measured ADAPTIVE STRETCH. Median duration of the last
 *     CADENCE_STRETCH_SAMPLE completed runs THIS schedule started (run
 *     input.scheduleId === the row — fixer 2026-09-27: never the session pool)
 *     (agent_runs startedAt/finishedAt; ≥3 samples or the median is unknown);
 *     when intervalSec < 1.5 × median, OR this firing was busy-parked ≥3
 *     times, OR the previous firing had to be steered into a running run, the
 *     cadence DOUBLES (ceiling SCHEDULE_ADAPTIVE_CADENCE_MAX_SEC, 6 h). Never
 *     shrinks. The tt-rd lane: owner set 30 min on 09-17 when runs took 3–12
 *     min; from 09-19 runs were 48–69 min median and every firing collided
 *     (1,357 busy-skips, then steer chains) for eight days. Machine-authored
 *     rows by default; owner rows only under SCHEDULE_ADAPTIVE_CADENCE_OWNER_ROWS=1.
 *   - STOCK PROJECT SWEEPS: adaptive BACKOFF. After 3 consecutive
 *     schedule-origin supervisor_noop rows (the attention watchdog's harness
 *     classification, never the model's claim) the sweep doubles up to
 *     PROJECT_SWEEP_MAX_INTERVAL_SEC (4 h); a supervisor_action / note row or
 *     an owner turn in the chat resets it to the default. sweep_triage /
 *     supervisor_turn_noop keep deciding WHICH tick to skip; the backoff
 *     changes the ROW so the gate stops being asked.
 *   - The fleet sweep and one-shots are untouched.
 *
 * Deterministic, cheap (≤3 indexed reads), fail-open: any read error returns
 * {} and the row keeps its cadence. The write rides the atomic claim below so
 * only the claim winner stretches; the metric + audit row are recorded after
 * the claim lands.
 */
/**
 * The newest firing ANSWERS (assistant rows) a schedule's runs persisted — the
 * block-streak scan input (todo 27c215d6). The run executor stamps
 * metadata.scheduleId on every row a schedule firing persists (partial +
 * final), so this scopes to THIS schedule's answers only; a firing that
 * produced no row (busy skip, cancelled) simply never matches, and a plain-chat
 * row without the stamp reads as no evidence (fail-open). Bounded by take.
 */
async function recentScheduleFiringAnswers(sessionId: string, scheduleId: string, take: number): Promise<string[]> {
  const rows = await prisma.crossModelMessage.findMany({
    where: { chatId: sessionId, role: 'assistant', metadata: { path: ['scheduleId'], equals: scheduleId } },
    orderBy: { createdAt: 'desc' },
    take: Math.max(1, Math.floor(take)),
    select: { content: true },
  });
  return (rows ?? []).map((r: any) => String(r?.content ?? ''));
}

export async function reconcileCadenceAtClaim(
  s: Pick<DueScheduleRow, 'id' | 'sessionId' | 'userId' | 'kind' | 'intervalSec' | 'prompt' | 'promptSetBy' | 'busySkips'>,
): Promise<{ intervalSec?: number; lastStatus?: string; stretch?: CadenceStretch | null; backoff?: SweepBackoff | null; blockStreak?: number; blockBackoff?: BlockStreakBackoff | null }> {
  if (s.kind !== 'recurring' || typeof s.intervalSec !== 'number' || !(s.intervalSec > 0)) return {};
  try {
    const sweepCls = classifySweepPrompt(s.prompt);
    if (sweepCls === 'fleet') return {};
    if (sweepCls === 'project') {
      const rows = await prisma.loopMetric.findMany({
        where: { sessionId: s.sessionId, kind: { in: [LOOP_METRIC_KINDS.SUPERVISOR_NOOP, LOOP_METRIC_KINDS.SUPERVISOR_ACTION, LOOP_METRIC_KINDS.SUPERVISOR_NOTE] } },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { kind: true, meta: true, createdAt: true },
      });
      const noteRows = (rows ?? []).map((r: any) => ({ kind: String(r.kind), origin: r?.meta?.origin ?? null, createdAt: r.createdAt as Date }));
      let ownerTurnSinceLastNote = false;
      const newestNoteAt = noteRows[0]?.createdAt ?? null;
      if (newestNoteAt) {
        const users = await prisma.crossModelMessage.findMany({
          where: { chatId: s.sessionId, role: 'user', createdAt: { gt: newestNoteAt } },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: { metadata: true },
        });
        ownerTurnSinceLastNote = (users ?? []).some((u: any) => !u?.metadata?.origin);
      }
      const backoff = sweepBackoffFor({
        intervalSec: s.intervalSec, defaultSec: STOCK_PROJECT_SWEEP_INTERVAL_SEC,
        noopStreak: scheduleNoopStreak(noteRows), ownerTurnSinceLastNote,
      });
      if (!backoff) return {};
      return { intervalSec: backoff.toSec, lastStatus: backoff.kind === 'backoff' ? `backoff:${backoff.noopStreak}` : 'backoff:reset', backoff };
    }
    const ownerRow = s.promptSetBy === 'user' || s.promptSetBy == null;
    if (ownerRow && !adaptiveCadenceOwnerRowsEnabled()) return {};
    const runs = await prisma.agentRun.findMany({
      where: { sessionId: s.sessionId, status: 'completed', startedAt: { not: null }, finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' },
      take: 12,
      select: { startedAt: true, finishedAt: true, input: true },
    });
    // fixer 2026-09-27: THIS schedule's runs only — the session-wide pool let a
    // fast poller sharing a session with a long-running schedule be stretched on
    // the OTHER row's run lengths.
    const durations = (runs ?? [])
      .filter((r: any) => String(r?.input?.scheduleId ?? '') === s.id && r.startedAt && r.finishedAt)
      .slice(0, CADENCE_STRETCH_SAMPLE)
      .map((r: any) => new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime());
    const medianRunMs = durations.length >= 3 ? medianMs(durations) : null;
    let previousFiringSteered = false;
    try { previousFiringSteered = !!(await redisClient.get(`cm:sched:steered:${s.id}`)); } catch { previousFiringSteered = false; }
    const stretch = cadenceStretchFor({ intervalSec: s.intervalSec, medianRunMs, busySkips: s.busySkips ?? 0, previousFiringSteered });
    // ── Open-ended block escalation (todo 27c215d6): the One Piece TCG
    //    prod-watch baseline — ~36 identical no-op checks over 4 days against
    //    the suspended AWS account, every one re-deriving "still blocked" at
    //    the full cadence. The chat's newest firing ANSWERS (assistant rows
    //    stamped with THIS schedule's id) are fingerprinted; BLOCK_STREAK_TRIGGER
    //    consecutive near-identical blocked-no-end-date answers back the
    //    CADENCE off (doubling, ceiling 24 h — never a pause: the harness
    //    never pauses a lane) and, opt-in, escalate ONCE to the owner. Kill
    //    switch BLOCK_STREAK_BACKOFF_DISABLED reverts the whole leg; the scan
    //    is best-effort fail-open (a read error leaves the cadence untouched).
    //    Owner rows follow the same doctrine as the stretch above (an
    //    owner-set cadence is never silently overridden) — the BACKOFF changes
    //    the interval, so owner rows are exempt unless opted in.
    let blockStreak: number | null = null;
    let blockBackoff: BlockStreakBackoff | null = null;
    const blockLegEligible = !blockStreakBackoffDisabled() && (s.promptSetBy === 'machine' || s.promptSetBy === 'system' || adaptiveCadenceOwnerRowsEnabled());
    if (blockLegEligible) {
      try {
        const answers = await recentScheduleFiringAnswers(s.sessionId, s.id, BLOCK_STREAK_SCAN);
        const streak = blockStreakCount(answers);
        if (streak >= BLOCK_STREAK_TRIGGER) {
          blockStreak = streak;
          blockBackoff = blockStreakBackoffFor({ intervalSec: s.intervalSec, streak });
        }
      } catch (err: any) {
        logger.warn(`coding schedule: block-streak scan for ${s.id} failed open (${err?.message ?? err}) — cadence unchanged`);
      }
    }
    // Both verdicts lengthen the row; the LARGER target lands (mergeCadenceInterval)
    // and ONLY the winner's verdict records telemetry — the loser is skipped
    // entirely (never shrunk). When the block leg wins, the stretch's telemetry
    // does not fire even if it would have: the written interval is the block
    // target, and a [SCHEDULE STATE] stretch line naming a smaller number
    // would mislead the lane about its own cadence.
    const winner = mergeCadenceInterval(stretch, blockBackoff);
    if (blockStreak == null && !winner) return {};
    if (stretch && winner === stretch) {
      return { intervalSec: stretch.toSec, lastStatus: cadenceStretchStatus(stretch), stretch, ...(blockStreak != null ? { blockStreak } : {}) };
    }
    if (!winner) return { blockStreak: blockStreak!, blockBackoff: null }; // streak ≥ trigger but the cadence is already at the ceiling
    return { intervalSec: winner.toSec, lastStatus: `blocked_streak:${blockStreak}`, blockStreak: blockStreak!, blockBackoff, stretch: null };
  } catch (err: any) {
    logger.warn(`coding schedule: cadence reconciliation for ${s.id} failed open (${err?.message ?? err}) — cadence unchanged`);
    return {};
  }
}

/** The audit + telemetry row a landed cadence change writes (claim winner only). */
async function recordCadenceChange(s: Pick<DueScheduleRow, 'id' | 'sessionId' | 'userId' | 'promptSetBy'>, cadence: Awaited<ReturnType<typeof reconcileCadenceAtClaim>>): Promise<void> {  try {
    if (cadence.stretch) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.SCHEDULE_CADENCE_STRETCHED, sessionId: s.sessionId,
        meta: { scheduleId: s.id, medianRunMin: cadence.stretch.medianRunMin, from: cadence.stretch.fromSec, to: cadence.stretch.toSec, reason: cadence.stretch.reason, promptSetBy: s.promptSetBy ?? null },
      });
      logger.info(`coding schedule: ${s.id} cadence STRETCHED ${Math.round(cadence.stretch.fromSec / 60)}→${Math.round(cadence.stretch.toSec / 60)} min (${cadence.stretch.reason}${cadence.stretch.medianRunMin != null ? `, median run ${cadence.stretch.medianRunMin} min` : ''}) — wake-cadence-2`);
      await prisma.activity.create({
        data: { userId: s.userId, action: 'schedule.update', resource: 'platform', metadata: { scheduleId: s.id, chatId: s.sessionId, fields: ['intervalSec'], source: 'cadence-stretch', from: cadence.stretch.fromSec, to: cadence.stretch.toSec, reason: cadence.stretch.reason, medianRunMin: cadence.stretch.medianRunMin } },
      }).catch(() => {});
    }
    if (cadence.backoff) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.SWEEP_BACKOFF, sessionId: s.sessionId,
        meta: { chatId: s.sessionId, scheduleId: s.id, from: cadence.backoff.fromSec, to: cadence.backoff.toSec, noopStreak: cadence.backoff.noopStreak, kind: cadence.backoff.kind },
      });
      logger.info(`coding schedule: stock project sweep ${s.id} ${cadence.backoff.kind === 'backoff' ? 'BACKED OFF' : 'RESET'} ${Math.round(cadence.backoff.fromSec / 60)}→${Math.round(cadence.backoff.toSec / 60)} min (schedule-origin no-op streak ${cadence.backoff.noopStreak}) — wake-cadence-3`);
      await prisma.activity.create({
        data: { userId: s.userId, action: 'schedule.update', resource: 'platform', metadata: { scheduleId: s.id, chatId: s.sessionId, fields: ['intervalSec'], source: 'project-sweep-backoff', from: cadence.backoff.fromSec, to: cadence.backoff.toSec, noopStreak: cadence.backoff.noopStreak, kind: cadence.backoff.kind } },
      }).catch(() => {});
    }
    // ── todo 27c215d6: the block-streak leg. OBSERVED is the observe-first
    // metric — it fires at EVERY claim the streak ≥ trigger (before the
    // backoff verdict), so the 7-day baseline exists even while the cadence
    // already sits at the ceiling and no further backoff can land. The card
    // is the OPT-IN escalate-once rung (BLOCK_STREAK_CARDS_ENABLED=1).
    if (cadence.blockStreak != null) {
      let escalatedCard = false;
      if (blockStreakCardsEnabled() && cadence.blockBackoff) {
        escalatedCard = await maybeFileBlockStreakCard(s, cadence.blockStreak, cadence.blockBackoff).catch(() => false);
      }
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.BLOCK_STREAK_OBSERVED, sessionId: s.sessionId,
        meta: { scheduleId: s.id, chatId: s.sessionId, streak: cadence.blockStreak, trigger: BLOCK_STREAK_TRIGGER, escalatedCard },
      });
    }
    if (cadence.blockBackoff) {
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.BLOCK_STREAK_BACKOFF, sessionId: s.sessionId,
        meta: { scheduleId: s.id, chatId: s.sessionId, from: cadence.blockBackoff.fromSec, to: cadence.blockBackoff.toSec, streak: cadence.blockBackoff.streak },
      });
      logger.info(`coding schedule: ${s.id} BLOCK-STREAK backoff ${Math.round(cadence.blockBackoff.fromSec / 60)}→${Math.round(cadence.blockBackoff.toSec / 60)} min (${cadence.blockBackoff.streak} consecutive near-identical blocked-no-end-date firing answers) — todo 27c215d6`);
      await prisma.activity.create({
        data: { userId: s.userId, action: 'schedule.update', resource: 'platform', metadata: { scheduleId: s.id, chatId: s.sessionId, fields: ['intervalSec'], source: 'block-streak-backoff', from: cadence.blockBackoff.fromSec, to: cadence.blockBackoff.toSec, streak: cadence.blockBackoff.streak } },
      }).catch(() => {});
    }
  } catch { /* telemetry never blocks a firing */ }
}

/**
 * todo 27c215d6 — the OPT-IN escalate-once rung (BLOCK_STREAK_CARDS_ENABLED=1, default
 * OFF: the STOPPED_SCHEDULE_CARDS observe-first pattern — sibling escalation
 * cards ship dark until measured). ONE card per schedule per 30 days, NX-gated
 * in Redis against races/repeats (the notifyScheduleTerminalOnce shape);
 * flagOwnerQuestion's exact-question dedupe backstops. Never pauses the row —
 * the cadence backoff already landed. Best-effort: never breaks the firing.
 */
async function maybeFileBlockStreakCard(s: Pick<DueScheduleRow, 'id' | 'sessionId' | 'userId'>, streak: number, backoff: BlockStreakBackoff): Promise<boolean> {
  const TTL_SEC = 30 * 24 * 3600;
  const key = `cm:sched:blockstreak-card:${s.id}`;
  const claimed = await redisClient.set(key, new Date().toISOString(), { NX: true, EX: TTL_SEC }).catch(() => null);
  if (claimed !== 'OK') return false; // already escalated within the window
  try {
    const { flagOwnerQuestion } = await import('../platform/owner-questions');
    const res = await flagOwnerQuestion({
      chatId: s.sessionId, userId: s.userId, machineTriggered: true,
      // A per-event card (this streak): an earlier owner ruling annotates it, never refuses it.
      harnessEventAt: new Date(),
      question: `Schedule ${s.id.slice(0, 8)} has reported the SAME unresolved blocker ${streak} firings in a row — keep waiting, or change something?`,
      context:
        `This recurring monitor's last ${streak} firing answers are near-identical "still blocked, no end date" reports. ` +
        `The harness has already backed its cadence off ${Math.round(backoff.fromSec / 60)}→${Math.round(backoff.toSec / 60)} min (ceiling 24 h — one check a day is enough for an open-ended block) instead of letting it re-report at full cadence; the row keeps running. ` +
        `Options: keep waiting (the schedule stays backed off and keeps checking), change the schedule (update_schedule — a longer cadence, a different probe), or stop it (cancel_schedule — the blocker has no end date and the check is no longer useful). ` +
        `This card files at most once per 30 days per schedule.`,
      options: [
        { id: 'keep_waiting', label: 'Keep waiting (stay backed off)', consequence: 'the monitor keeps checking at the backed-off cadence' },
        { id: 'retime', label: 'I will retime / rewrite it myself', consequence: 'the owner adjusts the schedule from the chat' },
        { id: 'stop', label: 'Stop the schedule', consequence: 'the row is cancelled — no more checks' },
      ],
    });
    return res.kind === 'created';
  } catch (err: any) {
    // Claim-then-fail must not silence the ONLY card for 30 days: reopen the
    // gate so the next claim retries (the required-probes pattern above).
    await redisClient.del(key).catch(() => {});
    logger.warn(`coding schedule: block-streak card for ${s.id} failed (${err?.message ?? err}) — gate reopened`);
    return false;
  }
}

async function processDueScheduleRow(s: DueScheduleRow, now: Date): Promise<DueRowOutcome> {
  // Expiry / run-cap: disable instead of firing.
  if ((s.expiresAt && s.expiresAt.getTime() <= now.getTime()) || (s.maxRuns != null && s.runsCount >= s.maxRuns)) {
    const isRunCap = s.maxRuns != null && s.runsCount >= s.maxRuns;
    // renewOnExhaustion (v1#14): a RUN-CAP exhaustion arms the successor
    // BEFORE BOTH the disable write and the disable event, so
    // schedule_disabled carries successorId (⇒ not alarm-class) and the
    // lane never goes deaf. Crash-window fix (shortfall hunt f24): arming
    // AFTER the disable left a gap — a hard process death (routine
    // blue-green deploy kill) between the two writes stranded the lane
    // PERMANENTLY deaf: the sweep only reads enabled:true rows, so the
    // row was never revisited, and every backstop (disable event, owner
    // notice, stopped-schedule alert) queued after the renewal inside the
    // same lost window. Renewal FIRST closes the window — the successor
    // (or its existing DB-UNIQUE renewedFromId key) is durable BEFORE the
    // lane's only enabled row goes dark. maybeRenewOnExhaustion reads no
    // runsCount and excludes the exhausted row from its own dupe scan
    // (r.id !== s.id — defense-in-depth for exactly this pre-disable
    // arrival), so the reorder changes no verdict, only the survival
    // order; a crash after the renewal but before the disable simply
    // re-runs THIS branch next tick (idempotent) and completes the stop.
    // Lifetime expiry deliberately does NOT renew — sliding expiry means
    // only an abandoned, never-firing lane reaches it.
    const renewOut: RenewRefusal = {};
    const successorId = isRunCap ? await maybeRenewOnExhaustion(s, renewOut) : null;
    await prisma.chatSchedule.update({ where: { id: s.id }, data: { enabled: false, lastStatus: 'expired', disabledAt: now } }).catch(() => {});
    // Owner-visible: an auto-disabled schedule must never die silently
    // (feedback dd0d37ac) — one notice per row, NX-gated. A governor refusal
    // (finding B2) names its reason in the same note.
    const why = isRunCap
      ? `hit its ${s.maxRuns}-run cap (${s.runsCount} runs)${!successorId && renewOut.reason ? `; auto-renew refused — ${renewOut.reason}` : ''}`
      : 'reached its lifetime expiry';
    if (successorId) {
      await notifyScheduleTerminalOnce(s, `${why}; a same-cadence successor schedule ${successorId} is already armed (renewOnExhaustion), so this loop continues`).catch(() => {});
    } else {
      await notifyScheduleTerminalOnce(s, why).catch(() => {});
    }
    // Supervisor-visible: cadence self-noticing (forensics fix 2).
    await emitScheduleDisabled(s, isRunCap ? 'max_runs' : 'expired', s.runsCount,
      successorId ? { successorId } : (renewOut.reason ? { detail: `auto-renew refused — ${renewOut.reason}` } : undefined));
    // Owner-decision fast lane (SA0906): delayed lane-liveness re-check —
    // skipped when a successor is armed (the lane is provably alive; the
    // re-check would only re-derive that).
    if (!successorId) await queueStoppedScheduleAlertSafe(s.id, isRunCap ? 'max_runs' : 'expired');
    return { outcome: 'disabled', reason: isRunCap ? 'max_runs' : 'expired' };
  }

  // Near-cap pre-emptive alert (ticket b4d1096c): ONE schedule_near_cap hook
  // event per schedule row, stamped + emitted when a recurring row first
  // crosses ≥90% of its run cap or enters the last 10% of its lifetime
  // window — BEFORE the gap opens (the post-death schedule_disabled was the
  // only signal; a watched lane could sit deaf a full sweep interval). Runs
  // pre-claim so EVERY due processing sees it (firing, delta-skipped, and
  // busy rows alike), and so an existing row already past threshold alerts
  // once on its first post-deploy processing. The guarded nearCapAlertedAt
  // stamp is the dedupe across repeat processings, busy re-arms and racing
  // blue/green sweepers (the race loser's count is 0). Best-effort: never
  // breaks the firing it precedes.
  if (s.kind === 'recurring' && (s as any).nearCapAlertedAt == null) {
    const nearCause = scheduleNearCapCause(s, now);
    if (nearCause) {
      const stamp = await prisma.chatSchedule.updateMany({
        where: { id: s.id, nearCapAlertedAt: null },
        data: { nearCapAlertedAt: now },
      }).catch(() => ({ count: 0 }));
      if (stamp.count === 1) await emitScheduleNearCap(s, nearCause).catch(() => {});
    }
  }

  // ATOMIC claim: advance nextRunAt (crash-safe: never hot-loops) guarded on the
  // row's CURRENT nextRunAt+runsCount, so only ONE sweeper across all blue/green
  // instances wins this tick. runsCount is NOT bumped here — only a real started
  // run consumes the budget (a busy/error skip must not burn maxRuns).
  // lastFiredAt is NOT stamped here either (P3 pin 14a): a cap/busy SKIP used to
  // read as a firing, so heartbeat surfaces (cadence-stopped scan, digest
  // isStoppedCadence, list views) saw a "recently fired" lane that had in fact
  // produced nothing for days. Only the actual-start branch below stamps it.
  // wake-cadence-2 / -3: cadence reconciliation rides the claim — the NEW
  // interval decides this claim's nextRunAt and lands in the same atomic write.
  const cadence = await reconcileCadenceAtClaim(s);
  const claimIntervalSec = cadence.intervalSec ?? s.intervalSec ?? MIN_INTERVAL_SEC;
  const nextRunAt = new Date(now.getTime() + claimIntervalSec * 1000);
  const claim = await prisma.chatSchedule.updateMany({
    where: { id: s.id, enabled: true, nextRunAt: s.nextRunAt, runsCount: s.runsCount },
    data: { nextRunAt, ...(cadence.intervalSec != null ? { intervalSec: cadence.intervalSec } : {}), ...(cadence.lastStatus ? { lastStatus: cadence.lastStatus } : {}) },
  }).catch(() => ({ count: 0 }));
  if (claim.count !== 1) return { outcome: 'lost_claim' }; // another instance claimed it
  if (cadence.intervalSec != null) (s as any).intervalSec = cadence.intervalSec;
  // todo 27c215d6: the block-streak OBSERVED metric (+ opt-in card) fire even
  // when the cadence is already at the 24 h ceiling — no intervalSec change
  // lands there, but every claim the streak ≥ trigger still records one row,
  // so the 7-day baseline accrues regardless of the backoff verdict.
  if (cadence.intervalSec != null || cadence.blockStreak != null) {
    await recordCadenceChange(s, cadence);
    // fixer 2026-09-27 (the ratchet finding): a LANDED stretch CONSUMES the
    // "previous firing was steered" marker — whatever reason won — so one steer
    // buys exactly one doubling. Before this the marker lived until the next
    // real start while every intervening claim (steer_duplicate skips, busy
    // re-arms) re-read it and doubled again (30 → 60 → 120 → 240 min inside
    // one 135-min run). Best-effort: a failed DEL is bounded by the real-start
    // delete below.
    if (cadence.stretch && s.kind === 'recurring') {
      await redisClient.del(`cm:sched:steered:${s.id}`).catch(() => {});
    }
  }

  // SUPERVISOR OFF SWITCH (owner 2026-09-26; platform/supervisor-switch.ts):
  // a firing on a Fleet / project supervisor chat whose admin switch is OFF
  // is SKIPPED here — after the claim (only the claiming instance stamps)
  // and BEFORE the dormancy gate, spend/daily caps and the sweep pre-triage
  // (so no cap token is reserved, no decision is bought and the heartbeat
  // floor never fires). The claim already slid a recurring row's nextRunAt
  // by one interval (the cadence slides, runsCount untouched); a `once` row
  // re-arms SUPERVISOR_SWITCH_ONCE_REARM_MS out so the supervisor's own
  // deferred check fires once it is back on. Steady state all-ON costs no
  // query (supervisorWakeSkipById reads the chat flags only when a switch is
  // off). Fail-open: any gate error fires as before.
  const supervisorOff = await supervisorWakeSkipById(s.sessionId, 'schedule');
  if (supervisorOff) {
    await prisma.chatSchedule.update({
      where: { id: s.id },
      data: {
        lastStatus: SUPERVISOR_SWITCH_SKIPPED_STATUS,
        ...(s.kind === 'once' ? { nextRunAt: new Date(now.getTime() + SUPERVISOR_SWITCH_ONCE_REARM_MS) } : {}),
      },
    }).catch(() => {});
    logger.info(`coding schedule: ${s.id} skipped (${SUPERVISOR_SWITCH_SKIP_REASON}) — the ${supervisorOff} supervisor switch is OFF; cadence slides, no run`);
    return { outcome: 'skipped', reason: SUPERVISOR_SWITCH_SKIP_REASON };
  }

  // Goal-gate (ticket b1d435fd, owner directive 2026-09-18): a RECURRING
  // wake whose project is DORMANT — no active/blocked goals, no open
  // todos, no live/queued runs, no live watched-resource registrations —
  // may not STAY ACTIVE: auto-park it (enabled:false, lastStatus
  // 'parked:dormant') instead of burning a run on a zero-work heartbeat.
  // Owner-authored rows (promptSetBy 'user'/NULL) are explicit owner
  // instruction and never gated; one-shots are out of scope. Placed after
  // the claim (only the claiming instance parks) and before the caps (a
  // parked row burns no daily token, no run, no spend check). The
  // predicate fails open — an evaluation error lets the firing proceed.
  //
  // One-shot CHAIN (finding B1, 2026-09-27): a `once` row that is link ≥3 of
  // a self-re-arming chain in 24h is governed as a recurring cadence — the
  // dormancy predicate is evaluated for it here (the arm-time gate is moot:
  // the arming run is itself live work), and fireScheduleTarget skips
  // queue-behind-busy for it (busy re-arm + busySkips accounting instead).
  // OBSERVE-ONLY: a dormant verdict on a chain link records
  // `would_park_dormant` and the link FIRES — a parked `once` row would have
  // no automatic way back (the recurring re-arm paths are recurring-only), so
  // a park would be a hard stop on a lane's own deferred work. Note the
  // predicate ALWAYS sees the
  // arming run finished at a link's fire time (liveRuns counts running |
  // queued), so on a goal-less / todo-less project every link ≥3 reads
  // dormant. The walk is one indexed read, only for rows carrying
  // chainedFromScheduleId; fail-open.
  let onceChainRecurringLike = false;
  if (s.kind === 'once' && (s as any).chainedFromScheduleId) {
    try {
      const chain = await evaluateDueOnceChain(s as any, now);
      onceChainRecurringLike = chain.recurringLike;
    } catch (err: any) {
      logger.warn(`coding schedule: once-chain walk errored for ${s.id} (fail-open — plain one-shot): ${err?.message ?? err}`);
    }
  }
  if (s.kind === 'recurring' || onceChainRecurringLike) {
    try {
      const dormancy = await evaluateScheduleDormancy(s.sessionId, s.promptSetBy);
      if (dormancy.dormant && onceChainRecurringLike) {
        // Observed, never parked: the metric + a log line are the whole effect.
        recordLoopMetric({ kind: LOOP_METRIC_KINDS.SCHEDULE_ONCE_CHAIN, sessionId: s.sessionId, meta: { scheduleId: s.id, chainedFrom: (s as any).chainedFromScheduleId ?? null, outcome: 'would_park_dormant', guardDisabled: false, reason: dormancy.reason } });
        logger.info(`coding schedule: ${s.id} is a recurring-like one-shot chain link on a dormant project — would park a recurring row; firing (observe-only, finding B1): ${dormancy.reason}`);
      } else if (dormancy.dormant) {
        // 37fa747d: emit + notify + report 'disabled' ONLY when the park write
        // landed — a failed write keeps the row enabled (the claim above
        // already advanced nextRunAt, so nothing fires now) and the next due
        // processing re-attempts the park; announcing a park that never
        // landed (ALARM-class event, owner notice) is a lie.
        let parkedOk = false;
        try {
          await prisma.chatSchedule.update({
            where: { id: s.id },
            data: { enabled: false, lastStatus: DORMANT_LAST_STATUS, cancelledBy: 'machine', disabledAt: now },
          });
          parkedOk = true;
        } catch (parkErr: any) {
          logger.warn(`coding schedule: ${s.id} dormancy park WRITE failed (row stays enabled; retried next due pass): ${parkErr?.message ?? parkErr}`);
        }
        if (parkedOk) {
          logger.warn(`coding schedule: ${s.id} auto-parked (goal-gate) — ${dormancy.reason}`);
          await emitScheduleDisabled(s, 'parked_dormant', s.runsCount, { detail: dormancy.reason }).catch(() => {});
          await notifyDormancyParkOnce(s, dormancy.reason).catch(() => {});
          return { outcome: 'disabled', reason: 'parked_dormant' };
        }
        return { outcome: 'error', message: 'dormancy park write failed — row stays enabled, retried next due pass' };
      }
    } catch (err: any) {
      logger.warn(`coding schedule: dormancy gate errored for ${s.id} (fail-open — firing proceeds): ${err?.message ?? err}`);
    }
  }

  // One sweep per supervisor chat (audit 2026-10-06 T4-8): a stock sweep
  // firing retires the chat's other machine/system sweep-shaped recurring
  // rows (best-effort; never changes this firing).
  if (s.kind === 'recurring' && classifySweepPrompt(s.prompt)) await foldDuplicateSweepsAtFire(s);

  // Spend cap (remediation P7 N7/S1a; owner directive 2026-09-27 "no hidden
  // cost caps"): the PROJECT's trailing-24h run spend over the USER-SET
  // ProjectSettings.spendCapUsdPerDay ⇒ skip this firing. That project cap is
  // the ONLY cost cap in the framework (no chat row, env default or fleet
  // budget). Checked BEFORE the daily-cap INCR so a spend skip never burns a
  // firing token. DEFAULT OFF (no project cap = no check fires); kill-switch
  // SPEND_CAP_DISABLED=1; every failure fails OPEN (the firing proceeds).
  try {
    const { checkSpendCap, recordSpendCapSkip, maybeAskSpendCapQuestion } = await import('./spend-cap.service');
    const spendVerdict = await checkSpendCap(s.sessionId);
    if (spendVerdict) {
      await prisma.chatSchedule.update({ where: { id: s.id }, data: { lastStatus: 'skipped:spend_cap' } }).catch(() => {});
      await recordSpendCapSkip(s.sessionId); // the chat's next run learns WHY it went quiet (P3 notice channel, spend flavor)
      logger.warn(`coding schedule: ${s.id} skipped — trailing-24h spend $${spendVerdict.spentUsd} over the ${spendVerdict.scope} cap $${spendVerdict.capUsd}/day`);
      // Same per-window dedupe as the daily-cap skip (feedback a30b6ad9):
      // a spend-capped chat re-skips every interval until trailing-24h spend
      // drops — one supervisor wake per 24h flat window is enough.
      if (await claimCapWindowGate(s.sessionId, 'spend', CAP_EVENT_GATE_FALLBACK_TTL_SEC)) {
        await emitHookEventSafe(
          s.sessionId, 'schedule_cap_skipped',
          `Schedule ${s.id} skipped: trailing-24h spend $${spendVerdict.spentUsd} is over the ${spendVerdict.scope} spend cap ($${spendVerdict.capUsd}/day) (further identical skips are muted for 24h)`,
          { scheduleId: s.id, kind: 'spend', scope: spendVerdict.scope, capUsd: spendVerdict.capUsd, spentUsd: spendVerdict.spentUsd },
        );
      }
      // ONE owner decision card per chat per 7d: raise the cap or keep it.
      await maybeAskSpendCapQuestion(s.sessionId, s.userId, spendVerdict);
      return { outcome: 'skipped', reason: 'spend_cap' };
    }
  } catch (err: any) {
    logger.warn(`coding schedule: spend-cap check errored for ${s.id} (fail-open — firing proceeds): ${err?.message ?? err}`);
  }

  // Aggregate daily runaway cap (independent of per-row renewal). The cap is
  // per-chat (ChatAutonomy.scheduleCap ?? 48) — see dailyCapExceeded.
  const exceededCap = await dailyCapExceeded(s.sessionId);
  if (exceededCap !== null) {
    await prisma.chatSchedule.update({ where: { id: s.id }, data: { lastStatus: 'skipped:daily_cap' } }).catch(() => {});
    await recordCapSkip(s.sessionId); // the session's next run learns its firing was skipped
    logger.warn(`coding schedule: ${s.id} hit the ${exceededCap}/day session cap — skipping`);
    // Fleet supervisor: let a supervisor chat react (slice B delivers).
    // Deduped to ONE event per chat per cap window (feedback a30b6ad9) —
    // every later identical skip this window is zero-information wake spam.
    if (await claimCapWindowGate(s.sessionId, 'daily')) {
      await emitHookEventSafe(s.sessionId, 'schedule_cap_skipped', `Schedule ${s.id} skipped: hit the ${exceededCap}/day firing cap (further identical skips are muted until the window resets)`, { scheduleId: s.id, cap: exceededCap });
    }
    // Owner visibility: one user-visible notice per cap window in the target chat.
    await notifyDailyCapOnce(s.sessionId, exceededCap).catch(() => {});
    return { outcome: 'skipped', reason: 'daily_cap' };
  }

  // Delta gate (ticket 0b1dbe75): a recurring schedule may arm cheap
  // platform-side https probes — {probes:[{url,headers?,jsonPath?|pattern?}],
  // heartbeatHours?} — evaluated HERE, after the caps and before the fire.
  // When every probe's observed value still equals its stored marker the
  // model run is SKIPPED (lastStatus 'skipped:delta_unchanged'; runsCount/
  // lastFiredAt untouched — the atomic claim already slid nextRunAt, so the
  // cadence slides and no run/maxRuns budget is consumed; the speculative
  // daily-cap token is REFUNDED like the busy/error paths below, 94bb9c2f).
  // A first evaluation (baseline), any delta, a probe error (FAIL-OPEN — a
  // gate failure must never silence a schedule), or an overdue heartbeat
  // fires normally. Fresh markers persist ONLY when the run actually starts
  // (review: a pre-fire persist let a busy lane's +3-min re-arm read the new
  // marker as "unchanged" and silently drop the wake) — the started branch
  // below writes them under the same optimistic Json-equals guard, so a
  // concurrent update_schedule replacement wins and a crash just re-fires
  // the delta next tick (fail-open).
  let deltaFireGate: { original: unknown; updated: DeltaGate } | null = null;
  // WI-C (2026-09-25): a shadow delta_material decision that FIRES is no longer
  // closed with actual:null here — its stash rides the fired run and the
  // finalize labels it from what the run did (decision-outcome-labels.ts).
  let deltaDecision: DecisionStash | null = null;
  if (s.kind === 'recurring' && (s as any).deltaGate != null) {
    try {
      const gate = parseStoredDeltaGate((s as any).deltaGate);
      if (!gate) {
        logger.warn(`coding schedule: ${s.id} has an unreadable deltaGate (fail-open — firing proceeds)`);
      } else {
        const verdict = await evaluateDeltaGate(gate, { now, lastFiredAt: s.lastFiredAt });
        if (!verdict.fire) {
          // SKIP: stamp the skip + advance checkedAt (the optimistic
          // Json-equals guard lets a concurrent gate replacement win —
          // lastStatus still stamps either way).
          const skipWrite = await prisma.chatSchedule.updateMany({
            where: { id: s.id, deltaGate: { equals: (s as any).deltaGate } },
            data: { lastStatus: 'skipped:delta_unchanged', deltaGate: verdict.gate as any },
          }).catch(() => ({ count: 0 }));
          if (skipWrite.count === 0) {
            await prisma.chatSchedule.update({ where: { id: s.id }, data: { lastStatus: 'skipped:delta_unchanged' } }).catch(() => {});
          }
          // dailyCapExceeded reserved its token INCR-first; a delta skip
          // started no run, so refund it exactly like the busy/error paths
          // below — otherwise pure skips drain the chat's daily cap.
          await refundDailyCapToken(s.sessionId);
          logger.info(`coding schedule: ${s.id} skipped (delta_unchanged) — ${gate.probes.length} probe(s) unchanged`);
          // Dead-source alarm (FO firing 9): an unchanged read PROVED the
          // probe source answers — clear any error streak so a recovered
          // source never alarms and a re-dying one re-alarms.
          await resetDeltaGateErrorStreak(s.id);
          return { outcome: 'skipped', reason: 'delta_unchanged' };
        }
        // DECISION GATE — DELTA MATERIALITY (2026-09-24): a probe DID change,
        // but is the change the kind of event this lane waits for, or noise
        // (a timestamp, a counter, a rotating id)? SHADOW records; ACT skips
        // a confidently immaterial delta exactly like an unchanged one
        // (markers persisted so the same churn is not re-judged next tick;
        // the heartbeat floor still fires). Fail-open to firing.
        if (verdict.reason === 'delta') {
          const dmode = decisionMode('delta_material');
          if (dmode !== 'off') {
            try {
              // E5 (2026-09-25): the state gains the eval doc's "last run
              // one-line outcome" — what the PREVIOUS delta-gated firing of
              // this lane measurably did (its labelled outcome row), so the
              // gate can tell a status flip the lane acted on from churn it
              // only noted. Harness-derived, fail-open (absent on any error).
              const lastRunOutcome = await deltaMaterialLastRunOutcome(s, now);
              const gateAnswer = await decide(
                {
                  schedule_prompt: String((s as any).prompt || '').slice(0, 2500),
                  watched_change: String(verdict.detail || '').slice(0, 1500),
                  ...(lastRunOutcome ? { last_run_outcome: lastRunOutcome } : {}),
                },
                {
                  material: {
                    type: 'noul',
                    instructions: 'The watched value changed in a way that matters for what this schedule exists to do — the scheduled run would have real work to act on now.',
                    criteria: {
                      true: 'the change is the kind of event the schedule waits for (a status flip, a new result, a finished job, a new version or release, a failure)',
                      false: 'the change is cosmetic or noise (a timestamp, a counter, a rotating id, whitespace, unrelated churn) that the run would only note and ignore',
                    },
                  },
                },
                { purpose: 'delta_material', timeoutMs: 4000, sessionId: s.sessionId },
              );
              if (gateAnswer) {
                const p = (gateAnswer.answers.material as { noul: number }).noul;
                const threshold = decisionThreshold('delta_material', 0.85);
                // E2 (2026-09-25): the RESULT's mode gates acting (an uncalibrated backend answers as 'shadow').
                if (gateAnswer.mode === 'act' && p <= 1 - threshold) {
                  const skipWrite = await prisma.chatSchedule.updateMany({
                    where: { id: s.id, deltaGate: { equals: (s as any).deltaGate } },
                    data: { lastStatus: 'skipped:delta_immaterial', deltaGate: verdict.gate as any },
                  }).catch(() => ({ count: 0 }));
                  if (skipWrite.count === 0) {
                    await prisma.chatSchedule.update({ where: { id: s.id }, data: { lastStatus: 'skipped:delta_immaterial' } }).catch(() => {});
                  }
                  await refundDailyCapToken(s.sessionId);
                  recordDecisionOutcome(gateAnswer, 'delta_material', { question: 'material', actual: null, acted: true, sessionId: s.sessionId, note: (verdict.detail || '').slice(0, 120) });
                  logger.info(`coding schedule: ${s.id} skipped (delta_immaterial) — decision gate judged the change immaterial (material ${p.toFixed(2)}): ${(verdict.detail || '').slice(0, 120)}`);
                  await resetDeltaGateErrorStreak(s.id);
                  return { outcome: 'skipped', reason: 'delta_immaterial' };
                }
                deltaDecision = stashDecision(gateAnswer, 'delta_material');
              }
            } catch (err: any) {
              logger.warn(`coding schedule: ${s.id} delta materiality gate failed open (${err?.message || err}) — firing`);
            }
          }
        }
        if (verdict.markersChanged) deltaFireGate = { original: (s as any).deltaGate, updated: verdict.gate };
        if (verdict.reason === 'error') {
          // Dead-source alarm (FO firing 9): count CONSECUTIVE error verdicts
          // (a thrown evaluation fails open in the catch below and does NOT
          // count — only a real probe failure streak is a dead source).
          await recordDeltaGateErrorStreak(s.id, s.sessionId, verdict.detail ?? '');
        } else {
          // baseline / delta / heartbeat all evaluated the probes cleanly.
          await resetDeltaGateErrorStreak(s.id);
        }
        logger.info(`coding schedule: ${s.id} delta gate → fire (${verdict.reason}${verdict.detail ? ` — ${verdict.detail}` : ''})`);
      }
    } catch (err: any) {
      logger.warn(`coding schedule: delta gate errored for ${s.id} (fail-open — firing proceeds): ${err?.message ?? err}`);
    }
  }

  // DECISION GATE — SWEEP PRE-TRIAGE (N2, 2026-09-25; platform/sweep-triage.ts):
  // a stock fleet/project SWEEP firing is judged over a CODE-COMPUTED delta
  // since the previous sweep. SHADOW (default): the firing is unchanged and the
  // stash rides the run like delta_material's does. ACT (designed, not enabled):
  // a confidently quiet sweep is skipped exactly like a delta skip (lastStatus
  // 'skipped:sweep_quiet:<n>', cap token refunded, no run/maxRuns budget), with
  // a heartbeat floor inside the leaf. A delta-gated row is never re-judged
  // here (one stash per firing). Fail-open to firing.
  let sweepDecision: DecisionStash | null = null;
  // agent-decisions 2026-09-27: once supervisor_turn_noop is in ACT it REPLACES
  // sweep_triage at this site (one act consumer per firing); while it is shadow
  // both are asked and both stashes ride the run (DecisionStash.also).
  const turnNoopGoverns = supervisorTurnNoopActive();
  const askSweepTriage = !deltaDecision && s.kind === 'recurring' && !turnNoopGoverns;
  // DECISION GATE — SUPERVISOR TURN PRE-TRIAGE (agent-decisions 2026-09-27;
  // platform/supervisor-turn-noop.ts, sweep origin): a stock fleet/project
  // SWEEP firing is judged over the TARGET's own record (7-day no-op / action
  // rates, consecutive no-ops, last action, last notes, board counts) + the
  // hook events still pending for it. SHADOW (default): the firing is
  // unchanged and the stash rides the run as a SIBLING of the sweep stash.
  // ACT (designed, admitted by the readiness ruler only): a confidently quiet
  // turn with no new input / alarm / cap bypass is skipped exactly like a
  // sweep_triage skip (lastStatus 'skipped:turn_noop:<n>', cap token refunded,
  // wake_parked reason 'turn_noop'), bounded by the heartbeat floor inside the
  // leaf. Fail-open to firing.
  // Fixer 2026-09-27: asked CONCURRENTLY with the sweep triage under the
  // sibling's wall clock (facts 1.5 s + decide 4 s inside snapshot 8 s + decide
  // 4 s) — the shadow ask adds no serial latency to the 30 s sweeper tick, and
  // its two pending-input queries run only when the purpose is consulted at all.
  const askTurnNoop = !deltaDecision && s.kind === 'recurring' && !!classifySweepPrompt(s.prompt) && supervisorTurnNoopConsulted();
  let turnNoopStash: DecisionStash | null = null;
  // MATERIAL-CHANGE GATE (audit 2026-10-08 W6-2; platform/supervisor-wake-ledger.ts):
  // a stock SWEEP firing on a supervisor chat is skipped when nothing material
  // happened since the supervisor's last completed wake (heartbeat floor of N h;
  // a lane idle while holding in-progress work is material for a sweep). Asked
  // CONCURRENTLY with the Jev asks above (they run shadow beside it — capped
  // while it acts); fail-open to firing. Kill switch SUPERVISOR_MATERIAL_GATE_DISABLED=1.
  const askMaterialGate = s.kind === 'recurring' && !!classifySweepPrompt(s.prompt);
  const [sweepTriage, turnTriage, materialGate] = await Promise.all([
    askSweepTriage
      ? Promise.resolve()
          .then(() => preTriageSweepFiring(
            { id: s.id, sessionId: s.sessionId, prompt: s.prompt, lastFiredAt: s.lastFiredAt, intervalSec: s.intervalSec, lastStatus: s.lastStatus },
            now,
          ))
          .catch((err: any) => { logger.warn(`coding schedule: ${s.id} sweep pre-triage failed open (${err?.message ?? err}) — firing`); return null; })
      : Promise.resolve(null),
    askTurnNoop
      ? Promise.resolve()
          .then(() => loadSweepPendingInputs(s.sessionId))
          .then((pending: TurnNoopPendingInput[]) => preTriageSupervisorTurn({ origin: 'sweep', chatId: s.sessionId, pending, consecutiveSkips: consecutiveTurnNoopSkips(s.lastStatus), now }))
          .catch((err: any) => { logger.warn(`coding schedule: ${s.id} supervisor turn pre-triage failed open (${err?.message ?? err}) — firing`); return null; })
      : Promise.resolve(null),
    askMaterialGate
      ? materialGateForSweep({ chatId: s.sessionId }).catch((): MaterialGateResult | null => null)
      : Promise.resolve(null as MaterialGateResult | null),
  ]);
  if (sweepTriage?.skip) {
    await prisma.chatSchedule.update({ where: { id: s.id }, data: { lastStatus: sweepSkipStatus(sweepTriage.skip.consecutive) } }).catch(() => {});
    await refundDailyCapToken(s.sessionId);
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SCHEDULE_SWEEP_SKIP, sessionId: s.sessionId,
      meta: { scheduleId: s.id, sweep: sweepTriage.skip.sweep, needsTurn: Number(sweepTriage.skip.needsTurn.toFixed(3)), consecutive: sweepTriage.skip.consecutive },
    });
    logger.info(`coding schedule: ${s.id} skipped (sweep_quiet) — decision gate judged the ${sweepTriage.skip.sweep} sweep a no-op (needs_turn ${sweepTriage.skip.needsTurn.toFixed(2)}, consecutive ${sweepTriage.skip.consecutive})`);
    // The concurrent turn-noop ask (shadow) never started a turn — close it unlabelled so it still pairs.
    closeUnstartedTurnNoop(turnTriage?.stash ?? null, s.sessionId, 'sweep_triage skip');
    return { outcome: 'skipped', reason: 'sweep_quiet' };
  }
  sweepDecision = sweepTriage?.stash ?? null;
  if (turnTriage?.skip) {
    await prisma.chatSchedule.update({ where: { id: s.id }, data: { lastStatus: turnNoopSkipStatus(turnTriage.skip.consecutive) } }).catch(() => {});
    await refundDailyCapToken(s.sessionId);
    logger.info(`coding schedule: ${s.id} skipped (turn_noop) — decision gate judged the sweep turn a no-op (will_act ${turnTriage.skip.p.toFixed(2)}, consecutive ${turnTriage.skip.consecutive})`);
    return { outcome: 'skipped', reason: 'turn_noop' };
  }
  turnNoopStash = turnTriage?.stash ?? null;
  // W6-2: record the deterministic verdict beside the Jev shadow asks, then skip a non-material sweep.
  if (materialGate) recordMaterialGateAgreement(materialGate, [sweepDecision, turnNoopStash]);
  if (materialGate?.skip) {
    // SUP-WAKE-TIERS (2026-10-20): a progress-only sweep whose source lanes drive themselves is held
    // (lastStatus 'skipped:progress_self_driving'); the next wake's diff still lists what it saw.
    const progressHold = materialGate.skipReason === 'progress_self_driving';
    await prisma.chatSchedule.update({ where: { id: s.id }, data: { lastStatus: progressHold ? SCHEDULE_STATUS_PROGRESS_SELF_DRIVING : SCHEDULE_STATUS_NO_MATERIAL_CHANGE } }).catch(() => {});
    await refundDailyCapToken(s.sessionId);
    void closeStashesForGateSkip([sweepDecision, turnNoopStash], s.sessionId, 'sweep');
    if (progressHold) {
      logger.info(`coding schedule: ${s.id} skipped (progress_self_driving) — progress only (${(materialGate.verdict?.reasons ?? []).join(', ')}) and every source lane is driving itself, ${materialGate.verdict?.sinceMin ?? '?'} min since the supervisor's last wake (SUP-WAKE-TIERS 2026-10-20)`);
      return { outcome: 'skipped', reason: 'progress_self_driving' };
    }
    logger.info(`coding schedule: ${s.id} skipped (no_material_change) — nothing material since the supervisor's last wake ${materialGate.verdict?.sinceMin ?? '?'} min ago (audit 2026-10-08 W6)`);
    return { outcome: 'skipped', reason: 'no_material_change' };
  }
  // DECISION GATE — SUPERSEDED FIRING (N7, 2026-09-25; coding/firing-superseded-gate.ts):
  // a firing that sat busy-parked (busySkips > 0) and now claims a free lane is
  // judged against the run that held the lane — did it already do this
  // firing's work? Eligibility is bounded inside the leaf (recurring +
  // machine-authored + not owner-subscribed; one-shots and owner rows never).
  // SHADOW (default): the firing is unchanged and the stash rides the run;
  // ACT (designed, not enabled — keyed on the RESULT's mode): a confident
  // drop/merge skips the firing (lastStatus 'skipped:superseded' |
  // 'skipped:merged_next', cap token refunded, busySkips reset, the row keeps
  // the nextRunAt the claim slid to). Fail-open. (The pre-2026-09-28 "one stash per
  // firing" rule is gone — see E09 below.)
  // backlog E09 (2026-09-28): the gate is asked for EVERY eligible parked row —
  // a busy-parked stock sweep already carries the sweep_triage stash, and the
  // old `!deltaDecision && !sweepDecision` guard meant the ask NEVER happened
  // (0 decision rows all-time). With a primary stash present the superseded
  // stash rides as a SIBLING (supersededAskEligibleAtSite).
  let parkedGate: FiringSupersededResult | null = null;
  const otherStash: DecisionStash | null = deltaDecision ?? sweepDecision;
  if (supersededAskEligibleAtSite(s)) {
    try {
      parkedGate = await preGateParkedFiring(s, now);
      if (parkedGate.skip) {
        const { disposition, confidence, finishedRunId } = parkedGate.skip;
        await prisma.chatSchedule.update({ where: { id: s.id }, data: { lastStatus: SUPERSEDED_SKIP_STATUS[disposition], busySkips: 0 } }).catch(() => {});
        await refundDailyCapToken(s.sessionId);
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SCHEDULE_SUPERSEDED_SKIP, sessionId: s.sessionId,
          meta: { scheduleId: s.id, disposition, confidence: Number(confidence.toFixed(3)), finishedRunId, busySkips: s.busySkips },
        });
        logger.info(`coding schedule: ${s.id} skipped (${disposition}) — decision gate judged the parked firing superseded by run ${finishedRunId.slice(0, 8)} (confidence ${confidence.toFixed(2)}, parked ${s.busySkips * BUSY_REARM_MIN}m)`);
        // The sibling asks (sweep / delta stash, turn-noop) never started a turn — close them unlabelled so they still pair.
        if (otherStash) {
          recordDecisionOutcome(reconstructDecision(otherStash), deltaDecision ? 'delta_material' : 'sweep_triage', {
            question: deltaDecision ? 'material' : SWEEP_TRIAGE_QUESTION, actual: null, acted: false, sessionId: s.sessionId, note: `not started: firing_superseded skip (${disposition})`,
          });
        }
        closeUnstartedTurnNoop(turnNoopStash, s.sessionId, `firing_superseded skip (${disposition})`);
        return { outcome: 'skipped', reason: disposition };
      }
    } catch (err: any) {
      logger.warn(`coding schedule: ${s.id} superseded-firing gate failed open (${err?.message ?? err}) — firing`);
    }
  }
  const supersededDecision: DecisionStash | null = parkedGate?.stash ?? null;
  // ONE PRIMARY stash rides the firing: the delta gate's (delta-gated rows), the
  // sweep triage's (stock sweeps) or the superseded-firing gate's (parked rows
  // nothing else judged); its purpose/question decide the close-out. A
  // superseded stash beside a delta / sweep stash rides as a SIBLING (E09).
  const primaryDecision = deltaDecision ?? sweepDecision ?? supersededDecision;
  const supersededSibling: DecisionStash | null = otherStash && supersededDecision ? supersededDecision : null;
  const firingPurpose = deltaDecision ? 'delta_material' : sweepDecision ? 'sweep_triage' : 'firing_superseded';
  const firingQuestion = deltaDecision ? 'material' : sweepDecision ? SWEEP_TRIAGE_QUESTION : FIRING_SUPERSEDED_QUESTION;
  // agent-decisions 2026-09-27: the supervisor_turn_noop stash rides as a SIBLING
  // of the primary stash (or alone when no other purpose asked) — the finalize
  // labels every rider from the same run evidence. E09: so does the superseded stash.
  const firingDecision = withSiblingStash(withSiblingStash(primaryDecision, turnNoopStash), supersededSibling);

  try {
    const res = await fireScheduleTarget({
      ...s,
      ...(firingDecision ? { decision: firingDecision } : {}),
      ...(cadence.stretch ? { cadenceStretch: cadence.stretch } : {}),
      ...(cadence.blockBackoff ? { blockStreakBackoff: cadence.blockBackoff } : {}),
      // One-shot chain (finding B1): a recurring-like link takes the busy
      // re-arm + busySkips path, not queue-behind-busy.
      ...(onceChainRecurringLike ? { onceChainRecurringLike: true } : {}),
    });
    // build 2026-10-08 D-1: a firing that handed its prompt to a run is a delegation task on the schedule's own chat (SHADOW).
    if (res.started) {
      recordDelegationTask({
        kind: 'schedule_firing', source: 'schedule', userId: s.userId, parentChatId: s.sessionId, childChatId: s.sessionId,
        childRef: s.id, brief: s.prompt, deliveredAs: res.steered ? 'steer' : res.queued ? 'queued' : 'started',
        origin: s.promptSetBy === 'user' || s.ownerSubscribed === true ? 'user' : 'machine',
      });
    }
    // WI-C: a stash reaches a finalize only when a run STARTED and carried it;
    // otherwise (busy re-arm, steer, plain-chat queue) close the decision row
    // here, unlabelled, so every decision still pairs with one outcome.
    if (primaryDecision && !(res.started && res.decisionDeferred)) {
      recordDecisionOutcome(reconstructDecision(primaryDecision), firingPurpose, {
        question: firingQuestion, actual: null, acted: false, sessionId: s.sessionId,
        note: res.started ? 'fired (steered/queued — outcome not attributable)' : `not started: ${res.reason ?? 'unknown'}`,
      });
    }
    if (turnNoopStash && !(res.started && res.decisionDeferred)) {
      closeUnstartedTurnNoop(turnNoopStash, s.sessionId, res.started ? 'fired (steered/queued — outcome not attributable)' : (res.reason ?? 'unknown'));
    }
    if (supersededSibling && !(res.started && res.decisionDeferred)) {
      closeUnstartedSupersededStash(supersededSibling, s.sessionId, res.started ? 'fired (steered/queued — outcome not attributable)' : (res.reason ?? 'unknown'));
    }
    if (res.started) {
      // Delta gate (ticket 0b1dbe75): the post-eval markers persist ONLY on
      // a real start (a busy re-arm must keep the OLD marker so the delta
      // re-attempts the fire) — same optimistic Json-equals guard; a
      // concurrently replaced gate wins and re-baselines next firing.
      if (deltaFireGate) {
        await prisma.chatSchedule.updateMany({
          where: { id: s.id, deltaGate: { equals: deltaFireGate.original as any } },
          data: { deltaGate: deltaFireGate.updated as any },
        }).catch(() => {});
      }
      // Only a REAL run consumes the budget; evaluate the cap after the bump.
      const nextRunsCount = s.runsCount + 1;
      const reachedCap = s.kind === 'once' || (s.maxRuns != null && nextRunsCount >= s.maxRuns);
      // SLIDING expiry: a recurring schedule that keeps firing stays alive —
      // expiry slides to 30 days from the LAST successful run. Before this,
      // expiresAt was fixed at creation, so a nightly loop silently lapsed
      // after 30 days (prod session b92ef13f). Abandoned/never-firing rows
      // still lapse; MAX_RUNS + the daily cap remain the runaway bounds.
      const slide = (s.kind === 'recurring' && !reachedCap)
        ? { expiresAt: new Date(now.getTime() + MAX_LIFETIME_MS) }
        : {};
      // Cancel-mid-fire race (review finding 1, fbe65673): an UNCONDITIONAL
      // bump would overwrite a cancel landing between the fire-time re-check
      // and this write — resurrecting a cancelled recurring schedule
      // (enabled:true, lastStatus 'started'). updateMany on enabled:true:
      // count 0 ⇒ the cancel won; the just-queued run is then dropped by the
      // executor's claim-time stale-firing guard.
      // Crash-window fix (shortfall hunt f24): when this fire consumed the
      // FINAL allowed run, the successor is armed BEFORE this disable write.
      // The old order (bump first, renew after) left a gap: a hard process
      // death (routine blue-green deploy kill) between the two writes
      // stranded the lane PERMANENTLY deaf — the sweep only reads
      // enabled:true rows, so the row was never revisited, and every
      // backstop (terminal notice, disable event, stopped-schedule alert)
      // queued after the renewal inside the same lost window. Renewal-first
      // closes it: the successor (or its DB-UNIQUE renewedFromId key) is
      // durable before the lane's only enabled row goes dark, and a crash
      // after the renewal but before the bump simply re-runs this branch
      // next tick (idempotent) and completes the stop.
      let renewOut: RenewRefusal = {};
      let successorId: string | null = null;
      if (reachedCap && s.kind === 'recurring') {
        successorId = await maybeRenewOnExhaustion(s, renewOut);
      }
      const bump = await prisma.chatSchedule.updateMany({
        where: { id: s.id, enabled: true },
        // lastFiredAt stamps HERE — on the actual fire, never at claim
        // (P3 pin 14a); a consumed final run also records disabledAt, and
        // a real start clears the busy-skip streak (v1#33).
        data: { runsCount: nextRunsCount, enabled: !reachedCap, lastStatus: 'started', lastFiredAt: now, busySkips: 0, ...(reachedCap ? { disabledAt: now } : {}), ...slide },
      }).catch(() => ({ count: 0 }));
      if (bump.count === 0) {
        logger.info(`coding schedule: ${s.id} cancelled mid-fire — post-fire bump skipped (cancel wins)`);
        // Cancel-race resurrection guard (f24): the renewal above ran BEFORE
        // the cancel landed, so a FRESH successor minted by this fire may now
        // be armed on top of a deliberately cancelled loop — exactly the
        // resurrection fbe65673's bump guard exists to prevent, one write
        // later. Tear down only a successor THIS fire created (renewOut.
        // createdId, renewedFromId = s.id): an adopted/existing/P2002-winner
        // row predates this fire and must survive. Enabled:false + disabled
        // 'cancelled' (never delete — the renewedFromId audit trail stays).
        if (renewOut.createdId) {
          await prisma.chatSchedule.updateMany({
            where: { id: renewOut.createdId, renewedFromId: s.id, enabled: true },
            data: { enabled: false, lastStatus: 'cancelled', disabledAt: now },
          }).then((r) => {
            if (r.count > 0) {
              logger.info(`coding schedule: cancelled mid-fire — tore down fresh successor ${renewOut.createdId} (cancel wins over renewal)`);
            }
          }).catch(() => {});
        }
        renewOut = {};
        successorId = null;
      }
      // wake-cadence-2: a REAL start (not a steer) clears the "previous firing
      // was steered" marker the adaptive stretch reads at the next claim.
      if (!res.steered && s.kind === 'recurring') {
        await redisClient.del(`cm:sched:steered:${s.id}`).catch(() => {});
      }
      // N7 (2026-09-25) — the "parked firing claimed after a finished run"
      // metric (doc §5: add it FIRST): a firing that had been busy-parked
      // actually started once the lane freed. Independent of the gate (mode
      // off still records it); the gate's facts enrich the row when present.
      if (s.busySkips > 0) {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SCHEDULE_PARKED_CLAIM, sessionId: s.sessionId, value: s.busySkips,
          meta: {
            scheduleId: s.id, busySkips: s.busySkips, parkedMin: s.busySkips * BUSY_REARM_MIN, kind: s.kind, promptSetBy: s.promptSetBy ?? null,
            ...(parkedGate?.facts ? { finishedRunId: parkedGate.facts.runId, finishedAgoMin: parkedGate.facts.finishedAgoMin, finishedRunNote: parkedGate.facts.noteKind, ownFiring: parkedGate.facts.wasThisSchedulesFiring } : {}),
            ...(parkedGate?.decision ? { decisionId: parkedGate.decision.id } : {}),
            ...(parkedGate?.ineligible ? { gate: parkedGate.ineligible } : {}),
          },
        });
      }
      logger.info(`coding schedule: fired ${s.id} (run ${nextRunsCount}${s.maxRuns ? '/' + s.maxRuns : ''}${reachedCap ? ', done' : ''}${res.queued ? ', queued behind busy' : ''}${res.steered ? ', steered into the active run' : ''})`);
      // A recurring schedule that just consumed its FINAL allowed run ends
      // here — tell the owner (one-shots complete by design, stay quiet).
      // bump.count===0 means a mid-fire cancel won (fbe65673): the cancel
      // path emits its own 'cancelled' disable event + notice, so this
      // terminal block must stay silent (f24).
      if (reachedCap && s.kind === 'recurring' && bump.count !== 0) {
        // renewOnExhaustion (v1#14) already ran ABOVE — before the disable
        // write (f24 crash-window fix) — so schedule_disabled carries
        // successorId (⇒ not alarm-class) and the lane never goes deaf. A
        // lost bump (mid-fire cancel) nulls successorId/renewOut in the
        // guard above, so a cancelled loop also never emits a renewal note.
        if (successorId) {
          await notifyScheduleTerminalOnce(s, `hit its ${s.maxRuns}-run cap (${nextRunsCount} runs); a same-cadence successor schedule ${successorId} is already armed (renewOnExhaustion), so this loop continues`).catch(() => {});
        } else {
          // A governor refusal (finding B2) names its reason in the 🛑 note.
          await notifyScheduleTerminalOnce(s, `hit its ${s.maxRuns}-run cap (${nextRunsCount} runs)${renewOut.reason ? `; auto-renew refused — ${renewOut.reason}` : ''}`).catch(() => {});
        }
        // Supervisor-visible (forensics fix 2). One-shot completions stay
        // quiet here too — their run already emits run_completed.
        await emitScheduleDisabled(s, 'max_runs', nextRunsCount,
          successorId ? { successorId } : (renewOut.reason ? { detail: `auto-renew refused — ${renewOut.reason}` } : undefined));
        // Owner-decision fast lane (SA0906): the just-fired run keeps the
        // lane "alive" for 6h, so a self-renewing chain's spent link never
        // files — only a lane that then goes silent does. A successor makes
        // the re-check moot entirely.
        if (!successorId) await queueStoppedScheduleAlertSafe(s.id, 'max_runs');
      }
      return { outcome: 'started' };
    } else {
      // Skipped (busy / not-runnable). Do NOT consume the budget. If busy, re-arm
      // SOON for BOTH once and recurring so a one-shot isn't silently lost.
      // Refund the speculative daily-cap token reserved above — a chat busy
      // for hours re-arms every ~3 min and each retry burned one token
      // (feedback 94bb9c2f: 85/144 consumed with only 4 real runs).
      await refundDailyCapToken(s.sessionId);
      // wake-cadence-6 (2026-09-27 tt-rd audit): the flat 3-min re-arm logged
      // ~45 busy-skips per real firing on a 30-min row colliding with 135-min
      // runs (1,357 rows = retries of ~26 firings/day) and read as a storm.
      // Geometric backoff on the persisted streak: 3 → 6 → 12 → 24 min,
      // capped at half the cadence (one-shots keep the flat 3 min); the
      // alarm crossings below are unchanged.
      const reArm = res.reason === 'busy'
        ? { nextRunAt: new Date(now.getTime() + busyRearmDelayMs(s.busySkips ?? 0, s.kind === 'recurring' ? s.intervalSec : null)) }
        // ALLCOMPLETE-CHARTER-TERMINATION: an idle skip carries its stretched next firing (≤ 24 h).
        : res.reason === 'all_complete_idle' && res.nextRunAt instanceof Date && Number.isFinite(res.nextRunAt.getTime())
          ? { nextRunAt: res.nextRunAt }
          : {};
      // 'obsolete' (continuation guard, fb8b609f) is terminal for the row:
      // the work it was scheduled to resume is already done, so the one-shot
      // must not re-arm into a skip-every-15-min loop.
      // ARCHIVED-TARGET-RETIRE (a, 2026-10-20): 'archived' is terminal too —
      // the target chat is archived (a stop), so the row is PAUSED
      // (enabled:false, lastStatus 'paused:archived', cancelledBy 'machine')
      // instead of sliding its nextRunAt into a refusal every interval (prod:
      // 821 refused rows / 7 d). The id is remembered and the chat's restore
      // re-enables exactly it. Kill switch ARCHIVED_TARGET_RETIRE_DISABLED=1
      // restores the skip-and-slide row byte-for-byte.
      const archivedRetire = res.reason === 'archived' && !archivedTargetRetireDisabled();
      // ALLCOMPLETE-CHARTER-TERMINATION (opt-in SCHEDULE_CHARTER_TERMINATION_ENFORCE): a machine row
      // whose lane charter is done is PAUSED (resumable) — never cancelled.
      const charterRetire = res.reason === 'charter_done';
      const terminal = res.reason === 'obsolete'
        ? { enabled: false, disabledAt: now }
        : archivedRetire || charterRetire ? { enabled: false, disabledAt: now, cancelledBy: 'machine' } : {};
      // Busy-skip streak (v1#33): persisted per schedule so a lane held
      // hostage by ONE wedged run is visible — the +3 min re-arm otherwise
      // made the watchdog read the lane as healthy forever.
      const busyBump = res.reason === 'busy' ? { busySkips: { increment: 1 } as const } : {};
      // ALLCOMPLETE-CHARTER-TERMINATION review fix: the charter pause is a GUARDED write on a still-enabled row
      // (an owner cancel / resume landing mid-fire is never overwritten) and only a write that landed is
      // recorded 'retired' + emits schedule_disabled; a lost / failed write records 'retire_lost'.
      const charterPaused = charterRetire
        ? Number((await prisma.chatSchedule.updateMany({
          where: { id: s.id, enabled: true },
          data: { lastStatus: CHARTER_DONE_LAST_STATUS, ...terminal },
        }).catch(() => null))?.count ?? 0) > 0
        : false;
      const updated = charterRetire ? null : await prisma.chatSchedule.update({
        where: { id: s.id },
        data: { lastStatus: archivedRetire ? ARCHIVED_SCHEDULE_LAST_STATUS : `skipped:${res.reason || 'unknown'}`, ...reArm, ...terminal, ...busyBump },
      }).catch(() => null);
      if (charterRetire) {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SCHEDULE_ALLCOMPLETE_FIRING, sessionId: s.sessionId,
          meta: { scheduleId: s.id, action: charterPaused ? 'retired' : 'retire_lost', why: res.detail ?? null, followUp: true },
        });
        if (charterPaused) await emitScheduleDisabled(s, 'charter_done', s.runsCount, res.detail ? { detail: res.detail } : undefined).catch(() => {});
      }
      if (archivedRetire && updated) {
        await rememberArchivePausedSchedules(s.sessionId, [s.id]);
        await emitScheduleDisabled(s, 'target_archived', s.runsCount).catch(() => {});
        recordArchivedTargetRetire(s.sessionId, { surface: 'schedule', action: 'paused', seam: 'sweeper', chatId: s.sessionId, scheduleId: s.id, kind: s.kind, promptSetBy: s.promptSetBy ?? null });
        logger.info(`coding schedule: ${s.id} paused — its chat ${s.sessionId.slice(0, 8)} is ARCHIVED (archived-target-retire; a restore re-arms it)`);
      }
      // Alarm on threshold CROSSINGS — 3, 10, then every 25 (a real start
      // or an owner resume resets the counter). The old strict ===3 fired
      // once per streak and NEVER again (one lane reached 75 skips
      // silently); busySkipAlarmLevel derives the crossing from the
      // persisted count, so a swallowed update cannot skip a level. Name
      // the run that holds the lane so the supervisor/owner can stop or
      // steer IT, not the schedule.
      const busySkips = res.reason === 'busy' && typeof (updated as any)?.busySkips === 'number'
        ? ((updated as any).busySkips as number)
        : null;
      if (busySkips !== null && busySkipAlarmLevel(busySkips) > busySkipAlarmLevel(busySkips - 1)) {
        const blocking = await prisma.agentRun.findFirst({
          where: { sessionId: s.sessionId, status: { in: ['running', 'queued'] } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true, startedAt: true },
        }).catch(() => null);
        // dae56e70: NO blocking row is NOT proof of a cross-process claim.
        // An unrunnable session-ROW state ('archived'/'error') fails
        // queueAgentRun's ready-gate on every start while agent_runs stays
        // empty — the 0afa0737 phantom-busy incident read exactly like a
        // leaked Redis claim, and the old label sent investigators chasing
        // one. Name the row state when it explains the busy; keep the
        // cross-process fallback only when the row looks runnable (or the
        // target is a plain chat with no coding-state row at all).
        let rowStatus: string | null = null;
        if (!blocking) {
          try {
            rowStatus = (await prisma.chatCodingState.findUnique({
              where: { id: s.sessionId },
              select: { status: true },
            }))?.status ?? null;
          } catch { rowStatus = null; } // best-effort attribution — never break the alarm
        }
        const blockerKind: BusySkipBlockerKind = blocking ? 'run' : rowStatus && rowStatus !== 'ready' ? 'stuck_row' : 'outside';
        const blockingLabel = blocking
          ? `run ${blocking.id} (${blocking.status}${blocking.startedAt ? `, started ${blocking.startedAt.toISOString()}` : ''})`
          : rowStatus && rowStatus !== 'ready'
            ? `no live run — the coding-session row is stuck at status '${rowStatus}' (every start fails the ready-gate; an unrunnable satellite state, not a claim)`
            : 'a run outside agent_runs (plain-chat lane or cross-instance claim)';
        // ≥10 skips: the reader needs the HOW, not just the WHAT — say
        // where the blocker lives so finding it takes no archaeology.
        const escalation = busySkips >= BUSY_SKIP_ALARM_ESCALATE
          ? ` To find the blocker: this is session ${s.sessionId} — check the live-run lock (Redis cm:liverun:${s.sessionId}) or a long/wedged run holding the lane.`
          : '';
        // Gate flip 2026-09-11 (owner: full steam): the crossing LOGS instead
        // of waking the Fleet Supervisor (192 wakes / 48h, 100% false-positive
        // — every "blocking" run completed normally; 59 were the supervisor
        // alarming ITSELF) — opt-in BUSY_SKIP_ALARM_HOOK=1 restores the
        // attention_needed hook, and then only from the ≥10-skip crossing (the
        // 3-skip level = 9 minutes busy, under the p50 32-min legitimate run).
        if (process.env.BUSY_SKIP_ALARM_HOOK === '1' && busySkips >= BUSY_SKIP_ALARM_ESCALATE) {
          await emitHookEventSafe(
            s.sessionId, 'attention_needed',
            `Schedule ${s.id}: ${busySkips} consecutive firings were skipped because the chat is BUSY — the lane is blocked by ${blockingLabel}. If that run is wedged, stop it; the schedule keeps re-arming every ~3 min but produces nothing while the lane is held.${escalation}`,
            { scheduleId: s.id, sessionId: s.sessionId, busySkips, ...(blocking?.id ? { runId: blocking.id } : {}) },
          );
        }
        // The LINE is the record at every crossing; it is warn only for a
        // ≥10-skip crossing with a named blocker (tolerated cases — the
        // 3-skip level, a plain-chat lane's own turn — log at info).
        logger[busySkipAlarmLogLevel(busySkips, blockerKind)](`coding schedule: ${s.id} hit ${busySkips} consecutive busy-skips (blocking: ${blockingLabel})`);
      }
      // Supervisor-visible (forensics fix 2): the obsolete staleness
      // disable is an enabled:false flip like any other.
      if (res.reason === 'obsolete') await emitScheduleDisabled(s, 'obsolete', s.runsCount);
      // Telemetry (remediation P0): busy skips are the congestion signal —
      // a chat busy for hours re-arms every ~3 min, each retry one row.
      if (res.reason === 'busy') {
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.SCHEDULE_BUSY_SKIP,
          sessionId: s.sessionId,
          meta: { scheduleId: s.id },
        });
      }
      logger.info(`coding schedule: ${s.id} skipped (${res.reason})`);
      return { outcome: 'skipped', reason: res.reason || 'unknown' };
    }
  } catch (err: any) {
    await refundDailyCapToken(s.sessionId); // no run started — the reserved token was speculative
    await prisma.chatSchedule.update({ where: { id: s.id }, data: { lastStatus: `error:${String(err?.message).slice(0, 60)}` } }).catch(() => {});
    logger.warn(`coding schedule: fire ${s.id} errored — ${err?.message}`);
    return { outcome: 'error', message: String(err?.message ?? err).slice(0, 120) };
  }
}

/** fireDueScheduleNow outcomes beyond the row pass itself. */
export type FireNowOutcome = DueRowOutcome | { outcome: 'not_due' } | { outcome: 'not_found' } | { outcome: 'retiring' };

/**
 * Schedule priority — direct fire (autonomy loop #10, 2026-09-20). Fire ONE
 * specific schedule NOW through the exact sweep path (processDueScheduleRow).
 * Called from the chat-agent finalize right after claimStarvedScheduleSlot
 * pulled a starved recurring schedule's nextRunAt to now: leaving the firing to
 * the sweeper's next tick (≤ 30 s) lost the free slot to whichever message send
 * / queue drain / hook wake found the chat idle first — live 2026-09-20 the
 * Fleet Supervisor's 2 h sweep got 4 priority slots and fired in 1 (the other 3
 * went to coalesced-message wakes; busySkips 50, last real sweep 3.5 h old).
 * Safe against the concurrent sweeper: the atomic claim inside the row pass
 * lets exactly one side fire; the other sees count 0 ('lost_claim'). A
 * RETIRING process never fires (its starts would be refused and counted as
 * busy-skips) — the new colour's sweeper owns the pulled-forward row.
 */
export async function fireDueScheduleNow(scheduleId: string): Promise<FireNowOutcome> {
  if (isRetiring()) return { outcome: 'retiring' };
  const now = new Date();
  const s = await prisma.chatSchedule.findUnique({ where: { id: scheduleId } });
  if (!s || !s.enabled) return { outcome: 'not_found' };
  if (s.nextRunAt.getTime() > now.getTime()) return { outcome: 'not_due' };
  return processDueScheduleRow(s, now);
}

/** Register the boot sweeper (idempotent). Called from server.ts on every boot. */
export function startCodingScheduleSweeper(): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => { void fireDue(); }, SWEEP_INTERVAL_MS);
  sweeperTimer.unref?.();
  setTimeout(() => { void fireDue(); }, 20_000).unref?.();
  logger.info('coding schedule sweeper started (30s, DB-backed, blue-green safe)');
}
