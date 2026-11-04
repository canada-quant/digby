/**
 * GOAL DONE-SUSPECT detector (sup3 audit C2, 2026-09-27 — CanLaw /
 * canlegal-bench / spark-cluster pass).
 *
 * Why: the goal done gate (goals.service updateGoal) checks DEPENDENCY goals
 * only. A goal could be closed 'done' with its own target premise unmet
 * (spark a57fb2e2 "≥20 tok/s" closed at an observed 5.33), with a HOLD
 * progress note ("redeploy of :3001 held" — 34 HOLD reports followed the
 * close on bench f6b31f1b), or with an open owner directive still naming it.
 * Nothing contradicted those closes: the board showed one more "done", the
 * digest counted it, and the supervisors moved on.
 *
 * What this is: a PURE, deterministic assessment of a close — no model, no
 * DB. goals.service calls it at both close seams (goal_update status:'done'
 * and the todo-driven auto-done cascade) and records ONE observe-only
 * `goal_done_suspect` loop_metrics row + an Activity audit row; the board
 * digest badges the goal line '⚠ suspect' for a week. The close itself is
 * NEVER refused (gate flip 2026-09-11: observe-only on lanes' own work).
 *
 * Reasons (review fixes 2026-09-27 — findings 1, 3, 4 of the sup3 fixer pass):
 *  - premise_target_unmet — a registered premise whose key starts with
 *    `target` (target_tok_per_s, target.suite_mean, target-p95-ms) has an
 *    OBSERVED value that misses the target. Direction: "at least" by default;
 *    a key carrying max / ceiling / upper / at_most / under / below / le is
 *    "at most". `tolerance` widens the bar either way. BADGES the board.
 *  - premise_target_unobserved — a target premise with NO observed value on
 *    record (no https source, or a source never read). TELEMETRY ONLY: it
 *    rides the metric row and the tool-result note ("record the measured
 *    value with goal_premise_set observed + observedNote") but never badges
 *    the board and never instructs a reopen — before this split a source-less
 *    target premise was unsatisfiable, so every such close was suspect
 *    forever and the prescribed remedy did not exist (finding 1).
 *  - hold_token — the progress note (or blockedReason) carries a HOLD idiom:
 *    "on hold", an uppercase HOLD label or a note starting with "hold",
 *    "held" at a clause end (the bench f6b31f1b replay) or with a cue,
 *    "holding|halted|paused|standing by … until|pending|for|on|by",
 *    awaiting/waiting-on the owner. Bare "holds" / "holding steady" /
 *    "halted the container" / "pauses for 2s" are ordinary progress verbs
 *    and are NOT holds (finding 4).
 *  - kpi_bar_unmet — GOAL-OUTCOME-UNMET (architecture review #3, 2026-10-20):
 *    the goal's `kpi:` premise of record carries a finite `bar` the register
 *    value does not meet (kpi-of-record.ts kpiBarMet — a DECLARED
 *    `barDirection` wins (ticket 9fcd69ca: a latency/ceiling KPI whose first
 *    reading already sits under its bar inferred 'up' and false-flagged every
 *    healthy reading); absent one, direction is inferred from the first
 *    registered value). Before this the close seams never read the KPI:
 *    a goal whose every todo landed auto-closed 'done' while its mission
 *    number sat below the bar. BADGES the board. Kill switch
 *    GOAL_OUTCOME_CHECK_DISABLED=1 (read per call).
 *  - open_directive — an open supervisor directive (last 72h, same owner)
 *    whose key terms cover the goal title (≥ the directive-conflict guard's
 *    MATCHING_COVERAGE 0.3, and at least two shared terms), EXCLUDING a
 *    directive recorded inside the grace window (this wake's own order), one
 *    whose text itself orders the close ("mark X done", "the bar is met") and
 *    one scoped to ANOTHER project (finding 3). Metric-only: the board never
 *    re-derives it.
 *
 * Fail-open everywhere: a malformed premise or note simply yields no reason.
 */

