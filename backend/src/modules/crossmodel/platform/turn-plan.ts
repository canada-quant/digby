/**
 * Turn plan — dynamic roster phase 2 (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §4 B;
 * owner chose option B on 2026-10-03).
 *
 * ONE batched decision-model ask per human turn (purpose `turn_plan`) classifies
 * the message into a LANE and a few stable, model-independent traits; a
 * deterministic planner then picks the actual models from the admin's Auto
 * pools. Jev classifies, code chooses models — the research briefing behind
 * the plan: typed decision models are sensitive to option NAMES and order and
 * weak as fine-grained judges, so the questions stay stable when the admin
 * edits the registry, and the lane is asked TWICE in one call with the options
 * in reverse order and averaged (position bias).
 *
 *   lane      choice  quick | standard | checked | research  (asked twice, averaged)
 *   needs_live_web / stakes / contested / multi_step   noul
 *   breadth   score   0..3  → 1..4 independent sub-topics
 *   follow_up noul    (only when there are earlier user turns)
 *
 * What it changes today (phase 2):
 *   SHADOW (default) — nothing; the plan (lane, traits, would-be roster) is
 *     persisted on the answer row (metadata.depth.turnPlan) and labelled later
 *     by Dig-deeper taps / re-asks / thumbs and offline replays.
 *   ACT — only the QUICK lane acts: a confident quick lane on an eligible turn
 *     runs the Quick answers seat (thinking off, short budget, no checker)
 *     instead of the preset's lead. Every other lane is still recorded only —
 *     a research route needs the controller's quota reserve (a later phase).
 *
 * Never throws: off / disabled / timeout / error ⇒ a plan with `act:false`
 * and the preset's lane. Kill switches: TURN_PLAN_DISABLED=1 (no ask at all),
 * QUICK_LANE_DISABLED=1 (act never routes a turn to the Quick lane).
 *
 * TASK KIND (2026-10-20, task-aware pick; docs/AUDIT_2026-10-20_REAL_USER.md): a
 * SECOND ask — its own purpose `task_kind` (task-kind.ts), never a question in
 * this batch (that would re-key turn_plan's readiness partition) — fires in the
 * same tick over the same state and classifies the JOB (writing / code /
 * analysis / lookup / advice / planning / explain). A usable kind keys the lead
 * pick's QUALITY on the bench's (model, kind) buckets (model-evidence.ts /
 * model-pick.ts): store mode `modelPickKind` shadow (default — recorded as
 * modelPick.kindPick) / act (replaces the lane pick) / off. It never extends the
 * plan's bounds: awaited inside the MODEL_EVIDENCE_WAIT_MS pick window, else for
 * TASK_KIND_GRACE_MS after the turn_plan answer. Kill switches:
 * TASK_KIND_DISABLED=1 (no ask), MODEL_PICK_KIND_DISABLED=1 (no kind-aware pick),
 * MODEL_EVIDENCE_KIND_DISABLED=1 (evidence ignores kind buckets).
 */

import logger from '../../../utils/logger';
import {
  decide, decisionMode, decisionOptionThreshold, stashDecision,
  type DecideResult, type DecisionAnswer, type DecisionMode, type DecisionQuestion, type DecisionStash,
} from './decision-gate';
import type { EffectivePool, PoolRole } from '../model-endpoints/auto-pools.service';
import {
  QUICK_LANE_DEFAULT_THRESHOLD, QUICK_LANE_FOLLOW_UP_CEILING, QUICK_LANE_MAX_MESSAGE_CHARS, quickLaneCeilings, stakesCeilingFor, traitRound, type QuickLaneGuards,
} from './quick-lane-guards';
import type { ModelCard } from '../model-endpoints/model-catalog';
import { pickModel, type ModelPick, type QualityKey } from './model-pick';
import { evidenceFrom, loadModelEvidence, type EvidenceSnapshot } from './model-evidence';
// 2026-10-20 task-aware pick: the job-type ask (its OWN purpose — never a question in the turn_plan batch, whose
// readiness partition is keyed by questionsHash) and its vocabulary.
import { TASK_KIND_PURPOSE, decideTaskKind, type TaskKind, type TaskKindResult } from './task-kind';

export const TURN_PLAN_PURPOSE = 'turn_plan' as const;

export type Lane = 'quick' | 'standard' | 'checked' | 'research';
export const LANES: readonly Lane[] = ['quick', 'standard', 'checked', 'research'];

/** Request-path bound for the ask (fired before the context load; awaited only in act). */
export const TURN_PLAN_TIMEOUT_MS = 1200;
/** State budget: keeps the ask under a ~3.8k-char decision backend window (Laya) with the fields below. */
export const TURN_PLAN_MESSAGE_CHARS = 2000;
export const TURN_PLAN_PRIOR_TURN_CHARS = 400;
export const TURN_PLAN_PRIOR_TURNS = 2;

// Quick-lane guard cutoffs (p(quick) 0.8 / stakes < 0.6 — < 0.75 on a pure live lookup (2026-10-20) / contested < 0.5 /
// ≤ 600 chars) live in the shared leaf quick-lane-guards.ts — the readiness ruler's act band reads the same values.
export { QUICK_LANE_DEFAULT_THRESHOLD, QUICK_LANE_MAX_MESSAGE_CHARS, QUICK_LANE_STAKES_CEILING, QUICK_LANE_CONTESTED_CEILING, QUICK_LANE_FOLLOW_UP_CEILING } from './quick-lane-guards';

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};
export function turnPlanDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.TURN_PLAN_DISABLED); }
export function quickLaneDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.QUICK_LANE_DISABLED); }
export function quickLaneThreshold(): number { return decisionOptionThreshold(TURN_PLAN_PURPOSE, 'quick', QUICK_LANE_DEFAULT_THRESHOLD); }
/** Every Quick-lane cutoff in force: the p(quick) threshold (decision-gate option env) + the trait ceilings (their own envs). */
export function quickLaneGuards(): QuickLaneGuards { return { threshold: quickLaneThreshold(), ...quickLaneCeilings() }; }
export function turnPlanCanaryDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.TURN_PLAN_CANARY_DISABLED); }
/** audit 2026-10-08 W4-1a: QUICK_INELIGIBLE_PICK_DISABLED=1 ⇒ a quick-classified turn that runs the preset gets no model pick (the seat leads). */
export function quickIneligiblePickDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.QUICK_INELIGIBLE_PICK_DISABLED); }

