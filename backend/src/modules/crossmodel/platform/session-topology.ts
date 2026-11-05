/**
 * Session topology policy — dedicated vs shared lanes (SESSION_TITLES_TOPOLOGY
 * design §B, 2026-09-27; shipped OBSERVE-ONLY with the `session_topology`
 * decision-gate purpose in SHADOW).
 *
 * WHY: nothing anywhere asked "does a lane for this goal exist?" before a
 * start_coding_session — every guard was a volume bound. Verified 2026-09-27:
 * 17 lanes on one canlegal-bench goal, ≈170 crossmodel chats under 30 wordings
 * of 4 ideas; goal-less satellites spent $2,476 / 14 d for 0 todos; a 1-goal
 * child lane reaches a mutating receipt in 2.8 min vs 29 min for a 3+-goal
 * lane; a poller ("Bounty Submission Status Inquiry") burned 252 runs.
 *
 * ONE pure function, `decideTopology(input)`, over the project's GOAL→LANE
 * INDEX (`buildLaneIndex`): per lane {title, charterGoalId, charterTodoIds,
 * planGoal, ageDays, runs14d, running, enabledSchedules, busySkips24h,
 * compactionsPerRun, goalsHeld, lastMutatingReceiptAgeSec, worktreeBranch}.
 *
 *   R1 duplicate  — the lane that OWNS the goal (charterGoalId) or holds the
 *                   same todoId (or Jaccard ≥ SESSION_TOPOLOGY_OVERLAP_MIN on
 *                   normalised goal words vs a lane's charter / plan goal)
 *                   ⇒ reuse that lane (send_chat_message), never a second lane.
 *                   A lane that merely holds ANOTHER open todo of the goal (no
 *                   charter) is NOT an owner — that case is R3 when the new todo
 *                   depends on one it holds, else R2 / R7 (fixer 2026-09-27:
 *                   fanning independent todos of one goal out is allowed).
 *   R2 independent — no charter overlap ⇒ spawn a dedicated lane (the busy
 *                   signals of the would-be host are the reason).
 *   R3 shared OK  — the request's todo depends on a todo the lane holds AND the
 *                   lane holds ≤ 2 goals ⇒ reuse (one worktree, one critical path).
 *   R4 monitor    — a GET-only watch ⇒ schedule, never a lane. NARROW (fixer
 *                   2026-09-27): only a charter-less request (no goalId / todoId),
 *                   a monitor verb, a CADENCE cue (every / hourly / until / poll …),
 *                   a URL / PR / issue reference and NO mutating verb (verify /
 *                   investigate / audit / review / test / design count as mutating
 *                   — a todo-bound verify spawn is never a watch).
 *   LANES         — only chats WITH a coding state (chat_coding_state row) are
 *                   lanes; plain project conversations never become R1 targets,
 *                   R5 hosts or R6 retire candidates (fixer 2026-09-27; the index
 *                   still lists them with isCoding:false for the Sessions view).
 *   R5 satellite  — no goal, no schedule, prompt ≤ 400 chars, the caller's own
 *                   lane exists and is idle ⇒ merge (todo_create on the parent +
 *                   send_chat_message).
 *   R6 retire     — non-supervisor lane, 0 enabled schedules, no OPEN charter
 *                   (charterOpen — the charter todo / goal as it stands now, not
 *                   the mere stamp; LANE-IDLE-RETIRE 2026-10-21), last mutating
 *                   receipt > 6 h, not running ⇒ retire candidate. The archiver
 *                   scan (session-topology-outcomes) hands candidates to
 *                   lane-retire.ts, which archives only a PROVEN machine-spawned
 *                   lane idle ≥ 7 d (LANE_IDLE_RETIRE_DISABLED=1 = observe-only).
 *   R7 ambiguous  — overlap in the grey band (or two rules fire) ⇒ the
 *                   decision-gate purpose `session_topology`; shadow ⇒ spawn.
 *
 * ENFORCEMENT: SESSION_TOPOLOGY_ENFORCE=0 (default) = observe-only: every
 * decision is logged (loop_metrics `session_topology`) and the spawn proceeds
 * with an advisory line. `=1` makes R1 / R4 REFUSE with the alternative named;
 * R2 / R3 / R5 / R6 stay advisory until the gate acts. Fail-open on every read
 * (a partial index is used, a thrown anything ⇒ spawn as before).
 *
 * Kill switches: SESSION_TOPOLOGY_DISABLED=1 (no pre-check at all),
 * SESSION_TOPOLOGY_ENFORCE, SESSION_TOPOLOGY_OVERLAP_MIN (0.6),
 * LANE_IDLE_RETIRE_DISABLED=1 (R6 keys on the charter STAMP again — a lane
 * whose charter todo is done is never a candidate — and nothing archives).
 *
 * LEAF: prisma / logger / loop-metrics / decision-gate statically; the plan
 * store dynamically (coding/* → platform/* would cycle).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { killSwitchOn } from '../../../utils/kill-switch';
import { LOOP_METRIC_KINDS, recordLoopMetric } from './loop-metrics.service';
import { decide, decisionMode, decisionThreshold, stashDecision, type DecisionQuestion, type DecisionStash } from './decision-gate';
import { PLATFORM_MUTATING_TOOLS } from './platform-tool-names';
import { lookupCharterRow, type SharedProjectRole } from './shared-project-access';

// ── Tunables ─────────────────────────────────────────────────────────────────

export const SESSION_TOPOLOGY_PURPOSE = 'session_topology' as const;
export const SESSION_TOPOLOGY_QUESTION = 'placement';
export const SESSION_TOPOLOGY_DEFAULT_THRESHOLD = 0.85;
export const SESSION_TOPOLOGY_TIMEOUT_MS = 2500;
/** Index read deadline — past it the pre-check fails open with whatever landed. */
export const SESSION_TOPOLOGY_INDEX_TIMEOUT_MS = 2500;
export const SESSION_TOPOLOGY_DEFAULT_OVERLAP_MIN = 0.6;
/** R7 grey band: overlap ≥ this fraction of OVERLAP_MIN (but below it) asks the gate. */
export const SESSION_TOPOLOGY_GREY_FRACTION = 0.5;
export const SESSION_TOPOLOGY_R2_BUSY_SKIPS = 20;
export const SESSION_TOPOLOGY_R2_COMPACTIONS_PER_RUN = 0.1;
export const SESSION_TOPOLOGY_R2_COMPACTION_GOALS = 3;
export const SESSION_TOPOLOGY_R2_SCHEDULES = 2;
export const SESSION_TOPOLOGY_R3_MAX_GOALS = 2;
export const SESSION_TOPOLOGY_R5_MAX_PROMPT_CHARS = 400;
export const SESSION_TOPOLOGY_R6_IDLE_MS = 6 * 3600_000;
export const SESSION_TOPOLOGY_MAX_LANES = 200;
export const SESSION_TOPOLOGY_MAX_PLAN_READS = 40;
export const SESSION_TOPOLOGY_STATE_MAX_CHARS = 4000;
export const SESSION_TOPOLOGY_DISABLED_ENV = 'SESSION_TOPOLOGY_DISABLED';
export const SESSION_TOPOLOGY_ENFORCE_ENV = 'SESSION_TOPOLOGY_ENFORCE';
export const SESSION_TOPOLOGY_OVERLAP_MIN_ENV = 'SESSION_TOPOLOGY_OVERLAP_MIN';
/** LANE-IDLE-RETIRE (2026-10-21): release switch — =1 restores the stamp-keyed R6 predicate and the observe-only scan. */
export const LANE_IDLE_RETIRE_DISABLED_ENV = 'LANE_IDLE_RETIRE_DISABLED';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};
export function sessionTopologyDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env[SESSION_TOPOLOGY_DISABLED_ENV]); }
export function sessionTopologyEnforce(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env[SESSION_TOPOLOGY_ENFORCE_ENV]); }
export function laneIdleRetireDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return killSwitchOn(env[LANE_IDLE_RETIRE_DISABLED_ENV]); }
export function sessionTopologyOverlapMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env[SESSION_TOPOLOGY_OVERLAP_MIN_ENV]);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : SESSION_TOPOLOGY_DEFAULT_OVERLAP_MIN;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface LaneIndexRow {
  laneId: string;
  title: string;
  charterGoalId: string | null;
  charterTodoIds: string[];
  /** open-todo goal ids the lane is assigned (≠ charter) */
  goalIds: string[];
  planGoal: string | null;
  ageDays: number;
  runs14d: number;
  running: boolean;
  enabledSchedules: number;
  busySkips24h: number;
  compactionsPerRun: number;
  goalsHeld: number;
  lastMutatingReceiptAgeSec: number | null;
  worktreeBranch: string | null;
  parentChatId: string | null;
  isSupervisor: boolean;
  /** true iff the chat has a coding state (a real lane); plain conversations are never placement targets. */
  isCoding: boolean;
  /**
   * LANE-IDLE-RETIRE (2026-10-21): the charter is still OPEN — charterTodoId is
   * an open todo (pending / in_progress / blocked) still assigned to this lane
   * or to nobody, or charterGoalId is an active / blocked goal. A missing todo /
   * goal row reads closed; a failed or timed-out leg reads OPEN (fail-safe) and
   * marks the index partial. `charterTodoIds` (the placement input) is unchanged.
   */
  charterOpen: boolean;
  /** A human rename pinned the title (crossmodel_chats.titlePinned). */
  titlePinned: boolean;
}

