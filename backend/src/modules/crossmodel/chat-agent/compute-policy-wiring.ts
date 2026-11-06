/**
 * Compute-policy harness wiring — the PURE leaf behind the answer-first chat
 * turn (docs/DEPTH_UX_SOTA_2026-09-26.md §4/§5; branch cp/harness, Module B).
 *
 * What lives here (no I/O, no imports beyond the gate's types):
 *   - the kill switches: ANSWER_FIRST_DISABLED, DIG_DEEPER_DISABLED,
 *     DEPTH_BUDGET_DISABLED, UX_BEACON_DISABLED;
 *   - the injector wait rule (0 by default; ≤ STAKES_WAIT_MS on the stakes
 *     path, clocked from the injector's first opportunity; today's
 *     CROSS_CHECK_GATE_MS byte-for-byte under the kill switch or for guests,
 *     who cannot receive a late revision);
 *   - the lead's [PARALLEL CROSS-CHECK] doctrine paragraph (answer-first:
 *     never wait / never "answer now"; kill switch: today's blocking text);
 *   - the checker-spawn rule (by plan, never by mode==='thinking' alone);
 *   - the FIXED progress keys + their server-side message table (never model
 *     prose) and the `check_state` vocabulary;
 *   - the Dig-deeper next-rung selection, the chip shapes, the ETA text
 *     table (harness-measured, never typed by a model);
 *   - (deleted 2026-09-27 — owner: no hidden cost caps) the DepthBudget USD
 *     refusal rule; a Dig-deeper tap is never refused on cost;
 *   - the research rung's wall-clock rail (`researchRungDeadlineMs`:
 *     maxBackgroundMs → the council profiles' FINAL-TURN deadline).
 */
import type { DepthPlan, DepthPreset } from '../platform/compute-policy-gate';
import type { DepthBudget } from '../platform/depth-budget';
import { researchNoWallClockDisabled } from './council-dispatch';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** ANSWER_FIRST_DISABLED=1 — restores today's 300 s injector gate + inline reconcile wait byte-for-byte. */
export function answerFirstDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.ANSWER_FIRST_DISABLED); }
/** DIG_DEEPER_DISABLED=1 — no escalate chip; an escalationOf request is refused gracefully. */
export function digDeeperDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.DIG_DEEPER_DISABLED); }
/** DEPTH_BUDGET_DISABLED=1 — the DepthBudget TIME bound is recorded but applied to no deadline (the same flag platform/depth-budget.ts honours). There is no USD bound to switch off since 2026-09-27. */
export function depthBudgetDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.DEPTH_BUDGET_DISABLED); }
/**
 * The Dig-deeper RESEARCH rung keeps the budget rail unless the WHOLE budget
 * is observe-only (DEPTH_BUDGET_DISABLED=1). The per-rung kill switch
 * DEPTH_BUDGET_RESEARCH_RUNG_DISABLED was removed 2026-10-30 (RSW-1 cohort
 * delete — the rung rail is the shipped behaviour).
 */
export function researchRungBudgetDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return depthBudgetDisabled(env);
}
/** UX_BEACON_DISABLED=1 — the beacon endpoint records nothing (204). */
export function uxBeaconDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.UX_BEACON_DISABLED); }


// ── Telemetry honesty (audit 2026-09-26 supervisors-auto-4) ────────────────
// A machine row carries `leadEffortSent` (the wake_effort act path may run the
// lead at 'high' while the plan — forced 'max' by the machine rails — is what
// the row's `leadEffort` records). The former `budgetEnforced: false` field
// (which rows the DepthBudget USD rail governed) was DELETED 2026-09-27 with
// the rail itself: no row is bounded by USD any more (owner: no hidden cost
// caps), so there is nothing for it to describe.

export type LeadEffortSent = 'low' | 'medium' | 'high' | 'max';

export interface EnforcementStampInput {
  /** a machine-triggered run (wake / hook / schedule / agent / webhook origin) */
  machine: boolean;
  /** a Fleet / project supervisor chat (human-typed or machine) */
  supervisor: boolean;
  /** a Level 3 council run */
  council: boolean;
  /** the effort the harness resolved to send the lead (the wake_effort act value when the provider takes it, else plan.leadEffort) */
  leadEffortSent: LeadEffortSent;
}

export interface EnforcementStamp {
  /** machine rows only: the effort actually sent to the lead */
  leadEffortSent?: LeadEffortSent;
}

/**
 * The honesty fields for ONE compute_policy row (pure; {} on a non-machine row
 * — those rows keep today's shape).
 */
export function computePolicyEnforcementStamp(i: EnforcementStampInput, _env: NodeJS.ProcessEnv = process.env): EnforcementStamp {
  return {
    ...(i.machine ? { leadEffortSent: i.leadEffortSent } : {}),
  };
}

// ── Progress keys (FIXED set; message text from this table, never a model) ──
export const PROGRESS_KEYS = ['planning', 'checking_web', 'second_opinion', 'double_checking_stakes', 'deeper_findings_started', 'deeper_findings_ready'] as const;
export type ProgressKey = typeof PROGRESS_KEYS[number];

// Digby's status voice (2026-10-04, chat-agent/status-voice.ts rules). The web client mirrors this table in
// frontend/lib/depth-ux.ts PROGRESS_KEY_TEXT (mobile renders the server text) — change both together.
export const PROGRESS_LINES: Record<ProgressKey, string> = {
  planning: 'Digby is working out the best way to answer…',
  checking_web: 'Digby is checking the web…',
  // Sent at the START of an answer-first checked turn — never "Answering now" (the first word can be a minute away).
  second_opinion: 'A second opinion is running alongside — this answer updates if it finds something.',
  double_checking_stakes: 'This one matters — Digby is double-checking before answering…',
  deeper_findings_started: 'Digging deeper — “Deeper findings” will post here as a new message when they’re ready…',
  deeper_findings_ready: 'Deeper findings are ready.',
};

