/** The turn plan carries the per-turn model pick (2026-10-04). */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockDecide = jest.fn();
jest.mock('./decision-gate', () => ({
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: () => 'act',
  decisionOptionThreshold: (_p: string, _o: string, fallback: number) => fallback,
  stashDecision: () => null,
}));
jest.mock('../memory/context-store', () => ({ storeGet: async () => null }));
import { decideTurnPlan, turnPlanMetadata } from './turn-plan';
import type { EvidenceSnapshot } from './model-evidence';

const choice = (p: Record<string, number>) => {
  const best = Object.entries(p).sort((a, b) => b[1] - a[1])[0];
  return { type: 'choice', choice: best[0], probabilities: p, confidence: best[1] };
};
const card = (spec: string, family: string) => ({ spec, name: spec, source: 'builtin', family, tier: 'fast', vision: true, contextChars: null, maxTools: null, priceIn: null, priceOut: null, frontier: false, autoEligible: true, servable: true, thinkingOff: false });
const CATALOG = [card('seat', 'glm'), card('fast', 'qwen'), card('dsk', 'deepseek')];
const POOLS = { quick: { role: 'quick', models: ['fast'], source: 'seats', dropped: [] }, lead: { role: 'lead', models: ['seat'], source: 'seats', dropped: [] }, checker: { role: 'checker', models: ['dsk'], source: 'seats', dropped: [] }, colleague: { role: 'colleague', models: ['dsk'], source: 'seats', dropped: [] } };
const SNAP: EvidenceSnapshot = { at: Date.now(), prod: null, bench: { models: {
  seat: { lanes: { all: { n: 12, ttftP50Ms: 150_000, ttftP90Ms: null, failRate: 0, quality: 4.0, qualityN: 12 } } },
  fast: { lanes: { all: { n: 12, ttftP50Ms: 20_000, ttftP90Ms: null, failRate: 0, quality: 3.95, qualityN: 12 } } },
} } };
const standardAnswers = { lane: choice({ quick: 0.05, standard: 0.85, checked: 0.07, research: 0.03 }), stakes: { type: 'noul', noul: 0.1 }, contested: { type: 'noul', noul: 0.1 } };
const input = { message: 'help me plan a weekly budget', priorUserTurns: [], images: 0, documents: 0, turnIndex: 0, sessionId: 'c1', userId: 'u1' };
const ctx = { messageChars: 30, images: 0, documents: 0, mode: 'thinking', escalation: false, supervisor: false, machine: false, requestedMode: 'thinking' };

