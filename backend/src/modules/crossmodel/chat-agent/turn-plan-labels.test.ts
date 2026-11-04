/**
 * Dynamic roster phase 2 — turn_plan labels (owner 2026-10-03: learn from
 * Dig-deeper taps, re-asks, thumbs and replays; no live exploration).
 */
const mockRecord = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  reconstructDecision: (s: any) => (s && s.id ? { id: s.id, purpose: 'turn_plan', mode: s.mode ?? 'shadow', backend: 'TypeSafe Jev', answers: s.answers ?? {}, ms: 0 } : null),
  recordDecisionOutcome: (...a: any[]) => mockRecord(...a),
}));
jest.mock('../platform/turn-plan', () => ({ LANES: ['quick', 'standard', 'checked', 'research'], TURN_PLAN_PURPOSE: 'turn_plan' }));

import { nextLaneUp, turnPlanFromMetadata, actualLaneFor, labelTurnPlan, TURN_PLAN_ESCALATION_WINDOW_MS, ranLaneFromDepth, ranRosterOf } from './turn-plan-labels';

const meta = (lane: string, act = false, synthetic = false) => ({ depth: { turnPlan: { lane, act, ...(synthetic ? { synthetic: true } : {}), stash: { id: 'tp1', mode: act ? 'act' : 'shadow', answers: {} }, roster: { lead: 'cql:q-flash' } } } });

beforeEach(() => { mockRecord.mockReset(); delete process.env.TURN_PLAN_LABELS_DISABLED; delete process.env.TURN_PLAN_COUNTERFACTUAL_LABELS_DISABLED; });

describe('lane arithmetic', () => {
  it('nextLaneUp climbs one lane and stops at research', () => {
    expect(['quick', 'standard', 'checked', 'research'].map(l => nextLaneUp(l as any))).toEqual(['standard', 'checked', 'research', 'research']);
  });
  it('a tap / re-ask / thumbs-down needed the next lane; a window close / thumbs-up held', () => {
    expect(actualLaneFor('quick', 'tap')).toBe('standard');
    expect(actualLaneFor('quick', 'reask')).toBe('standard');
    expect(actualLaneFor('checked', 'thumbs_down')).toBe('research');
    expect(actualLaneFor('quick', 'window_closed')).toBe('quick');
    expect(actualLaneFor('quick', 'thumbs_up')).toBe('quick');
  });
});

describe('turnPlanFromMetadata', () => {
  it('reads the persisted record; missing stash / unknown lane ⇒ null', () => {
    expect(turnPlanFromMetadata(meta('quick', true))).toMatchObject({ lane: 'quick', act: true, lead: 'cql:q-flash' });
    expect(turnPlanFromMetadata({ depth: { turnPlan: { lane: 'quick' } } })).toBeNull();
    expect(turnPlanFromMetadata({ depth: { turnPlan: { lane: 'nope', stash: { id: 'x' } } } })).toBeNull();
    expect(turnPlanFromMetadata(null)).toBeNull();
  });
  it('P3: synthetic flag round-trips (absent ⇒ false, only === true counts)', () => {
    expect(turnPlanFromMetadata(meta('quick', false, true))?.synthetic).toBe(true);
    expect(turnPlanFromMetadata(meta('quick'))?.synthetic).toBe(false);
    expect(turnPlanFromMetadata({ depth: { turnPlan: { lane: 'quick', synthetic: 'yes', stash: { id: 'x' } } } })?.synthetic).toBe(false);
  });
});

