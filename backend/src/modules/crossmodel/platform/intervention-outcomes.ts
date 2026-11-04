/**
 * Supervisor INTERVENTION OUTCOMES (supervisor SOTA round 2, 2026-10-20 —
 * INTERVENTION-OUTCOMES): every lane intervention a supervisor makes is
 * labelled by what the lane did AFTERWARDS, so a supervisor can tell an
 * effective lever from a useless one. Before this, every metric rewarded
 * "acted" (supervisor_material_gate_outcome, wake_triage labels), never "the
 * lane moved": SupervisorDispatch rows carry no outcome, no steer / dispatch
 * outcome kind existed, and ~94 % of the autonomous spend was attributed to
 * nothing. The only labelling precedent is session-topology-outcomes.ts.
 *
 *  1. CAPTURE (recordSupervisorInterventions, the supervisor chat finalize):
 *     each ok receipt of a LANE LEVER (INTERVENTION_LEVERS — spawn / steer /
 *     schedule / answer) whose target is a coding lane (a chat with a coding
 *     state, never a supervisor, never the supervisor itself) writes ONE
 *     `supervisor_intervention` loop_metrics row per (turn, lane):
 *     { supervisorChatId, targetChatId, goalId, todoId, projectId, kind,
 *       tools, receiptId, turnId, at (the receipt's own time), liveRun,
 *       origin }. `answer` = the turn only answered the lane's OWN question /
 *     permission request (lane-initiated — never a repeat of an earlier lever);
 *     `liveRun` = a lever acted on the run live at that moment (a
 *     send_chat_message steered INTO it, an answer / approval it waited on).
 *     A no-op receipt (delivered:'already', changed:false) is not an
 *     intervention. Halt levers (stop_run / pause_schedule / cancel_schedule)
 *     are NOT captured — their intended effect is the absence of runs, which
 *     the progress vocabulary below cannot measure.
 *  2. LABEL (runInterventionOutcomesOnce, worker cron every
 *     INTERVENTION_OUTCOMES_INTERVAL_SEC): each row is labelled at +6 h and at
 *     +24 h — one `supervisor_intervention_outcome` row per horizon — as
 *       progressed        the lane minted an artifact receipt (PR open / merge,
 *                         push, register_artifact) from an ATTRIBUTABLE run,
 *                         before any repeat;
 *       repeated          the same supervisor pulled a lever on the same lane
 *                         again (a later turn, ≥ REPEAT_MIN_GAP_MS later; an
 *                         `answer` never counts) before that;
 *       ran_no_artifact   an attributable run was active inside the window and
 *                         no artifact landed;
 *       no_run            no run was active on the lane inside the window;
 *       null              ambiguous — label conservatively, and the SAME way
 *                         for good and bad windows: the lane is gone, the only
 *                         activity (artifact or not) came from a run already
 *                         in flight that the lever did not act on, the run
 *                         read was truncated, the owner typed on the lane or
 *                         another supervisor intervened inside the window the
 *                         label rests on, the lane was archived, or the
 *                         labeller fell behind (label_expired).
 *     ATTRIBUTABLE run = one that started at/after the intervention, or — for
 *     a liveRun intervention — the run it acted on. The in-flight rule is
 *     symmetric on purpose: an in-flight run that produced is null, so an
 *     in-flight run that produced nothing is null too (never a negative label
 *     where the matching positive could not have been given).
 *  3. SHOW (buildInterventionOutcomesBlock, supervisor MACHINE wakes): after
 *     ≥ OBSERVATION_MIN_MS (one week) of this supervisor's own rows, the
 *     [INTERVENTION OUTCOMES — 7d] block (≤ BLOCK_MAX_CHARS) renders its +24 h
 *     labels per lever and per lane — evidence, never a command.
 *
 * Attribution is coarse by design (a lane also runs on its own schedule); the
 * labels are descriptive and the block says so. Everything is bounded and
 * never throws: the capture and the block fail open (no row / no block), the
 * cron returns a ≤200-char summary. Kill switches:
 * SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED=1 (capture + labels + block) and
 * SUPERVISOR_INTERVENTION_OUTCOMES_BLOCK_DISABLED=1 (the wake block only).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { LOOP_METRIC_KINDS, recordLoopMetric } from './loop-metrics.service';
import { classifyUserRow } from './supervisor-wake-ledger';

// ── switches ────────────────────────────────────────────────────────────────

const onFlag = (v: string | undefined): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED=1: no capture rows, no labels, no wake block. */
export function interventionOutcomesDisabled(): boolean {
  return onFlag(process.env.SUPERVISOR_INTERVENTION_OUTCOMES_DISABLED);
}

/** SUPERVISOR_INTERVENTION_OUTCOMES_BLOCK_DISABLED=1: rows + labels keep flowing, the wake block is omitted. */
export function interventionOutcomesBlockDisabled(): boolean {
  return interventionOutcomesDisabled() || onFlag(process.env.SUPERVISOR_INTERVENTION_OUTCOMES_BLOCK_DISABLED);
}

/** The chat-agent seams (capture, block) stay silent in other suites unless a test opts in (the wake-ledger precedent). */
function underTest(): boolean {
  return process.env.NODE_ENV === 'test' && process.env.SUPERVISOR_INTERVENTION_OUTCOMES_IN_TEST !== '1';
}

// ── constants ───────────────────────────────────────────────────────────────

