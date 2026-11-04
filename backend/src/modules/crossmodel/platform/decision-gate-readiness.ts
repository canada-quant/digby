/**
 * Decision gate — the FLIP-READINESS stamp (E1, 2026-09-25).
 *
 * WHY: docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §6 — no purpose may be
 * put in act mode on evidence that does not exist. The readiness report
 * (decision-gate-fit.ts buildReadinessReport: AUROC of 1 − confidence as an
 * error detector, coverage at ≤ 5 % error, act-band precision at the
 * purpose's REAL cutoff, labels / span / positives) is computed by TWO
 * callers over ONE pure builder (`buildReadinessArtifacts` below):
 *
 *   · the worker's `decision-gate-readiness` cron job
 *     (decision-gate-readiness.job.ts — every DECISION_GATE_READINESS_INTERVAL_MIN,
 *     default 360; the Postgres-leased cron_jobs claim means ONE worker runs a
 *     firing fleet-wide, and the web boxes never run the cron loop). It stamps
 *     AUTOMATICALLY, so an admin act flip is admitted the moment a purpose's
 *     bars hold — nobody has to run a script inside a container any more
 *     (the 2026-09-25 live defect: the prod image has no scripts/ dir and no
 *     tsx, so the CLI only ran from a dev checkout).
 *   · the CLI `npm run decision-gate:fit -- --stamp`
 *     (src/scripts/decision-gate-fit-temperature.ts — compiled into dist/
 *     since 2026-09-25, so `node dist/scripts/decision-gate-fit-temperature.js`
 *     runs inside the prod image too).
 *
 * The stamp is the ONLY thing that may justify an act flip; the admin PUT
 * (E12, decision-gate-modes.ts) is admitted against it.
 *
 * Storage: ['instance','decision-gate'] / 'readiness' →
 *   { <purpose>: { ready, at, metrics, backend, reasons, windowDays, partition } }
 * (purpose keys only — the shape agreed with the gate-core sibling; `at` is
 * the ISO time of the report that produced the entry; the job stamps EVERY
 * ACT_POLICIES purpose — one without labelled rows is NOT READY with "no
 * labelled outcomes" as its first reason). The job's full report lives next
 * to it under 'readiness-report' (computedAt, every (backend, purpose)
 * entry, the temperature fits) — that is what the admin
 * GET /admin/model-roles/decision-readiness returns; the GET never recomputes.
 *
 * KILL SWITCH: DECISION_GATE_READINESS_JOB_DISABLED=1 — the cron job never
 * computes or writes. Readers fail CLOSED: a missing / unreadable stamp means
 * "not ready" — the gate can only remove work, never let a flip through on a
 * DB blip.
 *
 * 2026-09-26 (open-weight decision backends, plan D/E): the stamp carries
 * `backendSpec` (the identity the verdict was measured on) and, when the job
 * is handed the per-purpose CONFIGURED primary (`primaryByPurpose`, from the
 * backends module), stamps THAT backend's entry (default: the most labelled
 * rows, challengers excluded); the admission side (decision-gate-modes
 * admissionVerdict) refuses act when the stamp's backendSpec is not the
 * effective primary. Every report entry carries a `role`
 * (primary | challenger | fallback) and the per-backend comparison numbers
 * (calls / fail rate / p50 / p95). The job can also AUTOFIT one temperature
 * per (backend, purpose) from the window's rows into the store row
 * ['instance','decision-gate'] / 'backends' → `temps['<spec>|<purpose>']`
 * (only fits with ≥ --min rows; the built-in jev is excluded — it is the
 * calibrated reference and re-tempering it would move act-mode answers).
 * The autofit is OPT-IN (review 2026-09-26): a stored T makes the runtime
 * treat that backend as CALIBRATED for the purpose, and under an act purpose
 * a calibrated fallback leg's answers then ACT — so the write must never
 * happen behind the owner's back. DECISION_GATE_TEMP_AUTOFIT_ENABLED=1
 * turns it on (the fits are always in the report; unset = today's
 * behaviour: no stored temps, a readout stays uncalibrated — its answers
 * stay shadow under an act purpose — until a human stages
 * DECISION_GATE_TEMP_<PURPOSE> after review); DECISION_GATE_TEMP_AUTOFIT_DISABLED=1
 * is the hard kill switch and wins. The stamp, the report and the metric
 * rows cover ACT_POLICIES purposes only — the admin Test button's `probe`
 * rows never enter them.
 */

