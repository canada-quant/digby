/**
 * compute-policy-gate.ts (2026-09-26, depth-UX Module A) — fail-open proofs:
 *  - gate off / COMPUTE_POLICY_DISABLED / null / throw / timeout ⇒ the PRESET plan;
 *  - uncalibrated (decide() hands back mode 'shadow') and shadow ⇒ a plan EQUAL to
 *    the preset that carries decisionId / answers / mode / stash for the labels;
 *  - ACT thresholds exactly as the shared contract (simple ≥0.85 ∧ stakes ≤0.15 ⇒ no
 *    checker; stakes ≥0.85 ∧ contestable ≥0.70 ⇒ wait ≤ STAKES_WAIT_MS + effort max;
 *    research ≥0.85 ∧ !guest ∧ allowDeepResearch ⇒ background council);
 *  - escalation = the next rung, never an ask;
 *  - the deterministic revision diff catches a changed number / date / negation /
 *    entity / recommendation and ignores wording;
 *  - drafts_agree / revision_material fail open (null / today's rewrite).
 * decision-gate is a mocked boundary (thresholds mirror the real env reads).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { COMPUTE_POLICY: 'compute_policy', DECISION_GATE: 'decision_gate' },
  recordLoopMetric: jest.fn(),
}));

const mockDecide: jest.Mock = jest.fn();
const mockMode: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => {
  const clamp = (v: number) => Math.min(1, Math.max(0.5, v));
  const threshold = (p: string, fallback: number) => {
    const raw = Number(process.env[`DECISION_GATE_THRESHOLD_${p.toUpperCase()}`]);
    return clamp(Number.isFinite(raw) ? raw : fallback);
  };
  return {
    __esModule: true,
    decide: (...a: any[]) => mockDecide(...a),
    decisionMode: (...a: any[]) => mockMode(...a),
    decisionThreshold: threshold,
    decisionOptionThreshold: (p: string, option: string, fallback: number) => {
      const raw = Number(process.env[`DECISION_GATE_THRESHOLD_${p.toUpperCase()}_${option.toUpperCase()}`]);
      return Number.isFinite(raw) ? clamp(raw) : threshold(p, fallback);
    },
    stashDecision: (d: any, purpose: string) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'now' } : null),
  };
});

import { recordLoopMetric } from './loop-metrics.service';
import { depthBudgetFor } from './depth-budget';
// 2026-09-26 audit (gate-runtime-5): the checker_route depth criteria mirror compute_policy's (Laya NaN on the old wording).
import { buildCheckerRouteRequest, CHECKER_ROUTE_QUESTION } from '../chat-agent/checker-route-gate';
import {
  COMPUTE_POLICY_TIMEOUT_MS, DEPTH_QUESTION, STAKES_WAIT_MS_DEFAULT, STAKES_WAIT_MS_MAX,
  applyComputePolicy, buildComputePolicyRequest, computePlanStash, computePolicyQuestions, computePolicyState, decideComputePlan, decideDraftsAgree, decideRevisionMaterial,
  normalizeDepthPreset, presetPlan, readComputePolicyAnswers, recordComputePolicyTelemetry, revisionMaterialDeterministic, stakesWaitMs,
  computeSegmentOf, revisionContradictsPrevious, revisionDiffEntries,
  type ComputePlanInput, type DepthPlan,
} from './compute-policy-gate';

const ENV_KEYS = [
  'COMPUTE_POLICY_DISABLED', 'RESEARCH_REQUEST_AUTOSTART_DISABLED', 'STAKES_WAIT_MS', 'COMPUTE_POLICY_TIMEOUT_MS',
  'DECISION_GATE_THRESHOLD_COMPUTE_POLICY', 'DECISION_GATE_THRESHOLD_COMPUTE_POLICY_SIMPLE_LOOKUP', 'DECISION_GATE_THRESHOLD_COMPUTE_POLICY_STAKES',
  'DECISION_GATE_THRESHOLD_COMPUTE_POLICY_CONTESTABLE', 'DECISION_GATE_THRESHOLD_COMPUTE_POLICY_RESEARCH_REQUEST',
  'DECISION_GATE_THRESHOLD_DRAFTS_AGREE', 'DECISION_GATE_THRESHOLD_REVISION_MATERIAL', 'DEPTH_BUDGET_MAX_USD', 'DEPTH_BUDGET_DISABLED',
  'REVISION_DIFF_STAMP_NOISE_DISABLED', 'REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED',
  'DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED', 'DECISION_GATE_COMPUTE_POLICY_HUMAN_RETIRE_LIFTED', 'DECISION_GATE_DRAFTS_AGREE_HUMAN_RETIRE_LIFTED',
];
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  mockMode.mockReturnValue('shadow');
});

const input = (over: Partial<ComputePlanInput> = {}): ComputePlanInput => ({
  message: 'What is the capital of France?', priorUserTurns: [], attachmentCount: 0, chatId: 'chat1', userId: 'u1', guest: false, requestedMode: 'thinking', allowDeepResearch: true, ...over,
});

/** A decide() result for the four questions. */
const answer = (o: { depth?: string; pSimple?: number; pContestable?: number; conf?: number; stakes?: number; web?: number; research?: number; mode?: 'shadow' | 'act'; id?: string }) => {
  const depth = o.depth ?? 'ordinary';
  const conf = o.conf ?? 0.9;
  const probabilities: Record<string, number> = { simple_lookup: o.pSimple ?? (depth === 'simple_lookup' ? conf : 0.05), ordinary: depth === 'ordinary' ? conf : 0.05, contestable: o.pContestable ?? (depth === 'contestable' ? conf : 0.05), unclear: 0.02 };
  return {
    id: o.id ?? 'd1', backend: 'TypeSafe Jev', ms: 12, mode: o.mode ?? 'act', calibrated: true,
    answers: {
      depth: { type: 'choice', choice: depth, confidence: conf, probabilities },
      stakes: { type: 'noul', noul: o.stakes ?? 0.1 },
      needs_live_web: { type: 'noul', noul: o.web ?? 0.3 },
      research_request: { type: 'noul', noul: o.research ?? 0.05 },
    },
  };
};

const L2: DepthPlan = presetPlan('thinking');
/** The preset's TUPLE fields (what "equals the preset" means — reason / mode / source are audit stamps). */
const tuple = (p: 'single_thinking' | 'thinking' | 'deep_research') => { const { preset, spawnChecker, checkerWaitMs, leadEffort, council } = presetPlan(p); return { preset, spawnChecker, checkerWaitMs, leadEffort, council }; };

describe('presets', () => {
  it('normalizeDepthPreset: legacy ids alias forward; auto / unknown ⇒ thinking', () => {
    expect(normalizeDepthPreset('single')).toBe('single_thinking');
    expect(normalizeDepthPreset('fast')).toBe('single_thinking');
    expect(normalizeDepthPreset('single_thinking')).toBe('single_thinking');
    expect(normalizeDepthPreset('deep_research_all')).toBe('deep_research');
    expect(normalizeDepthPreset('deep_research')).toBe('deep_research');
    expect(normalizeDepthPreset('auto')).toBe('thinking');
    expect(normalizeDepthPreset(undefined)).toBe('thinking');
  });

  it("presetPlan = today's tuples: L1 no checker, L2 one checker answer-first (wait 0), L3 inline council and no L2 checker", () => {
    expect(presetPlan('single_thinking')).toMatchObject({ preset: 'single_thinking', spawnChecker: false, checkerWaitMs: 0, leadEffort: 'high', council: 'none', source: 'preset', mode: 'off' });
    expect(presetPlan('thinking')).toMatchObject({ preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, leadEffort: 'high', council: 'none', source: 'preset' });
    expect(presetPlan('deep_research')).toMatchObject({ preset: 'deep_research', spawnChecker: false, checkerWaitMs: 0, council: 'none', source: 'preset' });
  });

  it('stakesWaitMs: default 90 s, env honoured, clamped 0..300 s, garbage ⇒ default', () => {
    expect(stakesWaitMs()).toBe(STAKES_WAIT_MS_DEFAULT);
    process.env.STAKES_WAIT_MS = '45000';
    expect(stakesWaitMs()).toBe(45_000);
    process.env.STAKES_WAIT_MS = '999999';
    expect(stakesWaitMs()).toBe(STAKES_WAIT_MS_MAX);
    process.env.STAKES_WAIT_MS = '-5';
    expect(stakesWaitMs()).toBe(0);
    process.env.STAKES_WAIT_MS = 'lots';
    expect(stakesWaitMs()).toBe(STAKES_WAIT_MS_DEFAULT);
  });
});