export const INTERVENTION_OUTCOMES_JOB_ID = 'supervisor-intervention-outcomes';
export const INTERVENTION_OUTCOMES_INTERVAL_SEC = 3600;
/** Label horizons, hours after the intervention. */
export const INTERVENTION_HORIZONS_H = [6, 24] as const;
export type InterventionHorizon = (typeof INTERVENTION_HORIZONS_H)[number];
/** A row stays a candidate this long past its horizon (catch-up after a missed firing / outage). */
export const LABEL_SLACK_MS = 48 * 3600_000;
/** Intervention rows read per pass over the whole 72 h scan window (≥ its normal volume, so labelled rows never starve new ones). */
export const CANDIDATE_SCAN_MAX = 8000;
/** Labels written per pass (all horizons together) — each costs ≤ 5 bounded reads. */
export const OUTCOMES_BATCH = 150;
/** Pairs past the batch that would age out before the next pass are written as null / label_expired (write-only) — at most this many a pass. */
export const EXPIRED_MARK_MAX = 500;
/** A later intervention by the same supervisor on the same lane counts as a REPEAT only this long after. */
export const REPEAT_MIN_GAP_MS = 5 * 60_000;
/** A run that started this little before the intervention still counts as started after it (clock skew). */
export const RUN_START_SLACK_MS = 5_000;
/**
 * Runs read per lane window. Only runs still unfinished at the intervention
 * are read, so the 24 h look-back never spends it on runs that ended before
 * the lever was pulled; a read that fills it is TRUNCATED.
 */
export const MAX_RUNS_PER_WINDOW = 100;
/** How far before the intervention a run still in flight at it is looked for (an older one is resolved by id when it minted an artifact). */
export const RUN_LOOKBACK_MS = 24 * 3600_000;
const MAX_ARTIFACTS_PER_WINDOW = 50;
/** User rows scanned (metadata only) per confound window; untagged ones then have their text read, at most MAX_OWNER_ROWS. */
const MAX_USER_ROWS_SCANNED = 200;
const MAX_OWNER_ROWS = 20;
/** Distinct lanes one supervisor turn can record. */
export const MAX_INTERVENTIONS_PER_TURN = 20;
/** The wake block reads this supervisor's +24 h labels over this window. */
export const BLOCK_WINDOW_MS = 7 * 24 * 3600_000;
/** The block renders only once this supervisor has been observed this long (design: after one week). */
export const OBSERVATION_MIN_MS = 7 * 24 * 3600_000;
/** The block needs at least this many labelled (non-null) rows. */
export const BLOCK_MIN_LABELLED = 3;
export const BLOCK_MAX_CHARS = 1200;
/** Whole-block read deadline — past it the wake composes without the block. */
export const BLOCK_READ_TIMEOUT_MS = 2500;
const BLOCK_MAX_ROWS = 2000;
const BLOCK_MAX_LANES = 30;

/** Receipt tools that mean the lane produced something (the wake ledger's artifact vocabulary). */
export const ARTIFACT_RECEIPT_TOOLS: readonly string[] = ['open_pull_request', 'merge_pull_request', 'git_push', 'push_to_github', 'register_artifact'];

export type InterventionKind = 'spawn' | 'steer' | 'schedule' | 'answer';
export type InterventionOutcome = 'progressed' | 'ran_no_artifact' | 'no_run' | 'repeated';
export type InterventionNullReason =
  | 'target_missing' | 'in_flight_run' | 'owner_confounded' | 'other_supervisor_confounded' | 'target_archived'
  | 'run_window_truncated' | 'label_expired';
export interface InterventionVerdict { outcome: InterventionOutcome | null; reason: InterventionNullReason | null }

/**
 * The lane LEVERS a supervisor pulls and where each receipt names its lane
 * (the envelope ids: send_chat_message / schedule_message / update_schedule /
 * answer_chat_question / approve_request / resume_schedule → chatId (a moot
 * resume carries none); start_coding_session → sessionId;
 * dispatch_platform_task → laneChatId). `live` levers act on the run already
 * live on the lane: an answer / approval releases the run waiting on it
 * (control-tools.ts). A send_chat_message acts on the live run only when its
 * envelope says it was steered INTO it (ids.delivery 'steer' —
 * platform-tools.ts); delivered to an idle lane it starts a new run.
 */
export const INTERVENTION_LEVERS: Readonly<Record<string, { kind: InterventionKind; idKeys: readonly string[]; live?: true }>> = {
  start_coding_session: { kind: 'spawn', idKeys: ['sessionId', 'chatId'] },
  dispatch_platform_task: { kind: 'spawn', idKeys: ['laneChatId'] },
  send_chat_message: { kind: 'steer', idKeys: ['chatId'] },
  answer_chat_question: { kind: 'answer', idKeys: ['chatId'], live: true },
  approve_request: { kind: 'answer', idKeys: ['chatId'], live: true },
  schedule_message: { kind: 'schedule', idKeys: ['chatId'] },
  update_schedule: { kind: 'schedule', idKeys: ['chatId'] },
  resume_schedule: { kind: 'schedule', idKeys: ['chatId'] },
};
/**
 * One row per (turn, lane): the strongest lever wins its kind. `answer` is the
 * weakest — it responds to the lane's own request — so a turn is filed as an
 * answer only when that is all it did on the lane.
 */
const KIND_PRIORITY: Record<InterventionKind, number> = { spawn: 4, steer: 3, schedule: 2, answer: 1 };

/** True when this ok lever receipt acted on the run live on the lane at that moment. Pure. */
export function leverActsOnLiveRun(tool: string, ids: Record<string, unknown>): boolean {
  if (INTERVENTION_LEVERS[tool]?.live) return true;
  return tool === 'send_chat_message' && (ids.delivery === 'steer' || ids.delivery === 'live');
}

/**
 * A receipt whose envelope says nothing changed — an answer / decision that
 * was "already" delivered, a schedule that was already in that state. Read
 * from the in-memory result head (≤ 200 chars, run-receipts E8); a head that
 * does not show the flag counts as a change (fail toward capture). Pure.
 */