/** The rows the placement rules may target: coding lanes that are not supervisors. Pure. */
export function placementLanes(lanes: LaneIndexRow[]): LaneIndexRow[] {
  return lanes.filter((l) => !l.isSupervisor && l.isCoding);
}

export type TopologyVerdict = 'spawn' | 'reuse' | 'merge' | 'retire' | 'schedule';
export type TopologyRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';

export interface TopologyInput {
  goalId?: string | null;
  todoId?: string | null;
  /** The request's goal text (goal / todo title, spawn title, prompt head) — the R1 word match input. */
  goalText?: string | null;
  prompt?: string | null;
  hasSchedule?: boolean;
  callerChatId?: string | null;
  dependsOnTodoIds?: string[];
  lanes: LaneIndexRow[];
  overlapMin?: number;
}

export interface TopologyDecision {
  verdict: TopologyVerdict;
  rule: TopologyRule;
  target?: string;
  reason: string;
  signals: Record<string, unknown>;
  /** R7: the gate is asked; `verdict` above is the fail-open default. */
  ambiguous?: boolean;
  candidates?: Array<{ laneId: string; overlap: number; title: string }>;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'from', 'is', 'are', 'be', 'this', 'that', 'it', 'as', 'into', 'via', 'per', 'we', 'you', 'our', 'your', 'lane', 'session', 'task', 'work', 'goal', 'todo', 'please', 'run', 'do']);

