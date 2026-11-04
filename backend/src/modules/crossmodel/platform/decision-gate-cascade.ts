/**
 * Decision gate — the OFFLINE cascade curve (Laya follow-up, 2026-09-26;
 * scope scratchpad/laya/followup-scope.md item 5).
 *
 * QUESTION IT ANSWERS: "if a cheap FIRST leg (a self-hosted Laya over the
 * LiteLLM proxy, `cql:agx-laya`) answered every ask it is confident about at
 * τ and the primary (TypeSafe Jev) answered the rest, how much would the
 * first leg cover and would it be at least as right as the primary on those
 * rows?" — computed OFFLINE from the paired rows the challenger design already
 * writes (a challenger answers the SAME ask as the primary, so every labelled
 * primary outcome has a matching first-leg answer). NO act-path cascade
 * exists: this is the ruler the act-path cascade would be admitted against,
 * after ≥ 1 week of paired rows.
 *
 * PAIRING (pairCascadeRows): loop_metrics decision_gate rows →
 *   · PRIMARY decision rows (challenger !== true, not memo hits) of the
 *     purpose, joined with their LABELLED outcome rows (phase 'outcome',
 *     acted:false, actual !== null, OUTCOME_LABEL_FOR_FIT) by meta.id + question;
 *   · the FIRST-leg answer for the same ask: the primary row itself when the
 *     primary IS the first spec (a degenerate cascade: d = 0), else the
 *     challenger decision row `{primaryId: <id>, backendSpec: <first>}`
 *     (id `<id>~c<n>`), else — when that row is outside the window — the
 *     challenger's own outcome row's meta.predicted;
 *   · per-(spec, purpose) TEMPERATURE: a row whose answers were not tempered
 *     at decision time (no meta.temperature) is re-tempered from its logits —
 *     meta.logits when present, else log p derived from meta.answers'
 *     probabilities (the fit's rule) — with temps['<spec>|<purpose>'] when the
 *     caller passes the store's map; an already-tempered row is used as is;
 *   · deduped by (question, stateHash), earliest kept — the busy re-asks.
 *
 * CURVE (cascadeCurve): for τ on the grid 0.50 … 0.99 (step 0.01):
 *   · the first leg's ACT BAND at τ (decision-gate-fit actBand with τ as the
 *     override — noul_low: noul ≤ 1 − τ; noul_high: noul ≥ τ; choice_high:
 *     confidence ≥ τ; score_low: round(score) ≤ max ∧ confidence ≥ τ);
 *   · coverage = n_band / n; first-leg in-band precision (acting on the band
 *     key was right — actKeyMatches) + its Wilson 95 % lower bound (z 1.96);
 *     the primary's precision on the SAME rows (its argmax = actual) + lower
 *     bound;
 *   · the PAIRED comparison: d = discordant rows (exactly one of the two was
 *     right), w = the first leg right where the primary was wrong;
 *     Δ = (w − (d − w)) / n_band; Δ's one-sided 95 % lower bound from the
 *     Wilson lower bound of w / d at z 1.645 (Δ_lower = d · (2 · w_lower − 1) /
 *     n_band; 0 when d = 0);
 *   · LEARN-THEN-TEST (Angelopoulos et al.): H0(τ) "the first leg's in-band
 *     error rate > α" with the EXACT binomial p-value P(Bin(n_band, α) ≤
 *     errors); rejected at level δ. α = 0.10 is the risk tolerance (≙ the
 *     readiness bar's act-band precision 0.90), δ = 0.05 the test level —
 *     the sizing that gives: n=50 → 1 error allowed, 100 → 4, 200 → 12,
 *     300 → 21 (lttMaxErrors). FIXED-SEQUENCE testing strict → loose (τ 0.99
 *     first): a τ is CERTIFIED only while every stricter τ passed too — the
 *     first failure stops the sequence, so the family-wise error stays at δ
 *     without a Bonferroni split;
 *   · NON-INFERIORITY: Δ_lower ≥ −margin (default 0.03); a τ PASSES when both
 *     the LTT test and non-inferiority hold. `certifiedTau` is the LOOSEST
 *     certified τ (the largest coverage the evidence supports).
 *
 * Dependency-free beyond decision-gate-fit / -math (no logger, no config): the
 * CLI `npm run decision-gate:cascade` (src/scripts/decision-gate-cascade.ts,
 * shipped in dist/) prints the table + JSON. Pure; every function here is
 * unit-tested.
 */

