/**
 * Decision gate — per-purpose MODE (off | shadow | act) as a STORE-BACKED,
 * instance-wide setting (WI-S, 2026-09-25).
 *
 * WHY: decisionMode() used to read process.env only. A flip therefore meant
 * staging DECISION_GATE_MODE_<PURPOSE> into the box-local env-override file
 * on EVERY box that runs the gated code path — the web backends on A and B
 * (hooks fire from setImmediate on emit) AND the sweeper worker on C — and
 * the ec2-ops `env_override` input stages box A only. A partial flip shows up
 * only as mixed act/shadow rows in telemetry. Model roles solved the same
 * problem for seats: ONE row in the context store, a 30 s in-process cache,
 * fail-open to the previous value. This module does the same for the mode.
 *
 * PRECEDENCE (decisionMode() in decision-gate.ts):
 *   DECISION_GATE_DISABLED=1            → 'off' (kill switch, everything)
 *   purpose 'probe'                     → 'act'
 *   store row modes[purpose]            → that mode        (this module)
 *   DECISION_GATE_MODE_<PURPOSE>        → env per purpose  (envDecisionMode)
 *   DECISION_GATE_DEFAULT_MODE          → env default
 *   bare default                        → 'shadow' ('off' under NODE_ENV=test)
 *
 * SYNC READ, ASYNC REFRESH: decisionMode() is synchronous and called from a
 * dozen request-path sites, so the store value is served from an in-process
 * cache that a background read refreshes every 30 s (deduped, fail-open —
 * a DB blip keeps the last known row). The FIRST call in a fresh process
 * answers from env while the first read is in flight; within one round trip
 * every later call sees the store. Under NODE_ENV='test' no background read
 * is ever scheduled (hermeticity — the same contract as the bare 'off'
 * default): suites that exercise the store call refreshDecisionModes()
 * themselves with a mocked context-store.
 *
 * Storage: ['instance','decision-gate'] / 'modes' → { modes: { <purpose>: 'off'|'shadow'|'act' } }.
 */

import logger from '../../../utils/logger';
import type { DecisionMode, DecisionPurpose } from './decision-gate';
import { wilsonInterval } from './decision-gate-math';
import { materialGateSupersedes } from './wake-material-rule';

/** Every gated purpose an admin may set a mode for ('probe' is always act). */
export const DECISION_PURPOSES: ReadonlyArray<{ purpose: Exclude<DecisionPurpose, 'probe'>; label: string; description: string }> = [
  { purpose: 'wake_triage', label: 'Supervisor wake triage', description: 'act = park a non-alarm supervisor wake the gate is confident needs no turn now (re-delivered after the defer window)' },
  { purpose: 'delta_material', label: 'Schedule delta materiality', description: 'act = skip a delta-gate schedule fire whose probe change the gate is confident is immaterial' },
  { purpose: 'auto_route', label: 'Auto patience router', description: "act = mode='auto' takes Level 1/2/3 from the gate instead of the regex heuristic; also asked by the explicit-level label window (a picked level is the label; patience plan 1a)" },
  { purpose: 'imessage_send', label: 'iMessage send intent', description: 'act = skip the send-intent utility call when the gate is confident the message is not a send' },
  { purpose: 'browser_driver', label: 'Browser driver choice', description: 'act = cloud / Mac / computer from the gate instead of a reasoning call' },
  { purpose: 'memory_extract', label: 'Memory-extraction gate', description: 'act = skip the memory extractors when the gate is confident there is nothing durable to extract' },
  { purpose: 'self_audit', label: 'Coding self-audit gate', description: 'act = skip the coding self-audit round when the gate is confident the final is evidenced' },
  // N1 (2026-09-25): the nightly strike adjudicator's verdicts are the labels — the only purpose with a labelled corpus on day one.
  { purpose: 'guard_strike', label: 'Guard-strike adjudication', description: 'act = the nightly adjudicator writes a confident true/false-positive verdict on strikes past the 30/night reasoning cap (never on unclear); shadow = every adjudicated strike is judged next to the real verdict' },
  // N2 (2026-09-25): the supervisor sweep pre-triage over a CODE-COMPUTED delta since the previous sweep.
  { purpose: 'sweep_triage', label: 'Supervisor sweep pre-triage', description: 'act = skip a scheduled fleet/project sweep the gate is confident is a no-op (nothing moved since the last sweep), bounded by a heartbeat floor; shadow = records against what the fired sweep actually did' },
  // N4 (2026-09-25): the Level 2 checker-site router — its own purpose so its depth / needs_live_web rows never share auto_route's readiness stamp.
  { purpose: 'checker_route', label: 'Level 2 checker placement', description: "act = a confident simple_lookup takes the 75 s checker path with the Double Checker at reasoning_effort 'high', a confident contestable forces the full wait (the checker is never skipped); shadow = judged next to the isSimpleQuestion regex, labelled from what the turn did" },
  // N3 (2026-09-25): one prefill of per-leg nouls before the post-run coding-memory fold (session / project / user) and the run-journal distillation; label = whether the leg actually changed its memory doc.
  { purpose: 'coding_memory_fold', label: 'Coding-memory fold gate', description: 'act = skip a post-run coding-memory leg (session summary / project fold / user prefs / run journal) the gate is confident has nothing worth folding; shadow = each leg is judged next to whether its extractor actually changed the stored doc' },
  // N8 (2026-09-25): a typed remedy choice over the streak evidence, concurrent with the 45 s Double-Checker consult; label = the consult's classified remedy (or the next tool call).
  { purpose: 'reflection_route', label: 'Reflection route pre-choice', description: 'act = on a 3× tool-failure streak, consult the Double Checker only when the gate says needs_diagnosis (a confident retry / different-tool / deterministic verdict skips the 45 s consult); shadow = the choice is judged next to the remedy the consult prescribed' },
  // N5 (2026-09-25): per-claim evidence noul over deterministically mined first-person action claims + the run's receipts, concurrent with the LLM extractor.
  { purpose: 'claim_evidenced', label: 'Action-verifier claim evidence', description: 'act = the pre-delivery verifier keeps the deterministically mined claims and skips the utility-LLM claim extraction when the gate is confident every mined claim is evidenced by the run\'s receipts (the tier chain still judges every claim); shadow = each mined claim is judged next to the verifier\'s own verdict' },
  // N6 (2026-09-25): ack_only / coalesce / act_now over a queued agent-message batch before the detached drain turn.
  { purpose: 'drain_triage', label: 'Agent-message drain triage', description: 'act = park a confidently quiet batch of queued agent messages (ack_only / coalesce) for one bounded defer window instead of starting a full detached turn — never when a user row waits behind it; shadow = records against what the drained turn actually did' },
  { purpose: 'firing_superseded', label: 'Superseded-firing gate', description: 'act = drop (or fold into the next cadence) a busy-parked MACHINE recurring firing the gate is confident the run that held the lane already did the work of; never owner-authored or one-shot rows; shadow = records against whether the fired run did real work' }, // N7 (2026-09-25)
  { purpose: 'tool_intent', label: 'Tool-intent attribution', description: 'shadow only (no act consumer): which offered tool the turn\'s narration intended, judged next to the regex detector\'s verdict and the actual next tool call — cleaner observe telemetry for the derail guard' }, // N10 (2026-09-25)
  { purpose: 'wake_effort', label: 'Machine-wake reasoning effort', description: "act = a non-alarm machine wake the gate confidently scores as needing little deliberation (0–1 of 2) runs its built-in glm/deepseek seat at reasoning_effort 'high' instead of 'max' (owner lock lifted 2026-09-26 — act flips here like every purpose; DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0 is the env hard disable); shadow = the score is recorded against what the wake actually did (no-op / note / action) with its run length and cost" },
  // Compute policy (2026-09-26, docs/DEPTH_UX_SOTA_2026-09-26.md §4): the outcome-driven depth policy behind every human send — three purposes, all SHADOW until the readiness ruler stamps READY.
  { purpose: 'compute_policy', label: 'Compute policy', description: "act = at send, a confident simple_lookup with low stakes skips the Double Checker; confident high stakes on a contestable question holds the first answer ≤ STAKES_WAIT_MS (90 s) for the check at reasoning_effort 'max'. A confident research request only MARKS the plan — no harness path starts a background council (audit 2026-09-26; RESEARCH_REQUEST_AUTOSTART_ENABLED=1 opts the marker back in), the user keeps the Dig-deeper research chip. HUMAN sends only: a machine / supervisor turn's act plan is downgraded to shadow until that segment has its own readiness (COMPUTE_POLICY_MACHINE_ACT_ENABLED=1 opts in). shadow = the preset plan runs and the row is labelled by the Dig-deeper tap (escalated) / the 30-min window closer (escalated:false) / the finalize facts." },
  { purpose: 'drafts_agree', label: 'Drafts agree', description: 'act = when the gate is confident the lead final and the checker draft agree, the reconcile pass is skipped and the answer is marked Checked; shadow = the reconcile runs as today and the row is labelled by whether it changed a material claim' },
  { purpose: 'revision_material', label: 'Revision material', description: 'act = a reconcile the deterministic diff calls unchanged and the gate is confident is wording-only is marked Checked with no rewrite; shadow / off = every revision rewrites as today; labelled by thumbs / escalation after the revision' },
  // agent-decisions 2026-09-27 (area supervisor): ONE noul over the TARGET's own record (7-day no-op / action rates, consecutive no-ops, last action, last three notes, board counts, pending inputs) before a supervisor sweep firing or an agent-message drain; hook wakes keep wake_triage (which gained the same facts as its v3 field block).
  { purpose: 'supervisor_turn_noop', label: 'Supervisor turn pre-triage (sweep + drain)', description: "act = skip a stock sweep firing / park a queued agent batch the gate is confident will close as a no-op note (will_act ≤ 0.15), never when the deterministic new-input rule, an alarm / owner-card / child-result row, a cap bypass or a waiting user row pins the turn (a pinned turn's row is excludeFromFit, so the band holds only turns the rule could skip), bounded by a heartbeat floor (in act the band's labelled rows are the floor turns, stamped control:true — readiness needs 30 band rows at ≥ 0.95 and, once floor turns exist, 30 of them with a quiet-rate LB ≥ 0.95; auto-demote bar 0.95); the label is a mutating platform tool call in the transcript, never the model's own ACTIONS TAKEN claim; once act it replaces sweep_triage and drain_triage at those sites; shadow = the stash rides the turn beside the older purpose's (asked concurrently) and is labelled from what the turn did" },
  // Session titles + topology (2026-09-27): ONE choice over the project's goal→lane index on the AMBIGUOUS band of the deterministic placement rules (R7) before a start_coding_session / on topology_check.
  { purpose: 'session_topology', label: 'Session topology (spawn / reuse / merge / retire)', description: "act = on the ambiguous R7 band (goal-word overlap between half the reuse bar and the bar) a confident reuse / merge / retire (placement ≥ 0.85) replaces the fail-open spawn: the spawn result names the lane to send_chat_message instead (R1 / R4 refusals need SESSION_TOPOLOGY_ENFORCE=1 regardless of the gate); shadow = the deterministic rule's verdict stands (spawn), the row is labelled +24 h by the worker cron session-topology-outcomes: spawn correct iff the new lane reached a mutating receipt ≤ 10 min and did not end one-run-no-PR; reuse / merge correct iff the target lane minted a mutating receipt within the window and no duplicate lane was spawned for the goal; retire correct iff the lane received no message for 72 h" },
  // Task-aware model pick (2026-10-20; owner "choosing the best models for the job"): the JOB a human turn is, asked as its
  // OWN purpose beside turn_plan (never inside that batch — it is in act and its readiness is partitioned by questionsHash).
  { purpose: 'task_kind', label: 'Task kind', description: "no gate act consumer (act is refused — capped in code): ONE choice over writing / code / analysis / lookup / advice / planning / explain, asked in both option orders and averaged (platform/task-kind.ts). A calibrated answer whose kind reaches p ≥ 0.5 keys the per-turn model pick's QUALITY evidence by (model, kind) before (model, lane); whether that kind-aware pick leads the turn or is only recorded beside today's pick is the modelPickKind store mode on ['instance','turn-plan']/'config' (off / shadow / act; absent = shadow). Also asked by the workspace attach gate (platform/workspace-attach-gate.ts): a confident non-code verdict keeps a CODE_INTENT keyword send a chat — its own workspaceAttachGate store mode on the same row. Missing, uncalibrated or below the bar ⇒ the (model, lane) evidence as today. shadow = the kind rides metadata.depth.turnPlan.taskKind; no outcome label writer yet (the bench's title-kind vs plan-kind agreement is the readout)." },
  // Dynamic roster phase 2 (2026-10-03; owner chose option B — docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md).
  { purpose: 'turn_plan', label: 'Turn plan (dynamic roster)', description: "act = a confident QUICK lane (p ≥ 0.8; stakes < 0.6 — < 0.75 on a pure live lookup —, contested < 0.5) on a short, attachment-free, non-code human turn that is not a follow-up in a checked / research session runs the Quick answers seat (web search, thinking off, ≤ 4 steps, no checker) instead of the preset's lead; every other lane (standard / checked / research) and the would-be roster are recorded only. shadow = the plan rides metadata.depth.turnPlan and is labelled by the Dig-deeper tap / re-ask / thumbs / the 30-min window close (owner 2026-10-03: no live exploration)." },
];

