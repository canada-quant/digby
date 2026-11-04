/**
 * Decision gate — the FLIP-READINESS JOB (E1 in-process, 2026-09-25).
 *
 * WHY: the E1 ruler (`npm run decision-gate:fit -- --stamp`) could not run in
 * production — the backend image carries neither scripts/ nor tsx, so the
 * checkers had to transpile the script by hand into a throwaway container
 * (live defect 2026-09-25). The report the CLI prints is now computed
 * IN-PROCESS by the worker's durable cron tier: the `decision-gate-readiness`
 * job (worker.ts CRON_JOBS; DECISION_GATE_READINESS_INTERVAL_MIN, default
 * 360) reads the window's loop_metrics decision_gate rows, builds the very
 * same artifacts the CLI does (`buildReadinessArtifacts`, one pure builder for
 * both), and
 *
 *   1. writes the stamp ['instance','decision-gate'] / 'readiness' →
 *      { <purpose>: { ready, at, metrics, backend, reasons, windowDays, partition } }
 *      for EVERY ACT_POLICIES purpose (24 as of 2026-10-20) — the E12 admission contract — so an
 *      admin act flip is admitted the moment a purpose's bars hold, with no
 *      human running anything;
 *   2. stores the full report under 'readiness-report' (computedAt, every
 *      (backend, purpose) entry, the temperature fits) — what the admin
 *      GET /admin/model-roles/decision-readiness returns (it never recomputes);
 *   3. records ONE loop_metrics row per purpose, kind `decision_gate_readiness`,
 *      meta { purpose, backend, ready, labels, spanDays, auroc, coverage5,
 *      bandN, bandPrecision, reasons } — the chartable readiness history.
 *
 * ONE process: the cron_jobs Postgres lease means one worker claims a firing
 * fleet-wide (box A's cron-only worker or box C's — never both), and the web
 * backends never run the cron loop. DB-only, no volume — NOT volume-bound.
 *
 * FAIL-OPEN + WRITE-ON-SUCCESS-ONLY: any failure (query, compute, store)
 * logs a warning and writes NOTHING (no stamp, no report, no metrics rows)
 * — a stale stamp is judged by DECISION_GATE_READINESS_MAX_AGE_DAYS on the
 * admission side, and readers already fail closed. The job never throws.
 *
 * KILL SWITCH: DECISION_GATE_READINESS_JOB_DISABLED=1 (checked in the worker
 * handler AND here — the MEMORY_DREAM_DISABLED pattern). No purpose is ever
 * moved to act by this job; it only produces the evidence the admin flip is
 * admitted against.
 *
 * 2026-09-26 (open-weight decision backends, plan D/E): the pass reads the
 * store's fitted temperatures (backends row `temps`) and the per-purpose
 * CONFIGURED primary (decision-gate-modes resolveDecisionPrimarySpec — the
 * backends module registers the resolver; unregistered = "most labelled rows"
 * as before), builds the artifacts with both, and writes, in this order:
 *   0. the AUTOFIT temperatures (`temps`) — ONLY when the autofit is opted in
 *      (DECISION_GATE_TEMP_AUTOFIT_ENABLED=1; _DISABLED=1 is the hard kill
 *      switch; unset = the fits are reported, never stored, so nothing
 *      becomes calibrated behind the owner's back — review 2026-09-26) and a
 *      fit moved. FIRST, so the stamp below never claims a calibration that
 *      is not in force: a failed temps write is fail-open — logged, recorded
 *      on the report as tempsWriteError, retried next pass — and the
 *      artifacts are rebuilt WITHOUT the merge before anything else is written;
 *   1. the stamp; 2. the report (tempsWritten / autofitEnabled are the truth);
 *   3. ONE decision_gate_readiness row per REPORT ENTRY (purpose ×
 *      backendSpec, with its role primary | challenger | fallback and the
 *      calls / fail-rate / p50 / p95 comparison numbers), not one per purpose.
 * Rows of the admin Test button's `probe` purpose never enter the report, the
 * stamp or the metric rows.
 *
 * 2026-09-26 (Laya follow-up): after every pass the job also PRUNES the
 * sampled-state corpus — loop_metrics kind 'decision_gate_state' rows older
 * than DECISION_GATE_STATE_RETENTION_DAYS (default 28, clamped 1..365) — with
 * ONE indexed deleteMany on (kind, createdAt) (the kind is opt-in sampled
 * and small; the generic 30-day loop-metrics sweep would drop it too, this
 * one just keeps the corpus tighter). Own try/catch: a prune failure is
 * logged and never fails the pass.
 */

