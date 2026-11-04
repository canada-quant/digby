/**
 * Schedule cadence reconciliation — PURE helpers + kill switches for the
 * wake-cadence fixes of the 2026-09-27 tt-rd audit (sup/wake-cadence).
 *
 * WHY (audit, VERIFIED on prod agent_runs / coding_schedules / loop_metrics):
 *   - a 30-min recurring schedule fired into 50–250-min runs for eight days:
 *     1,357 busy-skips (the 3-min re-arm loop) 09-19→09-24, then — once the
 *     2026-09-24 busy-session steer shipped — every firing that landed on the
 *     running run was delivered INTO it as a steer carrying the FULL prompt, so
 *     the run never reached a natural end (117…257-min runs with 1…8 steers,
 *     ~115k prompt tokens re-sent per turn, $566 of a $582 lane);
 *   - nothing in the harness compared a schedule's interval to the lane's
 *     observed run duration, so nobody stretched the cadence;
 *   - the project supervisor halved its own stock sweep to 30 min during an
 *     outage wake and the ensure/heal never restored it (48 sweeps/day at 76 %
 *     no-op); no adaptive backoff existed;
 *   - [SCHEDULE STATE] printed "firing N of 500" with no renewal note, so a
 *     lane-authored "SUCCESSOR at 480/500" clause caused a needless handoff.
 *
 * This module is DEPENDENCY-FREE (no prisma / redis / logger) so the fire
 * path, the create/update path, run-executor and the tests share ONE set of
 * semantics. Every behaviour is deterministic, cheap, fail-open and has its
 * own kill switch (documented in .env.example).
 */

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

// ── Kill switches ────────────────────────────────────────────────────────────

/** wake-cadence-2: owner-authored rows (promptSetBy 'user' / NULL) are stretched ONLY when
 *  SCHEDULE_ADAPTIVE_CADENCE_OWNER_ROWS=1 (default OFF — an owner-set cadence is never
 *  silently overridden; the hook-event registry has no non-alarm type to announce it with). */
export function adaptiveCadenceOwnerRowsEnabled(): boolean { return onFlag(process.env.SCHEDULE_ADAPTIVE_CADENCE_OWNER_ROWS); }
/** wake-cadence-3 (1, fixer 2026-09-27): the ensure heal ALSO restores a stock sweep whose interval the OWNER lowered
 *  (Activity attribution 'owner-interval') only under PROJECT_SWEEP_FLOOR_HEAL_OWNER_ROWS=1 — default OFF: the floor
 *  refusal promises "An owner turn may still set it lower", so the heal must not undo that on the next watchdog pass. */
export function projectSweepFloorHealOwnerRowsEnabled(): boolean { return onFlag(process.env.PROJECT_SWEEP_FLOOR_HEAL_OWNER_ROWS); }
/** wake-cadence-5: SUPERVISOR_REPORT_UP_IS_ACTION=1 restores the old classification (a report-up counts as supervisor_action). */
export function supervisorReportUpIsAction(): boolean { return onFlag(process.env.SUPERVISOR_REPORT_UP_IS_ACTION); }

// ── Stock sweep cadences (single source of truth — the services re-export) ──

/** Project supervisor stock sweep cadence: 2 h (was 60 min since #741; the project hook is the event path, the sweep is only the diff). */
export const PROJECT_SWEEP_INTERVAL_SEC = 2 * 60 * 60;
/** Fleet supervisor stock sweep cadence (supervisor.service SWEEP_INTERVAL_SEC — mirrored here for the floor). */
export const FLEET_SWEEP_INTERVAL_SEC = 2 * 60 * 60;
/** Upper bound of the adaptive sweep backoff. */
export const PROJECT_SWEEP_MAX_INTERVAL_SEC = 4 * 60 * 60;
/** Consecutive schedule-origin supervisor_noop rows before the stock sweep backs off one doubling. */
export const SWEEP_BACKOFF_NOOP_STREAK = 3;

export type StockSweepClass = 'fleet' | 'project';