// ── The act CANARY (2026-10-03 hardening) ────────────────────────────────────
// A store-backed allowlist of user ids — ['instance','turn-plan'] / 'config'
// { actCanaryUserIds: string[] } — whose eligible turns run the Quick lane
// while the purpose is still SHADOW, so the act path is verified end to end
// (the prod test account) before the fleet-wide flip. Same eligibility, same
// calibrated-answer rule; recorded as canary on the plan. Written by
// scripts/framework-audit/set-turn-plan-canary.js; 30 s cache; read failure =
// nobody. TURN_PLAN_CANARY_DISABLED=1 ignores the list.
const CANARY_NS = ['instance', 'turn-plan'];
const CANARY_KEY = 'config';
// The same row carries the per-turn MODEL PICK mode (2026-10-04, model-pick.ts): `modelPick` 'off' | 'shadow' | 'act'
// (absent ⇒ shadow). Written by scripts/framework-audit/set-model-pick-mode.js. In shadow a CANARY user's turns act.
// 2026-10-20: the same row carries `modelPickKind` 'off' | 'shadow' | 'act' (absent ⇒ shadow) — whether the KIND-AWARE
// pick (the turn's task_kind keys quality on the bench's kind buckets) is computed beside today's (model, lane) pick
// (shadow: recorded as modelPick.kindPick) or REPLACES it (act: it then acts under the modelPick mode / canary exactly
// like today's pick). Written by scripts/framework-audit/set-model-pick-kind.js; MODEL_PICK_KIND_DISABLED=1 ⇒ off.
export type ModelPickMode = 'off' | 'shadow' | 'act';
const pickModeOf = (v: unknown): ModelPickMode => (v === 'off' || v === 'act' ? v : 'shadow');
let canaryCache: { ids: Set<string>; modelPick: ModelPickMode; modelPickKind: ModelPickMode; workspaceAttachGate: ModelPickMode; expiresAt: number } | null = null;
export function __resetTurnPlanCanaryForTests(): void { canaryCache = null; }
async function turnPlanConfig(): Promise<{ ids: Set<string>; modelPick: ModelPickMode; modelPickKind: ModelPickMode; workspaceAttachGate: ModelPickMode }> {
  if (!canaryCache || canaryCache.expiresAt <= Date.now()) {
    try {
      const { storeGet } = await import('../memory/context-store');
      const row = await storeGet<{ actCanaryUserIds?: unknown; modelPick?: unknown; modelPickKind?: unknown; workspaceAttachGate?: unknown }>(CANARY_NS, CANARY_KEY);
      const ids = Array.isArray(row?.actCanaryUserIds) ? (row!.actCanaryUserIds as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
      canaryCache = { ids: new Set(ids), modelPick: pickModeOf(row?.modelPick), modelPickKind: pickModeOf(row?.modelPickKind), workspaceAttachGate: pickModeOf(row?.workspaceAttachGate), expiresAt: Date.now() + 30_000 };
    } catch {
      canaryCache = { ids: new Set(), modelPick: 'shadow', modelPickKind: 'shadow', workspaceAttachGate: 'shadow', expiresAt: Date.now() + 30_000 };
    }
  }
  return canaryCache;
}
export async function turnPlanCanaryIncludes(userId: string | null | undefined): Promise<boolean> {
  if (!userId || turnPlanCanaryDisabled()) return false;
  return (await turnPlanConfig()).ids.has(userId);
}
/** The per-turn model pick's mode (AUTO_MODEL_PICK_DISABLED=1 ⇒ off). */
export async function modelPickMode(env: NodeJS.ProcessEnv = process.env): Promise<ModelPickMode> {
  const s = String(env.AUTO_MODEL_PICK_DISABLED ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on') return 'off';
  return (await turnPlanConfig()).modelPick;
}
/** 2026-10-20: MODEL_PICK_KIND_DISABLED=1 ⇒ no kind-aware pick (today's (model, lane) pick only). */
export function modelPickKindDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.MODEL_PICK_KIND_DISABLED); }
/** The kind-aware pick's mode (the store row's modelPickKind, absent ⇒ shadow; MODEL_PICK_KIND_DISABLED=1 ⇒ off). */
export async function modelPickKindMode(env: NodeJS.ProcessEnv = process.env): Promise<ModelPickMode> {
  if (modelPickKindDisabled(env)) return 'off';
  return (await turnPlanConfig()).modelPickKind;
}
/**
 * 2026-10-20: the workspace attach gate's mode (platform/workspace-attach-gate.ts — the task_kind decision judges a
 * CODE_INTENT keyword hit before a send converts a chat into a coding session). The store row's workspaceAttachGate,
 * absent ⇒ shadow (asked + recorded, the keyword still attaches); WORKSPACE_ATTACH_KIND_GATE_DISABLED=1 ⇒ off. Like
 * modelPickKind, the consumer's own flag — task_kind's gate mode is act-capped (a pure evidence key).
 */
export async function workspaceAttachGateMode(env: NodeJS.ProcessEnv = process.env): Promise<ModelPickMode> {
  if (onFlag(env.WORKSPACE_ATTACH_KIND_GATE_DISABLED)) return 'off';
  return (await turnPlanConfig()).workspaceAttachGate;
}

// ── The questions (text pinned — a rewording resets comparability) ──────────

export const LANE_CRITERIA: Readonly<Record<Lane, string>> = {
  quick: 'QUICK — a short lookup or live fact that one fast model answers well with a web search: weather, the time somewhere, a score, a price, a definition, a unit conversion, a simple factual or how-to question. Not for advice with real consequences, contested or opinion topics, explanations that need depth, or multi-part requests.',
  standard: 'STANDARD — an ordinary request one strong model handles well on its own: explaining a concept, writing or editing text, summarizing, brainstorming, a simple piece of code, casual conversation. Not for contested topics, high-stakes advice, or research across many sources.',
  checked: 'CHECKED — worth a second independent model checking the answer: a contested, political or historically disputed point; health, legal or financial advice; tricky multi-step reasoning or numbers; facts that are easy to get wrong.',
  research: 'RESEARCH — the user wants depth across many sources: a report, a history or analysis of a broad topic with several perspectives, a comparison across many options, or an explicit request to research something.',
};

const LANE_INSTRUCTIONS = 'Which lane should answer this message? Pick the CHEAPEST lane whose answer a stronger lane would not meaningfully improve.';

export function turnPlanQuestions(hasPriorTurns: boolean): Record<string, DecisionQuestion> {
  const forward: Record<string, string> = {};
  for (const l of LANES) forward[l] = LANE_CRITERIA[l];
  const reversed: Record<string, string> = {};
  for (const l of [...LANES].reverse()) reversed[l] = LANE_CRITERIA[l];
  return {
    lane: { type: 'choice', instructions: LANE_INSTRUCTIONS, criteria: forward },
    lane_rev: { type: 'choice', instructions: LANE_INSTRUCTIONS, criteria: reversed },
    needs_live_web: { type: 'noul', instructions: 'Does a correct answer depend on current information from the web (news, prices, weather, schedules, recent events, anything after a model\'s training cutoff)?' },
    stakes: { type: 'noul', instructions: 'Could a wrong answer cost the user money, health, legal standing or something hard to undo?' },
    contested: { type: 'noul', instructions: 'Is this a contested, political or historically disputed topic where informed people disagree?' },
    multi_step: { type: 'noul', instructions: 'Does answering well need careful multi-step reasoning, calculation or planning?' },
    breadth: {
      type: 'score',
      instructions: 'How many independent sub-topics would a thorough answer have to cover?',
      criteria: [
        '0 — one focused point',
        '1 — two or three closely related points',
        '2 — several distinct sub-topics or perspectives',
        '3 — a broad topic needing many sources and perspectives',
      ],
    },
    ...(hasPriorTurns ? { follow_up: { type: 'noul' as const, instructions: 'Does this message continue the topic of the previous user messages (a follow-up), rather than starting a new one?' } } : {}),
  };
}

