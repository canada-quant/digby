/**
 * BOARD DIGEST (owner directive 2026-09-16, "inject the board, don't let the
 * model recall it") — the deterministic ledger block a supervisor wake carries
 * at the top of its user turn, next to [SUPERVISOR STATE] and [PROJECT
 * SCHEDULES].
 *
 * Why: every supervisor misstatement found in the 48h rollout watch was
 * RECALLED board state — an answered owner ruling reported "still OPEN"
 * (spark 2026-09-16: oq_bd1130d5, answered two days earlier), "same 4 active
 * goals" where the ledger had 1, a todo labelled with another todo's status.
 * The doctrine already says "read state fresh every wake"; a model that can
 * see the ledger in its context has nothing to recall. This block renders
 * goals, open todos and owner-question status straight from Postgres at
 * compose time, and the action verifier's board-assertion lane
 * (action-verifier.ts `findPhantomBoardAssertions`) strikes a note whose
 * status/open-closed claims contradict the same rows.
 *
 * Two scopes:
 *  - PROJECT supervisor: full ledger for its project — active/blocked goals
 *    (with registered premises, item 2), open todos with assignee + block
 *    reason, done-in-24h ids, owner questions (open + recently answered).
 *  - FLEET supervisor: one roll-up line per supervised project (goal/todo/
 *    owner-question counts) + every open owner question account-wide.
 *
 * Failure posture matches the sibling blocks: any error → '' (never break a
 * wake). Caps keep the block inside the wake budget; todos shrink first.
 * The pure renderer is exported for tests; the async builder reads prisma.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { computeProjectTiming, renderTimingLines, type ProjectTiming } from '../fleet/project-status.service';
// Supervisor OFF switch (owner 2026-09-26): the board carries the harness-
// composed "OFF since … — wakes skipped: N" line so a supervisor (or the owner
// reading its context) never mistakes a switched-off tier for a stalled one.
import { anySupervisorSwitchOff, getSupervisorSwitchState } from './supervisor-switch';
// KPI of record + adoption ladder (tt-rd audit 2026-09-27): a kpi: premise
// renders with its receipt, age, bar and last change; a goal whose KPI has
// not moved shows its harness-counted experiments-without-adoption.
import { isKpiPremise, kpiPremiseOf, renderKpiInline, renderPremiseReceiptSuffix } from './kpi-of-record';
// FLEET-PS-FIRST (supervisor SOTA round 2, 2026-10-20): the fleet roll-up gains
// one harness-read top-goal pace line per project (pure leaf).
import { fleetBoardGoalPaceDisabled, pickTopGoal, renderFleetPaceLine } from './fleet-ps-first';
import { loadAdoptionLadders, renderAdoptionLadderInline, type AdoptionLadder } from './adoption-ladder';
// sup3 audit C2 (2026-09-27): a goal closed 'done' with its own target
// premise unmet or a HOLD progress note is badged '⚠ suspect' for a week —
// pure assessment (premise + hold reasons; the directive reason needs the
// owner's supervisor state and rides only the close-time metric).
import { assessGoalDoneSuspect, renderGoalDoneSuspectBadge, GOAL_DONE_SUSPECT_DIRECTIVE_WINDOW_MS, type GoalDoneSuspectDirective } from './goal-done-suspect';
// GOAL-UNPLANNED (architecture review #6, 2026-10-20): the per-goal todo counts
// + the UNPLANNED tag (pure leaf).
import { isUnplannedGoal, goalUnplannedSignalDisabled } from './goal-unplanned';
// GOAL-OUTCOME-UNMET part 2 (2026-10-20): an older outcome-unmet close that is still live stays badged.
import { liveOutcomeUnmetGoalIds } from './goal-outcome';
import { renewRefusalBoardLine } from '../coding/renew-refusal-surface';
// GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20): goals rank by score (P1..P4 + accrual), the line
// leads with "[P1 · 82]" and carries the goal's harness-read 7-day spend (pure leaf + the spend read).
import {
  goalPriorityOrderDisabled, goalSpendAttributionDisabled, rankGoalsByScore, scoreGoal, renderGoalScorePrefix,
  renderGoalSpendClause, goalUnblockCounts, goalPriorityLabel, renderKpiGapText,
} from './goal-priority';
import { loadGoalSpend, knownGoalSpendUsd, GOAL_SPEND_WINDOW_DAYS, GOAL_SPEND_MAX_GOALS, type GoalSpendRead } from './goal-spend';
import { classifyOwnerGatedRows, computeNeedsYouUnion, type OwnerGatedRow, type OwnerGateCardView } from './owner-needs-you';
import { INLINE_OQ_ID_RE } from './owner-questions';
// TICKET dca83b85: the ONE answer to "is this project in the Fleet's scope?" —
// `supervised === false` opts a project out of every FLEET composition surface.
import { unsupervisedProjectIds } from './supervision-scope';

/** Non-mutating INLINE_OQ_ID_RE test (the shared regex carries lastIndex state). */
function INLINE_OQ_ID_RE_TEST(s: string): string | null { INLINE_OQ_ID_RE.lastIndex = 0; return INLINE_OQ_ID_RE.exec(s)?.[0] ?? null; }

const SOURCE = 'board-digest';

export const BOARD_BLOCK_PREFIX = '[BOARD';
export const BOARD_BLOCK_CAP = 4200;
export const FLEET_BOARD_BLOCK_CAP = 2400;
/** FLEET-PS-FIRST: extra room for the per-project top-goal pace lines — they shrink first and never push the
 *  owner-question section past the cap the block had without them. */
export const FLEET_BOARD_PACE_EXTRA_CAP = 1600;
/** CAP for the LANE board (2c203dac) — a lane sees its own linked rows only, a
 *  handful of lines; the cap guards a pathological linkage fan-out, never a
 *  normal lane board. */
export const LANE_BOARD_BLOCK_CAP = 1600;
/** Lane board (2c203dac): how many linked rows render before the "+N more" marker. */
export const LANE_BOARD_MAX_ROWS = 8;
/** The TIMING section appended to the project block (owner 2026-09-17). */
export const TIMING_BLOCK_CAP = 900;
export const TIMING_BLOCK_HEADER = 'TIMING (harness-measured — quote these when the owner asks what is going on or how much longer; never invent an estimate of your own):';

/** Pure: the timing section for the supervisor's context, capped. */
export function renderTimingBlock(timing: ProjectTiming, now: Date): string {
  const lines = [TIMING_BLOCK_HEADER, ...renderTimingLines(timing, now)];
  let body = lines.join('\n');
  while (body.length > TIMING_BLOCK_CAP && lines.length > 2) {
    lines.splice(lines.length - 2, 1); // drop the last lane/goal line, keep the tail line
    body = lines.join('\n');
  }
  return body.length <= TIMING_BLOCK_CAP ? body : `${body.slice(0, TIMING_BLOCK_CAP - 15)}\n…[truncated]`;
}
export const BOARD_MAX_GOALS = 12;
export const BOARD_MAX_TODOS = 20;
export const BOARD_MAX_DONE_IDS = 8;
export const BOARD_MAX_OQ = 8;
export const BOARD_TITLE_CHARS = 72;
export const BOARD_REASON_CHARS = 110;
/** "recently answered" window — long enough to cover a supervisor that last
 *  saw the question open, short enough to age out. */
export const BOARD_RECENT_ANSWER_MS = 72 * 60 * 60 * 1000;
export const BOARD_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** C2: a suspect 'done' close stays badged on the board this long (updatedAt-based). */
export const BOARD_SUSPECT_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const BOARD_MAX_SUSPECT_DONE = 4;

export interface BoardGoalRow {
  id: string;
  title: string;
  status: string;
  blockedReason?: string | null;
  blockKind?: string | null;
  progressNote?: string | null;
  updatedAt?: Date | string | null;
  /** Item 2 (premise register): registered quantitative premises. */
  premises?: unknown;
  /** Finding 3 (2026-09-27): the harness-measured adoption ladder for a goal with a kpi: premise. */
  adoption?: AdoptionLadder | null;
  /** audit 2026-10-08 W5-5: a directive recorded before the goal existed is its origin, never a suspect-close reason. */
  createdAt?: Date | string | null;
  /** GOAL-OUTCOME-UNMET part 2 (2026-10-20): a done goal OLDER than the suspect window whose outcome-unmet close is still live
   *  (goal-outcome.ts liveOutcomeUnmetGoalIds — set by the loader) stays badged: the dormancy gate keeps its project live,
   *  so the board must still say why. */
  outcomeLive?: boolean;
  /** GOAL-PRIORITY-SPEND (2026-10-20): stored priority 1..4 (null = P2), who set it, the optional due date. */
  priority?: number | null;
  prioritySource?: string | null;
  dueAt?: Date | string | null;
  /** GOAL-PRIORITY-SPEND: open goals that depend on this one (the score's unblock term; set by the loader). */
  unblockCount?: number;
  /** GOAL-PRIORITY-SPEND: attributed run_spend USD over GOAL_SPEND_WINDOW_DAYS (set by the loader; absent = unknown — no clause). */
  spendUsd?: number | null;
}
export interface BoardTodoRow {
  id: string;
  title: string;
  status: string;
  goalId?: string | null;
  assigneeChatId?: string | null;
  assigneeTitle?: string | null;
  blockedReason?: string | null;
  blockKind?: string | null;
  /** Todo 908f48a7: an owner gate the row is blocked on (the needs-you union's input). */
  gateQuestionId?: string | null;
  updatedAt?: Date | string | null;
}
export interface BoardOwnerQuestionRow {
  id: string;
  status: string;
  createdAt?: Date | string | null;
  resolvedAt?: Date | string | null;
  answeredBy?: string | null;
  question?: string | null;
}
export interface BoardFacts {
  projectName: string;
  goals: BoardGoalRow[];
  todos: BoardTodoRow[];
  ownerQuestions: BoardOwnerQuestionRow[];
  now: Date;
  /** The owner's open supervisor directives (board-time read, 2026-09-28) — lets a done goal a directive still names read '⚠ suspect: open_directive'. Absent = the badge set before the read. */
  directives?: GoalDoneSuspectDirective[];
  /** Todo 908f48a7 (monitor lesson 5): the needs-you union (open cards + owner-blocked + approved-but-never-landed). Absent = no gated rows were on the board; the render falls back to the open-questions section alone. */
  needsYouUnion?: { total: number; openCards: number; answeredUnlanded: number; ownerBlocked: number; unlandedTitles: string[]; ownerBlockedTitles?: string[] };
}
export interface FleetBoardProject {
  name: string;
  projectId: string;
  activeGoals: number;
  blockedGoals: number;
  openTodos: number;
  blockedTodos: number;
  openOwnerQuestions: number;
  /** C2: goals closed 'done' in the last week whose close is suspect (premise/hold reasons). */
  suspectDoneGoals?: number;
}

