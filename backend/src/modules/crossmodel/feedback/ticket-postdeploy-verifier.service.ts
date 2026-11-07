/**
 * Post-deploy ticket verifier (ticket 6665fff6 — b4824553's lifecycle half).
 *
 * THE LOOP THIS CLOSES: a fix ticket carrying an acceptance metric is closed
 * by its lane into 'awaiting_verification' (the done-bar redirect in
 * platform-tools.ts update_feedback), and THIS job owns everything after:
 *   1. WAIT for the recorded fix to be live (merged ∧ deployed — the same
 *      positive fix-state proof the closure manifest uses, fix-state.ts).
 *      First live observation is stamped context.verification.firstLiveAt —
 *      the metric's ANCHOR: only rows created after it count.
 *   2. Re-measure the ticket's DECLARATIVE acceptance metric
 *      (ticket-metric.ts — allowlisted probe, parameterized counts, never
 *      code from ticket content).
 *   3. Rule — with monotonicity, because counts over a FIXED anchor only
 *      grow:
 *        - operator <= / == and measured ALREADY misses the target
 *          ⇒ REOPEN now (the final count can only be worse);
 *        - operator >= and measured ALREADY meets the target
 *          ⇒ DEPLOYED_VERIFIED now (the final count can only be better);
 *        - otherwise a pass needs the FULL window elapsed (a "count == 0
 *          over 24h" metric cannot honestly pass 10 minutes after deploy —
 *          windowHours <= 1 is smoke-shaped and may pass immediately);
 *        - otherwise WAIT (verdict 'waiting', no transition).
 *   4. Transition the ticket: 'deployed_verified' (terminal — merged ∧
 *      deployed ∧ metric re-measured passing, measured value attached) or
 *      'reopened' (work owed — the drain re-dispatches it; measured value
 *      attached). An UNMEASURABLE metric (DB error) is waited on, never
 *      auto-reopened — fail-safe, same contract as fix-state.
 *
 * This owns the "measure in 7 days" follow-ups automatically: windowHours is
 * the filer's declared window (≤168h), and the job simply keeps measuring
 * until it can rule.
 *
 * Run by the worker cron loop (worker.ts 'ticket-postdeploy-verifier', 900s,
 * kill switch TICKET_POSTDEPLOY_VERIFIER_DISABLED=1). Not volume-bound: it
 * reads Postgres only; the cron lease (cron.service.ts claimDueCronJob)
 * keeps a single box ruling at a time. Never throws — run…Once() returns a
 * ≤200-char pass summary for cron_jobs.lastStatus.
 *
 * ACCEPTANCE-METRIC-BASELINE (2026-10-20): before a metric may rule, it must
 * be able to FAIL — measured over its PRE-FIX window ([filedAt − windowHours,
 * filedAt]; the filing / close stamp is reused when present). A VACUOUS metric
 * (it already passes pre-fix, or its messagePattern carries regex syntax that
 * a literal match can never honor), or an auto-filer default the closing lane
 * waived (a false-positive / sibling close), never reaches deployed_verified
 * and never reopens: once the fix is live the ticket closes as plain 'done'
 * (merged ∧ deployed — the bar a metric-less ticket meets) with the reason in
 * the adminNote, verdict 'done_vacuous'. A waived close that recorded NO fix
 * commit closes done at once (no deploy to wait for). Kill switch
 * ACCEPTANCE_BASELINE_GATE_DISABLED=1 restores the pre-gate ruling.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import {
  readAcceptanceMetric,
  evaluateAcceptanceMetric,
  AcceptanceMetric,
  acceptanceBaselineGateDisabled,
  measureAcceptanceBaseline,
  regexIntentOf,
  healAutofilerDefaultMetric,
  healEmitterScopedPattern,
  fingerprintOfLogSignalTitle,
  designedAlarmOfMetric,
} from './ticket-metric';
import { parseClosureEvidenceNote, resolveFixStateFromEvidence } from './fix-state';

const SOURCE = 'ticket-postdeploy-verifier';
/** Verifier lookback for the board counts (loop_metrics GC window). */
export const VERIFIER_LOOKBACK_MS = 30 * 24 * 3600_000;

export type VerifierVerdict = 'waiting' | 'deployed_verified' | 'reopened' | 'unmeasurable' | 'skipped' | 'done_vacuous' | 'review_required';

/** The pre-fix baseline stamp (filing / close / verifier — ticket-metric.ts measureAcceptanceBaseline). */
interface BaselineStamp {
  baseline?: number | null;
  measurable?: boolean;
  vacuous?: boolean;
  windowStart?: string;
  windowEnd?: string;
  at?: string;
}

