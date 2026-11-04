/**
 * Compute-policy gate (2026-09-26, docs/DEPTH_UX_SOTA_2026-09-26.md §4 —
 * Module A of the depth-UX program). The outcome-driven compute policy that
 * replaces "pick a level before evidence exists": every human send starts as
 * the PRESET plan the controller resolved (L1 / L2 / L3 tuples survive as
 * presets) and this module asks the decision seat — a calibrated Jev-class
 * decision model, one prefill, zero output tokens — WHERE to add compute:
 *
 *   D0 at send (`decideComputePlan`, purpose `compute_policy`):
 *     depth            choice {simple_lookup, ordinary, contestable, unclear}
 *     stakes           noul — money / health / legal / irreversible
 *     needs_live_web   noul — the answer depends on live web facts
 *     research_request noul — the user asked for a research job
 *     state = message ≤ 4k + the last two user turns ≤ 1k each + attachment
 *     count + this chat's prior rung / escalation count (`priorRung` /
 *     `priorEscalations` — carried on EVERY ask, not only on an escalation;
 *     review 2026-09-26). Bounded by
 *     COMPUTE_POLICY_TIMEOUT_MS (1200 ms) — the user is waiting for the first
 *     token, so the caller flushes headers first and the ask never blocks
 *     longer than that.
 *   D1 first answer ready (`decideDraftsAgree`, purpose `drafts_agree`):
 *     agree noul over lead final ≤ 3k + checker draft ≤ 3k.
 *   D1b reconcile landed (`decideRevisionMaterial`, purpose `revision_material`):
 *     a DETERMINISTIC diff first (numbers, times, dates, named entities,
 *     negations, recommendation verbs — `revisionMaterialDeterministic`;
 *     markdown structure, list markers, hh:mm ⇄ am/pm, spaced currency
 *     grouping and sentence-initial capitals are NOT changes since the
 *     2026-09-26 audit; since the 2026-10-06 audit (T6-1) UTC stamps / ISO
 *     timestamps / ids / pronoun contractions are not claims either —
 *     `REVISION_DIFF_STAMP_NOISE_DISABLED=1` — and (T6-2) a diff is material
 *     only when it CONTRADICTS the previous answer, additions-only is not —
 *     `REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED=1`); the gate DECIDES only when the diff says unchanged (the
 *     fallback is today's behaviour: material ⇒ rewrite). In SHADOW a
 *     diff-decided reconcile ALSO asks the gate for the row alone (audit
 *     gate-runtime-4: the diff fired on every real reconcile, so the purpose
 *     had zero rows and could never be calibrated) — the ask never changes the
 *     verdict, and is deferred off the inline swap path (`deferShadowAsk` → the
 *     verdict's `pending`).
 *
 * ACT contract (owner-approved 2026-09-26; thresholds env-overridable through
 * the decision-gate helpers — DECISION_GATE_THRESHOLD_COMPUTE_POLICY[_<OPTION>]):
 *   depth simple_lookup ≥ 0.85 ∧ stakes ≤ 0.15          ⇒ spawnChecker = false
 *   stakes ≥ 0.85 ∧ depth contestable ≥ 0.70            ⇒ checkerWaitMs = STAKES_WAIT_MS (90 s), leadEffort 'max'
 *   research_request ≥ 0.85 ∧ !guest ∧ allowDeepResearch ⇒ council 'background'
 *     (RESEARCH_REQUEST_AUTOSTART_DISABLED=1 kills that rule alone)
 *   otherwise the preset plan.
 * In SHADOW the plan EQUALS the preset and carries decisionId / answers /
 * mode so the labels (decision-outcome-labels.ts labelComputePolicyOutcome)
 * pair by decisionId. OFF / uncalibrated (decide() returns mode 'shadow') /
 * error / timeout ⇒ the preset plan. `decideComputePlan` NEVER throws.
 *
 * Escalation ("Dig deeper", `escalationOf`): the user asked for the NEXT rung
 * explicitly — the gate is not consulted; the plan is the next rung not yet
 * spent on that message (L1 → L2-class verify; L2 → background council for a
 * signed-in user within quota) with source 'escalation' and `rung` set. A
 * REFUSED escalation (guest / quota / no rung left) is a NON-RUNNABLE plan
 * (review 2026-09-26): `refused` names why, `rung` is null, spawnChecker is
 * false and council is 'none'; depthBudgetFor reads checker / council from
 * `rung` on an escalation plan, so a consumer that runs a refused plan
 * re-spends nothing — the refusal is structured, never only the `reason` text.
 *
 * Kill switches: COMPUTE_POLICY_DISABLED=1 (this module returns presets and
 * never asks; drafts_agree / revision_material answer null / fallback), plus
 * the gate-wide DECISION_GATE_DISABLED and the per-purpose modes. Hard rails
 * live in depth-budget.ts (one checker + one council per message, maxUsd).
 *
 * LEAF: imports decision-gate (+ loop-metrics for the one telemetry row) only.
 * Never a model-prose status string — `reason` is a code-composed audit
 * string, never shown to users (the UI reads progress.key from a fixed set).
 */

import logger from '../../../utils/logger';
import {
  decide, decisionMode, decisionOptionThreshold, decisionThreshold, stashDecision,
  type DecideResult, type DecisionAnswer, type DecisionMode, type DecisionQuestion, type DecisionStash,
} from './decision-gate';
import { depthBudgetFor, type DepthBudget } from './depth-budget';
import { LOOP_METRIC_KINDS, recordLoopMetric, type MetricStamp } from './loop-metrics.service';
import { skipRetiredHumanAsk } from './human-turn-retirement';

// ── Contract ─────────────────────────────────────────────────────────────────

export type DepthPreset = 'single_thinking' | 'thinking' | 'deep_research';
export const DEPTH_PRESETS: readonly DepthPreset[] = ['single_thinking', 'thinking', 'deep_research'];

/**
 * 'turn_plan' / 'lane_fail_open' (roster 2026-10-06 A-2 / A-4, platform/lane-depth.ts): the turn plan's LANE set the
 * checker (standard ⇒ none, checked ⇒ one), or the lane fail-open ran "standard on the seat" because the turn plan had
 * no usable answer. Both are human plain-chat turns on the per-feature canary / act flag.
 */
export type DepthPlanSource = 'preset' | 'gate_shadow' | 'gate_act' | 'escalation' | 'turn_plan' | 'lane_fail_open';

/** The rung a "Dig deeper" tap runs: L1 → 'verify' (L2-class check), L2 → 'research' (background council), L3 → null (nothing left). */
export type NextRung = 'verify' | 'research' | null;

export interface DepthPlan {
  preset: DepthPreset;
  spawnChecker: boolean;
  /** 0, or ≤ STAKES_WAIT_MS on the stakes path (the ONLY blocking path). */
  checkerWaitMs: number;
  leadEffort: 'high' | 'max';
  /** An ADDITIONAL background council beyond the preset (the deep_research preset runs its council inline as today). */
  council: 'none' | 'background';
  /** Code-composed audit string (never shown to users). */
  reason: string;
  source: DepthPlanSource;
  decisionId?: string;
  /** The gate's mode for this turn ('off' when it was not asked). */
  mode: DecisionMode;
  /** The gate's raw answers (DecisionAnswer per question) — for labels / telemetry. */
  answers?: Record<string, unknown>;
  /** The decision stash (id / mode / backend / answers) so a later label pairs by decisionId — additive to the shared contract. */
  stash?: DecisionStash;
  /** 2026-09-26 (audit): the sender segment the gate was asked for (computeSegmentOf) — persisted with the compact decision (metadata.depth.decision) so every deferred label's outcome row carries meta.segment. Absent when the gate was not asked. */
  segment?: ComputeSegment;
  /** Escalation plans (source 'escalation') only: the rung this plan runs (compute-policy-wiring escalationPlan — the ONE escalation resolver; the controller owns every refusal). */
  rung?: NextRung;
  /** Dynamic roster (2026-10-03): set when turn_plan in ACT routed this turn to the Quick lane (the Quick answers seat, thinking off, no checker).
   *  Roster 2026-10-06 (Team A): also the lane a lane-governed turn RAN — 'standard' / 'checked' (source 'turn_plan' /
   *  'lane_fail_open') and the Dig-deeper rung plans ('checked' = the verify rung, 'research' = the research rung). */
  lane?: 'quick' | 'standard' | 'checked' | 'research';
}