/** Normalised goal words (lowercase, alnum, no stop words, ≥ 3 chars, light stemming). Pure. */
export function normalizeGoalWords(text: unknown): Set<string> {
  const out = new Set<string>();
  for (const raw of String(text ?? '').toLowerCase().replace(/[^a-z0-9#+.\s-]/g, ' ').split(/\s+/)) {
    let w = raw.replace(/^[-.]+|[-.]+$/g, '');
    if (!w || w.length < 3 || STOP.has(w)) continue;
    // light stemming: plurals (types → type, images → image, boxes → box, queries → query), -ing, -ed
    const stem = (x: string): string => {
      if (/ies$/.test(x) && x.length > 4) return x.slice(0, -3) + 'y';
      if (/(s|x|z|ch|sh)es$/.test(x) && x.length > 4) return x.slice(0, -2);
      if (/[^s]s$/.test(x) && x.length > 3) return x.slice(0, -1);
      if (/ing$/.test(x) && x.length > 5) return x.slice(0, -3);
      if (/ed$/.test(x) && x.length > 4) return x.slice(0, -2);
      return x;
    };
    w = stem(w);
    if (w.length >= 3) out.add(w);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

const MONITOR_VERB_RE = /\b(watch|poll|check|probe|status|monitor|ping|track|inquire|inquiry)\b/i;
/** Fixer 2026-09-27: verify / investigate / audit / review / test / design / diagnose / reproduce / analyse are WORK, never a watch. */
const MUTATING_VERB_RE = /\b(fix|implement|build|write|add|create|change|refactor|merge|open a pr|open pr|commit|push|deploy|migrate|delete|remove|rename|rewrite|update the code|patch|ship|land|resolve|train|benchmark|run the|execute|verify|investigate|audit|review|test|design|diagnose|reproduce|analy[sz]e)\b/i;
/** Fixer 2026-09-27: a bare 8-hex token (every chat / ticket / commit id) no longer counts as a watch reference. */
const REF_RE = /(https?:\/\/\S+|\bPRs?\s*#?\d+|\bissues?\s*#?\d+|#\d{2,})/i;
/** A watch RECURS — without a cadence cue the request is a one-off read, not a schedule. */
const CADENCE_RE = /\b(every|hourly|daily|weekly|nightly|periodically|recurring|until|poll(?:ing|s)?|keep (?:checking|watching|polling|tracking)|each (?:hour|day|minute|week|morning|night)|on a schedule)\b/i;

/** R4: a GET-only watch — monitor verb + cadence cue + a URL / PR / issue reference + NO mutating verb. Pure. */
export function isMonitorPrompt(text: unknown): boolean {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  return MONITOR_VERB_RE.test(t) && CADENCE_RE.test(t) && !MUTATING_VERB_RE.test(t) && REF_RE.test(t);
}

function laneWords(l: LaneIndexRow, goalTitles: Record<string, string>): Set<string> {
  const parts: string[] = [];
  if (l.charterGoalId && goalTitles[l.charterGoalId]) parts.push(goalTitles[l.charterGoalId]);
  if (l.planGoal) parts.push(l.planGoal);
  if (!parts.length) parts.push(l.title);
  return normalizeGoalWords(parts.join(' '));
}

function laneBusySignals(l: LaneIndexRow): { busy: boolean; why: string[] } {
  const why: string[] = [];
  if (l.running) why.push('running');
  if (l.busySkips24h >= SESSION_TOPOLOGY_R2_BUSY_SKIPS) why.push(`${l.busySkips24h} busy-skips/24h`);
  if (l.compactionsPerRun >= SESSION_TOPOLOGY_R2_COMPACTIONS_PER_RUN && l.goalsHeld >= SESSION_TOPOLOGY_R2_COMPACTION_GOALS) why.push(`${l.compactionsPerRun.toFixed(2)} compactions/run over ${l.goalsHeld} goals`);
  if (l.enabledSchedules >= SESSION_TOPOLOGY_R2_SCHEDULES) why.push(`${l.enabledSchedules} enabled schedules`);
  return { busy: why.length > 0, why };
}

/**
 * THE placement rule set. `goalTitles` maps goal id → title for the word
 * match (the caller loads them with the index). Pure, deterministic.
 */
export function decideTopology(input: TopologyInput, goalTitles: Record<string, string> = {}): TopologyDecision {
  const overlapMin = input.overlapMin ?? SESSION_TOPOLOGY_DEFAULT_OVERLAP_MIN;
  // Only coding lanes are placement targets — a plain conversation in the
  // project is never a reuse / merge target (fixer 2026-09-27).
  const lanes = placementLanes(input.lanes);
  const reqWords = normalizeGoalWords([input.goalText ?? '', input.goalId && goalTitles[input.goalId] ? goalTitles[input.goalId] : ''].join(' '));
  const promptHead = String(input.prompt ?? '');
  const base = { goalId: input.goalId ?? null, todoId: input.todoId ?? null, lanes: lanes.length, reqWords: reqWords.size };

  // R4 — a watch is a schedule, never a lane. Charter-bound requests (goalId /
  // todoId) are deliverables by construction and skip the watch detector.
  const charterBound = !!(input.goalId || input.todoId);
  if (!charterBound && (isMonitorPrompt(promptHead) || (!promptHead && isMonitorPrompt(input.goalText)))) {
    return { verdict: 'schedule', rule: 'R4', reason: 'the request is a GET-only recurring watch (monitor verb, a cadence cue, no mutating verb, a URL / PR / issue reference) — arm schedule_message on the owning lane or yourself instead of a lane', signals: { ...base, monitor: true } };
  }

  // R1 — exact charter match (the lane that OWNS the goal, or holds this very
  // todo), then word overlap. A lane holding a DIFFERENT open todo of the same
  // goal is not an owner (fixer 2026-09-27): independent todos of one goal may
  // fan out; a dependent one is R3.
  const exact = lanes.filter((l) => (input.goalId && l.charterGoalId === input.goalId) || (input.todoId && l.charterTodoIds.includes(input.todoId)));
  if (exact.length) {
    const target = exact.sort((a, b) => Number(b.running) - Number(a.running) || b.runs14d - a.runs14d)[0];
    return { verdict: 'reuse', rule: 'R1', target: target.laneId, reason: `lane ${target.laneId.slice(0, 8)} "${target.title.slice(0, 60)}" already holds this ${input.todoId && target.charterTodoIds.includes(input.todoId) ? 'todo' : 'goal'} — send_chat_message it; never a second lane`, signals: { ...base, overlap: 1, exact: true, candidates: exact.length } };
  }
  const scored = lanes.map((l) => ({ laneId: l.laneId, title: l.title, overlap: jaccard(reqWords, laneWords(l, goalTitles)), lane: l })).sort((a, b) => b.overlap - a.overlap);
  const best = scored[0];
  if (best && best.overlap >= overlapMin) {
    return { verdict: 'reuse', rule: 'R1', target: best.laneId, reason: `lane ${best.laneId.slice(0, 8)} "${best.title.slice(0, 60)}" works the same goal (word overlap ${best.overlap.toFixed(2)} ≥ ${overlapMin}) — send_chat_message it; never a second lane`, signals: { ...base, overlap: Number(best.overlap.toFixed(3)) }, candidates: scored.slice(0, 3).map(({ laneId, title, overlap }) => ({ laneId, title, overlap: Number(overlap.toFixed(3)) })) };
  }

  // R3 — a dependency on a todo the lane holds, lane ≤ 2 goals.
  const deps = new Set(input.dependsOnTodoIds ?? []);
  if (deps.size) {
    const shared = lanes.find((l) => l.goalsHeld <= SESSION_TOPOLOGY_R3_MAX_GOALS && l.charterTodoIds.some((t) => deps.has(t)));
    if (shared) {
      return { verdict: 'reuse', rule: 'R3', target: shared.laneId, reason: `the request depends on a todo lane ${shared.laneId.slice(0, 8)} holds and that lane holds ≤ ${SESSION_TOPOLOGY_R3_MAX_GOALS} goals — one worktree, one critical path: route it there`, signals: { ...base, sharedDependency: true, goalsHeld: shared.goalsHeld } };
    }
  }

  // R7 — grey-band overlap: the gate decides (shadow ⇒ spawn).
  if (best && best.overlap >= overlapMin * SESSION_TOPOLOGY_GREY_FRACTION) {
    return { verdict: 'spawn', rule: 'R7', ambiguous: true, target: best.laneId, reason: `overlap ${best.overlap.toFixed(2)} with lane ${best.laneId.slice(0, 8)} is in the grey band (${(overlapMin * SESSION_TOPOLOGY_GREY_FRACTION).toFixed(2)}–${overlapMin}) — ambiguous`, signals: { ...base, overlap: Number(best.overlap.toFixed(3)) }, candidates: scored.slice(0, 3).map(({ laneId, title, overlap }) => ({ laneId, title, overlap: Number(overlap.toFixed(3)) })) };
  }

  // R5 — one-run satellite: no goal, no schedule, short prompt, idle parent.
  const parent = input.callerChatId ? lanes.find((l) => l.laneId === input.callerChatId) : undefined;
  if (!input.goalId && !input.todoId && !input.hasSchedule && promptHead.length > 0 && promptHead.length <= SESSION_TOPOLOGY_R5_MAX_PROMPT_CHARS && parent && !parent.running) {
    return { verdict: 'merge', rule: 'R5', target: parent.laneId, reason: `a short goal-less prompt (${promptHead.length} chars) with an idle parent lane — todo_create on the parent and send_chat_message it instead of a one-run satellite`, signals: { ...base, promptChars: promptHead.length, parentIdle: true } };
  }

  // R2 — independent: spawn a dedicated lane (name the would-be host's busy signals).
  const host = parent ?? (best?.lane) ?? null;
  const busy = host ? laneBusySignals(host) : { busy: false, why: [] as string[] };
  return { verdict: 'spawn', rule: 'R2', reason: host ? `no charter overlap with any lane${busy.busy ? `; the nearest lane ${host.laneId.slice(0, 8)} is busy (${busy.why.join(', ')})` : ''} — a dedicated lane with its own worktree and fresh context` : 'no lanes in the project yet — a dedicated lane', signals: { ...base, overlap: best ? Number(best.overlap.toFixed(3)) : 0, hostBusy: busy.busy, hostSignals: busy.why } };
}

/**
 * R6 candidates over the index. Pure. LANE-IDLE-RETIRE (2026-10-21): the
 * charter test is `!charterOpen` — the old `charterTodoIds.length === 0` read
 * the STAMP, so a lane whose charter todo was done (or reassigned) was never a
 * candidate again. Open assigned todos still exclude through `goalIds`.
 * LANE_IDLE_RETIRE_DISABLED=1 restores the stamp predicate.
 */
export function retireCandidates(lanes: LaneIndexRow[], opts: { now?: Date; env?: NodeJS.ProcessEnv } = {}): Array<{ laneId: string; title: string; idleSec: number | null }> {
  const stampKeyed = laneIdleRetireDisabled(opts.env);
  return placementLanes(lanes)
    .filter((l) => !l.running && l.enabledSchedules === 0 && (stampKeyed ? l.charterTodoIds.length === 0 : !l.charterOpen) && l.goalIds.length === 0 && (l.lastMutatingReceiptAgeSec == null ? l.ageDays * 86400 > SESSION_TOPOLOGY_R6_IDLE_MS / 1000 && l.runs14d === 0 : l.lastMutatingReceiptAgeSec * 1000 > SESSION_TOPOLOGY_R6_IDLE_MS))
    .map((l) => ({ laneId: l.laneId, title: l.title, idleSec: l.lastMutatingReceiptAgeSec }));
}

// ── Index ────────────────────────────────────────────────────────────────────

const OPEN_TODO = ['pending', 'in_progress', 'blocked'];
/** A charter goal in one of these is still being worked (goal status: active | blocked | done | archived). */
const OPEN_GOAL = ['active', 'blocked'];

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
  });
}

export interface LaneIndex { lanes: LaneIndexRow[]; goalTitles: Record<string, string>; partial: boolean }

/**
 * The project's goal→lane index. Bounded, fail-open (partial on any leg's error / timeout).
 *
 * `scan` (lane-retire's candidate walk, review fixer 2026-10-21): one PAGE of
 * the project's CODING lanes only, ordered by id after `afterId`, with no plan
 * reads (planGoal stays null — no R6 input reads it). Without it the index is
 * the 200 most-recently-updated chats of any kind, which is what placement
 * wants and what a long-idle lane falls off.
 */
export async function buildLaneIndex(projectId: string, userId: string, opts: { now?: Date; timeoutMs?: number; scan?: { afterId?: string | null } } = {}): Promise<LaneIndex> {
  const now = opts.now ?? new Date();
  const timeoutMs = opts.timeoutMs ?? SESSION_TOPOLOGY_INDEX_TIMEOUT_MS;
  const scan = opts.scan;
  let partial = false;
  const chats = await withDeadline(prisma.crossModelChat.findMany({
    where: { projectId, userId, archivedAt: null, ...(scan ? { codingState: { isNot: null }, ...(scan.afterId ? { id: { gt: scan.afterId } } : {}) } : {}) },
    select: { id: true, title: true, charterGoalId: true, charterTodoId: true, createdAt: true, parentChatId: true, isSupervisor: true, isProjectSupervisor: true, titlePinned: true },
    orderBy: scan ? { id: 'asc' } : { updatedAt: 'desc' }, take: SESSION_TOPOLOGY_MAX_LANES,
  }), timeoutMs, null as any[] | null);
  if (!chats) return { lanes: [], goalTitles: {}, partial: true };
  const ids = chats.map((c: any) => c.id as string);
  if (!ids.length) return { lanes: [], goalTitles: {}, partial: false };
  const d14 = new Date(now.getTime() - 14 * 86400_000);
  const d1 = new Date(now.getTime() - 86400_000);
  // LANE-IDLE-RETIRE (2026-10-21): the charter todos as they stand NOW (status +
  // assignee) — the charterOpen leg. Skipped when no lane carries a charter todo,
  // and under LANE_IDLE_RETIRE_DISABLED=1 (the index reads exactly what it read before).
  const charterLegs = !laneIdleRetireDisabled();
  const charterTodoIdList = charterLegs ? [...new Set(chats.map((c: any) => c.charterTodoId).filter((t: unknown): t is string => typeof t === 'string' && !!t))] : [];
  const legs = await Promise.all([
    withDeadline((prisma as any).chatCodingState.findMany({ where: { id: { in: ids } }, select: { id: true, branch: true, status: true } }), timeoutMs, null),
    withDeadline(prisma.projectTodo.findMany({ where: { projectId, assigneeChatId: { in: ids }, status: { in: OPEN_TODO } }, select: { id: true, goalId: true, assigneeChatId: true } }), timeoutMs, null),
    withDeadline(prisma.agentRun.groupBy({ by: ['sessionId'], where: { sessionId: { in: ids }, createdAt: { gte: d14 } }, _count: { _all: true } } as any), timeoutMs, null),
    withDeadline(prisma.agentRun.findMany({ where: { sessionId: { in: ids }, status: { in: ['running', 'queued'] } }, select: { sessionId: true }, take: 500 }), timeoutMs, null),
    withDeadline((prisma as any).chatSchedule.groupBy({ by: ['sessionId'], where: { sessionId: { in: ids }, enabled: true }, _count: { _all: true } }), timeoutMs, null),
    withDeadline(prisma.loopMetric.groupBy({ by: ['sessionId'], where: { kind: LOOP_METRIC_KINDS.SCHEDULE_BUSY_SKIP, sessionId: { in: ids }, createdAt: { gte: d1 } }, _count: { _all: true } } as any), timeoutMs, null),
    withDeadline(prisma.loopMetric.groupBy({ by: ['sessionId'], where: { kind: LOOP_METRIC_KINDS.CONTEXT_COMPACTION, sessionId: { in: ids }, createdAt: { gte: d14 } }, _count: { _all: true } } as any), timeoutMs, null),
    // The newest mutating receipt per lane. Lane lifecycle second review fixer
    // (2026-10-21): a SCAN page (lane-retire's walk over every coding lane) reads
    // it as a groupBy MAX — Prisma runs `distinct` in memory, so the findMany
    // pulled EVERY such receipt of all 200 lanes (no LIMIT) and a folder of
    // long-lived lanes timed the leg out, leaving its pages partial (= never
    // evaluated) pass after pass. The placement index keeps its read.
    scan
      ? withDeadline(Promise.resolve().then(() => (prisma.runToolReceipt as any).groupBy({ by: ['chatId'], where: { chatId: { in: ids }, ok: true, tool: { in: [...PLATFORM_MUTATING_TOOLS, 'open_pull_request', 'merge_pull_request', 'run_command'] } }, _max: { createdAt: true } }))
        .then((rows: Array<{ chatId: string; _max?: { createdAt?: Date | null } }>) => rows.filter((r) => r._max?.createdAt).map((r) => ({ chatId: r.chatId, createdAt: r._max!.createdAt as Date }))), timeoutMs, null)
      : withDeadline(prisma.runToolReceipt.findMany({ where: { chatId: { in: ids }, ok: true, tool: { in: [...PLATFORM_MUTATING_TOOLS, 'open_pull_request', 'merge_pull_request', 'run_command'] } }, orderBy: { createdAt: 'desc' }, distinct: ['chatId'], select: { chatId: true, createdAt: true } }), timeoutMs, null),
    charterTodoIdList.length
      ? withDeadline(prisma.projectTodo.findMany({ where: { id: { in: charterTodoIdList } }, select: { id: true, status: true, assigneeChatId: true } }), timeoutMs, null)
      : Promise.resolve([]),
  ]);
  const [states, todos, runs, running, schedules, skips, compactions, receipts, charterTodos] = legs as any[];
  if (legs.some((l) => l == null)) partial = true;
  const count = (rows: any[] | null, key = 'sessionId'): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows ?? []) m.set(String(r[key]), Number(r._count?._all ?? 0));
    return m;
  };
  const stateBy = new Map<string, any>((states ?? []).map((s: any) => [s.id, s]));
  const runs14 = count(runs); const scheds = count(schedules); const skip24 = count(skips); const comp14 = count(compactions);
  const runningSet = new Set<string>((running ?? []).map((r: any) => String(r.sessionId)));
  const receiptAt = new Map<string, Date>((receipts ?? []).map((r: any) => [r.chatId, r.createdAt]));
  const todosBy = new Map<string, Array<{ id: string; goalId: string }>>();
  for (const t of todos ?? []) {
    const list = todosBy.get(t.assigneeChatId) ?? [];
    list.push({ id: t.id, goalId: t.goalId });
    todosBy.set(t.assigneeChatId, list);
  }
  const goalIds = new Set<string>();
  for (const c of chats) if (c.charterGoalId) goalIds.add(c.charterGoalId);
  for (const t of todos ?? []) goalIds.add(t.goalId);
  const goalRows = goalIds.size ? await withDeadline(prisma.projectGoal.findMany({ where: { id: { in: [...goalIds] } }, select: { id: true, title: true, ...(charterLegs ? { status: true } : {}) } }), timeoutMs, null) : [];
  if (goalIds.size && !goalRows) partial = true;
  const goalTitles: Record<string, string> = {};
  for (const g of goalRows ?? []) goalTitles[g.id] = g.title;
  // charterOpen inputs: a FAILED leg (null) reads open — a lane is never retired on a read we did not get.
  const charterTodoBy = charterTodos ? new Map<string, any>((charterTodos as any[]).map((t: any) => [String(t.id), t])) : null;
  const goalStatusBy = goalRows ? new Map<string, string>((goalRows as any[]).map((g: any) => [String(g.id), String(g.status ?? '')])) : null;
  const charterOpenFor = (c: any): boolean => {
    let todoOpen = false;
    if (c.charterTodoId) {
      if (!charterTodoBy) todoOpen = true;
      else {
        const t = charterTodoBy.get(String(c.charterTodoId));
        todoOpen = !!t && OPEN_TODO.includes(String(t.status)) && (t.assigneeChatId == null || t.assigneeChatId === c.id);
      }
    }
    let goalOpen = false;
    if (c.charterGoalId) goalOpen = !goalStatusBy ? true : OPEN_GOAL.includes(goalStatusBy.get(String(c.charterGoalId)) ?? '');
    return todoOpen || goalOpen;
  };

  // Plan goals — bounded dynamic reads (the store is one row per lane). A scan page skips them.
  const planGoals = new Map<string, string>();
  try {
    const { getPlan } = await import('../coding/plan.service');
    const subset = scan ? [] : chats.filter((c: any) => !c.isSupervisor && !c.isProjectSupervisor).slice(0, SESSION_TOPOLOGY_MAX_PLAN_READS);
    const plans = await withDeadline(Promise.all(subset.map((c: any) => getPlan(c.id).catch(() => null))), timeoutMs, null);
    if (plans) subset.forEach((c: any, i: number) => { const g = plans[i]?.goal; if (typeof g === 'string' && g.trim()) planGoals.set(c.id, g.trim()); });
    else partial = true;
  } catch { partial = true; }

  const lanes: LaneIndexRow[] = chats.map((c: any) => {
    const st = stateBy.get(c.id);
    const mine = todosBy.get(c.id) ?? [];
    const r14 = runs14.get(c.id) ?? 0;
    const lastReceipt = receiptAt.get(c.id);
    const goalSet = new Set<string>(mine.map((t) => t.goalId));
    if (c.charterGoalId) goalSet.add(c.charterGoalId);
    return {
      laneId: c.id, title: c.title, charterGoalId: c.charterGoalId ?? null,
      charterTodoIds: [...new Set([...(c.charterTodoId ? [c.charterTodoId] : []), ...mine.map((t) => t.id)])],
      goalIds: mine.map((t) => t.goalId),
      planGoal: planGoals.get(c.id) ?? null,
      ageDays: Math.max(0, (now.getTime() - new Date(c.createdAt).getTime()) / 86400_000),
      runs14d: r14,
      running: runningSet.has(c.id) || st?.status === 'running',
      enabledSchedules: scheds.get(c.id) ?? 0,
      busySkips24h: skip24.get(c.id) ?? 0,
      compactionsPerRun: r14 > 0 ? (comp14.get(c.id) ?? 0) / r14 : 0,
      goalsHeld: goalSet.size,
      lastMutatingReceiptAgeSec: lastReceipt ? Math.max(0, Math.round((now.getTime() - new Date(lastReceipt).getTime()) / 1000)) : null,
      worktreeBranch: st?.branch ?? null,
      parentChatId: c.parentChatId ?? null,
      isSupervisor: c.isSupervisor === true || c.isProjectSupervisor === true,
      // A chat is a LANE only with a coding-state row. When the states leg
      // failed (partial index) nothing is a lane — the pre-check then fails
      // open to spawn, never to a reuse of an unknown chat.
      isCoding: !!st,
      charterOpen: charterOpenFor(c),
      titlePinned: c.titlePinned === true,
    };
  });
  return { lanes, goalTitles, partial };
}

