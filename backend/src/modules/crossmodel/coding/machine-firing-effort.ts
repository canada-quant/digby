/**
 * A4 — MACHINE-FIRING EFFORT STEP-DOWN (2026-10-04, coding quick wins; the
 * owner chose option A of the coding dynamic-roster options readout).
 *
 * Why: every coding run's lead seat sends reasoning_effort 'max' (coding-
 * model.ts — owner 2026-09-03 / 2026-09-29 "max everywhere"), including the
 * schedule and hook firings that make up most lane traffic (14-day prod
 * readout: 3,182 lane runs, schedule 2,010 / hook 149 / agent 939 / human 84;
 * coding spend ≈ $550/day). A recurring firing on a plan board that is already
 * 100 % complete is told by the harness itself ("[ALL-COMPLETE BOARD]",
 * schedule.service allCompleteBoardNotice) to pull the next queued item or
 * answer in one line — max-effort thinking buys nothing there.
 *
 * Rule (deterministic, claim time in run-executor.ts): a SCHEDULE or HOOK
 * firing (triggerKind 'schedule' | 'hook' — never a human turn, never an
 * owner-dispatched run, never an agent send / webhook / harness auto-resume)
 * whose plan board is ALL-COMPLETE by the very predicate the advisory uses
 * (schedule.service planBoardAllComplete: a non-empty plan, every step
 * completed, no blocked step) runs its lead seat at reasoning_effort 'high'.
 * Anything else — an open or blocked board, no plan, a plan read error —
 * keeps 'max'. Supervisor chats never reach this seam: they run on the
 * chat-agent path (a workspace attach to a supervisor lane is refused —
 * coding-data.service ensureChatWorkspaceState).
 *
 * The second trigger the owner listed ("the schedule's last 3 firings were
 * no-ops") is NOT implemented: no per-firing no-op signal is persisted for
 * coding lanes today (run_tool_profile carries no mutation count, run receipts
 * exclude write_file / edit_file, the zero-edit streak exists only inside a
 * continuation prompt), and inventing one here would be neither cheap nor
 * reliable.
 *
 * The provider seam is coding-model.ts capReasoningEffort: it only LOWERS a
 * reasoning_effort the seat already sends — a built-in GLM / DeepSeek seat
 * goes max → high; a custom endpoint gets 'high' only when it was sending an
 * effort (registry 'auto' / 'supported'), an 'unsupported' endpoint or a
 * no-think model still gets nothing, and Kimi K3 (whose entry sends no effort
 * and runs its server default) is left alone. The effort chosen + the reason
 * ride the run's run_spend / run_tokens stamp (reasoningEffort, effortReason).
 *
 * Kill switch MACHINE_FIRING_EFFORT_STEPDOWN_DISABLED=1: no decision, no input
 * field, no stamp — every firing at the seat's effort exactly as before.
 * Pure leaf (no imports).
 */

export function machineFiringEffortStepdownDisabled(): boolean {
  const v = String(process.env.MACHINE_FIRING_EFFORT_STEPDOWN_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** The effort an all-complete-board machine firing runs at. */
export const MACHINE_FIRING_STEPDOWN_EFFORT = 'high' as const;

export type MachineFiringEffortReason = 'all_complete_board' | 'board_open' | 'no_plan' | 'new_work';

/** Carried on AgentRunInput.machineFiringEffort (top-level runs only). */
export interface MachineFiringEffort {
  /** The effort cap to apply, or null = keep the seat's own effort (recorded only). */
  cap: typeof MACHINE_FIRING_STEPDOWN_EFFORT | null;
  reason: MachineFiringEffortReason;
}

/** True for the trigger kinds the step-down judges (schedule / hook firings only). */
export function machineFiringEffortApplies(o: { triggerKind: string; ownerDispatch?: boolean }): boolean {
  if (o.ownerDispatch) return false;
  return o.triggerKind === 'schedule' || o.triggerKind === 'hook';
}

/**
 * Pure decision from the claim-time board read. audit 2026-10-06 T7-1
 * (stanne.md #4): `newWork` — the firing's prompt names a todo of this lane,
 * or the lane holds an actionable assigned todo (lane-todos.ts
 * firingStartsNewWork) — keeps the seat's effort on an all-complete board:
 * a one-shot that STARTS a build always lands on the previous run's finished
 * plan (run 7a5e8e7d: a 4.5-h, $18 build ran at 'high'). Omitted / false =
 * the original rule (kill switch MACHINE_FIRING_NEW_WORK_DISABLED=1 never
 * computes it).
 */
export function machineFiringEffortDecision(o: { hasPlan: boolean; allComplete: boolean; newWork?: boolean }): MachineFiringEffort {
  if (!o.hasPlan) return { cap: null, reason: 'no_plan' };
  if (o.allComplete) return o.newWork ? { cap: null, reason: 'new_work' } : { cap: MACHINE_FIRING_STEPDOWN_EFFORT, reason: 'all_complete_board' };
  return { cap: null, reason: 'board_open' };
}
