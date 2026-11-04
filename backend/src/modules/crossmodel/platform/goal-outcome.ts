/**
 * GOAL OUTCOME UNMET (architecture review #3, 2026-10-20).
 *
 * Why: the todo-driven auto-complete cascade (goals.service
 * maybeAutoCompleteGoal) closed a goal 'done' the moment its last todo landed
 * and never read the goal's premises; goal-done-suspect knew only `target*`
 * keys and never asked kpi-of-record's kpiBarMet; the dormancy gate used the
 * suspect assessment only inside a 7-day window. So a goal whose KPI of record
 * sat below its bar ("all N todos done", mission number unmoved) closed
 * silently, the project went dormant a week later, and nobody re-planned the
 * next lever.
 *
 * Four parts (the kill switch GOAL_OUTCOME_CHECK_DISABLED=1 turns all of them
 * off; read per call):
 *  1. goal-done-suspect.ts: reason `kpi_bar_unmet` (a board reason).
 *  2. dormancy-gate.service: a done goal whose `kpi_bar_unmet` /
 *     `premise_target_unmet` close is still LIVE (this module's close record:
 *     same KPI / target value + bar as at close, not owner-accepted) is live
 *     work with no 7-day limit.
 *  3. goals.service, both close seams: ONE `[GOAL OUTCOME UNMET — RE-PLAN]`
 *     direct wake to the project supervisor (Redis NX 24 h, keyed by goal +
 *     KPI value + receipt) and a `goal_outcome_unmet` loop_metrics row.
 *  4. OPT-IN GOAL_OUTCOME_GATE_ENFORCE=1: the auto-complete cascade leaves the
 *     goal open with an '[outcome unmet] …' progress note; an explicit
 *     goal_update status:'done' still closes (audited).
 *
 * Review fix (same day): WHO accepts an unmet outcome. The first cut read any
 * user-anchored goal_update as the owner closing explicitly, so a lane run that
 * inherited the owner turn's userTurnAt (an agent-origin send, an owner-
 * dispatch run) silenced the re-plan wake and the dormancy hold for good. Tool
 * writes now classify with ledgerToolMachineTriggered, and only an OWNER close
 * accepts: a JWT REST write (a status-only one on an already-done goal), or a
 * human turn whose own message names the close (ownerTextNamesGoalClose).
 *
 * The pure helpers (outcome, fingerprint, dedupe key, wake text, note) are
 * exported for tests; the close record lives in the context store
 * (`[<goalId>, 'goal-outcome'] / 'close'`, no migration) behind a DYNAMIC
 * import so this module stays a leaf for its static importers. Every async
 * helper is best-effort and never throws.
 */

import { createHash } from 'crypto';
import {
  GOAL_OUTCOME_UNMET_REASONS, goalOutcomeCheckDisabled, kpiBarUnmetOf, unmetTargetPremises, formatKpiBarUnmet, formatUnmetPremise,
  type GoalDoneSuspectReason, type KpiBarUnmet, type UnmetTargetPremise,
} from './goal-done-suspect';
import { formatAge, kpiPremiseOf, normalizeKpiBarDirection } from './kpi-of-record';

export { goalOutcomeCheckDisabled };

/** Part 4 opt-in (default OFF): the auto-complete cascade holds a goal whose outcome bar is unmet. Never armed while the check itself is disabled. */
export const goalOutcomeGateEnforce = (): boolean => !goalOutcomeCheckDisabled() && process.env.GOAL_OUTCOME_GATE_ENFORCE === '1';

/** Who closed / moved a goal — the transition metric's actorKind vocabulary. */
export type GoalActorKind = 'user' | 'machine' | 'harness';

