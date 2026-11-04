/**
 * ACT needs labels (audit 2026-10-08 W3-7 — plumbing F7).
 *
 * `imessage_send` has been in ACT since 2026-09-26: 196 act outcomes in 7 d,
 * 11 labelled (5.6 %, agreement 6/11) — and of its 180 IN-BAND act decisions
 * (the rows the auto-demote reads) not one is labelled (prod read 2026-10-08).
 * The durable auto-demote needs n_act ≥ 30 LABELLED act-period rows, so the
 * purpose acts on every send with no way for its accuracy to ever pull it
 * back. An act purpose that cannot be graded cannot be governed.
 *
 * The floor: over a purpose's newest LABEL_FLOOR_WINDOW in-band outcome rows
 * on its ACT question (challengers excluded), once at least
 * DECISION_GATE_ACT_LABEL_FLOOR_MIN_N (default 100) exist, the labelled share
 * must reach DECISION_GATE_ACT_LABEL_FLOOR (default 0.05 — a 30-label demote
 * window then fills within ~600 decisions; the 1-in-10 control samples keep
 * the governable act purposes above it: wake_triage 9.3 %, sweep_triage 20 %,
 * turn_plan 100 % in-band act-mode coverage over the same 7 d). Two seams use it:
 *   - ADMISSION (decision-gate-readiness buildReadinessArtifacts): a stamp is
 *     NOT READY while its band coverage is under the floor — the admin PUT and
 *     the rollout automaton can never (re-)admit an ungradeable purpose;
 *   - the DURABLE demote pass (decision-gate-durable-demote): a purpose
 *     EFFECTIVELY in act whose ACT-MODE band coverage is under the floor is
 *     demoted act → shadow through the same writer as a precision breach
 *     (reason 'label_floor').
 * Pure. Kill switch DECISION_GATE_ACT_LABEL_FLOOR_DISABLED=1 (both seams).
 */
import { isActQuestionOf, type DecisionGateRow } from './decision-gate-fit';

export const LABEL_FLOOR_DEFAULT = 0.05;
export const LABEL_FLOOR_MIN_N_DEFAULT = 100;
/** Newest in-band outcome rows per purpose the coverage is measured over. */
export const LABEL_FLOOR_WINDOW = 500;

type Env = Record<string, string | undefined>;

export function labelFloorDisabled(env: Env = process.env): boolean {
  const v = String(env.DECISION_GATE_ACT_LABEL_FLOOR_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
export function labelFloor(env: Env = process.env): number {
  const n = Number(env.DECISION_GATE_ACT_LABEL_FLOOR);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : LABEL_FLOOR_DEFAULT;
}
export function labelFloorMinN(env: Env = process.env): number {
  const n = Number(env.DECISION_GATE_ACT_LABEL_FLOOR_MIN_N);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : LABEL_FLOOR_MIN_N_DEFAULT;
}

export interface LabelCoverage {
  /** in-band outcome rows on the act question (newest LABEL_FLOOR_WINDOW) */
  total: number;
  /** of those, rows carrying a boolean `agreed` (a real label) */
  labelled: number;
  coverage: number;
  since: string | null;
}

/**
 * Per purpose: the labelled share of its in-band outcome rows on the ACT
 * question. `actModeOnly` restricts to decisions made in act mode (the demote
 * seam); the admission seam counts every mode — a band that shadow never got
 * labels for will not get them in act either. Rows oldest first. Pure.
 */
export function actBandLabelCoverage(rows: readonly DecisionGateRow[], opts?: { purposes?: ReadonlySet<string>; actModeOnly?: boolean }): Map<string, LabelCoverage> {
  const per = new Map<string, Array<{ labelled: boolean; at: string | null }>>();
  for (const r of rows ?? []) {
    const m: any = r?.meta;
    if (!m || m.phase !== 'outcome' || m.inActBand !== true || m.challenger === true) continue;
    const purpose = String(m.purpose ?? '');
    if (!purpose || (opts?.purposes && !opts.purposes.has(purpose))) continue;
    if (opts?.actModeOnly && m.mode !== 'act') continue;
    if (!isActQuestionOf(purpose, String(m.question ?? ''))) continue;
    const list = per.get(purpose) ?? [];
    list.push({ labelled: typeof m.agreed === 'boolean', at: r.createdAt ? new Date(r.createdAt as any).toISOString() : null });
    if (list.length > LABEL_FLOOR_WINDOW) list.shift();
    per.set(purpose, list);
  }
  const out = new Map<string, LabelCoverage>();
  for (const [p, list] of per) {
    const labelled = list.filter((x) => x.labelled).length;
    out.set(p, { total: list.length, labelled, coverage: list.length ? labelled / list.length : 0, since: list[0]?.at ?? null });
  }
  return out;
}

/** Under the floor (with enough decisions to judge)? Returns the reason line when so. Pure. */
export function labelFloorBreach(cov: LabelCoverage | undefined, env: Env = process.env): string | null {
  if (!cov || labelFloorDisabled(env)) return null;
  if (cov.total < labelFloorMinN(env)) return null;
  const floor = labelFloor(env);
  if (cov.coverage >= floor) return null;
  return `act-band label coverage ${(cov.coverage * 100).toFixed(1)}% (${cov.labelled}/${cov.total} in-band decisions labelled) is under the ${(floor * 100).toFixed(0)}% floor — an act purpose that cannot be graded can never be auto-demoted`;
}

/**
 * Admission seam: mark every stamp entry whose band coverage is under the floor
 * NOT READY (reason first). Returns a NEW stamp; entries without a breach are
 * returned as they were. Pure.
 */
export function applyLabelFloorToStamp<T extends { ready: boolean; reasons: string[] }>(stamp: Record<string, T>, rows: readonly DecisionGateRow[], env: Env = process.env): Record<string, T & { labelCoverage?: number }> {
  if (labelFloorDisabled(env)) return stamp;
  const cov = actBandLabelCoverage(rows, { purposes: new Set(Object.keys(stamp)) });
  const out: Record<string, T & { labelCoverage?: number }> = {};
  for (const [purpose, entry] of Object.entries(stamp)) {
    const c = cov.get(purpose);
    const breach = labelFloorBreach(c, env);
    out[purpose] = breach
      ? { ...entry, ready: false, reasons: [breach, ...entry.reasons.filter((r) => r !== breach)], labelCoverage: Number(c!.coverage.toFixed(3)) }
      : c && c.total >= labelFloorMinN(env) ? { ...entry, labelCoverage: Number(c.coverage.toFixed(3)) } : entry;
  }
  return out;
}
