/**
 * N4 (2026-09-25) — the Level 2 checker-site router (purpose checker_route,
 * questions depth + needs_live_web): request shape, the harness-derived
 * labels (the heavy-un-merged confound reads UNKNOWN, review 2026-09-25),
 * the act verdict (result.mode + threshold; `unclear` never acts) and the
 * outcome recording. Pure leaf over a mocked decision-gate boundary.
 */
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decisionThreshold: (p: string, fallback: number) => {
    const raw = Number(process.env[`DECISION_GATE_THRESHOLD_${p.toUpperCase()}`]);
    return Math.min(1, Math.max(0.5, Number.isFinite(raw) ? raw : fallback));
  },
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

import {
  buildCheckerRouteRequest, deriveCheckerDepthActual, checkerTurnHeavy, checkerRouteVerdict, recordCheckerRouteOutcome, checkerRouteNote,
  checkerRouteDisabled, CHECKER_ROUTE_PURPOSE, CHECKER_ROUTE_QUESTION, CHECKER_ROUTE_WEB_QUESTION, type CheckerRunFacts,
} from './checker-route-gate';

const ENV = ['DECISION_GATE_CHECKER_ROUTE_DISABLED', 'DECISION_GATE_THRESHOLD_CHECKER_ROUTE', 'DECISION_GATE_THRESHOLD_AUTO_ROUTE'];
beforeEach(() => { jest.clearAllMocks(); for (const k of ENV) delete process.env[k]; });

const decision = (depth: string, confidence: number, web = 0.2, mode: 'shadow' | 'act' = 'act') => ({
  id: 'd1', backend: 'TypeSafe Jev', ms: 10, mode,
  answers: {
    [CHECKER_ROUTE_QUESTION]: { type: 'choice' as const, choice: depth, confidence, probabilities: { [depth]: confidence } },
    [CHECKER_ROUTE_WEB_QUESTION]: { type: 'noul' as const, noul: web },
  },
});
const facts = (over: Partial<CheckerRunFacts> = {}): CheckerRunFacts => ({
  regexSimple: false, leadToolCalls: 1, webToolCalls: 0, finalChars: 1200, checkerMerged: false, lateArmed: false, ...over,
});

describe('buildCheckerRouteRequest', () => {
  it('state = message ≤ 2k + last user turn ≤ 1k; a choice with the four depths (unclear = escape) + a criteria-bearing noul', () => {
    const { state, questions } = buildCheckerRouteRequest({ message: 'x'.repeat(5000), lastUserTurn: 'y'.repeat(3000) });
    expect((state.message as string).length).toBe(2000);
    expect((state.last_user_turn as string).length).toBe(1000);
    expect(Object.keys(questions).sort()).toEqual(['depth', 'needs_live_web']);
    const depth = questions.depth as any;
    expect(depth.type).toBe('choice');
    expect(Object.keys(depth.criteria).sort()).toEqual(['contestable', 'ordinary', 'simple_lookup', 'unclear']);
    const web = questions.needs_live_web as any;
    expect(web.type).toBe('noul');
    expect(web.criteria.true).toBeTruthy();
    expect(web.criteria.false).toBeTruthy();
  });
  it('omits last_user_turn when there is none', () => {
    const { state } = buildCheckerRouteRequest({ message: 'hi' });
    expect(state).toEqual({ message: 'hi' });
  });
  it('is its OWN purpose (never auto_route — the router\'s readiness stamp must not measure checker rows)', () => {
    expect(CHECKER_ROUTE_PURPOSE).toBe('checker_route');
  });
});