import logger from '../../../utils/logger';
import {
  ACT_POLICIES, READINESS_BARS, BUILT_IN_JEV_SPEC, backendTempStoreKey, buildReadinessReport, fitTemperature, pairDecisionRows, readinessMetrics, readinessVerdict, suggestedEnvLine,
  NON_HUMAN_SEGMENTS,
  type BackendKind, type DecisionGateRow, type FitGroup, type FitResult, type ReadinessEntry, type ReadinessMetrics, type ReadinessRole, type ReadinessRow,
} from './decision-gate-fit';
import { applyLabelFloorToStamp } from './decision-gate-label-floor';

export const READINESS_STORE_NS = ['instance', 'decision-gate'];
export const READINESS_STORE_KEY = 'readiness';
/** The worker job's full report (computedAt + every entry + fits) — the admin GET reads this, never recomputes. */
export const READINESS_REPORT_STORE_KEY = 'readiness-report';
/** 2026-09-26: the backends row (shared with the per-purpose primary / challenger config); this module touches ONLY its `temps` field. */
export const BACKENDS_STORE_KEY = 'backends';
/** Specs the autofit never writes a temperature for: the built-in jev is the calibrated reference. */
export const TEMP_AUTOFIT_EXCLUDED_SPECS: ReadonlySet<string> = new Set([BUILT_IN_JEV_SPEC]);

// ── Job knobs (read by the worker's cron registration and by the job itself) ──
export const READINESS_JOB_ID = 'decision-gate-readiness';
export const READINESS_INTERVAL_DEFAULT_MIN = 360;
export const READINESS_INTERVAL_MIN_MIN = 15;
export const READINESS_INTERVAL_MAX_MIN = 7 * 24 * 60;
export const READINESS_WINDOW_DEFAULT_DAYS = 14;
export const READINESS_FIT_MIN_DEFAULT = 50;

export interface PurposeReadiness {
  ready: boolean;
  /** ISO time of the report that produced this entry. */
  at: string;
  metrics: ReadinessMetrics;
  /** The backend the verdict measured (the configured primary when the job knew it, else the one that answered the most labelled rows for the purpose). */
  backend: string;
  /** 2026-09-26: the measured backend's identity (spec) — the admission side compares it with the effective primary. Absent on older stamps. */
  backendSpec?: string;
  /** Every bar missed, named (empty when ready). */
  reasons: string[];
  /** audit 2026-10-08 W3-7: the labelled share of the purpose's in-band decisions (set once ≥ the floor's min N exist). */
  labelCoverage?: number;
  /** The report's --days window. */
  windowDays: number;
  /** The questionsHash partition the metrics cover ('' = unpartitioned rows). */
  partition: string;
  /** audit budgets-cost-6 (2026-09-26): the PURPOSE's silent-degradation counters over the window, summed across every
   *  non-challenger backend that served it (the stamped entry's own metrics carry only that backend's share). Absent on
   *  pre-change stamps. `downgraded` > 0 on an act purpose means asks ran the pre-gate heuristic while the row said act. */
  health?: PurposeHealth;
}

/** Per-purpose degradation counters (see PurposeReadiness.health). */
export interface PurposeHealth {
  /** Decision rows attributed to the purpose's backends (answered + failures). */
  calls: number;
  fails: number;
  /** Act asks answered by an UNCALIBRATED backend (consumer ran its pre-gate path). */
  downgraded: number;
  /** Answers given by a later leg after an earlier one failed. */
  fellThrough: number;
  /** Asks that skipped a backend inside its 401/403 latch cooldown. */
  latched: number;
}

/** Pure: the per-purpose health counters from a report's entries (non-challenger entries of ACT_POLICIES purposes). */
export function purposeHealthFromReport(report: ReadonlyArray<ReadinessEntry>): Record<string, PurposeHealth> {
  const out: Record<string, PurposeHealth> = {};
  for (const e of report) {
    if (!ACT_POLICIES[e.purpose] || e.role === 'challenger') continue;
    const m = e.metrics;
    const h = (out[e.purpose] ??= { calls: 0, fails: 0, downgraded: 0, fellThrough: 0, latched: 0 });
    h.calls += m.calls ?? 0;
    h.fails += m.fails ?? 0;
    h.downgraded += m.downgraded ?? 0;
    h.fellThrough += m.fellThrough ?? 0;
    h.latched += m.latched ?? 0;
  }
  return out;
}