interface VerificationCtx {
  queuedAt?: string;
  queuedBy?: string;
  commitSha?: string;
  firstLiveAt?: string;
  lastVerdict?: string;
  lastVerdictAt?: string;
  lastMeasured?: number;
  lastDetail?: string;
  reopenedAt?: string;
  /** ACCEPTANCE-METRIC-BASELINE: the pre-fix baseline (stamped once). */
  baseline?: BaselineStamp;
  /** ACCEPTANCE-METRIC-BASELINE: an auto-filer default metric waived at close (false-positive / sibling close). */
  metricWaived?: { reason?: string; at?: string };
}

interface VerifierRow {
  id: string;
  type: string;
  status: string;
  priority: number;
  adminNote: string | null;
  userId: string | null;
  context: unknown;
  /** The filing time — the anchor of the metric's pre-fix baseline window. */
  createdAt?: Date | string;
  /** The stable `log-signal: <fingerprint>` title — carries the ticket's OWN
   *  emit-class fingerprint, which the emitter-scope heal needs (d634e874). */
  title?: string | null;
}

function verCtxOf(row: VerifierRow): VerificationCtx {
  const c = row.context as Record<string, unknown> | null;
  const v = c && typeof c === 'object' ? (c.verification as Record<string, unknown> | undefined) : undefined;
  return v && typeof v === 'object' ? (v as VerificationCtx) : {};
}

/** Record one telemetry row — fire-and-forget, never blocks a ruling. */
async function recordVerifierMetric(meta: Record<string, unknown>): Promise<void> {
  try {
    const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('../platform/loop-metrics.service');
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.TICKET_POSTDEPLOY_VERIFIER, meta });
  } catch { /* telemetry never blocks */ }
}

/** Smoke-shaped metrics (≤1h window) may pass immediately; longer windows must elapse. */
function windowElapsed(firstLiveAt: Date, windowHours: number, now: Date): boolean {
  return windowHours <= 1 || now.getTime() >= firstLiveAt.getTime() + windowHours * 3600_000;
}

/** Monotonicity over a fixed anchor: counts only grow, so an already-certain verdict rules now. */
function certainEarlyVerdict(metric: AcceptanceMetric, measured: number): 'pass' | 'fail' | null {
  if (metric.operator === '>=' && measured >= metric.target) return 'pass'; // can only grow
  if ((metric.operator === '<=' || metric.operator === '==') && measured > metric.target) return 'fail'; // cannot shrink
  return null;
}

/**
 * One ticket's ruling. Never throws; returns the verdict for the summary.
 * Exported for the unit tests (seeded rows, mocked fix-state).
 */