describe('decideTurnPlan — per-turn model pick', () => {
  beforeEach(() => { mockDecide.mockReset(); mockDecide.mockResolvedValue({ id: 'd1', mode: 'act', backend: 'jev', ms: 100, calibrated: true, answers: standardAnswers }); });

  it('act mode: the plan names the faster measured model and acts', async () => {
    const p = await decideTurnPlan(input, ctx, { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false, evidence: async () => SNAP, pickMode: async () => 'act' });
    expect(p.lane).toBe('standard');
    expect(p.modelPick).toMatchObject({ spec: 'fast', changed: true, act: true, mode: 'act', seat: 'seat' });
    expect(p.reason).toMatch(/model fast ACT/);
    expect((turnPlanMetadata(p) as any).modelPick).toMatchObject({ spec: 'fast', act: true, seat: 'seat' });
  });

  it('shadow mode records the pick without acting — except for a canary user', async () => {
    const base = { pools: async () => POOLS as any, catalog: async () => CATALOG as any, evidence: async () => SNAP, pickMode: async () => 'shadow' as const };
    expect((await decideTurnPlan(input, ctx, { ...base, canary: async () => false })).modelPick).toMatchObject({ spec: 'fast', act: false });
    expect((await decideTurnPlan(input, ctx, { ...base, canary: async () => true })).modelPick).toMatchObject({ spec: 'fast', act: true });
  });

  it('off mode, injected deps without pickMode, or no evidence: no pick / the seat', async () => {
    expect((await decideTurnPlan(input, ctx, { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false, evidence: async () => SNAP, pickMode: async () => 'off' })).modelPick).toBeNull();
    expect((await decideTurnPlan(input, ctx, { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false })).modelPick).toBeNull();
    const none = await decideTurnPlan(input, ctx, { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false, evidence: async () => null, pickMode: async () => 'act' });
    expect(none.modelPick).toMatchObject({ spec: 'seat', changed: false, act: false });
  });

  it('frontier hard rule (owner 2026-10-06 late): a frontier model with the best evidence is never the lead pick, with or without the cost term', async () => {
    const frontier = { ...card('frontier', 'claude'), source: 'registry', frontier: true, autoEligible: true }; // a card an old 'all' store admitted
    const snap: EvidenceSnapshot = { ...SNAP, bench: { models: { ...SNAP.bench!.models, frontier: { lanes: { all: { n: 12, ttftP50Ms: 1_000, ttftP90Ms: null, failRate: 0, quality: 5, qualityN: 12 } } } } } };
    const deps = { pools: async () => POOLS as any, catalog: async () => [...CATALOG, frontier] as any, canary: async () => false, evidence: async () => snap, pickMode: async () => 'act' as const };
    for (const p of [await decideTurnPlan(input, ctx, deps), await decideTurnPlan(input, ctx, { ...deps, costPerUsd: async () => 1 })]) {
      expect(p.modelPick?.spec).toBe('fast');
      expect(p.modelPick?.ranked.map((r) => r.spec)).not.toContain('frontier');
    }
  });

  it('roster 2026-10-06 C-1 (env opt-in AUTO_PICK_FRONTIER_ENABLED=1 only): with a cost weight the catalog prices every model — an expensive frontier model must earn its price', async () => {
    process.env.AUTO_PICK_FRONTIER_ENABLED = '1';
    try {
      const frontier = { ...card('frontier', 'claude'), source: 'registry', frontier: true }; // unpriced ⇒ the conservative frontier default
      const snap: EvidenceSnapshot = { ...SNAP, bench: { models: { ...SNAP.bench!.models, frontier: { lanes: { all: { n: 12, ttftP50Ms: 18_000, ttftP90Ms: null, failRate: 0, quality: 4.2, qualityN: 12 } } } } } };
      const deps = { pools: async () => POOLS as any, catalog: async () => [...CATALOG, frontier] as any, canary: async () => false, evidence: async () => snap, pickMode: async () => 'act' as const };
      // No cost term (injected deps without costPerUsd): the frontier model's small quality edge wins.
      expect((await decideTurnPlan(input, ctx, deps)).modelPick?.spec).toBe('frontier');
      // κ 1: its ~$1.24 / turn outweighs the edge — the open model wins; ranked entries carry the per-turn price.
      const p = await decideTurnPlan(input, ctx, { ...deps, costPerUsd: async () => 1 });
      expect(p.modelPick?.spec).toBe('fast');
      expect(p.modelPick?.ranked.find((r) => r.spec === 'frontier')?.usd).toBeGreaterThan(1);
    } finally {
      delete process.env.AUTO_PICK_FRONTIER_ENABLED;
    }
  });

  it('an admin-configured lead pool narrows the field', async () => {
    const pools = { ...POOLS, lead: { ...POOLS.lead, source: 'pool', models: ['seat', 'dsk'] } };
    const p = await decideTurnPlan(input, ctx, { pools: async () => pools as any, catalog: async () => CATALOG as any, canary: async () => false, evidence: async () => SNAP, pickMode: async () => 'act' });
    expect(p.modelPick?.spec).toBe('seat'); // 'fast' is not in the admin's pool; 'dsk' is unmeasured
  });
});