// ── Gate (R7) ────────────────────────────────────────────────────────────────

const SESSION_TOPOLOGY_QUESTIONS: Record<string, DecisionQuestion> = {
  [SESSION_TOPOLOGY_QUESTION]: {
    type: 'choice',
    instructions: 'A supervisor is about to start a coding lane for the REQUEST below inside a project whose live lanes are listed with their charter goal, plan goal and load signals. Choose the placement that reaches a first mutating receipt fastest WITHOUT creating a duplicate owner for a goal another lane already holds: spawn a dedicated lane (independent goal, or the nearest lane is busy), reuse the nearest lane (same goal or one critical path — the lane id is given), merge the request into the caller lane as a todo (a short one-run satellite), or retire (the request is moot and the nearest lane should be archived).',
    criteria: {
      spawn: 'an independent goal, or the nearest lane is busy / compacting / over-scheduled — a dedicated lane with its own worktree wins',
      reuse: 'the nearest lane already works this goal or holds the todo this depends on — route the request to it',
      merge: 'a short goal-less follow-up the idle caller lane should just do as a todo',
      retire: 'the request is moot and the nearest lane has no open charter, no schedule and no recent receipt',
    },
  },
};

const hash8 = (s: string): string => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** The gate state: the index rows (ids hashed, ≤ SESSION_TOPOLOGY_STATE_MAX_CHARS) + the request head. Pure. */
export function buildTopologyState(decision: TopologyDecision, input: Pick<TopologyInput, 'goalText' | 'prompt' | 'goalId' | 'todoId' | 'hasSchedule'>, lanes: LaneIndexRow[], goalTitles: Record<string, string>): string {
  const head = [
    `REQUEST: ${String(input.goalText ?? '').slice(0, 200) || '(no goal text)'}${input.goalId ? ' [has goalId]' : ''}${input.todoId ? ' [has todoId]' : ''}${input.hasSchedule ? ' [schedule]' : ''}`,
    `PROMPT HEAD: ${String(input.prompt ?? '').replace(/\s+/g, ' ').slice(0, 300) || '(none)'}`,
    `RULE: ${decision.rule} ${decision.reason.slice(0, 200)}`,
    `NEAREST: ${decision.target ? hash8(decision.target) : 'none'} overlap ${String(decision.signals.overlap ?? '?')}`,
    'LANES (id · goal · plan · runs14d · running · schedules · busySkips24h · compactions/run · goals · lastReceiptAge):',
  ];
  const rows = placementLanes(lanes).slice(0, 25).map((l) => `- ${hash8(l.laneId)} · ${(l.charterGoalId && goalTitles[l.charterGoalId]) ? goalTitles[l.charterGoalId].slice(0, 50) : l.title.slice(0, 50)} · ${(l.planGoal ?? '-').slice(0, 50)} · ${l.runs14d} · ${l.running ? 'yes' : 'no'} · ${l.enabledSchedules} · ${l.busySkips24h} · ${l.compactionsPerRun.toFixed(2)} · ${l.goalsHeld} · ${l.lastMutatingReceiptAgeSec == null ? 'none' : `${Math.round(l.lastMutatingReceiptAgeSec / 60)}m`}`);
  let out = [...head, ...rows].join('\n');
  if (out.length > SESSION_TOPOLOGY_STATE_MAX_CHARS) out = out.slice(0, SESSION_TOPOLOGY_STATE_MAX_CHARS);
  return out;
}