const NOOP_RESULT_RE = /"delivered"\s*:\s*"already"|"changed"\s*:\s*false\b/;
export function receiptIsNoop(resultHead: unknown): boolean {
  return typeof resultHead === 'string' && NOOP_RESULT_RE.test(resultHead);
}

const asRecord = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {});
const ms = (d: unknown): number => {
  const t = d instanceof Date ? d.getTime() : Date.parse(String(d ?? ''));
  return Number.isFinite(t) ? t : NaN;
};

// ── 1. capture ──────────────────────────────────────────────────────────────

export interface ReceiptLike {
  id?: unknown;
  tool?: unknown;
  ok?: unknown;
  ids?: unknown;
  runId?: unknown;
  createdAt?: unknown;
  /** In-memory only (run-receipts E8): the scrubbed head of the raw result — read for the no-op flags. */
  resultHead?: unknown;
}

export interface InterventionCandidate {
  targetChatId: string;
  kind: InterventionKind;
  tools: string[];
  receiptId: string | null;
  turnId: string | null;
  /** ISO time of the FIRST lever receipt on this lane in the turn. */
  at: string;
  /** Some lever of this turn acted on the lane's live run (leverActsOnLiveRun). */
  liveRun: boolean;
}

/**
 * The lane interventions in one supervisor turn's receipts: ok, non-no-op
 * lever receipts with a resolvable target other than the supervisor itself,
 * collapsed to one per target (first receipt's id and time, the strongest
 * kind, every tool, liveRun when any lever acted on the live run). Pure;
 * never throws.
 */
export function interventionCandidatesFromReceipts(receipts: unknown, supervisorChatId: string, now: Date = new Date()): InterventionCandidate[] {
  if (!Array.isArray(receipts)) return [];
  const byTarget = new Map<string, InterventionCandidate>();
  for (const raw of receipts as ReceiptLike[]) {
    if (!raw || typeof raw !== 'object' || raw.ok !== true) continue;
    const tool = String(raw.tool ?? '');
    const lever = INTERVENTION_LEVERS[tool];
    if (!lever) continue;
    const ids = asRecord(raw.ids);
    if (ids.staged === true || receiptIsNoop(raw.resultHead)) continue;
    let target = '';
    for (const k of lever.idKeys) {
      const v = ids[k];
      if (typeof v === 'string' && v.trim()) { target = v.trim(); break; }
    }
    if (!target || target === supervisorChatId) continue;
    const t = ms(raw.createdAt);
    const at = new Date(Number.isFinite(t) ? t : now.getTime()).toISOString();
    const live = leverActsOnLiveRun(tool, ids);
    const prev = byTarget.get(target);
    if (!prev) {
      if (byTarget.size >= MAX_INTERVENTIONS_PER_TURN) continue;
      byTarget.set(target, {
        targetChatId: target, kind: lever.kind, tools: [tool],
        receiptId: typeof raw.id === 'string' && raw.id ? raw.id : null,
        turnId: typeof raw.runId === 'string' && raw.runId ? raw.runId : null,
        at, liveRun: live,
      });
      continue;
    }
    if (!prev.tools.includes(tool)) prev.tools.push(tool);
    if (KIND_PRIORITY[lever.kind] > KIND_PRIORITY[prev.kind]) prev.kind = lever.kind;
    if (live) prev.liveRun = true;
  }
  return [...byTarget.values()];
}

/**
 * Write one `supervisor_intervention` row per lane the supervisor turn acted
 * on. Targets are resolved in ONE read: a coding lane (coding state present),
 * not a supervisor chat. Fire-and-forget from the chat finalize; returns the
 * number of rows written; never throws.
 */
export async function recordSupervisorInterventions(input: {
  supervisorChatId: string;
  receipts: unknown;
  machineWake: boolean;
  supervisorTier?: 'fleet' | 'project' | null;
}): Promise<number> {
  try {
    if (interventionOutcomesDisabled() || underTest()) return 0;
    const candidates = interventionCandidatesFromReceipts(input.receipts, input.supervisorChatId);
    if (!candidates.length) return 0;
    const lanes = await prisma.crossModelChat.findMany({
      where: { id: { in: candidates.map((c) => c.targetChatId) } },
      select: { id: true, projectId: true, charterGoalId: true, charterTodoId: true, isSupervisor: true, isProjectSupervisor: true, codingState: { select: { id: true } } },
    });
    const byId = new Map(lanes.map((l: any) => [l.id, l]));
    let written = 0;
    for (const c of candidates) {
      const lane: any = byId.get(c.targetChatId);
      if (!lane || lane.isSupervisor || lane.isProjectSupervisor || !lane.codingState) continue;
      recordLoopMetric({
        kind: LOOP_METRIC_KINDS.SUPERVISOR_INTERVENTION, sessionId: input.supervisorChatId, value: 1,
        meta: {
          supervisorChatId: input.supervisorChatId, targetChatId: c.targetChatId,
          goalId: lane.charterGoalId ?? null, todoId: lane.charterTodoId ?? null, projectId: lane.projectId ?? null,
          kind: c.kind, tools: c.tools, receiptId: c.receiptId, turnId: c.turnId, at: c.at, liveRun: c.liveRun,
          origin: input.machineWake ? 'machine' : 'human', tier: input.supervisorTier ?? null,
        },
      });
      written++;
    }
    return written;
  } catch (err: any) {
    logger.warn(`intervention-outcomes: capture failed for ${String(input?.supervisorChatId ?? '').slice(0, 8)} (non-fatal): ${err?.message ?? err}`);
    return 0;
  }
}

// ── 2. labels ───────────────────────────────────────────────────────────────

