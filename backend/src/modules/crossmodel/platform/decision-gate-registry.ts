/**
 * DECISION-ROLE REGISTRY — the ONE typed source of truth for every purpose the
 * decision gate answers (rollout self-governance, 2026-09-27; owner: "make sure
 * the framework … understands all the decision model roles in the framework so
 * it can take back over everything").
 *
 * What lives here and nowhere else: per purpose, what it DECIDES, WHERE the
 * act consumer sits (file:function), what ACT does (the work it removes or
 * adds), how the harness LABELS the outcome and when the label closes, the
 * ROLLOUT TIER (1 = the automaton flips it on a fresh measured READY stamp,
 * 2 = ready is reported to the owner as ONE question, 3 = never auto — the
 * reason is stated), the kill switches, and the owner lock when one exists.
 *
 * Everything the runtime already knows is READ from the runtime, never
 * duplicated: the label / description from DECISION_PURPOSES
 * (decision-gate-modes), the act question / kind / threshold / consumer from
 * ACT_POLICIES (decision-gate-fit), the readiness bars from readinessBarsFor,
 * the registry act caps from PURPOSE_ACT_CAPS, the control gate from
 * PURPOSE_CONTROL_GATED. decision-gate-registry.test.ts pins that every
 * purpose the runtime knows is a row here and vice-versa — a new purpose
 * without a row fails CI, exactly as a new tool without a doctrine row does.
 *
 * LEAF-ish: imports only the two leaf tables above (no prisma, no services).
 */

import type { DecisionPurpose } from './decision-gate';
import {
  DECISION_PURPOSES, PURPOSE_ACT_CAPS, PURPOSE_RETIRED, PURPOSE_RETIRED_ON_HUMAN_TURNS, actCapLiftEnv, humanRetireLiftEnv, purposeActCap, purposeRetired,
  purposeRetiredOnHumanTurns, retireLiftEnv, type HumanTurnRetirement, type PurposeActCap, type PurposeRetirement,
} from './decision-gate-modes';
import { ACT_POLICIES, PURPOSE_CONTROL_GATED, READINESS_MIN_LABELS_FLOOR, READINESS_VOLUME_RULE, READINESS_VOLUME_SCALE_DAYS, readinessBarsFor } from './decision-gate-fit';

export type StorablePurpose = Exclude<DecisionPurpose, 'probe'>;

/** 1 = safe to flip on READY; 2 = needs a human look; 3 = never auto. */
export type RolloutTier = 1 | 2 | 3;

/**
 * backlog E13 (2026-09-28): the REGISTRY DECISION for a purpose whose readout
 * says it should not simply wait for READY — stated once, here, so the
 * automaton, the admin table and the playbook read the same verdict:
 *   retire        — no act consumer exists or is planned; the bare default mode
 *                   is off (decision-gate-modes PURPOSE_RETIRED) and act is
 *                   refused (PURPOSE_ACT_CAPS); the row stays for history;
 *   shadow_review — stays in shadow with a REVIEW DATE and the bar it must
 *                   clear by then, else it is retired;
 *   shadow        — stays in shadow; the reason and the next step are named.
 */
export interface RegistryLifecycle {
  decision: 'retire' | 'shadow_review' | 'shadow';
  /** shadow_review: the ISO date the readout is judged (retire below `bar`). */
  reviewBy?: string;
  /** What the readout must show by `reviewBy` to stay (shadow_review) — or the next step (shadow). */
  bar?: string;
  /**
   * DECISION-GATE-LIFECYCLE (2026-10-20): `bar` in machine-checkable form —
   * the readiness stamp's newest-partition AUROC and label count it must
   * reach by `reviewBy`. The rollout automaton (decision-gate-rollout
   * planLifecycle) sets a shadow_review purpose OFF once the date has passed
   * with this bar unmet; a shadow_review row without it is reported, never
   * enforced (the free-text bar cannot be judged).
   */
  reviewBar?: { minAuroc: number; minLabels: number };
  why: string;
}

export interface DecisionRoleSpec {
  /** One line: the judgment this purpose makes. */
  decides: string;
  /** The act consumer site — file:function (the doc row; the runtime string is ACT_POLICIES[p].consumer). */
  consumerSite: string;
  /** What ACT does: the work it REMOVES (or adds) when confident. */
  actDoes: string;
  /** The harness label and when it closes (the outcome row's `actual`). */
  harnessLabel: string;
  /** Kill switches that restore the pre-gate behaviour on their own (env names only; documented in .env.example). */
  killSwitches: string[];
  /** An owner lock on the act path, when one exists (null = none). */
  ownerLock: string | null;
  tier: RolloutTier;
  /** Why this tier (one sentence; stated once, here). */
  tierWhy: string;
  /** backlog E13: the registry decision when the readout says "do not just wait for READY" (absent = the tier rule alone governs). */
  lifecycle?: RegistryLifecycle;
}

