/**
 * Quick-lane guard cutoffs — the 2026-10-03 replay defaults and their envs
 * (the shared leaf the consumer and the readiness ruler both read), plus the
 * 2026-10-20 lookup-conditioned stakes ceiling (a pure live lookup — live web
 * high, multi-step and contested low, all answered — gets 0.75; everything else
 * keeps 0.6; TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING ≤ the base restores today).
 */
import {
  DEFAULT_QUICK_LANE_GUARDS, QUICK_LANE_DEFAULT_THRESHOLD, QUICK_LANE_STAKES_CEILING, QUICK_LANE_CONTESTED_CEILING,
  QUICK_LANE_LOOKUP_STAKES_CEILING, QUICK_LANE_LOOKUP_WEB_FLOOR, QUICK_LANE_LOOKUP_MULTI_STEP_CEILING, QUICK_LANE_LOOKUP_CONTESTED_CEILING,
  ceilingFromEnv, quickLaneCeilings, isPureLookup, stakesCeilingFor, traitRound,
} from './quick-lane-guards';

describe('quick-lane guards', () => {
  it('defaults are the replay-set cutoffs: p(quick) 0.8, stakes < 0.6, contested < 0.5 (+ the 2026-10-20 lookup ceiling 0.75)', () => {
    expect([QUICK_LANE_DEFAULT_THRESHOLD, QUICK_LANE_STAKES_CEILING, QUICK_LANE_CONTESTED_CEILING]).toEqual([0.8, 0.6, 0.5]);
    expect(DEFAULT_QUICK_LANE_GUARDS).toEqual({ threshold: 0.8, stakesCeiling: 0.6, contestedCeiling: 0.5, lookupStakesCeiling: 0.75 });
    expect(quickLaneCeilings({})).toEqual({ stakesCeiling: 0.6, contestedCeiling: 0.5, lookupStakesCeiling: 0.75 });
  });
  it('a blank / garbage env is UNSET (compose passes blanks); values clamp to [0, 1]', () => {
    expect(ceilingFromEnv('', 0.6)).toBe(0.6);
    expect(ceilingFromEnv('  ', 0.6)).toBe(0.6);
    expect(ceilingFromEnv('abc', 0.6)).toBe(0.6);
    expect(ceilingFromEnv(undefined, 0.6)).toBe(0.6);
    expect(ceilingFromEnv('0.7', 0.6)).toBe(0.7);
    expect(ceilingFromEnv('1.5', 0.6)).toBe(1);
    expect(ceilingFromEnv('-1', 0.6)).toBe(0);
  });
  it('each ceiling has its OWN env (the generic purpose threshold env never moves a ceiling)', () => {
    expect(quickLaneCeilings({ TURN_PLAN_QUICK_STAKES_CEILING: '0.7', DECISION_GATE_THRESHOLD_TURN_PLAN: '0.95' })).toEqual({ stakesCeiling: 0.7, contestedCeiling: 0.5, lookupStakesCeiling: 0.75 });
    expect(quickLaneCeilings({ TURN_PLAN_QUICK_CONTESTED_CEILING: '0.4' })).toEqual({ stakesCeiling: 0.6, contestedCeiling: 0.4, lookupStakesCeiling: 0.75 });
    expect(quickLaneCeilings({ TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING: '0.7' })).toEqual({ stakesCeiling: 0.6, contestedCeiling: 0.5, lookupStakesCeiling: 0.7 });
    expect(quickLaneCeilings({ TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING: ' ' }).lookupStakesCeiling).toBe(0.75);
  });
});