export async function verifyTicketRow(row: VerifierRow, now: Date = new Date()): Promise<VerifierVerdict> {
  const stored = readAcceptanceMetric(row.context);
  if (!stored) {
    // A row in awaiting_verification without a readable metric cannot be
    // ruled (the done-bar redirect only fires on metric-carrying rows, so
    // this is a hand-set or a corrupted context) — surface it, decide nothing.
    logger.warn(`${SOURCE}: ticket ${row.id} is awaiting_verification but carries no readable acceptance metric — leaving it for triage`, { source: SOURCE });
    await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'skipped', reason: 'no readable metric' });
    return 'skipped';
  }
  // HEAL (2026-11-01, tickets 359c3a35 + b4bfd09a): a stored auto-filer
  // default written before the logClass symmetry existed is re-measured
  // WITHOUT the exclusion it now implies, so the verifier would keep
  // reopening the ticket on rows the sweep itself already adjudicated
  // external. The heal is narrow (auto-filer-stamped, app_error_log_count,
  // no filter yet), carries an audit stamp into the ticket's context on the
  // next write, and never touches a hand-authored metric — a lane's own
  // judgement is not ours to rewrite.
  let metric = stored;
  const stCtx = (row.context && typeof row.context === 'object' ? row.context : {}) as Record<string, unknown>;
  const heal = healAutofilerDefaultMetric(stored, stCtx.acceptanceMetricSource);
  if (heal.healed) {
    metric = heal.metric;
    await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'metric_healed', probe: metric.probe, reason: 'autofiler-default predates the logClass exclusion' });
  }
  // EMITTER-SCOPE HEAL (d634e874, 2026-11-07): a stored auto-filer pattern
  // derived before the emitter scope existed counts EVERY seat role sharing the
  // `warnSeatFailure` template, so a fix that reduced its own emit class to one
  // row still fails the bar on other classes' rows. Re-scope it to the ticket's
  // own role from its stable title. Narrow (auto-filer-stamped,
  // app_error_log_count, fingerprint names an emitter, pattern not yet scoped) —
  // a hand-authored metric is never rewritten.
  const emitHeal = healEmitterScopedPattern(metric, stCtx.acceptanceMetricSource, fingerprintOfLogSignalTitle(row.title));
  if (emitHeal.healed) {
    metric = emitHeal.metric;
    await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'metric_rescoped', probe: metric.probe, reason: `autofiler-default pattern predates emitter scope (${emitHeal.role})` });
  }
  let ver = verCtxOf(row);
  const gateOn = !acceptanceBaselineGateDisabled();

  // ── Anchor: the first live observation stamps firstLiveAt ──
  let firstLiveAt = ver.firstLiveAt ? new Date(ver.firstLiveAt) : null;
  if (!firstLiveAt || Number.isNaN(firstLiveAt.getTime())) {
    const note = parseClosureEvidenceNote(row.adminNote);
    // ACCEPTANCE-METRIC-BASELINE (r2 interactions): a WAIVED auto-filer
    // metric on a close that recorded NO fix commit has no fix to wait for —
    // liveness needs a commitSha (fix-state), so the wait below could never
    // end and the row would sit in awaiting_verification forever (outside the
    // sweep dedupe and the family precision measure). Close it done now.
    if (gateOn && ver.metricWaived && typeof ver.metricWaived === 'object' && !note?.commitSha) {
      const vac = await metricVacuity(row, metric, ver, now);
      return closeVacuous(row, ver, metric, vac.reason, 'the close recorded no fix commit, so there is no deploy to wait for', now, 'Closed with no fix to deploy');
    }
    const fixState = await resolveFixStateFromEvidence({ id: row.id, userId: row.userId }, note ?? {});
    if (!fixState.fixLive) {
      // Merged-but-not-deployed (or unprovable): WAIT. One stamp per verdict
      // change only — a ticket waiting days for a wave writes two rows total,
      // not four per hour.
      if (ver.lastVerdict !== 'waiting') {
        await writeTicket(row, { verification: { ...ver, lastVerdict: 'waiting', lastVerdictAt: now.toISOString(), lastDetail: `fix not live yet — ${fixState.reason.slice(0, 160)}` } },
          `[post-deploy verifier (6665fff6)]: WAITING — the recorded fix is not live yet (${fixState.reason.slice(0, 160)}). The verifier re-measures the acceptance metric (${metric.probe} ${metric.operator} ${metric.target} over ${metric.windowHours}h) once the deploy wave lands and the boxes report it.`);
        await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'waiting', probe: metric.probe, reason: fixState.reason.slice(0, 120) });
      }
      return 'waiting';
    }
    // ACCEPTANCE-METRIC-BASELINE: the fix is live — a vacuous metric closes
    // on the merged ∧ deployed bar now, never enters a metric window.
    if (gateOn) {
      const vac = await metricVacuity(row, metric, ver, now);
      if (vac.vacuous) return closeVacuous(row, ver, metric, vac.reason, `fix live — ${fixState.reason.slice(0, 160)}`, now);
      if (vac.stamp) ver = { ...ver, baseline: vac.stamp };
    }
    firstLiveAt = now;
    await writeTicket(row, { verification: { ...ver, firstLiveAt: now.toISOString(), lastVerdict: 'waiting', lastVerdictAt: now.toISOString(), lastDetail: `fix live — ${fixState.reason.slice(0, 160)}` } },
      `[post-deploy verifier (6665fff6)]: fix is LIVE (merged ∧ deployed) — ${fixState.reason.slice(0, 160)}. Metric window anchored now (${metric.probe} ${metric.operator} ${metric.target} over ${metric.windowHours}h); the verdict lands when the window can rule.`);
    await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'waiting', probe: metric.probe, reason: 'first live observation — window anchored' });
    return 'waiting';
  }

  // ACCEPTANCE-METRIC-BASELINE: a row anchored before the gate existed (or
  // whose baseline was unmeasurable) is judged once here — a vacuous metric
  // never rules; the fix was live at anchoring, so it closes done.
  if (gateOn) {
    const vac = await metricVacuity(row, metric, ver, now);
    if (vac.vacuous) return closeVacuous(row, ver, metric, vac.reason, `fix live since ${firstLiveAt.toISOString()}`, now);
    if (vac.stamp) {
      ver = { ...ver, baseline: vac.stamp };
      await writeTicket(row, { verification: ver });
    }
  }

  // ── Measure over [anchor, now] and rule ──
  const measurement = await evaluateAcceptanceMetric(metric, firstLiveAt);
  if (!measurement.measurable) {
    if (ver.lastVerdict !== 'unmeasurable') {
      await writeTicket(row, { verification: { ...ver, lastVerdict: 'unmeasurable', lastVerdictAt: now.toISOString(), lastDetail: measurement.detail.slice(0, 200) } });
      await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'unmeasurable', probe: metric.probe, reason: measurement.detail.slice(0, 120) });
    }
    return 'unmeasurable'; // fail-safe: an unmeasurable metric NEVER auto-reopens
  }
  const measured = measurement.measured as number;
  const elapsed = windowElapsed(firstLiveAt, metric.windowHours, now);

  // Pass: measured ok AND (smoke window OR full window elapsed) — or an
  // already-certain >= pass. Fail: measured missing AND certain (monotonic)
  // — or the window elapsed with the target still missed.
  const early = certainEarlyVerdict(metric, measured);
  const pass = measurement.ok === true && (elapsed || early === 'pass');
  const fail = measurement.ok === false && (elapsed || early === 'fail');

  if (pass) {
    await writeTicket(row, {
      status: 'deployed_verified',
      priority: row.priority,
      verification: { ...ver, lastVerdict: 'deployed_verified', lastVerdictAt: now.toISOString(), lastMeasured: measured, lastDetail: measurement.detail.slice(0, 200) },
    }, `[post-deploy verifier (6665fff6)]: DEPLOYED_VERIFIED — merged ∧ deployed ∧ acceptance metric re-measured PASSING: ${measurement.detail}.`);
    await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'deployed_verified', probe: metric.probe, measured, target: metric.target });
    return 'deployed_verified';
  }
  if (fail) {
    // ── TICKET 1425001e (2026-11-01): AN UNSOUND PROBE MUST NOT REOPEN ────────
    // A FAIL here means one thing: the stored metric missed its bar. It does NOT
    // mean the fix was wrong — and for a DESIGNED-ALARM class the stored metric
    // cannot speak to the fix at all. Ticket 8b62e61e is the measured case: a
    // fix that NAMED a severed tool-call cut and deliberately KEPT the warn as
    // the alarm was filed with the sweep's default `<= 2` over its own
    // fingerprint, a probe that counts warn EMISSION at coding-model.ts:2145 —
    // a file its diff never touched. Measured 28 against a bar of 2, which
    // `certainEarlyVerdict` rules as a CERTAIN fail, so the next tick would
    // REOPEN a correct fix and the drain would dispatch a fresh lane onto a
    // non-defect. Reopening on an unprovable metric is not a stricter done-bar,
    // it is a wrong one.
    //
    // ROUTE, don't rule. The row stays in awaiting_verification (never a false
    // 'done' — nothing was verified), the dispatch claim is NOT released (no
    // fresh lane is invited), and the audit note is written ONCE (idempotent on
    // lastVerdict) so a row cannot churn a write per tick.
    //
    // GUARDRAILS — this must never be a lane's escape hatch from a real test:
    // designedAlarmOfMetric refuses an EXPLICITLY hand-authored metric (a
    // present marker other than the auto-filer's is the lane's judgement) and
    // matches the METRIC'S OWN messagePattern, never a close-out note's prose.
    // A real defect that a designed-alarm probe CAN falsify (measured <=
    // target) still passes and still closes deployed_verified, so detection is
    // not weakened.
    // TICKET dc4f7ff5 (2026-11-06) extends the same guard one class over:
    // DESIGNED OBSERVABILITY (a designed failover serving the call, a drop
    // guard discarding a misattributed claim). Rows stamped before that change
    // still carry the unattainable `<= N` bar, and the verifier is what
    // re-measures the STORED metric — so without this the live tickets
    // (3769b1b3, e35f9985) would keep reopening on correct fixes even after the
    // autofiler stops minting such bars.
    // TICKET 31199f81 (2026-11-06) closes the remaining hole: the guard used
    // to require source === 'autofiler-default', which made a MISSING marker
    // mean "hand-authored" — so a bar stamped before the marker existed (or by
    // a filer that never wrote one, exactly 3769b1b3's case) failed CLOSED and
    // was measured anyway, reopening a correct deployed fix at 13:32:39Z on
    // measured 1. Absence now says nothing: the metric's content decides, and
    // only an EXPLICIT marker opts a bar out. A lane's own metric is still
    // never redirected by this guard.
    const unsound = designedAlarmOfMetric(metric, stCtx.acceptanceMetricSource);
    if (unsound) {
      if (ver.lastVerdict !== 'review_required') {
        const remedy = unsound.class === 'designed-observability'
          ? 'A human/supervisor should replace it with a behavioural criterion for this class — for a DISCARD guard the honest bar is a replay pin (the guard still fires), never a row count, since the count tracks how often lanes misattribute, not whether the fix works. See context.verification.lastMeasured.'
          : 'A human/supervisor should replace it with a behavioural criterion — the loop_metric_count probe over kind tool_call_unrecovered_severance is the loss signal for this class (see context.verification.lastMeasured).';
        await writeTicket(row, {
          verification: { ...ver, lastVerdict: 'review_required', lastVerdictAt: now.toISOString(), lastMeasured: measured, lastDetail: `metric unsound for this fix class — ${unsound.id}`.slice(0, 200) },
        }, `[post-deploy verifier (6665fff6 + tickets 1425001e/dc4f7ff5)]: NEEDS METRIC REVIEW — the fix is deployed, but the acceptance metric (${metric.probe} ${metric.operator} ${metric.target} over ${metric.windowHours}h) measures a class that emits BY DESIGN, not the fix: ${unsound.why}. Measured ${measured}. This is NOT a reopen: a <= bar over such a class's volume cannot distinguish a fixed system from a broken one, so the metric was redirected instead. ${remedy}`);
        await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'review_required', probe: metric.probe, measured, target: metric.target, designedAlarm: unsound.id, unsoundClass: unsound.class });
      }
      return 'review_required';
    }
    // Release the (stale) dispatch claim so the drain re-dispatches the row
    // to a fresh lane — the reopen's whole point (fail-open: a release
    // failure must not block the reopen itself).
    try {
      const { releaseTicketDispatchClaim } = await import('./ticket-dispatch.service');
      await releaseTicketDispatchClaim(row.id);
    } catch { /* the drain's stale-reclaim still finds it */ }
    await writeTicket(row, {
      status: 'reopened',
      priority: Math.min(5, (row.priority ?? 0) + 1), // the reopen-on-recurrence bump
      verification: { ...ver, lastVerdict: 'reopened', lastVerdictAt: now.toISOString(), lastMeasured: measured, lastDetail: measurement.detail.slice(0, 200), reopenedAt: now.toISOString() },
    }, `[post-deploy verifier (6665fff6)]: REOPENED — the fix is deployed but the acceptance metric FAILED: ${measurement.detail}. The measured value is attached (context.verification.lastMeasured); the ticket re-enters the dispatch queue for a fresh lane.`);
    await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'reopened', probe: metric.probe, measured, target: metric.target });
    return 'reopened';
  }
  // Not yet rulable: keep measuring (no per-tick write — the anchor stamp
  // above already says the window is open).
  return 'waiting';
}

