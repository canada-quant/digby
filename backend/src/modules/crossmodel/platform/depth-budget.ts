/**
 * DepthBudget (2026-09-26, docs/DEPTH_UX_SOTA_2026-09-26.md §4). ONE typed
 * object per turn, RECORDED on metadata.depth.budget and the compute_policy
 * telemetry row. What the harness actually ENFORCES (audit 2026-09-26,
 * budgets-cost-2 / docs-drift-4 / H2 — honest inventory; owner directive
 * 2026-09-27 "no hidden cost caps"):
 *
 *   (no spend bound)  There is NO per-turn / per-message USD bound. The former
 *                    `maxUsd` (DEPTH_BUDGET_MAX_USD, default $0.25 — crossing it
 *                    refused the next Dig-deeper rung and forced a FINAL TURN)
 *                    was DELETED on 2026-09-27: the owner's directive is that no
 *                    cost cap exists anywhere in the framework unless a user sets
 *                    ProjectSettings.spendCapUsdPerDay on a project — and that
 *                    cap is enforced by the schedule sweeper on machine firings
 *                    (coding/spend-cap.service.ts), never on a human turn or a
 *                    Dig-deeper tap. The turn ledger (turn-spend.ts) is a
 *                    RECORD only (`metadata.depth.spentUsd`).
 *   checker          RECORDED: a Double Checker runs on this turn (the plan
 *                    decides — shouldSpawnChecker reads `plan`, not this).
 *   checkerEffort    RECORDED: what the plan IMPLIES ('max' on the stakes path
 *                    / lead max). The checker's ACTUAL reasoning_effort is the
 *                    chat-agent `checkerEffort` variable ('max' unless the
 *                    checker_route purpose acted) — persisted as
 *                    depth.facts.checkerEffortSent so labels see the truth.
 *   council          RECORDED: a council RUNS on this turn — the L3 preset or
 *                    a research escalation. A gate `council:'background'` is
 *                    NOT counted (nothing consumes it).
 *   maxBackgroundMs  ENFORCED on the Double Checker / late reconcile only:
 *                    through `backgroundBoundMs` (settings-switches-5) it bounds
 *                    the Double Checker's harness kill + 300 s self-wrap and the
 *                    late reconcile wait, capped by CROSS_CHECK_HARD_MS (15 min;
 *                    the default equals the cap, so nothing changes there unless
 *                    the env is shortened). It NO LONGER bounds the Dig-deeper
 *                    RESEARCH rung (2026-10-20, owner: "deep research shouldn't
 *                    have any limit" — chat-agent/council-dispatch.ts
 *                    researchNoWallClock): the rung's council
 *                    runs INLINE on the tapper's stream with no final-turn
 *                    deadline, bounded by a
 *                    token-idle stream stall watchdog (COUNCIL_STALL_MS), a
 *                    progress-based dispatch wait and its step caps — like the
 *                    L3 preset and the research lane. Under
 *                    RESEARCH_NO_WALL_CLOCK_DISABLED=1 the rung is budgeted as
 *                    before (audit H2): the lead's FINAL-TURN deadline is the
 *                    budget and each colleague / clone gets what is left of it at
 *                    dispatch (floor 60 s — `chat-agent/compute-policy-wiring.ts
 *                    researchRungDeadlineMs`), the L3 preset lead keeps
 *                    COUNCIL_LEAD_BACKSTOP_MS (40 min), and when the rung's lead
 *                    hits the deadline coding/agent.ts reports `deadlineHit` and
 *                    the harness stamps depth.facts.backgroundDeadlineHit (+ the
 *                    compute_policy `facts` row). Machine lanes are untouched.
 *                    Kill switch: DEPTH_BUDGET_DISABLED=1 ⇒ the caps alone
 *                    everywhere ⇒ the rung's deadline (it matters only under
 *                    RESEARCH_NO_WALL_CLOCK_DISABLED=1).
 *
 * The one-checker / one-council-per-message rule lives in the persisted rung
 * ladder (compute-policy-wiring nextRungForMessage), not here — the former
 * `budgetVerdict` / `widenForRung` had no runtime caller and were deleted.
 * Pure leaf: no I/O, env reads only. DEPTH_BUDGET_DISABLED=1 ⇒ the time
 * bound is recorded but applied to no deadline (a time switch, not a cost one).
 */

import type { DepthPlan } from './compute-policy-gate';