/**
 * The ORIGIN-aware machine predicate for a goal / todo ledger write made by a
 * TOOL call (review fix 2026-10-20). `!ctx.userTurnAt` alone under-counts
 * machine runs: an agent-origin send from a user-anchored run threads a
 * userTurnAt onto the target run (the executor classifies it machine —
 * ctx.machineTriggered), and an owner-DISPATCH run (a supervisor relayed the
 * owner's ask) carries the owner turn's userTurnAt although nobody typed THIS
 * run's words (ctx.ownerDispatch). Same rule as the read-side redaction, the
 * work-tools human-turn test and schedule provenance. Pure.
 */
export function ledgerToolMachineTriggered(ctx: { userTurnAt?: Date | null; machineTriggered?: boolean; ownerDispatch?: boolean } | null | undefined): boolean {
  if (!ctx || !ctx.userTurnAt) return true;
  return ctx.machineTriggered === true || ctx.ownerDispatch === true;
}

// ── Does the owner's OWN message name this goal's close? (review fix 2026-10-20) ──
//
// A model's goal_update on a genuine human turn is not the owner accepting an
// unmet outcome: a model that closes the goal while answering "how is it
// going?" must not silence the re-plan wake (and the dormancy hold) forever.
// The outcome is accepted only when the owner's own text
// (ToolContext.userTurnText, threaded on human turns only) carries an
// imperative, un-negated, non-question close of a goal it names.