describe('labelTurnPlan', () => {
  it('a tap ≤ 30 min writes the PRIMARY escalated row with the next lane up and acted from the record', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    expect(labelTurnPlan(meta('quick', true), 'tap', { sessionId: 'c1', messageCreatedAt: new Date(now.getTime() - 60_000), now })).toBe('escalated');
    const [decision, purpose, outcome] = mockRecord.mock.calls[0];
    expect(decision.id).toBe('tp1');
    expect(purpose).toBe('turn_plan');
    expect(outcome).toMatchObject({ question: 'lane', actual: 'standard', acted: true, label: 'escalated', sessionId: 'c1', extra: { signal: 'tap', predictedLane: 'quick', lead: 'cql:q-flash' } });
  });
  it('a LATE tap is a secondary escalated_late row', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    expect(labelTurnPlan(meta('standard'), 'tap', { messageCreatedAt: new Date(now.getTime() - TURN_PLAN_ESCALATION_WINDOW_MS - 1), now })).toBe('escalated_late');
  });
  it('window close: the lane held (primary escalated row, actual = predicted)', () => {
    expect(labelTurnPlan(meta('checked'), 'window_closed')).toBe('escalated');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: 'checked', acted: false, label: 'escalated' });
  });
  it('re-ask and thumbs are secondary rows', () => {
    expect(labelTurnPlan(meta('quick'), 'reask')).toBe('reask_5m');
    expect(labelTurnPlan(meta('quick'), 'thumbs_down')).toBe('thumbs');
    expect(mockRecord.mock.calls.map(c => c[2].actual)).toEqual(['standard', 'standard']);
  });
  it('no record ⇒ nothing; TURN_PLAN_LABELS_DISABLED=1 ⇒ nothing', () => {
    expect(labelTurnPlan({ depth: {} }, 'tap')).toBe(false);
    process.env.TURN_PLAN_LABELS_DISABLED = '1';
    expect(labelTurnPlan(meta('quick'), 'tap')).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
  it('P3: a synthetic record still writes the row but stamps excludeFromFit:true (proxy label, never fit evidence)', () => {
    expect(labelTurnPlan(meta('quick', true, true), 'tap', { sessionId: 'c9' })).toBe('escalated');
    const [decision, purpose, outcome] = mockRecord.mock.calls[0];
    expect(purpose).toBe('turn_plan');
    expect(outcome).toMatchObject({ question: 'lane', actual: 'standard', acted: true, label: 'escalated', sessionId: 'c9', excludeFromFit: true });
    expect(outcome.extra).toMatchObject({ signal: 'tap', predictedLane: 'quick', lead: 'cql:q-flash', synthetic: true });
    expect(outcome.note).toContain('synthetic — excluded from fit');
  });
  it('P3: a non-synthetic record carries NO excludeFromFit key (fit evidence unaffected)', () => {
    expect(labelTurnPlan(meta('quick', true), 'tap', { sessionId: 'c10' })).toBe('escalated');
    const outcome = mockRecord.mock.calls[0][2];
    expect(outcome.excludeFromFit).toBeUndefined();
    expect(outcome.extra.synthetic).toBeUndefined();
    expect(outcome.note).not.toContain('synthetic');
  });
});