describe('request shape', () => {
  it("state = message ≤4k + last two user turns ≤1k each + attachment count + this chat's prior rung / escalations on EVERY ask; four pinned questions", () => {
    const long = 'x'.repeat(5000);
    const turn = 'y'.repeat(1500);
    const { state, questions } = buildComputePolicyRequest(input({ message: long, priorUserTurns: ['t1', 't2', turn], attachmentCount: 2.7 }));
    expect((state.message as string).length).toBe(4000);
    expect(state.prior_user_turns).toEqual(['t2', 'y'.repeat(1000)]);
    expect(state.attachment_count).toBe(2);
    expect(state.prior_rung).toBeUndefined();
    expect(state.prior_escalations).toBeUndefined();
    expect(Object.keys(questions)).toEqual(['depth', 'stakes', 'needs_live_web', 'research_request']);
    expect(questions.depth.type).toBe('choice');
    expect(Object.keys((questions.depth as any).criteria)).toEqual(['simple_lookup', 'ordinary', 'contestable', 'unclear']);
    for (const q of ['stakes', 'needs_live_web', 'research_request']) expect(questions[q].type).toBe('noul');
    // Review 2026-09-26: the prior rung / escalation count ride EVERY ask (the contract's "this chat's prior rung/escalations") —
    // never keyed on escalationOf, whose path never asks the gate at all.
    expect(computePolicyState(input({ priorRung: 'single_thinking', priorEscalations: 2 }))).toMatchObject({ prior_rung: 'single_thinking', prior_escalations: 2 });
    expect(computePolicyState(input({ priorEscalations: 0 })).prior_escalations).toBe(0);
    expect(computePolicyState(input({ priorRung: 'garbage' as any, priorEscalations: -3.7 }))).toMatchObject({ prior_escalations: 0 });
    expect(computePolicyState(input({ priorRung: 'garbage' as any })).prior_rung).toBeUndefined();
    const esc = computePolicyState(input({ priorUserTurns: ['', '  '] }));
    expect(esc.prior_user_turns).toBeUndefined();
    expect(esc).not.toHaveProperty('escalation');
    expect(esc).not.toHaveProperty('prior_rung_on_this_message');
    // The question text is the questionsHash partition key — the same object every time.
    expect(computePolicyQuestions()).toEqual(computePolicyQuestions());
  });

  it('readComputePolicyAnswers tolerates missing questions and takes P(option) from the distribution', () => {
    expect(readComputePolicyAnswers(null)).toEqual({ depth: null, depthConfidence: null, pSimple: null, pContestable: null, stakes: null, needsLiveWeb: null, researchRequest: null });
    const r = readComputePolicyAnswers(answer({ depth: 'contestable', conf: 0.75, pSimple: 0.1, stakes: 0.9 }).answers as any);
    expect(r).toMatchObject({ depth: 'contestable', depthConfidence: 0.75, pSimple: 0.1, pContestable: 0.75, stakes: 0.9 });
    expect(readComputePolicyAnswers({ depth: { type: 'choice', choice: 'nonsense', confidence: 0.9, probabilities: {} } } as any).depth).toBeNull();
  });
});

describe('decideComputePlan — fail-open', () => {
  it('gate off ⇒ the preset plan, no ask', async () => {
    mockMode.mockReturnValue('off');
    const plan = await decideComputePlan(input());
    expect(plan).toEqual(presetPlan('thinking'));
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('COMPUTE_POLICY_DISABLED=1 ⇒ the preset even when the purpose is act', async () => {
    process.env.COMPUTE_POLICY_DISABLED = '1';
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(answer({ depth: 'simple_lookup', conf: 0.99, stakes: 0.01 }));
    expect(await decideComputePlan(input({ requestedMode: 'single' }))).toEqual(presetPlan('single_thinking'));
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('shadow ⇒ a plan EQUAL to the preset that carries decisionId / answers / mode / stash (source gate_shadow)', async () => {
    mockDecide.mockResolvedValue(answer({ depth: 'simple_lookup', conf: 0.99, stakes: 0.01, mode: 'shadow' }));
    const plan = await decideComputePlan(input());
    expect(plan).toMatchObject({ preset: 'thinking', spawnChecker: true, checkerWaitMs: 0, leadEffort: 'high', council: 'none', source: 'gate_shadow', decisionId: 'd1', mode: 'shadow' });
    expect(plan.answers).toEqual(answer({ depth: 'simple_lookup', conf: 0.99, stakes: 0.01 }).answers);
    expect(plan.stash).toMatchObject({ id: 'd1', purpose: 'compute_policy', mode: 'shadow' });
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'compute_policy', timeoutMs: COMPUTE_POLICY_TIMEOUT_MS, sessionId: 'chat1' });
  });

  it('uncalibrated backend under an act purpose (result.mode shadow) ⇒ shadow plan equal to the preset', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(answer({ depth: 'simple_lookup', conf: 0.99, stakes: 0.01, mode: 'shadow' }));
    const plan = await decideComputePlan(input());
    expect(plan).toMatchObject({ spawnChecker: true, checkerWaitMs: 0, source: 'gate_shadow', mode: 'shadow', decisionId: 'd1' });
  });

  it('null answer ⇒ preset (mode carried); throw ⇒ preset', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(null);
    expect(await decideComputePlan(input())).toMatchObject({ ...presetPlan('thinking'), mode: 'act', reason: expect.stringContaining('no answer') });
    mockDecide.mockRejectedValue(new Error('boom'));
    expect(await decideComputePlan(input())).toMatchObject({ ...tuple('thinking'), source: 'preset', mode: 'act', reason: expect.stringContaining('no answer') });
    expect((await decideComputePlan(input())).decisionId).toBeUndefined();
  });

  it('a hung backend ⇒ the preset within the timeout bound (never blocks the first token)', async () => {
    process.env.COMPUTE_POLICY_TIMEOUT_MS = '300';
    mockMode.mockReturnValue('act');
    mockDecide.mockReturnValue(new Promise(() => { /* never settles */ }));
    const t0 = Date.now();
    const plan = await decideComputePlan(input());
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(plan).toMatchObject({ ...tuple('thinking'), source: 'preset', mode: 'act', reason: expect.stringContaining('no answer') });
    expect(mockDecide.mock.calls[0][2].timeoutMs).toBe(300);
  });
});

