/**
 * Decision gate — temperature FIT for the logprob readout backends (WI-I,
 * 2026-09-25; the eval doc's "Fit (week 2): one temperature per (backend,
 * purpose) from the shadow log").
 *
 * WHY: at T=1 the DeepSeek readout's probabilities saturate — wake_triage
 * noul was exactly 0 on 402 rows and exactly 1 on 27 of 429, confidence 1.0
 * everywhere — so DECISION_GATE_THRESHOLD_<PURPOSE> has no margin and the
 * confidence buckets are degenerate. SemIf / JevK5 / Kev all fix this the
 * same way: ONE scalar temperature per (backend, purpose), fitted by
 * minimising negative log-likelihood of the observed outcome under
 * softmax(logits / T). Raw logits are ECE ≈ 0.45; fitted ≈ 0.07–0.12.
 *
 * INPUTS: decision rows (phase 'decision') that carry meta.logits (readout
 * backends persist them since WI-I) paired by meta.id with outcome rows
 * (phase 'outcome') whose meta.actual is not null (WI-C supplies actuals for
 * wake_triage / delta_material / self_audit; browser_driver / imessage_send /
 * memory_extract already carry them).
 *
 * Pure module (no I/O, no config/env boot) so jest covers the math and the
 * script needs only DATABASE_URL; backend/scripts/decision-gate-fit-temperature.ts
 * does the prisma read + printing.
 */

import { quickLaneCeilings, stakesCeilingFor } from './quick-lane-guards';
import { createHash } from 'crypto';
import { distributionFromLogits, wilsonInterval } from './decision-gate-math';
import { decisionStallRecoveryDisabled, isStallRetryLegError } from './decision-gate-stall';

export interface FitSample {
  /** Raw per-option logprobs for ONE question (meta.logits[question]). */
  logits: Record<string, number>;
  /** The observed option key (outcome meta.actual normalised — see actualToKey). */
  actual: string;
}

export interface FitResult {
  n: number;
  /** The fitted temperature (clamped to [tMin, tMax]). */
  temperature: number;
  nllAt1: number;
  nllAtT: number;
  brierAt1: number;
  brierAtT: number;
  eceAt1: number;
  eceAtT: number;
  /** Accuracy of the argmax (temperature-invariant). */
  accuracy: number;
  /** Samples whose actual key is absent from the logits (counted, skipped). */
  skipped: number;
}

export const FIT_T_MIN = 0.7;
export const FIT_T_MAX = 10;

/**
 * The outcome row's `actual` in the readout's option vocabulary: a noul's
 * boolean (or 'true'/'false' string) → 'yes'/'no' (renderOptions' keys), a
 * choice key stays itself, a score level (number) → its index string.
 */
export function actualToKey(actual: unknown): string | null {
  if (actual === null || actual === undefined) return null;
  if (typeof actual === 'boolean') return actual ? 'yes' : 'no';
  if (typeof actual === 'number') return Number.isFinite(actual) ? String(Math.round(actual)) : null;
  const s = String(actual).trim();
  if (!s) return null;
  const low = s.toLowerCase();
  if (low === 'true') return 'yes';
  if (low === 'false') return 'no';
  return s;
}

/** Mean negative log-likelihood of the actual under softmax(logits / T); clamped at 1e-12. */
export function meanNll(samples: FitSample[], temperature: number): number {
  if (!samples.length) return NaN;
  let total = 0;
  for (const s of samples) {
    const keys = Object.keys(s.logits);
    const p = distributionFromLogits(s.logits, keys, temperature)[s.actual] ?? 0;
    total += -Math.log(Math.max(p, 1e-12));
  }
  return total / samples.length;
}

/** Mean Brier score (multi-class: Σ (p_k − y_k)²) under softmax(logits / T). */
export function meanBrier(samples: FitSample[], temperature: number): number {
  if (!samples.length) return NaN;
  let total = 0;
  for (const s of samples) {
    const keys = Object.keys(s.logits);
    const p = distributionFromLogits(s.logits, keys, temperature);
    let sum = 0;
    for (const k of keys) {
      const y = k === s.actual ? 1 : 0;
      sum += (p[k] - y) ** 2;
    }
    total += sum;
  }
  return total / samples.length;
}

/** Expected calibration error of the argmax confidence over 10 equal-width bins. */
export function ece(samples: FitSample[], temperature: number, bins = 10): number {
  if (!samples.length) return NaN;
  const sums = new Array(bins).fill(0).map(() => ({ n: 0, conf: 0, hit: 0 }));
  for (const s of samples) {
    const keys = Object.keys(s.logits);
    const p = distributionFromLogits(s.logits, keys, temperature);
    const best = keys.reduce((m, k) => (p[k] > p[m] ? k : m), keys[0]);
    const conf = p[best];
    const b = Math.min(bins - 1, Math.floor(conf * bins));
    sums[b].n += 1;
    sums[b].conf += conf;
    sums[b].hit += best === s.actual ? 1 : 0;
  }
  let out = 0;
  for (const bin of sums) {
    if (!bin.n) continue;
    out += (bin.n / samples.length) * Math.abs(bin.conf / bin.n - bin.hit / bin.n);
  }
  return out;
}

/**
 * Fit T by minimising mean NLL: a log-spaced grid over [tMin, tMax] followed
 * by a golden-section refinement in the best cell. NLL(T) is convex in 1/T
 * for a softmax, so the grid + local search finds the optimum.
 */
export function fitTemperature(samplesIn: FitSample[], opts?: { tMin?: number; tMax?: number }): FitResult {
  const tMin = opts?.tMin ?? FIT_T_MIN;
  const tMax = opts?.tMax ?? FIT_T_MAX;
  const samples = samplesIn.filter(s => s && s.logits && typeof s.logits[s.actual] === 'number');
  const skipped = samplesIn.length - samples.length;
  if (!samples.length) {
    return { n: 0, temperature: 1, nllAt1: NaN, nllAtT: NaN, brierAt1: NaN, brierAtT: NaN, eceAt1: NaN, eceAtT: NaN, accuracy: NaN, skipped };
  }
  const f = (t: number) => meanNll(samples, t);
  // Coarse grid (log-spaced, 40 cells).
  const cells = 40;
  const logMin = Math.log(tMin);
  const logMax = Math.log(tMax);
  let bestT = 1;
  let bestV = Infinity;
  for (let i = 0; i <= cells; i++) {
    const t = Math.exp(logMin + ((logMax - logMin) * i) / cells);
    const v = f(t);
    if (v < bestV) { bestV = v; bestT = t; }
  }
  // Golden-section refinement in the neighbouring cells (log space).
  const step = (logMax - logMin) / cells;
  let lo = Math.max(logMin, Math.log(bestT) - step);
  let hi = Math.min(logMax, Math.log(bestT) + step);
  const phi = (Math.sqrt(5) - 1) / 2;
  let c = hi - phi * (hi - lo);
  let d = lo + phi * (hi - lo);
  let fc = f(Math.exp(c));
  let fd = f(Math.exp(d));
  for (let i = 0; i < 40; i++) {
    if (fc < fd) { hi = d; d = c; fd = fc; c = hi - phi * (hi - lo); fc = f(Math.exp(c)); }
    else { lo = c; c = d; fc = fd; d = lo + phi * (hi - lo); fd = f(Math.exp(d)); }
  }
  const refined = Math.exp((lo + hi) / 2);
  const temperature = f(refined) <= bestV ? refined : bestT;
  let hits = 0;
  for (const s of samples) {
    const keys = Object.keys(s.logits);
    const best = keys.reduce((m, k) => (s.logits[k] > s.logits[m] ? k : m), keys[0]);
    if (best === s.actual) hits += 1;
  }
  return {
    n: samples.length,
    temperature: Number(temperature.toFixed(3)),
    nllAt1: f(1),
    nllAtT: f(temperature),
    brierAt1: meanBrier(samples, 1),
    brierAtT: meanBrier(samples, temperature),
    eceAt1: ece(samples, 1),
    eceAtT: ece(samples, temperature),
    accuracy: hits / samples.length,
    skipped,
  };
}

// ── Pairing loop_metrics rows into samples ──────────────────────────────────

/** The subset of a loop_metrics row the fit reads (`value` = the decision row's latency in ms, 2026-09-26). */
export interface DecisionGateRow { meta: any; createdAt?: Date | string; value?: number | null }

/** A decision backend's client kind (decision-gate.ts DecisionBackendKind; mirrored here so the fit stays dependency-free). */
export type BackendKind = 'systemone' | 'logit';

// ── Backend identity (2026-09-26) ───────────────────────────────────────────
// Rows written since 2026-09-26 carry meta.backendSpec (the seat spec — 'jev',
// 'deepseek-flash', '<label>:<id>'); older rows carry only the human label.
// Every grouping below keys on backendSpec ?? the label, with the two built-in
// labels mapped to their specs so the history of a built-in stays ONE group
// across the change.

/** The built-in labels' specs (decision-gate.ts backendForSpec) — for rows written before backendSpec existed. */
export const LEGACY_BACKEND_LABEL_SPECS: Readonly<Record<string, string>> = {
  'TypeSafe Jev': 'jev',
  'DeepSeek logprob readout': 'deepseek-flash',
};

/** The backend identity a row groups under: meta.backendSpec, else the built-in label's spec, else the label itself. */
export function backendSpecOfRow(meta: any): string {
  if (meta && typeof meta.backendSpec === 'string' && meta.backendSpec) return meta.backendSpec;
  const label = meta && typeof meta.backend === 'string' && meta.backend ? meta.backend : 'unknown';
  return LEGACY_BACKEND_LABEL_SPECS[label] ?? label;
}

/** The backend's client kind from a row: meta.backendKind, else inferred from the label (built-in Jev / "(systemone)" = systemone; "logprob readout" = logit). */
export function backendKindOfRow(meta: any): BackendKind | undefined {
  if (meta?.backendKind === 'systemone' || meta?.backendKind === 'logit') return meta.backendKind;
  const label = String(meta?.backend || '');
  if (!label) return undefined;
  if (isSystemOneBackend(label)) return 'systemone';
  if (/logprob readout/i.test(label)) return 'logit';
  return undefined;
}

const LOG_P_FLOOR = 1e-6;
const logP = (p: unknown): number => Math.log(Math.max(LOG_P_FLOOR, Math.min(1, Number(p) || 0)));

/**
 * 2026-09-26: per-question logits (= log p, floored at 1e-6) derived from a
 * decision row's compact meta.answers — a noul becomes {no, yes} (the
 * readout's noul vocabulary), a choice / score uses its stored per-option
 * `probabilities` (systemone rows keep them since 2026-09-26). Questions with
 * neither are skipped; null when nothing is derivable. Lets the temperature
 * fit read systemone rows (TypeSafe Jev, Laya, JevK5 …), which carry no
 * meta.logits unless a fitted T already re-calibrated them.
 */
export function logitsFromAnswers(answers: unknown): Record<string, Record<string, number>> | null {
  if (!answers || typeof answers !== 'object') return null;
  const out: Record<string, Record<string, number>> = {};
  for (const [q, a] of Object.entries(answers as Record<string, any>)) {
    if (!a || typeof a !== 'object') continue;
    if (typeof a.noul === 'number' && Number.isFinite(a.noul)) { out[q] = { no: logP(1 - a.noul), yes: logP(a.noul) }; continue; }
    if (a.probabilities && typeof a.probabilities === 'object' && !Array.isArray(a.probabilities)) {
      const l: Record<string, number> = {};
      for (const [k, p] of Object.entries(a.probabilities as Record<string, unknown>)) { const n = Number(p); if (Number.isFinite(n)) l[k] = logP(n); }
      if (Object.keys(l).length) out[q] = l;
    }
  }
  return Object.keys(out).length ? out : null;
}

export interface FitGroup {
  backend: string;
  /** 2026-09-26: the backend identity the group is keyed by (backendSpecOfRow). */
  backendSpec: string;
  /** The backend's client kind (from the newest row; undefined when no row says). */
  kind?: BackendKind;
  purpose: string;
  samples: FitSample[];
}

/**
 * Join decision rows with outcome rows (meta.actual !== null) by meta.id +
 * question, grouped by (backendSpec, purpose). Logits come from meta.logits
 * (readout rows; systemone rows a fitted T re-calibrated) or, since
 * 2026-09-26, are derived from meta.answers (log p — logitsFromAnswers), so
 * systemone backends are fitted too. Two row kinds never enter the fit
 * (review 2026-09-26): a MEMO HIT (meta.cached — its answers are a copy of
 * the original decision's, so a repeat would count one sample twice toward
 * the fit floor, and it carries no raw logits), and a row whose answers were
 * TEMPERED (meta.temperature ≠ 1) but carries no meta.logits — deriving
 * "logits" from a tempered distribution would feed post-T probabilities back
 * into the fit and bias it toward confirming the T in force. Audit 2026-09-26
 * (telemetry-readiness-8): only the purpose's ACT question is fitted
 * (fitAdmitsQuestion) — the fit is per act question, never a pool of every
 * question the purpose asked.
 */