/**
 * C2: the done goals (within BOARD_SUSPECT_DONE_WINDOW_MS of `now`) whose
 * close is suspect on the row itself — target_* premise unmet / unobserved or
 * a HOLD token in the progress note. Pure.
 */
export function suspectDoneGoals(goals: BoardGoalRow[], now: number, opts: { directives?: GoalDoneSuspectDirective[]; projectName?: string | null } = {}): Array<{ goal: BoardGoalRow; badge: string }> {
  const out: Array<{ goal: BoardGoalRow; badge: string }> = [];
  // Board-time directive read (goals-lifecycle deferred piece, 2026-09-28): when the facts loader
  // supplied the owner's open directives, the `open_directive` reason is RE-DERIVED here instead of
  // being close-time only — a goal closed while a directive still names it stays badged until the
  // directive closes. No directives supplied ⇒ byte-identical to the premise / hold badges.
  const directives = Array.isArray(opts.directives) ? opts.directives : [];
  for (const g of goals) {
    if (g.status !== 'done') continue;
    const at = msOf(g.updatedAt);
    if ((!Number.isFinite(at) || now - at > BOARD_SUSPECT_DONE_WINDOW_MS) && g.outcomeLive !== true) continue;
    const verdict = assessGoalDoneSuspect(
      { id: g.id, createdAt: g.createdAt ?? null, title: g.title, progressNote: g.progressNote, premises: g.premises },
      directives,
      { now, projectName: opts.projectName ?? null },
    );
    // Only BOARD reasons badge (finding 1, 2026-09-27): a never-observed
    // target is telemetry, not a badge — the renderer returns '' for it.
    const badge = renderGoalDoneSuspectBadge(verdict, { withDirectives: directives.length > 0 });
    if (badge) out.push({ goal: g, badge });
  }
  return out;
}

const OPEN_TODO = new Set(['pending', 'in_progress', 'blocked']);
const clip = (s: unknown, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Lane title on a todo line (session titles + topology, deferred piece shipped 2026-09-28): 40 chars, and a
 *  harness "<goal> · <step>" title keeps BOTH halves — the step half never falls off the end (it is the
 *  half that says what the lane is doing NOW). */
export const BOARD_LANE_TITLE_CHARS = 40;
const LANE_TITLE_SEP = ' · ';
export function clipLaneTitle(title: unknown, max: number = BOARD_LANE_TITLE_CHARS): string {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const i = t.lastIndexOf(LANE_TITLE_SEP);
  if (i <= 0) return clip(t, max);
  const goal = t.slice(0, i).trim();
  const step = t.slice(i + LANE_TITLE_SEP.length).trim();
  if (!step) return clip(goal, max);
  const budget = max - LANE_TITLE_SEP.length;
  // the step half keeps at least a third of the budget; a short goal leaves it the rest
  const stepAlloc = Math.min(step.length, Math.max(Math.floor(budget / 3), budget - goal.length));
  const goalAlloc = budget - stepAlloc;
  return `${clip(goal, goalAlloc)}${LANE_TITLE_SEP}${clip(step, stepAlloc)}`;
}
const id8 = (id: unknown): string => String(id ?? '').slice(0, 8);
const oqId = (id: unknown): string => {
  const s = String(id ?? '');
  return s.startsWith('oq_') ? s.slice(0, 11) : `oq_${s.slice(0, 8)}`;
};
const msOf = (d: Date | string | null | undefined): number => (d ? new Date(d).getTime() : NaN);
const hhmmz = (d: Date | string | null | undefined): string => {
  const ms = msOf(d);
  return Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')}Z` : '?';
};

/** Finding C3 (2026-09-27): a premise revision stays on the board this long after revisedAt. */
export const BOARD_PREMISE_REVISION_WINDOW_MS = 72 * 60 * 60 * 1000;
export const BOARD_MAX_PREMISE_REVISIONS = 6;
const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4))));
const fmtSigned = (n: number): string => `${n > 0 ? '+' : n < 0 ? '-' : ''}${fmtNum(Math.abs(n))}`;
const fmtPct = (pct: number | null): string => (pct === null ? 'from 0' : `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Number(Math.abs(pct).toFixed(1))}%`);

/**
 * Finding C3: the like-for-like GAP between a premise and its `compareTo`
 * sibling — rendered ONLY when both carry the SAME manifest (suite/scorer id);
 * otherwise the line says why there is no gap (a judged frontier bar beside a
 * det-v2 score is not a gap). Pure; '' when no premise names a compareTo.
 */