describe('decideComputePlan — ACT contract', () => {
  beforeEach(() => mockMode.mockReturnValue('act'));

  it('simple_lookup ≥ 0.85 ∧ stakes ≤ 0.15 ⇒ spawnChecker=false (source gate_act)', async () => {
    mockDecide.mockResolvedValue(answer({ depth: 'simple_lookup', conf: 0.85, stakes: 0.15 }));
    const plan = await decideComputePlan(input());
    expect(plan).toMatchObject({ preset: 'thinking', spawnChecker: false, checkerWaitMs: 0, leadEffort: 'high', council: 'none', source: 'gate_act', mode: 'act', decisionId: 'd1' });
  });

  it('just under either bar ⇒ the preset stands (decisionId carried, source preset)', async () => {
    mockDecide.mockResolvedValue(answer({ depth: 'simple_lookup', conf: 0.84, stakes: 0.1 }));
    expect(await decideComputePlan(input())).toMatchObject({ spawnChecker: true, source: 'preset', mode: 'act', decisionId: 'd1' });
    mockDecide.mockResolvedValue(answer({ depth: 'simple_lookup', conf: 0.95, stakes: 0.16 }));
    expect(await decideComputePlan(input())).toMatchObject({ spawnChecker: true, source: 'preset' });
    mockDecide.mockResolvedValue(answer({ depth: 'unclear', conf: 0.99, stakes: 0.01 }));
    expect(await decideComputePlan(input())).toMatchObject({ spawnChecker: true, source: 'preset' });
  });

  it('the L1 preset never gains a checker from a low-stakes simple read; the L3 preset is never amended', async () => {
    mockDecide.mockResolvedValue(answer({ depth: 'simple_lookup', conf: 0.95, stakes: 0.05 }));
    expect(await decideComputePlan(input({ requestedMode: 'single_thinking' }))).toMatchObject({ preset: 'single_thinking', spawnChecker: false, source: 'gate_act' });
    mockDecide.mockResolvedValue(answer({ depth: 'contestable', conf: 0.9, stakes: 0.95, research: 0.99 }));
    expect(await decideComputePlan(input({ requestedMode: 'deep_research' }))).toMatchObject({ preset: 'deep_research', spawnChecker: false, checkerWaitMs: 0, council: 'none', source: 'preset' });
  });

  it('stakes ≥ 0.85 ∧ contestable ≥ 0.70 ⇒ checkerWaitMs = STAKES_WAIT_MS, leadEffort max, checker spawned (even on the L1 preset)', async () => {
    mockDecide.mockResolvedValue(answer({ depth: 'contestable', conf: 0.7, stakes: 0.85 }));
    expect(await decideComputePlan(input())).toMatchObject({ spawnChecker: true, checkerWaitMs: 90_000, leadEffort: 'max', source: 'gate_act' });
    expect(await decideComputePlan(input({ requestedMode: 'single_thinking' }))).toMatchObject({ preset: 'single_thinking', spawnChecker: true, checkerWaitMs: 90_000, leadEffort: 'max' });
    process.env.STAKES_WAIT_MS = '30000';
    expect(await decideComputePlan(input())).toMatchObject({ checkerWaitMs: 30_000 });
    mockDecide.mockResolvedValue(answer({ depth: 'contestable', conf: 0.69, stakes: 0.99 }));
    expect(await decideComputePlan(input())).toMatchObject({ checkerWaitMs: 0, leadEffort: 'high', source: 'preset' });
    mockDecide.mockResolvedValue(answer({ depth: 'contestable', conf: 0.9, stakes: 0.84 }));
    expect(await decideComputePlan(input())).toMatchObject({ checkerWaitMs: 0, source: 'preset' });
  });

  it("research_request ≥ 0.85: DEFAULT OFF since the 2026-09-26 audit (no harness path consumes council:'background'); RESEARCH_REQUEST_AUTOSTART_ENABLED=1 opts in for signed-in + allowance; guest / quota / DISABLED ⇒ none", async () => {
    mockDecide.mockResolvedValue(answer({ depth: 'ordinary', research: 0.85 }));
    expect(await decideComputePlan(input())).toMatchObject({ council: 'none', source: 'preset' }); // default: label-only hint
    process.env.RESEARCH_REQUEST_AUTOSTART_ENABLED = '1';
    expect(await decideComputePlan(input())).toMatchObject({ council: 'background', spawnChecker: true, source: 'gate_act' });
    expect(await decideComputePlan(input({ guest: true }))).toMatchObject({ council: 'none', source: 'preset' });
    expect(await decideComputePlan(input({ allowDeepResearch: false }))).toMatchObject({ council: 'none', source: 'preset' });
    process.env.RESEARCH_REQUEST_AUTOSTART_DISABLED = '1';
    expect(await decideComputePlan(input())).toMatchObject({ council: 'none', source: 'preset' }); // DISABLED still wins
    delete process.env.RESEARCH_REQUEST_AUTOSTART_DISABLED;
    mockDecide.mockResolvedValue(answer({ depth: 'ordinary', research: 0.84 }));
    expect(await decideComputePlan(input())).toMatchObject({ council: 'none', source: 'preset' });
    delete process.env.RESEARCH_REQUEST_AUTOSTART_ENABLED;
  });

  it('rules compose: a research request on a confident simple low-stakes turn skips the checker AND starts the council; stakes dominates simple', () => {
    const t = { simple: 0.85, stakes: 0.85, contestable: 0.7, research: 0.85, lowStakesMax: 0.15 };
    const both = applyComputePolicy(L2, readComputePolicyAnswers(answer({ depth: 'simple_lookup', conf: 0.9, stakes: 0.05, research: 0.9 }).answers as any), { guest: false, allowDeepResearch: true }, t);
    expect(both).toMatchObject({ spawnChecker: false, council: 'background', source: 'gate_act' });
    const stakes = applyComputePolicy(L2, readComputePolicyAnswers(answer({ depth: 'simple_lookup', conf: 0.9, pContestable: 0.75, stakes: 0.9 }).answers as any), { guest: false, allowDeepResearch: true }, t);
    expect(stakes).toMatchObject({ spawnChecker: true, checkerWaitMs: 90_000, leadEffort: 'max' });
    // Nothing fires ⇒ the SAME preset object (identity is the "unchanged" signal).
    expect(applyComputePolicy(L2, readComputePolicyAnswers(answer({ depth: 'ordinary' }).answers as any), { guest: false, allowDeepResearch: true }, t)).toBe(L2);
  });

  it('thresholds are env-overridable per option (DECISION_GATE_THRESHOLD_COMPUTE_POLICY_<OPTION>)', async () => {
    process.env.DECISION_GATE_THRESHOLD_COMPUTE_POLICY_SIMPLE_LOOKUP = '0.95';
    process.env.DECISION_GATE_THRESHOLD_COMPUTE_POLICY_STAKES = '0.9';
    mockDecide.mockResolvedValue(answer({ depth: 'simple_lookup', conf: 0.9, stakes: 0.12 }));
    expect(await decideComputePlan(input())).toMatchObject({ spawnChecker: true, source: 'preset' });
    mockDecide.mockResolvedValue(answer({ depth: 'simple_lookup', conf: 0.96, stakes: 0.1 }));
    expect(await decideComputePlan(input())).toMatchObject({ spawnChecker: false, source: 'gate_act' });
    // stakes bar 0.9 ⇒ low stakes ⇔ ≤ 0.10
    mockDecide.mockResolvedValue(answer({ depth: 'simple_lookup', conf: 0.96, stakes: 0.12 }));
    expect(await decideComputePlan(input())).toMatchObject({ spawnChecker: true, source: 'preset' });
  });
});

describe('escalation (Dig deeper) — audit 2026-09-26 routing-unify-2 / tests-gaps-8', () => {
  it('the gate owns NO escalation plan: decideComputePlan never takes escalationOf and the ONE resolver is compute-policy-wiring escalationPlan', () => {
    const gate = require('./compute-policy-gate');
    expect(gate.escalationPlan).toBeUndefined();
    expect(gate.nextRungAfter).toBeUndefined();
    expect(gate.isRefusedEscalation).toBeUndefined();
    const { escalationPlan } = require('../chat-agent/compute-policy-wiring');
    expect(escalationPlan('research', 90_000)).toMatchObject({ preset: 'deep_research', source: 'escalation', rung: 'research' });
    expect(escalationPlan('verify', 90_000)).toMatchObject({ preset: 'thinking', spawnChecker: true, checkerWaitMs: 90_000, source: 'escalation', rung: 'verify' });
    expect(depthBudgetFor(escalationPlan('verify', 90_000))).toMatchObject({ checker: true, council: false });
    expect(depthBudgetFor(escalationPlan('research', 90_000))).toMatchObject({ checker: false, council: true });
    expect(mockDecide).not.toHaveBeenCalled();
  });
});

