/**
 * Evidence-bearing vs non-evidence tool names — ONE vocabulary shared by the
 * agent loop's deterministic zero-tool pre-final gate (agent.ts) and the
 * evidence guard's per-kind claim resolution (run-evidence-guard.ts).
 *
 * Why shared (owner transcript 2026-09-08, session a8976e11 firing-87): the
 * zero-tool gate used to count EVERY dispatched tool call as "fresh evidence",
 * while the guard has always treated update_plan / search_memory /
 * search_code_semantic / ask_user as evidencing NOTHING. A machine run that
 * opened with update_plan ("Setting the plan…") and then pattern-completed
 * its whole audit therefore sailed past the deterministic gate and was only
 * caught by the (regex + GitHub) guard lanes downstream. The two gates now
 * agree on what counts as an attempt at fresh evidence.
 *
 * Pure constants — no imports, safe for both module graphs.
 */

/** Tools whose execution proves nothing about the outside world. */
export const NON_EVIDENCE_TOOLS: ReadonlySet<string> = new Set([
  'update_plan',
  'search_memory',
  'search_code_semantic',
  'ask_user',
  'load_tool_group', // progressive-disclosure meta-tool (agent.ts) — changes the schema, not the world
  'list_tool_groups', 'load_tools', // the tool-groups gateway pair (coding/tool-groups.ts) — same: schema, not world
  'wait_for_chat', // T3b bounded block on another chat — a wait, not an observation
  // build 2026-10-08 F-1: the typed finish_run (coding/finish-run.ts) records the model's own account of the
  // run — it observes nothing, so it never counts as fresh evidence (zero-tool gate, wake_effort label,
  // production-state grounding, the guard's evidence tiers).
  'finish_run',
]);

/**
 * Read-only platform/fleet OBSERVATION tools (ticket 212b3aa0): calls that
 * observe platform state and change nothing — the fleet-monitoring probe
 * surface the machine-wake doctrine mandates ("probe-first: todo_get …,
 * get_chat_status …"). Their results ARE ground truth (the platform's own
 * DB/API), so a successful execution is evidence for probe/benchmark claims —
 * but NEVER for pr merge/create/close, deploy, or commit_pushed (observing the world cannot change
 * it). Before this set existed, those claim kinds bound ONLY to the
 * run_command/git_/github_ action class, so a pure fleet-monitoring run that
 * followed its probe-first doctrine was GUARANTEED an unprovable-claim strike
 * it could never escape with the mandated tools (the 2026-09-10 bench-lane
 * 3× final_answer streak).
 * Deliberate boundary: connector user-data reads (gmail_*, slack_*, …), the
 * account group, and state-changing probe-ish actions (infra_action,
 * restart_dev_tailnet) stay OUT — separate claim surfaces with no incident
 * evidence; widen only against a replayed trap.
 */
export const PLATFORM_OBSERVE_TOOLS: ReadonlySet<string> = new Set([
  'get_chat_status', 'list_chats', 'get_chat_messages',
  'list_projects', 'get_project',
  'goal_list', 'goal_get', 'todo_list', 'todo_get',
  'list_schedules', 'schedule_get',
  'hook_list',
  'list_feedback', 'get_feedback',
  'get_platform_network_info',
  // (ticket a9846924, 2026-10-07) list_owner_questions joins the observe set:
  // the action verifier's board lane names this tool — verbatim — as a
  // sanctioned source for owner-question status ("a this-run …
  // list_owner_questions pull"), yet it minted NO receipt, so a lane's claimed
  // fresh probe was receipt-invisible while goal_list / todo_list probes
  // leave rows. The incident's adjudication could not distinguish "probed
  // then raced" from "recalled from memory" — the exact question that
  // decides a board-status strike. It is a read-only owner-question probe
  // (JSON envelope), the same class as the goal/todo reads already here.
  'list_owner_questions',
  // the supervisor's verification read (2026-09-18): deploy runs / main head /
  // per-box sha and health / loop-metric counts — the platform's own records.
  'get_fleet_telemetry',
  // the live seat probe (WI-M 2026-09-25): "seat X is alive / dead" is a
  // claim only this executed read can evidence — its {ok, latencyMs, error}
  // envelope IS the observation; the admin-gate refusal receipts ok:false.
  'test_model_role',
  // the decision-gate status read (rollout self-governance, 2026-09-27): "purpose X
  // is shadow / parked / act" is a claim only this executed read can evidence.
  'get_decision_gate_status',
  // the delegation ledger's reads (build 2026-10-11 DL-1): "the lane I started finished / failed" read from the
  // ledger is a fleet-state observation exactly like get_chat_status — the reads that now replace those polls.
  'task_get', 'task_list',
]);