import os from 'os';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { ACT_POLICIES, type ReadinessEntry, type ReadinessRow } from './decision-gate-fit';
import {
  READINESS_JOB_ID, buildReadinessArtifacts, readStoredBackendTemps, readinessJobDisabled, readinessWindowDays, tempAutofitDisabled, tempAutofitEnabled,
  writeLatestReadinessReport, writeReadinessStamp, writeStoredBackendTemps, type PrimaryByPurpose, type PurposeReadiness, type ReadinessStamp, type StoredReadinessReport,
} from './decision-gate-readiness';
import { resolveDecisionPrimarySpec } from './decision-gate-modes';
import { registerDecisionPrimaryResolver } from './decision-gate-backends';
import { recordLoopMetrics, type LoopMetricInput } from './loop-metrics.service';

// Integration seam (a) (2026-09-26): the WORKER process runs this job, and nothing
// guarantees decision-gate.ts (whose import graph registers the backends module's
// resolver) has loaded there before the first pass. Registering explicitly at load
// makes `resolvePrimaryByPurpose` deterministic in every process: the stamp follows
// the CONFIGURED primary (decision-gate-backends resolveEffectivePrimarySpec — the
// stored per-purpose primary, else the decision seat). Idempotent; tests replace the
// resolver per case via setDecisionPrimaryResolver (a null resolver = "most labelled
// rows", the pre-change stamp).
registerDecisionPrimaryResolver();

export const READINESS_METRIC_KIND = 'decision_gate_readiness';

/** The sampled-state kind this job prunes (decision-gate.ts DECISION_GATE_STATE_KIND — mirrored so the worker never imports the gate). */
export const DECISION_GATE_STATE_KIND = 'decision_gate_state';
export const STATE_RETENTION_DEFAULT_DAYS = 28;

/** DECISION_GATE_STATE_RETENTION_DAYS (default 28, clamped 1..365) — sampled-state rows older than this are pruned. */
export function stateRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DECISION_GATE_STATE_RETENTION_DAYS);
  if (!Number.isFinite(n) || n <= 0) return STATE_RETENTION_DEFAULT_DAYS;
  return Math.min(365, Math.max(1, Math.round(n)));
}

/**
 * Delete 'decision_gate_state' rows older than the retention (one indexed
 * deleteMany on kind + createdAt). Never throws; returns the number deleted
 * (0 on failure — logged).
 */
export async function pruneDecisionGateStateRows(now: Date = new Date()): Promise<number> {
  try {
    const cutoff = new Date(now.getTime() - stateRetentionDays() * 86_400_000);
    const del = await prisma.loopMetric.deleteMany({ where: { kind: DECISION_GATE_STATE_KIND, createdAt: { lt: cutoff } } });
    const count = Number(del?.count ?? 0) || 0;
    if (count) logger.info(`${READINESS_JOB_ID}: pruned ${count} sampled-state row(s) older than ${stateRetentionDays()} d`);
    return count;
  } catch (err: any) {
    logger.warn(`${READINESS_JOB_ID}: sampled-state prune failed (non-fatal): ${err?.message || err}`);
    return 0;
  }
}