describe('telemetry + stash', () => {
  it('recordComputePolicyTelemetry writes ONE compute_policy row with the plan + budget (ttft as value when known)', () => {
    const plan: DepthPlan = { ...presetPlan('thinking'), source: 'gate_act', spawnChecker: false, decisionId: 'd9', mode: 'act' };
    recordComputePolicyTelemetry(plan, { sessionId: 'chat1', ttftMs: 1234.6, completionMs: 5000 });
    expect(recordLoopMetric).toHaveBeenCalledTimes(1);
    const row = (recordLoopMetric as jest.Mock).mock.calls[0][0];
    expect(row).toMatchObject({ kind: 'compute_policy', sessionId: 'chat1', value: 1235, unit: 'ms' });
    expect(row.meta).toMatchObject({ planSource: 'gate_act', preset: 'thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', leadEffort: 'high', mode: 'act', decisionId: 'd9', ttftMs: 1235, completionMs: 5000 });
    expect(row.meta.budget).toEqual({ checker: false, checkerEffort: 'high', council: false, maxBackgroundMs: 15 * 60_000 }); // no maxUsd since 2026-09-27 — no cost cap
    recordComputePolicyTelemetry(presetPlan('single_thinking'));
    expect((recordLoopMetric as jest.Mock).mock.calls[1][0].value).toBeUndefined();
  });

  it('computePlanStash: the carried stash, else rebuilt from decisionId / mode / answers, else null', () => {
    const stash = { id: 'd1', purpose: 'compute_policy', mode: 'shadow', backend: 'b', answers: { depth: { type: 'choice', choice: 'ordinary', confidence: 0.6, probabilities: {} } }, decidedAt: 'now' } as any;
    expect(computePlanStash({ decisionId: 'd1', mode: 'shadow', answers: {}, stash })).toBe(stash);
    expect(computePlanStash({ decisionId: 'd2', mode: 'act', answers: stash.answers })).toMatchObject({ id: 'd2', purpose: 'compute_policy', mode: 'act', backend: 'unknown' });
    expect(computePlanStash({ mode: 'off' } as any)).toBeNull();
    expect(computePlanStash(null)).toBeNull();
  });
});

describe('decideDraftsAgree', () => {
  const drafts = { leadFinal: 'Paris is the capital of France.', checkerDraft: 'The capital of France is Paris.', chatId: 'chat1' };
  it('off / disabled / empty draft / null / throw ⇒ agree null', async () => {
    mockMode.mockReturnValue('off');
    expect(await decideDraftsAgree(drafts)).toEqual({ agree: null, p: null, mode: 'off' });
    mockMode.mockReturnValue('act');
    process.env.COMPUTE_POLICY_DISABLED = '1';
    expect(await decideDraftsAgree(drafts)).toEqual({ agree: null, p: null, mode: 'off' });
    delete process.env.COMPUTE_POLICY_DISABLED;
    expect(await decideDraftsAgree({ ...drafts, checkerDraft: '  ' })).toEqual({ agree: null, p: null, mode: 'act' });
    mockDecide.mockResolvedValue(null);
    expect(await decideDraftsAgree(drafts)).toEqual({ agree: null, p: null, mode: 'act' });
    mockDecide.mockRejectedValue(new Error('x'));
    expect(await decideDraftsAgree(drafts)).toEqual({ agree: null, p: null, mode: 'act' });
    expect(mockDecide).toHaveBeenCalledTimes(2);
  });

  it('act: agree ⇔ p ≥ 0.8 (env overridable); shadow carries mode shadow so the consumer runs the reconcile', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue({ id: 'a1', backend: 'TypeSafe Jev', ms: 5, mode: 'act', answers: { agree: { type: 'noul', noul: 0.8 } } });
    expect(await decideDraftsAgree(drafts)).toMatchObject({ agree: true, p: 0.8, mode: 'act', decisionId: 'a1', stash: { purpose: 'drafts_agree' } });
    mockDecide.mockResolvedValue({ id: 'a2', backend: 'TypeSafe Jev', ms: 5, mode: 'act', answers: { agree: { type: 'noul', noul: 0.79 } } });
    expect(await decideDraftsAgree(drafts)).toMatchObject({ agree: false, p: 0.79, mode: 'act' });
    mockDecide.mockResolvedValue({ id: 'a3', backend: 'readout', ms: 5, mode: 'shadow', answers: { agree: { type: 'noul', noul: 0.95 } } });
    expect(await decideDraftsAgree(drafts)).toMatchObject({ agree: true, p: 0.95, mode: 'shadow', decisionId: 'a3' });
    process.env.DECISION_GATE_THRESHOLD_DRAFTS_AGREE = '0.97';
    expect(await decideDraftsAgree(drafts)).toMatchObject({ agree: false, mode: 'shadow' });
    const state = mockDecide.mock.calls[0][0];
    expect(state).toEqual({ lead_final: drafts.leadFinal, checker_draft: drafts.checkerDraft });
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'drafts_agree', sessionId: 'chat1' });
  });
});

