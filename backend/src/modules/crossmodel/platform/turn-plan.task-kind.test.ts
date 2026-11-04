/**
 * 2026-10-20 task-aware pick — the turn plan's task_kind ask (platform/task-kind.ts): fired in the SAME tick as the
 * turn_plan ask over the same state, never awaited past the plan's own bounds (the MODEL_EVIDENCE_WAIT_MS pick window,
 * else TASK_KIND_GRACE_MS), persisted through the turnPlanMetadata WHITELIST.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockDecide = jest.fn();
jest.mock('./decision-gate', () => ({
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: () => 'act',
  decisionOptionThreshold: (_p: string, _o: string, fallback: number) => fallback,
  stashDecision: (r: any, purpose: string, opts: any) => (r ? { id: r.id, purpose, mode: r.mode, backend: r.backend, answers: r.answers, decidedAt: 'x', ...(opts?.extra ? { extra: opts.extra } : {}) } : null),
}));
jest.mock('../memory/context-store', () => ({ storeGet: async () => null }));
import { decideTurnPlan, turnPlanMetadata, turnPlanState, turnTaskKindOf, MODEL_EVIDENCE_WAIT_MS, TASK_KIND_GRACE_MS, TURN_PLAN_TIMEOUT_MS } from './turn-plan';
import { classifyTaskKind, decideTaskKind, taskKindQuestions, usableTaskKind, type TaskKindResult } from './task-kind';
import type { EvidenceSnapshot } from './model-evidence';

const choice = (p: Record<string, number>) => {
  const best = Object.entries(p).sort((a, b) => b[1] - a[1])[0];
  return { type: 'choice', choice: best[0], probabilities: p, confidence: best[1] };
};
const card = (spec: string, family: string) => ({ spec, name: spec, source: 'builtin', family, tier: 'fast', vision: true, contextChars: null, maxTools: null, priceIn: null, priceOut: null, frontier: false, autoEligible: true, servable: true, thinkingOff: false });
const CATALOG = [card('seat', 'glm'), card('writer', 'kimi')];
const POOLS = { quick: { role: 'quick', models: ['writer'], source: 'seats', dropped: [] }, lead: { role: 'lead', models: ['seat'], source: 'seats', dropped: [] }, checker: { role: 'checker', models: ['writer'], source: 'seats', dropped: [] }, colleague: { role: 'colleague', models: ['writer'], source: 'seats', dropped: [] } };
const W = (q: number, n = 20) => ({ n, ttftP50Ms: 30_000, ttftP90Ms: null, failRate: 0, quality: q, qualityN: n });
const SNAP: EvidenceSnapshot = { at: Date.now(), prod: null, bench: { models: {
  seat: { lanes: { all: W(4.0) }, kinds: { writing: W(3.0) } },
  writer: { lanes: { all: W(4.0) }, kinds: { writing: W(5.0) } },
} } };
const standardAnswers = { lane: choice({ quick: 0.05, standard: 0.85, checked: 0.07, research: 0.03 }), lane_rev: choice({ quick: 0.05, standard: 0.85, checked: 0.07, research: 0.03 }), stakes: { type: 'noul', noul: 0.1 }, contested: { type: 'noul', noul: 0.1 } };
const input = { message: 'write a birthday poem for my sister', priorUserTurns: [], images: 0, documents: 0, turnIndex: 0, sessionId: 'c1', segment: 'user', userId: 'u1' };
const ctx = { messageChars: 36, images: 0, documents: 0, mode: 'thinking', escalation: false, supervisor: false, machine: false, requestedMode: 'thinking' };

const kindAnswers = (top: string, p = 0.9) => {
  const probs: Record<string, number> = { writing: 0, code: 0, analysis: 0, lookup: 0, advice: 0, planning: 0, explain: 0 };
  const rest = Object.keys(probs).filter((k) => k !== top);
  for (const k of rest) probs[k] = (1 - p) / rest.length;
  probs[top] = p;
  return { kind: choice(probs), kind_rev: choice(probs), harm: { type: 'noul', noul: 0.237 } } as any;
};
const kindResult = (top = 'writing'): TaskKindResult => {
  const answers = kindAnswers(top);
  const decision = { id: 'tk1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 60, calibrated: true, answers } as any;
  const cls = classifyTaskKind(answers);
  return { cls, decision, usableKind: usableTaskKind(decision, cls) };
};
const delayed = <T>(ms: number, v: T) => new Promise<T>((res) => setTimeout(() => res(v), ms));
const never = <T>() => new Promise<T>(() => { /* never settles */ });

