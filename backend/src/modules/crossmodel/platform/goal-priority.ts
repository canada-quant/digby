/**
 * GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20; owner decision
 * Paul 2026-10-20 "ship it") — goal priority + per-goal spend attribution.
 *
 * WHY (architecture review of production): lane effort followed FIFO, not
 * owner value — lane-todos maybeStartNextLaneTodo started the OLDEST pending
 * todo (createdAt asc, `todos[0]`) and the project [BOARD] listed goals in
 * creation order — and $4.1k/week of run_spend could not be tied to any goal
 * (the run_spend meta carried no goalId). Supervisors could neither rebalance
 * lanes toward the goals the owner values nor see a goal burning money without
 * moving. This is VISIBILITY + ORDERING only: no caps, no refusal of work.
 *
 * PURE LEAF (imports only the import-free kpi-of-record leaf): the ranking
 * rules every seam shares — goals.service (writes), board-digest.service (the
 * project [BOARD] order + the fleet top-goal line), coding/lane-todos (the
 * continuation pick), platform/goal-spend (attribution switch).
 *
 * Owner rules (binding, 2026-10-20):
 *   - priority P1 (highest) .. P4 (lowest); unset reads as P2;
 *   - an OWNER-set ranking always wins and is never overwritten by a machine;
 *   - a SUPERVISOR may set priority only on a goal whose prioritySource is not
 *     'owner', stamped 'machine' (a lane's own ranking write is refused — the
 *     rest of its write still applies; apply-or-explain, never silent);
 *   - dueAt optional.
 *
 * Who is the OWNER (review fix 2026-10-20): the PROJECT owner's own write — a
 * JWT REST call, or a human turn whose OWN text backs THIS write
 * (ownerTextBacksRanking: names the level / due date it sets, or points at
 * this goal by id / title). Another human with write access (a shared
 * project's editor) writes as 'member' — allowed and audited, never an owner
 * lock, never over an owner-set ranking. A model's guess on a human turn that
 * did not ask for that ranking is a 'machine' write.
 *
 * Scoring model (modelled on feedback/ticket-priority.ts scoreTicketRow —
 * linear, cheap, one integer per goal):
 *
 *   score = 20 × (5 − P)            P1 = 80 · P2 = 60 · P3 = 40 · P4 = 20 — the
 *                                    owner's (or a supervisor's) explicit intent
 *        + duePoints               a due date: passed 6 · ≤24 h 5 · ≤72 h 4 · ≤7 d 2
 *        + agePoints               starvation relief: 1 per 7 days old, cap 3
 *        + kpiGapPoints            2 when the goal's kpi: premise has a bar it has
 *                                    not met yet (owed work toward its own bar)
 *        + 2 × min(unblockCount, 3)  open goals that depend on this one
 *
 * Max accrual (6 + 3 + 2 + 6) = 17 < 20: no stack of accrual outranks one
 * priority level — owner intent is sacred. Ties: owner-set first, then the
 * input order (callers pass rows createdAt asc, so FIFO survives within a score).
 *
 * Kill switches (read per call):
 *   GOAL_PRIORITY_ORDER_DISABLED=1     the board renders goals / todos in the
 *                                      pre-change order with no score prefix, the
 *                                      fleet top goal is picked the pre-change way,
 *                                      and lane continuation starts the oldest todo
 *   GOAL_SPEND_ATTRIBUTION_DISABLED=1  no goalId on run metric stamps, no per-goal
 *                                      $ on the boards, get_spend scope 'goal' off
 */

import { kpiPremiseOf, kpiBarDirection, kpiBarMet, kpiBareKey, effectiveKpiBar, type KpiPremiseLike } from './kpi-of-record';

const envOn = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** GOAL_PRIORITY_ORDER_DISABLED=1 — the pre-2026-10-20 FIFO / createdAt order everywhere. */
export function goalPriorityOrderDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envOn(env.GOAL_PRIORITY_ORDER_DISABLED);
}
/** GOAL_SPEND_ATTRIBUTION_DISABLED=1 — no goalId stamp, no per-goal $, no get_spend 'goal' scope. */
export function goalSpendAttributionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return envOn(env.GOAL_SPEND_ATTRIBUTION_DISABLED);
}

