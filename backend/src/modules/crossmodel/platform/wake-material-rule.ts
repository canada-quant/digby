/**
 * Supervisor wakes — state from the LEDGER + ONE deterministic "material change
 * since my last wake" rule (audit 2026-10-08 W6; SOTA #5 + #8; fixes P1-10).
 *
 * PURE LEAF (imports two other leaves only): the rule, the diff renderer and
 * the continuity-history selector. The DB reads, the high-water mark and the
 * gate entry points live in platform/supervisor-wake-ledger.ts.
 *
 * WHY (audit 2026-10-08, supervisors.md F4 / sota.md #2 + #8):
 *   - a supervisor MACHINE wake rebuilt its state from the last 24 transcript
 *     messages — its own model-written notes plus ~15 k-char wake prompts that
 *     each carried an OLD [SUPERVISOR STATE] snapshot (chat-agent.service
 *     `history.slice(-24)`). The harness already holds the authoritative
 *     state; the wake now gets a HARNESS DIFF of the ledger since its last
 *     completed wake ([SINCE YOUR LAST WAKE]) and only its last 1–3 own notes
 *     (+ any owner-typed rows in the window) for continuity;
 *   - every non-alarm hook wake, every stock sweep and every queued agent
 *     batch was a full reasoning turn: Schooltime took 25 identical hourly
 *     "No audio yet" Drive wakes ($4.30) and ~42 % of supervisor spend closed
 *     as no-op notes. Six Jev purposes each answered "should I wake?" and the
 *     one in act (wake_triage) was auto-demoted on a biased label. ONE
 *     deterministic rule now gates hook / sweep / drain wakes: no MATERIAL
 *     change since the last completed wake and no alarm-class trigger ⇒ the
 *     wake is skipped and counted; a heartbeat floor of N hours always lets
 *     one through. The Jev purposes keep asking in SHADOW beside it (capped
 *     in decision-gate-modes) and their agreement is recorded.
 *
 * MATERIAL (any one ⇒ deliver):
 *   alarm            an alarm-class trigger row (attention_needed / run_failed /
 *                    goal_blocked / schedule_disabled / todo_wake) or a cap bypass
 *   heartbeat        the last completed wake is ≥ floor hours old
 *   owner_message    an owner-typed message since the last wake (this chat, or a
 *                    lane of the project for a project supervisor)
 *   owner_answer     an owner question answered / dismissed since the last wake
 *   goal_todo_change a goal / todo status transition made by ANOTHER actor
 *                    (→ done / blocked / dropped / archived, out of blocked, any
 *                    goal transition, an auto_* / force_* rewrite, or a goal /
 *                    todo the owner created)
 *   lane_failed      a lane run in scope failed since the last wake
 *   artifact         a PR opened / merged in scope since the last wake
 *   stall            (sweeps only) a lane holds in-progress work with no live run,
 *                    no armed schedule and its last run ended ≥ 30 min ago
 *                    (LANE-IDLE-WAKE 2026-10-20: also dependency-free PENDING
 *                    assigned work, only a schedule due within 2 h — or a
 *                    recurring one within 1.5× its own interval — counts as
 *                    armed, and a coding lane that never ran counts from its
 *                    todo's last change)
 *   lane_idle        (hook origin) a harness lane-idle wake row (payload.wakeKind
 *                    'lane_idle', coding/lane-idle.ts): a lane went idle holding
 *                    actionable assigned work with nothing to wake it — a DECISION
 *   event:<type>     a non-alarm hook event other than run_completed
 *                    (schedule_near_cap, ci_failed, schedule_cap_skipped, …)
 *   todo_done        a todo_done hook event
 *   new_report       a run_completed whose summary is NOT a near-duplicate
 *                    (≥ 0.8 normalized-trigram containment) of the last
 *                    DELIVERED summary from the same source — identical
 *                    summaries collapse
 *   peer_message     a queued agent message from a non-subordinate chat (the
 *                    Fleet Supervisor → a PS, another PS, an unknown chat)
 *   lane_report      a queued message from a subordinate lane that is not a
 *                    near-duplicate of that lane's previous message here
 *   lane_ask         (tiers on) a new_report / lane_report whose text carries
 *                    an ASK or a BLOCKER for the supervisor (laneAskCue) — the
 *                    same rows, read for content
 *   report_ask_or_change  a PS → Fleet report-up carrying an ask / state change
 *                    (platform/report-up.ts; a status-only report-up is not material)
 *
 * Replay (audit window 2026-10-07 18:00Z → 2026-10-08 19:13Z, 164 supervisor
 * machine wakes): 44 skipped (20 hook / 24 sweep / 0 drain), 2 of them had
 * taken a real action (a proactive "school window opened" steer and a
 * self-described "bookkeeping steer"); 47 h window: 68 / 342 skipped, 4 with
 * an action, all proactive / time-based (scratchpad agents/w6/replay.py).
 *
 * TIERS (supervisor SOTA 2026-10-20, SUP-WAKE-TIERS): every material reason is
 * DECISION (the supervisor must choose something — alarm, owner words, a
 * failed lane, a stall, a lane idle with open work (lane_idle), a peer / Fleet message, red CI, a block / unblock, a
 * goal transition, an owner-created item, the last open todo of a goal done)
 * or PROGRESS (a lane reporting forward motion — a new run report, a lane
 * message, a PR, a lane-made todo done with work left in its goal, the 4 h
 * heartbeat). A lane report or run summary that ASKS the supervisor something
 * or names a BLOCKER (laneAskCue — a question, "should I", "need a decision",
 * "blocked on", "waiting for your …") is DECISION ('lane_ask'), never a
 * progress report (review fix 2026-10-20: lane → supervisor traffic has no
 * report-up classifier, and a held drain is acked without a turn). The
 * verdict's tier is the max over its reasons. A PROGRESS-tier wake whose
 * source lanes are all still DRIVING THEMSELVES (a live run or a schedule
 * armed within 30 min — an assigned todo alone never counts; a lane in the
 * diff's stalledLanes never does; more than 50 source lanes never does —
 * platform/lane-self-driving.ts) is skipped and counted
 * ('skipped:progress_self_driving'), bounded by a progress heartbeat of
 * SUPERVISOR_PROGRESS_HEARTBEAT_HOURS (8) and a 1-in-
 * SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE (10) control delivery; DECISION
 * reasons are never gated. Evidence (7 d before the change):
 * supervisor_material_gate 4,834 evals / 4,544 material, and the harness label
 * shows ~75 % of delivered wakes take no real action — new_report on any
 * non-duplicate run_completed, artifact, goal_todo_change and the 4 h
 * heartbeat were each enough to wake a supervisor whose lanes were already
 * moving. Kill switch SUPERVISOR_MATERIAL_TIERS_DISABLED=1 restores the
 * untiered gate byte-for-byte.
 */

import { isMachineAuthoredText } from '../chat-agent/machine-wake';
import { classifyReportUp } from './report-up';
import { redactInboundHead } from './secret-scan';

