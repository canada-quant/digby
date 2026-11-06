/**
 * Machine-checkable acceptance metrics for fix tickets (ticket 6665fff6 —
 * the lifecycle half of b4824553's done-bar).
 *
 * WHY: "fixes are marked done at merge, sometimes before deploy" — and even
 * after the deploy gate landed (b4824553's pipeline half, PR #1634), a fix
 * ticket's "did it actually WORK in prod?" was never measured. Detectors said
 * "measure in 7 days" but no todo owned the measurement. This module gives a
 * fix ticket a DECLARATIVE metric at filing time that the post-deploy
 * verifier job (ticket-postdeploy-verifier.service.ts) can re-run
 * deterministically after the fix deploys.
 *
 * SECURITY INVARIANT: a metric is DATA, never code. The probe is chosen from
 * a CLOSED allowlist; params are validated scalars/strings (capped, matched
 * as case-insensitive SUBSTRINGS via Prisma parameterized queries — never
 * RegExp from ticket content, never eval, never a shell). A hostile or
 * malformed metric is rejected at FILING time by validateAcceptanceMetric()
 * and reads as null afterwards (readAcceptanceMetric re-validates).
 *
 * The three probes (deliberately small — each must be a bounded, indexed,
 * read-only COUNT):
 *   - app_error_log_count — app_error_logs rows (level/source/message
 *     substring) since the window start. E.g. "the P2025 refreshToken row
 *     class stays at 0 over 24h".
 *   - loop_metric_count   — loop_metrics rows of a kind since the window
 *     start. E.g. "infra_alert rows of kind X stay <= 2 over 24h" (it fired
 *     12/day before the fix).
 *   - ticket_count        — user_feature_requests rows (type/status) touched
 *     in the window. E.g. "lane archive-stuck tickets of this class == 0
 *     over 24h".
 *
 * ACCEPTANCE-METRIC-BASELINE (2026-10-20): only ~4 % of tickets ever got a
 * post-deploy proof, and two of the three metrics in prod could never match
 * (messagePattern 'a|b' is a LITERAL substring, so `<= 0` passed vacuously).
 * Now (kill switch ACCEPTANCE_BASELINE_GATE_DISABLED=1 restores all of it):
 *   - a messagePattern carrying regex INTENT ('|', a backslash, '.*',
 *     '[a-z]', …) is refused at filing (regexIntentOf) and reads as
 *     unmeasurable in the verifier (never a vacuous pass);
 *   - the BASELINE gate measures the probe over the PRE-FIX window (ending at
 *     filing) and requires the metric to FAIL there (baseline > target for
 *     <= / ==): a metric that already passes before the fix can prove nothing.
 *     A rare-event fix (target 0) qualifies on a baseline of 1. Applied at
 *     filing (feedback.service — a vacuous metric is not stored, the ticket
 *     still files, flagged), at close (the done-bar redirect stamps it) and in
 *     the verifier (a vacuous metric closes on the merged ∧ deployed bar as
 *     'done', never 'deployed_verified');
 *   - loop_metric_count takes an ALLOWLISTED meta filter (metaKey ∈
 *     LOOP_METRIC_META_KEYS, metaValue matched by JSON-path equality — still a
 *     parameterized query, never code);
 *   - auto-filers attach a DEFAULT metric (logSignalDefaultMetric /
 *     frameworkFindingDefaultMetric — kill switch
 *     AUTOFILER_DEFAULT_METRIC_DISABLED=1), subject to the same baseline gate.
 *
 * windowHours is BOTH the measurement window and the wait the verifier
 * observes before issuing a FAIL (a "count == 0 over 24h" metric cannot
 * honestly pass 10 minutes after deploy): the verifier measures
 * [max(firstLiveAt, now − window), now] and only a MEASURED fail after the
 * full window elapses reopens the ticket. windowHours <= 1 may pass
 * immediately (a smoke-shaped metric).
 */