/** Who sent the turn the plan is for (2026-09-26): 'supervisor' = a fleet / project supervisor chat (human-typed OR a machine wake), 'machine' = any other machine-triggered run, else user / guest. Rides the state (`sender_segment`, machine + supervisor only) and the compute_policy telemetry row so the readiness ruler can partition. */
export type ComputeSegment = 'user' | 'guest' | 'supervisor' | 'machine' | 'telegram';
export const COMPUTE_SEGMENTS: readonly ComputeSegment[] = ['user', 'guest', 'supervisor', 'machine', 'telegram'];

export interface ComputePlanInput {
  message: string;
  priorUserTurns: string[];
  attachmentCount: number;
  chatId?: string;
  userId?: string;
  guest: boolean;
  /** 2026-09-26 (owner: "default all chats to auto even supervisors"): the turn is a MACHINE-triggered run (schedule / hook / agent / webhook wake). Stamped on the state and the row; the harness applies the machine rails to the returned plan (compute-policy-wiring applyMachineRails). */
  machine?: boolean;
  /** Sender segment (see ComputeSegment). Absent ⇒ derived: guest ? 'guest' : 'user'. */
  segment?: ComputeSegment;
  /** The preset fallback the controller resolved (a PatienceMode; legacy ids normalise). */
  requestedMode: string;
  allowDeepResearch: boolean;
  sessionId?: string;
  /** This chat's prior rung — the preset the previous assistant turn ran at (gate state on EVERY ask; omit on a fresh chat). */
  priorRung?: DepthPreset;
  /** How many "Dig deeper" escalations this chat has seen so far (gate state on EVERY ask; 0 on a fresh chat). */
  priorEscalations?: number;
}

export const COMPUTE_POLICY_PURPOSE = 'compute_policy' as const;
export const DRAFTS_AGREE_PURPOSE = 'drafts_agree' as const;
export const REVISION_MATERIAL_PURPOSE = 'revision_material' as const;

/** Request-path bound for the D0 ask (the user is waiting for the first token). */
export const COMPUTE_POLICY_TIMEOUT_MS = 1200;
/** D1 / D1b bounds — off the first-token path but on the path to the check pill. */
export const DRAFTS_AGREE_TIMEOUT_MS = 2500;
export const REVISION_MATERIAL_TIMEOUT_MS = 2500;

export const COMPUTE_POLICY_MESSAGE_CHARS = 4000;
export const COMPUTE_POLICY_PRIOR_TURN_CHARS = 1000;
export const COMPUTE_POLICY_PRIOR_TURNS = 2;
export const DRAFT_TEXT_CHARS = 3000;

/** Owner decision 2026-09-26: the stakes wait bound (STAKES_WAIT_MS env; default 90 s; clamped 0..300 s). */
export const STAKES_WAIT_MS_DEFAULT = 90_000;
export const STAKES_WAIT_MS_MAX = 300_000;

/** Contract thresholds (each overridable: DECISION_GATE_THRESHOLD_COMPUTE_POLICY_<OPTION>, then the purpose env, then these). */
export const COMPUTE_POLICY_SIMPLE_THRESHOLD = 0.85;
export const COMPUTE_POLICY_STAKES_THRESHOLD = 0.85;
export const COMPUTE_POLICY_CONTESTABLE_THRESHOLD = 0.7;
export const COMPUTE_POLICY_RESEARCH_THRESHOLD = 0.85;
/** stakes ≤ 0.15 ⇔ the stakes noul sits on the LOW side of the 0.85 bar. */
export const COMPUTE_POLICY_LOW_STAKES_MAX = 0.15;
export const DRAFTS_AGREE_DEFAULT_THRESHOLD = 0.8;
export const REVISION_MATERIAL_DEFAULT_THRESHOLD = 0.85;

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** COMPUTE_POLICY_DISABLED=1 — presets only; no ask on any of the three purposes. */
export function computePolicyDisabled(): boolean {
  return onFlag(process.env.COMPUTE_POLICY_DISABLED);
}

/**
 * Whether a confident research_request may mark a plan `council:'background'`.
 * DEFAULT OFF since the 2026-09-26 audit (routing-unify-3 / budgets-cost-3 /
 * docs-drift-2): NO harness path consumes `council:'background'` — in act the
 * rule only suppressed the Dig-deeper chip (nextRungForPlan) and made the
 * budget / telemetry / facts label claim a council that never ran. Until a
 * consumer exists (the design's detached "Deeper findings" launcher), the
 * rule is a label-only hint: RESEARCH_REQUEST_AUTOSTART_ENABLED=1 opts back
 * in; RESEARCH_REQUEST_AUTOSTART_DISABLED=1 still forces it off.
 */
export function researchRequestAutostartDisabled(): boolean {
  if (onFlag(process.env.RESEARCH_REQUEST_AUTOSTART_DISABLED)) return true;
  return !onFlag(process.env.RESEARCH_REQUEST_AUTOSTART_ENABLED);
}

/**
 * REVISION_DIFF_STAMP_NOISE_DISABLED=1 — the pre-2026-10-06 de-noised diff (audit 2026-10-06 T6-1): a UTC clock
 * stamp ("00:29Z", "17:31:05Z", "21:02 UTC") reads as a number ("29z"), an ISO timestamp's time part yields junk
 * numbers, digits inside a UUID / hex id read as numbers, "I'm" / "it's" read as entities, and a moved UTC stamp
 * counts as a removed claim in `contradicts`.
 */
export function revisionDiffStampNoiseDisabled(): boolean {
  return onFlag(process.env.REVISION_DIFF_STAMP_NOISE_DISABLED);
}

/**
 * REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED=1 — any deterministic diff entry is material again (audit 2026-10-06
 * T6-2): additions-only diffs (the reconcile adopted the checker's extra detail) and UTC-stamp drift rewrite the
 * delivered answer in place and post the "Update to an earlier answer" addendum after the user moved on.
 */
export function revisionContradictsOnlyDisabled(): boolean {
  return onFlag(process.env.REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED);
}

/** The stakes wait bound (STAKES_WAIT_MS; default 90 000; clamped 0..300 000). */
export function stakesWaitMs(): number {
  const raw = process.env.STAKES_WAIT_MS;
  if (raw === undefined || String(raw).trim() === '') return STAKES_WAIT_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return STAKES_WAIT_MS_DEFAULT;
  return Math.min(STAKES_WAIT_MS_MAX, Math.max(0, Math.floor(n)));
}

/** COMPUTE_POLICY_TIMEOUT_MS override (clamped 300..1200 — the contract's ceiling). */
export function computePolicyTimeoutMs(): number {
  const n = Number(process.env.COMPUTE_POLICY_TIMEOUT_MS);
  if (!Number.isFinite(n)) return COMPUTE_POLICY_TIMEOUT_MS;
  return Math.min(COMPUTE_POLICY_TIMEOUT_MS, Math.max(300, Math.floor(n)));
}

// ── Presets ──────────────────────────────────────────────────────────────────

/** The requested mode → a preset (legacy ids alias forward exactly like normalizePatienceMode; unknown / 'auto' ⇒ the L2 default). */
export function normalizeDepthPreset(mode: unknown): DepthPreset {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'single' || m === 'fast' || m === 'single_thinking') return 'single_thinking';
  if (m === 'deep_research' || m === 'deep_research_all') return 'deep_research';
  return 'thinking';
}

/** Today's tuple for a preset (the fail-open): L1 no checker; L2 one checker, answer-first (wait 0); L3 the inline council, no L2 checker. */
export function presetPlan(preset: DepthPreset, reason = `preset ${preset}`): DepthPlan {
  return {
    preset,
    spawnChecker: preset === 'thinking',
    checkerWaitMs: 0,
    leadEffort: 'high',
    council: 'none',
    reason,
    source: 'preset',
    mode: 'off',
  };
}

// The escalation plan lives in ONE place — chat-agent/compute-policy-wiring.ts
// `escalationPlan(rung)` (2026-09-26 audit routing-unify-2 / docs-drift-15 /
// tests-gaps-8: this module used to carry a second `escalationPlan` with a
// DIFFERENT plan shape — research = the `thinking` preset + council
// 'background' — that no runtime path called; the controller owns every
// refusal (guest / quota / exhausted / budget) before the run starts).

// ── D0 request ───────────────────────────────────────────────────────────────

export const DEPTH_QUESTION = 'depth';
export const STAKES_QUESTION = 'stakes';
export const NEEDS_LIVE_WEB_QUESTION = 'needs_live_web';
export const RESEARCH_REQUEST_QUESTION = 'research_request';

export type ComputeDepth = 'simple_lookup' | 'ordinary' | 'contestable' | 'unclear';
export const COMPUTE_DEPTHS: readonly ComputeDepth[] = ['simple_lookup', 'ordinary', 'contestable', 'unclear'];