// ── Switches ────────────────────────────────────────────────────────────────

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** SUPERVISOR_WAKE_LEDGER_DIFF_DISABLED=1 — no [SINCE YOUR LAST WAKE] block; machine wakes replay the last 24 messages again (W6-1). */
export function wakeLedgerDiffDisabled(): boolean {
  return onFlag(process.env.SUPERVISOR_WAKE_LEDGER_DIFF_DISABLED);
}

/** SUPERVISOR_MATERIAL_GATE_DISABLED=1 — no material gate; the Jev wake purposes run in their stored modes again (W6-2). */
export function materialGateDisabled(): boolean {
  return onFlag(process.env.SUPERVISOR_MATERIAL_GATE_DISABLED);
}

/** SUPERVISOR_MATERIAL_GATE_SHADOW=1 — the gate decides + records but never skips (and does not cap the Jev purposes). */
export function materialGateShadow(): boolean {
  return onFlag(process.env.SUPERVISOR_MATERIAL_GATE_SHADOW);
}

/** SUPERVISOR_MATERIAL_TIERS_DISABLED=1 — no decision / progress tiers: every material wake delivers (the untiered gate byte-for-byte). */
export function materialTiersDisabled(): boolean {
  return onFlag(process.env.SUPERVISOR_MATERIAL_TIERS_DISABLED);
}

/** LANE_IDLE_WAKE_DISABLED=1 (coding/lane-idle.ts owns it; read here so this leaf stays a leaf) — no 'lane_idle' reason, the pre-2026-10-20 stall wording. */
export function laneIdleWakeOff(): boolean {
  return onFlag(process.env.LANE_IDLE_WAKE_DISABLED);
}

export type MaterialGateMode = 'act' | 'shadow' | 'off';

/**
 * Jest sets NODE_ENV=test: the diff block and the gate stay OFF there unless a
 * suite opts in (SUPERVISOR_WAKE_LEDGER_IN_TEST=1) — the wider suite mocks
 * prisma partially and pins exact wake prompts (the decision gate's
 * "NODE_ENV=test ⇒ off" idiom).
 */
export function wakeLedgerUnderTest(): boolean {
  return process.env.NODE_ENV === 'test' && !onFlag(process.env.SUPERVISOR_WAKE_LEDGER_IN_TEST);
}

/** The diff block + continuity history are live on this process. */
export function wakeLedgerDiffActive(): boolean {
  return !wakeLedgerDiffDisabled() && !wakeLedgerUnderTest();
}

/** The gate's mode on THIS process: off (kill switch / under test) → shadow (observe switch) → act (default). */
export function materialGateMode(): MaterialGateMode {
  if (materialGateDisabled() || wakeLedgerUnderTest()) return 'off';
  return materialGateShadow() ? 'shadow' : 'act';
}

/** The purposes the material gate supersedes as the wake gate — they keep asking in SHADOW beside it. */
export const MATERIAL_GATE_SUPERSEDED_PURPOSES: readonly string[] = ['wake_triage', 'sweep_triage', 'drain_triage', 'supervisor_turn_noop'];

/** True when the material gate ACTS on this process and `purpose` is one of the Jev wake purposes it supersedes. */
export function materialGateSupersedes(purpose: string): boolean {
  return materialGateMode() === 'act' && MATERIAL_GATE_SUPERSEDED_PURPOSES.includes(purpose);
}

export const MATERIAL_GATE_DEFAULT_FLOOR_HOURS = 4;
/** The heartbeat floor in hours (SUPERVISOR_MATERIAL_GATE_FLOOR_HOURS, clamped 1..24; default 4). */
export function materialGateFloorHours(): number {
  const raw = process.env.SUPERVISOR_MATERIAL_GATE_FLOOR_HOURS;
  if (raw === undefined || String(raw).trim() === '') return MATERIAL_GATE_DEFAULT_FLOOR_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(24, Math.max(1, n)) : MATERIAL_GATE_DEFAULT_FLOOR_HOURS;
}

export const PROGRESS_HEARTBEAT_DEFAULT_HOURS = 8;
/** The progress heartbeat in hours (SUPERVISOR_PROGRESS_HEARTBEAT_HOURS, clamped 1..72; default 8): past it a PROGRESS-tier wake always delivers. */
export function progressHeartbeatHours(): number {
  const raw = process.env.SUPERVISOR_PROGRESS_HEARTBEAT_HOURS;
  if (raw === undefined || String(raw).trim() === '') return PROGRESS_HEARTBEAT_DEFAULT_HOURS;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(72, Math.max(1, n)) : PROGRESS_HEARTBEAT_DEFAULT_HOURS;
}

export const PROGRESS_SKIP_CONTROL_DEFAULT_RATE = 10;
/** 1 in N progress self-driving skips delivers as a labelled CONTROL (SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE, integer 0..1000; 0 = no control; default 10). */
export function progressSkipControlRate(): number {
  const raw = process.env.SUPERVISOR_PROGRESS_SKIP_CONTROL_RATE;
  if (raw === undefined || String(raw).trim() === '') return PROGRESS_SKIP_CONTROL_DEFAULT_RATE;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(1000, Math.max(0, n)) : PROGRESS_SKIP_CONTROL_DEFAULT_RATE;
}

/** Draw the control sample: true ⇒ deliver this would-be skip as a control. `rand` is injectable for tests. */
export function drawProgressControl(rate: number = progressSkipControlRate(), rand: () => number = Math.random): boolean {
  return rate > 0 && rand() < 1 / rate;
}

export const WAKE_HISTORY_DEFAULT_NOTES = 3;
/** How many of its own notes a supervisor machine wake keeps for continuity (SUPERVISOR_WAKE_HISTORY_NOTES, clamped 1..6; default 3). */
export function wakeHistoryNotes(): number {
  const raw = process.env.SUPERVISOR_WAKE_HISTORY_NOTES;
  if (raw === undefined || String(raw).trim() === '') return WAKE_HISTORY_DEFAULT_NOTES;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.min(6, Math.max(1, n)) : WAKE_HISTORY_DEFAULT_NOTES;
}

/** Stall threshold: a lane with in-progress work and no live run / armed schedule for this long is stalled. */
export const STALL_IDLE_MIN = 30;
/** Near-duplicate threshold (normalized word-trigram containment of the new text in the previous one). */
export const NEAR_DUPLICATE_CONTAINMENT = 0.8;