const PURPOSE_SET = new Set<string>(DECISION_PURPOSES.map(p => p.purpose));
export function isStorablePurpose(x: unknown): x is Exclude<DecisionPurpose, 'probe'> {
  return typeof x === 'string' && PURPOSE_SET.has(x);
}

export function parseDecisionMode(v: unknown): DecisionMode | null {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'off' || s === 'shadow' || s === 'act' ? s : null;
}

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};


/**
 * The ENV-only mode for a purpose: DECISION_GATE_MODE_<PURPOSE>, else
 * DECISION_GATE_DEFAULT_MODE, else 'shadow' — EXCEPT under NODE_ENV='test',
 * where the bare default is 'off' (hermeticity, ticket 0aeb8844/e580b601
 * verify-blocker class 2026-09-24: coding containers carry real provider
 * keys, so a 'shadow' default made suites fire LIVE decide() calls). An
 * EXPLICIT env mode always wins over the test default.
 */
export function envDecisionMode(purpose: DecisionPurpose): { mode: DecisionMode; source: 'env_purpose' | 'env_default' | 'default' | 'retired_default' } {
  const perPurpose = parseDecisionMode(process.env[`DECISION_GATE_MODE_${purpose.toUpperCase()}`]);
  if (perPurpose) return { mode: perPurpose, source: 'env_purpose' };
  // backlog E13 (2026-09-28): a RETIRED purpose (PURPOSE_RETIRED) is 'off' when nothing names a mode for it —
  // a cleared store row or an unset env never revives an ask nothing consumes. An explicit per-purpose env
  // (above), a store row, or DECISION_GATE_DEFAULT_MODE still wins (the operator said so).
  const def = parseDecisionMode(process.env.DECISION_GATE_DEFAULT_MODE);
  if (def) return { mode: def, source: 'env_default' };
  if (purposeRetired(purpose)) return { mode: 'off', source: 'retired_default' };
  return { mode: process.env.NODE_ENV === 'test' ? 'off' : 'shadow', source: 'default' };
}

// ── backlog E13 (2026-09-28): REGISTRY RETIREMENT ────────────────────────────
// A purpose named here has no act consumer and no planned one; the registry row
// (decision-gate-registry `lifecycle`) records the decision. Effects: its bare
// default mode is 'off' (envDecisionMode, source 'retired_default' — an
// explicit env / store / DECISION_GATE_DEFAULT_MODE still governs, so the
// purpose can be turned back on by hand for a comparison), and it is act-capped
// (PURPOSE_ACT_CAPS below) so the admin PUT refuses 'act'. The purpose stays in
// DECISION_PURPOSES / ACT_POLICIES / the registry so stored rows validate and
// the readiness readout keeps its history. Lift per purpose with
// DECISION_GATE_<PURPOSE>_RETIRE_LIFTED=1 (the bare default is 'shadow' again).
export interface PurposeRetirement {
  since: string;
  why: string;
}
export const PURPOSE_RETIRED: Partial<Record<Exclude<DecisionPurpose, 'probe'>, PurposeRetirement>> = {
  tool_intent: {
    since: '2026-09-28',
    why: 'no act consumer exists or is planned (the derail guard reads the regex verdict directly); it was 70 % of all gate calls — off in the store since 2026-09-26 13:02Z, retired in the registry (backlog E13)',
  },
};