export function isProgressKey(k: unknown): k is ProgressKey {
  return typeof k === 'string' && (PROGRESS_KEYS as readonly string[]).includes(k);
}

/** The SSE 'progress' payload for a keyed status line (pure). */
export function keyedProgress(key: ProgressKey, extra: Record<string, unknown> = {}): { message: string; stage: string; key: ProgressKey } & Record<string, unknown> {
  const stage = key === 'deeper_findings_started' || key === 'deeper_findings_ready' ? 'synthesis' : key === 'checking_web' ? 'model-searching' : 'query';
  return { message: PROGRESS_LINES[key], stage, key, ...extra };
}

// ── check_state ──────────────────────────────────────────────────────────────
export const CHECK_STATES = ['checking', 'checked', 'updated', 'interrupted', 'skipped'] as const;
export type CheckState = typeof CHECK_STATES[number];

export interface CheckStatePayload { state: CheckState; changed?: string[]; revisionId?: string }

/**
 * The pill state a late-crosscheck outcome maps to (pure).
 *   conversation_moved (review 2026-09-26 M7): 'checked' ONLY when the check
 *   actually COMPLETED with nothing material to tell — a reconcile ran and its
 *   verdict was wording-only / no change (`movedCheckCompleted`). When no
 *   reconcile ran (no verdict function), it resolved
 *   empty, or the material addendum failed to persist, the user never received
 *   the check ⇒ 'interrupted' ("Check didn't finish"), never a false "Checked ✓".
 */
export function checkStateForLateOutcome(
  outcome: 'revised' | 'unchanged' | 'no_draft' | 'conversation_moved' | 'reconcile_failed' | 'timeout' | 'interrupted' | 'addendum',
  changed: string[] = [],
  opts: { movedCheckCompleted?: boolean } = {},
): CheckStatePayload {
  switch (outcome) {
    case 'revised':
    case 'addendum':
      return { state: 'updated', changed };
    case 'unchanged':
      return { state: 'checked' };
    case 'conversation_moved':
      return opts.movedCheckCompleted ? { state: 'checked' } : { state: 'interrupted' };
    default:
      return { state: 'interrupted' };
  }
}

// ── The lead's [PARALLEL CROSS-CHECK] doctrine paragraph ─────────────────────
/** Today's paragraph (kill switch / guest): the lead WAITS for the injected draft. Byte-for-byte the pre-2026-09-26 text. */
export const PARALLEL_CROSS_CHECK_NOTE_BLOCKING = '\n[PARALLEL CROSS-CHECK IN PROGRESS] The Double Checker (an independent model with its OWN live web tools) is researching and answering this same question right now. Its draft will be INJECTED into this conversation as a system message — use your early rounds for your own research (web_pipe / search / connectors), and do NOT write your final answer before the draft arrives and you have reconciled with it. EXCEPTION: if a system message tells you the Double Checker is STILL researching past its window, stop waiting — write your final answer from your own research; the harness reconciles the late draft into your delivered answer afterwards and updates the message.\n';
/**
 * Answer-first (review 2026-09-26 H2): the lead NEVER waits for the draft and is
 * never told to "answer now" — it keeps its full step budget and reconciles a
 * draft only if one is injected before it finishes; the harness reconciles a
 * late draft afterwards. Keeps the [PARALLEL CROSS-CHECK IN PROGRESS] header
 * (doctrine-ordering pins read it).
 */
export const PARALLEL_CROSS_CHECK_NOTE_ANSWER_FIRST = '\n[PARALLEL CROSS-CHECK IN PROGRESS] The Double Checker (an independent model with its OWN live web tools) is researching and answering this same question right now, in parallel. Do NOT wait for it and do not narrate waiting: use your tool rounds for your own research (web_pipe / search / connectors) and write your final answer as soon as YOUR research is done. If its draft is injected into this conversation as a system message before you finish, reconcile with it before writing; if it is not, answer from your own research — the harness reconciles the late draft into your delivered answer afterwards and updates the message.\n';

/** The [PARALLEL CROSS-CHECK] paragraph the lead reads when a Double Checker runs (pure). */
export function parallelCrossCheckNote(i: { answerFirst: boolean; webSearchConfigured?: boolean }): string {
  const note = i.answerFirst ? PARALLEL_CROSS_CHECK_NOTE_ANSWER_FIRST : PARALLEL_CROSS_CHECK_NOTE_BLOCKING;
  // Self-host setup hardening (2026-10-20): on an instance with no search backend
  // neither model has live web tools — keep the header (pins read it), fix the claim.
  if (i.webSearchConfigured === false) {
    return note
      .replace('(an independent model with its OWN live web tools)', '(an independent model answering from its own knowledge — this instance has no live web search)')
      .replace('(web_pipe / search / connectors)', '(connectors, files, memory)');
  }
  return note;
}

/**
 * How long finalize waits for a SHADOW / OFF compute-plan ask to attach its
 * decisionId / answers for labels (review 2026-09-26 M4: only an ACT purpose is
 * ever awaited on the request path; the preset runs at once otherwise).
 */
export const PLAN_LABEL_ATTACH_MS = 500;

// ── Injector wait / checker spawn ────────────────────────────────────────────
export interface InjectorWaitInput {
  /** answer-first applies: the kill switch is off AND the row can receive a late revision (a chatId exists). */
  answerFirst: boolean;
  plan: Pick<DepthPlan, 'checkerWaitMs'>;
  /** ms since the run started — today's kill-switch gate is measured from run start. */
  elapsedMs: number;
  /**
   * ms since the STAKES clock started (review 2026-09-26 M5): the injector's
   * FIRST opportunity (step ≥ 1, after the lead's step-0 model turn), not run
   * start — on a glm-5.3 'max' seat step 0 alone commonly exceeds 90 s, which
   * silently degraded the one blocking path to wait 0. Defaults to elapsedMs.
   */
  stakesElapsedMs?: number;
  /** today's CROSS_CHECK_GATE_MS */
  gateMs: number;
  /** the owner bound for the stakes path (STAKES_WAIT_MS) */
  stakesBoundMs: number;
}