/** { <purpose>: PurposeReadiness } — purpose keys only. */
export type ReadinessStamp = Record<string, PurposeReadiness>;

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** DECISION_GATE_TEMP_AUTOFIT_DISABLED=1 — the hard kill switch: the job reports the fits but never writes `temps` (the runtime keeps its env / previous temperatures), whatever the opt-in says. */
export function tempAutofitDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.DECISION_GATE_TEMP_AUTOFIT_DISABLED);
}

/** DECISION_GATE_TEMP_AUTOFIT_ENABLED=1 — the OPT-IN (review 2026-09-26): the job writes ready fits into the backends row's `temps`, after which the runtime treats those (backend, purpose) pairs as calibrated. Unset = the fits are reported, never stored; the kill switch above wins. */
export function tempAutofitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.DECISION_GATE_TEMP_AUTOFIT_ENABLED) && !tempAutofitDisabled(env);
}

/** DECISION_GATE_READINESS_JOB_DISABLED=1 — the worker's cron job computes and writes nothing. */
export function readinessJobDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.DECISION_GATE_READINESS_JOB_DISABLED);
}

/** DECISION_GATE_READINESS_INTERVAL_MIN (default 360, clamped 15..10080) — the job's cadence in minutes. */
export function readinessIntervalMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DECISION_GATE_READINESS_INTERVAL_MIN);
  if (!Number.isFinite(n) || n <= 0) return READINESS_INTERVAL_DEFAULT_MIN;
  return Math.min(READINESS_INTERVAL_MAX_MIN, Math.max(READINESS_INTERVAL_MIN_MIN, Math.round(n)));
}

/** The cadence the worker registers in cron_jobs (seconds). */
export function readinessIntervalSec(env: NodeJS.ProcessEnv = process.env): number {
  return readinessIntervalMin(env) * 60;
}

/** DECISION_GATE_READINESS_WINDOW_DAYS (default 14, clamped 1..90) — the job's report window (the CLI's --days). */
export function readinessWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DECISION_GATE_READINESS_WINDOW_DAYS);
  if (!Number.isFinite(n) || n <= 0) return READINESS_WINDOW_DEFAULT_DAYS;
  return Math.min(90, Math.max(1, Math.round(n)));
}

/** The per-purpose CONFIGURED primary backend spec (the backends module's `purposes[p].primary`, else the seat) — optional everywhere so the merge agent can wire it. */
export type PrimaryByPurpose = Readonly<Record<string, string | undefined>>;

/**
 * Pure: the report → one entry per purpose. 2026-09-26: when the caller names
 * the purpose's CONFIGURED primary (`primaryByPurpose[p]`, a backend spec)
 * and the report holds that backend's entry, THAT entry is stamped — the
 * flip would run on it. Otherwise (no primary known, or it has no rows yet)
 * the entry with the MOST labelled rows decides, challengers excluded (a
 * shadow challenger can never be the answering backend). A purpose is ready
 * only if the stamped entry is; the stamp carries the entry's backendSpec.
 * ACT_POLICIES purposes only (the E12 contract): an entry for the admin Test
 * button's `probe` purpose never becomes a stamp key.
 */
export function readinessStampFromReport(report: ReadonlyArray<ReadinessEntry>, at: Date, windowDays: number, primaryByPurpose?: PrimaryByPurpose): ReadinessStamp {
  const byPurpose = new Map<string, ReadinessEntry>();
  for (const e of report) {
    if (!ACT_POLICIES[e.purpose]) continue;
    if (e.role === 'challenger') continue;
    // 2026-09-26 (audit): a non-human segment's entry (machine / supervisor rows) never decides the stamp.
    if (e.segment && NON_HUMAN_SEGMENTS.has(e.segment)) continue;
    const cur = byPurpose.get(e.purpose);
    if (!cur || e.metrics.n > cur.metrics.n) byPurpose.set(e.purpose, e);
  }
  if (primaryByPurpose) {
    for (const e of report) {
      if (e.segment && NON_HUMAN_SEGMENTS.has(e.segment)) continue;
      const primary = primaryByPurpose[e.purpose];
      if (primary && ACT_POLICIES[e.purpose] && e.backendSpec === primary) byPurpose.set(e.purpose, e);
    }
  }
  const out: ReadinessStamp = {};
  const health = purposeHealthFromReport(report);
  for (const [purpose, e] of byPurpose) {
    out[purpose] = { ready: e.ready, at: at.toISOString(), metrics: e.metrics, backend: e.backend, ...(e.backendSpec ? { backendSpec: e.backendSpec } : {}), reasons: e.reasons, windowDays, partition: e.metrics.partition, ...(health[purpose] ? { health: health[purpose] } : {}) };
  }
  return out;
}