describe('roster 2026-10-06 B-1 — label hygiene (supervisor rows + the counterfactual rule)', () => {
  /** A persisted answer row: the turn plan's predicted lane + the depth plan / facts the turn actually ran. */
  const row = (lane: string, depth: Record<string, unknown>, tpExtra: Record<string, unknown> = {}) => ({
    depth: { ...depth, turnPlan: { lane, act: false, stash: { id: 'tp1', mode: 'shadow', answers: {} }, roster: { lead: 'glm-5.3' }, ...tpExtra } },
  });
  const L1 = { plan: { preset: 'single_thinking', spawnChecker: false }, facts: { checkerSpawned: false } };
  const L2 = { plan: { preset: 'thinking', spawnChecker: true }, facts: { checkerSpawned: true } };
  const L3 = { plan: { preset: 'deep_research', spawnChecker: false } };

  it('ranLaneFromDepth: the stamped ran.lane wins; else quick act / plan lane quick; else council ⇒ research, a spawned checker ⇒ checked, otherwise standard; no plan ⇒ null', () => {
    expect(ranLaneFromDepth(row('standard', L2, { ran: { lane: 'standard' } }))).toBe('standard');
    expect(ranLaneFromDepth(row('quick', { plan: { preset: 'single_thinking', lane: 'quick' } }))).toBe('quick');
    expect(ranLaneFromDepth(row('quick', {}, { act: true }))).toBe('quick');
    expect(ranLaneFromDepth(row('research', L3))).toBe('research');
    expect(ranLaneFromDepth(row('checked', L2))).toBe('checked');
    expect(ranLaneFromDepth(row('standard', L1))).toBe('standard');
    // facts win over the plan (an L2 plan whose checker seat was unservable ran standard; a supervisor L2 without the checker too)
    expect(ranLaneFromDepth(row('checked', { plan: { preset: 'thinking', spawnChecker: true }, facts: { checkerSpawned: false } }))).toBe('standard');
    expect(ranLaneFromDepth(row('checked', { plan: { preset: 'thinking', spawnChecker: true } }))).toBe('checked');
    expect(ranLaneFromDepth(meta('quick'))).toBeNull();
    expect(ranLaneFromDepth(null)).toBeNull();
  });

  it('ranRosterOf: quick / research / checked / standard; the checker only when it spawned on a non-quick, non-council turn; colleagues only on a council, deduped', () => {
    expect(ranRosterOf({ quick: true, council: false, checkerSpawned: false, lead: 'q-flash', checker: 'deepseek-flash' })).toEqual({ lane: 'quick', lead: 'q-flash', checker: null, colleagues: [] });
    expect(ranRosterOf({ quick: false, council: false, checkerSpawned: true, lead: 'glm-5.3', checker: 'deepseek-flash' })).toEqual({ lane: 'checked', lead: 'glm-5.3', checker: 'deepseek-flash', colleagues: [] });
    expect(ranRosterOf({ quick: false, council: false, checkerSpawned: false, lead: 'kimi-k3', checker: 'deepseek-flash' })).toEqual({ lane: 'standard', lead: 'kimi-k3', checker: null, colleagues: [] });
    expect(ranRosterOf({ quick: false, council: true, checkerSpawned: false, lead: 'kimi-k3', colleagues: ['glm-5.3', undefined, 'glm-5.3', 'deepseek-flash'] })).toEqual({ lane: 'research', lead: 'kimi-k3', checker: null, colleagues: ['glm-5.3', 'deepseek-flash'] });
  });

  it('the predicted lane RAN ⇒ the row enters the fit as before (no excludeFromFit key), ranLane on the extra', () => {
    expect(labelTurnPlan(row('checked', L2), 'window_closed', { sessionId: 'c1' })).toBe('escalated');
    const o = mockRecord.mock.calls[0][2];
    expect(o.excludeFromFit).toBeUndefined();
    expect(o.extra).toMatchObject({ predictedLane: 'checked', ranLane: 'checked' });
    expect(o.extra.counterfactual).toBeUndefined();
  });

  it('COUNTERFACTUAL: a lane that did not run is written excludeFromFit (the user saw another lane) — window close, tap, re-ask and thumbs alike', () => {
    // predicted standard, the L2 preset ran a checker ⇒ "no complaint" speaks to checked, not standard
    expect(labelTurnPlan(row('standard', L2), 'window_closed', { sessionId: 'c2' })).toBe('escalated');
    // predicted checked, the L1 preset ran without a checker
    expect(labelTurnPlan(row('checked', L1), 'tap')).toBe('escalated');
    // predicted quick, the quick guards refused and L2 ran
    expect(labelTurnPlan(row('quick', L2), 'reask')).toBe('reask_5m');
    for (const [, , o] of mockRecord.mock.calls) {
      expect(o.excludeFromFit).toBe(true);
      expect(o.extra.counterfactual).toBe(true);
      expect(o.note).toMatch(/counterfactual \(ran (checked|standard)\) — excluded from fit/);
    }
    expect(mockRecord.mock.calls.map(c => c[2].extra.ranLane)).toEqual(['checked', 'standard', 'checked']);
    // the actual still follows the signal on the PREDICTED lane (the row stays readable as before)
    expect(mockRecord.mock.calls.map(c => c[2].actual)).toEqual(['standard', 'research', 'standard']);
  });

  it('a Quick act row (ran quick) is fit evidence; an old row with no depth plan keeps today\'s behaviour', () => {
    labelTurnPlan(row('quick', { plan: { preset: 'single_thinking', lane: 'quick', spawnChecker: false } }, { act: true }), 'tap');
    labelTurnPlan(meta('standard'), 'window_closed');
    expect(mockRecord.mock.calls.map(c => c[2].excludeFromFit)).toEqual([undefined, undefined]);
  });

  it('SUPERVISOR rows never enter the fit: the record flag (asked under the kill switch) or an older row\'s compute_policy stash segment', () => {
    labelTurnPlan(row('checked', L2, { supervisor: true }), 'window_closed');
    labelTurnPlan({ depth: { ...L2, decision: { id: 'cp1', segment: 'supervisor', answers: {} }, turnPlan: { lane: 'checked', act: false, stash: { id: 'tp2', answers: {} } } } }, 'thumbs_up');
    for (const [, , o] of mockRecord.mock.calls) {
      expect(o.excludeFromFit).toBe(true);
      expect(o.extra.supervisor).toBe(true);
      expect(o.note).toContain('supervisor chat');
    }
    expect(turnPlanFromMetadata(row('checked', L2))?.supervisor).toBe(false);
  });

  it('TURN_PLAN_COUNTERFACTUAL_LABELS_DISABLED=1 restores the pre-2026-10-06 rule (a lane that did not run enters the fit); supervisor / synthetic exclusions stay', () => {
    process.env.TURN_PLAN_COUNTERFACTUAL_LABELS_DISABLED = '1';
    labelTurnPlan(row('standard', L2), 'window_closed');
    labelTurnPlan(row('standard', L2, { supervisor: true }), 'window_closed');
    expect(mockRecord.mock.calls[0][2].excludeFromFit).toBeUndefined();
    expect(mockRecord.mock.calls[0][2].extra.counterfactual).toBeUndefined();
    expect(mockRecord.mock.calls[1][2].excludeFromFit).toBe(true);
  });
});
