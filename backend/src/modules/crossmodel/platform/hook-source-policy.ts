/**
 * SAA-1.1 TRIGGER ADMISSION — a DETERMINISTIC policy that runs BEFORE any model
 * call on a hook wake (todo eb328629, backlog section SAA-1.1, essay §3.1).
 *
 * THE GAP THIS MEASURES. Digby's hook fan-in is wildcard at the ROOT: `EventHook`
 * carries `sourceChatId String?` where NULL is the owner-scope wildcard, and
 * `eventTypes String[]` is the ONLY subscriber-side filter — there is no
 * per-source policy column. So admission is a MODEL judgment, not code:
 * `wake_triage` is asked at `platform/hooks.service.ts` (`decisionMode('wake_triage')`)
 * and every emission that survives the depth ladder can cost a triage call.
 * What code already does is STRUCTURAL, not semantic: MAX_HOOK_DEPTH, the
 * alarm-class short-circuit `isAlarmEvent`, and the emit-time fingerprint dedupe.
 * None of them answers the essay's per-SOURCE question — "respond / treat as
 * candidate / ignore" — before a model is invoked.
 *
 * PHASE 1 IS OBSERVE-ONLY, AND BY CONSTRUCTION RATHER THAN BY DISCIPLINE.
 * This module returns a `HookSourcePolicyDecision` whose `applied` field is the
 * literal `false`, exactly as `platform/inline-spill.ts` does: no call site can
 * read a decision as a suppression, so every row still delivers on today's path
 * and the ONLY production effect is the `hook_source_policy_observe` row. That
 * is what makes the 48 h window meaningful — we are measuring what the policy
 * WOULD have done against what actually happened, not gambling on it.
 *
 * THE LATER LABEL. A suppressed wake is a missed event you never learn about,
 * so the observation is only worth anything if it can be judged AFTER the fact.
 * It can, because Phase 1 does not drop anything: the rows we would have
 * suppressed still ride the same group and the same run, and that run is
 * labelled by the harness's OWN verdict — `wakeActed()` in
 * `platform/decision-outcome-labels.ts`, derived from what the run measurably
 * DID (real mutating platform tools, housekeeping and report-ups removed),
 * never from what the model claimed. `attributeSuppression` below is the join:
 * given the row ids we would have suppressed and that later verdict, it says
 * whether a suppression would have been RIGHT.
 *
 * NEVER a model claim, never a network call: this leaf is pure, synchronous and
 * total. It is imported on the hot emit path.
 */

import { createHash } from 'node:crypto';
import type { LoopMetricKind } from './loop-metric-kinds';

/** The kind stamped once per batch the policy would have suppressed (observe-only). */
export const HOOK_SOURCE_POLICY_OBSERVE = 'hook_source_policy_observe' as const;

/**
 * The three-valued verdict the essay asks for. `candidate` is the DEFAULT and
 * the pre-policy behaviour: the batch reaches the decision gate exactly as it
 * does today. `ignore` is the policy's claim that no model is needed.
 */
export const HOOK_SOURCE_DECISIONS = ['respond', 'candidate', 'ignore'] as const;
export type HookSourceDecision = (typeof HOOK_SOURCE_DECISIONS)[number];

/**
 * WHY the policy reached its verdict — a closed vocabulary so the 48 h readout
 * can be aggregated without re-parsing prose. Ordered by precedence: the first
 * matching reason wins, so a batch that is BOTH alarm-class and rout ine is
 * reported as `alarm_class` (the safe reason), never as `routine_completion`.
 */
export const HOOK_SOURCE_REASONS = [
  /** The batch carries an alarm-class row (attention_needed / run_failed / goal_blocked / schedule_disabled / todo_wake, cause-aware). */
  'alarm_class',
  /** A row reports a failure, block, stall, crash or failed exit code. */
  'failure_or_block',
  /** A row asks a question or requests a decision (regex over emitter-authored prose). */
  'question_or_request',
  /** A row is owner-facing: it needs the owner's decision or names a folded owner card. */
  'owner_facing',
  /** A row is explicitly addressed to a supervisor (report-up / escalation / @fleet). */
  'addressed_to_supervisor',
  /**
   * A `run_completed` batch whose OWN run already made real mutating platform
   * calls (goal_create / todo_create / todo_update / send_chat_message / …).
   * The completion notice looks routine, but the run it reports on did work, so
   * "a model is not needed" is not a safe claim. Admission-time observable:
   * those calls are `run_tool_receipts` rows written BEFORE the wake is
   * processed — see `sourceRunMutated` below. (SAA-1.1 Phase 1, 2026-11-03.)
   */
  'source_run_mutated',
  /** Every row is a routine completion/done notice, nothing above fired, ONE source. */
  'routine_completion',
  /** The same, but the batch fans in from more than one source lane. */
  'routine_multi_source',
  /** A row carries a guard-REPLACED final — an evidence-guard action, never routine. */
  'guard_replaced_final',
  /** Batches older than the deferral bound are never ignored: staleness is not a reason to drop. */
  'stale_batch',
  /** Anything the policy cannot classify with confidence — the fail-safe default. */
  'unclassified',
] as const;
export type HookSourceReason = (typeof HOOK_SOURCE_REASONS)[number];