/**
 * The state for one send (pure): the typed message, the last two user turns,
 * the attachment count, and — on EVERY ask — this chat's prior rung and
 * escalation count when the consumer knows them (`prior_rung` /
 * `prior_escalations`; a fresh chat carries neither or `prior_escalations: 0`).
 * The escalation path never asks the gate, so nothing here is keyed on
 * `escalationOf` (review 2026-09-26: the old escalation-only fields were dead).
 */
export function computePolicyState(input: ComputePlanInput): Record<string, unknown> {
  const message = String(input.message || '').slice(0, COMPUTE_POLICY_MESSAGE_CHARS);
  const prior = (Array.isArray(input.priorUserTurns) ? input.priorUserTurns : [])
    .filter((t) => typeof t === 'string' && t.trim())
    .slice(-COMPUTE_POLICY_PRIOR_TURNS)
    .map((t) => t.slice(0, COMPUTE_POLICY_PRIOR_TURN_CHARS));
  const attachments = Number.isFinite(input.attachmentCount) ? Math.max(0, Math.floor(input.attachmentCount)) : 0;
  const priorRung = (DEPTH_PRESETS as readonly string[]).includes(String(input.priorRung)) ? (input.priorRung as DepthPreset) : null;
  const priorEscalations = typeof input.priorEscalations === 'number' && Number.isFinite(input.priorEscalations) ? Math.max(0, Math.floor(input.priorEscalations)) : null;
  // 2026-09-26: machine / supervisor senders are NAMED in the state (the gate
  // judges a fleet wake differently from a typed question); a human turn's
  // state is byte-identical to before (no key added ⇒ memo keys unchanged).
  const segment = computeSegmentOf(input);
  return {
    message,
    ...(prior.length ? { prior_user_turns: prior } : {}),
    attachment_count: attachments,
    ...(priorRung ? { prior_rung: priorRung } : {}),
    ...(priorEscalations !== null ? { prior_escalations: priorEscalations } : {}),
    ...(segment === 'machine' || segment === 'supervisor' || segment === 'telegram' ? { sender_segment: segment } : {}),
  };
}

/** The segment for one input (pure): explicit `segment` wins; else machine ⇒ 'machine'; else guest / user. */
export function computeSegmentOf(input: Pick<ComputePlanInput, 'guest' | 'machine' | 'segment'>): ComputeSegment {
  if (input.segment && (COMPUTE_SEGMENTS as readonly string[]).includes(input.segment)) return input.segment;
  if (input.machine) return 'machine';
  return input.guest ? 'guest' : 'user';
}

/** The FOUR questions every compute_policy site asks (text pinned — a rewording resets the questionsHash partition). */
export function computePolicyQuestions(): Record<string, DecisionQuestion> {
  return {
    [DEPTH_QUESTION]: {
      type: 'choice',
      instructions: 'How much independent cross-checking does a correct answer to this message need? When unsure, prefer ordinary.',
      criteria: {
        simple_lookup: 'A short, single-part factual lookup or quick answer whose correctness is easy to verify — one model answers directly; a second opinion adds little',
        ordinary: 'An ordinary question or task — a second model answering in parallel is useful, but the first complete answer can ship and be revised',
        contestable: 'A disputable, multi-part or easy-to-get-wrong question — the answer should be cross-checked before the user acts on it',
        unclear: 'None of the above / cannot tell from the message',
      },
    },
    [STAKES_QUESTION]: {
      type: 'noul',
      instructions: 'Acting on a wrong answer to this message would cost the user real money, health, legal standing, or something irreversible.',
      criteria: {
        true: 'The user is about to make a financial, medical, legal, safety or irreversible decision on the answer',
        false: 'A wrong answer is cheap to notice and cheap to undo — curiosity, drafting, explanation, casual planning',
      },
    },
    [NEEDS_LIVE_WEB_QUESTION]: {
      type: 'noul',
      instructions: 'Answering this message correctly requires live web information.',
      criteria: {
        true: 'The answer depends on time-sensitive, recent, or online-verifiable facts (prices, news, versions, schedules, current status)',
        false: 'The answer follows from stable knowledge or from the conversation itself; nothing needs to be looked up',
      },
    },
    [RESEARCH_REQUEST_QUESTION]: {
      type: 'noul',
      instructions: 'The user is explicitly asking for a research job: a comprehensive report, a literature or market analysis, many cited sources, or a long multi-part brief.',
      criteria: {
        true: 'The message asks for deep research, a full report, a survey of sources, or an exhaustive comparison',
        false: 'The message asks a question or for a task that one careful answer covers',
      },
    },
  };
}

/** The state + questions for one send (pure). */
export function buildComputePolicyRequest(input: ComputePlanInput): { state: Record<string, unknown>; questions: Record<string, DecisionQuestion> } {
  return { state: computePolicyState(input), questions: computePolicyQuestions() };
}

// ── Reading the answers ──────────────────────────────────────────────────────

export interface ComputePolicyReadout {
  depth: ComputeDepth | null;
  depthConfidence: number | null;
  /** P(simple_lookup) / P(contestable) from the choice distribution (the confidence when the option is the choice). */
  pSimple: number | null;
  pContestable: number | null;
  stakes: number | null;
  needsLiveWeb: number | null;
  researchRequest: number | null;
}

const noulOf = (a: DecisionAnswer | undefined): number | null => (a && a.type === 'noul' && Number.isFinite(a.noul) ? a.noul : null);

/** Read the raw answers into numbers (pure; tolerant of missing questions). */
export function readComputePolicyAnswers(answers: Record<string, DecisionAnswer> | undefined | null): ComputePolicyReadout {
  const none: ComputePolicyReadout = { depth: null, depthConfidence: null, pSimple: null, pContestable: null, stakes: null, needsLiveWeb: null, researchRequest: null };
  if (!answers) return none;
  const d = answers[DEPTH_QUESTION];
  let depth: ComputeDepth | null = null;
  let depthConfidence: number | null = null;
  let pSimple: number | null = null;
  let pContestable: number | null = null;
  if (d && d.type === 'choice') {
    depth = (COMPUTE_DEPTHS as readonly string[]).includes(d.choice) ? (d.choice as ComputeDepth) : null;
    depthConfidence = Number.isFinite(d.confidence) ? d.confidence : null;
    const probs = d.probabilities ?? {};
    const pOf = (k: ComputeDepth): number | null => {
      const v = probs[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      return d.choice === k && depthConfidence !== null ? depthConfidence : null;
    };
    pSimple = pOf('simple_lookup');
    pContestable = pOf('contestable');
  }
  return { depth, depthConfidence, pSimple, pContestable, stakes: noulOf(answers[STAKES_QUESTION]), needsLiveWeb: noulOf(answers[NEEDS_LIVE_WEB_QUESTION]), researchRequest: noulOf(answers[RESEARCH_REQUEST_QUESTION]) };
}

/** The acting cutoffs (env-overridable through the decision-gate helpers). */
export function computePolicyThresholds(): { simple: number; stakes: number; contestable: number; research: number; lowStakesMax: number } {
  const simple = decisionOptionThreshold(COMPUTE_POLICY_PURPOSE, 'simple_lookup', COMPUTE_POLICY_SIMPLE_THRESHOLD);
  const stakes = decisionOptionThreshold(COMPUTE_POLICY_PURPOSE, 'stakes', COMPUTE_POLICY_STAKES_THRESHOLD);
  const contestable = decisionOptionThreshold(COMPUTE_POLICY_PURPOSE, 'contestable', COMPUTE_POLICY_CONTESTABLE_THRESHOLD);
  const research = decisionOptionThreshold(COMPUTE_POLICY_PURPOSE, 'research_request', COMPUTE_POLICY_RESEARCH_THRESHOLD);
  // Low stakes ⇔ the noul sits on the low side of the STAKES bar (0.15 at the 0.85 default).
  return { simple, stakes, contestable, research, lowStakesMax: Number((1 - stakes).toFixed(6)) };
}

/**
 * Apply the ACT contract to a preset (pure). Returns the preset unchanged
 * (source untouched) when no rule fires; otherwise the amended plan with
 * source 'gate_act'. `unclear` never acts.
 */
export function applyComputePolicy(preset: DepthPlan, r: ComputePolicyReadout, ctx: { guest: boolean; allowDeepResearch: boolean; autostartDisabled?: boolean }, t = computePolicyThresholds()): DepthPlan {
  const eps = 1e-9;
  const fired: string[] = [];
  let plan: DepthPlan = { ...preset };
  const stakesKnown = r.stakes !== null;
  const lowStakes = stakesKnown && (r.stakes as number) <= t.lowStakesMax + eps;
  const highStakes = stakesKnown && (r.stakes as number) >= t.stakes - eps;
  const confidentSimple = r.depth === 'simple_lookup' && r.pSimple !== null && r.pSimple >= t.simple - eps;
  const contestable = r.pContestable !== null && r.pContestable >= t.contestable - eps;
  const research = r.researchRequest !== null && r.researchRequest >= t.research - eps;

  // Stakes rule first: it dominates (a high-stakes contestable turn always gets its check).
  if (highStakes && contestable && preset.preset !== 'deep_research') {
    plan = { ...plan, spawnChecker: true, checkerWaitMs: stakesWaitMs(), leadEffort: 'max' };
    fired.push(`stakes ${(r.stakes as number).toFixed(2)} ≥ ${t.stakes} ∧ contestable ${(r.pContestable as number).toFixed(2)} ≥ ${t.contestable} → wait ≤ ${plan.checkerWaitMs} ms, effort max`);
  } else if (confidentSimple && lowStakes && preset.preset !== 'deep_research') {
    plan = { ...plan, spawnChecker: false, checkerWaitMs: 0 };
    fired.push(`simple_lookup ${(r.pSimple as number).toFixed(2)} ≥ ${t.simple} ∧ stakes ${(r.stakes as number).toFixed(2)} ≤ ${t.lowStakesMax} → no checker`);
  }
  if (research && !ctx.guest && ctx.allowDeepResearch && !ctx.autostartDisabled && preset.preset !== 'deep_research') {
    plan = { ...plan, council: 'background' };
    fired.push(`research_request ${(r.researchRequest as number).toFixed(2)} ≥ ${t.research} → background council`);
  }
  if (!fired.length) return preset;
  return { ...plan, source: 'gate_act', reason: `decision gate: ${fired.join('; ')} (preset ${preset.preset})` };
}

/** A plan's answers as stored on the plan / the message (the raw DecisionAnswer objects — reconstructDecision reads them back). */
function planAnswers(r: DecideResult): Record<string, unknown> {
  return { ...r.answers };
}

/** Race a promise against a hard deadline (decide() bounds itself too — this is the contract's belt-and-braces). */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms));
    timer.unref?.();
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