/**
 * How long the lead's tool loop may block for the Double Checker's draft.
 *   answer-first: 0 — except the stakes path, min(plan.checkerWaitMs, STAKES_WAIT_MS)
 *     measured from the injector's first opportunity (stakesElapsedMs).
 *   kill switch / guest: today's `CROSS_CHECK_GATE_MS − elapsed` from run start (never negative).
 */
export function injectorWaitMs(i: InjectorWaitInput): number {
  if (!i.answerFirst) return Math.max(0, i.gateMs - i.elapsedMs);
  const wait = Math.min(Math.max(0, Number(i.plan.checkerWaitMs) || 0), i.stakesBoundMs);
  return wait > 0 ? Math.max(0, wait - (i.stakesElapsedMs ?? i.elapsedMs)) : 0;
}

/**
 * GUEST_CHECKER_GATE_BOUND_DISABLED=1 — a run with no persisted chat row (a
 * guest) blocks the lead for the Double Checker's draft up to the full
 * CROSS_CHECK_GATE_MS again (the pre-2026-10-03 behaviour).
 */
export function guestCheckerGateBoundDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.GUEST_CHECKER_GATE_BOUND_DISABLED); }
/** The documented guest bound ("guests keep the bounded 75 s behaviour" — DEPTH_UX_SOTA §5). */
export const GUEST_CHECKER_GATE_MS = 75_000;
/**
 * The blocking gate (ms from run start) for a run that cannot be answer-first.
 * Audit 2026-10-03: a guest run (no chat row ⇒ no late revision is possible)
 * blocked the lead for up to 300 s waiting on the checker — the 75 s cap the
 * design promised only applied when the regex called the message "simple",
 * which Auto almost never routes to Level 2. Guests (≈40% of plain human
 * turns) now get min(gateMs, 75 s); a signed-in run under the
 * ANSWER_FIRST_DISABLED kill switch keeps gateMs byte-for-byte. Pure.
 */
export function blockingCheckerGateMs(i: { hasChatRow: boolean; gateMs: number }, env: NodeJS.ProcessEnv = process.env): number {
  if (i.hasChatRow || guestCheckerGateBoundDisabled(env)) return i.gateMs;
  return Math.min(i.gateMs, GUEST_CHECKER_GATE_MS);
}

/** STAKES_FINALIZE_WAIT_DISABLED=1 — a lead that answers at step 0 on a stakes / verify plan ships after the 10 s late-wait again (the pre-2026-10-03 behaviour). */
export function stakesFinalizeWaitDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.STAKES_FINALIZE_WAIT_DISABLED); }
/**
 * How long the answer-first finalize waits for the Double Checker's draft.
 * Audit 2026-10-03: the stakes / Dig-deeper "verify" wait (plan.checkerWaitMs,
 * ≤ STAKES_WAIT_MS) lived ONLY in the step injector, which never runs when the
 * lead answers at step 0 with no tool call — so a verify rung shipped after the
 * plain 10 s late-wait without the check the user tapped for. When the
 * injector never waited, finalize now waits the plan's bound instead. Pure.
 */
export function finalizeDraftWaitMs(i: { answerFirst: boolean; plan: Pick<DepthPlan, 'checkerWaitMs'>; injectorWaited: boolean; lateWaitMs: number; stakesBoundMs: number }, env: NodeJS.ProcessEnv = process.env): number {
  if (!i.answerFirst || i.injectorWaited || stakesFinalizeWaitDisabled(env)) return i.lateWaitMs;
  const stakes = Math.min(Math.max(0, Number(i.plan.checkerWaitMs) || 0), i.stakesBoundMs);
  return Math.max(i.lateWaitMs, stakes);
}

export interface SpawnCheckerInput {
  plan: Pick<DepthPlan, 'spawnChecker' | 'preset'>;
  machineTurnSkipsChecker: boolean;
  checkerSeatProblem: string | null;
  /** the run is the council (its colleagues are the checkers) */
  isCouncil: boolean;
  /**
   * GHOST = ONE LEAD INFERENCE (owner ruling 2026-11-03): a ghost run on a live
   * designation never spawns a second model. Structural, not a plan flag — the
   * run seam already collapses the plan (`ghost-runtime ghostSingleModelPlan`),
   * and this belt-and-braces input means a future seam that hands a
   * checker-bearing plan to a ghost run STILL cannot spawn one.
   */
  ghost?: boolean;
  /**
   * A "second opinion" from the LEAD'S OWN MODEL is not a second opinion
   * (2026-11-06, owner-reported "the Double Checker is researching alongside"
   * on digby.cql.ca). When the Double Checker seat and the lead both resolve to
   * the same model — the usual shape on a single-model self-host, where the
   * admin points every seat at one endpoint — the run paid a FULL second
   * inference (`completionMs` 204 283 on the traced Edge turn) that could not
   * disagree, while the status line promised an independent cross-check. The
   * seam now refuses to spawn it, so the wording, the pill and the model trace
   * agree. Kill switch: CHECKER_SAME_MODEL_GUARD_DISABLED=1.
   */
  checkerSameModel?: boolean;
}

/** Spawn the Level 2 Double Checker iff the PLAN says so and nothing structural forbids it (pure). */
export function shouldSpawnChecker(i: SpawnCheckerInput): boolean {
  if (i.ghost || i.isCouncil || i.machineTurnSkipsChecker || i.checkerSeatProblem || i.checkerSameModel) return false;
  return i.plan.spawnChecker === true;
}