import { progressNoteLead } from './progress-note';
import { kpiPremiseOf, kpiBarMet, kpiBarDirection, normalizeKpiBarDirection, kpiBareKey, kpiValueText, effectiveKpiBar } from './kpi-of-record';

export type GoalDoneSuspectReason = 'premise_target_unmet' | 'premise_target_unobserved' | 'kpi_bar_unmet' | 'hold_token' | 'open_directive';

/** The reasons that BADGE the board ('⚠ suspect'). `premise_target_unobserved` is telemetry-only; `open_directive` badges only when the caller supplied a directive read (the board re-derives it since 2026-09-28 — `renderGoalDoneSuspectBadge(v, { withDirectives: true })`). */
export const GOAL_DONE_SUSPECT_BOARD_REASONS: ReadonlySet<GoalDoneSuspectReason> = new Set<GoalDoneSuspectReason>(['premise_target_unmet', 'kpi_bar_unmet', 'hold_token']);
/** GOAL-OUTCOME-UNMET (2026-10-20): the reasons that say the goal's OWN outcome bar is not met — the close seams wake the project supervisor on them and the dormancy gate keeps the project live while they stand. */
export const GOAL_OUTCOME_UNMET_REASONS: ReadonlySet<GoalDoneSuspectReason> = new Set<GoalDoneSuspectReason>(['premise_target_unmet', 'kpi_bar_unmet']);
/** GOAL_OUTCOME_CHECK_DISABLED=1 — no `kpi_bar_unmet` reason, no outcome wake / dormancy liveness / enforce hold (the pre-2026-10-20 close). Read per call. */
export const goalOutcomeCheckDisabled = (): boolean => process.env.GOAL_OUTCOME_CHECK_DISABLED === '1';
export const isBoardSuspectReason = (r: GoalDoneSuspectReason): boolean => GOAL_DONE_SUSPECT_BOARD_REASONS.has(r);

/** How far back an open directive counts against a close (mirrors DIRECTIVE_CONFLICT_WINDOW_MS). */
export const GOAL_DONE_SUSPECT_DIRECTIVE_WINDOW_MS = 72 * 60 * 60 * 1000;
/** A directive YOUNGER than this at close time is this wake's own order (the owner just said it) and never counts against the close. */
export const GOAL_DONE_SUSPECT_DIRECTIVE_GRACE_MS = 60 * 60 * 1000;
/** Share of the goal title's key terms an open directive must carry (mirrors directive-conflict MATCHING_COVERAGE). */
export const GOAL_DONE_SUSPECT_DIRECTIVE_COVERAGE = 0.3;
/** …and never fewer shared terms than this (a one-word title cannot match by accident). */
export const GOAL_DONE_SUSPECT_DIRECTIVE_MIN_SHARED = 2;

/** The badge text the board / digest / tool result carry. */
export const GOAL_DONE_SUSPECT_BADGE = '⚠ suspect';
/** The remedy the tool-result note names — the REAL tool path (finding 1). */
export const GOAL_DONE_SUSPECT_REMEDY_UNMET = "reopen the goal (goal_update status:'active') or record the measured value (goal_premise_set observed + observedNote)";
export const GOAL_DONE_SUSPECT_REMEDY_UNOBSERVED = 'record the measured value with goal_premise_set observed + observedNote (telemetry only — not badged)';
/** GOAL-OUTCOME-UNMET: the remedy when the KPI of record misses its bar — re-plan, never re-narrate. */
export const GOAL_DONE_SUSPECT_REMEDY_KPI = "plan the next lever (todo_create under the goal — it reopens it — with a budget and an adoption criterion) or record why the bar changed (goal_premise_set)";