/** The env that lifts a purpose's registry retirement on this process. */
export function retireLiftEnv(purpose: string): string {
  return `DECISION_GATE_${String(purpose).toUpperCase()}_RETIRE_LIFTED`;
}

/** Is the purpose retired on THIS process (registry row present and not lifted by its env)? */
export function purposeRetired(purpose: DecisionPurpose): boolean {
  const row = (PURPOSE_RETIRED as Record<string, PurposeRetirement | undefined>)[purpose];
  if (!row) return false;
  return !onFlag(process.env[retireLiftEnv(purpose)]);
}

// ── roster 2026-10-06 B-2: RETIRED ON HUMAN TURNS ────────────────────────────
// The four preset-era purposes that judged a HUMAN send near chance on the
// 2026-10-06 readiness readout (AUROC 0.46–0.55; ~4,000 asks a week, every one
// shadow — nothing they answered ever changed a human run): auto_route,
// compute_policy, checker_route, drafts_agree. On a HUMAN turn their ask is not
// made at all (the ask site returns what OFF returns: the regex level / the
// preset plan / no checker placement / the reconcile as today) and one
// `decision_ask_retired` loop_metrics row records the skip
// (platform/human-turn-retirement.ts). MACHINE turns keep asking (compute_policy
// machine wakes feed their own never-READY partition and the window closer's
// harness-proxy labels). The purposes stay in DECISION_PURPOSES / ACT_POLICIES /
// the registry (its row carries `retiredOnHumanTurns`) so stored rows validate
// and the readout keeps its history. Kill switches: DECISION_GATE_HUMAN_TURN_
// RETIRE_DISABLED=1 restores every human-turn ask; DECISION_GATE_<PURPOSE>_
// HUMAN_RETIRE_LIFTED=1 restores one purpose.
export interface HumanTurnRetirement {
  since: string;
  why: string;
  /** The ask site(s) the retirement applies at (file:function). */
  sites: string;
}
export const PURPOSE_RETIRED_ON_HUMAN_TURNS: Partial<Record<Exclude<DecisionPurpose, 'probe'>, HumanTurnRetirement>> = {
  auto_route: {
    since: '2026-10-06',
    why: 'AUROC 0.459, act-band precision 0.41 on the 2026-10-06 readout — the turn plan classifies the lane; the regex router stays the level fail-open',
    sites: 'platform/auto-router-gate.ts routeMessageAuto (segment ≠ machine) + shadowAutoRouteAgainst (the label window)',
  },
  compute_policy: {
    since: '2026-10-06',
    why: 'AUROC 0.511, act-band precision 0.43 on the 2026-10-06 readout — the preset plan already ran every human turn (shadow); machine-wake asks continue',
    sites: 'platform/compute-policy-gate.ts decideComputePlan (machine === false)',
  },
  checker_route: {
    since: '2026-10-06',
    why: 'AUROC 0.553 on the 2026-10-06 readout — the isSimpleQuestion regex placed the checker on every human turn (shadow)',
    sites: 'chat-agent/chat-agent.service.ts checker-site router (human turns)',
  },
  drafts_agree: {
    since: '2026-10-06',
    why: 'near chance on the 2026-10-06 readout and shadow — the reconcile ran on every human turn regardless; revision_material (deterministic diff first) still judges the reconcile',
    sites: 'platform/compute-policy-gate.ts decideDraftsAgree (machine === false; the inline + late reconcile seams)',
  },
};

/** DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED=1 — every human-turn retirement is lifted on this process (the asks run as before). */
export function humanTurnRetireDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED);
}
/** The env that lifts ONE purpose's human-turn retirement on this process. */
export function humanRetireLiftEnv(purpose: string): string {
  return `DECISION_GATE_${String(purpose).toUpperCase()}_HUMAN_RETIRE_LIFTED`;
}
/** Is the purpose's ask retired on HUMAN turns on THIS process (row present, neither the global switch nor its lift env set)? */
export function purposeRetiredOnHumanTurns(purpose: DecisionPurpose, env: NodeJS.ProcessEnv = process.env): boolean {
  const row = (PURPOSE_RETIRED_ON_HUMAN_TURNS as Record<string, HumanTurnRetirement | undefined>)[purpose];
  if (!row) return false;
  if (humanTurnRetireDisabled(env)) return false;
  return !onFlag(env[humanRetireLiftEnv(purpose)]);
}

// ── Registry ACT CAP (agent-decisions prerequisite 3, 2026-09-27) ────────────
// A purpose named here can never RUN in act on this build: a stored / env
// 'act' resolves to 'shadow' (decisionModeWithSource in decision-gate.ts and
// the admin view both report source 'registry_cap'), and the admin PUT
// refuses 'act' for it with the reason below. The store row is NOT rewritten
// by the cap (the auto-demote path owns store writes) — flip it to shadow as
// well so the admin panel and every box agree (scratchpad
// `set-mode.js FLIP=<purpose> MODE=shadow`). Lift per purpose with
// DECISION_GATE_<PURPOSE>_ACT_CAP_DISABLED=1 (e.g.
// DECISION_GATE_DRAIN_TRIAGE_ACT_CAP_DISABLED=1) — then the normal
// store → env precedence and READY admission govern again.
//
// drain_triage (2026-09-27): in act since 2026-09-26 02:05Z, 46 act-period
// labels agreed 43 % (20/46; act_now → ack_only 22 = 48 % over-acting; the
// judge's readout + prod-waste §3). The judge's re-pose ("does any queued
// message await a reply?" with a code-derived label from the resulting
// turn) is NOT deterministic on today's rows — a reply to the sender is not
// observable from tool NAMES (transcript parts carry no target chatId), and
// the state already carries the regex flag `sender_awaits_reply`, so the
// re-posed noul would read its own feature back. Demoted to shadow here
// instead ("never leave a 43 % purpose acting"); it keeps recording so the
// `supervisor_turn_noop` replacement (design §2.1) can be judged against it.
export interface PurposeActCap {
  /** ISO date the cap was placed. */
  since: string;
  /** Why (shown in the admin view + the PUT refusal). */
  why: string;
  /** The env that lifts this cap on a process. */
  liftEnv: string;
}

export const PURPOSE_ACT_CAPS: Partial<Record<Exclude<DecisionPurpose, 'probe'>, Omit<PurposeActCap, 'liftEnv'>>> = {
  drain_triage: {
    since: '2026-09-27',
    why: 'act agreement 43 % (20/46 act-period labels, 48 % act_now→ack_only over-acting; agent-decisions judge 2026-09-27) — demoted in code until supervisor_turn_noop replaces it at the drain site',
  },
  // tt-rd audit 2026-09-27 (self-audit-churn-2): the Jev self_audit purpose is
  // provably anti-predictive — readiness 12:19Z AUROC 0.232, accuracy 0.034,
  // ECE 0.84, act band n:0; "Jev never answers any_reopen < 0.2 (says 0.7 when
  // 2 % reopen)". The deterministic RECEIPT RULE in coding/self-audit-
  // receipt-rule.ts (54 % skippable at 2.4 % reopen in the backtest)
  // supersedes it at the agent.ts site; the purpose keeps recording in shadow
  // for comparison.
  self_audit: {
    since: '2026-09-27',
    why: 'Jev AUROC 0.232 / accuracy 0.034 on 288+416 labelled rows (readiness 2026-09-27 12:19Z) — retired as an act consumer; the deterministic receipt rule (SELF_AUDIT_RECEIPT_RULE_MODE) supersedes it',
  },
  // backlog E13 (2026-09-28): retired in the registry (PURPOSE_RETIRED) — no act consumer exists; an 'act' PUT is meaningless and refused.
  tool_intent: {
    since: '2026-09-28',
    why: 'retired (backlog E13): no act consumer exists — the derail guard reads its regex verdict directly; the purpose stays for history and its bare default mode is off',
  },
  // task-aware pick (2026-10-20): a PURE evidence key — its answer chooses which quality bucket the model pick reads, and
  // whether that pick leads is the consumer's own store flag (turn-plan config modelPickKind), never the gate mode. Capped
  // so the admin PUT refuses 'act' and the rollout automaton skips it ("act-capped in code" — no tier-3 owner-question
  // noise). NOT retired: the bare default stays 'shadow' so the ask runs in prod and the kind reaches metadata.
  task_kind: {
    since: '2026-10-20',
    why: 'a pure evidence key (no gate act consumer): the kind picks the model-pick quality bucket; whether a kind-aware pick leads is the modelPickKind store mode on the turn-plan config, never this gate mode',
  },
};