/** The floor a MACHINE turn may not set a stock sweep below (owner turns may). */
export function stockSweepFloorSec(cls: StockSweepClass): number {
  return cls === 'project' ? PROJECT_SWEEP_INTERVAL_SEC : FLEET_SWEEP_INTERVAL_SEC;
}

/** True when a machine-authored interval update on a stock sweep must be refused. Pure. */
export function stockSweepFloorRefusal(opts: { cls: StockSweepClass | null; machineActor: boolean; intervalSec: number }): string | null {
  if (!opts.cls || !opts.machineActor) return null;
  const floor = stockSweepFloorSec(opts.cls);
  if (!(opts.intervalSec < floor)) return null;
  return `stock ${opts.cls} sweeps are floored at ${Math.round(floor / 60)} min — the ${opts.cls === 'project' ? 'project' : 'fleet'} hook wakes you on events, the sweep is only the periodic diff; a shorter sweep is not diligence, it is a no-op storm (the 2026-09-27 audit: 48 sweeps/day at 76 % no-op). Nothing was updated. An owner turn may still set it lower.`;
}

// ── Adaptive cadence stretch (wake-cadence-2) ───────────────────────────────

/** Stretch when intervalSec < this × the median run duration. */
export const CADENCE_STRETCH_MEDIAN_FACTOR = 1.5;
/** Busy-skip streak on the CURRENT firing (re-arm retries) that counts as a collision — the stretch fires at the
 *  CROSSING only (busySkips === 3), never again on the 4th, 5th… skip of the same parked firing (fixer 2026-09-27:
 *  the `>=` form re-fired on every claim while the row stayed parked and doubled a 30-min row to 6 h in 93 min). */
export const CADENCE_STRETCH_BUSY_SKIPS = 3;
/** Hard ceiling of the automatic stretch (env SCHEDULE_ADAPTIVE_CADENCE_MAX_SEC, clamped ≥ 1 h). */
export function cadenceStretchMaxSec(): number {
  const n = Number(process.env.SCHEDULE_ADAPTIVE_CADENCE_MAX_SEC);
  return Number.isFinite(n) && n >= 3600 ? Math.floor(n) : 6 * 60 * 60;
}
/** Sample size of completed schedule-origin runs the median is taken over. */
export const CADENCE_STRETCH_SAMPLE = 5;