describe('revisionMaterialDeterministic', () => {
  const prev = 'Ottawa is the capital of Canada. The population was about 1,000,000 in 2021. You should file by April 30, 2026. It is not taxable.';
  it('wording / ordering / emphasis changes are NOT material', () => {
    const next = 'The capital of Canada is Ottawa — its population was roughly 1,000,000 in 2021. **You should file by April 30, 2026.** It is not taxable, to be clear.';
    expect(revisionMaterialDeterministic(prev, next)).toEqual({ material: false, changed: [] });
    expect(revisionMaterialDeterministic(prev, prev)).toEqual({ material: false, changed: [] });
    expect(revisionMaterialDeterministic(prev, `${prev}\n\n(Checked.)`)).toEqual({ material: false, changed: [] });
  });
  it('a changed number is material', () => {
    const r = revisionMaterialDeterministic(prev, prev.replace('1,000,000', '1,400,000'));
    expect(r.material).toBe(true);
    expect(r.changed).toEqual(['number: -1000000', 'number: +1400000']);
  });
  it('a changed date is material', () => {
    const r = revisionMaterialDeterministic(prev, prev.replace('April 30, 2026', 'June 15, 2026'));
    expect(r.material).toBe(true);
    expect(r.changed).toEqual(expect.arrayContaining(['date: -april 30 2026', 'date: +june 15 2026']));
    expect(revisionMaterialDeterministic('Due 2026-09-26.', 'Due 2026-10-26.').changed).toEqual(['date: -2026-09-26', 'date: +2026-10-26']);
  });
  it('a flipped negation is material; a contraction spelling is not', () => {
    const r = revisionMaterialDeterministic(prev, prev.replace('It is not taxable.', 'It is taxable.'));
    expect(r.material).toBe(true);
    expect(r.changed).toContain('negation: -not taxable');
    expect(revisionMaterialDeterministic("It isn't taxable.", 'It is not taxable.').material).toBe(false);
  });
  it('a changed named entity or recommendation is material', () => {
    expect(revisionMaterialDeterministic(prev, prev.replace('Ottawa', 'Toronto')).changed).toEqual(expect.arrayContaining(['entity: -ottawa', 'entity: +toronto']));
    const rec = revisionMaterialDeterministic('You should file early.', 'You should wait before filing.');
    expect(rec.material).toBe(true);
    expect(rec.changed).toEqual(expect.arrayContaining(['recommendation: -should file', 'recommendation: +should wait']));
  });
  it('review 2026-09-26: a unit-glued number (dosage), a bare yes/no or true/false flip and safe→unsafe / legal→illegal are material', () => {
    expect(revisionMaterialDeterministic('Take 200mg twice daily.', 'Take 400mg twice daily.')).toEqual({ material: true, changed: ['number: -200mg', 'number: +400mg'] });
    expect(revisionMaterialDeterministic('The answer is yes.', 'The answer is no.')).toEqual({ material: true, changed: ['polarity: -yes', 'polarity: +no'] });
    expect(revisionMaterialDeterministic('That claim is true.', 'That claim is false.')).toEqual({ material: true, changed: ['polarity: -true', 'polarity: +false'] });
    expect(revisionMaterialDeterministic('It is safe.', 'It is unsafe.')).toEqual({ material: true, changed: ['polarity: -safe', 'polarity: +unsafe'] });
    expect(revisionMaterialDeterministic('Mixing them is legal here.', 'Mixing them is illegal here.').changed).toEqual(expect.arrayContaining(['polarity: -legal', 'polarity: +illegal']));
    expect(revisionMaterialDeterministic('Limit is 10GB per user.', 'Limit is 20GB per user.').changed).toEqual(['number: -10gb', 'number: +20gb']);
    // The same tokens reordered / reworded stay NOT material; a spaced wording change next to a number is not a number change.
    expect(revisionMaterialDeterministic('Yes — take 200mg, it is safe.', 'It is safe: take 200mg. Yes.')).toEqual({ material: false, changed: [] });
    expect(revisionMaterialDeterministic('It was about 1,000,000 in 2021.', 'It was roughly 1,000,000 during 2021.')).toEqual({ material: false, changed: [] });
  });
  it('changed is bounded (≤ 12 entries, ≤ 80 chars each)', () => {
    const many = Array.from({ length: 30 }, (_, i) => `${i + 1}`).join(' ');
    const r = revisionMaterialDeterministic(many, 'none');
    expect(r.material).toBe(true);
    expect(r.changed.length).toBe(12);
    for (const c of r.changed) expect(c.length).toBeLessThanOrEqual(80);
  });

  // Audit gate-runtime-4 (2026-09-26): in prod the diff fired on EVERY real
  // reconcile (5/5 verdict rows source 'diff'; changed[] full of "+1/+2/+3",
  // "number: -00", "+$0") so the gate had zero rows. These are the probe's
  // formatting-only rewrites, pinned material:false.
  describe('audit gate-runtime-4: formatting-only rewrites are NOT material', () => {
    const cases: Array<[string, string, string]> = [
      ['paragraph → numbered list (same facts)', 'You can file online, by mail, or through an accountant. The deadline is April 30, 2026.', 'You have three options:\n1. File online\n2. File by mail\n3. Use an accountant\n\nThe deadline is April 30, 2026.'],
      ['"10:00" → "10 am", "17:00" → "5 pm"', 'The office opens at 10:00 and closes at 17:00.', 'The office opens at 10 am and closes at 5 pm.'],
      ['a markdown heading with a capitalised non-stopword', 'Rates went up 2% this year.', '## Mortgage rates\n\nRates went up 2% this year.'],
      ['bold the same entity + a "Note:" line', 'Ottawa announced the change in March 2026.', '**Ottawa** announced the change in March 2026.\n\nNote: this was confirmed by the ministry.'],
      ['bullets → prose with First / Second / Finally', '- Check the form\n- Sign it\n- Mail it', 'First, check the form. Second, sign it. Finally, mail it.'],
      ['"$1,200" → "$1 200" (spaced thousands)', 'It costs $1,200 per year.', 'It costs $1 200 per year.'],
      ['a list step gains a parenthetical', '1. Open the app\n2. Sign in\n3. Tap Settings', '1. Open the app\n2. Sign in (use your usual account)\n3. Tap Settings'],
      ['sentence-initial capital of a common noun', 'the rebate arrives quarterly.', 'Rebates arrive quarterly.'],
      ['the same fact as a markdown table', 'Fee: $50.', '| Item | Fee |\n|---|---|\n| Filing | $50 |'],
      ['a sentence-initial common noun swapped for another on reorder', 'Rebates arrive quarterly. Ottawa confirmed it.', 'Quarterly, rebates arrive. Ottawa confirmed it.'],
    ];
    it.each(cases)('%s', (_name, a, b) => {
      expect(revisionMaterialDeterministic(a, b)).toEqual({ material: false, changed: [] });
    });
    it('the real changes those formats can hide are still material (time, spaced currency, a list step\'s number, a sentence-initial entity REPLACED, a heading entity)', () => {
      expect(revisionMaterialDeterministic('Opens at 10:00.', 'Opens at 11 am.')).toEqual({ material: true, changed: ['time: -10:00', 'time: +11:00'] });
      expect(revisionMaterialDeterministic('Closes at 5 pm.', 'Closes at 17:30.')).toEqual({ material: true, changed: ['time: -17:00', 'time: +17:30'] });
      expect(revisionMaterialDeterministic('It costs $1 200 per year.', 'It costs $1,300 per year.')).toEqual({ material: true, changed: ['number: -$1200', 'number: +$1300'] });
      expect(revisionMaterialDeterministic('1. Take 2 tablets\n2. Wait 4 hours', '1. Take 3 tablets\n2. Wait 4 hours')).toEqual({ material: true, changed: ['number: -2', 'number: +3'] });
      expect(revisionMaterialDeterministic('Ottawa is the capital of Australia.', 'Canberra is the capital of Australia.')).toEqual({ material: true, changed: ['entity: -ottawa', 'entity: +canberra'] });
      expect(revisionMaterialDeterministic('The capital is Ottawa.', 'The capital is Canberra.')).toEqual({ material: true, changed: ['entity: -ottawa', 'entity: +canberra'] });
      expect(revisionMaterialDeterministic('## Rates in Ontario\n\nUp 2%.', '## Rates in Quebec\n\nUp 2%.')).toEqual({ material: true, changed: ['entity: -ontario', 'entity: +quebec'] });
      // An ALL-CAPS acronym at a sentence start is still a name.
      expect(revisionMaterialDeterministic('CRA confirmed it.', 'IRS confirmed it.')).toEqual({ material: true, changed: ['entity: -cra', 'entity: +irs'] });
      // Unprefixed numbers keep comma grouping only — two spaced numbers stay two numbers.
      expect(revisionMaterialDeterministic('In 2021 300 people came.', 'In 2021 400 people came.')).toEqual({ material: true, changed: ['number: -300', 'number: +400'] });
    });
    it('opts.denoise:false restores the pre-audit diff byte-for-byte', () => {
      const pre = { material: true, changed: ['number: -$1200', 'number: +$1', 'number: +200'] };
      expect(revisionMaterialDeterministic('It costs $1,200 per year.', 'It costs $1 200 per year.', { denoise: false })).toEqual(pre);
    });
  });
});

describe('revisionContradictsPrevious / revisionDiffEntries — the direction-aware reading (drafts_agree label semantics, 2026-09-26)', () => {
  const lead = 'Ottawa is the capital. The fee is $50, due April 30, 2026. You should file early. It is not taxable.';
  it('additions-only (the reconcile adopted the checker\'s extra detail) ⇒ NOT a contradiction, even though the symmetric diff is material', () => {
    const next = `${lead} Late filing adds a $20 penalty and Toronto offices close at 5pm.`;
    expect(revisionMaterialDeterministic(lead, next).material).toBe(true);
    expect(revisionDiffEntries(lead, next).every((e) => e.sign === '+')).toBe(true);
    expect(revisionContradictsPrevious(lead, next)).toBe(false);
  });
  it('a REPLACED or REMOVED claim (number / date / entity with a "-" entry) ⇒ contradiction', () => {
    expect(revisionContradictsPrevious(lead, lead.replace('$50', '$75'))).toBe(true);
    expect(revisionContradictsPrevious(lead, lead.replace('April 30, 2026', 'June 15, 2026'))).toBe(true);
    expect(revisionContradictsPrevious(lead, lead.replace('Ottawa', 'Toronto'))).toBe(true);
    expect(revisionContradictsPrevious(lead, lead.replace('The fee is $50, due April 30, 2026. ', ''))).toBe(true);
  });
  it('a polarity / negation / recommendation FLIP counts in EITHER direction; wording / order / emphasis never do', () => {
    expect(revisionContradictsPrevious(lead, lead.replace('It is not taxable.', 'It is taxable.'))).toBe(true);
    expect(revisionContradictsPrevious(lead, lead.replace('You should file early.', 'You should wait before filing.'))).toBe(true);
    expect(revisionContradictsPrevious('The answer is yes.', 'The answer is yes — and no doubt about it, none.')).toBe(true); // "+no" / "+none" polarity added ⇒ flip class
    expect(revisionContradictsPrevious(lead, `**${lead}** (checked)`)).toBe(false);
    expect(revisionContradictsPrevious(lead, lead)).toBe(false);
  });
  it('the untruncated entries decide: a removal past the 12-entry cap still contradicts', () => {
    const many = Array.from({ length: 14 }, (_, i) => `Item ${i + 1} costs $${(i + 1) * 10}.`).join(' ');
    const next = `${many.replace('$10.', '$11.')} Extra ${Array.from({ length: 14 }, (_, i) => `$${900 + i}`).join(' ')}`;
    expect(revisionMaterialDeterministic(many, next).changed.length).toBe(12);
    expect(revisionContradictsPrevious(many, next)).toBe(true);
  });
});