import prisma from '../../../config/database';
// A8 (review 48d4763a): the params a probe can never match must be refused at
// filing — a typo'd kind/status counts 0 rows and `<= 0` would auto-verify.
// Both vocabularies are imported from import-free leaves (loop-metric-kinds,
// ticket-status): importing the owning SERVICES would drag their env-validating
// chains (logger/error-handler → config/env) into every Jest suite that touches
// this module, and env.ts process.exit(1)s a worker with no DATABASE_URL.
import { LOOP_METRIC_KINDS } from '../platform/loop-metric-kinds';
import { FEEDBACK_TYPES, FEEDBACK_STATUSES } from './ticket-status';
// ACCEPTANCE-METRIC-BASELINE (2026-10-20): the prisma-free half (kill
// switches, the regex-intent check, the auto-filers' default metrics) lives in
// the leaf so the sweeps can attach a default without importing prisma; it is
// re-exported here so every caller keeps one import path.
import { acceptanceBaselineGateDisabled, regexIntentOf } from './acceptance-metric-defaults';
export {
  acceptanceBaselineGateDisabled,
  autofilerDefaultMetricDisabled,
  regexIntentOf,
  AUTOFILER_DEFAULT_METRIC_SOURCE,
  DEFAULT_METRIC_WINDOW_HOURS,
  LOG_FRAGMENT_MIN,
  stableLiteralFragment,
  logSignalDefaultMetric,
  frameworkFindingDefaultMetric,
  healAutofilerDefaultMetric,
  designedAlarmOfMetric,
  designedAlarmOfFingerprint,
  designedObservabilityOfFingerprint,
} from './acceptance-metric-defaults';

/** Registered loop_metrics kinds (the closed set params.kind must name). */
const LOOP_METRIC_KIND_VALUES: readonly string[] = Object.values(LOOP_METRIC_KINDS);

export const ACCEPTANCE_PROBES = ['app_error_log_count', 'loop_metric_count', 'ticket_count'] as const;
export type AcceptanceProbe = (typeof ACCEPTANCE_PROBES)[number];

export const ACCEPTANCE_OPERATORS = ['<=', '==', '>='] as const;
export type AcceptanceOperator = (typeof ACCEPTANCE_OPERATORS)[number];

export const ACCEPTANCE_WINDOW_HOURS_MIN = 1;
export const ACCEPTANCE_WINDOW_HOURS_MAX = 24 * 7; // the "measure in 7 days" follow-up, owned automatically

/** Per-probe param keys (validated shape — unknown keys are refused). */
const PROBE_PARAMS: Readonly<Record<AcceptanceProbe, readonly string[]>> = {
  app_error_log_count: ['level', 'source', 'messagePattern', 'excludeLogClass'],
  loop_metric_count: ['kind', 'metaKey', 'metaValue'],
  ticket_count: ['type', 'status'],
};

/**
 * The logClass values an app_error_log_count bar may EXCLUDE (2026-11-01,
 * tickets 359c3a35 + b4bfd09a). The three-way log convention
 * (utils/log-level.ts) already separates "a dependency we do not control is
 * degraded" (logExternal → warn + logClass:'external') from "handled"
 * (logHandled → info, never persisted) from a genuine internal fault
 * (logger.error, untagged or logClass:'fault'). The hourly sweep honours that
 * split via isNonFaultLogRow — but the acceptance PROBE did not, so a ticket
 * whose own root cause was adjudicated EXTERNAL was still re-measured against
 * an internal-fault bar: every external row counted, the bar never fell, and
 * the verifier reopened the same ticket forever.
 *
 * Only the two non-fault classes are excludable, and the count is SUBTRACTIVE
 * (total − excluded; see evaluateAcceptanceMetric) so an UNTAGGED row — or one
 * tagged 'fault' — always counts. A filter that could exclude "everything
 * except external" would let a tag talk a real internal fault out of its own
 * acceptance test; this one cannot.
 */
export const EXCLUDABLE_LOG_CLASSES = ['external', 'handled'] as const;

/**
 * The loop_metrics meta keys a metric may filter on (ACCEPTANCE-METRIC-BASELINE,
 * 2026-10-20). Closed set: each is a small scalar the recording sites already
 * write (a classifier verdict, a seam, a fingerprint) — never a free-text blob.
 */
export const LOOP_METRIC_META_KEYS = [
  'class', 'fingerprint', 'reason', 'verdict', 'outcome', 'seam', 'strike', 'tool', 'kind',
  'source', 'phase', 'purpose', 'shape', 'mode', 'state', 'detector', 'marker', 'rule',
] as const;

export interface AcceptanceMetric {
  probe: AcceptanceProbe;
  params: Record<string, string>;
  operator: AcceptanceOperator;
  target: number;
  windowHours: number;
}