/** A premise whose key names a TARGET the goal must reach. */
export const TARGET_PREMISE_KEY_RE = /^target(?:[_.:-]|$)/i;
/** Key fragments that flip the target to an UPPER bound ("at most"). */
export const TARGET_UPPER_BOUND_RE = /(?:^|[_.:-])(?:max|maximum|ceiling|upper|at_most|atmost|under|below|le|lte)(?:[_.:-]|$)/i;

/** Cue words that turn a hold VERB into a hold STATE ("holding for the owner", "paused until the rerun"). */
const HOLD_CUE = '(?:until|pending|for|on|by|awaiting)';
const HOLD_IDIOMS = [
  'on[ -]hold',
  // "redeploy of :3001 held" (clause end) · "held until|pending|for|on|by|back|off|up" — never "held the fix" / "held across seeds".
  `held(?=\\s*(?:$|[,.;:!?)\\]—–-]|${HOLD_CUE}\\b|back\\b|off\\b|up\\b))`,
  `hold(?:s|ing)?\\s+${HOLD_CUE}\\b`,
  `halt(?:ed|ing)?\\s+(?:at\\b|${HOLD_CUE}\\b)`,
  `paused\\s+${HOLD_CUE}\\b`,
  'standing by',
  'awaiting (?:the )?owner',
  'waiting (?:on|for) (?:the )?owner',
];
/**
 * HOLD idioms in a progress note that contradict a 'done' close (finding 4:
 * the verb forms need a cue; bare "holds" / "holding steady" / "halted the
 * container" / "pauses for 2s" / "pause between batches removed" are progress).
 * Case-insensitive; the uppercase HOLD label and the note-start "hold" are
 * matched separately in holdTokenIn.
 */