export interface TurnPlanInput {
  message: string;
  priorUserTurns: string[];
  images: number;
  documents: number;
  /** The lane the previous answer in this chat ran (session state), if known. */
  priorLane?: Lane | null;
  /** Human turns in this chat so far (0 on a fresh chat). */
  turnIndex: number;
  chatId?: string;
  sessionId?: string;
  segment?: string;
  /** The sender (the canary allowlist is per user; never in the state). */
  userId?: string | null;
}

/** The decision state (pure): the message, the last two user turns, and session facts — never tool output or documents (injection surface). */
export function turnPlanState(i: TurnPlanInput): Record<string, unknown> {
  const prior = (i.priorUserTurns ?? []).filter(t => typeof t === 'string' && t.trim()).slice(-TURN_PLAN_PRIOR_TURNS).map(t => t.slice(0, TURN_PLAN_PRIOR_TURN_CHARS));
  const attachments = i.images && i.documents ? 'images and documents' : i.images ? 'images' : i.documents ? 'documents' : 'none';
  return {
    message: String(i.message ?? '').slice(0, TURN_PLAN_MESSAGE_CHARS),
    ...(prior.length ? { previous_user_messages: prior } : {}),
    ...(i.priorLane ? { previous_answer_lane: i.priorLane } : {}),
    turn_in_chat: Math.max(0, Math.floor(i.turnIndex || 0)) + 1,
    attachments,
  };
}

// ── Reading the answers (pure) ───────────────────────────────────────────────

export interface TurnClass {
  lane: Lane;
  /** Averaged over both orderings when both answered. */
  laneProbs: Record<Lane, number>;
  laneConfidence: number;
  /** Both orderings answered (position-bias averaging applied). */
  laneAveraged: boolean;
  needsLiveWeb: number | null;
  stakes: number | null;
  contested: number | null;
  multiStep: number | null;
  /** 1..4 independent sub-topics. */
  breadth: number | null;
  followUp: number | null;
}

const noulOf = (a: DecisionAnswer | undefined): number | null => (a && a.type === 'noul' && Number.isFinite(a.noul) ? a.noul : null);

function laneProbsOf(a: DecisionAnswer | undefined): Record<Lane, number> | null {
  if (!a || a.type !== 'choice' || !a.probabilities) return null;
  const out = {} as Record<Lane, number>;
  let sum = 0;
  for (const l of LANES) { const p = Number(a.probabilities[l]); out[l] = Number.isFinite(p) && p > 0 ? p : 0; sum += out[l]; }
  if (sum <= 0) return null;
  for (const l of LANES) out[l] = out[l] / sum;
  return out;
}

export function classFromAnswers(answers: Record<string, DecisionAnswer> | null | undefined): TurnClass | null {
  if (!answers) return null;
  const a = laneProbsOf(answers.lane);
  const b = laneProbsOf(answers.lane_rev);
  if (!a && !b) return null;
  const probs = {} as Record<Lane, number>;
  for (const l of LANES) probs[l] = a && b ? (a[l] + b[l]) / 2 : (a ?? b)![l];
  const lane = LANES.reduce((best, l) => (probs[l] > probs[best] ? l : best), LANES[0]);
  const br = answers.breadth;
  const breadth = br && br.type === 'score' && Number.isFinite(br.score) ? Math.min(4, Math.max(1, Math.round(br.score) + 1)) : null;
  return {
    lane,
    laneProbs: probs,
    laneConfidence: probs[lane],
    laneAveraged: !!(a && b),
    needsLiveWeb: noulOf(answers.needs_live_web),
    stakes: noulOf(answers.stakes),
    contested: noulOf(answers.contested),
    multiStep: noulOf(answers.multi_step),
    breadth,
    followUp: noulOf(answers.follow_up),
  };
}

/**
 * TRAIT-ADJUSTED LANE — SHADOW ONLY (2026-10-04, research-routing input). The argmax lane is not a decision on a
 * near-tie: the live query suite's Quebec question ("explain the history of why Canadians are for or against Quebec
 * sovereignty" — the plan doc's own example of a research ask) read standard 0.365 vs research 0.355 with contested
 * 0.97 and breadth 4/4 and ran at Level 2. Two deterministic rules over the traits Jev already returns:
 *   - near_tie_research_broad: research within LANE_RULE_NEAR_TIE of the top lane AND breadth 4 ⇒ research;
 *   - contested_broad: contested ≥ LANE_RULE_CONTESTED AND breadth ≥ 3 ⇒ at least checked.
 * Recorded as metadata.depth.turnPlan.ruleLane / laneRule beside the argmax lane; NOTHING routes on it yet — the
 * nightly live-chat audit's reasoning judge scores both, and that readout decides whether research routing acts on
 * it. TURN_PLAN_LANE_RULE_DISABLED=1 drops the fields. Pure.
 */
export const LANE_RULE_NEAR_TIE = 0.05;
export const LANE_RULE_CONTESTED = 0.9;
const LANE_RANK: Record<Lane, number> = { quick: 0, standard: 1, checked: 2, research: 3 };

export function ruleAdjustedLane(cls: TurnClass | null | undefined): { lane: Lane; rule: string | null } | null {
  if (!cls) return null;
  const p = cls.laneProbs;
  const breadth = cls.breadth ?? 0;
  if (LANE_RANK[cls.lane] < LANE_RANK.research && breadth >= 4 && p.research >= p[cls.lane] - LANE_RULE_NEAR_TIE) {
    return { lane: 'research', rule: 'near_tie_research_broad' };
  }
  if (LANE_RANK[cls.lane] < LANE_RANK.checked && (cls.contested ?? 0) >= LANE_RULE_CONTESTED && breadth >= 3) {
    return { lane: 'checked', rule: 'contested_broad' };
  }
  return { lane: cls.lane, rule: null };
}

export function turnPlanLaneRuleDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TURN_PLAN_LANE_RULE_DISABLED === '1';
}

/** The lane a resolved preset corresponds to (the fallback when the gate is silent). */
export function presetLane(mode: string | null | undefined): Lane {
  if (mode === 'deep_research' || mode === 'deep_research_all') return 'research';
  if (mode === 'thinking') return 'checked';
  return 'standard';
}