export function renderPremiseGapsInline(premises: unknown): string {
  if (!Array.isArray(premises) || !premises.length) return '';
  const byKey = new Map<string, any>();
  for (const p of premises as any[]) if (p && typeof p === 'object' && typeof p.key === 'string') byKey.set(p.key.toLowerCase(), p);
  const parts: string[] = [];
  for (const p of premises as any[]) {
    if (!p || typeof p !== 'object' || typeof p.compareTo !== 'string') continue;
    const other = byKey.get(p.compareTo.toLowerCase());
    const a = Number(p.value); const b = Number(other?.value);
    if (!other || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const ka = clip(p.key, 28); const kb = clip(other.key, 28);
    if (p.manifest && other.manifest && String(p.manifest).toLowerCase() === String(other.manifest).toLowerCase()) {
      parts.push(`gap ${ka}-${kb}=${fmtSigned(a - b)}${p.unit ? String(p.unit) : ''} (like-for-like: ${clip(p.manifest, 40)})`);
    } else {
      const why = !p.manifest || !other.manifest
        ? `manifest unset on ${!p.manifest ? ka : kb}`
        : `${clip(p.manifest, 40)} vs ${clip(other.manifest, 40)}`;
      parts.push(`no like-for-like gap ${ka} vs ${kb} (${why})`);
    }
    if (parts.length >= 3) break;
  }
  return parts.length ? ` · ${parts.join('; ')}` : '';
}

/**
 * Which finding-C3 decorations a goal line carries. The shrink ladder in
 * renderProjectBoardBlock turns them off under cap pressure (gaps first, the
 * manifest tags later) — both default ON; PREMISE_REVISION_DISABLED=1 hides
 * both regardless.
 */
export interface PremiseLineDetail { gaps?: boolean; manifests?: boolean }
/** GOAL-UNPLANNED (2026-10-20): the goal line's todo counts and UNPLANNED tag — both ON by default; the shrink ladder drops them FIRST, before any older rung (counts, then the per-line tags fold into one GOALS-header count, then that goes). */
export interface GoalLineDetail extends PremiseLineDetail { todoCounts?: boolean; unplannedTag?: boolean }

/** Item 2: one-line rendering of a goal's registered premises (see premise-register.ts).
 *  2026-09-27 (kpi-honesty-loops finding 2b): the kpi: premise renders FIRST as
 *  `KPI <key>=<value> (receipt <id8> · <age> · bar ≥N) · last change a→b @HH:MMZ`;
 *  any other premise with a receipt shows `(receipt <id8> · <age>)`. `now` is
 *  the age clock (defaults to the wall clock). The finding-C3 `detail` (gaps /
 *  manifests) may be passed as the second argument in place of `now`. */
export function renderPremisesInline(premises: unknown, nowOrDetail: Date | PremiseLineDetail = new Date(), maybeDetail: PremiseLineDetail = {}): string {
  const now = nowOrDetail instanceof Date ? nowOrDetail : new Date();
  const detail: PremiseLineDetail = nowOrDetail instanceof Date ? maybeDetail : nowOrDetail;
  if (!Array.isArray(premises) || !premises.length) return '';
  const withManifests = detail.manifests !== false;
  const parts: string[] = [];
  const ordered = [...(premises as any[])].sort((a, b) => Number(isKpiPremise(b)) - Number(isKpiPremise(a)));
  for (const p of ordered.slice(0, 4) as any[]) {
    if (!p || typeof p !== 'object') continue;
    const drift = p.drift === 'drift' && Number.isFinite(Number(p.observed))
      ? ` ⚠ source now reads ${Number(p.observed)}${p.unit ? String(p.unit) : ''}`
      : p.drift === 'error' ? ' (source unreadable)' : p.lastError ? ' (last check failed)' : '';
    // A recorded `observed` that is NOT a drift (a lane's goal_premise_set observed / observedNote on a
    // target premise, or a source read that differs from the registered value) rides the ACTIVE line
    // too (goals-lifecycle deferred piece, 2026-09-28) — before this it showed only on a drift line.
    const observedInline = !drift
      && Number.isFinite(Number(p.observed)) && (p.observedNote || Number(p.observed) !== Number(p.value))
      ? ` (observed ${Number(p.observed)}${p.unit ? String(p.unit) : ''}${p.observedNote ? ', manual' : ''})`
      : '';
    // Finding C3: the manifest rides the value so two scores on different scorers never read as one number.
    const manifest = p.manifest && withManifests ? ` [${clip(p.manifest, 40)}]` : '';
    if (isKpiPremise(p) && Number.isFinite(Number(p.value))) {
      parts.push(`${renderKpiInline({ ...p, value: Number(p.value) }, now)}${manifest}${observedInline}${drift}`);
      continue;
    }
    const key = clip(p.key ?? p.label, 28);
    const val = Number.isFinite(Number(p.value)) ? `${Number(p.value)}${p.unit ? String(p.unit) : ''}` : '?';
    parts.push(`${key}=${val}${manifest}${renderPremiseReceiptSuffix(p, now)}${observedInline}${drift}`);
  }
  return parts.length ? ` · premises: ${parts.join('; ')}${detail.gaps === false ? '' : renderPremiseGapsInline(premises)}` : '';
}

/**
 * Finding C3: the PREMISE REVISIONS lines the project board PREPENDS (right
 * under the header, before GOALS) — every premise whose value was re-registered
 * beyond tolerance inside the window, newest first, capped. A same-stack
 * regression (spark's 30.88→18.6 tok/s) is no longer invisible: the number, the
 * old number and the percent sit at the top of every supervisor wake for 72h.
 */
export function renderPremiseRevisionLines(goals: BoardGoalRow[], now: Date, cap: number = BOARD_MAX_PREMISE_REVISIONS): string[] {
  const rows: Array<{ at: number; line: string }> = [];
  for (const g of goals) {
    if (!Array.isArray(g.premises)) continue;
    for (const p of g.premises as any[]) {
      if (!p || typeof p !== 'object' || typeof p.key !== 'string') continue;
      const at = msOf(p.revisedAt); const oldV = Number(p.prevValue); const newV = Number(p.value);
      if (!Number.isFinite(at) || !Number.isFinite(oldV) || !Number.isFinite(newV) || now.getTime() - at > BOARD_PREMISE_REVISION_WINDOW_MS || at > now.getTime() + 60_000) continue;
      const pct = oldV === 0 ? null : ((newV - oldV) / Math.abs(oldV)) * 100;
      const unit = p.unit ? String(p.unit) : '';
      const manifest = p.prevManifest && p.manifest && String(p.prevManifest) !== String(p.manifest)
        ? ` — manifest ${clip(p.prevManifest, 40)}→${clip(p.manifest, 40)}, not like-for-like`
        : p.manifest ? ` [${clip(p.manifest, 40)}]` : '';
      rows.push({ at, line: `- goal ${id8(g.id)} premise ${clip(p.key, 28)} revised ${fmtNum(oldV)}→${fmtNum(newV)}${unit} (${fmtPct(pct)}) at ${hhmmz(p.revisedAt)}${manifest}` });
    }
  }
  if (!rows.length) return [];
  rows.sort((a, b) => b.at - a.at);
  // cap 0 = the ladder's one-line rung: the count survives, the lines do not.
  const keep = Math.max(0, Math.min(BOARD_MAX_PREMISE_REVISIONS, Math.floor(cap)));
  if (keep === 0) return [`PREMISE REVISIONS (last 72h): ${rows.length} premise value(s) moved beyond tolerance — board at capacity; goal_get names old→new, say why each moved.`];
  const lines = rows.slice(0, keep).map((r) => r.line);
  if (rows.length > keep) lines.push(`- +${rows.length - keep} more revised (use goal_get)`);
  return [`PREMISE REVISIONS (last 72h — a re-registered number moved beyond tolerance; compare results against the NEW value and say why it moved):`, ...lines];
}

/**
 * Pure renderer for a PROJECT supervisor's board. Deterministic; the same
 * facts always render the same block (tests pin the shape).
 */
export function renderProjectBoardBlock(facts: BoardFacts): string {
  const now = facts.now.getTime();
  const goals = [...facts.goals];
  // GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20): the tracked goals render RANKED by score
  // (goal-priority.ts — P1..P4, owner-set wins, + due / age / KPI-gap / unblock accrual; ties keep the
  // loader's createdAt order) and each line LEADS with "[P1 · 82]" (" owner" when the owner set it); open
  // todos rank by their goal's score inside each status band. All of it is the FIRST text the shrink ladder
  // folds. GOAL_PRIORITY_ORDER_DISABLED=1 renders creation order with no prefix / header note;
  // GOAL_SPEND_ATTRIBUTION_DISABLED=1 drops the "7d $…" clause — both set = the pre-change block byte-for-byte.
  const rankOn = !goalPriorityOrderDisabled();
  const spendOn = !goalSpendAttributionDisabled();
  const scoreById = new Map<string, number>();
  if (rankOn) for (const g of goals) scoreById.set(g.id, scoreGoal(g, { now, unblockCount: g.unblockCount ?? 0 }));
  const trackedRaw = goals.filter((g) => g.status === 'active' || g.status === 'blocked');
  const active = rankOn
    ? rankGoalsByScore(trackedRaw, { now, unblockCounts: new Map(trackedRaw.map((g) => [g.id, g.unblockCount ?? 0])) }).map((r) => r.goal)
    : trackedRaw;
  const doneN = goals.filter((g) => g.status === 'done').length;
  const archivedN = goals.filter((g) => g.status === 'archived').length;
  // GOAL-UNPLANNED (architecture review #6, 2026-10-20): every tracked goal line
  // carries its own todo counts ('· todos <open> open/<done> done' — dropped
  // rows leave the bar, as in the digest) and an ACTIVE goal with zero open
  // todos is tagged UNPLANNED: before this the board showed an active goal
  // with nothing left to do as a plain '[active]' line and the digest read it
  // 'all tasks done'. GOAL_UNPLANNED_SIGNAL_DISABLED=1 renders the pre-change
  // line byte-for-byte.
  const unplannedOn = !goalUnplannedSignalDisabled();
  const todoCounts = new Map<string, { open: number; done: number }>();
  if (unplannedOn) {
    for (const t of facts.todos) {
      if (!t.goalId) continue;
      const c = todoCounts.get(t.goalId) ?? { open: 0, done: 0 };
      if (OPEN_TODO.has(t.status)) c.open += 1;
      else if (t.status === 'done') c.done += 1;
      todoCounts.set(t.goalId, c);
    }
  }
  const unplannedIds = new Set(unplannedOn ? active.filter((g) => isUnplannedGoal(g, todoCounts.get(g.id)?.open ?? 0)).map((g) => g.id) : []);
  // GOAL-PRIORITY-SPEND: what of the ranking text is still shown (the ladder folds spend → score → label).
  let rank = { spend: true, score: true, label: true };
  const goalLine = (g: BoardGoalRow, detail: GoalLineDetail): string => {
    const block = g.status === 'blocked' && (g.blockedReason || g.blockKind)
      ? ` — blocked${g.blockKind ? ` (${g.blockKind})` : ''}: ${clip(g.blockedReason, BOARD_REASON_CHARS)}`
      : '';
    const ladder = g.adoption ? renderAdoptionLadderInline(g.adoption) : '';
    const tc = todoCounts.get(g.id) ?? { open: 0, done: 0 };
    const counts = unplannedOn && detail.todoCounts !== false ? ` · todos ${tc.open} open/${tc.done} done` : '';
    const tag = unplannedIds.has(g.id) && detail.unplannedTag !== false ? ' · UNPLANNED' : '';
    const prefix = rankOn && rank.label ? `${renderGoalScorePrefix(g, rank.score ? scoreById.get(g.id) ?? null : null)} ` : '';
    const spend = spendOn && rank.spend && typeof g.spendUsd === 'number' ? ` · ${renderGoalSpendClause(g.spendUsd, GOAL_SPEND_WINDOW_DAYS)}` : '';
    return `- ${prefix}goal ${id8(g.id)} [${g.status}] "${clip(g.title, BOARD_TITLE_CHARS)}"${block}${spend}${counts}${tag}${renderPremisesInline(g.premises, facts.now, detail)}${ladder ? ` · ${ladder}` : ''}`;
  };
  // C2: recent suspect closes ride as their own lines + a header count. The
  // remedy clause lives in the doctrine, not here (review fix 2026-09-27,
  // finding 2: four unshrinkable ~230-char lines pushed a realistic board over
  // the cap and the tail slice ate OWNER QUESTIONS — the one section that is
  // never cut). These lines now SHRINK (see the strategy below) before any
  // hard slice; the header count is the floor that always survives.
  const suspect = suspectDoneGoals(goals, now, { directives: facts.directives, projectName: facts.projectName });
  const suspectMarker = (hidden: number): string => `- …${hidden} more suspect close${hidden === 1 ? '' : 's'} (use goal_list)`;
  const shrinkSuspect = (keep: number): string[] => {
    const lines = suspect.slice(0, keep).map(({ goal: g, badge }) => `- goal ${id8(g.id)} [done ${badge}] "${clip(g.title, BOARD_TITLE_CHARS)}" — closed ${hhmmz(g.updatedAt)}`);
    return suspect.length > keep ? [...lines, suspectMarker(suspect.length - keep)] : lines;
  };
  // GOAL-UNPLANNED: once the ladder folds the per-line UNPLANNED tags (rung 0b),
  // ONE header count keeps the signal unless the block is still over (0c).
  let unplannedHeader = false;
  const goalsHeaderOf = (): string => `GOALS: ${active.length} active/blocked · ${doneN} done${suspect.length ? ` (${suspect.length} ⚠ suspect)` : ''} · ${archivedN} archived${unplannedHeader && unplannedIds.size ? ` · ${unplannedIds.size} UNPLANNED (no open todos)` : ''}${rankOn && rank.label && active.length ? ` · ranked by [priority${rank.score ? ' · score' : ''}], P1 highest` : ''}`;

  const open = facts.todos.filter((t) => OPEN_TODO.has(t.status));
  const doneRecent = facts.todos
    .filter((t) => (t.status === 'done' || t.status === 'dropped') && Number.isFinite(msOf(t.updatedAt)) && now - msOf(t.updatedAt) <= BOARD_DONE_WINDOW_MS)
    .sort((a, b) => msOf(b.updatedAt) - msOf(a.updatedAt));
  const statusRank: Record<string, number> = { in_progress: 0, blocked: 1, pending: 2 };
  // EVERY open todo renders here; the cap/limit logic below decides how many
  // lines survive and ALWAYS leaves a "…N more (use todo_list)" marker when it
  // drops any, so the model never mistakes the visible list for the whole board.
  // GOAL-PRIORITY-SPEND: inside a status band, the todo of the higher-scored goal first (rankOn only).
  const todoGoalScore = (t: BoardTodoRow): number => (rankOn && t.goalId ? scoreById.get(t.goalId) ?? 0 : 0);
  const todoLines = open
    .sort((a, b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) || todoGoalScore(b) - todoGoalScore(a) || msOf(b.updatedAt) - msOf(a.updatedAt))
    .map((t) => {
      const lane = t.assigneeChatId ? ` → lane ${id8(t.assigneeChatId)}${t.assigneeTitle ? ` "${clipLaneTitle(t.assigneeTitle)}"` : ''}` : ' → unassigned';
      const block = t.status === 'blocked'
        ? ` — blocked${t.blockKind ? ` (${t.blockKind})` : ''}: ${clip(t.blockedReason, BOARD_REASON_CHARS) || '(no reason recorded)'}`
        : '';
      return `- todo ${id8(t.id)} [${t.status}] "${clip(t.title, BOARD_TITLE_CHARS)}"${lane}${block}`;
    });
  const todosHeader = `TODOS: ${open.length} open (${open.filter((t) => t.status === 'in_progress').length} in_progress · ${open.filter((t) => t.status === 'blocked').length} blocked · ${open.filter((t) => t.status === 'pending').length} pending) · ${doneRecent.length} closed in the last 24h${doneRecent.length ? `: ${doneRecent.slice(0, BOARD_MAX_DONE_IDS).map((t) => `${id8(t.id)} [${t.status}]`).join(', ')}${doneRecent.length > BOARD_MAX_DONE_IDS ? ` +${doneRecent.length - BOARD_MAX_DONE_IDS} more` : ''}` : ''}`;

  const oqOpen = facts.ownerQuestions.filter((q) => q.status === 'open');
  const oqRecent = facts.ownerQuestions
    .filter((q) => q.status !== 'open' && Number.isFinite(msOf(q.resolvedAt)) && now - msOf(q.resolvedAt) <= BOARD_RECENT_ANSWER_MS)
    .sort((a, b) => msOf(b.resolvedAt) - msOf(a.resolvedAt));
  const oqLines: string[] = [];
  // Todo 908f48a7 (monitor lesson 5): the needs-you UNION rides the
  // open-questions section — "nothing is waiting on the owner" may be written
  // ONLY from the union (open cards + approved-but-never-landed actions),
  // never from open cards alone (the Tailscale-ACL specimens: nine notes said
  // "nothing" counted from 0 cards while the deploy sat blocked on the owner's
  // approved-but-never-landed save). Absent union = the read failed; the
  // pre-union line stays (fail-open, never a false zero).
  const union = facts.needsYouUnion;
  if (!oqOpen.length) {
    if (union && union.total === 0) {
      oqLines.push('- OPEN owner questions on this project: NONE — and the NEEDS-YOU UNION is 0 (open cards 0, approved-but-never-landed 0): nothing is waiting on the owner. Quote THIS line for any "nothing needs the owner" claim; never count open cards alone.');
    } else {
      oqLines.push('- OPEN owner questions on this project: NONE — nothing is waiting on the owner; never write that something is "owner-gated" or "awaiting the owner\'s decision" unless you file the question this wake (flag_owner_question).');
    }
  }
  if (union && union.total > 0) {
    oqLines.push(`- NEEDS-YOU UNION: ${union.total} item(s) waiting on the owner = ${union.openCards} open card(s) + ${union.answeredUnlanded} approved action(s) NOT yet landed${union.unlandedTitles.length ? ` (${union.unlandedTitles.slice(0, 3).map((t) => `"${clip(t, 50)}"`).join('; ')})` : ''} — these need the owner even though no card is open; "nothing needs the owner" is FALSE while this line is present`);
  }
  for (const q of oqOpen.slice(0, BOARD_MAX_OQ)) oqLines.push(`- ${oqId(q.id)} OPEN since ${hhmmz(q.createdAt)}: "${clip(q.question, 90)}"`);
  if (oqOpen.length > BOARD_MAX_OQ) oqLines.push(`- +${oqOpen.length - BOARD_MAX_OQ} more open`);
  for (const q of oqRecent.slice(0, BOARD_MAX_OQ)) oqLines.push(`- ${oqId(q.id)} ${q.status.toUpperCase()} ${hhmmz(q.resolvedAt)}${q.answeredBy ? ` by ${q.answeredBy}` : ''} — NOT open; cite it as answered`);

  const header = `${BOARD_BLOCK_PREFIX} — the live ledger for "${clip(facts.projectName, 40)}", read from Postgres at compose time (${facts.now.toISOString().slice(0, 16)}Z). This is the ONLY source for goal/todo/owner-question STATUS and COUNT claims in your note: cite these ids and statuses verbatim. A status you remember that differs from this block is WRONG — the block wins. Anything not listed here is not on the board. The verifier strikes status claims that contradict this ledger.]`;
  const shrinkTodos = (lines: string[], keep: number): string[] => (lines.length > keep ? [...lines.slice(0, keep), `- …${lines.length - keep} more open todos (use todo_list)`] : lines);
  // Section order puts OWNER QUESTIONS before TODOS on purpose: the todo list
  // is the only section a hard tail-truncation may ever eat — the
  // owner-question section is the class the watch caught and is never cut.
  // Finding C3: PREMISE REVISIONS are PREPENDED (right under the header) — a
  // moved number is the class of fact a supervisor must read before anything
  // else on the board. Review fix (2026-09-27): every C3 addition sits INSIDE
  // the shrink ladder — prepended above OWNER QUESTIONS, a never-shrunk section
  // plus the longer goal lines pushed the hard tail cut into OWNER QUESTIONS +
  // TODOS on a realistic board (5 goals × 8 manifested premises + 3 revisions
  // each: 4198 chars, both sections gone) while the same facts rendered whole
  // with the policy OFF. Rungs, in order: (1) the like-for-like gap phrases
  // (derivable from the manifests that stay); (2) todos, exactly the pre-C3
  // loop; (3) the revisions section 6 → 3 → 1 line, the "+N more revised (use
  // goal_get)" marker kept; (4) the manifest tags; (5) the revisions section
  // collapses to ONE count line; (6) goals beyond 6, exactly as before; (7) the
  // C2 suspect closes to ONE line + marker, then to the marker alone (the GOALS
  // header count is the floor — finding 2 of the C2 review); (8) the revisions
  // count line goes too. After (8) the ON rendering is byte-identical to OFF,
  // so ON never truncates where OFF does not. A C3 rung frees far more than
  // the todo step that tripped it (12 goals × 4 manifest tags ≈ 900 chars), so
  // once one has fired the todo list is REFILLED four at a time while the
  // block still fits. With PREMISE_REVISION_DISABLED=1 rungs 1/3/4/5/8 are
  // no-ops, no refill runs, and the pre-C3 ladder (todos → goals → suspect
  // closes) runs unchanged.
  let detail: GoalLineDetail = { gaps: true, manifests: true, todoCounts: true, unplannedTag: true };
  let revisionCap: number | null = BOARD_MAX_PREMISE_REVISIONS;
  let keep = BOARD_MAX_TODOS;
  let goalCut = false;
  let suspectKeep = BOARD_MAX_SUSPECT_DONE;
  const render = (): string => {
    const lines = active.slice(0, BOARD_MAX_GOALS).map((g) => goalLine(g, detail));
    const goalRender = goalCut && lines.length > 6 ? lines.slice(0, 6).concat([`- …${lines.length - 6} more (use goal_list)`]) : lines;
    const revisionRender = revisionCap === null ? [] : renderPremiseRevisionLines(goals, facts.now, revisionCap);
    return [header, ...revisionRender, goalsHeaderOf(), ...goalRender, ...shrinkSuspect(suspectKeep), 'OWNER QUESTIONS:', ...oqLines, todosHeader, ...shrinkTodos(todoLines, keep)].join('\n');
  };
  let body = render();
  const over = (): boolean => body.length > BOARD_BLOCK_CAP;
  // GOAL-UNPLANNED (2026-10-20): ALL the new text shrinks FIRST, before any
  // older rung — (0a) the per-goal todo counts, (0b) the per-line UNPLANNED
  // tags fold into one GOALS-header count, (0c) that count goes too. After
  // (0c) the rendering is byte-identical to GOAL_UNPLANNED_SIGNAL_DISABLED=1, so
  // the older ladder below runs exactly as before and ON never cuts a todo /
  // goal / revision line that OFF keeps (the [GOAL UNPLANNED] watchdog wake
  // still carries the signal on a board this full).
  // GOAL-PRIORITY-SPEND (2026-10-20): the ranking text folds before EVERY older rung — (P-a) the per-goal
  // "7d $" clauses, (P-b) the score numbers (the P-level stays), (P-c) the "[P1]" prefix + the header note.
  // After (P-c) the block is byte-identical to the both-switches-off rendering except the goal / todo ORDER
  // (the rank survives every rung), so the older ladder below runs exactly as before.
  if (over() && rank.spend && spendOn && active.some((g) => typeof g.spendUsd === 'number')) { rank = { ...rank, spend: false }; body = render(); } // (P-a)
  if (over() && rankOn && rank.score) { rank = { ...rank, score: false }; body = render(); }                  // (P-b)
  if (over() && rankOn && rank.label) { rank = { ...rank, label: false }; body = render(); }                  // (P-c)
  if (over() && detail.todoCounts && unplannedOn) { detail = { ...detail, todoCounts: false }; body = render(); }           // (0a)
  if (over() && detail.unplannedTag && unplannedIds.size) { detail = { ...detail, unplannedTag: false }; unplannedHeader = true; body = render(); } // (0b)
  if (over() && unplannedHeader) { unplannedHeader = false; body = render(); }                               // (0c)
  if (over() && detail.gaps) { detail = { ...detail, gaps: false }; body = render(); }                       // (1)
  while (over() && keep > 0) { keep = Math.max(0, keep - 4); body = render(); }                              // (2)
  for (const cap of [3, 1]) if (over() && revisionCap !== null && revisionCap > cap) { revisionCap = cap; body = render(); } // (3)
  if (over() && detail.manifests) { detail = { ...detail, manifests: false }; body = render(); }             // (4)
  if (over() && revisionCap !== null && revisionCap > 0) { revisionCap = 0; body = render(); }               // (5)
  if (over() && !goalCut) { goalCut = true; body = render(); }                                               // (6)
  if (over() && suspect.length > 1 && suspectKeep > 1) { suspectKeep = 1; body = render(); }                 // (7a)
  if (over() && suspect.length > 0 && suspectKeep > 0) { suspectKeep = 0; body = render(); }                 // (7b)
  if (over() && revisionCap !== null) { revisionCap = null; body = render(); }                               // (8)
  const c3RungFired = !detail.gaps || !detail.manifests || revisionCap !== BOARD_MAX_PREMISE_REVISIONS;
  while (c3RungFired && !over() && keep < BOARD_MAX_TODOS && todoLines.length > keep) {                       // refill
    const grown = Math.min(BOARD_MAX_TODOS, keep + 4);
    const prev = keep; const prevBody = body;
    keep = grown; body = render();
    if (over()) { keep = prev; body = prevBody; break; }
  }
  return body.length <= BOARD_BLOCK_CAP ? body : `${body.slice(0, BOARD_BLOCK_CAP - 15)}\n…[truncated]`;
}

/** Pure renderer for the FLEET supervisor's roll-up. */
export function renderFleetBoardBlock(
  projects: FleetBoardProject[],
  openOwnerQuestions: BoardOwnerQuestionRow[],
  now: Date,
  capacityLine?: string,
  doneBarLine?: string,
  /** FLEET-PS-FIRST: projectId → its top-goal pace line (loadFleetGoalPaceLines). Absent/empty = the pre-pace block byte-for-byte. */
  paceLines?: Map<string, string>,
  /** SHARED-PROJECT-DISPATCH (2026-10-20): the held-ticket line (feedback/held-ticket-escalation heldTicketsFleetBoardLine). Absent = today's block. */
  heldTicketsLine?: string,
): string {
  const header = `${BOARD_BLOCK_PREFIX} — fleet ledger roll-up, read from Postgres at compose time (${now.toISOString().slice(0, 16)}Z). Goal/todo/owner-question COUNTS and open/answered STATUS come ONLY from here or a this-wake tool pull — never from memory or your last sweep note.]`;
  const sorted = projects.sort((a, b) => a.name.localeCompare(b.name));
  const countLine = (p: FleetBoardProject): string => `- ${clip(p.name, 28)} (${id8(p.projectId)}): ${p.activeGoals} active goal(s)${p.blockedGoals ? ` (${p.blockedGoals} blocked)` : ''} · ${p.openTodos} open todo(s)${p.blockedTodos ? ` (${p.blockedTodos} blocked)` : ''} · ${p.openOwnerQuestions} open owner question(s)${p.suspectDoneGoals ? ` · ${p.suspectDoneGoals} ⚠ suspect done goal(s)` : ''}`;
  const oq = openOwnerQuestions.length
    ? openOwnerQuestions.slice(0, BOARD_MAX_OQ).map((q) => `- ${oqId(q.id)} OPEN since ${hhmmz(q.createdAt)}: "${clip(q.question, 90)}"`).concat(openOwnerQuestions.length > BOARD_MAX_OQ ? [`- +${openOwnerQuestions.length - BOARD_MAX_OQ} more open`] : [])
    : ['- NONE open account-wide — no project is waiting on the owner right now.'];
  // Capacity (todo 0f58ddde) + ticket done-bar (6665fff6): ONE compact line
  // each, directly under the header, so the FLEET_BOARD_BLOCK_CAP truncation
  // can never cut them. Absent when healthy.
  const capacity = capacityLine ? [capacityLine] : [];
  const doneBar = doneBarLine ? [doneBarLine] : [];
  // SHARED-PROJECT-DISPATCH: ONE held-ticket line beside the done-bar (under the header, never truncated away).
  const held = heldTicketsLine ? [heldTicketsLine] : [];
  const render = (withPace: Set<string>): string => {
    const lines: string[] = [];
    for (const p of sorted) {
      lines.push(countLine(p));
      const pace = withPace.has(p.projectId) ? paceLines?.get(p.projectId) : undefined;
      if (pace) lines.push(pace);
    }
    return [header, ...capacity, ...doneBar, ...held, `SUPERVISED PROJECTS: ${projects.length}`, ...lines, 'OPEN OWNER QUESTIONS (account-wide):', ...oq].join('\n');
  };
  const body = render(new Set());
  // SHARED-PROJECT-DISPATCH: the held-ticket line carries its own allowance, so it can never be what
  // truncates the owner questions at the tail.
  const cap = FLEET_BOARD_BLOCK_CAP + (held.length ? held[0].length + 1 : 0);
  // FLEET-PS-FIRST: the pace lines ride ONLY when the block without them fits its cap (so they can never be
  // what truncates the owner questions); they get FLEET_BOARD_PACE_EXTRA_CAP of their own and drop from the
  // end of the list first.
  if (paceLines?.size && body.length <= cap) {
    const ids = sorted.map((p) => p.projectId).filter((id) => paceLines.has(id));
    for (let keep = ids.length; keep > 0; keep -= 1) {
      const withPace = render(new Set(ids.slice(0, keep)));
      if (withPace.length <= cap + FLEET_BOARD_PACE_EXTRA_CAP) return withPace;
    }
    return body;
  }
  return body.length <= cap ? body : `${body.slice(0, cap - 15)}\n…[truncated]`;
}

/** The per-goal pace phrase the fleet line quotes — harness facts only (computeGoalEta via goalEtaPhrase). */
export type FleetGoalPaceFn = (goal: any, todos: any[], now: Date) => string | null;

async function defaultGoalPace(): Promise<FleetGoalPaceFn> {
  // Dynamic import: project-digest pulls the utility LLM + cron modules, which the board must not load statically.
  const m = await import('../fleet/project-digest.service');
  return (goal, todos, now) => {
    const row = m.computeGoalProgress([goal], todos, now)[0];
    return row ? m.goalEtaPhrase(row) : null;
  };
}

const msOfStamp = (v: unknown): number => {
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : NaN;
};

/**
 * FLEET-PS-FIRST (supervisor SOTA round 2, 2026-10-20): the fleet [BOARD] was
 * counts-only, so the Fleet Supervisor could not see WHERE a project stood
 * without waking its lanes. One bounded read set builds, per project, a pace
 * line for its TOP goal (pickTopGoal): the harness pace phrase (computeGoalEta),
 * the KPI register (renderKpiInline) when the goal carries a kpi: premise, and
 * the age of the project's last move (its newest todo close, or the KPI's last
 * value change). projectId → line; any read error ⇒ the lines it could build
 * (an empty map renders the pre-pace block). Kill switch
 * FLEET_BOARD_GOAL_PACE_DISABLED=1.
 */
export async function loadFleetGoalPaceLines(projectIds: string[], now: Date, deps: { goalPace?: FleetGoalPaceFn } = {}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!projectIds.length || fleetBoardGoalPaceDisabled()) return out;
  try {
    // GOAL-PRIORITY-SPEND (2026-10-20): the ranking columns ride the same read (a pre-migration schema falls
    // back to the select without them — every goal then ranks as an unset P2).
    const goalWhere = { projectId: { in: projectIds }, status: { in: ['active', 'blocked'] } };
    const goalSelect = { id: true, projectId: true, title: true, status: true, blockKind: true, progressNote: true, premises: true, blockedAt: true, createdAt: true };
    const goals = ((await (prisma.projectGoal as any).findMany({ where: goalWhere, select: { ...goalSelect, priority: true, prioritySource: true, dueAt: true }, take: 400 })
      .catch(() => (prisma.projectGoal as any).findMany({ where: goalWhere, select: goalSelect, take: 400 }))
      .catch(() => [])) ?? []) as any[];
    if (!goals.length) return out;
    const openGroups = ((await (prisma.projectTodo as any).groupBy({
      by: ['goalId'],
      where: { projectId: { in: projectIds }, status: { in: ['pending', 'in_progress', 'blocked'] } },
      _count: { _all: true },
    }).catch(() => [])) ?? []) as any[];
    const openByGoal = new Map<string, number>(openGroups.map((g) => [String(g.goalId), Number(g._count?._all ?? 0)]));
    // GOAL-PRIORITY-SPEND (2026-10-20): the TOP goal is the highest-SCORED one (P1..P4 + accrual — the same
    // score the project board ranks by); the pre-change pick (KPI / active / open work / oldest) breaks ties.
    // GOAL_PRIORITY_ORDER_DISABLED=1 ⇒ no score ⇒ the pre-change pick.
    const rankOn = !goalPriorityOrderDisabled();
    const ranking = rankOn ? await loadGoalRankingFacts(goals.map((g) => ({ id: String(g.id), status: String(g.status) })), now, { spend: false }).catch(() => null) : null;
    const byProject = new Map<string, any[]>();
    for (const g of goals) {
      const pid = String(g.projectId ?? '');
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid)!.push({
        ...g, hasKpi: !!kpiPremiseOf(g.premises), openTodos: openByGoal.get(String(g.id)) ?? 0,
        ...(rankOn ? { score: scoreGoal(g, { now: now.getTime(), unblockCount: ranking?.unblock.get(String(g.id)) ?? 0 }) } : {}),
      });
    }
    const top = new Map<string, any>();
    for (const [pid, list] of byProject) {
      const g = pickTopGoal(list);
      if (g) top.set(pid, g);
    }
    if (!top.size) return out;
    const topIds = [...top.values()].map((g) => String(g.id));
    const [todos, lastDone] = await Promise.all([
      prisma.projectTodo.findMany({
        where: { goalId: { in: topIds } },
        select: { goalId: true, status: true, updatedAt: true, blockKind: true, progressNote: true, blockedAt: true },
        take: 3000,
      }).catch(() => [] as any[]),
      (prisma.projectTodo as any).groupBy({
        by: ['projectId'],
        where: { projectId: { in: [...top.keys()] }, status: 'done' },
        _max: { updatedAt: true },
      }).catch(() => [] as any[]),
    ]);
    const doneAt = new Map<string, number>(((lastDone ?? []) as any[]).map((r) => [String(r.projectId), msOfStamp(r._max?.updatedAt)]));
    // GOAL-PRIORITY-SPEND: the top goals' attributed 7-day spend (null = switched off / unreadable — no clause).
    // Review fix 2026-10-20: scoped to the top goals' projects (the indexed chat lookup) and KNOWN-only — a top
    // goal with no chartered lane / no attributed row (or past the read cap) renders no clause, never "$0.00".
    const spend = goalSpendAttributionDisabled() ? null : await loadGoalSpend(topIds, new Date(now.getTime() - GOAL_SPEND_WINDOW_DAYS * 24 * 3600_000), { projectIds: [...top.keys()] }).catch(() => null);
    const goalPace = deps.goalPace ?? (await defaultGoalPace());
    for (const [pid, g] of top) {
      try {
        const pace = goalPace(g, ((todos ?? []) as any[]).filter((t) => String(t.goalId) === String(g.id)), now);
        if (!pace) continue;
        const kpi = kpiPremiseOf(g.premises);
        const kpiMoved = kpi && kpi.prev && Number(kpi.prev.value) !== Number(kpi.value) ? msOfStamp(kpi.setAt) : NaN;
        const moves = [doneAt.get(pid) ?? NaN, kpiMoved].filter((n) => Number.isFinite(n));
        out.set(pid, renderFleetPaceLine({
          goalId: String(g.id), goalTitle: String(g.title ?? ''), pace,
          kpi: kpi ? renderKpiInline(kpi, now) : null,
          lastMoveMs: moves.length ? Math.max(...moves) : null,
          now,
          // GOAL-PRIORITY-SPEND: P-level (+ owner), the KPI gap to its bar, the 7-day attributed spend.
          ...(rankOn ? { priority: `${goalPriorityLabel(g.priority)}${g.prioritySource === 'owner' ? ' owner' : ''}`, kpiGap: renderKpiGapText(g.premises) || null } : {}),
          ...(knownGoalSpendUsd(spend, String(g.id)) !== null ? { spend: renderGoalSpendClause(knownGoalSpendUsd(spend, String(g.id)), GOAL_SPEND_WINDOW_DAYS) } : {}),
        }));
      } catch { /* one project's line is never load-bearing */ }
    }
    return out;
  } catch (err: any) {
    logger.warn(`${SOURCE}: fleet pace lines failed (the roll-up renders without them): ${err?.message ?? err}`, { source: SOURCE });
    return out;
  }
}