// Audit 2026-10-06 T6-1 / T6-2 (others.md F3, schooltime F2, spark F11): supervisor reconciles posted
// "Update to an earlier answer" addenda on changed[] like "number: -29z, +31z" (UTC clock stamps the
// checker re-stamped minutes later), "entity: +i'm" and additions-only elaborations.
describe('audit 2026-10-06 T6: UTC stamps / ids / contractions are not claims; only a CONTRADICTION is material', () => {
  it('"00:29Z" / "17:31:05Z" / "21:02 UTC" are clock times (never the number "29z"); a moved UTC stamp is drift — no number entry, no contradiction', () => {
    const a = 'Checked at 00:10Z, 00:29Z and 00:40Z — all 3 lanes idle (17:31:05Z read).';
    const b = 'Checked at 00:31Z, 00:33Z and 00:36Z — all 3 lanes idle (17:31 UTC read).';
    const entries = revisionDiffEntries(a, b);
    expect(entries.filter((e) => e.kind === 'number')).toEqual([]);
    expect(entries.every((e) => e.kind === 'time' && e.stamp === true)).toBe(true);
    expect(revisionMaterialDeterministic(a, b).changed).toEqual(['time: -0:10', 'time: -0:29', 'time: -0:40', 'time: +0:31', 'time: +0:33', 'time: +0:36']);
    expect(revisionContradictsPrevious(a, b)).toBe(false);
    // The same stamp with and without its suffix is the same clock.
    expect(revisionDiffEntries('Read at 21:02 UTC.', 'Read at 21:02:41Z.')).toEqual([]);
  });
  it('ISO timestamps split into date + clock; UUID / hex ids are never numbers', () => {
    expect(revisionDiffEntries('Last run 2026-10-06T00:29:13Z.', 'Last run 2026-10-06T00:31:02.120Z.')).toEqual([
      { kind: 'time', sign: '-', token: '0:29', stamp: true }, { kind: 'time', sign: '+', token: '0:31', stamp: true },
    ]);
    const ids = revisionDiffEntries('Receipt 54b84261-1234-4567-8901-abcdef012345, sha 1234abcd.', 'Receipt 9e1c13ea-2222-4567-8901-abcdef012345, sha 5678abcd.');
    expect(ids).toEqual([]);
    expect(revisionDiffEntries('Run chat-54b84261-1234-4567-8901-abcdef012345 idle.', 'Run chat-9e1c13ea-2222-4567-8901-abcdef012345 idle.')).toEqual([]);
    // A real number next to an id still compares.
    expect(revisionMaterialDeterministic('Lane 1234abcd ran 3 builds.', 'Lane 1234abcd ran 4 builds.').changed).toEqual(['number: -3', 'number: +4']);
  });
  it('pronoun contractions are not entities ("entity: +i\'m")', () => {
    expect(revisionDiffEntries('The lane is idle.', "The lane is idle, and I'm watching it — it's fine.")).toEqual([]);
  });
  it('a real clock correction still contradicts (spark e140faf5: 22:10Z is 3:10 PM PDT, not 5:10 PM); a replaced plain time too', () => {
    expect(revisionMaterialDeterministic('22:10Z is 5:10 PM PDT.', '22:10Z is 3:10 PM PDT.').changed).toEqual(['time: -17:10', 'time: +15:10']);
    expect(revisionContradictsPrevious('22:10Z is 5:10 PM PDT.', '22:10Z is 3:10 PM PDT.')).toBe(true);
    expect(revisionContradictsPrevious('Opens at 10:00.', 'Opens at 11 am.')).toBe(true);
  });
  it('decideRevisionMaterial: stamp drift and additions-only are NOT material; a removal / flip / new negation caveat still is', async () => {
    mockMode.mockReturnValue('off');
    expect(await decideRevisionMaterial('All idle (read 00:29Z).', 'All idle (read 00:31Z).')).toMatchObject({ material: false, source: 'diff', contradicts: false });
    expect(await decideRevisionMaterial('The VLAN is up.', 'The VLAN is up; MTU 9000 on all 4 ports.')).toMatchObject({ material: false, source: 'diff', contradicts: false });
    expect(await decideRevisionMaterial('The fee is $50.', 'The fee is $75.')).toMatchObject({ material: true, contradicts: true });
    expect(await decideRevisionMaterial('Take it with food.', 'Take it with food. Do not exceed 4 doses.')).toMatchObject({ material: true, contradicts: true });
    expect(await decideRevisionMaterial('The answer is yes.', 'The answer is no.')).toMatchObject({ material: true, contradicts: true });
  });
  it('REVISION_DIFF_STAMP_NOISE_DISABLED=1 restores the previous diff (the glued "29z" number) and contradiction', async () => {
    process.env.REVISION_DIFF_STAMP_NOISE_DISABLED = '1';
    expect(revisionMaterialDeterministic('All idle (read 00:29Z).', 'All idle (read 00:31Z).').changed).toEqual(expect.arrayContaining(['number: -29z', 'number: +31z']));
    expect(revisionContradictsPrevious('All idle (read 00:29Z).', 'All idle (read 00:31Z).')).toBe(true);
    expect(revisionDiffEntries('The lane is idle.', "The lane is idle, and I'm watching it.")).toEqual([{ kind: 'entity', sign: '+', token: "i'm" }]);
    mockMode.mockReturnValue('off');
    expect(await decideRevisionMaterial('All idle (read 00:29Z).', 'All idle (read 00:31Z).')).toMatchObject({ material: true, contradicts: true });
  });
});