export interface DepthBudget {
  checker: boolean;
  checkerEffort: 'high' | 'max';
  council: boolean;
  maxBackgroundMs: number;
}

export const DEPTH_BUDGET_MAX_BACKGROUND_MS_DEFAULT = 15 * 60_000;
export const DEPTH_BUDGET_MAX_BACKGROUND_MS_CEILING = 40 * 60_000; // the council's own backstop

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** DEPTH_BUDGET_DISABLED=1 — the budget is recorded but never enforced (the time bound applies to no deadline). */
export function depthBudgetDisabled(): boolean {
  return onFlag(process.env.DEPTH_BUDGET_DISABLED);
}

/** DEPTH_BUDGET_MAX_BACKGROUND_MS (default 15 min; clamped 60 s..40 min). */
export function depthBudgetMaxBackgroundMs(): number {
  const raw = process.env.DEPTH_BUDGET_MAX_BACKGROUND_MS;
  if (raw === undefined || String(raw).trim() === '') return DEPTH_BUDGET_MAX_BACKGROUND_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEPTH_BUDGET_MAX_BACKGROUND_MS_DEFAULT;
  return Math.min(DEPTH_BUDGET_MAX_BACKGROUND_MS_CEILING, Math.max(60_000, Math.floor(n)));
}

/**
 * The background bound is off — maxBackgroundMs is recorded on the row but
 * never applied to a deadline (the caps alone) — exactly when
 * DEPTH_BUDGET_DISABLED=1 ("the budget is recorded but never enforced").
 */
export function depthBudgetBackgroundBoundDisabled(): boolean {
  return depthBudgetDisabled();
}

export interface BackgroundBound {
  /** the deadline the job actually runs under (ms) */
  ms: number;
  /** what set it: the budget knob, the job's own harness cap, or the kill switch */
  source: 'depth_budget' | 'cap' | 'disabled';
}

/**
 * The deadline a background job runs under (pure): the tighter of the job's
 * own harness cap and budget.maxBackgroundMs. Fail-open — a disabled bound, a
 * missing / garbage budget value, or a knob wider than the cap leaves the cap
 * untouched, so the switch can only SHORTEN a job, never lengthen one. A
 * non-positive cap is treated as the 40-min ceiling.
 */
export function backgroundBoundMs(budget: Pick<DepthBudget, 'maxBackgroundMs'> | null | undefined, capMs: number, opts: { disabled?: boolean } = {}): BackgroundBound {
  const cap = Number.isFinite(capMs) && capMs > 0 ? Math.floor(capMs) : DEPTH_BUDGET_MAX_BACKGROUND_MS_CEILING;
  const disabled = opts.disabled ?? depthBudgetBackgroundBoundDisabled();
  if (disabled) return { ms: cap, source: 'disabled' };
  const knob = Number(budget?.maxBackgroundMs);
  if (!Number.isFinite(knob) || knob < 60_000 || knob >= cap) return { ms: cap, source: 'cap' };
  return { ms: Math.floor(knob), source: 'depth_budget' };
}

/**
 * The budget a plan implies (pure). A send plan: checker ⇔ spawnChecker or
 * the stakes path; council ⇔ the L3 preset (a gate `council:'background'` is
 * NOT a council that runs — audit 2026-09-26 routing-unify-3). An ESCALATION
 * plan (source 'escalation') is read from its `rung` ONLY — 'verify' ⇒
 * checker, 'research' ⇒ council, null ⇒ neither — never from `source` alone.
 * No USD field: there is no spend bound (owner 2026-09-27).
 */
export function depthBudgetFor(plan: Pick<DepthPlan, 'preset' | 'spawnChecker' | 'checkerWaitMs' | 'leadEffort' | 'council' | 'source'> & Partial<Pick<DepthPlan, 'rung'>>): DepthBudget {
  const stakesPath = plan.checkerWaitMs > 0;
  const escalation = plan.source === 'escalation';
  const rung = escalation ? (plan.rung ?? null) : null;
  return {
    checker: escalation ? rung === 'verify' : (plan.spawnChecker || stakesPath),
    checkerEffort: stakesPath || plan.leadEffort === 'max' ? 'max' : 'high',
    council: escalation ? rung === 'research' : plan.preset === 'deep_research',
    maxBackgroundMs: depthBudgetMaxBackgroundMs(),
  };
}