/**
 * The DepthPlan for one human send. NEVER throws; never slower than
 * COMPUTE_POLICY_TIMEOUT_MS. Off / disabled / uncalibrated / error / timeout
 * ⇒ the preset plan. Escalation ⇒ the next rung (no ask).
 */
export async function decideComputePlan(input: ComputePlanInput): Promise<DepthPlan> {
  const preset = presetPlan(normalizeDepthPreset(input.requestedMode));
  try {
    if (computePolicyDisabled()) return preset;
    const mode = decisionMode(COMPUTE_POLICY_PURPOSE);
    if (mode === 'off') return preset;
    // roster 2026-10-06 B-2: retired on HUMAN turns (AUROC 0.511 / act-band precision 0.43 on the 2026-10-06 readout;
    // every human turn already ran the preset in shadow) — the preset plan, as OFF returns it, plus one
    // decision_ask_retired row. Only a turn the harness marks machine:false is human; machine wakes keep asking.
    // Kill switches: DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED=1 / DECISION_GATE_COMPUTE_POLICY_HUMAN_RETIRE_LIFTED=1.
    if (input.machine === false && skipRetiredHumanAsk(COMPUTE_POLICY_PURPOSE, { site: 'send', segment: computeSegmentOf(input), sessionId: input.sessionId ?? input.chatId })) return preset;
    const { state, questions } = buildComputePolicyRequest(input);
    const timeoutMs = computePolicyTimeoutMs();
    // The sender segment rides decide() as a ROW stamp (meta.segment on the decision /
    // challenger / outcome rows — the readiness ruler's partition key; audit 2026-09-26
    // supervisors-auto-5 / telemetry-readiness-9), never the state: a human turn's state and
    // memo key stay byte-identical. A guest turn rides the consumer meta (guest-persistence-2).
    const segment = computeSegmentOf(input);
    const r = await withDeadline(
      decide(state, questions, { purpose: COMPUTE_POLICY_PURPOSE, timeoutMs, sessionId: input.sessionId ?? input.chatId, segment, ...(input.guest ? { meta: { guest: true } } : {}) }),
      timeoutMs + 50,
    );
    if (!r) return { ...preset, mode, segment, reason: `${preset.reason} (gate ${mode}: no answer)` };
    const stash = stashDecision(r, COMPUTE_POLICY_PURPOSE) ?? undefined;
    const carried = { decisionId: r.id, answers: planAnswers(r), mode: r.mode, segment, ...(stash ? { stash: { ...stash, segment } } : {}) };
    // E2: the RESULT's mode gates acting — an uncalibrated backend answers as 'shadow'.
    if (r.mode !== 'act') {
      return { ...preset, ...carried, source: 'gate_shadow', reason: `${preset.reason} (gate shadow: ${summarizeReadout(readComputePolicyAnswers(r.answers))})` };
    }
    const acted = applyComputePolicy(preset, readComputePolicyAnswers(r.answers), { guest: input.guest, allowDeepResearch: input.allowDeepResearch, autostartDisabled: researchRequestAutostartDisabled() });
    if (acted === preset) return { ...preset, ...carried, reason: `${preset.reason} (gate act: nothing confident — ${summarizeReadout(readComputePolicyAnswers(r.answers))})` };
    return { ...acted, ...carried };
  } catch (err: any) {
    logger.warn(`compute-policy: decideComputePlan failed (${err?.message || err}) — preset ${preset.preset} stands`);
    return preset;
  }
}

/** One-line audit summary of a readout (never user-facing). */
export function summarizeReadout(r: ComputePolicyReadout): string {
  const f = (v: number | null) => (v === null ? '—' : v.toFixed(2));
  return `depth ${r.depth ?? '—'}@${f(r.depthConfidence)} stakes ${f(r.stakes)} web ${f(r.needsLiveWeb)} research ${f(r.researchRequest)}`;
}

// ── Telemetry ────────────────────────────────────────────────────────────────

/**
 * ONE loop_metrics row per human turn (kind 'compute_policy'): the plan + budget
 * the turn ran under. The ONLY writer of this kind — the harness passes what
 * only it knows through `extra` (guest, escalationRung, check) and its metric
 * stamp. Fire-and-forget; never throws.
 */
export function recordComputePolicyTelemetry(plan: DepthPlan, opts: { sessionId?: string; ttftMs?: number; completionMs?: number; budget?: DepthBudget; stamp?: MetricStamp; extra?: Record<string, unknown> } = {}): void {
  try {
    const budget = opts.budget ?? depthBudgetFor(plan);
    const ttft = typeof opts.ttftMs === 'number' && Number.isFinite(opts.ttftMs) ? Math.round(opts.ttftMs) : undefined;
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.COMPUTE_POLICY,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.stamp ? { stamp: opts.stamp } : {}),
      ...(ttft !== undefined ? { value: ttft, unit: 'ms' } : {}),
      meta: {
        ...(opts.extra ?? {}),
        planSource: plan.source,
        preset: plan.preset,
        spawnChecker: plan.spawnChecker,
        checkerWaitMs: plan.checkerWaitMs,
        council: plan.council,
        leadEffort: plan.leadEffort,
        mode: plan.mode,
        ...(plan.decisionId ? { decisionId: plan.decisionId } : {}),
        ...(ttft !== undefined ? { ttftMs: ttft } : {}),
        ...(typeof opts.completionMs === 'number' && Number.isFinite(opts.completionMs) ? { completionMs: Math.round(opts.completionMs) } : {}),
        budget: { checker: budget.checker, checkerEffort: budget.checkerEffort, council: budget.council, maxBackgroundMs: budget.maxBackgroundMs },
      },
    });
  } catch { /* telemetry never throws */ }
}

// ── D1: drafts_agree ─────────────────────────────────────────────────────────

export const DRAFTS_AGREE_QUESTION = 'agree';

export interface DraftsAgreeInput {
  leadFinal: string; checkerDraft: string; chatId?: string; decisionCtx?: string;
  /** roster 2026-10-06 B-2: false = a HUMAN turn (the ask is retired there); true / absent = asked as before. */
  machine?: boolean;
}

export interface DraftsAgreeVerdict {
  /** null when the gate was off / disabled / failed; otherwise p ≥ τ (consumers act ONLY when mode === 'act'). */
  agree: boolean | null;
  p: number | null;
  mode: DecisionMode;
  decisionId?: string;
  stash?: DecisionStash;
}