export interface InterventionOutcomeFacts {
  /** The lane row still exists. */
  targetFound: boolean;
  /** Earliest artifact receipt (ms) from an attributable run, inside the window. */
  firstArtifactAt: number | null;
  /** Attributable artifact receipts inside the window. */
  artifacts: number;
  /** Artifact receipts inside the window from a run already in flight that the lever did not act on (or an unresolvable run). */
  inFlightArtifacts: number;
  /** Attributable runs active on the lane inside the window (started after the intervention, or the live run it acted on). */
  runs: number;
  /** Runs already in flight at the intervention that the lever did not act on, still active inside the window. */
  inFlightRuns: number;
  /** The run read hit MAX_RUNS_PER_WINDOW — "no attributable run" cannot be concluded from it. */
  runsTruncated: boolean;
  /** Earliest later intervention (ms) by the SAME supervisor on the same lane inside the window (never an `answer`). */
  firstRepeatAt: number | null;
  /** Someone else acted on the lane inside the window the label rests on (confoundWindowEnd). */
  confounded: 'owner' | 'other_supervisor' | null;
  /** The lane was archived at or before the window end. */
  archivedInWindow: boolean;
}

/**
 * The label for one intervention at one horizon, BEFORE the confound check.
 * Conservative and symmetric: a window whose only activity came from a run the
 * lever did not start or act on is null whether or not that run produced, and
 * a truncated run read never yields "no attributable run". Pure.
 */
export function tentativeInterventionOutcome(f: InterventionOutcomeFacts): InterventionVerdict {
  if (!f.targetFound) return { outcome: null, reason: 'target_missing' };
  if (f.firstArtifactAt != null && (f.firstRepeatAt == null || f.firstArtifactAt <= f.firstRepeatAt)) return { outcome: 'progressed', reason: null };
  // The lever had to be pulled again before anything attributable landed — any later progress belongs to the repeat.
  if (f.firstRepeatAt != null) return { outcome: 'repeated', reason: null };
  // The lane produced, but only from work already running that the lever did not act on: neither "progressed" nor "no artifact".
  if (f.inFlightArtifacts > 0) return { outcome: null, reason: 'in_flight_run' };
  // A retired lane was never going to run — not evidence about the lever.
  if (f.archivedInWindow) return { outcome: null, reason: 'target_archived' };
  if (f.runs > 0) return { outcome: 'ran_no_artifact', reason: null };
  // From here every label says "no attributable run" — which a truncated read cannot show.
  if (f.runsTruncated) return { outcome: null, reason: 'run_window_truncated' };
  // Only a run the lever did not start or act on was active: the mirror of the in-flight artifact case above.
  if (f.inFlightRuns > 0) return { outcome: null, reason: 'in_flight_run' };
  return { outcome: 'no_run', reason: null };
}

/**
 * The exclusive end (ms) of the window a label rests on, over which the
 * owner / other-supervisor confound is checked: up to the first artifact for
 * progressed, up to the repeat for repeated, the whole window (inclusive end)
 * for ran_no_artifact / no_run. Pure.
 */
export function confoundWindowEnd(outcome: InterventionOutcome, f: Pick<InterventionOutcomeFacts, 'firstArtifactAt' | 'firstRepeatAt'>, windowEnd: number): number {
  if (outcome === 'progressed' && f.firstArtifactAt != null) return f.firstArtifactAt;
  if (outcome === 'repeated' && f.firstRepeatAt != null) return f.firstRepeatAt;
  return windowEnd + 1;
}

/**
 * The final label: the tentative one, made null when the owner or another
 * supervisor acted inside the window it rests on — for EVERY non-null label,
 * so a negative label is confounded exactly like a positive one. Pure.
 */
export function judgeInterventionOutcome(f: InterventionOutcomeFacts): InterventionVerdict {
  const t = tentativeInterventionOutcome(f);
  if (t.outcome == null) return t;
  if (f.confounded === 'owner') return { outcome: null, reason: 'owner_confounded' };
  if (f.confounded === 'other_supervisor') return { outcome: null, reason: 'other_supervisor_confounded' };
  return t;
}

/** One intervention row as the labeller reads it. */
export interface InterventionRow {
  key: string;
  supervisorChatId: string;
  targetChatId: string;
  at: number;
  turnId: string | null;
  kind: string;
  /** The intervention acted on the lane's live run — that run counts as attributable. */
  liveRun: boolean;
}

/** Parse a supervisor_intervention loop_metrics row; null when unusable. Pure. */
export function parseInterventionRow(row: { id: string; sessionId?: string | null; meta?: unknown; createdAt: Date }): InterventionRow | null {
  const m = asRecord(row.meta);
  const sup = typeof m.supervisorChatId === 'string' && m.supervisorChatId ? m.supervisorChatId : (row.sessionId ?? '');
  const target = typeof m.targetChatId === 'string' ? m.targetChatId : '';
  if (!sup || !target) return null;
  const t = ms(m.at);
  return {
    key: row.id, supervisorChatId: sup, targetChatId: target, at: Number.isFinite(t) ? t : row.createdAt.getTime(),
    turnId: typeof m.turnId === 'string' && m.turnId ? m.turnId : null,
    kind: typeof m.kind === 'string' ? m.kind : '', liveRun: m.liveRun === true,
  };
}

/**
 * The repeat / other-supervisor facts from every intervention row on the same
 * lane (preloaded once per pass). An `answer` by the same supervisor responds
 * to the lane's own request — never a repeat; another supervisor's row of any
 * kind is a confound. Pure.
 */