describe('roster 2026-10-06 B-1 — turnPlanMetadata records what RAN (applied vs would-act + the ran roster)', () => {
  beforeEach(() => { mockDecide.mockReset(); mockDecide.mockResolvedValue({ id: 'd1', mode: 'act', backend: 'jev', ms: 100, calibrated: true, answers: standardAnswers }); delete process.env.TURN_PLAN_APPLIED_STAMP_DISABLED; });
  afterEach(() => { delete process.env.TURN_PLAN_APPLIED_STAMP_DISABLED; });
  const deps = { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false, evidence: async () => SNAP, pickMode: async () => 'act' as const };

  it('with the applied stamp, modelPick.act means "the pick LED this run" and wouldAct keeps the plan\'s verdict; `ran` sits beside the predicted roster', async () => {
    const p = await decideTurnPlan(input, ctx, deps);
    expect(p.modelPick?.act).toBe(true); // the plan would act…
    const notApplied = turnPlanMetadata(p, { pickApplied: false, ran: { lane: 'checked', lead: 'seat', checker: 'dsk', colleagues: [] } }) as any;
    expect(notApplied.modelPick).toMatchObject({ spec: 'fast', act: false, wouldAct: true }); // …but the seat led (e.g. a pinned chat / unservable pick)
    expect(notApplied.ran).toEqual({ lane: 'checked', lead: 'seat', checker: 'dsk', colleagues: [] });
    expect(notApplied.roster).toMatchObject({ lead: 'seat', leadPool: 'lead' }); // the prediction is still there
    const applied = turnPlanMetadata(p, { pickApplied: true, ran: { lane: 'standard', lead: 'fast', checker: null, colleagues: [] } }) as any;
    expect(applied.modelPick).toMatchObject({ act: true, wouldAct: true });
    expect(applied.ran.lead).toBe('fast');
  });

  it('no applied argument (legacy callers) ⇒ the record is unchanged (act = would-act, no wouldAct, no ran)', async () => {
    const p = await decideTurnPlan(input, ctx, deps);
    const m = turnPlanMetadata(p) as any;
    expect(m.modelPick.act).toBe(true);
    expect(m.modelPick.wouldAct).toBeUndefined();
    expect(m.ran).toBeUndefined();
  });

  it('TURN_PLAN_APPLIED_STAMP_DISABLED=1 restores the would-act record even when the harness passes what ran', async () => {
    process.env.TURN_PLAN_APPLIED_STAMP_DISABLED = '1';
    const p = await decideTurnPlan(input, ctx, deps);
    const m = turnPlanMetadata(p, { pickApplied: false, ran: { lane: 'checked', lead: 'seat', checker: 'dsk', colleagues: [] } }) as any;
    expect(m.modelPick.act).toBe(true);
    expect(m.modelPick.wouldAct).toBeUndefined();
    expect(m.ran).toBeUndefined();
  });
});