/** Close / accept phrasing ("close it", "mark the goal done", "set it to done", "call it done", "accept the shortfall", "wrap it up"); "close to / closer / closing in" are not closes. */
const OWNER_CLOSE_VERB_RE = new RegExp([
  '\\bclos(?:e|ing)\\b(?!\\s+(?:to|by|in|enough|on)\\b)',
  '\\bmark(?:\\s+\\S+){0,5}?\\s+(?:as\\s+)?(?:done|complete|completed|finished|closed)\\b',
  '\\bset(?:\\s+\\S+){0,5}?\\s+to\\s+(?:done|complete|completed|closed)\\b',
  '\\bcall\\s+it\\s+(?:done|complete)\\b',
  '\\bwrap\\s+(?:it\\s+|this\\s+|that\\s+)?up\\b',
  '\\baccept(?:ing)?\\s+(?:the\\s+|this\\s+|that\\s+)?(?:it\\b|as[\\s-]is\\b|(?:shortfall|outcome|result|close|closure|miss|number|gap|reading)\\b)',
].join('|'), 'i');
/** A negation BEFORE the close verb in the same sentence ("don't close it", "do not mark it done", "never accept"). */
const OWNER_CLOSE_NEGATION_RE = /\b(?:don'?t|do\s+not|never|not|no|stop|can'?t|cannot|shouldn'?t|won'?t|wouldn'?t)\b/i;
/** An 8-hex id-shaped token (a goal / chat / receipt id prefix). */
const ID_TOKEN_RE = /\b[0-9a-f]{8}\b/gi;

/**
 * TRUE when the owner's own message names the close of THIS goal: some
 * sentence closes (OWNER_CLOSE_VERB_RE), is not a question and has no
 * negation before its verb, and the message names the goal — its 8-char id
 * prefix, its full title, or the word "goal" while no OTHER id-shaped token
 * is present (a message naming a different id never accepts this one).
 * Pure; never throws.
 */
export function ownerTextNamesGoalClose(text: unknown, goal: { id?: string | null; title?: string | null } | null | undefined): boolean {
  try {
    const t = typeof text === 'string' ? text.slice(0, 20_000) : '';
    if (!t.trim() || !goal?.id) return false;
    const sentences = t.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
    const closes = sentences.some((sent) => {
      const m = OWNER_CLOSE_VERB_RE.exec(sent);
      if (!m || /\?\s*$/.test(sent)) return false;
      return !OWNER_CLOSE_NEGATION_RE.test(sent.slice(0, m.index));
    });
    if (!closes) return false;
    const lower = t.toLowerCase();
    const prefix = String(goal.id).toLowerCase().slice(0, 8);
    if (prefix.length === 8 && lower.includes(prefix)) return true;
    const title = String(goal.title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (title.length >= 4 && lower.replace(/\s+/g, ' ').includes(title)) return true;
    const ids = (t.match(ID_TOKEN_RE) ?? []).map((x) => x.toLowerCase());
    return /\bgoals?\b/i.test(t) && ids.every((x) => x === prefix);
  } catch {
    return false;
  }
}

export interface GoalOutcome {
  /** The outcome-unmet reasons that apply (subset of GOAL_OUTCOME_UNMET_REASONS, in verdict order). */
  reasons: GoalDoneSuspectReason[];
  kpi: KpiBarUnmet | null;
  targets: UnmetTargetPremise[];
}

const EMPTY_OUTCOME: GoalOutcome = { reasons: [], kpi: null, targets: [] };

/** Where the goal's OWN outcome bar stands on its premises. Empty under the kill switch. Pure; never throws. */
export function goalOutcomeOf(premises: unknown): GoalOutcome {
  try {
    if (goalOutcomeCheckDisabled()) return { ...EMPTY_OUTCOME };
    const targets = unmetTargetPremises(premises);
    const kpi = kpiBarUnmetOf(premises);
    const reasons: GoalDoneSuspectReason[] = [];
    if (targets.length) reasons.push('premise_target_unmet');
    if (kpi) reasons.push('kpi_bar_unmet');
    return { reasons, kpi, targets };
  } catch {
    return { ...EMPTY_OUTCOME };
  }
}

/** The outcome-unmet subset of a verdict's reasons. Pure. */
export function outcomeReasonsOf(reasons: readonly string[] | null | undefined): GoalDoneSuspectReason[] {
  return (Array.isArray(reasons) ? reasons : []).filter((r): r is GoalDoneSuspectReason => GOAL_OUTCOME_UNMET_REASONS.has(r as GoalDoneSuspectReason));
}

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The outcome FINGERPRINT — the KPI of record's key / value / bar and every
 * target premise's key / value / observed. A close stays live work only while
 * the fingerprint equals the one recorded at close ("until the bar/value
 * changes"). The receipt id is deliberately NOT part of it: a re-measurement
 * that reads the same number changes nothing. Ticket 9fcd69ca (2026-10-27):
 * a DECLARED barDirection now changes the fingerprint too — declaring the
 * direction on a false-flagged ceiling KPI ("this bar is a ≤500ms ceiling, not
 * a floor") is exactly the "the bar changed" that ends a live outcome-unmet
 * hold — while a direction-less row stays byte-identical to its pre-fix
 * fingerprint (existing holds neither release nor re-arm on deploy). Pure;
 * stable across key order.
 */
export function goalOutcomeFingerprint(premises: unknown): string {
  try {
    const kpi = kpiPremiseOf(premises);
    const targets = (Array.isArray(premises) ? premises : [])
      .filter((p: any) => p && typeof p === 'object' && /^target(?:[_.:-]|$)/i.test(String(p.key ?? '')))
      .map((p: any) => [String(p.key).toLowerCase(), num(p.value), num(p.observed)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    // B1 (review 4112375b): a direction-less row must fingerprint BYTE-IDENTICALLY
    // to the pre-9fcd69ca 3-tuple — a literal null/undefined 4th element changes
    // the JSON string and silently perturbs EVERY pre-existing live hold. Only
    // a DECLARED direction appends the 4th element.
    const dir = kpi ? normalizeKpiBarDirection((kpi as { barDirection?: unknown }).barDirection) : null;
    const kpiTuple = kpi ? [String(kpi.key).toLowerCase(), num(kpi.value), num(kpi.bar), ...(dir ? [dir] : [])] : null;
    return sha1(JSON.stringify({ kpi: kpiTuple, targets }));
  } catch {
    return sha1('unreadable');
  }
}

/** Part 3 dedupe window: one outcome wake per goal + KPI value + receipt per 24 h. */
export const GOAL_OUTCOME_WAKE_DEDUPE_SEC = 24 * 60 * 60;

/**
 * Redis NX key for the part-3 wake: goal + KPI value + receipt id (design);
 * a target-only outcome keys on the unmet targets' observed values instead.
 * Pure.
 */
export function goalOutcomeWakeDedupeKey(goalId: string, outcome: GoalOutcome): string {
  const kpiPart = outcome.kpi ? `${outcome.kpi.value}:${String(outcome.kpi.receiptId ?? '-').slice(0, 8)}` : '-:-';
  const targetPart = outcome.targets.length
    ? sha1(JSON.stringify(outcome.targets.map((t) => [t.key, t.value, t.observed]))).slice(0, 12)
    : '-';
  return `goal-outcome:wake:${goalId}:${kpiPart}:${targetPart}`;
}

export const GOAL_OUTCOME_UNMET_WAKE_PREFIX = '[GOAL OUTCOME UNMET — RE-PLAN]';

const clipTitle = (s: unknown, n = 90): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** "kpi tok_s=5.08 tok/s < bar 10 (receipt f5b42fe6, age 2h)" — the KPI clause with its receipt + age when the register has them. Pure. */
export function formatOutcomeKpiClause(k: KpiBarUnmet, now: Date = new Date()): string {
  const meta: string[] = [];
  if (k.receiptId) meta.push(`receipt ${String(k.receiptId).slice(0, 8)}`);
  const setMs = Date.parse(String(k.setAt ?? ''));
  if (Number.isFinite(setMs)) meta.push(`age ${formatAge(now.getTime() - setMs)}`);
  return `${formatKpiBarUnmet(k)}${meta.length ? ` (${meta.join(', ')})` : ''}`;
}

/** The outcome facts as one clause list ("kpi … < bar …; target_x ≥20, observed 5.33"). Pure. */
export function formatOutcomeFacts(outcome: GoalOutcome, now: Date = new Date()): string {
  const parts: string[] = [];
  if (outcome.kpi) parts.push(formatOutcomeKpiClause(outcome.kpi, now));
  for (const t of outcome.targets.slice(0, 3)) parts.push(formatUnmetPremise(t));
  return parts.join('; ');
}

/** "all 3 todos done" / "all 3 todos done (1 dropped)". Pure. */
export function formatTodosDone(todos: Array<{ status?: string | null }> | null | undefined): string {
  const rows = Array.isArray(todos) ? todos : [];
  const done = rows.filter((t) => t?.status === 'done').length;
  const dropped = rows.filter((t) => t?.status === 'dropped').length;
  return `all ${done} todo${done === 1 ? '' : 's'} done${dropped ? ` (${dropped} dropped)` : ''}`;
}

/**
 * The part-3 wake text (design: '[GOAL OUTCOME UNMET — RE-PLAN] goal <title>:
 * all N todos done; kpi K=v < bar b (receipt r, age a). Create the next-lever
 * todo with a budget and adoption criterion, or record why the bar changed
 * (goal_premise_set), or close explicitly with evidence.') plus ONE line on
 * where the goal stands now. Review fix (2026-10-20): the third remedy is
 * MODE-aware. Only a HELD goal (enforce) is still open, so only there does
 * "close explicitly" do anything; in the default observe-only mode the goal is
 * already 'done', a supervisor's goal_update status:'done' on it changes
 * nothing (only the owner's own close accepts the outcome), so the wake says
 * "ask the owner to accept the close" instead. Pure.
 */
export function renderGoalOutcomeUnmetWake(input: {
  goalId: string;
  title: string | null | undefined;
  todos: Array<{ status?: string | null }> | null | undefined;
  outcome: GoalOutcome;
  /** Part 4: the cascade HELD the close (the goal is still open). */
  enforced?: boolean;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const head = `${GOAL_OUTCOME_UNMET_WAKE_PREFIX} goal "${clipTitle(input.title)}" (${String(input.goalId).slice(0, 8)}): ${formatTodosDone(input.todos)}; ${formatOutcomeFacts(input.outcome, now)}. ` +
    'Create the next-lever todo with a budget and adoption criterion, or record why the bar changed (goal_premise_set), ' +
    (input.enforced ? 'or close explicitly with evidence.' : 'or ask the owner to accept the close.');
  const state = input.enforced
    ? "(The outcome gate kept the goal OPEN — GOAL_OUTCOME_GATE_ENFORCE: the auto-close did not run and an '[outcome unmet]' progress note leads; an explicit goal_update status:'done' still closes it, audited, and the project stays live until the KPI / target value or its bar changes or the owner accepts the close.)"
    : "(The goal was auto-closed 'done' — observe-only: it is badged ⚠ suspect and keeps this project live until the KPI / target value or its bar changes (goal_premise_set), or the owner accepts the close; a goal_update status:'done' from a supervisor or lane changes nothing. A todo_create under it reopens it.)";
  return `${head}\n${state}\nRe-read it with goal_get first and act on its CURRENT state. (wake sent ${now.toISOString()})`;
}

/** Part 4: the progress-note marker the held cascade writes. */
export const OUTCOME_UNMET_NOTE_PREFIX = '[outcome unmet]';
const OUTCOME_UNMET_LEAD_RE = /^\[outcome unmet\][^\n]*(?:\n|$)/i;

/**
 * Part 4: the held goal's progress note — the '[outcome unmet] …' line LEADS,
 * the previous note (minus an earlier '[outcome unmet]' lead line, so a second
 * cascade never stacks them) follows, capped at `max`. Review fix
 * (2026-10-20): the wording carries NO hold idiom (goal-done-suspect
 * holdTokenIn — "held;" matched) — a harness note must never read as a
 * deliberate owner / lane HOLD to the Pulse ('held per note'), the unplanned
 * signal (isUnplannedGoal) or a later close's done-suspect verdict. Pure.
 */
export function outcomeUnmetProgressNote(existing: string | null | undefined, outcome: GoalOutcome, todos: Array<{ status?: string | null }> | null | undefined, max: number, now: Date = new Date()): string {
  const lead = `${OUTCOME_UNMET_NOTE_PREFIX} ${formatTodosDone(todos)} but ${formatOutcomeFacts(outcome, now)} — the auto-close did not run; plan the next lever (budget + adoption criterion), record why the bar changed, or close explicitly with evidence.`;
  const rest = String(existing ?? '').replace(OUTCOME_UNMET_LEAD_RE, '').trim();
  return (rest ? `${lead}\n${rest}` : lead).slice(0, Math.max(1, max));
}

// ── The close record (part 2's "until the bar/value changes or the owner closes explicitly") ──

export const GOAL_OUTCOME_STORE_KEY = 'close';
export const goalOutcomeStoreNs = (goalId: string): string[] => [goalId, 'goal-outcome'];

export interface GoalOutcomeCloseRecord {
  /** goalOutcomeFingerprint at close time. */
  fingerprint: string;
  reasons: string[];
  seam: 'update' | 'auto';
  actorKind: GoalActorKind;
  /** ISO time of the close. */
  at: string;
  /** The OWNER closed — or re-confirmed — the goal explicitly (a JWT REST write, or a human turn whose own message names the close — never a model's own call on a user-anchored run): the outcome is accepted. */
  ownerAccepted: boolean;
  enforced?: boolean;
}

/**
 * The goal_update tool-result note for a close that left an unmet outcome
 * LIVE (review fix 2026-10-20): the closer — a supervisor's own close in
 * particular, which wakes nobody — learns the project now stays live and what
 * ends it. Null when the owner's close accepted the outcome or none applies.
 * Pure.
 */
export function goalOutcomeCloseNote(handled: string | null | undefined, outcome: GoalOutcome, now: Date = new Date()): string | null {
  if (!handled || handled === 'owner_close' || !outcome?.reasons?.length) return null;
  const woke = handled === 'woken' ? ' The project supervisor was woken to re-plan.' : '';
  return `Outcome bar unmet (${formatOutcomeFacts(outcome, now)}): this close is recorded as LIVE work — the project stays active (no dormancy) until the KPI / target value or its bar changes (goal_premise_set: a new receipted reading, or why the bar changed) or the owner accepts the close in their own message.${woke}`;
}

/** Is a recorded close still LIVE work? Not owner-accepted, and the KPI / target value + bar are what they were at close. Pure. */
export function outcomeCloseStillLive(record: GoalOutcomeCloseRecord | null | undefined, currentFingerprint: string): boolean {
  if (!record || typeof record !== 'object') return false;
  if (record.ownerAccepted === true) return false;
  return typeof record.fingerprint === 'string' && record.fingerprint === currentFingerprint;
}

/** Write the close record (upsert). Never throws. */
export async function recordGoalOutcomeClose(goalId: string, record: GoalOutcomeCloseRecord): Promise<boolean> {
  try {
    const { storePut } = await import('../memory/context-store');
    await storePut(goalOutcomeStoreNs(goalId), GOAL_OUTCOME_STORE_KEY, record as unknown as Record<string, unknown>);
    return true;
  } catch {
    return false;
  }
}

/** Read the close record (null when absent / unreadable). Never throws. */
export async function readGoalOutcomeClose(goalId: string): Promise<GoalOutcomeCloseRecord | null> {
  try {
    const { storeGet } = await import('../memory/context-store');
    const v = await storeGet<GoalOutcomeCloseRecord>(goalOutcomeStoreNs(goalId), GOAL_OUTCOME_STORE_KEY);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The owner re-confirmed an already-done goal (goals.service updateGoal: a
 * status-only JWT REST write, or a human turn whose own message names the
 * close — never a model's own call): the unmet outcome is ACCEPTED — the close
 * record flips ownerAccepted (created when absent) so the dormancy gate stops
 * counting it. No-op when the outcome is met. Never throws.
 */
export async function acceptGoalOutcomeClose(goalId: string, premises: unknown, now: Date = new Date()): Promise<boolean> {
  try {
    const outcome = goalOutcomeOf(premises);
    if (!outcome.reasons.length) return false;
    const prev = await readGoalOutcomeClose(goalId);
    return await recordGoalOutcomeClose(goalId, {
      fingerprint: goalOutcomeFingerprint(premises), reasons: outcome.reasons, seam: prev?.seam ?? 'update', actorKind: 'user',
      at: prev?.at ?? now.toISOString(), ownerAccepted: true, ...(prev?.enforced ? { enforced: true } : {}),
    });
  } catch {
    return false;
  }
}

/** Bound on store reads per call (a pathological project never turns a dormancy check into N reads). */
export const GOAL_OUTCOME_LIVE_MAX_READS = 20;

/**
 * Part 2: of these DONE goals, which carry an outcome-unmet close that is
 * still live (record present, fingerprint unchanged, not owner-accepted)? A
 * close with NO record predates 2026-10-20 and is not live here (the 7-day
 * suspect window still covers it). Empty under the kill switch. Never throws.
 */
export async function liveOutcomeUnmetGoalIds(goals: Array<{ id: string; premises?: unknown }>, max: number = GOAL_OUTCOME_LIVE_MAX_READS): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    if (goalOutcomeCheckDisabled()) return out;
    let reads = 0;
    for (const g of Array.isArray(goals) ? goals : []) {
      if (!g?.id || !goalOutcomeOf(g.premises).reasons.length) continue;
      if (reads >= max) break;
      reads += 1;
      const rec = await readGoalOutcomeClose(String(g.id));
      if (outcomeCloseStillLive(rec, goalOutcomeFingerprint(g.premises))) out.add(String(g.id));
    }
  } catch { /* best-effort: what was found so far */ }
  return out;
}