describe('decideRevisionMaterial', () => {
  const prev = 'The fee is $50.';
  const same = 'The fee is $50, as before.';
  it('the deterministic diff decides first (source diff, no ask in ACT)', async () => {
    mockMode.mockReturnValue('act');
    const r = await decideRevisionMaterial(prev, 'The fee is $75.', { chatId: 'c' });
    expect(r).toEqual({ material: true, changed: ['number: -$50', 'number: +$75'], source: 'diff', contradicts: true });
    expect(mockDecide).not.toHaveBeenCalled();
  });
  it('drafts_agree label semantics (2026-09-26): a diff verdict carries the DIRECTION-AWARE `contradicts` — additions-only ⇒ false (audit 2026-10-06 T6-2: NOT material — no rewrite, no addendum), a replaced claim ⇒ true; gate / fallback verdicts carry none', async () => {
    mockMode.mockReturnValue('off');
    const added = await decideRevisionMaterial(prev, 'The fee is $50, and filing costs $20 on top.');
    expect(added).toEqual({ material: false, changed: ['number: +$20'], source: 'diff', contradicts: false });
    // REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED=1: any diff entry is material again (the pre-2026-10-06 verdict).
    process.env.REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED = '1';
    expect(await decideRevisionMaterial(prev, 'The fee is $50, and filing costs $20 on top.')).toEqual({ material: true, changed: ['number: +$20'], source: 'diff', contradicts: false });
    delete process.env.REVISION_MATERIAL_CONTRADICTS_ONLY_DISABLED;
    expect(await decideRevisionMaterial(prev, same)).not.toHaveProperty('contradicts');
    expect(mockDecide).not.toHaveBeenCalled();
  });

  // Audit gate-runtime-4: the diff fired on every real reconcile, so the
  // purpose had zero rows. In SHADOW a diff-decided reconcile now ALSO asks
  // the gate — for the row and the stash the thumbs / tap hooks label — while
  // the diff verdict stands untouched.
  describe('shadow ask on a diff-decided reconcile (audit gate-runtime-4)', () => {
    const changed = 'The fee is $75.';
    const answer = { id: 'r-shadow', backend: 'TypeSafe Jev', ms: 5, mode: 'shadow', answers: { material: { type: 'noul', noul: 0.9 } } };
    it('SHADOW: the diff verdict stands (material true, source diff) and the gate is asked once — decisionId / mode / stash filled for the row', async () => {
      mockMode.mockReturnValue('shadow');
      mockDecide.mockResolvedValue(answer);
      const r = await decideRevisionMaterial(prev, changed, { chatId: 'c' });
      expect(r).toMatchObject({ material: true, changed: ['number: -$50', 'number: +$75'], source: 'diff', decisionId: 'r-shadow', mode: 'shadow', stash: { id: 'r-shadow', purpose: 'revision_material', mode: 'shadow' } });
      expect(r.pending).toBeUndefined();
      expect(mockDecide).toHaveBeenCalledTimes(1);
      expect(mockDecide.mock.calls[0][0]).toEqual({ previous: prev, revised: changed });
      expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'revision_material', sessionId: 'c' });
    });
    it('deferShadowAsk: the verdict returns at once with `pending`; the stash lands on the SAME object when the ask resolves', async () => {
      mockMode.mockReturnValue('shadow');
      let resolveAsk: (v: any) => void = () => {};
      mockDecide.mockReturnValue(new Promise((res) => { resolveAsk = res; }));
      const r = await decideRevisionMaterial(prev, changed, { chatId: 'c', deferShadowAsk: true });
      expect(r).toMatchObject({ material: true, source: 'diff' });
      expect(r.decisionId).toBeUndefined();
      expect(r.pending).toBeInstanceOf(Promise);
      resolveAsk(answer);
      await r.pending;
      expect(r).toMatchObject({ material: true, source: 'diff', decisionId: 'r-shadow', mode: 'shadow', stash: { purpose: 'revision_material' } });
    });
    it('a null / throwing / hung ask leaves the diff verdict intact and `pending` still resolves (never rejects)', async () => {
      mockMode.mockReturnValue('shadow');
      mockDecide.mockResolvedValue(null);
      expect(await decideRevisionMaterial(prev, changed)).toEqual({ material: true, changed: ['number: -$50', 'number: +$75'], source: 'diff', contradicts: true });
      mockDecide.mockRejectedValue(new Error('gate down'));
      const r = await decideRevisionMaterial(prev, changed, { deferShadowAsk: true });
      await expect(r.pending).resolves.toBeUndefined();
      expect(r).toMatchObject({ material: true, source: 'diff' });
      expect(r.decisionId).toBeUndefined();
      mockDecide.mockImplementation(() => { throw new Error('sync boom'); });
      expect(await decideRevisionMaterial(prev, changed)).toEqual({ material: true, changed: ['number: -$50', 'number: +$75'], source: 'diff', contradicts: true });
    });
    it('no ask in ACT / OFF / under COMPUTE_POLICY_DISABLED (the pre-audit behaviour)', async () => {
      mockDecide.mockResolvedValue(answer);
      for (const mode of ['act', 'off'] as const) {
        mockMode.mockReturnValue(mode);
        expect(await decideRevisionMaterial(prev, changed)).toEqual({ material: true, changed: ['number: -$50', 'number: +$75'], source: 'diff', contradicts: true });
      }
      mockMode.mockReturnValue('shadow');
      process.env.COMPUTE_POLICY_DISABLED = '1';
      expect(await decideRevisionMaterial(prev, changed)).toEqual({ material: true, changed: ['number: -$50', 'number: +$75'], source: 'diff', contradicts: true });
      delete process.env.COMPUTE_POLICY_DISABLED;
      expect(mockDecide).not.toHaveBeenCalled();
    });
  });
  it("unchanged by the diff: off / disabled / null / throw ⇒ fallback = today's rewrite (material true)", async () => {
    mockMode.mockReturnValue('off');
    expect(await decideRevisionMaterial(prev, same)).toEqual({ material: true, changed: [], source: 'fallback' });
    mockMode.mockReturnValue('act');
    process.env.COMPUTE_POLICY_DISABLED = '1';
    expect(await decideRevisionMaterial(prev, same)).toEqual({ material: true, changed: [], source: 'fallback' });
    delete process.env.COMPUTE_POLICY_DISABLED;
    mockDecide.mockResolvedValue(null);
    expect(await decideRevisionMaterial(prev, same)).toEqual({ material: true, changed: [], source: 'fallback', mode: 'act' });
    mockDecide.mockRejectedValue(new Error('x'));
    expect(await decideRevisionMaterial(prev, same)).toEqual({ material: true, changed: [], source: 'fallback', mode: 'act' });
  });
  it('act: wording-only ⇔ noul ≤ 1−τ (0.15) ⇒ material false (source gate); above ⇒ material true; shadow ⇒ fallback with the decisionId', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue({ id: 'r1', backend: 'TypeSafe Jev', ms: 5, mode: 'act', answers: { material: { type: 'noul', noul: 0.15 } } });
    expect(await decideRevisionMaterial(prev, same, { chatId: 'c' })).toMatchObject({ material: false, changed: [], source: 'gate', decisionId: 'r1', mode: 'act', stash: { purpose: 'revision_material' } });
    mockDecide.mockResolvedValue({ id: 'r2', backend: 'TypeSafe Jev', ms: 5, mode: 'act', answers: { material: { type: 'noul', noul: 0.16 } } });
    expect(await decideRevisionMaterial(prev, same)).toMatchObject({ material: true, source: 'gate', decisionId: 'r2' });
    mockDecide.mockResolvedValue({ id: 'r3', backend: 'readout', ms: 5, mode: 'shadow', answers: { material: { type: 'noul', noul: 0.01 } } });
    expect(await decideRevisionMaterial(prev, same)).toMatchObject({ material: true, source: 'fallback', decisionId: 'r3', mode: 'shadow' });
    expect(mockDecide.mock.calls[0][0]).toEqual({ previous: prev, revised: same });
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'revision_material', sessionId: 'c' });
  });
});

describe('machine / supervisor senders (owner 2026-09-26: "default all chats to auto even supervisors")', () => {
  it('computeSegmentOf: explicit segment wins; machine ⇒ machine; else guest / user', () => {
    expect(computeSegmentOf({ guest: false })).toBe('user');
    expect(computeSegmentOf({ guest: true })).toBe('guest');
    expect(computeSegmentOf({ guest: false, machine: true })).toBe('machine');
    expect(computeSegmentOf({ guest: false, machine: true, segment: 'supervisor' })).toBe('supervisor');
    expect(computeSegmentOf({ guest: true, segment: 'garbage' as any })).toBe('guest');
  });

  it('the state names a machine / supervisor sender (sender_segment) and stays BYTE-IDENTICAL for human turns (no new key ⇒ memo keys unchanged)', () => {
    const human = computePolicyState(input({}));
    expect(human).not.toHaveProperty('sender_segment');
    expect(computePolicyState(input({ guest: true }))).not.toHaveProperty('sender_segment');
    expect(computePolicyState(input({ machine: true }))).toMatchObject({ sender_segment: 'machine' });
    expect(computePolicyState(input({ machine: true, segment: 'supervisor' }))).toMatchObject({ sender_segment: 'supervisor' });
    expect(computePolicyState(input({ segment: 'user' }))).not.toHaveProperty('sender_segment');
  });

  it('a machine ask in shadow ⇒ the preset plan with the decision carried (the harness applies the machine rails); allowDeepResearch false ⇒ no research council even when confident in act', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(answer({ research: 0.95, mode: 'shadow' }));
    const shadow = await decideComputePlan(input({ machine: true, segment: 'supervisor', requestedMode: 'thinking' }));
    expect(shadow).toMatchObject({ preset: 'thinking', spawnChecker: true, source: 'gate_shadow', decisionId: 'd1' });
    expect(mockDecide.mock.calls[0][0]).toMatchObject({ sender_segment: 'supervisor' });
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(answer({ research: 0.95, mode: 'act' }));
    const act = await decideComputePlan(input({ machine: true, requestedMode: 'thinking', allowDeepResearch: false }));
    expect(act.council).toBe('none');
  });

  it('recordComputePolicyTelemetry carries the harness extras (machine / segment) on the row', () => {
    recordComputePolicyTelemetry(presetPlan('thinking'), { sessionId: 'sup-1', extra: { guest: false, machine: true, segment: 'supervisor' } });
    const row = (recordLoopMetric as jest.Mock).mock.calls.at(-1)![0];
    expect(row.kind).toBe('compute_policy');
    expect(row.meta).toMatchObject({ machine: true, segment: 'supervisor', guest: false, preset: 'thinking', planSource: 'preset' });
  });
});