describe('turn plan — the task_kind ask rides beside the turn_plan ask', () => {
  beforeEach(() => {
    mockDecide.mockReset();
    mockDecide.mockResolvedValue({ id: 'd1', mode: 'act', backend: 'jev', ms: 100, calibrated: true, answers: standardAnswers });
  });

  it('fires in the SAME tick as the turn_plan ask (before it is answered), over the same state, budget, session and segment', async () => {
    let releaseTurnPlan!: () => void;
    mockDecide.mockImplementation(() => new Promise((res) => { releaseTurnPlan = () => res({ id: 'd1', mode: 'act', backend: 'jev', ms: 100, calibrated: true, answers: standardAnswers }); }));
    const taskKind = jest.fn(async () => kindResult());
    const done = decideTurnPlan(input, ctx, { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false, taskKind });
    await Promise.resolve();
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(taskKind).toHaveBeenCalledTimes(1); // asked while the turn_plan answer is still pending
    expect(mockDecide.mock.calls[0][2]).toMatchObject({ purpose: 'turn_plan', timeoutMs: TURN_PLAN_TIMEOUT_MS, sessionId: 'c1' });
    expect((taskKind.mock.calls[0] as any[])[0]).toEqual(turnPlanState(input));
    expect((taskKind.mock.calls[0] as any[])[0]).toBe(mockDecide.mock.calls[0][0]); // the very same state object
    expect((taskKind.mock.calls[0] as any[])[1]).toEqual({ timeoutMs: TURN_PLAN_TIMEOUT_MS, sessionId: 'c1', segment: 'user' });
    releaseTurnPlan();
    const p = await done;
    expect(mockDecide).toHaveBeenCalledTimes(1); // the kind went through its own dep, never a second turn_plan ask
    expect(p.taskKind).toMatchObject({ kind: 'writing', usable: true, decisionId: 'tk1' });
    expect(p.reason).toMatch(/; kind writing$/);
  });

  it('injected deps without taskKind ask nothing (no kind, no wait); purpose off / TURN_PLAN_DISABLED never ask it', async () => {
    const p = await decideTurnPlan(input, ctx, { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false });
    expect(p.taskKind).toBeUndefined();
    expect(p.taskKindStash).toBeUndefined();
    const taskKind = jest.fn(async () => kindResult());
    process.env.TURN_PLAN_DISABLED = '1';
    try {
      await decideTurnPlan(input, ctx, { pools: async () => POOLS as any, catalog: async () => CATALOG as any, taskKind });
    } finally {
      delete process.env.TURN_PLAN_DISABLED;
    }
    expect(taskKind).not.toHaveBeenCalled();
  });

  describe('NEVER extends the budget (fake clock: the exact bound, not a wall-clock guess)', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });
    /** Settle `p` while the fake clock moves: resolved by `boundMs`, still pending 1 ms before it. */
    async function settlesAt<T>(p: Promise<T>, boundMs: number): Promise<T> {
      let out: { v: T } | null = null;
      void p.then((v) => { out = { v }; });
      await jest.advanceTimersByTimeAsync(boundMs - 1);
      expect(out).toBeNull();
      await jest.advanceTimersByTimeAsync(1);
      expect(out).not.toBeNull();
      return out!.v;
    }
    const noPick = { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false };
    const pick = { ...noPick, evidence: async () => SNAP, pickMode: async () => 'act' as const, pickKindMode: async () => 'act' as const };

    it('no pick: a slow kind gets exactly TASK_KIND_GRACE_MS after the turn_plan answer, then the plan goes without it', async () => {
      const p = await settlesAt(decideTurnPlan(input, ctx, { ...noPick, taskKind: () => never() }), TASK_KIND_GRACE_MS);
      expect(p.taskKind).toBeUndefined();
      expect(p.lane).toBe('standard'); // the plan itself is intact
      // in within the grace ⇒ recorded, and the plan returns as soon as it is in
      const q = await settlesAt(decideTurnPlan(input, ctx, { ...noPick, taskKind: () => delayed(40, kindResult()) }), 40);
      expect(q.taskKind).toMatchObject({ kind: 'writing' });
    });

    it('pick branch: the kind shares the MODEL_EVIDENCE_WAIT_MS window (window, not window + grace); a late kind ⇒ today\'s pick', async () => {
      const late = await settlesAt(decideTurnPlan(input, ctx, { ...pick, taskKind: () => never() }), MODEL_EVIDENCE_WAIT_MS);
      expect(late.modelPick).toMatchObject({ spec: 'seat', changed: false });
      expect(late.modelPick!.kindMode).toBeUndefined();
      expect(late.taskKind).toBeUndefined();
      // a kind landing inside the window drives the kind-aware pick — and ends the wait when it lands
      const inWindow = await settlesAt(decideTurnPlan(input, ctx, { ...pick, taskKind: () => delayed(120, kindResult()) }), 120);
      expect(inWindow.modelPick).toMatchObject({ spec: 'writer', changed: true, kind: 'writing', kindMode: 'act' });
    });

    it('a SLOW turn_plan answer leaves the kind only what is left of the ask\'s own bound (never past TURN_PLAN_TIMEOUT_MS)', async () => {
      const slow = () => delayed(TURN_PLAN_TIMEOUT_MS - 50, { id: 'd1', mode: 'act', backend: 'jev', ms: 1150, calibrated: true, answers: standardAnswers });
      mockDecide.mockImplementation(slow);
      // no pick: grace capped at 50 ms (not 150) ⇒ the plan is back at TURN_PLAN_TIMEOUT_MS
      const a = await settlesAt(decideTurnPlan(input, ctx, { ...noPick, taskKind: () => never() }), TURN_PLAN_TIMEOUT_MS);
      expect(a.lane).toBe('standard');
      // pick branch: the kind's window is capped the same way (the cached evidence is already in)
      const b = await settlesAt(decideTurnPlan(input, ctx, { ...pick, taskKind: () => never() }), TURN_PLAN_TIMEOUT_MS);
      expect(b.modelPick).toMatchObject({ spec: 'seat', changed: false });
    });

    it('pick branch with the kind mode OFF: the window never waits for the kind; it gets only the grace (telemetry)', async () => {
      const off = await settlesAt(decideTurnPlan(input, ctx, { ...pick, pickKindMode: async () => 'off' as const, taskKind: () => never() }), TASK_KIND_GRACE_MS);
      expect(off.modelPick).toMatchObject({ spec: 'seat', changed: false });
      expect(off.modelPick!.kindPick).toBeUndefined();
    });
  });

  it('fail-open: a throwing or rejecting kind dep changes nothing', async () => {
    const base = { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false, evidence: async () => SNAP, pickMode: async () => 'act' as const, pickKindMode: async () => 'act' as const };
    const sync = await decideTurnPlan(input, ctx, { ...base, taskKind: () => { throw new Error('boom'); } });
    const rej = await decideTurnPlan(input, ctx, { ...base, taskKind: async () => { throw new Error('boom'); } });
    for (const p of [sync, rej]) {
      expect(p.lane).toBe('standard');
      expect(p.reason).not.toBe('error');
      expect(p.modelPick).toMatchObject({ spec: 'seat', changed: false });
      expect(p.taskKind).toBeUndefined();
    }
  });

  it('the kind stash rides apart from the turn_plan stash (purpose task_kind)', async () => {
    const p = await decideTurnPlan(input, ctx, { pools: async () => POOLS as any, catalog: async () => CATALOG as any, canary: async () => false, taskKind: async () => kindResult() });
    expect(p.stash).toMatchObject({ id: 'd1', purpose: 'turn_plan' });
    expect(p.taskKindStash).toMatchObject({ id: 'tk1', purpose: 'task_kind', extra: { lane: 'standard', top: 'writing', usable: true } });
    expect((turnPlanMetadata(p) as any).taskKindStash).toMatchObject({ id: 'tk1', purpose: 'task_kind' });
  });
});