export function pairDecisionRows(rows: DecisionGateRow[], opts: { now?: number | Date; env?: Record<string, string | undefined> } = {}): FitGroup[] {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : typeof opts.now === 'number' ? opts.now : Date.now();
  const env = opts.env ?? process.env;
  const primary = primaryLabelledKeys(rows);
  const decisions = new Map<string, { backend: string; backendSpec: string; kind?: BackendKind; at: number; purpose: string; logits: Record<string, Record<string, number>> }>();
  for (const r of rows) {
    const m = r?.meta;
    if (!m || m.phase !== 'decision' || !m.id) continue;
    if (m.cached === true) continue;
    // 2026-09-26 (audit): a NON-HUMAN segment's decision never enters the temperature fit — its only
    // "label" today would be the structurally-negative facts fallback (see NON_HUMAN_SEGMENTS).
    if (partitionSegmentOfRow(m)) continue;
    const tempered = typeof m.temperature === 'number' && Number.isFinite(m.temperature) && m.temperature !== 1;
    const logits = m.logits && typeof m.logits === 'object' ? m.logits : tempered ? null : logitsFromAnswers(m.answers);
    if (!logits) continue;
    decisions.set(String(m.id), { backend: String(m.backend || 'unknown'), backendSpec: backendSpecOfRow(m), kind: backendKindOfRow(m), at: toMs(r.createdAt), purpose: String(m.purpose || 'unknown'), logits });
  }
  const groups = new Map<string, FitGroup & { newestAt: number }>();
  for (const r of rows) {
    const m = r?.meta;
    if (!m || m.phase !== 'outcome' || !m.id || !m.question) continue;
    const actual = actualToKey(m.actual);
    if (actual === null) continue;
    const d = decisions.get(String(m.id));
    if (!d) continue;
    if (!fitAdmitsQuestion(d.purpose, String(m.question), env)) continue;
    if (!outcomeRowEntersFit(d.purpose, m, { primary, rowAtMs: toMs(r.createdAt), nowMs })) continue;
    const logits = d.logits[String(m.question)];
    if (!logits || typeof logits !== 'object') continue;
    const key = `${d.backendSpec}\u0000${d.purpose}`;
    let g = groups.get(key);
    if (!g) { g = { backend: d.backend, backendSpec: d.backendSpec, ...(d.kind ? { kind: d.kind } : {}), purpose: d.purpose, samples: [], newestAt: -1 }; groups.set(key, g); }
    if (d.at >= g.newestAt) { g.newestAt = d.at; g.backend = d.backend; if (d.kind) g.kind = d.kind; }
    g.samples.push({ logits, actual });
  }
  return [...groups.values()]
    .sort((a, b) => a.purpose.localeCompare(b.purpose) || b.samples.length - a.samples.length)
    .map(({ newestAt: _n, ...g }) => g);
}

/** The env line the runtime reads for a fitted purpose (the logprob readouts only). */
export function suggestedEnvLine(purpose: string, temperature: number): string {
  return `DECISION_GATE_TEMP_${purpose.toUpperCase()}=${temperature}`;
}

/** 2026-09-26: the store key a fitted (backend, purpose) temperature lives under — ['instance','decision-gate']/backends `temps[key]`. */
export function backendTempStoreKey(backendSpec: string, purpose: string): string {
  return `${backendSpec}|${purpose}`;
}

/** 2026-09-26: is a temperature fitted for (backendSpec, purpose)? The store map for any backend; the per-purpose env key for a logprob readout only (it was fitted against the readout). */
export function backendTemperatureFittedIn(backendSpec: string, purpose: string, kind: BackendKind | undefined, env: Record<string, string | undefined> = {}, temps: Record<string, number> = {}): boolean {
  const stored = Number(temps[backendTempStoreKey(backendSpec, purpose)]);
  if (Number.isFinite(stored) && stored > 0) return true;
  if (kind === 'systemone') return false;
  return Number(env[`DECISION_GATE_TEMP_${purpose.toUpperCase()}`]) > 0;
}

// ── Flip-readiness report (E1, 2026-09-25) ───────────────────────────────────
// The temperature fit above only ever saw readout rows (meta.logits), so the
// backend that answers ~95–100% of prod decisions (TypeSafe Jev, which carries
// meta.answers and no logits) was never measured, and every "agreed" number
// was computed at a 0.5 cutoff while the consumers act at 0.15 / 0.2 / 0.7 /
// 0.85. This section is the ruler the act-flip roadmap (docs/
// DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §6) demands: per (backend,
// purpose) it pairs EVERY labelled outcome row with its decision (answers OR
// logits), dedupes by stateHash, partitions by questionsHash, and computes
// the paper's go/no-go numbers — AUROC of (1 − confidence) as an error
// detector, coverage at ≤ 5 % error, and precision inside the act band at the
// purpose's REAL cutoff — then prints READY / NOT READY against the §6 bars.
// Still pure: no I/O, no env boot (the script passes process.env in).

/** How a consumer acts on a confident answer — mirrors the seven call sites
 *  exactly (the cutoffs, and which side of the answer acts). */
export type ActPolicyKind = 'noul_low' | 'noul_high' | 'choice_high' | 'score_low';

export interface ActPolicy {
  /** The question the consumer acts on ('*' = every noul the purpose asks, memory_extract). */
  question: string;
  /** noul_low: act (skip / park) when noul ≤ 1 − τ; noul_high: act (skip) when noul ≥ τ; choice_high: act (route) when confidence ≥ τ;
   *  score_low (N9, 2026-09-25): act (lower effort) when round(score) ≤ maxScore AND confidence ≥ τ. */
  kind: ActPolicyKind;
  /** score_low only: the highest level the consumer still acts on (wake_effort: 1). */
  maxScore?: number;
  /** The caller's default τ (env DECISION_GATE_THRESHOLD_<PURPOSE> overrides it, clamped to [0.5, 1]). */
  defaultThreshold: number;
  /** choice_high only: a stricter default for specific options (auto_route: deep_research 0.85). */
  optionThresholds?: Record<string, number>;
  /**
   * A COMPOUND act predicate (audit 2026-09-26 telemetry-readiness-2): when the
   * consumer's rule reads MORE than the acted question (compute_policy acts on
   * `depth` AND the `stakes` noul), the plain kind would count confident answers
   * the consumer never acts on ('ordinary' / 'unclear' at 0.95) as in-band. The
   * predicate mirrors the consumer exactly; `answers` = the decision's other
   * questions when known (an outcome row carries `stakes` on its extra).
   */
  band?: (predicted: PredictedView, answers: Record<string, PredictedView> | undefined, env: Record<string, string | undefined>) => ActBandVerdict;
  /** Where the consumer applies it (for the report). */
  consumer: string;
}

/**
 * compute_policy's REAL act rule (platform/compute-policy-gate.ts applyComputePolicy), as
 * an act band over the ruler's predicted views: (simple_lookup ∧ P ≥ τ_simple ∧ stakes ≤
 * 1 − τ_stakes) ⇒ act 'simple_lookup'; (P(contestable) ≥ τ_contestable ∧ stakes ≥ τ_stakes)
 * ⇒ act 'contestable'; 'ordinary' / 'unclear' / unknown stakes ⇒ never in band. Thresholds
 * read through the SAME env keys computePolicyThresholds uses.
 */
export function computePolicyActBand(predicted: PredictedView, answers: Record<string, PredictedView> | undefined, env: Record<string, string | undefined>): ActBandVerdict {
  const tSimple = purposeCutoff('compute_policy', env, 'simple_lookup');
  const tStakes = purposeCutoff('compute_policy', env, 'stakes');
  const tContestable = purposeCutoff('compute_policy', env, 'contestable');
  const stakes = typeof answers?.stakes?.noul === 'number' && Number.isFinite(answers.stakes.noul) ? answers.stakes.noul : null;
  const choice = typeof predicted.choice === 'string' ? predicted.choice : null;
  const conf = typeof predicted.confidence === 'number' && Number.isFinite(predicted.confidence) ? predicted.confidence : null;
  const pContestable = typeof predicted.probabilities?.contestable === 'number' ? predicted.probabilities.contestable : (choice === 'contestable' ? conf : null);
  const eps = 1e-9;
  if (stakes !== null && pContestable !== null && pContestable >= tContestable - eps && stakes >= tStakes - eps) {
    return { inBand: true, threshold: tContestable, actKey: 'contestable' };
  }
  if (choice === 'simple_lookup' && conf !== null && stakes !== null && conf >= tSimple - eps && stakes <= 1 - tStakes + eps) {
    return { inBand: true, threshold: tSimple, actKey: 'simple_lookup' };
  }
  return { inBand: false, threshold: choice === 'contestable' ? tContestable : tSimple, actKey: choice };
}

/**
 * turn_plan's act rule (platform/turn-plan.ts quickLaneEligibility) as a band:
 * only a confident QUICK lane is ever acted on — a confident standard / checked /
 * research answer is recorded, never routed — with the stakes / contested
 * ceilings (the shared leaf quick-lane-guards.ts) when the row carries them (an
 * outcome row carries the lane only, so the trait guards apply only when known).
 * The stakes ceiling is the SAME stakesCeilingFor the consumer calls (2026-10-20):
 * a pure live lookup (needs_live_web / multi_step / contested all answered and in
 * bounds) is held to the lookup ceiling, anything else to the base one. Pure.
 */
export function turnPlanActBand(predicted: PredictedView, answers: Record<string, PredictedView> | undefined, env: Record<string, string | undefined>): ActBandVerdict {
  const t = purposeCutoff('turn_plan', env, 'quick');
  const ceilings = quickLaneCeilings(env);
  const { contestedCeiling } = ceilings;
  const choice = typeof predicted.choice === 'string' ? predicted.choice : null;
  const conf = typeof predicted.confidence === 'number' && Number.isFinite(predicted.confidence) ? predicted.confidence : null;
  const trait = (k: string): number | null => (typeof answers?.[k]?.noul === 'number' && Number.isFinite(answers[k].noul as number) ? answers[k].noul as number : null);
  const stakes = trait('stakes'); const contested = trait('contested');
  const { ceiling: stakesCeiling } = stakesCeilingFor({ needsLiveWeb: trait('needs_live_web'), multiStep: trait('multi_step'), contested }, ceilings);
  const inBand = choice === 'quick' && conf !== null && conf >= t - 1e-9 && (stakes === null || stakes < stakesCeiling) && (contested === null || contested < contestedCeiling);
  return { inBand, threshold: t, actKey: choice };
}