// ── audit 2026-10-08 W4-1a — a quick-classified turn that does NOT take the Quick lane is picked as Standard ──────
describe('W4-1a — quick-classified but Quick-ineligible turns still get the model pick', () => {
  // The real shape (prod 10-07/08, 9 turns): "lane quick (p 0.64, both orders); quick no (p(quick) 0.64 < 0.8)" with
  // NO model pick — the run led with the slow gateway seat (TTFT p50 287 s vs 59–71 s on picked leads).
  const quickIneligible = { lane: choice({ quick: 0.64, standard: 0.3, checked: 0.04, research: 0.02 }), lane_rev: choice({ quick: 0.64, standard: 0.3, checked: 0.04, research: 0.02 }), stakes: { type: 'noul', noul: 0.1 }, contested: { type: 'noul', noul: 0.1 } };
  const deps = { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false, evidence: async () => SNAP, pickMode: async () => 'act' as const };
  beforeEach(() => { mockDecide.mockReset(); mockDecide.mockResolvedValue({ id: 'd2', mode: 'act', backend: 'jev', ms: 90, calibrated: true, answers: quickIneligible }); delete process.env.QUICK_INELIGIBLE_PICK_DISABLED; });
  afterEach(() => { delete process.env.QUICK_INELIGIBLE_PICK_DISABLED; });

  it('the replayed reason line now carries a pick made as STANDARD against the LEAD seat (not the Quick seat)', async () => {
    const p = await decideTurnPlan(input, ctx, deps);
    expect(p.lane).toBe('quick');
    expect(p.act).toBe(false);
    expect(p.reason).toMatch(/lane quick \(p 0\.64, both orders\); quick no \(p\(quick\) 0\.64 < 0\.8\)/);
    expect(p.modelPick).toMatchObject({ spec: 'fast', changed: true, act: true, seat: 'seat', lane: 'standard' });
    expect(p.reason).toMatch(/model fast ACT \(picked as standard\)/);
    expect((turnPlanMetadata(p) as any).modelPick).toMatchObject({ seat: 'seat', lane: 'standard' });
  });

  it('a standard / checked lane keeps its own lane (no `lane` stamp on the pick)', async () => {
    mockDecide.mockResolvedValue({ id: 'd1', mode: 'act', backend: 'jev', ms: 100, calibrated: true, answers: standardAnswers });
    const p = await decideTurnPlan(input, ctx, deps);
    expect(p.modelPick?.lane).toBeUndefined();
  });

  it('a turn that DOES take the Quick lane is never picked (the Quick seat leads)', async () => {
    const eligible = { lane: choice({ quick: 0.92, standard: 0.05, checked: 0.02, research: 0.01 }), lane_rev: choice({ quick: 0.92, standard: 0.05, checked: 0.02, research: 0.01 }), stakes: { type: 'noul', noul: 0.1 }, contested: { type: 'noul', noul: 0.1 } };
    mockDecide.mockResolvedValue({ id: 'd3', mode: 'act', backend: 'jev', ms: 80, calibrated: true, answers: eligible });
    const p = await decideTurnPlan(input, ctx, deps);
    expect(p.act).toBe(true);
    expect(p.modelPick).toBeNull();
  });

  it('QUICK_INELIGIBLE_PICK_DISABLED=1 restores "no pick" (the seat leads)', async () => {
    process.env.QUICK_INELIGIBLE_PICK_DISABLED = '1';
    const p = await decideTurnPlan(input, ctx, deps);
    expect(p.lane).toBe('quick');
    expect(p.modelPick).toBeNull();
  });
});