// ── The roster planner (pure) ────────────────────────────────────────────────

export interface RosterPick {
  lead: string;
  /** Which pool the lead came from. */
  leadPool: 'quick' | 'lead';
  checker: string | null;
  colleagues: string[];
  /** Code-composed audit string. */
  reason: string;
}

/** The first spec in a pool that is servable (and vision-capable when images ride). Pure. */
export function firstUsable(models: readonly string[], catalog: ReadonlyMap<string, ModelCard>, opts: { vision?: boolean; excludeFamily?: string | null; exclude?: readonly string[] } = {}): string | null {
  const usable = (spec: string, requireFamily: boolean): boolean => {
    if ((opts.exclude ?? []).includes(spec)) return false;
    const card = catalog.get(spec);
    // A spec the catalog does not know (a seat on an unlisted built-in alias) stays usable — the run path resolves it.
    if (card && !card.servable) return false;
    if (opts.vision && card && !card.vision) return false;
    if (requireFamily && opts.excludeFamily && card && card.family === opts.excludeFamily) return false;
    return true;
  };
  if (opts.excludeFamily) {
    const diverse = models.find(m => usable(m, true));
    if (diverse) return diverse;
  }
  return models.find(m => usable(m, false)) ?? null;
}

/**
 * The models a lane would run (pure over the pools + catalog). Quick → the
 * quick pool's first usable model, alone. Standard → the lead pool's first.
 * Checked → lead + the first checker of a DIFFERENT family (independent
 * coverage), else the first checker. Research → lead + clamp(breadth, 2, 4)
 * colleagues from the colleague pool (today's council seats two of them; the
 * rest are recorded for the readout until the council takes N).
 */
export function planRoster(lane: Lane, cls: Pick<TurnClass, 'breadth'> | null, pools: Readonly<Record<PoolRole, Pick<EffectivePool, 'models'>>>, catalog: ReadonlyMap<string, ModelCard>, opts: { images?: boolean } = {}): RosterPick | null {
  const leadPool = lane === 'quick' ? 'quick' : 'lead';
  const lead = firstUsable(pools[leadPool].models, catalog, { vision: !!opts.images }) ?? firstUsable(pools[leadPool].models, catalog);
  if (!lead) return null;
  const leadFamily = catalog.get(lead)?.family ?? null;
  const checker = lane === 'checked' ? firstUsable(pools.checker.models, catalog, { excludeFamily: leadFamily, exclude: [lead] }) : null;
  const colleagues: string[] = [];
  if (lane === 'research') {
    const want = Math.min(4, Math.max(2, cls?.breadth ?? 2));
    for (const m of pools.colleague.models) {
      if (colleagues.length >= want) break;
      const card = catalog.get(m);
      if (card && !card.servable) continue;
      if (!colleagues.includes(m)) colleagues.push(m);
    }
  }
  const reason = `lane ${lane}: lead ${lead} (${leadPool} pool${opts.images ? ', vision' : ''})${checker ? `; checker ${checker}${leadFamily && catalog.get(checker)?.family !== leadFamily ? ' (different family)' : ''}` : ''}${colleagues.length ? `; colleagues ${colleagues.join(', ')}` : ''}`;
  return { lead, leadPool, checker, colleagues, reason };
}

// ── The Quick-lane act rule (pure) ───────────────────────────────────────────

export interface QuickLaneContext {
  messageChars: number;
  images: number;
  documents: number;
  /** The resolved preset ('single_thinking' / 'thinking' / 'deep_research'…). */
  mode: string;
  escalation: boolean;
  supervisor: boolean;
  machine: boolean;
  /** Code / repo intent in the message (auto-router detectCodeIntent) — code questions never take the Quick lane. */
  codeIntent?: boolean;
  /** The lane the previous answer in this chat ran (session hysteresis). */
  priorLane?: Lane | null;
  /**
   * Roster 2026-10-06 A-4: the ask decides the level itself (platform/lane-depth.ts routeResearchLane asks BEFORE the
   * final level is known), so the Level 1 / 2 preset check is skipped — the run still never takes the Quick lane on a
   * council turn (turnPlanMayAct). QUICK_PRESET_FREE_DISABLED=1 makes the caller send false.
   */
  presetFree?: boolean;
}

const DEFAULT_GUARDS: QuickLaneGuards = { threshold: QUICK_LANE_DEFAULT_THRESHOLD, ...quickLaneCeilings({}) };

/**
 * Whether a classified turn may run the Quick lane, and why not. Pure.
 * `guards` = quickLaneGuards() at the call site (a bare number is the legacy
 * threshold-only form; the ceilings then take their defaults).
 *
 * Stakes (2026-10-20, quick-lane-guards.ts stakesCeilingFor): a PURE LIVE LOOKUP (needs_live_web high, multi_step and
 * contested low — all answered) is held to the lookup ceiling (0.75), every other turn to the base one (0.6). The
 * refusal keeps the word "stakes" (turn-plan-readout.js keys its guard blocks on it): "lookup stakes 0.81" when the
 * lookup ceiling was the bar. When the relaxation DECIDED eligibility (a lookup between the two ceilings) the ok-why
 * says so ("; lookup stakes 0.62 < 0.75") and `lookupStakes: true` rides the verdict, so readouts and labels can
 * isolate those acts.
 */
export function quickLaneEligibility(cls: TurnClass | null, c: QuickLaneContext, guards: QuickLaneGuards | number = DEFAULT_GUARDS): { ok: boolean; why: string; lookupStakes?: true } {
  const g: QuickLaneGuards = typeof guards === 'number' ? { ...DEFAULT_GUARDS, threshold: guards } : guards;
  if (!cls) return { ok: false, why: 'no classification' };
  if (cls.lane !== 'quick') return { ok: false, why: `lane ${cls.lane}` };
  if (cls.laneConfidence < g.threshold - 1e-9) return { ok: false, why: `p(quick) ${cls.laneConfidence.toFixed(2)} < ${g.threshold}` };
  const stakes = traitRound(cls.stakes ?? 0); // the decision row's 3 dp — the readiness band reads the same number
  const sc = stakesCeilingFor(cls, g);
  if (stakes >= sc.ceiling) return { ok: false, why: `${sc.lookup ? 'lookup ' : ''}stakes ${stakes.toFixed(2)}` };
  const relaxed = sc.lookup && stakes >= g.stakesCeiling;
  if (traitRound(cls.contested ?? 0) >= g.contestedCeiling) return { ok: false, why: `contested ${cls.contested!.toFixed(2)}` };
  if (c.messageChars > QUICK_LANE_MAX_MESSAGE_CHARS) return { ok: false, why: `message ${c.messageChars} chars` };
  if (c.images || c.documents) return { ok: false, why: 'attachments' };
  if (c.codeIntent) return { ok: false, why: 'code intent' };
  if (!c.presetFree && c.mode !== 'single_thinking' && c.mode !== 'thinking') return { ok: false, why: `preset ${c.mode}` };
  // Session hysteresis: a follow-up in a Checked / Research conversation steps down at most one lane — never to Quick.
  if ((c.priorLane === 'checked' || c.priorLane === 'research') && (cls.followUp ?? 0) >= QUICK_LANE_FOLLOW_UP_CEILING) {
    return { ok: false, why: `follow-up in a ${c.priorLane} session` };
  }
  if (c.escalation) return { ok: false, why: 'dig deeper rung' };
  if (c.supervisor) return { ok: false, why: 'supervisor chat' };
  if (c.machine) return { ok: false, why: 'machine turn' };
  return {
    ok: true, why: `p(quick) ${cls.laneConfidence.toFixed(2)} ≥ ${g.threshold}${relaxed ? `; lookup stakes ${stakes.toFixed(2)} < ${sc.ceiling}` : ''}`,
    ...(relaxed ? { lookupStakes: true as const } : {}),
  };
}