/** Verified against the call sites 2026-09-25 (grep `decisionThreshold(`). */
export const ACT_POLICIES: Readonly<Record<string, ActPolicy>> = {
  wake_triage: { question: 'needs_turn_now', kind: 'noul_low', defaultThreshold: 0.85, consumer: 'platform/hooks.service.ts — park when noul ≤ 1−τ (in act one confident park in 10 delivers as a control:true wake — the band’s act-period labels; WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED)' },
  delta_material: { question: 'material', kind: 'noul_low', defaultThreshold: 0.85, consumer: 'coding/schedule.service.ts — skip the fire when noul ≤ 1−τ' },
  self_audit: { question: 'unevidenced', kind: 'noul_low', defaultThreshold: 0.85, consumer: 'coding/self-audit-gate.ts — skip the audit round when noul ≤ 1−τ' },
  imessage_send: { question: 'send', kind: 'noul_low', defaultThreshold: 0.85, consumer: 'imessage/nlp.ts — skip the send-intent utility call when noul ≤ 1−τ' },
  memory_extract: { question: '*', kind: 'noul_low', defaultThreshold: 0.8, consumer: 'langgraph/memory.graph.ts — skip an extractor when its noul ≤ 1−τ' },
  auto_route: { question: 'level', kind: 'choice_high', defaultThreshold: 0.7, optionThresholds: { deep_research: 0.85 }, consumer: 'platform/auto-router-gate.ts — route when confidence ≥ τ (0.85 for deep_research)' },
  browser_driver: { question: 'driver', kind: 'choice_high', defaultThreshold: 0.7, consumer: 'browser-agent/router.ts — route when confidence ≥ τ' },
  // N1 / N2 (2026-09-25) shipped before this table existed — added 2026-09-25 so the readiness report covers them.
  guard_strike: { question: 'verdict', kind: 'choice_high', defaultThreshold: 0.9, consumer: 'fleet/strike-adjudication.service.ts — over-cap strikes get a gate verdict when confident and not unclear' },
  sweep_triage: { question: 'needs_turn_now', kind: 'noul_low', defaultThreshold: 0.85, consumer: 'platform/sweep-triage.ts — skip a stock sweep firing the gate is confident is a no-op (heartbeat floor)' },
  checker_route: { question: 'depth', kind: 'choice_high', defaultThreshold: 0.7, consumer: 'chat-agent/checker-route-gate.ts — simple_lookup → 75 s path + checker at high, contestable → full wait, when confidence ≥ τ (N4)' },
  // backlog E14 (2026-09-28): τ 0.8 → 0.9 — the band at 0.8 held 719/1,035 (precision 0.695, LB 0.666) on the
  // 2026-09-28 readiness stamp; the consumer default (CODING_MEMORY_FOLD_DEFAULT_THRESHOLD) moved in lockstep.
  // DECISION_GATE_THRESHOLD_CODING_MEMORY_FOLD=0.8 restores the old cutoff at the site AND in the ruler.
  coding_memory_fold: { question: '*', kind: 'noul_low', defaultThreshold: 0.9, consumer: 'coding/coding-memory-fold-gate.ts — skip a fold leg (session / project / user / journal) when its noul ≤ 1−τ' },
  reflection_route: { question: 'route', kind: 'choice_high', defaultThreshold: 0.85, consumer: 'coding/reflection.ts — skip the Double-Checker consult when the route is confident and not needs_diagnosis' },
  claim_evidenced: { question: '*', kind: 'noul_high', defaultThreshold: 0.9, consumer: 'platform/claim-evidence-gate.ts — skip the LLM claim extraction when EVERY claim_<k>_evidenced noul ≥ τ (N5)' },
  drain_triage: { question: 'disposition', kind: 'choice_high', defaultThreshold: 0.85, consumer: 'platform/drain-triage.ts — park a queued agent batch when ack_only / coalesce confidence ≥ τ (N6; act_now never parks)' },
  firing_superseded: { question: 'disposition', kind: 'choice_high', defaultThreshold: 0.9, consumer: 'coding/firing-superseded-gate.ts — skip the parked firing when drop_superseded / merge_into_next has confidence ≥ τ (N7; act designed, shadow)' },
  tool_intent: { question: 'intended_tool', kind: 'choice_high', defaultThreshold: 0.85, consumer: 'coding/tool-intent-gate.ts — no act consumer (N10 shadow telemetry); the band measures confident attributions' },
  wake_effort: { question: 'deliberation', kind: 'score_low', maxScore: 1, defaultThreshold: 0.9, consumer: "platform/wake-effort.ts — machine wake at reasoning_effort 'high' when round(score) ≤ 1 and confidence ≥ τ (owner lock lifted 2026-09-26; DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0 hard-disables)" },
  // Compute policy (2026-09-26, docs/DEPTH_UX_SOTA_2026-09-26.md §4) — all three shipped SHADOW.
  compute_policy: { question: 'depth', kind: 'choice_high', defaultThreshold: 0.85, optionThresholds: { contestable: 0.7, stakes: 0.85 }, band: computePolicyActBand, consumer: 'platform/compute-policy-gate.ts — skip the checker when simple_lookup ≥ τ ∧ stakes ≤ 0.15; stakes wait (≤ STAKES_WAIT_MS) when stakes ≥ 0.85 ∧ contestable ≥ 0.7 (the band mirrors BOTH rules — computePolicyActBand); research_request only marks the plan (no consumer runs a background council; RESEARCH_REQUEST_AUTOSTART_ENABLED opts in)' },
  drafts_agree: { question: 'agree', kind: 'noul_high', defaultThreshold: 0.8, consumer: 'platform/compute-policy-gate.ts decideDraftsAgree — skip the reconcile pass when agree ≥ τ (label: the reconcile\'s revision_material verdict)' },
  revision_material: { question: 'material', kind: 'noul_low', defaultThreshold: 0.85, consumer: 'platform/compute-policy-gate.ts decideRevisionMaterial — wording-only (no rewrite) when material ≤ 1−τ; asked only when the deterministic diff says unchanged' },
  // agent-decisions 2026-09-27 (area supervisor): the per-target supervisor turn pre-triage — sweep firings + agent drains (hook wakes keep wake_triage).
  supervisor_turn_noop: { question: 'will_act', kind: 'noul_low', defaultThreshold: 0.85, consumer: 'platform/supervisor-turn-noop.ts — skip a sweep firing / park an agent drain when will_act ≤ 1−τ AND no pin holds (deterministic new-input, alarm, cap bypass, waiting user row) AND the heartbeat floor allows (act designed, shadow; has_new_input is a code-labelled probe, never in the rule). The band mirrors the rule because PINNED turns stamp their outcome rows excludeFromFit (decision-outcome-labels) — the threshold-only band then covers exactly the turns the rule could skip; readinessVerdict additionally judges the act-period floor-turn CONTROL rows (PURPOSE_CONTROL_GATED)' },
  // Session titles + topology (2026-09-27): the R7 placement choice before a start_coding_session (shipped SHADOW; labelled +24 h by the session-topology-outcomes cron).
  session_topology: { question: 'placement', kind: 'choice_high', defaultThreshold: 0.85, consumer: 'platform/session-topology.ts — on the ambiguous R7 band a confident reuse / merge / retire (placement ≥ τ) replaces the fail-open spawn; spawn is never acted on (it is the default); labels: session-topology-outcomes' },
  // Task-aware model pick (2026-10-20): the job type of a human turn, asked beside turn_plan (own purpose, own partition).
  // `kind` is the forward-order question (kind_rev is its reversed-order twin, averaged by the classifier); act-capped in
  // code (PURPOSE_ACT_CAPS) — the band only marks which answers the evidence consumer would use, for a future label writer.
  task_kind: { question: 'kind', kind: 'choice_high', defaultThreshold: 0.5, consumer: 'platform/task-kind.ts usableTaskKind ← platform/turn-plan.ts (the per-turn model pick) — no gate act consumer: a calibrated kind with p (both option orders averaged) ≥ τ keys the pick’s QUALITY evidence by (model, kind) before (model, lane); whether the kind-aware pick leads is the modelPickKind store mode on the turn-plan config, never this gate mode (consumer kill switches: MODEL_PICK_KIND_DISABLED = no kind pick, MODEL_EVIDENCE_KIND_DISABLED = evidence ignores kind buckets)' },
  // Dynamic roster phase 2 (2026-10-03): the lane choice; act routes ONLY the quick lane, behind code guards (stakes < 0.6 — < 0.75 on a pure live lookup since 2026-10-20 — / contested < 0.5, ≤ 600 chars, no attachments, human plain chat).
  turn_plan: { question: 'lane', kind: 'choice_high', defaultThreshold: 0.8, band: turnPlanActBand, consumer: 'platform/turn-plan.ts — act runs the Quick answers seat when p(quick) (both option orders averaged) ≥ τ (0.8) ∧ stakes < 0.6 (< 0.75 on a pure live lookup: needs_live_web ≥ 0.8 ∧ multi_step < 0.5 ∧ contested < 0.2, all answered — 2026-10-20; the band calls the same stakesCeilingFor) ∧ contested < 0.5 (quick-lane-guards.ts, set from the 2026-10-03 replay) ∧ a short, attachment-free, non-code human turn on a plain chat that is not a follow-up in a checked / research session; standard / checked / research are recorded only (labels: chat-agent/turn-plan-labels.ts)' },
};

/**
 * agent-decisions 2026-09-27: per-purpose OVERRIDES of READINESS_BARS. A
 * purpose that SKIPS work in act (supervisor_turn_noop: a skipped turn never
 * runs, so it has no label) sees, once act, only its heartbeat-floor CONTROL
 * turns inside the band — pinned turns (which the rule can never skip) are
 * excludeFromFit upstream, so neither the shadow nor the act population holds
 * a row the consumer could not have acted on. It needs more band rows and a
 * stricter precision — 0.95 ⇔ a floor-turn action rate ≤ 5% — before its act
 * flip is admitted. Read by readinessVerdict (with PURPOSE_CONTROL_GATED).
 */
export interface ReadinessBars {
  minLabels: number; minDays: number; minActBandPrecision: number; minActBandN: number; minAuroc: number; minCoverageAt5: number; imessageMinPositives: number;
}
export const PURPOSE_READINESS_BARS: Readonly<Record<string, Partial<Pick<ReadinessBars, 'minActBandN' | 'minActBandPrecision' | 'minLabels'>>>> = {
  supervisor_turn_noop: { minActBandN: 30, minActBandPrecision: 0.95 },
  // session titles + topology (2026-09-27): a placement that re-routes work (reuse / merge / retire) needs the same 30 band rows at 0.95.
  session_topology: { minActBandN: 30, minActBandPrecision: 0.95 },
};

/** The bars for a purpose (READINESS_BARS with PURPOSE_READINESS_BARS applied). Pure. */
export function readinessBarsFor(purpose: string): ReadinessBars {
  return { ...READINESS_BARS, ...(PURPOSE_READINESS_BARS[purpose] ?? {}) };
}

/**
 * fixer 2026-09-27: purposes whose act-period band rows are heartbeat-floor
 * CONTROL turns (meta.control). Once such rows exist in the window,
 * readinessVerdict judges the flip / re-admission on them as well — their
 * count against minActBandN and the Wilson 95% LOWER bound of their QUIET
 * rate (1 − action rate) against minActBandPrecision — so shadow-era band
 * rows alone can never keep a skipping purpose READY after its flip.
 */
export const PURPOSE_CONTROL_GATED: ReadonlySet<string> = new Set(['supervisor_turn_noop']);

/**
 * Purposes that write SEVERAL outcome rows per decision (meta.label tells
 * them apart) name here the ONE label that enters the temperature fit and
 * the readiness pairing — chosen explicitly, never by write order. A row
 * with no meta.label always passes (single-label purposes). Additive
 * registry — one line per purpose.
 */
export const OUTCOME_LABEL_FOR_FIT: Readonly<Record<string, string>> = {
  tool_intent: 'regex', // N10 (2026-09-25): 'next_call' is the weaker label (a batched / derailed model's next tool); the run's last turn never gets one
  compute_policy: 'escalated', // compute policy (2026-09-26): the Dig-deeper tap ≤ 30 min is the PRIMARY label, written once per decision (tap, or window close); facts (finalize) / reask_5m / thumbs / revision_material / checker_skipped_material are secondary rows — excluded here AND from the act-band window (decision-gate recordDecisionOutcome)
  // backlog E10 (2026-09-28): the HUMAN signal (thumbs / Dig-deeper after the revision) stays the primary label; the
  // harness row the window closer writes from the deterministic diff (label 'harness') is the FALLBACK below — never
  // the act-band window's label (an acted row's diff verdict is degenerate: the diff said unchanged by construction).
  revision_material: 'human',
  // Dynamic roster (2026-10-03): the Dig-deeper tap ≤ 30 min / the window close is the primary row; reask_5m / thumbs are secondary.
  turn_plan: 'escalated',
};

/**
 * backlog DOI-21 (2026-09-28): a NON-HUMAN segment's rows (machine / supervisor)
 * can carry no user label, so their partition names its OWN fit label — the
 * harness proxy the window closer writes once the escalation window has passed
 * (decision-outcome-labels deriveMachineDepthProxy; label 'machine'). Admitted
 * by outcomeRowEntersFit only for a row whose segment is non-human; a human
 * row with this label is never admitted (it has a real label path).
 */
export const MACHINE_SEGMENT_LABEL_FOR_FIT: Readonly<Record<string, string>> = {
  compute_policy: 'machine',
};

/**
 * Is `question` the one the purpose's act consumer keys on (ACT_POLICIES;
 * '*' = every question the purpose asks)? A purpose without a policy counts
 * every question. The ONE rule behind the write-time act-band window
 * (decision-gate isActQuestion) and, since the 2026-09-26 audit
 * (telemetry-readiness-8), the OFFLINE fit / ruler admission
 * (fitAdmitsQuestion). Pure.
 */
export function isActQuestionOf(purpose: string, question: string): boolean {
  const policy = ACT_POLICIES[purpose];
  return !policy || policy.question === '*' || policy.question === question;
}