/** The terminal hook_events status for a group the gate skipped (never replayed). */
export const HOOK_STATUS_NO_MATERIAL_CHANGE = 'skipped:no_material_change';
/** The schedule lastStatus for a sweep the gate skipped. */
export const SCHEDULE_STATUS_NO_MATERIAL_CHANGE = 'skipped:no_material_change';
/** The terminal hook_events status / schedule lastStatus for a PROGRESS-tier wake skipped because its lanes drive themselves. */
export const HOOK_STATUS_PROGRESS_SELF_DRIVING = 'skipped:progress_self_driving';
export const SCHEDULE_STATUS_PROGRESS_SELF_DRIVING = 'skipped:progress_self_driving';
/** Every hook_events status the gate stamps on a skipped group (the next diff's "Skipped by the material gate" line reads them all). */
export const MATERIAL_GATE_SKIP_STATUSES: readonly string[] = [HOOK_STATUS_NO_MATERIAL_CHANGE, HOOK_STATUS_PROGRESS_SELF_DRIVING];
export type MaterialSkipReason = 'no_material_change' | 'progress_self_driving';

// ── The diff ────────────────────────────────────────────────────────────────

export interface LedgerOwnerMessage { chatId: string; title?: string; at: string; head: string; self: boolean }
export interface LedgerOwnerAnswer { id: string; chatId: string; status: string; at: string; head?: string; by?: string | null }
export interface LedgerStatusChange {
  kind: 'goal' | 'todo'; id: string; title?: string; from?: string | null; to?: string | null; action: string; at: string; byChatId?: string | null;
  /** todo → done only (tiers on): open (pending / in_progress) todos left in its goal at diff time; absent = unknown (⇒ decision). */
  goalOpenTodos?: number;
}
export interface LedgerRun {
  chatId: string; title?: string; status: string; at: string; error?: string | null;
  /** A FAILED provider-transient run whose resume took over (cause-aware on): listed, never lane_failed. */
  resumeQueued?: boolean;
}
export interface LedgerArtifact {
  chatId: string; title?: string; tool: string; at: string; ref?: string;
  /** The work item the EVENT itself named (todo 13dfa16d): ids.todoId / ids.ticketId stamped at event time — 'todo 27c215d6' / 'ticket 2c203dac'. Rendered INSTEAD of any lane-title inference. */
  workItem?: string;
  /** Honest print when the receipt carries no stamp (legacy rows / kill switch): never guessed. */
  unattributed?: boolean;
}
export interface LedgerScheduleStop { id: string; chatId: string; title?: string; at: string; status?: string | null; kind?: string | null }
export interface LedgerTicket { id: string; title: string; status: string; at: string; source?: string | null; isNew: boolean }
export interface LedgerAgentMessage { fromChatId: string; title?: string; at: string; head: string }
export interface LedgerStalledLane {
  chatId: string; title?: string; todoId: string; todoTitle?: string; idleMin: number;
  /** LANE-IDLE-WAKE: 'pending' when the held todo is dependency-free pending work (absent = in_progress). */
  todoStatus?: string;
  /** LANE-IDLE-WAKE: a coding lane with no agent_runs row at all — idleMin counts from the todo's last change. */
  neverStarted?: boolean;
}
export interface LedgerGateSkip { sourceChatId: string; title?: string; n: number }
/**
 * FLEET-PS-FIRST (2026-10-20): the PROGRESS the fleet diff left out because its
 * lanes sit in projects an enabled project supervisor covers (decision-class
 * rows — failures, stalls, owner rows, goal transitions — stay in the diff).
 */
export interface LedgerPsCovered {
  projects: number;
  lanes: number;
  runsFinished: number;
  /** Artifact receipts omitted (PRs + pushes); `prs` is the PR subset. */
  artifacts: number;
  prs: number;
  /** Lane-made todo closes with work left in their goal (progress tier). */
  todosDone: number;
  /** Immaterial ledger rows. */
  other: number;
  /** The PS-first alarm routing is on (the line says alarms arrive as delayed escalations). */
  alarmsDelayed: boolean;
}

/** Everything the ledger recorded in the supervisor's scope since its last completed wake. */
export interface WakeLedgerDiff {
  chatId: string;
  scope: 'fleet' | 'project';
  projectId: string | null;
  /** ISO — the high-water mark (the last completed machine wake's start). */
  since: string;
  /** ISO — when the diff was read. */
  now: string;
  ownerMessages: LedgerOwnerMessage[];
  ownerAnswers: LedgerOwnerAnswer[];
  /** MATERIAL goal / todo transitions made by another actor (newest first). */
  statusChanges: LedgerStatusChange[];
  /** Ledger rows that are not material (a todo flipped in_progress, a lane-created todo, …). */
  otherLedgerChanges: number;
  runsStarted: number;
  runsRunning: number;
  runsFinished: LedgerRun[];
  runsFailed: LedgerRun[];
  runsCancelled: number;
  /** PRs opened / merged and pushes in scope (newest first). */
  artifacts: LedgerArtifact[];
  schedulesFired: number;
  schedulesStopped: LedgerScheduleStop[];
  /** Owner-origin directives captured since (harness-stamped origin). */
  directivesOpened: number;
  tickets: LedgerTicket[];
  /** Agent messages that arrived IN this chat since (lane reports, steers). */
  agentMessages: LedgerAgentMessage[];
  /** Lanes holding open work with no live run / armed schedule (sweep stall signal). */
  stalledLanes: LedgerStalledLane[];
  /** Hook groups the material gate skipped since (per source). */
  gateSkips: LedgerGateSkip[];
  /** Sections whose read hit a bound (rendered as "+ more"). */
  truncated?: string[];
  /** FLEET-PS-FIRST: fleet scope only — progress omitted for PS-covered projects (absent when nothing was omitted / the switch is off). */
  psCovered?: LedgerPsCovered;
}

export function emptyWakeLedgerDiff(chatId: string, since: Date, now: Date, scope: 'fleet' | 'project' = 'project', projectId: string | null = null): WakeLedgerDiff {
  return {
    chatId, scope, projectId, since: since.toISOString(), now: now.toISOString(),
    ownerMessages: [], ownerAnswers: [], statusChanges: [], otherLedgerChanges: 0,
    runsStarted: 0, runsRunning: 0, runsFinished: [], runsFailed: [], runsCancelled: 0,
    artifacts: [], schedulesFired: 0, schedulesStopped: [], directivesOpened: 0, tickets: [],
    agentMessages: [], stalledLanes: [], gateSkips: [],
  };
}

/** Goal / todo statuses whose arrival is material. */
const MATERIAL_TO_STATUSES = new Set(['done', 'blocked', 'dropped', 'archived']);
/** Audit actions that are always a material transition (no from/to in their metadata). */
const ALWAYS_MATERIAL_ACTIONS = new Set([
  'goal.auto_done', 'goal.auto_block', 'goal.auto_unblock', 'goal.auto_reopen', 'goal.force_done',
  'todo.auto_block', 'todo.auto_unblock', 'todo.force_done',
]);

/**
 * Is one goal / todo audit row a MATERIAL transition for a supervisor whose
 * chat id is `selfChatId`? Rows the supervisor wrote itself never are (it
 * already knows); lane-created todos are routine (counted, not material); an
 * owner-created goal / todo (no acting chat) is. Pure.
 */