describe('deriveCheckerDepthActual (harness facts → label)', () => {
  it('simple_lookup ⇔ no lead tool round AND a short final', () => {
    expect(deriveCheckerDepthActual(facts({ leadToolCalls: 0, finalChars: 300 }))).toBe('simple_lookup');
    expect(deriveCheckerDepthActual(facts({ leadToolCalls: 0, finalChars: 900 }))).toBe('ordinary');
    expect(deriveCheckerDepthActual(facts({ leadToolCalls: 1, finalChars: 300 }))).toBe('ordinary');
  });
  it('a HEAVY turn is contestable when the checker draft merged, and UNKNOWN (null) when it did not — never ordinary (the wait cap, not the question, decided the merge)', () => {
    expect(checkerTurnHeavy({ leadToolCalls: 3, finalChars: 100 })).toBe(true);
    expect(checkerTurnHeavy({ leadToolCalls: 0, finalChars: 2500 })).toBe(true);
    expect(checkerTurnHeavy({ leadToolCalls: 2, finalChars: 2499 })).toBe(false);
    expect(deriveCheckerDepthActual(facts({ checkerMerged: true, leadToolCalls: 3, finalChars: 1000 }))).toBe('contestable');
    expect(deriveCheckerDepthActual(facts({ checkerMerged: true, leadToolCalls: 1, finalChars: 3000 }))).toBe('contestable');
    expect(deriveCheckerDepthActual(facts({ checkerMerged: false, leadToolCalls: 5, finalChars: 4000 }))).toBeNull();
    expect(deriveCheckerDepthActual(facts({ checkerMerged: false, lateArmed: true, regexSimple: true, leadToolCalls: 3, finalChars: 900 }))).toBeNull();
  });
  it('a LIGHT turn is ordinary regardless of the merge (treatment-independent)', () => {
    expect(deriveCheckerDepthActual(facts({ checkerMerged: true, leadToolCalls: 1, finalChars: 1000 }))).toBe('ordinary');
    expect(deriveCheckerDepthActual(facts({ checkerMerged: false, leadToolCalls: 1, finalChars: 1000 }))).toBe('ordinary');
  });
  it('never returns unclear', () => {
    for (const f of [facts(), facts({ leadToolCalls: 0, finalChars: 0 }), facts({ checkerMerged: true, leadToolCalls: 9, finalChars: 9000 }), facts({ leadToolCalls: 9 })]) {
      expect(deriveCheckerDepthActual(f)).not.toBe('unclear');
    }
  });
});

describe("checkerRouteVerdict (act semantics behind the RESULT's mode — E2)", () => {
  it('null / shadow-mode results never act; the answers are still read', () => {
    expect(checkerRouteVerdict(null)).toEqual({ depth: null, depthConfidence: null, needsLiveWeb: null, actSimple: null });
    const v = checkerRouteVerdict(decision('simple_lookup', 0.95, 0.1, 'shadow') as any);
    expect(v).toMatchObject({ depth: 'simple_lookup', depthConfidence: 0.95, needsLiveWeb: 0.1, actSimple: null });
  });
  it('act + confident: simple_lookup → true, contestable → false, ordinary → null (regex decides), unclear → null', () => {
    expect(checkerRouteVerdict(decision('simple_lookup', 0.9) as any).actSimple).toBe(true);
    expect(checkerRouteVerdict(decision('contestable', 0.9) as any).actSimple).toBe(false);
    expect(checkerRouteVerdict(decision('ordinary', 0.9) as any).actSimple).toBeNull();
    expect(checkerRouteVerdict(decision('unclear', 0.99) as any).actSimple).toBeNull();
  });
  it("below the threshold (0.7 default; env DECISION_GATE_THRESHOLD_CHECKER_ROUTE — auto_route's env is NOT read) nothing acts", () => {
    expect(checkerRouteVerdict(decision('simple_lookup', 0.65) as any).actSimple).toBeNull();
    process.env.DECISION_GATE_THRESHOLD_AUTO_ROUTE = '0.6';
    expect(checkerRouteVerdict(decision('simple_lookup', 0.65) as any).actSimple).toBeNull();
    process.env.DECISION_GATE_THRESHOLD_CHECKER_ROUTE = '0.6';
    expect(checkerRouteVerdict(decision('simple_lookup', 0.65) as any).actSimple).toBe(true);
  });
  it('kill switch reads DECISION_GATE_CHECKER_ROUTE_DISABLED', () => {
    expect(checkerRouteDisabled()).toBe(false);
    process.env.DECISION_GATE_CHECKER_ROUTE_DISABLED = '1';
    expect(checkerRouteDisabled()).toBe(true);
  });
});