/**
 * Audit 2026-09-26 (telemetry-readiness-8): does the OFFLINE temperature fit
 * / readiness ruler admit an outcome row on `question` for `purpose`? Only
 * the purpose's ACT question — the population the act consumer is judged on
 * and the write-time act-band window already keys on. Pooling every question
 * (compute_policy's `research_request` next to `depth`, self_audit's
 * claims_unbacked / steps_unbacked / step_<k>, checker_route's
 * needs_live_web) doubled n toward the ≥200 bar and, for compute_policy, put
 * one near-guaranteed high-confidence disagreement per L2 Dig-deeper tap
 * into AUROC / coverage@5 (a FALSE NOT READY and a corrupted fit — never a
 * false admission). Kill switch `DECISION_GATE_FIT_POOL_QUESTIONS=1`
 * restores the pooled population (the write-time window is NOT affected).
 */
export function fitAdmitsQuestion(purpose: string, question: string, env: Record<string, string | undefined> = process.env): boolean {
  if (fitPoolsQuestions(env)) return true;
  return isActQuestionOf(purpose, question);
}

/** DECISION_GATE_FIT_POOL_QUESTIONS=1 — the offline fit / ruler pool every question of a purpose again (pre-audit behaviour). */
export function fitPoolsQuestions(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.DECISION_GATE_FIT_POOL_QUESTIONS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** False when the outcome row carries a label the purpose's fit does not use. Pure. */
export function outcomeLabelEntersFit(purpose: string, label: unknown): boolean {
  const want = OUTCOME_LABEL_FOR_FIT[purpose];
  if (!want || typeof label !== 'string' || !label) return true;
  return label === want;
}

/**
 * cp/labels (2026-09-26): a multi-label purpose's SECONDARY row that stands in
 * for the primary when the primary can no longer arrive. compute_policy's
 * primary `escalated` is written at the Dig-deeper tap ≤ 30 min after the
 * answer posted (or by a window closer as escalated:false — none runs today),
 * so a decision with NO escalated row is labelled by its finalize `facts` row
 * ONCE that row is older than the escalation window: the depth actual a
 * windowClosed row would carry is exactly the facts row's (both derive the
 * base depth from the same harness facts — decision-outcome-labels
 * deriveComputePolicyDepthActual). The rule is applied by the OFFLINE
 * pairings only (pairDecisionRows / pairReadinessRows — the temperature fit
 * and the readiness ruler, which know `now`); the write-time act-band window
 * (decision-gate recordDecisionOutcome → outcomeLabelEntersFit) still admits
 * only the primary, because at write time the window is open. `afterMs`
 * mirrors decision-outcome-labels COMPUTE_POLICY_ESCALATION_WINDOW_MS (pinned
 * by test; not imported — that module imports this one).
 */
export const OUTCOME_LABEL_FALLBACK_FOR_FIT: Readonly<Record<string, { label: string; afterMs: number }>> = {
  compute_policy: { label: 'facts', afterMs: 30 * 60_000 },
  // backlog E10 (2026-09-28): the harness row (the deterministic diff's verdict, written by the window closer ≥ 30 min
  // after the reconcile) stands in whenever no human row exists for the decision — it is already past the window.
  revision_material: { label: 'harness', afterMs: 0 },
};

// ── Sender-segment partition (2026-09-26 audit — telemetry-readiness-9) ──────
// Since the "Auto for every chat" directive the compute_policy gate is asked for
// supervisor chats and machine wakes too. Those rows carry meta.segment
// ('supervisor' | 'machine' — decide() opts.segment, stamped on the decision,
// challenger AND outcome rows) but no harness label can exist for them yet (no
// Dig-deeper chip / thumbs / re-ask on a wake; the chip is disabled on
// supervisor chats), so pooling them with user / guest turns would (a) count
// unlabelled machine asks as the human backend's calls and (b) admit the
// supervisor human turns' structurally-negative `facts` fallback rows into
// the human READY sample. The pairings below key a NON-HUMAN segment's rows
// into their OWN (backendSpec, purpose, segment) group, which the stamp never
// follows and readinessVerdict never calls READY. Human rows (no segment, or
// 'user' / 'guest' / a channel segment) pool exactly as before.

/** Segments whose rows never enter the human READY sample (no harness label exists for them). */
// 'replay' (2026-10-04): the nightly live-chat audit's re-asks (platform/live-chat-audit.ts REPLAY_SEGMENT) — offline,
// never answered, never labelled; partitioned so they can never pool into the human READY sample or its health counters.
export const NON_HUMAN_SEGMENTS: ReadonlySet<string> = new Set(['machine', 'supervisor', 'replay']);

/** The PARTITION segment of a row: meta.segment when it names a non-human segment; undefined otherwise (human rows pool). Pure. */
export function partitionSegmentOfRow(m: { segment?: unknown } | null | undefined): string | undefined {
  const s = typeof m?.segment === 'string' ? m.segment : '';
  return NON_HUMAN_SEGMENTS.has(s) ? s : undefined;
}

/** backlog DOI-21: is this outcome row a non-human segment's OWN harness-label row (MACHINE_SEGMENT_LABEL_FOR_FIT)? Pure. */
export function isMachineSegmentLabelRow(purpose: string, m: { label?: unknown; segment?: unknown } | null | undefined): boolean {
  const want = MACHINE_SEGMENT_LABEL_FOR_FIT[purpose];
  if (!want || m?.label !== want) return false;
  return partitionSegmentOfRow(m) !== undefined;
}

/** The dedupe key of a primary-labelled outcome row: purpose + decision id + question. */
const primaryKey = (purpose: string, id: unknown, question: unknown): string => `${purpose}\u0000${String(id)}\u0000${String(question)}`;

/**
 * Every (purpose, decision id, question) that carries the purpose's PRIMARY
 * fit label in `rows` — the set a fallback row is checked against. Pure.
 */
export function primaryLabelledKeys(rows: ReadonlyArray<{ meta: any }>): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const m = r?.meta;
    if (!m || m.phase !== 'outcome' || !m.id || !m.question) continue;
    const purpose = String(m.purpose || '');
    const want = OUTCOME_LABEL_FOR_FIT[purpose];
    if (!want || m.label !== want) continue;
    out.add(primaryKey(purpose, m.id, m.question));
  }
  return out;
}

/**
 * Does this outcome row enter the OFFLINE fit / ruler for `purpose`? The
 * primary label (or no label) as outcomeLabelEntersFit; the fallback label
 * only when no primary row exists for the same (id, question) AND the row is
 * older than the fallback's window as of `nowMs`. Pure.
 */
export function outcomeRowEntersFit(purpose: string, m: { id?: unknown; question?: unknown; label?: unknown; excludeFromFit?: unknown; segment?: unknown }, opts: { primary: ReadonlySet<string>; rowAtMs: number; nowMs: number; env?: Record<string, string | undefined> }): boolean {
  // 2026-09-26 (audit): a row the writer marked as a measured fact but NOT a label (a compute_policy
  // `facts` row on a turn whose Dig-deeper chip was never shown) never enters — it would otherwise
  // become the window-closed NEGATIVE for a decision that could never be tapped.
  if (m?.excludeFromFit === true) return false;
  // backlog DOI-21 (2026-09-28): a non-human segment's own harness label (MACHINE_SEGMENT_LABEL_FOR_FIT).
  if (isMachineSegmentLabelRow(purpose, m)) return true;
  if (outcomeLabelEntersFit(purpose, m?.label)) return true;
  const fb = OUTCOME_LABEL_FALLBACK_FOR_FIT[purpose];
  if (!fb || m?.label !== fb.label) return false;
  if (opts.primary.has(primaryKey(purpose, m.id, m.question))) return false;
  if (!(opts.rowAtMs > 0) || !(opts.nowMs > 0)) return false;
  return opts.nowMs - opts.rowAtMs >= fb.afterMs;
}

/** The purpose's REAL acting cutoff τ: env DECISION_GATE_THRESHOLD_<PURPOSE>
 *  (the same variable decisionThreshold() reads), else the consumer's default
 *  (per option for choice purposes), clamped to [0.5, 1] like the runtime. */
export function purposeCutoff(purpose: string, env: Record<string, string | undefined> = {}, option?: string | null): number {
  const policy = ACT_POLICIES[purpose];
  const fallback = policy ? ((option ? policy.optionThresholds?.[option] : undefined) ?? policy.defaultThreshold) : 0.85;
  // Audit 2026-09-26 (settings-switches-1): the per-OPTION env the act site reads
  // (decision-gate decisionOptionThreshold) wins over the generic one, and a BLANK
  // value (compose `${VAR:-}` passthrough) is UNSET — `Number('')` is 0, which the
  // clamp used to turn into a 0.5 cutoff the ruler / auto-demote then measured at.
  const optionRaw = option ? envThresholdNumber(env[`DECISION_GATE_THRESHOLD_${purpose.toUpperCase()}_${String(option).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`]) : null;
  const raw = optionRaw ?? envThresholdNumber(env[`DECISION_GATE_THRESHOLD_${purpose.toUpperCase()}`]);
  let v = raw ?? fallback;
  // auto_route's Level 3 floor (auto-router-gate AUTO_ROUTE_L3_THRESHOLD_FLOOR): the generic env can never lower it.
  if (purpose === 'auto_route' && option === 'deep_research' && optionRaw === null) v = Math.max(v, 0.85);
  return Math.min(1, Math.max(0.5, v));
}

/** A threshold env value as a number, or null when unset / blank / garbage (mirrors decision-gate thresholdEnvNumber — this module is import-free of it). */
function envThresholdNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The compact predicted view an outcome row carries (meta.predicted) / a decision row's meta.answers[q]. */
export interface PredictedView { noul?: number; choice?: string; score?: number; confidence?: number; probabilities?: Record<string, number> }

export interface ActBandVerdict {
  /** Would the consumer act on this answer at τ? */
  inBand: boolean;
  /** The τ applied. */
  threshold: number;
  /** The answer the consumer would act on, in the outcome vocabulary ('no' for a noul_low park/skip; the choice key; the rounded score). */
  actKey: string | null;
  /** score_low only: EVERY actual key under which acting was right (levels 0..maxScore) — actKeyMatches reads it. */
  actKeys?: string[];
}

/** Was acting on this band right for the observed actual key? (score_low: the actual level is within the acted band; else exact.) */
export function actKeyMatches(band: ActBandVerdict, actualKey: string | null): boolean {
  if (actualKey === null || band.actKey === null) return false;
  return band.actKeys ? band.actKeys.includes(actualKey) : band.actKey === actualKey;
}

/**
 * Is a predicted answer inside the purpose's ACT band at τ (default: the real
 * cutoff from env / the consumer's default)? noul_low purposes act when
 * noul ≤ 1 − τ (+1e-9, the consumers' floating-point guard); choice_high
 * purposes act when confidence ≥ τ. Unknown purpose / no prediction → never.
 */
export function actBand(purpose: string, predicted: PredictedView | null | undefined, env: Record<string, string | undefined> = {}, thresholdOverride?: number, answers?: Record<string, PredictedView>): ActBandVerdict {
  const policy = ACT_POLICIES[purpose];
  if (!policy || !predicted) return { inBand: false, threshold: thresholdOverride ?? purposeCutoff(purpose, env), actKey: null };
  // A compound consumer rule (compute_policy) — never the plain single-threshold band.
  if (policy.band && thresholdOverride === undefined) return policy.band(predicted, answers, env);
  if (policy.kind === 'noul_low') {
    const t = thresholdOverride ?? purposeCutoff(purpose, env);
    const p = typeof predicted.noul === 'number' && Number.isFinite(predicted.noul) ? predicted.noul : null;
    return { inBand: p !== null && p <= 1 - t + 1e-9, threshold: t, actKey: 'no' };
  }
  if (policy.kind === 'noul_high') {
    // N5 (2026-09-25): the HIGH side acts — "evidenced" skips the LLM lane.
    const t = thresholdOverride ?? purposeCutoff(purpose, env);
    const p = typeof predicted.noul === 'number' && Number.isFinite(predicted.noul) ? predicted.noul : null;
    return { inBand: p !== null && p >= t - 1e-9, threshold: t, actKey: 'yes' };
  }
  if (policy.kind === 'score_low') {
    const t = thresholdOverride ?? purposeCutoff(purpose, env);
    const maxScore = Math.max(0, Math.floor(policy.maxScore ?? 0));
    const s = typeof predicted.score === 'number' && Number.isFinite(predicted.score) ? Math.round(predicted.score) : null;
    const c = typeof predicted.confidence === 'number' && Number.isFinite(predicted.confidence) ? predicted.confidence : null;
    const actKeys = Array.from({ length: maxScore + 1 }, (_, i) => String(i));
    return { inBand: s !== null && c !== null && s <= maxScore && c >= t - 1e-9, threshold: t, actKey: s === null ? null : String(s), actKeys };
  }
  const choice = typeof predicted.choice === 'string' ? predicted.choice : null;
  const t = thresholdOverride ?? purposeCutoff(purpose, env, choice);
  const c = typeof predicted.confidence === 'number' && Number.isFinite(predicted.confidence) ? predicted.confidence : null;
  return { inBand: choice !== null && c !== null && c >= t, threshold: t, actKey: choice };
}