/** The state + question (pure). */
export function buildDraftsAgreeRequest(input: DraftsAgreeInput): { state: Record<string, unknown>; questions: Record<string, DecisionQuestion> } {
  const state: Record<string, unknown> = {
    lead_final: String(input.leadFinal || '').slice(0, DRAFT_TEXT_CHARS),
    checker_draft: String(input.checkerDraft || '').slice(0, DRAFT_TEXT_CHARS),
    ...(input.decisionCtx ? { context: String(input.decisionCtx).slice(0, 500) } : {}),
  };
  const questions: Record<string, DecisionQuestion> = {
    [DRAFTS_AGREE_QUESTION]: {
      type: 'noul',
      instructions: 'The lead answer and the independent checker draft agree on every claim, number, date and recommendation that matters to the user.',
      criteria: {
        true: 'Both say the same things — any differences are wording, ordering, length or emphasis',
        false: 'They differ on a fact, a number, a date, a named entity, a yes/no, or what the user should do',
      },
    },
  };
  return { state, questions };
}

/** The drafts_agree acting bar (DECISION_GATE_THRESHOLD_DRAFTS_AGREE; default 0.8). */
export function draftsAgreeThreshold(): number {
  return decisionThreshold(DRAFTS_AGREE_PURPOSE, DRAFTS_AGREE_DEFAULT_THRESHOLD);
}

/** Do the two drafts agree? Never throws; null on off / disabled / error / timeout. */
export async function decideDraftsAgree(input: DraftsAgreeInput): Promise<DraftsAgreeVerdict> {
  const none: DraftsAgreeVerdict = { agree: null, p: null, mode: 'off' };
  try {
    if (computePolicyDisabled()) return none;
    const mode = decisionMode(DRAFTS_AGREE_PURPOSE);
    if (mode === 'off') return none;
    if (!String(input.leadFinal || '').trim() || !String(input.checkerDraft || '').trim()) return { ...none, mode };
    // roster 2026-10-06 B-2: retired on HUMAN turns (near chance on the 2026-10-06 readout, shadow — the reconcile ran
    // regardless) — answers as OFF does (the reconcile runs as today) with one decision_ask_retired row.
    // Kill switches: DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED=1 / DECISION_GATE_DRAFTS_AGREE_HUMAN_RETIRE_LIFTED=1.
    if (input.machine === false && skipRetiredHumanAsk(DRAFTS_AGREE_PURPOSE, { site: 'reconcile', sessionId: input.chatId })) return none;
    const { state, questions } = buildDraftsAgreeRequest(input);
    const r = await withDeadline(decide(state, questions, { purpose: DRAFTS_AGREE_PURPOSE, timeoutMs: DRAFTS_AGREE_TIMEOUT_MS, sessionId: input.chatId }), DRAFTS_AGREE_TIMEOUT_MS + 50);
    if (!r) return { ...none, mode };
    const p = noulOf(r.answers[DRAFTS_AGREE_QUESTION]);
    if (p === null) return { ...none, mode: r.mode, decisionId: r.id };
    const stash = stashDecision(r, DRAFTS_AGREE_PURPOSE) ?? undefined;
    return { agree: p >= draftsAgreeThreshold() - 1e-9, p, mode: r.mode, decisionId: r.id, ...(stash ? { stash } : {}) };
  } catch (err: any) {
    logger.warn(`compute-policy: decideDraftsAgree failed (${err?.message || err}) — reconcile runs as today`);
    return none;
  }
}

// ── D1b: revision_material ───────────────────────────────────────────────────

export const REVISION_MATERIAL_QUESTION = 'material';
/** Bounded list of `changed` entries (compactExtra-friendly). */
export const REVISION_CHANGED_MAX = 12;
export const REVISION_CHANGED_ENTRY_CHARS = 80;

const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
/**
 * A number with its GLUED unit as one token ("200mg", "5%", "10GB", "3rd") or a
 * spaced magnitude word ("5 percent", "2 million"). The glued suffix is ≤ 4
 * letters so a unit-bearing dosage / size compares as one token (review
 * 2026-09-26: "200mg" → "400mg" used to yield NO number at all because the
 * trailing `(?![\w])` rejected a digit run followed by a letter). A spaced
 * ARBITRARY word is deliberately not swallowed ("1,000,000 in 2021" stays
 * "1,000,000") — otherwise a wording change next to a number would read as
 * a number change.
 */
const NUMBER_RE = /(?<![\w.])[$€£¥]?\d[\d,]*(?:\.\d+)?(?:[a-z%]{1,4}|\s?(?:%|percent|k|m|bn|million|billion|thousand))?(?![\w])/gi;
/**
 * The de-noised number token (audit gate-runtime-4, 2026-09-26): a CURRENCY
 * amount may group thousands with a space or NBSP as well as a comma
 * ("$1 200" ⇔ "$1,200" — the reconciler's typographic rewrite used to read
 * as three numbers: -$1200 +$1 +200). Unprefixed numbers keep comma grouping
 * only, so "2021 300 people" stays two numbers.
 */
const NUMBER_DENOISED_RE = /(?<![\w.])(?:[$€£¥]\d{1,3}(?:[,  ]\d{3})+|[$€£¥]?(?:\d{1,3}(?:,\d{3})+|\d+))(?:\.\d+)?(?:[a-z%]{1,4}|\s?(?:%|percent|k|m|bn|million|billion|thousand))?(?![\w])/gi;
/**
 * Clock times as their own kind: "10:00" ⇔ "10 am" ⇔ "10:00 a.m." normalise
 * to the same 24-h token ("17:00" ⇔ "5 pm"), so a reconciler reformatting a
 * time is not a number change ("number: -00" was the most common junk entry
 * in prod `changed[]`), while "10:00" → "11:00" is still material.
 */
const TIME_RE = /(?<![\w:])(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s?([ap])\.?m\.?(?![\w])|(?<![\w:])(\d{1,2}):(\d{2})(?::\d{2})?(?![\w:])/gi;
/**
 * TIME_RE + UTC observation stamps (audit 2026-10-06 T6-1, others.md F3): the 24-h branch also takes an
 * optional `Z` / `UTC` / `GMT` suffix (group 6) and fractional seconds — "(00:29Z)" used to match nothing (the
 * trailing `(?![\w:])` rejected the glued Z), so the number regex read it as "29z" and every supervisor reconcile
 * that re-stamped its reads looked like a changed number. REVISION_DIFF_STAMP_NOISE_DISABLED=1 ⇒ TIME_RE.
 */
const TIME_STAMP_RE = /(?<![\w:])(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s?([ap])\.?m\.?(?![\w])|(?<![\w:])(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(\s?(?:z|utc|gmt))?(?![\w:])/gi;
/** An ISO-8601 timestamp ("2026-10-06T00:29:13.120Z", "2026-10-06T00:29+02:00") — split into its date and clock so each is read by its own kind. */
const ISO_TIMESTAMP_RE = /\b(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2})(?::\d{2}(?:\.\d+)?)?(z|[+-]\d{2}:?\d{2})?(?![\w:])/gi;
/** A UUID — an id, never a set of numbers ("…-1234-…" used to read as the number 1234). */
const UUID_RE = /(?<![0-9a-z])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-z])/gi;
/** A short / long hex id (git sha, run / message / receipt id): 7–40 hex chars with at least one digit AND one a–f letter. */
const HEX_ID_RE = /(?<![0-9a-z])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}(?![0-9a-z])/gi;
/** Pronoun contractions ("I'm", "it's", "we'll") — sentence furniture, never a named entity. */
const PRONOUN_CONTRACTION_RE = /^(?:i|it|you|we|they|he|she|that|there|here|what|who|let)'(?:m|s|ll|ve|d|re)$/;

/**
 * Ids and ISO timestamps out of the way before any extractor runs (pure; audit 2026-10-06 T6-1): an ISO timestamp
 * becomes "<date> <hh:mm>[Z]" (a numeric offset is dropped — the clock still compares), a UUID / hex id is blanked.
 */
