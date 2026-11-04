/**
 * Supervisor sweep pre-triage — decision-gate purpose `sweep_triage`
 * (N2, docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §5; shipped SHADOW).
 *
 * WHY: the fleet sweep (every 120 min, platform/supervisor.service) and every
 * project sweep (every 60 min, platform/project-supervisor.service) fire a
 * FULL reasoning turn regardless of whether anything moved: 143–158 sweep
 * turns/day, 53–58% of them closing 'SWEEP: no-op', p50 164–405 s, ≈$0.26
 * each — the saturation lever the 2026-09-13 fleet review named. The gate
 * asks ONE typed noul BEFORE the firing, over a delta the HARNESS computes
 * (never lane-authored prose — the wake_triage lesson: state must be
 * code-computed): what changed since the previous sweep (lanes running /
 * finished / failed, hook events queued for this supervisor, open owner
 * asks, new tickets, the project's status card, the supervisor's own last
 * close-out note).
 *
 * MODES (decisionMode('sweep_triage'); default shadow, NODE_ENV=test off):
 *   shadow — the firing is UNCHANGED; the decision stash rides the fired run
 *            (fireScheduleTarget → RunInput.decision / ChatAgentRunArgs
 *            .decision) and decision-outcome-labels.ts records the outcome
 *            from what the sweep actually did (mutating platform tool or an
 *            ACTIONS TAKEN note ⇒ needed a turn; 'SWEEP: no-op' ⇒ did not).
 *   act    — DESIGNED, NOT ENABLED: a confidently quiet sweep (needs_turn_now
 *            ≤ 1 − DECISION_GATE_THRESHOLD_SWEEP_TRIAGE, default 0.85) is
 *            SKIPPED by the caller (lastStatus 'skipped:sweep_quiet:<n>', the
 *            daily-cap token refunded, loop metric schedule_sweep_skip) —
 *            bounded by a HEARTBEAT FLOOR: after DECISION_GATE_SWEEP_HEARTBEAT
 *            _TICKS − 1 consecutive skips the sweep fires regardless (the
 *            "a missed stuck lane waits one cadence" risk is capped at
 *            (ticks − 1) cadences, and hook wakes never pass through here).
 * Fail-open everywhere: a snapshot read error, a null gate answer, a thrown
 * anything ⇒ the sweep fires exactly as before. Kill switches: the gate-wide
 * switches.
 *
 * LEAF: imports decision-gate + sweep-doctrine-rebuild statically; the
 * supervisor note classifier and the project status card are pulled
 * DYNAMICALLY (supervisor.service → schedule.service → this would cycle).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import {
  decide, decisionMode, decisionThreshold, recordDecisionOutcome, stashDecision,
  type DecideResult, type DecisionQuestion, type DecisionStash,
} from './decision-gate';
import { classifySweepPrompt, type SweepClass } from './sweep-doctrine-rebuild';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** The question key on every sweep_triage decision/outcome row (the wake_triage vocabulary). */
export const SWEEP_TRIAGE_QUESTION = 'needs_turn_now';
/** Acting confidence (DECISION_GATE_THRESHOLD_SWEEP_TRIAGE overrides; clamped by decisionThreshold). */
export const SWEEP_TRIAGE_DEFAULT_THRESHOLD = 0.85;
/** Gate deadline — the sweeper tick is 30 s; this must stay a small slice of it. */
export const SWEEP_TRIAGE_TIMEOUT_MS = 4000;
/** Snapshot read deadline — past it the gate is NOT asked (no state, no decision). */
export const SWEEP_TRIAGE_SNAPSHOT_TIMEOUT_MS = 8000;
/** ACT heartbeat floor: the sweep fires on every Nth tick regardless (env DECISION_GATE_SWEEP_HEARTBEAT_TICKS, clamped 2..24). */
export const SWEEP_TRIAGE_DEFAULT_HEARTBEAT_TICKS = 3;
/** Upper bound on the "since the previous sweep" window (a worker outage must not scan a week). */
export const SWEEP_TRIAGE_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
/** lastStatus stamped on an ACT skip: `skipped:sweep_quiet:<consecutive>`. */
export const SWEEP_SKIP_STATUS_PREFIX = 'skipped:sweep_quiet';