/**
 * Pure: the entry a purpose gets when the window holds NO labelled outcome
 * for it — NOT READY with every bar named (n = 0 misses them all) and
 * "no labelled outcomes" first. The job's stamp then covers EVERY purpose in
 * ACT_POLICIES (17 as of 2026-09-25), so the admin page and the admission
 * read show a verdict + reasons for each instead of "no data".
 */
export function emptyReadinessEntry(purpose: string, env: Record<string, string | undefined> = {}): ReadinessEntry {
  const metrics = readinessMetrics({ backend: 'none', backendSpec: 'none', purpose, samples: [], deduped: 0, undedupable: 0, challenger: false, calls: 0, fails: 0, latenciesMs: [] }, env);
  const verdict = readinessVerdict(purpose, metrics, false, { env });
  return { backend: 'none', backendSpec: 'none', purpose, calibrated: false, metrics, ready: false, reasons: ['no labelled outcomes in the window', ...verdict.reasons] };
}

/**
 * 2026-09-26 (plan E): the role each entry plays for its purpose — 'primary'
 * when it IS the purpose's primary (the configured spec when known, else the
 * stamped entry — the one the flip would run on); 'challenger' when its
 * NEWEST decision row was a shadow challenger row (buildReadinessReport);
 * 'fallback' otherwise. The CONFIGURED primary wins over the challenger flag
 * (review 2026-09-26): after a promotion (plan D) the new primary's group
 * still holds its challenger-era rows for the rest of the window, and the
 * stamp already follows the configured spec — the role must agree with it.
 * Pure; returns new entries.
 */
export function assignReadinessRoles(entries: ReadonlyArray<ReadinessEntry>, stamp: ReadinessStamp, primaryByPurpose?: PrimaryByPurpose): ReadinessEntry[] {
  return entries.map(e => {
    let role: ReadinessRole;
    // 2026-09-26 (audit): a non-human segment's entry is a partition of the backend's rows, never the purpose's primary.
    if (e.segment && NON_HUMAN_SEGMENTS.has(e.segment)) return { ...e, role: 'fallback' as const };
    const configured = primaryByPurpose?.[e.purpose];
    if (configured) role = e.backendSpec === configured ? 'primary' : e.role === 'challenger' ? 'challenger' : 'fallback';
    else if (e.role === 'challenger') role = 'challenger';
    else role = stamp[e.purpose] && (stamp[e.purpose].backendSpec ?? stamp[e.purpose].backend) === (e.backendSpec ?? e.backend) ? 'primary' : 'fallback';
    return { ...e, role };
  });
}

export interface FitReportEntry extends FitResult {
  backend: string;
  /** 2026-09-26: the backend identity the fit is for. */
  backendSpec: string;
  kind?: BackendKind;
  purpose: string;
  /** n ≥ the --min floor (default 50): the fitted temperature is shippable. */
  ready: boolean;
  /** The DECISION_GATE_TEMP_<PURPOSE>=<T> line to stage (meaningful for the logprob readouts; a systemone backend's fit lives in the store — `storeKey`). */
  envLine: string;
  /** 2026-09-26: the `temps` key the autofit writes for this fit (['instance','decision-gate']/backends). */
  storeKey: string;
  /** 2026-09-26: the autofit WOULD write this fit — ready, and the spec is not excluded (built-in jev). Whether it was written is the report's `tempsWritten` / `autofitEnabled` (opt-in DECISION_GATE_TEMP_AUTOFIT_ENABLED=1). */
  autofit: boolean;
}

export interface ReadinessArtifacts {
  /** One entry per (backend, purpose) with labelled rows, plus an emptyReadinessEntry for every ACT_POLICIES purpose without any (skipped when a single purpose was asked for). Every entry carries its `role`. */
  entries: ReadinessEntry[];
  /** The stamp to write: one verdict per purpose (the configured primary when known, else the backend with the most labelled rows). */
  stamp: ReadinessStamp;
  /** The per-(backend, purpose) temperature fits. */
  fits: FitReportEntry[];
  /** 2026-09-26: the store `temps` map AFTER this pass's autofit (the input map, merged with every ready, non-excluded fit only when `autofit: true`). */
  temps: Record<string, number>;
  /** The temps keys this pass changed (empty when the autofit was off — the default — or nothing new fitted). */
  tempsChanged: string[];
}