/** The argmax of a predicted view in the outcome vocabulary (actualToKey's). */
export function predictedKey(p: PredictedView | null | undefined): string | null {
  if (!p) return null;
  if (typeof p.noul === 'number') return p.noul >= 0.5 ? 'yes' : 'no';
  if (typeof p.choice === 'string') return p.choice;
  if (typeof p.score === 'number') return String(Math.round(p.score));
  return null;
}

/** The confidence a consumer compares against τ (confidenceOf's rule, on the compact view). */
export function predictedConfidence(p: PredictedView | null | undefined): number | null {
  if (!p) return null;
  if (typeof p.noul === 'number') return Math.max(p.noul, 1 - p.noul);
  if (typeof p.confidence === 'number') return p.confidence;
  return null;
}

/** One labelled decision, ready for the readiness metrics. */
export interface ReadinessSample {
  id: string;
  question: string;
  predicted: PredictedView;
  predictedKey: string | null;
  /** max(p, 1−p) for a noul; the choice/score confidence otherwise. */
  confidence: number;
  actual: string;
  /** Argmax agreement (the 0.5 rule — what the outcome row's `agreed` records). */
  agreed: boolean;
  sessionId?: string;
  /** Epoch ms of the decision (the outcome's time when the decision row is gone). */
  at: number;
  /** Dedupe key: meta.stateHash when stamped, else sha256 of a stored state text, else undefined (no dedupe possible). */
  stateKey?: string;
  /** Partition key: meta.questionsHash when stamped, else '' (one partition). */
  questionsHash: string;
  /** The gate ACTED on this row (actual is then the acted answer's own vocabulary — excluded from labels, except for a USER-labelled purpose whose label is independent of the act — compute_policy). */
  acted: boolean;
  /** The decision's other answers (compound act bands read e.g. the `stakes` noul next to `depth`). */
  answers?: Record<string, PredictedView>;
  /** The sender segment the decision / outcome row carried (user / guest / supervisor / machine / telegram). */
  segment?: string;
  /** agent-decisions 2026-09-27: the outcome row was a heartbeat-floor CONTROL turn (meta.control from the consumer's stash extra) — the skip band's only labelled rows under an act purpose that skips work. */
  control?: boolean;
  /** A guest turn (its `facts` row never stands in for a window-closed negative — a guest cannot escalate). */
  guest?: boolean;
  /** backlog DOI-21 (2026-09-28): the row is a non-human segment's HARNESS-PROXY label (MACHINE_SEGMENT_LABEL_FOR_FIT) — the partition's own label; readinessVerdict lifts the "no label exists" bar when every sample carries it. */
  harnessLabel?: boolean;
}

/**
 * Purposes whose PRIMARY label is a USER signal independent of the act (a Dig-deeper tap
 * / its window closing), so an ACTED decision's outcome row is still a valid sample
 * (audit 2026-09-26 telemetry-readiness-1: dropping acted rows made every acted skip
 * invisible while its tap counted as a disagreement).
 */
export const USER_LABELLED_PURPOSES: ReadonlySet<string> = new Set(['compute_policy']);

/** Segments whose rows never feed a purpose's HUMAN readiness (audit 2026-09-26 supervisors-auto-5): they need their own stamp before an act flip may govern them. */
export const MACHINE_SEGMENTS: ReadonlySet<string> = new Set(['machine', 'supervisor']);

export interface ReadinessGroup {
  backend: string;
  /** 2026-09-26: the backend identity the group is keyed by (backendSpecOfRow: meta.backendSpec, else the label's spec, else the label). */
  backendSpec: string;
  /** The backend's client kind (newest decision row; undefined when no row says). */
  kind?: BackendKind;
  purpose: string;
  /** 2026-09-26 (audit): set ⇒ this group holds ONLY a non-human segment's rows ('machine' | 'supervisor') — never the stamp, never READY (NON_HUMAN_SEGMENTS). Absent on the pooled human group. */
  segment?: string;
  samples: ReadinessSample[];
  /** Rows dropped as exact repeats (same question + stateKey) — the 362/482 wake_triage busy re-asks. */
  deduped: number;
  /** Rows that could not be deduped because no stateHash / state text was stored. */
  undedupable: number;
  /** Audit 2026-09-26: labelled outcome rows dropped because their question is not the purpose's ACT question (fitAdmitsQuestion) — never part of n. */
  offQuestion: number;
  // ── 2026-09-26 (plan E): the per-backend comparison numbers, from DECISION rows ──
  /** The NEWEST decision row's meta.calibrated (undefined when no row carries the flag — pre-E2 rows). */
  calibratedNewest?: boolean;
  /** The NEWEST decision row of the group was a shadow challenger row (challenger:true). Newest-row semantics (review 2026-09-26): after a promotion the group keeps its challenger-era rows for the rest of the window, and a promoted backend must read as the answering backend, a demoted one as the challenger. */
  challenger: boolean;
  /** Decision rows of the group that were challenger rows — next to `calls` this shows a mixed window (a promotion / demotion inside it). */
  challengerRows: number;
  /** Decision rows attributed to this backend: the rows it answered (ok:true / its own ok:false rows) + earlier-leg failures named in meta.legErrors. */
  calls: number;
  /** …of which failed (ok:false rows, incl. challenger timeouts, + legErrors mentions). */
  fails: number;
  /** Latencies (row `value`, ms) of the rows it answered ok. */
  latenciesMs: number[];
  // ── audit budgets-cost-6 (2026-09-26): the silent-degradation counters ──
  /** Rows this backend answered with modeDowngrade (an act purpose served by this uncalibrated backend → the consumer ran its pre-gate path). */
  downgraded?: number;
  /** Rows this backend answered AFTER an earlier leg failed (legIndex > 0) — a calibrated primary silently swapped for this one. */
  fellThrough?: number;
  /** legErrors mentions naming this backend as LATCHED (skipped inside a 401/403 cooldown — see decision-gate.ts). Counted in `fails` too. */
  latched?: number;
}

/** sha256 hex of a stored state text (the fallback dedupe key when the gate did not stamp stateHash). */
export function stateHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A loop_metrics row as the readiness pairing reads it (sessionId is a column, not meta; `value` = the decision row's latency in ms). */
export interface ReadinessRow extends DecisionGateRow { sessionId?: string | null }

const toMs = (d: Date | string | undefined): number => {
  if (!d) return 0;
  const n = d instanceof Date ? d.getTime() : Date.parse(String(d));
  return Number.isFinite(n) ? n : 0;
};

/** The backend LABEL an earlier-leg error names (decision-gate.ts formats a leg error as `<label>: …`), or null. */
export function legErrorLabel(err: unknown): string | null {
  const s = String(err ?? '');
  const i = s.indexOf(': ');
  if (i <= 0) return null;
  const label = s.slice(0, i).trim();
  return label && label.length <= 120 ? label : null;
}

/** Nearest-rank percentile (p in [0, 1]) of a list; null when empty. */
export function percentile(values: ReadonlyArray<number>, p: number): number | null {
  const xs = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1));
  return xs[rank];
}

/**
 * Pair EVERY labelled outcome row (meta.actual !== null, acted:false) with its
 * decision row by meta.id, from meta.answers (systemone / Jev) OR meta.logits
 * (readout) OR, when the decision row is outside the window, the outcome
 * row's own meta.predicted / confidence / backend. Grouped by (backend,
 * purpose); deduped by (question, stateKey) keeping the EARLIEST row;
 * questionsHash carried for partitioning. Rows the gate acted on carry no
 * label (their actual is null) and are excluded. A purpose that writes
 * several outcome labels per decision contributes ONLY its
 * OUTCOME_LABEL_FOR_FIT row (meta.label) — the dedupe never has to pick —
 * or, cp/labels 2026-09-26, its OUTCOME_LABEL_FALLBACK_FOR_FIT row when no
 * primary row exists for the decision and the row is older than the
 * fallback's window as of `opts.now` (compute_policy: the finalize `facts`
 * row as the window-closed negative). Audit 2026-09-26
 * (telemetry-readiness-8): only rows on the purpose's ACT question enter
 * `samples` (fitAdmitsQuestion; the rest are counted in `offQuestion`) — the
 * ruler measures the question the act consumer keys on, never a pool.
 */