/** Same-model checker guard kill switch (default ON — see `checkerSameModelAsLead`). */
export function checkerSameModelGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.CHECKER_SAME_MODEL_GUARD_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Is the Double Checker the SAME model as the lead? (pure)
 *
 * Specs are `<registry-label>:<modelId>`; two seats can name one model with
 * different labels (`cql-llm:spark-x` vs `spark-x`), so the comparison is on
 * the modelId, case-insensitively. A missing/empty side is NOT a match — an
 * unresolvable spec must never silently suppress the checker (the seat's own
 * `seatUnservableReason` owns that verdict).
 */
export function checkerSameModelAsLead(leadSpec: string | null | undefined, checkerSpec: string | null | undefined): boolean {
  const id = (spec: string | null | undefined): string => {
    const s = String(spec ?? '').trim();
    if (!s) return '';
    const i = s.indexOf(':');
    return (i >= 0 ? s.slice(i + 1) : s).trim().toLowerCase();
  };
  const a = id(leadSpec);
  const b = id(checkerSpec);
  return !!a && a === b;
}

// ── Machine lanes on the compute policy (owner 2026-09-26: "default all chats
// to auto even supervisors and fleet supervisors") ────────────────────────────
// A supervisor / fleet-supervisor / project-supervisor wake — and every other
// machine-triggered run — now asks the SAME compute_policy gate a human turn
// asks, with the chat's stored preset as the fail-open fallback. What such a
// run got BY CONSTRUCTION before (lead effort max, no Double Checker — owner
// 2026-09-22 — no wait, no council) is now its PRESET plan (machinePresetPlan),
// so nothing changes until the gate acts; in act the plan may ADD a checker
// (it runs BEHIND the answer and reconciles late — never a wait) or, through the
// separate wake_effort purpose, lower the lead's effort. Hard rails a machine
// plan can never cross (applyMachineRails): checkerWaitMs 0 (the stakes wait is
// for humans — nobody is reading a wake live), council 'none' (a background
// council is never auto-started on a machine lane; the deep_research preset
// still runs its inline council as today), leadEffort 'max' (only wake_effort
// lowers it), and a checker ONLY when the gate ACTED to add one and answer-
// first is on (under ANSWER_FIRST_DISABLED=1 the old blocking gate would make
// the wake wait — so no gate checker there). COMPUTE_POLICY_MACHINE_DISABLED=1
// keeps machine runs off the gate entirely (preset rails only); the legacy
// MACHINE_TURN_CROSSCHECK_ENABLED=1 path is untouched.

/** COMPUTE_POLICY_MACHINE_DISABLED=1 — machine-triggered runs (incl. supervisor wakes) never ask the compute_policy gate; their preset rails run as before. */
export function computePolicyMachineDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.COMPUTE_POLICY_MACHINE_DISABLED); }

/** The plan a machine-triggered run executes when the gate does not act — exactly what it ran before 2026-09-26 (lead max, no checker, no wait, no council). Pure. */
export function machinePresetPlan(preset: DepthPreset, reason = `machine preset ${preset} (lead max, no checker, no wait, no council)`): DepthPlan {
  return { preset, spawnChecker: false, checkerWaitMs: 0, leadEffort: 'max', council: 'none', reason, source: 'preset', mode: 'off' };
}

export interface MachineRailsInput {
  /** ANSWER_FIRST_DISABLED=1 — the old blocking injector gate is live, so a gate-added checker would make the wake WAIT: refuse it. */
  answerFirstOff: boolean;
}

/** Apply the machine rails to a plan the gate returned (pure). A preset / shadow plan comes back as machinePresetPlan carrying the gate's decisionId / answers / mode / stash; an ACT plan keeps only what a machine lane may take: a checker the gate added (answer-first on), never a wait, never a council, lead max. */
export function applyMachineRails(plan: DepthPlan, i: MachineRailsInput): DepthPlan {
  const gateAddedChecker = plan.source === 'gate_act' && plan.spawnChecker === true && !i.answerFirstOff;
  const rails = ['wait 0', 'council none', 'lead max', gateAddedChecker ? 'checker (gate act, behind the answer)' : 'no checker'];
  return {
    ...plan,
    spawnChecker: gateAddedChecker,
    checkerWaitMs: 0,
    leadEffort: 'max',
    council: 'none',
    reason: `${plan.reason} [machine rails: ${rails.join(', ')}]`,
  };
}

// ── Supervisor chats run without the Double Checker (owner 2026-10-06: "the double
// checker when working with project supervisors and fleet supervisors seems to not
// bring any value at all") ──────────────────────────────────────────────────────
// Prod, 7 days to 2026-10-06: 93 owner turns on project-supervisor chats, 90
// checker reconciles, 88 of them changed the answer (46 "Update to an earlier
// answer" addenda + 42 silent rewrites) ~200 s after delivery — mostly re-renders
// of the same ledger facts. A supervisor answers from its own state / board /
// receipt reads, which the checker (a different model without that state) cannot
// verify. Machine wakes already skip it (machinePresetPlan); this extends the same
// rule to HUMAN turns on supervisor-class chats. A Dig-deeper rung (escalation) is an
// explicit ask and keeps its plan. Kill switch SUPERVISOR_CHECKER_SKIP_DISABLED=1.
export function supervisorCheckerSkipDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.SUPERVISOR_CHECKER_SKIP_DISABLED); }

/** A plan for a human turn on a supervisor-class chat: no Double Checker, no checker wait (pure). */
export function withoutSupervisorChecker(plan: DepthPlan): DepthPlan {
  if (!plan.spawnChecker && !plan.checkerWaitMs) return plan;
  return { ...plan, spawnChecker: false, checkerWaitMs: 0, reason: `${plan.reason} [supervisor chat: no Double Checker]` };
}