/**
 * ACCEPTANCE-METRIC-BASELINE: can this metric FAIL? Vacuous when the closing
 * lane waived an auto-filer default (verification.metricWaived), when its
 * messagePattern carries regex syntax a literal match never honors, or when a
 * MEASURED pre-fix baseline already passes it. Baseline precedence (review
 * 2026-10-20): the FILING stamp (context.acceptanceMetricBaseline — counted
 * LIVE when the defect was current) first, then the close stamp
 * (verification.baseline — a RETROSPECTIVE recount that rows worked or purged
 * since can only shrink), else measured now over [createdAt − windowHours,
 * createdAt]. A retrospective ticket_count or a window past retention is
 * unmeasurable (measureAcceptanceBaseline), and an unmeasurable baseline is
 * never vacuous (the metric rules as before). `stamp` = a fresh measurement
 * to persist (once). Never throws.
 */
async function metricVacuity(row: VerifierRow, metric: AcceptanceMetric, ver: VerificationCtx, now: Date): Promise<{ vacuous: boolean; reason: string; stamp?: BaselineStamp }> {
  try {
    if (ver.metricWaived && typeof ver.metricWaived === 'object') {
      return { vacuous: true, reason: `the closing lane recorded no defect for the auto-filer default metric to prove (${String(ver.metricWaived.reason ?? 'waived').slice(0, 120)})` };
    }
    const intent = metric.probe === 'app_error_log_count' ? regexIntentOf(metric.params.messagePattern) : null;
    if (intent) return { vacuous: true, reason: `messagePattern carries regex syntax "${intent}" but is matched as a literal substring — it can never count the intended rows` };
    const ctx = (row.context && typeof row.context === 'object' ? row.context : {}) as Record<string, unknown>;
    const known = [ctx.acceptanceMetricBaseline as BaselineStamp | undefined, ver.baseline]
      .find((b) => !!b && typeof b === 'object' && b.measurable === true && typeof b.vacuous === 'boolean');
    if (known) {
      return { vacuous: known.vacuous === true, reason: `baseline ${known.baseline ?? '?'} over the pre-fix window already meets "${metric.operator} ${metric.target}"` };
    }
    const created = row.createdAt instanceof Date ? row.createdAt : row.createdAt ? new Date(String(row.createdAt)) : null;
    if (!created || Number.isNaN(created.getTime())) return { vacuous: false, reason: 'no filing anchor' };
    const b = await measureAcceptanceBaseline(metric, created, now);
    if (!b.measurable) return { vacuous: false, reason: b.detail };
    return {
      vacuous: b.vacuous,
      reason: b.detail,
      stamp: { baseline: b.baseline ?? null, measurable: true, vacuous: b.vacuous, windowStart: b.windowStart, windowEnd: b.windowEnd, at: now.toISOString() },
    };
  } catch {
    return { vacuous: false, reason: 'baseline check failed (fail-safe — the metric rules as before)' };
  }
}