// ── backlog E12 (2026-09-28): the ACT CONTROL SAMPLE ────────────────────────
// A sweep the gate skips in act yields no turn and therefore no label, so the
// act band held ~4 rows in prod while the purpose ran at 50 % act-period
// agreement — auto-demote (n_act ≥ 30) could never fire. One in
// SWEEP_TRIAGE_CONTROL_SAMPLE_DEFAULT_N (10) confident-quiet skips now FIRES
// anyway and stamps `control:true` on its stash (the same design as
// supervisor_turn_noop's heartbeat floor turns): the finalize labels it from
// what the sweep did, the row sits inside the act band (quiet ≤ 1−τ), so the
// E12 act-band window and the readiness ruler's PURPOSE_CONTROL_GATED verdict
// measure the skip band's real action rate. The heartbeat-floor fire is
// stamped the same way (`controlReason:'heartbeat'`). Env
// DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE (0..1, default 0.1); kill switch
// SWEEP_TRIAGE_CONTROL_SAMPLE_DISABLED=1 restores the skip-every-time act path.
export const SWEEP_TRIAGE_CONTROL_SAMPLE_DEFAULT_N = 10;
export function sweepControlSampleDisabled(): boolean {
  return onFlag(process.env.SWEEP_TRIAGE_CONTROL_SAMPLE_DISABLED);
}
/** The control draw rate for act skips (env DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE, clamped 0..1; default 1/10; 0 under the kill switch). */
export function sweepControlSampleRate(): number {
  if (sweepControlSampleDisabled()) return 0;
  const raw = process.env.DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE;
  if (raw === undefined || String(raw).trim() === '') return 1 / SWEEP_TRIAGE_CONTROL_SAMPLE_DEFAULT_N;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1 / SWEEP_TRIAGE_CONTROL_SAMPLE_DEFAULT_N;
}
let controlSampler: () => number = Math.random;
/** Test hook: replace the control draw (null restores Math.random). */
export function setSweepControlSampler(fn: (() => number) | null): void { controlSampler = fn ?? Math.random; }
/** Does this act skip fire as a control instead? Pure given the sampler. */
export function drawSweepControl(): boolean {
  const rate = sweepControlSampleRate();
  if (rate <= 0) return false;
  return rate >= 1 || controlSampler() < rate;
}
/** Scope bounds (pathology guards — a fleet scope is every chat the owner has). */
export const SWEEP_TRIAGE_MAX_SCOPE_CHATS = 2000;
export const SWEEP_TRIAGE_MAX_RUNS = 1000;
export const SWEEP_TRIAGE_MAX_EVENTS = 500;
export const SWEEP_TRIAGE_MAX_ASKS = 200;
/** Head of the supervisor's own last note carried in the state. */
export const SWEEP_TRIAGE_NOTE_HEAD_CHARS = 400;

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/**
 * audit 2026-10-06 T4-3 (spark.md F5): an OPEN OWNER directive on the
 * supervisor's own ledger is an owner ask — it is counted into
 * owner_asks_open / owner_asks_new_since and it PINS the sweep: an act-mode
 * "quiet" verdict never skips a sweep while one is open (spark's 03:12Z sweep
 * — the one the supervisor's note said would "verify restore + attribution" —
 * was skipped with two owner incident directives open). Kill switch
 * SWEEP_TRIAGE_OWNER_DIRECTIVES_DISABLED=1 (no directive read, no pin). Read per call.
 */
export function sweepTriageOwnerDirectivesDisabled(): boolean {
  return onFlag(process.env.SWEEP_TRIAGE_OWNER_DIRECTIVES_DISABLED);
}

/** The ACT heartbeat floor in ticks (every Nth due tick fires regardless). */
export function sweepHeartbeatTicks(): number {
  const raw = Number(process.env.DECISION_GATE_SWEEP_HEARTBEAT_TICKS);
  const v = Number.isFinite(raw) ? Math.floor(raw) : SWEEP_TRIAGE_DEFAULT_HEARTBEAT_TICKS;
  return Math.min(24, Math.max(2, v));
}