export function sessionTopologyGateConsulted(): boolean {
  if (sessionTopologyDisabled()) return false;
  try { return decisionMode(SESSION_TOPOLOGY_PURPOSE) !== 'off'; } catch { return false; }
}

// ── Evaluate (DB + telemetry) ────────────────────────────────────────────────

export interface TopologyEvaluation {
  decision: TopologyDecision;
  index: LaneIndex;
  /** Under SESSION_TOPOLOGY_ENFORCE=1, R1 / R4 refuse with this text. */
  refusal: string | null;
  /** One advisory line for the tool result (observe-only). */
  advisory: string;
  decisionId: string | null;
  stash: DecisionStash | null;
  gateChoice: string | null;
  /** The `session_topology` row body (absent on a fail-open evaluation) — written by recordTopologyDecision. */
  telemetry?: Record<string, unknown> & { callerChatId: string | null };
}

export interface EvaluateTopologyOpts {
  userId: string;
  projectId: string;
  callerChatId?: string | null;
  goalId?: string | null;
  todoId?: string | null;
  title?: string | null;
  prompt?: string | null;
  hasSchedule?: boolean;
  /** 'spawn' = start_coding_session pre-check (telemetry source rule/gate), 'check' = the topology_check read tool. */
  site: 'spawn' | 'check';
  /** SHARED-PROJECT-DISPATCH: the caller's role resolver for a charter row it does not own (platform-tools passes
   *  getProjectAccess); absent = the owner / direct-member check. */
  projectRole?: (projectId: string, userId: string) => Promise<SharedProjectRole | null>;
  now?: Date;
}

