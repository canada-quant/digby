/**
 * DURABLE act-band auto-demote (2026-10-04).
 *
 * The E12 auto-demote (decision-gate-modes noteActBandOutcome) keeps its act-period window in a per-PROCESS
 * in-memory Map: every deploy / restart drops it and labels split across boxes and workers, so a purpose rarely
 * accumulates the DECISION_GATE_AUTO_DEMOTE_MIN_N (30) act-period labels the rule needs. The 2026-10-04 readiness
 * read showed wake_triage — in act since 2026-09-26 — at 23/35 correct in its act band (Wilson lower bound 0.49) with
 * no demotion since 2026-09-26; the night had ~8 deploys. This pass rebuilds the SAME window from the persisted
 * outcome rows the 6-hourly readiness job already loads (loop_metrics decision_gate, phase outcome) and applies the
 * SAME rule (actBandBreachVerdict: n ≥ minN AND Wilson 95% UPPER bound < bar − margin) through the SAME writer
 * (autoDemoteDecisionMode — store row act → shadow + a decision_gate_demoted row; throttled).
 *
 * The admitted labels mirror noteActBandOutcome exactly: decision made in ACT mode (meta.mode), inside the act band
 * (meta.inActBand), labelled (meta.agreed boolean), the purpose's ACT question (isActQuestionOf), a fit-entering label
 * (outcomeLabelEntersFit), not a challenger row, not excludeFromFit; the newest ACT_BAND_WINDOW (100) per purpose.
 * Exempt purposes (DECISION_GATE_AUTO_DEMOTE_EXEMPT) are skipped. Kill switch DECISION_GATE_DURABLE_DEMOTE_DISABLED=1.
 */
import { isActQuestionOf, outcomeLabelEntersFit, type DecisionGateRow } from './decision-gate-fit';
import {
  ACT_BAND_WINDOW, actBandBreachVerdict, autoDemoteDecisionMode, autoDemoteExemptPurposes, autoDemoteMargin, autoDemoteMinN, autoDemoteMinPrecision,
} from './decision-gate-modes';
import type { DecisionPurpose } from './decision-gate';
import { actBandLabelCoverage, labelFloorBreach } from './decision-gate-label-floor';

export function durableDemoteDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.DECISION_GATE_DURABLE_DEMOTE_DISABLED === '1';
}

export interface DurableWindow { n: number; k: number; since: string | null }

/** Rows (oldest first) → per purpose the newest ACT_BAND_WINDOW admitted act-period labels. Pure. */
export function durableActBandWindows(rows: readonly DecisionGateRow[], purposes: ReadonlySet<string>): Map<string, DurableWindow> {
  const labels = new Map<string, Array<{ agreed: boolean; at: string | null }>>();
  for (const r of rows) {
    const m = r?.meta;
    if (!m || m.phase !== 'outcome' || !purposes.has(String(m.purpose))) continue;
    if (m.mode !== 'act' || m.inActBand !== true || typeof m.agreed !== 'boolean') continue;
    if (m.challenger === true || m.excludeFromFit === true) continue;
    if (!isActQuestionOf(String(m.purpose), String(m.question ?? ''))) continue;
    if (!outcomeLabelEntersFit(String(m.purpose), m.label)) continue;
    const at = r.createdAt ? new Date(r.createdAt as any).toISOString() : null;
    const list = labels.get(m.purpose) ?? [];
    list.push({ agreed: m.agreed, at });
    if (list.length > ACT_BAND_WINDOW) list.shift();
    labels.set(m.purpose, list);
  }
  const out = new Map<string, DurableWindow>();
  for (const [p, list] of labels) out.set(p, { n: list.length, k: list.filter((x) => x.agreed).length, since: list[0]?.at ?? null });
  return out;
}

export interface DurableDemoteResult { purpose: string; n: number; precision: number; upperBound: number; outcome: 'demoted' | 'observed' | 'skipped'; reason?: 'precision' | 'label_floor' }

/**
 * ONE pass over the readiness job's rows: every purpose EFFECTIVELY in act (and not exempt) whose durable window
 * breaches the rule is demoted through autoDemoteDecisionMode. Never throws; returns what it did.
 */
export async function runDurableActBandDemote(rows: readonly DecisionGateRow[], actPurposes: readonly string[], demote = autoDemoteDecisionMode): Promise<DurableDemoteResult[]> {
  if (durableDemoteDisabled() || !actPurposes.length) return [];
  const exempt = autoDemoteExemptPurposes();
  const eligible = new Set(actPurposes.filter((p) => !exempt.has(p)));
  const windows = durableActBandWindows(rows, eligible);
  const out: DurableDemoteResult[] = [];
  for (const purpose of eligible) {
    const w = windows.get(purpose);
    if (!w) continue;
    const bar = autoDemoteMinPrecision(purpose as DecisionPurpose);
    const margin = autoDemoteMargin();
    const v = actBandBreachVerdict(w.k, w.n, { minN: autoDemoteMinN(), bar, margin });
    if (!v.breach) continue;
    const outcome = await demote(purpose as Exclude<DecisionPurpose, 'probe'>, {
      n: w.n, precision: v.precision, lowerBound: v.lowerBound, upperBound: v.upperBound, bar, margin, windowSince: w.since,
    }).catch(() => 'skipped' as const);
    out.push({ purpose, n: w.n, precision: v.precision, upperBound: v.upperBound, outcome });
  }
  // audit 2026-10-08 W3-7 (imessage_send: 11 of 196 act decisions labelled): an act purpose whose ACT-MODE band
  // decisions are almost never labelled can never reach the precision rule's minN — demote it on the LABEL FLOOR
  // (decision-gate-label-floor.ts; DECISION_GATE_ACT_LABEL_FLOOR_DISABLED=1 skips this half).
  const coverage = actBandLabelCoverage(rows, { purposes: eligible, actModeOnly: true });
  for (const purpose of eligible) {
    if (out.some((r) => r.purpose === purpose)) continue;
    const c = coverage.get(purpose);
    if (!labelFloorBreach(c)) continue;
    const w = windows.get(purpose);
    const n = c!.labelled;
    const precision = w && w.n ? w.k / w.n : 0;
    const outcome = await demote(purpose as Exclude<DecisionPurpose, 'probe'>, {
      n, precision, windowSince: c!.since, reason: 'label_floor', labelCoverage: c!.coverage, decisions: c!.total,
      lowerBound: 0, upperBound: 1,
    }).catch(() => 'skipped' as const);
    out.push({ purpose, n, precision, upperBound: 1, outcome, reason: 'label_floor' });
  }
  return out;
}