// ── The ask ──────────────────────────────────────────────────────────────────

export interface TurnPlan {
  /** The lane the classifier picked (else the preset's lane). */
  lane: Lane;
  cls: TurnClass | null;
  /** The models the lane would run (recorded in shadow; the quick lead is used in act). */
  roster: RosterPick | null;
  /** The Quick lane is APPLIED to this run. */
  act: boolean;
  /** The act came from the canary allowlist while the purpose is shadow. */
  canary?: boolean;
  /** The per-turn lead MODEL pick (standard / checked lanes; model-pick.ts). `act` = the run should lead with
   *  `spec` (mode act, or a canary user in shadow); in shadow it is recorded only.
   *  2026-10-20 (task-aware pick, only when the turn has a usable kind and modelPickKind ≠ off): `kindMode` is that
   *  mode; in SHADOW `kindPick` records what the kind-aware pick would lead with (telemetry only — the (model, lane)
   *  pick above acts as before); in ACT the kind-aware pick IS this pick and `lanePick` records the (model, lane)
   *  counterfactual. `kind` (from model-pick.ts) is present when the comparison was keyed on kind buckets. */
  modelPick?: (ModelPick & {
    mode: ModelPickMode; act: boolean; lane?: 'standard' | 'checked';
    kindMode?: ModelPickMode; kindPick?: KindPickRecord; lanePick?: { spec: string; changed: boolean };
  }) | null;
  /** 2026-10-20: the turn's job type (purpose task_kind) when its answer was in within budget. */
  taskKind?: TurnTaskKind | null;
  /** 2026-10-20: the task_kind decision's stash (future outcome labels), apart from the turn_plan stash. */
  taskKindStash?: DecisionStash | null;
  /** Code-composed audit string. */
  reason: string;
  mode: DecisionMode;
  decisionId?: string;
  backend?: string;
  ms?: number;
  stash?: DecisionStash | null;
}

/** 2026-10-20: the task_kind classification a turn was planned under. `usable` = the pick may key on `kind`. */
export interface TurnTaskKind {
  /** The kind over TASK_KIND_MIN_P, else null. */
  kind: TaskKind | null;
  /** The argmax kind (telemetry, even under the bar). */
  top: TaskKind;
  p: number;
  averaged: boolean;
  /** The harm noul asked beside it (telemetry). */
  harm: number | null;
  usable: boolean;
  decisionId?: string;
  backend?: string;
  calibrated?: boolean;
}

/** 2026-10-20: the kind-aware pick recorded beside an acting (model, lane) pick (shadow). */
export interface KindPickRecord {
  spec: string;
  changed: boolean;
  /** The comparison was keyed on kind buckets (else the seat had none and the lane comparison ran). */
  keyed: boolean;
  reason: string;
  ranked: Array<{ spec: string; u: number; ttft: number | null; q: number | null; qk?: QualityKey }>;
}

export interface TurnPlanDeps {
  /** The live pools + catalog (injected — tests and the chat run pass their own). */
  pools: () => Promise<Record<PoolRole, EffectivePool>>;
  catalog: () => Promise<ModelCard[]>;
  /** The canary allowlist check (default: the store-backed turnPlanCanaryIncludes). */
  canary?: (userId: string | null | undefined) => Promise<boolean>;
  /** Model evidence for the per-turn pick (the default deps: model-evidence.ts loadModelEvidence, cached). */
  evidence?: () => Promise<EvidenceSnapshot | null>;
  /** The model-pick mode (the default deps: modelPickMode — the store row + AUTO_MODEL_PICK_DISABLED). Injected
   *  deps WITHOUT it leave the pick off (tests opt in explicitly). */
  pickMode?: () => Promise<ModelPickMode>;
  /** roster 2026-10-06 C-1: quality points per USD of a turn's estimated spend (roster-policy.ts costPerUsd;
   *  MODEL_PICK_COST_DISABLED=1 ⇒ 0). Injected deps WITHOUT it price nothing (the pre-cost utility). */
  costPerUsd?: () => Promise<number>;
  /** 2026-10-20: the task_kind ask (the default deps: task-kind.ts decideTaskKind — TASK_KIND_DISABLED=1 ⇒ no ask).
   *  Fired in the same tick as the turn_plan ask over the same state; injected deps WITHOUT it ask nothing. */
  taskKind?: (state: Record<string, unknown>, opts: { timeoutMs: number; sessionId?: string; segment?: string }) => Promise<TaskKindResult>;
  /** 2026-10-20: the kind-aware pick's mode (the default deps: modelPickKindMode). Injected deps WITHOUT it read the
   *  same store row (absent ⇒ shadow); it only matters when `taskKind` answered a usable kind. */
  pickKindMode?: () => Promise<ModelPickMode>;
}

/** How long the turn plan waits for the evidence snapshot (it is cached; a cold miss must not delay the turn). */
export const MODEL_EVIDENCE_WAIT_MS = 400;
/**
 * 2026-10-20: how long a turn WITHOUT a kind-aware pick to compute waits for the task_kind answer after the turn_plan
 * answer is in (the two asks fire together and usually land together; the kind is then telemetry only). A turn that
 * computes the kind-aware pick waits for it inside the MODEL_EVIDENCE_WAIT_MS window instead — the plan's outer
 * bound never grows.
 */
export const TASK_KIND_GRACE_MS = 150;

const defaultDeps: TurnPlanDeps = {
  pools: async () => (await import('../model-endpoints/auto-pools.service')).resolveEffectivePools(),
  catalog: async () => (await import('../model-endpoints/model-catalog')).listChatModelCatalog(),
  evidence: () => loadModelEvidence(),
  pickMode: () => modelPickMode(),
  costPerUsd: async () => (await import('./roster-policy')).pickCostPerUsd(),
  taskKind: (state, opts) => decideTaskKind(state, opts),
  pickKindMode: () => modelPickKindMode(),
};