/**
 * COMPUTE_POLICY_MACHINE_ACT_ENABLED=1 — let a compute_policy ACT plan govern a
 * machine / supervisor turn. DEFAULT OFF (audit 2026-09-26 supervisors-auto-5):
 * the purpose's mode is global and its readiness is earned on HUMAN labels
 * only (no machine-segment label exists), so an act flip must not silently
 * add a full DeepSeek checker at 'max' behind every 'stakes' wake. Until a
 * machine-segment READY stamp exists the plan is DOWNGRADED to shadow.
 */
export function computePolicyMachineActEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.COMPUTE_POLICY_MACHINE_ACT_ENABLED); }

/** A gate_act plan on a machine / supervisor turn → the machine preset, keeping the decision identity (source 'gate_shadow') so the row still pairs. Pure. */
export function shadowMachineAct(plan: DepthPlan, fallback: DepthPlan): DepthPlan {
  if (plan.source !== 'gate_act') return plan;
  return {
    ...fallback,
    ...(plan.decisionId ? { decisionId: plan.decisionId } : {}),
    ...(plan.answers ? { answers: plan.answers } : {}),
    ...(plan.stash ? { stash: plan.stash } : {}),
    mode: 'shadow',
    source: 'gate_shadow',
    reason: `${fallback.reason} (gate act downgraded to shadow on a machine / supervisor turn — COMPUTE_POLICY_MACHINE_ACT_ENABLED unset; was: ${plan.reason})`,
  };
}

/** Whether a machine-triggered run spawns the checker THIS turn: only a gate-ACT plan that survived the rails (pure). */
export function machineGateSpawnsChecker(plan: Pick<DepthPlan, 'source' | 'spawnChecker'>, machineTriggered: boolean): boolean {
  return machineTriggered && plan.source === 'gate_act' && plan.spawnChecker === true;
}

// ── Dig deeper: rungs, chips, ETA ────────────────────────────────────────────
export type NextRung = 'verify' | 'research';

/**
 * Harness-owned wait text per rung (owner 30-d p50s: L2 233 s). Never typed by a model. Byte-identical to the
 * client's `RUNG_ETA_TEXT` (frontend/lib/depth-ux.ts), which re-derives the chip from metadata on reload — the live
 * chip and the reloaded chip must read the same. Research promises NO fixed time (2026-10-20 — deep research has no
 * wall clock, council-dispatch.ts researchNoWallClock: it runs until the council is done or stops responding); the
 * text reads after the chip's "Takes …" tooltip too.
 */
export const ETA_TEXT: Record<NextRung, string> = {
  verify: 'a couple of minutes',
  research: 'as long as it needs — I\u2019ll post it here when it\u2019s ready',
};

/** The research wait while RESEARCH_NO_WALL_CLOCK_DISABLED=1 puts the rung back on its 15-min DepthBudget clock. */
export const RESEARCH_ETA_TEXT_CLOCKED = 'about 20 minutes — I\u2019ll tell you when it\u2019s ready';

/** The live chip's wait text — the no-clock promise only while research really has no clock. */
export function etaTextFor(rung: NextRung): string {
  return rung === 'research' && researchNoWallClockDisabled() ? RESEARCH_ETA_TEXT_CLOCKED : ETA_TEXT[rung];
}

export const DEEPER_FINDINGS_KIND = 'deeper_findings';
export const DEEPER_FINDINGS_TITLE = 'Deeper findings';
export const CHECK_ADDENDUM_KIND = 'check_addendum';
/** Late council findings row (council-late-addendum.ts) — harness-authored, never escalatable. */
export const COUNCIL_ADDENDUM_KIND = 'council_addendum';

/** The metadata.depth shape persisted on every human-turn assistant row (the escalation reads it back). */
export interface DepthMetadata {
  plan: { preset: DepthPreset; spawnChecker: boolean; checkerWaitMs: number; council: DepthPlan['council']; source: DepthPlan['source']; lane?: DepthLane };
  /** the DepthBudget the turn ran under (time bound only — no USD field since 2026-09-27; older rows may still carry `maxUsd` / `enforced`, both ignored) */
  budget: DepthBudget;
  decisionId?: string;
  /** the gate's decision stash (compact: id / answers / mode + backend / backendSpec / stateHash / questionsHash + ok challengers, answers-only) — the escalated / reask / thumbs labels reconstruct the decision from it (audit 2026-09-26 telemetry-readiness-5: the old {id, answers, mode} shape labelled every persisted-row signal as backend 'unknown' with no challenger row) */
  decision?: { id: string; answers: Record<string, unknown>; mode: DepthPlan['mode'] } & Record<string, unknown>;
  /** turn ledger at finalize (USD) — a RECORD only; nothing is refused on it (owner 2026-09-27: no cost caps) */
  spentUsd?: number;
  /**
   * Rungs run for this message. Audit 2026-09-26: a rung is stamped `running`
   * at run START (so a re-tap while it runs is refused and a deploy-killed
   * rung reads 'interrupted', never silently re-offered), `done` at finalize
   * with the rung's OWN spend (the per-message budget sums them), or
   * `interrupted` by the deploy ritual. A legacy entry with no status is done.
   */
  escalations?: Array<{ rung: NextRung; at: string; messageId?: string; status?: 'running' | 'done' | 'interrupted'; spentUsd?: number }>;
  /**
   * cp/labels (2026-09-26): what the finalized turn measurably did (the
   * checker-route vocabulary) — persisted so the LATER labels (reask_5m /
   * thumbs / a late tap) can derive the same depth actual the finalize row
   * did. `checkerMerged` is as of finalize; a late 'checked' / 'updated'
   * pill upgrades it at label time (factsFromDepthMetadata).
   */
  facts?: DepthTurnFacts;
  /**
   * Dynamic roster phase 2 (2026-10-03): the turn_plan record — lane, act,
   * lane probabilities, traits, the would-be roster and the decision stash
   * (platform/turn-plan.ts turnPlanMetadata). The Dig-deeper tap / re-ask /
   * thumbs / window-close labels read it (chat-agent/turn-plan-labels.ts);
   * the window closer stamps `windowClosedAt` on it.
   */
  turnPlan?: Record<string, unknown>;
}

