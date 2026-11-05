/**
 * Verify-stage cap defaults — a LEAF module with NO imports (ticket 91120212).
 *
 * Why a leaf: the scaffolded default and the code default disagreed (300 000 vs
 * 600 000), so a newly scaffolded repo had HALF the verify budget of a repo with
 * no `loop` block — which deterministically walled a legitimate 329 s suite at a
 * 300 s cap. The scaffold must therefore TRACK the code default instead of
 * hard-coding a copy. Sharing the value through a leaf keeps
 * `scaffolding.service.ts` free of any edge into `verify.service.ts` (whose
 * import graph reaches `config/env`).
 *
 * Why the ceiling matters: the advice a timeout shows a lane is only useful if
 * the number it names can actually take effect. It cannot be "just double it" —
 * 2 × 600 000 = 1 200 000 ms (20 min) exceeds BOTH of the harness's own timers:
 *
 *  - `TOOL_HARD_TIMEOUT_MS` (agent.ts, 15 min) races every tool call and, on
 *    expiry, aborts with "Do not retry it" WITHOUT naming a cap — so a stage
 *    longer than that can never render the actionable verdict at all;
 *  - the PR-gate auto-verify deadline (pr-gate-docs-only.ts, 12 min default /
 *    14 min ceiling) covers the verify-slot queue wait AND the whole chain, so
 *    one stage must leave room for the rest.
 *
 * Recommending 20 min would have walked the lane into a second, opaque wall —
 * the exact "no in-repo escape" class this ticket is about. So the advice names
 * the default (10 min), states the ceiling, and tells a lane whose suite still
 * does not fit to SHARD the stage rather than chase a longer cap.
 */

/** The harness default per-command budget for one verify stage (10 min).
 *  `DEFAULT_LOOP.perCommandTimeoutMs` and every freshly scaffolded config use
 *  this value, so a scaffolded repo and a bare one behave identically. */
export const DEFAULT_PER_COMMAND_TIMEOUT_MS = 600_000;

/** The largest stage cap that can still produce a verdict: one minute under the
 *  harness's 15-min tool abort, mirroring `PR_GATE_AUTO_VERIFY_DEADLINE_MAX_MS`'s
 *  own "one minute under the loop's hard abort" rule. A cap above this cannot
 *  render a timeout verdict — the tool abort fires first. */
export const VERIFY_STAGE_CAP_CEILING_MS = 14 * 60 * 1000;

/** The value a stage-timeout notice recommends a lane write into
 *  `.digby/config.json` — the default, clamped to the ceiling above. Never 2×:
 *  see this module's header. */
export function recommendedStageCapMs(): number {
  return Math.min(DEFAULT_PER_COMMAND_TIMEOUT_MS, VERIFY_STAGE_CAP_CEILING_MS);
}

/**
 * The ONE render of the stage-timeout remedy, shared by the verify TOOL
 * (tools.ts) and the AUTO-VERIFY feedback (verify.service.ts) so the two seams
 * can never drift apart. Both used to answer a cap kill with text that forbade
 * the config edit — this ticket's actual defect.
 *
 * Kept count-agnostic (no stage name) so callers can append their own anchor.
 */
export function stageTimeoutAdvice(killedAtMs?: number): string {
  const at = killedAtMs ? ` (at ${killedAtMs} ms)` : '';
  return `The stage was KILLED AT THE HARNESS PER-COMMAND TIMEOUT${at} — a CAP hit, not a test verdict: the command may simply need longer than this repo's budget.
Decide which it is:
- If the code is sound and the stage is LEGITIMATELY SLOW (a large suite, a slow cold start), raise this repo's cap in .digby/config.json: "loop": { "perCommandTimeoutMs": ${String(recommendedStageCapMs())} }. That key IS the per-repo override, and that value is the harness default. It cannot usefully exceed ${String(VERIFY_STAGE_CAP_CEILING_MS)} ms: the harness aborts any tool at 900 s and the PR-gate auto-verify deadline tops out at ${String(VERIFY_STAGE_CAP_CEILING_MS)} ms, so a larger number replaces a clean timeout verdict with an opaque abort. A suite that still does not fit must be SHARDED across stages, not given a longer cap.
- If the stage is HUNG (an infinite loop, a deadlock, a test awaiting something that never arrives), fix the DEFECT — a bigger cap only buys a longer hang.
Do NOT disable or weaken the check to force a pass.`;
}

/** Pull the cap a death was reported against out of the tail the chain already
 *  wrote ("...per-command timeout (300000 ms)"), so the advice quotes the lane's
 *  ACTUAL budget rather than a guess. Returns undefined when absent. */
export function killedAtMsFromTail(outputTail: string): number | undefined {
  const m = /per-command timeout \((\d+) ms\)/.exec(outputTail || '');
  return m ? Number(m[1]) : undefined;
}