/** HOOK_SOURCE_POLICY_DISABLED=1 — the release kill switch (restores today's "every admitted emission can be triaged"). */
export function hookSourcePolicyDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env?.HOOK_SOURCE_POLICY_DISABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

/** The event types the policy may call ROUTINE. Anything not named here stays `candidate`. */
export const ROUTINE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run_completed',
  'todo_done',
  'schedule_near_cap',
]);

/**
 * The kinds this policy is allowed to make a claim about at all. A type outside
 * this set is `candidate` by construction — new event types must OPT IN rather
 * than be silently swept into `ignore` by a future maintainer.
 */
export const POLICY_COVERED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'run_completed',
  'run_failed',
  'attention_needed',
  'goal_blocked',
  'todo_done',
  'schedule_cap_skipped',
  'schedule_disabled',
  'schedule_near_cap',
  'ci_failed',
]);

/** A batch older than this is never ignored — staleness is not permission to drop. */
export const HOOK_SOURCE_POLICY_MAX_IGNORE_AGE_MIN = 720;

/** The minimum-viable shape of a hook row the policy reads. Tolerant of malformed rows. */
export interface HookSourcePolicyRow {
  id?: unknown;
  eventType?: unknown;
  payload?: unknown;
  createdAt?: unknown;
}

export interface HookSourcePolicyInput {
  rows: ReadonlyArray<HookSourcePolicyRow>;
  /**
   * Whether the batch holds an alarm-class row, as classified by the CALLER's
   * `isAlarmEvent` (cause-aware: it de-escalates a schedule_disabled carrying a
   * successorId, a quiet alarm cause, and an archived-target retire). Passed in
   * rather than re-derived so there is exactly ONE alarm definition on the path.
   */
  alarm: boolean;
  /** The code-computed prose flags the triage request already builds. */
  flags?: {
    any_row_is_question_or_request?: boolean;
    any_row_addressed_to_supervisor?: boolean;
    any_row_reports_failure_or_block?: boolean;
    any_row_guard_replaced_final?: boolean;
    any_row_owner_facing?: boolean;
    distinct_sources?: number;
  } | null;
  /**
   * TRI-STATE, and the caller must be honest about which it knows:
   *   true  — the batch's source run already made real mutating platform calls
   *           (`isRealActionTool`: goal_create / todo_create / todo_update /
   *           send_chat_message / … minus wake housekeeping). Admission-time
   *           observable: those `run_tool_receipts` rows are written BEFORE the
   *           hook wake is processed.
   *   false — receipts were read and NONE was a real action.
   *   null / undefined — not established (no runId on the rows, the lookup
   *           failed, or the caller does not do the lookup at all).
   * ONLY `false` permits a `run_completed` batch to be ignored. Unknown is
   * treated like true, because "we could not rule out that this run did work"
   * is exactly the state in which a suppression is unsafe — and the whole
   * point of this flag is to stop a completed run that DID work from being
   * suppressed on the strength of its quiet-looking summary.
   */
  sourceRunMutated?: boolean | null;
  now?: number;
}

export interface HookSourcePolicyDecision {
  /** OBSERVE-ONLY: the literal false. No call site can read this as a suppression. */
  applied: false;
  /** 'off' when the kill switch is on — the decision is then a no-op report, never a claim. */
  mode: 'off' | 'observe';
  decision: HookSourceDecision;
  reason: HookSourceReason;
  /** Event types in the batch → count. */
  kinds: Record<string, number>;
  /** Rows offered to the policy. */
  rows: number;
  /** Up to 3 row ids (8-char) — the join key to the LATER label. */
  ids: string[];
  /** Total distinct source lanes in the batch. */
  sources: number;
}