export function pairReadinessRows(rows: ReadinessRow[], opts: { now?: number | Date; env?: Record<string, string | undefined> } = {}): ReadinessGroup[] {
  const nowMs = opts.now instanceof Date ? opts.now.getTime() : typeof opts.now === 'number' ? opts.now : Date.now();
  const env = opts.env ?? process.env;
  const stallRetryEntriesSkipped = !decisionStallRecoveryDisabled(env as NodeJS.ProcessEnv);
  const primary = primaryLabelledKeys(rows);
  interface DecisionRef {
    backend: string; backendSpec: string; purpose: string; at: number; sessionId?: string;
    answers?: Record<string, PredictedView>; logits?: Record<string, Record<string, number>>;
    stateKey?: string; questionsHash?: string;
    /** The row's own sender segment as stamped (user / guest / telegram / machine / supervisor); the NON-HUMAN partition key is derived from it (partitionSegmentOfRow). */
    segment?: string; guest?: boolean;
  }
  const decisions = new Map<string, DecisionRef>();
  const groups = new Map<string, ReadinessGroup & { newestAt: number }>();
  /** The group for (backendSpec, purpose[, non-human segment]), created on first sight (label = the newest row's label). */
  const groupFor = (backend: string, backendSpec: string, purpose: string, segment?: string): ReadinessGroup & { newestAt: number } => {
    const gk = `${backendSpec}\u0000${purpose}\u0000${segment ?? ''}`;
    let g = groups.get(gk);
    if (!g) { g = { backend, backendSpec, purpose, ...(segment ? { segment } : {}), samples: [], deduped: 0, undedupable: 0, offQuestion: 0, challenger: false, challengerRows: 0, calls: 0, fails: 0, latenciesMs: [], downgraded: 0, fellThrough: 0, latched: 0, newestAt: -1 }; groups.set(gk, g); }
    return g;
  };
  // Labels seen on decision rows → their spec, so an earlier-leg failure named in
  // meta.legErrors ('<label>: HTTP 429 …') lands in the right group (2026-09-26, plan E).
  const specByLabel = new Map<string, string>(Object.entries(LEGACY_BACKEND_LABEL_SPECS));
  for (const r of rows) {
    const m = r?.meta;
    if (!m || m.phase !== 'decision' || typeof m.backend !== 'string' || !m.backend) continue;
    specByLabel.set(m.backend, backendSpecOfRow(m));
  }
  for (const r of rows) {
    const m = r?.meta;
    if (!m || m.phase !== 'decision' || !m.id) continue;
    const purpose = String(m.purpose || 'unknown');
    const at = toMs(r.createdAt);
    const segment = partitionSegmentOfRow(m);
    // ── plan E: calls / fails / latency per backend (every decision row, labelled or not) ──
    if (typeof m.backend === 'string' && m.backend) {
      const g = groupFor(m.backend, backendSpecOfRow(m), purpose, segment);
      g.calls += 1;
      if (m.ok === false) g.fails += 1;
      else if (typeof r.value === 'number' && Number.isFinite(r.value) && r.value >= 0 && m.cached !== true) g.latenciesMs.push(r.value);
      if (m.challenger === true) g.challengerRows += 1;
      // budgets-cost-6: the silent-degradation counters — an act ask this uncalibrated backend answered (the
      // consumer ran its pre-gate path), and an answer given only because an earlier leg failed.
      if (m.ok !== false && m.modeDowngrade) g.downgraded = (g.downgraded ?? 0) + 1;
      if (m.ok !== false && typeof m.legIndex === 'number' && m.legIndex > 0) g.fellThrough = (g.fellThrough ?? 0) + 1;
      if (at >= g.newestAt) {
        g.newestAt = at;
        g.backend = m.backend;
        g.challenger = m.challenger === true;
        const kind = backendKindOfRow(m);
        if (kind) g.kind = kind;
        if (typeof m.calibrated === 'boolean') g.calibratedNewest = m.calibrated;
      }
    }
    // Failed legs: meta.legErrors names them '<label>: …' (a later leg answered, or — since
    // the 2026-09-26 review — EVERY leg failed); a pre-change all-failed row carries only the
    // joined `error` string, split the way decide() joined it and attributed only to labels
    // the window knows (so 'invalid questions: …' never becomes a backend). Jev's fail rate
    // used to look best exactly when it was fully down — those rows named nobody.
    const fromErrorText = !Array.isArray(m.legErrors) && !m.backend && m.ok === false && typeof m.error === 'string' && m.error.includes(': ');
    const failedLegs: unknown[] = Array.isArray(m.legErrors) ? m.legErrors : fromErrorText ? String(m.error).split(' | ') : [];
    for (const e of failedLegs) {
      // Ticket 4d476b9a: a failed STALL RETRY is the same leg's second attempt within one ask — the first attempt's
      // entry already booked that call and its failure, so it is not a second one (it used to double a backend's fail
      // count in exactly the lag episodes the retry targets). DECISION_GATE_STALL_RECOVERY_DISABLED=1 in the reading
      // process counts every entry, as before the ticket.
      if (stallRetryEntriesSkipped && isStallRetryLegError(e)) continue;
      const label = legErrorLabel(e);
      if (!label) continue;
      if (fromErrorText && !specByLabel.has(label)) continue;
      const g = groupFor(label, specByLabel.get(label) ?? label, purpose, segment);
      g.calls += 1;
      g.fails += 1;
      // budgets-cost-6: a leg skipped inside its 401/403 cooldown ('<label>: latched (HTTP 403 at …)').
      if (/^[^:]+: latched \(/.test(String(e))) g.latched = (g.latched ?? 0) + 1;
    }
    // Challenger rows (2026-09-26, plan C) never pair with an outcome as the decision — the primary's row does.
    if (m.challenger === true) continue;
    const stateKey = typeof m.stateHash === 'string' && m.stateHash ? String(m.stateHash)
      : typeof m.stateText === 'string' && m.stateText ? stateHashOf(m.stateText)
        : typeof m.state === 'string' && m.state ? stateHashOf(m.state)
          : undefined;
    decisions.set(String(m.id), {
      backend: String(m.backend || 'unknown'), backendSpec: backendSpecOfRow(m), purpose, at,
      ...(r.sessionId ? { sessionId: String(r.sessionId) } : {}),
      ...(m.answers && typeof m.answers === 'object' ? { answers: m.answers } : {}),
      ...(m.logits && typeof m.logits === 'object' ? { logits: m.logits } : {}),
      ...(stateKey ? { stateKey } : {}),
      ...(typeof m.questionsHash === 'string' && m.questionsHash ? { questionsHash: String(m.questionsHash) } : {}),
      ...(typeof m.segment === 'string' && m.segment ? { segment: String(m.segment) } : {}),
      ...(m.guest === true ? { guest: true } : {}),
    });
  }
  for (const r of rows) {
    const m = r?.meta;
    if (!m || m.phase !== 'outcome' || !m.id || !m.question) continue;
    const purposeOfRow = String(m.purpose || decisions.get(String(m.id))?.purpose || 'unknown');
    if (m.acted === true && !USER_LABELLED_PURPOSES.has(purposeOfRow)) continue;
    // A guest's `facts` row can never stand in for the window-closed NEGATIVE
    // (a guest cannot escalate — audit 2026-09-26 guest-persistence-2).
    if (m.guest === true && OUTCOME_LABEL_FALLBACK_FOR_FIT[purposeOfRow] && m.label === OUTCOME_LABEL_FALLBACK_FOR_FIT[purposeOfRow].label) continue;
    // A challenger's own outcome row (plan C) is judged under its own group only through its decision row — never as the primary's label.
    if (m.challenger === true) continue;
    const actual = actualToKey(m.actual);
    if (actual === null) continue;
    const d = decisions.get(String(m.id));
    const question = String(m.question);
    let predicted: PredictedView | null = null;
    if (d?.answers?.[question] && typeof d.answers[question] === 'object') predicted = d.answers[question];
    else if (d?.logits?.[question] && typeof d.logits[question] === 'object') {
      const keys = Object.keys(d.logits[question]);
      const dist = distributionFromLogits(d.logits[question], keys, 1);
      if (keys.length === 2 && 'yes' in dist && 'no' in dist) predicted = { noul: dist.yes };
      else {
        const best = keys.reduce((a, k) => (dist[k] > dist[a] ? k : a), keys[0]);
        predicted = { choice: best, confidence: dist[best], probabilities: dist };
      }
    } else if (m.predicted && typeof m.predicted === 'object') predicted = m.predicted;
    if (!predicted) continue;
    const key = predictedKey(predicted);
    const confidence = predictedConfidence(predicted) ?? (typeof m.confidence === 'number' ? m.confidence : null);
    if (key === null || confidence === null) continue;
    const backend = d?.backend ?? String(m.backend || 'unknown');
    const backendSpec = d?.backendSpec ?? backendSpecOfRow(m);
    const purpose = d?.purpose ?? String(m.purpose || 'unknown');
    // The outcome row carries the segment too (row-own meta.segment from the stash) — the partition
    // holds even when the decision row fell out of the window. The raw stamp rides the sample; only
    // a NON-HUMAN segment (machine / supervisor) keys its own group (partitionSegmentOfRow).
    const segment = (typeof m.segment === 'string' && m.segment) ? String(m.segment) : d?.segment;
    const partition = partitionSegmentOfRow({ segment });
    if (!outcomeRowEntersFit(purpose, { ...m, segment }, { primary, rowAtMs: toMs(r.createdAt), nowMs, env })) continue;
    if (!fitAdmitsQuestion(purpose, question, env)) { groupFor(backend, backendSpec, purpose, partition).offQuestion += 1; continue; }
    const harnessLabel = isMachineSegmentLabelRow(purpose, { label: m.label, segment });
    const stateKey = d?.stateKey ?? (typeof m.stateHash === 'string' && m.stateHash ? String(m.stateHash) : undefined);
    // The decision's other answers for a compound band; an orphan outcome row carries `stakes` on its extra.
    const answers: Record<string, PredictedView> | undefined = d?.answers
      ?? (typeof m.stakes === 'number' && Number.isFinite(m.stakes) ? { stakes: { noul: m.stakes } } : undefined);
    const sample: ReadinessSample = {
      id: String(m.id), question, predicted, predictedKey: key, confidence, actual,
      agreed: typeof m.agreed === 'boolean' ? m.agreed : key === actual,
      ...(d?.sessionId || r.sessionId ? { sessionId: String(d?.sessionId || r.sessionId) } : {}),
      at: d?.at || toMs(r.createdAt),
      ...(stateKey ? { stateKey } : {}),
      questionsHash: d?.questionsHash ?? (typeof m.questionsHash === 'string' ? String(m.questionsHash) : ''),
      acted: m.acted === true,
      ...(answers ? { answers } : {}),
      ...(segment ? { segment } : {}),
      ...(m.guest === true || d?.guest ? { guest: true } : {}),
      ...(m.control === true ? { control: true } : {}),
      ...(harnessLabel ? { harnessLabel: true } : {}),
    };
    groupFor(backend, backendSpec, purpose, partition).samples.push(sample);
  }
  for (const g of groups.values()) {
    g.samples.sort((a, b) => a.at - b.at);
    const seen = new Set<string>();
    const kept: ReadinessSample[] = [];
    for (const s of g.samples) {
      if (!s.stateKey) { g.undedupable += 1; kept.push(s); continue; }
      const k = `${s.question}\u0000${s.questionsHash}\u0000${s.stateKey}`;
      if (seen.has(k)) { g.deduped += 1; continue; }
      seen.add(k);
      kept.push(s);
    }
    g.samples = kept;
  }
  return [...groups.values()]
    .sort((a, b) => a.purpose.localeCompare(b.purpose) || (a.segment ?? '').localeCompare(b.segment ?? '') || b.samples.length - a.samples.length || b.calls - a.calls)
    .map(({ newestAt: _n, ...g }) => g);
}

/**
 * Area under the ROC curve of `scores` as a detector of `positives`
 * (Mann–Whitney U with ties counted half). NaN when either class is empty.
 * The report calls it with score = 1 − confidence and positive = disagreed,
 * i.e. "does low confidence find the errors?" (the paper's decisive metric).
 */
export function auroc(scores: number[], positives: boolean[]): number {
  const n = Math.min(scores.length, positives.length);
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < n; i++) (positives[i] ? pos : neg).push(scores[i]);
  if (!pos.length || !neg.length) return NaN;
  const sortedNeg = [...neg].sort((a, b) => a - b);
  let sum = 0;
  for (const p of pos) {
    // count negatives < p (full) and == p (half) by binary search
    let lo = 0; let hi = sortedNeg.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sortedNeg[mid] < p) lo = mid + 1; else hi = mid; }
    const below = lo;
    let hi2 = sortedNeg.length; let lo2 = lo;
    while (lo2 < hi2) { const mid = (lo2 + hi2) >> 1; if (sortedNeg[mid] <= p) lo2 = mid + 1; else hi2 = mid; }
    const equal = lo2 - below;
    sum += below + equal / 2;
  }
  return sum / (pos.length * neg.length);
}

export interface CoverageResult {
  /** Fraction of rows the gate could answer while keeping error ≤ maxError (0 when even the most confident row errs). */
  coverage: number;
  /** The confidence cutoff that achieves it (rows with confidence ≥ this are covered), or null. */
  threshold: number | null;
  /** Rows covered / errors among them. */
  n: number;
  errors: number;
}

/**
 * The risk–coverage curve's operating point: sort by confidence descending,
 * take the largest prefix (whole confidence ties included) whose error rate
 * is ≤ maxError. Coverage is its share of all rows.
 */
export function coverageAtError(samples: ReadonlyArray<{ confidence: number; agreed: boolean }>, maxError = 0.05): CoverageResult {
  if (!samples.length) return { coverage: 0, threshold: null, n: 0, errors: 0 };
  const sorted = [...samples].sort((a, b) => b.confidence - a.confidence);
  let errors = 0;
  let best: CoverageResult = { coverage: 0, threshold: null, n: 0, errors: 0 };
  for (let i = 0; i < sorted.length; i++) {
    if (!sorted[i].agreed) errors += 1;
    // Only cut at a confidence boundary: a threshold cannot split equal confidences.
    if (i + 1 < sorted.length && sorted[i + 1].confidence === sorted[i].confidence) continue;
    const n = i + 1;
    if (errors / n <= maxError) best = { coverage: n / sorted.length, threshold: sorted[i].confidence, n, errors };
  }
  return best;
}

export interface ActBandStats {
  /** Rows the consumer WOULD act on at τ. */
  n: number;
  /** …of which the acted answer matched the reasoning path. */
  correct: number;
  /** correct / n (NaN when n = 0). */
  precision: number;
  /**
   * Wilson 95% LOWER bound of `precision` (NaN when n = 0). The readiness
   * bar's statistic since 2026-09-26 (R&D exp #6): the admission side is the
   * incident-class twin of E12's demotion rule — 6498712b6 put the burden of
   * proof on the DEMOTION (demote iff wilsonUpper95 < bar), so the mirror
   * here puts the burden of proof on the GRANT: a purpose is READY only when
   * its act-band precision is CONFIDENTLY at the bar, not when the point
   * estimate happens to clear it (19/20 = 0.950 point, LB 0.764 — one label
   * of noise must not admit an act flip; the flip's own auto-demote would
   * then fire on the same noise in the other direction).
   */
  lower95: number;
  /** n / all labelled rows — what act mode would shed. */
  coverage: number;
  /** The τ applied (the purpose's real cutoff unless overridden). */
  threshold: number;
}

/** Precision inside the act band at the purpose's real cutoff (or an override τ). */
export function actBandStats(samples: ReadonlyArray<ReadinessSample>, purpose: string, env: Record<string, string | undefined> = {}, thresholdOverride?: number): ActBandStats {
  let n = 0; let correct = 0;
  let threshold = thresholdOverride ?? purposeCutoff(purpose, env);
  for (const s of samples) {
    const band = actBand(purpose, s.predicted, env, thresholdOverride, s.answers);
    threshold = band.threshold;
    if (!band.inBand) continue;
    n += 1;
    if (actKeyMatches(band, s.actual)) correct += 1;
  }
  return { n, correct, precision: n ? correct / n : NaN, lower95: n ? wilsonInterval(correct, n).lower : NaN, coverage: samples.length ? n / samples.length : 0, threshold };
}

/** Mean Brier score on the compact views (noul: (p − y)²; choice/score with probabilities: Σ(p_k − y_k)²; else (conf − hit)²). */
export function readinessBrier(samples: ReadonlyArray<ReadinessSample>): number {
  if (!samples.length) return NaN;
  let total = 0;
  for (const s of samples) {
    const p = s.predicted;
    if (typeof p.noul === 'number') { const y = s.actual === 'yes' ? 1 : 0; total += (p.noul - y) ** 2; continue; }
    if (p.probabilities && typeof p.probabilities === 'object') {
      let sum = 0;
      let sawActual = false;
      for (const [k, v] of Object.entries(p.probabilities)) { const y = k === s.actual ? 1 : 0; if (y) sawActual = true; sum += (Number(v) - y) ** 2; }
      if (!sawActual) sum += 1; // the actual option had zero mass
      total += sum; continue;
    }
    total += (s.confidence - (s.agreed ? 1 : 0)) ** 2;
  }
  return total / samples.length;
}