describe('turnPlanMetadata — the taskKind WHITELIST', () => {
  it('stamps {kind, top, p (2 dp), averaged, harm (2 dp), usable, decisionId} — never backend / calibrated / probabilities', () => {
    const tk = turnTaskKindOf(kindResult())!;
    expect(tk).toMatchObject({ backend: 'TypeSafe Jev', calibrated: true }); // on the plan…
    const m = turnPlanMetadata({ lane: 'standard', cls: null, roster: null, act: false, reason: 'r', mode: 'shadow', taskKind: { ...tk, probs: { writing: 0.9 } } as any }) as any;
    expect(m.taskKind).toEqual({ kind: 'writing', top: 'writing', p: 0.9, averaged: true, harm: 0.24, usable: true, decisionId: 'tk1' }); // …not on the row
    expect(turnPlanMetadata({ lane: 'standard', cls: null, roster: null, act: false, reason: 'r', mode: 'shadow' }) as any).not.toHaveProperty('taskKind');
  });

  it('turnTaskKindOf: no classification ⇒ null; an unanswered decision keeps the class without decision fields', () => {
    expect(turnTaskKindOf(null)).toBeNull();
    expect(turnTaskKindOf({ cls: null, decision: null, usableKind: null })).toBeNull();
    const cls = classifyTaskKind(kindAnswers('code'))!;
    expect(turnTaskKindOf({ cls, decision: null, usableKind: null })).toEqual({ kind: 'code', top: 'code', p: cls.p, averaged: true, harm: 0.237, usable: false });
  });
});