/**
 * Remote-INFRA probe subjects (ticket 4df4bb41 reconciliation): the
 * non-generic PROBE_RE alternatives. A probe claim whose line names a box /
 * tailnet / remote host asserts an observation of REMOTE INFRASTRUCTURE —
 * fleet/platform reads can never produce that (only run_command / web reads
 * reach a box), so PLATFORM_OBSERVE_TOOLS must NOT evidence it (the
 * 4df4bb41 steer-keeper's "box probe healthy, tailnet probe active" stays a
 * conviction with a fleet-reads-only journal). Bare "probe[d]" lines without
 * an infra subject are fleet/platform-state probes — the class
 * PLATFORM_OBSERVE_TOOLS DOES evidence (212b3aa0).
 */
export const INFRA_PROBE_SUBJECT_RE = /\b(?:box|tailnet|remote host)\b/i;

// ── DEPLOY-OBSERVATION evidence tier (shortfall F32, 2026-10-22) ────────────
//
// The incident class (found by the verifier-strike surface probe, explorer
// bg1-378g, and verified first-hand): DEPLOY_ALT_RE extracts a `deploy` claim
// from pure OBSERVATION lines — "health check 200", "prod green", "digby.ai
// healthy" — but every deploy evidence tier bound ONLY to the external-action
// class (run_command|git_|open_pull_request|github_/merge_pull_request). A
// lane that follows the deploy doctrine's OWN mandated verification reads —
// get_fleet_telemetry view 'deploy' (backend platform-tools.ts:6559 even
// closes ticket updates with "Wait for the deploy wave to go green and the
// boxes to report the new main head (get_fleet_telemetry view deploy)") or a
// scrape_as_markdown/browser_task read of the health endpoint — could never
// evidence an honest health-observation sentence. Same shape as the 212b3aa0
// probe-tier trap: a doctrine-mandated read class was provably invisible to
// the tier that adjudicates the doctrine's own vocabulary.
//
// The chat lane's PRODUCTION-STATE lane (action-verifier.ts, 2026-09-27) is
// the in-repo precedent: "on main head" is grounded there by "an onMainHead
// field in a platform-observe read (get_fleet_telemetry view 'deploy')".
// GUARD 5 Lane A (run-evidence-guard.ts) holds the same doctrine for run
// ids: a deploy-run id this run OBSERVED in tool output "was OBSERVED — the
// run watched that deploy". This tier extends that doctrine to the
// health-sentence shape.
//
// CONTENT BOUNDARY — only the DEPLOY_ALT observation shape widens: a line
// carrying the deploy VERB ("deployed to prod", "the deploy flipped green")
// asserts the run PERFORMED the deploy — that stays action-only forever
// (PR-merge/deploy-completion claims keep the full external-action tier; the
// 680dd00a/4df4bb41 zero-tool incident class convicts unchanged). The
// boundary predicate mirrors DEPLOY_ALT_RE exactly (health check | prod |
// digby.ai + green|200|healthy) and must fire only on lines WITHOUT the
// deploy verb — isDeployObservationClaimText is the single site both
// consumers (guard + receipts) call, so the twins can never drift again.