import { distributionFromLogits, wilsonInterval } from './decision-gate-math';
import {
  ACT_POLICIES, actBand, actKeyMatches, actualToKey, backendSpecOfRow, logitsFromAnswers, outcomeLabelEntersFit, predictedConfidence, predictedKey,
  type DecisionGateRow, type PredictedView,
} from './decision-gate-fit';

export const CASCADE_TAU_MIN = 0.5;
export const CASCADE_TAU_MAX = 0.99;
export const CASCADE_TAU_STEP = 0.01;
/** LTT risk tolerance: the max in-band error rate the first leg may have (≙ act-band precision ≥ 0.90). */
export const CASCADE_ALPHA_DEFAULT = 0.10;
/** LTT test level (one-sided). */
export const CASCADE_DELTA_DEFAULT = 0.05;
/** Non-inferiority margin on Δ (first leg − primary, on the band). */
export const CASCADE_MARGIN_DEFAULT = 0.03;
/** One-sided 95 % z for Δ's lower bound. */
export const ONE_SIDED_95_Z = 1.645;

// ── Exact binomial ───────────────────────────────────────────────────────────

function logGamma(x: number): number {
  // Lanczos approximation (g = 7), accurate to ~1e-15 for x > 0.
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function logChoose(n: number, k: number): number {
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/** log P(Bin(n, p) = k); −∞ outside the support. */
export function logBinomialPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n || n < 0) return -Infinity;
  if (p <= 0) return k === 0 ? 0 : -Infinity;
  if (p >= 1) return k === n ? 0 : -Infinity;
  return logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log(1 - p);
}

/** P(Bin(n, p) ≤ k), summed exactly in log space (n up to 10⁵ is fine). */
export function binomialCdf(k: number, n: number, p: number): number {
  if (n <= 0) return 1;
  if (k < 0) return 0;
  if (k >= n) return 1;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += Math.exp(logBinomialPmf(i, n, p));
  return Math.min(1, sum);
}

/** The LTT p-value for `errors` in-band errors out of n at risk tolerance α: P(Bin(n, α) ≤ errors). */
export function lttPValue(errors: number, n: number, alpha: number): number {
  return binomialCdf(errors, n, alpha);
}

/** The LARGEST error count that still rejects H0 "error rate > α" at level δ (−1 when even zero errors cannot — n too small, or n = 0). */
export function lttMaxErrors(n: number, alpha = CASCADE_ALPHA_DEFAULT, delta = CASCADE_DELTA_DEFAULT): number {
  if (n <= 0) return -1;
  let best = -1;
  for (let k = 0; k <= n; k++) {
    if (binomialCdf(k, n, alpha) <= delta) best = k; else break;
  }
  return best;
}

// ── Pairing ──────────────────────────────────────────────────────────────────

export interface CascadePair {
  id: string;
  question: string;
  purpose: string;
  firstSpec: string;
  primarySpec: string;
  first: PredictedView;
  primary: PredictedView;
  actual: string;
  stateKey?: string;
  at: number;
  /** The first leg's answer came from the primary's own row (the primary IS the first spec). */
  degenerate: boolean;
  /** The first leg's view came from its outcome row's predicted (decision row outside the window). */
  fromOutcomePredicted: boolean;
}