describe('recordCheckerRouteOutcome', () => {
  it('writes one row per question under purpose checker_route with the derived actuals, the facts note and site:checker extras', () => {
    const f = facts({ regexSimple: true, leadToolCalls: 0, webToolCalls: 0, finalChars: 200 });
    recordCheckerRouteOutcome(decision('ordinary', 0.8, 0.3, 'shadow') as any, f, { sessionId: 's1' });
    expect(mockRecord).toHaveBeenCalledTimes(2);
    const depthRow = mockRecord.mock.calls.find(c => c[2].question === 'depth')![2];
    const webRow = mockRecord.mock.calls.find(c => c[2].question === 'needs_live_web')![2];
    expect(depthRow).toMatchObject({ actual: 'simple_lookup', acted: false, sessionId: 's1', note: checkerRouteNote(f, false) });
    expect(depthRow.extra).toMatchObject({ site: 'checker', regexSimple: true, leadToolCalls: 0, finalChars: 200 });
    expect(webRow).toMatchObject({ actual: false });
    expect(depthRow.note).toContain('regex:simple');
    expect(mockRecord.mock.calls.every(c => c[1] === 'checker_route')).toBe(true);
  });
  it('needs_live_web actual = the lead fired a web tool; acted rides through', () => {
    recordCheckerRouteOutcome(decision('ordinary', 0.8) as any, facts({ webToolCalls: 2 }), { acted: true });
    const webRow = mockRecord.mock.calls.find(c => c[2].question === 'needs_live_web')![2];
    expect(webRow).toMatchObject({ actual: true, acted: true });
    expect(webRow.note).toContain('acted');
  });
  it('a heavy un-merged turn records depth actual:null (unknown, noted) while needs_live_web is still labelled', () => {
    recordCheckerRouteOutcome(decision('contestable', 0.8) as any, facts({ leadToolCalls: 4, webToolCalls: 1, checkerMerged: false, lateArmed: true }), {});
    const depthRow = mockRecord.mock.calls.find(c => c[2].question === 'depth')![2];
    const webRow = mockRecord.mock.calls.find(c => c[2].question === 'needs_live_web')![2];
    expect(depthRow.actual).toBeNull();
    expect(depthRow.note).toContain('depth unknown');
    expect(webRow).toMatchObject({ actual: true });
  });
  it('a failed finalize (or no facts) records actual:null on both rows; a null decision records nothing', () => {
    recordCheckerRouteOutcome(decision('ordinary', 0.8) as any, facts(), { failed: true });
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls.every(c => c[2].actual === null)).toBe(true);
    mockRecord.mockClear();
    recordCheckerRouteOutcome(null, facts(), {});
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

// 2026-09-26 audit (gate-runtime-5): checker_route's OLD `contestable` line ("high-stakes … wait for the
// independent cross-check before it ships") made Laya (cql-litellm:agx-laya, systemone_chat) return NaN on the
// sibling `needs_live_web` noul deterministically (4/4 probes, 14/14 prod rows); compute_policy's wording on the
// same two keys parsed 10/10. The criterion now carries compute_policy's text (pinned equal in
// platform/compute-policy-gate.test.ts); a rewording resets the questionsHash partition — do it knowingly.
describe('2026-09-26 audit — contestable wording shared with compute_policy', () => {
  it('the `contestable` criterion is compute_policy\'s (not the Laya-NaN "high-stakes … before it ships" line)', () => {
    const { questions } = buildCheckerRouteRequest({ message: 'x' });
    const depth = questions[CHECKER_ROUTE_QUESTION] as Extract<typeof questions[string], { type: 'choice' }>;
    expect(depth.criteria.contestable).toBe('A disputable, multi-part or easy-to-get-wrong question — the answer should be cross-checked before the user acts on it');
    expect(depth.criteria.contestable).not.toMatch(/high-stakes|before it ships/);
  });
});