export function repeatFacts(self: InterventionRow, sameLane: readonly InterventionRow[], windowEnd: number): { firstRepeatAt: number | null; otherSupervisorAts: number[] } {
  let firstRepeatAt: number | null = null;
  const otherSupervisorAts: number[] = [];
  for (const o of sameLane) {
    if (o.key === self.key || o.targetChatId !== self.targetChatId) continue;
    if (o.at <= self.at || o.at > windowEnd) continue;
    if (o.supervisorChatId === self.supervisorChatId) {
      if (o.kind === 'answer') continue;
      if (self.turnId && o.turnId === self.turnId) continue;
      if (o.at - self.at < REPEAT_MIN_GAP_MS) continue;
      if (firstRepeatAt == null || o.at < firstRepeatAt) firstRepeatAt = o.at;
    } else {
      otherSupervisorAts.push(o.at);
    }
  }
  return { firstRepeatAt, otherSupervisorAts };
}

interface RunLite { id: string; createdAt: Date; startedAt: Date | null; finishedAt?: Date | null }

/**
 * Is a run that started at `start` attributable to an intervention at `at`?
 * Started at/after it (5 s slack), or — for a liveRun intervention — already
 * running when the lever acted on it. Pure.
 */
function runAttributable(start: number, at: number, liveRun: boolean): boolean {
  return start >= at - RUN_START_SLACK_MS || liveRun;
}

/**
 * Split the window's artifact receipts by whether the run that minted them is
 * attributable (runAttributable) or was already in flight without the lever
 * acting on it / cannot be resolved. Pure.
 */
export function attributeArtifacts(
  at: number,
  artifacts: ReadonlyArray<{ runId: string | null; createdAt: Date }>,
  runs: ReadonlyArray<RunLite>,
  liveRun = false,
): { firstArtifactAt: number | null; attributable: number; inFlight: number } {
  const startById = new Map<string, number>();
  for (const r of runs) startById.set(r.id, (r.startedAt ?? r.createdAt).getTime());
  let firstArtifactAt: number | null = null;
  let attributable = 0;
  let inFlight = 0;
  for (const a of artifacts) {
    const start = a.runId ? startById.get(a.runId) : undefined;
    if (start == null || !runAttributable(start, at, liveRun)) { inFlight++; continue; }
    attributable++;
    const t = a.createdAt.getTime();
    if (firstArtifactAt == null || t < firstArtifactAt) firstArtifactAt = t;
  }
  return { firstArtifactAt, attributable, inFlight };
}

/**
 * Runs active inside [at, end] (started by the end, not finished before the
 * intervention), split the SAME way attributeArtifacts splits their
 * artifacts: attributable vs already in flight without the lever acting on
 * them. Never-started (queued) rows do not count. Pure.
 */
export function activeRunSplit(at: number, end: number, runs: ReadonlyArray<{ startedAt: Date | null; finishedAt?: Date | null }>, liveRun = false): { attributable: number; inFlight: number } {
  let attributable = 0;
  let inFlight = 0;
  for (const r of runs) {
    if (!r.startedAt) continue;
    const s = r.startedAt.getTime();
    if (s > end) continue;
    if (r.finishedAt && r.finishedAt.getTime() < at) continue;
    if (runAttributable(s, at, liveRun)) attributable++; else inFlight++;
  }
  return { attributable, inFlight };
}

const RUN_SELECT = { id: true, createdAt: true, startedAt: true, finishedAt: true } as const;

/**
 * Did the OWNER type on the lane in (after, before)? Two bounded reads: the
 * window's user rows by metadata only (agent sends and machine traffic carry an
 * origin and are settled without their text), then the text head of the
 * untagged ones — so a busy lane's wake / steer rows never crowd an owner row
 * out of the read.
 */
async function ownerTypedOnLane(chatId: string, after: number, before: number): Promise<boolean> {
  if (!(before > after)) return false;
  const rows = await prisma.crossModelMessage.findMany({
    where: { chatId, role: 'user', createdAt: { gt: new Date(after), lt: new Date(before) } },
    select: { id: true, metadata: true },
    orderBy: { createdAt: 'asc' }, take: MAX_USER_ROWS_SCANNED,
  });
  const untagged = (rows as any[]).filter((m) => { const o = asRecord(m?.metadata).origin; return !o || o === 'user'; }).slice(0, MAX_OWNER_ROWS);
  if (!untagged.length) return false;
  const texts = await prisma.crossModelMessage.findMany({
    where: { id: { in: untagged.map((m) => String(m.id)) } },
    select: { content: true, metadata: true },
  });
  return (texts as any[]).some((m) => classifyUserRow(String(m?.content ?? '').slice(0, 400), asRecord(m?.metadata).origin ?? null) === 'owner');
}