/** Bounded read: the window's decision_gate rows (a 14-day window is ~10⁴–10⁵ rows today; 2026-09-26: raised 250k → 400k so shadow challenger rows — one extra decision row per challenger per ask — cannot push the primary's rows past the cap). */
export const READINESS_ROW_CAP = 400_000;

const finite = (n: unknown): number | null => (typeof n === 'number' && Number.isFinite(n) ? n : null);

/** The optional 2026-09-26 fields a metric row carries when the entry has them (a stamp entry has none — its shape is unchanged). */
type MetricRowExtras = Partial<Pick<ReadinessEntry, 'backendSpec' | 'role' | 'kind' | 'calibrated' | 'segment'>> & { metrics: PurposeReadiness['metrics'] & Partial<Pick<ReadinessEntry['metrics'], 'calls' | 'fails' | 'failRate' | 'p50Ms' | 'p95Ms'>> };

/** Pure: one purpose's stamp entry (or a report entry, see readinessMetricRowForEntry) → its `decision_gate_readiness` loop_metrics row (value 1 = ready, 0 = not). */
export function readinessMetricRow(purpose: string, e: PurposeReadiness & MetricRowExtras): LoopMetricInput {
  const m = e.metrics;
  return {
    kind: READINESS_METRIC_KIND,
    value: e.ready ? 1 : 0,
    meta: {
      purpose,
      backend: e.backend,
      ...(e.backendSpec ? { backendSpec: e.backendSpec } : {}),
      ...(e.role ? { role: e.role } : {}),
      // 2026-09-26 (audit): a non-human segment entry's row names its partition (two rows per purpose × backend otherwise read alike).
      ...(e.segment ? { segment: e.segment } : {}),
      ...(e.kind ? { kind: e.kind } : {}),
      ...(typeof e.calibrated === 'boolean' ? { calibrated: e.calibrated } : {}),
      ready: e.ready,
      labels: m.n,
      spanDays: finite(m.days),
      auroc: finite(m.auroc),
      coverage5: finite(m.coverageAt5?.coverage),
      bandN: m.actBand?.n ?? 0,
      bandPrecision: finite(m.actBand?.precision),
      bandLower95: finite(m.actBand?.lower95),
      ...(typeof m.calls === 'number' ? { calls: m.calls, fails: m.fails ?? 0, failRate: finite(m.failRate), p50Ms: finite(m.p50Ms), p95Ms: finite(m.p95Ms) } : {}),
      // budgets-cost-6 (2026-09-26): the silent-degradation counters ride the chartable row too (per entry; the stamp
      // carries the per-purpose sum as `health`).
      ...(typeof m.downgraded === 'number' ? { downgraded: m.downgraded, fellThrough: m.fellThrough ?? 0, latched: m.latched ?? 0 } : {}),
      reasons: e.reasons.slice(0, 12),
      windowDays: e.windowDays,
      partition: e.partition,
    },
  };
}

/** Pure: one REPORT entry (purpose × backendSpec, with its role) → its metric row (plan E, 2026-09-26). */
export function readinessMetricRowForEntry(e: ReadinessEntry, windowDays: number, at: Date): LoopMetricInput {
  return readinessMetricRow(e.purpose, {
    ready: e.ready, at: at.toISOString(), metrics: e.metrics, backend: e.backend, reasons: e.reasons, windowDays, partition: e.metrics.partition,
    backendSpec: e.backendSpec, role: e.role, kind: e.kind, calibrated: e.calibrated, segment: e.segment,
  });
}

/** Pure: the whole stamp → its metric rows, purposes sorted for a stable write order (one per purpose — the pre-2026-09-26 shape; the job now writes one per report entry, see readinessMetricRowsForEntries). */
export function readinessMetricRows(stamp: ReadinessStamp): LoopMetricInput[] {
  return Object.keys(stamp).sort().map(p => readinessMetricRow(p, stamp[p]));
}