export type AcceptanceMetricVerdict =
  | { ok: true; metric: AcceptanceMetric }
  | { ok: false; message: string };

const PARAM_MAX = 200;
const LEVELS = ['error', 'warn'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate a metric from ANY untrusted input (the file_feedback tool args, a
 * stored context blob). Returns the normalized metric or a refusal message
 * that names exactly what to fix. Pure — no DB.
 * `opts.stored` (readAcceptanceMetric): a metric ALREADY on a row skips the
 * filing-time regex-intent refusal, so the verifier still sees it and rules it
 * vacuous (closes on the merged ∧ deployed bar) instead of leaving the row
 * unreadable in awaiting_verification forever.
 */
export function validateAcceptanceMetric(input: unknown, opts: { stored?: boolean } = {}): AcceptanceMetricVerdict {
  if (!isRecord(input)) return { ok: false, message: 'acceptanceMetric must be an object { probe, params, operator, target, windowHours }.' };
  const { probe, params, operator, target, windowHours } = input;
  if (typeof probe !== 'string' || !(ACCEPTANCE_PROBES as readonly string[]).includes(probe)) {
    return { ok: false, message: `acceptanceMetric.probe must be one of: ${ACCEPTANCE_PROBES.join(' | ')} (got ${JSON.stringify(probe)}).` };
  }
  const p = probe as AcceptanceProbe;
  if (!isRecord(params)) return { ok: false, message: 'acceptanceMetric.params must be an object.' };
  const allowed = PROBE_PARAMS[p];
  const outParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!allowed.includes(k)) return { ok: false, message: `acceptanceMetric.params for probe "${p}" allows only: ${allowed.join(' | ')} (got "${k}").` };
    if (typeof v !== 'string' || !v.trim()) return { ok: false, message: `acceptanceMetric.params.${k} must be a non-empty string.` };
    if (v.length > PARAM_MAX) return { ok: false, message: `acceptanceMetric.params.${k} must be ≤${PARAM_MAX} chars (got ${v.length}).` };
    outParams[k] = v.trim();
  }
  if (p === 'loop_metric_count' && !outParams.kind) {
    return { ok: false, message: 'acceptanceMetric: probe "loop_metric_count" requires params.kind (a registered loop_metrics kind).' };
  }
  // A8 (review 48d4763a): a typo'd param counts 0 rows and `<= 0` then PASSES —
  // a false deployed_verified. Refuse values the probes can never match: kind
  // must be a registered loop_metrics kind; level must be error|warn (below);
  // ticket_count's type/status must be real vocabulary. A refused filing is
  // correctable at filing time (the message names the allowed values).
  if (p === 'loop_metric_count' && !LOOP_METRIC_KIND_VALUES.includes(outParams.kind)) {
    return { ok: false, message: `acceptanceMetric.params.kind must be a registered loop_metrics kind (got "${outParams.kind.slice(0, 60)}") — see LOOP_METRIC_KINDS in loop-metrics.service.ts.` };
  }
  // ACCEPTANCE-METRIC-BASELINE: the meta filter is a PAIR from a closed key set.
  if (p === 'loop_metric_count' && (outParams.metaKey !== undefined || outParams.metaValue !== undefined)) {
    if (!outParams.metaKey || !outParams.metaValue) {
      return { ok: false, message: 'acceptanceMetric.params.metaKey and metaValue go together (a loop_metrics meta filter: meta[metaKey] == metaValue).' };
    }
    if (!(LOOP_METRIC_META_KEYS as readonly string[]).includes(outParams.metaKey)) {
      return { ok: false, message: `acceptanceMetric.params.metaKey must be one of: ${LOOP_METRIC_META_KEYS.join(' | ')} (got "${outParams.metaKey.slice(0, 60)}").` };
    }
  }
  if (p === 'app_error_log_count' && outParams.messagePattern && !opts.stored && !acceptanceBaselineGateDisabled()) {
    const intent = regexIntentOf(outParams.messagePattern);
    if (intent) {
      return { ok: false, message: `acceptanceMetric.params.messagePattern is matched as a case-insensitive LITERAL substring, never a regex — "${intent}" can only match itself, so the metric would count 0 rows and pass vacuously. Use ONE stable literal fragment of the log message (no |, backslash escapes, .*, ^, $, [a-z] ranges).` };
    }
  }
  if (p === 'ticket_count') {
    if (outParams.type && !(FEEDBACK_TYPES as readonly string[]).includes(outParams.type)) {
      return { ok: false, message: `acceptanceMetric.params.type must be one of: ${FEEDBACK_TYPES.join(' | ')} (got "${outParams.type.slice(0, 60)}").` };
    }
    if (outParams.status && !(FEEDBACK_STATUSES as readonly string[]).includes(outParams.status)) {
      return { ok: false, message: `acceptanceMetric.params.status must be one of: ${FEEDBACK_STATUSES.join(' | ')} (got "${outParams.status.slice(0, 60)}").` };
    }
  }
  if (p === 'app_error_log_count' && outParams.level && !LEVELS.includes(outParams.level)) {
    return { ok: false, message: `acceptanceMetric.params.level must be one of: ${LEVELS.join(' | ')} (got ${outParams.level}).` };
  }
  // A8's rule, applied to the logClass filter (2026-11-01, 359c3a35/b4bfd09a):
  // a typo'd class would exclude NOTHING and quietly restore the very
  // forever-reopen this param exists to fix, so it is refused at filing —
  // and only the non-fault classes are offered, so the filter can never be
  // aimed at 'fault' rows.
  if (p === 'app_error_log_count' && outParams.excludeLogClass && !(EXCLUDABLE_LOG_CLASSES as readonly string[]).includes(outParams.excludeLogClass)) {
    return { ok: false, message: `acceptanceMetric.params.excludeLogClass must be one of: ${EXCLUDABLE_LOG_CLASSES.join(' | ')} (got "${outParams.excludeLogClass.slice(0, 60)}"). Untagged and logClass:'fault' rows always count — the filter subtracts non-fault classes only, it can never hide an internal fault.` };
  }
  if (typeof operator !== 'string' || !(ACCEPTANCE_OPERATORS as readonly string[]).includes(operator)) {
    return { ok: false, message: `acceptanceMetric.operator must be one of: ${ACCEPTANCE_OPERATORS.join(' | ')} (got ${JSON.stringify(operator)}).` };
  }
  const tgt = target as unknown;
  if (typeof tgt !== 'number' || !Number.isInteger(tgt) || tgt < 0 || tgt > 1_000_000_000) {
    return { ok: false, message: `acceptanceMetric.target must be a non-negative integer (got ${JSON.stringify(tgt)}).` };
  }
  const wh = windowHours as unknown;
  if (typeof wh !== 'number' || !Number.isInteger(wh) || wh < ACCEPTANCE_WINDOW_HOURS_MIN || wh > ACCEPTANCE_WINDOW_HOURS_MAX) {
    return { ok: false, message: `acceptanceMetric.windowHours must be an integer ${ACCEPTANCE_WINDOW_HOURS_MIN}..${ACCEPTANCE_WINDOW_HOURS_MAX} (got ${JSON.stringify(wh)}).` };
  }
  return { ok: true, metric: { probe: p, params: outParams, operator: operator as AcceptanceOperator, target: tgt, windowHours: wh } };
}

