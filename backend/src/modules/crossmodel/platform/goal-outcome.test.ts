/**
 * GOAL-OUTCOME-UNMET (architecture review #3, 2026-10-20) — the pure pieces:
 * the `kpi_bar_unmet` done-suspect reason (goal-done-suspect.ts — the close
 * seams never read the KPI of record before), the outcome / fingerprint /
 * dedupe key / wake text / held progress note (goal-outcome.ts), and the
 * close record's "until the bar/value changes or the owner closes it" rule.
 */
const mockStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => mockStore.get(`${ns.join(':')}/${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, v: any) => { mockStore.set(`${ns.join(':')}/${key}`, v); }),
}));

import {
  assessGoalDoneSuspect, kpiBarUnmetOf, formatKpiBarUnmet, renderGoalDoneSuspectBadge, GOAL_DONE_SUSPECT_BOARD_REASONS, GOAL_OUTCOME_UNMET_REASONS,
} from './goal-done-suspect';
import {
  goalOutcomeOf, outcomeReasonsOf, goalOutcomeFingerprint, goalOutcomeWakeDedupeKey, renderGoalOutcomeUnmetWake, outcomeUnmetProgressNote,
  outcomeCloseStillLive, recordGoalOutcomeClose, readGoalOutcomeClose, acceptGoalOutcomeClose, liveOutcomeUnmetGoalIds, goalOutcomeGateEnforce,
  formatTodosDone, GOAL_OUTCOME_UNMET_WAKE_PREFIX, OUTCOME_UNMET_NOTE_PREFIX, type GoalOutcomeCloseRecord,
  ledgerToolMachineTriggered, ownerTextNamesGoalClose, goalOutcomeCloseNote,
} from './goal-outcome';
import { holdTokenIn } from './goal-done-suspect';
import { progressNoteLead } from './progress-note';
import { isUnplannedGoal } from './goal-unplanned';

const NOW = new Date('2026-10-20T12:00:00Z');
const RID = 'f5b42fe6-1111-4000-8000-000000000000';
/** The KPI the tt-rd register held: 5.08 tok/s against a bar of 10, rising. */
const KPI = { key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', bar: 10, receiptId: RID, setAt: '2026-10-20T10:00:00Z', history: [{ value: 3.44 }] };

beforeEach(() => {
  mockStore.clear();
  delete process.env.GOAL_OUTCOME_CHECK_DISABLED;
  delete process.env.GOAL_OUTCOME_GATE_ENFORCE;
});

describe('kpi_bar_unmet — the done-suspect reason the close seams never had', () => {
  it('a kpi: premise of record below its bar is unmet; at / above it is met; a KPI without a bar is a reading, not an outcome', () => {
    expect(kpiBarUnmetOf([KPI])).toEqual({ key: KPI.key, value: 5.08, bar: 10, direction: 'up', unit: 'tok/s', receiptId: RID, setAt: KPI.setAt });
    expect(kpiBarUnmetOf([{ ...KPI, value: 10 }])).toBeNull();
    expect(kpiBarUnmetOf([{ ...KPI, value: 12.4 }])).toBeNull();
    expect(kpiBarUnmetOf([{ ...KPI, bar: undefined }])).toBeNull();
    expect(kpiBarUnmetOf([{ key: 'baseline', value: 1, bar: 9 }])).toBeNull(); // not a kpi: premise
    expect(kpiBarUnmetOf('garbage')).toBeNull();
  });

  it('a counts-DOWN KPI (bar below the first registered value) is unmet while ABOVE its bar', () => {
    const p95 = { key: 'kpi:p95_ms', value: 420, unit: 'ms', bar: 300, history: [{ value: 900 }] };
    const u = kpiBarUnmetOf([p95]);
    expect(u?.direction).toBe('down');
    expect(formatKpiBarUnmet(u!)).toBe('kpi p95_ms=420 ms > bar 300');
    expect(kpiBarUnmetOf([{ ...p95, value: 280 }])).toBeNull();
  });

  it('assessGoalDoneSuspect adds kpi_bar_unmet as a BOARD reason with the KPI remedy; the badge names the comparison', () => {
    const v = assessGoalDoneSuspect({ title: 'Qwen serving ≥10 tok/s', premises: [KPI] });
    expect(v.reasons).toEqual(['kpi_bar_unmet']);
    expect(v.boardReasons).toEqual(['kpi_bar_unmet']);
    expect(v.kpiUnmet?.value).toBe(5.08);
    expect(v.note).toContain('KPI of record misses its bar (kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10)');
    expect(v.note).toContain('plan the next lever');
    expect(renderGoalDoneSuspectBadge(v)).toBe('⚠ suspect: kpi_bar_unmet (kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10)');
    expect(GOAL_DONE_SUSPECT_BOARD_REASONS.has('kpi_bar_unmet')).toBe(true);
    expect([...GOAL_OUTCOME_UNMET_REASONS].sort()).toEqual(['kpi_bar_unmet', 'premise_target_unmet']);
  });

  it('kill switch GOAL_OUTCOME_CHECK_DISABLED=1: no kpi_bar_unmet (the pre-change verdict)', () => {
    process.env.GOAL_OUTCOME_CHECK_DISABLED = '1';
    expect(assessGoalDoneSuspect({ title: 'x', premises: [KPI] }).reasons).toEqual([]);
    expect(kpiBarUnmetOf([KPI])).toBeNull();
    expect(goalOutcomeOf([KPI]).reasons).toEqual([]);
  });
});

describe('goal-outcome.ts — outcome, fingerprint, dedupe key, texts', () => {
  const TARGET = { key: 'target_tok_per_s', value: 20, observed: 5.33, unit: 'tok/s' };

  it('goalOutcomeOf collects the target + KPI misses; outcomeReasonsOf filters a verdict to them', () => {
    const o = goalOutcomeOf([TARGET, KPI]);
    expect(o.reasons).toEqual(['premise_target_unmet', 'kpi_bar_unmet']);
    expect(o.targets.map((t) => t.key)).toEqual(['target_tok_per_s']);
    expect(goalOutcomeOf([{ ...KPI, value: 11 }]).reasons).toEqual([]);
    expect(outcomeReasonsOf(['hold_token', 'kpi_bar_unmet', 'open_directive', 'premise_target_unmet'])).toEqual(['kpi_bar_unmet', 'premise_target_unmet']);
    expect(outcomeReasonsOf(null)).toEqual([]);
  });

  it('the fingerprint moves with the KPI value / bar / target observed — never with the receipt or key order', () => {
    const base = goalOutcomeFingerprint([KPI, TARGET]);
    expect(goalOutcomeFingerprint([TARGET, KPI])).toBe(base);
    expect(goalOutcomeFingerprint([{ ...KPI, receiptId: 'aaaa1111-0000-4000-8000-000000000000' }, TARGET])).toBe(base);
    expect(goalOutcomeFingerprint([{ ...KPI, value: 6.1 }, TARGET])).not.toBe(base);
    expect(goalOutcomeFingerprint([{ ...KPI, bar: 8 }, TARGET])).not.toBe(base);
    expect(goalOutcomeFingerprint([KPI, { ...TARGET, observed: 7 }])).not.toBe(base);
  });

  it('the wake dedupe key is goal + KPI value + receipt id (targets key on their observed values)', () => {
    const k = goalOutcomeWakeDedupeKey('g-1', goalOutcomeOf([KPI]));
    expect(k).toBe('goal-outcome:wake:g-1:5.08:f5b42fe6:-');
    expect(goalOutcomeWakeDedupeKey('g-1', goalOutcomeOf([{ ...KPI, receiptId: '99999999-0000-4000-8000-000000000000' }]))).not.toBe(k);
    expect(goalOutcomeWakeDedupeKey('g-1', goalOutcomeOf([TARGET]))).toMatch(/^goal-outcome:wake:g-1:-:-:[0-9a-f]{12}$/);
  });

  it('the wake text follows the design and says where the goal stands (closed vs held)', () => {
    const todos = [{ status: 'done' }, { status: 'done' }, { status: 'dropped' }];
    const w = renderGoalOutcomeUnmetWake({ goalId: 'abcdef12-0000-4000-8000-000000000000', title: 'Qwen serving', todos, outcome: goalOutcomeOf([KPI]), now: NOW });
    // observe-only (the goal is already done): the third remedy asks the OWNER — a supervisor's re-close changes nothing (review fix)
    expect(w.startsWith(`${GOAL_OUTCOME_UNMET_WAKE_PREFIX} goal "Qwen serving" (abcdef12): all 2 todos done (1 dropped); kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10 (receipt f5b42fe6, age 2h). Create the next-lever todo with a budget and adoption criterion, or record why the bar changed (goal_premise_set), or ask the owner to accept the close.`)).toBe(true);
    expect(w).not.toContain('close explicitly with evidence');
    expect(w).toContain("auto-closed 'done' — observe-only");
    expect(w).toContain("a goal_update status:'done' from a supervisor or lane changes nothing");
    // enforce (the goal is still OPEN): an explicit close is meaningful there — the design's wording
    const held = renderGoalOutcomeUnmetWake({ goalId: 'g', title: 't', todos, outcome: goalOutcomeOf([KPI]), enforced: true, now: NOW });
    expect(held).toContain('or record why the bar changed (goal_premise_set), or close explicitly with evidence.');
    expect(held).toContain('kept the goal OPEN');
    expect(formatTodosDone([{ status: 'done' }])).toBe('all 1 todo done');
  });

  it('the held progress note LEADS with [outcome unmet], keeps the old note, never stacks, and is capped', () => {
    const o = goalOutcomeOf([KPI]);
    const n1 = outcomeUnmetProgressNote('3/5 shards trained', o, [{ status: 'done' }], 2000, NOW);
    expect(n1.startsWith(`${OUTCOME_UNMET_NOTE_PREFIX} all 1 todo done but kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10`)).toBe(true);
    expect(n1.endsWith('\n3/5 shards trained')).toBe(true);
    const n2 = outcomeUnmetProgressNote(n1, o, [{ status: 'done' }], 2000, NOW);
    expect(n2.match(/\[outcome unmet\]/g)?.length).toBe(1);
    expect(outcomeUnmetProgressNote(null, o, [], 40, NOW).length).toBe(40);
  });

  it('review fix: the held note carries NO hold idiom — the Pulse, the unplanned signal and a later close never read it as an owner HOLD', () => {
    for (const premises of [[KPI], [{ key: 'target_tok_per_s', value: 20, observed: 5.33, unit: 'tok/s' }], [KPI, { key: 'target_p95_ms_max', value: 300, observed: 420 }]]) {
      const note = outcomeUnmetProgressNote(null, goalOutcomeOf(premises), [{ status: 'done' }, { status: 'dropped' }], 2000, NOW);
      expect(holdTokenIn(progressNoteLead(note))).toBeNull();
      expect(isUnplannedGoal({ status: 'active', progressNote: note }, 0)).toBe(true);
      expect(assessGoalDoneSuspect({ title: 'x', progressNote: note }).reasons).not.toContain('hold_token');
    }
  });

  it('goalOutcomeCloseNote: a LIVE close says so and what ends it; the owner\'s close / a met outcome says nothing', () => {
    const o = goalOutcomeOf([KPI]);
    expect(goalOutcomeCloseNote('self', o, NOW)).toBe('Outcome bar unmet (kpi client_visible_e2e_tok_s=5.08 tok/s < bar 10 (receipt f5b42fe6, age 2h)): this close is recorded as LIVE work — the project stays active (no dormancy) until the KPI / target value or its bar changes (goal_premise_set: a new receipted reading, or why the bar changed) or the owner accepts the close in their own message.');
    expect(goalOutcomeCloseNote('woken', o, NOW)).toMatch(/The project supervisor was woken to re-plan\.$/);
    expect(goalOutcomeCloseNote('owner_close', o, NOW)).toBeNull();
    expect(goalOutcomeCloseNote(null, o, NOW)).toBeNull();
    expect(goalOutcomeCloseNote('self', goalOutcomeOf([{ ...KPI, value: 12 }]), NOW)).toBeNull();
  });

  it('GOAL_OUTCOME_GATE_ENFORCE is opt-in and never armed while the check is disabled', () => {
    expect(goalOutcomeGateEnforce()).toBe(false);
    process.env.GOAL_OUTCOME_GATE_ENFORCE = '1';
    expect(goalOutcomeGateEnforce()).toBe(true);
    process.env.GOAL_OUTCOME_CHECK_DISABLED = '1';
    expect(goalOutcomeGateEnforce()).toBe(false);
  });
});

describe('review fix — WHO accepts an unmet outcome', () => {
  it('ledgerToolMachineTriggered is origin-aware: no userTurnAt, an agent-origin (machine-classified) run or an owner-dispatch run is machine', () => {
    const at = new Date();
    expect(ledgerToolMachineTriggered({})).toBe(true);
    expect(ledgerToolMachineTriggered(null)).toBe(true);
    expect(ledgerToolMachineTriggered({ userTurnAt: at, machineTriggered: true })).toBe(true); // agent-origin send inherited the owner's userTurnAt
    expect(ledgerToolMachineTriggered({ userTurnAt: at, ownerDispatch: true })).toBe(true); // a supervisor relayed the owner's ask
    expect(ledgerToolMachineTriggered({ userTurnAt: at })).toBe(false); // a genuine human turn
    expect(ledgerToolMachineTriggered({ userTurnAt: at, machineTriggered: false, ownerDispatch: false })).toBe(false);
  });

  const G = { id: '226be7b7-0000-4000-8000-000000000000', title: 'Qwen serving ≥10 tok/s on QB2' };
  it('ownerTextNamesGoalClose: an imperative, un-negated close naming THIS goal (id prefix / title / "goal")', () => {
    for (const t of [
      'Close goal 226be7b7 — 5 tok/s is fine.',
      'close the goal, the bar was aspirational',
      'Mark the serving goal as done.',
      'set the goal to done',
      'Accept the shortfall on goal 226be7b7 and close it.',
      'Qwen serving ≥10 tok/s on QB2: call it done',
      'ok. wrap it up — that goal is finished for this quarter',
    ]) expect([t, ownerTextNamesGoalClose(t, G)]).toEqual([t, true]);
    for (const t of [
      'how is the serving goal going?', // no close
      'should we close the goal?', // a question
      "don't close the goal yet", // negated
      'do not mark the goal done',
      'we are close to the goal', // "close to" is not a close
      'close it', // names no goal
      'close goal aaaabbbb, not this one', // names a DIFFERENT id
      '',
    ]) expect([t, ownerTextNamesGoalClose(t, G)]).toEqual([t, false]);
    expect(ownerTextNamesGoalClose('close the goal', null)).toBe(false);
    expect(ownerTextNamesGoalClose(42 as any, G)).toBe(false);
  });
});

describe('the close record — live until the bar/value changes or the owner closes it', () => {
  const rec = (over: Partial<GoalOutcomeCloseRecord> = {}): GoalOutcomeCloseRecord => ({
    fingerprint: goalOutcomeFingerprint([KPI]), reasons: ['kpi_bar_unmet'], seam: 'auto', actorKind: 'harness', at: NOW.toISOString(), ownerAccepted: false, ...over,
  });

  it('outcomeCloseStillLive: same fingerprint + not accepted ⇒ live; drift / owner accepted / no record ⇒ not', () => {
    expect(outcomeCloseStillLive(rec(), goalOutcomeFingerprint([KPI]))).toBe(true);
    expect(outcomeCloseStillLive(rec(), goalOutcomeFingerprint([{ ...KPI, value: 7 }]))).toBe(false);
    expect(outcomeCloseStillLive(rec({ ownerAccepted: true }), goalOutcomeFingerprint([KPI]))).toBe(false);
    expect(outcomeCloseStillLive(null, goalOutcomeFingerprint([KPI]))).toBe(false);
  });

  it('record / read / accept round-trip through the context store; liveOutcomeUnmetGoalIds reads only outcome-unmet goals', async () => {
    expect(await recordGoalOutcomeClose('g-live', rec())).toBe(true);
    expect(await readGoalOutcomeClose('g-live')).toMatchObject({ seam: 'auto', ownerAccepted: false });
    await recordGoalOutcomeClose('g-drift', rec());
    const goals = [
      { id: 'g-live', premises: [KPI] },
      { id: 'g-drift', premises: [{ ...KPI, value: 7.2 }] }, // a new reading since the close: no longer the close's state
      { id: 'g-legacy', premises: [KPI] }, // closed before 2026-10-20: no record
      { id: 'g-met', premises: [{ ...KPI, value: 11 }] },
    ];
    expect([...(await liveOutcomeUnmetGoalIds(goals))]).toEqual(['g-live']);
    expect(await acceptGoalOutcomeClose('g-live', [KPI], NOW)).toBe(true);
    expect((await readGoalOutcomeClose('g-live'))?.ownerAccepted).toBe(true);
    expect([...(await liveOutcomeUnmetGoalIds(goals))]).toEqual([]);
    expect(await acceptGoalOutcomeClose('g-met', [{ ...KPI, value: 11 }], NOW)).toBe(false); // nothing to accept
    process.env.GOAL_OUTCOME_CHECK_DISABLED = '1';
    await recordGoalOutcomeClose('g-live', rec());
    expect([...(await liveOutcomeUnmetGoalIds(goals))]).toEqual([]);
  });
});