/** A vacuous metric with the fix LIVE (or, for a waived no-commit close, no fix at all): close as plain 'done', reason attached. */
async function closeVacuous(row: VerifierRow, ver: VerificationCtx, metric: AcceptanceMetric, reason: string, liveDetail: string, now: Date, bar = 'Closed on the merged ∧ deployed bar'): Promise<VerifierVerdict> {
  await writeTicket(row, {
    status: 'done',
    verification: { ...ver, lastVerdict: 'done_vacuous', lastVerdictAt: now.toISOString(), lastDetail: `${reason}`.slice(0, 200) },
  }, `[post-deploy verifier (6665fff6 + acceptance baseline)]: DONE (not deployed_verified) — ${liveDetail}, but the acceptance metric (${metric.probe} ${metric.operator} ${metric.target} over ${metric.windowHours}h) cannot prove the fix: ${reason}. ${bar}; no post-deploy measurement was taken.`);
  await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'done_vacuous', probe: metric.probe, reason: reason.slice(0, 120) });
  try {
    const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('../platform/loop-metrics.service');
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.ACCEPTANCE_METRIC_BASELINE, meta: { phase: 'verifier', ticketId: row.id.slice(0, 8), probe: metric.probe, operator: metric.operator, target: metric.target, vacuous: true, reason: reason.slice(0, 120) } });
  } catch { /* telemetry never blocks */ }
  return 'done_vacuous';
}