/** Consecutive ACT skips encoded in the row's lastStatus (0 for anything else). Pure. */
export function consecutiveSweepSkips(lastStatus: unknown): number {
  if (typeof lastStatus !== 'string' || !lastStatus.startsWith(SWEEP_SKIP_STATUS_PREFIX)) return 0;
  const tail = lastStatus.slice(SWEEP_SKIP_STATUS_PREFIX.length);
  if (!tail) return 1;
  const n = Number(tail.replace(/^:/, ''));
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** The lastStatus for an ACT skip. Pure. */
export function sweepSkipStatus(consecutive: number): string {
  return `${SWEEP_SKIP_STATUS_PREFIX}:${Math.max(1, Math.floor(consecutive))}`;
}

// ── The code-computed delta ──────────────────────────────────────────────────

export interface SweepSnapshot {
  sweep: SweepClass;
  /** ISO start of the window (the previous firing, else one cadence back). */
  since: string;
  windowMin: number;
  scopeChats: number;
  lanes: {
    running: number;
    startedSince: number;
    finishedSince: number;
    failedSince: number;
    cancelledSince: number;
    queued: number;
  };
  /** hook_events queued for THIS supervisor's hooks in the window. */
  hookEvents: { total: number; pending: number; byType: Record<string, number> };
  ownerAsks: { open: number; newSince: number };
  /** audit 2026-10-06 T4-3: open OWNER-origin directives on THIS supervisor's ledger (already folded into ownerAsks). Absent under the kill switch. */
  ownerDirectives?: { open: number; newSince: number; ids: string[] };
  newTicketsSince: number;
  /** The project's latest status card (project sweeps only). */
  projectStatus?: {
    headline: string;
    unchanged: boolean;
    quietChecks?: number;
    goals?: { active: number; done: number; blocked: number };
    todos?: { inProgress: number; pending: number; blocked: number; doneSince: number };
    lanesRunning?: number;
    ownerItems?: number;
    generatedAt?: string;
  } | null;
  /** The supervisor's own last assistant note (its previous close-out). */
  lastNote?: { kind: string; ageMin: number; head: string } | null;
}

export interface SweepSnapshotOpts {
  sessionId: string;
  sweep: SweepClass;
  since: Date;
  now: Date;
}

const clip = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Read the delta since the previous sweep from the ledger. Every read is
 * bounded; a missing supervisor chat returns null (no state ⇒ no decision).
 * Throws propagate to the caller, which fails open.
 */
export async function computeSweepSnapshot(opts: SweepSnapshotOpts): Promise<SweepSnapshot | null> {
  const { sessionId, sweep, since, now } = opts;
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: sessionId },
    select: { id: true, userId: true, projectId: true, isSupervisor: true, isProjectSupervisor: true },
  });
  if (!chat) return null;
  const projectScoped = sweep === 'project' && !!chat.projectId;
  const scope = await prisma.crossModelChat.findMany({
    where: {
      id: { not: sessionId },
      archivedAt: null,
      ...(projectScoped ? { projectId: chat.projectId as string } : { userId: chat.userId }),
    },
    select: { id: true },
    take: SWEEP_TRIAGE_MAX_SCOPE_CHATS,
  });
  const scopeIds = scope.map((c) => c.id);

  const [runs, hooks, asks, newTicketsSince, note] = await Promise.all([
    scopeIds.length
      ? prisma.agentRun.findMany({
          where: { sessionId: { in: scopeIds }, OR: [{ status: 'running' }, { status: 'queued' }, { updatedAt: { gte: since } }] },
          select: { status: true, sessionId: true, startedAt: true },
          take: SWEEP_TRIAGE_MAX_RUNS,
        })
      : Promise.resolve([] as Array<{ status: string; sessionId: string; startedAt: Date | null }>),
    prisma.eventHook.findMany({ where: { targetChatId: sessionId, enabled: true }, select: { id: true } }),
    prisma.ownerQuestion.findMany({
      where: { userId: chat.userId, status: 'open', ...(projectScoped ? { chatId: { in: [sessionId, ...scopeIds] } } : {}) },
      select: { createdAt: true },
      take: SWEEP_TRIAGE_MAX_ASKS,
    }),
    prisma.userFeatureRequest.count({ where: { userId: chat.userId, createdAt: { gte: since } } }),
    prisma.crossModelMessage.findFirst({
      where: { chatId: sessionId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
      select: { content: true, createdAt: true },
    }),
  ]);

  const hookIds = hooks.map((h) => h.id);
  const events = hookIds.length
    ? await prisma.hookEvent.findMany({
        where: { hookId: { in: hookIds }, createdAt: { gte: since } },
        select: { eventType: true, status: true },
        take: SWEEP_TRIAGE_MAX_EVENTS,
      })
    : [];

  const runningLanes = new Set<string>();
  const lanes = { running: 0, startedSince: 0, finishedSince: 0, failedSince: 0, cancelledSince: 0, queued: 0 };
  for (const r of runs) {
    if (r.status === 'running') runningLanes.add(r.sessionId);
    else if (r.status === 'queued') lanes.queued += 1;
    else if (r.status === 'completed') lanes.finishedSince += 1;
    else if (r.status === 'failed') lanes.failedSince += 1;
    else if (r.status === 'cancelled' || r.status === 'interrupted') lanes.cancelledSince += 1;
    if (r.startedAt && r.startedAt.getTime() >= since.getTime()) lanes.startedSince += 1;
  }
  lanes.running = runningLanes.size;

  const byType: Record<string, number> = {};
  let pending = 0;
  for (const e of events) {
    byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;
    if (e.status === 'pending' || e.status === 'delivering') pending += 1;
  }

  let projectStatus: SweepSnapshot['projectStatus'] = null;
  if (projectScoped) {
    try {
      const { getLatestProjectStatus } = await import('../fleet/project-status.service');
      const card = await getLatestProjectStatus(chat.projectId as string);
      if (card?.status) {
        // 2026-09-29 change-only cards: no "no change" stub is written any
        // more — a card older than an hour means "no milestone since it", so
        // the decision state keeps the stub's meaning (unchanged + quietChecks
        // = whole hours since) and its input distribution does not shift.
        const ageMs = card.generatedAt ? now.getTime() - Date.parse(card.generatedAt) : NaN;
        const statusMod: any = await import('../fleet/project-status.service');
        const changeOnly = typeof statusMod.projectStatusHourlyEnabled === 'function' && !statusMod.projectStatusHourlyEnabled();
        const synthQuiet = changeOnly && card.unchanged !== true && Number.isFinite(ageMs) && ageMs >= 60 * 60 * 1000;
        projectStatus = {
          headline: clip(card.status.headline, 240),
          unchanged: card.unchanged === true || synthQuiet,
          ...(typeof card.quietChecks === 'number' ? { quietChecks: card.quietChecks } : synthQuiet ? { quietChecks: Math.floor(ageMs / (60 * 60 * 1000)) } : {}),
          ...(card.status.goals ? { goals: card.status.goals } : {}),
          ...(card.status.todos ? { todos: card.status.todos } : {}),
          ...(typeof card.status.lanesRunning === 'number' ? { lanesRunning: card.status.lanesRunning } : {}),
          ...(typeof card.status.ownerItems === 'number' ? { ownerItems: card.status.ownerItems } : {}),
          ...(card.generatedAt ? { generatedAt: card.generatedAt } : {}),
        };
      }
    } catch (err: any) {
      logger.debug?.(`sweep-triage: project status card unavailable for ${sessionId.slice(0, 8)}: ${err?.message ?? err}`);
      projectStatus = null;
    }
  }

  // audit 2026-10-06 T4-3: open owner directives are owner asks. Best-effort —
  // a failed read leaves the snapshot exactly as before.
  let ownerDirectives: SweepSnapshot['ownerDirectives'];
  if (!sweepTriageOwnerDirectivesDisabled()) {
    try {
      const st = await import('./supervisor-state.service');
      const doc = await st.getSupervisorState(sessionId);
      ownerDirectives = st.countOpenOwnerDirectives(doc, now, { sinceMs: since.getTime() });
    } catch { ownerDirectives = undefined; }
  }

  let lastNote: SweepSnapshot['lastNote'] = null;
  if (note) {
    let kind = 'unclassified';
    try {
      const { classifySupervisorNote } = await import('./supervisor.service');
      kind = classifySupervisorNote(note.content);
    } catch { kind = 'unclassified'; }
    lastNote = { kind, ageMin: Math.max(0, Math.round((now.getTime() - note.createdAt.getTime()) / 60000)), head: clip(note.content, SWEEP_TRIAGE_NOTE_HEAD_CHARS) };
  }

  return {
    sweep,
    since: since.toISOString(),
    windowMin: Math.max(0, Math.round((now.getTime() - since.getTime()) / 60000)),
    scopeChats: scopeIds.length,
    lanes,
    hookEvents: { total: events.length, pending, byType },
    ownerAsks: {
      open: asks.length + (ownerDirectives?.open ?? 0),
      newSince: asks.filter((a) => a.createdAt.getTime() >= since.getTime()).length + (ownerDirectives?.newSince ?? 0),
    },
    ...(ownerDirectives ? { ownerDirectives } : {}),
    newTicketsSince,
    projectStatus,
    lastNote,
  };
}

