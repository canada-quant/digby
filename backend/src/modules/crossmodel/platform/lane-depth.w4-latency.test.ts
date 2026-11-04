/**
 * audit 2026-10-08 W4-1b / W4-1c — lane-depth.ts latency pieces:
 *   - ttftLaneStamp: EVERY human turn's ux_ttft row is keyed by the lane the model pick evaluates (before, only canary /
 *     Quick / research turns carried a lane and every other Standard turn was bucketed 'checked' by its preset — the
 *     pick's prod latency evidence starved and the 5–10× optimistic bench number won);
 *   - standardLaneThinkingBudget: a harness-set Standard lane (lane depth A-2 'standard' / the A-4 fail-open) runs the
 *     'thinking' BUDGET (8 steps / 480 s) with its checker still off — the owner canary's Standard turns ran the Level 1
 *     budget (6 steps / 240 s): measured 14 d, n 13, completion p50 176 s / p75 260 s / p90 284 s, 5 of 13 over 240 s.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./decision-gate', () => ({
  decide: jest.fn(async () => null),
  decisionMode: () => 'shadow',
  decisionOptionThreshold: (_p: string, _o: string, fallback: number) => fallback,
  stashDecision: () => null,
}));
jest.mock('./model-evidence', () => ({ evidenceFrom: () => null, loadModelEvidence: async () => null }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: jest.fn(async () => null) }));

import { ttftLaneStamp, standardLaneThinkingBudget, laneFailOpenPlan, applyLaneDepth, laneDepthRowMeta } from './lane-depth';
import { chatProfile } from '../coding/agent-profiles';
import type { DepthPlan } from './compute-policy-gate';

const preset = (p: DepthPlan['preset'], spawnChecker: boolean, lane?: DepthPlan['lane']): DepthPlan =>
  ({ preset: p, spawnChecker, checkerWaitMs: 0, council: 'none', source: 'preset', reason: 'preset', ...(lane ? { lane } : {}) } as DepthPlan);

describe('W4-1b — ttftLaneStamp keys every human turn by the pick\'s lane', () => {
  afterEach(() => { delete process.env.UX_TTFT_LANE_ALWAYS_DISABLED; });

  it('a non-canary Standard-classified turn on the thinking preset is keyed STANDARD (was bucketed checked by its preset)', () => {
    expect(ttftLaneStamp(preset('thinking', true), { lane: 'standard' })).toEqual({ lane: 'standard', ranLane: 'checked', planLane: 'standard', laneSource: 'turn_plan' });
  });

  it('the harness-applied lane wins; a quick-ineligible turn is keyed by its pick lane (standard), never quick', () => {
    expect(ttftLaneStamp(preset('single_thinking', false, 'quick'), { lane: 'quick' })).toMatchObject({ lane: 'quick', laneSource: 'plan' });
    expect(ttftLaneStamp(preset('thinking', true), { lane: 'quick', modelPick: { lane: 'standard' } })).toMatchObject({ lane: 'standard', laneSource: 'pick' });
    expect(ttftLaneStamp(preset('thinking', true), { lane: 'quick' })).toMatchObject({ lane: 'standard', laneSource: 'turn_plan' });
  });

  it('a research read that ran without the council keys by what ran; no turn plan ⇒ the preset alias', () => {
    expect(ttftLaneStamp(preset('thinking', true), { lane: 'research' })).toMatchObject({ lane: 'checked', ranLane: 'checked', planLane: 'research' });
    expect(ttftLaneStamp(preset('deep_research', false), { lane: 'research' })).toMatchObject({ lane: 'research' });
    expect(ttftLaneStamp(preset('single_thinking', false), null)).toEqual({ lane: 'standard', ranLane: 'standard', laneSource: 'preset' });
    expect(ttftLaneStamp(preset('thinking', true), null)).toEqual({ lane: 'checked', ranLane: 'checked', laneSource: 'preset' });
  });

  it('UX_TTFT_LANE_ALWAYS_DISABLED=1 restores the plan.lane-only stamp', () => {
    process.env.UX_TTFT_LANE_ALWAYS_DISABLED = '1';
    expect(ttftLaneStamp(preset('thinking', true), { lane: 'standard' }).lane).toBeUndefined();
    expect(ttftLaneStamp(preset('single_thinking', false, 'quick'), { lane: 'quick' })).toMatchObject({ lane: 'quick', laneSource: 'legacy' });
  });
});

describe('W4-1c — a harness-set Standard lane runs the thinking BUDGET, checker still off', () => {
  afterEach(() => { delete process.env.STANDARD_LANE_THINKING_BUDGET_DISABLED; });
  // The owner canary's 8 plain turns (prod 10-08): lane_depth acted, every one ran preset single_thinking → 6 steps /
  // 240 s; 4 overran 240 s (262 / 259 / 581 / 289 s) and the FINAL TURN forced the answer.
  const canaryStandard = applyLaneDepth({
    plan: preset('thinking', true),
    turnPlan: { cls: { lane: 'standard', laneProbs: { quick: 0.02, standard: 0.95, checked: 0.02, research: 0.01 }, laneConfidence: 0.95, laneAveraged: true, needsLiveWeb: 0.7, stakes: 0.1, contested: 0.1, multiStep: 0.3, breadth: 1, followUp: null }, mode: 'shadow', stash: null },
    access: { acts: { checker: true, research: false, failOpen: true } }, eligible: true,
  }).plan;

  it('the replayed canary plan keeps its Level 1 alias and no checker, but gets the thinking budget', () => {
    expect(canaryStandard).toMatchObject({ preset: 'single_thinking', spawnChecker: false, lane: 'standard', source: 'turn_plan' });
    expect(standardLaneThinkingBudget(canaryStandard)).toBe(true);
    const profile = chatProfile(standardLaneThinkingBudget(canaryStandard) ? 'thinking' : 'single_thinking', false);
    expect(profile).toMatchObject({ maxSteps: 8, runDeadlineMs: 480_000, contextCharBudget: 100_000 });
    // 12 of the 13 measured Standard-lane turns finished inside 480 s (p90 284 s)
    expect([176_000, 260_000, 284_000, 262_000, 259_000, 289_000].every((ms) => ms < profile.runDeadlineMs!)).toBe(true);
  });

  it('the lane fail-open ("standard on the seat") gets it too; the Quick lane, a checked lane and a bare preset never do', () => {
    expect(standardLaneThinkingBudget(laneFailOpenPlan(preset('thinking', true)))).toBe(true);
    expect(standardLaneThinkingBudget(preset('single_thinking', false, 'quick'))).toBe(false);
    expect(standardLaneThinkingBudget(preset('thinking', true, 'checked'))).toBe(false);
    expect(standardLaneThinkingBudget(preset('single_thinking', false))).toBe(false); // a user's own Level 1 pick keeps Level 1
    expect(standardLaneThinkingBudget(null)).toBe(false);
  });

  it('the lane_depth row says which budget ran', () => {
    const meta = laneDepthRowMeta({ access: null, turnPlan: null, decision: null, ranPlan: canaryStandard as any, ranChecker: false, segment: 'user' });
    expect(meta).toMatchObject({ ranLane: 'standard', ranPreset: 'single_thinking', budget: 'thinking' });
  });

  it('STANDARD_LANE_THINKING_BUDGET_DISABLED=1 restores the Level 1 budget', () => {
    process.env.STANDARD_LANE_THINKING_BUDGET_DISABLED = '1';
    expect(standardLaneThinkingBudget(canaryStandard)).toBe(false);
    expect(laneDepthRowMeta({ access: null, turnPlan: null, decision: null, ranPlan: canaryStandard as any, ranChecker: false, segment: 'user' }).budget).toBeUndefined();
  });
});
