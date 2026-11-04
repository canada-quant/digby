/**
 * GOAL-PRIORITY-SPEND (supervisor SOTA round 3, 2026-10-20) — the pure ranking
 * rules. Pins: P1..P4 parsing (unset = P2), the owner-wins write rule, the
 * owner-text gate, the score model (one priority level outweighs all accrual),
 * the stable rank (owner-set first, then input / FIFO order), the
 * continuation pick, the renderers and the two kill switches.
 */
import {
  goalPriorityOrderDisabled, goalSpendAttributionDisabled,
  parseGoalPriorityInput, parseGoalDueAtInput, effectiveGoalPriority, goalPriorityLabel, validGoalPriority,
  decidePriorityWrite, priorityRefusalNote, ownerTextNamesRanking,
  rankingLevelsNamed, ownerTextNamesDueDate, ownerTextPointsAtGoal, ownerTextBacksRanking,
  goalDuePoints, goalAgePoints, goalKpiGap, renderKpiGapText, scoreGoal, goalUnblockCounts,
  rankGoalsByScore, pickHighestScoredTodo, renderGoalScorePrefix, formatGoalUsd, renderGoalSpendClause,
  GOAL_PRIORITY_WEIGHT, GOAL_DUE_POINTS, GOAL_AGE_POINTS_CAP, GOAL_KPI_GAP_POINTS, GOAL_UNBLOCK_POINTS_EACH, GOAL_UNBLOCK_COUNT_CAP,
} from './goal-priority';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const DAY = 24 * 3600_000;
const kpi = (value: number, bar: number) => [{ key: 'kpi:tok_s', value, unit: 'tok/s', bar, history: [{ value: 2 }] }];

describe('kill switches', () => {
  it('are read per call (1 / true / on)', () => {
    expect(goalPriorityOrderDisabled({} as any)).toBe(false);
    expect(goalPriorityOrderDisabled({ GOAL_PRIORITY_ORDER_DISABLED: '1' } as any)).toBe(true);
    expect(goalSpendAttributionDisabled({ GOAL_SPEND_ATTRIBUTION_DISABLED: 'true' } as any)).toBe(true);
    expect(goalSpendAttributionDisabled({ GOAL_SPEND_ATTRIBUTION_DISABLED: '0' } as any)).toBe(false);
  });
});

describe('priority / dueAt input', () => {
  it('accepts 1..4, "1".."4" and "P1".."P4"; null / "" clear; undefined is absent; the rest is invalid', () => {
    expect(parseGoalPriorityInput(undefined)).toEqual({ kind: 'absent' });
    expect(parseGoalPriorityInput(null)).toEqual({ kind: 'clear' });
    expect(parseGoalPriorityInput('  ')).toEqual({ kind: 'clear' });
    expect(parseGoalPriorityInput(1)).toEqual({ kind: 'set', value: 1 });
    expect(parseGoalPriorityInput('p3')).toEqual({ kind: 'set', value: 3 });
    expect(parseGoalPriorityInput('4')).toEqual({ kind: 'set', value: 4 });
    for (const bad of [0, 5, 1.5, 'P5', 'high', true]) expect(parseGoalPriorityInput(bad).kind).toBe('invalid');
  });

  it('a due date is an ISO date in 2001..2099; garbage is invalid, never a silent drop', () => {
    expect(parseGoalDueAtInput(undefined)).toEqual({ kind: 'absent' });
    expect(parseGoalDueAtInput(null)).toEqual({ kind: 'clear' });
    expect(parseGoalDueAtInput('2026-11-01')).toEqual({ kind: 'set', value: new Date('2026-11-01T00:00:00Z') });
    expect(parseGoalDueAtInput('next tuesday').kind).toBe('invalid');
    expect(parseGoalDueAtInput('1970-01-01').kind).toBe('invalid');
  });

  it('unset reads as P2; only an int 1..4 is a stored priority', () => {
    expect(effectiveGoalPriority(null)).toBe(2);
    expect(effectiveGoalPriority(undefined)).toBe(2);
    expect(effectiveGoalPriority(9)).toBe(2);
    expect(effectiveGoalPriority(1)).toBe(1);
    expect(goalPriorityLabel(null)).toBe('P2');
    expect(goalPriorityLabel(4)).toBe('P4');
    expect(validGoalPriority('1')).toBeNull();
  });
});