/** ECE of the reported confidence vs argmax agreement over 10 equal-width bins. */
export function readinessEce(samples: ReadonlyArray<ReadinessSample>, bins = 10): number {
  if (!samples.length) return NaN;
  const sums = new Array(bins).fill(0).map(() => ({ n: 0, conf: 0, hit: 0 }));
  for (const s of samples) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor(s.confidence * bins)));
    sums[b].n += 1; sums[b].conf += s.confidence; sums[b].hit += s.agreed ? 1 : 0;
  }
  let out = 0;
  for (const bin of sums) { if (bin.n) out += (bin.n / samples.length) * Math.abs(bin.conf / bin.n - bin.hit / bin.n); }
  return out;
}

export interface ThresholdSearch {
  /** The loosest τ on the selection set with act-band precision ≥ bar and ≥ minActN rows in the band. */
  threshold: number;
  selection: { n: number; band: ActBandStats };
  holdout: { n: number; band: ActBandStats };
}

/**
 * The paper's frozen-policy rule (§7): choose τ on a SELECTION set to
 * maximise coverage subject to the precision bar, then report the HELD-OUT
 * numbers at that τ. The split is 60/40 by time, clustered so that a
 * session's rows from ONE UTC day never straddle the cut (wake re-asks of the
 * same chat on the same day are correlated). The cluster is (session, day)
 * rather than the whole session because prod's wake_triage sessions are the
 * handful of long-lived supervisor chats — clustering by session alone would
 * put every row on the selection side and leave nothing held out. null when
 * no τ qualifies or either side is empty. A suggestion for the report only —
 * the runtime never reads it.
 */
export function searchThreshold(samples: ReadonlyArray<ReadinessSample>, purpose: string, opts: { precisionBar?: number; minActN?: number } = {}): ThresholdSearch | null {
  const bar = opts.precisionBar ?? READINESS_BARS.minActBandPrecision;
  const minActN = opts.minActN ?? 10;
  if (samples.length < 2 || !ACT_POLICIES[purpose]) return null;
  const ordered = [...samples].sort((a, b) => a.at - b.at);
  // Cluster by (session, UTC day): a cluster goes to the side its FIRST row falls on.
  const side = new Map<string, 'sel' | 'hold'>();
  const selection: ReadinessSample[] = [];
  const holdout: ReadinessSample[] = [];
  const cut = Math.ceil(ordered.length * 0.6);
  ordered.forEach((s, i) => {
    const cluster = `${s.sessionId ?? `row:${s.id}`}\u0000${Math.floor(s.at / 86_400_000)}`;
    let which = side.get(cluster);
    if (!which) { which = i < cut ? 'sel' : 'hold'; side.set(cluster, which); }
    (which === 'sel' ? selection : holdout).push(s);
  });
  if (!selection.length || !holdout.length) return null;
  let best: ThresholdSearch | null = null;
  for (let t = 0.5; t <= 0.99 + 1e-9; t += 0.01) {
    const tau = Number(t.toFixed(2));
    const band = actBandStats(selection, purpose, {}, tau);
    if (band.n < minActN || !(band.precision >= bar)) continue;
    if (!best || band.coverage > best.selection.band.coverage) {
      best = { threshold: tau, selection: { n: selection.length, band }, holdout: { n: holdout.length, band: actBandStats(holdout, purpose, {}, tau) } };
    }
  }
  return best;
}

/** The common flip bar (doc §6): every number a purpose must clear before an admin may put it in act. */
export const READINESS_BARS = {
  /** ≥ 200 labelled outcomes after dedupe, in the newest questionsHash partition. */
  minLabels: 200,
  /** …spanning ≥ 3 days. */
  minDays: 3,
  /** Precision inside the act band at the real cutoff ≥ 0.9… */
  minActBandPrecision: 0.9,
  /** …measured on at least this many act-band rows (precision on 3 rows is noise). */
  minActBandN: 20,
  /** AUROC(1 − confidence vs disagreement) ≥ 0.8. */
  minAuroc: 0.8,
  /** Coverage at ≤ 5 % error ≥ 0.6. */
  minCoverageAt5: 0.6,
  /** imessage_send: ≥ 30 labelled POSITIVE sends (the only class that matters there). */
  imessageMinPositives: 30,
} as const;

// ── backlog E11 (2026-09-28): VOLUME-SCALED label floor + degenerate-label exemption ──
// The fixed 200-label floor inside a 14-day window is structurally unreachable
// for a purpose under ~14 labels/day (browser_driver 42 decisions / 7 d, imessage_send
// 8 labels / 2.3 d, …). The floor a purpose must clear is now scaled to ITS OWN
// observed label rate: READINESS_VOLUME_SCALE_DAYS (10) days' worth of labels,
// clamped to [READINESS_MIN_LABELS_FLOOR (50), the purpose's base floor (200)].
// The Wilson-LB precision bar, the band-row count, the span and the AUROC /
// coverage bars are UNCHANGED — the scaling only decides how many labels count
// as "enough evidence" for a low-volume purpose. A near-degenerate label set
// (one class under READINESS_DEGENERATE_MINORITY_SHARE of n — claim_evidenced
// 4 negatives / 430) cannot produce a meaningful AUROC / coverage@5 (both need
// both classes); those two bars are replaced by the precision bar alone there.
export const READINESS_MIN_LABELS_FLOOR = 50;
export const READINESS_VOLUME_SCALE_DAYS = 10;
export const READINESS_DEGENERATE_MINORITY_SHARE = 0.05;
/** The rule, stated once for the registry / docs. */
export const READINESS_VOLUME_RULE = `label floor = clamp(${READINESS_VOLUME_SCALE_DAYS} × observed labels/day, ${READINESS_MIN_LABELS_FLOOR}, the purpose's base floor); AUROC / coverage bars are waived when one label class is under ${Math.round(READINESS_DEGENERATE_MINORITY_SHARE * 100)} % of n (precision bar only)`;

/** Observed labels per day over the sample span (a span under one day counts as one day). Pure. */
export function labelsPerDayOf(n: number, days: number): number {
  return n / Math.max(1, days);
}

/** The effective label floor for a purpose given its observed rate (see the block above); the base floor with no labels at all (no rate observed). Pure. */
export function volumeScaledMinLabels(base: number, n: number, days: number): number {
  if (!(n > 0)) return base;
  const scaled = Math.round(READINESS_VOLUME_SCALE_DAYS * labelsPerDayOf(n, days));
  return Math.min(base, Math.max(Math.min(base, READINESS_MIN_LABELS_FLOOR), scaled));
}

/**
 * One label class under READINESS_DEGENERATE_MINORITY_SHARE of n — AUROC / coverage are not
 * measurable, the precision bar is. BOTH classes must exist: a set with NO minority row at all
 * is a label writer that never fires, not a rare class — it keeps the "AUROC n/a" missed bar. Pure.
 */
export function labelsDegenerate(m: Pick<ReadinessMetrics, 'n' | 'positives' | 'negatives'>): boolean {
  if (!(m.n > 0)) return false;
  const minority = Math.min(m.positives, m.negatives);
  return minority >= 1 && minority / m.n < READINESS_DEGENERATE_MINORITY_SHARE;
}

export interface ReadinessMetrics {
  /** Samples of the newest partition left out because their segment is machine / supervisor (audit 2026-09-26). */
  machineExcluded?: number;
  n: number;
  days: number;
  accuracy: number;
  brier: number;
  ece: number;
  auroc: number;
  coverageAt5: CoverageResult;
  actBand: ActBandStats;
  /** Labelled rows whose actual is the "positive" key (yes / the acted choice) — recall visibility. */
  positives: number;
  negatives: number;
  /** agent-decisions 2026-09-27: heartbeat-floor CONTROL rows in the partition (meta.control) and how many of them ACTED (the positive key) — the skip band's own action rate under an act purpose. */
  controls?: { n: number; positives: number };
  // ── backlog E11 / DOI-21 (2026-09-28): volume-scaled floor + the non-human segment's own label ──
  /** Observed labels per day over the partition's span (n / max(1, days)). */
  labelsPerDay?: number;
  /** The label floor this partition is judged against (volumeScaledMinLabels). */
  minLabelsEffective?: number;
  /** One label class under READINESS_DEGENERATE_MINORITY_SHARE — the AUROC / coverage bars were waived (precision bar only). */
  degenerateLabels?: boolean;
  /** Samples that are the segment's HARNESS-PROXY label (ReadinessSample.harnessLabel) — a non-human partition is judged on its own when every sample is one. */
  harnessLabelled?: number;
  deduped: number;
  undedupable: number;
  /** Rows per questionsHash partition (the newest partition is what the verdict measures). */
  partitions: Record<string, number>;
  partition: string;
  suggestedThreshold: ThresholdSearch | null;
  // ── 2026-09-26 (plan E): per-backend comparison — over EVERY decision row of the group, not only the newest partition ──
  /** Decision rows attributed to the backend (answered + its own failures + earlier-leg failures naming it). */
  calls: number;
  fails: number;
  /** fails / calls (NaN when calls = 0). */
  failRate: number;
  /** Latency percentiles (ms) of the rows it answered ok; null when none. */
  p50Ms: number | null;
  p95Ms: number | null;
  // ── audit budgets-cost-6 (2026-09-26): silent-degradation counters (absent on pre-change stamps / hand-built metrics) ──
  /** Act asks this backend answered while UNCALIBRATED (row modeDowngrade) — each one ran the consumer's pre-gate path. */
  downgraded?: number;
  /** Answers this backend gave only because an earlier leg failed (row legIndex > 0). */
  fellThrough?: number;
  /** Asks that skipped this backend inside a 401/403 latch cooldown (legErrors '<label>: latched (…)'). */
  latched?: number;
}

/** 2026-09-26 (plan E): the part a backend plays for a purpose in the report — the configured / stamped primary, a shadow challenger, or a fallback leg. */
export type ReadinessRole = 'primary' | 'challenger' | 'fallback';

export interface ReadinessEntry {
  backend: string;
  /** 2026-09-26: the backend identity ('jev' | 'deepseek-flash' | '<label>:<id>' | a legacy label). */
  backendSpec: string;
  /** The backend's client kind when a row said (2026-09-26). */
  kind?: BackendKind;
  purpose: string;
  /** 2026-09-26 (audit): the non-human segment this entry is partitioned for ('machine' | 'supervisor'); absent on the human entry. A segment entry is never stamped and never READY. */
  segment?: string;
  /** The built-in jev, a registry model flagged calibrated (the newest row's meta.calibrated), or a backend with a fitted temperature for (spec, purpose). */
  calibrated: boolean;
  metrics: ReadinessMetrics;
  ready: boolean;
  /** Every bar the entry misses, named. Empty when ready. */
  reasons: string[];
  /** 2026-09-26 (plan E): assigned by buildReadinessArtifacts (needs the per-purpose primary); absent from the bare report. */
  role?: ReadinessRole;
}

/** What readinessMetrics needs of a group: the labelled samples + dedupe counts; the plan-E call / latency fields are optional (a hand-built group has none). */
export type ReadinessMetricsInput = Pick<ReadinessGroup, 'purpose' | 'samples' | 'deduped' | 'undedupable'> & Partial<Pick<ReadinessGroup, 'backend' | 'backendSpec' | 'kind' | 'calls' | 'fails' | 'latenciesMs' | 'challenger' | 'challengerRows' | 'calibratedNewest' | 'segment' | 'downgraded' | 'fellThrough' | 'latched'>>;