async function factsFor(
  row: InterventionRow,
  horizonH: InterventionHorizon,
  lane: { archivedAt: Date | null } | undefined,
  sameLane: readonly InterventionRow[],
): Promise<InterventionOutcomeFacts> {
  const end = row.at + horizonH * 3600_000;
  const f: InterventionOutcomeFacts = {
    targetFound: !!lane, firstArtifactAt: null, artifacts: 0, inFlightArtifacts: 0, runs: 0, inFlightRuns: 0, runsTruncated: false,
    firstRepeatAt: null, confounded: null, archivedInWindow: false,
  };
  if (!lane) return f;
  f.archivedInWindow = !!(lane.archivedAt && lane.archivedAt.getTime() <= end);
  const [runs, artifacts] = await Promise.all([
    // Only runs that can matter: created by the window end and NOT finished before the intervention —
    // a busy lane's pre-intervention history never fills the cap ahead of the runs the label rests on.
    prisma.agentRun.findMany({
      where: {
        sessionId: row.targetChatId,
        createdAt: { gte: new Date(row.at - RUN_LOOKBACK_MS), lte: new Date(end) },
        OR: [{ finishedAt: null }, { finishedAt: { gte: new Date(row.at) } }],
      },
      select: RUN_SELECT,
      orderBy: { createdAt: 'asc' }, take: MAX_RUNS_PER_WINDOW,
    }),
    prisma.runToolReceipt.findMany({
      where: { chatId: row.targetChatId, ok: true, tool: { in: [...ARTIFACT_RECEIPT_TOOLS] }, createdAt: { gt: new Date(row.at), lte: new Date(end) } },
      select: { runId: true, createdAt: true },
      orderBy: { createdAt: 'asc' }, take: MAX_ARTIFACTS_PER_WINDOW,
    }),
  ]);
  const readRuns = runs as RunLite[];
  f.runsTruncated = readRuns.length >= MAX_RUNS_PER_WINDOW;
  // An artifact whose run the window read did not return (past the cap, or started before the look-back) is
  // resolved by id — never filed as "in flight" just because the read missed it.
  const known = new Set(readRuns.map((r) => r.id));
  const missing = [...new Set((artifacts as any[]).map((a) => a.runId).filter((id): id is string => typeof id === 'string' && !!id && !known.has(id)))];
  const extra = missing.length
    ? await prisma.agentRun.findMany({ where: { id: { in: missing } }, select: RUN_SELECT }) as RunLite[]
    : [];
  const allRuns = [...readRuns, ...extra];
  const split = activeRunSplit(row.at, end, allRuns, row.liveRun);
  f.runs = split.attributable;
  f.inFlightRuns = split.inFlight;
  const attr = attributeArtifacts(row.at, artifacts as any[], allRuns, row.liveRun);
  f.firstArtifactAt = attr.firstArtifactAt;
  f.artifacts = attr.attributable;
  f.inFlightArtifacts = attr.inFlight;
  const rep = repeatFacts(row, sameLane, end);
  f.firstRepeatAt = rep.firstRepeatAt;
  // Confounds apply to EVERY label that would be given — positive or negative — over the window it rests on.
  const tentative = tentativeInterventionOutcome(f);
  if (tentative.outcome != null) {
    const cutoff = confoundWindowEnd(tentative.outcome, f, end);
    if (rep.otherSupervisorAts.some((t) => t < cutoff)) f.confounded = 'other_supervisor';
    if (await ownerTypedOnLane(row.targetChatId, row.at, cutoff)) f.confounded = 'owner';
  }
  return f;
}

/** Write one supervisor_intervention_outcome row. */
function writeOutcomeRow(row: InterventionRow, h: InterventionHorizon, src: Record<string, any>, verdict: InterventionVerdict, facts: InterventionOutcomeFacts | null): void {
  recordLoopMetric({
    kind: LOOP_METRIC_KINDS.SUPERVISOR_INTERVENTION_OUTCOME, sessionId: row.supervisorChatId, value: verdict.outcome === 'progressed' ? 1 : 0,
    meta: {
      interventionKey: row.key, horizonH: h, supervisorChatId: row.supervisorChatId, targetChatId: row.targetChatId,
      goalId: src.goalId ?? null, projectId: src.projectId ?? null, kind: src.kind ?? null, tools: Array.isArray(src.tools) ? src.tools : [],
      receiptId: src.receiptId ?? null, origin: src.origin ?? null, at: new Date(row.at).toISOString(), liveRun: row.liveRun,
      outcome: verdict.outcome, reason: verdict.reason,
      ...(facts ? {
        ...facts,
        firstArtifactAt: facts.firstArtifactAt != null ? new Date(facts.firstArtifactAt).toISOString() : null,
        firstRepeatAt: facts.firstRepeatAt != null ? new Date(facts.firstRepeatAt).toISOString() : null,
      } : {}),
    },
  });
}