/** A stored context blob → the metric, or null when absent/invalid (re-validated). */
export function readAcceptanceMetric(context: unknown): AcceptanceMetric | null {
  if (!isRecord(context) || !('acceptanceMetric' in context)) return null;
  const verdict = validateAcceptanceMetric((context as Record<string, unknown>).acceptanceMetric, { stored: true });
  return verdict.ok ? verdict.metric : null;
}

export interface AcceptanceMeasurement {
  /** false = the count could not be taken (DB error / bad shape) — NEVER a verdict. */
  measurable: boolean;
  ok?: boolean;
  measured?: number;
  detail: string;
}

function compare(operator: AcceptanceOperator, measured: number, target: number): boolean {
  if (operator === '<=') return measured <= target;
  if (operator === '>=') return measured >= target;
  return measured === target;
}

/**
 * Run the metric's bounded COUNT over [windowStart, now] and compare against
 * the target. windowStart is the CALLER's anchor — the post-deploy verifier
 * passes max(firstLiveAt, now − windowHours) so pre-deploy rows never count.
 * Never throws: a DB failure returns measurable:false (an unmeasurable
 * metric is waited on, never auto-reopened).
 */
export async function evaluateAcceptanceMetric(metric: AcceptanceMetric, windowStart: Date, windowEnd?: Date): Promise<AcceptanceMeasurement> {
  const exclude = metric.probe === 'app_error_log_count' ? metric.params.excludeLogClass : undefined;
  const shape = `${metric.probe} ${metric.operator} ${metric.target} over ${metric.windowHours}h${exclude ? ` (excluding logClass:'${exclude}')` : ''}`;
  // ACCEPTANCE-METRIC-BASELINE: a pattern with regex intent can only count
  // itself — UNMEASURABLE (the verifier waits; never a vacuous pass).
  const intent = metric.probe === 'app_error_log_count' && !acceptanceBaselineGateDisabled() ? regexIntentOf(metric.params.messagePattern) : null;
  if (intent) {
    return { measurable: false, detail: `${shape}: unmeasurable — messagePattern carries regex syntax "${intent}" but is matched as a literal substring (it can never count the intended rows)` };
  }
  try {
    let measured: number;
    const created = windowEnd ? { gte: windowStart, lte: windowEnd } : { gte: windowStart };
    if (metric.probe === 'app_error_log_count') {
      const base = {
        ...(metric.params.level ? { level: metric.params.level } : {}),
        ...(metric.params.source ? { source: metric.params.source } : {}),
        ...(metric.params.messagePattern ? { message: { contains: metric.params.messagePattern, mode: 'insensitive' as const } } : {}),
        createdAt: created,
      };
      measured = await prisma.appErrorLog.count({ where: base });
      // SUBTRACTIVE, never a Prisma `not` filter (2026-11-01, 359c3a35 +
      // b4bfd09a). `NOT context->>'logClass' = 'external'` is NULL-safe in
      // Prisma but excludes EVERY row whose context has no logClass at all —
      // i.e. it would silently drop the untagged logger.error rows that are
      // the actual internal faults, turning an internal-fault bar into a
      // no-op. Measured as (all matching rows) − (rows tagged the excluded
      // class), an untagged row and a logClass:'fault' row both stay in the
      // count by construction.
      if (exclude) {
        const excluded = await prisma.appErrorLog.count({
          where: { ...base, context: { path: ['logClass'], equals: exclude } },
        });
        measured = Math.max(0, measured - excluded);
      }
    } else if (metric.probe === 'loop_metric_count') {
      measured = await prisma.loopMetric.count({
        where: {
          kind: String(metric.params.kind),
          // ACCEPTANCE-METRIC-BASELINE: the allowlisted meta filter (JSON-path equality — parameterized, never code).
          ...(metric.params.metaKey && metric.params.metaValue ? { meta: { path: [metric.params.metaKey], equals: metric.params.metaValue } } : {}),
          createdAt: created,
        },
      });
    } else {
      measured = await prisma.userFeatureRequest.count({
        where: {
          ...(metric.params.type ? { type: metric.params.type } : {}),
          ...(metric.params.status ? { status: metric.params.status } : {}),
          updatedAt: created,
        },
      });
    }
    const ok = compare(metric.operator, measured, metric.target);
    return { measurable: true, ok, measured, detail: `${shape}: measured ${measured} since ${windowStart.toISOString()}${windowEnd ? ` until ${windowEnd.toISOString()}` : ''}` };
  } catch (err: any) {
    return { measurable: false, detail: `${shape}: unmeasurable (fail-safe — no verdict): ${String(err?.message ?? err).slice(0, 120)}` };
  }
}