/** SHARED-PROJECT-DISPATCH: the caller's role on a project when the caller passes no resolver — the owner, or a
 *  DIRECT member row (the charter title only feeds the placement verdict; platform-tools passes the full
 *  getProjectAccess resolver with folder inheritance). Never throws; null on any error. */
async function topologyProjectRole(projectId: string, userId: string): Promise<SharedProjectRole | null> {
  try {
    const p = await prisma.crossModelProject.findUnique({ where: { id: projectId }, select: { userId: true } });
    if (!p) return null;
    if (p.userId === userId) return 'owner';
    const m = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } }, select: { role: true } });
    const role = String(m?.role ?? '');
    return role === 'admin' || role === 'editor' || role === 'viewer' ? role : null;
  } catch {
    return null;
  }
}

/** The pre-check. NEVER throws; a thrown anything ⇒ a spawn-as-today evaluation. */
export async function evaluateTopology(opts: EvaluateTopologyOpts): Promise<TopologyEvaluation> {
  const now = opts.now ?? new Date();
  const fallback = (reason: string): TopologyEvaluation => ({
    decision: { verdict: 'spawn', rule: 'R2', reason, signals: { failOpen: true } },
    index: { lanes: [], goalTitles: {}, partial: true }, refusal: null, advisory: '', decisionId: null, stash: null, gateChoice: null,
  });
  if (sessionTopologyDisabled()) return fallback('topology pre-check disabled');
  try {
    const index = await buildLaneIndex(opts.projectId, opts.userId, { now });
    let goalText = String(opts.title ?? '').trim();
    let dependsOnTodoIds: string[] = [];
    // SHARED-PROJECT-DISPATCH (2026-10-20): goals / todos carry the PROJECT
    // OWNER's id — a member caller's charter read "not found". Caller-owned
    // row first, else { id, projectId } with a read-access check on the
    // project (shared-project-access lookupCharterRow; never throws).
    // SPAWN_MEMBER_ACCESS_DISABLED=1 restores the caller-scoped lookups.
    const goalId = opts.goalId;
    if (goalId && index.goalTitles[goalId]) goalText = `${goalText} ${index.goalTitles[goalId]}`.trim();
    else if (goalId) {
      const g = await lookupCharterRow<{ title: string; userId?: string | null; projectId?: string | null }>({
        findOwned: () => prisma.projectGoal.findFirst({ where: { id: goalId, userId: opts.userId }, select: { title: true } }) as any,
        findById: () => prisma.projectGoal.findFirst({ where: { id: goalId, projectId: opts.projectId }, select: { title: true, userId: true, projectId: true } }),
        projectRole: (pid) => (opts.projectRole ?? topologyProjectRole)(pid, opts.userId),
      }, opts.userId);
      if (g?.title) { goalText = `${goalText} ${g.title}`.trim(); index.goalTitles[goalId] = g.title; }
    }
    if (opts.todoId) {
      const todoId = opts.todoId;
      const todoSelect = { title: true, goalId: true, depsThis: { select: { dependsOnTodoId: true } } } as const;
      const t: any = await lookupCharterRow<any>({
        findOwned: () => prisma.projectTodo.findFirst({ where: { id: todoId, userId: opts.userId }, select: todoSelect }),
        findById: () => prisma.projectTodo.findFirst({ where: { id: todoId, projectId: opts.projectId }, select: { ...todoSelect, userId: true, projectId: true } }),
        projectRole: (pid) => (opts.projectRole ?? topologyProjectRole)(pid, opts.userId),
      }, opts.userId);
      if (t) {
        goalText = `${goalText} ${t.title}`.trim();
        dependsOnTodoIds = (t.depsThis ?? []).map((d: any) => String(d.dependsOnTodoId));
        if (!opts.goalId && t.goalId) opts = { ...opts, goalId: t.goalId };
      }
    }
    if (!goalText) goalText = String(opts.prompt ?? '').replace(/\s+/g, ' ').slice(0, 300);
    const input: TopologyInput = {
      goalId: opts.goalId ?? null, todoId: opts.todoId ?? null, goalText, prompt: opts.prompt ?? null, hasSchedule: opts.hasSchedule === true,
      callerChatId: opts.callerChatId ?? null, dependsOnTodoIds, lanes: index.lanes, overlapMin: sessionTopologyOverlapMin(),
    };
    const decision = decideTopology(input, index.goalTitles);

    // R7 — the gate (shadow-first; act designed: a confident reuse/merge/retire REPLACES the fail-open spawn).
    let decisionId: string | null = null; let stash: DecisionStash | null = null; let gateChoice: string | null = null; let source: 'rule' | 'gate' = 'rule';
    if (decision.ambiguous && sessionTopologyGateConsulted()) {
      try {
        const state = buildTopologyState(decision, input, index.lanes, index.goalTitles);
        const result = await decide(state, SESSION_TOPOLOGY_QUESTIONS, {
          purpose: SESSION_TOPOLOGY_PURPOSE, timeoutMs: SESSION_TOPOLOGY_TIMEOUT_MS, sessionId: opts.callerChatId ?? undefined, segment: 'machine',
          meta: { site: opts.site, rule: decision.rule, projectId: opts.projectId },
        });
        if (result) {
          decisionId = result.id;
          stash = stashDecision(result, SESSION_TOPOLOGY_PURPOSE, { extra: { site: opts.site, rule: decision.rule, ruleVerdict: decision.verdict, target: decision.target ?? null } });
          const a = result.answers[SESSION_TOPOLOGY_QUESTION];
          if (a && a.type === 'choice') {
            gateChoice = a.choice;
            const threshold = decisionThreshold(SESSION_TOPOLOGY_PURPOSE, SESSION_TOPOLOGY_DEFAULT_THRESHOLD);
            if (result.mode === 'act' && a.confidence >= threshold && (a.choice === 'reuse' || a.choice === 'merge' || a.choice === 'retire')) {
              decision.verdict = a.choice; source = 'gate';
              decision.reason = `${decision.reason}; the decision gate chose ${a.choice} (${a.confidence.toFixed(2)})`;
            }
          }
        }
      } catch (err: any) {
        logger.warn(`session-topology: gate ask failed (fail-open): ${err?.message ?? err}`);
      }
    }

    const enforce = sessionTopologyEnforce();
    const enforced = enforce && (decision.rule === 'R1' || decision.rule === 'R4');
    let refusal: string | null = null;
    if (enforced && decision.rule === 'R1' && decision.target) {
      refusal = `Refused: ${decision.reason}. Send the work to chat ${decision.target} with send_chat_message (its todo can be assigned with todo_update assigneeChatId). SESSION_TOPOLOGY_ENFORCE=0 makes this advisory.`;
    } else if (enforced && decision.rule === 'R4') {
      refusal = `Refused: ${decision.reason}. Use schedule_message (interval ≥ the expected change cadence) on the lane that owns the work or on yourself, ending in notify_user / a report — a watch never needs a lane. SESSION_TOPOLOGY_ENFORCE=0 makes this advisory.`;
    }
    const advisory = decision.verdict === 'spawn' && !decision.ambiguous
      ? ''
      : `[TOPOLOGY ${decision.rule} → ${decision.verdict}${decision.target ? ` ${decision.target.slice(0, 8)}` : ''}${enforce ? '' : ' (observe-only)'}] ${decision.reason}`;

    const telemetry = {
      site: opts.site, rule: decision.rule, verdict: decision.verdict, targetChatId: decision.target ?? null, goalId: opts.goalId ?? null, todoId: opts.todoId ?? null,
      projectId: opts.projectId, callerChatId: opts.callerChatId ?? null, signals: decision.signals, source, enforced, refused: !!refusal, partialIndex: index.partial, lanes: index.lanes.length,
      ...(decisionId ? { decisionId, gateChoice } : {}), ...(stash ? { stash } : {}),
      goalText: goalText.slice(0, 120),
    };
    return { decision, index, refusal, advisory, decisionId, stash, gateChoice, telemetry };
  } catch (err: any) {
    logger.warn(`session-topology: pre-check failed open: ${err?.message ?? err}`);
    return fallback(`topology pre-check failed open (${String(err?.message ?? err).slice(0, 80)})`);
  }
}