export interface CascadePairStats {
  /** Primary decision rows of the purpose in the window (memo hits excluded). */
  primaryRows: number;
  /** First-leg decision rows (challenger rows with the first spec, or primary rows when the primary is the first). */
  firstRows: number;
  /** Primary rows with at least one labelled outcome. */
  labelled: number;
  /** Labelled (row, question) pairs that also had a first-leg answer. */
  paired: number;
  /** Pairs dropped as exact repeats (question + stateHash). */
  deduped: number;
  /** Pairs where the primary was the first spec. */
  degenerate: number;
}

const toMs = (d: Date | string | undefined): number => {
  if (!d) return 0;
  const n = d instanceof Date ? d.getTime() : Date.parse(String(d));
  return Number.isFinite(n) ? n : 0;
};

/** The store's temps map key (decision-gate-fit backendTempStoreKey — mirrored to keep this module's imports minimal). */
const tempKey = (spec: string, purpose: string): string => `${spec}|${purpose}`;

/**
 * A row's compact answer for a question as a PredictedView, re-tempered from
 * its logits when T ≠ 1 and the row was not tempered at decision time. Pure.
 */
export function temperedView(answer: unknown, logits: Record<string, number> | undefined, T: number, alreadyTempered: boolean): PredictedView | null {
  const a = answer && typeof answer === 'object' ? (answer as PredictedView) : null;
  if (!a) return null;
  if (!(T > 0) || T === 1 || alreadyTempered) return a;
  const src = logits && typeof logits === 'object' ? logits : logitsFromAnswers({ q: a })?.q;
  if (!src) return a;
  const keys = Object.keys(src);
  if (!keys.length) return a;
  let dist: Record<string, number>;
  try { dist = distributionFromLogits(src, keys, T); } catch { return a; }
  if (typeof a.noul === 'number') return { noul: dist.yes ?? a.noul };
  const best = keys.reduce((m, k) => (dist[k] > dist[m] ? k : m), keys[0]);
  if (typeof a.choice === 'string') return { choice: a.choice, confidence: dist[a.choice] ?? dist[best], probabilities: dist };
  if (typeof a.score === 'number') {
    const score = keys.reduce((acc, k) => acc + Number(k) * dist[k], 0);
    return { score: Number.isFinite(score) ? score : a.score, confidence: dist[best], probabilities: dist };
  }
  return a;
}

/**
 * Pair the purpose's labelled primary rows with the first leg's answer for
 * the same ask (see the header). `temps` = the store's fitted temperatures
 * (optional). Pure.
 */