// ── 2026-10-20 task-aware pick — the kind-aware pick beside (shadow) or instead of (act) the (model, lane) pick ─────
describe('task-aware pick — modelPickKind shadow / act / off', () => {
  // On the LANE the seat and 'writer' are equal (the lane pick keeps the seat); the WRITING bench separates them.
  const W = (q: number, n = 20) => ({ n, ttftP50Ms: 30_000, ttftP90Ms: null, failRate: 0, quality: q, qualityN: n });
  const KSNAP: EvidenceSnapshot = { at: Date.now(), prod: null, bench: { models: {
    seat: { lanes: { all: W(4.0) }, kinds: { writing: W(3.0) } },
    writer: { lanes: { all: W(4.0) }, kinds: { writing: W(5.0) } },
  } } };
  const KCATALOG = [card('seat', 'glm'), card('writer', 'kimi')];
  const kindAnswers = (top: string, p = 0.9) => {
    const probs: Record<string, number> = { writing: 0, code: 0, analysis: 0, lookup: 0, advice: 0, planning: 0, explain: 0 };
    probs[top] = p;
    const rest = Object.keys(probs).filter((k) => k !== top);
    for (const k of rest) probs[k] = (1 - p) / rest.length;
    return { kind: choice(probs), kind_rev: choice(probs), harm: { type: 'noul', noul: 0.12 } } as any;
  };
  const kindResult = (top = 'writing', o: { p?: number; calibrated?: boolean } = {}) => {
    const { classifyTaskKind, usableTaskKind } = jest.requireActual('./task-kind') as typeof import('./task-kind');
    const answers = kindAnswers(top, o.p ?? 0.9);
    const decision = { id: 'tk1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 60, calibrated: o.calibrated ?? true, answers } as any;
    const cls = classifyTaskKind(answers);
    return { cls, decision, usableKind: usableTaskKind(decision, cls) };
  };
  const deps = (kindMode: 'off' | 'shadow' | 'act' | undefined, over: Record<string, unknown> = {}) => ({
    pools: async () => POOLS as any, catalog: async () => KCATALOG as any, canary: async () => false, evidence: async () => KSNAP,
    pickMode: async () => 'act' as const, taskKind: async () => kindResult(), ...(kindMode ? { pickKindMode: async () => kindMode } : {}), ...over,
  });
  beforeEach(() => {
    mockDecide.mockReset();
    mockDecide.mockResolvedValue({ id: 'd1', mode: 'act', backend: 'jev', ms: 100, calibrated: true, answers: standardAnswers });
    delete process.env.MODEL_PICK_KIND_DISABLED;
    delete process.env.MODEL_EVIDENCE_KIND_DISABLED;
  });
  afterAll(() => { delete process.env.MODEL_PICK_KIND_DISABLED; delete process.env.MODEL_EVIDENCE_KIND_DISABLED; });

  it('SHADOW (the store default): the (model, lane) pick acts exactly as today; the kind-aware pick is recorded as kindPick', async () => {
    const p = await decideTurnPlan(input, ctx, deps(undefined)); // no pickKindMode dep ⇒ the store row (null ⇒ shadow)
    expect(p.modelPick).toMatchObject({ spec: 'seat', changed: false, act: false, kindMode: 'shadow' });
    expect(p.modelPick!.kind).toBeUndefined();
    expect(p.modelPick!.kindPick).toMatchObject({ spec: 'writer', changed: true, keyed: true });
    expect(p.modelPick!.kindPick!.reason).toMatch(/kind writing/);
    expect(p.reason).toMatch(/; model seat; kind writing → writer \(shadow\)$/);
    const m = turnPlanMetadata(p) as any;
    expect(m.modelPick).toMatchObject({ spec: 'seat', act: false, kindMode: 'shadow', kindPick: { spec: 'writer', changed: true, keyed: true } });
    expect(m.modelPick.kindPick.ranked.map((r: any) => [r.spec, r.qk])).toEqual([['writer', 'kind'], ['seat', 'kind']]);
    expect(m.modelPick.ranked.every((r: any) => r.qk === 'all')).toBe(true);
    expect(m.modelPick.lanePick).toBeUndefined();
    expect(m.taskKind).toEqual({ kind: 'writing', top: 'writing', p: 0.9, averaged: true, harm: 0.12, usable: true, decisionId: 'tk1' });
  });

  it('ACT: the kind-aware pick REPLACES the lane pick and acts under the modelPick mode; lanePick keeps the counterfactual', async () => {
    const p = await decideTurnPlan(input, ctx, deps('act'));
    expect(p.modelPick).toMatchObject({ spec: 'writer', changed: true, act: true, mode: 'act', kind: 'writing', kindMode: 'act', lanePick: { spec: 'seat', changed: false } });
    expect(p.modelPick!.kindPick).toBeUndefined();
    expect(p.reason).toMatch(/; model writer ACT; kind writing \(act\)$/);
    expect((turnPlanMetadata(p) as any).modelPick).toMatchObject({ spec: 'writer', kind: 'writing', kindMode: 'act', lanePick: { spec: 'seat', changed: false } });
    // shadow model pick: the kind pick acts only for a canary user — exactly like today's pick
    expect((await decideTurnPlan(input, ctx, deps('act', { pickMode: async () => 'shadow' as const }))).modelPick).toMatchObject({ spec: 'writer', act: false });
    expect((await decideTurnPlan(input, ctx, deps('act', { pickMode: async () => 'shadow' as const, canary: async () => true }))).modelPick).toMatchObject({ spec: 'writer', act: true });
  });

  it('ACT with no same-field alternative: the lane pick that measured a better model still leads (review 2026-10-20)', async () => {
    // On the LANE 'fast' clearly beats the seat; for WRITING only the seat has a bucket in this run ('fast' has none).
    const FSNAP: EvidenceSnapshot = { at: Date.now(), prod: null, bench: { models: {
      seat: { lanes: { all: { ...W(4.0), ttftP50Ms: 287_000 } }, kinds: { writing: W(4.0) } },
      fast: { lanes: { all: { ...W(4.0), ttftP50Ms: 20_000 } } },
    } } };
    const p = await decideTurnPlan(input, ctx, deps('act', { catalog: async () => [card('seat', 'glm'), card('fast', 'kimi')] as any, evidence: async () => FSNAP }));
    expect(p.modelPick).toMatchObject({ spec: 'fast', changed: true, kindMode: 'act' });
    expect(p.modelPick!.kind).toBeUndefined(); // the acting pick is the lane pick
    expect(p.modelPick!.kindPick).toMatchObject({ spec: 'seat', changed: false }); // the field-less kind pick is only recorded
    expect(p.modelPick!.lanePick).toBeUndefined();
    expect(p.reason).toMatch(/kind writing → seat \(act, not comparable in one kind field — lane pick leads\)$/);
    // an UNRELATED bucketed model gives the kind pick a "field", but the lane winner 'fast' was never in it ⇒ still the
    // lane pick (review 2026-10-20: a 300 s 'other' must not displace the 20 s lane winner)
    const OSNAP: EvidenceSnapshot = { ...FSNAP, bench: { models: { ...FSNAP.bench!.models, other: { lanes: { all: { ...W(4.0), ttftP50Ms: 300_000 } }, kinds: { writing: W(3.9) } } } } };
    const q = await decideTurnPlan(input, ctx, deps('act', { catalog: async () => [card('seat', 'glm'), card('fast', 'kimi'), card('other', 'qwen')] as any, evidence: async () => OSNAP }));
    expect(q.modelPick).toMatchObject({ spec: 'fast', changed: true });
    expect(q.modelPick!.kind).toBeUndefined();
  });

  it('OFF / MODEL_PICK_KIND_DISABLED=1: no kind pick at all — the kind is still recorded (telemetry)', async () => {
    const off = await decideTurnPlan(input, ctx, deps('off'));
    expect(off.modelPick).toMatchObject({ spec: 'seat', changed: false });
    expect(off.modelPick!.kindMode).toBeUndefined();
    expect(off.modelPick!.kindPick).toBeUndefined();
    expect(off.taskKind).toMatchObject({ kind: 'writing', usable: true });
    process.env.MODEL_PICK_KIND_DISABLED = '1';
    const ks = await decideTurnPlan(input, ctx, deps(undefined)); // the default mode reader honours the switch
    expect(ks.modelPick!.kindPick).toBeUndefined();
    expect(ks.modelPick!.kindMode).toBeUndefined();
  });

  it('no usable kind (under TASK_KIND_MIN_P, or an uncalibrated backend) ⇒ no kind pick; the record says usable:false', async () => {
    const low = await decideTurnPlan(input, ctx, deps('act', { taskKind: async () => kindResult('writing', { p: 0.4 }) }));
    expect(low.modelPick).toMatchObject({ spec: 'seat', changed: false });
    expect(low.modelPick!.kindMode).toBeUndefined();
    expect(low.taskKind).toMatchObject({ kind: null, top: 'writing', usable: false });
    expect(low.reason).not.toMatch(/kind/);
    const uncal = await decideTurnPlan(input, ctx, deps('act', { taskKind: async () => kindResult('writing', { calibrated: false }) }));
    expect(uncal.modelPick).toMatchObject({ spec: 'seat', changed: false });
    expect(uncal.taskKind).toMatchObject({ kind: 'writing', usable: false });
  });

  it('MODEL_EVIDENCE_KIND_DISABLED=1: the kind-aware pick falls back to lane evidence (keyed:false — the seat leads)', async () => {
    process.env.MODEL_EVIDENCE_KIND_DISABLED = '1';
    const p = await decideTurnPlan(input, ctx, deps('shadow'));
    expect(p.modelPick!.kindPick).toMatchObject({ spec: 'seat', changed: false, keyed: false });
  });
});