const NO_TASK_KIND: TaskKindResult = { cls: null, decision: null, usableKind: null };
/** A not-yet-in marker for the bounded task_kind waits. */
const KIND_LATE = Symbol('task-kind-late');
const after = <T>(ms: number, v: T): Promise<T> => new Promise<T>((res) => { setTimeout(() => res(v), ms).unref?.(); });

/** The turn's task_kind record (pure over the ask's result); null when nothing classified. */
export function turnTaskKindOf(r: TaskKindResult | null | undefined): TurnTaskKind | null {
  const cls = r?.cls;
  if (!cls) return null;
  const d = r?.decision;
  return {
    kind: cls.kind, top: cls.top, p: cls.p, averaged: cls.averaged, harm: cls.harm, usable: !!r?.usableKind,
    ...(d ? { decisionId: d.id, backend: d.backend, ...(typeof d.calibrated === 'boolean' ? { calibrated: d.calibrated } : {}) } : {}),
  };
}

const kindPickRecord = (p: ModelPick): KindPickRecord => ({
  spec: p.spec, changed: p.changed, keyed: !!p.kind, reason: p.reason.slice(0, 240),
  ranked: p.ranked.slice(0, 3).map((x) => ({ spec: x.spec, u: x.utility, ttft: x.ttftP50Ms, q: x.quality, ...(x.qk ? { qk: x.qk } : {}) })),
});

/**
 * Ask, classify, plan. Never throws. The decision row is written by decide();
 * the plan (lane, traits, would-be roster, act) rides back for the answer row.
 */