export const GOAL_PRIORITY_MIN = 1;
export const GOAL_PRIORITY_MAX = 4;
/** Unset reads as P2 (owner decision 2026-10-20). */
export const GOAL_PRIORITY_DEFAULT = 2;
/** One priority level (20) outweighs all accrual a goal can pick up (max 17). */
export const GOAL_PRIORITY_WEIGHT = 20;
export const GOAL_AGE_POINT_DAYS = 7;
export const GOAL_AGE_POINTS_CAP = 3;
export const GOAL_UNBLOCK_POINTS_EACH = 2;
export const GOAL_UNBLOCK_COUNT_CAP = 3;
export const GOAL_KPI_GAP_POINTS = 2;
/** Due-date accrual: passed / ≤24 h / ≤72 h / ≤7 d. */
export const GOAL_DUE_POINTS = { overdue: 6, day: 5, threeDays: 4, week: 2 } as const;
/** A due date outside this window is a typo, never a ranking input. */
const DUE_MIN_MS = Date.UTC(2001, 0, 1);
const DUE_MAX_MS = Date.UTC(2100, 0, 1);

/** 'owner' = the project owner (an unoverwritable lock); 'member' = another human with write access (not a lock);
 *  'machine' = a supervisor's ranking. */
export const GOAL_PRIORITY_SOURCES = ['owner', 'member', 'machine'] as const;
export type GoalPrioritySource = (typeof GOAL_PRIORITY_SOURCES)[number];

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const msOf = (v: unknown): number => {
  const t = v instanceof Date ? v.getTime() : typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/** A stored / supplied priority as an int 1..4, or null when it is not one. Pure. */
export function validGoalPriority(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= GOAL_PRIORITY_MIN && v <= GOAL_PRIORITY_MAX) return v;
  return null;
}

/** The priority a goal RANKS at: its stored 1..4, else the P2 default. Pure. */
export function effectiveGoalPriority(v: unknown): number {
  return validGoalPriority(v) ?? GOAL_PRIORITY_DEFAULT;
}

/** "P1".."P4" (an unset priority reads "P2"). Pure. */
export function goalPriorityLabel(v: unknown): string {
  return `P${effectiveGoalPriority(v)}`;
}

export type RankingFieldInput<T> = { kind: 'absent' } | { kind: 'clear' } | { kind: 'set'; value: T } | { kind: 'invalid'; error: string };

/**
 * A priority as supplied by a tool / REST caller: undefined = absent; null or
 * '' = clear (back to the P2 default); 1..4, '1'..'4' or 'P1'..'P4' = set;
 * anything else is invalid (the caller 400s — never a silent drop). Pure.
 */
export function parseGoalPriorityInput(v: unknown): RankingFieldInput<number> {
  if (v === undefined) return { kind: 'absent' };
  if (v === null || (typeof v === 'string' && !v.trim())) return { kind: 'clear' };
  const raw = typeof v === 'string' ? v.trim().replace(/^p/i, '') : v;
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
  const ok = validGoalPriority(n);
  return ok !== null ? { kind: 'set', value: ok } : { kind: 'invalid', error: `priority must be 1..4 (P1 highest … P4 lowest) or null to clear; got ${JSON.stringify(v)}` };
}

/** A due date as supplied: undefined = absent; null / '' = clear; an ISO date (2001..2099) = set. Pure. */
export function parseGoalDueAtInput(v: unknown): RankingFieldInput<Date> {
  if (v === undefined) return { kind: 'absent' };
  if (v === null || (typeof v === 'string' && !v.trim())) return { kind: 'clear' };
  const ms = msOf(v);
  if (!Number.isFinite(ms) || ms < DUE_MIN_MS || ms >= DUE_MAX_MS) {
    return { kind: 'invalid', error: `dueAt must be an ISO date between 2001 and 2099 (e.g. 2026-11-01 or 2026-11-01T17:00:00Z) or null to clear; got ${JSON.stringify(v)}` };
  }
  return { kind: 'set', value: new Date(ms) };
}