export function pairCascadeRows(rows: DecisionGateRow[], opts: { purpose: string; first: string; temps?: Record<string, number> }): { pairs: CascadePair[]; stats: CascadePairStats } {
  const temps = opts.temps ?? {};
  interface D { id: string; spec: string; purpose: string; challenger: boolean; primaryId?: string; answers?: Record<string, unknown>; logits?: Record<string, Record<string, number>>; tempered: boolean; stateKey?: string; at: number }
  const decisions = new Map<string, D>();
  const challengersByPrimary = new Map<string, D[]>();
  const stats: CascadePairStats = { primaryRows: 0, firstRows: 0, labelled: 0, paired: 0, deduped: 0, degenerate: 0 };
  for (const r of rows) {
    const m = r?.meta;
    if (!m || m.phase !== 'decision' || !m.id) continue;
    if (String(m.purpose || '') !== opts.purpose) continue;
    if (m.cached === true) continue;
    const d: D = {
      id: String(m.id), spec: backendSpecOfRow(m), purpose: String(m.purpose), challenger: m.challenger === true,
      ...(typeof m.primaryId === 'string' ? { primaryId: m.primaryId } : {}),
      ...(m.answers && typeof m.answers === 'object' ? { answers: m.answers } : {}),
      ...(m.logits && typeof m.logits === 'object' ? { logits: m.logits } : {}),
      tempered: typeof m.temperature === 'number' && Number.isFinite(m.temperature) && m.temperature !== 1,
      ...(typeof m.stateHash === 'string' && m.stateHash ? { stateKey: String(m.stateHash) } : {}),
      at: toMs(r.createdAt),
    };
    if (!d.answers && !d.logits) continue;
    decisions.set(d.id, d);
    if (d.challenger) {
      if (d.primaryId) challengersByPrimary.set(d.primaryId, [...(challengersByPrimary.get(d.primaryId) ?? []), d]);
      if (d.spec === opts.first) stats.firstRows += 1;
    } else {
      stats.primaryRows += 1;
      if (d.spec === opts.first) stats.firstRows += 1;
    }
  }
  // Outcomes: primary ones (the labels) and challenger ones (a fallback predicted view).
  interface O { actual: string; predicted?: PredictedView; spec: string }
  const primaryOutcomes = new Map<string, Map<string, O>>();
  const challengerOutcomes = new Map<string, Map<string, O[]>>(); // primaryId → question → rows
  for (const r of rows) {
    const m = r?.meta;
    if (!m || m.phase !== 'outcome' || !m.id || !m.question) continue;
    if (String(m.purpose || '') !== opts.purpose) continue;
    if (m.acted === true) continue;
    const actual = actualToKey(m.actual);
    if (actual === null) continue;
    if (!outcomeLabelEntersFit(opts.purpose, m.label)) continue;
    const o: O = { actual, spec: backendSpecOfRow(m), ...(m.predicted && typeof m.predicted === 'object' ? { predicted: m.predicted as PredictedView } : {}) };
    if (m.challenger === true) {
      const pid = typeof m.primaryId === 'string' ? m.primaryId : String(m.id).split('~c')[0];
      const byQ = challengerOutcomes.get(pid) ?? new Map<string, O[]>();
      byQ.set(String(m.question), [...(byQ.get(String(m.question)) ?? []), o]);
      challengerOutcomes.set(pid, byQ);
      continue;
    }
    const byQ = primaryOutcomes.get(String(m.id)) ?? new Map<string, O>();
    if (!byQ.has(String(m.question))) byQ.set(String(m.question), o);
    primaryOutcomes.set(String(m.id), byQ);
  }
  const viewOf = (d: D, question: string): PredictedView | null => {
    const T = Number(temps[tempKey(d.spec, d.purpose)]);
    const raw = d.answers?.[question];
    if (raw && typeof raw === 'object') return temperedView(raw, d.logits?.[question], Number.isFinite(T) && T > 0 ? T : 1, d.tempered);
    const lg = d.logits?.[question];
    if (lg && typeof lg === 'object') {
      const keys = Object.keys(lg);
      if (!keys.length) return null;
      let dist: Record<string, number>;
      try { dist = distributionFromLogits(lg, keys, Number.isFinite(T) && T > 0 ? T : 1); } catch { return null; }
      if (keys.length === 2 && 'yes' in dist && 'no' in dist) return { noul: dist.yes };
      const best = keys.reduce((m, k) => (dist[k] > dist[m] ? k : m), keys[0]);
      return { choice: best, confidence: dist[best], probabilities: dist };
    }
    return null;
  };
  const pairs: CascadePair[] = [];
  for (const d of decisions.values()) {
    if (d.challenger) continue;
    const outs = primaryOutcomes.get(d.id);
    if (!outs || !outs.size) continue;
    stats.labelled += 1;
    for (const [question, o] of outs) {
      const primary = viewOf(d, question);
      if (!primary || predictedKey(primary) === null || predictedConfidence(primary) === null) continue;
      let first: PredictedView | null = null;
      let degenerate = false;
      let fromOutcomePredicted = false;
      if (d.spec === opts.first) { first = primary; degenerate = true; }
      else {
        const c = (challengersByPrimary.get(d.id) ?? []).find(x => x.spec === opts.first);
        if (c) first = viewOf(c, question);
        if (!first) {
          const co = (challengerOutcomes.get(d.id)?.get(question) ?? []).find(x => x.spec === opts.first && x.predicted);
          if (co?.predicted) { first = co.predicted; fromOutcomePredicted = true; }
        }
      }
      if (!first || predictedKey(first) === null || predictedConfidence(first) === null) continue;
      stats.paired += 1;
      if (degenerate) stats.degenerate += 1;
      pairs.push({ id: d.id, question, purpose: d.purpose, firstSpec: opts.first, primarySpec: d.spec, first, primary, actual: o.actual, ...(d.stateKey ? { stateKey: d.stateKey } : {}), at: d.at, degenerate, fromOutcomePredicted });
    }
  }
  pairs.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const kept: CascadePair[] = [];
  for (const p of pairs) {
    if (!p.stateKey) { kept.push(p); continue; }
    const k = `${p.question}\u0000${p.stateKey}`;
    if (seen.has(k)) { stats.deduped += 1; continue; }
    seen.add(k);
    kept.push(p);
  }
  return { pairs: kept, stats };
}