// ── ACCEPTANCE-METRIC-BASELINE (2026-10-20) ─────────────────────────────────

export interface AcceptanceBaseline {
  /** false = the baseline could not be taken (DB error) — never treated as vacuous. */
  measurable: boolean;
  /** The probe's count over the pre-fix window (absent when unmeasurable / static). */
  baseline?: number;
  /** The metric already PASSES on the pre-fix window (or can never match) — it cannot prove a fix. */
  vacuous: boolean;
  windowStart: string;
  windowEnd: string;
  detail: string;
}

/**
 * The pre-fix window of a metric: [anchor − windowHours, anchor], where the
 * anchor is the ticket's filing time (the defect was observed then — the fix
 * cannot have shipped yet). Pure.
 */
export function baselineWindow(metric: AcceptanceMetric, anchor: Date): { start: Date; end: Date } {
  return { start: new Date(anchor.getTime() - metric.windowHours * 3600_000), end: anchor };
}

/**
 * Does a measured baseline make the metric vacuous — does it ALREADY pass on
 * the pre-fix window? For `<= T` / `== T` the baseline must exceed T (a
 * rare-event fix with target 0 qualifies on a baseline of 1); for `>= T` it
 * must sit below T. Pure.
 */
export function baselineIsVacuous(metric: AcceptanceMetric, baseline: number): boolean {
  return compare(metric.operator, baseline, metric.target);
}