/**
 * Bounded write: status/priority/verification-context/adminNote-append. Fail-soft (non-fatal, next tick retries).
 *
 * TICKET 31199f81: `statusGuard` makes the write CONDITIONAL on the row still
 * being in that status. The sweep reads a snapshot and then writes row by row,
 * so without a guard the drain can legitimately reclaim a row in between
 * (ticket-dispatch claims `open`/`reopened` and sets `in_progress`) and this
 * write would clobber a LIVE dispatch — un-dispatching a running lane. Returns
 * whether the write landed.
 */
async function writeTicket(
  row: VerifierRow,
  changes: { status?: string; priority?: number; verification: VerificationCtx },
  noteAppend?: string,
  statusGuard?: string,
): Promise<boolean> {
  const ctx = { ...((row.context as Record<string, unknown> | null) ?? {}), verification: changes.verification } as Record<string, unknown>;
  const adminNote = noteAppend
    ? `${row.adminNote ? `${row.adminNote}\n` : ''}${noteAppend}`
    : row.adminNote ?? undefined;
  const data = {
    ...(changes.status ? { status: changes.status } : {}),
    ...(changes.priority !== undefined ? { priority: changes.priority } : {}),
    context: ctx as any,
    ...(adminNote !== undefined ? { adminNote } : {}),
  };
  try {
    if (statusGuard) {
      // Guarded write: only lands while the row is STILL where the snapshot saw it.
      const res = await prisma.userFeatureRequest.updateMany({ where: { id: row.id, status: statusGuard }, data });
      if (!res || res.count === 0) return false;
      return true;
    }
    await prisma.userFeatureRequest.update({ where: { id: row.id }, data });
    return true;
  } catch (err: any) {
    logger.warn(`${SOURCE}: write failed for ticket ${row.id} (non-fatal, retried next tick): ${err?.message ?? err}`, { source: SOURCE });
    return false;
  }
}

/**
 * TICKET 31199f81 (2026-11-06) — RE-RULE A ROW THIS JOB ITSELF WRONGLY REOPENED.
 *
 * Why a second pass exists at all: the sweep below reads ONLY
 * `awaiting_verification`, so a row the verifier already moved to `reopened`
 * is out of reach — and `reopened` IS an open status (ticket-status.ts
 * OPEN_TICKET_STATUSES), so the drain will dispatch a fresh lane onto it. That
 * is the measured harm: 3769b1b3 was reopened at 13:32:39Z on measured 1 (one
 * residual row from its own deployed fix's 15 s leg cap working), the guard
 * that should have redirected it failed closed on a missing provenance marker,
 * and nothing in this job could ever revisit the verdict.
 *
 * Scope is deliberately the narrowest shape that closes the loop:
 *   - ONLY rows the VERIFIER reopened (`verification.reopenedAt` +
 *     lastVerdict 'reopened') — a human/lane reopen is theirs, never ours;
 *   - ONLY when the stored metric's OWN CONTENT classifies as unsound
 *     (designedAlarmOfMetric — no measurement, no DB count, no metadata);
 *   - the landing state is exactly what the correct predicate would have
 *     produced at reopen time: back to `awaiting_verification` parked on
 *     `review_required` (never a false 'done' — nothing was verified), which
 *     also takes the row OUT of the dispatch queue so no fresh lane is
 *     invited onto a non-defect.
 * The priority bump the reopen applied is left in place: the row still owes a
 * human a metric decision, and silently lowering it would hide that.
 *
 * Idempotent: the row leaves `reopened`, so the pass cannot see it again.
 * Never throws. Exported for the tests.
 */