describe('2026-09-26 (audit) — the segment rides decide() opts and the plan / stash as a ROW stamp (never the state)', () => {
  it('decideComputePlan passes segment to decide() opts; the plan and its stash carry it; a human turn is segment user / guest with no state key', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(answer({ mode: 'shadow' }));
    const sup = await decideComputePlan(input({ machine: true, segment: 'supervisor', requestedMode: 'thinking' }));
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'compute_policy', segment: 'supervisor' });
    expect(sup.segment).toBe('supervisor');
    expect(sup.stash).toMatchObject({ id: 'd1', segment: 'supervisor' });
    expect(computePlanStash(sup)).toMatchObject({ id: 'd1', segment: 'supervisor' });
    mockDecide.mockClear();
    const guest = await decideComputePlan(input({ guest: true, userId: undefined, allowDeepResearch: false }));
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ segment: 'guest' });
    expect(guest.segment).toBe('guest');
    expect(mockDecide.mock.calls[0][0]).not.toHaveProperty('sender_segment');
    mockDecide.mockClear();
    expect((await decideComputePlan(input({}))).segment).toBe('user');
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ segment: 'user' });
  });

  it('computePlanStash: the compact { decisionId, mode, answers, segment } shape keeps a valid segment and drops garbage; a stash without one inherits the plan\'s, a stash with one keeps its own', () => {
    const answers = { depth: { type: 'choice', choice: 'ordinary', confidence: 0.8 } };
    expect(computePlanStash({ decisionId: 'x', mode: 'shadow', answers, segment: 'machine' })).toMatchObject({ id: 'x', segment: 'machine' });
    expect(computePlanStash({ decisionId: 'x', mode: 'shadow', answers, segment: 'nope' })).not.toHaveProperty('segment');
    expect(computePlanStash({ decisionId: 'x', mode: 'shadow', answers })).not.toHaveProperty('segment');
    const stash = { id: 'x', purpose: 'compute_policy' as const, mode: 'shadow' as const, backend: 'b', answers: answers as any, decidedAt: 'now' };
    expect(computePlanStash({ decisionId: 'x', mode: 'shadow', answers, stash, segment: 'supervisor' })).toMatchObject({ segment: 'supervisor' });
    expect(computePlanStash({ decisionId: 'x', mode: 'shadow', answers, stash: { ...stash, segment: 'machine' }, segment: 'supervisor' })).toMatchObject({ segment: 'machine' });
    expect(computePlanStash({ decisionId: 'x', mode: 'shadow', answers, stash })).not.toHaveProperty('segment');
  });

  it('a no-answer ask still stamps the segment on the preset plan (so the finalize can persist it)', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(null);
    const p = await decideComputePlan(input({ machine: true }));
    expect(p).toMatchObject({ source: 'preset', segment: 'machine' });
    expect(p.decisionId).toBeUndefined();
  });
});

describe('2026-09-26 audit — depth criteria shared with checker_route', () => {
  it('checker_route asks the SAME depth question (instructions + all four criteria) as compute_policy — a rewording on either side must be made on both', () => {
    const cp = computePolicyQuestions()[DEPTH_QUESTION] as any;
    const cr = buildCheckerRouteRequest({ message: 'x' }).questions[CHECKER_ROUTE_QUESTION] as any;
    expect(cr.type).toBe('choice');
    expect(cr.instructions).toBe(cp.instructions);
    expect(cr.criteria).toEqual(cp.criteria);
  });
});

describe('roster 2026-10-06 B-2 — compute_policy + drafts_agree asks retired on HUMAN turns', () => {
  const retiredRows = () => (recordLoopMetric as jest.Mock).mock.calls.map(c => c[0]).filter((r: any) => r.kind === 'decision_ask_retired');

  it('decideComputePlan: a turn the harness marks machine:false gets the PRESET plan (what OFF returns) with NO ask and one decision_ask_retired row', async () => {
    mockDecide.mockResolvedValue(answer({ pSimple: 0.95, stakes: 0.05, mode: 'act' }));
    mockMode.mockReturnValue('act');
    const plan = await decideComputePlan(input({ machine: false, requestedMode: 'thinking' }));
    expect(plan).toEqual(presetPlan('thinking'));
    expect(mockDecide).not.toHaveBeenCalled();
    expect(retiredRows()).toEqual([expect.objectContaining({ kind: 'decision_ask_retired', sessionId: 'chat1', meta: { purpose: 'compute_policy', site: 'send', segment: 'user' } })]);
    // a supervisor OWNER turn is a human turn too (segment supervisor, machine false)
    await decideComputePlan(input({ machine: false, segment: 'supervisor' }));
    expect(mockDecide).not.toHaveBeenCalled();
    expect(retiredRows().at(-1).meta).toMatchObject({ segment: 'supervisor' });
  });

  it('decideComputePlan: machine wakes (machine:true) and legacy callers (machine absent) still ask', async () => {
    mockDecide.mockResolvedValue(answer({ mode: 'shadow' }));
    await decideComputePlan(input({ machine: true, segment: 'supervisor' }));
    await decideComputePlan(input({}));
    expect(mockDecide).toHaveBeenCalledTimes(2);
    expect(retiredRows()).toHaveLength(0);
  });

  it('decideComputePlan: off ⇒ no row; kill switches restore the human ask (per purpose / all)', async () => {
    mockMode.mockReturnValue('off');
    await decideComputePlan(input({ machine: false }));
    expect(retiredRows()).toHaveLength(0);
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(answer({ mode: 'shadow' }));
    process.env.DECISION_GATE_COMPUTE_POLICY_HUMAN_RETIRE_LIFTED = '1';
    expect(await decideComputePlan(input({ machine: false }))).toMatchObject({ source: 'gate_shadow', decisionId: 'd1' });
    delete process.env.DECISION_GATE_COMPUTE_POLICY_HUMAN_RETIRE_LIFTED;
    process.env.DECISION_GATE_HUMAN_TURN_RETIRE_DISABLED = '1';
    expect(await decideComputePlan(input({ machine: false }))).toMatchObject({ source: 'gate_shadow' });
    expect(mockDecide).toHaveBeenCalledTimes(2);
    expect(retiredRows()).toHaveLength(0);
  });

  it('decideDraftsAgree: machine:false answers as OFF (the reconcile runs as today) with one retired row; machine:true / absent ask; the lift env restores', async () => {
    const drafts = { leadFinal: 'Paris is the capital of France.', checkerDraft: 'The capital of France is Paris.', chatId: 'chat1' };
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue({ id: 'a1', backend: 'TypeSafe Jev', ms: 5, mode: 'act', answers: { agree: { type: 'noul', noul: 0.95 } } });
    expect(await decideDraftsAgree({ ...drafts, machine: false })).toEqual({ agree: null, p: null, mode: 'off' });
    expect(mockDecide).not.toHaveBeenCalled();
    expect(retiredRows()).toEqual([expect.objectContaining({ sessionId: 'chat1', meta: { purpose: 'drafts_agree', site: 'reconcile' } })]);
    expect(await decideDraftsAgree({ ...drafts, machine: true })).toMatchObject({ agree: true, decisionId: 'a1' });
    expect(await decideDraftsAgree(drafts)).toMatchObject({ agree: true });
    process.env.DECISION_GATE_DRAFTS_AGREE_HUMAN_RETIRE_LIFTED = '1';
    expect(await decideDraftsAgree({ ...drafts, machine: false })).toMatchObject({ agree: true });
    expect(mockDecide).toHaveBeenCalledTimes(3);
  });
});
