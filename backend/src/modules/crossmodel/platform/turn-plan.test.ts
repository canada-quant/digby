/**
 * Dynamic roster phase 2 — the turn plan (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §4 B).
 * Jev classifies (one batched ask, the lane in both option orders); code picks
 * the models; only a confident QUICK lane acts.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockDecide = jest.fn();
let mockMode = 'shadow';
jest.mock('./decision-gate', () => ({
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: () => mockMode,
  decisionOptionThreshold: (_p: string, _o: string, fallback: number) => fallback,
  stashDecision: (r: any, purpose: string, opts: any) => (r ? { id: r.id, purpose, mode: r.mode, backend: r.backend, answers: r.answers, decidedAt: 'x', ...(opts?.extra ? { extra: opts.extra } : {}) } : null),
}));

const mockStoreGet: jest.Mock = jest.fn(async () => null);
jest.mock('../memory/context-store', () => ({ storeGet: (...a: any[]) => mockStoreGet(...a) }));

import type { ModelCard } from '../model-endpoints/model-catalog';
import {
  turnPlanQuestions, turnPlanState, classFromAnswers, presetLane, firstUsable, planRoster, quickLaneEligibility,
  decideTurnPlan, turnPlanMetadata, LANES, LANE_CRITERIA, TURN_PLAN_MESSAGE_CHARS, QUICK_LANE_MAX_MESSAGE_CHARS,
  turnPlanCanaryIncludes, __resetTurnPlanCanaryForTests, quickLaneGuards,
} from './turn-plan';

const card = (spec: string, over: Partial<ModelCard> = {}): ModelCard => ({
  spec, name: spec, source: 'registry', family: 'other', tier: 'standard', vision: false, contextChars: null, maxTools: null,
  priceIn: null, priceOut: null, frontier: false, autoEligible: true, servable: true, thinkingOff: false, ...over,
});
const CATALOG = new Map<string, ModelCard>([
  ['q-flash', card('q-flash', { family: 'qwen', tier: 'fast' })],
  ['q-27b', card('q-27b', { family: 'qwen', tier: 'fast', vision: true })],
  ['glm-flash', card('glm-flash', { family: 'glm', tier: 'fast', vision: true })],
  ['ds-flash', card('ds-flash', { family: 'deepseek', tier: 'fast' })],
  ['glm-check', card('glm-check', { family: 'glm' })],
  ['kimi', card('kimi', { family: 'kimi' })],
  ['dead', card('dead', { servable: false })],
]);
const POOLS = {
  quick: { models: ['q-flash', 'q-27b'] },
  lead: { models: ['glm-flash'] },
  checker: { models: ['glm-check', 'ds-flash'] },
  colleague: { models: ['ds-flash', 'kimi', 'dead', 'glm-check', 'q-27b'] },
};
const choice = (probs: Record<string, number>) => ({ type: 'choice', choice: Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0], probabilities: probs, confidence: Math.max(...Object.values(probs)) });

describe('turnPlanQuestions', () => {
  it('asks the lane twice — forward and REVERSED option order — plus the traits; follow_up only with earlier turns', () => {
    const q = turnPlanQuestions(false);
    expect(Object.keys((q.lane as any).criteria)).toEqual(['quick', 'standard', 'checked', 'research']);
    expect(Object.keys((q.lane_rev as any).criteria)).toEqual(['research', 'checked', 'standard', 'quick']);
    expect((q.lane as any).criteria.quick).toBe(LANE_CRITERIA.quick);
    expect(Object.keys(q)).toEqual(['lane', 'lane_rev', 'needs_live_web', 'stakes', 'contested', 'multi_step', 'breadth']);
    expect(q.breadth.type).toBe('score');
    expect(Object.keys(turnPlanQuestions(true))).toContain('follow_up');
  });
  it('the lane descriptions name the owner examples: weather is quick; a broad history with several perspectives is research', () => {
    expect(LANE_CRITERIA.quick).toMatch(/weather/);
    expect(LANE_CRITERIA.research).toMatch(/history or analysis of a broad topic with several perspectives/);
  });
});

describe('turnPlanState', () => {
  it('caps the message and prior turns, names attachments, never carries document text', () => {
    const st = turnPlanState({ message: 'x'.repeat(5000), priorUserTurns: ['a', 'b'.repeat(900), 'c'], images: 1, documents: 2, priorLane: 'checked', turnIndex: 3 });
    expect(String(st.message)).toHaveLength(TURN_PLAN_MESSAGE_CHARS);
    expect(st.previous_user_messages).toEqual(['b'.repeat(400), 'c']);
    expect(st).toMatchObject({ previous_answer_lane: 'checked', turn_in_chat: 4, attachments: 'images and documents' });
    expect(JSON.stringify(turnPlanState({ message: 'hi', priorUserTurns: [], images: 0, documents: 0, turnIndex: 0 }))).toBe('{"message":"hi","turn_in_chat":1,"attachments":"none"}');
  });
});

describe('classFromAnswers', () => {
  it('averages the two orderings (position bias) and takes the argmax', () => {
    const c = classFromAnswers({
      lane: choice({ quick: 0.6, standard: 0.2, checked: 0.1, research: 0.1 }) as any,
      lane_rev: choice({ quick: 0.4, standard: 0.4, checked: 0.1, research: 0.1 }) as any,
      stakes: { type: 'noul', noul: 0.1 }, contested: { type: 'noul', noul: 0.05 }, needs_live_web: { type: 'noul', noul: 0.9 }, multi_step: { type: 'noul', noul: 0.2 },
      breadth: { type: 'score', score: 0.2, probabilities: {}, confidence: 0.8 } as any,
    })!;
    expect(c.lane).toBe('quick');
    expect(c.laneConfidence).toBeCloseTo(0.5);
    expect(c.laneAveraged).toBe(true);
    expect(c).toMatchObject({ stakes: 0.1, contested: 0.05, needsLiveWeb: 0.9, multiStep: 0.2, breadth: 1, followUp: null });
  });
  it('one ordering alone still classifies; no lane answer ⇒ null', () => {
    expect(classFromAnswers({ lane_rev: choice({ quick: 0.1, standard: 0.1, checked: 0.1, research: 0.7 }) as any })!.lane).toBe('research');
    expect(classFromAnswers({ stakes: { type: 'noul', noul: 0.5 } } as any)).toBeNull();
    expect(classFromAnswers(null)).toBeNull();
  });
  it('breadth maps score 0..3 → 1..4 (clamped)', () => {
    const b = (score: number) => classFromAnswers({ lane: choice({ quick: 1, standard: 0, checked: 0, research: 0 }) as any, breadth: { type: 'score', score, probabilities: {}, confidence: 1 } as any })!.breadth;
    expect([b(0), b(1.4), b(2.6), b(3), b(9)]).toEqual([1, 2, 4, 4, 4]);
  });
});

describe('presetLane', () => {
  it('maps the resolved preset to its lane (the silent-gate fallback)', () => {
    expect(['single_thinking', 'thinking', 'deep_research', 'deep_research_all', 'x'].map(presetLane)).toEqual(['standard', 'checked', 'research', 'research', 'standard']);
  });
});

describe('firstUsable / planRoster', () => {
  it('skips an unservable model; vision picks the first vision model', () => {
    expect(firstUsable(['dead', 'q-flash'], CATALOG)).toBe('q-flash');
    expect(firstUsable(['q-flash', 'q-27b'], CATALOG, { vision: true })).toBe('q-27b');
  });
  it('quick → the quick pool, alone', () => {
    expect(planRoster('quick', null, POOLS, CATALOG)).toMatchObject({ lead: 'q-flash', leadPool: 'quick', checker: null, colleagues: [] });
  });
  it('checked → a checker of a DIFFERENT family than the lead (glm lead ⇒ deepseek, not glm)', () => {
    const r = planRoster('checked', null, POOLS, CATALOG)!;
    expect(r).toMatchObject({ lead: 'glm-flash', leadPool: 'lead', checker: 'ds-flash' });
    expect(r.reason).toMatch(/different family/);
  });
  it('research → clamp(breadth, 2, 4) servable colleagues in pool order', () => {
    expect(planRoster('research', { breadth: 1 }, POOLS, CATALOG)!.colleagues).toEqual(['ds-flash', 'kimi']);
    expect(planRoster('research', { breadth: 4 }, POOLS, CATALOG)!.colleagues).toEqual(['ds-flash', 'kimi', 'glm-check', 'q-27b']);
  });
  it('an empty pool plans nothing', () => {
    expect(planRoster('quick', null, { ...POOLS, quick: { models: [] } }, CATALOG)).toBeNull();
  });
});

describe('quickLaneEligibility', () => {
  const cls = classFromAnswers({ lane: choice({ quick: 0.8, standard: 0.1, checked: 0.05, research: 0.05 }) as any, stakes: { type: 'noul', noul: 0.1 }, contested: { type: 'noul', noul: 0.1 } } as any)!;
  const ctx = { messageChars: 40, images: 0, documents: 0, mode: 'thinking', escalation: false, supervisor: false, machine: false };
  it('a confident, short, low-stakes, uncontested human turn qualifies', () => expect(quickLaneEligibility(cls, ctx).ok).toBe(true));
  it.each([
    ['below threshold', { ...cls, laneConfidence: 0.6 }, ctx],
    ['not quick', { ...cls, lane: 'standard' as const }, ctx],
    ['stakes', { ...cls, stakes: 0.6 }, ctx],
    ['contested', { ...cls, contested: 0.5 }, ctx],
    ['long message', cls, { ...ctx, messageChars: QUICK_LANE_MAX_MESSAGE_CHARS + 1 }],
    ['images', cls, { ...ctx, images: 1 }],
    ['documents', cls, { ...ctx, documents: 1 }],
    ['council preset', cls, { ...ctx, mode: 'deep_research' }],
    ['dig deeper', cls, { ...ctx, escalation: true }],
    ['supervisor', cls, { ...ctx, supervisor: true }],
    ['machine', cls, { ...ctx, machine: true }],
  ])('refused: %s', (_n, c, x) => {
    expect(quickLaneEligibility(c as any, x as any).ok).toBe(false);
  });
  it('roster 2026-10-06 A-4: a presetFree ask (the controller research route) skips the Level 1 / 2 preset check — every other guard holds', () => {
    expect(quickLaneEligibility(cls, { ...ctx, mode: 'deep_research' }).ok).toBe(false);
    expect(quickLaneEligibility(cls, { ...ctx, mode: 'deep_research', presetFree: true }).ok).toBe(true);
    expect(quickLaneEligibility({ ...cls, stakes: 0.6 } as any, { ...ctx, mode: 'deep_research', presetFree: true }).ok).toBe(false);
  });
});

describe('decideTurnPlan', () => {
  const deps = { pools: async () => POOLS as any, catalog: async () => [...CATALOG.values()] };
  const input = { message: "what's the weather in Toronto?", priorUserTurns: [], images: 0, documents: 0, turnIndex: 0, sessionId: 'c1' };
  const ctx = { messageChars: 30, images: 0, documents: 0, mode: 'thinking', escalation: false, supervisor: false, machine: false, requestedMode: 'thinking' };
  const quickAnswers = { lane: choice({ quick: 0.85, standard: 0.1, checked: 0.03, research: 0.02 }), lane_rev: choice({ quick: 0.8, standard: 0.1, checked: 0.05, research: 0.05 }), stakes: { type: 'noul', noul: 0.05 }, contested: { type: 'noul', noul: 0.02 } };
  beforeEach(() => { mockDecide.mockReset(); mockMode = 'shadow'; delete process.env.TURN_PLAN_DISABLED; delete process.env.QUICK_LANE_DISABLED; });

  it('SHADOW: classifies + plans the roster, never acts', async () => {
    mockDecide.mockResolvedValue({ id: 'd1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 180, answers: quickAnswers });
    const p = await decideTurnPlan(input, ctx, deps);
    expect(p).toMatchObject({ lane: 'quick', act: false, mode: 'shadow', decisionId: 'd1', roster: { lead: 'q-flash', leadPool: 'quick' } });
    expect(p.reason).toMatch(/quick eligible/);
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'turn_plan', timeoutMs: 1200, sessionId: 'c1' });
  });
  it('ACT: a confident eligible quick lane acts', async () => {
    mockMode = 'act';
    mockDecide.mockResolvedValue({ id: 'd2', mode: 'act', backend: 'TypeSafe Jev', ms: 150, answers: quickAnswers });
    expect(await decideTurnPlan(input, ctx, deps)).toMatchObject({ lane: 'quick', act: true, roster: { lead: 'q-flash' } });
  });
  it('ACT but an uncalibrated answer (decide downgraded it to shadow) never acts', async () => {
    mockMode = 'act';
    mockDecide.mockResolvedValue({ id: 'd3', mode: 'shadow', backend: 'readout', ms: 900, answers: quickAnswers });
    expect((await decideTurnPlan(input, ctx, deps)).act).toBe(false);
  });
  it('ACT on a non-quick lane records the lane, never acts', async () => {
    mockMode = 'act';
    mockDecide.mockResolvedValue({ id: 'd4', mode: 'act', backend: 'TypeSafe Jev', ms: 150, answers: { lane: choice({ quick: 0.05, standard: 0.05, checked: 0.1, research: 0.8 }), breadth: { type: 'score', score: 2, probabilities: {}, confidence: 0.9 } } });
    const p = await decideTurnPlan({ ...input, message: 'explain the history of why Canadians are for or against Quebec sovereignty' }, ctx, deps);
    expect(p).toMatchObject({ lane: 'research', act: false });
    expect(p.roster!.colleagues).toHaveLength(3);
  });
  it('QUICK_LANE_DISABLED=1 never acts; TURN_PLAN_DISABLED=1 never asks; off never asks; no answer ⇒ the preset lane', async () => {
    mockMode = 'act';
    mockDecide.mockResolvedValue({ id: 'd5', mode: 'act', backend: 'TypeSafe Jev', ms: 150, answers: quickAnswers });
    process.env.QUICK_LANE_DISABLED = '1';
    expect((await decideTurnPlan(input, ctx, deps)).act).toBe(false);
    delete process.env.QUICK_LANE_DISABLED;
    process.env.TURN_PLAN_DISABLED = '1';
    expect(await decideTurnPlan(input, ctx, deps)).toMatchObject({ act: false, lane: 'checked', reason: 'TURN_PLAN_DISABLED' });
    delete process.env.TURN_PLAN_DISABLED;
    mockMode = 'off';
    mockDecide.mockClear();
    expect((await decideTurnPlan(input, ctx, deps)).reason).toBe('purpose off');
    expect(mockDecide).not.toHaveBeenCalled();
    mockMode = 'shadow';
    mockDecide.mockResolvedValue(null);
    expect(await decideTurnPlan(input, ctx, deps)).toMatchObject({ lane: 'checked', act: false, cls: null });
  });
  it('never throws: a decide error ⇒ the preset lane', async () => {
    mockDecide.mockRejectedValue(new Error('boom'));
    expect(await decideTurnPlan(input, { ...ctx, requestedMode: 'single_thinking' }, deps)).toMatchObject({ lane: 'standard', act: false, reason: 'error' });
  });
});

describe('turnPlanMetadata', () => {
  it('compacts the plan for the answer row (lane, act, probabilities, traits, roster, stash)', () => {
    const cls = classFromAnswers({ lane: choice({ quick: 0.8, standard: 0.1, checked: 0.05, research: 0.05 }) as any, stakes: { type: 'noul', noul: 0.1234 } } as any)!;
    const m = turnPlanMetadata({ lane: 'quick', cls, roster: { lead: 'q-flash', leadPool: 'quick', checker: null, colleagues: [], reason: 'r' }, act: true, reason: 'x', mode: 'act', decisionId: 'd1', stash: { id: 'd1' } as any })!;
    expect(m).toMatchObject({ lane: 'quick', act: true, mode: 'act', decisionId: 'd1', roster: { lead: 'q-flash', leadPool: 'quick', checker: null, colleagues: [] }, stash: { id: 'd1' } });
    expect((m.laneProbs as any).quick).toBe(0.8);
    expect((m.traits as any).stakes).toBe(0.123);
    expect(turnPlanMetadata(null)).toBeNull();
    expect(LANES).toEqual(['quick', 'standard', 'checked', 'research']);
  });
});

describe('2026-10-03 hardening — replay-set guards, code intent, session hysteresis', () => {
  const mk = (p: number, over: Record<string, number> = {}) => classFromAnswers({
    lane: choice({ quick: p, standard: (1 - p) / 3, checked: (1 - p) / 3, research: (1 - p) / 3 }) as any,
    stakes: { type: 'noul', noul: over.stakes ?? 0.1 }, contested: { type: 'noul', noul: over.contested ?? 0.05 },
    ...(over.followUp !== undefined ? { follow_up: { type: 'noul', noul: over.followUp } } : {}),
  } as any)!;
  const ctx = { messageChars: 40, images: 0, documents: 0, mode: 'single_thinking', escalation: false, supervisor: false, machine: false };
  it('the default guards are 0.8 / 0.6 / 0.5 (+ the 2026-10-20 lookup stakes ceiling 0.75)', () => expect(quickLaneGuards()).toEqual({ threshold: 0.8, stakesCeiling: 0.6, contestedCeiling: 0.5, lookupStakesCeiling: 0.75 }));
  it('p(quick) 0.75 no longer qualifies (the replay judged 3 of 12 at p ≥ 0.7 checked / research)', () => {
    expect(quickLaneEligibility(mk(0.75), ctx).ok).toBe(false);
    expect(quickLaneEligibility(mk(0.8), ctx).ok).toBe(true);
  });
  it("the weather case — Jev's stakes 0.52 — now qualifies; stakes 0.6 does not", () => {
    expect(quickLaneEligibility(mk(1, { stakes: 0.52 }), ctx).ok).toBe(true);
    expect(quickLaneEligibility(mk(1, { stakes: 0.6 }), ctx)).toMatchObject({ ok: false, why: 'stakes 0.60' });
  });
  it('a code question never takes the Quick lane', () => {
    expect(quickLaneEligibility(mk(0.95), { ...ctx, codeIntent: true })).toMatchObject({ ok: false, why: 'code intent' });
  });
  it('hysteresis: a follow-up in a checked / research session never drops to Quick; a new topic or a standard session may', () => {
    expect(quickLaneEligibility(mk(0.95, { followUp: 0.8 }), { ...ctx, priorLane: 'research' })).toMatchObject({ ok: false, why: 'follow-up in a research session' });
    expect(quickLaneEligibility(mk(0.95, { followUp: 0.8 }), { ...ctx, priorLane: 'checked' }).ok).toBe(false);
    expect(quickLaneEligibility(mk(0.95, { followUp: 0.2 }), { ...ctx, priorLane: 'research' }).ok).toBe(true);
    expect(quickLaneEligibility(mk(0.95, { followUp: 0.9 }), { ...ctx, priorLane: 'standard' }).ok).toBe(true);
  });
  it('a bare threshold still works (legacy call form)', () => {
    expect(quickLaneEligibility(mk(0.75), ctx, 0.7).ok).toBe(true);
  });
});

describe('2026-10-20 — the lookup-conditioned stakes ceiling (quick-lane-guards.ts stakesCeilingFor)', () => {
  const mk = (over: Record<string, number | null> = {}) => classFromAnswers({
    lane: choice({ quick: 0.95, standard: 0.03, checked: 0.01, research: 0.01 }) as any,
    stakes: { type: 'noul', noul: over.stakes ?? 0.1 }, contested: { type: 'noul', noul: over.contested ?? 0.02 },
    ...(over.web !== null ? { needs_live_web: { type: 'noul', noul: over.web ?? 0.98 } } : {}),
    ...(over.multi !== null ? { multi_step: { type: 'noul', noul: over.multi ?? 0.2 } } : {}),
  } as any)!;
  const ctx = { messageChars: 40, images: 0, documents: 0, mode: 'single_thinking', escalation: false, supervisor: false, machine: false };
  afterEach(() => { delete process.env.TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING; });

  it("the audit's weather turn (stakes 0.62, live web 0.98, multi-step 0.2, contested 0.02) now takes the Quick lane — and says why", () => {
    const v = quickLaneEligibility(mk({ stakes: 0.62 }), ctx, quickLaneGuards());
    expect(v).toMatchObject({ ok: true, lookupStakes: true });
    expect(v.why).toBe('p(quick) 0.95 ≥ 0.8; lookup stakes 0.62 < 0.75');
  });
  it('"convert 10,000 USD" (stakes 0.81, live web 0.95) stays off Quick — the refusal names the lookup ceiling and keeps the word stakes', () => {
    expect(quickLaneEligibility(mk({ stakes: 0.81, web: 0.95 }), ctx, quickLaneGuards())).toEqual({ ok: false, why: 'lookup stakes 0.81' });
  });
  it('a low-stakes lookup needs no relaxation: plain ok-why, no lookupStakes flag', () => {
    expect(quickLaneEligibility(mk({ stakes: 0.3 }), ctx, quickLaneGuards())).toEqual({ ok: true, why: 'p(quick) 0.95 ≥ 0.8' });
  });
  it('a missing trait (no needs_live_web / no multi_step answer) ⇒ the base ceiling only', () => {
    expect(quickLaneEligibility(mk({ stakes: 0.62, web: null }), ctx, quickLaneGuards())).toEqual({ ok: false, why: 'stakes 0.62' });
    expect(quickLaneEligibility(mk({ stakes: 0.62, multi: null }), ctx, quickLaneGuards())).toEqual({ ok: false, why: 'stakes 0.62' });
  });
  it('not a pure lookup (multi-step 0.6 / contested 0.3 / live web 0.5) ⇒ the base ceiling', () => {
    expect(quickLaneEligibility(mk({ stakes: 0.62, multi: 0.6 }), ctx, quickLaneGuards())).toEqual({ ok: false, why: 'stakes 0.62' });
    expect(quickLaneEligibility(mk({ stakes: 0.62, contested: 0.3 }), ctx, quickLaneGuards())).toEqual({ ok: false, why: 'stakes 0.62' });
    expect(quickLaneEligibility(mk({ stakes: 0.62, web: 0.5 }), ctx, quickLaneGuards())).toEqual({ ok: false, why: 'stakes 0.62' });
  });
  it('TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING=0.6 restores the pre-2026-10-20 rule (the rollback)', () => {
    process.env.TURN_PLAN_QUICK_LOOKUP_STAKES_CEILING = '0.6';
    expect(quickLaneEligibility(mk({ stakes: 0.62 }), ctx, quickLaneGuards())).toEqual({ ok: false, why: 'stakes 0.62' });
  });
  it('a legacy guards object without lookupStakesCeiling (the replay grid) applies the base ceiling', () => {
    expect(quickLaneEligibility(mk({ stakes: 0.62 }), ctx, { threshold: 0.8, stakesCeiling: 0.6, contestedCeiling: 0.5 })).toEqual({ ok: false, why: 'stakes 0.62' });
  });
  it('every other guard still holds on a relaxed lookup (attachments, code intent, session hysteresis)', () => {
    const c = mk({ stakes: 0.62 });
    expect(quickLaneEligibility(c, { ...ctx, images: 1 }, quickLaneGuards()).ok).toBe(false);
    expect(quickLaneEligibility(c, { ...ctx, codeIntent: true }, quickLaneGuards()).ok).toBe(false);
    expect(quickLaneEligibility({ ...c, followUp: 0.9 }, { ...ctx, priorLane: 'checked' }, quickLaneGuards())).toMatchObject({ ok: false, why: 'follow-up in a checked session' });
  });
  it('the readiness ruler (decision-gate-fit turnPlanActBand) agrees with the consumer on every trait combination', () => {
    const { turnPlanActBand } = jest.requireActual('./decision-gate-fit');
    let compared = 0;
    for (const stakes of [0.5, 0.6, 0.62, 0.74, 0.75, 0.81]) for (const web of [null, 0.5, 0.8, 0.98]) for (const multi of [null, 0.2, 0.5]) for (const contested of [0.02, 0.19, 0.3, 0.5]) {
      const c = mk({ stakes, web, multi, contested });
      const answers: Record<string, { noul: number }> = { stakes: { noul: stakes }, contested: { noul: contested } };
      if (web !== null) answers.needs_live_web = { noul: web };
      if (multi !== null) answers.multi_step = { noul: multi };
      const consumer = quickLaneEligibility(c, ctx, quickLaneGuards()).ok;
      const band = turnPlanActBand({ choice: 'quick', confidence: c.laneConfidence }, answers, {}).inBand;
      expect({ stakes, web, multi, contested, band }).toEqual({ stakes, web, multi, contested, band: consumer });
      compared += 1;
    }
    expect(compared).toBe(288);
  });
  it('decideTurnPlan: an ACT answer on the weather turn runs the Quick lane end to end', async () => {
    mockMode = 'act';
    mockDecide.mockReset();
    mockDecide.mockResolvedValue({
      id: 'w1', mode: 'act', calibrated: true, backend: 'TypeSafe Jev', ms: 160,
      answers: { lane: choice({ quick: 0.95, standard: 0.03, checked: 0.01, research: 0.01 }), lane_rev: choice({ quick: 0.93, standard: 0.05, checked: 0.01, research: 0.01 }), needs_live_web: { type: 'noul', noul: 0.98 }, stakes: { type: 'noul', noul: 0.62 }, contested: { type: 'noul', noul: 0.02 }, multi_step: { type: 'noul', noul: 0.2 } },
    });
    try {
      const p = await decideTurnPlan({ message: "what's the weather today?", priorUserTurns: [], images: 0, documents: 0, turnIndex: 0 }, { ...ctx, requestedMode: 'single_thinking' }, { pools: async () => POOLS as any, catalog: async () => [...CATALOG.values()] });
      expect(p).toMatchObject({ lane: 'quick', act: true, roster: { lead: 'q-flash' } });
      expect(p.reason).toMatch(/quick eligible/);
    } finally { mockMode = 'shadow'; }
  });
});

describe('2026-10-03 hardening — the act CANARY', () => {
  const deps = { pools: async () => POOLS as any, catalog: async () => [...CATALOG.values()] };
  const input = { message: "what's the weather in Toronto?", priorUserTurns: [], images: 0, documents: 0, turnIndex: 0, userId: 'u-canary' };
  const ctx = { messageChars: 30, images: 0, documents: 0, mode: 'single_thinking', escalation: false, supervisor: false, machine: false, requestedMode: 'single_thinking' };
  const answers = { lane: choice({ quick: 0.95, standard: 0.03, checked: 0.01, research: 0.01 }), lane_rev: choice({ quick: 0.93, standard: 0.05, checked: 0.01, research: 0.01 }), stakes: { type: 'noul', noul: 0.52 }, contested: { type: 'noul', noul: 0.02 } };
  beforeEach(() => { mockDecide.mockReset(); mockMode = 'shadow'; delete process.env.TURN_PLAN_CANARY_DISABLED; __resetTurnPlanCanaryForTests(); mockStoreGet.mockReset(); });

  it('a canary user acts on a calibrated SHADOW answer; the plan says canary', async () => {
    mockDecide.mockResolvedValue({ id: 'c1', mode: 'shadow', calibrated: true, backend: 'TypeSafe Jev', ms: 150, answers });
    const p = await decideTurnPlan(input, ctx, { ...deps, canary: async (u) => u === 'u-canary' });
    expect(p).toMatchObject({ lane: 'quick', act: true, canary: true });
    expect(p.reason).toMatch(/ACT \(canary\)/);
    expect(turnPlanMetadata(p)).toMatchObject({ act: true, canary: true });
  });
  it('a canary never acts on an uncalibrated answer, an ineligible turn, or for anyone else', async () => {
    mockDecide.mockResolvedValue({ id: 'c2', mode: 'shadow', calibrated: false, backend: 'readout', ms: 900, answers });
    expect((await decideTurnPlan(input, ctx, { ...deps, canary: async () => true })).act).toBe(false);
    mockDecide.mockResolvedValue({ id: 'c3', mode: 'shadow', calibrated: true, backend: 'TypeSafe Jev', ms: 150, answers });
    expect((await decideTurnPlan(input, { ...ctx, codeIntent: true }, { ...deps, canary: async () => true })).act).toBe(false);
    expect((await decideTurnPlan(input, ctx, { ...deps, canary: async () => false })).act).toBe(false);
  });
  it('turnPlanCanaryIncludes reads the store allowlist (30 s cache), nobody on a read failure, never with the kill switch', async () => {
    mockStoreGet.mockResolvedValue({ actCanaryUserIds: ['u-canary', 42, ''] });
    expect(await turnPlanCanaryIncludes('u-canary')).toBe(true);
    expect(await turnPlanCanaryIncludes('u-other')).toBe(false);
    expect(await turnPlanCanaryIncludes(null)).toBe(false);
    expect(mockStoreGet).toHaveBeenCalledTimes(1); // cached
    __resetTurnPlanCanaryForTests();
    mockStoreGet.mockRejectedValue(new Error('db down'));
    expect(await turnPlanCanaryIncludes('u-canary')).toBe(false);
    __resetTurnPlanCanaryForTests();
    mockStoreGet.mockResolvedValue({ actCanaryUserIds: ['u-canary'] });
    process.env.TURN_PLAN_CANARY_DISABLED = '1';
    expect(await turnPlanCanaryIncludes('u-canary')).toBe(false);
  });
});

describe('ruleAdjustedLane — shadow trait rule (2026-10-04)', () => {
  const { ruleAdjustedLane, turnPlanMetadata } = jest.requireActual('./turn-plan') as typeof import('./turn-plan');
  const cls = (over: any = {}) => ({
    lane: 'standard', laneProbs: { quick: 0, standard: 0.365, checked: 0.28, research: 0.355 }, laneConfidence: 0.365, laneAveraged: true,
    needsLiveWeb: 0.15, stakes: 0.1, contested: 0.97, multiStep: 0.5, breadth: 4, followUp: null, ...over,
  });

  it('REPLAYS the Quebec turn: a broad near-tie with research reads research', () => {
    expect(ruleAdjustedLane(cls() as any)).toEqual({ lane: 'research', rule: 'near_tie_research_broad' });
  });

  it('contested + broad (no research near-tie) reads at least checked', () => {
    expect(ruleAdjustedLane(cls({ laneProbs: { quick: 0, standard: 0.6, checked: 0.3, research: 0.1 }, breadth: 3 }) as any)).toEqual({ lane: 'checked', rule: 'contested_broad' });
  });

  it('a narrow or uncontested turn keeps the argmax; the rule never lowers a lane', () => {
    expect(ruleAdjustedLane(cls({ breadth: 2, contested: 0.2 }) as any)).toEqual({ lane: 'standard', rule: null });
    expect(ruleAdjustedLane(cls({ lane: 'research', laneProbs: { quick: 0, standard: 0.1, checked: 0.1, research: 0.8 } }) as any)).toEqual({ lane: 'research', rule: null });
    expect(ruleAdjustedLane(cls({ lane: 'quick', laneProbs: { quick: 0.9, standard: 0.05, checked: 0.03, research: 0.02 }, contested: 0.1, breadth: 1 }) as any)).toEqual({ lane: 'quick', rule: null });
    expect(ruleAdjustedLane(null)).toBeNull();
  });

  it('rides turnPlanMetadata as ruleLane / laneRule; TURN_PLAN_LANE_RULE_DISABLED=1 drops it', () => {
    const plan: any = { lane: 'standard', act: false, mode: 'act', reason: 'r', cls: cls() };
    expect(turnPlanMetadata(plan)).toMatchObject({ lane: 'standard', ruleLane: 'research', laneRule: 'near_tie_research_broad' });
    process.env.TURN_PLAN_LANE_RULE_DISABLED = '1';
    try {
      expect(turnPlanMetadata(plan)).not.toHaveProperty('ruleLane');
    } finally {
      delete process.env.TURN_PLAN_LANE_RULE_DISABLED;
    }
  });
});