/** The metrics for one (backend, purpose) group on its NEWEST questionsHash partition. */
export function readinessMetrics(group: ReadinessMetricsInput, env: Record<string, string | undefined> = {}): ReadinessMetrics {
  const partitions: Record<string, number> = {};
  let newest = '';
  let newestAt = -1;
  for (const s of group.samples) {
    partitions[s.questionsHash] = (partitions[s.questionsHash] ?? 0) + 1;
    if (s.at > newestAt) { newestAt = s.at; newest = s.questionsHash; }
  }
  // Machine / supervisor-segment rows never feed the HUMAN readiness (audit 2026-09-26
  // supervisors-auto-5): the stamp this report writes admits act for human sends only.
  // A group that IS a non-human segment partition (telemetry-readiness-9) measures its own rows.
  const isMachineSample = (s: ReadinessSample) => !group.segment && !!s.segment && MACHINE_SEGMENTS.has(s.segment);
  const machineExcluded = group.samples.filter(s => s.questionsHash === newest && isMachineSample(s)).length;
  const samples = group.samples.filter(s => s.questionsHash === newest && !isMachineSample(s));
  const n = samples.length;
  const times = samples.map(s => s.at).filter(t => t > 0);
  const days = times.length ? (Math.max(...times) - Math.min(...times)) / 86_400_000 : 0;
  const hits = samples.filter(s => s.agreed).length;
  const policy = ACT_POLICIES[group.purpose];
  const positiveKey = policy?.kind === 'noul_low' ? 'yes' : null;
  const positives = positiveKey ? samples.filter(s => s.actual === positiveKey).length : samples.filter(s => s.actual === s.predictedKey).length;
  const controlRows = samples.filter(s => s.control === true);
  const controls = controlRows.length ? { n: controlRows.length, positives: controlRows.filter(s => (positiveKey ? s.actual === positiveKey : s.actual === s.predictedKey)).length } : undefined;
  // backlog E11 / DOI-21 (2026-09-28): the observed rate, the floor it scales to, and the segment's own-label count.
  const negatives = n - positives;
  const labelsPerDay = labelsPerDayOf(n, days);
  const minLabelsEffective = volumeScaledMinLabels(readinessBarsFor(group.purpose).minLabels, n, days);
  const degenerateLabels = labelsDegenerate({ n, positives, negatives });
  const harnessLabelled = samples.filter(s => s.harnessLabel === true).length;
  return {
    ...(controls ? { controls } : {}),
    labelsPerDay, minLabelsEffective, degenerateLabels, harnessLabelled,
    n, days,
    accuracy: n ? hits / n : NaN,
    brier: readinessBrier(samples),
    ece: readinessEce(samples),
    auroc: auroc(samples.map(s => 1 - s.confidence), samples.map(s => !s.agreed)),
    coverageAt5: coverageAtError(samples, 0.05),
    actBand: actBandStats(samples, group.purpose, env),
    positives, negatives,
    deduped: group.deduped, undedupable: group.undedupable,
    partitions, partition: newest, machineExcluded,
    suggestedThreshold: searchThreshold(samples, group.purpose),
    calls: group.calls ?? 0, fails: group.fails ?? 0,
    failRate: (group.calls ?? 0) > 0 ? (group.fails ?? 0) / (group.calls as number) : NaN,
    p50Ms: percentile(group.latenciesMs ?? [], 0.5),
    p95Ms: percentile(group.latenciesMs ?? [], 0.95),
    // budgets-cost-6: present whenever the group came from rows (0 when nothing degraded); absent on a hand-built input.
    ...(typeof group.calls === 'number' ? { downgraded: group.downgraded ?? 0, fellThrough: group.fellThrough ?? 0, latched: group.latched ?? 0 } : {}),
  };
}

/** READY / NOT READY against READINESS_BARS (+ the imessage positives bar), with every missed bar named. */
export function readinessVerdict(purpose: string, m: ReadinessMetrics, calibrated: boolean, opts: { segment?: string; env?: Record<string, string | undefined> } = {}): { ready: boolean; reasons: string[] } {
  // agent-decisions 2026-09-27: per-purpose bar overrides (PURPOSE_READINESS_BARS — supervisor_turn_noop needs 30 band rows at ≥ 0.95).
  const B = readinessBarsFor(purpose);
  const env = opts.env ?? {};
  const reasons: string[] = [];
  // 2026-09-26 (audit): a non-human segment's group is reported for visibility only — its rows carry
  // no harness label the act flip could be judged on, so it can never be READY on its own.
  // backlog DOI-21 (2026-09-28): unless EVERY sample is the segment's own harness-proxy label
  // (MACHINE_SEGMENT_LABEL_FOR_FIT — the window closer's `machine` row) — then the partition is judged
  // like any other on the bars below. The STAMP still follows the human entry (readinessStampFromReport);
  // the segment's READY shows on its report entry and gates COMPUTE_POLICY_MACHINE_ACT_ENABLED by hand.
  if (opts.segment && NON_HUMAN_SEGMENTS.has(opts.segment)) {
    const ownLabelled = m.n > 0 && (m.harnessLabelled ?? 0) === m.n;
    if (!ownLabelled) reasons.push(`segment '${opts.segment}': partitioned out of the human sample — no harness label exists for ${opts.segment} turns yet (never READY on its own; the stamp follows the human entry)`);
  }
  if (!ACT_POLICIES[purpose]) reasons.push(`no act policy known for "${purpose}"`);
  if (!calibrated) reasons.push('backend is not calibrated (a logprob readout without a fitted DECISION_GATE_TEMP_<PURPOSE>)');
  // backlog E11 (2026-09-28): the label floor scales to the purpose's own observed rate (never below READINESS_MIN_LABELS_FLOOR).
  const minLabels = m.minLabelsEffective ?? volumeScaledMinLabels(B.minLabels, m.n, m.days);
  const scaledNote = minLabels !== B.minLabels ? ` — volume-scaled: ${READINESS_VOLUME_SCALE_DAYS} × ${(m.labelsPerDay ?? labelsPerDayOf(m.n, m.days)).toFixed(1)}/day, floor ${READINESS_MIN_LABELS_FLOOR}, cap ${B.minLabels}` : '';
  if (m.n < minLabels) reasons.push(`labels ${m.n} < ${minLabels} (after dedupe, newest question partition${scaledNote})`);
  if (m.days < B.minDays) reasons.push(`span ${m.days.toFixed(1)} d < ${B.minDays} d`);
  if (m.actBand.n < B.minActBandN) reasons.push(`act-band rows ${m.actBand.n} < ${B.minActBandN} at τ=${m.actBand.threshold}`);
  // R&D exp #6 (2026-09-26): the Wilson LOWER bound is the bar's statistic — the
  // mirror of E12's demotion rule (6498712b6 demotes iff wilsonUpper95 < bar, the
  // burden of proof on the demotion; here the burden of proof is on the GRANT).
  // A point estimate at the bar on 20 band rows is one label of noise (19/20 =
  // 0.950 point, Wilson 95% [0.764, 0.993] — LB 0.764 must NOT admit an act flip).
  // Hand-checked boundaries at bar 0.9 (wilsonInterval, z = 1.96):
  //   n = 20  → READY only at 20/20 (LB 0.839; 19/20 LB 0.764 fails)
  //   n = 150 → 189/150-club: 144/150 LB 0.904 holds; 143/150 LB 0.896 fails
  //   n = 200 → 189/200 LB 0.904 holds; 188/200 LB 0.896 fails
  else if (!(m.actBand.lower95 >= B.minActBandPrecision)) reasons.push(`act-band precision Wilson 95% lower bound ${m.actBand.lower95.toFixed(3)} (point ${m.actBand.precision.toFixed(3)} over n=${m.actBand.n}) < ${B.minActBandPrecision} at τ=${m.actBand.threshold}`);
  // fixer 2026-09-27: a control-gated purpose (PURPOSE_CONTROL_GATED) — once the act period has
  // produced heartbeat-floor CONTROL rows (meta.control), they are the skip band's own action
  // rate; the flip / re-admission is judged on them too (count, then the Wilson LB of the quiet
  // rate), never on shadow-era band rows alone. Pinned turns are excludeFromFit upstream, so
  // neither population carries a turn the consumer could not have skipped.
  if (PURPOSE_CONTROL_GATED.has(purpose) && m.controls && m.controls.n > 0) {
    const quiet = m.controls.n - m.controls.positives;
    const lb = wilsonInterval(quiet, m.controls.n).lower;
    if (m.controls.n < B.minActBandN) reasons.push(`floor-turn control rows ${m.controls.n} < ${B.minActBandN} (act-period heartbeat turns)`);
    else if (!(lb >= B.minActBandPrecision)) reasons.push(`floor-turn action rate ${m.controls.positives}/${m.controls.n} — quiet-rate Wilson 95% lower bound ${lb.toFixed(3)} < ${B.minActBandPrecision}`);
  }
  // backlog E11 (2026-09-28): a near-degenerate label set cannot produce a meaningful AUROC / coverage@5 — the
  // precision bar above is the only bar that can be measured there (labelsDegenerate).
  const degenerate = m.degenerateLabels ?? labelsDegenerate(m);
  if (!degenerate) {
    if (!(m.auroc >= B.minAuroc)) reasons.push(`AUROC ${Number.isFinite(m.auroc) ? m.auroc.toFixed(3) : 'n/a (one class only)'} < ${B.minAuroc}`);
    if (!(m.coverageAt5.coverage >= B.minCoverageAt5)) reasons.push(`coverage at ≤5% error ${m.coverageAt5.coverage.toFixed(3)} < ${B.minCoverageAt5}`);
  }
  if (purpose === 'imessage_send' && m.positives < B.imessageMinPositives) reasons.push(`labelled positive sends ${m.positives} < ${B.imessageMinPositives}`);
  return { ready: reasons.length === 0, reasons };
}

/** A backend label names a systemone server: built-in Jev or a registry "(systemone)" seat.
 *  Since 2026-09-26 this is only the LEGACY fallback for rows without meta.calibrated — a
 *  systemone server is no longer presumed calibrated (see groupCalibrated). */
export function isSystemOneBackend(backend: string): boolean {
  return /typesafe jev|\(systemone\)/i.test(String(backend || ''));
}

/** The built-in jev spec (decision-gate.ts DECISION_BUILT_IN_JEV; mirrored so the fit stays dependency-free). */
export const BUILT_IN_JEV_SPEC = 'jev';

/**
 * 2026-09-26: is a group's backend CALIBRATED for its purpose? The built-in
 * jev (the reference); a fitted temperature for (spec, purpose) — the store
 * `temps` map for any backend, the per-purpose env key for a readout; else
 * the newest decision row's own meta.calibrated (a registry model flagged
 * calibrated by the admin); rows that predate the flag fall back to the
 * label ("TypeSafe Jev" / "(systemone)" = calibrated, as before).
 */
export function groupCalibrated(g: Pick<ReadinessGroup, 'backend' | 'backendSpec' | 'kind' | 'purpose' | 'calibratedNewest'>, env: Record<string, string | undefined> = {}, temps: Record<string, number> = {}): boolean {
  if (g.backendSpec === BUILT_IN_JEV_SPEC) return true;
  if (backendTemperatureFittedIn(g.backendSpec, g.purpose, g.kind, env, temps)) return true;
  if (typeof g.calibratedNewest === 'boolean') return g.calibratedNewest;
  return isSystemOneBackend(g.backend);
}

/**
 * The per-(backendSpec, purpose) readiness report. `calibrated` per
 * groupCalibrated (`temps` = the store's fitted per-(backend, purpose)
 * temperatures, passed in by the job; the CLI passes none).
 */
export function buildReadinessReport(rows: ReadinessRow[], opts: { env?: Record<string, string | undefined>; purpose?: string | null; temps?: Record<string, number>; now?: number | Date } = {}): ReadinessEntry[] {
  const env = opts.env ?? {};
  const temps = opts.temps ?? {};
  // The act-question filter reads its kill switch from the SAME env the report was given (the job passes process.env; a test passes its own).
  return pairReadinessRows(rows, { ...(opts.now !== undefined ? { now: opts.now } : {}), env: opts.env ?? process.env })
    // ACT_POLICIES purposes only (review 2026-09-26): the admin Test button / endpoint verify
    // write `purpose:'probe'` decision rows — never a report entry, a stamp key or a metric row.
    .filter(g => ACT_POLICIES[g.purpose] !== undefined && (!opts.purpose || g.purpose === opts.purpose))
    .map(g => {
      const calibrated = groupCalibrated(g, env, temps);
      const metrics = readinessMetrics(g, env);
      const verdict = readinessVerdict(g.purpose, metrics, calibrated, { segment: g.segment, env });
      // A group with calls but no labelled sample (plan E: a failing leg, a challenger with no outcome yet) reads "no labelled outcomes" first.
      const reasons = metrics.n === 0 ? ['no labelled outcomes in the window', ...verdict.reasons] : verdict.reasons;
      // A challenger group's role is known here (its rows say so); primary / fallback need the per-purpose primary — buildReadinessArtifacts assigns those.
      return { backend: g.backend, backendSpec: g.backendSpec, ...(g.kind ? { kind: g.kind } : {}), purpose: g.purpose, ...(g.segment ? { segment: g.segment } : {}), calibrated, metrics, ready: verdict.ready, reasons, ...(g.challenger ? { role: 'challenger' as const } : {}) };
    });
}