/** The gate state — the snapshot with its numbers flattened for a small
 *  model (counts first, prose last). Pure; ≤ ~2k chars. */
export function buildSweepTriageState(snap: SweepSnapshot): Record<string, unknown> {
  const movement =
    snap.lanes.finishedSince + snap.lanes.failedSince + snap.lanes.cancelledSince + snap.lanes.startedSince +
    snap.hookEvents.total + snap.ownerAsks.newSince + snap.newTicketsSince;
  const state: Record<string, unknown> = {
    sweep: snap.sweep === 'fleet' ? 'fleet supervisor sweep (all of the owner\'s lanes)' : 'project supervisor sweep (one project\'s lanes)',
    window_minutes_since_previous_sweep: snap.windowMin,
    lanes_in_scope: snap.scopeChats,
    lanes_running_now: snap.lanes.running,
    runs_queued_now: snap.lanes.queued,
    runs_started_since: snap.lanes.startedSince,
    runs_finished_since: snap.lanes.finishedSince,
    runs_failed_since: snap.lanes.failedSince,
    runs_cancelled_since: snap.lanes.cancelledSince,
    hook_events_since: snap.hookEvents.total,
    hook_events_still_pending: snap.hookEvents.pending,
    hook_event_types_since: Object.keys(snap.hookEvents.byType).length ? snap.hookEvents.byType : undefined,
    owner_asks_open: snap.ownerAsks.open,
    owner_asks_new_since: snap.ownerAsks.newSince,
    tickets_filed_since: snap.newTicketsSince,
    total_movement_events_since: movement,
    project_status_card: snap.projectStatus
      ? {
          headline: snap.projectStatus.headline,
          unchanged_since_previous_card: snap.projectStatus.unchanged,
          quiet_checks: snap.projectStatus.quietChecks,
          goals: snap.projectStatus.goals,
          todos: snap.projectStatus.todos,
          owner_items: snap.projectStatus.ownerItems,
        }
      : undefined,
    previous_sweep_note: snap.lastNote
      ? { class: snap.lastNote.kind, minutes_ago: snap.lastNote.ageMin, head: snap.lastNote.head }
      : undefined,
  };
  for (const k of Object.keys(state)) if (state[k] === undefined) delete state[k];
  return state;
}