// ── The curve ────────────────────────────────────────────────────────────────

export interface CascadePoint {
  tau: number;
  /** Rows the first leg would answer at τ. */
  nBand: number;
  /** nBand / n. */
  coverage: number;
  firstCorrect: number;
  firstPrecision: number;
  firstLower95: number;
  primaryCorrectOnBand: number;
  primaryPrecisionOnBand: number;
  primaryLower95: number;
  /** Discordant band rows (exactly one of the two was right). */
  d: number;
  /** …of which the first leg was right (and the primary wrong). */
  w: number;
  /** (w − (d − w)) / nBand — the first leg's precision minus the primary's on the band. */
  delta: number;
  /** One-sided 95 % lower bound of Δ (Wilson on w / d at z 1.645; 0 when d = 0). */
  deltaLower95: number;
  errors: number;
  /** lttMaxErrors(nBand, α, δ) — −1 when the band is too small for any pass. */
  errorsAllowed: number;
  /** P(Bin(nBand, α) ≤ errors). */
  lttP: number;
  lttPass: boolean;
  /** deltaLower95 ≥ −margin. */
  nonInferior: boolean;
  /** lttPass ∧ nonInferior (this τ alone). */
  pass: boolean;
  /** Fixed-sequence strict → loose: this τ passed AND every stricter τ passed. */
  certified: boolean;
}

export interface CascadeCurve {
  purpose: string;
  first: string;
  /** Every primary spec seen among the pairs (normally one). */
  primarySpecs: string[];
  n: number;
  alpha: number;
  delta: number;
  margin: number;
  points: CascadePoint[];
  /** The LOOSEST certified τ (largest certified coverage), or null. */
  certifiedTau: number | null;
  certifiedCoverage: number | null;
  /** The primary alone on the same pairs at the purpose's REAL cutoff (context). */
  primaryReference: { threshold: number; n: number; correct: number; precision: number; lower95: number; coverage: number };
  stats?: CascadePairStats;
}

/** The τ grid 0.50 … 0.99 (step 0.01), ascending, 2 dp. */
export function cascadeTaus(): number[] {
  const out: number[] = [];
  for (let t = CASCADE_TAU_MIN; t <= CASCADE_TAU_MAX + 1e-9; t += CASCADE_TAU_STEP) out.push(Number(t.toFixed(2)));
  return out;
}