/** The persisted turn facts (mirrors platform/decision-outcome-labels ComputePolicyTurnFacts — kept here so the leaf stays import-free). */
export interface DepthTurnFacts {
  leadToolCalls: number; webToolCalls: number; finalChars: number; checkerSpawned: boolean; checkerMerged: boolean;
  /** The reasoning_effort the checker ACTUALLY received (audit 2026-09-26 budgets-cost-2: budget.checkerEffort is what the plan implies, not what was sent). */
  checkerEffortSent?: 'high' | 'max';
  /** H2 (2026-09-26): the research rung's council lead reached `budget.maxBackgroundMs` and answered through the FINAL-TURN collapse (absent ⇒ the bound never fired). */
  backgroundDeadlineHit?: boolean;
}

export function depthMetadataFor(plan: DepthPlan, budget: DepthBudget, spentUsd?: number, facts?: DepthTurnFacts | null, turnPlan?: Record<string, unknown> | null): DepthMetadata {
  return {
    plan: { preset: plan.preset, spawnChecker: plan.spawnChecker, checkerWaitMs: plan.checkerWaitMs, council: plan.council, source: plan.source, ...(plan.lane ? { lane: plan.lane } : {}) },
    budget,
    ...(plan.decisionId ? { decisionId: plan.decisionId } : {}),
    // The compact stash (challengers bounded) carries the SEGMENT too (audit 2026-09-26), so a tap / re-ask / thumbs label months later still stamps meta.segment.
    ...(plan.decisionId && plan.answers ? { decision: (compactDecisionStash(plan.stash ? { ...plan.stash, ...(plan.segment && !plan.stash.segment ? { segment: plan.segment } : {}) } : null) as DepthMetadata['decision'] | null) ?? { id: plan.decisionId, answers: plan.answers, mode: plan.mode, ...(plan.segment ? { segment: plan.segment } : {}) } } : {}),
    ...(typeof spentUsd === 'number' && Number.isFinite(spentUsd) ? { spentUsd } : {}),
    ...(facts ? { facts } : {}),
    ...(turnPlan ? { turnPlan } : {}),
  };
}

/**
 * A decision stash → the compact shape persisted on a message row
 * (metadata.check.verdict.decision for revision_material): the identity +
 * answers the label writers need, minus the challenger payloads (pure; null
 * when unusable). Never throws.
 */
/** How many ok challengers a persisted compact stash keeps (answers only — the row must stay small). */
export const COMPACT_STASH_MAX_CHALLENGERS = 3;
export function compactDecisionStash(stash: unknown): Record<string, unknown> | null {
  const s = stash as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || !s.answers || typeof s.answers !== 'object') return null;
  const out: Record<string, unknown> = { id: s.id, answers: s.answers };
  for (const k of ['purpose', 'mode', 'backend', 'decidedAt', 'calibrated', 'stateHash', 'questionsHash', 'backendSpec', 'segment'] as const) {
    if (s[k] !== undefined && s[k] !== null) out[k] = s[k];
  }
  // The ok CHALLENGERS ride too (audit 2026-09-26 telemetry-readiness-5), bounded and
  // answers-only — exactly what decision-gate reconstructChallenger accepts — so a
  // label written from the persisted row emits the per-challenger outcome row.
  const challengers = Array.isArray(s.challengers) ? (s.challengers as any[]) : [];
  const kept = challengers
    .filter(c => c && typeof c === 'object' && typeof c.id === 'string' && typeof c.spec === 'string' && c.answers && typeof c.answers === 'object')
    .slice(0, COMPACT_STASH_MAX_CHALLENGERS)
    .map(c => ({ id: c.id, spec: c.spec, answers: c.answers, ...(typeof c.backend === 'string' ? { backend: c.backend } : {}), ...(typeof c.calibrated === 'boolean' ? { calibrated: c.calibrated } : {}), ...(typeof c.modelId === 'string' ? { modelId: c.modelId } : {}) }));
  if (kept.length) out.challengers = kept;
  return out;
}

// ── Dig-deeper rungs as LANE steps (roster 2026-10-06 A-4) ───────────────────
// The ladder is quick / standard → checked → research: a rung runs the NEXT lane
// up ('verify' = the checked lane: Level 2 + the Double Checker; 'research' = the
// council). The rung names stay the wire contract (chips, metadata.depth
// .escalations, the client's RUNG_ETA_TEXT). A plan's lane is its own `lane`
// when the turn plan set it, else the preset's alias — so every pre-lane row
// reads exactly as before. LANE_RUNGS_DISABLED=1 restores the preset reading.

export type DepthLane = 'quick' | 'standard' | 'checked' | 'research';

/** LANE_RUNGS_DISABLED=1 — nextRungForMessage / nextRungForPlan read the preset + spawnChecker again (the pre-2026-10-06 logic). */
export function laneRungsDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.LANE_RUNGS_DISABLED); }

/** The lane a (persisted or live) plan ran: its own lane, else the preset alias (Level 3 ⇒ research; a checker ⇒ checked; else standard). Pure. */
export function planLane(plan: { preset?: unknown; spawnChecker?: unknown; lane?: unknown } | null | undefined): DepthLane {
  const l = plan?.lane;
  if (l === 'quick' || l === 'standard' || l === 'checked' || l === 'research') return l;
  if (plan?.preset === 'deep_research' || plan?.preset === 'deep_research_all') return 'research';
  return plan?.spawnChecker === true ? 'checked' : 'standard';
}

/** The rung after a lane (pure): quick / standard → 'verify' (the checked lane), checked → 'research', research → none. */
export function nextLaneRung(lane: DepthLane): NextRung | null {
  if (lane === 'research') return null;
  if (lane === 'checked') return 'research';
  return 'verify';
}