/** Pure: the input temps merged with every ready, non-excluded fit — `changed` names the keys whose value moved. */
export function mergeAutofitTemps(temps: Record<string, number>, fits: ReadonlyArray<FitReportEntry>): { temps: Record<string, number>; changed: string[] } {
  const out: Record<string, number> = { ...temps };
  const changed: string[] = [];
  for (const f of fits) {
    if (!f.autofit) continue;
    if (out[f.storeKey] !== f.temperature) { out[f.storeKey] = f.temperature; changed.push(f.storeKey); }
  }
  return { temps: out, changed };
}

/**
 * Pure: loop_metrics decision_gate rows → the readiness entries, the stamp,
 * and the temperature fits. Shared by the worker job and the CLI so both
 * print / store the same verdicts. `purpose` narrows to one purpose (CLI
 * --purpose) and then adds NO empty entries — a single-purpose run is merged
 * into the existing stamp and must not erase the other purposes' verdicts.
 * 2026-09-26: `temps` = the store's fitted per-(backend, purpose)
 * temperatures BEFORE this pass; `autofit` (default FALSE — the opt-in, see
 * tempAutofitEnabled) merges this pass's ready fits into them FIRST, so an
 * entry whose backend just became fitted is judged calibrated in the same
 * pass — exactly what the runtime does once the temps are stored;
 * `primaryByPurpose` picks the stamped entry + the roles. All optional — the
 * CLI and the pre-change job shape (no temps, no primary, autofit off)
 * produce the same entries as before plus the additive fields, and a readout
 * stays uncalibrated until a temperature is actually stored.
 */
export function buildReadinessArtifacts(rows: ReadinessRow[], opts: { days: number; purpose?: string | null; min?: number; env?: Record<string, string | undefined>; now?: Date; temps?: Record<string, number>; primaryByPurpose?: PrimaryByPurpose; autofit?: boolean }): ReadinessArtifacts {
  const env = opts.env ?? {};
  const purpose = opts.purpose ?? null;
  const min = Math.max(1, opts.min ?? READINESS_FIT_MIN_DEFAULT);
  // cp/labels (2026-09-26): `now` bounds the compute_policy `facts` fallback (a decision's
  // window-closed negative once no tap can arrive) in BOTH pairings — the same population.
  const now = opts.now ?? new Date();
  // The act-question filter (audit 2026-09-26) reads its kill switch from the env the job was given.
  const groups: FitGroup[] = pairDecisionRows(rows as DecisionGateRow[], { now, env: opts.env ?? process.env }).filter(g => !purpose || g.purpose === purpose);
  const fits: FitReportEntry[] = groups.map(g => {
    const fit = fitTemperature(g.samples);
    const ready = fit.n >= min;
    return {
      backend: g.backend, backendSpec: g.backendSpec, ...(g.kind ? { kind: g.kind } : {}), purpose: g.purpose, ...fit, ready,
      envLine: suggestedEnvLine(g.purpose, fit.temperature), storeKey: backendTempStoreKey(g.backendSpec, g.purpose),
      autofit: ready && !TEMP_AUTOFIT_EXCLUDED_SPECS.has(g.backendSpec),
    };
  });
  const merged = opts.autofit === true ? mergeAutofitTemps(opts.temps ?? {}, fits) : { temps: { ...(opts.temps ?? {}) }, changed: [] as string[] };
  let entries = buildReadinessReport(rows, { env, purpose, temps: merged.temps, now });
  if (!purpose) {
    const covered = new Set(entries.map(e => e.purpose));
    for (const p of Object.keys(ACT_POLICIES)) if (!covered.has(p)) entries.push(emptyReadinessEntry(p, env));
    entries.sort((a, b) => a.purpose.localeCompare(b.purpose) || b.metrics.n - a.metrics.n);
  }
  // audit 2026-10-08 W3-7: a purpose whose band decisions are almost never labelled is NOT READY (decision-gate-label-floor.ts).
  const stamp = applyLabelFloorToStamp(readinessStampFromReport(entries, opts.now ?? new Date(), opts.days, opts.primaryByPurpose), rows as DecisionGateRow[], env);
  entries = assignReadinessRoles(entries, stamp, opts.primaryByPurpose);
  return { entries, stamp, fits, temps: merged.temps, tempsChanged: merged.changed };
}