/**
 * How old a baseline window may start and still be re-countable: the probes'
 * tables keep 30 days (loop_metrics LOOP_METRIC_RETENTION_DAYS; the
 * app_error_logs purge defaults to 30 days) — one day of margin. A window
 * starting earlier may already be purged, so its count is UNMEASURABLE, never
 * a vacuous 0 (review 2026-10-20).
 */
export const BASELINE_RETENTION_MS = 29 * 24 * 3600_000;
/** A baseline whose window ended longer ago than this is RETROSPECTIVE (not measured live at filing). */
export const BASELINE_LIVE_SLACK_MS = 10 * 60_000;

/**
 * Why a pre-fix window cannot be (re)counted honestly, or null. Pure.
 *   - ticket_count RETROSPECTIVELY: the probe filters on the row's CURRENT
 *     status and updatedAt, so tickets in the pre-fix window that were worked
 *     since drop out of it — a metric that measured failing at filing reads
 *     "vacuous" days later. Its baseline counts only LIVE (at filing).
 *   - a window starting beyond the probes' retention (rows may be purged).
 */
export function baselineUnmeasurableReason(metric: AcceptanceMetric, window: { start: Date; end: Date }, now: Date): string | null {
  if (metric.probe === 'ticket_count' && now.getTime() - window.end.getTime() > BASELINE_LIVE_SLACK_MS) {
    return 'a ticket_count baseline is measured only live at filing (the probe reads current status / updatedAt, so a retrospective count drops tickets worked since)';
  }
  if (now.getTime() - window.start.getTime() > BASELINE_RETENTION_MS) {
    return `the pre-fix window starts ${window.start.toISOString()}, beyond the ${Math.round(BASELINE_RETENTION_MS / 86_400_000)}-day row retention (rows may be purged)`;
  }
  return null;
}

/**
 * Measure the metric over its PRE-FIX window and say whether it is vacuous.
 * A regex-intent pattern is statically vacuous (no DB read). A DB failure —
 * or a window that cannot be recounted honestly (baselineUnmeasurableReason:
 * a retrospective ticket_count, a window past retention) — is
 * measurable:false, vacuous:false: the gate never drops or waives a metric it
 * could not measure. `now` is when the count runs (the filing gate passes the
 * anchor itself — a LIVE count). Never throws.
 */
export async function measureAcceptanceBaseline(metric: AcceptanceMetric, anchor: Date, now: Date = new Date()): Promise<AcceptanceBaseline> {
  const { start, end } = baselineWindow(metric, anchor);
  const base = { windowStart: start.toISOString(), windowEnd: end.toISOString() };
  const intent = metric.probe === 'app_error_log_count' ? regexIntentOf(metric.params.messagePattern) : null;
  if (intent) {
    return { measurable: true, vacuous: true, ...base, detail: `messagePattern carries regex syntax "${intent}" but is matched as a literal — it can never count the intended rows` };
  }
  const unmeasurable = baselineUnmeasurableReason(metric, { start, end }, now);
  if (unmeasurable) return { measurable: false, vacuous: false, ...base, detail: `baseline unmeasurable — ${unmeasurable}` };
  const m = await evaluateAcceptanceMetric(metric, start, end);
  if (!m.measurable || typeof m.measured !== 'number') {
    return { measurable: false, vacuous: false, ...base, detail: m.detail };
  }
  const vacuous = baselineIsVacuous(metric, m.measured);
  return {
    measurable: true,
    baseline: m.measured,
    vacuous,
    ...base,
    detail: vacuous
      ? `baseline ${m.measured} over the pre-fix window already meets "${metric.operator} ${metric.target}" — the metric cannot tell a fixed system from a broken one`
      : `baseline ${m.measured} over the pre-fix window fails "${metric.operator} ${metric.target}" — the metric can prove the fix`,
  };
}