export function isMaterialLedgerTransition(row: { action: string; fromStatus?: string | null; toStatus?: string | null; actingChatId?: string | null }, selfChatId: string): boolean {
  if (row.actingChatId && row.actingChatId === selfChatId) return false;
  if (ALWAYS_MATERIAL_ACTIONS.has(row.action)) return true;
  if (row.action === 'goal.create' || row.action === 'todo.create') return !row.actingChatId;
  if (row.action === 'goal.update' || row.action === 'todo.update') {
    const from = row.fromStatus ?? null;
    const to = row.toStatus ?? null;
    if (!to || from === to) return false;
    if (row.action === 'goal.update') return true;
    return MATERIAL_TO_STATUSES.has(to) || from === 'blocked';
  }
  return false;
}

// ── Near-duplicate summaries ────────────────────────────────────────────────

/** Strip the harness's run-digest boilerplate (RUN_OUTCOME / ANSWER_MSG_ID … "Final answer:"), keeping the outcome tokens. Pure. */
export function normalizeRunSummary(summary: unknown): string {
  const s = String(summary ?? '');
  const head = s.match(/RUN_OUTCOME:\s*([a-z_]+)(?:\s*·\s*VERDICT:\s*([^·\n]+?))?(?:\s*·\s*BLOCKING:\s*(\d+))?(?=\s|$)/i);
  const outcome = head ? `outcome ${head[1]} verdict ${String(head[2] ?? '').trim()} blocking ${head[3] ?? ''} ` : '';
  // HARNESS-RECEIPTS (2026-10-20): the front-loaded CLAIMS line is harness boilerplate, never the lane's words.
  const unclaimed = s.replace(/^CLAIMS:[^\n]*\n?/im, '');
  const body = unclaimed.replace(/^[\s\S]*?Final answer:\s*/i, '');
  return `${outcome}${body === unclaimed ? unclaimed.replace(/^RUN_OUTCOME:[^\n]*\n?/i, '') : body}`;
}

function normWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,}\b/g, ' id ')
    .replace(/\d+/g, '0')
    .replace(/[^a-z0-9_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Normalized word trigrams (case, numbers, clock times and hex ids folded). Pure. */
export function normalizedTrigrams(text: unknown): Set<string> {
  const w = normWords(String(text ?? ''));
  const out = new Set<string>();
  if (!w.length) return out;
  if (w.length < 3) { out.add(w.join(' ')); return out; }
  for (let i = 0; i + 2 < w.length; i += 1) out.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return out;
}

/** Share of `next`'s normalized trigrams present in `prev` (1 when `next` is empty). Pure. */
export function normalizedContainment(next: unknown, prev: unknown): number {
  const a = normalizedTrigrams(next);
  if (a.size === 0) return 1;
  const b = normalizedTrigrams(prev);
  let hit = 0;
  for (const t of a) if (b.has(t)) hit += 1;
  return hit / a.size;
}

/** Is `next` a near-duplicate of `prev`? (No previous text ⇒ never.) Pure. */
export function isNearDuplicate(next: unknown, prev: unknown, threshold: number = NEAR_DUPLICATE_CONTAINMENT): boolean {
  if (prev === undefined || prev === null || String(prev).trim() === '') return false;
  return normalizedContainment(next, prev) >= threshold;
}

/** The digest header tokens (RUN_OUTCOME / VERDICT / BLOCKING), lower-cased — '' when absent. Pure. */
export function runOutcomeKey(summary: unknown): string {
  const m = String(summary ?? '').match(/RUN_OUTCOME:\s*([a-z_]+)(?:\s*·\s*VERDICT:\s*([^·\n]*?))?(?:\s*·\s*BLOCKING:\s*(\d+))?(?=\s|$)/i);
  return m ? `${m[1]}|${String(m[2] ?? '').trim()}|${m[3] ?? ''}`.toLowerCase() : '';
}

/** Is a run_completed digest a near-duplicate of the previous one from the same source? The outcome / verdict /
 *  blocking header must match EXACTLY (a completed → failed flip is never a duplicate), the bodies by containment. Pure. */
export function isNearDuplicateRunSummary(next: unknown, prev: unknown): boolean {
  if (prev === undefined || prev === null || String(prev).trim() === '') return false;
  if (runOutcomeKey(next) !== runOutcomeKey(prev)) return false;
  return isNearDuplicate(normalizeRunSummary(next), normalizeRunSummary(prev));
}

// ── The rule ────────────────────────────────────────────────────────────────

export type WakeGateOrigin = 'hook' | 'sweep' | 'drain';

export interface MaterialTriggerRow {
  eventType: string; sourceChatId?: string; summary?: string; alarm?: boolean;
  /** LANE-IDLE-WAKE: payload.wakeKind of a harness direct wake ('lane_idle' ⇒ the DECISION reason 'lane_idle'). */
  wakeKind?: string;
  /** An ALARM-TYPE row its own payload made quiet (platform/alarm-cause.ts) — it adds no material reason. */
  quietCause?: string | null;
}

export interface MaterialDrainMessage {
  sourceChatId?: string;
  body: string;
  /** The source is a chat in this supervisor's scope that is not itself a supervisor (a lane). */
  sourceIsLane?: boolean;
  /** The source is a project supervisor (meaningful when the target is the Fleet Supervisor). */
  sourceIsProjectSupervisor?: boolean;
}

export interface MaterialInput {
  origin: WakeGateOrigin;
  diff: WakeLedgerDiff;
  /** The high-water mark (last completed wake start) and the decision time. */
  hwmAt: Date;
  now: Date;
  isFleet: boolean;
  floorHours?: number;
  /** hook origin: the group's rows. */
  rows?: MaterialTriggerRow[];
  /** hook origin: the last DELIVERED run summary per source chat id. */
  prevSummaryBySource?: Record<string, string>;
  /** An alarm-class row rides the group / the cap was bypassed. */
  alarm?: boolean;
  /** drain origin: the queued messages. */
  drain?: MaterialDrainMessage[];
  /** drain origin: the previous agent message body per source chat id (delivered in this chat). */
  prevAgentBodyBySource?: Record<string, string>;
}

export type WakeTier = 'decision' | 'progress' | 'none';

export interface MaterialVerdict {
  material: boolean;
  reasons: string[];
  heartbeat: boolean;
  /** Minutes since the high-water mark. */
  sinceMin: number;
  floorHours: number;
  /** SUP-WAKE-TIERS: the max tier over `reasons` ('none' when not material). Optional — absent on verdicts built elsewhere. */
  tier?: WakeTier;
  /** The reasons that put the verdict in the DECISION tier (empty for a progress-only verdict). */
  decisionReasons?: string[];
}

// ── Tiers (SUP-WAKE-TIERS) ──────────────────────────────────────────────────

/**
 * The static tier of each material reason. Two reasons are refined per row
 * (goal_todo_change by statusChangeTier, todo_done by the diff's lane-made
 * done changes); every reason NOT listed (event:<type> other than ci_failed,
 * any future reason) is DECISION — the conservative default, never gated.
 */
export const REASON_TIER: Readonly<Record<string, 'decision' | 'progress'>> = {
  alarm: 'decision',
  owner_message: 'decision',
  owner_answer: 'decision',
  lane_failed: 'decision',
  stall: 'decision',
  report_ask_or_change: 'decision',
  peer_message: 'decision',
  lane_ask: 'decision',
  lane_idle: 'decision',
  'event:ci_failed': 'decision',
  new_report: 'progress',
  lane_report: 'progress',
  artifact: 'progress',
  heartbeat: 'progress',
  goal_todo_change: 'progress',
  todo_done: 'progress',
};

/**
 * One material goal / todo transition's tier. DECISION: any goal transition,
 * an owner / harness write (no acting chat — owner-created items included),
 * every auto_* / force_* / create action, todo → blocked or out of blocked,
 * a todo dropped / archived (scope), and a todo done that leaves its goal
 * with NO open (pending / in_progress) successor or an unknown count.
 * PROGRESS: a lane-made todo → done with work left in its goal. Pure.
 */
export function statusChangeTier(c: Pick<LedgerStatusChange, 'kind' | 'action' | 'from' | 'to' | 'byChatId' | 'goalOpenTodos'>): 'decision' | 'progress' {
  if (c.kind !== 'todo') return 'decision';
  if (!c.byChatId) return 'decision';
  if (c.action !== 'todo.update') return 'decision';
  const from = c.from ?? null;
  const to = c.to ?? null;
  if (to === 'blocked' || from === 'blocked') return 'decision';
  if (to === 'done') return typeof c.goalOpenTodos === 'number' && c.goalOpenTodos > 0 ? 'progress' : 'decision';
  return 'decision';
}

/** The tier of ONE reason given the diff it was read from. Pure. */
export function reasonTier(reason: string, d: Pick<WakeLedgerDiff, 'statusChanges'>): 'decision' | 'progress' {
  if (reason === 'goal_todo_change') return d.statusChanges.some((c) => statusChangeTier(c) === 'decision') ? 'decision' : 'progress';
  // A todo_done hook row is progress only when the diff shows a lane-made done with work left in its goal (unseen ⇒ decision).
  if (reason === 'todo_done') return d.statusChanges.some((c) => c.kind === 'todo' && c.to === 'done' && statusChangeTier(c) === 'progress') ? 'progress' : 'decision';
  return REASON_TIER[reason] ?? 'decision';
}

/** The verdict's tier = max over its reasons (decision > progress > none) + the decision-tier reasons. Pure. */
export function tierOfReasons(reasons: readonly string[], d: Pick<WakeLedgerDiff, 'statusChanges'>): { tier: WakeTier; decisionReasons: string[] } {
  if (!reasons.length) return { tier: 'none', decisionReasons: [] };
  const decisionReasons = reasons.filter((r) => reasonTier(r, d) === 'decision');
  return { tier: decisionReasons.length ? 'decision' : 'progress', decisionReasons };
}

// ── Lane asks (review fix 2026-10-20) ───────────────────────────────────────

/**
 * An ASK or a BLOCKER for the supervisor in a lane's own words. The PS → Fleet
 * path reads report-ups with classifyReportUp; lane → supervisor messages and
 * run summaries had no such reading, so "Two options — A or B, which one?" or
 * "step 3 done; blocked on X — need a decision" rode as PROGRESS and could be
 * held (a held drain is acked with no turn). Biased toward DETECTION: a false
 * hit costs one wake (the pre-tier behaviour); a miss leaves a lane guessing.
 * Negated forms ("no decision needed", "not blocked by", "doesn't need
 * approval") do not fire; a '?' must close a sentence (URL query strings and
 * `a?.b` never fire).
 */
export const LANE_ASK_CUE_RE = new RegExp([
  // a question closing a sentence (closing brackets / quotes / markdown emphasis allowed after it)
  '\\?[)"\'”’\\]*_]*(?=\\s|$)',
  // explicit asks
  '\\bplease (?:reply|respond|confirm|advise|decide|rule|review|approve|choose|pick|answer|tell me|let me know)\\b',
  '\\blet me know\\b', '\\b(?:should|shall) (?:i|we)\\b', '\\b(?:can|could|would) you\\b', '\\bdo you want\\b',
  '\\bwhich (?:one|option|approach|path|way|do you|should)\\b',
  '\\byour (?:call|decision|choice|ruling|go[- ]ahead|approval|sign[- ]?off)\\b',
  '\\bconfirm (?:before|whether|if)\\b',
  // a need / wait on a person or a decision (negations excluded)
  '(?<!\\b(?:no|not|never) )(?<!n\'t )\\b(?:need(?:s|ed|ing)?|requir(?:e|es|ed|ing)) (?:a |an |your |the |owner |supervisor |fleet |human )?(?:decision|ruling|approval|answer|reply|input|guidance|go[- ]ahead|sign[- ]?off|confirmation|steer|owner|supervisor|fleet|human)\\b',
  '\\b(?:awaiting|waiting (?:for|on)|pending) (?:your |a |an |the )?(?:reply|response|decision|ruling|guidance|approval|go[- ]ahead|answer|input|confirmation|sign[- ]?off|owner|supervisor|you)\\b',
  '(?<!\\bno )\\b(?:decision|input|approval|sign[- ]?off|answer|ruling) (?:needed|required|requested)\\b',
  '\\b(?:i\'ll|i will|i am|i\'m|will) (?:hold|wait|pause) (?:until|for|on) (?:you|your|a decision|an answer|the supervisor|the owner|confirmation|approval)\\b',
  '\\bowner (?:decision|question|input|approval|action)\\b', '\\bNEEDS FLEET\\b', '\\bescalat(?:e|ing) (?:to|this)\\b',
  // a blocker (negations excluded)
  '(?<!\\b(?:no longer|not|never) )\\bblocked (?:on|by|until|pending|waiting)\\b',
  '\\b(?:i am|i\'m|we are|we\'re|lane is|still|currently|remains?|stays?) blocked\\b',
  '\\bblocker\\s*[:—–-]', '(?:^|[.;!]\\s+)blocked\\s*[:—–-]',
  '\\b(?:cannot|can\'t|can not|unable to) (?:proceed|continue|go further|make (?:further )?progress)\\b',
  '\\bstuck (?:on|until|waiting)\\b',
].join('|'), 'i');

/** Harness boilerplate a run digest carries around the lane's words (answer-id line, hand-off / loop notes). */
const DIGEST_BOILERPLATE_RE = /ANSWER_MSG_ID:[^\n]*?(?:message id\.|$)|\[(?:DELIVERABLES ALREADY POSTED|LOOP-MARKER)[^\]]*\]/gim;

/** The lane's own words in a run_completed digest (header + harness notes stripped). Pure. */
export function runSummaryAskText(summary: unknown): string {
  return normalizeRunSummary(summary).replace(DIGEST_BOILERPLATE_RE, ' ');
}

/** Does a lane's text carry an ask or a blocker for its supervisor? Pure. */
export function laneAskCue(text: unknown): boolean {
  return LANE_ASK_CUE_RE.test(String(text ?? ''));
}

/**
 * THE deterministic rule. Pure — the same input always yields the same verdict.
 * `reasons` lists every material reason that applied (empty ⇒ not material).
 */
export function decideMaterialChange(input: MaterialInput): MaterialVerdict {
  const floorHours = input.floorHours ?? materialGateFloorHours();
  const sinceMs = Math.max(0, input.now.getTime() - input.hwmAt.getTime());
  const reasons: string[] = [];
  const add = (r: string) => { if (!reasons.includes(r)) reasons.push(r); };
  const d = input.diff;
  // Read once: under SUPERVISOR_MATERIAL_TIERS_DISABLED=1 the verdict is the untiered one byte-for-byte
  // (no lane_ask reason, no tier / decisionReasons keys).
  const tiers = !materialTiersDisabled();

  if (input.alarm || (input.rows ?? []).some((r) => r.alarm === true)) add('alarm');
  const heartbeat = sinceMs >= floorHours * 3_600_000;
  if (heartbeat) add('heartbeat');
  if (d.ownerMessages.length) add('owner_message');
  if (d.ownerAnswers.length) add('owner_answer');
  if (d.statusChanges.length) add('goal_todo_change');
  // A provider-transient failure whose resume took over is listed, not material (ALARM-CAUSE-AWARE; the flag is only set while it is on).
  if (d.runsFailed.some((r) => r.resumeQueued !== true)) add('lane_failed');
  if (d.artifacts.some((a) => a.tool === 'open_pull_request' || a.tool === 'merge_pull_request')) add('artifact');
  if (input.origin === 'sweep' && d.stalledLanes.length) add('stall');

  if (input.origin === 'hook') {
    for (const r of input.rows ?? []) {
      // LANE-IDLE-WAKE: a lane idle with open work and nothing to wake it — named as its own DECISION reason.
      if (r.wakeKind === 'lane_idle' && !laneIdleWakeOff()) add('lane_idle');
      if (r.alarm === true) continue;
      // ALARM-CAUSE-AWARE: a stop by a chat / a provider-limit failure with its resume queued / a lane self-stop with live work.
      if (r.quietCause) continue;
      if (r.eventType === 'todo_done') { add('todo_done'); continue; }
      if (r.eventType !== 'run_completed') { add(`event:${r.eventType || 'unknown'}`); continue; }
      const prev = r.sourceChatId ? input.prevSummaryBySource?.[r.sourceChatId] : undefined;
      // A new report that asks the supervisor something / names a blocker is a DECISION (lane_ask), not progress.
      if (!isNearDuplicateRunSummary(r.summary, prev)) add(tiers && laneAskCue(runSummaryAskText(r.summary)) ? 'lane_ask' : 'new_report');
    }
  }

  if (input.origin === 'drain') {
    for (const m of input.drain ?? []) {
      if (input.isFleet && m.sourceIsProjectSupervisor) {
        if (!classifyReportUp(m.body).statusOnly) add('report_ask_or_change');
        continue;
      }
      if (!m.sourceIsLane) { add('peer_message'); continue; }
      const prev = m.sourceChatId ? input.prevAgentBodyBySource?.[m.sourceChatId] : undefined;
      // A lane's question / blocker is a DECISION (lane_ask) — a held drain is acked with no turn.
      if (!isNearDuplicate(m.body, prev)) add(tiers && laneAskCue(m.body) ? 'lane_ask' : 'lane_report');
    }
    // An empty batch is never a reason to skip a message nobody classified.
    if (!(input.drain ?? []).length) add('peer_message');
  }

  const verdict: MaterialVerdict = { material: reasons.length > 0, reasons, heartbeat, sinceMin: Math.round(sinceMs / 60_000), floorHours };
  if (!tiers) return verdict;
  const { tier, decisionReasons } = tierOfReasons(reasons, d);
  return { ...verdict, tier, decisionReasons };
}

/**
 * The lanes behind a PROGRESS-tier verdict — the chats whose forward motion
 * made it material: the group's report rows (hook), the lane messages (drain),
 * the PRs, the lane-made todo closes and the finished / resume-queued runs in
 * the window. Never the supervisor itself. An empty set means nothing proves
 * the work moves on its own (the caller delivers). Pure.
 */
export function progressSourceLaneIds(input: Pick<MaterialInput, 'origin' | 'diff' | 'rows' | 'drain'>): string[] {
  const out = new Set<string>();
  const add = (id: unknown) => { if (typeof id === 'string' && id && id !== input.diff.chatId) out.add(id); };
  if (input.origin === 'hook') for (const r of input.rows ?? []) if (r.alarm !== true && !r.quietCause) add(r.sourceChatId);
  if (input.origin === 'drain') for (const m of input.drain ?? []) if (m.sourceIsLane) add(m.sourceChatId);
  const d = input.diff;
  for (const a of d.artifacts) if (a.tool === 'open_pull_request' || a.tool === 'merge_pull_request') add(a.chatId);
  for (const c of d.statusChanges) if (statusChangeTier(c) === 'progress') add(c.byChatId);
  for (const r of d.runsFinished) add(r.chatId);
  for (const r of d.runsFailed) if (r.resumeQueued === true) add(r.chatId);
  return [...out];
}

export type ProgressSkipWhy = 'not_progress' | 'progress_heartbeat' | 'no_source_lanes' | 'stalled_lane' | 'too_many_lanes' | 'lookup_failed' | 'not_self_driving' | 'self_driving';

/**
 * The tier decision for ONE material verdict. Pure. A DECISION verdict is never
 * gated; a PROGRESS verdict past the progress heartbeat delivers; a source lane
 * the diff lists as STALLED (in-progress work, no live run, no armed schedule)
 * or more source lanes than one read covers delivers (review fix 2026-10-20);
 * otherwise it would skip only when every source lane is self-driving
 * (`selfDriving` true — null means the lookup failed or never ran ⇒ deliver).
 */
export function progressSkipDecision(input: {
  verdict: Pick<MaterialVerdict, 'material' | 'tier'>;
  sinceMs: number;
  progressHeartbeatHours: number;
  sourceLanes: number;
  selfDriving: boolean | null;
  /** A source lane is in the diff's stalledLanes. */
  stalledSource?: boolean;
  /** More source lanes than lane-self-driving reads (SELF_DRIVING_MAX_LANES). */
  tooManyLanes?: boolean;
}): { wouldSkip: boolean; why: ProgressSkipWhy } {
  if (!input.verdict.material || input.verdict.tier !== 'progress') return { wouldSkip: false, why: 'not_progress' };
  if (input.sinceMs >= input.progressHeartbeatHours * 3_600_000) return { wouldSkip: false, why: 'progress_heartbeat' };
  if (input.sourceLanes <= 0) return { wouldSkip: false, why: 'no_source_lanes' };
  if (input.stalledSource === true) return { wouldSkip: false, why: 'stalled_lane' };
  if (input.tooManyLanes === true) return { wouldSkip: false, why: 'too_many_lanes' };
  if (input.selfDriving === null) return { wouldSkip: false, why: 'lookup_failed' };
  return input.selfDriving ? { wouldSkip: true, why: 'self_driving' } : { wouldSkip: false, why: 'not_self_driving' };
}

// ── The [SINCE YOUR LAST WAKE] block ────────────────────────────────────────

export const WAKE_LEDGER_HEADING = '[SINCE YOUR LAST WAKE';
/** The same diff read on an OWNER turn (FS context map 2026-10-22, gap #3) — the mark is NOT advanced by it. */
export const OWNER_LEDGER_HEADING = '[SINCE YOUR LAST NOTE — harness diff';
export const WAKE_LEDGER_MAX_CHARS = 3500;
const SECTION_ROWS = 6;

const short = (id: unknown): string => String(id ?? '').slice(0, 8);
const clip = (v: unknown, n: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
/**
 * Round-3 review (FS owner-turn context, 2026-10-23): an owner / agent message head is redacted BEFORE the clip,
 * on a window to the end of the token on the clip's edge (secret-scan redactInboundHead), so a key pasted near the
 * start of a message never rides the diff, whole or as a fragment. Same output shape as clip(). Pure apart from
 * the redactor's own switch reads; never throws.
 */
const redactedClip = (v: unknown, n: number): string => {
  const { text, cut } = redactInboundHead(v, n);
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : cut ? `${s}…` : s;
};
const hhmm = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(11, 16)}Z` : '?';
};
const lane = (chatId: string, title?: string): string => (title ? `${short(chatId)} "${clip(title, 40)}"` : short(chatId));
function more<T>(rows: T[], render: (r: T) => string, max = SECTION_ROWS): string {
  const shown = rows.slice(0, max).map(render).join('; ');
  return rows.length > max ? `${shown}; +${rows.length - max} more` : shown;
}

/**
 * Render the diff as ONE compact block (≤ WAKE_LEDGER_MAX_CHARS). Ids are the
 * 8-char PREFIX every platform tool resolves. Empty sections are omitted; an
 * empty diff says so in one line. Pure.
 */
export function renderWakeLedgerDiff(d: WakeLedgerDiff, opts: { floorHours?: number; verdict?: MaterialVerdict | null; ownerTurn?: boolean } = {}): string {
  const sinceMin = Math.max(0, Math.round((Date.parse(d.now) - Date.parse(d.since)) / 60_000));
  const floor = opts.floorHours ?? materialGateFloorHours();
  const lines: string[] = [];
  const tiersNote = materialTiersDisabled() ? '' : `; progress from lanes still driving themselves is held up to ${progressHeartbeatHours()} h`;
  // Owner turn: the same rows under a heading that says what the window is (since the last completed WAKE —
  // an owner turn never moves the mark) and that the owner is waiting on the answer.
  lines.push(opts.ownerTurn
    ? `${OWNER_LEDGER_HEADING} ${d.since.slice(0, 16)}Z → ${d.now.slice(0, 16)}Z (${sinceMin} min, since your last completed wake); read from the ledger by the harness, not written by any model. The owner is on this turn: answer "what moved / where is X" from these rows or a fresh read, never from an older note.]`
    : `${WAKE_LEDGER_HEADING} — harness ledger diff ${d.since.slice(0, 16)}Z → ${d.now.slice(0, 16)}Z (${sinceMin} min); read from the ledger by the harness, not written by any model. Wakes with no material change are skipped and counted (a heartbeat wake fires at least every ${floor} h; alarms and owner messages always deliver${tiersNote}) — a missing wake is by design.]`);
  const n0 = lines.length;
  if (d.ownerMessages.length) lines.push(`Owner messages: ${more(d.ownerMessages, (m) => `${m.self ? 'in this chat' : `on ${lane(m.chatId, m.title)}`} ${hhmm(m.at)} "${redactedClip(m.head, 120)}"`)}`);
  if (d.ownerAnswers.length) lines.push(`Owner answers: ${more(d.ownerAnswers, (a) => `${clip(a.id, 11)} ${a.status}${a.by === 'default' ? ' (default auto-answer)' : ''} ${hhmm(a.at)}${a.head ? ` "${clip(a.head, 80)}"` : ''}`)}`);
  if (d.statusChanges.length) lines.push(`Goals/todos (changed by others): ${more(d.statusChanges, (c) => `${c.kind} ${short(c.id)}${c.title ? ` "${clip(c.title, 50)}"` : ''} ${c.from && c.to ? `${c.from}→${c.to}` : c.action.replace(/^(goal|todo)\./, '')}${c.byChatId ? ` by ${short(c.byChatId)}` : ' by owner/harness'} ${hhmm(c.at)}`)}`);
  if (d.otherLedgerChanges) lines.push(`Other ledger rows (in_progress flips, lane-created todos, notes): ${d.otherLedgerChanges}`);
  const runBits: string[] = [];
  if (d.runsFinished.length) runBits.push(`finished ${d.runsFinished.length} (${more(d.runsFinished, (r) => `${lane(r.chatId, r.title)} ${hhmm(r.at)}`, 4)})`);
  if (d.runsFailed.length) runBits.push(`FAILED ${d.runsFailed.length} (${more(d.runsFailed, (r) => `${lane(r.chatId, r.title)} ${hhmm(r.at)}${r.resumeQueued ? ' [provider limit — resume queued]' : ''}${r.error ? `: ${clip(r.error, 80)}` : ''}`, 4)})`);
  if (d.runsCancelled) runBits.push(`cancelled ${d.runsCancelled}`);
  if (d.runsStarted) runBits.push(`started ${d.runsStarted}`);
  if (d.runsRunning) runBits.push(`running now ${d.runsRunning}`);
  if (runBits.length) lines.push(`Lane runs: ${runBits.join(' · ')}`);
  if (d.artifacts.length) lines.push(`Artifacts: ${more(d.artifacts, (a) => `${a.tool === 'merge_pull_request' ? 'PR merged' : a.tool === 'open_pull_request' ? 'PR opened' : a.tool === 'git_push' ? 'push' : a.tool}${a.ref ? ` ${clip(a.ref, 24)}` : ''}${a.workItem ? ` → ${a.workItem}` : a.unattributed ? ` → unattributed` : ''} (${lane(a.chatId, a.title)} ${hhmm(a.at)})`)}`);
  if (d.schedulesFired || d.schedulesStopped.length) {
    lines.push(`Schedules: ${d.schedulesFired} fired${d.schedulesStopped.length ? ` · stopped ${more(d.schedulesStopped, (s) => `${short(s.id)} on ${lane(s.chatId, s.title)}${s.status ? ` (${clip(s.status, 30)})` : ''} ${hhmm(s.at)}`, 4)}` : ''}`);
  }
  if (d.agentMessages.length) lines.push(`Agent messages to you: ${more(d.agentMessages, (m) => `from ${lane(m.fromChatId, m.title)} ${hhmm(m.at)} "${redactedClip(m.head, 100)}"`, 4)}`);
  if (d.directivesOpened) lines.push(`Owner directives captured: ${d.directivesOpened} new (see [SUPERVISOR STATE])`);
  if (d.tickets.length) lines.push(`Tickets: ${more(d.tickets, (t) => `${short(t.id)} "${clip(t.title, 50)}" ${t.isNew ? 'filed' : 'now'} ${t.status}${t.source === 'user' ? ' (owner)' : ''}`, 4)}`);
  if (d.stalledLanes.length) {
    lines.push(laneIdleWakeOff()
      ? `Idle lanes holding in-progress work (no live run, no armed schedule): ${more(d.stalledLanes, (s) => `${lane(s.chatId, s.title)} — todo ${short(s.todoId)}${s.todoTitle ? ` "${clip(s.todoTitle, 40)}"` : ''}, idle ${s.idleMin} min`, 4)}`
      : `Idle lanes holding open work (no live run, no schedule due within 2 h or its own cadence): ${more(d.stalledLanes, (s) => `${lane(s.chatId, s.title)} — todo ${short(s.todoId)}${s.todoTitle ? ` "${clip(s.todoTitle, 40)}"` : ''}${s.todoStatus === 'pending' ? ' (pending)' : ''}, ${s.neverStarted ? `never started, assigned ${s.idleMin} min ago` : `idle ${s.idleMin} min`}`, 4)}`);
  }
  if (d.gateSkips.length) lines.push(`Skipped by the material gate since your last wake (near-duplicate / immaterial events${materialTiersDisabled() ? '' : ', or progress from lanes still driving themselves'}): ${more(d.gateSkips, (g) => `${lane(g.sourceChatId, g.title)} ×${g.n}`, 4)}`);
  if (lines.length === n0) lines.push('Nothing recorded in the ledger since your last wake.');
  const pc = d.psCovered;
  if (pc && (pc.runsFinished || pc.artifacts || pc.todosDone || pc.other)) {
    const bits = [
      pc.runsFinished ? `${pc.runsFinished} run(s) finished` : '',
      pc.prs ? `${pc.prs} PR(s)` : '',
      pc.artifacts - pc.prs > 0 ? `${pc.artifacts - pc.prs} push(es)` : '',
      pc.todosDone ? `${pc.todosDone} todo(s) done` : '',
      pc.other ? `${pc.other} other ledger row(s)` : '',
    ].filter(Boolean);
    lines.push(`Progress in ${pc.projects} project(s) with their own project supervisor (${pc.lanes} chat(s)) is left to those supervisors and omitted here: ${bits.join(' · ')}.${pc.alarmsDelayed ? ' Their alarms reach you only as a delayed [PS ESCALATION] when the project supervisor has not handled them.' : ''}`);
  }
  if (d.truncated?.length) lines.push(`(Read bounds hit for: ${d.truncated.join(', ')} — use list_chats / goal_list for the rest.)`);
  if (opts.verdict) {
    lines.push(opts.verdict.material
      ? `Material: yes — ${opts.verdict.reasons.join(', ')}`
      : 'Material: no — this wake delivered only because the gate is observing (shadow) on this process');
  }
  let text = lines.join('\n');
  if (text.length > WAKE_LEDGER_MAX_CHARS) text = `${text.slice(0, WAKE_LEDGER_MAX_CHARS - 40)}\n… [diff clipped — read the ledger for the rest]`;
  return text;
}

// ── Continuity history ──────────────────────────────────────────────────────

const HARNESS_USER_ROW_RE = /^\s*\[(?:\d+ status-only report-up|MATERIAL GATE|HARNESS CONTINUATION|SCHEDULER NOTICE|SINCE YOUR LAST WAKE)/i;

/** A user-role history row the harness or another agent wrote (wake prompt, agent send, queue banner, ack). Pure. */
export function isMachineUserRow(content: unknown): boolean {
  const s = String(content ?? '');
  return isMachineAuthoredText(s) || HARNESS_USER_ROW_RE.test(s);
}

export const ELIDED_WAKE_PROMPT =
  '[earlier machine wake — its prompt (preamble + state snapshot of that time) is elided; what changed since your last wake is in [SINCE YOUR LAST WAKE] below]';
const HUMAN_ROW_MAX_CHARS = 4000;
const NOTE_MAX_CHARS = 6000;

/**
 * The continuity slice of a supervisor MACHINE wake: the last `maxNotes`
 * turns that carry a reply of its own, plus every owner-typed turn in the
 * window (owner words are never dropped). Machine prompts become a one-line
 * stub (their state snapshots are stale by construction — the diff replaces
 * them); role alternation is preserved turn by turn. Pure.
 */
export function selectWakeContinuityHistory(history: ReadonlyArray<{ role: string; content: string }>, maxNotes: number = wakeHistoryNotes()): Array<{ role: 'user' | 'assistant'; content: string }> {
  type Turn = { users: string[]; assistants: string[] };
  const turns: Turn[] = [];
  for (const h of history) {
    const content = String(h?.content ?? '');
    if (h?.role === 'user') {
      const last = turns[turns.length - 1];
      if (last && last.assistants.length === 0) last.users.push(content);
      else turns.push({ users: [content], assistants: [] });
    } else if (h?.role === 'assistant') {
      if (!turns.length) turns.push({ users: [], assistants: [] });
      turns[turns.length - 1].assistants.push(content);
    }
  }
  const keep = new Set<number>();
  let notes = 0;
  for (let i = turns.length - 1; i >= 0 && notes < Math.max(1, maxNotes); i -= 1) {
    if (turns[i].assistants.length) { keep.add(i); notes += 1; }
  }
  turns.forEach((t, i) => { if (t.users.some((u) => !isMachineUserRow(u))) keep.add(i); });
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  [...keep].sort((a, b) => a - b).forEach((i) => {
    const t = turns[i];
    const human = t.users.filter((u) => !isMachineUserRow(u));
    if (human.length) out.push({ role: 'user', content: human.map((u) => (u.length > HUMAN_ROW_MAX_CHARS ? `${u.slice(0, HUMAN_ROW_MAX_CHARS)} …[clipped]` : u)).join('\n\n') });
    else if (t.users.length) out.push({ role: 'user', content: ELIDED_WAKE_PROMPT });
    for (const a of t.assistants) out.push({ role: 'assistant', content: a.length > NOTE_MAX_CHARS ? `${a.slice(0, NOTE_MAX_CHARS)} …[clipped]` : a });
  });
  return out;
}