function eventTypeOf(row: HookSourcePolicyRow): string {
  const p = (row?.payload ?? {}) as Record<string, unknown>;
  return String(row?.eventType ?? p.eventType ?? '');
}

function ageMinOf(row: HookSourcePolicyRow, now: number): number | null {
  const raw = row?.createdAt;
  const t = raw instanceof Date ? raw.getTime() : new Date(String(raw ?? '')).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 60000));
}

/**
 * THE POLICY. Pure, synchronous, total — no model, no I/O, no env read beyond
 * the kill switch. A batch it cannot classify is `candidate` (fail-safe), which
 * is today's behaviour, so the default can never suppress anything.
 */
export function decideHookSourcePolicy(
  input: HookSourcePolicyInput,
  env: NodeJS.ProcessEnv = process.env,
): HookSourcePolicyDecision {
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  const now = input?.now ?? Date.now();
  const kinds: Record<string, number> = {};
  const sourceIds = new Set<string>();
  let oldestAge: number | null = null;
  let uncovered = false;

  for (const r of rows) {
    const k = eventTypeOf(r) || 'unknown';
    kinds[k] = (kinds[k] ?? 0) + 1;
    if (!POLICY_COVERED_EVENT_TYPES.has(k)) uncovered = true;
    const p = (r?.payload ?? {}) as Record<string, unknown>;
    const src = String(p.sourceChatId ?? '').trim();
    if (src) sourceIds.add(src);
    const age = ageMinOf(r, now);
    if (age !== null && (oldestAge === null || age > oldestAge)) oldestAge = age;
  }

  const ids = rows
    .map((r) => (r?.id === undefined || r?.id === null ? '' : String(r.id)))
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => s.slice(0, 8));
  const sources = input?.flags?.distinct_sources ?? sourceIds.size;
  const base = { applied: false as const, mode: 'off' as const, kinds, rows: rows.length, ids, sources };

  // Kill switch: report the batch shape, claim nothing. `candidate` is the
  // honest verdict when we are not observing — off is off.
  if (hookSourcePolicyDisabled(env)) return { ...base, decision: 'candidate', reason: 'unclassified' };

  const observe = { ...base, mode: 'observe' as const };
  const f = input?.flags ?? null;

  // ── Precedence: every reason that means "a model may be needed" is checked
  // BEFORE any reason that means "routine", so a mixed batch can never be
  // ignored on the strength of its quiet half. ──
  if (input?.alarm) return { ...observe, decision: 'respond', reason: 'alarm_class' };
  if (f?.any_row_guard_replaced_final) return { ...observe, decision: 'respond', reason: 'guard_replaced_final' };
  if (f?.any_row_reports_failure_or_block) return { ...observe, decision: 'respond', reason: 'failure_or_block' };
  if (f?.any_row_owner_facing) return { ...observe, decision: 'respond', reason: 'owner_facing' };
  if (f?.any_row_is_question_or_request) return { ...observe, decision: 'respond', reason: 'question_or_request' };
  // Addressed-to-supervisor is a report-up: it is worth reading, but it is NOT
  // evidence a turn is needed NOW — that is precisely the report-up class the
  // wake-cadence-5 label taught the act-mode gates to stop waking for. So it
  // stays a CANDIDATE (the model still decides) rather than a respond.
  if (f?.any_row_addressed_to_supervisor) return { ...observe, decision: 'candidate', reason: 'addressed_to_supervisor' };

  if (!rows.length) return { ...observe, decision: 'candidate', reason: 'unclassified' };
  if (uncovered) return { ...observe, decision: 'candidate', reason: 'unclassified' };
  // Every row must be a routine type; one non-routine row keeps the batch a candidate.
  for (const k of Object.keys(kinds)) {
    if (!ROUTINE_EVENT_TYPES.has(k)) return { ...observe, decision: 'candidate', reason: 'unclassified' };
  }
  // ── THE SOURCE-RUN MUTATION GUARD (SAA-1.1 Phase 1, 2026-11-03). ──
  // A run_completed notice says the run FINISHED; it says nothing about whether
  // the run DID anything. Measured on the live replay: hook 15ba91cf sent the
  // SAME lone run_completed shape into the SAME chat twice ~33 min apart, and
  // one wake went on to mutate four things while the other did not — so the
  // event rows alone cannot separate them. What CAN separate them is the run's
  // own `run_tool_receipts`, written BEFORE this wake is processed.
  // Only an explicit `false` may reach the ignore return below: `true` means the
  // run did work, and `null`/undefined means the caller could not rule it out —
  // both are unsafe to suppress, and the fail-safe direction here is candidate.
  // `todo_done` and `schedule_near_cap` carry no source-run receipts, so this
  // guard is scoped to a batch that actually contains a run_completed.
  if ((kinds.run_completed ?? 0) > 0 && input?.sourceRunMutated !== false) {
    return { ...observe, decision: 'candidate', reason: 'source_run_mutated' };
  }
  if (oldestAge !== null && oldestAge > HOOK_SOURCE_POLICY_MAX_IGNORE_AGE_MIN) {
    return { ...observe, decision: 'candidate', reason: 'stale_batch' };
  }
  if (sources > 1) return { ...observe, decision: 'candidate', reason: 'routine_multi_source' };
  return { ...observe, decision: 'ignore', reason: 'routine_completion' };
}