/** The env that lifts a purpose's registry act cap on this process. */
export function actCapLiftEnv(purpose: string): string {
  return `DECISION_GATE_${String(purpose).toUpperCase()}_ACT_CAP_DISABLED`;
}

/**
 * audit 2026-10-08 W6-2: while the deterministic material-change gate ACTS
 * (platform/wake-material-rule.ts — the ONE wake gate for supervisor hook /
 * sweep / drain wakes), the four Jev "should this supervisor take a turn"
 * purposes keep asking in SHADOW beside it for comparison and never act
 * (agreement rows: supervisor_material_gate_agreement). Dynamic — lifted by
 * SUPERVISOR_MATERIAL_GATE_DISABLED=1 or SUPERVISOR_MATERIAL_GATE_SHADOW=1
 * (the gate no longer acts ⇒ the stored modes govern again).
 */
export const MATERIAL_GATE_ACT_CAP: Omit<PurposeActCap, 'liftEnv'> = {
  since: '2026-10-08',
  why: 'superseded by the deterministic material-change wake gate (audit 2026-10-08 W6) — asks in shadow beside it for comparison',
};

/** The purpose's registry act cap, or null (none, or lifted by its env on this process). */
export function purposeActCap(purpose: DecisionPurpose): PurposeActCap | null {
  if (materialGateSupersedes(purpose)) return { ...MATERIAL_GATE_ACT_CAP, liftEnv: 'SUPERVISOR_MATERIAL_GATE_DISABLED' };
  const cap = (PURPOSE_ACT_CAPS as Record<string, Omit<PurposeActCap, 'liftEnv'> | undefined>)[purpose];
  if (!cap) return null;
  const liftEnv = actCapLiftEnv(purpose);
  if (onFlag(process.env[liftEnv])) return null;
  return { ...cap, liftEnv };
}

/** Apply the registry act cap to a resolved mode: a capped purpose's 'act' runs as 'shadow' (source 'registry_cap'). Pure given env. */
export function capDecisionMode<S extends string>(purpose: DecisionPurpose, resolved: { mode: DecisionMode; source: S }): { mode: DecisionMode; source: S | 'registry_cap' } {
  if (resolved.mode !== 'act') return resolved;
  return purposeActCap(purpose) ? { mode: 'shadow', source: 'registry_cap' } : resolved;
}

// ── Store-backed modes (30 s cache, sync read, async refresh) ───────────────

const STORE_NS = ['instance', 'decision-gate'];
const STORE_KEY = 'modes';
const CACHE_TTL_MS = 30_000;

export type StoredDecisionModes = Partial<Record<Exclude<DecisionPurpose, 'probe'>, DecisionMode>>;
interface StoredRow { modes?: Record<string, string> }

let cache: { modes: StoredDecisionModes; expiresAt: number } | null = null;
let inFlight: Promise<StoredDecisionModes> | null = null;

/** Test hook + admin mutation invalidation. */
export function clearDecisionModeCache(): void { cache = null; inFlight = null; }

/** Pure: the stored row → known purposes with valid modes only. */
export function normalizeStoredDecisionModes(stored: StoredRow | null | undefined): StoredDecisionModes {
  const out: StoredDecisionModes = {};
  for (const [k, v] of Object.entries(stored?.modes ?? {})) {
    const mode = parseDecisionMode(v);
    if (mode && isStorablePurpose(k)) out[k] = mode;
  }
  return out;
}

/**
 * Read the store row into the cache (deduped; fail-open to the last known
 * row, else {}). Exported for tests and for the admin GET.
 */
export async function refreshDecisionModes(): Promise<StoredDecisionModes> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let modes: StoredDecisionModes = cache?.modes ?? {};
    try {
      const { storeGet } = await import('../memory/context-store');
      modes = normalizeStoredDecisionModes(await storeGet<StoredRow>(STORE_NS, STORE_KEY));
      // E12 act-period window: a purpose whose effective mode moved (a flip on
      // any box, a demotion, a cleared row) starts its window over. Only a
      // SUCCESSFUL read is compared — a failed read must not look like "every
      // purpose cleared".
      try { noteEffectiveModes(modes); } catch { /* never breaks the refresh */ }
    } catch (err: any) {
      logger.warn(`decision-gate-modes: store read failed (${err?.message}) — ${cache ? 'serving the last known modes' : 'env modes apply'}`);
    }
    cache = { modes, expiresAt: Date.now() + CACHE_TTL_MS };
    return modes;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * The store's mode for a purpose from the in-process cache, or null when the
 * store holds nothing for the purpose, or has not been read yet.
 * A stale cache schedules ONE background refresh (never under NODE_ENV=test).
 */
export function storedDecisionModeSync(purpose: DecisionPurpose): DecisionMode | null {
  if (!cache || cache.expiresAt <= Date.now()) {
    // Never schedule a live store read from inside jest: NODE_ENV='test' is
    // the documented contract, JEST_WORKER_ID covers suites that unset
    // NODE_ENV to pin the production default (decision-gate.hermeticity) —
    // the dynamic context-store import would boot config/env, which
    // process.exit()s a keyless test process.
    if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID && !inFlight) {
      void refreshDecisionModes().catch(() => { /* fail-open: logged inside */ });
    }
  }
  if (!cache || !isStorablePurpose(purpose)) return null;
  return cache.modes[purpose] ?? null;
}

// ── E12: flip-readiness stamps + admission control (2026-09-25) ─────────────
// The flip-readiness report (`npm run decision-gate:fit`, decision-gate-fit.ts)
// writes ONE store row, ['instance','decision-gate'] / 'readiness', shaped
//   { <purpose>: { ready: boolean, at: ISO, metrics: {...}, reasons?: string[] } }
// — per purpose whether the common bar (≥200 labelled outcomes over ≥3 days
// after dedupe, act-band precision ≥ 0.9 at the purpose's cutoff, AUROC ≥
// 0.8, coverage at ≤5% error ≥ 60%, a calibrated + pinned backend) was met,
// when it was measured, and the numbers. The admin PUT refuses `act` for a
// purpose without a fresh ready:true stamp, naming what is missing, so a
// flip can no longer happen on zero labels. Kill switch
// DECISION_GATE_ADMISSION_DISABLED=1 (the PUT admits act unconditionally
// again). A stamp older than DECISION_GATE_READINESS_MAX_AGE_DAYS (default 7)
// is stale — the report must be re-run.

const READINESS_KEY = 'readiness';
export const READINESS_MAX_AGE_DEFAULT_DAYS = 7;

export interface PurposeReadiness {
  ready: boolean;
  /** ISO time the report stamped it (null when the stamp carried none). */
  at: string | null;
  metrics: Record<string, unknown>;
  /** The report's own words for what fell short (optional). */
  reasons?: string[];
  /** 2026-09-26: the backend identity the verdict was measured on (the report's backendSpec). Absent on older stamps. */
  backendSpec?: string;
}
export type StoredReadiness = Partial<Record<Exclude<DecisionPurpose, 'probe'>, PurposeReadiness>>;