describe('2026-10-20 — the lookup-conditioned stakes ceiling', () => {
  // The audit's weather turn: stakes 0.62 refused Quick (157 s on the preset). Its live-web / multi-step / contested
  // reads below are the shape the replay showed for live lookups.
  const WEATHER = { needsLiveWeb: 0.98, multiStep: 0.2, contested: 0.02 };
  // 'convert 10,000 USD' — a live lookup with real money at stake (0.81 in the 10-04 live suite).
  const FX = { needsLiveWeb: 0.95, multiStep: 0.2, contested: 0.02 };
  const G = quickLaneCeilings({});

  it('the lookup bounds are pinned: web ≥ 0.8, multi_step < 0.5, contested < 0.2, ceiling 0.75', () => {
    expect([QUICK_LANE_LOOKUP_WEB_FLOOR, QUICK_LANE_LOOKUP_MULTI_STEP_CEILING, QUICK_LANE_LOOKUP_CONTESTED_CEILING, QUICK_LANE_LOOKUP_STAKES_CEILING]).toEqual([0.8, 0.5, 0.2, 0.75]);
  });

  it('isPureLookup: all three traits answered and in bounds', () => {
    expect(isPureLookup(WEATHER)).toBe(true);
    expect(isPureLookup({ ...WEATHER, needsLiveWeb: 0.8 })).toBe(true);
    expect(isPureLookup({ ...WEATHER, needsLiveWeb: 0.79 })).toBe(false);
    expect(isPureLookup({ ...WEATHER, multiStep: 0.5 })).toBe(false);
    expect(isPureLookup({ ...WEATHER, multiStep: 0.6 })).toBe(false);
    expect(isPureLookup({ ...WEATHER, contested: 0.2 })).toBe(false);
    expect(isPureLookup({ ...WEATHER, contested: 0.3 })).toBe(false);
  });

  it('a missing / NaN trait never relaxes anything (a backend that did not answer a noul fails toward the base ceiling)', () => {
    expect(isPureLookup(null)).toBe(false);
    expect(isPureLookup(undefined)).toBe(false);
    expect(isPureLookup({ ...WEATHER, needsLiveWeb: null })).toBe(false);
    expect(isPureLookup({ ...WEATHER, multiStep: null })).toBe(false);
    expect(isPureLookup({ ...WEATHER, contested: null })).toBe(false);
    expect(isPureLookup({ needsLiveWeb: 0.98, contested: 0.02 })).toBe(false);
    expect(isPureLookup({ ...WEATHER, needsLiveWeb: NaN })).toBe(false);
    expect(stakesCeilingFor({ ...WEATHER, multiStep: null }, G)).toEqual({ ceiling: 0.6, lookup: false });
    expect(stakesCeilingFor({ ...WEATHER, needsLiveWeb: null }, G)).toEqual({ ceiling: 0.6, lookup: false });
  });

  it('the weather case passes (0.62 < 0.75); "convert 10,000 USD" (0.81) is still above the lookup ceiling', () => {
    const w = stakesCeilingFor(WEATHER, G);
    expect(w).toEqual({ ceiling: 0.75, lookup: true });
    expect(0.62 < w.ceiling).toBe(true);
    const fx = stakesCeilingFor(FX, G);
    expect(fx.lookup).toBe(true);
    expect(0.81 < fx.ceiling).toBe(false);
  });

  it('a non-lookup keeps the base ceiling: multi_step 0.6 or contested 0.3 ⇒ 0.6', () => {
    expect(stakesCeilingFor({ ...WEATHER, multiStep: 0.6 }, G)).toEqual({ ceiling: 0.6, lookup: false });
    expect(stakesCeilingFor({ ...WEATHER, contested: 0.3 }, G)).toEqual({ ceiling: 0.6, lookup: false });
    expect(stakesCeilingFor({ ...WEATHER, needsLiveWeb: 0.3 }, G)).toEqual({ ceiling: 0.6, lookup: false });
  });

  it('LOWERING the base ceiling tightens lookups by the same amount (an operator tightening Quick tightens lookups too)', () => {
    expect(stakesCeilingFor(WEATHER, quickLaneCeilings({ TURN_PLAN_QUICK_STAKES_CEILING: '0.5' }))).toEqual({ ceiling: 0.65, lookup: true });
    expect(stakesCeilingFor(WEATHER, quickLaneCeilings({ TURN_PLAN_QUICK_STAKES_CEILING: '0.4' }))).toEqual({ ceiling: 0.55, lookup: true });
  });

  it('traits are classified at the decision row\'s 3 dp (the readiness ruler reads the stored row)', () => {
    expect(isPureLookup({ ...WEATHER, multiStep: 0.4996 })).toBe(false); // stored as 0.5
    expect(isPureLookup({ ...WEATHER, needsLiveWeb: 0.7996 })).toBe(true); // stored as 0.8
    expect(traitRound(0.74951)).toBe(0.75);
    // identical to the row writer (decision-gate.ts compactAnswers: Number(v.toFixed(3))) at the half-way points
    for (const v of [0.7995, 0.4995, 0.1995, 0.5995, 0.7495]) expect(traitRound(v)).toBe(Number(v.toFixed(3)));
  });

  it('a legacy guards object without lookupStakesCeiling applies the base ceiling only', () => {
    expect(stakesCeilingFor(WEATHER, { stakesCeiling: 0.6 })).toEqual({ ceiling: 0.6, lookup: false });
    expect(stakesCeilingFor(WEATHER, { stakesCeiling: 0.6, contestedCeiling: 0.5, threshold: 0.8 } as any)).toEqual({ ceiling: 0.6, lookup: false });
  });

  it('TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING at / below the base restores today (rollback); a blank env is the default', () => {
    expect(stakesCeilingFor(WEATHER, quickLaneCeilings({ TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING: '0.6' }))).toEqual({ ceiling: 0.6, lookup: false });
    expect(stakesCeilingFor(WEATHER, quickLaneCeilings({ TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING: '0.5' }))).toEqual({ ceiling: 0.6, lookup: false });
    expect(stakesCeilingFor(WEATHER, quickLaneCeilings({ TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING: '' }))).toEqual({ ceiling: 0.75, lookup: true });
    // a base ceiling raised ABOVE the lookup one is the base everywhere (the lookup ceiling only ever relaxes)
    expect(stakesCeilingFor(WEATHER, quickLaneCeilings({ TURN_PLAN_QUICK_STAKES_CEILING: '0.8' }))).toEqual({ ceiling: 0.8, lookup: false });
    expect(stakesCeilingFor(WEATHER, quickLaneCeilings({ TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING: '0.8' }))).toEqual({ ceiling: 0.8, lookup: true });
  });
});