/**
 * The metric meta for an observe row — counts and ids ONLY, never the prose it
 * measured (house rule: a telemetry row must not carry the object it measures).
 * Returns null when there is nothing to report: an admitted batch the policy
 * would have let through anyway is not news, and a row per admitted batch would
 * drown the 48 h readout in the denominator without adding a numerator.
 */
export function hookSourcePolicyMetricMeta(decision: HookSourcePolicyDecision): Record<string, unknown> | null {
  if (!decision || decision.mode !== 'observe') return null;
  // Only a WOULD-HAVE-SUPPRESSED batch is news. `respond` is recorded too,
  // because the false-negative side of the readout needs the batches the policy
  // was confident about — but `candidate` (the fail-safe, i.e. today's
  // behaviour) writes nothing.
  //
  // ONE EXCEPTION (review fix, 2026-11-03): `source_run_mutated` IS recorded even
  // though it is a candidate. That batch reached the routine branch and was
  // turned away by the source-run guard — it is the population whose
  // would-suppression the guard now decides, and dropping it would leave Phase 1
  // with no denominator at all for `run_completed` (the guard silently eats every
  // verdict it produces). It stays a CANDIDATE — never counted as a suppression,
  // never in precision — so this is visibility, not a reclassification.
  if (decision.decision === 'candidate') {
    if (decision.reason !== 'source_run_mutated') return null;
  } else if (!decision.rows) return null;
  return {
    decision: decision.decision,
    reason: decision.reason,
    rows: decision.rows,
    sources: decision.sources,
    kinds: decision.kinds,
    ids: decision.ids,
  };
}

/** The harness's OWN later verdict, as `attributeSuppression` consumes it. */
export interface SuppressionLaterLabel {
  /** Did the group that carried these rows run at all? false = it never reached a run. */
  delivered: boolean;
  /** `wakeActed()` for the run that finalised that group — the harness's own label, never the model's claim. */
  acted: boolean;
}

export type SuppressionVerdict =
  /** Suppression would have been CORRECT: the wake did not act. */
  | 'would_hold'
  /** Suppression would have been WRONG: the wake acted, so a turn WAS needed. */
  | 'would_lose'
  /** The group never reached a run — no verdict is possible; excluded from precision. */
  | 'unresolved';

/**
 * THE JOIN — the harness's own later label, applied to a would-have-suppressed
 * batch. Phase 1 suppresses nothing, so the rows still ride the same group and
 * the same run; `acted` is that run's `wakeActed()` verdict. A suppression is
 * correct exactly when the wake that carried those rows did NOT act.
 *
 * Deliberately asymmetric with the KNOWN BIAS documented on `firing_superseded`:
 * `wakeActed` is biased toward "acted" (a wake that merely repeats the finished
 * run's facts can still file a receipt), which makes `would_lose` an OVER-estimate
 * and `would_hold` a CONSERVATIVE reading. Precision computed from this join is
 * therefore a FLOOR, not a point estimate — say so when quoting it.
 */
export function attributeSuppression(label: SuppressionLaterLabel | null | undefined): SuppressionVerdict {
  if (!label || label.delivered !== true) return 'unresolved';
  return label.acted === true ? 'would_lose' : 'would_hold';
}

/**
 * Precision over a set of verdicts: `would_hold / (would_hold + would_lose)`.
 * `unresolved` verdicts are EXCLUDED, not counted as successes — a batch that
 * never ran proves nothing either way. Returns null when nothing resolved, which
 * is the honest answer for a quiet window (never 1.0, never 0).
 */
