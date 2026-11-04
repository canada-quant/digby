/**
 * platform/lane-depth.ts — roster 2026-10-06 Team A (A-1 … A-4). Pins:
 *   - the store config defaults (every feature shadow, the OWNER canary when the row has no list; [] = nobody) and the
 *     per-feature act rule (act = everyone incl. guests, shadow = the canary only, off = nobody) + every kill switch;
 *   - A-2 Standard vs Checked: a checker is dropped only on a confident lower-lane read with stakes < 0.6, contested
 *     < 0.5 and no trait rule pointing up, and never on a follow-up in a checked / research session (2026-10-20
 *     hysteresis; LANE_CHECKER_FOLLOW_UP_DISABLED restores the drop); applyLaneDepth sets source 'turn_plan' / lane /
 *     preset; the checker model comes from the checker POOL in another family than the lead (the seat when the pool
 *     follows it);
 *   - A-3 research routing: the decision rule and routeResearchLane (no ask for a non-governed sender, research route,
 *     keyword Level 3 retired / kept under KEYWORD_L3_RETIRE_DISABLED, fail-open on no answer / timeout, denied on a
 *     clamp AND on a refused allowance verdict / a verdict-less guest (2026-10-20), the lane_research row);
 *   - A-4 the lane fail-open ("standard on the seat"), the quota keyed on the research lane, the lane ⇄ preset aliases;
 *   - A-1 the checker-material label and the lane_depth row.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
// decision-gate's static graph reaches config/env (process.exit without env) — the pure rules here never ask it.
jest.mock('./decision-gate', () => ({
  decide: jest.fn(async () => null),
  decisionMode: () => 'shadow',
  decisionOptionThreshold: (_p: string, _o: string, fallback: number) => fallback,
  stashDecision: () => null,
}));
jest.mock('./model-evidence', () => ({ evidenceFrom: () => null, loadModelEvidence: async () => null }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
const mockStoreGet: jest.Mock = jest.fn(async () => null);
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: (...a: any[]) => mockStoreGet(...a) }));

import {
  laneDepthConfigFrom, laneFeatureActs, laneDepthAccessFrom, laneDepthFor, laneDepthConfig, __resetLaneDepthConfigForTests,
  laneCheckerDecision, laneCheckerGuards, applyLaneDepth, researchDenyReason, laneCheckerFollowUpDisabled, laneFailOpenPlan, laneCheckerModel, researchLaneDecision, researchLaneGuards,
  routeResearchLane, laneToPreset, ranLaneOf, checkerMaterialLabel, laneDepthRowMeta, usableTurnPlan,
  LANE_CANARY_DEFAULT_USER_IDS, LANE_CHECKER_DEFAULT_GUARDS, LANE_RESEARCH_METRIC,
  type LaneDepthAccess, type ResearchRouteDeps,
} from './lane-depth';
import { presetPlan } from './compute-policy-gate';
import type { TurnClass, TurnPlan } from './turn-plan';

const OWNER = LANE_CANARY_DEFAULT_USER_IDS[0];
const ENV_KEYS = ['LANE_DEPTH_DISABLED', 'LANE_CHECKER_DISABLED', 'LANE_RESEARCH_ROUTING_DISABLED', 'LANE_FAIL_OPEN_DISABLED', 'KEYWORD_L3_RETIRE_DISABLED', 'TURN_PLAN_DISABLED',
  'LANE_STANDARD_THRESHOLD', 'LANE_CHECKER_STAKES_CEILING', 'LANE_CHECKER_CONTESTED_CEILING', 'LANE_RESEARCH_THRESHOLD', 'LANE_RESEARCH_EXPLICIT_FLOOR', 'QUICK_PRESET_FREE_DISABLED', 'LANE_CHECKER_POOL_DISABLED',
  'LANE_CHECKER_FOLLOW_UP_DISABLED'];
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; __resetLaneDepthConfigForTests(); mockStoreGet.mockReset(); mockStoreGet.mockResolvedValue(null); });

const cls = (over: Partial<TurnClass> & { probs?: Partial<Record<'quick' | 'standard' | 'checked' | 'research', number>> } = {}): TurnClass => {
  const probs = { quick: 0.02, standard: 0.95, checked: 0.02, research: 0.01, ...(over.probs ?? {}) };
  const lane = (Object.keys(probs) as Array<keyof typeof probs>).reduce((b, l) => (probs[l] > probs[b] ? l : b), 'quick');
  return { lane, laneProbs: probs, laneConfidence: probs[lane], laneAveraged: true, needsLiveWeb: 0.2, stakes: 0.2, contested: 0.05, multiStep: 0.3, breadth: 2, followUp: null, ...over } as TurnClass;
};
const tp = (c: TurnClass | null, over: Partial<TurnPlan> = {}): TurnPlan => ({ lane: c?.lane ?? 'checked', cls: c, roster: null, act: false, reason: 'test', mode: 'act', decisionId: 'tp-1', stash: { id: 'tp-1', purpose: 'turn_plan', mode: 'act', backend: 'jev', answers: {}, decidedAt: 'x', calibrated: true } as any, ...over } as TurnPlan);
const ACTS = (over: Partial<Record<'checker' | 'research' | 'failOpen', boolean>> = {}): Pick<LaneDepthAccess, 'acts'> => ({ acts: { checker: false, research: false, failOpen: false, ...over } });

describe('store config + the per-feature act rule', () => {
  it('defaults: every feature shadow, the OWNER canary when the row carries no list; an explicit [] is nobody', () => {
    const d = laneDepthConfigFrom(null);
    expect(d.modes).toEqual({ checker: 'shadow', research: 'shadow', failOpen: 'shadow' });
    expect(d.canaryUserIds).toEqual([OWNER]);
    expect(d.canaryDefault).toBe(true);
    const empty = laneDepthConfigFrom({ laneCanaryUserIds: [] });
    expect(empty.canaryUserIds).toEqual([]);
    expect(empty.canaryDefault).toBe(false);
    const set = laneDepthConfigFrom({ laneChecker: 'act', laneResearch: 'off', laneFailOpen: 'bogus', laneCanaryUserIds: ['u2', 'u2', ' ', 3] });
    expect(set.modes).toEqual({ checker: 'act', research: 'off', failOpen: 'shadow' });
    expect(set.canaryUserIds).toEqual(['u2']);
  });

  it('act = every sender (guests too); shadow = the canary only; off = nobody', () => {
    const cfg = laneDepthConfigFrom({ laneChecker: 'act', laneResearch: 'shadow', laneFailOpen: 'off' });
    expect(laneFeatureActs(cfg, 'checker', null)).toBe(true);
    expect(laneFeatureActs(cfg, 'checker', 'someone')).toBe(true);
    expect(laneFeatureActs(cfg, 'research', OWNER)).toBe(true);
    expect(laneFeatureActs(cfg, 'research', 'someone')).toBe(false);
    expect(laneFeatureActs(cfg, 'research', null)).toBe(false);
    expect(laneFeatureActs(cfg, 'failOpen', OWNER)).toBe(false);
    expect(laneDepthAccessFrom(cfg, OWNER)).toMatchObject({ canary: true, acts: { checker: true, research: true, failOpen: false } });
  });

  it.each([
    ['LANE_DEPTH_DISABLED', ['checker', 'research', 'failOpen']],
    ['TURN_PLAN_DISABLED', ['checker', 'research', 'failOpen']],
    ['LANE_CHECKER_DISABLED', ['checker']],
    ['LANE_RESEARCH_ROUTING_DISABLED', ['research']],
    ['LANE_FAIL_OPEN_DISABLED', ['failOpen']],
  ])('%s=1 turns %j off even in act', (key, off) => {
    const cfg = laneDepthConfigFrom({ laneChecker: 'act', laneResearch: 'act', laneFailOpen: 'act' });
    process.env[key] = '1';
    for (const f of ['checker', 'research', 'failOpen'] as const) expect(laneFeatureActs(cfg, f, OWNER)).toBe(!off.includes(f));
  });

  it('laneDepthConfig reads the store row once per 30 s; a read failure = the defaults (nothing widens on an error)', async () => {
    mockStoreGet.mockResolvedValueOnce({ laneChecker: 'act' });
    expect((await laneDepthConfig()).modes.checker).toBe('act');
    expect((await laneDepthConfig()).modes.checker).toBe('act');
    expect(mockStoreGet).toHaveBeenCalledTimes(1);
    __resetLaneDepthConfigForTests();
    mockStoreGet.mockRejectedValueOnce(new Error('db down'));
    const cfg = await laneDepthConfig();
    expect(cfg.modes.checker).toBe('shadow');
    expect((await laneDepthFor('someone')).acts).toEqual({ checker: false, research: false, failOpen: false });
  });
});

describe('A-2 — Standard vs Checked by lane', () => {
  it('a confident standard read with low stakes and no contest DROPS the checker', () => {
    expect(laneCheckerDecision(cls())).toMatchObject({ lane: 'standard', spawnChecker: false });
    // 2026-10-20 review: an UNANSWERED stakes / contested noul never drops the checker
    expect(laneCheckerDecision(cls({ stakes: null }))).toMatchObject({ lane: 'checked', spawnChecker: true, why: 'stakes / contested unanswered' });
    expect(laneCheckerDecision(cls({ contested: null }))).toMatchObject({ lane: 'checked', spawnChecker: true });
    // a not-acted quick read counts as lower-lane mass too
    expect(laneCheckerDecision(cls({ probs: { quick: 0.7, standard: 0.2, checked: 0.05, research: 0.05 } }))).toMatchObject({ lane: 'standard', spawnChecker: false });
  });

  it.each([
    ['high stakes', { stakes: 0.6 }, /stakes 0.60/],
    ['contested', { contested: 0.5 }, /contested 0.50/],
    ['low lower-lane mass', { probs: { quick: 0.1, standard: 0.6, checked: 0.29, research: 0.01 } }, /p\(quick\+standard\) 0.70 < 0.8/],
    ['lane checked', { probs: { quick: 0, standard: 0.3, checked: 0.7, research: 0 } }, /lane checked/],
    ['lane research', { probs: { quick: 0, standard: 0.1, checked: 0.2, research: 0.7 } }, /lane research/],
    ['the contested_broad trait rule', { contested: 0.95, breadth: 3 }, /trait rule contested_broad/],
  ])('%s KEEPS the checker', (_n, over, why) => {
    const d = laneCheckerDecision(cls(over as any))!;
    expect(d).toMatchObject({ lane: 'checked', spawnChecker: true });
    expect(d.why).toMatch(why);
  });

  it('2026-10-20 follow-up hysteresis: a follow-up (follow_up ≥ 0.5) in a CHECKED / RESEARCH session keeps the checker', () => {
    const followUp = cls({ followUp: 0.8 });
    for (const prior of ['checked', 'research'] as const) {
      const d = laneCheckerDecision(followUp, LANE_CHECKER_DEFAULT_GUARDS, { priorLane: prior })!;
      expect(d).toMatchObject({ lane: 'checked', spawnChecker: true });
      expect(d.why).toBe(`follow-up in a ${prior} session (follow_up 0.80 ≥ 0.5)`);
    }
    expect(laneCheckerDecision(cls({ followUp: 0.5 }), LANE_CHECKER_DEFAULT_GUARDS, { priorLane: 'checked' })!.spawnChecker).toBe(true);
  });

  it('…but a NEW topic, a standard / quick session, no session or no follow_up answer still drops it', () => {
    expect(laneCheckerDecision(cls({ followUp: 0.2 }), LANE_CHECKER_DEFAULT_GUARDS, { priorLane: 'checked' })).toMatchObject({ lane: 'standard', spawnChecker: false });
    expect(laneCheckerDecision(cls({ followUp: 0.9 }), LANE_CHECKER_DEFAULT_GUARDS, { priorLane: 'standard' })).toMatchObject({ lane: 'standard', spawnChecker: false });
    expect(laneCheckerDecision(cls({ followUp: 0.9 }), LANE_CHECKER_DEFAULT_GUARDS, { priorLane: 'quick' })).toMatchObject({ lane: 'standard', spawnChecker: false });
    expect(laneCheckerDecision(cls({ followUp: 0.9 }), LANE_CHECKER_DEFAULT_GUARDS, { priorLane: null })).toMatchObject({ lane: 'standard', spawnChecker: false });
    expect(laneCheckerDecision(cls({ followUp: 0.9 }))).toMatchObject({ lane: 'standard', spawnChecker: false });
    expect(laneCheckerDecision(cls({ followUp: null }), LANE_CHECKER_DEFAULT_GUARDS, { priorLane: 'research' })).toMatchObject({ lane: 'standard', spawnChecker: false });
  });

  it('LANE_CHECKER_FOLLOW_UP_DISABLED=1 restores the session-blind drop', () => {
    expect(laneCheckerFollowUpDisabled()).toBe(false);
    process.env.LANE_CHECKER_FOLLOW_UP_DISABLED = '1';
    expect(laneCheckerFollowUpDisabled()).toBe(true);
    expect(laneCheckerDecision(cls({ followUp: 0.9 }), LANE_CHECKER_DEFAULT_GUARDS, { priorLane: 'checked' })).toMatchObject({ lane: 'standard', spawnChecker: false });
  });

  it('applyLaneDepth threads the session lane: a follow-up in a checked session keeps the checker on the L2 preset; the preset stays thinking', () => {
    const l2 = presetPlan('thinking');
    const kept = applyLaneDepth({ plan: l2, turnPlan: tp(cls({ followUp: 0.9 })), access: ACTS({ checker: true }), eligible: true, priorLane: 'checked' });
    expect(kept).toMatchObject({ applied: 'checker', why: expect.stringMatching(/follow-up in a checked session/) });
    expect(kept.plan).toMatchObject({ preset: 'thinking', spawnChecker: true, lane: 'checked', source: 'turn_plan' });
    // no session lane (a legacy caller) ⇒ today's drop
    expect(applyLaneDepth({ plan: l2, turnPlan: tp(cls({ followUp: 0.9 })), access: ACTS({ checker: true }), eligible: true }).plan).toMatchObject({ lane: 'standard', spawnChecker: false });
  });

  it('no classification ⇒ null; the guard envs override the defaults (blank = unset)', () => {
    expect(laneCheckerDecision(null)).toBeNull();
    expect(laneCheckerGuards({})).toEqual(LANE_CHECKER_DEFAULT_GUARDS);
    expect(laneCheckerGuards({ LANE_STANDARD_THRESHOLD: '0.9', LANE_CHECKER_STAKES_CEILING: ' ', LANE_CHECKER_CONTESTED_CEILING: '0.3' })).toEqual({ lowerLaneThreshold: 0.9, stakesCeiling: 0.6, contestedCeiling: 0.3 });
  });

  it('applyLaneDepth (checker acts): standard ⇒ Level 1 shape, no checker, source turn_plan; checked on an L1 preset ⇒ Level 2 + checker', () => {
    const l2 = presetPlan('thinking');
    const std = applyLaneDepth({ plan: l2, turnPlan: tp(cls()), access: ACTS({ checker: true }), eligible: true });
    expect(std.applied).toBe('checker');
    expect(std.plan).toMatchObject({ preset: 'single_thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', lane: 'standard', source: 'turn_plan' });
    const l1 = presetPlan('single_thinking');
    const chk = applyLaneDepth({ plan: l1, turnPlan: tp(cls({ stakes: 0.9 })), access: ACTS({ checker: true }), eligible: true });
    expect(chk.plan).toMatchObject({ preset: 'thinking', spawnChecker: true, lane: 'checked', source: 'turn_plan' });
  });

  it('applyLaneDepth records only when the checker feature does not act / the turn is not eligible / the answer is uncalibrated', () => {
    const l2 = presetPlan('thinking');
    const rec = applyLaneDepth({ plan: l2, turnPlan: tp(cls()), access: ACTS(), eligible: true });
    expect(rec.applied).toBeNull();
    expect(rec.plan).toBe(l2);
    expect(rec.checker).toMatchObject({ spawnChecker: false });
    expect(applyLaneDepth({ plan: l2, turnPlan: tp(cls()), access: ACTS({ checker: true }), eligible: false }).applied).toBeNull();
    const uncal = tp(cls(), { stash: { calibrated: false } as any });
    expect(usableTurnPlan(uncal)).toBe(false);
    expect(applyLaneDepth({ plan: l2, turnPlan: uncal, access: ACTS({ checker: true }), eligible: true }).applied).toBeNull();
    expect(usableTurnPlan(tp(cls(), { mode: 'off' }))).toBe(false);
  });

  it('the checker MODEL: a pool that follows its seat keeps the seat; an admin pool gives the first usable model of ANOTHER family than the lead', () => {
    const card = (spec: string, family: string, servable = true) => [spec, { spec, family, servable, vision: true } as any] as const;
    const catalog = new Map([card('glm-5.3', 'glm'), card('cql:glm-x', 'glm'), card('cql:dead-ds', 'deepseek', false), card('cql:kimi', 'kimi')]);
    const familyOf = (s: string) => (s.includes('glm') ? 'glm' : s.includes('kimi') ? 'kimi' : 'other');
    expect(laneCheckerModel({ pool: { models: ['cql:kimi'], source: 'seats' }, catalog, lead: 'glm-5.3', seat: 'deepseek-flash', familyOf }).spec).toBe('deepseek-flash');
    expect(laneCheckerModel({ pool: { models: ['cql:glm-x', 'cql:dead-ds', 'cql:kimi'], source: 'pool' }, catalog, lead: 'glm-5.3', seat: 'deepseek-flash', familyOf })).toMatchObject({ spec: 'cql:kimi' });
    expect(laneCheckerModel({ pool: { models: ['cql:dead-ds'], source: 'pool' }, catalog, lead: 'glm-5.3', seat: 'deepseek-flash', familyOf }).spec).toBe('deepseek-flash');
  });
});

describe('A-4 — the lane fail-open and the aliases (the quota lane: chat-gate.test.ts)', () => {
  it('no usable turn plan + failOpen acts ⇒ "standard on the seat" (source lane_fail_open); the feature off ⇒ the preset', () => {
    const l2 = presetPlan('thinking');
    const fo = applyLaneDepth({ plan: l2, turnPlan: null, access: ACTS({ failOpen: true }), eligible: true });
    expect(fo.applied).toBe('fail_open');
    expect(fo.plan).toMatchObject({ preset: 'single_thinking', spawnChecker: false, checkerWaitMs: 0, council: 'none', lane: 'standard', source: 'lane_fail_open' });
    expect(fo.why).toBe('turn plan not in');
    expect(applyLaneDepth({ plan: l2, turnPlan: tp(null), access: ACTS({ failOpen: true }), eligible: true }).why).toBe('no classification');
    expect(applyLaneDepth({ plan: l2, turnPlan: null, access: ACTS({ checker: true }), eligible: true }).plan).toBe(l2);
    // a usable answer never takes the fail-open, even with only failOpen acting
    expect(applyLaneDepth({ plan: l2, turnPlan: tp(cls()), access: ACTS({ failOpen: true }), eligible: true }).applied).toBeNull();
    expect(laneFailOpenPlan(l2, 'x').reason).toMatch(/lane fail-open: standard on the seat \(x; was preset thinking\)/);
  });

  it('lane ⇄ preset aliases + the lane a plan ran', () => {
    expect(laneToPreset('quick')).toBe('single_thinking');
    expect(laneToPreset('standard')).toBe('single_thinking');
    expect(laneToPreset('checked')).toBe('thinking');
    expect(laneToPreset('research')).toBe('deep_research');
    expect(ranLaneOf(presetPlan('thinking'))).toBe('checked');
    expect(ranLaneOf(presetPlan('single_thinking'))).toBe('standard');
    expect(ranLaneOf(presetPlan('deep_research'))).toBe('research');
    expect(ranLaneOf({ ...presetPlan('single_thinking'), lane: 'quick' })).toBe('quick');
  });
});

describe('A-3 — research by lane', () => {
  it('the rule: argmax research ≥ 0.5, the near-tie / breadth-4 trait rule, an explicit request ≥ 0.2; else not research', () => {
    expect(researchLaneDecision(cls({ probs: { quick: 0, standard: 0.3, checked: 0.1, research: 0.6 } })).route).toBe('research');
    expect(researchLaneDecision(cls({ probs: { quick: 0, standard: 0.3, checked: 0.25, research: 0.45 } })).route).toBe('not_research');
    // the Quebec example: standard 0.365 vs research 0.355, breadth 4
    expect(researchLaneDecision(cls({ probs: { quick: 0, standard: 0.365, checked: 0.28, research: 0.355 }, breadth: 4, contested: 0.97 }))).toMatchObject({ route: 'research', why: expect.stringMatching(/near_tie_research_broad/) });
    expect(researchLaneDecision(cls({ probs: { quick: 0, standard: 0.7, checked: 0.05, research: 0.25 } }), { keywordReasonKey: 'research_requested' }).route).toBe('research');
    expect(researchLaneDecision(cls({ probs: { quick: 0, standard: 0.7, checked: 0.05, research: 0.25 } }), { keywordReasonKey: 'long_brief' }).route).toBe('not_research');
    expect(researchLaneDecision(null).route).toBe('no_answer');
    expect(researchLaneGuards({ LANE_RESEARCH_THRESHOLD: '0.4', LANE_RESEARCH_EXPLICIT_FLOOR: '' })).toEqual({ threshold: 0.4, explicitFloor: 0.2 });
  });

  const routing = (level: string, reasonKey = 'default_ensemble', extra: Record<string, unknown> = {}) => ({ level, reason: 'r', suggestCode: false, reasonKey, source: 'heuristic', ...extra });
  const BASE = { seam: 'web' as const, userId: OWNER, chatId: 'c1', message: 'explain the history of X', images: 0, documents: 0, autoRouted: true, segment: 'user', isSupervisorChat: false, isChild: false, escalation: false };
  const mkDeps = (plan: TurnPlan | null | 'hang', acts = true): ResearchRouteDeps & { rows: any[]; asked: jest.Mock } => {
    const rows: any[] = [];
    const asked = jest.fn(async () => (plan === 'hang' ? new Promise<TurnPlan | null>(() => {}) : plan));
    return {
      rows, asked,
      access: async () => ({ acts: { checker: false, research: acts, failOpen: false }, canary: acts, modes: { checker: 'shadow', research: 'shadow', failOpen: 'shadow' } }),
      facts: async () => ({ priorUserTurns: [], priorLane: null, turnIndex: 0 }),
      turnPlan: asked as any,
      codeIntent: () => false,
      record: (r) => { rows.push(r); },
    };
  };
  const RESEARCH = tp(cls({ probs: { quick: 0, standard: 0.2, checked: 0.1, research: 0.7 } }));
  const STANDARD = tp(cls());

  it('a sender research routing does not act for is never asked (no added latency), and nothing changes', async () => {
    const deps = mkDeps(RESEARCH, false);
    const r = await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking') }, deps);
    expect(r).toMatchObject({ route: 'not_governed', mode: 'thinking', turnPlan: null });
    expect(deps.asked).not.toHaveBeenCalled();
    expect(deps.rows).toHaveLength(0);
    for (const over of [{ isSupervisorChat: true }, { escalation: true }, { isChild: true }, { autoRouted: false }, { chatless: true }]) {
      const d2 = mkDeps(RESEARCH);
      expect((await routeResearchLane({ ...BASE, ...over, mode: 'thinking', routing: routing('thinking') }, d2)).route).toBe('not_governed');
      expect(d2.asked).not.toHaveBeenCalled();
    }
  });

  // integ/ghost-composer review fix (2026-10-22): the research route asked the CLOUD turn plan with a ghost chat's
  // message + prior user turns BEFORE the run, and handed the answer in as turnPlanPrefetched — so the run's own
  // ghost_skip never ran. A ghost turn is now never asked here, even for a sender the feature acts for.
  it('a GHOST turn is never asked — not_governed before the access read; no plan handed to the run, no row', async () => {
    const deps = mkDeps(RESEARCH);
    const access = jest.fn(deps.access);
    const r = await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking'), ghost: true }, { ...deps, access });
    expect(r).toMatchObject({ route: 'not_governed', mode: 'thinking', turnPlan: null, why: expect.stringMatching(/ghost/) });
    expect(deps.asked).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(deps.rows).toHaveLength(0);
    // a keyword Level 3 on a ghost chat keeps the router's level (nothing retired without the plan)
    expect(await routeResearchLane({ ...BASE, mode: 'deep_research', routing: routing('deep_research', 'research_requested'), ghost: true }, mkDeps(STANDARD))).toMatchObject({ route: 'not_governed', mode: 'deep_research' });
    // a guest's per-send ghost too
    const guest = mkDeps(RESEARCH);
    expect((await routeResearchLane({ ...BASE, userId: null, segment: 'guest', mode: 'thinking', routing: routing('thinking'), deepResearchAllowed: true, ghost: true }, guest)).route).toBe('not_governed');
    expect(guest.asked).not.toHaveBeenCalled();
  });

  it('ghost:false is today\'s route; CHAT_GHOST_MODE_DISABLED=1 (ghost off instance-wide) asks a ghost turn like any other', async () => {
    const plain = mkDeps(RESEARCH);
    expect((await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking'), ghost: false }, plain)).route).toBe('research');
    process.env.CHAT_GHOST_MODE_DISABLED = '1';
    try {
      const deps = mkDeps(RESEARCH);
      expect((await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking'), ghost: true }, deps)).route).toBe('research');
      expect(deps.asked).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.CHAT_GHOST_MODE_DISABLED;
    }
  });

  it('a confident research lane routes an Ensemble send to Level 3 (routing card + auto_turn_plan) and hands the plan to the run; the lane_research row records it', async () => {
    const deps = mkDeps(RESEARCH);
    const r = await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking') }, deps);
    expect(r).toMatchObject({ route: 'research', mode: 'deep_research', routingSource: 'auto_turn_plan', turnPlan: RESEARCH });
    expect(r.routing).toMatchObject({ level: 'deep_research', reasonKey: 'turn_plan_research', source: 'turn_plan' });
    // the ask ran preset-free (A-4): the turn plan decides the level itself
    expect((deps.asked.mock.calls[0] as any[])[1]).toMatchObject({ presetFree: true, requestedMode: 'thinking' });
    expect(deps.rows[0]).toMatchObject({ kind: LANE_RESEARCH_METRIC, sessionId: 'c1', meta: { seam: 'web', route: 'research', routed: 'deep_research', keywordLevel: 'thinking', lane: 'research', canary: true } });
  });

  it('a keyword Level 3 the turn plan does not call research is RETIRED to Ensemble; KEYWORD_L3_RETIRE_DISABLED=1 keeps it', async () => {
    const r = await routeResearchLane({ ...BASE, mode: 'deep_research', routing: routing('deep_research', 'research_requested') }, mkDeps(tp(cls({ probs: { quick: 0, standard: 0.9, checked: 0.05, research: 0.05 } }))));
    expect(r).toMatchObject({ route: 'keyword_retired', mode: 'thinking', routingSource: 'auto_turn_plan' });
    expect(r.routing).toMatchObject({ level: 'thinking', reasonKey: 'turn_plan_lane', source: 'turn_plan' });
    process.env.KEYWORD_L3_RETIRE_DISABLED = '1';
    const kept = await routeResearchLane({ ...BASE, mode: 'deep_research', routing: routing('deep_research') }, mkDeps(STANDARD));
    expect(kept).toMatchObject({ route: 'kept', mode: 'deep_research' });
  });

  it('fails OPEN: no answer, a timeout, an uncalibrated answer, a thrown dep ⇒ the router\'s level stands', async () => {
    expect(await routeResearchLane({ ...BASE, mode: 'deep_research', routing: routing('deep_research') }, mkDeps(null))).toMatchObject({ route: 'no_answer', mode: 'deep_research' });
    expect(await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking') }, mkDeps(tp(cls(), { stash: { calibrated: false } as any })))).toMatchObject({ route: 'no_answer', mode: 'thinking' });
    const thrower = { ...mkDeps(RESEARCH), facts: async () => { throw new Error('db'); } };
    // a facts failure degrades to an empty session, the ask still runs
    expect((await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking') }, thrower)).route).toBe('research');
    const broken = { ...mkDeps(RESEARCH), access: async () => { throw new Error('store'); } };
    expect(await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking') }, broken)).toMatchObject({ route: 'not_governed', mode: 'thinking' });
  });

  it('times out at the turn-plan bound and keeps the level', async () => {
    jest.useFakeTimers();
    try {
      const p = routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking') }, mkDeps('hang'));
      await jest.advanceTimersByTimeAsync(2000);
      expect(await p).toMatchObject({ route: 'no_answer', mode: 'thinking', why: expect.stringMatching(/timed out/) });
    } finally { jest.useRealTimers(); }
  });

  it('a research read on a clamped send (allowance denied) is DENIED; on a Level 3 send it is kept', async () => {
    expect(await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking', 'quota_exhausted', { clamped: 'quota' }) }, mkDeps(RESEARCH))).toMatchObject({ route: 'denied', mode: 'thinking' });
    expect(await routeResearchLane({ ...BASE, mode: 'deep_research', routing: routing('deep_research') }, mkDeps(RESEARCH))).toMatchObject({ route: 'kept', mode: 'deep_research' });
  });

  it('2026-10-20 the guest gap: a GUEST whose router said Level 2 (no clamp) is DENIED the council — the allowance verdict, not only the clamp', async () => {
    const deps = mkDeps(RESEARCH);
    const guest = await routeResearchLane({ ...BASE, userId: null, segment: 'guest', mode: 'thinking', routing: routing('thinking'), deepResearchAllowed: false, deepResearchDenyReason: 'guest_no_research' }, deps);
    expect(guest).toMatchObject({ route: 'denied', mode: 'thinking', why: expect.stringMatching(/deep research not allowed \(guest_no_research\)/) });
    expect(guest.routing).toMatchObject({ level: 'thinking' });
    expect(guest.routingSource).toBeUndefined();
    // 2026-10-20 review: a sender who can never be routed is answered WITHOUT the serial ask (the run asks it
    // concurrently with the context load) — no plan rides, and the row says it was not asked.
    expect(guest.turnPlan).toBeNull();
    expect(deps.rows[0].meta).toMatchObject({ route: 'denied', routed: 'thinking', guest: true, allowance: false, asked: false });
  });

  it('2026-10-20 review: the Quick guard reads the SESSION lane (roster) the run reads, not only the last answer\'s lane', async () => {
    const seen: Array<string | null> = [];
    const deps = { ...mkDeps(RESEARCH), guardLane: async () => 'checked' as const };
    const turnPlan = deps.turnPlan;
    deps.turnPlan = async (input: any, ctx: any) => { seen.push(ctx.priorLane); return turnPlan(input, ctx); };
    await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking') }, deps as any);
    expect(seen).toEqual(['checked']);
  });

  it('a quota-exhausted signed-in sender (router Level 2, no clamp) is DENIED; an allowed verdict routes', async () => {
    expect(await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking'), deepResearchAllowed: false, deepResearchDenyReason: 'quota_exhausted' }, mkDeps(RESEARCH))).toMatchObject({ route: 'denied', mode: 'thinking', why: expect.stringMatching(/quota_exhausted/) });
    expect(await routeResearchLane({ ...BASE, mode: 'thinking', routing: routing('thinking'), deepResearchAllowed: true }, mkDeps(RESEARCH))).toMatchObject({ route: 'research', mode: 'deep_research' });
    // a guest with an ALLOWED verdict (AUTO_ROUTE_ALLOWANCE_DISABLED keeps guests' keyword Level 3 too) follows the verdict
    expect(await routeResearchLane({ ...BASE, userId: null, mode: 'thinking', routing: routing('thinking'), deepResearchAllowed: true }, mkDeps(RESEARCH))).toMatchObject({ route: 'research' });
  });

  it('researchDenyReason: clamp first, then the verdict; with NO verdict a guest is denied and a signed-in sender is not', () => {
    expect(researchDenyReason({ routing: routing('thinking', 'x', { clamped: 'supervisor' }) as any, userId: 'u', deepResearchAllowed: true })).toBe('supervisor');
    expect(researchDenyReason({ routing: routing('thinking') as any, userId: 'u', deepResearchAllowed: false, deepResearchDenyReason: 'chatless_no_research' })).toBe('chatless_no_research');
    expect(researchDenyReason({ routing: routing('thinking') as any, userId: 'u', deepResearchAllowed: false })).toBe('not_allowed');
    expect(researchDenyReason({ routing: null, userId: null })).toBe('guest_no_research');
    expect(researchDenyReason({ routing: null, userId: 'u' })).toBeNull();
    expect(researchDenyReason({ routing: null, userId: 'u', deepResearchAllowed: true })).toBeNull();
  });

  it('a verdict never touches the keyword-retire or kept paths (a Level 3 send is kept; a not-research read on a keyword L3 is retired)', async () => {
    expect(await routeResearchLane({ ...BASE, mode: 'deep_research', routing: routing('deep_research'), deepResearchAllowed: false, deepResearchDenyReason: 'quota_exhausted' }, mkDeps(RESEARCH))).toMatchObject({ route: 'kept', mode: 'deep_research' });
    expect(await routeResearchLane({ ...BASE, mode: 'deep_research', routing: routing('deep_research', 'research_requested'), deepResearchAllowed: false }, mkDeps(STANDARD))).toMatchObject({ route: 'keyword_retired', mode: 'thinking' });
  });
});

describe('A-1 — the checker-material label + the lane_depth row', () => {
  const ran = (check: unknown, extra: Record<string, unknown> = {}) => ({ depth: { plan: { preset: 'thinking', spawnChecker: true }, facts: { checkerSpawned: true } }, check, ...extra });
  it('only where a checker ran; checked ⇒ nothing material; updated reads the T6 contradiction verdict', () => {
    expect(checkerMaterialLabel({ depth: { plan: { spawnChecker: false }, facts: { checkerSpawned: false } }, check: { state: 'updated', verdict: { contradicts: true } } })).toBeNull();
    expect(checkerMaterialLabel(ran({ state: 'checked' }))).toBe('nothing_material');
    expect(checkerMaterialLabel(ran({ state: 'updated', verdict: { material: true, source: 'diff', contradicts: true } }))).toBe('material');
    expect(checkerMaterialLabel(ran({ state: 'updated', verdict: { material: false, source: 'diff', contradicts: false } }))).toBe('nothing_material');
    expect(checkerMaterialLabel(ran({ state: 'interrupted' }))).toBeNull();
    expect(checkerMaterialLabel(null)).toBeNull();
  });
  it('an older updated row re-reads the kept previous answer through the injected contradiction diff; a gate verdict is material', () => {
    const contradicts = jest.fn((prev: string, next: string) => prev !== next);
    const row = ran({ state: 'updated', verdict: { material: true, source: 'diff' } }, { revision: { previousContent: 'A' } });
    expect(checkerMaterialLabel(row, 'B', contradicts)).toBe('material');
    expect(checkerMaterialLabel(row, 'A', contradicts)).toBe('nothing_material');
    expect(checkerMaterialLabel(row, 'B')).toBeNull();
    expect(checkerMaterialLabel(ran({ state: 'updated', verdict: { material: true, source: 'gate' } }))).toBe('material');
    expect(checkerMaterialLabel(ran({ state: 'updated', verdict: { material: true, source: 'fallback' } }))).toBeNull();
  });
  it('the lane_depth meta: the would-act per feature, what applied, what RAN', () => {
    const access: LaneDepthAccess = { acts: { checker: true, research: false, failOpen: false }, canary: true, modes: { checker: 'shadow', research: 'shadow', failOpen: 'shadow' } };
    const decision = applyLaneDepth({ plan: presetPlan('thinking'), turnPlan: tp(cls()), access, eligible: true });
    const meta = laneDepthRowMeta({ access, turnPlan: tp(cls()), decision, ranPlan: decision.plan, ranChecker: false, segment: 'user', routedLevel: 'thinking', keywordReasonKey: 'default_ensemble' });
    expect(meta).toMatchObject({ segment: 'user', canary: true, lane: 'standard', wouldChecker: false, wouldResearch: false, applied: 'checker', ranLane: 'standard', ranPreset: 'single_thinking', ranChecker: false, source: 'turn_plan', routedLevel: 'thinking' });
    expect(laneDepthRowMeta({ access: null, turnPlan: null, decision: null, ranPlan: presetPlan('thinking'), ranChecker: true, segment: 'guest' })).toMatchObject({ lane: null, applied: null, ranLane: 'checked' });
  });
  it('2026-10-20: the would-act on the row reads the same session lane (follow-up hysteresis) and records it', () => {
    const access: LaneDepthAccess = { acts: { checker: false, research: false, failOpen: false }, canary: false, modes: { checker: 'shadow', research: 'shadow', failOpen: 'shadow' } };
    const t = tp(cls({ followUp: 0.9 }));
    const meta = laneDepthRowMeta({ access, turnPlan: t, decision: null, ranPlan: presetPlan('thinking'), ranChecker: true, segment: 'user', priorLane: 'research' });
    expect(meta).toMatchObject({ wouldChecker: true, priorLane: 'research', followUp: 0.9, checkerWhy: expect.stringMatching(/follow-up in a research session/) });
    const none = laneDepthRowMeta({ access, turnPlan: t, decision: null, ranPlan: presetPlan('thinking'), ranChecker: true, segment: 'user' });
    expect(none).toMatchObject({ wouldChecker: false });
    expect(none).not.toHaveProperty('priorLane');
    expect(none).not.toHaveProperty('followUp');
  });
});