/**
 * The next rung NOT yet spent on a persisted assistant message (pure):
 *   - a council answer (preset deep_research / lane research, or a research escalation) has no next rung;
 *   - a checked answer (lane checked / checker spawned / thinking preset / a verify escalation) ⇒ research;
 *   - an unchecked answer (lane quick / standard) ⇒ verify.
 * Reads metadata.depth first, then the legacy metadata.mode.
 */
export function nextRungForMessage(metadata: unknown): NextRung | null {
  const meta = (metadata && typeof metadata === 'object') ? metadata as Record<string, any> : {};
  const depth = (meta.depth && typeof meta.depth === 'object') ? meta.depth as Partial<DepthMetadata> : undefined;
  const escalations = Array.isArray(depth?.escalations) ? depth!.escalations! : [];
  if (meta.kind === DEEPER_FINDINGS_KIND) return null; // never escalate a deeper-findings message itself
  if (meta.kind === CHECK_ADDENDUM_KIND) return null; // an addendum corrects an earlier turn — escalate THAT row (audit 2026-09-26 sse-ui-restore-6)
  if (meta.kind === COUNCIL_ADDENDUM_KIND) return null; // late council findings — escalate the ANSWER row, never the addendum (c7d5f885)
  // A rung still RUNNING is not spent, but a second tap on it would double-spend
  // the quota (audit 2026-09-26 routing-unify-4): refuse until it settles.
  if (escalations.some(e => e?.status === 'running')) return null;
  if (!laneRungsDisabled()) {
    const spentRung = (rung: NextRung) => escalations.some(e => e?.rung === rung && e?.status !== 'interrupted');
    if (spentRung('research')) return null;
    const lane = depth?.plan ? planLane(depth.plan) : planLane({ preset: String(meta.mode ?? 'single_thinking'), spawnChecker: meta.mode === 'thinking' });
    // A spent verify rung already ran the checked lane on this question.
    return nextLaneRung(spentRung('verify') && (lane === 'quick' || lane === 'standard') ? 'checked' : lane);
  }
  const preset: string = depth?.plan?.preset ?? String(meta.mode ?? 'single_thinking');
  if (preset === 'deep_research' || preset === 'deep_research_all') return null;
  const spent = (rung: NextRung) => escalations.some(e => e?.rung === rung && e?.status !== 'interrupted');
  if (spent('research')) return null;
  const checked = depth?.plan ? depth.plan.spawnChecker === true : preset === 'thinking';
  if (checked || spent('verify')) return 'research';
  return 'verify';
}

/**
 * The rung the NEXT tap would run after THIS turn's plan (chip at finalize; pure).
 * `plan.council === 'background'` no longer counts as a council that RAN (audit
 * 2026-09-26 routing-unify-3: nothing in the harness consumes it, so a gate_act
 * research_request used to lose the Dig-deeper chip AND get no council); only
 * the L3 preset or a research escalation exhausts the ladder.
 */
export function nextRungForPlan(plan: Pick<DepthPlan, 'preset' | 'spawnChecker' | 'source' | 'council'> & { lane?: DepthPlan['lane'] }, escalationRung?: NextRung): NextRung | null {
  if (escalationRung === 'research') return null;
  if (!laneRungsDisabled()) return nextLaneRung(escalationRung === 'verify' && planLane(plan) !== 'research' ? 'checked' : planLane(plan));
  if (plan.preset === 'deep_research') return null;
  if (plan.spawnChecker || escalationRung === 'verify') return 'research';
  return 'verify';
}

/**
 * Everything spent on ONE message so far (USD): the original turn's finalize
 * spend plus every rung run on it (audit 2026-09-26 budgets-cost-1 — the
 * next-rung refusal used to read the stale lead-only snapshot). Pure.
 */
export function messageSpentUsd(metadata: unknown): number {
  const meta = (metadata && typeof metadata === 'object') ? metadata as Record<string, any> : {};
  const depth = (meta.depth && typeof meta.depth === 'object') ? meta.depth as Partial<DepthMetadata> : undefined;
  let total = Number(depth?.spentUsd);
  if (!Number.isFinite(total)) total = 0;
  for (const e of (Array.isArray(depth?.escalations) ? depth!.escalations! : [])) {
    const v = Number(e?.spentUsd);
    if (Number.isFinite(v) && v > 0) total += v;
  }
  return total;
}

export type DepthChip =
  | { kind: 'escalate'; label: 'Dig deeper'; escalationOf: string; nextRung: NextRung; etaText: string }
  | { kind: 'signin_deeper'; label: 'Sign in for a deeper look' };

export interface ChipInput {
  guest: boolean;
  machine: boolean;
  messageId: string | null;
  nextRung: NextRung | null;
  disabled?: boolean;
}

/** The ONE depth chip appended server-side on human turns (pure): escalate / signin_deeper / none. */
export function depthChipFor(i: ChipInput): DepthChip | null {
  if (i.disabled || i.machine) return null;
  if (i.guest) return { kind: 'signin_deeper', label: 'Sign in for a deeper look' };
  if (!i.messageId || !i.nextRung) return null;
  return { kind: 'escalate', label: 'Dig deeper', escalationOf: i.messageId, nextRung: i.nextRung, etaText: etaTextFor(i.nextRung) };
}

/**
 * GET /session/:id/state (guest resume): the guest's depth chip attached to
 * the LAST assistant message of the session history (pure; the same chip the
 * live turn sent — `signin_deeper`, or none under DIG_DEEPER_DISABLED=1). Other
 * messages pass through untouched; an empty history stays empty.
 */