// ── 2026-09-26: the per-purpose PRIMARY backend seam (plan D) ────────────────
// The backends module (per-purpose primary / challenger config — a sibling
// branch) registers a resolver here at import; until it does, nobody knows a
// primary and the admission check below is a no-op (pre-change behaviour).
// The readiness job asks the same resolver for the stamp's primaryByPurpose.

export type DecisionPrimaryResolver = (purpose: string) => Promise<string | undefined> | string | undefined;
let primaryResolver: DecisionPrimaryResolver | null = null;

/** Register (or clear with null) the resolver that names a purpose's effective primary backend spec. */
export function setDecisionPrimaryResolver(fn: DecisionPrimaryResolver | null): void {
  primaryResolver = fn;
}

/** The purpose's effective primary backend spec through the registered resolver — undefined when none is registered or it fails (fail-open). */
export async function resolveDecisionPrimarySpec(purpose: string): Promise<string | undefined> {
  if (!primaryResolver) return undefined;
  try {
    const v = await primaryResolver(purpose);
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  } catch (err: any) {
    logger.warn(`decision-gate-modes: primary resolver failed for ${purpose} (${err?.message}) — no backend pin applied`);
    return undefined;
  }
}

/** DECISION_GATE_ADMISSION_DISABLED=1 — the PUT admits `act` without a readiness stamp (pre-E12). */
export function decisionAdmissionDisabled(): boolean {
  return onFlag(process.env.DECISION_GATE_ADMISSION_DISABLED);
}

export function readinessMaxAgeMs(): number {
  const n = Number(process.env.DECISION_GATE_READINESS_MAX_AGE_DAYS);
  return (Number.isFinite(n) && n > 0 ? n : READINESS_MAX_AGE_DEFAULT_DAYS) * 24 * 60 * 60_000;
}

/** Pure: the stored readiness row → known purposes with a well-formed stamp only. */
export function normalizeStoredReadiness(stored: unknown): StoredReadiness {
  const out: StoredReadiness = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    if (!isStorablePurpose(k) || !v || typeof v !== 'object') continue;
    const r = v as Record<string, unknown>;
    if (typeof r.ready !== 'boolean') continue;
    const at = typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? r.at : null;
    const metrics = r.metrics && typeof r.metrics === 'object' && !Array.isArray(r.metrics) ? (r.metrics as Record<string, unknown>) : {};
    const reasons = Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === 'string').slice(0, 12) : undefined;
    const backendSpec = typeof r.backendSpec === 'string' && r.backendSpec.trim() ? r.backendSpec.trim().slice(0, 300) : undefined;
    out[k] = { ready: r.ready, at, metrics, ...(reasons?.length ? { reasons } : {}), ...(backendSpec ? { backendSpec } : {}) };
  }
  return out;
}

/** Fresh store read of the readiness row (fail-open to {}). */
export async function readDecisionReadiness(): Promise<StoredReadiness> {
  try {
    const { storeGet } = await import('../memory/context-store');
    return normalizeStoredReadiness(await storeGet<unknown>(STORE_NS, READINESS_KEY));
  } catch (err: any) {
    logger.warn(`decision-gate-modes: readiness read failed (${err?.message}) — treating every purpose as not ready`);
    return {};
  }
}

const compactMetrics = (m: Record<string, unknown>): string =>
  Object.entries(m).slice(0, 8).map(([k, v]) => `${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : String(v).slice(0, 24)}`).join(', ');

/**
 * Pure: may `act` be admitted for a purpose? A ready:true stamp younger than
 * the max age admits; anything else names the bar that is missing.
 * 2026-09-26 (plan D): when the stamp names the backend it was measured on
 * (`backendSpec`) AND the caller names the purpose's effective primary
 * (`opts.primarySpec`) and they differ, act is refused — the evidence was
 * gathered on another backend ("readiness measured on X, primary is Y"; the
 * next readiness pass re-stamps the primary within ≤ 6 h). Either side
 * missing = no pin (older stamps, no backends module) — pre-change behaviour.
 */
export function admissionVerdict(purpose: Exclude<DecisionPurpose, 'probe'>, readiness: StoredReadiness, now = Date.now(), opts: { primarySpec?: string } = {}): { admitted: boolean; stale: boolean; reason?: string } {
  const r = readiness[purpose];
  if (!r) return { admitted: false, stale: false, reason: 'no readiness stamp — the flip-readiness report has never marked this purpose READY (run `npm run decision-gate:fit`)' };
  const ageMs = r.at ? now - Date.parse(r.at) : Infinity;
  const stale = ageMs > readinessMaxAgeMs();
  const metricsText = Object.keys(r.metrics).length ? ` (${compactMetrics(r.metrics)})` : '';
  if (!r.ready) return { admitted: false, stale, reason: `the report marked it NOT READY${r.at ? ` at ${r.at}` : ''}${r.reasons?.length ? `: ${r.reasons.join('; ')}` : ''}${metricsText}` };
  if (stale) return { admitted: false, stale, reason: `the READY stamp is stale (${r.at ?? 'no timestamp'}; max age ${Math.round(readinessMaxAgeMs() / 86_400_000)} d) — re-run the report${metricsText}` };
  const primary = typeof opts.primarySpec === 'string' && opts.primarySpec.trim() ? opts.primarySpec.trim() : undefined;
  if (r.backendSpec && primary && r.backendSpec !== primary) {
    return { admitted: false, stale: false, reason: `readiness measured on ${r.backendSpec}, primary is ${primary} — the READY verdict does not cover the backend that would act; wait for the next readiness pass to stamp ${primary} (≤ 6 h), or set the primary back${metricsText}` };
  }
  return { admitted: true, stale: false };
}

// ── E12: rolling act-band precision → automatic demotion act → shadow ───────
// recordDecisionOutcome (decision-gate.ts) feeds one boolean per LABELLED
// outcome inside the purpose's act band, on the purpose's ACT question
// (agreed / disagreed). Once a purpose's window holds ≥
// DECISION_GATE_AUTO_DEMOTE_MIN_N such labels (default 30, of the last 100)
// and the precision is CONFIDENTLY below the bar (rule below), an
// EFFECTIVELY-act purpose is written back to shadow in the store row (the
// store wins over env, so an env-only act is demoted too) and a
// `decision_gate_demoted` telemetry row records why. The window is per
// PROCESS (outcome rows finalize where the gated run finalizes, mostly the
// coding worker); a purpose that is not act only clears its window — nothing
// is written. Demotion can only REMOVE acting, never add it.
//
// ACT-PERIOD ONLY (incident 2026-09-26 00:24:40Z): the owner flipped
// wake_triage to act at 00:20:54Z and FOUR MINUTES later the window demoted
// it on n=47, precision 0.894 — 47 labels that had accrued in SHADOW over the
// previous hours (the window never looked at the decision's mode) and a
// point estimate one label under the 0.9 bar. Two rules now hold:
//   (1) the window admits ONLY outcomes whose DECISION was made in act mode
//       (DecideResult.mode === 'act' — the mode the answer was actually used
//       under, carried on the stash for deferred labels), and it is CLEARED
//       whenever the purpose's effective store mode changes (a flip starts
//       the count at zero: `windowSince`). Shadow-era labels never count.
//   (2) the breach test is a CONFIDENCE BOUND, not a point estimate:
//         demote  iff  n_act ≥ MIN_N  AND  wilsonUpper95(k, n_act) < bar − margin
//       i.e. the 95% Wilson interval of the act-period precision lies WHOLLY
//       below the bar (one-sided 97.5%). Why the UPPER bound and not the lower:
//       "LB < bar − 0.05" reads as "demote unless the purpose PROVES it is ≥
//       0.85", and at n = 30 the interval is ±0.11 wide near 0.9, so ONE
//       disagreement in 30 (29/30 = 96.7%, LB 0.833) would demote — a purpose
//       running at exactly the 0.9 bar would be demoted 96% of the time at its
//       first 30 act labels (79% at a true 0.95). The upper-bound test puts
//       the burden of proof on the DEMOTION: at p = 0.9 it fires ≈3–4% of the
//       time per check; at p = 0.8 it fires with 62% at n = 47 and 87% at
//       n = 100. Boundaries at bar 0.9, margin 0 (wilsonInterval, z = 1.96):
//         n = 30 → demote at ≤ 23/30 (UB 0.882; 24/30 → 0.905 keeps)
//         n = 47 → demote at ≤ 38/47 (UB 0.896; 39/47 → 0.911 keeps)
//         n = 100 → demote at ≤ 84/100 (UB 0.899; 85/100 → 0.907 keeps)
//       The incident's 42/47 (UB 0.954) is inside the noise of the bar and
//       does NOT demote — it is the flip-readiness report's job (≥ 200 labels)
//       to judge 0.894 vs 0.9, not a 47-label window's. A purpose sitting in
//       the 0.85–0.9 band is therefore only caught ~half the time per 100-label
//       window: accepted, the alternative is demoting good flips.
//   bar    = DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_<PURPOSE>, else
//            DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION, else 0.9 (the flip bar)
//   margin = DECISION_GATE_AUTO_DEMOTE_MARGIN (default 0): extra tolerance
//            BELOW the bar before the net pulls a purpose (0.05 = "confidently
//            below 0.85"). With the upper-bound test no counterweight is
//            needed, hence 0; raise it only to make the net more lenient.