export function suppressionPrecision(verdicts: ReadonlyArray<SuppressionVerdict>): number | null {
  let hold = 0;
  let lose = 0;
  for (const v of verdicts) {
    if (v === 'would_hold') hold += 1;
    else if (v === 'would_lose') lose += 1;
  }
  const n = hold + lose;
  return n > 0 ? hold / n : null;
}

/** Compile-time proof the metric kind is a registered loop-metric kind. */
export type HookSourcePolicyMetricKind = Extract<LoopMetricKind, typeof HOOK_SOURCE_POLICY_OBSERVE>;

/**
 * THE DURABLE CORRELATION KEY for ONE batch (todo 03bcf00f).
 *
 * The observe row names the batch (`hookId` + `ids`), but nothing on the LABEL
 * side did: a `decision_gate` outcome row carries `stateHash`, never a hookId,
 * and `wake_delivered` carries `hookId` with no ids and no runId. So a batch
 * could only be tied to the run that finalised it TEMPORALLY — measured
 * 2026-11-03: 4 of 1,909 would-suppress batches resolved (0.21% coverage),
 * because the join had to guess inside a window where one chat-hour holds up
 * to 120 outcome rows.
 *
 * This key is stamped, unchanged, on both sides:
 *   - the `wake_delivered` metric meta (the delivery),
 *   - the wake_triage `DecisionStash.extra` → the outcome row's meta (the label).
 * so the grader joins `hookBatchKey === hookBatchKey` with NO time window.
 *
 * Shape: `<hookId>|<ids joined by comma>`, canonicalised by `canonicalBatchKey`.
 * `compactExtra` slices string extras to 80, so the key must fit that budget —
 * and BOTH sides must fit it IDENTICALLY, or the outcome side gets a silently
 * cut string that no longer matches the delivery side.
 *
 * TELEMETRY ONLY: this changes no admission decision, wakes nothing, and is
 * never read by the policy. It is a correlation handle, not a control.
 */

/** `compactExtra`'s string budget — the key must fit it on BOTH sides. */
export const HOOK_BATCH_KEY_MAX = 80;

/**
 * THE canonical batch identity — the ONE function both sides call.
 *
 * This exists because two hand-kept-in-sync functions is exactly how the join
 * broke once already: `hookBatchKey` joined arrival order while the grader's
 * `batchKeyOf` sorted, so the key agreed only for fixtures whose ids happened
 * to be pre-sorted (fixed 2026-11-03, 3844f715). A second asymmetry survived
 * that fix and is closed here: `hookBatchKey` SLICED to 80 while `batchKeyOf`
 * did not, so any batch whose id list pushed the raw key past 80 chars (a
 * 36-char uuid hookId plus FIVE 8-char ids = 86) produced a truncated stamp
 * and an untruncated dedupe key — a silent 0% join for exactly those batches.
 * Measured: live keys maxed at 54 chars on 2026-11-03, so nothing was lost yet;
 * it was a latent break, not an active one.
 *
 * WHY A DIGEST RATHER THAN A PLAIN SLICE. Plain truncation on the DEDUPE side
 * would be worse than the bug: two distinct large batches sharing an 80-char
 * prefix would collapse into ONE batch, inflating that batch's admissions and
 * mis-attributing a label. So beyond the budget the key keeps a readable head
 * and appends a digest of the FULL raw string. Distinct batches can then never
 * collide, and both sides still compute the same 80 chars.
 *
 * ≤80-char inputs are returned BYTE-IDENTICAL to the pre-fix shape, so every
 * key already stamped in production keeps matching — there is no migration.
 */
export function canonicalBatchKey(hookId: unknown, ids: readonly string[]): string {
  const h = String(hookId ?? '').trim();
  const list = (Array.isArray(ids) ? ids : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  // SORT: a re-admitted batch must keep ONE identity when it surfaces its ids in
  // a different order (the policy emits arrival order; a growing batch re-emits).
  const raw = `${h}|${[...list].sort().join(',')}`;
  if (raw.length <= HOOK_BATCH_KEY_MAX) return raw;
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return `${raw.slice(0, HOOK_BATCH_KEY_MAX - 17)}#${digest}`;
}

/**
 * The stamp side: the canonical key, or `null` when the batch cannot be
 * identified at all (never a partial key — a half key would join the wrong run).
 */
export function hookBatchKey(hookId: unknown, ids: readonly string[]): string | null {
  const h = String(hookId ?? '').trim();
  const list = (Array.isArray(ids) ? ids : []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!h || !list.length) return null;
  return canonicalBatchKey(h, list);
}