/**
 * The registry proper. Tier rules of thumb:
 *   1 — act only REMOVES bounded harness work behind a heartbeat / deadline
 *       floor (a parked wake is re-delivered, a skipped extractor loses at most
 *       one fold, a routed level keeps the presets as fail-open) — a wrong act
 *       costs a delay and shows up as an auto-demote;
 *   2 — act touches what a HUMAN reads or a lane's cadence in a way a delay
 *       does not undo (an unreconciled answer marked Checked, a wake at lower
 *       effort, a dropped firing, a written verdict), or the purpose is
 *       control-gated / capped and needs a human to read the readout;
 *   3 — there is no act consumer, or the consumer was retired for a
 *       deterministic rule — flipping it is meaningless or already superseded.
 */
export const DECISION_ROLE_REGISTRY: Readonly<Record<StorablePurpose, DecisionRoleSpec>> = {
  wake_triage: {
    decides: 'Does this hook-event group need a supervisor turn NOW, or can it wait?',
    consumerSite: 'platform/hooks.service.ts — the wake delivery seam (needs_turn_now)',
    actDoes: 'parks a non-alarm hook wake for the defer window (≤ 30 min), then delivers it; alarms / owner cards / child results never park',
    harnessLabel: 'the delivered wake ran an evidence-bearing tool or a mutating platform call (harnessActed) — closes at the wake finalize; a parked wake is never labelled, so in act one confident park in 10 DELIVERS as a control (control:true) and its label is the act band the auto-demote measures',
    killSwitches: ['DECISION_GATE_MODE_WAKE_TRIAGE=off (env fallback; the admin mode wins)', 'DECISION_GATE_WAKE_TRIAGE_DEFER_MIN', 'WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED', 'DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'a wrong park is a bounded delay (the wake is re-delivered) and never a lost wake',
  },
  sweep_triage: {
    decides: 'Would this scheduled supervisor sweep be a no-op (nothing moved since the previous sweep)?',
    consumerSite: 'platform/sweep-triage.ts ← coding/schedule.service.ts (needs_turn_now)',
    actDoes: 'skips a stock sweep firing the gate is confident is a no-op; a heartbeat floor still fires every Nth tick',
    harnessLabel: 'the fired sweep took a recorded action (mutating platform call) — closes at the sweep finalize; heartbeat turns are control rows, and since backlog E12 one confident-quiet act skip in 10 FIRES as a control (control:true) so the act band and auto-demote can measure the skip band',
    killSwitches: ['DECISION_GATE_SWEEP_HEARTBEAT_TICKS'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'a skipped tick is re-offered on the next cadence and the heartbeat floor bounds the miss',
  },
  drain_triage: {
    decides: 'Over a queued agent-message batch: ack_only / coalesce / act_now before the detached drain turn?',
    consumerSite: 'platform/drain-triage.ts ← chat-agent/chat-agent.service.ts drainChatQueue (disposition)',
    actDoes: 'parks a confidently quiet batch for one defer window (≤ 15 min) instead of starting a full detached turn; never when a user row waits',
    harnessLabel: 'the drained turn took a recorded action — closes at the drain finalize (a reply to the sender is NOT observable from tool names, which is why the purpose is act-capped)',
    killSwitches: ['DECISION_GATE_DISABLED'],
    ownerLock: null,
    tier: 2,
    tierWhy: 'act-capped in code after 43 % act-period agreement; supervisor_turn_noop replaces it at the drain site — a human reads the readout before the cap is lifted',
  },
  imessage_send: {
    decides: 'Is the user asking to SEND an iMessage now?',
    consumerSite: 'imessage/nlp.ts — the send-intent utility call (send)',
    actDoes: 'skips the send-intent utility call when the gate is confident the message is not a send',
    harnessLabel: 'the utility call / the user’s confirm card — a send that happened labels positive; closes on the turn',
    killSwitches: ['DECISION_GATE_MODE_IMESSAGE_SEND=off (env fallback; the admin mode wins)'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'a wrong skip only costs the utility call’s answer on a non-send; a real send still goes through the confirm card',
  },
  auto_route: {
    decides: 'Which preset (Level 1 / 2 / 3) should a mode=auto send run?',
    consumerSite: 'platform/auto-router-gate.ts ← platform/send-mode.ts resolveSendMode (level)',
    actDoes: 'picks the level for mode=auto sends instead of the regex heuristic; Level 3 needs the higher per-option bar and the quota',
    harnessLabel: 'the explicit-level label window (a picked level) and the Dig-deeper tap — closes on the next human signal or the window closer',
    killSwitches: ['DECISION_GATE_MODE_AUTO_ROUTE=off (env fallback; the admin mode wins)', 'DECISION_GATE_AUTO_ROUTE_LABEL_WINDOW_DISABLED', 'DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH', 'DECISION_GATE_AUTO_ROUTE_HUMAN_RETIRE_LIFTED / DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED (restore the human-turn ask retired 2026-10-06)'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'the presets stay the fail-open and Dig deeper is one tap away — a wrong level is recoverable in-line',
  },
  browser_driver: {
    decides: 'Which browser driver fits this task: cloud read, the paired Mac, or computer use?',
    consumerSite: 'browser-agent/router.ts selectBrowserDriver (driver)',
    actDoes: 'routes from the gate instead of a reasoning-model call; availability gates still run first',
    harnessLabel: 'the driver the reasoning call picked (shadow) / the session outcome — closes when the browser session ends',
    killSwitches: ['DECISION_GATE_MODE_BROWSER_DRIVER=off (env fallback; the admin mode wins)'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'the availability gates bound every choice and the session is already bounded (6 steps / 120 s)',
  },
  memory_extract: {
    decides: 'Does this turn carry anything durable to extract (user facts / project state / thread summary)?',
    consumerSite: 'langgraph/memory.graph.ts updateContextAsync — per extractor noul',
    actDoes: 'skips an extractor the gate is confident has nothing durable to extract',
    harnessLabel: 'whether the extractor actually changed the stored doc (shadow runs it) — closes when the extractor returns',
    killSwitches: ['DECISION_GATE_MODE_MEMORY_EXTRACT=off (env fallback; the admin mode wins)'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'a missed extraction is caught by the next turn and the nightly memory dream; nothing user-visible changes',
  },
  self_audit: {
    decides: 'Does the coding final claim work the run’s receipts do not evidence?',
    consumerSite: 'coding/self-audit-gate.ts ← coding/agent.ts (unevidenced) — RETIRED as an act consumer',
    actDoes: 'would skip the pre-finish self-audit round; superseded by the deterministic receipt rule (coding/self-audit-receipt-rule.ts)',
    harnessLabel: 'the audit round reopened work (any_reopen) — closes at the run finalize',
    killSwitches: ['DECISION_GATE_MODE_SELF_AUDIT=off (env fallback; the admin mode wins)', 'DECISION_GATE_SELF_AUDIT_ACT_CAP_DISABLED', 'SELF_AUDIT_RECEIPT_RULE_MODE'],
    ownerLock: null,
    tier: 3,
    tierWhy: 'measured anti-predictive (AUROC 0.232) and act-capped; the deterministic receipt rule owns the site — never auto, kept recording for comparison',
    // backlog E13 (2026-09-28): v2 re-pose readout AUROC 0.516 on n=85, band 0 at τ 0.85, ~1,430 decisions / 7 d while the
    // receipt rule already skips deterministically — kept in shadow for ONE review window, then retired unless v2 predicts.
    lifecycle: {
      decision: 'shadow_review',
      reviewBy: '2026-10-12',
      bar: 'v2 AUROC ≥ 0.6 on ≥ 200 labels in the newest partition — else set the store mode off and add it to PURPOSE_RETIRED',
      // DECISION-GATE-LIFECYCLE (2026-10-20): enforced — past reviewBy with this unmet, the rollout automaton sets the store mode off.
      reviewBar: { minAuroc: 0.6, minLabels: 200 },
      why: 'the v2 re-pose is at chance (AUROC 0.516) while the deterministic receipt rule owns the site; the ask costs ~1.4k Jev calls a week for a comparison that has not paid off',
    },
  },
  delta_material: {
    decides: 'Is the observed probe change material enough for a delta-gate schedule to fire?',
    consumerSite: 'coding/schedule.service.ts — the delta gate (material)',
    actDoes: 'skips a delta-gate schedule fire whose probe change the gate is confident is immaterial',
    harnessLabel: 'the fired run took a recorded action — closes at the run finalize (the skipped branch has no label)',
    killSwitches: ['DECISION_GATE_MODE_DELTA_MATERIAL=off (env fallback; the admin mode wins)'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'the next probe re-evaluates the same delta; a skipped fire is a delay, not a loss',
  },
  guard_strike: {
    decides: 'Is this guard strike a true fabrication or a false conviction?',
    consumerSite: 'fleet/strike-adjudication.service.ts — the nightly adjudicator (verdict)',
    actDoes: 'writes a confident true/false-positive verdict on strikes past the nightly reasoning cap (never on unclear)',
    harnessLabel: 'the reasoning adjudicator’s own verdict on the same strike — closes nightly',
    killSwitches: ['DECISION_GATE_GUARD_STRIKE_NIGHTLY_CAP'],
    ownerLock: null,
    tier: 2,
    tierWhy: 'act WRITES a verdict a supervisor later reads as ground truth — a human reads the readout before the first flip',
  },
  checker_route: {
    decides: 'Where does the Level 2 checker sit for this question — the 75 s path or the full wait?',
    consumerSite: 'chat-agent/checker-route-gate.ts (depth / needs_live_web)',
    actDoes: 'a confident simple_lookup takes the 75 s path with the checker at reasoning_effort high; a confident contestable forces the full wait — the checker is never skipped',
    harnessLabel: 'what the turn did next to the isSimpleQuestion regex — closes at the turn finalize',
    killSwitches: ['DECISION_GATE_CHECKER_ROUTE_DISABLED', 'DECISION_GATE_CHECKER_ROUTE_HUMAN_RETIRE_LIFTED / DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED (restore the human-turn ask retired 2026-10-06)'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'the checker always runs; act only moves where it waits',
  },
  coding_memory_fold: {
    decides: 'Does this coding run carry anything worth folding into session / project / user memory or the run journal?',
    consumerSite: 'coding/coding-memory-fold-gate.ts — per fold leg (noul per leg)',
    actDoes: 'skips a post-run memory leg the gate is confident has nothing worth folding',
    harnessLabel: 'whether the leg’s extractor actually changed the stored doc (shadow runs it) — closes when the leg returns; τ 0.9 since backlog E14 (band precision 0.695 at 0.8) and the state carries doc sizes + last-fold ages',
    killSwitches: ['DECISION_GATE_DISABLED'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'a missed fold is picked up by the next run’s fold; nothing user-visible changes',
  },
  reflection_route: {
    decides: 'On a 3× tool-failure streak, which remedy: retry / different tool / deterministic framework / needs diagnosis?',
    consumerSite: 'coding/reflection.ts — the streak consult (route)',
    actDoes: 'consults the Double Checker only on needs_diagnosis; a confident retry / different-tool / deterministic verdict skips the 45 s consult',
    harnessLabel: 'the remedy the consult prescribed (or the next tool call) — closes at the next tool round',
    killSwitches: ['DECISION_GATE_DISABLED'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'a wrong route costs one more failed tool round before the consult runs anyway',
  },
  claim_evidenced: {
    decides: 'Is each deterministically mined action claim evidenced by the run’s receipts?',
    consumerSite: 'platform/claim-evidence-gate.ts ← platform/action-verifier (per-claim noul)',
    actDoes: 'keeps the mined claims and skips the utility-LLM claim extraction when every claim is confidently evidenced; the tier chain still judges every claim',
    harnessLabel: 'the verifier’s own verdict per claim — closes when the verifier finishes',
    killSwitches: ['DECISION_GATE_CLAIM_EVIDENCE_MAX_CLAIMS'],
    ownerLock: null,
    tier: 1,
    tierWhy: 'the tier chain still judges every claim; act only removes an extraction call',
  },
  firing_superseded: {
    decides: 'Did the run that held the lane already do this busy-parked recurring firing’s work?',
    consumerSite: 'coding/firing-superseded-gate.ts ← run-executor claim (disposition)',
    actDoes: 'drops (or folds into the next cadence) a busy-parked MACHINE recurring firing; never owner-authored or one-shot rows',
    harnessLabel: 'whether the fired run did real work — closes at the run finalize; asked for EVERY eligible parked row since backlog E09 (a sibling stash beside a delta / sweep stash) — the earlier call-site guard had starved it to zero rows',
    killSwitches: ['DECISION_GATE_DISABLED'],
    ownerLock: null,
    tier: 2,
    tierWhy: 'act DROPS a firing outright and the label set is young (first rows since backlog E09) — a human reads the readout before the first flip',
  },
  tool_intent: {
    decides: 'Which offered tool did the coding turn’s narration intend?',
    consumerSite: 'coding/tool-intent-gate.ts — shadow telemetry beside the derail guard’s regex (no act consumer)',
    actDoes: 'nothing — there is no act consumer; the purpose only cleans the derail-guard telemetry',
    harnessLabel: 'the regex detector’s verdict and the actual next tool call — closes at the next tool round',
    killSwitches: ['DECISION_GATE_TOOL_INTENT_RUN_CAP'],
    ownerLock: null,
    tier: 3,
    tierWhy: 'no act consumer exists — an act flip changes nothing and the ask volume was 70 % of all gate calls; it stays off / shadow by hand',
    // backlog E13 (2026-09-28): RETIRED — the best-calibrated purpose (AUROC 0.934, band 266/269) with nothing to consume it.
    lifecycle: {
      decision: 'retire',
      why: 'no act consumer exists or is planned (the derail guard reads its regex verdict directly); retired in PURPOSE_RETIRED — bare default off, act refused, the row and its history stay; lift with DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED=1 for a comparison run',
    },
  },
  wake_effort: {
    decides: 'How much deliberation does this machine wake need (score 0–2)?',
    consumerSite: 'platform/wake-effort.ts ← chat-agent machine wake (deliberation)',
    actDoes: 'runs a non-alarm machine wake the gate confidently scores 0–1 at reasoning_effort high instead of max',
    harnessLabel: 'harness-counted: 2 ⇔ ≥ 3 evidence-bearing calls or a mutating platform tool, 1 ⇔ 1–2, 0 ⇔ none — closes at the wake finalize',
    killSwitches: ['DECISION_GATE_DISABLED'],
    ownerLock: 'DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0 is the env hard disable of the act path (the owner lock itself was lifted; act flips through the store + READY admission)',
    tier: 2,
    tierWhy: 'act lowers a supervisor wake’s reasoning effort — the owner asked for a look at the first readout',
    // backlog E13 (2026-09-28): harness-counted labels 2:1,471 / 1:314 / 0:789 over 7 d, AUROC 0.541, band LB 0.453 (n=32) — an act
    // consumer exists (platform/wake-effort.ts) but the score is not predictive; it stays shadow. Next step: re-pose to the same
    // `will_act` noul supervisor_turn_noop asks (they answer the same question over the same facts) and compare on ONE partition.
    lifecycle: {
      decision: 'shadow',
      bar: 'stays shadow; candidate re-pose = the supervisor_turn_noop will_act noul over the target record (own questionsHash partition), judged on the same harness-counted label',
      why: 'AUROC 0.541 / band LB 0.453 on the harness-counted label — the deliberation score does not predict what the wake does; a wrong act lowers a supervisor wake’s effort',
    },
  },
  compute_policy: {
    decides: 'At send: depth (simple_lookup / ordinary / contestable / unclear) + stakes / needs_live_web / research_request → the DepthPlan',
    consumerSite: 'platform/compute-policy-gate.ts decideComputePlan ← the chat-agent send seam',
    actDoes: 'a confident low-stakes simple_lookup skips the Double Checker; confident stakes ∧ contestable holds the first answer ≤ STAKES_WAIT_MS for the check; human sends only',
    harnessLabel: 'the Dig-deeper tap (escalated) / the 30-min window closer (escalated:false) / the finalize facts — closes on the tap or the window; supervisor + machine turns get the window closer’s `machine` harness-proxy row (backlog DOI-21: pill updated or ≥ 3 lead tool calls ⇒ contestable, 1–2 ⇒ ordinary, none + short ⇒ simple_lookup; excludeFromFit until 30 rows exist)',
    killSwitches: ['COMPUTE_POLICY_DISABLED', 'COMPUTE_POLICY_MACHINE_DISABLED', 'COMPUTE_POLICY_MACHINE_ACT_ENABLED', 'DECISION_GATE_COMPUTE_POLICY_HUMAN_RETIRE_LIFTED / DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED (restore the human-turn ask retired 2026-10-06)'],
    ownerLock: null,
    tier: 2,
    tierWhy: 'act removes the checker from a human answer — user-facing correctness; a human reads the first readout',
  },
  drafts_agree: {
    decides: 'Do the lead final and the checker draft agree on every claim?',
    consumerSite: 'platform/compute-policy-gate.ts decideDraftsAgree ← the reconcile seam (agree)',
    actDoes: 'skips the reconcile pass and marks the answer Checked when the drafts confidently agree',
    harnessLabel: 'the reconcile’s revision_material verdict (did it change a material claim) — closes when the reconcile lands',
    killSwitches: ['COMPUTE_POLICY_DISABLED', 'DECISION_GATE_DRAFTS_AGREE_HUMAN_RETIRE_LIFTED / DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED (restore the human-turn ask retired 2026-10-06)'],
    ownerLock: null,
    tier: 2,
    tierWhy: 'act marks a human answer Checked without the reconcile — user-facing correctness',
  },
  revision_material: {
    decides: 'Did the reconcile change a claim / number / recommendation, or only wording?',
    consumerSite: 'platform/compute-policy-gate.ts decideRevisionMaterial — asked only when the deterministic diff says unchanged (material)',
    actDoes: 'marks a wording-only reconcile Checked with no rewrite',
    harnessLabel: 'thumbs / escalation after the revision (label human, primary) — closes on the next human signal; else the window closer’s harness row from the deterministic diff verdict (source diff ⇒ material, fallback ⇒ wording-only; backlog E10)',
    killSwitches: ['COMPUTE_POLICY_DISABLED'],
    ownerLock: null,
    tier: 2,
    tierWhy: 'act suppresses a rewrite the user would otherwise see — user-facing correctness',
  },
  supervisor_turn_noop: {
    decides: 'Will this supervisor turn (sweep firing / agent drain) take a recorded action, or close as a no-op note?',
    consumerSite: 'platform/supervisor-turn-noop.ts ← coding/schedule.service (sweep) + chat-agent drainChatQueue (drain) (will_act)',
    actDoes: 'skips a stock sweep firing / parks a queued agent batch the gate is confident closes as a no-op; pinned turns never skip; heartbeat floor; then replaces sweep_triage + drain_triage at those sites',
    harnessLabel: 'a MUTATING platform tool call in the transcript (never the model’s own claim); pinned turns are excludeFromFit; floor turns are control rows — closes at the turn finalize',
    killSwitches: ['DECISION_GATE_SUPERVISOR_TURN_NOOP_HEARTBEAT_TICKS', 'DECISION_GATE_SUPERVISOR_TURN_NOOP_DEFER_MIN'],
    ownerLock: null,
    tier: 2,
    tierWhy: 'control-gated (needs act-period floor turns) and it REPLACES two acting purposes at its sites — a human reads the readout before the switch-over',
  },
  session_topology: {
    decides: 'Where does this coding request belong — a dedicated new lane (spawn), the nearest lane that already holds the goal (reuse), the caller itself (merge), or nowhere (retire)?',
    consumerSite: 'platform/session-topology.ts evaluateSessionTopology ← platform-tools start_coding_session + the supervisor dispatch pre-check (placement)',
    actDoes: 'on the ambiguous R7 band a confident reuse / merge / retire (placement ≥ τ) replaces the fail-open spawn — the spawn result names the lane to send_chat_message instead; spawn is never acted on (it is the default) and the R1 / R4 refusals still need SESSION_TOPOLOGY_ENFORCE=1',
    harnessLabel: 'labelled +24 h by the session-topology-outcomes cron: spawn correct iff the new lane reached a mutating receipt ≤ 10 min and did not end one-run-no-PR; reuse / merge correct iff the target lane minted a mutating receipt in the window and no duplicate lane was spawned for the goal; retire correct iff the lane received no message for 72 h',
    killSwitches: ['SESSION_TOPOLOGY_DISABLED', 'SESSION_TOPOLOGY_OVERLAP_MIN'],
    ownerLock: null,
    tier: 2,
    tierWhy: 'act re-routes a spawn into another lane (reuse / merge) or retires one — a wrong placement is not undone by a delay, and the purpose carries the stricter 30-row / 0.95 band bar — a human reads the readout first',
  },
  turn_plan: {
    decides: 'Which lane should answer this human turn — quick / standard / checked / research — plus stakes, live-web, contested, multi-step and breadth (dynamic roster; docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md)?',
    consumerSite: 'platform/turn-plan.ts decideTurnPlan ← chat-agent/chat-agent.service.ts (fired before the context load; awaited only in act)',
    actDoes: 'a confident QUICK lane (p ≥ 0.8, stakes < 0.6 — < 0.75 on a pure live lookup (needs_live_web ≥ 0.8, multi_step < 0.5, contested < 0.2), TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING=0.6 restores the base rule —, contested < 0.5 — quick-lane-guards.ts) on a short, attachment-free, non-code human turn that is not a follow-up in a checked / research session runs the Quick answers seat (web search, thinking off, ≤ 4 steps, no checker) instead of the preset lead; every other lane and the would-be roster are recorded only; the canary allowlist (set-turn-plan-canary.js) acts for listed users while the purpose is shadow',
    harnessLabel: 'the Dig-deeper tap ≤ 30 min (needed the next lane up) or the 30-min window close (the lane held) — primary; re-ask ≤ 5 min and thumbs are secondary rows (chat-agent/turn-plan-labels.ts)',
    killSwitches: ['TURN_PLAN_DISABLED', 'QUICK_LANE_DISABLED', 'TURN_PLAN_LABELS_DISABLED', 'TURN_PLAN_CANARY_DISABLED'],
    ownerLock: null,
    tier: 2,
    tierWhy: 'act changes which model writes a human answer (a fast model with thinking off) — user-facing quality; Dig deeper recovers a miss, but a human reads the shadow readout before the flip',
  },
  // Task-aware model pick (2026-10-20): a PURE evidence key. The gate never acts on it (PURPOSE_ACT_CAPS refuses act); the
  // consumer that changes behaviour is the per-turn model pick, governed by its OWN store flag — stated here so
  // get_decision_gate_status and the framework-facts layer never tell a supervisor this purpose "changes nothing".
  task_kind: {
    decides: 'What JOB is this human turn — writing / code / analysis / lookup / advice / planning / explain (asked in both option orders, averaged)?',
    consumerSite: 'platform/task-kind.ts decideTaskKind ← platform/turn-plan.ts decideTurnPlan (fired in the same tick as the turn_plan ask; read by the per-turn model pick) (kind); ← platform/workspace-attach-gate.ts shouldAttachWorkspace (a CODE_INTENT keyword send into a satellite-less code-capable chat, over the turn plan\'s own state) (kind)',
    actDoes: "no gate act consumer — the answer keys model-pick quality evidence (model, kind) before (model, lane); whether a kind-aware pick leads is the modelPickKind store mode on ['instance','turn-plan']/'config' (off / shadow / act); fail-open = (model, lane) evidence. Second consumer (2026-10-20): the workspace attach gate keeps a confidently (p ≥ 0.8) non-code keyword send a chat instead of converting it into a coding session — its own workspaceAttachGate store mode on the same row (off / shadow / act; absent = shadow); fail-open = the keyword attach. TASK_KIND_DISABLED=1 silences both (the gate then keeps the keyword behaviour)",
    harnessLabel: 'no outcome label writer yet — the readout is the model bench’s title-kind vs plan-kind agreement (the bench question’s corpus group fixes its kind on the title token; the turn’s metadata.depth.turnPlan.taskKind is the gate’s answer; counts only, model-bench-ingest.js), never a fit label',
    killSwitches: ['TASK_KIND_DISABLED'],
    ownerLock: null,
    tier: 3,
    tierWhy: 'no gate act consumer — the answer keys model-pick evidence and whether a kind-aware pick leads is the modelPickKind store mode, so a gate act flip is meaningless (act-capped in code) and never automatic',
    lifecycle: {
      decision: 'shadow',
      bar: 'next step: an outcome label writer (e.g. the nightly live-chat audit judging the kind on sampled turns) so readiness can measure the kind’s accuracy; until then the bench title-kind agreement is the only readout',
      why: 'the bare default must stay shadow so the ask runs and the kind reaches metadata.depth.turnPlan for the pick and the bench — never retired, never act',
    },
  },
};

export interface DecisionRegistryRow extends DecisionRoleSpec {
  purpose: StorablePurpose;
  label: string;
  description: string;
  /** From ACT_POLICIES. */
  question: string;
  questionShape: string;
  defaultThreshold: number;
  consumer: string;
  /** From readinessBarsFor + PURPOSE_CONTROL_GATED. backlog E11: `minLabels` is the BASE floor; the effective floor scales to the purpose's own label rate (`volumeRule`, never below `minLabelsFloor`); `volumeScaled` is always true. */
  bars: { minLabels: number; minLabelsFloor: number; volumeScaled: boolean; volumeScaleDays: number; volumeRule: string; minDays: number; minActBandN: number; minActBandPrecision: number; minAuroc: number; minCoverageAt5: number; controlGated: boolean };
  /** From PURPOSE_ACT_CAPS (null = none). `active` = the cap holds on THIS process (not lifted by its env). */
  actCap: (Omit<PurposeActCap, 'liftEnv'> & { liftEnv: string; active: boolean }) | null;
  /** backlog E13: from PURPOSE_RETIRED (null = not retired). `active` = the retirement holds on THIS process (not lifted by its env). */
  retired: (PurposeRetirement & { liftEnv: string; active: boolean }) | null;
  /** roster 2026-10-06 B-2: from PURPOSE_RETIRED_ON_HUMAN_TURNS (null = asked on every turn). `active` = human-turn asks are skipped on THIS process
   *  (neither DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED nor the purpose's lift env is set); machine turns keep asking. */
  retiredOnHumanTurns: (HumanTurnRetirement & { liftEnv: string; globalLiftEnv: string; active: boolean }) | null;
}

const KIND_LABEL: Record<string, string> = {
  noul_low: 'noul — acts on the LOW side (≤ 1−τ)',
  noul_high: 'noul — acts on the HIGH side (≥ τ)',
  choice_high: 'choice — acts when the top option’s confidence ≥ τ',
  score_low: 'score — acts when the rounded score is low and confidence ≥ τ',
};

/** One registry row with the runtime facts joined in. Pure given env. */
export function decisionRegistryRow(purpose: StorablePurpose): DecisionRegistryRow {
  const spec = DECISION_ROLE_REGISTRY[purpose];
  const meta = DECISION_PURPOSES.find(p => p.purpose === purpose);
  const policy = ACT_POLICIES[purpose];
  const bars = readinessBarsFor(purpose);
  const staticCap = (PURPOSE_ACT_CAPS as Record<string, Omit<PurposeActCap, 'liftEnv'> | undefined>)[purpose] ?? null;
  const staticRetired = (PURPOSE_RETIRED as Record<string, PurposeRetirement | undefined>)[purpose] ?? null;
  const staticHumanRetired = (PURPOSE_RETIRED_ON_HUMAN_TURNS as Record<string, HumanTurnRetirement | undefined>)[purpose] ?? null;
  return {
    purpose,
    label: meta?.label ?? purpose,
    description: meta?.description ?? '',
    question: policy?.question ?? '?',
    questionShape: policy ? (KIND_LABEL[policy.kind] ?? policy.kind) : 'unknown',
    defaultThreshold: policy?.defaultThreshold ?? NaN,
    consumer: policy?.consumer ?? spec.consumerSite,
    ...spec,
    bars: {
      minLabels: bars.minLabels, minLabelsFloor: Math.min(bars.minLabels, READINESS_MIN_LABELS_FLOOR), volumeScaled: true, volumeScaleDays: READINESS_VOLUME_SCALE_DAYS,
      volumeRule: READINESS_VOLUME_RULE,
      minDays: bars.minDays, minActBandN: bars.minActBandN, minActBandPrecision: bars.minActBandPrecision,
      minAuroc: bars.minAuroc, minCoverageAt5: bars.minCoverageAt5, controlGated: PURPOSE_CONTROL_GATED.has(purpose),
    },
    // audit 2026-10-08 W6-2: a dynamic cap (the material wake gate supersedes the Jev wake purposes) shows here too.
    actCap: staticCap
      ? { ...staticCap, liftEnv: actCapLiftEnv(purpose), active: purposeActCap(purpose) !== null }
      : (() => { const dyn = purposeActCap(purpose); return dyn ? { since: dyn.since, why: dyn.why, liftEnv: dyn.liftEnv, active: true } : null; })(),
    retired: staticRetired ? { ...staticRetired, liftEnv: retireLiftEnv(purpose), active: purposeRetired(purpose) } : null,
    retiredOnHumanTurns: staticHumanRetired
      ? { ...staticHumanRetired, liftEnv: humanRetireLiftEnv(purpose), globalLiftEnv: 'DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED', active: purposeRetiredOnHumanTurns(purpose) }
      : null,
  };
}

/** Every registry row, in DECISION_PURPOSES order (the admin table’s default order). */
export function listDecisionRegistry(): DecisionRegistryRow[] {
  return DECISION_PURPOSES.map(p => decisionRegistryRow(p.purpose));
}

export const REGISTRY_PURPOSES: readonly StorablePurpose[] = Object.keys(DECISION_ROLE_REGISTRY) as StorablePurpose[];

export function rolloutTierFor(purpose: string): RolloutTier | null {
  const spec = (DECISION_ROLE_REGISTRY as Record<string, DecisionRoleSpec | undefined>)[purpose];
  return spec ? spec.tier : null;
}

/** The tier rule, stated once for prompts and docs (no dates, no ids). */
// Tier 2 joined the automatic flips on the owner's standing authorization (AGENTS.md, the 2026-10-04 durable act-band
// bullet); DECISION_GATE_AUTO_ROLLOUT_MAX_TIER=1 restores tier-2 owner questions. Prompt-facing: no dates / ids here.
export const ROLLOUT_TIER_RULE =
  'tier 1 and tier 2 purposes flip to act automatically on a fresh measured READY stamp (an owner-locked purpose is asked as one owner question instead); tier 3 are never flipped automatically';