export const HOLD_TOKEN_RE = new RegExp(`\\b(?:${HOLD_IDIOMS.join('|')})`, 'i');
/** An uppercase HOLD label anywhere ("HOLD: waiting for the GPU box", "HOLD until the owner rules") — case-SENSITIVE on purpose. */
export const HOLD_LABEL_RE = /\bHOLD\b/;
/** A note that STARTS with hold ("hold — redeploy pending", "Hold: …", "[hold] …"). */
export const HOLD_START_RE = /^\s*[[(]?\s*hold\b/i;

export interface GoalDoneSuspectInput {
  /** The goal's id (audit 2026-10-08 W5-5: a directive whose evidence cites it is the goal's own origin). */
  id?: string | null;
  /** When the goal was created (W5-5: a directive recorded before it — or just after, the supervisor's restatement — is its origin). */
  createdAt?: Date | string | null;
  title?: string | null;
  progressNote?: string | null;
  blockedReason?: string | null;
  premises?: unknown;
}
export interface GoalDoneSuspectDirective {
  id?: string;
  text: string;
  at?: string;
  /** The directive's scope as supervisor-state stamps it: the project NAME, 'fleet', or unset (legacy). */
  scope?: string | null;
  /** The evidence recorded on the (still open) directive — a dispatch / goal citation (W5-5). */
  evidence?: string | null;
}
export interface GoalDoneSuspectOptions {
  /** Close time (ms); defaults to Date.now(). */
  now?: number;
  /** The goal's project NAME — directives scoped to another project are ignored. Unset = no scope filter. */
  projectName?: string | null;
  /** When known, a directive recorded at/after the acting run's start is this wake's own order and is ignored (in addition to the grace window). */
  runStartedAt?: number | null;
  /** The lane chats working this goal (charter / todo assignees) — a directive whose evidence cites one is the goal's origin (W5-5). */
  laneIds?: string[] | null;
}

/**
 * audit 2026-10-08 W5-5 (goals.md P3): `open_directive` fired on 2 of 2 rows in
 * the audit window — and on all 4 in the 3 days before — against the goal's
 * OWN originating directive: the owner said "add events … to the database"
 * (directive b3a7775f, 21:53:25Z), the supervisor created goal 2f45b016 for it
 * (21:54:34Z), the goal auto-closed when its todos landed, and the still-open
 * directive (it closes against the goal's evidence minutes later) "named" the
 * goal by title overlap. A directive that PREDATES the goal (or restates it
 * within GOAL_DONE_SUSPECT_ORIGIN_SLACK_MS after its creation — 669a5269 / 443ff515
 * were the supervisor's restatements 51–84 s after the goal) is the goal's
 * REASON, not a contradiction of its close; so is one whose recorded EVIDENCE
 * cites the goal id or one of its lanes (a dispatch note). Only a directive
 * recorded AFTER the goal existed (and not citing it in its evidence) counts. Kill switch
 * GOAL_DONE_SUSPECT_ORIGIN_DIRECTIVE_DISABLED=1.
 */
export const GOAL_DONE_SUSPECT_ORIGIN_SLACK_MS = 30 * 60 * 1000;
export const goalDoneSuspectOriginSkipEnabled = (): boolean => process.env.GOAL_DONE_SUSPECT_ORIGIN_DIRECTIVE_DISABLED !== '1';

/** Is this directive the goal's own ORIGIN (see above)? Pure; exported for tests. */
export function isOriginatingDirective(goal: GoalDoneSuspectInput, d: GoalDoneSuspectDirective, opts: GoalDoneSuspectOptions = {}): boolean {
  if (!goalDoneSuspectOriginSkipEnabled()) return false;
  // The EVIDENCE only — a directive's own TEXT naming the goal id ("do not close goal X until …") is a real signal.
  const cited = String(d?.evidence ?? '').toLowerCase();
  const ids = [goal.id, ...(Array.isArray(opts.laneIds) ? opts.laneIds : [])]
    .map((x) => String(x ?? '').toLowerCase()).filter((x) => /^[0-9a-f]{8}/.test(x));
  for (const id of ids) if (cited.includes(id.slice(0, 8))) return true;
  const created = goal.createdAt instanceof Date ? goal.createdAt.getTime() : Date.parse(String(goal.createdAt ?? ''));
  const at = Date.parse(String(d?.at ?? ''));
  return Number.isFinite(created) && Number.isFinite(at) && at <= created + GOAL_DONE_SUSPECT_ORIGIN_SLACK_MS;
}
export interface UnmetTargetPremise {
  key: string;
  value: number;
  observed: number | null;
  unit?: string;
  bound: 'min' | 'max';
}
export interface GoalDoneSuspectVerdict {
  /** Every reason found (telemetry). */
  reasons: GoalDoneSuspectReason[];
  /** The subset that badges the board (see GOAL_DONE_SUSPECT_BOARD_REASONS). */
  boardReasons: GoalDoneSuspectReason[];
  /** Target premises with an OBSERVED value that misses the bar. */
  unmetPremises: UnmetTargetPremise[];
  /** Target premises with NO observed value on record (telemetry only). */
  unobservedPremises: UnmetTargetPremise[];
  /** GOAL-OUTCOME-UNMET: the kpi: premise of record whose value misses its bar (null when none / met / no bar). */
  kpiUnmet: KpiBarUnmet | null;
  holdToken: string | null;
  directiveIds: string[];
  /** One line for the tool result / audit — '' when nothing is suspect. */
  note: string;
}

const finite = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function isTargetPremise(p: unknown): boolean {
  return !!p && typeof p === 'object' && TARGET_PREMISE_KEY_RE.test(String((p as any).key ?? ''));
}

export function targetBound(key: string): 'min' | 'max' {
  const rest = String(key ?? '').replace(TARGET_PREMISE_KEY_RE, '');
  return TARGET_UPPER_BOUND_RE.test(rest) ? 'max' : 'min';
}

export type TargetPremiseState = 'met' | 'unmet' | 'unobserved' | 'malformed';

/**
 * Where a target premise stands: 'met' / 'unmet' need an OBSERVED number
 * (the hourly source sweep's stamp, or a lane's goal_premise_set observed);
 * 'unobserved' = no number on record; 'malformed' = no finite value.
 */
export function targetPremiseState(p: any): TargetPremiseState {
  const value = finite(p?.value);
  if (value === null) return 'malformed';
  const observed = finite(p?.observed);
  if (observed === null) return 'unobserved';
  const tol = Math.max(0, finite(p?.tolerance) ?? 0);
  const met = targetBound(String(p.key ?? '')) === 'max' ? observed <= value + tol : observed >= value - tol;
  return met ? 'met' : 'unmet';
}

/**
 * Is an observed value on record that MEETS this target premise? An
 * unobserved premise is NOT met — the doctrine sentence is "done only when an
 * OBSERVED premise meets it" — but it is not UNMET either (see
 * unobservedTargetPremises).
 */
export function targetPremiseMet(p: any): boolean {
  return targetPremiseState(p) === 'met';
}

const toRow = (p: any, value: number): UnmetTargetPremise => ({
  key: String(p.key), value, observed: finite(p.observed),
  ...(p.unit ? { unit: String(p.unit) } : {}),
  bound: targetBound(String(p.key)),
});

/** Target premises whose OBSERVED value misses the bar. */
export function unmetTargetPremises(premises: unknown): UnmetTargetPremise[] {
  if (!Array.isArray(premises)) return [];
  const out: UnmetTargetPremise[] = [];
  for (const p of premises as any[]) {
    if (!isTargetPremise(p) || targetPremiseState(p) !== 'unmet') continue;
    out.push(toRow(p, finite(p.value) as number));
  }
  return out;
}

/** Target premises with NO observed value on record (telemetry only — never a badge). */
export function unobservedTargetPremises(premises: unknown): UnmetTargetPremise[] {
  if (!Array.isArray(premises)) return [];
  const out: UnmetTargetPremise[] = [];
  for (const p of premises as any[]) {
    if (!isTargetPremise(p) || targetPremiseState(p) !== 'unobserved') continue;
    out.push(toRow(p, finite(p.value) as number));
  }
  return out;
}

/** GOAL-OUTCOME-UNMET: a kpi: premise of record whose register value misses its bar. */
export interface KpiBarUnmet {
  /** The premise key as registered (`kpi:` prefix kept). */
  key: string;
  value: number;
  bar: number;
  unit?: string;
  /** 'up' = the KPI must RISE to the bar (value < bar); 'down' = it must fall (value > bar). A DECLARED barDirection (ticket 9fcd69ca) wins over inference. */
  direction: 'up' | 'down';
  /** The premise's declared direction when it has one (ticket 9fcd69ca) — 'down' marks a ceiling (latency/p95/cap) bar: value ≤ bar is MET. */
  barDirection?: 'up' | 'down';
  receiptId?: string;
  setAt?: string;
}

/**
 * The goal's kpi: premise of record when it carries a finite `bar` the value
 * does not meet (kpiBarMet), else null. No bar ⇒ nothing to miss (a KPI
 * without a bar is a reading, not an outcome). Null under
 * GOAL_OUTCOME_CHECK_DISABLED=1. Pure; never throws.
 */
export function kpiBarUnmetOf(premises: unknown): KpiBarUnmet | null {
  try {
    if (goalOutcomeCheckDisabled()) return null;
    const kpi = kpiPremiseOf(premises);
    if (!kpi || kpi.bar === undefined || kpi.bar === null) return null;
    // Ticket d1a7bec2 (CASE 2): compare against the bar the KPI is actually
    // measured on — a BOOLEAN unit's bar is 1 (true), never a numeric bar
    // copied over from a sibling percentage. Without this a closed goal sits
    // on the board with a permanent "⚠ suspect" no reading can ever clear.
    const barRaw = effectiveKpiBar(kpi);
    if (!Number.isFinite(Number(barRaw)) || !Number.isFinite(Number(kpi.value))) return null;
    const bar = Number(barRaw);
    if (kpiBarMet({ ...kpi, bar })) return null;
    const declaredBarDirection = normalizeKpiBarDirection(kpi.barDirection) ?? undefined;
    return {
      key: String(kpi.key), value: Number(kpi.value), bar, direction: kpiBarDirection({ ...kpi, bar }),
      ...(kpi.unit ? { unit: String(kpi.unit) } : {}),
      ...(kpi.receiptId ? { receiptId: String(kpi.receiptId) } : {}),
      ...(kpi.setAt ? { setAt: String(kpi.setAt) } : {}),
      ...(declaredBarDirection ? { barDirection: declaredBarDirection } : {}),
    };
  } catch {
    return null;
  }
}

/** "kpi tok_s=5.08 tok/s < bar 10" — the comparison the board / note / wake print. */
export function formatKpiBarUnmet(k: KpiBarUnmet): string {
  return `kpi ${kpiBareKey(k.key)}=${kpiValueText(k)} ${k.direction === 'up' ? '<' : '>'} bar ${k.bar}`;
}

/** The first HOLD idiom in the note, or null. */
export function holdTokenIn(text: unknown): string | null {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  const label = HOLD_LABEL_RE.exec(s);
  const start = HOLD_START_RE.exec(s);
  const idiom = HOLD_TOKEN_RE.exec(s);
  const hits = [label, start, idiom].filter((m): m is RegExpExecArray => !!m);
  if (!hits.length) return null;
  hits.sort((a, b) => a.index - b.index);
  const m = hits[0];
  // The note-start match carries its leading bracket/space — report the word.
  return m === start ? (/hold/i.exec(m[0]) as RegExpExecArray)[0] : m[0];
}

/** Stopword-free lowercase alphanumeric key terms (≥3 chars) — the directive-conflict discipline, trimmed. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'without', 'are', 'was', 'were', 'been', 'its', 'this', 'that', 'these', 'those',
  'then', 'than', 'from', 'into', 'about', 'over', 'under', 'you', 'our', 'your', 'does', 'did', 'will', 'would',
  'should', 'could', 'can', 'have', 'has', 'had', 'not', 'yes', 'please', 'now', 'when', 'them', 'they', 'their',
  'there', 'here', 'what', 'which', 'how', 'why', 'per', 'via', 'just', 'also', 'once', 'goal', 'todo',
]);
export function goalKeyTerms(text: unknown): Set<string> {
  return new Set(
    String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

/** Does an open directive name this goal? Pure; exported for tests. */
export function directiveNamesGoal(directiveText: unknown, goalTitle: unknown): boolean {
  const goalTerms = goalKeyTerms(goalTitle);
  if (!goalTerms.size) return false;
  const directiveTerms = goalKeyTerms(directiveText);
  let shared = 0;
  for (const t of goalTerms) if (directiveTerms.has(t)) shared += 1;
  return shared >= GOAL_DONE_SUSPECT_DIRECTIVE_MIN_SHARED && shared / goalTerms.size >= GOAL_DONE_SUSPECT_DIRECTIVE_COVERAGE;
}

// A directive that itself ORDERS the close (finding 3): "mark the vLLM goal
// done", "close it — the bar is met", "the target has been reached", "call it
// finished". A negation right before the verb ("do not close it as done",
// "never mark it done until…") keeps it an anti-close order.
const CLOSE_VERB = '(?:mark(?:ed|ing)?|close[ds]?|closing|set(?:ting)?|flip(?:ped|ping)?|declare[ds]?|call(?:ed|ing)?|consider|treat|wrap(?:ped)?\\s+up|finish(?:ed)?|record(?:ed)?)';
const CLOSE_STATE = '(?:done|complete[d]?|closed|finished|achieved|met|resolved|reached)';
const DIRECTIVE_CLOSE_RE = new RegExp([
  `\\b${CLOSE_VERB}\\b[^.;:\\n]{0,50}?\\b${CLOSE_STATE}\\b`,
  `\\b(?:bar|target|goal|threshold)\\b[^.;:\\n]{0,20}?\\b(?:is|was|has\\s+been|are|were|have\\s+been)\\s+(?:now\\s+|already\\s+)?(?:met|achieved|reached|hit|satisfied)\\b`,
  `\\b(?:is|are|was|were|has\\s+been|have\\s+been)\\s+(?:now\\s+|already\\s+)?(?:done|complete|finished|achieved)\\b`,
].join('|'), 'gi');
const CLOSE_NEGATION_RE = /\b(?:do\s+not|don['’]t|never|not|no|without|until|before|unless)\s+(?:\w+\s+){0,2}$/i;

/** Does the directive's own text order the close? Pure; exported for tests. */
export function directiveOrdersClose(directiveText: unknown): boolean {
  const s = String(directiveText ?? '');
  for (const m of s.matchAll(DIRECTIVE_CLOSE_RE)) {
    const before = s.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0);
    if (CLOSE_NEGATION_RE.test(before)) continue;
    return true;
  }
  return false;
}

const normScope = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
/** A directive counts only when its scope is unset (legacy), 'fleet', or THIS goal's project. Pure; exported for tests. */
export function directiveInScope(scope: unknown, projectName: unknown): boolean {
  const sc = normScope(scope);
  if (!sc || sc === 'fleet') return true;
  const pn = normScope(projectName);
  if (!pn) return true; // no project name to compare against: never drop on a missing fact
  return sc === pn;
}

/**
 * The directives that count against THIS close: named goal, outside the
 * grace window / not this wake's own order, not a close order, in scope.
 */
export function relevantDirectives(goal: GoalDoneSuspectInput, directives: GoalDoneSuspectDirective[], opts: GoalDoneSuspectOptions = {}): GoalDoneSuspectDirective[] {
  const now = Number.isFinite(opts.now) ? (opts.now as number) : Date.now();
  const out: GoalDoneSuspectDirective[] = [];
  for (const d of Array.isArray(directives) ? directives : []) {
    if (!d || !directiveNamesGoal(d.text, goal.title)) continue;
    const at = Date.parse(String(d.at ?? ''));
    if (Number.isFinite(at)) {
      if (now - at < GOAL_DONE_SUSPECT_DIRECTIVE_GRACE_MS) continue; // this wake's own order
      if (Number.isFinite(opts.runStartedAt) && at >= (opts.runStartedAt as number)) continue;
    }
    if (directiveOrdersClose(d.text)) continue;
    if (!directiveInScope(d.scope, opts.projectName)) continue;
    if (isOriginatingDirective(goal, d, opts)) continue; // W5-5: the goal's own origin is not a contradiction
    out.push(d);
  }
  return out;
}

export function formatUnmetPremise(u: UnmetTargetPremise): string {
  const unit = u.unit ?? '';
  const target = `${u.bound === 'max' ? '≤' : '≥'}${u.value}${unit}`;
  return u.observed === null ? `${u.key} ${target} never observed` : `${u.key} ${target}, observed ${u.observed}${unit}`;
}

const emptyVerdict = (): GoalDoneSuspectVerdict => ({ reasons: [], boardReasons: [], unmetPremises: [], unobservedPremises: [], kpiUnmet: null, holdToken: null, directiveIds: [], note: '' });

/**
 * Assess a 'done' close. Pure: the caller supplies the goal row and (when it
 * has them) the owner's open directives.
 */
export function assessGoalDoneSuspect(goal: GoalDoneSuspectInput, directives: GoalDoneSuspectDirective[] = [], opts: GoalDoneSuspectOptions = {}): GoalDoneSuspectVerdict {
  try {
    const reasons: GoalDoneSuspectReason[] = [];
    const parts: string[] = [];
    const unmetPremises = unmetTargetPremises(goal.premises);
    if (unmetPremises.length) {
      reasons.push('premise_target_unmet');
      parts.push(`target premise unmet (${unmetPremises.slice(0, 3).map(formatUnmetPremise).join('; ')})`);
    }
    const unobservedPremises = unobservedTargetPremises(goal.premises);
    if (unobservedPremises.length) {
      reasons.push('premise_target_unobserved');
      parts.push(`target premise never observed (${unobservedPremises.slice(0, 3).map((u) => u.key).join(', ')})`);
    }
    // GOAL-OUTCOME-UNMET (2026-10-20): the KPI of record below its bar.
    const kpiUnmet = kpiBarUnmetOf(goal.premises);
    if (kpiUnmet) {
      reasons.push('kpi_bar_unmet');
      parts.push(`KPI of record misses its bar (${formatKpiBarUnmet(kpiUnmet)})`);
    }
    // a8d6e514: the note may be a 2,000-char continuation ledger — the HOLD idiom is read from its LEAD only.
    const holdToken = holdTokenIn(progressNoteLead(goal.progressNote)) ?? holdTokenIn(goal.blockedReason);
    if (holdToken) {
      reasons.push('hold_token');
      parts.push(`progress note says "${holdToken}"`);
    }
    const directiveIds = relevantDirectives(goal, directives, opts).map((d) => String(d.id ?? '').slice(0, 8) || '?');
    if (directiveIds.length) {
      reasons.push('open_directive');
      parts.push(`open owner directive still names it (${directiveIds.slice(0, 3).join(', ')})`);
    }
    if (!reasons.length) return emptyVerdict();
    const boardReasons = reasons.filter(isBoardSuspectReason);
    const badged = reasons.some((r) => r !== 'premise_target_unobserved');
    const remedy = reasons.includes('kpi_bar_unmet')
      ? (reasons.some((r) => r !== 'kpi_bar_unmet' && r !== 'premise_target_unobserved') ? `${GOAL_DONE_SUSPECT_REMEDY_KPI}; otherwise ${GOAL_DONE_SUSPECT_REMEDY_UNMET}` : GOAL_DONE_SUSPECT_REMEDY_KPI)
      : badged ? GOAL_DONE_SUSPECT_REMEDY_UNMET : GOAL_DONE_SUSPECT_REMEDY_UNOBSERVED;
    return {
      reasons, boardReasons, unmetPremises, unobservedPremises, kpiUnmet, holdToken, directiveIds,
      note: `${badged ? GOAL_DONE_SUSPECT_BADGE : 'note'}: ${parts.join('; ')} — the close stands (observe-only); ${remedy}.`,
    };
  } catch {
    return emptyVerdict();
  }
}

/** Short badge for a board / digest line, e.g. "⚠ suspect: premise_target_unmet, hold_token" — '' when no BOARD reason applies.
 *  `withDirectives` (board-time re-derivation, 2026-09-28): the caller assessed the goal against a live directive read, so an
 *  `open_directive` reason is a board reason too — before this the directive reason was close-time only. */
export function renderGoalDoneSuspectBadge(verdict: Pick<GoalDoneSuspectVerdict, 'reasons' | 'unmetPremises'> & Partial<Pick<GoalDoneSuspectVerdict, 'boardReasons' | 'kpiUnmet'>>, opts: { withDirectives?: boolean } = {}): string {
  const source = opts.withDirectives === true ? verdict.reasons : (verdict.boardReasons ?? verdict.reasons);
  const board = source.filter((r) => isBoardSuspectReason(r) || (opts.withDirectives === true && r === 'open_directive'));
  if (!board.length) return '';
  const detail = board.includes('premise_target_unmet') && verdict.unmetPremises.length ? ` (${formatUnmetPremise(verdict.unmetPremises[0])})`
    : board.includes('kpi_bar_unmet') && verdict.kpiUnmet ? ` (${formatKpiBarUnmet(verdict.kpiUnmet)})` : '';
  return `${GOAL_DONE_SUSPECT_BADGE}: ${board.join(', ')}${detail}`;
}
