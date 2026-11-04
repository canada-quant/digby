/**
 * GOAL-UNPLANNED part 1 (architecture review #6, 2026-10-20) — the Project
 * Pulse mapped "remaining ≤ 0" to class 'done' and rendered "all tasks done"
 * for a goal that was still OPEN (remaining excludes dropped todos, while
 * maybeAutoCompleteGoal refuses to close an all-dropped goal — the two
 * contradicted each other; a never-decomposed goal read "done" too). Now an
 * ACTIVE goal with zero open non-dropped todos is class 'unplanned' ("no open
 * tasks — needs a plan"), a gate / hold on it still wins, and the rollup
 * treats it like no_movement. GOAL_UNPLANNED_SIGNAL_DISABLED=1 restores 'done'.
 * Mock harness mirrors project-digest.eta-gates.test.ts.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: jest.fn() }));
jest.mock('./fleet.service', () => ({ getSidebarHiddenFleetArtifacts: jest.fn() }));
jest.mock('../platform/loop-metrics.service', () => ({ recordLoopMetric: jest.fn() }));

import { computeGoalEta, computeGoalProgress, computeEtaSummary, etaSummaryPhrase, goalEtaPhrase } from './project-digest.service';

const NOW = new Date('2026-10-20T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const goal = (over: any = {}) => ({ id: 'g1', title: 'Hit 10 tok/s', status: 'active', blockKind: null, progressNote: null, premises: [], ...over });
const todo = (status: string, over: any = {}) => ({ goalId: 'g1', status, updatedAt: daysAgo(2), ...over });

beforeEach(() => { delete process.env.GOAL_UNPLANNED_SIGNAL_DISABLED; });

describe('computeGoalEta — the unplanned class', () => {
  it('nothing remains on an ACTIVE goal ⇒ unplanned (a gate / hold still wins); unset ⇒ done as before', () => {
    expect(computeGoalEta({ remaining: 0, blockedGate: false, completed24h: 0, completed7d: 2, unplannedEligible: true }).class).toBe('unplanned');
    expect(computeGoalEta({ remaining: 0, blockedGate: false, completed24h: 0, completed7d: 2, unplannedEligible: true, heldGate: true }).class).toBe('held');
    expect(computeGoalEta({ remaining: 0, blockedGate: true, completed24h: 0, completed7d: 2, unplannedEligible: true }).class).toBe('blocked');
    expect(computeGoalEta({ remaining: 0, blockedGate: false, completed24h: 0, completed7d: 2 }).class).toBe('done');
    expect(computeGoalEta({ remaining: 2, blockedGate: false, completed24h: 0, completed7d: 2, unplannedEligible: true }).class).toBe('on_pace');
  });

  it('the phrase: "no open tasks — needs a plan" (a registered deadline rides it)', () => {
    const eta = computeGoalEta({ remaining: 0, blockedGate: false, completed24h: 0, completed7d: 0, unplannedEligible: true });
    expect(goalEtaPhrase({ blockedCount: 0, eta })).toBe('no open tasks — needs a plan');
    expect(goalEtaPhrase({ blockedCount: 0, eta: { ...eta, deadline: { key: 'sft2_start_by_unixts', at: daysAgo(-3).toISOString(), daysLeft: 3 } } }))
      .toBe('no open tasks — needs a plan (sft2 start deadline due in 3 days)');
  });
});

describe('computeGoalProgress — the contradiction cases', () => {
  it('all todos done on a still-ACTIVE goal, all dropped, or none at all ⇒ unplanned; a BLOCKED goal never is (its pre-change class stands)', () => {
    expect(computeGoalProgress([goal()], [todo('done'), todo('done')], NOW)[0].eta.class).toBe('unplanned');
    expect(computeGoalProgress([goal()], [todo('dropped'), todo('dropped')], NOW)[0].eta.class).toBe('unplanned');
    expect(computeGoalProgress([goal()], [], NOW)[0].eta.class).toBe('unplanned');
    expect(computeGoalProgress([goal({ status: 'blocked', blockKind: 'external' })], [todo('done')], NOW)[0].eta.class).not.toBe('unplanned');
    expect(computeGoalProgress([goal({ progressNote: 'HOLD until the owner rules' })], [todo('done')], NOW)[0].eta.class).toBe('held');
    expect(computeGoalProgress([goal()], [todo('done'), todo('pending')], NOW)[0].eta.class).toBe('on_pace');
  });

  it('kill switch GOAL_UNPLANNED_SIGNAL_DISABLED=1 ⇒ done / "all tasks done" as before', () => {
    process.env.GOAL_UNPLANNED_SIGNAL_DISABLED = '1';
    const gp = computeGoalProgress([goal()], [todo('done')], NOW)[0];
    expect(gp.eta.class).toBe('done');
    expect(goalEtaPhrase(gp)).toBe('all tasks done');
  });
});

describe('computeEtaSummary — the rollup treats unplanned like no_movement', () => {
  it('only unplanned goals open ⇒ no_movement (never "all tasks done"), with the needs-a-plan phrase; the count rides only when > 0', () => {
    const one = computeEtaSummary(computeGoalProgress([goal()], [todo('done')], NOW))!;
    expect(one.class).toBe('no_movement');
    expect(one.unplannedGoals).toBe(1);
    expect(etaSummaryPhrase(one)).toBe('no open tasks — needs a plan');
    const two = computeEtaSummary(computeGoalProgress([goal(), goal({ id: 'g2', title: 'Other' })], [todo('done'), todo('done', { goalId: 'g2' })], NOW))!;
    expect(etaSummaryPhrase(two)).toBe('no open tasks — 2 goals need a plan');
    const paced = computeEtaSummary(computeGoalProgress([goal()], [todo('done'), todo('pending')], NOW))!;
    expect(paced.unplannedGoals).toBeUndefined(); // other projects' stored signatures stay byte-identical
  });

  it('an unplanned goal beside a paced one: the rollup keeps the pace; beside a blocked one it is not "all gated"', () => {
    const paced = computeEtaSummary(computeGoalProgress([goal(), goal({ id: 'g2', title: 'Paced' })], [todo('done'), todo('done', { goalId: 'g2' }), todo('pending', { goalId: 'g2' })], NOW))!;
    expect(paced.class).toBe('on_pace');
    const gated = computeEtaSummary(computeGoalProgress([goal(), goal({ id: 'g2', title: 'Gated', status: 'blocked', blockKind: 'external' })], [todo('done'), todo('blocked', { goalId: 'g2', blockKind: 'external' })], NOW))!;
    expect(gated.class).not.toBe('blocked');
  });
});