describe('the owner-wins write rule', () => {
  it('the owner always ranks; a machine never over an owner ranking; a lane never; a supervisor on a non-owner goal', () => {
    expect(decidePriorityWrite({ currentSource: 'owner', writer: 'owner' })).toEqual({ allowed: true, source: 'owner' });
    expect(decidePriorityWrite({ currentSource: 'owner', writer: 'machine', actingIsSupervisor: true })).toEqual({ allowed: false, reason: 'refused_owner_set' });
    expect(decidePriorityWrite({ currentSource: null, writer: 'machine', actingIsSupervisor: false })).toEqual({ allowed: false, reason: 'refused_not_supervisor' });
    expect(decidePriorityWrite({ currentSource: 'machine', writer: 'machine', actingIsSupervisor: true })).toEqual({ allowed: true, source: 'machine' });
  });

  it('review fix: a MEMBER (non-owner human) ranks anywhere but over the owner — stamped member, never a lock', () => {
    expect(decidePriorityWrite({ currentSource: null, writer: 'member' })).toEqual({ allowed: true, source: 'member' });
    expect(decidePriorityWrite({ currentSource: 'machine', writer: 'member' })).toEqual({ allowed: true, source: 'member' });
    expect(decidePriorityWrite({ currentSource: 'owner', writer: 'member' })).toEqual({ allowed: false, reason: 'refused_owner_set' });
    // A member's ranking is not a lock: a supervisor may re-rank it.
    expect(decidePriorityWrite({ currentSource: 'member', writer: 'machine', actingIsSupervisor: true })).toEqual({ allowed: true, source: 'machine' });
    expect(priorityRefusalNote('refused_owner_set', { priority: 1 }, 'member')).toMatch(/only the owner changes an owner-set ranking/);
  });

  it('refusal notes say what happened and that the rest applied', () => {
    expect(priorityRefusalNote('refused_owner_set', { priority: 1, prioritySource: 'owner' })).toMatch(/^priority\/dueAt NOT changed: the owner set this goal's ranking \(P1, owner-set\).*Everything else in this call applied/);
    expect(priorityRefusalNote('refused_not_supervisor', {})).toMatch(/only the owner or a supervisor ranks goals/);
  });

  it('a refusal in a call that carried nothing else says the ranking stands and nothing was written (interaction fix 2026-10-20)', () => {
    // The default text is byte-identical to the pre-fix note.
    expect(priorityRefusalNote('refused_owner_set', { priority: 1 })).toBe("priority/dueAt NOT changed: the owner set this goal's ranking (P1, owner-set) and an owner-set ranking is never overwritten by a machine write. Everything else in this call applied. If the ranking looks wrong, ask the owner.");
    expect(priorityRefusalNote('refused_owner_set', { priority: 1 }, 'machine', { nothingElse: true })).toBe("priority/dueAt NOT changed: the owner set this goal's ranking (P1, owner-set) and an owner-set ranking is never overwritten by a machine write. The owner's P1 stands. This call changed nothing else, so nothing was written (not executed). If the ranking looks wrong, ask the owner.");
    expect(priorityRefusalNote('refused_owner_set', { priority: 2 }, 'member', { nothingElse: true })).toMatch(/only the owner changes an owner-set ranking\. The owner's P2 stands\. This call changed nothing else/);
    expect(priorityRefusalNote('refused_not_supervisor', { priority: 3 }, 'machine', { nothingElse: true })).toBe("priority/dueAt NOT changed: only the owner or a supervisor ranks goals (P1..P4). The goal's P3 stands. This call changed nothing else, so nothing was written (not executed). Report the ranking you think is right to your supervisor.");
  });

  it('a human turn ranks as the OWNER only when the owner\'s own text speaks about ranking', () => {
    expect(ownerTextNamesRanking('make the serving goal P1')).toBe(true);
    expect(ownerTextNamesRanking('this is the top priority')).toBe(true);
    expect(ownerTextNamesRanking('please prioritise the bench')).toBe(true);
    expect(ownerTextNamesRanking('it is due by friday')).toBe(true);
    expect(ownerTextNamesRanking('the bench failed due to OOM, fix it')).toBe(false);
    expect(ownerTextNamesRanking('how is it going?')).toBe(false);
    expect(ownerTextNamesRanking('P10 run looks fine')).toBe(false);
    expect(ownerTextNamesRanking(undefined)).toBe(false);
  });

  it('review fix (major): the owner types in lowercase and plain words — all of these name a ranking', () => {
    for (const t of ['make the deploy goal p1', 'bump it to p1', 'this is due friday', 'due 2026-11-01', 'do this first', 'most important goal',
      'can you make it p2?', 'it is due by the 3rd', 'due in 3 days', 'finish by end of week', 'this is our #1 priority', 'put it on the back burner', 'priority 3 please']) {
      expect([t, ownerTextNamesRanking(t)]).toEqual([t, true]);
    }
    expect([...rankingLevelsNamed('make the deploy goal p1')]).toEqual([1]);
    expect([...rankingLevelsNamed('do this first')]).toEqual([1]);
    expect([...rankingLevelsNamed('put it on the back burner')]).toEqual([4]);
    expect([...rankingLevelsNamed('priority two for the bench, P4 for docs')].sort()).toEqual([2, 4]);
    expect(ownerTextNamesDueDate('this is due friday')).toBe(true);
    expect(ownerTextNamesDueDate('due 2026-11-01')).toBe(true);
    expect(ownerTextNamesDueDate('deadline is tomorrow')).toBe(true);
  });

  it('review fix: never a ranking — "due to", instance types, fractions, plain questions, version bumps', () => {
    for (const t of ['the bench failed due to OOM, fix it', 'the bench failed due to friday\'s outage', 'launch a p3.2xlarge for the bench', 'improve throughput by 2.5x',
      'cut latency by 3/4', 'what are our priorities this week?', 'urgent: the deploy is broken, also what are our priorities this week?', 'bump the version', 'P10 run looks fine']) {
      expect([t, ownerTextNamesRanking(t)]).toEqual([t, false]);
    }
    expect(ownerTextNamesDueDate('the deadline may slip.')).toBe(false);
  });

  it('review fix: the text must BACK this write — the level / due date it sets, or this goal by id / title', () => {
    const goal = { id: 'abcdef12-0000-4000-8000-000000000000', title: 'Deploy pipeline' };
    expect(ownerTextBacksRanking('make the deploy goal p1', { priority: 1 }, goal)).toBe(true);
    expect(ownerTextBacksRanking('MAKE IT P1', { priority: 'P1' }, null)).toBe(true);
    expect(ownerTextBacksRanking('make the deploy goal p1', { priority: 3 }, { id: 'ffffffff-x', title: 'Docs' })).toBe(false); // a level nobody named
    expect(ownerTextBacksRanking('this is due friday', { dueAt: '2026-10-23' }, null)).toBe(true);
    expect(ownerTextBacksRanking('this is due friday', { dueAt: '2026-10-23', priority: 1 }, null)).toBe(false); // the guessed priority is unbacked
    expect(ownerTextBacksRanking('remove the priority', { priority: null }, null)).toBe(true);
    expect(ownerTextBacksRanking('no deadline on this one', { dueAt: null }, null)).toBe(true);
    // Finding 4: a ranking word in a question that names no goal backs nothing.
    expect(ownerTextBacksRanking('urgent: the deploy is broken, also what are our priorities this week?', { priority: 1 }, goal)).toBe(false);
    expect(ownerTextBacksRanking('Urgent: our priorities changed. Re-rank as you see fit.', { priority: 2 }, { id: 'ffffffff-x', title: 'Docs' })).toBe(false);
    // Pointing at THIS goal beside ranking language backs any field.
    expect(ownerTextBacksRanking('Urgent: the deploy pipeline must land.', { priority: 2, dueAt: '2026-11-01' }, goal)).toBe(true);
    expect(ownerTextBacksRanking('raise abcdef12 priority please', { priority: 1 }, goal)).toBe(true);
    expect(ownerTextPointsAtGoal('the deploy pipeline', goal)).toBe(true);
    expect(ownerTextPointsAtGoal('the deploy', goal)).toBe(false);
    // Pointing alone (no ranking language) is not an order to rank.
    expect(ownerTextBacksRanking('how is the deploy pipeline going', { priority: 1 }, goal)).toBe(false);
    expect(ownerTextBacksRanking('', { priority: 1 }, goal)).toBe(false);
  });
});

describe('the score', () => {
  it('weights: P1 80 · P2 60 · P3 40 · P4 20 with no accrual', () => {
    expect([1, 2, 3, 4].map((p) => scoreGoal({ id: 'g', priority: p }, { now: NOW }))).toEqual([80, 60, 40, 20]);
    expect(scoreGoal({ id: 'g' }, { now: NOW })).toBe(60);
  });

  it('due / age / KPI-gap / unblock accrual', () => {
    expect(goalDuePoints(NOW - 1, NOW)).toBe(GOAL_DUE_POINTS.overdue);
    expect(goalDuePoints(NOW + 12 * 3600_000, NOW)).toBe(GOAL_DUE_POINTS.day);
    expect(goalDuePoints(NOW + 2 * DAY, NOW)).toBe(GOAL_DUE_POINTS.threeDays);
    expect(goalDuePoints(NOW + 6 * DAY, NOW)).toBe(GOAL_DUE_POINTS.week);
    expect(goalDuePoints(NOW + 30 * DAY, NOW)).toBe(0);
    expect(goalDuePoints(null, NOW)).toBe(0);
    expect(goalAgePoints(new Date(NOW - 15 * DAY), NOW)).toBe(2);
    expect(goalAgePoints(new Date(NOW - 400 * DAY), NOW)).toBe(GOAL_AGE_POINTS_CAP);
    expect(goalAgePoints('garbage', NOW)).toBe(0);
    expect(scoreGoal({ id: 'g', premises: kpi(5, 10) }, { now: NOW })).toBe(60 + GOAL_KPI_GAP_POINTS);
    expect(scoreGoal({ id: 'g', premises: kpi(12, 10) }, { now: NOW })).toBe(60); // bar met — nothing owed
    expect(scoreGoal({ id: 'g' }, { now: NOW, unblockCount: 9 })).toBe(60 + GOAL_UNBLOCK_COUNT_CAP * GOAL_UNBLOCK_POINTS_EACH);
  });

  it('max accrual stays below one priority level — owner intent is sacred', () => {
    const maxedP2 = scoreGoal({ id: 'g', priority: 2, dueAt: new Date(NOW - DAY), createdAt: new Date(NOW - 400 * DAY), premises: kpi(1, 10) }, { now: NOW, unblockCount: 10 });
    const bareP1 = scoreGoal({ id: 'g', priority: 1 }, { now: NOW });
    expect(maxedP2).toBeLessThan(bareP1);
    expect(maxedP2 - 60).toBeLessThan(GOAL_PRIORITY_WEIGHT);
  });

  it('unblock counts only open dependents', () => {
    const counts = goalUnblockCounts([
      { goalId: 'a', dependsOnGoalId: 'x' }, { goalId: 'b', dependsOnGoalId: 'x' }, { goalId: 'done1', dependsOnGoalId: 'x' }, { goalId: 'a', dependsOnGoalId: 'y' },
    ], new Set(['a', 'b']));
    expect(counts.get('x')).toBe(2);
    expect(counts.get('y')).toBe(1);
  });

  it('KPI gap reads the goal\'s own bar (direction from the first value)', () => {
    expect(goalKpiGap(kpi(5.08, 10))).toMatchObject({ gap: 4.92, met: false, direction: 'up' });
    expect(renderKpiGapText(kpi(5.08, 10))).toBe('KPI gap 4.92 tok/s to bar ≥10');
    expect(renderKpiGapText(kpi(11, 10))).toBe('KPI bar ≥10 met');
    expect(renderKpiGapText([{ key: 'kpi:x', value: 3 }])).toBe('');
    expect(renderKpiGapText([])).toBe('');
  });
});

describe('ranking + the continuation pick', () => {
  it('score desc; ties keep owner-set first, then the input (FIFO) order; never mutates', () => {
    const goals = [
      { id: 'old', createdAt: new Date(NOW - DAY) },
      { id: 'p1m', priority: 1, prioritySource: 'machine' },
      { id: 'mid', createdAt: new Date(NOW - DAY) },
      { id: 'p1o', priority: 1, prioritySource: 'owner' },
    ];
    const before = goals.map((g) => g.id);
    expect(rankGoalsByScore(goals, { now: NOW }).map((r) => r.goal.id)).toEqual(['p1o', 'p1m', 'old', 'mid']);
    expect(goals.map((g) => g.id)).toEqual(before);
  });

  it('the continuation starts the todo of the highest-scored goal; FIFO among equals; a missing goal ranks as unset P2', () => {
    const todos = [{ id: 't-old', goalId: 'g-p3' }, { id: 't-mid', goalId: 'g-missing' }, { id: 't-new', goalId: 'g-p1' }, { id: 't-new2', goalId: 'g-p1' }];
    const goals = new Map([['g-p3', { id: 'g-p3', priority: 3 }], ['g-p1', { id: 'g-p1', priority: 1 }]]);
    expect(pickHighestScoredTodo(todos, goals, { now: NOW })).toEqual({ todo: todos[2], score: 80 });
    expect(pickHighestScoredTodo(todos.slice(0, 2), goals, { now: NOW })).toEqual({ todo: todos[1], score: 60 });
    expect(pickHighestScoredTodo([], goals)).toBeNull();
  });
});

describe('renderers', () => {
  it('prefix, spend clause, money', () => {
    expect(renderGoalScorePrefix({ priority: 1, prioritySource: 'owner' }, 82)).toBe('[P1 owner · 82]');
    expect(renderGoalScorePrefix({}, 60)).toBe('[P2 · 60]');
    expect(renderGoalScorePrefix({ priority: 3 }, null)).toBe('[P3]');
    expect(formatGoalUsd(12.4)).toBe('$12.40');
    expect(formatGoalUsd(4123.6)).toBe('$4,124');
    expect(formatGoalUsd(-3)).toBe('$0.00');
    expect(renderGoalSpendClause(0)).toBe('7d $0.00');
    expect(renderGoalSpendClause(null)).toBe('');
  });
});