function stripStampNoise(s: string): string {
  return s
    .replace(ISO_TIMESTAMP_RE, (_m, date: string, hm: string, tz?: string) => `${date} ${hm}${tz && tz.toLowerCase() === 'z' ? 'Z' : ''}`)
    // "21:02 UTC" ⇔ "21:02Z": the zone word belongs to the clock, never a named entity of its own.
    .replace(/(?<![\w:])(\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s?(?:UTC|GMT)(?![\w:])/gi, '$1Z')
    .replace(UUID_RE, ' ')
    .replace(HEX_ID_RE, ' ');
}
/**
 * Polarity words compared as a MULTISET on their own (no following word
 * needed — review 2026-09-26: "The answer is yes." → "… is no." and "It is
 * safe." → "It is unsafe." used to read as unchanged because `yes` / `no` are
 * entity stopwords and the negation / recommendation bigrams need a next word).
 */
const POLARITY_RE = /\b(?:yes|no|true|false|safe|unsafe|legal|illegal|correct|incorrect|valid|invalid|allowed|prohibited|possible|impossible)\b/gi;
const DATE_RES: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  new RegExp(`\\b${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}(?:\\s+\\d{4})?\\b`, 'gi'),
  new RegExp(`\\b${MONTHS}\\s+\\d{4}\\b`, 'gi'),
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|yesterday|tonight)\b/gi,
];
/** Capitalised tokens that are sentence furniture, not entities. */
const ENTITY_STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'i', 'we', 'you', 'he', 'she', 'they', 'in', 'on', 'at', 'for', 'to', 'of', 'by',
  'if', 'so', 'but', 'and', 'or', 'nor', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will',
  'may', 'might', 'must', 'here', 'there', 'then', 'now', 'also', 'however', 'therefore', 'note', 'yes', 'no', 'not', 'first', 'second', 'third',
  'next', 'finally', 'overall', 'summary', 'answer', 'short', 'long', 'quick', 'key', 'why', 'what', 'when', 'where', 'how', 'who', 'which',
  'with', 'without', 'from', 'into', 'about', 'after', 'before', 'while', 'because', 'since', 'although', 'though', 'yet', 'still', 'both',
  'each', 'every', 'some', 'any', 'all', 'most', 'many', 'much', 'more', 'less', 'other', 'another', 'such', 'one', 'two', 'three', 'ok', 'okay',
  'thanks', 'thank', 'sure', 'yeah', 'good', 'great', 'important', 'update', 'updated', 'correction', 'corrections', 'checked', 'edit',
  'example', 'examples', 'step', 'steps', 'option', 'options', 'tip', 'tips', 'bottom', 'line', 'tl', 'dr', 'tldr', 'in', 'my', 'your', 'our', 'their',
]);
const NEGATION_RE = /\b(?:not|no|never|none|neither|nor|cannot|without|n't)\b/gi;
const RECOMMEND_RE = /\b(?:should|shouldn't|must|mustn't|recommend|recommended|avoid|prefer|suggest|advise|advised|consider|need to|needs to|don't|do not|never|always|safe|unsafe|legal|illegal)\b/gi;

/**
 * Markdown STRUCTURE is not content (audit gate-runtime-4): ordered / bullet
 * list markers ("1." / "2)" / "-" at line start — the "+1 +2 +3" junk when a
 * paragraph becomes a numbered list), heading hashes and table separator rows
 * are removed; table pipes stay as sentence boundaries. Line-aware (runs
 * BEFORE whitespace collapse).
 */
function stripMarkdownStructure(s: string): string {
  return s
    .replace(/^[ \t]*(?:\d{1,3}[.)]|[-*+•])[ \t]+/gm, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^(?=.*-)[ \t|:-]+$/gm, '');
}

/** Quote / contraction / CR normalisation shared by both diff flavours (line-aware; the equality check collapses whitespace separately). */
function prepareText(s: string, denoise: boolean): string {
  const t = String(s || '')
    .replace(/\r/g, '')
    .replace(/(\w)n['’]t\b/gi, '$1 not')
    .replace(/[’‘]/g, "'");
  return denoise ? stripMarkdownStructure(t) : t;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** The pre-audit text normalisation (byte-for-byte: prepare + collapse). */
function normalizeText(s: string): string {
  return collapseWhitespace(prepareText(s, false));
}

function countMap(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

/** Multiset symmetric difference as "+x" / "-x" entries (pure). */
function multisetDiff(prev: string[], next: string[]): string[] {
  const a = countMap(prev);
  const b = countMap(next);
  const out: string[] = [];
  for (const [k, n] of a) { const m = b.get(k) ?? 0; if (m < n) out.push(`-${k}`); }
  for (const [k, n] of b) { const m = a.get(k) ?? 0; if (m < n) out.push(`+${k}`); }
  return out;
}

function matches(re: RegExp, text: string): string[] {
  re.lastIndex = 0;
  return (text.match(re) ?? []).map((m) => m.trim().toLowerCase().replace(/,/g, ''));
}

function numbersOf(text: string, denoise = false, stampAware = false): string[] {
  // Strip the date spans first so "26" inside "Sept 26, 2026" is not double-counted as a bare number.
  let t = text;
  for (const re of DATE_RES) t = t.replace(re, ' ');
  // …and the clock times (their own kind, timesOf) so "10:00" is not the numbers 10 and 00.
  if (denoise) t = t.replace(stampAware ? TIME_STAMP_RE : TIME_RE, ' ');
  return matches(denoise ? NUMBER_DENOISED_RE : NUMBER_RE, t).map((n) => n.replace(/\s+/g, ''));
}

/** One clock time: the normalised 24-h token + whether it carried a UTC suffix (an observation stamp — TIME_STAMP_RE only). */
interface TimeToken { token: string; utc: boolean }

/** Clock times normalised to 24-h "h:mm" ("10 am" = "10:00", "5 pm" = "17:00", "12 am" = "0:00"); malformed hours / minutes are skipped. */
function timeTokensOf(text: string, re: RegExp): TimeToken[] {
  const out: TimeToken[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const meridiem = m[3] ? m[3].toLowerCase() : null;
    let h = Number(meridiem ? m[1] : m[4]);
    const mm = Number((meridiem ? m[2] : m[5]) ?? '0');
    if (!Number.isFinite(h) || !Number.isFinite(mm) || mm > 59 || h > 24 || (meridiem && h > 12)) continue;
    if (meridiem === 'p' && h < 12) h += 12;
    if (meridiem === 'a' && h === 12) h = 0;
    out.push({ token: `${h}:${String(mm).padStart(2, '0')}`, utc: !meridiem && !!m[6] });
  }
  return out;
}

function timesOf(text: string): string[] {
  return timeTokensOf(text, TIME_RE).map((t) => t.token);
}

function datesOf(text: string): string[] {
  const out: string[] = [];
  for (const re of DATE_RES) out.push(...matches(re, text).map((d) => d.replace(/\s+/g, ' ')));
  return out;
}

/** Bare polarity tokens (yes / no / true / false / safe / unsafe / legal / illegal …) — a flip is material even with no word after it. */
function polarityOf(text: string): string[] {
  return matches(POLARITY_RE, text);
}

/**
 * Is the token at `idx` the first word of a sentence / line / list item /
 * heading / table cell? Walks back over whitespace, markdown emphasis, quotes,
 * brackets, dashes and pipes; a preceding `. ! ? : ;` (a list marker's dot
 * included), a newline or the start of the text says yes.
 */
function isSentenceInitial(text: string, idx: number): boolean {
  for (let i = idx - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '\n') return true;
    if (/[ \t#*_>|"“”‘'(\[\-–—•]/.test(ch)) continue;
    if (ch === ')') {
      // "3) Foo" — an ordered-list marker at line start; any other ")" is mid-sentence.
      let j = i - 1;
      while (j >= 0 && /\d/.test(text[j])) j--;
      if (j < i - 1 && (j < 0 || text[j] === '\n')) return true;
      return false;
    }
    return /[.!?:;]/.test(ch);
  }
  return true;
}

interface EntityTokens { full: string[]; initial: string[] }

/**
 * Capitalised tokens (≥ 2 letters, first upper) minus sentence furniture;
 * ALL-CAPS acronyms always count as `full`. With `classifyInitial` a
 * sentence-initial token that is not an acronym lands in `initial` instead —
 * a capital there is English, not evidence of a name (audit gate-runtime-4:
 * "## Mortgage rates", "| Item | Fee |", "- Check the form", "Rebates arrive
 * quarterly" all read as new entities).
 */
function entityTokensOf(text: string, classifyInitial: boolean, skipContractions = false): EntityTokens {
  const full: string[] = [];
  const initial: string[] = [];
  const re = /(?<![\w'])([A-Z][A-Za-z0-9'&.-]*[A-Za-z0-9]|[A-Z]{2,})(?![\w])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const tok = m[1].replace(/\.$/, '');
    if (tok.length < 2) continue;
    const low = tok.toLowerCase();
    if (ENTITY_STOPWORDS.has(low)) continue;
    // Audit 2026-10-06 T6-1 (schooltime F2: "entity: +i'm"): a pronoun contraction is furniture, not a name.
    if (skipContractions && PRONOUN_CONTRACTION_RE.test(low)) continue;
    const acronym = tok === tok.toUpperCase();
    if (classifyInitial && !acronym && isSentenceInitial(text, m.index)) initial.push(low);
    else full.push(low);
  }
  return { full: [...new Set(full)], initial: [...new Set(initial)] };
}

/** Pre-audit entity set (every capitalised token). */
function entitiesOf(text: string): string[] {
  return entityTokensOf(text, false).full;
}

/** Words that appear UNCAPITALISED somewhere (lowercased, trailing dot stripped) — a sentence-initial capital of one of these is a common noun. */
function lowercaseWordsOf(text: string): Set<string> {
  const out = new Set<string>();
  const re = /(?<![\w'])([a-z][A-Za-z0-9'&.-]*[A-Za-z0-9]|[a-z])(?![\w])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.add(m[1].replace(/\.$/, '').toLowerCase());
  return out;
}

/**
 * Entity diff with sentence-initial capitals resolved (pure):
 *  - a sentence-initial token that ALSO appears capitalised mid-sentence in
 *    either text is a name ⇒ compared like every other entity;
 *  - one that appears uncapitalised in either text is a common noun ⇒ ignored;
 *  - the rest (initial-only, unknown) count only as a REPLACEMENT (one removed
 *    AND one added — "Ottawa is the capital" → "Toronto is the capital");
 *    a bare addition / removal is restructuring (a heading, a table header, a
 *    bullet turned into prose), not a claim change.
 */
function entityDiffDenoised(a: string, b: string, skipContractions = false): string[] {
  const ta = entityTokensOf(a, true, skipContractions);
  const tb = entityTokensOf(b, true, skipContractions);
  const midCaps = new Set([...ta.full, ...tb.full]);
  const lower = lowercaseWordsOf(`${a}\n${b}`);
  const resolve = (t: EntityTokens): EntityTokens => {
    const full = [...t.full];
    const initial: string[] = [];
    for (const w of t.initial) {
      if (midCaps.has(w)) full.push(w);
      else if (!lower.has(w)) initial.push(w);
    }
    return { full: [...new Set(full)], initial };
  };
  const ra = resolve(ta);
  const rb = resolve(tb);
  const out = multisetDiff(ra.full, rb.full);
  const initialDiff = multisetDiff(ra.initial, rb.initial);
  if (initialDiff.some((e) => e.startsWith('-')) && initialDiff.some((e) => e.startsWith('+'))) out.push(...initialDiff);
  return out;
}

/** Negation bigrams ("not recommended", "no evidence") — a negation moving to a different word is material. */
function negationsOf(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${NEGATION_RE.source}\\s+([a-z0-9'-]+)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(`${m[0].split(/\s+/)[0].toLowerCase()} ${m[1].toLowerCase()}`);
  return [...new Set(out)];
}

/** Recommendation-verb bigrams ("should file", "avoid mixing") — the advice changing is material. */
function recommendationsOf(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${RECOMMEND_RE.source}\\s+([a-z0-9'-]+)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(`${m[0].replace(/\s+[a-z0-9'-]+$/i, '').toLowerCase()} ${m[1].toLowerCase()}`);
  return [...new Set(out)];
}

export interface RevisionDiff { material: boolean; changed: string[] }

/** One untruncated diff entry: the kind, the sign ('-' = in prev only, '+' = in next only) and the token. */
export interface RevisionDiffEntry {
  kind: 'number' | 'time' | 'date' | 'entity' | 'polarity' | 'negation' | 'recommendation'; sign: '+' | '-'; token: string;
  /**
   * kind 'time' only (audit 2026-10-06 T6-1): this clock appeared as a UTC OBSERVATION stamp ("00:29Z",
   * "21:02 UTC") in either text — a reconcile that re-stamps its reads moves these by minutes, so a moved stamp is
   * drift, never a removed claim (`contradicts` skips it). Absent on every other entry.
   */
  stamp?: true;
}

/** Kinds whose change in EITHER direction flips what the reader would do (a yes → no, a negation moving, the advice changing). */
const FLIP_KINDS: ReadonlySet<RevisionDiffEntry['kind']> = new Set(['polarity', 'negation', 'recommendation']);

/**
 * The full (untruncated, signed) diff the deterministic detector is built from
 * (pure). De-noised by default (audit gate-runtime-4): line-aware text (list
 * markers / headings / table rows gone) so sentence starts are visible, clock
 * times as one `time:` kind, currency amounts may group thousands with a space,
 * sentence-initial capitals resolved (entityDiffDenoised). `denoise:false` is
 * the pre-audit diff byte-for-byte.
 */
export function revisionDiffEntries(prev: string, next: string, opts: { denoise?: boolean } = {}): RevisionDiffEntry[] {
  const denoise = opts.denoise ?? true;
  let a = denoise ? prepareText(prev, true) : normalizeText(prev);
  let b = denoise ? prepareText(next, true) : normalizeText(next);
  if (collapseWhitespace(a) === collapseWhitespace(b)) return [];
  // Audit 2026-10-06 T6-1 (others.md F3 / schooltime F2): UTC stamps, ISO timestamps, ids and pronoun contractions
  // are not claims. De-noised path only; REVISION_DIFF_STAMP_NOISE_DISABLED=1 restores the previous diff.
  const stampAware = denoise && !revisionDiffStampNoiseDisabled();
  if (stampAware) { a = stripStampNoise(a); b = stripStampNoise(b); }
  const out: RevisionDiffEntry[] = [];
  const push = (kind: RevisionDiffEntry['kind'], entries: string[], stamps?: ReadonlySet<string>) => {
    for (const e of entries) {
      const token = e.slice(1);
      out.push({ kind, sign: e.startsWith('-') ? '-' : '+', token, ...(stamps?.has(token) ? { stamp: true as const } : {}) });
    }
  };
  push('number', multisetDiff(numbersOf(a, denoise, stampAware), numbersOf(b, denoise, stampAware)));
  if (stampAware) {
    const ta = timeTokensOf(a, TIME_STAMP_RE);
    const tb = timeTokensOf(b, TIME_STAMP_RE);
    const stamps = new Set([...ta, ...tb].filter((t) => t.utc).map((t) => t.token));
    push('time', multisetDiff(ta.map((t) => t.token), tb.map((t) => t.token)), stamps);
  } else if (denoise) push('time', multisetDiff(timesOf(a), timesOf(b)));
  push('date', multisetDiff(datesOf(a), datesOf(b)));
  push('entity', denoise ? entityDiffDenoised(a, b, stampAware) : multisetDiff(entitiesOf(a), entitiesOf(b)));
  push('polarity', multisetDiff(polarityOf(a), polarityOf(b)));
  push('negation', multisetDiff(negationsOf(a), negationsOf(b)));
  push('recommendation', multisetDiff(recommendationsOf(a), recommendationsOf(b)));
  return out;
}

/**
 * Deterministic material-change detector (pure, no I/O): numbers with their
 * glued unit (multiset), dates, named entities (capitalised tokens minus
 * sentence furniture), bare polarity tokens (yes / no / true / false / safe /
 * unsafe / legal / illegal …), negation bigrams and recommendation-verb
 * bigrams. Wording, ordering, length and emphasis changes leave every set
 * identical ⇒ not material. `changed` is bounded (≤ 12 entries, ≤ 80 chars
 * each) and prefixed by kind.
 */
export function revisionMaterialDeterministic(prev: string, next: string, opts: { denoise?: boolean } = {}): RevisionDiff {
  const entries = revisionDiffEntries(prev, next, opts);
  const changed = entries.map((e) => `${e.kind}: ${e.sign}${e.token}`.slice(0, REVISION_CHANGED_ENTRY_CHARS));
  return { material: changed.length > 0, changed: changed.slice(0, REVISION_CHANGED_MAX) };
}

/**
 * DIRECTION-AWARE reading of the same diff (drafts_agree label semantics,
 * 2026-09-26): did `next` REMOVE or REPLACE a claim `prev` made, or flip a
 * polarity / negation / recommendation? A '-' number / date / entity entry
 * means a claim of `prev` is gone (replaced or dropped); a '+' -only diff
 * means `next` only ADDED detail (a reconcile adopting the checker's extra
 * facts) — the two texts do not disagree. Pure; computed on the UNTRUNCATED
 * entries so a long diff cannot hide a removal past the 12-entry cap.
 */
export function revisionContradictsPrevious(prev: string, next: string): boolean {
  return entriesContradict(revisionDiffEntries(prev, next));
}

/** The direction-aware rule over already-computed entries (pure): a '-' entry that is not a moved UTC stamp, or any flip-kind entry. */
function entriesContradict(entries: RevisionDiffEntry[]): boolean {
  return entries.some((e) => (e.sign === '-' && !e.stamp) || FLIP_KINDS.has(e.kind));
}

export interface RevisionMaterialVerdict {
  material: boolean;
  changed: string[];
  /** 'diff' = the deterministic diff decided; 'gate' = the gate decided (act); 'fallback' = today's behaviour (rewrite), gate off / shadow / failed. */
  source: 'diff' | 'gate' | 'fallback';
  /**
   * source 'diff' only (drafts_agree label semantics, 2026-09-26): the
   * direction-aware reading — `next` removed / replaced a claim of `prev` or
   * flipped a polarity / negation / recommendation (revisionContradictsPrevious).
   * false = additions only (or a moved UTC stamp). Since the 2026-10-06 audit
   * (T6-2) a diff verdict is material ONLY when it contradicts: an additions-only
   * diff is `material:false` (no in-place rewrite, no "Update to an earlier
   * answer" addendum, pill "Checked ✓"); REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED=1
   * restores "any entry is material".
   */
  contradicts?: boolean;
  decisionId?: string;
  mode?: DecisionMode;
  stash?: DecisionStash;
  /**
   * A diff-decided verdict's SHADOW ask still in flight (`deferShadowAsk`):
   * resolves within REVISION_MATERIAL_TIMEOUT_MS and fills decisionId / mode /
   * stash on THIS object in place; never rejects; never changes `material`.
   */
  pending?: Promise<void>;
}

/** The state + question (pure). */
export function buildRevisionMaterialRequest(prev: string, next: string): { state: Record<string, unknown>; questions: Record<string, DecisionQuestion> } {
  const state: Record<string, unknown> = { previous: String(prev || '').slice(0, DRAFT_TEXT_CHARS), revised: String(next || '').slice(0, DRAFT_TEXT_CHARS) };
  const questions: Record<string, DecisionQuestion> = {
    [REVISION_MATERIAL_QUESTION]: {
      type: 'noul',
      instructions: 'Between the previous and the revised answer, a claim, a number, a date, a named entity, a yes/no, or a recommendation changed.',
      criteria: {
        true: 'The revised answer says something different that a reader would act on differently',
        false: 'Only wording, ordering, length, formatting or emphasis changed — the reader would act the same way',
      },
    },
  };
  return { state, questions };
}

/** The revision_material acting bar (DECISION_GATE_THRESHOLD_REVISION_MATERIAL; default 0.85 — wording-only ⇔ noul ≤ 1−τ). */
export function revisionMaterialThreshold(): number {
  return decisionThreshold(REVISION_MATERIAL_PURPOSE, REVISION_MATERIAL_DEFAULT_THRESHOLD);
}

/**
 * The SHADOW ask behind a diff-decided verdict (audit gate-runtime-4): the
 * diff keeps deciding, the gate only records its row + hands back the stash
 * the row persists (metadata.check.verdict.decision) so a later thumbs / tap
 * can label it. null when there is nothing to ask (act keeps diff-first;
 * off / disabled). Fills `verdict` in place; never rejects.
 */
function shadowAskForDiffVerdict(prev: string, next: string, verdict: RevisionMaterialVerdict, ctx: { chatId?: string }): Promise<void> | null {
  try {
    if (computePolicyDisabled()) return null;
    if (decisionMode(REVISION_MATERIAL_PURPOSE) !== 'shadow') return null;
    const { state, questions } = buildRevisionMaterialRequest(prev, next);
    return withDeadline(decide(state, questions, { purpose: REVISION_MATERIAL_PURPOSE, timeoutMs: REVISION_MATERIAL_TIMEOUT_MS, sessionId: ctx.chatId }), REVISION_MATERIAL_TIMEOUT_MS + 50)
      .then((r) => {
        if (!r) return;
        verdict.decisionId = r.id;
        verdict.mode = r.mode;
        const stash = stashDecision(r, REVISION_MATERIAL_PURPOSE);
        if (stash) verdict.stash = stash;
      })
      .catch((err: any) => { logger.warn(`compute-policy: revision_material shadow ask failed (${err?.message || err}) — the diff verdict stands`); });
  } catch (err: any) {
    logger.warn(`compute-policy: revision_material shadow ask not started (${err?.message || err}) — the diff verdict stands`);
    return null;
  }
}

/**
 * Is a revision material? Deterministic diff first; the gate DECIDES only when
 * the diff says unchanged; in ACT a confident "wording-only" (noul ≤ 1−τ) means
 * no rewrite; everything else falls back to material (today's behaviour:
 * rewrite). A diff-decided verdict in SHADOW also asks the gate for the row
 * (`shadowAskForDiffVerdict`) — awaited here (≤ REVISION_MATERIAL_TIMEOUT_MS)
 * unless `deferShadowAsk`, when it rides the verdict's `pending` so the inline
 * swap never waits on it. Never throws.
 */
export async function decideRevisionMaterial(prev: string, next: string, ctx: { chatId?: string; deferShadowAsk?: boolean; ghost?: boolean } = {}): Promise<RevisionMaterialVerdict> {
  // ONE diff pass: the symmetric detector (`changed`) and the direction-aware reading come from the same entries.
  const entries = revisionDiffEntries(prev, next);
  const diff = {
    material: entries.length > 0,
    changed: entries.map((e) => `${e.kind}: ${e.sign}${e.token}`.slice(0, REVISION_CHANGED_ENTRY_CHARS)).slice(0, REVISION_CHANGED_MAX),
  };
  if (diff.material) {
    // drafts_agree label semantics (2026-09-26): `contradicts` is the direction-aware read of the same diff.
    const contradicts = entriesContradict(entries);
    // Audit 2026-10-06 T6-2 (schooltime F2 / others.md F3 / spark F11): an additions-only (or stamp-drift) diff
    // changed no claim the user already read — it is NOT material: the delivered answer stands and no addendum
    // posts. The changed[] list is kept for the record. Kill switch REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED=1.
    const material = contradicts || revisionContradictsOnlyDisabled();
    const verdict: RevisionMaterialVerdict = { material, changed: diff.changed, source: 'diff', contradicts };
    // Ghost mode (owner 2026-10-22): a ghost run never ships its drafts to
    // the decision backend — skip the shadow ask entirely (the deterministic
    // diff verdict above already decided this reconcile).
    const ask = ctx.ghost ? null : shadowAskForDiffVerdict(prev, next, verdict, ctx);
    if (ask) {
      if (ctx.deferShadowAsk) verdict.pending = ask;
      else await ask;
    }
    return verdict;
  }
  const fallback: RevisionMaterialVerdict = { material: true, changed: [], source: 'fallback' };
  try {
    if (computePolicyDisabled()) return fallback;
    // Ghost mode (owner 2026-10-22): never ship ghost drafts to the decision
    // backend on this path either — the diff already said "material".
    if (ctx.ghost) return fallback;
    const mode = decisionMode(REVISION_MATERIAL_PURPOSE);
    if (mode === 'off') return fallback;
    const { state, questions } = buildRevisionMaterialRequest(prev, next);
    const r = await withDeadline(decide(state, questions, { purpose: REVISION_MATERIAL_PURPOSE, timeoutMs: REVISION_MATERIAL_TIMEOUT_MS, sessionId: ctx.chatId }), REVISION_MATERIAL_TIMEOUT_MS + 50);
    if (!r) return { ...fallback, mode };
    const p = noulOf(r.answers[REVISION_MATERIAL_QUESTION]);
    const stash = stashDecision(r, REVISION_MATERIAL_PURPOSE) ?? undefined;
    const carried = { decisionId: r.id, mode: r.mode, ...(stash ? { stash } : {}) };
    if (p === null || r.mode !== 'act') return { ...fallback, ...carried };
    const wordingOnly = p <= 1 - revisionMaterialThreshold() + 1e-9;
    return { material: !wordingOnly, changed: [], source: 'gate', ...carried };
  } catch (err: any) {
    logger.warn(`compute-policy: decideRevisionMaterial failed (${err?.message || err}) — rewrite as today`);
    return fallback;
  }
}

// ── Stash helpers for the label writers ──────────────────────────────────────

/** The stash a plan carries (from the gate) — or one rebuilt from the contract fields (decisionId / mode / answers) when a consumer stored only those. */
export function computePlanStash(plan: (Pick<DepthPlan, 'decisionId' | 'mode' | 'answers' | 'stash'> & { segment?: string }) | null | undefined): DecisionStash | null {
  if (!plan) return null;
  const segment = typeof plan.segment === 'string' && (COMPUTE_SEGMENTS as readonly string[]).includes(plan.segment) ? plan.segment : undefined;
  if (plan.stash && typeof plan.stash === 'object') return segment && !plan.stash.segment ? { ...plan.stash, segment } : plan.stash;
  if (!plan.decisionId || !plan.answers || typeof plan.answers !== 'object') return null;
  return { id: plan.decisionId, purpose: COMPUTE_POLICY_PURPOSE, mode: plan.mode, backend: 'unknown', answers: plan.answers as Record<string, DecisionAnswer>, decidedAt: new Date(0).toISOString(), ...(segment ? { segment } : {}) };
}

export type { DepthBudget };