export const ACT_BAND_WINDOW = 100;
export const AUTO_DEMOTE_MIN_N_DEFAULT = 30;
export const AUTO_DEMOTE_MIN_PRECISION_DEFAULT = 0.9;
export const AUTO_DEMOTE_MARGIN_DEFAULT = 0;
/** z for the Wilson interval: 1.96 = the 95% two-sided interval (its upper end is a one-sided 97.5% bound). */
export const AUTO_DEMOTE_WILSON_Z = 1.96;
const AUTO_DEMOTE_THROTTLE_MS = 60 * 60_000;

/**
 * Purposes EXEMPT from the in-memory auto-demote window (DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES,
 * comma-separated; default `compute_policy` — audit 2026-09-26 tests-gaps-5 /
 * telemetry-readiness-1: its window is per PROCESS while its labels are written by
 * two processes — taps / facts in the web backend, the window-closed negatives by
 * the worker cron — so each process would judge a different biased half. The
 * DB-backed readiness ruler (all rows, every 6 h) is its demotion path.)
 */
export function autoDemoteExemptPurposes(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env.DECISION_GATE_AUTO_DEMOTE_EXEMPT_PURPOSES;
  const list = raw === undefined ? ['compute_policy'] : String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return new Set(list);
}
export function autoDemoteMinN(): number {
  const n = Number(process.env.DECISION_GATE_AUTO_DEMOTE_MIN_N);
  return Number.isFinite(n) && n >= 5 ? Math.min(ACT_BAND_WINDOW, Math.floor(n)) : AUTO_DEMOTE_MIN_N_DEFAULT;
}
/** agent-decisions 2026-09-27: purposes whose act-period band labels are the heartbeat-floor control turns (pinned turns
 *  are excludeFromFit upstream and never reach this window) need a stricter bar than the global 0.9 —
 *  supervisor_turn_noop demotes when the floor-turn action rate exceeds 5%. Env still wins. */
export const AUTO_DEMOTE_MIN_PRECISION_DEFAULTS: Readonly<Partial<Record<DecisionPurpose, number>>> = { supervisor_turn_noop: 0.95 };

/** The precision bar for a purpose: DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_<PURPOSE> → the global env → the purpose default (AUTO_DEMOTE_MIN_PRECISION_DEFAULTS) → 0.9. */
export function autoDemoteMinPrecision(purpose?: DecisionPurpose): number {
  if (purpose) {
    const p = Number(process.env[`DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_${purpose.toUpperCase()}`]);
    if (Number.isFinite(p) && p > 0 && p <= 1) return p;
  }
  const n = Number(process.env.DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION);
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  return (purpose && AUTO_DEMOTE_MIN_PRECISION_DEFAULTS[purpose]) || AUTO_DEMOTE_MIN_PRECISION_DEFAULT;
}
/** DECISION_GATE_AUTO_DEMOTE_MARGIN — tolerance below the bar (0 ≤ m < 0.5; default 0). */
export function autoDemoteMargin(): number {
  const m = Number(process.env.DECISION_GATE_AUTO_DEMOTE_MARGIN);
  return Number.isFinite(m) && m >= 0 && m < 0.5 ? m : AUTO_DEMOTE_MARGIN_DEFAULT;
}

interface ActBandWindowState {
  /** One entry per admitted act-period label (agreed / disagreed), oldest first, ≤ ACT_BAND_WINDOW. */
  labels: boolean[];
  /** ms epoch of the first label admitted since the window was (re)started; null while empty. */
  since: number | null;
}
const actBandWindows = new Map<string, ActBandWindowState>();
const lastDemoteAt = new Map<string, number>();
/** Demotions run one at a time (the store row is read-modify-write). */
let demoteQueue: Promise<unknown> = Promise.resolve();
/** The effective mode (store row, else env) each purpose was last seen running — the window resets when it moves. */
let lastSeenEffectiveModes: Map<Exclude<DecisionPurpose, 'probe'>, DecisionMode> | null = null;
/** Test hook. */
export function clearActBandWindows(): void { actBandWindows.clear(); lastDemoteAt.clear(); lastSeenEffectiveModes = null; }

export interface ActBandWindowView {
  /** Act-period labels in the window (n_act). */
  n: number;
  precision: number;
  /** Wilson 95% bounds of `precision` (the whole [0, 1] while empty). */
  lowerBound: number;
  upperBound: number;
  /** ISO time the current window started (first admitted label), null while empty. */
  since: string | null;
}

/** The current act-period window for a purpose (tests / diagnostics). */
export function actBandWindow(purpose: DecisionPurpose): ActBandWindowView {
  const w = actBandWindows.get(purpose);
  const labels = w?.labels ?? [];
  const n = labels.length;
  const k = labels.filter(Boolean).length;
  const { lower, upper } = wilsonInterval(k, n, AUTO_DEMOTE_WILSON_Z);
  return { n, precision: n ? k / n : NaN, lowerBound: lower, upperBound: upper, since: w?.since ? new Date(w.since).toISOString() : null };
}

/** Restart a purpose's window (a flip, a demotion, or a breach that fired). Exported for the admin PUT + tests. */
export function resetActBandWindow(purpose: DecisionPurpose, reason: string): void {
  const had = actBandWindows.get(purpose)?.labels.length ?? 0;
  actBandWindows.delete(purpose);
  if (had > 0) logger.info(`decision-gate-modes: ${purpose} act-band window reset (${reason}) — ${had} act-period label(s) dropped`);
}

/**
 * Detect effective-mode moves (store row, else env, per purpose) and reset the
 * moved purposes' windows. Called after every successful store read; the first
 * call seeds the baseline from what this process served before the store was
 * read (env), so an env-act → store-shadow move on the first read resets too.
 */
function noteEffectiveModes(stored: StoredDecisionModes): void {
  const next = new Map<Exclude<DecisionPurpose, 'probe'>, DecisionMode>();
  for (const p of DECISION_PURPOSES) next.set(p.purpose, stored[p.purpose] || envDecisionMode(p.purpose).mode);
  const prev = lastSeenEffectiveModes ?? new Map<Exclude<DecisionPurpose, 'probe'>, DecisionMode>(DECISION_PURPOSES.map(p => [p.purpose, envDecisionMode(p.purpose).mode]));
  for (const [purpose, mode] of next) {
    const before = prev.get(purpose);
    if (before !== undefined && before !== mode) resetActBandWindow(purpose, `effective mode ${before} → ${mode}`);
  }
  lastSeenEffectiveModes = next;
}

export interface ActBandBreach {
  /** Act-period labels in the window when the breach fired (n_act). */
  n: number;
  precision: number;
  lowerBound: number;
  upperBound: number;
  bar: number;
  margin: number;
  /** ISO time the breached window started (first admitted act-period label). */
  windowSince: string | null;
  /** audit 2026-10-08 W3-7: why the purpose is demoted — a precision breach (default) or the act LABEL FLOOR
   *  (decision-gate-label-floor.ts: too few of its act decisions are ever labelled for the precision rule to fire). */
  reason?: 'precision' | 'label_floor';
  /** label_floor: the labelled share of the act-band act decisions, and how many decisions it covers. */
  labelCoverage?: number;
  decisions?: number;
}