/** The typed question — the wake_triage vocabulary applied to a sweep. */
export const SWEEP_TRIAGE_QUESTIONS: Record<string, DecisionQuestion> = {
  [SWEEP_TRIAGE_QUESTION]: {
    type: 'noul',
    instructions: 'Since the previous sweep something moved that requires the supervisor to act now (steer, dispatch, re-arm, close, unblock, escalate) — a full supervisor turn would do real work rather than closing as a no-op.',
    criteria: {
      true: 'a run failed or was cancelled, a lane finished and needs follow-up, hook events or owner asks are waiting, new tickets were filed, the project status card changed, or the previous sweep left an action open',
      false: 'nothing finished, failed or was filed; no events or asks are waiting; running lanes are still running; the status card is unchanged and the previous sweep closed as a no-op',
    },
  },
};

// ── The consumer entry point (called from coding/schedule.service processDueScheduleRow) ──

export interface SweepTriageResult {
  /** The sweep class, null when the firing is not a stock sweep (nothing consulted). */
  sweep: SweepClass | null;
  decision: DecideResult | null;
  /** SHADOW/ACT-fired: the stash the firing carries to its finalize (null when labels are off or no decision). */
  stash: DecisionStash | null;
  /** ACT only: the caller skips this firing. */
  skip: { needsTurn: number; consecutive: number; sweep: SweepClass } | null;
}

const NO_TRIAGE: SweepTriageResult = { sweep: null, decision: null, stash: null, skip: null };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Pre-triage ONE due schedule firing. Non-sweep prompts and mode 'off'
 * return NO_TRIAGE without touching the DB or the seat. Never
 * throws — every failure returns NO_TRIAGE so the firing proceeds unchanged.
 */