/** One pass: label due rows at every horizon. Returns the ≤200-char summary for cron_jobs.lastStatus. Never throws. */
export async function runInterventionOutcomesOnce(now: Date = new Date()): Promise<string> {
  if (interventionOutcomesDisabled()) return 'disabled';
  try {
    const maxH = Math.max(...INTERVENTION_HORIZONS_H);
    const minH = Math.min(...INTERVENTION_HORIZONS_H);
    // Every row that can be due at any horizon, plus the later rows its window can see (repeats / confounds).
    const scanFrom = new Date(now.getTime() - maxH * 3600_000 - LABEL_SLACK_MS);
    const all = await prisma.loopMetric.findMany({
      where: { kind: LOOP_METRIC_KINDS.SUPERVISOR_INTERVENTION, createdAt: { gte: scanFrom } },
      orderBy: { createdAt: 'asc' }, take: CANDIDATE_SCAN_MAX,
      select: { id: true, sessionId: true, meta: true, createdAt: true },
    });
    const metaByKey = new Map<string, Record<string, any>>((all as any[]).map((a) => [a.id, asRecord(a.meta)]));
    const rows = (all as any[]).map(parseInterventionRow).filter((r): r is InterventionRow => !!r);
    const due = rows.filter((r) => r.at <= now.getTime() - minH * 3600_000);
    if (!due.length) return 'no interventions to label';
    // No catch: an unreadable dedupe set fails the pass (outer catch) — never a second label for every row.
    const labelled = await prisma.loopMetric.findMany({
      where: { kind: LOOP_METRIC_KINDS.SUPERVISOR_INTERVENTION_OUTCOME, createdAt: { gte: scanFrom } },
      select: { meta: true }, take: CANDIDATE_SCAN_MAX * INTERVENTION_HORIZONS_H.length,
    });
    const done = new Set<string>((labelled as any[]).map((r) => { const m = asRecord(r.meta); return `${m.interventionKey ?? ''}:${m.horizonH ?? ''}`; }));
    const byLane = new Map<string, InterventionRow[]>();
    for (const r of rows) { const l = byLane.get(r.targetChatId) ?? []; l.push(r); byLane.set(r.targetChatId, l); }
    // Work list: (row, horizon) pairs that are due, inside their slack, not labelled yet — nearest to ageing out first.
    const work: Array<{ row: InterventionRow; h: InterventionHorizon; dueAt: number }> = [];
    for (const r of due) {
      for (const h of INTERVENTION_HORIZONS_H) {
        const dueAt = r.at + h * 3600_000;
        if (dueAt > now.getTime() || now.getTime() - dueAt > LABEL_SLACK_MS) continue;
        if (done.has(`${r.key}:${h}`)) continue;
        work.push({ row: r, h, dueAt });
      }
    }
    if (!work.length) return `nothing due (${due.length} intervention(s) already labelled)`;
    work.sort((a, b) => a.dueAt - b.dueAt);
    const batch = work.slice(0, OUTCOMES_BATCH);
    const lanes = await prisma.crossModelChat.findMany({
      where: { id: { in: [...new Set(batch.map((w) => w.row.targetChatId))] } },
      select: { id: true, archivedAt: true },
    });
    const laneById = new Map((lanes as any[]).map((l) => [l.id, l]));
    let written = 0; let nulls = 0; let failed = 0;
    for (const { row, h } of batch) {
      try {
        const facts = await factsFor(row, h, laneById.get(row.targetChatId), byLane.get(row.targetChatId) ?? []);
        const verdict = judgeInterventionOutcome(facts);
        writeOutcomeRow(row, h, metaByKey.get(row.key) ?? {}, verdict, facts);
        written++;
        if (verdict.outcome == null) nulls++;
      } catch {
        failed++; // a failed read labels nothing — the row stays due and is retried next pass
      }
    }
    // Backlog past this batch that leaves the slack before the next pass would vanish unlabelled: write it as
    // null / label_expired (no reads) so the loss shows in the data, the wake block ("unlabelled") and this summary.
    const nextPassAt = now.getTime() + INTERVENTION_OUTCOMES_INTERVAL_SEC * 1000;
    const expiring = work.slice(OUTCOMES_BATCH).filter((w) => w.dueAt + LABEL_SLACK_MS < nextPassAt);
    const marked = expiring.slice(0, EXPIRED_MARK_MAX);
    for (const { row, h } of marked) writeOutcomeRow(row, h, metaByKey.get(row.key) ?? {}, { outcome: null, reason: 'label_expired' }, null);
    if (expiring.length) {
      logger.warn(`intervention-outcomes: labeller behind — ${expiring.length} label(s) aged out unlabelled (${marked.length} recorded as label_expired); ${work.length} pair(s) were due`);
    }
    const queued = work.length - batch.length - marked.length;
    const summary = `intervention-outcomes: ${written} labelled (${nulls} ambiguous), ${failed} retry, ${expiring.length ? `${expiring.length} expired, ` : ''}${queued} queued over ${due.length} due`;
    logger.info(summary);
    return summary.slice(0, 200);
  } catch (err: any) {
    const msg = `intervention-outcomes: pass failed (non-fatal): ${err?.message ?? err}`;
    logger.warn(msg);
    return msg.slice(0, 200);
  }
}

// ── 3. the wake block ───────────────────────────────────────────────────────

export interface OutcomeRowLite {
  interventionKey: string;
  targetChatId: string;
  kind: InterventionKind | string;
  outcome: InterventionOutcome | null;
}

interface Tally { n: number; progressed: number; ran_no_artifact: number; no_run: number; repeated: number; unlabelled: number }
const emptyTally = (): Tally => ({ n: 0, progressed: 0, ran_no_artifact: 0, no_run: 0, repeated: 0, unlabelled: 0 });
const bump = (t: Tally, o: InterventionOutcome | null): void => {
  t.n++;
  if (o == null) t.unlabelled++; else t[o]++;
};

export interface LeverYield {
  total: Tally;
  byKind: Map<string, Tally>;
  byLane: Map<string, Map<string, Tally>>;
}

/** Tally +24 h outcome rows (deduped by intervention) per lever and per lane. Pure. */
export function aggregateLeverYield(rows: readonly OutcomeRowLite[]): LeverYield {
  const seen = new Set<string>();
  const out: LeverYield = { total: emptyTally(), byKind: new Map(), byLane: new Map() };
  for (const r of rows) {
    if (!r.interventionKey || seen.has(r.interventionKey)) continue;
    seen.add(r.interventionKey);
    const kind = String(r.kind || 'other');
    bump(out.total, r.outcome);
    const k = out.byKind.get(kind) ?? emptyTally(); bump(k, r.outcome); out.byKind.set(kind, k);
    const lane = out.byLane.get(r.targetChatId) ?? new Map<string, Tally>();
    const lk = lane.get(kind) ?? emptyTally(); bump(lk, r.outcome); lane.set(kind, lk);
    out.byLane.set(r.targetChatId, lane);
  }
  return out;
}

const pct = (a: number, b: number): string => (b > 0 ? `${Math.round((100 * a) / b)}%` : '—');
const KIND_ORDER = ['steer', 'spawn', 'schedule', 'answer'];
const kindRank = (k: string): number => { const i = KIND_ORDER.indexOf(k); return i < 0 ? KIND_ORDER.length : i; };

function tallyParts(t: Tally): string {
  const parts: string[] = [];
  if (t.progressed) parts.push(`${t.progressed} progressed`);
  if (t.ran_no_artifact) parts.push(`${t.ran_no_artifact} ran, no artifact`);
  if (t.no_run) parts.push(`${t.no_run} no run`);
  if (t.repeated) parts.push(`${t.repeated} repeated`);
  if (t.unlabelled) parts.push(`${t.unlabelled} unlabelled`);
  return parts.join(' · ') || 'none';
}