/**
 * Pure: the demotion rule on one window. Demote iff n ≥ minN AND the Wilson
 * 95% UPPER bound of k/n is below bar − margin (see the block comment above).
 */
export function actBandBreachVerdict(k: number, n: number, opts: { minN: number; bar: number; margin: number }): { breach: boolean; precision: number; lowerBound: number; upperBound: number } {
  const { lower, upper } = wilsonInterval(k, n, AUTO_DEMOTE_WILSON_Z);
  const precision = n ? k / n : NaN;
  return { breach: n >= opts.minN && upper < opts.bar - opts.margin, precision, lowerBound: lower, upperBound: upper };
}

/**
 * Feed one labelled act-band outcome. ONLY a label whose decision was made in
 * act mode is admitted (`decisionMode` — DecideResult.mode / the stash's mode);
 * shadow / off / unknown labels return null without touching the window.
 * Returns the breach it triggered (or null). Never throws; the demotion
 * itself runs fire-and-forget.
 */
export function noteActBandOutcome(purpose: DecisionPurpose, agreed: boolean, decisionMode: DecisionMode | null | undefined): ActBandBreach | null {
  try {
    if (purpose === 'probe' || !isStorablePurpose(purpose)) return null;
    if (decisionMode !== 'act') return null;
    if (autoDemoteExemptPurposes().has(purpose)) return null;
    const w = actBandWindows.get(purpose) ?? { labels: [], since: null };
    if (w.since === null) w.since = Date.now();
    w.labels.push(agreed);
    while (w.labels.length > ACT_BAND_WINDOW) w.labels.shift();
    actBandWindows.set(purpose, w);
    const n = w.labels.length;
    const k = w.labels.filter(Boolean).length;
    const bar = autoDemoteMinPrecision(purpose);
    const margin = autoDemoteMargin();
    const v = actBandBreachVerdict(k, n, { minN: autoDemoteMinN(), bar, margin });
    if (!v.breach) return null;
    const breach: ActBandBreach = { n, precision: v.precision, lowerBound: v.lowerBound, upperBound: v.upperBound, bar, margin, windowSince: w.since ? new Date(w.since).toISOString() : null };
    resetActBandWindow(purpose, 'breach fired');
    // Serialized: two purposes breaching in the same tick would otherwise
    // read-modify-write the ONE store row concurrently and the second write
    // would drop the first demotion.
    demoteQueue = demoteQueue.then(() => autoDemoteDecisionMode(purpose, breach)).catch(() => { /* logged inside */ });
    return breach;
  } catch { return null; }
}

/**
 * Demote an EFFECTIVELY-act purpose to shadow in the store row and record a
 * `decision_gate_demoted` telemetry row (outcome 'demoted'). Throttled once per purpose
 * per hour. Never throws. A bare `{ n, precision }` breach (direct callers /
 * tests) gets its Wilson bounds, bar and margin filled in here.
 */
export async function autoDemoteDecisionMode(purpose: Exclude<DecisionPurpose, 'probe'>, breachIn: Pick<ActBandBreach, 'n' | 'precision'> & Partial<ActBandBreach>): Promise<'demoted' | 'observed' | 'skipped'> {
  try {
    const now = Date.now();
    const { storeGet, storePut } = await import('../memory/context-store');
    let existing: StoredDecisionModes = {};
    try { existing = normalizeStoredDecisionModes(await storeGet<StoredRow>(STORE_NS, STORE_KEY)); } catch { existing = {}; }
    const gateOff = onFlag(process.env.DECISION_GATE_DISABLED);
    const effective: DecisionMode = gateOff ? 'off' : existing[purpose] ? existing[purpose]! : envDecisionMode(purpose).mode;
    const previous = existing[purpose] ?? null;
    const bar = breachIn.bar ?? autoDemoteMinPrecision(purpose);
    const margin = breachIn.margin ?? autoDemoteMargin();
    const bounds = breachIn.lowerBound !== undefined && breachIn.upperBound !== undefined
      ? { lower: breachIn.lowerBound, upper: breachIn.upperBound }
      : wilsonInterval(Math.round(breachIn.precision * breachIn.n), breachIn.n, AUTO_DEMOTE_WILSON_Z);
    const breach: ActBandBreach = { n: breachIn.n, precision: breachIn.precision, lowerBound: bounds.lower, upperBound: bounds.upper, bar, margin, windowSince: breachIn.windowSince ?? null };
    const r3 = (x: number) => Number(x.toFixed(3));
    const labelFloorDemote = breachIn.reason === 'label_floor';
    const summary = labelFloorDemote
      ? `act LABEL FLOOR: only ${breach.n} of ${breachIn.decisions ?? '?'} act-band act decisions labelled (coverage ${r3(breachIn.labelCoverage ?? 0)}) — the precision auto-demote could never fire (window since ${breach.windowSince ?? 'unknown'})`
      : `act-period act-band precision ${r3(breach.precision)} over n_act=${breach.n} labelled act-mode outcomes (Wilson 95% [${r3(breach.lowerBound)}, ${r3(breach.upperBound)}]; upper bound < bar ${bar}${margin ? ` − margin ${margin}` : ''}; window since ${breach.windowSince ?? 'unknown'})`;
    if (effective !== 'act') {
      // A stale breach (labels from a previous act period landing after the flip back): nothing to demote, no throttle burnt.
      logger.debug(`decision-gate-modes: ${purpose} ${summary} — purpose is ${effective}, nothing to demote`);
      return 'skipped';
    }
    if (now - (lastDemoteAt.get(purpose) ?? 0) < AUTO_DEMOTE_THROTTLE_MS) return 'skipped';
    lastDemoteAt.set(purpose, now);
    existing[purpose] = 'shadow';
    await storePut(STORE_NS, STORE_KEY, {
      modes: existing, updatedBy: 'auto-demote', updatedAt: new Date(now).toISOString(),
      demoted: { purpose, n: breach.n, nAct: breach.n, precision: r3(breach.precision), lowerBound: r3(breach.lowerBound), upperBound: r3(breach.upperBound), bar, margin, windowSince: breach.windowSince, windowScope: 'act_period', ...(labelFloorDemote ? { reason: 'label_floor', labelCoverage: r3(breachIn.labelCoverage ?? 0), decisions: breachIn.decisions ?? null } : {}) },
    });
    clearDecisionModeCache();
    resetActBandWindow(purpose, 'auto-demoted act → shadow');
    const outcome = 'demoted' as const;
    logger.warn(`decision-gate-modes: AUTO-DEMOTED ${purpose} act → shadow — ${summary} (store row updated fleet-wide; re-run the readiness report before flipping again)`);
    try {
      const { recordLoopMetric } = await import('./loop-metrics.service');
      recordLoopMetric({
        kind: 'decision_gate_demoted',
        value: r3(breach.precision),
        meta: {
          purpose, n: breach.n, nAct: breach.n, precision: r3(breach.precision), lowerBound: r3(breach.lowerBound), upperBound: r3(breach.upperBound), bar, margin,
          window: ACT_BAND_WINDOW, windowScope: 'act_period', windowSince: breach.windowSince, previousStoreMode: previous, effectiveBefore: effective, outcome,
          ...(labelFloorDemote ? { reason: 'label_floor', labelCoverage: r3(breachIn.labelCoverage ?? 0), decisions: breachIn.decisions ?? null } : {}),
        },
      });
    } catch { /* telemetry never throws */ }
    return outcome;
  } catch (err: any) {
    logger.warn(`decision-gate-modes: auto-demote of ${purpose} failed (${err?.message}) — mode unchanged`);
    return 'skipped';
  }
}

// ── Admin view + update ─────────────────────────────────────────────────────