/** One grid point (pure). */
export function cascadePoint(pairs: ReadonlyArray<CascadePair>, purpose: string, tau: number, opts: { alpha: number; delta: number; margin: number; env?: Record<string, string | undefined> }): Omit<CascadePoint, 'certified'> {
  const env = opts.env ?? {};
  let nBand = 0; let firstCorrect = 0; let primaryCorrect = 0; let d = 0; let w = 0;
  for (const p of pairs) {
    const band = actBand(purpose, p.first, env, tau);
    if (!band.inBand) continue;
    nBand += 1;
    const fr = actKeyMatches(band, p.actual);
    const pr = predictedKey(p.primary) === p.actual;
    if (fr) firstCorrect += 1;
    if (pr) primaryCorrect += 1;
    if (fr !== pr) { d += 1; if (fr) w += 1; }
  }
  const n = pairs.length;
  const errors = nBand - firstCorrect;
  const errorsAllowed = lttMaxErrors(nBand, opts.alpha, opts.delta);
  const lttP = nBand > 0 ? lttPValue(errors, nBand, opts.alpha) : 1;
  const lttPass = nBand > 0 && lttP <= opts.delta;
  const delta = nBand > 0 ? (w - (d - w)) / nBand : 0;
  const deltaLower95 = nBand > 0 && d > 0 ? (d * (2 * wilsonInterval(w, d, ONE_SIDED_95_Z).lower - 1)) / nBand : 0;
  const nonInferior = nBand > 0 && deltaLower95 >= -opts.margin - 1e-12;
  return {
    tau, nBand, coverage: n ? nBand / n : 0,
    firstCorrect, firstPrecision: nBand ? firstCorrect / nBand : NaN, firstLower95: nBand ? wilsonInterval(firstCorrect, nBand).lower : NaN,
    primaryCorrectOnBand: primaryCorrect, primaryPrecisionOnBand: nBand ? primaryCorrect / nBand : NaN, primaryLower95: nBand ? wilsonInterval(primaryCorrect, nBand).lower : NaN,
    d, w, delta, deltaLower95,
    errors, errorsAllowed, lttP, lttPass, nonInferior, pass: lttPass && nonInferior,
  };
}

/** The whole curve with the fixed-sequence certification (pure). */
export function cascadeCurve(pairs: ReadonlyArray<CascadePair>, opts: { purpose: string; first: string; alpha?: number; delta?: number; margin?: number; env?: Record<string, string | undefined>; taus?: number[]; stats?: CascadePairStats }): CascadeCurve {
  const alpha = opts.alpha ?? CASCADE_ALPHA_DEFAULT;
  const delta = opts.delta ?? CASCADE_DELTA_DEFAULT;
  const margin = opts.margin ?? CASCADE_MARGIN_DEFAULT;
  const env = opts.env ?? {};
  const taus = (opts.taus ?? cascadeTaus()).slice().sort((a, b) => a - b);
  const raw = taus.map(tau => cascadePoint(pairs, opts.purpose, tau, { alpha, delta, margin, env }));
  // Fixed sequence strict → loose: walk τ DESCENDING; certified while every stricter τ passed.
  const certifiedSet = new Set<number>();
  let alive = true;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (alive && raw[i].pass) certifiedSet.add(raw[i].tau); else alive = false;
  }
  const points: CascadePoint[] = raw.map(p => ({ ...p, certified: certifiedSet.has(p.tau) }));
  const certified = points.filter(p => p.certified);
  const loosest = certified.length ? certified[0] : null; // ascending order → the first certified is the loosest
  // The primary alone at its real cutoff on the same pairs.
  let pn = 0; let pc = 0; let threshold = NaN;
  for (const p of pairs) {
    const band = actBand(opts.purpose, p.primary, env);
    threshold = band.threshold;
    if (!band.inBand) continue;
    pn += 1;
    if (actKeyMatches(band, p.actual)) pc += 1;
  }
  const primarySpecs = [...new Set(pairs.map(p => p.primarySpec))].sort();
  return {
    purpose: opts.purpose, first: opts.first, primarySpecs, n: pairs.length, alpha, delta, margin, points,
    certifiedTau: loosest ? loosest.tau : null, certifiedCoverage: loosest ? loosest.coverage : null,
    primaryReference: { threshold, n: pn, correct: pc, precision: pn ? pc / pn : NaN, lower95: pn ? wilsonInterval(pc, pn).lower : NaN, coverage: pairs.length ? pn / pairs.length : 0 },
    ...(opts.stats ? { stats: opts.stats } : {}),
  };
}

// ── Table ────────────────────────────────────────────────────────────────────

const f3 = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : 'n/a');
const pct = (n: number): string => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : 'n/a');
const pad = (s: string, w: number): string => (s.length >= w ? s : ' '.repeat(w - s.length) + s);