/**
 * GOAL-PRIORITY-SPEND (2026-10-20): the ranking facts a board read adds — goalId → open goals depending on it
 * (the score's unblock term; any project of the owner) and the tracked (active / blocked) goals' attributed
 * run_spend over GOAL_SPEND_WINDOW_DAYS (goal-spend.ts; `spend` null = switched off / unreadable — no clause).
 * Review fix 2026-10-20: the spend read takes the goals in their provisional RANK order (P-level + due / age /
 * KPI accrual — the order the board renders, minus the ≤ 6-point unblock term) so the ≤ GOAL_SPEND_MAX_GOALS it
 * reads are the ones on screen, it is scoped to `projectIds` (the indexed chat lookup), and only a KNOWN goal
 * gets a figure (knownGoalSpendUsd — an unattributable goal renders no clause, never a false "$0.00").
 * Skipped entirely under GOAL_PRIORITY_ORDER_DISABLED (unblock) / GOAL_SPEND_ATTRIBUTION_DISABLED (spend).
 * Never throws.
 */
export async function loadGoalRankingFacts(
  goals: Array<{ id: string; status: string } & Partial<Omit<BoardGoalRow, 'id' | 'status'>>>,
  now: Date,
  opts: { spend?: boolean; projectIds?: string[] } = {},
): Promise<{ unblock: Map<string, number>; spend: GoalSpendRead | null }> {
  const trackedRows = goals.filter((g) => g.status === 'active' || g.status === 'blocked');
  const tracked = trackedRows.map((g) => g.id);
  const unblockP = (async (): Promise<Map<string, number>> => {
    if (goalPriorityOrderDisabled() || !tracked.length) return new Map();
    try {
      const deps = ((await (prisma as any).goalDependency.findMany({ where: { dependsOnGoalId: { in: tracked } }, select: { goalId: true, dependsOnGoalId: true } })) ?? []) as Array<{ goalId: string; dependsOnGoalId: string }>;
      if (!deps.length) return new Map();
      const dependents = ((await prisma.projectGoal.findMany({ where: { id: { in: [...new Set(deps.map((d) => d.goalId))] } }, select: { id: true, status: true } })) ?? []) as Array<{ id: string; status: string }>;
      return goalUnblockCounts(deps, new Set(dependents.filter((d) => d.status === 'active' || d.status === 'blocked').map((d) => d.id)));
    } catch {
      return new Map();
    }
  })();
  const spendOrder = goalPriorityOrderDisabled() || trackedRows.length <= GOAL_SPEND_MAX_GOALS
    ? tracked
    : rankGoalsByScore(trackedRows, { now: now.getTime() }).map((r) => r.goal.id);
  const spendP = opts.spend === false || goalSpendAttributionDisabled() || !tracked.length
    ? Promise.resolve(null)
    : loadGoalSpend(spendOrder, new Date(now.getTime() - GOAL_SPEND_WINDOW_DAYS * 24 * 3600_000), { projectIds: opts.projectIds ?? [] }).catch(() => null);
  const [unblock, spend] = await Promise.all([unblockP, spendP]);
  return { unblock, spend };
}