export const INTERVENTION_BLOCK_HEADER = '[INTERVENTION OUTCOMES — 7d] Your lane interventions, labelled by the harness 24 h after each. progressed = a PR / push / artifact from a run your lever started or acted on (a steer into it, an answer it waited on); repeated = you pulled a lever on it again first; answer = you answered the lane\'s own question / request; unlabelled = ambiguous (only work already in flight, the owner or another supervisor acted, lane archived). Coarse attribution — evidence for choosing a lever, never an order.';

/**
 * Render the block: header, totals, yield per lever, then one line per lane
 * (most interventions first) until BLOCK_MAX_CHARS. '' when there is too
 * little labelled evidence. Pure.
 */
export function renderInterventionOutcomesBlock(y: LeverYield, titles: ReadonlyMap<string, string>, maxChars: number = BLOCK_MAX_CHARS): string {
  const labelled = y.total.n - y.total.unlabelled;
  if (labelled < BLOCK_MIN_LABELLED) return '';
  const lines: string[] = [INTERVENTION_BLOCK_HEADER];
  lines.push(`Totals: ${y.total.n} intervention(s) — ${tallyParts(y.total)}; progressed ${pct(y.total.progressed, labelled)} of labelled.`);
  const kinds = [...y.byKind.entries()].sort((a, b) => kindRank(a[0]) - kindRank(b[0]));
  lines.push(`By lever: ${kinds.map(([k, t]) => `${k} ${t.n} → ${pct(t.progressed, t.n - t.unlabelled)} progressed`).join(' | ')}`);
  const lanes = [...y.byLane.entries()]
    .map(([id, m]) => ({ id, m, n: [...m.values()].reduce((s, t) => s + t.n, 0) }))
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  let used = lines.join('\n').length;
  let shown = 0;
  for (const lane of lanes) {
    const title = String(titles.get(lane.id) ?? '').replace(/\s+/g, ' ').trim();
    const name = title ? `${title.length > 40 ? `${title.slice(0, 39)}…` : title} (${lane.id.slice(0, 8)})` : lane.id.slice(0, 8);
    const levers = [...lane.m.entries()].sort((a, b) => kindRank(a[0]) - kindRank(b[0])).map(([k, t]) => `${k} ${t.n} → ${tallyParts(t)}`).join(' | ');
    const line = `- ${name}: ${levers}`;
    const remaining = lanes.length - shown - 1;
    const tail = remaining > 0 ? `\n… ${remaining} more lane(s)`.length : 0;
    if (used + 1 + line.length + tail > maxChars) break;
    lines.push(line);
    used += 1 + line.length;
    shown++;
  }
  if (shown < lanes.length) lines.push(`… ${lanes.length - shown} more lane(s)`);
  const block = lines.join('\n');
  return block.length > maxChars ? `${block.slice(0, maxChars - 1)}…` : block;
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    (t as any).unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function readBlock(supervisorChatId: string, now: Date): Promise<string> {
  // Design: render only after one week of observing THIS supervisor.
  const observed = await prisma.loopMetric.findFirst({
    where: { kind: LOOP_METRIC_KINDS.SUPERVISOR_INTERVENTION, sessionId: supervisorChatId, createdAt: { lte: new Date(now.getTime() - OBSERVATION_MIN_MS) } },
    select: { id: true },
  });
  if (!observed) return '';
  const rows = await prisma.loopMetric.findMany({
    where: { kind: LOOP_METRIC_KINDS.SUPERVISOR_INTERVENTION_OUTCOME, sessionId: supervisorChatId, createdAt: { gte: new Date(now.getTime() - BLOCK_WINDOW_MS) } },
    select: { meta: true }, orderBy: { createdAt: 'desc' }, take: BLOCK_MAX_ROWS,
  });
  const lite: OutcomeRowLite[] = [];
  for (const r of rows as any[]) {
    const m = asRecord(r.meta);
    if (Number(m.horizonH) !== 24 || typeof m.interventionKey !== 'string' || typeof m.targetChatId !== 'string') continue;
    const o = m.outcome;
    lite.push({ interventionKey: m.interventionKey, targetChatId: m.targetChatId, kind: String(m.kind ?? 'other'), outcome: o === 'progressed' || o === 'ran_no_artifact' || o === 'no_run' || o === 'repeated' ? o : null });
  }
  const y = aggregateLeverYield(lite);
  if (y.total.n - y.total.unlabelled < BLOCK_MIN_LABELLED) return '';
  const laneIds = [...y.byLane.keys()].slice(0, BLOCK_MAX_LANES);
  const chats = laneIds.length
    ? await prisma.crossModelChat.findMany({ where: { id: { in: laneIds } }, select: { id: true, title: true } }).catch(() => [])
    : [];
  const titles = new Map<string, string>((chats as any[]).map((c) => [c.id, String(c.title ?? '')]));
  return renderInterventionOutcomesBlock(y, titles);
}

/**
 * The [INTERVENTION OUTCOMES — 7d] block for a supervisor MACHINE wake, or ''
 * (switch off, under a week of observation, too few labels, any error, past
 * BLOCK_READ_TIMEOUT_MS). Never throws.
 */
export async function buildInterventionOutcomesBlock(supervisorChatId: string, now: Date = new Date()): Promise<string> {
  try {
    if (!supervisorChatId || interventionOutcomesBlockDisabled() || underTest()) return '';
    return await withTimeout(readBlock(supervisorChatId, now), BLOCK_READ_TIMEOUT_MS);
  } catch (err: any) {
    logger.warn(`intervention-outcomes: wake block skipped for ${supervisorChatId.slice(0, 8)} (${err?.message ?? err})`);
    return '';
  }
}