/** Pure: every report entry → its metric row, sorted (purpose, primary first, then challengers, then fallbacks, then most labels) for a stable write order. */
export function readinessMetricRowsForEntries(entries: ReadonlyArray<ReadinessEntry>, windowDays: number, at: Date): LoopMetricInput[] {
  const rank = (r: ReadinessEntry['role']): number => (r === 'primary' ? 0 : r === 'challenger' ? 1 : 2);
  return [...entries]
    .sort((a, b) => a.purpose.localeCompare(b.purpose) || rank(a.role) - rank(b.role) || b.metrics.n - a.metrics.n || a.backendSpec.localeCompare(b.backendSpec))
    .map(e => readinessMetricRowForEntry(e, windowDays, at));
}

/** The configured primary per ACT_POLICIES purpose through the registered resolver (fail-open: an unregistered / failing resolver yields no entry — the stamp then follows the most labelled rows). */
export async function resolvePrimaryByPurpose(): Promise<PrimaryByPurpose> {
  const out: Record<string, string | undefined> = {};
  for (const p of Object.keys(ACT_POLICIES)) {
    try {
      const spec = await resolveDecisionPrimarySpec(p);
      if (spec) out[p] = spec;
    } catch { /* fail-open */ }
  }
  return out;
}

export interface ReadinessJobOptions {
  now?: Date;
  /** Override the window (tests); default readinessWindowDays(). */
  windowDays?: number;
  workerId?: string;
  /** 2026-09-26: the configured primary per purpose (tests / the merge agent); default: the registered resolver (decision-gate-modes), else none. */
  primaryByPurpose?: PrimaryByPurpose;
}

/**
 * One pass. Returns a ≤200-char one-line summary for cron_jobs.lastStatus
 * ('disabled' / 'failed: …' / 'rows N, purposes M, ready K, stamped …').
 * NEVER throws.
 */