export async function redirectWronglyReopenedRow(row: VerifierRow, now: Date = new Date()): Promise<'redirected' | 'kept' | 'skipped'> {
  const ver = verCtxOf(row);
  if (!ver.reopenedAt || ver.lastVerdict !== 'reopened') return 'skipped';
  const stored = readAcceptanceMetric(row.context);
  if (!stored) return 'skipped';
  const stCtx = (row.context && typeof row.context === 'object' ? row.context : {}) as Record<string, unknown>;
  const unsound = designedAlarmOfMetric(stored, stCtx.acceptanceMetricSource);
  if (!unsound) return 'kept'; // a real metric failure stays reopened — detection is not weakened
  const remedy = unsound.class === 'designed-observability'
    ? 'A human/supervisor should replace it with a behavioural criterion for this class — for a failover or a DISCARD guard the honest bar is a replay pin (the guard still fires), never a row count.'
    : 'A human/supervisor should replace it with a behavioural criterion — the loop_metric_count probe over kind tool_call_unrecovered_severance is the loss signal for this class.';
  const landed = await writeTicket(row, {
    status: 'awaiting_verification',
    verification: { ...ver, lastVerdict: 'review_required', lastVerdictAt: now.toISOString(), lastDetail: `metric unsound for this fix class — ${unsound.id} (reopen withdrawn)` },
  }, `[post-deploy verifier (6665fff6 + tickets 1425001e/dc4f7ff5/31199f81)]: REOPEN WITHDRAWN — this ticket had been reopened on its acceptance metric (${stored.probe} ${stored.operator} ${stored.target} over ${stored.windowHours}h), but that metric measures a class that emits BY DESIGN, not the fix: ${unsound.why}. A <= bar over such a class's volume cannot distinguish a fixed system from a broken one, so the reopen is withdrawn and the row is parked for metric review instead — no fresh lane is dispatched onto a non-defect. ${remedy}`,
  // The drain may have reclaimed this row between the snapshot and here.
  'reopened');
  if (!landed) return 'skipped'; // a live dispatch now owns it — never clobber it
  await recordVerifierMetric({ ticketId: row.id.slice(0, 8), verdict: 'review_required', probe: stored.probe, designedAlarm: unsound.id, unsoundClass: unsound.class, reason: 'reopen withdrawn (31199f81)' });
  return 'redirected';
}

/**
 * The cron entry point. Never throws; returns a ≤200-char summary for
 * cron_jobs.lastStatus. Kill switch: TICKET_POSTDEPLOY_VERIFIER_DISABLED=1.
 */