export interface DecisionModeView {
  purpose: Exclude<DecisionPurpose, 'probe'>;
  label: string;
  description: string;
  /** The stored (fleet-wide) mode, or null when the purpose runs its env/default mode. */
  storeMode: DecisionMode | null;
  /** What env alone would give on THIS process (DECISION_GATE_MODE_<PURPOSE> / DEFAULT / built-in default). */
  envMode: DecisionMode;
  /** What this process runs right now. */
  effective: DecisionMode;
  effectiveSource: 'disabled' | 'store' | 'env_purpose' | 'env_default' | 'default' | 'registry_cap' | 'retired_default';
  /** agent-decisions prerequisite 3 (2026-09-27): the purpose is capped at shadow in code (act refused / clamped) — absent when uncapped or lifted on this process. */
  actCap?: PurposeActCap;
  /** E12: the flip-readiness stamp (null = never stamped) + whether act would be admitted now. */
  readiness: (PurposeReadiness & { stale: boolean }) | null;
  admission: { admitted: boolean; reason?: string };
  /** 2026-09-26: the purpose's effective primary backend spec, when a resolver is registered / passed (plan D pin). */
  primarySpec?: string;
}

/** 2026-09-26: per-call override of the primary resolver (the merge agent / tests); default = the registered resolver. */
export interface DecisionModeOpts {
  primarySpecFor?: DecisionPrimaryResolver;
}

async function primarySpecFor(purpose: string, opts?: DecisionModeOpts): Promise<string | undefined> {
  if (!opts?.primarySpecFor) return resolveDecisionPrimarySpec(purpose);
  try {
    const v = await opts.primarySpecFor(purpose);
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  } catch { return undefined; }
}

export interface DecisionModeConfig {
  purposes: DecisionModeView[];
  /** DECISION_GATE_DISABLED is set on this process — every purpose is off here. */
  gateDisabled: boolean;
  /** E12: DECISION_GATE_ADMISSION_DISABLED is set on this process — the PUT admits act without a readiness stamp. */
  admissionDisabled: boolean;
}

/** The admin view: every purpose with its stored, env and effective mode (fresh store read). */
export async function getDecisionModeConfig(opts?: DecisionModeOpts): Promise<DecisionModeConfig> {
  const [stored, readiness] = await Promise.all([refreshDecisionModes(), readDecisionReadiness()]);
  const gateDisabled = onFlag(process.env.DECISION_GATE_DISABLED);
  const admissionDisabled = decisionAdmissionDisabled();
  const purposes: DecisionModeView[] = await Promise.all(DECISION_PURPOSES.map(async p => {
    const storeMode = stored[p.purpose] ?? null;
    const env = envDecisionMode(p.purpose);
    let effective: DecisionMode;
    let effectiveSource: DecisionModeView['effectiveSource'];
    if (gateDisabled) { effective = 'off'; effectiveSource = 'disabled'; }
    else if (storeMode) { effective = storeMode; effectiveSource = 'store'; }
    else { effective = env.mode; effectiveSource = env.source; }
    // agent-decisions prerequisite 3: a registry-capped purpose runs shadow whatever the store / env say.
    const actCap = purposeActCap(p.purpose);
    if (actCap && effective === 'act') { effective = 'shadow'; effectiveSource = 'registry_cap'; }
    const primarySpec = await primarySpecFor(p.purpose, opts);
    const verdict = admissionVerdict(p.purpose, readiness, Date.now(), { primarySpec });
    const r = readiness[p.purpose];
    return {
      purpose: p.purpose, label: p.label, description: p.description, storeMode, envMode: env.mode, effective, effectiveSource,
      readiness: r ? { ...r, stale: verdict.stale } : null,
      admission: actCap
        ? { admitted: false, reason: `capped at shadow in code since ${actCap.since}: ${actCap.why} — lift with ${actCap.liftEnv}=1` }
        : admissionDisabled ? { admitted: true, reason: 'DECISION_GATE_ADMISSION_DISABLED is set on this process' } : { admitted: verdict.admitted, ...(verdict.reason ? { reason: verdict.reason } : {}) },
      ...(primarySpec ? { primarySpec } : {}),
      ...(actCap ? { actCap } : {}),
    };
  }));
  return { purposes, gateDisabled, admissionDisabled };
}

/**
 * Admin PUT: { <purpose>: 'off' | 'shadow' | 'act' | '' } — '' clears the
 * stored mode (env/default applies again). Unknown purposes and values are
 * refused with a precise message; `act` is refused (409, E12) for a purpose
 * whose flip-readiness stamp is missing, NOT READY or stale, unless
 * DECISION_GATE_ADMISSION_DISABLED=1. Read-modify-write of the single row;
 * the cache is dropped so THIS process sees it at once (other boxes within
 * the 30 s TTL). Returns the fresh admin view.
 */
export async function updateDecisionModes(patch: Record<string, unknown>, userId?: string, opts?: DecisionModeOpts): Promise<DecisionModeConfig> {
  const { AppError } = await import('../../../middleware/error-handler');
  const entries = Object.entries(patch ?? {});
  if (!entries.length) throw new AppError(400, 'No modes to update — send { modes: { "<purpose>": "off" | "shadow" | "act" | "" } }.');
  const changes: Array<[Exclude<DecisionPurpose, 'probe'>, DecisionMode | null]> = [];
  for (const [k, v] of entries) {
    if (!isStorablePurpose(k)) throw new AppError(400, `Unknown decision-gate purpose "${k}" — one of ${DECISION_PURPOSES.map(p => p.purpose).join(', ')}.`);
    const s = String(v ?? '').trim();
    if (s === '') { changes.push([k, null]); continue; }
    const mode = parseDecisionMode(s);
    if (!mode) throw new AppError(400, `Invalid mode "${s}" for ${k} — use off, shadow, act, or "" to clear.`);
    changes.push([k, mode]);
  }
  // E12: admission control — act needs a fresh READY stamp from the report.
  const wantsAct = changes.filter(([, m]) => m === 'act').map(([k]) => k);
  // agent-decisions prerequisite 3 (2026-09-27): a registry-capped purpose refuses act
  // outright (the cap would clamp it to shadow anyway — refusing keeps the store honest).
  for (const k of wantsAct) {
    const cap = purposeActCap(k);
    if (cap) throw new AppError(409, `Cannot set ${k} to act — capped at shadow in code since ${cap.since}: ${cap.why}. Lift the cap on every box with ${cap.liftEnv}=1 first.`);
  }
  if (wantsAct.length && !decisionAdmissionDisabled()) {
    const readiness = await readDecisionReadiness();
    for (const k of wantsAct) {
      // 2026-09-26 (plan D): the stamp must have been measured on the purpose's effective primary (when both are known).
      const primarySpec = await primarySpecFor(k, opts);
      const verdict = admissionVerdict(k, readiness, Date.now(), { primarySpec });
      if (!verdict.admitted) {
        throw new AppError(409, `Cannot set ${k} to act — not ready: ${verdict.reason}. The store key instance:decision-gate/readiness must carry { ${k}: { ready: true, at, metrics } } from the flip-readiness report; kill switch DECISION_GATE_ADMISSION_DISABLED=1.`);
      }
    }
  }
  const { storeGet, storePut } = await import('../memory/context-store');
  let existing: StoredDecisionModes = {};
  try { existing = normalizeStoredDecisionModes(await storeGet<StoredRow>(STORE_NS, STORE_KEY)); } catch { existing = {}; }
  const moved: Array<[Exclude<DecisionPurpose, 'probe'>, string]> = [];
  for (const [k, mode] of changes) {
    const before = existing[k] ?? null;
    if (mode) existing[k] = mode;
    else delete existing[k];
    if (before !== mode) moved.push([k, `admin set ${before ?? '(env)'} → ${mode ?? '(env)'}`]);
  }
  await storePut(STORE_NS, STORE_KEY, { modes: existing, updatedBy: userId ?? null, updatedAt: new Date().toISOString() });
  clearDecisionModeCache();
  // E12 act-period window: a purpose whose stored mode actually moved starts
  // its window over on THIS process at once (other boxes on their next refresh).
  for (const [k, reason] of moved) resetActBandWindow(k, reason);
  logger.info(`decision-gate-modes: updated ${changes.map(([k, m]) => `${k}=${m ?? '(env)'}`).join(', ')}${userId ? ` by ${userId}` : ''}`);
  return getDecisionModeConfig(opts);
}