export async function decideTurnPlan(input: TurnPlanInput, ctx: QuickLaneContext & { requestedMode: string }, deps: TurnPlanDeps = defaultDeps): Promise<TurnPlan> {
  const fallbackLane = presetLane(ctx.requestedMode);
  const quiet = (reason: string, mode: DecisionMode = 'off'): TurnPlan => ({ lane: fallbackLane, cls: null, roster: null, act: false, reason, mode });
  if (turnPlanDisabled()) return quiet('TURN_PLAN_DISABLED');
  const mode = decisionMode(TURN_PLAN_PURPOSE);
  if (mode === 'off') return quiet('purpose off');
  // 2026-10-20 review: every wait for the task_kind answer ends by this ABSOLUTE deadline (the turn_plan ask's own
  // bound) — a slow turn_plan answer must never be followed by a kind wait that pushes the whole plan past the callers'
  // TURN_PLAN_TIMEOUT_MS + 300 ms race (an over-run drops the plan: no Quick lane, no pick, no lane depth).
  const kindDeadlineAt = Date.now() + TURN_PLAN_TIMEOUT_MS;
  const kindWaitMs = (capMs: number): number => Math.max(0, Math.min(capMs, kindDeadlineAt - Date.now()));
  try {
    const catalogP = deps.catalog().catch(() => [] as ModelCard[]);
    const poolsP = deps.pools().catch(() => null);
    // The model-pick evidence loads IN PARALLEL with the classifier ask (2026-10-05: a cold process — the first turns
    // after every deploy — used to start the load only after the ask, miss the 400 ms window and lead with the seat).
    const evidenceP = deps.evidence && deps.pickMode ? deps.evidence().catch(() => null) : Promise.resolve(null);
    const canaryP = (deps.canary ?? turnPlanCanaryIncludes)(input.userId).catch(() => false);
    const state = turnPlanState(input);
    const rP: Promise<DecideResult | null> = decide(state, turnPlanQuestions((input.priorUserTurns ?? []).some(t => String(t ?? '').trim())), {
      purpose: TURN_PLAN_PURPOSE, timeoutMs: TURN_PLAN_TIMEOUT_MS,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.segment ? { segment: input.segment } : {}),
    });
    // 2026-10-20 (task-aware pick): the task_kind ask fires in the SAME tick, over the SAME state, with the same budget /
    // session / segment — after the turn_plan call, so the turn_plan ask stays the first decide() of the turn. It is
    // never awaited past the plan's own bounds (the pick window below, else TASK_KIND_GRACE_MS). Fail-open: no dep,
    // TASK_KIND_DISABLED=1, an error or a late answer ⇒ no kind ⇒ today's (model, lane) pick.
    let kindP: Promise<TaskKindResult> | null = null;
    if (deps.taskKind) {
      try {
        kindP = deps.taskKind(state, {
          timeoutMs: TURN_PLAN_TIMEOUT_MS,
          ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          ...(input.segment ? { segment: input.segment } : {}),
        }).catch(() => NO_TASK_KIND);
      } catch { kindP = null; }
    }
    const kindModeP: Promise<ModelPickMode> = kindP ? (deps.pickKindMode ?? (() => modelPickKindMode()))().catch(() => 'off' as ModelPickMode) : Promise.resolve('off');
    const r: DecideResult | null = await rP;
    // The grace clock starts when the turn_plan answer is in.
    const kindGrace: Promise<typeof KIND_LATE> | null = kindP ? after(kindWaitMs(TASK_KIND_GRACE_MS), KIND_LATE) : null;
    let taskKindRes: TaskKindResult | null = null;
    const cls = classFromAnswers(r?.answers);
    const lane = cls?.lane ?? fallbackLane;
    const [catalog, pools] = await Promise.all([catalogP, poolsP]);
    const bySpec = new Map(catalog.map(c => [c.spec, c] as const));
    const roster = pools ? planRoster(lane, cls, pools, bySpec, { images: input.images > 0 }) : null;
    const elig = quickLaneEligibility(cls, ctx, quickLaneGuards());
    // Only an ACT answer from a calibrated backend may change the run (decide() downgrades an uncalibrated act to shadow);
    // a canary user's SHADOW answer acts too when its backend is calibrated (the act path verified before the flip).
    const canary = await canaryP;
    const modeActs = !!r && (r.mode === 'act' || (canary && r.mode === 'shadow' && r.calibrated !== false));
    const act = modeActs && elig.ok && !quickLaneDisabled() && roster?.leadPool === 'quick';
    const actByCanary = act && r!.mode !== 'act';
    // Per-turn MODEL PICK (2026-10-04, model-pick.ts): on a standard / checked turn, the best measured open model for
    // the task — or the seat when nothing clearly beats it. Candidates: the admin's lead pool when one is configured,
    // else every catalog model (the picker filters open / servable / chat / vision).
    let modelPick: TurnPlan['modelPick'] = null;
    // audit 2026-10-08 W4-1a: a QUICK-classified turn that does NOT take the Quick lane (p(quick) under the bar,
    // stakes, attachments, shadow …) runs the preset — i.e. a Standard turn on the lead seat. It used to get NO pick
    // and ran the slowest seat (prod 10-07/08: 9 such turns, seat TTFT p50 287 s vs picked leads 59–71 s). It is
    // picked as 'standard' against the LEAD pool's seat (the quick roster's lead is the Quick seat, not what runs).
    // QUICK_INELIGIBLE_PICK_DISABLED=1 restores "no pick".
    const pickLane: 'standard' | 'checked' | null = lane === 'standard' || lane === 'checked'
      ? lane
      : (lane === 'quick' && !act && !quickIneligiblePickDisabled() ? 'standard' : null);
    const pickRoster = pickLane && lane === 'quick' && pools ? planRoster('standard', cls, pools, bySpec, { images: input.images > 0 }) : roster;
    if (!act && pickRoster && pickLane) {
      const pmode: ModelPickMode = deps.pickMode ? await deps.pickMode().catch(() => 'off' as ModelPickMode) : 'off';
      if (pmode !== 'off') {
        // ONE MODEL_EVIDENCE_WAIT_MS window for the evidence AND (2026-10-20) the task_kind answer — the kind-aware pick
        // needs both, and the window is the plan's existing bound (never extended). A kind mode of off ⇒ no wait for it.
        const window = after<null>(MODEL_EVIDENCE_WAIT_MS, null);
        const kindWindow = after<null>(kindWaitMs(MODEL_EVIDENCE_WAIT_MS), null);
        type KindIn = TaskKindResult | typeof KIND_LATE;
        const kindIn: Promise<KindIn> = kindP
          ? Promise.race<KindIn>([
            kindModeP.then((km): KindIn | Promise<KindIn> => (km === 'off' ? KIND_LATE : kindP!)),
            kindWindow.then((): KindIn => KIND_LATE),
          ])
          : Promise.resolve<KindIn>(KIND_LATE);
        const [ev, kindRes] = await Promise.all([Promise.race([evidenceP, window]), kindIn]);
        if (kindRes !== KIND_LATE) taskKindRes = kindRes;
        // In only when the mode read was (kindIn waited on it) — already settled here.
        const kindMode: ModelPickMode = taskKindRes ? await kindModeP : 'off';
        const usableKind = taskKindRes?.usableKind ?? null;
        const adminPool = pools?.lead?.source === 'pool';
        const candidates = adminPool ? pools!.lead.models.map((s) => bySpec.get(s)).filter((c): c is ModelCard => !!c) : catalog;
        // roster 2026-10-06 C-1: every model is priced from the live catalog (registry / built-in / twin prices;
        // an unknown price takes model-pick.ts's conservative default) — a frontier model admitted by the auto-pick
        // policy wins only when its quality / speed justifies its cost.
        const perUsd = deps.costPerUsd ? await deps.costPerUsd().catch(() => 0) : 0;
        const pickArgs = {
          lane: pickLane, stakes: cls?.stakes ?? null, images: input.images > 0, seat: pickRoster.lead, candidates, evidence: evidenceFrom(ev),
          ...(perUsd > 0 ? { cost: { perUsd, priceOf: (spec: string) => bySpec.get(spec) ?? null } } : {}),
        };
        const lanePick = pickModel(pickArgs);
        // 2026-10-20: the KIND-AWARE pick (model-pick.ts `kind`) — shadow: recorded beside the acting (model, lane) pick;
        // act: it replaces that pick and acts under the same modelPick mode / canary rule. No usable kind / mode off ⇒
        // today's pick alone.
        const kindPick = usableKind && kindMode !== 'off' ? pickModel({ ...pickArgs, kind: usableKind }) : null;
        // 2026-10-20 review: in act the kind pick replaces the lane pick only when it actually COMPARED the seat with
        // at least one same-field alternative (keyed on the kind, a non-seat candidate ranked). A kind pick that kept
        // the seat for want of a field must not override a lane pick that measured a better model.
        const kindHasField = !!kindPick?.kind && kindPick.ranked.some((x) => x.spec !== kindPick.seat);
        // …and only when the LANE pick's winner was itself inside that kind field (a kind bucket from the seat's run):
        // a lane winner the kind comparison never saw is not out-measured by it, it was just not compared.
        const laneWinnerKeyed = (() => {
          if (!kindPick?.kind || !lanePick.changed) return true;
          const evf = pickArgs.evidence;
          const seatK = evf(pickArgs.seat, pickLane, kindPick.kind);
          const winK = evf(lanePick.spec, pickLane, kindPick.kind);
          return !!winK && winK.qualityKey === 'kind'
            && (!seatK?.qualityRunId || !winK.qualityRunId || seatK.qualityRunId === winK.qualityRunId);
        })();
        const kindActs = !!kindPick && kindMode === 'act' && kindHasField && laneWinnerKeyed;
        const pick = kindActs ? kindPick! : lanePick;
        modelPick = {
          ...pick, mode: pmode, act: pick.changed && (pmode === 'act' || (pmode === 'shadow' && canary)), ...(pickLane !== lane ? { lane: pickLane } : {}),
          ...(kindPick ? { kindMode } : {}),
          ...(kindPick && !kindActs ? { kindPick: kindPickRecord(kindPick) } : {}),
          ...(kindActs ? { lanePick: { spec: lanePick.spec, changed: lanePick.changed } } : {}),
        };
      }
    }
    // 2026-10-20: the task_kind answer for the record when the pick window did not take it — at most TASK_KIND_GRACE_MS
    // after the turn_plan answer (a clock that has usually run out by now, so this never waits past the plan's bound).
    if (kindP && kindGrace && !taskKindRes) {
      const late = await Promise.race([kindP, kindGrace]);
      if (late !== KIND_LATE) taskKindRes = late;
    }
    const taskKind = turnTaskKindOf(taskKindRes);
    const taskKindStash = taskKindRes?.decision
      ? stashDecision(taskKindRes.decision, TASK_KIND_PURPOSE, { extra: { lane, ...(taskKind ? { top: taskKind.top, usable: taskKind.usable } : {}), ...(modelPick?.kindMode ? { pickKindMode: modelPick.kindMode } : {}) } })
      : null;
    const kindPickNote = modelPick?.kindPick
      ? ` → ${modelPick.kindPick.changed ? modelPick.kindPick.spec : 'seat'} (${modelPick.kindMode === 'act' ? 'act, not comparable in one kind field — lane pick leads' : 'shadow'})`
      : modelPick?.kindMode === 'act' ? ' (act)' : '';
    const stash = stashDecision(r, TURN_PLAN_PURPOSE, { extra: { lane, wouldQuick: elig.ok, ...(elig.lookupStakes ? { lookupStakes: true } : {}), act, ...(actByCanary ? { canary: true } : {}), ...(modelPick?.changed ? { pickModel: modelPick.spec, pickAct: modelPick.act } : {}), ...(modelPick?.lane ? { pickLane: modelPick.lane } : {}), ...(modelPick?.kind ? { pickKind: modelPick.kind } : {}) } });
    return {
      lane, cls, roster, act, ...(actByCanary ? { canary: true } : {}), modelPick,
      reason: `${cls ? `lane ${lane} (p ${cls.laneConfidence.toFixed(2)}${cls.laneAveraged ? ', both orders' : ''})` : `no answer — preset lane ${fallbackLane}`}; quick ${elig.ok ? 'eligible' : `no (${elig.why})`}${act ? (actByCanary ? '; ACT (canary)' : '; ACT') : ''}${modelPick ? `; model ${modelPick.changed ? `${modelPick.spec}${modelPick.act ? ' ACT' : ' (shadow)'}` : 'seat'}${modelPick.lane ? ` (picked as ${modelPick.lane})` : ''}` : ''}${taskKind?.usable ? `; kind ${taskKind.kind}${kindPickNote}` : ''}`,
      mode: r?.mode ?? mode,
      ...(r ? { decisionId: r.id, backend: r.backend, ms: r.ms } : {}),
      stash,
      ...(taskKind ? { taskKind } : {}),
      ...(taskKindStash ? { taskKindStash } : {}),
    };
  } catch (err: any) {
    logger.warn(`turn-plan: ask failed (${err?.message ?? err}) — preset lane ${fallbackLane} stands`);
    return quiet('error', mode);
  }
}