export function attachGuestStateChips<M extends { role: string; content: string }>(messages: M[], opts: { disabled?: boolean } = {}): Array<M & { chips?: DepthChip[] }> {
  const chip = depthChipFor({ guest: true, machine: false, messageId: null, nextRung: null, disabled: opts.disabled ?? digDeeperDisabled() });
  if (!chip) return messages;
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') { last = i; break; }
  if (last < 0) return messages;
  return messages.map((m, i) => (i === last ? { ...m, chips: [chip] } : m));
}

/**
 * THE plan an escalation run executes (source 'escalation'; pure) — the ONE
 * escalation resolver since the 2026-09-26 audit (the gate's duplicate with a
 * different shape was deleted). The controller has already refused guests /
 * quota / exhausted messages, so every plan here is RUNNABLE and carries its
 * `rung` — platform/depth-budget.ts `depthBudgetFor` reads an escalation
 * plan's budget from `rung` alone ('verify' ⇒ checker, 'research' ⇒ council),
 * and the controller derives the run MODE from `.preset` (research ⇒ the
 * deep_research preset = the inline council on the tapper's stream).
 */
export function escalationPlan(rung: NextRung, stakesBoundMs: number): DepthPlan {
  // Roster 2026-10-06 A-4: each rung records the LANE it runs (verify = checked, research = research); LANE_RUNGS_DISABLED=1 drops the field.
  const lane = (l: DepthLane) => (laneRungsDisabled() ? {} : { lane: l });
  return rung === 'research'
    ? { preset: 'deep_research', spawnChecker: false, checkerWaitMs: 0, leadEffort: 'max', council: 'background', reason: 'Dig deeper: research rung', source: 'escalation', mode: 'off', rung, ...lane('research') }
    : { preset: 'thinking', spawnChecker: true, checkerWaitMs: stakesBoundMs, leadEffort: 'max', council: 'none', reason: 'Dig deeper: verify rung', source: 'escalation', mode: 'off', rung, ...lane('checked') };
}

/** The harness note the escalation run's user message carries (never persisted as a user row). */
export function escalationUserNote(rung: NextRung): string {
  return rung === 'research'
    ? '[DIG DEEPER — the user asked for a deeper look at your earlier answer to this question. Lead the research council on it now: verify the earlier answer\'s key claims against primary sources, challenge its underlying assumptions (not just its facts), correct what was wrong, add what was missing. Write "Deeper findings" as a complete stand-alone answer.]'
    : '[DIG DEEPER — the user asked for a second look at your earlier answer to this question. Re-verify its key claims with live evidence and the Double Checker\'s draft, correct what was wrong, add what was missing. Write "Deeper findings" as a complete stand-alone answer.]';
}



/**
 * The escalations ledger after ONE rung event (pure): a `running` stamp at
 * run start (replacing a stale running/interrupted entry for the same rung),
 * `done` (+ spend) at finalize, `interrupted` from the deploy ritual — each
 * replaces the rung's running entry rather than appending a second row.
 */
export function stampEscalation(
  escalations: unknown,
  entry: { rung: NextRung; at: string; status: 'running' | 'done' | 'interrupted'; messageId?: string; spentUsd?: number },
): NonNullable<DepthMetadata['escalations']> {
  const list = (Array.isArray(escalations) ? escalations : []).filter((e): e is NonNullable<DepthMetadata['escalations']>[number] => !!e && typeof e === 'object' && typeof (e as any).rung === 'string');
  const idx = list.findIndex(e => e.rung === entry.rung && e.status !== 'done');
  const next = { rung: entry.rung, at: entry.at, status: entry.status, ...(entry.messageId ? { messageId: entry.messageId } : {}), ...(typeof entry.spentUsd === 'number' && Number.isFinite(entry.spentUsd) ? { spentUsd: Number(entry.spentUsd.toFixed(4)) } : {}) };
  if (idx >= 0) { const out = [...list]; out[idx] = { ...list[idx], ...next }; return out; }
  return [...list, next];
}

// ── DepthBudget ──────────────────────────────────────────────────────────────
// (`budgetExceeded` / `budgetRefusalMessage` — the per-message USD refusal and
// the FINAL-TURN spend hook — were DELETED 2026-09-27: owner directive "no cost
// caps anywhere in the framework unless set by a user at the project settings
// level". Only the wall-clock rail below remains.)

/**
 * The research rung's wall-clock rail (audit H2, 2026-09-26): the council
 * that a Dig-deeper tap convenes runs INLINE on the tapper's stream (the
 * controller sets mode='deep_research'; `plan.council:'background'` has no
 * detached consumer), so `DepthBudget.maxBackgroundMs` is enforced through the
 * existing FINAL-TURN deadline (`coding/agent.ts` `profile.runDeadlineMs`):
 * the lead's deadline is the budget itself, and a colleague / clone dispatched
 * `elapsedMs` into the run gets what is LEFT of it (floor 60 s — the same
 * floor `depthBudgetMaxBackgroundMs` clamps to — so a late dispatch still
 * writes a report instead of dying on step 1). The council's own runaway
 * backstop (`backstopMs`) stays the ceiling. Disabled ⇒ the backstop, i.e.
 * the previous behaviour. Pure. Since 2026-10-20 the chat-agent consults it ONLY under
 * RESEARCH_NO_WALL_CLOCK_DISABLED=1 — deep research has no wall clock (council-dispatch.ts researchNoWallClock).
 */
export const RESEARCH_RUNG_DEADLINE_FLOOR_MS = 60_000;
export function researchRungDeadlineMs(
  backstopMs: number,
  budget: Pick<DepthBudget, 'maxBackgroundMs'>,
  elapsedMs = 0,
  disabled = researchRungBudgetDisabled(),
): number {
  if (disabled) return backstopMs;
  const max = Number(budget.maxBackgroundMs);
  if (!Number.isFinite(max) || max <= 0) return backstopMs;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return Math.min(backstopMs, Math.max(RESEARCH_RUNG_DEADLINE_FLOOR_MS, Math.floor(max - elapsed)));
}