export async function preTriageSweepFiring(
  s: { id: string; sessionId: string; prompt: string; lastFiredAt?: Date | null; intervalSec?: number | null; lastStatus?: string | null },
  now: Date = new Date(),
): Promise<SweepTriageResult> {
  try {
    const sweep = classifySweepPrompt(s.prompt);
    if (!sweep) return NO_TRIAGE;
    const mode = decisionMode('sweep_triage');
    if (mode === 'off') return NO_TRIAGE;

    const cadenceMs = Math.max(60_000, (s.intervalSec ?? 3600) * 1000);
    const floor = now.getTime() - SWEEP_TRIAGE_MAX_WINDOW_MS;
    const sinceMs = s.lastFiredAt ? s.lastFiredAt.getTime() : now.getTime() - cadenceMs;
    const since = new Date(Math.min(now.getTime(), Math.max(floor, sinceMs)));

    const snapshot = await withTimeout(computeSweepSnapshot({ sessionId: s.sessionId, sweep, since, now }), SWEEP_TRIAGE_SNAPSHOT_TIMEOUT_MS, 'sweep snapshot');
    if (!snapshot) return { ...NO_TRIAGE, sweep };

    const decision = await decide(buildSweepTriageState(snapshot), SWEEP_TRIAGE_QUESTIONS, {
      purpose: 'sweep_triage', timeoutMs: SWEEP_TRIAGE_TIMEOUT_MS, sessionId: s.sessionId,
    });
    if (!decision) return { ...NO_TRIAGE, sweep };

    const a = decision.answers[SWEEP_TRIAGE_QUESTION];
    const p = a && a.type === 'noul' ? a.noul : 1;
    const threshold = decisionThreshold('sweep_triage', SWEEP_TRIAGE_DEFAULT_THRESHOLD);
    const quiet = p <= 1 - threshold;
    // E2 (2026-09-25): the RESULT's mode gates acting — an uncalibrated backend answers as 'shadow'.
    // backlog E12 (2026-09-28): a confident-quiet act skip fires as a CONTROL one time in N (drawSweepControl),
    // and the heartbeat-floor fire is a control too — both stamp `control:true` on the stash so the
    // finalize's label row is identifiable as the skip band's own action rate.
    let control: 'sample' | 'heartbeat' | null = null;
    // audit 2026-10-06 T4-3: an open OWNER directive pins the sweep — a
    // confident-quiet act verdict fires anyway (deterministic; never a skip).
    const ownerPin = decision.mode === 'act' && quiet && !sweepTriageOwnerDirectivesDisabled()
      && (snapshot.ownerDirectives?.open ?? 0) > 0;
    if (ownerPin) {
      logger.info(`sweep-triage: ${s.id} pinned — ${snapshot.ownerDirectives!.open} open owner directive(s) on the supervisor ledger; the ${sweep} sweep fires despite needs_turn ${p.toFixed(2)} (audit 2026-10-06 T4-3)`);
      try {
        const { recordLoopMetric } = await import('./loop-metrics.service');
        recordLoopMetric({ kind: 'sweep_triage_owner_pin', sessionId: s.sessionId, meta: { scheduleId: s.id, sweep, needsTurn: p, ownerDirectivesOpen: snapshot.ownerDirectives!.open, directiveIds: snapshot.ownerDirectives!.ids } });
      } catch { /* telemetry never blocks */ }
    }
    if (decision.mode === 'act' && quiet && !ownerPin) {
      const consecutive = consecutiveSweepSkips(s.lastStatus);
      if (consecutive < sweepHeartbeatTicks() - 1) {
        if (drawSweepControl()) {
          control = 'sample';
          logger.info(`sweep-triage: ${s.id} control sample — ${sweep} sweep fires instead of skip ${consecutive + 1} (needs_turn ${p.toFixed(2)})`);
        } else {
          recordDecisionOutcome(decision, 'sweep_triage', {
            question: SWEEP_TRIAGE_QUESTION, actual: null, acted: true, sessionId: s.sessionId,
            note: `skipped ${sweep} sweep (needs_turn ${p.toFixed(2)}, skip ${consecutive + 1}/${sweepHeartbeatTicks() - 1})`,
          });
          return { sweep, decision, stash: null, skip: { needsTurn: p, consecutive: consecutive + 1, sweep } };
        }
      } else {
        // Heartbeat floor reached — fire regardless; the label still applies.
        control = 'heartbeat';
        logger.info(`sweep-triage: ${s.id} heartbeat floor — ${sweep} sweep fires after ${consecutive} quiet skip(s) (needs_turn ${p.toFixed(2)})`);
      }
    }
    // A pinned fire is NOT a band row the rule chose — it is excluded from the
    // readiness fit like supervisor_turn_noop's pinned turns.
    const controlExtra = control
      ? { extra: { control: true, controlReason: control } }
      // (the supervisor_turn_noop convention: stash extra.pinned:true ⇒ the
      // finalize's outcome row is excludeFromFit).
      : ownerPin ? { extra: { pinned: true, pins: ['owner_directive_open'] } } : {};
    return { sweep, decision, stash: stashDecision(decision, 'sweep_triage', controlExtra), skip: null };
  } catch (err: any) {
    logger.warn(`sweep-triage: ${s.id} failed open (${err?.message ?? err}) — the sweep fires as before`);
    return NO_TRIAGE;
  }
}