/** What the worker job stores under 'readiness-report' after every successful pass. */
export interface StoredReadinessReport {
  /** ISO time the pass computed it. */
  computedAt: string;
  windowDays: number;
  /** decision_gate rows read for the window. */
  rows: number;
  durationMs: number;
  /** Every (backend, purpose) entry (+ the empty entries for unlabelled purposes). */
  entries: ReadinessEntry[];
  fits: FitReportEntry[];
  /** The job always writes the stamp (true); a report stored before 2026-10-08 S-2 may read false. */
  stampWritten: boolean;
  /** The worker that ran the pass (hostname-pid). */
  workerId: string;
  /** 2026-09-26: the fitted per-(backend, purpose) temperatures in force after the pass (the merged map when the autofit wrote; the input map otherwise), and the primaries the stamp followed. */
  temps?: Record<string, number>;
  /** The keys this pass fitted anew — stored when `tempsWritten`, else reported only (see autofitEnabled / tempsWriteError). */
  tempsChanged?: string[];
  /** true only when the autofit was opted in, at least one fit moved AND the backends-row write succeeded (review 2026-09-26). */
  tempsWritten?: boolean;
  /** The autofit opt-in (DECISION_GATE_TEMP_AUTOFIT_ENABLED=1, not killed by _DISABLED) as the job read it — the admin page's "why were the fits not stored". */
  autofitEnabled?: boolean;
  /** The temps write failed this pass (the stamp + the report still landed; the next pass retries). */
  tempsWriteError?: string;
  primaryByPurpose?: Record<string, string | undefined>;
}

// ── 2026-09-26: the `temps` field of the backends row (read + read-modify-write) ──