/** The deploy-observation predicate — the guard's DEPLOY_ALT_RE, verbatim (single shared home). */
export const DEPLOY_HEALTH_SURFACE_RE = /\b(?:health\s?check|prod|digby\.ai)\b[^\n]*\b(?:green|200|healthy)\b/i;
/**
 * The deploy-ACTION verb — a line carrying it asserts the run DID the deploy
 * (never widens). F2 (review): covers the full deploy word-family
 * (redeployed / deploying / deployments — \w* catches every suffix and the
 * optional "re" prefix, which the extraction twin DEPLOY_RE also misses but
 * whose lines still extract via the health surface alone) plus the shipped /
 * rolled-out / went-live paraphrases — "Shipped to prod; health check 200"
 * asserts an action as strongly as "deployed".
 */
export const DEPLOY_ACTION_VERB_RE = /\b(?:(?:re)?deploy\w*|shipped|rolled\s+out|went\s+live|pushed\s+to\s+prod)\b/i;

/** True when a `deploy` claim line is the pure OBSERVATION shape (no deploy verb): "health check 200", "prod green", "digby.ai healthy". */
export function isDeployObservationClaimText(text?: string): boolean {
  if (!text) return false;
  return DEPLOY_HEALTH_SURFACE_RE.test(text) && !DEPLOY_ACTION_VERB_RE.test(text);
}

/**
 * DEPLOY-HEALTH observation tools: get_fleet_telemetry (deploy/health view —
 * the platform's own box-sha/health records, the deploy doctrine's mandated
 * verification read) and the web reads (scrape_as_markdown / browser_task on
 * the health endpoint — the same web-read class that already evidences the
 * observation-shaped probe kind). Deliberately NARROWER than
 * PLATFORM_OBSERVE_TOOLS as a whole: a generic fleet read (get_chat_status,
 * todo_get, …) can never vouch "prod is healthy" — that stays a conviction
 * (the 212b3aa0 anti-laundering boundary keeps its pins green).
 */
export const DEPLOY_HEALTH_OBSERVATION_TOOLS: ReadonlySet<string> = new Set([
  'get_fleet_telemetry',
  'scrape_as_markdown', 'scrape_batch', 'browser_task',
]);

/**
 * EVIDENCE_GUARD_DEPLOY_OBSERVATION_DISABLED=1 — kill switch restoring the
 * pre-F32 action-only deploy tier (the widening vanishes at all four sites
 * and the twin regexes stay synced). Registered in switch-registry.ts.
 */
export const DEPLOY_OBSERVATION_TIER_DISABLED_ENV = 'EVIDENCE_GUARD_DEPLOY_OBSERVATION_DISABLED';
export function deployObservationTierDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DEPLOY_OBSERVATION_TIER_DISABLED_ENV] === '1';
}

/** True when a dispatched call of this tool counts as an attempt at fresh evidence. */
export function isEvidenceToolName(name: unknown): boolean {
  return typeof name === 'string' && name.length > 0 && !NON_EVIDENCE_TOOLS.has(name);
}

/**
 * Evidence-bearing tool calls already present in a (resumed) transcript:
 * assistant turns' tool_calls whose function name is evidence-bearing. A
 * checkpoint is trimmed to its pre-model boundary, so every assistant
 * tool_calls turn it carries completed (its role:'tool' results follow) —
 * counting the calls by NAME is equivalent to the old role:'tool' tally,
 * minus the non-evidence names.
 */
export function countEvidenceToolCalls(messages: ReadonlyArray<unknown>): number {
  let n = 0;
  for (const m of messages) {
    const msg = m as { role?: unknown; tool_calls?: unknown } | null | undefined;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls as Array<{ function?: { name?: unknown } } | null | undefined>) {
      if (isEvidenceToolName(tc?.function?.name)) n += 1;
    }
  }
  return n;
}