describe('the default dep — task-kind.ts decideTaskKind asks its OWN purpose', () => {
  beforeEach(() => { mockDecide.mockReset(); delete process.env.TASK_KIND_DISABLED; });
  afterAll(() => { delete process.env.TASK_KIND_DISABLED; });

  it('purpose task_kind, both option orders + harm, the caller\'s budget / session / segment; usable only when calibrated', async () => {
    mockDecide.mockResolvedValue({ id: 'tk9', mode: 'shadow', backend: 'jev', ms: 70, calibrated: true, answers: kindAnswers('planning') });
    const r = await decideTaskKind({ message: 'plan a 3-day trip to Lisbon' }, { timeoutMs: 1200, sessionId: 'c9', segment: 'guest' });
    expect(mockDecide.mock.calls[0][2]).toEqual({ purpose: 'task_kind', timeoutMs: 1200, sessionId: 'c9', segment: 'guest', challengers: false });
    expect(Object.keys(mockDecide.mock.calls[0][1])).toEqual(Object.keys(taskKindQuestions()));
    expect(r.usableKind).toBe('planning');
    mockDecide.mockResolvedValue({ id: 'tk10', mode: 'shadow', backend: 'readout', ms: 70, calibrated: false, answers: kindAnswers('planning') });
    expect((await decideTaskKind({ message: 'x' }, { timeoutMs: 1200 })).usableKind).toBeNull();
  });

  it('TASK_KIND_DISABLED=1 ⇒ no ask; an error ⇒ nothing', async () => {
    process.env.TASK_KIND_DISABLED = '1';
    expect(await decideTaskKind({ message: 'x' }, { timeoutMs: 1200 })).toEqual({ cls: null, decision: null, usableKind: null });
    expect(mockDecide).not.toHaveBeenCalled();
    delete process.env.TASK_KIND_DISABLED;
    mockDecide.mockRejectedValue(new Error('backend down'));
    expect(await decideTaskKind({ message: 'x' }, { timeoutMs: 1200 })).toEqual({ cls: null, decision: null, usableKind: null });
  });
});