export type PriorityWriteVerdict =
  | { allowed: true; source: GoalPrioritySource }
  | { allowed: false; reason: 'refused_owner_set' | 'refused_not_supervisor' };

/**
 * May this writer change a goal's ranking fields (priority / dueAt)? The OWNER
 * always may (stamped 'owner'). Nobody else changes an owner-set ranking. A
 * MEMBER (another human with write access) may otherwise (stamped 'member' —
 * not a lock). A MACHINE may only from a supervisor-class chat (stamped
 * 'machine'). Pure.
 */
export function decidePriorityWrite(o: { currentSource?: string | null; writer: GoalPrioritySource; actingIsSupervisor?: boolean }): PriorityWriteVerdict {
  if (o.writer === 'owner') return { allowed: true, source: 'owner' };
  if (o.currentSource === 'owner') return { allowed: false, reason: 'refused_owner_set' };
  if (o.writer === 'member') return { allowed: true, source: 'member' };
  if (o.actingIsSupervisor !== true) return { allowed: false, reason: 'refused_not_supervisor' };
  return { allowed: true, source: 'machine' };
}

/**
 * The tool-result note for a refused ranking write (the rest of the write still applied). `nothingElse`
 * (interaction fix 2026-10-20): the call carried nothing else, so it changed nothing — the note says the
 * current ranking stands and the call was not executed, never "everything else applied". Pure.
 */
export function priorityRefusalNote(reason: 'refused_owner_set' | 'refused_not_supervisor', current: { priority?: unknown; prioritySource?: string | null }, writer: GoalPrioritySource = 'machine', opts: { nothingElse?: boolean } = {}): string {
  const label = goalPriorityLabel(current.priority);
  const rest = opts.nothingElse ? 'This call changed nothing else, so nothing was written (not executed).' : 'Everything else in this call applied.';
  if (reason === 'refused_owner_set') {
    const stands = opts.nothingElse ? ` The owner's ${label} stands.` : '';
    return writer === 'member'
      ? `priority/dueAt NOT changed: the project owner set this goal's ranking (${label}, owner-set) and only the owner changes an owner-set ranking.${stands} ${rest} Ask the owner to change it.`
      : `priority/dueAt NOT changed: the owner set this goal's ranking (${label}, owner-set) and an owner-set ranking is never overwritten by a machine write.${stands} ${rest} If the ranking looks wrong, ask the owner.`;
  }
  return `priority/dueAt NOT changed: only the owner or a supervisor ranks goals (P1..P4).${opts.nothingElse ? ` The goal's ${label} stands.` : ''} ${rest} Report the ranking you think is right to your supervisor.`;
}

// ── Owner text (review fix 2026-10-20) ───────────────────────────────────────
// The owner types in lowercase and in plain words ("make the deploy goal p1", "this is due friday",
// "do this first"); the first cut matched only "P1" / a fixed "due <word>" list, so ordinary owner orders
// were machine writes (refused on a lane, stamped 'machine' on a supervisor). And ANY ranking word anywhere
// in the turn ("urgent: …, what are our priorities?") made every ranking the model wrote that turn an owner
// lock. Now the text must BACK the write: name the level / due date it sets, or point at this goal.

const WEEKDAY_RE = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|weds?|thu(?:rs?)?|fri|sat|sun)';
/** Months; the bare word "may" (a modal verb) counts only with a day number ("may 3"). */
const MONTH_RE = '(?:(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b(?:\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)?|may\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)';
/** Word-shaped date tokens: ISO date, weekdays, months, today / tomorrow / eod, next / this <period>, end of <period>, in N days. */
const DATE_WORD_RE = `(?:\\d{4}-\\d{2}-\\d{2}\\b|${WEEKDAY_RE}\\b|${MONTH_RE}|today\\b|tonight\\b|tomorrow\\b|eod\\b|eow\\b|eom\\b|end\\s+of\\s+(?:the\\s+)?(?:day|week|month|quarter|year)\\b|(?:next|this)\\s+(?:week|month|quarter|year|${WEEKDAY_RE})\\b|(?:in|within)\\s+(?:\\d+|a|an|one|two|three|four|five|six|seven)\\s+(?:hours?|days?|weeks?|months?)\\b)`;
/** Plus numeric dates ("11/01", "1.11.2026") and ordinals ("the 3rd") — only after "due" / "deadline" (never "by 2.5x" / "by 3/4"). */
const DATE_TOKEN_RE = `(?:${DATE_WORD_RE}|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b|\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}\\b|\\d{1,2}(?:st|nd|rd|th)\\b)`;
/**
 * A due DATE stated: "due friday" / "due by the 3rd" / "due 2026-11-01" / "due in 3 days" / "deadline is
 * tomorrow" / "due date to next week" / "by end of week" / "before friday". Never "due to" (a cause).
 */