/** The human table: every 0.05 step of the grid plus the certified τ, one line per τ. */
export function formatCascadeTable(curve: CascadeCurve): string {
  const lines: string[] = [];
  const policy = ACT_POLICIES[curve.purpose];
  lines.push(`decision-gate CASCADE CURVE — purpose ${curve.purpose}, first leg ${curve.first}, primary ${curve.primarySpecs.join(' / ') || '(none)'}, ${curve.n} paired labelled rows`);
  if (curve.stats) lines.push(`   pairing: ${curve.stats.primaryRows} primary rows, ${curve.stats.firstRows} first-leg rows, ${curve.stats.labelled} labelled, ${curve.stats.paired} paired (${curve.stats.degenerate} degenerate — primary is the first leg), ${curve.stats.deduped} deduped`);
  lines.push(`   band: ${policy ? `${policy.kind} on "${policy.question}"` : 'unknown purpose — no band'}; LTT exact binomial α=${curve.alpha} (risk) δ=${curve.delta} (level), fixed-sequence strict→loose; non-inferiority Δ_lower ≥ −${curve.margin}`);
  lines.push(`   primary alone at its real cutoff τ=${curve.primaryReference.threshold}: band n=${curve.primaryReference.n}, precision ${f3(curve.primaryReference.precision)} (LB ${f3(curve.primaryReference.lower95)}), coverage ${pct(curve.primaryReference.coverage)}`);
  lines.push('');
  lines.push(`   ${pad('τ', 5)} ${pad('n', 6)} ${pad('cov', 7)} ${pad('first', 7)} ${pad('(LB)', 7)} ${pad('primary', 8)} ${pad('(LB)', 7)} ${pad('d', 5)} ${pad('w', 5)} ${pad('Δ', 7)} ${pad('Δ_LB', 7)} ${pad('err/ok', 8)} ${pad('p', 7)}  LTT  NI  cert`);
  const show = new Set<number>();
  for (const p of curve.points) if (Math.round(p.tau * 100) % 5 === 0 || p.tau === curve.certifiedTau || p.tau === CASCADE_TAU_MAX) show.add(p.tau);
  for (const p of curve.points) {
    if (!show.has(p.tau)) continue;
    lines.push(`   ${pad(p.tau.toFixed(2), 5)} ${pad(String(p.nBand), 6)} ${pad(pct(p.coverage), 7)} ${pad(f3(p.firstPrecision), 7)} ${pad(f3(p.firstLower95), 7)} ${pad(f3(p.primaryPrecisionOnBand), 8)} ${pad(f3(p.primaryLower95), 7)} ${pad(String(p.d), 5)} ${pad(String(p.w), 5)} ${pad(Number.isFinite(p.delta) ? (p.delta >= 0 ? '+' : '') + p.delta.toFixed(3) : 'n/a', 7)} ${pad(Number.isFinite(p.deltaLower95) ? (p.deltaLower95 >= 0 ? '+' : '') + p.deltaLower95.toFixed(3) : 'n/a', 7)} ${pad(`${p.errors}/${p.errorsAllowed < 0 ? '-' : p.errorsAllowed}`, 8)} ${pad(f3(p.lttP), 7)}  ${p.lttPass ? 'ok ' : 'no '}  ${p.nonInferior ? 'ok' : 'no'}  ${p.certified ? 'YES' : 'no'}`);
  }
  lines.push('');
  lines.push(curve.certifiedTau === null
    ? '   VERDICT: no τ is certified — the first leg cannot take any band yet (more paired rows, a lower error rate, or a smaller advantage gap needed). NO act-path cascade exists; this table is the ruler it would be admitted against.'
    : `   VERDICT: certified down to τ=${curve.certifiedTau.toFixed(2)} → the first leg could answer ${pct(curve.certifiedCoverage ?? 0)} of asks at ≤ ${(curve.alpha * 100).toFixed(0)}% in-band error (level ${curve.delta}) and no worse than the primary by more than ${curve.margin}. NO act-path cascade exists yet — this is the offline ruler; the act path is the next step after ≥ 1 week of paired rows.`);
  return lines.join('\n');
}