/** Ledger reads for one project — exported for the verifier's board lane too. */
export async function loadProjectBoardFacts(projectId: string, now: Date = new Date()): Promise<BoardFacts | null> {
  const project = await prisma.crossModelProject.findUnique({ where: { id: projectId }, select: { id: true, name: true, userId: true } });
  if (!project) return null;
  // Board-time directive read (2026-09-28): the same
  // bounded window the close-time assessment uses; dynamic import (supervisor-state pulls the
  // dormancy gate + schedule helpers) and fail-open — no directives = no directive badge.
  let directives: GoalDoneSuspectDirective[] | undefined;
  if ((project as any).userId) {
    try {
      const { listOpenDirectivesForUser } = await import('./supervisor-state.service');
      directives = await listOpenDirectivesForUser(String((project as any).userId), now.getTime() - GOAL_DONE_SUSPECT_DIRECTIVE_WINDOW_MS);
    } catch { directives = undefined; }
  }
  const [goals, todos, chats] = await Promise.all([
    (prisma.projectGoal as any).findMany({
      where: { projectId },
      // GOAL-PRIORITY-SPEND (2026-10-20): the ranking columns; a pre-migration schema falls through to the
      // select without them (the board then ranks every goal as an unset P2 — creation order within age).
      select: { id: true, title: true, status: true, blockedReason: true, blockKind: true, progressNote: true, updatedAt: true, premises: true, createdAt: true, priority: true, prioritySource: true, dueAt: true },
      orderBy: { createdAt: 'asc' },
    }).catch(() => (prisma.projectGoal as any).findMany({
      where: { projectId },
      select: { id: true, title: true, status: true, blockedReason: true, blockKind: true, progressNote: true, updatedAt: true, premises: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })).catch(() => (prisma.projectGoal as any).findMany({
      // Pre-migration schema (no premises column yet) — same rows without it.
      where: { projectId },
      select: { id: true, title: true, status: true, blockedReason: true, blockKind: true, progressNote: true, updatedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    })),
    prisma.projectTodo.findMany({
      where: { projectId },
      select: { id: true, title: true, status: true, goalId: true, assigneeChatId: true, blockedReason: true, blockKind: true, updatedAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.crossModelChat.findMany({ where: { projectId, ghostMode: false }, select: { id: true, title: true } }),
  ]);
  const titleOf = new Map<string, string>((chats as any[]).map((c) => [c.id, String(c.title ?? '')]));
  const chatIds = (chats as any[]).map((c) => c.id);
  const ownerQuestions = chatIds.length
    ? await prisma.ownerQuestion.findMany({
        where: {
          OR: [
            { chatId: { in: chatIds } },
            { forChatId: { in: chatIds } },
          ],
        },
        select: { id: true, status: true, createdAt: true, resolvedAt: true, answeredBy: true, question: true },
        orderBy: { createdAt: 'desc' },
        take: 60,
      }).catch(() => [] as any[])
    : [];
    // Todo 908f48a7 (monitor lesson 5): the needs-you union, computed from the
    // rows this loader ALREADY reads (zero extra queries when nothing is
    // gated). Only rows that claim an owner gate (gateQuestionId or an inline
    // oq_ id) classify; their cards resolve from the same owner-question read,
    // with ONE bounded fetch for a gate id the windowed read missed.
    const rawOq = ownerQuestions as any[];
    const isGated = (r: { status: string; gateQuestionId?: string | null; blockedReason?: string | null }) =>
      r.status === 'blocked' && (!!r.gateQuestionId || INLINE_OQ_ID_RE_TEST(String(r.blockedReason ?? '')));
    const gatedBoardRows: OwnerGatedRow[] = [
      ...(todos as any[]).filter(isGated).map((t) => ({ id: t.id, title: t.title, gateQuestionId: t.gateQuestionId ?? null, blockedReason: t.blockedReason ?? null, blockKind: t.blockKind ?? null })),
      ...(goals as any[]).filter(isGated).map((g) => ({ id: g.id, title: g.title, gateQuestionId: (g as any).gateQuestionId ?? null, blockedReason: g.blockedReason ?? null, blockKind: g.blockKind ?? null })),
    ];
    let needsYouUnion: BoardFacts['needsYouUnion'];
    if (gatedBoardRows.length) {
      const cardsById = new Map<string, OwnerGateCardView>(rawOq.map((q) => [String(q.id), q]));
      const missing = [...new Set(gatedBoardRows.flatMap((r) => [r.gateQuestionId ? String(r.gateQuestionId) : null, INLINE_OQ_ID_RE_TEST(String(r.blockedReason ?? ''))].filter(Boolean) as string[]))].filter((id) => !cardsById.has(id));
      if (missing.length) {
        const extra = await prisma.ownerQuestion.findMany({ where: { id: { in: missing } }, select: { id: true, status: true, answer: true, chosenOption: true, answeredBy: true } }).catch(() => [] as any[]);
        for (const q of extra as any[]) cardsById.set(String(q.id), q);
      }
      const classified = classifyOwnerGatedRows(gatedBoardRows, cardsById);
      needsYouUnion = {
        ...computeNeedsYouUnion({
          openCards: rawOq.filter((q) => q.status === 'open').length,
          ownerBlocked: classified.ownerBlocked.length,
          answeredUnlanded: classified.answeredUnlanded.length,
        }),
        unlandedTitles: classified.answeredUnlanded.map((r) => String(r.title ?? r.id)).slice(0, 6),
        ownerBlockedTitles: classified.ownerBlocked.map((r) => String(r.title ?? r.id)).slice(0, 6),
      };
    }
  const recentCut = now.getTime() - BOARD_RECENT_ANSWER_MS;
  // Finding 3: the adoption ladder per KPI goal (best-effort; an empty map keeps the plain line).
  const ladders = await loadAdoptionLadders(projectId, now).catch(() => new Map<string, AdoptionLadder>());
  // GOAL-OUTCOME-UNMET part 2 (2026-10-20): a done goal OLDER than the suspect
  // window whose outcome-unmet close is still live (the dormancy gate keeps the
  // project live for it) stays on the board's suspect lines — at most
  // BOARD_MAX_SUSPECT_DONE store reads, newest closes first; fail-open.
  let outcomeLive = new Set<string>();
  try {
    const cutoff = now.getTime() - BOARD_SUSPECT_DONE_WINDOW_MS;
    const older = (goals as BoardGoalRow[])
      .filter((g) => g.status === 'done' && Number.isFinite(msOf(g.updatedAt)) && msOf(g.updatedAt) < cutoff)
      .sort((a, b) => msOf(b.updatedAt) - msOf(a.updatedAt));
    if (older.length) outcomeLive = await liveOutcomeUnmetGoalIds(older, BOARD_MAX_SUSPECT_DONE);
  } catch { outcomeLive = new Set<string>(); }
  // GOAL-PRIORITY-SPEND (2026-10-20): the score's unblock term + the tracked goals' 7-day attributed spend —
  // both best-effort (no counts / no spend clause on a read error).
  const ranking = await loadGoalRankingFacts(goals as BoardGoalRow[], now, { projectIds: [projectId] });
  return {
    projectName: project.name,
    goals: (goals as BoardGoalRow[]).map((g) => {
      const withLadder = ladders.has(g.id) ? { ...g, adoption: ladders.get(g.id) } : g;
      const withOutcome = outcomeLive.has(g.id) ? { ...withLadder, outcomeLive: true } : withLadder;
      const unblock = ranking.unblock.get(g.id);
      const spend = knownGoalSpendUsd(ranking.spend, g.id);
      return { ...withOutcome, ...(unblock ? { unblockCount: unblock } : {}), ...(typeof spend === 'number' ? { spendUsd: spend } : {}) };
    }),
    todos: (todos as any[]).map((t) => ({ ...t, assigneeTitle: t.assigneeChatId ? titleOf.get(t.assigneeChatId) ?? null : null })),
    ownerQuestions: (ownerQuestions as any[]).filter((q) => q.status === 'open' || (q.resolvedAt && new Date(q.resolvedAt).getTime() >= recentCut)),
    now,
    ...(directives?.length ? { directives } : {}),
    ...(needsYouUnion ? { needsYouUnion } : {}),
  };
}

/** Build the block for a wake. scope 'project' needs projectId; 'fleet' needs userId. */
/** Prefix of the switch line the board carries (pinned by supervisor-switch.test.ts). */
export const SUPERVISOR_SWITCH_BOARD_PREFIX = '[SUPERVISOR SWITCH — harness-measured]';

/**
 * The supervisor-switch status line for a board (null when both switches are
 * ON — the common case costs two cached reads and no query). Never throws.
 */
export async function supervisorSwitchBoardLine(): Promise<string | null> {
  try {
    if (!(await anySupervisorSwitchOff())) return null;
    const state = await getSupervisorSwitchState();
    return state.line ? `${SUPERVISOR_SWITCH_BOARD_PREFIX} ${state.line}` : null;
  } catch {
    return null;
  }
}

/**
 * LANE BOARD (ticket 2c203dac) — the "inject the board, don't let the model
 * recall it" doctrine (owner 2026-09-16) extended to NON-SUPERVISOR machine
 * wakes. The supervisor [BOARD] is project/fleet-scoped and rides only
 * supervisor chats; a plain LANE gated on owner questions (forChatId) or
 * assigned todos got NO live ledger in its wake, so its board-status claims
 * came from transcript memory — the mishap: chat 1ea4621f asserted three
 * owner questions "sit open" four days after the owner answered them, and the
 * verifier's board-assertion lane (correctly) struck it. This block gives the
 * lane the same read-don't-recall contract for the rows it is accountable
 * for: every owner question LINKED to this chat (filed by it OR gating it via
 * forChatId) and every todo ASSIGNED to it, with the live status of each.
 *
 * Deliberately narrow (scope discipline — the fleet-wide board stays the
 * supervisor's surface): no goals, no project-wide rows, no counts. The rows
 * here are exactly the ones the verifier will hold this lane's note against.
 *
 * Same failure posture as the supervisor board: any read failure returns ''
 * and the wake proceeds with the plain preamble (never blocks a run start).
 * Kill switch LANE_BOARD_BLOCK_DISABLED=1 restores the pre-fix behavior.
 */
export async function buildLaneBoardBlock(chatId: string, opts: { now?: Date } = {}): Promise<string> {
  if (process.env.LANE_BOARD_BLOCK_DISABLED === '1') return '';
  const now = opts.now ?? new Date();
  try {
    // Every owner question this lane is accountable for: filed by it (chatId)
    // OR gating it (forChatId — flag_owner_question's dual-wake linkage).
    // forChatId is NOT indexed — the lookup scans owner_questions by prefix
    // like the verifier's own ledger lookups; a plain lane links to at most a
    // handful of rows (OPEN_QUESTION_OPEN_CAP bounds per-run filings, the
    // flag API caps open rows), so this stays cheap on every machine wake.
    const oq = (await prisma.ownerQuestion.findMany({
      where: {
        OR: [
          { chatId, status: { in: ['open', 'answered', 'dismissed'] } },
          { forChatId: chatId, status: { in: ['open', 'answered', 'dismissed'] } },
        ],
      },
      select: { id: true, status: true, createdAt: true, resolvedAt: true, answeredBy: true, question: true, chatId: true, forChatId: true },
      orderBy: { createdAt: 'desc' },
      take: LANE_BOARD_MAX_ROWS * 2,
    }).catch(() => [])) as Array<{ id: string; status: string; createdAt: Date; resolvedAt: Date | null; answeredBy: string | null; question: string; chatId: string; forChatId: string | null }>;
    // Todos assigned to this lane, open or recently closed (same 24h window
    // idiom as the supervisor board's doneRecent).
    const todos = (await prisma.projectTodo.findMany({
      where: {
        assigneeChatId: chatId,
        OR: [{ status: { in: ['pending', 'in_progress', 'blocked'] } }, { status: 'done', updatedAt: { gte: new Date(now.getTime() - BOARD_DONE_WINDOW_MS) } }],
      },
      select: { id: true, title: true, status: true, blockedReason: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: LANE_BOARD_MAX_ROWS * 2,
    }).catch(() => [])) as Array<{ id: string; title: string; status: string; blockedReason: string | null; updatedAt: Date }>;
    if (!oq.length && !todos.length) return '';
    const clipQ = (s: string): string => clip(String(s ?? ''), 90);
    const lines: string[] = [];
    if (oq.length) {
      const open = oq.filter((q) => q.status === 'open');
      const closed = oq.filter((q) => q.status !== 'open');
      lines.push(`OWNER QUESTIONS linked to this chat: ${open.length} open · ${closed.length} answered/dismissed (ledger, read ${now.toISOString().slice(0, 16)}Z)`);
      if (!open.length) lines.push('- OPEN owner questions: NONE — nothing is waiting on the owner; never write that something is "owner-gated" or "awaiting the owner\'s decision" unless you file the question this wake (flag_owner_question).');
      for (const q of open.slice(0, LANE_BOARD_MAX_ROWS)) {
        lines.push(`- ${oqId(q.id)} OPEN since ${hhmmz(q.createdAt)}: "${clipQ(q.question)}"${q.forChatId && q.forChatId === chatId ? ' (gates this lane)' : ''}`);
      }
      if (open.length > LANE_BOARD_MAX_ROWS) lines.push(`- …${open.length - LANE_BOARD_MAX_ROWS} more open (use list_owner_questions)`);
      for (const q of closed.slice(0, LANE_BOARD_MAX_ROWS)) {
        lines.push(`- ${oqId(q.id)} ${q.status.toUpperCase()} ${q.resolvedAt ? hhmmz(q.resolvedAt) : ''}${q.answeredBy ? ` by ${q.answeredBy}` : ''} — NOT open; cite it as ${q.status}`);
      }
      if (closed.length > LANE_BOARD_MAX_ROWS) lines.push(`- …${closed.length - LANE_BOARD_MAX_ROWS} more answered/dismissed (use list_owner_questions)`);
    }
    if (todos.length) {
      const open = todos.filter((t) => t.status !== 'done');
      const doneRecent = todos.filter((t) => t.status === 'done');
      lines.push(`TODOS assigned to this chat: ${open.length} open (${open.filter((t) => t.status === 'in_progress').length} in_progress · ${open.filter((t) => t.status === 'blocked').length} blocked · ${open.filter((t) => t.status === 'pending').length} pending) · ${doneRecent.length} closed in the last 24h`);
      for (const t of open.slice(0, LANE_BOARD_MAX_ROWS)) {
        const block = t.status === 'blocked' ? ` — blocked: ${clip(String(t.blockedReason ?? ''), 80) || '(no reason recorded)'}` : '';
        lines.push(`- todo ${id8(t.id)} [${t.status}] "${clip(String(t.title ?? ''), 72)}"${block}`);
      }
      if (open.length > LANE_BOARD_MAX_ROWS) lines.push(`- …${open.length - LANE_BOARD_MAX_ROWS} more open (use todo_list)`);
    }
    if (!lines.length) return '';
    const header = `${BOARD_BLOCK_PREFIX} — this lane's live ledger, read from Postgres at compose time (${now.toISOString().slice(0, 16)}Z). This is the ONLY source for owner-question and todo STATUS claims in your note: cite these ids and statuses verbatim. A status you remember that differs from this block is WRONG — the block wins. If you need a status not listed here, read it with a tool (list_owner_questions / todo_get), never recall it.]`;
    let body = `${header}\n${lines.join('\n')}`;
    if (body.length > LANE_BOARD_BLOCK_CAP) body = `${body.slice(0, LANE_BOARD_BLOCK_CAP - 15)}\n…[truncated]`;
    return body;
  } catch {
    return ''; // never break a run start on a board read
  }
}

export async function buildBoardDigestBlock(opts: { scope: 'project'; projectId: string; now?: Date } | { scope: 'fleet'; userId: string; now?: Date }): Promise<string> {
  const block = await buildBoardDigestBlockCore(opts);
  const switchLine = await supervisorSwitchBoardLine();
  // Refused self-renewals (review-fixer 2026-09-27, finding B2 follow-up): the
  // board names the lanes whose self-armed watch the governor stopped in the
  // window, so the supervisor decides deliberately instead of learning it from
  // a 🛑 note nobody reads. Null when none; never throws.
  const refusalLine = await renewRefusalBoardLine(
    opts.scope === 'project' ? { scope: 'project', projectId: opts.projectId } : { scope: 'user', userId: opts.userId },
  ).catch(() => null);
  const tail = [switchLine, refusalLine].filter((l): l is string => !!l).join('\n');
  if (!tail) return block;
  return block ? `${block}\n${tail}` : tail;
}

async function buildBoardDigestBlockCore(opts: { scope: 'project'; projectId: string; now?: Date } | { scope: 'fleet'; userId: string; now?: Date }): Promise<string> {
  const now = opts.now ?? new Date();
  try {
    if (opts.scope === 'project') {
      const facts = await loadProjectBoardFacts(opts.projectId, now);
      if (!facts) return '';
      const block = renderProjectBoardBlock(facts);
      // Owner 2026-09-17 ("what is going on / how much longer"): the same
      // harness-measured timing the status card shows rides into the
      // supervisor's context, so an answer quotes measured numbers instead of
      // a lookup or a guess. Best-effort: null keeps the plain board.
      const timing = await computeProjectTiming(opts.projectId, now);
      return timing ? `${block}\n${renderTimingBlock(timing, now)}` : block;
    }
    // TICKET dca83b85: the fleet roll-up is SUPERVISION-SCOPED. A project the
    // owner has taken out of fleet supervision (supervised:false) is excluded
    // here — before composition — even when it still runs its own project
    // supervisor (projectSupervisorEnabled is an INDEPENDENT setting: that lane
    // stays in its own project's flow and is never re-listed by the Fleet).
    const projects = (await prisma.crossModelProject.findMany({
      where: { userId: opts.userId, archivedAt: null, projectSupervisorEnabled: true, supervised: { not: false } },
      select: { id: true, name: true },
      take: 40,
    })) as Array<{ id: string; name: string }>;
    if (!projects.length) return '';
    const pids = projects.map((p) => p.id);
    // Same scope for the account-wide owner-question section (requirement 4):
    // a card raised inside an OPTED-OUT project belongs to that project's own
    // flow, never to the Fleet's board. OwnerQuestion keys on chatId (the
    // flagging run's session), so the subtraction is chat-id based; the
    // project's own supervisor still sees and works its cards.
    const optedOut = await prisma.crossModelProject.findMany({
      where: { userId: opts.userId, supervised: false },
      // `supervised` MUST ride the select: unsupervisedProjectIds() keys on the
      // flag, so a bare {id} projection makes this set silently empty and the
      // question filter below a no-op (adversarial review B1).
      select: { id: true, supervised: true },
    }).catch(() => [] as Array<{ id: string; supervised?: boolean | null }>);
    const optedOutIds = unsupervisedProjectIds(optedOut as Array<{ id: string; supervised?: boolean | null }>);
    const optedOutChatIds = optedOutIds.size
      ? new Set(((await prisma.crossModelChat.findMany({
          where: { projectId: { in: [...optedOutIds] } },
          select: { id: true },
        }).catch(() => [])) as Array<{ id: string }>).map((c) => c.id))
      : new Set<string>();
    const [goalGroups, todoGroups, chats] = await Promise.all([
      (prisma.projectGoal as any).groupBy({ by: ['projectId', 'status'], where: { projectId: { in: pids } }, _count: { _all: true } }).catch(() => []),
      (prisma.projectTodo as any).groupBy({ by: ['projectId', 'status'], where: { projectId: { in: pids } }, _count: { _all: true } }).catch(() => []),
      prisma.crossModelChat.findMany({ where: { projectId: { in: pids }, ghostMode: false }, select: { id: true, projectId: true } }),
    ]);
    const openOq = (await prisma.ownerQuestion.findMany({
      where: { userId: opts.userId, status: 'open' },
      select: { id: true, status: true, createdAt: true, resolvedAt: true, answeredBy: true, question: true, chatId: true, forChatId: true },
      orderBy: { createdAt: 'desc' },
      take: 40,
    }).catch(() => []) as any[]).filter((q: any) => !optedOutChatIds.has(String(q.chatId ?? '')) && !(q.forChatId && optedOutChatIds.has(String(q.forChatId))));
    const projectOfChat = new Map<string, string>((chats as any[]).map((c) => [c.id, String(c.projectId)]));
    // C2: recent done goals (one bounded read) — assessed per row, counted per project.
    const recentDone = (await (prisma.projectGoal as any).findMany({
      where: { projectId: { in: pids }, status: 'done', updatedAt: { gte: new Date(now.getTime() - BOARD_SUSPECT_DONE_WINDOW_MS) } },
      select: { id: true, projectId: true, title: true, status: true, progressNote: true, updatedAt: true, premises: true },
      take: 200,
    }).catch(() => [])) as any[];
    const suspectByProject = new Map<string, number>();
    for (const { goal } of suspectDoneGoals(recentDone as BoardGoalRow[], now.getTime())) {
      const pid = String((goal as any).projectId ?? '');
      suspectByProject.set(pid, (suspectByProject.get(pid) ?? 0) + 1);
    }
    const rows: FleetBoardProject[] = projects.map((p) => {
      const g = (goalGroups as any[]).filter((x) => x.projectId === p.id);
      const t = (todoGroups as any[]).filter((x) => x.projectId === p.id);
      const cnt = (arr: any[], statuses: string[]) => arr.filter((x) => statuses.includes(x.status)).reduce((n, x) => n + Number(x._count?._all ?? 0), 0);
      const oqN = openOq.filter((q) => projectOfChat.get(q.chatId) === p.id || (q.forChatId && projectOfChat.get(q.forChatId) === p.id)).length;
      return {
        name: p.name, projectId: p.id,
        activeGoals: cnt(g, ['active', 'blocked']), blockedGoals: cnt(g, ['blocked']),
        openTodos: cnt(t, ['pending', 'in_progress', 'blocked']), blockedTodos: cnt(t, ['blocked']),
        openOwnerQuestions: oqN,
        ...(suspectByProject.get(p.id) ? { suspectDoneGoals: suspectByProject.get(p.id) } : {}),
      };
    });
    // Capacity watch (todo 0f58ddde): the fleet board carries ONE compact
    // capacity line whenever a saturation signal is sustained (the same
    // 2-consecutive-check evidence the [INFRA ALERT — capacity] wake uses, so
    // the board and the alert can never disagree). Dynamic import + fail-open
    // null: a board line is never load-bearing for the wake.
    let capacityLine: string | null = null;
    try {
      const { fleetCapacityBoardLine } = await import('../fleet/capacity-watch.service');
      capacityLine = await fleetCapacityBoardLine(now);
    } catch { capacityLine = null; }
    // Ticket done-bar (6665fff6): one compact line naming merged-not-deployed,
    // in-window, verifier-reopened and missing-metric counts, plus the
    // deployed-verified tally — the drift the supervisor should see every
    // wake. Same pattern: dynamic import + fail-open null.
    let doneBarLine: string | null = null;
    try {
      const { ticketDoneBarBoardLine } = await import('../feedback/ticket-postdeploy-verifier.service');
      doneBarLine = await ticketDoneBarBoardLine(now);
    } catch { doneBarLine = null; }
    // FLEET-PS-FIRST (2026-10-20): one top-goal pace line per project. Read AFTER the counts / suspect reads
    // (one more bounded read set); an empty map renders the pre-pace block.
    const paceLines = fleetBoardGoalPaceDisabled() ? undefined : await loadFleetGoalPaceLines(pids, now).catch(() => undefined);
    // SHARED-PROJECT-DISPATCH (2026-10-20): held tickets on other accounts waiting on an admin (owner / admin
    // viewers only). Same pattern: dynamic import + fail-open null. Kill switch HELD_TICKET_ESCALATION_DISABLED=1.
    let heldTicketsLine: string | null = null;
    try {
      const { heldTicketsFleetBoardLine } = await import('../feedback/held-ticket-escalation');
      heldTicketsLine = await heldTicketsFleetBoardLine(opts.userId, now);
    } catch { heldTicketsLine = null; }
    return renderFleetBoardBlock(rows, openOq, now, capacityLine ?? undefined, doneBarLine ?? undefined, paceLines, heldTicketsLine ?? undefined);
  } catch (err: any) {
    logger.warn(`${SOURCE}: block failed: ${err?.message ?? err}`, { source: SOURCE });
    return '';
  }
}