const DUE_DATE_RE = new RegExp(
  `(?:\\bdue(?:\\s*(?:by|on|before|at|for|:))*\\s*(?:the\\s+)?${DATE_TOKEN_RE}`
  + `|\\b(?:due\\s+date|deadline)(?:\\s*(?:is|to|by|on|before|at|for|of|:|=))*\\s*(?:the\\s+)?${DATE_TOKEN_RE}`
  + `|\\b(?:by|before)\\s+(?:the\\s+)?${DATE_WORD_RE})`,
  'i',
);
/** Clearing a due date in words. */
const DUE_CLEAR_RE = /\b(?:no|remove|drop|clear|delete|without)\s+(?:the\s+|a\s+|its\s+)?(?:deadline|due\s+date)\b/i;
/** Explicit P-levels: "P1".."P4" in any case (never "P10", never an instance type like "p3.2xlarge"), "priority 1" / "priority one". */
const P_LEVEL_RE = /\bp([1-4])\b(?!\.\w)/gi;
const PRIORITY_NUM_RE = /\bpriority[\s-]*(?:level\s*)?(?:#\s*)?([1-4]|one|two|three|four)\b/gi;
const WORD_LEVEL: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
/** Plain idioms that state a level unambiguously: top → P1, bottom → P4. */
const IMPLIED_P1_RE = /(?:\b(?:top|highest|first|number[\s-]*one|critical)|#\s*1)\s+priority\b|\bmost\s+important\b|\b(?:do|work\s+on|start\s+with|focus\s+on|tackle|handle)\s+(?:this|that|it|these|those)\s+first\b/i;
const IMPLIED_P4_RE = /\b(?:lowest|bottom|last)\s+priority\b|\bleast\s+important\b|\bback[\s-]?burner\b/i;
/** Clearing a priority in words ("remove the priority", "back to the default priority"). */
const PRIORITY_CLEAR_RE = /\b(?:no|remove|drop|clear|reset|unset)\s+(?:the\s+|its\s+|a\s+)?priority\b|\bdefault\s+priority\b/i;
/** Ranking language that needs a goal pointer to back a write on its own. */
const RANKING_WORD_RE = /\b(?:de)?priorit(?:y|ies|i[sz]e[ds]?|i[sz]ing|i[sz]ation)\b|\burgent(?:ly)?\b|\bdeadline\b|\b(?:more|less|most|least)\s+important\b|\bback[\s-]?burner\b|\b(?:rank|bump|raise|lower|demote|promote)(?:s|d|ed|ing)?\s+(?:it|this|that|the\s+goal|goal)\b|\bbump(?:ed|ing)?\s+(?:up|down)\b/i;
/** A polite request phrased as a question still orders ("can you make it p1?"); a real question does not. */
const REQUEST_QUESTION_RE = /^(?:(?:can|could|would|will)\s+(?:you|we)\b|please\b)|\bplease\b/i;

/** The sentences of `text` that ORDER something (a plain question — "what are our priorities?" — does not). */
function orderingSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s && (!/\?\s*$/.test(s) || REQUEST_QUESTION_RE.test(s)));
}