export async function runTicketPostdeployVerifierOnce(): Promise<string> {
  if (process.env.TICKET_POSTDEPLOY_VERIFIER_DISABLED === '1') return 'disabled (kill switch)';
  const now = new Date();
  try {
    // TICKET 31199f81: withdraw a reopen THIS job recorded against a metric it
    // now knows could never speak to the fix (see redirectWronglyReopenedRow).
    // Bounded and fail-soft — a repair pass must never break the sweep below.
    let withdrawn = 0;
    try {
      const reopened = (await prisma.userFeatureRequest.findMany({
        where: { status: 'reopened' },
        orderBy: [{ priority: 'desc' }, { updatedAt: 'asc' }],
        take: 20, // bounded per tick; leftovers ride the next tick
        select: { id: true, type: true, status: true, priority: true, adminNote: true, userId: true, context: true, createdAt: true, title: true },
      }) ?? []) as unknown as VerifierRow[];
      for (const r of reopened) {
        if ((await redirectWronglyReopenedRow(r, now)) === 'redirected') withdrawn++;
      }
    } catch (err: any) {
      logger.warn(`${SOURCE}: reopen-withdrawal pass failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    }
    const rows = (await prisma.userFeatureRequest.findMany({
      where: { status: 'awaiting_verification' },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'asc' }],
      take: 50, // bounded per tick; leftover rows ride the next tick
      select: { id: true, type: true, status: true, priority: true, adminNote: true, userId: true, context: true, createdAt: true, title: true },
    }) ?? []) as unknown as VerifierRow[];
    if (!rows.length) {
      return `${withdrawn ? `${withdrawn} reopen(s) withdrawn: ` : ''}no tickets awaiting verification`.slice(0, 200);
    }
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const verdict = await verifyTicketRow(row, now);
      counts[verdict] = (counts[verdict] ?? 0) + 1;
    }
    const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ');
    logger.info(`${SOURCE}: ${rows.length} ticket(s): ${summary}${withdrawn ? `; ${withdrawn} reopen(s) withdrawn` : ''}`, { source: SOURCE });
    return `${rows.length} verified: ${summary}${withdrawn ? `; ${withdrawn} reopen(s) withdrawn` : ''}`.slice(0, 200);
  } catch (err: any) {
    logger.warn(`${SOURCE}: sweep failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
    return `sweep failed (non-fatal): ${String(err?.message ?? err).slice(0, 140)}`;
  }
}

/**
 * The supervisor board's done-bar line (6665fff6): deployed-verified count,
 * awaiting-verification rows split by merged-not-deployed vs waiting-wave,
 * verifier-reopened count, and flagged fix tickets missing a metric. Absent
 * (null) when everything is zero — a healthy board carries no extra line.
 * Never throws. Exported for board-digest.service.ts (the capacity-line
 * pattern) and the unit tests.
 */
export async function ticketDoneBarBoardLine(now: Date = new Date()): Promise<string | null> {
  try {
    const lookback = new Date(now.getTime() - VERIFIER_LOOKBACK_MS);
    const rows = (await prisma.userFeatureRequest.findMany({
      where: {
        OR: [
          { status: 'deployed_verified' },
          { status: 'awaiting_verification' },
          { status: 'reopened' },
        ],
      },
      select: { id: true, status: true, context: true, updatedAt: true },
      take: 400,
    })) as Array<{ id: string; status: string; context: unknown; updatedAt: Date }>;
    const deployedVerified = rows.filter((r) => r.status === 'deployed_verified' && r.updatedAt >= lookback).length;
    const awaiting = rows.filter((r) => r.status === 'awaiting_verification');
    const notDeployed = awaiting.filter((r) => {
      const v = (r.context as Record<string, unknown> | null)?.verification as Record<string, unknown> | undefined;
      return !(v && typeof v.firstLiveAt === 'string');
    }).length;
    // TICKET 1425001e (2026-11-01): a row parked on 'review_required' needs
    // HUMAN metric surgery — its metric measured a designed alarm and cannot
    // prove the fix. It deliberately stays in awaiting_verification (that is
    // the point: never a false 'done'), but counting it as "in metric window"
    // would render it HEALTHY-waiting and nothing would ever surface it. Named
    // separately so the board says what it needs.
    const reviewRequired = awaiting.filter((r) => {
      const v = (r.context as Record<string, unknown> | null)?.verification as Record<string, unknown> | undefined;
      return v?.lastVerdict === 'review_required';
    }).length;
    const waitingWave = awaiting.length - notDeployed - reviewRequired;
    const reopenedByVerifier = rows.filter((r) => {
      if (r.status !== 'reopened' || r.updatedAt < lookback) return false;
      const v = (r.context as Record<string, unknown> | null)?.verification as Record<string, unknown> | undefined;
      return !!(v && typeof v.reopenedAt === 'string');
    }).length;
    const missingMetric = (await prisma.userFeatureRequest.count({
      where: {
        source: 'agent',
        type: { in: ['bug_report', 'mishap', 'enhancement'] },
        status: { in: ['open', 'in_progress', 'queued', 'reopened'] },
        context: { path: ['acceptanceMetricMissing'], equals: true },
      },
    }).catch(() => 0)) as number;
    if (!deployedVerified && !awaiting.length && !reopenedByVerifier && !missingMetric) return null;
    const parts = [
      deployedVerified ? `${deployedVerified} deployed-verified` : null,
      notDeployed ? `${notDeployed} fix-not-yet-live (merge/deploy pending)` : null,
      waitingWave ? `${waitingWave} in metric window` : null,
      reviewRequired ? `${reviewRequired} awaiting metric review (probe measures a designed alarm, not the fix — ticket 1425001e)` : null,
      reopenedByVerifier ? `${reopenedByVerifier} reopened by verifier (metric failed)` : null,
      missingMetric ? `${missingMetric} fix ticket(s) missing an acceptance metric (flagged at filing)` : null,
    ].filter(Boolean);
    return `TICKET DONE-BAR (6665fff6): ${parts.length ? parts.join(' · ') : 'all clear'}.`;
  } catch {
    return null; // a board line is never load-bearing for the wake
  }
}