/**
 * roster 2026-10-06 B-1 (readiness report #1/#3): what the turn ACTUALLY ran, stamped at
 * finalize beside the prediction. With it, `modelPick.act` means "the pick LED this run"
 * (the would-act flag moves to `modelPick.wouldAct`) and the record carries `ran` — the
 * lane / lead / checker / colleagues that ran — so readouts and the counterfactual label
 * rule (chat-agent/turn-plan-labels.ts) compare predicted vs ran. Kill switch
 * TURN_PLAN_APPLIED_STAMP_DISABLED=1 restores the would-act record (no `ran`, no `wouldAct`).
 */
export interface TurnPlanApplied {
  /** The per-turn model pick led this run (the harness swapped the lead to it). */
  pickApplied: boolean;
  /** The roster that ran (chat-agent/turn-plan-labels.ts ranRosterOf). */
  ran?: { lane: Lane; lead: string | null; checker: string | null; colleagues: string[] } | null;
}
export function turnPlanAppliedStampDisabled(env: NodeJS.ProcessEnv = process.env): boolean { return onFlag(env.TURN_PLAN_APPLIED_STAMP_DISABLED); }

/** The compact record persisted on the answer row (metadata.depth.turnPlan) — what labels and readouts join on. Pure. */
export function turnPlanMetadata(p: TurnPlan | null | undefined, applied?: TurnPlanApplied | null): Record<string, unknown> | null {
  if (!p) return null;
  const did = applied && !turnPlanAppliedStampDisabled() ? applied : null;
  const probs = p.cls ? Object.fromEntries(LANES.map(l => [l, Number(p.cls!.laneProbs[l].toFixed(3))])) : undefined;
  const r3 = (v: number | null | undefined) => (typeof v === 'number' ? Number(v.toFixed(3)) : null);
  const r2 = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(2)) : null);
  return {
    lane: p.lane,
    act: p.act,
    ...(p.canary ? { canary: true } : {}),
    mode: p.mode,
    reason: p.reason,
    ...(p.decisionId ? { decisionId: p.decisionId } : {}),
    ...(p.backend ? { backend: p.backend } : {}),
    ...(probs ? { laneProbs: probs } : {}),
    ...((() => {
      if (turnPlanLaneRuleDisabled()) return {};
      const adj = ruleAdjustedLane(p.cls);
      return adj ? { ruleLane: adj.lane, ...(adj.rule ? { laneRule: adj.rule } : {}) } : {};
    })()),
    ...(p.cls ? { traits: { needsLiveWeb: r3(p.cls.needsLiveWeb), stakes: r3(p.cls.stakes), contested: r3(p.cls.contested), multiStep: r3(p.cls.multiStep), breadth: p.cls.breadth, followUp: r3(p.cls.followUp) } } : {}),
    ...(p.roster ? { roster: { lead: p.roster.lead, leadPool: p.roster.leadPool, checker: p.roster.checker, colleagues: p.roster.colleagues } } : {}),
    ...(p.modelPick ? { modelPick: {
      spec: p.modelPick.spec, changed: p.modelPick.changed,
      // roster 2026-10-06 B-1: with the applied stamp, `act` = the pick led this run; `wouldAct` = the plan's own verdict.
      act: did ? did.pickApplied : p.modelPick.act, ...(did ? { wouldAct: p.modelPick.act } : {}),
      mode: p.modelPick.mode, seat: p.modelPick.seat, ...(p.modelPick.lane ? { lane: p.modelPick.lane } : {}),
      expectedTtftMs: p.modelPick.expectedTtftMs, reason: p.modelPick.reason.slice(0, 240),
      // 2026-10-20: `qk` = the bucket each candidate's quality came from (kind / lane / all).
      ranked: p.modelPick.ranked.slice(0, 3).map((x) => ({ spec: x.spec, u: x.utility, ttft: x.ttftP50Ms, q: x.quality, ...(x.qk ? { qk: x.qk } : {}) })),
      // 2026-10-20 (task-aware pick): the kind the comparison was keyed on, the kind mode, and the other pick —
      // shadow: the kind-aware pick (kindPick); act: the (model, lane) counterfactual (lanePick).
      ...(p.modelPick.kind ? { kind: p.modelPick.kind } : {}),
      ...(p.modelPick.kindMode ? { kindMode: p.modelPick.kindMode } : {}),
      ...(p.modelPick.kindPick ? { kindPick: {
        spec: p.modelPick.kindPick.spec, changed: p.modelPick.kindPick.changed, keyed: p.modelPick.kindPick.keyed,
        reason: p.modelPick.kindPick.reason.slice(0, 240), ranked: p.modelPick.kindPick.ranked.slice(0, 3),
      } } : {}),
      ...(p.modelPick.lanePick ? { lanePick: { spec: p.modelPick.lanePick.spec, changed: p.modelPick.lanePick.changed } } : {}),
    } } : {}),
    // 2026-10-20: the turn's job type (purpose task_kind) — what the bench scorecard's planKind and the readouts join on.
    ...(p.taskKind ? { taskKind: {
      kind: p.taskKind.kind, top: p.taskKind.top, p: r2(p.taskKind.p), averaged: p.taskKind.averaged, harm: r2(p.taskKind.harm),
      usable: p.taskKind.usable, ...(p.taskKind.decisionId ? { decisionId: p.taskKind.decisionId } : {}),
    } } : {}),
    ...(did?.ran ? { ran: { lane: did.ran.lane, lead: did.ran.lead, checker: did.ran.checker, colleagues: did.ran.colleagues.slice(0, 4) } } : {}),
    ...(p.stash ? { stash: p.stash } : {}),
    ...(p.taskKindStash ? { taskKindStash: p.taskKindStash } : {}),
  };
}