/** The P-levels a text names: explicit "p1" / "priority 2" plus the unambiguous idioms (top → 1, bottom → 4). Pure. */
export function rankingLevelsNamed(text: string | null | undefined): Set<number> {
  const out = new Set<number>();
  for (const s of orderingSentences(String(text ?? '').slice(0, 20_000))) {
    for (const m of s.matchAll(P_LEVEL_RE)) out.add(Number(m[1]));
    for (const m of s.matchAll(PRIORITY_NUM_RE)) out.add(WORD_LEVEL[m[1].toLowerCase()] ?? Number(m[1]));
    if (IMPLIED_P1_RE.test(s)) out.add(1);
    if (IMPLIED_P4_RE.test(s)) out.add(4);
  }
  return out;
}

/** Does the text state a due date ("due friday", "due 2026-11-01", "deadline is tomorrow", "by end of week")? Never "due to". Pure. */
export function ownerTextNamesDueDate(text: string | null | undefined): boolean {
  return orderingSentences(String(text ?? '').slice(0, 20_000)).some((s) => DUE_DATE_RE.test(s));
}

/**
 * Does the owner's OWN message (a genuine human turn) speak about ranking at
 * all — a P-level ("p1", any case), "priority 2", priority words, urgent,
 * deadline, a due DATE, "most important", "do this first", "bump it"? Only
 * in a sentence that orders (a plain question does not). Pure.
 */
export function ownerTextNamesRanking(text: string | null | undefined): boolean {
  const t = String(text ?? '');
  if (!t.trim()) return false;
  if (rankingLevelsNamed(t).size || ownerTextNamesDueDate(t)) return true;
  return orderingSentences(t.slice(0, 20_000)).some((s) => RANKING_WORD_RE.test(s) || DUE_CLEAR_RE.test(s) || PRIORITY_CLEAR_RE.test(s));
}