export async function runDecisionGateReadinessOnce(opts: ReadinessJobOptions = {}): Promise<string> {
  if (readinessJobDisabled()) return 'disabled (DECISION_GATE_READINESS_JOB_DISABLED)';
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? readinessWindowDays();
  const t0 = Date.now();
  try {
    const since = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
    const rows = (await prisma.loopMetric.findMany({
      where: { kind: 'decision_gate', createdAt: { gte: since, lte: now } },
      // `value` = the decision row's latency (plan E: p50 / p95 per backend).
      select: { meta: true, createdAt: true, sessionId: true, value: true },
      orderBy: { createdAt: 'asc' },
      take: READINESS_ROW_CAP,
    })) as ReadinessRow[];
    // 2026-09-26: the fitted temperatures in force + the configured primaries (both fail-open to "none").
    const temps = await readStoredBackendTemps();
    const primaryByPurpose = opts.primaryByPurpose ?? await resolvePrimaryByPurpose();
    // The temps autofit is OPT-IN (review 2026-09-26): unset, the fits are computed and
    // reported but never merged — the entries' calibration verdicts then match the runtime.
    const autofitEnabled = tempAutofitEnabled();
    const buildOpts = { days: windowDays, env: process.env as Record<string, string | undefined>, now, temps, primaryByPurpose };
    let art = buildReadinessArtifacts(rows, { ...buildOpts, autofit: autofitEnabled });
    // Writes happen only once EVERYTHING computed cleanly: the autofit temps
    // FIRST (opt-in, only when a fit moved) so the stamp never claims a
    // calibration that is not in force — a failure here is fail-open (logged,
    // recorded on the report, retried next pass) and the artifacts are rebuilt
    // without the merge; then the stamp (the admission read), the report (the
    // admin readout — it records whether the temps landed), the metric rows.
    // A throw in the compute above leaves the store untouched.
    const tempsAttempted = art.tempsChanged;
    let tempsWritten = false;
    let tempsWriteError: string | undefined;
    if (autofitEnabled && tempsAttempted.length > 0) {
      try {
        await writeStoredBackendTemps(art.temps, { changed: tempsAttempted, at: now });
        tempsWritten = true;
      } catch (err: any) {
        tempsWriteError = String(err?.message || err).slice(0, 300);
        logger.warn(`${READINESS_JOB_ID}: temps autofit write failed — ${tempsWriteError} (stamp + report written WITHOUT the merge; retried next pass)`);
        art = buildReadinessArtifacts(rows, { ...buildOpts, autofit: false });
      }
    }
    await writeReadinessStamp(art.stamp);
    const report: StoredReadinessReport = {
      computedAt: now.toISOString(),
      windowDays,
      rows: rows.length,
      durationMs: Date.now() - t0,
      entries: art.entries,
      fits: art.fits,
      stampWritten: true,
      workerId: opts.workerId ?? `worker-${os.hostname()}-${process.pid}`,
      temps: art.temps,
      tempsChanged: tempsAttempted,
      tempsWritten,
      autofitEnabled,
      ...(tempsWriteError ? { tempsWriteError } : {}),
      primaryByPurpose: { ...primaryByPurpose },
    };
    await writeLatestReadinessReport(report);
    recordLoopMetrics(readinessMetricRowsForEntries(art.entries, windowDays, now));
    const purposes = Object.keys(art.stamp);
    const ready = purposes.filter(p => art.stamp[p].ready);
    // The autofit line: what was stored, or — when opted out — how many ready fits are waiting and which switch holds them.
    const writableFits = art.fits.filter(f => f.autofit).length;
    const autofitNote = autofitEnabled
      ? (tempsAttempted.length ? `, temps ${tempsWritten ? 'fitted' : `write FAILED (${tempsWriteError})`} ${tempsAttempted.length}` : '')
      : (writableFits ? `, autofit off (${writableFits} ready fit(s) reported, not stored — ${tempAutofitDisabled() ? 'DECISION_GATE_TEMP_AUTOFIT_DISABLED' : 'set DECISION_GATE_TEMP_AUTOFIT_ENABLED=1'})` : '');
    // 2026-10-04: the DURABLE act-band auto-demote rides the same rows (the per-process window is wiped by every
    // deploy — decision-gate-durable-demote.ts). Own try/catch; never fails the pass.
    let durableNote = '';
    try {
      const { runDurableActBandDemote } = await import('./decision-gate-durable-demote');
      const { getDecisionModeConfig } = await import('./decision-gate-modes');
      const cfg = await getDecisionModeConfig();
      const actPurposes = cfg.purposes.filter((x) => x.effective === 'act').map((x) => x.purpose as string);
      const demoted = await runDurableActBandDemote(rows, actPurposes);
      if (demoted.length) durableNote = `, durable act-band: ${demoted.map((d) => `${d.purpose} ${d.outcome} (n_act ${d.n}, precision ${d.precision.toFixed(2)})`).join('; ')}`;
    } catch (err: any) {
      logger.warn(`${READINESS_JOB_ID}: durable act-band demote failed (non-fatal): ${err?.message ?? err}`);
    }
    // Laya follow-up: the sampled-state corpus prune rides the same pass (own try/catch; never fails it).
    const pruned = await pruneDecisionGateStateRows(now);
    const summary = `rows ${rows.length}, purposes ${purposes.length}, ready ${ready.length}${ready.length ? ` (${ready.join(', ')})` : ''}, stamped${autofitNote}, ${windowDays} d window, ${report.durationMs} ms${pruned ? `, pruned ${pruned} state rows` : ''}${durableNote}`;
    logger.info(`${READINESS_JOB_ID}: ${summary}`);
    return summary.slice(0, 200);
  } catch (err: any) {
    const msg = String(err?.message || err);
    logger.warn(`${READINESS_JOB_ID}: pass failed after ${Date.now() - t0} ms — nothing written (${msg})`);
    return `failed: ${msg}`.slice(0, 200);
  }
}