/** Pure: the backends row → its finite, positive temperatures only. */
export function normalizeStoredTemps(row: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const temps = row && typeof row === 'object' ? (row as { temps?: unknown }).temps : undefined;
  if (!temps || typeof temps !== 'object' || Array.isArray(temps)) return out;
  for (const [k, v] of Object.entries(temps as Record<string, unknown>)) {
    const n = Number(v);
    if (k.includes('|') && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

/** The store's fitted temperatures, or {} when none / unreadable (logged — the pass then judges calibration from env + row flags only). */
export async function readStoredBackendTemps(): Promise<Record<string, number>> {
  try {
    const { storeGet } = await import('../memory/context-store');
    return normalizeStoredTemps(await storeGet<Record<string, unknown>>(READINESS_STORE_NS, BACKENDS_STORE_KEY));
  } catch (err: any) {
    logger.warn(`decision-gate-readiness: backend temps read failed (${err?.message}) — fitting from env / row flags only`);
    return {};
  }
}

/**
 * Read-modify-write of the backends row's `temps` field ONLY (the row's other
 * fields — the per-purpose primary / challenger config — are carried over
 * untouched). Throws when the autofit is not opted in (DECISION_GATE_TEMP_AUTOFIT_ENABLED
 * unset, or the _DISABLED kill switch set) so a caller cannot mistake a
 * refusal for a write, and throws when the READ fails (review 2026-09-26): a
 * read-modify-write whose read did not succeed must never be written — it
 * would replace the shared row with a temps-only one and wipe the primary /
 * challenger config; the next pass retries. Every process's 30 s temps cache
 * (decision-gate.ts storedBackendTempSync) picks the new map up on its next
 * refresh — this module never imports decision-gate.ts (its loop-metrics
 * import boots config/env, which exits a keyless jest worker).
 */
export async function writeStoredBackendTemps(temps: Record<string, number>, meta: { changed: string[]; at: Date }): Promise<void> {
  if (tempAutofitDisabled()) throw new Error('DECISION_GATE_TEMP_AUTOFIT_DISABLED is set — the fitted temperatures were NOT written');
  if (!tempAutofitEnabled()) throw new Error('DECISION_GATE_TEMP_AUTOFIT_ENABLED is not set (the temps autofit is opt-in) — the fitted temperatures were NOT written');
  const { storeGet, storePut } = await import('../memory/context-store');
  let existing: Record<string, unknown> = {};
  try {
    const row = await storeGet<Record<string, unknown>>(READINESS_STORE_NS, BACKENDS_STORE_KEY);
    if (row && typeof row === 'object' && !Array.isArray(row)) existing = row;
  } catch (err: any) {
    throw new Error(`backends row read failed (${err?.message ?? err}) — the fitted temperatures were NOT written (a blind write would drop the row's other fields); the next pass retries`);
  }
  await storePut(READINESS_STORE_NS, BACKENDS_STORE_KEY, { ...existing, temps: normalizeStoredTemps({ temps }), tempsUpdatedAt: meta.at.toISOString(), tempsUpdatedBy: 'readiness-autofit', tempsChanged: meta.changed.slice(0, 64) });
  logger.info(`decision-gate-readiness: autofit wrote ${meta.changed.length} temperature(s) — ${meta.changed.map(k => `${k}=${temps[k]}`).join(', ')} (runtime caches converge within 30 s)`);
}

/** Pure: a stored row → the report, or null when it is not one (malformed / never written). */
export function normalizeStoredReport(stored: unknown): StoredReadinessReport | null {
  if (!stored || typeof stored !== 'object') return null;
  const r = stored as Partial<StoredReadinessReport>;
  if (typeof r.computedAt !== 'string' || Number.isNaN(Date.parse(r.computedAt)) || !Array.isArray(r.entries)) return null;
  return {
    computedAt: r.computedAt,
    windowDays: typeof r.windowDays === 'number' ? r.windowDays : 0,
    rows: typeof r.rows === 'number' ? r.rows : 0,
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : 0,
    entries: r.entries as ReadinessEntry[],
    fits: Array.isArray(r.fits) ? (r.fits as FitReportEntry[]) : [],
    stampWritten: r.stampWritten === true,
    workerId: typeof r.workerId === 'string' ? r.workerId : '',
    ...(r.temps && typeof r.temps === 'object' ? { temps: normalizeStoredTemps({ temps: r.temps }) } : {}),
    ...(Array.isArray(r.tempsChanged) ? { tempsChanged: r.tempsChanged.map(String) } : {}),
    ...(typeof r.tempsWritten === 'boolean' ? { tempsWritten: r.tempsWritten } : {}),
    ...(typeof r.autofitEnabled === 'boolean' ? { autofitEnabled: r.autofitEnabled } : {}),
    ...(typeof r.tempsWriteError === 'string' && r.tempsWriteError ? { tempsWriteError: r.tempsWriteError.slice(0, 300) } : {}),
    ...(r.primaryByPurpose && typeof r.primaryByPurpose === 'object' ? { primaryByPurpose: r.primaryByPurpose as Record<string, string | undefined> } : {}),
  };
}

/** The job's latest stored report, or null when none exists or the store is unreadable (logged). */
export async function readLatestReadinessReport(): Promise<StoredReadinessReport | null> {
  try {
    const { storeGet } = await import('../memory/context-store');
    const row = await storeGet<Record<string, unknown>>(READINESS_STORE_NS, READINESS_REPORT_STORE_KEY);
    return normalizeStoredReport(row);
  } catch (err: any) {
    logger.warn(`decision-gate-readiness: report read failed (${err?.message})`);
    return null;
  }
}

/** Write the job's report (replaces the row; NaN metrics become null through JSON). Not gated by the stamp kill switch — the report is the job's printout. */
export async function writeLatestReadinessReport(report: StoredReadinessReport): Promise<void> {
  const { storePut } = await import('../memory/context-store');
  await storePut(READINESS_STORE_NS, READINESS_REPORT_STORE_KEY, JSON.parse(JSON.stringify(report)) as Record<string, unknown>);
}

/** Pure: a stored row → valid ACT_POLICIES purpose entries only (an unknown purpose — `probe`, a retired key — and anything malformed are dropped; the modes side's normalizeStoredReadiness filters the same way). */
export function normalizeReadinessStamp(stored: unknown): ReadinessStamp {
  const out: ReadinessStamp = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!ACT_POLICIES[k]) continue;
    const e = v as Partial<PurposeReadiness> | null;
    if (!e || typeof e !== 'object' || typeof e.ready !== 'boolean' || typeof e.at !== 'string' || !e.metrics || typeof e.metrics !== 'object') continue;
    out[k] = {
      ready: e.ready, at: e.at, metrics: e.metrics as ReadinessMetrics,
      backend: typeof e.backend === 'string' ? e.backend : 'unknown',
      ...(typeof e.backendSpec === 'string' && e.backendSpec ? { backendSpec: e.backendSpec } : {}),
      reasons: Array.isArray(e.reasons) ? e.reasons.map(String) : [],
      windowDays: typeof e.windowDays === 'number' ? e.windowDays : 0,
      partition: typeof e.partition === 'string' ? e.partition : '',
      ...(normalizePurposeHealth(e.health) ? { health: normalizePurposeHealth(e.health)! } : {}),
    };
  }
  return out;
}

/** A stored `health` object with every counter a finite number, else null (dropped). */
function normalizePurposeHealth(h: unknown): PurposeHealth | null {
  if (!h || typeof h !== 'object') return null;
  const x = h as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const calls = num(x.calls), fails = num(x.fails), downgraded = num(x.downgraded), fellThrough = num(x.fellThrough), latched = num(x.latched);
  if (calls === null || fails === null || downgraded === null || fellThrough === null || latched === null) return null;
  return { calls, fails, downgraded, fellThrough, latched };
}

/** The stored stamp, or null when none exists or the store is unreadable (logged). */
export async function readReadinessStamp(): Promise<ReadinessStamp | null> {
  try {
    const { storeGet } = await import('../memory/context-store');
    const row = await storeGet<Record<string, unknown>>(READINESS_STORE_NS, READINESS_STORE_KEY);
    if (!row) return null;
    return normalizeReadinessStamp(row);
  } catch (err: any) {
    logger.warn(`decision-gate-readiness: store read failed (${err?.message}) — treating every purpose as NOT READY`);
    return null;
  }
}

/** Write the stamp (replaces the row). */
export async function writeReadinessStamp(stamp: ReadinessStamp): Promise<void> {
  const { storePut } = await import('../memory/context-store');
  await storePut(READINESS_STORE_NS, READINESS_STORE_KEY, normalizeReadinessStamp(stamp) as unknown as Record<string, unknown>);
  logger.info(`decision-gate-readiness: stamped ${Object.entries(stamp).map(([p, e]) => `${p}=${e.ready ? 'READY' : 'not ready'}`).join(', ')}`);
}

/**
 * Fail-CLOSED admission read for the flip (E12): true only when the stored
 * stamp says the purpose is ready. Missing stamp, unknown purpose, store
 * error → false.
 */
export async function isPurposeStampedReady(purpose: string): Promise<boolean> {
  const stamp = await readReadinessStamp();
  return stamp?.[purpose]?.ready === true;
}

export interface DecisionReadinessView {
  /** The stored stamp, or null when neither the job nor the CLI has stamped. */
  purposes: ReadinessStamp | null;
  /** The newest `at` across purposes, or null. */
  stampedAt: string | null;
  /** ISO time of the worker job's latest STORED report, or null when it has never run (the GET never recomputes). */
  computedAt: string | null;
  /** The job's latest stored report (every (backend, purpose) entry + the temperature fits), or null. */
  report: StoredReadinessReport | null;
  /** The cron job's configuration as THIS process reads the env (the worker reads the same env in prod). */
  job: { id: string; intervalMin: number; windowDays: number; disabled: boolean };
  /** The bars every purpose must clear (READINESS_BARS). */
  bars: typeof READINESS_BARS;
  /** Always false (the stamp kill switch was retired 2026-10-08 S-2); kept for the admin page, which badges a true. */
  stampDisabled: boolean;
  /** How the stamp is produced (the job) and how to force one on demand (the CLI). */
  howTo: string;
}

/** The admin view (GET /admin/model-roles/decision-readiness): the job's latest STORED report + stamp — never recomputed on request. */
export async function getDecisionReadinessView(): Promise<DecisionReadinessView> {
  const [purposes, report] = await Promise.all([readReadinessStamp(), readLatestReadinessReport()]);
  let stampedAt: string | null = null;
  for (const e of Object.values(purposes ?? {})) if (!stampedAt || e.at > stampedAt) stampedAt = e.at;
  const intervalMin = readinessIntervalMin();
  const windowDays = readinessWindowDays();
  return {
    purposes, stampedAt,
    computedAt: report?.computedAt ?? null,
    report,
    job: { id: READINESS_JOB_ID, intervalMin, windowDays, disabled: readinessJobDisabled() },
    bars: READINESS_BARS, stampDisabled: false,
    howTo: `the worker's ${READINESS_JOB_ID} job recomputes and stamps every ${intervalMin} min (DECISION_GATE_READINESS_INTERVAL_MIN); on demand: cd backend && npm run decision-gate:fit -- --days=${windowDays} --stamp (inside the prod image: node dist/scripts/decision-gate-fit-temperature.js --days=${windowDays} --stamp)`,
  };
}