/** Does the text point at THIS goal — its id prefix (8 hex) or its full title (≥ 4 chars)? Pure. */
export function ownerTextPointsAtGoal(text: string | null | undefined, goal: { id?: string | null; title?: string | null } | null | undefined): boolean {
  const lower = String(text ?? '').slice(0, 20_000).toLowerCase().replace(/\s+/g, ' ');
  if (!lower.trim() || !goal) return false;
  const prefix = String(goal.id ?? '').toLowerCase().slice(0, 8);
  if (/^[0-9a-f]{8}$/.test(prefix) && lower.includes(prefix)) return true;
  const title = String(goal.title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return title.length >= 4 && lower.includes(title);
}

/**
 * Does the owner's OWN text BACK this ranking write — so the write ranks as
 * the OWNER's (an unoverwritable lock)? Every field the write supplies must
 * be backed:
 *   - priority set to N: the text names level N ("p1", "priority 1", "top
 *     priority" → 1, "back burner" → 4), or points at this goal;
 *   - priority cleared: "remove the priority" / "default priority", or points at this goal;
 *   - dueAt set: the text states a due date, or points at this goal;
 *   - dueAt cleared: "no deadline" / "remove the due date", or points at this goal.
 * Pointing at the goal only counts beside ranking language. A model's own
 * guesses on such a turn stay machine writes. Pure, never throws.
 */
export function ownerTextBacksRanking(text: string | null | undefined, write: { priority?: unknown; dueAt?: unknown }, goal?: { id?: string | null; title?: string | null } | null): boolean {
  try {
    const t = String(text ?? '');
    if (!t.trim() || !ownerTextNamesRanking(t)) return false;
    if (ownerTextPointsAtGoal(t, goal)) return true;
    const p = parseGoalPriorityInput(write?.priority);
    const d = parseGoalDueAtInput(write?.dueAt);
    if (p.kind === 'absent' && d.kind === 'absent') return false;
    const sentences = orderingSentences(t.slice(0, 20_000));
    const priorityBacked = p.kind === 'absent' ? true
      : p.kind === 'set' ? rankingLevelsNamed(t).has(p.value)
        : p.kind === 'clear' ? sentences.some((s) => PRIORITY_CLEAR_RE.test(s)) : false;
    const dueBacked = d.kind === 'absent' ? true
      : d.kind === 'set' ? ownerTextNamesDueDate(t)
        : d.kind === 'clear' ? sentences.some((s) => DUE_CLEAR_RE.test(s)) : false;
    return priorityBacked && dueBacked;
  } catch {
    return false;
  }
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export interface ScorableGoal {
  id: string;
  priority?: number | null;
  prioritySource?: string | null;
  dueAt?: Date | string | null;
  createdAt?: Date | string | null;
  status?: string | null;
  premises?: unknown;
}

/** Due-date points: passed 6 · ≤24 h 5 · ≤72 h 4 · ≤7 d 2 · else / none 0. Pure. */
export function goalDuePoints(dueAt: unknown, now: number = Date.now()): number {
  const t = msOf(dueAt);
  if (!Number.isFinite(t) || t < DUE_MIN_MS || t >= DUE_MAX_MS) return 0;
  const left = t - now;
  if (left <= 0) return GOAL_DUE_POINTS.overdue;
  if (left <= DAY) return GOAL_DUE_POINTS.day;
  if (left <= 3 * DAY) return GOAL_DUE_POINTS.threeDays;
  if (left <= 7 * DAY) return GOAL_DUE_POINTS.week;
  return 0;
}

/** Age points: one per GOAL_AGE_POINT_DAYS days old, capped (a bad createdAt earns 0). Pure. */
export function goalAgePoints(createdAt: unknown, now: number = Date.now()): number {
  const t = msOf(createdAt);
  if (!Number.isFinite(t)) return 0;
  return Math.min(GOAL_AGE_POINTS_CAP, Math.floor(Math.max(0, now - t) / (GOAL_AGE_POINT_DAYS * DAY)));
}

export interface GoalKpiGap {
  key: string;
  value: number;
  bar: number;
  unit?: string;
  /** |bar − value| (0 when met). */
  gap: number;
  met: boolean;
  direction: 'up' | 'down';
}

/** The goal's KPI of record against its own bar (null without a kpi: premise carrying a bar). Pure. */
export function goalKpiGap(premises: unknown): GoalKpiGap | null {
  const kpi: KpiPremiseLike | null = kpiPremiseOf(premises);
  if (!kpi || !Number.isFinite(Number(kpi.value))) return null;
  // Ticket d1a7bec2 (CASE 2): use the bar the KPI is actually measured on. A
  // boolean unit is compared against 1, so reading the raw `kpi.bar` here made
  // the board print two contradictory clauses for ONE row — "bar ≥1" on the KPI
  // line (kpiBarText) beside "KPI bar ≥90 met" in the gap column — and computed
  // a nonzero gap (|90 − 1|) on a MET row. effectiveKpiBar also keeps a bar-less
  // premise bar-less, so nothing fabricates a bar the register never held.
  const bar = effectiveKpiBar(kpi);
  if (bar === undefined) return null;
  const met = kpiBarMet(kpi);
  const gap = met ? 0 : Math.abs(bar - Number(kpi.value));
  return { key: kpiBareKey(kpi.key), value: Number(kpi.value), bar, ...(kpi.unit ? { unit: String(kpi.unit) } : {}), gap: Math.round(gap * 1000) / 1000, met, direction: kpiBarDirection(kpi) };
}

/** "KPI gap 4.92 tok/s to bar ≥10" / "KPI bar ≥10 met" / '' without a bar. Pure. */
export function renderKpiGapText(premises: unknown): string {
  const g = goalKpiGap(premises);
  if (!g) return '';
  const bar = `bar ${g.direction === 'up' ? '≥' : '≤'}${g.bar}`;
  if (g.met) return `KPI ${bar} met`;
  const unit = g.unit ? (/^[\s%]/.test(g.unit) ? g.unit : ` ${g.unit}`) : '';
  return `KPI gap ${g.gap}${unit} to ${bar}`;
}

/** The goal's score (see the model above). `unblockCount` = open goals depending on it. Pure, never throws. */
export function scoreGoal(g: ScorableGoal, opts: { unblockCount?: number; now?: number } = {}): number {
  const now = opts.now ?? Date.now();
  const p = effectiveGoalPriority(g?.priority);
  const unblock = Math.min(GOAL_UNBLOCK_COUNT_CAP, Math.max(0, Math.floor(Number(opts.unblockCount) || 0)));
  const kpi = goalKpiGap(g?.premises);
  return (GOAL_PRIORITY_MAX + 1 - p) * GOAL_PRIORITY_WEIGHT
    + goalDuePoints(g?.dueAt, now)
    + goalAgePoints(g?.createdAt, now)
    + (kpi && !kpi.met ? GOAL_KPI_GAP_POINTS : 0)
    + unblock * GOAL_UNBLOCK_POINTS_EACH;
}

/**
 * goalId → how many OPEN (active / blocked) goals depend on it. `deps` are
 * GoalDependency rows {goalId (the dependent), dependsOnGoalId}; `openGoalIds`
 * the dependents that still count (unknown dependents are not counted). Pure.
 */
export function goalUnblockCounts(deps: ReadonlyArray<{ goalId: string; dependsOnGoalId: string }>, openGoalIds: ReadonlySet<string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of deps ?? []) {
    if (!d || !openGoalIds.has(String(d.goalId))) continue;
    const k = String(d.dependsOnGoalId);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/**
 * Goals ranked by score desc; ties keep owner-set first, then the INPUT order
 * (callers pass rows createdAt asc — FIFO survives within a score). Returns a
 * NEW array of {goal, score}; never mutates the input. Pure.
 */
export function rankGoalsByScore<T extends ScorableGoal>(goals: ReadonlyArray<T>, opts: { now?: number; unblockCounts?: ReadonlyMap<string, number> } = {}): Array<{ goal: T; score: number }> {
  const now = opts.now ?? Date.now();
  return goals
    .map((goal, i) => ({ goal, i, score: scoreGoal(goal, { now, unblockCount: opts.unblockCounts?.get(String(goal?.id)) ?? 0 }), owner: goal?.prioritySource === 'owner' ? 1 : 0 }))
    .sort((a, b) => b.score - a.score || b.owner - a.owner || a.i - b.i)
    .map(({ goal, score }) => ({ goal, score }));
}

/**
 * The lane-continuation pick: among `todos` (already filtered to actionable —
 * pending, no open dependency — and passed createdAt asc), the one whose GOAL
 * scores highest; ties keep the input (FIFO) order. A todo whose goal row is
 * missing scores as an unset P2 goal. Null on an empty list. Pure.
 */
export function pickHighestScoredTodo<T extends { id: string; goalId: string }>(
  todos: ReadonlyArray<T>,
  goalsById: ReadonlyMap<string, ScorableGoal>,
  opts: { now?: number; unblockCounts?: ReadonlyMap<string, number> } = {},
): { todo: T; score: number } | null {
  if (!todos.length) return null;
  const now = opts.now ?? Date.now();
  let best: { todo: T; score: number } | null = null;
  for (const todo of todos) {
    const goal = goalsById.get(String(todo.goalId)) ?? { id: String(todo.goalId) };
    const score = scoreGoal(goal, { now, unblockCount: opts.unblockCounts?.get(String(todo.goalId)) ?? 0 });
    if (!best || score > best.score) best = { todo, score };
  }
  return best;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** "[P1 · 82]" — the [BOARD] goal-line prefix; "[P1]" when the score is folded. Pure. */
export function renderGoalScorePrefix(g: { priority?: unknown; prioritySource?: string | null }, score: number | null): string {
  const owner = g?.prioritySource === 'owner' ? ' owner' : '';
  return score === null ? `[${goalPriorityLabel(g?.priority)}${owner}]` : `[${goalPriorityLabel(g?.priority)}${owner} · ${Math.round(score)}]`;
}

/** "$12.40" (two decimals under $1k, whole dollars above). Pure. */
export function formatGoalUsd(usd: number): string {
  const n = Number.isFinite(usd) && usd > 0 ? usd : 0;
  return n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
}

/** "7d $12.40" — the per-goal spend clause (harness-read run_spend; '' when unknown). Pure. */
export function renderGoalSpendClause(usd: number | null | undefined, days = 7): string {
  return typeof usd === 'number' && Number.isFinite(usd) ? `${days}d ${formatGoalUsd(usd)}` : '';
}