/** Median of a list of durations (ms). Pure; null on an empty list. */
export function medianMs(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

export interface CadenceStretchInput {
  /** The row's current cadence. */
  intervalSec: number;
  /** Median duration (ms) of the last completed schedule-origin runs on the session, or null when unknown (plain-chat lanes). */
  medianRunMs: number | null;
  /** The CURRENT firing's busy-skip streak (re-arm retries that preceded this claim). Triggers ONLY at the crossing. */
  busySkips: number;
  /** The previous firing of THIS row was delivered as a steer into an active run. The wiring CONSUMES the marker when
   *  the stretch it triggered lands (schedule.service processDueScheduleRow), so one steer buys one doubling. */
  previousFiringSteered: boolean;
}

export interface CadenceStretch {
  fromSec: number;
  toSec: number;
  reason: 'run_duration' | 'busy_skips' | 'steered';
  medianRunMin: number | null;
}

/**
 * The stretch verdict for one recurring row at fire time. Never shrinks.
 * new = min(2 × current, cadenceStretchMaxSec()); rows already at/above the
 * ceiling are left alone. Pure.
 *
 * AT MOST ONE DOUBLING PER COLLISION EPISODE (fixer 2026-09-27 — the ratchet
 * finding): the two collision triggers are one-shot per episode — `busy_skips`
 * fires only at the crossing (busySkips === CADENCE_STRETCH_BUSY_SKIPS; the
 * streak keeps growing on later re-arms but never re-triggers) and `steered`
 * fires on the marker the wiring deletes as soon as a stretch lands. The
 * `run_duration` trigger is DATA-bounded, not collision-bounded: it re-checks
 * `interval < 1.5 × median` at every claim and stops once the cadence covers
 * the measured run (30 → 60 → 120 min for a 62-min median, then quiet) — it
 * can never reach the ceiling on a short run. A real start resets the episode.
 */
export function cadenceStretchFor(input: CadenceStretchInput): CadenceStretch | null {
  const cur = Math.round(input.intervalSec);
  if (!Number.isFinite(cur) || cur <= 0) return null;
  const max = cadenceStretchMaxSec();
  if (cur >= max) return null;
  let reason: CadenceStretch['reason'] | null = null;
  const medianSec = input.medianRunMs != null ? input.medianRunMs / 1000 : null;
  if (medianSec != null && cur < CADENCE_STRETCH_MEDIAN_FACTOR * medianSec) reason = 'run_duration';
  else if (input.busySkips === CADENCE_STRETCH_BUSY_SKIPS) reason = 'busy_skips';
  else if (input.previousFiringSteered) reason = 'steered';
  if (!reason) return null;
  const toSec = Math.min(cur * 2, max);
  if (toSec <= cur) return null;
  return { fromSec: cur, toSec, reason, medianRunMin: medianSec != null ? Math.round(medianSec / 60) : null };
}

/** The lastStatus stamp a stretch writes ('stretched:30m→60m'). Pure. */
export function cadenceStretchStatus(s: CadenceStretch): string {
  return `stretched:${Math.round(s.fromSec / 60)}m→${Math.round(s.toSec / 60)}m`;
}

/** The one-line [SCHEDULE STATE] addendum the stretched firing carries. Pure. */
export function cadenceStretchStateLine(s: CadenceStretch): string {
  const why = s.reason === 'run_duration' && s.medianRunMin != null
    ? `your last ${CADENCE_STRETCH_SAMPLE} runs took ~${s.medianRunMin} min`
    : s.reason === 'busy_skips'
      ? 'this firing collided with your own running run (busy re-arms)'
      : 'your previous firing had to be steered into a still-running run';
  return `cadence stretched ${Math.round(s.fromSec / 60)}→${Math.round(s.toSec / 60)} min by the harness: ${why} — a cadence shorter than the run is a collision, not diligence`;
}

// ── Project sweep backoff (wake-cadence-3) ──────────────────────────────────

export interface SupervisorNoteRow { kind: string; origin: string | null | undefined; createdAt: Date }

/**
 * Consecutive most-recent SCHEDULE-origin no-op notes. Walks newest → oldest:
 * a supervisor_action or supervisor_note row (any origin) ENDS the streak (the
 * lane did something / narrated); a schedule-origin supervisor_noop extends
 * it; a hook/agent-origin no-op is skipped (neither counts nor breaks — hook
 * wakes are event-driven and say nothing about the sweep). Pure.
 */
export function scheduleNoopStreak(rowsNewestFirst: SupervisorNoteRow[]): number {
  let streak = 0;
  for (const r of rowsNewestFirst) {
    if (r.kind === 'supervisor_action' || r.kind === 'supervisor_note') break;
    if (r.kind !== 'supervisor_noop') continue;
    if (String(r.origin ?? '') === 'schedule') streak += 1;
  }
  return streak;
}

export interface SweepBackoffInput {
  intervalSec: number;
  defaultSec: number;
  maxSec?: number;
  noopStreak: number;
  /** A real user (owner) turn in the chat newer than the newest note — resets the backoff. */
  ownerTurnSinceLastNote: boolean;
}

export type SweepBackoff =
  | { kind: 'backoff'; fromSec: number; toSec: number; noopStreak: number }
  | { kind: 'reset'; fromSec: number; toSec: number; noopStreak: number };

/**
 * Backoff verdict for a stock sweep row at fire time. Doubles after every
 * SWEEP_BACKOFF_NOOP_STREAK consecutive schedule-origin no-ops (3 → ×2, 6 → ×4,
 * …) up to maxSec; an owner turn or a streak of 0 (an action/note landed)
 * resets a backed-off row to the default. Rows BELOW the default are never
 * touched here (that is the floor heal's job). Pure.
 */
export function sweepBackoffFor(input: SweepBackoffInput): SweepBackoff | null {
  const cur = Math.round(input.intervalSec);
  const def = Math.round(input.defaultSec);
  const max = Math.round(input.maxSec ?? PROJECT_SWEEP_MAX_INTERVAL_SEC);
  if (!Number.isFinite(cur) || !Number.isFinite(def) || cur <= 0 || def <= 0) return null;
  if (input.ownerTurnSinceLastNote || input.noopStreak === 0) {
    return cur > def ? { kind: 'reset', fromSec: cur, toSec: def, noopStreak: input.noopStreak } : null;
  }
  if (cur < def) return null;
  const doublings = Math.floor(input.noopStreak / SWEEP_BACKOFF_NOOP_STREAK);
  if (doublings <= 0) return null;
  const target = Math.min(def * 2 ** doublings, max);
  return target > cur ? { kind: 'backoff', fromSec: cur, toSec: target, noopStreak: input.noopStreak } : null;
}

// ── [SCHEDULE STATE] renewal clause (wake-cadence-4) ────────────────────────

/**
 * The SAME derivation maybeRenewOnExhaustion / emitScheduleNearCap use:
 * row.renewOnExhaustion when set, else NULL derives TRUE only for
 * machine/system-authored rows. Pure.
 */
export function willAutoRenew(s: { promptSetBy?: string | null; renewOnExhaustion?: boolean | null }): boolean {
  return s.renewOnExhaustion ?? (s.promptSetBy === 'machine' || s.promptSetBy === 'system');
}

/** The renewal clause appended to [SCHEDULE STATE] for a CAPPED recurring row; null when uncapped. Pure. */
export function scheduleStateRenewClause(s: { kind: string; maxRuns: number | null; promptSetBy?: string | null; renewOnExhaustion?: boolean | null; fleetManaged?: boolean | null }): string | null {
  if (s.kind !== 'recurring' || s.maxRuns == null) return null;
  if (willAutoRenew(s)) {
    return 'auto-renews at cap — a successor row arms itself; NEVER hand off, spawn a successor chat, or file an owner card because of the cap';
  }
  // SS-1 (2026-10-23): a row whose cadence the FLEET manages (per Fleet Supervisor
  // routing — e.g. the FO lane's d2b633c0) must NOT be told to restate the
  // owner-decides line; cadence concerns route to the Fleet Supervisor. The
  // no-rearm protection is unchanged. Marker source: isFleetManagedCadence.
  if (s.fleetManaged) {
    return 'STOPS at cap (owner-set) — cadence FLEET-MANAGED per Fleet Supervisor routing: never restate the owner-decides line in closes/cards; route cadence concerns to the Fleet Supervisor; do NOT re-arm a replacement schedule yourself';
  }
  // fixer 2026-09-27: an owner-capped row is the OWNER's stop — a machine re-arm would be promptSetBy
  // 'machine' and auto-renew forever, defeating the deliberate maxRuns (project-supervisor rule 5:
  // owner rows are never retired or replaced by machine turns; the near-cap event already routes the
  // decision to the supervisor with ownerVisible).
  return 'STOPS at cap (owner-set) — the owner decides whether this cadence continues: state it in your final line / report-up; do NOT re-arm a replacement schedule yourself';
}

/**
 * SS-1 per-row fleet-managed marker (2026-10-23): true when the schedule id is
 * listed in FLEET_MANAGED_CADENCE_SCHEDULE_IDS (comma-separated; a full id or a
 * >=8-char unique prefix, matching how the fleet cites rows in state docs).
 * A platform-admin env list — the supervisor-owned-list shape the backlog entry
 * names, with NO new column and NO tool setter, so the authority model cannot be
 * laundered by a machine turn. Kill switch FLEET_MANAGED_CADENCE_DISABLED=1.
 */
export function isFleetManagedCadence(scheduleId: string | null | undefined): boolean {
  if (!scheduleId) return false;
  if (process.env.FLEET_MANAGED_CADENCE_DISABLED === '1') return false;
  const raw = process.env.FLEET_MANAGED_CADENCE_SCHEDULE_IDS ?? '';
  for (const entry of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    if (scheduleId === entry) return true;
    if (entry.length >= 8 && scheduleId.startsWith(entry)) return true;
  }
  return false;
}

// ── Stock-sweep interval attribution (wake-cadence-3, fixer 2026-09-27) ───────

/** Activity `schedule.update` metadata.source values that attribute an intervalSec write to its author. */
export const INTERVAL_ATTRIBUTION_OWNER_SOURCE = 'owner-interval';
export const INTERVAL_ATTRIBUTION_MACHINE_SOURCE = 'machine-interval';
export const INTERVAL_ATTRIBUTION_MACHINE_SOURCES: ReadonlySet<string> = new Set([
  INTERVAL_ATTRIBUTION_MACHINE_SOURCE, 'cadence-stretch', 'project-sweep-backoff', 'project-sweep-cadence-floor',
  'block-streak-backoff',
]);

export type IntervalAttribution = 'owner' | 'machine';

/**
 * Who last set a schedule's intervalSec, from its `schedule.update` Activity
 * rows NEWEST FIRST: the first row whose `fields` names intervalSec AND whose
 * `source` is a known attribution decides ('owner-interval' ⇒ owner; the
 * harness/machine sources ⇒ machine). Rows without a known source — the
 * platform.service tool audit row written after every update_schedule, or
 * legacy rows — are skipped, so a pre-fix row (no attribution at all) yields
 * null and the caller keeps its old behaviour. Pure.
 */
export function latestIntervalAttribution(metasNewestFirst: Array<Record<string, unknown> | null | undefined>): IntervalAttribution | null {
  for (const m of metasNewestFirst) {
    if (!m || typeof m !== 'object') continue;
    const fields = Array.isArray((m as any).fields) ? ((m as any).fields as unknown[]).map(String) : [];
    if (!fields.includes('intervalSec')) continue;
    const source = String((m as any).source ?? '');
    if (source === INTERVAL_ATTRIBUTION_OWNER_SOURCE) return 'owner';
    if (INTERVAL_ATTRIBUTION_MACHINE_SOURCES.has(source)) return 'machine';
  }
  return null;
}

// ── Prompt lint (wake-cadence-4, observe-only) ──────────────────────────────

/** A lane-authored "successor / hand-off at the cap" clause (the tt-rd 480/500 SUCCESSOR protocol). */
export const CAP_HANDOFF_CLAUSE_RE = /(?:(?:successor|hand-?off).{0,80}(?:exhaust|\bcap\b|\b4[5-9]\d\b|\b500\b)|(?:exhaust|\bcap\b|\b4[5-9]\d\b|\b500\b).{0,80}(?:successor|hand-?off))/is;

export interface PromptLintFinding { rule: 'cap_handoff'; notice: string }

/** Lint a MACHINE-authored schedule prompt. Never refuses — returns a notice to append to the tool result. Pure. */
export function lintSchedulePrompt(prompt: string, promptSetBy: string | null | undefined): PromptLintFinding | null {
  if (promptSetBy !== 'machine') return null;
  if (!CAP_HANDOFF_CLAUSE_RE.test(String(prompt ?? ''))) return null;
  return {
    rule: 'cap_handoff',
    notice: '[SCHEDULE PROMPT NOTICE] this prompt carries a cap-driven successor/hand-off clause. The harness AUTO-RENEWS capped machine schedules (a same-cadence successor row arms itself at the cap — see the [SCHEDULE STATE] line on every firing); a lane-authored hand-off at firing 480/500 causes a new chat, an owner card and lost context for nothing. Consider removing that clause. The schedule was saved as written.',
  };
}

// ── Busy re-arm backoff (wake-cadence-6) ────────────────────────────────────

/** The base busy re-arm (minutes) — mirrors firing-superseded-gate BUSY_REARM_MIN. */
export const BUSY_REARM_BASE_MIN = 3;
/** Max doublings of the base re-arm (3 → 6 → 12 → 24 min). */
export const BUSY_REARM_MAX_DOUBLINGS = 3;

/**
 * Re-arm delay (ms) for the k-th consecutive busy skip of a RECURRING row:
 * min(3 min × 2^min(k, 3), intervalSec / 2), never below the 3-min base. A
 * one-shot (intervalSec null) keeps the flat 3 min. Pure.
 */
export function busyRearmDelayMs(busySkipsBefore: number, intervalSec: number | null | undefined): number {
  const base = BUSY_REARM_BASE_MIN * 60_000;
  if (intervalSec == null || !Number.isFinite(intervalSec) || intervalSec <= 0) return base;
  const k = Math.min(Math.max(0, Math.floor(busySkipsBefore)), BUSY_REARM_MAX_DOUBLINGS);
  const geometric = base * 2 ** k;
  const halfCadence = Math.round((intervalSec * 1000) / 2);
  return Math.max(base, Math.min(geometric, halfCadence));
}

/** Total minutes a row sat parked over `busySkips` consecutive re-arms under the backoff. Pure. */
export function parkedMinutesWithBackoff(busySkips: number, intervalSec: number | null | undefined): number {
  const n = Math.max(1, Math.floor(busySkips || 1));
  let ms = 0;
  for (let k = 0; k < n; k += 1) ms += busyRearmDelayMs(k, intervalSec);
  return Math.max(BUSY_REARM_BASE_MIN, Math.round(ms / 60_000));
}

// ── Busy-steer delta header (wake-cadence-1) ────────────────────────────────

/** The short delta a recurring steer delivers INSTEAD of the whole stored prompt. Pure. */
export function busySteerDeltaBody(scheduleId: string, extras: string[] = []): string {
  const head = `[SCHEDULED FIRING ${scheduleId.slice(0, 13)} arrived mid-run — the stored prompt is UNCHANGED from the one this run started with, so it is not repeated here. Finish the current step, fold its result into your work, then WRAP UP at the next natural point — the next firing starts a FRESH run with the full prompt. Do not start over.]`;
  const tail = extras.map((e) => String(e ?? '').trim()).filter(Boolean);
  return tail.length ? `${head}\n\n${tail.join('\n\n')}` : head;
}

// ── Schedule-origin run wrap-up note (wake-cadence-1 part 3) ────────────────

/** Elapsed factor of the schedule's interval at which the note is injected. */
export const RUN_WRAPUP_INTERVAL_FACTOR = 2;

/**
 * The ONE observe-only line a schedule-origin run receives once its wall
 * clock passes 2× its schedule's interval. null while under the bound or when
 * the interval is unknown. Pure.
 */
export function scheduleRunWrapupNote(opts: { elapsedMs: number; intervalSec: number | null | undefined; alreadyDelivered: boolean }): string | null {
  if (opts.alreadyDelivered) return null;
  if (opts.intervalSec == null || !Number.isFinite(opts.intervalSec) || opts.intervalSec <= 0) return null;
  const boundMs = opts.intervalSec * 1000 * RUN_WRAPUP_INTERVAL_FACTOR;
  if (!(opts.elapsedMs >= boundMs)) return null;
  const elapsedMin = Math.round(opts.elapsedMs / 60_000);
  const intervalMin = Math.round(opts.intervalSec / 60);
  return `[SCHEDULE CADENCE NOTE — harness, not the user] This run has been going ${elapsedMin} min; the schedule that started it fires every ${intervalMin} min, so further firings are already colliding with it. Wrap up at the next natural point (commit/record what you have, state what is unfinished) and let the next firing start fresh — a run longer than ~2× its cadence re-sends the whole context on every step for no gain. This is advice, not a stop.`;
}