/**
 * Write the `session_topology` row for an evaluation — called by the spawn
 * executor AFTER the spawn attempt (so the row carries `spawnedChatId` for the
 * +24 h label) and by topology_check at once. A fail-open evaluation (no
 * telemetry) writes nothing. Never throws.
 */
export function recordTopologyDecision(ev: TopologyEvaluation, extras: { spawnedChatId?: string | null; refused?: boolean } = {}): void {
  if (!ev.telemetry) return;
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SESSION_TOPOLOGY, sessionId: ev.telemetry.callerChatId ?? undefined,
      meta: { ...ev.telemetry, ...(extras.spawnedChatId ? { spawnedChatId: extras.spawnedChatId } : {}), ...(extras.refused !== undefined ? { refused: extras.refused } : {}) },
    });
  } catch { /* telemetry never blocks */ }
}

/** Compact index rows for the topology_check tool result (no signals the model can misread as verdicts). */
export function renderLaneIndex(index: LaneIndex): Array<Record<string, unknown>> {
  return placementLanes(index.lanes).map((l) => ({
    chatId: l.laneId, title: l.title, charterGoalId: l.charterGoalId, charterGoal: l.charterGoalId ? index.goalTitles[l.charterGoalId] ?? null : null,
    openTodos: l.charterTodoIds.length, goalsHeld: l.goalsHeld, planGoal: l.planGoal, running: l.running, enabledSchedules: l.enabledSchedules,
    runs14d: l.runs14d, busySkips24h: l.busySkips24h, compactionsPerRun: Number(l.compactionsPerRun.toFixed(2)),
    lastMutatingReceiptAgeMin: l.lastMutatingReceiptAgeSec == null ? null : Math.round(l.lastMutatingReceiptAgeSec / 60), branch: l.worktreeBranch,
  }));
}
